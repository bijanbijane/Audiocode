import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveDeviceTier } from './StudioRootBootstrapper';

test('resolveEffectiveDeviceTier respects URL tier overrides and falls back to hardware detection', () => {
  assert.equal(resolveEffectiveDeviceTier('DESKTOP_STUDIO', ''), 'DESKTOP_STUDIO');
  assert.equal(resolveEffectiveDeviceTier('DESKTOP_STUDIO', '?tier=mobile'), 'MOBILE_COMPANION');
  assert.equal(resolveEffectiveDeviceTier('MOBILE_COMPANION', '?tier=tablet'), 'TABLET_STUDIO');
  assert.equal(resolveEffectiveDeviceTier('MOBILE_COMPANION', '?tier=desktop'), 'DESKTOP_STUDIO');
});
