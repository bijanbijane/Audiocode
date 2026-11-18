/**
 * PHASE 14E — MODEL SUPPLY CHAIN SECURITY & DATASET/ANNOTATION POISONING DEFENSE
 * - Detects poisoning indicators as INVESTIGATION_FLAGs without blindly deleting valid speech diversity.
 * - Prevents annotator self-approval.
 * - Verifies SHA-256 digests, tokenizer consistency, license commercial status, and safe serialization format.
 */

import crypto from 'node:crypto';
import type {
  ModelPackageRecord,
  ModelVersionRecord,
} from '../model-factory/ModelFactoryContracts';
import type {
  ModelSupplyChainVerificationResult,
  PoisoningAnomalyIndicator,
} from './SpeechSecurityContracts';

export interface DatasetSubmissionTelemetryRow {
  readonly recordingId: string;
  readonly sourceId: string;
  readonly contributorId: string;
  readonly audioSha256: string;
  readonly normalizedTranscript: string;
  readonly rawTranscript: string;
  readonly language: 'fa' | 'en' | 'fa-en';
}

const UNSAFE_SERIALIZATION_EXTENSIONS = ['.pkl', '.pickle', '.pt', '.pth', '.bin_pickle', '.dill'];

export class SupplyChainAndPoisoningGuard {
  /**
   * Scans dataset submissions for anomalous poisoning patterns.
   * Strictly produces INVESTIGATION_FLAGs and never auto-deletes rows blindly.
   */
  public static scanDatasetSubmissionsForPoisoning(
    rows: readonly DatasetSubmissionTelemetryRow[]
  ): PoisoningAnomalyIndicator[] {
    const indicators: PoisoningAnomalyIndicator[] = [];
    if (rows.length === 0) return indicators;

    // 1. Conflicting transcripts mapped to identical audio SHA-256 (strong poisoning/label-flip signal)
    const byAudioHash = new Map<string, DatasetSubmissionTelemetryRow[]>();
    for (const r of rows) {
      const list = byAudioHash.get(r.audioSha256) ?? [];
      list.push(r);
      byAudioHash.set(r.audioSha256, list);
    }
    for (const [audioHash, group] of byAudioHash.entries()) {
      const distinctTexts = new Set(group.map((g) => g.normalizedTranscript.trim()));
      if (distinctTexts.size > 1) {
        indicators.push({
          indicatorId: `pois_${crypto.randomUUID().slice(0, 10)}`,
          anomalyType: 'CONFLICTING_TRANSCRIPTS_SAME_AUDIO_HASH',
          severity: 'HIGH',
          affectedRecordingIds: group.map((g) => g.recordingId),
          disposition: 'INVESTIGATION_FLAG',
          detail: `Audio SHA-256 ${audioHash.slice(0, 12)} mapped to ${distinctTexts.size} conflicting transcripts.`,
          autoDeleted: false,
        });
      }
    }

    // 2. Repeated identical transcript template flooding across distinct recordings
    const byTranscript = new Map<string, DatasetSubmissionTelemetryRow[]>();
    for (const r of rows) {
      const key = r.normalizedTranscript.trim();
      if (!key) continue;
      const list = byTranscript.get(key) ?? [];
      list.push(r);
      byTranscript.set(key, list);
    }
    for (const [, group] of byTranscript.entries()) {
      if (group.length >= Math.max(4, Math.ceil(rows.length * 0.45))) {
        indicators.push({
          indicatorId: `pois_${crypto.randomUUID().slice(0, 10)}`,
          anomalyType: 'REPEATED_TEMPLATE_FLOODING',
          severity: 'MEDIUM',
          affectedRecordingIds: group.map((g) => g.recordingId),
          disposition: 'INVESTIGATION_FLAG',
          detail: `Identical transcript repeated ${group.length}/${rows.length} submissions; verify for scripted spam vs valid anchor phrase.`,
          autoDeleted: false,
        });
      }
    }

    // 3. Single contributor concentration >= 75% (requires >= 5 samples)
    if (rows.length >= 5) {
      const byContrib = new Map<string, DatasetSubmissionTelemetryRow[]>();
      for (const r of rows) {
        const list = byContrib.get(r.contributorId) ?? [];
        list.push(r);
        byContrib.set(r.contributorId, list);
      }
      for (const [contrib, group] of byContrib.entries()) {
        if (group.length / rows.length >= 0.75) {
          indicators.push({
            indicatorId: `pois_${crypto.randomUUID().slice(0, 10)}`,
            anomalyType: 'SINGLE_CONTRIBUTOR_DOMINANCE',
            severity: 'MEDIUM',
            affectedRecordingIds: group.map((g) => g.recordingId),
            disposition: 'INVESTIGATION_FLAG',
            detail: `Contributor '${contrib}' accounts for ${group.length}/${rows.length} rows; flag for stratified speaker audit.`,
            autoDeleted: false,
          });
        }
      }
    }

    // 4. Normalization evasion via invisible formatting characters spam (beyond normal ZWNJ usage)
    const evasionRows = rows.filter((r) => {
      const zeroWidthRatio = (r.rawTranscript.match(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g)?.length ?? 0) / Math.max(1, r.rawTranscript.length);
      return zeroWidthRatio > 0.25 || /[\u202A-\u202E]/.test(r.rawTranscript);
    });
    if (evasionRows.length > 0) {
      indicators.push({
        indicatorId: `pois_${crypto.randomUUID().slice(0, 10)}`,
        anomalyType: 'NORMALIZATION_EVASION_ZERO_WIDTH_SPAM',
        severity: 'HIGH',
        affectedRecordingIds: evasionRows.map((r) => r.recordingId),
        disposition: 'INVESTIGATION_FLAG',
        detail: `${evasionRows.length} transcript(s) contain suspicious bidirectional override or excessive invisible zero-width tokens.`,
        autoDeleted: false,
      });
    }

    return indicators;
  }

  /**
   * Enforces independent human review: annotators cannot self-approve their own labels.
   */
  public static assertNoAnnotationSelfApproval(annotatorId: string, reviewerId: string): void {
    if (!annotatorId || !reviewerId || annotatorId.trim() === reviewerId.trim()) {
      throw new Error(
        `ANNOTATION_SELF_APPROVAL_BLOCKED: Reviewer '${reviewerId}' cannot approve their own annotation ('${annotatorId}').`
      );
    }
  }

  /**
   * Verifies model weights SHA-256, tokenizer compatibility, safe serialization format
   * (blocking untrusted pickle/.pt payloads), license status, and clean secret scan prior to load.
   */
  public static verifyModelArtifactBeforeLoad(params: {
    modelVersion: ModelVersionRecord;
    packageRecord: ModelPackageRecord | null;
    artifactFilenames: readonly string[];
    observedWeightsSha256: string;
    expectedTokenizerVersion: string;
  }): ModelSupplyChainVerificationResult {
    const blockingReasons: string[] = [];
    const sha256Verified =
      params.observedWeightsSha256.length === 64 &&
      params.observedWeightsSha256 === params.modelVersion.weightsArtifactHash;
    if (!sha256Verified) {
      blockingReasons.push('Artifact SHA-256 checksum mismatch against signed registry digest.');
    }

    const tokenizerHashVerified =
      params.modelVersion.tokenizerVersion === params.expectedTokenizerVersion;
    if (!tokenizerHashVerified) {
      blockingReasons.push(
        `Tokenizer mismatch (model=${params.modelVersion.tokenizerVersion}, expected=${params.expectedTokenizerVersion}).`
      );
    }

    const rejectedFormatsDetected = params.artifactFilenames.filter((f) => {
      const lower = f.trim().toLowerCase();
      return UNSAFE_SERIALIZATION_EXTENSIONS.some((ext) => lower.endsWith(ext));
    });
    const safeSerializationFormat = rejectedFormatsDetected.length === 0;
    if (!safeSerializationFormat) {
      blockingReasons.push(
        `Unsafe deserialization artifact format rejected: ${rejectedFormatsDetected.join(', ')}. Use .safetensors or verified ONNX.`
      );
    }

    const licenseVerifiedCommercial =
      params.modelVersion.licenseMetadata.licenseStatus === 'VERIFIED_COMMERCIAL' &&
      params.modelVersion.licenseMetadata.commercialUseVerified;
    if (!licenseVerifiedCommercial) {
      blockingReasons.push(
        `Model license status '${params.modelVersion.licenseMetadata.licenseStatus}' is not cleared for production serving.`
      );
    }

    const secretScanClean = Boolean(params.packageRecord?.secretScanPassed && params.packageRecord?.verifiedSafeToLoad);
    if (!secretScanClean) {
      blockingReasons.push('Package validation / secret scan failed or package manifest is missing.');
    }

    return {
      modelVersionId: params.modelVersion.modelVersionId,
      safeToLoad: blockingReasons.length === 0,
      sha256Verified,
      tokenizerHashVerified,
      safeSerializationFormat,
      rejectedFormatsDetected,
      licenseVerifiedCommercial,
      secretScanClean,
      blockingReasons,
    };
  }
}
