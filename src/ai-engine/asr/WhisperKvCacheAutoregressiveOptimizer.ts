import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
  WhisperSpecialTokens,
} from './UnifiedOnnxPersianAsrEngine';

export interface WhisperKvCacheConfig {
  readonly numDecoderLayers: number; // 4 in Tiny, 6 in Base, 12 in Small, 24 in Medium
  readonly numAttentionHeads: number; // 6 in Tiny, 8 in Base, 12 in Small, 16 in Medium
  readonly headDim: number; // Typically 64
  readonly maxDecoderSequenceLength: number; // Typically 224
  readonly repetitionPenalty?: number; // Default 1.18 to prevent infinite repetition loops on noisy Persian audio
}

/**
 * Section 111: Whisper O(N) Autoregressive KV-Cache Optimizer & Anti-Hallucination Logit Guard
 */
export class WhisperKvCacheAutoregressiveOptimizer {
  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly kvCfg: WhisperKvCacheConfig,
    private readonly specialTokens: WhisperSpecialTokens,
  ) {}

  /**
   * O(N) Whisper autoregressive decoding reusing past_key_values KV-Cache and applying anti-repetition logit guards
   */
  public async decodeWithKvCache(params: {
    decoderWithPastSession: OrtSessionLike;
    encoderHiddenStates: OrtTensorLike;
    isMergedUseCacheBranchModel?: boolean;
  }): Promise<{ tokenId: number; prob: number }[]> {
    const { decoderWithPastSession, encoderHiddenStates } = params;
    const { numDecoderLayers, numAttentionHeads, headDim, maxDecoderSequenceLength } =
      this.kvCfg;

    const generated: { tokenId: number; prob: number }[] = [
      { tokenId: this.specialTokens.sotTokenId, prob: 1.0 },
      { tokenId: this.specialTokens.persianLangTokenId, prob: 1.0 },
      { tokenId: this.specialTokens.transcribeTaskTokenId, prob: 1.0 },
    ];

    // Cross-attention encoder KV caches are populated on step 0 and reused unchanged for all subsequent steps
    const encoderKvCache = new Map<string, OrtTensorLike>();
    const decoderKvCache = new Map<string, OrtTensorLike>();

    let isFirstStep = true;
    let lastTimestampTokenId = this.specialTokens.timestampBeginId - 1;

    for (let step = 0; step < maxDecoderSequenceLength; step++) {
      const feeds: Record<string, OrtTensorLike> = {};

      if (isFirstStep) {
        const initIds = BigInt64Array.from(generated.map((g) => BigInt(g.tokenId)));
        feeds['input_ids'] = this.ortProvider.createTensor('int64', initIds, [
          1,
          initIds.length,
        ]);
        feeds['encoder_hidden_states'] = encoderHiddenStates;

        if (params.isMergedUseCacheBranchModel) {
          for (let l = 0; l < numDecoderLayers; l++) {
            const emptyKv = this.ortProvider.createTensor('float32', new Float32Array(0), [
              1,
              numAttentionHeads,
              0,
              headDim,
            ]);
            feeds[`past_key_values.${l}.decoder.key`] = emptyKv;
            feeds[`past_key_values.${l}.decoder.value`] = emptyKv;
            feeds[`past_key_values.${l}.encoder.key`] = emptyKv;
            feeds[`past_key_values.${l}.encoder.value`] = emptyKv;
          }
        }
      } else {
        // Subsequent steps feed only the single last generated token [1, 1] + KV-Cache
        const lastTokenId = generated[generated.length - 1].tokenId;
        feeds['input_ids'] = this.ortProvider.createTensor(
          'int64',
          BigInt64Array.from([BigInt(lastTokenId)]),
          [1, 1],
        );

        for (let l = 0; l < numDecoderLayers; l++) {
          feeds[`past_key_values.${l}.decoder.key`] = decoderKvCache.get(`dec.k.${l}`)!;
          feeds[`past_key_values.${l}.decoder.value`] = decoderKvCache.get(`dec.v.${l}`)!;
          feeds[`past_key_values.${l}.encoder.key`] = encoderKvCache.get(`enc.k.${l}`)!;
          feeds[`past_key_values.${l}.encoder.value`] = encoderKvCache.get(`enc.v.${l}`)!;
        }
      }

      const outputs = await decoderWithPastSession.run(feeds);

      // Update present.* KV caches
      for (let l = 0; l < numDecoderLayers; l++) {
        const decK = outputs[`present.${l}.decoder.key`];
        const decV = outputs[`present.${l}.decoder.value`];
        if (decK && decV) {
          decoderKvCache.set(`dec.k.${l}`, decK);
          decoderKvCache.set(`dec.v.${l}`, decV);
        }

        if (isFirstStep) {
          const encK = outputs[`present.${l}.encoder.key`];
          const encV = outputs[`present.${l}.encoder.value`];
          if (encK && encV) {
            encoderKvCache.set(`enc.k.${l}`, encK);
            encoderKvCache.set(`enc.v.${l}`, encV);
          }
        }
      }

      const logitsTensor = outputs['logits'] ?? Object.values(outputs)[0];
      const [, seqLen, vocabSize] = logitsTensor.dims;
      const logitsData = logitsTensor.data as Float32Array;
      const lastStepLogits = new Float32Array(
        logitsData.subarray((seqLen - 1) * vocabSize, seqLen * vocabSize),
      );

      this.applyWhisperLogitGuardsInPlace(
        lastStepLogits,
        generated,
        lastTimestampTokenId,
        isFirstStep,
      );

      const { bestId, prob } = this.selectBestToken(lastStepLogits);
      if (bestId === this.specialTokens.eotTokenId) break;

      if (bestId >= this.specialTokens.timestampBeginId) {
        lastTimestampTokenId = bestId;
      }

      generated.push({ tokenId: bestId, prob });
      isFirstStep = false;
    }

    return generated.slice(3);
  }

  /**
   * Anti-Hallucination & monotonic timestamp logit guards for Persian speech
   */
  private applyWhisperLogitGuardsInPlace(
    logits: Float32Array,
    generatedSoFar: { tokenId: number; prob: number }[],
    lastTimestampTokenId: number,
    isFirstGeneratedToken: boolean,
  ): void {
    const tsBegin = this.specialTokens.timestampBeginId;
    const penalty = this.kvCfg.repetitionPenalty ?? 1.18;

    // 1. Force first generated token after prompt to be a timestamp token (e.g. <|0.00|>)
    if (isFirstGeneratedToken) {
      for (let i = 0; i < tsBegin; i++) {
        logits[i] = -1e9;
      }
      return;
    }

    // 2. Enforce strictly monotonic non-decreasing timestamps
    for (let t = tsBegin; t <= lastTimestampTokenId && t < logits.length; t++) {
      logits[t] = -1e9;
    }

    // 3. Prevent emitting more than two consecutive timestamp tokens without text in between
    const lastOneWasTs =
      generatedSoFar[generatedSoFar.length - 1]?.tokenId >= tsBegin;
    const prevTwoWereTs =
      lastOneWasTs && generatedSoFar[generatedSoFar.length - 2]?.tokenId >= tsBegin;
    if (prevTwoWereTs) {
      for (let t = tsBegin; t < logits.length; t++) {
        logits[t] = -1e9;
      }
    }

    // 4. Apply Repetition Penalty over the last 12 non-timestamp tokens
    const recentNonTsIds = new Set<number>();
    const lookbackStart = Math.max(3, generatedSoFar.length - 12);
    for (let i = lookbackStart; i < generatedSoFar.length; i++) {
      const id = generatedSoFar[i].tokenId;
      if (id < tsBegin) recentNonTsIds.add(id);
    }

    for (const tokId of recentNonTsIds) {
      if (tokId < logits.length) {
        logits[tokId] = logits[tokId] > 0 ? logits[tokId] / penalty : logits[tokId] * penalty;
      }
    }
  }

  private selectBestToken(logits: Float32Array): { bestId: number; prob: number } {
    let bestId = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxVal) {
        maxVal = logits[i];
        bestId = i;
      }
    }
    let expSum = 0;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > -1e8) expSum += Math.exp(logits[i] - maxVal);
    }
    return { bestId, prob: 1.0 / Math.max(1e-9, expSum) };
  }
}
