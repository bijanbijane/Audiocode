import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEqualPowerMicroCrossfade,
  detectLongPauses,
  detectPitchPlateauSegments,
  extractAcousticProfile,
  snapToZeroCrossing,
  synthesizeRoomToneFill,
} from './dsp';

test('snapToZeroCrossing locks cut index to nearest zero crossing', () => {
  const sampleRate = 48_000;
  const buf = new Float32Array(2000);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.sin((2 * Math.PI * 200 * i) / sampleRate);
  }
  const candidate = 300;
  const snapped = snapToZeroCrossing(buf, candidate, 240);
  assert.ok(snapped.adjusted);
  const val = buf[snapped.index];
  const nextVal = buf[snapped.index + 1];
  assert.ok((val <= 0 && nextVal > 0) || (val >= 0 && nextVal < 0));
});

test('Equal-Power Micro-Crossfade maintains constant power across transition', () => {
  const len = 480; // 10ms at 48kHz
  const left = new Float32Array(len).fill(1.0);
  const right = new Float32Array(len).fill(1.0);
  const mixed = applyEqualPowerMicroCrossfade(left, right);
  const mid = mixed[Math.floor(len / 2)];
  // cos(pi/4) + sin(pi/4) = sqrt(2) ~ 1.414 for correlated DC signals; endpoints remain exact 1.0
  assert.ok(Math.abs(mixed[0] - 1.0) < 1e-5);
  assert.ok(Math.abs(mixed[len - 1] - 1.0) < 1e-5);
  assert.ok(mid > 1.35);
});

test('detectPitchPlateauSegments identifies co-articulated stretched vowel without RMS valley', () => {
  const sampleRate = 16_000;
  const len = sampleRate * 1.2;
  const buf = new Float32Array(len);
  // First 0.3s: silence, next 0.6s: steady 140Hz voiced vowel stretch (e.g. رفتیمممم), last 0.3s: silence
  for (let i = Math.floor(0.3 * sampleRate); i < Math.floor(0.9 * sampleRate); i++) {
    const t = i / sampleRate;
    buf[i] = 0.25 * Math.sin(2 * Math.PI * 140 * t) + 0.1 * Math.sin(2 * Math.PI * 280 * t);
  }
  const plateaus = detectPitchPlateauSegments(buf, sampleRate, 250);
  assert.ok(plateaus.length >= 1, 'Expected at least 1 pitch plateau segment');
  assert.ok(Math.abs(plateaus[0].f0Hz - 140) <= 10);
});

test('extractAcousticProfile and detectLongPauses find room tone and pauses', () => {
  const sampleRate = 16_000;
  const buf = new Float32Array(sampleRate * 2);
  // Subtle room tone floor throughout
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 0.002 * Math.sin(i * 0.37);
  }
  // Speech burst 0.1s..0.5s and 1.4s..1.9s -> pause in [0.5s..1.4s] (900ms)
  for (let i = 1600; i < 8000; i++) {
    buf[i] += 0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
  for (let i = 22400; i < 30400; i++) {
    buf[i] += 0.3 * Math.sin((2 * Math.PI * 240 * i) / sampleRate);
  }

  const profile = extractAcousticProfile('test-asset', buf, sampleRate);
  assert.ok(profile.noiseFloorDbfs < -40);
  const pauses = detectLongPauses(buf, sampleRate, profile, 600);
  assert.ok(pauses.length >= 1);
  assert.ok(pauses[0].durationMs >= 750);

  const fill = synthesizeRoomToneFill(profile, 8000);
  assert.equal(fill.length, 8000);
});
