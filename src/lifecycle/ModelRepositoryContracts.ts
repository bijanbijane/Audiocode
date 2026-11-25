import { InputHardeningError } from '../security/LocalPrivacyPolicy';

export const MODEL_REPOSITORY_ROOT_DIR = 'ai-models' as const;
export const MODEL_REGISTRY_DIR = 'registry' as const;
export const ACTIVE_MODEL_REGISTRY_FILE = 'active-model.json' as const;
export const PREVIOUS_MODEL_REGISTRY_FILE = 'previous-model.json' as const;
export const MODEL_ARTIFACT_MANIFEST_FILE = 'manifest.json' as const;
export const MODEL_STAGING_MARKER_FILE = '.staging.json' as const;

export const MODEL_CHUNK_SIZE_BYTES = 1024 * 1024;
export const MAX_MODEL_CHUNK_BYTES = 1024 * 1024;
export const MAX_SAFE_MODEL_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export type ModelArchitecture = 'FASTCONFORMER_CTC' | 'WHISPER_SEQ2SEQ' | 'ZIPFORMER_TRANSDUCER';

export interface StoredModelChunkEntry {
  readonly index: number;
  readonly byteLength: number;
  readonly sha256Hex: string;
}

export interface StoredModelArtifactManifest {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly version: string;
  readonly generationId: string;
  readonly architecture: ModelArchitecture;
  readonly storageBackend: 'OPFS';
  readonly storageDirectory: string;
  readonly fileName: string;
  readonly totalBytes: number;
  readonly chunkSizeBytes: number;
  readonly chunkCount: number;
  readonly sha256Hex: string;
  readonly chunks: readonly StoredModelChunkEntry[];
  readonly committedAtMs: number;
}

export interface PersistedModelRegistryPointer {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly version: string;
  readonly generationId: string;
  readonly storageDirectory: string;
  readonly architecture: ModelArchitecture;
  readonly supportedRuntime: 'onnxruntime-web/wasm' | 'onnxruntime-web/webgpu';
  readonly supportedExecutionProviders: readonly ('webgpu' | 'wasm')[];
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly verifiedSha256Hex: string;
  readonly license: string;
  readonly sourceOrigin: string;
  readonly compatibilityMinAppVersion: string;
  readonly installedAtMs: number;
  readonly committedAtMs: number;
}

export interface StreamingModelChunkStorage {
  initialize(): Promise<void>;

  beginTemporaryArtifact(params: {
    key: string;
    expectedByteLength: number;
    chunkSizeBytes: number;
  }): Promise<void>;

  writeTemporaryChunk(
    key: string,
    offset: number,
    chunk: Uint8Array,
  ): Promise<void>;

  readTemporaryChunk(
    key: string,
    index: number,
  ): Promise<Uint8Array | null>;

  getTemporaryArtifactSize(key: string): Promise<number>;

  promoteTemporaryArtifact(
    temporaryKey: string,
    installedKey: string,
    manifest: StoredModelArtifactManifest,
  ): Promise<void>;

  readInstalledChunk(
    key: string,
    index: number,
  ): Promise<Uint8Array | null>;

  getInstalledManifest(
    key: string,
  ): Promise<StoredModelArtifactManifest | null>;

  deleteTemporaryArtifact(key: string): Promise<void>;

  deleteInstalledArtifact(key: string): Promise<void>;

  listArtifacts(): Promise<{
    installed: string[];
    temporary: string[];
  }>;

  // Optional persistent registry & quota methods supported by OPFS and test adapters
  isStorageAvailable?(): boolean;
  getStorageBackendName?(): 'OPFS' | 'MEMORY_TEST';
  getAvailableQuotaBytes?(): Promise<number | null>;
  requestPersistentStorage?(): Promise<boolean>;
  readActiveRegistryPointer?(): Promise<PersistedModelRegistryPointer | null>;
  readPreviousRegistryPointer?(): Promise<PersistedModelRegistryPointer | null>;
  writeActiveRegistryPointer?(pointer: PersistedModelRegistryPointer | null): Promise<void>;
  writePreviousRegistryPointer?(pointer: PersistedModelRegistryPointer | null): Promise<void>;
}

export type ModelRepositoryErrorCode =
  | 'MODEL_STORAGE_UNAVAILABLE'
  | 'MODEL_STORAGE_QUOTA_EXCEEDED'
  | 'MODEL_PATH_INVALID'
  | 'MODEL_MANIFEST_INVALID'
  | 'MODEL_REGISTRY_CORRUPTED'
  | 'MODEL_INTEGRITY_FAILURE'
  | 'MODEL_WRITE_FAILED'
  | 'MODEL_READ_FAILED';

export class ModelRepositoryError extends Error {
  public readonly code: ModelRepositoryErrorCode;
  public readonly cause?: unknown;

  constructor(code: ModelRepositoryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ModelRepositoryError';
    this.code = code;
    this.cause = cause;
  }
}

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Validates a single OPFS path component strictly against path traversal,
 * separators, null bytes, control characters, and reserved segments.
 */
export function validateModelPathSegment(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string') {
    throw new ModelRepositoryError(
      'MODEL_PATH_INVALID',
      `Invalid ${fieldName}: expected non-empty string.`,
    );
  }
  const value = raw.trim();
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !SAFE_SEGMENT_PATTERN.test(value)
  ) {
    throw new ModelRepositoryError(
      'MODEL_PATH_INVALID',
      `Invalid ${fieldName} "${raw}": path traversal, separators, null bytes, or unsafe characters are forbidden.`,
    );
  }
  if (value.toLowerCase() === MODEL_REGISTRY_DIR) {
    throw new ModelRepositoryError(
      'MODEL_PATH_INVALID',
      `Invalid ${fieldName}: "${MODEL_REGISTRY_DIR}" is a reserved repository directory.`,
    );
  }
  return value;
}

export function buildModelArtifactDirectory(
  modelId: string,
  version: string,
  generationId: string,
): string {
  const safeId = validateModelPathSegment(modelId, 'modelId');
  const safeVersion = validateModelPathSegment(version, 'version');
  const safeGen = validateModelPathSegment(generationId, 'generationId');
  const combined = `${safeId}_${safeVersion}_${safeGen}`;
  if (combined.length > 200) {
    throw new ModelRepositoryError(
      'MODEL_PATH_INVALID',
      `Artifact directory name exceeds maximum safe length (${combined.length} > 200).`,
    );
  }
  return combined;
}

export function formatModelChunkFileName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) {
    throw new ModelRepositoryError(
      'MODEL_PATH_INVALID',
      `Invalid chunk index: ${String(index)}.`,
    );
  }
  return `chunk_${String(index).padStart(4, '0')}.bin`;
}

export function computeRequiredModelQuotaBytes(expectedByteLength: number): number {
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Expected model byte length must be a positive safe integer, received ${String(expectedByteLength)}.`,
    );
  }
  return (
    expectedByteLength +
    Math.max(16 * 1024 * 1024, Math.ceil(expectedByteLength * 0.05))
  );
}

export function isQuotaExceededError(err: unknown): boolean {
  if (err instanceof ModelRepositoryError && err.code === 'MODEL_STORAGE_QUOTA_EXCEEDED') {
    return true;
  }
  if (!err || typeof err !== 'object') return false;
  const record = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof record.name === 'string' ? record.name : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  return (
    name === 'QuotaExceededError' ||
    code === 'MODEL_STORAGE_QUOTA_EXCEEDED' ||
    code === 'STORAGE_QUOTA_EXCEEDED' ||
    /quota\s*exceeded|MODEL_STORAGE_QUOTA_EXCEEDED/i.test(message)
  );
}

export function validateStoredModelArtifactManifest(
  raw: unknown,
  expectedStorageDirectory?: string,
): StoredModelArtifactManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      'Stored model manifest must be a JSON object.',
    );
  }

  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Unsupported model artifact manifest schemaVersion: ${String(obj.schemaVersion)}.`,
    );
  }

  const modelId = validateModelPathSegment(obj.modelId, 'modelId');
  const version = validateModelPathSegment(obj.version, 'version');
  const generationId = validateModelPathSegment(obj.generationId, 'generationId');

  if (obj.architecture !== 'FASTCONFORMER_CTC' && obj.architecture !== 'WHISPER_SEQ2SEQ') {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Unsupported model architecture: ${String(obj.architecture)}.`,
    );
  }

  if (obj.storageBackend !== 'OPFS') {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Unsupported model storageBackend: ${String(obj.storageBackend)}.`,
    );
  }

  const expectedCanonicalDir = buildModelArtifactDirectory(modelId, version, generationId);
  const storageDirectory = validateModelPathSegment(obj.storageDirectory, 'storageDirectory');
  if (storageDirectory !== expectedCanonicalDir) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Manifest storageDirectory "${storageDirectory}" does not match canonical "${expectedCanonicalDir}".`,
    );
  }
  if (expectedStorageDirectory !== undefined && storageDirectory !== expectedStorageDirectory) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Manifest storageDirectory "${storageDirectory}" does not match directory "${expectedStorageDirectory}".`,
    );
  }

  if (
    typeof obj.fileName !== 'string' ||
    !/^[A-Za-z0-9._-]+\.onnx$/i.test(obj.fileName) ||
    obj.fileName.includes('..')
  ) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Invalid model fileName: ${String(obj.fileName)}.`,
    );
  }

  if (
    typeof obj.totalBytes !== 'number' ||
    !Number.isSafeInteger(obj.totalBytes) ||
    obj.totalBytes <= 0 ||
    obj.totalBytes > MAX_SAFE_MODEL_FILE_BYTES
  ) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Invalid manifest totalBytes: ${String(obj.totalBytes)}.`,
    );
  }

  if (
    typeof obj.chunkSizeBytes !== 'number' ||
    !Number.isSafeInteger(obj.chunkSizeBytes) ||
    obj.chunkSizeBytes <= 0 ||
    obj.chunkSizeBytes > MAX_MODEL_CHUNK_BYTES
  ) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Invalid manifest chunkSizeBytes: ${String(obj.chunkSizeBytes)} (must be in 1..${MAX_MODEL_CHUNK_BYTES}).`,
    );
  }

  if (
    typeof obj.sha256Hex !== 'string' ||
    !SHA256_HEX_PATTERN.test(obj.sha256Hex.toLowerCase())
  ) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      'Manifest sha256Hex must be a valid 64-character hex SHA-256 digest.',
    );
  }

  if (!Array.isArray(obj.chunks) || obj.chunks.length === 0) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      'Manifest chunks must be a non-empty array.',
    );
  }

  if (
    typeof obj.chunkCount !== 'number' ||
    !Number.isSafeInteger(obj.chunkCount) ||
    obj.chunkCount !== obj.chunks.length
  ) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Manifest chunkCount (${String(obj.chunkCount)}) does not match chunks.length (${obj.chunks.length}).`,
    );
  }

  if (
    typeof obj.committedAtMs !== 'number' ||
    !Number.isFinite(obj.committedAtMs) ||
    obj.committedAtMs <= 0
  ) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Invalid manifest committedAtMs: ${String(obj.committedAtMs)}.`,
    );
  }

  const seenIndexes = new Set<number>();
  const validatedChunks: StoredModelChunkEntry[] = [];
  let sumBytes = 0;

  for (let i = 0; i < obj.chunks.length; i++) {
    const rawChunk = obj.chunks[i];
    if (!rawChunk || typeof rawChunk !== 'object' || Array.isArray(rawChunk)) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Chunk entry #${i} must be an object.`,
      );
    }
    const c = rawChunk as Record<string, unknown>;
    if (typeof c.index !== 'number' || !Number.isSafeInteger(c.index)) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Chunk entry #${i} has invalid index: ${String(c.index)}.`,
      );
    }
    if (seenIndexes.has(c.index)) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Duplicate chunk index ${c.index} in manifest.`,
      );
    }
    if (c.index !== i) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Out-of-order or non-contiguous chunk index: expected ${i}, got ${c.index}.`,
      );
    }
    seenIndexes.add(c.index);

    if (
      typeof c.byteLength !== 'number' ||
      !Number.isSafeInteger(c.byteLength) ||
      c.byteLength <= 0 ||
      c.byteLength > MAX_MODEL_CHUNK_BYTES
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Chunk #${i} has invalid byteLength: ${String(c.byteLength)} (max ${MAX_MODEL_CHUNK_BYTES}).`,
      );
    }

    const isLast = i === obj.chunks.length - 1;
    if (!isLast && c.byteLength !== obj.chunkSizeBytes) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Non-final chunk #${i} byteLength (${c.byteLength}) must equal chunkSizeBytes (${obj.chunkSizeBytes}).`,
      );
    }
    if (isLast && c.byteLength > obj.chunkSizeBytes) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Final chunk #${i} byteLength (${c.byteLength}) exceeds chunkSizeBytes (${obj.chunkSizeBytes}).`,
      );
    }

    if (typeof c.sha256Hex !== 'string' || !SHA256_HEX_PATTERN.test(c.sha256Hex.toLowerCase())) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Chunk #${i} sha256Hex must be a valid 64-character hex SHA-256 digest.`,
      );
    }

    sumBytes += c.byteLength;
    validatedChunks.push({
      index: c.index,
      byteLength: c.byteLength,
      sha256Hex: c.sha256Hex.toLowerCase(),
    });
  }

  if (sumBytes !== obj.totalBytes) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Manifest totalBytes (${obj.totalBytes}) does not equal sum of chunk lengths (${sumBytes}).`,
    );
  }

  const expectedChunkCount = Math.ceil(obj.totalBytes / obj.chunkSizeBytes);
  if (obj.chunkCount !== expectedChunkCount) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      `Manifest chunkCount (${obj.chunkCount}) does not match expected ${expectedChunkCount} for totalBytes=${obj.totalBytes} and chunkSizeBytes=${obj.chunkSizeBytes}.`,
    );
  }

  return {
    schemaVersion: 1,
    modelId,
    version,
    generationId,
    architecture: obj.architecture,
    storageBackend: 'OPFS',
    storageDirectory,
    fileName: obj.fileName,
    totalBytes: obj.totalBytes,
    chunkSizeBytes: obj.chunkSizeBytes,
    chunkCount: validatedChunks.length,
    sha256Hex: obj.sha256Hex.toLowerCase(),
    chunks: validatedChunks,
    committedAtMs: obj.committedAtMs,
  };
}

export function validatePersistedModelRegistryPointer(
  raw: unknown,
): PersistedModelRegistryPointer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      'Model registry pointer must be a JSON object.',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      `Unsupported registry pointer schemaVersion: ${String(obj.schemaVersion)}.`,
    );
  }

  const modelId = validateModelPathSegment(obj.modelId, 'modelId');
  const version = validateModelPathSegment(obj.version, 'version');
  const generationId = validateModelPathSegment(obj.generationId, 'generationId');
  const storageDirectory = validateModelPathSegment(obj.storageDirectory, 'storageDirectory');
  const expectedDir = buildModelArtifactDirectory(modelId, version, generationId);
  if (storageDirectory !== expectedDir) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      `Registry pointer storageDirectory "${storageDirectory}" does not match "${expectedDir}".`,
    );
  }

  if (obj.architecture !== 'FASTCONFORMER_CTC' && obj.architecture !== 'WHISPER_SEQ2SEQ') {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      `Invalid registry architecture: ${String(obj.architecture)}.`,
    );
  }

  if (
    obj.supportedRuntime !== 'onnxruntime-web/wasm' &&
    obj.supportedRuntime !== 'onnxruntime-web/webgpu'
  ) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      `Invalid registry supportedRuntime: ${String(obj.supportedRuntime)}.`,
    );
  }

  if (
    !Array.isArray(obj.supportedExecutionProviders) ||
    obj.supportedExecutionProviders.length === 0 ||
    !obj.supportedExecutionProviders.every((ep) => ep === 'wasm' || ep === 'webgpu')
  ) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      'Invalid registry supportedExecutionProviders.',
    );
  }

  if (
    typeof obj.fileName !== 'string' ||
    !/^[A-Za-z0-9._-]+\.onnx$/i.test(obj.fileName) ||
    obj.fileName.includes('..')
  ) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      `Invalid registry fileName: ${String(obj.fileName)}.`,
    );
  }

  if (
    typeof obj.fileSizeBytes !== 'number' ||
    !Number.isSafeInteger(obj.fileSizeBytes) ||
    obj.fileSizeBytes <= 0 ||
    obj.fileSizeBytes > MAX_SAFE_MODEL_FILE_BYTES
  ) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      `Invalid registry fileSizeBytes: ${String(obj.fileSizeBytes)}.`,
    );
  }

  if (
    typeof obj.verifiedSha256Hex !== 'string' ||
    !SHA256_HEX_PATTERN.test(obj.verifiedSha256Hex.toLowerCase())
  ) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      'Registry verifiedSha256Hex must be a valid 64-character hex SHA-256 digest.',
    );
  }

  if (
    typeof obj.license !== 'string' ||
    typeof obj.sourceOrigin !== 'string' ||
    typeof obj.compatibilityMinAppVersion !== 'string' ||
    typeof obj.installedAtMs !== 'number' ||
    !Number.isFinite(obj.installedAtMs) ||
    typeof obj.committedAtMs !== 'number' ||
    !Number.isFinite(obj.committedAtMs)
  ) {
    throw new ModelRepositoryError(
      'MODEL_REGISTRY_CORRUPTED',
      'Registry pointer metadata fields are invalid or missing.',
    );
  }

  return {
    schemaVersion: 1,
    modelId,
    version,
    generationId,
    storageDirectory,
    architecture: obj.architecture,
    supportedRuntime: obj.supportedRuntime,
    supportedExecutionProviders: [...(obj.supportedExecutionProviders as ('webgpu' | 'wasm')[])],
    fileName: obj.fileName,
    fileSizeBytes: obj.fileSizeBytes,
    verifiedSha256Hex: obj.verifiedSha256Hex.toLowerCase(),
    license: obj.license,
    sourceOrigin: obj.sourceOrigin,
    compatibilityMinAppVersion: obj.compatibilityMinAppVersion,
    installedAtMs: obj.installedAtMs,
    committedAtMs: obj.committedAtMs,
  };
}

/**
 * Helper to derive a safe modelId and version from an arbitrary uploaded `.onnx` filename
 * while preserving the original filename for manifest/display metadata.
 */
export function deriveModelIdentityFromFileName(fileName: string): {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly safeFileName: string;
} {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  const cleaned = baseName
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.\.+/g, '_');

  if (!/\.onnx$/i.test(cleaned)) {
    throw new InputHardeningError(
      'INVALID_MODEL_MANIFEST',
      `Model file "${fileName}" must have a .onnx extension.`,
    );
  }

  const safeFileName = cleaned.replace(/^\.+/, '') || 'local-model.onnx';
  const stem = safeFileName.replace(/\.onnx$/i, '');

  // Support optional semver suffix like `persian-asr-v2.1.0.onnx` or `persian-asr_2.1.0.onnx`
  const versionMatch = stem.match(/^(.+?)[-_]v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/i);
  if (versionMatch) {
    const rawId = versionMatch[1].replace(/^[^A-Za-z0-9]+/, '') || 'local-persian-asr';
    const rawVer = versionMatch[2];
    return {
      modelId: validateModelPathSegment(rawId.slice(0, 64), 'modelId'),
      modelVersion: validateModelPathSegment(rawVer.slice(0, 48), 'version'),
      safeFileName,
    };
  }

  const normalizedId = stem.replace(/^[^A-Za-z0-9]+/, '') || 'local-persian-asr';
  return {
    modelId: validateModelPathSegment(normalizedId.slice(0, 64), 'modelId'),
    modelVersion: '1.0.0-local',
    safeFileName,
  };
}
