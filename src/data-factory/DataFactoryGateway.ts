/**
 * PHASE 12 — DATA FACTORY HTTP GATEWAY (`/v1/data/*`, `/v1/datasets/*`)
 * Bridges Express/HTTP endpoints with SpeechDataFactoryService while enforcing
 * Bearer API key authentication, tenant isolation (401/403), and structured error envelopes.
 */

import { PlatformControlPlaneService, buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import { SpeechDataFactoryService, buildErrorStatus } from './SpeechDataFactoryService';
import type {
  AugmentationConfig,
  DatasetReleaseType,
  IngestionSourceType,
  LanguageClassification,
  RightsPermissions,
  SplitPolicyConfig,
  StereoChannelPolicy,
} from './DataFactoryContracts';

export interface GatewayHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export class DataFactoryGateway {
  public readonly service: SpeechDataFactoryService;

  constructor(private readonly controlPlane: PlatformControlPlaneService) {
    this.service = new SpeechDataFactoryService(controlPlane);
  }

  private mapErrorToHttp(err: unknown): GatewayHttpResponse {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('TENANT_ISOLATION_DENIED') || msg.startsWith('TENANT_OR_SOURCE_NOT_FOUND')) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({ code: 'TENANT_ISOLATION_DENIED', message: msg }),
      };
    }
    if (msg.startsWith('BLIND_ANNOTATION_VIOLATION') || msg.startsWith('RIGHTS_DENIED')) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({ code: 'INSUFFICIENT_SCOPE', message: msg }),
      };
    }
    if (msg.startsWith('IMMUTABLE_RELEASE_CONFLICT') || msg.startsWith('RIGHTS_REVOKED_IMMUTABLE')) {
      return { status: 409, body: buildErrorStatus('CONFLICT', msg) };
    }
    if (msg.startsWith('RELEASE_NOT_FOUND') || msg.startsWith('ARTIFACT_MISSING')) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: msg }),
      };
    }
    if (msg.includes('EXCEEDED') || msg.includes('TOO_LARGE') || msg.includes('UPLOAD_TOO_LARGE')) {
      return { status: 413, body: buildErrorStatus('UPLOAD_LIMIT', msg) };
    }
    return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', msg) };
  }

  public createDataSource(params: {
    bearerToken: string;
    body: {
      sourceType?: IngestionSourceType;
      sourceName?: string;
      ownerReference?: string;
      licenseReference?: string;
      verified?: boolean;
      provenanceMetadata?: Record<string, string | number | boolean>;
    };
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.sourceName || !params.body?.sourceType) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'sourceType and sourceName are required') };
    }
    try {
      const rec = this.service.createDataSource({
        tenantId: auth.organization.id,
        sourceType: params.body.sourceType,
        sourceName: params.body.sourceName,
        ownerReference: params.body.ownerReference ?? auth.organization.id,
        licenseReference: params.body.licenseReference ?? 'UNSPECIFIED',
        verified: Boolean(params.body.verified),
        provenanceMetadata: params.body.provenanceMetadata,
      });
      return { status: 201, body: rec };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public listDataSources(bearerToken: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: { data: this.service.listDataSources(auth.organization.id) } };
  }

  public async createIngestionJob(params: {
    bearerToken: string;
    idempotencyKey?: string;
    body: {
      entries?: Array<{
        sourceId: string;
        filename: string;
        claimedMimeType?: string;
        audioBase64: string;
        speakerRef?: string;
        sessionRef?: string;
        sourceCorpusTag?: string;
        domainTag?: string;
        declaredLanguage?: LanguageClassification;
        licenseId?: string;
        rightsVerified?: boolean;
        permissions?: Partial<RightsPermissions>;
        evaluationAllowed?: boolean;
      }>;
    };
  }): Promise<GatewayHttpResponse> {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const entries = params.body?.entries ?? [];
    try {
      const job = await this.service.createIngestionJob({
        tenantId: auth.organization.id,
        projectId: auth.project.id,
        idempotencyKey: params.idempotencyKey,
        entries: entries.map((e, idx) => ({
          tenantId: auth.organization.id,
          projectId: auth.project.id,
          sourceId: e.sourceId,
          filename: e.filename,
          claimedMimeType: e.claimedMimeType,
          fileBytes: Buffer.from(e.audioBase64 ?? '', 'base64'),
          speakerRef: e.speakerRef ?? `spk_${idx}`,
          sessionRef: e.sessionRef ?? `ses_${idx}`,
          sourceCorpusTag: e.sourceCorpusTag,
          domainTag: e.domainTag,
          declaredLanguage: e.declaredLanguage,
          licenseId: e.licenseId,
          rightsVerified: e.rightsVerified,
          permissions: e.permissions,
          evaluationAllowed: e.evaluationAllowed,
        })),
      });
      return { status: 201, body: job };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public getIngestionJob(bearerToken: string, jobId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getIngestionJob(auth.organization.id, jobId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public cancelIngestionJob(bearerToken: string, jobId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.cancelIngestionJob(auth.organization.id, jobId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public async ingestRecording(params: {
    bearerToken: string;
    body: {
      sourceId?: string;
      filename?: string;
      claimedMimeType?: string;
      audioBase64?: string;
      speakerRef?: string;
      sessionRef?: string;
      sourceCorpusTag?: string;
      domainTag?: string;
      declaredLanguage?: LanguageClassification;
      licenseId?: string;
      rightsVerified?: boolean;
      permissions?: Partial<RightsPermissions>;
      evaluationAllowed?: boolean;
      autoNormalizeCanonical?: boolean;
      channelPolicyOverride?: StereoChannelPolicy;
    };
  }): Promise<GatewayHttpResponse> {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.sourceId || !params.body?.audioBase64) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'sourceId and audioBase64 are required') };
    }
    try {
      const out = await this.service.ingestRecording({
        tenantId: auth.organization.id,
        projectId: auth.project.id,
        sourceId: params.body.sourceId,
        filename: params.body.filename ?? 'upload.wav',
        claimedMimeType: params.body.claimedMimeType,
        fileBytes: Buffer.from(params.body.audioBase64, 'base64'),
        speakerRef: params.body.speakerRef ?? 'spk_anon',
        sessionRef: params.body.sessionRef ?? 'ses_default',
        sourceCorpusTag: params.body.sourceCorpusTag,
        domainTag: params.body.domainTag,
        declaredLanguage: params.body.declaredLanguage,
        licenseId: params.body.licenseId,
        rightsVerified: params.body.rightsVerified,
        permissions: params.body.permissions,
        evaluationAllowed: params.body.evaluationAllowed,
        autoNormalizeCanonical: params.body.autoNormalizeCanonical,
        channelPolicyOverride: params.body.channelPolicyOverride,
      });
      return { status: 201, body: out };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public listRecordings(bearerToken: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: { data: this.service.listRecordings(auth.organization.id) } };
  }

  public getRecording(bearerToken: string, recordingId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getRecording(auth.organization.id, recordingId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public getRecordingArtifacts(bearerToken: string, recordingId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: { data: this.service.getArtifactsForRecording(auth.organization.id, recordingId) } };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public normalizeRecording(params: {
    bearerToken: string;
    recordingId: string;
    channelPolicy?: StereoChannelPolicy;
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      const art = this.service.normalizeRecordingArtifact({
        tenantId: auth.organization.id,
        recordingId: params.recordingId,
        channelPolicy: params.channelPolicy,
      });
      return { status: 201, body: art };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public augmentRecording(params: {
    bearerToken: string;
    recordingId: string;
    config: AugmentationConfig;
    datasetReleaseId?: string | null;
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      const art = this.service.createAugmentedArtifact({
        tenantId: auth.organization.id,
        recordingId: params.recordingId,
        config: params.config,
        datasetReleaseId: params.datasetReleaseId,
      });
      return { status: 201, body: art };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public validateRecording(bearerToken: string, recordingId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.validateRecordingIntegrity(auth.organization.id, recordingId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public createAnnotation(params: {
    bearerToken: string;
    body: Parameters<SpeechDataFactoryService['createAnnotationDraft']>[0];
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      const ann = this.service.createAnnotationDraft({
        ...params.body,
        tenantId: auth.organization.id,
      });
      return { status: 201, body: ann };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public getAnnotation(params: {
    bearerToken: string;
    annotationId: string;
    requesterAnnotatorId?: string;
    isReviewer?: boolean;
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.getAnnotationForAnnotator({
          tenantId: auth.organization.id,
          annotationId: params.annotationId,
          requesterAnnotatorId: params.requesterAnnotatorId,
          isReviewer: params.isReviewer,
        }),
      };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public submitAnnotation(params: {
    bearerToken: string;
    annotationId: string;
    segments: Parameters<SpeechDataFactoryService['submitAnnotation']>[0]['segments'];
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.submitAnnotation({
          tenantId: auth.organization.id,
          annotationId: params.annotationId,
          segments: params.segments,
        }),
      };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public reviewAnnotation(params: {
    bearerToken: string;
    annotationId: string;
    body: {
      reviewerId?: string;
      action?: 'APPROVED' | 'NEEDS_CORRECTION' | 'REJECTED' | 'ADJUDICATE';
      resolvedSegments?: Parameters<SpeechDataFactoryService['reviewOrAdjudicateAnnotation']>[0]['resolvedSegments'];
      policyNote?: string;
    };
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.reviewOrAdjudicateAnnotation({
          tenantId: auth.organization.id,
          annotationId: params.annotationId,
          reviewerId: params.body.reviewerId ?? 'reviewer_api',
          action: params.body.action ?? 'APPROVED',
          resolvedSegments: params.body.resolvedSegments,
          policyNote: params.body.policyNote,
        }),
      };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public createDataset(params: {
    bearerToken: string;
    body: { datasetName?: string; description?: string };
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.datasetName) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'datasetName is required') };
    }
    return {
      status: 201,
      body: this.service.createDatasetDefinition({
        tenantId: auth.organization.id,
        datasetName: params.body.datasetName,
        description: params.body.description,
      }),
    };
  }

  public listDatasets(bearerToken: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: { data: this.service.listDatasets(auth.organization.id) } };
  }

  public buildDatasetRelease(params: {
    bearerToken: string;
    datasetId: string;
    body: {
      version?: string;
      releaseType?: DatasetReleaseType;
      releaseAuthor?: string;
      splitPolicy?: Partial<SplitPolicyConfig>;
      recordingIdsFilter?: readonly string[];
    };
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    if (!params.body?.version) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'version is required') };
    }
    try {
      const built = this.service.buildDatasetRelease({
        tenantId: auth.organization.id,
        datasetId: params.datasetId,
        version: params.body.version,
        releaseType: params.body.releaseType ?? 'TRAIN',
        releaseAuthor: params.body.releaseAuthor ?? auth.credential.name,
        splitPolicy: params.body.splitPolicy,
        recordingIdsFilter: params.body.recordingIdsFilter,
      });
      return { status: 201, body: built };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public auditDataset(bearerToken: string, datasetId: string, releaseId?: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.auditDatasetRelease(auth.organization.id, datasetId, releaseId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public listDatasetReleases(bearerToken: string, datasetId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: { data: this.service.listDatasetReleases(auth.organization.id, datasetId) } };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public getDatasetRelease(params: {
    bearerToken: string;
    releaseId: string;
    requesterRole?: 'TRAINING_PIPELINE' | 'AUTHORIZED_EVAL_WORKFLOW' | 'ADMIN';
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.getDatasetRelease({
          tenantId: auth.organization.id,
          releaseId: params.releaseId,
          requesterRole: params.requesterRole,
        }),
      };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public getRights(bearerToken: string, recordingId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.getRightsRecord(auth.organization.id, recordingId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public verifyRights(params: {
    bearerToken: string;
    recordingId: string;
    body: {
      licenseId?: string;
      permissions?: Partial<RightsPermissions>;
      evaluationAllowed?: boolean;
      legalHold?: boolean;
      expirationAtIso?: string | null;
    };
  }): GatewayHttpResponse {
    const auth = this.service.authenticate(params.bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return {
        status: 200,
        body: this.service.verifyRightsRecord({
          tenantId: auth.organization.id,
          recordingId: params.recordingId,
          licenseId: params.body.licenseId,
          permissions: params.body.permissions,
          evaluationAllowed: params.body.evaluationAllowed,
          legalHold: params.body.legalHold,
          expirationAtIso: params.body.expirationAtIso,
        }),
      };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public revokeRights(bearerToken: string, recordingId: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    try {
      return { status: 200, body: this.service.revokeRecordingRights(auth.organization.id, recordingId) };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
  }

  public getDashboard(bearerToken: string): GatewayHttpResponse {
    const auth = this.service.authenticate(bearerToken);
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: this.service.computeDashboardMetrics(auth.organization.id) };
  }
}
