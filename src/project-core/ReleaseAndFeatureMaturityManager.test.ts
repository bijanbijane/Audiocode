import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReleaseAndFeatureMaturityManager,
  StagedReleaseBundle,
} from './ReleaseAndFeatureMaturityManager';

const v1: StagedReleaseBundle = {
  releaseId: 'rel-1.2.0',
  versions: {
    projectSchemaVersion: 2,
    audioEngineVersion: '1.2.0',
    processingNodeCatalogVersion: '1.2',
    activeModelBundleVersion: '2.4.1',
  },
  minCompatibleSchemaVersion: 1,
  stagedAtTimestamp: 1000,
};

const v2: StagedReleaseBundle = {
  ...v1,
  releaseId: 'rel-1.3.0',
  stagedAtTimestamp: 2000,
};

test('ReleaseAndFeatureMaturityManager defers updates while project active, commits cleanly on idle, and supports instant rollback', () => {
  const mgr = new ReleaseAndFeatureMaturityManager(v1, [
    {
      featureId: 'ai-diarization-beta',
      titleFa: 'تفکیک گویندگان',
      stage: 'BETA',
      minRequiredDeviceTier: 'TABLET_STUDIO',
    },
    {
      featureId: 'experimental-neural-eq',
      titleFa: 'اکولایزر عصبی آزمایشی',
      stage: 'EXPERIMENTAL',
      minRequiredDeviceTier: 'DESKTOP_STUDIO',
    },
  ]);

  assert.equal(mgr.canActivateFeature('experimental-neural-eq', false).allowed, false);
  assert.equal(mgr.canActivateFeature('experimental-neural-eq', true, 'MOBILE_COMPANION').allowed, false);
  assert.equal(mgr.canActivateFeature('experimental-neural-eq', true, 'DESKTOP_STUDIO').allowed, true);
  assert.equal(mgr.canActivateFeature('ai-diarization-beta', false).badgeFa, 'نسخه بتا (Beta)');

  mgr.stageUpdateInBackground(v2);

  // Blocked while project is open
  const busyRes = mgr.commitStagedUpdateIfSafe({
    hasActiveOpenProject: true,
    hasRunningJobs: false,
  });
  assert.equal(busyRes.committed, false);
  assert.equal(busyRes.activeRelease.releaseId, 'rel-1.2.0');

  // Committed once idle
  const idleRes = mgr.commitStagedUpdateIfSafe({
    hasActiveOpenProject: false,
    hasRunningJobs: false,
  });
  assert.equal(idleRes.committed, true);
  assert.equal(idleRes.activeRelease.releaseId, 'rel-1.3.0');

  // Instant rollback
  const rolledBack = mgr.rollbackToPreviousRelease();
  assert.equal(rolledBack.releaseId, 'rel-1.2.0');
});
