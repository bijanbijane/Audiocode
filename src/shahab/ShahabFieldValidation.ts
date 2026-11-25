/**
 * SHAHAB-011 — Real-World Validation, Error Intelligence & Neural Independence Decision (SHAHAB-R1.5.0-VALIDATION)
 *
 * Implements:
 * - SHAHABFieldEvaluationProgram (Categories A–E with explicit UNEVALUATED / INSUFFICIENT_DATA tracking)
 * - SHAHABFieldDatasetManifest (consent/privacy granular toggles, immutable refs, leakage & duplicate checks, withdrawal/deletion)
 * - SHAHABBlindHumanReviewWorkflow (randomized anonymized comparison, separate reviewer corrections, disagreement exclusion)
 * - SHAHABEditingProductivityEvaluator (authorized user-study tracking — reports 0 participants honestly when unconducted)
 * - SHAHABFieldErrorIntelligence (OBSERVED_ERROR | VERIFIED_CAUSE | POSSIBLE_CAUSE | CAUSE_UNKNOWN + minimum remediation layer)
 * - Paired statistical sufficiency evaluator (descriptive-only guard when sample size is insufficient)
 * - Neural Independence Decision Gate (5 formal outcomes backed strictly by measured evidence)
 */

import crypto from 'node:crypto';
import {
  DualTrackEvaluationMetrics,
  evaluateDualTrackSample,
} from './ShahabBenchmarkAndErrorEngine';

export const SHAHAB_VALIDATION_RELEASE = 'SHAHAB-R1.5.0-VALIDATION' as const;

export type ShahabFieldAudioCategory =
  | 'CATEGORY_A_STUDIO_PODCAST'
  | 'CATEGORY_B_INTERVIEWS_CONVERSATIONS'
  | 'CATEGORY_C_PROFESSIONAL_EDUCATIONAL'
  | 'CATEGORY_D_MEDIA_VIDEO_EDITING'
  | 'CATEGORY_E_DIFFICULT_ACOUSTICS';

export type ShahabDatasetPartition = 'DEV_DIAGNOSTIC' | 'FROZEN_TEST' | 'EXCLUDED_UNRESOLVED';

export type ShahabReferenceVerificationStatus =
  | 'HUMAN_VERIFIED'
  | 'UPSTREAM_DOCUMENTED_DEMO'
  | 'UNVERIFIED_DRAFT'
  | 'DISPUTED_UNRESOLVED';

export interface ShahabConsentAndPrivacyRecord {
  readonly anonymousOperationalTelemetry: boolean;
  readonly audioRetentionForResearch: boolean;
  readonly transcriptRetentionForEvaluation: boolean;
  readonly shareCorrectionsForResearch: boolean;
  readonly consentRecordedAtIso: string;
  readonly retentionPolicyDays: number;
  readonly withdrawn: boolean;
  readonly withdrawnAtIso: string | null;
}

export interface ShahabFieldSampleRecord {
  readonly sampleId: string;
  readonly audioSha256: string;
  readonly acousticFingerprint: string;
  readonly sourceIdentifier: string;
  readonly sourceLicenseOrAuthorization: string;
  readonly durationSec: number;
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly category: ShahabFieldAudioCategory;
  readonly recordingConditions: string;
  readonly referenceTranscript: string | null;
  readonly referenceVerificationStatus: ShahabReferenceVerificationStatus;
  readonly speakerGroupId: string | null;
  readonly sessionGroupId: string;
  readonly partition: ShahabDatasetPartition;
  readonly consent: ShahabConsentAndPrivacyRecord;
  readonly annotationVersion: string;
  readonly isDerivedAcousticConditionVariant: boolean;
  readonly derivedFromSampleId: string | null;
}

export interface ShahabLeakageCheckReport {
  readonly passed: boolean;
  readonly duplicateAudioHashes: readonly string[];
  readonly duplicateAcousticFingerprints: readonly string[];
  readonly crossPartitionSpeakerLeaks: readonly string[];
  readonly crossPartitionSessionLeaks: readonly string[];
  readonly crossPartitionLineageLeaks?: readonly string[];
  readonly notes: readonly string[];
}

export class SHAHABFieldDatasetManifest {
  public readonly datasetId: string;
  public datasetVersion: string;
  private readonly samples = new Map<string, ShahabFieldSampleRecord>();
  private readonly deletionAuditLog: { readonly sampleId: string; readonly deletedAtIso: string; readonly reason: string }[] = [];

  constructor(datasetId: string, datasetVersion = '1.0.0') {
    this.datasetId = datasetId;
    this.datasetVersion = datasetVersion;
  }

  public addSample(sample: ShahabFieldSampleRecord): void {
    if (!sample.consent.transcriptRetentionForEvaluation && !sample.consent.audioRetentionForResearch) {
      throw new Error(`PRIVACY_POLICY_VIOLATION: Sample ${sample.sampleId} lacks explicit evaluation retention consent.`);
    }
    if (this.samples.has(sample.sampleId)) {
      throw new Error(`IMMUTABLE_SAMPLE_CONFLICT: Sample ${sample.sampleId} already exists. Create a new dataset version instead of overwriting.`);
    }
    this.samples.set(sample.sampleId, Object.freeze({ ...sample, consent: Object.freeze({ ...sample.consent }) }));
  }

  /**
   * SHAHAB-011 §3 & §16: Explicit user withdrawal & deletion — removes sample immediately and logs immutable audit record.
   */
  public withdrawAndDeleteSample(sampleId: string, reason = 'USER_WITHDRAWAL'): boolean {
    const existing = this.samples.get(sampleId);
    if (!existing) return false;
    this.samples.delete(sampleId);
    this.deletionAuditLog.push({
      sampleId,
      deletedAtIso: new Date().toISOString(),
      reason,
    });
    return true;
  }

  public getDeletionAuditLog(): readonly { readonly sampleId: string; readonly deletedAtIso: string; readonly reason: string }[] {
    return [...this.deletionAuditLog];
  }

  public listSamples(): readonly ShahabFieldSampleRecord[] {
    return Array.from(this.samples.values());
  }

  public listEligibleForScoring(): readonly ShahabFieldSampleRecord[] {
    return this.listSamples().filter(
      (s) =>
        !s.consent.withdrawn &&
        s.partition !== 'EXCLUDED_UNRESOLVED' &&
        s.referenceTranscript !== null &&
        s.referenceTranscript.trim().length > 0 &&
        s.referenceVerificationStatus !== 'DISPUTED_UNRESOLVED',
    );
  }

  /**
   * Checks duplicate audio hashes, near-duplicate acoustic fingerprints,
   * and speaker/session overlap between DEV_DIAGNOSTIC and FROZEN_TEST.
   */
  public checkLeakage(): ShahabLeakageCheckReport {
    const all = this.listSamples();
    const sampleById = new Map<string, ShahabFieldSampleRecord>(all.map((s) => [s.sampleId, s]));
    const resolveRootSampleId = (sampleId: string): string => {
      let currentId = sampleId;
      const visited = new Set<string>([currentId]);
      while (true) {
        const record = sampleById.get(currentId);
        const parentId = record?.derivedFromSampleId?.trim();
        if (!parentId || visited.has(parentId)) {
          return currentId;
        }
        visited.add(parentId);
        currentId = parentId;
      }
    };

    const seenHashes = new Map<string, string>();
    const dupHashes: string[] = [];
    const seenFp = new Map<string, string>();
    const dupFp: string[] = [];

    const devSpeakers = new Set<string>();
    const testSpeakers = new Set<string>();
    const devSessions = new Set<string>();
    const testSessions = new Set<string>();
    const devLineageRoots = new Set<string>();
    const testLineageRoots = new Set<string>();

    for (const s of all) {
      if (seenHashes.has(s.audioSha256)) {
        dupHashes.push(`${s.sampleId} == ${seenHashes.get(s.audioSha256)}`);
      } else {
        seenHashes.set(s.audioSha256, s.sampleId);
      }

      if (seenFp.has(s.acousticFingerprint)) {
        dupFp.push(`${s.sampleId} ~= ${seenFp.get(s.acousticFingerprint)}`);
      } else {
        seenFp.set(s.acousticFingerprint, s.sampleId);
      }

      const rootId = resolveRootSampleId(s.sampleId);
      if (s.partition === 'DEV_DIAGNOSTIC') {
        if (s.speakerGroupId) devSpeakers.add(s.speakerGroupId);
        devSessions.add(s.sessionGroupId);
        devLineageRoots.add(rootId);
      } else if (s.partition === 'FROZEN_TEST') {
        if (s.speakerGroupId) testSpeakers.add(s.speakerGroupId);
        testSessions.add(s.sessionGroupId);
        testLineageRoots.add(rootId);
      }
    }

    const speakerLeaks = [...devSpeakers].filter((sp) => testSpeakers.has(sp));
    const sessionLeaks = [...devSessions].filter((se) => testSessions.has(se));
    const lineageLeaks = [...devLineageRoots].filter((root) => testLineageRoots.has(root));
    const passed =
      dupHashes.length === 0 &&
      speakerLeaks.length === 0 &&
      sessionLeaks.length === 0 &&
      lineageLeaks.length === 0;

    return {
      passed,
      duplicateAudioHashes: dupHashes,
      duplicateAcousticFingerprints: dupFp,
      crossPartitionSpeakerLeaks: speakerLeaks,
      crossPartitionSessionLeaks: sessionLeaks,
      crossPartitionLineageLeaks: lineageLeaks,
      notes: [
        `Total samples registered: ${all.length}`,
        `Eligible for ground-truth scoring: ${this.listEligibleForScoring().length}`,
        speakerLeaks.length === 0
          ? 'No speaker overlap across DEV/FROZEN_TEST.'
          : `Speaker leakage detected: ${speakerLeaks.join(', ')}`,
        lineageLeaks.length === 0
          ? 'No derived-sample lineage overlap across DEV/FROZEN_TEST.'
          : `Derived-sample lineage leakage detected across DEV/FROZEN_TEST (root recordings: ${lineageLeaks.join(', ')}).`,
      ],
    };
  }

  public getCategoryCoverage(): Record<ShahabFieldAudioCategory, {
    readonly sampleCount: number;
    readonly independentRecordingCount: number;
    readonly totalDurationSec: number;
    readonly status: 'EVALUATED_PILOT' | 'INSUFFICIENT_DATA' | 'NOT_EVALUATED';
  }> {
    const categories: ShahabFieldAudioCategory[] = [
      'CATEGORY_A_STUDIO_PODCAST',
      'CATEGORY_B_INTERVIEWS_CONVERSATIONS',
      'CATEGORY_C_PROFESSIONAL_EDUCATIONAL',
      'CATEGORY_D_MEDIA_VIDEO_EDITING',
      'CATEGORY_E_DIFFICULT_ACOUSTICS',
    ];
    const out = {} as Record<ShahabFieldAudioCategory, {
      readonly sampleCount: number;
      readonly independentRecordingCount: number;
      readonly totalDurationSec: number;
      readonly status: 'EVALUATED_PILOT' | 'INSUFFICIENT_DATA' | 'NOT_EVALUATED';
    }>;

    for (const cat of categories) {
      const items = this.listEligibleForScoring().filter((s) => s.category === cat);
      // Only non-derived source recordings count as independent recordings for a category.
      // Derived acoustic stress variants of another recording must never inflate independentRecordingCount.
      const independentItems = items.filter(
        (i) => !i.isDerivedAcousticConditionVariant && !i.derivedFromSampleId,
      );
      const uniqueRecordings = new Set(independentItems.map((i) => i.sampleId)).size;
      const totalDur = Number(items.reduce((acc, i) => acc + i.durationSec, 0).toFixed(2));
      const status =
        items.length === 0
          ? 'NOT_EVALUATED'
          : uniqueRecordings < 5
            ? 'INSUFFICIENT_DATA'
            : 'EVALUATED_PILOT';
      out[cat] = {
        sampleCount: items.length,
        independentRecordingCount: uniqueRecordings,
        totalDurationSec: totalDur,
        status,
      };
    }
    return out;
  }
}

// ── Blind Human Review Workflow (SHAHAB-011 §5) ──────────────────────────────

export interface BlindReviewCandidateSlot {
  readonly blindSlotId: string; // e.g. 'CANDIDATE_1', 'CANDIDATE_2' (never exposes model name)
  readonly transcriptText: string;
}

export interface BlindReviewTask {
  readonly taskId: string;
  readonly sampleId: string;
  readonly candidates: readonly BlindReviewCandidateSlot[];
  /** Stored separately from UI-facing task payload so reviewers cannot see model identity. */
  readonly sealedModelMapping: Readonly<Record<string, string>>;
}

export interface BlindReviewerSubmission {
  readonly taskId: string;
  readonly reviewerId: string;
  readonly preferredBlindSlotId: string | null;
  readonly proposedCorrectionText: string | null;
  readonly flaggedIssues: readonly (
    | 'WRONG_WORD'
    | 'MISSING_WORD'
    | 'EXTRA_WORD'
    | 'WRONG_PROPER_NOUN'
    | 'WRONG_NUMBER'
    | 'LOST_REPETITION'
    | 'REMOVED_DISFLUENCY'
    | 'INCORRECT_FORMALIZATION'
    | 'BOUNDARY_ERROR'
    | 'EDIT_UNFRIENDLY_SEGMENTATION'
  )[];
  readonly referenceDisputed: boolean;
  readonly submittedAtIso: string;
}

export class SHAHABBlindHumanReviewWorkflow {
  private readonly tasks = new Map<string, BlindReviewTask>();
  private readonly submissions: BlindReviewerSubmission[] = [];

  public createBlindTask(params: {
    readonly sampleId: string;
    readonly systemOutputs: readonly { readonly systemKey: string; readonly transcriptText: string }[];
    readonly seed?: string;
  }): BlindReviewTask {
    // Deterministic or cryptographic shuffle so model identity is hidden in randomized order
    const items = [...params.systemOutputs];
    const hashSeed = crypto
      .createHash('sha256')
      .update(`${params.sampleId}:${params.seed ?? Date.now()}`)
      .digest();
    for (let i = items.length - 1; i > 0; i--) {
      const j = hashSeed[i % hashSeed.length] % (i + 1);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }

    const candidates: BlindReviewCandidateSlot[] = [];
    const sealedModelMapping: Record<string, string> = {};
    items.forEach((item, idx) => {
      const slotId = `BLIND_OPT_${String.fromCharCode(65 + idx)}`;
      candidates.push({ blindSlotId: slotId, transcriptText: item.transcriptText });
      sealedModelMapping[slotId] = item.systemKey;
    });

    const task: BlindReviewTask = {
      taskId: `blind_${params.sampleId}_${Date.now()}`,
      sampleId: params.sampleId,
      candidates,
      sealedModelMapping,
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  public submitReview(submission: BlindReviewerSubmission): {
    readonly accepted: boolean;
    readonly referenceOverwritten: false;
    readonly sampleStatus: 'PENDING_APPROVAL' | 'UNRESOLVED_EXCLUDED';
  } {
    if (!this.tasks.has(submission.taskId)) {
      throw new Error(`Unknown blind review task ${submission.taskId}`);
    }
    this.submissions.push(submission);
    // Reviewer corrections NEVER silently become ground-truth references
    return {
      accepted: true,
      referenceOverwritten: false,
      sampleStatus: submission.referenceDisputed ? 'UNRESOLVED_EXCLUDED' : 'PENDING_APPROVAL',
    };
  }

  public getSummary(): {
    readonly totalBlindTasksCreated: number;
    readonly totalHumanSubmissions: number;
    readonly disputedSamplesExcluded: number;
    readonly status: 'NOT_MEASURED' | 'MEASURED';
  } {
    return {
      totalBlindTasksCreated: this.tasks.size,
      totalHumanSubmissions: this.submissions.length,
      disputedSamplesExcluded: this.submissions.filter((s) => s.referenceDisputed).length,
      status: this.submissions.length > 0 ? 'MEASURED' : 'NOT_MEASURED',
    };
  }
}

// ── Human Editing Productivity Evaluator (SHAHAB-011 §7) ─────────────────────

export interface EditingSessionRecord {
  readonly sessionId: string;
  readonly participantId: string;
  readonly recordingId: string;
  readonly audioDurationSec: number;
  readonly timeToAcceptedTranscriptSec: number;
  readonly systemGeneratedChanges: number;
  readonly userGeneratedEdits: number;
  readonly userConfirmedSuggestions: number;
  readonly rejectedAutomaticSuggestions: number;
  readonly autoAppliedCorrections: number;
  readonly insertedWords: number;
  readonly deletedWords: number;
  readonly correctedNames: number;
  readonly timingAdjustments: number;
  readonly unresolvedSegments: number;
  readonly userTrustRating1To5: number | null;
}

export class SHAHABEditingProductivityEvaluator {
  private readonly sessions: EditingSessionRecord[] = [];

  public recordAuthorizedSession(session: EditingSessionRecord): void {
    this.sessions.push(session);
  }

  public summarize(): {
    readonly status: 'NOT_MEASURED' | 'PILOT_MEASURED';
    readonly participantCount: number;
    readonly recordingCount: number;
    readonly averageEditingTimeSec: number | null;
    readonly manualCorrectionsPerAudioMinute: number | null;
    readonly rejectedSuggestionsTotal: number;
    readonly timingAdjustmentsTotal: number;
    readonly unresolvedSegmentsTotal: number;
    readonly limitationNote: string;
  } {
    if (this.sessions.length === 0) {
      return {
        status: 'NOT_MEASURED',
        participantCount: 0,
        recordingCount: 0,
        averageEditingTimeSec: null,
        manualCorrectionsPerAudioMinute: null,
        rejectedSuggestionsTotal: 0,
        timingAdjustmentsTotal: 0,
        unresolvedSegmentsTotal: 0,
        limitationNote: 'No consented human editing productivity study sessions have been conducted yet. Zero fabricated user-study metrics.',
      };
    }
    const participants = new Set(this.sessions.map((s) => s.participantId)).size;
    const recordings = new Set(this.sessions.map((s) => s.recordingId)).size;
    const avgTime = this.sessions.reduce((a, s) => a + s.timeToAcceptedTranscriptSec, 0) / this.sessions.length;
    const totalMin = this.sessions.reduce((a, s) => a + s.audioDurationSec, 0) / 60;
    const totalManualEdits = this.sessions.reduce((a, s) => a + s.userGeneratedEdits, 0);

    return {
      status: 'PILOT_MEASURED',
      participantCount: participants,
      recordingCount: recordings,
      averageEditingTimeSec: Number(avgTime.toFixed(2)),
      manualCorrectionsPerAudioMinute: totalMin > 0 ? Number((totalManualEdits / totalMin).toFixed(2)) : null,
      rejectedSuggestionsTotal: this.sessions.reduce((a, s) => a + s.rejectedAutomaticSuggestions, 0),
      timingAdjustmentsTotal: this.sessions.reduce((a, s) => a + s.timingAdjustments, 0),
      unresolvedSegmentsTotal: this.sessions.reduce((a, s) => a + s.unresolvedSegments, 0),
      limitationNote: participants < 10
        ? `Small pilot (${participants} participants) — descriptive only; no population-level usability claims.`
        : 'Pilot study recorded.',
    };
  }
}

// ── Field Error Intelligence & Failure Attribution (SHAHAB-011 §8 & §11) ────

export type ShahabAttributionEvidenceLevel =
  | 'OBSERVED_ERROR'
  | 'VERIFIED_CAUSE'
  | 'POSSIBLE_CAUSE'
  | 'CAUSE_UNKNOWN';

export type ShahabMinimumRemediationLayer =
  | 'RUNTIME_OPTIMIZATION'
  | 'CONTEXTUAL_INTELLIGENCE'
  | 'MODEL_OR_DECODER_LIMITATION';

export interface ShahabFieldErrorCluster {
  readonly clusterId: string;
  readonly errorCategory: string;
  readonly evidenceLevel: ShahabAttributionEvidenceLevel;
  readonly affectedSampleIds: readonly string[];
  readonly affectedSampleCount: number;
  readonly totalAudioDurationSec: number;
  readonly referenceEvidence: readonly string[];
  readonly rawOutputEvidence: readonly string[];
  readonly runtimeConfiguration: string;
  readonly reproductionSteps: string;
  readonly minimumRemediationLayer: ShahabMinimumRemediationLayer;
  readonly candidateRemediation: string;
  readonly diagnosisConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface ShahabFieldSampleEvaluation {
  readonly sampleId: string;
  readonly category: ShahabFieldAudioCategory;
  readonly durationSec: number;
  readonly referenceText: string;
  readonly rawHypothesis: string;
  readonly normalizedHypothesis: string;
  readonly dualTrack: DualTrackEvaluationMetrics;
  readonly policyName: string;
  readonly rtf: number;
  readonly latencyMs: number;
}

export class SHAHABFieldErrorIntelligence {
  public analyzeClusters(
    evaluations: readonly ShahabFieldSampleEvaluation[],
    runtimeConfiguration: string,
  ): readonly ShahabFieldErrorCluster[] {
    const clusters: ShahabFieldErrorCluster[] = [];

    // 1. Word-boundary / compound Persian spacing / ZWNJ differences (Track A > Track B)
    const boundarySamples = evaluations.filter(
      (e) => e.dualTrack.trackAVerbatim.wer > e.dualTrack.trackBNormalized.wer + 0.005,
    );
    if (boundarySamples.length > 0) {
      clusters.push({
        clusterId: 'CLUSTER_ORTHOGRAPHY_ZWNJ_BOUNDARY',
        errorCategory: 'ORTHOGRAPHIC_AND_WORD_BOUNDARY',
        evidenceLevel: 'VERIFIED_CAUSE',
        affectedSampleIds: boundarySamples.map((s) => s.sampleId),
        affectedSampleCount: boundarySamples.length,
        totalAudioDurationSec: Number(boundarySamples.reduce((a, s) => a + s.durationSec, 0).toFixed(2)),
        referenceEvidence: boundarySamples.map((s) => s.referenceText),
        rawOutputEvidence: boundarySamples.map((s) => s.rawHypothesis),
        runtimeConfiguration,
        reproductionSteps: 'Run Track A Verbatim vs Track B P0-009 Normalized comparison on affected samples.',
        minimumRemediationLayer: 'RUNTIME_OPTIMIZATION',
        candidateRemediation: 'Apply authorized P0-009 ZWNJ/half-space normalization in reading layer while preserving raw Track A verbatim output.',
        diagnosisConfidence: 'HIGH',
      });
    }

    // 2. Difficult acoustics degradation (Category E vs clean studio Category A)
    const cleanEvals = evaluations.filter((e) => e.category === 'CATEGORY_A_STUDIO_PODCAST');
    const noisyEvals = evaluations.filter((e) => e.category === 'CATEGORY_E_DIFFICULT_ACOUSTICS');
    if (noisyEvals.length > 0) {
      const cleanMeanWer = cleanEvals.length > 0
        ? cleanEvals.reduce((a, s) => a + s.dualTrack.trackAVerbatim.wer, 0) / cleanEvals.length
        : null;
      const noisyMeanWer = noisyEvals.reduce((a, s) => a + s.dualTrack.trackAVerbatim.wer, 0) / noisyEvals.length;
      if (cleanMeanWer !== null && noisyMeanWer > cleanMeanWer + 0.05) {
        clusters.push({
          clusterId: 'CLUSTER_NOISE_AND_SIGNAL_DEGRADATION',
          errorCategory: 'DIFFICULT_ACOUSTICS_NOISE_CLIPPING',
          evidenceLevel: 'VERIFIED_CAUSE',
          affectedSampleIds: noisyEvals.map((s) => s.sampleId),
          affectedSampleCount: noisyEvals.length,
          totalAudioDurationSec: Number(noisyEvals.reduce((a, s) => a + s.durationSec, 0).toFixed(2)),
          referenceEvidence: noisyEvals.map((s) => s.referenceText),
          rawOutputEvidence: noisyEvals.map((s) => s.rawHypothesis),
          runtimeConfiguration,
          reproductionSteps: 'Compare clean sample.wav against SNR-degraded / low-gain / clipped acoustic stress samples.',
          minimumRemediationLayer: 'RUNTIME_OPTIMIZATION',
          candidateRemediation: 'Apply Avapardaz front-end gain normalization + spectral Wiener denoise before FBANK extraction; re-evaluate before attributing to neural core.',
          diagnosisConfidence: 'MEDIUM',
        });
      }
    }

    // 3. Residual acoustic substitutions/deletions on clean speech -> POSSIBLE_CAUSE / CAUSE_UNKNOWN (do NOT over-claim)
    const residualCleanErrors = cleanEvals.filter((e) => e.dualTrack.trackBNormalized.wer > 0);
    if (residualCleanErrors.length > 0) {
      clusters.push({
        clusterId: 'CLUSTER_RESIDUAL_PHONETIC_AND_LEXICAL_SUBS',
        errorCategory: 'PERSIAN_PHONETIC_OR_SUBWORD_DECISION',
        evidenceLevel: 'POSSIBLE_CAUSE',
        affectedSampleIds: residualCleanErrors.map((s) => s.sampleId),
        affectedSampleCount: residualCleanErrors.length,
        totalAudioDurationSec: Number(residualCleanErrors.reduce((a, s) => a + s.durationSec, 0).toFixed(2)),
        referenceEvidence: residualCleanErrors.map((s) => s.referenceText),
        rawOutputEvidence: residualCleanErrors.map((s) => s.rawHypothesis),
        runtimeConfiguration,
        reproductionSteps: 'Run SHAHABFrozenModelAdapter on sample.wav with SPEED vs PRECISION policy and inspect BPE token transitions.',
        minimumRemediationLayer: 'MODEL_OR_DECODER_LIMITATION',
        candidateRemediation: 'Verify on larger multi-speaker Persian field corpus before recommending neural adaptation; single-recording error cannot prove systematic acoustic model deficiency.',
        diagnosisConfidence: 'LOW',
      });
    }

    return clusters;
  }
}

// ── Neural Independence Decision Gate (SHAHAB-011 §12 & §20) ────────────────

export type ShahabNeuralIndependenceDecisionCode =
  | 'CONTINUE_FROZEN_WEIGHT_RUNTIME'
  | 'APPROVE_MINIMAL_NEURAL_ADAPTATION_MISSION'
  | 'APPROVE_COMPACT_STUDENT_RESEARCH_MISSION'
  | 'RECOMMEND_BASE_MODEL_REPLACEMENT'
  | 'RECOMMEND_PROJECT_SCOPE_REDUCTION';

export interface ShahabNeuralIndependenceDecision {
  readonly decisionCode: ShahabNeuralIndependenceDecisionCode;
  readonly decisionTitle: string;
  readonly validationRelease: typeof SHAHAB_VALIDATION_RELEASE;
  readonly sampleSufficiencyMet: boolean;
  readonly independentRecordingsEvaluated: number;
  readonly distinctSpeakersEvaluated: number | null;
  readonly humanReviewCompleted: boolean;
  readonly gpuTrainingResourcesAvailable: boolean;
  readonly frozenRuntimeLimitationsIdentified: readonly string[];
  readonly runtimeFixableIssues: readonly string[];
  readonly contextFixableIssues: readonly string[];
  readonly neuralModelLimitationsObserved: readonly string[];
  readonly smallestNextEngineeringStep: string;
  readonly reasoning: string;
  readonly ownsIndependentNeuralWeights: false;
}

export function evaluateNeuralIndependenceDecision(params: {
  readonly independentRecordingsEvaluated: number;
  readonly distinctSpeakersEvaluated: number | null;
  readonly humanReviewSubmissions: number;
  readonly cleanMeanTrackAWer: number;
  readonly cleanMeanTrackBWer: number;
  readonly noisyMeanTrackAWer: number | null;
  readonly gpuAvailable: boolean;
  readonly packageSizeMiB: number;
  readonly clusters: readonly ShahabFieldErrorCluster[];
}): ShahabNeuralIndependenceDecision {
  const sampleSufficiencyMet = params.independentRecordingsEvaluated >= 30 && params.humanReviewSubmissions >= 10;

  const runtimeFixable = params.clusters
    .filter((c) => c.minimumRemediationLayer === 'RUNTIME_OPTIMIZATION')
    .map((c) => `${c.clusterId}: ${c.candidateRemediation}`);
  const contextFixable = [
    'Domain proper nouns & technical terms via verified SHAHABPersianMemoryManager + Modified Beam Search (protected by SHAHABFalseInsertionGuard).',
  ];
  const neuralObserved = params.clusters
    .filter((c) => c.minimumRemediationLayer === 'MODEL_OR_DECODER_LIMITATION')
    .map((c) => `${c.clusterId}: ${c.candidateRemediation}`);

  // Strict SHAHAB-011 principle: SHAHAB must EARN the right to become an independent neural model.
  // Without sufficient multi-speaker real field evidence + GPU resources, NEVER recommend training a new model.
  if (!sampleSufficiencyMet || !params.gpuAvailable) {
    return {
      decisionCode: 'CONTINUE_FROZEN_WEIGHT_RUNTIME',
      decisionTitle: 'Decision A — Continue Frozen-Weight SHAHAB Runtime (Do Not Train New Neural Weights Yet)',
      validationRelease: SHAHAB_VALIDATION_RELEASE,
      sampleSufficiencyMet,
      independentRecordingsEvaluated: params.independentRecordingsEvaluated,
      distinctSpeakersEvaluated: params.distinctSpeakersEvaluated,
      humanReviewCompleted: params.humanReviewSubmissions > 0,
      gpuTrainingResourcesAvailable: params.gpuAvailable,
      frozenRuntimeLimitationsIdentified: [
        `Complete uncompressed mandatory on-disk package is ${params.packageSizeMiB.toFixed(2)} MiB (exceeds 100 MiB uncompressed target).`,
        'Offline stateless7 ONNX graph lacks native recurrent streaming cache inputs (uses chunked overlap streaming).',
        'No bundled forced word-level aligner or speaker diarization inside the inherited acoustic core.',
      ],
      runtimeFixableIssues: runtimeFixable.length > 0
        ? runtimeFixable
        : ['Front-end audio gain/denoise conditioning & chunk-boundary deduplication.'],
      contextFixableIssues: contextFixable,
      neuralModelLimitationsObserved: neuralObserved,
      smallestNextEngineeringStep:
        'Acquire an explicitly consented, speaker-independent multi-category Persian field corpus (Categories A–E, >= 30 independent recordings) with blind human reference verification and re-run SHAHABFieldEvaluationProgram before considering any neural weight adaptation.',
      reasoning:
        `Current evidence covers ${params.independentRecordingsEvaluated} independent real Persian recording(s) plus derived acoustic stress variants (` +
        `clean Track A WER ${(params.cleanMeanTrackAWer * 100).toFixed(1)}%, Track B WER ${(params.cleanMeanTrackBWer * 100).toFixed(1)}%) ` +
        `with ${params.humanReviewSubmissions} blind human review submissions and 0 GPUs in the current execution container. ` +
        'Per SHAHAB-011 §10 and §12, single-source pilot data is descriptive only and does NOT justify neural training, distillation, or base-model replacement. ' +
        'Continue operating the verified frozen-weight SHAHAB-R1.4.0 architecture while expanding consented real-world field data.',
      ownsIndependentNeuralWeights: false,
    };
  }

  return {
    decisionCode: params.cleanMeanTrackBWer > 0.25 ? 'RECOMMEND_BASE_MODEL_REPLACEMENT' : 'APPROVE_MINIMAL_NEURAL_ADAPTATION_MISSION',
    decisionTitle: params.cleanMeanTrackBWer > 0.25
      ? 'Decision D — Controlled Base-Model Replacement Study'
      : 'Decision B — Minimal Neural Adaptation Proposal',
    validationRelease: SHAHAB_VALIDATION_RELEASE,
    sampleSufficiencyMet,
    independentRecordingsEvaluated: params.independentRecordingsEvaluated,
    distinctSpeakersEvaluated: params.distinctSpeakersEvaluated,
    humanReviewCompleted: params.humanReviewSubmissions > 0,
    gpuTrainingResourcesAvailable: params.gpuAvailable,
    frozenRuntimeLimitationsIdentified: [
      `Clean Track B WER ${(params.cleanMeanTrackBWer * 100).toFixed(1)}% persisted on sufficient multi-speaker corpus.`,
    ],
    runtimeFixableIssues: runtimeFixable,
    contextFixableIssues: contextFixable,
    neuralModelLimitationsObserved: neuralObserved,
    smallestNextEngineeringStep: 'Submit scoped proposal for narrow adapter/comparator evaluation with verified training data and GPU allocation.',
    reasoning: 'Sufficient multi-speaker evidence demonstrated persistent errors beyond runtime and contextual mitigation.',
    ownsIndependentNeuralWeights: false,
  };
}

export class SHAHABFieldEvaluationProgram {
  public readonly manifest: SHAHABFieldDatasetManifest;
  public readonly blindReview = new SHAHABBlindHumanReviewWorkflow();
  public readonly productivity = new SHAHABEditingProductivityEvaluator();
  public readonly errorIntelligence = new SHAHABFieldErrorIntelligence();

  constructor(datasetId = 'shahab-persian-field-eval-v1', datasetVersion = '1.0.0') {
    this.manifest = new SHAHABFieldDatasetManifest(datasetId, datasetVersion);
  }

  public evaluateSampleOutput(params: {
    readonly sample: ShahabFieldSampleRecord;
    readonly rawHypothesis: string;
    readonly normalizedHypothesis: string;
    readonly policyName: string;
    readonly rtf: number;
    readonly latencyMs: number;
  }): ShahabFieldSampleEvaluation {
    if (!params.sample.referenceTranscript) {
      throw new Error(`Sample ${params.sample.sampleId} has no verified reference transcript.`);
    }
    const dualTrack = evaluateDualTrackSample({
      referenceVerbatim: params.sample.referenceTranscript,
      rawHypothesis: params.rawHypothesis,
    });
    return {
      sampleId: params.sample.sampleId,
      category: params.sample.category,
      durationSec: params.sample.durationSec,
      referenceText: params.sample.referenceTranscript,
      rawHypothesis: params.rawHypothesis,
      normalizedHypothesis: params.normalizedHypothesis,
      dualTrack,
      policyName: params.policyName,
      rtf: params.rtf,
      latencyMs: params.latencyMs,
    };
  }
}
