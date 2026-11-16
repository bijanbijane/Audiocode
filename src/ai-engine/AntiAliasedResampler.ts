import { SampleRate } from '../contracts/timebase.contract';

/**
 * Blackman-Sinc FIR Anti-Aliased Resampler (PoC #3)
 * Eliminates >8kHz aliasing artifacts on Persian sibilants (س، ش، ز، ف) when feeding 16kHz ASR/VAD models.
 */
export class AntiAliasedResampler {
  private readonly filterKernel: Float32Array;
  private readonly filterHalfWing: number;
  private readonly ratio: number;

  constructor(
    private readonly sourceRate: SampleRate,
    private readonly targetRate: SampleRate = 16000,
    taps = 63,
  ) {
    this.ratio = sourceRate / targetRate;
    this.filterHalfWing = Math.floor(taps / 2);
    this.filterKernel = this.buildBlackmanSincKernel(taps, targetRate / sourceRate);
  }

  private buildBlackmanSincKernel(taps: number, cutoffRatio: number): Float32Array {
    const kernel = new Float32Array(taps);
    const mid = Math.floor(taps / 2);
    const fc = 0.475 * cutoffRatio;
    let sum = 0;

    for (let i = 0; i < taps; i++) {
      const n = i - mid;
      const sinc = n === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * n) / n;
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      kernel[i] = sinc * window;
      sum += kernel[i];
    }

    for (let i = 0; i < taps; i++) {
      kernel[i] /= sum;
    }
    return kernel;
  }

  public processToMono16k(channels: Float32Array[]): Float32Array {
    if (channels.length === 0 || channels[0].length === 0) {
      return new Float32Array(0);
    }
    const inputFrames = channels[0].length;
    const chCount = channels.length;
    const monoSource = new Float32Array(inputFrames);

    const invCh = 1.0 / chCount;
    for (let i = 0; i < inputFrames; i++) {
      let sum = 0;
      for (let c = 0; c < chCount; c++) sum += channels[c][i];
      monoSource[i] = sum * invCh;
    }

    if (this.sourceRate === this.targetRate) return monoSource;

    const outputFrames = Math.floor(inputFrames / this.ratio);
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
