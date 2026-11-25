/**
 * SHAHAB SHARED CORE — Host-Neutral Recognition Contract (v1.0.0)
 *
 * Strictly independent of Express, Node filesystem paths, docs/shahab state files,
 * AVAPARDAZ timeline/UI/editing modules, and Adobe Audition plugin host details.
 * Both AVAPARDAZ and a future Adobe Audition host adapter can consume this single
 * authoritative contract without duplicating ASR logic.
 */

export const SHAHAB_CORE_CONTRACT_VERSION = '1.0.0' as const;

export type ShahabCoreExecutionProvider =
  | 'wasm_single_thread'
  | 'cpu_native_ort'
  | 'cpu_native_sherpa'
  | 'webgpu';

export type ShahabCoreTimestampGranularity =
  | 'WORD_ALIGNED'
  | 'SEGMENT_ESTIMATED'
  | 'NONE';

export interface ShahabCoreAudioMetadata {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly layout: 'interleaved' | 'planar';
  readonly sourceAudioId?: string;
  readonly sourceAudioHashSha256?: string;
  readonly filename?: string;
}

export interface ShahabCoreAudioInput {
  readonly pcmFloat32: Float32Array;
  readonly metadata: ShahabCoreAudioMetadata;
}

export interface ShahabCoreRecognitionConfig {
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly decodePolicy?: 'SPEED' | 'BALANCED' | 'PRECISION' | 'VERBATIM';
  readonly maxChunkDurationSec?: number;
  readonly overlapSec?: number;
  readonly verifiedContextTerms?: readonly { readonly term: string; readonly boostWeight: number }[];
  readonly unloadAfterTranscribe?: boolean;
  readonly tenantScope?: string;
}

export interface ShahabCoreProgressEvent {
  readonly percent: number;
  readonly currentChunk: number;
  readonly totalChunks: number;
  readonly elapsedMs: number;
  readonly partialText: string;
}

export interface ShahabCoreTranscriptToken {
  readonly tokenId: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample: number;
  readonly endSample: number;
  /** Strictly null when the acoustic decoder does not emit calibrated probabilities. */
  readonly confidence: number | null;
  readonly timestampGranularity: ShahabCoreTimestampGranularity;
}

export interface ShahabCoreTranscriptOutput {
  readonly contractVersion: typeof SHAHAB_CORE_CONTRACT_VERSION;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly executionProvider: ShahabCoreExecutionProvider;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly language: 'fa' | 'en' | 'fa-en';
  readonly sampleRateHz: number;
  readonly totalSourceSamples: number;
  readonly durationSec: number;
  readonly tokens: readonly ShahabCoreTranscriptToken[];
  readonly timestampGranularity: ShahabCoreTimestampGranularity;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly offlineVerified: true;
}

export interface ShahabCoreStructuredError {
  readonly contractVersion: typeof SHAHAB_CORE_CONTRACT_VERSION;
  readonly code:
    | 'MODEL_NOT_AVAILABLE'
    | 'MODEL_INTEGRITY_FAILED'
    | 'INVALID_AUDIO_INPUT'
    | 'AUDIO_DURATION_LIMIT_EXCEEDED'
    | 'JOB_CANCELLED'
    | 'QUEUE_FULL'
    | 'INFERENCE_FAILED';
  readonly message: string;
  readonly retryable: boolean;
}

export interface ShahabCoreCapabilities {
  readonly contractVersion: typeof SHAHAB_CORE_CONTRACT_VERSION;
  readonly executionProvider: ShahabCoreExecutionProvider;
  readonly nativeCppAvailable: boolean;
  readonly statefulStreamingSupported: boolean;
  readonly maxThreads: number;
  readonly offlineCapable: boolean;
}

/**
 * Pluggable inference backend interface decoupling audio conditioning, beam search,
 * and Persian transcript assembly from the underlying ONNX runtime (onnxruntime-web
 * WASM today; onnxruntime-node / C++ sherpa-onnx C-ABI in future native builds).
 */
export interface ShahabCoreInferenceBackend {
  readonly executionProvider: ShahabCoreExecutionProvider;
  readonly modelId: string;
  readonly modelVersion: string;
  getCapabilities(): ShahabCoreCapabilities;
  initialize(): Promise<void>;
  getVocab(): readonly string[];
  runEncoder(
    features: Float32Array,
    numFrames: number,
    featureDim?: number,
  ): Promise<{
    readonly data: Float32Array;
    readonly numFrames: number;
    readonly dim: number;
    readonly frameStrideSec?: number;
  }>;
  runDecoderBatch(contexts: readonly (readonly [number, number])[]): Promise<readonly Float32Array[]>;
  runJoinerBatch(
    encoderFrame: Float32Array,
    decoderVectors: readonly Float32Array[],
    dim: number,
  ): Promise<readonly Float32Array[]>;
  dispose(): Promise<void>;
}
