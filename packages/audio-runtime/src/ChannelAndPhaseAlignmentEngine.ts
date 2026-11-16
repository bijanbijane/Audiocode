import { SampleRate } from '../../../src/contracts/timebase.contract';

export type MonoCollapseRiskLevel =
  | 'NONE'
  | 'MODERATE_COMB_FILTER'
  | 'SEVERE_PHASE_CANCELLATION';

export type ChannelRoutingMode =
  | 'STEREO_PASS_THROUGH'
  | 'MONO_SUM_PHASE_SAFE'
  | 'LEFT_CHANNEL_TO_MONO'
  | 'RIGHT_CHANNEL_TO_MONO'
  | 'SWAP_LEFT_RIGHT'
  | 'INVERT_RIGHT_POLARITY';

export interface StereoPhaseDiagnostic {
  /** Zero-lag Pearson correlation in [-1.0, +1.0]. Negative indicates out-of-phase cancellation. */
  readonly zeroLagPhaseCorrelation: number;
  /** Peak absolute cross-correlation after compensating delay/polarity. */
  readonly peakAlignedCorrelation: number;
  /** Shift (in samples, fractional) applied to Right channel to align with Left (+ means Right lags Left). */
  readonly estimatedRightLagSamples: number;
  readonly estimatedDelayMs: number;
  readonly isPolarityInverted: boolean;
  readonly monoFoldDownLossDb: number;
  readonly channelBalanceDb: number;
  readonly monoCollapseRisk: MonoCollapseRiskLevel;
}

export interface PhaseAlignmentDiagnosticReport {
  /** Phase correlation in [-1.0, +1.0]; negative values indicate phase cancellation in mono playback */
  readonly phaseCorrelation: number;
  /** Delay lag in samples between Left/MicA and Right/MicB */
  readonly optimalDelayLagSamples: number;
  readonly optimalDelayMs: number;
  /** True when one channel has 180-degree inverted polarity */
  readonly isPolarityInverted: boolean;
  readonly monoCompatibilityLossDb: number;
  readonly recommendationFa: string;
}

export interface AlignedStereoResult {
  readonly leftChannel: Float32Array;
  readonly rightChannel: Float32Array;
  readonly diagnosticBefore: StereoPhaseDiagnostic;
  readonly correlationAfterAlignment: number;
  readonly appliedPolarityFlip: boolean;
  readonly appliedShiftSamples: number;
}

/**
 * Channel Management & Sub-Millisecond Phase Alignment Engine (Sections 2.4 & 33)
 * Detects stereo polarity inversion (180 deg), inter-microphone comb-filtering delay
 * via Cross-Correlation + parabolic sub-sample interpolation, and restores coherent phase
 * so mono mobile/headset fold-down does not sound hollow.
 */
export class ChannelAndPhaseAlignmentEngine {
  public static analyzeStereoPhaseAndDelay(
    leftChannel: Float32Array,
    rightChannel: Float32Array,
    sampleRate: SampleRate,
    maxSearchLagMs = 20,
  ): StereoPhaseDiagnostic {
    const len = Math.min(leftChannel.length, rightChannel.length);
    if (len === 0) {
      return {
        zeroLagPhaseCorrelation: 1,
        peakAlignedCorrelation: 1,
        estimatedRightLagSamples: 0,
        estimatedDelayMs: 0,
        isPolarityInverted: false,
        monoFoldDownLossDb: 0,
        channelBalanceDb: 0,
        monoCollapseRisk: 'NONE',
      };
    }

    let sumL2 = 0;
    let sumR2 = 0;
    let sumLR = 0;
    let sumMono2 = 0;

    for (let i = 0; i < len; i++) {
      const l = leftChannel[i];
      const r = rightChannel[i];
      sumL2 += l * l;
      sumR2 += r * r;
      sumLR += l * r;
      const mono = 0.5 * (l + r);
      sumMono2 += mono * mono;
    }

    const zeroLagPhaseCorrelation =
      sumL2 > 1e-12 && sumR2 > 1e-12 ? sumLR / Math.sqrt(sumL2 * sumR2) : 0;

    const rmsL = Math.sqrt(sumL2 / len);
    const rmsR = Math.sqrt(sumR2 / len);
    const rmsAvg = 0.5 * (rmsL + rmsR);
    const rmsMono = Math.sqrt(sumMono2 / len);

    const channelBalanceDb = 20 * Math.log10((rmsL + 1e-9) / (rmsR + 1e-9));
    const monoFoldDownLossDb = 20 * Math.log10((rmsMono + 1e-9) / (rmsAvg + 1e-9));

    const maxLag = Math.min(Math.floor(len / 3), Math.max(1, Math.floor((sampleRate * maxSearchLagMs) / 1000)));
    const lagCorrs = new Float64Array(2 * maxLag + 1);

    let bestAbsIdx = maxLag;
    let bestWeightedScore = -1;

    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const start = Math.max(0, -lag);
      const end = Math.min(len, len - lag);
      let sL2 = 0;
      let sR2 = 0;
      let sDot = 0;

      for (let i = start; i < end; i++) {
        const l = leftChannel[i];
        const r = rightChannel[i + lag];
        sL2 += l * l;
        sR2 += r * r;
        sDot += l * r;
      }

      const corr = sL2 > 1e-12 && sR2 > 1e-12 ? sDot / Math.sqrt(sL2 * sR2) : 0;
      const idx = lag + maxLag;
      lagCorrs[idx] = corr;

      // Slight preference for smaller |lag| breaks ties on periodic signals (e.g. R = -L stays at lag=0)
      const weightedScore = Math.abs(corr) - 0.005 * (Math.abs(lag) / maxLag);
      if (weightedScore > bestWeightedScore) {
        bestWeightedScore = weightedScore;
        bestAbsIdx = idx;
      }
    }
    const bestAbsCorr = Math.abs(lagCorrs[bestAbsIdx]);

    // Parabolic sub-sample refinement around peak |correlation|
    let refinedLag = bestAbsIdx - maxLag;
    if (bestAbsIdx > 0 && bestAbsIdx < lagCorrs.length - 1) {
      const y1 = Math.abs(lagCorrs[bestAbsIdx - 1]);
      const y2 = Math.abs(lagCorrs[bestAbsIdx]);
      const y3 = Math.abs(lagCorrs[bestAbsIdx + 1]);
      const denom = y1 - 2 * y2 + y3;
      if (Math.abs(denom) > 1e-9) {
        const delta = 0.5 * (y1 - y3) / denom;
        refinedLag += Math.max(-0.5, Math.min(0.5, delta));
      }
    }

    const peakSignedCorr = lagCorrs[bestAbsIdx];
    const isPolarityInverted = peakSignedCorr < -0.55;
    const estimatedDelayMs = (refinedLag / sampleRate) * 1000;

    let monoCollapseRisk: MonoCollapseRiskLevel = 'NONE';
    if (zeroLagPhaseCorrelation < -0.35 || monoFoldDownLossDb <= -6.0) {
      monoCollapseRisk = 'SEVERE_PHASE_CANCELLATION';
    } else if (
      zeroLagPhaseCorrelation < 0.45 ||
      (bestAbsCorr > 0.65 && Math.abs(estimatedDelayMs) > 0.25)
    ) {
      monoCollapseRisk = 'MODERATE_COMB_FILTER';
    }

    return {
      zeroLagPhaseCorrelation: Number(zeroLagPhaseCorrelation.toFixed(4)),
      peakAlignedCorrelation: Number(Math.abs(peakSignedCorr).toFixed(4)),
      estimatedRightLagSamples: Number(refinedLag.toFixed(3)),
      estimatedDelayMs: Number(estimatedDelayMs.toFixed(3)),
      isPolarityInverted,
      monoFoldDownLossDb: Number(monoFoldDownLossDb.toFixed(2)),
      channelBalanceDb: Number(channelBalanceDb.toFixed(2)),
      monoCollapseRisk,
    };
  }

  /**
   * Analyzes stereo phase correlation, sub-millisecond inter-mic delay (+/-3ms search radius),
   * and mono playback energy collapse risk (Sections 2.4 & 33).
   */
  public static analyzePhaseAndChannelCompatibility(
    leftOrMicA: Float32Array,
    rightOrMicB: Float32Array,
    sampleRate: SampleRate,
  ): PhaseAlignmentDiagnosticReport {
    const len = Math.min(leftOrMicA.length, rightOrMicB.length);
    if (len === 0) {
      return {
        phaseCorrelation: 1.0,
        optimalDelayLagSamples: 0,
        optimalDelayMs: 0,
        isPolarityInverted: false,
        monoCompatibilityLossDb: 0,
        recommendationFa: 'سیگنال خالی است.',
      };
    }

    let dotZero = 0;
    let sumSqL = 0;
    let sumSqR = 0;
    let sumSqMono = 0;

    for (let i = 0; i < len; i++) {
      const l = leftOrMicA[i];
      const r = rightOrMicB[i];
      dotZero += l * r;
      sumSqL += l * l;
      sumSqR += r * r;
      const mono = 0.5 * (l + r);
      sumSqMono += mono * mono;
    }

    const denom = Math.sqrt(sumSqL * sumSqR) + 1e-12;
    const phaseCorrelation = dotZero / denom;

    const avgStereoPower = (0.5 * (sumSqL + sumSqR)) / len;
    const monoPower = sumSqMono / len;
    const monoCompatibilityLossDb =
      10 * Math.log10((avgStereoPower + 1e-12) / (monoPower + 1e-12));

    const maxLagSamples = Math.max(
      1,
      Math.min(Math.floor(len / 3), Math.floor((sampleRate * 3.0) / 1000)),
    );
    let bestLag = 0;
    let bestWeightedScore = Math.abs(phaseCorrelation);
    let signedCorrAtBestLag = phaseCorrelation;

    const searchLen = Math.min(len - maxLagSamples * 2, sampleRate * 4);
    const startOffset = Math.max(maxLagSamples, Math.floor((len - searchLen) / 2));

    if (searchLen > 1024) {
      for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
        let dot = 0;
        let magA = 0;
        let magB = 0;
        for (let i = 0; i < searchLen; i += 2) {
          const a = leftOrMicA[startOffset + i];
          const b = rightOrMicB[startOffset + i + lag];
          dot += a * b;
          magA += a * a;
          magB += b * b;
        }
        const corr = dot / (Math.sqrt(magA * magB) + 1e-12);
        // Tie-breaker favoring minimum lag prevents periodic signals (e.g. R = -L) from drifting to half-period lag
        const weightedScore = Math.abs(corr) - 0.005 * (Math.abs(lag) / maxLagSamples);
        if (weightedScore > bestWeightedScore) {
          bestWeightedScore = weightedScore;
          bestLag = lag;
          signedCorrAtBestLag = corr;
        }
      }
    }

    const isPolarityInverted = signedCorrAtBestLag < -0.35;
    const optimalDelayMs = (bestLag / sampleRate) * 1000;

    let recommendationFa = 'وضعیت فاز کانال‌ها استاندارد و سازگار با پخش مونو است.';
    if (isPolarityInverted) {
      recommendationFa =
        'هشدار بحرانی: قطبیت یکی از کانال‌ها معکوس است (180° Out-of-Phase) و صدا در اسپیکر موبایل حذف می‌شود. معکوس‌سازی قطبیت و هم‌فازسازی پیشنهاد می‌شود.';
    } else if (Math.abs(bestLag) >= 2 && monoCompatibilityLossDb > 2.0) {
      recommendationFa = `اختلاف فاز زمانی به میزان ${bestLag} نمونه (${optimalDelayMs.toFixed(2)}ms) بین دو میکروفون شناسایی شد؛ اعمال هم‌فازسازی خودکار (Phase Alignment) پیشنهاد می‌شود.`;
    }

    return {
      phaseCorrelation: Number(phaseCorrelation.toFixed(3)),
      optimalDelayLagSamples: bestLag,
      optimalDelayMs: Number(optimalDelayMs.toFixed(3)),
      isPolarityInverted,
      monoCompatibilityLossDb: Number(Math.max(0, monoCompatibilityLossDb).toFixed(2)),
      recommendationFa,
    };
  }

  /**
   * Applies integer-sample lag alignment and optional polarity inversion to targetChannel.
   */
  public static alignPhaseAndPolarity(
    _referenceChannel: Float32Array,
    targetChannel: Float32Array,
    lagSamplesToCorrect: number,
    invertPolarity: boolean,
  ): Float32Array {
    const len = targetChannel.length;
    const aligned = new Float32Array(len);
    const polaritySign = invertPolarity ? -1.0 : 1.0;

    for (let i = 0; i < len; i++) {
      const srcIdx = i + lagSamplesToCorrect;
      if (srcIdx >= 0 && srcIdx < len) {
        aligned[i] = targetChannel[srcIdx] * polaritySign;
      } else {
        aligned[i] = 0.0;
      }
    }
    return aligned;
  }

  /**
   * Executes channel routing modes (Section 2.4 Channel Management).
   */
  public static applyChannelRouting(
    left: Float32Array,
    right: Float32Array,
    mode: ChannelRoutingMode,
  ): [Float32Array, Float32Array] {
    const len = Math.min(left.length, right.length);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);

    switch (mode) {
      case 'STEREO_PASS_THROUGH':
        outL.set(left.subarray(0, len));
        outR.set(right.subarray(0, len));
        break;

      case 'LEFT_CHANNEL_TO_MONO':
        outL.set(left.subarray(0, len));
        outR.set(left.subarray(0, len));
        break;

      case 'RIGHT_CHANNEL_TO_MONO':
        outL.set(right.subarray(0, len));
        outR.set(right.subarray(0, len));
        break;

      case 'SWAP_LEFT_RIGHT':
        outL.set(right.subarray(0, len));
        outR.set(left.subarray(0, len));
        break;

      case 'INVERT_RIGHT_POLARITY':
        outL.set(left.subarray(0, len));
        for (let i = 0; i < len; i++) outR[i] = -right[i];
        break;

      case 'MONO_SUM_PHASE_SAFE':
        // -3dB (sqrt(1/2)) summing preserves constant acoustic power in mono fold-down
        for (let i = 0; i < len; i++) {
          const sum = (left[i] + right[i]) * Math.SQRT1_2;
          outL[i] = sum;
          outR[i] = sum;
        }
        break;
    }

    return [outL, outR];
  }

  /**
   * Aligns Right channel to Left using polarity correction and fractional linear interpolation.
   */
  public static alignAndFixStereoChannels(
    leftChannel: Float32Array,
    rightChannel: Float32Array,
    sampleRate: SampleRate,
    maxSearchLagMs = 20,
  ): AlignedStereoResult {
    const diagnosticBefore = this.analyzeStereoPhaseAndDelay(
      leftChannel,
      rightChannel,
      sampleRate,
      maxSearchLagMs,
    );

    const len = Math.min(leftChannel.length, rightChannel.length);
    const outLeft = leftChannel.slice(0, len);
    const outRight = new Float32Array(len);

    const sign = diagnosticBefore.isPolarityInverted ? -1.0 : 1.0;
    const lag = diagnosticBefore.estimatedRightLagSamples;

    for (let i = 0; i < len; i++) {
      const srcPos = i + lag;
      const idx0 = Math.floor(srcPos);
      const frac = srcPos - idx0;
      const s0 = idx0 >= 0 && idx0 < len ? rightChannel[idx0] : 0;
      const s1 = idx0 + 1 >= 0 && idx0 + 1 < len ? rightChannel[idx0 + 1] : 0;
      outRight[i] = sign * (s0 + frac * (s1 - s0));
    }

    const correlationAfterAlignment = this.computeZeroLagCorrelation(outLeft, outRight);

    return {
      leftChannel: outLeft,
      rightChannel: outRight,
      diagnosticBefore,
      correlationAfterAlignment: Number(correlationAfterAlignment.toFixed(4)),
      appliedPolarityFlip: diagnosticBefore.isPolarityInverted,
      appliedShiftSamples: diagnosticBefore.estimatedRightLagSamples,
    };
  }

  public static computeZeroLagCorrelation(left: Float32Array, right: Float32Array): number {
    const len = Math.min(left.length, right.length);
    let sL2 = 0;
    let sR2 = 0;
    let sDot = 0;
    for (let i = 0; i < len; i++) {
      sL2 += left[i] * left[i];
      sR2 += right[i] * right[i];
      sDot += left[i] * right[i];
    }
    return sL2 > 1e-12 && sR2 > 1e-12 ? sDot / Math.sqrt(sL2 * sR2) : 0;
  }
}
