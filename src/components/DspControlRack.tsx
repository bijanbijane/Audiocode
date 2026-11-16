import React from 'react';
import { History, RotateCcw } from 'lucide-react';
import { EditTransaction, EphemeralDspParams } from '../contracts/v1_2';

interface DspControlRackProps {
  ephemeralParams: EphemeralDspParams;
  committedParams: EphemeralDspParams;
  isGestureActive: boolean;
  history: EditTransaction[];
  onEphemeralChange: (next: EphemeralDspParams) => void;
  onCommitGesture: (coalescingKey: string, labelFa: string) => void;
  onResetDefaults: () => void;
}

export const DspControlRack: React.FC<DspControlRackProps> = ({
  ephemeralParams,
  committedParams,
  isGestureActive,
  history,
  onEphemeralChange,
  onCommitGesture,
  onResetDefaults,
}) => {
  const sliders: Array<{
    key: keyof EphemeralDspParams;
    label: string;
    min: number;
    max: number;
    step: number;
    unit: string;
  }> = [
    { key: 'highPassHz', label: 'فیلتر بالاگذر (HPF)', min: 20, max: 220, step: 5, unit: 'Hz' },
    { key: 'compressorThresholdDb', label: 'آستانه کمپرسور', min: -36, max: 0, step: 1, unit: 'dB' },
    { key: 'compressorRatio', label: 'نسبت فشرده‌سازی', min: 1, max: 8, step: 0.5, unit: ':1' },
    { key: 'noiseGateThresholdDb', label: 'آستانه Noise Gate', min: -70, max: -20, step: 1, unit: 'dB' },
    { key: 'masterGainDb', label: 'گین خروجی (Master)', min: -12, max: 12, step: 0.5, unit: 'dB' },
  ];

  const hasUncommittedDiff =
    JSON.stringify(ephemeralParams) !== JSON.stringify(committedParams);

  return (
    <div className="space-y-4">
      <section
        aria-label="پردازشگر صوتی و کنترل گذرا"
        className="border border-[#252F42] bg-[#131924] rounded-lg"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#252F42]">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">زنجیره DSP با Pre-Roll و ادغام تراکنش</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isGestureActive || hasUncommittedDiff
                ? 'وضعیت گذرا (Ephemeral RAM) — ثبت تراکنش نهایی پس از رها کردن'
                : 'تغییرات با رها کردن اسلایدر به صورت یک تراکنش واحد ثبت می‌شوند'}
            </p>
          </div>
          <button
            type="button"
            onClick={onResetDefaults}
            aria-label="بازنشانی تنظیمات DSP"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
            <span>پیش‌فرض</span>
          </button>
        </div>

        <div className="p-4 space-y-3.5">
          {sliders.map((s) => {
            const val = ephemeralParams[s.key];
            return (
              <div key={s.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor={`dsp-${s.key}`} className="text-slate-200 font-medium">
                    {s.label}
                  </label>
                  <span dir="ltr" className="font-mono text-amber-400">
                    {val} {s.unit}
                  </span>
                </div>
                <input
                  id={`dsp-${s.key}`}
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={val}
                  onChange={(e) =>
                    onEphemeralChange({
                      ...ephemeralParams,
                      [s.key]: Number(e.target.value),
                    })
                  }
                  onPointerUp={() => onCommitGesture(`dsp-${s.key}`, `تنظیم ${s.label}: ${val} ${s.unit}`)}
                  onKeyUp={() => onCommitGesture(`dsp-${s.key}`, `تنظیم ${s.label}: ${val} ${s.unit}`)}
                  className="w-full accent-amber-400 cursor-pointer"
                />
              </div>
            );
          })}
        </div>
      </section>

      <section
        aria-label="تاریخچه تراکنش‌های تدوین"
        className="border border-[#252F42] bg-[#131924] rounded-lg"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#252F42]">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-100">تاریخچه تراکنش‌ها (Undo/Redo)</h2>
          </div>
          <span className="text-xs font-mono text-slate-400">{history.length} تراکنش</span>
        </div>

        <div className="max-h-[180px] overflow-y-auto divide-y divide-[#1E2738]">
          {history.length === 0 ? (
            <div className="p-4 text-xs text-slate-400 text-center">
              هنوز تراکنشی ثبت نشده است. با اعمال یک پیشنهاد یا تغییر DSP، تاریخچه اینجا ثبت می‌شود.
            </div>
          ) : (
            history.map((tx) => (
              <div key={tx.operationId} className="px-4 py-2.5 flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-200 truncate">{tx.description}</span>
                <span className="font-mono text-[11px] text-slate-500 shrink-0">
                  v{tx.projectVersion}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};
