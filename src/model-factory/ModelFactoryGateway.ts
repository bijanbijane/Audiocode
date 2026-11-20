/**
 * PHASE 13 — HARDENED MODEL FACTORY & MLOPS HTTP GATEWAY (`/v1/ml/*`)
 *
 * Enforces centralized fail-closed server-side authorization (`AuthorizationPolicyEngine`),
 * verified organization membership RBAC, least-privilege credential scopes, strict tenant
 * and resource ownership isolation, and tamper-resistant provenance & audit logging.
 *
 * Security invariants:
 * - No `resolveActorRole()` or fail-open `OWNER` fallback exists anywhere in this gateway.
 * - Client-supplied roles (`actorRole`, `approverRole`, `x-avapardaz-role`, query `role`)
 *   NEVER grant privileges or override recorded approver/actor provenance.
 * - Authorization failure occurs strictly prior to any state mutation.
 */

import crypto from 'node:crypto';
import { PlatformControlPlaneService, buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import type { OrganizationRole } from '../platform/PlatformContractsAndSchemas';
import { AudioSecurityGuard } from '../security/AudioSecurityGuard';
import {
  authorizePlatformOperation,
  extractClaimedTenantId,
  type ModelFactoryOperationId,
  type TrustedAuthContext,
} from '../security/AuthorizationPolicyEngine';
import type { SpeechDataFactoryService } from '../data-factory/SpeechDataFactoryService';
import { SpeechModelFactoryService } from './SpeechModelFactoryService';
import type {
  DeploymentEnvironment,
  DeploymentStrategy,
  ExperimentHypothesis,
  ExperimentObjective,
  ModelInitializationType,
  OptimizationExperimentRecord,
  ResourceClass,
  TrainingConfigurationSpec,
} from './ModelFactoryContracts';

export interface MlGatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ModelGovernanceAuditEntry {
  readonly auditId: string;
  readonly requestId: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly verifiedRole: OrganizationRole | null;
  readonly operation: ModelFactoryOperationId;
  readonly resourceId: string;
  readonly outcome: 'ALLOWED' | 'DENIED';
  readonly reasonCode: string;
  readonly timestampIso: string;
}

const VALID_DEPLOYMENT_ENVIRONMENTS = new Set<DeploymentEnvironment>([
  'DEVELOPMENT',
  'STAGING',
  'SHADOW',
  'CANARY',
  'PRODUCTION',
]);

const VALID_DEPLOYMENT_STRATEGIES = new Set<DeploymentStrategy>([
  'DIRECT_DEV',
  'STAGING',
  'SHADOW',
  'CANARY',
  'FULL_PRODUCTION',
  'ROLLBACK',
]);

export class ModelFactoryGateway {
  public readonly service: SpeechModelFactoryService;
  private readonly governanceAuditLog: ModelGovernanceAuditEntry[] = [];

  constructor(
    private readonly controlPlane: PlatformControlPlaneService,
    private readonly dataFactory: SpeechDataFactoryService
  ) {
    this.service = new SpeechModelFactoryService(controlPlane, dataFactory);
  }

  private recordGovernanceAudit(params: {
    readonly requestId: string;
    readonly organizationId: string;
    readonly actorId: string;
    readonly verifiedRole: OrganizationRole | null;
    readonly operation: ModelFactoryOperationId;
    readonly resourceId: string;
    readonly outcome: 'ALLOWED' | 'DENIED';
    readonly reasonCode: string;
  }): void {
    const timestampIso = new Date().toISOString();
    const safeResourceId = AudioSecurityGuard.sanitizeErrorForTelemetry(params.resourceId).slice(0, 128);
    const entry: ModelGovernanceAuditEntry = {
      auditId: `mlaud_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      requestId: params.requestId,
      organizationId: params.organizationId,
      actorId: params.actorId,
      verifiedRole: params.verifiedRole,
      operation: params.operation,
      resourceId: safeResourceId,
      outcome: params.outcome,
      reasonCode: params.reasonCode,
      timestampIso,
    };
    this.governanceAuditLog.unshift(entry);
    if (this.governanceAuditLog.length > 500) {
      this.governanceAuditLog.length = 500;
    }

    this.controlPlane.recordAuditLog({
      organizationId: params.organizationId,
      actorType: 'USER',
      actorId: params.actorId,
      action: params.operation,
      resourceType: 'model_factory',
      resourceId: safeResourceId,
      outcome: params.outcome,
      reason: `role=${params.verifiedRole ?? 'NONE'} reasonCode=${params.reasonCode} requestId=${params.requestId}`,
    });
  }

  private authorize(params: {
    readonly bearerToken: string;
    readonly operation: ModelFactoryOperationId;
    readonly resourceId: string;
    readonly claimedTenantId?: string | null;
    readonly nowMs?: number;
  }):
    | { readonly ok: true; readonly context: TrustedAuthContext }
    | { readonly ok: false; readonly response: MlGatewayResponse } {
    const decision = authorizePlatformOperation({
      controlPlane: this.controlPlane,
      bearerToken: params.bearerToken,
      operation: params.operation,
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });

    if (!decision.allowed) {
      if (decision.organizationId) {
        this.recordGovernanceAudit({
          requestId: decision.errorEnvelope.error.request_id,
          organizationId: decision.organizationId,
          actorId: decision.principalId ?? 'unauthenticated',
          verifiedRole: decision.role,
          operation: params.operation,
          resourceId: params.resourceId,
          outcome: 'DENIED',
          reasonCode: decision.reasonCode,
        });
      }
      return {
        ok: false,
        response: { status: decision.httpStatus, body: decision.errorEnvelope },
      };
    }

    return { ok: true, context: decision.context };
  }

  private mapError(
    err: unknown,
    auditCtx?: {
      readonly context: TrustedAuthContext;
      readonly operation: ModelFactoryOperationId;
      readonly resourceId: string;
    }
  ): MlGatewayResponse {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = AudioSecurityGuard.sanitizeErrorForTelemetry(raw);

    const emitDeniedAudit = (reasonCode: string) => {
      if (auditCtx) {
        this.recordGovernanceAudit({
          requestId: auditCtx.context.requestId,
          organizationId: auditCtx.context.organizationId,
          actorId: auditCtx.context.principalId,
          verifiedRole: auditCtx.context.role,
          operation: auditCtx.operation,
          resourceId: auditCtx.resourceId,
          outcome: 'DENIED',
          reasonCode,
        });
      }
    };

    if (raw.startsWith('TENANT_ISOLATION_DENIED')) {
      emitDeniedAudit('DENIED_RESOURCE_OWNERSHIP_VIOLATION');
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Resource access denied.',
          requestId: auditCtx?.context.requestId,
          details: { reasonCode: 'DENIED_RESOURCE_OWNERSHIP_VIOLATION' },
        }),
      };
    }
    if (
      raw.startsWith('RBAC_FORBIDDEN') ||
      raw.startsWith('UNAPPROVED_MODEL_DEPLOYMENT_DENIED') ||
      raw.startsWith('LIFECYCLE_POLICY_DENIED')
    ) {
      const reasonCode = raw.startsWith('RBAC_FORBIDDEN')
        ? 'DENIED_ROLE_NOT_PERMITTED'
        : raw.startsWith('UNAPPROVED_MODEL_DEPLOYMENT_DENIED')
          ? 'DENIED_UNAPPROVED_MODEL'
          : 'DENIED_LIFECYCLE_POLICY';
      emitDeniedAudit(reasonCode);
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: msg,
          requestId: auditCtx?.context.requestId,
          details: { reasonCode },
        }),
      };
    }
    if (raw.includes('CONFLICT') || raw.startsWith('DUPLICATE_EXPERIMENT_CONFLICT')) {
      emitDeniedAudit('DENIED_CONFLICT');
      return {
        status: 409,
        body: buildPlatformErrorEnvelope({
          code: 'IDEMPOTENCY_CONFLICT',
          message: msg,
          requestId: auditCtx?.context.requestId,
        }),
      };
    }
    if (raw.includes('NOT_FOUND')) {
      emitDeniedAudit('DENIED_RESOURCE_NOT_FOUND');
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: msg,
          requestId: auditCtx?.context.requestId,
        }),
      };
    }
    if (
      raw.startsWith('PROMOTION_GATE_FAILED') ||
      raw.startsWith('PACKAGE_VALIDATION_REQUIRED') ||
      raw.startsWith('PACKAGE_INVALID') ||
      raw.startsWith('CONCURRENCY_QUOTA_EXCEEDED') ||
      raw.startsWith('ARTIFACT_INTEGRITY_FAILED') ||
      raw.startsWith('HEALTH_GATE_FAILED') ||
      raw.startsWith('NO_ROLLBACK_TARGET') ||
      raw.startsWith('LICENSE_COMMERCIAL_USE_UNVERIFIED')
    ) {
      emitDeniedAudit('DENIED_GOVERNANCE_PRECONDITION');
      return {
        status: 422,
        body: buildPlatformErrorEnvelope({
          code: 'MODEL_UNAVAILABLE',
          message: msg,
          requestId: auditCtx?.context.requestId,
        }),
      };
    }
    if (raw.startsWith('VALIDATION_ERROR')) {
      emitDeniedAudit('DENIED_VALIDATION_ERROR');
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: msg,
          requestId: auditCtx?.context.requestId,
        }),
      };
    }
    return {
      status: 400,
      body: buildPlatformErrorEnvelope({
        code: 'MODEL_UNAVAILABLE',
        message: msg,
        requestId: auditCtx?.context.requestId,
      }),
    };
  }

  public createExperiment(params: {
    bearerToken: string;
    body: {
      experimentName?: string;
      primaryObjective?: ExperimentObjective;
      hypothesis?: ExperimentHypothesis;
      modelFamily?: string;
      architecture?: string;
      initializationType?: ModelInitializationType;
      baseModelVersion?: string;
      configuration?: Partial<TrainingConfigurationSpec>;
      datasetReleaseIds?: readonly string[];
      evaluationDatasetReleaseId?: string;
      requestedResourceClass?: ResourceClass;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): MlGatewayResponse {
    const rawExpName =
      typeof params.body?.experimentName === 'string' && params.body.experimentName.trim().length > 0
        ? params.body.experimentName.trim()
        : null;
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_MANAGE_EXPERIMENTS',
      resourceId: rawExpName ?? 'new_experiment',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    if (
      !rawExpName ||
      !params.body?.hypothesis ||
      typeof params.body.hypothesis !== 'object' ||
      Array.isArray(params.body.hypothesis)
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'experimentName (non-empty string) and hypothesis (object) are required',
          requestId: auth.context.requestId,
        }),
      };
    }
    if (
      params.body.datasetReleaseIds !== undefined &&
      (!Array.isArray(params.body.datasetReleaseIds) ||
        params.body.datasetReleaseIds.some((id) => typeof id !== 'string'))
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'datasetReleaseIds must be an array of strings',
          requestId: auth.context.requestId,
        }),
      };
    }
    try {
      const exp = this.service.createExperiment({
        tenantId: auth.context.organizationId,
        projectId: auth.context.projectId,
        experimentName: rawExpName,
        primaryObjective: params.body.primaryObjective ?? 'PERSIAN_CER_REDUCTION',
        hypothesis: params.body.hypothesis,
        modelFamily:
          typeof params.body.modelFamily === 'string' && params.body.modelFamily.trim()
            ? params.body.modelFamily.trim()
            : 'avapardaz_local_ctc_adapter',
        architecture:
          typeof params.body.architecture === 'string' && params.body.architecture.trim()
            ? params.body.architecture.trim()
            : 'SpectralCTC-BigramAdapter-v1',
        initializationType: params.body.initializationType ?? 'ADAPTER_TUNING',
        baseModelVersion:
          typeof params.body.baseModelVersion === 'string' && params.body.baseModelVersion.trim()
            ? params.body.baseModelVersion.trim()
            : 'ASR-FA-EN-0.9.0-BASELINE',
        configuration: params.body.configuration,
        datasetReleaseIds: params.body.datasetReleaseIds ?? [],
        evaluationDatasetReleaseId:
          typeof params.body.evaluationDatasetReleaseId === 'string'
            ? params.body.evaluationDatasetReleaseId
            : undefined,
        requestedResourceClass: params.body.requestedResourceClass ?? 'CPU_ONLY',
        ownerId: auth.context.principalId,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: exp.experimentId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: exp };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: rawExpName,
      });
    }
  }

  public listExperiments(bearerToken: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: 'experiments_list',
    });
    if (!auth.ok) return auth.response;
    return { status: 200, body: { data: this.service.listExperiments(auth.context.organizationId) } };
  }

  public getExperiment(bearerToken: string, experimentId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: experimentId,
    });
    if (!auth.ok) return auth.response;
    try {
      return { status: 200, body: this.service.getExperiment(auth.context.organizationId, experimentId) };
    } catch (err) {
      return this.mapError(err, { context: auth.context, operation: 'ML_READ_MODELS', resourceId: experimentId });
    }
  }

  public createTrainingRun(params: {
    bearerToken: string;
    experimentId?: string;
    body: {
      experimentId?: string;
      datasetReleaseId?: string;
      resourceClass?: ResourceClass;
      interruptAfterStep?: number;
      resumedFromCheckpointId?: string;
      maxBudgetUsd?: number;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): MlGatewayResponse {
    const rawExpId = params.experimentId ?? params.body?.experimentId;
    const experimentId = typeof rawExpId === 'string' ? rawExpId.trim() : '';
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_MANAGE_EXPERIMENTS',
      resourceId: experimentId || 'training_run',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;
    if (!experimentId) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'experimentId must be a non-empty string',
          requestId: auth.context.requestId,
        }),
      };
    }
    try {
      const run = this.service.startTrainingRun({
        tenantId: auth.context.organizationId,
        experimentId,
        datasetReleaseId: params.body?.datasetReleaseId,
        resourceClass: params.body?.resourceClass,
        interruptAfterStep: params.body?.interruptAfterStep,
        resumedFromCheckpointId: params.body?.resumedFromCheckpointId,
        maxBudgetUsd: params.body?.maxBudgetUsd,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: run.trainingRunId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: run.status === 'BLOCKED' ? 422 : 201, body: run };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: experimentId,
      });
    }
  }

  public getTrainingJob(bearerToken: string, jobId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: jobId,
    });
    if (!auth.ok) return auth.response;
    try {
      return { status: 200, body: this.service.getTrainingRun(auth.context.organizationId, jobId) };
    } catch (err) {
      return this.mapError(err, { context: auth.context, operation: 'ML_READ_MODELS', resourceId: jobId });
    }
  }

  public cancelTrainingJob(bearerToken: string, jobId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_MANAGE_EXPERIMENTS',
      resourceId: jobId,
    });
    if (!auth.ok) return auth.response;
    try {
      const res = this.service.cancelTrainingRun(auth.context.organizationId, jobId);
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: jobId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 200, body: res };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: jobId,
      });
    }
  }

  public resumeTrainingJob(params: {
    bearerToken: string;
    jobId: string;
    body?: { checkpointId?: string; newMaxSteps?: number; [extra: string]: unknown };
  }): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_MANAGE_EXPERIMENTS',
      resourceId: params.jobId,
      claimedTenantId: extractClaimedTenantId(params.body),
    });
    if (!auth.ok) return auth.response;
    try {
      const res = this.service.resumeTrainingRun({
        tenantId: auth.context.organizationId,
        runId: params.jobId,
        checkpointId: params.body?.checkpointId,
        newMaxSteps: params.body?.newMaxSteps,
      });
      return { status: 201, body: res };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: params.jobId,
      });
    }
  }

  public listTrainingCheckpoints(bearerToken: string, jobId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: jobId,
    });
    if (!auth.ok) return auth.response;
    try {
      return { status: 200, body: { data: this.service.listCheckpointsForRun(auth.context.organizationId, jobId) } };
    } catch (err) {
      return this.mapError(err, { context: auth.context, operation: 'ML_READ_MODELS', resourceId: jobId });
    }
  }

  public createEvaluation(params: {
    bearerToken: string;
    body: {
      modelVersionId?: string;
      datasetReleaseId?: string;
      datasetSplit?: 'VALIDATION' | 'TEST' | 'HOLDOUT';
      baselineModelVersionId?: string;
      bootstrapIterations?: number;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): MlGatewayResponse {
    const modelVersionId =
      typeof params.body?.modelVersionId === 'string' && params.body.modelVersionId.trim().length > 0
        ? params.body.modelVersionId.trim()
        : null;
    const datasetReleaseId =
      typeof params.body?.datasetReleaseId === 'string' && params.body.datasetReleaseId.trim().length > 0
        ? params.body.datasetReleaseId.trim()
        : null;
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_EVALUATE_MODEL',
      resourceId: modelVersionId ?? 'evaluation',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;
    if (!modelVersionId || !datasetReleaseId) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'modelVersionId and datasetReleaseId must be non-empty strings',
          requestId: auth.context.requestId,
        }),
      };
    }
    try {
      const report = this.service.runEvaluation({
        tenantId: auth.context.organizationId,
        modelVersionId,
        datasetReleaseId,
        datasetSplit: params.body.datasetSplit,
        baselineModelVersionId:
          typeof params.body.baselineModelVersionId === 'string'
            ? params.body.baselineModelVersionId
            : undefined,
        bootstrapIterations:
          typeof params.body.bootstrapIterations === 'number' &&
          Number.isFinite(params.body.bootstrapIterations)
            ? params.body.bootstrapIterations
            : undefined,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_EVALUATE_MODEL',
        resourceId: report.evaluationId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: report };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_EVALUATE_MODEL',
        resourceId: modelVersionId,
      });
    }
  }

  public getEvaluation(bearerToken: string, evaluationId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: evaluationId,
    });
    if (!auth.ok) return auth.response;
    try {
      return { status: 200, body: this.service.getEvaluation(auth.context.organizationId, evaluationId) };
    } catch (err) {
      return this.mapError(err, { context: auth.context, operation: 'ML_READ_MODELS', resourceId: evaluationId });
    }
  }

  public listExperimentEvaluations(bearerToken: string, experimentId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: experimentId,
    });
    if (!auth.ok) return auth.response;
    try {
      this.service.getExperiment(auth.context.organizationId, experimentId);
      return {
        status: 200,
        body: { data: this.service.listEvaluationsForExperiment(auth.context.organizationId, experimentId) },
      };
    } catch (err) {
      return this.mapError(err, { context: auth.context, operation: 'ML_READ_MODELS', resourceId: experimentId });
    }
  }

  public registerModel(params: {
    bearerToken: string;
    body: {
      modelId?: string;
      version?: string;
      experimentId?: string;
      trainingRunId?: string;
      checkpointId?: string;
      parentModelVersionId?: string;
      tokenizerVersion?: string;
      initialStatus?: 'RESEARCH' | 'TRAINED';
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): MlGatewayResponse {
    const modelId =
      typeof params.body?.modelId === 'string' && params.body.modelId.trim().length > 0
        ? params.body.modelId.trim()
        : null;
    const version =
      typeof params.body?.version === 'string' && params.body.version.trim().length > 0
        ? params.body.version.trim()
        : null;
    const experimentId =
      typeof params.body?.experimentId === 'string' && params.body.experimentId.trim().length > 0
        ? params.body.experimentId.trim()
        : null;
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_MANAGE_EXPERIMENTS',
      resourceId: modelId ?? 'new_model',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;
    if (!modelId || !version || !experimentId) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'modelId, version, and experimentId must be non-empty strings',
          requestId: auth.context.requestId,
        }),
      };
    }
    try {
      const mv = this.service.registerModelVersion({
        tenantId: auth.context.organizationId,
        modelId,
        version,
        experimentId,
        trainingRunId: typeof params.body.trainingRunId === 'string' ? params.body.trainingRunId : undefined,
        checkpointId: typeof params.body.checkpointId === 'string' ? params.body.checkpointId : undefined,
        parentModelVersionId:
          typeof params.body.parentModelVersionId === 'string' ? params.body.parentModelVersionId : undefined,
        tokenizerVersion:
          typeof params.body.tokenizerVersion === 'string' ? params.body.tokenizerVersion : undefined,
        initialStatus: params.body.initialStatus,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: mv.modelVersionId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: mv };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_MANAGE_EXPERIMENTS',
        resourceId: modelId,
      });
    }
  }

  public listModels(bearerToken: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: 'models_list',
    });
    if (!auth.ok) return auth.response;
    return { status: 200, body: { data: this.service.listModels(auth.context.organizationId) } };
  }

  public getModel(bearerToken: string, modelId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: modelId,
    });
    if (!auth.ok) return auth.response;
    const matches = this.service.listModels(auth.context.organizationId).filter(
      (m) => m.modelId === modelId || m.modelVersionId === modelId
    );
    if (matches.length === 0) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Model ${modelId} not found.`,
          requestId: auth.context.requestId,
        }),
      };
    }
    return { status: 200, body: { modelId, versions: matches } };
  }

  public getModelVersion(bearerToken: string, modelId: string, version: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: `${modelId}@${version}`,
    });
    if (!auth.ok) return auth.response;
    try {
      return { status: 200, body: this.service.getModelByIdAndVersion(auth.context.organizationId, modelId, version) };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_READ_MODELS',
        resourceId: `${modelId}@${version}`,
      });
    }
  }

  public packageModel(params: {
    bearerToken: string;
    modelVersionId: string;
    extraMetadataForSecretScan?: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_PACKAGE_MODEL',
      resourceId: params.modelVersionId,
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;
    try {
      const pkg = this.service.packageAndValidateModel({
        tenantId: auth.context.organizationId,
        modelVersionId: params.modelVersionId,
        extraMetadataForSecretScan: params.extraMetadataForSecretScan,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_PACKAGE_MODEL',
        resourceId: pkg.packageId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: pkg };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_PACKAGE_MODEL',
        resourceId: params.modelVersionId,
      });
    }
  }

  /**
   * Model Release Approval:
   * - Authorizes strictly from server-side principal membership & credential scope.
   * - Rejects client attempts to forge `approverRole` or `approverId` in body.
   * - Ignores any `actorRole` parameter or `x-avapardaz-role` header.
   * - Persists verified `approverId = auth.context.principalId` and `approverRole = auth.context.role`.
   */
  public approveModel(params: {
    bearerToken: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    body: {
      modelVersionId?: string;
      evaluationId?: string;
      packageId?: string;
      approvalScope?: string;
      reason?: string;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_APPROVE_MODEL',
      resourceId: params.body?.modelVersionId ?? 'model_approval',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    // Reject forged provenance fields in request body before any mutation
    const rawBody = (params.body ?? {}) as Record<string, unknown>;
    if ('approverRole' in rawBody || 'approverId' in rawBody) {
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_APPROVE_MODEL',
        resourceId: params.body?.modelVersionId ?? 'model_approval',
        outcome: 'DENIED',
        reasonCode: 'DENIED_FORGED_PROVENANCE_FIELD',
      });
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Caller-supplied approverId or approverRole is forbidden; provenance is derived strictly from authenticated identity.',
          requestId: auth.context.requestId,
          details: { reasonCode: 'DENIED_FORGED_PROVENANCE_FIELD' },
        }),
      };
    }

    if (
      typeof params.body?.modelVersionId !== 'string' ||
      params.body.modelVersionId.trim().length === 0 ||
      typeof params.body?.evaluationId !== 'string' ||
      params.body.evaluationId.trim().length === 0 ||
      typeof params.body?.packageId !== 'string' ||
      params.body.packageId.trim().length === 0 ||
      (params.body.approvalScope !== undefined && typeof params.body.approvalScope !== 'string') ||
      (params.body.reason !== undefined && typeof params.body.reason !== 'string')
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'modelVersionId, evaluationId, and packageId must be non-empty strings.',
          requestId: auth.context.requestId,
        }),
      };
    }

    try {
      const approval = this.service.approveModelForRelease({
        tenantId: auth.context.organizationId,
        modelVersionId: params.body.modelVersionId.trim(),
        evaluationId: params.body.evaluationId.trim(),
        packageId: params.body.packageId.trim(),
        approverId: auth.context.principalId,
        approverRole: auth.context.role,
        approvalScope: params.body.approvalScope ?? 'production',
        reason: params.body.reason ?? 'Approved via ML Governance API',
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_APPROVE_MODEL',
        resourceId: approval.approvalId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: approval };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_APPROVE_MODEL',
        resourceId: params.body.modelVersionId,
      });
    }
  }

  public listApprovals(bearerToken: string, modelVersionId?: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_GOVERNANCE_AUDIT',
      resourceId: modelVersionId ?? 'approvals_list',
    });
    if (!auth.ok) return auth.response;
    try {
      return {
        status: 200,
        body: { data: this.service.listApprovals(auth.context.organizationId, modelVersionId) },
      };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_READ_GOVERNANCE_AUDIT',
        resourceId: modelVersionId ?? 'approvals_list',
      });
    }
  }

  public listGovernanceAuditEvents(bearerToken: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_GOVERNANCE_AUDIT',
      resourceId: 'ml_governance_audit',
    });
    if (!auth.ok) return auth.response;
    const events = this.governanceAuditLog.filter(
      (e) => e.organizationId === auth.context.organizationId
    );
    return { status: 200, body: { events } };
  }

  public createDeployment(params: {
    bearerToken: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    body: {
      modelVersionId?: string;
      packageId?: string;
      environment?: DeploymentEnvironment;
      strategy?: DeploymentStrategy;
      trafficPercentage?: number;
      previousModelVersionId?: string;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): MlGatewayResponse {
    const requestedEnv = params.body?.environment ?? 'STAGING';
    const isProdTarget =
      requestedEnv === 'STAGING' || requestedEnv === 'CANARY' || requestedEnv === 'PRODUCTION';
    const operation: ModelFactoryOperationId = isProdTarget
      ? 'ML_DEPLOY_PRODUCTION'
      : 'ML_DEPLOY_NON_PROD';

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation,
      resourceId: params.body?.modelVersionId ?? 'new_deployment',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    if (!VALID_DEPLOYMENT_ENVIRONMENTS.has(requestedEnv)) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: `Unsupported deployment environment '${String(requestedEnv)}'.`,
          requestId: auth.context.requestId,
        }),
      };
    }
    const requestedStrategy = params.body?.strategy ?? 'STAGING';
    if (!VALID_DEPLOYMENT_STRATEGIES.has(requestedStrategy)) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: `Unsupported deployment strategy '${String(requestedStrategy)}'.`,
          requestId: auth.context.requestId,
        }),
      };
    }
    if (
      typeof params.body?.modelVersionId !== 'string' ||
      params.body.modelVersionId.trim().length === 0 ||
      typeof params.body?.packageId !== 'string' ||
      params.body.packageId.trim().length === 0 ||
      (params.body.previousModelVersionId !== undefined && typeof params.body.previousModelVersionId !== 'string')
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'modelVersionId and packageId must be non-empty strings.',
          requestId: auth.context.requestId,
        }),
      };
    }
    const trafficPercentage = params.body.trafficPercentage ?? 100;
    if (
      typeof trafficPercentage !== 'number' ||
      !Number.isFinite(trafficPercentage) ||
      trafficPercentage < 0 ||
      trafficPercentage > 100
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'trafficPercentage must be a finite number between 0 and 100.',
          requestId: auth.context.requestId,
        }),
      };
    }

    try {
      const dep = this.service.deployModelVersion({
        tenantId: auth.context.organizationId,
        modelVersionId: params.body.modelVersionId.trim(),
        packageId: params.body.packageId.trim(),
        environment: requestedEnv,
        strategy: requestedStrategy,
        trafficPercentage,
        actorId: auth.context.principalId,
        actorRole: auth.context.role,
        previousModelVersionId: params.body.previousModelVersionId,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation,
        resourceId: dep.deploymentId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: dep };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation,
        resourceId: params.body.modelVersionId,
      });
    }
  }

  public getDeployment(bearerToken: string, deploymentId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MODELS',
      resourceId: deploymentId,
    });
    if (!auth.ok) return auth.response;
    try {
      return { status: 200, body: this.service.getDeployment(auth.context.organizationId, deploymentId) };
    } catch (err) {
      return this.mapError(err, { context: auth.context, operation: 'ML_READ_MODELS', resourceId: deploymentId });
    }
  }

  public promoteDeployment(params: {
    bearerToken: string;
    deploymentId: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    trafficPercentage?: number;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_PROMOTE_DEPLOYMENT',
      resourceId: params.deploymentId,
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    const nextTrafficPercentage = params.trafficPercentage ?? 100;
    if (
      typeof nextTrafficPercentage !== 'number' ||
      !Number.isFinite(nextTrafficPercentage) ||
      nextTrafficPercentage < 1 ||
      nextTrafficPercentage > 100
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'trafficPercentage must be a finite number between 1 and 100.',
          requestId: auth.context.requestId,
        }),
      };
    }

    try {
      const promoted = this.service.promoteCanaryDeployment({
        tenantId: auth.context.organizationId,
        deploymentId: params.deploymentId,
        nextTrafficPercentage,
        actorId: auth.context.principalId,
        actorRole: auth.context.role,
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_PROMOTE_DEPLOYMENT',
        resourceId: params.deploymentId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 200, body: promoted };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_PROMOTE_DEPLOYMENT',
        resourceId: params.deploymentId,
      });
    }
  }

  public rollbackDeployment(params: {
    bearerToken: string;
    deploymentId: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    reason?: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_ROLLBACK_DEPLOYMENT',
      resourceId: params.deploymentId,
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    try {
      const res = this.service.rollbackDeployment({
        tenantId: auth.context.organizationId,
        deploymentId: params.deploymentId,
        actorId: auth.context.principalId,
        actorRole: auth.context.role,
        reason: params.reason ?? 'API rollback trigger',
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_ROLLBACK_DEPLOYMENT',
        resourceId: params.deploymentId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 200, body: res };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_ROLLBACK_DEPLOYMENT',
        resourceId: params.deploymentId,
      });
    }
  }

  public optimizeModel(params: {
    bearerToken: string;
    modelVersionId: string;
    newVersion: string;
    technique?: OptimizationExperimentRecord['technique'];
    claimedTenantId?: string | null;
    nowMs?: number;
  }): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'ML_OPTIMIZE_MODEL',
      resourceId: params.modelVersionId,
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    try {
      const res = this.service.optimizeAndRegisterDerivedVersion({
        tenantId: auth.context.organizationId,
        parentModelVersionId: params.modelVersionId,
        newVersion: params.newVersion,
        technique: params.technique ?? 'DYNAMIC_INT8_QUANTIZATION',
      });
      this.recordGovernanceAudit({
        requestId: auth.context.requestId,
        organizationId: auth.context.organizationId,
        actorId: auth.context.principalId,
        verifiedRole: auth.context.role,
        operation: 'ML_OPTIMIZE_MODEL',
        resourceId: res.optimizedModel.modelVersionId,
        outcome: 'ALLOWED',
        reasonCode: 'ALLOWED',
      });
      return { status: 201, body: res };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_OPTIMIZE_MODEL',
        resourceId: params.modelVersionId,
      });
    }
  }

  public getMonitoring(bearerToken: string, modelIdOrVersionId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MONITORING',
      resourceId: modelIdOrVersionId,
    });
    if (!auth.ok) return auth.response;
    try {
      const target = this.service.listModels(auth.context.organizationId).find(
        (m) => m.modelVersionId === modelIdOrVersionId || m.modelId === modelIdOrVersionId
      );
      if (!target) throw new Error('MODEL_NOT_FOUND');
      return {
        status: 200,
        body: this.service.getMonitoringSnapshot(auth.context.organizationId, target.modelVersionId),
      };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_READ_MONITORING',
        resourceId: modelIdOrVersionId,
      });
    }
  }

  public getModelHealth(bearerToken: string, modelIdOrVersionId: string): MlGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'ML_READ_MONITORING',
      resourceId: modelIdOrVersionId,
    });
    if (!auth.ok) return auth.response;
    try {
      const target = this.service.listModels(auth.context.organizationId).find(
        (m) => m.modelVersionId === modelIdOrVersionId || m.modelId === modelIdOrVersionId
      );
      if (!target) throw new Error('MODEL_NOT_FOUND');
      return {
        status: 200,
        body: this.service.getModelHealthStatus(auth.context.organizationId, target.modelVersionId),
      };
    } catch (err) {
      return this.mapError(err, {
        context: auth.context,
        operation: 'ML_READ_MONITORING',
        resourceId: modelIdOrVersionId,
      });
    }
  }
}
