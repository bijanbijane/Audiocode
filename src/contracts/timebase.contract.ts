/**
 * Core Draft Contracts v0.1 — Timebase & Flicks Contract
 * 1 Second = 705,600,000 Flicks (exact integer division across 16k, 22.05k, 24k, 32k, 44.1k, 48k, 96k)
 */

export const FLICKS_PER_SECOND = 705_600_000 as const;

export type Flicks = number; // Integer-guaranteed within Safe Integer range (~3500 hours)
export type SampleIndex = number;
export type SampleRate = 16000 | 22050 | 24000 | 32000 | 44100 | 48000 | 96000;

/** Half-open canonical interval [start, end) in Flicks */
export interface TimeRange {
  readonly start: Flicks;
  readonly end: Flicks;
}

export const TimeMath = {
  samplesToFlicks(samples: SampleIndex, rate: SampleRate): Flicks {
    const flicksPerSample = FLICKS_PER_SECOND / rate; // Exact integer
    return Math.round(samples * flicksPerSample);
  },

  flicksToSamplesFloor(flicks: Flicks, rate: SampleRate): SampleIndex {
    const flicksPerSample = FLICKS_PER_SECOND / rate;
    return Math.floor(flicks / flicksPerSample);
  },

  secondsToFlicks(seconds: number): Flicks {
    return Math.round(seconds * FLICKS_PER_SECOND);
  },

  flicksToSeconds(flicks: Flicks): number {
    return flicks / FLICKS_PER_SECOND;
  },
} as const;
