import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompactPersianLanguageModelScorer } from './CompactPersianLanguageModelScorer';
import { PersianPhoneticConfusionCorrector } from './PersianPhoneticConfusionCorrector';
import { PersianTextNormalizer } from '../PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

describe('Section 125: PersianPhoneticConfusionCorrector', () => {
  it('corrects homophone confusion using bilateral LM rescoring while keeping originalText untouched', () => {
    const lm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(
      [
        'ثبت نام در سامانه انجام شد',
        'ثبت نام کاربران جدید آغاز گردید',
        'فرایند ثبت نام سریع است',
      ],
      1,
      1,
    );

    const corrector = new PersianPhoneticConfusionCorrector(
      lm,
      ['ثبت', 'سامانه'],
      [{ confusedForm: 'سبت', intendedForm: 'ثبت', empiricalPriorBonus: 1.5 }],
    );

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 't1',
        text: 'فرایند',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.4) },
        confidence: 0.95,
      },
      {
        id: 't2',
        text: 'سبت',
        range: { start: TimeMath.secondsToFlicks(0.45), end: TimeMath.secondsToFlicks(0.8) },
        confidence: 0.72,
      },
      {
        id: 't3',
        text: 'نام',
        range: { start: TimeMath.secondsToFlicks(0.85), end: TimeMath.secondsToFlicks(1.2) },
        confidence: 0.94,
      },
    ]);

    const res = corrector.correctTranscriptWithContextRescoring(tokens);
    assert.equal(res.appliedCorrections.length, 1);
    assert.equal(res.correctedTokens[1].displayText, 'ثبت');
    assert.equal(res.correctedTokens[1].originalText, 'سبت');
  });
});
