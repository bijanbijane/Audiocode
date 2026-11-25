import {
  LocalModelManifest,
  validateLocalModelManifest,
} from '../security/LocalPrivacyPolicy';
import { IncrementalSha256 } from '../utils/StreamingSha256';
import {
  ChunkedModelManifest,
  createChunkedModelManifestFromStoredArtifact,
} from '../platform/ChunkedModelDelivery';
import {
  buildModelArtifactDirectory,
  computeRequiredModelQuotaBytes,
  isQuotaExceededError,
  MAX_MODEL_CHUNK_BYTES,
  MODEL_CHUNK_SIZE_BYTES,
  ModelArchitecture,
  ModelRepositoryError,
  PersistedModelRegistryPointer,
  StoredModelArtifactManifest,
  StoredModelChunkEntry,
  StreamingModelChunkStorage,
  validateModelPathSegment,
  validatePersistedModelRegistryPointer,
  validateStoredModelArtifactManifest,
} from './ModelRepositoryContracts';
import { OpfsModelChunkStorage } from './OpfsModelChunkStorage';

export type ModelLifecycleState =
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_AVAILABLE'
  | 'DOWNLOAD_PENDING'
  | 'DOWNLOAD_IN_PROGRESS'
  | 'DOWNLOAD_PAUSED'
  | 'DOWNLOAD_INTERRUPTED'
  | 'DOWNLOAD_RESUMED'
  | 'CHECKSUM_VERIFICATION'
  | 'INTEGRITY_FAILURE'
  | 'INSTALLATION_COMPLETED'
  | 'MODEL_LOADING'
  | 'MODEL_READY'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_INCOMPATIBLE'
  | 'MODEL_UPDATE_AVAILABLE'
  | 'MODEL_REMOVED';

export interface InstalledModelDescriptor {
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
}

export interface PartialModelDownloadRecord {
  readonly modelId: string;
  readonly version: string;
  readonly expectedByteLength: number;
  readonly expectedSha256Hex: string;
  readonly receivedBytes: number;
  readonly supportsRangeResume: boolean;
  readonly updatedAtMs: number;
}

export type ModelChunkStorageAdapter = StreamingModelChunkStorage;

interface InMemoryStagingBucket {
  readonly expectedByteLength: number;
  readonly chunkSizeBytes: number;
  readonly chunks: Map<number, Uint8Array>;
  persistedBytes: number;
}

interface InMemoryInstalledBucket {
  manifest: StoredModelArtifactManifest;
  readonly chunks: Map<number, Uint8Array>;
}

/**
 * Deterministic chunk-addressable in-memory storage adapter for UNIT TESTS ONLY.
 *
 * Production code MUST use `OpfsModelChunkStorage`.
 * Unlike the legacy concatenated-buffer implementation, this adapter stores chunks
 * in indexed `Map<number, Uint8Array>` buckets (O(1) per chunk, zero O(n^2) copying)
 * and persists manifest/registry pointers strictly in accordance with `StreamingModelChunkStorage`.
 */
export class InMemoryModelChunkStorage implements StreamingModelChunkStorage {
  private readonly tempArtifacts = new Map<string, InMemoryStagingBucket>();
  private readonly installedArtifacts = new Map<string, InMemoryInstalledBucket>();
  private activePointer: PersistedModelRegistryPointer | null = null;
  private previousPointer: PersistedModelRegistryPointer | null = null;
  private initialized = false;

  public simulatedAvailableQuotaBytes: number | null = null;
  public simulatedStorageUnavailable = false;
  public failOnChunkWriteIndex: number | null = null;
  public failOnChunkWriteError: Error | null = null;
  public failOnPromote = false;
  public failOnWriteActivePointer = false;
  public corruptedRegistryPointer = false;

  public isStorageAvailable(): boolean {
    return this.initialized && !this.simulatedStorageUnavailable;
  }

  public getStorageBackendName(): 'MEMORY_TEST' {
    return 'MEMORY_TEST';
  }

  public async initialize(): Promise<void> {
    if (this.simulatedStorageUnavailable) {
      this.initialized = false;
      throw new ModelRepositoryError(
        'MODEL_STORAGE_UNAVAILABLE',
        'Simulated storage unavailable.',
      );
    }
    this.initialized = true;
  }

  public async getAvailableQuotaBytes(): Promise<number | null> {
    return this.simulatedAvailableQuotaBytes;
  }

  public async beginTemporaryArtifact(params: {
    key: string;
    expectedByteLength: number;
    chunkSizeBytes: number;
  }): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(params.key, 'temporaryKey');
    if (this.installedArtifacts.has(safeKey)) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Refusing to overwrite committed model artifact "${safeKey}".`,
      );
    }
    this.tempArtifacts.set(safeKey, {
      expectedByteLength: params.expectedByteLength,
      chunkSizeBytes: params.chunkSizeBytes,
      chunks: new Map<number, Uint8Array>(),
      persistedBytes: 0,
    });
  }

  public async writeTemporaryChunk(
    key: string,
    offset: number,
    chunk: Uint8Array,
  ): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    const bucket = this.tempArtifacts.get(safeKey);
    if (!bucket) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Temporary artifact "${safeKey}" not initialized.`,
      );
    }
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_MODEL_CHUNK_BYTES) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Invalid chunk size ${chunk.byteLength} (must be 1..${MAX_MODEL_CHUNK_BYTES}).`,
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % bucket.chunkSizeBytes !== 0) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Unaligned chunk offset ${offset} for chunkSizeBytes=${bucket.chunkSizeBytes}.`,
      );
    }
    const index = Math.floor(offset / bucket.chunkSizeBytes);
    if (this.failOnChunkWriteIndex === index) {
      if (this.failOnChunkWriteError) {
        throw this.failOnChunkWriteError;
      }
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Simulated write failure at chunk #${index}.`,
      );
    }
    const prev = bucket.chunks.get(index);
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    bucket.chunks.set(index, copy);
    bucket.persistedBytes = bucket.persistedBytes - (prev?.byteLength ?? 0) + copy.byteLength;
  }

  public async readTemporaryChunk(key: string, index: number): Promise<Uint8Array | null> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    const bucket = this.tempArtifacts.get(safeKey);
    const found = bucket?.chunks.get(index);
    return found ? new Uint8Array(found) : null;
  }

  public async getTemporaryArtifactSize(key: string): Promise<number> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    return this.tempArtifacts.get(safeKey)?.persistedBytes ?? 0;
  }

  public async promoteTemporaryArtifact(
    temporaryKey: string,
    installedKey: string,
    manifest: StoredModelArtifactManifest,
  ): Promise<void> {
    await this.initialize();
    const safeTemp = validateModelPathSegment(temporaryKey, 'temporaryKey');
    const safeInstalled = validateModelPathSegment(installedKey, 'installedKey');
    const validated = validateStoredModelArtifactManifest(manifest, safeInstalled);

    if (this.failOnPromote) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `Simulated manifest commit failure for "${safeInstalled}".`,
      );
    }

    const bucket = this.tempArtifacts.get(safeTemp);
    if (!bucket) {
      throw new ModelRepositoryError(
        'MODEL_INTEGRITY_FAILURE',
        `Temporary artifact "${safeTemp}" does not exist.`,
      );
    }

    const committedChunks = new Map<number, Uint8Array>();
    for (const c of validated.chunks) {
      const data = bucket.chunks.get(c.index);
      if (!data || data.byteLength !== c.byteLength) {
        throw new ModelRepositoryError(
          'MODEL_INTEGRITY_FAILURE',
          `Missing or mismatched chunk #${c.index} during promotion of "${safeTemp}".`,
        );
      }
      committedChunks.set(c.index, data);
    }

    this.installedArtifacts.set(safeInstalled, {
      manifest: validated,
      chunks: committedChunks,
    });
    this.tempArtifacts.delete(safeTemp);
  }

  public async readInstalledChunk(key: string, index: number): Promise<Uint8Array | null> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'installedKey');
    const found = this.installedArtifacts.get(safeKey)?.chunks.get(index);
    return found ? new Uint8Array(found) : null;
  }

  public async getInstalledManifest(key: string): Promise<StoredModelArtifactManifest | null> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'installedKey');
    const found = this.installedArtifacts.get(safeKey);
    if (!found) return null;
    return validateStoredModelArtifactManifest(found.manifest, safeKey);
  }

  public async deleteTemporaryArtifact(key: string): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'temporaryKey');
    this.tempArtifacts.delete(safeKey);
  }

  public async deleteInstalledArtifact(key: string): Promise<void> {
    await this.initialize();
    const safeKey = validateModelPathSegment(key, 'installedKey');
    this.installedArtifacts.delete(safeKey);
  }

  public async listArtifacts(): Promise<{ installed: string[]; temporary: string[] }> {
    await this.initialize();
    return {
      installed: Array.from(this.installedArtifacts.keys()).sort(),
      temporary: Array.from(this.tempArtifacts.keys()).sort(),
    };
  }

  public async readActiveRegistryPointer(): Promise<PersistedModelRegistryPointer | null> {
    await this.initialize();
    if (this.corruptedRegistryPointer) {
      throw new ModelRepositoryError(
        'MODEL_REGISTRY_CORRUPTED',
        'Simulated corrupted active-model.json.',
      );
    }
    return this.activePointer ? validatePersistedModelRegistryPointer(this.activePointer) : null;
  }

  public async readPreviousRegistryPointer(): Promise<PersistedModelRegistryPointer | null> {
    await this.initialize();
    if (this.corruptedRegistryPointer) {
      throw new ModelRepositoryError(
        'MODEL_REGISTRY_CORRUPTED',
        'Simulated corrupted previous-model.json.',
      );
    }
    return this.previousPointer ? validatePersistedModelRegistryPointer(this.previousPointer) : null;
  }

  public async writeActiveRegistryPointer(
    pointer: PersistedModelRegistryPointer | null,
  ): Promise<void> {
    await this.initialize();
    if (this.failOnWriteActivePointer) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        'Simulated active-model.json commit failure.',
      );
    }
    this.activePointer = pointer ? validatePersistedModelRegistryPointer(pointer) : null;
  }

  public async writePreviousRegistryPointer(
    pointer: PersistedModelRegistryPointer | null,
  ): Promise<void> {
    await this.initialize();
    this.previousPointer = pointer ? validatePersistedModelRegistryPointer(pointer) : null;
  }

  /** Test helper to simulate on-disk bit-flip corruption of a stored chunk */
  public corruptInstalledChunkForTest(key: string, index: number): void {
    const bucket = this.installedArtifacts.get(key);
    const chunk = bucket?.chunks.get(index);
    if (chunk && chunk.byteLength > 0) {
      chunk[0] = chunk[0] ^ 0xff;
    }
  }

  /** Test helper to simulate missing chunk file on disk */
  public deleteInstalledChunkForTest(key: string, index: number): void {
    this.installedArtifacts.get(key)?.chunks.delete(index);
  }
}

export interface ModelDownloadChunkStream {
  readonly supportsRangeResume: boolean;
  fetchRange(startByte: number, endByteExclusive: number): Promise<Uint8Array>;
}

export interface LocalModelLifecycleSnapshot {
  readonly state: ModelLifecycleState;
  readonly initialized: boolean;
  readonly runtimeReady: boolean;
  readonly storageBackend: 'OPFS' | 'MEMORY_TEST';
  readonly activeModel: InstalledModelDescriptor | null;
  readonly previousVerifiedModel: InstalledModelDescriptor | null;
  readonly partialDownload: PartialModelDownloadRecord | null;
  readonly downloadProgressPct: number | null;
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
}

function descriptorFromPointer(ptr: PersistedModelRegistryPointer): InstalledModelDescriptor {
  return {
    modelId: ptr.modelId,
    version: ptr.version,
    generationId: ptr.generationId,
    storageDirectory: ptr.storageDirectory,
    architecture: ptr.architecture,
    supportedRuntime: ptr.supportedRuntime,
    supportedExecutionProviders: [...ptr.supportedExecutionProviders],
    fileName: ptr.fileName,
    fileSizeBytes: ptr.fileSizeBytes,
    verifiedSha256Hex: ptr.verifiedSha256Hex,
    license: ptr.license,
    sourceOrigin: ptr.sourceOrigin,
    compatibilityMinAppVersion: ptr.compatibilityMinAppVersion,
    installedAtMs: ptr.installedAtMs,
  };
}

function pointerFromDescriptor(
  desc: InstalledModelDescriptor,
  committedAtMs: number,
): PersistedModelRegistryPointer {
  return {
    schemaVersion: 1,
    modelId: desc.modelId,
    version: desc.version,
    generationId: desc.generationId,
    storageDirectory: desc.storageDirectory,
    architecture: desc.architecture,
    supportedRuntime: desc.supportedRuntime,
    supportedExecutionProviders: [...desc.supportedExecutionProviders],
    fileName: desc.fileName,
    fileSizeBytes: desc.fileSizeBytes,
    verifiedSha256Hex: desc.verifiedSha256Hex,
    license: desc.license,
    sourceOrigin: desc.sourceOrigin,
    compatibilityMinAppVersion: desc.compatibilityMinAppVersion,
    installedAtMs: desc.installedAtMs,
    committedAtMs,
  };
}

/**
 * Local Model Installation, Persistent OPFS Repository, Incremental Verification & Rollback Manager
 * (AVP-P09-001 / AVP-MODEL-OPFS-DURABILITY-008)
 *
 * Guarantees:
 * - Production default storage is durable chunk-addressable `OpfsModelChunkStorage` (OPFS/ai-models/).
 * - Zero complete-model `Uint8Array` or `ArrayBuffer` allocation during installation or verification.
 * - Incremental SHA-256 verification per chunk and across the full persisted artifact.
 * - Never overwrites or invalidates a working active model when a replacement fails.
 * - Never emits `MODEL_READY` based solely on file existence or SHA-256 verification;
 *   durable verified models enter `MODEL_AVAILABLE`, while `MODEL_READY` requires explicit runtime readiness.
 * - Model removal and cleanup never touch user projects, audio assets, or exported files.
 */
export class LocalModelLifecycleManager {
  private readonly storage: StreamingModelChunkStorage;
  private state: ModelLifecycleState = 'MODEL_NOT_INSTALLED';
  private initialized = false;
  private initPromise: Promise<LocalModelLifecycleSnapshot> | null = null;
  private runtimeReady = false;
  private activeModel: InstalledModelDescriptor | null = null;
  private previousVerifiedModel: InstalledModelDescriptor | null = null;
  private partialDownload: PartialModelDownloadRecord | null = null;
  private downloadProgressPct: number | null = null;
  private lastError: string | null = null;
  private lastErrorCode: string | null = null;
  private generationSeq = 0;

  constructor(storage?: StreamingModelChunkStorage) {
    this.storage = storage ?? new OpfsModelChunkStorage();
  }

  public getSnapshot(): LocalModelLifecycleSnapshot {
    const backend = this.storage.getStorageBackendName?.() ?? 'OPFS';
    return Object.freeze({
      state: this.state,
      initialized: this.initialized,
      runtimeReady: this.runtimeReady,
      storageBackend: backend,
      activeModel: this.activeModel ? { ...this.activeModel } : null,
      previousVerifiedModel: this.previousVerifiedModel
        ? { ...this.previousVerifiedModel }
        : null,
      partialDownload: this.partialDownload ? { ...this.partialDownload } : null,
      downloadProgressPct: this.downloadProgressPct,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
    });
  }

  /**
   * Startup hydration barrier: initializes durable OPFS storage, reads persisted active/previous
   * registry pointers, validates stored manifests, and incrementally verifies every persisted chunk
   * of the active model before exposing it as `MODEL_AVAILABLE`.
   */
  public async initialize(): Promise<LocalModelLifecycleSnapshot> {
    if (this.initialized) {
      return this.getSnapshot();
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    const run = this.performInitialize();
    this.initPromise = run;
    try {
      return await run;
    } finally {
      this.initPromise = null;
    }
  }

  private async performInitialize(): Promise<LocalModelLifecycleSnapshot> {
    this.runtimeReady = false;
    try {
      await this.storage.initialize();
    } catch (err) {
      this.initialized = true;
      this.activeModel = null;
      this.previousVerifiedModel = null;
      this.state = 'MODEL_UNAVAILABLE';
      this.lastErrorCode =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_STORAGE_UNAVAILABLE';
      this.lastError = err instanceof Error ? err.message : String(err);
      return this.getSnapshot();
    }

    let activePtr: PersistedModelRegistryPointer | null = null;
    let previousPtr: PersistedModelRegistryPointer | null = null;

    try {
      activePtr = (await this.storage.readActiveRegistryPointer?.()) ?? null;
      previousPtr = (await this.storage.readPreviousRegistryPointer?.()) ?? null;
    } catch (err) {
      this.initialized = true;
      this.activeModel = null;
      this.previousVerifiedModel = null;
      this.state = 'MODEL_UNAVAILABLE';
      this.lastErrorCode =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_REGISTRY_CORRUPTED';
      this.lastError = err instanceof Error ? err.message : String(err);
      return this.getSnapshot();
    }

    // Hydrate previous verified model descriptor only if its committed manifest exists and matches
    this.previousVerifiedModel = null;
    if (previousPtr) {
      try {
        const prevManifest = await this.storage.getInstalledManifest(previousPtr.storageDirectory);
        if (
          prevManifest &&
          this.manifestMatchesDescriptor(prevManifest, descriptorFromPointer(previousPtr))
        ) {
          this.previousVerifiedModel = descriptorFromPointer(previousPtr);
        }
      } catch {
        this.previousVerifiedModel = null;
      }
    }

    if (!activePtr) {
      this.initialized = true;
      this.activeModel = null;
      this.state = 'MODEL_NOT_INSTALLED';
      this.lastError = null;
      this.lastErrorCode = null;
      return this.getSnapshot();
    }

    const candidateDescriptor = descriptorFromPointer(activePtr);
    const verification = await this.verifyArtifactIncrementally(candidateDescriptor);
    this.initialized = true;

    if (!verification.ok) {
      this.activeModel = null;
      this.runtimeReady = false;
      this.state = verification.storageUnavailable ? 'MODEL_UNAVAILABLE' : 'INTEGRITY_FAILURE';
      this.lastErrorCode = verification.errorCode;
      this.lastError = verification.error;
      return this.getSnapshot();
    }

    this.activeModel = candidateDescriptor;
    this.runtimeReady = false;
    // Storage + SHA-256 verification establishes durable availability, NEVER runtime readiness.
    this.state = 'MODEL_AVAILABLE';
    this.lastError = null;
    this.lastErrorCode = null;
    return this.getSnapshot();
  }

  /**
   * Explicitly records ONNX/WASM runtime readiness for the currently verified active model.
   * This is the ONLY valid transition from `MODEL_AVAILABLE` to `MODEL_READY`.
   */
  public markRuntimeReady(ready: boolean): LocalModelLifecycleSnapshot {
    if (ready) {
      if (
        this.activeModel &&
        (this.state === 'MODEL_AVAILABLE' || this.state === 'MODEL_READY')
      ) {
        this.runtimeReady = true;
        this.state = 'MODEL_READY';
      }
    } else {
      this.runtimeReady = false;
      if (this.state === 'MODEL_READY') {
        this.state = this.activeModel ? 'MODEL_AVAILABLE' : 'MODEL_NOT_INSTALLED';
      }
    }
    return this.getSnapshot();
  }

  /**
   * Returns the unified `ChunkedModelManifest` for the currently verified active model
   * so `WebWorkerOrtRuntimeProvider` resolves the exact same OPFS artifact directory and chunks.
   */
  public async getActiveRuntimeManifest(): Promise<ChunkedModelManifest | null> {
    if (!this.activeModel) return null;
    const manifest = await this.storage.getInstalledManifest(this.activeModel.storageDirectory);
    if (!manifest || !this.manifestMatchesDescriptor(manifest, this.activeModel)) {
      return null;
    }
    return createChunkedModelManifestFromStoredArtifact(manifest);
  }

  /**
   * Streams a local or downloaded ONNX model into an isolated staging generation directory
   * (`OPFS/ai-models/{modelId}_{version}_{generationId}/`) using strictly bounded <= 1 MiB chunks,
   * re-reads and incrementally verifies every persisted chunk + full-file SHA-256, commits
   * `manifest.json`, and atomically updates `previous-model.json` and `active-model.json`.
   */
  public async installOrUpdateFromStream(params: {
    readonly manifest: LocalModelManifest;
    readonly stream: ModelDownloadChunkStream;
    readonly license: string;
    readonly sourceOrigin: string;
    readonly chunkSizeBytes?: number;
    readonly abortSignal?: AbortSignal;
    readonly shouldPause?: () => boolean;
    readonly onProgress?: (pct: number, receivedBytes: number, totalBytes: number) => void;
    readonly nowMs?: number;
  }): Promise<{
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly snapshot: LocalModelLifecycleSnapshot;
  }> {
    const previousActiveModel = this.activeModel ? { ...this.activeModel } : null;
    const previousPriorModel = this.previousVerifiedModel
      ? { ...this.previousVerifiedModel }
      : null;
    const previousState = this.state;
    const previousRuntimeReady = this.runtimeReady;

    const restoreOrSetFailureState = (
      failureState: ModelLifecycleState,
      errorCode: string,
      errorMessage: string,
    ): { readonly ok: false; readonly errorCode: string; readonly snapshot: LocalModelLifecycleSnapshot } => {
      this.partialDownload = null;
      this.downloadProgressPct = null;
      this.lastErrorCode = errorCode;
      this.lastError = errorMessage;

      if (previousActiveModel) {
        // Replacement failed: preserve the previously working active model intact.
        this.activeModel = previousActiveModel;
        this.previousVerifiedModel = previousPriorModel;
        this.runtimeReady = previousRuntimeReady;
        this.state =
          previousState === 'MODEL_READY' || previousState === 'MODEL_AVAILABLE'
            ? previousState
            : 'MODEL_AVAILABLE';
      } else {
        this.activeModel = null;
        this.runtimeReady = false;
        this.state = failureState;
      }

      return { ok: false, errorCode, snapshot: this.getSnapshot() };
    };

    let manifest: LocalModelManifest;
    try {
      manifest = validateLocalModelManifest(params.manifest);
      validateModelPathSegment(manifest.modelId, 'modelId');
      validateModelPathSegment(manifest.modelVersion, 'version');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_MANIFEST_INVALID';
      return restoreOrSetFailureState('INTEGRITY_FAILURE', code, msg);
    }

    try {
      await this.storage.initialize();
      this.initialized = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_STORAGE_UNAVAILABLE';
      return restoreOrSetFailureState('MODEL_UNAVAILABLE', code, msg);
    }

    const nowMs = params.nowMs ?? Date.now();
    const requestedChunkSize = params.chunkSizeBytes ?? MODEL_CHUNK_SIZE_BYTES;
    const chunkSize = Math.min(
      MAX_MODEL_CHUNK_BYTES,
      Math.max(1024, Math.trunc(requestedChunkSize)),
    );

    // Pre-write quota check with required safety margin (expectedByteLength + max(16 MiB, 5%))
    const requiredQuotaBytes = computeRequiredModelQuotaBytes(manifest.expectedByteLength);
    const availableQuota = await this.storage.getAvailableQuotaBytes?.();
    if (typeof availableQuota === 'number' && availableQuota < requiredQuotaBytes) {
      return restoreOrSetFailureState(
        'MODEL_UNAVAILABLE',
        'MODEL_STORAGE_QUOTA_EXCEEDED',
        `MODEL_STORAGE_QUOTA_EXCEEDED: Insufficient storage quota (${availableQuota} B available, ${requiredQuotaBytes} B required including safety margin).`,
      );
    }

    const generationId = `g${nowMs.toString(36)}-${(++this.generationSeq).toString(36)}`;
    const artifactDir = buildModelArtifactDirectory(
      manifest.modelId,
      manifest.modelVersion,
      generationId,
    );

    let stagingCreated = false;
    let promoted = false;
    let previousPointerUpdated = false;
    const existingPersistedPreviousPtr: PersistedModelRegistryPointer | null =
      previousPriorModel
        ? pointerFromDescriptor(previousPriorModel, previousPriorModel.installedAtMs)
        : null;

    this.state = 'DOWNLOAD_PENDING';
    this.lastError = null;
    this.lastErrorCode = null;
    this.partialDownload = {
      modelId: manifest.modelId,
      version: manifest.modelVersion,
      expectedByteLength: manifest.expectedByteLength,
      expectedSha256Hex: manifest.expectedSha256Hex,
      receivedBytes: 0,
      supportsRangeResume: params.stream.supportsRangeResume,
      updatedAtMs: nowMs,
    };

    try {
      await this.storage.beginTemporaryArtifact({
        key: artifactDir,
        expectedByteLength: manifest.expectedByteLength,
        chunkSizeBytes: chunkSize,
      });
      stagingCreated = true;

      this.state = 'DOWNLOAD_IN_PROGRESS';
      let offset = 0;
      let chunkIndex = 0;
      const recordedChunks: StoredModelChunkEntry[] = [];

      while (offset < manifest.expectedByteLength) {
        if (params.abortSignal?.aborted) {
          await this.safeDeleteTemporary(artifactDir);
          return restoreOrSetFailureState(
            'DOWNLOAD_INTERRUPTED',
            'MODEL_INSTALL_ABORTED',
            'Model installation cancelled before completion.',
          );
        }
        if (params.shouldPause?.()) {
          await this.safeDeleteTemporary(artifactDir);
          return restoreOrSetFailureState(
            'DOWNLOAD_PAUSED',
            'MODEL_INSTALL_PAUSED',
            'Model installation paused before completion.',
          );
        }

        const end = Math.min(manifest.expectedByteLength, offset + chunkSize);
        const expectedChunkLen = end - offset;
        const chunk = await params.stream.fetchRange(offset, end);

        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== expectedChunkLen) {
          await this.safeDeleteTemporary(artifactDir);
          return restoreOrSetFailureState(
            'DOWNLOAD_INTERRUPTED',
            'MODEL_CHUNK_LENGTH_MISMATCH',
            `Stream returned ${chunk?.byteLength ?? 0} B for range [${offset}, ${end}) (expected ${expectedChunkLen} B).`,
          );
        }

        const chunkHash = new IncrementalSha256().update(chunk).digestHex();
        await this.storage.writeTemporaryChunk(artifactDir, offset, chunk);

        recordedChunks.push({
          index: chunkIndex,
          byteLength: chunk.byteLength,
          sha256Hex: chunkHash,
        });

        offset += chunk.byteLength;
        chunkIndex += 1;

        const pct = Math.min(99, Math.round((offset / manifest.expectedByteLength) * 100));
        this.downloadProgressPct = pct;
        this.partialDownload = {
          ...this.partialDownload,
          receivedBytes: offset,
          updatedAtMs: Date.now(),
        };
        params.onProgress?.(pct, offset, manifest.expectedByteLength);
      }

      if (params.abortSignal?.aborted) {
        await this.safeDeleteTemporary(artifactDir);
        return restoreOrSetFailureState(
          'DOWNLOAD_INTERRUPTED',
          'MODEL_INSTALL_ABORTED',
          'Model installation cancelled before verification.',
        );
      }

      // Mandatory incremental re-read & SHA-256 verification from persisted temporary chunks
      // (ZERO full-file allocation in RAM).
      this.state = 'CHECKSUM_VERIFICATION';
      const persistedSize = await this.storage.getTemporaryArtifactSize(artifactDir);
      if (persistedSize !== manifest.expectedByteLength) {
        await this.safeDeleteTemporary(artifactDir);
        return restoreOrSetFailureState(
          'INTEGRITY_FAILURE',
          'MODEL_INTEGRITY_FAILURE',
          `Persisted byte count (${persistedSize}) != expected (${manifest.expectedByteLength}).`,
        );
      }

      const fullHasher = new IncrementalSha256();
      let verifiedBytes = 0;

      for (const expectedChunk of recordedChunks) {
        const persistedChunk = await this.storage.readTemporaryChunk(
          artifactDir,
          expectedChunk.index,
        );
        if (!persistedChunk || persistedChunk.byteLength !== expectedChunk.byteLength) {
          await this.safeDeleteTemporary(artifactDir);
          return restoreOrSetFailureState(
            'INTEGRITY_FAILURE',
            'MODEL_INTEGRITY_FAILURE',
            `Persisted chunk #${expectedChunk.index} is missing or size-mismatched during verification.`,
          );
        }

        const rereadChunkHash = new IncrementalSha256().update(persistedChunk).digestHex();
        if (rereadChunkHash !== expectedChunk.sha256Hex) {
          await this.safeDeleteTemporary(artifactDir);
          return restoreOrSetFailureState(
            'INTEGRITY_FAILURE',
            'MODEL_INTEGRITY_FAILURE',
            `Persisted chunk #${expectedChunk.index} failed SHA-256 readback verification.`,
          );
        }

        fullHasher.update(persistedChunk);
        verifiedBytes += persistedChunk.byteLength;
      }

      if (verifiedBytes !== manifest.expectedByteLength) {
        await this.safeDeleteTemporary(artifactDir);
        return restoreOrSetFailureState(
          'INTEGRITY_FAILURE',
          'MODEL_INTEGRITY_FAILURE',
          `Verified byte count (${verifiedBytes}) != expected (${manifest.expectedByteLength}).`,
        );
      }

      const actualFullHash = fullHasher.digestHex();
      if (actualFullHash !== manifest.expectedSha256Hex) {
        await this.safeDeleteTemporary(artifactDir);
        return restoreOrSetFailureState(
          'INTEGRITY_FAILURE',
          'MODEL_INTEGRITY_FAILURE',
          `SHA-256 checksum mismatch: expected ${manifest.expectedSha256Hex}, actual ${actualFullHash}. Working model (if any) left untouched.`,
        );
      }

      const committedAtMs = Date.now();
      const storedManifest = validateStoredModelArtifactManifest(
        {
          schemaVersion: 1,
          modelId: manifest.modelId,
          version: manifest.modelVersion,
          generationId,
          architecture: manifest.architecture,
          storageBackend: 'OPFS',
          storageDirectory: artifactDir,
          fileName: manifest.fileName,
          totalBytes: manifest.expectedByteLength,
          chunkSizeBytes: chunkSize,
          chunkCount: recordedChunks.length,
          sha256Hex: actualFullHash,
          chunks: recordedChunks,
          committedAtMs,
        },
        artifactDir,
      );

      // Commit artifact manifest inside the isolated generation directory
      await this.storage.promoteTemporaryArtifact(artifactDir, artifactDir, storedManifest);
      promoted = true;

      const nextActiveDescriptor: InstalledModelDescriptor = {
        modelId: manifest.modelId,
        version: manifest.modelVersion,
        generationId,
        storageDirectory: artifactDir,
        architecture: manifest.architecture,
        supportedRuntime: 'onnxruntime-web/wasm',
        supportedExecutionProviders: ['wasm', 'webgpu'],
        fileName: manifest.fileName,
        fileSizeBytes: manifest.expectedByteLength,
        verifiedSha256Hex: actualFullHash,
        license: params.license || 'Unspecified — verify upstream license before commercial use',
        sourceOrigin: params.sourceOrigin || 'local-user-import',
        compatibilityMinAppVersion: '1.0.0',
        installedAtMs: nowMs,
      };

      const nextActivePointer = pointerFromDescriptor(nextActiveDescriptor, committedAtMs);
      const nextPreviousPointer: PersistedModelRegistryPointer | null = previousActiveModel
        ? pointerFromDescriptor(previousActiveModel, previousActiveModel.installedAtMs)
        : null;

      // Persist previous-model.json first (if replacing an active model), then atomically commit active-model.json.
      if (nextPreviousPointer && this.storage.writePreviousRegistryPointer) {
        await this.storage.writePreviousRegistryPointer(nextPreviousPointer);
        previousPointerUpdated = true;
      }

      if (this.storage.writeActiveRegistryPointer) {
        await this.storage.writeActiveRegistryPointer(nextActivePointer);
      }

      // Commit succeeded — update in-memory state.
      this.previousVerifiedModel = previousActiveModel;
      this.activeModel = nextActiveDescriptor;
      this.runtimeReady = false;
      this.partialDownload = null;
      this.downloadProgressPct = 100;
      this.lastError = null;
      this.lastErrorCode = null;
      // Verified durable artifact enters MODEL_AVAILABLE; MODEL_READY requires runtime readiness.
      this.state = 'MODEL_AVAILABLE';

      // Best-effort cleanup of superseded grandparent artifact (never touching new active or new previous)
      if (
        previousPriorModel &&
        previousPriorModel.storageDirectory !== nextActiveDescriptor.storageDirectory &&
        previousPriorModel.storageDirectory !== previousActiveModel?.storageDirectory
      ) {
        await this.safeDeleteInstalled(previousPriorModel.storageDirectory);
      }

      return { ok: true, snapshot: this.getSnapshot() };
    } catch (err) {
      // Roll back previous-model.json if active-model.json failed to commit
      if (previousPointerUpdated && this.storage.writePreviousRegistryPointer) {
        try {
          await this.storage.writePreviousRegistryPointer(existingPersistedPreviousPtr);
        } catch {
          // ignore rollback cleanup error
        }
      }

      if (promoted) {
        await this.safeDeleteInstalled(artifactDir);
      } else if (stagingCreated) {
        await this.safeDeleteTemporary(artifactDir);
      }

      if (isQuotaExceededError(err)) {
        return restoreOrSetFailureState(
          'MODEL_UNAVAILABLE',
          'MODEL_STORAGE_QUOTA_EXCEEDED',
          err instanceof Error ? err.message : 'MODEL_STORAGE_QUOTA_EXCEEDED',
        );
      }

      const code =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_INSTALL_FAILED';
      const failureState: ModelLifecycleState =
        code === 'MODEL_STORAGE_UNAVAILABLE'
          ? 'MODEL_UNAVAILABLE'
          : code === 'MODEL_INTEGRITY_FAILURE' || code === 'MODEL_MANIFEST_INVALID'
            ? 'INTEGRITY_FAILURE'
            : 'DOWNLOAD_INTERRUPTED';
      return restoreOrSetFailureState(
        failureState,
        code,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Incrementally verifies every persisted chunk and the complete SHA-256 digest of the active
   * model without loading the full model into memory.
   */
  public async verifyInstalledActiveModelOffline(): Promise<{
    readonly ok: boolean;
    readonly state: ModelLifecycleState;
    readonly error?: string;
    readonly errorCode?: string;
  }> {
    if (!this.activeModel) {
      this.runtimeReady = false;
      this.state = 'MODEL_NOT_INSTALLED';
      return {
        ok: false,
        state: this.state,
        error: 'No installed local model found.',
        errorCode: 'MODEL_NOT_INSTALLED',
      };
    }

    const result = await this.verifyArtifactIncrementally(this.activeModel);
    if (!result.ok) {
      this.runtimeReady = false;
      this.state = result.storageUnavailable ? 'MODEL_UNAVAILABLE' : 'INTEGRITY_FAILURE';
      this.lastError = result.error;
      this.lastErrorCode = result.errorCode;
      return {
        ok: false,
        state: this.state,
        error: result.error,
        errorCode: result.errorCode,
      };
    }

    this.state = this.runtimeReady ? 'MODEL_READY' : 'MODEL_AVAILABLE';
    this.lastError = null;
    this.lastErrorCode = null;
    return { ok: true, state: this.state };
  }

  /**
   * Rolls back to the previous verified model ONLY after full incremental manifest and chunk
   * SHA-256 verification succeeds.
   */
  public async rollbackToPreviousVerifiedModel(): Promise<{
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly snapshot: LocalModelLifecycleSnapshot;
  }> {
    if (!this.previousVerifiedModel) {
      this.lastErrorCode = 'MODEL_ROLLBACK_UNAVAILABLE';
      this.lastError = 'No previous verified model is available for rollback.';
      return {
        ok: false,
        errorCode: this.lastErrorCode,
        snapshot: this.getSnapshot(),
      };
    }

    const candidate = { ...this.previousVerifiedModel };
    const verification = await this.verifyArtifactIncrementally(candidate);
    if (!verification.ok) {
      this.lastErrorCode = verification.errorCode;
      this.lastError = `Rollback aborted: ${verification.error}`;
      return {
        ok: false,
        errorCode: verification.errorCode,
        snapshot: this.getSnapshot(),
      };
    }

    const supersededActive = this.activeModel ? { ...this.activeModel } : null;
    const nextActivePtr = pointerFromDescriptor(candidate, Date.now());

    try {
      if (this.storage.writeActiveRegistryPointer) {
        await this.storage.writeActiveRegistryPointer(nextActivePtr);
      }
      if (this.storage.writePreviousRegistryPointer) {
        await this.storage.writePreviousRegistryPointer(null);
      }
    } catch (err) {
      this.lastErrorCode =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_WRITE_FAILED';
      this.lastError = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorCode: this.lastErrorCode,
        snapshot: this.getSnapshot(),
      };
    }

    this.activeModel = candidate;
    this.previousVerifiedModel = null;
    this.runtimeReady = false;
    this.state = 'MODEL_AVAILABLE';
    this.lastError = null;
    this.lastErrorCode = null;

    if (
      supersededActive &&
      supersededActive.storageDirectory !== candidate.storageDirectory
    ) {
      await this.safeDeleteInstalled(supersededActive.storageDirectory);
    }

    return { ok: true, snapshot: this.getSnapshot() };
  }

  /**
   * Removes the active installed model idempotently without ever touching user projects,
   * audio assets, or exported files.
   */
  public async removeActiveModel(): Promise<{
    readonly ok: boolean;
    readonly userProjectsPreserved: true;
    readonly snapshot: LocalModelLifecycleSnapshot;
  }> {
    try {
      await this.storage.initialize();
    } catch (err) {
      this.lastErrorCode =
        err instanceof ModelRepositoryError ? err.code : 'MODEL_STORAGE_UNAVAILABLE';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = 'MODEL_UNAVAILABLE';
      return { ok: false, userProjectsPreserved: true, snapshot: this.getSnapshot() };
    }

    const toDelete = this.activeModel?.storageDirectory ?? null;

    if (this.storage.writeActiveRegistryPointer) {
      await this.storage.writeActiveRegistryPointer(null);
    }

    if (
      toDelete &&
      toDelete !== this.previousVerifiedModel?.storageDirectory
    ) {
      await this.safeDeleteInstalled(toDelete);
    }

    this.activeModel = null;
    this.runtimeReady = false;
    this.state = 'MODEL_REMOVED';
    this.downloadProgressPct = null;
    this.lastError = null;
    this.lastErrorCode = null;
    return { ok: true, userProjectsPreserved: true, snapshot: this.getSnapshot() };
  }

  /**
   * Removes only incomplete/temporary staging directories and unreferenced orphaned model
   * directories. Never deletes active or previous verified model artifacts, and never touches
   * user projects or audio assets. Strictly idempotent.
   */
  public async cleanupInvalidPartialDownloads(): Promise<number> {
    await this.storage.initialize();
    const protectedDirs = new Set<string>();
    if (this.activeModel?.storageDirectory) {
      protectedDirs.add(this.activeModel.storageDirectory);
    }
    if (this.previousVerifiedModel?.storageDirectory) {
      protectedDirs.add(this.previousVerifiedModel.storageDirectory);
    }
    try {
      const activePtr = await this.storage.readActiveRegistryPointer?.();
      if (activePtr?.storageDirectory) protectedDirs.add(activePtr.storageDirectory);
    } catch {
      // ignore corrupted pointer during cleanup
    }
    try {
      const prevPtr = await this.storage.readPreviousRegistryPointer?.();
      if (prevPtr?.storageDirectory) protectedDirs.add(prevPtr.storageDirectory);
    } catch {
      // ignore corrupted pointer during cleanup
    }

    const listing = await this.storage.listArtifacts();
    let cleaned = 0;

    for (const tempDir of listing.temporary) {
      if (protectedDirs.has(tempDir)) continue;
      await this.storage.deleteTemporaryArtifact(tempDir);
      cleaned++;
    }

    for (const installedDir of listing.installed) {
      if (protectedDirs.has(installedDir)) continue;
      await this.storage.deleteInstalledArtifact(installedDir);
      cleaned++;
    }

    this.partialDownload = null;
    return cleaned;
  }

  private manifestMatchesDescriptor(
    manifest: StoredModelArtifactManifest,
    descriptor: InstalledModelDescriptor,
  ): boolean {
    return (
      manifest.modelId === descriptor.modelId &&
      manifest.version === descriptor.version &&
      manifest.generationId === descriptor.generationId &&
      manifest.storageDirectory === descriptor.storageDirectory &&
      manifest.totalBytes === descriptor.fileSizeBytes &&
      manifest.sha256Hex === descriptor.verifiedSha256Hex.toLowerCase()
    );
  }

  private async verifyArtifactIncrementally(
    descriptor: InstalledModelDescriptor,
  ): Promise<
    | { readonly ok: true; readonly manifest: StoredModelArtifactManifest }
    | {
        readonly ok: false;
        readonly storageUnavailable: boolean;
        readonly errorCode: string;
        readonly error: string;
      }
  > {
    try {
      await this.storage.initialize();
    } catch (err) {
      return {
        ok: false,
        storageUnavailable: true,
        errorCode:
          err instanceof ModelRepositoryError ? err.code : 'MODEL_STORAGE_UNAVAILABLE',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let manifest: StoredModelArtifactManifest | null;
    try {
      manifest = await this.storage.getInstalledManifest(descriptor.storageDirectory);
    } catch (err) {
      return {
        ok: false,
        storageUnavailable: false,
        errorCode:
          err instanceof ModelRepositoryError ? err.code : 'MODEL_MANIFEST_INVALID',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!manifest) {
      return {
        ok: false,
        storageUnavailable: false,
        errorCode: 'MODEL_INTEGRITY_FAILURE',
        error: `Installed model manifest missing for "${descriptor.storageDirectory}".`,
      };
    }

    if (!this.manifestMatchesDescriptor(manifest, descriptor)) {
      return {
        ok: false,
        storageUnavailable: false,
        errorCode: 'MODEL_MANIFEST_INVALID',
        error: `Installed model manifest identity mismatch for "${descriptor.storageDirectory}".`,
      };
    }

    const fullHasher = new IncrementalSha256();
    let totalVerifiedBytes = 0;

    for (let i = 0; i < manifest.chunks.length; i++) {
      const expectedChunk = manifest.chunks[i];
      let chunkBytes: Uint8Array | null;
      try {
        chunkBytes = await this.storage.readInstalledChunk(
          descriptor.storageDirectory,
          expectedChunk.index,
        );
      } catch (err) {
        return {
          ok: false,
          storageUnavailable: false,
          errorCode: err instanceof ModelRepositoryError ? err.code : 'MODEL_READ_FAILED',
          error: `Failed to read chunk #${expectedChunk.index}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!chunkBytes || chunkBytes.byteLength !== expectedChunk.byteLength) {
        return {
          ok: false,
          storageUnavailable: false,
          errorCode: 'MODEL_INTEGRITY_FAILURE',
          error: `Chunk #${expectedChunk.index} is missing or has unexpected length (${chunkBytes?.byteLength ?? 0} != ${expectedChunk.byteLength}).`,
        };
      }

      const actualChunkHash = new IncrementalSha256().update(chunkBytes).digestHex();
      if (actualChunkHash !== expectedChunk.sha256Hex) {
        return {
          ok: false,
          storageUnavailable: false,
          errorCode: 'MODEL_INTEGRITY_FAILURE',
          error: `Chunk #${expectedChunk.index} failed SHA-256 verification.`,
        };
      }

      fullHasher.update(chunkBytes);
      totalVerifiedBytes += chunkBytes.byteLength;
    }

    if (totalVerifiedBytes !== manifest.totalBytes) {
      return {
        ok: false,
        storageUnavailable: false,
        errorCode: 'MODEL_INTEGRITY_FAILURE',
        error: `Verified byte total (${totalVerifiedBytes}) != manifest totalBytes (${manifest.totalBytes}).`,
      };
    }

    const actualFullHash = fullHasher.digestHex();
    if (
      actualFullHash !== manifest.sha256Hex ||
      actualFullHash !== descriptor.verifiedSha256Hex.toLowerCase()
    ) {
      return {
        ok: false,
        storageUnavailable: false,
        errorCode: 'MODEL_INTEGRITY_FAILURE',
        error: `Full-artifact SHA-256 mismatch: expected ${descriptor.verifiedSha256Hex}, actual ${actualFullHash}.`,
      };
    }

    return { ok: true, manifest };
  }

  private async safeDeleteTemporary(key: string): Promise<void> {
    try {
      await this.storage.deleteTemporaryArtifact(key);
    } catch {
      // ignore best-effort cleanup failure
    }
  }

  private async safeDeleteInstalled(key: string): Promise<void> {
    try {
      await this.storage.deleteInstalledArtifact(key);
    } catch {
      // ignore best-effort cleanup failure
    }
  }
}
