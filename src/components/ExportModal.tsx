import React, { useEffect } from 'react';
import { X, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ExportValidationReport } from '../contracts/v1_2';
import { RenderManifest } from '../processing-core/ExportValidator';

interface ExportModalProps {
  isOpen: boolean;
  isRendering: boolean;
  progressPct: number;
  report: ExportValidationReport | null;
  manifest?: RenderManifest | null;
  validationErrors?: string[];
  downloadUrl: string | null;
  fileName: string;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  isRendering,
  progressPct,
  report,
  manifest,
  validationErrors = [],
  downloadUrl,
  fileName,
  onClose,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border border-[#252F42] bg-[#131924] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#252F42]">
          <h2 id="export-modal-title" className="text-sm font-semibold text-slate-100">
            رندر جریانی و اعتبارسنجی خروجی (Streaming Export)
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره خروجی"
            className="p-1 text-slate-400 hover:text-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {isRendering ? (
            <div className="space-y-3 py-4">
              <div className="flex justify-between text-xs text-slate-300">
                <span>در حال اجرای رندر جریانی با Pre-Roll و جبران تأخیر PDC...</span>
                <span className="font-mono text-amber-400">{progressPct}٪</span>
              </div>
              <div className="h-2 w-full bg-[#0E131D] rounded overflow-hidden border border-[#252F42]">
                <div
                  className="h-full bg-amber-400 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          ) : report ? (
            <>
              <div
                className={`flex items-center gap-2.5 p-3 rounded border text-xs ${
                  report.passed && validationErrors.length === 0
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                    : 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                }`}
              >
                {report.passed && validationErrors.length === 0 ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {report.passed && validationErrors.length === 0
                    ? 'اعتبارسنجی خروجی با موفقیت تایید شد (بدون Clipping و تراز استاندارد).'
                    : validationErrors[0] ?? 'فایل تولید شد اما در آستانه اوج صدا (True Peak) هشدار ثبت شد.'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42]">
                  <div className="text-slate-400 font-sans">مدت زمان خروجی</div>
                  <div dir="ltr" className="text-slate-100 mt-1 text-right">{report.durationSeconds} s</div>
                </div>
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42]">
                  <div className="text-slate-400 font-sans">نرخ نمونه / عمق بیت</div>
                  <div dir="ltr" className="text-slate-100 mt-1 text-right">
                    {report.sampleRate} Hz · {report.bitDepth}-bit
                  </div>
                </div>
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42]">
                  <div className="text-slate-400 font-sans">اوج واقعی (True Peak)</div>
                  <div dir="ltr" className="text-sky-400 mt-1 text-right">{report.truePeakDbfs} dBFS</div>
                </div>
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42]">
                  <div className="text-slate-400 font-sans">بلندی صدا (LUFS)</div>
                  <div dir="ltr" className="text-amber-400 mt-1 text-right">{report.integratedLufs} LUFS</div>
                </div>
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42]">
                  <div className="text-slate-400 font-sans">نمونه‌های Clipping</div>
                  <div dir="ltr" className="text-emerald-400 mt-1 text-right">{report.clippedSampleCount}</div>
                </div>
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42]">
                  <div className="text-slate-400 font-sans">حجم فایل WAV</div>
                  <div dir="ltr" className="text-slate-100 mt-1 text-right">
                    {(report.fileSizeBytes / 1024).toFixed(1)} KB
                  </div>
                </div>
              </div>

              {manifest && (
                <div className="p-3 rounded bg-[#0E131D] border border-[#252F42] text-[11px] font-mono text-slate-300 space-y-1">
                  <div className="font-sans text-xs font-semibold text-slate-200 mb-1">
                    گواهی رندر قطعی (RenderManifest · بخش ۳۴)
                  </div>
                  <div dir="ltr" className="flex justify-between">
                    <span className="text-slate-500">Cache Key:</span>
                    <span className="text-amber-400">{manifest.graphCacheKey}</span>
                  </div>
                  <div dir="ltr" className="flex justify-between">
                    <span className="text-slate-500">Schema / Engine:</span>
                    <span>
                      v{manifest.versions.projectSchemaVersion}.0 · {manifest.versions.audioEngineVersion}
                    </span>
                  </div>
                  <div dir="ltr" className="flex justify-between">
                    <span className="text-slate-500">Revision / Bundle:</span>
                    <span>
                      rev #{manifest.projectRevision} · {manifest.versions.activeModelBundleVersion}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
                >
                  بستن
                </button>
                {downloadUrl && report.readable && validationErrors.length === 0 && (
                  <a
                    href={downloadUrl}
                    download={fileName}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded bg-amber-400 text-slate-950 hover:bg-amber-300"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>دانلود فایل WAV</span>
                  </a>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
