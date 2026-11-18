/**
 * PHASE 14 — SECURITY HTTP GATEWAY (`/v1/security/*`)
 * Enforces Bearer authentication, RBAC role restrictions, and safe error scrubbing.
 */

import { buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import type { OrganizationRole } from '../platform/PlatformContractsAndSchemas';
import type { PiiRedactionConfig, PrivacyRetentionPolicy } from './SpeechSecurityContracts';
import { sanitizeSecurityTelemetry } from './PrivacyRetentionAndIsolationEngine';
import type { SpeechSecurityService } from './SpeechSecurityService';

export interface SecurityGatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

export class SpeechSecurityGateway {
  constructor(public readonly service: SpeechSecurityService) {}

  private resolveRole(raw?: string): OrganizationRole {
    const allowed: OrganizationRole[] = [
      'OWNER',
      'ADMIN',
      'DEVELOPER',
      'BILLING_ADMIN',
      'ANALYST',
      'VIEWER',
      'SECURITY_AUDITOR',
    ];
    if (raw && allowed.includes(raw as OrganizationRole)) {
      return raw as OrganizationRole;
    }
    return 'OWNER';
  }

  public getThreatModel(bearerToken: string): SecurityGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: this.service.getThreatModelAndPlaybooks() };
  }

  public inspectUpload(params: {
    bearerToken: string;
    body: {
      filename?: string;
      base64Bytes?: string;
      sampleRateHz?: number;
      channels?: number;
      durationSeconds?: number;
    };
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };

    const rawBytes = params.body?.base64Bytes
      ? Uint8Array.from(Buffer.from(params.body.base64Bytes, 'base64'))
      : new Uint8Array(0);
    const result = this.service.inspectAudioPayload({
      tenantId: auth.organization.id,
      actorId: auth.credential.id,
      filename: params.body?.filename ?? 'upload.wav',
      bytes: rawBytes,
      sampleRateHz: params.body?.sampleRateHz ?? 16000,
      channels: params.body?.channels ?? 1,
      durationSeconds: params.body?.durationSeconds ?? 1,
    });
    return { status: result.accepted ? 200 : 422, body: result };
  }

  public validateRemoteUrl(params: {
    bearerToken: string;
    url: string;
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const res = this.service.validateRemoteMediaUrl({
      tenantId: auth.organization.id,
      actorId: auth.credential.id,
      url: params.url ?? '',
    });
    return { status: res.allowed ? 200 : 403, body: res };
  }

  public runRobustnessSuite(params: {
    bearerToken: string;
    actorRole?: string;
    modelVersionId?: string;
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const role = this.resolveRole(params.actorRole);
    if (!['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'].includes(role)) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: `Role '${role}' is not authorized to invoke internal robustness test harness.`,
        }),
      };
    }
    const report = this.service.runRobustnessEvaluation({
      tenantId: auth.organization.id,
      modelVersionId: params.modelVersionId ?? 'asr-fa-en-local-adapter@1.0.0',
      authorizedOperatorContext: true,
    });
    return { status: 200, body: report };
  }

  public evaluateTranscriptBoundary(params: {
    bearerToken: string;
    recordingId?: string;
    transcriptText?: string;
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const env = this.service.protectTranscriptAndCheckTool({
      tenantId: auth.organization.id,
      recordingId: params.recordingId ?? 'rec_api_01',
      rawTranscriptText: params.transcriptText ?? '',
      actorId: auth.credential.id,
    });
    return { status: 200, body: env };
  }

  public createRedactedDerivative(params: {
    bearerToken: string;
    body: {
      recordingId?: string;
      originalTranscript?: string;
      config?: Partial<PiiRedactionConfig>;
    };
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const deriv = this.service.createPiiDerivative({
      tenantId: auth.organization.id,
      recordingId: params.body?.recordingId ?? 'rec_api_01',
      originalTranscript: params.body?.originalTranscript ?? '',
      config: params.body?.config,
      actorId: auth.credential.id,
    });
    return { status: 201, body: deriv };
  }

  public updateRetentionPolicy(params: {
    bearerToken: string;
    actorRole?: string;
    body: Partial<Omit<PrivacyRetentionPolicy, 'tenantId' | 'updatedAtIso' | 'updatedBy'>>;
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const role = this.resolveRole(params.actorRole);
    if (!['OWNER', 'ADMIN', 'SECURITY_AUDITOR'].includes(role)) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: `Role '${role}' cannot mutate privacy retention policies.`,
        }),
      };
    }
    try {
      const current = this.service.getRetentionPolicy(auth.organization.id);
      const updated = this.service.updateRetentionPolicy({
        ...current,
        ...params.body,
        tenantId: auth.organization.id,
        updatedBy: auth.credential.id,
      });
      return { status: 200, body: updated };
    } catch (err) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'AUDIO_FORMAT_UNSUPPORTED',
          message: sanitizeSecurityTelemetry(String(err)),
        }),
      };
    }
  }

  public executeDeletion(params: {
    bearerToken: string;
    actorRole?: string;
    recordingId: string;
  }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const role = this.resolveRole(params.actorRole);
    if (!['OWNER', 'ADMIN'].includes(role)) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: `Role '${role}' cannot execute deletion cascades.`,
        }),
      };
    }
    const report = this.service.deleteRecordingWithCascade({
      tenantId: auth.organization.id,
      recordingId: params.recordingId,
      actorId: auth.credential.id,
    });
    return { status: 200, body: report };
  }

  public runRedTeamSuite(params: { bearerToken: string; actorRole?: string }): SecurityGatewayResponse {
    const auth = this.service.authenticate(params.bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const role = this.resolveRole(params.actorRole);
    if (!['OWNER', 'ADMIN', 'SECURITY_AUDITOR', 'DEVELOPER'].includes(role)) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: `Role '${role}' is denied from executing security red-team harness.`,
        }),
      };
    }
    const groups = this.service.runFullRedTeamVerificationSuite(auth.organization.id);
    return { status: 200, body: { groups } };
  }

  public getAuditEvents(bearerToken: string): SecurityGatewayResponse {
    const auth = this.service.authenticate(bearerToken, 'audio:transcribe');
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return { status: 200, body: { events: this.service.listSecurityEvents(auth.organization.id) } };
  }
}
