import {
  AudioAsset,
  PersianWordToken,
  RecommendationActionMode,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import { selectPeakLevel } from '../engine/peakPyramid';
import { flicksToSeconds } from '../engine/timebase';
import { applySyncSafeCut, computeTimelineDurationFlicks, determineSyncSafeEditMode } from '../engine/timeline';

export interface WaveformMiniBin {
  /** Normalized peak amplitude in [0, 1] for crisp symmetric mini-waveform rendering */
  peak: number;
  /** Normalized RMS amplitude in [0, 1] */
  rms: number;
  /** True when the sample bucket comes from a synthesized room-tone fill clip */
  isRoomTone: boolean;
}

export interface SuggestionWaveformPreviewData {
  recommendationId: string;
  trackId: string;
  trackName: string;
  effectiveMode: RecommendationActionMode;
  windowStartSec: number;
  windowEndSec: number;
  windowDurationSec: number;
  cutStartSec: number;
  cutEndSec: number;
  cutDurationSec: number;
  /** Normalized [0, 1] cut start position inside the Before window */
  cutStartRatio: number;
  /** Normalized [0, 1] cut end position inside the Before window */
  cutEndRatio: number;
  /** Resulting window duration after applying the suggestion */
  afterDurationSec: number;
  /** Fraction of the Before window width occupied by the After waveform (<= 1 for ripple cut, 1 for room-tone) */
  afterFillRatio: number;
  /** Normalized [0, 1] position of the splice seam inside the After window */
  spliceRatio: number;
  /** Exact seconds removed from the timeline (0 for sync-preserving room-tone replacement) */
  savedDurationSec: number;
  /** Average normalized RMS inside the targeted segment before edit */
  removedZoneRmsBefore: number;
  /** Average normalized RMS inside the targeted segment / post-splice zone after edit */
  afterZoneRms: number;
  beforeBins: WaveformMiniBin[];
  afterBins: WaveformMiniBin[];
}

interface RawBucketMetrics {
  peak: number;
  rms: number;
  isRoomTone: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sampleClipBucketFromPcmOrPyramid(params: {
  clipKind: 'speech' | 'room-tone-fill';
  assetId: string;
  srcStartSample: number;
  srcEndSample: number;
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
}): { peak: number; rms: number } {
  const { clipKind, assetId, srcStartSample, srcEndSample, assets, pcmSources } = params;
  const asset = assets[assetId];

  if (clipKind === 'room-tone-fill') {
    const rtRms = asset?.acousticProfile?.roomToneRms ?? 0.008;
    const bounded = Math.max(0.004, Math.min(0.06, rtRms));
    return { peak: bounded * 1.4, rms: bounded };
  }

  const pcm = pcmSources?.[assetId];
  if (pcm && pcm.length > 0) {
    const s = Math.max(0, Math.min(pcm.length, Math.floor(srcStartSample)));
    const e = Math.max(s, Math.min(pcm.length, Math.ceil(srcEndSample)));
    if (e <= s) return { peak: 0, rms: 0 };

    // Subsample large spans smoothly while keeping short windows sample-accurate
    const span = e - s;
    const stride = span > 256 ? Math.floor(span / 128) : 1;
    let peak = 0;
    let sumSq = 0;
    let count = 0;
    for (let i = s; i < e; i += stride) {
      const v = pcm[i];
      if (!Number.isFinite(v)) continue;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      count++;
    }
    return {
      peak,
      rms: count > 0 ? Math.sqrt(sumSq / count) : 0,
    };
  }

  // Fallback to Multi-Resolution PeakPyramid when raw PCM is evicted to OPFS
  if (asset?.peakPyramid && asset.peakPyramid.levels.length > 0) {
    const spanSamples = Math.max(1, srcEndSample - srcStartSample);
    const level = selectPeakLevel(asset.peakPyramid, spanSamples);
    if (level && level.max.length > 0) {
      const bStart = Math.max(
        0,
        Math.min(level.max.length - 1, Math.floor(srcStartSample / level.samplesPerBin)),
      );
      const bEnd = Math.max(
        bStart + 1,
        Math.min(level.max.length, Math.ceil(srcEndSample / level.samplesPerBin)),
      );
      let peak = 0;
      let rmsSum = 0;
      let count = 0;
      for (let b = bStart; b < bEnd; b++) {
        const p = Math.max(Math.abs(level.min[b] ?? 0), Math.abs(level.max[b] ?? 0));
        if (p > peak) peak = p;
        rmsSum += level.rms[b] ?? 0;
        count++;
      }
      return {
        peak,
        rms: count > 0 ? rmsSum / count : 0,
      };
    }
  }

  return { peak: 0, rms: 0 };
}

/**
 * Extracts raw un-normalized peak/RMS buckets for a single track over [windowStartSec, windowEndSec).
 */
export function extractTrackWindowBuckets(params: {
  track: Track | undefined;
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  sampleRate: number;
  windowStartSec: number;
  windowEndSec: number;
  binCount: number;
}): RawBucketMetrics[] {
  const { track, assets, pcmSources, sampleRate, windowStartSec, windowEndSec, binCount } = params;
  const safeBins = Math.max(8, Math.floor(binCount));
  const buckets: RawBucketMetrics[] = Array.from({ length: safeBins }, () => ({
    peak: 0,
    rms: 0,
    isRoomTone: false,
  }));

  if (!track || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return buckets;
  }

  const windowDurSec = windowEndSec - windowStartSec;
  if (!Number.isFinite(windowDurSec) || windowDurSec <= 1e-6) {
    return buckets;
  }

  const secPerBin = windowDurSec / safeBins;
  const trackGain = Math.pow(10, (Number.isFinite(track.gainDb) ? track.gainDb : 0) / 20);

  for (let b = 0; b < safeBins; b++) {
    const bStartSec = windowStartSec + b * secPerBin;
    const bEndSec = bStartSec + secPerBin;
    let maxPeak = 0;
    let sumSqRms = 0;
    let sawSpeech = false;
    let sawRoomTone = false;

    for (const clip of track.clips) {
      if (clip.muted) continue;
      const clipStartSec = flicksToSeconds(clip.timelineRange.startFlicks);
      const clipEndSec = flicksToSeconds(clip.timelineRange.endFlicks);
      const ovStart = Math.max(bStartSec, clipStartSec);
      const ovEnd = Math.min(bEndSec, clipEndSec);
      if (ovEnd <= ovStart) continue;

      const clipGain = trackGain * Math.pow(10, (Number.isFinite(clip.gainDb) ? clip.gainDb : 0) / 20);
      const clipSourceStartSec = flicksToSeconds(clip.sourceStartFlicks);
      const srcStartSec = clipSourceStartSec + (ovStart - clipStartSec);
      const srcEndSec = clipSourceStartSec + (ovEnd - clipStartSec);

      const sampled = sampleClipBucketFromPcmOrPyramid({
        clipKind: clip.kind,
        assetId: clip.assetId,
        srcStartSample: srcStartSec * sampleRate,
        srcEndSample: srcEndSec * sampleRate,
        assets,
        pcmSources,
      });

      const scaledPeak = sampled.peak * clipGain;
      const scaledRms = sampled.rms * clipGain;
      if (scaledPeak > maxPeak) maxPeak = scaledPeak;
      sumSqRms += scaledRms * scaledRms;

      if (clip.kind === 'room-tone-fill') {
        sawRoomTone = true;
      } else {
        sawSpeech = true;
      }
    }

    buckets[b] = {
      peak: maxPeak,
      rms: Math.sqrt(sumSqRms),
      isRoomTone: sawRoomTone && !sawSpeech,
    };
  }

  return buckets;
}

/**
 * Builds an exact before-vs-after mini-waveform preview for a SmartRecommendation
 * using the live timeline cut engine (`determineSyncSafeEditMode` + `applySyncSafeCut`),
 * guaranteeing the visual preview matches the actual non-destructive edit.
 */
export function buildSuggestionImpactPreview(params: {
  recommendation: SmartRecommendation;
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  tokens: PersianWordToken[];
  sampleRate: number;
  binCount?: number;
  contextPaddingSec?: number;
}): SuggestionWaveformPreviewData {
  const {
    recommendation,
    tracks,
    assets,
    pcmSources,
    tokens,
    sampleRate,
    binCount = 88,
    contextPaddingSec = 1.25,
  } = params;

  const targetTrackBefore =
    tracks.find((t) => t.id === recommendation.trackId) ?? tracks[0];
  const trackId = targetTrackBefore?.id ?? recommendation.trackId;
  const trackName = targetTrackBefore?.name ?? 'ترک اصلی';

  const totalTimelineSec = Math.max(
    0.1,
    flicksToSeconds(computeTimelineDurationFlicks(tracks)),
  );

  const rawCutStartSec = flicksToSeconds(recommendation.boundary.snappedRange.startFlicks);
  const rawCutEndSec = flicksToSeconds(recommendation.boundary.snappedRange.endFlicks);
  const cutStartSec = Math.max(0, Math.min(totalTimelineSec, rawCutStartSec));
  const cutEndSec = Math.max(cutStartSec, Math.min(totalTimelineSec, rawCutEndSec));
  const cutDurationSec = Math.max(0, cutEndSec - cutStartSec);

  const padSec = Math.max(0.65, Math.min(2.0, contextPaddingSec));
  const windowStartSec = Math.max(0, cutStartSec - padSec);
  const windowEndSec = Math.min(totalTimelineSec, Math.max(cutEndSec + padSec, windowStartSec + 0.5));
  const windowDurationSec = Math.max(0.1, windowEndSec - windowStartSec);

  // Mirror live sync-safety resolution used in App.tsx onAccept / onPreview
  const liveSafety = determineSyncSafeEditMode(
    tracks,
    trackId,
    recommendation.boundary.snappedRange,
    tokens,
    pcmSources,
    sampleRate,
  );
  const effectiveMode: RecommendationActionMode =
    recommendation.recommendedMode === 'in-place-room-tone-suppression' ||
    liveSafety.mode === 'in-place-room-tone-suppression'
      ? 'in-place-room-tone-suppression'
      : 'sync-locked-ripple-cut';

  const tracksAfter =
    cutDurationSec > 0
      ? applySyncSafeCut(tracks, trackId, recommendation.boundary.snappedRange, effectiveMode)
      : tracks;
  const targetTrackAfter =
    tracksAfter.find((t) => t.id === trackId) ?? tracksAfter[0];

  const isRipple = effectiveMode === 'sync-locked-ripple-cut';
  const savedDurationSec = isRipple ? cutDurationSec : 0;
  const afterDurationSec = Math.max(0.05, windowDurationSec - savedDurationSec);
  const afterFillRatio = clamp01(afterDurationSec / windowDurationSec);

  const safeBinCount = Math.max(24, Math.floor(binCount));
  const afterBinCount = isRipple
    ? Math.max(12, Math.round(safeBinCount * afterFillRatio))
    : safeBinCount;

  const beforeRaw = extractTrackWindowBuckets({
    track: targetTrackBefore,
    assets,
    pcmSources,
    sampleRate,
    windowStartSec,
    windowEndSec,
    binCount: safeBinCount,
  });

  const afterRaw = extractTrackWindowBuckets({
    track: targetTrackAfter,
    assets,
    pcmSources,
    sampleRate,
    windowStartSec,
    windowEndSec: windowStartSec + afterDurationSec,
    binCount: afterBinCount,
  });

  // Shared peak normalization across Before & After so amplitude reductions remain visually honest
  let sharedMaxPeak = 0.05;
  for (const b of beforeRaw) {
    if (b.peak > sharedMaxPeak) sharedMaxPeak = b.peak;
  }
  for (const b of afterRaw) {
    if (b.peak > sharedMaxPeak) sharedMaxPeak = b.peak;
  }

  const normalizeBins = (raw: RawBucketMetrics[]): WaveformMiniBin[] =>
    raw.map((b) => ({
      peak: clamp01(b.peak / sharedMaxPeak),
      rms: clamp01(b.rms / sharedMaxPeak),
      isRoomTone: b.isRoomTone,
    }));

  const beforeBins = normalizeBins(beforeRaw);
  const afterBins = normalizeBins(afterRaw);

  const cutStartRatio = clamp01((cutStartSec - windowStartSec) / windowDurationSec);
  const cutEndRatio = clamp01((cutEndSec - windowStartSec) / windowDurationSec);
  const spliceRatio = clamp01((cutStartSec - windowStartSec) / windowDurationSec);

  const meanRmsRange = (bins: WaveformMiniBin[], rStart: number, rEnd: number): number => {
    if (bins.length === 0) return 0;
    const i0 = Math.max(0, Math.min(bins.length - 1, Math.floor(rStart * bins.length)));
    const i1 = Math.max(i0 + 1, Math.min(bins.length, Math.ceil(rEnd * bins.length)));
    let acc = 0;
    for (let i = i0; i < i1; i++) acc += bins[i].rms;
    return acc / (i1 - i0);
  };

  const removedZoneRmsBefore = meanRmsRange(beforeBins, cutStartRatio, cutEndRatio);
  const afterZoneRms = isRipple
    ? meanRmsRange(
        afterBins,
        clamp01((cutStartSec - windowStartSec) / afterDurationSec),
        clamp01((cutStartSec - windowStartSec + Math.min(0.45, cutDurationSec || 0.3)) / afterDurationSec),
      )
    : meanRmsRange(afterBins, cutStartRatio, cutEndRatio);

  return {
    recommendationId: recommendation.id,
    trackId,
    trackName,
    effectiveMode,
    windowStartSec,
    windowEndSec,
    windowDurationSec,
    cutStartSec,
    cutEndSec,
    cutDurationSec,
    cutStartRatio,
    cutEndRatio,
    afterDurationSec,
    afterFillRatio,
    spliceRatio,
    savedDurationSec,
    removedZoneRmsBefore,
    afterZoneRms,
    beforeBins,
    afterBins,
  };
}
