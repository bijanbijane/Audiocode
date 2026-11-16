import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import { TimedPersianToken } from './PersianTextNormalizer';

export type NonVerbalEventType =
  | 'COUGH_OR_THROAT_CLEAR'
  | 'SHARP_INHALE_BREATH'
  | 'LAUGHTER_BURST';

export type NonVerbalRecommendedAction =
  | 'REPLACE_WITH_ROOM_TONE' // For coughs and throat clearing
  | 'ATTENUATE_GAIN_10DB'    // For sharp inhale breaths before sentences (preserves natural speech)
  | 'KEEP_OR_USER_REVIEW';   // For laughter bursts

export interface DetectedNonVerbalEvent {
  readonly eventId: string;
  readonly eventType: NonVerbalEventType;
  readonly range: TimeRange;
  readonly recommendedAction: NonVerbalRecommendedAction;
  readonly peakDb: number;
  readonly confidence: number;
  readonly descriptionFa: string;
}

/**
 * Non-Verbal Vocal Event Detector for Persian Podcasts & Audiobooks
 * (Architecture Doc Sections 2.2 & 2.6)
 * Scans inter-word acoustic gaps to distinguish explosive coughs/throat clears
 * (recommended: REPLACE_WITH_ROOM_TONE) from sharp pre-sentence inhale breaths
 * (recommended: ATTENUATE_GAIN_10DB rather than unnatural hard mute).
 */
export class NonVerbalVocalEventDetector {
  /**
   * Scans inter-word gaps for coughs, throat clearing, and sharp inhale breaths.
   */
  public static detectNonVerbalEventsInGaps(
    pcmMono: Float32Array,
    tokens: readonly TimedPersianToken[],
    sampleRate: SampleRate,
  ): DetectedNonVerbalEvent[] {
    const events: DetectedNonVerbalEvent[] = [];
    if (pcmMono.length === 0 || tokens.length === 0) return events;

    const frameSize = Math.floor(sampleRate * 0.025); // 25ms hop windows

    for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
      const prevEndSample =
        tIdx === 0
          ? 0
          : TimeMath.flicksToSamplesFloor(tokens[tIdx - 1].range.end, sampleRate);
      const nextStartSample = TimeMath.flicksToSamplesFloor(
        tokens[tIdx].range.start,
        sampleRate,
      );

      const gapSamples = nextStartSample - prevEndSample;
      const gapMs = (gapSamples / sampleRate) * 1000;
      if (gapMs < 70) continue; // Gaps under 70ms are too short for coughs or inhale breaths

      for (
        let pos = prevEndSample;
        pos + frameSize * 3 <= nextStartSample;
        pos += frameSize
      ) {
        const winLen = Math.min(frameSize * 6, nextStartSample - pos); // Up to 150ms analysis window
        let sumSq = 0;
        let peak = 0;
        let zcr = 0;

        for (let i = pos; i < pos + winLen; i++) {
          const val = pcmMono[i];
          const abs = Math.abs(val);
          sumSq += val * val;
          if (abs > peak) peak = abs;
          if (
            i > pos &&
            ((pcmMono[i - 1] >= 0 && val < 0) || (pcmMono[i - 1] < 0 && val >= 0))
          ) {
            zcr++;
          }
        }

        const rms = Math.sqrt(sumSq / winLen);
        const rmsDb = 20 * Math.log10(rms + 1e-9);
        const peakDb = 20 * Math.log10(peak + 1e-9);
        const crestFactor = peak / (rms + 1e-9);
        const zcrRatio = zcr / winLen;

        if (rmsDb < -44.0) continue;

        const eventRange: TimeRange = {
          start: TimeMath.samplesToFlicks(pos, sampleRate),
          end: TimeMath.samplesToFlicks(pos + winLen, sampleRate),
        };

        // 1. Cough / throat clear: high impulsive peak (> -14dB), high crest factor (> 4.2), noisy ZCR
        if (peakDb > -14.0 && crestFactor > 4.2 && zcrRatio > 0.08) {
          events.push({
            eventId: `nv_cough_${pos}`,
            eventType: 'COUGH_OR_THROAT_CLEAR',
            range: eventRange,
            recommendedAction: 'REPLACE_WITH_ROOM_TONE',
            peakDb: Number(peakDb.toFixed(1)),
            confidence: 0.89,
            descriptionFa: 'سرفه یا ضربه گلویی ناگهانی بین دو کلمه (پیشنهاد جایگزینی با Room Tone)',
          });
          pos += winLen;
          continue;
        }

        // 2. Sharp inhale breath immediately preceding the next word (<= 280ms before word onset)
        const distToNextWordMs = ((nextStartSample - (pos + winLen)) / sampleRate) * 1000;
        if (
          distToNextWordMs <= 280 &&
          rmsDb >= -36.0 &&
          rmsDb <= -18.0 &&
          zcrRatio >= 0.12 &&
          crestFactor < 3.8
        ) {
          events.push({
            eventId: `nv_breath_${pos}`,
            eventType: 'SHARP_INHALE_BREATH',
            range: eventRange,
            recommendedAction: 'ATTENUATE_GAIN_10DB',
            peakDb: Number(peakDb.toFixed(1)),
            confidence: 0.86,
            descriptionFa:
              'نفس کشیدن بلند پیش از شروع جمله (پیشنهاد کاهش نرم 10dB به جای حذف کامل برای حفظ طبیعی بودن گویندگی)',
          });
          pos += winLen;
        }
      }
    }

    return events;
  }
}
