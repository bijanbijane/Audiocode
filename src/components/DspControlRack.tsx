import React from 'react';
import { Activity, RotateCcw, Sliders, Wand2 } from 'lucide-react';
import { EditTransaction, EphemeralDspParams } from '../contracts/v1_2';
import { StudioAcousticAdvisorSummary } from '../engine/persianAsrTranscriber';
import { StereoPhaseDiagnostic } from '../../packages/audio-runtime/src/ChannelAndPhaseAlignmentEngine';
import { DspFrequencyResponseGraph } from './DspFrequencyResponseGraph';
import { formatNumberForLocale } from '../utils/formatters';

interface DspControlRackProps {
  ephemeralParams: EphemeralDspParams;
  committedParams: EphemeralDspParams;
  isGestureActive: boolean;
  sampleRate?: number;
  locale?: 'fa' | 'en';
  persianDigits?: boolean;
  history?: EditTransaction[];
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
  locale = 'fa',
  persianDigits = false,
  acousticAdvisor,
  eqResponseCurveDb,
  phaseDiagnostic,
  onEphemeralChange,
  onCommitGesture,
  onResetDefaults,
  onApplyAcousticAdvisorPreset,
  onApply8BandPersianVoiceEq,
}) => {
  const isFa = locale === 'fa';

  const sliders: Array<{
    key: keyof EphemeralDspParams;
    label: string;
    min: number;
    max: number;
    step: number;
    unit: string;
  }> = [
    {
      key: 'highPassHz',
      label: isFa ? 'فیلتر بالاگذر (HPF)' : 'High-Pass Filter (HPF)',
      min: 20,
      max: 220,
      step: 5,
      unit: 'Hz',
    },
    {
      key: 'compressorThresholdDb',
      label: isFa ? 'آستانه کمپرسور' : 'Compressor Threshold',
      min: -36,
      max: 0,
      step: 1,
      unit: 'dB',
    },
    {
      key: 'compressorRatio',
      label: isFa ? 'نسبت فشرده‌سازی' : 'Compressor Ratio',
      min: 1,
      max: 8,
      step: 0.5,
      unit: ':1',
    },
    {
      key: 'noiseGateThresholdDb',
      label: isFa ? 'آستانه Noise Gate' : 'Noise Gate Threshold',
      min: -70,
      max: -20,
      step: 1,
      unit: 'dB',
    },
    {
      key: 'masterGainDb',
      label: isFa ? 'گین خروجی (Master)' : 'Master Output Gain',
      min: -12,
      max: 12,
      step: 0.5,
      unit: 'dB',
    },
  ];

  const hasUncommittedDiff =
    JSON.stringify(ephemeralParams) !== JSON.stringify(committedParams);

  return (
    <div dir={isFa ? 'rtl' : 'ltr'} className="space-y-3">
      <section
        aria-label={isFa ? 'پردازشگر صوتی و کنترل گذرا' : 'Audio DSP Chain & Controls'}
        className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
          <div>
            <h2 className="text-xs font-bold text-[var(--avp-text)]">
              {isFa ? 'زنجیره پردازش DSP و Pre-Roll' : 'Live DSP Processing Chain'}
            </h2>
            <p className="text-[11px] text-[var(--avp-text-secondary)] mt-0.5">
              {isGestureActive || hasUncommittedDiff
                ? isFa
                  ? 'وضعیت گذرا (RAM) — ثبت تراکنش پس از رها کردن'
                  : 'Previewing in RAM — commits to history on release'
                : isFa
                  ? 'تغییرات با رها کردن اسلایدر در تاریخچه ثبت می‌شوند'
                  : 'Slider changes coalesce into a single undoable step'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {onApply8BandPersianVoiceEq && (
              <button
                type="button"
                data-testid="btn-apply-8band-persian-eq"
                onClick={onApply8BandPersianVoiceEq}
                className="avp-btn avp-btn-sm avp-btn-tonal min-h-[44px] lg:min-h-[28px]"
              >
                <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isFa ? 'اکوالایزر ۸ بانده کلام' : '8-Band Voice EQ'}</span>
              </button>
            )}
            {onApplyAcousticAdvisorPreset && (
              <button
                type="button"
                data-testid="btn-apply-acoustic-advisor-dsp"
                onClick={onApplyAcousticAdvisorPreset}
                className="avp-btn avp-btn-sm avp-btn-secondary min-h-[44px] lg:min-h-[28px]"
              >
                <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isFa ? 'کالیبراسیون خودکار' : 'Auto Calibrate'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onResetDefaults}
              aria-label={isFa ? 'بازنشانی تنظیمات DSP' : 'Reset DSP parameters'}
              className="avp-btn avp-btn-sm avp-btn-outline min-h-[44px] lg:min-h-[28px]"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              <span>{isFa ? 'پیش‌فرض' : 'Reset'}</span>
            </button>
          </div>
        </div>

        {acousticAdvisor && (
          <div
            data-testid="acoustic-advisor-bar"
            className="px-3.5 py-2 border-b border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <div className="flex items-center gap-1.5 text-[var(--avp-accent-text)] font-medium">
              <Activity className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {isFa ? 'مشاور آکوستیک (50Hz / پاپ / صفیر):' : 'Acoustic Advisor:'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--avp-text-secondary)]">
              <span dir="ltr" className="font-mono tabular-nums">
                SNR: {formatNumberForLocale(acousticAdvisor.report.signalToNoiseRatioDb, { persianDigits })} dB
              </span>
              <span dir="ltr" className="font-mono tabular-nums">
                50Hz Hum: {formatNumberForLocale(acousticAdvisor.report.humFundamentalAndHarmonicsDb.hz50, { persianDigits })} dB
              </span>
              <span className="inline-flex items-center gap-1">
                <span>{isFa ? 'پاپ پ/ب/ت:' : 'Plosives:'}</span>
                <bdi dir="ltr" className="font-mono tabular-nums">
                  {formatNumberForLocale(acousticAdvisor.report.plosivePopEvents.length, { persianDigits })}
                </bdi>
              </span>
              <span className="inline-flex items-center gap-1">
                <span>{isFa ? 'صفیر س/ش/ز:' : 'Sibilance:'}</span>
                <bdi dir="ltr" className="font-mono tabular-nums">
                  {formatNumberForLocale(acousticAdvisor.report.harshSibilanceEvents.length, { persianDigits })}
                </bdi>
              </span>
            </div>
          </div>
        )}

        {phaseDiagnostic && (
          <div
            data-testid="phase-compatibility-bar"
            className="px-3.5 py-2 border-b border-[var(--avp-border)] bg-[var(--avp-warning-soft)]/50 flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span className="text-[var(--avp-warning-text)] font-medium">
              {isFa ? 'هم‌فازی چندترک و سازگاری مونو:' : 'Multi-track Phase & Mono Compatibility:'}
            </span>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--avp-text-secondary)]">
              <span dir="ltr" className="font-mono tabular-nums">
                Phase r: {formatNumberForLocale(phaseDiagnostic.zeroLagPhaseCorrelation, { persianDigits })}
              </span>
              <span dir="ltr" className="font-mono tabular-nums">
                Mono Loss: {formatNumberForLocale(phaseDiagnostic.monoFoldDownLossDb, { persianDigits })} dB
              </span>
              <span className="text-[var(--avp-success-text)] font-medium">
                {phaseDiagnostic.isPolarityInverted
                  ? isFa
                    ? 'معکوس فاز (180°)'
                    : 'Inverted (180°)'
                  : isFa
                    ? 'فاز هم‌سو'
                    : 'Phase Aligned'}
              </span>
            </div>
          </div>
        )}

        {eqResponseCurveDb && eqResponseCurveDb.length > 0 && (
          <div
            data-testid="eq-8band-response-bar"
            className="px-3.5 py-2 border-b border-[var(--avp-border)] bg-[var(--avp-success-soft)]/60 flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span className="text-[var(--avp-success-text)] font-semibold">
              {isFa ? 'منحنی پاسخ فرکانسی ۸ بانده:' : '8-Band Voice EQ Curve:'}
            </span>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
              {eqResponseCurveDb.map((pt) => (
                <span
                  key={pt.freqHz}
                  dir="ltr"
                  className="px-1.5 py-0.5 rounded bg-[var(--avp-surface)] border border-[var(--avp-border)] text-[var(--avp-text)]"
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
          locale={locale}
        />

        <div className="p-3.5 space-y-3">
          {sliders.map((s) => {
            const val = ephemeralParams[s.key];
            return (
              <div key={s.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor={`dsp-${s.key}`} className="text-[var(--avp-text)] font-medium">
                    {s.label}
                  </label>
                  <span dir="ltr" className="font-mono tabular-nums text-[var(--avp-accent-text)] font-semibold">
                    {formatNumberForLocale(val, { persianDigits })} {s.unit}
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
                  onPointerUp={() => onCommitGesture(`dsp-${s.key}`, `${s.label}: ${val} ${s.unit}`)}
                  onPointerCancel={() => onCommitGesture(`dsp-${s.key}`, `${s.label}: ${val} ${s.unit}`)}
                  onBlur={() => onCommitGesture(`dsp-${s.key}`, `${s.label}: ${val} ${s.unit}`)}
                  onKeyUp={() => onCommitGesture(`dsp-${s.key}`, `${s.label}: ${val} ${s.unit}`)}
                  className="w-full min-h-[44px] lg:min-h-[24px] accent-[var(--avp-accent)] cursor-pointer"
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
