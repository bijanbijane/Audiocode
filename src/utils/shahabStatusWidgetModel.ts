/**
 * Pure presentation/state model for the real-time SHAHAB Engine Status Widget
 * displayed at the top of the Studio tab.
 */

import type { ShahabLocalRuntimeStatusResponse } from '../asr-core/ShahabLocalHttpClient';

export type ShahabWidgetHealthState =
  | 'CHECKING'
  | 'PROCESSING'
  | 'HEALTHY_LOADED'
  | 'HEALTHY_STANDBY'
  | 'DEGRADED_MISSING_ASSETS'
  | 'DEGRADED_INTEGRITY_ERROR'
  | 'OFFLINE';

export interface ShahabStatusWidgetViewModel {
  readonly healthState: ShahabWidgetHealthState;
  readonly healthLabel: string;
  readonly healthDetail: string;
  readonly tone: 'emerald' | 'sky' | 'amber' | 'rose' | 'slate';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly runtimeLabel: string;
  readonly rtfValue: string;
  readonly speedMultiplierLabel: string;
  readonly lastRunMeta: string;
  readonly lastCheckedTime: string;
  readonly activeJobCount: number;
  readonly queuedJobCount: number;
  readonly missingFilesCount: number;
}

export function formatClockTime(timestampMs: number | null, locale: 'fa' | 'en'): string {
  if (timestampMs === null || !Number.isFinite(timestampMs)) {
    return '—';
  }
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const raw = `${hh}:${mm}:${ss}`;
  return locale === 'fa' ? raw : raw;
}

export function deriveShahabWidgetViewModel(params: {
  readonly status: ShahabLocalRuntimeStatusResponse | null;
  readonly isTranscribing: boolean;
  readonly hasCheckedOnce: boolean;
  readonly lastCheckedAtMs: number | null;
  readonly locale: 'fa' | 'en';
}): ShahabStatusWidgetViewModel {
  const { status, isTranscribing, hasCheckedOnce, lastCheckedAtMs, locale } = params;
  const isFa = locale === 'fa';
  const lastCheckedTime = formatClockTime(lastCheckedAtMs, locale);

  if (!status && !hasCheckedOnce) {
    return {
      healthState: 'CHECKING',
      healthLabel: isFa ? 'در حال بررسی اتصال...' : 'Checking connection...',
      healthDetail: isFa ? 'پایش سرویس محلی شهاب' : 'Probing local SHAHAB runtime',
      tone: 'slate',
      modelId: '—',
      modelVersion: '—',
      runtimeLabel: isFa ? '۱۰۰٪ محلی' : '100% Local',
      rtfValue: '—',
      speedMultiplierLabel: isFa ? 'در انتظار پایش' : 'Awaiting probe',
      lastRunMeta: isFa ? 'هنوز اجرایی ثبت نشده' : 'No runs yet',
      lastCheckedTime,
      activeJobCount: 0,
      queuedJobCount: 0,
      missingFilesCount: 0,
    };
  }

  if (!status) {
    return {
      healthState: 'OFFLINE',
      healthLabel: isFa ? 'عدم اتصال به شهاب' : 'SHAHAB Offline',
      healthDetail: isFa
        ? 'پاسخی از سرویس محلی /api/shahab دریافت نشد'
        : 'Local /api/shahab runtime unreachable',
      tone: 'rose',
      modelId: 'persian-zipformer-transducer',
      modelVersion: '—',
      runtimeLabel: isFa ? 'سرویس محلی غیرفعال' : 'Local runtime offline',
      rtfValue: '—',
      speedMultiplierLabel: isFa ? 'خارج از دسترس' : 'Unavailable',
      lastRunMeta: isFa ? 'اتصال برقرار نیست' : 'Not connected',
      lastCheckedTime,
      activeJobCount: 0,
      queuedJobCount: 0,
      missingFilesCount: 0,
    };
  }

  const missingCount = status.missingFiles.length;
  const queuedJobs = Math.max(0, status.queuedJobCount ?? 0);
  const activeJobs = Math.max(status.activeJobCount, isTranscribing ? 1 : 0);
  const metrics = status.lastMetrics;

  let rtfValue = '—';
  let speedMultiplierLabel = isFa ? 'در انتظار اولین رونویسی' : 'Awaiting first run';
  let lastRunMeta = isFa ? 'بدون اجرای ثبت‌شده' : 'No completed runs yet';

  if (metrics && Number.isFinite(metrics.realTimeFactor) && metrics.realTimeFactor > 0) {
    rtfValue = `${metrics.realTimeFactor.toFixed(3)}x`;
    const speedX = 1 / metrics.realTimeFactor;
    if (speedX >= 1) {
      speedMultiplierLabel = isFa
        ? `${speedX.toFixed(1)}× سریع‌تر از زمان واقعی`
        : `${speedX.toFixed(1)}× faster than real-time`;
    } else {
      speedMultiplierLabel = isFa
        ? `${speedX.toFixed(2)}× سرعت زمان واقعی`
        : `${speedX.toFixed(2)}× real-time speed`;
    }
    const secStr = `${(metrics.processingTimeMs / 1000).toFixed(2)}s`;
    lastRunMeta = isFa
      ? `${metrics.tokenCount} واژه · ${secStr}`
      : `${metrics.tokenCount} words · ${secStr}`;
  } else if (metrics && metrics.processingTimeMs > 0) {
    rtfValue = '0.000x';
    speedMultiplierLabel = isFa ? 'پایان پردازش' : 'Completed';
    lastRunMeta = isFa
      ? `${metrics.tokenCount} واژه · ${metrics.processingTimeMs}ms`
      : `${metrics.tokenCount} words · ${metrics.processingTimeMs}ms`;
  }

  let healthState: ShahabWidgetHealthState;
  let healthLabel: string;
  let healthDetail: string;
  let tone: ShahabStatusWidgetViewModel['tone'];

  if (!status.available && status.integrityError) {
    healthState = 'DEGRADED_INTEGRITY_ERROR';
    healthLabel = isFa ? 'خطای اصالت فایل‌های مدل (SHA-256)' : 'Degraded — Model Integrity Failed';
    healthDetail = status.integrityError;
    tone = 'rose';
  } else if (!status.available) {
    healthState = 'DEGRADED_MISSING_ASSETS';
    healthLabel = isFa ? 'ناقص — فایل مدل یافت نشد' : 'Degraded — Model Assets Missing';
    healthDetail = isFa
      ? `${missingCount} فایل مدل روی دیسک موجود نیست`
      : `${missingCount} required model files missing`;
    tone = 'amber';
  } else if (activeJobs > 0 || queuedJobs > 0) {
    healthState = 'PROCESSING';
    healthLabel = isFa ? 'در حال رونویسی فعال' : 'Transcribing Audio';
    healthDetail =
      queuedJobs > 0
        ? isFa
          ? `${activeJobs} پردازش فعال · ${queuedJobs} در صف انتظار`
          : `${activeJobs} active · ${queuedJobs} queued`
        : isFa
          ? `${activeJobs} پردازش فعال روی هسته محلی`
          : `${activeJobs} active local inference job`;
    tone = 'sky';
  } else if (status.modelLoaded) {
    healthState = 'HEALTHY_LOADED';
    healthLabel = isFa ? 'سالم · بارگذاری‌شده در حافظه' : 'Healthy · Loaded in RAM';
    healthDetail = isFa
      ? 'آماده پردازش فوری بدون زمان بارگذاری'
      : 'Warm ONNX sessions ready for instant inference';
    tone = 'emerald';
  } else {
    healthState = 'HEALTHY_STANDBY';
    healthLabel = isFa ? 'سالم · آماده اجرا' : 'Healthy · Standby';
    healthDetail = isFa
      ? 'وزن‌های SHA-256 تأیید شده (بارگذاری هنگام اجرا)'
      : 'SHA-256 weights verified (lazy-loads on first run)';
    tone = 'emerald';
  }

  return {
    healthState,
    healthLabel,
    healthDetail,
    tone,
    modelId: status.modelId,
    modelVersion: status.modelVersion,
    runtimeLabel: isFa
      ? `${status.runtime} · ۱۰۰٪ محلی`
      : `${status.runtime} · 100% Local`,
    rtfValue,
    speedMultiplierLabel,
    lastRunMeta,
    lastCheckedTime,
    activeJobCount: activeJobs,
    queuedJobCount: queuedJobs,
    missingFilesCount: missingCount,
  };
}
