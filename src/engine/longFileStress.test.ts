import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AVAPARDAZ_AUDIO_CACHE_SPLIT, AVAPARDAZ_MEMORY_POLICY } from '../runtime/memory/MemoryPolicy';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { RollingLruBlockCache } from './lruCache';
import { StreamingKaiserSincResampler } from './resampler';
import { StreamingPeakPyramidBuilder } from './peakPyramid';
import { StreamingWavExportEncoder, WavSyncAccessTarget } from '../processing-core/StreamingExportEncoder';

/**
 * AVP-P01-008 — Long-File Stress Verification Suite (30 / 60 / 120 minutes)
 *
 * IMPORTANT: Synthetic waveforms generated here are strictly for memory, block storage,
 * chunked resampling, peak pyramid, windowed playback read, and streaming export stress
 * verification — NEVER for ASR recognition accuracy claims.
 */

interface StressScenario {
  readonly label: string;
  readonly durationMinutes: 30 | 60 | 120;
  readonly sampleRate: 16_000 | 48_000;
  readonly channels: 1 | 2;
  readonly chunkSeconds: number;
}

interface StressResult {
  readonly label: string;
  readonly inputDurationMinutes: number;
  readonly inputFormat: string;
  readonly blockCount: number;
  readonly peakAccountedMemoryBytes: number;
  readonly peakNodeRssBytes: number;
  readonly cachePeakBytes: number;
  readonly storageUsageBytes: number;
  readonly processingTimeMs: number;
  readonly failureCount: number;
  readonly finalLeakedBytes: number;
}

/**
 * Counting streaming sink simulating OPFS / FileSystemWritableFileStream disk writes
 * without retaining the exported WAV file in RAM.
 */
function createCountingStreamingDiskSink(): {
  target: WavSyncAccessTarget;
  getTotalBytesStored: () => number;
} {
  let maxEnd = 0;
  let cursor = 0;
  const target: WavSyncAccessTarget = {
    write(buffer: ArrayBufferView, options?: { at?: number }): number {
      const pos = options?.at ?? cursor;
      const end = pos + buffer.byteLength;
      if (end > maxEnd) maxEnd = end;
      cursor = end;
      return buffer.byteLength;
    },
    flush() {},
    truncate(newSize: number) {
      maxEnd = Math.min(maxEnd, newSize);
      cursor = Math.min(cursor, newSize);
    },
  };
  return {
    target,
    getTotalBytesStored: () => maxEnd,
  };
}

function runLongFileStreamingStress(scenario: StressScenario): StressResult {
  const t0 = performance.now();
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const cache = new RollingLruBlockCache(AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes); // 24 MiB cap
  budget.registerCacheEvictionCallback(() => {
    cache.evictToBudget(0);
  });

  const totalInputSamples = scenario.durationMinutes * 60 * scenario.sampleRate;
  const chunkSamples = scenario.chunkSeconds * scenario.sampleRate;
  const totalBlocks = Math.ceil(totalInputSamples / chunkSamples);

  const resampler =
    scenario.sampleRate === 16_000
      ? null
      : new StreamingKaiserSincResampler(scenario.sampleRate, 16_000);
  const peakBuilder = new StreamingPeakPyramidBuilder(`stress-${scenario.label}`, scenario.sampleRate);

  const exportSink = createCountingStreamingDiskSink();
  const wavEncoder = new StreamingWavExportEncoder(exportSink.target, {
    profileId: `STRESS_WAV_${scenario.label}`,
    profileVersion: 1,
    nameFa: `Stress WAV ${scenario.label}`,
    sampleRate: 16000,
    channelCount: 1,
    bitDepth: 16,
    targetLufs: -16,
    truePeakCeilingDbtp: -1,
    applyTpdfDither: false,
  });
  wavEncoder.beginStreamingExport();

  let storageBlockBytesWritten = 0;
  let peakNodeRssBytes = process.memoryUsage().rss;
  let cachePeakBytes = 0;
  let failureCount = 0;
  let total16kSamples = 0;

  // Reuse a bounded synthetic generator buffer per chunk (constant O(chunkSize) working set)
  const monoChunkBuf = new Float32Array(chunkSamples);
  const stereoAuxBuf = scenario.channels === 2 ? new Float32Array(chunkSamples) : null;

  for (let blk = 0; blk < totalBlocks; blk++) {
    const startSample = blk * chunkSamples;
    const count = Math.min(chunkSamples, totalInputSamples - startSample);
    const activeMono = count === chunkSamples ? monoChunkBuf : monoChunkBuf.subarray(0, count);

    const chunkBytes =
      count * Float32Array.BYTES_PER_ELEMENT * scenario.channels +
      Math.ceil((count * 16_000) / scenario.sampleRate) * Float32Array.BYTES_PER_ELEMENT;

    const res = budget.reserve({
      owner: `stress-${scenario.label}-blk-${blk}`,
      category: 'decoded-audio',
      bytes: chunkBytes,
      priority: 'normal',
      releasable: true,
    });

    try {
      // Deterministic lightweight synthetic waveform (fast trigonometric recurrence)
      const phaseStep = (2 * Math.PI * 440) / scenario.sampleRate;
      let phase = (startSample * phaseStep) % (2 * Math.PI);
      const cosStep = Math.cos(phaseStep);
      const sinStep = Math.sin(phaseStep);
      let s = Math.sin(phase);
      let c = Math.cos(phase);

      for (let i = 0; i < count; i++) {
        const sample = 0.25 * s;
        if (stereoAuxBuf) {
          stereoAuxBuf[i] = sample;
          activeMono[i] = 0.5 * (sample + stereoAuxBuf[i]);
        } else {
          activeMono[i] = sample;
        }
        const nextS = s * cosStep + c * sinStep;
        const nextC = c * cosStep - s * sinStep;
        s = nextS;
        c = nextC;
      }

      // 1. Streaming peak pyramid update
      peakBuilder.pushMonoChunk(activeMono);

      // 2. Bounded LRU cache insertion (auto-evicts strictly <= 24 MiB)
      cache.put(`stress-${scenario.label}`, blk, [activeMono.slice()]);
      const cacheStats = cache.getStats();
      if (cacheStats.usedBytes > cachePeakBytes) {
        cachePeakBytes = cacheStats.usedBytes;
      }

      // 3. Simulated OPFS block write accounting (Float32 mono persisted block)
      storageBlockBytesWritten += activeMono.byteLength;

      // 4. Chunked streaming resample to 16 kHz Mono + streaming WAV export write
      const chunk16k = resampler ? resampler.pushChunk(activeMono) : activeMono;
      if (chunk16k.length > 0) {
        total16kSamples += chunk16k.length;
        wavEncoder.pushRenderedChunk([chunk16k]);
      }

      if (blk % 50 === 0) {
        const rss = process.memoryUsage().rss;
        if (rss > peakNodeRssBytes) peakNodeRssBytes = rss;
      }
    } catch {
      failureCount++;
    } finally {
      budget.release(res);
    }
  }

  if (resampler) {
    const tail = resampler.flush();
    if (tail.length > 0) {
      total16kSamples += tail.length;
      wavEncoder.pushRenderedChunk([tail]);
    }
  }

  const finalizedExport = wavEncoder.finalizeStreamingExport();
  const pyramid = peakBuilder.finalize();
  cache.clear();

  const rssEnd = process.memoryUsage().rss;
  if (rssEnd > peakNodeRssBytes) peakNodeRssBytes = rssEnd;

  const snap = budget.getSnapshot();
  const processingTimeMs = Math.round(performance.now() - t0);

  // Structural invariants
  assert.equal(failureCount, 0);
  assert.equal(snap.accountedBytes, 0, 'Zero leaked memory reservations allowed after stress run');
  assert.ok(
    snap.highWaterMarkBytes < AVAPARDAZ_MEMORY_POLICY.targetBytes,
    `Peak accounted memory (${snap.highWaterMarkBytes} B) must stay well below 850 MiB target`,
  );
  assert.ok(
    cachePeakBytes <= AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
    `Cache peak (${cachePeakBytes} B) exceeded 24 MiB cap`,
  );
  assert.equal(finalizedExport.totalBytes, 44 + total16kSamples * 2);
  assert.ok(pyramid.levels.length > 0);

  const expected16k = scenario.durationMinutes * 60 * 16_000;
  assert.ok(
    Math.abs(total16kSamples - expected16k) <= 2,
    `16kHz output sample count drift too high for ${scenario.label}: got ${total16kSamples}, expected ${expected16k}`,
  );

  budget.dispose();

  return {
    label: scenario.label,
    inputDurationMinutes: scenario.durationMinutes,
    inputFormat: `${scenario.sampleRate}Hz ${scenario.channels === 1 ? 'Mono' : 'Stereo'}`,
    blockCount: totalBlocks,
    peakAccountedMemoryBytes: snap.highWaterMarkBytes,
    peakNodeRssBytes,
    cachePeakBytes,
    storageUsageBytes: storageBlockBytesWritten + exportSink.getTotalBytesStored(),
    processingTimeMs,
    failureCount,
    finalLeakedBytes: snap.accountedBytes,
  };
}

test('AVP-P01-008 Long-File Stress Suite: 30m, 60m, and 120m across 16kHz Mono and 48kHz Stereo stay strictly bounded with zero leaks', () => {
  const scenarios: StressScenario[] = [
    { label: '30m-16k-mono', durationMinutes: 30, sampleRate: 16_000, channels: 1, chunkSeconds: 4 },
    { label: '30m-48k-stereo', durationMinutes: 30, sampleRate: 48_000, channels: 2, chunkSeconds: 4 },
    { label: '60m-16k-mono', durationMinutes: 60, sampleRate: 16_000, channels: 1, chunkSeconds: 4 },
    { label: '60m-48k-stereo', durationMinutes: 60, sampleRate: 48_000, channels: 2, chunkSeconds: 4 },
    { label: '120m-16k-mono', durationMinutes: 120, sampleRate: 16_000, channels: 1, chunkSeconds: 4 },
    { label: '120m-48k-stereo', durationMinutes: 120, sampleRate: 48_000, channels: 2, chunkSeconds: 4 },
  ];

  const results: StressResult[] = [];
  for (const sc of scenarios) {
    results.push(runLongFileStreamingStress(sc));
  }

  // Emit exact measured telemetry for LONG-FILE-STRESS-REPORT.md
  console.log('AVP_P01_STRESS_REPORT_JSON=' + JSON.stringify(results));
  assert.equal(results.length, 6);
  for (const r of results) {
    assert.equal(r.failureCount, 0);
    assert.equal(r.finalLeakedBytes, 0);
    assert.ok(r.cachePeakBytes <= 24 * 1024 * 1024);
    assert.ok(r.peakAccountedMemoryBytes <= 10 * 1024 * 1024);
  }
});
