/**
 * @file src/ai-engine/asr/PersianAsrConfidenceCalibrator.ts
 * @description Section 134: Word-Level Confidence Calibration (Platt Scaling & ECE) for Persian ASR.
 *              Transforms overconfident raw CTC/Transducer softmax probabilities into calibrated
 *              empirical accuracy probabilities via Platt Scaling logistic regression and evaluates
 *              Expected Calibration Error (ECE) across 10 reliability bins.
 */

export interface CalibrationSample {
  /** Raw uncalibrated model confidence in (0, 1) */
  rawConfidence: number;
  /** Ground-truth correctness: 1 if word matches reference transcript, 0 if substitution/insertion error */
  isCorrect: 0 | 1;
}

export interface PlattScalingParams {
  /** Logistic slope (a > 0 preserves monotonicity) */
  slopeA: number;
  /** Logistic intercept (b < 0 shifts overconfident scores downward) */
  interceptB: number;
}

export interface CalibrationBinMetric {
  binIndex: number;
  lowerBound: number;
  upperBound: number;
  sampleCount: number;
  meanPredictedConfidence: number;
  empiricalAccuracy: number;
  absoluteCalibrationGap: number;
}

export interface CalibrationEvaluationReport {
  totalSamples: number;
  /** Expected Calibration Error (ECE) in [0, 1] — lower is better (target <= 0.04) */
  expectedCalibrationError: number;
  /** Maximum Calibration Error across populated bins */
  maxCalibrationError: number;
  /** Brier Score (mean squared error between predicted probability and binary outcome) */
  brierScore: number;
  bins: CalibrationBinMetric[];
}

export class PersianAsrConfidenceCalibrator {
  private static readonly EPSILON = 1e-6;

  /**
   * Computes logit(p) = ln(p / (1 - p)) with safe clamping away from 0 and 1.
   */
  public static logit(prob: number): number {
    const p = Math.max(this.EPSILON, Math.min(1.0 - this.EPSILON, prob));
    return Math.log(p / (1.0 - p));
  }

  /**
   * Numerically stable sigmoid function 1 / (1 + exp(-z)).
   */
  public static sigmoid(z: number): number {
    if (z >= 0) {
      const ez = Math.exp(-z);
      return 1.0 / (1.0 + ez);
    } else {
      const ez = Math.exp(z);
      return ez / (1.0 + ez);
    }
  }

  /**
   * Applies Platt Scaling to a raw word confidence score:
   *   p_cal = sigmoid(a * logit(p_raw) + b)
   */
  public static calibrateConfidence(rawConfidence: number, params: PlattScalingParams): number {
    const x = this.logit(rawConfidence);
    return this.sigmoid(params.slopeA * x + params.interceptB);
  }

  /**
   * Fits Platt Scaling parameters (slopeA, interceptB) on a held-out Persian validation set
   * using L2-regularized gradient descent on Binary Cross-Entropy with Platt's Target Smoothing.
   */
  public static fitPlattScaling(
    validationSamples: CalibrationSample[],
    iterations: number = 400,
    learningRate: number = 0.05
  ): PlattScalingParams {
    if (validationSamples.length === 0) {
      return { slopeA: 1.0, interceptB: 0.0 };
    }

    // Platt's Bayesian target smoothing prevents infinite weights on separable subsets
    let posCount = 0;
    let negCount = 0;
    for (const s of validationSamples) {
      if (s.isCorrect === 1) posCount++;
      else negCount++;
    }

    const tPos = (posCount + 1.0) / (posCount + 2.0);
    const tNeg = 1.0 / (negCount + 2.0);

    const logits = new Float64Array(validationSamples.length);
    const targets = new Float64Array(validationSamples.length);

    for (let i = 0; i < validationSamples.length; i++) {
      logits[i] = this.logit(validationSamples[i].rawConfidence);
      targets[i] = validationSamples[i].isCorrect === 1 ? tPos : tNeg;
    }

    let slopeA = 1.0;
    let interceptB = 0.0;
    const invN = 1.0 / validationSamples.length;
    const l2Lambda = 1e-4;

    for (let iter = 0; iter < iterations; iter++) {
      let gradA = 0.0;
      let gradB = 0.0;

      for (let i = 0; i < logits.length; i++) {
        const pred = this.sigmoid(slopeA * logits[i] + interceptB);
        const diff = pred - targets[i];
        gradA += diff * logits[i];
        gradB += diff;
      }

      gradA = gradA * invN + l2Lambda * (slopeA - 1.0);
      gradB = gradB * invN + l2Lambda * interceptB;

      slopeA = Math.max(0.05, slopeA - learningRate * gradA);
      interceptB -= learningRate * gradB;
    }

    return {
      slopeA: Number(slopeA.toFixed(5)),
      interceptB: Number(interceptB.toFixed(5)),
    };
  }

  /**
   * Evaluates Expected Calibration Error (ECE) across M=10 equal-width probability bins.
   */
  public static computeExpectedCalibrationError(
    samples: CalibrationSample[],
    params?: PlattScalingParams,
    numBins: number = 10
  ): CalibrationEvaluationReport {
    const bins: CalibrationBinMetric[] = Array.from({ length: numBins }, (_, idx) => ({
      binIndex: idx,
      lowerBound: idx / numBins,
      upperBound: (idx + 1) / numBins,
      sampleCount: 0,
      meanPredictedConfidence: 0,
      empiricalAccuracy: 0,
      absoluteCalibrationGap: 0,
    }));

    if (samples.length === 0) {
      return {
        totalSamples: 0,
        expectedCalibrationError: 0,
        maxCalibrationError: 0,
        brierScore: 0,
        bins,
      };
    }

    let brierSum = 0.0;

    for (const s of samples) {
      const p = params ? this.calibrateConfidence(s.rawConfidence, params) : s.rawConfidence;
      const clampedP = Math.max(0.0, Math.min(1.0, p));
      const binIdx = Math.min(numBins - 1, Math.floor(clampedP * numBins));

      bins[binIdx].sampleCount += 1;
      bins[binIdx].meanPredictedConfidence += clampedP;
      bins[binIdx].empiricalAccuracy += s.isCorrect;

      const err = clampedP - s.isCorrect;
      brierSum += err * err;
    }

    let ece = 0.0;
    let mce = 0.0;

    for (const b of bins) {
      if (b.sampleCount > 0) {
        b.meanPredictedConfidence /= b.sampleCount;
        b.empiricalAccuracy /= b.sampleCount;
        b.absoluteCalibrationGap = Math.abs(b.meanPredictedConfidence - b.empiricalAccuracy);

        ece += (b.sampleCount / samples.length) * b.absoluteCalibrationGap;
        if (b.absoluteCalibrationGap > mce) {
          mce = b.absoluteCalibrationGap;
        }
      }
    }

    return {
      totalSamples: samples.length,
      expectedCalibrationError: Number(ece.toFixed(5)),
      maxCalibrationError: Number(mce.toFixed(5)),
      brierScore: Number((brierSum / samples.length).toFixed(5)),
      bins,
    };
  }
}
