import { AntiAliasedResampler } from '../ai-engine/AntiAliasedResampler';
import { SampleRate } from '../contracts/timebase.contract';
import {
  asResampledFramePosition,
  asSourceSamplePosition,
  ResampledFramePosition,
  SourceSamplePosition,
} from './SamplePosition';
import { assertValidSampleRate, buildSampleRateRatio } from './SampleRate';
import {
  resampledFrameToSourceSample,
  RoundingPolicy,
  sourceSampleToResampledFrame,
} from './TimeConversion';

export interface ResampleConversionProvenance {
  readonly sourceSampleRate: SampleRate;
  readonly targetSampleRate: SampleRate;
  readonly originalSampleCount: number;
  readonly resampledSampleCount: number;
  readonly exactRatioNumerator: string;
  readonly exactRatioDenominator: string;
  readonly filterTaps: number;
  readonly filterDelaySamples: number;
  readonly groupDelaySourceSamples: number;
  readonly boundaryPolicy: 'ZERO_PAD_SYMMETRIC_BOUNDARY';
  readonly roundingPolicy: RoundingPolicy;
  readonly channelMapping: 'AVERAGED_MONO_DOWNMIX' | 'IDENTITY_MONO';
  readonly resamplerImplementation: 'AntiAliasedResampler';
}

export interface ResampledAudioWithProvenance {
  readonly samples: Float32Array;
  readonly provenance: ResampleConversionProvenance;
}

/**
 * Canonical Resample Coordinate Mapper wrapping the existing AntiAliasedResampler
 * (AVP-P12-001 Section 2 — zero duplicate resampler, zero cumulative drift).
 */
export class ResampleCoordinateMapper {
  public readonly sourceSampleRate: SampleRate;
  public readonly targetSampleRate: SampleRate;
  public readonly filterTaps: number;
  public readonly roundingPolicy: RoundingPolicy;
  private readonly resampler: AntiAliasedResampler;

  constructor(params: {
    readonly sourceSampleRate: SampleRate;
    readonly targetSampleRate?: SampleRate;
    readonly filterTaps?: number;
    readonly roundingPolicy?: RoundingPolicy;
  }) {
    assertValidSampleRate(params.sourceSampleRate);
    const target = params.targetSampleRate ?? 16000;
    assertValidSampleRate(target);
    this.sourceSampleRate = params.sourceSampleRate;
    this.targetSampleRate = target;
    const rawTaps =
      typeof params.filterTaps === 'number' && Number.isFinite(params.filterTaps) && params.filterTaps >= 3
        ? Math.trunc(params.filterTaps)
        : 63;
    this.filterTaps = rawTaps % 2 === 1 ? rawTaps : rawTaps + 1;
    this.roundingPolicy = params.roundingPolicy ?? 'HALF_UP';
    this.resampler = new AntiAliasedResampler(this.sourceSampleRate, this.targetSampleRate, this.filterTaps);
  }

  public resampleToMonoWithProvenance(channels: Float32Array[]): ResampledAudioWithProvenance {
    const ratio = buildSampleRateRatio(this.sourceSampleRate, this.targetSampleRate);
    if (channels.length === 0 || channels[0].length === 0) {
      return {
        samples: new Float32Array(0),
        provenance: {
          sourceSampleRate: this.sourceSampleRate,
          targetSampleRate: this.targetSampleRate,
          originalSampleCount: 0,
          resampledSampleCount: 0,
          exactRatioNumerator: ratio.numerator.toString(),
          exactRatioDenominator: ratio.denominator.toString(),
          filterTaps: this.filterTaps,
          filterDelaySamples: 0,
          groupDelaySourceSamples: 0,
          boundaryPolicy: 'ZERO_PAD_SYMMETRIC_BOUNDARY',
          roundingPolicy: this.roundingPolicy,
          channelMapping: channels.length <= 1 ? 'IDENTITY_MONO' : 'AVERAGED_MONO_DOWNMIX',
          resamplerImplementation: 'AntiAliasedResampler',
        },
      };
    }

    const originalSampleCount = channels[0].length;
    const samples = this.resampler.processToMono16k(channels);
    const filterDelaySamples =
      this.sourceSampleRate === this.targetSampleRate ? 0 : Math.floor(this.filterTaps / 2);

    return {
      samples,
      provenance: {
        sourceSampleRate: this.sourceSampleRate,
        targetSampleRate: this.targetSampleRate,
        originalSampleCount,
        resampledSampleCount: samples.length,
        exactRatioNumerator: ratio.numerator.toString(),
        exactRatioDenominator: ratio.denominator.toString(),
        filterTaps: this.filterTaps,
        filterDelaySamples,
        groupDelaySourceSamples: filterDelaySamples,
        boundaryPolicy: 'ZERO_PAD_SYMMETRIC_BOUNDARY',
        roundingPolicy: this.roundingPolicy,
        channelMapping: channels.length === 1 ? 'IDENTITY_MONO' : 'AVERAGED_MONO_DOWNMIX',
        resamplerImplementation: 'AntiAliasedResampler',
      },
    };
  }

  /**
   * Chunked resampling using overlap-context from original source coordinates so adjacent chunks
   * remain continuous without edge discontinuities or cumulative sample drift.
   */
  public resampleChunkContinuous(params: {
    readonly fullChannels: readonly Float32Array[];
    readonly sourceStartSample: SourceSamplePosition;
    readonly sourceEndSample: SourceSamplePosition;
  }): {
    readonly resampledChunk: Float32Array;
    readonly expectedTargetStartFrame: ResampledFramePosition;
    readonly expectedTargetEndFrame: ResampledFramePosition;
  } {
    const safeStart =
      Number.isSafeInteger(params.sourceStartSample) && params.sourceStartSample >= 0
        ? params.sourceStartSample
        : asSourceSamplePosition(0);
    const safeEnd =
      Number.isSafeInteger(params.sourceEndSample) && params.sourceEndSample >= safeStart
        ? params.sourceEndSample
        : safeStart;
    const targetStart = sourceSampleToResampledFrame(
      safeStart,
      this.sourceSampleRate,
      this.targetSampleRate,
      'FLOOR',
    );
    const targetEnd = sourceSampleToResampledFrame(
      safeEnd,
      this.sourceSampleRate,
      this.targetSampleRate,
      'FLOOR',
    );

    const outLen = Math.max(0, targetEnd - targetStart);
    if (outLen === 0 || params.fullChannels.length === 0) {
      return {
        resampledChunk: new Float32Array(0),
        expectedTargetStartFrame: targetStart,
        expectedTargetEndFrame: targetEnd,
      };
    }

    const totalIn = params.fullChannels[0].length;
    const wing = this.sourceSampleRate === this.targetSampleRate ? 0 : Math.floor(this.filterTaps / 2) + 4;
    const readStart = Math.max(0, safeStart - wing);
    const readEnd = Math.min(totalIn, safeEnd + wing);

    const sliced = params.fullChannels.map((ch) => ch.subarray(readStart, readEnd));
    const resampledWithContext = this.resampler.processToMono16k(sliced);
    const trimFront = sourceSampleToResampledFrame(
      asSourceSamplePosition(Math.max(0, safeStart - readStart)),
      this.sourceSampleRate,
      this.targetSampleRate,
      'FLOOR',
    );
    const availableEnd = Math.min(resampledWithContext.length, trimFront + outLen);
    const chunk = new Float32Array(outLen);
    if (availableEnd > trimFront) {
      chunk.set(resampledWithContext.subarray(trimFront, availableEnd), 0);
    }
    return {
      resampledChunk: chunk,
      expectedTargetStartFrame: asResampledFramePosition(targetStart),
      expectedTargetEndFrame: asResampledFramePosition(targetEnd),
    };
  }

  public toResampledFrame(sourceSample: SourceSamplePosition): ResampledFramePosition {
    return sourceSampleToResampledFrame(
      sourceSample,
      this.sourceSampleRate,
      this.targetSampleRate,
      this.roundingPolicy,
    );
  }

  public toSourceSample(resampledFrame: ResampledFramePosition): SourceSamplePosition {
    return resampledFrameToSourceSample(
      resampledFrame,
      this.sourceSampleRate,
      this.targetSampleRate,
      this.roundingPolicy,
    );
  }
}
