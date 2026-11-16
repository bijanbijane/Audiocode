import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersianPostAsrSpellingAndCompoundRestorer } from './PersianPostAsrSpellingAndCompoundRestorer';
import { PersianTextNormalizer } from '../PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

describe('Section 110: PersianPostAsrSpellingAndCompoundRestorer', () => {
  it('merges contiguous compounds, ZWNJ prefixes/suffixes, and bilingual terms while skipping tokens separated by > 180ms pause', () => {
    const restorer = new PersianPostAsrSpellingAndCompoundRestorer();
    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 't1',
        text: 'فست',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.25) },
        confidence: 0.9,
      },
      {
        id: 't2',
        text: 'ای',
        range: { start: TimeMath.secondsToFlicks(0.28), end: TimeMath.secondsToFlicks(0.45) },
        confidence: 0.92,
      },
      {
        id: 't3',
        text: 'پی',
        range: { start: TimeMath.secondsToFlicks(0.48), end: TimeMath.secondsToFlicks(0.65) },
        confidence: 0.94,
      },
      {
        id: 't4',
        text: 'آی',
        range: { start: TimeMath.secondsToFlicks(0.68), end: TimeMath.secondsToFlicks(0.85) },
        confidence: 0.96,
      },
      {
        id: 't5',
        text: 'می',
        range: { start: TimeMath.secondsToFlicks(1.0), end: TimeMath.secondsToFlicks(1.2) },
        confidence: 0.95,
      },
      {
        id: 't6',
        text: 'سازیم',
        range: { start: TimeMath.secondsToFlicks(1.25), end: TimeMath.secondsToFlicks(1.6) },
        confidence: 0.95,
      },
      // Separated by 600ms real pause -> must NOT merge
      {
        id: 't7',
        text: 'کتاب',
        range: { start: TimeMath.secondsToFlicks(2.0), end: TimeMath.secondsToFlicks(2.4) },
        confidence: 0.95,
      },
      {
        id: 't8',
        text: 'خانه',
        range: { start: TimeMath.secondsToFlicks(3.0), end: TimeMath.secondsToFlicks(3.4) },
        confidence: 0.95,
      },
    ]);

    const out = restorer.restoreCompoundsAndBilingualTerms(tokens, 180);
    assert.equal(out.length, 4);
    assert.equal(out[0].displayText, 'FastAPI');
    assert.equal(out[0].originalText, 'فست ای پی آی');
    assert.equal(out[1].displayText, 'می\u200cسازیم');
    assert.equal(out[2].displayText, 'کتاب');
    assert.equal(out[3].displayText, 'خانه');
  });
});
