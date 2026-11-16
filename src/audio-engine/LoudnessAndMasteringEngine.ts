import { SampleRate } from '../contracts/timebase.contract';

export interface LoudnessMeasurementReport {
  readonly integratedLufs: number;
  readonly maxShortTermLufs: number;
  readonly truePeakDbtp: number;
  readonly headroomDb: number;
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * ITU-R BS.1770-4 / EBU R128 Loudness Measurement, 4x Inter-Sample True Peak Limiter,
 * and Equal-Power Pan Law Engine (Architecture Doc Sections 2.4, 33, 34).
 */
export class LoudnessAndMasteringEngine {
  public static measureLoudnessAndTruePeak(
    channels: Float32Array[],
    sampleRate: SampleRate,
  ): LoudnessMeasurementReport {
    const chCount = channels.length;
    const frameCount = channels[0]?.length ?? 0;
    if (chCount === 0 || frameCount === 0) {
      return {
        integratedLufs: -70.0,
        maxShortTermLufs: -70.0,
        truePeakDbtp: -100.0,
        headroomDb: 100.0,
      };
    }

    const kWeightedChannels = channels.map((ch) =>
      this.applyKWeightingFilter(ch, sampleRate),
    );

    const blockSamples = Math.floor(sampleRate * 0.4);
    const stepSamples = Math.floor(sampleRate * 0.1);
    const blockEnergies: number[] = [];

    if (frameCount < blockSamples) {
      let sum = 0;
      for (let c = 0; c < chCount; c++) {
        const kCh = kWeightedChannels[c];
        let chSq = 0;
        for (let i = 0; i < frameCount; i++) chSq += kCh[i] * kCh[i];
        sum += chSq / frameCount;
      }
      blockEnergies.push(sum);
    } else {
      for (let start = 0; start + blockSamples <= frameCount; start += stepSamples) {
        let blockSum = 0;
        for (let c = 0; c < chCount; c++) {
          const kCh = kWeightedChannels[c];
          let chSquareSum = 0;
          for (let i = start; i < start + blockSamples; i++) {
            const val = kCh[i];
            chSquareSum += val * val;
          }
          blockSum += chSquareSum / blockSamples;
        }
        blockEnergies.push(blockSum);
      }
    }

    // Gate 1: Absolute Threshold (-70 LKFS)
    const absGateThresholdEnergy = Math.pow(10, (-70.0 + 0.691) / 10.0);
    const blocksAboveAbs = blockEnergies.filter((e) => e > absGateThresholdEnergy);

    let integratedLufs = -70.0;
    if (blocksAboveAbs.length > 0) {
      const meanAboveAbs =
        blocksAboveAbs.reduce((acc, v) => acc + v, 0) / blocksAboveAbs.length;
      const relativeThresholdLufs = -0.691 + 10 * Math.log10(meanAboveAbs) - 10.0;
      const relGateThresholdEnergy = Math.pow(10, (relativeThresholdLufs + 0.691) / 10.0);

      // Gate 2: Relative Threshold (-10 LU)
      const gatedBlocks = blocksAboveAbs.filter((e) => e > relGateThresholdEnergy);
      if (gatedBlocks.length > 0) {
        const finalMeanEnergy =
          gatedBlocks.reduce((acc, v) => acc + v, 0) / gatedBlocks.length;
        integratedLufs = -0.691 + 10 * Math.log10(finalMeanEnergy);
      }
    }

    let maxShortTermEnergy = 0;
    const stWindowSteps = 30;
    if (blockEnergies.length < stWindowSteps) {
      maxShortTermEnergy = Math.max(0, ...blockEnergies);
    } else {
      for (let i = 0; i <= blockEnergies.length - stWindowSteps; i++) {
        let sum = 0;
        for (let k = 0; k < stWindowSteps; k++) sum += blockEnergies[i + k];
        const mean = sum / stWindowSteps;
        if (mean > maxShortTermEnergy) maxShortTermEnergy = mean;
      }
    }
    const maxShortTermLufs =
      maxShortTermEnergy > 1e-12 ? -0.691 + 10 * Math.log10(maxShortTermEnergy) : -70.0;

    const truePeakLin = this.compute4xTruePeakLinear(channels);
    const truePeakDbtp = 20 * Math.log10(truePeakLin + 1e-12);

    return {
      integratedLufs: Number(integratedLufs.toFixed(2)),
      maxShortTermLufs: Number(maxShortTermLufs.toFixed(2)),
      truePeakDbtp: Number(truePeakDbtp.toFixed(2)),
      headroomDb: Number((-truePeakDbtp).toFixed(2)),
    };
  }

  /**
   * Normalizes loudness toward target LUFS (default -16.0 LUFS) with 4x True-Peak-safe limiting
   * so post-render inter-sample peaks strictly respect ceilingDbtp (-1.0 dBTP).
   */
  public static normalizeToTargetLufsWithTruePeakLimiter(
    channels: Float32Array[],
    sampleRate: SampleRate,
    targetLufs = -16.0,
    ceilingDbtp = -1.0,
  ): { normalizedChannels: Float32Array[]; appliedGainDb: number } {
    const report = this.measureLoudnessAndTruePeak(channels, sampleRate);
    if (report.integratedLufs <= -68.0) {
      return { normalizedChannels: channels.map((c) => new Float32Array(c)), appliedGainDb: 0 };
    }

    const rawGainDb = Math.min(18.0, Math.max(-24.0, targetLufs - report.integratedLufs));
    const linearMakeup = Math.pow(10, rawGainDb / 20.0);
    const ceilingLin = Math.pow(10, ceilingDbtp / 20.0);

    const frameCount = channels[0].length;
    const chCount = channels.length;
    const outChannels = channels.map((ch) => new Float32Array(ch.length));

    const releaseCoeff = Math.exp(-1.0 / (0.06 * sampleRate));
    let gainReductionEnv = 1.0;

    for (let i = 0; i < frameCount; i++) {
      let maxSampleInFrame = 0;
      for (let c = 0; c < chCount; c++) {
        const amplified = Math.abs(channels[c][i] * linearMakeup);
        if (amplified > maxSampleInFrame) maxSampleInFrame = amplified;
      }

      const requiredAttenuation =
        maxSampleInFrame > ceilingLin ? ceilingLin / maxSampleInFrame : 1.0;

      if (requiredAttenuation < gainReductionEnv) {
        gainReductionEnv = requiredAttenuation;
      } else {
        gainReductionEnv =
          releaseCoeff * gainReductionEnv + (1.0 - releaseCoeff) * requiredAttenuation;
      }

      const totalFrameGain = linearMakeup * gainReductionEnv;
      for (let c = 0; c < chCount; c++) {
        outChannels[c][i] = channels[c][i] * totalFrameGain;
      }
    }

    // Inter-sample true-peak ceiling enforcement guard
    const postPeakLin = this.compute4xTruePeakLinear(outChannels);
    if (postPeakLin > ceilingLin) {
      const trim = (ceilingLin * 0.999) / postPeakLin;
      for (let c = 0; c < chCount; c++) {
        for (let i = 0; i < frameCount; i++) {
          outChannels[c][i] *= trim;
        }
      }
    }

    return {
      normalizedChannels: outChannels,
      appliedGainDb: Number(rawGainDb.toFixed(2)),
    };
  }

  public static applyEqualPowerPan(
    monoInput: Float32Array,
    panPosition: number,
  ): [Float32Array, Float32Array] {
    const clampedPan = Math.max(-1.0, Math.min(1.0, panPosition));
    const angle = ((clampedPan + 1.0) * Math.PI) / 4.0;
    const gainL = Math.cos(angle);
    const gainR = Math.sin(angle);

    const left = new Float32Array(monoInput.length);
    const right = new Float32Array(monoInput.length);
    for (let i = 0; i < monoInput.length; i++) {
      left[i] = monoInput[i] * gainL;
      right[i] = monoInput[i] * gainR;
    }
    return [left, right];
  }

  /**
   * Sample-rate-adaptive ITU-R BS.1770-4 Stage 1 High-Shelf + Stage 2 RLB High-Pass.
   */
  private static applyKWeightingFilter(
    input: Float32Array,
    sampleRate: SampleRate,
  ): Float32Array {
    const stage1Coeffs = this.computeShelfCoeffs(sampleRate);
    const stage2Coeffs = this.computeRlbHighPassCoeffs(sampleRate);
    const stage1 = this.runBiquad(input, stage1Coeffs);
    return this.runBiquad(stage1, stage2Coeffs);
  }

  private static computeShelfCoeffs(fs: SampleRate): BiquadCoeffs {
    if (fs === 48000) {
      return {
        b0: 1.53512485958697,
        b1: -2.69169618940638,
        b2: 1.19839281085285,
        a1: -1.69065929318241,
        a2: 0.73248077421585,
      };
    }
    const f0 = 1681.974450955533;
    const gainDb = 3.999843853973347;
    const q = 0.7071752369554196;
    const k = Math.tan((Math.PI * f0) / fs);
    const vh = Math.pow(10, gainDb / 20);
    const vb = Math.pow(vh, 0.4996667741545416);
    const a0 = 1 + k / q + k * k;
    return {
      b0: (vh + (vb * k) / q + k * k) / a0,
      b1: (2 * (k * k - vh)) / a0,
      b2: (vh - (vb * k) / q + k * k) / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  }

  private static computeRlbHighPassCoeffs(fs: SampleRate): BiquadCoeffs {
    if (fs === 48000) {
      return {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: -1.99004745483398,
        a2: 0.99007225036621,
      };
    }
    const f0 = 38.13547087602444;
    const q = 0.5003270373238773;
    const k = Math.tan((Math.PI * f0) / fs);
    const a0 = 1 + k / q + k * k;
    return {
      b0: 1 / a0,
      b1: -2 / a0,
      b2: 1 / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  }

  private static runBiquad(input: Float32Array, c: BiquadCoeffs): Float32Array {
    const out = new Float32Array(input.length);
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const x0 = input[i];
      const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
    return out;
  }

  /** Evaluates 4x Catmull-Rom sub-sample peaks (t = 0, 0.25, 0.5, 0.75) */
  private static compute4xTruePeakLinear(channels: Float32Array[]): number {
    let maxPeak = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const abs = Math.abs(ch[i]);
        if (abs > maxPeak) maxPeak = abs;
      }
      for (let i = 1; i < ch.length - 2; i++) {
        const y0 = ch[i - 1];
        const y1 = ch[i];
        const y2 = ch[i + 1];
        const y3 = ch[i + 2];

        if (Math.max(Math.abs(y1), Math.abs(y2)) > 0.1) {
          for (const t of [0.25, 0.5, 0.75]) {
            const t2 = t * t;
            const t3 = t2 * t;
            const interp =
              0.5 *
              (2 * y1 +
                (-y0 + y2) * t +
                (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
                (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
            const absInterp = Math.abs(interp);
            if (absInterp > maxPeak) maxPeak = absInterp;
          }
        }
      }
    }
    return maxPeak;
  }
}
