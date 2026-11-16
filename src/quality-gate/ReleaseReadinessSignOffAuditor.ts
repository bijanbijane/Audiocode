export interface MvpAndReleaseChecklistEvidence {
  // معیارهای ۱۱گانه موفقیت MVP (بخش ۶۱ سند نسخه ۱.۲)
  readonly importToExportWorksOfflineWithoutExternalApi: boolean;
  readonly zeroWaitGroupAAvailableImmediatelyAfterImport: boolean;
  readonly projectSurvivesTabCloseAndCrashRecovery: boolean;
  readonly originalSourceAssetByteHashUnchanged: boolean;
  readonly persianAsrBenchmarkedOnTargetDevices: boolean;
  readonly postEditSplicesClickFreeAndPreserveEzafe: boolean;
  readonly smartSuggestionsRequireExplicitUserApproval: boolean;
  readonly playbackUnderrunsZeroDuringBackgroundAi: boolean;
  readonly storageAndOpfsLockErrorsZeroUnderStress: boolean;
  readonly fourWayVersionsAndModelProvenanceTracked: boolean;
  readonly deviceRamAndDurationLimitsShownTransparently: boolean;

  // وضعیت عبور از ۱۰ دروازه کیفیت انتشار (بخش ۶۵ سند نسخه ۱.۲)
  readonly gates: {
    readonly functional: boolean;
    readonly audioQuality: boolean;
    readonly persianAiAndProsodicQuality: boolean;
    readonly performance: boolean;
    readonly memoryDiskAndStability: boolean;
    readonly storageAndRecovery: boolean;
    readonly securityAndCrossOriginIsolation: boolean;
    readonly compatibilityAcrossDesktopAndIos: boolean;
    readonly regression: boolean;
    readonly userAcceptance: boolean;
  };
}

export interface ReleaseSignOffVerdict {
  readonly approvedForRelease: boolean;
  readonly mvpCriteriaPassedCount: number;
  readonly releaseGatesPassedCount: number;
  readonly blockingFailures: string[];
  readonly generatedAtIso: string;
}

export class ReleaseReadinessSignOffAuditor {
  /**
   * ارزیابی نهایی تمام ۱۱ معیار MVP (بخش ۶۱) و ۱۰ دروازه انتشار (بخش ۶۵)
   * شکست حتی یک مورد بحرانی مانع انتشار می‌شود.
   */
  public static evaluateReleaseSignOff(
    evidence: MvpAndReleaseChecklistEvidence,
  ): ReleaseSignOffVerdict {
    const blockingFailures: string[] = [];

    const mvpChecks: [string, boolean][] = [
      [
        'MVP-01: گردش کامل Import تا Export بدون API خارجی',
        evidence.importToExportWorksOfflineWithoutExternalApi,
      ],
      [
        'MVP-02: دسترسی فوری به قابلیت‌های گروه A در ثانیه صفر',
        evidence.zeroWaitGroupAAvailableImmediatelyAfterImport,
      ],
      [
        'MVP-03: بازیابی کامل پروژه پس از بسته شدن تب/کرش',
        evidence.projectSurvivesTabCloseAndCrashRecovery,
      ],
      [
        'MVP-04: حفظ بدون تغییر فایل صوتی اصلی مبدأ',
        evidence.originalSourceAssetByteHashUnchanged,
      ],
      [
        'MVP-05: بنچمارک ASR فارسی روی دستگاه‌های هدف',
        evidence.persianAsrBenchmarkedOnTargetDevices,
      ],
      [
        'MVP-06: برش‌های بدون کلیک صوتی و حفاظت از کسره اضافه',
        evidence.postEditSplicesClickFreeAndPreserveEzafe,
      ],
      [
        'MVP-07: عدم اعمال خودکار پیشنهادها بدون تایید کاربر',
        evidence.smartSuggestionsRequireExplicitUserApproval,
      ],
      [
        'MVP-08: پخش بدون وقفه (Zero Underrun) همزمان با پردازش پس‌زمینه',
        evidence.playbackUnderrunsZeroDuringBackgroundAi,
      ],
      [
        'MVP-09: صفر بودن خطای قفل فایل OPFS در تست استرس',
        evidence.storageAndOpfsLockErrorsZeroUnderStress,
      ],
      [
        'MVP-10: ردیابی کامل چهار نسخه پروژه و منشأ مدل‌ها',
        evidence.fourWayVersionsAndModelProvenanceTracked,
      ],
      [
        'MVP-11: شفاف‌سازی محدودیت‌های واقعی سخت‌افزار و حافظه',
        evidence.deviceRamAndDurationLimitsShownTransparently,
      ],
    ];

    let mvpPassed = 0;
    for (const [label, ok] of mvpChecks) {
      if (ok) {
        mvpPassed++;
      } else {
        blockingFailures.push(`BLOCKER_${label}`);
      }
    }

    const gateEntries = Object.entries(evidence.gates) as [string, boolean][];
    let gatesPassed = 0;
    for (const [gateName, ok] of gateEntries) {
      if (ok) {
        gatesPassed++;
      } else {
        blockingFailures.push(`GATE_FAILED_${gateName.toUpperCase()}`);
      }
    }

    return {
      approvedForRelease: blockingFailures.length === 0,
      mvpCriteriaPassedCount: mvpPassed,
      releaseGatesPassedCount: gatesPassed,
      blockingFailures,
      generatedAtIso: new Date().toISOString(),
    };
  }
}
