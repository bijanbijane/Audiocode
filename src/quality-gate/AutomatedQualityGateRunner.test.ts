import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomatedQualityGateRunner } from './AutomatedQualityGateRunner';

test('AutomatedQualityGateRunner passes all 4 core release quality gates', () => {
  const report = AutomatedQualityGateRunner.runAllCoreQualityGates();
  assert.equal(report.results.length, 4);
  for (const r of report.results) {
    assert.equal(r.passed, true, `Gate failed: ${r.gateName} -> ${r.measuredValue}`);
  }
  assert.equal(report.allGatesPassed, true);
});

test('AutomatedQualityGateRunner computePersianWER distinguishes raw vs normalized Yeh/Kaf & ZWNJ differences', () => {
  const ref = 'می‌خواهم کتاب‌های فارسی را بررسی کنم';
  const hypWithArabicAndSpace = 'می خواهم كتاب های فارسی را بررسی كنم';

  const wer = AutomatedQualityGateRunner.computePersianWER(ref, hypWithArabicAndSpace);
  // Raw WER penalizes missing ZWNJ and Arabic kaf, whereas normalized WER is 0%
  assert.ok(wer.rawWerPercent > 0);
  assert.equal(wer.normalizedWerPercent, 0);
});
