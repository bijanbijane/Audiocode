import test from 'node:test';
import assert from 'node:assert/strict';
import { ScriptToAudioDeviationDetector } from './ScriptToAudioDeviationDetector';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

test('Section 66: ScriptToAudioDeviationDetector detects OMITTED_FROM_BOOK, NARRATOR_MISREAD_WORD, and EXTRA_SPOKEN_RETAKE while ignoring homophone ASR spellings', () => {
  // Manuscript contains "طباطبایی" (spelled with ط) and "فصل" and "اول" and "کتاب"
  const referenceManuscript = 'دکتر طباطبایی فصل اول کتاب صوتی را خواند';

  // Spoken ASR has:
  // - "تباتبایی" (homophone spelling of طباطبایی -> should NOT be flagged as misread!)
  // - omits "اول" (OMITTED_FROM_BOOK)
  // - misreads "کتاب" as "مجله" (NARRATOR_MISREAD_WORD)
  // - adds extra retake word "اممم" at the end (EXTRA_SPOKEN_RETAKE)
  const spokenTokens = PersianTextNormalizer.buildThreeLayerTranscript([
    { id: 'w1', text: 'دکتر', range: { start: 0, end: TimeMath.secondsToFlicks(0.4) }, confidence: 0.98 },
    { id: 'w2', text: 'تباتبایی', range: { start: TimeMath.secondsToFlicks(0.5), end: TimeMath.secondsToFlicks(1.1) }, confidence: 0.82 },
    { id: 'w3', text: 'فصل', range: { start: TimeMath.secondsToFlicks(1.2), end: TimeMath.secondsToFlicks(1.6) }, confidence: 0.97 },
    { id: 'w4', text: 'مجله', range: { start: TimeMath.secondsToFlicks(1.7), end: TimeMath.secondsToFlicks(2.2) }, confidence: 0.95 },
    { id: 'w5', text: 'صوتی', range: { start: TimeMath.secondsToFlicks(2.3), end: TimeMath.secondsToFlicks(2.7) }, confidence: 0.96 },
    { id: 'w6', text: 'را', range: { start: TimeMath.secondsToFlicks(2.8), end: TimeMath.secondsToFlicks(3.0) }, confidence: 0.99 },
    { id: 'w7', text: 'خواند', range: { start: TimeMath.secondsToFlicks(3.1), end: TimeMath.secondsToFlicks(3.6) }, confidence: 0.97 },
    { id: 'w8', text: 'بارها', range: { start: TimeMath.secondsToFlicks(3.7), end: TimeMath.secondsToFlicks(4.1) }, confidence: 0.91 },
  ]);

  const deviations = ScriptToAudioDeviationDetector.detectNarratorDeviations(
    referenceManuscript,
    spokenTokens,
  );

  // Homophone "طباطبایی" vs "تباتبایی" must NOT appear in deviations
  assert.equal(
    deviations.some((d) => d.expectedBookText === 'طباطبایی' || d.actualSpokenText === 'تباتبایی'),
    false,
  );

  const omitted = deviations.find((d) => d.kind === 'OMITTED_FROM_BOOK');
  assert.ok(omitted);
  assert.equal(omitted!.expectedBookText, 'اول');

  const misread = deviations.find((d) => d.kind === 'NARRATOR_MISREAD_WORD');
  assert.ok(misread);
  assert.equal(misread!.expectedBookText, 'کتاب');
  assert.equal(misread!.actualSpokenText, 'مجله');

  const extra = deviations.find((d) => d.kind === 'EXTRA_SPOKEN_RETAKE');
  assert.ok(extra);
  assert.equal(extra!.actualSpokenText, 'بارها');
});
