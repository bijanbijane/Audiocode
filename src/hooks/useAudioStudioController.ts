import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Flicks,
  SampleRate,
  TimeMath,
  TimeRange,
} from '../contracts/timebase.contract';
import {
  ProjectDocument,
  RecommendationId,
} from '../contracts/project-schema.contract';
import { TimelineTransactionEngine } from '../project-core/TimelineTransactionEngine';
import { TimedPersianToken } from '../ai-engine/PersianTextNormalizer';
import {
  LodWaveformCanvasRenderer,
  WaveformLodBuffer,
} from '../ui/waveform/LodWaveformCanvasRenderer';
import { CTRL_STATE } from '../audio-engine/SharedRingBuffer';

export interface AudioClockSharedMemoryReader {
  /** Atomically reads current playback sample index from AudioWorklet shared memory (Section 23). */
  readCurrentSampleFrameAtomically(): number;
  isPlaying(): boolean;
  setPlaybackRate(rate: number): void;
  togglePlayPause(): void;
  seekToSample(sampleIndex: number): void;
}

export interface StudioShortcutContext {
  readonly clockReader: AudioClockSharedMemoryReader;
  readonly sampleRate: SampleRate;
  readonly currentShuttleSpeed: number;
  readonly onSetShuttleSpeed: (speed: number) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onSplitAtPlayhead?: (playheadFlicks: Flicks) => void;
}

/**
 * O(log N) binary search mapping playhead Flicks to the matching Persian word token.
 * Safe for multi-hour podcasts with 30,000+ timed tokens.
 */
export function findActiveTokenIdAtFlicks(
  tokens: readonly TimedPersianToken[],
  playheadFlicks: Flicks,
): string | null {
  if (!Number.isFinite(playheadFlicks)) return null;
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const tok = tokens[mid];
    if (!Number.isFinite(tok.range.start) || !Number.isFinite(tok.range.end)) {
      return null;
    }
    if (playheadFlicks >= tok.range.start && playheadFlicks < tok.range.end) {
      return tok.tokenId;
    }
    if (playheadFlicks < tok.range.start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return null;
}

/**
 * Advances the waveform viewport window cleanly when active playback passes its right edge.
 */
export function computeAutoScrollViewport(
  viewport: TimeRange,
  playheadFlicks: Flicks,
  isPlaying: boolean,
): TimeRange {
  if (
    !isPlaying ||
    !Number.isFinite(playheadFlicks) ||
    !Number.isFinite(viewport.start) ||
    !Number.isFinite(viewport.end)
  ) {
    return viewport;
  }
  const span = viewport.end - viewport.start;
  if (!Number.isFinite(span) || span <= 0) return viewport;
  if (playheadFlicks > viewport.end) {
    return {
      start: playheadFlicks,
      end: playheadFlicks + span,
    };
  }
  if (playheadFlicks < viewport.start) {
    return {
      start: playheadFlicks,
      end: playheadFlicks + span,
    };
  }
  return viewport;
}

/**
 * Factory creating an Atomics-backed clock reader bound to SharedArrayBuffer (with ArrayBuffer fallback).
 */
export function createSharedMemoryClockReader(params: {
  controlBuffer: SharedArrayBuffer | ArrayBuffer;
  sampleFrameControlIndex?: number;
  isPlayingControlIndex?: number;
  onTogglePlayPause: () => void;
  onSetPlaybackRate: (rate: number) => void;
  onSeekToSample: (sampleIndex: number) => void;
}): AudioClockSharedMemoryReader {
  const ctrlView = new Int32Array(params.controlBuffer);
  const canUseAtomics =
    typeof SharedArrayBuffer !== 'undefined' && params.controlBuffer instanceof SharedArrayBuffer;
  const sampleIdx = params.sampleFrameControlIndex ?? CTRL_STATE.READ_INDEX;
  const playingIdx = params.isPlayingControlIndex ?? CTRL_STATE.IS_PLAYING;

  const readInt32 = (slot: number): number => {
    if (slot < 0 || slot >= ctrlView.length) return 0;
    return canUseAtomics ? Atomics.load(ctrlView, slot) : ctrlView[slot];
  };

  return {
    readCurrentSampleFrameAtomically: () => Math.max(0, readInt32(sampleIdx)),
    isPlaying: () => readInt32(playingIdx) === 1,
    setPlaybackRate: params.onSetPlaybackRate,
    togglePlayPause: params.onTogglePlayPause,
    seekToSample: params.onSeekToSample,
  };
}

/**
 * Detects if keyboard focus is inside an editable Persian text control so single-key shortcuts are suspended.
 */
export function isEditableTextTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable);
}

export interface StudioShortcutEvent {
  readonly target: EventTarget | null;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey?: boolean;
  readonly key: string;
  readonly code: string;
  preventDefault(): void;
}

/**
 * Pure keyboard shortcut dispatcher for Space, J/K/L, S, Ctrl+Z, Ctrl+Shift+Z (Sections 50-53).
 * Returns true if the shortcut was handled.
 */
export function dispatchStudioShortcutKeyDown(
  e: StudioShortcutEvent,
  ctx: StudioShortcutContext,
): boolean {
  if (isEditableTextTarget(e.target)) {
    return false;
  }

  const keyLower = (e.key ?? '').toLowerCase();

  if ((e.ctrlKey || e.metaKey) && keyLower === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      ctx.onRedo();
    } else {
      ctx.onUndo();
    }
    return true;
  }

  if ((e.ctrlKey || e.metaKey) && keyLower === 'y') {
    e.preventDefault();
    ctx.onRedo();
    return true;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) {
    return false;
  }

  switch (e.code) {
    case 'Space': {
      e.preventDefault();
      ctx.clockReader.togglePlayPause();
      return true;
    }
    case 'KeyK': {
      e.preventDefault();
      if (ctx.clockReader.isPlaying()) {
        ctx.clockReader.togglePlayPause();
      }
      ctx.onSetShuttleSpeed(1.0);
      ctx.clockReader.setPlaybackRate(1.0);
      return true;
    }
    case 'KeyL': {
      e.preventDefault();
      const safeSpeed =
        Number.isFinite(ctx.currentShuttleSpeed) && ctx.currentShuttleSpeed > 0
          ? ctx.currentShuttleSpeed
          : 1.0;
      const nextSpeed = safeSpeed >= 2.0 ? 1.0 : Number((safeSpeed + 0.5).toFixed(1));
      ctx.onSetShuttleSpeed(nextSpeed);
      ctx.clockReader.setPlaybackRate(nextSpeed);
      if (!ctx.clockReader.isPlaying()) {
        ctx.clockReader.togglePlayPause();
      }
      return true;
    }
    case 'KeyJ': {
      e.preventDefault();
      const rawSample = ctx.clockReader.readCurrentSampleFrameAtomically();
      const curSample = Number.isFinite(rawSample) ? Math.max(0, rawSample) : 0;
      const safeRate =
        Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
      const backSample = Math.max(0, curSample - 3 * safeRate);
      ctx.clockReader.seekToSample(backSample);
      return true;
    }
    case 'KeyS': {
      if (ctx.onSplitAtPlayhead) {
        e.preventDefault();
        const rawSample = ctx.clockReader.readCurrentSampleFrameAtomically();
        if (
          Number.isFinite(rawSample) &&
          Number.isFinite(ctx.sampleRate) &&
          ctx.sampleRate > 0
        ) {
          const curFlicks = TimeMath.samplesToFlicks(Math.max(0, rawSample), ctx.sampleRate);
          ctx.onSplitAtPlayhead(curFlicks);
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Primary React Studio Controller (Sections 23, 25 & 50-53)
 * - Prevents 60fps/120fps React tree freezes by keeping playhead coordinates out of React state.
 * - Updates Waveform Canvas directly in requestAnimationFrame via Atomics audio clock polling.
 * - Triggers React re-render only when binary search resolves a new activeTokenId (2-3x/sec).
 */
export function useAudioStudioController(params: {
  txEngine: TimelineTransactionEngine;
  clockReader: AudioClockSharedMemoryReader;
  tokens: TimedPersianToken[];
  waveformLods: WaveformLodBuffer[];
  sampleRate: SampleRate;
  roomToneSourceRange: TimeRange;
  onSplitAtPlayhead?: (playheadFlicks: Flicks) => void;
}) {
  const {
    txEngine,
    clockReader,
    tokens,
    waveformLods,
    sampleRate,
    roomToneSourceRange,
    onSplitAtPlayhead,
  } = params;

  const [projectDoc, setProjectDoc] = useState<ProjectDocument>(() =>
    txEngine.getActiveState(),
  );
  const [activeTokenId, setActiveTokenId] = useState<string | null>(null);
  const [shuttleSpeed, setShuttleSpeed] = useState<number>(1.0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRangeRef = useRef<TimeRange>({
    start: 0,
    end: TimeMath.secondsToFlicks(30),
  });
  const lastActiveTokenIdRef = useRef<string | null>(null);
  const shuttleSpeedRef = useRef<number>(1.0);
  const recommendationsRef = useRef(projectDoc.recommendations);
  recommendationsRef.current = projectDoc.recommendations;

  const findActiveTokenId = useCallback(
    (playheadFlicks: Flicks): string | null => findActiveTokenIdAtFlicks(tokens, playheadFlicks),
    [tokens],
  );

  // 1. Direct 60fps/120fps Canvas render loop bypassing React reconciliation
  useEffect(() => {
    let rafId = 0;

    const renderLoop = () => {
      const rawSample = clockReader.readCurrentSampleFrameAtomically();
      const currentSample = Number.isFinite(rawSample) ? Math.max(0, rawSample) : 0;
      const safeRate =
        Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
      const currentFlicks = TimeMath.samplesToFlicks(currentSample, safeRate);

      const canvas = canvasRef.current;
      if (canvas && waveformLods.length > 0) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          viewportRangeRef.current = computeAutoScrollViewport(
            viewportRangeRef.current,
            currentFlicks,
            clockReader.isPlaying(),
          );

          const bestLod = LodWaveformCanvasRenderer.selectBestLod(
            waveformLods,
            viewportRangeRef.current,
            canvas.width,
            sampleRate,
          );

          const pendingSpliceDescriptors = recommendationsRef.current
            .filter((r) => r.status === 'PENDING')
            .map((r) => r.spliceDescriptor);

          LodWaveformCanvasRenderer.renderViewport(
            ctx,
            canvas.width,
            canvas.height,
            bestLod,
            viewportRangeRef.current,
            currentFlicks,
            sampleRate,
            pendingSpliceDescriptors,
          );
        }
      }

      // Only notify React when playhead crosses into a new Persian token boundary
      const matchedTokenId = findActiveTokenId(currentFlicks);
      if (matchedTokenId !== lastActiveTokenIdRef.current) {
        lastActiveTokenIdRef.current = matchedTokenId;
        setActiveTokenId(matchedTokenId);
      }

      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafId);
  }, [clockReader, sampleRate, waveformLods, findActiveTokenId]);

  // 2. Transactional Undo / Redo & Smart Splice Acceptance
  const handleUndo = useCallback(() => {
    const prevDoc = txEngine.undo();
    if (prevDoc) setProjectDoc({ ...prevDoc });
  }, [txEngine]);

  const handleRedo = useCallback(() => {
    const nextDoc = txEngine.redo();
    if (nextDoc) setProjectDoc({ ...nextDoc });
  }, [txEngine]);

  const handleAcceptRecommendation = useCallback(
    (recId: RecommendationId) => {
      txEngine.applySmartSpliceRecommendation(recId, roomToneSourceRange);
      setProjectDoc({ ...txEngine.getActiveState() });
    },
    [txEngine, roomToneSourceRange],
  );

  // 3. Professional Audio Editing Shortcuts (Space, J/K/L, S, Ctrl+Z, Ctrl+Shift+Z)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      dispatchStudioShortcutKeyDown(e, {
        clockReader,
        sampleRate,
        currentShuttleSpeed: shuttleSpeedRef.current,
        onSetShuttleSpeed: (speed) => {
          shuttleSpeedRef.current = speed;
          setShuttleSpeed(speed);
        },
        onUndo: handleUndo,
        onRedo: handleRedo,
        onSplitAtPlayhead,
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clockReader, handleUndo, handleRedo, sampleRate, onSplitAtPlayhead]);

  const setViewportRange = useCallback((newRange: TimeRange) => {
    viewportRangeRef.current = newRange;
  }, []);

  return {
    projectDoc,
    activeTokenId,
    shuttleSpeed,
    canvasRef,
    setViewportRange,
    handleUndo,
    handleRedo,
    handleAcceptRecommendation,
  };
}
