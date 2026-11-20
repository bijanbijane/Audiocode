import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVAPARDAZ_AUDIO_CACHE_SPLIT,
  AVAPARDAZ_MEMORY_POLICY,
} from '../runtime/memory/MemoryPolicy';
import { BrokerWorkerLike, StorageBrokerClient } from './storageBroker';
import {
  BoundedWorkerBufferCache,
  OpfsDirectoryLike,
  WorkerBrokerRequest,
  WorkerStorageCore,
} from './workerStorageCore';

test('StorageBrokerClient enforces 32 MiB combined audio cache ceiling and matches telemetry capacity', () => {
  const defaultBroker = new StorageBrokerClient();
  const telemetry = defaultBroker.getTelemetry();

  assert.equal(telemetry.cacheStats.maxBytes, AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes);
  assert.equal(telemetry.totalAudioCacheBudgetBytes, AVAPARDAZ_MEMORY_POLICY.audioCacheBytes);
  assert.equal(telemetry.persistenceAvailable, false);
  assert.equal(telemetry.persistenceStatus, 'OPFS-Unavailable');
  defaultBroker.dispose();

  // Combined > 32 MiB must be rejected
  assert.throws(
    () =>
      new StorageBrokerClient({
        mainThreadCacheBytes: 25 * 1024 * 1024,
        workerCacheBytes: 8 * 1024 * 1024,
      }),
    RangeError,
  );

  // Worker cache > 8 MiB must be rejected
  assert.throws(
    () =>
      new StorageBrokerClient({
        mainThreadCacheBytes: 16 * 1024 * 1024,
        workerCacheBytes: 9 * 1024 * 1024,
      }),
    RangeError,
  );
});

test('StorageBrokerClient handles Worker & OPFS unavailable honestly without false durable persistence or extra copies', async () => {
  const broker = new StorageBrokerClient();
  const tel = await broker.init();

  assert.equal(tel.opfsSupported, false);
  assert.equal(tel.persistenceAvailable, false);
  assert.equal(tel.persistenceStatus, 'OPFS-Unavailable');

  const block = new Float32Array(1024).fill(0.25);
  const writeRes = await broker.writePcmBlock('asset-1', 0, [block]);
  assert.equal(writeRes.persisted, false);
  assert.equal(writeRes.backend, 'OPFS-Unavailable');
  assert.equal(writeRes.bytesWritten, 0);
  assert.equal(writeRes.cachedInMainLru, true);

  // Fallback source supplies block when absent from OPFS and evicted from main cache
  broker.lruCache.clear();
  const source = new Float32Array(2048);
  source[1024] = 0.75;
  const readBack = await broker.readPcmBlock('asset-1', 1, source, 1024, 512);
  assert.equal(readBack.length, 512);
  assert.equal(readBack[0], 0.75);

  broker.dispose();
});

test('StorageBrokerClient skips worker transfer when OPFS is unavailable and no worker cache is configured', async () => {
  let postMessages: unknown[] = [];

  class NoOpfsMockWorker implements BrokerWorkerLike {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent | { message?: string }) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    private readonly core = new WorkerStorageCore(async () => null);

    postMessage(message: unknown): void {
      postMessages.push(message);
      const req = message as WorkerBrokerRequest;
      void this.core.handleMessage(req).then(({ payload }) => {
        this.onmessage?.({ data: { id: req.id, ok: true, payload } } as MessageEvent);
      });
    }
    terminate(): void {}
  }

  const broker = new StorageBrokerClient({
    mainThreadCacheBytes: AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
    workerCacheBytes: 0,
    workerFactory: () => new NoOpfsMockWorker(),
  });

  const tel = await broker.init();
  assert.equal(tel.opfsSupported, false);
  assert.equal(tel.persistenceAvailable, false);
  assert.equal(postMessages.length, 1); // INIT only

  const writeRes = await broker.writePcmBlock('asset-1', 0, [new Float32Array(1024)]);
  assert.equal(writeRes.persisted, false);
  assert.equal(writeRes.bytesWritten, 0);
  // Zero extra IPC / buffer copy when OPFS unavailable
  assert.equal(postMessages.length, 1);

  broker.dispose();
});

test('StorageBrokerClient rejects pending requests on disposal, worker failure, and deserialization errors, and makes dispose idempotent', async () => {
  let activeWorker: HangingOrFailingWorker | null = null;

  class HangingOrFailingWorker implements BrokerWorkerLike {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent | { message?: string }) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    terminated = false;

    postMessage(message: unknown): void {
      const req = message as WorkerBrokerRequest;
      if (req.type === 'INIT') {
        this.onmessage?.({
          data: {
            id: req.id,
            ok: true,
            payload: {
              opfsAvailable: true,
              syncHandleAvailable: true,
              lockConflictsPrevented: 0,
              leases: [],
              workerCacheStats: null,
            },
          },
        } as MessageEvent);
      } else if (req.type === 'RECOVER_STARTUP_ASSETS') {
        this.onmessage?.({
          data: {
            id: req.id,
            ok: true,
            payload: {
              cleanedAssetIds: [],
              readyAssetIds: [],
            },
          },
        } as MessageEvent);
      }
      // Deliberately hang WRITE_BLOCK so disposal / error must reject pending promise
    }
    terminate(): void {
      this.terminated = true;
    }
  }

  // Case 1: Disposal rejects pending request and prevents post-dispose calls; repeated dispose is safe
  const broker1 = new StorageBrokerClient({
    workerFactory: () => {
      activeWorker = new HangingOrFailingWorker();
      return activeWorker;
    },
  });
  await broker1.init();

  const pendingWrite = broker1.writePcmBlock('asset-hang', 0, [new Float32Array(512)]);
  broker1.dispose();
  broker1.dispose(); // idempotent repeat

  assert.equal(activeWorker!.terminated, true);
  assert.equal(broker1.isDisposed(), true);
  await assert.rejects(pendingWrite, /disposed/i);
  await assert.rejects(
    broker1.writePcmBlock('asset-after', 1, [new Float32Array(512)]),
    /disposed/i,
  );

  // Case 2: Worker error rejects pending request cleanly
  let errorWorker: HangingOrFailingWorker | null = null;
  const broker2 = new StorageBrokerClient({
    workerFactory: () => {
      errorWorker = new HangingOrFailingWorker();
      return errorWorker;
    },
  });
  await broker2.init();
  const writeDuringCrash = broker2.writePcmBlock('asset-crash', 0, [new Float32Array(512)]);
  errorWorker!.onerror?.({ message: 'Simulated worker crash' });
  await assert.rejects(writeDuringCrash, /Simulated worker crash/);
  assert.equal(broker2.getTelemetry().opfsSupported, false);
  assert.equal(broker2.getTelemetry().persistenceAvailable, false);
  broker2.dispose();

  // Case 3: Worker message deserialization error rejects pending request cleanly
  let msgErrWorker: HangingOrFailingWorker | null = null;
  const broker3 = new StorageBrokerClient({
    workerFactory: () => {
      msgErrWorker = new HangingOrFailingWorker();
      return msgErrWorker;
    },
  });
  await broker3.init();
  const writeDuringDeserializeErr = broker3.writePcmBlock('asset-msgerr', 0, [new Float32Array(512)]);
  msgErrWorker!.onmessageerror?.({} as MessageEvent);
  await assert.rejects(writeDuringDeserializeErr, /deserialization/i);
  broker3.dispose();
});

test('WorkerStorageCore enforces bounded <= 8 MiB cache when enabled, rejects oversized blocks, and never claims durable persistence without OPFS', async () => {
  assert.throws(() => new BoundedWorkerBufferCache(0), RangeError);
  assert.throws(
    () => new BoundedWorkerBufferCache(AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes + 1),
    RangeError,
  );

  const core = new WorkerStorageCore(async () => null);
  const initRes = await core.init(8192); // 8 KiB bounded worker cache
  assert.equal(initRes.opfsAvailable, false);
  assert.equal(initRes.workerCacheStats?.maxBytes, 8192);

  const b1 = await core.writeBlock('k1.f32', 'playback-feeder', new ArrayBuffer(4096));
  const b2 = await core.writeBlock('k2.f32', 'playback-feeder', new ArrayBuffer(4096));
  assert.equal(b1.persisted, false);
  assert.equal(b1.backend, 'OPFS-Unavailable');
  assert.equal(b1.cachedInWorker, true);
  assert.equal(b2.workerCacheStats?.usedBytes, 8192);

  // Oversized write (> 8192 B) must be rejected without evicting k1 or k2
  const oversized = await core.writeBlock('huge.f32', 'playback-feeder', new ArrayBuffer(16_384));
  assert.equal(oversized.persisted, false);
  assert.equal(oversized.cachedInWorker, false);
  assert.equal(oversized.workerCacheStats?.cachedBlocks, 2);
  assert.equal(oversized.workerCacheStats?.evictions, 0);

  // Third 4096 B block evicts k1 via LRU
  const b3 = await core.writeBlock('k3.f32', 'playback-feeder', new ArrayBuffer(4096));
  assert.equal(b3.cachedInWorker, true);
  assert.equal(b3.workerCacheStats?.usedBytes, 8192);
  assert.equal(b3.workerCacheStats?.evictions, 1);
  assert.equal((await core.readBlock('k1.f32', 'ai-worker')).buffer, null);
  const r2 = await core.readBlock('k2.f32', 'ai-worker');
  assert.equal(r2.persisted, false);
  assert.equal(r2.buffer?.byteLength, 4096);
});

test('WorkerStorageCore persists honestly when OPFS is available', async () => {
  const files = new Map<string, ArrayBuffer>();
  const mockOpfsDir: OpfsDirectoryLike = {
    async getFileHandle(name) {
      return {
        async createWritable() {
          return {
            async write(data: ArrayBuffer) {
              files.set(name, data.slice(0));
            },
            async close() {},
          };
        },
        async getFile() {
          const data = files.get(name);
          if (!data) throw new Error('NotFoundError');
          return { async arrayBuffer() { return data.slice(0); } };
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };

  const core = new WorkerStorageCore(async () => mockOpfsDir);
  const initRes = await core.init(0);
  assert.equal(initRes.opfsAvailable, true);

  const payload = new Float32Array([1, 2, 3, 4]).buffer;
  const writeRes = await core.writeBlock('track_0.f32', 'io-broker', payload);
  assert.equal(writeRes.persisted, true);
  assert.equal(writeRes.backend, 'OPFS-Writable');
  assert.equal(writeRes.bytesWritten, 16);

  const readRes = await core.readBlock('track_0.f32', 'playback-feeder');
  assert.equal(readRes.persisted, true);
  assert.deepEqual(Array.from(new Float32Array(readRes.buffer!)), [1, 2, 3, 4]);
});

test('WorkerStorageCore serializes concurrent SyncAccessHandle operations on the same fileKey without NoModificationAllowedError', async () => {
  const fileBuffers = new Map<string, Uint8Array>();
  const openHandleCount = new Map<string, number>();
  let peakConcurrentOpen = 0;

  const strictSyncDir: OpfsDirectoryLike = {
    async getFileHandle(name) {
      // Simulate real microtask yield during OPFS handle resolution
      await new Promise((r) => setTimeout(r, 5));
      return {
        async createSyncAccessHandle() {
          await new Promise((r) => setTimeout(r, 5));
          const currentlyOpen = openHandleCount.get(name) ?? 0;
          if (currentlyOpen > 0) {
            const err = new Error(
              'Access Handles cannot be created if there is another open Access Handle associated with the same file.',
            );
            err.name = 'NoModificationAllowedError';
            throw err;
          }
          const nextOpen = currentlyOpen + 1;
          openHandleCount.set(name, nextOpen);
          peakConcurrentOpen = Math.max(peakConcurrentOpen, nextOpen);
          let closed = false;
          return {
            truncate(size: number) {
              const prev = fileBuffers.get(name) ?? new Uint8Array(0);
              const resized = new Uint8Array(size);
              resized.set(prev.subarray(0, Math.min(prev.length, size)));
              fileBuffers.set(name, resized);
            },
            write(data: ArrayBufferView, options?: { at?: number }) {
              const at = options?.at ?? 0;
              const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              const prev = fileBuffers.get(name) ?? new Uint8Array(0);
              const out = new Uint8Array(Math.max(prev.length, at + src.length));
              out.set(prev);
              out.set(src, at);
              fileBuffers.set(name, out);
              return src.length;
            },
            flush() {},
            getSize() {
              return (fileBuffers.get(name) ?? new Uint8Array(0)).length;
            },
            read(data: ArrayBufferView, options?: { at?: number }) {
              const at = options?.at ?? 0;
              const src = fileBuffers.get(name) ?? new Uint8Array(0);
              const dst = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              const slice = src.subarray(at, at + dst.length);
              dst.set(slice);
              return slice.length;
            },
            close() {
              if (!closed) {
                closed = true;
                openHandleCount.set(name, Math.max(0, (openHandleCount.get(name) ?? 1) - 1));
              }
            },
          };
        },
        async getFile() {
          const data = fileBuffers.get(name) ?? new Uint8Array(0);
          return {
            size: data.byteLength,
            async arrayBuffer() {
              return data.slice().buffer;
            },
          };
        },
      };
    },
    async removeEntry(name) {
      fileBuffers.delete(name);
    },
  };

  const core = new WorkerStorageCore(async () => strictSyncDir);
  const initRes = await core.init(0);
  assert.equal(initRes.opfsAvailable, true);
  assert.equal(initRes.syncHandleAvailable, true);

  const bufA = new Float32Array([10, 20, 30, 40]).buffer;
  const bufB = new Float32Array([50, 60, 70, 80]).buffer;

  // Fire concurrent writes and read on the exact same fileKey (like 2-Worker contention test)
  const [w1, w2, r1] = await Promise.all([
    core.writeBlock('shared_blk_999.f32', 'playback-feeder', bufA),
    core.writeBlock('shared_blk_999.f32', 'ai-worker', bufB),
    core.readBlock('shared_blk_999.f32', 'io-broker'),
  ]);

  assert.equal(w1.backend, 'OPFS-SyncAccessHandle');
  assert.equal(w2.backend, 'OPFS-SyncAccessHandle');
  assert.equal(r1.persisted, true);
  assert.equal(peakConcurrentOpen, 1);
  assert.ok(core.getState().lockConflictsPrevented >= 2);
});

