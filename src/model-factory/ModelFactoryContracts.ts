/**
 * PHASE 13 — ASR MODEL FACTORY & MLOPS LIFECYCLE GOVERNANCE CONTRACTS
 * Browser-safe pure TypeScript interfaces shared across Model Factory engines, HTTP Gateway, Router Bridge, and Studio UI.
 */

export type ExperimentObjective =
  | 'PERSIAN_CER_REDUCTION'
  | 'PERSIAN_WER_REDUCTION'
  | 'ENGLISH_CER_REDUCTION'
  | 'ENGLISH_WER_REDUCTION'
  | 'CODE_SWITCHING_IMPROVEMENT'
  | 'NOISE_ROBUSTNESS'
  | 'LONG_FORM_IMPROVEMENT'
  | 'STREAMING_LATENCY_IMPROVEMENT'
  | 'MODEL_SIZE_REDUCTION'
  | 'THROUGHPUT_IMPROVEMENT'
  | 'MEMORY_REDUCTION'
  | 'COST_REDUCTION';

export type ModelInitializationType =
  | 'PRETRAINED_INFERENCE'
  | 'FULL_FINE_TUNING'
  | 'PARAMETER_EFFICIENT_FINE_TUNING'
  | 'ADAPTER_TUNING'
  | 'RANDOM_INITIALIZATION'
  | 'SELF_SUPERVISED_PRETRAINING'
  | 'DISTILLATION';

export type ReproducibilityLevel =
  | 'CONFIGURATION_REPRODUCIBLE'
  | 'ENVIRONMENT_REPRODUCIBLE'
  | 'DATA_REPRODUCIBLE'
  | 'EXECUTION_REPRODUCIBLE'
  | 'BITWISE_REPRODUCIBLE';

export type TrainingRunStatus =
  | 'CREATED'
  | 'VALIDATING'
  | 'QUEUED'
  | 'INITIALIZING'
  | 'RUNNING'
  | 'CHECKPOINTING'
  | 'EVALUATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'BLOCKED';

export type TrainingFailureCategory =
  | 'OUT_OF_MEMORY'
  | 'DATASET_CORRUPTION'
  | 'DEPENDENCY_FAILURE'
  | 'GPU_UNAVAILABLE'
  | 'WORKER_INTERRUPTION'
  | 'NUMERICAL_INSTABILITY'
  | 'NAN_LOSS'
  | 'CHECKPOINT_WRITE_FAILURE'
  | 'STORAGE_OUTAGE'
  | 'USER_CANCELLATION'
  | 'PREFLIGHT_REJECTED';

export type ResourceClass = 'CPU_ONLY' | 'GPU_SMALL' | 'GPU_MEDIUM' | 'GPU_LARGE' | 'MULTI_GPU';

export type ModelLifecycleStatus =
  | 'RESEARCH'
  | 'TRAINED'
  | 'EVALUATED'
  | 'CANDIDATE'
  | 'APPROVED'
  | 'STAGED'
  | 'CANARY'
  | 'PRODUCTION'
  | 'REJECTED'
  | 'BLOCKED'
  | 'DEPRECATED'
  | 'ARCHIVED'
  | 'WITHDRAWN';

export type RegistryTag =
  | 'research'
  | 'benchmark'
  | 'candidate'
  | 'approved'
  | 'production'
  | 'deprecated';

export type DeploymentStrategy =
  | 'DIRECT_DEV'
  | 'STAGING'
  | 'SHADOW'
  | 'CANARY'
  | 'FULL_PRODUCTION'
  | 'ROLLBACK';

export type DeploymentEnvironment = 'DEVELOPMENT' | 'STAGING' | 'SHADOW' | 'CANARY' | 'PRODUCTION';

export type ModelServingHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'LOADING' | 'DRAINING';

export type CostCategory =
  | 'FORECAST'
  | 'RESERVED'
  | 'ACTUAL_MEASURED'
  | 'ACTUAL_INVOICED'
  | 'UNKNOWN';

export interface ExperimentHypothesis {
  readonly problemAddressed: string;
  readonly proposedChange: string;
  readonly expectedMeasurableEffect: string;
  readonly affectedDatasetSlices: readonly string[];
  readonly possibleNegativeEffects: string;
  readonly acceptanceCriterion: string;
}

export interface TrainingConfigurationSpec {
  readonly optimizer: 'adamw' | 'sgd' | 'adafactor' | 'contextual_bigram_em';
  readonly learningRate: number;
  readonly scheduler: 'cosine' | 'linear' | 'constant';
  readonly warmupSteps: number;
  readonly batchSize: number;
  readonly gradientAccumulationSteps: number;
  readonly epochs: number;
  readonly maxTrainingSteps: number;
  readonly weightDecay: number;
  readonly gradientClipping: number;
  readonly precisionMode: 'fp32' | 'bf16' | 'fp16' | 'int8_qat';
  readonly adapterOrLoraConfig: {
    readonly enabled: boolean;
    readonly method: 'NONE' | 'LORA' | 'CONTEXTUAL_BIGRAM_ADAPTER' | 'CTC_PROJECTION';
    readonly rank?: number;
    readonly alpha?: number;
    readonly targetModules?: readonly string[];
  };
  readonly checkpointEverySteps: number;
  readonly earlyStoppingPatience: number;
  readonly dataSamplingPolicy: string;
  readonly audioAugmentationPolicy: string;
  readonly validationEverySteps: number;
}

export interface EnvironmentCaptureManifest {
  readonly capturedAtIso: string;
  readonly sourceCommit: string;
  readonly nodeVersion: string;
  readonly pythonVersion: string | null;
  readonly frameworkVersions: Record<string, string>;
  readonly cudaVersion: string | null;
  readonly gpuDetected: boolean;
  readonly gpuModel: string | null;
  readonly gpuMemoryMb: number;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly hostRamMb: number;
  readonly operatingSystem: string;
  readonly containerImageDigest: string;
  readonly dependencyLockfile: string;
  readonly dependencyLockfileHash: string;
  readonly nonSecretExecutionEnvVars: Record<string, string>;
  readonly deterministicFlags: Record<string, string | boolean>;
  readonly nonDeterminismVariationSources: readonly string[];
}

export interface RandomSeedsRecord {
  readonly pythonSeed: number;
  readonly numpySeed: number;
  readonly torchCpuSeed: number;
  readonly torchCudaSeed: number | null;
  readonly dataSamplerSeed: number;
  readonly augmentationSeed: number;
  readonly workerInitSeed: number;
}

export interface MlExperimentRecord {
  readonly experimentId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly parentExperimentId: string | null;
  readonly experimentName: string;
  readonly primaryObjective: ExperimentObjective;
  readonly secondaryMetrics: readonly string[];
  readonly hypothesis: ExperimentHypothesis;
  readonly modelFamily: string;
  readonly architecture: string;
  readonly initializationType: ModelInitializationType;
  readonly baseModelVersion: string;
  readonly initialCheckpointId: string | null;
  readonly configuration: TrainingConfigurationSpec;
  readonly configurationHash: string;
  readonly configurationLocked: boolean;
  readonly datasetReleaseIds: readonly string[];
  readonly datasetManifestHashes: readonly string[];
  readonly evaluationDatasetReleaseId: string | null;
  readonly sourceCommit: string;
  readonly dependencyLockfileHash: string;
  readonly containerImageDigest: string;
  readonly requestedResourceClass: ResourceClass;
  readonly reproducibilityLevel: ReproducibilityLevel;
  readonly randomSeeds: RandomSeedsRecord;
  readonly ownerId: string;
  readonly status: 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly createdAtIso: string;
}

export interface PreflightCheckItem {
  readonly checkName: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ComputeCostTelemetry {
  readonly costCategory: CostCategory;
  readonly gpuModel: string | null;
  readonly gpuSeconds: number;
  readonly peakVramMb: number;
  readonly cpuSeconds: number;
  readonly peakRamMb: number;
  readonly storageBytesConsumed: number;
  readonly trainingDurationMs: number;
  readonly evaluationDurationMs: number;
  readonly checkpointStorageBytes: number;
  readonly retryCount: number;
  readonly estimatedCostUsd: number;
  readonly invoicedCostUsd: number | null;
}

export interface TrainingRunRecord {
  readonly trainingRunId: string;
  readonly tenantId: string;
  readonly experimentId: string;
  readonly datasetReleaseId: string;
  readonly datasetManifestHash: string;
  readonly resourceClass: ResourceClass;
  readonly priorityClass: 'LOW' | 'STANDARD' | 'HIGH';
  readonly status: TrainingRunStatus;
  readonly preflightPassed: boolean;
  readonly preflightChecks: readonly PreflightCheckItem[];
  readonly environmentManifest: EnvironmentCaptureManifest;
  readonly randomSeeds: RandomSeedsRecord;
  readonly resumedFromCheckpointId: string | null;
  readonly currentStep: number;
  readonly maxSteps: number;
  readonly lossHistory: readonly { step: number; trainLoss: number; valCerPercent: number | null }[];
  readonly failureCategory: TrainingFailureCategory | null;
  readonly failureReason: string | null;
  readonly telemetry: ComputeCostTelemetry;
  readonly weightsOutputSummary: {
    readonly lexicalBoostCount: number;
    readonly bigramTransitionCount: number;
    readonly weightsHash: string;
  } | null;
  readonly startedAtIso: string | null;
  readonly completedAtIso: string | null;
  readonly createdAtIso: string;
}

export interface TrainingCheckpointRecord {
  readonly checkpointId: string;
  readonly tenantId: string;
  readonly experimentId: string;
  readonly trainingRunId: string;
  readonly globalStep: number;
  readonly epoch: number;
  readonly checkpointType: 'TEMPORARY' | 'PERIODIC' | 'BEST_VALIDATION' | 'FINAL' | 'INTERRUPTION_RECOVERY';
  readonly integrityStatus: 'STAGING' | 'COMMITTED' | 'CORRUPT';
  readonly architecture: string;
  readonly tokenizerVersion: string;
  readonly optimizerStateIncluded: boolean;
  readonly schedulerStateIncluded: boolean;
  readonly randomStateIncluded: boolean;
  readonly artifactLocation: string;
  readonly artifactHash: string;
  readonly validationMetrics: {
    readonly trainLoss: number;
    readonly valCerPercent: number;
    readonly persianValCerPercent: number;
    readonly englishValCerPercent: number;
    readonly codeSwitchValCerPercent: number;
  };
  readonly protectedFromRetentionGc: boolean;
  readonly createdAtIso: string;
}

export interface AsrSliceMetrics {
  readonly sliceName: string;
  readonly status: 'EVALUATED' | 'NO_EVIDENCE';
  readonly sampleCount: number;
  readonly speakerCount: number;
  readonly rawCerPercent: number | null;
  readonly rawWerPercent: number | null;
  readonly normalizedCerPercent: number | null;
  readonly normalizedWerPercent: number | null;
  readonly merPercent: number | null;
  readonly insertions: number;
  readonly deletions: number;
  readonly substitutions: number;
  readonly emptyTranscriptionRate: number;
  readonly failureRate: number;
  readonly processingTimeMs: number;
}

export interface StreamingEvalMetrics {
  readonly streamingEvaluated: boolean;
  readonly nativeStreamingSupported: boolean;
  readonly timeToFirstPartialMs: number | null;
  readonly finalizationLatencyMs: number | null;
  readonly realTimeFactor: number | null;
  readonly partialRevisionCount: number | null;
  readonly transcriptStabilityRatio: number | null;
  readonly eventOrderingValid: boolean;
  readonly audioLossRatio: number;
  readonly sessionFailureRate: number;
  readonly note: string;
}

export interface PairedBootstrapConfidenceInterval {
  readonly metricName: string;
  readonly samplingUnit: 'utterance';
  readonly bootstrapIterations: number;
  readonly confidenceLevel: number;
  readonly randomSeed: number;
  readonly baselineMean: number;
  readonly candidateMean: number;
  readonly meanDeltaCandidateMinusBaseline: number;
  readonly ci95Lower: number;
  readonly ci95Upper: number;
  readonly pValueTwoSided: number;
  readonly statisticallySignificantImprovement: boolean;
}

export interface ModelEvaluationReport {
  readonly evaluationId: string;
  readonly tenantId: string;
  readonly experimentId: string;
  readonly trainingRunId: string | null;
  readonly modelVersionId: string;
  readonly baselineModelVersionId: string | null;
  readonly datasetReleaseId: string;
  readonly datasetManifestHash: string;
  readonly datasetSplit: 'VALIDATION' | 'TEST' | 'HOLDOUT';
  readonly metricPolicyVersion: string;
  readonly normalizationConfiguration: string;
  readonly coreSlices: readonly AsrSliceMetrics[];
  readonly persianLinguisticSlices: readonly AsrSliceMetrics[];
  readonly streamingMetrics: StreamingEvalMetrics;
  readonly pairedComparisons: readonly PairedBootstrapConfidenceInterval[];
  readonly promotionGateChecks: readonly {
    readonly gateName: string;
    readonly passed: boolean;
    readonly measuredValue: string;
    readonly threshold: string;
  }[];
  readonly overallPromotionGatePassed: boolean;
  readonly totalRuntimeMs: number;
  readonly resourceUsageSummary: ComputeCostTelemetry;
  readonly limitations: readonly string[];
  readonly createdAtIso: string;
}

export interface LicenseProvenanceMetadata {
  readonly sourceCodeLicense: string;
  readonly baseWeightsLicense: string;
  readonly tokenizerLicense: string;
  readonly trainingDataLicenseSummary: string;
  readonly evaluationDataLicenseSummary: string;
  readonly runtimeDependenciesLicense: string;
  readonly commercialUseVerified: boolean;
  readonly redistributionPermitted: boolean;
  readonly licenseStatus: 'VERIFIED_COMMERCIAL' | 'NON_COMMERCIAL_RESEARCH' | 'RESTRICTED' | 'UNKNOWN';
  readonly blockers: readonly string[];
}

export interface ModelCardDocument {
  readonly modelId: string;
  readonly version: string;
  readonly intendedUse: string;
  readonly supportedLanguagesVerified: readonly string[];
  readonly unsupportedOrWeakConditions: readonly string[];
  readonly trainingMethod: ModelInitializationType;
  readonly datasetProvenance: readonly { readonly datasetReleaseId: string; readonly manifestHash: string }[];
  readonly licenseSummary: string;
  readonly benchmarkEvaluationIds: readonly string[];
  readonly hardwareRequirements: { readonly resourceClass: ResourceClass; readonly minRamMb: number; readonly minVramMb: number };
  readonly knownBiasesAndLimitations: readonly string[];
  readonly safetyAndPrivacyNotes: string;
  readonly versionHistoryNotes: readonly string[];
}

export interface ModelCapabilitiesDeclaration {
  readonly batchSupported: boolean;
  readonly nativeStreamingSupported: boolean;
  readonly vadSegmentedStreamingSupported: boolean;
  readonly supportedLanguages: readonly ('fa' | 'en' | 'fa-en')[];
  readonly supportedSampleRates: readonly number[];
  readonly maxDurationSeconds: number;
  readonly timestampsSupported: boolean;
  readonly diarizationSupported: boolean;
  readonly minRamMb: number;
  readonly minVramMb: number;
  readonly capabilityTestVerifiedAtIso: string | null;
}

export interface ModelVersionRecord {
  readonly modelVersionId: string;
  readonly tenantId: string;
  readonly modelId: string;
  readonly version: string;
  readonly modelFamily: string;
  readonly architecture: string;
  readonly initializationType: ModelInitializationType;
  readonly baseModelReference: string;
  readonly parentModelVersionId: string | null;
  readonly trainingExperimentId: string;
  readonly checkpointId: string | null;
  readonly datasetLineage: readonly { readonly datasetReleaseId: string; readonly manifestHash: string }[];
  readonly tokenizerVersion: string;
  readonly configurationHash: string;
  readonly weightsArtifactHash: string;
  readonly artifactChecksums: {
    readonly weightsSha256: string;
    readonly tokenizerSha256: string;
    readonly configSha256: string;
    readonly auxAssetsSha256: string;
    readonly runtimePackageSha256: string;
  };
  readonly licenseMetadata: LicenseProvenanceMetadata;
  readonly modelCard: ModelCardDocument;
  readonly declaredCapabilities: ModelCapabilitiesDeclaration;
  readonly evaluationIds: readonly string[];
  readonly lifecycleStatus: ModelLifecycleStatus;
  readonly tags: readonly RegistryTag[];
  readonly immutable: true;
  readonly createdAtIso: string;
}

export interface ModelPackageRecord {
  readonly packageId: string;
  readonly tenantId: string;
  readonly modelVersionId: string;
  readonly modelId: string;
  readonly version: string;
  readonly packageHash: string;
  readonly weightsChecksumSha256: string;
  readonly tokenizerChecksumSha256: string;
  readonly configChecksumSha256: string;
  readonly excludesPrivateDataAndSecrets: boolean;
  readonly secretScanPassed: boolean;
  readonly dependencyScanPassed: boolean;
  readonly compatibilityChecks: readonly {
    readonly checkName: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
  readonly compatibilityPassed: boolean;
  readonly verifiedSafeToLoad: boolean;
  readonly createdAtIso: string;
}

export interface ModelApprovalRecord {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly modelVersionId: string;
  readonly evaluationId: string;
  readonly packageId: string;
  readonly approvalScope: string;
  readonly approverId: string;
  readonly approverRole: string;
  readonly status: 'APPROVED' | 'REJECTED';
  readonly reason: string;
  readonly acceptedLimitations: readonly string[];
  readonly rollbackReferenceVersionId: string | null;
  readonly createdAtIso: string;
}

export interface ModelDeploymentRecord {
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly modelVersionId: string;
  readonly packageId: string;
  readonly previousModelVersionId: string | null;
  readonly environment: DeploymentEnvironment;
  readonly strategy: DeploymentStrategy;
  readonly trafficPercentage: number;
  readonly sessionPinningEnabled: boolean;
  readonly activePinnedSessions: number;
  readonly servingHealth: ModelServingHealth;
  readonly status: 'ACTIVE' | 'PROMOTED' | 'ROLLED_BACK' | 'FAILED' | 'DRAINING';
  readonly configurationHash: string;
  readonly shadowMetrics: {
    readonly shadowRequestsCopied: number;
    readonly shadowErrors: number;
    readonly avgShadowLatencyMs: number;
    readonly agreementRateWithPrimary: number;
    readonly exposedToEndUsers: false;
  } | null;
  readonly rollbackTriggers: {
    readonly maxFailureRatePct: number;
    readonly maxP95LatencyMs: number;
    readonly maxPersianCerRegressionPp: number;
  };
  readonly startedAtIso: string;
  readonly completedAtIso: string | null;
}

export interface ModelDeploymentEventRecord {
  readonly eventId: string;
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly previousModelVersionId: string | null;
  readonly newModelVersionId: string | null;
  readonly actorId: string;
  readonly detail: string;
  readonly createdAtIso: string;
}

export interface ModelMonitoringAlert {
  readonly alertId: string;
  readonly modelVersionId: string;
  readonly deploymentId: string;
  readonly driftDimension:
    | 'OPERATIONAL_TELEMETRY'
    | 'FEATURE_DISTRIBUTION_DRIFT'
    | 'DATA_QUALITY_DRIFT'
    | 'MODEL_PERFORMANCE_DRIFT';
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly metricName: string;
  readonly metricValue: number;
  readonly workload: string;
  readonly timeWindow: string;
  readonly safeMessage: string; // Never includes raw customer transcripts!
  readonly createdAtIso: string;
}

export interface ModelMonitoringSnapshot {
  readonly modelVersionId: string;
  readonly deploymentId: string;
  readonly operational: {
    readonly requestCount: number;
    readonly successCount: number;
    readonly failureCount: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly p99LatencyMs: number;
    readonly rtf: number;
    readonly gpuUtilizationPct: number;
    readonly peakVramMb: number;
    readonly cpuUtilizationPct: number;
    readonly peakRamMb: number;
    readonly queueWaitMs: number;
    readonly modelLoadTimeMs: number;
    readonly coldStartTimeMs: number;
    readonly audioHoursProcessed: number;
    readonly estimatedCostPerAudioHourUsd: number;
    readonly workerRestartCount: number;
  };
  readonly behaviorAndDataDrift: {
    readonly languageShareFa: number;
    readonly languageShareEn: number;
    readonly languageShareCodeSwitch: number;
    readonly avgAudioDurationSec: number;
    readonly avgEstimatedSnrDb: number;
    readonly emptyTranscriptRate: number;
    readonly featureDriftPsi: number;
    readonly dataQualityDriftNote: string;
  };
  readonly performanceDrift: {
    readonly evaluatedWithApprovedGroundTruth: boolean;
    readonly cerDeltaPp: number | null;
    readonly werDeltaPp: number | null;
    readonly status: 'STABLE' | 'DEGRADATION_DETECTED' | 'INSUFFICIENT_GROUND_TRUTH';
  };
  readonly alerts: readonly ModelMonitoringAlert[];
}

export interface OptimizationExperimentRecord {
  readonly optimizationId: string;
  readonly tenantId: string;
  readonly parentModelVersionId: string;
  readonly optimizedModelVersionId: string;
  readonly technique: 'DYNAMIC_INT8_QUANTIZATION' | 'PRUNING_LEXICON_DISTILL' | 'BF16_EXPORT' | 'KV_CACHE_COMPACTION';
  readonly comparison: {
    readonly parentSizeBytes: number;
    readonly optimizedSizeBytes: number;
    readonly parentP95LatencyMs: number;
    readonly optimizedP95LatencyMs: number;
    readonly parentPeakRamMb: number;
    readonly optimizedPeakRamMb: number;
    readonly persianCerDeltaPp: number;
    readonly codeSwitchCerDeltaPp: number;
    readonly recommendation: 'ACCEPT_OPTIMIZED_VERSION' | 'KEEP_ORIGINAL_QUALITY_CRITICAL';
  };
  readonly createdAtIso: string;
}
