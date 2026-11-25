/**
 * SHAHAB-025 — Acoustic Forced Alignment, Word-Level Timing & Sample-Accurate Synchronization
 *
 * Strictly decoupled from ASR decoding (SHAHAB-005..021).
 *
 * Epistemic & Engineering Invariants:
 * 1. NEVER fabricates evenly distributed / proportional word timestamps from segment duration.
 * 2. Explicitly separates transcript source layers (`RAW_ACOUSTIC`, `CONTEXT_ASSISTED`,
 *    `VERBATIM`, `NORMALIZED`, `USER_EDITED`, `AUTHORIZED_FINAL`) and NEVER mutates the input text.
 * 3. Reversible Persian alignment text preparation preserves original surface spans, ZWNJ,
 *    compound structure, mixed Latin/Persian, and marks non-acoustic punctuation without
 *    assigning fake acoustic durations.
 * 4. Integer half-open sample intervals `[startSample, endSample)` with explicit sample rate,
 *    source offset, resampling lineage, and exact Avapardaz flick conversion (705,600,000 flicks/sec).
 * 5. Active ASR model (`ramin-mahmoodi/persian-zipformer-asr` rev `0408facbcf3f670121def48e0802c395c225d150`)
 *    is an RNN-T (`pruned_transducer_stateless7`) model with 40ms frame stride — its emission
 *    frames are NOT exact phoneme-level word onsets/offsets. Without a dedicated CTC/phoneme
 *    forced-aligner checkpoint on disk, exact word-level phoneme alignment is honestly reported
 *    as `ALIGNMENT_PARTIALLY_SUPPORTED` / `SEPARATE_ALIGNER_REQUIRED`.
 * 6. Real CTC Viterbi alignment (`runCtcViterbiBackend`) IS supported whenever true frame-level
 *    CTC log-probabilities are supplied via the pluggable `ShahabCtcLogProbProvider` interface.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PersianCtcForcedAligner } from '../ai-engine/PersianCtcForcedAligner.ts';

export const SHAHAB_ACTIVE_MODEL_ID = 'ramin-mahmoodi/persian-zipformer-asr';
export const SHAHAB_ACTIVE_MODEL_REVISION = '0408facbcf3f670121def48e0802c395c225d150';
export const SHAHAB_ALIGNMENT_CONTRACT_VERSION = '1.0.0';
export const SHAHAB_ALIGNMENT_NORMALIZATION_POLICY_VERSION = 'persian-align-norm-1.0.0';
export const FLICKS_PER_SECOND = 705_600_000;

export type AlignmentCapabilityStatus =
  | 'WORD_ALIGNMENT_SUPPORTED'
  | 'ALIGNMENT_PARTIALLY_SUPPORTED'
  | 'SEPARATE_ALIGNER_REQUIRED'
  | 'ALIGNMENT_BLOCKED';

export type AlignmentGranularity =
  | 'WORD_LEVEL'
  | 'TOKEN_LEVEL'
  | 'PHRASE_LEVEL'
  | 'SEGMENT_LEVEL'
  | 'TIMING_UNAVAILABLE';

export type AlignmentTranscriptLayer =
  | 'RAW_ACOUSTIC'
  | 'CONTEXT_ASSISTED'
  | 'VERBATIM'
  | 'NORMALIZED'
  | 'USER_EDITED'
  | 'AUTHORIZED_FINAL';

export type AlignmentItemStatus =
  | 'ALIGNED'
  | 'PARTIALLY_ALIGNED'
  | 'UNALIGNED'
  | 'AMBIGUOUS'
  | 'OUT_OF_AUDIO_RANGE'
  | 'TRANSCRIPT_MISMATCH_SUSPECTED'
  | 'ALIGNMENT_FAILED'
  | 'TIMING_UNAVAILABLE';

export type AlignmentJobState =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'DISPOSED';

export type AlignmentBackendMode =
  | 'CTC_VITERBI_LOGPROBS'
  | 'TRANSDUCER_TOKEN_EMISSION_LATTICE'
  | 'ACOUSTIC_VAD_ANCHORED_SEGMENT'
  | 'TIMING_UNAVAILABLE_NO_ACOUSTIC_EVIDENCE';

export interface AlignmentMethodEvaluation {
  readonly methodId: string;
  readonly name: string;
  readonly architecture: string;
  readonly supportedGranularity: AlignmentGranularity;
  readonly pros: readonly string[];
  readonly cons: readonly string[];
  readonly persianReadiness: 'VERIFIED_IF_CHECKPOINT_PRESENT' | 'PARTIAL_EMISSION_DELAY' | 'REQUIRES_EXTERNAL_PHONEME_MODEL' | 'REJECTED_FABRICATION';
  readonly diskAssetAvailable: boolean;
  readonly selectionStatus: 'ACTIVE_PRIMARY_WHEN_LOGPROBS_PROVIDED' | 'ACTIVE_FALLBACK_HONEST_SEGMENT' | 'RECOMMENDED_NEXT_ACQUISITION' | 'REJECTED';
}

export interface AlignmentCapabilityReport {
  readonly contractVersion: string;
  readonly inspectedAtUtc: string;
  readonly activeAsrModelId: string;
  readonly activeAsrModelRevision: string;
  readonly activeAsrArchitecture: string;
  readonly activeAsrFrameStrideMs: number;
  readonly activeModelTokensPresentOnDisk: boolean;
  readonly activeModelOnnxWeightsPresentOnDisk: boolean;
  readonly dedicatedCtcAlignerWeightsPresentOnDisk: boolean;
  readonly capabilityStatus: AlignmentCapabilityStatus;
  readonly supportedGranularities: readonly AlignmentGranularity[];
  readonly verifiedWordLevelPhonemeAlignment: boolean;
  readonly proportionalTimestampFabricationBlocked: true;
  readonly supportedBackends: readonly AlignmentBackendMode[];
  readonly methodEvaluationMatrix: readonly AlignmentMethodEvaluation[];
  readonly limitations: readonly string[];
  readonly recommendedNextStep: string;
}

export interface PreparedAlignmentToken {
  readonly tokenIndex: number;
  readonly originalSurface: string;
  readonly normalizedForm: string;
  readonly originalCharStart: number;
  readonly originalCharEnd: number;
  readonly tokenKind:
    | 'PERSIAN_WORD'
    | 'PERSIAN_COMPOUND_ZWNJ'
    | 'LATIN_WORD'
    | 'MIXED_SCRIPT'
    | 'NUMERIC_LITERAL'
    | 'NON_ACOUSTIC_PUNCTUATION';
  readonly containsZwnj: boolean;
  readonly requiresSpokenExpansion: boolean;
  readonly acousticAlignable: boolean;
  readonly attachedToTokenIndex: number | null;
}

export interface PreparedPersianAlignmentText {
  readonly policyVersion: string;
  readonly originalText: string;
  readonly originalTextSha256: string;
  readonly normalizedAlignableText: string;
  readonly tokens: readonly PreparedAlignmentToken[];
  readonly alignableTokens: readonly PreparedAlignmentToken[];
  readonly punctuationTokens: readonly PreparedAlignmentToken[];
  readonly numericRiskCount: number;
  readonly zwnjCompoundCount: number;
  readonly mixedScriptCount: number;
  readonly reversibleVerified: boolean;
}

export interface SampleInterval {
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRateHz: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationMs: number;
  readonly startFlicks: number;
  readonly endFlicks: number;
}

export interface ResamplingLineage {
  readonly originalSampleRateHz: number;
  readonly processingSampleRateHz: number;
  readonly resampled: boolean;
  readonly mappingFormula: string;
  readonly sourceOffsetSample: number;
}

export interface AlignedWordRecord {
  readonly wordId: string;
  readonly tokenIndex: number;
  readonly originalSurface: string;
  readonly normalizedForm: string;
  readonly originalCharStart: number;
  readonly originalCharEnd: number;
  readonly tokenKind: PreparedAlignmentToken['tokenKind'];
  readonly status: AlignmentItemStatus;
  readonly granularity: AlignmentGranularity;
  readonly acousticRange: SampleInterval | null;
  readonly sourceRange: SampleInterval | null;
  readonly trailingPunctuation: readonly string[];
  /** Raw acoustic log-likelihood / frame score — explicitly NOT a calibrated probability */
  readonly rawAcousticScore: number | null;
  readonly rawScoreCalibrationState: 'UNCALIBRATED_RAW_MODEL_SCORE' | 'NOT_AVAILABLE';
  readonly notes: string;
}

export interface AlignedSegmentRecord {
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly text: string;
  readonly originalCharStart: number;
  readonly originalCharEnd: number;
  readonly status: AlignmentItemStatus;
  readonly granularity: AlignmentGranularity;
  readonly acousticRange: SampleInterval | null;
  readonly sourceRange: SampleInterval | null;
  readonly wordIds: readonly string[];
  readonly alignedWordCount: number;
  readonly unalignedWordCount: number;
  readonly notes: string;
}

export interface UnmatchedRegion {
  readonly regionType: 'UNMATCHED_AUDIO_SPEECH_REGION' | 'UNMATCHED_TRANSCRIPT_SPAN';
  readonly audioRange: SampleInterval | null;
  readonly transcriptCharStart: number | null;
  readonly transcriptCharEnd: number | null;
  readonly transcriptExcerpt: string | null;
  readonly reason: string;
}

export interface CtcLogProbEvidence {
  readonly logProbsPerFrame: readonly Float32Array[];
  readonly frameStrideSec: number;
  readonly blankId: number;
  readonly charToVocabId: ReadonlyMap<string, number>;
  readonly modelId: string;
  readonly modelRevision: string;
}

export interface TransducerEmissionEvidence {
  readonly emissions: readonly {
    readonly tokenText: string;
    readonly frameIndex: number;
    readonly rawLogProb?: number;
  }[];
  readonly frameStrideSec: number;
  readonly modelId: string;
  readonly modelRevision: string;
}

export interface AlignmentRequestInput {
  readonly requestId?: string;
  readonly audioId: string;
  readonly audioSamples: Float32Array;
  readonly sampleRateHz: number;
  readonly originalSampleRateHz?: number;
  readonly sourceOffsetSample?: number;
  readonly audioSha256?: string;
  readonly transcriptText: string;
  readonly transcriptRevisionId: string;
  readonly transcriptLayer: AlignmentTranscriptLayer;
  readonly ctcEvidence?: CtcLogProbEvidence;
  readonly transducerEvidence?: TransducerEmissionEvidence;
  readonly allowCache?: boolean;
}

export interface AlignmentCacheKeyParts {
  readonly audioSha256: string;
  readonly sampleRange: string;
  readonly transcriptSha256: string;
  readonly transcriptRevisionId: string;
  readonly transcriptLayer: AlignmentTranscriptLayer;
  readonly alignerId: string;
  readonly alignerRevision: string;
  readonly normalizationPolicyVersion: string;
  readonly contractVersion: string;
}

export interface AlignmentInvariantCheck {
  readonly passed: boolean;
  readonly monotonicOrderVerified: boolean;
  readonly nonNegativeDurationVerified: boolean;
  readonly withinAudioBoundsVerified: boolean;
  readonly inputTranscriptUnmodifiedVerified: boolean;
  readonly noFabricatedUniformWordSplitVerified: boolean;
  readonly violations: readonly string[];
}

export interface AlignmentResult {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly audioId: string;
  readonly audioSha256: string;
  readonly transcriptRevisionId: string;
  readonly transcriptLayer: AlignmentTranscriptLayer;
  readonly originalTranscriptText: string;
  readonly preparedText: PreparedPersianAlignmentText;
  readonly backendMode: AlignmentBackendMode;
  readonly alignerId: string;
  readonly alignerRevision: string;
  readonly effectiveGranularity: AlignmentGranularity;
  readonly overallStatus: AlignmentItemStatus;
  readonly resamplingLineage: ResamplingLineage;
  readonly audioDurationSec: number;
  readonly totalAudioSamples: number;
  readonly segments: readonly AlignedSegmentRecord[];
  readonly words: readonly AlignedWordRecord[];
  readonly unmatchedRegions: readonly UnmatchedRegion[];
  readonly mismatchSuspected: boolean;
  readonly mismatchReasons: readonly string[];
  readonly coverage: {
    readonly alignableWordCount: number;
    readonly alignedWordCount: number;
    readonly unalignedWordCount: number;
    readonly alignedSegmentCount: number;
    readonly totalSegmentCount: number;
    readonly wordCoverageRatio: number;
    readonly segmentCoverageRatio: number;
    readonly coverageIsNotAccuracyNotice: string;
  };
  readonly cacheHit: boolean;
  readonly cacheKey: string;
  readonly invariantCheck: AlignmentInvariantCheck;
  readonly latencyMs: number;
  readonly createdAtUtc: string;
}

export interface AlignmentInvalidationEvent {
  readonly eventId: string;
  readonly timestampUtc: string;
  readonly reason: 'TRANSCRIPT_REVISION_CHANGED' | 'AUDIO_CHANGED' | 'ALIGNER_VERSION_CHANGED' | 'MANUAL_INVALIDATION';
  readonly affectedKeysCount: number;
  readonly detail: string;
}

export interface AlignmentReferenceWord {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface AlignmentEvaluationMetrics {
  readonly datasetLabel: string;
  readonly evaluationSource: 'SYNTHETIC_CONTROLLED_CTC_FIXTURE' | 'HUMAN_ANNOTATED_PERSIAN_GOLD' | 'NO_REFERENCE_AVAILABLE';
  readonly evaluatedWordCount: number;
  readonly alignedWordCount: number;
  readonly unalignedWordCount: number;
  readonly coverageRatio: number;
  readonly onsetMaeMs: number | null;
  readonly offsetMaeMs: number | null;
  readonly boundaryMaeMs: number | null;
  readonly boundaryMedianAbsErrorMs: number | null;
  readonly boundaryP90AbsErrorMs: number | null;
  readonly boundaryP95AbsErrorMs: number | null;
  readonly overlapCount: number;
  readonly outOfOrderCount: number;
  readonly coverageVsAccuracyWarning: string;
}

export type PersianAlignmentEvalCategory =
  | 'CLEAN_STUDIO'
  | 'COLLOQUIAL_CONVERSATIONAL'
  | 'FAST_SPEECH'
  | 'SLOW_DELIBERATE'
  | 'NOISY_REVERBERANT'
  | 'LONG_RECORDING'
  | 'HEAVY_PUNCTUATION'
  | 'PERSIAN_COMPOUNDS_ZWNJ'
  | 'MIXED_PERSIAN_ENGLISH'
  | 'NUMBERS_DATES'
  | 'USER_EDITED_TRANSCRIPT'
  | 'PARTIAL_MISMATCH_AUDIO'
  | 'SILENCE_AND_NON_SPEECH';

export const PERSIAN_ALIGNMENT_EVAL_CATEGORIES: readonly PersianAlignmentEvalCategory[] = [
  'CLEAN_STUDIO',
  'COLLOQUIAL_CONVERSATIONAL',
  'FAST_SPEECH',
  'SLOW_DELIBERATE',
  'NOISY_REVERBERANT',
  'LONG_RECORDING',
  'HEAVY_PUNCTUATION',
  'PERSIAN_COMPOUNDS_ZWNJ',
  'MIXED_PERSIAN_ENGLISH',
  'NUMBERS_DATES',
  'USER_EDITED_TRANSCRIPT',
  'PARTIAL_MISMATCH_AUDIO',
  'SILENCE_AND_NON_SPEECH',
];

const PERSIAN_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_CHAR_RE = /[A-Za-z]/;
const DIGIT_CHAR_RE = /[0-9\u06F0-\u06F9\u0660-\u0669]/;
const PUNCTUATION_ONLY_RE = /^[\p{P}\p{S}«»؟،؛…ـ]+$/u;
const ZWNJ = '\u200c';

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hashFloat32Pcm(samples: Float32Array): string {
  const view = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return sha256Hex(view);
}

/**
 * Exact half-open integer sample interval builder `[startSample, endSample)`
 * with exact integer flick conversion (`705,600,000` flicks/sec).
 */
export function samplesToFlicks(samples: number, sampleRateHz: number): number {
  const safeRate = Math.max(1, Math.round(sampleRateHz));
  return Math.round((samples / safeRate) * FLICKS_PER_SECOND);
}

export function buildSampleInterval(
  startSample: number,
  endSample: number,
  sampleRateHz: number,
): SampleInterval {
  const safeRate = Math.max(1, Math.round(sampleRateHz));
  const s = Math.max(0, Math.round(startSample));
  const e = Math.max(s, Math.round(endSample));
  const startSec = s / safeRate;
  const endSec = e / safeRate;
  const durationMs = Number((((e - s) / safeRate) * 1000).toFixed(3));
  const startFlicks = Math.round((s / safeRate) * FLICKS_PER_SECOND);
  const endFlicks = Math.round((e / safeRate) * FLICKS_PER_SECOND);
  return {
    startSample: s,
    endSample: e,
    sampleRateHz: safeRate,
    startSec: Number(startSec.toFixed(6)),
    endSec: Number(endSec.toFixed(6)),
    durationMs,
    startFlicks,
    endFlicks,
  };
}

export function mapProcessingIntervalToSource(
  procInterval: SampleInterval,
  lineage: ResamplingLineage,
): SampleInterval {
  const ratio = lineage.originalSampleRateHz / lineage.processingSampleRateHz;
  const srcStart = lineage.sourceOffsetSample + Math.round(procInterval.startSample * ratio);
  const srcEnd = lineage.sourceOffsetSample + Math.round(procInterval.endSample * ratio);
  return buildSampleInterval(srcStart, Math.max(srcStart, srcEnd), lineage.originalSampleRateHz);
}

/**
 * Entry Gate Capability Inspection (SHAHAB-025 §2 & §6).
 * Inspects actual on-disk artifacts without inventing model capabilities.
 */
export function inspectAlignmentCapabilities(workspaceRoot = process.cwd()): AlignmentCapabilityReport {
  const modelDir = path.join(workspaceRoot, 'models', 'persian-zipformer-transducer', '1.0.0');
  const tokensPresent = fs.existsSync(path.join(modelDir, 'tokens.txt'));
  const encoderPresent = fs.existsSync(path.join(modelDir, 'encoder.int8.onnx'));
  const decoderPresent = fs.existsSync(path.join(modelDir, 'decoder.int8.onnx'));
  const joinerPresent = fs.existsSync(path.join(modelDir, 'joiner.int8.onnx'));
  const onnxWeightsPresent = encoderPresent && decoderPresent && joinerPresent;

  // Check if any dedicated Persian CTC / phoneme forced aligner model exists on disk
  const dedicatedCtcDir = path.join(workspaceRoot, 'models', 'persian-ctc-aligner');
  const dedicatedCtcPresent =
    fs.existsSync(dedicatedCtcDir) &&
    fs.readdirSync(dedicatedCtcDir).some((f) => f.endsWith('.onnx'));

  const methodEvaluationMatrix: AlignmentMethodEvaluation[] = [
    {
      methodId: 'ctc-viterbi-forced-alignment',
      name: 'CTC Frame-Posterior Viterbi Forced Alignment (Log-Domain)',
      architecture: 'Wav2Vec2-CTC / Conformer-CTC / MMS-FA + Log-Domain Viterbi Trellis',
      supportedGranularity: 'WORD_LEVEL',
      pros: [
        'True acoustic frame-to-character Viterbi alignment with mathematically verifiable monotonicity',
        'No emission-delay bias typical of causal RNN-T transducers',
        'Reuses pure TypeScript log-domain aligner already implemented in SHAHAB workspace',
      ],
      cons: [
        'Requires a verified Persian CTC acoustic model checkpoint (.onnx) not yet bundled on disk',
        'Sensitive to unexpanded numeric literals unless spoken-form normalization is provided',
      ],
      persianReadiness: 'VERIFIED_IF_CHECKPOINT_PRESENT',
      diskAssetAvailable: dedicatedCtcPresent,
      selectionStatus: dedicatedCtcPresent
        ? 'ACTIVE_PRIMARY_WHEN_LOGPROBS_PROVIDED'
        : 'RECOMMENDED_NEXT_ACQUISITION',
    },
    {
      methodId: 'rnnt-transducer-token-lattice',
      name: 'Active Zipformer-Transducer Emission Frame Mapping',
      architecture: 'pruned_transducer_stateless7 (40ms frame stride, 1024 BPE)',
      supportedGranularity: 'TOKEN_LEVEL',
      pros: [
        'Uses active SHAHAB ASR model family directly without a second runtime',
        'Provides monotonic BPE emission frame indices at 40ms granularity',
      ],
      cons: [
        'RNN-T emission frames reflect decoder emission time (lookahead delay), NOT exact phoneme onset/offset',
        '40ms frame stride limits sub-frame precision; ONNX weights currently absent from container snapshot',
      ],
      persianReadiness: 'PARTIAL_EMISSION_DELAY',
      diskAssetAvailable: onnxWeightsPresent,
      selectionStatus: 'ACTIVE_PRIMARY_WHEN_LOGPROBS_PROVIDED',
    },
    {
      methodId: 'acoustic-vad-segment-anchoring',
      name: 'Acoustic Signal VAD Speech-Region Anchoring (Honest Segment-Level)',
      architecture: 'Deterministic 20ms RMS + Spectral-Flatness Speech Activity Anchoring',
      supportedGranularity: 'SEGMENT_LEVEL',
      pros: [
        'Zero external weight dependency; operates on real PCM signal energy/spectrum',
        'Detects silent/mismatched audio and anchors real speech spans honestly at segment granularity',
        'Refuses to fabricate word-level timestamps when acoustic word evidence is absent',
      ],
      cons: [
        'Cannot resolve word-level acoustic boundaries inside continuous speech',
        'Words inside anchored segments remain explicitly TIMING_UNAVAILABLE',
      ],
      persianReadiness: 'PARTIAL_EMISSION_DELAY',
      diskAssetAvailable: true,
      selectionStatus: 'ACTIVE_FALLBACK_HONEST_SEGMENT',
    },
    {
      methodId: 'phoneme-mfa-persian',
      name: 'Phoneme-Level Forced Alignment (Persian G2P + MFA / Kaldi)',
      architecture: 'Persian Grapheme-to-Phoneme + Acoustic Triphone/HMM-DNN Forced Aligner',
      supportedGranularity: 'WORD_LEVEL',
      pros: [
        'Highest theoretical phoneme/word onset accuracy when backed by a Persian lexicon + G2P',
      ],
      cons: [
        'Requires native Kaldi/MFA toolchain + verified Persian pronunciation dictionary (heavy footprint)',
        'Out-of-vocabulary colloquial Persian forms require robust G2P rules',
      ],
      persianReadiness: 'REQUIRES_EXTERNAL_PHONEME_MODEL',
      diskAssetAvailable: false,
      selectionStatus: 'RECOMMENDED_NEXT_ACQUISITION',
    },
    {
      methodId: 'uniform-proportional-split',
      name: 'Evenly Distributed / Character-Proportional Word Timing',
      architecture: 'Heuristic text-length division over segment duration',
      supportedGranularity: 'TIMING_UNAVAILABLE',
      pros: ['Trivial computation'],
      cons: [
        'Fabricates fake acoustic timing — strictly PROHIBITED by SHAHAB-025 §18',
        'Breaks on pauses, elongated vowels, fast/slow speech rate changes, and silent padding',
      ],
      persianReadiness: 'REJECTED_FABRICATION',
      diskAssetAvailable: false,
      selectionStatus: 'REJECTED',
    },
  ];

  const capabilityStatus: AlignmentCapabilityStatus = dedicatedCtcPresent
    ? 'WORD_ALIGNMENT_SUPPORTED'
    : 'ALIGNMENT_PARTIALLY_SUPPORTED';

  return {
    contractVersion: SHAHAB_ALIGNMENT_CONTRACT_VERSION,
    inspectedAtUtc: new Date().toISOString(),
    activeAsrModelId: SHAHAB_ACTIVE_MODEL_ID,
    activeAsrModelRevision: SHAHAB_ACTIVE_MODEL_REVISION,
    activeAsrArchitecture: 'zipformer2 pruned_transducer_stateless7 (RNN-T, 1024 BPE)',
    activeAsrFrameStrideMs: 40,
    activeModelTokensPresentOnDisk: tokensPresent,
    activeModelOnnxWeightsPresentOnDisk: onnxWeightsPresent,
    dedicatedCtcAlignerWeightsPresentOnDisk: dedicatedCtcPresent,
    capabilityStatus,
    supportedGranularities: dedicatedCtcPresent
      ? ['WORD_LEVEL', 'TOKEN_LEVEL', 'SEGMENT_LEVEL', 'TIMING_UNAVAILABLE']
      : ['SEGMENT_LEVEL', 'TOKEN_LEVEL', 'TIMING_UNAVAILABLE'],
    verifiedWordLevelPhonemeAlignment: dedicatedCtcPresent,
    proportionalTimestampFabricationBlocked: true,
    supportedBackends: [
      'CTC_VITERBI_LOGPROBS',
      'TRANSDUCER_TOKEN_EMISSION_LATTICE',
      'ACOUSTIC_VAD_ANCHORED_SEGMENT',
      'TIMING_UNAVAILABLE_NO_ACOUSTIC_EVIDENCE',
    ],
    methodEvaluationMatrix,
    limitations: [
      'Active SHAHAB ASR model is an RNN-T transducer (40ms frame stride); emission frames are decoder emission times, not exact acoustic phoneme boundaries.',
      'No standalone Persian CTC/phoneme forced-alignment ONNX checkpoint is bundled in models/persian-ctc-aligner/; SEPARATE_ALIGNER_REQUIRED for production phoneme-exact word timing.',
      'No human-annotated Persian word-boundary ground-truth dataset is bundled in the workspace; real-world Persian word-boundary MAE remains NOT_MEASURED until gold annotations are ingested.',
      'When only PCM audio + transcript are supplied without CTC log-probs or transducer emission frames, SHAHAB-025 anchors real speech segments via acoustic VAD and leaves internal words honestly TIMING_UNAVAILABLE (never fabricating proportional splits).',
    ],
    recommendedNextStep:
      'Acquire a permissively licensed Persian/multilingual CTC acoustic model (e.g. Wav2Vec2-CTC / MMS-FA ONNX) and evaluate boundary MAE/P95 against a human-annotated Persian forced-alignment corpus.',
  };
}

/**
 * Normalizes a single Persian/mixed token for acoustic matching while preserving
 * ZWNJ awareness and never mutating the original transcript surface form.
 */
function normalizeTokenForAlignment(surface: string): string {
  return surface
    .replace(/\u064A/g, '\u06CC') // Arabic Yeh -> Persian Yeh
    .replace(/\u0649/g, '\u06CC') // Alef Maksura -> Persian Yeh
    .replace(/\u0643/g, '\u06A9') // Arabic Kaf -> Persian Kaf
    .replace(/\u0622/g, 'آ')
    .replace(/[\u0623\u0625]/g, 'ا')
    .replace(/[\u064B-\u065F\u0670]/g, '') // Strip diacritics for alignment only (reversible)
    .replace(/\u0640/g, '') // Strip Tatweel/Kashida
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // Strip invisible bidi controls
    .trim()
    .toLowerCase();
}

function classifyTokenKind(surface: string): PreparedAlignmentToken['tokenKind'] {
  if (PUNCTUATION_ONLY_RE.test(surface)) {
    return 'NON_ACOUSTIC_PUNCTUATION';
  }
  const withoutDigits = surface.replace(/[0-9\u06F0-\u06F9\u0660-\u0669]/g, '');
  const hasPersian = PERSIAN_CHAR_RE.test(withoutDigits);
  const hasLatin = LATIN_CHAR_RE.test(withoutDigits);
  const hasDigit = DIGIT_CHAR_RE.test(surface);
  if (hasDigit && !hasPersian && !hasLatin) {
    return 'NUMERIC_LITERAL';
  }
  if (hasPersian && hasLatin) {
    return 'MIXED_SCRIPT';
  }
  if (hasPersian) {
    return surface.includes(ZWNJ) ? 'PERSIAN_COMPOUND_ZWNJ' : 'PERSIAN_WORD';
  }
  if (hasLatin) {
    return 'LATIN_WORD';
  }
  return 'NON_ACOUSTIC_PUNCTUATION';
}

/**
 * SHAHAB-025 §5 — Reversible Persian Text Preparation for Forced Alignment.
 * Splits surface text into character-indexed tokens (preserving ZWNJ inside Persian
 * compounds, separating punctuation as non-acoustic tokens attached to adjacent words,
 * and flagging numeric literals that require spoken-form expansion).
 */
export function preparePersianTextForAlignment(originalText: string): PreparedPersianAlignmentText {
  const originalTextSha256 = sha256Hex(originalText);
  const tokens: PreparedAlignmentToken[] = [];

  // Match either punctuation/symbol runs OR contiguous non-space non-punctuation word runs (keeping ZWNJ inside words)
  const tokenRegex = /([\p{P}\p{S}«»؟،؛…]+|[^\s\p{P}\p{S}«»؟،؛…]+)/gu;
  let match: RegExpExecArray | null;
  let lastAlignableIndex: number | null = null;

  while ((match = tokenRegex.exec(originalText)) !== null) {
    const surface = match[0];
    const start = match.index;
    const end = start + surface.length;
    const tokenKind = classifyTokenKind(surface);
    const normalizedForm = normalizeTokenForAlignment(surface);
    const acousticAlignable = tokenKind !== 'NON_ACOUSTIC_PUNCTUATION' && normalizedForm.length > 0;
    const tokenIndex = tokens.length;
    const attachedToTokenIndex =
      tokenKind === 'NON_ACOUSTIC_PUNCTUATION' ? lastAlignableIndex : null;

    tokens.push({
      tokenIndex,
      originalSurface: surface,
      normalizedForm,
      originalCharStart: start,
      originalCharEnd: end,
      tokenKind,
      containsZwnj: surface.includes(ZWNJ),
      requiresSpokenExpansion: tokenKind === 'NUMERIC_LITERAL',
      acousticAlignable,
      attachedToTokenIndex,
    });

    if (acousticAlignable) {
      lastAlignableIndex = tokenIndex;
    }
  }

  // Verify exact reversibility: every token slice matches originalText.slice(start, end)
  const reversibleVerified = tokens.every(
    (t) => originalText.slice(t.originalCharStart, t.originalCharEnd) === t.originalSurface,
  );

  const alignableTokens = tokens.filter((t) => t.acousticAlignable);
  const punctuationTokens = tokens.filter((t) => !t.acousticAlignable);

  return {
    policyVersion: SHAHAB_ALIGNMENT_NORMALIZATION_POLICY_VERSION,
    originalText,
    originalTextSha256,
    normalizedAlignableText: alignableTokens.map((t) => t.normalizedForm).join(' '),
    tokens,
    alignableTokens,
    punctuationTokens,
    numericRiskCount: alignableTokens.filter((t) => t.requiresSpokenExpansion).length,
    zwnjCompoundCount: alignableTokens.filter((t) => t.containsZwnj).length,
    mixedScriptCount: alignableTokens.filter((t) => t.tokenKind === 'MIXED_SCRIPT').length,
    reversibleVerified,
  };
}

interface SpeechActivityRegion {
  readonly startSample: number;
  readonly endSample: number;
  readonly meanRms: number;
}

/**
 * Deterministic 20ms acoustic RMS speech-activity detector operating on real PCM samples.
 * Used strictly for honest segment-level anchoring & silent/mismatch detection.
 */
export function detectAcousticSpeechRegions(
  samples: Float32Array,
  sampleRateHz: number,
): readonly SpeechActivityRegion[] {
  if (samples.length === 0 || sampleRateHz <= 0) {
    return [];
  }
  const frameLen = Math.max(1, Math.round(sampleRateHz * 0.02)); // 20ms
  const frameRms: number[] = [];
  let maxRms = 0;

  for (let i = 0; i < samples.length; i += frameLen) {
    const end = Math.min(samples.length, i + frameLen);
    let sumSq = 0;
    for (let j = i; j < end; j++) {
      const v = samples[j];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - i));
    frameRms.push(rms);
    if (rms > maxRms) maxRms = rms;
  }

  // Silence floor check (-54 dBFS ~= 0.002)
  if (maxRms < 0.002) {
    return [];
  }

  const threshold = Math.max(0.004, maxRms * 0.12);
  const rawRegions: { startFrame: number; endFrame: number; rmsSum: number; count: number }[] = [];
  let active: { startFrame: number; endFrame: number; rmsSum: number; count: number } | null = null;

  for (let f = 0; f < frameRms.length; f++) {
    if (frameRms[f] >= threshold) {
      if (!active) {
        active = { startFrame: f, endFrame: f + 1, rmsSum: frameRms[f], count: 1 };
      } else {
        active.endFrame = f + 1;
        active.rmsSum += frameRms[f];
        active.count += 1;
      }
    } else if (active) {
      rawRegions.push(active);
      active = null;
    }
  }
  if (active) {
    rawRegions.push(active);
  }

  // Bridge micro-pauses shorter than 180ms (9 frames) so natural intra-word stops stay intact
  const merged: typeof rawRegions = [];
  for (const r of rawRegions) {
    const prev = merged[merged.length - 1];
    if (prev && r.startFrame - prev.endFrame <= 9) {
      prev.endFrame = r.endFrame;
      prev.rmsSum += r.rmsSum;
      prev.count += r.count;
    } else {
      merged.push({ ...r });
    }
  }

  return merged
    .filter((r) => (r.endFrame - r.startFrame) * frameLen >= Math.round(sampleRateHz * 0.06))
    .map((r) => ({
      startSample: r.startFrame * frameLen,
      endSample: Math.min(samples.length, r.endFrame * frameLen),
      meanRms: Number((r.rmsSum / Math.max(1, r.count)).toFixed(6)),
    }));
}

/**
 * Splits transcript text into honest sentence/clause segments while preserving
 * exact character offsets in the original transcript.
 */
function splitTranscriptIntoSentenceSpans(
  originalText: string,
): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  const spans: { text: string; start: number; end: number }[] = [];
  if (!originalText.trim()) {
    return spans;
  }

  const isDigitChar = (ch: string | undefined): boolean =>
    Boolean(ch && /[0-9\u06F0-\u06F9\u0660-\u0669]/.test(ch));

  const pushSlice = (rawStart: number, rawEnd: number) => {
    const raw = originalText.slice(rawStart, rawEnd);
    const leadWs = raw.length - raw.trimStart().length;
    const trailWs = raw.length - raw.trimEnd().length;
    const text = raw.trim();
    if (text.length > 0) {
      spans.push({
        text,
        start: rawStart + leadWs,
        end: rawEnd - trailWs,
      });
    }
  };

  let segStart = 0;
  for (let i = 0; i < originalText.length; i++) {
    const ch = originalText[i];
    if (ch === '\n') {
      pushSlice(segStart, i);
      segStart = i + 1;
      continue;
    }
    const isSentenceEnd =
      ch === '!' ||
      ch === '?' ||
      ch === '؟' ||
      ch === '؛' ||
      (ch === '.' && !(isDigitChar(originalText[i - 1]) && isDigitChar(originalText[i + 1])));

    if (isSentenceEnd) {
      // Consume consecutive closing punctuation like "..." or "?!"
      let j = i;
      while (
        j + 1 < originalText.length &&
        /[.!?؟؛]/.test(originalText[j + 1]) &&
        !(
          originalText[j + 1] === '.' &&
          isDigitChar(originalText[j]) &&
          isDigitChar(originalText[j + 2])
        )
      ) {
        j += 1;
      }
      pushSlice(segStart, j + 1);
      i = j;
      segStart = j + 1;
    }
  }
  if (segStart < originalText.length) {
    pushSlice(segStart, originalText.length);
  }
  return spans;
}

export function buildAlignmentCacheKey(parts: AlignmentCacheKeyParts): string {
  return sha256Hex(JSON.stringify(parts));
}

export function validateAlignmentInvariants(
  result: Omit<AlignmentResult, 'invariantCheck'>,
): AlignmentInvariantCheck {
  const violations: string[] = [];
  let monotonicOrderVerified = true;
  let nonNegativeDurationVerified = true;
  let withinAudioBoundsVerified = true;
  const inputTranscriptUnmodifiedVerified =
    result.preparedText.originalText === result.originalTranscriptText &&
    result.preparedText.reversibleVerified;

  let prevWordStart = -1;
  let prevWordEnd = -1;
  const alignedDurations: number[] = [];

  for (const w of result.words) {
    if (w.acousticRange) {
      if (w.acousticRange.endSample < w.acousticRange.startSample) {
        nonNegativeDurationVerified = false;
        violations.push(`Negative word duration at ${w.wordId}`);
      }
      if (
        w.acousticRange.startSample < 0 ||
        w.acousticRange.endSample > result.totalAudioSamples
      ) {
        withinAudioBoundsVerified = false;
        violations.push(`Word ${w.wordId} exceeds audio sample bounds [0, ${result.totalAudioSamples})`);
      }
      if (w.acousticRange.startSample < prevWordStart || w.acousticRange.startSample < prevWordEnd) {
        monotonicOrderVerified = false;
        violations.push(`Non-monotonic word timing at ${w.wordId}`);
      }
      prevWordStart = w.acousticRange.startSample;
      prevWordEnd = w.acousticRange.endSample;
      alignedDurations.push(w.acousticRange.endSample - w.acousticRange.startSample);
    }
  }

  let prevSegStart = -1;
  for (const s of result.segments) {
    if (s.acousticRange) {
      if (s.acousticRange.endSample < s.acousticRange.startSample) {
        nonNegativeDurationVerified = false;
        violations.push(`Negative segment duration at ${s.segmentId}`);
      }
      if (
        s.acousticRange.startSample < 0 ||
        s.acousticRange.endSample > result.totalAudioSamples
      ) {
        withinAudioBoundsVerified = false;
        violations.push(`Segment ${s.segmentId} exceeds audio bounds`);
      }
      if (s.acousticRange.startSample < prevSegStart) {
        monotonicOrderVerified = false;
        violations.push(`Non-monotonic segment timing at ${s.segmentId}`);
      }
      prevSegStart = s.acousticRange.startSample;
    }
  }

  // Guard: Segment-level fallback MUST never emit word-level acousticRange!
  const noFabricatedUniformWordSplitVerified =
    result.backendMode === 'ACOUSTIC_VAD_ANCHORED_SEGMENT' ||
    result.backendMode === 'TIMING_UNAVAILABLE_NO_ACOUSTIC_EVIDENCE'
      ? result.words.every((w) => w.acousticRange === null)
      : true;

  if (!noFabricatedUniformWordSplitVerified) {
    violations.push('POLICY_VIOLATION: Segment-only backend emitted word-level timestamps.');
  }

  return {
    passed:
      monotonicOrderVerified &&
      nonNegativeDurationVerified &&
      withinAudioBoundsVerified &&
      inputTranscriptUnmodifiedVerified &&
      noFabricatedUniformWordSplitVerified &&
      violations.length === 0,
    monotonicOrderVerified,
    nonNegativeDurationVerified,
    withinAudioBoundsVerified,
    inputTranscriptUnmodifiedVerified,
    noFabricatedUniformWordSplitVerified,
    violations,
  };
}

/**
 * Evaluates alignment result against ground-truth word boundaries (SHAHAB-025 §10).
 * Explicitly separates coverage from boundary error (MAE/Median/P90/P95).
 */
export function evaluateAlignmentAgainstReference(
  result: AlignmentResult,
  referenceWords: readonly AlignmentReferenceWord[],
  datasetLabel: string,
  evaluationSource: AlignmentEvaluationMetrics['evaluationSource'],
): AlignmentEvaluationMetrics {
  const alignable = result.words.filter((w) => w.tokenKind !== 'NON_ACOUSTIC_PUNCTUATION');
  const onsetErrorsMs: number[] = [];
  const offsetErrorsMs: number[] = [];
  const combinedErrorsMs: number[] = [];

  let overlapCount = 0;
  let outOfOrderCount = 0;
  let prevStart = -1;
  let prevEnd = -1;
  let alignedCount = 0;

  const limit = Math.min(alignable.length, referenceWords.length);
  for (let i = 0; i < limit; i++) {
    const pred = alignable[i];
    const ref = referenceWords[i];
    if (pred.acousticRange && pred.status === 'ALIGNED') {
      alignedCount += 1;
      const onsetErr = Math.abs(pred.acousticRange.startSec - ref.startSec) * 1000;
      const offsetErr = Math.abs(pred.acousticRange.endSec - ref.endSec) * 1000;
      onsetErrorsMs.push(onsetErr);
      offsetErrorsMs.push(offsetErr);
      combinedErrorsMs.push(onsetErr, offsetErr);

      if (pred.acousticRange.startSec < prevStart) {
        outOfOrderCount += 1;
      }
      if (prevEnd >= 0 && pred.acousticRange.startSec < prevEnd - 1e-6) {
        overlapCount += 1;
      }
      prevStart = pred.acousticRange.startSec;
      prevEnd = pred.acousticRange.endSec;
    }
  }

  const percentile = (arr: readonly number[], p: number): number | null => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
    return Number(sorted[idx].toFixed(2));
  };
  const mean = (arr: readonly number[]): number | null =>
    arr.length === 0 ? null : Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));

  const denom = Math.max(1, referenceWords.length);
  return {
    datasetLabel,
    evaluationSource,
    evaluatedWordCount: referenceWords.length,
    alignedWordCount: alignedCount,
    unalignedWordCount: Math.max(0, referenceWords.length - alignedCount),
    coverageRatio: Number((alignedCount / denom).toFixed(4)),
    onsetMaeMs: mean(onsetErrorsMs),
    offsetMaeMs: mean(offsetErrorsMs),
    boundaryMaeMs: mean(combinedErrorsMs),
    boundaryMedianAbsErrorMs: percentile(combinedErrorsMs, 50),
    boundaryP90AbsErrorMs: percentile(combinedErrorsMs, 90),
    boundaryP95AbsErrorMs: percentile(combinedErrorsMs, 95),
    overlapCount,
    outOfOrderCount,
    coverageVsAccuracyWarning:
      'Coverage reports the fraction of words with assigned timing; it is NOT timing accuracy. Boundary accuracy requires onset/offset MAE and P95 against verified ground truth.',
  };
}

interface AlignmentJobRecord {
  readonly requestId: string;
  readonly input: AlignmentRequestInput;
  state: AlignmentJobState;
  result: AlignmentResult | null;
  error: string | null;
  readonly createdAtUtc: string;
  updatedAtUtc: string;
}

/**
 * SHAHAB-025 Acoustic Forced Alignment Service
 * Manages request lifecycle, cache + invalidation, and truthful backend execution.
 */
export class ShahabAlignmentEngine {
  private readonly cache = new Map<string, AlignmentResult>();
  private readonly jobs = new Map<string, AlignmentJobRecord>();
  private readonly invalidationLog: AlignmentInvalidationEvent[] = [];
  private readonly workspaceRoot: string;

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  public inspectAlignmentCapabilities(): AlignmentCapabilityReport {
    return inspectAlignmentCapabilities(this.workspaceRoot);
  }

  public createAlignmentRequest(input: AlignmentRequestInput): {
    readonly requestId: string;
    readonly state: AlignmentJobState;
    readonly createdAtUtc: string;
  } {
    const requestId =
      input.requestId ?? `align_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.jobs.set(requestId, {
      requestId,
      input,
      state: 'CREATED',
      result: null,
      error: null,
      createdAtUtc: now,
      updatedAtUtc: now,
    });
    return { requestId, state: 'CREATED', createdAtUtc: now };
  }

  public getAlignmentStatus(requestId: string): {
    readonly requestId: string;
    readonly state: AlignmentJobState;
    readonly error: string | null;
    readonly updatedAtUtc: string;
  } {
    const job = this.jobs.get(requestId);
    if (!job) {
      throw new Error(`ALIGNMENT_REQUEST_NOT_FOUND: ${requestId}`);
    }
    return {
      requestId: job.requestId,
      state: job.state,
      error: job.error,
      updatedAtUtc: job.updatedAtUtc,
    };
  }

  public getAlignmentResult(requestId: string): AlignmentResult {
    const job = this.jobs.get(requestId);
    if (!job) {
      throw new Error(`ALIGNMENT_REQUEST_NOT_FOUND: ${requestId}`);
    }
    if (job.state === 'DISPOSED') {
      throw new Error(`ALIGNMENT_REQUEST_DISPOSED: ${requestId}`);
    }
    if (job.state === 'CANCELLED') {
      throw new Error(`ALIGNMENT_REQUEST_CANCELLED: ${requestId}`);
    }
    if (!job.result) {
      throw new Error(`ALIGNMENT_RESULT_NOT_READY: ${requestId} (state=${job.state})`);
    }
    return job.result;
  }

  public cancelAlignment(requestId: string): { readonly requestId: string; readonly state: AlignmentJobState } {
    const job = this.jobs.get(requestId);
    if (!job) {
      throw new Error(`ALIGNMENT_REQUEST_NOT_FOUND: ${requestId}`);
    }
    if (job.state !== 'DISPOSED') {
      job.state = 'CANCELLED';
      job.updatedAtUtc = new Date().toISOString();
    }
    return { requestId, state: job.state };
  }

  public disposeAlignmentRequest(requestId: string): { readonly requestId: string; readonly state: AlignmentJobState } {
    const job = this.jobs.get(requestId);
    if (!job) {
      throw new Error(`ALIGNMENT_REQUEST_NOT_FOUND: ${requestId}`);
    }
    job.result = null;
    job.state = 'DISPOSED';
    job.updatedAtUtc = new Date().toISOString();
    return { requestId, state: job.state };
  }

  public invalidateCache(
    reason: AlignmentInvalidationEvent['reason'],
    predicate?: (result: AlignmentResult) => boolean,
    detail = 'Cache invalidated due to upstream input revision change',
  ): AlignmentInvalidationEvent {
    let removed = 0;
    for (const [key, res] of this.cache.entries()) {
      if (!predicate || predicate(res)) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    const evt: AlignmentInvalidationEvent = {
      eventId: `align_inv_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestampUtc: new Date().toISOString(),
      reason,
      affectedKeysCount: removed,
      detail,
    };
    this.invalidationLog.push(evt);
    return evt;
  }

  public getInvalidationHistory(): readonly AlignmentInvalidationEvent[] {
    return [...this.invalidationLog];
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  public submitAlignment(requestIdOrInput: string | AlignmentRequestInput): AlignmentResult {
    const t0 = performance.now();
    let job: AlignmentJobRecord;
    if (typeof requestIdOrInput === 'string') {
      const existing = this.jobs.get(requestIdOrInput);
      if (!existing) {
        throw new Error(`ALIGNMENT_REQUEST_NOT_FOUND: ${requestIdOrInput}`);
      }
      if (existing.state === 'CANCELLED' || existing.state === 'DISPOSED') {
        throw new Error(`ALIGNMENT_INVALID_STATE: Cannot submit ${existing.state} request ${requestIdOrInput}`);
      }
      job = existing;
    } else {
      const created = this.createAlignmentRequest(requestIdOrInput);
      job = this.jobs.get(created.requestId)!;
    }

    job.state = 'RUNNING';
    job.updatedAtUtc = new Date().toISOString();

    try {
      const result = this.executeAlignmentInternal(job.requestId, job.input, t0);
      if ((job.state as AlignmentJobState) === 'CANCELLED') {
        throw new Error(`ALIGNMENT_CANCELLED_DURING_EXECUTION: ${job.requestId}`);
      }
      job.result = result;
      job.state = 'COMPLETED';
      job.updatedAtUtc = new Date().toISOString();
      return result;
    } catch (err) {
      job.state = 'FAILED';
      job.error = err instanceof Error ? err.message : String(err);
      job.updatedAtUtc = new Date().toISOString();
      throw err;
    }
  }

  private executeAlignmentInternal(
    requestId: string,
    input: AlignmentRequestInput,
    t0: number,
  ): AlignmentResult {
    const sampleRateHz = input.sampleRateHz;
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error(`INVALID_SAMPLE_RATE: ${sampleRateHz}`);
    }
    const originalSampleRateHz = input.originalSampleRateHz ?? sampleRateHz;
    const sourceOffsetSample = Math.max(0, Math.round(input.sourceOffsetSample ?? 0));
    const totalAudioSamples = input.audioSamples.length;
    const audioDurationSec = Number((totalAudioSamples / sampleRateHz).toFixed(6));
    const audioSha256 = input.audioSha256 ?? hashFloat32Pcm(input.audioSamples);
    const preparedText = preparePersianTextForAlignment(input.transcriptText);

    const backendMode: AlignmentBackendMode = input.ctcEvidence
      ? 'CTC_VITERBI_LOGPROBS'
      : input.transducerEvidence
        ? 'TRANSDUCER_TOKEN_EMISSION_LATTICE'
        : totalAudioSamples > 0
          ? 'ACOUSTIC_VAD_ANCHORED_SEGMENT'
          : 'TIMING_UNAVAILABLE_NO_ACOUSTIC_EVIDENCE';

    const alignerId =
      backendMode === 'CTC_VITERBI_LOGPROBS'
        ? input.ctcEvidence!.modelId
        : backendMode === 'TRANSDUCER_TOKEN_EMISSION_LATTICE'
          ? input.transducerEvidence!.modelId
          : 'shahab-acoustic-vad-segment-anchorer';

    const alignerRevision =
      backendMode === 'CTC_VITERBI_LOGPROBS'
        ? input.ctcEvidence!.modelRevision
        : backendMode === 'TRANSDUCER_TOKEN_EMISSION_LATTICE'
          ? input.transducerEvidence!.modelRevision
          : '1.0.0-vad-honest-segment';

    const cacheKey = buildAlignmentCacheKey({
      audioSha256,
      sampleRange: `${sourceOffsetSample}:${totalAudioSamples}@${sampleRateHz}`,
      transcriptSha256: preparedText.originalTextSha256,
      transcriptRevisionId: input.transcriptRevisionId,
      transcriptLayer: input.transcriptLayer,
      alignerId,
      alignerRevision,
      normalizationPolicyVersion: preparedText.policyVersion,
      contractVersion: SHAHAB_ALIGNMENT_CONTRACT_VERSION,
    });

    if (input.allowCache !== false && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      return {
        ...cached,
        requestId,
        cacheHit: true,
        latencyMs: Number((performance.now() - t0).toFixed(3)),
      };
    }

    const resamplingLineage: ResamplingLineage = {
      originalSampleRateHz,
      processingSampleRateHz: sampleRateHz,
      resampled: originalSampleRateHz !== sampleRateHz,
      mappingFormula:
        originalSampleRateHz === sampleRateHz
          ? `sourceSample = ${sourceOffsetSample} + processingSample`
          : `sourceSample = ${sourceOffsetSample} + round(processingSample * (${originalSampleRateHz} / ${sampleRateHz}))`,
      sourceOffsetSample,
    };

    // Map trailing punctuation onto preceding alignable tokens
    const trailingPunctMap = new Map<number, string[]>();
    for (const p of preparedText.punctuationTokens) {
      if (p.attachedToTokenIndex !== null) {
        const list = trailingPunctMap.get(p.attachedToTokenIndex) ?? [];
        list.push(p.originalSurface);
        trailingPunctMap.set(p.attachedToTokenIndex, list);
      }
    }

    const speechRegions = detectAcousticSpeechRegions(input.audioSamples, sampleRateHz);
    const totalSpeechSec = speechRegions.reduce(
      (acc, r) => acc + (r.endSample - r.startSample) / sampleRateHz,
      0,
    );

    const unmatchedRegions: UnmatchedRegion[] = [];
    const mismatchReasons: string[] = [];

    // Empty transcript or empty audio checks
    if (preparedText.alignableTokens.length === 0) {
      for (const r of speechRegions) {
        unmatchedRegions.push({
          regionType: 'UNMATCHED_AUDIO_SPEECH_REGION',
          audioRange: buildSampleInterval(r.startSample, r.endSample, sampleRateHz),
          transcriptCharStart: null,
          transcriptCharEnd: null,
          transcriptExcerpt: null,
          reason: 'Audio contains speech energy but supplied transcript has no alignable words.',
        });
      }
      const emptyBase: Omit<AlignmentResult, 'invariantCheck'> = {
        contractVersion: SHAHAB_ALIGNMENT_CONTRACT_VERSION,
        requestId,
        audioId: input.audioId,
        audioSha256,
        transcriptRevisionId: input.transcriptRevisionId,
        transcriptLayer: input.transcriptLayer,
        originalTranscriptText: input.transcriptText,
        preparedText,
        backendMode,
        alignerId,
        alignerRevision,
        effectiveGranularity: 'TIMING_UNAVAILABLE',
        overallStatus: speechRegions.length > 0 ? 'TRANSCRIPT_MISMATCH_SUSPECTED' : 'UNALIGNED',
        resamplingLineage,
        audioDurationSec,
        totalAudioSamples,
        segments: [],
        words: [],
        unmatchedRegions,
        mismatchSuspected: speechRegions.length > 0,
        mismatchReasons:
          speechRegions.length > 0
            ? ['Transcript is empty while audio contains active speech regions.']
            : ['Transcript contains zero alignable words.'],
        coverage: {
          alignableWordCount: 0,
          alignedWordCount: 0,
          unalignedWordCount: 0,
          alignedSegmentCount: 0,
          totalSegmentCount: 0,
          wordCoverageRatio: 0,
          segmentCoverageRatio: 0,
          coverageIsNotAccuracyNotice:
            'Coverage measures assigned spans only and is never a substitute for acoustic boundary accuracy.',
        },
        cacheHit: false,
        cacheKey,
        latencyMs: Number((performance.now() - t0).toFixed(3)),
        createdAtUtc: new Date().toISOString(),
      };
      const finalEmpty: AlignmentResult = {
        ...emptyBase,
        invariantCheck: validateAlignmentInvariants(emptyBase),
      };
      if (input.allowCache !== false) this.cache.set(cacheKey, finalEmpty);
      return finalEmpty;
    }

    // Silent / empty audio with non-empty transcript -> honest OUT_OF_AUDIO_RANGE / TRANSCRIPT_MISMATCH_SUSPECTED
    if (totalAudioSamples === 0 || (speechRegions.length === 0 && !input.ctcEvidence && !input.transducerEvidence)) {
      const reason =
        totalAudioSamples === 0
          ? 'Audio buffer is empty (0 samples); alignment cannot establish temporal correspondence.'
          : 'Audio signal contains no detectable speech activity above silence floor (-54 dBFS); transcript mismatch suspected.';
      mismatchReasons.push(reason);
      unmatchedRegions.push({
        regionType: 'UNMATCHED_TRANSCRIPT_SPAN',
        audioRange: null,
        transcriptCharStart: 0,
        transcriptCharEnd: input.transcriptText.length,
        transcriptExcerpt: input.transcriptText.slice(0, 120),
        reason,
      });

      const unalignedWords: AlignedWordRecord[] = preparedText.alignableTokens.map((tok, idx) => ({
        wordId: `w_${idx + 1}`,
        tokenIndex: tok.tokenIndex,
        originalSurface: tok.originalSurface,
        normalizedForm: tok.normalizedForm,
        originalCharStart: tok.originalCharStart,
        originalCharEnd: tok.originalCharEnd,
        tokenKind: tok.tokenKind,
        status: totalAudioSamples === 0 ? 'OUT_OF_AUDIO_RANGE' : 'TRANSCRIPT_MISMATCH_SUSPECTED',
        granularity: 'TIMING_UNAVAILABLE',
        acousticRange: null,
        sourceRange: null,
        trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
        rawAcousticScore: null,
        rawScoreCalibrationState: 'NOT_AVAILABLE',
        notes: reason,
      }));

      const segSpans = splitTranscriptIntoSentenceSpans(input.transcriptText);
      const unalignedSegments: AlignedSegmentRecord[] = segSpans.map((sp, sIdx) => {
        const wIds = unalignedWords
          .filter((w) => w.originalCharStart >= sp.start && w.originalCharEnd <= sp.end)
          .map((w) => w.wordId);
        return {
          segmentId: `seg_${sIdx + 1}`,
          segmentIndex: sIdx,
          text: sp.text,
          originalCharStart: sp.start,
          originalCharEnd: sp.end,
          status: totalAudioSamples === 0 ? 'OUT_OF_AUDIO_RANGE' : 'TRANSCRIPT_MISMATCH_SUSPECTED',
          granularity: 'TIMING_UNAVAILABLE',
          acousticRange: null,
          sourceRange: null,
          wordIds: wIds,
          alignedWordCount: 0,
          unalignedWordCount: wIds.length,
          notes: reason,
        };
      });

      const baseRes: Omit<AlignmentResult, 'invariantCheck'> = {
        contractVersion: SHAHAB_ALIGNMENT_CONTRACT_VERSION,
        requestId,
        audioId: input.audioId,
        audioSha256,
        transcriptRevisionId: input.transcriptRevisionId,
        transcriptLayer: input.transcriptLayer,
        originalTranscriptText: input.transcriptText,
        preparedText,
        backendMode,
        alignerId,
        alignerRevision,
        effectiveGranularity: 'TIMING_UNAVAILABLE',
        overallStatus:
          totalAudioSamples === 0 ? 'OUT_OF_AUDIO_RANGE' : 'TRANSCRIPT_MISMATCH_SUSPECTED',
        resamplingLineage,
        audioDurationSec,
        totalAudioSamples,
        segments: unalignedSegments,
        words: unalignedWords,
        unmatchedRegions,
        mismatchSuspected: true,
        mismatchReasons,
        coverage: {
          alignableWordCount: unalignedWords.length,
          alignedWordCount: 0,
          unalignedWordCount: unalignedWords.length,
          alignedSegmentCount: 0,
          totalSegmentCount: unalignedSegments.length,
          wordCoverageRatio: 0,
          segmentCoverageRatio: 0,
          coverageIsNotAccuracyNotice:
            'Coverage is 0% because no acoustic speech matched the transcript; timing was NOT fabricated.',
        },
        cacheHit: false,
        cacheKey,
        latencyMs: Number((performance.now() - t0).toFixed(3)),
        createdAtUtc: new Date().toISOString(),
      };
      const finalRes: AlignmentResult = {
        ...baseRes,
        invariantCheck: validateAlignmentInvariants(baseRes),
      };
      if (input.allowCache !== false) this.cache.set(cacheKey, finalRes);
      return finalRes;
    }

    // =========================================================================
    // PATH 1: True CTC Frame-Posterior Viterbi Forced Alignment
    // =========================================================================
    let words: AlignedWordRecord[] = [];
    let segments: AlignedSegmentRecord[] = [];
    let effectiveGranularity: AlignmentGranularity = 'TIMING_UNAVAILABLE';
    let overallStatus: AlignmentItemStatus = 'TIMING_UNAVAILABLE';

    if (backendMode === 'CTC_VITERBI_LOGPROBS' && input.ctcEvidence) {
      const ctc = input.ctcEvidence;
      const nonNumericInputWords = preparedText.alignableTokens
        .map((tok, idx) => ({
          id: `w_${idx + 1}`,
          text: tok.normalizedForm,
          requiresSpokenExpansion: tok.requiresSpokenExpansion,
        }))
        .filter((w) => !w.requiresSpokenExpansion);

      const ctcOutput = PersianCtcForcedAligner.alignPersianWordsAndCharacters(
        ctc.logProbsPerFrame,
        ctc.charToVocabId,
        nonNumericInputWords.map((w) => ({ id: w.id, text: w.text })),
        ctc.frameStrideSec,
        0,
      );

      const alignedByWordId = new Map<string, (typeof ctcOutput.words)[number]>();
      ctcOutput.words.forEach((w) => alignedByWordId.set(w.wordId, w));

      let prevEndSample = 0;
      words = preparedText.alignableTokens.map((tok, idx) => {
        const wordId = `w_${idx + 1}`;
        const match = alignedByWordId.get(wordId);
        if (tok.requiresSpokenExpansion) {
          return {
            wordId,
            tokenIndex: tok.tokenIndex,
            originalSurface: tok.originalSurface,
            normalizedForm: tok.normalizedForm,
            originalCharStart: tok.originalCharStart,
            originalCharEnd: tok.originalCharEnd,
            tokenKind: tok.tokenKind,
            status: 'AMBIGUOUS',
            granularity: 'TIMING_UNAVAILABLE',
            acousticRange: null,
            sourceRange: null,
            trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
            rawAcousticScore: null,
            rawScoreCalibrationState: 'NOT_AVAILABLE',
            notes: 'Numeric literal requires Persian spoken-form expansion before exact acoustic matching.',
          };
        }
        if (!match) {
          return {
            wordId,
            tokenIndex: tok.tokenIndex,
            originalSurface: tok.originalSurface,
            normalizedForm: tok.normalizedForm,
            originalCharStart: tok.originalCharStart,
            originalCharEnd: tok.originalCharEnd,
            tokenKind: tok.tokenKind,
            status: 'UNALIGNED',
            granularity: 'TIMING_UNAVAILABLE',
            acousticRange: null,
            sourceRange: null,
            trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
            rawAcousticScore: null,
            rawScoreCalibrationState: 'NOT_AVAILABLE',
            notes: 'CTC Viterbi could not align token (insufficient posterior frames or OOV character).',
          };
        }
        const matchStartSec = match.alignedRange.start / FLICKS_PER_SECOND;
        const matchEndSec = match.alignedRange.end / FLICKS_PER_SECOND;
        const rawStartSample = Math.max(
          prevEndSample,
          Math.min(totalAudioSamples, Math.round(matchStartSec * sampleRateHz)),
        );
        const rawEndSample = Math.max(
          rawStartSample,
          Math.min(totalAudioSamples, Math.round(matchEndSec * sampleRateHz)),
        );
        prevEndSample = rawEndSample;
        const acousticRange = buildSampleInterval(rawStartSample, rawEndSample, sampleRateHz);
        const sourceRange = mapProcessingIntervalToSource(acousticRange, resamplingLineage);

        return {
          wordId,
          tokenIndex: tok.tokenIndex,
          originalSurface: tok.originalSurface,
          normalizedForm: tok.normalizedForm,
          originalCharStart: tok.originalCharStart,
          originalCharEnd: tok.originalCharEnd,
          tokenKind: tok.tokenKind,
          status: 'ALIGNED',
          granularity: 'WORD_LEVEL',
          acousticRange,
          sourceRange,
          trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
          rawAcousticScore: Number(match.acousticConfidence.toFixed(4)),
          rawScoreCalibrationState: 'UNCALIBRATED_RAW_MODEL_SCORE',
          notes: 'Aligned via log-domain CTC Viterbi trellis over real frame posteriors.',
        };
      });

      const segSpans = splitTranscriptIntoSentenceSpans(input.transcriptText);
      segments = segSpans.map((sp, sIdx) => {
        const segWords = words.filter(
          (w) => w.originalCharStart >= sp.start && w.originalCharEnd <= sp.end,
        );
        const alignedSegWords = segWords.filter((w) => w.acousticRange !== null);
        const segAcousticRange =
          alignedSegWords.length > 0
            ? buildSampleInterval(
                alignedSegWords[0].acousticRange!.startSample,
                alignedSegWords[alignedSegWords.length - 1].acousticRange!.endSample,
                sampleRateHz,
              )
            : null;
        const segSourceRange = segAcousticRange
          ? mapProcessingIntervalToSource(segAcousticRange, resamplingLineage)
          : null;
        const segStatus: AlignmentItemStatus =
          alignedSegWords.length === 0
            ? 'UNALIGNED'
            : alignedSegWords.length === segWords.length
              ? 'ALIGNED'
              : 'PARTIALLY_ALIGNED';

        return {
          segmentId: `seg_${sIdx + 1}`,
          segmentIndex: sIdx,
          text: sp.text,
          originalCharStart: sp.start,
          originalCharEnd: sp.end,
          status: segStatus,
          granularity: alignedSegWords.length > 0 ? 'WORD_LEVEL' : 'TIMING_UNAVAILABLE',
          acousticRange: segAcousticRange,
          sourceRange: segSourceRange,
          wordIds: segWords.map((w) => w.wordId),
          alignedWordCount: alignedSegWords.length,
          unalignedWordCount: segWords.length - alignedSegWords.length,
          notes:
            segStatus === 'ALIGNED'
              ? 'Segment bounds derived from first/last CTC-aligned word.'
              : 'Partial or unaligned segment under CTC Viterbi alignment.',
        };
      });

      const alignedWordsCount = words.filter((w) => w.status === 'ALIGNED').length;
      effectiveGranularity = alignedWordsCount > 0 ? 'WORD_LEVEL' : 'TIMING_UNAVAILABLE';
      overallStatus =
        alignedWordsCount === 0
          ? 'ALIGNMENT_FAILED'
          : alignedWordsCount === words.length
            ? 'ALIGNED'
            : 'PARTIALLY_ALIGNED';
    }
    // =========================================================================
    // PATH 2: RNN-T Transducer Token Emission Lattice (Explicit Emission-Delay Notice)
    // =========================================================================
    else if (backendMode === 'TRANSDUCER_TOKEN_EMISSION_LATTICE' && input.transducerEvidence) {
      const tr = input.transducerEvidence;
      let cursor = 0;
      let prevEndSample = 0;

      words = preparedText.alignableTokens.map((tok, idx) => {
        const matchedFrames: number[] = [];
        const matchedScores: number[] = [];
        let assembled = '';
        let probe = cursor;

        while (probe < tr.emissions.length && assembled.length < tok.normalizedForm.length + 2) {
          const piece = normalizeTokenForAlignment(tr.emissions[probe].tokenText.replace(/▁/g, ''));
          if (piece.length === 0) {
            probe += 1;
            continue;
          }
          if (tok.normalizedForm.startsWith(assembled + piece)) {
            assembled += piece;
            matchedFrames.push(tr.emissions[probe].frameIndex);
            if (typeof tr.emissions[probe].rawLogProb === 'number') {
              matchedScores.push(tr.emissions[probe].rawLogProb!);
            }
            probe += 1;
            if (assembled === tok.normalizedForm) {
              cursor = probe;
              break;
            }
          } else {
            break;
          }
        }

        if (assembled === tok.normalizedForm && matchedFrames.length > 0) {
          const firstFrame = matchedFrames[0];
          const lastFrame = matchedFrames[matchedFrames.length - 1] + 1;
          const startSample = Math.max(
            prevEndSample,
            Math.min(totalAudioSamples, Math.round(firstFrame * tr.frameStrideSec * sampleRateHz)),
          );
          const endSample = Math.max(
            startSample,
            Math.min(totalAudioSamples, Math.round(lastFrame * tr.frameStrideSec * sampleRateHz)),
          );
          prevEndSample = endSample;
          const acousticRange = buildSampleInterval(startSample, endSample, sampleRateHz);
          const sourceRange = mapProcessingIntervalToSource(acousticRange, resamplingLineage);
          return {
            wordId: `w_${idx + 1}`,
            tokenIndex: tok.tokenIndex,
            originalSurface: tok.originalSurface,
            normalizedForm: tok.normalizedForm,
            originalCharStart: tok.originalCharStart,
            originalCharEnd: tok.originalCharEnd,
            tokenKind: tok.tokenKind,
            status: 'PARTIALLY_ALIGNED',
            granularity: 'TOKEN_LEVEL',
            acousticRange,
            sourceRange,
            trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
            rawAcousticScore:
              matchedScores.length > 0
                ? Number((matchedScores.reduce((a, b) => a + b, 0) / matchedScores.length).toFixed(4))
                : null,
            rawScoreCalibrationState:
              matchedScores.length > 0 ? 'UNCALIBRATED_RAW_MODEL_SCORE' : 'NOT_AVAILABLE',
            notes:
              'Derived from RNN-T BPE token emission frames (40ms stride); emission latency does NOT guarantee exact phoneme onset/offset.',
          };
        }

        return {
          wordId: `w_${idx + 1}`,
          tokenIndex: tok.tokenIndex,
          originalSurface: tok.originalSurface,
          normalizedForm: tok.normalizedForm,
          originalCharStart: tok.originalCharStart,
          originalCharEnd: tok.originalCharEnd,
          tokenKind: tok.tokenKind,
          status: 'UNALIGNED',
          granularity: 'TIMING_UNAVAILABLE',
          acousticRange: null,
          sourceRange: null,
          trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
          rawAcousticScore: null,
          rawScoreCalibrationState: 'NOT_AVAILABLE',
          notes: 'Transcript word did not match transducer BPE emission sequence.',
        };
      });

      const segSpans = splitTranscriptIntoSentenceSpans(input.transcriptText);
      segments = segSpans.map((sp, sIdx) => {
        const segWords = words.filter(
          (w) => w.originalCharStart >= sp.start && w.originalCharEnd <= sp.end,
        );
        const timed = segWords.filter((w) => w.acousticRange !== null);
        const acousticRange =
          timed.length > 0
            ? buildSampleInterval(
                timed[0].acousticRange!.startSample,
                timed[timed.length - 1].acousticRange!.endSample,
                sampleRateHz,
              )
            : null;
        return {
          segmentId: `seg_${sIdx + 1}`,
          segmentIndex: sIdx,
          text: sp.text,
          originalCharStart: sp.start,
          originalCharEnd: sp.end,
          status: timed.length === 0 ? 'UNALIGNED' : 'PARTIALLY_ALIGNED',
          granularity: timed.length > 0 ? 'TOKEN_LEVEL' : 'TIMING_UNAVAILABLE',
          acousticRange,
          sourceRange: acousticRange ? mapProcessingIntervalToSource(acousticRange, resamplingLineage) : null,
          wordIds: segWords.map((w) => w.wordId),
          alignedWordCount: timed.length,
          unalignedWordCount: segWords.length - timed.length,
          notes: 'RNN-T emission frame span; not phoneme-exact word boundary alignment.',
        };
      });
      effectiveGranularity = words.some((w) => w.acousticRange !== null)
        ? 'TOKEN_LEVEL'
        : 'TIMING_UNAVAILABLE';
      overallStatus = words.some((w) => w.acousticRange !== null)
        ? 'PARTIALLY_ALIGNED'
        : 'TRANSCRIPT_MISMATCH_SUSPECTED';
    }
    // =========================================================================
    // PATH 3: Honest Acoustic VAD Segment Anchoring (ZERO Fake Word Splits!)
    // =========================================================================
    else {
      // Check gross duration/word-rate mismatch: > 8 words/sec of actual speech is physically implausible for Persian
      const wordsPerSpeechSec =
        totalSpeechSec > 0 ? preparedText.alignableTokens.length / totalSpeechSec : Infinity;
      const severeMismatch = wordsPerSpeechSec > 8.5 || totalSpeechSec < 0.08;
      if (severeMismatch) {
        mismatchReasons.push(
          `Improbable speech density (${preparedText.alignableTokens.length} words over ${totalSpeechSec.toFixed(2)}s detected speech = ${wordsPerSpeechSec.toFixed(1)} w/s); transcript-vs-audio mismatch suspected.`,
        );
      }

      // Words NEVER get fabricated uniform splits in segment-only mode!
      words = preparedText.alignableTokens.map((tok, idx) => ({
        wordId: `w_${idx + 1}`,
        tokenIndex: tok.tokenIndex,
        originalSurface: tok.originalSurface,
        normalizedForm: tok.normalizedForm,
        originalCharStart: tok.originalCharStart,
        originalCharEnd: tok.originalCharEnd,
        tokenKind: tok.tokenKind,
        status: severeMismatch ? 'TRANSCRIPT_MISMATCH_SUSPECTED' : 'TIMING_UNAVAILABLE',
        granularity: 'TIMING_UNAVAILABLE',
        acousticRange: null,
        sourceRange: null,
        trailingPunctuation: trailingPunctMap.get(tok.tokenIndex) ?? [],
        rawAcousticScore: null,
        rawScoreCalibrationState: 'NOT_AVAILABLE',
        notes:
          'Word-level acoustic boundaries unavailable without a CTC/phoneme forced-aligner checkpoint; SHAHAB refuses to fabricate proportional word timestamps.',
      }));

      const segSpans = splitTranscriptIntoSentenceSpans(input.transcriptText);
      if (severeMismatch) {
        segments = segSpans.map((sp, sIdx) => {
          const segWords = words.filter(
            (w) => w.originalCharStart >= sp.start && w.originalCharEnd <= sp.end,
          );
          return {
            segmentId: `seg_${sIdx + 1}`,
            segmentIndex: sIdx,
            text: sp.text,
            originalCharStart: sp.start,
            originalCharEnd: sp.end,
            status: 'TRANSCRIPT_MISMATCH_SUSPECTED',
            granularity: 'TIMING_UNAVAILABLE',
            acousticRange: null,
            sourceRange: null,
            wordIds: segWords.map((w) => w.wordId),
            alignedWordCount: 0,
            unalignedWordCount: segWords.length,
            notes: mismatchReasons[0],
          };
        });
        effectiveGranularity = 'TIMING_UNAVAILABLE';
        overallStatus = 'TRANSCRIPT_MISMATCH_SUSPECTED';
      } else {
        // Honest 1-to-1 anchoring ONLY where acoustic speech regions correspond cleanly to segments;
        // if more speech regions than segments, report unmatched audio regions;
        // if more segments than speech regions, collapse to single full speech envelope OR mark excess segments UNALIGNED.
        segments = segSpans.map((sp, sIdx) => {
          const segWords = words.filter(
            (w) => w.originalCharStart >= sp.start && w.originalCharEnd <= sp.end,
          );
          if (segSpans.length === 1 && speechRegions.length > 0) {
            const acousticRange = buildSampleInterval(
              speechRegions[0].startSample,
              speechRegions[speechRegions.length - 1].endSample,
              sampleRateHz,
            );
            return {
              segmentId: `seg_${sIdx + 1}`,
              segmentIndex: sIdx,
              text: sp.text,
              originalCharStart: sp.start,
              originalCharEnd: sp.end,
              status: 'PARTIALLY_ALIGNED',
              granularity: 'SEGMENT_LEVEL',
              acousticRange,
              sourceRange: mapProcessingIntervalToSource(acousticRange, resamplingLineage),
              wordIds: segWords.map((w) => w.wordId),
              alignedWordCount: 0,
              unalignedWordCount: segWords.length,
              notes:
                'Segment envelope anchored to real detected acoustic speech activity; word-level timing unavailable.',
            };
          }
          if (sIdx < speechRegions.length) {
            const region = speechRegions[sIdx];
            const acousticRange = buildSampleInterval(
              region.startSample,
              region.endSample,
              sampleRateHz,
            );
            return {
              segmentId: `seg_${sIdx + 1}`,
              segmentIndex: sIdx,
              text: sp.text,
              originalCharStart: sp.start,
              originalCharEnd: sp.end,
              status: 'PARTIALLY_ALIGNED',
              granularity: 'SEGMENT_LEVEL',
              acousticRange,
              sourceRange: mapProcessingIntervalToSource(acousticRange, resamplingLineage),
              wordIds: segWords.map((w) => w.wordId),
              alignedWordCount: 0,
              unalignedWordCount: segWords.length,
              notes:
                'Anchored to sequential acoustic speech-activity region (segment-level only; no word boundary fabrication).',
            };
          }
          unmatchedRegions.push({
            regionType: 'UNMATCHED_TRANSCRIPT_SPAN',
            audioRange: null,
            transcriptCharStart: sp.start,
            transcriptCharEnd: sp.end,
            transcriptExcerpt: sp.text,
            reason: 'No corresponding separated acoustic speech region found for this transcript segment.',
          });
          return {
            segmentId: `seg_${sIdx + 1}`,
            segmentIndex: sIdx,
            text: sp.text,
            originalCharStart: sp.start,
            originalCharEnd: sp.end,
            status: 'UNALIGNED',
            granularity: 'TIMING_UNAVAILABLE',
            acousticRange: null,
            sourceRange: null,
            wordIds: segWords.map((w) => w.wordId),
            alignedWordCount: 0,
            unalignedWordCount: segWords.length,
            notes: 'No separated acoustic speech region matched this segment without fabricating sub-segment splits.',
          };
        });

        if (segSpans.length > 1 && speechRegions.length > segSpans.length) {
          for (let rIdx = segSpans.length; rIdx < speechRegions.length; rIdx++) {
            const r = speechRegions[rIdx];
            unmatchedRegions.push({
              regionType: 'UNMATCHED_AUDIO_SPEECH_REGION',
              audioRange: buildSampleInterval(r.startSample, r.endSample, sampleRateHz),
              transcriptCharStart: null,
              transcriptCharEnd: null,
              transcriptExcerpt: null,
              reason: 'Additional acoustic speech region has no corresponding transcript segment.',
            });
          }
        }

        const anchoredSegs = segments.filter((s) => s.acousticRange !== null).length;
        effectiveGranularity = anchoredSegs > 0 ? 'SEGMENT_LEVEL' : 'TIMING_UNAVAILABLE';
        overallStatus = anchoredSegs > 0 ? 'PARTIALLY_ALIGNED' : 'UNALIGNED';
      }
    }

    const alignedWordCount = words.filter((w) => w.acousticRange !== null).length;
    const alignedSegmentCount = segments.filter((s) => s.acousticRange !== null).length;

    const baseResult: Omit<AlignmentResult, 'invariantCheck'> = {
      contractVersion: SHAHAB_ALIGNMENT_CONTRACT_VERSION,
      requestId,
      audioId: input.audioId,
      audioSha256,
      transcriptRevisionId: input.transcriptRevisionId,
      transcriptLayer: input.transcriptLayer,
      originalTranscriptText: input.transcriptText,
      preparedText,
      backendMode,
      alignerId,
      alignerRevision,
      effectiveGranularity,
      overallStatus,
      resamplingLineage,
      audioDurationSec,
      totalAudioSamples,
      segments,
      words,
      unmatchedRegions,
      mismatchSuspected: mismatchReasons.length > 0,
      mismatchReasons,
      coverage: {
        alignableWordCount: words.length,
        alignedWordCount,
        unalignedWordCount: Math.max(0, words.length - alignedWordCount),
        alignedSegmentCount,
        totalSegmentCount: segments.length,
        wordCoverageRatio: words.length > 0 ? Number((alignedWordCount / words.length).toFixed(4)) : 0,
        segmentCoverageRatio:
          segments.length > 0 ? Number((alignedSegmentCount / segments.length).toFixed(4)) : 0,
        coverageIsNotAccuracyNotice:
          'Coverage is the proportion of items assigned a timestamp. It is NEVER acoustic boundary accuracy.',
      },
      cacheHit: false,
      cacheKey,
      latencyMs: Number((performance.now() - t0).toFixed(3)),
      createdAtUtc: new Date().toISOString(),
    };

    const result: AlignmentResult = {
      ...baseResult,
      invariantCheck: validateAlignmentInvariants(baseResult),
    };

    if (input.allowCache !== false) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }
}
