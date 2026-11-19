import { FLICKS_PER_SECOND, Flicks, SampleIndex, SampleRate } from '../contracts/timebase.contract';
import { ProjectDocument, TimelineClip } from '../contracts/project-schema.contract';
import {
  EditDecisionListSnapshot,
  EditOperationType,
  EditProposal,
  SourceSampleInterval,
  UndoRedoEditMetadata,
} from '../ai-engine/edit-decision/EditDecisionTypes';
import { MemoryPressureLevel } from '../runtime/memory/MemoryBudgetManager';

export const AUDIO_RENDERER_VERSION = '6.0.0-avp-p06' as const;

/** Maximum RIFF/WAVE data chunk payload before 32-bit RIFF size overflows (4 GiB - 36 B header) */
export const RIFF_WAV_MAX_DATA_BYTES = 0xffffffff - 36;

export type RenderLifecycleState =
  | 'QUEUED'
  | 'VALIDATING'
  | 'PLANNING'
  | 'RENDERING'
  | 'PAUSED_MEMORY_PRESSURE'
  | 'PAUSED_USER'
  | 'FINALIZING'
  | 'VALIDATING_OUTPUT'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'FAILED_VALIDATION'
  | 'RECOVERABLE';

export type RenderExportEncoding = 'pcm16' | 'pcm24' | 'float32';

export type RenderExportContainer = 'wav' | 'rf64';

export type CrossfadeCurve = 'linear' | 'equal-power' | 'smooth-cosine';

export type BoundaryQualityClass = 'CLEAN' | 'ACCEPTABLE' | 'RISKY' | 'UNSAFE';

export interface AudioRenderConfig {
  readonly encoding: RenderExportEncoding;
  readonly container?: RenderExportContainer;
  /** Auto-upgrade WAV to RF64 if output size exceeds 4 GiB RIFF ceiling (default: false -> explicit error) */
  readonly autoUpgradeToRf64?: boolean;
  /** Intentional resampling target rate; omitted or equal to sourceSampleRate preserves native rate */
  readonly targetSampleRate?: SampleRate;
  /** Max chunk size in samples per channel for streaming reads/writes (default: 32768) */
  readonly chunkSizeSamples?: number;
  /** Maximum zero-crossing / acoustic boundary search radius in samples (default: 240, ~5ms @ 48kHz) */
  readonly maxBoundaryAdjustmentSamples?: number;
  /** Default crossfade duration in milliseconds at splice junctions (default: 10ms) */
  readonly defaultCrossfadeMs?: number;
  /** Minimum crossfade duration in milliseconds (default: 3ms) */
  readonly minCrossfadeMs?: number;
  /** Maximum crossfade duration in milliseconds (default: 25ms) */
  readonly maxCrossfadeMs?: number;
  /** Preferred crossfade curve or 'auto' for context-aware selection */
  readonly crossfadeCurve?: CrossfadeCurve | 'auto';
  /** Apply soft peak limiter at transitions if overshoot exceeds 0.999 */
  readonly enableTransitionLimiter?: boolean;
  /** Optional explicit max output bytes quota guard */
  readonly maxOutputBytesQuota?: number;
  /** Optional trackId filter when an EDL contains multiple tracks */
  readonly trackId?: string;
}

export interface RetainedSourceSegment {
  readonly segmentIndex: number;
  readonly sourceStartSample: SampleIndex;
  readonly sourceEndSample: SampleIndex;
  readonly sampleCount: number;
  readonly outputStartSample: SampleIndex;
  readonly outputEndSample: SampleIndex;
  readonly sourceStartFlicks: Flicks;
  readonly sourceEndFlicks: Flicks;
  readonly outputStartFlicks: Flicks;
  readonly outputEndFlicks: Flicks;
}

export interface RemovedSourceSegment {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly trackId: string;
  readonly operation: Extract<
    EditOperationType,
    'REMOVE_FILLER' | 'SHORTEN_SILENCE' | 'REMOVE_ACCIDENTAL_REPETITION'
  >;
  readonly originalRange: SourceSampleInterval;
  readonly removedRange: SourceSampleInterval;
  readonly removedSampleCount: number;
  readonly relatedEventIds: readonly string[];
  readonly relatedText?: string;
}

export interface SourceToOutputMappingEntry {
  readonly segmentIndex: number;
  readonly sourceStartSample: SampleIndex;
  readonly sourceEndSample: SampleIndex;
  readonly outputStartSample: SampleIndex;
  readonly outputEndSample: SampleIndex;
}

export interface RenderTransitionPlan {
  readonly transitionIndex: number;
  readonly leftSegmentIndex: number;
  readonly rightSegmentIndex: number;
  readonly sourceLeftCutSample: SampleIndex;
  readonly sourceRightResumeSample: SampleIndex;
  readonly removedProposalId: string;
  readonly requestedCrossfadeSamples: number;
  readonly maxAdjustmentSamples: number;
  readonly preferredCurve: CrossfadeCurve | 'auto';
}

export interface ImmutableRenderPlan {
  readonly planId: string;
  readonly planHash: string;
  readonly rendererVersion: typeof AUDIO_RENDERER_VERSION;
  readonly projectId: string;
  readonly trackId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly edlId: string;
  readonly edlVersion: number;
  readonly transcriptVersion: string;
  readonly timebaseFlicksPerSecond: typeof FLICKS_PER_SECOND;
  readonly sourceSampleRate: SampleRate;
  readonly outputSampleRate: SampleRate;
  readonly channelCount: number;
  readonly totalSourceSamples: number;
  readonly expectedPreResampleOutputSamples: number;
  readonly expectedOutputSamples: number;
  readonly sourceDurationSec: number;
  readonly expectedOutputDurationSec: number;
  readonly removedSampleCount: number;
  readonly removedDurationSec: number;
  readonly encoding: RenderExportEncoding;
  readonly container: RenderExportContainer;
  readonly estimatedOutputBytes: number;
  readonly approvedProposalIds: readonly string[];
  readonly retainedSegments: readonly RetainedSourceSegment[];
  readonly removedSegments: readonly RemovedSourceSegment[];
  readonly transitions: readonly RenderTransitionPlan[];
  readonly sourceToOutputMap: readonly SourceToOutputMappingEntry[];
  readonly derivedTimelineClips: readonly TimelineClip[];
  readonly undoMetadataItems: readonly UndoRedoEditMetadata[];
  readonly createdAtMs: number;
}

export interface BoundaryCheckRecord {
  readonly transitionIndex: number;
  readonly proposalId: string;
  readonly originalLeftSample: SampleIndex;
  readonly adjustedLeftSample: SampleIndex;
  readonly originalRightSample: SampleIndex;
  readonly adjustedRightSample: SampleIndex;
  readonly leftAdjustmentSamples: number;
  readonly rightAdjustmentSamples: number;
  readonly maxAllowedAdjustmentSamples: number;
  readonly leftRmsDb: number;
  readonly rightRmsDb: number;
  readonly energyDeltaDb: number;
  readonly discontinuityJump: number;
  readonly slopeSignMatch: boolean;
  readonly qualityClass: BoundaryQualityClass;
  readonly adjustmentApplied: boolean;
  readonly rejectedAdjustmentReason?: string;
  readonly notes: readonly string[];
}

export interface CrossfadeTransitionResult {
  readonly transitionIndex: number;
  readonly proposalId: string;
  readonly applied: boolean;
  readonly curveUsed: CrossfadeCurve | 'none';
  readonly crossfadeSamples: number;
  readonly channelCount: number;
  readonly correlationCoefficient: number;
  readonly phaseCancellationRisk: boolean;
  readonly peakBeforeLimit: number;
  readonly peakAfterLimit: number;
  readonly limiterEngaged: boolean;
  readonly fallbackUsed: boolean;
  readonly notes: readonly string[];
}

export type RenderValidationErrorCode =
  | 'INVALID_SOURCE_IDENTITY'
  | 'STALE_EDL_OR_TRANSCRIPT'
  | 'UNAPPROVED_PROPOSAL'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_SAMPLE_COORDINATES'
  | 'DUPLICATE_OR_OVERLAPPING_REMOVAL'
  | 'PROTECTED_EVENT_OVERLAP'
  | 'UNRESOLVED_EDL_CONFLICT'
  | 'CRITICAL_OR_UNKNOWN_RISK'
  | 'UNSUPPORTED_EXPORT_FORMAT'
  | 'OUTPUT_SIZE_EXCEEDS_RIFF_LIMIT'
  | 'OUTPUT_QUOTA_EXCEEDED'
  | 'MEMORY_BUDGET_EXHAUSTED'
  | 'CHANNEL_MISMATCH'
  | 'INVALID_CONTAINER_HEADER'
  | 'SAMPLE_COUNT_MISMATCH'
  | 'DURATION_MISMATCH'
  | 'UNEXPECTED_CLIPPING'
  | 'INVALID_FLOAT_SAMPLES'
  | 'HASH_VERIFICATION_FAILED'
  | 'OUTPUT_UNREADABLE'
  | 'TIMELINE_MAPPING_INCONSISTENT'
  | 'CHECKPOINT_INCOMPATIBLE'
  | 'WRITE_IO_FAILURE';

export interface RenderValidationFailure {
  readonly code: RenderValidationErrorCode;
  readonly severity: 'ERROR' | 'WARNING';
  readonly message: string;
  readonly proposalId?: string;
  readonly actionableFix: string;
}

export interface RenderValidationReport {
  readonly phase: 'PRE_RENDER' | 'POST_RENDER';
  readonly passed: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly failures: readonly RenderValidationFailure[];
  readonly verifiedContainer?: RenderExportContainer;
  readonly verifiedEncoding?: RenderExportEncoding;
  readonly verifiedSampleRate?: number;
  readonly verifiedChannelCount?: number;
  readonly verifiedOutputSamples?: number;
  readonly verifiedDurationSec?: number;
  readonly verifiedFileSizeBytes?: number;
  readonly verifiedPeakAmplitude?: number;
  readonly verifiedClippedSamples?: number;
  readonly verifiedNonFiniteSamples?: number;
  readonly verifiedOutputHash?: string;
}

export interface RenderProgressSnapshot {
  readonly renderId: string;
  readonly state: RenderLifecycleState;
  readonly progressPercent: number | null;
  readonly currentOperation: string;
  readonly processedSourceSamples: number;
  readonly totalSourceSamples: number;
  readonly writtenOutputSamples: number;
  readonly expectedOutputSamples: number;
  readonly currentSegmentIndex: number;
  readonly totalSegments: number;
  readonly memoryPressure: MemoryPressureLevel;
  readonly accountedMemoryBytes: number;
  readonly elapsedMs: number;
}

export interface RenderCheckpoint {
  readonly checkpointId: string;
  readonly renderId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly rendererVersion: typeof AUDIO_RENDERER_VERSION;
  readonly projectId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly edlId: string;
  readonly edlVersion: number;
  readonly transcriptVersion: string;
  readonly encoding: RenderExportEncoding;
  readonly container: RenderExportContainer;
  readonly outputSampleRate: SampleRate;
  readonly channelCount: number;
  readonly completedSegmentIndex: number;
  readonly nextSegmentSampleOffset: number;
  readonly writtenOutputSamples: number;
  readonly writtenDataBytes: number;
  readonly partialOutputHashState: string;
  readonly stateAtCheckpoint: RenderLifecycleState;
  readonly savedAtMs: number;
  readonly integrityHash: string;
}

export interface RenderOutputMetadata {
  readonly renderId: string;
  readonly artifactId: string;
  readonly container: RenderExportContainer;
  readonly encoding: RenderExportEncoding;
  readonly bitsPerSample: 16 | 24 | 32;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly totalOutputSamples: number;
  readonly durationSec: number;
  readonly fileSizeBytes: number;
  readonly outputHash: string;
  readonly peakAmplitude: number;
  readonly truePeakDbfs: number;
  readonly clippedSampleCount: number;
  readonly nonFiniteSampleCount: number;
  readonly persistedExternally: boolean;
  readonly finalizedAtMs: number;
}

export interface AudioRenderResult {
  readonly renderId: string;
  readonly state: RenderLifecycleState;
  readonly ok: boolean;
  readonly plan: ImmutableRenderPlan | null;
  readonly output: RenderOutputMetadata | null;
  readonly outputBytes: Uint8Array | null;
  readonly preValidation: RenderValidationReport;
  readonly postValidation: RenderValidationReport | null;
  readonly boundaryChecks: readonly BoundaryCheckRecord[];
  readonly crossfadeResults: readonly CrossfadeTransitionResult[];
  readonly checkpoint: RenderCheckpoint | null;
  readonly sourceDurationSec: number;
  readonly outputDurationSec: number;
  readonly removedDurationSec: number;
  readonly wallClockMs: number;
  readonly realTimeFactor: number | null;
  readonly peakReservedBytes: number;
  readonly sourceImmutableVerified: true;
  readonly edlImmutableVerified: true;
  readonly appliedProposalIds: readonly string[];
  readonly failureReason?: string;
}

export interface ChunkedPcmSource {
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly totalSamples: number;
  /** Reads [startSample, startSample + sampleCount) as planar Float32Array[channel] */
  readPlanarRange(startSample: number, sampleCount: number): Promise<Float32Array[]>;
}

export interface AudioRenderRequest {
  readonly renderId?: string;
  readonly edl: EditDecisionListSnapshot;
  readonly source: ChunkedPcmSource;
  readonly expectedSourceAudioHash: string;
  readonly expectedTranscriptVersion: string;
  readonly expectedEdlVersion: number;
  readonly config: AudioRenderConfig;
  readonly projectDocument?: ProjectDocument;
  /** Optional explicit subset of approved proposal IDs to render */
  readonly proposalIds?: readonly string[];
  readonly abortSignal?: AbortSignal;
  /** Optional hook returning true when the user requests a clean pause between chunks */
  readonly shouldPauseUser?: () => boolean;
  readonly onProgress?: (snapshot: RenderProgressSnapshot) => void;
  readonly nowMs?: number;
}

export type ApprovedEditProposal = EditProposal & {
  readonly status: 'APPROVED';
  readonly originalRange: SourceSampleInterval;
  readonly proposedRange: SourceSampleInterval;
};
