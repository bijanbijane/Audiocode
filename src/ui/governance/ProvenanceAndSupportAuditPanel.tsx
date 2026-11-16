import React, { useMemo, useState } from 'react';
import { CheckCircle2, Cpu, Globe, ShieldCheck, Trash2 } from 'lucide-react';
import { AudioSecurityGuard } from '../../security/AudioSecurityGuard';

export interface AnalysisProvenanceItem {
  readonly analysisId: string;
  readonly taskTitleFa: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly executedRuntime: 'LOCAL_WEBGPU' | 'LOCAL_WASM_SIMD' | 'EXTERNAL_API';
  readonly inputAssetHashPrefix: string;
  readonly confidencePercent: number;
  readonly validityStatus: 'VALID_CURRENT' | 'STALE_NEEDS_REVALIDATION';
}

export interface DiagnosticLogEntry {
  readonly logId: string;
  readonly timestampIso: string;
  readonly category: string;
  readonly rawMessage: string;
}

export interface ProvenanceAndAuditProps {
  provenanceItems: readonly AnalysisProvenanceItem[];
  diagnosticLogs: readonly DiagnosticLogEntry[];
  onSendApprovedDiagnosticBundle: (sanitizedJsonPayload: string) => void;
}

/**
 * AI Provenance Registry & Pre-Send Support Log Privacy Inspector (Sections 4, 36, 42 & 50)
 * Shows exact model version, input asset hash, runtime environment, and validity status,
 * and allows inspecting + deleting individual redacted support log lines prior to explicit user send.
 */
export const ProvenanceAndSupportAuditPanel: React.FC<ProvenanceAndAuditProps> = ({
  provenanceItems,
  diagnosticLogs,
  onSendApprovedDiagnosticBundle,
}) => {
  const [editableLogs, setEditableLogs] = useState(() =>
    diagnosticLogs.map((log) => ({
      ...log,
      sanitizedMessage: AudioSecurityGuard.sanitizeErrorForTelemetry(log.rawMessage),
    })),
  );
  const [bundleDispatchedCount, setBundleDispatchedCount] = useState(0);

  const handleRemoveLogLine = (logId: string) => {
    setEditableLogs((prev) => prev.filter((item) => item.logId !== logId));
  };

  const finalExportableJson = useMemo(
    () =>
      JSON.stringify(
        {
          privacyBoundaryVerified: true,
          containsAudioOrTranscriptContent: false,
          logsCount: editableLogs.length,
          logs: editableLogs.map((l) => ({
            time: l.timestampIso,
            cat: l.category,
            msg: l.sanitizedMessage,
          })),
        },
        null,
        2,
      ),
    [editableLogs],
  );

  const handleApproveAndSend = () => {
    if (editableLogs.length === 0) return;
    onSendApprovedDiagnosticBundle(finalExportableJson);
    setBundleDispatchedCount((c) => c + 1);
  };

  return (
    <div
      dir="rtl"
      className="grid grid-cols-1 lg:grid-cols-2 gap-4 bg-slate-950 text-slate-100 p-4 rounded-xl border border-slate-800"
    >
      {/* Column 1: AI Analysis Provenance Registry (Sections 36 & 50) */}
      <section
        aria-label="شناسنامه منشأ تحلیل‌های هوشمند"
        className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-sm text-sky-400">
              شناسنامه منشأ تحلیل‌های هوشمند (AI Provenance Registry)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              ردیابی دقیق نسخه مدل، محیط اجرا و اعتبار نتایج روی نسخه فعلی پروژه
            </p>
          </div>
          <span className="text-[11px] font-mono tabular-nums text-slate-400 whitespace-nowrap shrink-0">
            {provenanceItems.length} تحلیل ثبت‌شده
          </span>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {provenanceItems.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center">
              هنوز تحلیلی برای نمایش در رجیستری منشأ ثبت نشده است.
            </p>
          ) : (
            provenanceItems.map((item) => (
              <div
                key={item.analysisId}
                className="p-3 rounded-lg bg-slate-950 border border-slate-800/90 flex flex-col gap-1.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-200">{item.taskTitleFa}</span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
                        item.validityStatus === 'VALID_CURRENT'
                          ? 'bg-sky-950/70 text-sky-300 border border-sky-800/80'
                          : 'bg-amber-950/70 text-amber-300 border border-amber-700/80'
                      }`}
                    >
                      {item.validityStatus === 'VALID_CURRENT'
                        ? 'معتبر برای نسخه فعلی'
                        : 'نیازمند بازسنجی'}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
                        item.executedRuntime === 'EXTERNAL_API'
                          ? 'bg-amber-950 text-amber-300 border border-amber-700'
                          : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                      }`}
                    >
                      {item.executedRuntime === 'EXTERNAL_API' ? (
                        <>
                          <Globe className="w-3 h-3" aria-hidden="true" />
                          <span>API خارجی (با رضایت کاربر)</span>
                        </>
                      ) : (
                        <>
                          <Cpu className="w-3 h-3" aria-hidden="true" />
                          <span>پردازش محلی ({item.executedRuntime})</span>
                        </>
                      )}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400 text-[11px]">
                  <span>
                    مدل: <span dir="ltr" className="font-mono text-slate-300">{item.modelId}</span> (v
                    {item.modelVersion})
                  </span>
                  <span>
                    هش رسانه:{' '}
                    <span dir="ltr" className="font-mono text-slate-300">
                      #{item.inputAssetHashPrefix}
                    </span>
                  </span>
                  <span className="tabular-nums">اطمینان: {item.confidencePercent}%</span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Column 2: Pre-Send Support Diagnostic Privacy Audit (Section 42) */}
      <section
        aria-label="ممیزی حریم خصوصی گزارش پشتیبانی"
        className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-sm text-emerald-400 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>ممیزی حریم خصوصی گزارش فنی پیش از ارسال (بخش ۴۲)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              مسیرهای فایل محلی و متون فارسی به‌طور خودکار با{' '}
              <span dir="ltr" className="font-mono text-slate-300">
                [REDACTED]
              </span>{' '}
              پاک‌سازی شده‌اند؛ پیش از ارسال می‌توانید هر ردیف را حذف کنید.
            </p>
          </div>
        </div>

        <div className="space-y-1.5 max-h-40 overflow-y-auto bg-slate-950 p-2 rounded-lg border border-slate-800">
          {editableLogs.length === 0 ? (
            <p className="text-xs text-slate-400 py-3 text-center">
              تمام ردیف‌های گزارش حذف شدند؛ داده‌ای برای ارسال وجود ندارد.
            </p>
          ) : (
            editableLogs.map((log) => (
              <div
                key={log.logId}
                className="flex items-center justify-between gap-2 text-xs bg-slate-900 px-2.5 py-1.5 rounded"
              >
                <span className="font-mono text-[11px] text-slate-300 truncate" dir="ltr">
                  [{log.category}] {log.sanitizedMessage}
                </span>
                <button
                  type="button"
                  aria-label={`حذف ردیف ${log.category} (${log.logId})`}
                  onClick={() => handleRemoveLogLine(log.logId)}
                  className="inline-flex items-center gap-1 text-rose-400 hover:text-rose-300 text-[11px] shrink-0 px-2 py-0.5 bg-rose-950/60 border border-rose-900/60 rounded cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" aria-hidden="true" />
                  <span>حذف این خط</span>
                </button>
              </div>
            ))
          )}
        </div>

        <pre
          dir="ltr"
          aria-label="پیش‌نمایش JSON گزارش پاک‌سازی‌شده"
          className="text-[10px] font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800 text-slate-300 max-h-28 overflow-y-auto"
        >
          {finalExportableJson}
        </pre>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={editableLogs.length === 0}
            onClick={handleApproveAndSend}
            className="flex-1 py-2 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-xs cursor-pointer disabled:cursor-not-allowed transition-colors"
          >
            تایید محتوای بالا و ارسال گزارش فنی پاک‌سازی‌شده
          </button>
          {bundleDispatchedCount > 0 && (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-xs text-emerald-300 whitespace-nowrap"
            >
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>آماده/ارسال‌شده ({bundleDispatchedCount})</span>
            </span>
          )}
        </div>
      </section>
    </div>
  );
};
