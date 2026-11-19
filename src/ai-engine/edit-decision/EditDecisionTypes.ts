import {
  FLICKS_PER_SECOND,
  Flicks,
  SampleIndex,
  SampleRate,
  TimeRange,
} from '../../contracts/timebase.contract';
import { ChannelLayout, PersianWordToken } from '../../contracts/v1_2';
import {
  MultiTrackCutStrategy,
  ProsodicWarningType,
} from '../../contracts/persian-editing.contract';
import {
  ScoreCalibrationStatus,
  SpeechEvent,
  SpeechEventCategory,
  SpeechEventSubtype,
  TimelineSuggestionClass,
} from '../speech-events/SpeechEventContracts';
import { TimedPersianToken } from '../PersianTextNormalizer';

export const EDL_SCHEMA_VERSION = '1.0.0' as const;
export const EDIT_DECISION_ENGINE_VERSION = '5.0.0-avp-p05' as const;

export type EditOperationType = TimelineSuggestionClass;

export type EditProposalStatus =
  | 'PROPOSED'
  | 'NEEDS_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'STALE'
  | 'INVALID'
  | 'SUPERSEDED'
  | 'APPLIED';

export type EditValidationStatus =
  | 'VALID'
  | 'WARNING'
  | 'INVALID'
  | 'STALE'
  | 'UNVALIDATED';

export type EditRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export type CandidateEligibilityClass =
  | 'SAFE_EDIT_CANDIDATE'
  | 'REVIEW_REQUIRED_CANDIDATE'
  | 'DETECTABLE_NOT_EDITABLE'
  | 'DO_NOT_EDIT'
  | 'INVALID_CANDIDATE';

export type RiskDimensionKey =
  | 'ACOUSTIC_BOUNDARY_UNCERTAINTY'
  | 'WORD_BOUNDARY_UNCERTAINTY'
  | 'PHONEME_TRUNCATION_RISK'
  | 'CONSONANT_ONSET_OR_RELEASE_TRUNCATION'
  | 'VOWEL_TRUNCATION_RISK'
  | 'SEMANTIC_ALTERATION_RISK'
  | 'GRAMMATICAL_DAMAGE_RISK'
  | 'PROSODIC_DISRUPTION_RISK'
  | 'OVERLAPPING_EVENT_RISK'
  | 'TRANSCRIPT_AUDIO_MISMATCH'
  | 'INSUFFICIENT_SOURCE_EVIDENCE'
  | 'STALE_DATA_RISK';

export interface RiskDimensionAssessment {
  readonly dimension: RiskDimensionKey;
  readonly level: EditRiskLevel;
  readonly reason: string;
  readonly evidenceNotes: readonly string[];
}

export interface EditRiskAssessment {
  readonly overallLevel: EditRiskLevel;
  readonly dimensions: readonly RiskDimensionAssessment[];
  /** Heuristic ranking score in [0, 1] for sorting only — NEVER a calibrated probability */
  readonly heuristicRankingScore: number;
  readonly scoreCalibrationStatus: ScoreCalibrationStatus;
  /** Always false in AVP-P05-001; approval is always a separate explicit action */
  readonly automaticApprovalEligible: false;
  readonly approvalPermitted: boolean;
  readonly mandatoryHumanReview: boolean;
  readonly blockingReasons: readonly string[];
}

/** Authoritative integer sample coordinate interval on the original source timeline */
export interface SourceSampleInterval {
  readonly startSample: SampleIndex;
  readonly endSample: SampleIndex;
  readonly sampleRate: SampleRate;
  readonly timebaseFlicksPerSecond: typeof FLICKS_PER_SECOND;
  readonly startFlicks: Flicks;
  readonly endFlicks: Flicks;
  /** Presentation-only seconds derived from authoritative integer samples */
  readonly startSec: number;
  /** Presentation-only seconds derived from authoritative integer samples */
  readonly endSec: number;
  /** Presentation-only duration in milliseconds */
  readonly durationMs: number;
}

export type BoundaryMeasurementBasis =
  | 'FORCED_ALIGNED'
  | 'MEASURED_ACOUSTIC'
  | 'ESTIMATED_ASR_TOKEN'
  | 'ESTIMATED_HEURISTIC'
  | 'UNKNOWN';

export type BoundaryConfidenceClassification = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface RefinedBoundaryResult {
  readonly valid: boolean;
  readonly originalInterval: SourceSampleInterval | null;
  readonly proposedInterval: SourceSampleInterval | null;
  readonly measurementBasis: BoundaryMeasurementBasis;
  /** Independent from speech-event confidence */
  readonly boundaryConfidence: BoundaryConfidenceClassification;
  /** Heuristic boundary quality score in [0, 1] or null when unknown — NOT a calibrated probability */
  readonly boundaryConfidenceScore: number | null;
  readonly boundaryScoreCalibrationStatus: ScoreCalibrationStatus;
  readonly refinementMethod: string;
  readonly leftSafetyMarginSamples: number;
  readonly rightSafetyMarginSamples: number;
  readonly phonemeBoundariesAvailable: boolean;
  readonly appliedEvidence: readonly string[];
  readonly warnings: readonly string[];
  readonly rejectionReason?: string;
}

export type EditConfidenceClassification =
  | 'CALIBRATED_HIGH'
  | 'CALIBRATED_MEDIUM'
  | 'CALIBRATED_LOW'
  | 'MODEL_RAW'
  | 'HIGH_HEURISTIC'
  | 'MEDIUM_HEURISTIC'
  | 'LOW_HEURISTIC'
  | 'INSUFFICIENT'
  | 'UNSUPPORTED';

export interface EditEvidenceReference {
  readonly refId: string;
  readonly kind:
    | 'SPEECH_EVENT'
    | 'TRANSCRIPT_TOKEN'
    | 'ACOUSTIC_WINDOW'
    | 'VAD'
    | 'PROSODY'
    | 'LEXICON';
  readonly sourceId: string;
  readonly summary: string;
  readonly metrics?: Readonly<Record<string, number | string | boolean | null>>;
}

export interface EditProposalProvenance {
  readonly projectId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly alignmentVersion?: string;
  readonly speechEventSourceIds: readonly string[];
  readonly eventDetectorVersion: string;
  readonly decisionEngineVersion: string;
  readonly modelVersions: Readonly<Record<string, string>>;
  readonly lexiconVersion: string;
  readonly thresholdConfigVersion: string;
}

export type EditValidationErrorCode =
  | 'MISSING_SOURCE_IDENTITY'
  | 'INVALID_TIMEBASE'
  | 'INVALID_SAMPLE_RATE'
  | 'INVALID_SAMPLE_POSITIONS'
  | 'START_GTE_END'
  | 'OUT_OF_RANGE_COORDINATES'
  | 'MISSING_EVENT_PROVENANCE'
  | 'MISSING_TRANSCRIPT_VERSION'
  | 'UNSUPPORTED_OPERATION'
  | 'UNRESOLVED_CONFLICT'
  | 'STALE_PROPOSAL'
  | 'INVALID_STATE_TRANSITION'
  | 'DUPLICATE_PROPOSAL_ID'
  | 'PROTECTED_EVENT_OVERLAP'
  | 'INCOMPATIBLE_EDL_VERSION'
  | 'INVALID_SERIALIZATION'
  | 'DUPLICATE_SOURCE_REMOVAL'
  | 'POST_EDIT_VALIDATION_FAILED'
  | 'PROPOSAL_NOT_APPROVED'
  | 'CRITICAL_OR_UNKNOWN_RISK';

export interface EditValidationFailure {
  readonly code: EditValidationErrorCode;
  readonly severity: 'ERROR' | 'WARNING';
  readonly proposalId?: string;
  readonly message: string;
  readonly actionableFix: string;
}

export interface EditProposal {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly projectId: string;
  readonly trackId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly alignmentVersion?: string;
  readonly speechEventSourceIds: readonly string[];
  readonly eventDetectorVersion: string;
  readonly modelVersions: Readonly<Record<string, string>>;
  readonly lexiconVersion: string;
  readonly timebaseFlicksPerSecond: typeof FLICKS_PER_SECOND;
  readonly sampleRate: SampleRate;
  readonly channelLayout?: ChannelLayout;
  readonly originalRange: SourceSampleInterval | null;
  readonly proposedRange: SourceSampleInterval | null;
  readonly operation: EditOperationType;
  readonly eventCategory: SpeechEventCategory;
  readonly eventSubtype: SpeechEventSubtype;
  readonly candidateEligibility: CandidateEligibilityClass;
  readonly evidenceReferences: readonly EditEvidenceReference[];
  readonly confidenceClassification: EditConfidenceClassification;
  readonly eventConfidenceScore: number | null;
  readonly scoreCalibrationStatus: ScoreCalibrationStatus;
  readonly calibratedProbability: number | null;
  readonly boundary: RefinedBoundaryResult;
  readonly risk: EditRiskAssessment;
  readonly requiresHumanReview: boolean;
  readonly protectedEvent: boolean;
  readonly createdAtMs: number;
  readonly status: EditProposalStatus;
  readonly validationStatus: EditValidationStatus;
  readonly validationIssues: readonly EditValidationFailure[];
  readonly provenance: EditProposalProvenance;
  readonly relatedTokenIds: readonly string[];
  readonly relatedText?: string;
  readonly explanationFa: string;
  readonly conflictIds: readonly string[];
  readonly supersedesProposalId?: string;
  readonly supersededByProposalId?: string;
  readonly consolidatedFromProposalIds?: readonly string[];
}

export type EditConflictType =
  | 'DUPLICATE_PROPOSAL'
  | 'DUPLICATE_EVENT_REFERENCE'
  | 'IDENTICAL_INTERVAL'
  | 'PARTIAL_OVERLAP'
  | 'NESTED_INTERVAL'
  | 'ADJACENT_INTERVAL'
  | 'CONFLICTING_OPERATIONS'
  | 'FILLER_INSIDE_SILENCE'
  | 'BREATH_INSIDE_SILENCE'
  | 'SHARED_WORD_CONFLICT'
  | 'PROTECTED_EVENT_OVERLAP'
  | 'TRANSCRIPT_VERSION_MISMATCH';

export type EditConflictResolutionAction =
  | 'SUPERSEDED_DUPLICATE'
  | 'CONSOLIDATED_WITH_PROVENANCE'
  | 'BLOCKED_PROTECTED_OVERLAP'
  | 'REQUIRES_HUMAN_REVIEW'
  | 'ADJUSTED_SILENCE_AROUND_PROTECTED'
  | 'MARKED_ADJACENT_NOTICE'
  | 'REJECTED_STALE_VERSION';

export interface EditConflictRecord {
  readonly conflictId: string;
  readonly type: EditConflictType;
  readonly involvedProposalIds: readonly string[];
  readonly resolutionAction: EditConflictResolutionAction;
  readonly winningProposalId?: string;
  readonly supersededProposalIds: readonly string[];
  readonly blockedProposalIds: readonly string[];
  readonly consolidatedProposalId?: string;
  readonly resolved: boolean;
  readonly reason: string;
  readonly reasonFa: string;
}

export type HumanDecisionAction =
  | 'APPROVE'
  | 'REJECT'
  | 'REQUEST_REVIEW'
  | 'REVISE_BOUNDARIES'
  | 'SUPERSEDE'
  | 'REVALIDATE'
  | 'MARK_STALE';

export interface EditDecisionHistoryEntry {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly previousStatus: EditProposalStatus;
  readonly newStatus: EditProposalStatus;
  readonly action: HumanDecisionAction;
  readonly timestampMs: number;
  readonly reason?: string;
  readonly actorId?: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly supersededByProposalId?: string;
}

export interface EdlValidationSummary {
  readonly isValid: boolean;
  readonly status: EditValidationStatus;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly failures: readonly EditValidationFailure[];
}

export type EdlPersistenceStatus =
  | 'IN_MEMORY_ONLY'
  | 'PERSISTED_LOCAL'
  | 'PERSISTENCE_UNAVAILABLE';

export interface EditDecisionListSnapshot {
  readonly edlId: string;
  readonly edlSchemaVersion: typeof EDL_SCHEMA_VERSION;
  readonly edlVersion: number;
  readonly projectId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly alignmentVersion?: string;
  readonly timebaseFlicksPerSecond: typeof FLICKS_PER_SECOND;
  readonly sampleRate: SampleRate;
  readonly channelLayout?: ChannelLayout;
  readonly totalSourceSamples: number;
  readonly eventSourceVersions: {
    readonly eventDetectorVersion: string;
    readonly decisionEngineVersion: string;
    readonly lexiconVersion: string;
    readonly thresholdConfigVersion: string;
    readonly modelVersions: Readonly<Record<string, string>>;
  };
  readonly proposals: readonly EditProposal[];
  readonly conflicts: readonly EditConflictRecord[];
  readonly validation: EdlValidationSummary;
  readonly decisionHistory: readonly EditDecisionHistoryEntry[];
  readonly createdAtMs: number;
  readonly modifiedAtMs: number;
  readonly cancelled: boolean;
  readonly processedEventCount: number;
  readonly totalInputEventCount: number;
  readonly persistenceStatus: EdlPersistenceStatus;
  readonly persistenceNote: string;
}

export interface EdlSourceContext {
  readonly projectId: string;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly alignmentVersion?: string;
  readonly eventDetectorVersion?: string;
  readonly sampleRate: SampleRate;
  readonly channelLayout?: ChannelLayout;
  readonly totalSourceSamples: number;
  readonly timebaseFlicksPerSecond?: number;
  readonly modelVersions?: Readonly<Record<string, string>>;
  readonly lexiconVersion?: string;
  readonly thresholdConfigVersion?: string;
}

export interface EditDecisionGenerationRequest {
  readonly context: EdlSourceContext;
  readonly events: readonly SpeechEvent[];
  readonly tokens?: readonly (TimedPersianToken | PersianWordToken)[];
  /** Optional explicit per-event transcript version map to catch mixed-version inputs */
  readonly eventTranscriptVersions?: Readonly<Record<string, string>>;
  /** Optional bounded batch size for deterministic large-list processing (default: 64) */
  readonly batchSize?: number;
  /** Optional creation timestamp override for deterministic tests */
  readonly nowMs?: number;
  /** Optional AbortSignal for cooperative cancellation */
  readonly signal?: AbortSignal;
}

export interface UndoRedoEditMetadata {
  readonly operationIdHint: string;
  readonly expectedProjectRevision: number;
  readonly expectedSourceAudioHash: string;
  readonly expectedTranscriptVersion: string;
  readonly expectedEdlVersion: number;
  readonly sourceInterval: SourceSampleInterval;
  readonly proposedInterval: SourceSampleInterval;
  readonly timelineRangeFlicks: TimeRange;
  readonly cutStrategy: MultiTrackCutStrategy;
  readonly fadeInDurationFlicks: Flicks;
  readonly fadeOutDurationFlicks: Flicks;
  readonly injectRoomToneFlicks: Flicks;
  readonly prosodicWarnings: readonly ProsodicWarningType[];
  readonly affectedTokenIds: readonly string[];
  readonly reversible: true;
}

export interface ApplicationReadyEditItem {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly trackId: string;
  readonly operation: Extract<
    EditOperationType,
    'REMOVE_FILLER' | 'SHORTEN_SILENCE' | 'REMOVE_ACCIDENTAL_REPETITION'
  >;
  readonly originalRange: SourceSampleInterval;
  readonly proposedRange: SourceSampleInterval;
  readonly provenance: EditProposalProvenance;
  readonly undoMetadata: UndoRedoEditMetadata;
}

export interface ApplicationReadyEditPlan {
  readonly readyToApply: boolean;
  readonly edlId: string;
  readonly edlVersion: number;
  readonly projectId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly validatedAtMs: number;
  readonly items: readonly ApplicationReadyEditItem[];
  readonly blockingFailures: readonly EditValidationFailure[];
  readonly postEditWarnings: readonly string[];
  /** Explicit guarantee: Mission 05 never mutates audio or executes transactions */
  readonly executed: false;
}
