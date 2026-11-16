import test from 'node:test';
import assert from 'node:assert/strict';
import { EditQualityVsModelQualityEvaluator } from './EditQualityVsModelQualityEvaluator';
import { TimeMath } from '../../contracts/timebase.contract';

test('Section 89: EditQualityVsModelQualityEvaluator computes independent AI model metrics and final edit smoothness score', () => {
  const aiReport = EditQualityVsModelQualityEvaluator.evaluateAiModelQuality({
    referenceTranscript: 'امروز در پادکست فارسی درباره هوش مصنوعی صحبت می‌کنیم',
    hypothesisTranscript: 'امروز در پادکست فارسی درباره هوش مصنوعی صحبت میکنیم',
    timestampPairsMs: [
      { groundTruthStartMs: 100, predictedStartMs: 112 },
      { groundTruthStartMs: 500, predictedStartMs: 492 },
    ],
    detectedIssueRanges: [
      { start: TimeMath.secondsToFlicks(2.0), end: TimeMath.secondsToFlicks(2.6) },
    ],
    groundTruthIssueRanges: [
      { start: TimeMath.secondsToFlicks(2.05), end: TimeMath.secondsToFlicks(2.55) },
    ],
    diarizationErrorRatePercent: 4.5,
    realTimeFactor: 0.28,
    peakMemoryMb: 380,
  });

  assert.equal(aiReport.normalizedWerPercent, 0);
  assert.equal(aiReport.wordTimestampMeanAbsErrorMs, 10);
  assert.equal(aiReport.disfluencyMetrics.truePositives, 1);
  assert.equal(aiReport.disfluencyMetrics.f1Score, 1);

  const sr = 48000 as const;
  const smoothPcm = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    smoothPcm[i] = 0.002 * Math.sin((2 * Math.PI * 200 * i) / sr);
  }

  const editReport = EditQualityVsModelQualityEvaluator.evaluateFinalEditedAudioQuality({
    renderedPcmMono: smoothPcm,
    sampleRate: sr,
    spliceBoundarySamples: [12000, 24000, 36000],
    interWordGapDurationsMsAfterEdit: [120, 95, 140],
    multiTrackSyncDriftMs: 0.4,
  });

  assert.equal(editReport.passedFinalEditQuality, true);
  assert.equal(editReport.audibleClickSpliceIndices.length, 0);
  assert.equal(editReport.compositeEditSmoothnessScoreOutOf100, 100);
});
