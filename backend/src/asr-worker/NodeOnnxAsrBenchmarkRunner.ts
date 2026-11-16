import fs from 'node:fs';
import {
  AsrArchitectureKind,
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
  UnifiedOnnxPersianAsrEngine,
} from '../../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';
import { PersianLanguageModelScorer } from '../../../src/ai-engine/asr/PersianCtcPrefixBeamSearchDecoder';
import { PersianChunkedAsrEngine } from '../../../src/ai-engine/PersianChunkedAsrWorker';
import { AntiAliasedResampler } from '../../../src/ai-engine/AntiAliasedResampler';
import { SampleRate } from '../../../src/contracts/timebase.contract';
import { AutomatedQualityGateRunner } from '../../../src/quality-gate/AutomatedQualityGateRunner';

export interface NativeOrtBindingLike {
  Tensor: new (
    type: 'float32' | 'int32' | 'int64',
    data: Float32Array | Int32Array | BigInt64Array,
    dims: readonly number[],
  ) => OrtTensorLike;
  InferenceSession: {
    create(
      modelBytesOrPath: Uint8Array | string,
      options?: {
        executionProviders?: readonly string[];
        graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
      },
    ): Promise<OrtSessionLike>;
  };
}

/**
 * 1. Native ONNX Runtime Provider for Node.js (CPU / CUDA)
 */
export class NodeJsOrtRuntimeProvider implements OrtRuntimeProvider {
  constructor(private readonly customBinding?: NativeOrtBindingLike) {}

  public createTensor(
    type: 'float32' | 'int32' | 'int64',
    data: Float32Array | Int32Array | BigInt64Array,
    dims: readonly number[],
  ): OrtTensorLike {
    if (this.customBinding) {
      return new this.customBinding.Tensor(type, data, dims);
    }
    return {
      type,
      data,
      dims: [...dims],
    };
  }

  public async createSession(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[],
  ): Promise<OrtSessionLike> {
    const nodeProviders = executionProviders
      .map((p) => (p === 'wasm' || p === 'webgpu' ? 'cpu' : p))
      .filter((v, idx, arr) => arr.indexOf(v) === idx);

    const sessionOptions = {
      executionProviders: nodeProviders.length > 0 ? nodeProviders : ['cpu'],
      graphOptimizationLevel: 'all' as const,
    };

    if (this.customBinding) {
      return this.customBinding.InferenceSession.create(modelBytesOrPath, sessionOptions);
    }

    // Dynamic import of onnxruntime-node when running on a native benchmark host
    const moduleName = 'onnxruntime-node';
    const ortModule = (await import(/* @vite-ignore */ moduleName)) as NativeOrtBindingLike;
    return ortModule.InferenceSession.create(modelBytesOrPath, sessionOptions);
  }
}

export interface NodeAsrBenchmarkResult {
  readonly audioDurationSeconds: number;
  readonly inferenceWallTimeSeconds: number;
  readonly realTimeFactor: number;
  readonly peakRssMemoryMb: number;
  readonly recognizedDisplayTranscript: string;
  readonly recognizedWordCount: number;
  readonly rawWerPercent?: number;
  readonly normalizedWerPercent?: number;
}

/**
 * Section 102: Node.js ONNX Runtime ASR Worker, Studio RIFF/WAV Chunk Walker & Automated Benchmark Runner
 */
export class NodeOnnxAsrBenchmarkRunner {
  /**
   * 2. Resilient RIFF/WAV Chunk Walker (Supports 16-bit PCM, 24-bit PCM, 32-bit IEEE Float + skips LIST/bext/JUNK metadata chunks)
   */
  public static parseWavBufferToFloat32Channels(buf: Buffer): {
    sampleRate: SampleRate;
    channels: Float32Array[];
  } {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    if (
      buf.byteLength < 12 ||
      buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error('WAV_PARSE_ERROR: هدر RIFF/WAVE معتبر نیست.');
    }

    let audioFormat = 1;
    let numChannels = 1;
    let sampleRate = 48000;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataSize = 0;

    let offset = 12;
    while (offset + 8 <= buf.byteLength) {
      const chunkId = buf.toString('ascii', offset, offset + 4);
      const chunkSize = view.getUint32(offset + 4, true);
      const bodyStart = offset + 8;

      if (chunkId === 'fmt ') {
        audioFormat = view.getUint16(bodyStart, true);
        numChannels = view.getUint16(bodyStart + 2, true);
        sampleRate = view.getUint32(bodyStart + 4, true);
        bitsPerSample = view.getUint16(bodyStart + 14, true);
      } else if (chunkId === 'data') {
        dataOffset = bodyStart;
        dataSize = Math.min(chunkSize, buf.byteLength - bodyStart);
        break;
      }

      // Standard RIFF even-byte word alignment
      offset = bodyStart + chunkSize + (chunkSize % 2);
    }

    if (dataOffset === -1 || dataSize <= 0) {
      throw new Error('WAV_PARSE_ERROR: چانک صوتی data یافت نشد.');
    }

    const bytesPerSample = bitsPerSample / 8;
    const totalFrames = Math.floor(dataSize / (numChannels * bytesPerSample));
    const channels = Array.from({ length: numChannels }, () => new Float32Array(totalFrames));

    let ptr = dataOffset;
    for (let f = 0; f < totalFrames; f++) {
      for (let c = 0; c < numChannels; c++) {
        let sampleVal = 0;
        if (audioFormat === 3 && bitsPerSample === 32) {
          sampleVal = view.getFloat32(ptr, true);
        } else if (bitsPerSample === 24) {
          let int24 = buf[ptr] | (buf[ptr + 1] << 8) | (buf[ptr + 2] << 16);
          if (int24 & 0x800000) int24 |= ~0xffffff;
          sampleVal = int24 / 8388608.0;
        } else {
          // 16-bit Signed PCM
          sampleVal = view.getInt16(ptr, true) / 32768.0;
        }
        channels[c][f] = sampleVal;
        ptr += bytesPerSample;
      }
    }

    return { sampleRate: sampleRate as SampleRate, channels };
  }

  public static parseWavFileToFloat32Channels(filePath: string): {
    sampleRate: SampleRate;
    channels: Float32Array[];
  } {
    const buf = fs.readFileSync(filePath);
    return this.parseWavBufferToFloat32Channels(buf);
  }

  /**
   * 3. Run full Persian ASR benchmark on a WAV file using ONNX Runtime in Node.js
   */
  public static async runWavBenchmark(params: {
    wavFilePath: string;
    architecture: AsrArchitectureKind;
    encoderModelPath: string;
    decoderModelPath?: string;
    ctcVocabulary?: readonly string[];
    persianLmScorer?: PersianLanguageModelScorer;
    groundTruthReferenceText?: string;
    useCuda?: boolean;
    customOrtProvider?: OrtRuntimeProvider;
  }): Promise<NodeAsrBenchmarkResult> {
    const { sampleRate, channels } = this.parseWavFileToFloat32Channels(params.wavFilePath);
    const audioDurationSeconds = channels[0].length / sampleRate;

    // Anti-aliased downsampling to 16kHz Mono for ASR
    const resampler = new AntiAliasedResampler(sampleRate, 16000);
    const pcm16kMono = resampler.processToMono16k(channels);

    const ortProvider = params.customOrtProvider ?? new NodeJsOrtRuntimeProvider();
    const asrEngine = new UnifiedOnnxPersianAsrEngine(ortProvider, params.architecture, {
      modelId: 'node-benchmark-model',
      modelVersion: '1.0.0',
      ctcVocabulary: params.ctcVocabulary,
      persianLmScorer: params.persianLmScorer,
    });

    await asrEngine.loadModels({
      encoderModelBytesOrPath: params.encoderModelPath,
      decoderModelBytesOrPath: params.decoderModelPath,
      executionProviders: params.useCuda ? ['cuda', 'cpu'] : ['cpu'],
    });

    const chunkedAsr = new PersianChunkedAsrEngine(asrEngine);
    const t0 = performance.now();

    const tokens = await chunkedAsr.transcribeLongAudioStream(
      pcm16kMono.length,
      async (start, count) => pcm16kMono.subarray(start, start + count),
      async () => {},
    );

    const inferenceWallTimeSeconds = Math.max(0.001, (performance.now() - t0) / 1000);
    await asrEngine.unloadModels();

    const recognizedDisplayTranscript = tokens.map((t) => t.displayText).join(' ');
    const peakRssMemoryMb = process.memoryUsage().rss / (1024 * 1024);

    let rawWerPercent: number | undefined;
    let normalizedWerPercent: number | undefined;
    if (params.groundTruthReferenceText) {
      const wer = AutomatedQualityGateRunner.computePersianWER(
        params.groundTruthReferenceText,
        recognizedDisplayTranscript,
      );
      rawWerPercent = Number(wer.rawWerPercent.toFixed(2));
      normalizedWerPercent = Number(wer.normalizedWerPercent.toFixed(2));
    }

    return {
      audioDurationSeconds: Number(audioDurationSeconds.toFixed(2)),
      inferenceWallTimeSeconds: Number(inferenceWallTimeSeconds.toFixed(2)),
      realTimeFactor: Number((inferenceWallTimeSeconds / audioDurationSeconds).toFixed(3)),
      peakRssMemoryMb: Number(peakRssMemoryMb.toFixed(1)),
      recognizedDisplayTranscript,
      recognizedWordCount: tokens.length,
      rawWerPercent,
      normalizedWerPercent,
    };
  }
}
