import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianSemanticRepetitionEngine } from './PersianSemanticRepetitionEngine';
import { PersianTextNormalizer, TimedPersianToken } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

function makeTokensForPhrase(
  words: string[],
  startSec: number,
  trackId = 'track-host',
  prefix = 'tok',
): TimedPersianToken[] {
  return words.map((w, i) =>
    PersianTextNormalizer.createToken({
      tokenId: `${prefix}_${i}`,
      trackId,
      originalText: w,
      startFlicks: TimeMath.secondsToFlicks(startSec + i * 0.25),
      endFlicks: TimeMath.secondsToFlicks(startSec + (i + 0.8) * 0.25),
      confidence: 0.94,
    }),
  );
}

test('PersianSemanticRepetitionEngine detects paraphrased Persian retake after pause and preserves second take', () => {
  const take1 = makeTokensForPhrase(
    ['امروز', 'می‌خواهیم', 'درباره', 'ساختارهای', 'نرم‌افزاری', 'بگوییم'],
    0.0,
    'track-host',
    't1',
  );
  // 800ms pause between take1 end and take2 start
  const take2 = makeTokensForPhrase(
    ['امروز', 'درباره', 'ساختار', 'نرم‌افزار', 'صحبت', 'می‌کنیم'],
    2.3,
    'track-host',
    't2',
  );

  const candidates = PersianSemanticRepetitionEngine.detectSemanticRetakes([...take1, ...take2]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].trackId, 'track-host');
  assert.equal(candidates[0].firstTakeDeleteRange.start, take1[0].range.start);
  assert.equal(candidates[0].firstTakeDeleteRange.end, take2[0].range.start);
  assert.equal(candidates[0].secondTakeKeepRange.start, take2[0].range.start);
  assert.ok(candidates[0].semanticSimilarityScore >= 0.54);
});

test('PersianSemanticRepetitionEngine avoids false positives across distinct topics or different speakers', () => {
  const distinct1 = makeTokensForPhrase(
    ['دمای', 'تهران', 'امروز', 'بسیار', 'معتدل', 'بود'],
    0.0,
    'track-host',
    'd1',
  );
  const distinct2 = makeTokensForPhrase(
    ['کیفیت', 'میکروفون', 'استودیو', 'صدای', 'تمیز', 'ضبط', 'کرد'],
    2.5,
    'track-host',
    'd2',
  );
  assert.equal(
    PersianSemanticRepetitionEngine.detectSemanticRetakes([...distinct1, ...distinct2]).length,
    0,
  );

  // Different speakers discussing identical keywords must NOT be merged or deleted as self-retake
  const hostLine = makeTokensForPhrase(
    ['معماری', 'نرم‌افزار', 'پادکست', 'بسیار', 'مهم', 'است'],
    0.0,
    'track-host',
    'h',
  );
  const guestLine = makeTokensForPhrase(
    ['معماری', 'نرم‌افزار', 'پادکست', 'واقعاً', 'مهم', 'است'],
    3.0,
    'track-guest',
    'g',
  );
  assert.equal(
    PersianSemanticRepetitionEngine.detectSemanticRetakes([...hostLine, ...guestLine]).length,
    0,
  );
});

test('PersianSemanticRepetitionEngine stems Persian prefixes/suffixes without over-stripping short words', () => {
  assert.equal(PersianSemanticRepetitionEngine.stemPersianWord('می‌خواهیم'), 'خواه');
  assert.equal(PersianSemanticRepetitionEngine.stemPersianWord('کتاب‌هایشان'), 'کتاب');
  assert.equal(PersianSemanticRepetitionEngine.stemPersianWord('برنامه'), 'برنامه');
  assert.ok(PersianSemanticRepetitionEngine.stemPersianWord('ام').length >= 2);
});
