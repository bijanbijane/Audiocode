import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordTimingsFromTokens } from '../LocalSherpaNeuralEngine';

test('SHAHAB uses native CTC token durations for word ends instead of stretching the final word to the chunk boundary', () => {
  const words = buildWordTimingsFromTokens(
    ['▁سلام', '▁دنیا', '▁خوب'],
    [0.1, 0.6, 1.0],
    [0.32, 0.28, 0.4],
    5,
    10,
  );

  assert.deepEqual(words, [
    { word: 'سلام', startSec: 5.1, endSec: 5.42 },
    { word: 'دنیا', startSec: 5.6, endSec: 5.88 },
    { word: 'خوب', startSec: 6, endSec: 6.4 },
  ]);
  assert.ok(words.at(-1)!.endSec < 10, 'the last word must end at its acoustic token duration, not at chunk end');
});

test('SHAHAB combines SentencePiece continuation tokens and preserves measured acoustic spans', () => {
  const words = buildWordTimingsFromTokens(
    ['▁آوا', 'پرداز', '▁فارس', 'ی'],
    [0.2, 0.31, 0.8, 0.94],
    [0.11, 0.16, 0.14, 0.10],
    2,
    8,
  );

  assert.deepEqual(words, [
    { word: 'آواپرداز', startSec: 2.2, endSec: 2.47 },
    { word: 'فارسی', startSec: 2.8, endSec: 3.04 },
  ]);
});

test('SHAHAB refuses fabricated word timing when native CTC durations are absent or invalid', () => {
  assert.deepEqual(buildWordTimingsFromTokens(['▁سلام'], [0.1], undefined, 0, 10), []);
  assert.deepEqual(buildWordTimingsFromTokens(['▁سلام'], [0.1], [0], 0, 10), []);
  assert.deepEqual(buildWordTimingsFromTokens(['▁سلام'], [Number.NaN], [0.2], 0, 10), []);
  assert.deepEqual(buildWordTimingsFromTokens(['▁سلام'], [0.1, 0.2], [0.2], 0, 10), []);
});
