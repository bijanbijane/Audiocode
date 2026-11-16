export interface ModelTelemetryEventSummary {
  readonly modelId: string;
  readonly version: string;
  readonly modelTotalSizeBytes: number;
  readonly uniqueUsersCount: number;
  readonly chunkDownloadOkCount: number;
  readonly chunkFailureCount: number;
  readonly resumeSuccessCount: number;
  readonly localCacheHitCount: number;
  readonly totalBytesTransferredCdn: number;
  readonly deltaUpdateBytesTransferredCdn: number;
}

/** گزارش رسمی ۷ شاخص اقتصادی بخش ۵۷ سند معماری */
export interface Section57ModelEconomicsReport {
  readonly modelId: string;
  readonly version: string;
  readonly modelDownloadSizeMb: number; // ۱. Model Download Size
  readonly downloadFailureRatePercent: number; // ۲. Download Failure Rate
  readonly redownloadRateRatio: number; // ۳. Redownload Rate (نسبت حجم دانلود شده به حجم ایده‌آل هر کاربر یک‌بار)
  readonly cacheHitRatePercent: number; // ۴. Cache Hit Rate
  readonly estimatedCdnCostUsd: number; // ۵. CDN Cost
  readonly modelUpdateCostUsd: number; // ۶. Model Update Cost
  readonly avgClientStorageUsageMb: number; // ۷. Storage Usage
  readonly healthAdvisoryFa: string;
}

export class ModelDeliveryEconomicsAnalyzer {
  /**
   * محاسبه دقیق ۷ شاخص بخش ۵۷ سند معماری برای پایش هزینه CDN و سلامت کش مرورگر کاربران
   * @param cdnCostPerGigabyteUsd هزینه هر گیگابایت ترافیک CDN (مثلاً 0.02 دلار)
   */
  public static computeSection57Metrics(
    summary: ModelTelemetryEventSummary,
    cdnCostPerGigabyteUsd: number = 0.02,
  ): Section57ModelEconomicsReport {
    const modelDownloadSizeMb = Number(
      (summary.modelTotalSizeBytes / (1024 * 1024)).toFixed(2),
    );

    const totalChunkAttempts =
      summary.chunkDownloadOkCount + summary.chunkFailureCount;
    const downloadFailureRatePercent =
      totalChunkAttempts > 0
        ? Number(((summary.chunkFailureCount / totalChunkAttempts) * 100).toFixed(2))
        : 0;

    // محاسبه Redownload Rate: در حالت ایده‌آل هر کاربر یکتا فقط ۱ بار کل مدل را دانلود می‌کند
    const idealTotalBytes =
      Math.max(1, summary.uniqueUsersCount) * summary.modelTotalSizeBytes;
    const redownloadRateRatio = Number(
      (summary.totalBytesTransferredCdn / idealTotalBytes).toFixed(2),
    );

    const totalLoads =
      summary.localCacheHitCount + Math.max(1, summary.uniqueUsersCount);
    const cacheHitRatePercent = Number(
      ((summary.localCacheHitCount / totalLoads) * 100).toFixed(2),
    );

    const totalGb = summary.totalBytesTransferredCdn / (1024 * 1024 * 1024);
    const updateGb = summary.deltaUpdateBytesTransferredCdn / (1024 * 1024 * 1024);

    const estimatedCdnCostUsd = Number((totalGb * cdnCostPerGigabyteUsd).toFixed(4));
    const modelUpdateCostUsd = Number((updateGb * cdnCostPerGigabyteUsd).toFixed(4));

    let healthAdvisoryFa =
      'وضعیت کش محلی OPFS و نرخ ادامه دانلود (Resume) در محدوده بهینه اقتصادی قرار دارد.';
    if (redownloadRateRatio > 1.35) {
      healthAdvisoryFa =
        'هشدار اقتصادی: نرخ دانلود مجدد (Redownload Rate) بالاست؛ احتمال پاک شدن کش OPFS در برخی مرورگرها به دلیل عدم تایید Persistent Storage وجود دارد.';
    } else if (downloadFailureRatePercent > 12.0) {
      healthAdvisoryFa =
        'هشدار شبکه: نرخ خطای دریافت قطعات بالاست؛ کاهش سایز قطعات از 8MB به 4MB برای اینترنت‌های ناپایدار پیشنهاد می‌شود.';
    }

    return {
      modelId: summary.modelId,
      version: summary.version,
      modelDownloadSizeMb,
      downloadFailureRatePercent,
      redownloadRateRatio,
      cacheHitRatePercent,
      estimatedCdnCostUsd,
      modelUpdateCostUsd,
      avgClientStorageUsageMb: modelDownloadSizeMb,
      healthAdvisoryFa,
    };
  }
}
