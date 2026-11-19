import { PerformanceMetricName } from './PerformanceBudget';
import { PerformanceAnomaly } from './PerformanceSample';

export interface MemoryTrendPoint {
  readonly timestampMs: number;
  readonly accountedBytes: number;
}

/**
 * Distinguishes temporary single-sample spikes from persistent latency regressions
 * and progressive memory growth over an extended session.
 */
export class PerformanceAnomalyDetector {
  private anomalySeq = 0;

  /**
   * Detects sustained regression when the recent half of a window is persistently worse
   * than the earlier baseline half (ignoring isolated single-point spikes via median comparison).
   */
  public detectLatencyRegression(
    metric: PerformanceMetricName,
    samples: readonly number[],
    budgetLimit: number | null,
  ): PerformanceAnomaly | null {
    if (samples.length < 12) return null;
    const mid = Math.floor(samples.length / 2);
    const early = [...samples.slice(0, mid)].sort((a, b) => a - b);
    const recent = [...samples.slice(mid)].sort((a, b) => a - b);

    const earlyMedian = early[Math.floor(early.length / 2)];
    const recentMedian = recent[Math.floor(recent.length / 2)];
    const thresholdFloor = budgetLimit ? budgetLimit * 0.85 : 20;

    // Persistent regression requires median to grow by >= 75% AND exceed meaningful threshold
    if (recentMedian > thresholdFloor && recentMedian >= Math.max(earlyMedian * 1.75, earlyMedian + 15)) {
      this.anomalySeq += 1;
      return {
        anomalyId: `anom_lat_${this.anomalySeq}`,
        kind: 'PERSISTENT_LATENCY_REGRESSION',
        metric,
        detectedAtIso: new Date().toISOString(),
        severity: budgetLimit !== null && recentMedian > budgetLimit ? 'ERROR' : 'WARNING',
        detail: `Sustained median latency degradation on ${metric}: baseline ${earlyMedian.toFixed(1)}ms -> recent ${recentMedian.toFixed(1)}ms.`,
        baselineValue: earlyMedian,
        currentValue: recentMedian,
      };
    }
    return null;
  }

  /**
   * Detects monotonic/progressive application memory growth across bounded checkpoints.
   */
  public detectProgressiveMemoryGrowth(
    points: readonly MemoryTrendPoint[],
    minDeltaBytes: number = 16 * 1024 * 1024,
  ): PerformanceAnomaly | null {
    if (points.length < 6) return null;
    let risingSteps = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].accountedBytes > points[i - 1].accountedBytes) {
        risingSteps += 1;
      }
    }
    const first = points[0].accountedBytes;
    const last = points[points.length - 1].accountedBytes;
    const netGrowth = last - first;

    // At least 80% consecutive rising steps AND significant net growth
    if (risingSteps >= Math.floor((points.length - 1) * 0.8) && netGrowth >= minDeltaBytes) {
      this.anomalySeq += 1;
      return {
        anomalyId: `anom_mem_${this.anomalySeq}`,
        kind: 'PROGRESSIVE_MEMORY_GROWTH',
        metric: 'memory_growth',
        detectedAtIso: new Date().toISOString(),
        severity: 'WARNING',
        detail: `Progressive accounted memory growth detected: ${(first / (1024 * 1024)).toFixed(1)}MB -> ${(last / (1024 * 1024)).toFixed(1)}MB.`,
        baselineValue: first,
        currentValue: last,
      };
    }
    return null;
  }
}
