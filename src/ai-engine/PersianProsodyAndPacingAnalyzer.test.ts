import test from 'node:test';
import assert from 'node:assert/strict';
import { PersianProsodyAndPacingAnalyzer } from './PersianProsodyAndPacingAnalyzer';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

function synthesizeVoicedPitchWave(
  durationSec: number,
  sampleRate: 48000 | 16000,
  pitchFn: (timeSec: number) => number,
): Float32Array {
  const total = Math.floor(durationSec * sampleRate);
  const pcm = new Float32Array(total);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const f0 = pitchFn(t);
    phase += (2 * Math.PI * f0) / sampleRate;
    pcm[i] = 0.35 * Math.sin(phase) + 0.15 * Math.sin(2 * phase);
  }
  return pcm;
}

test('Section 54: PersianProsodyAndPacingAnalyzer measures net articulation WPM excluding inter-word silences', () => {
  const sr = 16000 as const;
  const pcm = synthesizeVoicedPitchWave(15, sr, (t) => 130 + 28 * Math.sin(t * 2.1));

  // Place 16 words across 15s, where each word lasts only 0.45s (total net speech = 7.2s -> ~133 WPM)
  const rawTokens = Array.from({ length: 16 }, (_, idx) => {
    const startSec = idx * 0.9;
    return {
      id: `tok_${idx}`,
      text: 'سلامت',
      range: {
        start: TimeMath.secondsToFlicks(startSec),
        end: TimeMath.secondsToFlicks(startSec + 0.45),
      },
      confidence: 0.96,
    };
  });

  const tokens = PersianTextNormalizer.buildThreeLayerTranscript(rawTokens);
  const reports = PersianProsodyAndPacingAnalyzer.analyzeProsodyWindows(tokens, pcm, sr, 15.0);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].pacingStatus, 'OPTIMAL_NARRATION_PACE');
  assert.ok(reports[0].netWordsPerMinute >= 120 && reports[0].netWordsPerMinute <= 145);
  assert.equal(reports[0].intonationStatus, 'EXPRESSIVE_DYNAMIC');
});

test('Section 54: PersianProsodyAndPacingAnalyzer detects TOO_FAST_RUSHED and MONOTONE_FLAT_RISK speaker-independently', () => {
  const sr = 16000 as const;
  // Constant 220Hz pitch (female range, zero intonation variation -> monotone risk)
  const monotonePcm = synthesizeVoicedPitchWave(15, sr, () => 220);

  // Rapid delivery: 32 words at 0.28s each -> ~214 WPM
  const fastTokens = PersianTextNormalizer.buildThreeLayerTranscript(
    Array.from({ length: 32 }, (_, idx) => {
      const startSec = idx * 0.42;
      return {
        id: `fast_${idx}`,
        text: 'آزمایشگاه',
        range: {
          start: TimeMath.secondsToFlicks(startSec),
          end: TimeMath.secondsToFlicks(startSec + 0.28),
        },
        confidence: 0.94,
      };
    }),
  );

  const reports = PersianProsodyAndPacingAnalyzer.analyzeProsodyWindows(
    fastTokens,
    monotonePcm,
    sr,
    15.0,
  );

  assert.equal(reports.length, 1);
  assert.equal(reports[0].pacingStatus, 'TOO_FAST_RUSHED');
  assert.equal(reports[0].intonationStatus, 'MONOTONE_FLAT_RISK');
  assert.ok(Math.abs(reports[0].medianPitchHz - 220) < 12);
  assert.ok(reports[0].pitchStdDevSemitones < 1.3);
  assert.ok(reports[0].coachingTipFa && reports[0].coachingTipFa.includes('سرعت بیان'));
  assert.ok(reports[0].coachingTipFa && reports[0].coachingTipFa.includes('یکنواخت'));
});

test('Section 54: PersianProsodyAndPacingAnalyzer detects TOO_SLOW_DRAGGING and counts Persian syllables cleanly', () => {
  assert.equal(PersianProsodyAndPacingAnalyzer.estimatePersianWordSyllables('من'), 1);
  assert.ok(PersianProsodyAndPacingAnalyzer.estimatePersianWordSyllables('آزمایشگاه') >= 3);

  const sr = 16000 as const;
  const expressivePcm = synthesizeVoicedPitchWave(15, sr, (t) => 125 + 30 * Math.sin(t * 1.7));
  // 5 long slow words occupying 1.2s each -> ~50 WPM
  const slowTokens = PersianTextNormalizer.buildThreeLayerTranscript(
    Array.from({ length: 5 }, (_, idx) => {
      const startSec = idx * 2.5;
      return {
        id: `slow_${idx}`,
        text: 'با',
        range: {
          start: TimeMath.secondsToFlicks(startSec),
          end: TimeMath.secondsToFlicks(startSec + 1.2),
        },
        confidence: 0.92,
      };
    }),
  );

  const reports = PersianProsodyAndPacingAnalyzer.analyzeProsodyWindows(
    slowTokens,
    expressivePcm,
    sr,
    15.0,
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].pacingStatus, 'TOO_SLOW_DRAGGING');
  assert.ok(reports[0].coachingTipFa?.includes('کند'));
});
