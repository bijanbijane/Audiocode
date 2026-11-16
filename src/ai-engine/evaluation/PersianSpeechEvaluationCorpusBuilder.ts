export type PersianSpeechStyle = 'FORMAL' | 'COLLOQUIAL' | 'MIXED_CODE_SWITCHING';
export type PersianGenreCategory =
  | 'PODCAST'
  | 'INTERVIEW'
  | 'LECTURE'
  | 'EDUCATIONAL'
  | 'AUDIOBOOK';
export type SpeakingRateTier = 'SLOW' | 'NORMAL' | 'FAST';
export type AcousticNoiseTier =
  | 'CLEAN_STUDIO'
  | 'MODERATE_ROOM_NOISE'
  | 'CHALLENGING_NOISE_50HZ';
export type DurationClass =
  | 'SHORT_UNDER_3MIN'
  | 'MEDIUM_3_TO_30MIN'
  | 'LONG_OVER_60MIN';

export interface EvaluationCorpusSampleEntry {
  readonly sampleId: string;
  readonly legalLicenseSource: string; // تضمین «داده‌های آزمون مجاز» (بخش ۳۹)
  readonly speakerConsentVerified: boolean;
  readonly style: PersianSpeechStyle;
  readonly accentOrDialectRegion: string; // مثلاً تهرانی، شیرازی، اصفهانی، مشهدی، تبریزی، جنوبی
  readonly genre: PersianGenreCategory;
  readonly speakingRate: SpeakingRateTier;
  readonly noiseTier: AcousticNoiseTier;
  readonly durationClass: DurationClass;
  readonly speakerCount: number;
  readonly containsStuttersAndFillers: boolean;
  readonly containsLongPauses: boolean;
  readonly containsEzafeChains: boolean;
  readonly audioDurationSeconds: number;
}

export interface CorpusCoverageAuditReport {
  readonly totalSamplesCount: number;
  readonly totalDurationMinutes: number;
  readonly distinctAccentsCount: number;
  readonly missingMandatoryAxes: string[];
  readonly baselineReadyForThresholdApproval: boolean;
}

export class PersianSpeechEvaluationCorpusBuilder {
  /**
   * ممیزی پوشش کامل ۱۲ محور الزامی بخش ۳۹ سند معماری و بررسی مجوز قانونی داده‌ها
   */
  public static auditCorpusCoverageAndLegality(
    samples: EvaluationCorpusSampleEntry[],
  ): CorpusCoverageAuditReport {
    const missingMandatoryAxes: string[] = [];

    // بررسی مجوز قانونی تمام نمونه‌ها پیش از ورود به چرخه آزمون
    const unauthorizedSamples = samples.filter(
      (s) => !s.speakerConsentVerified || !s.legalLicenseSource.trim(),
    );
    if (unauthorizedSamples.length > 0) {
      missingMandatoryAxes.push(
        `LEGAL_LICENSE_VIOLATION: تعداد ${unauthorizedSamples.length} نمونه فاقد مجوز یا رضایت معتبر است.`,
      );
    }

    const checkCondition = (
      label: string,
      pred: (s: EvaluationCorpusSampleEntry) => boolean,
    ) => {
      if (!samples.some(pred)) missingMandatoryAxes.push(label);
    };

    // بررسی ۱۲ محور الزامی بخش ۳۹ سند معماری
    checkCondition('سبک گفتار رسمی (FORMAL)', (s) => s.style === 'FORMAL');
    checkCondition('سبک گفتار محاوره‌ای (COLLOQUIAL)', (s) => s.style === 'COLLOQUIAL');
    checkCondition('گفتار سریع (FAST)', (s) => s.speakingRate === 'FAST');
    checkCondition('گفتار آرام (SLOW)', (s) => s.speakingRate === 'SLOW');
    checkCondition('فایل چندگوینده (Multi-Speaker)', (s) => s.speakerCount >= 2);
    checkCondition('ضبط دارای نویز محیط/هوم برق', (s) => s.noiseTier !== 'CLEAN_STUDIO');
    checkCondition('حاوی مکث‌های طولانی', (s) => s.containsLongPauses);
    checkCondition('حاوی تپق‌های مستقل و کشیده‌شده', (s) => s.containsStuttersAndFillers);
    checkCondition('زنجیره کسره اضافه فارسی', (s) => s.containsEzafeChains);
    checkCondition('ژانر مصاحبه (INTERVIEW)', (s) => s.genre === 'INTERVIEW');
    checkCondition('ژانر سخنرانی (LECTURE)', (s) => s.genre === 'LECTURE');
    checkCondition('ژانر پادکست (PODCAST)', (s) => s.genre === 'PODCAST');
    checkCondition('ژانر آموزشی (EDUCATIONAL)', (s) => s.genre === 'EDUCATIONAL');
    checkCondition('فایل کوتاه (< 3 دقیقه)', (s) => s.durationClass === 'SHORT_UNDER_3MIN');
    checkCondition('فایل طولانی (> 60 دقیقه)', (s) => s.durationClass === 'LONG_OVER_60MIN');

    const accents = new Set(samples.map((s) => s.accentOrDialectRegion.trim()));
    if (accents.size < 3) {
      missingMandatoryAxes.push('تنوع لهجه‌های مختلف (حداقل ۳ لهجه مختلف فارسی الزامی است)');
    }

    const totalDurationMinutes = Number(
      (samples.reduce((acc, s) => acc + s.audioDurationSeconds, 0) / 60).toFixed(1),
    );

    return {
      totalSamplesCount: samples.length,
      totalDurationMinutes,
      distinctAccentsCount: accents.size,
      missingMandatoryAxes,
      baselineReadyForThresholdApproval: missingMandatoryAxes.length === 0,
    };
  }
}
