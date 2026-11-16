import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
  WhisperSpecialTokens,
} from './UnifiedOnnxPersianAsrEngine';

export interface BeamSearchTempFallbackOptions {
  readonly numDecoderLayers: number;
  readonly numAttentionHeads: number;
  readonly headDim: number;
  readonly beamSize?: number; // Default 3 beams at temperature 0.0
  readonly lengthPenalty?: number; // Default 1.0
  readonly maxDecoderSequenceLength?: number;
  readonly temperatures?: readonly number[]; // Default [0.0, 0.2, 0.4, 0.6, 0.8]
  readonly compressionRatioThreshold?: number; // Whisper standard: 2.4
  readonly logProbThreshold?: number; // Whisper standard: -1.0
  readonly noSpeechProbThreshold?: number; // Default 0.6
  readonly noSpeechTokenId?: number;
}

export interface WhisperBeamDecodeOutcome {
  readonly tokenIds: number[];
  readonly tokenProbs: number[];
  readonly avgLogProb: number;
  readonly compressionRatio: number;
  readonly temperatureUsed: number;
  readonly noSpeechProb: number;
}

interface ActiveBeamState {
  tokenIds: number[];
  tokenProbs: number[];
  sumLogProb: number;
  decoderKv: Map<string, OrtTensorLike>;
  lastTimestampId: number;
  finished: boolean;
}

/**
 * Section 131: Multi-Beam Whisper Decoder with Automatic Temperature Fallback & Pure LZ77 Anti-Hallucination Guard
 */
export class WhisperBeamSearchAndTempFallbackEngine {
  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly specialTokens: WhisperSpecialTokens,
    private readonly decodeTokensToTextFn: (tokenIds: number[]) => string,
  ) {}

  /**
   * 1. Execute decoding with automatic Temperature Fallback (0.0 -> 0.2 -> 0.4 -> 0.6 -> 0.8)
   * whenever LZ77 compression ratio > 2.4 or avgLogProb < -1.0
   */
  public async decodeWithTemperatureFallback(params: {
    decoderWithPastSession: OrtSessionLike;
    encoderHiddenStates: OrtTensorLike;
    initialPromptTokenIds: number[];
    options: BeamSearchTempFallbackOptions;
  }): Promise<WhisperBeamDecodeOutcome> {
    const temperatures = params.options.temperatures ?? [0.0, 0.2, 0.4, 0.6, 0.8];
    const compressionLimit = params.options.compressionRatioThreshold ?? 2.4;
    const logProbLimit = params.options.logProbThreshold ?? -1.0;

    let bestFallbackOutcome: WhisperBeamDecodeOutcome | null = null;

    for (const temp of temperatures) {
      const outcome = await this.runSingleTemperaturePass({
        decoderWithPastSession: params.decoderWithPastSession,
        encoderHiddenStates: params.encoderHiddenStates,
        initialPromptTokenIds: params.initialPromptTokenIds,
        temperature: temp,
        options: params.options,
      });

      if (!bestFallbackOutcome || outcome.avgLogProb > bestFallbackOutcome.avgLogProb) {
        bestFallbackOutcome = outcome;
      }

      const needsRetry =
        outcome.compressionRatio > compressionLimit ||
        outcome.avgLogProb < logProbLimit;

      if (!needsRetry) {
        return outcome;
      }
    }

    return bestFallbackOutcome!;
  }

  /**
   * 2. Run a single temperature pass (Deterministic Beam Search at T=0.0 or Top-K Stochastic Sampling at T>0)
   */
  private async runSingleTemperaturePass(params: {
    decoderWithPastSession: OrtSessionLike;
    encoderHiddenStates: OrtTensorLike;
    initialPromptTokenIds: number[];
    temperature: number;
    options: BeamSearchTempFallbackOptions;
  }): Promise<WhisperBeamDecodeOutcome> {
    const {
      decoderWithPastSession,
      encoderHiddenStates,
      initialPromptTokenIds,
      temperature,
      options,
    } = params;

    const beamSize = temperature === 0 ? (options.beamSize ?? 3) : 1;
    const maxSteps = options.maxDecoderSequenceLength ?? 224;
    const lenPenalty = options.lengthPenalty ?? 1.0;
    const { numDecoderLayers, numAttentionHeads, headDim } = options;

    const sharedEncoderKv = new Map<string, OrtTensorLike>();
    let firstStepNoSpeechProb = 0;

    let beams: ActiveBeamState[] = [
      {
        tokenIds: [...initialPromptTokenIds],
        tokenProbs: initialPromptTokenIds.map(() => 1.0),
        sumLogProb: 0,
        decoderKv: new Map(),
        lastTimestampId: this.specialTokens.timestampBeginId - 1,
        finished: false,
      },
    ];

    for (let step = 0; step < maxSteps; step++) {
      const isFirstStep = step === 0;
      const nextBeamCandidates: ActiveBeamState[] = [];

      for (const beam of beams) {
        if (beam.finished) {
          nextBeamCandidates.push(beam);
          continue;
        }

        const feeds: Record<string, OrtTensorLike> = {};
        if (isFirstStep) {
          const idsArr = BigInt64Array.from(beam.tokenIds.map((id) => BigInt(id)));
          feeds['input_ids'] = this.ortProvider.createTensor('int64', idsArr, [
            1,
            idsArr.length,
          ]);
          feeds['encoder_hidden_states'] = encoderHiddenStates;

          for (let l = 0; l < numDecoderLayers; l++) {
            const emptyKv = this.ortProvider.createTensor(
              'float32',
              new Float32Array(0),
              [1, numAttentionHeads, 0, headDim],
            );
            feeds[`past_key_values.${l}.decoder.key`] = emptyKv;
            feeds[`past_key_values.${l}.decoder.value`] = emptyKv;
            feeds[`past_key_values.${l}.encoder.key`] = emptyKv;
            feeds[`past_key_values.${l}.encoder.value`] = emptyKv;
          }
        } else {
          const lastId = beam.tokenIds[beam.tokenIds.length - 1];
          feeds['input_ids'] = this.ortProvider.createTensor(
            'int64',
            BigInt64Array.from([BigInt(lastId)]),
            [1, 1],
          );
          for (let l = 0; l < numDecoderLayers; l++) {
            feeds[`past_key_values.${l}.decoder.key`] = beam.decoderKv.get(`dec.k.${l}`)!;
            feeds[`past_key_values.${l}.decoder.value`] = beam.decoderKv.get(
              `dec.v.${l}`,
            )!;
            feeds[`past_key_values.${l}.encoder.key`] = sharedEncoderKv.get(
              `enc.k.${l}`,
            )!;
            feeds[`past_key_values.${l}.encoder.value`] = sharedEncoderKv.get(
              `enc.v.${l}`,
            )!;
          }
        }

        const outputs = await decoderWithPastSession.run(feeds);

        const newDecoderKv = new Map<string, OrtTensorLike>();
        for (let l = 0; l < numDecoderLayers; l++) {
          const dk = outputs[`present.${l}.decoder.key`];
          const dv = outputs[`present.${l}.decoder.value`];
          if (dk && dv) {
            newDecoderKv.set(`dec.k.${l}`, dk);
            newDecoderKv.set(`dec.v.${l}`, dv);
          }
          if (isFirstStep) {
            const ek = outputs[`present.${l}.encoder.key`];
            const ev = outputs[`present.${l}.encoder.value`];
            if (ek && ev) {
              sharedEncoderKv.set(`enc.k.${l}`, ek);
              sharedEncoderKv.set(`enc.v.${l}`, ev);
            }
          }
        }

        const logitsTensor = outputs['logits'] ?? Object.values(outputs)[0];
        const [, seqLen, vocabSize] = logitsTensor.dims;
        const rawLogits = logitsTensor.data as Float32Array;
        const stepLogits = new Float32Array(
          rawLogits.subarray((seqLen - 1) * vocabSize, seqLen * vocabSize),
        );

        if (
          isFirstStep &&
          options.noSpeechTokenId !== undefined &&
          options.noSpeechTokenId < stepLogits.length
        ) {
          const logProbsRaw = this.logSoftmax(stepLogits);
          firstStepNoSpeechProb = Math.exp(logProbsRaw[options.noSpeechTokenId]);
        }

        for (
          let t = this.specialTokens.timestampBeginId;
          t <= beam.lastTimestampId && t < stepLogits.length;
          t++
        ) {
          stepLogits[t] = -1e9;
        }

        const logProbs = this.logSoftmax(stepLogits, Math.max(1.0, temperature));

        if (temperature > 0) {
          const sampled = this.sampleTopK(logProbs, 20);
          const isEot = sampled.tokenId === this.specialTokens.eotTokenId;
          nextBeamCandidates.push({
            tokenIds: isEot ? beam.tokenIds : [...beam.tokenIds, sampled.tokenId],
            tokenProbs: isEot
              ? beam.tokenProbs
              : [...beam.tokenProbs, Math.exp(sampled.logProb)],
            sumLogProb: beam.sumLogProb + sampled.logProb,
            decoderKv: newDecoderKv,
            lastTimestampId:
              sampled.tokenId >= this.specialTokens.timestampBeginId
                ? sampled.tokenId
                : beam.lastTimestampId,
            finished: isEot,
          });
        } else {
          const topK = this.topKIndices(logProbs, beamSize);
          for (const tokId of topK) {
            const lp = logProbs[tokId];
            const isEot = tokId === this.specialTokens.eotTokenId;
            nextBeamCandidates.push({
              tokenIds: isEot ? beam.tokenIds : [...beam.tokenIds, tokId],
              tokenProbs: isEot ? beam.tokenProbs : [...beam.tokenProbs, Math.exp(lp)],
              sumLogProb: beam.sumLogProb + lp,
              decoderKv: newDecoderKv,
              lastTimestampId:
                tokId >= this.specialTokens.timestampBeginId
                  ? tokId
                  : beam.lastTimestampId,
              finished: isEot,
            });
          }
        }
      }

      beams = nextBeamCandidates
        .sort((a, b) => {
          const normA =
            a.sumLogProb / Math.pow((5 + a.tokenIds.length) / 6, lenPenalty);
          const normB =
            b.sumLogProb / Math.pow((5 + b.tokenIds.length) / 6, lenPenalty);
          return normB - normA;
        })
        .slice(0, beamSize);

      if (beams.every((b) => b.finished)) break;
    }

    const winner = beams[0];
    const generatedOnlyIds = winner.tokenIds.slice(initialPromptTokenIds.length);
    const generatedOnlyProbs = winner.tokenProbs.slice(initialPromptTokenIds.length);

    const decodedText = this.decodeTokensToTextFn(generatedOnlyIds);
    const compressionRatio =
      WhisperBeamSearchAndTempFallbackEngine.computeUtf8TextCompressionRatio(
        decodedText,
      );
    const avgLogProb =
      generatedOnlyIds.length > 0
        ? winner.sumLogProb / (generatedOnlyIds.length + 1)
        : -10.0;

    return {
      tokenIds: generatedOnlyIds,
      tokenProbs: generatedOnlyProbs,
      avgLogProb: Number(avgLogProb.toFixed(3)),
      compressionRatio: Number(compressionRatio.toFixed(3)),
      temperatureUsed: temperature,
      noSpeechProb: Number(firstStepNoSpeechProb.toFixed(3)),
    };
  }

  /**
   * 3. Runtime-agnostic pure LZ77 UTF-8 text compression ratio (zero node:zlib dependency)
   * Values > 2.4 reliably indicate repetitive hallucination loops.
   */
  public static computeUtf8TextCompressionRatio(text: string): number {
    const bytes = new TextEncoder().encode(text.trim());
    if (bytes.length < 16) return 1.0;

    let compressedTokens = 0;
    let i = 0;
    const windowSize = 256;

    while (i < bytes.length) {
      let bestMatchLen = 0;
      const searchStart = Math.max(0, i - windowSize);

      for (let j = searchStart; j < i; j++) {
        let matchLen = 0;
        while (
          matchLen < 32 &&
          i + matchLen < bytes.length &&
          bytes[j + matchLen] === bytes[i + matchLen]
        ) {
          matchLen++;
        }
        if (matchLen > bestMatchLen) bestMatchLen = matchLen;
      }

      if (bestMatchLen >= 4) {
        compressedTokens += 2;
        i += bestMatchLen;
      } else {
        compressedTokens += 1;
        i += 1;
      }
    }

    return bytes.length / Math.max(1, compressedTokens);
  }

  private logSoftmax(logits: Float32Array, temp: number = 1.0): Float32Array {
    const out = new Float32Array(logits.length);
    let maxVal = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      const v = logits[i] / temp;
      out[i] = v;
      if (v > maxVal) maxVal = v;
    }
    let sumExp = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > -1e7) sumExp += Math.exp(out[i] - maxVal);
    }
    const logZ = maxVal + Math.log(Math.max(1e-12, sumExp));
    for (let i = 0; i < out.length; i++) out[i] -= logZ;
    return out;
  }

  private topKIndices(arr: Float32Array, k: number): number[] {
    const best: { idx: number; val: number }[] = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < -1e7) continue;
      if (best.length < k) {
        best.push({ idx: i, val: v });
        if (best.length === k) best.sort((a, b) => a.val - b.val);
      } else if (v > best[0].val) {
        best[0] = { idx: i, val: v };
        best.sort((a, b) => a.val - b.val);
      }
    }
    return best.sort((a, b) => b.val - a.val).map((x) => x.idx);
  }

  private sampleTopK(
    logProbs: Float32Array,
    k: number,
  ): { tokenId: number; logProb: number } {
    const topIds = this.topKIndices(logProbs, k);
    if (topIds.length === 0) {
      return { tokenId: this.specialTokens.eotTokenId, logProb: 0 };
    }

    const probs = topIds.map((id) => Math.exp(logProbs[id]));
    const sum = probs.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;

    for (let i = 0; i < topIds.length; i++) {
      r -= probs[i];
      if (r <= 0) {
        return { tokenId: topIds[i], logProb: logProbs[topIds[i]] };
      }
    }
    return { tokenId: topIds[0], logProb: logProbs[topIds[0]] };
  }
}
