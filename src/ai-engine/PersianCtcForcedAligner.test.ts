import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianCtcForcedAligner } from './PersianCtcForcedAligner';
import { TimeMath } from '../contracts/timebase.contract';

function makeFrameLogProbs(
  vocabSize: number,
  dominantId: number,
  dominantLogProb = -0.05,
  backgroundLogProb = -8.0,
): Float32Array {
  const row = new Float32Array(vocabSize).fill(backgroundLogProb);
  row[dominantId] = dominantLogProb;
  return row;
}

test('PersianCtcForcedAligner aligns Persian words to exact millisecond frames with chunk offset', () => {
  // Vocab: 0 = Blank (ε), 1 = س, 2 = ل, 3 = ا, 4 = م, 5 = ب, 6 = د
  const vocab = new Map<string, number>([
    ['س', 1],
    ['ل', 2],
    ['ا', 3],
    ['م', 4],
    ['ب', 5],
    ['د', 6],
  ]);
  const vocabSize = 7;

  // Frame duration = 0.02s (20ms). 12 frames = 240ms total.
  // Word 1 «سلام» occupies frames [1..6) => 20ms..120ms
  // Silence Blank Gap occupies frames [6..8)
  // Word 2 «باد» occupies frames [8..11) => 160ms..220ms
  const emissionPlan = [0, 1, 2, 3, 3, 4, 0, 0, 5, 3, 6, 0];
  const logProbs = emissionPlan.map((id) => makeFrameLogProbs(vocabSize, id));

  const offsetFlicks = TimeMath.secondsToFlicks(10.0);
  const result = PersianCtcForcedAligner.alignPersianWordsToAudio(
    logProbs,
    vocab,
    [
      { id: 'w1', text: 'سلام' },
      { id: 'w2', text: 'باد' },
    ],
    0.02,
    offsetFlicks,
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].wordText, 'سلام');
  assert.ok(
    Math.abs(TimeMath.flicksToSeconds(result[0].alignedRange.start - offsetFlicks) - 0.02) < 1e-6,
  );
  assert.ok(
    Math.abs(TimeMath.flicksToSeconds(result[0].alignedRange.end - offsetFlicks) - 0.12) < 1e-6,
  );

  assert.equal(result[1].wordText, 'باد');
  assert.ok(
    Math.abs(TimeMath.flicksToSeconds(result[1].alignedRange.start - offsetFlicks) - 0.16) < 1e-6,
  );
  assert.ok(
    Math.abs(TimeMath.flicksToSeconds(result[1].alignedRange.end - offsetFlicks) - 0.22) < 1e-6,
  );
  assert.ok(result[0].acousticConfidence > 0.9);
  assert.ok(result[1].acousticConfidence > 0.9);
});

test('PersianCtcForcedAligner enforces mandatory Blank Token (epsilon) between repeated adjacent Persian characters («مم»)', () => {
  // Vocab: 0 = Blank (ε), 1 = م, 2 = ن, 3 = و
  const vocab = new Map<string, number>([
    ['م', 1],
    ['ن', 2],
    ['و', 3],
  ]);
  const vocabSize = 4;

  // Word «ممنون» contains repeated 'م' followed by 'م' at start.
  // Frames emit: م (frame 0..2), mandatory Blank ε (frame 2), م (frame 3), ن (frame 4), و (frame 5), ن (frame 6)
  const emissionPlan = [1, 1, 0, 1, 2, 3, 2];
  const logProbs = emissionPlan.map((id) => makeFrameLogProbs(vocabSize, id));

  const { words, characterSpans } = PersianCtcForcedAligner.alignPersianWordsAndCharacters(
    logProbs,
    vocab,
    [{ id: 'w_mem', text: 'ممنون' }],
    0.02,
  );

  assert.equal(words.length, 1);
  assert.equal(characterSpans.length, 5);
  // First 'م' must end strictly at or before frame 2, and second 'م' must start strictly at frame 3 after Blank
  assert.equal(characterSpans[0].char, 'م');
  assert.equal(characterSpans[0].startFrame, 0);
  assert.equal(characterSpans[0].endFrame, 2);

  assert.equal(characterSpans[1].char, 'م');
  assert.equal(characterSpans[1].startFrame, 3);
  assert.equal(characterSpans[1].endFrame, 4);

  assert.equal(characterSpans[4].char, 'ن');
  assert.equal(characterSpans[4].startFrame, 6);
  assert.equal(characterSpans[4].endFrame, 7);
});

test('PersianCtcForcedAligner handles empty audio frames or empty words cleanly', () => {
  const vocab = new Map<string, number>([['س', 1]]);
  assert.deepEqual(PersianCtcForcedAligner.alignPersianWordsToAudio([], vocab, [{ id: 'w1', text: 'س' }]), []);
  assert.deepEqual(
    PersianCtcForcedAligner.alignPersianWordsToAudio([makeFrameLogProbs(2, 1)], vocab, []),
    [],
  );
});
