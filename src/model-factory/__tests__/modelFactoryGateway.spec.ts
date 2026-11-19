import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import type { ApiCredentialScope, OrganizationRole } from '../../platform/PlatformContractsAndSchemas';
import { DataFactoryGateway } from '../../data-factory/DataFactoryGateway';
import { ModelFactoryGateway } from '../ModelFactoryGateway';
import { createModelFactoryHttpRouter } from '../ModelFactoryHttpRouter';

const ALL_ML_SCOPES: ApiCredentialScope[] = [
  'models:read',
  'models:write',
  'models:approve',
  'models:deploy',
  'audio:transcribe',
  'security:audit',
];

async function withMlHttpServer<T>(
  gw: ModelFactoryGateway,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(createModelFactoryHttpRouter(gw));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createMlPrincipalKey(params: {
  cp: PlatformControlPlaneService;
  orgId: string;
  projectId: string;
  userId: string;
  role: OrganizationRole;
  scopes?: ApiCredentialScope[];
  expiresAtIso?: string | null;
}) {
  if (!params.cp.getUser(params.userId)) {
    params.cp.createUser({
      id: params.userId,
      email: `${params.userId}@avapardaz.local`,
      displayName: params.userId,
    });
  }
  params.cp.setOrganizationMembership({
    organizationId: params.orgId,
    userId: params.userId,
    role: params.role,
    membershipStatus: 'ACTIVE',
  });
  const issued = params.cp.issueApiKey({
    organizationId: params.orgId,
    projectId: params.projectId,
    principalId: params.userId,
    name: `ml-${params.userId}-${params.role}`,
    scopes: params.scopes ?? ALL_ML_SCOPES,
    expiresAtIso: params.expiresAtIso,
  });
  return {
    bearer: `Bearer ${issued.plaintextSecretOnce}`,
    credentialId: issued.credential.id,
    userId: params.userId,
  };
}

describe('Phase 13 ModelFactoryGateway Hardened Authorization, Provenance & Tenant Isolation', () => {
  it('1. Preserves legitimate end-to-end ML workflow with verified server-side actor provenance', async () => {
    const cp = new PlatformControlPlaneService();
    const dfGw = new DataFactoryGateway(cp);
    const mlGw = new ModelFactoryGateway(cp, dfGw.service);
    const orgId = 'org_avapardaz_sandbox';
    await mlGw.service.ensureSandboxDemoSeeded(orgId);

    const projectId = cp.listProjects(orgId)[0].id;
    const owner = createMlPrincipalKey({
      cp,
      orgId,
      projectId,
      userId: 'usr_studio_owner_01',
      role: 'OWNER',
    });
    const admin = createMlPrincipalKey({
      cp,
      orgId,
      projectId,
      userId: 'usr_ml_admin_01',
      role: 'ADMIN',
    });

    expect(mlGw.listModels('Bearer bad_token').status).toBe(401);

    const ds = dfGw.service.listDatasets(orgId)[0];
    const rel = dfGw.service.listDatasetReleases(orgId, ds.datasetId)[0];

    const expRes = mlGw.createExperiment({
      bearerToken: owner.bearer,
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
      bearerToken: owner.bearer,
      experimentId: expId,
      body: { datasetReleaseId: rel.datasetReleaseId, resourceClass: 'CPU_ONLY' },
    });
    expect(runRes.status).toBe(201);
    const runId = (runRes.body as { trainingRunId: string }).trainingRunId;

    const mvRes = mlGw.registerModel({
      bearerToken: owner.bearer,
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
      bearerToken: owner.bearer,
      body: { modelVersionId: mvId, datasetReleaseId: rel.datasetReleaseId, bootstrapIterations: 300 },
    });
    expect(evRes.status).toBe(201);
    const evalId = (evRes.body as { evaluationId: string }).evaluationId;

    const pkgRes = mlGw.packageModel({ bearerToken: owner.bearer, modelVersionId: mvId });
    expect(pkgRes.status).toBe(201);
    const pkgId = (pkgRes.body as { packageId: string }).packageId;

    // ADMIN approves cleanly (no actorRole needed; actual principalId + ADMIN recorded!)
    const okApprove = mlGw.approveModel({
      bearerToken: admin.bearer,
      body: { modelVersionId: mvId, evaluationId: evalId, packageId: pkgId },
    });
    expect(okApprove.status).toBe(201);
    const approvalBody = okApprove.body as { approverId: string; approverRole: string };
    expect(approvalBody.approverId).toBe('usr_ml_admin_01');
    expect(approvalBody.approverRole).toBe('ADMIN');

    // ADMIN creates CANARY deployment, promotes to 100%, and rolls back cleanly
    const canaryDep = mlGw.createDeployment({
      bearerToken: admin.bearer,
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
      bearerToken: admin.bearer,
      deploymentId: depId,
      trafficPercentage: 100,
    });
    expect(promoted.status).toBe(200);
    expect((promoted.body as { trafficPercentage: number }).trafficPercentage).toBe(100);

    const rolledBack = mlGw.rollbackDeployment({
      bearerToken: owner.bearer,
      deploymentId: depId,
      reason: 'Controlled post-release rollback drill',
    });
    expect(rolledBack.status).toBe(200);
    expect((rolledBack.body as { rolledBackDeployment: { status: string } }).rolledBackDeployment.status).toBe(
      'ROLLED_BACK'
    );
  });

  it('2. Blocks role spoofing, forged approver fields, unauthorized deploy/promote/rollback, and membership anomalies', async () => {
    const cp = new PlatformControlPlaneService();
    const dfGw = new DataFactoryGateway(cp);
    const mlGw = new ModelFactoryGateway(cp, dfGw.service);
    const orgId = 'org_avapardaz_sandbox';
    await mlGw.service.ensureSandboxDemoSeeded(orgId);
    const projectId = cp.listProjects(orgId)[0].id;

    const owner = createMlPrincipalKey({ cp, orgId, projectId, userId: 'usr_studio_owner_01', role: 'OWNER' });
    const developer = createMlPrincipalKey({ cp, orgId, projectId, userId: 'usr_ml_dev', role: 'DEVELOPER' });
    const analyst = createMlPrincipalKey({ cp, orgId, projectId, userId: 'usr_ml_analyst', role: 'ANALYST' });
    const viewer = createMlPrincipalKey({ cp, orgId, projectId, userId: 'usr_ml_viewer', role: 'VIEWER' });
    const readOnlyOwner = createMlPrincipalKey({
      cp,
      orgId,
      projectId,
      userId: 'usr_studio_owner_01',
      role: 'OWNER',
      scopes: ['models:read'],
    });

    // Build a candidate model + evaluation + package for governance tests
    const ds = dfGw.service.listDatasets(orgId)[0];
    const rel = dfGw.service.listDatasetReleases(orgId, ds.datasetId)[0];
    const exp = mlGw.createExperiment({
      bearerToken: owner.bearer,
      body: {
        experimentName: 'adv_sec_exp',
        primaryObjective: 'PERSIAN_CER_REDUCTION',
        hypothesis: {
          problemAddressed: 'Security governance test',
          proposedChange: 'CPU step-8',
          expectedMeasurableEffect: 'Reduced CER',
          affectedDatasetSlices: ['persian_fa'],
          possibleNegativeEffects: 'None',
          acceptanceCriterion: '>=5%',
        },
        datasetReleaseIds: [rel.datasetReleaseId],
      },
    }).body as { experimentId: string };
    const run = mlGw.createTrainingRun({
      bearerToken: owner.bearer,
      experimentId: exp.experimentId,
      body: { datasetReleaseId: rel.datasetReleaseId },
    }).body as { trainingRunId: string };
    const mv = mlGw.registerModel({
      bearerToken: owner.bearer,
      body: {
        modelId: 'adv-model',
        version: '1.1.0',
        experimentId: exp.experimentId,
        trainingRunId: run.trainingRunId,
        tokenizerVersion: 'fa-en-subword-v1',
      },
    }).body as { modelVersionId: string };
    const ev = mlGw.createEvaluation({
      bearerToken: owner.bearer,
      body: { modelVersionId: mv.modelVersionId, datasetReleaseId: rel.datasetReleaseId, bootstrapIterations: 150 },
    }).body as { evaluationId: string };
    const pkg = mlGw.packageModel({
      bearerToken: owner.bearer,
      modelVersionId: mv.modelVersionId,
    }).body as { packageId: string };

    // Approval spoofing: VIEWER, ANALYST, unauthenticated, read-only OWNER, forged approverRole/approverId
    expect(
      mlGw.approveModel({
        bearerToken: '',
        body: { modelVersionId: mv.modelVersionId, evaluationId: ev.evaluationId, packageId: pkg.packageId },
      }).status
    ).toBe(401);

    for (const spoof of [undefined, 'INVALID', 'OWNER', 'ADMIN', 'DEVELOPER']) {
      expect(
        mlGw.approveModel({
          bearerToken: viewer.bearer,
          actorRole: spoof,
          body: { modelVersionId: mv.modelVersionId, evaluationId: ev.evaluationId, packageId: pkg.packageId },
        }).status
      ).toBe(403);
      expect(
        mlGw.approveModel({
          bearerToken: analyst.bearer,
          actorRole: spoof,
          body: { modelVersionId: mv.modelVersionId, evaluationId: ev.evaluationId, packageId: pkg.packageId },
        }).status
      ).toBe(403);
    }

    // OWNER with read-only scope cannot approve (credential does not inherit full OWNER privilege)
    expect(
      mlGw.approveModel({
        bearerToken: readOnlyOwner.bearer,
        body: { modelVersionId: mv.modelVersionId, evaluationId: ev.evaluationId, packageId: pkg.packageId },
      }).status
    ).toBe(403);

    // Forged approverRole / approverId in body rejected even for authorized DEVELOPER -> zero approval created
    expect(
      mlGw.approveModel({
        bearerToken: developer.bearer,
        body: {
          modelVersionId: mv.modelVersionId,
          evaluationId: ev.evaluationId,
          packageId: pkg.packageId,
          approverRole: 'OWNER',
        },
      }).status
    ).toBe(403);
    expect(
      mlGw.approveModel({
        bearerToken: developer.bearer,
        body: {
          modelVersionId: mv.modelVersionId,
          evaluationId: ev.evaluationId,
          packageId: pkg.packageId,
          approverId: 'usr_studio_owner_01',
        },
      }).status
    ).toBe(403);
    expect(mlGw.service.listApprovals(orgId, mv.modelVersionId).length).toBe(0);

    // Legitimate DEVELOPER approval records actual DEVELOPER role & principalId
    const devAppr = mlGw.approveModel({
      bearerToken: developer.bearer,
      actorRole: 'OWNER', // ignored
      body: { modelVersionId: mv.modelVersionId, evaluationId: ev.evaluationId, packageId: pkg.packageId },
    });
    expect(devAppr.status).toBe(201);
    expect((devAppr.body as { approverId: string; approverRole: string }).approverId).toBe('usr_ml_dev');
    expect((devAppr.body as { approverId: string; approverRole: string }).approverRole).toBe('DEVELOPER');

    // DEVELOPER attempting PRODUCTION/CANARY deployment with spoofed actorRole='OWNER' -> 403 & zero deployment created
    const depsBefore = mlGw.service.listDeployments(orgId).length;
    expect(
      mlGw.createDeployment({
        bearerToken: developer.bearer,
        actorRole: 'OWNER',
        body: {
          modelVersionId: mv.modelVersionId,
          packageId: pkg.packageId,
          environment: 'CANARY',
          strategy: 'CANARY',
          trafficPercentage: 10,
        },
      }).status
    ).toBe(403);
    expect(mlGw.service.listDeployments(orgId).length).toBe(depsBefore);

    // OWNER creates legitimate CANARY deployment (traffic 10%)
    const depRes = mlGw.createDeployment({
      bearerToken: owner.bearer,
      body: {
        modelVersionId: mv.modelVersionId,
        packageId: pkg.packageId,
        environment: 'CANARY',
        strategy: 'CANARY',
        trafficPercentage: 10,
      },
    });
    expect(depRes.status).toBe(201);
    const depId = (depRes.body as { deploymentId: string }).deploymentId;

    // DEVELOPER and VIEWER blocked from promote & rollback even when spoofing OWNER -> deployment state untouched!
    for (const lowPriv of [developer.bearer, viewer.bearer, analyst.bearer]) {
      expect(
        mlGw.promoteDeployment({
          bearerToken: lowPriv,
          deploymentId: depId,
          actorRole: 'OWNER',
          trafficPercentage: 100,
        }).status
      ).toBe(403);
      expect(
        mlGw.rollbackDeployment({
          bearerToken: lowPriv,
          deploymentId: depId,
          actorRole: 'OWNER',
          reason: 'spoofed rollback',
        }).status
      ).toBe(403);
    }
    const unchangedDep = mlGw.service.getDeployment(orgId, depId);
    expect(unchangedDep.status).toBe('ACTIVE');
    expect(unchangedDep.trafficPercentage).toBe(10);

    // Membership lifecycle: role downgraded after key issuance takes effect immediately
    const promoUser = createMlPrincipalKey({ cp, orgId, projectId, userId: 'usr_downgraded', role: 'ADMIN' });
    cp.setOrganizationMembership({
      organizationId: orgId,
      userId: 'usr_downgraded',
      role: 'VIEWER',
      membershipStatus: 'ACTIVE',
    });
    expect(
      mlGw.promoteDeployment({ bearerToken: promoUser.bearer, deploymentId: depId, trafficPercentage: 50 }).status
    ).toBe(403);

    // Revoked membership, missing/ambiguous membership, expired/revoked key -> fail closed
    cp.revokeOrganizationMembership(orgId, 'usr_downgraded');
    expect(mlGw.listModels(promoUser.bearer).status).toBe(403);

    const ambigUser = createMlPrincipalKey({ cp, orgId, projectId, userId: 'usr_ambig_ml', role: 'OWNER' });
    cp.appendOrganizationMembershipRecord({
      organizationId: orgId,
      userId: 'usr_ambig_ml',
      role: 'VIEWER',
      membershipStatus: 'ACTIVE',
      createdAtIso: new Date().toISOString(),
    });
    expect(mlGw.listModels(ambigUser.bearer).status).toBe(403);

    const expiredKey = createMlPrincipalKey({
      cp,
      orgId,
      projectId,
      userId: 'usr_exp_ml',
      role: 'OWNER',
      expiresAtIso: new Date(Date.now() - 5000).toISOString(),
    });
    expect(mlGw.listModels(expiredKey.bearer).status).toBe(401);
  });

  it('3. Enforces cross-tenant isolation and blocks HTTP x-avapardaz-role spoofing with real audit provenance', async () => {
    const cp = new PlatformControlPlaneService();
    const dfGw = new DataFactoryGateway(cp);
    const mlGw = new ModelFactoryGateway(cp, dfGw.service);

    const orgA = 'org_avapardaz_sandbox';
    await mlGw.service.ensureSandboxDemoSeeded(orgA);
    const prjA = cp.listProjects(orgA)[0].id;
    const ownerA = createMlPrincipalKey({ cp, orgId: orgA, projectId: prjA, userId: 'usr_studio_owner_01', role: 'OWNER' });
    const viewerA = createMlPrincipalKey({ cp, orgId: orgA, projectId: prjA, userId: 'usr_http_viewer', role: 'VIEWER' });

    // Create Tenant B with its own seeded model/package/deployment
    const orgB = cp.createOrganization({ name: 'Tenant B ML', ownerUserId: 'usr_owner_b_ml' });
    const prjB = cp.createProject({ organizationId: orgB.id, projectName: 'Proj B ML', environment: 'DEVELOPMENT' });
    await mlGw.service.ensureSandboxDemoSeeded(orgB.id);
    const ownerB = createMlPrincipalKey({ cp, orgId: orgB.id, projectId: prjB.id, userId: 'usr_owner_b_ml', role: 'OWNER' });

    const summaryA = mlGw.service.getSandboxLifecycleSummary(orgA);
    const summaryB = mlGw.service.getSandboxLifecycleSummary(orgB.id);
    const modelA = summaryA.models[0];
    const pkgA = summaryA.packages[0];
    const depA = summaryA.deployments[0];
    const modelB = summaryB.models[0];
    const pkgB = summaryB.packages[0];

    await withMlHttpServer(mlGw, async (baseUrl) => {
      // HTTP integration: VIEWER sends x-avapardaz-role: OWNER + ?role=OWNER + body actorRole='OWNER' on /v1/ml/deployments/:id/promote
      const spoofPromote = await fetch(`${baseUrl}/v1/ml/deployments/${depA.deploymentId}/promote?role=OWNER`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: viewerA.bearer,
          'x-avapardaz-role': 'OWNER',
        },
        body: JSON.stringify({ trafficPercentage: 100, actorRole: 'OWNER' }),
      });
      expect(spoofPromote.status).toBe(403);
      expect(mlGw.service.getDeployment(orgA, depA.deploymentId).status).toBe(depA.status);

      // Verify governance audit log recorded the REAL authenticated principal (usr_http_viewer) and real VIEWER role
      const auditRes = await fetch(`${baseUrl}/v1/ml/audit-events`, {
        headers: { authorization: ownerA.bearer },
      });
      expect(auditRes.status).toBe(200);
      const auditBody = (await auditRes.json()) as {
        events: Array<{ actorId: string; verifiedRole: string; operation: string; outcome: string; reasonCode: string }>;
      };
      const deniedEvt = auditBody.events.find(
        (e) => e.actorId === 'usr_http_viewer' && e.operation === 'ML_PROMOTE_DEPLOYMENT'
      );
      expect(deniedEvt).toBeDefined();
      expect(deniedEvt?.verifiedRole).toBe('VIEWER');
      expect(deniedEvt?.outcome).toBe('DENIED');
      expect(deniedEvt?.reasonCode).toBe('DENIED_ROLE_NOT_PERMITTED');
      // Never log bearer secret
      expect(JSON.stringify(auditBody)).not.toContain(viewerA.bearer.replace('Bearer ', ''));

      // Cross-tenant deployment creation: Tenant B tries to deploy Tenant A's model or package -> 403
      const crossModelDep = await fetch(`${baseUrl}/v1/ml/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: ownerB.bearer },
        body: JSON.stringify({
          modelVersionId: modelA.modelVersionId,
          packageId: pkgB.packageId,
          environment: 'CANARY',
          strategy: 'CANARY',
          trafficPercentage: 10,
        }),
      });
      expect(crossModelDep.status).toBe(403);

      const crossPkgDep = await fetch(`${baseUrl}/v1/ml/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: ownerB.bearer },
        body: JSON.stringify({
          modelVersionId: modelB.modelVersionId,
          packageId: pkgA.packageId,
          environment: 'CANARY',
          strategy: 'CANARY',
          trafficPercentage: 10,
        }),
      });
      expect(crossPkgDep.status).toBe(403);

      // Cross-tenant deployment promotion & rollback: Tenant B tries to promote/rollback Tenant A's deployment -> 403
      const crossPromote = await fetch(`${baseUrl}/v1/ml/deployments/${depA.deploymentId}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: ownerB.bearer },
        body: JSON.stringify({ trafficPercentage: 100 }),
      });
      expect(crossPromote.status).toBe(403);

      const crossRollback = await fetch(`${baseUrl}/v1/ml/deployments/${depA.deploymentId}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: ownerB.bearer },
        body: JSON.stringify({ reason: 'cross-tenant sabotage' }),
      });
      expect(crossRollback.status).toBe(403);
      expect(mlGw.service.getDeployment(orgA, depA.deploymentId).status).toBe(depA.status);
    });
  });
});
