/**
 * SHAHAB-029 — Transcript-Aware Editorial Intelligence, Speech-Content Analysis,
 * Edit Decision Planning & Reversible Edit Policy
 *
 * Architectural Law (Strict 3-Stage Separation: Detect != Decide != Execute):
 * - THIS MODULE DECIDES / PLANS ONLY (produces versioned, reviewable Edit Decision Plans).
 * - NEVER mutates source audio, NEVER mutates raw ASR transcripts, NEVER executes audio cuts.
 * - Conservative preservation defaults: when uncertain, preserve audio & flag for human review.
 * - Separates Risk Classification from Automation Eligibility; ZERO fake confidence percentages.
 */

import crypto from 'node:crypto';
import type { AcousticEventRecord, AudioSceneAnalysisResult } from './ShahabAudioIntelligenceEngine.ts';
import type { AlignmentResult } from './ShahabAlignmentEngine.ts';
import type { DiarizationResult } from './ShahabDiarizationEngine.ts';

export const SHAHAB_EDITORIAL_PLANNER_CONTRACT_VERSION = '1.0.0';
export const SHAHAB_EDP_SCHEMA_VERSION = '1.0.0';

export type EditorialProfileId =
  | 'VERBATIM_PRESERVATION'
  | 'LIGHT_CLEANUP'
  | 'CONVERSATIONAL_CLEANUP'
  | 'PODCAST_EDITING'
  | 'INTERVIEW_EDITING'
  | 'LECTURE_EDITING'
  | 'PRESENTATION_EDITING'
  | 'ARCHIVAL_PRESERVATION'
  | 'CUSTOM_USER_POLICY';

export interface EditorialProfileDefinition {
  readonly profileId: EditorialProfileId;
  readonly profileVersion: string;
  readonly displayName: string;
  readonly displayNameFa: string;
  readonly description: string;
  readonly minLongPauseMs: number;
  readonly targetPauseAfterTrimMs: number;
  readonly breathMarginMs: number;
  readonly allowLongPauseCandidate: boolean;
  readonly allowFillerCandidate: boolean;
  readonly allowRepetitionCandidate: boolean;
  readonly allowFalseStartCandidate: boolean;
  readonly allowLowRiskAutoEligiblePauses: boolean;
  readonly preserveEmphasisAndQuotes: true;
  readonly conservativeDefault: boolean;
}

export const SHAHAB_EDITORIAL_PROFILES: Readonly<Record<EditorialProfileId, EditorialProfileDefinition>> = Object.freeze({
  VERBATIM_PRESERVATION: {
    profileId: 'VERBATIM_PRESERVATION',
    profileVersion: '1.0.0',
    displayName: 'Verbatim Preservation',
    displayNameFa: 'حفظ عین گفتار (Verbatim)',
    description: 'Review-only preservation policy; flags defects/gaps without proposing destructive speech edits.',
    minLongPauseMs: 3000,
    targetPauseAfterTrimMs: 900,
    breathMarginMs: 120,
    allowLongPauseCandidate: false,
    allowFillerCandidate: false,
    allowRepetitionCandidate: false,
    allowFalseStartCandidate: false,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  LIGHT_CLEANUP: {
    profileId: 'LIGHT_CLEANUP',
    profileVersion: '1.0.0',
    displayName: 'Light Cleanup',
    displayNameFa: 'پاک‌سازی ملایم',
    description: 'Suggests trimming only clearly excessive dead silence while keeping natural pacing and breaths.',
    minLongPauseMs: 1800,
    targetPauseAfterTrimMs: 650,
    breathMarginMs: 110,
    allowLongPauseCandidate: true,
    allowFillerCandidate: false,
    allowRepetitionCandidate: false,
    allowFalseStartCandidate: false,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  CONVERSATIONAL_CLEANUP: {
    profileId: 'CONVERSATIONAL_CLEANUP',
    profileVersion: '1.0.0',
    displayName: 'Conversational Cleanup',
    displayNameFa: 'پاک‌سازی محاوره‌ای',
    description: 'Detects long pauses, isolated hesitations/fillers, and clear stutter repetitions for review.',
    minLongPauseMs: 1400,
    targetPauseAfterTrimMs: 500,
    breathMarginMs: 90,
    allowLongPauseCandidate: true,
    allowFillerCandidate: true,
    allowRepetitionCandidate: true,
    allowFalseStartCandidate: true,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  PODCAST_EDITING: {
    profileId: 'PODCAST_EDITING',
    profileVersion: '1.0.0',
    displayName: 'Podcast Editing',
    displayNameFa: 'تدوین پادکست',
    description: 'Balanced podcast tightening for long pauses, isolated Persian fillers, stutters, and signal defects.',
    minLongPauseMs: 1300,
    targetPauseAfterTrimMs: 450,
    breathMarginMs: 95,
    allowLongPauseCandidate: true,
    allowFillerCandidate: true,
    allowRepetitionCandidate: true,
    allowFalseStartCandidate: true,
    allowLowRiskAutoEligiblePauses: true,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  INTERVIEW_EDITING: {
    profileId: 'INTERVIEW_EDITING',
    profileVersion: '1.0.0',
    displayName: 'Interview Editing',
    displayNameFa: 'تدوین مصاحبه',
    description: 'Protects turn-taking and multi-speaker overlaps; flags long dead-air gaps and stutters for human approval.',
    minLongPauseMs: 1600,
    targetPauseAfterTrimMs: 550,
    breathMarginMs: 100,
    allowLongPauseCandidate: true,
    allowFillerCandidate: true,
    allowRepetitionCandidate: true,
    allowFalseStartCandidate: false,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  LECTURE_EDITING: {
    profileId: 'LECTURE_EDITING',
    profileVersion: '1.0.0',
    displayName: 'Lecture Editing',
    displayNameFa: 'تدوین سخنرانی و آموزش',
    description: 'Preserves pedagogical pauses while identifying excessive silence (>2.0s), restarts, and technical dropouts.',
    minLongPauseMs: 2000,
    targetPauseAfterTrimMs: 700,
    breathMarginMs: 110,
    allowLongPauseCandidate: true,
    allowFillerCandidate: true,
    allowRepetitionCandidate: true,
    allowFalseStartCandidate: true,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  PRESENTATION_EDITING: {
    profileId: 'PRESENTATION_EDITING',
    profileVersion: '1.0.0',
    displayName: 'Presentation Editing',
    displayNameFa: 'تدوین ارائه و ویدیو',
    description: 'Tightens pacing around long dead silence and flags hesitations/false starts with mandatory review.',
    minLongPauseMs: 1200,
    targetPauseAfterTrimMs: 420,
    breathMarginMs: 85,
    allowLongPauseCandidate: true,
    allowFillerCandidate: true,
    allowRepetitionCandidate: true,
    allowFalseStartCandidate: true,
    allowLowRiskAutoEligiblePauses: true,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  ARCHIVAL_PRESERVATION: {
    profileId: 'ARCHIVAL_PRESERVATION',
    profileVersion: '1.0.0',
    displayName: 'Archival Preservation',
    displayNameFa: 'آرشیو تاریخی (بدون حذف)',
    description: 'Strict archival mode: never proposes speech removal; emits review-only quality markers.',
    minLongPauseMs: 4000,
    targetPauseAfterTrimMs: 1500,
    breathMarginMs: 150,
    allowLongPauseCandidate: false,
    allowFillerCandidate: false,
    allowRepetitionCandidate: false,
    allowFalseStartCandidate: false,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
  CUSTOM_USER_POLICY: {
    profileId: 'CUSTOM_USER_POLICY',
    profileVersion: '1.0.0',
    displayName: 'Custom User Policy',
    displayNameFa: 'سیاست سفارشی کاربر',
    description: 'User-customized parameters grounded in conservative safety bounds.',
    minLongPauseMs: 1500,
    targetPauseAfterTrimMs: 500,
    breathMarginMs: 100,
    allowLongPauseCandidate: true,
    allowFillerCandidate: true,
    allowRepetitionCandidate: true,
    allowFalseStartCandidate: true,
    allowLowRiskAutoEligiblePauses: false,
    preserveEmphasisAndQuotes: true,
    conservativeDefault: true,
  },
});

export type EditOperationType =
  | 'TRIM_SILENCE_OR_PAUSE'
  | 'REMOVE_FILLER_CANDIDATE'
  | 'REMOVE_REPETITION_CANDIDATE'
  | 'REMOVE_FALSE_START_CANDIDATE'
  | 'FLAG_RECORDING_GAP_REVIEW'
  | 'FLAG_QUALITY_DEFECT_REVIEW'
  | 'FLAG_OVERLAP_REVIEW'
  | 'PRESERVE_SOURCE_RANGE';

export type EditRiskLevel = 'LOW_RISK' | 'MEDIUM_RISK' | 'HIGH_RISK' | 'CRITICAL_PRESERVE_ONLY';

export type AutomationEligibility =
  | 'ELIGIBLE_WITH_POLICY_OPT_IN'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'NEVER_AUTO_APPLY';

export type EditOperationApprovalState =
  | 'PROPOSED_PENDING_REVIEW'
  | 'USER_APPROVED'
  | 'USER_REJECTED'
  | 'USER_PROTECTED_PRESERVE'
  | 'INVALIDATED_STALE';

export type TranscriptAudioConsistencyStatus =
  | 'CONSISTENT_WITH_AVAILABLE_EVIDENCE'
  | 'POTENTIAL_ASR_OMISSION'
  | 'ALIGNMENT_CONFLICT'
  | 'TIMING_INSUFFICIENT_FOR_WORD_CUT'
  | 'UNVERIFIED_MISSING_TRANSCRIPT';

export interface EditSourceSampleRange {
  /** Immutable original source coordinate domain — half-open [startSample, endSample) */
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRateHz: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationMs: number;
  readonly intervalSemantics: 'HALF_OPEN_[startSample,endSample)';
}

export interface EditEvidencePackage {
  readonly acousticEventIds: readonly string[];
  readonly transcriptUnitRef: string | null;
  readonly excerptText: string | null;
  readonly evidenceClasses: readonly (
    | 'DIRECT_SIGNAL_MEASUREMENT'
    | 'TRANSCRIPT_LEXICAL_RULE'
    | 'ALIGNMENT_TIMING_CHECK'
    | 'DIARIZATION_OVERLAP_GUARD'
    | 'CONSISTENCY_CROSS_CHECK'
  )[];
  readonly calibratedConfidenceAvailable: false;
  readonly linguisticContextNote: string;
  readonly breathProtectionApplied: boolean;
  readonly timingPrecisionAvailable: 'SAMPLE_EXACT_ACOUSTIC' | 'WORD_ALIGNED' | 'SEGMENT_ONLY_UNSAFE_FOR_WORD_CUT';
}

export interface EditDecisionOperation {
  readonly operationId: string;
  readonly operationType: EditOperationType;
  readonly sourceRange: EditSourceSampleRange;
  readonly affectedText: string | null;
  readonly riskLevel: EditRiskLevel;
  readonly automationEligibility: AutomationEligibility;
  readonly approvalState: EditOperationApprovalState;
  readonly dependsOnOperationIds: readonly string[];
  readonly transitionHint: {
    readonly recommendedFadeMs: number;
    readonly zeroCrossingSnapAllowed: boolean;
    readonly reason: string;
  };
  readonly evidence: EditEvidencePackage;
  readonly rationale: string;
  readonly rejectionHistory: readonly {
    readonly rejectedAtUtc: string;
    readonly actor: string;
    readonly reason: string;
  }[];
  readonly approvedAtUtc: string | null;
  readonly approvedBy: string | null;
}

export interface ProtectedSourceRange {
  readonly protectionId: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRateHz: number;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAtUtc: string;
}

export interface EditPlanConflictRecord {
  readonly conflictId: string;
  readonly conflictType:
    | 'OVERLAPPING_CUT_RANGES'
    | 'PROTECTED_RANGE_VIOLATION'
    | 'CYCLIC_DEPENDENCY'
    | 'OUT_OF_BOUNDS_RANGE';
  readonly operationIds: readonly string[];
  readonly detail: string;
}

export interface TranscriptAudioConsistencyReport {
  readonly status: TranscriptAudioConsistencyStatus;
  readonly wordTimingAvailable: boolean;
  readonly untranscribedSpeechCount: number;
  readonly alignmentWarnings: readonly string[];
  readonly note: string;
}

export interface TranscriptWordTimingInput {
  readonly wordId: string;
  readonly text: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly timingPrecision: 'WORD_ALIGNED' | 'SEGMENT_ONLY';
}

export interface EditPlanGenerationInput {
  readonly projectId: string;
  readonly audioId: string;
  readonly sourceRevisionId: string;
  readonly transcriptRevisionId?: string | null;
  readonly profileId: EditorialProfileId;
  readonly customProfileOverrides?: Partial<EditorialProfileDefinition>;
  readonly audioScene: AudioSceneAnalysisResult;
  readonly alignment?: AlignmentResult | null;
  readonly diarization?: DiarizationResult | null;
  readonly transcriptText?: string | null;
  readonly wordTimings?: readonly TranscriptWordTimingInput[];
  readonly protectedRanges?: readonly ProtectedSourceRange[];
}

export interface EditDecisionPlan {
  readonly planId: string;
  readonly edpSchemaVersion: string;
  readonly plannerContractVersion: string;
  readonly planRevision: number;
  readonly supersedesPlanId: string | null;
  readonly projectId: string;
  readonly audioId: string;
  readonly sourceRevisionId: string;
  readonly sourcePcmSha256: string;
  readonly transcriptRevisionId: string | null;
  readonly audioSceneAnalysisId: string;
  readonly sampleRateHz: number;
  readonly totalSourceFrames: number;
  readonly profile: EditorialProfileDefinition;
  readonly validityState: 'VALID' | 'STALE_DEPENDENCY_CHANGED';
  readonly staleReason: string | null;
  readonly consistencyReport: TranscriptAudioConsistencyReport;
  readonly operations: readonly EditDecisionOperation[];
  readonly protectedRanges: readonly ProtectedSourceRange[];
  readonly conflicts: readonly EditPlanConflictRecord[];
  readonly planDigestSha256: string;
  readonly summary: {
    readonly totalCandidates: number;
    readonly approvedCutCount: number;
    readonly pendingReviewCount: number;
    readonly rejectedCount: number;
    readonly protectedRangeCount: number;
    readonly estimatedRemovableMsIfAllApproved: number;
  };
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

// Persian isolated hesitation fillers vs context-sensitive lexical words
const PERSIAN_PURE_HESITATION_FILLERS = new Set([
  'اِ',
  'ام',
  'امم',
  'آه',
  'اوهوم',
  'اوم',
  'اه',
  'اِمم',
]);

const PERSIAN_CONTEXT_SENSITIVE_DISCOURSE_MARKERS = new Set([
  'یعنی',
  'خب',
  'حالا',
  'اصلاً',
  'اصلا',
  'ببینید',
  'عرضم',
]);

const PERSIAN_FALSE_START_CUES = new Set(['نه', 'ببخشید', 'منظورم', 'چیزه']);

function normalizeFaWord(w: string): string {
  return w
    .replace(/[\u064A]/g, '\u06CC')
    .replace(/[\u0643]/g, '\u06A9')
    .replace(/[،,.؟?!؛:«»"'()[\]]/g, '')
    .trim();
}

function makeEditRange(startSample: number, endSample: number, sampleRateHz: number): EditSourceSampleRange {
  const s = Math.max(0, Math.round(startSample));
  const e = Math.max(s, Math.round(endSample));
  return {
    startSample: s,
    endSample: e,
    sampleRateHz,
    startSec: Number((s / sampleRateHz).toFixed(6)),
    endSec: Number((e / sampleRateHz).toFixed(6)),
    durationMs: Number((((e - s) / sampleRateHz) * 1000).toFixed(2)),
    intervalSemantics: 'HALF_OPEN_[startSample,endSample)',
  };
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isCutOperationType(t: EditOperationType): boolean {
  return (
    t === 'TRIM_SILENCE_OR_PAUSE' ||
    t === 'REMOVE_FILLER_CANDIDATE' ||
    t === 'REMOVE_REPETITION_CANDIDATE' ||
    t === 'REMOVE_FALSE_START_CANDIDATE'
  );
}

export function detectEditPlanConflicts(
  operations: readonly EditDecisionOperation[],
  protectedRanges: readonly ProtectedSourceRange[],
  totalSourceFrames: number,
): readonly EditPlanConflictRecord[] {
  const conflicts: EditPlanConflictRecord[] = [];
  let seq = 0;

  const activeCuts = operations.filter(
    (op) =>
      isCutOperationType(op.operationType) &&
      op.approvalState !== 'USER_REJECTED' &&
      op.approvalState !== 'USER_PROTECTED_PRESERVE',
  );

  // 1. Out of bounds check
  for (const op of operations) {
    if (op.sourceRange.startSample < 0 || op.sourceRange.endSample > totalSourceFrames) {
      seq++;
      conflicts.push({
        conflictId: `conf_${seq}`,
        conflictType: 'OUT_OF_BOUNDS_RANGE',
        operationIds: [op.operationId],
        detail: `Operation ${op.operationId} [${op.sourceRange.startSample}, ${op.sourceRange.endSample}) exceeds source bounds [0, ${totalSourceFrames}).`,
      });
    }
  }

  // 2. Overlapping cut ranges
  for (let i = 0; i < activeCuts.length; i++) {
    for (let j = i + 1; j < activeCuts.length; j++) {
      const a = activeCuts[i];
      const b = activeCuts[j];
      if (rangesOverlap(a.sourceRange.startSample, a.sourceRange.endSample, b.sourceRange.startSample, b.sourceRange.endSample)) {
        seq++;
        conflicts.push({
          conflictId: `conf_${seq}`,
          conflictType: 'OVERLAPPING_CUT_RANGES',
          operationIds: [a.operationId, b.operationId],
          detail: `Cut operations ${a.operationId} and ${b.operationId} overlap in original source sample coordinates.`,
        });
      }
    }
  }

  // 3. Protected range violation
  for (const op of activeCuts) {
    for (const pr of protectedRanges) {
      if (rangesOverlap(op.sourceRange.startSample, op.sourceRange.endSample, pr.startSample, pr.endSample)) {
        seq++;
        conflicts.push({
          conflictId: `conf_${seq}`,
          conflictType: 'PROTECTED_RANGE_VIOLATION',
          operationIds: [op.operationId],
          detail: `Cut operation ${op.operationId} intersects protected range ${pr.protectionId} (${pr.reason}).`,
        });
      }
    }
  }

  // 4. Cyclic dependency check (DFS 3-color)
  const opMap = new Map(operations.map((o) => [o.operationId, o]));
  const color = new Map<string, 0 | 1 | 2>();
  const dfs = (id: string, stack: string[]) => {
    color.set(id, 1);
    const node = opMap.get(id);
    if (node) {
      for (const dep of node.dependsOnOperationIds) {
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          seq++;
          conflicts.push({
            conflictId: `conf_${seq}`,
            conflictType: 'CYCLIC_DEPENDENCY',
            operationIds: [...stack, dep],
            detail: `Cyclic dependency detected involving ${id} -> ${dep}.`,
          });
        } else if (c === 0 && opMap.has(dep)) {
          dfs(dep, [...stack, dep]);
        }
      }
    }
    color.set(id, 2);
  };
  for (const op of operations) {
    if ((color.get(op.operationId) ?? 0) === 0) {
      dfs(op.operationId, [op.operationId]);
    }
  }

  return conflicts;
}

function computePlanDigest(
  planId: string,
  planRevision: number,
  sourcePcmSha256: string,
  operations: readonly EditDecisionOperation[],
  protectedRanges: readonly ProtectedSourceRange[],
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        planId,
        planRevision,
        sourcePcmSha256,
        ops: operations.map((o) => ({
          id: o.operationId,
          type: o.operationType,
          s: o.sourceRange.startSample,
          e: o.sourceRange.endSample,
          state: o.approvalState,
        })),
        protectedRanges: protectedRanges.map((p) => [p.startSample, p.endSample]),
      }),
    )
    .digest('hex');
}

function summarizePlan(
  operations: readonly EditDecisionOperation[],
  protectedRanges: readonly ProtectedSourceRange[],
): EditDecisionPlan['summary'] {
  let approvedCutCount = 0;
  let pendingReviewCount = 0;
  let rejectedCount = 0;
  let estimatedRemovableMsIfAllApproved = 0;
  for (const op of operations) {
    if (op.approvalState === 'USER_APPROVED' && isCutOperationType(op.operationType)) {
      approvedCutCount++;
      estimatedRemovableMsIfAllApproved += op.sourceRange.durationMs;
    } else if (op.approvalState === 'PROPOSED_PENDING_REVIEW') {
      pendingReviewCount++;
    } else if (op.approvalState === 'USER_REJECTED') {
      rejectedCount++;
    }
  }
  return {
    totalCandidates: operations.length,
    approvedCutCount,
    pendingReviewCount,
    rejectedCount,
    protectedRangeCount: protectedRanges.length,
    estimatedRemovableMsIfAllApproved: Number(estimatedRemovableMsIfAllApproved.toFixed(2)),
  };
}

export class ShahabEditorialPlannerEngine {
  private readonly plans = new Map<string, EditDecisionPlan>();
  private readonly planRevisions = new Map<string, EditDecisionPlan[]>();
  private disposed = false;

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('SHAHAB_EDITORIAL_PLANNER_DISPOSED: Engine instance has been disposed.');
    }
  }

  public listProfiles(): readonly EditorialProfileDefinition[] {
    this.assertActive();
    return Object.values(SHAHAB_EDITORIAL_PROFILES);
  }

  public getPlan(planId: string): EditDecisionPlan | null {
    this.assertActive();
    return this.plans.get(planId) ?? null;
  }

  public getPlanHistory(audioId: string): readonly EditDecisionPlan[] {
    this.assertActive();
    return this.planRevisions.get(audioId) ?? [];
  }

  public dispose(): void {
    this.plans.clear();
    this.planRevisions.clear();
    this.disposed = true;
  }

  /**
   * Generates a versioned, immutable Edit Decision Plan (EDP) strictly in original source coordinates.
   */
  public generateEditPlan(input: EditPlanGenerationInput): EditDecisionPlan {
    this.assertActive();
    const baseProfile = SHAHAB_EDITORIAL_PROFILES[input.profileId] ?? SHAHAB_EDITORIAL_PROFILES.PODCAST_EDITING;
    const profile: EditorialProfileDefinition = {
      ...baseProfile,
      ...(input.customProfileOverrides ?? {}),
      preserveEmphasisAndQuotes: true,
    };

    const sr = input.audioScene.sampleRateHz;
    const totalFrames = input.audioScene.totalFrames;
    const protectedRanges: ProtectedSourceRange[] = [...(input.protectedRanges ?? [])];
    const operations: EditDecisionOperation[] = [];
    let opSeq = 0;

    // Gather overlap & protected intervals from SHAHAB-028 / SHAHAB-026
    const overlapRanges = input.audioScene.events
      .filter((e) => e.eventType === 'OVERLAPPING_SPEECH')
      .map((e) => e.range);
    if (input.diarization) {
      for (const t of input.diarization.turns) {
        if (t.kind === 'OVERLAPPING_SPEECH') {
          overlapRanges.push({
            startSample: t.range.startSample,
            endSample: t.range.endSample,
            sampleRateHz: t.range.sampleRateHz,
            startSec: t.range.startSec,
            endSec: t.range.endSec,
            durationMs: Number(((t.range.endSec - t.range.startSec) * 1000).toFixed(2)),
            startFlicks: t.range.startFlicks,
            endFlicks: t.range.endFlicks,
            intervalSemantics: 'HALF_OPEN_[startSample,endSample)',
          });
        }
      }
    }

    const lowEnergyEvents = input.audioScene.events.filter(
      (e) => e.eventType === 'LOW_ENERGY_SPEECH' || e.breathOrQuietSpeechProtected,
    );

    const overlapsProtected = (s: number, e: number): boolean =>
      protectedRanges.some((p) => rangesOverlap(s, e, p.startSample, p.endSample));

    const overlapsMultiSpeaker = (s: number, e: number): boolean =>
      overlapRanges.some((o) => rangesOverlap(s, e, o.startSample, o.endSample));

    // Extract available word timings (only when explicitly word-aligned!)
    const wordTimings: TranscriptWordTimingInput[] = [];
    if (input.wordTimings && input.wordTimings.length > 0) {
      wordTimings.push(...input.wordTimings);
    } else if (input.alignment) {
      for (const w of input.alignment.words) {
        const range = w.sourceRange ?? w.acousticRange;
        if (range && w.granularity === 'WORD_LEVEL') {
          wordTimings.push({
            wordId: w.wordId,
            text: w.originalSurface,
            startSample: range.startSample,
            endSample: range.endSample,
            timingPrecision: 'WORD_ALIGNED',
          });
        }
      }
    }

    const hasValidWordTiming = wordTimings.some((w) => w.timingPrecision === 'WORD_ALIGNED');

    // 1. Transcript-Audio Consistency Check
    const alignmentWarnings: string[] = [];
    const untranscribedCount = input.audioScene.coverageCrossCheck.untranscribedSpeechRanges.length;
    if (untranscribedCount > 0) {
      alignmentWarnings.push(
        `${untranscribedCount} acoustic speech interval(s) lack transcript coverage (POTENTIAL_ASR_OMISSION) — protected from silence removal.`,
      );
    }
    if (!hasValidWordTiming && (input.transcriptText || input.alignment)) {
      alignmentWarnings.push(
        'Word-level acoustic alignment is absent; lexical filler/repetition candidates are emitted as review-only or deferred rather than unsafe word cuts.',
      );
    }

    const consistencyStatus: TranscriptAudioConsistencyStatus =
      untranscribedCount > 0
        ? 'POTENTIAL_ASR_OMISSION'
        : !input.transcriptText && !input.alignment && wordTimings.length === 0
          ? 'UNVERIFIED_MISSING_TRANSCRIPT'
          : !hasValidWordTiming
            ? 'TIMING_INSUFFICIENT_FOR_WORD_CUT'
            : 'CONSISTENT_WITH_AVAILABLE_EVIDENCE';

    const consistencyReport: TranscriptAudioConsistencyReport = {
      status: consistencyStatus,
      wordTimingAvailable: hasValidWordTiming,
      untranscribedSpeechCount: untranscribedCount,
      alignmentWarnings,
      note:
        consistencyStatus === 'CONSISTENT_WITH_AVAILABLE_EVIDENCE'
          ? 'Acoustic events and word-aligned transcript evidence are consistent for editorial planning.'
          : alignmentWarnings[0] ?? 'Transcript unavailable; operating on acoustic scene evidence only.',
    };

    // 2. Long Silence & Pause Trimming Candidates (breath & low-energy protected)
    if (profile.allowLongPauseCandidate) {
      for (const ev of input.audioScene.events) {
        if (ev.eventType !== 'LONG_SILENCE' && ev.eventType !== 'INTER_UTTERANCE_PAUSE') continue;
        if (ev.range.durationMs < profile.minLongPauseMs) continue;

        // Compute safe interior trim interval preserving breath margins on both sides
        const keepTotalMs = Math.max(profile.targetPauseAfterTrimMs, profile.breathMarginMs * 2);
        const trimMs = ev.range.durationMs - keepTotalMs;
        if (trimMs < 200) continue;

        const leadKeepSamples = Math.round(((keepTotalMs * 0.5) / 1000) * sr);
        const tailKeepSamples = Math.round(((keepTotalMs * 0.5) / 1000) * sr);
        const cutStart = Math.min(totalFrames, ev.range.startSample + leadKeepSamples);
        const cutEnd = Math.max(cutStart, ev.range.endSample - tailKeepSamples);
        if (cutEnd - cutStart < Math.round(0.15 * sr)) continue;

        const intersectsLowEnergy = lowEnergyEvents.some(
          (le) => le.eventId !== ev.eventId && rangesOverlap(cutStart, cutEnd, le.range.startSample, le.range.endSample),
        );
        const intersectsUntranscribed = input.audioScene.coverageCrossCheck.untranscribedSpeechRanges.some((u) =>
          rangesOverlap(cutStart, cutEnd, u.startSample, u.endSample),
        );
        if (intersectsUntranscribed) {
          // Hard Red Line: NEVER cut untranscribed speech!
          continue;
        }
        const protectedHit = overlapsProtected(cutStart, cutEnd);
        const overlapHit = overlapsMultiSpeaker(cutStart, cutEnd);

        const isCleanSilence = !ev.breathOrQuietSpeechProtected && !intersectsLowEnergy && !overlapHit && !protectedHit;
        const riskLevel: EditRiskLevel = protectedHit
          ? 'CRITICAL_PRESERVE_ONLY'
          : isCleanSilence
            ? 'LOW_RISK'
            : 'MEDIUM_RISK';
        const automationEligibility: AutomationEligibility =
          isCleanSilence && profile.allowLowRiskAutoEligiblePauses
            ? 'ELIGIBLE_WITH_POLICY_OPT_IN'
            : 'HUMAN_REVIEW_REQUIRED';

        opSeq++;
        operations.push({
          operationId: `edop_${String(opSeq).padStart(4, '0')}`,
          operationType: 'TRIM_SILENCE_OR_PAUSE',
          sourceRange: makeEditRange(cutStart, cutEnd, sr),
          affectedText: null,
          riskLevel,
          automationEligibility,
          approvalState: protectedHit ? 'USER_PROTECTED_PRESERVE' : 'PROPOSED_PENDING_REVIEW',
          dependsOnOperationIds: [],
          transitionHint: {
            recommendedFadeMs: 12,
            zeroCrossingSnapAllowed: true,
            reason: 'Short equal-power crossfade across pause splice prevents DC step clicks.',
          },
          evidence: {
            acousticEventIds: [ev.eventId],
            transcriptUnitRef: null,
            excerptText: null,
            evidenceClasses: ['DIRECT_SIGNAL_MEASUREMENT', 'CONSISTENCY_CROSS_CHECK'],
            calibratedConfidenceAvailable: false,
            linguisticContextNote: isCleanSilence
              ? `Interior of ${ev.range.durationMs}ms ${ev.eventType}; ${keepTotalMs}ms natural breath/pause margin retained.`
              : `Pause contains adjacent low-energy or overlap context; flagged for mandatory human review.`,
            breathProtectionApplied: true,
            timingPrecisionAvailable: 'SAMPLE_EXACT_ACOUSTIC',
          },
          rationale: `Shorten ${ev.range.durationMs}ms pause by ${Number((((cutEnd - cutStart) / sr) * 1000).toFixed(0))}ms while preserving ${keepTotalMs}ms natural margin.`,
          rejectionHistory: [],
          approvedAtUtc: null,
          approvedBy: null,
        });
      }
    }

    // 3. Persian Filler, Repetition, and False-Start Candidate Detection (requires valid word timing for cuts!)
    if (wordTimings.length > 0) {
      for (let i = 0; i < wordTimings.length; i++) {
        const w = wordTimings[i];
        const norm = normalizeFaWord(w.text);
        const prev = i > 0 ? wordTimings[i - 1] : null;
        const next = i + 1 < wordTimings.length ? wordTimings[i + 1] : null;
        const insideQuotes = w.text.includes('«') || w.text.includes('»') || w.text.includes('"');
        const overlapHit = overlapsMultiSpeaker(w.startSample, w.endSample);
        const protectedHit = overlapsProtected(w.startSample, w.endSample);

        // 3a. Filler detection — distinguish pure hesitation vs meaningful lexical / quoted word
        if (profile.allowFillerCandidate && !insideQuotes) {
          const isPureHesitation = PERSIAN_PURE_HESITATION_FILLERS.has(norm);
          const isContextMarker = PERSIAN_CONTEXT_SENSITIVE_DISCOURSE_MARKERS.has(norm);
          if (isPureHesitation || isContextMarker) {
            const safeWordTiming = w.timingPrecision === 'WORD_ALIGNED';
            opSeq++;
            operations.push({
              operationId: `edop_${String(opSeq).padStart(4, '0')}`,
              operationType: 'REMOVE_FILLER_CANDIDATE',
              sourceRange: makeEditRange(w.startSample, w.endSample, sr),
              affectedText: w.text,
              riskLevel:
                protectedHit || overlapHit || !safeWordTiming
                  ? 'HIGH_RISK'
                  : isPureHesitation
                    ? 'MEDIUM_RISK'
                    : 'HIGH_RISK',
              automationEligibility: 'HUMAN_REVIEW_REQUIRED',
              approvalState: protectedHit ? 'USER_PROTECTED_PRESERVE' : 'PROPOSED_PENDING_REVIEW',
              dependsOnOperationIds: [],
              transitionHint: {
                recommendedFadeMs: 15,
                zeroCrossingSnapAllowed: true,
                reason: 'Voice boundary splice requires short equal-power crossfade and human listening check.',
              },
              evidence: {
                acousticEventIds: [],
                transcriptUnitRef: w.wordId,
                excerptText: `${prev?.text ?? ''} [${w.text}] ${next?.text ?? ''}`.trim(),
                evidenceClasses: ['TRANSCRIPT_LEXICAL_RULE', 'ALIGNMENT_TIMING_CHECK'],
                calibratedConfidenceAvailable: false,
                linguisticContextNote: isPureHesitation
                  ? 'Isolated Persian hesitation filler candidate; requires human approval before execution.'
                  : `Context-sensitive Persian discourse marker ("${w.text}") may carry rhetorical/explanatory meaning; high risk — human review mandatory.`,
                breathProtectionApplied: true,
                timingPrecisionAvailable: safeWordTiming ? 'WORD_ALIGNED' : 'SEGMENT_ONLY_UNSAFE_FOR_WORD_CUT',
              },
              rationale: isPureHesitation
                ? `Detected isolated Persian hesitation filler "${w.text}".`
                : `Detected context-sensitive discourse marker "${w.text}" (potential filler vs meaningful lexical item).`,
              rejectionHistory: [],
              approvedAtUtc: null,
              approvedBy: null,
            });
          }
        }

        // 3b. Immediate repetition detection (distinguish emphasis vs stutter/restart; require valid timing)
        if (profile.allowRepetitionCandidate && prev && !insideQuotes) {
          const prevNorm = normalizeFaWord(prev.text);
          const gapSamples = w.startSample - prev.endSample;
          const gapMs = (gapSamples / sr) * 1000;
          const isExactImmediateRepeat = norm.length > 0 && norm === prevNorm && gapMs >= 0 && gapMs <= 650;
          // Heuristic guard against intentional Persian rhetorical emphasis (e.g., "خیلی خیلی", "آرام آرام", "کم کم")
          const PERSIAN_REDUPLICATION_EMPHASIS = new Set(['خیلی', 'آرام', 'کم', 'تند', 'زود', 'تک', 'دانه', 'یواش', 'اصلا']);
          if (isExactImmediateRepeat && !PERSIAN_REDUPLICATION_EMPHASIS.has(norm)) {
            const safeWordTiming = prev.timingPrecision === 'WORD_ALIGNED' && w.timingPrecision === 'WORD_ALIGNED';
            opSeq++;
            operations.push({
              operationId: `edop_${String(opSeq).padStart(4, '0')}`,
              operationType: 'REMOVE_REPETITION_CANDIDATE',
              sourceRange: makeEditRange(prev.startSample, prev.endSample, sr),
              affectedText: prev.text,
              riskLevel: !safeWordTiming || overlapHit || protectedHit ? 'HIGH_RISK' : 'MEDIUM_RISK',
              automationEligibility: 'HUMAN_REVIEW_REQUIRED',
              approvalState: protectedHit ? 'USER_PROTECTED_PRESERVE' : 'PROPOSED_PENDING_REVIEW',
              dependsOnOperationIds: [],
              transitionHint: {
                recommendedFadeMs: 14,
                zeroCrossingSnapAllowed: true,
                reason: 'Remove first stuttered occurrence while preserving clean second utterance.',
              },
              evidence: {
                acousticEventIds: [],
                transcriptUnitRef: prev.wordId,
                excerptText: `[${prev.text}] ${w.text}`,
                evidenceClasses: ['TRANSCRIPT_LEXICAL_RULE', 'ALIGNMENT_TIMING_CHECK'],
                calibratedConfidenceAvailable: false,
                linguisticContextNote:
                  'Immediate lexical repetition detected; verified not in Persian rhetorical reduplication emphasis list ("خیلی خیلی", etc.).',
                breathProtectionApplied: true,
                timingPrecisionAvailable: safeWordTiming ? 'WORD_ALIGNED' : 'SEGMENT_ONLY_UNSAFE_FOR_WORD_CUT',
              },
              rationale: `Detected immediate word repetition "${prev.text} ${w.text}" (${Math.round(gapMs)}ms gap).`,
              rejectionHistory: [],
              approvedAtUtc: null,
              approvedBy: null,
            });
          }
        }

        // 3c. False start / self-correction cue ("ببخشید", "نه منظورم")
        if (profile.allowFalseStartCandidate && prev && PERSIAN_FALSE_START_CUES.has(norm) && !insideQuotes) {
          const safeWordTiming = prev.timingPrecision === 'WORD_ALIGNED' && w.timingPrecision === 'WORD_ALIGNED';
          opSeq++;
          operations.push({
            operationId: `edop_${String(opSeq).padStart(4, '0')}`,
            operationType: 'REMOVE_FALSE_START_CANDIDATE',
            sourceRange: makeEditRange(prev.startSample, w.endSample, sr),
            affectedText: `${prev.text} ${w.text}`,
            riskLevel: 'HIGH_RISK',
            automationEligibility: 'NEVER_AUTO_APPLY',
            approvalState: protectedHit ? 'USER_PROTECTED_PRESERVE' : 'PROPOSED_PENDING_REVIEW',
            dependsOnOperationIds: [],
            transitionHint: {
              recommendedFadeMs: 18,
              zeroCrossingSnapAllowed: true,
              reason: 'Self-correction boundary is semantically sensitive; requires human listening verification.',
            },
            evidence: {
              acousticEventIds: [],
              transcriptUnitRef: w.wordId,
              excerptText: `[${prev.text} ${w.text}] ${next?.text ?? ''}`.trim(),
              evidenceClasses: ['TRANSCRIPT_LEXICAL_RULE', 'ALIGNMENT_TIMING_CHECK'],
              calibratedConfidenceAvailable: false,
              linguisticContextNote: 'Possible Persian self-correction / false-start cue; NEVER auto-applied.',
              breathProtectionApplied: true,
              timingPrecisionAvailable: safeWordTiming ? 'WORD_ALIGNED' : 'SEGMENT_ONLY_UNSAFE_FOR_WORD_CUT',
            },
            rationale: `Detected potential false start / self-correction around "${prev.text} ${w.text}".`,
            rejectionHistory: [],
            approvedAtUtc: null,
            approvedBy: null,
          });
        }
      }
    }

    // 4. Non-destructive Review Flags for Recording Gaps, Quality Defects (Clipping/Dropout), and Overlaps
    const pushReviewFlag = (ev: AcousticEventRecord, opType: EditOperationType, reason: string) => {
      opSeq++;
      operations.push({
        operationId: `edop_${String(opSeq).padStart(4, '0')}`,
        operationType: opType,
        sourceRange: makeEditRange(ev.range.startSample, ev.range.endSample, sr),
        affectedText: null,
        riskLevel: 'CRITICAL_PRESERVE_ONLY',
        automationEligibility: 'NEVER_AUTO_APPLY',
        approvalState: 'PROPOSED_PENDING_REVIEW',
        dependsOnOperationIds: [],
        transitionHint: {
          recommendedFadeMs: 0,
          zeroCrossingSnapAllowed: false,
          reason: 'Review flag only — no automatic audio deletion.',
        },
        evidence: {
          acousticEventIds: [ev.eventId],
          transcriptUnitRef: null,
          excerptText: null,
          evidenceClasses: ['DIRECT_SIGNAL_MEASUREMENT', 'DIARIZATION_OVERLAP_GUARD'],
          calibratedConfidenceAvailable: false,
          linguisticContextNote: reason,
          breathProtectionApplied: true,
          timingPrecisionAvailable: 'SAMPLE_EXACT_ACOUSTIC',
        },
        rationale: reason,
        rejectionHistory: [],
        approvedAtUtc: null,
        approvedBy: null,
      });
    };

    for (const ev of input.audioScene.events) {
      if (ev.eventType === 'POSSIBLE_RECORDING_GAP') {
        pushReviewFlag(ev, 'FLAG_RECORDING_GAP_REVIEW', `Possible recording gap (${ev.range.durationMs}ms digital silence) flagged for review.`);
      } else if (ev.eventType === 'SIGNAL_DROPOUT' || ev.eventType === 'CLIPPING') {
        pushReviewFlag(ev, 'FLAG_QUALITY_DEFECT_REVIEW', `Technical signal defect (${ev.eventType}, ${ev.range.durationMs}ms) flagged for review.`);
      } else if (ev.eventType === 'OVERLAPPING_SPEECH') {
        pushReviewFlag(ev, 'FLAG_OVERLAP_REVIEW', `Overlapping speech region (${ev.range.durationMs}ms) flagged for manual editorial handling.`);
      }
    }

    const prevHistory = this.planRevisions.get(input.audioId) ?? [];
    const planRevision = prevHistory.length + 1;
    const planId = `edp_${crypto.randomBytes(5).toString('hex')}`;
    const nowUtc = new Date().toISOString();
    const conflicts = detectEditPlanConflicts(operations, protectedRanges, totalFrames);
    const planDigestSha256 = computePlanDigest(
      planId,
      planRevision,
      input.audioScene.sourcePcmSha256,
      operations,
      protectedRanges,
    );

    const plan: EditDecisionPlan = {
      planId,
      edpSchemaVersion: SHAHAB_EDP_SCHEMA_VERSION,
      plannerContractVersion: SHAHAB_EDITORIAL_PLANNER_CONTRACT_VERSION,
      planRevision,
      supersedesPlanId: prevHistory.length > 0 ? prevHistory[prevHistory.length - 1].planId : null,
      projectId: input.projectId,
      audioId: input.audioId,
      sourceRevisionId: input.sourceRevisionId,
      sourcePcmSha256: input.audioScene.sourcePcmSha256,
      transcriptRevisionId: input.transcriptRevisionId ?? null,
      audioSceneAnalysisId: input.audioScene.analysisId,
      sampleRateHz: sr,
      totalSourceFrames: totalFrames,
      profile,
      validityState: 'VALID',
      staleReason: null,
      consistencyReport,
      operations,
      protectedRanges,
      conflicts,
      planDigestSha256,
      summary: summarizePlan(operations, protectedRanges),
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };

    this.plans.set(planId, plan);
    this.planRevisions.set(input.audioId, [...prevHistory, plan]);
    return plan;
  }

  private commitNewPlanRevision(
    current: EditDecisionPlan,
    nextOperations: readonly EditDecisionOperation[],
    nextProtected: readonly ProtectedSourceRange[],
    validityPatch?: { readonly validityState: EditDecisionPlan['validityState']; readonly staleReason: string | null },
  ): EditDecisionPlan {
    const nowUtc = new Date().toISOString();
    const history = this.planRevisions.get(current.audioId) ?? [current];
    const nextRevision = history.length + 1;
    const nextPlanId = `edp_${crypto.randomBytes(5).toString('hex')}`;
    const conflicts = detectEditPlanConflicts(nextOperations, nextProtected, current.totalSourceFrames);
    const digest = computePlanDigest(
      nextPlanId,
      nextRevision,
      current.sourcePcmSha256,
      nextOperations,
      nextProtected,
    );

    const nextPlan: EditDecisionPlan = {
      ...current,
      planId: nextPlanId,
      planRevision: nextRevision,
      supersedesPlanId: current.planId,
      validityState: validityPatch?.validityState ?? current.validityState,
      staleReason: validityPatch ? validityPatch.staleReason : current.staleReason,
      operations: nextOperations,
      protectedRanges: nextProtected,
      conflicts,
      planDigestSha256: digest,
      summary: summarizePlan(nextOperations, nextProtected),
      updatedAtUtc: nowUtc,
    };

    this.plans.set(nextPlanId, nextPlan);
    this.planRevisions.set(current.audioId, [...history, nextPlan]);
    return nextPlan;
  }

  /** Explicit user approval of a single edit operation (returns a new immutable EDP revision). */
  public approveEditOperation(planId: string, operationId: string, actor = 'local-editor'): EditDecisionPlan {
    this.assertActive();
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`EDP_NOT_FOUND: Plan ${planId} does not exist.`);
    if (plan.validityState !== 'VALID') {
      throw new Error(`EDP_STALE: Plan ${planId} is stale (${plan.staleReason}) and cannot approve operations.`);
    }

    const target = plan.operations.find((o) => o.operationId === operationId);
    if (!target) throw new Error(`EDP_OPERATION_NOT_FOUND: Operation ${operationId} not found in ${planId}.`);

    // Refuse approving a cut that intersects a user-protected range
    if (
      isCutOperationType(target.operationType) &&
      plan.protectedRanges.some((p) =>
        rangesOverlap(target.sourceRange.startSample, target.sourceRange.endSample, p.startSample, p.endSample),
      )
    ) {
      throw new Error(`PROTECTED_RANGE_VIOLATION: Operation ${operationId} intersects a user-protected source range.`);
    }

    const nowUtc = new Date().toISOString();
    const nextOps = plan.operations.map((o) =>
      o.operationId === operationId
        ? { ...o, approvalState: 'USER_APPROVED' as const, approvedAtUtc: nowUtc, approvedBy: actor }
        : o,
    );
    return this.commitNewPlanRevision(plan, nextOps, plan.protectedRanges);
  }

  /** Explicit user rejection preserving full rejection history (returns a new immutable EDP revision). */
  public rejectEditOperation(
    planId: string,
    operationId: string,
    reason = 'User declined editorial cut',
    actor = 'local-editor',
  ): EditDecisionPlan {
    this.assertActive();
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`EDP_NOT_FOUND: Plan ${planId} does not exist.`);

    const nowUtc = new Date().toISOString();
    const nextOps = plan.operations.map((o) =>
      o.operationId === operationId
        ? {
            ...o,
            approvalState: 'USER_REJECTED' as const,
            approvedAtUtc: null,
            approvedBy: null,
            rejectionHistory: [...o.rejectionHistory, { rejectedAtUtc: nowUtc, actor, reason }],
          }
        : o,
    );
    return this.commitNewPlanRevision(plan, nextOps, plan.protectedRanges);
  }

  /** Protects an immutable source range so no cut may intersect it. */
  public protectSourceRange(
    planId: string,
    range: { readonly startSample: number; readonly endSample: number; readonly reason: string; readonly actor?: string },
  ): EditDecisionPlan {
    this.assertActive();
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`EDP_NOT_FOUND: Plan ${planId} does not exist.`);
    if (range.startSample < 0 || range.endSample <= range.startSample || range.endSample > plan.totalSourceFrames) {
      throw new Error('INVALID_PROTECTED_RANGE: Protected sample range must lie inside source media bounds.');
    }

    const protection: ProtectedSourceRange = {
      protectionId: `prot_${crypto.randomBytes(4).toString('hex')}`,
      startSample: Math.round(range.startSample),
      endSample: Math.round(range.endSample),
      sampleRateHz: plan.sampleRateHz,
      reason: range.reason,
      createdBy: range.actor ?? 'local-editor',
      createdAtUtc: new Date().toISOString(),
    };
    const nextProtected = [...plan.protectedRanges, protection];

    // Automatically demote any intersecting cut candidate to USER_PROTECTED_PRESERVE
    const nextOps = plan.operations.map((o) => {
      if (
        isCutOperationType(o.operationType) &&
        rangesOverlap(o.sourceRange.startSample, o.sourceRange.endSample, protection.startSample, protection.endSample)
      ) {
        return {
          ...o,
          approvalState: 'USER_PROTECTED_PRESERVE' as const,
          approvedAtUtc: null,
          approvedBy: null,
        };
      }
      return o;
    });

    return this.commitNewPlanRevision(plan, nextOps, nextProtected);
  }

  /** Invalidates all plans for an audioId when source audio or transcript revision changes. */
  public invalidatePlansOnDependencyChange(
    audioId: string,
    reason: string,
  ): readonly EditDecisionPlan[] {
    this.assertActive();
    const history = this.planRevisions.get(audioId);
    if (!history || history.length === 0) return [];
    const latest = history[history.length - 1];
    const invalidatedOps = latest.operations.map((o) => ({
      ...o,
      approvalState: 'INVALIDATED_STALE' as const,
    }));
    const updated = this.commitNewPlanRevision(latest, invalidatedOps, latest.protectedRanges, {
      validityState: 'STALE_DEPENDENCY_CHANGED',
      staleReason: reason,
    });
    return [updated];
  }
}
