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
      className="grid grid-cols-1 lg:grid-cols-2 gap-4 bg-[var(--avp-bg)] text-[var(--avp-text)] p-4 rounded-xl border border-[var(--avp-border)]"
    >
      {/* Column 1: AI Analysis Provenance Registry (Sections 36 & 50) */}
      <section
        aria-label="شناسنامه منشأ تحلیل‌های هوشمند"
        className="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-sm text-[var(--avp-accent-text)]">
              شناسنامه منشأ تحلیل‌های هوشمند (AI Provenance Registry)
            </h3>
            <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
              ردیابی دقیق نسخه مدل، محیط اجرا و اعتبار نتایج روی نسخه فعلی پروژه
            </p>
          </div>
          <span className="text-[11px] font-mono tabular-nums text-[var(--avp-text-muted)] whitespace-nowrap shrink-0">
            {provenanceItems.length} تحلیل ثبت‌شده
          </span>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {provenanceItems.length === 0 ? (
            <p className="text-xs text-[var(--avp-text-muted)] py-4 text-center">
              هنوز تحلیلی برای نمایش در رجیستری منشأ ثبت نشده است.
            </p>
          ) : (
            provenanceItems.map((item) => (
              <div
                key={item.analysisId}
                className="p-3 rounded-lg bg-[var(--avp-surface-secondary)] border border-[var(--avp-border)] flex flex-col gap-1.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--avp-text)]">{item.taskTitleFa}</span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
                        item.validityStatus === 'VALID_CURRENT'
                          ? 'bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] border border-[var(--avp-accent)]/35'
                          : 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)] border border-[var(--avp-warning)]/35'
                      }`}
                    >
                      {item.validityStatus === 'VALID_CURRENT'
                        ? 'معتبر برای نسخه فعلی'
                        : 'نیازمند بازسنجی'}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
                        item.executedRuntime === 'EXTERNAL_API'
                          ? 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)] border border-[var(--avp-warning)]/35'
                          : 'bg-[var(--avp-success-soft)] text-[var(--avp-success-text)] border border-[var(--avp-success)]/35'
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

                <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--avp-text-secondary)] text-[11px]">
                  <span>
                    مدل: <span dir="ltr" className="font-mono text-[var(--avp-text)]">{item.modelId}</span> (v
                    {item.modelVersion})
                  </span>
                  <span>
                    هش رسانه:{' '}
                    <span dir="ltr" className="font-mono text-[var(--avp-text)]">
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
        className="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-sm text-[var(--avp-success-text)] flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>ممیزی حریم خصوصی گزارش فنی پیش از ارسال (بخش ۴۲)</span>
            </h3>
            <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
              مسیرهای فایل محلی و متون فارسی به‌طور خودکار با{' '}
              <span dir="ltr" className="font-mono text-[var(--avp-text)]">
                [REDACTED]
              </span>{' '}
              پاک‌سازی شده‌اند؛ پیش از ارسال می‌توانید هر ردیف را حذف کنید.
            </p>
          </div>
        </div>

        <div className="space-y-1.5 max-h-40 overflow-y-auto bg-[var(--avp-surface-secondary)] p-2 rounded-lg border border-[var(--avp-border)]">
          {editableLogs.length === 0 ? (
            <p className="text-xs text-[var(--avp-text-muted)] py-3 text-center">
              تمام ردیف‌های گزارش حذف شدند؛ داده‌ای برای ارسال وجود ندارد.
            </p>
          ) : (
            editableLogs.map((log) => (
              <div
                key={log.logId}
                className="flex items-center justify-between gap-2 text-xs bg-[var(--avp-surface)] px-2.5 py-1.5 rounded border border-[var(--avp-border-subtle)]"
              >
                <span className="font-mono text-[11px] text-[var(--avp-text)] truncate" dir="ltr">
                  [{log.category}] {log.sanitizedMessage}
                </span>
                <button
                  type="button"
                  aria-label={`حذف ردیف ${log.category} (${log.logId})`}
                  onClick={() => handleRemoveLogLine(log.logId)}
                  className="inline-flex items-center gap-1 text-[var(--avp-danger-text)] hover:opacity-90 text-[11px] shrink-0 px-2 py-0.5 bg-[var(--avp-danger-soft)] border border-[var(--avp-danger)]/35 rounded cursor-pointer"
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
          className="text-[11px] font-mono bg-[var(--avp-surface-secondary)] p-2.5 rounded-lg border border-[var(--avp-border)] text-[var(--avp-text-secondary)] max-h-28 overflow-y-auto"
        >
          {finalExportableJson}
        </pre>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={editableLogs.length === 0}
            onClick={handleApproveAndSend}
            className="avp-btn avp-btn-primary flex-1 py-2 px-4 text-xs"
          >
            تایید محتوای بالا و ارسال گزارش فنی پاک‌سازی‌شده
          </button>
          {bundleDispatchedCount > 0 && (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-xs text-[var(--avp-success-text)] whitespace-nowrap"
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
