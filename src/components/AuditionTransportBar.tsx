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
  SkipBack,
  SkipForward,
  Square,
  X,
} from 'lucide-react';
import { formatNumberForLocale, formatStudioTimecode } from '../utils/formatters';

export interface WaveformSelectionState {
  startSec: number;
  endSec: number;
  trackId: string;
  scope: 'track' | 'all';
}

interface AuditionTransportBarProps {
  isPlaying: boolean;
  hasAudio?: boolean;
  isPreviewMode?: boolean;
  previewLabel?: string | null;
  playheadSec: number;
  totalDurationSec: number;
  selection: WaveformSelectionState | null;
  loopSelection: boolean;
  playbackRate: number;
  seekStepSec?: number;
  peakDb: number;
  rmsDb: number;
  locale?: 'fa' | 'en';
  timecodeFormat?: 'mm:ss.ms' | 'hh:mm:ss';
  persianDigits?: boolean;
  onTogglePlay: () => void;
  onPlaySelection: () => void;
  onStopAndReset: () => void;
  onExitPreview?: () => void;
  onSeekSec: (sec: number) => void;
  onStepBack?: () => void;
  onStepForward?: () => void;
  onToggleLoop: () => void;
  onChangePlaybackRate: (rate: number) => void;
  onJumpPrevMarker: () => void;
  onJumpNextMarker: () => void;
  onSetInAtPlayhead: () => void;
  onSetOutAtPlayhead: () => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const AuditionTransportBar: React.FC<AuditionTransportBarProps> = ({
  isPlaying,
  hasAudio = true,
  isPreviewMode = false,
  previewLabel = null,
  playheadSec,
  totalDurationSec,
  selection,
  loopSelection,
  playbackRate,
  seekStepSec = 5,
  peakDb,
  rmsDb,
  locale = 'fa',
  timecodeFormat = 'mm:ss.ms',
  persianDigits = false,
  onTogglePlay,
  onPlaySelection,
  onStopAndReset,
  onExitPreview,
  onSeekSec,
  onStepBack,
  onStepForward,
  onToggleLoop,
  onChangePlaybackRate,
  onJumpPrevMarker,
  onJumpNextMarker,
  onSetInAtPlayhead,
  onSetOutAtPlayhead,
}) => {
  const isFa = locale === 'fa';
  const safeTotal = Math.max(0.1, totalDurationSec);
  const progressPct = Math.max(0, Math.min(100, (playheadSec / safeTotal) * 100));
  const peakPct = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));
  void rmsDb;
  const selectionLenSec = selection ? Math.max(0, selection.endSec - selection.startSec) : 0;

  const formattedPlayhead = formatStudioTimecode(playheadSec, timecodeFormat, persianDigits);
  const formattedTotal = formatStudioTimecode(totalDurationSec, timecodeFormat, persianDigits);

  const statusText = !hasAudio
    ? isFa
      ? 'بدون صوت'
      : 'No Audio'
    : isPreviewMode
      ? previewLabel ?? (isFa ? 'پیش‌شنوایی' : 'Previewing')
      : isPlaying
        ? isFa
          ? 'در حال پخش'
          : 'Playing'
        : playheadSec > 0.05
          ? isFa
            ? 'مکث'
            : 'Paused'
          : isFa
            ? 'آماده'
            : 'Ready';

  return (
    <footer
      data-testid="audition-transport-deck"
      aria-label={isFa ? 'نوار کنترل پخش صوت' : 'Audio transport control bar'}
      className="fixed bottom-0 inset-x-0 z-30 border-t border-[var(--avp-border)] bg-[var(--avp-surface-shell)]/96 backdrop-blur-md text-[var(--avp-text)]"
    >
      {/* Top Edge-Anchored Slim Progress Scrubber (3px resting, expands visually on hover) */}
      <div
        className="group relative w-full h-2.5 -mt-1 flex items-center cursor-pointer"
        dir="ltr"
      >
        <div className="w-full h-[3px] group-hover:h-[5px] bg-[var(--avp-border)] transition-all relative overflow-hidden">
          <div
            className="h-full bg-[var(--avp-accent)]"
            style={{ width: `${progressPct}%` }}
          />
          {selection && selectionLenSec > 0.01 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 bg-[var(--avp-warning)]/70"
              style={{
                left: `${(selection.startSec / safeTotal) * 100}%`,
                width: `${Math.max(0.8, ((selection.endSec - selection.startSec) / safeTotal) * 100)}%`,
              }}
            />
          )}
        </div>
        <input
          type="range"
          data-testid="audition-scrub-slider"
          aria-label={isFa ? 'نوار زمان پخش' : 'Playback timeline scrubber'}
          disabled={!hasAudio}
          min={0}
          max={safeTotal}
          step={0.01}
          value={Math.min(safeTotal, Math.max(0, playheadSec))}
          onChange={(e) => onSeekSec(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
        />
      </div>

      {/* Responsive Transport Row: 2 clean rows on < sm (390px), symmetrical 50px 3-zone grid on sm+ */}
      <div className="w-full px-2.5 sm:px-4 py-1.5 sm:py-0 min-h-[50px] sm:h-[50px] flex flex-wrap sm:grid sm:grid-cols-[1fr_auto_1fr] items-center justify-between gap-1.5 sm:gap-2">
        {/* Zone 1 (Start — Timecode HUD + Status + LED Output Meter) */}
        <div className="order-2 sm:order-1 flex items-center gap-2 min-w-0 justify-self-start px-2 sm:px-2.5 py-1 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/65">
          <div className="flex items-center gap-1.5" dir="ltr">
            <span
              data-testid="audition-timecode-hud"
              className="avp-bidi-num text-[11.5px] sm:text-[12.5px] font-semibold text-[var(--avp-text)] sm:min-w-[72px]"
            >
              {formattedPlayhead}
            </span>
            <span className="text-[11px] text-[var(--avp-text-faint)]">/</span>
            <span className="avp-bidi-num text-[10.5px] sm:text-[11px] text-[var(--avp-text-muted)]">
              {formattedTotal}
            </span>
          </div>

          <span className="w-px h-3.5 bg-[var(--avp-border)] hidden md:block" aria-hidden="true" />

          <span
            data-testid="transport-status-badge"
            className={`hidden md:inline-flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap ${
              isPreviewMode
                ? 'text-[var(--avp-warning-text)]'
                : isPlaying
                  ? 'text-[var(--avp-accent-text)]'
                  : 'text-[var(--avp-text-secondary)]'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isPreviewMode
                  ? 'bg-[var(--avp-warning)]'
                  : isPlaying
                    ? 'bg-[var(--avp-accent)]'
                    : 'bg-emerald-500/70'
              }`}
              aria-hidden="true"
            />
            <span>{statusText}</span>
          </span>

          {isPreviewMode && onExitPreview && (
            <button
              type="button"
              data-testid="btn-exit-preview-mode"
              onClick={onExitPreview}
              className="avp-btn avp-btn-sm avp-btn-ghost"
            >
              <X className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
              <span>{isFa ? 'پایان' : 'Exit'}</span>
            </button>
          )}

          <span className="w-px h-3.5 bg-[var(--avp-border)] hidden xl:block" aria-hidden="true" />

          {/* 12-Segment Stereo L/R Studio LED Output Meter */}
          <div
            data-testid="audition-master-meter"
            className="hidden xl:flex items-center gap-2"
            dir="ltr"
            aria-label={isFa ? 'سطح خروجی صدا dBFS' : 'Master output level dBFS'}
          >
            <div className="flex flex-col gap-[3px]">
              {(['L', 'R'] as const).map((ch, chIdx) => {
                const chPeak = chIdx === 0 ? peakPct : Math.max(0, peakPct - (isPlaying ? 4 : 0));
                const activeSegments = isPlaying
                  ? Math.max(2, Math.round((chPeak / 100) * 12))
                  : chPeak > 2
                    ? Math.round((chPeak / 100) * 12)
                    : 0;
                return (
                  <div key={ch} className="flex items-center gap-1.5">
                    <span className="text-[9px] font-mono font-bold leading-none text-[var(--avp-text-muted)] w-2.5">
                      {ch}
                    </span>
                    <div className="flex items-center gap-[2px]">
                      {Array.from({ length: 12 }).map((_, segIdx) => {
                        const isLit = segIdx < activeSegments;
                        const activeColor =
                          segIdx >= 10
                            ? 'bg-rose-500'
                            : segIdx >= 8
                              ? 'bg-amber-400'
                              : 'bg-emerald-500';
                        const idleColor =
                          segIdx >= 10
                            ? 'bg-rose-500/20 dark:bg-rose-500/15'
                            : segIdx >= 8
                              ? 'bg-amber-500/20 dark:bg-amber-400/15'
                              : 'bg-emerald-600/20 dark:bg-emerald-500/18';
                        return (
                          <span
                            key={segIdx}
                            className={`w-[4.5px] h-[5px] rounded-[1px] transition-colors duration-75 ${
                              isLit ? activeColor : idleColor
                            }`}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <span className="avp-bidi-num text-[10px] font-medium text-[var(--avp-text-muted)] w-[38px]">
              {peakDb <= -59 ? '-∞' : formatNumberForLocale(Math.round(peakDb), { persianDigits })} dB
            </span>
          </div>
        </div>

        {/* Zone 2 (Exact Geometric Center on sm+ / Full-width primary row on < sm, LOCKED dir="ltr") */}
        <div
          className="order-1 sm:order-2 w-full sm:w-auto flex items-center justify-center gap-1 sm:gap-0.5 justify-self-center px-2 py-1 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/75"
          dir="ltr"
        >
          <div className="hidden lg:inline-flex items-center gap-0.5 me-0.5 pe-1 border-e border-[var(--avp-border)]">
            <button
              type="button"
              data-testid="audition-btn-set-in"
              disabled={!hasAudio}
              onClick={onSetInAtPlayhead}
              title={isFa ? 'تنظیم شروع انتخاب (I)' : 'Set Selection In (I)'}
              className="avp-btn avp-btn-sm avp-btn-ghost px-1.5 font-mono text-[11px]"
            >
              I
            </button>
            <button
              type="button"
              data-testid="audition-btn-set-out"
              disabled={!hasAudio}
              onClick={onSetOutAtPlayhead}
              title={isFa ? 'تنظیم پایان انتخاب (O)' : 'Set Selection Out (O)'}
              className="avp-btn avp-btn-sm avp-btn-ghost px-1.5 font-mono text-[11px]"
            >
              O
            </button>
          </div>

          <button
            type="button"
            data-testid="audition-btn-rewind"
            disabled={!hasAudio}
            onClick={onStopAndReset}
            aria-label={isFa ? 'بازگشت به ابتدا' : 'Rewind to start'}
            title={isFa ? 'بازگشت به ابتدا (Home)' : 'Rewind (Home)'}
            className="avp-btn-icon avp-btn-icon-sm hidden sm:inline-flex"
          >
            <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>

          {onStepBack && (
            <button
              type="button"
              data-testid="audition-btn-step-back"
              disabled={!hasAudio}
              onClick={onStepBack}
              aria-label={isFa ? `${seekStepSec} ثانیه عقب` : `Back ${seekStepSec}s`}
              title={isFa ? `${seekStepSec} ثانیه عقب` : `Back ${seekStepSec}s`}
              className="avp-btn min-h-[36px] sm:min-h-0 sm:avp-btn-sm avp-btn-ghost px-2 font-mono text-[11px]"
            >
              <SkipBack className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span className="hidden xs:inline sm:inline">-{formatNumberForLocale(seekStepSec, { persianDigits })}s</span>
            </button>
          )}

          {/* Focal Play / Pause CTA */}
          <button
            type="button"
            data-testid="toolbar-btn-play-pause"
            disabled={!hasAudio}
            onClick={onTogglePlay}
            aria-label={
              isPlaying
                ? isFa
                  ? 'توقف پخش'
                  : 'Pause playback'
                : isFa
                  ? 'شروع پخش'
                  : 'Start playback'
            }
            title={isFa ? 'پخش / مکث (Space)' : 'Play / Pause (Space)'}
            className={`avp-btn h-[36px] sm:h-[var(--avp-ctrl-md)] min-w-[92px] sm:min-w-[86px] mx-0.5 sm:mx-1 ${
              isPlaying
                ? 'bg-[var(--avp-warning)] text-slate-950 hover:opacity-90'
                : 'avp-btn-primary'
            }`}
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                <span>{isFa ? 'توقف' : 'Pause'}</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                <span>{isFa ? 'پخش' : 'Play'}</span>
              </>
            )}
          </button>

          {onStepForward && (
            <button
              type="button"
              data-testid="audition-btn-step-forward"
              disabled={!hasAudio}
              onClick={onStepForward}
              aria-label={isFa ? `${seekStepSec} ثانیه جلو` : `Forward ${seekStepSec}s`}
              title={isFa ? `${seekStepSec} ثانیه جلو` : `Forward ${seekStepSec}s`}
              className="avp-btn min-h-[36px] sm:min-h-0 sm:avp-btn-sm avp-btn-ghost px-2 font-mono text-[11px]"
            >
              <span className="hidden xs:inline sm:inline">+{formatNumberForLocale(seekStepSec, { persianDigits })}s</span>
              <SkipForward className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            data-testid="audition-btn-stop"
            disabled={!hasAudio}
            onClick={onStopAndReset}
            aria-label={isFa ? 'توقف کامل' : 'Stop'}
            title={isFa ? 'توقف' : 'Stop'}
            className="avp-btn-icon avp-btn-icon-sm hidden sm:inline-flex"
          >
            <Square className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>

          <button
            type="button"
            data-testid="audition-btn-loop"
            disabled={!hasAudio}
            onClick={onToggleLoop}
            aria-pressed={loopSelection}
            title={
              selection
                ? isFa
                  ? 'تکرار محدوده انتخابی (L)'
                  : 'Loop Selection (L)'
                : isFa
                  ? 'تکرار کل فایل (L)'
                  : 'Loop Full Track (L)'
            }
            className={`avp-btn min-h-[36px] sm:min-h-0 sm:avp-btn-sm ms-0.5 ${loopSelection ? 'avp-btn-tonal' : 'avp-btn-ghost'}`}
          >
            <Repeat className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden md:inline">{isFa ? 'تکرار' : 'Loop'}</span>
          </button>
        </div>

        {/* Zone 3 (End — Selection Play + Marker Nav + Playback Rate) */}
        <div className="order-3 flex items-center justify-end gap-1.5 shrink-0 justify-self-end">
          {selection && selectionLenSec >= 0.05 && (
            <>
              <div
                data-testid="audition-selection-hud"
                dir="ltr"
                className="hidden 2xl:inline-flex items-center text-[11px] font-mono tabular-nums text-[var(--avp-warning-text)] font-medium whitespace-nowrap"
              >
                {formatNumberForLocale(selection.startSec, { persianDigits, maximumFractionDigits: 2 })}–
                {formatNumberForLocale(selection.endSec, { persianDigits, maximumFractionDigits: 2 })}s (Δ
                {formatNumberForLocale(selectionLenSec, { persianDigits, maximumFractionDigits: 2 })}s)
              </div>

              <button
                type="button"
                data-testid="audition-btn-play-selection"
                disabled={!hasAudio}
                onClick={onPlaySelection}
                title={isFa ? 'پخش محدوده انتخاب‌شده' : 'Play Selected Range'}
                className="hidden sm:inline-flex avp-btn avp-btn-sm avp-btn-tonal"
              >
                <Scissors className="w-3.5 h-3.5 text-[var(--avp-accent)]" strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden lg:inline">{isFa ? 'پخش انتخاب' : 'Range'}</span>
              </button>
            </>
          )}

          {/* Framed Marker Step & Playback Speed Utility Capsule */}
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/65">
            <div className="hidden lg:inline-flex items-center gap-0.5 pe-1 border-e border-[var(--avp-border)]" dir="ltr">
              <button
                type="button"
                disabled={!hasAudio}
                onClick={onJumpPrevMarker}
                aria-label={isFa ? 'نشانگر قبلی' : 'Previous marker'}
                title={isFa ? 'نشانگر قبلی' : 'Previous marker'}
                className="avp-btn-icon avp-btn-icon-sm"
              >
                <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={!hasAudio}
                onClick={onJumpNextMarker}
                aria-label={isFa ? 'نشانگر بعدی' : 'Next marker'}
                title={isFa ? 'نشانگر بعدی' : 'Next marker'}
                className="avp-btn-icon avp-btn-icon-sm"
              >
                <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>

            <label
              className="inline-flex items-center gap-1 text-xs text-[var(--avp-text-secondary)]"
              title={
                isFa
                  ? 'سرعت پخش (تغییر نرخ بازپخش بومی مرورگر؛ بدون الگوریتم جداگانه حفظ زیر و بمی)'
                  : 'Playback rate (native browser rate scaling without pitch-preserve DSP)'
              }
            >
              <Gauge className="w-3.5 h-3.5 text-[var(--avp-text-muted)] hidden sm:block ms-1" strokeWidth={1.75} aria-hidden="true" />
              <span className="sr-only">{isFa ? 'سرعت پخش' : 'Playback speed'}</span>
              <select
                data-testid="audition-playback-speed"
                aria-label={isFa ? 'سرعت پخش' : 'Playback speed'}
                value={playbackRate}
                onChange={(e) => onChangePlaybackRate(Number(e.target.value))}
                dir="ltr"
                className="avp-select font-mono tabular-nums border-0 bg-transparent h-[26px]"
              >
                {SPEED_OPTIONS.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate.toFixed(2).replace(/\.00$/, '.0')}x
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
    </footer>
  );
};
