/**
 * 10 Official Platform Error Categories (Architecture Doc Section 64 / SPEC-10)
 */
export type OfficialErrorCategory =
  | 'INPUT_ERROR'
  | 'RESOURCE_ERROR'
  | 'RUNTIME_ERROR'
  | 'MODEL_ERROR'
  | 'PROCESSING_ERROR'
  | 'STORAGE_ERROR'
  | 'TIMELINE_ERROR'
  | 'EXPORT_ERROR'
  | 'POLICY_ERROR'
  | 'COMPATIBILITY_ERROR';

export type ErrorSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL_BLOCKER';

export type AutomatedRecoveryStrategy =
  | 'NONE_USER_ACTION_REQUIRED'
  | 'RETRY_WITH_EXPONENTIAL_BACKOFF'
  | 'FALLBACK_WEBGPU_TO_WASM_SIMD'
  | 'EVICT_LRU_CACHE_AND_RETRY'
  | 'RESTORE_FROM_LAST_CHECKPOINT'
  | 'SWITCH_TO_IN_PLACE_ROOM_TONE'
  | 'OPEN_IN_READ_ONLY_MODE';

export interface StructuredPlatformError {
  readonly code: string;
  readonly category: OfficialErrorCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly recoveryStrategy: AutomatedRecoveryStrategy;
  readonly userMessageFa: string;
  readonly technicalDiagnosticRedacted: string;
}

export type PlatformErrorCode = keyof typeof PLATFORM_ERROR_CATALOG;

export const PLATFORM_ERROR_CATALOG = {
  // 1. Input Error
  ERR_INPUT_INVALID_MAGIC_BYTES: {
    code: 'ERR_INPUT_INVALID_MAGIC_BYTES',
    category: 'INPUT_ERROR',
    severity: 'ERROR',
    retryable: false,
    recoveryStrategy: 'NONE_USER_ACTION_REQUIRED',
    userMessageFa: 'فرمت باینری فایل انتخابی معتبر نیست یا فایل صوتی آسیب دیده است.',
  },

  // 2. Resource Error
  ERR_RESOURCE_MEMORY_PRESSURE_HIGH: {
    code: 'ERR_RESOURCE_MEMORY_PRESSURE_HIGH',
    category: 'RESOURCE_ERROR',
    severity: 'WARNING',
    retryable: true,
    recoveryStrategy: 'EVICT_LRU_CACHE_AND_RETRY',
    userMessageFa:
      'حافظه دستگاه تحت فشار است؛ مدل‌های غیرفعال و کش موقت به صورت خودکار آزاد شدند.',
  },

  // 3. Runtime Error
  ERR_RUNTIME_WEBGPU_DEVICE_LOST: {
    code: 'ERR_RUNTIME_WEBGPU_DEVICE_LOST',
    category: 'RUNTIME_ERROR',
    severity: 'WARNING',
    retryable: true,
    recoveryStrategy: 'FALLBACK_WEBGPU_TO_WASM_SIMD',
    userMessageFa:
      'شتاب‌دهنده گرافیکی ریست شد؛ ادامه پردازش بدون وقفه به موتور پردازنده (WASM) منتقل گردید.',
  },

  // 4. Model Error
  ERR_MODEL_CHUNK_NETWORK_INTERRUPTED: {
    code: 'ERR_MODEL_CHUNK_NETWORK_INTERRUPTED',
    category: 'MODEL_ERROR',
    severity: 'WARNING',
    retryable: true,
    recoveryStrategy: 'RETRY_WITH_EXPONENTIAL_BACKOFF',
    userMessageFa:
      'اتصال اینترنت در حین دریافت قطعه مدل قطع شد؛ دانلود از آخرین قطعه سالم ادامه می‌یابد.',
  },

  // 5. Processing Error
  ERR_PROCESSING_GRAPH_CYCLE: {
    code: 'ERR_PROCESSING_GRAPH_CYCLE',
    category: 'PROCESSING_ERROR',
    severity: 'ERROR',
    retryable: false,
    recoveryStrategy: 'NONE_USER_ACTION_REQUIRED',
    userMessageFa: 'مسیر مسیریابی صدا (Routing) دارای حلقه بازخورد غیرمجاز است.',
  },

  // 6. Storage Error
  ERR_STORAGE_PROJECT_LOCKED_OTHER_TAB: {
    code: 'ERR_STORAGE_PROJECT_LOCKED_OTHER_TAB',
    category: 'STORAGE_ERROR',
    severity: 'WARNING',
    retryable: false,
    recoveryStrategy: 'OPEN_IN_READ_ONLY_MODE',
    userMessageFa:
      'این پروژه در تب دیگری در حال ویرایش است و برای حفاظت از داده‌ها در حالت فقط‌خواندنی باز شد.',
  },

  // 7. Timeline Error
  ERR_TIMELINE_MULTI_TRACK_SYNC_CONFLICT: {
    code: 'ERR_TIMELINE_MULTI_TRACK_SYNC_CONFLICT',
    category: 'TIMELINE_ERROR',
    severity: 'INFO',
    retryable: false,
    recoveryStrategy: 'SWITCH_TO_IN_PLACE_ROOM_TONE',
    userMessageFa:
      'به دلیل صحبت هم‌زمان گوینده دیگر در ترک موازی، برای حفظ همگام‌سازی از جایگزینی با صدای محیط استفاده شد.',
  },

  // 8. Export Error
  ERR_EXPORT_VALIDATION_CLIPPING: {
    code: 'ERR_EXPORT_VALIDATION_CLIPPING',
    category: 'EXPORT_ERROR',
    severity: 'ERROR',
    retryable: true,
    recoveryStrategy: 'NONE_USER_ACTION_REQUIRED',
    userMessageFa:
      'در بررسی نهایی خروجی، اشباع صدا (Clipping) شناسایی شد. لطفاً محدودکننده True Peak را فعال کنید.',
  },

  // 9. Policy Error
  ERR_POLICY_UNCONSENTED_EXTERNAL_CALL: {
    code: 'ERR_POLICY_UNCONSENTED_EXTERNAL_CALL',
    category: 'POLICY_ERROR',
    severity: 'CRITICAL_BLOCKER',
    retryable: false,
    recoveryStrategy: 'NONE_USER_ACTION_REQUIRED',
    userMessageFa:
      'ارسال داده به سرویس خارجی بدون رضایت صریح کاربر توسط سپر امنیتی مسدود شد.',
  },

  // 10. Compatibility Error
  ERR_COMPATIBILITY_NEWER_PROJECT_SCHEMA: {
    code: 'ERR_COMPATIBILITY_NEWER_PROJECT_SCHEMA',
    category: 'COMPATIBILITY_ERROR',
    severity: 'WARNING',
    retryable: false,
    recoveryStrategy: 'OPEN_IN_READ_ONLY_MODE',
    userMessageFa:
      'این پروژه با نسخه جدیدتری از برنامه ساخته شده است؛ لطفاً برای ویرایش، برنامه را به‌روزرسانی کنید.',
  },
} as const satisfies Record<string, Omit<StructuredPlatformError, 'technicalDiagnosticRedacted'>>;

/**
 * Builds a structured, telemetry-safe error object whose diagnostic payload is guaranteed
 * to scrub OS file paths and Persian transcript text (SPEC-09 Invariant #2).
 */
export function createStructuredPlatformError(
  code: PlatformErrorCode,
  rawDiagnostic: unknown,
): StructuredPlatformError {
  const entry = PLATFORM_ERROR_CATALOG[code];
  const rawMessage =
    rawDiagnostic instanceof Error
      ? rawDiagnostic.message
      : typeof rawDiagnostic === 'string'
        ? rawDiagnostic
        : String(rawDiagnostic ?? '');

  const technicalDiagnosticRedacted = rawMessage
    .replace(/([a-zA-Z]:\\[^\s]+|\/Users\/[^\s]+|\/home\/[^\s]+)/g, '[REDACTED_PATH]')
    .replace(/[\u0600-\u06FF]+(?:\u200c[\u0600-\u06FF]+)*/g, '[REDACTED_PERSIAN_CONTENT]');

  return {
    ...entry,
    technicalDiagnosticRedacted,
  };
}
