import { Flicks, SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';

export type AutomationCurveInterpolation = 'STEP' | 'LINEAR' | 'S_CURVE_COSINE';

export interface AutomationKeyframe {
  readonly timeFlicks: Flicks;
  readonly value: number;
  readonly curveToNext: AutomationCurveInterpolation;
}

export interface AutomationLane {
  readonly laneId: string;
  readonly targetNodeOrTrackId: string;
  readonly parameterName: 'GAIN_DB' | 'PAN' | 'WET_MIX';
  readonly defaultValue: number;
  readonly keyframes: AutomationKeyframe[]; // Sorted ascending by timeFlicks
}

/**
 * Sample-accurate timeline parameter automation and podcast Auto-Ducking generator
 * (Architecture Doc Sections 2.5 & 33).
 */
export class TimelineAutomationEngine {
  /**
   * 1. O(log N) binary-search sample-accurate evaluation at any Flicks timestamp.
   */
  public static evaluateAtFlicks(lane: AutomationLane, queryFlicks: Flicks): number {
    const frames = lane.keyframes;
    if (frames.length === 0) return lane.defaultValue;
    if (queryFlicks <= frames[0].timeFlicks) return frames[0].value;
    if (queryFlicks >= frames[frames.length - 1].timeFlicks) {
      return frames[frames.length - 1].value;
    }

    let low = 0;
    let high = frames.length - 2;
    let idx = 0;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (frames[mid].timeFlicks <= queryFlicks && queryFlicks < frames[mid + 1].timeFlicks) {
        idx = mid;
        break;
      } else if (frames[mid].timeFlicks > queryFlicks) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const k0 = frames[idx];
    const k1 = frames[idx + 1];
    const span = k1.timeFlicks - k0.timeFlicks;
    if (span <= 0) return k0.value;

    const t = (queryFlicks - k0.timeFlicks) / span;

    switch (k0.curveToNext) {
      case 'STEP':
        return k0.value;
      case 'LINEAR':
        return k0.value + (k1.value - k0.value) * t;
      case 'S_CURVE_COSINE': {
        const smoothT = (1 - Math.cos(t * Math.PI)) * 0.5;
        return k0.value + (k1.value - k0.value) * smoothT;
      }
    }
  }

  /**
   * 2. Generates a smooth S-Curve Auto-Ducking automation lane for background music
   * based on active Persian speech intervals, merging short pauses to prevent pumping.
   */
  public static generatePodcastMusicDuckingLane(params: {
    musicTrackId: string;
    speechActiveRanges: readonly TimeRange[];
    normalMusicGainDb?: number;
    duckedMusicGainDb?: number;
    lookaheadAttackMs?: number;
    releaseHoldMs?: number;
    releaseFadeMs?: number;
  }): AutomationLane {
    const normalDb = params.normalMusicGainDb ?? 0.0;
    const duckedDb = params.duckedMusicGainDb ?? -14.0;
    const attackFlicks = TimeMath.secondsToFlicks((params.lookaheadAttackMs ?? 180) / 1000);
    const holdFlicks = TimeMath.secondsToFlicks((params.releaseHoldMs ?? 600) / 1000);
    const releaseFlicks = TimeMath.secondsToFlicks((params.releaseFadeMs ?? 800) / 1000);

    const minGapForMusicRise = holdFlicks + releaseFlicks + attackFlicks;
    const mergedSpeechRanges: TimeRange[] = [];

    const sorted = [...params.speechActiveRanges].sort((a, b) => a.start - b.start);
    for (const r of sorted) {
      if (mergedSpeechRanges.length === 0) {
        mergedSpeechRanges.push({ ...r });
      } else {
        const prev = mergedSpeechRanges[mergedSpeechRanges.length - 1];
        if (r.start - prev.end <= minGapForMusicRise) {
          mergedSpeechRanges[mergedSpeechRanges.length - 1] = {
            start: prev.start,
            end: Math.max(prev.end, r.end),
          };
        } else {
          mergedSpeechRanges.push({ ...r });
        }
      }
    }

    const keyframes: AutomationKeyframe[] = [];
    for (const speech of mergedSpeechRanges) {
      const fadeDownStart = Math.max(0, speech.start - attackFlicks);
      const fadeUpStart = speech.end + holdFlicks;
      const fadeUpEnd = fadeUpStart + releaseFlicks;

      keyframes.push(
        { timeFlicks: fadeDownStart, value: normalDb, curveToNext: 'S_CURVE_COSINE' },
        { timeFlicks: speech.start, value: duckedDb, curveToNext: 'LINEAR' },
        { timeFlicks: fadeUpStart, value: duckedDb, curveToNext: 'S_CURVE_COSINE' },
        { timeFlicks: fadeUpEnd, value: normalDb, curveToNext: 'LINEAR' },
      );
    }

    return {
      laneId: `auto_duck_${params.musicTrackId}`,
      targetNodeOrTrackId: params.musicTrackId,
      parameterName: 'GAIN_DB',
      defaultValue: normalDb,
      keyframes,
    };
  }

  /**
   * 3. Applies sample-accurate dB gain automation in-place across a PCM chunk
   * using 64-sample sub-block interpolation to prevent zipper noise.
   */
  public static applyGainAutomationToChunkInPlace(
    lane: AutomationLane,
    channels: Float32Array[],
    chunkStartFlicks: Flicks,
    sampleRate: SampleRate,
  ): void {
    if (lane.parameterName !== 'GAIN_DB' || lane.keyframes.length === 0 || channels.length === 0) {
      return;
    }
    const frameCount = channels[0].length;
    const flicksPerSample = TimeMath.samplesToFlicks(1, sampleRate);

    const stepSamples = 64;
    for (let i = 0; i < frameCount; i += stepSamples) {
      const subEnd = Math.min(frameCount, i + stepSamples);
      const f0 = chunkStartFlicks + i * flicksPerSample;
      const f1 = chunkStartFlicks + subEnd * flicksPerSample;

      const gainDb0 = this.evaluateAtFlicks(lane, f0);
      const gainDb1 = this.evaluateAtFlicks(lane, f1);
      const lin0 = Math.pow(10, gainDb0 / 20.0);
      const lin1 = Math.pow(10, gainDb1 / 20.0);
      const span = Math.max(1, subEnd - i);

      for (let s = i; s < subEnd; s++) {
        const alpha = (s - i) / span;
        const g = lin0 + (lin1 - lin0) * alpha;
        for (let c = 0; c < channels.length; c++) {
          channels[c][s] *= g;
        }
      }
    }
  }
}
