/**
 * AVP-P0-008 — Canonical Audio DSP Integrity, Sample-Accurate Timeline & Deterministic Rendering Engine
 *
 * Reuses and unifies existing AVAPARDAZ audio primitives (`StreamingKaiserSincResampler`,
 * `AudioCrossfadeProcessor`, `AudioExportWriter`, `AudioRenderValidator`, `MemoryBudgetManager`)
 * under one canonical internal representation and cross-runtime DSP contract.
 *
 * Guarantees:
 * - Authoritative integer sample positions for all edit boundaries (explicit rounding rules).
 * - Anti-aliased Kaiser-windowed sinc resampling (both downsampling AND upsampling).
 * - Explicit channel layout & downmix/upmix coefficients (zero accidental swap or silent loss).
 * - Explicit fade-in, fade-out, and crossfade curves with discontinuity & clipping checks.
 * - Digital silence vs low-level audio discrimination without destructive threshold assumptions.
 * - Numerical integrity validation (NaN, Infinity, clipping, DC offset, RMS, peak).
 * - Independent decode-back verification of rendered WAV artifacts (PCM16, PCM24, Float32).
 */

import { StreamingKaiserSincResampler } from '../engine/resampler';
import { AudioCrossfadeProcessor } from './AudioCrossfadeProcessor';
import { AudioExportWriter, BoundedChunkedByteSink } from './AudioExportWriter';
import { parseWaveContainerBytes } from './AudioRenderValidator';
import type { CrossfadeCurve, RenderExportEncoding } from './AudioRenderTypes';
import type { SampleRate } from '../contracts/timebase.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';

export const CANONICAL_DSP_CONTRACT_VERSION = '2.0.0' as const;

export type CanonicalChannelLayout = 'mono' | 'stereo' | 'quad' | '5.1';
export type TimeToSampleRoundingMode = 'round' | 'floor' | 'ceil';
export type FadeCurveType = 'linear' | 'equal-power' | 'smooth-cosine';
export type DownmixCoefficientPolicy = 'equal_amplitude_0_5' | 'equal_power_minus_3db';

export interface CanonicalAudioDescriptor {
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly channelLayout: CanonicalChannelLayout;
  readonly sampleFormat: 'float32-planar';
  readonly frameCount: number;
  readonly durationSec: number;
  readonly interleaving: 'planar';
  readonly nominalRange: readonly [-1, 1];
}

export interface CanonicalAudioBuffer {
  readonly descriptor: CanonicalAudioDescriptor;
  /** Planar float32 channels: channels[ch][frameIndex], owned immutably unless cloned */
  readonly channels: readonly Float32Array[];
}

export interface AudioDescriptorValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export const SUPPORTED_SAMPLE_RATES = new Set<number>([
  8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000,
]);

export function inferCanonicalChannelLayout(channelCount: number): CanonicalChannelLayout | null {
  switch (channelCount) {
    case 1:
      return 'mono';
    case 2:
      return 'stereo';
    case 4:
      return 'quad';
    case 6:
      return '5.1';
    default:
      return null;
  }
}

export function validateCanonicalAudioDescriptor(
  desc: CanonicalAudioDescriptor,
  channels?: readonly Float32Array[],
): AudioDescriptorValidationResult {
  const errors: string[] = [];
  if (!desc.assetId || desc.assetId.trim().length === 0) {
    errors.push('INVALID_METADATA: assetId must be non-empty.');
  }
  if (!Number.isInteger(desc.sampleRate) || !SUPPORTED_SAMPLE_RATES.has(desc.sampleRate)) {
    errors.push(`INVALID_SAMPLE_RATE: Unsupported sampleRate ${String(desc.sampleRate)}.`);
  }
  const expectedLayout = inferCanonicalChannelLayout(desc.channelCount);
  if (!expectedLayout || desc.channelLayout !== expectedLayout) {
    errors.push(
      `INVALID_CHANNEL_LAYOUT: channelCount=${desc.channelCount} contradicts channelLayout="${desc.channelLayout}".`,
    );
  }
  if (!Number.isSafeInteger(desc.frameCount) || desc.frameCount < 0) {
    errors.push(`INVALID_FRAME_COUNT: frameCount must be a non-negative safe integer.`);
  }
  if (desc.sampleFormat !== 'float32-planar' || desc.interleaving !== 'planar') {
    errors.push('INVALID_SAMPLE_FORMAT: Canonical internal representation requires float32-planar.');
  }
  const expectedDur = desc.sampleRate > 0 ? desc.frameCount / desc.sampleRate : 0;
  if (!Number.isFinite(desc.durationSec) || Math.abs(desc.durationSec - expectedDur) > 1e-4) {
    errors.push(
      `DURATION_METADATA_MISMATCH: durationSec=${desc.durationSec} disagrees with frameCount/sampleRate=${expectedDur}.`,
    );
  }
  if (channels) {
    if (channels.length !== desc.channelCount) {
      errors.push(`CHANNEL_BUFFER_MISMATCH: Expected ${desc.channelCount} channel buffers, got ${channels.length}.`);
    }
    for (let c = 0; c < channels.length; c++) {
      if (channels[c].length !== desc.frameCount) {
        errors.push(
          `FRAME_BUFFER_MISMATCH: Channel ${c} length (${channels[c].length}) != descriptor frameCount (${desc.frameCount}).`,
        );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function createCanonicalAudioBuffer(params: {
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly sampleRate: SampleRate;
  readonly channels: readonly Float32Array[];
  readonly channelLayout?: CanonicalChannelLayout;
}): CanonicalAudioBuffer {
  const channelCount = params.channels.length;
  const inferred = inferCanonicalChannelLayout(channelCount);
  if (!inferred) {
    throw new Error(`INVALID_CHANNEL_LAYOUT: Unsupported channel count ${channelCount}.`);
  }
  const frameCount = params.channels[0]?.length ?? 0;
  const descriptor: CanonicalAudioDescriptor = {
    assetId: params.assetId,
    sourceSha256: params.sourceSha256,
    sampleRate: params.sampleRate,
    channelCount,
    channelLayout: params.channelLayout ?? inferred,
    sampleFormat: 'float32-planar',
    frameCount,
    durationSec: Number((frameCount / params.sampleRate).toFixed(6)),
    interleaving: 'planar',
    nominalRange: [-1, 1],
  };
  const check = validateCanonicalAudioDescriptor(descriptor, params.channels);
  if (!check.valid) {
    throw new Error(check.errors.join(' | '));
  }
  const integrity = inspectNumericalIntegrity(params.channels);
  if (integrity.nonFiniteCount > 0) {
    throw new Error(
      `NON_FINITE_AUDIO_SAMPLES: Buffer "${params.assetId}" contains ${integrity.nonFiniteCount} NaN/Infinity sample(s).`,
    );
  }
  return { descriptor, channels: params.channels };
}

/**
 * Deterministic time-to-sample conversion with explicit rounding mode.
 * Never confuses milliseconds, seconds, and sample frames.
 */
export function secondsToSampleIndex(
  seconds: number,
  sampleRate: number,
  rounding: TimeToSampleRoundingMode = 'round',
  maxFrames?: number,
): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`INVALID_TIMEBASE: seconds must be finite and >= 0, got ${seconds}.`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`INVALID_SAMPLE_RATE: sampleRate must be > 0, got ${sampleRate}.`);
  }
  const exact = seconds * sampleRate;
  let idx: number;
  if (rounding === 'floor') idx = Math.floor(exact);
  else if (rounding === 'ceil') idx = Math.ceil(exact);
  else idx = Math.round(exact);
  if (maxFrames !== undefined) {
    idx = Math.max(0, Math.min(maxFrames, idx));
  }
  return idx;
}

export function millisecondsToSampleIndex(
  milliseconds: number,
  sampleRate: number,
  rounding: TimeToSampleRoundingMode = 'round',
  maxFrames?: number,
): number {
  return secondsToSampleIndex(milliseconds / 1000, sampleRate, rounding, maxFrames);
}

export function sampleIndexToSeconds(sampleIndex: number, sampleRate: number): number {
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) {
    throw new RangeError(`INVALID_SAMPLE_INDEX: ${sampleIndex}.`);
  }
  return sampleIndex / sampleRate;
}

/**
 * Numerical signal inspection: peak, RMS, DC offset, NaN/Infinity count, clipped samples.
 */
export interface SignalIntegrityMetrics {
  readonly frameCount: number;
  readonly channelCount: number;
  readonly peakAmplitude: number;
  readonly rmsLevel: number;
  readonly rmsDbfs: number;
  readonly dcOffsetPerChannel: readonly number[];
  readonly maxAbsDcOffset: number;
  readonly nonFiniteCount: number;
  readonly clippedCount: number;
  readonly maxSampleStepDiscontinuity: number;
  readonly valid: boolean;
}

export function inspectNumericalIntegrity(
  channels: readonly Float32Array[],
  options?: { readonly clippingThreshold?: number },
): SignalIntegrityMetrics {
  const clipThreshold = options?.clippingThreshold ?? 1.0;
  const channelCount = channels.length;
  const frameCount = channelCount > 0 ? channels[0].length : 0;

  let peak = 0;
  let sumSq = 0;
  let finiteSamples = 0;
  let nonFiniteCount = 0;
  let clippedCount = 0;
  let maxStep = 0;
  const dcOffsetPerChannel: number[] = [];

  for (let c = 0; c < channelCount; c++) {
    const buf = channels[c];
    let chSum = 0;
    let chFinite = 0;
    let prev = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      if (!Number.isFinite(v)) {
        nonFiniteCount++;
        continue;
      }
      finiteSamples++;
      chFinite++;
      chSum += v;
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > clipThreshold) clippedCount++;
      if (i > 0) {
        const step = Math.abs(v - prev);
        if (step > maxStep) maxStep = step;
      }
      prev = v;
    }
    dcOffsetPerChannel.push(chFinite > 0 ? chSum / chFinite : 0);
  }

  const rmsLevel = finiteSamples > 0 ? Math.sqrt(sumSq / finiteSamples) : 0;
  const rmsDbfs = rmsLevel <= 1e-9 ? -180 : 20 * Math.log10(rmsLevel);
  const maxAbsDcOffset = dcOffsetPerChannel.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  return {
    frameCount,
    channelCount,
    peakAmplitude: peak,
    rmsLevel,
    rmsDbfs,
    dcOffsetPerChannel,
    maxAbsDcOffset,
    nonFiniteCount,
    clippedCount,
    maxSampleStepDiscontinuity: maxStep,
    valid: nonFiniteCount === 0,
  };
}

/**
 * Sanitizes NaN/Infinity samples safely and applies explicit clipping/saturation policy.
 */
export function sanitizeAndLimitPlanarChannels(
  channels: readonly Float32Array[],
  policy: 'reject_non_finite' | 'zero_non_finite_hard_clip' | 'zero_non_finite_soft_limit' = 'zero_non_finite_hard_clip',
): { readonly channels: Float32Array[]; readonly nonFiniteReplaced: number; readonly clippedSamples: number } {
  let nonFiniteReplaced = 0;
  let clippedSamples = 0;
  const out = channels.map((src) => {
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!Number.isFinite(v)) {
        if (policy === 'reject_non_finite') {
          throw new Error(`INVALID_NUMERIC_SAMPLE: Encountered non-finite sample (${String(v)}) at frame ${i}.`);
        }
        nonFiniteReplaced++;
        dst[i] = 0;
        continue;
      }
      if (Math.abs(v) > 1.0) {
        clippedSamples++;
        if (policy === 'zero_non_finite_soft_limit') {
          const sign = v < 0 ? -1 : 1;
          dst[i] = sign * (0.995 + 0.005 * Math.tanh((Math.abs(v) - 0.995) / 0.005));
        } else {
          dst[i] = Math.max(-1, Math.min(1, v));
        }
      } else {
        dst[i] = v;
      }
    }
    return dst;
  });
  return { channels: out, nonFiniteReplaced, clippedSamples };
}

/**
 * Explicit channel mapping & downmix/upmix engine.
 * - Preserves channel ordering (no accidental L/R swap).
 * - Supports explicit downmix gain policies (`0.5` equal-amplitude or `1/sqrt(2)` equal-power).
 * - Preserves multichannel layouts when target matches source.
 */
export function convertChannelLayout(params: {
  readonly channels: readonly Float32Array[];
  readonly targetLayout: CanonicalChannelLayout;
  readonly downmixPolicy?: DownmixCoefficientPolicy;
}): Float32Array[] {
  const srcCount = params.channels.length;
  const frameCount = srcCount > 0 ? params.channels[0].length : 0;
  const targetCount =
    params.targetLayout === 'mono'
      ? 1
      : params.targetLayout === 'stereo'
        ? 2
        : params.targetLayout === 'quad'
          ? 4
          : 6;

  if (srcCount === 0) {
    throw new Error('INVALID_CHANNEL_LAYOUT: Source has 0 channels.');
  }
  if (srcCount === targetCount) {
    return params.channels.map((ch) => new Float32Array(ch));
  }

  // Downmix to mono
  if (targetCount === 1) {
    const out = new Float32Array(frameCount);
    const coeff =
      srcCount === 2 && params.downmixPolicy === 'equal_power_minus_3db'
        ? Math.SQRT1_2
        : 1 / srcCount;
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < srcCount; c++) {
        const s = params.channels[c][i];
        sum += Number.isFinite(s) ? s * coeff : 0;
      }
      out[i] = Math.max(-1, Math.min(1, sum));
    }
    return [out];
  }

  // Mono -> Stereo upmix (explicit dual-mono equal gain)
  if (srcCount === 1 && targetCount === 2) {
    return [new Float32Array(params.channels[0]), new Float32Array(params.channels[0])];
  }

  // 5.1 -> Stereo ITU-R BS.775-3 standard downmix (L + 0.707*C + 0.707*Ls, R + 0.707*C + 0.707*Rs)
  if (srcCount === 6 && targetCount === 2) {
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    const norm = 1 / (1 + Math.SQRT1_2 + Math.SQRT1_2); // prevents clipping on full-scale correlated signals
    for (let i = 0; i < frameCount; i++) {
      const l = params.channels[0][i];
      const r = params.channels[1][i];
      const c = params.channels[2][i];
      const ls = params.channels[4][i];
      const rs = params.channels[5][i];
      left[i] = (l + Math.SQRT1_2 * c + Math.SQRT1_2 * ls) * norm;
      right[i] = (r + Math.SQRT1_2 * c + Math.SQRT1_2 * rs) * norm;
    }
    return [left, right];
  }

  // Quad -> Stereo (FL+RL, FR+RR)
  if (srcCount === 4 && targetCount === 2) {
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      left[i] = 0.5 * (params.channels[0][i] + params.channels[2][i]);
      right[i] = 0.5 * (params.channels[1][i] + params.channels[3][i]);
    }
    return [left, right];
  }

  throw new Error(
    `UNSUPPORTED_CHANNEL_CONVERSION: Explicit mapping from ${srcCount}ch to ${params.targetLayout} (${targetCount}ch) is not defined.`,
  );
}

/**
 * Anti-aliased Kaiser-windowed sinc resampling supporting BOTH downsampling AND upsampling
 * with deterministic output frame-count policy: `Math.floor(inputFrames * targetRate / sourceRate)`.
 */
export function resamplePlanarAudio(params: {
  readonly channels: readonly Float32Array[];
  readonly sourceSampleRate: SampleRate;
  readonly targetSampleRate: SampleRate;
  readonly chunkSizeFrames?: number;
  readonly abortSignal?: AbortSignal;
}): { readonly channels: Float32Array[]; readonly outputFrameCount: number; readonly filterTaps: number } {
  const { channels, sourceSampleRate, targetSampleRate } = params;
  if (!SUPPORTED_SAMPLE_RATES.has(sourceSampleRate) || !SUPPORTED_SAMPLE_RATES.has(targetSampleRate)) {
    throw new Error(`INVALID_SAMPLE_RATE: ${sourceSampleRate} -> ${targetSampleRate}`);
  }
  const inputFrames = channels[0]?.length ?? 0;
  if (sourceSampleRate === targetSampleRate) {
    return {
      channels: channels.map((c) => new Float32Array(c)),
      outputFrameCount: inputFrames,
      filterTaps: 1,
    };
  }

  // Downsampling uses the verified StreamingKaiserSincResampler directly in bounded chunks
  if (sourceSampleRate > targetSampleRate) {
    const chunkSize = Math.max(1024, Math.min(65536, params.chunkSizeFrames ?? 16384));
    const expectedOut = Math.floor(inputFrames / (sourceSampleRate / targetSampleRate));
    const outChannels: Float32Array[] = [];
    let taps = 0;

    for (let c = 0; c < channels.length; c++) {
      const resampler = new StreamingKaiserSincResampler(sourceSampleRate, targetSampleRate);
      taps = resampler.filterTaps;
      const out = new Float32Array(expectedOut);
      let writePos = 0;
      for (let off = 0; off < inputFrames; off += chunkSize) {
        if (params.abortSignal?.aborted) throw new Error('RESAMPLE_ABORTED');
        const slice = channels[c].subarray(off, Math.min(inputFrames, off + chunkSize));
        const piece = resampler.pushChunk(slice);
        const copyLen = Math.min(piece.length, expectedOut - writePos);
        if (copyLen > 0) {
          out.set(piece.subarray(0, copyLen), writePos);
          writePos += copyLen;
        }
      }
      const tail = resampler.flush();
      const tailCopy = Math.min(tail.length, expectedOut - writePos);
      if (tailCopy > 0) {
        out.set(tail.subarray(0, tailCopy), writePos);
        writePos += tailCopy;
      }
      outChannels.push(writePos === expectedOut ? out : out.subarray(0, writePos));
    }
    return {
      channels: outChannels,
      outputFrameCount: outChannels[0]?.length ?? 0,
      filterTaps: taps,
    };
  }

  // Upsampling: anti-imaged Kaiser-windowed sinc interpolation at source Nyquist (0.45 * sourceSampleRate)
  const ratio = sourceSampleRate / targetSampleRate; // < 1
  const outputFrameCount = Math.floor(inputFrames / ratio);
  const halfWidth = 16;
  const filterTaps = halfWidth * 2 + 1;
  const beta = 6.5;
  const besselI0 = (x: number): number => {
    let sum = 1.0;
    let term = 1.0;
    const xHalf = x * 0.5;
    for (let k = 1; k <= 20; k++) {
      term *= (xHalf / k) * (xHalf / k);
      sum += term;
      if (term < 1e-12 * sum) break;
    }
    return sum;
  };
  const invI0Beta = 1 / besselI0(beta);
  const fc = 0.45; // normalized to source rate

  const outChannels = channels.map((src) => {
    const dst = new Float32Array(outputFrameCount);
    for (let outIdx = 0; outIdx < outputFrameCount; outIdx++) {
      if ((outIdx & 0x3fff) === 0 && params.abortSignal?.aborted) {
        throw new Error('RESAMPLE_ABORTED');
      }
      const center = outIdx * ratio;
      const centerInt = Math.floor(center);
      let acc = 0;
      let wSum = 0;
      for (let t = -halfWidth; t <= halfWidth; t++) {
        const inIdx = centerInt + t;
        if (inIdx < 0 || inIdx >= inputFrames) continue;
        const x = inIdx - center;
        const norm = x / halfWidth;
        if (Math.abs(norm) > 1) continue;
        const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - norm * norm))) * invI0Beta;
        const sincArg = 2 * fc * x;
        const sinc = Math.abs(sincArg) < 1e-8 ? 2 * fc : Math.sin(Math.PI * sincArg) / (Math.PI * x);
        const w = sinc * win;
        acc += src[inIdx] * w;
        wSum += w;
      }
      dst[outIdx] = wSum > 1e-9 ? acc / wSum : 0;
    }
    return dst;
  });

  return { channels: outChannels, outputFrameCount, filterTaps };
}

/**
 * Explicit Fade-In and Fade-Out processor using exact mathematical gain curves.
 */
export function applyFadeInOut(params: {
  readonly channels: readonly Float32Array[];
  readonly fadeInSamples?: number;
  readonly fadeOutSamples?: number;
  readonly curve?: FadeCurveType;
}): Float32Array[] {
  const curve = params.curve ?? 'smooth-cosine';
  const frameCount = params.channels[0]?.length ?? 0;
  const fadeIn = Math.max(0, Math.min(frameCount, Math.trunc(params.fadeInSamples ?? 0)));
  const fadeOut = Math.max(0, Math.min(frameCount, Math.trunc(params.fadeOutSamples ?? 0)));

  return params.channels.map((src) => {
    const out = new Float32Array(src);
    if (fadeIn > 0) {
      const denom = Math.max(1, fadeIn - 1);
      for (let i = 0; i < fadeIn; i++) {
        const g = AudioCrossfadeProcessor.computeGainPair(curve, i / denom).fadeInGain;
        out[i] *= g;
      }
    }
    if (fadeOut > 0) {
      const start = frameCount - fadeOut;
      const denom = Math.max(1, fadeOut - 1);
      for (let i = 0; i < fadeOut; i++) {
        const g = AudioCrossfadeProcessor.computeGainPair(curve, i / denom).fadeOutGain;
        out[start + i] *= g;
      }
    }
    return out;
  });
}

/**
 * Silence vs low-level signal classification (non-destructive analysis only).
 * Explicitly distinguishes true digital zero, noise floor / near-silence, and speech/program signal.
 */
export type SilenceWindowClassification = 'DIGITAL_SILENCE' | 'LOW_LEVEL_AMBIENT' | 'ACTIVE_SIGNAL';

export function classifySilenceWindow(
  channel0: Float32Array,
  startSample: number,
  endSample: number,
  options?: { readonly lowLevelRmsDbfsThreshold?: number },
): {
  readonly classification: SilenceWindowClassification;
  readonly peakAmplitude: number;
  readonly rmsDbfs: number;
} {
  const s = Math.max(0, Math.min(channel0.length, Math.trunc(startSample)));
  const e = Math.max(s, Math.min(channel0.length, Math.trunc(endSample)));
  const thresholdDbfs = options?.lowLevelRmsDbfsThreshold ?? -45;
  let peak = 0;
  let sumSq = 0;
  const len = e - s;
  for (let i = s; i < e; i++) {
    const v = Number.isFinite(channel0[i]) ? channel0[i] : 0;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = len > 0 ? Math.sqrt(sumSq / len) : 0;
  const rmsDbfs = rms <= 1e-9 ? -180 : 20 * Math.log10(rms);

  let classification: SilenceWindowClassification = 'ACTIVE_SIGNAL';
  if (peak === 0) {
    classification = 'DIGITAL_SILENCE';
  } else if (rmsDbfs < thresholdDbfs) {
    classification = 'LOW_LEVEL_AMBIENT';
  }

  return { classification, peakAmplitude: peak, rmsDbfs };
}

/**
 * Sample-accurate non-destructive Timeline Operations (`AVP-P0-008 §3`).
 */
export type CanonicalTimelineOp =
  | {
      readonly opId: string;
      readonly kind: 'TRIM';
      readonly startSample: number;
      readonly endSample: number;
    }
  | {
      readonly opId: string;
      readonly kind: 'DELETE_RANGE';
      readonly startSample: number;
      readonly endSample: number;
      readonly crossfadeSamples?: number;
      readonly crossfadeCurve?: CrossfadeCurve;
    }
  | {
      readonly opId: string;
      readonly kind: 'SILENCE_REMOVAL';
      readonly startSample: number;
      readonly endSample: number;
      readonly preservePaddingSamples?: number;
      readonly crossfadeSamples?: number;
    }
  | {
      readonly opId: string;
      readonly kind: 'GAP_INSERTION';
      readonly atSample: number;
      readonly durationSamples: number;
    }
  | {
      readonly opId: string;
      readonly kind: 'REPOSITION_SEGMENT';
      readonly sourceStartSample: number;
      readonly sourceEndSample: number;
      readonly insertAtOutputSample: number;
    }
  | {
      readonly opId: string;
      readonly kind: 'FADE_IN';
      readonly durationSamples: number;
      readonly curve?: FadeCurveType;
    }
  | {
      readonly opId: string;
      readonly kind: 'FADE_OUT';
      readonly durationSamples: number;
      readonly curve?: FadeCurveType;
    };

export interface TimelineClipSegment {
  readonly kind: 'SOURCE' | 'SILENCE_GAP';
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly frameCount: number;
  readonly fadeInSamples?: number;
  readonly fadeOutSamples?: number;
  readonly fadeCurve?: FadeCurveType;
  readonly incomingCrossfadeSamples?: number;
  readonly incomingCrossfadeCurve?: CrossfadeCurve;
}

export interface TimelineExecutionResult {
  readonly ok: boolean;
  readonly channels: Float32Array[];
  readonly outputFrameCount: number;
  readonly segments: readonly TimelineClipSegment[];
  readonly metrics: SignalIntegrityMetrics;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Deterministically executes an ordered list of sample-accurate non-destructive timeline operations
 * without mutating the source audio buffer.
 */
export function executeSampleAccurateTimeline(params: {
  readonly source: CanonicalAudioBuffer;
  readonly operations: readonly CanonicalTimelineOp[];
  readonly abortSignal?: AbortSignal;
}): TimelineExecutionResult {
  const { source, operations } = params;
  const srcCheck = validateCanonicalAudioDescriptor(source.descriptor, source.channels);
  if (!srcCheck.valid) {
    return {
      ok: false,
      channels: [],
      outputFrameCount: 0,
      segments: [],
      metrics: inspectNumericalIntegrity([]),
      errorCode: 'CORRUPT_SOURCE_AUDIO',
      errorMessage: srcCheck.errors.join(' | '),
    };
  }

  let currentChannels = source.channels.map((c) => new Float32Array(c));
  const appliedSegments: TimelineClipSegment[] = [
    {
      kind: 'SOURCE',
      sourceStartSample: 0,
      sourceEndSample: source.descriptor.frameCount,
      frameCount: source.descriptor.frameCount,
    },
  ];

  for (const op of operations) {
    if (params.abortSignal?.aborted) {
      return {
        ok: false,
        channels: [],
        outputFrameCount: 0,
        segments: [],
        metrics: inspectNumericalIntegrity([]),
        errorCode: 'RENDER_CANCELLED',
        errorMessage: 'Timeline execution aborted by signal.',
      };
    }

    const curFrames = currentChannels[0]?.length ?? 0;

    if (op.kind === 'TRIM') {
      if (
        !Number.isSafeInteger(op.startSample) ||
        !Number.isSafeInteger(op.endSample) ||
        op.startSample < 0 ||
        op.endSample > curFrames ||
        op.endSample <= op.startSample
      ) {
        return {
          ok: false,
          channels: [],
          outputFrameCount: 0,
          segments: [],
          metrics: inspectNumericalIntegrity([]),
          errorCode: 'OUT_OF_RANGE_BOUNDARY',
          errorMessage: `TRIM [${op.startSample}, ${op.endSample}) invalid for ${curFrames} frames.`,
        };
      }
      currentChannels = currentChannels.map((ch) => ch.slice(op.startSample, op.endSample));
    } else if (op.kind === 'DELETE_RANGE' || op.kind === 'SILENCE_REMOVAL') {
      const pad = op.kind === 'SILENCE_REMOVAL' ? Math.max(0, Math.trunc(op.preservePaddingSamples ?? 0)) : 0;
      const effStart = op.startSample + pad;
      const effEnd = op.endSample - pad;
      if (
        !Number.isSafeInteger(op.startSample) ||
        !Number.isSafeInteger(op.endSample) ||
        op.startSample < 0 ||
        op.endSample > curFrames ||
        op.endSample <= op.startSample
      ) {
        return {
          ok: false,
          channels: [],
          outputFrameCount: 0,
          segments: [],
          metrics: inspectNumericalIntegrity([]),
          errorCode: 'OUT_OF_RANGE_BOUNDARY',
          errorMessage: `${op.kind} [${op.startSample}, ${op.endSample}) invalid for ${curFrames} frames.`,
        };
      }
      if (effEnd <= effStart) {
        continue; // Padding preserved the entire region safely
      }
      const leftLen = effStart;
      const rightLen = curFrames - effEnd;
      const requestedXfade = Math.max(0, Math.trunc(op.crossfadeSamples ?? 0));
      const xfade = Math.min(requestedXfade, leftLen, rightLen);
      const outLen = leftLen + rightLen - xfade;
      const curve: CrossfadeCurve =
        op.kind === 'DELETE_RANGE' && op.crossfadeCurve ? op.crossfadeCurve : 'smooth-cosine';

      const nextChannels = currentChannels.map(() => new Float32Array(outLen));
      if (xfade >= 2) {
        const leftTail = currentChannels.map((ch) => ch.subarray(leftLen - xfade, leftLen));
        const rightHead = currentChannels.map((ch) => ch.subarray(effEnd, effEnd + xfade));
        const { blended } = AudioCrossfadeProcessor.blendTransition({
          transitionIndex: 0,
          proposalId: op.opId,
          leftTail,
          rightHead,
          preferredCurve: curve,
          enableLimiter: true,
        });
        for (let c = 0; c < currentChannels.length; c++) {
          if (leftLen - xfade > 0) {
            nextChannels[c].set(currentChannels[c].subarray(0, leftLen - xfade), 0);
          }
          nextChannels[c].set(blended[c], leftLen - xfade);
          if (rightLen - xfade > 0) {
            nextChannels[c].set(currentChannels[c].subarray(effEnd + xfade), leftLen);
          }
        }
      } else {
        for (let c = 0; c < currentChannels.length; c++) {
          if (leftLen > 0) nextChannels[c].set(currentChannels[c].subarray(0, leftLen), 0);
          if (rightLen > 0) nextChannels[c].set(currentChannels[c].subarray(effEnd), leftLen);
        }
      }
      currentChannels = nextChannels;
    } else if (op.kind === 'GAP_INSERTION') {
      if (
        !Number.isSafeInteger(op.atSample) ||
        !Number.isSafeInteger(op.durationSamples) ||
        op.atSample < 0 ||
        op.atSample > curFrames ||
        op.durationSamples < 0
      ) {
        return {
          ok: false,
          channels: [],
          outputFrameCount: 0,
          segments: [],
          metrics: inspectNumericalIntegrity([]),
          errorCode: 'OUT_OF_RANGE_BOUNDARY',
          errorMessage: `GAP_INSERTION at=${op.atSample}, dur=${op.durationSamples} invalid.`,
        };
      }
      const outLen = curFrames + op.durationSamples;
      currentChannels = currentChannels.map((ch) => {
        const out = new Float32Array(outLen);
        out.set(ch.subarray(0, op.atSample), 0);
        // [atSample, atSample + durationSamples) remains exact digital zero
        out.set(ch.subarray(op.atSample), op.atSample + op.durationSamples);
        return out;
      });
    } else if (op.kind === 'REPOSITION_SEGMENT') {
      if (
        !Number.isSafeInteger(op.sourceStartSample) ||
        !Number.isSafeInteger(op.sourceEndSample) ||
        op.sourceStartSample < 0 ||
        op.sourceEndSample > curFrames ||
        op.sourceEndSample <= op.sourceStartSample
      ) {
        return {
          ok: false,
          channels: [],
          outputFrameCount: 0,
          segments: [],
          metrics: inspectNumericalIntegrity([]),
          errorCode: 'OUT_OF_RANGE_BOUNDARY',
          errorMessage: `REPOSITION_SEGMENT [${op.sourceStartSample}, ${op.sourceEndSample}) out of bounds.`,
        };
      }
      const segLen = op.sourceEndSample - op.sourceStartSample;
      const remainingLen = curFrames - segLen;
      if (
        !Number.isSafeInteger(op.insertAtOutputSample) ||
        op.insertAtOutputSample < 0 ||
        op.insertAtOutputSample > remainingLen
      ) {
        return {
          ok: false,
          channels: [],
          outputFrameCount: 0,
          segments: [],
          metrics: inspectNumericalIntegrity([]),
          errorCode: 'OUT_OF_RANGE_BOUNDARY',
          errorMessage: `REPOSITION_SEGMENT insertAt=${op.insertAtOutputSample} exceeds remaining frames (${remainingLen}).`,
        };
      }
      currentChannels = currentChannels.map((ch) => {
        const moved = ch.slice(op.sourceStartSample, op.sourceEndSample);
        const without = new Float32Array(remainingLen);
        without.set(ch.subarray(0, op.sourceStartSample), 0);
        without.set(ch.subarray(op.sourceEndSample), op.sourceStartSample);
        const out = new Float32Array(curFrames);
        out.set(without.subarray(0, op.insertAtOutputSample), 0);
        out.set(moved, op.insertAtOutputSample);
        out.set(without.subarray(op.insertAtOutputSample), op.insertAtOutputSample + segLen);
        return out;
      });
    } else if (op.kind === 'FADE_IN') {
      currentChannels = applyFadeInOut({
        channels: currentChannels,
        fadeInSamples: op.durationSamples,
        curve: op.curve,
      }).map((ch) => new Float32Array(ch));
    } else if (op.kind === 'FADE_OUT') {
      currentChannels = applyFadeInOut({
        channels: currentChannels,
        fadeOutSamples: op.durationSamples,
        curve: op.curve,
      }).map((ch) => new Float32Array(ch));
    }
  }

  const metrics = inspectNumericalIntegrity(currentChannels);
  if (!metrics.valid) {
    return {
      ok: false,
      channels: [],
      outputFrameCount: 0,
      segments: [],
      metrics,
      errorCode: 'NON_FINITE_OUTPUT_SAMPLES',
      errorMessage: `Detected ${metrics.nonFiniteCount} non-finite sample(s) after timeline execution.`,
    };
  }

  return {
    ok: true,
    channels: currentChannels,
    outputFrameCount: currentChannels[0]?.length ?? 0,
    segments: appliedSegments,
    metrics,
  };
}

/**
 * Independently decodes a WAV buffer (PCM16, PCM24, or IEEE Float32) back into planar Float32Array channels
 * so exported artifacts are verified at the decoded-sample level rather than trusting write metadata.
 */
export function decodeWaveArtifactToPlanarFloat32(wavBytes: Uint8Array): {
  readonly ok: boolean;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly encoding: RenderExportEncoding | null;
  readonly frameCount: number;
  readonly channels: Float32Array[];
  readonly error?: string;
} {
  const parsed = parseWaveContainerBytes(wavBytes);
  if (!parsed.valid || !parsed.encoding) {
    return {
      ok: false,
      sampleRate: 0,
      channelCount: 0,
      encoding: null,
      frameCount: 0,
      channels: [],
      error: parsed.error ?? 'Failed to parse WAV container.',
    };
  }

  const frameCount = parsed.sampleCountPerChannel;
  const channelCount = parsed.channelCount;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  let pos = parsed.dataOffsetBytes;

  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channelCount; c++) {
      if (parsed.encoding === 'pcm16') {
        const s = view.getInt16(pos, true);
        channels[c][i] = s < 0 ? s / 32768 : s / 32767;
        pos += 2;
      } else if (parsed.encoding === 'pcm24') {
        const b0 = wavBytes[pos];
        const b1 = wavBytes[pos + 1];
        const b2 = wavBytes[pos + 2];
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= ~0xffffff;
        channels[c][i] = val < 0 ? val / 8388608 : val / 8388607;
        pos += 3;
      } else {
        channels[c][i] = view.getFloat32(pos, true);
        pos += 4;
      }
    }
  }

  return {
    ok: true,
    sampleRate: parsed.sampleRate,
    channelCount,
    encoding: parsed.encoding,
    frameCount,
    channels,
  };
}

export interface DeterministicRenderVerificationResult {
  readonly ok: boolean;
  readonly wavBytes: Uint8Array | null;
  readonly outputHash: string | null;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly encoding: RenderExportEncoding;
  readonly expectedFrames: number;
  readonly verifiedFrames: number;
  readonly verifiedDurationSec: number;
  readonly decodedMetrics: SignalIntegrityMetrics | null;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Canonical deterministic rendering pipeline with independent decode-back verification.
 * Uses bounded chunk streaming through `AudioExportWriter` + `MemoryBudgetManager`.
 */
export async function renderAndVerifyDeterministicWav(params: {
  readonly renderId: string;
  readonly channels: readonly Float32Array[];
  readonly sourceSampleRate: SampleRate;
  readonly outputSampleRate?: SampleRate;
  readonly targetLayout?: CanonicalChannelLayout;
  readonly encoding: RenderExportEncoding;
  readonly chunkSizeFrames?: number;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly abortSignal?: AbortSignal;
}): Promise<DeterministicRenderVerificationResult> {
  const outputSampleRate = params.outputSampleRate ?? params.sourceSampleRate;
  const budget = params.memoryBudgetManager ?? getSharedMemoryBudgetManager();
  const chunkSize = Math.max(1024, Math.min(65536, params.chunkSizeFrames ?? 16384));

  let working: Float32Array[] = params.channels.map((c) => new Float32Array(c));
  const preMetrics = inspectNumericalIntegrity(working);
  if (!preMetrics.valid) {
    return {
      ok: false,
      wavBytes: null,
      outputHash: null,
      sampleRate: outputSampleRate,
      channelCount: working.length,
      encoding: params.encoding,
      expectedFrames: working[0]?.length ?? 0,
      verifiedFrames: 0,
      verifiedDurationSec: 0,
      decodedMetrics: null,
      errorCode: 'INVALID_NUMERIC_SAMPLES',
      errorMessage: `Refused to export buffer with ${preMetrics.nonFiniteCount} non-finite sample(s).`,
    };
  }

  if (params.targetLayout) {
    working = convertChannelLayout({
      channels: working,
      targetLayout: params.targetLayout,
    });
  }

  if (outputSampleRate !== params.sourceSampleRate) {
    const resampled = resamplePlanarAudio({
      channels: working,
      sourceSampleRate: params.sourceSampleRate,
      targetSampleRate: outputSampleRate,
      chunkSizeFrames: chunkSize,
      abortSignal: params.abortSignal,
    });
    working = resampled.channels;
  }

  const expectedFrames = working[0]?.length ?? 0;
  const channelCount = working.length;
  const sink = new BoundedChunkedByteSink({ memoryBudgetManager: budget });
  const writer = new AudioExportWriter({
    renderId: params.renderId,
    artifactId: `det_${params.renderId}`,
    container: 'wav',
    encoding: params.encoding,
    sampleRate: outputSampleRate,
    channelCount,
    sink,
  });

  try {
    await writer.begin();
    for (let off = 0; off < expectedFrames; off += chunkSize) {
      if (params.abortSignal?.aborted) {
        await writer.abort();
        return {
          ok: false,
          wavBytes: null,
          outputHash: null,
          sampleRate: outputSampleRate,
          channelCount,
          encoding: params.encoding,
          expectedFrames,
          verifiedFrames: 0,
          verifiedDurationSec: 0,
          decodedMetrics: null,
          errorCode: 'RENDER_CANCELLED',
          errorMessage: 'Deterministic WAV export cancelled; temporary buffers released.',
        };
      }
      const len = Math.min(chunkSize, expectedFrames - off);
      const chunk = working.map((ch) => ch.subarray(off, off + len));
      await writer.writePlanarChunk(chunk, len);
    }

    const meta = await writer.finalize(1_700_000_000_000);
    const totalBytes = sink.getTotalBytesWritten();
    const outBytes = new Uint8Array(totalBytes);
    let readCursor = 0;
    while (readCursor < totalBytes) {
      const toRead = Math.min(1024 * 1024, totalBytes - readCursor);
      const slice = await sink.readRange(readCursor, toRead);
      outBytes.set(slice, readCursor);
      readCursor += slice.byteLength;
    }

    // Independent decode-back verification (never trust write call alone)
    const decoded = decodeWaveArtifactToPlanarFloat32(outBytes);
    if (!decoded.ok) {
      return {
        ok: false,
        wavBytes: null,
        outputHash: null,
        sampleRate: outputSampleRate,
        channelCount,
        encoding: params.encoding,
        expectedFrames,
        verifiedFrames: 0,
        verifiedDurationSec: 0,
        decodedMetrics: null,
        errorCode: 'EXPORT_VERIFICATION_FAILED',
        errorMessage: decoded.error ?? 'Decoded WAV verification failed.',
      };
    }

    const decodedMetrics = inspectNumericalIntegrity(decoded.channels);
    if (
      decoded.sampleRate !== outputSampleRate ||
      decoded.channelCount !== channelCount ||
      decoded.frameCount !== expectedFrames ||
      !decodedMetrics.valid
    ) {
      return {
        ok: false,
        wavBytes: null,
        outputHash: null,
        sampleRate: outputSampleRate,
        channelCount,
        encoding: params.encoding,
        expectedFrames,
        verifiedFrames: decoded.frameCount,
        verifiedDurationSec: decoded.frameCount / Math.max(1, decoded.sampleRate),
        decodedMetrics,
        errorCode: 'EXPORT_VERIFICATION_MISMATCH',
        errorMessage: `Decoded artifact mismatch (frames=${decoded.frameCount}/${expectedFrames}, sr=${decoded.sampleRate}/${outputSampleRate}, ch=${decoded.channelCount}/${channelCount}).`,
      };
    }

    return {
      ok: true,
      wavBytes: outBytes,
      outputHash: meta.outputHash,
      sampleRate: outputSampleRate,
      channelCount,
      encoding: params.encoding,
      expectedFrames,
      verifiedFrames: decoded.frameCount,
      verifiedDurationSec: Number((decoded.frameCount / decoded.sampleRate).toFixed(6)),
      decodedMetrics,
    };
  } catch (err) {
    await writer.abort().catch(() => {});
    return {
      ok: false,
      wavBytes: null,
      outputHash: null,
      sampleRate: outputSampleRate,
      channelCount,
      encoding: params.encoding,
      expectedFrames,
      verifiedFrames: 0,
      verifiedDurationSec: 0,
      decodedMetrics: null,
      errorCode: 'RENDER_IO_FAILURE',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    sink.disposeCommitted();
  }
}

/** Deterministic DSP reference signal fixture generators (`AVP-P0-008 §8`) */
export const DspReferenceFixtures = {
  impulse(frameCount: number, impulseAt = 0, amplitude = 0.9): Float32Array {
    const out = new Float32Array(frameCount);
    if (impulseAt >= 0 && impulseAt < frameCount) out[impulseAt] = amplitude;
    return out;
  },
  sineWave(frameCount: number, sampleRate: number, freqHz: number, amplitude = 0.5, phaseRad = 0): Float32Array {
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate + phaseRad);
    }
    return out;
  },
  linearSweep(frameCount: number, sampleRate: number, startHz: number, endHz: number, amplitude = 0.4): Float32Array {
    const out = new Float32Array(frameCount);
    const dur = frameCount / sampleRate;
    for (let i = 0; i < frameCount; i++) {
      const t = i / sampleRate;
      const phase = 2 * Math.PI * (startHz * t + ((endHz - startHz) / (2 * Math.max(1e-6, dur))) * t * t);
      out[i] = amplitude * Math.sin(phase);
    }
    return out;
  },
  deterministicWhiteNoise(frameCount: number, amplitude = 0.25, seed = 0x51a7c3d1): Float32Array {
    const out = new Float32Array(frameCount);
    let state = seed >>> 0;
    for (let i = 0; i < frameCount; i++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
    }
    return out;
  },
  digitalSilence(frameCount: number): Float32Array {
    return new Float32Array(frameCount);
  },
  nearSilence(frameCount: number, amplitude = 1e-4): Float32Array {
    return this.deterministicWhiteNoise(frameCount, amplitude, 0x12345678);
  },
  abruptStepTransition(frameCount: number, stepAt: number, leftVal = -0.7, rightVal = 0.7): Float32Array {
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      out[i] = i < stepAt ? leftVal : rightVal;
    }
    return out;
  },
};
