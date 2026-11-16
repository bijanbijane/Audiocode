import React, { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, Lock, ZoomIn, ZoomOut } from 'lucide-react';
import {
  AudioAsset,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import { selectPeakLevel } from '../engine/peakPyramid';
import { flicksToSeconds, formatTimecode, secondsToFlicks } from '../engine/timebase';

interface WaveformCanvasProps {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  recommendations: SmartRecommendation[];
  selectedRecId: string | null;
  playheadSec: number;
  totalDurationSec: number;
  zoom: number;
  onZoomChange: (nextZoom: number) => void;
  onSeekSec: (sec: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onSelectRecommendation: (recId: string) => void;
  detectedSyncOffsetMs?: number;
  detectedClockDriftPpm?: number;
  onAutoAlignSyncedTracks?: () => void;
  onNudgeSyncedTracksMs?: (deltaMs: number) => void;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  tracks,
  assets,
  recommendations,
  selectedRecId,
  playheadSec,
  totalDurationSec,
  zoom,
  onZoomChange,
  onSeekSec,
  onToggleTrackMute,
  onToggleTrackSolo,
  onSelectRecommendation,
  detectedSyncOffsetMs = 0,
  detectedClockDriftPpm = 0,
  onAutoAlignSyncedTracks,
  onNudgeSyncedTracksMs,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const next = Math.max(320, el.clientWidth);
      setContainerWidth(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = containerWidth;
    const trackHeight = 96;
    const rulerHeight = 28;
    const height = rulerHeight + Math.max(1, tracks.length) * trackHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0E131D';
    ctx.fillRect(0, 0, width, height);

    const safeTotalSec = Math.max(0.5, totalDurationSec);
    const visibleSec = safeTotalSec / Math.max(1, zoom);
    const viewStartSec = Math.max(
      0,
      Math.min(safeTotalSec - visibleSec, playheadSec - visibleSec * 0.35),
    );
    const secToX = (sec: number) => ((sec - viewStartSec) / visibleSec) * width;

    // 1. Time Ruler
    ctx.fillStyle = '#131924';
    ctx.fillRect(0, 0, width, rulerHeight);
    ctx.strokeStyle = '#252F42';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerHeight);
    ctx.lineTo(width, rulerHeight);
    ctx.stroke();

    const tickStep = visibleSec <= 4 ? 0.5 : visibleSec <= 15 ? 1 : 2;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94A3B8';
    for (
      let t = Math.ceil(viewStartSec / tickStep) * tickStep;
      t <= viewStartSec + visibleSec;
      t += tickStep
    ) {
      const x = secToX(t);
      ctx.strokeStyle = '#252F42';
      ctx.beginPath();
      ctx.moveTo(x, rulerHeight - 6);
      ctx.lineTo(x, rulerHeight);
      ctx.stroke();
      ctx.fillText(`${t.toFixed(1)}s`, x + 4, 17);
    }

    // 2. Render Each Track & LOD Peak Pyramid
    tracks.forEach((track, tIdx) => {
      const top = rulerHeight + tIdx * trackHeight;
      const midY = top + trackHeight / 2;

      // Track lane divider
      ctx.fillStyle = tIdx % 2 === 0 ? '#0E131D' : '#111724';
      ctx.fillRect(0, top, width, trackHeight);

      ctx.strokeStyle = '#1E2738';
      ctx.beginPath();
      ctx.moveTo(0, top + trackHeight);
      ctx.lineTo(width, top + trackHeight);
      ctx.stroke();

      // Center zero-axis line
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();

      // Draw each non-destructive clip
      for (const clip of track.clips) {
        const clipStartSec = flicksToSeconds(clip.timelineRange.startFlicks);
        const clipEndSec = flicksToSeconds(clip.timelineRange.endFlicks);
        if (clipEndSec < viewStartSec || clipStartSec > viewStartSec + visibleSec) continue;

        const x0 = Math.max(0, secToX(clipStartSec));
        const x1 = Math.min(width, secToX(clipEndSec));
        const clipW = Math.max(1, x1 - x0);

        if (clip.kind === 'room-tone-fill') {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
          ctx.fillRect(x0, top + 8, clipW, trackHeight - 16);
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)';
          ctx.strokeRect(x0 + 0.5, top + 8.5, Math.max(1, clipW - 1), trackHeight - 17);
          ctx.fillStyle = '#34D399';
          ctx.font = '10px "Vazirmatn", sans-serif';
          if (clipW > 48) {
            ctx.fillText('Room Tone', x0 + 6, top + 22);
          }
          continue;
        }

        const asset = assets[clip.assetId];
        if (!asset) continue;
        const sr = asset.nativeSampleRate;
        const visibleSamples = visibleSec * sr;
        const samplesPerPixel = visibleSamples / width;
        const level = selectPeakLevel(asset.peakPyramid, samplesPerPixel);
        if (!level) continue;

        const sourceStartSec = flicksToSeconds(clip.sourceStartFlicks);
        const barColor = track.muted
          ? 'rgba(100, 116, 139, 0.45)'
          : tIdx === 0
            ? '#38BDF8'
            : '#A78BFA';
        const rmsColor = track.muted
          ? 'rgba(100, 116, 139, 0.25)'
          : tIdx === 0
            ? 'rgba(14, 165, 233, 0.32)'
            : 'rgba(139, 92, 246, 0.32)';

        const amp = (trackHeight - 20) * 0.5;
        const pxStart = Math.floor(x0);
        const pxEnd = Math.ceil(x1);

        for (let px = pxStart; px < pxEnd; px++) {
          const pxSec = viewStartSec + (px / width) * visibleSec;
          const srcSec = sourceStartSec + (pxSec - clipStartSec);
          const samplePos = srcSec * sr;
          const binIdx = Math.floor(samplePos / level.samplesPerBin);
          if (binIdx < 0 || binIdx >= level.max.length) continue;

          const maxV = level.max[binIdx];
          const minV = level.min[binIdx];
          const rmsV = level.rms[binIdx];

          const yTop = midY - maxV * amp;
          const yBot = midY - minV * amp;
          ctx.fillStyle = barColor;
          ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));

          const rmsH = rmsV * amp;
          ctx.fillStyle = rmsColor;
          ctx.fillRect(px, midY - rmsH, 1, Math.max(1, rmsH * 2));
        }
      }

      // 3. Draw Pending Smart Recommendation Overlays on this Track
      for (const rec of recommendations) {
        if (rec.trackId !== track.id || rec.status !== 'Pending') continue;
        const rStart = flicksToSeconds(rec.range.startFlicks);
        const rEnd = flicksToSeconds(rec.range.endFlicks);
        const rx0 = secToX(rStart);
        const rx1 = secToX(rEnd);
        if (rx1 < 0 || rx0 > width) continue;

        const isSelected = rec.id === selectedRecId;
        const isWarning = rec.boundary.trailingEzafeRisk;
        ctx.fillStyle = isWarning
          ? 'rgba(244, 63, 94, 0.22)'
          : isSelected
            ? 'rgba(245, 158, 11, 0.28)'
            : 'rgba(245, 158, 11, 0.14)';
        ctx.fillRect(rx0, top + 4, Math.max(2, rx1 - rx0), trackHeight - 8);

        ctx.strokeStyle = isWarning ? '#F43F5E' : '#F59E0B';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(rx0, top + 4, Math.max(2, rx1 - rx0), trackHeight - 8);
      }

      // 3b. Visual Sync Offset Indicator on secondary synced track
      if (tIdx > 0 && track.syncGroupId && Math.abs(detectedSyncOffsetMs) > 0.1) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
        ctx.fillRect(8, top + 6, 148, 20);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1;
        ctx.strokeRect(8, top + 6, 148, 20);
        ctx.fillStyle = '#FCD34D';
        ctx.font = '11px "JetBrains Mono", monospace';
        const sign = detectedSyncOffsetMs > 0 ? '+' : '';
        ctx.fillText(`Δ Sync: ${sign}${detectedSyncOffsetMs.toFixed(1)}ms`, 14, top + 20);
      }
    });

    // 4. Playhead Cursor
    const playX = secToX(playheadSec);
    if (playX >= 0 && playX <= width) {
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();

      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.moveTo(playX - 6, 0);
      ctx.lineTo(playX + 6, 0);
      ctx.lineTo(playX, 10);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }, [tracks, assets, recommendations, selectedRecId, playheadSec, totalDurationSec, zoom, containerWidth, detectedSyncOffsetMs]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const safeTotalSec = Math.max(0.5, totalDurationSec);
    const visibleSec = safeTotalSec / Math.max(1, zoom);
    const viewStartSec = Math.max(
      0,
      Math.min(safeTotalSec - visibleSec, playheadSec - visibleSec * 0.35),
    );
    const clickedSec = Math.max(0, Math.min(safeTotalSec, viewStartSec + (x / rect.width) * visibleSec));

    // Check if user clicked inside a pending recommendation on that track lane
    const y = e.clientY - rect.top - 28;
    const trackIdx = Math.floor(y / 96);
    const clickedTrack = tracks[trackIdx];
    if (clickedTrack) {
      const clickedFlicks = secondsToFlicks(clickedSec);
      const hitRec = recommendations.find(
        (r) =>
          r.trackId === clickedTrack.id &&
          r.status === 'Pending' &&
          clickedFlicks >= r.range.startFlicks &&
          clickedFlicks <= r.range.endFlicks,
      );
      if (hitRec) {
        onSelectRecommendation(hitRec.id);
      }
    }

    onSeekSec(clickedSec);
  };

  const hasDetectedDrift = Math.abs(detectedSyncOffsetMs) > 0.1 || Math.abs(detectedClockDriftPpm) > 1.0;

  return (
    <section
      aria-label="نوار زمان و شکل‌موج چندترک"
      className="border border-[#252F42] bg-[#131924] rounded-lg overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-[#252F42] bg-[#161D2A]">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <span className="font-semibold text-slate-100">تایم‌لاین غیرمخرب چندترک</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="inline-flex items-center gap-1 text-emerald-400">
            <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            <span>قفل همگام‌سازی ترک‌ها فعال (Sync-Lock)</span>
          </span>
        </div>

        {/* Sync Drift / Temporal Offset Detection & Instant Nudge / Align Controls */}
        <div
          data-testid="waveform-sync-drift-bar"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <span
            data-testid="waveform-sync-drift-status"
            className={`px-2.5 py-1 rounded border font-medium tabular-nums ${
              hasDetectedDrift
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
            }`}
          >
            {hasDetectedDrift ? (
              <>
                <span>انحراف زمانی شناسایی‌شده: </span>
                <span dir="ltr" className="font-mono font-semibold">
                  {detectedSyncOffsetMs >= 0 ? '+' : ''}
                  {detectedSyncOffsetMs.toFixed(1)} ms
                </span>
                {Math.abs(detectedClockDriftPpm) > 0.5 && (
                  <>
                    <span className="mx-1.5 text-amber-500/60">·</span>
                    <span>دریفت کلاک: </span>
                    <span dir="ltr" className="font-mono">
                      {detectedClockDriftPpm >= 0 ? '+' : ''}
                      {detectedClockDriftPpm.toFixed(1)} ppm
                    </span>
                  </>
                )}
              </>
            ) : (
              <span>هم‌تراز شده: ۰.۰ ms (سینک دقیق زیر-میلی‌ثانیه)</span>
            )}
          </span>

          {onNudgeSyncedTracksMs && (
            <div className="inline-flex items-center gap-1" role="group" aria-label="جابجایی دقیق زمانی ترک همگام">
              <button
                type="button"
                data-testid="btn-nudge-sync-minus"
                onClick={() => onNudgeSyncedTracksMs(-5)}
                title="جابجایی ۵- میلی‌ثانیه (Nudge -5ms)"
                className="px-2 py-1 rounded border border-[#252F42] bg-[#0E131D] hover:bg-[#1E2738] text-slate-200 font-mono text-[11px] cursor-pointer"
              >
                <span dir="ltr">-5ms</span>
              </button>
              <button
                type="button"
                data-testid="btn-nudge-sync-plus"
                onClick={() => onNudgeSyncedTracksMs(5)}
                title="جابجایی ۵+ میلی‌ثانیه (Nudge +5ms)"
                className="px-2 py-1 rounded border border-[#252F42] bg-[#0E131D] hover:bg-[#1E2738] text-slate-200 font-mono text-[11px] cursor-pointer"
              >
                <span dir="ltr">+5ms</span>
              </button>
            </div>
          )}

          {onAutoAlignSyncedTracks && (
            <button
              type="button"
              data-testid="btn-auto-align-sync"
              disabled={!hasDetectedDrift}
              onClick={onAutoAlignSyncedTracks}
              className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold text-xs cursor-pointer disabled:cursor-not-allowed transition-colors"
            >
              اصلاح آنی و هم‌ترازسازی (Align)
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onZoomChange(Math.max(1, zoom / 1.5))}
            aria-label="کوچک‌نمایی شکل‌موج"
            className="p-1.5 rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-mono text-slate-400 min-w-[44px] text-center">
            {zoom.toFixed(1)}x
          </span>
          <button
            type="button"
            onClick={() => onZoomChange(Math.min(8, zoom * 1.5))}
            aria-label="بزرگ‌نمایی شکل‌موج"
            className="p-1.5 rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr]">
        {/* Track Headers */}
        <div className="border-b lg:border-b-0 lg:border-l border-[#252F42] bg-[#111722] flex flex-col">
          <div className="h-[28px] px-3 flex items-center text-[11px] text-slate-500 border-b border-[#252F42] font-mono">
            {formatTimecode(secondsToFlicks(playheadSec))}
          </div>
          {tracks.map((track, idx) => (
            <div
              key={track.id}
              className="h-[96px] px-3 py-2.5 border-b border-[#1E2738] last:border-b-0 flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100 truncate">
                  {track.name}
                </span>
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    idx === 0 ? 'bg-sky-400' : 'bg-violet-400'
                  }`}
                  aria-hidden="true"
                />
              </div>
              <div className="text-[11px] text-slate-400">
                <span>گوینده: {track.speakerLabel}</span>
                {track.syncGroupId && (
                  <>
                    <span className="mx-1 text-slate-600">·</span>
                    <span className="text-emerald-400">همگام</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onToggleTrackMute(track.id)}
                  aria-label={`قطع صدای ${track.name}`}
                  aria-pressed={track.muted}
                  className={`px-2 py-0.5 text-[11px] rounded border cursor-pointer transition-colors ${
                    track.muted
                      ? 'bg-rose-500/20 border-rose-500/50 text-rose-300'
                      : 'bg-[#182030] border-[#252F42] text-slate-300 hover:bg-[#1E2738]'
                  }`}
                >
                  {track.muted ? <VolumeX className="w-3 h-3 inline" /> : <Volume2 className="w-3 h-3 inline" />}
                  <span className="mr-1">M</span>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleTrackSolo(track.id)}
                  aria-label={`تک‌صدایی ${track.name}`}
                  aria-pressed={track.solo}
                  className={`px-2 py-0.5 text-[11px] rounded border cursor-pointer transition-colors ${
                    track.solo
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      : 'bg-[#182030] border-[#252F42] text-slate-300 hover:bg-[#1E2738]'
                  }`}
                >
                  S
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Interactive High-DPI LOD Canvas */}
        <div ref={containerRef} className="w-full overflow-hidden select-none" dir="ltr">
          <canvas
            ref={canvasRef}
            data-testid="waveform-canvas"
            onClick={handleCanvasClick}
            className="block w-full cursor-crosshair"
          />
        </div>
      </div>
    </section>
  );
};
