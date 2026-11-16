import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SentencePieceSubwordCtcMapper,
  WhisperCppAsrAdapter,
} from './SentencePieceAndWhisperBridge';

describe('Section 104: SentencePieceSubwordCtcMapper & WhisperCppAsrAdapter', () => {
  it('groups SentencePiece subwords (▁) while preserving Persian ZWNJ and exact frame spans', () => {
    const vocab = ['<blank>', '\u2581سلام', '\u2581می', '\u200c', 'خوا', 'هم'];
    const mapper = new SentencePieceSubwordCtcMapper(vocab, 0);

    const makeFrame = (activeId: number) => {
      const f = new Float32Array(vocab.length).fill(-10);
      f[activeId] = -0.05;
      return f;
    };

    const frames = [
      makeFrame(0), // blank
      makeFrame(1), // ▁سلام (t=1..2)
      makeFrame(1),
      makeFrame(0),
      makeFrame(2), // ▁می (t=4)
      makeFrame(3), // ZWNJ (t=5)
      makeFrame(4), // خوا (t=6)
      makeFrame(5), // هم (t=7)
    ];

    const decoded = mapper.decodeSubwordMatrixToWords(frames, 0.04);
    assert.equal(decoded.fullText, 'سلام می‌خواهم');
    assert.equal(decoded.words.length, 2);
    assert.equal(decoded.words[0].word, 'سلام');
    assert.equal(decoded.words[0].relativeStartSec, 0.04);
    assert.equal(decoded.words[0].relativeEndSec, 0.12);
    assert.equal(decoded.words[1].word, 'می‌خواهم');
    assert.equal(decoded.words[1].relativeStartSec, 0.16);
    assert.equal(decoded.words[1].relativeEndSec, 0.32);
  });

  it('merges whisper.cpp BPE sub-tokens and filters non-speech markers', async () => {
    const adapter = new WhisperCppAsrAdapter(
      {
        async transcribe16kFloat32() {
          return {
            tokens: [
              { text: ' پاد', t0Ms: 120, t1Ms: 280, probability: 0.92 },
              { text: 'کست', t0Ms: 280, t1Ms: 460, probability: 0.96 },
              { text: ' فارسی', t0Ms: 500, t1Ms: 850, probability: 0.95 },
              { text: ' [موسیقی]', t0Ms: 900, t1Ms: 1200, probability: 0.8 },
            ],
          };
        },
      },
      async () => ({ hasSpeech: true, speechRatio: 0.88 }),
    );

    const words = await adapter.transcribeWindow(new Float32Array(16000));
    assert.equal(words.length, 2);
    assert.equal(words[0].word, 'پادکست');
    assert.equal(words[0].relativeStartSec, 0.12);
    assert.equal(words[0].relativeEndSec, 0.46);
    assert.equal(words[1].word, 'فارسی');
  });
});
