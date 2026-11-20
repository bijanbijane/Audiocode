/**
 * PHASE 13 — HARDENED EXPRESS HTTP ROUTER (`/v1/ml/*`)
 *
 * Mounted directly by `/server.ts` and exercised in adversarial HTTP integration tests.
 * Never reads or forwards `x-avapardaz-role`, query `role`, or client-supplied authorization headers.
 */

import express from 'express';
import { buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import type {
  DeploymentEnvironment,
  DeploymentStrategy,
  ExperimentHypothesis,
  ExperimentObjective,
  ModelInitializationType,
  OptimizationExperimentRecord,
  ResourceClass,
} from './ModelFactoryContracts';
import type { ModelFactoryGateway } from './ModelFactoryGateway';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractCrossTenantHint(req: express.Request): string | null {
  const bodyRecord = isPlainRecord(req.body) ? req.body : undefined;
  const candidates: unknown[] = [
    req.headers['x-tenant-id'],
    req.headers['x-organization-id'],
    req.query.tenantId,
    req.query.organizationId,
    bodyRecord?.tenantId,
    bodyRecord?.organizationId,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return null;
}

export function createModelFactoryHttpRouter(
  modelFactoryGateway: ModelFactoryGateway
): express.Router {
  const router = express.Router();

  router.use('/v1/ml', (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      if (req.body !== undefined && !isPlainRecord(req.body)) {
        res.status(400).json(
          buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: 'Request body must be a JSON object.',
          })
        );
        return;
      }
    }
    next();
  });

  router.post('/v1/ml/experiments', (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const claimed = extractCrossTenantHint(req);
    const out = modelFactoryGateway.createExperiment({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody) as {
        experimentName?: string;
        primaryObjective?: ExperimentObjective;
        hypothesis?: ExperimentHypothesis;
        modelFamily?: string;
        architecture?: string;
        initializationType?: ModelInitializationType;
        baseModelVersion?: string;
        datasetReleaseIds?: readonly string[];
        requestedResourceClass?: ResourceClass;
        [extra: string]: unknown;
      },
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/experiments', (req, res) => {
    const out = modelFactoryGateway.listExperiments(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/experiments/:experimentId', (req, res) => {
    const out = modelFactoryGateway.getExperiment(
      String(req.headers.authorization ?? ''),
      req.params.experimentId
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/experiments/:experimentId/runs', (req, res) => {
    const out = modelFactoryGateway.createTrainingRun({
      bearerToken: String(req.headers.authorization ?? ''),
      experimentId: req.params.experimentId,
      body: (req.body ?? {}) as Parameters<ModelFactoryGateway['createTrainingRun']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/training-jobs', (req, res) => {
    const out = modelFactoryGateway.createTrainingRun({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as Parameters<ModelFactoryGateway['createTrainingRun']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/training-jobs/:jobId', (req, res) => {
    const out = modelFactoryGateway.getTrainingJob(
      String(req.headers.authorization ?? ''),
      req.params.jobId
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/training-jobs/:jobId/cancel', (req, res) => {
    const out = modelFactoryGateway.cancelTrainingJob(
      String(req.headers.authorization ?? ''),
      req.params.jobId
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/training-jobs/:jobId/resume', (req, res) => {
    const out = modelFactoryGateway.resumeTrainingJob({
      bearerToken: String(req.headers.authorization ?? ''),
      jobId: req.params.jobId,
      body: (req.body ?? {}) as { checkpointId?: string; newMaxSteps?: number },
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/training-jobs/:jobId/checkpoints', (req, res) => {
    const out = modelFactoryGateway.listTrainingCheckpoints(
      String(req.headers.authorization ?? ''),
      req.params.jobId
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/evaluations', (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const claimed = extractCrossTenantHint(req);
    const out = modelFactoryGateway.createEvaluation({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody) as Parameters<
        ModelFactoryGateway['createEvaluation']
      >[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/evaluations/:evaluationId', (req, res) => {
    const out = modelFactoryGateway.getEvaluation(
      String(req.headers.authorization ?? ''),
      req.params.evaluationId
    );
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/experiments/:experimentId/evaluations', (req, res) => {
    const out = modelFactoryGateway.listExperimentEvaluations(
      String(req.headers.authorization ?? ''),
      req.params.experimentId
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/models', (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const claimed = extractCrossTenantHint(req);
    const out = modelFactoryGateway.registerModel({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody) as Parameters<
        ModelFactoryGateway['registerModel']
      >[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/models', (req, res) => {
    const out = modelFactoryGateway.listModels(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/models/:modelId', (req, res) => {
    const out = modelFactoryGateway.getModel(
      String(req.headers.authorization ?? ''),
      req.params.modelId
    );
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/models/:modelId/versions', (req, res) => {
    const out = modelFactoryGateway.getModel(
      String(req.headers.authorization ?? ''),
      req.params.modelId
    );
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/models/:modelId/versions/:version', (req, res) => {
    const out = modelFactoryGateway.getModelVersion(
      String(req.headers.authorization ?? ''),
      req.params.modelId,
      req.params.version
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/models/:modelVersionId/package', (req, res) => {
    const body = (req.body ?? {}) as { extraMetadataForSecretScan?: string };
    const out = modelFactoryGateway.packageModel({
      bearerToken: String(req.headers.authorization ?? ''),
      modelVersionId: req.params.modelVersionId,
      extraMetadataForSecretScan: body.extraMetadataForSecretScan,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/models/:modelVersionId/optimize', (req, res) => {
    const body = (req.body ?? {}) as {
      newVersion?: string;
      technique?: OptimizationExperimentRecord['technique'];
    };
    const out = modelFactoryGateway.optimizeModel({
      bearerToken: String(req.headers.authorization ?? ''),
      modelVersionId: req.params.modelVersionId,
      newVersion: body.newVersion ?? `1.0.0-opt-${Date.now() % 1000}`,
      technique: body.technique,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  // Strictly ignore x-avapardaz-role and any client-supplied role header/query on approvals, deployments, promotion, and rollback
  router.post('/v1/ml/approvals', (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const claimed = extractCrossTenantHint(req);
    const out = modelFactoryGateway.approveModel({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody) as Parameters<
        ModelFactoryGateway['approveModel']
      >[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/approvals', (req, res) => {
    const mvId = typeof req.query.modelVersionId === 'string' ? req.query.modelVersionId : undefined;
    const out = modelFactoryGateway.listApprovals(String(req.headers.authorization ?? ''), mvId);
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/audit-events', (req, res) => {
    const out = modelFactoryGateway.listGovernanceAuditEvents(
      String(req.headers.authorization ?? '')
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/deployments', (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const claimed = extractCrossTenantHint(req);
    const out = modelFactoryGateway.createDeployment({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody) as {
        modelVersionId?: string;
        packageId?: string;
        environment?: DeploymentEnvironment;
        strategy?: DeploymentStrategy;
        trafficPercentage?: number;
        previousModelVersionId?: string;
        [extra: string]: unknown;
      },
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/deployments/:deploymentId', (req, res) => {
    const out = modelFactoryGateway.getDeployment(
      String(req.headers.authorization ?? ''),
      req.params.deploymentId
    );
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/deployments/:deploymentId/promote', (req, res) => {
    const body = (req.body ?? {}) as { trafficPercentage?: number };
    const out = modelFactoryGateway.promoteDeployment({
      bearerToken: String(req.headers.authorization ?? ''),
      deploymentId: req.params.deploymentId,
      trafficPercentage: body.trafficPercentage,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/ml/deployments/:deploymentId/rollback', (req, res) => {
    const body = (req.body ?? {}) as { reason?: string };
    const out = modelFactoryGateway.rollbackDeployment({
      bearerToken: String(req.headers.authorization ?? ''),
      deploymentId: req.params.deploymentId,
      reason: body.reason,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/models/:modelId/monitoring', (req, res) => {
    const out = modelFactoryGateway.getMonitoring(
      String(req.headers.authorization ?? ''),
      req.params.modelId
    );
    res.status(out.status).json(out.body);
  });

  router.get('/v1/ml/models/:modelId/drift', (req, res) => {
    const out = modelFactoryGateway.getMonitoring(
      String(req.headers.authorization ?? ''),
      req.params.modelId
    );
    if (out.status !== 200) {
      res.status(out.status).json(out.body);
      return;
    }
    const snap = out.body as {
      behaviorAndDataDrift?: unknown;
      performanceDrift?: unknown;
      alerts?: unknown;
    };
    res.json({
      behaviorAndDataDrift: snap?.behaviorAndDataDrift ?? null,
      performanceDrift: snap?.performanceDrift ?? null,
      alerts: snap?.alerts ?? [],
    });
  });

  router.get('/v1/ml/models/:modelId/health', (req, res) => {
    const out = modelFactoryGateway.getModelHealth(
      String(req.headers.authorization ?? ''),
      req.params.modelId
    );
    res.status(out.status).json(out.body);
  });

  return router;
}
