import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CausalFastConformerStreamingRunner,
  LocalAgreement2StreamStabilizer,
} from './StreamingLivePersianAsrEngine';
import { OrtRuntimeProvider } from './UnifiedOnnxPersianAsrEngine';
import { RawWordPrediction } from '../PersianChunkedAsrWorker';

describe('Section 107: StreamingLivePersianAsrEngine (Causal FastConformer + LocalAgreement-2)', () => {
  it('maintains 9-frame Mel overlap and carries cache_last_channel/time tensors in CausalFastConformerStreamingRunner', async () => {
    const vocab = ['<blank>', '\u2581سلام', '\u2581برنامه'];
    let observedCacheLen = -1n;

    const mockOrt: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run(feeds) {
            observedCacheLen = (feeds.cache_last_channel_len.data as BigInt64Array)[0];
            const outFrames = 4;
            const V = vocab.length;
            const probs = new Float32Array(outFrames * V).fill(-10);
            probs[1 * V + 1] = -0.05; // ▁سلام
            probs[0 * V + 0] = -0.05;
            probs[2 * V + 0] = -0.05;
            probs[3 * V + 0] = -0.05;

            return {
              outputs: { type: 'float32', data: probs, dims: [1, outFrames, V] },
              cache_last_channel_next: feeds.cache_last_channel,
              cache_last_time_next: feeds.cache_last_time,
              cache_last_channel_len_next: {
                type: 'int64',
                data: BigInt64Array.from([observedCacheLen + 4n]),
                dims: [1],
              },
            };
          },
        };
      },
    };

    const runner = new CausalFastConformerStreamingRunner(mockOrt, vocab, {
      numLayers: 2,
      attentionContextFrames: 16,
      hiddenDim: 32,
      convKernelContext: 4,
      preEncodeOverlapMelFrames: 9,
      chunkShiftMelFrames: 28,
    });
    await runner.loadModel(new Uint8Array([1, 2]), ['wasm']);

    const chunk1 = await runner.processLiveAudioChunk(new Float32Array(8000));
    assert.equal(observedCacheLen, 0n);
    assert.equal(chunk1.newlyCommittedWords[0]?.word, 'سلام');

    const chunk2 = await runner.processLiveAudioChunk(new Float32Array(8000));
    assert.equal(observedCacheLen, 4n);
    assert.ok(chunk2.totalAudioProcessedSeconds > chunk1.totalAudioProcessedSeconds);
  });

  it('commits matching prefix words only outside the 350ms Draft Horizon in LocalAgreement2StreamStabilizer', async () => {
    let step = 0;
    const hypotheses: RawWordPrediction[][] = [
      // Step 1 (1.0s buffer): "سلام" ends at 0.45s (safe), "پاد" ends at 0.90s (inside 350ms draft horizon)
      [
        { word: 'سلام', relativeStartSec: 0.1, relativeEndSec: 0.45, probability: 0.95 },
        { word: 'پاد', relativeStartSec: 0.5, relativeEndSec: 0.9, probability: 0.7 },
      ],
      // Step 2 (2.0s buffer): "سلام" confirmed and outside 350ms horizon -> committed! "پادکست" ends at 1.85s (inside draft horizon)
      [
        { word: 'سلام', relativeStartSec: 0.1, relativeEndSec: 0.45, probability: 0.97 },
        { word: 'پادکست', relativeStartSec: 0.5, relativeEndSec: 1.85, probability: 0.94 },
      ],
    ];

    const stabilizer = new LocalAgreement2StreamStabilizer(async () => {
      return hypotheses[Math.min(step++, hypotheses.length - 1)];
    }, 0.35);

    const u1 = await stabilizer.pushAudioChunkAndTranscribe(new Float32Array(16000)); // 1.0s
    assert.equal(u1.newlyCommittedWords.length, 0);
    assert.equal(u1.tentativeTailWords.length, 2);

    const u2 = await stabilizer.pushAudioChunkAndTranscribe(new Float32Array(16000)); // 2.0s
    assert.equal(u2.newlyCommittedWords.length, 1);
    assert.equal(u2.newlyCommittedWords[0].word, 'سلام');
    assert.equal(u2.tentativeTailWords.length, 1);
    assert.equal(u2.tentativeTailWords[0].word, 'پادکست');
  });
});
