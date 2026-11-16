import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianProsodicPunctuationRestorer } from './PersianProsodicPunctuationRestorer';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

test('Section 85: PersianProsodicPunctuationRestorer detects colloquial Persian question via F0 pitch rise without interrogative words', () => {
  const sr = 16000 as const;
  const pcm = new Float32Array(sr * 3);

  // Word 1: "فایل" [0.0s - 0.3s], Word 2: "رو" [0.35s - 0.55s], Word 3: "فرستادی" [0.6s - 1.1s]
  // Synthesize rising F0 on "فرستادی": first half [0.6s - 0.85s] at 130 Hz, second half [0.85s - 1.1s] at 185 Hz (~ +6.1 semitones)
  const w3Start = Math.floor(0.6 * sr);
  const w3Mid = Math.floor(0.85 * sr);
  const w3End = Math.floor(1.1 * sr);

  for (let i = w3Start; i < w3Mid; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * 130 * i) / sr);
  }
  for (let i = w3Mid; i < w3End; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * 185 * i) / sr);
  }

  // Second clause [1.7s - 3.0s]: declarative with comma before "اما"
  const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
    { id: 't1', text: 'فایل', range: { start: 0, end: TimeMath.secondsToFlicks(0.3) }, confidence: 0.98 },
    { id: 't2', text: 'رو', range: { start: TimeMath.secondsToFlicks(0.35), end: TimeMath.secondsToFlicks(0.55) }, confidence: 0.98 },
    { id: 't3', text: 'فرستادی', range: { start: TimeMath.secondsToFlicks(0.6), end: TimeMath.secondsToFlicks(1.1) }, confidence: 0.98 },
    // 600ms pause -> end of first sentence
    { id: 't4', text: 'من', range: { start: TimeMath.secondsToFlicks(1.7), end: TimeMath.secondsToFlicks(1.9) }, confidence: 0.98 },
    { id: 't5', text: 'منتظر', range: { start: TimeMath.secondsToFlicks(1.95), end: TimeMath.secondsToFlicks(2.15) }, confidence: 0.98 },
    { id: 't6', text: 'بودم', range: { start: TimeMath.secondsToFlicks(2.2), end: TimeMath.secondsToFlicks(2.4) }, confidence: 0.98 },
    // Next token is "اما" -> should insert Persian comma "،" on "بودم"
    { id: 't7', text: 'اما', range: { start: TimeMath.secondsToFlicks(2.45), end: TimeMath.secondsToFlicks(2.6) }, confidence: 0.98 },
    { id: 't8', text: 'نرسید', range: { start: TimeMath.secondsToFlicks(2.65), end: TimeMath.secondsToFlicks(2.95) }, confidence: 0.98 },
  ]);

  const punctuated = PersianProsodicPunctuationRestorer.restorePunctuationInDisplayLayer(
    tokens,
    pcm,
    sr,
  );

  assert.equal(punctuated[2].displayText, 'فرستادی؟');
  assert.equal(punctuated[2].originalText, 'فرستادی'); // Layer 1 remains immutable
  assert.equal(punctuated[5].displayText, 'بودم،');
  assert.equal(punctuated[7].displayText, 'نرسید.');
});
