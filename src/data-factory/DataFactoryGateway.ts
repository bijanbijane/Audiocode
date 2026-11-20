/**
 * PHASE 12 — DATA FACTORY HTTP GATEWAY (`/v1/data/*`, `/v1/datasets/*`)
 * Bridges Express/HTTP endpoints with SpeechDataFactoryService while enforcing
 * Bearer API key authentication, tenant isolation (401/403), and structured error envelopes.
 */

import { PlatformControlPlaneService, buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import { sanitizePublicErrorOutput } from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';
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

const ALLOWED_INGESTION_SOURCE_TYPES = new Set<IngestionSourceType>([
  'AUTHORIZED_USER_UPLOAD',
  'ORGANIZATION_CONTROLLED_RECORDING',
  'EXPLICITLY_LICENSED_CORPUS',
  'APPROVED_PUBLIC_DATASET',
  'CONSENT_CONTRIBUTOR_RECORDING',
  'APPROVED_HUMAN_ANNOTATION_DELIVERY',
  'AUTHORIZED_PRODUCTION_FEEDBACK',
]);

const ALLOWED_DATASET_RELEASE_TYPES = new Set<DatasetReleaseType>([
  'TRAIN',
  'VALIDATION',
  'TEST',
  'CHALLENGE',
  'REGRESSION',
  'STREAMING_EVALUATION',
  'RESEARCH_ONLY',
]);

export class DataFactoryGateway {
  public readonly service: SpeechDataFactoryService;

  constructor(private readonly controlPlane: PlatformControlPlaneService) {
    this.service = new SpeechDataFactoryService(controlPlane);
  }

  private mapErrorToHttp(err: unknown): GatewayHttpResponse {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const msg = sanitizePublicErrorOutput(rawMsg);
    if (rawMsg.startsWith('TENANT_ISOLATION_DENIED') || rawMsg.startsWith('TENANT_OR_SOURCE_NOT_FOUND')) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({ code: 'TENANT_ISOLATION_DENIED', message: msg }),
      };
    }
    if (rawMsg.startsWith('BLIND_ANNOTATION_VIOLATION') || rawMsg.startsWith('RIGHTS_DENIED')) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({ code: 'INSUFFICIENT_SCOPE', message: msg }),
      };
    }
    if (rawMsg.startsWith('IMMUTABLE_RELEASE_CONFLICT') || rawMsg.startsWith('RIGHTS_REVOKED_IMMUTABLE')) {
      return { status: 409, body: buildErrorStatus('CONFLICT', msg) };
    }
    if (rawMsg.startsWith('RELEASE_NOT_FOUND') || rawMsg.startsWith('ARTIFACT_MISSING')) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: msg }),
      };
    }
    if (rawMsg.includes('EXCEEDED') || rawMsg.includes('TOO_LARGE') || rawMsg.includes('UPLOAD_TOO_LARGE')) {
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
    if (
      typeof params.body?.sourceName !== 'string' ||
      params.body.sourceName.trim().length === 0 ||
      typeof params.body?.sourceType !== 'string' ||
      !ALLOWED_INGESTION_SOURCE_TYPES.has(params.body.sourceType as IngestionSourceType)
    ) {
      return {
        status: 400,
        body: buildErrorStatus(
          'VALIDATION_ERROR',
          'sourceName (non-empty string) and valid sourceType are required',
        ),
      };
    }
    try {
      const rec = this.service.createDataSource({
        tenantId: auth.organization.id,
        sourceType: params.body.sourceType,
        sourceName: params.body.sourceName.trim(),
        ownerReference:
          typeof params.body.ownerReference === 'string' && params.body.ownerReference.trim().length > 0
            ? params.body.ownerReference.trim()
            : auth.organization.id,
        licenseReference:
          typeof params.body.licenseReference === 'string' && params.body.licenseReference.trim().length > 0
            ? params.body.licenseReference.trim()
            : 'UNSPECIFIED',
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
    const rawEntries = (params.body as { entries?: unknown })?.entries;
    if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'entries must be an array') };
    }
    const entries = (rawEntries ?? []) as NonNullable<typeof params.body.entries>;
    for (const e of entries) {
      if (
        !e ||
        typeof e !== 'object' ||
        typeof e.sourceId !== 'string' ||
        typeof e.filename !== 'string' ||
        typeof e.audioBase64 !== 'string'
      ) {
        return {
          status: 400,
          body: buildErrorStatus(
            'VALIDATION_ERROR',
            'Each ingestion entry must include string sourceId, filename, and audioBase64',
          ),
        };
      }
    }
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
          claimedMimeType: typeof e.claimedMimeType === 'string' ? e.claimedMimeType : undefined,
          fileBytes: Buffer.from(e.audioBase64, 'base64'),
          speakerRef: typeof e.speakerRef === 'string' && e.speakerRef.trim() ? e.speakerRef : `spk_${idx}`,
          sessionRef: typeof e.sessionRef === 'string' && e.sessionRef.trim() ? e.sessionRef : `ses_${idx}`,
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
    if (
      typeof params.body?.sourceId !== 'string' ||
      params.body.sourceId.trim().length === 0 ||
      typeof params.body?.audioBase64 !== 'string' ||
      params.body.audioBase64.trim().length === 0
    ) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'sourceId and audioBase64 strings are required') };
    }
    try {
      const out = await this.service.ingestRecording({
        tenantId: auth.organization.id,
        projectId: auth.project.id,
        sourceId: params.body.sourceId.trim(),
        filename: typeof params.body.filename === 'string' && params.body.filename.trim() ? params.body.filename.trim() : 'upload.wav',
        claimedMimeType: typeof params.body.claimedMimeType === 'string' ? params.body.claimedMimeType : undefined,
        fileBytes: Buffer.from(params.body.audioBase64, 'base64'),
        speakerRef: typeof params.body.speakerRef === 'string' && params.body.speakerRef.trim() ? params.body.speakerRef : 'spk_anon',
        sessionRef: typeof params.body.sessionRef === 'string' && params.body.sessionRef.trim() ? params.body.sessionRef : 'ses_default',
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
    if (!params.config || typeof params.config !== 'object' || Array.isArray(params.config)) {
      return {
        status: 400,
        body: buildErrorStatus('VALIDATION_ERROR', 'config must be a valid AugmentationConfig object'),
      };
    }
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
    if (!params.body || typeof params.body !== 'object' || Array.isArray(params.body)) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'Request body must be a JSON object') };
    }
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
    // Never trust client-supplied ?reviewer=true unless API credential has reviewer/audit/admin scope
    const hasReviewerPrivilege =
      auth.credential.scopes.includes('models:approve') ||
      auth.credential.scopes.includes('security:audit') ||
      auth.credential.scopes.includes('security:admin');
    const effectiveIsReviewer = Boolean(params.isReviewer) && hasReviewerPrivilege;
    try {
      return {
        status: 200,
        body: this.service.getAnnotationForAnnotator({
          tenantId: auth.organization.id,
          annotationId: params.annotationId,
          requesterAnnotatorId: params.requesterAnnotatorId,
          isReviewer: effectiveIsReviewer,
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
    if (!Array.isArray(params.segments)) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'segments must be an array') };
    }
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
    if (!params.body || typeof params.body !== 'object' || Array.isArray(params.body)) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'Request body must be a JSON object') };
    }
    const allowedActions = new Set(['APPROVED', 'NEEDS_CORRECTION', 'REJECTED', 'ADJUDICATE']);
    if (
      params.body.action !== undefined &&
      (typeof params.body.action !== 'string' || !allowedActions.has(params.body.action))
    ) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'Unsupported review action') };
    }
    try {
      return {
        status: 200,
        body: this.service.reviewOrAdjudicateAnnotation({
          tenantId: auth.organization.id,
          annotationId: params.annotationId,
          reviewerId:
            typeof params.body.reviewerId === 'string' && params.body.reviewerId.trim()
              ? params.body.reviewerId.trim()
              : 'reviewer_api',
          action: params.body.action ?? 'APPROVED',
          resolvedSegments: params.body.resolvedSegments,
          policyNote: typeof params.body.policyNote === 'string' ? params.body.policyNote : undefined,
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
    if (typeof params.body?.datasetName !== 'string' || params.body.datasetName.trim().length === 0) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'datasetName must be a non-empty string') };
    }
    try {
      return {
        status: 201,
        body: this.service.createDatasetDefinition({
          tenantId: auth.organization.id,
          datasetName: params.body.datasetName.trim(),
          description: typeof params.body.description === 'string' ? params.body.description : undefined,
        }),
      };
    } catch (err) {
      return this.mapErrorToHttp(err);
    }
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
    if (typeof params.body?.version !== 'string' || params.body.version.trim().length === 0) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'version must be a non-empty string') };
    }
    if (
      params.body.releaseType !== undefined &&
      (typeof params.body.releaseType !== 'string' ||
        !ALLOWED_DATASET_RELEASE_TYPES.has(params.body.releaseType))
    ) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'Unsupported releaseType') };
    }
    try {
      const built = this.service.buildDatasetRelease({
        tenantId: auth.organization.id,
        datasetId: params.datasetId,
        version: params.body.version.trim(),
        releaseType: params.body.releaseType ?? 'TRAIN',
        releaseAuthor:
          typeof params.body.releaseAuthor === 'string' && params.body.releaseAuthor.trim()
            ? params.body.releaseAuthor.trim()
            : auth.credential.name,
        splitPolicy:
          params.body.splitPolicy && typeof params.body.splitPolicy === 'object' && !Array.isArray(params.body.splitPolicy)
            ? params.body.splitPolicy
            : undefined,
        recordingIdsFilter: Array.isArray(params.body.recordingIdsFilter)
          ? params.body.recordingIdsFilter.filter((id): id is string => typeof id === 'string')
          : undefined,
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
    // Strictly derive privilege ceiling from authenticated server-side scopes; client ?role cannot elevate
    const scopes = auth.credential.scopes;
    const canAdmin = scopes.includes('security:admin');
    const canEval = canAdmin || scopes.includes('models:approve') || scopes.includes('security:audit');
    let effectiveRole: 'TRAINING_PIPELINE' | 'AUTHORIZED_EVAL_WORKFLOW' | 'ADMIN' = 'TRAINING_PIPELINE';
    if (params.requesterRole === 'ADMIN' && canAdmin) {
      effectiveRole = 'ADMIN';
    } else if (
      (params.requesterRole === 'AUTHORIZED_EVAL_WORKFLOW' || params.requesterRole === 'ADMIN') &&
      canEval
    ) {
      effectiveRole = 'AUTHORIZED_EVAL_WORKFLOW';
    }
    try {
      return {
        status: 200,
        body: this.service.getDatasetRelease({
          tenantId: auth.organization.id,
          releaseId: params.releaseId,
          requesterRole: effectiveRole,
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
    if (!params.body || typeof params.body !== 'object' || Array.isArray(params.body)) {
      return { status: 400, body: buildErrorStatus('VALIDATION_ERROR', 'Request body must be a JSON object') };
    }
    try {
      return {
        status: 200,
        body: this.service.verifyRightsRecord({
          tenantId: auth.organization.id,
          recordingId: params.recordingId,
          licenseId: typeof params.body.licenseId === 'string' ? params.body.licenseId : undefined,
          permissions:
            params.body.permissions && typeof params.body.permissions === 'object' && !Array.isArray(params.body.permissions)
              ? params.body.permissions
              : undefined,
          evaluationAllowed:
            typeof params.body.evaluationAllowed === 'boolean' ? params.body.evaluationAllowed : undefined,
          legalHold: typeof params.body.legalHold === 'boolean' ? params.body.legalHold : undefined,
          expirationAtIso:
            typeof params.body.expirationAtIso === 'string' || params.body.expirationAtIso === null
              ? params.body.expirationAtIso
              : undefined,
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
