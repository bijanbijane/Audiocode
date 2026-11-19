import { TimedPersianToken, PersianTextNormalizer } from './PersianTextNormalizer';
import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import {
  DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
  SpeechAnalysisThresholdConfig,
  SpeechEventSubtype,
  SpeechEventUncertaintyState,
} from './speech-events/SpeechEventContracts';

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

export interface PauseDurationDistribution {
  readonly count: number;
  readonly totalPauseSec: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
}

export interface ProsodyPacingAnomaly {
  readonly anomalyId: string;
  readonly trackId: string;
  readonly subtype: Extract<
    SpeechEventSubtype,
    | 'TOO_FAST_PACING'
    | 'TOO_SLOW_PACING'
    | 'ABRUPT_PACING_CHANGE'
    | 'LONG_UNINTERRUPTED_SPEECH'
  >;
  readonly range: TimeRange;
  readonly speakingRateWpm: number;
  readonly articulationRateWpm: number;
  readonly speakerBaselineWpm: number;
  readonly score: number;
  readonly uncertaintyState: SpeechEventUncertaintyState;
  readonly explanationFa: string;
}

export interface ComprehensiveProsodyReport {
  readonly totalSpeakingRateWpm: number;
  readonly netArticulationRateWpm: number;
  readonly netSyllablesPerSecond: number;
  readonly speakerBaselineWpm: number;
  readonly pauseFrequencyPerMin: number;
  readonly pauseDistribution: PauseDurationDistribution;
  readonly phraseRhythmCv: number;
  readonly windowReports: readonly ProsodicWindowReport[];
  readonly anomalies: readonly ProsodyPacingAnomaly[];
  readonly baselineNoteFa: string;
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
   * Self-relative Persian prosody, speaking rate vs net articulation rate, pause distribution,
   * phrase rhythm CV, abrupt tempo shifts, and long uninterrupted speech span analysis.
   * Never enforces a universal speed norm or treats accent/speaking style as an error.
   */
  public static analyzeComprehensiveProsody(
    tokens: readonly TimedPersianToken[],
    pcmMono: Float32Array,
    sampleRate: SampleRate,
    config: SpeechAnalysisThresholdConfig = DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
    options?: { readonly offsetSeconds?: number; readonly windowDurationSec?: number },
  ): ComprehensiveProsodyReport {
    const windowDurationSec = options?.windowDurationSec ?? 8.0;
    const offsetSeconds = options?.offsetSeconds ?? 0;

    if (tokens.length === 0) {
      return {
        totalSpeakingRateWpm: 0,
        netArticulationRateWpm: 0,
        netSyllablesPerSecond: 0,
        speakerBaselineWpm: 0,
        pauseFrequencyPerMin: 0,
        pauseDistribution: { count: 0, totalPauseSec: 0, meanMs: 0, medianMs: 0, p95Ms: 0 },
        phraseRhythmCv: 0,
        windowReports: [],
        anomalies: [],
        baselineNoteFa: 'واژه‌ای برای تحلیل ریتم و آهنگ گفتار در دسترس نیست.',
      };
    }

    const sorted = [...tokens].sort((a, b) => a.range.start - b.range.start);
    const firstStartSec = TimeMath.flicksToSeconds(sorted[0].range.start);
    const lastEndSec = TimeMath.flicksToSeconds(sorted[sorted.length - 1].range.end);
    const audioSpanSec =
      pcmMono.length > 0 && sampleRate > 0 ? pcmMono.length / sampleRate : 0;
    const totalSpanSec = Math.max(0.2, audioSpanSec, lastEndSec - firstStartSec);

    let totalArticulationSec = 0;
    let totalSyllables = 0;
    const pauseDurationsMs: number[] = [];
    const wordDurationsSec: number[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const tok = sorted[i];
      const durSec = Math.max(0.05, TimeMath.flicksToSeconds(tok.range.end - tok.range.start));
      totalArticulationSec += durSec;
      totalSyllables += this.estimatePersianWordSyllables(tok.normalizedText);
      wordDurationsSec.push(durSec);

      if (i > 0 && tok.trackId === sorted[i - 1].trackId) {
        const gapMs =
          TimeMath.flicksToSeconds(tok.range.start - sorted[i - 1].range.end) * 1000;
        if (gapMs >= 180) {
          pauseDurationsMs.push(gapMs);
        }
      }
    }

    const totalPauseSec = pauseDurationsMs.reduce((a, b) => a + b, 0) / 1000;
    // Net articulation time excludes inter-word pauses >= 180ms
    const netSpeechSec = Math.max(0.2, totalSpanSec - totalPauseSec);
    const effectiveArticulationSec = Math.max(0.2, Math.min(netSpeechSec, totalArticulationSec + pauseDurationsMs.length * 0.05));

    const totalSpeakingRateWpm = Math.round((sorted.length / totalSpanSec) * 60);
    const netArticulationRateWpm = Math.round((sorted.length / effectiveArticulationSec) * 60);
    const netSyllablesPerSecond = Number((totalSyllables / effectiveArticulationSec).toFixed(2));
    const pauseFrequencyPerMin = Number(((pauseDurationsMs.length / totalSpanSec) * 60).toFixed(2));

    const sortedPauses = [...pauseDurationsMs].sort((a, b) => a - b);
    const pauseDistribution: PauseDurationDistribution =
      sortedPauses.length === 0
        ? { count: 0, totalPauseSec: 0, meanMs: 0, medianMs: 0, p95Ms: 0 }
        : {
            count: sortedPauses.length,
            totalPauseSec: Number(totalPauseSec.toFixed(3)),
            meanMs: Math.round(
              sortedPauses.reduce((a, b) => a + b, 0) / sortedPauses.length,
            ),
            medianMs: Math.round(sortedPauses[Math.floor(sortedPauses.length / 2)]),
            p95Ms: Math.round(
              sortedPauses[Math.min(sortedPauses.length - 1, Math.floor(sortedPauses.length * 0.95))],
            ),
          };

    // Phrase rhythm CV across inter-onset intervals / token durations
    const meanDur =
      wordDurationsSec.reduce((a, b) => a + b, 0) / Math.max(1, wordDurationsSec.length);
    const durVariance =
      wordDurationsSec.reduce((acc, d) => acc + (d - meanDur) * (d - meanDur), 0) /
      Math.max(1, wordDurationsSec.length);
    const phraseRhythmCv = Number((Math.sqrt(durVariance) / Math.max(1e-6, meanDur)).toFixed(3));

    const windowReports =
      pcmMono.length > 0 && sampleRate > 0
        ? this.analyzeProsodyWindows(sorted, pcmMono, sampleRate, Math.max(5.0, windowDurationSec))
        : [];

    // Compute per-window articulation rate for self-relative speaker baseline
    interface LocalRateWindow {
      readonly trackId: string;
      readonly startSec: number;
      readonly endSec: number;
      readonly articulationWpm: number;
      readonly speakingWpm: number;
      readonly wordCount: number;
    }

    const localWindows: LocalRateWindow[] = [];
    const spanStart = offsetSeconds > 0 ? offsetSeconds : firstStartSec;
    const spanEnd = Math.max(lastEndSec, spanStart + totalSpanSec);

    for (let s = spanStart; s < spanEnd; s += windowDurationSec) {
      const e = Math.min(spanEnd, s + windowDurationSec);
      if (e - s < 3.0) break;
      const winStartFlicks = TimeMath.secondsToFlicks(s);
      const winEndFlicks = TimeMath.secondsToFlicks(e);
      const winToks = sorted.filter((t) => {
        const mid = (t.range.start + t.range.end) / 2;
        return mid >= winStartFlicks && mid < winEndFlicks;
      });
      if (winToks.length < 4) continue;

      let winNetSec = 0;
      for (const tok of winToks) {
        winNetSec += Math.max(0.05, TimeMath.flicksToSeconds(tok.range.end - tok.range.start));
      }
      localWindows.push({
        trackId: winToks[0].trackId,
        startSec: s,
        endSec: e,
        articulationWpm: Math.round((winToks.length / Math.max(0.25, winNetSec)) * 60),
        speakingWpm: Math.round((winToks.length / (e - s)) * 60),
        wordCount: winToks.length,
      });
    }

    const sortedRates = localWindows.map((w) => w.articulationWpm).sort((a, b) => a - b);
    const speakerBaselineWpm =
      sortedRates.length >= 2
        ? sortedRates[Math.floor(sortedRates.length / 2)]
        : netArticulationRateWpm;

    const anomalies: ProsodyPacingAnomaly[] = [];

    // Self-relative pacing anomalies (only when >= 2 windows establish the speaker's own baseline)
    if (localWindows.length >= 2 && speakerBaselineWpm > 0) {
      for (let i = 0; i < localWindows.length; i++) {
        const w = localWindows[i];
        const ratioToBaseline = w.articulationWpm / speakerBaselineWpm;

        if (ratioToBaseline >= config.relativeFastPaceRatio) {
          anomalies.push({
            anomalyId: `pace_fast_${Math.round(w.startSec * 1000)}`,
            trackId: w.trackId,
            subtype: 'TOO_FAST_PACING',
            range: {
              start: TimeMath.secondsToFlicks(w.startSec),
              end: TimeMath.secondsToFlicks(w.endSec),
            },
            speakingRateWpm: w.speakingWpm,
            articulationRateWpm: w.articulationWpm,
            speakerBaselineWpm,
            score: Number(Math.min(0.84, 0.56 + (ratioToBaseline - config.relativeFastPaceRatio) * 0.6).toFixed(3)),
            uncertaintyState: 'MODERATE_UNCERTAINTY',
            explanationFa: `شتاب ناگهانی نرخ بیان نسبت به پایه خود گوینده (${w.articulationWpm} در برابر میانگین ${speakerBaselineWpm} کلمه بر دقیقه). صرفاً جهت بررسی ریتم.`,
          });
        } else if (ratioToBaseline <= config.relativeSlowPaceRatio) {
          anomalies.push({
            anomalyId: `pace_slow_${Math.round(w.startSec * 1000)}`,
            trackId: w.trackId,
            subtype: 'TOO_SLOW_PACING',
            range: {
              start: TimeMath.secondsToFlicks(w.startSec),
              end: TimeMath.secondsToFlicks(w.endSec),
            },
            speakingRateWpm: w.speakingWpm,
            articulationRateWpm: w.articulationWpm,
            speakerBaselineWpm,
            score: Number(Math.min(0.82, 0.56 + (config.relativeSlowPaceRatio - ratioToBaseline) * 0.7).toFixed(3)),
            uncertaintyState: 'MODERATE_UNCERTAINTY',
            explanationFa: `کندی محسوس نسبت به سرعت عادی همین گوینده (${w.articulationWpm} در برابر پایه ${speakerBaselineWpm} کلمه بر دقیقه).`,
          });
        }

        if (i > 0) {
          const prev = localWindows[i - 1];
          const deltaRatio =
            Math.abs(w.articulationWpm - prev.articulationWpm) / Math.max(1, prev.articulationWpm);
          if (deltaRatio >= config.abruptPaceChangeRatio) {
            anomalies.push({
              anomalyId: `pace_shift_${Math.round(w.startSec * 1000)}`,
              trackId: w.trackId,
              subtype: 'ABRUPT_PACING_CHANGE',
              range: {
                start: TimeMath.secondsToFlicks(w.startSec),
                end: TimeMath.secondsToFlicks(w.endSec),
              },
              speakingRateWpm: w.speakingWpm,
              articulationRateWpm: w.articulationWpm,
              speakerBaselineWpm,
              score: Number(Math.min(0.82, 0.55 + (deltaRatio - config.abruptPaceChangeRatio) * 0.5).toFixed(3)),
              uncertaintyState: 'MODERATE_UNCERTAINTY',
              explanationFa: `تغییر ناگهانی سرعت بین دو بازه متوالی (${prev.articulationWpm} ← ${w.articulationWpm} کلمه بر دقیقه، تغییر ${Math.round(deltaRatio * 100)}٪).`,
            });
          }
        }
      }
    }

    // Long uninterrupted speech spans without a natural >= 220ms pause
    let spanStartTok = sorted[0];
    let lastTokInSpan = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const curr = sorted[i];
      const gapMs =
        curr.trackId === lastTokInSpan.trackId
          ? TimeMath.flicksToSeconds(curr.range.start - lastTokInSpan.range.end) * 1000
          : 1000;
      if (gapMs >= 220 || curr.trackId !== lastTokInSpan.trackId) {
        const spanDur = TimeMath.flicksToSeconds(lastTokInSpan.range.end - spanStartTok.range.start);
        if (spanDur >= config.longUninterruptedSpeechMinSec) {
          anomalies.push({
            anomalyId: `pace_uninterrupted_${spanStartTok.tokenId}`,
            trackId: spanStartTok.trackId,
            subtype: 'LONG_UNINTERRUPTED_SPEECH',
            range: { start: spanStartTok.range.start, end: lastTokInSpan.range.end },
            speakingRateWpm: totalSpeakingRateWpm,
            articulationRateWpm: netArticulationRateWpm,
            speakerBaselineWpm,
            score: 0.72,
            uncertaintyState: 'LOW_UNCERTAINTY',
            explanationFa: `گفتار پیوسته به مدت ${spanDur.toFixed(1)} ثانیه بدون مکث تنفس طبیعی (≥ ${config.longUninterruptedSpeechMinSec}s).`,
          });
        }
        spanStartTok = curr;
      }
      lastTokInSpan = curr;
    }
    const tailSpanDur = TimeMath.flicksToSeconds(lastTokInSpan.range.end - spanStartTok.range.start);
    if (tailSpanDur >= config.longUninterruptedSpeechMinSec) {
      anomalies.push({
        anomalyId: `pace_uninterrupted_${spanStartTok.tokenId}`,
        trackId: spanStartTok.trackId,
        subtype: 'LONG_UNINTERRUPTED_SPEECH',
        range: { start: spanStartTok.range.start, end: lastTokInSpan.range.end },
        speakingRateWpm: totalSpeakingRateWpm,
        articulationRateWpm: netArticulationRateWpm,
        speakerBaselineWpm,
        score: 0.72,
        uncertaintyState: 'LOW_UNCERTAINTY',
        explanationFa: `گفتار پیوسته به مدت ${tailSpanDur.toFixed(1)} ثانیه بدون مکث تنفس طبیعی (≥ ${config.longUninterruptedSpeechMinSec}s).`,
      });
    }

    return {
      totalSpeakingRateWpm,
      netArticulationRateWpm,
      netSyllablesPerSecond,
      speakerBaselineWpm,
      pauseFrequencyPerMin,
      pauseDistribution,
      phraseRhythmCv,
      windowReports,
      anomalies,
      baselineNoteFa: `مقایسه نسبی بر اساس سرعت پایه خود گوینده (${speakerBaselineWpm} کلمه بر دقیقه در بیان خالص، ${totalSpeakingRateWpm} با احتساب مکث‌ها) بدون اعمال معیار تحمیلی گویش یا لهجه.`,
    };
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
