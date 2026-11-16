import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from './UnifiedOnnxPersianAsrEngine';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import { SentencePieceSubwordCtcMapper } from './SentencePieceAndWhisperBridge';
import { RawWordPrediction } from '../PersianChunkedAsrWorker';
import { PersianTextNormalizer } from '../PersianTextNormalizer';

export interface StreamingAsrHypothesisUpdate {
  /** Committed Persian words that will no longer change */
  readonly newlyCommittedWords: RawWordPrediction[];
  /** Tentative trailing words that may be refined as more live audio arrives */
  readonly tentativeTailWords: RawWordPrediction[];
  readonly totalAudioProcessedSeconds: number;
}

export interface CausalFastConformerCacheConfig {
  readonly numLayers: number; // e.g., 17 layers in standard FastConformer
  readonly attentionContextFrames: number; // e.g., 70 frames
  readonly hiddenDim: number; // e.g., 512 or 176
  readonly convKernelContext: number; // e.g., 8
  readonly preEncodeOverlapMelFrames: number; // 9 Mel frames overlap for NeMo dw_striding
  readonly chunkShiftMelFrames: number; // e.g., 112 frames (1.12 seconds)
}

/**
 * Section 107 (Part 1): Causal Cache-Aware FastConformer-CTC Streaming Runner (< 200ms latency)
 */
export class CausalFastConformerStreamingRunner {
  private session: OrtSessionLike | null = null;
  private readonly featureExtractor = new OnnxPersianAsrAndVadAdapter();
  private readonly ctcMapper: SentencePieceSubwordCtcMapper;

  private cacheLastChannel!: Float32Array;
  private cacheLastTime!: Float32Array;
  private cacheLastChannelLen: bigint = 0n;
  private trailingMelOverlap: Float32Array = new Float32Array(0);
  private totalFramesEmitted = 0;

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    vocabulary: readonly string[],
    private readonly cacheCfg: CausalFastConformerCacheConfig,
  ) {
    this.ctcMapper = new SentencePieceSubwordCtcMapper(vocabulary, 0);
    this.resetStreamingCaches();
  }

  public async loadModel(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[],
  ): Promise<void> {
    this.session = await this.ortProvider.createSession(
      modelBytesOrPath,
      executionProviders,
    );
    this.resetStreamingCaches();
  }

  public resetStreamingCaches(): void {
    const { numLayers, attentionContextFrames, hiddenDim, convKernelContext } =
      this.cacheCfg;
    this.cacheLastChannel = new Float32Array(
      1 * numLayers * attentionContextFrames * hiddenDim,
    );
    this.cacheLastTime = new Float32Array(
      1 * numLayers * hiddenDim * convKernelContext,
    );
    this.cacheLastChannelLen = 0n;
    this.trailingMelOverlap = new Float32Array(0);
    this.totalFramesEmitted = 0;
  }

  /**
   * Process a live 16kHz Mono audio chunk with state cache carryover across chunks
   */
  public async processLiveAudioChunk(
    newPcm16kChunk: Float32Array,
  ): Promise<StreamingAsrHypothesisUpdate> {
    if (!this.session) throw new Error('CAUSAL_STREAMING_SESSION_NOT_LOADED');

    const { melTensor, numFrames, nMels } =
      this.featureExtractor.computeLogMelSpectrogram(newPcm16kChunk);

    if (numFrames === 0) {
      return {
        newlyCommittedWords: [],
        tentativeTailWords: [],
        totalAudioProcessedSeconds: Number((this.totalFramesEmitted * 0.04).toFixed(2)),
      };
    }

    // Prepend trailing 9 Mel frames from previous chunk (NeMo dw_striding pre-encode overlap contract)
    const overlapFrames = Math.min(
      this.cacheCfg.preEncodeOverlapMelFrames,
      this.trailingMelOverlap.length / nMels,
    );
    const totalMelFrames = overlapFrames + numFrames;
    const combinedMel = new Float32Array(totalMelFrames * nMels);

    if (overlapFrames > 0) {
      combinedMel.set(
        this.trailingMelOverlap.subarray(
          this.trailingMelOverlap.length - overlapFrames * nMels,
        ),
        0,
      );
    }
    combinedMel.set(melTensor, overlapFrames * nMels);

    // Save trailing 9 Mel frames for next chunk
    const keepOverlapFrames = Math.min(
      this.cacheCfg.preEncodeOverlapMelFrames,
      totalMelFrames,
    );
    this.trailingMelOverlap = combinedMel.slice(
      (totalMelFrames - keepOverlapFrames) * nMels,
    );

    // Transpose layout to [1, 80, totalMelFrames]
    const transposedMel = new Float32Array(nMels * totalMelFrames);
    for (let t = 0; t < totalMelFrames; t++) {
      for (let m = 0; m < nMels; m++) {
        transposedMel[m * totalMelFrames + t] = combinedMel[t * nMels + m];
      }
    }

    const { numLayers, attentionContextFrames, hiddenDim, convKernelContext } =
      this.cacheCfg;

    const feeds: Record<string, OrtTensorLike> = {
      audio_signal: this.ortProvider.createTensor('float32', transposedMel, [
        1,
        nMels,
        totalMelFrames,
      ]),
      length: this.ortProvider.createTensor(
        'int64',
        BigInt64Array.from([BigInt(totalMelFrames)]),
        [1],
      ),
      cache_last_channel: this.ortProvider.createTensor(
        'float32',
        this.cacheLastChannel,
        [1, numLayers, attentionContextFrames, hiddenDim],
      ),
      cache_last_time: this.ortProvider.createTensor(
        'float32',
        this.cacheLastTime,
        [1, numLayers, hiddenDim, convKernelContext],
      ),
      cache_last_channel_len: this.ortProvider.createTensor(
        'int64',
        BigInt64Array.from([this.cacheLastChannelLen]),
        [1],
      ),
    };

    const outputs = await this.session.run(feeds);

    // Carry over updated caches for next chunk
    if (outputs['cache_last_channel_next']) {
      this.cacheLastChannel = new Float32Array(
        outputs['cache_last_channel_next'].data as Float32Array,
      );
    }
    if (outputs['cache_last_time_next']) {
      this.cacheLastTime = new Float32Array(
        outputs['cache_last_time_next'].data as Float32Array,
      );
    }
    if (outputs['cache_last_channel_len_next']) {
      this.cacheLastChannelLen = (
        outputs['cache_last_channel_len_next'].data as BigInt64Array
      )[0];
    }

    const logProbsTensor =
      outputs['outputs'] ?? outputs['logprobs'] ?? Object.values(outputs)[0];
    const [, outFrames, vocabSize] = logProbsTensor.dims;
    const flatData = logProbsTensor.data as Float32Array;

    const frameArray: Float32Array[] = new Array(outFrames);
    for (let t = 0; t < outFrames; t++) {
      frameArray[t] = flatData.subarray(t * vocabSize, (t + 1) * vocabSize);
    }

    const decoded = this.ctcMapper.decodeSubwordMatrixToWords(frameArray, 0.04);
    const timeOffsetSec = this.totalFramesEmitted * 0.04;
    this.totalFramesEmitted += outFrames;

    const shiftedWords: RawWordPrediction[] = decoded.words.map((w) => ({
      ...w,
      relativeStartSec: Number((w.relativeStartSec + timeOffsetSec).toFixed(3)),
      relativeEndSec: Number((w.relativeEndSec + timeOffsetSec).toFixed(3)),
    }));

    return {
      newlyCommittedWords: shiftedWords,
      tentativeTailWords: [],
      totalAudioProcessedSeconds: Number((this.totalFramesEmitted * 0.04).toFixed(2)),
    };
  }
}

/**
 * Section 107 (Part 2): LocalAgreement-2 Stream Stabilizer with 350ms Draft Horizon Shield
 */
export class LocalAgreement2StreamStabilizer {
  private prevHypothesisWords: RawWordPrediction[] = [];
  private committedCursorSec = 0;
  private audioBuffer: Float32Array = new Float32Array(0);
  private readonly sampleRate = 16000;

  constructor(
    private readonly transcribeWindowFn: (pcm16k: Float32Array) => Promise<RawWordPrediction[]>,
    private readonly draftHorizonSec: number = 0.35, // Prevents premature locking of words near live buffer edge
    private readonly maxTrimWindowSec: number = 20.0,
  ) {}

  public async pushAudioChunkAndTranscribe(
    newPcm16k: Float32Array,
  ): Promise<StreamingAsrHypothesisUpdate> {
    const combined = new Float32Array(this.audioBuffer.length + newPcm16k.length);
    combined.set(this.audioBuffer, 0);
    combined.set(newPcm16k, this.audioBuffer.length);
    this.audioBuffer = combined;

    const bufferDurationSec = this.audioBuffer.length / this.sampleRate;
    const rawWords = await this.transcribeWindowFn(this.audioBuffer);

    // Compute Longest Common Prefix (LCP) across consecutive hypotheses using normalized Persian text
    const commonPrefixWords: RawWordPrediction[] = [];
    const minLen = Math.min(this.prevHypothesisWords.length, rawWords.length);

    for (let i = 0; i < minLen; i++) {
      const wPrev = PersianTextNormalizer.normalizeTokenText(this.prevHypothesisWords[i].word);
      const wCurr = PersianTextNormalizer.normalizeTokenText(rawWords[i].word);
      if (wPrev !== wCurr) break;

      // Draft Horizon Rule: do not lock words within the trailing 350ms of the live audio buffer
      if (rawWords[i].relativeEndSec > bufferDurationSec - this.draftHorizonSec) {
        break;
      }
      commonPrefixWords.push(rawWords[i]);
    }

    const tentativeTailWords = rawWords.slice(commonPrefixWords.length);
    this.prevHypothesisWords = tentativeTailWords;

    const newlyCommittedWords = commonPrefixWords.map((w) => ({
      ...w,
      relativeStartSec: Number((w.relativeStartSec + this.committedCursorSec).toFixed(3)),
      relativeEndSec: Number((w.relativeEndSec + this.committedCursorSec).toFixed(3)),
    }));

    const shiftedTentative = tentativeTailWords.map((w) => ({
      ...w,
      relativeStartSec: Number((w.relativeStartSec + this.committedCursorSec).toFixed(3)),
      relativeEndSec: Number((w.relativeEndSec + this.committedCursorSec).toFixed(3)),
    }));

    // Trim audio buffer up to the end of the last committed word so buffer never grows unbounded
    if (commonPrefixWords.length > 0) {
      const trimSec = commonPrefixWords[commonPrefixWords.length - 1].relativeEndSec;
      const trimSamples = Math.min(
        this.audioBuffer.length,
        Math.floor(trimSec * this.sampleRate),
      );
      this.audioBuffer = this.audioBuffer.slice(trimSamples);
      this.committedCursorSec += trimSamples / this.sampleRate;
    } else if (bufferDurationSec > this.maxTrimWindowSec) {
      const dropSamples = Math.floor((bufferDurationSec - 10.0) * this.sampleRate);
      this.audioBuffer = this.audioBuffer.slice(dropSamples);
      this.committedCursorSec += dropSamples / this.sampleRate;
    }

    return {
      newlyCommittedWords,
      tentativeTailWords: shiftedTentative,
      totalAudioProcessedSeconds: Number(
        (this.committedCursorSec + this.audioBuffer.length / this.sampleRate).toFixed(2),
      ),
    };
  }
}
