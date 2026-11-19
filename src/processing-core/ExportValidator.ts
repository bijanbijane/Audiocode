import { SampleRate } from '../contracts/timebase.contract';
import { ProjectVersionMatrix } from '../contracts/project-schema.contract';

export const EXPORT_DURATION_TOLERANCE_SECONDS = 0.002;
export const EXPORT_CLIPPING_THRESHOLD = 0.9999;
export const EXPORT_BOUNDARY_CLICK_THRESHOLD = 0.05;

export interface RenderManifest {
  readonly manifestId: string;
  readonly projectRevision: number;
  readonly versions: ProjectVersionMatrix;
  readonly inputAssetContentHashes: string[];
  readonly graphCacheKey: string;
  readonly exportSampleRate: SampleRate;
  readonly exportChannelCount: number;
  readonly renderedAtIso: string;
}

export interface ExportValidationReport {
  readonly passed: boolean;
  readonly structurallyValid: boolean;
  readonly expectedDurationSeconds: number;
  readonly actualDurationSeconds: number;
  readonly channelCount: number;
  readonly frameCount: number;
  readonly maxSamplePeakDb: number;
  readonly clippedSamplesCount: number;
  readonly invalidSamplesCount: number;
  readonly hasStartOrEndClickRisk: boolean;
  readonly errors: string[];
}

export class ExportValidator {
  /**
   * Fail-safe, non-mutating PCM export validator.
   * Validates structure, numeric parameters, every sample across all channels (O(1) extra memory),
   * duration tolerance, clipping threshold, and boundary click risk.
   */
  public static validateRenderedPcm(
    channels: readonly Float32Array[],
    sampleRate: SampleRate,
    expectedDurationSeconds: number,
  ): ExportValidationReport {
    const errors: string[] = [];

    const validSampleRate =
      typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0;
    if (!validSampleRate) {
      errors.push(
        `EXPORT_INVALID_SAMPLE_RATE: نرخ نمونه‌برداری (${String(sampleRate)}) باید عددی متناهی و مثبت باشد.`,
      );
    }

    const validExpectedDuration =
      typeof expectedDurationSeconds === 'number' &&
      Number.isFinite(expectedDurationSeconds) &&
      expectedDurationSeconds >= 0;
    if (!validExpectedDuration) {
      errors.push(
        `EXPORT_INVALID_EXPECTED_DURATION: مدت زمان موردانتظار (${String(expectedDurationSeconds)}) باید عددی متناهی و نامنفی باشد.`,
      );
    }

    if (!Array.isArray(channels)) {
      errors.push(
        'EXPORT_INVALID_CHANNEL_ARRAY: ساختار کانال‌های خروجی معتبر نیست و باید آرایه‌ای از Float32Array باشد.',
      );
      return {
        passed: false,
        structurallyValid: false,
        expectedDurationSeconds,
        actualDurationSeconds: 0,
        channelCount: 0,
        frameCount: 0,
        maxSamplePeakDb: -Infinity,
        clippedSamplesCount: 0,
        invalidSamplesCount: 0,
        hasStartOrEndClickRisk: false,
        errors,
      };
    }

    const channelCount = channels.length;
    if (channelCount === 0) {
      errors.push('EXPORT_EMPTY_BUFFER: بافر خروجی خالی است (هیچ کانالی وجود ندارد).');
      return {
        passed: false,
        structurallyValid: false,
        expectedDurationSeconds,
        actualDurationSeconds: 0,
        channelCount: 0,
        frameCount: 0,
        maxSamplePeakDb: -Infinity,
        clippedSamplesCount: 0,
        invalidSamplesCount: 0,
        hasStartOrEndClickRisk: false,
        errors,
      };
    }

    let allValidFloat32 = true;
    for (let c = 0; c < channelCount; c++) {
      if (!(channels[c] instanceof Float32Array)) {
        allValidFloat32 = false;
        errors.push(
          `EXPORT_INVALID_CHANNEL_TYPE: کانال شماره ${c} از نوع معتبر Float32Array نیست.`,
        );
      }
    }

    if (!allValidFloat32) {
      return {
        passed: false,
        structurallyValid: false,
        expectedDurationSeconds,
        actualDurationSeconds: 0,
        channelCount,
        frameCount: 0,
        maxSamplePeakDb: -Infinity,
        clippedSamplesCount: 0,
        invalidSamplesCount: 0,
        hasStartOrEndClickRisk: false,
        errors,
      };
    }

    const firstChannelLength = channels[0].length;
    let hasEmptyChannel = firstChannelLength === 0;
    let hasLengthMismatch = false;

    for (let c = 1; c < channelCount; c++) {
      const len = channels[c].length;
      if (len === 0) {
        hasEmptyChannel = true;
      }
      if (len !== firstChannelLength) {
        hasLengthMismatch = true;
      }
    }

    if (hasEmptyChannel) {
      errors.push('EXPORT_EMPTY_BUFFER: بافر خروجی خالی است (یک یا چند کانال دارای ۰ نمونه هستند).');
    }

    if (hasLengthMismatch) {
      errors.push(
        `EXPORT_CHANNEL_LENGTH_MISMATCH: طول کانال‌های صوتی یکسان نیست (کانال ۰ دارای ${firstChannelLength} فریم است).`,
      );
    }

    const structurallyValid =
      validSampleRate && validExpectedDuration && !hasEmptyChannel && !hasLengthMismatch;

    if (!structurallyValid) {
      // Still scan available samples safely if channels have data so invalid values are reported transparently
      let invalidSamplesCount = 0;
      let clippedSamplesCount = 0;
      let validFiniteSamplesCount = 0;
      let maxAbs = 0;
      for (let c = 0; c < channelCount; c++) {
        const ch = channels[c];
        for (let i = 0; i < ch.length; i++) {
          const sample = ch[i];
          if (!Number.isFinite(sample)) {
            invalidSamplesCount++;
            continue;
          }
          validFiniteSamplesCount++;
          const abs = Math.abs(sample);
          if (abs > maxAbs) maxAbs = abs;
          if (abs >= EXPORT_CLIPPING_THRESHOLD) clippedSamplesCount++;
        }
      }

      if (invalidSamplesCount > 0) {
        errors.push(
          `EXPORT_INVALID_SAMPLE_VALUES: تعداد ${invalidSamplesCount} نمونه نامعتبر (NaN یا Infinity) در بافر خروجی شناسایی شد.`,
        );
      }

      const actualDurationSeconds =
        validSampleRate && firstChannelLength > 0 ? firstChannelLength / sampleRate : 0;

      return {
        passed: false,
        structurallyValid: false,
        expectedDurationSeconds,
        actualDurationSeconds,
        channelCount,
        frameCount: hasLengthMismatch ? 0 : firstChannelLength,
        maxSamplePeakDb:
          validFiniteSamplesCount > 0 ? 20 * Math.log10(maxAbs + 1e-12) : -Infinity,
        clippedSamplesCount,
        invalidSamplesCount,
        hasStartOrEndClickRisk: false,
        errors,
      };
    }

    const frameCount = firstChannelLength;
    const actualDurationSeconds = frameCount / sampleRate;

    if (Math.abs(actualDurationSeconds - expectedDurationSeconds) > EXPORT_DURATION_TOLERANCE_SECONDS) {
      errors.push(
        `EXPORT_DURATION_MISMATCH: انتظار ${expectedDurationSeconds.toFixed(3)}s بود اما ${actualDurationSeconds.toFixed(3)}s تولید شد.`,
      );
    }

    let maxAbs = 0;
    let validFiniteSamplesCount = 0;
    let clippedSamplesCount = 0;
    let invalidSamplesCount = 0;
    let firstSampleMax = 0;
    let lastSampleMax = 0;
    const lastFrameIdx = frameCount - 1;

    for (let c = 0; c < channelCount; c++) {
      const ch = channels[c];
      for (let i = 0; i < frameCount; i++) {
        const sample = ch[i];
        if (!Number.isFinite(sample)) {
          invalidSamplesCount++;
          continue;
        }
        validFiniteSamplesCount++;
        const abs = Math.abs(sample);
        if (abs > maxAbs) maxAbs = abs;
        if (abs >= EXPORT_CLIPPING_THRESHOLD) clippedSamplesCount++;
        if (i === 0 && abs > firstSampleMax) firstSampleMax = abs;
        if (i === lastFrameIdx && abs > lastSampleMax) lastSampleMax = abs;
      }
    }

    const maxSamplePeakDb =
      validFiniteSamplesCount > 0 ? 20 * Math.log10(maxAbs + 1e-12) : -Infinity;

    if (invalidSamplesCount > 0) {
      errors.push(
        `EXPORT_INVALID_SAMPLE_VALUES: تعداد ${invalidSamplesCount} نمونه نامعتبر (NaN یا Infinity) در بافر خروجی شناسایی شد.`,
      );
    }

    if (clippedSamplesCount > 0) {
      errors.push(
        `EXPORT_CLIPPING_DETECTED: تعداد ${clippedSamplesCount} نمونه دچار اشباع (Clipping) شده‌اند.`,
      );
    }

    const hasStartOrEndClickRisk =
      firstSampleMax > EXPORT_BOUNDARY_CLICK_THRESHOLD ||
      lastSampleMax > EXPORT_BOUNDARY_CLICK_THRESHOLD;

    if (hasStartOrEndClickRisk) {
      errors.push(
        'EXPORT_BOUNDARY_CLICK_RISK: نمونه اول یا آخر فایل دارای دامنه غیرصفر بالا است (خطر کلیک صوتی).',
      );
    }

    return {
      passed: errors.length === 0,
      structurallyValid: true,
      expectedDurationSeconds,
      actualDurationSeconds,
      channelCount,
      frameCount,
      maxSamplePeakDb,
      clippedSamplesCount,
      invalidSamplesCount,
      hasStartOrEndClickRisk,
      errors,
    };
  }
}
