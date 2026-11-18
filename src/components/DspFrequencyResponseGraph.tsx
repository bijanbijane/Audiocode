import React, { useMemo, useState } from 'react';
import { EphemeralDspParams } from '../contracts/v1_2';
import {
  buildDspResponseSvgPaths,
  computeDspFrequencyResponseCurve,
  GRAPH_MAX_DB,
  GRAPH_MAX_HZ,
  GRAPH_MIN_DB,
  GRAPH_MIN_HZ,
  mapDbToSvgY,
  mapFrequencyToSvgX,
} from '../engine/dspFrequencyResponse';

interface DspFrequencyResponseGraphProps {
  ephemeralParams: EphemeralDspParams;
  committedParams: EphemeralDspParams;
  sampleRate?: number;
  isGestureActive?: boolean;
  eqResponseCurveDb?: { freqHz: number; gainDb: number }[] | null;
}

const SVG_WIDTH = 640;
const SVG_HEIGHT = 192;
const PLOT_LEFT = 42;
const PLOT_RIGHT = 18;
const PLOT_TOP = 14;
const PLOT_BOTTOM = 24;
const INNER_W = SVG_WIDTH - PLOT_LEFT - PLOT_RIGHT;
const INNER_H = SVG_HEIGHT - PLOT_TOP - PLOT_BOTTOM;

const FREQ_GRID_TICKS: Array<{ hz: number; label: string }> = [
  { hz: 20, label: '20' },
  { hz: 50, label: '50' },
  { hz: 100, label: '100' },
  { hz: 200, label: '200' },
  { hz: 500, label: '500' },
  { hz: 1000, label: '1k' },
  { hz: 2000, label: '2k' },
  { hz: 5000, label: '5k' },
  { hz: 10000, label: '10k' },
  { hz: 20000, label: '20k' },
];

const DB_GRID_TICKS: Array<{ db: number; showLabel: boolean }> = [
  { db: 12, showLabel: true },
  { db: 6, showLabel: false },
  { db: 0, showLabel: true },
  { db: -6, showLabel: false },
  { db: -12, showLabel: true },
  { db: -24, showLabel: true },
  { db: -36, showLabel: true },
];
const REF_INPUT_OPTIONS = [-12, -6, 0] as const;

export const DspFrequencyResponseGraph: React.FC<DspFrequencyResponseGraphProps> = ({
  ephemeralParams,
  committedParams,
  sampleRate = 48000,
  isGestureActive = false,
  eqResponseCurveDb,
}) => {
  const [referenceInputDb, setReferenceInputDb] = useState<number>(-6);

  const hasUncommittedDiff =
    JSON.stringify(ephemeralParams) !== JSON.stringify(committedParams);

  const liveCurve = useMemo(
    () =>
      computeDspFrequencyResponseCurve(ephemeralParams, {
        sampleRate,
        referenceInputDb,
        numPoints: 96,
      }),
    [ephemeralParams, sampleRate, referenceInputDb],
  );

  const committedCurve = useMemo(
    () =>
      hasUncommittedDiff
        ? computeDspFrequencyResponseCurve(committedParams, {
            sampleRate,
            referenceInputDb,
            numPoints: 96,
          })
        : null,
    [committedParams, hasUncommittedDiff, sampleRate, referenceInputDb],
  );

  const livePaths = useMemo(
    () => buildDspResponseSvgPaths(liveCurve, INNER_W, INNER_H),
    [liveCurve],
  );

  const committedPaths = useMemo(
    () =>
      committedCurve
        ? buildDspResponseSvgPaths(committedCurve, INNER_W, INNER_H)
        : null,
    [committedCurve],
  );

  const eqPath = useMemo(() => {
    if (!eqResponseCurveDb || eqResponseCurveDb.length === 0) return null;
    const sorted = [...eqResponseCurveDb].sort((a, b) => a.freqHz - b.freqHz);
    return sorted
      .map((pt, idx) => {
        const x = mapFrequencyToSvgX(pt.freqHz, INNER_W, GRAPH_MIN_HZ, GRAPH_MAX_HZ);
        const y = mapDbToSvgY(pt.gainDb, INNER_H, GRAPH_MIN_DB, GRAPH_MAX_DB);
        return `${idx === 0 ? 'M' : 'L'}${x},${y}`;
      })
      .join(' ');
  }, [eqResponseCurveDb]);

  const formatSignedDb = (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;

  return (
    <div
      data-testid="dsp-frequency-response-graph"
      data-hpf-hz={ephemeralParams.highPassHz}
      data-comp-threshold-db={ephemeralParams.compressorThresholdDb}
      data-comp-ratio={ephemeralParams.compressorRatio}
      data-comp-gr-db={liveCurve.passbandReductionDb}
      data-effective-1khz-db={liveCurve.effectiveAt1kHzDb}
      data-50hz-gain-db={liveCurve.effectiveAt50HzDb}
      className="px-4 py-3 border-b border-[#252F42] bg-[#0E131D]/65 space-y-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-xs font-semibold text-slate-100">
            منحنی لحظه‌ای پاسخ فرکانسی (۲۰Hz – ۲۰kHz)
          </h3>
          <span className="text-[11px] text-slate-400">
            {isGestureActive || hasUncommittedDiff
              ? 'نمایش زنده حین تغییر (مقایسه با مرجع ثبت‌شده)'
              : 'پاسخ فیلتر بالاگذر و کاهش پویای کمپرسور'}
          </span>
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-slate-400">سطح ورودی مرجع:</span>
          <div
            dir="ltr"
            role="group"
            aria-label="سطح سیگنال مرجع کمپرسور"
            className="inline-flex items-center p-0.5 rounded bg-[#0B0F17] border border-[#252F42]"
          >
            {REF_INPUT_OPTIONS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                data-testid={`btn-dsp-ref-input-${lvl}`}
                onClick={() => setReferenceInputDb(lvl)}
                className={`px-2 py-0.5 rounded font-mono tabular-nums transition-colors cursor-pointer whitespace-nowrap ${
                  referenceInputDb === lvl
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl} dBFS
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-[#252F42] bg-[#0B0F17] overflow-hidden" dir="ltr">
        <svg
          direction="ltr"
          role="img"
          aria-label="نمودار لحظه‌ای پاسخ فرکانسی فیلتر بالاگذر و کمپرسور"
          data-testid="dsp-frequency-response-svg"
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          className="w-full h-44 sm:h-48 block select-none"
        >
          <g transform={`translate(${PLOT_LEFT}, ${PLOT_TOP})`}>
            {/* Vertical Logarithmic Frequency Grid Lines */}
            {FREQ_GRID_TICKS.map((tick) => {
              const x = mapFrequencyToSvgX(tick.hz, INNER_W, GRAPH_MIN_HZ, GRAPH_MAX_HZ);
              const anchor = tick.hz === 20 ? 'start' : tick.hz === 20000 ? 'end' : 'middle';
              return (
                <g key={tick.hz}>
                  <line
                    x1={x}
                    y1={0}
                    x2={x}
                    y2={INNER_H}
                    stroke="#1E2738"
                    strokeWidth={1}
                  />
                  <text
                    x={x}
                    y={INNER_H + 15}
                    textAnchor={anchor}
                    fill="#94A3B8"
                    fontSize="10"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {tick.label}
                  </text>
                </g>
              );
            })}

            {/* Horizontal dB Grid Lines */}
            {DB_GRID_TICKS.map(({ db, showLabel }) => {
              const y = mapDbToSvgY(db, INNER_H, GRAPH_MIN_DB, GRAPH_MAX_DB);
              const isZeroDb = db === 0;
              return (
                <g key={db}>
                  <line
                    x1={0}
                    y1={y}
                    x2={INNER_W}
                    y2={y}
                    stroke={isZeroDb ? '#475569' : '#1E2738'}
                    strokeWidth={isZeroDb ? 1.25 : 1}
                    strokeDasharray={isZeroDb ? '3 3' : undefined}
                  />
                  {showLabel && (
                    <text
                      x={-8}
                      y={y + 3.5}
                      textAnchor="end"
                      fill={isZeroDb ? '#CBD5E1' : '#64748B'}
                      fontSize="9.5"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {db > 0 ? `+${db}` : String(db)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Shaded Compressor Gain Reduction Area */}
            {livePaths.reductionAreaPath && (
              <path
                data-testid="dsp-curve-gr-area"
                d={livePaths.reductionAreaPath}
                fill="rgba(251, 191, 36, 0.14)"
              />
            )}

            {/* Optional Committed Reference Ghost Curve while Dragging */}
            {committedPaths && (
              <path
                data-testid="dsp-curve-committed"
                d={committedPaths.effectivePath}
                fill="none"
                stroke="#64748B"
                strokeWidth={1.25}
                strokeDasharray="2 3"
              />
            )}

            {/* Optional 8-Band Persian Voice EQ Curve Overlay */}
            {eqPath && (
              <path
                data-testid="dsp-curve-eq"
                d={eqPath}
                fill="none"
                stroke="#34D399"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}

            {/* HPF Cutoff Guide Vertical Line */}
            <line
              x1={livePaths.cutoffPoint.x}
              y1={0}
              x2={livePaths.cutoffPoint.x}
              y2={INNER_H}
              stroke="rgba(56, 189, 248, 0.45)"
              strokeWidth={1}
              strokeDasharray="3 2"
            />

            {/* Static Filter Curve (HPF + Master Gain) */}
            <path
              data-testid="dsp-curve-hpf"
              d={livePaths.staticPath}
              fill="none"
              stroke="#38BDF8"
              strokeWidth={1.75}
              strokeDasharray="5 3"
            />

            {/* Primary Effective Response Curve (HPF + Compressor + Master Gain) */}
            <path
              data-testid="dsp-curve-effective"
              d={livePaths.effectivePath}
              fill="none"
              stroke="#FBBF24"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* -3 dB Cutoff Marker Dot */}
            <circle
              data-testid="dsp-marker-hpf-cutoff"
              cx={livePaths.cutoffPoint.x}
              cy={livePaths.cutoffPoint.y}
              r={4.5}
              fill="#38BDF8"
              stroke="#0B0F17"
              strokeWidth={1.5}
            />
          </g>
        </svg>
      </div>

      {/* Legend & Tabular Telemetry Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2.5 text-slate-300">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="w-3 h-0.5 bg-amber-400 inline-block" aria-hidden="true" />
            <span>پاسخ موثر</span>
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="w-3 h-0.5 border-t border-dashed border-sky-400 inline-block" aria-hidden="true" />
            <span>فیلتر بالاگذر</span>
          </span>
          {eqPath && (
            <span className="inline-flex items-center gap-1.5 text-emerald-300 whitespace-nowrap">
              <span className="w-3 h-0.5 border-t border-dashed border-emerald-400 inline-block" aria-hidden="true" />
              <span>EQ ۸ بانده</span>
            </span>
          )}
        </div>

        <div dir="ltr" className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-slate-300">
          <span data-testid="dsp-graph-readout-hpf" className="text-sky-300">
            HPF -3dB: {ephemeralParams.highPassHz}Hz
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span data-testid="dsp-graph-readout-50hz">
            50Hz: {formatSignedDb(liveCurve.effectiveAt50HzDb)}
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span data-testid="dsp-graph-readout-gr" className="text-amber-300">
            Comp GR: {liveCurve.passbandReductionDb.toFixed(1)}dB
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span data-testid="dsp-graph-readout-1khz">
            1kHz: {formatSignedDb(liveCurve.effectiveAt1kHzDb)}
          </span>
        </div>
      </div>
    </div>
  );
};
