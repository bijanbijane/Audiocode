import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NonVerbalVocalEventDetector } from './NonVerbalVocalEventDetector';
import { PersianTextNormalizer } from './PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

describe('NonVerbalVocalEventDetector (Sections 2.2 & 2.6)', () => {
  it('distinguishes an impulsive cough (REPLACE_WITH_ROOM_TONE) from a pre-word inhale breath (ATTENUATE_GAIN_10DB)', () => {
    const sr = 16000 as const;
    const pcm = new Float32Array(sr * 3); // 3 seconds

    // Gap 1: [0.0s .. 1.0s] -> Inject impulsive cough burst around 0.2s (sample 3200..4000)
    for (let i = 3200; i < 3450; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      pcm[i] = i < 3260 ? sign * 0.85 : sign * 0.08;
    }

    // Gap 2: [1.5s .. 2.2s] -> Inject unvoiced fricative inhale breath right before word 2 at [2.0s..2.15s] (sample 32000..34400)
    for (let i = 32000; i < 34400; i++) {
      const sign = i % 3 === 0 ? 1 : -1;
      pcm[i] = sign * 0.06;
    }

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 'w1',
        text: 'سلام',
        range: {
          start: TimeMath.secondsToFlicks(1.0),
          end: TimeMath.secondsToFlicks(1.5),
        },
        confidence: 0.98,
      },
      {
        id: 'w2',
        text: 'دوستان',
        range: {
          start: TimeMath.secondsToFlicks(2.2),
          end: TimeMath.secondsToFlicks(2.8),
        },
        confidence: 0.97,
      },
    ]);

    const detected = NonVerbalVocalEventDetector.detectNonVerbalEventsInGaps(pcm, tokens, sr);
    assert.ok(
      detected.some(
        (e) =>
          e.eventType === 'COUGH_OR_THROAT_CLEAR' &&
          e.recommendedAction === 'REPLACE_WITH_ROOM_TONE',
      ),
    );
    assert.ok(
      detected.some(
        (e) =>
          e.eventType === 'SHARP_INHALE_BREATH' &&
          e.recommendedAction === 'ATTENUATE_GAIN_10DB',
      ),
    );
  });
});
