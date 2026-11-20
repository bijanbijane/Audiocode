/**
 * AVAPARDAZ — CANONICAL MULTI-CAPABILITY PROCESSING CONTRACTS (v2.0.0)
 *
 * Compliant with AVP-ARCH-001 (Version 4.0) Sections 5, 6, 7 & INV-001..INV-009:
 * - Zero host dependencies (no Adobe/CEP/ExtendScript/React/DOM/Cloud SDK imports)
 * - Shared Operation Envelope (Section 6.1) + Capability-Specific Payload Contracts (Section 6.2)
 * - Explicit Local & Cloud execution policies with zero silent Local-to-Cloud fallback
 */

import type {
  ConfidenceStatus,
  DetectedLanguageTag,
  NormalizationProfileId,
  TimestampGranularity,
} from '../../asr-core/CoreAsrContracts';
import type { SampleRate } from '../../contracts/timebase.contract';
import type { SpeechEvent, SpeechEditSuggestion } from '../../ai-engine/speech-events';
import type { EditDecisionListSnapshot } from '../../ai-engine/edit-decision';
import type {
  CapabilityAvailabilityState,
  ExecutionMode,
  MeasuredResourceUsage,
  ProcessingMode,
  TransportSafeAudioInput,
  UnifiedProcessingErrorCode,
  UnifiedProcessingErrorPayload,
  UnifiedTranscriptSegment,
} from '../UnifiedProcessingContract';

export const CANONICAL_CONTRACT_VERSION = '2.0.0' as const;
export const CANONICAL_OPERATION_VERSION = '1.0.0' as const;

export type CanonicalCapabilityId =
  | 'speech.transcription'
  | 'audio.silence_detection'
  | 'speech.filler_detection'
  | 'speech.repetition_detection'
  | 'speech.intelligent_editing'
  | 'audio.quality_analysis';

export type ExecutionPolicy =
  | 'LOCAL_ONLY'
  | 'CLOUD_ONLY'
  | 'LOCAL_PREFERRED_EXPLICIT_CLOUD_OPT_IN';

export type RequestedModelPolicy =
  | 'AUTO_BEST_LOCAL'
  | 'DETERMINISTIC_CPU_BASELINE'
  | 'REQUIRE_NEURAL_WEIGHTS'
  | 'EXPLICIT_CLOUD_PROVIDER';

export type CanonicalJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'RECOVERABLE'
  | 'EXPIRED';

export interface CanonicalMediaReference {
  readonly media_id: string;
  readonly filename: string;
  readonly sha256_hex: string | null;
  readonly sample_rate_hz: number;
  readonly channel_count: number;
  readonly byte_length: number;
  readonly storage_ref?: string | null;
}

export interface CanonicalOperationEnvelope<TInput = unknown, TConfig = Record<string, unknown>> {
  readonly request_id: string;
  readonly capability_id: CanonicalCapabilityId;
  readonly operation_version: string;
  readonly contract_version: typeof CANONICAL_CONTRACT_VERSION;
  readonly project_id: string;
  readonly project_revision: number;
  readonly media_references: readonly CanonicalMediaReference[];
  readonly input_payload: TInput;
  readonly configuration: TConfig;
  readonly execution_policy: ExecutionPolicy;
  readonly requested_model_policy: RequestedModelPolicy;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly correlation_id: string;
}

export interface CanonicalResultProvenance {
  readonly request_id: string;
  readonly correlation_id: string;
  readonly project_id: string;
  readonly project_revision: number;
  readonly actual_adapter_id: string;
  readonly actual_provider_id: string;
  readonly is_genuine_neural_model: boolean;
  readonly fallback_used: boolean;
  readonly fallback_authorized_reason: string | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
}

export interface CanonicalOperationResult<TOutput = unknown> {
  readonly request_id: string;
  readonly capability_id: CanonicalCapabilityId;
  readonly operation_version: string;
  readonly result_schema_version: string;
  readonly status: 'COMPLETED' | 'PARTIAL_WITH_FAILURES' | 'FAILED' | 'CANCELLED';
  readonly result_payload: TOutput | null;
  readonly media_references: readonly CanonicalMediaReference[];
  readonly processing_metadata: MeasuredResourceUsage;
  readonly actual_execution_environment: ExecutionMode;
  readonly actual_model_identity: string | null;
  readonly actual_model_version: string | null;
  readonly provenance: CanonicalResultProvenance;
  readonly warnings: readonly string[];
  readonly errors: readonly UnifiedProcessingErrorPayload[];
}

export interface CapabilityDescriptor {
  readonly capability_id: CanonicalCapabilityId;
  readonly display_name: string;
  readonly responsibility: string;
  readonly ownership_layer: 'PROCESSING_CORE';
  readonly supported_operation_versions: readonly string[];
  readonly local_status: CapabilityAvailabilityState;
  readonly cloud_status: CapabilityAvailabilityState;
  readonly required_runtime_components: readonly string[];
  readonly max_recommended_memory_bytes: number;
  readonly entitlement_tier: 'FREE_LOCAL' | 'PRO_LOCAL' | 'CLOUD_QUOTA';
  readonly verification_status: 'VERIFIED' | 'UNVERIFIED';
  readonly limitations: readonly string[];
}

// ── Capability-Specific Payload Schemas (Section 6.2) ────────────────────────

export interface SpeechTranscriptionInput {
  readonly audio: TransportSafeAudioInput;
  readonly processing_mode: ProcessingMode;
  readonly language_hint: DetectedLanguageTag | 'auto';
  readonly normalization_profile: NormalizationProfileId;
  readonly max_segment_duration_sec?: number;
  readonly context_overlap_sec?: number;
  readonly preferred_provider_id?: string;
}

export interface SpeechTranscriptionOutput {
  readonly duration_sec: number | null;
  readonly dominant_language: DetectedLanguageTag;
  readonly raw_model_output: string;
  readonly normalized_by_profile: Readonly<Record<NormalizationProfileId, string>>;
  readonly confidence_status: ConfidenceStatus;
  readonly calibrated_confidence: number | null;
  readonly timestamp_granularity: TimestampGranularity;
  readonly segments: readonly UnifiedTranscriptSegment[];
  readonly failed_segment_ranges: readonly {
    readonly segmentIndex: number;
    readonly startSec: number;
    readonly endSec: number;
    readonly reason: string;
  }[];
}

export interface TimedWordInput {
  readonly id: string;
  readonly track_id: string;
  readonly original_text: string;
  readonly start_sec: number;
  readonly end_sec: number;
  readonly confidence?: number;
}

export interface SpeechEventCapabilityInput {
  readonly track_id: string;
  readonly sample_rate_hz?: SampleRate;
  readonly audio?: TransportSafeAudioInput;
  readonly tokens?: readonly TimedWordInput[];
}

export interface SilenceDetectionOutput {
  readonly engine_version: string;
  readonly analyzed_duration_sec: number;
  readonly estimated_noise_floor_dbfs: number | null;
  readonly silence_events: readonly SpeechEvent[];
  readonly suggestions: readonly SpeechEditSuggestion[];
}

export interface FillerDetectionOutput {
  readonly engine_version: string;
  readonly analyzed_duration_sec: number;
  readonly filler_events: readonly SpeechEvent[];
  readonly suggestions: readonly SpeechEditSuggestion[];
}

export interface RepetitionDetectionOutput {
  readonly engine_version: string;
  readonly analyzed_duration_sec: number;
  readonly repetition_events: readonly SpeechEvent[];
  readonly suggestions: readonly SpeechEditSuggestion[];
}

export interface IntelligentEditingInput {
  readonly track_id: string;
  readonly source_audio_id: string;
  readonly source_audio_hash: string;
  readonly transcript_version: string;
  readonly sample_rate_hz?: SampleRate;
  readonly audio?: TransportSafeAudioInput;
  readonly tokens?: readonly TimedWordInput[];
}

export interface IntelligentEditingOutput {
  readonly non_destructive_guarantee: true;
  readonly auto_applied: false;
  readonly base_project_revision: number;
  readonly edl_snapshot: EditDecisionListSnapshot;
  readonly proposal_count: number;
  readonly conflict_count: number;
}

export interface AudioQualityAnalysisInput {
  readonly audio: TransportSafeAudioInput;
}

export interface AudioQualityAnalysisOutput {
  readonly detected_container: string;
  readonly source_sample_rate_hz: number;
  readonly source_channels: number;
  readonly duration_sec: number;
  readonly peak_dbfs: number;
  readonly rms_dbfs: number;
  readonly clipping_ratio: number;
  readonly dc_offset: number;
  readonly estimated_snr_db: number;
  readonly stereo_channel_action: string;
  readonly stereo_correlation: number | null;
  readonly quality_warnings: readonly string[];
}

const VALID_CAPABILITIES = new Set<CanonicalCapabilityId>([
  'speech.transcription',
  'audio.silence_detection',
  'speech.filler_detection',
  'speech.repetition_detection',
  'speech.intelligent_editing',
  'audio.quality_analysis',
]);

const VALID_EXECUTION_POLICIES = new Set<ExecutionPolicy>([
  'LOCAL_ONLY',
  'CLOUD_ONLY',
  'LOCAL_PREFERRED_EXPLICIT_CLOUD_OPT_IN',
]);

export interface EnvelopeValidationResult {
  readonly ok: boolean;
  readonly code?: UnifiedProcessingErrorCode;
  readonly message?: string;
}

export function validateCanonicalOperationEnvelope(
  envelope: unknown,
): EnvelopeValidationResult {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'Envelope must be a JSON object.' };
  }
  const e = envelope as Record<string, unknown>;
  if (e.contract_version !== CANONICAL_CONTRACT_VERSION) {
    return {
      ok: false,
      code: 'INVALID_PROCESSING_REQUEST',
      message: `Unsupported contract_version "${String(e.contract_version)}". Expected "${CANONICAL_CONTRACT_VERSION}".`,
    };
  }
  if (typeof e.request_id !== 'string' || e.request_id.trim().length === 0) {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'request_id is required.' };
  }
  if (!VALID_CAPABILITIES.has(e.capability_id as CanonicalCapabilityId)) {
    return {
      ok: false,
      code: 'INVALID_PROCESSING_REQUEST',
      message: `Unknown capability_id "${String(e.capability_id)}".`,
    };
  }
  if (typeof e.operation_version !== 'string' || e.operation_version.trim().length === 0) {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'operation_version is required.' };
  }
  if (typeof e.project_id !== 'string' || e.project_id.trim().length === 0) {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'project_id is required.' };
  }
  if (typeof e.project_revision !== 'number' || !Number.isInteger(e.project_revision) || e.project_revision < 0) {
    return {
      ok: false,
      code: 'INVALID_PROCESSING_REQUEST',
      message: 'project_revision must be a non-negative integer.',
    };
  }
  if (!Array.isArray(e.media_references)) {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'media_references must be an array.' };
  }
  if (!VALID_EXECUTION_POLICIES.has(e.execution_policy as ExecutionPolicy)) {
    return {
      ok: false,
      code: 'INVALID_PROCESSING_REQUEST',
      message: `Invalid execution_policy "${String(e.execution_policy)}".`,
    };
  }
  if (typeof e.idempotency_key !== 'string' || e.idempotency_key.trim().length === 0) {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'idempotency_key is required.' };
  }
  if (typeof e.correlation_id !== 'string' || e.correlation_id.trim().length === 0) {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'correlation_id is required.' };
  }
  if (!e.input_payload || typeof e.input_payload !== 'object') {
    return { ok: false, code: 'INVALID_PROCESSING_REQUEST', message: 'input_payload must be an object.' };
  }
  return { ok: true };
}
