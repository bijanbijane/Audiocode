import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianColloquialAndDialectNormalizer } from './PersianColloquialAndDialectNormalizer';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

test('Section 86: PersianColloquialAndDialectNormalizer maps colloquial verbs, clitics, and vowel shifts to formal Persian while preserving originalText', () => {
  const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
    { id: 'c1', text: 'اونا', range: { start: 0, end: TimeMath.secondsToFlicks(0.4) }, confidence: 0.96 },
    { id: 'c2', text: 'می‌خوان', range: { start: TimeMath.secondsToFlicks(0.45), end: TimeMath.secondsToFlicks(0.9) }, confidence: 0.97 },
    { id: 'c3', text: 'خونه‌شون', range: { start: TimeMath.secondsToFlicks(0.95), end: TimeMath.secondsToFlicks(1.4) }, confidence: 0.95 },
    { id: 'c4', text: 'رو', range: { start: TimeMath.secondsToFlicks(1.45), end: TimeMath.secondsToFlicks(1.65) }, confidence: 0.98 },
    { id: 'c5', text: 'بفروشن', range: { start: TimeMath.secondsToFlicks(1.7), end: TimeMath.secondsToFlicks(2.2) }, confidence: 0.96 },
  ]);

  const enriched = PersianColloquialAndDialectNormalizer.enrichTranscriptWithFormalLayer(
    tokens,
    true,
  );

  assert.equal(enriched[0].formalStandardEquivalent, 'آن\u200cها');
  assert.equal(enriched[0].originalText, 'اونا'); // Layer 1 untouched
  assert.equal(enriched[1].formalStandardEquivalent, 'می\u200cخواهند');
  assert.equal(enriched[2].formalStandardEquivalent, 'خانه\u200cشان');
  assert.equal(enriched[3].formalStandardEquivalent, 'را');
  assert.equal(enriched[0].displayText, 'آن\u200cها');

  const pluralCheck = PersianColloquialAndDialectNormalizer.convertWordToFormalStandard('کتابامون');
  assert.equal(pluralCheck.formalWord, 'کتاب\u200cهایمان');
  assert.equal(pluralCheck.converted, true);
});
