import { PersianAsrBaselineReport } from './batch-persian-corpus-benchmark-cli';

export interface RegressionThresholdsPolicy {
  readonly maxAllowedOverallNormWerRegressionPct: number; // Default 0.0 (zero overall regression allowed)
  readonly maxAllowedSliceNormWerRegressionPct: number; // Default +1.0% max tolerance per style/noise slice
  readonly maxAllowedRtfSlowdownRatio: number; // Default 1.15 (at most 15% slower)
  readonly maxAllowedPeakRssIncreaseMb: number; // Default +80 MB
}

export interface SampleLevelRegressionFinding {
  readonly sampleId: string;
  readonly baselineNormWerPct: number;
  readonly candidateNormWerPct: number;
  readonly werDeltaPct: number;
  readonly status: 'IMPROVED' | 'UNCHANGED' | 'REGRESSED';
}

export interface AsrModelRegressionDiffVerdict {
  readonly baselineModelVersion: string;
  readonly candidateModelVersion: string;
  readonly promotionApproved: boolean;
  readonly overallNormWerDeltaPct: number;
  readonly formalSliceDeltaPct: number;
  readonly colloquialSliceDeltaPct: number;
  readonly noisySliceDeltaPct: number;
  readonly rtfRatio: number;
  readonly memoryDeltaMb: number;
  readonly blockingReasons: string[];
  readonly topImprovedSamples: SampleLevelRegressionFinding[];
  readonly topRegressedSamples: SampleLevelRegressionFinding[];
}

/**
 * Section 126: Persian ASR Model Version Regression Diff Runner & Simpson's Paradox Blocker
 */
export class AsrRegressionDiffRunner {
  public static compareCandidateAgainstBaseline(
    baseline: PersianAsrBaselineReport,
    candidate: PersianAsrBaselineReport,
    policy: RegressionThresholdsPolicy = {
      maxAllowedOverallNormWerRegressionPct: 0.0,
      maxAllowedSliceNormWerRegressionPct: 1.0,
      maxAllowedRtfSlowdownRatio: 1.15,
      maxAllowedPeakRssIncreaseMb: 80,
    },
  ): AsrModelRegressionDiffVerdict {
    const blockingReasons: string[] = [];

    const overallDelta = Number(
      (
        candidate.durationWeightedNormalizedWerPercent -
        baseline.durationWeightedNormalizedWerPercent
      ).toFixed(2),
    );
    const formalDelta = Number(
      (
        candidate.breakdownByStyle.formalNormalizedWerPercent -
        baseline.breakdownByStyle.formalNormalizedWerPercent
      ).toFixed(2),
    );
    const colloquialDelta = Number(
      (
        candidate.breakdownByStyle.colloquialNormalizedWerPercent -
        baseline.breakdownByStyle.colloquialNormalizedWerPercent
      ).toFixed(2),
    );
    const noisyDelta = Number(
      (
        candidate.breakdownByStyle.noisyNormalizedWerPercent -
        baseline.breakdownByStyle.noisyNormalizedWerPercent
      ).toFixed(2),
    );

    const rtfRatio = Number(
      (
        candidate.meanRealTimeFactor / Math.max(0.001, baseline.meanRealTimeFactor)
      ).toFixed(3),
    );
    const memoryDeltaMb = Number(
      (candidate.maxPeakRssMemoryMb - baseline.maxPeakRssMemoryMb).toFixed(1),
    );

    // 1. Quality regression gates across overall + formal/colloquial/noisy slices (prevents Simpson's Paradox)
    if (overallDelta > policy.maxAllowedOverallNormWerRegressionPct) {
      blockingReasons.push(
        `REGRESSION_OVERALL_WER: خطای کل مدل جدید به میزان +${overallDelta}% افزایش یافته است.`,
      );
    }
    if (formalDelta > policy.maxAllowedSliceNormWerRegressionPct) {
      blockingReasons.push(
        `REGRESSION_FORMAL_SLICE: خطای گفتار رسمی +${formalDelta}% بدتر شده است.`,
      );
    }
    if (colloquialDelta > policy.maxAllowedSliceNormWerRegressionPct) {
      blockingReasons.push(
        `REGRESSION_COLLOQUIAL_SLICE: خطای گفتار محاوره‌ای +${colloquialDelta}% بدتر شده است.`,
      );
    }
    if (noisyDelta > policy.maxAllowedSliceNormWerRegressionPct) {
      blockingReasons.push(
        `REGRESSION_NOISY_SLICE: خطای فایل‌های نویزدار +${noisyDelta}% بدتر شده است.`,
      );
    }

    // 2. Latency (RTF) and Peak Memory (RSS) gates
    if (rtfRatio > policy.maxAllowedRtfSlowdownRatio) {
      blockingReasons.push(
        `REGRESSION_INFERENCE_SPEED: سرعت پردازش ${rtfRatio}x کندتر از نسخه قبلی است.`,
      );
    }
    if (memoryDeltaMb > policy.maxAllowedPeakRssIncreaseMb) {
      blockingReasons.push(
        `REGRESSION_PEAK_MEMORY: مصرف حافظه +${memoryDeltaMb}MB افزایش یافته است.`,
      );
    }

    // 3. Per-sample diff analysis
    const baseSampleMap = new Map(
      baseline.perSampleResults.map((s) => [s.sampleId, s.result]),
    );
    const findings: SampleLevelRegressionFinding[] = [];

    for (const candEntry of candidate.perSampleResults) {
      const baseRes = baseSampleMap.get(candEntry.sampleId);
      if (!baseRes) continue;
      const bWer = baseRes.normalizedWerPercent ?? 0;
      const cWer = candEntry.result.normalizedWerPercent ?? 0;
      const delta = Number((cWer - bWer).toFixed(2));

      findings.push({
        sampleId: candEntry.sampleId,
        baselineNormWerPct: bWer,
        candidateNormWerPct: cWer,
        werDeltaPct: delta,
        status: delta < -0.5 ? 'IMPROVED' : delta > 0.5 ? 'REGRESSED' : 'UNCHANGED',
      });
    }

    const topImprovedSamples = [...findings]
      .filter((f) => f.status === 'IMPROVED')
      .sort((a, b) => a.werDeltaPct - b.werDeltaPct)
      .slice(0, 5);

    const topRegressedSamples = [...findings]
      .filter((f) => f.status === 'REGRESSED')
      .sort((a, b) => b.werDeltaPct - a.werDeltaPct)
      .slice(0, 5);

    return {
      baselineModelVersion: baseline.modelVersion,
      candidateModelVersion: candidate.modelVersion,
      promotionApproved: blockingReasons.length === 0,
      overallNormWerDeltaPct: overallDelta,
      formalSliceDeltaPct: formalDelta,
      colloquialSliceDeltaPct: colloquialDelta,
      noisySliceDeltaPct: noisyDelta,
      rtfRatio,
      memoryDeltaMb,
      blockingReasons,
      topImprovedSamples,
      topRegressedSamples,
    };
  }
}
