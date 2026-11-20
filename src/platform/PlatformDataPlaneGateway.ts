/**
 * PHASE 10 — PUBLIC API DATA PLANE GATEWAY (`/v1/*`)
 * Hardened under AVP-PUBLIC-DATAPLANE-REAL-AUDIO-010:
 * - Accepts strictly streamed binary audio payloads (`audio/wav`, `audio/ogg`, `audio/mpeg`, `audio/flac`, etc.).
 * - Never trusts client-supplied `audio_duration_ms`, `raw_text_hint`, `sample_id`, or `pcm_base64_preview`.
 * - Never invokes synthetic corpus lookups or placeholder text generators.
 * - Derives model availability honestly from `PublicAsrInferenceExecutor.getModelReadiness()`.
 * - Rejects `long_form_async` honestly with HTTP 501 `ASYNC_EXECUTION_UNAVAILABLE` until a real durable queue exists.
 * - Releases budget reservations on every inference/validation failure and guarantees temp artifact cleanup in `finally`.
 */

import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  PHASE10_PUBLIC_MODEL_CATALOG,
  PHASE10_VERSIONED_PLAN_CATALOG,
  PlatformControlPlaneService,
  buildPlatformErrorEnvelope,
  computeIntegerOverageChargeMinor,
} from './PlatformControlPlaneEngine';
import type {
  BatchJobLifecycleState,
  PlatformApiErrorEnvelope,
  PublicModelCatalogEntry,
  PublicTranscriptionJobRecord,
} from './PlatformContractsAndSchemas';
import type { DomainProfileName } from '../ai-engine/asr/IndependentAsrModelDevelopmentEngine';
import {
  PHASE5_STREAMING_BACKEND_REGISTRY,
  StreamingSessionGatewayManager,
} from '../ai-engine/asr/RealTimeStreamingAsrEngine';
import {
  DEFAULT_FULL_SANDBOX_CONSENT,
  PHASE11_CAPABILITY_REGISTRY,
  SpeechIntelligenceOrchestrator,
} from '../intelligence/CapabilityRegistryAndOrchestrator';
import type {
  EnterpriseConnectorKind,
  GranularProcessingConsent,
  IntelligenceCapabilityRequestItem,
  SpeechArtifactType,
} from '../intelligence/SpeechIntelligenceContracts';
import type { TimedSegmentInput } from '../intelligence/DiarizationAlignmentEngine';
import {
  ingestPublicAudioStream,
  PublicAudioIngestError,
  type PublicAudioArtifact,
} from './PublicAudioArtifactIngest';
import type { PublicAsrInferenceExecutor } from './PublicAsrInferenceExecutor';
import {
  isSyntheticPlaceholderText,
  NodePublicAsrInferenceExecutor,
  PublicInferenceExecutionError,
} from './NodePublicAsrInferenceExecutor';

const VALID_DOMAIN_PROFILES = new Set<string>([
  'general',
  'technology',
  'business',
  'real_estate',
  'education',
  'medical',
  'legal',
]);

const VALID_LANGUAGES = new Set<string>(['auto', 'fa', 'en', 'fa-en']);

const FORBIDDEN_LEGACY_TRANSCRIPTION_FIELDS = [
  'audio_duration_ms',
  'raw_text_hint',
  'sample_id',
  'pcm_base64_preview',
] as const;

interface StoredIdempotencyRecord {
  scopedKey: string;
  payloadHash: string;
  httpStatus: number;
  responseBody: unknown;
  expiresAtMs: number;
}

export interface CreateBinaryTranscriptionParams {
  bearerToken: string;
  idempotencyKey?: string;
  contentType: string | undefined;
  contentLengthHeader?: string | number;
  audioStream: Readable;
  options?: Record<string, unknown>;
  maxUploadBytes?: number;
  decodeTimeoutMs?: number;
  ffmpegBinaryPath?: string;
  abortSignal?: AbortSignal;
}

export class PlatformDataPlaneGateway {
  private readonly jobs = new Map<string, PublicTranscriptionJobRecord>();
  private readonly idempotencyStore = new Map<string, StoredIdempotencyRecord>();
  private readonly streamingGateway = new StreamingSessionGatewayManager(16, 4);
  public readonly intelligenceOrchestrator: SpeechIntelligenceOrchestrator;
  private readonly inferenceExecutor: PublicAsrInferenceExecutor;

  constructor(
    private readonly controlPlane: PlatformControlPlaneService,
    inferenceExecutor?: PublicAsrInferenceExecutor
  ) {
    this.intelligenceOrchestrator = new SpeechIntelligenceOrchestrator(controlPlane);
    this.inferenceExecutor = inferenceExecutor ?? new NodePublicAsrInferenceExecutor();
  }

  private hashCanonicalPayload(payload: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? {}), 'utf8').digest('hex');
  }

  public async resolveCatalogModelWithReadiness(
    entry: PublicModelCatalogEntry
  ): Promise<PublicModelCatalogEntry> {
    const readiness = await this.inferenceExecutor.getModelReadiness(entry.modelId);
    return {
      ...entry,
      version: readiness.modelVersion && readiness.modelVersion !== 'unknown' ? readiness.modelVersion : entry.version,
      availabilityInCurrentContainer: readiness.availability,
      timestampsSupported: readiness.ready ? readiness.timestampsSupported : false,
      diarizationSupported: readiness.ready ? readiness.diarizationSupported : false,
    };
  }

  public async resolveCatalogModelsForProject(
    allowedModels: readonly string[]
  ): Promise<PublicModelCatalogEntry[]> {
    const permitted = PHASE10_PUBLIC_MODEL_CATALOG.filter((m) =>
      allowedModels.includes(m.modelId)
    );
    return Promise.all(permitted.map((m) => this.resolveCatalogModelWithReadiness(m)));
  }

  public async listPublicModels(bearerToken: string): Promise<{
    status: number;
    body: { object: 'list'; data: readonly PublicModelCatalogEntry[] } | PlatformApiErrorEnvelope;
  }> {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'models:read',
    });
    if (!auth.authenticated) {
      return { status: auth.httpStatus, body: auth.errorEnvelope };
    }
    const visibleModels = await this.resolveCatalogModelsForProject(auth.project.allowedModels);
    return {
      status: 200,
      body: { object: 'list', data: visibleModels },
    };
  }

  public async getPublicModel(bearerToken: string, modelId: string): Promise<{
    status: number;
    body: PublicModelCatalogEntry | PlatformApiErrorEnvelope;
  }> {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'models:read',
    });
    if (!auth.authenticated) {
      return { status: auth.httpStatus, body: auth.errorEnvelope };
    }
    const baseModel = PHASE10_PUBLIC_MODEL_CATALOG.find(
      (m) => m.modelId === modelId && auth.project.allowedModels.includes(m.modelId)
    );
    if (!baseModel) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Model "${modelId}" was not found or is not permitted for this project.`,
        }),
      };
    }
    const resolved = await this.resolveCatalogModelWithReadiness(baseModel);
    return { status: 200, body: resolved };
  }

  public estimateTranscriptionCost(params: {
    bearerToken: string;
    modelId: string;
    durationSeconds: number;
    regionId?: string;
  }): {
    status: number;
    body:
      | {
          model: string;
          region_id: string;
          duration_seconds: number;
          plan_id: string;
          plan_version: string;
          overage_rate_minor_per_minute: number;
          estimated_charge_minor: number;
          currency: 'USD';
          is_final_invoice: false;
        }
      | PlatformApiErrorEnvelope;
  } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'audio:transcribe',
    });
    if (!auth.authenticated) {
      return { status: auth.httpStatus, body: auth.errorEnvelope };
    }

    const regionCheck = this.controlPlane.validateRegionPolicy({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      requestedRegionId: params.regionId,
    });
    if (!regionCheck.allowed) {
      return { status: 422, body: regionCheck.errorEnvelope };
    }

    const overview = this.controlPlane.getPortalOverview(auth.organization.id);
    const plan = overview.plan ?? PHASE10_VERSIONED_PLAN_CATALOG[0];
    const calc = computeIntegerOverageChargeMinor({
      billedAudioSeconds: Math.max(0, params.durationSeconds),
      includedAudioMinutes: 0,
      overageRateMinorPerMinute: plan.overageRateMinorPerMinute,
    });

    return {
      status: 200,
      body: {
        model: params.modelId || 'asr-fa-en-v1',
        region_id: regionCheck.region.regionId,
        duration_seconds: Math.max(0, Math.round(params.durationSeconds)),
        plan_id: plan.planId,
        plan_version: plan.planVersion,
        overage_rate_minor_per_minute: plan.overageRateMinorPerMinute,
        estimated_charge_minor: calc.overageChargeMinor,
        currency: 'USD',
        is_final_invoice: false,
      },
    };
  }

  /**
   * Public `POST /v1/audio/transcriptions` — Genuine Binary Audio Streaming Pipeline:
   * Auth -> Option Validation -> Async Mode Guard (501) -> Model Catalog & Readiness Probe (503) ->
   * Region Policy (422) -> Streaming Ingest + Constrained FFmpeg Decode + Canonical PCM Verification ->
   * Audio-SHA256 Idempotency Check (409 / replay) -> Atomic Budget Reservation (402) ->
   * Genuine Inference Execution -> Strict Output Validation -> Authoritative Ledger Commit / Release ->
   * Webhook Dispatch (success only) -> Guaranteed Temp Artifact Disposal.
   */
  public async createTranscription(
    params: CreateBinaryTranscriptionParams
  ): Promise<{ status: number; body: unknown }> {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'audio:transcribe',
    });
    if (!auth.authenticated) {
      params.audioStream.resume();
      return { status: auth.httpStatus, body: auth.errorEnvelope };
    }

    const reqId = `req_${crypto.randomUUID()}`;
    const rawOpts = params.options ?? {};
    if (typeof rawOpts !== 'object' || rawOpts === null || Array.isArray(rawOpts)) {
      params.audioStream.resume();
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Transcription options must be a JSON object.',
          requestId: reqId,
        }),
      };
    }

    // 1. Strictly reject forbidden client-trusted duration/text/corpus fields
    for (const forbiddenField of FORBIDDEN_LEGACY_TRANSCRIPTION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(rawOpts, forbiddenField) && rawOpts[forbiddenField] !== undefined) {
        params.audioStream.resume();
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: `Field "${forbiddenField}" is forbidden. Upload raw binary audio; duration and transcript are derived exclusively server-side.`,
            requestId: reqId,
          }),
        };
      }
    }

    // 2. Validate option schema
    const modelId = rawOpts.model === undefined ? 'asr-fa-en-v1' : String(rawOpts.model).trim();
    if (!modelId) {
      params.audioStream.resume();
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'model must be a non-empty string.',
          requestId: reqId,
        }),
      };
    }

    const languageRaw = rawOpts.language === undefined ? 'auto' : String(rawOpts.language);
    if (!VALID_LANGUAGES.has(languageRaw)) {
      params.audioStream.resume();
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: `Unsupported language "${languageRaw}". Allowed values: auto, fa, en, fa-en.`,
          requestId: reqId,
        }),
      };
    }
    const language = languageRaw as 'auto' | 'fa' | 'en' | 'fa-en';

    const domainProfileRaw = rawOpts.domain_profile === undefined ? 'technology' : String(rawOpts.domain_profile);
    if (!VALID_DOMAIN_PROFILES.has(domainProfileRaw)) {
      params.audioStream.resume();
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: `Unsupported domain_profile "${domainProfileRaw}".`,
          requestId: reqId,
        }),
      };
    }
    const domainProfile = domainProfileRaw as DomainProfileName;

    const executionModeRaw = rawOpts.execution_mode === undefined ? 'batch' : String(rawOpts.execution_mode);
    if (executionModeRaw !== 'batch' && executionModeRaw !== 'long_form_async') {
      params.audioStream.resume();
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: `Unsupported execution_mode "${executionModeRaw}". Allowed values: batch, long_form_async.`,
          requestId: reqId,
        }),
      };
    }

    // 3. Honest 501 for asynchronous long-form mode (no durable background queue worker in this container)
    if (executionModeRaw === 'long_form_async') {
      params.audioStream.resume();
      return {
        status: 501,
        body: buildPlatformErrorEnvelope({
          code: 'ASYNC_EXECUTION_UNAVAILABLE',
          message:
            'execution_mode="long_form_async" is not implemented in this single-node container because no durable background ASR worker queue is provisioned. Use execution_mode="batch".',
          requestId: reqId,
          retryable: false,
        }),
      };
    }

    const timestamps = Boolean(rawOpts.timestamps);
    const diarization = Boolean(rawOpts.diarization);
    const requestedRegionId = rawOpts.region_id === undefined ? undefined : String(rawOpts.region_id);

    const metadata: Record<string, string> = {};
    if (rawOpts.metadata !== undefined) {
      if (typeof rawOpts.metadata !== 'object' || rawOpts.metadata === null || Array.isArray(rawOpts.metadata)) {
        params.audioStream.resume();
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: 'metadata must be a string-to-string map.',
            requestId: reqId,
          }),
        };
      }
      const entries = Object.entries(rawOpts.metadata as Record<string, unknown>);
      if (entries.length > 16) {
        params.audioStream.resume();
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: 'metadata may contain at most 16 key/value pairs.',
            requestId: reqId,
          }),
        };
      }
      for (const [k, v] of entries) {
        if (typeof v !== 'string' || k.length > 64 || v.length > 256) {
          params.audioStream.resume();
          return {
            status: 400,
            body: buildPlatformErrorEnvelope({
              code: 'VALIDATION_ERROR',
              message: 'metadata keys (<=64 chars) and values (<=256 chars) must be strings.',
              requestId: reqId,
            }),
          };
        }
        metadata[k] = v;
      }
    }

    // 4. Model catalog & project authorization check
    const modelEntry = PHASE10_PUBLIC_MODEL_CATALOG.find(
      (m) => m.modelId === modelId && auth.project.allowedModels.includes(m.modelId)
    );
    if (!modelEntry) {
      params.audioStream.resume();
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'MODEL_UNAVAILABLE',
          message: `Model "${modelId}" is not available in this project.`,
          requestId: reqId,
        }),
      };
    }

    // 5. Hard Region Data Residency Validation
    const regionCheck = this.controlPlane.validateRegionPolicy({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      requestedRegionId,
    });
    if (!regionCheck.allowed) {
      params.audioStream.resume();
      return { status: 422, body: regionCheck.errorEnvelope };
    }

    // 6. Probe genuine inference readiness BEFORE reserving budget or billing
    const readiness = await this.inferenceExecutor.getModelReadiness(modelId);
    if (!readiness.ready) {
      params.audioStream.resume();
      return {
        status: 503,
        body: buildPlatformErrorEnvelope({
          code: 'PROVIDER_UNAVAILABLE',
          message: `Model "${modelId}" cannot execute transcription (${readiness.availability}): ${readiness.reason}`,
          requestId: reqId,
          retryable: false,
          details: {
            model: modelId,
            availability: readiness.availability,
          },
        }),
      };
    }

    // 7. Stream binary upload -> private temp file -> constrained FFmpeg decode -> canonical 16kHz PCM verification
    let artifact: PublicAudioArtifact | null = null;
    try {
      artifact = await ingestPublicAudioStream({
        audioStream: params.audioStream,
        contentType: params.contentType,
        contentLengthHeader: params.contentLengthHeader,
        maxUploadBytes: params.maxUploadBytes,
        maxDurationSeconds: modelEntry.maxAudioDurationSec,
        ffmpegBinaryPath: params.ffmpegBinaryPath,
        decodeTimeoutMs: params.decodeTimeoutMs,
        abortSignal: params.abortSignal,
      });

      // 8. Canonical 24-hour Idempotency check bound to audioSha256 + normalized options
      const idempKey = params.idempotencyKey?.trim();
      const canonicalDigest = this.hashCanonicalPayload({
        audioSha256: artifact.audioSha256,
        model: modelId,
        language,
        timestamps,
        diarization,
        domain_profile: domainProfile,
        execution_mode: 'batch',
        region_id: regionCheck.region.regionId,
        metadata,
      });

      if (idempKey) {
        const scopedKey = `${auth.organization.id}::POST:/v1/audio/transcriptions::${idempKey}`;
        const existing = this.idempotencyStore.get(scopedKey);
        if (existing && existing.expiresAtMs > Date.now()) {
          if (existing.payloadHash !== canonicalDigest) {
            return {
              status: 409,
              body: buildPlatformErrorEnvelope({
                code: 'IDEMPOTENCY_CONFLICT',
                message:
                  'Idempotency-Key was reused with a different audio payload or transcription option set.',
                requestId: reqId,
              }),
            };
          }
          return { status: existing.httpStatus, body: existing.responseBody };
        }
      }

      // 9. Atomic Budget & Quota Reservation using strictly server-verified decoded duration
      const verifiedAudioDurationMs = artifact.durationMs;
      const reservationRes = this.controlPlane.reserveUsageBudgetAtomically({
        organizationId: auth.organization.id,
        projectId: auth.project.id,
        requestId: reqId,
        estimatedDurationMs: verifiedAudioDurationMs,
        modelId,
      });
      if (!reservationRes.approved) {
        return { status: 402, body: reservationRes.errorEnvelope };
      }

      // 10. Genuine ASR Inference Execution with guaranteed reservation release on failure
      const transcriptionId = `tr_${crypto.randomUUID()}`;
      const startWall = performance.now();
      const stateHistory: Array<{ state: BatchJobLifecycleState; timestampIso: string }> = [
        { state: 'QUEUED', timestampIso: new Date().toISOString() },
        { state: 'VALIDATING', timestampIso: new Date().toISOString() },
        { state: 'PROCESSING', timestampIso: new Date().toISOString() },
      ];

      const releaseReservationOnFailure = (processingMs: number) => {
        this.controlPlane.commitAuthoritativeUsageAndLedger({
          reservationId: reservationRes.reservation.reservationId,
          usageEventId: `usg_${transcriptionId}`,
          idempotencyKey: `usage:${reqId}`,
          credentialId: auth.credential.id,
          transcriptionId,
          modelId: modelEntry.modelId,
          modelVersion: readiness.modelVersion,
          executionMode: 'batch',
          verifiedAudioDurationMs,
          billableDurationMs: 0,
          processingDurationMs: Math.max(1, processingMs),
          succeeded: false,
        });
      };

      let inferenceResult;
      try {
        inferenceResult = await this.inferenceExecutor.transcribe(artifact, {
          modelId,
          language,
          domainProfile,
          timestamps,
          diarization,
          abortSignal: params.abortSignal,
        });
      } catch (infErr) {
        const elapsedMs = Math.round(performance.now() - startWall);
        releaseReservationOnFailure(elapsedMs);
        if (infErr instanceof PublicInferenceExecutionError) {
          return {
            status: infErr.httpStatus,
            body: buildPlatformErrorEnvelope({
              code:
                infErr.code === 'AUDIO_DECODE_FAILED'
                  ? 'AUDIO_FORMAT_UNSUPPORTED'
                  : infErr.code === 'PROVIDER_UNAVAILABLE'
                    ? 'PROVIDER_UNAVAILABLE'
                    : 'INTERNAL_ERROR',
              message: infErr.message,
              requestId: reqId,
              retryable: infErr.retryable,
            }),
          };
        }
        return {
          status: 500,
          body: buildPlatformErrorEnvelope({
            code: 'INTERNAL_ERROR',
            message: 'ASR inference execution failed unexpectedly.',
            requestId: reqId,
            retryable: false,
          }),
        };
      }

      const processingMs = Math.max(1, Math.round(performance.now() - startWall));

      // 11. Strict post-inference validation (provenance, model identity, sample coverage, non-synthetic output)
      const validResult =
        inferenceResult.provenance === 'MODEL_INFERENCE' &&
        inferenceResult.modelId === modelId &&
        inferenceResult.processedSamples16k === artifact.totalSamples16k &&
        typeof inferenceResult.normalizedText === 'string' &&
        inferenceResult.normalizedText.trim().length > 0 &&
        !isSyntheticPlaceholderText(inferenceResult.normalizedText) &&
        !isSyntheticPlaceholderText(inferenceResult.rawText);

      if (!validResult) {
        releaseReservationOnFailure(processingMs);
        return {
          status: 502,
          body: buildPlatformErrorEnvelope({
            code: 'PROVIDER_UNAVAILABLE',
            message: 'ASR inference output failed provenance, sample-coverage, or non-synthetic validation.',
            requestId: reqId,
            retryable: false,
          }),
        };
      }

      stateHistory.push({ state: 'FINALIZING', timestampIso: new Date().toISOString() });
      stateHistory.push({ state: 'COMPLETED', timestampIso: new Date().toISOString() });

      // 12. Authoritative Usage Metering & Immutable Financial Commit (ONLY after valid inference)
      const usageEv = this.controlPlane.commitAuthoritativeUsageAndLedger({
        reservationId: reservationRes.reservation.reservationId,
        usageEventId: `usg_${transcriptionId}`,
        idempotencyKey: `usage:${reqId}`,
        credentialId: auth.credential.id,
        transcriptionId,
        modelId: inferenceResult.modelId,
        modelVersion: inferenceResult.modelVersion,
        executionMode: 'batch',
        verifiedAudioDurationMs,
        billableDurationMs: verifiedAudioDurationMs,
        processingDurationMs: processingMs,
        succeeded: true,
      });

      const job: PublicTranscriptionJobRecord = {
        id: transcriptionId,
        object: 'audio.transcription',
        organizationId: auth.organization.id,
        projectId: auth.project.id,
        credentialId: auth.credential.id,
        regionId: regionCheck.region.regionId,
        status: 'COMPLETED',
        stateHistory,
        model: inferenceResult.modelId,
        modelVersion: inferenceResult.modelVersion,
        language,
        executionMode: 'batch',
        text: inferenceResult.normalizedText,
        rawText: inferenceResult.rawText,
        segments: inferenceResult.segments,
        audioSha256: artifact.audioSha256,
        provenance: 'MODEL_INFERENCE',
        modelDigestSha256: inferenceResult.modelDigestSha256,
        processedSamples16k: inferenceResult.processedSamples16k,
        durationMs: verifiedAudioDurationMs,
        billableMs: usageEv.billableDurationMs,
        actualCostMinor: usageEv.actualCostMinor,
        currency: 'USD',
        timestampsAvailable: inferenceResult.timestampsAvailable,
        diarizationAvailable: inferenceResult.diarizationAvailable,
        metadata,
        createdAtIso: stateHistory[0].timestampIso,
        completedAtIso: stateHistory[stateHistory.length - 1].timestampIso,
      };

      this.jobs.set(job.id, job);

      // 13. Outbound Webhook Notification (ONLY after validated completion)
      this.controlPlane.dispatchWebhookEvent({
        organizationId: auth.organization.id,
        eventType: 'transcription.completed',
        data: {
          transcription_id: job.id,
          status: 'completed',
          model: job.model,
          audio_sha256: artifact.audioSha256,
          duration_ms: job.durationMs,
          result_url: `/v1/audio/transcriptions/${job.id}/result`,
        },
      });

      const publicResponse = {
        id: job.id,
        object: job.object,
        status: job.status.toLowerCase(),
        model: job.model,
        model_version: job.modelVersion,
        model_digest_sha256: inferenceResult.modelDigestSha256,
        provenance: 'MODEL_INFERENCE' as const,
        backend_engine: inferenceResult.backendEngine,
        region_id: job.regionId,
        language: job.language,
        text: job.text,
        raw_text: inferenceResult.rawText,
        ...(job.segments ? { segments: job.segments } : {}),
        audio_sha256: artifact.audioSha256,
        duration_ms: job.durationMs,
        processed_samples_16k: inferenceResult.processedSamples16k,
        usage: {
          audio_seconds: Number((job.durationMs / 1000).toFixed(3)),
          billable_seconds: Number((job.billableMs / 1000).toFixed(3)),
          actual_cost_minor_cents: job.actualCostMinor,
          currency: job.currency,
        },
        timestamps_available: job.timestampsAvailable,
        diarization_available: job.diarizationAvailable,
        created_at: job.createdAtIso,
      };

      if (idempKey) {
        const scopedKey = `${auth.organization.id}::POST:/v1/audio/transcriptions::${idempKey}`;
        this.idempotencyStore.set(scopedKey, {
          scopedKey,
          payloadHash: canonicalDigest,
          httpStatus: 200,
          responseBody: publicResponse,
          expiresAtMs: Date.now() + 86400_000,
        });
      }

      return { status: 200, body: publicResponse };
    } catch (err) {
      if (err instanceof PublicAudioIngestError) {
        const mappedCode =
          err.code === 'AUDIO_DURATION_EXCEEDED'
            ? 'AUDIO_DURATION_EXCEEDED'
            : err.code === 'PROVIDER_UNAVAILABLE'
              ? 'PROVIDER_UNAVAILABLE'
              : err.code === 'EMPTY_AUDIO_BODY' || err.code === 'PAYLOAD_TOO_LARGE'
                ? 'VALIDATION_ERROR'
                : 'AUDIO_FORMAT_UNSUPPORTED';
        return {
          status: err.httpStatus,
          body: buildPlatformErrorEnvelope({
            code: mappedCode,
            message: err.message,
            requestId: reqId,
            retryable: false,
            details: { ingest_error_code: err.code },
          }),
        };
      }
      return {
        status: 500,
        body: buildPlatformErrorEnvelope({
          code: 'INTERNAL_ERROR',
          message: 'Unexpected error during audio transcription pipeline.',
          requestId: reqId,
          retryable: false,
        }),
      };
    } finally {
      if (artifact) {
        await artifact.dispose();
      }
    }
  }

  public getTranscriptionJob(params: {
    bearerToken: string;
    transcriptionId: string;
  }): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'transcripts:read',
    });
    if (!auth.authenticated) {
      return { status: auth.httpStatus, body: auth.errorEnvelope };
    }

    const job = this.jobs.get(params.transcriptionId);
    if (!job) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Transcription "${params.transcriptionId}" not found.`,
        }),
      };
    }

    // Strict Multi-Tenant Ownership Enforcement
    if (job.organizationId !== auth.organization.id || job.projectId !== auth.project.id) {
      this.controlPlane.recordAuditLog({
        organizationId: auth.organization.id,
        actorType: 'API_KEY',
        actorId: auth.credential.id,
        action: 'CROSS_TENANT_TRANSCRIPTION_ACCESS',
        resourceType: 'transcription',
        resourceId: params.transcriptionId,
        outcome: 'DENIED',
        reason: 'Attempted access to transcription belonging to another tenant/project.',
      });
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Access denied: transcription does not belong to authenticated tenant/project.',
        }),
      };
    }

    return { status: 200, body: job };
  }

  public deleteTranscriptionJob(params: {
    bearerToken: string;
    transcriptionId: string;
  }): { status: number; body: unknown } {
    const lookup = this.getTranscriptionJob(params);
    if (lookup.status !== 200) return lookup;
    const job = lookup.body as PublicTranscriptionJobRecord;
    job.status = 'CANCELLED';
    job.text = null;
    this.jobs.delete(job.id);
    return { status: 200, body: { id: job.id, deleted: true } };
  }

  public createStreamingProductSession(params: {
    bearerToken: string;
    body: {
      model?: string;
      language?: 'auto' | 'fa' | 'en' | 'fa-en';
      mode?: 'native_streaming' | 'vad_segmented_streaming';
      sample_rate?: number;
      channels?: number;
      region_id?: string;
    };
  }): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'audio:stream',
    });
    if (!auth.authenticated) {
      return { status: auth.httpStatus, body: auth.errorEnvelope };
    }

    const regionCheck = this.controlPlane.validateRegionPolicy({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      requestedRegionId: params.body?.region_id,
    });
    if (!regionCheck.allowed) {
      return { status: 422, body: regionCheck.errorEnvelope };
    }

    const sr = params.body?.sample_rate ?? 16000;
    const ch = params.body?.channels ?? 1;
    if (sr !== 16000 || ch !== 1) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'AUDIO_FORMAT_UNSUPPORTED',
          message: 'Streaming API requires 16000 Hz mono PCM16 input.',
        }),
      };
    }

    const backend = PHASE5_STREAMING_BACKEND_REGISTRY.find(
      (b) => b.backendId === 'AVAPARDAZ_LOCAL_CTC_STREAMING'
    )!;
    const created = this.streamingGateway.createSession({
      backend_id: backend.backendId,
      language: params.body?.language === 'en' ? 'en' : params.body?.language === 'fa' ? 'fa' : 'auto',
      domain_profile: 'technology',
      user_id: auth.credential.id,
      tenant_id: auth.organization.id,
    });

    if (!created.accepted || !created.response) {
      return {
        status: 429,
        body: buildPlatformErrorEnvelope({
          code: 'QUOTA_EXCEEDED',
          message: created.errorEnvelope?.error?.message ?? 'Concurrent streaming session limit reached.',
          retryable: true,
        }),
      };
    }

    return {
      status: 201,
      body: {
        session_id: created.response.session_id,
        status: 'created',
        model: params.body?.model ?? 'asr-fa-en-v1',
        region_id: regionCheck.region.regionId,
        session_locality_pinned: true,
        protocol_version: 'asr-stream-v1',
        websocket_url: 'ws://localhost:3000/v1/audio/stream',
        session_token: created.response.single_use_session_token,
        expires_in_seconds: 30,
        billing_unit_policy: 'AudioDuration = UniqueAcceptedSamples / 16000 (duplicate frames never billed)',
      },
    };
  }

  // ── Phase 11 Public Speech Intelligence Product Gateway (`/v1/*`) ─────────

  public listCapabilities(bearerToken: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'models:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return {
      status: 200,
      body: { object: 'list', data: PHASE11_CAPABILITY_REGISTRY },
    };
  }

  public getCapability(bearerToken: string, capabilityId: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'models:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const found = PHASE11_CAPABILITY_REGISTRY.find((c) => c.capabilityId === capabilityId);
    if (!found) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Capability "${capabilityId}" does not exist.`,
        }),
      };
    }
    return { status: 200, body: found };
  }

  public createIntelligenceJob(params: {
    bearerToken: string;
    idempotencyKey?: string;
    body: {
      recording_id?: string;
      region_id?: string;
      language?: 'fa' | 'en' | 'fa-en';
      duration_sec?: number;
      segments?: TimedSegmentInput[];
      capabilities?: IntelligenceCapabilityRequestItem[];
      consent?: Partial<GranularProcessingConsent>;
    };
  }): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'audio:transcribe',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };

    const recId = params.body?.recording_id?.trim() || `rec_${crypto.randomUUID().slice(0, 8)}`;
    const caps = params.body?.capabilities ?? [{ id: 'speech.diarization' }, { id: 'speech.alignment' }];
    const segments: TimedSegmentInput[] =
      params.body?.segments && params.body.segments.length > 0
        ? params.body.segments
        : [
            {
              segmentId: 'seg_1',
              startSec: 0.4,
              endSec: 3.6,
              text: 'سلام، امروز وضعیت سرویس TypeScript و قرارداد PRJ-101 را بررسی می‌کنیم.',
              language: 'fa-en',
              speakerHint: 'speaker_1',
            },
            {
              segmentId: 'seg_2',
              startSec: 3.8,
              endSec: 7.1,
              text: 'بله، مبلغ 500 USD برای گزارش جلسه پنج‌شنبه تأیید شد؛ آیا نیاز به دیارایزیشن داریم؟',
              language: 'fa-en',
              speakerHint: 'speaker_2',
            },
          ];

    try {
      const job = this.intelligenceOrchestrator.submitIntelligenceJob({
        organizationId: auth.organization.id,
        projectId: auth.project.id,
        credentialId: auth.credential.id,
        recordingId: recId,
        regionId: params.body?.region_id,
        language: params.body?.language ?? 'fa-en',
        durationSec: Number(params.body?.duration_sec ?? 8.0),
        sourceTranscriptSegments: segments,
        consent: params.body?.consent
          ? { ...DEFAULT_FULL_SANDBOX_CONSENT, ...params.body.consent }
          : DEFAULT_FULL_SANDBOX_CONSENT,
        capabilities: caps,
        idempotencyKey: params.idempotencyKey,
      });
      return { status: 201, body: job };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRegion = msg.includes('REGION_UNAVAILABLE');
      return {
        status: isRegion ? 422 : 400,
        body: buildPlatformErrorEnvelope({
          code: isRegion ? 'REGION_UNAVAILABLE' : 'QUOTA_EXCEEDED',
          message: msg,
        }),
      };
    }
  }

  public getIntelligenceJob(bearerToken: string, jobId: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'transcripts:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const found = this.intelligenceOrchestrator.getJob({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      jobId,
    });
    if (!found.found) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Intelligence job "${jobId}" not found.`,
        }),
      };
    }
    if (found.forbidden) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Access denied to intelligence job outside active tenant/project scope.',
        }),
      };
    }
    return { status: 200, body: found.job };
  }

  public cancelIntelligenceJob(bearerToken: string, jobId: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'audio:transcribe',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const job = this.intelligenceOrchestrator.cancelJob({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      jobId,
    });
    if (!job) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Intelligence job "${jobId}" not found or unauthorized.`,
        }),
      };
    }
    return { status: 200, body: job };
  }

  public getIntelligenceJobArtifacts(bearerToken: string, jobId: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'transcripts:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const found = this.intelligenceOrchestrator.getJob({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      jobId,
    });
    if (!found.found) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Intelligence job "${jobId}" not found.`,
        }),
      };
    }
    if (found.forbidden) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Access denied to job artifacts outside active project.',
        }),
      };
    }
    return {
      status: 200,
      body: {
        object: 'list',
        data: this.intelligenceOrchestrator.getJobArtifacts({
          organizationId: auth.organization.id,
          projectId: auth.project.id,
          jobId,
        }),
      },
    };
  }

  public getRecordingArtifactBySlug(
    bearerToken: string,
    recordingId: string,
    slug: string
  ): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'transcripts:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };

    const slugMap: Record<string, SpeechArtifactType> = {
      diarization: 'DIARIZATION',
      alignment: 'ALIGNMENT',
      translations: 'TRANSLATION',
      subtitles: 'SUBTITLES',
      'meeting-intelligence': 'MEETING_INTELLIGENCE',
      analytics: 'CONVERSATION_ANALYTICS',
      'search-index': 'SEMANTIC_INDEX',
      'structured-extraction': 'STRUCTURED_EXTRACTION',
    };
    const artifactType = slugMap[slug];
    if (!artifactType) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: `Unknown artifact type "${slug}".`,
        }),
      };
    }
    const items = this.intelligenceOrchestrator.getArtifactsForRecording({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      recordingId,
      artifactType,
    });
    return {
      status: 200,
      body: {
        recording_id: recordingId,
        artifact_type: artifactType,
        versions_count: items.length,
        latest: items.slice(-1)[0] ?? null,
        history: items,
      },
    };
  }

  public searchRecordingSemantic(params: {
    bearerToken: string;
    recordingId?: string;
    query: string;
    speakerId?: string;
    language?: 'fa' | 'en' | 'fa-en';
  }): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'transcripts:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };

    const results = this.intelligenceOrchestrator.getSemanticIndex().searchAuthorized({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      recordingId: params.recordingId,
      query: params.query,
      speakerId: params.speakerId,
      language: params.language,
    });
    return { status: 200, body: { object: 'list', data: results } };
  }

  public deleteRecordingAndDerived(bearerToken: string, recordingId: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'audio:transcribe',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const deleted = this.intelligenceOrchestrator.deleteRecordingAndPropagate({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      recordingId,
    });
    return { status: 200, body: { recording_id: recordingId, ...deleted } };
  }

  public listIntegrations(bearerToken: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'projects:read',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    return {
      status: 200,
      body: {
        object: 'list',
        data: this.intelligenceOrchestrator.listConnectors(auth.organization.id, auth.project.id),
      },
    };
  }

  public createIntegration(params: {
    bearerToken: string;
    body: {
      kind?: EnterpriseConnectorKind;
      name?: string;
      config_summary?: Record<string, string | boolean>;
      is_local_test_adapter?: boolean;
    };
  }): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken: params.bearerToken,
      requiredScope: 'webhooks:manage',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const created = this.intelligenceOrchestrator.registerConnector({
      organizationId: auth.organization.id,
      projectId: auth.project.id,
      kind: params.body?.kind ?? 'OBJECT_STORAGE_S3',
      name: params.body?.name ?? 'Custom Storage Connector',
      configSummary: params.body?.config_summary ?? { configured: false },
      isLocalTestAdapter: Boolean(params.body?.is_local_test_adapter),
    });
    return { status: 201, body: created };
  }

  public deleteIntegration(bearerToken: string, integrationId: string): { status: number; body: unknown } {
    const auth = this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'webhooks:manage',
    });
    if (!auth.authenticated) return { status: auth.httpStatus, body: auth.errorEnvelope };
    const ok = this.intelligenceOrchestrator.deleteConnector(auth.organization.id, integrationId);
    return ok
      ? { status: 200, body: { id: integrationId, deleted: true } }
      : {
          status: 404,
          body: buildPlatformErrorEnvelope({
            code: 'RESOURCE_NOT_FOUND',
            message: `Integration "${integrationId}" not found.`,
          }),
        };
  }
}
