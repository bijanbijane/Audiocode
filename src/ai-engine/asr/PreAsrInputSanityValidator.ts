export type InputSignalAnomalyCode =
  | 'DIGITAL_SILENCE_EMPTY'
  | 'SEVERE_DC_OFFSET_FIXED'
  | 'HEAVY_CLIPPING_DISTORTION'
  | 'NAN_OR_INFINITY_CORRUPTED';

export interface SignalSanityReport {
  readonly safeForAsrInference: boolean;
  readonly anomaliesDetected: InputSignalAnomalyCode[];
  readonly measuredDcOffset: number;
  readonly measuredRmsDb: number;
  readonly clippedSampleRatioPercent: number;
  readonly recommendationFa: string;
}

export class PreAsrInputSanityValidator {
  /**
   * Inspects 16kHz Mono PCM signal health prior to neural ASR inference and removes severe DC offset in-place.
   */
  public static validateAndSanitizeForAsr(pcm16kMono: Float32Array): SignalSanityReport {
    const len = pcm16kMono.length;
    if (len === 0) {
      return {
        safeForAsrInference: false,
        anomaliesDetected: ['DIGITAL_SILENCE_EMPTY'],
        measuredDcOffset: 0,
        measuredRmsDb: -100,
        clippedSampleRatioPercent: 0,
        recommendationFa: 'فایل ورودی خالی است.',
      };
    }

    const anomalies: InputSignalAnomalyCode[] = [];
    let sum = 0;
    let clippedCount = 0;
    let hasNanOrInf = false;

    for (let i = 0; i < len; i++) {
      const s = pcm16kMono[i];
      if (!Number.isFinite(s)) {
        hasNanOrInf = true;
        pcm16kMono[i] = 0;
        continue;
      }
      sum += s;
      if (Math.abs(s) >= 0.995) clippedCount++;
    }

    if (hasNanOrInf) {
      anomalies.push('NAN_OR_INFINITY_CORRUPTED');
    }

    const dcOffset = sum / len;
    // Remove severe DC bias (> 0.02) in-place before spectral extraction
    if (Math.abs(dcOffset) > 0.02) {
      anomalies.push('SEVERE_DC_OFFSET_FIXED');
      for (let i = 0; i < len; i++) {
        pcm16kMono[i] -= dcOffset;
      }
    }

    let sumSqAfterDc = 0;
    for (let i = 0; i < len; i++) {
      sumSqAfterDc += pcm16kMono[i] * pcm16kMono[i];
    }

    const rms = Math.sqrt(sumSqAfterDc / len);
    const rmsDb = 20 * Math.log10(rms + 1e-12);
    const clippedPct = (clippedCount / len) * 100;

    if (rmsDb < -68.0) {
      anomalies.push('DIGITAL_SILENCE_EMPTY');
    }
    if (clippedPct > 4.0) {
      anomalies.push('HEAVY_CLIPPING_DISTORTION');
    }

    const safeForAsrInference = !anomalies.includes('DIGITAL_SILENCE_EMPTY');

    return {
      safeForAsrInference,
      anomaliesDetected: anomalies,
      measuredDcOffset: Number(dcOffset.toFixed(4)),
      measuredRmsDb: Number(rmsDb.toFixed(2)),
      clippedSampleRatioPercent: Number(clippedPct.toFixed(2)),
      recommendationFa: !safeForAsrInference
        ? 'سیگنال صوتی عملاً سکوت مطلق است و نیازی به اجرای مدل ASR ندارد.'
        : anomalies.includes('HEAVY_CLIPPING_DISTORTION')
        ? 'هشدار: بیش از ۴٪ نمونه‌ها دچار اشباع (Clipping) هستند؛ دقت تشخیص کلمات ممکن است کاهش یابد.'
        : 'سیگنال صوتی برای ورود به موتور تشخیص گفتار کاملاً سالم است.',
    };
  }
}
