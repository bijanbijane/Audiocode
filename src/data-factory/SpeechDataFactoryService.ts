/**
 * PHASE 12 — SPEECH DATA FACTORY SERVICE & TENANT-ISOLATED GATEWAY
 * Coordinates Data Sources, Ingestion Jobs, Audio Profiling, Canonical 16kHz Normalization,
 * Default-Deny 8-Flag Rights & Revocation, Blind Dual Annotation & Adjudication,
 * Immutable Dataset Releases, Leakage Audits & Corpus Quality Operations.
 */

import crypto from 'node:crypto';
import { PlatformControlPlaneService, buildPlatformErrorEnvelope } from '../platform/PlatformControlPlaneEngine';
import { AudioSecurityGuard } from '../security/AudioSecurityGuard';
import {
  DATA_FACTORY_AUDIO_SW_VERSION,
  applyReproducibleAugmentation,
  buildCanonical16kMonoArtifact,
  encodePcm16WavBuffer,
  ingestAndDecodeUntrustedAudio,
  sha256Hex,
} from './AudioIngestionAndProfilingEngine';
import {
  ANNOTATION_POLICY_VERSION,
  adjudicateAnnotationConflict,
  buildDefaultDenyRightsPermissions,
  buildRevocationCascade,
  computeInterAnnotatorAgreement,
  evaluateRightsForPurpose,
  validateAndNormalizeAnnotationSegments,
} from './RightsAndAnnotationGovernanceEngine';
import {
  TrainingManifestJsonlRow,
  buildImmutableDatasetRelease,
  computeMultiDimensionalCorpusMetrics,
  DatasetBuildCandidate,
  runLeakageAndContaminationAudit,
} from './DatasetVersioningAndOpsEngine';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  AnnotationSegmentInput,
  AudioArtifactRecord,
  AugmentationConfig,
  DataFactoryUploadLimits,
  DataSourceRecord,
  DatasetReleaseRecord,
  DatasetReleaseType,
  IngestionJobRecord,
  IngestionSourceType,
  LanguageClassification,
  LeakageAuditReport,
  MultiDimensionalCorpusMetrics,
  RecordingRecord,
  RevocationCascadeReport,
  RightsPermissions,
  RightsPurpose,
  RightsRecord,
  SplitPolicyConfig,
  StereoChannelPolicy,
} from './DataFactoryContracts';
import { DEFAULT_DATA_FACTORY_LIMITS } from './DataFactoryContracts';

interface StoredDatasetDefinition {
  readonly datasetId: string;
  readonly tenantId: string;
  readonly datasetName: string;
  readonly description: string;
  readonly createdAtIso: string;
}

export class SpeechDataFactoryService {
  private readonly sources = new Map<string, DataSourceRecord>();
  private readonly ingestionJobs = new Map<string, IngestionJobRecord>();
  private readonly ingestionIdempotency = new Map<string, string>(); // tenantId:key -> jobId
  private readonly recordings = new Map<string, RecordingRecord>();
  private readonly rightsRecords = new Map<string, RightsRecord>(); // keyed by recordingId
  private readonly artifactsByRecording = new Map<string, AudioArtifactRecord[]>();
  private readonly artifactBytes = new Map<string, Buffer>(); // artifactId -> raw immutable buffer
  private readonly decodedPcmCache = new Map<string, { channels: Float32Array[]; sampleRate: number }>();
  private readonly annotationsByRecording = new Map<string, AnnotationRecord[]>();
  private readonly annotationsById = new Map<string, AnnotationRecord>();
  private readonly reviewsByRecording = new Map<string, AnnotationReviewRecord[]>();
  private readonly datasets = new Map<string, StoredDatasetDefinition>();
  private readonly releases = new Map<string, DatasetReleaseRecord>();
  private readonly releaseManifestRows = new Map<string, TrainingManifestJsonlRow[]>();
  private readonly auditsByRelease = new Map<string, LeakageAuditReport[]>();
  private readonly historicalTrainRecIds = new Set<string>();
  private readonly sealedTestRecIds = new Set<string>();

  private limits: DataFactoryUploadLimits = DEFAULT_DATA_FACTORY_LIMITS;

  constructor(private readonly controlPlane: PlatformControlPlaneService) {}

  public configureLimits(partial: Partial<DataFactoryUploadLimits>): void {
    this.limits = { ...this.limits, ...partial };
  }

  public getLimits(): DataFactoryUploadLimits {
    return this.limits;
  }

  /**
   * Authenticates Bearer API key via Control Plane without duplicating auth systems.
   */
  public authenticate(bearerToken: string) {
    return this.controlPlane.authenticateApiKeyRequest({
      bearerToken,
      requiredScope: 'audio:transcribe',
    });
  }

  public createDataSource(params: {
    tenantId: string;
    sourceType: IngestionSourceType;
    sourceName: string;
    ownerReference: string;
    licenseReference: string;
    verified?: boolean;
    provenanceMetadata?: Record<string, string | number | boolean>;
  }): DataSourceRecord {
    const sourceId = `src_${crypto.randomUUID().slice(0, 10)}`;
    const record: DataSourceRecord = {
      sourceId,
      tenantId: params.tenantId,
      sourceType: params.sourceType,
      sourceName: params.sourceName,
      ownerReference: params.ownerReference,
      licenseReference: params.licenseReference,
      verificationStatus: params.verified ? 'VERIFIED' : 'PENDING',
      provenanceMetadata: params.provenanceMetadata ?? {},
      createdAtIso: new Date().toISOString(),
    };
    this.sources.set(sourceId, record);
    return record;
  }

  public listDataSources(tenantId: string): DataSourceRecord[] {
    return [...this.sources.values()].filter((s) => s.tenantId === tenantId);
  }

  /**
   * Executes isolated audio ingestion + immutable raw artifact preservation + default-deny rights creation.
   */
  public async ingestRecording(params: {
    tenantId: string;
    projectId: string;
    sourceId: string;
    filename: string;
    claimedMimeType?: string;
    fileBytes: Buffer;
    speakerRef: string;
    sessionRef: string;
    sourceCorpusTag?: string;
    domainTag?: string;
    declaredLanguage?: LanguageClassification;
    licenseId?: string;
    licenseUrlOrDocRef?: string;
    licenseVersion?: string;
    permissionBasis?: string;
    consentReference?: string | null;
    rightsVerified?: boolean;
    permissions?: Partial<RightsPermissions>;
    evaluationAllowed?: boolean;
    expirationAtIso?: string | null;
    retentionExpiresAtIso?: string | null;
    autoNormalizeCanonical?: boolean;
    channelPolicyOverride?: StereoChannelPolicy;
  }): Promise<{
    recording: RecordingRecord;
    rights: RightsRecord;
    artifacts: AudioArtifactRecord[];
    exactDuplicateOfRecordingId: string | null;
  }> {
    const src = this.sources.get(params.sourceId);
    if (!src || src.tenantId !== params.tenantId) {
      throw new Error('TENANT_OR_SOURCE_NOT_FOUND: Data source does not exist for this tenant.');
    }

    const activeQueueCount = [...this.ingestionJobs.values()].filter(
      (j) => j.tenantId === params.tenantId && j.status === 'PROCESSING'
    ).length;
    if (activeQueueCount >= this.limits.maxConcurrentTasksPerTenant) {
      throw new Error('TENANT_CONCURRENT_INGESTION_LIMIT: Concurrent ingestion limit reached for tenant.');
    }

    const recordingId = `rec_${crypto.randomUUID().slice(0, 12)}`;
    const originalArtifactId = `art_raw_${crypto.randomUUID().slice(0, 12)}`;
    const rightsRecordId = `rgt_${crypto.randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();

    const rawSha = sha256Hex(params.fileBytes);
    const existingDuplicate = [...this.recordings.values()].find(
      (r) => r.tenantId === params.tenantId && r.checksumSha256 === rawSha && !r.deletedAtIso
    );

    let decoded: Awaited<ReturnType<typeof ingestAndDecodeUntrustedAudio>>;
    try {
      decoded = await ingestAndDecodeUntrustedAudio({
        fileBytes: params.fileBytes,
        claimedFilename: params.filename,
        claimedMimeType: params.claimedMimeType,
        limits: this.limits,
      });
    } catch (err) {
      const safeMsg = AudioSecurityGuard.sanitizeErrorForTelemetry(
        err instanceof Error ? err.message : String(err)
      );
      const rejectedRec: RecordingRecord = {
        recordingId,
        tenantId: params.tenantId,
        projectId: params.projectId,
        sourceId: params.sourceId,
        originalArtifactId,
        originalFilename: pathSafeBaseName(params.filename),
        speakerRef: params.speakerRef,
        sessionRef: params.sessionRef,
        sourceCorpusTag: params.sourceCorpusTag ?? src.sourceName,
        domainTag: params.domainTag ?? 'general',
        declaredLanguage: params.declaredLanguage ?? 'unknown',
        segmentLanguagesObserved: [],
        languageClassification: 'unknown',
        ingestionStatus: 'REJECTED',
        checksumSha256: rawSha,
        audioFingerprint: 'fp-rejected',
        technicalMetadata: {
          detectedFormat: 'WAV',
          detectedMimeType: 'application/octet-stream',
          container: 'corrupt',
          codec: 'unknown',
          sampleRate: 0,
          channelCount: 0,
          bitDepth: 0,
          bitrateBps: null,
          durationSeconds: 0,
          fileSizeBytes: params.fileBytes.byteLength,
          peakAmplitude: 0,
          rmsLevelDb: -120,
          clippingPercentage: 0,
          silentRegionPercentage: 100,
          channelImbalanceDb: null,
          stereoPhaseCorrelation: null,
          recommendedChannelPolicy: 'MONO_SOURCE',
          corruptionDetected: true,
          corruptionReason: safeMsg,
        },
        acousticProfile: {
          profilerAlgorithmId: 'rejected',
          profilerAlgorithmVersion: '1.0',
          isHeuristicEstimate: true,
          estimatedSnrDb: 0,
          voiceActivityRatio: 0,
          reverberationProxyScore: 0,
          longSilenceRatio: 1,
          speechClippingIndicator: false,
          backgroundNoiseIndicator: false,
          speechOverlapProxyIndicator: false,
          qualityClass: 'UNUSABLE',
          classificationRulesSummary: safeMsg,
        },
        rightsRecordId,
        validationErrors: [safeMsg],
        createdAtIso: nowIso,
        deletedAtIso: null,
      };
      this.recordings.set(recordingId, rejectedRec);
      throw new Error(safeMsg);
    }

    // Store raw original artifact immutably
    const rawArtifact: AudioArtifactRecord = {
      artifactId: originalArtifactId,
      tenantId: params.tenantId,
      recordingId,
      artifactType: 'ORIGINAL_RAW',
      artifactVersion: 1,
      parentArtifactId: null,
      storageLocation: `object://tenants/${params.tenantId}/recordings/${recordingId}/original_${rawSha.slice(0, 10)}.bin`,
      checksumSha256: rawSha,
      sampleRate: decoded.sampleRate,
      channelCount: decoded.technical.channelCount,
      durationSeconds: decoded.technical.durationSeconds,
      transformationConfig: { originalPreserved: true },
      processingSoftwareVersion: DATA_FACTORY_AUDIO_SW_VERSION,
      createdAtIso: nowIso,
      deletedAtIso: null,
    };

    const artifacts: AudioArtifactRecord[] = [rawArtifact];
    this.artifactBytes.set(originalArtifactId, Buffer.from(params.fileBytes));
    this.decodedPcmCache.set(recordingId, {
      channels: decoded.channelChannelsPcm,
      sampleRate: decoded.sampleRate,
    });

    if (params.autoNormalizeCanonical !== false) {
      const policy = params.channelPolicyOverride ?? decoded.technical.recommendedChannelPolicy;
      const canonical = buildCanonical16kMonoArtifact({
        tenantId: params.tenantId,
        recordingId,
        parentArtifact: rawArtifact,
        sourceChannels: decoded.channelChannelsPcm,
        sourceSampleRate: decoded.sampleRate,
        channelPolicy: policy,
        nextVersion: 1,
      });
      artifacts.push(canonical.artifact);
      this.artifactBytes.set(canonical.artifact.artifactId, canonical.canonicalWavBytes);
    }

    const declaredLang = params.declaredLanguage ?? 'unknown';
    const recording: RecordingRecord = {
      recordingId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      sourceId: params.sourceId,
      originalArtifactId,
      originalFilename: pathSafeBaseName(params.filename),
      speakerRef: params.speakerRef,
      sessionRef: params.sessionRef,
      sourceCorpusTag: params.sourceCorpusTag ?? src.sourceName,
      domainTag: params.domainTag ?? 'general',
      declaredLanguage: declaredLang,
      segmentLanguagesObserved: [declaredLang],
      languageClassification: declaredLang,
      ingestionStatus: 'VALIDATED',
      checksumSha256: rawSha,
      audioFingerprint: decoded.fingerprint,
      technicalMetadata: decoded.technical,
      acousticProfile: decoded.acousticProfile,
      rightsRecordId,
      validationErrors: [],
      createdAtIso: nowIso,
      deletedAtIso: null,
    };

    const rights: RightsRecord = {
      rightsRecordId,
      tenantId: params.tenantId,
      recordingId,
      sourceOwnerOrProvider: src.ownerReference,
      licenseId: params.licenseId ?? 'UNKNOWN_LICENSE',
      licenseUrlOrDocRef: params.licenseUrlOrDocRef ?? src.licenseReference,
      licenseVersion: params.licenseVersion ?? '1.0',
      permissionBasis: params.permissionBasis ?? 'explicit_consent',
      consentReference: params.consentReference ?? null,
      permissions: buildDefaultDenyRightsPermissions(params.permissions ?? {}),
      evaluationAllowed: params.evaluationAllowed ?? false,
      retentionPolicyId: 'ret_standard_365d',
      geographicRestrictions: [],
      legalHold: false,
      verificationStatus: params.rightsVerified ? 'VERIFIED' : 'UNVERIFIED',
      expirationAtIso: params.expirationAtIso ?? null,
      revokedAtIso: null,
      retentionExpiresAtIso: params.retentionExpiresAtIso ?? null,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };

    this.recordings.set(recordingId, recording);
    this.rightsRecords.set(recordingId, rights);
    this.artifactsByRecording.set(recordingId, artifacts);

    return {
      recording,
      rights,
      artifacts,
      exactDuplicateOfRecordingId: existingDuplicate?.recordingId ?? null,
    };
  }

  public async createIngestionJob(params: {
    tenantId: string;
    projectId: string;
    idempotencyKey?: string;
    entries: Array<Parameters<SpeechDataFactoryService['ingestRecording']>[0]>;
  }): Promise<IngestionJobRecord> {
    if (params.entries.length > this.limits.maxBatchManifestEntries) {
      throw new Error(
        `MANIFEST_LIMIT_EXCEEDED: Batch entries (${params.entries.length}) exceed max (${this.limits.maxBatchManifestEntries}).`
      );
    }

    if (params.idempotencyKey) {
      const existingId = this.ingestionIdempotency.get(`${params.tenantId}:${params.idempotencyKey}`);
      if (existingId && this.ingestionJobs.has(existingId)) {
        return this.ingestionJobs.get(existingId)!;
      }
    }

    const jobId = `ing_${crypto.randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();
    let job: IngestionJobRecord = {
      jobId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      idempotencyKey: params.idempotencyKey ?? null,
      status: 'PROCESSING',
      totalEntries: params.entries.length,
      processedEntries: 0,
      recordingIds: [],
      errors: [],
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    this.ingestionJobs.set(jobId, job);
    if (params.idempotencyKey) {
      this.ingestionIdempotency.set(`${params.tenantId}:${params.idempotencyKey}`, jobId);
    }

    const recIds: string[] = [];
    const errors: string[] = [];
    for (const entry of params.entries) {
      if (this.ingestionJobs.get(jobId)?.status === 'CANCELLED') {
        break;
      }
      try {
        const res = await this.ingestRecording({
          ...entry,
          tenantId: params.tenantId,
          projectId: params.projectId,
        });
        recIds.push(res.recording.recordingId);
      } catch (err) {
        errors.push(AudioSecurityGuard.sanitizeErrorForTelemetry(String(err)));
      }
    }

    const latest = this.ingestionJobs.get(jobId)!;
    if (latest.status !== 'CANCELLED') {
      job = {
        ...latest,
        status:
          errors.length === 0
            ? 'COMPLETED'
            : recIds.length > 0
              ? 'PARTIAL_FAILURE'
              : 'FAILED',
        processedEntries: recIds.length + errors.length,
        recordingIds: recIds,
        errors,
        updatedAtIso: new Date().toISOString(),
      };
      this.ingestionJobs.set(jobId, job);
    }
    return this.ingestionJobs.get(jobId)!;
  }

  public getIngestionJob(tenantId: string, jobId: string): IngestionJobRecord {
    const job = this.ingestionJobs.get(jobId);
    if (!job || job.tenantId !== tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Ingestion job not accessible for this tenant.');
    }
    return job;
  }

  public cancelIngestionJob(tenantId: string, jobId: string): IngestionJobRecord {
    const job = this.getIngestionJob(tenantId, jobId);
    const updated: IngestionJobRecord = {
      ...job,
      status: 'CANCELLED',
      updatedAtIso: new Date().toISOString(),
    };
    this.ingestionJobs.set(jobId, updated);
    return updated;
  }

  public getRecording(tenantId: string, recordingId: string): RecordingRecord {
    const rec = this.recordings.get(recordingId);
    if (!rec || rec.tenantId !== tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Recording not accessible for this tenant.');
    }
    return rec;
  }

  public listRecordings(tenantId: string): RecordingRecord[] {
    return [...this.recordings.values()].filter((r) => r.tenantId === tenantId && !r.deletedAtIso);
  }

  public getArtifactsForRecording(tenantId: string, recordingId: string): AudioArtifactRecord[] {
    this.getRecording(tenantId, recordingId);
    return this.artifactsByRecording.get(recordingId) ?? [];
  }

  public normalizeRecordingArtifact(params: {
    tenantId: string;
    recordingId: string;
    channelPolicy?: StereoChannelPolicy;
  }): AudioArtifactRecord {
    const rec = this.getRecording(params.tenantId, params.recordingId);
    const arts = this.artifactsByRecording.get(params.recordingId) ?? [];
    const raw = arts.find((a) => a.artifactType === 'ORIGINAL_RAW');
    const pcm = this.decodedPcmCache.get(params.recordingId);
    if (!raw || !pcm) {
      throw new Error('ARTIFACT_MISSING: Original raw artifact PCM not available.');
    }
    const existingCanonicalCount = arts.filter(
      (a) => a.artifactType === 'CANONICAL_16K_MONO_PCM16'
    ).length;
    const next = buildCanonical16kMonoArtifact({
      tenantId: params.tenantId,
      recordingId: params.recordingId,
      parentArtifact: raw,
      sourceChannels: pcm.channels,
      sourceSampleRate: pcm.sampleRate,
      channelPolicy: params.channelPolicy ?? rec.technicalMetadata.recommendedChannelPolicy,
      nextVersion: existingCanonicalCount + 1,
    });
    arts.push(next.artifact);
    this.artifactsByRecording.set(params.recordingId, arts);
    this.artifactBytes.set(next.artifact.artifactId, next.canonicalWavBytes);
    return next.artifact;
  }

  public createAugmentedArtifact(params: {
    tenantId: string;
    recordingId: string;
    config: AugmentationConfig;
    datasetReleaseId?: string | null;
  }): AudioArtifactRecord {
    this.getRecording(params.tenantId, params.recordingId);
    const arts = this.artifactsByRecording.get(params.recordingId) ?? [];
    const canonical = arts.find((a) => a.artifactType === 'CANONICAL_16K_MONO_PCM16');
    const canonicalBytes = canonical ? this.artifactBytes.get(canonical.artifactId) : undefined;
    if (!canonical || !canonicalBytes) {
      throw new Error('MISSING_CANONICAL_16K_ARTIFACT: Normalize recording to 16kHz canonical WAV before augmenting.');
    }
    const pcm16k = this.decodedPcmCache.get(params.recordingId)?.channels[0];
    if (!pcm16k) {
      throw new Error('PCM_CACHE_UNAVAILABLE');
    }
    // Extract canonical float32 directly from stored WAV PCM16 bytes
    const frames = Math.floor((canonicalBytes.byteLength - 44) / 2);
    const canSamples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      canSamples[i] = canonicalBytes.readInt16LE(44 + i * 2) / 32768.0;
    }

    const augCount = arts.filter((a) => a.artifactType === 'AUGMENTED').length;
    const aug = applyReproducibleAugmentation({
      tenantId: params.tenantId,
      recordingId: params.recordingId,
      sourceArtifact: canonical,
      canonicalPcm16k: canSamples,
      config: params.config,
      datasetReleaseId: params.datasetReleaseId,
      nextVersion: augCount + 1,
    });
    arts.push(aug.artifact);
    this.artifactsByRecording.set(params.recordingId, arts);
    this.artifactBytes.set(aug.artifact.artifactId, aug.augmentedWavBytes);
    return aug.artifact;
  }

  public validateRecordingIntegrity(tenantId: string, recordingId: string): {
    recordingId: string;
    originalChecksumVerified: boolean;
    canonicalArtifactsVerified: boolean;
    details: string[];
  } {
    this.getRecording(tenantId, recordingId);
    const arts = this.artifactsByRecording.get(recordingId) ?? [];
    const details: string[] = [];
    let origOk = false;
    let canonOk = true;
    for (const a of arts) {
      const bytes = this.artifactBytes.get(a.artifactId);
      const actualSha = bytes ? sha256Hex(bytes) : '';
      const matched = actualSha === a.checksumSha256;
      if (a.artifactType === 'ORIGINAL_RAW') origOk = matched;
      else if (!matched) canonOk = false;
      details.push(`${a.artifactType}(v${a.artifactVersion}): checksum=${matched ? 'MATCH' : 'MISMATCH'}`);
    }
    return {
      recordingId,
      originalChecksumVerified: origOk,
      canonicalArtifactsVerified: canonOk,
      details,
    };
  }

  // ── Rights & Governance ────────────────────────────────────────────────────

  public getRightsRecord(tenantId: string, recordingId: string): RightsRecord {
    this.getRecording(tenantId, recordingId);
    const r = this.rightsRecords.get(recordingId);
    if (!r) throw new Error('RIGHTS_RECORD_MISSING');
    return r;
  }

  public checkRightsEligibility(
    tenantId: string,
    recordingId: string,
    purpose: RightsPurpose
  ) {
    const rights = this.getRightsRecord(tenantId, recordingId);
    return evaluateRightsForPurpose(rights, purpose);
  }

  public verifyRightsRecord(params: {
    tenantId: string;
    recordingId: string;
    licenseId?: string;
    permissions?: Partial<RightsPermissions>;
    evaluationAllowed?: boolean;
    legalHold?: boolean;
    expirationAtIso?: string | null;
  }): RightsRecord {
    const cur = this.getRightsRecord(params.tenantId, params.recordingId);
    if (cur.revokedAtIso) {
      throw new Error('RIGHTS_REVOKED_IMMUTABLE: Revoked rights record cannot be silently re-verified.');
    }
    const updated: RightsRecord = {
      ...cur,
      licenseId: params.licenseId ?? cur.licenseId,
      permissions: params.permissions
        ? { ...cur.permissions, ...params.permissions }
        : cur.permissions,
      evaluationAllowed: params.evaluationAllowed ?? cur.evaluationAllowed,
      legalHold: params.legalHold ?? cur.legalHold,
      expirationAtIso: params.expirationAtIso !== undefined ? params.expirationAtIso : cur.expirationAtIso,
      verificationStatus: 'VERIFIED',
      updatedAtIso: new Date().toISOString(),
    };
    this.rightsRecords.set(params.recordingId, updated);
    return updated;
  }

  public revokeRecordingRights(tenantId: string, recordingId: string): RevocationCascadeReport {
    const rec = this.getRecording(tenantId, recordingId);
    const rights = this.getRightsRecord(tenantId, recordingId);
    const arts = this.artifactsByRecording.get(recordingId) ?? [];
    const anns = this.annotationsByRecording.get(recordingId) ?? [];

    const publishedReleasesContaining = [...this.releases.values()]
      .filter((rel) => rel.tenantId === tenantId && rel.sourceRecordingIds.includes(recordingId))
      .map((rel) => rel.datasetReleaseId);

    const { updatedRights, report } = buildRevocationCascade({
      rights,
      checksumSha256: rec.checksumSha256,
      artifacts: arts,
      annotations: anns,
      pendingReleaseIds: [],
      publishedReleaseIdsContainingRecording: publishedReleasesContaining,
    });
    this.rightsRecords.set(recordingId, updatedRights);
    return report;
  }

  // ── Annotation & Adjudication Workflow ─────────────────────────────────────

  public createAnnotationDraft(params: {
    tenantId: string;
    recordingId: string;
    annotatorId: string;
    passIndex?: 1 | 2;
    annotationType?: AnnotationRecord['annotationType'];
    segments?: readonly AnnotationSegmentInput[];
  }): AnnotationRecord {
    const rec = this.getRecording(params.tenantId, params.recordingId);
    const rightsCheck = evaluateRightsForPurpose(
      this.rightsRecords.get(params.recordingId),
      'RETAIN_TRANSCRIPT'
    );
    if (!rightsCheck.allowed) {
      throw new Error(`RIGHTS_DENIED: ${rightsCheck.reasonCodes.join(',')}`);
    }

    const existingForRec = this.annotationsByRecording.get(params.recordingId) ?? [];
    const annotationId = `ann_${crypto.randomUUID().slice(0, 12)}`;
    const segs = params.segments ?? [];
    const validation = segs.length > 0 ? validateAndNormalizeAnnotationSegments(segs) : null;

    const record: AnnotationRecord = {
      annotationId,
      tenantId: params.tenantId,
      recordingId: params.recordingId,
      annotatorId: params.annotatorId,
      passIndex: params.passIndex ?? (existingForRec.length === 0 ? 1 : 2),
      blindToPeerSubmissions: true,
      annotationVersion: existingForRec.length + 1,
      annotationType: params.annotationType ?? 'CODE_SWITCH_TOKENS',
      recordingLanguage: validation?.observedLanguage ?? rec.languageClassification,
      policyVersion: ANNOTATION_POLICY_VERSION,
      status: segs.length > 0 ? 'IN_PROGRESS' : 'ASSIGNED',
      segments: [...segs],
      normalizedDerivedTextFaStrict: validation?.strictDerivedFa ?? '',
      normalizedDerivedTextFaRelaxed: validation?.relaxedDerivedFa ?? '',
      validationWarnings: validation?.warnings ?? [],
      contentArtifactId: `annart_${sha256Hex(annotationId).slice(0, 12)}`,
      createdAtIso: new Date().toISOString(),
      submittedAtIso: null,
      reviewedAtIso: null,
    };

    this.annotationsById.set(annotationId, record);
    existingForRec.push(record);
    this.annotationsByRecording.set(params.recordingId, existingForRec);
    return record;
  }

  public getAnnotationForAnnotator(params: {
    tenantId: string;
    annotationId: string;
    requesterAnnotatorId?: string;
    isReviewer?: boolean;
  }): { annotation: AnnotationRecord; peerSubmissionsRedacted: boolean } {
    const ann = this.annotationsById.get(params.annotationId);
    if (!ann || ann.tenantId !== params.tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Annotation not accessible.');
    }
    if (
      !params.isReviewer &&
      params.requesterAnnotatorId &&
      ann.annotatorId !== params.requesterAnnotatorId
    ) {
      throw new Error(
        'BLIND_ANNOTATION_VIOLATION: Annotator cannot view peer annotation before independent submission.'
      );
    }
    return { annotation: ann, peerSubmissionsRedacted: !params.isReviewer };
  }

  public submitAnnotation(params: {
    tenantId: string;
    annotationId: string;
    segments: readonly AnnotationSegmentInput[];
  }): AnnotationRecord {
    const ann = this.annotationsById.get(params.annotationId);
    if (!ann || ann.tenantId !== params.tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Annotation not found for tenant.');
    }

    const check = validateAndNormalizeAnnotationSegments(params.segments);
    if (!check.valid) {
      throw new Error(`ANNOTATION_VALIDATION_ERROR: ${check.errors.join('; ')}`);
    }

    // Check if another independent annotator already submitted for this recording -> measure IAA
    const allForRec = this.annotationsByRecording.get(ann.recordingId) ?? [];
    const peerSubmitted = allForRec.find(
      (a) =>
        a.annotationId !== ann.annotationId &&
        a.annotatorId !== ann.annotatorId &&
        a.status !== 'UNANNOTATED' &&
        a.status !== 'ASSIGNED' &&
        a.status !== 'IN_PROGRESS'
    );

    const submittedCandidate: AnnotationRecord = {
      ...ann,
      status: 'SUBMITTED',
      recordingLanguage: check.observedLanguage,
      segments: [...params.segments],
      normalizedDerivedTextFaStrict: check.strictDerivedFa,
      normalizedDerivedTextFaRelaxed: check.relaxedDerivedFa,
      validationWarnings: check.warnings,
      submittedAtIso: new Date().toISOString(),
    };

    let finalStatus: AnnotationRecord['status'] = 'SUBMITTED';
    if (peerSubmitted) {
      const iaa = computeInterAnnotatorAgreement(peerSubmitted, submittedCandidate);
      if (iaa.requiresAdjudication) {
        finalStatus = 'ADJUDICATION_REQUIRED';
      }
    }

    const saved: AnnotationRecord = {
      ...submittedCandidate,
      status: finalStatus,
    };

    this.annotationsById.set(ann.annotationId, saved);
    const updatedList = allForRec.map((a) => (a.annotationId === saved.annotationId ? saved : a));
    this.annotationsByRecording.set(ann.recordingId, updatedList);

    // Update recording observed language breakdown when multiple segments span FA & EN
    const rec = this.recordings.get(ann.recordingId);
    if (rec) {
      const segLangs = Array.from(new Set(params.segments.map((s) => s.language)));
      const nextRec: RecordingRecord = {
        ...rec,
        segmentLanguagesObserved: segLangs,
        languageClassification: check.observedLanguage,
      };
      this.recordings.set(rec.recordingId, nextRec);
    }

    return saved;
  }

  public reviewOrAdjudicateAnnotation(params: {
    tenantId: string;
    annotationId: string;
    reviewerId: string;
    action: 'APPROVED' | 'NEEDS_CORRECTION' | 'REJECTED' | 'ADJUDICATE';
    resolvedSegments?: readonly AnnotationSegmentInput[];
    policyNote?: string;
  }): { annotation: AnnotationRecord; review: AnnotationReviewRecord } {
    const ann = this.annotationsById.get(params.annotationId);
    if (!ann || ann.tenantId !== params.tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Annotation not accessible.');
    }

    const allForRec = this.annotationsByRecording.get(ann.recordingId) ?? [];
    const nowIso = new Date().toISOString();

    if (params.action === 'ADJUDICATE') {
      const review = adjudicateAnnotationConflict({
        tenantId: params.tenantId,
        recordingId: ann.recordingId,
        peerAnnotations: allForRec,
        reviewerId: params.reviewerId,
        resolvedSegments: params.resolvedSegments ?? ann.segments,
        policyNote: params.policyNote ?? 'Adjudication resolution',
      });
      const revs = this.reviewsByRecording.get(ann.recordingId) ?? [];
      revs.push(review);
      this.reviewsByRecording.set(ann.recordingId, revs);

      // Update status to APPROVED on adjudicated consensus while preserving original peer annotation segments intact!
      const updatedAnn: AnnotationRecord = {
        ...ann,
        status: 'APPROVED',
        reviewedAtIso: nowIso,
      };
      this.annotationsById.set(ann.annotationId, updatedAnn);
      this.annotationsByRecording.set(
        ann.recordingId,
        allForRec.map((a) => (a.annotationId === updatedAnn.annotationId ? updatedAnn : a))
      );
      return { annotation: updatedAnn, review };
    }

    const review: AnnotationReviewRecord = {
      reviewId: `revw_${crypto.randomUUID().slice(0, 12)}`,
      tenantId: params.tenantId,
      recordingId: ann.recordingId,
      annotationId: ann.annotationId,
      reviewerId: params.reviewerId,
      reviewStatus: params.action,
      disagreementSummary: null,
      adjudicatedSegments: null,
      preservedOriginalAnnotationIds: [ann.annotationId],
      policyNote: params.policyNote ?? `Review decision: ${params.action}`,
      createdAtIso: nowIso,
    };
    const revs = this.reviewsByRecording.get(ann.recordingId) ?? [];
    revs.push(review);
    this.reviewsByRecording.set(ann.recordingId, revs);

    const updatedAnn: AnnotationRecord = {
      ...ann,
      status: params.action,
      reviewedAtIso: nowIso,
    };
    this.annotationsById.set(ann.annotationId, updatedAnn);
    this.annotationsByRecording.set(
      ann.recordingId,
      allForRec.map((a) => (a.annotationId === updatedAnn.annotationId ? updatedAnn : a))
    );
    return { annotation: updatedAnn, review };
  }

  public listAnnotationsForRecording(tenantId: string, recordingId: string): {
    annotations: AnnotationRecord[];
    reviews: AnnotationReviewRecord[];
  } {
    this.getRecording(tenantId, recordingId);
    return {
      annotations: this.annotationsByRecording.get(recordingId) ?? [],
      reviews: this.reviewsByRecording.get(recordingId) ?? [],
    };
  }

  // ── Dataset Construction, Auditing & Operations ────────────────────────────

  public createDatasetDefinition(params: {
    tenantId: string;
    datasetName: string;
    description?: string;
  }): StoredDatasetDefinition {
    const datasetId = `ds_${crypto.randomUUID().slice(0, 10)}`;
    const def: StoredDatasetDefinition = {
      datasetId,
      tenantId: params.tenantId,
      datasetName: params.datasetName,
      description: params.description ?? '',
      createdAtIso: new Date().toISOString(),
    };
    this.datasets.set(datasetId, def);
    return def;
  }

  public listDatasets(tenantId: string): StoredDatasetDefinition[] {
    return [...this.datasets.values()].filter((d) => d.tenantId === tenantId);
  }

  public buildDatasetRelease(params: {
    tenantId: string;
    datasetId: string;
    version: string;
    releaseType: DatasetReleaseType;
    releaseAuthor: string;
    splitPolicy?: Partial<SplitPolicyConfig>;
    recordingIdsFilter?: readonly string[];
  }): { release: DatasetReleaseRecord; trainingManifestRows: TrainingManifestJsonlRow[] } {
    const def = this.datasets.get(params.datasetId);
    if (!def || def.tenantId !== params.tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Dataset definition not accessible for tenant.');
    }

    const dupVer = [...this.releases.values()].find(
      (r) => r.datasetId === params.datasetId && r.version === params.version
    );
    if (dupVer) {
      throw new Error(
        `IMMUTABLE_RELEASE_CONFLICT: Dataset ${def.datasetName} version ${params.version} already exists; publish a new version.`
      );
    }

    const defaultSplitPolicy: SplitPolicyConfig = {
      groupBy: 'SPEAKER_AND_SESSION',
      trainRatio: 0.7,
      valRatio: 0.1,
      testRatio: 0.2,
      maxSingleSpeakerSharePercent: 1.0,
      requireDoubleAnnotationForTestPct: 100,
      requireDoubleAnnotationForTrainPct: 20,
      randomSeed: 42,
      ...params.splitPolicy,
    };

    const tenantRecs = this.listRecordings(params.tenantId).filter(
      (r) => !params.recordingIdsFilter || params.recordingIdsFilter.includes(r.recordingId)
    );

    const candidates: DatasetBuildCandidate[] = tenantRecs.map((rec) => {
      const arts = this.artifactsByRecording.get(rec.recordingId) ?? [];
      const canonical = arts.find((a) => a.artifactType === 'CANONICAL_16K_MONO_PCM16');
      return {
        recording: rec,
        rights: this.rightsRecords.get(rec.recordingId),
        canonicalArtifact: canonical,
        annotations: this.annotationsByRecording.get(rec.recordingId) ?? [],
        reviews: this.reviewsByRecording.get(rec.recordingId) ?? [],
      };
    });

    const built = buildImmutableDatasetRelease({
      tenantId: params.tenantId,
      datasetId: def.datasetId,
      datasetName: def.datasetName,
      version: params.version,
      releaseType: params.releaseType,
      releaseAuthor: params.releaseAuthor,
      splitPolicy: defaultSplitPolicy,
      candidates,
      historicalTrainRecordingIds: this.historicalTrainRecIds,
      sealedTestRecordingIds: this.sealedTestRecIds,
    });

    // Register historical split tracking for cross-release contamination defense
    for (const m of built.release.memberships) {
      if (m.split === 'TRAIN') this.historicalTrainRecIds.add(m.recordingId);
      if (m.split === 'TEST') this.sealedTestRecIds.add(m.recordingId);
    }

    this.releases.set(built.release.datasetReleaseId, built.release);
    this.releaseManifestRows.set(built.release.datasetReleaseId, built.trainingManifestRows);
    this.auditsByRelease.set(built.release.datasetReleaseId, [built.release.leakageAudit]);
    return built;
  }

  public auditDatasetRelease(tenantId: string, datasetId: string, releaseId?: string): LeakageAuditReport {
    const def = this.datasets.get(datasetId);
    if (!def || def.tenantId !== tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Dataset not accessible.');
    }
    const matching = [...this.releases.values()]
      .filter((r) => r.datasetId === datasetId && (!releaseId || r.datasetReleaseId === releaseId))
      .pop();
    if (!matching) {
      throw new Error('RELEASE_NOT_FOUND');
    }

    const candidatesByRecId = new Map<string, DatasetBuildCandidate>();
    for (const m of matching.memberships) {
      const rec = this.recordings.get(m.recordingId);
      if (!rec) continue;
      const arts = this.artifactsByRecording.get(rec.recordingId) ?? [];
      candidatesByRecId.set(rec.recordingId, {
        recording: rec,
        rights: this.rightsRecords.get(rec.recordingId),
        canonicalArtifact: arts.find((a) => a.artifactType === 'CANONICAL_16K_MONO_PCM16'),
        annotations: this.annotationsByRecording.get(rec.recordingId) ?? [],
        reviews: this.reviewsByRecording.get(rec.recordingId) ?? [],
      });
    }

    const report = runLeakageAndContaminationAudit({
      datasetReleaseId: matching.datasetReleaseId,
      memberships: matching.memberships,
      candidatesByRecId,
      historicalTrainRecordingIds: this.historicalTrainRecIds,
      sealedTestRecordingIds: this.sealedTestRecIds,
    });
    const prev = this.auditsByRelease.get(matching.datasetReleaseId) ?? [];
    prev.push(report);
    this.auditsByRelease.set(matching.datasetReleaseId, prev);
    return report;
  }

  public listDatasetReleases(tenantId: string, datasetId: string): DatasetReleaseRecord[] {
    const def = this.datasets.get(datasetId);
    if (!def || def.tenantId !== tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Dataset not accessible.');
    }
    return [...this.releases.values()].filter((r) => r.datasetId === datasetId);
  }

  public getDatasetRelease(params: {
    tenantId: string;
    releaseId: string;
    requesterRole?: 'TRAINING_PIPELINE' | 'AUTHORIZED_EVAL_WORKFLOW' | 'ADMIN';
  }): {
    release: DatasetReleaseRecord;
    manifestJsonlPreview: string;
    sealedTestTranscriptsWithheld: boolean;
  } {
    const rel = this.releases.get(params.releaseId);
    if (!rel || rel.tenantId !== params.tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Release not accessible.');
    }

    const isTrainingRequester = params.requesterRole === 'TRAINING_PIPELINE';
    if (rel.sealedTestProtected && isTrainingRequester) {
      return {
        release: rel,
        manifestJsonlPreview: '',
        sealedTestTranscriptsWithheld: true,
      };
    }

    const rows = this.releaseManifestRows.get(rel.datasetReleaseId) ?? [];
    const safeRows = isTrainingRequester ? rows.filter((r) => r.split !== 'TEST') : rows;
    return {
      release: rel,
      manifestJsonlPreview: safeRows.map((r) => JSON.stringify(r)).join('\n'),
      sealedTestTranscriptsWithheld: isTrainingRequester && rel.sealedTestProtected,
    };
  }

  public computeDashboardMetrics(tenantId: string): MultiDimensionalCorpusMetrics {
    const recs = [...this.recordings.values()].filter((r) => r.tenantId === tenantId);
    return computeMultiDimensionalCorpusMetrics({
      recordings: recs,
      rightsByRecId: this.rightsRecords,
      annotationsByRecId: this.annotationsByRecording,
      reviewsByRecId: this.reviewsByRecording,
    });
  }

  /**
   * Seeds 4 small honest synthetic WAV recordings in the sandbox org so UI & smoke tests can inspect the pipeline immediately.
   * Note: Strictly tagged `SANDBOX_SYNTHETIC_DEMO` (~12s total, 0.0033h vs D0 30h).
   */
  public async ensureSandboxDemoSeeded(tenantId = 'org_avapardaz_sandbox'): Promise<void> {
    if (this.listDataSources(tenantId).length > 0) return;

    const src = this.createDataSource({
      tenantId,
      sourceType: 'ORGANIZATION_CONTROLLED_RECORDING',
      sourceName: 'avapardaz_sandbox_studio_seed',
      ownerReference: 'org_avapardaz_sandbox',
      licenseReference: 'INTERNAL_SANDBOX_EVAL_ONLY_V1',
      verified: true,
      provenanceMetadata: { syntheticDemo: true, purpose: 'Pipeline & UI verification only' },
    });

    const ds = this.createDatasetDefinition({
      tenantId,
      datasetName: 'avapardaz-fa-en-dev-seed',
      description: 'Controlled multi-speaker sandbox verification dataset (NOT 30h D0 training scale)',
    });

    const sampleSpecs = [
      {
        filename: 'seed_fa_clean_spk1.wav',
        speaker: 'SPK_ANON_101',
        session: 'SES_2026_01',
        lang: 'fa' as const,
        domain: 'podcast_tech',
        freq: 180,
        durSec: 3.0,
        text1: 'سلام امروز درباره معماری پردازش گفتار فارسی صحبت می‌کنیم',
        text2: 'سلام امروز درباره معماری پردازش گفتار فارسی صحبت می‌کنیم',
        tokens: [
          { text: 'سلام', language: 'fa' as const },
          { text: 'امروز', language: 'fa' as const },
          { text: 'درباره', language: 'fa' as const },
          { text: 'معماری', language: 'fa' as const },
          { text: 'پردازش', language: 'fa' as const },
          { text: 'گفتار', language: 'fa' as const },
          { text: 'فارسی', language: 'fa' as const },
          { text: 'صحبت', language: 'fa' as const },
          { text: 'می‌کنیم', language: 'fa' as const },
        ],
        trainAllowed: true,
        evalAllowed: true,
      },
      {
        filename: 'seed_codeswitch_spk2.wav',
        speaker: 'SPK_ANON_102',
        session: 'SES_2026_02',
        lang: 'fa-en' as const,
        domain: 'engineering',
        freq: 220,
        durSec: 3.0,
        text1: 'امروز باید مدل را fine-tune کنیم و API را تست کنیم',
        text2: 'امروز باید مدل را فاين تيون کنیم و ای‌پی‌آی را تست کنیم',
        tokens: [
          { text: 'امروز', language: 'fa' as const },
          { text: 'باید', language: 'fa' as const },
          { text: 'مدل', language: 'fa' as const },
          { text: 'را', language: 'fa' as const },
          { text: 'fine-tune', language: 'en' as const },
          { text: 'کنیم', language: 'fa' as const },
          { text: 'و', language: 'fa' as const },
          { text: 'API', language: 'en' as const },
          { text: 'را', language: 'fa' as const },
          { text: 'تست', language: 'fa' as const },
          { text: 'کنیم', language: 'fa' as const },
        ],
        trainAllowed: true,
        evalAllowed: true,
      },
      {
        filename: 'seed_eval_only_spk3.wav',
        speaker: 'SPK_ANON_103',
        session: 'SES_2026_03',
        lang: 'fa-en' as const,
        domain: 'clinical_interview',
        freq: 150,
        durSec: 3.0,
        text1: 'این فایل فقط مجوز ارزیابی دارد و برای آموزش غیرمجاز است',
        text2: 'این فایل فقط مجوز ارزیابی دارد و برای آموزش غیرمجاز است',
        tokens: [
          { text: 'این', language: 'fa' as const },
          { text: 'فایل', language: 'fa' as const },
          { text: 'فقط', language: 'fa' as const },
          { text: 'مجوز', language: 'fa' as const },
          { text: 'ارزیابی', language: 'fa' as const },
          { text: 'دارد', language: 'fa' as const },
        ],
        trainAllowed: false,
        evalAllowed: true,
      },
    ];

    for (const spec of sampleSpecs) {
      const sr = 48000;
      const samples = new Float32Array(Math.floor(sr * spec.durSec));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = 0.25 * Math.sin((2 * Math.PI * spec.freq * i) / sr);
      }
      const wavBuf = encodePcm16WavBuffer([samples], sr);
      const ing = await this.ingestRecording({
        tenantId,
        projectId: 'prj_avapardaz_dev_01',
        sourceId: src.sourceId,
        filename: spec.filename,
        fileBytes: wavBuf,
        speakerRef: spec.speaker,
        sessionRef: spec.session,
        domainTag: spec.domain,
        declaredLanguage: spec.lang,
        licenseId: spec.trainAllowed ? 'AP-INTERNAL-CORPUS-V1' : 'EVAL-ONLY-NON-TRAIN-V1',
        licenseVersion: '1.0',
        rightsVerified: true,
        permissions: {
          transcribe: true,
          storeAudio: true,
          retainTranscripts: true,
          research: true,
          trainModels: spec.trainAllowed,
        },
        evaluationAllowed: spec.evalAllowed,
      });

      const a1 = this.createAnnotationDraft({
        tenantId,
        recordingId: ing.recording.recordingId,
        annotatorId: 'annotator_alpha',
        passIndex: 1,
      });
      this.submitAnnotation({
        tenantId,
        annotationId: a1.annotationId,
        segments: [
          {
            segmentId: 'seg_1',
            startSec: 0.1,
            endSec: 2.8,
            speakerLabel: spec.speaker,
            language: spec.lang,
            rawText: spec.text1,
            tokens: spec.tokens,
          },
        ],
      });

      const a2 = this.createAnnotationDraft({
        tenantId,
        recordingId: ing.recording.recordingId,
        annotatorId: 'annotator_beta',
        passIndex: 2,
      });
      const s2 = this.submitAnnotation({
        tenantId,
        annotationId: a2.annotationId,
        segments: [
          {
            segmentId: 'seg_1',
            startSec: 0.1,
            endSec: 2.8,
            speakerLabel: spec.speaker,
            language: spec.lang,
            rawText: spec.text2,
            tokens: spec.tokens,
          },
        ],
      });

      if (s2.status === 'SUBMITTED') {
        this.reviewOrAdjudicateAnnotation({
          tenantId,
          annotationId: a1.annotationId,
          reviewerId: 'reviewer_lead_01',
          action: 'APPROVED',
        });
      }
    }

    // Build initial training/validation/test release on approved train samples
    try {
      this.buildDatasetRelease({
        tenantId,
        datasetId: ds.datasetId,
        version: 'v1.0.0-sandbox-seed',
        releaseType: 'TRAIN',
        releaseAuthor: 'data-factory-seed',
      });
    } catch {
      // If speakers happen to hash cleanly or require adjudication, seed still leaves dashboard populated cleanly
    }
  }
}

function pathSafeBaseName(filename: string): string {
  const cleaned = filename.replace(/[/\\]/g, '_').replace(/\.\./g, '_').trim();
  return cleaned || 'audio_upload.bin';
}

export function buildErrorStatus(code: string, message: string) {
  return buildPlatformErrorEnvelope({
    code: 'AUDIO_FORMAT_UNSUPPORTED',
    message: `[${code}] ${AudioSecurityGuard.sanitizeErrorForTelemetry(message)}`,
  });
}
