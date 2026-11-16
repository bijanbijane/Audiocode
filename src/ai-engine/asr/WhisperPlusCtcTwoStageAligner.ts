import { OrtRuntimeProvider, OrtSessionLike } from './UnifiedOnnxPersianAsrEngine';
import { PersianCtcForcedAligner } from '../PersianCtcForcedAligner';
import { PersianNumeralAndCurrencyNormalizer } from '../PersianNumeralAndCurrencyNormalizer';
import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

export interface CoarseWhisperSegment {
  readonly segmentId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly rawTextFa: string;
  readonly avgConfidence: number;
}

/**
 * Section 119: Two-Stage Whisper + CTC Forced Re-Alignment Pipeline
 * Combines Whisper's conversational Persian transcription accuracy with 20ms CTC Viterbi phoneme-level alignment,
 * including automatic number verbalization (e.g., ۱۴۰۵ -> هزار و چهارصد و پنج) prior to acoustic alignment.
 */
export class WhisperPlusCtcTwoStageAligner {
  private ctcAcousticSession: OrtSessionLike | null = null;

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly charToVocabId: ReadonlyMap<string, number>,
    private readonly ctcFrameDurationSec: number = 0.02, // 20ms in Wav2Vec2-CTC
  ) {}

  public async loadCtcAlignerModel(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[],
  ): Promise<void> {
    this.ctcAcousticSession = await this.ortProvider.createSession(
      modelBytesOrPath,
      executionProviders,
    );
  }

  public async unloadModel(): Promise<void> {
    if (this.ctcAcousticSession?.release) await this.ctcAcousticSession.release();
    this.ctcAcousticSession = null;
  }

  /**
   * Re-align coarse Whisper segments onto 16kHz audio using CTC Viterbi Forced Alignment
   */
  public async reAlignWhisperSegments(
    pcm16kMono: Float32Array,
    whisperSegments: CoarseWhisperSegment[],
  ): Promise<TimedPersianToken[]> {
    if (!this.ctcAcousticSession) {
      throw new Error('CTC_ALIGNER_SESSION_NOT_LOADED');
    }

    const sr = 16000;
    const safetyMarginSamples = Math.floor(sr * 0.25); // ±250ms safety margin around Whisper segment
    const allAlignedTokens: TimedPersianToken[] = [];

    for (const seg of whisperSegments) {
      const segStartSample = Math.max(
        0,
        Math.floor(seg.startSec * sr) - safetyMarginSamples,
      );
      const segEndSample = Math.min(
        pcm16kMono.length,
        Math.ceil(seg.endSec * sr) + safetyMarginSamples,
      );
      if (segEndSample - segStartSample < 800) continue;

      const audioSlice = pcm16kMono.subarray(segStartSample, segEndSample);

      // 1. Expand numerals to spoken Persian words for acoustic alignment without mutating final display text
      const originalDisplayWords = seg.rawTextFa.trim().split(/\s+/).filter(Boolean);
      if (originalDisplayWords.length === 0) continue;

      const verbalizedWordsForViterbi: {
        id: string;
        text: string;
        parentWordIdx: number;
      }[] = [];

      originalDisplayWords.forEach((origW, wIdx) => {
        const cleanDigits = origW.replace(/[۰-۹]/g, (d) =>
          String.fromCharCode(d.charCodeAt(0) - 1728),
        );

        if (/^\d{1,9}$/.test(cleanDigits)) {
          const spoken = PersianNumeralAndCurrencyNormalizer.numberToPersianSpokenWords(
            parseInt(cleanDigits, 10),
          );
          const subWords = spoken.split(/\s+/).filter(Boolean);
          subWords.forEach((sw, swIdx) => {
            verbalizedWordsForViterbi.push({
              id: `${seg.segmentId}_w${wIdx}_s${swIdx}`,
              text: PersianTextNormalizer.normalizeTokenText(sw),
              parentWordIdx: wIdx,
            });
          });
        } else {
          const norm = PersianTextNormalizer.normalizeTokenText(origW).replace(
            /[،؛.!؟«»"()\-:]/g,
            '',
          );
          if (norm.length > 0) {
            verbalizedWordsForViterbi.push({
              id: `${seg.segmentId}_w${wIdx}`,
              text: norm,
              parentWordIdx: wIdx,
            });
          }
        }
      });

      if (verbalizedWordsForViterbi.length === 0) continue;

      // 2. Extract frame log-probability matrix from lightweight CTC encoder
      const logProbsPerFrame = await this.runCtcEncoderForLogProbs(audioSlice);
      if (logProbsPerFrame.length === 0) continue;

      const sliceOffsetFlicks = TimeMath.samplesToFlicks(segStartSample, sr);

      // 3. Run CTC Viterbi Forced Alignment over the Persian character sequence
      const alignedSubWords = PersianCtcForcedAligner.alignPersianWordsToAudio(
        logProbsPerFrame,
        this.charToVocabId,
        verbalizedWordsForViterbi,
        this.ctcFrameDurationSec,
        sliceOffsetFlicks,
      );

      // 4. Aggregate expanded subword spans back onto the parent Whisper tokens
      const groupedByParent = new Map<
        number,
        { start: number; end: number; confSum: number; count: number }
      >();

      alignedSubWords.forEach((aw, idx) => {
        const pIdx = verbalizedWordsForViterbi[idx].parentWordIdx;
        const prev = groupedByParent.get(pIdx);
        if (!prev) {
          groupedByParent.set(pIdx, {
            start: aw.alignedRange.start,
            end: aw.alignedRange.end,
            confSum: aw.acousticConfidence,
            count: 1,
          });
        } else {
          prev.start = Math.min(prev.start, aw.alignedRange.start);
          prev.end = Math.max(prev.end, aw.alignedRange.end);
          prev.confSum += aw.acousticConfidence;
          prev.count++;
        }
      });

      const rawAlignedForNorm = originalDisplayWords.map((origText, wIdx) => {
        const grp = groupedByParent.get(wIdx);
        return {
          id: `${seg.segmentId}_aligned_${wIdx}`,
          text: origText,
          range: grp
            ? { start: grp.start, end: grp.end }
            : {
                start: TimeMath.secondsToFlicks(seg.startSec),
                end: TimeMath.secondsToFlicks(seg.endSec),
              },
          confidence: grp
            ? Number((grp.confSum / grp.count).toFixed(2))
            : seg.avgConfidence,
        };
      });

      allAlignedTokens.push(
        ...PersianTextNormalizer.buildThreeLayerTranscript(rawAlignedForNorm),
      );
    }

    return allAlignedTokens;
  }

  private async runCtcEncoderForLogProbs(
    pcm16kSlice: Float32Array,
  ): Promise<Float32Array[]> {
    if (!this.ctcAcousticSession) return [];

    const inputTensor = this.ortProvider.createTensor('float32', pcm16kSlice, [
      1,
      pcm16kSlice.length,
    ]);

    const outputs = await this.ctcAcousticSession.run({ input_values: inputTensor });
    const logitsTensor = outputs['logits'] ?? Object.values(outputs)[0];
    const [, numFrames, vocabSize] = logitsTensor.dims;
    const rawLogits = logitsTensor.data as Float32Array;

    const logProbs: Float32Array[] = new Array(numFrames);
    for (let t = 0; t < numFrames; t++) {
      const offset = t * vocabSize;
      const frame = new Float32Array(vocabSize);

      let maxL = -Infinity;
      for (let v = 0; v < vocabSize; v++) {
        if (rawLogits[offset + v] > maxL) maxL = rawLogits[offset + v];
      }
      let sumExp = 0;
      for (let v = 0; v < vocabSize; v++) {
        sumExp += Math.exp(rawLogits[offset + v] - maxL);
      }
      const logZ = maxL + Math.log(sumExp);
      for (let v = 0; v < vocabSize; v++) {
        frame[v] = rawLogits[offset + v] - logZ;
      }
      logProbs[t] = frame;
    }

    return logProbs;
  }
}
