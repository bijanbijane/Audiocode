/**
 * Shared ASR experimentation contracts.
 * Kept separate from the runtime adapter implementation to avoid a type-only dependency cycle.
 */

export type AsrLabEngineId =
  | 'avapardaz-local-ctc-dsp'
  | 'elevenlabs-scribe-v3'
  | 'deepgram-nova-3'
  | 'openai-gpt-transcribe'
  | 'qwen3-asr-1.7b-worker'
  | 'whisper-large-v3-worker'
  | 'gemini-audio-asr';

export type EngineExecutionStatus =
  | 'SUCCESS'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_NOT_READY'
  | 'MISSING_API_KEY'
  | 'WORKER_OFFLINE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'API_ERROR'
  | 'EMPTY_RESPONSE';

export type HypothesisProvenance =
  | 'MODEL_INFERENCE'
  | 'DETERMINISTIC_TEST_FIXTURE'
  | 'ACOUSTIC_SEGMENTATION'
  | 'FORCED_ALIGNMENT'
  | 'NONE';

export interface VerifiedModelIdentity {
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly modelSha256: string | null;
  readonly architecture: string | null;
}

export interface AsrEngineRegistryDescriptor {
  readonly engineId: AsrLabEngineId;
  readonly displayName: string;
  readonly version: string;
  readonly vendorOrFamily: string;
  readonly deploymentKind: 'LOCAL_IN_PROCESS' | 'COMMERCIAL_CLOUD_API' | 'SELF_HOSTED_GPU_WORKER';
  readonly architecture?: string | null;
  readonly supportsPersian: boolean;
  readonly supportsEnglish: boolean;
  readonly supportsCodeSwitching: boolean;
  readonly supportsTranscription: boolean;
  readonly supportsForcedAlignment: boolean;
  readonly supportsSpeechSegmentation: boolean;
  readonly supportsBatch: boolean;
  readonly supportsStreaming: boolean;
  readonly officialPricePerHourUsd: number;
  readonly requiredEnvVar: string | null;
}

export interface AudioIngestionValidationReport {
  readonly isValid: boolean;
  readonly fileName: string;
  readonly detectedFormat: 'wav' | 'mp3' | 'm4a' | 'flac' | 'ogg' | 'pcm-float32' | 'invalid';
  readonly audioSha256: string;
  readonly fileVersion: string;
  readonly originalSampleRate: number;
  readonly originalChannels: number;
  readonly standardizedSampleRate: 16000;
  readonly standardizedChannels: 1;
  readonly durationSec: number;
  readonly originalSampleCount: number;
  readonly standardizedSampleCount: number;
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
  readonly hasClipping: boolean;
  readonly standardizedPcm16k: Float32Array;
  readonly errorCode?: string;
  readonly errorMessageFa?: string;
}

export interface EngineAdapterConfig {
  readonly expectedLanguage: 'fa' | 'en' | 'fa-en-mixed' | 'auto';
  readonly mode: 'batch' | 'live';
  readonly keyterms: readonly string[];
  readonly contextPrompt?: string;
  readonly timeoutMs?: number;
  readonly isFrozenTestSample?: boolean;
}

export interface AsrInferenceRequest {
  readonly audio: AudioIngestionValidationReport;
  readonly config: EngineAdapterConfig;
  readonly signal: AbortSignal;
  readonly experimentId: string;
}

export interface AsrInferenceWordPrediction {
  readonly word: string;
  readonly normalizedWord: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence: number;
}

export interface AsrAdapterExecutionOutput {
  readonly status: EngineExecutionStatus;
  readonly rawTranscript: string;
  readonly normalizedTranscript?: string;
  readonly words?: readonly AsrInferenceWordPrediction[];
  readonly meanConfidence?: number | null;
  readonly hypothesisProvenance?: HypothesisProvenance;
  readonly modelIdentity?: VerifiedModelIdentity;
  readonly errorMessage?: string;
  readonly isMockTestOnly?: boolean;
}

export interface AsrProviderAdapter {
  readonly descriptor: AsrEngineRegistryDescriptor;
  transcribe(request: AsrInferenceRequest): Promise<AsrAdapterExecutionOutput>;
}
