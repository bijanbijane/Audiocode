import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  DEFAULT_COMPANION_ENDPOINT,
  STANDALONE_COMPANION_ENDPOINT,
  normalizeAndValidateCompanionEndpoint,
  runCompanionConnectionDiagnostic,
  type CompanionConnectionReport,
  type DiagnosticStageStatus,
  type OverallConnectionStatus,
} from '../host-bridge/companion/CompanionDiagnostics';
import type { WorkflowLocale } from '../workflow/StudioWorkflowController';

interface CompanionConnectionDiagnosticProps {
  endpoint: string;
  onChangeEndpoint: (nextEndpoint: string) => void;
  locale?: WorkflowLocale;
  defaultExpanded?: boolean;
  onReportUpdated?: (report: CompanionConnectionReport) => void;
}

function getOverallStatusCopy(
  status: OverallConnectionStatus | 'CHECKING',
  isFa: boolean,
): {
  label: string;
  textClass: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case 'CHECKING':
      return {
        label: isFa ? 'در حال بررسی اتصال...' : 'Checking connection...',
        textClass: 'text-sky-700 dark:text-sky-300',
        icon: <RefreshCw className="w-4 h-4 text-sky-600 dark:text-sky-400 animate-spin shrink-0" aria-hidden="true" />,
      };
    case 'CONNECTED':
      return {
        label: isFa ? 'متصل و آماده' : 'Connected & Ready',
        textClass: 'text-emerald-700 dark:text-emerald-400',
        icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />,
      };
    case 'DEGRADED':
      return {
        label: isFa ? 'اتصال ناقص' : 'Degraded',
        textClass: 'text-amber-700 dark:text-amber-400',
        icon: <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />,
      };
    case 'INVALID_ENDPOINT':
      return {
        label: isFa ? 'نشانی نامعتبر' : 'Invalid Endpoint',
        textClass: 'text-rose-700 dark:text-rose-400',
        icon: <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />,
      };
    case 'UNREACHABLE':
    default:
      return {
        label: isFa ? 'قطع / در دسترس نیست' : 'Unreachable',
        textClass: 'text-rose-700 dark:text-rose-400',
        icon: <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />,
      };
  }
}

function getStageStatusMeta(status: DiagnosticStageStatus, isFa: boolean) {
  switch (status) {
    case 'PASS':
      return {
        label: isFa ? 'تایید شد' : 'Pass',
        className: 'text-emerald-700 dark:text-emerald-400',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />,
      };
    case 'WARN':
      return {
        label: isFa ? 'هشدار' : 'Warn',
        className: 'text-amber-700 dark:text-amber-400',
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />,
      };
    case 'FAIL':
    default:
      return {
        label: isFa ? 'ناموفق' : 'Fail',
        className: 'text-rose-700 dark:text-rose-400',
        icon: <XCircle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />,
      };
  }
}

function getStageTitle(id: CompanionConnectionReport['stages'][number]['id'], isFa: boolean): React.ReactNode {
  switch (id) {
    case 'ENDPOINT_POLICY':
      return isFa ? '۱. سیاست محلی نشانی' : '1. Local Endpoint Policy';
    case 'HEALTH_PROBE':
      return isFa ? (
        <>
          ۲. سلامت سرویس (<bdi dir="ltr" className="font-mono">/health</bdi>)
        </>
      ) : (
        '2. Service Health (/health)'
      );
    case 'HANDSHAKE_AND_IPC':
      return isFa ? '۳. نشست امن و IPC' : '3. Handshake & IPC';
  }
}

export const CompanionConnectionDiagnostic: React.FC<CompanionConnectionDiagnosticProps> = ({
  endpoint,
  onChangeEndpoint,
  locale = 'fa',
  defaultExpanded = true,
  onReportUpdated,
}) => {
  const isFa = locale === 'fa';
  const inputId = useId();
  const [draftEndpoint, setDraftEndpoint] = useState<string>(endpoint);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [report, setReport] = useState<CompanionConnectionReport | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded);
  const abortRef = useRef<AbortController | null>(null);
  const onReportUpdatedRef = useRef(onReportUpdated);
  onReportUpdatedRef.current = onReportUpdated;

  useEffect(() => {
    setDraftEndpoint(endpoint);
  }, [endpoint]);

  const executeProbe = useCallback(async (targetEndpoint: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsChecking(true);
    try {
      const nextReport = await runCompanionConnectionDiagnostic({
        endpoint: targetEndpoint,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setReport(nextReport);
        onReportUpdatedRef.current?.(nextReport);
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsChecking(false);
      }
    }
  }, []);

  // Run an initial live probe against the configured endpoint on mount
  useEffect(() => {
    void executeProbe(endpoint);
    return () => {
      abortRef.current?.abort();
    };
  }, [endpoint, executeProbe]);

  const handleSubmitEndpoint = (e: React.FormEvent) => {
    e.preventDefault();
    const check = normalizeAndValidateCompanionEndpoint(draftEndpoint);
    if (!check.valid) {
      setValidationError(isFa ? check.errorMessageFa : check.errorMessageEn);
      void executeProbe(draftEndpoint);
      return;
    }
    setValidationError(null);
    setDraftEndpoint(check.normalizedEndpoint);
    if (check.normalizedEndpoint !== endpoint) {
      onChangeEndpoint(check.normalizedEndpoint);
    } else {
      void executeProbe(check.normalizedEndpoint);
    }
  };

  const handleSelectPreset = (presetUrl: string) => {
    setValidationError(null);
    setDraftEndpoint(presetUrl);
    if (presetUrl !== endpoint) {
      onChangeEndpoint(presetUrl);
    } else {
      void executeProbe(presetUrl);
    }
  };

  const effectiveStatus: OverallConnectionStatus | 'CHECKING' = isChecking
    ? 'CHECKING'
    : (report?.overallStatus ?? 'CHECKING');
  const statusMeta = getOverallStatusCopy(effectiveStatus, isFa);

  const formattedCheckedTime = report
    ? new Date(report.checkedAtIso).toLocaleTimeString(isFa ? 'fa-IR' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;

  return (
    <section
      dir={isFa ? 'rtl' : 'ltr'}
      data-testid="companion-connection-diagnostic"
      data-connection-status={effectiveStatus}
      aria-label={isFa ? 'عیب‌یابی اتصال سرویس محلی Companion' : 'Local Companion Connection Diagnostics'}
      className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg"
    >
      {/* Compact Top Summary Header */}
      <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Server className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
              {isFa ? 'عیب‌یابی اتصال سرویس محلی Companion' : 'Local Companion Connection Diagnostic'}
            </h2>
          </div>

          <span className="h-3.5 w-px bg-slate-300 dark:bg-[#252F42] hidden sm:inline-block" aria-hidden="true" />

          <div
            role="status"
            aria-live="polite"
            data-testid="companion-diagnostic-status"
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${statusMeta.textClass}`}
          >
            {statusMeta.icon}
            <span>{statusMeta.label}</span>
          </div>

          <span className="text-slate-300 dark:text-slate-600 hidden sm:inline" aria-hidden="true">·</span>

          <span
            dir="ltr"
            data-testid="companion-configured-endpoint"
            className="font-mono text-xs text-slate-600 dark:text-slate-400 truncate max-w-[260px]"
            title={endpoint}
          >
            {endpoint}
          </span>

          {report && (
            <>
              <span className="text-slate-300 dark:text-slate-600 hidden md:inline" aria-hidden="true">·</span>
              <span
                dir="ltr"
                data-testid="companion-diagnostic-latency"
                className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400"
              >
                {report.totalLatencyMs} ms
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="btn-companion-retest"
            onClick={() => void executeProbe(endpoint)}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] disabled:opacity-50 whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{isFa ? 'بررسی مجدد اتصال' : 'Test Connection'}</span>
          </button>

          <button
            type="button"
            data-testid="btn-companion-toggle-details"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-[#252F42] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            <span>{isExpanded ? (isFa ? 'بستن جزئیات' : 'Hide Details') : (isFa ? 'جزئیات و نشانی' : 'Endpoint & Details')}</span>
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Expandable Diagnostic Body */}
      {isExpanded && (
        <div className="border-t border-slate-200 dark:border-[#252F42] px-4 py-3.5 space-y-4">
          {/* Endpoint Configuration Form */}
          <form
            onSubmit={handleSubmitEndpoint}
            noValidate
            className="flex flex-col lg:flex-row lg:items-end gap-3"
          >
            <div className="flex-1 min-w-0 space-y-1">
              <label
                htmlFor={inputId}
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {isFa
                  ? 'نشانی پیکربندی‌شده API سرویس محلی Companion'
                  : 'Configured Companion Web Service API Endpoint'}
              </label>
              <input
                id={inputId}
                data-testid="input-companion-endpoint"
                type="text"
                dir="ltr"
                value={draftEndpoint}
                onChange={(e) => {
                  setDraftEndpoint(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                placeholder="/api/v2/companion"
                aria-invalid={Boolean(validationError)}
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-[#2A354B] bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-amber-500 dark:focus:border-amber-400"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="submit"
                data-testid="btn-companion-save-test"
                disabled={isChecking}
                className="px-3.5 py-2 text-xs font-semibold rounded-md bg-amber-400 text-slate-950 hover:bg-amber-300 active:bg-amber-500 disabled:opacity-50 whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-300"
              >
                {isFa ? 'ذخیره و بررسی' : 'Save & Probe'}
              </button>

              <button
                type="button"
                data-testid="btn-companion-preset-same-origin"
                onClick={() => handleSelectPreset(DEFAULT_COMPANION_ENDPOINT)}
                className={`px-2.5 py-2 text-xs font-medium rounded-md border whitespace-nowrap cursor-pointer transition-colors ${
                  endpoint === DEFAULT_COMPANION_ENDPOINT
                    ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                    : 'border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738]'
                }`}
              >
                {isFa ? (
                  <>
                    میزبان فعلی (<bdi dir="ltr" className="font-mono">/api/v2/companion</bdi>)
                  </>
                ) : (
                  'Same-Origin (/api/v2/companion)'
                )}
              </button>

              <button
                type="button"
                data-testid="btn-companion-preset-standalone"
                onClick={() => handleSelectPreset(STANDALONE_COMPANION_ENDPOINT)}
                className={`px-2.5 py-2 text-xs font-medium rounded-md border whitespace-nowrap cursor-pointer transition-colors ${
                  endpoint === STANDALONE_COMPANION_ENDPOINT
                    ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                    : 'border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738]'
                }`}
              >
                {isFa ? (
                  <>
                    دسکتاپ محلی (<bdi dir="ltr" className="font-mono">127.0.0.1:47291</bdi>)
                  </>
                ) : (
                  'Local Daemon (127.0.0.1:47291)'
                )}
              </button>
            </div>
          </form>

          {validationError && (
            <div
              role="alert"
              data-testid="companion-endpoint-validation-error"
              className="px-3 py-2 rounded-md border border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 text-xs text-rose-800 dark:text-rose-200 flex items-center gap-2"
            >
              <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />
              <span>{validationError}</span>
            </div>
          )}

          {/* 3-Stage Diagnostic Breakdown (clean hairline-divided grid, no nested card shadows) */}
          {report && (
            <div className="space-y-3">
              <div
                data-testid="companion-diagnostic-stages"
                className={`grid grid-cols-1 ${
                  report.stages.length >= 3
                    ? 'md:grid-cols-3'
                    : report.stages.length === 2
                      ? 'md:grid-cols-2'
                      : 'md:grid-cols-1'
                } divide-y md:divide-y-0 md:divide-x ${isFa ? 'md:divide-x-reverse' : ''} divide-slate-200 dark:divide-[#252F42] border border-slate-200 dark:border-[#252F42] rounded-md bg-slate-50/70 dark:bg-[#0E131D]`}
              >
                {report.stages.map((stage) => {
                  const stageMeta = getStageStatusMeta(stage.status, isFa);
                  return (
                    <div
                      key={stage.id}
                      data-testid={`companion-stage-${stage.id}`}
                      className="p-3 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-800 dark:text-slate-200">
                          {getStageTitle(stage.id, isFa)}
                        </span>
                        <span className={`inline-flex items-center gap-1 font-semibold whitespace-nowrap ${stageMeta.className}`}>
                          {stageMeta.icon}
                          <span>{stageMeta.label}</span>
                        </span>
                      </div>

                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {isFa ? stage.summaryFa : stage.summaryEn}
                      </p>

                      <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 pt-0.5">
                        <span dir="ltr" className="truncate" title={stage.detail ?? undefined}>
                          {stage.detail ?? '—'}
                        </span>
                        {stage.latencyMs !== null && (
                          <span dir="ltr" className="shrink-0">
                            {stage.latencyMs} ms
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Clean Unboxed Runtime & Privacy Proof Metadata Row */}
              {report.health && (
                <div
                  data-testid="companion-runtime-metadata"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-400"
                >
                  <span className="inline-flex items-center gap-1.5 text-slate-800 dark:text-slate-200 font-medium">
                    <Activity className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <span dir="ltr" className="font-mono">
                      {report.health.runtime.runtimeName}
                    </span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {report.health.runtime.activeModelId ? (
                      <>
                        {isFa ? 'مدل فعال:' : 'Active model:'}{' '}
                        <bdi dir="ltr" className="font-mono text-slate-800 dark:text-slate-200">
                          {report.health.runtime.activeModelId}
                        </bdi>
                      </>
                    ) : report.health.runtime.installedModels.length > 0 ? (
                      <>
                        {isFa ? 'مدل‌های محلی آماده:' : 'Local models ready:'}{' '}
                        <span className="font-mono tabular-nums text-slate-800 dark:text-slate-200">
                          {report.health.runtime.installedModels.length}
                        </span>
                      </>
                    ) : (
                      isFa ? 'مدل محلی نصب نشده' : 'No local model installed'
                    )}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span dir="ltr" className="font-mono tabular-nums">
                    {report.health.runtime.cpuThreads} threads
                  </span>
                  <span aria-hidden="true">·</span>
                  <span dir="ltr" className="font-mono tabular-nums">
                    {report.health.runtime.processRssMb} MB RSS
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {report.health.offlineOnlyEnforced
                        ? isFa
                          ? 'آفلاین کامل (بدون ارسال ابری)'
                          : 'Offline-Only Enforced'
                        : isFa
                          ? 'حالت ترکیبی'
                          : 'Hybrid Mode'}
                    </span>
                  </span>
                  {formattedCheckedTime && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums text-slate-500 dark:text-slate-400">
                        {isFa ? `آخرین بررسی: ${formattedCheckedTime}` : `Checked: ${formattedCheckedTime}`}
                      </span>
                    </>
                  )}
                </div>
              )}

              {/* Actionable Remediation Notice when not healthy */}
              {(report.remediationFa || report.remediationEn) && (
                <div
                  role="note"
                  data-testid="companion-remediation-note"
                  className="px-3 py-2 rounded-md border border-amber-500/35 bg-amber-50/70 dark:bg-amber-950/20 text-xs text-amber-900 dark:text-amber-200"
                >
                  {isFa ? report.remediationFa : report.remediationEn}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
