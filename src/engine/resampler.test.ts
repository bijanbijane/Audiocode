import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleTo16kMono, computeSignalRms } from './resampler';

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
