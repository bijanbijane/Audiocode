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
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-400 animate-pulse',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  slate: 'bg-slate-400',
} as const;

const TEXT_TONE_CLASS = {
  emerald: 'text-emerald-700 dark:text-emerald-400',
  sky: 'text-sky-700 dark:text-sky-300',
  amber: 'text-amber-700 dark:text-amber-300',
  rose: 'text-rose-700 dark:text-rose-400',
  slate: 'text-slate-600 dark:text-slate-400',
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
      className="rounded-lg border border-slate-200 dark:border-[#1E2738] bg-white dark:bg-[#111622] px-4 py-3"
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
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                {isFa ? 'موتور تبدیل صوت به متن شهاب' : 'SHAHAB Speech Engine'}
              </span>
              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
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
              className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate"
            >
              {vm.healthDetail}
            </p>
          </div>
        </div>

        {/* Metrics Strip: Separated by subtle hairline dividers, zero pill clutter */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 lg:gap-x-6">
          {/* Column 2: Model & Version */}
          <div className="flex items-center gap-2 min-w-0 lg:border-s lg:border-slate-200 dark:lg:border-[#1E2738] lg:ps-5">
            <Cpu className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                {isFa ? 'نسخه مدل' : 'Model Version'}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-800 dark:text-slate-200 font-mono truncate">
                <bdi dir="ltr" data-testid="shahab-widget-model-version">
                  {vm.modelVersion}
                </bdi>
              </div>
            </div>
          </div>

          {/* Column 3: Live RTF */}
          <div className="flex items-center gap-2 min-w-0 lg:border-s lg:border-slate-200 dark:lg:border-[#1E2738] lg:ps-5">
            <Gauge className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                {isFa ? 'نرخ فعلی RTF' : 'Current RTF'}
              </div>
              <div className="flex items-baseline gap-2">
                <span
                  dir="ltr"
                  data-testid="shahab-widget-rtf"
                  className="text-xs font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100"
                >
                  {vm.rtfValue}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  {vm.speedMultiplierLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Column 4: Last Run / Runtime Telemetry */}
          <div className="flex items-center gap-2 min-w-0 lg:border-s lg:border-slate-200 dark:lg:border-[#1E2738] lg:ps-5">
            <Activity className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                {isFa ? 'آخرین پردازش · پایش زنده' : 'Last Run · Live Probe'}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300 tabular-nums">
                <span data-testid="shahab-widget-last-run">{vm.lastRunMeta}</span>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span dir="ltr" className="font-mono text-slate-500 dark:text-slate-400" data-testid="shahab-widget-checked-at">
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
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] disabled:opacity-50 cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-sky-500"
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
