import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsrRegressionDiffRunner } from './AsrRegressionDiffRunner';
import { PersianAsrBaselineReport } from './batch-persian-corpus-benchmark-cli';

describe('Section 126: AsrRegressionDiffRunner', () => {
  it('blocks promotion when colloquial slice degrades by > 1.0% even if overall WER improves', () => {
    const makeReport = (
      ver: string,
      overall: number,
      formal: number,
      colloquial: number,
      noisy: number,
    ): PersianAsrBaselineReport => ({
      modelId: 'fastconformer-fa',
      modelVersion: ver,
      generatedAtIso: new Date().toISOString(),
      corpusAudit: {
        totalSamplesCount: 20,
        totalDurationMinutes: 120,
        distinctAccentsCount: 4,
        missingMandatoryAxes: [],
        baselineReadyForThresholdApproval: true,
      },
      totalAudioMinutesEvaluated: 120,
      durationWeightedNormalizedWerPercent: overall,
      durationWeightedRawWerPercent: overall + 1.5,
      breakdownByStyle: {
        formalNormalizedWerPercent: formal,
        colloquialNormalizedWerPercent: colloquial,
        noisyNormalizedWerPercent: noisy,
      },
      meanRealTimeFactor: 0.12,
      maxPeakRssMemoryMb: 420,
      perSampleResults: [],
    });

    const base = makeReport('1.1.0', 10.5, 8.0, 12.0, 14.0);
    const cand = makeReport('1.2.0', 10.2, 6.2, 14.5, 14.1);

    const verdict = AsrRegressionDiffRunner.compareCandidateAgainstBaseline(base, cand);
    assert.equal(verdict.promotionApproved, false);
    assert.ok(
      verdict.blockingReasons.some((r) => r.startsWith('REGRESSION_COLLOQUIAL_SLICE')),
    );
  });
});
