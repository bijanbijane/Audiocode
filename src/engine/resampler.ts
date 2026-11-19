/**
 * Anti-Aliased Windowed-Sinc Resampler (44.1kHz / 48kHz -> 16,000 Hz Mono)
 * Prevents high-frequency sibilant aliasing (س، ش، ز، ف) when feeding Persian ASR/VAD models.
 */

export interface ResampleResult {
  samples: Float32Array;
  outputSampleRate: number;
  cutoffHz: number;
  filterTaps: number;
  aliasingAttenuationDb: number;
}

/** Modified Bessel function I0 for Kaiser window */
function besselI0(x: number): number {
  let sum = 1.0;
  let term = 1.0;
  const xHalf = x * 0.5;
  for (let k = 1; k <= 20; k++) {
    term *= (xHalf / k) * (xHalf / k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Downsamples mono or interleaved/planar multi-channel audio to 16kHz mono
 * using a Kaiser-windowed sinc low-pass filter at 0.9 * (targetRate / 2) = 7,200 Hz.
 */
export function resampleTo16kMono(
  channels: Float32Array[],
  inputSampleRate: number,
  targetSampleRate = 16_000,
): ResampleResult {
  if (
    channels.length === 0 ||
    !Number.isFinite(inputSampleRate) ||
    inputSampleRate <= 0 ||
    !Number.isFinite(targetSampleRate) ||
    targetSampleRate <= 0
  ) {
    return {
      samples: new Float32Array(0),
      outputSampleRate: Number.isFinite(targetSampleRate) && targetSampleRate > 0 ? targetSampleRate : 16_000,
      cutoffHz: (Number.isFinite(targetSampleRate) && targetSampleRate > 0 ? targetSampleRate : 16_000) * 0.45,
      filterTaps: 0,
      aliasingAttenuationDb: 0,
    };
  }

  let inputLength = channels[0].length;
  for (let c = 1; c < channels.length; c++) {
    if (channels[c].length < inputLength) {
      inputLength = channels[c].length;
    }
  }
  if (inputLength === 0) {
    return {
      samples: new Float32Array(0),
      outputSampleRate: targetSampleRate,
      cutoffHz: targetSampleRate * 0.45,
      filterTaps: 0,
      aliasingAttenuationDb: 0,
    };
  }

  // Mix down to mono first without overflow or NaN propagation
  const mono = new Float32Array(inputLength);
  const invCh = 1 / channels.length;
  for (let i = 0; i < inputLength; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      const sample = channels[c][i];
      if (Number.isFinite(sample)) {
        sum += sample;
      }
    }
    mono[i] = sum * invCh;
  }

  if (inputSampleRate === targetSampleRate) {
    return {
      samples: mono,
      outputSampleRate: targetSampleRate,
      cutoffHz: targetSampleRate * 0.5,
      filterTaps: 1,
      aliasingAttenuationDb: 96,
    };
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.floor(inputLength / ratio);
  const output = new Float32Array(outputLength);

  // Cutoff at 0.9 * Nyquist of target rate (7200 Hz for 16kHz)
  const cutoffHz = targetSampleRate * 0.45;
  const fc = cutoffHz / inputSampleRate; // normalized to input sample rate
  const halfWidth = Math.max(12, Math.round(16 * (inputSampleRate / targetSampleRate)));
  const filterTaps = halfWidth * 2 + 1;
  const beta = 6.5; // Kaiser beta (~65+ dB stopband attenuation)
  const invI0Beta = 1 / besselI0(beta);

  for (let outIdx = 0; outIdx < outputLength; outIdx++) {
    const center = outIdx * ratio;
    const centerInt = Math.floor(center);
    const startTap = Math.max(0, centerInt - halfWidth);
    const endTap = Math.min(inputLength - 1, centerInt + halfWidth);

    let acc = 0;
    let weightSum = 0;

    for (let inIdx = startTap; inIdx <= endTap; inIdx++) {
      const x = inIdx - center;
      const norm = x / halfWidth;
      const windowArg = Math.max(0, 1 - norm * norm);
      const win = besselI0(beta * Math.sqrt(windowArg)) * invI0Beta;
      const sincArg = 2 * fc * x;
      const sinc =
        Math.abs(sincArg) < 1e-8
          ? 2 * fc
          : Math.sin(Math.PI * sincArg) / (Math.PI * x);
      const w = sinc * win;
      acc += mono[inIdx] * w;
      weightSum += w;
    }

    output[outIdx] = weightSum > 1e-9 ? acc / weightSum : 0;
  }

  return {
    samples: output,
    outputSampleRate: targetSampleRate,
    cutoffHz,
    filterTaps,
    aliasingAttenuationDb: 68,
  };
}

/** Measures RMS energy of a Float32Array */
export function computeSignalRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Stateful chunk-by-chunk Kaiser-windowed sinc resampler.
 * Keeps only a tiny O(filterTaps) boundary history in memory across chunks
 * so multi-hour audio can be downsampled to 16 kHz Mono without allocating
 * a full-file intermediate or output buffer.
 */
export class StreamingKaiserSincResampler {
  public readonly inputSampleRate: number;
  public readonly targetSampleRate: number;
  public readonly cutoffHz: number;
  public readonly filterTaps: number;
  public readonly aliasingAttenuationDb: number;

  private readonly ratio: number;
  private readonly fc: number;
  private readonly halfWidth: number;
  private readonly beta = 6.5;
  private readonly invI0Beta: number;

  private ringTail = new Float32Array(0);
  private windowStartGlobalIdx = 0;
  private totalInputSamples = 0;
  private nextOutIdx = 0;
  private flushed = false;

  constructor(inputSampleRate: number, targetSampleRate = 16_000) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
      throw new RangeError(`Invalid inputSampleRate: ${inputSampleRate}`);
    }
    if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
      throw new RangeError(`Invalid targetSampleRate: ${targetSampleRate}`);
    }
    this.inputSampleRate = inputSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.ratio = inputSampleRate / targetSampleRate;
    this.cutoffHz = targetSampleRate * 0.45;
    this.fc = this.cutoffHz / inputSampleRate;

    if (inputSampleRate === targetSampleRate) {
      this.halfWidth = 0;
      this.filterTaps = 1;
      this.aliasingAttenuationDb = 96;
      this.invI0Beta = 1;
    } else {
      this.halfWidth = Math.max(12, Math.round(16 * this.ratio));
      this.filterTaps = this.halfWidth * 2 + 1;
      this.aliasingAttenuationDb = 68;
      this.invI0Beta = 1 / besselI0(this.beta);
    }
  }

  public pushChunk(monoChunk: Float32Array): Float32Array {
    if (this.flushed) {
      throw new Error('StreamingKaiserSincResampler cannot accept chunks after flush()');
    }
    if (monoChunk.length === 0) return new Float32Array(0);

    if (this.inputSampleRate === this.targetSampleRate) {
      this.totalInputSamples += monoChunk.length;
      this.nextOutIdx += monoChunk.length;
      return new Float32Array(monoChunk);
    }

    const combined = new Float32Array(this.ringTail.length + monoChunk.length);
    combined.set(this.ringTail, 0);
    combined.set(monoChunk, this.ringTail.length);
    const combinedEndGlobal = this.windowStartGlobalIdx + combined.length;
    this.totalInputSamples = combinedEndGlobal;

    // Only emit outputs whose full [centerInt - halfWidth .. centerInt + halfWidth] support is available
    const maxSafeCenter = combinedEndGlobal - 1 - this.halfWidth;
    const outSamples: number[] = [];

    while (true) {
      const center = this.nextOutIdx * this.ratio;
      const centerInt = Math.floor(center);
      if (centerInt + this.halfWidth > combinedEndGlobal - 1 || centerInt > maxSafeCenter) {
        break;
      }
      outSamples.push(this.evalTap(combined, this.windowStartGlobalIdx, center, centerInt));
      this.nextOutIdx++;
    }

    // Retain at most the last (2 * halfWidth + ceil(ratio) + 2) samples needed for next boundary
    const keepLen = Math.min(combined.length, this.halfWidth * 2 + Math.ceil(this.ratio) + 4);
    const trimCount = combined.length - keepLen;
    if (trimCount > 0) {
      this.ringTail = combined.slice(trimCount);
      this.windowStartGlobalIdx += trimCount;
    } else {
      this.ringTail = combined;
    }

    return Float32Array.from(outSamples);
  }

  public flush(): Float32Array {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;

    if (this.inputSampleRate === this.targetSampleRate) {
      return new Float32Array(0);
    }

    const targetTotalOut = Math.floor(this.totalInputSamples / this.ratio);
    const remaining = Math.max(0, targetTotalOut - this.nextOutIdx);
    const out = new Float32Array(remaining);

    for (let i = 0; i < remaining; i++) {
      const center = (this.nextOutIdx + i) * this.ratio;
      const centerInt = Math.floor(center);
      out[i] = this.evalTap(this.ringTail, this.windowStartGlobalIdx, center, centerInt);
    }

    this.nextOutIdx = targetTotalOut;
    this.ringTail = new Float32Array(0);
    return out;
  }

  public getStats() {
    return {
      inputSampleRate: this.inputSampleRate,
      outputSampleRate: this.targetSampleRate,
      cutoffHz: this.cutoffHz,
      filterTaps: this.filterTaps,
      aliasingAttenuationDb: this.aliasingAttenuationDb,
      totalInputSamples: this.totalInputSamples,
      totalOutputSamples: this.nextOutIdx,
    };
  }

  private evalTap(
    buf: Float32Array,
    bufStartGlobal: number,
    center: number,
    centerInt: number,
  ): number {
    const startTap = Math.max(bufStartGlobal, centerInt - this.halfWidth);
    const endTap = Math.min(bufStartGlobal + buf.length - 1, centerInt + this.halfWidth);
    let acc = 0;
    let weightSum = 0;

    for (let inIdx = startTap; inIdx <= endTap; inIdx++) {
      const x = inIdx - center;
      const norm = x / this.halfWidth;
      const windowArg = Math.max(0, 1 - norm * norm);
      const win = besselI0(this.beta * Math.sqrt(windowArg)) * this.invI0Beta;
      const sincArg = 2 * this.fc * x;
      const sinc =
        Math.abs(sincArg) < 1e-8 ? 2 * this.fc : Math.sin(Math.PI * sincArg) / (Math.PI * x);
      const w = sinc * win;
      acc += buf[inIdx - bufStartGlobal] * w;
      weightSum += w;
    }

    return weightSum > 1e-9 ? acc / weightSum : 0;
  }
}

export async function resampleChunkedTo16kStream(params: {
  inputSampleRate: number;
  targetSampleRate?: number;
  totalInputSamples: number;
  chunkSizeSamples: number;
  readInputChunkFn: (startSample: number, count: number) => Promise<Float32Array>;
  onOutputChunk: (chunk16k: Float32Array, offset16k: number) => Promise<void> | void;
  abortSignal?: AbortSignal;
  onProgress?: (pct: number) => void;
}): Promise<{
  totalOutputSamples: number;
  cutoffHz: number;
  filterTaps: number;
  aliasingAttenuationDb: number;
}> {
  const resampler = new StreamingKaiserSincResampler(
    params.inputSampleRate,
    params.targetSampleRate ?? 16_000,
  );
  const totalInput = Math.max(0, Math.floor(params.totalInputSamples));
  const safeChunkSize =
    Number.isFinite(params.chunkSizeSamples) && params.chunkSizeSamples >= 1
      ? Math.floor(params.chunkSizeSamples)
      : 4096;
  let cursor = 0;
  let outputOffset = 0;

  while (cursor < totalInput) {
    if (params.abortSignal?.aborted) {
      throw new Error('RESAMPLE_ABORTED');
    }
    const count = Math.min(safeChunkSize, totalInput - cursor);
    const inChunk = await params.readInputChunkFn(cursor, count);
    const outChunk = resampler.pushChunk(inChunk);
    if (outChunk.length > 0) {
      await params.onOutputChunk(outChunk, outputOffset);
      outputOffset += outChunk.length;
    }
    cursor += count;
    params.onProgress?.(Math.min(99, Math.round((cursor / totalInput) * 100)));
  }

  const tail = resampler.flush();
  if (tail.length > 0) {
    await params.onOutputChunk(tail, outputOffset);
    outputOffset += tail.length;
  }
  params.onProgress?.(100);

  const stats = resampler.getStats();
  return {
    totalOutputSamples: outputOffset,
    cutoffHz: stats.cutoffHz,
    filterTaps: stats.filterTaps,
    aliasingAttenuationDb: stats.aliasingAttenuationDb,
  };
}

