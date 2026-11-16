import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseReadinessSignOffAuditor } from './ReleaseReadinessSignOffAuditor';

test('Section 91: ReleaseReadinessSignOffAuditor approves when all 11 MVP criteria and 10 gates pass and blocks on any failure', () => {
  const fullPassEvidence = {
    importToExportWorksOfflineWithoutExternalApi: true,
    zeroWaitGroupAAvailableImmediatelyAfterImport: true,
    projectSurvivesTabCloseAndCrashRecovery: true,
    originalSourceAssetByteHashUnchanged: true,
    persianAsrBenchmarkedOnTargetDevices: true,
    postEditSplicesClickFreeAndPreserveEzafe: true,
    smartSuggestionsRequireExplicitUserApproval: true,
    playbackUnderrunsZeroDuringBackgroundAi: true,
    storageAndOpfsLockErrorsZeroUnderStress: true,
    fourWayVersionsAndModelProvenanceTracked: true,
    deviceRamAndDurationLimitsShownTransparently: true,
    gates: {
      functional: true,
      audioQuality: true,
      persianAiAndProsodicQuality: true,
      performance: true,
      memoryDiskAndStability: true,
      storageAndRecovery: true,
      securityAndCrossOriginIsolation: true,
      compatibilityAcrossDesktopAndIos: true,
      regression: true,
      userAcceptance: true,
    },
  };

  const passVerdict = ReleaseReadinessSignOffAuditor.evaluateReleaseSignOff(fullPassEvidence);
  assert.equal(passVerdict.approvedForRelease, true);
  assert.equal(passVerdict.mvpCriteriaPassedCount, 11);
  assert.equal(passVerdict.releaseGatesPassedCount, 10);
  assert.equal(passVerdict.blockingFailures.length, 0);

  const failedVerdict = ReleaseReadinessSignOffAuditor.evaluateReleaseSignOff({
    ...fullPassEvidence,
    smartSuggestionsRequireExplicitUserApproval: false,
  });
  assert.equal(failedVerdict.approvedForRelease, false);
  assert.equal(failedVerdict.blockingFailures.length, 1);
});
