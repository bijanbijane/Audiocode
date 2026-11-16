import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticVerticalSliceHarness } from './SyntheticVerticalSliceHarness';

test('Section 94: SyntheticVerticalSliceHarness executes all 6 end-to-end stages in memory with zero external files', () => {
  const result = SyntheticVerticalSliceHarness.runCompleteSyntheticPipeline();
  assert.equal(result.allStagesPassed, true);
  assert.equal(result.detected50HzHum, true);
  assert.ok(result.repairedMouthClicks >= 1);
  assert.ok(result.detectedDisfluenciesCount >= 1);
  assert.ok(result.finalTruePeakDbtp <= -0.95);
  assert.ok(result.editSmoothnessScore >= 85);
});
