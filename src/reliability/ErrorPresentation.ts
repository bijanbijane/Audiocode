import { AvapardazError } from './AvapardazError';
import { AvapardazErrorCode, ErrorRecoverability, ErrorSeverity } from './ErrorCode';
import { RecoveryActionRecommendation } from './RecoveryPolicy';

export interface UserFacingFailureModel {
  readonly code: AvapardazErrorCode;
  readonly severity: ErrorSeverity;
  readonly recoverability: ErrorRecoverability;
  readonly title: string;
  readonly explanation: string;
  readonly originalDataStatus: string;
  readonly retryStatusText: string;
  readonly canRetry: boolean;
  readonly recoveryAction: RecoveryActionRecommendation | null;
  readonly correlationId: string;
  readonly timestampIso: string;
}

const TITLES_FA: Readonly<Record<AvapardazErrorCode, string>> = {
  AUDIO_IMPORT_FAILED: 'خطا در ورود فایل صوتی',
  AUDIO_DECODE_FAILED: 'خطا در رمزگشایی صوت',
  MODEL_NOT_INSTALLED: 'مدل محلی نصب نشده است',
  MODEL_CHECKSUM_MISMATCH: 'عدم تطابق اصالت فایل مدل',
  MODEL_LOAD_FAILED: 'خطا در بارگذاری مدل محلی',
  ASR_RUNTIME_UNAVAILABLE: 'موتور استنتاج محلی در دسترس نیست',
  ASR_INFERENCE_FAILED: 'توقف در پیاده‌سازی گفتار محلی',
  WORKER_CRASHED: 'توقف غیرمنتظره پردازش پس‌زمینه',
  WORKER_TIMEOUT: 'پایان مهلت زمانی پردازش پس‌زمینه',
  MEMORY_BUDGET_EXCEEDED: 'تکمیل سقف حافظه مجاز برنامه',
  STORAGE_UNAVAILABLE: 'حافظه محلی مرورگر در دسترس نیست',
  STORAGE_QUOTA_EXCEEDED: 'فضای ذخیره‌سازی مرورگر پر شده است',
  PROJECT_PERSISTENCE_FAILED: 'خطا در ذخیره پروژه',
  PROJECT_CORRUPTED: 'ناسازگاری یا آسیب در داده پروژه',
  TRANSCRIPT_PERSISTENCE_FAILED: 'خطا در ذخیره نسخه متن',
  TIMELINE_TRANSACTION_FAILED: 'لغو تراکنش نامعتبر تایملاین',
  RENDER_FAILED: 'توقف یا رد اعتبارسنجی رندر صوت',
  EXPORT_FAILED: 'خروجی فایل ناتمام ماند',
  RECOVERY_FAILED: 'خطا در بازیابی خودکار',
  UPDATE_INCOMPATIBLE: 'محدودیت در اعمال به‌روزرسانی',
  INTERNAL_UNEXPECTED_ERROR: 'خطای داخلی غیرمنتظره',
};

const TITLES_EN: Readonly<Record<AvapardazErrorCode, string>> = {
  AUDIO_IMPORT_FAILED: 'Audio Import Failed',
  AUDIO_DECODE_FAILED: 'Audio Decoding Failed',
  MODEL_NOT_INSTALLED: 'Local ASR Model Not Installed',
  MODEL_CHECKSUM_MISMATCH: 'Model Integrity Verification Failed',
  MODEL_LOAD_FAILED: 'Model Load Failed',
  ASR_RUNTIME_UNAVAILABLE: 'Local Inference Runtime Unavailable',
  ASR_INFERENCE_FAILED: 'Local Speech Transcription Failed',
  WORKER_CRASHED: 'Background Worker Stopped Unexpectedly',
  WORKER_TIMEOUT: 'Background Worker Timed Out',
  MEMORY_BUDGET_EXCEEDED: 'Memory Budget Limit Reached',
  STORAGE_UNAVAILABLE: 'Local Storage Unavailable',
  STORAGE_QUOTA_EXCEEDED: 'Browser Storage Quota Full',
  PROJECT_PERSISTENCE_FAILED: 'Project Save Failed',
  PROJECT_CORRUPTED: 'Project Integrity Failure',
  TRANSCRIPT_PERSISTENCE_FAILED: 'Transcript Save Failed',
  TIMELINE_TRANSACTION_FAILED: 'Timeline Transaction Rejected',
  RENDER_FAILED: 'Audio Render Failed',
  EXPORT_FAILED: 'Export Interrupted',
  RECOVERY_FAILED: 'Recovery Failed',
  UPDATE_INCOMPATIBLE: 'Update Blocked or Incompatible',
  INTERNAL_UNEXPECTED_ERROR: 'Unexpected Internal Error',
};

/**
 * Produces a user-safe failure view model with zero stack traces, zero file paths,
 * explicit data-safety status, and honest retryability.
 */
export function buildUserFacingFailure(
  error: AvapardazError,
  locale: 'fa' | 'en' = 'fa',
): UserFacingFailureModel {
  const isFa = locale === 'fa';
  const hasRealAction = error.recoveryAction.actionId !== 'NONE';

  const originalDataStatus = error.originalDataSafe
    ? isFa
      ? 'فایل صوتی اصلی و وضعیت معتبر پروژه بدون آسیب حفظ شده‌اند.'
      : 'Original audio and valid project state remain intact.'
    : isFa
      ? 'ساختار ذخیره‌شده نیاز به بررسی دارد؛ بازنویسی خودکار انجام نشد.'
      : 'Stored record requires inspection; automatic overwrite was blocked.';

  const retryStatusText = error.retryRecommended
    ? isFa
      ? 'تکرار این عملیات ایمن است.'
      : 'Retrying this operation is safe.'
    : isFa
      ? 'تکرار خودکار بدون رفع علت توصیه نمی‌شود.'
      : 'Blind retry is disabled until the root cause is addressed.';

  return {
    code: error.code,
    severity: error.severity,
    recoverability: error.recoverability,
    title: isFa ? TITLES_FA[error.code] : TITLES_EN[error.code],
    explanation: isFa ? error.userSafeMessageFa : error.userSafeMessageEn,
    originalDataStatus,
    retryStatusText,
    canRetry: error.retryRecommended,
    recoveryAction: hasRealAction ? error.recoveryAction : null,
    correlationId: error.correlationId,
    timestampIso: error.timestampIso,
  };
}
