import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { PersianDisfluencyEngine } from './PersianDisfluencyEngine';
import { TimeMath } from '../contracts/timebase.contract';

function makeToken(id: string, text: string, startSec: number, endSec: number, confidence = 0.94) {
  return PersianTextNormalizer.createToken({
    tokenId: id,
    trackId: 'track-1',
    originalText: text,
    startFlicks: TimeMath.secondsToFlicks(startSec),
    endFlicks: TimeMath.secondsToFlicks(endSec),
    confidence,
  });
}

test('Self-Repair deletes Reparandum + multi-token Interregnum and preserves final Repair', () => {
  const tokens = [
    makeToken('t1', 'ما', 0.0, 0.2),
    makeToken('t2', 'دیروز', 0.25, 0.55),
    makeToken('t3', 'رفتیم', 0.6, 0.95),
    makeToken('t4', 'به', 0.98, 1.12),
    makeToken('t5', 'اممم', 1.25, 1.55),
    makeToken('t6', 'ااا', 1.6, 1.8),
    makeToken('t7', 'رفتیم', 1.9, 2.2),
    makeToken('t8', 'به', 2.24, 2.38),
    makeToken('t9', 'شرکت', 2.42, 2.85),
  ];

  const issues = PersianDisfluencyEngine.analyzeTranscript(tokens);
  const rep = issues.find((i) => i.type === 'WORD_REPETITION');
  assert.ok(rep, 'Expected WORD_REPETITION self-repair issue');
  assert.deepEqual(rep.affectedTokenIds, ['t3', 't4', 't5', 't6']);
  assert.equal(rep.targetRange.start, tokens[2].range.start);
  assert.equal(rep.targetRange.end, tokens[5].range.end);
  // Ensure Repair ('t7', 't8', 't9') is NOT marked for deletion
  assert.equal(issues.some((i) => i.affectedTokenIds.includes('t7')), false);
});

test('N-gram self-repair handles connector words like «من و» inside multi-word phrase', () => {
  const tokens = [
    makeToken('t1', 'من', 0.0, 0.2),
    makeToken('t2', 'و', 0.22, 0.3),
    makeToken('t3', 'ام', 0.4, 0.6),
    makeToken('t4', 'من', 0.7, 0.9),
    makeToken('t5', 'و', 0.92, 1.0),
    makeToken('t6', 'سارا', 1.05, 1.4),
  ];

  const issues = PersianDisfluencyEngine.analyzeTranscript(tokens);
  const rep = issues.find((i) => i.type === 'WORD_REPETITION');
  assert.ok(rep);
  assert.deepEqual(rep.affectedTokenIds, ['t1', 't2', 't3']);
});

test('Isolated Persian discourse filler surrounded by pauses is detected', () => {
  const tokens = [
    makeToken('t1', 'امروز', 0.0, 0.3),
    makeToken('t2', 'راستش', 0.6, 0.9),
    makeToken('t3', 'رو', 0.92, 1.05),
    makeToken('t4', 'بخواید', 1.08, 1.4),
    makeToken('t5', 'سخت', 1.7, 2.0),
    makeToken('t6', 'بود', 2.05, 2.3),
  ];

  const issues = PersianDisfluencyEngine.analyzeTranscript(tokens);
  const filler = issues.find((i) => i.issueId.startsWith('disc_'));
  assert.ok(filler, 'Expected isolated discourse filler detection');
  assert.deepEqual(filler.affectedTokenIds, ['t2', 't3', 't4']);
});

test('Mid-clause pause after «که» triggers at >450ms while sentence-end pause waits until >950ms', () => {
  const tokens = [
    makeToken('t1', 'گفتم', 0.0, 0.3),
    makeToken('t2', 'که', 0.35, 0.5),
    // 650ms mid-clause pause after 'که' -> should trigger and trim to 150ms
    makeToken('t3', 'برنامه', 1.15, 1.55),
    makeToken('t4', 'آماده', 1.6, 1.95),
    makeToken('t5', 'شد', 2.0, 2.25),
    // 650ms sentence-end pause -> should NOT trigger (< 950ms)
    makeToken('t6', 'اما', 2.9, 3.15),
    makeToken('t7', 'فردا', 3.2, 3.5),
    // 1200ms sentence-end pause -> should trigger and trim to 400ms
    makeToken('t8', 'می‌آییم', 4.7, 5.15),
  ];

  const issues = PersianDisfluencyEngine.analyzeTranscript(tokens);
  const pauses = issues.filter((i) => i.type === 'LONG_PAUSE');
  assert.equal(pauses.length, 2);
  assert.equal(pauses[0].issueId, 'pause_t2_t3');
  assert.ok(Math.abs(TimeMath.flicksToSeconds(pauses[0].suggestedRemainingPauseFlicks) - 0.15) < 1e-6);
  assert.equal(pauses[1].issueId, 'pause_t7_t8');
  assert.ok(Math.abs(TimeMath.flicksToSeconds(pauses[1].suggestedRemainingPauseFlicks) - 0.4) < 1e-6);
});

test('Detects ZWNJ-joined discourse filler «به‌اصطلاح» and direct single-word repetition without interregnum', () => {
  const tokens = [
    makeToken('t1', 'این', 0.0, 0.2),
    makeToken('t2', 'به‌اصطلاح', 0.5, 0.9),
    makeToken('t3', 'موضوع', 1.2, 1.5),
    makeToken('t4', 'خیلی', 1.55, 1.8),
    makeToken('t5', 'خیلی', 1.85, 2.1),
    makeToken('t6', 'مهمه', 2.15, 2.5),
  ];

  const issues = PersianDisfluencyEngine.analyzeTranscript(tokens);
  const disc = issues.find((i) => i.issueId === 'disc_t2');
  const rep = issues.find((i) => i.issueId === 'rep_t4');
  assert.ok(disc, 'Expected ZWNJ-joined discourse filler detection');
  assert.ok(rep, 'Expected direct word repetition detection');
  assert.deepEqual(rep.affectedTokenIds, ['t4']);
});
