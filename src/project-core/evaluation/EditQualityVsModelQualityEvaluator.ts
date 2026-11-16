import { SampleRate, TimeRange } from '../../contracts/timebase.contract';
import { AutomatedQualityGateRunner } from '../../quality-gate/AutomatedQualityGateRunner';

/** ۱. معیارهای مستقل کیفیت مدل هوش مصنوعی (بخش ۳۹ سند معماری) */
export interface AiModelDetectionQualityReport {
  readonly rawWerPercent: number;
  readonly normalizedWerPercent: number;
  readonly wordTimestampMeanAbsErrorMs: number;
  readonly diarizationErrorRatePercent: number;
  readonly disfluencyMetrics: {
    readonly truePositives: number;
    readonly falsePositives: number;
    readonly falseNegatives: number;
    readonly precision: number;
    readonly recall: number;
    readonly f1Score: number;
  };
  readonly realTimeFactor: number;
  readonly peakMemoryMb: number;
}

/** ۲. معیارهای مستقل کیفیت تدوین نهایی صوت (بخش ۳۹ و قانون ۲۶: کاملاً جدا از دقت مدل!) */
export interface FinalEditedAudioQualityReport {
  readonly evaluatedSplicePointsCount: number;
  /** بیشترین پرش دامنه در تمام نقاط برش؛ مقادیر زیر 0.05 نشانه نبود کلیک صوتی است */
  readonly maxSpliceStepDiscontinuity: number;
  readonly audibleClickSpliceIndices: number[];
  /** اختلاف تراز کف نویز بین نقاط برش (Room Tone) و بافت طبیعی اطراف آن بر حسب dB */
  readonly maxRoomToneFloorMismatchDb: number;
  /** تعداد برش‌هایی که در آن‌ها مکث بین دو کلمه به کمتر از 35ms سقوط کرده (حس خفگی و کلافگی گفتار) */
  readonly crushedCadenceCollisionCount: number;
  /** خطای همگام‌سازی بین ترک‌های عضو یک گروه سینک بر حسب میلی‌ثانیه */
  readonly multiTrackSyncDriftMs: number;
  readonly compositeEditSmoothnessScoreOutOf100: number;
  readonly passedFinalEditQuality: boolean;
}

export class EditQualityVsModelQualityEvaluator {
  /**
   * الف) محاسبه معیارهای مستقل کیفیت تشخیص مدل (WER, Precision, Recall, Timestamp MAE)
   */
  public static evaluateAiModelQuality(params: {
    referenceTranscript: string;
    hypothesisTranscript: string;
    timestampPairsMs: { groundTruthStartMs: number; predictedStartMs: number }[];
    detectedIssueRanges: TimeRange[];
    groundTruthIssueRanges: TimeRange[];
    diarizationErrorRatePercent: number;
    realTimeFactor: number;
    peakMemoryMb: number;
  }): AiModelDetectionQualityReport {
    const wer = AutomatedQualityGateRunner.computePersianWER(
      params.referenceTranscript,
      params.hypothesisTranscript,
    );

    // محاسبه میانگین خطای مطلق زمان‌بندی کلمات (Word Timestamp MAE)
    let totalAbsErrMs = 0;
    for (const pair of params.timestampPairsMs) {
      totalAbsErrMs += Math.abs(pair.groundTruthStartMs - pair.predictedStartMs);
    }
    const wordTimestampMeanAbsErrorMs =
      params.timestampPairsMs.length > 0
        ? Number((totalAbsErrMs / params.timestampPairsMs.length).toFixed(2))
        : 0;

    // محاسبه True Positive / False Positive / False Negative بر اساس همپوشانی زمانی IoU >= 0.4
    let truePositives = 0;
    const matchedGroundTruth = new Set<number>();

    for (const pred of params.detectedIssueRanges) {
      let matched = false;
      for (let gIdx = 0; gIdx < params.groundTruthIssueRanges.length; gIdx++) {
        if (matchedGroundTruth.has(gIdx)) continue;
        const gt = params.groundTruthIssueRanges[gIdx];
        const iou = this.computeTimeRangeIoU(pred, gt);
        if (iou >= 0.4) {
          truePositives++;
          matchedGroundTruth.add(gIdx);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // False Positive به صورت ضمنی از تفاضل محاسبه می‌شود
      }
    }

    const falsePositives = params.detectedIssueRanges.length - truePositives;
    const falseNegatives = params.groundTruthIssueRanges.length - truePositives;

    const precision =
      params.detectedIssueRanges.length > 0
        ? truePositives / params.detectedIssueRanges.length
        : 1.0;
    const recall =
      params.groundTruthIssueRanges.length > 0
        ? truePositives / params.groundTruthIssueRanges.length
        : 1.0;
    const f1Score =
      precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
      rawWerPercent: Number(wer.rawWerPercent.toFixed(2)),
      normalizedWerPercent: Number(wer.normalizedWerPercent.toFixed(2)),
      wordTimestampMeanAbsErrorMs,
      diarizationErrorRatePercent: Number(params.diarizationErrorRatePercent.toFixed(2)),
      disfluencyMetrics: {
        truePositives,
        falsePositives,
        falseNegatives,
        precision: Number(precision.toFixed(3)),
        recall: Number(recall.toFixed(3)),
        f1Score: Number(f1Score.toFixed(3)),
      },
      realTimeFactor: Number(params.realTimeFactor.toFixed(3)),
      peakMemoryMb: Number(params.peakMemoryMb.toFixed(1)),
    };
  }

  /**
   * ب) محاسبه معیارهای مستقل کیفیت تدوین نهایی روی فایل خروجی رندرشده
   * مستقل از اینکه مدل هوش مصنوعی چقدر دقیق بوده، بررسی می‌کند که آیا صدای تدوین‌شده کاملاً طبیعی و بدون پرش است یا خیر
   */
  public static evaluateFinalEditedAudioQuality(params: {
    renderedPcmMono: Float32Array;
    sampleRate: SampleRate;
    spliceBoundarySamples: number[];
    interWordGapDurationsMsAfterEdit: number[];
    multiTrackSyncDriftMs: number;
  }): FinalEditedAudioQualityReport {
    const { renderedPcmMono, sampleRate, spliceBoundarySamples } = params;
    const audibleClickSpliceIndices: number[] = [];
    let maxSpliceStepDiscontinuity = 0;
    let maxRoomToneFloorMismatchDb = 0;

    const checkRadius = Math.floor((sampleRate * 12) / 1000); // ±12ms اطراف نقطه برش
    const rmsWindow = Math.floor((sampleRate * 40) / 1000); // پنجره 40ms برای سنجش کف نویز محیط

    for (let idx = 0; idx < spliceBoundarySamples.length; idx++) {
      const center = spliceBoundarySamples[idx];
      const start = Math.max(1, center - checkRadius);
      const end = Math.min(renderedPcmMono.length - 1, center + checkRadius);

      // ۱. بررسی پرش مشتق اول سیگنال (تشخیص کلیک و تق در نقطه اتصال)
      let localMaxDelta = 0;
      for (let s = start; s <= end; s++) {
        const delta = Math.abs(renderedPcmMono[s] - renderedPcmMono[s - 1]);
        if (delta > localMaxDelta) localMaxDelta = delta;
      }
      if (localMaxDelta > maxSpliceStepDiscontinuity) {
        maxSpliceStepDiscontinuity = localMaxDelta;
      }
      if (localMaxDelta >= 0.05) {
        audibleClickSpliceIndices.push(idx);
      }

      // ۲. بررسی یکنواختی کف نویز (عدم سقوط ناگهانی به سکوت مطلق دیجیتال در نقطه برش)
      if (center - rmsWindow >= 0 && center + rmsWindow < renderedPcmMono.length) {
        const leftRmsDb = this.computeSliceDb(renderedPcmMono, center - rmsWindow, center);
        const rightRmsDb = this.computeSliceDb(renderedPcmMono, center, center + rmsWindow);
        const mismatchDb = Math.abs(leftRmsDb - rightRmsDb);
        // اگر یکی از طرفین سکوت مطلق دیجیتال (-90dB) باشد و طرف دیگر صدای اتاق (-55dB)، جهش غیرطبیعی رخ داده است
        if (Math.min(leftRmsDb, rightRmsDb) < -80 && mismatchDb > maxRoomToneFloorMismatchDb) {
          maxRoomToneFloorMismatchDb = mismatchDb;
        }
      }
    }

    // ۳. بررسی ریتم تنفسی طبیعی (جلوگیری از چسبیدن بیش از حد دو کلمه در اثر حذف تهاجمی مکث)
    const crushedCadenceCollisionCount = params.interWordGapDurationsMsAfterEdit.filter(
      (gapMs) => gapMs < 35,
    ).length;

    // محاسبه امتیاز ترکیبی نرمی و طبیعی بودن تدوین نهایی (از ۱۰۰)
    let score = 100;
    score -= audibleClickSpliceIndices.length * 15;
    score -= Math.max(0, maxRoomToneFloorMismatchDb - 6) * 1.5;
    score -= crushedCadenceCollisionCount * 4;
    score -= Math.max(0, params.multiTrackSyncDriftMs - 5) * 3;
    const boundedScore = Math.max(0, Math.min(100, Math.round(score)));

    const passedFinalEditQuality =
      audibleClickSpliceIndices.length === 0 &&
      params.multiTrackSyncDriftMs <= 5.0 &&
      boundedScore >= 80;

    return {
      evaluatedSplicePointsCount: spliceBoundarySamples.length,
      maxSpliceStepDiscontinuity: Number(maxSpliceStepDiscontinuity.toFixed(4)),
      audibleClickSpliceIndices,
      maxRoomToneFloorMismatchDb: Number(maxRoomToneFloorMismatchDb.toFixed(1)),
      crushedCadenceCollisionCount,
      multiTrackSyncDriftMs: Number(params.multiTrackSyncDriftMs.toFixed(2)),
      compositeEditSmoothnessScoreOutOf100: boundedScore,
      passedFinalEditQuality,
    };
  }

  private static computeTimeRangeIoU(a: TimeRange, b: TimeRange): number {
    const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
    return union > 0 ? intersection / union : 0;
  }

  private static computeSliceDb(pcm: Float32Array, start: number, end: number): number {
    let sumSq = 0;
    const len = Math.max(1, end - start);
    for (let i = start; i < end; i++) sumSq += pcm[i] * pcm[i];
    return 10 * Math.log10(sumSq / len + 1e-12);
  }
}
