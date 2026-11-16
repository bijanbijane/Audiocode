import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelAndPhaseAlignmentEngine } from './ChannelAndPhaseAlignmentEngine';

test('ChannelAndPhaseAlignmentEngine detects 180-degree polarity inversion and fixes mono phase cancellation', () => {
  const sampleRate = 48000 as const;
  const len = 4800; // 100ms
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const val = 0.4 * Math.sin(2 * Math.PI * 240 * (i / sampleRate));
    left[i] = val;
    right[i] = -val; // 180-degree inverted mic polarity
  }

  const fixed = ChannelAndPhaseAlignmentEngine.alignAndFixStereoChannels(
    left,
    right,
    sampleRate,
  );

  assert.equal(fixed.diagnosticBefore.isPolarityInverted, true);
  assert.equal(fixed.diagnosticBefore.monoCollapseRisk, 'SEVERE_PHASE_CANCELLATION');
  assert.ok(fixed.diagnosticBefore.zeroLagPhaseCorrelation < -0.99);
  assert.ok(fixed.diagnosticBefore.monoFoldDownLossDb < -20);

  assert.equal(fixed.appliedPolarityFlip, true);
  assert.ok(fixed.correlationAfterAlignment > 0.999);
});

test('ChannelAndPhaseAlignmentEngine aligns delayed multi-harmonic stereo speech signal and reverses comb-filter risk', () => {
  const sampleRate = 48000 as const;
  const len = 9600; // 200ms
  const base = new Float32Array(len);

  // Rich speech-like multi-harmonic + modulated waveform so cross-correlation has unique non-periodic peak
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const env = Math.sin(Math.PI * (i / len));
    base[i] =
      env *
      (0.35 * Math.sin(2 * Math.PI * 190 * t) +
        0.22 * Math.sin(2 * Math.PI * 530 * t) +
        0.15 * Math.sin(2 * Math.PI * 1370 * t));
  }

  // Right mic is delayed by 42 samples (~0.875ms) AND polarity-inverted
  const delaySamples = 42;
  const left = base;
  const right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const srcIdx = i - delaySamples;
    right[i] = srcIdx >= 0 ? -base[srcIdx] : 0;
  }

  const fixed = ChannelAndPhaseAlignmentEngine.alignAndFixStereoChannels(
    left,
    right,
    sampleRate,
  );

  assert.equal(fixed.diagnosticBefore.isPolarityInverted, true);
  assert.ok(
    Math.abs(fixed.appliedShiftSamples - delaySamples) < 1.0,
    `Expected lag ~${delaySamples}, got ${fixed.appliedShiftSamples}`,
  );
  assert.ok(
    fixed.correlationAfterAlignment > 0.95,
    `Expected correlation > 0.95 after alignment, got ${fixed.correlationAfterAlignment}`,
  );
});

test('ChannelAndPhaseAlignmentEngine compatibility report & alignPhaseAndPolarity work for inverted and delayed signals', () => {
  const sampleRate = 48000 as const;
  const len = 48000; // 1s
  const left = new Float32Array(len);
  const rightInv = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const s = 0.4 * Math.sin((2 * Math.PI * 250 * i) / sampleRate);
    left[i] = s;
    rightInv[i] = -s;
  }

  const reportInv = ChannelAndPhaseAlignmentEngine.analyzePhaseAndChannelCompatibility(
    left,
    rightInv,
    sampleRate,
  );
  assert.equal(reportInv.isPolarityInverted, true);
  assert.equal(reportInv.optimalDelayLagSamples, 0);
  assert.ok(reportInv.phaseCorrelation < -0.95);
  assert.ok(reportInv.monoCompatibilityLossDb > 20);

  const corrected = ChannelAndPhaseAlignmentEngine.alignPhaseAndPolarity(
    left,
    rightInv,
    reportInv.optimalDelayLagSamples,
    reportInv.isPolarityInverted,
  );
  const postCorr = ChannelAndPhaseAlignmentEngine.computeZeroLagCorrelation(left, corrected);
  assert.ok(postCorr > 0.999);
});

test('ChannelAndPhaseAlignmentEngine.applyChannelRouting handles all 6 routing modes accurately', () => {
  const left = new Float32Array([0.5, -0.5, 0.25]);
  const right = new Float32Array([0.1, 0.3, -0.4]);

  const [ptL, ptR] = ChannelAndPhaseAlignmentEngine.applyChannelRouting(left, right, 'STEREO_PASS_THROUGH');
  assert.deepEqual(Array.from(ptL), Array.from(left));
  assert.deepEqual(Array.from(ptR), Array.from(right));

  const [lmL, lmR] = ChannelAndPhaseAlignmentEngine.applyChannelRouting(left, right, 'LEFT_CHANNEL_TO_MONO');
  assert.deepEqual(Array.from(lmL), Array.from(left));
  assert.deepEqual(Array.from(lmR), Array.from(left));

  const [rmL, rmR] = ChannelAndPhaseAlignmentEngine.applyChannelRouting(left, right, 'RIGHT_CHANNEL_TO_MONO');
  assert.deepEqual(Array.from(rmL), Array.from(right));
  assert.deepEqual(Array.from(rmR), Array.from(right));

  const [swL, swR] = ChannelAndPhaseAlignmentEngine.applyChannelRouting(left, right, 'SWAP_LEFT_RIGHT');
  assert.deepEqual(Array.from(swL), Array.from(right));
  assert.deepEqual(Array.from(swR), Array.from(left));

  const [invL, invR] = ChannelAndPhaseAlignmentEngine.applyChannelRouting(left, right, 'INVERT_RIGHT_POLARITY');
  assert.deepEqual(Array.from(invL), Array.from(left));
  assert.ok(Math.abs(invR[0] + right[0]) < 1e-6);
  assert.ok(Math.abs(invR[2] + right[2]) < 1e-6);

  const [msL, msR] = ChannelAndPhaseAlignmentEngine.applyChannelRouting(left, right, 'MONO_SUM_PHASE_SAFE');
  const expectedSum0 = (0.5 + 0.1) * Math.SQRT1_2;
  assert.ok(Math.abs(msL[0] - expectedSum0) < 1e-6);
  assert.equal(msL[0], msR[0]);
});

