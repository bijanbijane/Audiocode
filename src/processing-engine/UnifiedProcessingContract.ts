/**
 * AVAPARDAZ — UNIFIED PROCESSING CONTRACT (v1.0.0)
 *
 * Single versioned, transport-safe contract shared identically by LOCAL and CLOUD
 * execution paths. No Node.js Buffer, filesystem handles, native handles, or
 * browser-only objects are permitted in public wire payloads.
 */

import type {
  ConfidenceStatus,
  DetectedLanguageTag,
  NormalizationProfileId,
  TimestampGranularity,
} from '../asr-core/CoreAsrContracts';

export const UNIFIED_PROCESSING_CONTRACT_VERSION = '1.0.0' as const;
export const UNIFIED_PROCESSING_CONFIG_VERSION = '1.0.0' as const;

export type ExecutionMode = 'LOCAL' | 'CLOUD';

export type ProcessingMode = 'batch' | 'long_form' | 'streaming';

export type UnifiedProcessingErrorCode =
  | 'INVALID_PROCESSING_REQUEST'
  | 'UNSUPPORTED_AUDIO_FORMAT'
  | 'LOCAL_RUNTIME_UNAVAILABLE'
  | 'CLOUD_PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTHENTICATION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROCESSING_CANCELLED'
  | 'PROCESSING_RESOURCE_LIMIT_EXCEEDED'
  | 'PROCESSING_FAILED';

export type CapabilityAvailabilityState =
  | 'AVAILABLE_NOW'
  | 'INSTALLED_NOT_CONFIGURED'
  | 'CONFIGURED_UNREACHABLE'
  | 'MISSING_REQUIRED_RUNTIME'
  | 'MISSING_MODEL_WEIGHTS'
  | 'BLOCKED_BY_EXTERNAL_INFRASTRUCTURE'
  | 'UNKNOWN_NOT_YET_VERIFIED';

export type UnifiedJobStatus =
  | 'COMPLETED'
  | 'PARTIAL_WITH_FAILURES'
  | 'FAILED'
  | 'CANCELLED';

export type ProcessingOutputCapability =
  | 'RAW_TRANSCRIPT'
  | 'NORMALIZED_VARIANTS'
  | 'SEGMENT_TIMESTAMPS'
  | 'WORD_TIMESTAMPS'
  | 'CALIBRATED_CONFIDENCE';

export interface CanonicalAudioMetadata {
  readonly filename: string;
  readonly mimeType: string;
  readonly containerFormat: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm' | 'pcm16' | 'unknown';
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly byteLength: number;
  readonly durationSecEstimate: number | null;
  readonly sha256Hex: string | null;
}

/**
 * Serializable, transport-safe audio reference for wire/IPC boundaries.
 * Never exposes Buffer, File, AudioBuffer, or filesystem paths.
 */
export interface TransportSafeAudioInput {
  readonly encoding: 'BASE64_CONTAINER' | 'BASE64_PCM16_16K_MONO' | 'OPAQUE_ASSET_REF';
  readonly payloadBase64?: string;
  readonly opaqueAssetRef?: string;
  readonly metadata: CanonicalAudioMetadata;
}

export interface UnifiedProcessingConfig {
  readonly configVersion: typeof UNIFIED_PROCESSING_CONFIG_VERSION;
  readonly normalizationProfile: NormalizationProfileId;
  readonly maxSegmentDurationSec?: number;
  readonly contextOverlapSec?: number;
  readonly maxRetriesPerSegment?: number;
  readonly requireNeuralWeights?: boolean;
  readonly simulateFailureOnSegmentIndex?: number;
}

export interface ExecutionConstraints {
  readonly timeoutMs?: number;
  readonly maxMemoryBytes?: number;
  readonly maxRetries?: number;
  readonly idempotencyKey?: string;
}

export interface UnifiedProcessingRequest {
  readonly contractVersion: typeof UNIFIED_PROCESSING_CONTRACT_VERSION;
  readonly jobId: string;
  readonly recordingId: string;
  readonly executionMode?: ExecutionMode;
  readonly processingMode: ProcessingMode;
  readonly audio: TransportSafeAudioInput;
  readonly languageHint: DetectedLanguageTag | 'auto';
  readonly config: UnifiedProcessingConfig;
  readonly requestedCapabilities: readonly ProcessingOutputCapability[];
  readonly cancellationId: string;
  readonly constraints?: ExecutionConstraints;
  readonly preferredProviderId?: string;
}

export interface ProviderCapabilityDescriptor {
  readonly executionMode: ExecutionMode;
  readonly providerId: string;
  readonly displayName: string;
  readonly availability: CapabilityAvailabilityState;
  readonly reason: string;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly isGenuineNeuralModel: boolean;
  readonly supportedProcessingModes: readonly ProcessingMode[];
  readonly supportedCapabilities: readonly ProcessingOutputCapability[];
  readonly requiresNetwork: boolean;
  readonly verifiedAtIso: string | null;
}

export interface UnifiedWordTiming {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly language: DetectedLanguageTag;
}

export interface UnifiedTranscriptSegment {
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly language: DetectedLanguageTag;
  readonly languageConfidence: number | null;
  readonly rawModelOutput: string;
  readonly normalizedByProfile: Readonly<Record<NormalizationProfileId, string>>;
  readonly words: readonly UnifiedWordTiming[];
  readonly timestampGranularity: TimestampGranularity;
  readonly confidenceStatus: ConfidenceStatus;
  readonly calibratedConfidence: number | null;
  readonly retryCount: number;
  readonly status: 'OK' | 'FAILED';
  readonly failureReason: string | null;
}

export interface MeasuredResourceUsage {
  readonly measurementKind: 'MEASURED' | 'UNAVAILABLE';
  readonly processingTimeMs: number | null;
  readonly realTimeFactor: number | null;
  readonly peakMemoryBytes: number | null;
}

export interface ExecutionProvenance {
  readonly jobId: string;
  readonly recordingId: string;
  readonly selectedExecutionMode: ExecutionMode;
  readonly actualAdapterId: string;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly isGenuineNeuralModel: boolean;
  readonly contractVersion: typeof UNIFIED_PROCESSING_CONTRACT_VERSION;
  readonly configVersion: typeof UNIFIED_PROCESSING_CONFIG_VERSION;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly actualDurationMs: number;
  readonly retryCount: number;
  readonly fallbackUsed: boolean;
  readonly fallbackAuthorizedReason: string | null;
  readonly failureCode: UnifiedProcessingErrorCode | null;
  readonly failureReason: string | null;
}

export interface UnifiedProcessingErrorPayload {
  readonly code: UnifiedProcessingErrorCode;
  readonly messageEn: string;
  readonly messageFa: string;
  readonly retryable: boolean;
  readonly executionMode: ExecutionMode;
  readonly providerId: string | null;
}

export interface UnifiedProcessingResultEnvelope {
  readonly contractVersion: typeof UNIFIED_PROCESSING_CONTRACT_VERSION;
  readonly jobId: string;
  readonly recordingId: string;
  readonly status: UnifiedJobStatus;
  readonly executionMode: ExecutionMode;
  readonly processingMode: ProcessingMode;
  readonly durationSec: number | null;
  readonly dominantLanguage: DetectedLanguageTag;
  readonly rawModelOutput: string;
  readonly normalizedByProfile: Readonly<Record<NormalizationProfileId, string>>;
  readonly confidenceStatus: ConfidenceStatus;
  readonly calibratedConfidence: number | null;
  readonly timestampGranularity: TimestampGranularity;
  readonly segments: readonly UnifiedTranscriptSegment[];
  readonly failedSegmentRanges: readonly {
    readonly segmentIndex: number;
    readonly startSec: number;
    readonly endSec: number;
    readonly reason: string;
  }[];
  readonly warnings: readonly string[];
  readonly audioSha256Hex: string | null;
  readonly capabilitySnapshot: readonly ProviderCapabilityDescriptor[];
  readonly resourceUsage: MeasuredResourceUsage;
  readonly provenance: ExecutionProvenance;
  readonly error: UnifiedProcessingErrorPayload | null;
}

export interface ExecutionTraceEntry {
  readonly traceId: string;
  readonly jobId: string;
  readonly recordingId: string;
  readonly selectedExecutionMode: ExecutionMode;
  readonly actualAdapterId: string;
  readonly providerId: string;
  readonly processingMode: ProcessingMode;
  readonly status: UnifiedJobStatus;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly actualDurationMs: number;
  readonly retryCount: number;
  readonly fallbackUsed: boolean;
  readonly failureCode: UnifiedProcessingErrorCode | null;
}

const DEFAULT_ERROR_MESSAGES: Record<
  UnifiedProcessingErrorCode,
  { readonly en: string; readonly fa: string; readonly retryable: boolean }
> = {
  INVALID_PROCESSING_REQUEST: {
    en: 'The processing request is invalid or incompatible with contract v1.0.0.',
    fa: 'درخواست پردازش نامعتبر یا با نسخه قرارداد ناسازگار است.',
    retryable: false,
  },
  UNSUPPORTED_AUDIO_FORMAT: {
    en: 'The supplied audio format is unsupported or corrupted.',
    fa: 'قالب فایل صوتی پشتیبانی نمی‌شود یا خراب است.',
    retryable: false,
  },
  LOCAL_RUNTIME_UNAVAILABLE: {
    en: 'The required local ASR runtime or verified neural weights are unavailable on this device.',
    fa: 'موتور پردازش محلی یا وزن‌های عصبی تأییدشده روی این دستگاه در دسترس نیست.',
    retryable: false,
  },
  CLOUD_PROVIDER_UNAVAILABLE: {
    en: 'The explicitly selected Cloud provider is not configured or is currently unreachable.',
    fa: 'سرویس‌دهنده ابری انتخاب‌شده پیکربندی نشده یا در دسترس نیست.',
    retryable: true,
  },
  PROVIDER_AUTHENTICATION_FAILED: {
    en: 'Cloud provider authentication failed. Verify server-side credentials.',
    fa: 'احراز هویت سرویس‌دهنده ابری ناموفق بود. تنظیمات سرور را بررسی کنید.',
    retryable: false,
  },
  PROVIDER_TIMEOUT: {
    en: 'The processing provider timed out before completing the job.',
    fa: 'زمان پاسخ‌گویی پردازشگر به پایان رسید.',
    retryable: true,
  },
  PROVIDER_RATE_LIMITED: {
    en: 'The Cloud provider rejected the request due to rate limits.',
    fa: 'درخواست به دلیل محدودیت نرخ سرویس‌دهنده ابری رد شد.',
    retryable: true,
  },
  PROVIDER_INVALID_RESPONSE: {
    en: 'The remote provider returned a malformed or schema-invalid response.',
    fa: 'پاسخ دریافت‌شده از پردازشگر خارجی نامعتبر است و رد شد.',
    retryable: false,
  },
  PROCESSING_CANCELLED: {
    en: 'Processing was cancelled by the caller.',
    fa: 'فرایند پردازش توسط کاربر لغو شد.',
    retryable: false,
  },
  PROCESSING_RESOURCE_LIMIT_EXCEEDED: {
    en: 'Processing exceeded the local memory or resource safety policy.',
    fa: 'پردازش از سقف مجاز حافظه یا منابع سیستم فراتر رفت و ایمن متوقف شد.',
    retryable: false,
  },
  PROCESSING_FAILED: {
    en: 'Audio processing failed unexpectedly.',
    fa: 'پردازش صوتی با خطا مواجه شد.',
    retryable: false,
  },
};

export class UnifiedProcessingError extends Error {
  public readonly code: UnifiedProcessingErrorCode;
  public readonly messageFa: string;
  public readonly retryable: boolean;
  public readonly executionMode: ExecutionMode;
  public readonly providerId: string | null;

  constructor(params: {
    readonly code: UnifiedProcessingErrorCode;
    readonly executionMode: ExecutionMode;
    readonly providerId?: string | null;
    readonly detailEn?: string;
    readonly detailFa?: string;
    readonly retryable?: boolean;
  }) {
    const def = DEFAULT_ERROR_MESSAGES[params.code];
    super(params.detailEn ?? def.en);
    this.name = 'UnifiedProcessingError';
    this.code = params.code;
    this.messageFa = params.detailFa ?? def.fa;
    this.retryable = params.retryable ?? def.retryable;
    this.executionMode = params.executionMode;
    this.providerId = params.providerId ?? null;
  }

  public toPayload(): UnifiedProcessingErrorPayload {
    return Object.freeze({
      code: this.code,
      messageEn: this.message,
      messageFa: this.messageFa,
      retryable: this.retryable,
      executionMode: this.executionMode,
      providerId: this.providerId,
    });
  }
}

/** Converts raw Uint8Array audio bytes into a transport-safe base64 wire payload. */
export function uint8ArrayToTransportSafeAudioInput(params: {
  readonly bytes: Uint8Array;
  readonly encoding: 'BASE64_CONTAINER' | 'BASE64_PCM16_16K_MONO';
  readonly metadata: Omit<CanonicalAudioMetadata, 'byteLength'>;
}): TransportSafeAudioInput {
  let base64: string;
  if (typeof Buffer !== 'undefined') {
    base64 = Buffer.from(params.bytes.buffer, params.bytes.byteOffset, params.bytes.byteLength).toString(
      'base64',
    );
  } else {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < params.bytes.byteLength; i += step) {
      bin += String.fromCharCode(...params.bytes.subarray(i, i + step));
    }
    base64 = btoa(bin);
  }

  return Object.freeze({
    encoding: params.encoding,
    payloadBase64: base64,
    metadata: Object.freeze({
      ...params.metadata,
      byteLength: params.bytes.byteLength,
    }),
  });
}

/** Decodes a transport-safe base64 payload back into a standard Uint8Array. */
export function transportSafeAudioInputToUint8Array(input: TransportSafeAudioInput): Uint8Array {
  if (!input.payloadBase64 || input.payloadBase64.trim().length === 0) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: 'LOCAL',
      detailEn: 'TransportSafeAudioInput is missing payloadBase64.',
    });
  }
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(input.payloadBase64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(input.payloadBase64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const VALID_PROCESSING_MODES = new Set<ProcessingMode>(['batch', 'long_form', 'streaming']);
const VALID_EXECUTION_MODES = new Set<ExecutionMode>(['LOCAL', 'CLOUD']);
const VALID_NORMALIZATION_PROFILES = new Set<NormalizationProfileId>([
  'RAW_UNMODIFIED',
  'FA-STRICT-V1',
  'FA-RELAXED-V1',
  'EN-NORM-V1',
  'MIXED-NORM-V1',
]);

/** Ensures no runtime-specific Buffer / File / Function objects leak into public wire payloads. */
export function containsNonSerializableRuntimeObject(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === null || value === undefined) return false;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return true;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array || value instanceof Float32Array || value instanceof ArrayBuffer) {
    return true;
  }
  if (typeof File !== 'undefined' && value instanceof File) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsNonSerializableRuntimeObject(item, depth + 1));
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (containsNonSerializableRuntimeObject(v, depth + 1)) return true;
    }
  }
  return false;
}

export function validateUnifiedProcessingRequest(
  req: UnifiedProcessingRequest,
  resolvedMode: ExecutionMode,
): void {
  if (!req || typeof req !== 'object') {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'Request payload must be an object.',
    });
  }
  if (req.contractVersion !== UNIFIED_PROCESSING_CONTRACT_VERSION) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: `Unsupported contractVersion "${String(req.contractVersion)}". Expected "${UNIFIED_PROCESSING_CONTRACT_VERSION}".`,
    });
  }
  if (containsNonSerializableRuntimeObject(req)) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'Public wire request must not contain Buffer, TypedArray, Blob, File, or function objects.',
    });
  }
  if (!req.jobId || typeof req.jobId !== 'string' || req.jobId.trim().length === 0) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'jobId is required.',
    });
  }
  if (!req.recordingId || typeof req.recordingId !== 'string' || req.recordingId.trim().length === 0) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'recordingId is required.',
    });
  }
  if (req.executionMode !== undefined && !VALID_EXECUTION_MODES.has(req.executionMode)) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: `Invalid executionMode "${String(req.executionMode)}".`,
    });
  }
  if (!VALID_PROCESSING_MODES.has(req.processingMode)) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: `Invalid processingMode "${String(req.processingMode)}".`,
    });
  }
  if (!req.audio || !req.audio.metadata) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'audio input and metadata are required.',
    });
  }
  if (
    req.audio.encoding !== 'OPAQUE_ASSET_REF' &&
    (!req.audio.payloadBase64 || req.audio.payloadBase64.trim().length === 0)
  ) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'audio.payloadBase64 is required for base64 encodings.',
    });
  }
  if (req.audio.metadata.byteLength <= 0) {
    throw new UnifiedProcessingError({
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      executionMode: resolvedMode,
      detailEn: 'Audio input cannot be empty (0 bytes).',
    });
  }
  if (!req.config || !VALID_NORMALIZATION_PROFILES.has(req.config.normalizationProfile)) {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'Valid config.normalizationProfile is required.',
    });
  }
  if (!req.cancellationId || typeof req.cancellationId !== 'string') {
    throw new UnifiedProcessingError({
      code: 'INVALID_PROCESSING_REQUEST',
      executionMode: resolvedMode,
      detailEn: 'cancellationId is required.',
    });
  }
}

export function validateUnifiedProcessingResultEnvelope(
  envelope: unknown,
  expectedJobId: string,
  expectedExecutionMode: ExecutionMode,
): envelope is UnifiedProcessingResultEnvelope {
  if (!envelope || typeof envelope !== 'object') return false;
  if (containsNonSerializableRuntimeObject(envelope)) return false;
  const e = envelope as Record<string, unknown>;
  if (e.contractVersion !== UNIFIED_PROCESSING_CONTRACT_VERSION) return false;
  if (e.jobId !== expectedJobId) return false;
  if (e.executionMode !== expectedExecutionMode) return false;
  if (
    e.status !== 'COMPLETED' &&
    e.status !== 'PARTIAL_WITH_FAILURES' &&
    e.status !== 'FAILED' &&
    e.status !== 'CANCELLED'
  ) {
    return false;
  }
  if (typeof e.rawModelOutput !== 'string') return false;
  if (!e.normalizedByProfile || typeof e.normalizedByProfile !== 'object') return false;
  const norm = e.normalizedByProfile as Record<string, unknown>;
  if (norm.RAW_UNMODIFIED !== e.rawModelOutput) return false;
  if (!Array.isArray(e.segments)) return false;
  if (!e.provenance || typeof e.provenance !== 'object') return false;
  const prov = e.provenance as Record<string, unknown>;
  if (prov.jobId !== expectedJobId) return false;
  if (prov.selectedExecutionMode !== expectedExecutionMode) return false;
  if (typeof prov.actualAdapterId !== 'string' || prov.actualAdapterId.length === 0) return false;
  if (typeof prov.fallbackUsed !== 'boolean') return false;
  return true;
}

export interface UnifiedExecutionAdapter {
  readonly adapterId: string;
  readonly executionMode: ExecutionMode;
  discoverCapabilities(): Promise<readonly ProviderCapabilityDescriptor[]>;
  execute(
    request: UnifiedProcessingRequest,
    signal?: AbortSignal,
  ): Promise<UnifiedProcessingResultEnvelope>;
}
