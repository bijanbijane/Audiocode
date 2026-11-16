import { describe, it, expect } from 'vitest';
import { CompactPersianLanguageModelScorer } from '../../src/ai-engine/asr/CompactPersianLanguageModelScorer';
import { ContextBiasingTrieCtcScorer } from '../../src/ai-engine/asr/ContextBiasingTrieCtcScorer';
import { PersianFastConformerRnntAndTdtDecoder } from '../../src/ai-engine/asr/PersianFastConformerRnntAndTdtDecoder';
import { WhisperPlusCtcTwoStageAligner } from '../../src/ai-engine/asr/WhisperPlusCtcTwoStageAligner';
import { SingleFlightReadThroughCache } from '../src/cache/BackendReadThroughCacheAndMetrics';
import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from '../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';

describe('Section 124: Advanced Persian ASR Core & Backend Cache Verification Suite', () => {
  it('1. ContextBiasingTrieCtcScorer boosts domain proper nouns and penalizes homophone misspellings', () => {
    const baseLm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(
      ['سلام آقای طباطبایی', 'سلام آقای تباتبایی'],
      1,
      1,
    );

    const biasedScorer = new ContextBiasingTrieCtcScorer(baseLm, [
      { phrase: 'طباطبایی', boostLogProb: 3.0 },
      { phrase: 'کوبرنتیز', boostLogProb: 3.0 },
    ]);

    const exactHotwordScore = biasedScorer.scoreWordTransitionLogProb('آقای', 'طباطبایی');
    const homophoneWrongScore = biasedScorer.scoreWordTransitionLogProb('آقای', 'تباتبایی');

    expect(exactHotwordScore).toBeGreaterThan(homophoneWrongScore + 3.5);
    expect(biasedScorer.getPartialPrefixDepthBonus('کوبر')).toBeGreaterThan(0);
  });

  it('2. PersianFastConformerRnntAndTdtDecoder decodes TDT duration jumps and guards against infinite loops', async () => {
    const vocab = ['<blk>', '\u2581سلام', '\u2581تست'];
    const durations = [0, 1, 2]; // TDT indices 3, 4, 5

    let stepCallCount = 0;
    const mockOrt: OrtRuntimeProvider = {
      createTensor: (type, data, dims) => ({ type, data, dims }) as OrtTensorLike,
      createSession: async (nameOrPath): Promise<OrtSessionLike> => ({
        run: async (): Promise<Record<string, OrtTensorLike>> => {
          if (nameOrPath === 'enc') {
            return {
              outputs: {
                type: 'float32',
                dims: [1, 8, 4],
                data: new Float32Array(32),
              },
            };
          }
          if (nameOrPath === 'dec') {
            return {
              outputs: { type: 'float32', dims: [1, 8, 1], data: new Float32Array(8) },
              states_1_out: { type: 'float32', dims: [1, 1, 8], data: new Float32Array(8) },
              states_2_out: { type: 'float32', dims: [1, 1, 8], data: new Float32Array(8) },
            };
          }
          const logits = new Float32Array(vocab.length + durations.length).fill(-10);
          if (stepCallCount === 0) {
            logits[1] = 5.0; // '▁سلام'
            logits[5] = 5.0; // durationSkip = 2 frames
          } else {
            logits[2] = 5.0; // '▁تست'
            logits[5] = 5.0; // durationSkip = 2 frames
          }
          stepCallCount++;
          return {
            outputs: {
              type: 'float32',
              dims: [1, 1, 1, logits.length],
              data: logits,
            },
          };
        },
      }),
    };

    const tdtDecoder = new PersianFastConformerRnntAndTdtDecoder(mockOrt, {
      mode: 'TDT',
      vocabulary: vocab,
      blankTokenId: 0,
      predNumLayers: 1,
      predHiddenDim: 8,
      encoderFrameDurationSec: 0.04,
      tdtDurationsMap: durations,
    });

    await tdtDecoder.loadModels({
      encoderBytesOrPath: 'enc',
      decoderBytesOrPath: 'dec',
      jointBytesOrPath: 'joint',
      executionProviders: ['cpu'],
    });

    const pcm = new Float32Array(16000);
    const words = await tdtDecoder.transcribeWindow(pcm);

    expect(words).toHaveLength(2);
    expect(words[0].word).toBe('سلام');
    expect(words[0].relativeStartSec).toBe(0);
    expect(words[0].relativeEndSec).toBeCloseTo(0.08, 3);
    expect(words[1].word).toBe('تست');
    expect(words[1].relativeStartSec).toBeCloseTo(0.08, 3);
  });

  it('3. WhisperPlusCtcTwoStageAligner verbalizes Persian numerals and locks timestamps back to display token', async () => {
    const charVocab = new Map<string, number>([
      ['<blk>', 0],
      ['د', 1],
      ['و', 2],
      ['س', 3],
      ['ا', 4],
      ['ل', 5],
    ]);

    const mockOrt: OrtRuntimeProvider = {
      createTensor: (type, data, dims) => ({ type, data, dims }) as OrtTensorLike,
      createSession: async (): Promise<OrtSessionLike> => ({
        run: async () => {
          const T = 10;
          const V = 6;
          const logits = new Float32Array(T * V).fill(-10);
          const seq = [1, 1, 2, 2, 0, 3, 3, 4, 5, 5];
          for (let t = 0; t < T; t++) {
            logits[t * V + seq[t]] = 6.0;
          }
          return {
            logits: { type: 'float32', dims: [1, T, V], data: logits },
          };
        },
      }),
    };

    const aligner = new WhisperPlusCtcTwoStageAligner(mockOrt, charVocab, 0.02);
    await aligner.loadCtcAlignerModel('ctc_mock', ['cpu']);

    const alignedTokens = await aligner.reAlignWhisperSegments(new Float32Array(16000), [
      {
        segmentId: 'seg_0',
        startSec: 0,
        endSec: 0.5,
        rawTextFa: '۲ سال',
        avgConfidence: 0.94,
      },
    ]);

    expect(alignedTokens).toHaveLength(2);
    expect(alignedTokens[0].displayText).toBe('۲');
    expect(alignedTokens[1].displayText).toBe('سال');
    expect(alignedTokens[0].range.end).toBeLessThanOrEqual(alignedTokens[1].range.start);
  });

  it('4. SingleFlightReadThroughCache prevents DB stampedes under 50 concurrent requests and supports instant revocation', async () => {
    const cache = new SingleFlightReadThroughCache();
    let dbQueryExecutions = 0;

    const simulateDbLoad = async () => {
      dbQueryExecutions++;
      await new Promise((r) => setTimeout(r, 25));
      return { modelId: 'whisper-fa', status: 'ACTIVE' };
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        cache.getOrComputeSingleFlight('manifest:whisper-fa:1.2.0', 60_000, simulateDbLoad),
      ),
    );

    expect(dbQueryExecutions).toBe(1);
    expect(cache.coalescedRequestsSaved).toBe(49);
    expect(results.every((r) => r.status === 'ACTIVE')).toBe(true);

    const removedCount = cache.invalidateByPrefix('manifest:whisper-fa:');
    expect(removedCount).toBe(1);
  });
});
