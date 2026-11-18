import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Lock,
  Maximize2,
  Play,
  Scissors,
  SplitSquareVertical,
  Volume2,
  VolumeX,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  AudioAsset,
  FlickRange,
  RecommendationActionMode,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import { selectPeakLevel } from '../engine/peakPyramid';
import { flicksToSeconds, formatTimecode, secondsToFlicks } from '../engine/timebase';
import type { WaveformSelectionState } from './AuditionTransportBar';

interface WaveformCanvasProps {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
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
  onSplitAtPlayhead?: () => void;
  onCutWaveformRange?: (
    range: FlickRange,
    targetTrackId: string,
    mode: RecommendationActionMode,
  ) => void;
  detectedSyncOffsetMs?: number;
  detectedClockDriftPpm?: number;
  onAutoAlignSyncedTracks?: () => void;
  onNudgeSyncedTracksMs?: (deltaMs: number) => void;
  selection?: WaveformSelectionState | null;
  onSelectionChange?: (next: WaveformSelectionState | null) => void;
  onPlaySelectionRange?: (sel: WaveformSelectionState) => void;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  tracks,
  assets,
  pcmSources,
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
  onSplitAtPlayhead,
  onCutWaveformRange,
  detectedSyncOffsetMs = 0,
  detectedClockDriftPpm = 0,
  onAutoAlignSyncedTracks,
  onNudgeSyncedTracksMs,
  selection: controlledSelection,
  onSelectionChange,
  onPlaySelectionRange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const [viewMode, setViewMode] = useState<'waveform' | 'spectral'>('waveform');
  const [internalSelection, setInternalSelection] = useState<WaveformSelectionState | null>(null);
  const [selectionScope, setSelectionScope] = useState<'track' | 'all'>('all');

  const selectedRangeSec =
    controlledSelection !== undefined ? controlledSelection : internalSelection;

  const setSelectedRangeSec = (next: WaveformSelectionState | null) => {
    if (onSelectionChange) onSelectionChange(next);
    if (controlledSelection === undefined) setInternalSelection(next);
  };

  type DragMode =
    | { kind: 'new'; sec: number; trackId: string }
    | { kind: 'resize-start'; fixedEndSec: number; trackId: string }
    | { kind: 'resize-end'; fixedStartSec: number; trackId: string };
  const dragModeRef = useRef<DragMode | null>(null);

  const totalClipsCount = tracks.reduce((acc, t) => acc + t.clips.length, 0);

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
    const trackHeight = 104;
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

    // Adobe Audition Charcoal Canvas Background
    ctx.fillStyle = '#14161B';
    ctx.fillRect(0, 0, width, height);

    const safeTotalSec = Math.max(0.5, totalDurationSec);
    const visibleSec = safeTotalSec / Math.max(1, zoom);
    const viewStartSec = Math.max(
      0,
      Math.min(safeTotalSec - visibleSec, playheadSec - visibleSec * 0.35),
    );
    const secToX = (sec: number) => ((sec - viewStartSec) / visibleSec) * width;

    // 1. Time Ruler
    ctx.fillStyle = '#1A1D24';
    ctx.fillRect(0, 0, width, rulerHeight);
    ctx.strokeStyle = '#2B303C';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerHeight);
    ctx.lineTo(width, rulerHeight);
    ctx.stroke();

    const tickStep = visibleSec <= 4 ? 0.5 : visibleSec <= 15 ? 1 : 2;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#9CA3AF';
    for (
      let t = Math.ceil(viewStartSec / tickStep) * tickStep;
      t <= viewStartSec + visibleSec;
      t += tickStep
    ) {
      const x = secToX(t);
      ctx.strokeStyle = '#313746';
      ctx.beginPath();
      ctx.moveTo(x, rulerHeight - 7);
      ctx.lineTo(x, rulerHeight);
      ctx.stroke();
      ctx.fillText(`${t.toFixed(1)}s`, x + 4, 17);
    }

    // 2. Render Each Track (Waveform OR Spectral Frequency Heatmap)
    tracks.forEach((track, tIdx) => {
      const top = rulerHeight + tIdx * trackHeight;
      const midY = top + trackHeight / 2;

      ctx.fillStyle = tIdx % 2 === 0 ? '#14161B' : '#181B22';
      ctx.fillRect(0, top, width, trackHeight);

      ctx.strokeStyle = '#252A36';
      ctx.beginPath();
      ctx.moveTo(0, top + trackHeight);
      ctx.lineTo(width, top + trackHeight);
      ctx.stroke();

      // Horizontal dB / center reference grid lines
      ctx.strokeStyle = 'rgba(156, 163, 175, 0.14)';
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();

      for (const clip of track.clips) {
        const clipStartSec = flicksToSeconds(clip.timelineRange.startFlicks);
        const clipEndSec = flicksToSeconds(clip.timelineRange.endFlicks);
        if (clipEndSec < viewStartSec || clipStartSec > viewStartSec + visibleSec) continue;

        const x0 = Math.max(0, secToX(clipStartSec));
        const x1 = Math.min(width, secToX(clipEndSec));
        const clipW = Math.max(1, x1 - x0);

        if (clip.kind === 'room-tone-fill') {
          ctx.fillStyle = 'rgba(46, 229, 157, 0.12)';
          ctx.fillRect(x0, top + 8, clipW, trackHeight - 16);
          ctx.strokeStyle = 'rgba(46, 229, 157, 0.55)';
          ctx.strokeRect(x0 + 0.5, top + 8.5, Math.max(1, clipW - 1), trackHeight - 17);
          ctx.fillStyle = '#2EE59D';
          ctx.font = '10px "Vazirmatn", sans-serif';
          if (clipW > 48) {
            ctx.fillText('Room Tone', x0 + 6, top + 22);
          }
          continue;
        }

        if (clipStartSec > 0.02 && x0 > 1 && x0 < width - 1) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, top + 6);
          ctx.lineTo(x0, top + trackHeight - 6);
          ctx.stroke();
        }

        const asset = assets[clip.assetId];
        if (!asset) continue;
        const sr = asset.nativeSampleRate;
        const visibleSamples = visibleSec * sr;
        const samplesPerPixel = visibleSamples / width;
        const level = selectPeakLevel(asset.peakPyramid, samplesPerPixel);
        if (!level) continue;

        const sourceStartSec = flicksToSeconds(clip.sourceStartFlicks);
        const pcm = pcmSources?.[clip.assetId];
        const barColor = track.muted
          ? 'rgba(100, 116, 139, 0.45)'
          : tIdx === 0
            ? '#2EE59D'
            : '#38BDF8';
        const rmsColor = track.muted
          ? 'rgba(100, 116, 139, 0.25)'
          : tIdx === 0
            ? 'rgba(46, 229, 157, 0.30)'
            : 'rgba(56, 189, 248, 0.28)';

        const amp = (trackHeight - 20) * 0.5;
        const pxStart = Math.floor(x0);
        const pxEnd = Math.ceil(x1);

        if (viewMode === 'spectral' && pcm) {
          // Adobe Audition Spectral Frequency Heatmap (8 frequency bands per pixel column)
          const bands = 8;
          const bandH = (trackHeight - 12) / bands;
          const colStep = 3;
          for (let px = pxStart; px < pxEnd; px += colStep) {
            const pxSec = viewStartSec + (px / width) * visibleSec;
            const srcSec = sourceStartSec + (pxSec - clipStartSec);
            const centerSample = Math.floor(srcSec * sr);
            const win = 128;
            if (centerSample < 0 || centerSample + win >= pcm.length) continue;

            for (let b = 0; b < bands; b++) {
              // Goertzel-like 2-point band energy proxy across low->high frequencies
              const hz = 160 * Math.pow(6400 / 160, b / (bands - 1));
              const w = (2 * Math.PI * hz) / sr;
              let re = 0;
              let im = 0;
              for (let n = 0; n < win; n += 2) {
                const s = pcm[centerSample + n];
                re += s * Math.cos(w * n);
                im += s * Math.sin(w * n);
              }
              const mag = Math.min(1, Math.log1p(Math.sqrt(re * re + im * im) * 0.8) / 2.6);
              const hue = mag > 0.65 ? `rgba(251, 191, 36, ${0.2 + mag * 0.78})` : mag > 0.35 ? `rgba(244, 63, 94, ${0.15 + mag * 0.7})` : `rgba(56, 189, 248, ${0.08 + mag * 0.55})`;
              ctx.fillStyle = hue;
              const bandY = top + trackHeight - 6 - (b + 1) * bandH;
              ctx.fillRect(px, bandY, colStep, bandH - 0.5);
            }
          }
        } else {
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

      // 3b. Adobe Audition Selection Overlay with Bright Trim Handles
      if (
        selectedRangeSec &&
        (selectedRangeSec.scope === 'all' || selectedRangeSec.trackId === track.id)
      ) {
        const sx0 = secToX(selectedRangeSec.startSec);
        const sx1 = secToX(selectedRangeSec.endSec);
        if (sx1 >= 0 && sx0 <= width) {
          ctx.fillStyle = 'rgba(226, 232, 240, 0.17)';
          ctx.fillRect(sx0, top + 1, Math.max(2, sx1 - sx0), trackHeight - 2);
          ctx.strokeStyle = '#E2E8F0';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx0, top + 1, Math.max(2, sx1 - sx0), trackHeight - 2);

          // Left '[' & Right ']' trim bracket handles
          ctx.fillStyle = '#38BDF8';
          ctx.fillRect(sx0 - 2, top + 2, 4, trackHeight - 4);
          ctx.fillRect(sx1 - 2, top + 2, 4, trackHeight - 4);
        }
      }

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
  }, [
    tracks,
    assets,
    pcmSources,
    recommendations,
    selectedRecId,
    playheadSec,
    totalDurationSec,
    zoom,
    containerWidth,
    detectedSyncOffsetMs,
    selectedRangeSec,
    viewMode,
  ]);

  const clientXToTimelineSec = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const safeTotalSec = Math.max(0.5, totalDurationSec);
    const visibleSec = safeTotalSec / Math.max(1, zoom);
    const viewStartSec = Math.max(
      0,
      Math.min(safeTotalSec - visibleSec, playheadSec - visibleSec * 0.35),
    );
    return Math.max(0, Math.min(safeTotalSec, viewStartSec + (x / rect.width) * visibleSec));
  };

  const clientYToTrackId = (clientY: number): string => {
    const canvas = canvasRef.current;
    if (!canvas) return tracks[0]?.id ?? 'track-host';
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top - 28;
    const trackIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor(y / 104)));
    return tracks[trackIdx]?.id ?? tracks[0]?.id ?? 'track-host';
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sec = clientXToTimelineSec(e.clientX);
    const trackId = clientYToTrackId(e.clientY);

    // Check if user grabbed left/right trim edge handle of current selection
    if (selectedRangeSec) {
      const safeTotal = Math.max(0.5, totalDurationSec);
      const handleToleranceSec = Math.max(0.06, (safeTotal / Math.max(1, zoom)) * 0.014);
      if (Math.abs(sec - selectedRangeSec.startSec) <= handleToleranceSec) {
        dragModeRef.current = {
          kind: 'resize-start',
          fixedEndSec: selectedRangeSec.endSec,
          trackId: selectedRangeSec.trackId,
        };
        return;
      }
      if (Math.abs(sec - selectedRangeSec.endSec) <= handleToleranceSec) {
        dragModeRef.current = {
          kind: 'resize-end',
          fixedStartSec: selectedRangeSec.startSec,
          trackId: selectedRangeSec.trackId,
        };
        return;
      }
    }

    dragModeRef.current = { kind: 'new', sec, trackId };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mode = dragModeRef.current;
    if (!mode) return;
    const curSec = clientXToTimelineSec(e.clientX);

    if (mode.kind === 'resize-start') {
      const startSec = Math.max(0, Math.min(mode.fixedEndSec - 0.05, curSec));
      setSelectedRangeSec({
        startSec,
        endSec: mode.fixedEndSec,
        trackId: mode.trackId,
        scope: selectionScope,
      });
      return;
    }

    if (mode.kind === 'resize-end') {
      const endSec = Math.min(totalDurationSec, Math.max(mode.fixedStartSec + 0.05, curSec));
      setSelectedRangeSec({
        startSec: mode.fixedStartSec,
        endSec,
        trackId: mode.trackId,
        scope: selectionScope,
      });
      return;
    }

    const delta = Math.abs(curSec - mode.sec);
    if (delta >= 0.06) {
      setSelectedRangeSec({
        startSec: Math.min(mode.sec, curSec),
        endSec: Math.max(mode.sec, curSec),
        trackId: mode.trackId,
        scope: selectionScope,
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mode = dragModeRef.current;
    dragModeRef.current = null;
    const clickedSec = clientXToTimelineSec(e.clientX);

    if (mode && (mode.kind === 'resize-start' || mode.kind === 'resize-end')) {
      return;
    }

    if (mode && mode.kind === 'new' && Math.abs(clickedSec - mode.sec) >= 0.06) {
      const lo = Math.min(mode.sec, clickedSec);
      const hi = Math.max(mode.sec, clickedSec);
      setSelectedRangeSec({
        startSec: lo,
        endSec: hi,
        trackId: mode.trackId,
        scope: selectionScope,
      });
      onSeekSec(lo);
      return;
    }

    const clickedTrackId = clientYToTrackId(e.clientY);
    const clickedFlicks = secondsToFlicks(clickedSec);
    const hitRec = recommendations.find(
      (r) =>
        r.trackId === clickedTrackId &&
        r.status === 'Pending' &&
        clickedFlicks >= r.range.startFlicks &&
        clickedFlicks <= r.range.endFlicks,
    );
    if (hitRec) {
      onSelectRecommendation(hitRec.id);
    }

    onSeekSec(clickedSec);
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const clickedSec = clientXToTimelineSec(e.clientX);
    const trackId = clientYToTrackId(e.clientY);
    const trk = tracks.find((t) => t.id === trackId);
    if (!trk) return;
    const clickedFlicks = secondsToFlicks(clickedSec);
    const hitClip = trk.clips.find(
      (c) => clickedFlicks >= c.timelineRange.startFlicks && clickedFlicks <= c.timelineRange.endFlicks,
    );
    if (hitClip) {
      const s = flicksToSeconds(hitClip.timelineRange.startFlicks);
      const en = flicksToSeconds(hitClip.timelineRange.endFlicks);
      setSelectedRangeSec({
        startSec: Number(s.toFixed(2)),
        endSec: Number(en.toFixed(2)),
        trackId: trk.id,
        scope: selectionScope,
      });
    }
  };

  const handleSelectWindowAroundPlayhead = () => {
    const safeTotal = Math.max(0.5, totalDurationSec);
    const center = Math.min(safeTotal - 0.25, Math.max(0.25, playheadSec || 1.2));
    const startSec = Math.max(0, center - 0.35);
    const endSec = Math.min(safeTotal, center + 0.35);
    setSelectedRangeSec({
      startSec: Number(startSec.toFixed(2)),
      endSec: Number(endSec.toFixed(2)),
      trackId: tracks[0]?.id ?? 'track-host',
      scope: selectionScope,
    });
  };

  const handleExecuteWaveformRangeCut = (mode: RecommendationActionMode) => {
    if (!selectedRangeSec || !onCutWaveformRange) return;
    onCutWaveformRange(
      {
        startFlicks: secondsToFlicks(selectedRangeSec.startSec),
        endFlicks: secondsToFlicks(selectedRangeSec.endSec),
      },
      selectedRangeSec.trackId,
      mode,
    );
    setSelectedRangeSec(null);
  };

  const handleZoomToSelection = () => {
    if (!selectedRangeSec) return;
    const len = Math.max(0.25, selectedRangeSec.endSec - selectedRangeSec.startSec);
    const nextZoom = Math.max(1, Math.min(8, totalDurationSec / (len * 1.4)));
    onSeekSec(selectedRangeSec.startSec + len * 0.35);
    onZoomChange(nextZoom);
  };

  const hasDetectedDrift =
    Math.abs(detectedSyncOffsetMs) > 0.1 || Math.abs(detectedClockDriftPpm) > 1.0;

  return (
    <section
      aria-label="نوار زمان و شکل‌موج چندترک ادیشن"
      className="border border-[#2A2F3B] bg-[#16181D] rounded-lg overflow-hidden"
    >
      {/* Adobe Audition Studio Editor Ribbon */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-[#2A2F3B] bg-[#1D2028]">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <span className="font-semibold text-slate-100 whitespace-nowrap">ویرایشگر چندترک ادیشن</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="inline-flex items-center gap-1 text-[#2EE59D] whitespace-nowrap">
            <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            <span>قفل همگام‌سازی ترک‌ها (Sync-Lock)</span>
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span data-testid="waveform-clips-count" className="font-mono tabular-nums text-slate-400 whitespace-nowrap">
            {totalClipsCount} کلیپ صوتی
          </span>
        </div>

        {/* Direct Editing, Spectral View & Selection Tools */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Audition Waveform / Spectral Display Toggle */}
          <button
            type="button"
            data-testid="btn-toggle-spectral-view"
            onClick={() => setViewMode((m) => (m === 'waveform' ? 'spectral' : 'waveform'))}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-medium whitespace-nowrap cursor-pointer ${
              viewMode === 'spectral'
                ? 'border-amber-400/60 bg-amber-400/20 text-amber-200'
                : 'border-[#2D323E] bg-[#14161B] hover:bg-[#232732] text-slate-200'
            }`}
          >
            {viewMode === 'spectral' ? (
              <Waves className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
            ) : (
              <Activity className="w-3.5 h-3.5 text-[#2EE59D]" aria-hidden="true" />
            )}
            <span>{viewMode === 'spectral' ? 'طیف فرکانسی (Spectral)' : 'نمایش شکل‌موج'}</span>
          </button>

          <button
            type="button"
            data-testid="btn-toggle-selection-scope"
            onClick={() => {
              const nextScope = selectionScope === 'all' ? 'track' : 'all';
              setSelectionScope(nextScope);
              if (selectedRangeSec) {
                setSelectedRangeSec({ ...selectedRangeSec, scope: nextScope });
              }
            }}
            className="px-2.5 py-1 rounded border border-[#2D323E] bg-[#14161B] hover:bg-[#232732] text-slate-200 font-medium whitespace-nowrap cursor-pointer"
          >
            محدوده: {selectionScope === 'all' ? 'همه ترک‌ها' : 'فقط ترک فعال'}
          </button>

          {onSplitAtPlayhead && (
            <button
              type="button"
              data-testid="btn-split-at-playhead"
              onClick={onSplitAtPlayhead}
              title="برش غیرمخرب کلیپ در محل مکان‌نما با Micro-Crossfade 10ms"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#2D323E] bg-[#14161B] hover:bg-[#232732] text-slate-200 font-medium whitespace-nowrap cursor-pointer"
            >
              <SplitSquareVertical className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>برش در مکان‌نما (Split)</span>
            </button>
          )}

          <button
            type="button"
            data-testid="btn-select-playhead-window"
            onClick={handleSelectWindowAroundPlayhead}
            title="انتخاب بازه ۰.۷ ثانیه‌ای اطراف مکان‌نما برای برش یا پخش انتخابی"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#2D323E] bg-[#14161B] hover:bg-[#232732] text-slate-200 font-medium whitespace-nowrap cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <span>انتخاب بازه برش</span>
          </button>

          {selectedRangeSec && (
            <div
              data-testid="waveform-range-action-bar"
              className="inline-flex flex-wrap items-center gap-1.5 px-2 py-0.5 rounded border border-sky-500/40 bg-sky-500/15"
            >
              <span dir="ltr" className="font-mono tabular-nums text-[11px] text-sky-200">
                [{selectedRangeSec.startSec.toFixed(2)}s .. {selectedRangeSec.endSec.toFixed(2)}s · Δ{' '}
                {(selectedRangeSec.endSec - selectedRangeSec.startSec).toFixed(2)}s]
              </span>

              {onPlaySelectionRange && (
                <button
                  type="button"
                  data-testid="btn-play-waveform-selection"
                  onClick={() => onPlaySelectionRange(selectedRangeSec)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#2EE59D] text-slate-950 font-semibold text-[11px] hover:bg-[#52EEB0] cursor-pointer"
                >
                  <Play className="w-3 h-3" aria-hidden="true" />
                  <span>پخش بازه</span>
                </button>
              )}

              <button
                type="button"
                data-testid="btn-zoom-to-selection"
                onClick={handleZoomToSelection}
                title="بزرگ‌نمایی روی بازه انتخابی"
                className="p-1 rounded bg-[#14161B] text-sky-200 hover:bg-[#232732] cursor-pointer"
              >
                <Maximize2 className="w-3 h-3" />
              </button>

              <button
                type="button"
                data-testid="btn-waveform-ripple-cut"
                onClick={() => handleExecuteWaveformRangeCut('sync-locked-ripple-cut')}
                className="px-2 py-0.5 rounded bg-amber-400 text-slate-950 font-semibold text-[11px] hover:bg-amber-300 cursor-pointer"
              >
                حذف بازه (Ripple)
              </button>
              <button
                type="button"
                data-testid="btn-waveform-roomtone-cut"
                onClick={() => handleExecuteWaveformRangeCut('in-place-room-tone-suppression')}
                className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 font-medium text-[11px] hover:bg-emerald-500/30 cursor-pointer"
              >
                Room Tone درجا
              </button>
              <button
                type="button"
                data-testid="btn-clear-waveform-selection"
                onClick={() => setSelectedRangeSec(null)}
                aria-label="لغو انتخاب بازه موج صوت"
                className="p-0.5 text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Sync Drift / Temporal Offset Detection & Zoom */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
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
                <span>هم‌تراز شده: ۰.۰ ms</span>
              )}
            </span>

            {onNudgeSyncedTracksMs && (
              <div
                className="inline-flex items-center gap-1"
                role="group"
                aria-label="جابجایی دقیق زمانی ترک همگام"
              >
                <button
                  type="button"
                  data-testid="btn-nudge-sync-minus"
                  onClick={() => onNudgeSyncedTracksMs(-5)}
                  className="px-2 py-1 rounded border border-[#2D323E] bg-[#14161B] hover:bg-[#232732] text-slate-200 font-mono text-[11px] cursor-pointer"
                >
                  <span dir="ltr">-5ms</span>
                </button>
                <button
                  type="button"
                  data-testid="btn-nudge-sync-plus"
                  onClick={() => onNudgeSyncedTracksMs(5)}
                  className="px-2 py-1 rounded border border-[#2D323E] bg-[#14161B] hover:bg-[#232732] text-slate-200 font-mono text-[11px] cursor-pointer"
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
                هم‌ترازسازی (Align)
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onZoomChange(Math.max(1, zoom / 1.5))}
              aria-label="کوچک‌نمایی شکل‌موج"
              className="p-1.5 rounded border border-[#2D323E] text-slate-300 hover:bg-[#232732] cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-400 min-w-[44px] text-center">
              {zoom.toFixed(1)}x
            </span>
            <button
              type="button"
              onClick={() => onZoomChange(Math.min(8, zoom * 1.5))}
              aria-label="بزرگ‌نمایی شکل‌موج"
              className="p-1.5 rounded border border-[#2D323E] text-slate-300 hover:bg-[#232732] cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Track Headers + Interactive Audition Waveform/Spectral Canvas */}
      <div className="grid grid-cols-1 lg:grid-cols-[210px_1fr]">
        <div className="border-b lg:border-b-0 lg:border-l border-[#2A2F3B] bg-[#191C23] flex flex-col">
          <div className="h-[28px] px-3 flex items-center text-[11px] text-[#2EE59D] border-b border-[#2A2F3B] font-mono tabular-nums">
            {formatTimecode(secondsToFlicks(playheadSec))}
          </div>
          {tracks.map((track) => (
            <div
              key={track.id}
              className="h-[104px] px-3 py-2.5 border-b border-[#252A36] last:border-b-0 flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100 truncate">{track.name}</span>
                <span className="text-[10px] font-mono text-slate-500 shrink-0">
                  {track.syncGroupId ? 'SYNC' : 'TRK'}
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                <span>گوینده: {track.speakerLabel}</span>
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
                      : 'bg-[#14161B] border-[#2D323E] text-slate-300 hover:bg-[#232732]'
                  }`}
                >
                  {track.muted ? (
                    <VolumeX className="w-3 h-3 inline" />
                  ) : (
                    <Volume2 className="w-3 h-3 inline" />
                  )}
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
                      : 'bg-[#14161B] border-[#2D323E] text-slate-300 hover:bg-[#232732]'
                  }`}
                >
                  S
                </button>
              </div>
            </div>
          ))}
        </div>

        <div ref={containerRef} className="w-full overflow-hidden select-none" dir="ltr">
          <canvas
            ref={canvasRef}
            data-testid="waveform-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            className="block w-full cursor-crosshair"
          />
        </div>
      </div>
    </section>
  );
};
