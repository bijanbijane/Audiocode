/**
 * Branded Temporal Coordinate Domains (AVP-P12-001 Section 1)
 * Prevents silently conflating source samples, resampled frames, ASR window timestamps,
 * timeline display seconds, and render output sample positions.
 */

declare const BRAND_SOURCE_SAMPLE: unique symbol;
declare const BRAND_DECODED_FRAME: unique symbol;
declare const BRAND_RESAMPLED_FRAME: unique symbol;
declare const BRAND_ASR_WINDOW_OFFSET: unique symbol;
declare const BRAND_ASR_REL_SEC: unique symbol;
declare const BRAND_TIMELINE_DISPLAY_SEC: unique symbol;
declare const BRAND_RENDER_OUTPUT_SAMPLE: unique symbol;

export type SourceSamplePosition = number & { readonly [BRAND_SOURCE_SAMPLE]: 'SourceSamplePosition' };
export type DecodedFramePosition = number & { readonly [BRAND_DECODED_FRAME]: 'DecodedFramePosition' };
export type ResampledFramePosition = number & { readonly [BRAND_RESAMPLED_FRAME]: 'ResampledFramePosition' };
export type AsrWindowSourceOffset = number & { readonly [BRAND_ASR_WINDOW_OFFSET]: 'AsrWindowSourceOffset' };
export type AsrWindowRelativeSec = number & { readonly [BRAND_ASR_REL_SEC]: 'AsrWindowRelativeSec' };
export type TimelineDisplaySec = number & { readonly [BRAND_TIMELINE_DISPLAY_SEC]: 'TimelineDisplaySec' };
export type RenderOutputSamplePosition = number & { readonly [BRAND_RENDER_OUTPUT_SAMPLE]: 'RenderOutputSamplePosition' };

export type CoordinateDomain =
  | 'SOURCE_SAMPLE'
  | 'DECODED_FRAME'
  | 'RESAMPLED_FRAME'
  | 'ASR_WINDOW_RELATIVE'
  | 'TIMELINE_DISPLAY'
  | 'RENDER_OUTPUT_SAMPLE';

export interface SourceSampleRange {
  readonly domain: 'SOURCE_SAMPLE';
  readonly startSample: SourceSamplePosition;
  readonly endSample: SourceSamplePosition;
  readonly sampleRate: number;
}

export function asSourceSamplePosition(value: number): SourceSamplePosition {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`SourceSamplePosition must be a non-negative safe integer, got ${value}`);
  }
  return value as SourceSamplePosition;
}

export function asDecodedFramePosition(value: number): DecodedFramePosition {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`DecodedFramePosition must be a non-negative safe integer, got ${value}`);
  }
  return value as DecodedFramePosition;
}

export function asResampledFramePosition(value: number): ResampledFramePosition {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`ResampledFramePosition must be a non-negative safe integer, got ${value}`);
  }
  return value as ResampledFramePosition;
}

export function asAsrWindowSourceOffset(value: number): AsrWindowSourceOffset {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`AsrWindowSourceOffset must be a non-negative safe integer, got ${value}`);
  }
  return value as AsrWindowSourceOffset;
}

export function asAsrWindowRelativeSec(value: number): AsrWindowRelativeSec {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`AsrWindowRelativeSec must be finite >= 0, got ${value}`);
  }
  return value as AsrWindowRelativeSec;
}

export function asTimelineDisplaySec(value: number): TimelineDisplaySec {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`TimelineDisplaySec must be finite >= 0, got ${value}`);
  }
  return value as TimelineDisplaySec;
}

export function asRenderOutputSamplePosition(value: number): RenderOutputSamplePosition {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`RenderOutputSamplePosition must be a non-negative safe integer, got ${value}`);
  }
  return value as RenderOutputSamplePosition;
}

export function createSourceSampleRange(
  startSample: number,
  endSample: number,
  sampleRate: number,
): SourceSampleRange {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`SourceSampleRange sampleRate must be a positive safe integer, got ${sampleRate}`);
  }
  const s = asSourceSamplePosition(startSample);
  const e = asSourceSamplePosition(endSample);
  if (e < s) {
    throw new RangeError(`SourceSampleRange end (${e}) < start (${s})`);
  }
  return {
    domain: 'SOURCE_SAMPLE',
    startSample: s,
    endSample: e,
    sampleRate,
  };
}
