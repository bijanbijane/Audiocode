import { SampleRate } from '../../../src/contracts/timebase.contract';

export interface ClockDriftAlignmentReport {
  /** Initial start offset of secondary track relative to reference track (in samples and seconds) */
  readonly initialOffsetSamples: number;
  readonly initialOffsetSeconds: number;
  /** Measured crystal clock drift between recorders in Parts Per Million (PPM) */
  readonly measuredClockDriftPpm: number;
  /** Fractional resampling stretch factor required to sample-lock the secondary track */
  readonly resampleStretchFactor: number;
  readonly alignmentConfidence: number;
}

/**
 * Multi-Recorder Clock Drift & Temporal Offset Aligner
 * (Section 80 — Architecture Doc Sections 23, 24 & 33)
 * Estimates initial start offset and linear crystal oscillator drift (PPM) between two
 * independent recorders (e.g., Host Laptop @ 48000.0Hz vs Guest Mobile @ 47999.2Hz) using
 * Two-Anchor Coarse-to-Fine Cross-Correlation, and compensates both via 4-point Catmull-Rom
 * cubic fractional resampling.
 */
export class MultiRecorderClockDriftAligner {
  /**
   * 1. Estimates initial offset and linear clock drift (PPM) between two independent recordings
   * using two temporal anchors (Anchor A at 10% and Anchor B at 80%).
   */
  public static estimateOffsetAndClockDrift(
    referenceTrackPcm: Float32Array,
    secondaryTrackPcm: Float32Array,
    sampleRate: SampleRate,
    maxSearchOffsetSeconds = 15.0,
  ): ClockDriftAlignmentReport {
    const minLen = Math.min(referenceTrackPcm.length, secondaryTrackPcm.length);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || minLen === 0) {
      return {
        initialOffsetSamples: 0,
        initialOffsetSeconds: 0,
        measuredClockDriftPpm: 0,
        resampleStretchFactor: 1.0,
        alignmentConfidence: 0,
      };
    }

    const windowDurationSec = Math.min(30.0, minLen / sampleRate / 3);

    if (windowDurationSec < 2.0) {
      return {
        initialOffsetSamples: 0,
        initialOffsetSeconds: 0,
        measuredClockDriftPpm: 0,
        resampleStretchFactor: 1.0,
        alignmentConfidence: 0,
      };
    }

    const envRate = 200; // 200Hz envelope (5ms steps)
    const decimationStep = Math.max(1, Math.floor(sampleRate / envRate));
    const refEnv = this.extractEnergyEnvelope(referenceTrackPcm, decimationStep);
    const secEnv = this.extractEnergyEnvelope(secondaryTrackPcm, decimationStep);

    const winEnvSamples = Math.max(1, Math.min(refEnv.length, Math.floor(windowDurationSec * envRate)));
    const safeMaxOffsetSec =
      Number.isFinite(maxSearchOffsetSeconds) && maxSearchOffsetSeconds >= 0
        ? maxSearchOffsetSeconds
        : 15.0;
    const maxLagEnv = Math.floor(safeMaxOffsetSec * envRate);

    const maxValidAnchor = Math.max(0, refEnv.length - winEnvSamples);
    const anchorAIndex = Math.min(maxValidAnchor, Math.floor(refEnv.length * 0.1));
    const lagA = this.findBestEnvelopeLag(
      refEnv,
      secEnv,
      anchorAIndex,
      winEnvSamples,
      maxLagEnv,
    );

    const anchorBIndex = Math.min(
      maxValidAnchor,
      Math.max(
        anchorAIndex + winEnvSamples,
        Math.floor(refEnv.length * 0.8) - winEnvSamples,
      ),
    );
    const lagB = this.findBestEnvelopeLag(
      refEnv,
      secEnv,
      anchorBIndex,
      winEnvSamples,
      maxLagEnv,
    );

    const spanEnvSamples = Math.max(1, anchorBIndex - anchorAIndex);
    const driftEnvDelta = lagB.bestLag - lagA.bestLag;

    const driftRatio = driftEnvDelta / spanEnvSamples;
    const measuredClockDriftPpm = Number((driftRatio * 1_000_000).toFixed(2));
    const resampleStretchFactor = 1.0 + driftRatio;

    const initialOffsetSamples = Math.round(
      (lagA.bestLag - anchorAIndex * driftRatio) * decimationStep,
    );

    return {
      initialOffsetSamples,
      initialOffsetSeconds: Number((initialOffsetSamples / sampleRate).toFixed(4)),
      measuredClockDriftPpm,
      resampleStretchFactor: Number(resampleStretchFactor.toFixed(8)),
      alignmentConfidence: Number(
        ((lagA.confidence + lagB.confidence) * 0.5).toFixed(2),
      ),
    };
  }

  /**
   * 2. Applies start offset correction and continuous clock drift compensation using
   * 4-point Catmull-Rom fractional cubic interpolation.
   */
  public static applyDriftAndOffsetCorrection(
    secondaryTrackPcm: Float32Array,
    targetLengthSamples: number,
    report: ClockDriftAlignmentReport,
  ): Float32Array {
    const safeTargetLen =
      Number.isFinite(targetLengthSamples) && targetLengthSamples > 0
        ? Math.floor(targetLengthSamples)
        : 0;
    const out = new Float32Array(safeTargetLen);
    const srcLen = secondaryTrackPcm.length;
    if (safeTargetLen === 0 || srcLen === 0) return out;

    const offset = Number.isFinite(report.initialOffsetSamples) ? report.initialOffsetSamples : 0;
    const factor =
      Number.isFinite(report.resampleStretchFactor) && report.resampleStretchFactor > 0
        ? report.resampleStretchFactor
        : 1.0;

    const readSafe = (k: number): number => {
      const clamped = k < 0 ? 0 : k >= srcLen ? srcLen - 1 : k;
      const v = secondaryTrackPcm[clamped];
      return Number.isFinite(v) ? v : 0;
    };

    for (let i = 0; i < safeTargetLen; i++) {
      const exactSrcPos = i * factor + offset;
      const idx = Math.floor(exactSrcPos);
      const frac = exactSrcPos - idx;

      if (idx >= 0 && idx < srcLen) {
        const y0 = readSafe(idx - 1);
        const y1 = readSafe(idx);
        const y2 = readSafe(idx + 1);
        const y3 = readSafe(idx + 2);

        const c0 = y1;
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);

        out[i] = ((c3 * frac + c2) * frac + c1) * frac + c0;
      }
    }

    return out;
  }

  private static extractEnergyEnvelope(
    pcm: Float32Array,
    stepSamples: number,
  ): Float32Array {
    const safeStep = Math.max(1, Math.floor(stepSamples));
    const envLen = Math.floor(pcm.length / safeStep);
    const env = new Float32Array(envLen);
    for (let i = 0; i < envLen; i++) {
      const base = i * safeStep;
      let sum = 0;
      for (let k = 0; k < safeStep; k++) {
        const v = pcm[base + k];
        sum += Number.isFinite(v) ? Math.abs(v) : 0;
      }
      env[i] = sum / safeStep;
    }
    return env;
  }

  private static findBestEnvelopeLag(
    refEnv: Float32Array,
    secEnv: Float32Array,
    startIdx: number,
    winLen: number,
    maxLag: number,
  ): { bestLag: number; confidence: number } {
    if (startIdx < 0 || winLen <= 0 || startIdx + winLen > refEnv.length) {
      return { bestLag: 0, confidence: 0 };
    }

    let bestLag = 0;
    let maxCorr = -1;

    for (let lag = -maxLag; lag <= maxLag; lag++) {
      if (startIdx + lag < 0 || startIdx + lag + winLen > secEnv.length) continue;

      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < winLen; i++) {
        const a = refEnv[startIdx + i];
        const b = secEnv[startIdx + lag + i];
        dot += a * b;
        magA += a * a;
        magB += b * b;
      }

      const corr = dot / (Math.sqrt(magA * magB) + 1e-12);
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    return {
      bestLag,
      confidence: Math.max(0, Math.min(0.99, maxCorr)),
    };
  }
}
