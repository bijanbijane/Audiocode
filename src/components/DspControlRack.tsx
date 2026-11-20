import React from 'react';
import { Activity, History, RotateCcw, Sliders, Wand2 } from 'lucide-react';
import { EditTransaction, EphemeralDspParams } from '../contracts/v1_2';
import { StudioAcousticAdvisorSummary } from '../engine/persianAsrTranscriber';
import { StereoPhaseDiagnostic } from '../../packages/audio-runtime/src/ChannelAndPhaseAlignmentEngine';
import { DspFrequencyResponseGraph } from './DspFrequencyResponseGraph';

interface DspControlRackProps {
  ephemeralParams: EphemeralDspParams;
  committedParams: EphemeralDspParams;
  isGestureActive: boolean;
  sampleRate?: number;
  history: EditTransaction[];
  acousticAdvisor?: StudioAcousticAdvisorSummary | null;
  eqResponseCurveDb?: { freqHz: number; gainDb: number }[] | null;
  phaseDiagnostic?: StereoPhaseDiagnostic | null;
  onEphemeralChange: (next: EphemeralDspParams) => void;
  onCommitGesture: (coalescingKey: string, labelFa: string) => void;
  onResetDefaults: () => void;
  onApplyAcousticAdvisorPreset?: () => void;
  onApply8BandPersianVoiceEq?: () => void;
}

export const DspControlRack: React.FC<DspControlRackProps> = ({
  ephemeralParams,
  committedParams,
  isGestureActive,
  sampleRate = 48000,
  history,
  acousticAdvisor,
  eqResponseCurveDb,
  phaseDiagnostic,
  onEphemeralChange,
  onCommitGesture,
  onResetDefaults,
  onApplyAcousticAdvisorPreset,
  onApply8BandPersianVoiceEq,
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
    <div dir="rtl" className="space-y-4">
      <section
        aria-label="پردازشگر صوتی و کنترل گذرا"
        className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg shadow-xs dark:shadow-none"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-[#252F42]">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">زنجیره DSP با Pre-Roll و ادغام تراکنش</h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              {isGestureActive || hasUncommittedDiff
                ? 'وضعیت گذرا (Ephemeral RAM) — ثبت تراکنش نهایی پس از رها کردن'
                : 'تغییرات با رها کردن اسلایدر به صورت یک تراکنش واحد ثبت می‌شوند'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {onApply8BandPersianVoiceEq && (
              <button
                type="button"
                data-testid="btn-apply-8band-persian-eq"
                onClick={onApply8BandPersianVoiceEq}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded border border-emerald-500/40 bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-500/20 dark:hover:bg-emerald-500/25 cursor-pointer"
              >
                <Sliders className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span>اکوالایزر ۸ بانده صدای فارسی</span>
              </button>
            )}
            {onApplyAcousticAdvisorPreset && (
              <button
                type="button"
                data-testid="btn-apply-acoustic-advisor-dsp"
                onClick={onApplyAcousticAdvisorPreset}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
              >
                <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>کالیبراسیون خودکار DSP</span>
              </button>
            )}
            <button
              type="button"
              onClick={onResetDefaults}
              aria-label="بازنشانی تنظیمات DSP"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              <span>پیش‌فرض</span>
            </button>
          </div>
        </div>

        {acousticAdvisor && (
          <div
            data-testid="acoustic-advisor-bar"
            className="px-4 py-2 border-b border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D]/90 flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <div className="flex items-center gap-1.5 text-sky-700 dark:text-sky-300 font-medium">
              <Activity className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
              <span>مشاور آکوستیک (Goertzel 50Hz / Plosive / Sibilance):</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700 dark:text-slate-300">
              <span dir="ltr" className="font-mono tabular-nums">SNR: {acousticAdvisor.report.signalToNoiseRatioDb} dB</span>
              <span dir="ltr" className="font-mono tabular-nums">
                50Hz Hum: {acousticAdvisor.report.humFundamentalAndHarmonicsDb.hz50} dB
              </span>
              <span className="inline-flex items-center gap-1">
                <span>پاپ پ/ب/ت:</span>
                <bdi dir="ltr" className="font-mono tabular-nums">{acousticAdvisor.report.plosivePopEvents.length}</bdi>
              </span>
              <span className="inline-flex items-center gap-1">
                <span>صفیر س/ش/ز:</span>
                <bdi dir="ltr" className="font-mono tabular-nums">{acousticAdvisor.report.harshSibilanceEvents.length}</bdi>
              </span>
            </div>
          </div>
        )}

        {phaseDiagnostic && (
          <div
            data-testid="phase-compatibility-bar"
            className="px-4 py-2 border-b border-slate-200 dark:border-[#252F42] bg-slate-50/70 dark:bg-[#0E131D]/70 flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span className="text-amber-700 dark:text-amber-300 font-medium">
              هم‌فازی چندترک و سازگاری مونو (Mono Fold-Down):
            </span>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700 dark:text-slate-300">
              <span dir="ltr" className="font-mono tabular-nums">Phase r: {phaseDiagnostic.zeroLagPhaseCorrelation}</span>
              <span dir="ltr" className="font-mono tabular-nums">Mono Loss: {phaseDiagnostic.monoFoldDownLossDb} dB</span>
              <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                {phaseDiagnostic.isPolarityInverted ? 'معکوس فاز (180°)' : 'فاز هم‌سو'}
              </span>
            </div>
          </div>
        )}

        {eqResponseCurveDb && eqResponseCurveDb.length > 0 && (
          <div
            data-testid="eq-8band-response-bar"
            className="px-4 py-2 border-b border-slate-200 dark:border-[#252F42] bg-emerald-50/60 dark:bg-emerald-950/20 flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span className="text-emerald-800 dark:text-emerald-300 font-semibold">
              منحنی پاسخ فرکانسی ۸ بانده کلام فارسی (Z-Plane Biquad):
            </span>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              {eqResponseCurveDb.map((pt) => (
                <span
                  key={pt.freqHz}
                  dir="ltr"
                  className="px-1.5 py-0.5 rounded bg-white dark:bg-[#0E131D] border border-emerald-500/30 text-emerald-800 dark:text-emerald-200"
                >
                  {pt.freqHz >= 1000 ? `${(pt.freqHz / 1000).toFixed(1)}k` : `${pt.freqHz}Hz`}:{' '}
                  {pt.gainDb > 0 ? `+${pt.gainDb}` : pt.gainDb}dB
                </span>
              ))}
            </div>
          </div>
        )}

        <DspFrequencyResponseGraph
          ephemeralParams={ephemeralParams}
          committedParams={committedParams}
          sampleRate={sampleRate}
          isGestureActive={isGestureActive}
          eqResponseCurveDb={eqResponseCurveDb}
        />

        <div className="p-4 space-y-3.5">
          {sliders.map((s) => {
            const val = ephemeralParams[s.key];
            return (
              <div key={s.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor={`dsp-${s.key}`} className="text-slate-800 dark:text-slate-200 font-medium">
                    {s.label}
                  </label>
                  <span dir="ltr" className="font-mono tabular-nums text-amber-700 dark:text-amber-400">
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
                  onPointerCancel={() => onCommitGesture(`dsp-${s.key}`, `تنظیم ${s.label}: ${val} ${s.unit}`)}
                  onBlur={() => onCommitGesture(`dsp-${s.key}`, `تنظیم ${s.label}: ${val} ${s.unit}`)}
                  onKeyUp={() => onCommitGesture(`dsp-${s.key}`, `تنظیم ${s.label}: ${val} ${s.unit}`)}
                  className="w-full accent-amber-500 dark:accent-amber-400 cursor-pointer"
                />
              </div>
            );
          })}
        </div>
      </section>

      <section
        aria-label="تاریخچه تراکنش‌های تدوین"
        className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg shadow-xs dark:shadow-none"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-[#252F42]">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">تاریخچه تراکنش‌ها (Undo/Redo)</h2>
          </div>
          <span className="text-xs text-slate-600 dark:text-slate-400 inline-flex items-center gap-1">
            <bdi dir="ltr" className="font-mono tabular-nums">{history.length}</bdi>
            <span>تراکنش</span>
          </span>
        </div>

        <div className="max-h-[180px] overflow-y-auto divide-y divide-slate-200 dark:divide-[#1E2738]">
          {history.length === 0 ? (
            <div className="p-4 text-xs text-slate-500 dark:text-slate-400 text-center">
              هنوز تراکنشی ثبت نشده است. با اعمال یک پیشنهاد یا تغییر DSP، تاریخچه اینجا ثبت می‌شود.
            </div>
          ) : (
            history.map((tx) => (
              <div key={tx.operationId} className="px-4 py-2.5 flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-800 dark:text-slate-200 truncate">{tx.description}</span>
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
