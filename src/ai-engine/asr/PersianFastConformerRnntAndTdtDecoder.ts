import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from './UnifiedOnnxPersianAsrEngine';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import {
  SentencePieceSubwordCtcMapper,
  SubwordTokenEmission,
} from './SentencePieceAndWhisperBridge';
import { RawWordPrediction } from '../PersianChunkedAsrWorker';

export interface RnntOrTdtArchitectureConfig {
  readonly mode: 'RNNT' | 'TDT';
  readonly vocabulary: readonly string[];
  readonly blankTokenId: number;
  readonly predNumLayers: number; // Typically 1 or 2 LSTM layers
  readonly predHiddenDim: number; // Typically 640
  readonly encoderFrameDurationSec: number; // Typically 0.04s or 0.08s
  /** Mapping from TDT duration head output index to frame jump count (e.g., [0, 1, 2, 3, 4]) */
  readonly tdtDurationsMap?: readonly number[];
  readonly maxSymbolsPerStep?: number; // Default 8 to prevent infinite loops on noise
}

/**
 * Section 122: FastConformer RNN-Transducer (RNN-T) & Token-and-Duration Transducer (TDT) Decoder on ONNX Runtime
 */
export class PersianFastConformerRnntAndTdtDecoder {
  private encoderSession: OrtSessionLike | null = null;
  private decoderSession: OrtSessionLike | null = null;
  private jointSession: OrtSessionLike | null = null;

  private readonly featureExtractor = new OnnxPersianAsrAndVadAdapter(
    'fastconformer-rnnt-fa',
    '1.0.0',
  );
  private readonly subwordMapper: SentencePieceSubwordCtcMapper;

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly cfg: RnntOrTdtArchitectureConfig,
  ) {
    this.subwordMapper = new SentencePieceSubwordCtcMapper(
      cfg.vocabulary,
      cfg.blankTokenId,
    );
  }

  public async loadModels(params: {
    encoderBytesOrPath: Uint8Array | string;
    decoderBytesOrPath: Uint8Array | string;
    jointBytesOrPath: Uint8Array | string;
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[];
  }): Promise<void> {
    this.encoderSession = await this.ortProvider.createSession(
      params.encoderBytesOrPath,
      params.executionProviders,
    );
    this.decoderSession = await this.ortProvider.createSession(
      params.decoderBytesOrPath,
      params.executionProviders,
    );
    this.jointSession = await this.ortProvider.createSession(
      params.jointBytesOrPath,
      params.executionProviders,
    );
  }

  public async unloadModels(): Promise<void> {
    if (this.encoderSession?.release) await this.encoderSession.release();
    if (this.decoderSession?.release) await this.decoderSession.release();
    if (this.jointSession?.release) await this.jointSession.release();
    this.encoderSession = null;
    this.decoderSession = null;
    this.jointSession = null;
  }

  /**
   * Execute greedy RNN-T / TDT decoding loop over 16kHz Mono PCM while carrying Prediction LSTM states (h, c)
   */
  public async transcribeWindow(pcm16kMono: Float32Array): Promise<RawWordPrediction[]> {
    if (!this.encoderSession || !this.decoderSession || !this.jointSession) {
      throw new Error('RNNT_TDT_SESSIONS_NOT_LOADED');
    }

    const { melTensor, numFrames, nMels } =
      this.featureExtractor.computeLogMelSpectrogram(pcm16kMono);
    if (numFrames === 0) return [];

    // 1. Transpose Mel layout to [1, 80, numFrames] and run Encoder
    const transposedMel = new Float32Array(nMels * numFrames);
    for (let t = 0; t < numFrames; t++) {
      for (let m = 0; m < nMels; m++) {
        transposedMel[m * numFrames + t] = melTensor[t * nMels + m];
      }
    }

    const encOutputs = await this.encoderSession.run({
      audio_signal: this.ortProvider.createTensor('float32', transposedMel, [
        1,
        nMels,
        numFrames,
      ]),
      length: this.ortProvider.createTensor(
        'int64',
        BigInt64Array.from([BigInt(numFrames)]),
        [1],
      ),
    });

    const encodedTensor =
      encOutputs['outputs'] ?? encOutputs['encoded'] ?? Object.values(encOutputs)[0];
    // Standard NeMo encoder output shape: [1, encHiddenDim, T_out]
    const [, encHiddenDim, tOutFrames] = encodedTensor.dims;
    const encodedData = encodedTensor.data as Float32Array;

    // 2. Initialize Prediction Network LSTM with Blank/SOS token
    let hState: OrtTensorLike = this.ortProvider.createTensor(
      'float32',
      new Float32Array(this.cfg.predNumLayers * 1 * this.cfg.predHiddenDim),
      [this.cfg.predNumLayers, 1, this.cfg.predHiddenDim],
    );
    let cState: OrtTensorLike = this.ortProvider.createTensor(
      'float32',
      new Float32Array(this.cfg.predNumLayers * 1 * this.cfg.predHiddenDim),
      [this.cfg.predNumLayers, 1, this.cfg.predHiddenDim],
    );

    let predStep = await this.runDecoderPredictionStep(
      this.cfg.blankTokenId,
      hState,
      cState,
    );

    const emissions: SubwordTokenEmission[] = [];
    const maxSymbols = this.cfg.maxSymbolsPerStep ?? 8;
    const vocabSize = this.cfg.vocabulary.length;
    const durationsMap = this.cfg.tdtDurationsMap ?? [0, 1, 2, 3, 4];

    // 3. Main time-synchronous / TDT duration-jumping decoding loop
    let t = 0;
    const encFrameSlice = new Float32Array(encHiddenDim);

    while (t < tOutFrames) {
      for (let d = 0; d < encHiddenDim; d++) {
        encFrameSlice[d] = encodedData[d * tOutFrames + t];
      }

      const encFrameTensor = this.ortProvider.createTensor('float32', encFrameSlice, [
        1,
        encHiddenDim,
        1,
      ]);

      let symCount = 0;
      let frameAdvanced = false;

      while (symCount < maxSymbols) {
        const jointOut = await this.jointSession.run({
          encoder_outputs: encFrameTensor,
          decoder_outputs: predStep.decoderOutput,
        });

        const jointLogits = (jointOut['outputs'] ?? Object.values(jointOut)[0])
          .data as Float32Array;

        const { bestId: tokenId, prob } = this.argmaxProbInRange(
          jointLogits,
          0,
          vocabSize,
        );

        let durationSkip = 1;
        if (this.cfg.mode === 'TDT' && jointLogits.length > vocabSize) {
          const { bestId: durIdx } = this.argmaxProbInRange(
            jointLogits,
            vocabSize,
            jointLogits.length,
          );
          durationSkip = durationsMap[durIdx - vocabSize] ?? 1;
        }

        if (tokenId === this.cfg.blankTokenId) {
          t += this.cfg.mode === 'TDT' ? Math.max(1, durationSkip) : 1;
          frameAdvanced = true;
          break;
        }

        const spanFrames = this.cfg.mode === 'TDT' ? Math.max(1, durationSkip) : 1;
        emissions.push({
          tokenId,
          piece: this.cfg.vocabulary[tokenId] ?? '',
          startFrame: t,
          endFrame: Math.min(tOutFrames, t + spanFrames),
          logProb: Math.log(Math.max(1e-9, prob)),
        });

        hState = predStep.nextH;
        cState = predStep.nextC;
        predStep = await this.runDecoderPredictionStep(tokenId, hState, cState);
        symCount++;

        if (this.cfg.mode === 'TDT' && durationSkip > 0) {
          t += durationSkip;
          frameAdvanced = true;
          break;
        }
      }

      if (!frameAdvanced) {
        t += 1;
      }
    }

    const grouped = this.subwordMapper.groupSubwordsIntoPersianWords(
      emissions,
      this.cfg.encoderFrameDurationSec,
    );
    return grouped.words;
  }

  private async runDecoderPredictionStep(
    tokenId: number,
    hState: OrtTensorLike,
    cState: OrtTensorLike,
  ): Promise<{
    decoderOutput: OrtTensorLike;
    nextH: OrtTensorLike;
    nextC: OrtTensorLike;
  }> {
    if (!this.decoderSession) throw new Error('DECODER_SESSION_MISSING');

    const res = await this.decoderSession.run({
      targets: this.ortProvider.createTensor(
        'int32',
        Int32Array.from([tokenId]),
        [1, 1],
      ),
      target_length: this.ortProvider.createTensor(
        'int32',
        Int32Array.from([1]),
        [1],
      ),
      states_1: hState,
      states_2: cState,
    });

    return {
      decoderOutput: res['outputs'] ?? Object.values(res)[0],
      nextH: res['states_1_out'] ?? Object.values(res)[1] ?? hState,
      nextC: res['states_2_out'] ?? Object.values(res)[2] ?? cState,
    };
  }

  private argmaxProbInRange(
    logits: Float32Array,
    startIdx: number,
    endIdx: number,
  ): { bestId: number; prob: number } {
    let bestId = startIdx;
    let maxVal = -Infinity;
    for (let i = startIdx; i < endIdx; i++) {
      if (logits[i] > maxVal) {
        maxVal = logits[i];
        bestId = i;
      }
    }
    let expSum = 0;
    for (let i = startIdx; i < endIdx; i++) {
      expSum += Math.exp(logits[i] - maxVal);
    }
    return { bestId, prob: 1.0 / Math.max(1e-9, expSum) };
  }
}
