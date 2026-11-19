import {
  AvapardazErrorCode,
  ErrorRecoverability,
  ErrorSeverity,
  ReliabilitySubsystemId,
} from './ErrorCode';

export interface RecoveryActionRecommendation {
  readonly actionId:
    | 'RETRY_OPERATION'
    | 'INSTALL_OR_SELECT_MODEL'
    | 'REINSTALL_MODEL'
    | 'FREE_LOCAL_STORAGE'
    | 'REDUCE_MEMORY_LOAD'
    | 'RESTORE_FROM_CHECKPOINT'
    | 'RESTORE_FROM_BACKUP'
    | 'RELOAD_WHEN_SAFE'
    | 'REIMPORT_AUDIO'
    | 'INSPECT_DIAGNOSTICS'
    | 'NONE';
  readonly labelFa: string;
  readonly labelEn: string;
  readonly safeToAutoExecute: false;
}

export interface ErrorRecoveryPolicyEntry {
  readonly code: AvapardazErrorCode;
  readonly defaultSubsystem: ReliabilitySubsystemId;
  readonly defaultSeverity: ErrorSeverity;
  readonly defaultRecoverability: ErrorRecoverability;
  readonly retryRecommended: boolean;
  /** Whether retry is safe for idempotent operations; non-idempotent ops must still be gated by caller */
  readonly safeRetryForIdempotentOnly: boolean;
  readonly originalDataSafe: boolean;
  readonly userMessageFa: string;
  readonly userMessageEn: string;
  readonly recoveryAction: RecoveryActionRecommendation;
}

export const ERROR_RECOVERY_POLICY: Readonly<Record<AvapardazErrorCode, ErrorRecoveryPolicyEntry>> = {
  AUDIO_IMPORT_FAILED: {
    code: 'AUDIO_IMPORT_FAILED',
    defaultSubsystem: 'AUDIO_IMPORT',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'ورود فایل صوتی انجام نشد. فرمت یا ساختار فایل معتبر نیست.',
    userMessageEn: 'Audio import failed. The file format or header is invalid.',
    recoveryAction: {
      actionId: 'REIMPORT_AUDIO',
      labelFa: 'انتخاب فایل صوتی معتبر دیگر',
      labelEn: 'Select another valid audio file',
      safeToAutoExecute: false,
    },
  },
  AUDIO_DECODE_FAILED: {
    code: 'AUDIO_DECODE_FAILED',
    defaultSubsystem: 'AUDIO_DECODE',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'رمزگشایی فایل صوتی در مرورگر ممکن نشد. فایل ممکن است آسیب‌دیده یا کدک آن پشتیبانی‌نشده باشد.',
    userMessageEn: 'Audio decoding failed in the browser. The file may be corrupted or unsupported.',
    recoveryAction: {
      actionId: 'REIMPORT_AUDIO',
      labelFa: 'ورود نسخه WAV یا فایل سالم دیگر',
      labelEn: 'Import a WAV copy or another valid audio file',
      safeToAutoExecute: false,
    },
  },
  MODEL_NOT_INSTALLED: {
    code: 'MODEL_NOT_INSTALLED',
    defaultSubsystem: 'ASR_MODEL',
    defaultSeverity: 'WARNING',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'مدل محلی تبدیل گفتار به متن فارسی نصب نشده است. پردازش ابری انجام نمی‌شود.',
    userMessageEn: 'No local Persian ASR model is installed. Cloud fallback is disabled.',
    recoveryAction: {
      actionId: 'INSTALL_OR_SELECT_MODEL',
      labelFa: 'نصب یا انتخاب فایل مدل محلی ONNX',
      labelEn: 'Install or load a local ONNX model',
      safeToAutoExecute: false,
    },
  },
  MODEL_CHECKSUM_MISMATCH: {
    code: 'MODEL_CHECKSUM_MISMATCH',
    defaultSubsystem: 'ASR_MODEL',
    defaultSeverity: 'CRITICAL',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'تأیید اصالت (SHA-256) فایل مدل محلی ناموفق بود. مدل فعال نشد و پروژه‌های شما ایمن هستند.',
    userMessageEn: 'Local model SHA-256 integrity verification failed. Activation was blocked.',
    recoveryAction: {
      actionId: 'REINSTALL_MODEL',
      labelFa: 'نصب مجدد نسخه معتبر مدل',
      labelEn: 'Reinstall a verified model package',
      safeToAutoExecute: false,
    },
  },
  MODEL_LOAD_FAILED: {
    code: 'MODEL_LOAD_FAILED',
    defaultSubsystem: 'ASR_MODEL',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RETRYABLE',
    retryRecommended: true,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'بارگذاری مدل محلی در موتور استنتاج ناموفق بود.',
    userMessageEn: 'Failed to load the local model into the inference runtime.',
    recoveryAction: {
      actionId: 'REINSTALL_MODEL',
      labelFa: 'بررسی مدل یا تلاش مجدد',
      labelEn: 'Verify model and retry',
      safeToAutoExecute: false,
    },
  },
  ASR_RUNTIME_UNAVAILABLE: {
    code: 'ASR_RUNTIME_UNAVAILABLE',
    defaultSubsystem: 'ASR_RUNTIME',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'موتور استنتاج محلی (ONNX/WASM) در این محیط در دسترس نیست.',
    userMessageEn: 'Local inference runtime (ONNX/WASM) is unavailable in this environment.',
    recoveryAction: {
      actionId: 'INSPECT_DIAGNOSTICS',
      labelFa: 'بررسی وضعیت زیرسیستم‌ها',
      labelEn: 'Inspect subsystem health',
      safeToAutoExecute: false,
    },
  },
  ASR_INFERENCE_FAILED: {
    code: 'ASR_INFERENCE_FAILED',
    defaultSubsystem: 'ASR_RUNTIME',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RETRYABLE',
    retryRecommended: true,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'اجرای پیاده‌سازی گفتار محلی متوقف شد. فایل صوتی اصلی بدون تغییر باقی مانده است.',
    userMessageEn: 'Local speech transcription failed. Original audio remains intact.',
    recoveryAction: {
      actionId: 'RETRY_OPERATION',
      labelFa: 'تلاش مجدد پیاده‌سازی محلی',
      labelEn: 'Retry local transcription',
      safeToAutoExecute: false,
    },
  },
  WORKER_CRASHED: {
    code: 'WORKER_CRASHED',
    defaultSubsystem: 'WORKER_INFRA',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RECOVERABLE',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'یک پردازش پس‌زمینه (Worker) به‌طور غیرمنتظره متوقف شد. داده‌های اصلی پروژه حفظ شده‌اند.',
    userMessageEn: 'A background worker stopped unexpectedly. Original project data is preserved.',
    recoveryAction: {
      actionId: 'RESTORE_FROM_CHECKPOINT',
      labelFa: 'بررسی وضعیت و ادامه امن',
      labelEn: 'Check recovery state',
      safeToAutoExecute: false,
    },
  },
  WORKER_TIMEOUT: {
    code: 'WORKER_TIMEOUT',
    defaultSubsystem: 'WORKER_INFRA',
    defaultSeverity: 'WARNING',
    defaultRecoverability: 'RETRYABLE',
    retryRecommended: true,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'پاسخ‌دهی پردازش پس‌زمینه بیش از حد مجاز طول کشید و عملیات متوقف شد.',
    userMessageEn: 'A background worker timed out and the request was aborted.',
    recoveryAction: {
      actionId: 'RETRY_OPERATION',
      labelFa: 'تلاش مجدد امن',
      labelEn: 'Retry safely',
      safeToAutoExecute: false,
    },
  },
  MEMORY_BUDGET_EXCEEDED: {
    code: 'MEMORY_BUDGET_EXCEEDED',
    defaultSubsystem: 'MEMORY_BUDGET',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'سقف حافظه مجاز برنامه (۱ گیگابایت) پر شده است. عملیات سنگین جدید برای حفظ پایداری متوقف شد.',
    userMessageEn: 'Application memory budget (1 GiB) limit was reached. Heavy work was halted to protect project state.',
    recoveryAction: {
      actionId: 'REDUCE_MEMORY_LOAD',
      labelFa: 'پاکسازی کش‌های موقت و آزادسازی حافظه',
      labelEn: 'Clear temporary caches and free memory',
      safeToAutoExecute: false,
    },
  },
  STORAGE_UNAVAILABLE: {
    code: 'STORAGE_UNAVAILABLE',
    defaultSubsystem: 'LOCAL_STORAGE',
    defaultSeverity: 'WARNING',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'دسترسی به حافظه محلی مرورگر (OPFS/Storage) ممکن نیست. تغییرات فقط در حافظه موقت نگهداری می‌شوند.',
    userMessageEn: 'Browser local storage (OPFS/Storage) is unavailable. Changes remain in memory only.',
    recoveryAction: {
      actionId: 'RESTORE_FROM_BACKUP',
      labelFa: 'دریافت فایل پشتیبان محلی',
      labelEn: 'Export local backup file',
      safeToAutoExecute: false,
    },
  },
  STORAGE_QUOTA_EXCEEDED: {
    code: 'STORAGE_QUOTA_EXCEEDED',
    defaultSubsystem: 'LOCAL_STORAGE',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'فضای ذخیره‌سازی مرورگر پر شده است. عملیات نوشتن برای جلوگیری از آسیب به داده‌ها متوقف شد.',
    userMessageEn: 'Browser storage quota is full. Write was aborted to prevent data corruption.',
    recoveryAction: {
      actionId: 'FREE_LOCAL_STORAGE',
      labelFa: 'پاکسازی فایل‌های موقت و آزادسازی فضا',
      labelEn: 'Clean temporary files to free storage',
      safeToAutoExecute: false,
    },
  },
  PROJECT_PERSISTENCE_FAILED: {
    code: 'PROJECT_PERSISTENCE_FAILED',
    defaultSubsystem: 'PROJECT_PERSISTENCE',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RETRYABLE',
    retryRecommended: true,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'ذخیره وضعیت پروژه در حافظه محلی ناموفق بود. نسخه فعلی در حافظه برنامه حفظ شده است.',
    userMessageEn: 'Failed to save project state to local storage. Current state remains in memory.',
    recoveryAction: {
      actionId: 'RETRY_OPERATION',
      labelFa: 'تلاش مجدد ذخیره یا دریافت پشتیبان',
      labelEn: 'Retry save or export backup',
      safeToAutoExecute: false,
    },
  },
  PROJECT_CORRUPTED: {
    code: 'PROJECT_CORRUPTED',
    defaultSubsystem: 'PROJECT_PERSISTENCE',
    defaultSeverity: 'CRITICAL',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: false,
    originalDataSafe: false,
    userMessageFa: 'ساختار داده پروژه یا نسخه ذخیره‌شده ناسازگار یا آسیب‌دیده است و به‌طور خودکار بازنویسی نشد.',
    userMessageEn: 'The stored project record failed integrity validation and was not overwritten.',
    recoveryAction: {
      actionId: 'RESTORE_FROM_BACKUP',
      labelFa: 'بازیابی از نقطه بازگشت یا فایل پشتیبان',
      labelEn: 'Restore from checkpoint or backup',
      safeToAutoExecute: false,
    },
  },
  TRANSCRIPT_PERSISTENCE_FAILED: {
    code: 'TRANSCRIPT_PERSISTENCE_FAILED',
    defaultSubsystem: 'TRANSCRIPT_PERSISTENCE',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RETRYABLE',
    retryRecommended: true,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'ذخیره نسخه جدید متن پیاده‌شده ناموفق بود. اصلاحات شما در حافظه حفظ شده‌اند.',
    userMessageEn: 'Failed to persist the transcript version. Your edits remain in memory.',
    recoveryAction: {
      actionId: 'RETRY_OPERATION',
      labelFa: 'تلاش مجدد ذخیره متن',
      labelEn: 'Retry transcript save',
      safeToAutoExecute: false,
    },
  },
  TIMELINE_TRANSACTION_FAILED: {
    code: 'TIMELINE_TRANSACTION_FAILED',
    defaultSubsystem: 'TIMELINE_ENGINE',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RECOVERABLE',
    retryRecommended: false,
    safeRetryForIdempotentOnly: false,
    originalDataSafe: true,
    userMessageFa: 'تراکنش ویرایش تایملاین تأیید نشد و به آخرین وضعیت معتبر بازگردانده شد.',
    userMessageEn: 'Timeline transaction failed validation and was rolled back to the last valid state.',
    recoveryAction: {
      actionId: 'NONE',
      labelFa: 'بازبینی انتخاب و مرز برش',
      labelEn: 'Review selection and cut boundaries',
      safeToAutoExecute: false,
    },
  },
  RENDER_FAILED: {
    code: 'RENDER_FAILED',
    defaultSubsystem: 'AUDIO_RENDERER',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RECOVERABLE',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'رندر غیرمخرب صوت کامل نشد یا اعتبارسنجی خروجی رد شد. صوت اصلی کاملاً دست‌نخورده است.',
    userMessageEn: 'Non-destructive audio rendering failed or failed validation. Original audio is untouched.',
    recoveryAction: {
      actionId: 'RESTORE_FROM_CHECKPOINT',
      labelFa: 'بررسی خطاهای EDL یا شروع مجدد رندر',
      labelEn: 'Review EDL checks or restart render',
      safeToAutoExecute: false,
    },
  },
  EXPORT_FAILED: {
    code: 'EXPORT_FAILED',
    defaultSubsystem: 'EXPORT_PIPELINE',
    defaultSeverity: 'ERROR',
    defaultRecoverability: 'RECOVERABLE',
    retryRecommended: false,
    safeRetryForIdempotentOnly: true,
    originalDataSafe: true,
    userMessageFa: 'نوشتن یا دریافت فایل خروجی ناتمام ماند و به‌عنوان خروجی موفق ثبت نشد.',
    userMessageEn: 'Export write was interrupted and was not marked as successful.',
    recoveryAction: {
      actionId: 'FREE_LOCAL_STORAGE',
      labelFa: 'بررسی فضا و تکرار خروجی',
      labelEn: 'Verify storage space and export again',
      safeToAutoExecute: false,
    },
  },
  RECOVERY_FAILED: {
    code: 'RECOVERY_FAILED',
    defaultSubsystem: 'RECOVERY_ENGINE',
    defaultSeverity: 'CRITICAL',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: false,
    originalDataSafe: true,
    userMessageFa: 'بازیابی خودکار از نقطه بازگشت ممکن نبود. هیچ داده معتبری حذف یا بازنویسی نشده است.',
    userMessageEn: 'Automatic recovery failed. No valid project state was deleted or overwritten.',
    recoveryAction: {
      actionId: 'RESTORE_FROM_BACKUP',
      labelFa: 'بازیابی دستی از فایل پشتیبان',
      labelEn: 'Restore manually from backup file',
      safeToAutoExecute: false,
    },
  },
  UPDATE_INCOMPATIBLE: {
    code: 'UPDATE_INCOMPATIBLE',
    defaultSubsystem: 'UPDATE_MANAGER',
    defaultSeverity: 'WARNING',
    defaultRecoverability: 'REQUIRES_USER_ACTION',
    retryRecommended: false,
    safeRetryForIdempotentOnly: false,
    originalDataSafe: true,
    userMessageFa: 'به‌روزرسانی برنامه در شرایط فعلی (یا به‌دلیل ناسازگاری نسخه طرحواره) قابل فعال‌سازی نیست.',
    userMessageEn: 'Application update cannot safely proceed right now or is schema-incompatible.',
    recoveryAction: {
      actionId: 'RELOAD_WHEN_SAFE',
      labelFa: 'تکمیل کارهای فعال و سپس به‌روزرسانی',
      labelEn: 'Finish active tasks before updating',
      safeToAutoExecute: false,
    },
  },
  INTERNAL_UNEXPECTED_ERROR: {
    code: 'INTERNAL_UNEXPECTED_ERROR',
    defaultSubsystem: 'INTERNAL',
    defaultSeverity: 'CRITICAL',
    defaultRecoverability: 'UNKNOWN',
    retryRecommended: false,
    safeRetryForIdempotentOnly: false,
    originalDataSafe: true,
    userMessageFa: 'خطای داخلی غیرمنتظره رخ داد. جزئیات فنی ایمن به‌صورت محلی ثبت شد.',
    userMessageEn: 'An unexpected internal error occurred. Sanitized technical diagnostics were stored locally.',
    recoveryAction: {
      actionId: 'INSPECT_DIAGNOSTICS',
      labelFa: 'مشاهده یا دریافت گزارش عیب‌یابی محلی',
      labelEn: 'Inspect or export local diagnostics',
      safeToAutoExecute: false,
    },
  },
};

export function getRecoveryPolicy(code: AvapardazErrorCode): ErrorRecoveryPolicyEntry {
  return ERROR_RECOVERY_POLICY[code];
}
