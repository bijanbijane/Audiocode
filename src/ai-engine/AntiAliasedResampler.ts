import { SampleRate } from '../contracts/timebase.contract';

/**
 * Blackman-Sinc FIR Anti-Aliased Resampler (PoC #3)
 * Eliminates >8kHz aliasing artifacts on Persian sibilants (س، ش، ز، ف) when feeding 16kHz ASR/VAD models.
 */
export class AntiAliasedResampler {
  private readonly filterKernel: Float32Array;
  private readonly filterHalfWing: number;
  private readonly ratio: number;

  private readonly safeSourceRate: number;
  private readonly safeTargetRate: number;

  constructor(
    private readonly sourceRate: SampleRate,
    private readonly targetRate: SampleRate = 16000,
    taps = 63,
  ) {
    this.safeSourceRate =
      Number.isFinite(sourceRate) && sourceRate > 0 ? sourceRate : 48000;
    this.safeTargetRate =
      Number.isFinite(targetRate) && targetRate > 0 ? targetRate : 16000;
    const safeTaps =
      Number.isFinite(taps) && taps >= 3 ? Math.floor(taps) | 1 : 63;
    this.ratio = this.safeSourceRate / this.safeTargetRate;
    this.filterHalfWing = Math.floor(safeTaps / 2);
    this.filterKernel = this.buildBlackmanSincKernel(
      safeTaps,
      Math.min(1.0, this.safeTargetRate / this.safeSourceRate),
    );
  }

  private buildBlackmanSincKernel(taps: number, cutoffRatio: number): Float32Array {
    const kernel = new Float32Array(taps);
    const mid = Math.floor(taps / 2);
    const fc = 0.475 * cutoffRatio;
    const denom = Math.max(1, taps - 1);
    let sum = 0;

    for (let i = 0; i < taps; i++) {
      const n = i - mid;
      const sinc = n === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * n) / n;
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / denom) +
        0.08 * Math.cos((4 * Math.PI * i) / denom);
      kernel[i] = sinc * window;
      sum += kernel[i];
    }

    const norm = Math.abs(sum) > 1e-12 ? sum : 1;
    for (let i = 0; i < taps; i++) {
      kernel[i] /= norm;
    }
    return kernel;
  }

  public processToMono16k(channels: Float32Array[]): Float32Array {
    if (channels.length === 0) {
      return new Float32Array(0);
    }
    let inputFrames = channels[0].length;
    for (let c = 1; c < channels.length; c++) {
      if (channels[c].length < inputFrames) {
        inputFrames = channels[c].length;
      }
    }
    if (inputFrames <= 0) {
      return new Float32Array(0);
    }

    const chCount = channels.length;
    const monoSource = new Float32Array(inputFrames);

    const invCh = 1.0 / chCount;
    for (let i = 0; i < inputFrames; i++) {
      let sum = 0;
      for (let c = 0; c < chCount; c++) {
        const s = channels[c][i];
        if (Number.isFinite(s)) sum += s;
      }
      monoSource[i] = sum * invCh;
    }

    if (this.safeSourceRate === this.safeTargetRate) return monoSource;

    const outputFrames = Math.max(0, Math.floor(inputFrames / this.ratio));
    const output = new Float32Array(outputFrames);
    const kernel = this.filterKernel;
    const half = this.filterHalfWing;

    for (let outIdx = 0; outIdx < outputFrames; outIdx++) {
      const centerIn = Math.floor(outIdx * this.ratio);
      let acc = 0;
      for (let k = -half; k <= half; k++) {
        const sampleIdx = centerIn + k;
        if (sampleIdx >= 0 && sampleIdx < inputFrames) {
          acc += monoSource[sampleIdx] * kernel[k + half];
        }
      }
      output[outIdx] = acc;
    }

    return output;
  }
}
