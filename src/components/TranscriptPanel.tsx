import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { PersianWordToken } from '../contracts/v1_2';
import { flicksToSeconds, secondsToFlicks } from '../engine/timebase';

type TranscriptLayer = 'display' | 'normalized' | 'original';

interface TranscriptPanelProps {
  tokens: PersianWordToken[];
  playheadSec: number;
  onSeekSec: (sec: number) => void;
}

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  tokens,
  playheadSec,
  onSeekSec,
}) => {
  const [layer, setLayer] = useState<TranscriptLayer>('display');
  const playheadFlicks = secondsToFlicks(playheadSec);

  const layerLabels: { id: TranscriptLayer; label: string }[] = [
    { id: 'display', label: 'متن نمایشی' },
    { id: 'normalized', label: 'نرمال‌شده' },
    { id: 'original', label: 'خام ASR' },
  ];

  return (
    <section
      aria-label="متن همگام‌شده فارسی"
      className="border border-[#252F42] bg-[#131924] rounded-lg flex flex-col"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[#252F42]">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">متن و تراز آوایی فارسی</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            تفکیک سه لایه متن (اصل، نرمال‌شده با نیم‌فاصله، و نمایشی) متصل به Timebase بدون رانش
          </p>
        </div>

        <div
          role="group"
          aria-label="لایه متن فارسی"
          className="flex items-center gap-1 p-1 bg-[#0E131D] border border-[#252F42] rounded-md"
        >
          {layerLabels.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setLayer(item.id)}
              aria-pressed={layer === item.id}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                layer === item.id
                  ? 'bg-amber-400 text-slate-950'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 min-h-[210px] max-h-[340px] overflow-y-auto">
        {tokens.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400 space-y-2">
            <p className="text-slate-200 font-medium">
              فایل صوتی واردشده در حال حاضر در سطح گروه A (پردازش فوری DSP) تحلیل شده است.
            </p>
            <p>
              تشخیص مکث‌های طولانی و کشیدگی واکه بلافاصله فعال است؛ پیاده‌سازی متن کامل با دانلود بلوکی مدل فارسی (گروه B) تکمیل می‌شود.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-3 leading-8">
            {tokens.map((tok) => {
              const isActive =
                playheadFlicks >= tok.range.startFlicks && playheadFlicks < tok.range.endFlicks;
              const textValue =
                layer === 'original'
                  ? tok.originalText
                  : layer === 'normalized'
                    ? tok.normalizedText
                    : tok.displayText;

              const startSec = flicksToSeconds(tok.range.startFlicks);

              return (
                <button
                  key={tok.id}
                  type="button"
                  onClick={() => onSeekSec(startSec)}
                  title={`${tok.speakerName} · ${startSec.toFixed(2)}s · اطمینان ${(tok.confidence * 100).toFixed(0)}٪ · منبع: ${tok.alignmentSource}`}
                  className={`group inline-flex items-center gap-1 px-2 py-0.5 rounded text-sm transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/60'
                      : tok.isDisfluency
                        ? 'bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
                        : tok.hasTrailingEzafeRisk
                          ? 'bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                          : 'text-slate-200 hover:bg-[#1E2738]'
                  }`}
                >
                  <span className="text-[11px] text-slate-500 font-normal">
                    {tok.speakerName === 'آرش' ? 'آرش:' : ''}
                  </span>
                  <span className={tok.isDisfluency ? 'line-through decoration-rose-400/70' : ''}>
                    {textValue}
                  </span>
                  {tok.hasTrailingEzafeRisk && (
                    <AlertTriangle
                      className="w-3 h-3 text-amber-400 shrink-0"
                      aria-label="خطر کسره اضافه معلق"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-[#252F42] bg-[#101520] flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>کلیک روی هر کلمه مکان‌نما را با دقت Flick به همان نقطه منتقل می‌کند</span>
        <span className="font-mono">
          واژگان همگام‌شده: {tokens.length}
        </span>
      </div>
    </section>
  );
};
