/**
 * CORE ASR ENGINE — STRICT DOMAIN CONTRACTS (Milestones CORE-02 .. CORE-08)
 *
 * Explicitly separates:
 * - Raw unmodified acoustic/model output vs normalized text profiles
 * - Confidence calibration availability (never fabricates calibrated probabilities)
 * - Word timestamp granularity availability (never fabricates fake word boundaries)
 * - Streaming execution architecture classification
 * - Local CPU runtime vs unavailable external neural weights/workers
 */

export type NormalizationProfileId =
  | 'RAW_UNMODIFIED'
  | 'FA-STRICT-V1'
  | 'FA-RELAXED-V1'
  | 'EN-NORM-V1'
  | 'MIXED-NORM-V1';

export type DetectedLanguageTag = 'fa' | 'en' | 'fa-en' | 'unknown' | 'uncertain';

export type ConfidenceStatus = 'CALIBRATED' | 'UNAVAILABLE_UNCALIBRATED';

export type TimestampGranularity = 'RECORDING' | 'SEGMENT' | 'WORD' | 'UNAVAILABLE';

export type StreamingExecutionCategory =
  | 'NATIVE_INCREMENTAL_STREAMING'
  | 'STATEFUL_CHUNKED_STREAMING'
  | 'VAD_SEGMENTED_BATCH'
  | 'REPEATED_FULL_CONTEXT_PROCESSING';

export type AudioContainerFormat = 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm' | 'aiff' | 'pcm16' | 'unknown';

export type AsrBackendKind =
  | 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER'
  | 'EXTERNAL_ONNX_RUNTIME'
  | 'EXTERNAL_PYTHON_NEURAL_WORKER';

export interface RuntimeBackendAvailability {
  backendId: AsrBackendKind;
  displayName: string;
  availableOnThisHost: boolean;
  reasonIfUnavailable: string | null;
  requiresGpu: boolean;
  requiresExternalCloudApi: boolean;
  weightsPresent: boolean;
  confidenceStatus: ConfidenceStatus;
  timestampGranularity: TimestampGranularity;
  streamingCategory: StreamingExecutionCategory;
}

export interface StereoChannelInspection {
  originalChannels: number;
  policyApplied: 'MONO_PASSTHROUGH' | 'EQUAL_POWER_AVG' | 'LEFT_PRIMARY_PHASE_GUARD' | 'DOMINANT_ACTIVE_CHANNEL';
  leftRmsDb: number;
  rightRmsDb: number;
  interChannelCorrelation: number;
  phaseInversionRisk: boolean;
  silentChannelDetected: boolean;
  note: string;
}

export interface CoreAudioIngestResult {
  recordingId: string;
  sourceFilename: string;
  detectedFormat: AudioContainerFormat;
  decoderUsed: 'ffmpeg' | 'native_riff_wav' | 'raw_pcm16';
  originalSampleRateHz: number;
  originalChannels: number;
  canonicalSampleRateHz: 16000;
  canonicalChannels: 1;
  canonicalPcm16: Buffer;
  canonicalFloat32: Float32Array;
  sampleCount: number;
  durationSec: number;
  audioSha256: string;
  stereoInspection: StereoChannelInspection;
  signalHealth: {
    rmsDb: number;
    peakDb: number;
    estimatedSnrDb: number;
    clippingRatio: number;
    dcOffset: number;
    silenceRatio: number;
    isSilent: boolean;
  };
  warnings: string[];
}

export interface CoreWordTiming {
  word: string;
  startSec: number;
  endSec: number;
  startSample: number;
  endSample: number;
  language: DetectedLanguageTag;
}

export interface CoreTranscriptionSegment {
  segmentId: string;
  segmentIndex: number;
  startSec: number;
  endSec: number;
  startSample: number;
  endSample: number;
  language: DetectedLanguageTag;
  languageConfidence: number | null;
  rawModelOutput: string;
  normalizedByProfile: Record<NormalizationProfileId, string>;
  words: CoreWordTiming[];
  timestampGranularity: TimestampGranularity;
  confidenceStatus: ConfidenceStatus;
  calibratedConfidence: number | null;
  acousticFrameCount: number;
  backendUsed: AsrBackendKind;
  retryCount: number;
  status: 'OK' | 'FAILED';
  failureReason: string | null;
}

export interface CoreTranscriptionResult {
  jobId: string;
  status: 'COMPLETED' | 'PARTIAL_WITH_FAILURES' | 'FAILED';
  backendUsed: AsrBackendKind;
  backendAvailabilitySnapshot: RuntimeBackendAvailability[];
  modelVersionId: string;
  durationSec: number;
  processingTimeMs: number;
  realTimeFactor: number;
  peakRssMb: number;
  dominantLanguage: DetectedLanguageTag;
  rawModelOutput: string;
  normalizedByProfile: Record<NormalizationProfileId, string>;
  confidenceStatus: ConfidenceStatus;
  calibratedConfidence: number | null;
  timestampGranularity: TimestampGranularity;
  segments: CoreTranscriptionSegment[];
  failedSegmentRanges: Array<{ segmentIndex: number; startSec: number; endSec: number; reason: string }>;
  ingestWarnings: string[];
  audioSha256: string;
}

export interface LongFormConfig {
  maxSegmentDurationSec: number;
  contextOverlapSec: number;
  minSilenceValleyMs: number;
  maxRetriesPerSegment: number;
  simulateFailureOnSegmentIndex?: number;
}

export type CoreStreamingEventType =
  | 'session.ready'
  | 'speech.started'
  | 'transcript.partial'
  | 'transcript.revision'
  | 'transcript.final'
  | 'speech.ended'
  | 'session.overloaded'
  | 'session.failed'
  | 'session.completed';

export interface CoreStreamingEvent {
  eventId: string;
  sessionId: string;
  seq: number;
  type: CoreStreamingEventType;
  streamingCategory: StreamingExecutionCategory;
  emittedAtMs: number;
  audioCursorSec: number;
  segmentIndex?: number;
  startSec?: number;
  endSec?: number;
  language?: DetectedLanguageTag;
  rawModelOutput?: string;
  normalizedText?: string;
  isRevision?: boolean;
  confidenceStatus: ConfidenceStatus;
  calibratedConfidence: number | null;
  detail?: string;
}

export interface ErrorTaxonomyCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
  scriptMismatches: number;
  halfSpaceErrors: number;
  englishCodeSwitchErrors: number;
  punctuationNormalizationDiffs: number;
}

export interface BootstrapConfidenceInterval {
  metric: 'WER' | 'CER';
  meanDelta: number;
  ci95Low: number;
  ci95High: number;
  iterations: number;
  seed: number;
  statisticallySignificant: boolean;
}

export interface EvaluationUtteranceInput {
  utteranceId: string;
  speakerId: string;
  conditionTag: 'clean' | 'telephone' | 'noisy' | 'code_switch' | 'long_form';
  languageGroup: 'fa' | 'en' | 'fa-en';
  referenceRaw: string;
  pcm16k: Float32Array;
}

export interface EvaluationUtteranceResult {
  utteranceId: string;
  speakerId: string;
  conditionTag: string;
  languageGroup: 'fa' | 'en' | 'fa-en';
  referenceNormalized: string;
  hypothesisRaw: string;
  hypothesisNormalized: string;
  wer: number;
  cer: number;
  latencyMs: number;
  rtf: number;
  errors: ErrorTaxonomyCounts;
}

export interface BenchmarkSliceReport {
  sliceName: string;
  languageGroup: 'fa' | 'en' | 'fa-en';
  normalizationProfile: NormalizationProfileId;
  modelVersionId: string;
  utteranceCount: number;
  speakerCount: number;
  meanWer: number;
  meanCer: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanRtf: number;
  taxonomyTotals: ErrorTaxonomyCounts;
  perUtterance: EvaluationUtteranceResult[];
}

export interface AdaptationGateReport {
  baselineModelVersionId: string;
  candidateModelVersionId: string;
  persianBaselineCer: number;
  persianCandidateCer: number;
  persianRelativeCerImprovementPct: number;
  englishBaselineWer: number;
  englishCandidateWer: number;
  englishAbsoluteDeltaPp: number;
  mixedBaselineCer: number;
  mixedCandidateCer: number;
  mixedAbsoluteDeltaPp: number;
  bootstrapPersianCer: BootstrapConfidenceInterval;
  gatesPassed: {
    faImprovementMin5Pct: boolean;
    enRegressionMax05Pp: boolean;
    mixedRegressionMax05Pp: boolean;
    zeroFailures: boolean;
  };
  overallApproved: boolean;
}

export interface RoutingAuditRecord {
  routingId: string;
  timestampIso: string;
  mode: 'batch' | 'long_form' | 'streaming';
  requestedLanguageHint: DetectedLanguageTag | 'auto';
  selectedBackend: AsrBackendKind;
  selectedModelVersionId: string;
  fallbackTriggered: boolean;
  fallbackReason: string | null;
  availableBackends: RuntimeBackendAvailability[];
  measuredRtf?: number;
  measuredLatencyMs?: number;
}
