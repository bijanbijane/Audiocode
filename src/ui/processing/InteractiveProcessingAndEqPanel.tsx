import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PERSIAN_VOICE_8BAND_EQ,
  EqBandConfig,
  Parametric8BandBiquadEq,
} from '../../../packages/audio-runtime/src/Parametric8BandBiquadEq';
import { SampleRate } from '../../contracts/timebase.contract';

interface ProcessingPanelProps {
  sampleRate: SampleRate;
  initialBands?: EqBandConfig[];
  onBeginEqGesture: (gestureKey: string) => void;
  onUpdateEqGesture: (updatedBands: EqBandConfig[]) => void;
  onCommitEqGesture: (finalBands: EqBandConfig[], description: string) => void;
}

export const InteractiveProcessingAndEqPanel: React.FC<ProcessingPanelProps> = ({
  sampleRate,
  initialBands = DEFAULT_PERSIAN_VOICE_8BAND_EQ,
  onBeginEqGesture,
  onUpdateEqGesture,
  onCommitEqGesture,
}) => {
  const [bands, setBands] = useState<EqBandConfig[]>(initialBands);
  const [selectedBandId, setSelectedBandId] = useState<string>(initialBands[2].bandId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const eqAnalyzer = useMemo(
    () => new Parametric8BandBiquadEq(sampleRate, bands),
    [sampleRate, bands],
  );

  // رندر لحظه‌ای منحنی پاسخ فرکانسی لگاریتمی از 20Hz تا 20kHz روی Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // رسم خط مرجع 0 dB
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // تولید ۲۰۰ نقطه فرکانس لگاریتمی از 20Hz تا 20000Hz
    const numPoints = 200;
    const freqs = new Float32Array(numPoints);
    const minLog = Math.log10(20);
    const maxLog = Math.log10(20000);
    for (let i = 0; i < numPoints; i++) {
      freqs[i] = Math.pow(10, minLog + (i / (numPoints - 1)) * (maxLog - minLog));
    }

    const dbValues = eqAnalyzer.computeFrequencyResponseDb(freqs);
    const maxDbDisplay = 15.0; // بازه ±15 dB

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const x = (i / (numPoints - 1)) * W;
      const clampedDb = Math.max(-maxDbDisplay, Math.min(maxDbDisplay, dbValues[i]));
      const y = H / 2 - (clampedDb / maxDbDisplay) * (H * 0.45);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // رسم نقاط کنترل ۸ باند روی منحنی
    for (const band of bands) {
      const logX =
        (Math.log10(Math.max(20, band.frequencyHz)) - minLog) / (maxLog - minLog);
      const px = logX * W;
      const py = H / 2 - (band.gainDb / maxDbDisplay) * (H * 0.45);

      ctx.fillStyle = band.enabled
        ? band.bandId === selectedBandId
          ? '#f43f5e'
          : '#38bdf8'
        : '#64748b';
      ctx.beginPath();
      ctx.arc(px, py, band.bandId === selectedBandId ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [bands, eqAnalyzer, selectedBandId]);

  const activeBand = bands.find((b) => b.bandId === selectedBandId) ?? bands[0];

  const handleSliderChange = (
    field: 'frequencyHz' | 'gainDb' | 'qFactor',
    val: number,
  ) => {
    const nextBands = bands.map((b) =>
      b.bandId === activeBand.bandId ? { ...b, [field]: val } : b,
    );
    setBands(nextBands);
    onUpdateEqGesture(nextBands);
  };

  return (
    <div
      dir="rtl"
      className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col gap-3 text-slate-100"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-sky-400">
          اکوالایزر پارامتریک ۸ بانده (دقت داخلی ۶۴ بیتی)
        </h3>
        <span className="text-[11px] text-slate-400">
          تغییرات حین کشیدن در حالت پیش‌نمایش گذرا (Ephemeral) اجرا می‌شوند
        </span>
      </div>

      <canvas
        ref={canvasRef}
        width={760}
        height={160}
        className="w-full h-40 bg-slate-900 rounded-lg border border-slate-800"
      />

      {/* دکمه‌های انتخاب ۸ باند */}
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-1.5 text-xs">
        {bands.map((b, idx) => (
          <button
            key={b.bandId}
            type="button"
            onClick={() => setSelectedBandId(b.bandId)}
            className={`py-1.5 px-2 rounded border text-center ${
              b.bandId === selectedBandId
                ? 'bg-sky-900/60 border-sky-400 text-sky-200 font-semibold'
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            باند {idx + 1} ({Math.round(b.frequencyHz)}Hz)
          </button>
        ))}
      </div>

      {/* کنترلرهای باند انتخاب‌شده با تفکیک دقیق PointerDown / Change / PointerUp */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-slate-900 p-3 rounded-lg border border-slate-800 text-xs">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={activeBand.enabled}
            onChange={(e) => {
              const next = bands.map((b) =>
                b.bandId === activeBand.bandId
                  ? { ...b, enabled: e.target.checked }
                  : b,
              );
              setBands(next);
              onCommitEqGesture(next, `تغییر وضعیت باند ${activeBand.bandId}`);
            }}
          />
          <span>فعال‌سازی باند ({activeBand.topology})</span>
        </label>

        <div className="flex flex-col gap-1">
          <span>فرکانس: {Math.round(activeBand.frequencyHz)} Hz</span>
          <input
            type="range"
            min={20}
            max={16000}
            step={5}
            value={activeBand.frequencyHz}
            onPointerDown={() => onBeginEqGesture(`eq_freq_${activeBand.bandId}`)}
            onChange={(e) => handleSliderChange('frequencyHz', Number(e.target.value))}
            onPointerUp={() =>
              onCommitEqGesture(
                bands,
                `تنظیم فرکانس EQ به ${Math.round(activeBand.frequencyHz)}Hz`,
              )
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <span>بهره (Gain): {activeBand.gainDb.toFixed(1)} dB</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={0.1}
            value={activeBand.gainDb}
            disabled={
              activeBand.topology === 'LOW_CUT_HPF' || activeBand.topology === 'NOTCH'
            }
            onPointerDown={() => onBeginEqGesture(`eq_gain_${activeBand.bandId}`)}
            onChange={(e) => handleSliderChange('gainDb', Number(e.target.value))}
            onPointerUp={() =>
              onCommitEqGesture(
                bands,
                `تنظیم بهره EQ به ${activeBand.gainDb.toFixed(1)}dB`,
              )
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <span>پهنای باند (Q): {activeBand.qFactor.toFixed(2)}</span>
          <input
            type="range"
            min={0.3}
            max={14.0}
            step={0.05}
            value={activeBand.qFactor}
            onPointerDown={() => onBeginEqGesture(`eq_q_${activeBand.bandId}`)}
            onChange={(e) => handleSliderChange('qFactor', Number(e.target.value))}
            onPointerUp={() =>
              onCommitEqGesture(
                bands,
                `تنظیم Q اکوالایزر به ${activeBand.qFactor.toFixed(2)}`,
              )
            }
          />
        </div>
      </div>
    </div>
  );
};
