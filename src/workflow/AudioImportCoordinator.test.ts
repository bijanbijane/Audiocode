import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  PersistedAudioAssetManifest,
  StorageBrokerTelemetry,
} from '../contracts/v1_2';
import {
  MemoryBudgetManager,
  MemoryPressureError,
} from '../runtime/memory/MemoryBudgetManager';
import {
  AVAPARDAZ_MEMORY_POLICY,
  type MemoryPolicyConfig,
} from '../runtime/memory/MemoryPolicy';
import {
  encodeAndValidateWavExport,
  type WritePcmBlockResult,
} from '../engine/storageBroker';
import {
  IngestAbortedError,
  IngestTransactionError,
  ProjectResourceLeaseSlot,
  type StreamingIngestBroker,
  type StreamingIngestOptions,
} from '../engine/streamingIngest';
import { ingestUploadedAudioFile } from '../engine/audioFixtures';
import {
  AudioImportCoordinatorError,
  importAudioProject,
  verifyReadyAssetManifestInvariants,
} from './AudioImportCoordinator';

function createDeterministicWavFile(
  durationSeconds = 2.5,
  sampleRate = 16_000,
  fileName = 'coordinator-test.wav',
): { file: File; samples: Float32Array; totalSamples: number; sampleRate: number } {
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    samples[i] = 0.35 * Math.sin((2 * Math.PI * 260 * i) / sampleRate);
  }
  const encoded = encodeAndValidateWavExport([samples], sampleRate);
  const file = new File([encoded.blob], fileName, { type: 'audio/wav' });
  return { file, samples, totalSamples, sampleRate };
}

function makeTightPolicy(hardLimitBytes: number): MemoryPolicyConfig {
  return {
    hardLimitBytes,
    emergencyBytes: Math.max(1, Math.floor(hardLimitBytes * 0.92)),
    throttleBytes: Math.max(1, Math.floor(hardLimitBytes * 0.87)),
    targetBytes: Math.max(1, Math.floor(hardLimitBytes * 0.82)),
    audioCacheBytes: Math.max(1, Math.min(8 * 1024 * 1024, Math.floor(hardLimitBytes * 0.25))),
  };
}

interface MockBrokerControl {
  readonly broker: StreamingIngestBroker;
  readonly getCounts: () => {
    beginCalls: number;
    writeCalls: number;
    finalizeCalls: number;
    abortCalls: number;
    readyManifestCalls: number;
  };
  readonly setTelemetry: (patch: Partial<StorageBrokerTelemetry>) => void;
  readonly setDisposed: (disposed: boolean) => void;
  readonly getManifest: (assetId: string) => PersistedAudioAssetManifest | undefined;
}

function createControlledBroker(opts?: {
  initialOpfsAvailable?: boolean;
  backend?: 'OPFS-SyncAccessHandle' | 'OPFS-Writable' | 'OPFS-Unavailable';
  failOnChunkIndex?: number;
  disposeOnChunkIndex?: number;
  onGetReadyManifest?: (
    assetId: string,
    stored: PersistedAudioAssetManifest | null,
    callIndex: number,
  ) => PersistedAudioAssetManifest | null;
  onWriteChunkDelayMs?: number;
}): MockBrokerControl {
  const initialOpfs = opts?.initialOpfsAvailable ?? true;
  const backend =
    opts?.backend ?? (initialOpfs ? 'OPFS-SyncAccessHandle' : 'OPFS-Unavailable');
  let disposed = false;
  let beginCalls = 0;
  let writeCalls = 0;
  let finalizeCalls = 0;
  let abortCalls = 0;
  let readyManifestCalls = 0;

  const manifests = new Map<string, PersistedAudioAssetManifest>();
  const chunks = new Map<string, Map<number, Float32Array>>();

  let telemetryState: StorageBrokerTelemetry = {
    opfsSupported: initialOpfs,
    syncAccessHandleSupported: backend === 'OPFS-SyncAccessHandle',
    persistentStorageGranted: initialOpfs ? true : null,
    quotaUsedBytes: 0,
    quotaTotalBytes: 1024 * 1024 * 1024,
    activeLeases: [],
    lockConflictsPrevented: 0,
    cacheStats: {
      maxBytes: 24 * 1024 * 1024,
      usedBytes: 0,
      cachedBlocks: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
    },
    persistenceAvailable: initialOpfs,
    persistenceStatus: backend,
    workerCacheStats: null,
    totalAudioCacheBudgetBytes: 32 * 1024 * 1024,
    disposed: false,
    recoveredAssetCount: 0,
    cleanedAbandonedCount: 0,
  };

  const broker: StreamingIngestBroker = {
    isDisposed: () => disposed,
    getTelemetry: () => ({
      ...telemetryState,
      disposed,
      persistenceStatus: disposed ? 'Disposed' : telemetryState.persistenceStatus,
      opfsSupported: disposed ? false : telemetryState.opfsSupported,
      persistenceAvailable: disposed ? false : telemetryState.persistenceAvailable,
    }),
    async beginAssetIngest(manifest) {
      if (disposed) throw new Error('StorageBrokerClient has been disposed');
      beginCalls++;
      if (!telemetryState.opfsSupported) {
        return {
          manifest: { ...manifest, state: 'ingesting' },
          persisted: false,
          backend: 'OPFS-Unavailable',
        };
      }
      const stored: PersistedAudioAssetManifest = { ...manifest, state: 'ingesting' };
      manifests.set(manifest.assetId, stored);
      chunks.set(manifest.assetId, new Map());
      return {
        manifest: stored,
        persisted: true,
        backend: telemetryState.persistenceStatus as 'OPFS-SyncAccessHandle' | 'OPFS-Writable',
      };
    },
    async writeAssetChunk(assetId, chunkIndex, data) {
      if (disposed) throw new Error('StorageBrokerClient has been disposed');
      writeCalls++;
      if (opts?.onWriteChunkDelayMs) {
        await new Promise((r) => setTimeout(r, opts.onWriteChunkDelayMs));
      }
      if (opts?.disposeOnChunkIndex === chunkIndex) {
        disposed = true;
        throw new Error('StorageBrokerClient has been disposed');
      }
      if (opts?.failOnChunkIndex === chunkIndex) {
        const failRes: WritePcmBlockResult = {
          persisted: false,
          backend: 'OPFS-Unavailable',
          bytesWritten: 0,
          cachedInMainLru: false,
          blockIndex: chunkIndex,
        };
        return failRes;
      }
      const copy =
        data instanceof Float32Array
          ? new Float32Array(data)
          : new Float32Array(data.slice(0));
      let map = chunks.get(assetId);
      if (!map) {
        map = new Map();
        chunks.set(assetId, map);
      }
      map.set(chunkIndex, copy);
      return {
        persisted: true,
        backend: telemetryState.persistenceStatus as 'OPFS-SyncAccessHandle' | 'OPFS-Writable',
        bytesWritten: copy.byteLength,
        cachedInMainLru: true,
        blockIndex: chunkIndex,
      };
    },
    async finalizeAsset(assetId, patch) {
      if (disposed) throw new Error('StorageBrokerClient has been disposed');
      finalizeCalls++;
      const cur = manifests.get(assetId);
      if (!cur) return null;
      const now = Date.now();
      const ready: PersistedAudioAssetManifest = {
        ...cur,
        ...(patch ?? {}),
        assetId,
        state: 'ready',
        updatedAtMs: now,
        finalizedAtMs: now,
      };
      manifests.set(assetId, ready);
      return ready;
    },
    async abortAssetIngest(assetId, reason, targetState = 'failed') {
      abortCalls++;
      chunks.delete(assetId);
      const cur = manifests.get(assetId);
      if (cur) {
        manifests.set(assetId, { ...cur, state: targetState, errorMessage: reason });
      }
    },
    async getReadyAssetManifest(assetId) {
      if (disposed) throw new Error('StorageBrokerClient has been disposed');
      readyManifestCalls++;
      const cur = manifests.get(assetId) ?? null;
      const defaultResult = cur && cur.state === 'ready' ? cur : null;
      if (opts?.onGetReadyManifest) {
        return opts.onGetReadyManifest(assetId, defaultResult, readyManifestCalls);
      }
      return defaultResult;
    },
    async streamReadRange(assetId, startSample, lengthSamples, blockSizeSamples, fallbackSource) {
      if (fallbackSource) {
        return fallbackSource.subarray(startSample, Math.min(fallbackSource.length, startSample + lengthSamples));
      }
      const map = chunks.get(assetId);
      if (!map) return new Float32Array(0);
      const out = new Float32Array(lengthSamples);
      let written = 0;
      const startBlock = Math.floor(startSample / blockSizeSamples);
      const endBlock = Math.floor((startSample + lengthSamples - 1) / blockSizeSamples);
      for (let b = startBlock; b <= endBlock; b++) {
        const blk = map.get(b);
        if (!blk) continue;
        const blkStart = b * blockSizeSamples;
        const from = Math.max(0, startSample - blkStart);
        const to = Math.min(blk.length, startSample + lengthSamples - blkStart);
        if (to > from) {
          out.set(blk.subarray(from, to), written);
          written += to - from;
        }
      }
      return out.subarray(0, written);
    },
  };

  return {
    broker,
    getCounts: () => ({
      beginCalls,
      writeCalls,
      finalizeCalls,
      abortCalls,
      readyManifestCalls,
    }),
    setTelemetry: (patch) => {
      telemetryState = { ...telemetryState, ...patch };
    },
    setDisposed: (val) => {
      disposed = val;
    },
    getManifest: (assetId) => manifests.get(assetId),
  };
}

test('1. Upload triggered before broker initialization resolves awaits barrier and never reads stale pre-init telemetry', async () => {
  const { file, totalSamples } = createDeterministicWavFile(2.5, 16_000, 'delayed-init.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  // Start with stale pre-init telemetry reporting OPFS-Unavailable
  const ctrl = createControlledBroker({
    initialOpfsAvailable: false,
    backend: 'OPFS-Unavailable',
  });

  let resolveInit!: (t: StorageBrokerTelemetry) => void;
  const brokerReady = new Promise<StorageBrokerTelemetry>((resolve) => {
    resolveInit = resolve;
  });

  const importPromise = importAudioProject(file, {
    broker: ctrl.broker,
    brokerReady,
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });

  // Yield a few ticks: ingest MUST NOT have begun while brokerReady is still pending
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctrl.getCounts().beginCalls, 0);
  assert.equal(ctrl.getCounts().writeCalls, 0);

  // Complete broker initialization with OPFS-SyncAccessHandle enabled
  ctrl.setTelemetry({
    opfsSupported: true,
    syncAccessHandleSupported: true,
    persistenceAvailable: true,
    persistenceStatus: 'OPFS-SyncAccessHandle',
  });
  resolveInit(ctrl.broker.getTelemetry());

  const loaded = await importPromise;
  const assetId = Object.keys(loaded.assets)[0];
  const asset = loaded.assets[assetId];

  assert.equal(ctrl.getCounts().beginCalls, 1);
  assert.equal(ctrl.getCounts().writeCalls, 3);
  assert.equal(ctrl.getCounts().finalizeCalls, 1);
  assert.equal(asset.storageLifecycle, 'ready');
  assert.equal(asset.storageBackend, 'OPFS-SyncAccessHandle');
  assert.equal(loaded.pcmSources[assetId]?.length, totalSamples);
  assert.ok(loaded.runtimeResourceLease);

  loaded.runtimeResourceLease.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('2. OPFS-available upload with retainActivePcmMirror=true persists blocks, verifies manifest, and reserves single budgeted PCM mirror', async () => {
  const { file, samples, totalSamples } = createDeterministicWavFile(2.5, 16_000, 'opfs-mirror.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({
    initialOpfsAvailable: true,
    backend: 'OPFS-SyncAccessHandle',
  });

  const loaded = await importAudioProject(file, {
    broker: ctrl.broker,
    brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  const asset = loaded.assets[assetId];
  const expectedMirrorBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  const oneChunkBytes = 16_000 * Float32Array.BYTES_PER_ELEMENT;

  assert.equal(asset.storageLifecycle, 'ready');
  assert.equal(asset.storageBackend, 'OPFS-SyncAccessHandle');
  assert.equal(ctrl.getCounts().beginCalls, 1);
  assert.equal(ctrl.getCounts().writeCalls, 3);
  assert.equal(ctrl.getCounts().finalizeCalls, 1);

  const mirror = loaded.pcmSources[assetId];
  assert.ok(mirror instanceof Float32Array);
  assert.equal(mirror.length, totalSamples);
  assert.ok(Math.abs(mirror[1000] - samples[1000]) < 1e-3);
  assert.ok(Math.abs(mirror[totalSamples - 10] - samples[totalSamples - 10]) < 1e-3);

  // Exact RAM accounting: single resident mirror + at most 1 transient chunk (OPFS disk size NOT double-counted)
  const snap = budget.getSnapshot();
  assert.equal(snap.accountedBytes, expectedMirrorBytes);
  assert.equal(snap.highWaterMarkBytes, expectedMirrorBytes + oneChunkBytes);
  assert.equal(snap.reservationCount, 1);
  assert.ok(loaded.runtimeResourceLease && !loaded.runtimeResourceLease.disposed);

  loaded.runtimeResourceLease.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('3. OPFS-available upload with retainActivePcmMirror=false persists cleanly with zero resident PCM or lingering reservations', async () => {
  const { file } = createDeterministicWavFile(2.5, 16_000, 'opfs-no-mirror.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({
    initialOpfsAvailable: true,
    backend: 'OPFS-Writable',
  });

  const loaded = await importAudioProject(file, {
    broker: ctrl.broker,
    brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: false,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  assert.equal(loaded.assets[assetId].storageLifecycle, 'ready');
  assert.equal(loaded.assets[assetId].storageBackend, 'OPFS-Writable');
  assert.equal(loaded.pcmSources[assetId], undefined);
  assert.equal(loaded.runtimeResourceLease, undefined);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('4. Upload with OPFS unavailable uses honest memory-only fallback and never claims ready persistence', async () => {
  const { file, totalSamples } = createDeterministicWavFile(2.0, 16_000, 'no-opfs.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({
    initialOpfsAvailable: false,
    backend: 'OPFS-Unavailable',
  });

  const loaded = await importAudioProject(file, {
    broker: ctrl.broker,
    brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  const asset = loaded.assets[assetId];
  assert.equal(ctrl.getCounts().beginCalls, 0);
  assert.notEqual(asset.storageLifecycle, 'ready');
  assert.notEqual(asset.storageBackend, 'OPFS-SyncAccessHandle');
  assert.notEqual(asset.storageBackend, 'OPFS-Writable');
  assert.equal(loaded.pcmSources[assetId]?.length, totalSamples);
  assert.ok(loaded.runtimeResourceLease);
  assert.equal(budget.getSnapshot().accountedBytes, totalSamples * 4);

  loaded.runtimeResourceLease.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('5. Rejected broker initialization never produces false persistence and falls back safely to memory-only mode', async () => {
  const { file, totalSamples } = createDeterministicWavFile(1.5, 16_000, 'init-rejected.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({
    initialOpfsAvailable: true,
    backend: 'OPFS-SyncAccessHandle',
  });

  const rejectedInit = Promise.reject<StorageBrokerTelemetry>(new Error('Worker spawn failed'));

  const loaded = await importAudioProject(file, {
    broker: ctrl.broker,
    brokerReady: rejectedInit,
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  const asset = loaded.assets[assetId];
  assert.equal(ctrl.getCounts().beginCalls, 0);
  assert.notEqual(asset.storageLifecycle, 'ready');
  assert.equal(asset.storageBackend, 'Memory-Bounded-Fallback');
  assert.equal(loaded.pcmSources[assetId]?.length, totalSamples);
  assert.ok(loaded.runtimeResourceLease);

  loaded.runtimeResourceLease.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('6 & 7. Disposed broker before upload or mid-upload fails closed with zero memory leaks', async () => {
  const { file } = createDeterministicWavFile(3.0, 16_000, 'disposed-broker.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  // Case A: Disposed before upload starts
  const preDisposed = createControlledBroker({ initialOpfsAvailable: true });
  preDisposed.setDisposed(true);

  await assert.rejects(
    () =>
      importAudioProject(file, {
        broker: preDisposed.broker,
        brokerReady: Promise.resolve(preDisposed.broker.getTelemetry()),
        memoryBudgetManager: budget,
        retainActivePcmMirror: true,
        chunkSeconds: 1,
      }),
    (err: unknown) =>
      err instanceof AudioImportCoordinatorError && err.code === 'IMPORT_BROKER_DISPOSED',
  );
  assert.equal(preDisposed.getCounts().beginCalls, 0);
  assert.equal(budget.getSnapshot().accountedBytes, 0);

  // Case B: Disposed mid-upload during chunk #1 write
  const midDisposed = createControlledBroker({
    initialOpfsAvailable: true,
    disposeOnChunkIndex: 1,
  });

  await assert.rejects(() =>
    importAudioProject(file, {
      broker: midDisposed.broker,
      brokerReady: Promise.resolve(midDisposed.broker.getTelemetry()),
      memoryBudgetManager: budget,
      retainActivePcmMirror: true,
      chunkSeconds: 1,
    }),
  );
  assert.equal(midDisposed.getCounts().finalizeCalls, 0);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('8. Partial OPFS chunk failure aborts transaction and releases resident PCM mirror reservation', async () => {
  const { file } = createDeterministicWavFile(3.0, 16_000, 'partial-chunk-fail.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({
    initialOpfsAvailable: true,
    failOnChunkIndex: 1,
  });

  await assert.rejects(
    () =>
      importAudioProject(file, {
        broker: ctrl.broker,
        brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
        memoryBudgetManager: budget,
        retainActivePcmMirror: true,
        chunkSeconds: 1,
      }),
    (err: unknown) =>
      err instanceof IngestTransactionError && err.code === 'INGEST_CHUNK_PERSISTENCE_FAILED',
  );

  assert.equal(ctrl.getCounts().abortCalls, 1);
  assert.equal(ctrl.getCounts().finalizeCalls, 0);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('9-15. Manifest validation rejects null, non-ready, SHA-256, totalSamples, totalBlocks, bytesPerSample, and blockSizeSamples mismatches with zero memory leaks', async () => {
  const { file } = createDeterministicWavFile(2.0, 16_000, 'manifest-tamper.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  const cases: Array<{
    name: string;
    mutate: (m: PersistedAudioAssetManifest | null) => PersistedAudioAssetManifest | null;
  }> = [
    { name: 'missing manifest (null)', mutate: () => null },
    {
      name: 'non-ready state',
      mutate: (m) => (m ? { ...m, state: 'finalizing' } : null),
    },
    {
      name: 'contentSha256 mismatch',
      mutate: (m) => (m ? { ...m, contentSha256: 'sha256:0000000000000000' } : null),
    },
    {
      name: 'totalSamples mismatch',
      mutate: (m) => (m ? { ...m, totalSamples: m.totalSamples - 1 } : null),
    },
    {
      name: 'totalBlocks mismatch',
      mutate: (m) => (m ? { ...m, totalBlocks: m.totalBlocks + 1 } : null),
    },
    {
      name: 'bytesPerSample mismatch',
      mutate: (m) => (m ? { ...m, bytesPerSample: 2 } : null),
    },
    {
      name: 'blockSizeSamples mismatch',
      mutate: (m) => (m ? { ...m, blockSizeSamples: m.blockSizeSamples + 64 } : null),
    },
  ];

  for (const tc of cases) {
    // Test both in-ingest validation (call #1) and coordinator defense-in-depth (call #2)
    for (const tamperOnCall of [1, 2]) {
      const ctrl = createControlledBroker({
        initialOpfsAvailable: true,
        onGetReadyManifest: (_id, stored, callIndex) =>
          callIndex === tamperOnCall ? tc.mutate(stored) : stored,
      });

      await assert.rejects(
        () =>
          importAudioProject(file, {
            broker: ctrl.broker,
            brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
            memoryBudgetManager: budget,
            retainActivePcmMirror: true,
            chunkSeconds: 1,
          }),
        (err: unknown) =>
          (err instanceof IngestTransactionError &&
            err.code === 'INGEST_MANIFEST_VALIDATION_FAILED') ||
          (err instanceof AudioImportCoordinatorError && err.code === 'IMPORT_MANIFEST_INVALID'),
        `Expected manifest validation failure for "${tc.name}" on call #${tamperOnCall}`,
      );

      assert.equal(
        budget.getSnapshot().accountedBytes,
        0,
        `Leaked memory after "${tc.name}" (call #${tamperOnCall})`,
      );
      assert.equal(budget.getSnapshot().reservationCount, 0);
    }
  }
});

test('16. Active PCM mirror exceeding MemoryBudgetManager rejects with MemoryPressureError before touching OPFS and preserves previous project', async () => {
  const { file, totalSamples } = createDeterministicWavFile(2.0, 16_000, 'over-budget.wav');
  const requiredBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  // Set budget strictly below resident mirror bytes
  const tightBudget = new MemoryBudgetManager(makeTightPolicy(Math.floor(requiredBytes * 0.5)));
  const ctrl = createControlledBroker({ initialOpfsAvailable: true });

  await assert.rejects(
    () =>
      importAudioProject(file, {
        broker: ctrl.broker,
        brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
        memoryBudgetManager: tightBudget,
        retainActivePcmMirror: true,
        chunkSeconds: 1,
      }),
    (err: unknown) => err instanceof MemoryPressureError,
  );

  // Because memory reservation occurs BEFORE beginAssetIngest, OPFS was never even dirtied
  assert.equal(ctrl.getCounts().beginCalls, 0);
  assert.equal(tightBudget.getSnapshot().accountedBytes, 0);
  assert.equal(tightBudget.getSnapshot().reservationCount, 0);
});

test('17. Sequential imports replace project lease atomically and release first project memory reservation exactly once', async () => {
  const first = createDeterministicWavFile(1.5, 16_000, 'project-a.wav');
  const second = createDeterministicWavFile(2.25, 16_000, 'project-b.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({ initialOpfsAvailable: true });
  const leaseSlot = new ProjectResourceLeaseSlot();

  const projA = await importAudioProject(first.file, {
    broker: ctrl.broker,
    brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });
  leaseSlot.replaceWith(projA.runtimeResourceLease ?? null);
  assert.equal(budget.getSnapshot().accountedBytes, first.totalSamples * 4);
  assert.equal(projA.runtimeResourceLease?.disposed, false);

  const projB = await importAudioProject(second.file, {
    broker: ctrl.broker,
    brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });
  leaseSlot.replaceWith(projB.runtimeResourceLease ?? null);

  assert.equal(projA.runtimeResourceLease?.disposed, true);
  assert.equal(projB.runtimeResourceLease?.disposed, false);
  assert.equal(budget.getSnapshot().accountedBytes, second.totalSamples * 4);
  assert.equal(budget.getSnapshot().reservationCount, 1);

  leaseSlot.clear();
  assert.equal(projB.runtimeResourceLease?.disposed, true);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('18. Abort while waiting for broker init or mid-ingest rejects with IngestAbortedError, aborts OPFS, and leaks zero memory', async () => {
  const { file } = createDeterministicWavFile(3.0, 16_000, 'abortable.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  // Case A: Abort while waiting on pending brokerReady
  const ctrlA = createControlledBroker({ initialOpfsAvailable: true });
  const abortA = new AbortController();
  const neverResolves = new Promise<StorageBrokerTelemetry>(() => {});
  const pA = importAudioProject(file, {
    broker: ctrlA.broker,
    brokerReady: neverResolves,
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    abortSignal: abortA.signal,
    chunkSeconds: 1,
  });
  abortA.abort();
  await assert.rejects(() => pA, (err: unknown) => err instanceof IngestAbortedError);
  assert.equal(ctrlA.getCounts().beginCalls, 0);
  assert.equal(budget.getSnapshot().accountedBytes, 0);

  // Case B: Abort mid-ingest after chunk 0 write
  const ctrlB = createControlledBroker({
    initialOpfsAvailable: true,
    onWriteChunkDelayMs: 15,
  });
  const abortB = new AbortController();
  const pB = importAudioProject(file, {
    broker: ctrlB.broker,
    brokerReady: Promise.resolve(ctrlB.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    abortSignal: abortB.signal,
    chunkSeconds: 1,
    onProgress: (progress) => {
      if (progress.phase === 'persisting' && progress.chunkIndex === 0) {
        abortB.abort();
      }
    },
  });
  await assert.rejects(() => pB, (err: unknown) => err instanceof IngestAbortedError);
  assert.equal(ctrlB.getCounts().abortCalls, 1);
  assert.equal(ctrlB.getCounts().finalizeCalls, 0);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('19. Regression: AudioImportCoordinator never calls ingestUploadedAudioFile() without supplying required options', async () => {
  const { file } = createDeterministicWavFile(1.5, 16_000, 'options-audit.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({
    initialOpfsAvailable: true,
    backend: 'OPFS-SyncAccessHandle',
  });
  const abortController = new AbortController();
  const progressEvents: number[] = [];
  let capturedOptions: StreamingIngestOptions | undefined;

  const spyIngest: typeof ingestUploadedAudioFile = (f, opts) => {
    capturedOptions = opts;
    return ingestUploadedAudioFile(f, opts);
  };

  const loaded = await importAudioProject(file, {
    broker: ctrl.broker,
    brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    abortSignal: abortController.signal,
    onProgress: (p) => progressEvents.push(p.percent),
    chunkSeconds: 1,
    ingestFn: spyIngest,
  });

  assert.ok(capturedOptions, 'ingestUploadedAudioFile must receive an options object');
  assert.equal(capturedOptions.broker, ctrl.broker);
  assert.equal(capturedOptions.memoryBudgetManager, budget);
  assert.equal(capturedOptions.retainResidentPcmMirror, true);
  assert.equal(capturedOptions.retainFallbackWhenOpfsUnavailable, false);
  assert.equal(capturedOptions.abortSignal, abortController.signal);
  assert.equal(typeof capturedOptions.onProgress, 'function');
  assert.ok(progressEvents.length > 0);

  loaded.runtimeResourceLease?.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('20. Empty file rejects cleanly with IMPORT_INVALID_FILE before touching broker or memory budget', async () => {
  const emptyFile = new File([], 'empty.wav', { type: 'audio/wav' });
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = createControlledBroker({ initialOpfsAvailable: true });

  await assert.rejects(
    () =>
      importAudioProject(emptyFile, {
        broker: ctrl.broker,
        brokerReady: Promise.resolve(ctrl.broker.getTelemetry()),
        memoryBudgetManager: budget,
        retainActivePcmMirror: true,
      }),
    (err: unknown) =>
      err instanceof AudioImportCoordinatorError && err.code === 'IMPORT_INVALID_FILE',
  );
  assert.equal(ctrl.getCounts().beginCalls, 0);
  assert.equal(budget.getSnapshot().accountedBytes, 0);

  // Direct invariant verifier sanity check
  assert.throws(
    () =>
      verifyReadyAssetManifestInvariants({
        asset: {
          id: 'a1',
          name: 'x.wav',
          contentHash: 'sha256:abc',
          partialFingerprint: 'fp',
          contentVersion: 1,
          fileSizeBytes: 100,
          container: 'wav',
          codec: 'wav-16bit',
          nativeSampleRate: 16_000,
          channelLayout: 'mono',
          exactSampleCount: 100,
          durationFlicks: 1,
          importTimestamp: 1,
          validationStatus: 'verified',
          seekTable: [],
          peakPyramid: { assetId: 'a1', sampleRate: 16_000, totalSamples: 100, levels: [] },
          acousticProfile: {
            assetId: 'a1',
            noiseFloorDbfs: -60,
            roomToneRms: 0.001,
            roomToneSample: new Float32Array(1),
            sampleRate: 16_000,
          },
        },
        manifest: null,
      }),
    (err: unknown) =>
      err instanceof AudioImportCoordinatorError && err.code === 'IMPORT_MANIFEST_INVALID',
  );
});
