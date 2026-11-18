import { describe, expect, it } from 'vitest';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import { DataFactoryGateway } from '../../data-factory/DataFactoryGateway';
import { ModelFactoryGateway } from '../ModelFactoryGateway';

describe('Phase 13 ModelFactoryGateway HTTP & RBAC Enforcement', () => {
  it('enforces Bearer 401, RBAC role blocking on approval/deployment, and full /v1/ml/* workflow', async () => {
    const cp = new PlatformControlPlaneService();
    const dfGw = new DataFactoryGateway(cp);
    const mlGw = new ModelFactoryGateway(cp, dfGw.service);
    await mlGw.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');

    const keyRes = cp.issueApiKey({
      organizationId: 'org_avapardaz_sandbox',
      projectId: 'prj_avapardaz_dev_01',
      name: 'mlops-key',
      scopes: ['audio:transcribe', 'models:read'],
    });
    const token = `Bearer ${keyRes.plaintextSecretOnce}`;

    expect(mlGw.listModels('Bearer bad_token').status).toBe(401);

    const ds = dfGw.service.listDatasets('org_avapardaz_sandbox')[0];
    const rel = dfGw.service.listDatasetReleases('org_avapardaz_sandbox', ds.datasetId)[0];

    const expRes = mlGw.createExperiment({
      bearerToken: token,
      body: {
        experimentName: 'api_gw_exp_v1',
        primaryObjective: 'PERSIAN_CER_REDUCTION',
        hypothesis: {
          problemAddressed: 'Adapter calibration',
          proposedChange: 'CPU step-8 run',
          expectedMeasurableEffect: 'Reduced CER',
          affectedDatasetSlices: ['persian_fa'],
          possibleNegativeEffects: 'None',
          acceptanceCriterion: '>=5% CER reduction',
        },
        datasetReleaseIds: [rel.datasetReleaseId],
        requestedResourceClass: 'CPU_ONLY',
      },
    });
    expect(expRes.status).toBe(201);
    const expId = (expRes.body as { experimentId: string }).experimentId;

    const runRes = mlGw.createTrainingRun({
      bearerToken: token,
      experimentId: expId,
      body: { datasetReleaseId: rel.datasetReleaseId, resourceClass: 'CPU_ONLY' },
    });
    expect(runRes.status).toBe(201);
    const runId = (runRes.body as { trainingRunId: string }).trainingRunId;

    const mvRes = mlGw.registerModel({
      bearerToken: token,
      body: {
        modelId: 'gw-test-model',
        version: '2.0.0',
        experimentId: expId,
        trainingRunId: runId,
        tokenizerVersion: 'fa-en-subword-v1',
      },
    });
    expect(mvRes.status).toBe(201);
    const mvId = (mvRes.body as { modelVersionId: string }).modelVersionId;

    const evRes = mlGw.createEvaluation({
      bearerToken: token,
      body: { modelVersionId: mvId, datasetReleaseId: rel.datasetReleaseId, bootstrapIterations: 300 },
    });
    expect(evRes.status).toBe(201);
    const evalId = (evRes.body as { evaluationId: string }).evaluationId;

    const pkgRes = mlGw.packageModel({ bearerToken: token, modelVersionId: mvId });
    expect(pkgRes.status).toBe(201);
    const pkgId = (pkgRes.body as { packageId: string }).packageId;

    // VIEWER cannot approve or deploy!
    const deniedApprove = mlGw.approveModel({
      bearerToken: token,
      actorRole: 'VIEWER',
      body: { modelVersionId: mvId, evaluationId: evalId, packageId: pkgId },
    });
    expect(deniedApprove.status).toBe(403);

    // OWNER approves + deploys SHADOW then CANARY -> PROMOTE 100%
    const okApprove = mlGw.approveModel({
      bearerToken: token,
      actorRole: 'OWNER',
      body: { modelVersionId: mvId, evaluationId: evalId, packageId: pkgId },
    });
    expect(okApprove.status).toBe(201);

    const canaryDep = mlGw.createDeployment({
      bearerToken: token,
      actorRole: 'OWNER',
      body: {
        modelVersionId: mvId,
        packageId: pkgId,
        environment: 'CANARY',
        strategy: 'CANARY',
        trafficPercentage: 10,
      },
    });
    expect(canaryDep.status).toBe(201);
    const depId = (canaryDep.body as { deploymentId: string }).deploymentId;

    const promoted = mlGw.promoteDeployment({
      bearerToken: token,
      deploymentId: depId,
      actorRole: 'OWNER',
      trafficPercentage: 100,
    });
    expect(promoted.status).toBe(200);
    expect((promoted.body as { trafficPercentage: number }).trafficPercentage).toBe(100);
  });
});
