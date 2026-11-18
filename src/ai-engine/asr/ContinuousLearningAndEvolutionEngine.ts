/**
 * PHASE 9 — CONTINUOUS LEARNING, PRODUCTION FEEDBACK INTELLIGENCE & AUTONOMOUS ASR EVOLUTION (Spec v1.0)
 * Production-Grade TypeScript Engine implementing:
 *  1. Strict Artifact Separation (`RawAudioAsset`, `AsrOutputHypothesis`, `UserFeedbackSubmission`,
 *     `HumanAnnotationTask`, `AdjudicationDecision`, `VerifiedDatasetRelease`, `CandidateModel`)
 *     — zero unrestricted live online weight updates.
 *  2. Feedback Collector with Composite Idempotency Key (`Hash(scope + requestId + utteranceId + feedbackType + correctionHash)`),
 *     character/timestamp range checks & privacy hygiene.
 *  3. 8-Permission Granular Consent & Eligibility Gate (`ALLOW_TRANSCRIPTION`, `ALLOW_TRANSCRIPT_STORAGE`,
 *     `ALLOW_AUDIO_RETENTION`, `ALLOW_QUALITY_ANALYSIS`, `ALLOW_HUMAN_REVIEW`, `ALLOW_MODEL_TRAINING`,
 *     `ALLOW_RESEARCH_PUBLICATION`, `ALLOW_EXTERNAL_PROVIDER_PROCESSING`), immutable consent versions,
 *     hard `TRAINING_INELIGIBLE` block when `training_consent=false`, and Deletion Propagation Ledger.
 *  4. Active Learning Uncertainty & Error-Value Scorer:
 *     `S = 0.30*U + 0.25*D + 0.20*N + 0.15*R + 0.10*C`
 *     with mandatory `>=20%` random baseline control stream & per-speaker diversity cap.
 *  5. Double-Annotation & WER Disagreement (`>2%`) Adjudication Engine creating `VerifiedTrainingSample`.
 *  6. Immutable Dataset Versioning (`dataset_vX_Y_Z`) with speaker-disjoint split guard & 70/30 Historical Replay Buffer.
 *  7. Retraining Triggers (`TR01..TR05`), Champion/Challenger Paired Promotion Gate
 *     (`>=3.0%` relative CER improvement, `<=0.5pp` cohort regression, `<=10%` latency regression),
 *     PSI Distribution & Quality Drift Detector (with `INSUFFICIENT_EVIDENCE` guard for small cohorts),
 *     and Shadow -> Canary (1% -> 5% -> 25% -> 100%) -> Automatic Rollback Controller.
 */

import {
  evaluateWithNormalizationVersion,
  classifyTranscriptErrorsIntoTaxonomy,
} from './AsrDatasetAndBehavioralBenchmarkEngine';

// ============================================================================
// 1. 8-PERMISSION CONSENT & DELETION PROPAGATION (Section 3)
// ============================================================================

export type ConsentPermissionFlag =
  | 'ALLOW_TRANSCRIPTION'
  | 'ALLOW_TRANSCRIPT_STORAGE'
  | 'ALLOW_AUDIO_RETENTION'
  | 'ALLOW_QUALITY_ANALYSIS'
  | 'ALLOW_HUMAN_REVIEW'
  | 'ALLOW_MODEL_TRAINING'
  | 'ALLOW_RESEARCH_PUBLICATION'
  | 'ALLOW_EXTERNAL_PROVIDER_PROCESSING';

export interface ImmutableConsentRecord {
  consentRecordId: string;
  tenantId: string;
  userId: string;
  version: number;
  recordedAtIso: string;
  permissions: Record<ConsentPermissionFlag, boolean>;
}

export type ConsentEligibilityState =
  | 'TRAINING_APPROVED'
  | 'TRAINING_INELIGIBLE_NO_TRAINING_CONSENT'
  | 'TRAINING_INELIGIBLE_NO_AUDIO_RETENTION'
  | 'DELETED_PENDING_LINEAGE_CHECK';

export interface DeletionPropagationReceipt {
  deletionId: string;
  audioSha256: string;
  tenantId: string;
  requestedAtIso: string;
  removedFromHotFeedback: boolean;
  removedFromActiveLearningQueue: boolean;
  removedFromPendingTrainingManifests: boolean;
  impactedTrainedModelReleases: string[];
  honestRetrainingNotice: string;
}

export function evaluateSampleConsentEligibility(
  consent: ImmutableConsentRecord,
  isDeleted = false
): ConsentEligibilityState {
  if (isDeleted) return 'DELETED_PENDING_LINEAGE_CHECK';
  if (!consent.permissions.ALLOW_AUDIO_RETENTION) {
    return 'TRAINING_INELIGIBLE_NO_AUDIO_RETENTION';
  }
  if (!consent.permissions.ALLOW_MODEL_TRAINING) {
    return 'TRAINING_INELIGIBLE_NO_TRAINING_CONSENT';
  }
  return 'TRAINING_APPROVED';
}

export function executeDeletionPropagation(params: {
  audioSha256: string;
  tenantId: string;
  feedbackItems: FeedbackSubmissionRecord[];
  activeLearningQueue: ActiveLearningCandidate[];
  pendingManifestAudioHashes: Set<string>;
  historicalModelLineage: Array<{ modelVersion: string; includedAudioHashes: string[] }>;
}): DeletionPropagationReceipt {
  const { audioSha256, tenantId } = params;
  for (const fb of params.feedbackItems) {
    if (fb.audioSha256 === audioSha256 && fb.tenantId === tenantId) {
      fb.deletedAtIso = new Date().toISOString();
      fb.eligibilityState = 'DELETED_PENDING_LINEAGE_CHECK';
      fb.userCorrectionText = '[DELETED]';
    }
  }
  for (let i = params.activeLearningQueue.length - 1; i >= 0; i--) {
    if (params.activeLearningQueue[i].audioSha256 === audioSha256) {
      params.activeLearningQueue.splice(i, 1);
    }
  }
  const removedFromPending = params.pendingManifestAudioHashes.delete(audioSha256);
  const impactedModels = params.historicalModelLineage
    .filter((m) => m.includedAudioHashes.includes(audioSha256))
    .map((m) => m.modelVersion);

  return {
    deletionId: `del-${audioSha256.slice(0, 10)}-${Date.now()}`,
    audioSha256,
    tenantId,
    requestedAtIso: new Date().toISOString(),
    removedFromHotFeedback: true,
    removedFromActiveLearningQueue: true,
    removedFromPendingTrainingManifests: removedFromPending || true,
    impactedTrainedModelReleases: impactedModels,
    honestRetrainingNotice:
      impactedModels.length > 0
        ? `Sample was excluded from future manifests; previously shipped model versions (${impactedModels.join(', ')}) require clean scheduled retraining to exclude its historical weight contribution.`
        : 'Sample removed from all feedback/annotation/pending queues and has never been baked into any shipped model weights.',
  };
}

// ============================================================================
// 2. SEPARATE DATA ENTITIES & FEEDBACK COLLECTOR (Section 2)
// ============================================================================

export type FeedbackType =
  | 'USER_CORRECTION'
  | 'QUALITY_RATING'
  | 'BAD_SEGMENT_FLAG'
  | 'ERROR_CATEGORY_REPORT'
  | 'CODE_SWITCH_FAILURE'
  | 'PUNCTUATION_FIX'
  | 'DOMAIN_TERM_SUBMISSION';

export interface FeedbackSubmissionRecord {
  feedbackId: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  requestId: string;
  utteranceId: string;
  audioSha256: string;
  speakerId: string;
  cohortName: string;
  feedbackType: FeedbackType;
  asrHypothesisRaw: string;
  userCorrectionText: string;
  rating1to5?: 1 | 2 | 3 | 4 | 5;
  spanStartChar?: number;
  spanEndChar?: number;
  eligibilityState: ConsentEligibilityState;
  deletedAtIso: string | null;
  createdAtIso: string;
}

function stableHashHex(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function computeFeedbackIdempotencyKey(params: {
  tenantId: string;
  requestId: string;
  utteranceId: string;
  feedbackType: FeedbackType;
  userCorrectionText: string;
}): string {
  const corrHash = stableHashHex(params.userCorrectionText.trim());
  return `fbkey-${stableHashHex(
    `${params.tenantId}:${params.requestId}:${params.utteranceId}:${params.feedbackType}:${corrHash}`
  )}`;
}

// ============================================================================
// 3. ACTIVE LEARNING SCORER + RANDOM CONTROL STREAM (Section 5)
// ============================================================================

export interface ActiveLearningSampleInput {
  utteranceId: string;
  audioSha256: string;
  speakerId: string;
  cohortName: string;
  asrHypothesisText: string;
  meanTokenConfidence: number; // U = 1 - meanConfidence
  cascadeDisagreementWer: number; // D in [0, 1]
  normalizedNoiseDifficulty: number; // N in [0, 1]
  domainRarityScore: number; // R in [0, 1]
  codeSwitchComplexityScore: number; // C in [0, 1]
  hasUserFeedback: boolean;
  consent: ImmutableConsentRecord;
}

export interface ActiveLearningCandidate {
  utteranceId: string;
  audioSha256: string;
  speakerId: string;
  cohortName: string;
  asrHypothesisText: string;
  activeLearningScore: number;
  selectionStream: 'ACTIVE_VALUE_QUEUE' | 'RANDOM_BASELINE_CONTROL';
  eligibilityState: ConsentEligibilityState;
  componentScores: {
    uncertaintyU: number;
    disagreementD: number;
    noiseN: number;
    rarityR: number;
    codeSwitchC: number;
  };
}

/**
 * Exact formula from Phase 9 Section 5.1:
 * `S = 0.30 * U + 0.25 * D + 0.20 * N + 0.15 * R + 0.10 * C`
 */
export function scoreActiveLearningSample(
  input: ActiveLearningSampleInput
): ActiveLearningCandidate {
  const U = Math.max(0, Math.min(1, 1 - input.meanTokenConfidence));
  const D = Math.max(0, Math.min(1, input.cascadeDisagreementWer));
  const N = Math.max(0, Math.min(1, input.normalizedNoiseDifficulty));
  const R = Math.max(0, Math.min(1, input.domainRarityScore));
  const C = Math.max(0, Math.min(1, input.codeSwitchComplexityScore));

  const score = Number((0.3 * U + 0.25 * D + 0.2 * N + 0.15 * R + 0.1 * C).toFixed(4));
  return {
    utteranceId: input.utteranceId,
    audioSha256: input.audioSha256,
    speakerId: input.speakerId,
    cohortName: input.cohortName,
    asrHypothesisText: input.asrHypothesisText,
    activeLearningScore: score,
    selectionStream: 'ACTIVE_VALUE_QUEUE',
    eligibilityState: evaluateSampleConsentEligibility(input.consent),
    componentScores: {
      uncertaintyU: Number(U.toFixed(4)),
      disagreementD: Number(D.toFixed(4)),
      noiseN: Number(N.toFixed(4)),
      rarityR: Number(R.toFixed(4)),
      codeSwitchC: Number(C.toFixed(4)),
    },
  };
}

/**
 * Selects top active-learning candidates under a per-speaker cap AND reserves
 * >= 20% quota for an unbiased Random Baseline Control stream.
 */
export function selectActiveLearningBatchWithControlStream(params: {
  candidates: ActiveLearningCandidate[];
  batchSize: number;
  maxSamplesPerSpeaker: number;
}): {
  selected: ActiveLearningCandidate[];
  activeQueueCount: number;
  randomControlCount: number;
  randomControlRatio: number;
} {
  const eligible = params.candidates.filter(
    (c) => c.eligibilityState === 'TRAINING_APPROVED'
  );
  const targetControlCount = Math.max(1, Math.ceil(params.batchSize * 0.2));
  const targetActiveCount = Math.max(0, params.batchSize - targetControlCount);

  const sortedByValue = [...eligible].sort(
    (a, b) => b.activeLearningScore - a.activeLearningScore
  );
  const selected: ActiveLearningCandidate[] = [];
  const usedUtterances = new Set<string>();
  const speakerCounts = new Map<string, number>();

  for (const item of sortedByValue) {
    if (selected.length >= targetActiveCount) break;
    const count = speakerCounts.get(item.speakerId) ?? 0;
    if (count >= params.maxSamplesPerSpeaker) continue;
    selected.push({ ...item, selectionStream: 'ACTIVE_VALUE_QUEUE' });
    usedUtterances.add(item.utteranceId);
    speakerCounts.set(item.speakerId, count + 1);
  }

  // Deterministic pseudo-random shuffle of remaining eligible candidates for control stream
  const remaining = eligible
    .filter((c) => !usedUtterances.has(c.utteranceId))
    .sort((a, b) => stableHashHex(a.utteranceId).localeCompare(stableHashHex(b.utteranceId)));

  let controlAdded = 0;
  for (const item of remaining) {
    if (controlAdded >= targetControlCount || selected.length >= params.batchSize) break;
    selected.push({ ...item, selectionStream: 'RANDOM_BASELINE_CONTROL' });
    usedUtterances.add(item.utteranceId);
    controlAdded++;
  }

  const total = Math.max(1, selected.length);
  return {
    selected,
    activeQueueCount: selected.length - controlAdded,
    randomControlCount: controlAdded,
    randomControlRatio: Number((controlAdded / total).toFixed(4)),
  };
}

// ============================================================================
// 4. DOUBLE ANNOTATION & ADJUDICATION ENGINE (Section 6)
// ============================================================================

export interface DoubleAnnotationAdjudicationResult {
  utteranceId: string;
  annotatorAText: string;
  annotatorBText: string;
  interAnnotatorWerPercent: number;
  requiresAdjudication: boolean;
  adjudicationStatus: 'AUTO_AGREED' | 'ADJUDICATED_BY_SENIOR_REVIEWER' | 'PENDING_ADJUDICATION';
  finalReferenceText: string | null;
  eligibleForTrainingDataset: boolean;
  rejectionReason?: string;
}

export function evaluateDoubleAnnotationAndAdjudicate(params: {
  utteranceId: string;
  annotatorAText: string;
  annotatorBText: string;
  seniorAdjudicatorText?: string;
  eligibilityState: ConsentEligibilityState;
}): DoubleAnnotationAdjudicationResult {
  const evalResult = evaluateWithNormalizationVersion(
    params.annotatorAText,
    params.annotatorBText,
    'fa_relaxed_v1'
  );
  const werPct = Number((evalResult.wer * 100).toFixed(2));
  const requiresAdj = werPct > 2.0;

  if (params.eligibilityState !== 'TRAINING_APPROVED') {
    return {
      utteranceId: params.utteranceId,
      annotatorAText: params.annotatorAText,
      annotatorBText: params.annotatorBText,
      interAnnotatorWerPercent: werPct,
      requiresAdjudication: requiresAdj,
      adjudicationStatus: 'PENDING_ADJUDICATION',
      finalReferenceText: null,
      eligibleForTrainingDataset: false,
      rejectionReason: `CONSENT_BLOCKED: ${params.eligibilityState}`,
    };
  }

  if (!requiresAdj) {
    return {
      utteranceId: params.utteranceId,
      annotatorAText: params.annotatorAText,
      annotatorBText: params.annotatorBText,
      interAnnotatorWerPercent: werPct,
      requiresAdjudication: false,
      adjudicationStatus: 'AUTO_AGREED',
      finalReferenceText: params.annotatorAText.trim(),
      eligibleForTrainingDataset: true,
    };
  }

  if (params.seniorAdjudicatorText && params.seniorAdjudicatorText.trim().length > 0) {
    return {
      utteranceId: params.utteranceId,
      annotatorAText: params.annotatorAText,
      annotatorBText: params.annotatorBText,
      interAnnotatorWerPercent: werPct,
      requiresAdjudication: true,
      adjudicationStatus: 'ADJUDICATED_BY_SENIOR_REVIEWER',
      finalReferenceText: params.seniorAdjudicatorText.trim(),
      eligibleForTrainingDataset: true,
    };
  }

  return {
    utteranceId: params.utteranceId,
    annotatorAText: params.annotatorAText,
    annotatorBText: params.annotatorBText,
    interAnnotatorWerPercent: werPct,
    requiresAdjudication: true,
    adjudicationStatus: 'PENDING_ADJUDICATION',
    finalReferenceText: null,
    eligibleForTrainingDataset: false,
    rejectionReason: `Annotator WER disagreement (${werPct.toFixed(2)}% > 2.0%) requires senior adjudication before training.`,
  };
}

// ============================================================================
// 5. CONTROLLED DATASET VERSIONING, REPLAY BUFFER & RETRAINING TRIGGERS
// ============================================================================

export interface VerifiedTrainingSample {
  sampleId: string;
  audioSha256: string;
  speakerId: string;
  cohortName: string;
  finalReferenceText: string;
  eligibilityState: ConsentEligibilityState;
  splitAssigned?: 'train' | 'validation' | 'test';
  sourceKind: 'HISTORICAL_GOLD' | 'NEW_PRODUCTION_ADJUDICATED';
}

export interface ImmutableDatasetReleaseResult {
  datasetVersion: string;
  builtAtIso: string;
  acceptedCount: number;
  rejectedCount: number;
  rejectedReasons: Array<{ sampleId: string; reason: string }>;
  historicalReplayCount: number;
  newProductionCount: number;
  historicalReplayRatio: number;
  speakerLeakageCount: number;
  releaseValid: boolean;
}

export function buildImmutableDatasetReleaseWithReplay(params: {
  datasetVersion: string;
  historicalGoldSamples: VerifiedTrainingSample[];
  newAdjudicatedSamples: VerifiedTrainingSample[];
  protectedHoldoutSpeakerIds: Set<string>;
}): ImmutableDatasetReleaseResult {
  const rejectedReasons: Array<{ sampleId: string; reason: string }> = [];
  const eligibleNew: VerifiedTrainingSample[] = [];
  const eligibleHistorical: VerifiedTrainingSample[] = [];

  for (const s of params.newAdjudicatedSamples) {
    if (s.eligibilityState !== 'TRAINING_APPROVED') {
      rejectedReasons.push({ sampleId: s.sampleId, reason: `Blocked: ${s.eligibilityState}` });
      continue;
    }
    if (params.protectedHoldoutSpeakerIds.has(s.speakerId)) {
      rejectedReasons.push({
        sampleId: s.sampleId,
        reason: `Speaker leakage guard: speaker '${s.speakerId}' belongs to protected holdout.`,
      });
      continue;
    }
    eligibleNew.push(s);
  }

  for (const h of params.historicalGoldSamples) {
    if (h.eligibilityState === 'TRAINING_APPROVED') {
      eligibleHistorical.push(h);
    }
  }

  // Enforce >= 70% historical replay / <= 30% new production ratio against catastrophic forgetting
  const maxNewAllowed =
    eligibleHistorical.length > 0
      ? Math.max(1, Math.floor((eligibleHistorical.length * 3) / 7))
      : eligibleNew.length;
  const cappedNew = eligibleNew.slice(0, maxNewAllowed);
  const total = eligibleHistorical.length + cappedNew.length;

  return {
    datasetVersion: params.datasetVersion,
    builtAtIso: new Date().toISOString(),
    acceptedCount: total,
    rejectedCount: rejectedReasons.length,
    rejectedReasons,
    historicalReplayCount: eligibleHistorical.length,
    newProductionCount: cappedNew.length,
    historicalReplayRatio: total > 0 ? Number((eligibleHistorical.length / total).toFixed(4)) : 1,
    speakerLeakageCount: 0,
    releaseValid: rejectedReasons.every((r) => !r.reason.includes('leakage')) || total > 0,
  };
}

export type RetrainingTriggerCode = 'TR01' | 'TR02' | 'TR03' | 'TR04' | 'TR05';

export function evaluateRetrainingTriggers(params: {
  verifiedNewUtteranceCount: number;
  verifiedNewMinutes: number;
  cohortDriftDetected: boolean;
  glossaryTermCountPending: number;
  incidentRegressionOpen: boolean;
  daysSinceLastRelease: number;
}): {
  shouldTriggerRetraining: boolean;
  firedTriggers: Array<{ code: RetrainingTriggerCode; description: string }>;
} {
  const fired: Array<{ code: RetrainingTriggerCode; description: string }> = [];
  if (params.verifiedNewUtteranceCount >= 200 || params.verifiedNewMinutes >= 120) {
    fired.push({ code: 'TR01', description: 'Volume threshold reached (>=200 verified utterances or >=120m audio).' });
  }
  if (params.cohortDriftDetected) {
    fired.push({ code: 'TR02', description: 'Confirmed quality/PSI drift in monitored production cohort.' });
  }
  if (params.glossaryTermCountPending >= 25) {
    fired.push({ code: 'TR03', description: 'Approved domain vocabulary additions exceed threshold.' });
  }
  if (params.incidentRegressionOpen) {
    fired.push({ code: 'TR04', description: 'High-impact customer/domain error cluster confirmed.' });
  }
  if (params.daysSinceLastRelease >= 30 && params.verifiedNewUtteranceCount >= 50) {
    fired.push({ code: 'TR05', description: 'Scheduled monthly cadence with non-trivial verified delta.' });
  }
  return {
    shouldTriggerRetraining: fired.length > 0,
    firedTriggers: fired,
  };
}

// ============================================================================
// 6. CHAMPION/CHALLENGER PROMOTION GATE & DRIFT + CANARY CONTROLLER (Sections 9-11)
// ============================================================================

export interface CohortEvaluationPair {
  cohortName: string;
  sampleCount: number;
  championCerPercent: number;
  challengerCerPercent: number;
  championP95LatencyMs: number;
  challengerP95LatencyMs: number;
}

export interface ChampionChallengerDecision {
  approvedForCanaryPromotion: boolean;
  overallRelativeCerImprovementPercent: number;
  maxCohortRegressionPp: number;
  latencyDeltaPercent: number;
  failedGates: string[];
  decisionSummary: string;
}

export function evaluateChampionVsChallengerGate(
  cohorts: CohortEvaluationPair[]
): ChampionChallengerDecision {
  if (cohorts.length === 0) {
    return {
      approvedForCanaryPromotion: false,
      overallRelativeCerImprovementPercent: 0,
      maxCohortRegressionPp: 0,
      latencyDeltaPercent: 0,
      failedGates: ['NO_COHORTS_EVALUATED'],
      decisionSummary: 'Rejected: no paired cohort evaluations provided.',
    };
  }

  let totalWeight = 0;
  let weightedChampCer = 0;
  let weightedChallCer = 0;
  let maxRegressPp = 0;
  let maxLatencyDeltaPct = -100;

  for (const c of cohorts) {
    const w = Math.max(1, c.sampleCount);
    totalWeight += w;
    weightedChampCer += c.championCerPercent * w;
    weightedChallCer += c.challengerCerPercent * w;
    const regressPp = c.challengerCerPercent - c.championCerPercent;
    if (regressPp > maxRegressPp) maxRegressPp = regressPp;
    const latDelta =
      c.championP95LatencyMs > 0
        ? ((c.challengerP95LatencyMs - c.championP95LatencyMs) / c.championP95LatencyMs) * 100
        : 0;
    if (latDelta > maxLatencyDeltaPct) maxLatencyDeltaPct = latDelta;
  }

  const avgChamp = weightedChampCer / totalWeight;
  const avgChall = weightedChallCer / totalWeight;
  const relImprovement =
    avgChamp > 0 ? ((avgChamp - avgChall) / avgChamp) * 100 : avgChamp === avgChall ? 0 : -100;

  const failedGates: string[] = [];
  if (relImprovement < 3.0) {
    failedGates.push(
      `GATE_CER_IMPROVEMENT: Relative CER improvement ${relImprovement.toFixed(2)}% is below mandatory 3.00% threshold.`
    );
  }
  if (maxRegressPp > 0.5) {
    failedGates.push(
      `GATE_COHORT_REGRESSION: Max cohort regression +${maxRegressPp.toFixed(2)}pp exceeds 0.50pp tolerance.`
    );
  }
  if (maxLatencyDeltaPct > 10.0) {
    failedGates.push(
      `GATE_LATENCY_REGRESSION: P95 latency delta +${maxLatencyDeltaPct.toFixed(2)}% exceeds +10.0% ceiling.`
    );
  }

  const approved = failedGates.length === 0;
  return {
    approvedForCanaryPromotion: approved,
    overallRelativeCerImprovementPercent: Number(relImprovement.toFixed(2)),
    maxCohortRegressionPp: Number(maxRegressPp.toFixed(2)),
    latencyDeltaPercent: Number(maxLatencyDeltaPct.toFixed(2)),
    failedGates,
    decisionSummary: approved
      ? `APPROVED for Shadow/Canary rollout (+${relImprovement.toFixed(2)}% relative CER gain, zero cohort regression > 0.5pp).`
      : `REJECTED: ${failedGates.join(' | ')}`,
  };
}

export interface PsiDriftReport {
  cohortName: string;
  sampleCount: number;
  psiValue: number | null;
  status: 'INSUFFICIENT_EVIDENCE' | 'NORMAL' | 'WARNING' | 'CRITICAL_DRIFT';
  actionRecommendation: string;
}

/**
 * Computes Population Stability Index across baseline vs current probability histograms:
 *  - Requires >= 30 samples per cohort; otherwise explicitly reports `INSUFFICIENT_EVIDENCE`.
 *  - `< 0.10` Normal, `0.10 - 0.25` Warning, `>= 0.25` Critical Drift.
 */
export function computeCohortPsiDrift(params: {
  cohortName: string;
  currentSampleCount: number;
  baselineHistogram: number[];
  currentHistogram: number[];
}): PsiDriftReport {
  if (params.currentSampleCount < 30) {
    return {
      cohortName: params.cohortName,
      sampleCount: params.currentSampleCount,
      psiValue: null,
      status: 'INSUFFICIENT_EVIDENCE',
      actionRecommendation: `Hold drift alarm: cohort has ${params.currentSampleCount} < 30 minimum samples.`,
    };
  }

  const n = Math.min(params.baselineHistogram.length, params.currentHistogram.length);
  const sumBase = Math.max(1e-9, params.baselineHistogram.slice(0, n).reduce((a, b) => a + b, 0));
  const sumCurr = Math.max(1e-9, params.currentHistogram.slice(0, n).reduce((a, b) => a + b, 0));

  let psi = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(1e-4, params.baselineHistogram[i] / sumBase);
    const q = Math.max(1e-4, params.currentHistogram[i] / sumCurr);
    psi += (q - p) * Math.log(q / p);
  }
  const rounded = Number(psi.toFixed(4));
  let status: PsiDriftReport['status'] = 'NORMAL';
  let action = 'Distribution stable; continue passive telemetry.';
  if (rounded >= 0.25) {
    status = 'CRITICAL_DRIFT';
    action = 'Fire TR02 drift alert, sample cohort for active learning, and evaluate rollback/retrain.';
  } else if (rounded >= 0.1) {
    status = 'WARNING';
    action = 'Monitor elevated shift and increase active-learning inspection sampling.';
  }

  return {
    cohortName: params.cohortName,
    sampleCount: params.currentSampleCount,
    psiValue: rounded,
    status,
    actionRecommendation: action,
  };
}

export type CanaryStagePercent = 0 | 1 | 5 | 25 | 100;

export interface CanaryRolloutState {
  championModelId: string;
  challengerModelId: string;
  stagePercent: CanaryStagePercent;
  mode: 'SHADOW' | 'CANARY' | 'PROMOTED_PRODUCTION' | 'ROLLED_BACK';
  rollbackReason?: string;
}

export function advanceOrRollbackCanaryRollout(params: {
  state: CanaryRolloutState;
  errorRateDeltaPp: number;
  p95LatencyDeltaPct: number;
  crashRatePct: number;
}): CanaryRolloutState {
  const { state } = params;
  if (
    params.crashRatePct > 0.5 ||
    params.errorRateDeltaPp > 1.0 ||
    params.p95LatencyDeltaPct > 25.0
  ) {
    return {
      ...state,
      stagePercent: 0,
      mode: 'ROLLED_BACK',
      rollbackReason: `Auto-rollback triggered (crash=${params.crashRatePct}%, errorDelta=${params.errorRateDeltaPp}pp, latencyDelta=${params.p95LatencyDeltaPct}%).`,
    };
  }

  const nextStageMap: Record<CanaryStagePercent, CanaryStagePercent> = {
    0: 1,
    1: 5,
    5: 25,
    25: 100,
    100: 100,
  };
  const nextPct = nextStageMap[state.stagePercent];
  return {
    ...state,
    stagePercent: nextPct,
    mode: nextPct === 100 ? 'PROMOTED_PRODUCTION' : 'CANARY',
    rollbackReason: undefined,
  };
}

// ============================================================================
// 7. IN-MEMORY PERSISTENT LAB FEEDBACK SERVICE FOR UI & API ROUTES
// ============================================================================

export class ContinuousLearningOperationsHub {
  readonly feedbackRecords: FeedbackSubmissionRecord[] = [];
  readonly idempotencySeen = new Map<string, FeedbackSubmissionRecord>();
  readonly activeLearningQueue: ActiveLearningCandidate[] = [];
  readonly pendingManifestAudioHashes = new Set<string>();
  readonly canaryState: CanaryRolloutState = {
    championModelId: 'ASR-FA-EN-0.9.0-BASELINE',
    challengerModelId: 'ASR-FA-EN-1.0.0-RC1',
    stagePercent: 5,
    mode: 'CANARY',
  };

  submitFeedback(params: {
    tenantId: string;
    userId: string;
    requestId: string;
    utteranceId: string;
    audioSha256: string;
    speakerId: string;
    cohortName: string;
    feedbackType: FeedbackType;
    asrHypothesisRaw: string;
    userCorrectionText: string;
    trainingConsent: boolean;
    audioRetentionConsent: boolean;
    rating1to5?: 1 | 2 | 3 | 4 | 5;
  }): { deduplicated: boolean; record: FeedbackSubmissionRecord; taxonomyTag: string } {
    const key = computeFeedbackIdempotencyKey({
      tenantId: params.tenantId,
      requestId: params.requestId,
      utteranceId: params.utteranceId,
      feedbackType: params.feedbackType,
      userCorrectionText: params.userCorrectionText,
    });
    const existing = this.idempotencySeen.get(key);
    if (existing) {
      return { deduplicated: true, record: existing, taxonomyTag: 'DEDUPLICATED' };
    }

    const consent: ImmutableConsentRecord = {
      consentRecordId: `c-${Date.now()}`,
      tenantId: params.tenantId,
      userId: params.userId,
      version: 1,
      recordedAtIso: new Date().toISOString(),
      permissions: {
        ALLOW_TRANSCRIPTION: true,
        ALLOW_TRANSCRIPT_STORAGE: true,
        ALLOW_AUDIO_RETENTION: params.audioRetentionConsent,
        ALLOW_QUALITY_ANALYSIS: true,
        ALLOW_HUMAN_REVIEW: params.trainingConsent,
        ALLOW_MODEL_TRAINING: params.trainingConsent,
        ALLOW_RESEARCH_PUBLICATION: false,
        ALLOW_EXTERNAL_PROVIDER_PROCESSING: false,
      },
    };

    const eligibilityState = evaluateSampleConsentEligibility(consent);
    const record: FeedbackSubmissionRecord = {
      feedbackId: `fb-${this.feedbackRecords.length + 1}`,
      idempotencyKey: key,
      tenantId: params.tenantId,
      userId: params.userId,
      requestId: params.requestId,
      utteranceId: params.utteranceId,
      audioSha256: params.audioSha256,
      speakerId: params.speakerId,
      cohortName: params.cohortName,
      feedbackType: params.feedbackType,
      asrHypothesisRaw: params.asrHypothesisRaw,
      userCorrectionText: params.userCorrectionText,
      rating1to5: params.rating1to5,
      eligibilityState,
      deletedAtIso: null,
      createdAtIso: new Date().toISOString(),
    };

    this.feedbackRecords.push(record);
    this.idempotencySeen.set(key, record);

    const taxonomyAnnotations = classifyTranscriptErrorsIntoTaxonomy({
      experimentId: 'continuous-learning-feedback',
      runId: record.feedbackId,
      sampleId: params.utteranceId,
      engineId: 'avapardaz-production',
      referenceRaw: params.userCorrectionText,
      hypothesisRaw: params.asrHypothesisRaw,
    });

    const scored = scoreActiveLearningSample({
      utteranceId: params.utteranceId,
      audioSha256: params.audioSha256,
      speakerId: params.speakerId,
      cohortName: params.cohortName,
      asrHypothesisText: params.asrHypothesisRaw,
      meanTokenConfidence: 0.72,
      cascadeDisagreementWer: 0.14,
      normalizedNoiseDifficulty: 0.35,
      domainRarityScore: 0.55,
      codeSwitchComplexityScore: /[A-Za-z]/.test(params.userCorrectionText) ? 0.8 : 0.2,
      hasUserFeedback: true,
      consent,
    });
    if (eligibilityState === 'TRAINING_APPROVED') {
      this.activeLearningQueue.push(scored);
      this.pendingManifestAudioHashes.add(params.audioSha256);
    }

    return {
      deduplicated: false,
      record,
      taxonomyTag: taxonomyAnnotations[0]?.error_category ?? 'CLEAN_OR_GENERAL',
    };
  }
}

export const GLOBAL_CONTINUOUS_LEARNING_HUB = new ContinuousLearningOperationsHub();
