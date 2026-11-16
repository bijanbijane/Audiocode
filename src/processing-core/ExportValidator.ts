import { SampleRate } from '../contracts/timebase.contract';
import { ProjectVersionMatrix } from '../contracts/project-schema.contract';

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
  readonly expectedDurationSeconds: number;
  readonly actualDurationSeconds: number;
  readonly maxSamplePeakDb: number;
  readonly clippedSamplesCount: number;
  readonly hasStartOrEndClickRisk: boolean;
  readonly errors: string[];
}

export class ExportValidator {
  public static validateRenderedPcm(
    channels: Float32Array[],
    sampleRate: SampleRate,
    expectedDurationSeconds: number,
  ): ExportValidationReport {
    const errors: string[] = [];
    if (channels.length === 0 || channels[0].length === 0) {
      return {
        passed: false,
        expectedDurationSeconds,
        actualDurationSeconds: 0,
        maxSamplePeakDb: -Infinity,
        clippedSamplesCount: 0,
        hasStartOrEndClickRisk: false,
        errors: ['EXPORT_EMPTY_BUFFER: بافر خروجی خالی است.'],
      };
    }

    const frameCount = channels[0].length;
    const actualDurationSeconds = frameCount / sampleRate;

    if (Math.abs(actualDurationSeconds - expectedDurationSeconds) > 0.002) {
      errors.push(
        `EXPORT_DURATION_MISMATCH: انتظار ${expectedDurationSeconds.toFixed(3)}s بود اما ${actualDurationSeconds.toFixed(3)}s تولید شد.`,
      );
    }

    let maxAbs = 0;
    let clippedSamplesCount = 0;

    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < frameCount; i++) {
        const abs = Math.abs(ch[i]);
        if (abs > maxAbs) maxAbs = abs;
        if (abs >= 0.9999) clippedSamplesCount++;
      }
    }

    const maxSamplePeakDb = 20 * Math.log10(maxAbs + 1e-12);
    if (clippedSamplesCount > 0) {
      errors.push(
        `EXPORT_CLIPPING_DETECTED: تعداد ${clippedSamplesCount} نمونه دچار اشباع (Clipping) شده‌اند.`,
      );
    }

    const firstSampleMax = Math.max(...channels.map((ch) => Math.abs(ch[0])));
    const lastSampleMax = Math.max(...channels.map((ch) => Math.abs(ch[frameCount - 1])));
    const hasStartOrEndClickRisk = firstSampleMax > 0.05 || lastSampleMax > 0.05;

    if (hasStartOrEndClickRisk) {
      errors.push(
        'EXPORT_BOUNDARY_CLICK_RISK: نمونه اول یا آخر فایل دارای دامنه غیرصفر بالا است (خطر کلیک صوتی).',
      );
    }

    return {
      passed: errors.length === 0,
      expectedDurationSeconds,
      actualDurationSeconds,
      maxSamplePeakDb,
      clippedSamplesCount,
      hasStartOrEndClickRisk,
      errors,
    };
  }
}
