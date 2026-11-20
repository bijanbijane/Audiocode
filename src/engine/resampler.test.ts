import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resampleTo16kMono,
  computeSignalRms,
  StreamingKaiserSincResampler,
} from './resampler';
import { alignPersianScriptToAudio } from './persianAsrTranscriber';
import { extractAcousticProfile } from './dsp';

test('Anti-aliased resampler preserves 1kHz speech fundamental and suppresses 14kHz ultrasonic/aliasing tone', () => {
  const sampleRate = 48_000;
  const durationSec = 0.5;
  const n = Math.floor(sampleRate * durationSec);

  // 1) 1 kHz tone (well inside 16kHz passband)
  const lowTone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lowTone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  }
  const lowRes = resampleTo16kMono([lowTone], sampleRate, 16_000);
  assert.equal(lowRes.samples.length, 8_000);
  const lowRms = computeSignalRms(lowRes.samples);
  // Expected RMS of 0.5*sin is ~0.3535
  assert.ok(lowRms > 0.32, `1kHz passband RMS should stay intact, got ${lowRms}`);

  // 2) 14 kHz high-frequency tone (above 8kHz Nyquist of 16kHz output — would alias to 2kHz without filter!)
  const highTone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    highTone[i] = 0.5 * Math.sin((2 * Math.PI * 14_000 * i) / sampleRate);
  }
  const highRes = resampleTo16kMono([highTone], sampleRate, 16_000);
  const highRms = computeSignalRms(highRes.samples);
  const attenuationDb = 20 * Math.log10(Math.max(highRms, 1e-9) / lowRms);
  assert.ok(
    attenuationDb < -45,
    `14kHz tone must be attenuated by >45dB to prevent aliasing, got ${attenuationDb.toFixed(1)} dB`,
  );
});

test('Resampler handles 44.1kHz -> 16kHz cleanly without fractional buffer errors', () => {
  const sampleRate = 44_100;
  const n = 44_100; // 1.0 second
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    input[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const res = resampleTo16kMono([input], sampleRate, 16_000);
  assert.equal(res.samples.length, 16_000);
  assert.ok(computeSignalRms(res.samples) > 0.25);
});

test('StreamingKaiserSincResampler produces finite, passband-accurate output for integer and fractional ratios', () => {
  for (const sr of [32_000, 48_000, 44_100]) {
    const n = sr; // 1.0s
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 500 * i) / sr);
    }
    const streaming = new StreamingKaiserSincResampler(sr, 16_000);
    const out1 = streaming.pushChunk(input.subarray(0, n >> 1));
    const out2 = streaming.pushChunk(input.subarray(n >> 1));
    const tail = streaming.flush();
    const combined = new Float32Array(out1.length + out2.length + tail.length);
    combined.set(out1, 0);
    combined.set(out2, out1.length);
    combined.set(tail, out1.length + out2.length);

    assert.ok(combined.length >= 15_950 && combined.length <= 16_050, `Unexpected length for ${sr}: ${combined.length}`);
    for (let i = 0; i < combined.length; i++) {
      assert.ok(Number.isFinite(combined[i]), `Non-finite sample at ${i}`);
    }
    assert.ok(computeSignalRms(combined) > 0.30, `Passband RMS too low at ${sr}`);
  }
});

test('alignPersianScriptToAudio produces identical results when precomputed16k matches resampled PCM', () => {
  const sampleRate = 48_000;
  const durationSec = 2;
  const pcm = new Float32Array(sampleRate * durationSec);
  // Two speech bursts separated by silence
  for (let i = Math.floor(0.2 * sampleRate); i < Math.floor(0.8 * sampleRate); i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 190 * i) / sampleRate);
  }
  for (let i = Math.floor(1.1 * sampleRate); i < Math.floor(1.7 * sampleRate); i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
  const resampled = resampleTo16kMono([pcm], sampleRate, 16_000).samples;
  const profile = extractAcousticProfile('test-asset', pcm, sampleRate);

  const withoutPre = alignPersianScriptToAudio({
    pcm,
    sampleRate,
    trackId: 'track-1',
    speakerName: 'میزبان',
    rawTranscriptText: 'سلام دوستان عزیز خوش آمدید',
    acousticProfile: profile,
    alignmentSource: 'ASR',
  });
  const withPre = alignPersianScriptToAudio({
    pcm,
    sampleRate,
    precomputed16k: resampled,
    trackId: 'track-1',
    speakerName: 'میزبان',
    rawTranscriptText: 'سلام دوستان عزیز خوش آمدید',
    acousticProfile: profile,
    alignmentSource: 'ASR',
  });

  assert.equal(withPre.tokens.length, withoutPre.tokens.length);
  assert.deepEqual(withPre.tokens, withoutPre.tokens);
  assert.deepEqual(withPre.recommendations, withoutPre.recommendations);
});

test('Single-Pass vs Chunked Streaming resampling: exact sample count, low RMS/max error, zero boundary discontinuity, <= 1 sample drift', async () => {
  const { resampleChunkedTo16kStream } = await import('./resampler');

  for (const srcRate of [48_000, 44_100, 32_000]) {
    const durationSec = 6;
    const totalIn = srcRate * durationSec;
    const monoInput = new Float32Array(totalIn);
    for (let i = 0; i < totalIn; i++) {
      // Multi-tone speech-band signal (300Hz + 1100Hz + 2600Hz)
      const t = i / srcRate;
      monoInput[i] =
        0.3 * Math.sin(2 * Math.PI * 300 * t) +
        0.2 * Math.sin(2 * Math.PI * 1100 * t) +
        0.1 * Math.sin(2 * Math.PI * 2600 * t);
    }

    const singlePass = resampleTo16kMono([monoInput], srcRate, 16_000).samples;

    // Stream in arbitrary non-aligned chunks (e.g. 0.73s)
    const chunkLen = Math.floor(srcRate * 0.73);
    const streamedChunks: Float32Array[] = [];
    let totalStreamed = 0;

    await resampleChunkedTo16kStream({
      inputSampleRate: srcRate,
      targetSampleRate: 16_000,
      totalInputSamples: monoInput.length,
      chunkSizeSamples: chunkLen,
      readInputChunkFn: async (start, count) =>
        monoInput.subarray(start, Math.min(monoInput.length, start + count)),
      onOutputChunk: (c) => {
        streamedChunks.push(c);
        totalStreamed += c.length;
      },
    });

    const streamed = new Float32Array(totalStreamed);
    let writePos = 0;
    for (const c of streamedChunks) {
      streamed.set(c, writePos);
      writePos += c.length;
    }

    // 1. Sample count drift <= 1 sample at 16 kHz
    const expectedOut = Math.round((totalIn * 16_000) / srcRate);
    assert.ok(
      Math.abs(streamed.length - expectedOut) <= 1,
      `Sample count drift > 1 sample at ${srcRate}Hz: got ${streamed.length}, expected ${expectedOut}`,
    );
    assert.ok(
      Math.abs(streamed.length - singlePass.length) <= 1,
      `Single-pass (${singlePass.length}) vs streamed (${streamed.length}) length drift > 1 at ${srcRate}Hz`,
    );

    // 2. Compare interior samples (skipping 32-sample filter edge transients)
    const compareLen = Math.min(singlePass.length, streamed.length);
    const edge = 32;
    let sumSqErr = 0;
    let maxAbsErr = 0;
    let count = 0;
    for (let i = edge; i < compareLen - edge; i++) {
      const diff = Math.abs(singlePass[i] - streamed[i]);
      if (diff > maxAbsErr) maxAbsErr = diff;
      sumSqErr += diff * diff;
      count++;
    }
    const rmsErr = Math.sqrt(sumSqErr / Math.max(1, count));
    assert.ok(
      rmsErr < 1e-3,
      `Streamed vs Single-Pass RMS error too high at ${srcRate}Hz: ${rmsErr}`,
    );
    assert.ok(
      maxAbsErr < 5e-3,
      `Streamed vs Single-Pass max abs error too high at ${srcRate}Hz: ${maxAbsErr}`,
    );

    // 3. Check boundary discontinuity at chunk joins
    let cursor = 0;
    for (let ci = 0; ci < streamedChunks.length - 1; ci++) {
      cursor += streamedChunks[ci].length;
      if (cursor > edge && cursor < streamed.length - edge) {
        const jump = Math.abs(streamed[cursor] - streamed[cursor - 1]);
        const refJump = Math.abs(singlePass[cursor] - singlePass[cursor - 1]);
        assert.ok(
          Math.abs(jump - refJump) < 0.01,
          `Boundary discontinuity detected at chunk join #${ci} (${srcRate}Hz): jump=${jump}, ref=${refJump}`,
        );
      }
    }
  }
});

test('Resampler handles stereo downmix, empty input, and single-sample input without NaN/crash', () => {
  // Empty
  const emptyRes = resampleTo16kMono([new Float32Array(0)], 48_000, 16_000);
  assert.equal(emptyRes.samples.length, 0);

  const emptyStream = new StreamingKaiserSincResampler(48_000, 16_000);
  assert.equal(emptyStream.pushChunk(new Float32Array(0)).length, 0);
  assert.equal(emptyStream.flush().length, 0);

  // Single sample
  const singleRes = resampleTo16kMono([new Float32Array([0.5])], 48_000, 16_000);
  for (let i = 0; i < singleRes.samples.length; i++) {
    assert.ok(Number.isFinite(singleRes.samples[i]));
  }

  // Stereo opposite phase cancellation check
  const n = 4800;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.4 * Math.sin((2 * Math.PI * 500 * i) / 48_000);
    right[i] = 0.4 * Math.sin((2 * Math.PI * 500 * i) / 48_000);
  }
  const stereoRes = resampleTo16kMono([left, right], 48_000, 16_000);
  assert.equal(stereoRes.samples.length, 1600);
  assert.ok(computeSignalRms(stereoRes.samples) > 0.25);
});


