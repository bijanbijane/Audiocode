import { TimedPersianToken, PersianTextNormalizer } from './PersianTextNormalizer';
import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';

export type PacingClassification =
  | 'OPTIMAL_NARRATION_PACE' // Standard Persian narration pace (115-145 WPM)
  | 'TOO_FAST_RUSHED'        // Rushed delivery risking phoneme elision (> 165 WPM)
  | 'TOO_SLOW_DRAGGING';     // Overly slow delivery (< 90 WPM)

export type IntonationClassification =
  | 'EXPRESSIVE_DYNAMIC'     // Natural pitch expressiveness (stdDev >= 1.3 semitones)
  | 'MONOTONE_FLAT_RISK';    // Flat/monotone prosody risk (stdDev < 1.3 semitones)

export interface ProsodicWindowReport {
  readonly windowRange: TimeRange;
  readonly netWordsPerMinute: number;
  readonly syllablesPerSecond: number;
  readonly medianPitchHz: number;
  readonly pitchStdDevSemitones: number;
  readonly pacingStatus: PacingClassification;
  readonly intonationStatus: IntonationClassification;
  readonly coachingTipFa: string | null;
}

/**
 * Persian Prosody, Articulation Rate & Monotone Detector (Sections 2.2 & 2.6)
 * Measures net speech rate (excluding inter-word silences) and speaker-independent
 * pitch contour variance in logarithmic Semitones.
 */
export class PersianProsodyAndPacingAnalyzer {
  public static analyzeProsodyWindows(
    tokens: readonly TimedPersianToken[],
    pcmMono: Float32Array,
    sampleRate: SampleRate,
    windowDurationSec = 15.0,
  ): ProsodicWindowReport[] {
    if (tokens.length === 0 || pcmMono.length === 0 || sampleRate <= 0 || windowDurationSec <= 0) {
      return [];
    }

    const totalDurationSec = pcmMono.length / sampleRate;
    const reports: ProsodicWindowReport[] = [];

    for (let startSec = 0; startSec < totalDurationSec; startSec += windowDurationSec) {
      const endSec = Math.min(totalDurationSec, startSec + windowDurationSec);
      if (endSec - startSec < 5.0) break;

      const winRange: TimeRange = {
        start: TimeMath.secondsToFlicks(startSec),
        end: TimeMath.secondsToFlicks(endSec),
      };

      const winTokens = tokens.filter((t) => {
        const midFlicks = (t.range.start + t.range.end) / 2;
        return midFlicks >= winRange.start && midFlicks < winRange.end;
      });
      if (winTokens.length < 4) continue;

      // 1. Net articulation time (sum of word speech durations, excluding inter-word silences)
      let netSpeechSeconds = 0;
      let totalSyllables = 0;
      for (const tok of winTokens) {
        const dur = TimeMath.flicksToSeconds(tok.range.end - tok.range.start);
        netSpeechSeconds += Math.max(0.05, dur);
        totalSyllables += this.estimatePersianWordSyllables(tok.normalizedText);
      }

      const netWordsPerMinute = Math.round((winTokens.length / netSpeechSeconds) * 60);
      const syllablesPerSecond = Number((totalSyllables / netSpeechSeconds).toFixed(2));

      // 2. Fundamental frequency (F0) contour and Semitone standard deviation
      const startSample = Math.floor(startSec * sampleRate);
      const endSample = Math.min(pcmMono.length, Math.floor(endSec * sampleRate));
      const { medianHz, stdDevSemitones } = this.estimatePitchContourStats(
        pcmMono.subarray(startSample, endSample),
        sampleRate,
      );

      // 3. Classify pacing and intonation
      let pacingStatus: PacingClassification = 'OPTIMAL_NARRATION_PACE';
      if (netWordsPerMinute > 165 || syllablesPerSecond > 6.2) {
        pacingStatus = 'TOO_FAST_RUSHED';
      } else if (netWordsPerMinute < 90 && syllablesPerSecond < 3.0) {
        pacingStatus = 'TOO_SLOW_DRAGGING';
      }

      const intonationStatus: IntonationClassification =
        stdDevSemitones < 1.3 && medianHz > 0
          ? 'MONOTONE_FLAT_RISK'
          : 'EXPRESSIVE_DYNAMIC';

      const tips: string[] = [];
      if (pacingStatus === 'TOO_FAST_RUSHED') {
        tips.push(
          `سرعت بیان در این بخش بالاست (${netWordsPerMinute} کلمه بر دقیقه)؛ احتمال ناواضح شدن واج‌ها وجود دارد.`,
        );
      } else if (pacingStatus === 'TOO_SLOW_DRAGGING') {
        tips.push(
          `سرعت بیان در این بخش کند است (${netWordsPerMinute} کلمه بر دقیقه)؛ ریتم روایت ممکن است کش‌دار به نظر برسد.`,
        );
      }
      if (intonationStatus === 'MONOTONE_FLAT_RISK') {
        tips.push(
          `لحن بیان در این بازه یکنواخت است (تغییرات زیر و بمی فقط ${stdDevSemitones.toFixed(1)} نیم‌پرده).`,
        );
      }

      reports.push({
        windowRange: winRange,
        netWordsPerMinute,
        syllablesPerSecond,
        medianPitchHz: Number(medianHz.toFixed(1)),
        pitchStdDevSemitones: Number(stdDevSemitones.toFixed(2)),
        pacingStatus,
        intonationStatus,
        coachingTipFa: tips.length > 0 ? tips.join(' ') : null,
      });
    }

    return reports;
  }

  /**
   * Estimates syllable count of a Persian word using vowel cores and consonant length.
   */
  public static estimatePersianWordSyllables(word: string): number {
    const normalized = PersianTextNormalizer.normalizeTokenText(word);
    const clean = normalized.replace(/[^\u0621-\u06CC]/g, '');
    if (clean.length === 0) return 0;
    if (clean.length <= 2) return 1;

    const longVowelMatches = clean.match(/[آاوی]/g)?.length ?? 0;
    const lengthBasedEstimate = Math.ceil(clean.length / 2.4);
    return Math.max(1, Math.round((longVowelMatches + lengthBasedEstimate) / 1.8));
  }

  /**
   * Estimates F0 pitch across 40ms voiced frames (75Hz - 360Hz) via normalized autocorrelation
   * and returns median pitch (Hz) + standard deviation in Semitones relative to median pitch.
   */
  private static estimatePitchContourStats(
    slice: Float32Array,
    sampleRate: SampleRate,
  ): { medianHz: number; stdDevSemitones: number } {
    const frameSamples = Math.floor(sampleRate * 0.04); // 40ms frames
    if (frameSamples <= 0 || slice.length < frameSamples) {
      return { medianHz: 0, stdDevSemitones: 0 };
    }

    const minLag = Math.max(1, Math.floor(sampleRate / 360)); // 360 Hz upper bound
    const maxLag = Math.min(frameSamples - 2, Math.floor(sampleRate / 75)); // 75 Hz lower bound
    if (maxLag <= minLag) {
      return { medianHz: 0, stdDevSemitones: 0 };
    }

    const coarseStep = sampleRate >= 32000 ? 2 : 1;
    const voicedPitchesHz: number[] = [];

    const evalNormCorr = (start: number, lag: number): number => {
      let dot = 0;
      let e1 = 0;
      let e2 = 0;
      const limit = frameSamples - lag;
      for (let i = 0; i < limit; i += 2) {
        const a = slice[start + i];
        const b = slice[start + i + lag];
        dot += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      return dot / (Math.sqrt(e1 * e2) + 1e-12);
    };

    for (let start = 0; start + frameSamples <= slice.length; start += frameSamples) {
      let energy = 0;
      for (let i = 0; i < frameSamples; i++) {
        const s = slice[start + i];
        energy += s * s;
      }
      const rms = Math.sqrt(energy / frameSamples);
      if (rms < 0.015) continue; // Ignore silent or weak unvoiced frames

      let bestLag = 0;
      let maxNormCorr = 0;

      for (let lag = minLag; lag <= maxLag; lag += coarseStep) {
        const corr = evalNormCorr(start, lag);
        if (corr > maxNormCorr) {
          maxNormCorr = corr;
          bestLag = lag;
        }
      }

      // Single-sample neighborhood refinement when coarseStep === 2
      if (coarseStep > 1 && bestLag > 0) {
        for (const candidateLag of [bestLag - 1, bestLag + 1]) {
          if (candidateLag >= minLag && candidateLag <= maxLag) {
            const corr = evalNormCorr(start, candidateLag);
            if (corr > maxNormCorr) {
              maxNormCorr = corr;
              bestLag = candidateLag;
            }
          }
        }
      }

      if (maxNormCorr >= 0.65 && bestLag > 0) {
        voicedPitchesHz.push(sampleRate / bestLag);
      }
    }

    if (voicedPitchesHz.length < 3) {
      return { medianHz: 0, stdDevSemitones: 0 };
    }

    const sorted = [...voicedPitchesHz].sort((a, b) => a - b);
    const medianHz = sorted[Math.floor(sorted.length / 2)];

    // Semitones relative to speaker median: ST = 12 * log2(f / f_median)
    const semitones = voicedPitchesHz.map((f) => 12.0 * Math.log2(f / medianHz));
    const meanSt = semitones.reduce((a, b) => a + b, 0) / semitones.length;
    const varianceSt =
      semitones.reduce((acc, st) => acc + (st - meanSt) * (st - meanSt), 0) /
      semitones.length;

    return {
      medianHz,
      stdDevSemitones: Math.sqrt(varianceSt),
    };
  }
}
