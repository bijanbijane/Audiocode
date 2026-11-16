import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeStretchWsolaEngine } from './TimeStretchWsolaEngine';

function estimateDominantFreqZeroCrossings(pcm: Float32Array, sampleRate: number): number {
  let risingCrossings = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  const start = Math.floor(pcm.length * 0.15);
  const end = Math.floor(pcm.length * 0.85);

  for (let i = start + 1; i < end; i++) {
    if (pcm[i - 1] < 0 && pcm[i] >= 0) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
      risingCrossings++;
    }
  }
  if (risingCrossings < 2 || lastIdx <= firstIdx) return 0;
  const elapsedSec = (lastIdx - firstIdx) / sampleRate;
  return (risingCrossings - 1) / elapsedSec;
}

test('Section 65: TimeStretchWsolaEngine speeds up (1.5x) and slows down (0.8x) speech while preserving fundamental pitch F0', () => {
  const sr = 48000 as const;
  const f0 = 160; // 160 Hz fundamental voice tone
  const inputLen = sr; // 1.0 second
  const inputPcm = new Float32Array(inputLen);
  for (let i = 0; i < inputLen; i++) {
    inputPcm[i] =
      0.4 * Math.sin((2 * Math.PI * f0 * i) / sr) +
      0.15 * Math.sin((2 * Math.PI * (f0 * 2) * i) / sr);
  }

  // 1.5x faster -> duration ~0.666s, pitch remains ~160Hz (NOT 240Hz chipmunk!)
  const fasterPcm = TimeStretchWsolaEngine.processTimeStretch(inputPcm, sr, 1.5);
  assert.equal(fasterPcm.length, Math.floor(inputLen / 1.5));
  const fasterPitch = estimateDominantFreqZeroCrossings(fasterPcm, sr);
  assert.ok(
    Math.abs(fasterPitch - f0) < 8,
    `Expected WSOLA 1.5x pitch near ${f0}Hz, got ${fasterPitch.toFixed(1)}Hz`,
  );

  // 0.8x slower -> duration 1.25s, pitch remains ~160Hz
  const slowerPcm = TimeStretchWsolaEngine.processTimeStretch(inputPcm, sr, 0.8);
  assert.equal(slowerPcm.length, Math.floor(inputLen / 0.8));
  const slowerPitch = estimateDominantFreqZeroCrossings(slowerPcm, sr);
  assert.ok(
    Math.abs(slowerPitch - f0) < 8,
    `Expected WSOLA 0.8x pitch near ${f0}Hz, got ${slowerPitch.toFixed(1)}Hz`,
  );
});
