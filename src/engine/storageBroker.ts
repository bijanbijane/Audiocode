import {
  ExportValidationReport,
  FileHandleLease,
  PersistedAudioAssetManifest,
  RollingCacheStats,
  RuntimeCapabilities,
  SeekTableEntry,
  StorageBrokerTelemetry,
} from '../contracts/v1_2';
import {
  AVAPARDAZ_AUDIO_CACHE_SPLIT,
  AVAPARDAZ_MEMORY_POLICY,
} from '../runtime/memory/MemoryPolicy';
import { RollingLruBlockCache } from './lruCache';
import {
  isQuotaExceededError,
  StorageQuotaExceededError,
  WorkerPersistenceBackend,
} from './workerStorageCore';

/**
 * Storage I/O Broker Client, Capability Probe, Seek Indexer, and Streaming WAV Exporter (v1.2)
 */

export function detectRuntimeCapabilities(): RuntimeCapabilities {
  const crossOriginIsolated =
    typeof self !== 'undefined' &&
    Boolean((self as { crossOriginIsolated?: boolean }).crossOriginIsolated);
  const sharedArrayBufferSupported = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
  const audioWorkletSupported =
    typeof AudioWorkletNode !== 'undefined' || typeof AudioContext !== 'undefined';
  const webGpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const opfsSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage) &&
    'getDirectory' in navigator.storage;
  const hardwareConcurrency =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;

  let deviceTier: RuntimeCapabilities['deviceTier'] = 'Desktop Studio';
  if (typeof window !== 'undefined') {
    const w = window.innerWidth;
    if (w < 640) deviceTier = 'Mobile Companion';
    else if (w < 1024) deviceTier = 'Tablet Studio';
  }

  return {
    crossOriginIsolated,
    sharedArrayBufferSupported,
    transportMode: sharedArrayBufferSupported ? 'SharedArrayBuffer' : 'MessagePort-Fallback',
    audioWorkletSupported,
    webGpuSupported,
    gpuFallbackMode: webGpuSupported ? 'WebGPU-Sliced' : 'WASM-SIMD-CPU',
    opfsSupported,
    hardwareConcurrency,
    deviceTier,
  };
}

export async function requestPersistentStorage(): Promise<{
  persisted: boolean | null;
  quotaUsedBytes: number | null;
  quotaTotalBytes: number | null;
}> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage) {
      return { persisted: null, quotaUsedBytes: null, quotaTotalBytes: null };
    }
    let persisted: boolean | null = null;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
      if (!persisted && typeof navigator.storage.persist === 'function') {
        persisted = await navigator.storage.persist();
      }
    }
    let quotaUsedBytes: number | null = null;
    let quotaTotalBytes: number | null = null;
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      quotaUsedBytes = est.usage ?? null;
      quotaTotalBytes = est.quota ?? null;
    }
    return { persisted, quotaUsedBytes, quotaTotalBytes };
  } catch {
    return { persisted: null, quotaUsedBytes: null, quotaTotalBytes: null };
  }
}

export function buildSeekTable(
  totalSamples: number,
  blockSizeSamples: number,
  bytesPerSamplePerChannel: number,
  channels: number,
): SeekTableEntry[] {
  const entries: SeekTableEntry[] = [];
  let blockIndex = 0;
  let cursor = 0;
  while (cursor < totalSamples) {
    const count = Math.min(blockSizeSamples, totalSamples - cursor);
    const byteLength = count * bytesPerSamplePerChannel * channels;
    entries.push({
      blockIndex,
      startSample: cursor,
      sampleCount: count,
      byteOffset: cursor * bytesPerSamplePerChannel * channels,
      byteLength,
    });
    cursor += count;
    blockIndex++;
  }
  return entries;
}

export function computeDeterministicAssetId(params: {
  contentSha256?: string;
  fileName: string;
  fileSizeBytes: number;
  sampleRate?: number;
  exactSampleCount?: number;
}): string {
  const cleanHash = (params.contentSha256 ?? '')
    .replace(/^sha256:/i, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();

  if (cleanHash.length >= 12) {
    return `asset-${cleanHash.slice(0, 16)}-${params.fileSizeBytes}`;
  }

  // Deterministic 64-bit FNV-1a mix of metadata when raw digest is omitted
  const seed = `${params.fileName}|${params.fileSizeBytes}|${params.sampleRate ?? 0}|${params.exactSampleCount ?? 0}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  return `asset-${hex}-${params.fileSizeBytes}`;
}

export interface BrokerWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent | { message?: string }) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface StorageBrokerClientOptions {
  readonly mainThreadCacheBytes?: number;
  readonly workerCacheBytes?: number;
  readonly workerFactory?: () => BrokerWorkerLike;
}

export interface WritePcmBlockResult {
  readonly persisted: boolean;
  readonly backend: WorkerPersistenceBackend;
  readonly cachedInMainLru: boolean;
  readonly bytesWritten: number;
}

export class StorageBrokerClient {
  private worker: BrokerWorkerLike | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private disposed = false;
  private readonly workerCacheBytes: number;
  private readonly workerFactory?: () => BrokerWorkerLike;
  public readonly lruCache: RollingLruBlockCache;
  private telemetry: StorageBrokerTelemetry;

  constructor(
    cacheMaxBytesOrOptions: number | StorageBrokerClientOptions = AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
  ) {
    const opts: StorageBrokerClientOptions =
      typeof cacheMaxBytesOrOptions === 'number'
        ? { mainThreadCacheBytes: cacheMaxBytesOrOptions }
        : cacheMaxBytesOrOptions;

    const mainThreadCacheBytes =
      opts.mainThreadCacheBytes ?? AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes;
    const workerCacheBytes = opts.workerCacheBytes ?? 0;

    if (
      typeof mainThreadCacheBytes !== 'number' ||
      !Number.isSafeInteger(mainThreadCacheBytes) ||
      mainThreadCacheBytes <= 0
    ) {
      throw new RangeError(
        `mainThreadCacheBytes must be a positive safe integer, got ${String(mainThreadCacheBytes)}`,
      );
    }

    if (
      typeof workerCacheBytes !== 'number' ||
      !Number.isSafeInteger(workerCacheBytes) ||
      workerCacheBytes < 0 ||
      workerCacheBytes > AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes
    ) {
      throw new RangeError(
        `workerCacheBytes must be an integer in [0, ${AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes}], got ${String(workerCacheBytes)}`,
      );
    }

    if (mainThreadCacheBytes + workerCacheBytes > AVAPARDAZ_MEMORY_POLICY.audioCacheBytes) {
      throw new RangeError(
        `Combined main-thread (${mainThreadCacheBytes}) + worker (${workerCacheBytes}) audio cache budget exceeds policy limit (${AVAPARDAZ_MEMORY_POLICY.audioCacheBytes}).`,
      );
    }

    this.workerCacheBytes = workerCacheBytes;
    this.workerFactory = opts.workerFactory;
    this.lruCache = new RollingLruBlockCache(mainThreadCacheBytes);
    this.telemetry = {
      opfsSupported: false,
      syncAccessHandleSupported: false,
      persistentStorageGranted: null,
      quotaUsedBytes: null,
      quotaTotalBytes: null,
      activeLeases: [],
      lockConflictsPrevented: 0,
      cacheStats: this.lruCache.getStats(),
      persistenceAvailable: false,
      persistenceStatus: 'OPFS-Unavailable',
      workerCacheStats: null,
      totalAudioCacheBudgetBytes: AVAPARDAZ_MEMORY_POLICY.audioCacheBytes,
      disposed: false,
      recoveredAssetCount: 0,
      cleanedAbandonedCount: 0,
    };
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('StorageBrokerClient has been disposed');
    }
  }

  private rejectAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async init(): Promise<StorageBrokerTelemetry> {
    this.assertNotDisposed();

    const storageInfo = await requestPersistentStorage();
    if (this.disposed) {
      throw new Error('StorageBrokerClient has been disposed');
    }

    this.telemetry.persistentStorageGranted = storageInfo.persisted;
    this.telemetry.quotaUsedBytes = storageInfo.quotaUsedBytes;
    this.telemetry.quotaTotalBytes = storageInfo.quotaTotalBytes;

    const canSpawnWorker =
      Boolean(this.workerFactory) || typeof Worker !== 'undefined';

    if (canSpawnWorker && !this.worker) {
      try {
        this.worker = this.workerFactory
          ? this.workerFactory()
          : (new Worker(new URL('../workers/ioBroker.worker.ts', import.meta.url), {
              type: 'module',
            }) as unknown as BrokerWorkerLike);

        this.worker.onmessage = (event: MessageEvent) => {
          let data: unknown;
          try {
            data = event?.data;
          } catch (err) {
            this.rejectAllPending(
              `StorageBroker worker message deserialization failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return;
          }

          if (!data || typeof data !== 'object') {
            this.rejectAllPending('StorageBroker worker sent malformed non-object message');
            return;
          }

          const record = data as {
            id?: unknown;
            ok?: unknown;
            payload?: unknown;
            error?: unknown;
          };

          if (typeof record.id !== 'string') {
            return;
          }

          const entry = this.pending.get(record.id);
          if (!entry) return;
          this.pending.delete(record.id);

          if (record.ok === true) {
            entry.resolve(record.payload);
          } else {
            entry.reject(
              new Error(
                typeof record.error === 'string' && record.error.length > 0
                  ? record.error
                  : 'OPFS Broker error',
              ),
            );
          }
        };

        this.worker.onerror = (event) => {
          const detail =
            event && 'message' in event && typeof event.message === 'string' && event.message
              ? event.message
              : 'Unknown worker error';
          this.telemetry.opfsSupported = false;
          this.telemetry.syncAccessHandleSupported = false;
          this.telemetry.persistenceAvailable = false;
          this.telemetry.persistenceStatus = 'OPFS-Unavailable';
          this.rejectAllPending(`StorageBroker worker error: ${detail}`);
          try {
            this.worker?.terminate();
          } catch {
            // ignore terminate failure on already-failed worker
          }
          this.worker = null;
        };

        this.worker.onmessageerror = () => {
          this.rejectAllPending('StorageBroker worker message deserialization error');
        };

        const res = (await this.callWorker({
          type: 'INIT',
          workerCacheMaxBytes: this.workerCacheBytes,
        })) as {
          opfsAvailable: boolean;
          syncHandleAvailable: boolean;
          lockConflictsPrevented: number;
          leases: FileHandleLease[];
          workerCacheStats?: RollingCacheStats | null;
        };

        if (this.disposed) {
          throw new Error('StorageBrokerClient has been disposed');
        }

        this.telemetry.opfsSupported = Boolean(res?.opfsAvailable);
        this.telemetry.syncAccessHandleSupported = Boolean(res?.syncHandleAvailable);
        this.telemetry.lockConflictsPrevented = res?.lockConflictsPrevented ?? 0;
        this.telemetry.activeLeases = res?.leases ?? [];
        this.telemetry.workerCacheStats = res?.workerCacheStats ?? null;
        this.telemetry.persistenceAvailable = Boolean(res?.opfsAvailable);
        this.telemetry.persistenceStatus = res?.opfsAvailable
          ? res.syncHandleAvailable
            ? 'OPFS-SyncAccessHandle'
            : 'OPFS-Writable'
          : 'OPFS-Unavailable';

        if (this.telemetry.opfsSupported && !this.disposed) {
          try {
            const recovery = await this.recoverStartupAssets();
            this.telemetry.cleanedAbandonedCount = recovery.cleanedAssetIds.length;
            this.telemetry.recoveredAssetCount = recovery.readyAssetIds.length;
          } catch {
            // Non-fatal startup recovery failure; keep telemetry initialized
          }
        }
      } catch (err) {
        if (this.disposed) {
          throw err;
        }
        this.telemetry.opfsSupported = false;
        this.telemetry.syncAccessHandleSupported = false;
        this.telemetry.persistenceAvailable = false;
        this.telemetry.persistenceStatus = 'OPFS-Unavailable';
        try {
          this.worker?.terminate();
        } catch {
          // ignore
        }
        this.worker = null;
      }
    }

    this.telemetry.cacheStats = this.lruCache.getStats();
    return this.getTelemetry();
  }

  private callWorker(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('StorageBrokerClient has been disposed'));
    }
    if (!this.worker) {
      return Promise.reject(new Error('StorageBroker worker is unavailable'));
    }

    const id = `req-${++this.seq}`;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...msg, id }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async writePcmBlock(
    assetId: string,
    blockIndex: number,
    channels: Float32Array[],
    ownerWorker: FileHandleLease['ownerWorker'] = 'io-broker',
  ): Promise<WritePcmBlockResult> {
    this.assertNotDisposed();

    const cachedBlock = this.lruCache.put(assetId, blockIndex, channels);
    const mono = channels[0];
    const shouldUseWorker =
      Boolean(this.worker) &&
      mono instanceof Float32Array &&
      mono.byteLength > 0 &&
      (this.telemetry.opfsSupported || this.workerCacheBytes > 0);

    // Avoid allocating a full-buffer copy or invoking worker persistence when OPFS is unavailable
    // and no bounded worker cache is configured.
    if (!shouldUseWorker) {
      this.telemetry.cacheStats = this.lruCache.getStats();
      return {
        persisted: false,
        backend: 'OPFS-Unavailable',
        cachedInMainLru: cachedBlock !== null,
        bytesWritten: 0,
      };
    }

    const copy = new Float32Array(mono);
    const fileKey = `${assetId}_blk_${blockIndex}.f32`;
    const res = (await this.callWorker(
      {
        type: 'WRITE_BLOCK',
        fileKey,
        ownerWorker,
        data: copy.buffer,
      },
      [copy.buffer],
    )) as {
      bytesWritten: number;
      persisted: boolean;
      backend: WorkerPersistenceBackend;
      lockConflictsPrevented: number;
      leases: FileHandleLease[];
      workerCacheStats?: RollingCacheStats | null;
    };

    if (res) {
      this.telemetry.lockConflictsPrevented =
        res.lockConflictsPrevented ?? this.telemetry.lockConflictsPrevented;
      this.telemetry.activeLeases = res.leases ?? this.telemetry.activeLeases;
      if (res.workerCacheStats !== undefined) {
        this.telemetry.workerCacheStats = res.workerCacheStats;
      }
    }
    this.telemetry.cacheStats = this.lruCache.getStats();

    return {
      persisted: Boolean(res?.persisted),
      backend: res?.backend ?? 'OPFS-Unavailable',
      cachedInMainLru: cachedBlock !== null,
      bytesWritten: res?.bytesWritten ?? 0,
    };
  }

  async readPcmBlock(
    assetId: string,
    blockIndex: number,
    fallbackSource: Float32Array,
    startSample: number,
    sampleCount: number,
    ownerWorker: FileHandleLease['ownerWorker'] = 'playback-feeder',
  ): Promise<Float32Array> {
    this.assertNotDisposed();

    const cached = this.lruCache.get(assetId, blockIndex);
    if (cached) {
      this.telemetry.cacheStats = this.lruCache.getStats();
      return cached.channels[0];
    }

    const fileKey = `${assetId}_blk_${blockIndex}.f32`;
    if (this.worker && (this.telemetry.opfsSupported || this.workerCacheBytes > 0)) {
      const res = (await this.callWorker({
        type: 'READ_BLOCK',
        fileKey,
        ownerWorker,
      })) as {
        buffer: ArrayBuffer | null;
        lockConflictsPrevented: number;
        leases: FileHandleLease[];
        workerCacheStats?: RollingCacheStats | null;
      };
      if (res?.leases) {
        this.telemetry.activeLeases = res.leases;
        this.telemetry.lockConflictsPrevented = res.lockConflictsPrevented ?? 0;
      }
      if (res?.workerCacheStats !== undefined) {
        this.telemetry.workerCacheStats = res.workerCacheStats;
      }
      if (res?.buffer) {
        const loaded = new Float32Array(res.buffer);
        this.lruCache.put(assetId, blockIndex, [loaded]);
        this.telemetry.cacheStats = this.lruCache.getStats();
        return loaded;
      }
    }

    if (!(fallbackSource instanceof Float32Array) || fallbackSource.length === 0 || sampleCount <= 0) {
      this.telemetry.cacheStats = this.lruCache.getStats();
      return new Float32Array(0);
    }

    const safeStart = Math.max(0, Math.min(fallbackSource.length, Math.trunc(startSample)));
    const safeEnd = Math.max(safeStart, Math.min(fallbackSource.length, safeStart + Math.trunc(sampleCount)));
    const sliced = fallbackSource.slice(safeStart, safeEnd);
    this.lruCache.put(assetId, blockIndex, [sliced]);
    this.telemetry.cacheStats = this.lruCache.getStats();
    return sliced;
  }

  async beginAssetIngest(manifest: PersistedAudioAssetManifest): Promise<{
    manifest: PersistedAudioAssetManifest;
    persisted: boolean;
    backend: WorkerPersistenceBackend;
  }> {
    this.assertNotDisposed();
    if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
      return {
        manifest: {
          ...manifest,
          state: 'ingesting',
          updatedAtMs: Date.now(),
          finalizedAtMs: null,
        },
        persisted: false,
        backend: 'OPFS-Unavailable',
      };
    }

    try {
      return (await this.callWorker({
        type: 'BEGIN_ASSET_INGEST',
        manifest,
      })) as {
        manifest: PersistedAudioAssetManifest;
        persisted: boolean;
        backend: WorkerPersistenceBackend;
      };
    } catch (err) {
      if (isQuotaExceededError(err)) {
        this.lruCache.evictToBudget(0);
        await this.recoverStartupAssets(0).catch(() => {});
        try {
          return (await this.callWorker({
            type: 'BEGIN_ASSET_INGEST',
            manifest,
          })) as {
            manifest: PersistedAudioAssetManifest;
            persisted: boolean;
            backend: WorkerPersistenceBackend;
          };
        } catch (retryErr) {
          throw new StorageQuotaExceededError(undefined, retryErr);
        }
      }
      throw err;
    }
  }

  async writeAssetChunk(
    assetId: string,
    chunkIndex: number,
    data: Float32Array | ArrayBuffer,
    ownerWorker: FileHandleLease['ownerWorker'] = 'io-broker',
  ): Promise<WritePcmBlockResult> {
    this.assertNotDisposed();
    const floatView =
      data instanceof Float32Array ? data : new Float32Array(data);
    const cachedBlock = this.lruCache.put(assetId, chunkIndex, [floatView]);

    const shouldUseWorker =
      Boolean(this.worker) &&
      floatView.byteLength > 0 &&
      (this.telemetry.opfsSupported || this.workerCacheBytes > 0);

    if (!shouldUseWorker) {
      this.telemetry.cacheStats = this.lruCache.getStats();
      return {
        persisted: false,
        backend: 'OPFS-Unavailable',
        cachedInMainLru: cachedBlock !== null,
        bytesWritten: 0,
      };
    }

    const sendWrite = async () => {
      const copy = new Float32Array(floatView);
      return (await this.callWorker(
        {
          type: 'WRITE_ASSET_CHUNK',
          assetId,
          chunkIndex,
          ownerWorker,
          data: copy.buffer,
        },
        [copy.buffer],
      )) as {
        bytesWritten: number;
        persisted: boolean;
        backend: WorkerPersistenceBackend;
        lockConflictsPrevented: number;
        leases: FileHandleLease[];
        workerCacheStats?: RollingCacheStats | null;
      };
    };

    let res;
    try {
      res = await sendWrite();
    } catch (err) {
      if (isQuotaExceededError(err)) {
        this.lruCache.evictToBudget(0);
        await this.recoverStartupAssets(0).catch(() => {});
        try {
          res = await sendWrite();
        } catch (retryErr) {
          throw new StorageQuotaExceededError(undefined, retryErr);
        }
      } else {
        throw err;
      }
    }

    if (res) {
      this.telemetry.lockConflictsPrevented =
        res.lockConflictsPrevented ?? this.telemetry.lockConflictsPrevented;
      this.telemetry.activeLeases = res.leases ?? this.telemetry.activeLeases;
      if (res.workerCacheStats !== undefined) {
        this.telemetry.workerCacheStats = res.workerCacheStats;
      }
    }
    this.telemetry.cacheStats = this.lruCache.getStats();

    return {
      persisted: Boolean(res?.persisted),
      backend: res?.backend ?? 'OPFS-Unavailable',
      cachedInMainLru: cachedBlock !== null,
      bytesWritten: res?.bytesWritten ?? 0,
    };
  }

  async finalizeAsset(
    assetId: string,
    patch?: Partial<PersistedAudioAssetManifest>,
  ): Promise<PersistedAudioAssetManifest | null> {
    this.assertNotDisposed();
    if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
      return null;
    }
    const res = (await this.callWorker({
      type: 'FINALIZE_ASSET',
      assetId,
      patch,
    })) as { manifest: PersistedAudioAssetManifest };
    return res?.manifest ?? null;
  }

  async abortAssetIngest(
    assetId: string,
    reason: string,
    targetState: 'abandoned' | 'failed' = 'abandoned',
  ): Promise<void> {
    if (this.disposed) return;
    this.lruCache.evictAsset(assetId);
    if (this.worker && (this.telemetry.opfsSupported || this.workerCacheBytes > 0)) {
      await this.callWorker({
        type: 'ABORT_ASSET_INGEST',
        assetId,
        reason,
        targetState,
      }).catch(() => {});
    }
    this.telemetry.cacheStats = this.lruCache.getStats();
  }

  async getReadyAssetManifest(assetId: string): Promise<PersistedAudioAssetManifest | null> {
    this.assertNotDisposed();
    if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
      return null;
    }
    const res = (await this.callWorker({
      type: 'GET_READY_ASSET',
      assetId,
    })) as { manifest: PersistedAudioAssetManifest | null };
    return res?.manifest ?? null;
  }

  async listReadyAssets(): Promise<PersistedAudioAssetManifest[]> {
    this.assertNotDisposed();
    if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
      return [];
    }
    const res = (await this.callWorker({
      type: 'LIST_READY_ASSETS',
    })) as { assets: PersistedAudioAssetManifest[] };
    return res?.assets ?? [];
  }

  async deleteAsset(assetId: string): Promise<void> {
    this.assertNotDisposed();
    this.lruCache.evictAsset(assetId);
    if (this.worker && (this.telemetry.opfsSupported || this.workerCacheBytes > 0)) {
      await this.callWorker({
        type: 'DELETE_ASSET',
        assetId,
      });
    }
    this.telemetry.cacheStats = this.lruCache.getStats();
  }

  async recoverStartupAssets(maxIngestingAgeMs = 0): Promise<{
    cleanedAssetIds: string[];
    readyAssetIds: string[];
  }> {
    this.assertNotDisposed();
    if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
      return { cleanedAssetIds: [], readyAssetIds: [] };
    }
    const res = (await this.callWorker({
      type: 'RECOVER_STARTUP_ASSETS',
      maxIngestingAgeMs,
    })) as { cleanedAssetIds: string[]; readyAssetIds: string[] };
    this.telemetry.cleanedAbandonedCount = res?.cleanedAssetIds?.length ?? 0;
    this.telemetry.recoveredAssetCount = res?.readyAssetIds?.length ?? 0;
    return res ?? { cleanedAssetIds: [], readyAssetIds: [] };
  }

  /**
   * Streams an arbitrary sample window [startSample, startSample + length) into a freshly
   * allocated Float32Array of exact length `length` using bounded LRU + OPFS chunk reads.
   * Never loads the entire audio asset into memory.
   */
  async streamReadRange(
    assetId: string,
    startSample: number,
    length: number,
    blockSizeSamples: number,
    fallbackSource?: Float32Array,
    ownerWorker: FileHandleLease['ownerWorker'] = 'playback-feeder',
  ): Promise<Float32Array> {
    this.assertNotDisposed();
    const safeStart = Math.max(0, Math.trunc(startSample));
    const safeLength = Math.max(0, Math.trunc(length));
    const safeBlockSize = Math.max(1, Math.trunc(blockSizeSamples));
    if (safeLength === 0) return new Float32Array(0);

    const output = new Float32Array(safeLength);
    const rangeEnd = safeStart + safeLength;
    const firstBlock = Math.floor(safeStart / safeBlockSize);
    const lastBlock = Math.floor((rangeEnd - 1) / safeBlockSize);

    for (let blockIdx = firstBlock; blockIdx <= lastBlock; blockIdx++) {
      const blockStartSample = blockIdx * safeBlockSize;
      let blockPcm: Float32Array | null = null;

      const cached = this.lruCache.get(assetId, blockIdx);
      if (cached && cached.channels[0]) {
        blockPcm = cached.channels[0];
      } else if (
        this.worker &&
        (this.telemetry.opfsSupported || this.workerCacheBytes > 0)
      ) {
        const assetRes = (await this.callWorker({
          type: 'READ_ASSET_CHUNK',
          assetId,
          chunkIndex: blockIdx,
          ownerWorker,
        })) as {
          buffer: ArrayBuffer | null;
          lockConflictsPrevented?: number;
          leases?: FileHandleLease[];
          workerCacheStats?: RollingCacheStats | null;
        };
        if (assetRes?.leases) {
          this.telemetry.activeLeases = assetRes.leases;
          this.telemetry.lockConflictsPrevented =
            assetRes.lockConflictsPrevented ?? this.telemetry.lockConflictsPrevented;
        }
        if (assetRes?.workerCacheStats !== undefined) {
          this.telemetry.workerCacheStats = assetRes.workerCacheStats;
        }
        if (assetRes?.buffer) {
          blockPcm = new Float32Array(assetRes.buffer);
          this.lruCache.put(assetId, blockIdx, [blockPcm]);
        } else {
          // Legacy flat block key fallback
          const legacyRes = (await this.callWorker({
            type: 'READ_BLOCK',
            fileKey: `${assetId}_blk_${blockIdx}.f32`,
            ownerWorker,
          })) as { buffer: ArrayBuffer | null };
          if (legacyRes?.buffer) {
            blockPcm = new Float32Array(legacyRes.buffer);
            this.lruCache.put(assetId, blockIdx, [blockPcm]);
          }
        }
      }

      if (!blockPcm && fallbackSource instanceof Float32Array && fallbackSource.length > blockStartSample) {
        const sliceEnd = Math.min(fallbackSource.length, blockStartSample + safeBlockSize);
        blockPcm = fallbackSource.slice(blockStartSample, sliceEnd);
        this.lruCache.put(assetId, blockIdx, [blockPcm]);
      }

      if (!blockPcm || blockPcm.length === 0) continue;

      const blockEndSample = blockStartSample + blockPcm.length;
      const copyStart = Math.max(safeStart, blockStartSample);
      const copyEnd = Math.min(rangeEnd, blockEndSample);
      if (copyEnd <= copyStart) continue;

      const srcOffset = copyStart - blockStartSample;
      const dstOffset = copyStart - safeStart;
      output.set(blockPcm.subarray(srcOffset, srcOffset + (copyEnd - copyStart)), dstOffset);
    }

    this.telemetry.cacheStats = this.lruCache.getStats();
    return output;
  }

  async simulateConcurrentLockBrokerTest(assetId: string): Promise<StorageBrokerTelemetry> {
    this.assertNotDisposed();
    const dummy = new Float32Array(2048);
    await Promise.all([
      this.writePcmBlock(assetId, 999, [dummy], 'playback-feeder'),
      this.writePcmBlock(assetId, 999, [dummy], 'ai-worker'),
    ]);
    if (this.worker && (this.telemetry.opfsSupported || this.workerCacheBytes > 0)) {
      await this.callWorker({ type: 'DELETE_FILE', fileKey: `${assetId}_blk_999.f32` }).catch(
        () => {},
      );
    }
    this.lruCache.evictAsset(assetId);
    this.telemetry.cacheStats = this.lruCache.getStats();
    return this.getTelemetry();
  }

  getTelemetry(): StorageBrokerTelemetry {
    return {
      ...this.telemetry,
      cacheStats: this.lruCache.getStats(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.telemetry.disposed = true;
    this.telemetry.opfsSupported = false;
    this.telemetry.syncAccessHandleSupported = false;
    this.telemetry.persistenceAvailable = false;
    this.telemetry.persistenceStatus = 'Disposed';

    this.rejectAllPending('StorageBrokerClient has been disposed');
    try {
      this.worker?.terminate();
    } catch {
      // ignore terminate error during teardown
    }
    this.worker = null;
    this.lruCache.clear();
    this.telemetry.cacheStats = this.lruCache.getStats();
  }
}

/**
 * Encodes Float32 PCM chunks into a standard 16-bit PCM WAV Blob
 * and computes Export Validation Report (LUFS approximation, True Peak, Clipping, Head/Tail fades).
 */
export function encodeAndValidateWavExport(
  monoOrStereoChannels: Float32Array[],
  sampleRate: number,
): { blob: Blob; report: ExportValidationReport } {
  const numChannels = Math.max(1, monoOrStereoChannels.length);
  const totalSamples = monoOrStereoChannels[0]?.length ?? 0;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = totalSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let peakLin = 0;
  let clippedSampleCount = 0;
  let sumSq = 0;
  let offset = 44;

  for (let i = 0; i < totalSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const raw = monoOrStereoChannels[c][i] ?? 0;
      const absRaw = Math.abs(raw);
      if (absRaw > peakLin) peakLin = absRaw;
      if (absRaw >= 0.999) clippedSampleCount++;
      sumSq += raw * raw;

      const clamped = Math.max(-1, Math.min(1, raw));
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  const rms = totalSamples > 0 ? Math.sqrt(sumSq / (totalSamples * numChannels)) : 0;
  const integratedLufs = Number((20 * Math.log10(Math.max(rms, 1e-6)) - 0.691).toFixed(1));
  const truePeakDbfs = Number((20 * Math.log10(Math.max(peakLin, 1e-6))).toFixed(2));
  const headValid = totalSamples > 0 ? Math.abs(monoOrStereoChannels[0][0]) < 0.1 : true;
  const tailValid =
    totalSamples > 0 ? Math.abs(monoOrStereoChannels[0][totalSamples - 1]) < 0.1 : true;

  const report: ExportValidationReport = {
    readable: totalSamples > 0,
    durationSeconds: Number((totalSamples / sampleRate).toFixed(3)),
    channelCount: numChannels,
    sampleRate,
    bitDepth: 16,
    clippedSampleCount,
    truePeakDbfs,
    integratedLufs,
    headTailFadeValid: headValid && tailValid,
    passed: totalSamples > 0 && clippedSampleCount === 0 && truePeakDbfs <= -0.1,
    fileSizeBytes: buffer.byteLength,
  };

  return {
    blob: new Blob([buffer], { type: 'audio/wav' }),
    report,
  };
}
