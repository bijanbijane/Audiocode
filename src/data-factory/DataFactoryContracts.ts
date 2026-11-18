/**
 * PHASE 12 — SPEECH DATA FACTORY, DATASET ENGINEERING & CORPUS GOVERNANCE CONTRACTS
 * Browser-safe pure TypeScript interfaces shared across Data Factory engines, API Gateway, and Studio UI.
 */

export type IngestionSourceType =
  | 'AUTHORIZED_USER_UPLOAD'
  | 'ORGANIZATION_CONTROLLED_RECORDING'
  | 'EXPLICITLY_LICENSED_CORPUS'
  | 'APPROVED_PUBLIC_DATASET'
  | 'CONSENT_CONTRIBUTOR_RECORDING'
  | 'APPROVED_HUMAN_ANNOTATION_DELIVERY'
  | 'AUTHORIZED_PRODUCTION_FEEDBACK';

export type SupportedMediaFormat = 'WAV' | 'FLAC' | 'MP3' | 'M4A_AAC' | 'OGG_OPUS' | 'WEBM';

export type StereoChannelPolicy =
  | 'MONO_SOURCE'
  | 'LEFT_CHANNEL'
  | 'RIGHT_CHANNEL'
  | 'SAFE_MIXDOWN'
  | 'MULTI_CHANNEL_PRESERVATION';

export type AudioQualityClass =
  | 'CLEAN'
  | 'ACCEPTABLE'
  | 'CHALLENGING'
  | 'POOR'
  | 'UNUSABLE'
  | 'UNKNOWN';

export type LanguageClassification = 'fa' | 'en' | 'fa-en' | 'other' | 'unknown' | 'uncertain';

export type IngestionValidationStatus =
  | 'QUEUED'
  | 'VALIDATED'
  | 'QUARANTINED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'DELETED';

export type AudioArtifactType =
  | 'ORIGINAL_RAW'
  | 'CANONICAL_16K_MONO_PCM16'
  | 'STEREO_LEFT'
  | 'STEREO_RIGHT'
  | 'STEREO_PRESERVED'
  | 'REPAIRED'
  | 'AUGMENTED';

export interface DataFactoryUploadLimits {
  readonly maxUploadBytes: number; // default 500 MB
  readonly maxDurationSeconds: number; // default 4 hours
  readonly maxBatchManifestEntries: number; // default 10,000
  readonly maxConcurrentTasksPerTenant: number;
  readonly maxProcessingDurationMs: number;
}

export const DEFAULT_DATA_FACTORY_LIMITS: DataFactoryUploadLimits = {
  maxUploadBytes: 500 * 1024 * 1024,
  maxDurationSeconds: 4 * 3600,
  maxBatchManifestEntries: 10_000,
  maxConcurrentTasksPerTenant: 8,
  maxProcessingDurationMs: 60_000,
};

export interface DataSourceRecord {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly sourceType: IngestionSourceType;
  readonly sourceName: string;
  readonly ownerReference: string;
  readonly licenseReference: string;
  readonly verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'REVOKED';
  readonly provenanceMetadata: Record<string, string | number | boolean>;
  readonly createdAtIso: string;
}

export interface RightsPermissions {
  readonly transcribe: boolean;
  readonly storeAudio: boolean;
  readonly retainTranscripts: boolean;
  readonly research: boolean;
  readonly trainModels: boolean;
  readonly publishDerivedDatasets: boolean;
  readonly redistributeAudio: boolean;
  readonly commercialUse: boolean;
}

export type RightsPurpose =
  | 'TRANSCRIPTION'
  | 'STORAGE'
  | 'RETAIN_TRANSCRIPT'
  | 'RESEARCH'
  | 'TRAINING'
  | 'EVALUATION'
  | 'PUBLISH_DERIVED'
  | 'REDISTRIBUTION'
  | 'COMMERCIAL';

export interface RightsRecord {
  readonly rightsRecordId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly sourceOwnerOrProvider: string;
  readonly licenseId: string;
  readonly licenseUrlOrDocRef: string;
  readonly licenseVersion: string;
  readonly permissionBasis: string;
  readonly consentReference: string | null;
  readonly permissions: RightsPermissions;
  readonly evaluationAllowed: boolean;
  readonly retentionPolicyId: string;
  readonly geographicRestrictions: readonly string[];
  readonly legalHold: boolean;
  readonly verificationStatus: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED' | 'REVOKED';
  readonly expirationAtIso: string | null;
  readonly revokedAtIso: string | null;
  readonly retentionExpiresAtIso: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface RightsEligibilityDecision {
  readonly allowed: boolean;
  readonly purpose: RightsPurpose;
  readonly reasonCodes: readonly string[];
}

export interface RevocationCascadeReport {
  readonly revocationId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly checksumSha256: string;
  readonly revokedAtIso: string;
  readonly revokedRawRecording: boolean;
  readonly affectedArtifactIds: readonly string[];
  readonly excludedAnnotationIds: readonly string[];
  readonly impactedPendingReleaseIds: readonly string[];
  readonly previouslyPublishedReleaseIdsRequiringRetraining: readonly string[];
  readonly remediationSummary: string;
}

export interface AudioTechnicalMetadata {
  readonly detectedFormat: SupportedMediaFormat;
  readonly detectedMimeType: string;
  readonly container: string;
  readonly codec: string;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly bitDepth: number;
  readonly bitrateBps: number | null;
  readonly durationSeconds: number;
  readonly fileSizeBytes: number;
  readonly peakAmplitude: number;
  readonly rmsLevelDb: number;
  readonly clippingPercentage: number;
  readonly silentRegionPercentage: number;
  readonly channelImbalanceDb: number | null;
  readonly stereoPhaseCorrelation: number | null;
  readonly recommendedChannelPolicy: StereoChannelPolicy;
  readonly corruptionDetected: boolean;
  readonly corruptionReason: string | null;
}

export interface AcousticQualityProfile {
  readonly profilerAlgorithmId: string;
  readonly profilerAlgorithmVersion: string;
  readonly isHeuristicEstimate: true;
  readonly estimatedSnrDb: number;
  readonly voiceActivityRatio: number;
  readonly reverberationProxyScore: number;
  readonly longSilenceRatio: number;
  readonly speechClippingIndicator: boolean;
  readonly backgroundNoiseIndicator: boolean;
  readonly speechOverlapProxyIndicator: boolean;
  readonly qualityClass: AudioQualityClass;
  readonly classificationRulesSummary: string;
}

export interface ResamplingProvenanceMetadata {
  readonly sourceSampleRate: number;
  readonly targetSampleRate: number;
  readonly channelPolicyApplied: StereoChannelPolicy;
  readonly resamplingAlgorithm: string;
  readonly filterCutoffHz: number;
  readonly filterTaps: number;
  readonly processingLibraryVersion: string;
  readonly inputChecksumSha256: string;
  readonly outputChecksumSha256: string;
  readonly durationDeltaMs: number;
  readonly postResamplePeak: number;
  readonly clippingIntroduced: boolean;
  readonly expectedSampleCount: number;
  readonly actualSampleCount: number;
}

export interface AudioArtifactRecord {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly artifactType: AudioArtifactType;
  readonly artifactVersion: number;
  readonly parentArtifactId: string | null;
  readonly storageLocation: string;
  readonly checksumSha256: string;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly durationSeconds: number;
  readonly transformationConfig: Record<string, string | number | boolean | null>;
  readonly processingSoftwareVersion: string;
  readonly resamplingProvenance?: ResamplingProvenanceMetadata;
  readonly augmentationMetadata?: AugmentationRecordMetadata;
  readonly createdAtIso: string;
  readonly deletedAtIso: string | null;
}

export interface RecordingRecord {
  readonly recordingId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly originalArtifactId: string;
  readonly originalFilename: string;
  readonly speakerRef: string;
  readonly sessionRef: string;
  readonly sourceCorpusTag: string;
  readonly domainTag: string;
  readonly declaredLanguage: LanguageClassification;
  readonly segmentLanguagesObserved: readonly LanguageClassification[];
  readonly languageClassification: LanguageClassification;
  readonly ingestionStatus: IngestionValidationStatus;
  readonly checksumSha256: string;
  readonly audioFingerprint: string;
  readonly technicalMetadata: AudioTechnicalMetadata;
  readonly acousticProfile: AcousticQualityProfile;
  readonly rightsRecordId: string;
  readonly validationErrors: readonly string[];
  readonly createdAtIso: string;
  readonly deletedAtIso: string | null;
}

export interface IngestionJobRecord {
  readonly jobId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly idempotencyKey: string | null;
  readonly status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED' | 'CANCELLED';
  readonly totalEntries: number;
  readonly processedEntries: number;
  readonly recordingIds: readonly string[];
  readonly errors: readonly string[];
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export type AnnotationStatus =
  | 'UNANNOTATED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'REVIEWED'
  | 'APPROVED'
  | 'NEEDS_CORRECTION'
  | 'REJECTED'
  | 'DISPUTED'
  | 'ADJUDICATION_REQUIRED';

export type NonSpeechEventKind =
  | 'LAUGHTER'
  | 'COUGH'
  | 'BREATH'
  | 'CRYING'
  | 'MUSIC'
  | 'BACKGROUND_SPEECH'
  | 'NON_VERBAL_SOUND'
  | 'UNINTELLIGIBLE';

export interface TokenLanguageAnnotation {
  readonly text: string;
  readonly language: 'fa' | 'en' | 'other';
  readonly startSec?: number;
  readonly endSec?: number;
}

export interface NonSpeechEventAnnotation {
  readonly kind: NonSpeechEventKind;
  readonly startSec: number;
  readonly endSec: number;
  readonly note?: string;
}

export interface AnnotationSegmentInput {
  readonly segmentId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly speakerLabel: string;
  readonly language: LanguageClassification;
  readonly rawText: string;
  readonly tokens?: readonly TokenLanguageAnnotation[];
  readonly nonSpeechEvents?: readonly NonSpeechEventAnnotation[];
  readonly uncertain?: boolean;
}

export interface AnnotationRecord {
  readonly annotationId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly annotatorId: string;
  readonly passIndex: 1 | 2;
  readonly blindToPeerSubmissions: true;
  readonly annotationVersion: number;
  readonly annotationType: 'UTTERANCE_TRANSCRIPT' | 'CODE_SWITCH_TOKENS' | 'SPEAKER_SEGMENTS' | 'NON_SPEECH_EVENTS';
  readonly recordingLanguage: LanguageClassification;
  readonly policyVersion: string;
  readonly status: AnnotationStatus;
  readonly segments: readonly AnnotationSegmentInput[];
  readonly normalizedDerivedTextFaStrict: string;
  readonly normalizedDerivedTextFaRelaxed: string;
  readonly validationWarnings: readonly string[];
  readonly contentArtifactId: string;
  readonly createdAtIso: string;
  readonly submittedAtIso: string | null;
  readonly reviewedAtIso: string | null;
}

export interface InterAnnotatorAgreementMetrics {
  readonly wordDisagreementWerPercent: number;
  readonly charDisagreementCerPercent: number;
  readonly segmentBoundaryMaeMs: number;
  readonly speakerLabelAgreementPercent: number;
  readonly languageLabelAgreementPercent: number;
  readonly entityAndNumberAgreementPercent: number;
  readonly requiresAdjudication: boolean;
}

export interface AnnotationReviewRecord {
  readonly reviewId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly annotationId: string;
  readonly reviewerId: string;
  readonly reviewStatus: 'APPROVED' | 'NEEDS_CORRECTION' | 'REJECTED' | 'DISPUTED' | 'ADJUDICATED';
  readonly disagreementSummary: InterAnnotatorAgreementMetrics | null;
  readonly adjudicatedSegments: readonly AnnotationSegmentInput[] | null;
  readonly preservedOriginalAnnotationIds: readonly string[];
  readonly policyNote: string;
  readonly createdAtIso: string;
}

export type DatasetReleaseType =
  | 'TRAIN'
  | 'VALIDATION'
  | 'TEST'
  | 'CHALLENGE'
  | 'REGRESSION'
  | 'STREAMING_EVALUATION'
  | 'RESEARCH_ONLY';

export type DatasetSplitName =
  | 'TRAIN'
  | 'VALIDATION'
  | 'TEST'
  | 'CHALLENGE'
  | 'REGRESSION'
  | 'STREAMING_EVALUATION'
  | 'RESEARCH_ONLY';

export interface SplitPolicyConfig {
  readonly groupBy: 'SPEAKER_AND_SESSION' | 'SPEAKER_ONLY' | 'SESSION_ONLY' | 'SOURCE_RECORDING';
  readonly trainRatio: number; // e.g. 0.70 (21h / 30h)
  readonly valRatio: number; // e.g. 0.10 (3h / 30h)
  readonly testRatio: number; // e.g. 0.20 (6h / 30h)
  readonly maxSingleSpeakerSharePercent: number; // e.g. 1% for large datasets
  readonly requireDoubleAnnotationForTestPct: number; // 100
  readonly requireDoubleAnnotationForTrainPct: number; // 20
  readonly randomSeed: number;
}

export interface LeakageAuditReport {
  readonly auditId: string;
  readonly datasetReleaseId: string;
  readonly status: 'PASSED' | 'FAILED_WITH_VIOLATIONS' | 'PASSED_WITH_LIMITATIONS';
  readonly exactDuplicateOverlapCount: number;
  readonly probableNearDuplicatePairCount: number;
  readonly repeatedTranscriptOverlapCount: number;
  readonly sharedSpeakerOverlapIds: readonly string[];
  readonly sharedSessionOverlapIds: readonly string[];
  readonly sourceRecordingOverlapIds: readonly string[];
  readonly protectedBenchmarkContaminationIds: readonly string[];
  readonly speakerDisjointVerified: boolean;
  readonly limitations: readonly string[];
  readonly executedAtIso: string;
}

export interface DatasetMembershipRecord {
  readonly membershipId: string;
  readonly datasetReleaseId: string;
  readonly recordingId: string;
  readonly artifactId: string;
  readonly split: DatasetSplitName;
  readonly speakerRef: string;
  readonly sessionRef: string;
  readonly checksumSha256: string;
  readonly included: boolean;
  readonly inclusionReason: string;
  readonly exclusionReason: string | null;
}

export interface AugmentationConfig {
  readonly speedFactor: number; // e.g. 0.90 | 0.95 | 1.00 | 1.05 | 1.10
  readonly gainDb: number;
  readonly targetNoiseSnrDb: number | null; // e.g. 5 | 10 | 15 | 20 | 25
  readonly telephoneBandpass: boolean;
  readonly reverberationMix: number; // 0..0.4
  readonly randomSeed: number;
}

export interface AugmentationRecordMetadata {
  readonly sourceRecordingId: string;
  readonly sourceArtifactId: string;
  readonly transformationSequence: readonly string[];
  readonly parameters: AugmentationConfig;
  readonly randomSeed: number;
  readonly processingImplementationVersion: string;
  readonly outputChecksumSha256: string;
  readonly outputDurationSeconds: number;
  readonly datasetReleaseId: string | null;
}

export interface DatasetReleaseRecord {
  readonly datasetReleaseId: string;
  readonly tenantId: string;
  readonly datasetId: string;
  readonly datasetName: string;
  readonly version: string;
  readonly releaseType: DatasetReleaseType;
  readonly configurationHash: string;
  readonly splitPolicy: SplitPolicyConfig;
  readonly immutable: true;
  readonly sealedTestProtected: boolean;
  readonly releaseStatus: 'PUBLISHED' | 'SEALED' | 'DEPRECATED' | 'REVOKED';
  readonly manifestArtifactId: string;
  readonly sourceRecordingIds: readonly string[];
  readonly includedArtifactVersions: readonly string[];
  readonly memberships: readonly DatasetMembershipRecord[];
  readonly languageDistributionSeconds: Record<LanguageClassification, number>;
  readonly durationBySplitSeconds: Record<string, number>;
  readonly uniqueSpeakerCount: number;
  readonly recordingSourceDistribution: Record<string, number>;
  readonly doubleAnnotatedSharePercent: number;
  readonly excludedRecordingReasons: readonly { recordingId: string; reason: string }[];
  readonly leakageAudit: LeakageAuditReport;
  readonly transcriptPolicyVersion: string;
  readonly normalizationPolicyVersion: string;
  readonly releaseAuthor: string;
  readonly createdAtIso: string;
}

export interface GrowthMilestoneProgress {
  readonly milestoneId: 'D0' | 'D1' | 'D2' | 'D3' | 'D4';
  readonly targetHours: number;
  readonly trainingEligibleHours: number;
  readonly completionPercent: number;
  readonly reached: boolean;
  readonly purpose: string;
}

export interface MultiDimensionalCorpusMetrics {
  readonly generatedAtIso: string;
  readonly durationBreakdownSeconds: {
    readonly uploadedSeconds: number;
    readonly validatedSeconds: number;
    readonly rightsApprovedSeconds: number;
    readonly annotatedSeconds: number;
    readonly reviewedSeconds: number;
    readonly trainingEligibleSeconds: number;
    readonly evaluationEligibleSeconds: number;
    readonly rejectedOrQuarantinedSeconds: number;
  };
  readonly audio: {
    readonly acceptedRecordingsCount: number;
    readonly rejectedOrQuarantinedCount: number;
    readonly corruptPercentage: number;
    readonly exactDuplicatePercentage: number;
    readonly nearDuplicateCandidateCount: number;
    readonly sampleRateDistribution: Record<string, number>;
    readonly channelDistribution: Record<string, number>;
    readonly qualityClassDistribution: Record<AudioQualityClass, number>;
    readonly meanClippingPercentage: number;
    readonly meanSilencePercentage: number;
  };
  readonly transcripts: {
    readonly totalWordCount: number;
    readonly totalCharacterCount: number;
    readonly languageDistributionCounts: Record<LanguageClassification, number>;
    readonly codeSwitchingRecordingsCount: number;
    readonly doubleAnnotatedRecordingsCount: number;
    readonly pendingAdjudicationCount: number;
    readonly unintelligibleEventsCount: number;
  };
  readonly diversity: {
    readonly uniqueSpeakerCount: number;
    readonly uniqueSessionCount: number;
    readonly sourceCount: number;
    readonly domainDistribution: Record<string, number>;
    readonly maxSingleSpeakerSharePercent: number;
    readonly speakerConcentrationWarning: boolean;
  };
  readonly governance: {
    readonly verifiedRightsPercentage: number;
    readonly consentRevokedCount: number;
    readonly legalHoldCount: number;
    readonly unresolvedRightsCount: number;
  };
  readonly expansionMilestones: readonly GrowthMilestoneProgress[];
}
