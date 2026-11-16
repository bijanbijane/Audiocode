import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTrailingEzafeRisk, normalizePersianText } from './persianText';
import { PersianWordToken } from '../contracts/v1_2';
import { secondsToFlicks } from './timebase';

test('normalizePersianText preserves original and applies Yeh/Kaf, ZWNJ, and Persian digits', () => {
  const input = 'مي خواهم كتاب هاي 2026 را بخوانم';
  const res = normalizePersianText(input);
  assert.equal(res.original, input);
  assert.equal(res.normalized, 'می\u200cخواهم کتاب\u200cهای 2026 را بخوانم');
  assert.equal(res.display, 'می\u200cخواهم کتاب\u200cهای ۲۰۲۶ را بخوانم');
});

test('assessTrailingEzafeRisk flags headword before closely coupled modifier deletion', () => {
  const tokens: PersianWordToken[] = [
    {
      id: 'w1',
      trackId: 't1',
      speakerName: 'سارا',
      originalText: 'پادکست',
      normalizedText: 'پادکست',
      displayText: 'پادکست',
      range: { startFlicks: secondsToFlicks(1.0), endFlicks: secondsToFlicks(1.5) },
      confidence: 0.94,
      alignmentSource: 'ForcedAlignment',
      hasTrailingEzafeRisk: true,
    },
    {
      id: 'w2',
      trackId: 't1',
      speakerName: 'سارا',
      originalText: 'جذاب',
      normalizedText: 'جذاب',
      displayText: 'جذاب',
      range: { startFlicks: secondsToFlicks(1.52), endFlicks: secondsToFlicks(1.95) },
      confidence: 0.91,
      alignmentSource: 'ForcedAlignment',
    },
  ];

  const check = assessTrailingEzafeRisk(tokens, 1);
  assert.equal(check.hasRisk, true);
  assert.equal(check.headword, 'پادکست');
});
