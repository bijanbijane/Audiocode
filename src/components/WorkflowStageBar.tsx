import React from 'react';
import {
  AlertTriangle,
  RefreshCw,
  X,
} from 'lucide-react';
import { StudioWorkflowState, WorkflowLocale } from '../workflow/StudioWorkflowController';
import { UserFacingFailureModel } from '../reliability';
import type { CompanionHealthResponse } from '../host-bridge/companion/CompanionWebClient';

export type StudioWorkflowStepId = 'file' | 'transcribe' | 'review' | 'export';

interface WorkflowStageBarProps {
  workflowState: StudioWorkflowState;
  cloudAsrConfigured?: boolean;
  onRunCloudGeminiAsr?: () => void;
  activeFailure: UserFacingFailureModel | null;
  onDismissFailure: () => void;
  onRetryFailure?: () => void;
  onRecoverFailure?: () => void;
  onOpenLifecycleModal: (
    initialTab?: 'model' | 'offline' | 'health' | 'backup' | 'storage' | 'diagnostics' | 'companion',
  ) => void;
}

export function formatAsrShortStatus(
  state: StudioWorkflowState['asrState'],
  locale: WorkflowLocale,
  companionHealth?: CompanionHealthResponse | null,
): string {
  const isFa = locale === 'fa';
  switch (state) {
    case 'MODEL_NOT_INSTALLED':
      return isFa ? 'مدل محلی نصب نشده' : 'Local Model Not Installed';
    case 'MODEL_AVAILABLE':
      return isFa ? 'مدل محلی آماده' : 'Local Model Verified';
    case 'MODEL_INTEGRITY_FAILURE':
      return isFa ? 'خطای اصالت مدل' : 'Model Integrity Error';
    case 'RUNTIME_UNAVAILABLE':
      return isFa ? 'موتور محلی ناموجود' : 'Runtime Unavailable';
    case 'MODEL_LOADING':
      return isFa ? 'بارگذاری مدل...' : 'Loading Model...';
    case 'MODEL_READY':
      if (companionHealth?.runtime?.available) {
        return isFa ? 'موتور محلی شهاب آماده' : 'Native Engine Ready';
      }
      return isFa ? 'مدل محلی آماده' : 'Local Model Ready';
    case 'INFERENCE_RUNNING':
      return isFa ? 'در حال رونویسی...' : 'Transcribing...';
    case 'INFERENCE_FAILED':
      return isFa ? 'خطای رونویسی' : 'Transcription Failed';
    case 'NO_SPEECH_DETECTED':
      return isFa ? 'گفتاری یافت نشد' : 'No Speech Detected';
    case 'TRANSCRIPTION_COMPLETED':
      return isFa ? 'رونویسی آماده' : 'Transcript Ready';
    case 'TRANSCRIPTION_CANCELLED':
      return isFa ? 'رونویسی لغو شد' : 'Cancelled';
  }
}

export const WorkflowStageBar: React.FC<WorkflowStageBarProps> = ({
  workflowState,
  cloudAsrConfigured = false,
  activeFailure,
  onRunCloudGeminiAsr,
  onDismissFailure,
  onRetryFailure,
  onRecoverFailure,
  onOpenLifecycleModal,
}) => {
  const isFa = workflowState.locale === 'fa';

  return (
    <>
      {/* Honest User-Facing Failure Banner (only when an actual failure occurred) */}
      {activeFailure && (
        <div
          role="alert"
          data-testid="reliability-failure-banner"
          className="border-b border-[var(--avp-danger)]/35 bg-[var(--avp-danger-soft)] px-4 py-2.5 text-xs space-y-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle
                className="w-4 h-4 text-[var(--avp-danger)] shrink-0 mt-0.5"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <div className="space-y-0.5">
                <div className="font-semibold text-[var(--avp-text)]">{activeFailure.title}</div>
                <p className="text-[var(--avp-text-secondary)] leading-relaxed">
                  {activeFailure.explanation}
                </p>
                <p className="text-[var(--avp-accent-text)] font-medium">
                  {activeFailure.originalDataStatus}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onDismissFailure}
              aria-label={isFa ? 'بستن اعلان خطا' : 'Dismiss error notice'}
              className="avp-btn-icon avp-btn-icon-sm avp-touch-icon"
            >
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 ps-6">
            {activeFailure.code === 'MODEL_NOT_INSTALLED' &&
              cloudAsrConfigured &&
              onRunCloudGeminiAsr && (
                <button
                  type="button"
                  data-testid="btn-banner-cloud-gemini-asr"
                  onClick={onRunCloudGeminiAsr}
                  className="avp-btn avp-btn-sm avp-btn-tonal"
                >
                  <span>
                    {isFa
                      ? 'تشخیص کلمات با Gemini ASR (انتقال صریح به ابری)'
                      : 'Transcribe via Gemini ASR (Opt-In Cloud)'}
                  </span>
                </button>
              )}
            {activeFailure.canRetry && onRetryFailure && (
              <button
                type="button"
                onClick={onRetryFailure}
                className="avp-btn avp-btn-sm avp-btn-warning-tonal"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>{isFa ? 'تلاش مجدد' : 'Retry'}</span>
              </button>
            )}
            {activeFailure.recoveryAction && onRecoverFailure && (
              <button
                type="button"
                onClick={onRecoverFailure}
                className="avp-btn avp-btn-sm avp-btn-outline"
              >
                {isFa ? activeFailure.recoveryAction.labelFa : activeFailure.recoveryAction.labelEn}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenLifecycleModal('diagnostics')}
              className="avp-btn avp-btn-sm avp-btn-ghost"
            >
              {isFa ? 'مشاهده گزارش عیب‌یابی' : 'View Diagnostics'}
            </button>
            <bdi
              dir="ltr"
              className="avp-bidi-num text-[11px] text-[var(--avp-text-muted)] ms-auto"
            >
              {activeFailure.code}
            </bdi>
          </div>
        </div>
      )}
    </>
  );
};
