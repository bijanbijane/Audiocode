import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomPersianLexiconManager } from './CustomPersianLexiconManager';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

test('CustomPersianLexiconManager resolves Persian homophones via Phonetic Skeleton while preserving originalText', () => {
  const mgr = new CustomPersianLexiconManager();
  mgr.registerLexiconEntries([
    {
      entryId: 'lex-tabatabaei',
      canonicalDisplayForm: 'طباطبایی',
      phoneticAliases: ['تباتبایی'],
      category: 'PERSON_NAME',
    },
    {
      entryId: 'lex-typescript',
      canonicalDisplayForm: 'تایپ‌اسکریپت',
      phoneticAliases: ['تایپ اسکریپ', 'تایپ اسکریپت'],
      category: 'TECHNICAL_TERM',
    },
  ]);

  assert.equal(
    CustomPersianLexiconManager.toPersianPhoneticSkeleton('طباطبایی'),
    CustomPersianLexiconManager.toPersianPhoneticSkeleton('تباتبایی'),
  );

  const tokens = [
    PersianTextNormalizer.createToken({
      tokenId: 't1',
      trackId: 'track-1',
      originalText: 'دکتر',
      startFlicks: 0,
      endFlicks: TimeMath.secondsToFlicks(0.4),
      confidence: 0.97,
    }),
    PersianTextNormalizer.createToken({
      tokenId: 't2',
      trackId: 'track-1',
      originalText: 'تباتبایی', // ASR homophone misspelling
      startFlicks: TimeMath.secondsToFlicks(0.45),
      endFlicks: TimeMath.secondsToFlicks(0.95),
      confidence: 0.62,
    }),
    PersianTextNormalizer.createToken({
      tokenId: 't3',
      trackId: 'track-1',
      originalText: 'تایپ‌اسکریپ', // Missing final 'ت', high-ish confidence 0.81 still corrected by lexicon
      startFlicks: TimeMath.secondsToFlicks(1.0),
      endFlicks: TimeMath.secondsToFlicks(1.6),
      confidence: 0.81,
    }),
    PersianTextNormalizer.createToken({
      tokenId: 't4',
      trackId: 'track-1',
      originalText: 'نامشخص',
      startFlicks: TimeMath.secondsToFlicks(1.7),
      endFlicks: TimeMath.secondsToFlicks(2.1),
      confidence: 0.55, // Generic uncertain token below 0.75 threshold
    }),
  ];

  const suggestions = mgr.findUncertainWordsAndSuggestCorrections(tokens, 0.75);
  assert.equal(suggestions.length, 3);

  const sugT2 = suggestions.find((s) => s.tokenId === 't2');
  const sugT3 = suggestions.find((s) => s.tokenId === 't3');
  const sugT4 = suggestions.find((s) => s.tokenId === 't4');

  assert.equal(sugT2?.suggestedReplacement, 'طباطبایی');
  assert.equal(sugT2?.matchedLexiconEntryId, 'lex-tabatabaei');
  assert.equal(sugT3?.suggestedReplacement, 'تایپ‌اسکریپت');
  assert.equal(sugT3?.matchedLexiconEntryId, 'lex-typescript');
  assert.equal(sugT4?.matchedLexiconEntryId, undefined);

  const { tokens: updated, appliedCount } = mgr.applyBatchLexiconCorrectionsNonDestructively(
    tokens,
    0.75,
  );
  assert.equal(appliedCount, 2);
  // Display updated to canonical spelling while ASR originalText remains 100% immutable!
  assert.equal(updated[1].displayText, 'طباطبایی');
  assert.equal(updated[1].originalText, 'تباتبایی');
  assert.equal(updated[2].displayText, 'تایپ‌اسکریپت');
  assert.equal(updated[2].originalText, 'تایپ‌اسکریپ');
});
