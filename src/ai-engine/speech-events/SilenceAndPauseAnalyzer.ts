import { SampleRate, TimeMath, TimeRange } from '../../contracts/timebase.contract';
import { TimedPersianToken } from '../PersianTextNormalizer';
import {
  DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
  SpeechAnalysisThresholdConfig,
  SpeechEventAcousticEvidence,
  SpeechEventDetectionState,
  SpeechEventSubtype,
  SpeechEventUncertaintyState,
} from './SpeechEventContracts';

export interface VadProbeProvider {
  detectVoiceActivity(
    pcm16kMono: Float32Array,
  ): Promise<{ hasSpeech: boolean; speechRatio: number }>;
}

export interface SilencePauseDetection {
  readonly id: string;
  readonly trackId: string;
  readonly subtype: Extract<
    SpeechEventSubtype,
    | 'NATURAL_SHORT_PAUSE'
    | 'SENTENCE_BOUNDARY_PAUSE'
    | 'BREATH_RELATED_PAUSE'
    | 'HESITATION_PAUSE'
    | 'LONG_UNNECESSARY_SILENCE'
    | 'RECORDING_GAP'
    | 'INPUT_FAILURE_OR_DIGITAL_ZERO'
    | 'UTTERANCE_INTERNAL_SILENCE'
    | 'EDGE_SILENCE'
  >;
  readonly detectionState: SpeechEventDetectionState;
  readonly uncertaintyState: SpeechEventUncertaintyState;
  readonly fullRange: TimeRange;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  /** Trimmable interior range after preserving speech boundary padding and natural pause retention */
  readonly candidateStartSec?: number;
  readonly candidateEndSec?: number;
  readonly acousticScore: number;
  readonly linguisticScore: number | null;
  readonly acousticEvidence: SpeechEventAcousticEvidence;
  readonly eligibleForShortening: boolean;
  readonly requiresHumanReview: boolean;
  readonly explanationFa: string;
}

export interface SilenceAnalysisResult {
  readonly noiseFloorDbfs: number;
  readonly noiseFloorRms: number;
  readonly vadChecked: boolean;
  readonly detections: readonly SilencePauseDetection[];
  readonly protectedLowVolumeSpanCount: number;
}

const MID_CLAUSE_HESITATION_WORDS = new Set([
  'که', 'و', 'یا', 'از', 'به', 'در', 'با', 'برای', 'تا', 'چون', 'اگر', 'وقتی', 'ولی', 'اما',
]);

/**
 * Adaptive Silence & Pause Intelligence Engine (AVP-P04-001 Section 7)
 * Uses short-time RMS, peak amplitude, 10th-percentile adaptive noise floor,
 * dual-threshold hysteresis, speech boundary padding, VAD correlation, and
 * whisper/low-volume consonant protection.
 */
export class SilenceAndPauseAnalyzer {
  public static async analyzeSilenceAndPauses(params: {
    readonly pcmMono: Float32Array;
    readonly sampleRate: SampleRate;
    readonly tokens?: readonly TimedPersianToken[];
    readonly breathRangesSec?: readonly { readonly startSec: number; readonly endSec: number }[];
    readonly trackId?: string;
    readonly offsetSeconds?: number;
    readonly totalRecordingDurationSec?: number;
    readonly config?: SpeechAnalysisThresholdConfig;
    readonly vadProvider?: VadProbeProvider | null;
  }): Promise<SilenceAnalysisResult> {
    const {
      pcmMono,
      sampleRate,
      tokens = [],
      breathRangesSec = [],
      trackId = tokens[0]?.trackId ?? 'track-1',
      offsetSeconds = 0,
      config = DEFAULT_SPEECH_EVENT_THRESHOLDS_V1,
      vadProvider = null,
    } = params;

    if (pcmMono.length === 0 || sampleRate <= 0) {
      return {
        noiseFloorDbfs: -96,
        noiseFloorRms: 0,
        vadChecked: false,
        detections: [],
        protectedLowVolumeSpanCount: 0,
      };
    }

    const windowDurationSec = pcmMono.length / sampleRate;
    const totalDurationSec = params.totalRecordingDurationSec ?? offsetSeconds + windowDurationSec;
    const frameSamples = Math.max(32, Math.floor((sampleRate * config.silenceFrameMs) / 1000));
    const hopSamples = Math.max(16, Math.floor((sampleRate * config.silenceHopMs) / 1000));

    const numFrames =
      pcmMono.length >= frameSamples
        ? 1 + Math.floor((pcmMono.length - frameSamples) / hopSamples)
        : 0;

    if (numFrames === 0) {
      return {
        noiseFloorDbfs: -96,
        noiseFloorRms: 0,
        vadChecked: false,
        detections: [],
        protectedLowVolumeSpanCount: 0,
      };
    }

    // TypedArray frame feature buffers (reused locally, freed on return)
    const frameRmsDb = new Float32Array(numFrames);
    const framePeak = new Float32Array(numFrames);
    const frameZcr = new Float32Array(numFrames);
    const frameZeroFrac = new Float32Array(numFrames);
    const nonZeroRmsValues: number[] = [];

    for (let f = 0; f < numFrames; f++) {
      const start = f * hopSamples;
      let sumSq = 0;
      let peak = 0;
      let zcrCount = 0;
      let zeroSamples = 0;

      for (let i = 0; i < frameSamples; i++) {
        const s = pcmMono[start + i];
        const abs = Math.abs(s);
        sumSq += s * s;
        if (abs > peak) peak = abs;
        if (abs <= config.digitalZeroPeakCeiling) zeroSamples++;
        if (i > 0) {
          const prev = pcmMono[start + i - 1];
          if ((prev >= 0 && s < 0) || (prev < 0 && s >= 0)) zcrCount++;
        }
      }

      const rms = Math.sqrt(sumSq / frameSamples);
      frameRmsDb[f] = 20 * Math.log10(Math.max(rms, 1e-9));
      framePeak[f] = peak;
      frameZcr[f] = zcrCount / frameSamples;
      frameZeroFrac[f] = zeroSamples / frameSamples;

      if (rms > config.digitalZeroPeakCeiling) {
        nonZeroRmsValues.push(rms);
      }
    }

    // Adaptive 10th-percentile noise floor from non-digital-zero frames
    let noiseFloorRms = 0.0005;
    if (nonZeroRmsValues.length > 0) {
      nonZeroRmsValues.sort((a, b) => a - b);
      const p10 = nonZeroRmsValues[Math.floor(nonZeroRmsValues.length * 0.1)];
      const p85 = nonZeroRmsValues[Math.floor(nonZeroRmsValues.length * 0.85)];
      // Cap noise floor well below active speech percentile when a window is mostly speech
      noiseFloorRms = Math.max(0.0003, Math.min(p10, p85 * 0.25));
    }
    const noiseFloorDbfs = Number(
      (20 * Math.log10(Math.max(noiseFloorRms, 1e-6))).toFixed(1),
    );

    const enterSilenceDb = Math.min(-24, noiseFloorDbfs + config.silenceEnterMarginDb);
    const exitSilenceDb = Math.min(-20, noiseFloorDbfs + config.silenceExitHysteresisDb);

    // Hysteresis state machine + whisper/low-volume protection
    const rawRuns: Array<{ startFrame: number; endFrame: number }> = [];
    let inSilence = false;
    let runStart = -1;
    let protectedLowVolumeSpanCount = 0;
    let consecutiveProtectedFrames = 0;

    for (let f = 0; f < numFrames; f++) {
      const db = frameRmsDb[f];
      const zcr = frameZcr[f];
      const peak = framePeak[f];
      const isDigitalZero = peak <= config.digitalZeroPeakCeiling;

      // Whisper / soft consonant protection: audible low-volume speech above -54 dBFS
      // with speech-like ZCR (fricatives/whispers) or weak voicing periodicity must not be cut
      let isWhisperProtected = false;
      if (!isDigitalZero && db > -54.0 && db > noiseFloorDbfs + 2.5) {
        if (zcr >= config.whisperProtectionZcrThreshold && zcr <= 0.48) {
          isWhisperProtected = true;
        } else if (db > -48.0) {
          const frameStart = f * hopSamples;
          const periodicity = this.estimateFramePeriodicity(
            pcmMono,
            frameStart,
            Math.min(pcmMono.length, frameStart + frameSamples * 2),
            sampleRate,
          );
          if (periodicity >= 0.44) {
            isWhisperProtected = true;
          }
        }
      }

      if (isWhisperProtected) {
        consecutiveProtectedFrames++;
        if (consecutiveProtectedFrames === 4) {
          protectedLowVolumeSpanCount++;
        }
      } else {
        consecutiveProtectedFrames = 0;
      }

      if (!inSilence) {
        if ((db <= enterSilenceDb || isDigitalZero) && !isWhisperProtected) {
          inSilence = true;
          runStart = f;
        }
      } else {
        if ((db > exitSilenceDb && !isDigitalZero) || isWhisperProtected) {
          rawRuns.push({ startFrame: runStart, endFrame: f });
          inSilence = false;
          runStart = -1;
        }
      }
    }

    if (inSilence && runStart !== -1) {
      rawRuns.push({ startFrame: runStart, endFrame: numFrames });
    }

    const sortedTokens = [...tokens].sort((a, b) => a.range.start - b.range.start);
    const detections: SilencePauseDetection[] = [];
    let vadChecked = false;

    for (const run of rawRuns) {
      const relStartSec = (run.startFrame * hopSamples) / sampleRate;
      const relEndSec = Math.min(
        windowDurationSec,
        (run.endFrame * hopSamples + frameSamples) / sampleRate,
      );
      const startSec = Number((offsetSeconds + relStartSec).toFixed(4));
      const endSec = Number((offsetSeconds + relEndSec).toFixed(4));
      const durationSec = Number((endSec - startSec).toFixed(4));
      const durationMs = durationSec * 1000;

      if (durationMs < 140) continue; // Ignore micro-closure stops (e.g. Persian /p/, /t/, /k/)

      // Aggregate acoustic stats over this silence run
      let sumDb = 0;
      let maxPeak = 0;
      let sumZeroFrac = 0;
      let sumZcr = 0;
      const frameCount = Math.max(1, run.endFrame - run.startFrame);
      for (let f = run.startFrame; f < run.endFrame; f++) {
        sumDb += frameRmsDb[f];
        if (framePeak[f] > maxPeak) maxPeak = framePeak[f];
        sumZeroFrac += frameZeroFrac[f];
        sumZcr += frameZcr[f];
      }
      const meanRmsDb = Number((sumDb / frameCount).toFixed(1));
      const peakDb = Number((20 * Math.log10(Math.max(maxPeak, 1e-9))).toFixed(1));
      const digitalZeroRatio = Number((sumZeroFrac / frameCount).toFixed(3));
      const meanZcr = Number((sumZcr / frameCount).toFixed(4));

      // Optional VAD verification on candidate span (downsample to 16kHz if needed)
      let vadSpeechRatio: number | undefined;
      let vadActiveOverlap = false;
      if (vadProvider) {
        const sSample = Math.max(0, Math.floor(relStartSec * sampleRate));
        const eSample = Math.min(pcmMono.length, Math.floor(relEndSec * sampleRate));
        if (eSample - sSample >= Math.floor(sampleRate * 0.04)) {
          const slice16k = this.resampleTo16kLightweight(
            pcmMono.subarray(sSample, eSample),
            sampleRate,
          );
          const vad = await vadProvider.detectVoiceActivity(slice16k);
          vadChecked = true;
          vadSpeechRatio = vad.speechRatio;
          vadActiveOverlap = vad.hasSpeech && vad.speechRatio >= 0.15;
        }
      }

      // Check token alignment & surrounding lexical context
      const { prevTok, nextTok, overlapsSpeechToken } = this.findTokenContext(
        sortedTokens,
        startSec,
        endSec,
        trackId,
      );

      // If a real spoken token covers >65% of this interval and it is not digital zero,
      // treat as whisper-protected low-volume speech rather than silence.
      const isDigitalZeroFailure =
        digitalZeroRatio >= 0.98 && maxPeak <= config.digitalZeroPeakCeiling;
      if (overlapsSpeechToken && !isDigitalZeroFailure && durationMs < 600) {
        protectedLowVolumeSpanCount++;
        continue;
      }

      const overlapsBreath = breathRangesSec.some(
        (b) => Math.min(b.endSec, endSec) > Math.max(b.startSec, startSec) - 0.08,
      );
      const isEdgeSilence =
        startSec <= 0.05 || Math.abs(totalDurationSec - endSec) <= 0.08;
      const prevNorm = prevTok
        ? prevTok.normalizedText.replace(/[،؛.!؟«»()[\]\u200c\s]/g, '')
        : '';
      const isMidClause = prevTok !== null && MID_CLAUSE_HESITATION_WORDS.has(prevNorm);
      const isSentenceBoundary =
        prevTok !== null && /[.!؟؛]$/.test(prevTok.displayText.trim());

      // Classify exact silence/pause subtype
      let subtype: SilencePauseDetection['subtype'];
      let eligibleForShortening = false;
      let requiresHumanReview = false;
      let targetRetainedPauseSec = 0.25;
      let linguisticScore: number | null = null;
      let explanationFa = '';

      if (isDigitalZeroFailure) {
        subtype = 'INPUT_FAILURE_OR_DIGITAL_ZERO';
        eligibleForShortening = false;
        requiresHumanReview = true;
        explanationFa = `قطع سیگنال یا صفر دیجیتال کامل (${durationSec.toFixed(2)}s)؛ احتمال قطعی میکروفون یا افت ورودی — نیازمند بررسی انسانی.`;
      } else if (isEdgeSilence && durationMs >= 350) {
        subtype = 'EDGE_SILENCE';
        eligibleForShortening = durationMs >= 500;
        requiresHumanReview = false;
        targetRetainedPauseSec = 0.12;
        explanationFa = `سکوت ابتدای/انتهای فایل به مدت ${durationSec.toFixed(2)} ثانیه (با حفظ حاشیه ایمن ${config.silenceBoundaryPaddingMs}ms).`;
      } else if (durationMs >= config.recordingGapMinMs) {
        subtype = 'RECORDING_GAP';
        eligibleForShortening = true;
        requiresHumanReview = true;
        targetRetainedPauseSec = 0.45;
        explanationFa = `وقفه بسیار طولانی ضبط (${durationSec.toFixed(2)}s)؛ پیشنهاد کوتاه‌سازی با حفظ مکث طبیعی و بررسی کاربر.`;
      } else if (overlapsBreath && durationMs < config.longSilenceMinMs) {
        subtype = 'BREATH_RELATED_PAUSE';
        eligibleForShortening = false;
        requiresHumanReview = true;
        explanationFa = `مکث مرتبط با تنفس طبیعی گوینده (${Math.round(durationMs)}ms) — کوتاه‌سازی خودکار توصیه نمی‌شود.`;
      } else if (isMidClause && durationMs >= config.midClauseHesitationMinMs) {
        subtype = 'HESITATION_PAUSE';
        eligibleForShortening = true;
        requiresHumanReview = durationMs < 750;
        targetRetainedPauseSec = 0.16;
        linguisticScore = 0.84;
        explanationFa = `مکث تردیدی در میانه عبارت پس از «${prevTok?.displayText ?? ''}» (${Math.round(durationMs)}ms)؛ پیشنهاد کوتاه‌سازی با حفظ حاشیه آوایی.`;
      } else if (durationMs <= config.naturalShortPauseMaxMs) {
        subtype = 'NATURAL_SHORT_PAUSE';
        eligibleForShortening = false;
        requiresHumanReview = false;
        explanationFa = `مکث کوتاه طبیعی بین گفتار (${Math.round(durationMs)}ms) — حفظ برای طبیعی ماندن ریتم.`;
      } else if (isSentenceBoundary && durationMs <= config.sentenceBoundaryPauseMaxMs) {
        subtype = 'SENTENCE_BOUNDARY_PAUSE';
        eligibleForShortening = false;
        requiresHumanReview = false;
        linguisticScore = 0.78;
        explanationFa = `مکث طبیعی پایان جمله (${Math.round(durationMs)}ms) — حفظ برای تنفس و مرزبندی معنایی.`;
      } else if (durationMs >= config.longSilenceMinMs) {
        subtype = 'LONG_UNNECESSARY_SILENCE';
        eligibleForShortening = true;
        requiresHumanReview = vadActiveOverlap;
        targetRetainedPauseSec = isSentenceBoundary ? 0.38 : 0.24;
        explanationFa = `سکوت طولانی غیرضروری (${durationSec.toFixed(2)}s، کف نویز ${noiseFloorDbfs}dBFS)؛ قابل کوتاه‌سازی تا ${Math.round(targetRetainedPauseSec * 1000)}ms با حفظ حاشیه ایمن.`;
      } else {
        subtype = 'UTTERANCE_INTERNAL_SILENCE';
        eligibleForShortening = false;
        requiresHumanReview = true;
        explanationFa = `سکوت میانه عبارت (${Math.round(durationMs)}ms) — در آستانه طبیعی/تردید؛ نیازمند بررسی انسانی.`;
      }

      // Compute padded candidate shortening bounds (never trims speech edges)
      const paddingSec = config.silenceBoundaryPaddingMs / 1000;
      let candidateStartSec: number | undefined;
      let candidateEndSec: number | undefined;
      if (eligibleForShortening && !vadActiveOverlap) {
        const safeStart = startSec + paddingSec;
        const safeEnd = endSec - Math.max(paddingSec, targetRetainedPauseSec - paddingSec);
        if (safeEnd - safeStart >= 0.08) {
          candidateStartSec = Number(safeStart.toFixed(4));
          candidateEndSec = Number(safeEnd.toFixed(4));
        } else {
          eligibleForShortening = false;
        }
      } else if (vadActiveOverlap) {
        eligibleForShortening = false;
        requiresHumanReview = true;
      }

      const snrMarginBelowExit = Math.max(0, exitSilenceDb - meanRmsDb);
      const baseAcousticScore = isDigitalZeroFailure
        ? 0.94
        : Math.min(0.92, 0.62 + Math.min(0.25, snrMarginBelowExit * 0.015) + (durationMs >= 950 ? 0.05 : 0));
      const acousticScore = vadActiveOverlap
        ? Number(Math.max(0.32, baseAcousticScore - 0.42).toFixed(3))
        : Number(baseAcousticScore.toFixed(3));

      const detectionState: SpeechEventDetectionState = vadActiveOverlap
        ? 'UNCERTAIN'
        : isDigitalZeroFailure || durationMs >= config.longSilenceMinMs || isMidClause
          ? 'DETECTED'
          : 'PROBABLE';

      const uncertaintyState: SpeechEventUncertaintyState = vadActiveOverlap
        ? 'CONFLICTING_EVIDENCE'
        : subtype === 'UTTERANCE_INTERNAL_SILENCE'
          ? 'MODERATE_UNCERTAINTY'
          : 'LOW_UNCERTAINTY';

      detections.push({
        id: `sil_${Math.round(startSec * 1000)}_${Math.round(endSec * 1000)}`,
        trackId,
        subtype,
        detectionState,
        uncertaintyState,
        fullRange: {
          start: TimeMath.secondsToFlicks(startSec),
          end: TimeMath.secondsToFlicks(endSec),
        },
        startSec,
        endSec,
        durationSec,
        candidateStartSec,
        candidateEndSec,
        acousticScore,
        linguisticScore,
        acousticEvidence: {
          rmsDb: meanRmsDb,
          peakDb,
          noiseFloorDbfs,
          zcrRatio: meanZcr,
          digitalZeroRatio,
          vadSpeechRatio,
          vadActiveOverlap,
          hysteresisApplied: true,
          boundaryPaddingMs: config.silenceBoundaryPaddingMs,
          isWhisperOrLowVolumeProtected: false,
          notes: [
            `آستانه ورود به سکوت: ${enterSilenceDb.toFixed(1)}dBFS، خروج (هیسترزیس): ${exitSilenceDb.toFixed(1)}dBFS`,
            prevTok || nextTok
              ? `مجاور واژگان: «${prevTok?.displayText ?? 'ابتدا'}» ... «${nextTok?.displayText ?? 'انتها'}»`
              : 'تحلیل صرفاً آکوستیک بدون توکن مجاور',
          ],
        },
        eligibleForShortening,
        requiresHumanReview,
        explanationFa,
      });
    }

    return {
      noiseFloorDbfs,
      noiseFloorRms,
      vadChecked,
      detections,
      protectedLowVolumeSpanCount,
    };
  }

  private static findTokenContext(
    sortedTokens: readonly TimedPersianToken[],
    startSec: number,
    endSec: number,
    trackId: string,
  ): {
    prevTok: TimedPersianToken | null;
    nextTok: TimedPersianToken | null;
    overlapsSpeechToken: boolean;
  } {
    let prevTok: TimedPersianToken | null = null;
    let nextTok: TimedPersianToken | null = null;
    let maxOverlapRatio = 0;
    const spanDur = Math.max(1e-6, endSec - startSec);

    for (const tok of sortedTokens) {
      if (tok.trackId !== trackId) continue;
      const tStart = TimeMath.flicksToSeconds(tok.range.start);
      const tEnd = TimeMath.flicksToSeconds(tok.range.end);

      const overlap = Math.min(endSec, tEnd) - Math.max(startSec, tStart);
      if (overlap > 0) {
        const ratio = overlap / spanDur;
        if (ratio > maxOverlapRatio) maxOverlapRatio = ratio;
      }

      if (tEnd <= startSec + 0.08) {
        prevTok = tok;
      } else if (tStart >= endSec - 0.08 && !nextTok) {
        nextTok = tok;
      }
    }

    return {
      prevTok,
      nextTok,
      overlapsSpeechToken: maxOverlapRatio >= 0.65,
    };
  }

  private static estimateFramePeriodicity(
    pcm: Float32Array,
    start: number,
    end: number,
    sampleRate: number,
  ): number {
    const len = end - start;
    const minLag = Math.max(2, Math.floor(sampleRate / 340));
    const maxLag = Math.min(len - 2, Math.floor(sampleRate / 80));
    if (maxLag <= minLag) return 0;

    let bestCorr = 0;
    const step = sampleRate >= 32000 ? 2 : 1;
    for (let lag = minLag; lag <= maxLag; lag += step) {
      let dot = 0;
      let e1 = 0;
      let e2 = 0;
      const lim = len - lag;
      for (let i = 0; i < lim; i += 2) {
        const a = pcm[start + i];
        const b = pcm[start + i + lag];
        dot += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const corr = dot / (Math.sqrt(e1 * e2) + 1e-12);
      if (corr > bestCorr) bestCorr = corr;
    }
    return bestCorr;
  }

  private static resampleTo16kLightweight(
    input: Float32Array,
    sourceSampleRate: number,
  ): Float32Array {
    if (sourceSampleRate === 16000) return input;
    const ratio = sourceSampleRate / 16000;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = Math.min(input.length - 1, Math.floor(i * ratio));
      out[i] = input[srcIdx];
    }
    return out;
  }
}
