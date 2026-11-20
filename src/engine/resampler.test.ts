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

