import { AsrModelRunnerAdapter, RawWordPrediction } from '../PersianChunkedAsrWorker';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import {
  PersianCtcPrefixBeamSearchDecoder,
  PersianLanguageModelScorer,
} from './PersianCtcPrefixBeamSearchDecoder';

/** قرارداد مشترک با ONNX Runtime Web و ONNX Runtime Node (تضمین استقلال از Runtime) */
export interface OrtTensorLike {
  readonly data: Float32Array | Int32Array | BigInt64Array;
  readonly dims: readonly number[];
  readonly type: 'float32' | 'int32' | 'int64';
}

export interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}

export interface OrtRuntimeProvider {
  createTensor(
    type: 'float32' | 'int32' | 'int64',
    data: Float32Array | Int32Array | BigInt64Array,
    dims: readonly number[],
  ): OrtTensorLike;
  createSession(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[],
  ): Promise<OrtSessionLike>;
}

export type AsrArchitectureKind = 'FASTCONFORMER_CTC' | 'WHISPER_SEQ2SEQ';

export interface WhisperSpecialTokens {
  readonly sotTokenId: number; // 50258 (<|startoftranscript|>)
  readonly persianLangTokenId: number; // 50300 (<|fa|>)
  readonly transcribeTaskTokenId: number; // 50359 (<|transcribe|>)
  readonly eotTokenId: number; // 50257 (<|endoftext|>)
  readonly timestampBeginId: number; // 50364 (<|0.00|>)
}

/**
 * موتور کامل استنتاج تشخیص گفتار فارسی (سازگار با Browser Worker و Node.js Backend)
 */
export class UnifiedOnnxPersianAsrEngine implements AsrModelRunnerAdapter {
  public readonly modelId: string;
  public readonly modelVersion: string;

  private readonly featureExtractor: OnnxPersianAsrAndVadAdapter;
  private encoderSession: OrtSessionLike | null = null;
  private decoderSession: OrtSessionLike | null = null;
  private ctcDecoder: PersianCtcPrefixBeamSearchDecoder | null = null;

  // نگاشت معکوس Byte-Level BPE ویسپر برای دیکد صحیح بایت‌های UTF-8 فارسی
  private readonly whisperByteDecoderMap: Map<string, number>;
  private readonly whisperByteEncoderMap: Map<number, string>;
  private readonly whisperIdToToken: ReadonlyMap<number, string>;
  private readonly whisperSpecial: WhisperSpecialTokens;

  public readonly architecture: AsrArchitectureKind;

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    architecture: AsrArchitectureKind,
    config: {
      modelId: string;
      modelVersion: string;
      ctcVocabulary?: readonly string[];
      whisperIdToBpeToken?: ReadonlyMap<number, string>;
      whisperSpecialTokens?: WhisperSpecialTokens;
      persianLmScorer?: PersianLanguageModelScorer;
    },
  ) {
    this.architecture = architecture;
    this.modelId = config.modelId;
    this.modelVersion = config.modelVersion;
    this.featureExtractor = new OnnxPersianAsrAndVadAdapter(
      config.modelId,
      config.modelVersion,
    );
    const { decoderMap, encoderMap } = this.buildWhisperByteMaps();
    this.whisperByteDecoderMap = decoderMap;
    this.whisperByteEncoderMap = encoderMap;

    if (architecture === 'FASTCONFORMER_CTC' && config.ctcVocabulary && config.ctcVocabulary.length > 0) {
      this.ctcDecoder = new PersianCtcPrefixBeamSearchDecoder(
        config.ctcVocabulary,
        0,
        ' ',
        config.persianLmScorer,
      );
    }

    this.whisperIdToToken = config.whisperIdToBpeToken ?? new Map();
    this.whisperSpecial = config.whisperSpecialTokens ?? {
      sotTokenId: 50258,
      persianLangTokenId: 50300,
      transcribeTaskTokenId: 50359,
      eotTokenId: 50257,
      timestampBeginId: 50364,
    };
  }

  public hasDecoderConfiguration(): boolean {
    if (this.architecture === 'FASTCONFORMER_CTC') {
      return this.ctcDecoder !== null;
    }
    return this.whisperIdToToken.size > 0;
  }

  public isReady(): boolean {
    if (!this.encoderSession) return false;
    if (this.architecture === 'FASTCONFORMER_CTC') {
      return this.ctcDecoder !== null;
    }
    return this.decoderSession !== null && this.whisperIdToToken.size > 0;
  }

  public getReadinessReport(): {
    readonly modelId: string;
    readonly modelVersion: string;
    readonly architecture: AsrArchitectureKind;
    readonly sessionInitialized: boolean;
    readonly decoderConfigured: boolean;
    readonly ready: boolean;
  } {
    const sessionInitialized =
      this.architecture === 'FASTCONFORMER_CTC'
        ? this.encoderSession !== null
        : this.encoderSession !== null && this.decoderSession !== null;
    const decoderConfigured = this.hasDecoderConfiguration();
    return {
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      architecture: this.architecture,
      sessionInitialized,
      decoderConfigured,
      ready: sessionInitialized && decoderConfigured,
    };
  }

  /** کمکی برای ساخت توکن BPE از متن UTF-8 فارسی در تست‌ها و واژه‌نامه‌ها */
  public encodeUtf8StringToWhisperBpeToken(utf8Text: string): string {
    const bytes = new TextEncoder().encode(utf8Text);
    let out = '';
    for (const b of bytes) {
      out += this.whisperByteEncoderMap.get(b) ?? '';
    }
    return out;
  }

  /**
   * ۱. بارگذاری مدل(ها) در حافظه Runtime (بدون کپی مضاعف و با پشتیبانی از WebGPU / WASM / CPU / CUDA)
   */
  public async loadModels(params: {
    encoderModelBytesOrPath: Uint8Array | string;
    decoderModelBytesOrPath?: Uint8Array | string;
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[];
  }): Promise<void> {
    this.encoderSession = await this.ortProvider.createSession(
      params.encoderModelBytesOrPath,
      params.executionProviders,
    );

    if (this.architecture === 'WHISPER_SEQ2SEQ' && params.decoderModelBytesOrPath) {
      this.decoderSession = await this.ortProvider.createSession(
        params.decoderModelBytesOrPath,
        params.executionProviders,
      );
    }
  }

  /** آزادسازی کامل حافظه مدل پس از اتمام پردازش (سیاست Single-Active-Heavy-Model) */
  public async unloadModels(): Promise<void> {
    if (this.encoderSession?.release) await this.encoderSession.release();
    if (this.decoderSession?.release) await this.decoderSession.release();
    this.encoderSession = null;
    this.decoderSession = null;
  }

  public async dispose(): Promise<void> {
    await this.unloadModels();
  }

  public async detectVoiceActivity(
    pcm16kMono: Float32Array,
  ): Promise<{ hasSpeech: boolean; speechRatio: number }> {
    return this.featureExtractor.detectVoiceActivity(pcm16kMono);
  }

  /**
   * ۲. اجرای کامل خط لوله استنتاج روی یک پنجره صوتی 16kHz Mono و استخراج کلمات زمان‌بندی‌شده فارسی
   */
  public async transcribeWindow(pcm16kMono: Float32Array): Promise<RawWordPrediction[]> {
    if (!this.encoderSession) {
      throw new Error('ASR_ENGINE_NOT_LOADED: جلسه مدل استنتاج هنوز بارگذاری نشده است.');
    }

    const { melTensor, numFrames, nMels } =
      this.featureExtractor.computeLogMelSpectrogram(pcm16kMono);
    if (numFrames === 0) return [];

    if (this.architecture === 'FASTCONFORMER_CTC') {
      return this.runFastConformerCtcInference(melTensor, numFrames, nMels);
    }

    return this.runWhisperAutoregressiveInference(melTensor, numFrames, nMels);
  }

  /**
   * الف) استنتاج معماری FastConformer-CTC فارسی
   */
  private async runFastConformerCtcInference(
    melTensor: Float32Array,
    numFrames: number,
    nMels: number,
  ): Promise<RawWordPrediction[]> {
    if (!this.encoderSession || !this.ctcDecoder) {
      throw new Error('FASTCONFORMER_SESSION_OR_VOCAB_MISSING');
    }

    // تغییر چیدمان تانسور به [Batch=1, nMels=80, Time=numFrames] استاندارد NeMo/FastConformer
    const transposedMel = new Float32Array(nMels * numFrames);
    for (let t = 0; t < numFrames; t++) {
      for (let m = 0; m < nMels; m++) {
        transposedMel[m * numFrames + t] = melTensor[t * nMels + m];
      }
    }

    const audioSignalTensor = this.ortProvider.createTensor('float32', transposedMel, [
      1,
      nMels,
      numFrames,
    ]);
    const lengthTensor = this.ortProvider.createTensor(
      'int64',
      BigInt64Array.from([BigInt(numFrames)]),
      [1],
    );

    const outputs = await this.encoderSession.run({
      audio_signal: audioSignalTensor,
      length: lengthTensor,
    });

    const logProbsOutput = outputs['logprobs'] ?? Object.values(outputs)[0];
    const [, outFrames, vocabSize] = logProbsOutput.dims;
    const flatData = logProbsOutput.data as Float32Array;

    const framesArray: Float32Array[] = new Array(outFrames);
    for (let t = 0; t < outFrames; t++) {
      const start = t * vocabSize;
      framesArray[t] = flatData.subarray(start, start + vocabSize);
    }

    const decoded = this.ctcDecoder.decodeWithWordTimestamps({
      logProbsPerFrame: framesArray,
      frameDurationSec: 0.04, // FastConformer 4x subsampling on 10ms Mel hops = 40ms/frame
      beamWidth: 16,
    });

    return decoded.words;
  }

  /**
   * ب) استنتاج خودبازگشتی Whisper فارسی + استخراج بازه‌های زمانی کلمات از توکن‌های Timestamp
   */
  private async runWhisperAutoregressiveInference(
    melTensor: Float32Array,
    numFrames: number,
    nMels: number,
  ): Promise<RawWordPrediction[]> {
    if (!this.encoderSession || !this.decoderSession) {
      throw new Error('WHISPER_ENCODER_OR_DECODER_MISSING');
    }

    // استاندارد Whisper: پدینگ/برش طیف‌نگاره به دقیقاً 3000 فریم (۳۰ ثانیه) با شکل [1, 80, 3000]
    const WHISPER_FRAMES = 3000;
    const paddedMel = new Float32Array(nMels * WHISPER_FRAMES);
    const copyFrames = Math.min(numFrames, WHISPER_FRAMES);

    for (let t = 0; t < copyFrames; t++) {
      for (let m = 0; m < nMels; m++) {
        paddedMel[m * WHISPER_FRAMES + t] = melTensor[t * nMels + m];
      }
    }

    const melInput = this.ortProvider.createTensor('float32', paddedMel, [
      1,
      nMels,
      WHISPER_FRAMES,
    ]);
    const encOutputs = await this.encoderSession.run({ input_features: melInput });
    const encoderHiddenStates =
      encOutputs['last_hidden_state'] ?? Object.values(encOutputs)[0];

    // توکن‌های آغازین اجباری زبان فارسی: <|startoftranscript|> <|fa|> <|transcribe|>
    const generatedTokens: { tokenId: number; prob: number }[] = [
      { tokenId: this.whisperSpecial.sotTokenId, prob: 1.0 },
      { tokenId: this.whisperSpecial.persianLangTokenId, prob: 1.0 },
      { tokenId: this.whisperSpecial.transcribeTaskTokenId, prob: 1.0 },
    ];

    const maxNewTokens = 224;
    for (let step = 0; step < maxNewTokens; step++) {
      const inputIds = BigInt64Array.from(
        generatedTokens.map((g) => BigInt(g.tokenId)),
      );
      const decInputTensor = this.ortProvider.createTensor('int64', inputIds, [
        1,
        inputIds.length,
      ]);

      const decOut = await this.decoderSession.run({
        input_ids: decInputTensor,
        encoder_hidden_states: encoderHiddenStates,
      });

      const logitsTensor = decOut['logits'] ?? Object.values(decOut)[0];
      const [, seqLen, vocabSize] = logitsTensor.dims;
      const logitsData = logitsTensor.data as Float32Array;
      const lastStepOffset = (seqLen - 1) * vocabSize;
      const lastLogits = logitsData.subarray(lastStepOffset, lastStepOffset + vocabSize);

      const { bestId, prob } = this.argmaxWithSoftmaxProb(lastLogits);
      if (bestId === this.whisperSpecial.eotTokenId) break;

      generatedTokens.push({ tokenId: bestId, prob });
    }

    return this.parseWhisperTimestampedTokensToWords(generatedTokens.slice(3));
  }

  /**
   * تبدیل دنباله توکن‌های BPE و توکن‌های زمانی Whisper (<|0.00|> ... <|2.40|>) به کلمات فارسی با زمان دقیق
   */
  private parseWhisperTimestampedTokensToWords(
    sequence: { tokenId: number; prob: number }[],
  ): RawWordPrediction[] {
    const segments: {
      startSec: number;
      endSec: number;
      textTokenIds: { tokenId: number; prob: number }[];
    }[] = [];

    let curStartSec = 0;
    let curTokens: { tokenId: number; prob: number }[] = [];

    for (const item of sequence) {
      if (item.tokenId >= this.whisperSpecial.timestampBeginId) {
        const timeSec = (item.tokenId - this.whisperSpecial.timestampBeginId) * 0.02;
        if (curTokens.length === 0) {
          curStartSec = timeSec;
        } else {
          segments.push({
            startSec: curStartSec,
            endSec: Math.max(timeSec, curStartSec + 0.05),
            textTokenIds: curTokens,
          });
          curTokens = [];
          curStartSec = timeSec;
        }
      } else {
        curTokens.push(item);
      }
    }

    const words: RawWordPrediction[] = [];
    for (const seg of segments) {
      const decodedText = this.decodeWhisperBpeTokensToUtf8(
        seg.textTokenIds.map((t) => t.tokenId),
      ).trim();
      const segWords = decodedText.split(/\s+/).filter(Boolean);
      if (segWords.length === 0) continue;

      const avgProb =
        seg.textTokenIds.reduce((a, b) => a + b.prob, 0) / seg.textTokenIds.length;

      // توزیع متناسب زمان بین کلمات داخل سگمنت بر اساس طول کاراکتری هر کلمه فارسی
      const totalChars = Math.max(
        1,
        segWords.reduce((acc, w) => acc + w.length, 0),
      );
      const segDur = seg.endSec - seg.startSec;
      let cursorSec = seg.startSec;

      for (const w of segWords) {
        const wordDur = (w.length / totalChars) * segDur;
        words.push({
          word: w,
          relativeStartSec: Number(cursorSec.toFixed(3)),
          relativeEndSec: Number((cursorSec + wordDur).toFixed(3)),
          probability: Number(avgProb.toFixed(3)),
        });
        cursorSec += wordDur;
      }
    }

    return words;
  }

  /** دیکد صحیح رشته بایت‌های BPE به متن UTF-8 فارسی بدون شکستن حروف چندبایتی */
  private decodeWhisperBpeTokensToUtf8(tokenIds: number[]): string {
    const rawBytes: number[] = [];
    for (const id of tokenIds) {
      const bpeStr = this.whisperIdToToken.get(id);
      if (!bpeStr) continue;
      for (const ch of bpeStr) {
        const byteVal = this.whisperByteDecoderMap.get(ch);
        if (byteVal !== undefined) rawBytes.push(byteVal);
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(rawBytes));
  }

  private buildWhisperByteMaps(): {
    decoderMap: Map<string, number>;
    encoderMap: Map<number, string>;
  } {
    const bs: number[] = [];
    for (let b = 33; b <= 126; b++) bs.push(b);
    for (let b = 161; b <= 172; b++) bs.push(b);
    for (let b = 174; b <= 255; b++) bs.push(b);

    const cs = [...bs];
    let n = 0;
    for (let b = 0; b < 256; b++) {
      if (!bs.includes(b)) {
        bs.push(b);
        cs.push(256 + n);
        n++;
      }
    }

    const decoderMap = new Map<string, number>();
    const encoderMap = new Map<number, string>();
    for (let i = 0; i < bs.length; i++) {
      const ch = String.fromCharCode(cs[i]);
      decoderMap.set(ch, bs[i]);
      encoderMap.set(bs[i], ch);
    }
    return { decoderMap, encoderMap };
  }

  private argmaxWithSoftmaxProb(logits: Float32Array): { bestId: number; prob: number } {
    let bestId = 0;
    let maxLogit = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxLogit) {
        maxLogit = logits[i];
        bestId = i;
      }
    }
    let expSum = 0;
    for (let i = 0; i < logits.length; i++) {
      expSum += Math.exp(logits[i] - maxLogit);
    }
    return { bestId, prob: 1.0 / expSum };
  }
}
