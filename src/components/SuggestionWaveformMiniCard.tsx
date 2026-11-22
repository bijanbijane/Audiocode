import React, { useId, useMemo, useState } from 'react';
import {
  AudioAsset,
  PersianWordToken,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import {
  buildSuggestionImpactPreview,
  WaveformMiniBin,
} from '../utils/suggestionWaveformPreview';

export type MiniCardPreviewMode = 'compare' | 'before' | 'after';

export interface SuggestionWaveformMiniCardProps {
  recommendation: SmartRecommendation;
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  tokens: PersianWordToken[];
  sampleRate: number;
}

const SVG_W = 360;
const SVG_H = 44;
const MID_Y = SVG_H / 2;
const MAX_HALF_H = SVG_H / 2 - 4;

function renderWaveformBars(
  bins: WaveformMiniBin[],
  xStart: number,
  xWidth: number,
  colorForBin: (bin: WaveformMiniBin, idx: number, ratio: number) => string,
  opacityForBin?: (bin: WaveformMiniBin, idx: number, ratio: number) => number,
) {
  if (bins.length === 0 || xWidth <= 0) return null;
  const step = xWidth / bins.length;
  const barW = Math.max(1.2, step * 0.68);

  return bins.map((bin, idx) => {
    const ratio = (idx + 0.5) / bins.length;
    const x = xStart + idx * step + (step - barW) * 0.5;
    // Keep a subtle 1.5px baseline so genuine silence stays visibly readable as a flat quiet floor
    const halfH = Math.max(1.2, Math.min(MAX_HALF_H, bin.peak * MAX_HALF_H));
    const y = MID_Y - halfH;
    const h = halfH * 2;
    return (
      <rect
        key={idx}
        x={x.toFixed(2)}
        y={y.toFixed(2)}
        width={barW.toFixed(2)}
        height={h.toFixed(2)}
        rx={0.75}
        fill={colorForBin(bin, idx, ratio)}
        fillOpacity={opacityForBin ? opacityForBin(bin, idx, ratio) : 0.92}
      />
    );
  });
}

export const SuggestionWaveformMiniCard: React.FC<SuggestionWaveformMiniCardProps> = ({
  recommendation,
  tracks,
  assets,
  pcmSources,
  tokens,
  sampleRate,
}) => {
  const [viewMode, setViewMode] = useState<MiniCardPreviewMode>('compare');
  const rawId = useId();
  const hatchPatternId = `saved-hatch-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const preview = useMemo(
    () =>
      buildSuggestionImpactPreview({
        recommendation,
        tracks,
        assets,
        pcmSources,
        tokens,
        sampleRate,
        binCount: 84,
      }),
    [recommendation, tracks, assets, pcmSources, tokens, sampleRate],
  );

  const isRipple = preview.effectiveMode === 'sync-locked-ripple-cut';
  const cutStartX = preview.cutStartRatio * SVG_W;
  const cutEndX = preview.cutEndRatio * SVG_W;
  const cutWidthX = Math.max(2, cutEndX - cutStartX);
  const afterFillW = preview.afterFillRatio * SVG_W;
  const spliceX = preview.spliceRatio * SVG_W;
  const savedTailW = Math.max(0, SVG_W - afterFillW);

  const impactSummaryText = isRipple
    ? `حذف ${preview.cutDurationSec.toFixed(2)}s و بستن فاصله (برش Ripple)`
    : `جایگزینی ${preview.cutDurationSec.toFixed(2)}s با Room Tone (حفظ سینک چندترک)`;

  return (
    <div
      data-testid="suggestion-waveform-minicard"
      data-rec-id={recommendation.id}
      data-effective-mode={preview.effectiveMode}
      data-view-mode={viewMode}
      className="px-4 py-3 border-b border-[#252F42] bg-[#0E131D]"
    >
      {/* Top Row: Title + Segmented Mode Toggle */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-100 whitespace-nowrap">
          پیش‌نمایش موجی اثر حذف
        </span>

        {/* Interactive Segmented Control (Compare / Before / After) */}
        <div
          role="group"
          aria-label="حالت نمایش نمودار موجی پیش‌نمایش"
          className="inline-flex items-center gap-0.5 p-0.5 rounded bg-[#131924] border border-[#252F42] shrink-0"
        >
          {(
            [
              { id: 'compare', label: 'مقایسه' },
              { id: 'before', label: 'قبل' },
              { id: 'after', label: 'بعد' },
            ] as const
          ).map((opt) => {
            const active = viewMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                data-testid={`minicard-mode-${opt.id}`}
                aria-pressed={active}
                onClick={() => setViewMode(opt.id)}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-[#223049] text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Suggestion Title & Quantitative Impact Metadata */}
      <div className="mt-1.5 space-y-0.5">
        <p className="text-xs text-slate-200 font-medium truncate">
          {recommendation.relatedText}
        </p>
        <div
          data-testid="minicard-impact-summary"
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-slate-400"
        >
          <span className={isRipple ? 'text-emerald-400' : 'text-sky-300'}>
            {impactSummaryText}
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span dir="ltr" className="font-mono tabular-nums">
              {preview.cutStartSec.toFixed(2)}s – {preview.cutEndSec.toFixed(2)}s
            </span>
            <span className="text-slate-600" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-500">{preview.trackName}</span>
          </span>
        </div>
      </div>

      {/* Status Notice if Already Applied or Rejected */}
      {recommendation.status !== 'Pending' && (
        <p className="mt-2 text-[11px] text-amber-300/90">
          {recommendation.status === 'Accepted'
            ? 'این پیشنهاد قبلاً روی تایم‌لاین اعمال شده است (نمایش مرجع بازه انتخابی).'
            : recommendation.status === 'Superseded'
              ? 'این بازه توسط برش قبلی پوشش داده شده است.'
              : 'این پیشنهاد رد شده و تغییری روی موج صوتی اعمال نشده است.'}
        </p>
      )}

      {/* Mini Waveform Strips */}
      <div className="mt-2.5 space-y-2">
        {(viewMode === 'compare' || viewMode === 'before') && (
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-slate-300 font-medium">قبل از اعمال (بخش حذفی مشخص‌شده)</span>
              <span className="text-rose-300/90 inline-flex items-center gap-1">
                <span>بازه حذف:</span>
                <span dir="ltr" className="font-mono tabular-nums">
                  {preview.cutDurationSec.toFixed(2)}s
                </span>
              </span>
            </div>
            <div
              dir="ltr"
              className="rounded border border-[#1E293B] bg-[#090D14] px-1.5 py-1 overflow-hidden"
            >
              <svg
                data-testid="minicard-svg-before"
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-11 block"
                role="img"
                aria-label={`نمودار موجی قبل از اعمال پیشنهاد ${recommendation.relatedText} با نمایش بازه حذف از ${preview.cutStartSec.toFixed(2)} تا ${preview.cutEndSec.toFixed(2)} ثانیه`}
              >
                {/* Center reference axis */}
                <line
                  x1={0}
                  y1={MID_Y}
                  x2={SVG_W}
                  y2={MID_Y}
                  stroke="#1E293B"
                  strokeWidth={1}
                />

                {/* Highlighted cut zone */}
                <rect
                  data-testid="minicard-cut-zone"
                  x={cutStartX.toFixed(2)}
                  y={1}
                  width={cutWidthX.toFixed(2)}
                  height={SVG_H - 2}
                  fill="#F43F5E"
                  fillOpacity={0.16}
                />

                {/* Waveform bars */}
                {renderWaveformBars(
                  preview.beforeBins,
                  0,
                  SVG_W,
                  (_bin, _idx, ratio) => {
                    const inCut = ratio >= preview.cutStartRatio && ratio <= preview.cutEndRatio;
                    return inCut ? '#FB7185' : '#38BDF8';
                  },
                  (_bin, _idx, ratio) => {
                    const inCut = ratio >= preview.cutStartRatio && ratio <= preview.cutEndRatio;
                    return inCut ? 0.88 : 0.78;
                  },
                )}

                {/* Crisp dashed boundary markers */}
                <line
                  x1={cutStartX.toFixed(2)}
                  y1={0}
                  x2={cutStartX.toFixed(2)}
                  y2={SVG_H}
                  stroke="#F43F5E"
                  strokeWidth={1.25}
                  strokeDasharray="3 2"
                />
                <line
                  x1={cutEndX.toFixed(2)}
                  y1={0}
                  x2={cutEndX.toFixed(2)}
                  y2={SVG_H}
                  stroke="#F43F5E"
                  strokeWidth={1.25}
                  strokeDasharray="3 2"
                />
              </svg>
            </div>
          </div>
        )}

        {(viewMode === 'compare' || viewMode === 'after') && (
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-slate-300 font-medium">
                {isRipple
                  ? 'پس از حذف (بخش پس از سکوت به محل برش متصل می‌شود)'
                  : 'پس از جایگزینی (سطح صدا به کف Room Tone کاهش می‌یابد)'}
              </span>
              <span dir="ltr" className="font-mono tabular-nums text-emerald-400">
                {isRipple
                  ? `-${preview.savedDurationSec.toFixed(2)}s`
                  : 'Sync 0.00s'}
              </span>
            </div>
            <div
              dir="ltr"
              className="rounded border border-[#1E293B] bg-[#090D14] px-1.5 py-1 overflow-hidden"
            >
              <svg
                data-testid="minicard-svg-after"
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-11 block"
                role="img"
                aria-label={`نمودار موجی پیش‌بینی‌شده پس از اعمال پیشنهاد ${recommendation.relatedText}`}
              >
                <defs>
                  <pattern
                    id={hatchPatternId}
                    width="6"
                    height="6"
                    patternTransform="rotate(45 0 0)"
                    patternUnits="userSpaceOnUse"
                  >
                    <line
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="6"
                      stroke="#334155"
                      strokeWidth="1.2"
                      strokeOpacity="0.55"
                    />
                  </pattern>
                </defs>

                {/* Center reference axis */}
                <line
                  x1={0}
                  y1={MID_Y}
                  x2={SVG_W}
                  y2={MID_Y}
                  stroke="#1E293B"
                  strokeWidth={1}
                />

                {/* Room-tone replacement band when in-place suppression is active */}
                {!isRipple && (
                  <rect
                    data-testid="minicard-roomtone-zone"
                    x={cutStartX.toFixed(2)}
                    y={1}
                    width={cutWidthX.toFixed(2)}
                    height={SVG_H - 2}
                    fill="#10B981"
                    fillOpacity={0.12}
                  />
                )}

                {/* Reclaimed / shortened timeline tail when ripple cut collapses duration */}
                {isRipple && savedTailW > 1 && (
                  <g data-testid="minicard-saved-tail">
                    <rect
                      x={afterFillW.toFixed(2)}
                      y={1}
                      width={savedTailW.toFixed(2)}
                      height={SVG_H - 2}
                      fill={`url(#${hatchPatternId})`}
                    />
                    <line
                      x1={afterFillW.toFixed(2)}
                      y1={0}
                      x2={afterFillW.toFixed(2)}
                      y2={SVG_H}
                      stroke="#475569"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                  </g>
                )}

                {/* After-edit waveform bars */}
                {renderWaveformBars(
                  preview.afterBins,
                  0,
                  afterFillW,
                  (bin, _idx, ratio) => {
                    if (!isRipple && bin.isRoomTone) return '#10B981';
                    if (isRipple && ratio * preview.afterFillRatio >= preview.spliceRatio) {
                      return '#34D399';
                    }
                    return '#38BDF8';
                  },
                  (bin) => (bin.isRoomTone ? 0.72 : 0.88),
                )}

                {/* Emerald splice seam marker */}
                {isRipple ? (
                  <g data-testid="minicard-splice-seam">
                    <line
                      x1={spliceX.toFixed(2)}
                      y1={0}
                      x2={spliceX.toFixed(2)}
                      y2={SVG_H}
                      stroke="#10B981"
                      strokeWidth={1.6}
                    />
                    <polygon
                      points={`${spliceX.toFixed(2)},1 ${(spliceX - 3.5).toFixed(2)},6 ${(spliceX + 3.5).toFixed(2)},6`}
                      fill="#10B981"
                    />
                  </g>
                ) : (
                  <g data-testid="minicard-roomtone-bounds">
                    <line
                      x1={cutStartX.toFixed(2)}
                      y1={0}
                      x2={cutStartX.toFixed(2)}
                      y2={SVG_H}
                      stroke="#10B981"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                    <line
                      x1={cutEndX.toFixed(2)}
                      y1={0}
                      x2={cutEndX.toFixed(2)}
                      y2={SVG_H}
                      stroke="#10B981"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                  </g>
                )}
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Compact Footer Axis & Legend (Zero-pill clean inline metadata) */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-slate-400">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-[2px] bg-rose-400/80" aria-hidden="true" />
            <span>بخش حذفی</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-[2px] bg-emerald-400" aria-hidden="true" />
            <span>{isRipple ? 'نقطه اتصال و بخش جابه‌جاشده' : 'کف Room Tone'}</span>
          </span>
        </div>
        <span dir="ltr" className="font-mono tabular-nums text-slate-500">
          {preview.windowStartSec.toFixed(2)}s → {preview.windowEndSec.toFixed(2)}s
        </span>
      </div>
    </div>
  );
};
