import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhisperKvCacheAutoregressiveOptimizer } from './WhisperKvCacheAutoregressiveOptimizer';
import { OrtRuntimeProvider } from './UnifiedOnnxPersianAsrEngine';

describe('Section 111: WhisperKvCacheAutoregressiveOptimizer (O(N) KV-Cache + Repetition Guard)', () => {
  it('feeds [1, 3] on step 0 and [1, 1] with past_key_values on subsequent steps while enforcing timestamp and repetition guards', async () => {
    const observedInputLengths: number[] = [];
    let stepIdx = 0;

    const special = {
      sotTokenId: 50,
      persianLangTokenId: 51,
      transcribeTaskTokenId: 52,
      eotTokenId: 53,
      timestampBeginId: 60,
    };

    const mockOrt: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        throw new Error('Not used directly');
      },
    };

    const optimizer = new WhisperKvCacheAutoregressiveOptimizer(
      mockOrt,
      {
        numDecoderLayers: 2,
        numAttentionHeads: 4,
        headDim: 8,
        maxDecoderSequenceLength: 10,
        repetitionPenalty: 1.5,
      },
      special,
    );

    const mockDecoderSession = {
      async run(feeds: Record<string, any>) {
        const seqLen = feeds.input_ids.dims[1];
        observedInputLengths.push(seqLen);

        const vocabSize = 70;
        const logits = new Float32Array(seqLen * vocabSize).fill(-5);
        const offset = (seqLen - 1) * vocabSize;

        if (stepIdx === 0) {
          // Non-timestamp token 10 has high logit, but first step guard must force timestamp >= 60
          logits[offset + 10] = 12.0;
          logits[offset + 60] = 4.0; // <|0.00|>
        } else if (stepIdx === 1) {
          logits[offset + 12] = 6.0; // Token 12
        } else if (stepIdx === 2) {
          // Token 12 (repeated) has slightly higher raw logit than Token 14, but repetition penalty (1.5) suppresses Token 12!
          logits[offset + 12] = 6.0; // 6.0 / 1.5 = 4.0 after penalty
          logits[offset + 14] = 5.0; // wins!
        } else if (stepIdx === 3) {
          logits[offset + 65] = 8.0; // <|0.10|>
        } else {
          logits[offset + special.eotTokenId] = 10.0;
        }
        stepIdx++;

        const dummyKv = {
          type: 'float32' as const,
          data: new Float32Array(4),
          dims: [1, 4, 1, 8],
        };
        return {
          logits: { type: 'float32' as const, data: logits, dims: [1, seqLen, vocabSize] },
          'present.0.decoder.key': dummyKv,
          'present.0.decoder.value': dummyKv,
          'present.0.encoder.key': dummyKv,
          'present.0.encoder.value': dummyKv,
          'present.1.decoder.key': dummyKv,
          'present.1.decoder.value': dummyKv,
          'present.1.encoder.key': dummyKv,
          'present.1.encoder.value': dummyKv,
        };
      },
    };

    const generated = await optimizer.decodeWithKvCache({
      decoderWithPastSession: mockDecoderSession,
      encoderHiddenStates: {
        type: 'float32',
        data: new Float32Array(16),
        dims: [1, 4, 4],
      },
      isMergedUseCacheBranchModel: true,
    });

    assert.deepEqual(observedInputLengths, [3, 1, 1, 1, 1]);
    assert.deepEqual(
      generated.map((g) => g.tokenId),
      [60, 12, 14, 65],
    );
  });
});
