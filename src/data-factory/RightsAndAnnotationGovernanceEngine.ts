/**
 * PHASE 12A & 12C — RIGHTS, CONSENT GOVERNANCE, PERSIAN/ENGLISH ANNOTATION POLICIES,
 * BLIND DOUBLE ANNOTATION, INTER-ANNOTATOR AGREEMENT (IAA) & IMMUTABLE ADJUDICATION
 */

import crypto from 'node:crypto';
import { PersianTextNormalizer } from '../ai-engine/PersianTextNormalizer';
import { AutomatedQualityGateRunner } from '../quality-gate/AutomatedQualityGateRunner';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  AnnotationSegmentInput,
  AudioArtifactRecord,
  InterAnnotatorAgreementMetrics,
  LanguageClassification,
  RevocationCascadeReport,
  RightsEligibilityDecision,
  RightsPermissions,
  RightsPurpose,
  RightsRecord,
} from './DataFactoryContracts';

export const ANNOTATION_POLICY_VERSION = 'fa-en-annotation-policy-v1.0';

export function buildDefaultDenyRightsPermissions(
  overrides: Partial<RightsPermissions> = {}
): RightsPermissions {
  return {
    transcribe: overrides.transcribe ?? false,
    storeAudio: overrides.storeAudio ?? false,
    retainTranscripts: overrides.retainTranscripts ?? false,
    research: overrides.research ?? false,
    trainModels: overrides.trainModels ?? false,
    publishDerivedDatasets: overrides.publishDerivedDatasets ?? false,
    redistributeAudio: overrides.redistributeAudio ?? false,
    commercialUse: overrides.commercialUse ?? false,
  };
}

/**
 * Strict default-deny rights gate separating Transcription, Storage, Research, Training, Evaluation, Redistribution & Commercial purposes.
 */
export function evaluateRightsForPurpose(
  rights: RightsRecord | undefined,
  purpose: RightsPurpose,
  nowIso = new Date().toISOString()
): RightsEligibilityDecision {
  if (!rights) {
    return { allowed: false, purpose, reasonCodes: ['UNKNOWN_RIGHTS_RECORD'] };
  }

  const reasons: string[] = [];
  if (rights.verificationStatus !== 'VERIFIED') {
    reasons.push(`RIGHTS_NOT_VERIFIED_${rights.verificationStatus}`);
  }
  if (rights.revokedAtIso || rights.verificationStatus === 'REVOKED') {
    reasons.push('CONSENT_OR_LICENSE_REVOKED');
  }
  if (rights.legalHold) {
    reasons.push('LEGAL_OR_ADMIN_HOLD');
  }
  if (rights.expirationAtIso && rights.expirationAtIso <= nowIso) {
    reasons.push('RIGHTS_LICENSE_EXPIRED');
  }
  if (rights.retentionExpiresAtIso && rights.retentionExpiresAtIso <= nowIso) {
    reasons.push('RETENTION_WINDOW_EXPIRED');
  }

  switch (purpose) {
    case 'TRANSCRIPTION':
      if (!rights.permissions.transcribe) reasons.push('MISSING_TRANSCRIBE_PERMISSION');
      break;
    case 'STORAGE':
      if (!rights.permissions.storeAudio) reasons.push('MISSING_AUDIO_STORAGE_PERMISSION');
      break;
    case 'RETAIN_TRANSCRIPT':
      if (!rights.permissions.retainTranscripts) reasons.push('MISSING_TRANSCRIPT_RETENTION_PERMISSION');
      break;
    case 'RESEARCH':
      if (!rights.permissions.research) reasons.push('MISSING_RESEARCH_PERMISSION');
      break;
    case 'TRAINING':
      if (!rights.permissions.trainModels) reasons.push('MISSING_MODEL_TRAINING_PERMISSION');
      if (!rights.permissions.storeAudio) reasons.push('TRAINING_REQUIRES_AUDIO_RETENTION');
      break;
    case 'EVALUATION':
      if (!rights.evaluationAllowed) reasons.push('MISSING_EVALUATION_PERMISSION');
      break;
    case 'PUBLISH_DERIVED':
      if (!rights.permissions.publishDerivedDatasets) reasons.push('MISSING_DERIVED_PUBLICATION_PERMISSION');
      break;
    case 'REDISTRIBUTION':
      if (!rights.permissions.redistributeAudio) reasons.push('MISSING_REDISTRIBUTION_PERMISSION');
      break;
    case 'COMMERCIAL':
      if (!rights.permissions.commercialUse) reasons.push('MISSING_COMMERCIAL_USE_PERMISSION');
      break;
  }

  return {
    allowed: reasons.length === 0,
    purpose,
    reasonCodes: reasons,
  };
}

/**
 * Triggers controlled revocation workflow across raw/derived artifacts, annotations, pending manifests,
 * and transparently enumerates previously published releases requiring clean retraining.
 */
export function buildRevocationCascade(params: {
  rights: RightsRecord;
  checksumSha256: string;
  artifacts: readonly AudioArtifactRecord[];
  annotations: readonly AnnotationRecord[];
  pendingReleaseIds: readonly string[];
  publishedReleaseIdsContainingRecording: readonly string[];
}): { updatedRights: RightsRecord; report: RevocationCascadeReport } {
  const nowIso = new Date().toISOString();
  const updatedRights: RightsRecord = {
    ...params.rights,
    verificationStatus: 'REVOKED',
    revokedAtIso: nowIso,
    evaluationAllowed: false,
    permissions: buildDefaultDenyRightsPermissions({}),
    updatedAtIso: nowIso,
  };

  const affectedArtifactIds = params.artifacts.map((a) => a.artifactId);
  const excludedAnnotationIds = params.annotations.map((a) => a.annotationId);
  const published = params.publishedReleaseIdsContainingRecording;

  const remediationSummary =
    published.length > 0
      ? `Recording excluded from future training/eval builds and marked REVOKED across ${affectedArtifactIds.length} artifacts & ${excludedAnnotationIds.length} annotations. Previously immutable dataset releases (${published.join(', ')}) cannot be silently rewritten and require clean deprecation/retraining where contractually obligated.`
      : `Recording marked REVOKED across ${affectedArtifactIds.length} artifacts & ${excludedAnnotationIds.length} annotations; no published immutable releases contained this sample.`;

  return {
    updatedRights,
    report: {
      revocationId: `rev_${crypto.randomUUID().slice(0, 12)}`,
      tenantId: params.rights.tenantId,
      recordingId: params.rights.recordingId,
      checksumSha256: params.checksumSha256,
      revokedAtIso: nowIso,
      revokedRawRecording: true,
      affectedArtifactIds,
      excludedAnnotationIds,
      impactedPendingReleaseIds: [...params.pendingReleaseIds],
      previouslyPublishedReleaseIdsRequiringRetraining: [...published],
      remediationSummary,
    },
  };
}

/**
 * Validates Persian/English/Code-Switch annotation segments, preserves raw transcript text,
 * computes versioned derived normalizations, and enforces non-speech separation & unintelligible rules.
 */
export function validateAndNormalizeAnnotationSegments(segments: readonly AnnotationSegmentInput[]): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  observedLanguage: LanguageClassification;
  strictDerivedFa: string;
  relaxedDerivedFa: string;
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (segments.length === 0) {
    errors.push('ANNOTATION_EMPTY: At least one segment is required.');
  }

  let hasFa = false;
  let hasEn = false;
  const rawJoined: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || typeof seg !== 'object') {
      errors.push(`INVALID_SEGMENT: Segment at index ${i} must be an object.`);
      continue;
    }
    const segId = typeof seg.segmentId === 'string' && seg.segmentId.trim() ? seg.segmentId : `idx_${i}`;
    if (!Number.isFinite(seg.startSec) || !Number.isFinite(seg.endSec) || seg.startSec < 0 || seg.endSec <= seg.startSec) {
      errors.push(`INVALID_TIMESTAMP: Segment ${segId} has invalid range [${seg.startSec}, ${seg.endSec}].`);
    }
    if (typeof seg.speakerLabel !== 'string' || !seg.speakerLabel.trim()) {
      errors.push(`MISSING_SPEAKER_LABEL: Segment ${segId} missing opaque speaker label.`);
    }

    if (typeof seg.rawText !== 'string') {
      errors.push(`INVALID_RAW_TEXT: Segment ${segId} must provide string rawText.`);
      continue;
    }
    const trimmed = seg.rawText.trim();
    const hasUnintelligibleEvent = Array.isArray(seg.nonSpeechEvents)
      ? seg.nonSpeechEvents.some((ev) => ev && ev.kind === 'UNINTELLIGIBLE')
      : false;
    if (hasUnintelligibleEvent && trimmed.length > 0 && !seg.uncertain) {
      warnings.push(
        `UNINTELLIGIBLE_CO_OCCURS_WITH_TEXT: Segment ${segId} marks UNINTELLIGIBLE event alongside words; verify words are not hallucinated.`
      );
    }

    if (trimmed.length > 0) {
      rawJoined.push(trimmed);
      if (/[\u0600-\u06FF]/.test(trimmed)) hasFa = true;
      if (/[A-Za-z]{2,}/.test(trimmed)) hasEn = true;
    }

    if (seg.tokens) {
      for (const tok of seg.tokens) {
        if (tok.language === 'fa') hasFa = true;
        if (tok.language === 'en') hasEn = true;
      }
    }

    if (seg.nonSpeechEvents) {
      for (const ev of seg.nonSpeechEvents) {
        if (!Number.isFinite(ev.startSec) || !Number.isFinite(ev.endSec) || ev.endSec <= ev.startSec) {
          errors.push(`INVALID_NONSPEECH_RANGE: Event ${ev.kind} in ${seg.segmentId} has invalid bounds.`);
        }
      }
    }
  }

  const combinedRaw = rawJoined.join(' ');
  const normObj = PersianTextNormalizer.normalize(combinedRaw);
  const relaxed = normObj.normalized.replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim();

  const observedLanguage: LanguageClassification =
    hasFa && hasEn ? 'fa-en' : hasFa ? 'fa' : hasEn ? 'en' : 'unknown';

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    observedLanguage,
    strictDerivedFa: normObj.normalized,
    relaxedDerivedFa: relaxed,
  };
}

function charLevenshteinRatio(a: string, b: string): number {
  if (a.length === 0) return b.length === 0 ? 0 : 100;
  const n = a.length;
  const m = b.length;
  const prev = new Array<number>(m + 1);
  const curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j];
  }
  return Number(((prev[m] / n) * 100).toFixed(2));
}

function extractNumbersAndLatinEntities(text: string): Set<string> {
  const matches = text.match(/(?:[0-9۰-۹]+|[A-Za-z][A-Za-z0-9_-]+)/g) ?? [];
  return new Set(matches.map((m) => m.toLowerCase()));
}

/**
 * Computes multi-dimensional Inter-Annotator Agreement (IAA) across words, chars, boundaries, speaker, language & entities.
 */
export function computeInterAnnotatorAgreement(
  annA: AnnotationRecord,
  annB: AnnotationRecord
): InterAnnotatorAgreementMetrics {
  const textA = annA.segments.map((s) => s.rawText.trim()).join(' ').trim();
  const textB = annB.segments.map((s) => s.rawText.trim()).join(' ').trim();

  const wer = AutomatedQualityGateRunner.computePersianWER(textA, textB);
  const charCer = charLevenshteinRatio(annA.normalizedDerivedTextFaStrict, annB.normalizedDerivedTextFaStrict);

  const pairCount = Math.min(annA.segments.length, annB.segments.length);
  let boundaryErrSumMs = 0;
  let speakerMatches = 0;
  let langMatches = 0;

  for (let i = 0; i < pairCount; i++) {
    const sA = annA.segments[i];
    const sB = annB.segments[i];
    boundaryErrSumMs +=
      (Math.abs(sA.startSec - sB.startSec) + Math.abs(sA.endSec - sB.endSec)) * 500;
    if (sA.speakerLabel === sB.speakerLabel) speakerMatches++;
    if (sA.language === sB.language) langMatches++;
  }

  const maxSegs = Math.max(1, Math.max(annA.segments.length, annB.segments.length));
  const boundaryMaeMs = pairCount > 0 ? Number((boundaryErrSumMs / pairCount).toFixed(1)) : 0;
  const speakerAgreement = Number(((speakerMatches / maxSegs) * 100).toFixed(2));
  const langAgreement = Number(((langMatches / maxSegs) * 100).toFixed(2));

  const entA = extractNumbersAndLatinEntities(textA);
  const entB = extractNumbersAndLatinEntities(textB);
  const unionSize = new Set([...entA, ...entB]).size;
  let entInter = 0;
  for (const e of entA) if (entB.has(e)) entInter++;
  const entityAgreement = unionSize === 0 ? 100 : Number(((entInter / unionSize) * 100).toFixed(2));

  const requiresAdjudication =
    wer.normalizedWerPercent > 2.0 ||
    speakerAgreement < 100 ||
    langAgreement < 100 ||
    entityAgreement < 100;

  return {
    wordDisagreementWerPercent: wer.normalizedWerPercent,
    charDisagreementCerPercent: charCer,
    segmentBoundaryMaeMs: boundaryMaeMs,
    speakerLabelAgreementPercent: speakerAgreement,
    languageLabelAgreementPercent: langAgreement,
    entityAndNumberAgreementPercent: entityAgreement,
    requiresAdjudication,
  };
}

/**
 * Executes immutable adjudication resolving disputed peer annotations without overwriting annotation history.
 */
export function adjudicateAnnotationConflict(params: {
  tenantId: string;
  recordingId: string;
  peerAnnotations: readonly AnnotationRecord[];
  reviewerId: string;
  resolvedSegments: readonly AnnotationSegmentInput[];
  policyNote: string;
}): AnnotationReviewRecord {
  if (params.peerAnnotations.length < 2) {
    throw new Error('ADJUDICATION_ERROR: At least two independent annotations are required for conflict adjudication.');
  }
  const check = validateAndNormalizeAnnotationSegments(params.resolvedSegments);
  if (!check.valid) {
    throw new Error(`ADJUDICATION_INVALID_SEGMENTS: ${check.errors.join('; ')}`);
  }
  const disagreementSummary = computeInterAnnotatorAgreement(
    params.peerAnnotations[0],
    params.peerAnnotations[1]
  );

  return {
    reviewId: `revw_${crypto.randomUUID().slice(0, 12)}`,
    tenantId: params.tenantId,
    recordingId: params.recordingId,
    annotationId: params.peerAnnotations[0].annotationId,
    reviewerId: params.reviewerId,
    reviewStatus: 'ADJUDICATED',
    disagreementSummary,
    adjudicatedSegments: [...params.resolvedSegments],
    preservedOriginalAnnotationIds: params.peerAnnotations.map((a) => a.annotationId),
    policyNote: params.policyNote.trim() || 'Adjudicated per fa-en-annotation-policy-v1.0',
    createdAtIso: new Date().toISOString(),
  };
}
