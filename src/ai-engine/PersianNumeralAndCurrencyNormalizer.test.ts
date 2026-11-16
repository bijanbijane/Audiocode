import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersianNumeralAndCurrencyNormalizer } from './PersianNumeralAndCurrencyNormalizer';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

describe('PersianNumeralAndCurrencyNormalizer (Sections 26 & 27)', () => {
  it('converts numbers to standard spoken Persian words for CTC forced alignment', () => {
    assert.equal(
      PersianNumeralAndCurrencyNormalizer.numberToPersianSpokenWords(1405),
      'هزار و چهارصد و پنج',
    );
    assert.equal(
      PersianNumeralAndCurrencyNormalizer.numberToPersianSpokenWords(250_000_000),
      'دویست و پنجاه میلیون',
    );
  });

  it('formats spoken colloquial years and currency into Persian numerals in Display layer while preserving originalText and TimeRange', () => {
    const rawWords = ['سال', 'هزار', 'و', 'چهارصد', 'و', 'پنج', 'مبلغ', 'پونصد', 'میلیون', 'تومن'];
    const rawTokens = rawWords.map((w, idx) => ({
      id: `t_${idx}`,
      text: w,
      range: {
        start: TimeMath.secondsToFlicks(idx * 0.5),
        end: TimeMath.secondsToFlicks(idx * 0.5 + 0.4),
      },
      confidence: 0.95,
    }));

    const threeLayer = PersianTextNormalizer.buildThreeLayerTranscript(rawTokens);
    const formatted =
      PersianNumeralAndCurrencyNormalizer.formatSpokenNumbersInDisplayLayer(threeLayer);

    assert.equal(formatted.length, 4); // ['سال', '۱۴۰۵', 'مبلغ', '۵۰۰٬۰۰۰٬۰۰۰ تومان']
    assert.equal(formatted[1].displayText, '۱۴۰۵');
    assert.equal(formatted[1].originalText, 'هزار و چهارصد و پنج');
    assert.equal(formatted[1].range.start, TimeMath.secondsToFlicks(0.5));
    assert.equal(formatted[1].range.end, TimeMath.secondsToFlicks(2.5 + 0.4));

    assert.equal(formatted[3].displayText, '۵۰۰٬۰۰۰٬۰۰۰ تومان');
    assert.equal(formatted[3].originalText, 'پونصد میلیون تومن');
  });
});
