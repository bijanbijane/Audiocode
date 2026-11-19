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
  if (!Array.isArray(channels) || channels.length === 0) {
    return { assetId, sampleRate, totalSamples: 0, levels: [] };
  }

  let totalSamples = channels[0]?.length ?? 0;
  for (let c = 1; c < channels.length; c++) {
    const len = channels[c]?.length ?? 0;
    if (len < totalSamples) totalSamples = len;
  }

  const levels: PeakLevel[] = [];

  if (totalSamples === 0) {
    return { assetId, sampleRate, totalSamples: 0, levels: [] };
  }

  for (const rawBinSize of binSizes) {
    if (!Number.isFinite(rawBinSize) || rawBinSize < 1) continue;
    const binSize = Math.floor(rawBinSize);
    const numBins = Math.ceil(totalSamples / binSize);
    const minArr = new Float32Array(numBins);
    const maxArr = new Float32Array(numBins);
    const rmsArr = new Float32Array(numBins);

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(totalSamples, start + binSize);
      let minVal = Number.POSITIVE_INFINITY;
      let maxVal = Number.NEGATIVE_INFINITY;
      let sumSq = 0;
      let count = 0;

      for (let i = start; i < end; i++) {
        // Mono-folded peak across channels with non-finite sanitization
        let sampleSum = 0;
        let validCh = 0;
        for (let c = 0; c < channels.length; c++) {
          const v = channels[c][i];
          if (Number.isFinite(v)) {
            sampleSum += v;
            validCh++;
          }
        }
        const sample = validCh > 0 ? sampleSum / validCh : 0;
        if (sample < minVal) minVal = sample;
        if (sample > maxVal) maxVal = sample;
        sumSq += sample * sample;
        count++;
      }

      minArr[b] = count > 0 && Number.isFinite(minVal) ? minVal : 0;
      maxArr[b] = count > 0 && Number.isFinite(maxVal) ? maxVal : 0;
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
    const validBinSizes = binSizes
      .filter((bs) => Number.isFinite(bs) && bs >= 1)
      .map((bs) => Math.floor(bs));
    this.levelStates = (validBinSizes.length > 0 ? validBinSizes : [...DEFAULT_BIN_SIZES]).map(
      (binSize) => ({
        binSize,
        mins: [],
        maxs: [],
        rmss: [],
        curMin: Number.POSITIVE_INFINITY,
        curMax: Number.NEGATIVE_INFINITY,
        curSumSq: 0,
        curCount: 0,
      }),
    );
  }

  public pushMonoChunk(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.totalSamples += samples.length;

    for (const st of this.levelStates) {
      for (let i = 0; i < samples.length; i++) {
        const raw = samples[i];
        const s = Number.isFinite(raw) ? raw : 0;
        if (s < st.curMin) st.curMin = s;
        if (s > st.curMax) st.curMax = s;
        st.curSumSq += s * s;
        st.curCount++;

        if (st.curCount >= st.binSize) {
          st.mins.push(Number.isFinite(st.curMin) ? st.curMin : 0);
          st.maxs.push(Number.isFinite(st.curMax) ? st.curMax : 0);
          st.rmss.push(Math.sqrt(st.curSumSq / st.curCount));
          st.curMin = Number.POSITIVE_INFINITY;
          st.curMax = Number.NEGATIVE_INFINITY;
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
      const hasPartial = st.curCount > 0;
      const outLen = st.mins.length + (hasPartial ? 1 : 0);
      const min = new Float32Array(outLen);
      const max = new Float32Array(outLen);
      const rms = new Float32Array(outLen);
      min.set(st.mins, 0);
      max.set(st.maxs, 0);
      rms.set(st.rmss, 0);
      if (hasPartial) {
        min[st.mins.length] = Number.isFinite(st.curMin) ? st.curMin : 0;
        max[st.maxs.length] = Number.isFinite(st.curMax) ? st.curMax : 0;
        rms[st.rmss.length] = Math.sqrt(st.curSumSq / st.curCount);
      }
      return {
        samplesPerBin: st.binSize,
        min,
        max,
        rms,
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

