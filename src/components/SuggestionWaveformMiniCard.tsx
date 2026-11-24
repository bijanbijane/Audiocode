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
  locale?: 'fa' | 'en';
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
  locale = 'fa',
}) => {
  const isFa = locale === 'fa';
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
    ? isFa
      ? `حذف ${preview.cutDurationSec.toFixed(2)}s و بستن فاصله (Ripple)`
      : `Remove ${preview.cutDurationSec.toFixed(2)}s (Ripple Cut)`
    : isFa
      ? `جایگزینی ${preview.cutDurationSec.toFixed(2)}s با Room Tone (حفظ سینک)`
      : `Replace ${preview.cutDurationSec.toFixed(2)}s with Room Tone (Sync Safe)`;

  return (
    <div
      data-testid="suggestion-waveform-minicard"
      data-rec-id={recommendation.id}
      data-effective-mode={preview.effectiveMode}
      data-view-mode={viewMode}
      className="px-3.5 py-3 border-b border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--avp-text)] whitespace-nowrap">
          {isFa ? 'پیش‌نمایش موجی اثر حذف' : 'Edit Impact Waveform'}
        </span>

        <div
          role="group"
          aria-label={isFa ? 'حالت نمایش نمودار موجی' : 'Mini waveform preview mode'}
          className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-border)] shrink-0"
        >
          {(
            [
              { id: 'compare', label: isFa ? 'مقایسه' : 'Compare' },
              { id: 'before', label: isFa ? 'قبل' : 'Before' },
              { id: 'after', label: isFa ? 'بعد' : 'After' },
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
                className={`px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-[var(--avp-accent)] text-white'
                    : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-1.5 space-y-0.5">
        <p className="text-xs text-[var(--avp-text)] font-medium truncate">
          {recommendation.relatedText}
        </p>
        <div
          data-testid="minicard-impact-summary"
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-[var(--avp-text-muted)]"
        >
          <span className="text-[var(--avp-accent-text)] font-medium">
            {impactSummaryText}
          </span>
          <span dir="ltr" className="font-mono tabular-nums">
            {preview.cutStartSec.toFixed(2)}s – {preview.cutEndSec.toFixed(2)}s
          </span>
        </div>
      </div>

      <div className="mt-2 space-y-2">
        {(viewMode === 'compare' || viewMode === 'before') && (
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-[var(--avp-text-secondary)] font-medium">
                {isFa ? 'قبل از اعمال' : 'Before Edit'}
              </span>
              <span className="text-[var(--avp-danger)] font-mono tabular-nums" dir="ltr">
                {preview.cutDurationSec.toFixed(2)}s
              </span>
            </div>
            <div
              dir="ltr"
              className="rounded-lg border border-slate-800 bg-[var(--avp-waveform-bg)] px-1.5 py-1 overflow-hidden"
            >
              <svg
                data-testid="minicard-svg-before"
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-10 block"
                role="img"
                aria-label={`${isFa ? 'موج قبل از اعمال' : 'Before waveform'} ${recommendation.relatedText}`}
              >
                <line x1={0} y1={MID_Y} x2={SVG_W} y2={MID_Y} stroke="#1E2B3A" strokeWidth={1} />
                <rect
                  data-testid="minicard-cut-zone"
                  x={cutStartX.toFixed(2)}
                  y={1}
                  width={cutWidthX.toFixed(2)}
                  height={SVG_H - 2}
                  fill="#D85D65"
                  fillOpacity={0.22}
                />
                {renderWaveformBars(
                  preview.beforeBins,
                  0,
                  SVG_W,
                  (_bin, _idx, ratio) => {
                    const inCut = ratio >= preview.cutStartRatio && ratio <= preview.cutEndRatio;
                    return inCut ? '#F2747C' : '#43C7A7';
                  },
                  (_bin, _idx, ratio) => {
                    const inCut = ratio >= preview.cutStartRatio && ratio <= preview.cutEndRatio;
                    return inCut ? 0.92 : 0.82;
                  },
                )}
                <line
                  x1={cutStartX.toFixed(2)}
                  y1={0}
                  x2={cutStartX.toFixed(2)}
                  y2={SVG_H}
                  stroke="#F2747C"
                  strokeWidth={1.25}
                  strokeDasharray="3 2"
                />
                <line
                  x1={cutEndX.toFixed(2)}
                  y1={0}
                  x2={cutEndX.toFixed(2)}
                  y2={SVG_H}
                  stroke="#F2747C"
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
              <span className="text-[var(--avp-text-secondary)] font-medium">
                {isRipple
                  ? isFa
                    ? 'پس از حذف (Ripple)'
                    : 'After Ripple Cut'
                  : isFa
                    ? 'پس از Room Tone'
                    : 'After Room Tone'}
              </span>
              <span dir="ltr" className="font-mono tabular-nums text-[var(--avp-accent-text)]">
                {isRipple ? `-${preview.savedDurationSec.toFixed(2)}s` : 'Sync 0.00s'}
              </span>
            </div>
            <div
              dir="ltr"
              className="rounded-lg border border-slate-800 bg-[var(--avp-waveform-bg)] px-1.5 py-1 overflow-hidden"
            >
              <svg
                data-testid="minicard-svg-after"
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-10 block"
                role="img"
                aria-label={`${isFa ? 'موج پس از اعمال' : 'After waveform'} ${recommendation.relatedText}`}
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
                      strokeOpacity="0.6"
                    />
                  </pattern>
                </defs>
                <line x1={0} y1={MID_Y} x2={SVG_W} y2={MID_Y} stroke="#1E2B3A" strokeWidth={1} />
                {!isRipple && (
                  <rect
                    data-testid="minicard-roomtone-zone"
                    x={cutStartX.toFixed(2)}
                    y={1}
                    width={cutWidthX.toFixed(2)}
                    height={SVG_H - 2}
                    fill="#1FA38B"
                    fillOpacity={0.14}
                  />
                )}
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
                {renderWaveformBars(
                  preview.afterBins,
                  0,
                  afterFillW,
                  (bin) => (bin.isRoomTone ? '#1FA38B' : '#43C7A7'),
                  (bin) => (bin.isRoomTone ? 0.65 : 0.88),
                )}
                {isRipple ? (
                  <g data-testid="minicard-splice-seam">
                    <line
                      x1={spliceX.toFixed(2)}
                      y1={0}
                      x2={spliceX.toFixed(2)}
                      y2={SVG_H}
                      stroke="#E5A13B"
                      strokeWidth={1.6}
                    />
                    <polygon
                      points={`${spliceX.toFixed(2)},1 ${(spliceX - 3.5).toFixed(2)},6 ${(spliceX + 3.5).toFixed(2)},6`}
                      fill="#E5A13B"
                    />
                  </g>
                ) : (
                  <g data-testid="minicard-roomtone-bounds">
                    <line
                      x1={cutStartX.toFixed(2)}
                      y1={0}
                      x2={cutStartX.toFixed(2)}
                      y2={SVG_H}
                      stroke="#43C7A7"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                    <line
                      x1={cutEndX.toFixed(2)}
                      y1={0}
                      x2={cutEndX.toFixed(2)}
                      y2={SVG_H}
                      stroke="#43C7A7"
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
    </div>
  );
};
