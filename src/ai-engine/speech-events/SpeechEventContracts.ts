import { Flicks, SampleRate, TimeRange } from '../../contracts/timebase.contract';
import {
  FlickRange,
  ProsodicBoundaryDetail,
  RecommendationActionMode,
} from '../../contracts/v1_2';

export const SPEECH_EVENT_ENGINE_VERSION = '4.0.0-avp-p04';
export const SPEECH_EVENT_THRESHOLD_CONFIG_VERSION = 'speech-thresholds-v1.0.0';

export type SpeechEventCategory =
  | 'FILLER'
  | 'WORD_REPETITION'
  | 'SYLLABLE_REPETITION'
  | 'STUTTER'
  | 'FALSE_START'
  | 'SELF_CORRECTION'
  | 'SILENCE'
  | 'BREATH'
  | 'NON_VERBAL_VOCALIZATION'
  | 'PACING_ANOMALY'
  | 'UNCERTAIN_SPEECH_EVENT';

export type SpeechEventSubtype =
  // Fillers
  | 'VOCAL_FILLED_PAUSE'
  | 'DISCOURSE_FILLER'
  | 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED'
  | 'CONTEXT_DEPENDENT_COLLOQUIAL'
  // Repetitions & Stutter (observable patterns, non-diagnostic)
  | 'ACCIDENTAL_WORD_REPETITION'
  | 'INTENTIONAL_EMPHASIS_REPETITION'
  | 'LEGITIMATE_LEXICAL_REPETITION'
  | 'SYLLABLE_REPETITION'
  | 'INITIAL_PHONEME_REPETITION'
  | 'STUTTER_LIKE_BLOCK'
  // False Starts & Self-Corrections
  | 'ABANDONED_PHRASE'
  | 'RESTARTED_PHRASE'
  | 'EXPLICIT_CORRECTION'
  | 'REFORMULATION'
  | 'INCOMPLETE_INTENTIONAL'
  // Silence & Pauses
  | 'NATURAL_SHORT_PAUSE'
  | 'SENTENCE_BOUNDARY_PAUSE'
  | 'BREATH_RELATED_PAUSE'
  | 'HESITATION_PAUSE'
  | 'LONG_UNNECESSARY_SILENCE'
  | 'RECORDING_GAP'
  | 'INPUT_FAILURE_OR_DIGITAL_ZERO'
  | 'UTTERANCE_INTERNAL_SILENCE'
  | 'EDGE_SILENCE'
  // Non-verbal vocalizations
  | 'AUDIBLE_INHALATION'
  | 'AUDIBLE_EXHALATION'
  | 'COUGH'
  | 'LAUGHTER'
  | 'SIGH'
  | 'THROAT_CLEARING'
  | 'CRYING'
  | 'OTHER_VOCALIZATION'
  | 'UNCERTAIN_NON_VERBAL'
  // Prosody & Pacing
  | 'TOO_FAST_PACING'
  | 'TOO_SLOW_PACING'
  | 'ABRUPT_PACING_CHANGE'
  | 'LONG_UNINTERRUPTED_SPEECH'
  | 'NATURAL_PACING_BASELINE'
  // Uncertain / Unsupported
  | 'CONFLICTING_EVIDENCE'
  | 'LOW_ACOUSTIC_EVIDENCE'
  | 'UNSUPPORTED_DETECTOR';

export type SpeechEventDetectionState =
  | 'DETECTED'
  | 'PROBABLE'
  | 'POSSIBLE'
  | 'UNCERTAIN'
  | 'NOT_DETECTED'
  | 'UNSUPPORTED';

export type SpeechEventDetectionMethod =
  | 'HEURISTIC_SIGNAL'
  | 'HEURISTIC_LINGUISTIC'
  | 'HYBRID_HEURISTIC_FUSION'
  | 'MODEL_BASED'
  | 'UNSUPPORTED_NO_MODEL';

export type SpeechEventUncertaintyState =
  | 'LOW_UNCERTAINTY'
  | 'MODERATE_UNCERTAINTY'
  | 'HIGH_UNCERTAINTY'
  | 'CONFLICTING_EVIDENCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNSUPPORTED_CAPABILITY';

export type ScoreCalibrationStatus =
  | 'UNCALIBRATED_HEURISTIC'
  | 'MODEL_RAW_CONFIDENCE'
  | 'CALIBRATED_EMPIRICAL'
  | 'UNAVAILABLE';

export interface SpeechEventAcousticEvidence {
  readonly rmsDb?: number;
  readonly peakDb?: number;
  readonly noiseFloorDbfs?: number;
  readonly crestFactor?: number;
  readonly zcrRatio?: number;
  readonly spectralCentroidRatio?: number;
  readonly lowBandEnergyRatio?: number;
  readonly midSpeechBandEnergyRatio?: number;
  readonly fricativeBandEnergyRatio?: number;
  readonly highTransientEnergyRatio?: number;
  readonly vadSpeechRatio?: number;
  readonly vadActiveOverlap?: boolean;
  readonly periodicityScore?: number;
  readonly medianPitchHz?: number;
  readonly rhythmBurstCount?: number;
  readonly digitalZeroRatio?: number;
  readonly hysteresisApplied?: boolean;
  readonly boundaryPaddingMs?: number;
  readonly isWhisperOrLowVolumeProtected?: boolean;
  readonly notes?: readonly string[];
}

export interface SpeechEventLinguisticEvidence {
  readonly matchedLexiconId?: string;
  readonly canonicalForm?: string;
  readonly linguisticRole?: string;
  readonly surroundingLeftText?: string;
  readonly surroundingRightText?: string;
  readonly isClauseBoundary?: boolean;
  readonly repetitionCount?: number;
  readonly semanticSimilarityScore?: number;
  readonly correctionMarker?: string;
  readonly preservedAlternateSpanText?: string;
  readonly preservedAlternateRangeSec?: { readonly startSec: number; readonly endSec: number };
  readonly speakingRateWpm?: number;
  readonly articulationRateWpm?: number;
  readonly speakerBaselineWpm?: number;
  readonly notes?: readonly string[];
}

export interface SpeechEventScoreBreakdown {
  /** Acoustic heuristic feature strength in [0, 1], or null if no audio window analyzed */
  readonly acousticScore: number | null;
  /** Linguistic/lexicon structural score in [0, 1], or null if purely acoustic */
  readonly linguisticScore: number | null;
  /** Number of supporting heuristic or structural rules satisfied */
  readonly ruleEvidenceCount: number;
  /** Token confidence genuinely provided by an ASR model (if available) */
  readonly modelTokenConfidence: number | null;
  /** Combined heuristic decision score in [0, 1] — NOT a calibrated probability */
  readonly combinedDecisionScore: number | null;
  /** Calibrated probability in [0, 1] ONLY when empirical calibration has been performed; otherwise null */
  readonly calibratedProbability: number | null;
  readonly scoreCalibrationStatus: ScoreCalibrationStatus;
  /** Explicit conflicts between acoustic, VAD, model, and linguistic evidence */
  readonly conflicts: readonly string[];
}

export interface SpeechEventProvenance {
  readonly engineVersion: string;
  readonly thresholdConfigVersion: string;
  readonly detectorModule: string;
  readonly capabilityMode: 'heuristic' | 'model-based' | 'unsupported';
  readonly modelId?: string | null;
  readonly modelVersion?: string | null;
  readonly analysisWindowIndex?: number;
  readonly evaluatedSampleRate?: SampleRate | number;
  readonly timingPrecision?: 'WORD' | 'SEGMENT_ONLY' | 'PARTIAL' | 'NONE';
  readonly hasIncompleteTimestamps?: boolean;
  readonly notes?: readonly string[];
}

export interface SpeechEvent {
  readonly eventId: string;
  readonly trackId: string;
  readonly category: SpeechEventCategory;
  readonly subtype: SpeechEventSubtype;
  readonly detectionState: SpeechEventDetectionState;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly startFlicks: Flicks;
  readonly endFlicks: Flicks;
  readonly durationFlicks: Flicks;
  /** Optional trimmed candidate interval (e.g. shortened silence preserving natural padding) */
  readonly candidateStartSec?: number;
  readonly candidateEndSec?: number;
  readonly candidateStartFlicks?: Flicks;
  readonly candidateEndFlicks?: Flicks;
  readonly relatedTokenIds?: readonly string[];
  readonly relatedText?: string;
  readonly acousticEvidence?: SpeechEventAcousticEvidence;
  readonly linguisticEvidence?: SpeechEventLinguisticEvidence;
  readonly detectionMethod: SpeechEventDetectionMethod;
  /** Confidence/decision score in [0, 1] governed by scores.scoreCalibrationStatus */
  readonly confidence: number;
  readonly uncertaintyState: SpeechEventUncertaintyState;
  readonly scores: SpeechEventScoreBreakdown;
  readonly provenance: SpeechEventProvenance;
  readonly eligibleForEditSuggestion: boolean;
  readonly requiresHumanReview: boolean;
  /** Explicit safeguard stating observable speech pattern only, never medical diagnosis */
  readonly nonMedicalNotice?: string;
  readonly explanationFa: string;
}

export type TimelineSuggestionClass =
  | 'REMOVE_FILLER'
  | 'SHORTEN_SILENCE'
  | 'REMOVE_ACCIDENTAL_REPETITION'
  | 'REVIEW_FALSE_START'
  | 'REVIEW_SELF_CORRECTION'
  | 'REVIEW_BREATH'
  | 'REVIEW_NON_VERBAL_EVENT'
  | 'NO_EDIT_RECOMMENDED';

export type SuggestionRiskClassification = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SpeechEditSuggestion {
  readonly suggestionId: string;
  readonly suggestionClass: TimelineSuggestionClass;
  readonly suggestedOperation: string;
  readonly sourceEventId: string;
  readonly trackId: string;
  readonly originalStartSec: number;
  readonly originalEndSec: number;
  readonly originalRangeFlicks: FlickRange;
  readonly proposedStartSec: number;
  readonly proposedEndSec: number;
  readonly proposedRangeFlicks: FlickRange;
  readonly reason: string;
  readonly reasonFa: string;
  readonly evidenceSummary: string;
  readonly confidence: number;
  readonly scoreCalibrationStatus: ScoreCalibrationStatus;
  readonly riskClassification: SuggestionRiskClassification;
  readonly requiresHumanReview: boolean;
  readonly reversible: true;
  readonly autoApplyPermitted: false;
  readonly recommendedMode: RecommendationActionMode | 'no-op-review';
  readonly boundary?: ProsodicBoundaryDetail;
}

export interface SpeechAnalysisThresholdConfig {
  readonly version: string;
  /** Confidence thresholds for precision-oriented suggestion eligibility */
  readonly highConfidenceDeletionThreshold: number;
  readonly mediumConfidenceReviewThreshold: number;
  readonly lowConfidenceInformationalCeiling: number;
  /** Adaptive silence parameters */
  readonly silenceFrameMs: number;
  readonly silenceHopMs: number;
  readonly silenceEnterMarginDb: number;
  readonly silenceExitHysteresisDb: number;
  readonly silenceBoundaryPaddingMs: number;
  readonly naturalShortPauseMaxMs: number;
  readonly sentenceBoundaryPauseMaxMs: number;
  readonly midClauseHesitationMinMs: number;
  readonly longSilenceMinMs: number;
  readonly recordingGapMinMs: number;
  readonly digitalZeroPeakCeiling: number;
  readonly whisperProtectionZcrThreshold: number;
  /** Windowing & memory safety */
  readonly analysisWindowSec: number;
  readonly maxBufferedEvents: number;
  /** Prosody thresholds */
  readonly relativeFastPaceRatio: number;
  readonly relativeSlowPaceRatio: number;
  readonly abruptPaceChangeRatio: number;
  readonly longUninterruptedSpeechMinSec: number;
  /** Optional empirical calibration map (category -> scale/bias), null if uncalibrated */
  readonly empiricalCalibration?: Readonly<
    Partial<Record<SpeechEventCategory, { readonly slope: number; readonly intercept: number }>>
  > | null;
}

export const DEFAULT_SPEECH_EVENT_THRESHOLDS_V1: SpeechAnalysisThresholdConfig = {
  version: SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
  highConfidenceDeletionThreshold: 0.82,
  mediumConfidenceReviewThreshold: 0.58,
  lowConfidenceInformationalCeiling: 0.57,
  silenceFrameMs: 20,
  silenceHopMs: 10,
  silenceEnterMarginDb: 6.0,
  silenceExitHysteresisDb: 9.5,
  silenceBoundaryPaddingMs: 60,
  naturalShortPauseMaxMs: 420,
  sentenceBoundaryPauseMaxMs: 950,
  midClauseHesitationMinMs: 450,
  longSilenceMinMs: 950,
  recordingGapMinMs: 3000,
  digitalZeroPeakCeiling: 1e-6,
  whisperProtectionZcrThreshold: 0.08,
  analysisWindowSec: 15,
  maxBufferedEvents: 4000,
  relativeFastPaceRatio: 1.32,
  relativeSlowPaceRatio: 0.72,
  abruptPaceChangeRatio: 0.35,
  longUninterruptedSpeechMinSec: 12.0,
  empiricalCalibration: null,
};

export type SpeechEditSensitivityPreset = 'CONSERVATIVE' | 'BALANCED' | 'SENSITIVE';

export function createSpeechAnalysisThresholdConfig(options?: {
  readonly preset?: SpeechEditSensitivityPreset;
  readonly overrides?: Partial<Omit<SpeechAnalysisThresholdConfig, 'version'>>;
}): SpeechAnalysisThresholdConfig {
  const preset = options?.preset ?? 'BALANCED';
  const base = DEFAULT_SPEECH_EVENT_THRESHOLDS_V1;
  const presetOverrides: Partial<SpeechAnalysisThresholdConfig> =
    preset === 'CONSERVATIVE'
      ? {
          highConfidenceDeletionThreshold: 0.88,
          mediumConfidenceReviewThreshold: 0.65,
          lowConfidenceInformationalCeiling: 0.64,
          naturalShortPauseMaxMs: 550,
          sentenceBoundaryPauseMaxMs: 1200,
          midClauseHesitationMinMs: 650,
          longSilenceMinMs: 1250,
          silenceBoundaryPaddingMs: 80,
        }
      : preset === 'SENSITIVE'
        ? {
            highConfidenceDeletionThreshold: 0.76,
            mediumConfidenceReviewThreshold: 0.50,
            lowConfidenceInformationalCeiling: 0.49,
            naturalShortPauseMaxMs: 320,
            sentenceBoundaryPauseMaxMs: 750,
            midClauseHesitationMinMs: 350,
            longSilenceMinMs: 750,
            silenceBoundaryPaddingMs: 45,
          }
        : {};

  return {
    ...base,
    ...presetOverrides,
    ...(options?.overrides ?? {}),
    version: options?.overrides
      ? `${SPEECH_EVENT_THRESHOLD_CONFIG_VERSION}:${preset.toLowerCase()}+custom`
      : `${SPEECH_EVENT_THRESHOLD_CONFIG_VERSION}:${preset.toLowerCase()}`,
  };
}

export interface AnnotatedSpeechEventReference {
  readonly referenceId: string;
  readonly category: SpeechEventCategory;
  readonly startSec: number;
  readonly endSec: number;
  readonly annotatorId: string;
  readonly speechStyle?: string;
  readonly noiseCondition?: string;
}

export interface CategoryEvaluationMetrics {
  readonly category: SpeechEventCategory;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface SpeechEventEvaluationReport {
  readonly status: 'EVALUATED' | 'UNAVAILABLE_NO_ANNOTATED_REFERENCE';
  readonly evidenceClassification:
    | 'SYNTHETIC_DIAGNOSTIC'
    | 'REAL_ANNOTATED_AUDIO'
    | 'UNAVAILABLE';
  readonly matchPolicy: {
    readonly minTemporalIou: number;
    readonly allowCategoryAliasMatch: boolean;
  };
  readonly totalAudioMinutes: number;
  readonly referenceCount: number;
  readonly predictedCount: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly classificationAccuracyAmongMatched: number;
  readonly falsePositiveRate: number;
  readonly falseNegativeRate: number;
  readonly falsePositivesPerMinute: number;
  readonly missedEventsPerMinute: number;
  readonly meanTemporalIou: number;
  readonly meanStartBoundaryErrorMs: number;
  readonly meanEndBoundaryErrorMs: number;
  readonly meanDurationErrorMs: number;
  readonly perCategory: readonly CategoryEvaluationMetrics[];
  readonly limitationsNote: string;
}
