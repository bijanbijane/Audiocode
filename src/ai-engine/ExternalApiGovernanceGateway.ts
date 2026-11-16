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

export interface ExplicitUserConsentGrant {
  readonly consentId: string;
  readonly providerId: string;
  readonly allowedDataKind: ExternalDataPayloadKind;
  readonly maxApprovedCostUsd: number;
  readonly grantedAtTimestamp: number;
  readonly revoked: boolean;
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

/**
 * Enforces all 10 External API Governance Rules (Section 4),
 * mandatory execution chain (Section 10), and output validation (Section 43).
 */
export class ExternalApiGovernanceGateway {
  private userPolicy: UserExternalApiPolicy = {
    externalApiGloballyEnabled: false,
    maxAllowedAudioSnippetSeconds: 120,
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
    this.activeConsents.set(grant.consentId, { ...grant });
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
   * User Policy -> Consent Validation -> Execution Policy Enforcement -> Execution Router -> External Runtime
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
    dispatchNetworkCall: () => Promise<TResult>;
    validateExternalSchema: (raw: TResult) => TResult;
  }): Promise<ExternalAnalysisResultWithProvenance<TResult>> {
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
    if (!consent || consent.revoked) {
      throw new Error(
        'CONSENT_INVALID_OR_REVOKED: رضایت معتبر برای ارسال داده یافت نشد یا توسط کاربر لغو شده است.',
      );
    }
    if (consent.providerId !== params.providerId || consent.allowedDataKind !== params.dataKind) {
      throw new Error(
        'CONSENT_SCOPE_MISMATCH: نوع داده یا سرویس‌دهنده با مجوز رضایت کاربر هم‌خوانی ندارد.',
      );
    }

    // 3. Execution Policy Enforcement (Data Minimization + Cost Guard)
    const selectedDurationSec = TimeMath.flicksToSeconds(
      params.selectedRange.end - params.selectedRange.start,
    );
    if (selectedDurationSec <= 0 && params.dataKind === 'SELECTED_AUDIO_SNIPPET') {
      throw new Error('POLICY_INVALID_SELECTION_RANGE: بازه انتخابی صوتی نامعتبر است.');
    }

    const totalAssetDurationSec = TimeMath.flicksToSeconds(
      params.totalAssetDurationRange.end - params.totalAssetDurationRange.start,
    );

    if (
      params.dataKind === 'SELECTED_AUDIO_SNIPPET' &&
      selectedDurationSec > this.userPolicy.maxAllowedAudioSnippetSeconds &&
      totalAssetDurationSec > this.userPolicy.maxAllowedAudioSnippetSeconds
    ) {
      throw new Error(
        `POLICY_FULL_FILE_UPLOAD_FORBIDDEN: ارسال فایل کامل مجاز نیست. حداکثر قطعه مجاز ${this.userPolicy.maxAllowedAudioSnippetSeconds} ثانیه است.`,
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
        executedAtIso: new Date().toISOString(),
        requiresMandatoryUserReview: true,
      },
      validatedPayload,
    };
  }
}
