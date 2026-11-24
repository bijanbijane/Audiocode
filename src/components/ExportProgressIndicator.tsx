import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Loader2,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import {
  ExportUiLifecycleState,
  formatExportElapsed,
  resolveExportStatusPresentation,
} from '../utils/exportProgress';
import { formatNumberForLocale } from '../utils/formatters';

export interface ExportProgressIndicatorProps {
  state: ExportUiLifecycleState;
  progressPercent?: number | null;
  currentOperation?: string | null;
  errorMessage?: string | null;
  currentSegmentIndex?: number | null;
  totalSegments?: number | null;
  elapsedMs?: number | null;
  locale?: 'fa' | 'en';
  persianDigits?: boolean;
  testId?: string;
}

const PIPELINE_STEPS: Array<{ id: number; labelFa: string; labelEn: string }> = [
  { id: 1, labelFa: 'آماده‌سازی و اعتبارسنجی', labelEn: 'Prepare & Validate' },
  { id: 2, labelFa: 'رندر صوتی', labelEn: 'Audio Render' },
  { id: 3, labelFa: 'تأیید نهایی (Peak/LUFS)', labelEn: 'Final Verify' },
];

export const ExportProgressIndicator: React.FC<ExportProgressIndicatorProps> = ({
  state,
  progressPercent,
  currentOperation,
  errorMessage,
  currentSegmentIndex,
  totalSegments,
  elapsedMs,
  locale = 'fa',
  persianDigits = false,
  testId = 'render-progress-panel',
}) => {
  const isFa = locale === 'fa';
  const info = resolveExportStatusPresentation({
    state,
    progressPercent,
    currentOperation,
    errorMessage,
  });

  const statusBadgeClass =
    info.tone === 'success'
      ? 'bg-[var(--avp-success-soft)] text-[var(--avp-success-text)] border-[var(--avp-success)]/35'
      : info.tone === 'error'
        ? 'bg-[var(--avp-error-soft)] text-[var(--avp-error)] border-[var(--avp-error)]/35'
        : info.tone === 'paused'
          ? 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)] border-[var(--avp-warning)]/35'
          : info.tone === 'active'
            ? 'bg-[var(--avp-brand-soft)] text-[var(--avp-accent-text)] border-[var(--avp-brand)]/35'
            : 'bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)] border-[var(--avp-border)]';

  const barFillClass =
    info.tone === 'error'
      ? 'bg-[var(--avp-error)]'
      : info.tone === 'success'
        ? 'bg-[var(--avp-success)]'
        : info.tone === 'paused'
          ? 'bg-[var(--avp-warning)]'
          : info.tone === 'active'
            ? 'bg-[var(--avp-brand-solid)]'
            : 'bg-[var(--avp-border)]';

  const percentTextClass =
    info.tone === 'error'
      ? 'text-[var(--avp-error)]'
      : info.tone === 'success'
        ? 'text-[var(--avp-success-text)]'
        : info.tone === 'paused'
          ? 'text-[var(--avp-warning-text)]'
          : info.tone === 'active'
            ? 'text-[var(--avp-brand-ink)]'
            : 'text-[var(--avp-text-secondary)]';

  const StatusIcon = () => {
    if (info.isActive) {
      return <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />;
    }
    if (info.isCompleted) {
      return <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />;
    }
    if (info.isFailed) {
      return <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />;
    }
    if (info.isPaused) {
      return <PauseCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />;
    }
    if (info.isCancelled) {
      return <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />;
    }
    return <CircleDot className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />;
  };

  const hasSegmentMeta =
    typeof totalSegments === 'number' &&
    totalSegments > 0 &&
    typeof currentSegmentIndex === 'number' &&
    currentSegmentIndex >= 0 &&
    (info.isActive || info.isPaused || info.isCompleted);

  const elapsedLabel = formatExportElapsed(elapsedMs, isFa);
  const statusLabel = isFa ? info.labelFa : info.labelEn;
  const statusDetail = isFa ? info.detailFa : info.detailEn;

  return (
    <div
      data-testid={testId}
      data-export-state={state}
      className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3.5 space-y-2.5"
    >
      {/* Top Row: Status Indicator Badge + Percentage Readout */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`${testId}-status`}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold ${statusBadgeClass}`}
        >
          <StatusIcon />
          <span>{statusLabel}</span>
        </div>

        <div className="flex items-center gap-2.5 text-[11px]">
          {hasSegmentMeta && (
            <span className="text-[var(--avp-text-secondary)] tabular-nums">
              {isFa ? 'بخش' : 'Segment'}{' '}
              <bdi dir="ltr" className="font-mono font-semibold text-[var(--avp-text)]">
                {Math.min(currentSegmentIndex + 1, totalSegments)}/{totalSegments}
              </bdi>
            </span>
          )}
          {elapsedLabel && (info.isActive || info.isCompleted || info.isPaused) && (
            <span className="text-[var(--avp-text-muted)] tabular-nums">{elapsedLabel}</span>
          )}
          <span
            data-testid={`${testId}-percent`}
            className={`font-mono font-bold tabular-nums text-xs ${percentTextClass}`}
            dir="ltr"
          >
            {formatNumberForLocale(info.percent, { persianDigits })}%
          </span>
        </div>
      </div>

      {/* Accessible Progress Bar */}
      <div
        role="progressbar"
        data-testid={`${testId}-bar`}
        aria-label={isFa ? 'پیشرفت فرآیند خروجی' : 'Export progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={info.percent}
        aria-valuetext={`${statusLabel} (${info.percent}%)`}
        className="h-2.5 w-full rounded-full bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] overflow-hidden"
      >
        <div
          data-testid={`${testId}-bar-fill`}
          className={`h-full rounded-full transition-all duration-300 ease-out ${barFillClass} ${
            info.isActive ? 'animate-pulse' : ''
          }`}
          style={{ width: `${info.percent}%` }}
        />
      </div>

      {/* Stage Stepper + Status Detail */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <p className="text-[11px] text-[var(--avp-text-secondary)] leading-relaxed">
          {statusDetail}
        </p>

        <ol
          aria-label={isFa ? 'مراحل خروجی' : 'Export stages'}
          className="flex items-center gap-1.5 text-[11px] shrink-0"
        >
          {PIPELINE_STEPS.map((step) => {
            const isStepDone = info.stageIndex > step.id || info.isCompleted;
            const isStepCurrent = info.stageIndex === step.id && (info.isActive || info.isPaused);
            return (
              <li
                key={step.id}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border ${
                  isStepDone
                    ? 'bg-[var(--avp-success-soft)] text-[var(--avp-success-text)] border-[var(--avp-success)]/30 font-semibold'
                    : isStepCurrent
                      ? 'bg-[var(--avp-brand-soft)] text-[var(--avp-accent-text)] border-[var(--avp-brand)]/35 font-semibold'
                      : 'bg-[var(--avp-surface)] text-[var(--avp-text-muted)] border-[var(--avp-border-subtle)]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${
                    isStepDone
                      ? 'bg-[var(--avp-success)]'
                      : isStepCurrent
                        ? 'bg-[var(--avp-brand-solid)]'
                        : 'bg-[var(--avp-border)]'
                  }`}
                />
                <span>{isFa ? step.labelFa : step.labelEn}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
};
