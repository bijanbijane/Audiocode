import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Gauge,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Scissors,
  Square,
} from 'lucide-react';
import { formatTimecode, secondsToFlicks } from '../engine/timebase';

export interface WaveformSelectionState {
  startSec: number;
  endSec: number;
  trackId: string;
  scope: 'track' | 'all';
}

interface AuditionTransportBarProps {
  isPlaying: boolean;
  playheadSec: number;
  totalDurationSec: number;
  selection: WaveformSelectionState | null;
  loopSelection: boolean;
  playbackRate: number;
  peakDb: number;
  rmsDb: number;
  onTogglePlay: () => void;
  onPlaySelection: () => void;
  onStopAndReset: () => void;
  onSeekSec: (sec: number) => void;
  onToggleLoop: () => void;
  onChangePlaybackRate: (rate: number) => void;
  onJumpPrevMarker: () => void;
  onJumpNextMarker: () => void;
  onSetInAtPlayhead: () => void;
  onSetOutAtPlayhead: () => void;
}

export const AuditionTransportBar: React.FC<AuditionTransportBarProps> = ({
  isPlaying,
  playheadSec,
  totalDurationSec,
  selection,
  loopSelection,
  playbackRate,
  peakDb,
  rmsDb,
  onTogglePlay,
  onPlaySelection,
  onStopAndReset,
  onSeekSec,
  onToggleLoop,
  onChangePlaybackRate,
  onJumpPrevMarker,
  onJumpNextMarker,
  onSetInAtPlayhead,
  onSetOutAtPlayhead,
}) => {
  const safeTotal = Math.max(0.1, totalDurationSec);
  const peakPct = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));
  const rmsPct = Math.max(0, Math.min(100, ((rmsDb + 60) / 60) * 100));
  const selectionLenSec = selection ? Math.max(0, selection.endSec - selection.startSec) : 0;

  return (
    <footer
      data-testid="audition-transport-deck"
      aria-label="پلیر و نوار کنترل ترنسپورت ادوبی ادیشن"
      className="sticky bottom-0 z-30 border-t border-[#2A2F3B] bg-[#16181D] text-slate-200 px-4 py-2.5"
    >
      <div className="max-w-[1440px] mx-auto flex flex-col gap-2">
        {/* Top Row: Interactive Playhead Scrub Slider with Selection Highlight */}
        <div className="flex items-center gap-3" dir="ltr">
          <span
            data-testid="audition-timecode-hud"
            className="text-sm font-mono tabular-nums text-[#2EE59D] min-w-[92px] tracking-tight"
          >
            {formatTimecode(secondsToFlicks(playheadSec))}
          </span>

          <div className="relative flex-1 flex items-center">
            {selection && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 -translate-y-1/2 h-2.5 rounded bg-sky-400/35 border border-sky-400/70"
                style={{
                  left: `${(selection.startSec / safeTotal) * 100}%`,
                  width: `${Math.max(0.8, ((selection.endSec - selection.startSec) / safeTotal) * 100)}%`,
                }}
              />
            )}
            <input
              type="range"
              data-testid="audition-scrub-slider"
              aria-label="نوار زمان پخش"
              min={0}
              max={safeTotal}
              step={0.01}
              value={Math.min(safeTotal, playheadSec)}
              onChange={(e) => onSeekSec(Number(e.target.value))}
              className="w-full h-2 accent-[#2EE59D] bg-[#252A36] rounded cursor-pointer relative z-10"
            />
          </div>

          <span className="text-xs font-mono tabular-nums text-slate-400 min-w-[82px] text-right">
            {formatTimecode(secondsToFlicks(totalDurationSec))}
          </span>
        </div>

        {/* Bottom Row: Adobe Audition Transport Controls, In/Out Markers, Speed & Live Peak/RMS Meter */}
        <div dir="rtl" className="flex flex-wrap items-center justify-between gap-3">
          {/* Primary Playback & Selection Play Controls */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="audition-btn-rewind"
              onClick={onStopAndReset}
              aria-label="توقف و بازگشت به ابتدا"
              title="بازگشت به ابتدا (Home)"
              className="p-2 rounded border border-[#2D323E] bg-[#1F232C] hover:bg-[#292F3B] text-slate-300 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              data-testid="audition-btn-stop"
              onClick={onStopAndReset}
              aria-label="توقف کامل"
              className="p-2 rounded border border-[#2D323E] bg-[#1F232C] hover:bg-[#292F3B] text-slate-300 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              data-testid="audition-btn-play-pause"
              onClick={onTogglePlay}
              aria-label={isPlaying ? 'توقف پخش' : 'شروع پخش'}
              title="پخش / مکث (Space)"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                isPlaying
                  ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                  : 'bg-[#2EE59D] text-slate-950 hover:bg-[#52EEB0]'
              }`}
            >
              {isPlaying ? (
                <>
                  <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>توقف پخش</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>پخش</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="audition-btn-play-selection"
              disabled={!selection || selectionLenSec < 0.05}
              onClick={onPlaySelection}
              title="پخش فقط محدوده انتخاب‌شده"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-40 text-sky-200 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <Scissors className="w-3.5 h-3.5 text-sky-300" aria-hidden="true" />
              <span>پخش انتخاب</span>
            </button>

            <button
              type="button"
              data-testid="audition-btn-loop"
              onClick={onToggleLoop}
              aria-pressed={loopSelection}
              title="تکرار پخش محدوده انتخابی (L)"
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded border text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                loopSelection
                  ? 'border-amber-400/70 bg-amber-400/20 text-amber-200'
                  : 'border-[#2D323E] bg-[#1F232C] text-slate-300 hover:bg-[#292F3B]'
              }`}
            >
              <Repeat className="w-3.5 h-3.5" aria-hidden="true" />
              <span>تکرار (Loop)</span>
            </button>

            <div className="h-5 w-px bg-[#2D323E] mx-1 hidden sm:block" aria-hidden="true" />

            <button
              type="button"
              onClick={onJumpPrevMarker}
              aria-label="پرش به نشانگر قبلی"
              title="نشانگر یا فصل قبلی"
              className="p-1.5 rounded border border-[#2D323E] bg-[#1F232C] hover:bg-[#292F3B] text-slate-300 cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onJumpNextMarker}
              aria-label="پرش به نشانگر بعدی"
              title="نشانگر یا فصل بعدی"
              className="p-1.5 rounded border border-[#2D323E] bg-[#1F232C] hover:bg-[#292F3B] text-slate-300 cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Selection In/Out Marker Readout + Set I/O Buttons */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              data-testid="audition-btn-set-in"
              onClick={onSetInAtPlayhead}
              title="تنظیم نقطه شروع انتخاب روی مکان‌نما (I)"
              className="px-2 py-1 rounded border border-[#2D323E] bg-[#1F232C] hover:bg-[#292F3B] font-mono text-[11px] text-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
            >
              نقطه شروع (I)
            </button>
            <button
              type="button"
              data-testid="audition-btn-set-out"
              onClick={onSetOutAtPlayhead}
              title="تنظیم نقطه پایان انتخاب روی مکان‌نما (O)"
              className="px-2 py-1 rounded border border-[#2D323E] bg-[#1F232C] hover:bg-[#292F3B] font-mono text-[11px] text-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
            >
              نقطه پایان (O)
            </button>

            <div
              data-testid="audition-selection-hud"
              dir="ltr"
              className="px-2.5 py-1 rounded border border-[#2D323E] bg-[#111318] font-mono tabular-nums text-[11px] text-slate-300 whitespace-nowrap"
            >
              {selection ? (
                <span>
                  Sel: {selection.startSec.toFixed(2)}s .. {selection.endSec.toFixed(2)}s (Δ{' '}
                  {selectionLenSec.toFixed(2)}s)
                </span>
              ) : (
                <span className="text-slate-500">No Selection</span>
              )}
            </div>
          </div>

          {/* Playback Speed & Real-Time Peak/RMS dBFS Output Meter */}
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 whitespace-nowrap shrink-0">
              <Gauge className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span className="sr-only">سرعت پخش</span>
              <select
                data-testid="audition-playback-speed"
                aria-label="سرعت پخش"
                value={playbackRate}
                onChange={(e) => onChangePlaybackRate(Number(e.target.value))}
                className="px-2 py-1 rounded border border-[#2D323E] bg-[#1F232C] font-mono tabular-nums text-[11px] text-slate-200 cursor-pointer"
              >
                <option value={0.75}>0.75x</option>
                <option value={1}>1.00x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.50x</option>
              </select>
            </label>

            <div
              data-testid="audition-master-meter"
              className="flex flex-col gap-1 min-w-[140px]"
              dir="ltr"
              aria-label="سطح‌سنج خروجی صدا dBFS"
            >
              <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-400">
                <span>MASTER</span>
                <span>{peakDb <= -59 ? '-∞' : peakDb.toFixed(1)} dBFS</span>
              </div>
              <div className="h-2 w-full rounded bg-[#111318] border border-[#2D323E] overflow-hidden relative">
                <div
                  className="h-full bg-gradient-to-r from-[#2EE59D] via-amber-400 to-rose-500 transition-[width] duration-75"
                  style={{ width: `${peakPct}%` }}
                />
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-white/80"
                  style={{ left: `${rmsPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};
