import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLabModeHref, isLabModeEnabled } from './labMode.ts';

test('isLabModeEnabled returns false for normal creator URLs', () => {
  assert.equal(isLabModeEnabled(''), false);
  assert.equal(isLabModeEnabled('?view=studio'), false);
  assert.equal(isLabModeEnabled('?mode=studio&project=123'), false);
});

test('isLabModeEnabled unlocks R&D lab views when mode=lab or lab=1', () => {
  assert.equal(isLabModeEnabled('?mode=lab'), true);
  assert.equal(isLabModeEnabled('?view=studio&mode=LAB'), true);
  assert.equal(isLabModeEnabled('?lab=1'), true);
});

test('buildLabModeHref appends mode=lab while preserving existing query parameters', () => {
  assert.equal(
    buildLabModeHref('http://localhost:3000/?view=studio&project=ep42'),
    '/?view=studio&project=ep42&mode=lab',
  );
});
