import test from 'node:test';
import assert from 'node:assert/strict';
import { clampMobileRecommendationIndex } from './MobileCompanionWorkspace';

test('clampMobileRecommendationIndex safely clamps index when pending list shrinks after triage', () => {
  assert.equal(clampMobileRecommendationIndex(0, 0), 0);
  assert.equal(clampMobileRecommendationIndex(2, 0), 0);
  assert.equal(clampMobileRecommendationIndex(2, 2), 1);
  assert.equal(clampMobileRecommendationIndex(-3, 5), 0);
  assert.equal(clampMobileRecommendationIndex(1, 3), 1);
});
