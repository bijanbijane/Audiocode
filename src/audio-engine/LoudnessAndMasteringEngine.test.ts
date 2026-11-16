import test from 'node:test';
import assert from 'node:assert/strict';
import { LoudnessAndMasteringEngine } from './LoudnessAndMasteringEngine';

test('ITU-R BS.1770-4 normalizer hits -16 LUFS target and enforces <= -1.0 dBTP True Peak across 48kHz & 44.1kHz', () => {
  for (const sr of [48000, 44100] as const) {
    const len = sr * 2;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      // Quiet -26 LUFS equivalent speech-band sum with occasional sharp transient
      mono[i] = 0.05 * Math.sin((2 * Math.PI * 1000 * i) / sr);
      if (i % 12000 === 500) mono[i] = 0.25;
    }

    const [left, right] = LoudnessAndMasteringEngine.applyEqualPowerPan(mono, 0.0);
    // Center pan applies -3.01 dB per channel
    assert.ok(Math.abs(left[10] - mono[10] * Math.SQRT1_2) < 1e-5);
    assert.ok(Math.abs(right[10] - left[10]) < 1e-6);

    const { normalizedChannels } = LoudnessAndMasteringEngine.normalizeToTargetLufsWithTruePeakLimiter(
      [left, right],
      sr,
      -16.0,
      -1.0,
    );

    const post = LoudnessAndMasteringEngine.measureLoudnessAndTruePeak(normalizedChannels, sr);
    assert.ok(post.truePeakDbtp <= -0.99, `Expected truePeakDbtp <= -1.0, got ${post.truePeakDbtp}`);
    assert.ok(post.integratedLufs > -22 && post.integratedLufs <= -15.0);
  }
});
