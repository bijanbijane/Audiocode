/**
 * Decision-Directed Spectral Wiener Denoiser Engine (Sections 2.4 & 35 Group B)
 * Learns stationary room noise N(k) from a Room Tone sample and applies 50% Overlap-Add
 * Sqrt-Hann WOLA with Ephraim-Malah decision-directed a-priori SNR smoothing to avoid Musical Noise.
 */
export class SpectralWienerDenoiserEngine {
  private readonly fftSize = 1024;
  private readonly hopSize = 512; // 50% Overlap-Add
  private readonly numBins = 513; // (1024 / 2) + 1
  private readonly synthesisWindow: Float32Array;
  private readonly noisePowerProfile: Float32Array;
  private readonly prevCleanMagSq: Float32Array;

  constructor(roomToneReferencePcm: Float32Array) {
    this.synthesisWindow = this.buildSqrtHannWindow(this.fftSize);
    this.noisePowerProfile = new Float32Array(this.numBins).fill(1e-8);
    this.prevCleanMagSq = new Float32Array(this.numBins).fill(0);
    this.learnNoiseProfileFromRoomTone(roomToneReferencePcm);
  }

  /**
   * Learns per-bin background noise variance from silence / Room Tone frames.
   */
  private learnNoiseProfileFromRoomTone(roomTone: Float32Array): void {
    if (roomTone.length < this.fftSize) return;

    const real = new Float32Array(this.fftSize);
    const imag = new Float32Array(this.fftSize);
    const accumPower = new Float32Array(this.numBins);
    let framesCount = 0;

    for (let start = 0; start + this.fftSize <= roomTone.length; start += this.hopSize) {
      real.fill(0);
      imag.fill(0);
      for (let i = 0; i < this.fftSize; i++) {
        real[i] = roomTone[start + i] * this.synthesisWindow[i];
      }
      this.fftInPlace(real, imag, false);

      for (let k = 0; k < this.numBins; k++) {
        accumPower[k] += real[k] * real[k] + imag[k] * imag[k];
      }
      framesCount++;
    }

    if (framesCount > 0) {
      const scale = 1.4 / framesCount; // Over-subtraction margin to cover stationary variance
      for (let k = 0; k < this.numBins; k++) {
        this.noisePowerProfile[k] = Math.max(1e-10, accumPower[k] * scale);
      }
    }
  }

  /**
   * Denoises a PCM buffer cleanly using Decision-Directed Wiener filtering with 50% WOLA overlap-add.
   */
  public processChunk(
    inputPcm: Float32Array,
    reductionStrength = 0.85,
  ): Float32Array {
    const len = inputPcm.length;
    if (len < this.fftSize || reductionStrength <= 0) {
      return new Float32Array(inputPcm);
    }

    const clampedStrength = Math.max(0, Math.min(1, reductionStrength));
    const outputPcm = new Float32Array(len);
    const real = new Float32Array(this.fftSize);
    const imag = new Float32Array(this.fftSize);

    const spectralFloor = Math.max(0.08, 1.0 - clampedStrength * 0.88);
    const alphaDecisionDirected = 0.92;

    for (let start = 0; start < len; start += this.hopSize) {
      for (let i = 0; i < this.fftSize; i++) {
        const sample = start + i < len ? inputPcm[start + i] : 0;
        real[i] = sample * this.synthesisWindow[i];
        imag[i] = 0;
      }

      this.fftInPlace(real, imag, false);

      for (let k = 0; k < this.numBins; k++) {
        const noisyMagSq = real[k] * real[k] + imag[k] * imag[k];
        const noiseVar = this.noisePowerProfile[k];

        const gamma = noisyMagSq / noiseVar;
        const xi =
          alphaDecisionDirected * (this.prevCleanMagSq[k] / noiseVar) +
          (1.0 - alphaDecisionDirected) * Math.max(0, gamma - 1.0);

        const wienerGain = Math.max(spectralFloor, xi / (xi + 1.0));

        real[k] *= wienerGain;
        imag[k] *= wienerGain;
        this.prevCleanMagSq[k] = noisyMagSq * wienerGain * wienerGain;

        // Preserve Hermitian symmetry for real-valued IFFT output
        if (k > 0 && k < this.numBins - 1) {
          const symIdx = this.fftSize - k;
          real[symIdx] = real[k];
          imag[symIdx] = -imag[k];
        }
      }

      this.fftInPlace(real, imag, true);

      const copyLimit = Math.min(this.fftSize, len - start);
      for (let i = 0; i < copyLimit; i++) {
        outputPcm[start + i] += real[i] * this.synthesisWindow[i];
      }
    }

    return outputPcm;
  }

  /** Sqrt-Hann synthesis/analysis window satisfying WOLA sum(w^2) = 1.0 at 50% overlap */
  private buildSqrtHannWindow(size: number): Float32Array {
    const win = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      win[i] = Math.sin((Math.PI * (i + 0.5)) / size);
    }
    return win;
  }

  private fftInPlace(real: Float32Array, imag: Float32Array, inverse: boolean): void {
    const n = real.length;
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < j) {
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
      }
      let k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    const dir = inverse ? 2.0 : -2.0;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const angle = (dir * Math.PI) / size;
      const wStepR = Math.cos(angle);
      const wStepI = Math.sin(angle);

      for (let i = 0; i < n; i += size) {
        let wr = 1.0;
        let wi = 0.0;
        for (let k = 0; k < half; k++) {
          const eIdx = i + k;
          const oIdx = i + k + half;
          const tr = wr * real[oIdx] - wi * imag[oIdx];
          const ti = wr * imag[oIdx] + wi * real[oIdx];

          real[oIdx] = real[eIdx] - tr;
          imag[oIdx] = imag[eIdx] - ti;
          real[eIdx] += tr;
          imag[eIdx] += ti;

          const nextWr = wr * wStepR - wi * wStepI;
          wi = wr * wStepI + wi * wStepR;
          wr = nextWr;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imag[i] /= n;
      }
    }
  }
}
