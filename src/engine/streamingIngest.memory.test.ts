import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVAPARDAZ_MEMORY_POLICY,
  MemoryPolicyConfig,
} from '../runtime/memory/MemoryPolicy';
import {
  MemoryBudgetManager,
  MemoryPressureError,
} from '../runtime/memory/MemoryBudgetManager';
import { encodeAndValidateWavExport } from './storageBroker';
import {
  computeSafeDecodedSampleBytes,
  computeSafeResidentPcmBytes,
  IngestAbortedError,
  ingestAudioFileStreaming,
  ProjectResourceLeaseSlot,
} from './streamingIngest';
import { buildDefaultPersianPodcastProject } from './audioFixtures';

function createWavFileFromSamples(
  samples: Float32Array,
  sampleRate: number,
  fileName = 'memory-test.wav',
): File {
  const encoded = encodeAndValidateWavExport([samples], sampleRate);
  return new File([encoded.blob], fileName, { type: 'audio/wav' });
}

function createSyntheticMp3File(sizeBytes: number, fileName = 'compressed-test.mp3'): File {
  const bytes = new Uint8Array(Math.max(64, sizeBytes));
  // Valid ID3v2 header magic ("ID3") so AudioSecurityGuard identifies MP3 cleanly
  bytes[0] = 0x49; // 'I'
  bytes[1] = 0x44; // 'D'
  bytes[2] = 0x33; // '3'
  bytes[3] = 0x04;
  bytes[4] = 0x00;
  for (let i = 16; i < Math.min(bytes.length, 4096); i++) {
    bytes[i] = (i * 37) & 0xff;
  }
  return new File([bytes], fileName, { type: 'audio/mpeg' });
}

function makeTightPolicy(hardLimitBytes: number): MemoryPolicyConfig {
  return {
    hardLimitBytes,
    emergencyBytes: Math.max(1, Math.floor(hardLimitBytes * 0.92)),
    throttleBytes: Math.max(1, Math.floor(hardLimitBytes * 0.87)),
    targetBytes: Math.max(1, Math.floor(hardLimitBytes * 0.82)),
    audioCacheBytes: Math.max(1, Math.min(32 * 1024 * 1024, Math.floor(hardLimitBytes * 0.25))),
  };
}

test('1. Small WAV fallback import produces exactly one resident PCM source with no duplicate full allocation', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 2; // 2s = 32,000 samples = 128,000 bytes
  const pcm = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.4;
  }
  const file = createWavFileFromSamples(pcm, sampleRate, 'small-fallback.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  const loaded = await ingestAudioFileStreaming(file, {
    memoryBudgetManager: budget,
    chunkSeconds: 1,
  });

  const assetIds = Object.keys(loaded.pcmSources);
  assert.equal(assetIds.length, 1);
  const assetId = assetIds[0];
  const resident = loaded.pcmSources[assetId];
  assert.ok(resident instanceof Float32Array);
  assert.equal(resident.length, totalSamples);
  assert.ok(Math.abs(resident[500] - pcm[500]) < 1e-3);
  assert.ok(loaded.runtimeResourceLease, 'Expected runtimeResourceLease on fallback project');
  assert.equal(loaded.runtimeResourceLease.disposed, false);

  // High-water mark must be single resident PCM + 1 transient chunk (never ~2x resident PCM)
  const expectedResidentBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  const oneChunkBytes = sampleRate * 1 * Float32Array.BYTES_PER_ELEMENT;
  const snap = budget.getSnapshot();
  assert.equal(snap.accountedBytes, expectedResidentBytes);
  assert.equal(snap.highWaterMarkBytes, expectedResidentBytes + oneChunkBytes);

  loaded.runtimeResourceLease.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('2. Multi-block WAV fallback preserves exact contiguous sample ordering across block boundaries', async () => {
  const sampleRate = 16_000;
  const totalSamples = Math.round(sampleRate * 4.5); // 4.5s -> 5 blocks (4 x 1s + 1 x 0.5s)
  const pcm = new Float32Array(totalSamples);
  // Unique monotonic ramp per sample so any out-of-order or shifted block write is immediately caught
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = ((i / totalSamples) * 1.8) - 0.9;
  }
  const file = createWavFileFromSamples(pcm, sampleRate, 'multi-block-ramp.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  const loaded = await ingestAudioFileStreaming(file, {
    memoryBudgetManager: budget,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  const resident = loaded.pcmSources[assetId];
  assert.equal(resident.length, totalSamples);

  const probeIndexes = [
    0,
    1,
    15_999,
    16_000,
    16_001,
    31_999,
    32_000,
    47_999,
    48_000,
    63_999,
    64_000,
    totalSamples - 2,
    totalSamples - 1,
  ];
  for (const idx of probeIndexes) {
    assert.ok(
      Math.abs(resident[idx] - pcm[idx]) < 2e-4,
      `Sample mismatch at index ${idx}: got ${resident[idx]}, expected ${pcm[idx]}`,
    );
  }

  loaded.runtimeResourceLease?.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('3 & 4. Resident PCM reservation equals exact totalSamples x 4 bytes and remains active after ingestion', async () => {
  const sampleRate = 16_000;
  const totalSamples = 40_321; // Non-aligned sample count
  const pcm = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = Math.sin(i * 0.05) * 0.25;
  }
  const file = createWavFileFromSamples(pcm, sampleRate, 'exact-bytes.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  const loaded = await ingestAudioFileStreaming(file, {
    memoryBudgetManager: budget,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  const expectedBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  const snap = budget.getSnapshot();
  const active = budget.listActiveReservations();

  assert.equal(snap.accountedBytes, expectedBytes);
  assert.equal(snap.byCategory['decoded-audio'], expectedBytes);
  assert.equal(snap.byCategory['render-export-buffers'], 0);
  assert.equal(snap.reservationCount, 1);
  assert.equal(active.length, 1);
  assert.equal(active[0].owner, `streaming-ingest:${assetId}:resident-pcm`);
  assert.equal(active[0].category, 'decoded-audio');
  assert.equal(active[0].bytes, expectedBytes);
  assert.equal(active[0].priority, 'protected');
  assert.equal(active[0].protectedUserData, true);
  assert.equal(loaded.runtimeResourceLease?.disposed, false);

  loaded.runtimeResourceLease?.dispose();
});

test('5 & 6. Project lease disposal releases reservation and repeated disposal causes zero double-release', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 2;
  const file = createWavFileFromSamples(new Float32Array(totalSamples), sampleRate, 'lease-dispose.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  // Add an unrelated reservation to ensure repeated disposal cannot perturb other reservations
  const unrelated = budget.reserve({
    owner: 'unrelated-active-subsystem',
    category: 'other',
    bytes: 65_536,
    priority: 'normal',
  });

  const loaded = await ingestAudioFileStreaming(file, {
    memoryBudgetManager: budget,
    chunkSeconds: 1,
  });

  const residentBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  assert.equal(budget.getSnapshot().accountedBytes, 65_536 + residentBytes);
  assert.equal(loaded.runtimeResourceLease?.disposed, false);

  // First disposal releases resident PCM reservation
  loaded.runtimeResourceLease?.dispose();
  assert.equal(loaded.runtimeResourceLease?.disposed, true);
  assert.equal(budget.getSnapshot().accountedBytes, 65_536);
  assert.equal(budget.getSnapshot().reservationCount, 1);

  // Repeated disposals must be idempotent no-ops with zero double release
  loaded.runtimeResourceLease?.dispose();
  loaded.runtimeResourceLease?.dispose();
  assert.equal(loaded.runtimeResourceLease?.disposed, true);
  assert.equal(budget.getSnapshot().accountedBytes, 65_536);
  assert.equal(budget.getSnapshot().reservationCount, 1);

  budget.release(unrelated);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('7. Insufficient memory budget rejects BEFORE PCM allocation and preserves MemoryPressureError', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 10; // 160,000 samples => 640,000 bytes resident PCM
  const file = createWavFileFromSamples(new Float32Array(totalSamples), sampleRate, 'too-big.wav');
  const budget = new MemoryBudgetManager(makeTightPolicy(200_000)); // 200 KB hard limit < 640 KB

  await assert.rejects(
    ingestAudioFileStreaming(file, {
      memoryBudgetManager: budget,
      chunkSeconds: 2,
    }),
    (err: unknown) => {
      assert.ok(err instanceof MemoryPressureError, `Expected MemoryPressureError, got ${String(err)}`);
      assert.equal(err.code, 'MEMORY_PRESSURE_LIMIT');
      assert.equal(err.requestedBytes, totalSamples * Float32Array.BYTES_PER_ELEMENT);
      return true;
    },
  );

  // Zero reservations leaked and highWaterMark never admitted the 640 KB buffer
  const snap = budget.getSnapshot();
  assert.equal(snap.accountedBytes, 0);
  assert.equal(snap.reservationCount, 0);
  assert.equal(snap.highWaterMarkBytes, 0);
});

test('8. Aborted ingestion releases all temporary and resident reservations cleanly', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 5;
  const file = createWavFileFromSamples(new Float32Array(totalSamples), sampleRate, 'abort-mem.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const controller = new AbortController();

  await assert.rejects(
    ingestAudioFileStreaming(file, {
      memoryBudgetManager: budget,
      chunkSeconds: 1,
      abortSignal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'persisting' && p.chunkIndex === 1) {
          controller.abort();
        }
      },
    }),
    (err: unknown) => err instanceof IngestAbortedError,
  );

  const snap = budget.getSnapshot();
  assert.equal(snap.accountedBytes, 0);
  assert.equal(snap.reservationCount, 0);
});

test('9. Failed ingestion leaves zero leaked reservations', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 4;
  const file = createWavFileFromSamples(new Float32Array(totalSamples), sampleRate, 'fail-mem.wav');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  await assert.rejects(
    ingestAudioFileStreaming(file, {
      memoryBudgetManager: budget,
      chunkSeconds: 1,
      onProgress: (p) => {
        if (p.phase === 'persisting' && p.chunkIndex === 2) {
          throw new Error('INJECTED_INGEST_CALLBACK_FAILURE');
        }
      },
    }),
    /INJECTED_INGEST_CALLBACK_FAILURE/,
  );

  const snap = budget.getSnapshot();
  assert.equal(snap.accountedBytes, 0);
  assert.equal(snap.reservationCount, 0);
});

test('10, 11, 12 & 13. Compressed mono & stereo decoding enforce separate encoded, decoded, and resident PCM accounting and release encoded input immediately', async () => {
  // Case A: Compressed mono decoding
  {
    const encodedSize = 32_768;
    const sampleRate = 16_000;
    const length = sampleRate * 3; // 48,000 samples => 192,000 B decoded mono + 192,000 B resident mono
    const monoFile = createSyntheticMp3File(encodedSize, 'mono-compressed.mp3');
    const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

    let encodedReservedDuringDecode = false;
    let encodedStillPresentDuringPersisting = false;
    let decodedBytesDuringPersisting = 0;
    let residentBytesDuringPersisting = 0;

    const loaded = await ingestAudioFileStreaming(monoFile, {
      memoryBudgetManager: budget,
      chunkSeconds: 1,
      decodeCompressedAudioFn: async (buf) => {
        assert.equal(buf.byteLength, encodedSize);
        const active = budget.listActiveReservations();
        encodedReservedDuringDecode = active.some(
          (r) => r.owner.includes('encoded-input') && r.bytes === encodedSize,
        );
        const ch0 = new Float32Array(length);
        for (let i = 0; i < length; i++) ch0[i] = Math.sin(i * 0.02) * 0.3;
        return {
          sampleRate,
          numberOfChannels: 1,
          length,
          duration: length / sampleRate,
          getChannelData: () => ch0,
        };
      },
      onProgress: (p) => {
        if (p.phase === 'persisting' && p.chunkIndex === 0) {
          const active = budget.listActiveReservations();
          encodedStillPresentDuringPersisting = active.some((r) => r.owner.includes('encoded-input'));
          decodedBytesDuringPersisting =
            active.find((r) => r.owner.includes('decoded-buffer'))?.bytes ?? 0;
          residentBytesDuringPersisting =
            active.find((r) => r.owner.includes('resident-pcm'))?.bytes ?? 0;
        }
      },
    });

    assert.equal(encodedReservedDuringDecode, true, 'Encoded input must be reserved during decode');
    assert.equal(
      encodedStillPresentDuringPersisting,
      false,
      'Encoded input reservation must be released immediately after decode disposal',
    );
    assert.equal(decodedBytesDuringPersisting, length * 1 * Float32Array.BYTES_PER_ELEMENT);
    assert.equal(residentBytesDuringPersisting, length * Float32Array.BYTES_PER_ELEMENT);

    // After ingestion completes: decoded buffer released, ONLY resident PCM remains owned by project lease
    const snap = budget.getSnapshot();
    assert.equal(snap.accountedBytes, length * Float32Array.BYTES_PER_ELEMENT);
    assert.equal(snap.reservationCount, 1);
    assert.equal(loaded.runtimeResourceLease?.disposed, false);

    loaded.runtimeResourceLease?.dispose();
    assert.equal(budget.getSnapshot().accountedBytes, 0);
  }

  // Case B: Compressed stereo decoding (channel-aware 2x decoded payload accounting)
  {
    const encodedSize = 49_152;
    const sampleRate = 16_000;
    const length = sampleRate * 2; // 32,000 frames => stereo decoded = 256,000 B, resident mono = 128,000 B
    const stereoFile = createSyntheticMp3File(encodedSize, 'stereo-compressed.mp3');
    const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

    let decodedBytesDuringPersisting = 0;
    let residentBytesDuringPersisting = 0;
    let simultaneousDecodedCategoryBytes = 0;

    const loaded = await ingestAudioFileStreaming(stereoFile, {
      memoryBudgetManager: budget,
      chunkSeconds: 1,
      decodeCompressedAudioFn: async () => {
        const left = new Float32Array(length).fill(0.4);
        const right = new Float32Array(length).fill(0.2);
        return {
          sampleRate,
          numberOfChannels: 2,
          length,
          duration: length / sampleRate,
          getChannelData: (c) => (c === 0 ? left : right),
        };
      },
      onProgress: (p) => {
        if (p.phase === 'persisting' && p.chunkIndex === 0) {
          const active = budget.listActiveReservations();
          decodedBytesDuringPersisting =
            active.find((r) => r.owner.includes('decoded-buffer'))?.bytes ?? 0;
          residentBytesDuringPersisting =
            active.find((r) => r.owner.includes('resident-pcm'))?.bytes ?? 0;
          simultaneousDecodedCategoryBytes = budget.getSnapshot().byCategory['decoded-audio'];
        }
      },
    });

    const expectedStereoDecodedBytes = length * 2 * Float32Array.BYTES_PER_ELEMENT;
    const expectedResidentMonoBytes = length * Float32Array.BYTES_PER_ELEMENT;
    assert.equal(decodedBytesDuringPersisting, expectedStereoDecodedBytes);
    assert.equal(residentBytesDuringPersisting, expectedResidentMonoBytes);
    assert.equal(
      simultaneousDecodedCategoryBytes,
      expectedStereoDecodedBytes + expectedResidentMonoBytes,
    );

    // Mono fold verified: (0.4 + 0.2) / 2 = 0.3
    const assetId = Object.keys(loaded.assets)[0];
    assert.ok(Math.abs(loaded.pcmSources[assetId][100] - 0.3) < 1e-5);

    // Post-ingest: stereo decoded reservation released; only mono resident PCM remains
    assert.equal(budget.getSnapshot().accountedBytes, expectedResidentMonoBytes);
    assert.equal(budget.getSnapshot().reservationCount, 1);

    loaded.runtimeResourceLease?.dispose();
    assert.equal(budget.getSnapshot().accountedBytes, 0);
  }

  // Case C: Failed compressed decode releases encoded input reservation immediately
  {
    const encodedSize = 16_384;
    const brokenFile = createSyntheticMp3File(encodedSize, 'broken-decode.mp3');
    const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

    await assert.rejects(
      ingestAudioFileStreaming(brokenFile, {
        memoryBudgetManager: budget,
        decodeCompressedAudioFn: async () => {
          assert.equal(budget.getSnapshot().accountedBytes, encodedSize);
          throw new Error('DECODER_CORRUPT_FRAME');
        },
      }),
      /DECODER_CORRUPT_FRAME/,
    );
    assert.equal(budget.getSnapshot().accountedBytes, 0);
    assert.equal(budget.getSnapshot().reservationCount, 0);
  }
});

test('14, 15 & 16. Project replacement releases previous lease once, failed replacement protects existing project, and demo restoration releases imported reservation', async () => {
  const sampleRate = 16_000;
  const samplesA = sampleRate * 2; // 128,000 B
  const samplesB = sampleRate * 3; // 192,000 B
  const samplesTooBig = sampleRate * 10; // 640,000 B

  // Budget allows A (128 KB) + B (192 KB) + chunk (64 KB) = 384 KB, but rejects TooBig (640 KB)
  const budget = new MemoryBudgetManager(makeTightPolicy(500_000));
  const slot = new ProjectResourceLeaseSlot();

  // Import Project A
  const fileA = createWavFileFromSamples(new Float32Array(samplesA).fill(0.2), sampleRate, 'proj-a.wav');
  const projectA = await ingestAudioFileStreaming(fileA, {
    memoryBudgetManager: budget,
    chunkSeconds: 1,
  });
  slot.replaceWith(projectA.runtimeResourceLease);
  const bytesA = samplesA * Float32Array.BYTES_PER_ELEMENT;
  assert.equal(budget.getSnapshot().accountedBytes, bytesA);
  assert.equal(projectA.runtimeResourceLease?.disposed, false);

  // Failed replacement (TooBig rejected by MemoryBudgetManager): Project A & its reservation remain protected
  const fileTooBig = createWavFileFromSamples(
    new Float32Array(samplesTooBig),
    sampleRate,
    'proj-too-big.wav',
  );
  await assert.rejects(
    ingestAudioFileStreaming(fileTooBig, {
      memoryBudgetManager: budget,
      chunkSeconds: 1,
    }),
    (err: unknown) => err instanceof MemoryPressureError,
  );
  assert.equal(projectA.runtimeResourceLease?.disposed, false);
  assert.equal(slot.current, projectA.runtimeResourceLease);
  assert.equal(budget.getSnapshot().accountedBytes, bytesA);
  assert.equal(budget.getSnapshot().reservationCount, 1);

  // Successful replacement with Project B: Project A lease disposed exactly once; Project B becomes active
  const fileB = createWavFileFromSamples(new Float32Array(samplesB).fill(0.4), sampleRate, 'proj-b.wav');
  const projectB = await ingestAudioFileStreaming(fileB, {
    memoryBudgetManager: budget,
    chunkSeconds: 1,
  });
  slot.replaceWith(projectB.runtimeResourceLease);
  const bytesB = samplesB * Float32Array.BYTES_PER_ELEMENT;
  assert.equal(projectA.runtimeResourceLease?.disposed, true);
  assert.equal(projectB.runtimeResourceLease?.disposed, false);
  assert.equal(slot.current, projectB.runtimeResourceLease);
  assert.equal(budget.getSnapshot().accountedBytes, bytesB);
  assert.equal(budget.getSnapshot().reservationCount, 1);

  // Demo restoration clears imported Project B reservation cleanly
  const demoProject = buildDefaultPersianPodcastProject();
  slot.clear();
  assert.ok(demoProject.projectName.length > 0);
  assert.equal(projectB.runtimeResourceLease?.disposed, true);
  assert.equal(slot.current, null);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('17. Quantitative verification: 1, 10, 30, 60, and 120 min @ 48 kHz mono resident PCM bytes and 1,024 MiB policy enforcement', async () => {
  // Verify exact policy thresholds remain intact (no weakening of 1,024 MiB policy)
  assert.equal(AVAPARDAZ_MEMORY_POLICY.targetBytes, 850 * 1024 * 1024);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.throttleBytes, 900 * 1024 * 1024);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.emergencyBytes, 950 * 1024 * 1024);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.hardLimitBytes, 1024 * 1024 * 1024);
  assert.equal(AVAPARDAZ_MEMORY_POLICY.audioCacheBytes, 32 * 1024 * 1024);

  const sampleRate = 48_000;
  const matrix = [
    { minutes: 1, expectedBytes: 11_520_000, admitted: true },
    { minutes: 10, expectedBytes: 115_200_000, admitted: true },
    { minutes: 30, expectedBytes: 345_600_000, admitted: true },
    { minutes: 60, expectedBytes: 691_200_000, admitted: true },
    { minutes: 120, expectedBytes: 1_382_400_000, admitted: false },
  ] as const;

  for (const row of matrix) {
    const totalSamples = row.minutes * 60 * sampleRate;
    const computedBytes = computeSafeResidentPcmBytes(totalSamples);
    assert.equal(computedBytes, row.expectedBytes, `Byte mismatch for ${row.minutes} min @ 48kHz mono`);
    assert.equal(
      computeSafeDecodedSampleBytes(totalSamples, 1),
      row.expectedBytes,
    );

    const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
    if (row.admitted) {
      const res = budget.reserve({
        owner: `quant-${row.minutes}min`,
        category: 'decoded-audio',
        bytes: computedBytes,
        priority: 'protected',
        protectedUserData: true,
      });
      assert.equal(budget.getSnapshot().accountedBytes, row.expectedBytes);
      budget.release(res);
      assert.equal(budget.getSnapshot().accountedBytes, 0);
    } else {
      assert.throws(
        () =>
          budget.reserve({
            owner: `quant-${row.minutes}min`,
            category: 'decoded-audio',
            bytes: computedBytes,
            priority: 'protected',
            protectedUserData: true,
          }),
        MemoryPressureError,
      );
      assert.equal(budget.getSnapshot().accountedBytes, 0);
    }
  }

  // Real end-to-end 1-minute @ 48 kHz mono WAV import (11.52 MB exact single allocation, no 2x peak)
  {
    const totalSamples1Min = 60 * sampleRate; // 2,880,000 samples = 11,520,000 bytes
    const pcm1Min = new Float32Array(totalSamples1Min);
    for (let i = 0; i < totalSamples1Min; i += 480) {
      pcm1Min[i] = 0.25;
    }
    const file1Min = createWavFileFromSamples(pcm1Min, sampleRate, 'one-minute-48k.wav');
    const budget1Min = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

    const loaded = await ingestAudioFileStreaming(file1Min, {
      memoryBudgetManager: budget1Min,
      chunkSeconds: 4,
    });
    const assetId = Object.keys(loaded.assets)[0];
    assert.equal(loaded.pcmSources[assetId].length, totalSamples1Min);
    assert.equal(budget1Min.getSnapshot().accountedBytes, 11_520_000);
    // Peak must be 11.52 MB + 1 chunk (4s = 768 KB) = 12,288,000 B (nowhere near 2x = 23.04 MB)
    assert.equal(budget1Min.getSnapshot().highWaterMarkBytes, 11_520_000 + 4 * sampleRate * 4);
    loaded.runtimeResourceLease?.dispose();
    assert.equal(budget1Min.getSnapshot().accountedBytes, 0);
  }

  // Real end-to-end 120-minute @ 48 kHz mono fallback rejection under 1,024 MiB default policy
  // (rejected BEFORE allocating 1,382.40 MB Float32Array)
  {
    const totalSamples120Min = 120 * 60 * sampleRate; // 345,600,000 samples => 1,382,400,000 bytes
    // 10 MiB compressed MP3 keeps expansion ratio ~132x (< 250x security bomb guard)
    const file120Min = createSyntheticMp3File(10 * 1024 * 1024, 'two-hour-48k-mono.mp3');
    const budget120Min = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

    await assert.rejects(
      ingestAudioFileStreaming(file120Min, {
        memoryBudgetManager: budget120Min,
        decodeCompressedAudioFn: async () => ({
          sampleRate,
          numberOfChannels: 1,
          length: totalSamples120Min,
          duration: 120 * 60,
          getChannelData() {
            throw new Error('Must never read channel data when 120-min admission is rejected');
          },
        }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof MemoryPressureError);
        assert.equal(err.code, 'MEMORY_PRESSURE_LIMIT');
        assert.equal(err.requestedBytes, 1_382_400_000);
        return true;
      },
    );

    assert.equal(budget120Min.getSnapshot().accountedBytes, 0);
    assert.equal(budget120Min.getSnapshot().reservationCount, 0);
  }
});
