import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookmarkPlus,
  Lock,
  Maximize2,
  Minimize2,
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

export interface TimelineMarkerItem {
  id: string;
  label: string;
  startSec: number;
}

interface WaveformCanvasProps {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  recommendations: SmartRecommendation[];
  selectedRecId: string | null;
  playheadSec: number;
  totalDurationSec: number;
  zoom: number;
  locale?: 'fa' | 'en';
  showGrid?: boolean;
  showRuler?: boolean;
  showMarkers?: boolean;
  showEditRegions?: boolean;
  markers?: TimelineMarkerItem[];
  onZoomChange: (nextZoom: number) => void;
  onSeekSec: (sec: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onSelectRecommendation: (recId: string) => void;
  onAddMarkerAtPlayhead?: () => void;
  onSplitAtPlayhead?: () => void;
  onCutWaveformRange?: (
    range: FlickRange,
    targetTrackId: string,
    mode: RecommendationActionMode,
    scope?: 'track' | 'all',
  ) => boolean | void;
  detectedSyncOffsetMs?: number;
  detectedClockDriftPpm?: number;
  onAutoAlignSyncedTracks?: () => void;
  onNudgeSyncedTracksMs?: (deltaMs: number) => void;
  selection?: WaveformSelectionState | null;
  onSelectionChange?: (next: WaveformSelectionState | null) => void;
  onPlaySelectionRange?: (sel: WaveformSelectionState) => void;
  trackHeightPx?: number;
  onTrackHeightChange?: (nextTrackHeightPx: number) => void;
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
  locale = 'fa',
  showGrid = true,
  showRuler = true,
  showMarkers = true,
  showEditRegions = true,
  markers = [],
  onZoomChange,
  onSeekSec,
  onToggleTrackMute,
  onToggleTrackSolo,
  onSelectRecommendation,
  onAddMarkerAtPlayhead,
  onSplitAtPlayhead,
  onCutWaveformRange,
  detectedSyncOffsetMs = 0,
  detectedClockDriftPpm = 0,
  onAutoAlignSyncedTracks,
  onNudgeSyncedTracksMs,
  selection: controlledSelection,
  onSelectionChange,
  onPlaySelectionRange,
  trackHeightPx = 82,
  onTrackHeightChange,
}) => {
  const isFa = locale === 'fa';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(820);
  const [viewMode, setViewMode] = useState<'waveform' | 'spectral'>('waveform');
  const [showSyncPopover, setShowSyncPopover] = useState(false);
  const [internalSelection, setInternalSelection] = useState<WaveformSelectionState | null>(null);
  const [selectionScope, setSelectionScope] = useState<'track' | 'all'>('all');
  const [isDarkTheme, setIsDarkTheme] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const htmlEl = document.documentElement;
    const syncTheme = () => setIsDarkTheme(htmlEl.classList.contains('dark'));
    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(htmlEl, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const selectedRangeSec =
    controlledSelection !== undefined ? controlledSelection : internalSelection;
  const effectiveSelectionScope = selectedRangeSec?.scope ?? selectionScope;

  const setSelectedRangeSec = (next: WaveformSelectionState | null) => {
    if (onSelectionChange) onSelectionChange(next);
    if (controlledSelection === undefined) setInternalSelection(next);
  };

  type DragMode =
    | { kind: 'new'; sec: number; trackId: string; scope: 'track' | 'all' }
    | { kind: 'resize-start'; fixedEndSec: number; trackId: string; scope: 'track' | 'all' }
    | { kind: 'resize-end'; fixedStartSec: number; trackId: string; scope: 'track' | 'all' };
  const dragModeRef = useRef<DragMode | null>(null);

  useEffect(() => {
    const clearStuckDrag = () => {
      dragModeRef.current = null;
    };
    window.addEventListener('mouseup', clearStuckDrag);
    window.addEventListener('blur', clearStuckDrag);
    return () => {
      window.removeEventListener('mouseup', clearStuckDrag);
      window.removeEventListener('blur', clearStuckDrag);
    };
  }, []);

  const totalClipsCount = tracks.reduce((acc, t) => acc + t.clips.length, 0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const next = Math.max(280, el.clientWidth);
      setContainerWidth(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rulerHeight = showRuler ? 24 : 0;
  const trackHeight = Math.max(46, Math.min(180, Math.round(trackHeightPx)));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = containerWidth;
    const height = rulerHeight + Math.max(1, tracks.length) * trackHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Theme-Adaptive Studio Waveform Surface: Crisp Studio Slate in Light Mode, Deep Navy in Dark Mode
    ctx.fillStyle = isDarkTheme ? '#0D1520' : '#F1F5F9';
    ctx.fillRect(0, 0, width, height);

    const safeTotalSec = Math.max(0.5, totalDurationSec);
    const visibleSec = safeTotalSec / Math.max(1, zoom);
    const viewStartSec = Math.max(
      0,
      Math.min(safeTotalSec - visibleSec, playheadSec - visibleSec * 0.35),
    );
    const secToX = (sec: number) => ((sec - viewStartSec) / visibleSec) * width;

    // 1. Time Ruler
    if (showRuler) {
      ctx.fillStyle = isDarkTheme ? '#131E2D' : '#E2E8F0';
      ctx.fillRect(0, 0, width, rulerHeight);
      ctx.strokeStyle = isDarkTheme ? '#243447' : '#CBD5E1';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, rulerHeight);
      ctx.lineTo(width, rulerHeight);
      ctx.stroke();

      const tickStep = visibleSec <= 4 ? 0.5 : visibleSec <= 15 ? 1 : visibleSec <= 60 ? 5 : 10;
      ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = isDarkTheme ? '#8EA3B8' : '#475569';
      for (
        let t = Math.ceil(viewStartSec / tickStep) * tickStep;
        t <= viewStartSec + visibleSec;
        t += tickStep
      ) {
        const x = secToX(t);
        ctx.strokeStyle = isDarkTheme ? '#293B4F' : '#94A3B8';
        ctx.beginPath();
        ctx.moveTo(x, rulerHeight - 6);
        ctx.lineTo(x, rulerHeight);
        ctx.stroke();
        ctx.fillText(`${t.toFixed(tickStep < 1 ? 1 : 0)}s`, x + 4, 16);

        if (showGrid) {
          ctx.strokeStyle = isDarkTheme ? 'rgba(142, 163, 184, 0.06)' : 'rgba(100, 116, 139, 0.10)';
          ctx.beginPath();
          ctx.moveTo(x, rulerHeight);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }
    }

    // 2. Render Each Track
    tracks.forEach((track, tIdx) => {
      const top = rulerHeight + tIdx * trackHeight;
      const midY = top + trackHeight / 2;

      ctx.fillStyle = isDarkTheme
        ? tIdx % 2 === 0
          ? '#0D1520'
          : '#101A27'
        : tIdx % 2 === 0
          ? '#F8FAFC'
          : '#F1F5F9';
      ctx.fillRect(0, top, width, trackHeight);

      ctx.strokeStyle = isDarkTheme ? '#1E2D3E' : '#CBD5E1';
      ctx.beginPath();
      ctx.moveTo(0, top + trackHeight);
      ctx.lineTo(width, top + trackHeight);
      ctx.stroke();

      if (showGrid) {
        ctx.strokeStyle = isDarkTheme ? 'rgba(148, 163, 184, 0.14)' : 'rgba(100, 116, 139, 0.22)';
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();
      }

      for (const clip of track.clips) {
        const clipStartSec = flicksToSeconds(clip.timelineRange.startFlicks);
        const clipEndSec = flicksToSeconds(clip.timelineRange.endFlicks);
        if (clipEndSec < viewStartSec || clipStartSec > viewStartSec + visibleSec) continue;

        const x0 = Math.max(0, secToX(clipStartSec));
        const x1 = Math.min(width, secToX(clipEndSec));
        const clipW = Math.max(1, x1 - x0);

        if (clip.kind === 'room-tone-fill') {
          ctx.fillStyle = 'rgba(31, 163, 139, 0.14)';
          ctx.fillRect(x0, top + 8, clipW, trackHeight - 16);
          ctx.strokeStyle = 'rgba(67, 199, 167, 0.5)';
          ctx.strokeRect(x0 + 0.5, top + 8.5, Math.max(1, clipW - 1), trackHeight - 17);
          ctx.fillStyle = isDarkTheme ? '#43C7A7' : '#0D7A66';
          ctx.font = '10px sans-serif';
          if (clipW > 48) {
            ctx.fillText('Room Tone', x0 + 6, top + 22);
          }
          continue;
        }

        if (clipStartSec > 0.02 && x0 > 1 && x0 < width - 1) {
          ctx.strokeStyle = 'rgba(67, 199, 167, 0.45)';
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
            ? isDarkTheme
              ? '#43C7A7'
              : '#0D9488'
            : isDarkTheme
              ? '#38BDF8'
              : '#0284C7';
        const rmsColor = track.muted
          ? 'rgba(100, 116, 139, 0.25)'
          : tIdx === 0
            ? isDarkTheme
              ? 'rgba(31, 163, 139, 0.45)'
              : 'rgba(13, 148, 136, 0.35)'
            : isDarkTheme
              ? 'rgba(56, 189, 248, 0.34)'
              : 'rgba(2, 132, 199, 0.28)';

        const amp = (trackHeight - 18) * 0.5;
        const pxStart = Math.floor(x0);
        const pxEnd = Math.ceil(x1);

        if (viewMode === 'spectral' && pcm) {
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
              const hue =
                mag > 0.65
                  ? `rgba(229, 161, 59, ${0.22 + mag * 0.75})`
                  : mag > 0.35
                    ? `rgba(67, 199, 167, ${0.18 + mag * 0.7})`
                    : `rgba(56, 189, 248, ${0.08 + mag * 0.55})`;
              ctx.fillStyle = hue;
              const bandY = top + trackHeight - 6 - (b + 1) * bandH;
              ctx.fillRect(px, bandY, colStep, bandH - 0.5);
            }
          }
        } else {
          const secPerPx = visibleSec / Math.max(1, width);
          for (let px = pxStart; px < pxEnd; px++) {
            const pxSec0 = viewStartSec + (px / width) * visibleSec;
            const pxSec1 = pxSec0 + secPerPx;
            const srcSec0 = sourceStartSec + (pxSec0 - clipStartSec);
            const srcSec1 = sourceStartSec + (pxSec1 - clipStartSec);
            const binStart = Math.max(0, Math.floor((srcSec0 * sr) / level.samplesPerBin));
            const binEnd = Math.min(
              level.max.length - 1,
              Math.max(binStart, Math.floor((srcSec1 * sr) / level.samplesPerBin)),
            );
            if (binStart >= level.max.length || binEnd < 0) continue;

            let maxV = -Infinity;
            let minV = Infinity;
            let rmsV = 0;
            for (let b = binStart; b <= binEnd; b++) {
              if (level.max[b] > maxV) maxV = level.max[b];
              if (level.min[b] < minV) minV = level.min[b];
              if (level.rms[b] > rmsV) rmsV = level.rms[b];
            }
            if (!Number.isFinite(maxV) || !Number.isFinite(minV)) continue;

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

      // 3. Pending Smart Suggestion Edit Region Overlays
      if (showEditRegions) {
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
            ? 'rgba(216, 93, 101, 0.24)'
            : isSelected
              ? 'rgba(229, 161, 59, 0.30)'
              : 'rgba(229, 161, 59, 0.14)';
          ctx.fillRect(rx0, top + 4, Math.max(2, rx1 - rx0), trackHeight - 8);

          ctx.strokeStyle = isWarning ? '#D85D65' : '#E5A13B';
          ctx.lineWidth = isSelected ? 1.8 : 1;
          ctx.strokeRect(rx0, top + 4, Math.max(2, rx1 - rx0), trackHeight - 8);
        }
      }

      // 3b. Active Selection Overlay (Amber Accent)
      if (
        selectedRangeSec &&
        (selectedRangeSec.scope === 'all' || selectedRangeSec.trackId === track.id)
      ) {
        const sx0 = secToX(selectedRangeSec.startSec);
        const sx1 = secToX(selectedRangeSec.endSec);
        if (sx1 >= 0 && sx0 <= width) {
          ctx.fillStyle = 'rgba(229, 161, 59, 0.22)';
          ctx.fillRect(sx0, top + 1, Math.max(2, sx1 - sx0), trackHeight - 2);
          ctx.strokeStyle = '#E5A13B';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx0, top + 1, Math.max(2, sx1 - sx0), trackHeight - 2);

          // Left & Right trim handles
          ctx.fillStyle = '#F6C26B';
          ctx.fillRect(sx0 - 2, top + 2, 4, trackHeight - 4);
          ctx.fillRect(sx1 - 2, top + 2, 4, trackHeight - 4);
        }
      }
    });

    // 3c. Markers Overlay
    if (showMarkers && markers.length > 0) {
      for (const m of markers) {
        const mx = secToX(m.startSec);
        if (mx < 0 || mx > width) continue;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(mx, rulerHeight);
        ctx.lineTo(mx, height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#38BDF8';
        ctx.fillRect(mx - 3, Math.max(0, rulerHeight - 8), 6, 6);
      }
    }

    // 4. Crisp High-Contrast Playhead
    const playX = secToX(playheadSec);
    if (playX >= 0 && playX <= width) {
      ctx.strokeStyle = isDarkTheme ? '#FFFFFF' : '#0F172A';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();

      ctx.fillStyle = isDarkTheme ? '#E5A13B' : '#0D9488';
      ctx.beginPath();
      ctx.moveTo(playX - 5.5, 0);
      ctx.lineTo(playX + 5.5, 0);
      ctx.lineTo(playX, 9);
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
    showGrid,
    showRuler,
    showMarkers,
    showEditRegions,
    markers,
    rulerHeight,
    trackHeight,
    isDarkTheme,
  ]);

  const clientXToTimelineSec = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const safeWidth = Math.max(1, rect.width);
    const x = clientX - rect.left;
    const safeTotalSec = Math.max(0.5, totalDurationSec);
    const visibleSec = safeTotalSec / Math.max(1, zoom);
    const viewStartSec = Math.max(
      0,
      Math.min(safeTotalSec - visibleSec, playheadSec - visibleSec * 0.35),
    );
    return Math.max(0, Math.min(safeTotalSec, viewStartSec + (x / safeWidth) * visibleSec));
  };

  const clientYToTrackId = (clientY: number): string => {
    const canvas = canvasRef.current;
    if (!canvas) return tracks[0]?.id ?? 'track-host';
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top - rulerHeight;
    const trackIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor(y / trackHeight)));
    return tracks[trackIdx]?.id ?? tracks[0]?.id ?? 'track-host';
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sec = clientXToTimelineSec(e.clientX);
    const trackId = clientYToTrackId(e.clientY);

    if (selectedRangeSec) {
      const safeTotal = Math.max(0.5, totalDurationSec);
      const handleToleranceSec = Math.max(0.06, (safeTotal / Math.max(1, zoom)) * 0.014);
      if (Math.abs(sec - selectedRangeSec.startSec) <= handleToleranceSec) {
        dragModeRef.current = {
          kind: 'resize-start',
          fixedEndSec: selectedRangeSec.endSec,
          trackId: selectedRangeSec.trackId,
          scope: selectedRangeSec.scope,
        };
        return;
      }
      if (Math.abs(sec - selectedRangeSec.endSec) <= handleToleranceSec) {
        dragModeRef.current = {
          kind: 'resize-end',
          fixedStartSec: selectedRangeSec.startSec,
          trackId: selectedRangeSec.trackId,
          scope: selectedRangeSec.scope,
        };
        return;
      }
    }

    dragModeRef.current = { kind: 'new', sec, trackId, scope: effectiveSelectionScope };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mode = dragModeRef.current;
    if (!mode) return;
    if ((e.buttons & 1) === 0) {
      dragModeRef.current = null;
      return;
    }
    const curSec = clientXToTimelineSec(e.clientX);

    if (mode.kind === 'resize-start') {
      const startSec = Math.max(0, Math.min(mode.fixedEndSec - 0.05, curSec));
      setSelectedRangeSec({
        startSec,
        endSec: mode.fixedEndSec,
        trackId: mode.trackId,
        scope: mode.scope,
      });
      return;
    }

    if (mode.kind === 'resize-end') {
      const endSec = Math.min(totalDurationSec, Math.max(mode.fixedStartSec + 0.05, curSec));
      setSelectedRangeSec({
        startSec: mode.fixedStartSec,
        endSec,
        trackId: mode.trackId,
        scope: mode.scope,
      });
      return;
    }

    const delta = Math.abs(curSec - mode.sec);
    if (delta >= 0.06) {
      setSelectedRangeSec({
        startSec: Math.min(mode.sec, curSec),
        endSec: Math.max(mode.sec, curSec),
        trackId: mode.trackId,
        scope: mode.scope,
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mode = dragModeRef.current;
    dragModeRef.current = null;
    const clickedSec = clientXToTimelineSec(e.clientX);

    if (mode && (mode.kind === 'resize-start' || mode.kind === 'resize-end')) return;

    if (mode && mode.kind === 'new' && Math.abs(clickedSec - mode.sec) >= 0.06) {
      const lo = Math.min(mode.sec, clickedSec);
      const hi = Math.max(mode.sec, clickedSec);
      setSelectedRangeSec({
        startSec: lo,
        endSec: hi,
        trackId: mode.trackId,
        scope: mode.scope,
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

  const handleWheelZoom = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const nextZoom = Math.max(1, Math.min(12, Number((zoom * factor).toFixed(2))));
    onZoomChange(nextZoom);
  };

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 0.5 : 0.25;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const nextSec = Math.max(0, Math.min(totalDurationSec, playheadSec + dir * step));
      if (e.shiftKey) {
        const baseStart = selectedRangeSec ? selectedRangeSec.startSec : playheadSec;
        const lo = Math.min(baseStart, nextSec);
        const hi = Math.max(baseStart, nextSec);
        if (hi - lo >= 0.05) {
          setSelectedRangeSec({
            startSec: lo,
            endSec: hi,
            trackId: tracks[0]?.id ?? 'track-host',
            scope: effectiveSelectionScope,
          });
        }
      }
      onSeekSec(nextSec);
    } else if (e.key === 'Escape' && selectedRangeSec) {
      e.preventDefault();
      setSelectedRangeSec(null);
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
    const applied = onCutWaveformRange(
      {
        startFlicks: secondsToFlicks(selectedRangeSec.startSec),
        endFlicks: secondsToFlicks(selectedRangeSec.endSec),
      },
      selectedRangeSec.trackId,
      mode,
      selectedRangeSec.scope,
    );
    if (applied !== false) {
      setSelectedRangeSec(null);
    }
  };

  const handleZoomToSelection = () => {
    if (!selectedRangeSec) return;
    const len = Math.max(0.25, selectedRangeSec.endSec - selectedRangeSec.startSec);
    const nextZoom = Math.max(1, Math.min(12, totalDurationSec / (len * 1.4)));
    onSeekSec(selectedRangeSec.startSec + len * 0.35);
    onZoomChange(nextZoom);
  };

  const hasSyncedPeerTrack = tracks.some((t, idx) => idx > 0 && Boolean(t.syncGroupId));
  const hasDetectedDrift =
    hasSyncedPeerTrack &&
    (Math.abs(detectedSyncOffsetMs) > 0.1 || Math.abs(detectedClockDriftPpm) > 1.0);

  return (
    <section
      data-testid="waveform-timeline-panel"
      aria-label={isFa ? 'تایملاین و شکل‌موج صوتی' : 'Audio Waveform & Timeline'}
      className="border-b border-[var(--avp-border)] bg-[var(--avp-surface)] shrink-0 overflow-hidden"
    >
      {/* Strictly Single-Line 36px Timeline Toolbar — 3 Segmented Studio Clusters */}
      <div className="h-[36px] flex items-center justify-between gap-1 sm:gap-1.5 px-2 sm:px-3 border-b border-[var(--avp-border)] bg-[var(--avp-surface)] overflow-x-auto">
        {/* Cluster 1 (Right/Start): Timeline Identity + Unified Sync & Drift Capsule */}
        <div className="flex items-center gap-1.5 sm:gap-2 text-xs min-w-0 shrink-0">
          <span className="font-bold text-[12px] sm:text-[12.5px] text-[var(--avp-text)] whitespace-nowrap">
            {isFa ? 'تایملاین' : 'Timeline'}
          </span>
          <span data-testid="waveform-clips-count" className="sr-only">
            ({totalClipsCount} {isFa ? 'کلیپ' : 'clips'})
          </span>

          {hasSyncedPeerTrack ? (
            <button
              type="button"
              data-testid="btn-toggle-sync-drift"
              aria-expanded={showSyncPopover}
              onClick={() => setShowSyncPopover((v) => !v)}
              title={
                isFa
                  ? 'قفل همگام‌سازی فعال — بررسی و تنظیم انحراف زمانی ترک‌ها'
                  : 'Sync-Lock active — Inspect & align multi-track sync offset'
              }
              className={`inline-flex items-center gap-1 sm:gap-1.5 h-[22px] sm:h-[24px] px-1.5 sm:px-2 rounded-md border text-[10px] sm:text-[10.5px] font-medium cursor-pointer transition-colors ${
                showSyncPopover || hasDetectedDrift
                  ? 'border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)]/70 text-[var(--avp-warning-text)]'
                  : 'border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] text-[var(--avp-accent-text)]'
              }`}
            >
              <Lock className="w-3 h-3 text-[var(--avp-accent-text)] shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className="hidden xl:inline text-[var(--avp-text-secondary)]">
                {isFa ? 'همگام' : 'Sync'}
              </span>
              <span className="hidden xl:inline text-[var(--avp-border-strong)]" aria-hidden="true">·</span>
              <bdi dir="ltr" className="avp-bidi-num font-mono font-semibold">
                {hasDetectedDrift
                  ? `Δ ${detectedSyncOffsetMs >= 0 ? '+' : ''}${detectedSyncOffsetMs.toFixed(1)}ms`
                  : '0.0ms'}
              </bdi>
            </button>
          ) : (
            <span
              className="inline-flex items-center gap-1 h-[22px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] text-[10.5px] text-[var(--avp-accent-text)] font-medium whitespace-nowrap"
              title={isFa ? 'قفل همگام‌سازی چندترکی فعال' : 'Multi-track Sync-Lock active'}
            >
              <Lock className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
              <span className="hidden xl:inline">{isFa ? 'همگام' : 'Sync'}</span>
            </span>
          )}
        </div>

        {/* Cluster 2 & 3 (Left/End): Framed Editing Tools + View & Zoom Deck */}
        <div className="flex items-center gap-1 sm:gap-1.5 text-xs shrink-0">
          {/* Cluster 2: Framed Action Tool Group [Marker | Split | Range] */}
          <div className="inline-flex items-center rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/60 p-0.5">
            {onAddMarkerAtPlayhead && (
              <button
                type="button"
                data-testid="btn-add-timeline-marker"
                onClick={onAddMarkerAtPlayhead}
                title={isFa ? 'ثبت نشانگر در مکان‌نما (M)' : 'Add marker at playhead (M)'}
                className="inline-flex items-center gap-1 h-[22px] px-1.5 sm:px-2 rounded-[5px] text-[11px] font-medium text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
              >
                <BookmarkPlus className="w-3 h-3 text-[var(--avp-accent)]" strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden xl:inline">{isFa ? 'نشانگر' : 'Marker'}</span>
              </button>
            )}

            {onAddMarkerAtPlayhead && onSplitAtPlayhead && (
              <span className="w-px h-3 bg-[var(--avp-border)]" aria-hidden="true" />
            )}

            {onSplitAtPlayhead && (
              <button
                type="button"
                data-testid="btn-split-at-playhead"
                onClick={onSplitAtPlayhead}
                title={isFa ? 'برش غیرمخرب در مکان‌نما' : 'Non-destructive split at playhead'}
                className="inline-flex items-center gap-1 h-[22px] px-1.5 sm:px-2 rounded-[5px] text-[11px] font-medium text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
              >
                <SplitSquareVertical className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden xl:inline">{isFa ? 'برش' : 'Split'}</span>
              </button>
            )}

            <span className="w-px h-3 bg-[var(--avp-border)]" aria-hidden="true" />

            <button
              type="button"
              data-testid="btn-select-playhead-window"
              onClick={handleSelectWindowAroundPlayhead}
              title={isFa ? 'انتخاب بازه ۰.۷ ثانیه‌ای اطراف مکان‌نما' : 'Select 0.7s range around playhead'}
              className="inline-flex items-center gap-1 h-[22px] px-1.5 sm:px-2 rounded-[5px] text-[11px] font-medium text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
            >
              <Scissors className="w-3 h-3 text-[var(--avp-warning)]" strokeWidth={1.75} aria-hidden="true" />
              <span className="hidden xl:inline">{isFa ? 'بازه' : 'Range'}</span>
            </button>
          </div>

          <button
            type="button"
            data-testid="btn-toggle-selection-scope"
            onClick={() => {
              const nextScope = effectiveSelectionScope === 'all' ? 'track' : 'all';
              setSelectionScope(nextScope);
              if (selectedRangeSec) {
                setSelectedRangeSec({ ...selectedRangeSec, scope: nextScope });
              }
            }}
            className="hidden 2xl:inline-flex avp-btn avp-btn-sm avp-btn-ghost h-[24px] px-2"
          >
            {effectiveSelectionScope === 'all'
              ? isFa
                ? 'همه ترک‌ها'
                : 'All Tracks'
              : isFa
                ? 'ترک فعال'
                : 'Active Track'}
          </button>

          {/* Desktop Split Ratio Quick Presets [Mini | 30/70 | 50/50] */}
          {onTrackHeightChange && (
            <div
              role="group"
              aria-label={isFa ? 'نسبت ارتفاع تایم‌لاین و متن' : 'Timeline split ratio'}
              className="hidden lg:inline-flex items-center rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/60 p-0.5"
            >
              {(
                [
                  { id: 'mini', px: 48, label: isFa ? 'مینی' : 'Mini' },
                  { id: 'balanced', px: 82, label: '30/70' },
                  { id: 'expanded', px: 132, label: '50/50' },
                ] as const
              ).map((preset) => {
                const isActive = Math.abs(trackHeight - preset.px) <= 10;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`btn-split-preset-${preset.id}`}
                    aria-pressed={isActive}
                    onClick={() => onTrackHeightChange(preset.px)}
                    title={
                      isFa
                        ? `تنظیم نسبت ارتفاع تایم‌لاین (${preset.label})`
                        : `Set timeline split ratio (${preset.label})`
                    }
                    className={`inline-flex items-center justify-center h-[22px] px-1.5 rounded-[5px] text-[10px] font-mono font-medium cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                        : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Cluster 3: View Mode & Zoom Capsule */}
          <div className="inline-flex items-center rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/60 p-0.5">
            <button
              type="button"
              data-testid="btn-toggle-spectral-view"
              onClick={() => setViewMode((m) => (m === 'waveform' ? 'spectral' : 'waveform'))}
              className={`inline-flex items-center gap-1 h-[22px] px-2 rounded-[5px] text-[11px] font-medium cursor-pointer transition-colors ${
                viewMode === 'spectral'
                  ? 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)] font-semibold'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)]'
              }`}
            >
              {viewMode === 'spectral' ? (
                <Waves className="w-3 h-3 text-[var(--avp-warning)]" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Activity className="w-3 h-3 text-[var(--avp-accent)]" strokeWidth={1.75} aria-hidden="true" />
              )}
              <span>{viewMode === 'spectral' ? (isFa ? 'طیف' : 'Spectral') : isFa ? 'موج' : 'Wave'}</span>
            </button>

            <span className="w-px h-3 bg-[var(--avp-border)] mx-0.5" aria-hidden="true" />

            <div dir="ltr" className="inline-flex items-center">
              <button
                type="button"
                data-testid="btn-waveform-zoom-out"
                onClick={() => onZoomChange(Math.max(1, Number((zoom / 1.5).toFixed(2))))}
                aria-label={isFa ? 'کوچک‌نمایی' : 'Zoom out'}
                className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer"
              >
                <ZoomOut className="w-3 h-3" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                data-testid="btn-waveform-zoom-fit"
                onClick={() => onZoomChange(1)}
                title={isFa ? 'نمایش کامل (Fit)' : 'Fit to view'}
                className="inline-flex items-center justify-center h-[22px] px-1.5 rounded-[5px] font-mono tabular-nums text-[10.5px] font-semibold text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer"
              >
                {zoom.toFixed(1)}x
              </button>
              <button
                type="button"
                data-testid="btn-waveform-zoom-in"
                onClick={() => onZoomChange(Math.min(12, Number((zoom * 1.5).toFixed(2))))}
                aria-label={isFa ? 'بزرگ‌نمایی' : 'Zoom in'}
                className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer"
              >
                <ZoomIn className="w-3 h-3" strokeWidth={1.75} />
              </button>
              {zoom > 1.05 && (
                <button
                  type="button"
                  onClick={() => onZoomChange(1)}
                  aria-label={isFa ? 'بازنشانی بزرگ‌نمایی' : 'Reset zoom'}
                  className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer"
                >
                  <Minimize2 className="w-3 h-3" strokeWidth={1.75} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Contextual Selection Action Strip (only when user selects a range) */}
      {selectedRangeSec && (
        <div
          data-testid="waveform-range-action-bar"
          className="px-3 py-1.5 border-b border-[var(--avp-border)] bg-[var(--avp-warning-soft)]/70 flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <span className="text-[11px] font-semibold text-[var(--avp-text)] flex items-center gap-1.5">
            <span>{isFa ? 'بازه انتخاب:' : 'Selection:'}</span>
            <bdi dir="ltr" className="avp-bidi-num">
              {selectedRangeSec.startSec.toFixed(2)}s – {selectedRangeSec.endSec.toFixed(2)}s (Δ{' '}
              {(selectedRangeSec.endSec - selectedRangeSec.startSec).toFixed(2)}s)
            </bdi>
          </span>

          <div className="flex flex-wrap items-center gap-1.5">
            {onPlaySelectionRange && (
              <button
                type="button"
                data-testid="btn-play-waveform-selection"
                onClick={() => onPlaySelectionRange(selectedRangeSec)}
                className="avp-btn avp-btn-sm avp-btn-tonal"
              >
                <Play className="w-3 h-3" strokeWidth={2} aria-hidden="true" />
                <span>{isFa ? 'پخش بازه' : 'Play Range'}</span>
              </button>
            )}

            <button
              type="button"
              data-testid="btn-zoom-to-selection"
              onClick={handleZoomToSelection}
              title={isFa ? 'بزرگ‌نمایی روی بازه انتخابی' : 'Zoom to selection'}
              className="avp-btn avp-btn-sm avp-btn-outline"
            >
              <Maximize2 className="w-3 h-3" strokeWidth={1.75} />
              <span>{isFa ? 'بزرگ‌نمایی انتخاب' : 'Zoom Sel'}</span>
            </button>

            <button
              type="button"
              data-testid="btn-waveform-ripple-cut"
              onClick={() => handleExecuteWaveformRangeCut('sync-locked-ripple-cut')}
              className="avp-btn avp-btn-sm bg-[var(--avp-warning)] text-slate-950 font-semibold hover:opacity-90"
            >
              {isFa ? 'حذف بازه (Ripple)' : 'Ripple Cut'}
            </button>

            <button
              type="button"
              data-testid="btn-waveform-roomtone-cut"
              onClick={() => handleExecuteWaveformRangeCut('in-place-room-tone-suppression')}
              className="avp-btn avp-btn-sm avp-btn-tonal"
            >
              {isFa ? 'Room Tone درجا' : 'Room Tone'}
            </button>

            <button
              type="button"
              data-testid="btn-clear-waveform-selection"
              onClick={() => setSelectedRangeSec(null)}
              aria-label={isFa ? 'لغو انتخاب بازه' : 'Clear selection'}
              className="avp-btn-icon-sm"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {/* Collapsible Multi-Track Sync Drift Drawer (opened via Δ badge in toolbar) */}
      {hasSyncedPeerTrack && showSyncPopover && (
        <div
          data-testid="waveform-sync-drift-bar"
          className="px-3 py-1.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] flex flex-wrap items-center justify-between gap-2 text-[11px]"
        >
          <span
            data-testid="waveform-sync-drift-status"
            className={`font-medium flex items-center gap-1.5 ${
              hasDetectedDrift ? 'text-[var(--avp-warning-text)]' : 'text-[var(--avp-accent-text)]'
            }`}
          >
            {hasDetectedDrift ? (
              <>
                <span>{isFa ? 'انحراف همگام‌سازی:' : 'Sync Offset:'}</span>
                <bdi dir="ltr" className="avp-bidi-num">
                  {detectedSyncOffsetMs >= 0 ? '+' : ''}
                  {detectedSyncOffsetMs.toFixed(1)} ms
                </bdi>
              </>
            ) : (
              <span>
                {isFa
                  ? 'ترک‌های همگام هم‌تراز هستند (0.0 ms)'
                  : 'Synced Tracks Aligned (0.0 ms)'}
              </span>
            )}
          </span>
          <div className="flex items-center gap-1.5">
            {onNudgeSyncedTracksMs && (
              <>
                <button
                  type="button"
                  data-testid="btn-nudge-sync-minus"
                  onClick={() => onNudgeSyncedTracksMs(-5)}
                  className="avp-btn avp-btn-sm avp-btn-outline"
                >
                  <bdi dir="ltr" className="avp-bidi-num">-5ms</bdi>
                </button>
                <button
                  type="button"
                  data-testid="btn-nudge-sync-plus"
                  onClick={() => onNudgeSyncedTracksMs(5)}
                  className="avp-btn avp-btn-sm avp-btn-outline"
                >
                  <bdi dir="ltr" className="avp-bidi-num">+5ms</bdi>
                </button>
              </>
            )}
            {onAutoAlignSyncedTracks && hasDetectedDrift && (
              <button
                type="button"
                data-testid="btn-auto-align-sync"
                onClick={onAutoAlignSyncedTracks}
                className="avp-btn avp-btn-sm bg-[var(--avp-warning)] text-slate-950 font-semibold hover:opacity-90"
              >
                {isFa ? 'هم‌ترازسازی' : 'Auto Align'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSyncPopover(false)}
              aria-label={isFa ? 'بستن تنظیم همگام‌سازی' : 'Close sync alignment'}
              className="avp-btn-icon-sm"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {/* Mobile (<md) Compact Horizontal Track Strip — Saves 160px vertical space on 390px screens */}
      <div className="flex md:hidden items-center justify-between gap-2 px-3 py-1 border-b border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] overflow-x-auto">
        {tracks.map((track, idx) => {
          const isHost = idx === 0;
          return (
            <div key={track.id} className="inline-flex items-center gap-1.5 shrink-0 text-[11px]">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  isHost ? 'bg-emerald-500' : 'bg-sky-400'
                }`}
                aria-hidden="true"
              />
              <span className="font-semibold text-[var(--avp-text)]">
                {track.speakerLabel || track.name}
              </span>
              <button
                type="button"
                onClick={() => onToggleTrackMute(track.id)}
                aria-label={`${isFa ? 'قطع صدا' : 'Mute'} ${track.name}`}
                aria-pressed={track.muted}
                className={`h-5 px-1.5 rounded text-[10px] font-mono font-semibold cursor-pointer ${
                  track.muted
                    ? 'bg-[var(--avp-danger-soft)] text-[var(--avp-danger)]'
                    : 'bg-[var(--avp-surface)] text-[var(--avp-text-secondary)]'
                }`}
              >
                M
              </button>
              <button
                type="button"
                onClick={() => onToggleTrackSolo(track.id)}
                aria-label={`${isFa ? 'تک‌صدایی' : 'Solo'} ${track.name}`}
                aria-pressed={track.solo}
                className={`h-5 px-1.5 rounded text-[10px] font-mono font-semibold cursor-pointer ${
                  track.solo
                    ? 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)]'
                    : 'bg-[var(--avp-surface)] text-[var(--avp-text-secondary)]'
                }`}
              >
                S
              </button>
            </div>
          );
        })}
      </div>

      {/* Desktop Track Headers (120px LEFT axis, aligned with Transcript left column) + Theme-Adaptive Waveform Canvas */}
      <div dir="ltr" className="grid grid-cols-1 md:grid-cols-[120px_1fr]">
        <div className="hidden md:flex border-r border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] flex-col">
          {showRuler && (
            <div className="h-[24px] px-2 flex items-center justify-between text-[10.5px] text-[var(--avp-accent-text)] border-b border-[var(--avp-border)] avp-bidi-num font-semibold">
              <span>{formatTimecode(secondsToFlicks(playheadSec))}</span>
              <span className="text-[9px] uppercase tracking-wider text-[var(--avp-text-faint)] font-sans">
                0s →
              </span>
            </div>
          )}
          {tracks.map((track, idx) => {
            const isHost = idx === 0;
            const roleLabel = isHost ? (isFa ? 'میزبان' : 'Host') : isFa ? 'مهمان' : 'Guest';
            const isCompactTrack = trackHeight < 62;
            return (
              <div
                key={track.id}
                dir={isFa ? 'rtl' : 'ltr'}
                style={{ height: `${trackHeight}px` }}
                className={`px-2 py-1.5 border-b border-[var(--avp-border)] last:border-b-0 border-l-[3px] flex flex-col justify-between overflow-hidden ${
                  isHost ? 'border-l-emerald-500' : 'border-l-sky-400'
                }`}
              >
                {/* Row 1: Color Dot + Speaker Identity (Start) + Segmented [M|S] Studio Pill (End) */}
                <div className="flex items-center justify-between gap-1.5 min-w-0">
                  <div className="min-w-0 flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isHost ? 'bg-emerald-500' : 'bg-sky-400'
                      }`}
                      aria-hidden="true"
                    />
                    <span
                      className="text-xs font-bold text-[var(--avp-text)] truncate"
                      title={track.name}
                    >
                      {track.speakerLabel || track.name}
                    </span>
                  </div>

                  {/* Unified Segmented [M | S] Control Pill */}
                  <div
                    className="inline-flex items-center rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] overflow-hidden shrink-0"
                    dir="ltr"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleTrackMute(track.id)}
                      aria-label={`${isFa ? 'قطع صدا' : 'Mute'} ${track.name}`}
                      aria-pressed={track.muted}
                      className={`inline-flex items-center justify-center w-[22px] h-[20px] text-[10px] font-mono font-bold cursor-pointer transition-colors ${
                        track.muted
                          ? 'bg-[var(--avp-danger-soft)] text-[var(--avp-danger)]'
                          : 'text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] hover:text-[var(--avp-text)]'
                      }`}
                    >
                      M
                    </button>
                    <span className="w-px h-3.5 bg-[var(--avp-border)]" aria-hidden="true" />
                    <button
                      type="button"
                      onClick={() => onToggleTrackSolo(track.id)}
                      aria-label={`${isFa ? 'تک‌صدایی' : 'Solo'} ${track.name}`}
                      aria-pressed={track.solo}
                      className={`inline-flex items-center justify-center w-[22px] h-[20px] text-[10px] font-mono font-bold cursor-pointer transition-colors ${
                        track.solo
                          ? 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)]'
                          : 'text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] hover:text-[var(--avp-text)]'
                      }`}
                    >
                      S
                    </button>
                  </div>
                </div>

                {/* Row 2: Role + Channel Telemetry & Segmented Gain Strip (hidden in Mini compact mode) */}
                {!isCompactTrack && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[9.5px]">
                      <span className="text-[var(--avp-text-muted)] font-medium truncate">
                        {roleLabel} · <bdi dir="ltr" className="font-mono text-[9px]">{`CH${idx + 1}`}</bdi>
                      </span>
                      <bdi dir="ltr" className="font-mono text-[9px] text-[var(--avp-text-secondary)] font-semibold">
                        {track.muted ? 'MUTE' : '0.0 dB'}
                      </bdi>
                    </div>
                    <div className="h-[3px] w-full rounded-full bg-[var(--avp-border)] overflow-hidden" dir="ltr">
                      <div
                        className={`h-full rounded-full transition-all ${
                          track.muted
                            ? 'w-0'
                            : isHost
                              ? 'w-[78%] bg-emerald-500/80'
                              : 'w-[72%] bg-sky-400/80'
                        }`}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div ref={containerRef} className="w-full overflow-hidden select-none bg-slate-100 dark:bg-[#0D1520]">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            data-testid="waveform-canvas"
            aria-label={isFa ? 'بوم شکل‌موج صوتی تعاملی' : 'Interactive audio waveform canvas'}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheelZoom}
            onKeyDown={handleCanvasKeyDown}
            className="block w-full cursor-crosshair focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--avp-accent)]"
          />
        </div>
      </div>
    </section>
  );
};
