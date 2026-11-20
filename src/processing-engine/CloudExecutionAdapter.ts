import { buildAllNormalizationProfiles, detectTextLanguageTag } from '../asr-core/CoreNormalizationAndLanguage';
import {
  CapabilityAvailabilityState,
  ProviderCapabilityDescriptor,
  UNIFIED_PROCESSING_CONFIG_VERSION,
  UNIFIED_PROCESSING_CONTRACT_VERSION,
  UnifiedExecutionAdapter,
  UnifiedProcessingError,
  UnifiedProcessingErrorCode,
  UnifiedProcessingRequest,
  UnifiedProcessingResultEnvelope,
  validateUnifiedProcessingResultEnvelope,
} from './UnifiedProcessingContract';
import { sanitizeSecurityTelemetry } from '../security/PrivacyRetentionAndIsolationEngine';

export interface CloudProviderConfig {
  readonly providerId: string;
  readonly displayName: string;
  readonly endpointUrl: string | null;
  readonly configured: boolean;
  readonly defaultTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly modelId?: string | null;
  readonly modelVersion?: string | null;
}

export interface CloudTransportRequest {
  readonly endpointUrl: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly payload: UnifiedProcessingRequest;
}

export interface CloudTransportResponse {
  readonly httpStatus: number;
  readonly body: unknown;
}

export interface CloudProviderTransport {
  readonly transportId: string;
  send(req: CloudTransportRequest, signal?: AbortSignal): Promise<CloudTransportResponse>;
  probeReachability?(endpointUrl: string): Promise<boolean>;
}

export interface CloudExecutionAdapterOptions {
  readonly config: CloudProviderConfig;
  readonly transport?: CloudProviderTransport | null;
  readonly backoffBaseMs?: number;
}

/**
 * Provider-neutral Cloud Execution Adapter.
 *
 * - Strictly validates outgoing requests and incoming remote envelopes.
 * - Supports explicit timeout, AbortSignal cancellation, idempotencyKey, and bounded
 *   retries ONLY for safe retryable failure codes (TIMEOUT, RATE_LIMITED, transient 503).
 * - NEVER silently falls back to LOCAL execution.
 * - NEVER embeds credentials in frontend code or logs audio/transcript/secret payloads.
 */
export class CloudExecutionAdapter implements UnifiedExecutionAdapter {
  public readonly adapterId = 'avapardaz-cloud-adapter-v1';
  public readonly executionMode = 'CLOUD' as const;

  private readonly config: CloudProviderConfig;
  private readonly transport: CloudProviderTransport | null;
  private readonly backoffBaseMs: number;

  constructor(options: CloudExecutionAdapterOptions) {
    this.config = Object.freeze({ ...options.config });
    this.transport = options.transport ?? null;
    this.backoffBaseMs =
      typeof options.backoffBaseMs === 'number' &&
      Number.isFinite(options.backoffBaseMs) &&
      options.backoffBaseMs >= 0
        ? options.backoffBaseMs
        : 5;
  }

  public async discoverCapabilities(): Promise<readonly ProviderCapabilityDescriptor[]> {
    const nowIso = new Date().toISOString();
    let availability: CapabilityAvailabilityState;
    let reason: string;

    if (!this.config.configured || !this.config.endpointUrl) {
      availability = 'INSTALLED_NOT_CONFIGURED';
      reason =
        'Cloud adapter is installed, but no remote Cloud provider endpoint/credentials are configured.';
    } else if (!this.transport) {
      availability = 'BLOCKED_BY_EXTERNAL_INFRASTRUCTURE';
      reason = 'Cloud endpoint configured, but no remote transport is attached in this runtime.';
    } else if (this.transport.probeReachability) {
      const reachable = await this.transport
        .probeReachability(this.config.endpointUrl)
        .catch(() => false);
      availability = reachable ? 'AVAILABLE_NOW' : 'CONFIGURED_UNREACHABLE';
      reason = reachable
        ? `Cloud provider "${this.config.providerId}" reachable (${this.transport.transportId}).`
        : `Cloud provider "${this.config.providerId}" is configured but currently unreachable.`;
    } else {
      availability = 'UNKNOWN_NOT_YET_VERIFIED';
      reason =
        'Cloud provider is configured, but live reachability has not yet been verified.';
    }

    return Object.freeze([
      Object.freeze({
        executionMode: 'CLOUD' as const,
        providerId: this.config.providerId,
        displayName: this.config.displayName,
        availability,
        reason,
        modelId: this.config.modelId ?? null,
        modelVersion: this.config.modelVersion ?? null,
        isGenuineNeuralModel: false,
        supportedProcessingModes: ['batch', 'long_form', 'streaming'] as const,
        supportedCapabilities: [
          'RAW_TRANSCRIPT',
          'NORMALIZED_VARIANTS',
          'SEGMENT_TIMESTAMPS',
          'WORD_TIMESTAMPS',
        ] as const,
        requiresNetwork: true,
        verifiedAtIso: nowIso,
      }),
    ]);
  }

  private mapHttpFailure(status: number, body: unknown): UnifiedProcessingError {
    const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    const detail =
      typeof bodyObj?.message === 'string'
        ? sanitizeSecurityTelemetry(bodyObj.message)
        : `Remote provider returned HTTP ${status}.`;

    let code: UnifiedProcessingErrorCode;
    if (status === 401 || status === 403) {
      code = 'PROVIDER_AUTHENTICATION_FAILED';
    } else if (status === 408 || status === 504) {
      code = 'PROVIDER_TIMEOUT';
    } else if (status === 429) {
      code = 'PROVIDER_RATE_LIMITED';
    } else if (status === 413) {
      code = 'PROCESSING_RESOURCE_LIMIT_EXCEEDED';
    } else if (status === 415) {
      code = 'UNSUPPORTED_AUDIO_FORMAT';
    } else if (status === 502 || status === 503) {
      code = 'CLOUD_PROVIDER_UNAVAILABLE';
    } else if (status >= 400 && status < 500) {
      code = 'INVALID_PROCESSING_REQUEST';
    } else {
      code = 'PROCESSING_FAILED';
    }

    return new UnifiedProcessingError({
      code,
      executionMode: 'CLOUD',
      providerId: this.config.providerId,
      detailEn: detail,
    });
  }

  public async execute(
    request: UnifiedProcessingRequest,
    signal?: AbortSignal,
  ): Promise<UnifiedProcessingResultEnvelope> {
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();

    if (signal?.aborted) {
      throw new UnifiedProcessingError({
        code: 'PROCESSING_CANCELLED',
        executionMode: 'CLOUD',
        providerId: this.config.providerId,
      });
    }

    if (!this.config.configured || !this.config.endpointUrl || !this.transport) {
      throw new UnifiedProcessingError({
        code: 'CLOUD_PROVIDER_UNAVAILABLE',
        executionMode: 'CLOUD',
        providerId: this.config.providerId,
        detailEn:
          'Cloud execution was explicitly requested, but no Cloud provider is configured or connected. No silent fallback to Local will occur.',
        detailFa:
          'اجرای ابری انتخاب شده است اما هیچ سرویس‌دهنده ابری پیکربندی یا متصل نیست. بازگشت خودکار پنهان به حالت محلی انجام نمی‌شود.',
        retryable: false,
      });
    }

    const rawTimeoutMs = request.constraints?.timeoutMs ?? this.config.defaultTimeoutMs;
    const timeoutMs =
      typeof rawTimeoutMs === 'number' && Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
        ? Math.floor(rawTimeoutMs)
        : 30_000;
    const rawMaxRetries = request.constraints?.maxRetries ?? this.config.maxRetries;
    const maxRetries =
      typeof rawMaxRetries === 'number' && Number.isFinite(rawMaxRetries)
        ? Math.max(0, Math.min(3, Math.floor(rawMaxRetries)))
        : 1;
    const idempotencyKey = request.constraints?.idempotencyKey ?? request.jobId;
    const capabilities = await this.discoverCapabilities();

    let attempt = 0;
    let lastError: UnifiedProcessingError | null = null;

    while (attempt <= maxRetries) {
      if (signal?.aborted) {
        throw new UnifiedProcessingError({
          code: 'PROCESSING_CANCELLED',
          executionMode: 'CLOUD',
          providerId: this.config.providerId,
        });
      }

      const attemptController = new AbortController();
      const onOuterAbort = () => attemptController.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, timeoutMs);

      try {
        const response = await this.transport.send(
          {
            endpointUrl: this.config.endpointUrl,
            idempotencyKey,
            timeoutMs,
            payload: { ...request, executionMode: 'CLOUD' },
          },
          attemptController.signal,
        );

        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);

        if (response.httpStatus < 200 || response.httpStatus >= 300) {
          throw this.mapHttpFailure(response.httpStatus, response.body);
        }

        if (!validateUnifiedProcessingResultEnvelope(response.body, request.jobId, 'CLOUD')) {
          throw new UnifiedProcessingError({
            code: 'PROVIDER_INVALID_RESPONSE',
            executionMode: 'CLOUD',
            providerId: this.config.providerId,
            detailEn:
              'Remote Cloud provider response failed UnifiedProcessingResultEnvelope schema/provenance validation.',
          });
        }

        const completedAtMs = Date.now();
        const env = response.body;
        return Object.freeze({
          ...env,
          capabilitySnapshot: capabilities,
          provenance: Object.freeze({
            ...env.provenance,
            selectedExecutionMode: 'CLOUD',
            actualAdapterId: this.adapterId,
            providerId: this.config.providerId,
            contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
            configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
            startedAtIso,
            completedAtIso: new Date(completedAtMs).toISOString(),
            actualDurationMs: Math.max(0, completedAtMs - startedAtMs),
            retryCount: attempt,
            fallbackUsed: false,
            fallbackAuthorizedReason: null,
          }),
        });
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);

        if (signal?.aborted) {
          throw new UnifiedProcessingError({
            code: 'PROCESSING_CANCELLED',
            executionMode: 'CLOUD',
            providerId: this.config.providerId,
          });
        }

        const mapped =
          err instanceof UnifiedProcessingError
            ? err
            : timedOut
              ? new UnifiedProcessingError({
                  code: 'PROVIDER_TIMEOUT',
                  executionMode: 'CLOUD',
                  providerId: this.config.providerId,
                  detailEn: `Cloud provider timed out after ${timeoutMs}ms.`,
                })
              : new UnifiedProcessingError({
                  code: 'CLOUD_PROVIDER_UNAVAILABLE',
                  executionMode: 'CLOUD',
                  providerId: this.config.providerId,
                  detailEn: sanitizeSecurityTelemetry(err instanceof Error ? err.message : String(err)),
                });

        lastError = mapped;

        const isSafeRetryable =
          mapped.retryable &&
          (mapped.code === 'PROVIDER_TIMEOUT' ||
            mapped.code === 'PROVIDER_RATE_LIMITED' ||
            mapped.code === 'CLOUD_PROVIDER_UNAVAILABLE');

        if (!isSafeRetryable || attempt >= maxRetries) {
          throw mapped;
        }

        attempt++;
        const backoffMs = this.backoffBaseMs * attempt;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(
              new UnifiedProcessingError({
                code: 'PROCESSING_CANCELLED',
                executionMode: 'CLOUD',
                providerId: this.config.providerId,
              }),
            );
            return;
          }
          const onBackoffAbort = () => {
            clearTimeout(backoffTimer);
            reject(
              new UnifiedProcessingError({
                code: 'PROCESSING_CANCELLED',
                executionMode: 'CLOUD',
                providerId: this.config.providerId,
              }),
            );
          };
          const backoffTimer = setTimeout(() => {
            signal?.removeEventListener('abort', onBackoffAbort);
            resolve();
          }, backoffMs);
          signal?.addEventListener('abort', onBackoffAbort, { once: true });
        });
      }
    }

    throw (
      lastError ??
      new UnifiedProcessingError({
        code: 'PROCESSING_FAILED',
        executionMode: 'CLOUD',
        providerId: this.config.providerId,
      })
    );
  }
}

export type DeterministicMockCloudBehavior =
  | { readonly kind: 'SUCCESS'; readonly rawText: string; readonly delayMs?: number }
  | { readonly kind: 'HTTP_ERROR'; readonly status: number; readonly message?: string }
  | { readonly kind: 'MALFORMED_RESPONSE'; readonly body: unknown }
  | { readonly kind: 'TIMEOUT'; readonly delayMs: number }
  | { readonly kind: 'TRANSIENT_THEN_SUCCESS'; readonly failCount: number; readonly failStatus: number; readonly rawText: string };

/**
 * Deterministic test-only Cloud transport for verifying the Cloud protocol without
 * claiming a live commercial Cloud provider is connected.
 */
export class DeterministicMockCloudTransport implements CloudProviderTransport {
  public readonly transportId = 'deterministic-mock-cloud-transport';
  public receivedRequests: CloudTransportRequest[] = [];
  private attemptsByJob = new Map<string, number>();

  constructor(
    private readonly behavior: DeterministicMockCloudBehavior,
    private readonly reachable = true,
  ) {}

  public async probeReachability(): Promise<boolean> {
    return this.reachable;
  }

  public async send(
    req: CloudTransportRequest,
    signal?: AbortSignal,
  ): Promise<CloudTransportResponse> {
    this.receivedRequests.push(req);
    const prevAttempts = this.attemptsByJob.get(req.payload.jobId) ?? 0;
    this.attemptsByJob.set(req.payload.jobId, prevAttempts + 1);

    const waitWithAbort = async (ms: number) => {
      if (ms <= 0) return;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('ABORTED'));
          },
          { once: true },
        );
      });
    };

    if (this.behavior.kind === 'TIMEOUT') {
      await waitWithAbort(this.behavior.delayMs);
      return { httpStatus: 504, body: { message: 'Mock timeout' } };
    }

    if (this.behavior.kind === 'HTTP_ERROR') {
      return {
        httpStatus: this.behavior.status,
        body: { message: this.behavior.message ?? `Simulated HTTP ${this.behavior.status}` },
      };
    }

    if (this.behavior.kind === 'MALFORMED_RESPONSE') {
      return { httpStatus: 200, body: this.behavior.body };
    }

    if (this.behavior.kind === 'TRANSIENT_THEN_SUCCESS') {
      if (prevAttempts < this.behavior.failCount) {
        return {
          httpStatus: this.behavior.failStatus,
          body: { message: `Transient simulated HTTP ${this.behavior.failStatus}` },
        };
      }
      return this.buildCanonicalSuccessResponse(req, this.behavior.rawText);
    }

    if (this.behavior.delayMs) {
      await waitWithAbort(this.behavior.delayMs);
    }

    return this.buildCanonicalSuccessResponse(req, this.behavior.rawText);
  }

  private buildCanonicalSuccessResponse(
    req: CloudTransportRequest,
    rawText: string,
  ): CloudTransportResponse {
    const langInfo = detectTextLanguageTag(rawText);
    const normalizedByProfile = buildAllNormalizationProfiles(rawText);
    const rawDur = req.payload.audio.metadata.durationSecEstimate;
    const dur = typeof rawDur === 'number' && Number.isFinite(rawDur) && rawDur >= 0 ? rawDur : 1.0;
    const nowIso = new Date().toISOString();

    const envelope: UnifiedProcessingResultEnvelope = {
      contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
      jobId: req.payload.jobId,
      recordingId: req.payload.recordingId,
      status: 'COMPLETED',
      executionMode: 'CLOUD',
      processingMode: req.payload.processingMode,
      durationSec: dur,
      dominantLanguage: langInfo.language,
      rawModelOutput: rawText,
      normalizedByProfile,
      confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
      calibratedConfidence: null,
      timestampGranularity: 'SEGMENT',
      segments: [
        {
          segmentId: 'seg_0',
          segmentIndex: 0,
          startSec: 0,
          endSec: dur,
          startSample: 0,
          endSample: Math.round(dur * 16_000),
          language: langInfo.language,
          languageConfidence: null,
          rawModelOutput: rawText,
          normalizedByProfile,
          words: [],
          timestampGranularity: 'SEGMENT',
          confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
          calibratedConfidence: null,
          retryCount: 0,
          status: 'OK',
          failureReason: null,
        },
      ],
      failedSegmentRanges: [],
      warnings: [
        'Deterministic mock cloud transport used for protocol verification — no live commercial Cloud provider connected.',
      ],
      audioSha256Hex: req.payload.audio.metadata.sha256Hex,
      capabilitySnapshot: [],
      resourceUsage: {
        measurementKind: 'UNAVAILABLE',
        processingTimeMs: null,
        realTimeFactor: null,
        peakMemoryBytes: null,
      },
      provenance: {
        jobId: req.payload.jobId,
        recordingId: req.payload.recordingId,
        selectedExecutionMode: 'CLOUD',
        actualAdapterId: 'avapardaz-cloud-adapter-v1',
        providerId: 'mock-cloud-provider',
        modelId: 'deterministic-mock-cloud-v1',
        modelVersion: '1.0.0-test',
        isGenuineNeuralModel: false,
        contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
        configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
        startedAtIso: nowIso,
        completedAtIso: nowIso,
        actualDurationMs: 1,
        retryCount: 0,
        fallbackUsed: false,
        fallbackAuthorizedReason: null,
        failureCode: null,
        failureReason: null,
      },
      error: null,
    };

    return { httpStatus: 200, body: envelope };
  }
}
