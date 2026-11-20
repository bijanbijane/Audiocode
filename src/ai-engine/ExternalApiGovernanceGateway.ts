import { TimeMath, TimeRange } from '../contracts/timebase.contract';

export type ExternalDataPayloadKind = 'SELECTED_AUDIO_SNIPPET' | 'SELECTED_TEXT_EXCERPT';

export interface UserExternalApiPolicy {
  /** Rule 1 (Section 4): Strictly disabled by default */
  readonly externalApiGloballyEnabled: boolean;
  /** Rule 4 (Section 4): Prohibits full-file audio uploads */
  readonly maxAllowedAudioSnippetSeconds: number;
  /** Rule 4 (Section 4): Caps text excerpt size to enforce data minimization */
  readonly maxAllowedTextChars?: number;
  readonly allowedProviderIds: string[];
}

export interface StudioAudioConsentBinding {
  readonly projectId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly trackId: string;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly payloadSha256: string;
  readonly providerModelId: string;
  readonly expiresAtMs: number;
}

export interface ExplicitUserConsentGrant {
  readonly consentId: string;
  readonly providerId: string;
  readonly allowedDataKind: ExternalDataPayloadKind;
  readonly maxApprovedCostUsd: number;
  readonly grantedAtTimestamp: number;
  readonly revoked: boolean;
  /** Optional cryptographic resource binding required for all Studio Cloud audio dispatches */
  readonly binding?: StudioAudioConsentBinding;
  /** Enforces atomic one-time consumption before network dispatch */
  readonly oneTimeUse?: boolean;
  readonly consumedAtTimestamp?: number | null;
}

export interface CostEstimationQuote {
  readonly providerId: string;
  readonly dataKind: ExternalDataPayloadKind;
  readonly durationSecondsOrCharCount: number;
  readonly estimatedCostUsd: number;
  readonly currencyDisplay: string;
}

export interface ExternalAnalysisResultWithProvenance<TData> {
  readonly provenance: {
    readonly origin: 'EXTERNAL_API';
    readonly providerId: string;
    readonly modelName: string;
    readonly consentIdUsed: string;
    readonly executedAtIso: string;
    readonly requiresMandatoryUserReview: true;
  };
  readonly validatedPayload: TData;
}

const DEFAULT_MAX_TEXT_CHARS = 8000;
const STUDIO_HARD_MAX_AUDIO_SECONDS = 120;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function isValidSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value.toLowerCase());
}

/**
 * Enforces all 10 External API Governance Rules (Section 4),
 * mandatory execution chain (Section 10), resource-bound one-time consent (AVP-013),
 * and output validation (Section 43).
 */
export class ExternalApiGovernanceGateway {
  private userPolicy: UserExternalApiPolicy = {
    externalApiGloballyEnabled: false,
    maxAllowedAudioSnippetSeconds: STUDIO_HARD_MAX_AUDIO_SECONDS,
    maxAllowedTextChars: DEFAULT_MAX_TEXT_CHARS,
    allowedProviderIds: [],
  };

  private activeConsents = new Map<string, ExplicitUserConsentGrant>();

  public getUserPolicy(): UserExternalApiPolicy {
    return {
      ...this.userPolicy,
      allowedProviderIds: [...this.userPolicy.allowedProviderIds],
    };
  }

  public estimateCostBeforeExecution(
    providerId: string,
    dataKind: ExternalDataPayloadKind,
    selectedRange: TimeRange,
    charCount = 0,
  ): CostEstimationQuote {
    const durationSec = Math.max(
      0,
      TimeMath.flicksToSeconds(selectedRange.end - selectedRange.start),
    );
    const unitRate = dataKind === 'SELECTED_AUDIO_SNIPPET' ? 0.0001 : 0.00001;
    const quantity = dataKind === 'SELECTED_AUDIO_SNIPPET' ? durationSec : Math.max(0, charCount);
    const estimatedCostUsd = Number((quantity * unitRate).toFixed(5));

    return {
      providerId,
      dataKind,
      durationSecondsOrCharCount: Math.ceil(quantity),
      estimatedCostUsd,
      currencyDisplay: `$${estimatedCostUsd.toFixed(4)} USD`,
    };
  }

  public registerExplicitConsent(grant: ExplicitUserConsentGrant): void {
    const normalizedBinding: StudioAudioConsentBinding | undefined = grant.binding
      ? Object.freeze({
          ...grant.binding,
          assetSha256: grant.binding.assetSha256.toLowerCase(),
          payloadSha256: grant.binding.payloadSha256.toLowerCase(),
        })
      : undefined;
    this.activeConsents.set(grant.consentId, {
      ...grant,
      binding: normalizedBinding,
      oneTimeUse: grant.oneTimeUse ?? Boolean(normalizedBinding),
      consumedAtTimestamp: grant.consumedAtTimestamp ?? null,
    });
  }

  public getConsentSnapshot(consentId: string): ExplicitUserConsentGrant | null {
    const existing = this.activeConsents.get(consentId);
    return existing ? Object.freeze({ ...existing }) : null;
  }

  public revokeConsentImmediately(consentId: string): void {
    const existing = this.activeConsents.get(consentId);
    if (existing) {
      this.activeConsents.set(consentId, { ...existing, revoked: true });
    }
  }

  public updateUserPolicy(newPolicy: UserExternalApiPolicy): void {
    this.userPolicy = {
      ...newPolicy,
      maxAllowedTextChars: newPolicy.maxAllowedTextChars ?? DEFAULT_MAX_TEXT_CHARS,
      allowedProviderIds: [...newPolicy.allowedProviderIds],
    };
  }

  /**
   * Executes mandatory Section 10 chain:
   * User Policy -> Consent Validation (with resource binding & atomic consumption) ->
   * Execution Policy Enforcement -> Execution Router -> External Runtime
   */
  public async executeThroughGovernancePipeline<TResult>(params: {
    providerId: string;
    modelName: string;
    consentId: string;
    dataKind: ExternalDataPayloadKind;
    selectedRange: TimeRange;
    totalAssetDurationRange: TimeRange;
    charCount?: number;
    isTriggeredByInternalAiFailureFallback: boolean;
    requireStudioAudioBinding?: boolean;
    studioAudioBinding?: Omit<StudioAudioConsentBinding, 'expiresAtMs'>;
    nowMs?: number;
    dispatchNetworkCall: () => Promise<TResult>;
    validateExternalSchema: (raw: TResult) => TResult;
  }): Promise<ExternalAnalysisResultWithProvenance<TResult>> {
    const nowMs =
      typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
        ? Math.trunc(params.nowMs)
        : Date.now();

    // 0. Rule 6 (Section 4): Strictly forbid silent auto-fallback from local AI
    if (params.isTriggeredByInternalAiFailureFallback) {
      throw new Error(
        'POLICY_VIOLATION_AUTO_FALLBACK_FORBIDDEN: سوییچ خودکار از موتور داخلی به API خارجی اکیداً ممنوع است.',
      );
    }

    // 1. User Policy gate
    if (!this.userPolicy.externalApiGloballyEnabled) {
      throw new Error(
        'POLICY_EXTERNAL_API_DISABLED: قابلیت API خارجی به صورت پیش‌فرض خاموش است.',
      );
    }
    if (!this.userPolicy.allowedProviderIds.includes(params.providerId)) {
      throw new Error(
        `POLICY_PROVIDER_NOT_ALLOWED: سرویس‌دهنده ${params.providerId} در لیست مجاز کاربر نیست.`,
      );
    }

    // 2. Consent Validation gate
    const consent = this.activeConsents.get(params.consentId);
    if (!consent || consent.revoked || consent.consumedAtTimestamp) {
      throw new Error(
        'CONSENT_INVALID_OR_REVOKED: رضایت معتبر برای ارسال داده یافت نشد، قبلاً مصرف شده یا توسط کاربر لغو شده است.',
      );
    }
    if (consent.providerId !== params.providerId || consent.allowedDataKind !== params.dataKind) {
      throw new Error(
        'CONSENT_SCOPE_MISMATCH: نوع داده یا سرویس‌دهنده با مجوز رضایت کاربر هم‌خوانی ندارد.',
      );
    }

    // 2b. Studio audio cryptographic resource binding & expiry validation
    const requiresBinding =
      Boolean(params.requireStudioAudioBinding) || Boolean(consent.binding) || Boolean(params.studioAudioBinding);
    if (requiresBinding) {
      const grantedBinding = consent.binding;
      const reqBinding = params.studioAudioBinding;
      if (!grantedBinding || !reqBinding) {
        throw new Error(
          'CLOUD_CONSENT_REQUIRED: مجوز ارسال صوت ابری باید به شناسه پروژه، دارایی صوتی، بازه دقیق و هش SHA-256 بسته شده باشد.',
        );
      }
      if (!Number.isFinite(grantedBinding.expiresAtMs) || nowMs >= grantedBinding.expiresAtMs) {
        this.activeConsents.set(params.consentId, { ...consent, revoked: true });
        throw new Error(
          'CLOUD_CONSENT_EXPIRED: اعتبار زمانی رضایت ارسال صوت منقضی شده است؛ لطفاً دوباره تأیید کنید.',
        );
      }
      if (
        !grantedBinding.projectId ||
        !grantedBinding.assetId ||
        !grantedBinding.trackId ||
        !isValidSha256Hex(grantedBinding.assetSha256) ||
        !isValidSha256Hex(grantedBinding.payloadSha256) ||
        !Number.isSafeInteger(grantedBinding.startSample16k) ||
        !Number.isSafeInteger(grantedBinding.endSample16k) ||
        grantedBinding.startSample16k < 0 ||
        grantedBinding.endSample16k <= grantedBinding.startSample16k ||
        grantedBinding.endSample16k - grantedBinding.startSample16k >
          16_000 * STUDIO_HARD_MAX_AUDIO_SECONDS
      ) {
        throw new Error(
          'CLOUD_CONSENT_RESOURCE_MISMATCH: اطلاعات اتصال منبع در مجوز رضایت نامعتبر است.',
        );
      }
      if (
        grantedBinding.projectId !== reqBinding.projectId ||
        grantedBinding.assetId !== reqBinding.assetId ||
        grantedBinding.assetSha256 !== reqBinding.assetSha256.toLowerCase() ||
        grantedBinding.trackId !== reqBinding.trackId ||
        grantedBinding.startSample16k !== reqBinding.startSample16k ||
        grantedBinding.endSample16k !== reqBinding.endSample16k ||
        grantedBinding.payloadSha256 !== reqBinding.payloadSha256.toLowerCase() ||
        grantedBinding.providerModelId !== reqBinding.providerModelId ||
        grantedBinding.providerModelId !== params.modelName
      ) {
        throw new Error(
          'CLOUD_CONSENT_RESOURCE_MISMATCH: فایل، بازه انتخابی یا هش بایت‌های صوتی با رضایت تأییدشده مطابقت ندارد.',
        );
      }
    }

    // 3. Execution Policy Enforcement (Unconditional Data Minimization + Cost Guard)
    const selectedDurationSec = TimeMath.flicksToSeconds(
      params.selectedRange.end - params.selectedRange.start,
    );
    if (
      params.dataKind === 'SELECTED_AUDIO_SNIPPET' &&
      (!Number.isFinite(selectedDurationSec) || selectedDurationSec <= 0)
    ) {
      throw new Error('POLICY_INVALID_SELECTION_RANGE: بازه انتخابی صوتی نامعتبر است.');
    }

    const effectiveMaxSnippetSec = requiresBinding
      ? Math.min(this.userPolicy.maxAllowedAudioSnippetSeconds, STUDIO_HARD_MAX_AUDIO_SECONDS)
      : this.userPolicy.maxAllowedAudioSnippetSeconds;

    if (
      params.dataKind === 'SELECTED_AUDIO_SNIPPET' &&
      selectedDurationSec > effectiveMaxSnippetSec
    ) {
      throw new Error(
        `POLICY_FULL_FILE_UPLOAD_FORBIDDEN: ارسال قطعه صوتی بیش از سقف مجاز ممنوع است. حداکثر قطعه مجاز ${effectiveMaxSnippetSec} ثانیه است.`,
      );
    }

    const maxChars = this.userPolicy.maxAllowedTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    const effectiveChars = params.charCount ?? 0;
    if (params.dataKind === 'SELECTED_TEXT_EXCERPT' && effectiveChars > maxChars) {
      throw new Error(
        `POLICY_TEXT_MINIMIZATION_EXCEEDED: حداکثر طول متن ارسالی ${maxChars} کاراکتر است.`,
      );
    }

    const quote = this.estimateCostBeforeExecution(
      params.providerId,
      params.dataKind,
      params.selectedRange,
      effectiveChars,
    );
    if (quote.estimatedCostUsd > consent.maxApprovedCostUsd) {
      throw new Error(
        `POLICY_COST_EXCEEDS_CONSENT: هزینه تخمینی (${quote.currencyDisplay}) بیش از سقف تأییدشده توسط کاربر است.`,
      );
    }

    // 3b. Atomic one-time consumption BEFORE network dispatch so failed/retried calls cannot reuse the grant
    if (consent.oneTimeUse || requiresBinding) {
      this.activeConsents.set(params.consentId, {
        ...consent,
        revoked: true,
        consumedAtTimestamp: nowMs,
      });
    }

    // 4. Execution Router -> External API Runtime
    const rawResponse = await params.dispatchNetworkCall();
    const validatedPayload = params.validateExternalSchema(rawResponse);

    // 5. Provenance tagging + mandatory manual review gate
    return {
      provenance: {
        origin: 'EXTERNAL_API',
        providerId: params.providerId,
        modelName: params.modelName,
        consentIdUsed: params.consentId,
        executedAtIso: new Date(nowMs).toISOString(),
        requiresMandatoryUserReview: true,
      },
      validatedPayload,
    };
  }
}
