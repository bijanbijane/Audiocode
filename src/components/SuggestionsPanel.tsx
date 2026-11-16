import React from 'react';
import { Check, X, Play, AlertTriangle, Scissors, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { SmartRecommendation } from '../contracts/v1_2';
import { flicksToSeconds } from '../engine/timebase';

interface SuggestionsPanelProps {
  recommendations: SmartRecommendation[];
  selectedRecId: string | null;
  previewingId: string | null;
  onSelect: (id: string) => void;
  onPreview: (rec: SmartRecommendation, mode: 'before' | 'after') => void;
  onAccept: (rec: SmartRecommendation) => void;
  onReject: (id: string) => void;
  onNudgeBoundary: (id: string, deltaMs: number) => void;
}

const KIND_LABELS: Record<SmartRecommendation['kind'], string> = {
  'co-articulated-filler': 'تپق کشیده متصل به کلمه',
  'standalone-filler': 'تپق مستقل',
  'long-pause': 'مکث طولانی',
  repetition: 'هشدار تدوین متنی',
  'crosstalk-bleed': 'نشت صدا (Mic Bleed)',
};

export const SuggestionsPanel: React.FC<SuggestionsPanelProps> = ({
  recommendations,
  selectedRecId,
  previewingId,
  onSelect,
  onPreview,
  onAccept,
  onReject,
  onNudgeBoundary,
}) => {
  const pendingCount = recommendations.filter((r) => r.status === 'Pending').length;

  return (
    <section
      aria-label="پیشنهادهای تدوین هوشمند"
      className="border border-[#252F42] bg-[#131924] rounded-lg flex flex-col"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#252F42]">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">پیشنهادهای هوشمند تدوین</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            تراز آکوستیکی فارسی · اعمال تنها با تأیید صریح کاربر
          </p>
        </div>
        <span className="text-xs font-mono text-amber-400">
          {pendingCount} در انتظار بررسی
        </span>
      </div>

      <div className="divide-y divide-[#252F42] max-h-[460px] overflow-y-auto">
        {recommendations.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">
            پیشنهاد فعالی برای این فایل یافت نشد.
          </div>
        ) : (
          recommendations.map((rec) => {
            const isSelected = rec.id === selectedRecId;
            const startSec = flicksToSeconds(rec.boundary.snappedRange.startFlicks);
            const endSec = flicksToSeconds(rec.boundary.snappedRange.endFlicks);
            const isPending = rec.status === 'Pending';

            return (
              <div
                key={rec.id}
                onClick={() => onSelect(rec.id)}
                className={`p-4 transition-colors ${
                  isSelected ? 'bg-[#182132]' : 'hover:bg-[#161D2B]'
                }`}
              >
                {/* Header Metadata (Zero-pill clean inline typography) */}
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-100">
                    {KIND_LABELS[rec.kind]}
                  </span>
                  <span className="font-mono text-slate-400">
                    {startSec.toFixed(2)}s – {endSec.toFixed(2)}s · {Math.round(rec.confidence * 100)}٪
                  </span>
                </div>

                <p className="text-xs text-slate-200 mt-1.5 font-medium">
                  {rec.relatedText}
                </p>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  {rec.reasonFa}
                </p>

                {/* Sync Protection & Acoustic Boundary Detail */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    {rec.recommendedMode === 'in-place-room-tone-suppression' ? (
                      <>
                        <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>حفظ سینک: جایگزینی درجا با Room Tone</span>
                      </>
                    ) : (
                      <>
                        <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>برش هم‌زمان قفل‌شده (Ripple Cut)</span>
                      </>
                    )}
                  </span>
                  <span className="text-slate-600">·</span>
                  <span className="font-mono">
                    Zero-Cross: {rec.boundary.zeroCrossingAdjusted ? 'بله' : 'دقیق'} · Crossfade: {rec.boundary.microCrossfadeMs}ms
                  </span>
                </div>

                {rec.boundary.trailingEzafeRisk && (
                  <div className="mt-2 flex items-start gap-2 p-2 rounded bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-200">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      هشدار دنباله کسره اضافه: حذف این واژه ممکن است «{rec.boundary.trailingEzafeWord}ِ» را ناقص باقی بگذارد. حتماً پیش‌شنوایی را بررسی کنید.
                    </span>
                  </div>
                )}

                {rec.syncProtectedReason && (
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    {rec.syncProtectedReason}
                  </p>
                )}

                {/* Actions */}
                {isPending ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPreview(rec, 'before');
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-[#252F42] bg-[#0E131D] text-slate-200 hover:bg-[#1E2738] whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Play className="w-3 h-3" aria-hidden="true" />
                        <span>{previewingId === `${rec.id}-before` ? 'در حال پخش...' : 'شنیدن قبل'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPreview(rec, 'after');
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Play className="w-3 h-3" aria-hidden="true" />
                        <span>{previewingId === `${rec.id}-after` ? 'در حال پخش...' : 'پیش‌شنوایی برش'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNudgeBoundary(rec.id, -40);
                        }}
                        title="اصلاح مرز شروع (-40ms)"
                        aria-label={`اصلاح مرز ${rec.relatedText}`}
                        className="inline-flex items-center gap-1 px-2 py-1.5 text-xs rounded border border-[#252F42] text-slate-400 hover:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3 h-3" aria-hidden="true" />
                        <span dir="ltr" className="font-mono">-40ms</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAccept(rec);
                        }}
                        aria-label={`اعمال پیشنهاد ${rec.relatedText}`}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-500 text-slate-950 hover:bg-emerald-400 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>اعمال</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onReject(rec.id);
                        }}
                        aria-label={`رد پیشنهاد ${rec.relatedText}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-[#252F42] text-slate-300 hover:bg-rose-500/15 hover:text-rose-200 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>رد</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2.5 text-xs font-medium">
                    {rec.status === 'Accepted' ? (
                      <span className="text-emerald-400">اعمال شد (قابل بازگشت با Undo)</span>
                    ) : (
                      <span className="text-slate-500">رد شد</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
