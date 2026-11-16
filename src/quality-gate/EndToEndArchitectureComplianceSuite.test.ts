import test from 'node:test';
import assert from 'node:assert/strict';
import { EndToEndArchitectureComplianceSuite } from './EndToEndArchitectureComplianceSuite';

test('EndToEndArchitectureComplianceSuite verifies all 32 architecture golden principles end-to-end', async () => {
  const result = await EndToEndArchitectureComplianceSuite.runFullSystemComplianceVerification();
  assert.equal(result.allChecksPassed, true);
  assert.equal(result.verifiedRulesCount, 32);
  assert.equal(result.diagnostics.length, 7);
  for (const line of result.diagnostics) {
    assert.ok(line.startsWith('PASS:'));
  }
});
