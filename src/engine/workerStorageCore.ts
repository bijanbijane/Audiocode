import {
  AssetStorageLifecycleState,
  FileHandleLease,
  PersistedAudioAssetManifest,
  RollingCacheStats,
} from '../contracts/v1_2';
import {
  AVAPARDAZ_AUDIO_CACHE_SPLIT,
  AVAPARDAZ_MEMORY_POLICY,
} from '../runtime/memory/MemoryPolicy';

export type WorkerPersistenceBackend =
  | 'OPFS-SyncAccessHandle'
  | 'OPFS-Writable'
  | 'OPFS-Unavailable';

export interface OpfsSyncHandleLike {
  truncate(size: number): void;
  write(data: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  getSize(): number;
  read(data: ArrayBufferView, options?: { at?: number }): number;
  close(): void;
}

export interface OpfsWritableLike {
  write(data: ArrayBuffer | string): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandleLike {
  createSyncAccessHandle?: () => Promise<OpfsSyncHandleLike>;
  createWritable?: () => Promise<OpfsWritableLike>;
  getFile(): Promise<{
    size?: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text?: () => Promise<string>;
  }>;
}

export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?: () => AsyncIterable<[string, { kind: 'file' | 'directory'; name: string }]>;
}

export class StorageQuotaExceededError extends Error {
  public readonly code = 'STORAGE_QUOTA_EXCEEDED';

  constructor(message = 'ظرفیت ذخیره‌سازی محلی مرورگر (OPFS Quota) تکمیل شده است.', cause?: unknown) {
    super(message);
    this.name = 'StorageQuotaExceededError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { name?: unknown; code?: unknown; message?: unknown };
  if (rec.name === 'QuotaExceededError' || rec.code === 'STORAGE_QUOTA_EXCEEDED') {
    return true;
  }
  if (typeof rec.message === 'string' && /quota/i.test(rec.message)) {
    return true;
  }
  return false;
}

const ASSETS_ROOT_DIR = 'avapardaz-assets';
const ASSET_MANIFEST_FILE = 'manifest.json';

/**
 * Strictly byte-bounded LRU cache for Worker-local ArrayBuffer blocks.
 * Never claims durable persistence; used only when explicitly budgeted (<= 8 MiB).
 */
export class BoundedWorkerBufferCache {
  private readonly maxBytes: number;
  private usedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly map = new Map<string, ArrayBuffer>();

  constructor(maxBytes: number) {
    if (
      typeof maxBytes !== 'number' ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes
    ) {
      throw new RangeError(
        `Worker cache budget must be an integer in [1, ${AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes}] bytes, got ${String(maxBytes)}`,
      );
    }
    this.maxBytes = maxBytes;
  }

  get(key: string): ArrayBuffer | null {
    const existing = this.map.get(key);
    if (!existing) {
      this.misses++;
      return null;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, existing);
    return existing;
  }

  put(key: string, buffer: ArrayBuffer): boolean {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= 0) {
      return false;
    }
    if (buffer.byteLength > this.maxBytes) {
      return false;
    }
    const prev = this.map.get(key);
    if (prev) {
      this.usedBytes = Math.max(0, this.usedBytes - prev.byteLength);
      this.map.delete(key);
    }
    while (this.usedBytes + buffer.byteLength > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) {
        this.usedBytes = Math.max(0, this.usedBytes - oldest.byteLength);
        this.evictions++;
      }
    }
    this.map.set(key, buffer.slice(0));
    this.usedBytes += buffer.byteLength;
    return true;
  }

  delete(key: string): void {
    const prev = this.map.get(key);
    if (prev) {
      this.usedBytes = Math.max(0, this.usedBytes - prev.byteLength);
      this.map.delete(key);
    }
  }

  deleteByPrefix(prefix: string): number {
    let deleted = 0;
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) {
        this.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  clear(): void {
    this.map.clear();
    this.usedBytes = 0;
  }

  getStats(): RollingCacheStats {
    return {
      maxBytes: this.maxBytes,
      usedBytes: this.usedBytes,
      cachedBlocks: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

export type WorkerBrokerRequest =
  | { id: string; type: 'INIT'; workerCacheMaxBytes?: number }
  | {
      id: string;
      type: 'WRITE_BLOCK';
      fileKey: string;
      ownerWorker: FileHandleLease['ownerWorker'];
      data: ArrayBuffer;
    }
  | {
      id: string;
      type: 'READ_BLOCK';
      fileKey: string;
      ownerWorker: FileHandleLease['ownerWorker'];
    }
  | { id: string; type: 'DELETE_FILE'; fileKey: string }
  | {
      id: string;
      type: 'BEGIN_ASSET_INGEST';
      manifest: PersistedAudioAssetManifest;
    }
  | {
      id: string;
      type: 'WRITE_ASSET_CHUNK';
      assetId: string;
      chunkIndex: number;
      ownerWorker: FileHandleLease['ownerWorker'];
      data: ArrayBuffer;
    }
  | {
      id: string;
      type: 'READ_ASSET_CHUNK';
      assetId: string;
      chunkIndex: number;
      ownerWorker: FileHandleLease['ownerWorker'];
    }
  | {
      id: string;
      type: 'FINALIZE_ASSET';
      assetId: string;
      patch?: Partial<PersistedAudioAssetManifest>;
    }
  | {
      id: string;
      type: 'ABORT_ASSET_INGEST';
      assetId: string;
      reason: string;
      targetState?: 'abandoned' | 'failed';
    }
  | { id: string; type: 'GET_READY_ASSET'; assetId: string }
  | { id: string; type: 'LIST_READY_ASSETS' }
  | { id: string; type: 'DELETE_ASSET'; assetId: string }
  | { id: string; type: 'RECOVER_STARTUP_ASSETS'; maxIngestingAgeMs?: number }
  | { id: string; type: 'GET_STATE' };

export class WorkerStorageCore {
  private readonly activeLeases = new Map<string, FileHandleLease>();
  private readonly keyMutexTails = new Map<string, Promise<void>>();
  private lockConflictsPrevented = 0;
  private opfsAvailable = false;
  private syncHandleAvailable = false;
  private rootDir: OpfsDirectoryLike | null = null;
  private boundedWorkerCache: BoundedWorkerBufferCache | null = null;
  // In-session manifests only track lifecycle metadata (never full audio buffers) when OPFS is absent
  private readonly fallbackManifests = new Map<string, PersistedAudioAssetManifest>();

  constructor(
    private readonly getOpfsDirectoryFn?: () => Promise<OpfsDirectoryLike | null>,
  ) {}

  private async runWithKeyMutex<T>(
    mutexKey: string,
    fn: () => Promise<T>,
    onContention?: () => void,
  ): Promise<T> {
    const prevTail = this.keyMutexTails.get(mutexKey);
    if (prevTail) {
      onContention?.();
    }
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextTail = (prevTail ?? Promise.resolve()).then(() => currentGate);
    this.keyMutexTails.set(mutexKey, nextTail);

    if (prevTail) {
      await prevTail.catch(() => {});
    }
    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.keyMutexTails.get(mutexKey) === nextTail) {
        this.keyMutexTails.delete(mutexKey);
      }
    }
  }

  async init(workerCacheMaxBytes = 0): Promise<{
    opfsAvailable: boolean;
    syncHandleAvailable: boolean;
    lockConflictsPrevented: number;
    leases: FileHandleLease[];
    workerCacheStats: RollingCacheStats | null;
  }> {
    if (
      typeof workerCacheMaxBytes !== 'number' ||
      !Number.isSafeInteger(workerCacheMaxBytes) ||
      workerCacheMaxBytes < 0 ||
      workerCacheMaxBytes > AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes ||
      workerCacheMaxBytes > AVAPARDAZ_MEMORY_POLICY.audioCacheBytes
    ) {
      throw new RangeError(
        `workerCacheMaxBytes must be in [0, ${AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes}] bytes`,
      );
    }

    this.boundedWorkerCache =
      workerCacheMaxBytes > 0 ? new BoundedWorkerBufferCache(workerCacheMaxBytes) : null;

    this.opfsAvailable = false;
    this.syncHandleAvailable = false;
    this.rootDir = null;

    try {
      const dir = this.getOpfsDirectoryFn
        ? await this.getOpfsDirectoryFn()
        : typeof navigator !== 'undefined' &&
            navigator.storage &&
            'getDirectory' in navigator.storage
          ? ((await navigator.storage.getDirectory()) as unknown as OpfsDirectoryLike)
          : null;

      if (dir) {
        this.rootDir = dir;
        this.opfsAvailable = true;
        const probeHandle = await dir.getFileHandle('__avapardaz_probe.bin', { create: true });
        if (typeof probeHandle.createSyncAccessHandle === 'function') {
          const sync = await probeHandle.createSyncAccessHandle();
          sync.close();
          this.syncHandleAvailable = true;
        }
        await dir.removeEntry('__avapardaz_probe.bin').catch(() => {});
      }
    } catch {
      this.opfsAvailable = false;
      this.syncHandleAvailable = false;
      this.rootDir = null;
    }

    return {
      opfsAvailable: this.opfsAvailable,
      syncHandleAvailable: this.syncHandleAvailable,
      lockConflictsPrevented: this.lockConflictsPrevented,
      leases: Array.from(this.activeLeases.values()),
      workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
    };
  }

  private sanitizeName(fileKey: string): string {
    return fileKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private acquireLease(
    fileKey: string,
    ownerWorker: FileHandleLease['ownerWorker'],
  ): FileHandleLease {
    const existing = this.activeLeases.get(fileKey);
    if (existing && existing.status === 'active') {
      this.lockConflictsPrevented++;
    }
    const lease: FileHandleLease = {
      leaseId: `lease-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fileKey,
      ownerWorker,
      mode: this.syncHandleAvailable ? 'exclusive-broker' : 'read-buffered',
      acquiredAt: Date.now(),
      status: 'active',
    };
    this.activeLeases.set(fileKey, lease);
    return lease;
  }

  private releaseLease(fileKey: string, leaseId?: string): void {
    const lease = this.activeLeases.get(fileKey);
    if (lease && (!leaseId || lease.leaseId === leaseId)) {
      lease.status = 'released';
    }
  }

  private async getAssetsRootDir(create: boolean): Promise<OpfsDirectoryLike | null> {
    if (!this.opfsAvailable || !this.rootDir) return null;
    if (typeof this.rootDir.getDirectoryHandle === 'function') {
      try {
        return await this.rootDir.getDirectoryHandle(ASSETS_ROOT_DIR, { create });
      } catch {
        return null;
      }
    }
    return this.rootDir;
  }

  private async getAssetDir(assetId: string, create: boolean): Promise<OpfsDirectoryLike | null> {
    const assetsRoot = await this.getAssetsRootDir(create);
    if (!assetsRoot) return null;
    const safeAssetId = this.sanitizeName(assetId);
    if (typeof assetsRoot.getDirectoryHandle === 'function') {
      try {
        return await assetsRoot.getDirectoryHandle(safeAssetId, { create });
      } catch {
        return null;
      }
    }
    return assetsRoot;
  }

  private assetFileName(assetId: string, fileName: string, hasSubdirs: boolean): string {
    return hasSubdirs ? fileName : `${this.sanitizeName(assetId)}__${fileName}`;
  }

  private hasHierarchicalSubdirs(): boolean {
    return Boolean(this.rootDir && typeof this.rootDir.getDirectoryHandle === 'function');
  }

  private async writeBytesToFileHandle(
    fh: OpfsFileHandleLike,
    bytes: Uint8Array,
  ): Promise<WorkerPersistenceBackend> {
    if (this.syncHandleAvailable && typeof fh.createSyncAccessHandle === 'function') {
      const sync = await fh.createSyncAccessHandle();
      try {
        sync.truncate(0);
        sync.write(bytes, { at: 0 });
        sync.flush();
        return 'OPFS-SyncAccessHandle';
      } finally {
        sync.close();
      }
    }
    if (typeof fh.createWritable === 'function') {
      const writable = await fh.createWritable();
      try {
        const copy = bytes.slice().buffer;
        await writable.write(copy);
        await writable.close();
        return 'OPFS-Writable';
      } catch (err) {
        await writable.close().catch(() => {});
        throw err;
      }
    }
    return 'OPFS-Unavailable';
  }

  private async readBytesFromFileHandle(fh: OpfsFileHandleLike): Promise<ArrayBuffer> {
    if (this.syncHandleAvailable && typeof fh.createSyncAccessHandle === 'function') {
      const sync = await fh.createSyncAccessHandle();
      try {
        const size = sync.getSize();
        const out = new Uint8Array(size);
        sync.read(out, { at: 0 });
        return out.buffer;
      } finally {
        sync.close();
      }
    }
    const file = await fh.getFile();
    return file.arrayBuffer();
  }

  private async readManifestRaw(assetId: string): Promise<PersistedAudioAssetManifest | null> {
    const safeAssetId = this.sanitizeName(assetId);
    return this.runWithKeyMutex(`manifest:${safeAssetId}`, async () => {
      if (this.opfsAvailable && this.rootDir) {
        const dir = await this.getAssetDir(safeAssetId, false);
        if (!dir) return null;
        const manifestName = this.assetFileName(
          safeAssetId,
          ASSET_MANIFEST_FILE,
          this.hasHierarchicalSubdirs(),
        );
        try {
          const fh = await dir.getFileHandle(manifestName, { create: false });
          const buf = await this.readBytesFromFileHandle(fh);
          const text = new TextDecoder().decode(new Uint8Array(buf));
          return JSON.parse(text) as PersistedAudioAssetManifest;
        } catch {
          return null;
        }
      }
      return this.fallbackManifests.get(safeAssetId) ?? null;
    });
  }

  private async writeManifestRaw(manifest: PersistedAudioAssetManifest): Promise<void> {
    const safeAssetId = this.sanitizeName(manifest.assetId);
    await this.runWithKeyMutex(`manifest:${safeAssetId}`, async () => {
      if (this.opfsAvailable && this.rootDir) {
        const dir = await this.getAssetDir(safeAssetId, true);
        if (!dir) {
          throw new Error(`OPFS directory unavailable for asset ${safeAssetId}`);
        }
        const manifestName = this.assetFileName(
          safeAssetId,
          ASSET_MANIFEST_FILE,
          this.hasHierarchicalSubdirs(),
        );
        try {
          const fh = await dir.getFileHandle(manifestName, { create: true });
          const encoded = new TextEncoder().encode(JSON.stringify(manifest));
          await this.writeBytesToFileHandle(fh, encoded);
        } catch (err) {
          if (isQuotaExceededError(err)) {
            throw new StorageQuotaExceededError(undefined, err);
          }
          throw err;
        }
      }
      this.fallbackManifests.set(safeAssetId, manifest);
    });
  }

  async beginAssetIngest(manifest: PersistedAudioAssetManifest): Promise<{
    manifest: PersistedAudioAssetManifest;
    persisted: boolean;
    backend: WorkerPersistenceBackend;
  }> {
    const safeAssetId = this.sanitizeName(manifest.assetId);
    return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, async () => {
      const initialManifest: PersistedAudioAssetManifest = {
        ...manifest,
        assetId: safeAssetId,
        state: 'ingesting',
        updatedAtMs: Date.now(),
        finalizedAtMs: null,
      };

      try {
        await this.writeManifestRaw(initialManifest);
        const backend: WorkerPersistenceBackend = this.opfsAvailable
          ? this.syncHandleAvailable
            ? 'OPFS-SyncAccessHandle'
            : 'OPFS-Writable'
          : 'OPFS-Unavailable';
        return {
          manifest: initialManifest,
          persisted: this.opfsAvailable,
          backend,
        };
      } catch (err) {
        if (isQuotaExceededError(err)) {
          this.boundedWorkerCache?.clear();
          throw new StorageQuotaExceededError(undefined, err);
        }
        throw err;
      }
    });
  }

  async writeAssetChunk(
    assetId: string,
    chunkIndex: number,
    ownerWorker: FileHandleLease['ownerWorker'],
    buffer: ArrayBuffer,
  ): Promise<{
    bytesWritten: number;
    persisted: boolean;
    backend: WorkerPersistenceBackend;
    cachedInWorker: boolean;
    workerCacheStats: RollingCacheStats | null;
  }> {
    const safeAssetId = this.sanitizeName(assetId);
    const manifest = await this.readManifestRaw(safeAssetId);
    if (!manifest || (manifest.state !== 'ingesting' && manifest.state !== 'ready')) {
      throw new Error(
        `ASSET_INVALID_LIFECYCLE_WRITE: Asset ${safeAssetId} is not in ingesting/ready state (${manifest?.state ?? 'missing'}).`,
      );
    }

    const leaseKey = `${safeAssetId}:blk_${chunkIndex}`;
    return this.runWithKeyMutex(
      `chunk:${leaseKey}`,
      async () => {
        const lease = this.acquireLease(leaseKey, ownerWorker);
        try {
          const chunkFile = `blk_${chunkIndex}.f32`;
          if (this.opfsAvailable && this.rootDir) {
            const dir = await this.getAssetDir(safeAssetId, true);
            if (dir) {
              const targetName = this.assetFileName(
                safeAssetId,
                chunkFile,
                this.hasHierarchicalSubdirs(),
              );
              try {
                const fh = await dir.getFileHandle(targetName, { create: true });
                const backend = await this.writeBytesToFileHandle(fh, new Uint8Array(buffer));
                return {
                  bytesWritten: buffer.byteLength,
                  persisted: backend !== 'OPFS-Unavailable',
                  backend,
                  cachedInWorker: false,
                  workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
                };
              } catch (err) {
                if (isQuotaExceededError(err)) {
                  this.boundedWorkerCache?.clear();
                  throw new StorageQuotaExceededError(undefined, err);
                }
                throw err;
              }
            }
          }

          const cachedInWorker = this.boundedWorkerCache
            ? this.boundedWorkerCache.put(`${safeAssetId}__${chunkFile}`, buffer)
            : false;
          return {
            bytesWritten: 0,
            persisted: false,
            backend: 'OPFS-Unavailable',
            cachedInWorker,
            workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
          };
        } finally {
          this.releaseLease(leaseKey, lease.leaseId);
        }
      },
      () => {
        this.lockConflictsPrevented++;
      },
    );
  }

  async finalizeAsset(
    assetId: string,
    patch?: Partial<PersistedAudioAssetManifest>,
  ): Promise<PersistedAudioAssetManifest> {
    const safeAssetId = this.sanitizeName(assetId);
    return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, async () => {
      const existing = await this.readManifestRaw(safeAssetId);
      if (!existing) {
        throw new Error(`ASSET_NOT_FOUND: Cannot finalize missing asset ${safeAssetId}`);
      }
      if (existing.state === 'abandoned' || existing.state === 'failed') {
        throw new Error(
          `ASSET_LIFECYCLE_ERROR: Cannot finalize ${existing.state} asset ${safeAssetId}`,
        );
      }

      const finalizing: PersistedAudioAssetManifest = {
        ...existing,
        ...patch,
        assetId: safeAssetId,
        state: 'finalizing',
        updatedAtMs: Date.now(),
      };
      await this.writeManifestRaw(finalizing);

      // Verify all expected chunk files exist on OPFS before marking 'ready'
      if (this.opfsAvailable && this.rootDir && finalizing.totalBlocks > 0) {
        const dir = await this.getAssetDir(safeAssetId, false);
        if (!dir) {
          await this.abortAssetIngestUnlocked(safeAssetId, 'OPFS directory missing during finalization', 'failed');
          throw new Error(`ASSET_FINALIZE_VERIFICATION_FAILED: Directory missing for ${safeAssetId}`);
        }
        for (let idx = 0; idx < finalizing.totalBlocks; idx++) {
          const expectedSamples = Math.min(
            finalizing.blockSizeSamples,
            Math.max(0, finalizing.totalSamples - idx * finalizing.blockSizeSamples),
          );
          const expectedBytes = expectedSamples * finalizing.bytesPerSample * finalizing.channels;
          const targetName = this.assetFileName(
            safeAssetId,
            `blk_${idx}.f32`,
            this.hasHierarchicalSubdirs(),
          );
          try {
            await this.runWithKeyMutex(`chunk:${safeAssetId}:blk_${idx}`, async () => {
              const fh = await dir.getFileHandle(targetName, { create: false });
              const file = await fh.getFile();
              const actualBytes = typeof file.size === 'number' ? file.size : (await file.arrayBuffer()).byteLength;
              if (actualBytes !== expectedBytes) {
                throw new Error(
                  `Chunk #${idx} size mismatch: expected ${expectedBytes} bytes, got ${actualBytes}`,
                );
              }
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.abortAssetIngestUnlocked(safeAssetId, `Chunk verification failed: ${msg}`, 'failed');
            throw new Error(`ASSET_FINALIZE_VERIFICATION_FAILED: ${msg}`);
          }
        }
      }

      const now = Date.now();
      const ready: PersistedAudioAssetManifest = {
        ...finalizing,
        state: 'ready',
        updatedAtMs: now,
        finalizedAtMs: now,
      };
      await this.writeManifestRaw(ready);
      return ready;
    });
  }

  private async abortAssetIngestUnlocked(
    safeAssetId: string,
    reason: string,
    targetState: 'abandoned' | 'failed' = 'abandoned',
  ): Promise<{ cleaned: boolean; state: AssetStorageLifecycleState }> {
    const existing = await this.readManifestRaw(safeAssetId);
    if (existing) {
      const failedManifest: PersistedAudioAssetManifest = {
        ...existing,
        state: targetState,
        updatedAtMs: Date.now(),
        finalizedAtMs: null,
        errorMessage: reason,
      };
      this.fallbackManifests.set(safeAssetId, failedManifest);
      await this.writeManifestRaw(failedManifest).catch(() => {});
    }

    await this.deleteAssetUnlocked(safeAssetId);
    return { cleaned: true, state: targetState };
  }

  async abortAssetIngest(
    assetId: string,
    reason: string,
    targetState: 'abandoned' | 'failed' = 'abandoned',
  ): Promise<{ cleaned: boolean; state: AssetStorageLifecycleState }> {
    const safeAssetId = this.sanitizeName(assetId);
    return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, () =>
      this.abortAssetIngestUnlocked(safeAssetId, reason, targetState),
    );
  }

  async getReadyAssetManifest(assetId: string): Promise<PersistedAudioAssetManifest | null> {
    const manifest = await this.readManifestRaw(assetId);
    if (!manifest || manifest.state !== 'ready') {
      return null;
    }
    return manifest;
  }

  async listReadyAssets(): Promise<PersistedAudioAssetManifest[]> {
    const ready: PersistedAudioAssetManifest[] = [];
    if (this.opfsAvailable && this.rootDir) {
      const assetsRoot = await this.getAssetsRootDir(false);
      if (assetsRoot && typeof assetsRoot.entries === 'function') {
        for await (const [name, handle] of assetsRoot.entries()) {
          if (handle.kind === 'directory') {
            const m = await this.getReadyAssetManifest(name);
            if (m) ready.push(m);
          }
        }
        return ready;
      }
    }
    for (const m of this.fallbackManifests.values()) {
      if (m.state === 'ready') ready.push(m);
    }
    return ready;
  }

  async readAssetChunk(
    assetId: string,
    chunkIndex: number,
    ownerWorker: FileHandleLease['ownerWorker'],
  ): Promise<{ buffer: ArrayBuffer | null; persisted: boolean }> {
    const safeAssetId = this.sanitizeName(assetId);
    const manifest = await this.readManifestRaw(safeAssetId);
    // Partial/ingesting/abandoned/failed uploads MUST NEVER be served as completed audio
    if (!manifest || manifest.state !== 'ready') {
      return { buffer: null, persisted: false };
    }

    const leaseKey = `${safeAssetId}:blk_${chunkIndex}`;
    return this.runWithKeyMutex(
      `chunk:${leaseKey}`,
      async () => {
        const lease = this.acquireLease(leaseKey, ownerWorker);
        try {
          const chunkFile = `blk_${chunkIndex}.f32`;
          if (this.opfsAvailable && this.rootDir) {
            const dir = await this.getAssetDir(safeAssetId, false);
            if (!dir) return { buffer: null, persisted: false };
            const targetName = this.assetFileName(
              safeAssetId,
              chunkFile,
              this.hasHierarchicalSubdirs(),
            );
            const fh = await dir.getFileHandle(targetName, { create: false });
            const buf = await this.readBytesFromFileHandle(fh);
            return { buffer: buf, persisted: true };
          }

          if (this.boundedWorkerCache) {
            const cached = this.boundedWorkerCache.get(`${safeAssetId}__${chunkFile}`);
            if (cached) return { buffer: cached.slice(0), persisted: false };
          }
          return { buffer: null, persisted: false };
        } catch {
          return { buffer: null, persisted: false };
        } finally {
          this.releaseLease(leaseKey, lease.leaseId);
        }
      },
      () => {
        this.lockConflictsPrevented++;
      },
    );
  }

  private async deleteAssetUnlocked(safeAssetId: string): Promise<{ deleted: boolean }> {
    this.fallbackManifests.delete(safeAssetId);
    this.boundedWorkerCache?.deleteByPrefix(`${safeAssetId}__`);
    this.boundedWorkerCache?.deleteByPrefix(`${safeAssetId}_blk_`);

    if (this.opfsAvailable && this.rootDir) {
      const assetsRoot = await this.getAssetsRootDir(false);
      if (assetsRoot) {
        if (this.hasHierarchicalSubdirs()) {
          await assetsRoot.removeEntry(safeAssetId, { recursive: true }).catch(() => {});
        } else if (typeof assetsRoot.entries === 'function') {
          for await (const [name] of assetsRoot.entries()) {
            if (name.startsWith(`${safeAssetId}__`)) {
              await assetsRoot.removeEntry(name).catch(() => {});
            }
          }
        }
      }
    }

    for (const k of Array.from(this.activeLeases.keys())) {
      if (k.startsWith(`${safeAssetId}:`) || k.startsWith(`${safeAssetId}_`)) {
        this.activeLeases.delete(k);
      }
    }
    return { deleted: true };
  }

  async deleteAsset(assetId: string): Promise<{ deleted: boolean }> {
    const safeAssetId = this.sanitizeName(assetId);
    return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, () =>
      this.deleteAssetUnlocked(safeAssetId),
    );
  }

  async recoverStartupAssets(maxIngestingAgeMs = 0): Promise<{
    cleanedAssetIds: string[];
    readyAssetIds: string[];
  }> {
    const cleanedAssetIds: string[] = [];
    const readyAssetIds: string[] = [];
    const now = Date.now();

    if (this.opfsAvailable && this.rootDir) {
      const assetsRoot = await this.getAssetsRootDir(false);
      if (assetsRoot && typeof assetsRoot.entries === 'function') {
        const candidateIds: string[] = [];
        for await (const [name, handle] of assetsRoot.entries()) {
          if (handle.kind === 'directory') {
            candidateIds.push(name);
          } else if (name.endsWith(`__${ASSET_MANIFEST_FILE}`)) {
            candidateIds.push(name.slice(0, -(`__${ASSET_MANIFEST_FILE}`).length));
          }
        }

        for (const assetId of candidateIds) {
          const manifest = await this.readManifestRaw(assetId);
          if (!manifest) {
            await this.deleteAsset(assetId);
            cleanedAssetIds.push(assetId);
            continue;
          }
          if (manifest.state === 'ready') {
            readyAssetIds.push(assetId);
            continue;
          }
          const safeMaxAge =
            typeof maxIngestingAgeMs === 'number' &&
            Number.isFinite(maxIngestingAgeMs) &&
            maxIngestingAgeMs >= 0
              ? maxIngestingAgeMs
              : 0;
          const ageMs = now - (manifest.updatedAtMs || manifest.createdAtMs || 0);
          if (
            manifest.state === 'abandoned' ||
            manifest.state === 'failed' ||
            manifest.state === 'finalizing' ||
            (manifest.state === 'ingesting' && ageMs >= safeMaxAge)
          ) {
            await this.deleteAsset(assetId);
            cleanedAssetIds.push(assetId);
          }
        }
        return { cleanedAssetIds, readyAssetIds };
      }
    }

    for (const [assetId, manifest] of Array.from(this.fallbackManifests.entries())) {
      if (manifest.state === 'ready') {
        readyAssetIds.push(assetId);
      } else {
        await this.deleteAsset(assetId);
        cleanedAssetIds.push(assetId);
      }
    }
    return { cleanedAssetIds, readyAssetIds };
  }

  async writeBlock(
    fileKey: string,
    ownerWorker: FileHandleLease['ownerWorker'],
    buffer: ArrayBuffer,
  ): Promise<{
    bytesWritten: number;
    persisted: boolean;
    backend: WorkerPersistenceBackend;
    cachedInWorker: boolean;
    workerCacheStats: RollingCacheStats | null;
  }> {
    const safeName = this.sanitizeName(fileKey);
    return this.runWithKeyMutex(
      `file:${safeName}`,
      async () => {
        const lease = this.acquireLease(fileKey, ownerWorker);
        try {
          if (this.opfsAvailable && this.rootDir) {
            try {
              const fh = await this.rootDir.getFileHandle(safeName, { create: true });
              const backend = await this.writeBytesToFileHandle(fh, new Uint8Array(buffer));
              if (backend !== 'OPFS-Unavailable') {
                return {
                  bytesWritten: buffer.byteLength,
                  persisted: true,
                  backend,
                  cachedInWorker: false,
                  workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
                };
              }
            } catch (err) {
              if (isQuotaExceededError(err)) {
                this.boundedWorkerCache?.clear();
                throw new StorageQuotaExceededError(undefined, err);
              }
              throw err;
            }
          }

          // OPFS is unavailable: NEVER pretend durable persistence or keep unbounded memory.
          // Only store in an explicitly bounded (<= 8 MiB) LRU cache if configured.
          const cachedInWorker = this.boundedWorkerCache
            ? this.boundedWorkerCache.put(safeName, buffer)
            : false;
          return {
            bytesWritten: 0,
            persisted: false,
            backend: 'OPFS-Unavailable',
            cachedInWorker,
            workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
          };
        } finally {
          this.releaseLease(fileKey, lease.leaseId);
        }
      },
      () => {
        this.lockConflictsPrevented++;
      },
    );
  }

  async readBlock(
    fileKey: string,
    ownerWorker: FileHandleLease['ownerWorker'],
  ): Promise<{ buffer: ArrayBuffer | null; persisted: boolean }> {
    const safeName = this.sanitizeName(fileKey);
    return this.runWithKeyMutex(
      `file:${safeName}`,
      async () => {
        const lease = this.acquireLease(fileKey, ownerWorker);
        try {
          if (this.opfsAvailable && this.rootDir) {
            const fh = await this.rootDir.getFileHandle(safeName);
            const buf = await this.readBytesFromFileHandle(fh);
            return { buffer: buf, persisted: true };
          }

          if (this.boundedWorkerCache) {
            const cached = this.boundedWorkerCache.get(safeName);
            if (cached) {
              return { buffer: cached.slice(0), persisted: false };
            }
          }
          return { buffer: null, persisted: false };
        } catch {
          return { buffer: null, persisted: false };
        } finally {
          this.releaseLease(fileKey, lease.leaseId);
        }
      },
      () => {
        this.lockConflictsPrevented++;
      },
    );
  }

  async deleteFile(fileKey: string): Promise<{ deleted: boolean }> {
    const safeName = this.sanitizeName(fileKey);
    return this.runWithKeyMutex(`file:${safeName}`, async () => {
      if (this.opfsAvailable && this.rootDir) {
        await this.rootDir.removeEntry(safeName).catch(() => {});
      }
      this.boundedWorkerCache?.delete(safeName);
      this.activeLeases.delete(fileKey);
      return { deleted: true };
    });
  }

  getState() {
    return {
      opfsAvailable: this.opfsAvailable,
      syncHandleAvailable: this.syncHandleAvailable,
      lockConflictsPrevented: this.lockConflictsPrevented,
      leases: Array.from(this.activeLeases.values()).slice(-12),
      workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
    };
  }

  async handleMessage(msg: WorkerBrokerRequest): Promise<{
    payload: Record<string, unknown>;
    transfer: Transferable[];
  }> {
    if (msg.type === 'INIT') {
      const probe = await this.init(msg.workerCacheMaxBytes ?? 0);
      return { payload: probe, transfer: [] };
    }
    if (msg.type === 'WRITE_BLOCK') {
      const res = await this.writeBlock(msg.fileKey, msg.ownerWorker, msg.data);
      return {
        payload: {
          ...res,
          lockConflictsPrevented: this.lockConflictsPrevented,
          leases: Array.from(this.activeLeases.values()).slice(-12),
        },
        transfer: [],
      };
    }
    if (msg.type === 'READ_BLOCK') {
      const res = await this.readBlock(msg.fileKey, msg.ownerWorker);
      return {
        payload: {
          buffer: res.buffer,
          persisted: res.persisted,
          lockConflictsPrevented: this.lockConflictsPrevented,
          leases: Array.from(this.activeLeases.values()).slice(-12),
          workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
        },
        transfer: res.buffer ? [res.buffer] : [],
      };
    }
    if (msg.type === 'DELETE_FILE') {
      const res = await this.deleteFile(msg.fileKey);
      return { payload: res, transfer: [] };
    }
    if (msg.type === 'BEGIN_ASSET_INGEST') {
      const res = await this.beginAssetIngest(msg.manifest);
      return { payload: res, transfer: [] };
    }
    if (msg.type === 'WRITE_ASSET_CHUNK') {
      const res = await this.writeAssetChunk(
        msg.assetId,
        msg.chunkIndex,
        msg.ownerWorker,
        msg.data,
      );
      return {
        payload: {
          ...res,
          lockConflictsPrevented: this.lockConflictsPrevented,
          leases: Array.from(this.activeLeases.values()).slice(-12),
        },
        transfer: [],
      };
    }
    if (msg.type === 'READ_ASSET_CHUNK') {
      const res = await this.readAssetChunk(msg.assetId, msg.chunkIndex, msg.ownerWorker);
      return {
        payload: {
          buffer: res.buffer,
          persisted: res.persisted,
          lockConflictsPrevented: this.lockConflictsPrevented,
          leases: Array.from(this.activeLeases.values()).slice(-12),
          workerCacheStats: this.boundedWorkerCache?.getStats() ?? null,
        },
        transfer: res.buffer ? [res.buffer] : [],
      };
    }
    if (msg.type === 'FINALIZE_ASSET') {
      const manifest = await this.finalizeAsset(msg.assetId, msg.patch);
      return { payload: { manifest }, transfer: [] };
    }
    if (msg.type === 'ABORT_ASSET_INGEST') {
      const res = await this.abortAssetIngest(msg.assetId, msg.reason, msg.targetState);
      return { payload: res, transfer: [] };
    }
    if (msg.type === 'GET_READY_ASSET') {
      const manifest = await this.getReadyAssetManifest(msg.assetId);
      return { payload: { manifest }, transfer: [] };
    }
    if (msg.type === 'LIST_READY_ASSETS') {
      const assets = await this.listReadyAssets();
      return { payload: { assets }, transfer: [] };
    }
    if (msg.type === 'DELETE_ASSET') {
      const res = await this.deleteAsset(msg.assetId);
      return { payload: res, transfer: [] };
    }
    if (msg.type === 'RECOVER_STARTUP_ASSETS') {
      const res = await this.recoverStartupAssets(msg.maxIngestingAgeMs);
      return { payload: res, transfer: [] };
    }
    return { payload: this.getState(), transfer: [] };
  }
}

