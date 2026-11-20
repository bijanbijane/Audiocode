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
  readonly blockIndex?: number;
}

interface BrokerAssetTransactionRecord {
  readonly transactionId: string;
  readonly assetId: string;
  readonly expectedTotalBlocks: number;
  readonly expectedTotalSamples: number;
  readonly blockSizeSamples: number;
  readonly bytesPerSample: number;
  readonly channels: 1 | 2;
  readonly expectedBytes: number;
  state: 'ingesting' | 'finalizing' | 'ready' | 'abandoned' | 'failed';
  readonly persistedBlocks: Map<number, number>;
  persistedBytes: number;
  failureReason?: string;
  abortedCleaned: boolean;
}

export class StorageBrokerClient {
  private worker: BrokerWorkerLike | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private txSeq = 0;
  private disposed = false;
  private initialized = false;
  private initPromise: Promise<StorageBrokerTelemetry> | null = null;
  private readonly workerCacheBytes: number;
  private readonly workerFactory?: () => BrokerWorkerLike;
  private readonly assetTransactions = new Map<string, BrokerAssetTransactionRecord>();
  private readonly assetOpQueues = new Map<string, Promise<unknown>>();
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

  public isInitialized(): boolean {
    return this.initialized && !this.disposed;
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

  /**
   * Serializes transactional operations for the same assetId in strict FIFO order
   * so concurrent writes, finalizations, and aborts cannot violate ordering.
   */
  private enqueueAssetOp<T>(assetId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.assetOpQueues.get(assetId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(op);
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.assetOpQueues.set(assetId, tracked);
    void tracked.finally(() => {
      if (this.assetOpQueues.get(assetId) === tracked) {
        this.assetOpQueues.delete(assetId);
      }
    });
    return run;
  }

  private invalidateInFlightTransactions(reason: string): void {
    for (const [assetId, tx] of this.assetTransactions.entries()) {
      if (tx.state === 'ingesting' || tx.state === 'finalizing') {
        tx.state = 'failed';
        tx.failureReason = tx.failureReason ?? reason;
        tx.persistedBlocks.clear();
        tx.persistedBytes = 0;
        this.lruCache.evictAsset(assetId);
      }
    }
  }

  init(): Promise<StorageBrokerTelemetry> {
    if (this.disposed) {
      return Promise.reject(new Error('StorageBrokerClient has been disposed'));
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    const run = this.performInit();
    this.initPromise = run;
    return run;
  }

  private async performInit(): Promise<StorageBrokerTelemetry> {
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
          this.invalidateInFlightTransactions(`StorageBroker worker error: ${detail}`);
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

    if (this.disposed) {
      throw new Error('StorageBrokerClient has been disposed');
    }
    this.initialized = true;
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
    if (
      !manifest ||
      typeof manifest.assetId !== 'string' ||
      manifest.assetId.trim().length === 0 ||
      !Number.isSafeInteger(manifest.totalSamples) ||
      manifest.totalSamples <= 0 ||
      !Number.isSafeInteger(manifest.blockSizeSamples) ||
      manifest.blockSizeSamples <= 0 ||
      !Number.isSafeInteger(manifest.totalBlocks) ||
      manifest.totalBlocks !== Math.ceil(manifest.totalSamples / manifest.blockSizeSamples) ||
      !Number.isSafeInteger(manifest.bytesPerSample) ||
      manifest.bytesPerSample <= 0 ||
      (manifest.channels !== 1 && manifest.channels !== 2)
    ) {
      throw new Error(
        `BROKER_INVALID_MANIFEST: Invalid ingest manifest metadata for asset "${manifest?.assetId ?? 'unknown'}".`,
      );
    }

    return this.enqueueAssetOp(manifest.assetId, async () => {
      this.assertNotDisposed();

      const existingTx = this.assetTransactions.get(manifest.assetId);
      if (existingTx && (existingTx.state === 'ingesting' || existingTx.state === 'finalizing')) {
        throw new Error(
          `BROKER_TRANSACTION_CONFLICT: Asset "${manifest.assetId}" already has an active transaction in state "${existingTx.state}".`,
        );
      }

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

      this.lruCache.evictAsset(manifest.assetId);

      const executeBegin = async () =>
        (await this.callWorker({
          type: 'BEGIN_ASSET_INGEST',
          manifest,
        })) as {
          manifest: PersistedAudioAssetManifest;
          persisted: boolean;
          backend: WorkerPersistenceBackend;
        };

      let res: {
        manifest: PersistedAudioAssetManifest;
        persisted: boolean;
        backend: WorkerPersistenceBackend;
      };
      try {
        res = await executeBegin();
      } catch (err) {
        if (isQuotaExceededError(err)) {
          this.lruCache.evictToBudget(0);
          await this.recoverStartupAssets(0).catch(() => {});
          try {
            res = await executeBegin();
          } catch (retryErr) {
            throw new StorageQuotaExceededError(undefined, retryErr);
          }
        } else {
          throw err;
        }
      }

      const truthfulPersisted =
        Boolean(res?.persisted) && res?.backend !== 'OPFS-Unavailable';

      if (truthfulPersisted) {
        const expectedBytes =
          manifest.totalSamples * manifest.bytesPerSample * manifest.channels;
        this.assetTransactions.set(manifest.assetId, {
          transactionId: `tx-${++this.txSeq}-${manifest.assetId}`,
          assetId: manifest.assetId,
          expectedTotalBlocks: manifest.totalBlocks,
          expectedTotalSamples: manifest.totalSamples,
          blockSizeSamples: manifest.blockSizeSamples,
          bytesPerSample: manifest.bytesPerSample,
          channels: manifest.channels,
          expectedBytes,
          state: 'ingesting',
          persistedBlocks: new Map(),
          persistedBytes: 0,
          abortedCleaned: false,
        });
      }

      return {
        manifest: res.manifest,
        persisted: truthfulPersisted,
        backend: truthfulPersisted ? res.backend : 'OPFS-Unavailable',
      };
    });
  }

  async writeAssetChunk(
    assetId: string,
    chunkIndex: number,
    data: Float32Array | ArrayBuffer,
    ownerWorker: FileHandleLease['ownerWorker'] = 'io-broker',
  ): Promise<WritePcmBlockResult> {
    this.assertNotDisposed();
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error(
        `BROKER_INVALID_BLOCK_INDEX: chunkIndex must be a non-negative integer, got ${String(chunkIndex)}.`,
      );
    }

    const floatView =
      data instanceof Float32Array ? data : new Float32Array(data);

    return this.enqueueAssetOp(assetId, async () => {
      this.assertNotDisposed();

      const shouldUseWorker =
        Boolean(this.worker) &&
        floatView.byteLength > 0 &&
        (this.telemetry.opfsSupported || this.workerCacheBytes > 0);

      if (!shouldUseWorker) {
        const cachedBlock = this.lruCache.put(assetId, chunkIndex, [floatView]);
        this.telemetry.cacheStats = this.lruCache.getStats();
        return {
          persisted: false,
          backend: 'OPFS-Unavailable',
          cachedInMainLru: cachedBlock !== null,
          bytesWritten: 0,
          blockIndex: chunkIndex,
        };
      }

      const tx = this.assetTransactions.get(assetId);
      if (this.telemetry.opfsSupported) {
        if (!tx) {
          throw new Error(
            `BROKER_NO_ACTIVE_TRANSACTION: Cannot write chunk #${chunkIndex} for "${assetId}" without an active beginAssetIngest() transaction.`,
          );
        }
        if (tx.state !== 'ingesting') {
          throw new Error(
            `BROKER_TRANSACTION_INVALID_STATE: Cannot write chunk #${chunkIndex} for "${assetId}" while transaction is in state "${tx.state}".`,
          );
        }
        if (chunkIndex >= tx.expectedTotalBlocks) {
          tx.state = 'failed';
          tx.failureReason = `Block index ${chunkIndex} out of bounds [0, ${tx.expectedTotalBlocks - 1}]`;
          this.lruCache.evictAsset(assetId);
          throw new Error(`BROKER_INVALID_BLOCK_INDEX: ${tx.failureReason}`);
        }
        if (tx.persistedBlocks.has(chunkIndex)) {
          tx.state = 'failed';
          tx.failureReason = `Duplicate write attempted for already-acknowledged block #${chunkIndex}`;
          this.lruCache.evictAsset(assetId);
          throw new Error(`BROKER_DUPLICATE_BLOCK_WRITE: ${tx.failureReason}`);
        }
        const expectedChunkSamples = Math.min(
          tx.blockSizeSamples,
          Math.max(0, tx.expectedTotalSamples - chunkIndex * tx.blockSizeSamples),
        );
        const expectedChunkBytes =
          expectedChunkSamples * tx.bytesPerSample * tx.channels;
        if (floatView.byteLength !== expectedChunkBytes) {
          tx.state = 'failed';
          tx.failureReason = `Chunk #${chunkIndex} byte length mismatch: expected ${expectedChunkBytes} bytes, got ${floatView.byteLength}`;
          this.lruCache.evictAsset(assetId);
          throw new Error(`BROKER_CHUNK_BYTE_MISMATCH: ${tx.failureReason}`);
        }
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
            if (tx) {
              tx.state = 'failed';
              tx.failureReason =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              this.lruCache.evictAsset(assetId);
            }
            throw new StorageQuotaExceededError(undefined, retryErr);
          }
        } else {
          if (tx) {
            tx.state = 'failed';
            tx.failureReason = err instanceof Error ? err.message : String(err);
            this.lruCache.evictAsset(assetId);
          }
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

      const bytesWritten =
        typeof res?.bytesWritten === 'number' &&
        Number.isSafeInteger(res.bytesWritten) &&
        res.bytesWritten >= 0
          ? res.bytesWritten
          : 0;
      const backend: WorkerPersistenceBackend = res?.backend ?? 'OPFS-Unavailable';
      const rawPersisted = Boolean(res?.persisted) && backend !== 'OPFS-Unavailable';
      const byteCountMatches = bytesWritten === floatView.byteLength;
      const truthfulPersisted = rawPersisted && byteCountMatches;

      let cachedInMainLru = false;
      if (tx) {
        if (truthfulPersisted) {
          tx.persistedBlocks.set(chunkIndex, bytesWritten);
          tx.persistedBytes += bytesWritten;
          cachedInMainLru = this.lruCache.put(assetId, chunkIndex, [floatView]) !== null;
        } else {
          tx.state = 'failed';
          tx.failureReason = !rawPersisted
            ? `Block #${chunkIndex} failed durable persistence (backend: ${backend})`
            : `Block #${chunkIndex} byte write mismatch: expected ${floatView.byteLength}, wrote ${bytesWritten}`;
          this.lruCache.evictAsset(assetId);
        }
      } else {
        cachedInMainLru = this.lruCache.put(assetId, chunkIndex, [floatView]) !== null;
      }

      this.telemetry.cacheStats = this.lruCache.getStats();

      return {
        persisted: truthfulPersisted,
        backend,
        cachedInMainLru,
        bytesWritten,
        blockIndex: chunkIndex,
      };
    });
  }

  async finalizeAsset(
    assetId: string,
    patch?: Partial<PersistedAudioAssetManifest>,
  ): Promise<PersistedAudioAssetManifest | null> {
    this.assertNotDisposed();
    return this.enqueueAssetOp(assetId, async () => {
      this.assertNotDisposed();
      if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
        return null;
      }

      const tx = this.assetTransactions.get(assetId);
      if (this.telemetry.opfsSupported) {
        if (!tx) {
          throw new Error(
            `BROKER_NO_ACTIVE_TRANSACTION: Cannot finalize asset "${assetId}" without an active ingestion transaction.`,
          );
        }
        if (tx.state === 'ready') {
          throw new Error(
            `BROKER_ALREADY_COMMITTED: Asset "${assetId}" transaction "${tx.transactionId}" has already been finalized.`,
          );
        }
        if (tx.state !== 'ingesting') {
          throw new Error(
            `BROKER_CANNOT_FINALIZE_STATE: Cannot finalize asset "${assetId}" in state "${tx.state}"${
              tx.failureReason ? ` (${tx.failureReason})` : ''
            }.`,
          );
        }
        if (patch?.totalBlocks !== undefined && patch.totalBlocks !== tx.expectedTotalBlocks) {
          tx.state = 'failed';
          tx.failureReason = `Finalization patch totalBlocks mismatch: expected ${tx.expectedTotalBlocks}, got ${patch.totalBlocks}`;
          this.lruCache.evictAsset(assetId);
          throw new Error(`BROKER_FINALIZE_MISMATCH: ${tx.failureReason}`);
        }
        if (patch?.totalSamples !== undefined && patch.totalSamples !== tx.expectedTotalSamples) {
          tx.state = 'failed';
          tx.failureReason = `Finalization patch totalSamples mismatch: expected ${tx.expectedTotalSamples}, got ${patch.totalSamples}`;
          this.lruCache.evictAsset(assetId);
          throw new Error(`BROKER_FINALIZE_MISMATCH: ${tx.failureReason}`);
        }

        const missingIndexes: number[] = [];
        for (let i = 0; i < tx.expectedTotalBlocks; i++) {
          if (!tx.persistedBlocks.has(i)) {
            missingIndexes.push(i);
          }
        }
        if (
          missingIndexes.length > 0 ||
          tx.persistedBlocks.size !== tx.expectedTotalBlocks ||
          tx.persistedBytes !== tx.expectedBytes
        ) {
          tx.state = 'failed';
          tx.failureReason = `Incomplete block set before finalization: persisted ${tx.persistedBlocks.size}/${tx.expectedTotalBlocks} blocks (${tx.persistedBytes}/${tx.expectedBytes} bytes), missing [${missingIndexes.join(', ')}]`;
          this.lruCache.evictAsset(assetId);
          throw new Error(`BROKER_INCOMPLETE_BLOCKS: ${tx.failureReason}`);
        }

        tx.state = 'finalizing';
      }

      try {
        const res = (await this.callWorker({
          type: 'FINALIZE_ASSET',
          assetId,
          patch,
        })) as { manifest: PersistedAudioAssetManifest };
        const manifest = res?.manifest ?? null;

        if (tx) {
          if (
            !manifest ||
            manifest.state !== 'ready' ||
            manifest.totalBlocks !== tx.expectedTotalBlocks ||
            manifest.totalSamples !== tx.expectedTotalSamples ||
            manifest.blockSizeSamples !== tx.blockSizeSamples
          ) {
            tx.state = 'failed';
            tx.failureReason = `Worker returned invalid finalized manifest for "${assetId}" (state=${manifest?.state ?? 'null'}, totalBlocks=${manifest?.totalBlocks ?? 'null'}, totalSamples=${manifest?.totalSamples ?? 'null'}).`;
            this.lruCache.evictAsset(assetId);
            throw new Error(`BROKER_INVALID_FINAL_MANIFEST: ${tx.failureReason}`);
          }
          tx.state = 'ready';
        }

        return manifest;
      } catch (err) {
        if (tx && tx.state !== 'ready') {
          tx.state = 'failed';
          tx.failureReason =
            tx.failureReason ?? (err instanceof Error ? err.message : String(err));
          this.lruCache.evictAsset(assetId);
        }
        throw err;
      }
    });
  }

  async abortAssetIngest(
    assetId: string,
    reason: string,
    targetState: 'abandoned' | 'failed' = 'abandoned',
  ): Promise<void> {
    if (this.disposed) return;
    return this.enqueueAssetOp(assetId, async () => {
      if (this.disposed) return;
      this.lruCache.evictAsset(assetId);

      const tx = this.assetTransactions.get(assetId);
      if (tx && (tx.state === 'abandoned' || tx.state === 'failed') && tx.abortedCleaned) {
        this.telemetry.cacheStats = this.lruCache.getStats();
        return;
      }

      if (tx) {
        tx.state = targetState;
        tx.failureReason = tx.failureReason ?? reason;
        tx.persistedBlocks.clear();
        tx.persistedBytes = 0;
      }

      let rollbackErr: unknown = null;
      if (this.worker && (this.telemetry.opfsSupported || this.workerCacheBytes > 0)) {
        try {
          await this.callWorker({
            type: 'ABORT_ASSET_INGEST',
            assetId,
            reason,
            targetState,
          });
        } catch (err) {
          rollbackErr = err;
        }
      }

      if (tx) {
        tx.abortedCleaned = true;
      }
      this.telemetry.cacheStats = this.lruCache.getStats();

      if (rollbackErr !== null) {
        throw rollbackErr;
      }
    });
  }

  async getReadyAssetManifest(assetId: string): Promise<PersistedAudioAssetManifest | null> {
    this.assertNotDisposed();
    const tx = this.assetTransactions.get(assetId);
    if (tx && tx.state !== 'ready') {
      return null;
    }
    if (!this.worker || (!this.telemetry.opfsSupported && this.workerCacheBytes === 0)) {
      return null;
    }
    const res = (await this.callWorker({
      type: 'GET_READY_ASSET',
      assetId,
    })) as { manifest: PersistedAudioAssetManifest | null };
    const manifest = res?.manifest ?? null;
    if (!manifest || manifest.state !== 'ready') {
      return null;
    }
    return manifest;
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
    return this.enqueueAssetOp(assetId, async () => {
      this.assertNotDisposed();
      this.assetTransactions.delete(assetId);
      this.lruCache.evictAsset(assetId);
      if (this.worker && (this.telemetry.opfsSupported || this.workerCacheBytes > 0)) {
        await this.callWorker({
          type: 'DELETE_ASSET',
          assetId,
        });
      }
      this.telemetry.cacheStats = this.lruCache.getStats();
    });
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
    this.initialized = false;
    this.initPromise = null;
    this.telemetry.disposed = true;
    this.telemetry.opfsSupported = false;
    this.telemetry.syncAccessHandleSupported = false;
    this.telemetry.persistenceAvailable = false;
    this.telemetry.persistenceStatus = 'Disposed';

    this.invalidateInFlightTransactions('StorageBrokerClient has been disposed');
    this.rejectAllPending('StorageBrokerClient has been disposed');
    try {
      this.worker?.terminate();
    } catch {
      // ignore terminate error during teardown
    }
    this.worker = null;
    this.assetTransactions.clear();
    this.assetOpQueues.clear();
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
  const validSampleRate = Number.isFinite(sampleRate) && sampleRate > 0;
  const hasChannels = Array.isArray(monoOrStereoChannels) && monoOrStereoChannels.length > 0;
  const firstLen = hasChannels && monoOrStereoChannels[0] instanceof Float32Array
    ? monoOrStereoChannels[0].length
    : 0;
  const allChannelsValid =
    hasChannels &&
    firstLen > 0 &&
    monoOrStereoChannels.every(
      (ch) => ch instanceof Float32Array && ch.length === firstLen,
    );
  const structurallyValid = validSampleRate && allChannelsValid;

  if (!structurallyValid) {
    const safeChannels = hasChannels ? monoOrStereoChannels.length : 0;
    const safeSampleRate = validSampleRate ? Math.round(sampleRate) : 0;
    const emptyHeader = new ArrayBuffer(44);
    return {
      blob: new Blob([emptyHeader], { type: 'audio/wav' }),
      report: {
        readable: false,
        structurallyValid: false,
        invalidSampleCount: 0,
        durationSeconds: 0,
        channelCount: safeChannels,
        sampleRate: safeSampleRate,
        bitDepth: 16,
        clippedSampleCount: 0,
        truePeakDbfs: -120,
        integratedLufs: -120,
        headTailFadeValid: false,
        passed: false,
        fileSizeBytes: 0,
      },
    };
  }

  const numChannels = monoOrStereoChannels.length;
  const totalSamples = firstLen;
  const safeSampleRate = Math.round(sampleRate);
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
  view.setUint32(24, safeSampleRate, true);
  view.setUint32(28, safeSampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let peakLin = 0;
  let clippedSampleCount = 0;
  let invalidSampleCount = 0;
  let validSampleCount = 0;
  let sumSq = 0;
  let offset = 44;

  for (let i = 0; i < totalSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const raw = monoOrStereoChannels[c][i];
      if (!Number.isFinite(raw)) {
        invalidSampleCount++;
        view.setInt16(offset, 0, true);
        offset += 2;
        continue;
      }
      validSampleCount++;
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

  const rms = validSampleCount > 0 ? Math.sqrt(sumSq / validSampleCount) : 0;
  const integratedLufs = Number((20 * Math.log10(Math.max(rms, 1e-6)) - 0.691).toFixed(1));
  const truePeakDbfs = Number((20 * Math.log10(Math.max(peakLin, 1e-6))).toFixed(2));
  const headValid = monoOrStereoChannels.every(
    (ch) => Number.isFinite(ch[0]) && Math.abs(ch[0]) < 0.1,
  );
  const tailValid = monoOrStereoChannels.every(
    (ch) =>
      Number.isFinite(ch[totalSamples - 1]) && Math.abs(ch[totalSamples - 1]) < 0.1,
  );

  const report: ExportValidationReport = {
    readable: invalidSampleCount === 0,
    structurallyValid: true,
    invalidSampleCount,
    durationSeconds: Number((totalSamples / safeSampleRate).toFixed(3)),
    channelCount: numChannels,
    sampleRate: safeSampleRate,
    bitDepth: 16,
    clippedSampleCount,
    truePeakDbfs,
    integratedLufs,
    headTailFadeValid: headValid && tailValid,
    passed:
      invalidSampleCount === 0 &&
      clippedSampleCount === 0 &&
      truePeakDbfs <= -0.1,
    fileSizeBytes: buffer.byteLength,
  };

  return {
    blob: new Blob([buffer], { type: 'audio/wav' }),
    report,
  };
}
