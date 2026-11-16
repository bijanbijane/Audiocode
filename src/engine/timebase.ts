import { FLICKS_PER_SECOND, FlickRange } from '../contracts/v1_2';
export { FLICKS_PER_SECOND };

/**
 * Canonical Drift-Free Timebase (Flicks: 705,600,000 ticks/second)
 * 705,600,000 is evenly divisible by 16k, 22.05k, 24k, 32k, 44.1k, 48k, 96k, 192k, and 24/25/30/60fps.
 * Uses BigInt internally when multiplying large multi-hour sample counts to prevent IEEE-754 overflow.
 */

const FLICKS_BIG = BigInt(FLICKS_PER_SECOND);

export function flicksPerSample(sampleRate: number): number {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }
  if (FLICKS_PER_SECOND % sampleRate === 0) {
    return FLICKS_PER_SECOND / sampleRate;
  }
  return FLICKS_PER_SECOND / sampleRate;
}

/**
 * Deterministic conversion from sample index at any sampleRate to canonical Flicks.
 * Exact integer when sampleRate divides 705,600,000 (all standard audio rates).
 */
export function samplesToFlicks(sampleIndex: number, sampleRate: number): number {
  if (!Number.isFinite(sampleIndex) || sampleRate <= 0) {
    throw new Error(`Invalid inputs: sampleIndex=${sampleIndex}, sampleRate=${sampleRate}`);
  }
  if (Number.isInteger(sampleIndex) && FLICKS_PER_SECOND % sampleRate === 0) {
    const step = BigInt(FLICKS_PER_SECOND / sampleRate);
    const result = BigInt(sampleIndex) * step;
    if (result <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(result);
    }
  }
  return Math.round((sampleIndex * FLICKS_PER_SECOND) / sampleRate);
}

/**
 * Deterministic conversion from canonical Flicks to sample index at target sampleRate.
 * Uses BigInt division to preserve zero cumulative drift over multi-hour durations.
 */
export function flicksToSamples(flicks: number, sampleRate: number): number {
  if (!Number.isFinite(flicks) || sampleRate <= 0) {
    throw new Error(`Invalid inputs: flicks=${flicks}, sampleRate=${sampleRate}`);
  }
  if (Number.isInteger(flicks) && FLICKS_PER_SECOND % sampleRate === 0) {
    const step = BigInt(FLICKS_PER_SECOND / sampleRate);
    const halfStep = step / 2n;
    const fBig = BigInt(flicks);
    if (fBig >= 0n) {
      return Number((fBig + halfStep) / step);
    }
    return Number((fBig - halfStep) / step);
  }
  return Math.round((flicks * sampleRate) / FLICKS_PER_SECOND);
}

export function msToFlicks(ms: number): number {
  return Math.round((ms * FLICKS_PER_SECOND) / 1000);
}

export function secondsToFlicks(seconds: number): number {
  return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(flicks: number): number {
  return flicks / FLICKS_PER_SECOND;
}

export function flicksToMs(flicks: number): number {
  return (flicks * 1000) / FLICKS_PER_SECOND;
}

/** Format flicks into tabular HH:MM:SS.mmm */
export function formatTimecode(flicks: number): string {
  const safeFlicks = Math.max(0, flicks);
  const totalMs = Math.round((safeFlicks * 1000) / FLICKS_PER_SECOND);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);

  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const pad3 = (n: number) => n.toString().padStart(3, '0');
  if (hr > 0) {
    return `${pad2(hr)}:${pad2(min)}:${pad2(sec)}.${pad3(ms)}`;
  }
  return `${pad2(min)}:${pad2(sec)}.${pad3(ms)}`;
}

/** Half-open interval [startFlicks, endFlicks) overlap test */
export function rangesOverlap(a: FlickRange, b: FlickRange): boolean {
  return a.startFlicks < b.endFlicks && b.startFlicks < a.endFlicks;
}

export function rangeDurationFlicks(r: FlickRange): number {
  return Math.max(0, r.endFlicks - r.startFlicks);
}

export function isValidHalfOpenRange(r: FlickRange): boolean {
  return Number.isFinite(r.startFlicks) && Number.isFinite(r.endFlicks) && r.startFlicks < r.endFlicks;
}

/** Map a sample index directly between two sample rates via Flicks without fractional drift */
export function mapSampleBetweenRates(
  sampleIndex: number,
  fromRate: number,
  toRate: number,
): number {
  const f = samplesToFlicks(sampleIndex, fromRate);
  return flicksToSamples(f, toRate);
}

export { FLICKS_BIG };
