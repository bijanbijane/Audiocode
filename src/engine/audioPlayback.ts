import {
  AudioAsset,
  EphemeralDspParams,
  ExportValidationReport,
  FlickRange,
  Track,
} from '../contracts/v1_2';
import {
  StreamingWavExportEncoder,
  WavSyncAccessTarget,
} from '../processing-core/StreamingExportEncoder';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { synthesizeRoomToneFill } from './dsp';
import { DspBypassFlags, processChunkWithPreRoll } from './processingGraph';
import { computeTimelineDurationFlicks } from './timeline';
import { flicksToSamples, flicksToSeconds, samplesToFlicks } from './timebase';

export type ReadAssetRangeFn = (
  assetId: string,
  startSample: number,
  length: number,
) => Promise<Float32Array>;

export const MAX_LEGACY_FULL_RENDER_BYTES = 128 * 1024 * 1024;

/**
 * Renders the non-destructive multi-track timeline through the Processing Graph
 * using Pre-Roll State Priming and Equal-Power Micro-Crossfades.
 */
export function renderTimelineRangeToPcm(params: {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources: Record<string, Float32Array>;
  sampleRate: number;
  rangeFlicks: FlickRange;
  dspParams: EphemeralDspParams;
  dspBypassFlags?: DspBypassFlags;
  preRollSamples?: number;
}): Float32Array {
  const {
    tracks,
    assets,
    pcmSources,
    sampleRate,
    rangeFlicks,
    dspParams,
    dspBypassFlags,
    preRollSamples = 2400, // 50ms default pre-roll priming
  } = params;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return new Float32Array(0);
  }
  const safePreRoll = Number.isFinite(preRollSamples) ? Math.max(0, Math.floor(preRollSamples)) : 0;

  const startSample = Math.max(0, flicksToSamples(rangeFlicks.startFlicks, sampleRate));
  const endSample = Math.max(startSample, flicksToSamples(rangeFlicks.endFlicks, sampleRate));
  const outLen = endSample - startSample;
  if (outLen <= 0) return new Float32Array(0);

  // Extended window [renderStart .. endSample) for Pre-Roll state priming
  const renderStart = Math.max(0, startSample - safePreRoll);
  const actualPreRoll = startSample - renderStart;
  const mixLen = outLen + actualPreRoll;
  const mixBuf = new Float32Array(mixLen);

  const anySolo = tracks.some((t) => t.solo);

  for (const track of tracks) {
    if (track.muted) continue;
    if (anySolo && !track.solo) continue;

    const trackGain = Math.pow(10, track.gainDb / 20);

    for (const clip of track.clips) {
      if (clip.muted) continue;
      const clipStart = flicksToSamples(clip.timelineRange.startFlicks, sampleRate);
      const clipEnd = flicksToSamples(clip.timelineRange.endFlicks, sampleRate);

      const overlapStart = Math.max(renderStart, clipStart);
      const overlapEnd = Math.min(endSample, clipEnd);
      if (overlapEnd <= overlapStart) continue;

      const clipGain = trackGain * Math.pow(10, clip.gainDb / 20);
      const clipLenSamples = Math.max(0, clipEnd - clipStart);
      const maxFadeSamples = Math.floor(clipLenSamples * 0.45);
      const fadeInSamples = Math.min(maxFadeSamples, Math.max(0, Math.round((clip.fadeInMs * sampleRate) / 1000)));
      const fadeOutSamples = Math.min(maxFadeSamples, Math.max(0, Math.round((clip.fadeOutMs * sampleRate) / 1000)));

      if (clip.kind === 'room-tone-fill') {
        const asset = assets[clip.assetId];
        if (!asset) continue;
        const fill = synthesizeRoomToneFill(
          asset.acousticProfile,
          overlapEnd - overlapStart,
          overlapStart - clipStart,
        );
        for (let i = 0; i < fill.length; i++) {
          const tlSample = overlapStart + i;
          const distFromStart = tlSample - clipStart;
          const distFromEnd = clipEnd - tlSample;
          let env = 1.0;
          if (fadeInSamples > 0 && distFromStart < fadeInSamples) {
            env *= Math.sin((distFromStart / fadeInSamples) * Math.PI * 0.5);
          }
          if (fadeOutSamples > 0 && distFromEnd < fadeOutSamples) {
            env *= Math.sin((distFromEnd / fadeOutSamples) * Math.PI * 0.5);
          }
          mixBuf[tlSample - renderStart] += fill[i] * clipGain * env;
        }
        continue;
      }

      const src = pcmSources[clip.assetId];
      if (!src) continue;
      const srcOffsetBase = flicksToSamples(clip.sourceStartFlicks, sampleRate);

      for (let tlSample = overlapStart; tlSample < overlapEnd; tlSample++) {
        const srcIdx = srcOffsetBase + (tlSample - clipStart);
        if (srcIdx < 0 || srcIdx >= src.length) continue;

        const distFromStart = tlSample - clipStart;
        const distFromEnd = clipEnd - tlSample;
        let env = 1.0;
        if (fadeInSamples > 0 && distFromStart < fadeInSamples) {
          env *= Math.sin((distFromStart / fadeInSamples) * Math.PI * 0.5);
        }
        if (fadeOutSamples > 0 && distFromEnd < fadeOutSamples) {
          env *= Math.sin((distFromEnd / fadeOutSamples) * Math.PI * 0.5);
        }

        const rawSample = src[srcIdx];
        if (Number.isFinite(rawSample)) {
          mixBuf[tlSample - renderStart] += rawSample * clipGain * env;
        }
      }
    }
  }

  return processChunkWithPreRoll(mixBuf, actualPreRoll, sampleRate, dspParams, dspBypassFlags);
}

/**
 * Async block-backed timeline range renderer.
 * Reads ONLY the required sample windows from `readAssetRange` (e.g. StorageBrokerClient.streamReadRange)
 * when `pcmSources[clip.assetId]` is not resident in memory — enabling constant-RAM playback & export
 * of 30/60/120-minute projects directly from OPFS blocks.
 */
export async function renderTimelineRangeFromBlocks(params: {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  readAssetRange?: ReadAssetRangeFn;
  sampleRate: number;
  rangeFlicks: FlickRange;
  dspParams: EphemeralDspParams;
  dspBypassFlags?: DspBypassFlags;
  preRollSamples?: number;
  abortSignal?: AbortSignal;
}): Promise<Float32Array> {
  const {
    tracks,
    assets,
    pcmSources = {},
    readAssetRange,
    sampleRate,
    rangeFlicks,
    dspParams,
    dspBypassFlags,
    preRollSamples = 2400,
    abortSignal,
  } = params;

  if (abortSignal?.aborted) {
    throw new Error('RENDER_ABORTED: Timeline range render cancelled.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return new Float32Array(0);
  }
  const safePreRoll = Number.isFinite(preRollSamples) ? Math.max(0, Math.floor(preRollSamples)) : 0;

  const startSample = Math.max(0, flicksToSamples(rangeFlicks.startFlicks, sampleRate));
  const endSample = Math.max(startSample, flicksToSamples(rangeFlicks.endFlicks, sampleRate));
  const outLen = endSample - startSample;
  if (outLen <= 0) return new Float32Array(0);

  const renderStart = Math.max(0, startSample - safePreRoll);
  const actualPreRoll = startSample - renderStart;
  const mixLen = outLen + actualPreRoll;
  const mixBuf = new Float32Array(mixLen);

  const anySolo = tracks.some((t) => t.solo);

  for (const track of tracks) {
    if (abortSignal?.aborted) {
      throw new Error('RENDER_ABORTED: Timeline range render cancelled.');
    }
    if (track.muted) continue;
    if (anySolo && !track.solo) continue;

    const trackGain = Math.pow(10, track.gainDb / 20);

    for (const clip of track.clips) {
      if (clip.muted) continue;
      const clipStart = flicksToSamples(clip.timelineRange.startFlicks, sampleRate);
      const clipEnd = flicksToSamples(clip.timelineRange.endFlicks, sampleRate);

      const overlapStart = Math.max(renderStart, clipStart);
      const overlapEnd = Math.min(endSample, clipEnd);
      if (overlapEnd <= overlapStart) continue;

      const clipGain = trackGain * Math.pow(10, clip.gainDb / 20);
      const clipLenSamples = Math.max(0, clipEnd - clipStart);
      const maxFadeSamples = Math.floor(clipLenSamples * 0.45);
      const fadeInSamples = Math.min(maxFadeSamples, Math.max(0, Math.round((clip.fadeInMs * sampleRate) / 1000)));
      const fadeOutSamples = Math.min(maxFadeSamples, Math.max(0, Math.round((clip.fadeOutMs * sampleRate) / 1000)));

      if (clip.kind === 'room-tone-fill') {
        const asset = assets[clip.assetId];
        if (!asset) continue;
        const fill = synthesizeRoomToneFill(
          asset.acousticProfile,
          overlapEnd - overlapStart,
          overlapStart - clipStart,
        );
        for (let i = 0; i < fill.length; i++) {
          const tlSample = overlapStart + i;
          const distFromStart = tlSample - clipStart;
          const distFromEnd = clipEnd - tlSample;
          let env = 1.0;
          if (fadeInSamples > 0 && distFromStart < fadeInSamples) {
            env *= Math.sin((distFromStart / fadeInSamples) * Math.PI * 0.5);
          }
          if (fadeOutSamples > 0 && distFromEnd < fadeOutSamples) {
            env *= Math.sin((distFromEnd / fadeOutSamples) * Math.PI * 0.5);
          }
          mixBuf[tlSample - renderStart] += fill[i] * clipGain * env;
        }
        continue;
      }

      const srcOffsetBase = flicksToSamples(clip.sourceStartFlicks, sampleRate);
      const reqSrcStart = Math.max(0, srcOffsetBase + (overlapStart - clipStart));
      const reqSrcLen = overlapEnd - overlapStart;

      const resident = pcmSources[clip.assetId];
      let slicePcm: Float32Array | null = null;
      let sliceOrigin = 0;

      if (resident) {
        slicePcm = resident;
        sliceOrigin = 0;
      } else if (readAssetRange) {
        slicePcm = await readAssetRange(clip.assetId, reqSrcStart, reqSrcLen);
        sliceOrigin = reqSrcStart;
        if (abortSignal?.aborted) {
          throw new Error('RENDER_ABORTED: Timeline range render cancelled.');
        }
      }

      if (!slicePcm || slicePcm.length === 0) continue;

      for (let tlSample = overlapStart; tlSample < overlapEnd; tlSample++) {
        const srcIdx = srcOffsetBase + (tlSample - clipStart) - sliceOrigin;
        if (srcIdx < 0 || srcIdx >= slicePcm.length) continue;

        const distFromStart = tlSample - clipStart;
        const distFromEnd = clipEnd - tlSample;
        let env = 1.0;
        if (fadeInSamples > 0 && distFromStart < fadeInSamples) {
          env *= Math.sin((distFromStart / fadeInSamples) * Math.PI * 0.5);
        }
        if (fadeOutSamples > 0 && distFromEnd < fadeOutSamples) {
          env *= Math.sin((distFromEnd / fadeOutSamples) * Math.PI * 0.5);
        }

        const rawSample = slicePcm[srcIdx];
        if (Number.isFinite(rawSample)) {
          mixBuf[tlSample - renderStart] += rawSample * clipGain * env;
        }
      }
    }
  }

  return processChunkWithPreRoll(mixBuf, actualPreRoll, sampleRate, dspParams, dspBypassFlags);
}

/**
 * Streams a multi-track timeline chunk-by-chunk directly into a `WavSyncAccessTarget`
 * via `StreamingWavExportEncoder`, keeping peak RAM O(chunkSize) and enforcing
 * `MemoryBudgetManager` reservations + clean cancellation teardown.
 */
export async function streamExportTimelineToWav(params: {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  readAssetRange?: ReadAssetRangeFn;
  sampleRate: number;
  channels?: 1 | 2;
  bitDepth?: 16 | 24;
  dspParams: EphemeralDspParams;
  dspBypassFlags?: DspBypassFlags;
  target: WavSyncAccessTarget;
  memoryBudgetManager?: MemoryBudgetManager;
  chunkSeconds?: number;
  abortSignal?: AbortSignal;
  onCleanupAbortedTarget?: () => void | Promise<void>;
  onProgress?: (progress: {
    chunksCompleted: number;
    totalChunks: number;
    samplesWritten: number;
    totalSamples: number;
    percent: number;
  }) => void;
}): Promise<{
  totalSamplesWritten: number;
  totalBytesWritten: number;
  chunksProcessed: number;
  sampleRate: number;
  channels: 1 | 2;
  bitDepth: 16 | 24;
  peakLinear: number;
}> {
  const {
    tracks,
    assets,
    pcmSources = {},
    readAssetRange,
    sampleRate,
    channels = 1,
    bitDepth = 16,
    dspParams,
    dspBypassFlags,
    target,
    memoryBudgetManager,
    chunkSeconds = 2.0,
    abortSignal,
    onCleanupAbortedTarget,
    onProgress,
  } = params;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`EXPORT_INVALID_SAMPLE_RATE: Invalid sample rate ${sampleRate}`);
  }

  const totalFlicks = computeTimelineDurationFlicks(tracks);
  const totalSamples = flicksToSamples(totalFlicks, sampleRate);
  if (totalSamples <= 0) {
    throw new Error('EXPORT_EMPTY_TIMELINE: Timeline has zero audio samples to export.');
  }

  const safeChunkSec = Math.max(0.25, Math.min(8.0, Number.isFinite(chunkSeconds) ? chunkSeconds : 2.0));
  const chunkSamples = Math.max(1, Math.round(safeChunkSec * sampleRate));
  const preRollSamples = Math.round(sampleRate * 0.08);
  const totalChunks = Math.ceil(totalSamples / chunkSamples);

  const estimatedChunkBytes =
    (chunkSamples + preRollSamples) * Float32Array.BYTES_PER_ELEMENT * (channels + 1) +
    chunkSamples * channels * (bitDepth / 8);

  const encoder = new StreamingWavExportEncoder(target, {
    profileId: `STREAM_WAV_${bitDepth}BIT_${channels}CH`,
    profileVersion: 1,
    nameFa: `Streaming WAV ${sampleRate}Hz ${bitDepth}-bit`,
    sampleRate: sampleRate as 16000 | 44100 | 48000 | 96000,
    channelCount: channels,
    bitDepth,
    targetLufs: -16,
    truePeakCeilingDbtp: -1,
    applyTpdfDither: false,
  });
  let samplesWritten = 0;
  let chunksProcessed = 0;
  let peakLinear = 0;

  try {
    encoder.beginStreamingExport();

    let cursor = 0;
    while (cursor < totalSamples) {
      if (abortSignal?.aborted) {
        throw new Error('EXPORT_ABORTED: Streaming WAV export cancelled by caller.');
      }

      const nextCursor = Math.min(totalSamples, cursor + chunkSamples);
      const startFlicks = samplesToFlicks(cursor, sampleRate);
      const endFlicks = samplesToFlicks(nextCursor, sampleRate);

      const res = memoryBudgetManager?.reserve({
        owner: `streaming-wav-export-chunk-${chunksProcessed}`,
        category: 'render-export-buffers',
        bytes: estimatedChunkBytes,
        priority: 'normal',
        releasable: true,
      });

      try {
        const chunkMono = await renderTimelineRangeFromBlocks({
          tracks,
          assets,
          pcmSources,
          readAssetRange,
          sampleRate,
          rangeFlicks: { startFlicks, endFlicks },
          dspParams,
          dspBypassFlags,
          preRollSamples,
          abortSignal,
        });

        const exactLen = Math.min(chunkMono.length, nextCursor - cursor);
        const trimmed = exactLen === chunkMono.length ? chunkMono : chunkMono.subarray(0, exactLen);
        for (let i = 0; i < trimmed.length; i++) {
          const abs = Math.abs(trimmed[i]);
          if (Number.isFinite(abs) && abs > peakLinear) peakLinear = abs;
        }

        const channelPlanes = channels === 2 ? [trimmed, trimmed] : [trimmed];
        encoder.pushRenderedChunk(channelPlanes);
        samplesWritten += trimmed.length;
        chunksProcessed++;
        cursor = nextCursor;

        onProgress?.({
          chunksCompleted: chunksProcessed,
          totalChunks,
          samplesWritten,
          totalSamples,
          percent: Math.min(100, Math.round((samplesWritten / totalSamples) * 100)),
        });
      } finally {
        if (res) {
          memoryBudgetManager?.release(res);
        }
      }
    }

    const finalized = encoder.finalizeStreamingExport();
    return {
      totalSamplesWritten: samplesWritten,
      totalBytesWritten: finalized.totalBytes,
      chunksProcessed,
      sampleRate,
      channels,
      bitDepth,
      peakLinear,
    };
  } catch (err) {
    try {
      target.truncate(0);
    } catch {
      // ignore truncation failure on aborted target
    }
    try {
      await onCleanupAbortedTarget?.();
    } catch {
      // ignore cleanup errors after failure
    }
    throw err;
  }
}

/**
 * Legacy short-clip contiguous render helper.
 * Guarded against unbounded multi-hour RAM allocation (use `streamExportTimelineToWav`
 * or `src/audio-renderer` for long exports).
 */
export function streamingChunkedRender(params: {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources: Record<string, Float32Array>;
  sampleRate: number;
  dspParams: EphemeralDspParams;
  dspBypassFlags?: DspBypassFlags;
  chunkSeconds?: number;
  maxOutputBytes?: number;
  onProgress?: (pct: number) => void;
}): Float32Array {
  if (!Number.isFinite(params.sampleRate) || params.sampleRate <= 0) {
    return new Float32Array(0);
  }
  const totalFlicks = computeTimelineDurationFlicks(params.tracks);
  const totalSamples = flicksToSamples(totalFlicks, params.sampleRate);
  if (totalSamples <= 0) return new Float32Array(0);

  const requiredBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  const maxBytes = params.maxOutputBytes ?? MAX_LEGACY_FULL_RENDER_BYTES;
  if (requiredBytes > maxBytes) {
    throw new RangeError(
      `MEMORY_LIMIT_EXCEEDED: Contiguous render buffer (${requiredBytes} B) exceeds safe limit (${maxBytes} B). Use streamExportTimelineToWav() for long timelines.`,
    );
  }

  const rawChunkSec = params.chunkSeconds ?? 2.0;
  const chunkSec = Number.isFinite(rawChunkSec) && rawChunkSec > 0 ? Math.max(0.05, rawChunkSec) : 2.0;
  const chunkSamples = Math.max(1, Math.round(chunkSec * params.sampleRate));
  const out = new Float32Array(totalSamples);
  const preRollSamples = Math.round(params.sampleRate * 0.08); // 80ms Pre-Roll priming

  let cursor = 0;
  while (cursor < totalSamples) {
    const nextCursor = Math.min(totalSamples, cursor + chunkSamples);
    const startFlicks = samplesToFlicks(cursor, params.sampleRate);
    const endFlicks = samplesToFlicks(nextCursor, params.sampleRate);
    const chunkPcm = renderTimelineRangeToPcm({
      ...params,
      rangeFlicks: { startFlicks, endFlicks },
      preRollSamples,
    });
    const copyLen = Math.min(chunkPcm.length, nextCursor - cursor);
    out.set(chunkPcm.subarray(0, copyLen), cursor);
    cursor = nextCursor;
    params.onProgress?.(Math.round((cursor / totalSamples) * 100));
  }

  return out;
}

/**
 * Builds a Before/After splice preview buffer around a cut range (±1.2s context)
 * with Equal-Power Micro-Crossfade applied cleanly at the cut join.
 */
export function buildSplicePreviewBuffer(params: {
  tracksAfterEdit: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources: Record<string, Float32Array>;
  sampleRate: number;
  cutRange: FlickRange;
  dspParams: EphemeralDspParams;
  dspBypassFlags?: DspBypassFlags;
  mode: 'before' | 'after';
  tracksBeforeEdit: Track[];
}): Float32Array {
  const contextSec = 1.1;
  const cutStartSec = flicksToSeconds(params.cutRange.startFlicks);
  const cutEndSec = flicksToSeconds(params.cutRange.endFlicks);
  const previewStartSec = Math.max(0, cutStartSec - contextSec);

  if (params.mode === 'before') {
    const previewEndSec = cutEndSec + contextSec;
    return renderTimelineRangeToPcm({
      tracks: params.tracksBeforeEdit,
      assets: params.assets,
      pcmSources: params.pcmSources,
      sampleRate: params.sampleRate,
      rangeFlicks: {
        startFlicks: Math.round(previewStartSec * 705_600_000),
        endFlicks: Math.round(previewEndSec * 705_600_000),
      },
      dspParams: params.dspParams,
      dspBypassFlags: params.dspBypassFlags,
    });
  }

  // After edit: render left + right seamlessly (cut/split clip boundaries already enforce 10ms equal-power micro-fades)
  const totalDurSec = flicksToSeconds(computeTimelineDurationFlicks(params.tracksAfterEdit));
  const previewEndSec = Math.min(totalDurSec, cutStartSec + contextSec * 1.3);
  return renderTimelineRangeToPcm({
    tracks: params.tracksAfterEdit,
    assets: params.assets,
    pcmSources: params.pcmSources,
    sampleRate: params.sampleRate,
    rangeFlicks: {
      startFlicks: Math.round(previewStartSec * 705_600_000),
      endFlicks: Math.round(previewEndSec * 705_600_000),
    },
    dspParams: params.dspParams,
    dspBypassFlags: params.dspBypassFlags,
  });
}

/**
 * Web Audio Transport Controller managing Play/Pause/Seek, Preview playback,
 * and Windowed Chunk Scheduling (no main-thread freeze on 60-minute projects!)
 * with AudioContext.currentTime synchronization.
 */
export class StudioAudioTransport {
  private ctx: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private activeNodes: Set<AudioBufferSourceNode> = new Set();
  private startedAtCtxTime = 0;
  private startOffsetSec = 0;
  private rafId: number | null = null;
  private isPlaying = false;
  private activeSessionToken: symbol | null = null;

  private ensureContext(sampleRate: number): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try {
        this.ctx =
          Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000
            ? new AudioCtx({ sampleRate })
            : new AudioCtx();
      } catch {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Plays a timeline range using progressive 4-second windowed buffer scheduling
   * so long podcast timelines play immediately without allocating a huge single Float32Array.
   * Supports both resident `pcmSources` and async OPFS block-backed `readAssetRange`.
   */
  playTimelineWindowed(params: {
    tracks: Track[];
    assets: Record<string, AudioAsset>;
    pcmSources: Record<string, Float32Array>;
    readAssetRange?: ReadAssetRangeFn;
    sampleRate: number;
    startTimelineSec: number;
    totalDurationSec: number;
    endTimelineSec?: number;
    loop?: boolean;
    playbackRate?: number;
    dspParams: EphemeralDspParams;
    dspBypassFlags?: DspBypassFlags;
    windowDurationSec?: number;
    onTick?: (timelineSec: number) => void;
    onMeter?: (peakDb: number, rmsDb: number) => void;
    onError?: (err: Error) => void;
    onEnded?: () => void;
  }): void {
    this.stop();
    const {
      tracks,
      assets,
      pcmSources,
      readAssetRange,
      sampleRate,
      startTimelineSec,
      totalDurationSec,
      endTimelineSec = totalDurationSec,
      loop = false,
      playbackRate = 1.0,
      dspParams,
      dspBypassFlags,
      windowDurationSec = 4.0,
      onTick,
      onMeter,
      onError,
      onEnded,
    } = params;

    const clampedEndSec = Math.min(totalDurationSec, Math.max(startTimelineSec, endTimelineSec));
    if (clampedEndSec <= startTimelineSec + 0.01) {
      onMeter?.(-60, -60);
      onEnded?.();
      return;
    }

    const ctx = this.ensureContext(sampleRate);
    let anchorInitialized = false;
    this.startedAtCtxTime = ctx.currentTime + 0.03;
    this.startOffsetSec = startTimelineSec;
    this.isPlaying = true;
    const playbackSessionToken = Symbol('playback');
    this.activeSessionToken = playbackSessionToken;

    let scheduledUpToTimelineSec = startTimelineSec;
    let isSchedulingAsyncWindow = false;
    const totalToPlaySec = clampedEndSec - startTimelineSec;
    const rate = Math.max(0.5, Math.min(2.0, playbackRate));
    const bufferedMeterBlocks: Array<{ startSec: number; endSec: number; pcm: Float32Array }> = [];

    const hasAllResidentSources = tracks.every((t) =>
      t.clips.every((c) => c.kind === 'room-tone-fill' || Boolean(pcmSources[c.assetId])),
    );

    const commitRenderedWindow = (winStartSec: number, winEndSec: number, chunkPcm: Float32Array) => {
      if (!this.isPlaying || !this.ctx || this.activeSessionToken !== playbackSessionToken) return;
      if (chunkPcm.length === 0) return;

      bufferedMeterBlocks.push({ startSec: winStartSec, endSec: winEndSec, pcm: chunkPcm });
      if (bufferedMeterBlocks.length > 6) bufferedMeterBlocks.shift();

      const audioBuf = ctx.createBuffer(1, chunkPcm.length, sampleRate);
      audioBuf.copyToChannel(new Float32Array(chunkPcm), 0);

      const node = ctx.createBufferSource();
      node.buffer = audioBuf;
      node.playbackRate.value = rate;
      node.connect(ctx.destination);
      this.activeNodes.add(node);

      if (!anchorInitialized) {
        this.startedAtCtxTime = ctx.currentTime + 0.025;
        anchorInitialized = true;
      }

      const offsetFromPlayStartSec = (winStartSec - startTimelineSec) / rate;
      const targetCtxStartTime = Math.max(
        ctx.currentTime,
        this.startedAtCtxTime + offsetFromPlayStartSec,
      );

      node.onended = () => {
        this.activeNodes.delete(node);
      };

      node.start(targetCtxStartTime);
    };

    const scheduleNextWindow = () => {
      if (!this.isPlaying || !this.ctx || this.activeSessionToken !== playbackSessionToken) return;
      if (scheduledUpToTimelineSec >= clampedEndSec - 0.005) return;

      if (hasAllResidentSources || !readAssetRange) {
        const winStartSec = scheduledUpToTimelineSec;
        const winEndSec = Math.min(clampedEndSec, winStartSec + windowDurationSec);
        scheduledUpToTimelineSec = winEndSec;

        const chunkPcm = renderTimelineRangeToPcm({
          tracks,
          assets,
          pcmSources,
          sampleRate,
          rangeFlicks: {
            startFlicks: Math.round(winStartSec * 705_600_000),
            endFlicks: Math.round(winEndSec * 705_600_000),
          },
          dspParams,
          dspBypassFlags,
        });
        commitRenderedWindow(winStartSec, winEndSec, chunkPcm);
        return;
      }

      if (isSchedulingAsyncWindow) return;
      isSchedulingAsyncWindow = true;
      const winStartSec = scheduledUpToTimelineSec;
      const winEndSec = Math.min(clampedEndSec, winStartSec + windowDurationSec);
      scheduledUpToTimelineSec = winEndSec;

      void renderTimelineRangeFromBlocks({
        tracks,
        assets,
        pcmSources,
        readAssetRange,
        sampleRate,
        rangeFlicks: {
          startFlicks: Math.round(winStartSec * 705_600_000),
          endFlicks: Math.round(winEndSec * 705_600_000),
        },
        dspParams,
        dspBypassFlags,
      })
        .then((chunkPcm) => {
          isSchedulingAsyncWindow = false;
          commitRenderedWindow(winStartSec, winEndSec, chunkPcm);
          if (
            this.isPlaying &&
            this.activeSessionToken === playbackSessionToken &&
            scheduledUpToTimelineSec < clampedEndSec - 0.005 &&
            scheduledUpToTimelineSec - startTimelineSec < windowDurationSec * 2
          ) {
            scheduleNextWindow();
          }
        })
        .catch((err) => {
          isSchedulingAsyncWindow = false;
          if (this.activeSessionToken !== playbackSessionToken) return;
          this.stop();
          onMeter?.(-60, -60);
          onError?.(err instanceof Error ? err : new Error(String(err)));
          onEnded?.();
        });
    };

    // Prime first two windows immediately
    scheduleNextWindow();
    if (hasAllResidentSources || !readAssetRange) {
      scheduleNextWindow();
    }

    const tick = () => {
      if (!this.isPlaying || !this.ctx || this.activeSessionToken !== playbackSessionToken) return;
      const elapsedTimelineSec = anchorInitialized
        ? Math.max(0, (this.ctx.currentTime - this.startedAtCtxTime) * rate)
        : 0;
      const currentTimelineSec = this.startOffsetSec + elapsedTimelineSec;

      if (anchorInitialized && elapsedTimelineSec >= totalToPlaySec) {
        if (loop) {
          this.playTimelineWindowed(params);
          return;
        }
        this.isPlaying = false;
        this.stop();
        onMeter?.(-60, -60);
        onTick?.(clampedEndSec);
        onEnded?.();
        return;
      }

      // Live Peak & RMS meter reading around current playhead
      if (onMeter) {
        const blk = bufferedMeterBlocks.find(
          (b) => currentTimelineSec >= b.startSec && currentTimelineSec < b.endSec,
        );
        if (blk) {
          const localIdx = Math.floor((currentTimelineSec - blk.startSec) * sampleRate);
          const winEnd = Math.min(blk.pcm.length, localIdx + Math.round(sampleRate * 0.04));
          let peak = 0;
          let sumSq = 0;
          let count = 0;
          for (let i = Math.max(0, localIdx); i < winEnd; i++) {
            const v = Math.abs(blk.pcm[i]);
            if (v > peak) peak = v;
            sumSq += blk.pcm[i] * blk.pcm[i];
            count++;
          }
          const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
          const peakDb = peak > 1e-4 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
          const rmsDb = rms > 1e-4 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
          onMeter(Number(peakDb.toFixed(1)), Number(rmsDb.toFixed(1)));
        }
      }

      // Keep at least 3.5 seconds buffered ahead of playhead
      if (
        scheduledUpToTimelineSec < clampedEndSec &&
        scheduledUpToTimelineSec - currentTimelineSec < 3.5 * rate
      ) {
        scheduleNextWindow();
      }

      onTick?.(currentTimelineSec);
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  playBuffer(
    pcm: Float32Array,
    sampleRate: number,
    startTimelineSec: number,
    onTick?: (timelineSec: number) => void,
    onEnded?: () => void,
  ): void {
    this.stop();
    if (pcm.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      onEnded?.();
      return;
    }

    const ctx = this.ensureContext(sampleRate);
    const audioBuf = ctx.createBuffer(1, pcm.length, sampleRate);
    audioBuf.copyToChannel(new Float32Array(pcm), 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);

    this.sourceNode = src;
    this.activeNodes.add(src);
    this.startedAtCtxTime = ctx.currentTime;
    this.startOffsetSec = startTimelineSec;
    this.isPlaying = true;

    const totalSec = pcm.length / sampleRate;

    src.onended = () => {
      this.activeNodes.delete(src);
      if (this.sourceNode === src) {
        this.isPlaying = false;
        this.stopRaf();
        onEnded?.();
      }
    };

    src.start(0);

    const tick = () => {
      if (!this.isPlaying || !this.ctx) return;
      const elapsed = Math.max(0, this.ctx.currentTime - this.startedAtCtxTime);
      if (elapsed >= totalSec) {
        this.isPlaying = false;
        this.rafId = null;
        onTick?.(startTimelineSec + totalSec);
        return;
      }
      onTick?.(this.startOffsetSec + elapsed);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  stop(): void {
    this.isPlaying = false;
    this.activeSessionToken = null;
    this.stopRaf();
    for (const node of this.activeNodes) {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch {
        // Ignore already-stopped source
      }
    }
    this.activeNodes.clear();
    this.sourceNode = null;
  }

  dispose(): void {
    this.stop();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
  }
}
