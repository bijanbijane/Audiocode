/**
 * PHASE 12D, 12E & 12F — DATASET VERSIONING, GROUP-DISJOINT SPLITTING,
 * LEAKAGE & CONTAMINATION AUDIT, BENCHMARK PROTECTION, JSONL EXPORT & CORPUS METRICS DASHBOARD
 */

import crypto from 'node:crypto';
import { fingerprintBitSimilarity, sha256Hex } from './AudioIngestionAndProfilingEngine';
import { ANNOTATION_POLICY_VERSION, evaluateRightsForPurpose } from './RightsAndAnnotationGovernanceEngine';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  AudioArtifactRecord,
  AudioQualityClass,
  DatasetMembershipRecord,
  DatasetReleaseRecord,
  DatasetReleaseType,
  DatasetSplitName,
  GrowthMilestoneProgress,
  LanguageClassification,
  LeakageAuditReport,
  MultiDimensionalCorpusMetrics,
  RecordingRecord,
  RightsRecord,
  SplitPolicyConfig,
} from './DataFactoryContracts';

export interface DatasetBuildCandidate {
  readonly recording: RecordingRecord;
  readonly rights: RightsRecord | undefined;
  readonly canonicalArtifact: AudioArtifactRecord | undefined;
  readonly annotations: readonly AnnotationRecord[];
  readonly reviews: readonly AnnotationReviewRecord[];
  readonly isAugmentedDerived?: boolean;
}

export interface TrainingManifestJsonlRow {
  readonly dataset_release_id: string;
  readonly recording_id: string;
  readonly artifact_id: string;
  readonly artifact_checksum_sha256: string;
  readonly split: DatasetSplitName;
  readonly speaker_ref: string;
  readonly session_ref: string;
  readonly language: LanguageClassification;
  readonly duration_seconds: number;
  readonly sample_rate: number;
  readonly quality_class: AudioQualityClass;
  readonly transcript_raw: string;
  readonly transcript_normalized_fa_strict: string;
  readonly rights_record_id: string;
}

export const PHASE12_EXPANSION_CHECKPOINTS: ReadonlyArray<{
  id: 'D0' | 'D1' | 'D2' | 'D3' | 'D4';
  targetHours: number;
  purpose: string;
}> = [
  { id: 'D0', targetHours: 30, purpose: 'Pipeline validation and baseline experiments (initial 21h/3h/6h plan target)' },
  { id: 'D1', targetHours: 100, purpose: 'Early data diversity assessment' },
  { id: 'D2', targetHours: 500, purpose: 'More meaningful fine-tuning research' },
  { id: 'D3', targetHours: 2000, purpose: 'Broader model adaptation experiments' },
  { id: 'D4', targetHours: 10000, purpose: 'Larger-scale training research' },
];

function deterministicUnitHash(seed: number, groupKey: string): number {
  const hex = sha256Hex(`${seed}:${groupKey}`).slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

/**
 * Resolves the authoritative transcript for a recording only when human-reviewed / approved / adjudicated.
 * Never promotes unreviewed ASR hypotheses as ground truth.
 */
export function resolveApprovedTranscript(
  annotations: readonly AnnotationRecord[],
  reviews: readonly AnnotationReviewRecord[]
): {
  approved: boolean;
  doubleAnnotated: boolean;
  rawText: string;
  strictText: string;
  reason: string;
} {
  const submittedOrHigher = annotations.filter((a) =>
    ['SUBMITTED', 'REVIEWED', 'APPROVED', 'DISPUTED', 'ADJUDICATION_REQUIRED'].includes(a.status)
  );
  const distinctAnnotators = new Set(submittedOrHigher.map((a) => a.annotatorId));
  const doubleAnnotated = distinctAnnotators.size >= 2;

  const adjudicated = reviews.find(
    (r) => r.reviewStatus === 'ADJUDICATED' && r.adjudicatedSegments && r.adjudicatedSegments.length > 0
  );
  if (adjudicated && adjudicated.adjudicatedSegments) {
    const raw = adjudicated.adjudicatedSegments.map((s) => s.rawText.trim()).filter(Boolean).join(' ');
    return {
      approved: true,
      doubleAnnotated,
      rawText: raw,
      strictText: raw,
      reason: 'APPROVED_VIA_ADJUDICATION',
    };
  }

  const approvedAnn = annotations.find((a) => a.status === 'APPROVED');
  if (approvedAnn) {
    const raw = approvedAnn.segments.map((s) => s.rawText.trim()).filter(Boolean).join(' ');
    return {
      approved: true,
      doubleAnnotated,
      rawText: raw,
      strictText: approvedAnn.normalizedDerivedTextFaStrict,
      reason: 'APPROVED_VIA_REVIEW',
    };
  }

  return {
    approved: false,
    doubleAnnotated,
    rawText: '',
    strictText: '',
    reason: 'UNREVIEWED_OR_DISPUTED_ANNOTATION',
  };
}

/**
 * Runs group-disjoint leakage and contamination audit on a proposed or existing membership set.
 */
export function runLeakageAndContaminationAudit(params: {
  datasetReleaseId: string;
  memberships: readonly DatasetMembershipRecord[];
  candidatesByRecId: ReadonlyMap<string, DatasetBuildCandidate>;
  historicalTrainRecordingIds: ReadonlySet<string>;
  sealedTestRecordingIds: ReadonlySet<string>;
}): LeakageAuditReport {
  const included = params.memberships.filter((m) => m.included);

  // Group records by split
  const splitGroups = new Map<DatasetSplitName, DatasetMembershipRecord[]>();
  for (const m of included) {
    const list = splitGroups.get(m.split) ?? [];
    list.push(m);
    splitGroups.set(m.split, list);
  }

  const shaBySplit = new Map<string, Set<DatasetSplitName>>();
  const speakerBySplit = new Map<string, Set<DatasetSplitName>>();
  const sessionBySplit = new Map<string, Set<DatasetSplitName>>();
  const recBySplit = new Map<string, Set<DatasetSplitName>>();
  const transcriptBySplit = new Map<string, Set<DatasetSplitName>>();

  for (const m of included) {
    const cand = params.candidatesByRecId.get(m.recordingId);
    const shaSet = shaBySplit.get(m.checksumSha256) ?? new Set<DatasetSplitName>();
    shaSet.add(m.split);
    shaBySplit.set(m.checksumSha256, shaSet);

    const spkSet = speakerBySplit.get(m.speakerRef) ?? new Set<DatasetSplitName>();
    spkSet.add(m.split);
    speakerBySplit.set(m.speakerRef, spkSet);

    const sesSet = sessionBySplit.get(m.sessionRef) ?? new Set<DatasetSplitName>();
    sesSet.add(m.split);
    sessionBySplit.set(m.sessionRef, sesSet);

    const recSet = recBySplit.get(m.recordingId) ?? new Set<DatasetSplitName>();
    recSet.add(m.split);
    recBySplit.set(m.recordingId, recSet);

    if (cand) {
      const tx = resolveApprovedTranscript(cand.annotations, cand.reviews);
      if (tx.strictText) {
        const txKey = sha256Hex(tx.strictText.trim());
        const tSet = transcriptBySplit.get(txKey) ?? new Set<DatasetSplitName>();
        tSet.add(m.split);
        transcriptBySplit.set(txKey, tSet);
      }
    }
  }

  let exactDuplicateOverlapCount = 0;
  for (const splits of shaBySplit.values()) if (splits.size > 1) exactDuplicateOverlapCount++;

  let repeatedTranscriptOverlapCount = 0;
  for (const splits of transcriptBySplit.values()) if (splits.size > 1) repeatedTranscriptOverlapCount++;

  const sharedSpeakerOverlapIds: string[] = [];
  for (const [spk, splits] of speakerBySplit.entries()) {
    if (splits.size > 1) sharedSpeakerOverlapIds.push(spk);
  }

  const sharedSessionOverlapIds: string[] = [];
  for (const [ses, splits] of sessionBySplit.entries()) {
    if (splits.size > 1) sharedSessionOverlapIds.push(ses);
  }

  const sourceRecordingOverlapIds: string[] = [];
  for (const [recId, splits] of recBySplit.entries()) {
    if (splits.size > 1) sourceRecordingOverlapIds.push(recId);
  }

  // Probable near-duplicate fingerprint overlap across splits
  let probableNearDuplicatePairCount = 0;
  for (let i = 0; i < included.length; i++) {
    const a = params.candidatesByRecId.get(included[i].recordingId);
    if (!a) continue;
    for (let j = i + 1; j < included.length; j++) {
      if (included[i].split === included[j].split) continue;
      const b = params.candidatesByRecId.get(included[j].recordingId);
      if (!b) continue;
      if (a.recording.checksumSha256 === b.recording.checksumSha256) continue;
      const sim = fingerprintBitSimilarity(a.recording.audioFingerprint, b.recording.audioFingerprint);
      if (sim >= 0.92) {
        probableNearDuplicatePairCount++;
      }
    }
  }

  // Cross-release benchmark contamination check:
  // If any included TRAIN/VALIDATION sample was ever sealed in TEST, OR if a TEST sample appeared in historical TRAIN
  const contaminationIds: string[] = [];
  for (const m of included) {
    if ((m.split === 'TRAIN' || m.split === 'VALIDATION') && params.sealedTestRecordingIds.has(m.recordingId)) {
      contaminationIds.push(m.recordingId);
    }
    if (
      (m.split === 'TEST' || m.split === 'CHALLENGE' || m.split === 'REGRESSION') &&
      params.historicalTrainRecordingIds.has(m.recordingId)
    ) {
      contaminationIds.push(m.recordingId);
    }
  }

  const limitations: string[] = [];
  const totalDurHours = included.reduce((acc, m) => {
    const c = params.candidatesByRecId.get(m.recordingId);
    return acc + (c?.recording.technicalMetadata.durationSeconds ?? 0) / 3600;
  }, 0);
  if (totalDurHours < 30) {
    limitations.push(`CORPUS_BELOW_D0_30H_TARGET: Validated included duration is ${(totalDurHours * 3600).toFixed(1)}s (< 30.0h).`);
  }

  const hasHardViolations =
    exactDuplicateOverlapCount > 0 ||
    sharedSpeakerOverlapIds.length > 0 ||
    sharedSessionOverlapIds.length > 0 ||
    sourceRecordingOverlapIds.length > 0 ||
    contaminationIds.length > 0;

  return {
    auditId: `aud_${crypto.randomUUID().slice(0, 12)}`,
    datasetReleaseId: params.datasetReleaseId,
    status: hasHardViolations
      ? 'FAILED_WITH_VIOLATIONS'
      : limitations.length > 0 || probableNearDuplicatePairCount > 0
        ? 'PASSED_WITH_LIMITATIONS'
        : 'PASSED',
    exactDuplicateOverlapCount,
    probableNearDuplicatePairCount,
    repeatedTranscriptOverlapCount,
    sharedSpeakerOverlapIds,
    sharedSessionOverlapIds,
    sourceRecordingOverlapIds,
    protectedBenchmarkContaminationIds: Array.from(new Set(contaminationIds)),
    speakerDisjointVerified: sharedSpeakerOverlapIds.length === 0 && sharedSessionOverlapIds.length === 0,
    limitations,
    executedAtIso: new Date().toISOString(),
  };
}

/**
 * Builds an immutable, group-disjoint DatasetRelease enforcing rights, annotation QC, and zero leakage.
 */
export function buildImmutableDatasetRelease(params: {
  tenantId: string;
  datasetId: string;
  datasetName: string;
  version: string;
  releaseType: DatasetReleaseType;
  releaseAuthor: string;
  splitPolicy: SplitPolicyConfig;
  candidates: readonly DatasetBuildCandidate[];
  historicalTrainRecordingIds: ReadonlySet<string>;
  sealedTestRecordingIds: ReadonlySet<string>;
}): { release: DatasetReleaseRecord; trainingManifestRows: TrainingManifestJsonlRow[] } {
  const datasetReleaseId = `rel_${crypto.randomUUID().slice(0, 12)}`;
  const excluded: { recordingId: string; reason: string }[] = [];
  const eligible: { cand: DatasetBuildCandidate; tx: ReturnType<typeof resolveApprovedTranscript> }[] = [];

  const requiredPurpose = params.releaseType === 'TRAIN' ? 'TRAINING' : 'EVALUATION';

  for (const cand of params.candidates) {
    const rec = cand.recording;
    if (rec.tenantId !== params.tenantId) continue;
    if (rec.deletedAtIso || rec.ingestionStatus !== 'VALIDATED') {
      excluded.push({ recordingId: rec.recordingId, reason: `INGESTION_STATUS_${rec.ingestionStatus}` });
      continue;
    }
    if (rec.acousticProfile.qualityClass === 'UNUSABLE') {
      excluded.push({ recordingId: rec.recordingId, reason: 'QUALITY_UNUSABLE' });
      continue;
    }
    if (!cand.canonicalArtifact) {
      excluded.push({ recordingId: rec.recordingId, reason: 'MISSING_CANONICAL_16K_ARTIFACT' });
      continue;
    }

    const rightsCheck = evaluateRightsForPurpose(cand.rights, requiredPurpose);
    if (!rightsCheck.allowed) {
      excluded.push({
        recordingId: rec.recordingId,
        reason: `RIGHTS_DENIED:${rightsCheck.reasonCodes.join(',')}`,
      });
      continue;
    }

    // Do not compromise benchmark independence with augmented samples
    if (cand.isAugmentedDerived && params.releaseType !== 'TRAIN') {
      excluded.push({ recordingId: rec.recordingId, reason: 'AUGMENTATION_FORBIDDEN_IN_EVAL_SPLIT' });
      continue;
    }

    const tx = resolveApprovedTranscript(cand.annotations, cand.reviews);
    if (!tx.approved) {
      excluded.push({ recordingId: rec.recordingId, reason: tx.reason });
      continue;
    }

    eligible.push({ cand, tx });
  }

  // Deterministic Group-Level Split Assignment (Speaker + Session atomic group)
  const groupAssignments = new Map<string, DatasetSplitName>();
  const singleTargetSplit: DatasetSplitName = params.releaseType;

  if (params.releaseType !== 'TRAIN') {
    // Dedicated release (e.g. TEST, VALIDATION, CHALLENGE, REGRESSION) pins all eligible groups to that split
    for (const { cand } of eligible) {
      const gKey =
        params.splitPolicy.groupBy === 'SPEAKER_ONLY'
          ? cand.recording.speakerRef
          : params.splitPolicy.groupBy === 'SESSION_ONLY'
            ? cand.recording.sessionRef
            : `${cand.recording.speakerRef}::${cand.recording.sessionRef}`;
      groupAssignments.set(gKey, singleTargetSplit);
    }
  } else {
    // Partition unique speaker groups across TRAIN / VALIDATION / TEST without EVER splitting a speaker or session
    const seenGroups: string[] = [];
    for (const { cand } of eligible) {
      const gKey =
        params.splitPolicy.groupBy === 'SPEAKER_ONLY'
          ? cand.recording.speakerRef
          : params.splitPolicy.groupBy === 'SESSION_ONLY'
            ? cand.recording.sessionRef
            : `${cand.recording.speakerRef}::${cand.recording.sessionRef}`;
      if (!seenGroups.includes(gKey)) seenGroups.push(gKey);
    }

    // Also unify groups that share the same speaker when groupBy === SPEAKER_AND_SESSION so a speaker never leaks across splits
    const speakerSplit = new Map<string, DatasetSplitName>();
    for (const { cand } of eligible) {
      const spk = cand.recording.speakerRef;
      if (speakerSplit.has(spk)) continue;

      if (params.sealedTestRecordingIds.has(cand.recording.recordingId)) {
        speakerSplit.set(spk, 'TEST');
        continue;
      }

      const r = deterministicUnitHash(params.splitPolicy.randomSeed, spk);
      if (r < params.splitPolicy.trainRatio) {
        speakerSplit.set(spk, 'TRAIN');
      } else if (r < params.splitPolicy.trainRatio + params.splitPolicy.valRatio) {
        speakerSplit.set(spk, 'VALIDATION');
      } else {
        speakerSplit.set(spk, 'TEST');
      }
    }

    for (const { cand } of eligible) {
      const spk = cand.recording.speakerRef;
      const gKey = `${spk}::${cand.recording.sessionRef}`;
      groupAssignments.set(gKey, speakerSplit.get(spk) ?? 'TRAIN');
    }
  }

  const memberships: DatasetMembershipRecord[] = [];
  const trainingManifestRows: TrainingManifestJsonlRow[] = [];
  const candidatesByRecId = new Map<string, DatasetBuildCandidate>();

  const langDur: Record<LanguageClassification, number> = {
    fa: 0,
    en: 0,
    'fa-en': 0,
    other: 0,
    unknown: 0,
    uncertain: 0,
  };
  const splitDur: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const uniqueSpeakers = new Set<string>();
  const artifactVersions = new Set<string>();
  let doubleCount = 0;

  for (const { cand, tx } of eligible) {
    const rec = cand.recording;
    const art = cand.canonicalArtifact!;
    candidatesByRecId.set(rec.recordingId, cand);

    const gKey =
      params.splitPolicy.groupBy === 'SPEAKER_ONLY'
        ? rec.speakerRef
        : params.splitPolicy.groupBy === 'SESSION_ONLY'
          ? rec.sessionRef
          : `${rec.speakerRef}::${rec.sessionRef}`;
    const split = groupAssignments.get(gKey) ?? singleTargetSplit;

    memberships.push({
      membershipId: `mem_${crypto.randomUUID().slice(0, 10)}`,
      datasetReleaseId,
      recordingId: rec.recordingId,
      artifactId: art.artifactId,
      split,
      speakerRef: rec.speakerRef,
      sessionRef: rec.sessionRef,
      checksumSha256: rec.checksumSha256,
      included: true,
      inclusionReason: `${tx.reason};RIGHTS_VERIFIED`,
      exclusionReason: null,
    });

    const dur = rec.technicalMetadata.durationSeconds;
    langDur[rec.languageClassification] = Number(
      ((langDur[rec.languageClassification] ?? 0) + dur).toFixed(3)
    );
    splitDur[split] = Number(((splitDur[split] ?? 0) + dur).toFixed(3));
    sourceCounts[rec.sourceCorpusTag] = (sourceCounts[rec.sourceCorpusTag] ?? 0) + 1;
    uniqueSpeakers.add(rec.speakerRef);
    artifactVersions.add(`${art.artifactId}@v${art.artifactVersion}`);
    if (tx.doubleAnnotated) doubleCount++;

    // Protect sealed TEST transcripts from unrestricted training manifest export
    if (split !== 'TEST' || params.releaseType === 'TEST' || params.releaseType === 'REGRESSION') {
      trainingManifestRows.push({
        dataset_release_id: datasetReleaseId,
        recording_id: rec.recordingId,
        artifact_id: art.artifactId,
        artifact_checksum_sha256: art.checksumSha256,
        split,
        speaker_ref: rec.speakerRef,
        session_ref: rec.sessionRef,
        language: rec.languageClassification,
        duration_seconds: dur,
        sample_rate: art.sampleRate,
        quality_class: rec.acousticProfile.qualityClass,
        transcript_raw: tx.rawText,
        transcript_normalized_fa_strict: tx.strictText,
        rights_record_id: rec.rightsRecordId,
      });
    }
  }

  const leakageAudit = runLeakageAndContaminationAudit({
    datasetReleaseId,
    memberships,
    candidatesByRecId,
    historicalTrainRecordingIds: params.historicalTrainRecordingIds,
    sealedTestRecordingIds: params.sealedTestRecordingIds,
  });

  if (leakageAudit.status === 'FAILED_WITH_VIOLATIONS') {
    throw new Error(
      `DATASET_LEAKAGE_BLOCKED: Leakage audit failed (speakersOverlap=${leakageAudit.sharedSpeakerOverlapIds.length}, sessionsOverlap=${leakageAudit.sharedSessionOverlapIds.length}, dupSha=${leakageAudit.exactDuplicateOverlapCount}, contamination=${leakageAudit.protectedBenchmarkContaminationIds.length}).`
    );
  }

  const configHash = sha256Hex(
    JSON.stringify({
      datasetId: params.datasetId,
      version: params.version,
      releaseType: params.releaseType,
      splitPolicy: params.splitPolicy,
      recordingIds: eligible.map((e) => e.cand.recording.recordingId).sort(),
    })
  );

  const sealedTestProtected =
    params.releaseType === 'TEST' ||
    eligible.some((e) => groupAssignments.get(`${e.cand.recording.speakerRef}::${e.cand.recording.sessionRef}`) === 'TEST');

  const release: DatasetReleaseRecord = {
    datasetReleaseId,
    tenantId: params.tenantId,
    datasetId: params.datasetId,
    datasetName: params.datasetName,
    version: params.version,
    releaseType: params.releaseType,
    configurationHash: configHash,
    splitPolicy: params.splitPolicy,
    immutable: true,
    sealedTestProtected,
    releaseStatus: params.releaseType === 'TEST' ? 'SEALED' : 'PUBLISHED',
    manifestArtifactId: `man_${configHash.slice(0, 12)}`,
    sourceRecordingIds: eligible.map((e) => e.cand.recording.recordingId),
    includedArtifactVersions: Array.from(artifactVersions),
    memberships,
    languageDistributionSeconds: langDur,
    durationBySplitSeconds: splitDur,
    uniqueSpeakerCount: uniqueSpeakers.size,
    recordingSourceDistribution: sourceCounts,
    doubleAnnotatedSharePercent:
      eligible.length > 0 ? Number(((doubleCount / eligible.length) * 100).toFixed(2)) : 0,
    excludedRecordingReasons: excluded,
    leakageAudit,
    transcriptPolicyVersion: ANNOTATION_POLICY_VERSION,
    normalizationPolicyVersion: 'fa_strict_v1',
    releaseAuthor: params.releaseAuthor,
    createdAtIso: new Date().toISOString(),
  };

  return { release, trainingManifestRows };
}

/**
 * Computes Section 15 multi-dimensional corpus dashboard metrics.
 * Never reduces dataset quality to one blended number and strictly separates Uploaded vs Validated vs Training-Eligible durations.
 */
export function computeMultiDimensionalCorpusMetrics(params: {
  recordings: readonly RecordingRecord[];
  rightsByRecId: ReadonlyMap<string, RightsRecord>;
  annotationsByRecId: ReadonlyMap<string, AnnotationRecord[]>;
  reviewsByRecId: ReadonlyMap<string, AnnotationReviewRecord[]>;
}): MultiDimensionalCorpusMetrics {
  let uploadedSeconds = 0;
  let validatedSeconds = 0;
  let rightsApprovedSeconds = 0;
  let annotatedSeconds = 0;
  let reviewedSeconds = 0;
  let trainingEligibleSeconds = 0;
  let evaluationEligibleSeconds = 0;
  let rejectedOrQuarantinedSeconds = 0;

  let acceptedRecordingsCount = 0;
  let rejectedOrQuarantinedCount = 0;
  let corruptCount = 0;
  let clippingSum = 0;
  let silenceSum = 0;

  const seenSha = new Set<string>();
  let exactDupCount = 0;
  const fingerprints: string[] = [];
  let nearDupCandidateCount = 0;

  const srDist: Record<string, number> = {};
  const chDist: Record<string, number> = {};
  const qualityDist: Record<AudioQualityClass, number> = {
    CLEAN: 0,
    ACCEPTABLE: 0,
    CHALLENGING: 0,
    POOR: 0,
    UNUSABLE: 0,
    UNKNOWN: 0,
  };

  let totalWords = 0;
  let totalChars = 0;
  const langCounts: Record<LanguageClassification, number> = {
    fa: 0,
    en: 0,
    'fa-en': 0,
    other: 0,
    unknown: 0,
    uncertain: 0,
  };
  let codeSwitchCount = 0;
  let doubleAnnotatedCount = 0;
  let pendingAdjudicationCount = 0;
  let unintelligibleEventsCount = 0;

  const speakerDur = new Map<string, number>();
  const sessions = new Set<string>();
  const sources = new Set<string>();
  const domainDist: Record<string, number> = {};

  let verifiedRightsCount = 0;
  let consentRevokedCount = 0;
  let legalHoldCount = 0;
  let unresolvedRightsCount = 0;

  for (const rec of params.recordings) {
    if (rec.deletedAtIso) continue;
    const dur = rec.technicalMetadata.durationSeconds;
    uploadedSeconds += dur;

    if (rec.ingestionStatus === 'REJECTED' || rec.ingestionStatus === 'QUARANTINED' || rec.ingestionStatus === 'CANCELLED') {
      rejectedOrQuarantinedCount++;
      rejectedOrQuarantinedSeconds += dur;
      if (rec.technicalMetadata.corruptionDetected) corruptCount++;
      continue;
    }

    acceptedRecordingsCount++;
    validatedSeconds += dur;
    clippingSum += rec.technicalMetadata.clippingPercentage;
    silenceSum += rec.technicalMetadata.silentRegionPercentage;

    srDist[String(rec.technicalMetadata.sampleRate)] =
      (srDist[String(rec.technicalMetadata.sampleRate)] ?? 0) + 1;
    chDist[`${rec.technicalMetadata.channelCount}ch`] =
      (chDist[`${rec.technicalMetadata.channelCount}ch`] ?? 0) + 1;
    qualityDist[rec.acousticProfile.qualityClass] =
      (qualityDist[rec.acousticProfile.qualityClass] ?? 0) + 1;

    if (seenSha.has(rec.checksumSha256)) {
      exactDupCount++;
    } else {
      seenSha.add(rec.checksumSha256);
    }

    for (const prevFp of fingerprints) {
      if (fingerprintBitSimilarity(prevFp, rec.audioFingerprint) >= 0.92) {
        nearDupCandidateCount++;
        break;
      }
    }
    fingerprints.push(rec.audioFingerprint);

    langCounts[rec.languageClassification] = (langCounts[rec.languageClassification] ?? 0) + 1;
    if (rec.languageClassification === 'fa-en') codeSwitchCount++;

    speakerDur.set(rec.speakerRef, (speakerDur.get(rec.speakerRef) ?? 0) + dur);
    sessions.add(rec.sessionRef);
    sources.add(rec.sourceId);
    domainDist[rec.domainTag] = (domainDist[rec.domainTag] ?? 0) + 1;

    const rights = params.rightsByRecId.get(rec.recordingId);
    if (!rights || rights.verificationStatus === 'UNVERIFIED') {
      unresolvedRightsCount++;
    }
    if (rights?.verificationStatus === 'VERIFIED') {
      verifiedRightsCount++;
      rightsApprovedSeconds += dur;
    }
    if (rights?.revokedAtIso || rights?.verificationStatus === 'REVOKED') {
      consentRevokedCount++;
    }
    if (rights?.legalHold) {
      legalHoldCount++;
    }

    const anns = params.annotationsByRecId.get(rec.recordingId) ?? [];
    const revs = params.reviewsByRecId.get(rec.recordingId) ?? [];

    const hasSubmitted = anns.some((a) => a.status !== 'UNANNOTATED' && a.status !== 'ASSIGNED' && a.status !== 'IN_PROGRESS');
    if (hasSubmitted) {
      annotatedSeconds += dur;
    }
    if (anns.some((a) => a.status === 'ADJUDICATION_REQUIRED' || a.status === 'DISPUTED')) {
      pendingAdjudicationCount++;
    }

    for (const a of anns) {
      for (const seg of a.segments) {
        unintelligibleEventsCount +=
          seg.nonSpeechEvents?.filter((ev) => ev.kind === 'UNINTELLIGIBLE').length ?? 0;
      }
    }

    const tx = resolveApprovedTranscript(anns, revs);
    if (tx.doubleAnnotated) doubleAnnotatedCount++;
    if (tx.approved) {
      reviewedSeconds += dur;
      totalWords += tx.rawText.split(/\s+/).filter(Boolean).length;
      totalChars += tx.rawText.length;

      const trainOk = evaluateRightsForPurpose(rights, 'TRAINING').allowed;
      const evalOk = evaluateRightsForPurpose(rights, 'EVALUATION').allowed;
      if (trainOk && rec.acousticProfile.qualityClass !== 'UNUSABLE') {
        trainingEligibleSeconds += dur;
      }
      if (evalOk && rec.acousticProfile.qualityClass !== 'UNUSABLE') {
        evaluationEligibleSeconds += dur;
      }
    }
  }

  let maxSpeakerSec = 0;
  for (const sDur of speakerDur.values()) {
    if (sDur > maxSpeakerSec) maxSpeakerSec = sDur;
  }
  const maxSingleSpeakerSharePercent =
    validatedSeconds > 0 ? Number(((maxSpeakerSec / validatedSeconds) * 100).toFixed(2)) : 0;

  const totalActiveRecs = acceptedRecordingsCount + rejectedOrQuarantinedCount;
  const trainingHours = trainingEligibleSeconds / 3600;

  const expansionMilestones: GrowthMilestoneProgress[] = PHASE12_EXPANSION_CHECKPOINTS.map((cp) => ({
    milestoneId: cp.id,
    targetHours: cp.targetHours,
    trainingEligibleHours: Number(trainingHours.toFixed(4)),
    completionPercent: Number(Math.min(100, (trainingHours / cp.targetHours) * 100).toFixed(3)),
    reached: trainingHours >= cp.targetHours,
    purpose: cp.purpose,
  }));

  return {
    generatedAtIso: new Date().toISOString(),
    durationBreakdownSeconds: {
      uploadedSeconds: Number(uploadedSeconds.toFixed(2)),
      validatedSeconds: Number(validatedSeconds.toFixed(2)),
      rightsApprovedSeconds: Number(rightsApprovedSeconds.toFixed(2)),
      annotatedSeconds: Number(annotatedSeconds.toFixed(2)),
      reviewedSeconds: Number(reviewedSeconds.toFixed(2)),
      trainingEligibleSeconds: Number(trainingEligibleSeconds.toFixed(2)),
      evaluationEligibleSeconds: Number(evaluationEligibleSeconds.toFixed(2)),
      rejectedOrQuarantinedSeconds: Number(rejectedOrQuarantinedSeconds.toFixed(2)),
    },
    audio: {
      acceptedRecordingsCount,
      rejectedOrQuarantinedCount,
      corruptPercentage:
        totalActiveRecs > 0 ? Number(((corruptCount / totalActiveRecs) * 100).toFixed(2)) : 0,
      exactDuplicatePercentage:
        acceptedRecordingsCount > 0
          ? Number(((exactDupCount / acceptedRecordingsCount) * 100).toFixed(2))
          : 0,
      nearDuplicateCandidateCount: nearDupCandidateCount,
      sampleRateDistribution: srDist,
      channelDistribution: chDist,
      qualityClassDistribution: qualityDist,
      meanClippingPercentage:
        acceptedRecordingsCount > 0
          ? Number((clippingSum / acceptedRecordingsCount).toFixed(4))
          : 0,
      meanSilencePercentage:
        acceptedRecordingsCount > 0
          ? Number((silenceSum / acceptedRecordingsCount).toFixed(2))
          : 0,
    },
    transcripts: {
      totalWordCount: totalWords,
      totalCharacterCount: totalChars,
      languageDistributionCounts: langCounts,
      codeSwitchingRecordingsCount: codeSwitchCount,
      doubleAnnotatedRecordingsCount: doubleAnnotatedCount,
      pendingAdjudicationCount,
      unintelligibleEventsCount,
    },
    diversity: {
      uniqueSpeakerCount: speakerDur.size,
      uniqueSessionCount: sessions.size,
      sourceCount: sources.size,
      domainDistribution: domainDist,
      maxSingleSpeakerSharePercent,
      speakerConcentrationWarning: validatedSeconds > 3600 && maxSingleSpeakerSharePercent > 1.0,
    },
    governance: {
      verifiedRightsPercentage:
        acceptedRecordingsCount > 0
          ? Number(((verifiedRightsCount / acceptedRecordingsCount) * 100).toFixed(2))
          : 0,
      consentRevokedCount,
      legalHoldCount,
      unresolvedRightsCount,
    },
    expansionMilestones,
  };
}
