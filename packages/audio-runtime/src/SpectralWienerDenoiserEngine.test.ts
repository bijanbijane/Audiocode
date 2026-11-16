import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectralWienerDenoiserEngine } from './SpectralWienerDenoiserEngine';

function createBroadbandNoise(length: number, amplitude: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic multi-component broadband background noise
    const n =
      Math.sin(i * 0.713) +
      Math.sin(i * 1.419) +
      Math.sin(i * 2.173) +
      Math.sin(i * 3.041);
    out[i] = (n / 4) * amplitude;
  }
  return out;
}

function rmsSlice(buf: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

test('Section 63: SpectralWienerDenoiserEngine attenuates learned Room Tone noise while preserving voice signal and buffer length', () => {
  const sr = 48000;
  const roomTone = createBroadbandNoise(24000, 0.05);
  const denoiser = new SpectralWienerDenoiserEngine(roomTone);

  // First 0.5s: 320Hz speech + noise; Second 0.5s: noise-only segment
  const mixed = createBroadbandNoise(sr, 0.05);
  for (let i = 0; i < sr / 2; i++) {
    mixed[i] += 0.35 * Math.sin((2 * Math.PI * 320 * i) / sr);
  }

  const cleaned = denoiser.processChunk(mixed, 0.9);
  assert.equal(cleaned.length, mixed.length);

  // Noise-only region [26000..46000] must drop substantially (>3x RMS reduction)
  const noiseBeforeRms = rmsSlice(mixed, 26000, 46000);
  const noiseAfterRms = rmsSlice(cleaned, 26000, 46000);
  assert.ok(
    noiseAfterRms < noiseBeforeRms * 0.35,
    `Expected noise RMS drop >3x: before=${noiseBeforeRms.toFixed(4)}, after=${noiseAfterRms.toFixed(4)}`,
  );

  // Vocal region [2000..22000] must retain its speech energy cleanly
  const speechBeforeRms = rmsSlice(mixed, 2000, 22000);
  const speechAfterRms = rmsSlice(cleaned, 2000, 22000);
  assert.ok(
    speechAfterRms > speechBeforeRms * 0.8,
    `Expected speech preservation >80%: before=${speechBeforeRms.toFixed(4)}, after=${speechAfterRms.toFixed(4)}`,
  );
});
