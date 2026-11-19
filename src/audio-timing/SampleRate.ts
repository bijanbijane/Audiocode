import { SampleRate as ContractSampleRate } from '../contracts/timebase.contract';

export type CanonicalSampleRate = ContractSampleRate;

export const SUPPORTED_CANONICAL_SAMPLE_RATES: readonly CanonicalSampleRate[] = [
  16000, 22050, 24000, 32000, 44100, 48000, 96000,
];

export function assertValidSampleRate(rate: number): asserts rate is CanonicalSampleRate {
  if (!Number.isSafeInteger(rate) || rate <= 0) {
    throw new RangeError(`Invalid sample rate: ${String(rate)}`);
  }
}

export function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export interface RationalRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Exact reduced rational conversion ratio (targetRate / sourceRate) */
export function buildSampleRateRatio(sourceRate: number, targetRate: number): RationalRatio {
  assertValidSampleRate(sourceRate);
  assertValidSampleRate(targetRate);
  const num = BigInt(targetRate);
  const den = BigInt(sourceRate);
  const g = gcdBigInt(num, den);
  return {
    numerator: num / g,
    denominator: den / g,
  };
}
