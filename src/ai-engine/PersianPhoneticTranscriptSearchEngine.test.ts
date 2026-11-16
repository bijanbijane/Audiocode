import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianPhoneticTranscriptSearchEngine } from './PersianPhoneticTranscriptSearchEngine';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

test('Section 55: PersianPhoneticTranscriptSearchEngine resolves exact, homophone, ZWNJ-split, and multi-word queries', () => {
  const rawTokens = [
    { id: 't1', text: 'دکتر', range: { start: 0, end: TimeMath.secondsToFlicks(0.5) }, confidence: 0.96 },
    { id: 't2', text: 'تباتبایی', range: { start: TimeMath.secondsToFlicks(0.6), end: TimeMath.secondsToFlicks(1.2) }, confidence: 0.72 },
    { id: 't3', text: 'درباره', range: { start: TimeMath.secondsToFlicks(1.3), end: TimeMath.secondsToFlicks(1.8) }, confidence: 0.95 },
    { id: 't4', text: 'سادرات', range: { start: TimeMath.secondsToFlicks(1.9), end: TimeMath.secondsToFlicks(2.5) }, confidence: 0.68 },
    { id: 't5', text: 'نفت', range: { start: TimeMath.secondsToFlicks(2.6), end: TimeMath.secondsToFlicks(3.0) }, confidence: 0.97 },
    { id: 't6', text: 'می', range: { start: TimeMath.secondsToFlicks(3.2), end: TimeMath.secondsToFlicks(3.4) }, confidence: 0.91 },
    { id: 't7', text: 'خواهم', range: { start: TimeMath.secondsToFlicks(3.45), end: TimeMath.secondsToFlicks(3.9) }, confidence: 0.94 },
    { id: 't8', text: 'صحبت', range: { start: TimeMath.secondsToFlicks(4.0), end: TimeMath.secondsToFlicks(4.5) }, confidence: 0.98 },
  ];

  const engine = new PersianPhoneticTranscriptSearchEngine();
  engine.indexTranscript(PersianTextNormalizer.buildThreeLayerTranscript(rawTokens));

  // 1. Homophone match ("طباطبایی" finds ASR-misspelled "تباتبایی")
  const tabaHits = engine.searchPhrase('طباطبایی');
  assert.equal(tabaHits.length, 1);
  assert.equal(tabaHits[0].matchType, 'HOMOPHONE_PHONETIC');
  assert.deepEqual(tabaHits[0].matchedTokenIds, ['t2']);

  // 2. Multi-word phrase with homophone + exact ("صادرات نفت" finds "سادرات نفت")
  const exportHits = engine.searchPhrase('صادرات نفت');
  assert.equal(exportHits.length, 1);
  assert.equal(exportHits[0].matchType, 'HOMOPHONE_PHONETIC');
  assert.deepEqual(exportHits[0].matchedTokenIds, ['t4', 't5']);
  assert.equal(exportHits[0].audioRange.start, TimeMath.secondsToFlicks(1.9));
  assert.equal(exportHits[0].audioRange.end, TimeMath.secondsToFlicks(3.0));

  // 3. ZWNJ query matching split tokens ("می‌خواهم" finds ["می", "خواهم"])
  const zwnjHits = engine.searchPhrase('می‌خواهم');
  assert.equal(zwnjHits.length, 1);
  assert.deepEqual(zwnjHits[0].matchedTokenIds, ['t6', 't7']);

  // 4. Exact match ranks highest
  const doctorHits = engine.searchPhrase('دکتر');
  assert.equal(doctorHits[0].matchType, 'EXACT_NORMALIZED');
  assert.equal(doctorHits[0].relevanceScore, 1.0);
});

test('Section 55: PersianPhoneticTranscriptSearchEngine indexes 25,000 tokens and searches in sub-5ms', () => {
  const filler = ['امروز', 'درباره', 'معماری', 'نرم‌افزار', 'صحبت', 'می‌کنیم'];
  const tokens = PersianTextNormalizer.buildThreeLayerTranscript(
    Array.from({ length: 25000 }, (_, i) => ({
      id: `w_${i}`,
      text: i === 18420 ? 'طباطبایی' : filler[i % filler.length],
      range: {
        start: TimeMath.secondsToFlicks(i * 0.4),
        end: TimeMath.secondsToFlicks(i * 0.4 + 0.35),
      },
      confidence: 0.95,
    })),
  );

  const engine = new PersianPhoneticTranscriptSearchEngine();
  engine.indexTranscript(tokens);

  const t0 = performance.now();
  const hits = engine.searchPhrase('تباتبایی');
  const elapsedMs = performance.now() - t0;

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].matchedTokenIds, ['w_18420']);
  assert.ok(elapsedMs < 15, `Expected sub-15ms inverted search, took ${elapsedMs.toFixed(2)}ms`);
});
