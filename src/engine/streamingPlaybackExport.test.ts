import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAsset, EphemeralDspParams, Track } from '../contracts/v1_2';
import {
  MAX_OPFS_UNAVAILABLE_FALLBACK_BYTES,
  estimateStorageQuotaForIngest,
} from './storageBroker';
import {
  MAX_LEGACY_FULL_RENDER_BYTES,
  renderTimelineRangeFromBlocks,
  streamExportTimelineToWav,
  streamingChunkedRender,
} from './audioPlayback';
import { samplesToFlicks } from './timebase';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { WavSyncAccessTarget } from '../processing-core/StreamingExportEncoder';
import { ExportValidator } from '../processing-core/ExportValidator';

function validateWavExportIndependent(
  wavBuffer: ArrayBuffer,
  expectedSampleRate: number,
  expectedChannels: number,
  expectedBitDepth: 16 | 24,
): { passed: boolean; structurallyValid: boolean; invalidSampleCount: number; errors: string[] } {
  const errors: string[] = [];
  if (wavBuffer.byteLength < 44) {
    return { passed: false, structurallyValid: false, invalidSampleCount: 0, errors: ['WAV < 44 bytes'] };
  }
  const view = new DataView(wavBuffer);
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...new Uint8Array(wavBuffer, off, len));

  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' || ascii(36, 4) !== 'data') {
    errors.push('Invalid RIFF/WAVE/fmt/data signature');
  }
  const riffSize = view.getUint32(4, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitDepth = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);

  if (riffSize !== wavBuffer.byteLength - 8) errors.push(`RIFF size mismatch: ${riffSize} vs ${wavBuffer.byteLength - 8}`);
  if (dataSize !== wavBuffer.byteLength - 44) errors.push(`data size mismatch: ${dataSize} vs ${wavBuffer.byteLength - 44}`);
  if (channels !== expectedChannels) errors.push(`channel mismatch: ${channels}`);
  if (sampleRate !== expectedSampleRate) errors.push(`sampleRate mismatch: ${sampleRate}`);
  if (bitDepth !== expectedBitDepth) errors.push(`bitDepth mismatch: ${bitDepth}`);

  if (errors.length > 0) {
    return { passed: false, structurallyValid: false, invalidSampleCount: 0, errors };
  }

  const bytesPerSample = bitDepth / 8;
  const frameCount = Math.floor(dataSize / (channels * bytesPerSample));
  const planes = Array.from({ length: channels }, () => new Float32Array(frameCount));
  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channels; c++) {
      if (bitDepth === 16) {
        planes[c][i] = view.getInt16(offset, true) / 32768;
        offset += 2;
      } else {
        let v =
          view.getUint8(offset) |
          (view.getUint8(offset + 1) << 8) |
          (view.getUint8(offset + 2) << 16);
        if (v & 0x800000) v |= ~0xffffff;
        planes[c][i] = v / 8388608;
        offset += 3;
      }
    }
  }

  const pcmReport = ExportValidator.validateRenderedPcm(
    planes,
    sampleRate as 16000 | 44100 | 48000 | 96000,
    frameCount / sampleRate,
  );
  return {
    passed: pcmReport.passed,
    structurallyValid: pcmReport.structurallyValid,
    invalidSampleCount: pcmReport.invalidSamplesCount,
    errors: pcmReport.errors,
  };
}

const DEFAULT_DSP: EphemeralDspParams = {
  highPassHz: 0,
  compressorThresholdDb: 0,
  compressorRatio: 1,
  noiseGateThresholdDb: -96,
  masterGainDb: 0,
};

function createInMemorySyncTarget(): {
  target: WavSyncAccessTarget;
  toUint8Array: () => Uint8Array;
  getSize: () => number;
  getTruncateCalls: () => number;
} {
  let buf = new Uint8Array(0);
  let truncateCalls = 0;

  const ensureSize = (size: number) => {
    if (size <= buf.length) return;
    const next = new Uint8Array(Math.max(size, buf.length * 2 || 4096));
    next.set(buf);
    buf = next;
  };
  let logicalSize = 0;

  const target: WavSyncAccessTarget = {
    write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number {
      const src =
        buffer instanceof ArrayBuffer
          ? new Uint8Array(buffer)
          : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const at = options?.at ?? logicalSize;
      ensureSize(at + src.byteLength);
      buf.set(src, at);
      logicalSize = Math.max(logicalSize, at + src.byteLength);
      return src.byteLength;
    },
    flush() {},
    truncate(newSize: number) {
      truncateCalls++;
      logicalSize = Math.max(0, Math.min(logicalSize, newSize));
    },
  };

  return {
    target,
    toUint8Array: () => buf.slice(0, logicalSize),
    getSize: () => logicalSize,
    getTruncateCalls: () => truncateCalls,
  };
}

function makeFixtureTrack(assetId: string, sampleRate: number, totalSamples: number): {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
} {
  const durFlicks = samplesToFlicks(totalSamples, sampleRate);
  const asset: AudioAsset = {
    id: assetId,
    name: `${assetId}.wav`,
    contentHash: 'sha256:test',
    partialFingerprint: 'fp:test',
    contentVersion: 1,
    fileSizeBytes: totalSamples * 2 + 44,
    container: 'wav',
    codec: 'pcm_s16le',
    nativeSampleRate: sampleRate,
    channelLayout: 'mono',
    exactSampleCount: totalSamples,
    durationFlicks: durFlicks,
    importTimestamp: Date.now(),
    validationStatus: 'verified',
    seekTable: [],
    peakPyramid: { assetId, sampleRate, totalSamples, levels: [] },
    acousticProfile: {
      assetId,
      noiseFloorDbfs: -60,
      roomToneRms: 0.001,
      roomToneSample: new Float32Array(16),
      sampleRate,
    },
    storageLifecycle: 'ready',
    storageBackend: 'OPFS-SyncAccessHandle',
  };

  const track: Track = {
    id: 'track-main',
    name: 'Host',
    speakerLabel: 'میزبان',
    syncGroupId: null,
    muted: false,
    solo: false,
    gainDb: 0,
    pan: 0,
    clips: [
      {
        id: 'clip-1',
        trackId: 'track-main',
        assetId,
        kind: 'speech',
        sourceStartFlicks: 0,
        timelineRange: { startFlicks: 0, endFlicks: durFlicks },
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        muted: false,
      },
    ],
  };

  return { tracks: [track], assets: { [assetId]: asset } };
}

test('estimateStorageQuotaForIngest separates audio-blocks and model-weights pools and handles unavailable estimate honestly', async () => {
  assert.equal(MAX_OPFS_UNAVAILABLE_FALLBACK_BYTES, 32 * 1024 * 1024);

  const audioOk = await estimateStorageQuotaForIngest({
    requiredBytes: 100 * 1024 * 1024,
    pool: 'audio-blocks',
    estimateFn: async () => ({ quota: 500 * 1024 * 1024, usage: 50 * 1024 * 1024 }),
  });
  assert.equal(audioOk.available, true);
  assert.equal(audioOk.sufficient, true);
  assert.equal(audioOk.pool, 'audio-blocks');

  const modelInsufficient = await estimateStorageQuotaForIngest({
    requiredBytes: 450 * 1024 * 1024,
    pool: 'model-weights',
    estimateFn: async () => ({ quota: 500 * 1024 * 1024, usage: 50 * 1024 * 1024 }),
  });
  assert.equal(modelInsufficient.available, true);
  assert.equal(modelInsufficient.sufficient, false);
  assert.equal(modelInsufficient.pool, 'model-weights');

  const unavailable = await estimateStorageQuotaForIngest({
    requiredBytes: 10 * 1024 * 1024,
    pool: 'audio-blocks',
    estimateFn: async () => ({}),
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.sufficient, null);
});

test('renderTimelineRangeFromBlocks streams bounded windows without resident pcmSources and propagates storage errors / missing blocks safely', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 10; // 10s
  const { tracks, assets } = makeFixtureTrack('opfs-asset', sampleRate, totalSamples);

  const reads: Array<{ start: number; len: number }> = [];
  const readAssetRange = async (_assetId: string, startSample: number, length: number) => {
    reads.push({ start: startSample, len: length });
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = 0.25 * Math.sin((2 * Math.PI * 440 * (startSample + i)) / sampleRate);
    }
    return out;
  };

  // Seek to middle [4.0s .. 6.0s)
  const windowPcm = await renderTimelineRangeFromBlocks({
    tracks,
    assets,
    pcmSources: {}, // ZERO resident PCM!
    readAssetRange,
    sampleRate,
    rangeFlicks: {
      startFlicks: samplesToFlicks(4 * sampleRate, sampleRate),
      endFlicks: samplesToFlicks(6 * sampleRate, sampleRate),
    },
    dspParams: DEFAULT_DSP,
    preRollSamples: 0,
  });

  assert.equal(windowPcm.length, 2 * sampleRate);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].start, 4 * sampleRate);
  assert.equal(reads[0].len, 2 * sampleRate);
  assert.ok(windowPcm.some((v) => Math.abs(v) > 0.1));

  // Missing block returns zeroed silence safely without NaN/crash
  const missingPcm = await renderTimelineRangeFromBlocks({
    tracks,
    assets,
    pcmSources: {},
    readAssetRange: async () => new Float32Array(0),
    sampleRate,
    rangeFlicks: {
      startFlicks: 0,
      endFlicks: samplesToFlicks(sampleRate, sampleRate),
    },
    dspParams: DEFAULT_DSP,
    preRollSamples: 0,
  });
  assert.equal(missingPcm.length, sampleRate);
  assert.ok(missingPcm.every((v) => v === 0));

  // Storage I/O failure propagates cleanly
  await assert.rejects(
    () =>
      renderTimelineRangeFromBlocks({
        tracks,
        assets,
        pcmSources: {},
        readAssetRange: async () => {
          throw new Error('OPFS_READ_IO_ERROR');
        },
        sampleRate,
        rangeFlicks: {
          startFlicks: 0,
          endFlicks: samplesToFlicks(sampleRate, sampleRate),
        },
        dspParams: DEFAULT_DSP,
      }),
    /OPFS_READ_IO_ERROR/,
  );
});

test('streamExportTimelineToWav writes valid PCM16 Mono and PCM24 Stereo WAV with zero memory leaks and supports independent validation + corrupt rejection', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 5; // 5s
  const { tracks, assets } = makeFixtureTrack('export-asset', sampleRate, totalSamples);
  const budget = new MemoryBudgetManager();

  const readAssetRange = async (_assetId: string, startSample: number, length: number) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      // Gentle head/tail fade envelope
      const idx = startSample + i;
      const env = idx < 160 ? idx / 160 : idx > totalSamples - 160 ? (totalSamples - idx) / 160 : 1;
      out[i] = 0.25 * env * Math.sin((2 * Math.PI * 500 * idx) / sampleRate);
    }
    return out;
  };

  // 1) PCM16 Mono
  const sink16 = createInMemorySyncTarget();
  const res16 = await streamExportTimelineToWav({
    tracks,
    assets,
    readAssetRange,
    sampleRate,
    channels: 1,
    bitDepth: 16,
    dspParams: DEFAULT_DSP,
    target: sink16.target,
    memoryBudgetManager: budget,
    chunkSeconds: 1.5,
  });

  assert.equal(res16.totalSamplesWritten, totalSamples);
  assert.equal(res16.totalBytesWritten, 44 + totalSamples * 2);
  assert.equal(budget.getUsedBytes(), 0, 'All export chunk reservations must be released');

  const bytes16 = sink16.toUint8Array();
  const validation16 = validateWavExportIndependent(bytes16.buffer as ArrayBuffer, sampleRate, 1, 16);
  assert.equal(validation16.passed, true, `PCM16 validation failed: ${validation16.errors.join('; ')}`);
  assert.equal(validation16.structurallyValid, true);
  assert.equal(validation16.invalidSampleCount, 0);

  // 2) PCM24 Stereo
  const sink24 = createInMemorySyncTarget();
  const res24 = await streamExportTimelineToWav({
    tracks,
    assets,
    readAssetRange,
    sampleRate,
    channels: 2,
    bitDepth: 24,
    dspParams: DEFAULT_DSP,
    target: sink24.target,
    memoryBudgetManager: budget,
    chunkSeconds: 2.0,
  });
  assert.equal(res24.totalSamplesWritten, totalSamples);
  assert.equal(res24.totalBytesWritten, 44 + totalSamples * 2 * 3);
  assert.equal(budget.getUsedBytes(), 0);

  const bytes24 = sink24.toUint8Array();
  const validation24 = validateWavExportIndependent(bytes24.buffer as ArrayBuffer, sampleRate, 2, 24);
  assert.equal(validation24.passed, true, `PCM24 validation failed: ${validation24.errors.join('; ')}`);

  // 3) Corrupt file detection
  const corrupted = bytes16.slice(0, 60);
  const corruptValidation = validateWavExportIndependent(corrupted.buffer as ArrayBuffer, sampleRate, 1, 16);
  assert.equal(corruptValidation.passed, false);
  assert.equal(corruptValidation.structurallyValid, false);
});

test('streamExportTimelineToWav cancels cleanly mid-export, truncates temp target, and leaks zero memory', async () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 8;
  const { tracks, assets } = makeFixtureTrack('cancel-asset', sampleRate, totalSamples);
  const budget = new MemoryBudgetManager();
  const sink = createInMemorySyncTarget();
  const abortController = new AbortController();
  let cleanupCalled = false;

  await assert.rejects(
    () =>
      streamExportTimelineToWav({
        tracks,
        assets,
        readAssetRange: async (_id, _s, len) => new Float32Array(len),
        sampleRate,
        channels: 1,
        bitDepth: 16,
        dspParams: DEFAULT_DSP,
        target: sink.target,
        memoryBudgetManager: budget,
        chunkSeconds: 1.0,
        abortSignal: abortController.signal,
        onProgress: (p) => {
          if (p.chunksCompleted >= 2) {
            abortController.abort();
          }
        },
        onCleanupAbortedTarget: () => {
          cleanupCalled = true;
        },
      }),
    /EXPORT_ABORTED/,
  );

  assert.equal(cleanupCalled, true);
  assert.ok(sink.getTruncateCalls() >= 1);
  assert.equal(sink.getSize(), 0);
  assert.equal(budget.getUsedBytes(), 0);
});

test('legacy streamingChunkedRender rejects unbounded multi-hour allocations exceeding MAX_LEGACY_FULL_RENDER_BYTES', () => {
  const sampleRate = 48_000;
  // 2 hours at 48kHz Float32 = 345,600,000 samples * 4 B = ~1.38 GiB > 128 MiB guard
  const twoHourSamples = sampleRate * 7200;
  const { tracks, assets } = makeFixtureTrack('huge-legacy', sampleRate, twoHourSamples);

  assert.throws(
    () =>
      streamingChunkedRender({
        tracks,
        assets,
        pcmSources: {},
        sampleRate,
        dspParams: DEFAULT_DSP,
        maxOutputBytes: MAX_LEGACY_FULL_RENDER_BYTES,
      }),
    /MEMORY_LIMIT_EXCEEDED/,
  );
});
