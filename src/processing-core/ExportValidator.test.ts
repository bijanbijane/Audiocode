import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportValidator } from './ExportValidator';

test('ExportValidator passes clean faded PCM matching expected duration', () => {
  const sr = 48000;
  const buf = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    const env = i < 480 ? i / 480 : i > sr - 480 ? (sr - 1 - i) / 480 : 1;
    buf[i] = 0.5 * env * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  const report = ExportValidator.validateRenderedPcm([buf], sr, 1.0);
  assert.equal(report.passed, true);
  assert.equal(report.clippedSamplesCount, 0);
  assert.equal(report.hasStartOrEndClickRisk, false);
  assert.equal(report.errors.length, 0);
});

test('ExportValidator flags clipping, duration mismatch, and boundary click risk', () => {
  const sr = 48000;
  const buf = new Float32Array(sr / 2); // 0.5s vs 1.0s expected
  buf.fill(1.0); // Clipping + high amplitude at start/end boundaries

  const report = ExportValidator.validateRenderedPcm([buf], sr, 1.0);
  assert.equal(report.passed, false);
  assert.equal(report.clippedSamplesCount, sr / 2);
  assert.equal(report.hasStartOrEndClickRisk, true);
  assert.ok(report.errors.some((e) => e.includes('EXPORT_DURATION_MISMATCH')));
  assert.ok(report.errors.some((e) => e.includes('EXPORT_CLIPPING_DETECTED')));
  assert.ok(report.errors.some((e) => e.includes('EXPORT_BOUNDARY_CLICK_RISK')));
});
