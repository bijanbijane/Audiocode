import {
  evaluateOutboundUrlPolicy,
  LOCAL_ONLY_PROTECTED_DATA_CLASSES,
  LocalPrivacyViolationError,
  type OutboundRequestAuditRecord,
} from '../security/LocalPrivacyPolicy';

/**
 * Avapardaz Phase-01 Local-Only Execution Policy (AVP-P01-006)
 *
 * Non-negotiable product invariants:
 * - Zero audio upload to Cloud / Gemini / OpenAI / third-party ASR APIs in production.
 * - Zero silent fallback to external APIs.
 * - Zero fake, canned, or placeholder transcript generation when a real local ASR model is absent.
 */

export const LOCAL_EXECUTION_POLICY_VERSION = '1.0.0-avp-p01' as const;

export type LocalAsrReadinessCode =
  | 'LOCAL_ASR_MODEL_NOT_INSTALLED'
  | 'LOCAL_ASR_MODEL_NOT_READY'
  | 'LOCAL_ASR_INTEGRITY_FAILED'
  | 'LOCAL_ONLY_CLOUD_ASR_BLOCKED'
  | 'LOCAL_ASR_READY';

export interface LocalAsrReadinessDecision {
  readonly ready: boolean;
  readonly code: LocalAsrReadinessCode;
  readonly allowCloudFallback: false;
  readonly allowFakeTranscriptFallback: false;
  readonly titleFa: string;
  readonly messageFa: string;
  readonly reasonEn: string;
}

export interface LocalExecutionPolicyConfig {
  readonly localOnlyEnforced: true;
  readonly allowCloudAsr: false;
  readonly allowFakeTranscriptGeneration: false;
  readonly protectedDataClasses: readonly string[];
}

export const AVAPARDAZ_LOCAL_EXECUTION_POLICY: LocalExecutionPolicyConfig = Object.freeze({
  localOnlyEnforced: true,
  allowCloudAsr: false,
  allowFakeTranscriptGeneration: false,
  protectedDataClasses: LOCAL_ONLY_PROTECTED_DATA_CLASSES,
});

export class LocalAsrPolicyError extends Error {
  public readonly code: LocalAsrReadinessCode;

  constructor(code: LocalAsrReadinessCode, message: string) {
    super(message);
    this.name = 'LocalAsrPolicyError';
    this.code = code;
  }
}

/**
 * Evaluates whether local neural ASR transcription may execute right now.
 * Never permits Cloud ASR fallback or synthetic/placeholder transcript generation.
 */
export function evaluateLocalAsrExecutionReadiness(params: {
  readonly hasInstalledModelWeights: boolean;
  readonly hasVerifiedInferenceEngine: boolean;
  readonly requestedCloudMode?: boolean;
}): LocalAsrReadinessDecision {
  if (params.requestedCloudMode) {
    return {
      ready: false,
      code: 'LOCAL_ONLY_CLOUD_ASR_BLOCKED',
      allowCloudFallback: false,
      allowFakeTranscriptFallback: false,
      titleFa: 'ارسال صوت به سرور ابری غیرفعال است (سیاست ۱۰۰٪ محلی)',
      messageFa:
        'در معماری Local-Only آواپرداز، ارسال فایل صوتی به سرویس‌های ابری (از جمله Gemini ASR) به‌طور کامل مسدود است و هیچ داده صوتی از دستگاه خارج نمی‌شود.',
      reasonEn:
        'Cloud ASR execution is permanently disabled by AVAPARDAZ Local-Only Execution Policy (AVP-P01-006).',
    };
  }

  if (!params.hasInstalledModelWeights) {
    return {
      ready: false,
      code: 'LOCAL_ASR_MODEL_NOT_INSTALLED',
      allowCloudFallback: false,
      allowFakeTranscriptFallback: false,
      titleFa: 'مدل عصبی محلی (.onnx) نصب نشده است',
      messageFa:
        'هیچ مدل ASR محلی نصب نشده است. برای حفظ دقت و حریم خصوصی، نه متن ساختگی تولید می‌شود و نه صوت به سرور ابری ارسال می‌گردد. می‌توانید از «هم‌ترازی با متن دلخواه» یا «بخش‌بندی زمانی موج صوت» استفاده کنید.',
      reasonEn:
        'LOCAL_ASR_MODEL_NOT_INSTALLED: No local ONNX/native ASR model weights are installed; cloud fallback and fake transcripts are forbidden.',
    };
  }

  if (!params.hasVerifiedInferenceEngine) {
    return {
      ready: false,
      code: 'LOCAL_ASR_MODEL_NOT_READY',
      allowCloudFallback: false,
      allowFakeTranscriptFallback: false,
      titleFa: 'موتور استنتاج عصبی محلی هنوز فعال نشده است',
      messageFa:
        'فایل مدل محلی ثبت شده است، اما موتور استنتاج عصبی محلی (ONNX/Native CPU) در فازهای بعدی روی این زیرساخت نصب می‌شود. برای جلوگیری از متن ساختگی، رونویسی خودکار متوقف شد؛ می‌توانید هم‌ترازی متن دلخواه یا بخش‌بندی آوایی را اجرا کنید.',
      reasonEn:
        'LOCAL_ASR_MODEL_NOT_READY: Real local neural inference backend is scheduled after PHASE-01; refusing synthetic or cloud fallback.',
    };
  }

  return {
    ready: true,
    code: 'LOCAL_ASR_READY',
    allowCloudFallback: false,
    allowFakeTranscriptFallback: false,
    titleFa: 'موتور محلی آماده است',
    messageFa: 'پردازش صوت به‌صورت کاملاً محلی روی دستگاه شما اجرا می‌شود.',
    reasonEn: 'Local ASR runtime and verified weights are ready.',
  };
}

/**
 * Guards any outbound network attempt from ASR/audio pipelines so zero external
 * requests or `/api/v1/asr/transcribe` calls can ever occur.
 */
export function assertLocalOnlyNetworkRequest(
  url: string,
  method = 'GET',
  allowedLocalOrigin?: string,
): OutboundRequestAuditRecord {
  const verdict = evaluateOutboundUrlPolicy(url, allowedLocalOrigin);
  const record: OutboundRequestAuditRecord = {
    url,
    method: method.toUpperCase(),
    allowed: verdict.allowed,
    reason: verdict.reason,
    timestampMs: Date.now(),
  };

  if (!verdict.allowed) {
    throw new LocalPrivacyViolationError(url, verdict.reason);
  }
  return record;
}

/**
 * Wraps a fetch implementation with strict Local-Only ASR network isolation and audit recording.
 */
export function createLocalOnlyFetchGuard(
  baseFetch: typeof fetch,
  options?: { readonly allowedLocalOrigin?: string },
): {
  readonly guardedFetch: typeof fetch;
  readonly getAuditLog: () => readonly OutboundRequestAuditRecord[];
  readonly getBlockedCount: () => number;
} {
  const auditLog: OutboundRequestAuditRecord[] = [];

  const guardedFetch: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ??
      (typeof input === 'object' && input !== null && 'method' in input ? input.method : 'GET')
    ).toUpperCase();

    const verdict = evaluateOutboundUrlPolicy(rawUrl, options?.allowedLocalOrigin);
    const record: OutboundRequestAuditRecord = {
      url: rawUrl,
      method,
      allowed: verdict.allowed,
      reason: verdict.reason,
      timestampMs: Date.now(),
    };
    auditLog.push(record);

    if (!verdict.allowed) {
      throw new LocalPrivacyViolationError(rawUrl, verdict.reason);
    }

    return baseFetch(input, init);
  };

  return {
    guardedFetch,
    getAuditLog: () => [...auditLog],
    getBlockedCount: () => auditLog.filter((r) => !r.allowed).length,
  };
}
