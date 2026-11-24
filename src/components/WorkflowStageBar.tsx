import React from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  X,
} from 'lucide-react';
import { StudioWorkflowState, WorkflowLocale } from '../workflow/StudioWorkflowController';
import { UserFacingFailureModel } from '../reliability';
import type { CompanionHealthResponse } from '../host-bridge/companion/CompanionWebClient';
import { OfflineIndicator } from '../ui/pwa/PWAInstallControls';
import { toPersianDigits } from '../utils/formatters';

export interface AdvancedLabActions {
  readonly onOpenAsrLab: () => void;
  readonly onOpenDevPortal: () => void;
  readonly onOpenSpeechIntel: () => void;
  readonly onOpenDataFactory: () => void;
  readonly onOpenModelFactory: () => void;
  readonly onOpenSpeechSecurity: () => void;
}

export type StudioWorkflowStepId = 'file' | 'transcribe' | 'review' | 'export';

interface WorkflowStageBarProps {
  workflowState: StudioWorkflowState;
  executionMode: 'LOCAL' | 'CLOUD';
  cloudProviderStatusLabel: string;
  cloudAsrConfigured?: boolean;
  companionHealth?: CompanionHealthResponse | null;
  hasAudioLoaded: boolean;
  hasTranscriptWords: boolean;
  pendingSuggestionsCount: number;
  acceptedSuggestionsCount: number;
  activeStep: StudioWorkflowStepId;
  onSelectStep: (step: StudioWorkflowStepId) => void;
  onRunCloudGeminiAsr?: () => void;
  activeFailure: UserFacingFailureModel | null;
  canInstallPwa: boolean;
  onTriggerInstallPwa: () => void;
  onDismissFailure: () => void;
  onRetryFailure?: () => void;
  onRecoverFailure?: () => void;
  onImportAudioClick: () => void;
  onOpenLifecycleModal: (
    initialTab?: 'model' | 'offline' | 'health' | 'backup' | 'storage' | 'diagnostics' | 'companion',
  ) => void;
  persianDigits?: boolean;
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
  hasAudioLoaded,
  hasTranscriptWords,
  pendingSuggestionsCount,
  acceptedSuggestionsCount,
  activeStep,
  onSelectStep,
  onRunCloudGeminiAsr,
  activeFailure,
  canInstallPwa,
  onTriggerInstallPwa,
  onDismissFailure,
  onRetryFailure,
  onRecoverFailure,
  onOpenLifecycleModal,
  persianDigits = false,
}) => {
  const isFa = workflowState.locale === 'fa';
  const StepArrow = isFa ? ChevronLeft : ChevronRight;

  const isExportComplete = workflowState.exportStatus === 'SAVED_OR_DOWNLOADED';
  const isReviewDone =
    hasTranscriptWords && (acceptedSuggestionsCount > 0 || pendingSuggestionsCount === 0);

  const steps: Array<{
    id: StudioWorkflowStepId;
    num: string;
    label: string;
    done: boolean;
  }> = [
    {
      id: 'file',
      num: isFa || persianDigits ? '۱' : '1',
      label: isFa ? 'فایل' : 'File',
      done: hasAudioLoaded,
    },
    {
      id: 'transcribe',
      num: isFa || persianDigits ? '۲' : '2',
      label: isFa ? 'رونویسی' : 'Transcribe',
      done: hasTranscriptWords,
    },
    {
      id: 'review',
      num: isFa || persianDigits ? '۳' : '3',
      label: isFa ? 'بازبینی' : 'Review',
      done: isReviewDone,
    },
    {
      id: 'export',
      num: isFa || persianDigits ? '۴' : '4',
      label: isFa ? 'خروجی' : 'Export',
      done: isExportComplete,
    },
  ];

  return (
    <>
      {/* Responsive Mobile/Tablet Workflow Stepper + Inline PWA/Offline Utility Strip (< lg) */}
      <div
        data-testid="mobile-workflow-stage-bar"
        className="lg:hidden border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)] px-3 py-1.5 flex items-center justify-between gap-2 overflow-x-auto"
      >
        <nav
          aria-label={isFa ? 'مراحل کار تدوین صوتی' : 'Audio editing workflow stages'}
          className="flex items-center min-w-0"
        >
          <ol className="flex items-center gap-0.5 bg-[var(--avp-surface-secondary)]/80 border border-[var(--avp-border)] rounded-lg p-0.5">
            {steps.map((step, idx) => {
              const isActive = activeStep === step.id;
              return (
                <li key={step.id} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    data-testid={`mobile-workflow-step-${step.id}`}
                    aria-current={isActive ? 'step' : undefined}
                    onClick={() => onSelectStep(step.id)}
                    className={`inline-flex items-center gap-1 h-[26px] px-2 rounded-md text-[11px] transition-colors whitespace-nowrap cursor-pointer ${
                      isActive
                        ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                        : step.done
                          ? 'text-[var(--avp-text-secondary)] font-medium'
                          : 'text-[var(--avp-text-muted)]'
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-full inline-flex items-center justify-center text-[9.5px] font-semibold shrink-0 ${
                        isActive
                          ? 'bg-[var(--avp-accent)] text-white'
                          : step.done
                            ? 'text-[var(--avp-accent-text)]'
                            : 'text-[var(--avp-text-faint)]'
                      }`}
                    >
                      {step.done && !isActive ? (
                        <Check className="w-2.5 h-2.5" strokeWidth={2.5} aria-hidden="true" />
                      ) : persianDigits ? (
                        toPersianDigits(step.num)
                      ) : (
                        step.num
                      )}
                    </span>
                    <span>{step.label}</span>
                  </button>
                  {idx < steps.length - 1 && (
                    <StepArrow className="w-3 h-3 text-[var(--avp-text-faint)] shrink-0" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex items-center gap-1.5 shrink-0">
          <OfflineIndicator inline locale={workflowState.locale} />
          {canInstallPwa && (
            <button
              type="button"
              data-testid="btn-stagebar-pwa-install"
              onClick={onTriggerInstallPwa}
              className="avp-btn avp-btn-sm avp-btn-outline"
            >
              <Download className="w-3 h-3 text-[var(--avp-brand)]" aria-hidden="true" />
              <span>{isFa ? 'نصب' : 'Install'}</span>
            </button>
          )}
        </div>
      </div>

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
              className="avp-btn-icon avp-btn-icon-sm"
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
