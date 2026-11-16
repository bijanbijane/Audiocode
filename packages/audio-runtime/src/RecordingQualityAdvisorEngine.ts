import { SampleRate, TimeMath, TimeRange } from '../../../src/contracts/timebase.contract';
import { ProcessingNodeSpec } from '../../../src/processing-core/ProcessingGraphEngine';

export interface PlosiveOrSibilanceEvent {
  readonly kind: 'PLOSIVE_POP_LOW_FREQ' | 'HARSH_SIBILANCE_HIGH_FREQ';
  readonly range: TimeRange;
  readonly severityDb: number;
}

export interface RecordingAcousticDiagnosticReport {
  readonly has50HzMainsHum: boolean;
  readonly humFundamentalAndHarmonicsDb: { hz50: number; hz100: number; hz150: number };
  readonly plosivePopEvents: PlosiveOrSibilanceEvent[];
  readonly harshSibilanceEvents: PlosiveOrSibilanceEvent[];
  readonly signalToNoiseRatioDb: number;
  readonly recommendedGraphNodes: ProcessingNodeSpec[];
  readonly summaryAdviceFa: string[];
}

/**
 * Cold-Start Recording Acoustic Diagnostic & Graph Advisor Engine (Sections 2.4, 28 & 35 Group A)
 * - Detects Iranian 50Hz mains hum + 100Hz/150Hz harmonics in silence slices via windowed Goertzel O(N).
 * - Scans for low-frequency plosive pops (< 130Hz) and high-frequency sibilance (> 5kHz) using sample-rate invariant filters.
 * - Emits ready-to-wire ProcessingNodeSpec recommendations for the DAG graph.
 */
export class RecordingQualityAdvisorEngine {
  public static analyzeRecordingQuality(
    pcmMono: Float32Array,
    roomToneSlice: Float32Array,
    sampleRate: SampleRate,
  ): RecordingAcousticDiagnosticReport {
    const summaryAdviceFa: string[] = [];
    const recommendedGraphNodes: ProcessingNodeSpec[] = [];

    // 1. Windowed Goertzel detection for 50Hz mains hum and 100Hz/150Hz harmonics vs neighboring bins
    const p50 = this.computeGoertzelPowerDb(roomToneSlice, sampleRate, 50);
    const p100 = this.computeGoertzelPowerDb(roomToneSlice, sampleRate, 100);
    const p150 = this.computeGoertzelPowerDb(roomToneSlice, sampleRate, 150);
    const pRef65 = this.computeGoertzelPowerDb(roomToneSlice, sampleRate, 65);
    const pRef125 = this.computeGoertzelPowerDb(roomToneSlice, sampleRate, 125);

    const humProminenceDb = Math.max(p50 - pRef65, p100 - pRef125);
    const has50HzMainsHum = humProminenceDb >= 9.0 && Math.max(p50, p100) > -62.0;

    if (has50HzMainsHum) {
      summaryAdviceFa.push(
        `نویز هوم برق شهر (50Hz/100Hz) به شدت ${humProminenceDb.toFixed(1)}dB بالاتر از کف نویز اتاق شناسایی شد؛ فیلتر حذف هوم (Notch EQ) پیشنهاد می‌شود.`,
      );
      recommendedGraphNodes.push({
        id: 'auto_notch_50hz_hum',
        type: 'EQ_FILTER',
        version: '1.0.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: Math.floor(sampleRate * 0.05),
        tailSamples: 0,
        committedParameters: {
          mode: 'CASCADED_NOTCH',
          f1Hz: 50,
          f2Hz: 100,
          f3Hz: 150,
          qFactor: 12.0,
        },
      });
    }

    // 2. Plosive pops (< 130Hz) & Sibilance harshness (> 5kHz) scan
    const { plosives, sibilances, speechRmsDb } = this.scanPlosivesAndSibilance(
      pcmMono,
      sampleRate,
    );

    if (plosives.length > 0) {
      summaryAdviceFa.push(
        `تعداد ${plosives.length} ضربه باد دهان به میکروفون (Plosive Pop در حروف پ/ب/ت) شناسایی شد؛ فعال‌سازی فیلتر پویای فرکانس پایین پیشنهاد می‌شود.`,
      );
      recommendedGraphNodes.push({
        id: 'auto_plosive_dynamic_hpf',
        type: 'EQ_FILTER',
        version: '1.0.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: Math.floor(sampleRate * 0.03),
        tailSamples: 0,
        committedParameters: {
          mode: 'DYNAMIC_HIGH_PASS',
          cutoffHz: 110,
          slopeDbPerOct: 18,
        },
      });
    }

    if (sibilances.length > 3) {
      summaryAdviceFa.push(
        `تیزی بیش از حد در ادای حروف «س/ش/ز» (${sibilances.length} مورد) مشاهده شد؛ اعمال De-Esser نرم در بازه 6kHz پیشنهاد می‌شود.`,
      );
      recommendedGraphNodes.push({
        id: 'auto_persian_de_esser',
        type: 'COMPRESSOR',
        version: '1.0.0',
        enabled: true,
        latencySamples: 64,
        preRollSamples: Math.floor(sampleRate * 0.08),
        tailSamples: 0,
        committedParameters: {
          mode: 'BAND_SPLIT_DE_ESSER',
          centerFreqHz: 6400,
          thresholdDb: -24.0,
          maxReductionDb: 6.0,
        },
      });
    }

    // 3. Signal-to-Noise Ratio check
    const roomRmsDb = this.computeRmsDb(roomToneSlice);
    const signalToNoiseRatioDb = Number(Math.max(0, speechRmsDb - roomRmsDb).toFixed(1));

    if (signalToNoiseRatioDb < 28.0) {
      summaryAdviceFa.push(
        `نسبت سیگنال به نویز ضبط (${signalToNoiseRatioDb}dB) پایین‌تر از استاندارد استودیویی (35dB+) است؛ فعال‌سازی Noise Reduction پیشنهاد می‌شود.`,
      );
    }

    return {
      has50HzMainsHum,
      humFundamentalAndHarmonicsDb: {
        hz50: Number(p50.toFixed(1)),
        hz100: Number(p100.toFixed(1)),
        hz150: Number(p150.toFixed(1)),
      },
      plosivePopEvents: plosives,
      harshSibilanceEvents: sibilances,
      signalToNoiseRatioDb,
      recommendedGraphNodes,
      summaryAdviceFa,
    };
  }

  /**
   * Hann-windowed O(N) Goertzel power estimator minimizing adjacent-bin spectral leakage.
   */
  public static computeGoertzelPowerDb(
    samples: Float32Array,
    sampleRate: SampleRate,
    targetFreqHz: number,
  ): number {
    const n = samples.length;
    if (n === 0) return -100.0;

    const omega = (2.0 * Math.PI * targetFreqHz) / sampleRate;
    const coeff = 2.0 * Math.cos(omega);
    let s1 = 0.0;
    let s2 = 0.0;
    let windowSum = 0.0;

    for (let i = 0; i < n; i++) {
      const w = n > 1 ? 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (n - 1))) : 1.0;
      windowSum += w;
      const s0 = samples[i] * w + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }

    const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / Math.max(1.0, windowSum * windowSum * 0.25);
    return 10.0 * Math.log10(Math.max(1e-12, power));
  }

  private static scanPlosivesAndSibilance(
    pcm: Float32Array,
    sampleRate: SampleRate,
  ): {
    plosives: PlosiveOrSibilanceEvent[];
    sibilances: PlosiveOrSibilanceEvent[];
    speechRmsDb: number;
  } {
    const frameSamples = Math.max(1, Math.floor(sampleRate * 0.04)); // 40ms frames
    const plosives: PlosiveOrSibilanceEvent[] = [];
    const sibilances: PlosiveOrSibilanceEvent[] = [];

    let activeFramesEnergySum = 0;
    let activeFramesCount = 0;

    // Sample-rate invariant 1-pole filters: 130Hz LPF (plosives) & unity-passband 5000Hz HPF (sibilance)
    const lpAlpha = Math.exp((-2.0 * Math.PI * 130.0) / sampleRate);
    const hpAlpha = Math.exp((-2.0 * Math.PI * 5000.0) / sampleRate);
    const hpGain = 0.5 * (1.0 + hpAlpha);

    for (let start = 0; start + frameSamples <= pcm.length; start += frameSamples) {
      let totalSq = 0;
      let lowFreqSq = 0;
      let highFreqSq = 0;
      let lpState = 0;
      let hpState = 0;
      let prevX = pcm[start];

      for (let i = start; i < start + frameSamples; i++) {
        const x = pcm[i];
        totalSq += x * x;

        lpState = (1.0 - lpAlpha) * x + lpAlpha * lpState;
        lowFreqSq += lpState * lpState;

        hpState = hpAlpha * hpState + hpGain * (x - prevX);
        prevX = x;
        highFreqSq += hpState * hpState;
      }

      const totalRms = Math.sqrt(totalSq / frameSamples);
      const totalDb = 20 * Math.log10(totalRms + 1e-9);
      if (totalDb < -40.0) continue;

      activeFramesEnergySum += totalSq / frameSamples;
      activeFramesCount++;

      const lowRms = Math.sqrt(lowFreqSq / frameSamples);
      const highRms = Math.sqrt(highFreqSq / frameSamples);

      const range: TimeRange = {
        start: TimeMath.samplesToFlicks(start, sampleRate),
        end: TimeMath.samplesToFlicks(start + frameSamples, sampleRate),
      };

      if (lowRms / (totalRms + 1e-9) > 0.80 && totalDb > -18.0) {
        plosives.push({
          kind: 'PLOSIVE_POP_LOW_FREQ',
          range,
          severityDb: Number(totalDb.toFixed(1)),
        });
      }

      if (highRms / (totalRms + 1e-9) > 0.62 && totalDb > -24.0) {
        sibilances.push({
          kind: 'HARSH_SIBILANCE_HIGH_FREQ',
          range,
          severityDb: Number(totalDb.toFixed(1)),
        });
      }
    }

    const meanSpeechEnergy =
      activeFramesCount > 0 ? activeFramesEnergySum / activeFramesCount : 1e-8;
    const speechRmsDb = 10 * Math.log10(meanSpeechEnergy + 1e-12);

    return { plosives, sibilances, speechRmsDb };
  }

  private static computeRmsDb(slice: Float32Array): number {
    if (slice.length === 0) return -90.0;
    let sumSq = 0;
    for (let i = 0; i < slice.length; i++) sumSq += slice[i] * slice[i];
    return 10 * Math.log10(sumSq / slice.length + 1e-12);
  }
}
