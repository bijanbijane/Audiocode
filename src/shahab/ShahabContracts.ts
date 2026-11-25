/**
 * SHAHAB — Avapardaz Native Speech Recognition Engine
 * Canonical Contracts, Evidence Taxonomy, Progress Validation & State Schemas
 * (Governing Contract: SHAHAB-PROGRAM-000 | Missions: SHAHAB-001 through SHAHAB-009)
 *
 * Strict Epistemic Rules:
 * - Never mix REPORTED (upstream publisher) with MEASURED or VERIFIED values.
 * - Unknown metrics remain `null` with status `'NOT_MEASURED'`.
 * - Download percentage is valid ONLY when exact verified `expectedBytes > 0`
 *   and `0 <= downloadedBytes <= expectedBytes`.
 * - Trainable parameters = 0 for the frozen inherited neural core (never a training bar).
 */

import {
  applySafePersianZwnjToken,
  normalizeUnicodeScriptAware,
} from '../asr-core/PersianLinguisticQualityEngine';

export const SHAHAB_PROGRAM_VERSION = '0.9.0-shahab-foundation';
export const SHAHAB_STATE_SCHEMA_VERSION = '1.0.0';

export type ShahabEvidenceStatus =
  | 'VERIFIED'
  | 'MEASURED'
  | 'REPORTED'
  | 'ESTIMATED'
  | 'NOT_MEASURED'
  | 'BLOCKED';

export type ShahabPhaseStatus =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'BLOCKED'
  | 'FAILED'
  | 'COMPLETED_UNVERIFIED'
  | 'VERIFIED';

export type ShahabMissionId =
  | 'SHAHAB-001'
  | 'SHAHAB-002'
  | 'SHAHAB-003'
  | 'SHAHAB-004'
  | 'SHAHAB-005'
  | 'SHAHAB-006'
  | 'SHAHAB-007'
  | 'SHAHAB-008'
  | 'SHAHAB-009'
  | 'SHAHAB-010'
  | 'SHAHAB-011'
  | 'SHAHAB-012'
  | 'SHAHAB-013'
  | 'SHAHAB-014'
  | 'SHAHAB-015'
  | 'SHAHAB-016'
  | 'SHAHAB-017'
  | 'SHAHAB-018'
  | 'SHAHAB-019'
  | 'SHAHAB-020'
  | 'SHAHAB-021'
  | 'SHAHAB-022'
  | 'SHAHAB-023'
  | 'SHAHAB-024'
  | 'SHAHAB-025'
  | 'SHAHAB-026'
  | 'SHAHAB-027'
  | 'SHAHAB-028'
  | 'SHAHAB-029'
  | 'SHAHAB-030';

export type ShahabTrackKey =
  | 'repository_inspection'
  | 'model_selection'
  | 'artifact_acquisition'
  | 'model_verification'
  | 'baseline_inference'
  | 'runtime_implementation'
  | 'decoder_implementation'
  | 'cache_implementation'
  | 'persian_context_memory'
  | 'quantization'
  | 'benchmarking'
  | 'local_cloud_integration';

export interface ShahabMetricValue<T = number | string | null> {
  readonly value: T;
  readonly unit: string;
  readonly method: string;
  readonly source: string;
  readonly timestampUtc: string;
  readonly environment: string;
  readonly status: ShahabEvidenceStatus;
  readonly note?: string;
}

export interface ShahabEvidenceEvent {
  readonly eventId: string;
  readonly timestampUtc: string;
  readonly missionId: ShahabMissionId | 'SHAHAB-PROGRAM-000';
  readonly taskId: string;
  readonly eventType: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly measurementValue: number | string | null;
  readonly measurementUnit: string | null;
  readonly measurementMethod: string;
  readonly evidenceSource: string;
  readonly artifactRef: string | null;
  readonly modelRevision: string | null;
  readonly sha256: string | null;
  readonly environmentId: string;
  readonly verificationStatus: ShahabEvidenceStatus;
  readonly supersedesEventId?: string | null;
}

export interface ShahabMissionRecord {
  readonly missionId: ShahabMissionId;
  readonly title: string;
  readonly status: ShahabPhaseStatus;
  readonly verifiedTaskCount: number;
  readonly totalTaskCount: number;
  readonly startedAtUtc: string | null;
  readonly verifiedAtUtc: string | null;
  readonly acceptancePassed: boolean | null;
  readonly blockers: readonly string[];
}

export interface ShahabHardwareEnvironment {
  readonly capturedAtUtc: string;
  readonly osKernel: string;
  readonly osPrettyName: string;
  readonly cpuArch: string;
  readonly cpuCores: number;
  readonly cpuModel: string;
  readonly totalRamBytes: number;
  readonly availableRamBytes: number;
  readonly diskTotalBytes: number;
  readonly diskAvailableBytes: number;
  readonly gpuPresent: boolean;
  readonly gpuModel: string | null;
  readonly vramBytes: number | null;
  readonly cudaAvailable: boolean;
  readonly nodeVersion: string | null;
  readonly npmVersion: string | null;
  readonly bunVersion: string | null;
  readonly pythonVersion: string | null;
  readonly pythonOnnxRuntimeProviders: readonly string[];
  readonly jsOnnxRuntimeWebVersion: string | null;
  readonly sherpaOnnxBinaryPresent: boolean;
  readonly nativeBuildTools: Readonly<Record<string, string | null>>;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  readonly gitDirtyFileCount: number | null;
  readonly gitStatusNote: string;
}

export interface ShahabRemoteFileEntry {
  readonly path: string;
  readonly sizeBytes: number | null;
  readonly sha256LfsOid: string | null;
  readonly downloadUrl: string;
  readonly category:
    | 'weights_int8'
    | 'weights_fp32'
    | 'weights_other'
    | 'tokens'
    | 'tokenizer'
    | 'config'
    | 'script'
    | 'license'
    | 'documentation'
    | 'sample_audio'
    | 'other';
  readonly requiredForInference: boolean;
}

export interface ShahabCandidateModelRecord {
  readonly candidateId: string;
  readonly displayName: string;
  readonly sourceKind: 'huggingface' | 'github';
  readonly repoId: string;
  readonly upstreamUrl: string;
  readonly defaultBranch: string | null;
  readonly pinnedRevisionSha: string | null;
  readonly revisionStatus: ShahabEvidenceStatus;
  readonly architecture: string;
  readonly modelFamily: string;
  readonly reportedParameters: ShahabMetricValue<string | number | null>;
  readonly licenseSpdx: string | null;
  readonly licenseFilePresent: boolean;
  readonly licenseTextExcerpt: string | null;
  readonly licenseStatus: 'PERMISSIVE_CLEAR' | 'PERMISSIVE_NO_STANDALONE_FILE' | 'LEGAL_GATE_REQUIRED' | 'MISSING_OR_AMBIGUOUS';
  readonly legalGateNote: string;
  readonly totalRepositoryBytes: number | null;
  readonly selectedInferencePackageBytes: number | null;
  readonly fileCount: number | null;
  readonly files: readonly ShahabRemoteFileEntry[];
  readonly supportedRuntimes: readonly string[];
  readonly audioConfig: {
    readonly sampleRateHz: number | null;
    readonly channels: number | null;
    readonly featureDim: number | null;
    readonly note: string;
  };
  readonly knownLimitations: readonly string[];
  readonly inspectedAtUtc: string;
  readonly inspectionStatus: ShahabEvidenceStatus;
}

export interface ShahabThirdPartyReuseItem {
  readonly componentId: string;
  readonly upstreamRepo: string;
  readonly pinnedCommitSha: string | null;
  readonly licenseSpdx: string | null;
  readonly targetPathOrModule: string;
  readonly reuseCategory:
    | 'runtime_integration'
    | 'transducer_inference'
    | 'streaming_state'
    | 'decoder_behavior'
    | 'vad'
    | 'model_loading'
    | 'language_bindings'
    | 'optimization';
  readonly technicalFeasibility: 'DIRECT_DEPENDENCY' | 'NARROW_ADAPTATION' | 'REFERENCE_ONLY' | 'BLOCKED';
  readonly copyrightAndNoticeObligation: string;
  readonly assessmentNote: string;
}

export interface ShahabArtifactTransferRecord {
  readonly artifactId: string;
  readonly repoId: string;
  readonly immutableRevision: string;
  readonly relativePath: string;
  readonly localPath: string;
  readonly role: string;
  readonly mandatory: boolean;
  readonly expectedBytes: number | null;
  readonly downloadedBytes: number;
  readonly downloadPercent: number | null;
  readonly sha256Expected: string | null;
  readonly sha256Actual: string | null;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string | null;
  readonly retryCount: number;
  readonly integrityStatus: 'PENDING' | 'DOWNLOADING' | 'VERIFIED' | 'CHECKSUM_FAILED' | 'FAILED';
}

export interface ShahabOnnxGraphStats {
  readonly filePath: string;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly irVersion: number;
  readonly opsetVersion: number | null;
  readonly producerName: string;
  readonly nodeCount: number;
  readonly operatorCounts: Readonly<Record<string, number>>;
  readonly initializerTensorCount: number;
  readonly uniqueInitializerTensorCount: number;
  readonly duplicateInitializerTensorCount: number;
  readonly parameterElementCount: number;
  readonly quantizedWeightElementCount?: number;
  readonly floatWeightElementCount?: number;
  readonly nonParameterConstantElementCount: number;
  readonly totalInitializerElementCount: number;
  readonly parameterStorageBytes: number;
  readonly dtypeTensorCounts: Readonly<Record<string, number>>;
  readonly dtypeElementCounts: Readonly<Record<string, number>>;
  readonly quantizedTensorCount: number;
  readonly nonQuantizedTensorCount: number;
  readonly externalDataTensorCount: number;
  readonly externalDataLocations: readonly string[];
  readonly inputs: readonly { readonly name: string; readonly dtype: string; readonly shape: readonly (number | string)[] }[];
  readonly outputs: readonly { readonly name: string; readonly dtype: string; readonly shape: readonly (number | string)[] }[];
  readonly metadataProps: Readonly<Record<string, string>>;
  readonly countingMethodology: string;
  readonly ambiguityNotes: readonly string[];
}

export interface ShahabModelParameterSummary {
  readonly publisherReportedParameters: ShahabMetricValue<number | string | null>;
  readonly independentlyParsedElements: ShahabMetricValue<number | null>;
  readonly verifiedParameterCount: ShahabMetricValue<number | null>;
  readonly trainableParameters: ShahabMetricValue<number>;
  readonly frozenParameters: ShahabMetricValue<number | null>;
  readonly parameterStorageBytes: ShahabMetricValue<number | null>;
  readonly totalTensorCount: number | null;
  readonly uniqueTensorCount: number | null;
  readonly duplicateTensorCount: number | null;
  readonly quantizedTensorCount: number | null;
  readonly nonQuantizedTensorCount: number | null;
  readonly externalDataTensorCount: number | null;
  readonly dtypeDistribution: Readonly<Record<string, number>>;
  readonly countingMethodology: string;
  readonly graphs: readonly ShahabOnnxGraphStats[];
}

export interface ShahabSizeBreakdown {
  readonly remoteRepositoryBytes: ShahabMetricValue<number | null>;
  readonly selectedMandatoryPackageBytes: ShahabMetricValue<number | null>;
  readonly localModelStoreBytes: ShahabMetricValue<number | null>;
  readonly installedPackageBytes: ShahabMetricValue<number | null>;
  readonly quantizedModelWeightsBytes: ShahabMetricValue<number | null>;
  readonly runtimeDependenciesBytes: ShahabMetricValue<number | null>;
  readonly downloadArchiveBytes: ShahabMetricValue<number | null>;
  readonly residentMemoryAfterLoadBytes: ShahabMetricValue<number | null>;
  readonly below100MiBVerified: boolean;
  readonly below100MiBNote: string;
}

export interface ShahabBenchmarkRecord {
  readonly benchmarkId: string;
  readonly dataset: string;
  readonly datasetRevision: string;
  readonly audioDurationSec: number;
  readonly sampleCount: number;
  readonly hardware: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly runtimeVersion: string;
  readonly inferenceConfig: string;
  readonly normalizationPolicy: string;
  readonly measuredAtUtc: string;
  readonly status: ShahabEvidenceStatus;
  readonly wer: number | null;
  readonly cer: number | null;
  readonly substitutions: number | null;
  readonly deletions: number | null;
  readonly insertions: number | null;
  readonly properNounErrorRate: number | null;
  readonly numericAccuracy: number | null;
  readonly loadTimeMs: number | null;
  readonly coldLatencyMs: number | null;
  readonly warmLatencyMs: number | null;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly realTimeFactor: number | null;
  readonly throughputAudioSecPerWallSec: number | null;
  readonly peakRamBytes: number | null;
  readonly peakVramBytes: number | null;
  readonly cpuUserMs: number | null;
  readonly cpuSystemMs: number | null;
  readonly rawTranscriptSample: string | null;
  readonly normalizedTranscriptSample: string | null;
  readonly referenceTranscriptSample: string | null;
  readonly notes: string;
}

export interface ShahabCacheExperimentSummary {
  readonly status: ShahabPhaseStatus;
  readonly encoderReuseFeasible: boolean | null;
  readonly feasibilityProofNote: string;
  readonly numericalMaxAbsDiff: number | null;
  readonly transcriptIdentical: boolean | null;
  readonly measuredAtUtc: string | null;
  readonly scenarios: readonly {
    readonly scenarioId: 'A_BASELINE' | 'B_FULL_REINFER' | 'C_CACHED_REDECODE' | 'D_SELECTIVE_REGION';
    readonly label: string;
    readonly encoderInvocations: number;
    readonly decoderInvocations: number;
    readonly cacheHitRate: number;
    readonly cacheBytes: number;
    readonly totalLatencyMs: number;
    readonly peakRamBytes: number;
    readonly wer: number | null;
    readonly cer: number | null;
    readonly rawText: string;
  }[];
  readonly measuredTimeSavedMs: number | null;
  readonly measuredEncoderCallsAvoided: number | null;
  readonly cacheMemoryOverheadBytes: number | null;
}

export interface ShahabAdaptiveDecodingSummary {
  readonly status: ShahabPhaseStatus;
  readonly activePolicy: 'SPEED' | 'BALANCED' | 'PRECISION' | 'VOCABULARY' | 'VERBATIM';
  readonly policyComparisons: readonly {
    readonly policyId: 'SPEED' | 'BALANCED' | 'PRECISION' | 'VOCABULARY' | 'VERBATIM';
    readonly decodingMethod: 'greedy_search' | 'modified_beam_search';
    readonly maxActivePaths: number;
    readonly blankPenalty: number;
    readonly allowContextBias: boolean;
    readonly decoderPasses: number;
    readonly segmentsReprocessed: number;
    readonly latencyMs: number;
    readonly additionalLatencyMs: number;
    readonly wer: number | null;
    readonly cer: number | null;
    readonly selectionReason: string;
    readonly rawText: string;
  }[];
}

export interface ShahabPersianContextSummary {
  readonly status: ShahabPhaseStatus;
  readonly verifiedProjectTermsCount: number;
  readonly verifiedDomainTermsCount: number;
  readonly unverifiedCandidatesCount: number;
  readonly contextualTermsAppliedCount: number;
  readonly targetTermRecoveryRate: number | null;
  readonly falseInsertionRate: number | null;
  readonly incorrectSubstitutionRate: number | null;
  readonly userConfirmedCorrectionsCount: number;
  readonly evidenceCompletenessStatus: ShahabEvidenceStatus;
  readonly unresolvedSegmentsCount: number;
  readonly terms: readonly {
    readonly termId: string;
    readonly surfaceForm: string;
    readonly tier: 'VERIFIED_PROJECT_TERMS' | 'VERIFIED_DOMAIN_TERMS' | 'UNVERIFIED_CANDIDATES';
    readonly bpeTokenIds: readonly number[];
    readonly tokenizable: boolean;
    readonly evidenceSource: string;
    readonly projectScope: string;
    readonly createdAtUtc: string;
    readonly lastConfirmedAtUtc: string | null;
  }[];
}

export interface ShahabOptimizationVariantRecord {
  readonly variantId: string;
  readonly label: string;
  readonly category: 'A_ORIGINAL_INT8' | 'B_GRAPH_OPTIMIZED_INT8' | 'C_MIXED_PRECISION_INT4' | 'D_COMPACT_ARCHIVE';
  readonly compatibilityStatus: 'COMPATIBLE_VERIFIED' | 'INCOMPATIBLE_RUNTIME' | 'NOT_VERIFIED' | 'ARCHIVE_TRANSFER_ONLY';
  readonly verificationStatus: ShahabEvidenceStatus;
  readonly originalPackageBytes: number;
  readonly variantPackageBytes: number | null;
  readonly exactByteReduction: number | null;
  readonly compressionRatio: number | null;
  readonly transferArchiveBytes: number | null;
  readonly tensorPrecisionBreakdown: Readonly<Record<string, number>>;
  readonly convertedTensorCount: number;
  readonly unconvertedTensorCount: number;
  readonly loadTimeMs: number | null;
  readonly warmLatencyMs: number | null;
  readonly realTimeFactor: number | null;
  readonly peakRamBytes: number | null;
  readonly wer: number | null;
  readonly cer: number | null;
  readonly werDeltaVsBaseline: number | null;
  readonly cerDeltaVsBaseline: number | null;
  readonly artifactPath: string | null;
  readonly sha256Summary: string | null;
  readonly notes: string;
}

export interface ShahabImplementationState {
  readonly schemaVersion: string;
  readonly programVersion: string;
  readonly productName: string;
  readonly releaseId: string | null;
  readonly currentMissionId: ShahabMissionId;
  readonly currentPhase: string;
  readonly currentTask: string;
  readonly lastVerifiedEventId: string | null;
  readonly lastUpdatedUtc: string;
  readonly hardwareEnvironment: ShahabHardwareEnvironment;
  readonly missions: Readonly<Record<ShahabMissionId, ShahabMissionRecord>>;
  readonly developmentTracks: Readonly<Record<ShahabTrackKey, ShahabPhaseStatus>>;
  readonly selectedModel: {
    readonly modelId: string | null;
    readonly displayName: string | null;
    readonly modelFamily: string | null;
    readonly architecture: string | null;
    readonly upstreamRepository: string | null;
    readonly immutableRevisionSha: string | null;
    readonly licenseSpdx: string | null;
    readonly licenseStatus: string;
    readonly inputConfiguration: string | null;
    readonly tokenizer: string | null;
    readonly inferenceRuntime: string | null;
    readonly weightImmutabilityVerified: boolean;
    readonly modelLoadedStatus: 'NOT_LOADED' | 'LOADED_VERIFIED' | 'LOAD_FAILED';
    readonly selectionDecisionRef: string | null;
  };
  readonly candidateModels: readonly ShahabCandidateModelRecord[];
  readonly thirdPartyReuseInventory: readonly ShahabThirdPartyReuseItem[];
  readonly artifactInventory: readonly ShahabArtifactTransferRecord[];
  readonly parameterSummary: ShahabModelParameterSummary;
  readonly sizeBreakdown: ShahabSizeBreakdown;
  readonly benchmarks: readonly ShahabBenchmarkRecord[];
  readonly cacheExperiment: ShahabCacheExperimentSummary;
  readonly adaptiveDecoding: ShahabAdaptiveDecodingSummary;
  readonly persianContext: ShahabPersianContextSummary;
  readonly optimizationVariants: readonly ShahabOptimizationVariantRecord[];
  readonly realInferenceTestCount: number;
  readonly realInferencePassedCount: number;
  readonly testSummary: {
    readonly status: ShahabPhaseStatus;
    readonly totalTests: number | null;
    readonly passedTests: number | null;
    readonly failedTests: number | null;
    readonly lastRunUtc: string | null;
    readonly command: string | null;
  };
  readonly blockers: readonly {
    readonly blockerId: string;
    readonly missionId: ShahabMissionId;
    readonly severity: 'HIGH' | 'MEDIUM' | 'LOW';
    readonly summary: string;
    readonly impact: string;
    readonly status: 'OPEN' | 'MITIGATED' | 'RESOLVED';
  }[];
}

/**
 * Strictly formats bytes in both decimal MB (10^6) and binary MiB (2^20).
 */
export function formatBytesDual(bytes: number | null | undefined): {
  readonly bytes: number | null;
  readonly mb: string;
  readonly mib: string;
  readonly display: string;
} {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return { bytes: null, mb: 'NOT_MEASURED', mib: 'NOT_MEASURED', display: 'NOT_MEASURED' };
  }
  const mbVal = (bytes / 1_000_000).toFixed(2);
  const mibVal = (bytes / (1024 * 1024)).toFixed(2);
  return {
    bytes,
    mb: `${mbVal} MB`,
    mib: `${mibVal} MiB`,
    display: `${mbVal} MB (${mibVal} MiB) · ${bytes.toLocaleString('en-US')} B`,
  };
}

/**
 * Computes download progress strictly from verified byte counts.
 * Throws on invalid negative/overflowing values; returns `null` (indeterminate)
 * when `expectedBytes` is unknown (`null`).
 */
export function computeValidatedDownloadPercent(
  downloadedBytes: number,
  expectedBytes: number | null,
): number | null {
  if (!Number.isFinite(downloadedBytes) || downloadedBytes < 0) {
    throw new Error(`INVALID_DOWNLOAD_PROGRESS: downloadedBytes (${downloadedBytes}) must be >= 0.`);
  }
  if (expectedBytes === null) {
    return null; // Indeterminate progress — never invent a percentage!
  }
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`INVALID_DOWNLOAD_PROGRESS: expectedBytes (${expectedBytes}) must be > 0 or null.`);
  }
  if (downloadedBytes > expectedBytes) {
    throw new Error(
      `INVALID_DOWNLOAD_PROGRESS: downloadedBytes (${downloadedBytes}) exceeds expectedBytes (${expectedBytes}).`,
    );
  }
  const pct = Number(((downloadedBytes / expectedBytes) * 100).toFixed(2));
  if (pct < 0 || pct > 100) {
    throw new Error(`INVALID_DOWNLOAD_PROGRESS: computed percentage (${pct}) out of [0, 100].`);
  }
  return pct;
}

/**
 * Thin deterministic wrapper over existing Avapardaz P0-009 (`PersianLinguisticQualityEngine`)
 * so SHAHAB modules reuse P0-009 directly without duplicating Persian normalization logic.
 */
export function normalizePersianTextDeterministic(
  text: string,
  _options?: { readonly digitPolicy?: 'PRESERVE_ORIGINAL' | 'PERSIAN_DIGITS' | 'LATIN_DIGITS' },
): { readonly normalized: string; readonly raw: string } {
  const step1 = normalizeUnicodeScriptAware(text, {
    stripDiacritics: false,
    preserveZwnj: true,
  });
  const tokens = step1
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => applySafePersianZwnjToken(tok));
  return {
    normalized: tokens.join(' '),
    raw: text,
  };
}

