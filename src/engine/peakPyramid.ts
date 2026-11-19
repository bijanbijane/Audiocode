import { PeakLevel, PeakPyramid } from '../contracts/v1_2';

const DEFAULT_BIN_SIZES = [64, 256, 1024, 4096] as const;

/**
 * Computes Multi-Resolution Peak Pyramid (LOD) in streaming chunks
 * so multi-hour waveforms render at 60fps from OPFS without holding full PCM in RAM.
 */
export function buildPeakPyramid(
  assetId: string,
  channels: Float32Array[],
  sampleRate: number,
  binSizes: readonly number[] = DEFAULT_BIN_SIZES,
): PeakPyramid {
  const totalSamples = channels[0]?.length ?? 0;
  const levels: PeakLevel[] = [];

  if (totalSamples === 0) {
    return { assetId, sampleRate, totalSamples: 0, levels: [] };
  }

  for (const binSize of binSizes) {
    const numBins = Math.ceil(totalSamples / binSize);
    const minArr = new Float32Array(numBins);
    const maxArr = new Float32Array(numBins);
    const rmsArr = new Float32Array(numBins);

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(totalSamples, start + binSize);
      let minVal = 1.0;
      let maxVal = -1.0;
      let sumSq = 0;
      let count = 0;

      for (let i = start; i < end; i++) {
        // Mono-folded peak across channels
        let sample = 0;
        for (let c = 0; c < channels.length; c++) {
          sample += channels[c][i];
        }
        sample /= channels.length;
        if (sample < minVal) minVal = sample;
        if (sample > maxVal) maxVal = sample;
        sumSq += sample * sample;
        count++;
      }

      minArr[b] = count > 0 ? minVal : 0;
      maxArr[b] = count > 0 ? maxVal : 0;
      rmsArr[b] = count > 0 ? Math.sqrt(sumSq / count) : 0;
    }

    levels.push({
      samplesPerBin: binSize,
      min: minArr,
      max: maxArr,
      rms: rmsArr,
    });
  }

  return {
    assetId,
    sampleRate,
    totalSamples,
    levels,
  };
}

/** Selects optimal LOD level for the requested samples-per-pixel viewport zoom */
export function selectPeakLevel(pyramid: PeakPyramid, samplesPerPixel: number): PeakLevel | null {
  if (pyramid.levels.length === 0) return null;
  let chosen = pyramid.levels[0];
  for (const level of pyramid.levels) {
    if (level.samplesPerBin <= Math.max(1, samplesPerPixel * 0.75)) {
      chosen = level;
    }
  }
  return chosen;
}

/**
 * Incrementally computes a Multi-Resolution PeakPyramid across streaming PCM chunks
 * without retaining full-file audio in JavaScript memory.
 */
export class StreamingPeakPyramidBuilder {
  private readonly binSizes: readonly number[];
  private readonly levelStates: Array<{
    binSize: number;
    mins: number[];
    maxs: number[];
    rmss: number[];
    curMin: number;
    curMax: number;
    curSumSq: number;
    curCount: number;
  }>;
  private totalSamples = 0;

  constructor(
    private readonly assetId: string,
    private readonly sampleRate: number,
    binSizes: readonly number[] = DEFAULT_BIN_SIZES,
  ) {
    this.binSizes = binSizes;
    this.levelStates = binSizes.map((binSize) => ({
      binSize,
      mins: [],
      maxs: [],
      rmss: [],
      curMin: 1.0,
      curMax: -1.0,
      curSumSq: 0,
      curCount: 0,
    }));
  }

  public pushMonoChunk(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.totalSamples += samples.length;

    for (const st of this.levelStates) {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s < st.curMin) st.curMin = s;
        if (s > st.curMax) st.curMax = s;
        st.curSumSq += s * s;
        st.curCount++;

        if (st.curCount >= st.binSize) {
          st.mins.push(st.curMin);
          st.maxs.push(st.curMax);
          st.rmss.push(Math.sqrt(st.curSumSq / st.curCount));
          st.curMin = 1.0;
          st.curMax = -1.0;
          st.curSumSq = 0;
          st.curCount = 0;
        }
      }
    }
  }

  public finalize(): PeakPyramid {
    if (this.totalSamples === 0) {
      return { assetId: this.assetId, sampleRate: this.sampleRate, totalSamples: 0, levels: [] };
    }

    const levels: PeakLevel[] = this.levelStates.map((st) => {
      if (st.curCount > 0) {
        st.mins.push(st.curMin);
        st.maxs.push(st.curMax);
        st.rmss.push(Math.sqrt(st.curSumSq / st.curCount));
        st.curCount = 0;
      }
      return {
        samplesPerBin: st.binSize,
        min: Float32Array.from(st.mins),
        max: Float32Array.from(st.maxs),
        rms: Float32Array.from(st.rmss),
      };
    });

    return {
      assetId: this.assetId,
      sampleRate: this.sampleRate,
      totalSamples: this.totalSamples,
      levels,
    };
  }
}

