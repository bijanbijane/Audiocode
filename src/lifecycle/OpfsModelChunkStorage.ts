import { safeParseJsonWithGuards } from '../security/LocalPrivacyPolicy';
import {
  ACTIVE_MODEL_REGISTRY_FILE,
  formatModelChunkFileName,
  isQuotaExceededError,
  MAX_MODEL_CHUNK_BYTES,
  MAX_SAFE_MODEL_FILE_BYTES,
  MODEL_ARTIFACT_MANIFEST_FILE,
  MODEL_REGISTRY_DIR,
  MODEL_REPOSITORY_ROOT_DIR,
  MODEL_STAGING_MARKER_FILE,
  ModelRepositoryError,
  PersistedModelRegistryPointer,
  PREVIOUS_MODEL_REGISTRY_FILE,
  StoredModelArtifactManifest,
  StreamingModelChunkStorage,
  validateModelPathSegment,
  validatePersistedModelRegistryPointer,
  validateStoredModelArtifactManifest,
} from './ModelRepositoryContracts';

export interface OpfsWritableStreamLike {
  write(data: Uint8Array | ArrayBuffer | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface OpfsFileHandleLike {
  readonly kind?: 'file';
  readonly name?: string;
  getFile(): Promise<{
    readonly size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text?(): Promise<string>;
  }>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableStreamLike>;
}

export interface OpfsDirectoryHandleLike {
  readonly kind?: 'directory';
  readonly name?: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterableIterator<[string, { readonly kind: 'file' | 'directory'; readonly name?: string }]>;
  keys?(): AsyncIterableIterator<string>;
}

export interface OpfsModelChunkStorageOptions {
  readonly getRootDirectory?: () => Promise<OpfsDirectoryHandleLike>;
  readonly estimateStorage?: () => Promise<{ quota?: number; usage?: number }>;
  readonly isPersisted?: () => Promise<boolean>;
  readonly requestPersist?: () => Promise<boolean>;
  readonly onBeforeWriteManifest?: (key: string) => Promise<void> | void;
  readonly onBeforeWriteRegistry?: (fileName: string) => Promise<void> | void;
}

interface StagingArtifactMetadata {
  readonly key: string;
  readonly expectedByteLength: number;
  readonly chunkSizeBytes: number;
  readonly createdAtMs: number;
}

interface ActiveStagingState {
  readonly expectedByteLength: number;
  readonly chunkSizeBytes: number;
  readonly writtenChunkSizes: Map<number, number>;
  persistedBytes: number;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const msg = (err as { message?: unknown }).message;
  return (
    name === 'NotFoundError' ||
    (typeof msg === 'string' && /not\s*found|ENOENT/i.test(msg))
  );
}

async function readTextFromFileHandle(fileHandle: OpfsFileHandleLike): Promise<string> {
  const file = await fileHandle.getFile();
  if (typeof file.text === 'function') {
    return file.text();
  }
  const buf = await file.arrayBuffer();
  return new TextDecoder().decode(new Uint8Array(buf));
}

async function writeBytesAtomically(
  dir: OpfsDirectoryHandleLike,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  let writable: OpfsWritableStreamLike | null = null;
  let closed = false;
  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    closed = true;
  } catch (err) {
    if (writable && !closed) {
      try {
        if (typeof writable.abort === 'function') {
          await writable.abort(err);
        } else {
          await writable.close();
        }
      } catch {
        // ignore abort failure while propagating root cause
      }
    }
    if (isQuotaExceededError(err)) {
      throw new ModelRepositoryError(
        'MODEL_STORAGE_QUOTA_EXCEEDED',
        `OPFS storage quota exceeded while writing "${fileName}".`,
        err,
      );
    }
    throw new ModelRepositoryError(
      'MODEL_WRITE_FAILED',
      `Failed to persist OPFS file "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

async function writeJsonAtomically(
  dir: OpfsDirectoryHandleLike,
  fileName: string,
  value: unknown,
): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const tmpName = `${fileName}.tmp`;
  await writeBytesAtomically(dir, tmpName, encoded);
  try {
    await writeBytesAtomically(dir, fileName, encoded);
  } finally {
    try {
      await dir.removeEntry(tmpName);
    } catch {
      // ignore temporary file cleanup error
    }
  }
}

async function listDirectoryEntries(
  dir: OpfsDirectoryHandleLike,
): Promise<Array<{ readonly name: string; readonly kind: 'file' | 'directory' | 'unknown' }>> {
  const out: Array<{ readonly name: string; readonly kind: 'file' | 'directory' | 'unknown' }> = [];
  if (typeof dir.entries === 'function') {
    for await (const [name, handle] of dir.entries()) {
      out.push({ name, kind: handle?.kind ?? 'unknown' });
    }
    return out;
  }
  if (typeof dir.keys === 'function') {
    for await (const name of dir.keys()) {
      out.push({ name, kind: 'unknown' });
    }
    return out;
  }
  return out;
}

/**
 * Production durable OPFS chunk-addressable model repository.
 *
 * Namespace strictly scoped to:
 *   OPFS/ai-models/
 *     ├── registry/
 *     │   ├── active-model.json
 *     │   └── previous-model.json
 *     └── {modelId}_{version}_{generation}/
 *         ├── manifest.json
 *         ├── chunk_0000.bin
 *         └── ...
 *
 * Guarantees:
 * - Zero complete-model Uint8Array held in RAM inside the storage adapter.
 * - Zero O(n^2) reallocation/copying; every chunk is written independently as chunk_XXXX.bin.
 * - Staging isolation without relying on unsupported OPFS directory rename semantics.
 * - Atomic manifest and registry updates via OPFS writable-file commit boundaries.
 * - Never touches audio assets, recovery journals, or exported user projects.
 */
export class OpfsModelChunkStorage implements StreamingModelChunkStorage {
  private readonly options: OpfsModelChunkStorageOptions;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private storageAvailable = false;
  private modelsRootDir: OpfsDirectoryHandleLike | null = null;
  private registryDir: OpfsDirectoryHandleLike | null = null;
  private readonly stagingStates = new Map<string, ActiveStagingState>();

  constructor(options: OpfsModelChunkStorageOptions = {}) {
    this.options = options;
  }

  public isStorageAvailable(): boolean {
    return this.initialized && this.storageAvailable && this.modelsRootDir !== null;
  }

  public getStorageBackendName(): 'OPFS' {
    return 'OPFS';
  }

  public async initialize(): Promise<void> {
    if (this.initialized && this.storageAvailable && this.modelsRootDir) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    const run = this.performInitialize();
    this.initPromise = run;
    try {
      await run;
    } finally {
      if (!this.storageAvailable) {
        this.initPromise = null;
      }
    }
  }

  private async performInitialize(): Promise<void> {
    try {
      const root = await this.resolveRootDirectory();
      const modelsRoot = await root.getDirectoryHandle(MODEL_REPOSITORY_ROOT_DIR, {
        create: true,
      });
      const registry = await modelsRoot.getDirectoryHandle(MODEL_REGISTRY_DIR, {
        create: true,
      });
      this.modelsRootDir = modelsRoot;
      this.registryDir = registry;
      this.storageAvailable = true;
      this.initialized = true;

      // Best-effort durable persistence request; never fatal if unsupported
      await this.requestPersistentStorage().catch(() => false);
    } catch (err) {
      this.modelsRootDir = null;
      this.registryDir = null;
      this.storageAvailable = false;
      this.initialized = true;
      if (err instanceof ModelRepositoryError) {
        throw err;
      }
      throw new ModelRepositoryError(
        'MODEL_STORAGE_UNAVAILABLE',
        `OPFS model repository unavailable: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private async resolveRootDirectory(): Promise<OpfsDirectoryHandleLike> {
    if (this.options.getRootDirectory) {
      return this.options.getRootDirectory();
    }
    if (
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      throw new ModelRepositoryError(
        'MODEL_STORAGE_UNAVAILABLE',
        'OPFS (navigator.storage.getDirectory) is unavailable in this environment.',
      );
    }
    return (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandleLike;
  }

  private requireModelsRoot(): OpfsDirectoryHandleLike {
    if (!this.modelsRootDir || !this.storageAvailable) {
      throw new ModelRepositoryError(
        'MODEL_STORAGE_UNAVAILABLE',
        'OPFS model repository is not initialized or unavailable.',
      );
    }
    return this.modelsRootDir;
  }

  private requireRegistryDir(): OpfsDirectoryHandleLike {
    if (!this.registryDir || !this.storageAvailable) {
      throw new ModelRepositoryError(
        'MODEL_STORAGE_UNAVAILABLE',
        'OPFS model registry directory is not initialized or unavailable.',
      );
    }
    return this.registryDir;
  }

  public async requestPersistentStorage(): Promise<boolean> {
    try {
      if (this.options.isPersisted) {
        const already = await this.options.isPersisted();
        if (already) return true;
      } else if (
        typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.persisted === 'function'
      ) {
        const already = await navigator.storage.persisted();
        if (already) return true;
      }

      if (this.options.requestPersist) {
        return await this.options.requestPersist();
      }
      if (
        typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.persist === 'function'
      ) {
        return await navigator.storage.persist();
      }
      return false;
    } catch {
      return false;
    }
  }

  public async getAvailableQuotaBytes(): Promise<number | null> {
    try {
      const est = this.options.estimateStorage
        ? await this.options.estimateStorage()
        : typeof navigator !== 'undefined' &&
            navigator.storage &&
            typeof navigator.storage.estimate === 'function'
          ? await navigator.storage.estimate()
          : null;
      if (
        est &&
        typeof est.quota === 'number' &&
        Number.isFinite(est.quota) &&
        est.quota >= 0
      ) {
        const usage =
          typeof est.usage === 'number' && Number.isFinite(est.usage) && est.usage >= 0
            ? est.usage
            : 0;
        return Math.max(0, Math.floor(est.quota - usage));
      }
      return null;
    } catch {
      return null;
    }
  }

  public async beginTemporaryArtifact(params: {
    key: string;
    expectedByteLength: number;
    chunkSizeBytes: number;
  }): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(params.key, 'temporaryKey');
    if (
      !Number.isSafeInteger(params.expectedByteLength) ||
      params.expectedByteLength <= 0 ||
      params.expectedByteLength > MAX_SAFE_MODEL_FILE_BYTES
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Invalid expectedByteLength for temporary artifact "${safeKey}": ${String(params.expectedByteLength)}.`,
      );
    }
    if (
      !Number.isSafeInteger(params.chunkSizeBytes) ||
      params.chunkSizeBytes <= 0 ||
      params.chunkSizeBytes > MAX_MODEL_CHUNK_BYTES
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Invalid chunkSizeBytes for temporary artifact "${safeKey}": ${String(params.chunkSizeBytes)}.`,
      );
    }

    const modelsRoot = this.requireModelsRoot();

    // Refuse to stage over a directory that already holds a committed manifest
    const existingManifest = await this.tryReadManifestFromDir(safeKey);
    if (existingManifest) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Refusing to overwrite committed model artifact "${safeKey}" during staging.`,
      );
    }

    const dir = await modelsRoot.getDirectoryHandle(safeKey, { create: true });
    const marker: StagingArtifactMetadata = {
      key: safeKey,
      expectedByteLength: params.expectedByteLength,
      chunkSizeBytes: params.chunkSizeBytes,
      createdAtMs: Date.now(),
    };
    await writeJsonAtomically(dir, MODEL_STAGING_MARKER_FILE, marker);

    this.stagingStates.set(safeKey, {
      expectedByteLength: params.expectedByteLength,
      chunkSizeBytes: params.chunkSizeBytes,
      writtenChunkSizes: new Map<number, number>(),
      persistedBytes: 0,
    });
  }

  private async loadOrRestoreStagingState(safeKey: string): Promise<ActiveStagingState> {
    const cached = this.stagingStates.get(safeKey);
    if (cached) return cached;

    const modelsRoot = this.requireModelsRoot();
    let dir: OpfsDirectoryHandleLike;
    try {
      dir = await modelsRoot.getDirectoryHandle(safeKey, { create: false });
    } catch (err) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Temporary staging artifact "${safeKey}" has not been initialized.`,
        err,
      );
    }

    let markerHandle: OpfsFileHandleLike;
    try {
      markerHandle = await dir.getFileHandle(MODEL_STAGING_MARKER_FILE, { create: false });
    } catch (err) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Staging metadata missing for "${safeKey}".`,
        err,
      );
    }

    const rawText = await readTextFromFileHandle(markerHandle);
    const parsed = safeParseJsonWithGuards<StagingArtifactMetadata>(rawText, 64 * 1024);
    if (
      !parsed ||
      typeof parsed.chunkSizeBytes !== 'number' ||
      !Number.isSafeInteger(parsed.chunkSizeBytes) ||
      parsed.chunkSizeBytes <= 0 ||
      parsed.chunkSizeBytes > MAX_MODEL_CHUNK_BYTES ||
      typeof parsed.expectedByteLength !== 'number' ||
      !Number.isSafeInteger(parsed.expectedByteLength) ||
      parsed.expectedByteLength <= 0
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Corrupted staging metadata for "${safeKey}".`,
      );
    }

    const writtenChunkSizes = new Map<number, number>();
    let persistedBytes = 0;
    const entries = await listDirectoryEntries(dir);
    for (const entry of entries) {
      const match = entry.name.match(/^chunk_(\d{4,})\.bin$/);
      if (!match) continue;
      const idx = Number.parseInt(match[1], 10);
      const fh = await dir.getFileHandle(entry.name, { create: false });
      const file = await fh.getFile();
      writtenChunkSizes.set(idx, file.size);
      persistedBytes += file.size;
    }

    const restored: ActiveStagingState = {
      expectedByteLength: parsed.expectedByteLength,
      chunkSizeBytes: parsed.chunkSizeBytes,
      writtenChunkSizes,
      persistedBytes,
    };
    this.stagingStates.set(safeKey, restored);
    return restored;
  }

  public async writeTemporaryChunk(
    key: string,
    offset: number,
    chunk: Uint8Array,
  ): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Chunk payload for "${safeKey}" must be a non-empty Uint8Array.`,
      );
    }
    if (chunk.byteLength > MAX_MODEL_CHUNK_BYTES) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Chunk byteLength (${chunk.byteLength}) exceeds maximum allowed ${MAX_MODEL_CHUNK_BYTES} bytes.`,
      );
    }

    const state = await this.loadOrRestoreStagingState(safeKey);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % state.chunkSizeBytes !== 0
    ) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Chunk offset (${offset}) must be aligned to chunkSizeBytes (${state.chunkSizeBytes}).`,
      );
    }
    if (offset + chunk.byteLength > state.expectedByteLength) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Chunk write [${offset}, ${offset + chunk.byteLength}) exceeds expected artifact size ${state.expectedByteLength}.`,
      );
    }

    const chunkIndex = Math.floor(offset / state.chunkSizeBytes);
    const fileName = formatModelChunkFileName(chunkIndex);
    const modelsRoot = this.requireModelsRoot();
    const dir = await modelsRoot.getDirectoryHandle(safeKey, { create: false });

    await writeBytesAtomically(dir, fileName, chunk);

    const prevSize = state.writtenChunkSizes.get(chunkIndex) ?? 0;
    state.writtenChunkSizes.set(chunkIndex, chunk.byteLength);
    state.persistedBytes = state.persistedBytes - prevSize + chunk.byteLength;
  }

  public async readTemporaryChunk(
    key: string,
    index: number,
  ): Promise<Uint8Array | null> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    const fileName = formatModelChunkFileName(index);
    const modelsRoot = this.requireModelsRoot();

    try {
      const dir = await modelsRoot.getDirectoryHandle(safeKey, { create: false });
      const fh = await dir.getFileHandle(fileName, { create: false });
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw new ModelRepositoryError(
        'MODEL_READ_FAILED',
        `Failed to read temporary chunk #${index} for "${safeKey}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  public async getTemporaryArtifactSize(key: string): Promise<number> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    const cached = this.stagingStates.get(safeKey);
    if (cached) {
      return cached.persistedBytes;
    }

    const modelsRoot = this.requireModelsRoot();
    try {
      const dir = await modelsRoot.getDirectoryHandle(safeKey, { create: false });
      const entries = await listDirectoryEntries(dir);
      let total = 0;
      for (const entry of entries) {
        if (!/^chunk_\d{4,}\.bin$/.test(entry.name)) continue;
        const fh = await dir.getFileHandle(entry.name, { create: false });
        const file = await fh.getFile();
        total += file.size;
      }
      return total;
    } catch (err) {
      if (isNotFoundError(err)) return 0;
      throw new ModelRepositoryError(
        'MODEL_READ_FAILED',
        `Failed to measure temporary artifact "${safeKey}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  public async promoteTemporaryArtifact(
    temporaryKey: string,
    installedKey: string,
    manifest: StoredModelArtifactManifest,
  ): Promise<void> {
    await this.initialize();
    const safeTempKey = validateModelPathSegment(temporaryKey, 'temporaryKey');
    const safeInstalledKey = validateModelPathSegment(installedKey, 'installedKey');
    const validatedManifest = validateStoredModelArtifactManifest(manifest, safeInstalledKey);

    const modelsRoot = this.requireModelsRoot();

    // If staging used a distinct directory key, stream chunks one-by-one into target directory
    // without ever concatenating into a full-file buffer or relying on unsupported directory rename.
    if (safeTempKey !== safeInstalledKey) {
      const targetDir = await modelsRoot.getDirectoryHandle(safeInstalledKey, { create: true });
      try {
        for (const chunkMeta of validatedManifest.chunks) {
          const chunkBytes = await this.readTemporaryChunk(safeTempKey, chunkMeta.index);
          if (!chunkBytes || chunkBytes.byteLength !== chunkMeta.byteLength) {
            throw new ModelRepositoryError(
              'MODEL_INTEGRITY_FAILURE',
              `Cannot promote "${safeTempKey}": missing or mismatched chunk #${chunkMeta.index}.`,
            );
          }
          await writeBytesAtomically(
            targetDir,
            formatModelChunkFileName(chunkMeta.index),
            chunkBytes,
          );
        }
      } catch (err) {
        await this.deleteDirectoryIfExists(safeInstalledKey);
        throw err;
      }
    }

    const targetDir = await modelsRoot.getDirectoryHandle(safeInstalledKey, { create: false });

    // Verify all expected chunk files exist with exact sizes before committing manifest.json
    for (const chunkMeta of validatedManifest.chunks) {
      const fileName = formatModelChunkFileName(chunkMeta.index);
      let fileSize: number;
      try {
        const fh = await targetDir.getFileHandle(fileName, { create: false });
        const file = await fh.getFile();
        fileSize = file.size;
      } catch (err) {
        throw new ModelRepositoryError(
          'MODEL_INTEGRITY_FAILURE',
          `Cannot commit manifest for "${safeInstalledKey}": chunk "${fileName}" is missing.`,
          err,
        );
      }
      if (fileSize !== chunkMeta.byteLength) {
        throw new ModelRepositoryError(
          'MODEL_INTEGRITY_FAILURE',
          `Cannot commit manifest for "${safeInstalledKey}": chunk #${chunkMeta.index} size ${fileSize} != ${chunkMeta.byteLength}.`,
        );
      }
    }

    if (this.options.onBeforeWriteManifest) {
      await this.options.onBeforeWriteManifest(safeInstalledKey);
    }

    await writeJsonAtomically(targetDir, MODEL_ARTIFACT_MANIFEST_FILE, validatedManifest);

    try {
      await targetDir.removeEntry(MODEL_STAGING_MARKER_FILE);
    } catch {
      // ignore if marker already absent
    }

    this.stagingStates.delete(safeTempKey);
    if (safeTempKey !== safeInstalledKey) {
      await this.deleteDirectoryIfExists(safeTempKey);
    }
  }

  public async readInstalledChunk(
    key: string,
    index: number,
  ): Promise<Uint8Array | null> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'installedKey');
    const fileName = formatModelChunkFileName(index);
    const modelsRoot = this.requireModelsRoot();

    try {
      const dir = await modelsRoot.getDirectoryHandle(safeKey, { create: false });
      const fh = await dir.getFileHandle(fileName, { create: false });
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw new ModelRepositoryError(
        'MODEL_READ_FAILED',
        `Failed to read installed chunk #${index} for "${safeKey}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private async tryReadManifestFromDir(
    safeKey: string,
  ): Promise<StoredModelArtifactManifest | null> {
    const modelsRoot = this.requireModelsRoot();
    let dir: OpfsDirectoryHandleLike;
    try {
      dir = await modelsRoot.getDirectoryHandle(safeKey, { create: false });
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }

    let fh: OpfsFileHandleLike;
    try {
      fh = await dir.getFileHandle(MODEL_ARTIFACT_MANIFEST_FILE, { create: false });
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }

    const text = await readTextFromFileHandle(fh);
    const parsed = safeParseJsonWithGuards<unknown>(text, 4 * 1024 * 1024);
    return validateStoredModelArtifactManifest(parsed, safeKey);
  }

  public async getInstalledManifest(
    key: string,
  ): Promise<StoredModelArtifactManifest | null> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'installedKey');
    try {
      return await this.tryReadManifestFromDir(safeKey);
    } catch (err) {
      if (err instanceof ModelRepositoryError) {
        throw err;
      }
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Failed to read or validate manifest for "${safeKey}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private async deleteDirectoryIfExists(safeKey: string): Promise<void> {
    const modelsRoot = this.requireModelsRoot();
    try {
      await modelsRoot.removeEntry(safeKey, { recursive: true });
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw new ModelRepositoryError(
          'MODEL_WRITE_FAILED',
          `Failed to delete model artifact directory "${safeKey}": ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }
  }

  public async deleteTemporaryArtifact(key: string): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    this.stagingStates.delete(safeKey);
    await this.deleteDirectoryIfExists(safeKey);
  }

  public async deleteInstalledArtifact(key: string): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'installedKey');
    this.stagingStates.delete(safeKey);
    await this.deleteDirectoryIfExists(safeKey);
  }

  public async listArtifacts(): Promise<{
    installed: string[];
    temporary: string[];
  }> {
    await this.initialize();
    const modelsRoot = this.requireModelsRoot();
    const entries = await listDirectoryEntries(modelsRoot);
    const installed: string[] = [];
    const temporary: string[] = [];

    for (const entry of entries) {
      if (entry.name === MODEL_REGISTRY_DIR) continue;
      if (entry.kind === 'file') continue;

      let validSegment: string;
      try {
        validSegment = validateModelPathSegment(entry.name, 'artifactDirectory');
      } catch {
        continue;
      }

      try {
        const manifest = await this.tryReadManifestFromDir(validSegment);
        if (manifest) {
          installed.push(validSegment);
        } else {
          temporary.push(validSegment);
        }
      } catch {
        // Corrupted manifest directory is never considered validly installed
        temporary.push(validSegment);
      }
    }

    installed.sort();
    temporary.sort();
    return { installed, temporary };
  }

  private async readRegistryPointerFile(
    fileName: string,
  ): Promise<PersistedModelRegistryPointer | null> {
    await this.initialize();
    const regDir = this.requireRegistryDir();
    let fh: OpfsFileHandleLike;
    try {
      fh = await regDir.getFileHandle(fileName, { create: false });
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw new ModelRepositoryError(
        'MODEL_REGISTRY_CORRUPTED',
        `Unable to open registry file "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    try {
      const text = await readTextFromFileHandle(fh);
      if (!text.trim()) return null;
      const parsed = safeParseJsonWithGuards<unknown>(text, 256 * 1024);
      if (parsed === null) return null;
      return validatePersistedModelRegistryPointer(parsed);
    } catch (err) {
      if (err instanceof ModelRepositoryError) throw err;
      throw new ModelRepositoryError(
        'MODEL_REGISTRY_CORRUPTED',
        `Corrupted model registry file "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private async writeRegistryPointerFile(
    fileName: string,
    pointer: PersistedModelRegistryPointer | null,
  ): Promise<void> {
    await this.initialize();
    const regDir = this.requireRegistryDir();

    if (this.options.onBeforeWriteRegistry) {
      await this.options.onBeforeWriteRegistry(fileName);
    }

    if (pointer === null) {
      try {
        await regDir.removeEntry(fileName);
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw new ModelRepositoryError(
            'MODEL_WRITE_FAILED',
            `Failed to clear registry file "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
      }
      return;
    }

    const validated = validatePersistedModelRegistryPointer(pointer);
    await writeJsonAtomically(regDir, fileName, validated);
  }

  public async readActiveRegistryPointer(): Promise<PersistedModelRegistryPointer | null> {
    return this.readRegistryPointerFile(ACTIVE_MODEL_REGISTRY_FILE);
  }

  public async readPreviousRegistryPointer(): Promise<PersistedModelRegistryPointer | null> {
    return this.readRegistryPointerFile(PREVIOUS_MODEL_REGISTRY_FILE);
  }

  public async writeActiveRegistryPointer(
    pointer: PersistedModelRegistryPointer | null,
  ): Promise<void> {
    return this.writeRegistryPointerFile(ACTIVE_MODEL_REGISTRY_FILE, pointer);
  }

  public async writePreviousRegistryPointer(
    pointer: PersistedModelRegistryPointer | null,
  ): Promise<void> {
    return this.writeRegistryPointerFile(PREVIOUS_MODEL_REGISTRY_FILE, pointer);
  }
}
