import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompactPersianLanguageModelScorer } from './CompactPersianLanguageModelScorer';

describe('Section 101: CompactPersianLanguageModelScorer (PLM1 Binary Format)', () => {
  it('trains from Persian corpus, serializes to PLM1 binary, reloads, and scores bigrams with Stupid Backoff', () => {
    const corpus = [
      'سلام به مخاطبان پادکست فارسی',
      'سلام به شنوندگان پادکست فارسی',
      'پادکست فارسی با کیفیت استودیویی',
      'ویرایش هوشمند پادکست فارسی در استودیو',
    ];

    const lm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(corpus, 1, 1);
    assert.equal(lm.isKnownPersianWord('پادکست'), true);
    assert.equal(lm.isKnownPersianWord('فارسی'), true);
    assert.equal(lm.isKnownPersianWord('ناشناخته۱۲۳'), false);

    // Bigram "پادکست" -> "فارسی" appears 4 times out of 4 occurrences of "پادکست"
    const bigramScore = lm.scoreWordTransitionLogProb('پادکست', 'فارسی');
    const backoffScore = lm.scoreWordTransitionLogProb('استودیو', 'فارسی');
    const unknownScore = lm.scoreWordTransitionLogProb('پادکست', 'کلمه‌ناموجود');

    assert.ok(bigramScore > backoffScore, 'Observed bigram should score higher than stupid backoff');
    assert.ok(backoffScore > unknownScore, 'Known unigram backoff should score higher than OOV');

    // Serialize & deserialize PLM1 binary
    const binary = lm.serializeToBinary();
    assert.ok(binary.byteLength > 20 && binary.byteLength < 4096);

    const reloaded = CompactPersianLanguageModelScorer.loadFromBinary(binary);
    assert.equal(reloaded.isKnownPersianWord('پادکست'), true);
    assert.ok(
      Math.abs(reloaded.scoreWordTransitionLogProb('پادکست', 'فارسی') - bigramScore) < 1e-5,
    );
  });
});
