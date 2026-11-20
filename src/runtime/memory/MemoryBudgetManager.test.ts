import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVAPARDAZ_AUDIO_CACHE_SPLIT,
  AVAPARDAZ_MEMORY_POLICY,
  measureTypedArrayListBackingBytes,
} from './MemoryPolicy';
import {
  InvalidMemoryReservationError,
  MemoryBudgetManager,
  MemoryPressureError,
} from './MemoryBudgetManager';

const MiB = 1024 * 1024;

test('MemoryPolicy defines canonical integer byte thresholds and 32 MiB cache split', () => {
  assert.equal(AVAPARDAZ_MEMORY_POLICY.hardLimitBytes, 1024 * MiB);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.targetBytes, 850 * MiB);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.throttleBytes, 900 * MiB);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.emergencyBytes, 950 * MiB);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.audioCacheBytes, 32 * MiB);
  assert.equal(
    AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes + AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes,
    AVAPARDAZ_MEMORY_POLICY.audioCacheBytes,
  );
});

test('MemoryBudgetManager handles reservation, single-once release, double release, and high-water mark', () => {
  const mgr = new MemoryBudgetManager();

  const r1 = mgr.reserve({
    owner: 'asr-window-0',
    category: 'asr-input-windows',
    bytes: 100 * MiB,
  });
  const r2 = mgr.reserve({
    owner: 'asr-features-0',
    category: 'asr-feature-buffers',
    bytes: 50 * MiB,
  });

  let snap = mgr.getSnapshot();
  assert.equal(snap.accountedBytes, 150 * MiB);
  assert.equal(snap.reservationCount, 2);
  assert.equal(snap.highWaterMarkBytes, 150 * MiB);
  assert.equal(snap.byCategory['asr-input-windows'], 100 * MiB);
  assert.equal(snap.byCategory['asr-feature-buffers'], 50 * MiB);

  assert.equal(mgr.release(r1), true);
  // Double release must return false and not corrupt accounting
  assert.equal(mgr.release(r1), false);
  assert.equal(mgr.release(r1.id), false);
  assert.equal(mgr.release('non-existent-id'), false);

  snap = mgr.getSnapshot();
  assert.equal(snap.accountedBytes, 50 * MiB);
  assert.equal(snap.reservationCount, 1);
  assert.equal(snap.highWaterMarkBytes, 150 * MiB);

  assert.equal(mgr.release(r2), true);
  snap = mgr.getSnapshot();
  assert.equal(snap.accountedBytes, 0);
  assert.equal(snap.reservationCount, 0);
  assert.equal(snap.highWaterMarkBytes, 150 * MiB);
});

test('MemoryBudgetManager rejects invalid reservation sizes and owners', () => {
  const mgr = new MemoryBudgetManager();
  const invalidSizes = [0, -1, -1024, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1];

  for (const badBytes of invalidSizes) {
    assert.throws(
      () =>
        mgr.reserve({
          owner: 'bad-size-task',
          category: 'other',
          bytes: badBytes,
        }),
      InvalidMemoryReservationError,
    );
  }

  assert.throws(
    () =>
      mgr.reserve({
        owner: '   ',
        category: 'other',
        bytes: 1024,
      }),
    InvalidMemoryReservationError,
  );

  assert.equal(mgr.getSnapshot().accountedBytes, 0);
});

test('MemoryBudgetManager transitions accurately across 850 MiB warning, 900 MiB throttle, 950 MiB emergency, and 1024 MiB hard limit', () => {
  const mgr = new MemoryBudgetManager();

  // Normal (< 850 MiB)
  const baseRes = mgr.reserve({
    owner: 'decoded-track-1',
    category: 'decoded-audio',
    bytes: 849 * MiB,
    protectedUserData: true,
    priority: 'protected',
  });
  assert.equal(mgr.getPressureLevel(), 'normal');
  assert.equal(mgr.canStartHeavyTask({ activeHeavyTasks: 1 }).allowed, true);

  // 850 MiB elevated/warning state
  const warnRes = mgr.reserve({
    owner: 'warn-step',
    category: 'other',
    bytes: 1 * MiB,
  });
  assert.equal(mgr.getSnapshot().accountedBytes, 850 * MiB);
  assert.equal(mgr.getPressureLevel(), 'elevated');
  assert.equal(mgr.getSnapshot().throttled, false);

  // 900 MiB throttle state: disables optional prefetch, limits heavy tasks to 1
  const throttleRes = mgr.reserve({
    owner: 'throttle-step',
    category: 'model-runtime',
    bytes: 50 * MiB,
  });
  assert.equal(mgr.getSnapshot().accountedBytes, 900 * MiB);
  assert.equal(mgr.getPressureLevel(), 'throttle');
  let snap = mgr.getSnapshot();
  assert.equal(snap.throttled, true);
  assert.equal(snap.allowOptionalPrefetch, false);
  assert.equal(snap.recommendedMaxConcurrentHeavyTasks, 1);

  assert.equal(mgr.canStartHeavyTask({ activeHeavyTasks: 0 }).allowed, true);
  assert.equal(mgr.canStartHeavyTask({ activeHeavyTasks: 1 }).allowed, false);

  // 950 MiB emergency state
  const emergencyRes = mgr.reserve({
    owner: 'emergency-step',
    category: 'render-export-buffers',
    bytes: 50 * MiB,
  });
  assert.equal(mgr.getSnapshot().accountedBytes, 950 * MiB);
  assert.equal(mgr.getPressureLevel(), 'emergency');

  // Optional work must be rejected at emergency pressure
  assert.throws(
    () =>
      mgr.reserve({
        owner: 'optional-prefetch',
        category: 'audio-cache',
        bytes: 1 * MiB,
        priority: 'optional',
      }),
    MemoryPressureError,
  );
  assert.equal(mgr.canStartHeavyTask({ optional: true }).allowed, false);

  // Hard limit rejection (> 1024 MiB)
  assert.throws(
    () =>
      mgr.reserve({
        owner: 'too-big',
        category: 'asr-input-windows',
        bytes: 75 * MiB,
      }),
    MemoryPressureError,
  );

  // Exactly up to 1024 MiB is allowed for non-optional critical allocation
  const maxFit = mgr.reserve({
    owner: 'exact-fit',
    category: 'asr-input-windows',
    bytes: 74 * MiB,
  });
  assert.equal(mgr.getSnapshot().accountedBytes, 1024 * MiB);

  // Protected reservation must remain intact across emergency pressure
  const active = mgr.listActiveReservations();
  assert.ok(active.some((r) => r.id === baseRes.id && r.protectedUserData === true));

  mgr.release(maxFit);
  mgr.release(emergencyRes);
  mgr.release(throttleRes);
  mgr.release(warnRes);
  mgr.release(baseRes);
});

test('MemoryBudgetManager triggers cache eviction callbacks at emergency threshold without evicting protected user data', () => {
  const mgr = new MemoryBudgetManager();

  const userAudio = mgr.reserve({
    owner: 'user-podcast-audio',
    category: 'decoded-audio',
    bytes: 930 * MiB,
    priority: 'protected',
    protectedUserData: true,
  });

  let cacheReservation: ReturnType<MemoryBudgetManager['reserve']> | null = mgr.reserve({
    owner: 'lru-cache-pool',
    category: 'audio-cache',
    bytes: 24 * MiB,
    priority: 'optional',
  });

  let callbackCalls = 0;
  mgr.registerCacheEvictionCallback((ctx) => {
    callbackCalls++;
    assert.equal(ctx.pressureLevel, 'emergency');
    if (cacheReservation) {
      mgr.release(cacheReservation);
      cacheReservation = null;
    }
  });

  // Accounted = 954 MiB (emergency). Reserving 20 MiB optional should trigger cache eviction,
  // bringing accounted down to 930 MiB (throttle, below emergency) and admitting or cleanly evaluating.
  const newRes = mgr.reserve({
    owner: 'asr-window',
    category: 'asr-input-windows',
    bytes: 16 * MiB,
    priority: 'normal',
  });

  assert.equal(callbackCalls, 1);
  assert.equal(cacheReservation, null);
  assert.equal(mgr.getSnapshot().evictionTriggerCount, 1);
  assert.equal(mgr.getSnapshot().accountedBytes, 946 * MiB);

  // Protected user data reservation MUST still be active
  assert.ok(mgr.listActiveReservations().some((r) => r.id === userAudio.id));

  mgr.release(newRes);
  mgr.release(userAudio);
});

test('MemoryBudgetManager reports honest JS heap availability and disposes cleanly/idempotently', () => {
  const mgr = new MemoryBudgetManager();
  mgr.reserve({ owner: 'temp', category: 'other', bytes: 1024 });

  const snapBefore = mgr.getSnapshot();
  assert.equal(typeof snapBefore.browserJsHeap.available, 'boolean');
  if (!snapBefore.browserJsHeap.available) {
    assert.equal(snapBefore.browserJsHeap.usedJSHeapSizeBytes, null);
    assert.equal(snapBefore.browserJsHeap.totalJSHeapSizeBytes, null);
    assert.equal(snapBefore.browserJsHeap.jsHeapSizeLimitBytes, null);
  }

  mgr.dispose();
  // Repeated dispose must be a safe no-op
  mgr.dispose();

  const snapAfter = mgr.getSnapshot();
  assert.equal(snapAfter.disposed, true);
  assert.equal(snapAfter.accountedBytes, 0);
  assert.equal(snapAfter.reservationCount, 0);
  assert.equal(mgr.canStartHeavyTask().allowed, false);

  assert.throws(() => mgr.reserve({ owner: 'after-dispose', category: 'other', bytes: 1024 }));
});

test('measureTypedArrayListBackingBytes captures subarray backing retention and rejects SharedArrayBuffer conservatively', () => {
  const bigBacking = new Float32Array(10_000); // 40,000 bytes
  const smallSlice = bigBacking.subarray(100, 110); // 40 bytes visible view
  assert.equal(smallSlice.byteLength, 40);
  assert.equal(measureTypedArrayListBackingBytes([smallSlice]), 40_000);

  // Multi-channel views sharing one backing ArrayBuffer count the backing buffer once
  const sharedPlanar = new Float32Array(2048); // 8,192 bytes
  const ch0 = sharedPlanar.subarray(0, 1024);
  const ch1 = sharedPlanar.subarray(1024, 2048);
  assert.equal(measureTypedArrayListBackingBytes([ch0, ch1]), 8192);

  if (typeof SharedArrayBuffer !== 'undefined') {
    const sab = new SharedArrayBuffer(4096);
    const view = new Float32Array(sab);
    assert.equal(measureTypedArrayListBackingBytes([view]), null);
  }
});

test('MT-07: Duplicate active allocation ID is rejected without mutating accounted bytes', async () => {
  const { DuplicateMemoryAllocationIdError } = await import('./MemoryBudgetManager');
  const mgr = new MemoryBudgetManager();
  const r1 = mgr.reserve({
    id: 'chunk-window-001',
    owner: 'ingest-worker',
    category: 'decoded-audio',
    bytes: 4 * MiB,
  });
  assert.equal(r1.id, 'chunk-window-001');
  assert.equal(mgr.getUsedBytes(), 4 * MiB);

  assert.throws(
    () =>
      mgr.reserve({
        id: 'chunk-window-001',
        owner: 'ingest-worker',
        category: 'decoded-audio',
        bytes: 4 * MiB,
      }),
    DuplicateMemoryAllocationIdError,
  );
  assert.equal(mgr.getUsedBytes(), 4 * MiB);
  assert.equal(mgr.getCategoryUsage('decoded-audio'), 4 * MiB);

  // After release, reusing the same ID is valid
  assert.equal(mgr.release('chunk-window-001'), true);
  assert.equal(mgr.getUsedBytes(), 0);
  const r2 = mgr.reserve({
    id: 'chunk-window-001',
    owner: 'ingest-worker',
    category: 'decoded-audio',
    bytes: 2 * MiB,
  });
  assert.equal(mgr.getUsedBytes(), 2 * MiB);
  mgr.release(r2);
});

test('MT-08 & MT-09: Double release and unknown ID release never cause negative underflow', () => {
  const mgr = new MemoryBudgetManager();
  const res = mgr.reserve({
    id: 'audio-block-1',
    owner: 'cache',
    category: 'audio-cache',
    bytes: 8 * MiB,
  });
  assert.equal(mgr.release(res), true);
  assert.equal(mgr.release(res), false);
  assert.equal(mgr.release('audio-block-1'), false);
  assert.equal(mgr.release('does-not-exist'), false);
  assert.equal(mgr.getUsedBytes(), 0);
  assert.equal(mgr.getCategoryUsage('audio-cache'), 0);
});

test('MT-11, MT-12 & MT-13: Concurrent allocations, worker release reconciliation, and cancellation cleanup leave zero leaks', async () => {
  const mgr = new MemoryBudgetManager();
  const workers = Array.from({ length: 16 }, (_, idx) =>
    Promise.resolve().then(() => {
      const res = mgr.reserve({
        id: `worker-task-${idx}`,
        owner: idx % 2 === 0 ? 'io-worker' : 'export-worker',
        category: idx % 2 === 0 ? 'decoded-audio' : 'render-export-buffers',
        bytes: 16 * MiB,
        releasable: true,
      });
      return res;
    }),
  );

  const reservations = await Promise.all(workers);
  assert.equal(mgr.getUsedBytes(), 16 * 16 * MiB);
  assert.equal(mgr.getActiveAllocations().length, 16);

  // Worker release reconciliation (MT-12): release all io-worker reservations atomically
  const reclaimedIo = mgr.releaseByOwner('io-worker');
  assert.equal(reclaimedIo, 8 * 16 * MiB);
  assert.equal(mgr.getCategoryUsage('decoded-audio'), 0);

  // Cancellation cleanup (MT-13): simulate aborted export releasing remaining allocations
  for (const res of reservations) {
    mgr.release(res);
  }
  assert.equal(mgr.getUsedBytes(), 0);
  assert.equal(mgr.getActiveAllocations().length, 0);
});

test('MT-14: Leak detection surfaces unreleased allocations older than threshold deterministically', () => {
  let fakeNow = 1_000_000;
  const mgr = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY, { now: () => fakeNow });

  const oldRes = mgr.reserve({
    id: 'stale-buffer',
    owner: 'stuck-task',
    category: 'asr-feature-buffers',
    bytes: 12 * MiB,
  });

  fakeNow += 60_000;
  const freshRes = mgr.reserve({
    id: 'fresh-buffer',
    owner: 'active-task',
    category: 'asr-input-windows',
    bytes: 4 * MiB,
  });

  fakeNow += 5_000;
  const leaks = mgr.detectLeaks(30_000);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].reservation.id, oldRes.id);
  assert.equal(leaks[0].ageMs, 65_000);

  mgr.release(oldRes);
  mgr.release(freshRes);
  assert.equal(mgr.detectLeaks(0).length, 0);
});

