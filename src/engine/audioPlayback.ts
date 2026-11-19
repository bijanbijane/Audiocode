import {
  AudioAsset,
  EphemeralDspParams,
  ExportValidationReport,
  FlickRange,
  Track,
} from '../contracts/v1_2';
import { CompiledRenderPlan } from '../processing-core/ProcessingGraphEngine';
import { ParallelChunkRenderCoordinator } from '../processing-core/ParallelChunkRenderCoordinator';
import {
  StreamingWavExportEncoder,
  WavSyncAccessTarget,
} from '../processing-core/StreamingExportEncoder';
import { applyEqualPowerMicroCrossfade, synthesizeRoomToneFill } from './dsp';
import { processChunkWithPreRoll } from './processingGraph';
import { computeTimelineDurationFlicks } from './timeline';
import { flicksToSamples, flicksToSeconds } from './timebase';

export type ReadAssetRangeFn = (
  assetId: string,
  startSample: number,
  length: number,
) => Promise<Float32Array>;

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
  preRollSamples?: number;
}): Float32Array {
  const {
    tracks,
    assets,
    pcmSources,
    sampleRate,
    rangeFlicks,
    dspParams,
    preRollSamples = 2400, // 50ms default pre-roll priming
  } = params;

  const startSample = Math.max(0, flicksToSamples(rangeFlicks.startFlicks, sampleRate));
  const endSample = Math.max(startSample, flicksToSamples(rangeFlicks.endFlicks, sampleRate));
  const outLen = endSample - startSample;
  if (outLen <= 0) return new Float32Array(0);

  // Extended window [renderStart .. endSample) for Pre-Roll state priming
  const renderStart = Math.max(0, startSample - preRollSamples);
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
      const fadeInSamples = Math.round((clip.fadeInMs * sampleRate) / 1000);
      const fadeOutSamples = Math.round((clip.fadeOutMs * sampleRate) / 1000);

      if (clip.kind === 'room-tone-fill') {
        const asset = assets[clip.assetId];
        if (!asset) continue;
        const fill = synthesizeRoomToneFill(asset.acousticProfile, overlapEnd - overlapStart);
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

        mixBuf[tlSample - renderStart] += src[srcIdx] * clipGain * env;
      }
    }
  }

  return processChunkWithPreRoll(mixBuf, actualPreRoll, sampleRate, dspParams);
}

/**
 * Renders the full timeline in streaming chunks (keeping peak memory bounded)
 * for Export without loading a giant multi-hour mix buffer at once.
 */
export function streamingChunkedRender(params: {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources: Record<string, Float32Array>;
  sampleRate: number;
  dspParams: EphemeralDspParams;
  chunkSeconds?: number;
  onProgress?: (pct: number) => void;
}): Float32Array {
  const totalFlicks = computeTimelineDurationFlicks(params.tracks);
  const totalSamples = flicksToSamples(totalFlicks, params.sampleRate);
  if (totalSamples <= 0) return new Float32Array(0);

  const chunkSec = params.chunkSeconds ?? 2.0;
  const chunkSamples = Math.round(chunkSec * params.sampleRate);
  const out = new Float32Array(totalSamples);
  const preRollSamples = Math.round(params.sampleRate * 0.08); // 80ms Pre-Roll priming

  let cursor = 0;
  while (cursor < totalSamples) {
    const nextCursor = Math.min(totalSamples, cursor + chunkSamples);
    const startFlicks = Math.round((cursor / params.sampleRate) * 705_600_000);
    const endFlicks = Math.round((nextCursor / params.sampleRate) * 705_600_000);
    const chunkPcm = renderTimelineRangeToPcm({
      ...params,
      rangeFlicks: { startFlicks, endFlicks },
      preRollSamples,
    });
    out.set(chunkPcm.subarray(0, nextCursor - cursor), cursor);
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
    });
  }

  // After edit: render left + right seamlessly with Equal-Power Micro-Crossfade
  const totalDurSec = flicksToSeconds(computeTimelineDurationFlicks(params.tracksAfterEdit));
  const previewEndSec = Math.min(totalDurSec, cutStartSec + contextSec * 1.3);
  const rendered = renderTimelineRangeToPcm({
    tracks: params.tracksAfterEdit,
    assets: params.assets,
    pcmSources: params.pcmSources,
    sampleRate: params.sampleRate,
    rangeFlicks: {
      startFlicks: Math.round(previewStartSec * 705_600_000),
      endFlicks: Math.round(previewEndSec * 705_600_000),
    },
    dspParams: params.dspParams,
  });

  // Ensure smooth micro-fade on splice boundary
  const spliceSample = Math.round((cutStartSec - previewStartSec) * params.sampleRate);
  const xfLen = Math.min(480, Math.floor(rendered.length / 4));
  if (spliceSample > xfLen && spliceSample + xfLen < rendered.length) {
    const left = rendered.slice(spliceSample - xfLen, spliceSample);
    const right = rendered.slice(spliceSample, spliceSample + xfLen);
    const blended = applyEqualPowerMicroCrossfade(left, right);
    rendered.set(blended, spliceSample - Math.floor(xfLen / 2));
  }
  return rendered;
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

  private ensureContext(sampleRate: number): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ sampleRate });
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Plays a timeline range using progressive 4-second windowed buffer scheduling
   * so long podcast timelines play immediately without allocating a huge single Float32Array.
   */
  playTimelineWindowed(params: {
    tracks: Track[];
    assets: Record<string, AudioAsset>;
    pcmSources: Record<string, Float32Array>;
    sampleRate: number;
    startTimelineSec: number;
    totalDurationSec: number;
    endTimelineSec?: number;
    loop?: boolean;
    playbackRate?: number;
    dspParams: EphemeralDspParams;
    windowDurationSec?: number;
    onTick?: (timelineSec: number) => void;
    onMeter?: (peakDb: number, rmsDb: number) => void;
    onEnded?: () => void;
  }): void {
    this.stop();
    const {
      tracks,
      assets,
      pcmSources,
      sampleRate,
      startTimelineSec,
      totalDurationSec,
      endTimelineSec = totalDurationSec,
      loop = false,
      playbackRate = 1.0,
      dspParams,
      windowDurationSec = 4.0,
      onTick,
      onMeter,
      onEnded,
    } = params;

    const clampedEndSec = Math.min(totalDurationSec, Math.max(startTimelineSec, endTimelineSec));
    if (clampedEndSec <= startTimelineSec + 0.01) {
      onMeter?.(-60, -60);
      onEnded?.();
      return;
    }

    const ctx = this.ensureContext(sampleRate);
    this.startedAtCtxTime = ctx.currentTime;
    this.startOffsetSec = startTimelineSec;
    this.isPlaying = true;

    let scheduledUpToTimelineSec = startTimelineSec;
    const totalToPlaySec = clampedEndSec - startTimelineSec;
    const rate = Math.max(0.5, Math.min(2.0, playbackRate));
    const bufferedMeterBlocks: Array<{ startSec: number; endSec: number; pcm: Float32Array }> = [];

    const scheduleNextWindow = () => {
      if (!this.isPlaying || !this.ctx) return;
      if (scheduledUpToTimelineSec >= clampedEndSec - 0.005) return;

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
      });

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

    // Prime first two windows immediately
    scheduleNextWindow();
    scheduleNextWindow();

    const tick = () => {
      if (!this.isPlaying || !this.ctx) return;
      const elapsedTimelineSec = Math.max(0, (this.ctx.currentTime - this.startedAtCtxTime) * rate);
      const currentTimelineSec = this.startOffsetSec + elapsedTimelineSec;

      if (elapsedTimelineSec >= totalToPlaySec) {
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
    if (pcm.length === 0) {
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
