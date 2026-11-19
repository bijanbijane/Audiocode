/**
 * PHASE 14 — HARDENED SECURITY HTTP GATEWAY (`/v1/security/*`)
 *
 * Enforces centralized fail-closed server-side authorization (`AuthorizationPolicyEngine`),
 * verified organization membership RBAC, least-privilege credential scopes, strict tenant
 * and resource ownership boundaries, schema-validated retention mutations, and scrubbed telemetry.
 *
 * Security invariants:
 * - No fail-open `OWNER` fallback exists anywhere in this gateway.
 * - Client-supplied roles (`actorRole`, `role`, `x-avapardaz-role`), tenant IDs, or actor IDs
 *   never establish authorization or override provenance.
 */

import { buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import type {
  PiiRedactionConfig,
  SecurityAuditEventType,
} from './SpeechSecurityContracts';
import { sanitizeSecurityTelemetry } from './PrivacyRetentionAndIsolationEngine';
import type { SpeechSecurityService } from './SpeechSecurityService';
import {
  authorizePlatformOperation,
  extractClaimedTenantId,
  validateRetentionPolicyPatch,
  type SecurityOperationId,
  type TrustedAuthContext,
} from './AuthorizationPolicyEngine';

export interface SecurityGatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

const VALID_SECURITY_AUDIT_EVENT_TYPES = new Set<SecurityAuditEventType>([
  'AUDIO_UPLOAD_REJECTED',
  'URL_FETCH_SSRF_BLOCKED',
  'STREAMING_FRAME_REJECTED',
  'STREAMING_SESSION_HIJACK_BLOCKED',
  'QUOTA_OR_CONCURRENCY_EXCEEDED',
  'TRANSCRIPT_PROMPT_INJECTION_DETECTED',
  'TOOL_EXECUTION_UNAUTHORIZED_BLOCKED',
  'MODEL_ARTIFACT_TAMPER_OR_UNSAFE_BLOCKED',
  'DATASET_POISONING_ANOMALY_FLAGGED',
  'TENANT_CROSS_BOUNDARY_ACCESS_DENIED',
  'PII_REDACTION_DERIVATIVE_CREATED',
  'PRIVACY_RETENTION_DELETION_EXECUTED',
  'AUTHORIZATION_DENIED',
  'RETENTION_POLICY_UPDATED',
  'MODEL_GOVERNANCE_DECISION',
]);

export class SpeechSecurityGateway {
  constructor(public readonly service: SpeechSecurityService) {}

  private authorize(params: {
    readonly bearerToken: string;
    readonly operation: SecurityOperationId;
    readonly claimedTenantId?: string | null;
    readonly resourceId?: string;
    readonly nowMs?: number;
  }):
    | { readonly ok: true; readonly context: TrustedAuthContext }
    | { readonly ok: false; readonly response: SecurityGatewayResponse } {
    const decision = authorizePlatformOperation({
      controlPlane: this.service.getControlPlane(),
      bearerToken: params.bearerToken,
      operation: params.operation,
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });

    if (!decision.allowed) {
      if (decision.organizationId) {
        this.service.privacyEngine.recordSecurityEvent({
          tenantId: decision.organizationId,
          eventType:
            decision.reasonCode === 'DENIED_TENANT_BOUNDARY_MISMATCH' ||
            decision.reasonCode === 'DENIED_RESOURCE_OWNERSHIP_VIOLATION'
              ? 'TENANT_CROSS_BOUNDARY_ACCESS_DENIED'
              : 'AUTHORIZATION_DENIED',
          severity:
            decision.reasonCode === 'DENIED_TENANT_BOUNDARY_MISMATCH' ? 'CRITICAL' : 'HIGH',
          actorId: decision.principalId ?? 'unauthenticated',
          resourceType: 'security_operation',
          resourceId: params.resourceId ?? params.operation,
          actionOutcome: 'DENIED',
          summary: `Denied ${params.operation} (${decision.reasonCode}).`,
          metadata: {
            operation: params.operation,
            reasonCode: decision.reasonCode,
            verifiedRole: decision.role,
          },
        });
      }
      return {
        ok: false,
        response: { status: decision.httpStatus, body: decision.errorEnvelope },
      };
    }

    return { ok: true, context: decision.context };
  }

  private mapServiceError(err: unknown): SecurityGatewayResponse {
    const raw = err instanceof Error ? err.message : String(err);
    const cleanMsg = sanitizeSecurityTelemetry(raw);
    if (raw.startsWith('TENANT_ISOLATION_DENIED')) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Resource access denied.',
        }),
      };
    }
    if (raw.startsWith('RATE_LIMITED') || raw.startsWith('CONCURRENCY_LIMIT_EXCEEDED')) {
      return {
        status: 429,
        body: buildPlatformErrorEnvelope({
          code: 'RATE_LIMITED',
          message: 'Security operation rate or concurrency limit exceeded.',
          retryable: true,
          retryAfterSeconds: 60,
        }),
      };
    }
    if (raw.startsWith('VALIDATION_ERROR') || raw.startsWith('RETENTION_POLICY_INVALID')) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: cleanMsg,
        }),
      };
    }
    return {
      status: 400,
      body: buildPlatformErrorEnvelope({
        code: 'VALIDATION_ERROR',
        message: cleanMsg,
      }),
    };
  }

  // 1. Read threat model
  public getThreatModel(
    bearerToken: string,
    options?: { readonly claimedTenantId?: string | null; readonly nowMs?: number }
  ): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'SECURITY_READ_THREAT_MODEL',
      claimedTenantId: options?.claimedTenantId,
      nowMs: options?.nowMs,
    });
    if (!auth.ok) return auth.response;
    return { status: 200, body: this.service.getThreatModelAndPlaybooks() };
  }

  // 2. Inspect audio upload
  public inspectUpload(params: {
    bearerToken: string;
    body: {
      filename?: string;
      base64Bytes?: string;
      sampleRateHz?: number;
      channels?: number;
      durationSeconds?: number;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_INSPECT_AUDIO_UPLOAD',
      claimedTenantId: extractClaimedTenantId(params.body),
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    const rawBytes =
      typeof params.body?.base64Bytes === 'string'
        ? Uint8Array.from(Buffer.from(params.body.base64Bytes, 'base64'))
        : new Uint8Array(0);
    const result = this.service.inspectAudioPayload({
      tenantId: auth.context.organizationId,
      actorId: auth.context.principalId,
      filename: typeof params.body?.filename === 'string' ? params.body.filename : 'upload.wav',
      bytes: rawBytes,
      sampleRateHz: typeof params.body?.sampleRateHz === 'number' ? params.body.sampleRateHz : 16000,
      channels: typeof params.body?.channels === 'number' ? params.body.channels : 1,
      durationSeconds: typeof params.body?.durationSeconds === 'number' ? params.body.durationSeconds : 1,
    });
    return { status: result.accepted ? 200 : 422, body: result };
  }

  // 3. Validate remote URL
  public validateRemoteUrl(params: {
    bearerToken: string;
    url: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_VALIDATE_REMOTE_URL',
      claimedTenantId: params.claimedTenantId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    const res = this.service.validateRemoteMediaUrl({
      tenantId: auth.context.organizationId,
      actorId: auth.context.principalId,
      url: typeof params.url === 'string' ? params.url : '',
    });
    return { status: res.allowed ? 200 : 403, body: res };
  }

  // 4. Run robustness evaluation (client-supplied actorRole is strictly ignored)
  public runRobustnessSuite(params: {
    bearerToken: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    modelVersionId?: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_RUN_ROBUSTNESS_EVALUATION',
      claimedTenantId: params.claimedTenantId,
      resourceId: params.modelVersionId ?? 'asr-fa-en-local-adapter@1.0.0',
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    try {
      const report = this.service.runRobustnessEvaluation({
        tenantId: auth.context.organizationId,
        modelVersionId: params.modelVersionId ?? 'asr-fa-en-local-adapter@1.0.0',
        authorizedOperatorContext: true,
      });
      return { status: 200, body: report };
    } catch (err) {
      return this.mapServiceError(err);
    }
  }

  // 5. Evaluate transcript boundary
  public evaluateTranscriptBoundary(params: {
    bearerToken: string;
    recordingId?: string;
    transcriptText?: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): SecurityGatewayResponse {
    const recordingId =
      typeof params.recordingId === 'string' && params.recordingId.trim().length > 0
        ? params.recordingId.trim()
        : 'rec_api_01';

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_EVALUATE_TRANSCRIPT_BOUNDARY',
      claimedTenantId: params.claimedTenantId,
      resourceId: recordingId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    try {
      const env = this.service.protectTranscriptAndCheckTool({
        tenantId: auth.context.organizationId,
        recordingId,
        rawTranscriptText: typeof params.transcriptText === 'string' ? params.transcriptText : '',
        actorId: auth.context.principalId,
      });
      return { status: 200, body: env };
    } catch (err) {
      return this.mapServiceError(err);
    }
  }

  // 6. Create redacted derivative
  public createRedactedDerivative(params: {
    bearerToken: string;
    body: {
      recordingId?: string;
      originalTranscript?: string;
      config?: Partial<PiiRedactionConfig>;
      [extra: string]: unknown;
    };
    nowMs?: number;
  }): SecurityGatewayResponse {
    const recordingId =
      typeof params.body?.recordingId === 'string' && params.body.recordingId.trim().length > 0
        ? params.body.recordingId.trim()
        : 'rec_api_01';

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_CREATE_REDACTED_DERIVATIVE',
      claimedTenantId: extractClaimedTenantId(params.body),
      resourceId: recordingId,
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    try {
      const deriv = this.service.createPiiDerivative({
        tenantId: auth.context.organizationId,
        recordingId,
        originalTranscript:
          typeof params.body?.originalTranscript === 'string' ? params.body.originalTranscript : '',
        config: params.body?.config,
        actorId: auth.context.principalId,
      });
      return { status: 201, body: deriv };
    } catch (err) {
      return this.mapServiceError(err);
    }
  }

  // 7. Update retention policy (strict allowlist schema + server-derived tenant/author/timestamp)
  public updateRetentionPolicy(params: {
    bearerToken: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    body: Record<string, unknown>;
    nowMs?: number;
  }): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_UPDATE_RETENTION_POLICY',
      claimedTenantId: extractClaimedTenantId(params.body),
      resourceId: 'privacy_retention_policy',
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    const validated = validateRetentionPolicyPatch(params.body, auth.context.organizationId);
    if (!validated.ok) {
      return {
        status: validated.httpStatus,
        body: buildPlatformErrorEnvelope({
          code: validated.code,
          message: validated.message,
          requestId: auth.context.requestId,
        }),
      };
    }

    try {
      const current = this.service.getRetentionPolicy(auth.context.organizationId);
      const updated = this.service.updateRetentionPolicy({
        rawAudioTtlDays: validated.patch.rawAudioTtlDays ?? current.rawAudioTtlDays,
        intermediateChunksTtlHours:
          validated.patch.intermediateChunksTtlHours ?? current.intermediateChunksTtlHours,
        rawTranscriptTtlDays: validated.patch.rawTranscriptTtlDays ?? current.rawTranscriptTtlDays,
        redactedTranscriptTtlDays:
          validated.patch.redactedTranscriptTtlDays ?? current.redactedTranscriptTtlDays,
        diagnosticsTtlDays: validated.patch.diagnosticsTtlDays ?? current.diagnosticsTtlDays,
        securityLogsTtlDays: validated.patch.securityLogsTtlDays ?? current.securityLogsTtlDays,
        externalApiTransferAllowed:
          validated.patch.externalApiTransferAllowed ?? current.externalApiTransferAllowed,
        allowedResidencyRegion:
          validated.patch.allowedResidencyRegion ?? current.allowedResidencyRegion,
        tenantId: auth.context.organizationId,
        updatedBy: auth.context.principalId,
      });
      return { status: 200, body: updated };
    } catch (err) {
      return this.mapServiceError(err);
    }
  }

  // 8. Execute deletion cascade (strict tenant ownership + RBAC + zero partial mutation)
  public executeDeletion(params: {
    bearerToken: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    recordingId: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): SecurityGatewayResponse {
    const recordingId = typeof params.recordingId === 'string' ? params.recordingId.trim() : '';
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_EXECUTE_DELETION_CASCADE',
      claimedTenantId: params.claimedTenantId,
      resourceId: recordingId || 'missing_recording_id',
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    if (!recordingId || recordingId.length > 128 || /[\r\n\\]|\.\./.test(recordingId)) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Valid recordingId is required.',
          requestId: auth.context.requestId,
        }),
      };
    }

    try {
      const report = this.service.deleteRecordingWithCascade({
        tenantId: auth.context.organizationId,
        recordingId,
        actorId: auth.context.principalId,
      });
      return { status: 200, body: report };
    } catch (err) {
      return this.mapServiceError(err);
    }
  }

  // 9. Run red-team suite (RBAC + scopes + bounded execution)
  public runRedTeamSuite(params: {
    bearerToken: string;
    /** @deprecated Ignored for authorization; server resolves role strictly from verified membership. */
    actorRole?: string;
    claimedTenantId?: string | null;
    nowMs?: number;
  }): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'SECURITY_RUN_RED_TEAM_SUITE',
      claimedTenantId: params.claimedTenantId,
      resourceId: 'red_team_suite',
      nowMs: params.nowMs,
    });
    if (!auth.ok) return auth.response;

    try {
      const groups = this.service.runFullRedTeamVerificationSuite(auth.context.organizationId);
      return { status: 200, body: { groups } };
    } catch (err) {
      return this.mapServiceError(err);
    }
  }

  // 10. Read security audit events (RBAC + scopes + strictly tenant-scoped & redacted)
  public getAuditEvents(
    bearerToken: string,
    options?: {
      readonly limit?: number;
      readonly eventType?: string;
      readonly claimedTenantId?: string | null;
      readonly nowMs?: number;
    }
  ): SecurityGatewayResponse {
    const auth = this.authorize({
      bearerToken,
      operation: 'SECURITY_READ_AUDIT_EVENTS',
      claimedTenantId: options?.claimedTenantId,
      resourceId: 'security_audit_events',
      nowMs: options?.nowMs,
    });
    if (!auth.ok) return auth.response;

    let eventTypeFilter: SecurityAuditEventType | undefined;
    if (options?.eventType !== undefined && options.eventType !== '') {
      if (!VALID_SECURITY_AUDIT_EVENT_TYPES.has(options.eventType as SecurityAuditEventType)) {
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: 'Invalid security audit eventType filter.',
            requestId: auth.context.requestId,
          }),
        };
      }
      eventTypeFilter = options.eventType as SecurityAuditEventType;
    }

    const events = this.service.listSecurityEvents(auth.context.organizationId, {
      limit: options?.limit,
      eventType: eventTypeFilter,
    });
    return { status: 200, body: { events } };
  }
}
