import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import { SpeechDataFactoryService } from '../../data-factory/SpeechDataFactoryService';
import { SpeechModelFactoryService } from '../SpeechModelFactoryService';
import { computePairedBootstrapCi } from '../EvaluationAndPromotionEngine';

async function setupSeededFactories() {
  const cp = new PlatformControlPlaneService();
  const df = new SpeechDataFactoryService(cp);
  const mf = new SpeechModelFactoryService(cp, df);
  await mf.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
  const ds = df.listDatasets('org_avapardaz_sandbox')[0];
  const rel = df.listDatasetReleases('org_avapardaz_sandbox', ds.datasetId)[0];
  return { cp, df, mf, releaseId: rel.datasetReleaseId };
}

test('Phase 13.1 & 13.2: Experiment immutability, GPU preflight honesty, cancellation, interruption & checkpoint resume recovery', async () => {
  const { mf, releaseId } = await setupSeededFactories();
  const tenantId = 'org_avapardaz_sandbox';

  // Reject missing dataset reference
  assert.throws(
    () =>
      mf.createExperiment({
        tenantId,
        projectId: 'prj_avapardaz_dev_01',
        experimentName: 'invalid_no_ds',
        primaryObjective: 'PERSIAN_CER_REDUCTION',
        hypothesis: {
          problemAddressed: 'none',
          proposedChange: 'none',
          expectedMeasurableEffect: 'none',
          affectedDatasetSlices: ['persian_fa'],
          possibleNegativeEffects: 'none',
          acceptanceCriterion: 'none',
        },
        modelFamily: 'avapardaz_local_ctc_adapter',
        architecture: 'SpectralCTC-BigramAdapter-v1',
        initializationType: 'ADAPTER_TUNING',
        baseModelVersion: 'ASR-FA-EN-0.9.0-BASELINE',
        datasetReleaseIds: [],
        ownerId: 'usr_1',
      }),
    /DATASET_REFERENCE_REQUIRED/
  );

  // GPU_MEDIUM in G0_CPU_ONLY container must fail preflight honestly -> status BLOCKED!
  const gpuExp = mf.createExperiment({
    tenantId,
    projectId: 'prj_avapardaz_dev_01',
    experimentName: 'gpu_blocked_test',
    primaryObjective: 'PERSIAN_WER_REDUCTION',
    hypothesis: {
      problemAddressed: 'Need VRAM check',
      proposedChange: 'Request GPU_MEDIUM',
      expectedMeasurableEffect: 'Preflight blocks cleanly on CPU container',
      affectedDatasetSlices: ['overall'],
      possibleNegativeEffects: 'None',
      acceptanceCriterion: 'BLOCKED state returned',
    },
    modelFamily: 'qwen3_asr',
    architecture: 'AuT-Qwen3-1.7B-LoRA',
    initializationType: 'PARAMETER_EFFICIENT_FINE_TUNING',
    baseModelVersion: 'Qwen/Qwen3-ASR-1.7B',
    datasetReleaseIds: [releaseId],
    requestedResourceClass: 'GPU_MEDIUM',
    ownerId: 'usr_1',
  });
  const blockedRun = mf.startTrainingRun({
    tenantId,
    experimentId: gpuExp.experimentId,
    resourceClass: 'GPU_MEDIUM',
  });
  assert.equal(blockedRun.status, 'BLOCKED');
  assert.equal(blockedRun.failureCategory, 'GPU_UNAVAILABLE');
  assert.equal(blockedRun.preflightPassed, false);

  // CPU_ONLY real run interrupted at step 4 -> verify atomic checkpoint -> resume to step 12!
  const cpuExp = mf.createExperiment({
    tenantId,
    projectId: 'prj_avapardaz_dev_01',
    experimentName: 'cpu_recovery_test',
    primaryObjective: 'CODE_SWITCHING_IMPROVEMENT',
    hypothesis: {
      problemAddressed: 'Recovery check',
      proposedChange: 'Interrupt step 4 then resume to step 12',
      expectedMeasurableEffect: 'Preserves exact step and loss curve',
      affectedDatasetSlices: ['persian_fa', 'code_switching_fa_en'],
      possibleNegativeEffects: 'None',
      acceptanceCriterion: 'Completed cleanly from step 4',
    },
    modelFamily: 'avapardaz_local_ctc_adapter',
    architecture: 'SpectralCTC-BigramAdapter-v1',
    initializationType: 'ADAPTER_TUNING',
    baseModelVersion: 'ASR-FA-EN-0.9.0-BASELINE',
    configuration: { maxTrainingSteps: 12, checkpointEverySteps: 4, validationEverySteps: 4 },
    datasetReleaseIds: [releaseId],
    requestedResourceClass: 'CPU_ONLY',
    ownerId: 'usr_1',
  });

  const interrupted = mf.startTrainingRun({
    tenantId,
    experimentId: cpuExp.experimentId,
    interruptAfterStep: 4,
  });
  assert.equal(interrupted.status, 'INTERRUPTED');
  assert.equal(interrupted.currentStep, 4);
  const ckpts = mf.listCheckpointsForRun(tenantId, interrupted.trainingRunId);
  assert.equal(ckpts.length, 1);
  assert.equal(ckpts[0].integrityStatus, 'COMMITTED');

  // Resume cleanly from step 4 -> completes at step 12
  const resumed = mf.resumeTrainingRun({
    tenantId,
    runId: interrupted.trainingRunId,
    checkpointId: ckpts[0].checkpointId,
  });
  assert.equal(resumed.status, 'COMPLETED');
  assert.equal(resumed.currentStep, 12);
  assert.equal(resumed.resumedFromCheckpointId, ckpts[0].checkpointId);

  // NaN loss test
  const nanExp = mf.createExperiment({
    tenantId,
    projectId: 'prj_avapardaz_dev_01',
    experimentName: 'nan_stability_test',
    primaryObjective: 'PERSIAN_CER_REDUCTION',
    hypothesis: {
      problemAddressed: 'NaN detection',
      proposedChange: 'Inject NaN at step 3',
      expectedMeasurableEffect: 'Fails with NAN_LOSS category',
      affectedDatasetSlices: ['overall'],
      possibleNegativeEffects: 'Fails',
      acceptanceCriterion: 'NAN_LOSS recorded',
    },
    modelFamily: 'avapardaz_local_ctc_adapter',
    architecture: 'SpectralCTC-BigramAdapter-v1',
    initializationType: 'ADAPTER_TUNING',
    baseModelVersion: 'ASR-FA-EN-0.9.0-BASELINE',
    configuration: { maxTrainingSteps: 8, checkpointEverySteps: 2 },
    datasetReleaseIds: [releaseId],
    requestedResourceClass: 'CPU_ONLY',
    ownerId: 'usr_1',
  });
  const nanRun = mf.startTrainingRun({ tenantId, experimentId: nanExp.experimentId, injectNanAtStep: 3 });
  assert.equal(nanRun.status, 'FAILED');
  assert.equal(nanRun.failureCategory, 'NAN_LOSS');

  // Corrupt checkpoint guard check
  mf.tamperCheckpointPayloadForTest(ckpts[0].checkpointId);
  assert.throws(
    () => mf.resumeTrainingRun({ tenantId, runId: interrupted.trainingRunId, checkpointId: ckpts[0].checkpointId }),
    /CHECKPOINT_CORRUPT_HASH/
  );
});

test('Phase 13.3–13.7: Eval slices + Bootstrap CI, Immutable Registry + Tamper Guard, Security & Router Integration + Session-Pinned Rollback', async () => {
  const { mf, releaseId } = await setupSeededFactories();
  const tenantId = 'org_avapardaz_sandbox';

  // Paired Bootstrap CI direct math test
  const ci = computePairedBootstrapCi({
    metricName: 'cer',
    baselinePerSample: [10, 12, 11, 9, 13, 10, 12, 11],
    candidatePerSample: [3, 4, 3, 2, 4, 3, 4, 3],
    iterations: 600,
    seed: 7,
  });
  assert.ok(ci.meanDeltaCandidateMinusBaseline < -6);
  assert.equal(ci.statisticallySignificantImprovement, true);

  const summary = mf.getSandboxLifecycleSummary(tenantId);
  // 1. Seeded v1.0.0 should be in PRODUCTION and exported to Phase 6 Adaptive Router!
  const prodModel = summary.models.find((m) => m.version === '1.0.0');
  const researchModel = summary.models.find((m) => m.lifecycleStatus === 'RESEARCH');
  assert.ok(prodModel);
  assert.ok(researchModel);
  assert.equal(prodModel!.lifecycleStatus, 'PRODUCTION');

  // Verify Adaptive Router bridge ONLY contains routable verified models & excludes RESEARCH model
  const routerList = mf.exportVerifiedModelsForAdaptiveRouter(tenantId);
  assert.ok(routerList.some((r) => r.model_revision === '1.0.0'));
  assert.equal(routerList.some((r) => r.model_identifier === 'qwen3-asr-1.7b-research'), false);

  // Unapproved RESEARCH model CANNOT deploy to CANARY/PRODUCTION
  const resPkg = mf.packageAndValidateModel({ tenantId, modelVersionId: researchModel!.modelVersionId });
  assert.throws(
    () =>
      mf.deployModelVersion({
        tenantId,
        modelVersionId: researchModel!.modelVersionId,
        packageId: resPkg.packageId,
        environment: 'PRODUCTION',
        strategy: 'FULL_PRODUCTION',
        trafficPercentage: 100,
        actorId: 'usr_1',
        actorRole: 'OWNER',
      }),
    /UNAPPROVED_MODEL_DEPLOYMENT_DENIED/
  );

  // Optimization registers a NEW immutable version without overwriting parent
  const opt = mf.optimizeAndRegisterDerivedVersion({
    tenantId,
    parentModelVersionId: prodModel!.modelVersionId,
    newVersion: '1.0.0-int8',
    technique: 'DYNAMIC_INT8_QUANTIZATION',
  });
  assert.equal(opt.optimizedModel.parentModelVersionId, prodModel!.modelVersionId);
  assert.equal(mf.getModelVersion(tenantId, prodModel!.modelVersionId).version, '1.0.0');

  // Secret scan defense in packaging
  const badPkg = mf.packageAndValidateModel({
    tenantId,
    modelVersionId: opt.optimizedModel.modelVersionId,
    extraMetadataForSecretScan: 'asr_live_leaked_token_123456',
  });
  assert.equal(badPkg.secretScanPassed, false);
  assert.equal(badPkg.verifiedSafeToLoad, false);

  // Rollback restores baseline v0.9.0 and preserves active streaming pinned sessions & failed evidence
  const prodDep = summary.deployments.find((d) => d.status === 'ACTIVE');
  assert.ok(prodDep);
  const rb = mf.rollbackDeployment({
    tenantId,
    deploymentId: prodDep!.deploymentId,
    actorId: 'usr_owner',
    reason: 'Canary regression test drill',
  });
  assert.equal(rb.restoredModelVersion.version, '0.9.0');
  assert.equal(rb.preservedPinnedSessions, 3);
  // Evaluation history remains attached!
  assert.ok(mf.getModelVersion(tenantId, prodModel!.modelVersionId).evaluationIds.length >= 1);

  // Tenant isolation check & Artifact Tamper Detection
  assert.throws(() => mf.getModelVersion('org_other', opt.optimizedModel.modelVersionId), /TENANT_ISOLATION_DENIED/);
  mf.tamperModelWeightsForTest(opt.optimizedModel.modelVersionId);
  const health = mf.getModelHealthStatus(tenantId, opt.optimizedModel.modelVersionId);
  assert.equal(health.artifactIntegrityVerified, false);
  assert.equal(health.routableToProduction, false);
  assert.throws(
    () =>
      mf.runEvaluation({
        tenantId,
        modelVersionId: opt.optimizedModel.modelVersionId,
        datasetReleaseId: releaseId,
      }),
    /ARTIFACT_INTEGRITY_FAILED/
  );
});
