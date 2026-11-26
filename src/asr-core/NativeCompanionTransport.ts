/**
 * ASR-core-owned port for a local Native Companion transport.
 *
 * Host/desktop adapters implement this structural contract and inject it into
 * NativeCompanionAsrRuntimeAdapter. ASR Core must not import Host Bridge modules.
 */
export interface NativeCompanionHealthSnapshot {
  readonly serviceVersion?: string;
  readonly runtime?: {
    readonly available?: boolean;
  };
}

export interface NativeCompanionProgressSnapshot {
  readonly progressPct: number;
  readonly currentChunk: number;
  readonly totalChunks: number;
  readonly elapsedMs: number;
}

export interface NativeCompanionTranscriptionSnapshot {
  readonly modelId: string;
  readonly architecture: string;
  readonly quantization: string;
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly rawText: string;
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly segments: readonly {
    readonly id: string;
    readonly index?: number;
    readonly startSec: number;
    readonly endSec: number;
    readonly text: string;
    readonly timestampGranularity?: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
    readonly words: readonly {
      readonly word: string;
      readonly startSec: number;
      readonly endSec: number;
    }[];
  }[];
}

export interface NativeCompanionAudioSourceRequest {
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly readSourceRange: (startSample: number, count: number) => Promise<Float32Array>;
  readonly filename: string;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly modelId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: NativeCompanionProgressSnapshot) => void;
}

export interface NativeCompanionTransport {
  getHealth(signal?: AbortSignal): Promise<NativeCompanionHealthSnapshot | null>;
  /** Legacy small-clip API. Large recordings must use transcribeAudioSource(). */
  transcribePcm(params: {
    readonly pcm: Float32Array;
    readonly sampleRate: number;
    readonly filename: string;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly modelId?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (job: NativeCompanionProgressSnapshot) => void;
  }): Promise<NativeCompanionTranscriptionSnapshot>;
  /** File-backed range-reader API; implementations must not materialize the full recording. */
  transcribeAudioSource?(params: NativeCompanionAudioSourceRequest): Promise<NativeCompanionTranscriptionSnapshot>;
}
