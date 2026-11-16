import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianCtcPrefixBeamSearchDecoder } from './PersianCtcPrefixBeamSearchDecoder';

test('Section 98: PersianCtcPrefixBeamSearchDecoder resolves homophone spelling using Persian LM scorer and extracts word timestamps', () => {
  // Vocabulary: 0:<blk>, 1:' ', 2:'س', 3:'ل', 4:'ا', 5:'م', 6:'ص', 7:'د', 8:'ا'
  const vocab = ['<blk>', ' ', 'س', 'ل', 'ا', 'م', 'ص', 'د'];
  const decoder = new PersianCtcPrefixBeamSearchDecoder(vocab, 0, ' ', {
    scoreWordTransitionLogProb: (_prev, word) => (word === 'سلام' || word === 'صدا' ? -0.2 : -6.0),
    isKnownPersianWord: (w) => w === 'سلام' || w === 'صدا',
  });

  // Sequence for "سلام صدا":
  // Frame 0: 'س'(2) or 'ص'(6) with close acoustic probabilities (-0.7 vs -0.65)
  // Frames 1: 'ل'(3), 2: 'ا'(4), 3: 'م'(5), 4: ' '(1), 5: 'ص'(6), 6: 'د'(7), 7: 'ا'(4)
  const makeFrame = (probs: Record<number, number>): Float32Array => {
    const arr = new Float32Array(vocab.length).fill(-12.0);
    for (const [idxStr, val] of Object.entries(probs)) {
      arr[Number(idxStr)] = val;
    }
    return arr;
  };

  const frames: Float32Array[] = [
    makeFrame({ 2: -0.7, 6: -0.65 }), // Ambiguous 'س' vs 'ص' -> LM should pick 'سلام' over 'صلام'
    makeFrame({ 3: -0.05 }),
    makeFrame({ 4: -0.05 }),
    makeFrame({ 5: -0.05 }),
    makeFrame({ 1: -0.05 }),
    makeFrame({ 6: -0.05 }),
    makeFrame({ 7: -0.05 }),
    makeFrame({ 4: -0.05 }),
  ];

  const decoded = decoder.decodeWithWordTimestamps({
    logProbsPerFrame: frames,
    frameDurationSec: 0.04,
    beamWidth: 12,
    lmAlpha: 1.0,
  });

  assert.equal(decoded.bestTranscript, 'سلام صدا');
  assert.equal(decoded.words.length, 2);
  assert.equal(decoded.words[0].word, 'سلام');
  assert.equal(decoded.words[1].word, 'صدا');
  assert.ok(decoded.words[1].relativeStartSec >= decoded.words[0].relativeEndSec);
});
