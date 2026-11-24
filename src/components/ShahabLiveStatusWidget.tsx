import React from 'react';
import { Activity, Cpu, Gauge, RefreshCw } from 'lucide-react';
import type { ShahabLocalRuntimeStatusResponse } from '../asr-core/ShahabLocalHttpClient';
import { deriveShahabWidgetViewModel } from '../utils/shahabStatusWidgetModel';

interface ShahabLiveStatusWidgetProps {
  readonly status: ShahabLocalRuntimeStatusResponse | null;
  readonly isTranscribing: boolean;
  readonly hasCheckedOnce: boolean;
  readonly isRefreshing: boolean;
  readonly lastCheckedAtMs: number | null;
  readonly locale: 'fa' | 'en';
  readonly onRefresh: () => void;
}

const DOT_TONE_CLASS = {
  emerald: 'bg-[var(--avp-success)]',
  sky: 'bg-[var(--avp-accent)] animate-pulse',
  amber: 'bg-[var(--avp-warning)]',
  rose: 'bg-[var(--avp-danger)]',
  slate: 'bg-[var(--avp-text-subtle)]',
} as const;

const TEXT_TONE_CLASS = {
  emerald: 'text-[var(--avp-success-text)]',
  sky: 'text-[var(--avp-accent-text)]',
  amber: 'text-[var(--avp-warning-text)]',
  rose: 'text-[var(--avp-danger-text)]',
  slate: 'text-[var(--avp-text-secondary)]',
} as const;

export const ShahabLiveStatusWidget: React.FC<ShahabLiveStatusWidgetProps> = ({
  status,
  isTranscribing,
  hasCheckedOnce,
  isRefreshing,
  lastCheckedAtMs,
  locale,
  onRefresh,
}) => {
  const isFa = locale === 'fa';
  const vm = deriveShahabWidgetViewModel({
    status,
    isTranscribing,
    hasCheckedOnce,
    lastCheckedAtMs,
    locale,
  });

  return (
    <section
      dir={isFa ? 'rtl' : 'ltr'}
      data-testid="shahab-live-status-widget"
      data-health-state={vm.healthState}
      aria-label={isFa ? 'وضعیت لحظه‌ای موتور تبدیل صوت به متن شهاب' : 'SHAHAB ASR Live Engine Status'}
      className="rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] px-4 py-3"
    >
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        {/* Column 1: Engine Identity & Real-Time Health */}
        <div className="flex items-start gap-2.5 min-w-0">
          <span
            className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${DOT_TONE_CLASS[vm.tone]}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-xs font-semibold text-[var(--avp-text)]">
                {isFa ? 'موتور تبدیل صوت به متن شهاب' : 'SHAHAB Speech Engine'}
              </span>
              <span className="text-[var(--avp-text-subtle)]" aria-hidden="true">
                ·
              </span>
              <span
                data-testid="shahab-widget-health"
                className={`text-xs font-medium ${TEXT_TONE_CLASS[vm.tone]}`}
              >
                {vm.healthLabel}
              </span>
            </div>
            <p
              title={vm.healthDetail}
              className="text-[11px] text-[var(--avp-text-secondary)] mt-0.5 truncate"
            >
              {vm.healthDetail}
            </p>
          </div>
        </div>

        {/* Metrics Strip: Separated by subtle hairline dividers, zero pill clutter */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 lg:gap-x-6">
          {/* Column 2: Model & Version */}
          <div className="flex items-center gap-2 min-w-0 lg:border-s lg:border-[var(--avp-border)] lg:ps-5">
            <Cpu className="w-3.5 h-3.5 text-[var(--avp-text-muted)] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[10px] text-[var(--avp-text-muted)]">
                {isFa ? 'نسخه مدل' : 'Model Version'}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-[var(--avp-text)] font-mono truncate">
                <bdi dir="ltr" data-testid="shahab-widget-model-version">
                  {vm.modelVersion}
                </bdi>
              </div>
            </div>
          </div>

          {/* Column 3: Live RTF */}
          <div className="flex items-center gap-2 min-w-0 lg:border-s lg:border-[var(--avp-border)] lg:ps-5">
            <Gauge className="w-3.5 h-3.5 text-[var(--avp-text-muted)] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[10px] text-[var(--avp-text-muted)]">
                {isFa ? 'نرخ فعلی RTF' : 'Current RTF'}
              </div>
              <div className="flex items-baseline gap-2">
                <span
                  dir="ltr"
                  data-testid="shahab-widget-rtf"
                  className="text-xs font-semibold font-mono tabular-nums text-[var(--avp-text)]"
                >
                  {vm.rtfValue}
                </span>
                <span className="text-[11px] text-[var(--avp-text-secondary)] truncate">
                  {vm.speedMultiplierLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Column 4: Last Run / Runtime Telemetry */}
          <div className="flex items-center gap-2 min-w-0 lg:border-s lg:border-[var(--avp-border)] lg:ps-5">
            <Activity className="w-3.5 h-3.5 text-[var(--avp-text-muted)] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[10px] text-[var(--avp-text-muted)]">
                {isFa ? 'آخرین پردازش · پایش زنده' : 'Last Run · Live Probe'}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--avp-text-secondary)] tabular-nums">
                <span data-testid="shahab-widget-last-run">{vm.lastRunMeta}</span>
                <span className="text-[var(--avp-text-subtle)]" aria-hidden="true">
                  ·
                </span>
                <span dir="ltr" className="font-mono text-[var(--avp-text-muted)]" data-testid="shahab-widget-checked-at">
                  {vm.lastCheckedTime}
                </span>
              </div>
            </div>
          </div>

          {/* Live Refresh Button */}
          <button
            type="button"
            data-testid="btn-shahab-widget-refresh"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={isFa ? 'بروزرسانی وضعیت موتور شهاب' : 'Refresh SHAHAB engine status'}
            className="avp-btn avp-btn-sm avp-btn-outline text-xs shrink-0"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isFa ? 'بروزرسانی' : 'Refresh'}</span>
          </button>
        </div>
      </div>
    </section>
  );
};
