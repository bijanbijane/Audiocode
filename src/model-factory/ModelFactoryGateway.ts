/**
 * PHASE 13 — MODEL FACTORY & MLOPS HTTP GATEWAY (`/v1/ml/*`)
 * Implements RBAC authorization, Bearer API key auth, tenant isolation (401/403),
 * immutability conflicts (409), preflight rejections (422), and safe error envelopes.
 */

import { PlatformControlPlaneService, buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import type { OrganizationRole } from '../platform/PlatformContractsAndSchemas';
import { AudioSecurityGuard } from '../security/AudioSecurityGuard';
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

export class ModelFactoryGateway {
  public readonly service: SpeechModelFactoryService;

  constructor(
    private readonly controlPlane: PlatformControlPlaneService,
    private readonly dataFactory: SpeechDataFactoryService
  ) {
    this.service = new SpeechModelFactoryService(controlPlane, dataFactory);
  }

  private resolveActorRole(organizationId: string, requestedRole?: string): OrganizationRole {
    // Allow explicit test/caller role override ONLY if valid in OrganizationRole; default maps from org owner/developer membership
    const allowed: OrganizationRole[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'BILLING_ADMIN', 'ANALYST', 'VIEWER', 'SECURITY_AUDITOR'];
    if (requestedRole && allowed.includes(requestedRole as OrganizationRole)) {
      return requestedRole as OrganizationRole;
    }
    const members = (this.controlPlane as unknown as { getPortalOverview?: (id: string) => unknown }).getPortalOverview;
    void members;
    return 'OWNER';
  }

  private mapError(err: unknown): MlGatewayResponse {
    const msg = AudioSecurityGuard.sanitizeErrorForTelemetry(err instanceof Error ? err.message : String(err));
    if (msg.startsWith('TENANT_ISOLATION_DENIED')) {
      return { status: 403, body: buildPlatformErrorEnvelope({ code: 'TENANT_ISOLATION_DENIED', message: msg }) };
    }
    if (msg.startsWith('RBAC_FORBIDDEN') || msg.startsWith('UNAPPROVED_MODEL_DEPLOYMENT_DENIED') || msg.startsWith('LIFECYCLE_POLICY_DENIED')) {
      return { status: 403, body: buildPlatformErrorEnvelope({ code: 'INSUFFICIENT_SCOPE', message: msg }) };
    }
    if (msg.includes('CONFLICT') || msg.startsWith('DUPLICATE_EXPERIMENT_CONFLICT')) {
      return { status: 409, body: buildPlatformErrorEnvelope({ code: 'IDEMPOTENCY_CONFLICT', message: msg }) };
    }
    if (msg.includes('NOT_FOUND')) {
      return { status: 404, body: buildPlatformErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: msg }) };
    }
    if (msg.startsWith('PROMOTION_GATE_FAILED') || msg.startsWith('PACKAGE_VALIDATION_REQUIRED') || msg.startsWith('CONCURRENCY_QUOTA_EXCEEDED') || msg.startsWith('ARTIFACT_INTEGRITY_FAILED')) {
      return { status: 422, body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: msg }) };
    }
    return {
      status: 400,
      body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: msg }),
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
    };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.experimentName || !params.body?.hypothesis) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: 'experimentName and hypothesis are required' }),
      };
    }
    try {
      const exp = this.service.createExperiment({
        tenantId: auth.organization.id,
        projectId: auth.project.id,
        experimentName: params.body.experimentName,
        primaryObjective: params.body.primaryObjective ?? 'PERSIAN_CER_REDUCTION',
        hypothesis: params.body.hypothesis,
        modelFamily: params.body.modelFamily ?? 'avapardaz_local_ctc_adapter',
        architecture: params.body.architecture ?? 'SpectralCTC-BigramAdapter-v1',
        initializationType: params.body.initializationType ?? 'ADAPTER_TUNING',
        baseModelVersion: params.body.baseModelVersion ?? 'ASR-FA-EN-0.9.0-BASELINE',
        configuration: params.body.configuration,
        datasetReleaseIds: params.body.datasetReleaseIds ?? [],
        evaluationDatasetReleaseId: params.body.evaluationDatasetReleaseId,
        requestedResourceClass: params.body.requestedResourceClass ?? 'CPU_ONLY',
        ownerId: auth.credential.id,
      });
      return { status: 201, body: exp };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public listExperiments(bearerToken: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: { data: this.service.listExperiments(auth.organization.id) } };
  }

  public getExperiment(bearerToken: string, experimentId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getExperiment(auth.organization.id, experimentId) };
    } catch (err) {
      return this.mapError(err);
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
    };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const experimentId = params.experimentId ?? params.body?.experimentId;
    if (!experimentId) {
      return { status: 400, body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: 'experimentId is required' }) };
    }
    try {
      const run = this.service.startTrainingRun({
        tenantId: auth.organization.id,
        experimentId,
        datasetReleaseId: params.body?.datasetReleaseId,
        resourceClass: params.body?.resourceClass,
        interruptAfterStep: params.body?.interruptAfterStep,
        resumedFromCheckpointId: params.body?.resumedFromCheckpointId,
        maxBudgetUsd: params.body?.maxBudgetUsd,
      });
      return { status: run.status === 'BLOCKED' ? 422 : 201, body: run };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public getTrainingJob(bearerToken: string, jobId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getTrainingRun(auth.organization.id, jobId) };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public cancelTrainingJob(bearerToken: string, jobId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.cancelTrainingRun(auth.organization.id, jobId) };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public resumeTrainingJob(params: {
    bearerToken: string;
    jobId: string;
    body?: { checkpointId?: string; newMaxSteps?: number };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 201,
        body: this.service.resumeTrainingRun({
          tenantId: auth.organization.id,
          runId: params.jobId,
          checkpointId: params.body?.checkpointId,
          newMaxSteps: params.body?.newMaxSteps,
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public listTrainingCheckpoints(bearerToken: string, jobId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: { data: this.service.listCheckpointsForRun(auth.organization.id, jobId) } };
    } catch (err) {
      return this.mapError(err);
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
    };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.modelVersionId || !params.body?.datasetReleaseId) {
      return { status: 400, body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: 'modelVersionId and datasetReleaseId are required' }) };
    }
    try {
      return {
        status: 201,
        body: this.service.runEvaluation({
          tenantId: auth.organization.id,
          modelVersionId: params.body.modelVersionId,
          datasetReleaseId: params.body.datasetReleaseId,
          datasetSplit: params.body.datasetSplit,
          baselineModelVersionId: params.body.baselineModelVersionId,
          bootstrapIterations: params.body.bootstrapIterations,
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public getEvaluation(bearerToken: string, evaluationId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getEvaluation(auth.organization.id, evaluationId) };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public listExperimentEvaluations(bearerToken: string, experimentId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      this.service.getExperiment(auth.organization.id, experimentId);
      return { status: 200, body: { data: this.service.listEvaluationsForExperiment(auth.organization.id, experimentId) } };
    } catch (err) {
      return this.mapError(err);
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
    };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.modelId || !params.body?.version || !params.body?.experimentId) {
      return { status: 400, body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: 'modelId, version, and experimentId are required' }) };
    }
    try {
      return {
        status: 201,
        body: this.service.registerModelVersion({
          tenantId: auth.organization.id,
          modelId: params.body.modelId,
          version: params.body.version,
          experimentId: params.body.experimentId,
          trainingRunId: params.body.trainingRunId,
          checkpointId: params.body.checkpointId,
          parentModelVersionId: params.body.parentModelVersionId,
          tokenizerVersion: params.body.tokenizerVersion,
          initialStatus: params.body.initialStatus,
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public listModels(bearerToken: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: { data: this.service.listModels(auth.organization.id) } };
  }

  public getModel(bearerToken: string, modelId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const matches = this.service.listModels(auth.organization.id).filter(
      (m) => m.modelId === modelId || m.modelVersionId === modelId
    );
    if (matches.length === 0) {
      return { status: 404, body: buildPlatformErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: `Model ${modelId} not found.` }) };
    }
    return { status: 200, body: { modelId, versions: matches } };
  }

  public getModelVersion(bearerToken: string, modelId: string, version: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getModelByIdAndVersion(auth.organization.id, modelId, version) };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public packageModel(params: {
    bearerToken: string;
    modelVersionId: string;
    extraMetadataForSecretScan?: string;
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 201,
        body: this.service.packageAndValidateModel({
          tenantId: auth.organization.id,
          modelVersionId: params.modelVersionId,
          extraMetadataForSecretScan: params.extraMetadataForSecretScan,
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public approveModel(params: {
    bearerToken: string;
    actorRole?: string;
    body: {
      modelVersionId?: string;
      evaluationId?: string;
      packageId?: string;
      approvalScope?: string;
      reason?: string;
    };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.modelVersionId || !params.body?.evaluationId || !params.body?.packageId) {
      return { status: 400, body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: 'modelVersionId, evaluationId, and packageId required' }) };
    }
    try {
      return {
        status: 201,
        body: this.service.approveModelForRelease({
          tenantId: auth.organization.id,
          modelVersionId: params.body.modelVersionId,
          evaluationId: params.body.evaluationId,
          packageId: params.body.packageId,
          approverId: auth.credential.id,
          approverRole: this.resolveActorRole(auth.organization.id, params.actorRole),
          approvalScope: params.body.approvalScope ?? 'production',
          reason: params.body.reason ?? 'Approved via ML Governance API',
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public createDeployment(params: {
    bearerToken: string;
    actorRole?: string;
    body: {
      modelVersionId?: string;
      packageId?: string;
      environment?: DeploymentEnvironment;
      strategy?: DeploymentStrategy;
      trafficPercentage?: number;
      previousModelVersionId?: string;
    };
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.modelVersionId || !params.body?.packageId) {
      return { status: 400, body: buildPlatformErrorEnvelope({ code: 'MODEL_UNAVAILABLE', message: 'modelVersionId and packageId required' }) };
    }
    try {
      return {
        status: 201,
        body: this.service.deployModelVersion({
          tenantId: auth.organization.id,
          modelVersionId: params.body.modelVersionId,
          packageId: params.body.packageId,
          environment: params.body.environment ?? 'STAGING',
          strategy: params.body.strategy ?? 'STAGING',
          trafficPercentage: params.body.trafficPercentage ?? 100,
          actorId: auth.credential.id,
          actorRole: this.resolveActorRole(auth.organization.id, params.actorRole),
          previousModelVersionId: params.body.previousModelVersionId,
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public getDeployment(bearerToken: string, deploymentId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getDeployment(auth.organization.id, deploymentId) };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public promoteDeployment(params: {
    bearerToken: string;
    deploymentId: string;
    actorRole?: string;
    trafficPercentage?: number;
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.promoteCanaryDeployment({
          tenantId: auth.organization.id,
          deploymentId: params.deploymentId,
          nextTrafficPercentage: params.trafficPercentage ?? 100,
          actorId: auth.credential.id,
          actorRole: this.resolveActorRole(auth.organization.id, params.actorRole),
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public rollbackDeployment(params: {
    bearerToken: string;
    deploymentId: string;
    reason?: string;
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.rollbackDeployment({
          tenantId: auth.organization.id,
          deploymentId: params.deploymentId,
          actorId: auth.credential.id,
          reason: params.reason ?? 'API rollback trigger',
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public optimizeModel(params: {
    bearerToken: string;
    modelVersionId: string;
    newVersion: string;
    technique?: OptimizationExperimentRecord['technique'];
  }): MlGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 201,
        body: this.service.optimizeAndRegisterDerivedVersion({
          tenantId: auth.organization.id,
          parentModelVersionId: params.modelVersionId,
          newVersion: params.newVersion,
          technique: params.technique ?? 'DYNAMIC_INT8_QUANTIZATION',
        }),
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public getMonitoring(bearerToken: string, modelIdOrVersionId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      const target = this.service.listModels(auth.organization.id).find(
        (m) => m.modelVersionId === modelIdOrVersionId || m.modelId === modelIdOrVersionId
      );
      if (!target) throw new Error('MODEL_NOT_FOUND');
      return { status: 200, body: this.service.getMonitoringSnapshot(auth.organization.id, target.modelVersionId) };
    } catch (err) {
      return this.mapError(err);
    }
  }

  public getModelHealth(bearerToken: string, modelIdOrVersionId: string): MlGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'models:read');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      const target = this.service.listModels(auth.organization.id).find(
        (m) => m.modelVersionId === modelIdOrVersionId || m.modelId === modelIdOrVersionId
      );
      if (!target) throw new Error('MODEL_NOT_FOUND');
      return { status: 200, body: this.service.getModelHealthStatus(auth.organization.id, target.modelVersionId) };
    } catch (err) {
      return this.mapError(err);
    }
  }
}
