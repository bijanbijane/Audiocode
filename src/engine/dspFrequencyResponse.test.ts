import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDspResponseSvgPaths,
  compute1PoleHpfAlpha,
  compute1PoleHpfMagnitudeDb,
  computeDownwardCompressorGainDb,
  computeDspFrequencyResponseCurve,
} from './dspFrequencyResponse';
import { EphemeralDspParams } from '../contracts/v1_2';

const BASE_PARAMS: EphemeralDspParams = {
  highPassHz: 80,
  compressorThresholdDb: -18,
  compressorRatio: 3.0,
  noiseGateThresholdDb: -50,
  masterGainDb: 0,
};

test('1-pole HPF exhibits ~ -3dB attenuation at cutoff frequency and increases sub-bass cut when raised', () => {
  const alpha80 = compute1PoleHpfAlpha(80, 48000);
  const gainAt80 = compute1PoleHpfMagnitudeDb(80, 48000, alpha80);
  assert.ok(gainAt80 > -3.3 && gainAt80 < -2.7, `Expected ~ -3.0dB at fc=80Hz, got ${gainAt80}`);

  const gainAt1000 = compute1PoleHpfMagnitudeDb(1000, 48000, alpha80);
  assert.ok(gainAt1000 > -0.1 && gainAt1000 <= 0, `Expected ~0dB at 1kHz, got ${gainAt1000}`);

  const curve80 = computeDspFrequencyResponseCurve(BASE_PARAMS, { sampleRate: 48000, referenceInputDb: -6 });
  const curve200 = computeDspFrequencyResponseCurve(
    { ...BASE_PARAMS, highPassHz: 200 },
    { sampleRate: 48000, referenceInputDb: -6 },
  );

  // Raising HPF from 80Hz to 200Hz strongly attenuates 50Hz
  const pt50_80 = curve80.points.find((p) => p.freqHz >= 50)!;
  const pt50_200 = curve200.points.find((p) => p.freqHz >= 50)!;
  assert.ok(pt50_200.hpfGainDb < pt50_80.hpfGainDb - 4);
});

test('Downward compressor applies accurate gain reduction above threshold and preserves passband below threshold', () => {
  // Below threshold: 0 reduction
  assert.equal(computeDownwardCompressorGainDb(-24, -18, 4), 0);
  // 12 dB over -18 dB threshold at 3:1 -> compressed to -18 + 4 = -14 -> -8 dB reduction
  assert.ok(Math.abs(computeDownwardCompressorGainDb(-6, -18, 3) - (-8)) < 1e-6);

  const gentle = computeDspFrequencyResponseCurve(
    { ...BASE_PARAMS, compressorThresholdDb: -12, compressorRatio: 2 },
    { sampleRate: 48000, referenceInputDb: -6 },
  );
  const heavy = computeDspFrequencyResponseCurve(
    { ...BASE_PARAMS, compressorThresholdDb: -30, compressorRatio: 6 },
    { sampleRate: 48000, referenceInputDb: -6 },
  );

  assert.ok(Math.abs(gentle.passbandReductionDb - (-3)) < 0.1, `Expected ~ -3dB GR, got ${gentle.passbandReductionDb}`);
  assert.ok(Math.abs(heavy.passbandReductionDb - (-20)) < 0.1, `Expected ~ -20dB GR, got ${heavy.passbandReductionDb}`);
  assert.ok(heavy.effectiveAt1kHzDb < gentle.effectiveAt1kHzDb);
});

test('SVG path builder produces valid monotonic log-X curves and updates cutoff marker on HPF change', () => {
  const c1 = computeDspFrequencyResponseCurve(BASE_PARAMS, { sampleRate: 48000 });
  const c2 = computeDspFrequencyResponseCurve({ ...BASE_PARAMS, highPassHz: 180 }, { sampleRate: 48000 });

  const svg1 = buildDspResponseSvgPaths(c1, 600, 180);
  const svg2 = buildDspResponseSvgPaths(c2, 600, 180);

  assert.ok(svg1.staticPath.startsWith('M0,'));
  assert.ok(svg1.effectivePath.startsWith('M0,'));
  assert.ok(svg1.reductionAreaPath.endsWith('Z'));
  assert.ok(svg2.cutoffPoint.x > svg1.cutoffPoint.x);
  assert.notEqual(svg1.effectivePath, svg2.effectivePath);
});
