import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  ShahabZipformerAsrRuntime,
  ShahabZipformerRuntimeError,
} from './ShahabZipformerAsrRuntime';
import { decodeWavToMono16k } from './ShahabZipformerEngine';
import {
  mergeChunkedTranscriptWords,
  planAudioChunks,
} from '../asr-core/ShahabChunkMerger';
import {
  parseShahabJsonResponse,
  type ShahabLocalRuntimeStatusResponse,
} from '../asr-core/ShahabLocalHttpClient';
import { deriveShahabWidgetViewModel } from '../utils/shahabStatusWidgetModel';

const SAMPLE_WAV_PATH = path.resolve(
  process.cwd(),
  'models',
  'persian-zipformer-transducer',
  '1.0.0',
  'sample.wav',
);

function buildPcm16WavBuffer(params: {
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelData: readonly Float32Array[];
}): Buffer {
  const numFrames = params.channelData[0].length;
  const bytesPerSample = 2;
  const dataSize = numFrames * params.channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(params.channels, 22);
  buf.writeUInt32LE(params.sampleRate, 24);
  buf.writeUInt32LE(params.sampleRate * params.channels * bytesPerSample, 28);
  buf.writeUInt16LE(params.channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < params.channels; ch++) {
      const clamped = Math.max(-1, Math.min(1, params.channelData[ch][i]));
      const val = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      buf.writeInt16LE(val, offset);
      offset += 2;
    }
  }
  return buf;
}

test('D1: Corrupt model assets fail SHA-256 check, flip available=false with integrityError, and clear on disk change', async () => {
  const tmpModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-corrupt-shahab-'));
  try {
    // Populate required model files with corrupted bytes
    const files = [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
      'bpe_fa_1024.model',
      'manifest.json',
    ];
    for (const f of files) {
      fs.writeFileSync(path.join(tmpModelDir, f), Buffer.from('corrupted-model-bytes-test'));
    }

    const rt = new ShahabZipformerAsrRuntime({ modelDir: tmpModelDir });
    const initial = rt.getRuntimeStatus();
    // Eager SHA-256 integrity verification must detect corrupted weights immediately before the first transcribe()
    assert.equal(initial.available, false);
    assert.equal(initial.integrityVerified, false);
    assert.ok(initial.integrityError && initial.integrityError.length > 0);

    const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
    const hash = crypto.createHash('sha256').update(sampleBytes).digest('hex');

    await assert.rejects(
      () =>
        rt.transcribe({
          sourceAudioId: 'corrupt_test',
          sourceAudioHash: hash,
          audioBytes: sampleBytes,
          filename: 'sample.wav',
        }),
      (err: unknown) =>
        err instanceof ShahabZipformerRuntimeError && err.code === 'SHAHAB_MODEL_INTEGRITY_FAILED',
    );

    const afterFailure = rt.getRuntimeStatus();
    assert.equal(afterFailure.available, false);
    assert.equal(afterFailure.modelLoaded, false);
    assert.equal(afterFailure.integrityVerified, false);
    assert.ok(afterFailure.integrityError && afterFailure.integrityError.length > 0);

    // Replacing tokens.txt with still-corrupted content triggers re-verification and remains unavailable
    fs.writeFileSync(path.join(tmpModelDir, 'tokens.txt'), Buffer.from('updated-tokens-content'));
    const afterChange = rt.getRuntimeStatus();
    assert.equal(afterChange.available, false);
    assert.equal(afterChange.integrityVerified, false);
    assert.ok(afterChange.integrityError && afterChange.integrityError.length > 0);

    await rt.dispose();
  } finally {
    fs.rmSync(tmpModelDir, { recursive: true, force: true });
  }
});

test('D2: Malformed WAV, fake text audio, and truncated MP3 reject cleanly with INVALID_AUDIO_INPUT', async () => {
  const rt = new ShahabZipformerAsrRuntime();

  // 1. Direct decodeWavToMono16k header bounds checks
  const zeroChanWav = Buffer.alloc(64);
  zeroChanWav.write('RIFF', 0, 'ascii');
  zeroChanWav.writeUInt32LE(56, 4);
  zeroChanWav.write('WAVE', 8, 'ascii');
  zeroChanWav.write('fmt ', 12, 'ascii');
  zeroChanWav.writeUInt32LE(16, 16);
  zeroChanWav.writeUInt16LE(1, 20);
  zeroChanWav.writeUInt16LE(0, 22); // invalid 0 channels
  zeroChanWav.writeUInt32LE(16000, 24);
  zeroChanWav.writeUInt16LE(16, 34);
  zeroChanWav.write('data', 36, 'ascii');
  zeroChanWav.writeUInt32LE(20, 40);
  assert.throws(() => decodeWavToMono16k(zeroChanWav), /channels/i);

  // Non-PCM audio format (e.g., ADPCM = 2) with 16 bits must be rejected
  const adpcmWav = Buffer.from(zeroChanWav);
  adpcmWav.writeUInt16LE(2, 20); // non-PCM format
  adpcmWav.writeUInt16LE(1, 22); // 1 channel
  assert.throws(() => decodeWavToMono16k(adpcmWav), /format/i);

  // 2. Runtime rejects fake text .wav and truncated MP3 with INVALID_AUDIO_INPUT
  const cases = [
    { name: 'fake.wav', bytes: Buffer.from('not a real wav file payload at all '.repeat(4)) },
    { name: 'broken.mp3', bytes: Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0xff, 0xfb, 0x00, 0x00]) },
    { name: 'corrupt-fmt.wav', bytes: zeroChanWav },
  ];

  for (const tc of cases) {
    const hash = crypto.createHash('sha256').update(tc.bytes).digest('hex');
    await assert.rejects(
      () =>
        rt.transcribe({
          sourceAudioId: `invalid_${tc.name}`,
          sourceAudioHash: hash,
          audioBytes: tc.bytes,
          filename: tc.name,
        }),
      (err: unknown) =>
        err instanceof ShahabZipformerRuntimeError && err.code === 'INVALID_AUDIO_INPUT',
      `Expected INVALID_AUDIO_INPUT for ${tc.name}`,
    );
  }

  // 3. Duration DoS cap rejects overly long audio with AUDIO_DURATION_LIMIT_EXCEEDED
  const shortLimitRt = new ShahabZipformerAsrRuntime({ maxSingleRequestDurationSec: 5 });
  const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
  await assert.rejects(
    () =>
      shortLimitRt.transcribe({
        sourceAudioId: 'too_long_test',
        sourceAudioHash: 'too_long_hash',
        audioBytes: sampleBytes, // 12.12s > 5s cap
        filename: 'sample.wav',
      }),
    (err: unknown) =>
      err instanceof ShahabZipformerRuntimeError && err.code === 'AUDIO_DURATION_LIMIT_EXCEEDED',
  );

  await rt.dispose();
  await shortLimitRt.dispose();
});

test('D3: Stereo out-of-phase (L = +s, R = -s) WAV preserves Persian speech instead of cancelling to silence', async () => {
  const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
  const mono = decodeWavToMono16k(sampleBytes);

  // Build stereo WAV where R = -L (180-degree phase inversion)
  const inverted = new Float32Array(mono.pcm16k.length);
  for (let i = 0; i < mono.pcm16k.length; i++) {
    inverted[i] = -mono.pcm16k[i];
  }
  const outOfPhaseStereoWav = buildPcm16WavBuffer({
    sampleRate: 16000,
    channels: 2,
    channelData: [mono.pcm16k, inverted],
  });

  // 1. Unit check: decoded mono must retain full RMS energy instead of cancelling to ~0
  const decoded = decodeWavToMono16k(outOfPhaseStereoWav);
  let energy = 0;
  for (let i = 0; i < decoded.pcm16k.length; i++) {
    energy += decoded.pcm16k[i] * decoded.pcm16k[i];
  }
  const rms = Math.sqrt(energy / decoded.pcm16k.length);
  assert.ok(rms > 0.02, `Expected preserved speech RMS > 0.02, got ${rms}`);

  // 2. Real SHAHAB inference check: must recover Persian words
  const rt = new ShahabZipformerAsrRuntime();
  try {
    const hash = crypto.createHash('sha256').update(outOfPhaseStereoWav).digest('hex');
    const res = await rt.transcribe({
      sourceAudioId: 'out_of_phase_stereo',
      sourceAudioHash: hash,
      audioBytes: outOfPhaseStereoWav,
      filename: 'out-of-phase-stereo.wav',
    });
    assert.ok(res.transcript.tokens.length >= 10, `Expected >=10 tokens, got ${res.transcript.tokens.length}`);
    assert.ok(res.transcript.rawText.includes('شکلات'));
  } finally {
    await rt.dispose();
  }
});

test('D4: planAudioChunks & mergeChunkedTranscriptWords enforce monotonicity, prevent seam cuts, and preserve legitimate repetitions', () => {
  // 1. Exact threshold <= 24s produces 1 chunk
  const single = planAudioChunks({ totalSamples: 24 * 16000, sampleRate: 16000 });
  assert.equal(single.length, 1);

  // 2. 55s audio plans 3 overlapping chunks covering [0, 55]
  const chunks55 = planAudioChunks({ totalSamples: 55 * 16000, sampleRate: 16000 });
  assert.equal(chunks55.length, 3);
  assert.equal(chunks55[0].startSec, 0);
  assert.equal(chunks55[0].endSec, 24);
  assert.equal(chunks55[1].startSec, 23); // 1.0s overlap
  assert.equal(chunks55[chunks55.length - 1].endSec, 55);

  // 3. Midpoint ownership drops cut fragments on chunk edges & deduplicates seam word
  const merged = mergeChunkedTranscriptWords({
    totalDurationSec: 47,
    buckets: [
      {
        chunkStartSec: 0,
        chunkEndSec: 24,
        words: [
          { rawText: 'سلام', startSec: 1.0, endSec: 1.5 },
          { rawText: 'سلام', startSec: 2.0, endSec: 2.5 }, // legitimate repetition outside overlap!
          { rawText: 'استاندارد', startSec: 23.1, endSec: 23.55 },
          { rawText: 'بلژ', startSec: 23.75, endSec: 23.95 }, // truncated edge fragment after midpoint (23.5)
        ],
      },
      {
        chunkStartSec: 23,
        chunkEndSec: 47,
        words: [
          { rawText: 'دارد', startSec: 23.05, endSec: 23.35 }, // truncated left edge fragment before midpoint (23.5)
          { rawText: 'بلژیکی', startSec: 23.65, endSec: 24.2 },
          { rawText: 'عالی', startSec: 25.0, endSec: 25.4 },
          { rawText: 'عالی', startSec: 26.0, endSec: 26.4 }, // legitimate repetition after seam!
        ],
      },
    ],
  });

  const texts = merged.map((w) => w.rawText);
  assert.deepEqual(texts, ['سلام', 'سلام', 'استاندارد', 'بلژیکی', 'عالی', 'عالی']);

  // Strictly monotonic and within [0, 47]
  for (let i = 0; i < merged.length; i++) {
    assert.ok(merged[i].startSec >= 0 && merged[i].endSec <= 47);
    assert.ok(merged[i].endSec > merged[i].startSec);
    if (i > 0) {
      assert.ok(merged[i].startSec >= merged[i - 1].startSec);
    }
  }
});

test('D5: parseShahabJsonResponse classifies transient proxy/queue errors vs terminal JSON errors correctly', async () => {
  const plain502 = new Response('502 Bad Gateway', {
    status: 502,
    headers: { 'Content-Type': 'text/plain' },
  });
  const r502 = await parseShahabJsonResponse(plain502, 'خطا');
  assert.equal(r502.kind, 'RETRYABLE_TRANSIENT');

  const empty504 = new Response('', { status: 504 });
  const r504 = await parseShahabJsonResponse(empty504, 'خطا');
  assert.equal(r504.kind, 'RETRYABLE_TRANSIENT');

  const queue429 = new Response(JSON.stringify({ error: 'SHAHAB_QUEUE_FULL', message: 'صف پر است' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });
  const r429 = await parseShahabJsonResponse(queue429, 'خطا');
  assert.equal(r429.kind, 'RETRYABLE_TRANSIENT');

  const bad400 = new Response(JSON.stringify({ error: 'INVALID_AUDIO_INPUT', message: 'فایل نامعتبر' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
  const r400 = await parseShahabJsonResponse(bad400, 'خطا');
  assert.equal(r400.kind, 'ERROR');

  const brokenJson200 = new Response('{"ok": true, truncated', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const rBroken = await parseShahabJsonResponse(brokenJson200, 'خطا');
  assert.equal(rBroken.kind, 'ERROR');
});

test('D6: Bounded queue rejects overflow with SHAHAB_QUEUE_FULL and reports accurate activeJobCount + queuedJobCount', async () => {
  const rt = new ShahabZipformerAsrRuntime({ maxPendingJobs: 2 });
  const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
  try {
    // Launch 3 parallel uncached jobs against maxPendingJobs=2 -> 3rd must reject immediately with SHAHAB_QUEUE_FULL
    const p1 = rt.transcribe({
      sourceAudioId: 'q_1',
      sourceAudioHash: 'q_hash_1',
      audioBytes: sampleBytes,
      filename: 'q1.wav',
    });
    const p2 = rt.transcribe({
      sourceAudioId: 'q_2',
      sourceAudioHash: 'q_hash_2',
      audioBytes: sampleBytes,
      filename: 'q2.wav',
    });

    const midStatus = rt.getRuntimeStatus();
    assert.ok(
      midStatus.activeJobCount + midStatus.queuedJobCount >= 2,
      `Expected >=2 pending jobs reported, got active=${midStatus.activeJobCount}, queued=${midStatus.queuedJobCount}`,
    );

    await assert.rejects(
      () =>
        rt.transcribe({
          sourceAudioId: 'q_3',
          sourceAudioHash: 'q_hash_3',
          audioBytes: sampleBytes,
          filename: 'q3.wav',
        }),
      (err: unknown) =>
        err instanceof ShahabZipformerRuntimeError && err.code === 'SHAHAB_QUEUE_FULL',
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.transcript.tokens.length > 0);
    assert.ok(r2.transcript.tokens.length > 0);

    const endStatus = rt.getRuntimeStatus();
    assert.equal(endStatus.activeJobCount, 0);
    assert.equal(endStatus.queuedJobCount, 0);
  } finally {
    await rt.dispose();
  }
});

test('D7: deriveShahabWidgetViewModel renders DEGRADED_INTEGRITY_ERROR and queuedJobCount accurately', () => {
  const base: ShahabLocalRuntimeStatusResponse = {
    available: true,
    modelLoaded: true,
    engine: 'SHAHAB_ZIPFORMER_TRANSDUCER',
    modelId: 'persian-zipformer-transducer',
    modelVersion: '1.0.0-shahab-zipformer-int8',
    upstreamModelId: 'ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f',
    runtime: 'shahab-zipformer-onnx-cpu',
    offlineOnlyEnforced: true,
    missingFiles: [],
    integrityError: null,
    sampleAudioAvailable: true,
    activeJobCount: 0,
    queuedJobCount: 0,
    lastMetrics: null,
  };

  const corruptVm = deriveShahabWidgetViewModel({
    status: {
      ...base,
      available: false,
      modelLoaded: false,
      integrityError: 'SHA-256 mismatch on encoder.int8.onnx',
    },
    isTranscribing: false,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(corruptVm.healthState, 'DEGRADED_INTEGRITY_ERROR');
  assert.equal(corruptVm.tone, 'rose');
  assert.ok(corruptVm.healthDetail.includes('SHA-256'));

  const queuedVm = deriveShahabWidgetViewModel({
    status: {
      ...base,
      activeJobCount: 1,
      queuedJobCount: 3,
    },
    isTranscribing: true,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(queuedVm.healthState, 'PROCESSING');
  assert.equal(queuedVm.queuedJobCount, 3);
  assert.ok(queuedVm.healthDetail.includes('3 در صف انتظار'));
});
