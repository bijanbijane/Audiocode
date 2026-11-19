import { FLICKS_PER_SECOND } from '../contracts/timebase.contract';
import {
  asResampledFramePosition,
  asSourceSamplePosition,
  asTimelineDisplaySec,
  ResampledFramePosition,
  SourceSamplePosition,
  TimelineDisplaySec,
} from './SamplePosition';
import { assertValidSampleRate, buildSampleRateRatio } from './SampleRate';

export type RoundingPolicy = 'HALF_UP' | 'FLOOR' | 'CEIL';

export const CANONICAL_TIMEBASE_FLICKS_PER_SECOND = FLICKS_PER_SECOND;

/**
 * Exact BigInt integer rational scaling: round(value * num / den) without IEEE-754 float accumulation drift.
 */
export function scaleIntegerRational(
  value: number,
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingPolicy = 'HALF_UP',
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`scaleIntegerRational requires non-negative safe integer, got ${value}`);
  }
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      `scaleIntegerRational requires numerator >= 0 and denominator > 0, got ${numerator}/${denominator}`,
    );
  }
  const bigVal = BigInt(value);
  const product = bigVal * numerator;
  let result: bigint;
  if (rounding === 'FLOOR') {
    result = product / denominator;
  } else if (rounding === 'CEIL') {
    result = (product + denominator - 1n) / denominator;
  } else {
    // HALF_UP
    result = (product * 2n + denominator) / (denominator * 2n);
  }
  const num = Number(result);
  if (!Number.isSafeInteger(num)) {
    throw new RangeError('Scaled sample coordinate exceeded MAX_SAFE_INTEGER');
  }
  return num;
}

/** Convert authoritative SourceSamplePosition -> ResampledFramePosition directly from exact rational ratio */
export function sourceSampleToResampledFrame(
  sourceSample: SourceSamplePosition,
  sourceRate: number,
  targetRate: number,
  rounding: RoundingPolicy = 'HALF_UP',
): ResampledFramePosition {
  assertValidSampleRate(sourceRate);
  assertValidSampleRate(targetRate);
  if (sourceRate === targetRate) {
    return asResampledFramePosition(sourceSample);
  }
  const ratio = buildSampleRateRatio(sourceRate, targetRate);
  return asResampledFramePosition(
    scaleIntegerRational(sourceSample, ratio.numerator, ratio.denominator, rounding),
  );
}

/** Convert ResampledFramePosition -> authoritative SourceSamplePosition using exact inverse ratio */
export function resampledFrameToSourceSample(
  resampledFrame: ResampledFramePosition,
  sourceRate: number,
  targetRate: number,
  rounding: RoundingPolicy = 'HALF_UP',
): SourceSamplePosition {
  assertValidSampleRate(sourceRate);
  assertValidSampleRate(targetRate);
  if (sourceRate === targetRate) {
    return asSourceSamplePosition(resampledFrame);
  }
  const ratio = buildSampleRateRatio(targetRate, sourceRate);
  return asSourceSamplePosition(
    scaleIntegerRational(resampledFrame, ratio.numerator, ratio.denominator, rounding),
  );
}

/** Derive presentation-only TimelineDisplaySec from authoritative SourceSamplePosition */
export function sourceSampleToDisplaySec(
  sourceSample: SourceSamplePosition,
  sourceRate: number,
): TimelineDisplaySec {
  assertValidSampleRate(sourceRate);
  return asTimelineDisplaySec(sourceSample / sourceRate);
}

/** Convert authoritative SourceSamplePosition -> integer Flicks exactly when divisible or half-up */
export function sourceSampleToFlicksExact(
  sourceSample: SourceSamplePosition,
  sourceRate: number,
): number {
  assertValidSampleRate(sourceRate);
  return scaleIntegerRational(
    sourceSample,
    BigInt(CANONICAL_TIMEBASE_FLICKS_PER_SECOND),
    BigInt(sourceRate),
    'HALF_UP',
  );
}

/** Convert Flicks -> SourceSamplePosition without floating-point accumulation */
export function flicksToSourceSampleExact(
  flicks: number,
  sourceRate: number,
): SourceSamplePosition {
  assertValidSampleRate(sourceRate);
  if (!Number.isFinite(flicks)) {
    throw new RangeError(`flicksToSourceSampleExact requires finite flicks, got ${flicks}`);
  }
  return asSourceSamplePosition(
    scaleIntegerRational(
      Math.max(0, Math.round(flicks)),
      BigInt(sourceRate),
      BigInt(CANONICAL_TIMEBASE_FLICKS_PER_SECOND),
      'HALF_UP',
    ),
  );
}
