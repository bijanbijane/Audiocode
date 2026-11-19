import {
  AnnotatedSpeechEventReference,
  CategoryEvaluationMetrics,
  DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
  ScoreCalibrationStatus,
  SpeechAnalysisThresholdConfig,
  SpeechEvent,
  SpeechEventCategory,
  SpeechEventDetectionMethod,
  SpeechEventDetectionState,
  SpeechEventEvaluationReport,
  SpeechEventScoreBreakdown,
  SpeechEventUncertaintyState,
} from './SpeechEventContracts';

export interface EvidenceFusionInput {
  readonly category: SpeechEventCategory;
  readonly acousticScore: number | null;
  readonly linguisticScore: number | null;
  readonly ruleEvidenceCount: number;
  readonly modelTokenConfidence: number | null;
  readonly modelEventConfidence?: number | null;
  readonly vadActiveOverlap?: boolean;
  readonly requiresAcousticVerification?: boolean;
  readonly isUnsupportedCapability?: boolean;
  readonly baseConflicts?: readonly string[];
  readonly config?: SpeechAnalysisThresholdConfig;
}

export interface EvidenceFusionOutput {
  readonly scores: SpeechEventScoreBreakdown;
  readonly decisionScore: number;
  readonly detectionMethod: SpeechEventDetectionMethod;
  readonly uncertaintyState: SpeechEventUncertaintyState;
}

const NEVER_AUTO_DELETABLE_SUBTYPES = new Set([
  'MEANINGFUL_DISCOURSE_MARKER_PRESERVED',
  'INTENTIONAL_EMPHASIS_REPETITION',
  'LEGITIMATE_LEXICAL_REPETITION',
  'NATURAL_SHORT_PAUSE',
  'SENTENCE_BOUNDARY_PAUSE',
  'BREATH_RELATED_PAUSE',
  'INPUT_FAILURE_OR_DIGITAL_ZERO',
  'UTTERANCE_INTERNAL_SILENCE',
  'TOO_FAST_PACING',
  'TOO_SLOW_PACING',
  'ABRUPT_PACING_CHANGE',
  'LONG_UNINTERRUPTED_SPEECH',
  'NATURAL_PACING_BASELINE',
  'LAUGHTER',
  'SIGH',
  'CRYING',
  'UNCERTAIN_NON_VERBAL',
  'UNSUPPORTED_DETECTOR',
]);

const ALWAYS_HUMAN_REVIEW_CATEGORIES = new Set<SpeechEventCategory>([
  'FALSE_START',
  'SELF_CORRECTION',
  'STUTTER',
  'SYLLABLE_REPETITION',
  'NON_VERBAL_VOCALIZATION',
  'BREATH',
  'PACING_ANOMALY',
  'UNCERTAIN_SPEECH_EVENT',
]);

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

/**
 * Controlled Evidence Fusion (AVP-P04-001 Section 10)
 * Separates acoustic score, linguistic score, rule evidence count, and model confidence.
 * NEVER labels heuristic weighted combinations as calibrated probabilities.
 */
export function fuseSpeechEventEvidence(input: EvidenceFusionInput): EvidenceFusionOutput {
  const config = input.config ?? DEFAULT_SPEECH_EVENT_THRESHOLDS_V1;
  const conflicts: string[] = [...(input.baseConflicts ?? [])];

  if (input.isUnsupportedCapability) {
    return {
      scores: {
        acousticScore: null,
        linguisticScore: null,
        ruleEvidenceCount: 0,
        modelTokenConfidence: null,
        combinedDecisionScore: null,
        calibratedProbability: null,
        scoreCalibrationStatus: 'UNAVAILABLE',
        conflicts: [...conflicts, 'قابلیت مدل‌محور در دسترس نیست (UNSUPPORTED).'],
      },
      decisionScore: 0,
      detectionMethod: 'UNSUPPORTED_NO_MODEL',
      uncertaintyState: 'UNSUPPORTED_CAPABILITY',
    };
  }

  const aScore = input.acousticScore !== null ? clamp01(input.acousticScore) : null;
  const lScore = input.linguisticScore !== null ? clamp01(input.linguisticScore) : null;
  const mTokConf =
    input.modelTokenConfidence !== null ? clamp01(input.modelTokenConfidence) : null;
  const mEventConf =
    input.modelEventConfidence !== undefined && input.modelEventConfidence !== null
      ? clamp01(input.modelEventConfidence)
      : null;

  // Cross-source conflict checks
  if (input.vadActiveOverlap && (input.category === 'SILENCE' || input.category === 'FILLER')) {
    conflicts.push('تعارض شواهد: ماژول VAD در این بازه فعالیت گفتاری گزارش کرده است.');
  }
  if (input.requiresAcousticVerification && aScore === null) {
    conflicts.push('شواهد آکوستیکی سیگنال برای تأیید این رویداد موجود نیست.');
  }
  if (aScore !== null && lScore !== null && Math.abs(aScore - lScore) >= 0.38) {
    conflicts.push(
      `واگرایی قابل توجه بین شواهد آکوستیکی (${aScore.toFixed(2)}) و زبانی (${lScore.toFixed(2)}).`,
    );
  }
  if (mTokConf !== null && mTokConf < 0.55 && lScore !== null) {
    conflicts.push(
      `اطمینان توکن ASR پایین است (${mTokConf.toFixed(2)})؛ احتمال خطای بازشناسی وجود دارد.`,
    );
  }

  let detectionMethod: SpeechEventDetectionMethod = 'HYBRID_HEURISTIC_FUSION';
  let combined: number;
  let calibrationStatus: ScoreCalibrationStatus = 'UNCALIBRATED_HEURISTIC';

  if (mEventConf !== null) {
    detectionMethod = 'MODEL_BASED';
    calibrationStatus = 'MODEL_RAW_CONFIDENCE';
    combined = aScore !== null ? 0.8 * mEventConf + 0.2 * aScore : mEventConf;
  } else if (aScore !== null && lScore !== null) {
    detectionMethod = 'HYBRID_HEURISTIC_FUSION';
    combined = 0.52 * aScore + 0.48 * lScore;
  } else if (aScore !== null) {
    detectionMethod = 'HEURISTIC_SIGNAL';
    combined = aScore;
  } else if (lScore !== null) {
    detectionMethod = 'HEURISTIC_LINGUISTIC';
    combined = lScore;
  } else {
    detectionMethod = 'HEURISTIC_SIGNAL';
    combined = 0;
  }

  // Factor genuine ASR token confidence conservatively when linguistic evidence is involved
  if (mTokConf !== null && lScore !== null) {
    combined = combined * (0.78 + 0.22 * mTokConf);
  }

  // Penalize combined heuristic decision score whenever evidence sources conflict or lack acoustics
  if (conflicts.length > 0) {
    const penalty = Math.min(0.35, conflicts.length * 0.14);
    combined = Math.max(0.15, combined - penalty);
  }

  // Calibrated probability ONLY if an explicit empirical calibration table exists for this category
  let calibratedProbability: number | null = null;
  const calEntry = config.empiricalCalibration?.[input.category];
  if (calEntry && Number.isFinite(calEntry.slope) && Number.isFinite(calEntry.intercept)) {
    const logit = calEntry.slope * combined + calEntry.intercept;
    calibratedProbability = Number((1 / (1 + Math.exp(-logit))).toFixed(4));
    calibrationStatus = 'CALIBRATED_EMPIRICAL';
  }

  const finalDecisionScore = Number(clamp01(combined).toFixed(3));

  let uncertaintyState: SpeechEventUncertaintyState;
  if (
    conflicts.some((c) => c.includes('تعارض') || c.includes('واگرایی'))
  ) {
    uncertaintyState = 'CONFLICTING_EVIDENCE';
  } else if (
    (input.requiresAcousticVerification && aScore === null) ||
    (aScore === null && lScore === null && mEventConf === null)
  ) {
    uncertaintyState = 'INSUFFICIENT_EVIDENCE';
  } else if (finalDecisionScore >= config.highConfidenceDeletionThreshold && conflicts.length === 0) {
    uncertaintyState = 'LOW_UNCERTAINTY';
  } else if (finalDecisionScore >= config.mediumConfidenceReviewThreshold) {
    uncertaintyState = 'MODERATE_UNCERTAINTY';
  } else {
    uncertaintyState = 'HIGH_UNCERTAINTY';
  }

  return {
    scores: {
      acousticScore: aScore !== null ? Number(aScore.toFixed(3)) : null,
      linguisticScore: lScore !== null ? Number(lScore.toFixed(3)) : null,
      ruleEvidenceCount: Number.isFinite(input.ruleEvidenceCount)
        ? Math.max(0, Math.trunc(input.ruleEvidenceCount))
        : 0,
      modelTokenConfidence: mTokConf !== null ? Number(mTokConf.toFixed(3)) : null,
      combinedDecisionScore: finalDecisionScore,
      calibratedProbability,
      scoreCalibrationStatus: calibrationStatus,
      conflicts,
    },
    decisionScore: finalDecisionScore,
    detectionMethod,
    uncertaintyState,
  };
}

/**
 * Precision-Oriented Suggestion Eligibility Policy (AVP-P04-001 Section 11)
 * - High confidence (>= 0.82) -> eligible for deletion/trimming suggestion (when subtype permits)
 * - Medium confidence (0.58..0.81) -> human review only
 * - Low confidence (<= 0.57) or UNCERTAIN/UNSUPPORTED/NOT_DETECTED -> informational only
 */
export function applyPrecisionEligibilityAndThresholds(
  event: SpeechEvent,
  config: SpeechAnalysisThresholdConfig = DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
): SpeechEvent {
  if (
    event.detectionState === 'UNSUPPORTED' ||
    event.detectionState === 'NOT_DETECTED' ||
    event.detectionState === 'UNCERTAIN' ||
    event.uncertaintyState === 'UNSUPPORTED_CAPABILITY' ||
    event.uncertaintyState === 'CONFLICTING_EVIDENCE' ||
    event.uncertaintyState === 'INSUFFICIENT_EVIDENCE'
  ) {
    return {
      ...event,
      eligibleForEditSuggestion: false,
      requiresHumanReview: true,
    };
  }

  if (NEVER_AUTO_DELETABLE_SUBTYPES.has(event.subtype)) {
    return {
      ...event,
      eligibleForEditSuggestion: false,
      requiresHumanReview:
        event.subtype === 'INPUT_FAILURE_OR_DIGITAL_ZERO' ||
        event.subtype === 'INTENTIONAL_EMPHASIS_REPETITION' ||
        event.subtype === 'BREATH_RELATED_PAUSE' ||
        event.subtype === 'LAUGHTER' ||
        event.subtype === 'SIGH' ||
        event.subtype === 'CRYING',
    };
  }

  const score = event.confidence;

  // Low confidence or non-finite score -> informational only
  if (!Number.isFinite(score) || score <= config.lowConfidenceInformationalCeiling) {
    return {
      ...event,
      detectionState: event.detectionState === 'DETECTED' ? 'POSSIBLE' : event.detectionState,
      eligibleForEditSuggestion: false,
      requiresHumanReview: true,
    };
  }

  // Medium confidence -> review-only suggestion
  if (score < config.highConfidenceDeletionThreshold) {
    return {
      ...event,
      eligibleForEditSuggestion:
        event.eligibleForEditSuggestion && !ALWAYS_HUMAN_REVIEW_CATEGORIES.has(event.category),
      requiresHumanReview: true,
    };
  }

  // High confidence (>= 0.82)
  const needsReview =
    event.requiresHumanReview ||
    ALWAYS_HUMAN_REVIEW_CATEGORIES.has(event.category) ||
    event.scores.conflicts.length > 0;

  return {
    ...event,
    eligibleForEditSuggestion:
      event.eligibleForEditSuggestion &&
      event.scores.conflicts.length === 0 &&
      event.category !== 'FALSE_START' &&
      event.category !== 'SELF_CORRECTION' &&
      event.category !== 'PACING_ANOMALY',
    requiresHumanReview: needsReview,
  };
}

function computeTemporalIou(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  if (
    !Number.isFinite(aStart) ||
    !Number.isFinite(aEnd) ||
    !Number.isFinite(bStart) ||
    !Number.isFinite(bEnd)
  ) {
    return 0;
  }
  const interStart = Math.max(aStart, bStart);
  const interEnd = Math.min(aEnd, bEnd);
  const inter = Math.max(0, interEnd - interStart);
  if (inter <= 0) return 0;
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  return union > 0 ? inter / union : 0;
}

function categoriesMatch(
  pred: SpeechEventCategory,
  ref: SpeechEventCategory,
  allowAliases: boolean,
): boolean {
  if (pred === ref) return true;
  if (!allowAliases) return false;
  if (
    (pred === 'SYLLABLE_REPETITION' && ref === 'STUTTER') ||
    (pred === 'STUTTER' && ref === 'SYLLABLE_REPETITION')
  ) {
    return true;
  }
  if (
    (pred === 'FALSE_START' && ref === 'SELF_CORRECTION') ||
    (pred === 'SELF_CORRECTION' && ref === 'FALSE_START')
  ) {
    return true;
  }
  return false;
}

/**
 * Evidence-Backed Evaluation Engine (AVP-P04-001 Section 12)
 * Compares predicted SpeechEvents against human-annotated reference spans.
 * If no human-annotated ground truth exists, explicitly returns UNAVAILABLE_NO_ANNOTATED_REFERENCE.
 * Never uses detector output as ground truth.
 */
export function evaluateDetectedSpeechEvents(params: {
  readonly predicted: readonly SpeechEvent[];
  readonly references: readonly AnnotatedSpeechEventReference[];
  readonly totalAudioDurationSec: number;
  readonly minTemporalIou?: number;
  readonly allowCategoryAliasMatch?: boolean;
  readonly evidenceClassification?: 'SYNTHETIC_DIAGNOSTIC' | 'REAL_ANNOTATED_AUDIO';
}): SpeechEventEvaluationReport {
  const minTemporalIou =
    params.minTemporalIou !== undefined && Number.isFinite(params.minTemporalIou)
      ? Math.max(0.01, Math.min(1, params.minTemporalIou))
      : 0.3;
  const allowCategoryAliasMatch = params.allowCategoryAliasMatch ?? false;
  const safeDurationSec =
    Number.isFinite(params.totalAudioDurationSec) && params.totalAudioDurationSec > 0
      ? params.totalAudioDurationSec
      : 60;
  const totalAudioMinutes = Math.max(1e-6, safeDurationSec / 60);

  // Filter out non-detections / unsupported placeholders from predicted detections
  const activePredictions = params.predicted.filter(
    (e) => e.detectionState !== 'NOT_DETECTED' && e.detectionState !== 'UNSUPPORTED',
  );

  if (!params.references || params.references.length === 0) {
    return {
      status: 'UNAVAILABLE_NO_ANNOTATED_REFERENCE',
      evidenceClassification: 'UNAVAILABLE',
      matchPolicy: { minTemporalIou, allowCategoryAliasMatch },
      totalAudioMinutes: Number(totalAudioMinutes.toFixed(3)),
      referenceCount: 0,
      predictedCount: activePredictions.length,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      classificationAccuracyAmongMatched: 0,
      falsePositiveRate: 0,
      falseNegativeRate: 0,
      falsePositivesPerMinute: 0,
      missedEventsPerMinute: 0,
      meanTemporalIou: 0,
      meanStartBoundaryErrorMs: 0,
      meanEndBoundaryErrorMs: 0,
      meanDurationErrorMs: 0,
      perCategory: [],
      limitationsNote:
        'ارزیابی دقت در دسترس نیست (UNAVAILABLE): هیچ برچسب مرجع انسانی (Human-Annotated Ground Truth) برای این ضبط ارائه نشده است. خروجی خود موتور هرگز به‌عنوان حقیقت مبنا استفاده نمی‌شود.',
    };
  }

  // Greedy maximum temporal IoU bipartite matching
  interface MatchCandidate {
    predIdx: number;
    refIdx: number;
    iou: number;
    catMatch: boolean;
  }

  const pairs: MatchCandidate[] = [];
  for (let p = 0; p < activePredictions.length; p++) {
    for (let r = 0; r < params.references.length; r++) {
      const iou = computeTemporalIou(
        activePredictions[p].startSec,
        activePredictions[p].endSec,
        params.references[r].startSec,
        params.references[r].endSec,
      );
      if (iou >= minTemporalIou) {
        pairs.push({
          predIdx: p,
          refIdx: r,
          iou,
          catMatch: categoriesMatch(
            activePredictions[p].category,
            params.references[r].category,
            allowCategoryAliasMatch,
          ),
        });
      }
    }
  }

  // Prefer category-matching overlaps first, then highest IoU
  pairs.sort((a, b) => {
    if (a.catMatch !== b.catMatch) return a.catMatch ? -1 : 1;
    return b.iou - a.iou;
  });

  const matchedPreds = new Set<number>();
  const matchedRefs = new Set<number>();
  const matchedPairs: MatchCandidate[] = [];

  for (const pair of pairs) {
    if (matchedPreds.has(pair.predIdx) || matchedRefs.has(pair.refIdx)) continue;
    matchedPreds.add(pair.predIdx);
    matchedRefs.add(pair.refIdx);
    matchedPairs.push(pair);
  }

  const tpMatches = matchedPairs.filter((m) => m.catMatch);
  const truePositives = tpMatches.length;
  const falsePositives = activePredictions.length - truePositives;
  const falseNegatives = params.references.length - truePositives;

  const precision =
    activePredictions.length > 0 ? truePositives / activePredictions.length : 0;
  const recall =
    params.references.length > 0 ? truePositives / params.references.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const classificationAccuracyAmongMatched =
    matchedPairs.length > 0 ? truePositives / matchedPairs.length : 0;

  let sumIou = 0;
  let sumStartErrMs = 0;
  let sumEndErrMs = 0;
  let sumDurErrMs = 0;
  for (const m of matchedPairs) {
    const p = activePredictions[m.predIdx];
    const r = params.references[m.refIdx];
    sumIou += m.iou;
    sumStartErrMs += Math.abs(p.startSec - r.startSec) * 1000;
    sumEndErrMs += Math.abs(p.endSec - r.endSec) * 1000;
    sumDurErrMs += Math.abs((p.endSec - p.startSec) - (r.endSec - r.startSec)) * 1000;
  }

  const denomMatched = Math.max(1, matchedPairs.length);

  // Per-category metrics
  const allCats = new Set<SpeechEventCategory>();
  for (const r of params.references) allCats.add(r.category);
  for (const p of activePredictions) allCats.add(p.category);

  const perCategory: CategoryEvaluationMetrics[] = [];
  for (const cat of allCats) {
    const catTp = tpMatches.filter((m) => params.references[m.refIdx].category === cat).length;
    const catPredCount = activePredictions.filter((p) => p.category === cat).length;
    const catRefCount = params.references.filter((r) => r.category === cat).length;
    const catFp = Math.max(0, catPredCount - catTp);
    const catFn = Math.max(0, catRefCount - catTp);
    const catPrec = catPredCount > 0 ? catTp / catPredCount : 0;
    const catRec = catRefCount > 0 ? catTp / catRefCount : 0;
    const catF1 = catPrec + catRec > 0 ? (2 * catPrec * catRec) / (catPrec + catRec) : 0;
    perCategory.push({
      category: cat,
      truePositives: catTp,
      falsePositives: catFp,
      falseNegatives: catFn,
      precision: Number(catPrec.toFixed(4)),
      recall: Number(catRec.toFixed(4)),
      f1: Number(catF1.toFixed(4)),
    });
  }

  const evidenceClass = params.evidenceClassification ?? 'SYNTHETIC_DIAGNOSTIC';

  return {
    status: 'EVALUATED',
    evidenceClassification: evidenceClass,
    matchPolicy: { minTemporalIou, allowCategoryAliasMatch },
    totalAudioMinutes: Number(totalAudioMinutes.toFixed(3)),
    referenceCount: params.references.length,
    predictedCount: activePredictions.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    classificationAccuracyAmongMatched: Number(classificationAccuracyAmongMatched.toFixed(4)),
    falsePositiveRate: Number(
      (activePredictions.length > 0 ? falsePositives / activePredictions.length : 0).toFixed(4),
    ),
    falseNegativeRate: Number(
      (params.references.length > 0 ? falseNegatives / params.references.length : 0).toFixed(4),
    ),
    falsePositivesPerMinute: Number((falsePositives / totalAudioMinutes).toFixed(3)),
    missedEventsPerMinute: Number((falseNegatives / totalAudioMinutes).toFixed(3)),
    meanTemporalIou: Number((matchedPairs.length > 0 ? sumIou / denomMatched : 0).toFixed(4)),
    meanStartBoundaryErrorMs: Number(
      (matchedPairs.length > 0 ? sumStartErrMs / denomMatched : 0).toFixed(2),
    ),
    meanEndBoundaryErrorMs: Number(
      (matchedPairs.length > 0 ? sumEndErrMs / denomMatched : 0).toFixed(2),
    ),
    meanDurationErrorMs: Number(
      (matchedPairs.length > 0 ? sumDurErrMs / denomMatched : 0).toFixed(2),
    ),
    perCategory,
    limitationsNote:
      evidenceClass === 'SYNTHETIC_DIAGNOSTIC'
        ? 'نتایج بر مبنای مجموعه مرجع مصنوعی/آزمایشی (Synthetic Diagnostic) محاسبه شده و نمایانگر بنچمارک گفتار واقعی انسانی نیست.'
        : 'نتایج بر مبنای برچسب‌های انسانی واقعی با آستانه هم‌پوشانی زمانی IoU محاسبه شده است.',
  };
}
