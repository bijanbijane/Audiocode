import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import { TimedPersianToken } from './PersianTextNormalizer';
import type {
  SpeechEventAcousticEvidence,
  SpeechEventCategory,
  SpeechEventDetectionMethod,
  SpeechEventDetectionState,
  SpeechEventSubtype,
  SpeechEventUncertaintyState,
} from './speech-events/SpeechEventContracts';

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

export interface NonVerbalEventModelAdapter {
  readonly modelId: string;
  readonly modelVersion: string;
  classifyGapWindow(
    pcmMono: Float32Array,
    sampleRate: SampleRate,
  ): Promise<{
    subtype: SpeechEventSubtype;
    modelConfidence: number;
    label: string;
  } | null>;
}

export interface DetailedNonVerbalDetection {
  readonly eventId: string;
  readonly trackId: string;
  readonly category: Extract<SpeechEventCategory, 'BREATH' | 'NON_VERBAL_VOCALIZATION' | 'UNCERTAIN_SPEECH_EVENT'>;
  readonly subtype: SpeechEventSubtype;
  readonly detectionState: SpeechEventDetectionState;
  readonly detectionMethod: SpeechEventDetectionMethod;
  readonly uncertaintyState: SpeechEventUncertaintyState;
  readonly range: TimeRange;
  readonly recommendedAction: NonVerbalRecommendedAction;
  readonly heuristicScore: number | null;
  readonly modelConfidence: number | null;
  readonly acousticEvidence: SpeechEventAcousticEvidence;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly requiresHumanReview: boolean;
  readonly descriptionFa: string;
}

export interface RejectedNonVocalCandidate {
  readonly range: TimeRange;
  readonly rejectedAs: 'KEYBOARD_OR_MECHANICAL_TRANSIENT' | 'BACKGROUND_NOISE' | 'MIC_HANDLING_THUMP';
  readonly reasonFa: string;
  readonly acousticEvidence: SpeechEventAcousticEvidence;
}

export interface DetailedNonVerbalScanResult {
  readonly events: readonly DetailedNonVerbalDetection[];
  readonly rejectedCandidates: readonly RejectedNonVocalCandidate[];
  readonly capabilityMode: 'heuristic' | 'model-based' | 'unsupported';
  readonly limitationNote: string;
}

/**
 * Non-Verbal Vocal Event Detector for Persian Podcasts & Audiobooks
 * Uses explicit multi-band DSP features (energy, crest factor, ZCR, Goertzel spectral bands,
 * envelope modulation bursts, and periodicity) and strictly separates heuristic detection
 * from trained model-based classification.
 */
export class NonVerbalVocalEventDetector {
  /**
   * Scans inter-word gaps for coughs, throat clearing, and sharp inhale breaths.
   * Preserved for backward compatibility with existing callers/tests.
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

  /**
   * Honest multi-class heuristic (or optional external model-based) non-verbal vocal event detector.
   * Rejects keyboard clicks, mechanical transients, mic-handling bumps, and stationary room noise.
   * Never fabricates neural model confidence when no trained classifier is loaded.
   */
  public static async detectDetailedNonVerbalEvents(params: {
    readonly pcmMono: Float32Array;
    readonly tokens: readonly TimedPersianToken[];
    readonly sampleRate: SampleRate;
    readonly trackId?: string;
    readonly offsetSeconds?: number;
    readonly detectionMode?: 'auto' | 'heuristic' | 'model-based';
    readonly modelAdapter?: NonVerbalEventModelAdapter | null;
    readonly noiseFloorRms?: number;
  }): Promise<DetailedNonVerbalScanResult> {
    const {
      pcmMono,
      tokens,
      sampleRate,
      trackId = tokens[0]?.trackId ?? 'track-1',
      offsetSeconds = 0,
      detectionMode = 'auto',
      modelAdapter = null,
    } = params;

    if (detectionMode === 'model-based' && !modelAdapter) {
      const endSec = offsetSeconds + pcmMono.length / sampleRate;
      return {
        events: [
          {
            eventId: `nv_unsupported_${Math.round(offsetSeconds * 1000)}`,
            trackId,
            category: 'UNCERTAIN_SPEECH_EVENT',
            subtype: 'UNSUPPORTED_DETECTOR',
            detectionState: 'UNSUPPORTED',
            detectionMethod: 'UNSUPPORTED_NO_MODEL',
            uncertaintyState: 'UNSUPPORTED_CAPABILITY',
            range: {
              start: TimeMath.secondsToFlicks(offsetSeconds),
              end: TimeMath.secondsToFlicks(endSec),
            },
            recommendedAction: 'KEEP_OR_USER_REVIEW',
            heuristicScore: null,
            modelConfidence: null,
            acousticEvidence: {},
            modelId: null,
            modelVersion: null,
            requiresHumanReview: true,
            descriptionFa:
              'مدل عصبی طبقه‌بندی رویدادهای غیرکلامی بارگذاری نشده است؛ نبود تشخیص مدل نباید نبود رویداد تلقی شود.',
          },
        ],
        rejectedCandidates: [],
        capabilityMode: 'unsupported',
        limitationNote:
          'No trained non-verbal vocal event neural model is installed; model-based classification is UNSUPPORTED.',
      };
    }

    if (pcmMono.length < Math.floor(sampleRate * 0.08)) {
      return {
        events: [],
        rejectedCandidates: [],
        capabilityMode: modelAdapter ? 'model-based' : 'heuristic',
        limitationNote:
          modelAdapter
            ? `Model adapter ${modelAdapter.modelId} active.`
            : 'Heuristic acoustic signal classifier active (no trained neural event model installed).',
      };
    }

    const noiseFloorRms = params.noiseFloorRms ?? this.estimateNoiseFloorRms(pcmMono, sampleRate);
    const gaps = this.collectAnalysisGaps(pcmMono.length, tokens, sampleRate, offsetSeconds);
    const events: DetailedNonVerbalDetection[] = [];
    const rejectedCandidates: RejectedNonVocalCandidate[] = [];

    const frameSamples = Math.max(128, Math.floor(sampleRate * 0.02)); // 20ms

    for (const gap of gaps) {
      const gapLen = gap.endSample - gap.startSample;
      if (gapLen < Math.floor(sampleRate * 0.07)) continue;

      // Find contiguous above-floor energy islands inside this gap
      const enterThresh = Math.max(noiseFloorRms * 2.6, 0.012);
      const exitThresh = Math.max(noiseFloorRms * 1.6, 0.007);

      let islandStart = -1;
      let silenceRunFrames = 0;

      for (let pos = gap.startSample; pos + frameSamples <= gap.endSample; pos += frameSamples) {
        let sumSq = 0;
        for (let i = pos; i < pos + frameSamples; i++) {
          const s = pcmMono[i];
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / frameSamples);

        if (islandStart === -1) {
          if (rms >= enterThresh) {
            islandStart = pos;
            silenceRunFrames = 0;
          }
        } else if (rms < exitThresh) {
          silenceRunFrames++;
          if (silenceRunFrames >= 4) {
            const islandEnd = pos - (silenceRunFrames - 1) * frameSamples;
            await this.evaluateIsland({
              pcmMono,
              sampleRate,
              trackId,
              offsetSeconds,
              islandStart,
              islandEnd,
              gap,
              noiseFloorRms,
              modelAdapter,
              events,
              rejectedCandidates,
            });
            islandStart = -1;
            silenceRunFrames = 0;
          }
        } else {
          silenceRunFrames = 0;
        }
      }

      if (islandStart !== -1) {
        await this.evaluateIsland({
          pcmMono,
          sampleRate,
          trackId,
          offsetSeconds,
          islandStart,
          islandEnd: gap.endSample,
          gap,
          noiseFloorRms,
          modelAdapter,
          events,
          rejectedCandidates,
        });
      }
    }

    return {
      events,
      rejectedCandidates,
      capabilityMode: modelAdapter ? 'model-based' : 'heuristic',
      limitationNote: modelAdapter
        ? `Classified via model adapter ${modelAdapter.modelId}@${modelAdapter.modelVersion}.`
        : 'Classified via conservative multi-feature acoustic heuristics (no trained neural event model installed; scores are uncalibrated).',
    };
  }

  private static async evaluateIsland(params: {
    pcmMono: Float32Array;
    sampleRate: SampleRate;
    trackId: string;
    offsetSeconds: number;
    islandStart: number;
    islandEnd: number;
    gap: { startSample: number; endSample: number; distToNextWordMs: number; distFromPrevWordMs: number };
    noiseFloorRms: number;
    modelAdapter: NonVerbalEventModelAdapter | null;
    events: DetailedNonVerbalDetection[];
    rejectedCandidates: RejectedNonVocalCandidate[];
  }): Promise<void> {
    const {
      pcmMono,
      sampleRate,
      trackId,
      offsetSeconds,
      islandStart,
      islandEnd,
      gap,
      noiseFloorRms,
      modelAdapter,
      events,
      rejectedCandidates,
    } = params;

    const len = islandEnd - islandStart;
    const durationMs = (len / sampleRate) * 1000;
    if (durationMs < 20) return;

    const absRange: TimeRange = {
      start: TimeMath.secondsToFlicks(offsetSeconds + islandStart / sampleRate),
      end: TimeMath.secondsToFlicks(offsetSeconds + islandEnd / sampleRate),
    };

    // Compute time-domain stats
    let sumSq = 0;
    let peak = 0;
    let zcr = 0;
    for (let i = islandStart; i < islandEnd; i++) {
      const s = pcmMono[i];
      const abs = Math.abs(s);
      sumSq += s * s;
      if (abs > peak) peak = abs;
      if (i > islandStart && ((pcmMono[i - 1] >= 0 && s < 0) || (pcmMono[i - 1] < 0 && s >= 0))) {
        zcr++;
      }
    }
    const rms = Math.sqrt(sumSq / len);
    const rmsDb = Number((20 * Math.log10(rms + 1e-9)).toFixed(1));
    const peakDb = Number((20 * Math.log10(peak + 1e-9)).toFixed(1));
    const crestFactor = Number((peak / (rms + 1e-9)).toFixed(2));
    const zcrRatio = Number((zcr / len).toFixed(4));
    const noiseFloorDbfs = Number((20 * Math.log10(noiseFloorRms + 1e-9)).toFixed(1));

    // Spectral band energy via Goertzel probe frequencies (no huge FFT buffers)
    const segment = pcmMono.subarray(islandStart, islandEnd);
    const lowRump = this.measureBandPower(segment, sampleRate, [55, 85, 110]);
    const speechBody = this.measureBandPower(segment, sampleRate, [180, 320, 520, 850]);
    const fricativeBand = this.measureBandPower(segment, sampleRate, [1800, 2600, 3500, 4400]);
    const highTransient = this.measureBandPower(segment, sampleRate, [5500, 6800, 7600]);
    const totalProbe = Math.max(1e-12, lowRump + speechBody + fricativeBand + highTransient);

    const lowBandEnergyRatio = Number((lowRump / totalProbe).toFixed(3));
    const midSpeechBandEnergyRatio = Number((speechBody / totalProbe).toFixed(3));
    const fricativeBandEnergyRatio = Number((fricativeBand / totalProbe).toFixed(3));
    const highTransientEnergyRatio = Number((highTransient / totalProbe).toFixed(3));

    // Envelope modulation / burst counting (15ms sub-frames)
    const { burstCount, envelopeCv, firstHalfRms, secondHalfRms } = this.analyzeEnvelopeModulation(
      segment,
      sampleRate,
    );
    const periodicityScore = this.estimatePeriodicity(segment, sampleRate);

    const acousticEvidence: SpeechEventAcousticEvidence = {
      rmsDb,
      peakDb,
      noiseFloorDbfs,
      crestFactor,
      zcrRatio,
      lowBandEnergyRatio,
      midSpeechBandEnergyRatio,
      fricativeBandEnergyRatio,
      highTransientEnergyRatio,
      periodicityScore: Number(periodicityScore.toFixed(3)),
      rhythmBurstCount: burstCount,
    };

    // Optional real external model adapter path
    if (modelAdapter) {
      const pred = await modelAdapter.classifyGapWindow(segment, sampleRate);
      if (pred) {
        const cat =
          pred.subtype === 'AUDIBLE_INHALATION' || pred.subtype === 'AUDIBLE_EXHALATION'
            ? 'BREATH'
            : 'NON_VERBAL_VOCALIZATION';
        events.push({
          eventId: `nv_model_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
          trackId,
          category: cat,
          subtype: pred.subtype,
          detectionState: pred.modelConfidence >= 0.75 ? 'DETECTED' : 'PROBABLE',
          detectionMethod: 'MODEL_BASED',
          uncertaintyState: pred.modelConfidence >= 0.75 ? 'LOW_UNCERTAINTY' : 'MODERATE_UNCERTAINTY',
          range: absRange,
          recommendedAction:
            pred.subtype === 'COUGH' || pred.subtype === 'THROAT_CLEARING'
              ? 'REPLACE_WITH_ROOM_TONE'
              : pred.subtype === 'AUDIBLE_INHALATION'
                ? 'ATTENUATE_GAIN_10DB'
                : 'KEEP_OR_USER_REVIEW',
          heuristicScore: null,
          modelConfidence: Number(pred.modelConfidence.toFixed(3)),
          acousticEvidence,
          modelId: modelAdapter.modelId,
          modelVersion: modelAdapter.modelVersion,
          requiresHumanReview: pred.modelConfidence < 0.85,
          descriptionFa: pred.label,
        });
        return;
      }
    }

    // --- Noise & Non-Vocal Rejection Gates ---
    // 1. Keyboard click / mechanical transient: ultra-short (< 60ms) sharp spike OR >5.5kHz dominated with tiny vocal body
    if (
      (durationMs < 55 && crestFactor >= 3.2 && midSpeechBandEnergyRatio < 0.35) ||
      (highTransientEnergyRatio >= 0.48 && midSpeechBandEnergyRatio < 0.2 && durationMs < 130)
    ) {
      rejectedCandidates.push({
        range: absRange,
        rejectedAs: 'KEYBOARD_OR_MECHANICAL_TRANSIENT',
        reasonFa: `ضربه کوتاه یا کلید صفحه‌کلید (${Math.round(durationMs)}ms، انرژی فرکانس بالا ${Math.round(highTransientEnergyRatio * 100)}٪) از رویداد آوایی تفکیک و رد شد.`,
        acousticEvidence,
      });
      return;
    }

    // 2. Stationary background noise / steady room hum: flat envelope (low CV) & low SNR over floor
    if (envelopeCv < 0.14 && rms < noiseFloorRms * 4.2 && durationMs >= 160 && periodicityScore < 0.45) {
      rejectedCandidates.push({
        range: absRange,
        rejectedAs: 'BACKGROUND_NOISE',
        reasonFa: `نویز محیطی پایدار با واریانس پوش پایین (CV=${envelopeCv.toFixed(2)}) است و رویداد آوایی محسوب نمی‌شود.`,
        acousticEvidence,
      });
      return;
    }

    // 3. Microphone handling bump: sub-120Hz dominant thump without breath fricative or speech harmonicity
    if (lowBandEnergyRatio >= 0.58 && fricativeBandEnergyRatio < 0.12 && periodicityScore < 0.35) {
      rejectedCandidates.push({
        range: absRange,
        rejectedAs: 'MIC_HANDLING_THUMP',
        reasonFa: 'کوبش بم لمس میکروفون (<120Hz) شناسایی و از رویدادهای حنجره‌ای تفکیک شد.',
        acousticEvidence,
      });
      return;
    }

    // --- Heuristic Vocal Event Classification ---
    // 1. Laughter: >= 3 rhythmic amplitude bursts across >= 350ms with voiced harmonicity
    if (burstCount >= 3 && durationMs >= 320 && (midSpeechBandEnergyRatio >= 0.3 || periodicityScore >= 0.42)) {
      events.push({
        eventId: `nv_laugh_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'NON_VERBAL_VOCALIZATION',
        subtype: 'LAUGHTER',
        detectionState: 'PROBABLE',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'MODERATE_UNCERTAINTY',
        range: absRange,
        recommendedAction: 'KEEP_OR_USER_REVIEW',
        heuristicScore: Number(Math.min(0.84, 0.55 + burstCount * 0.06).toFixed(3)),
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa: `خنده محتمل (${burstCount} ضرب‌آهنگ متوالی در ${Math.round(durationMs)}ms) — حفظ یا بررسی توسط کاربر`,
      });
      return;
    }

    // 2. Cough: high impulsive peak (> -14dB), high crest factor (> 3.8), short/medium burst with vocal body
    if (peakDb > -14.0 && crestFactor >= 3.8 && durationMs >= 65 && durationMs <= 650 && (midSpeechBandEnergyRatio >= 0.18 || zcrRatio >= 0.08)) {
      events.push({
        eventId: `nv_cough_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'NON_VERBAL_VOCALIZATION',
        subtype: 'COUGH',
        detectionState: 'PROBABLE',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'MODERATE_UNCERTAINTY',
        range: absRange,
        recommendedAction: 'REPLACE_WITH_ROOM_TONE',
        heuristicScore: Number(Math.min(0.86, 0.62 + (crestFactor - 3.5) * 0.06).toFixed(3)),
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa: 'سرفه انفجاری محتمل بین عبارات (تحلیل آکوستیک هیوریستیک؛ پیشنهاد جایگزینی با Room Tone)',
      });
      return;
    }

    // 3. Throat clearing: rough raspy voiced/noise burst 160-650ms with lower crest than cough and vocal body
    if (
      durationMs >= 160 &&
      durationMs <= 650 &&
      rmsDb >= -30.0 &&
      crestFactor >= 2.2 &&
      crestFactor < 4.5 &&
      midSpeechBandEnergyRatio >= 0.32 &&
      periodicityScore >= 0.35 &&
      fricativeBandEnergyRatio >= 0.14
    ) {
      events.push({
        eventId: `nv_throat_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'NON_VERBAL_VOCALIZATION',
        subtype: 'THROAT_CLEARING',
        detectionState: 'PROBABLE',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'MODERATE_UNCERTAINTY',
        range: absRange,
        recommendedAction: 'REPLACE_WITH_ROOM_TONE',
        heuristicScore: 0.72,
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa: 'صاف‌کردن گلو محتمل (هیوریستیک آکوستیک؛ پیشنهاد بررسی و جایگزینی با Room Tone)',
      });
      return;
    }

    // 4. Sigh: sustained breathy/voiced decay >= 380ms with gentle crest & falling envelope
    if (
      durationMs >= 380 &&
      rmsDb >= -40.0 &&
      rmsDb <= -16.0 &&
      crestFactor < 3.6 &&
      secondHalfRms <= firstHalfRms * 0.92 &&
      (fricativeBandEnergyRatio >= 0.18 || periodicityScore >= 0.3)
    ) {
      events.push({
        eventId: `nv_sigh_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'NON_VERBAL_VOCALIZATION',
        subtype: 'SIGH',
        detectionState: 'POSSIBLE',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'HIGH_UNCERTAINTY',
        range: absRange,
        recommendedAction: 'KEEP_OR_USER_REVIEW',
        heuristicScore: 0.64,
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa: `آه یا بازدم کشیده (${Math.round(durationMs)}ms) — اطلاع‌رسانی بدون حذف خودکار`,
      });
      return;
    }

    // 5. Breath: Audible Inhalation (pre-word, sharp fricative/ZCR) vs Exhalation (post-word, softer tail)
    if (
      durationMs >= 90 &&
      durationMs <= 850 &&
      rmsDb >= -40.0 &&
      rmsDb <= -14.0 &&
      crestFactor < 3.8 &&
      (zcrRatio >= 0.1 || fricativeBandEnergyRatio >= 0.28)
    ) {
      const distAfterIslandToNextWordMs =
        gap.distToNextWordMs + ((gap.endSample - islandEnd) / sampleRate) * 1000;
      const distBeforeIslandFromPrevWordMs =
        gap.distFromPrevWordMs + ((islandStart - gap.startSample) / sampleRate) * 1000;
      const isPreWordInhale = distAfterIslandToNextWordMs <= 340 || secondHalfRms >= firstHalfRms * 0.85;
      const subtype: SpeechEventSubtype =
        !isPreWordInhale && distBeforeIslandFromPrevWordMs <= 340
          ? 'AUDIBLE_EXHALATION'
          : 'AUDIBLE_INHALATION';

      events.push({
        eventId: `nv_breath_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'BREATH',
        subtype,
        detectionState: 'PROBABLE',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'MODERATE_UNCERTAINTY',
        range: absRange,
        recommendedAction:
          subtype === 'AUDIBLE_INHALATION' ? 'ATTENUATE_GAIN_10DB' : 'KEEP_OR_USER_REVIEW',
        heuristicScore: Number(Math.min(0.8, 0.58 + fricativeBandEnergyRatio * 0.35).toFixed(3)),
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa:
          subtype === 'AUDIBLE_INHALATION'
            ? 'دم شنیداری پیش از عبارت (تحلیل هیوریستیک؛ پیشنهاد کاهش نرم 10dB در صورت نیاز)'
            : 'بازدم شنیداری پس از عبارت (پیشنهاد بررسی یا حفظ طبیعی بودن)',
      });
      return;
    }

    // 6. Crying / sustained tremulous vocalization
    if (durationMs >= 700 && periodicityScore >= 0.45 && burstCount >= 2 && midSpeechBandEnergyRatio >= 0.35) {
      events.push({
        eventId: `nv_cry_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'NON_VERBAL_VOCALIZATION',
        subtype: 'CRYING',
        detectionState: 'POSSIBLE',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'HIGH_UNCERTAINTY',
        range: absRange,
        recommendedAction: 'KEEP_OR_USER_REVIEW',
        heuristicScore: 0.54,
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa: 'آوای احساسی یا لرزش صدای ممتد (هیوریستیک؛ نیازمند بازبینی انسانی)',
      });
      return;
    }

    // 7. Ambiguous above-floor acoustic event -> UNCERTAIN_NON_VERBAL
    if (durationMs >= 100 && rmsDb >= -34.0) {
      events.push({
        eventId: `nv_uncertain_${Math.round(offsetSeconds * 1000)}_${islandStart}`,
        trackId,
        category: 'NON_VERBAL_VOCALIZATION',
        subtype: 'UNCERTAIN_NON_VERBAL',
        detectionState: 'UNCERTAIN',
        detectionMethod: 'HEURISTIC_SIGNAL',
        uncertaintyState: 'HIGH_UNCERTAINTY',
        range: absRange,
        recommendedAction: 'KEEP_OR_USER_REVIEW',
        heuristicScore: 0.45,
        modelConfidence: null,
        acousticEvidence,
        modelId: null,
        modelVersion: null,
        requiresHumanReview: true,
        descriptionFa: 'صدای غیرکلامی نامشخص بین گفتار (قطعیت پایین؛ صرفاً اطلاع‌رسانی)',
      });
    }
  }

  private static collectAnalysisGaps(
    pcmLength: number,
    tokens: readonly TimedPersianToken[],
    sampleRate: SampleRate,
    offsetSeconds: number,
  ): Array<{ startSample: number; endSample: number; distToNextWordMs: number; distFromPrevWordMs: number }> {
    if (tokens.length === 0) {
      return [{ startSample: 0, endSample: pcmLength, distToNextWordMs: 1000, distFromPrevWordMs: 1000 }];
    }

    const sorted = [...tokens].sort((a, b) => a.range.start - b.range.start);
    const offsetFlicks = TimeMath.secondsToFlicks(offsetSeconds);
    const gaps: Array<{ startSample: number; endSample: number; distToNextWordMs: number; distFromPrevWordMs: number }> = [];

    let cursor = 0;
    for (let i = 0; i < sorted.length; i++) {
      const tokStartRel = Math.max(
        0,
        Math.min(pcmLength, TimeMath.flicksToSamplesFloor(sorted[i].range.start - offsetFlicks, sampleRate)),
      );
      const tokEndRel = Math.max(
        0,
        Math.min(pcmLength, TimeMath.flicksToSamplesFloor(sorted[i].range.end - offsetFlicks, sampleRate)),
      );
      if (tokStartRel > cursor) {
        gaps.push({
          startSample: cursor,
          endSample: tokStartRel,
          distFromPrevWordMs: i === 0 ? 1000 : 0,
          distToNextWordMs: 0,
        });
      }
      cursor = Math.max(cursor, tokEndRel);
    }

    if (cursor < pcmLength) {
      gaps.push({
        startSample: cursor,
        endSample: pcmLength,
        distFromPrevWordMs: 0,
        distToNextWordMs: 1000,
      });
    }
    return gaps;
  }

  private static estimateNoiseFloorRms(pcm: Float32Array, sampleRate: SampleRate): number {
    const frameLen = Math.max(1, Math.floor(sampleRate * 0.02));
    const vals: number[] = [];
    for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
      let sumSq = 0;
      for (let j = 0; j < frameLen; j++) {
        const s = pcm[i + j];
        sumSq += s * s;
      }
      const r = Math.sqrt(sumSq / frameLen);
      if (r > 1e-6) vals.push(r);
    }
    if (vals.length === 0) return 0.001;
    vals.sort((a, b) => a - b);
    return Math.max(0.0005, vals[Math.floor(vals.length * 0.1)]);
  }

  private static measureBandPower(
    segment: Float32Array,
    sampleRate: number,
    targetFreqsHz: readonly number[],
  ): number {
    const n = Math.min(segment.length, Math.floor(sampleRate * 0.15));
    if (n <= 8) return 0;
    let total = 0;
    for (const freq of targetFreqsHz) {
      if (freq >= sampleRate * 0.49) continue;
      const omega = (2 * Math.PI * freq) / sampleRate;
      const coeff = 2 * Math.cos(omega);
      let sPrev = 0;
      let sPrev2 = 0;
      for (let i = 0; i < n; i++) {
        const s = segment[i] + coeff * sPrev - sPrev2;
        sPrev2 = sPrev;
        sPrev = s;
      }
      const power = sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
      total += Math.max(0, power) / (n * n);
    }
    return total;
  }

  private static analyzeEnvelopeModulation(
    segment: Float32Array,
    sampleRate: number,
  ): { burstCount: number; envelopeCv: number; firstHalfRms: number; secondHalfRms: number } {
    const subLen = Math.max(64, Math.floor(sampleRate * 0.015));
    const rmsFrames: number[] = [];
    for (let i = 0; i + subLen <= segment.length; i += subLen) {
      let sumSq = 0;
      for (let j = 0; j < subLen; j++) {
        const s = segment[i + j];
        sumSq += s * s;
      }
      rmsFrames.push(Math.sqrt(sumSq / subLen));
    }
    if (rmsFrames.length === 0) {
      return { burstCount: 1, envelopeCv: 0, firstHalfRms: 0, secondHalfRms: 0 };
    }
    const maxRms = Math.max(...rmsFrames);
    const meanRms = rmsFrames.reduce((a, b) => a + b, 0) / rmsFrames.length;
    const variance =
      rmsFrames.reduce((acc, r) => acc + (r - meanRms) * (r - meanRms), 0) / rmsFrames.length;
    const envelopeCv = meanRms > 1e-8 ? Math.sqrt(variance) / meanRms : 0;

    // Count modulation bursts separated by deep dips (< 40% of peak frame RMS)
    const highThresh = maxRms * 0.48;
    const lowThresh = maxRms * 0.26;
    let inBurst = false;
    let burstCount = 0;
    for (const r of rmsFrames) {
      if (!inBurst && r >= highThresh) {
        inBurst = true;
        burstCount++;
      } else if (inBurst && r <= lowThresh) {
        inBurst = false;
      }
    }

    const mid = Math.max(1, Math.floor(rmsFrames.length / 2));
    const firstHalfRms = rmsFrames.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const secondHalfRms =
      rmsFrames.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, rmsFrames.length - mid);

    return { burstCount, envelopeCv, firstHalfRms, secondHalfRms };
  }

  private static estimatePeriodicity(segment: Float32Array, sampleRate: number): number {
    const frameSamples = Math.min(segment.length, Math.floor(sampleRate * 0.04));
    const minLag = Math.max(2, Math.floor(sampleRate / 350));
    const maxLag = Math.min(frameSamples - 2, Math.floor(sampleRate / 75));
    if (maxLag <= minLag) return 0;

    const offset = Math.max(0, Math.floor((segment.length - frameSamples) / 2));
    let bestCorr = 0;
    const step = sampleRate >= 32000 ? 2 : 1;
    for (let lag = minLag; lag <= maxLag; lag += step) {
      let dot = 0;
      let e1 = 0;
      let e2 = 0;
      const limit = frameSamples - lag;
      for (let i = 0; i < limit; i += 2) {
        const a = segment[offset + i];
        const b = segment[offset + i + lag];
        dot += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const corr = dot / (Math.sqrt(e1 * e2) + 1e-12);
      if (corr > bestCorr) bestCorr = corr;
    }
    return Math.max(0, Math.min(1, bestCorr));
  }
}
