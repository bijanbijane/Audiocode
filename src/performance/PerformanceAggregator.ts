import { PerformanceMetricName } from './PerformanceBudget';
import { AggregatedMetricStats } from './PerformanceSample';

function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Bounded per-metric ring buffer aggregator (prevents unbounded raw sample accumulation).
 */
export class PerformanceAggregator {
  private readonly maxWindowSamples: number;
  private readonly windows = new Map<PerformanceMetricName, number[]>();
  private readonly totalCounts = new Map<PerformanceMetricName, number>();
  private readonly overBudgetCounts = new Map<PerformanceMetricName, number>();

  constructor(maxWindowSamples = 200) {
    this.maxWindowSamples = Math.max(16, maxWindowSamples);
  }

  public record(metric: PerformanceMetricName, value: number, overBudget: boolean): void {
    if (!Number.isFinite(value) || value < 0) return;
    let ring = this.windows.get(metric);
    if (!ring) {
      ring = [];
      this.windows.set(metric, ring);
    }
    ring.push(value);
    if (ring.length > this.maxWindowSamples) {
      ring.shift();
    }
    this.totalCounts.set(metric, (this.totalCounts.get(metric) ?? 0) + 1);
    if (overBudget) {
      this.overBudgetCounts.set(metric, (this.overBudgetCounts.get(metric) ?? 0) + 1);
    }
  }

  public getWindowValues(metric: PerformanceMetricName): readonly number[] {
    return this.windows.get(metric) ?? [];
  }

  public getStats(metric: PerformanceMetricName): AggregatedMetricStats | null {
    const raw = this.windows.get(metric);
    if (!raw || raw.length === 0) return null;
    const sorted = [...raw].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
      metric,
      count: this.totalCounts.get(metric) ?? sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Number((sum / sorted.length).toFixed(2)),
      p50: Number(percentileSorted(sorted, 50).toFixed(2)),
      p95: Number(percentileSorted(sorted, 95).toFixed(2)),
      p99: sorted.length >= 20 ? Number(percentileSorted(sorted, 99).toFixed(2)) : null,
      overBudgetCount: this.overBudgetCounts.get(metric) ?? 0,
    };
  }

  public getAllStats(): Readonly<Partial<Record<PerformanceMetricName, AggregatedMetricStats>>> {
    const out: Partial<Record<PerformanceMetricName, AggregatedMetricStats>> = {};
    for (const key of this.windows.keys()) {
      const s = this.getStats(key);
      if (s) out[key] = s;
    }
    return out;
  }

  public getStoredSampleCount(): number {
    let total = 0;
    for (const ring of this.windows.values()) {
      total += ring.length;
    }
    return total;
  }

  public clear(): void {
    this.windows.clear();
    this.totalCounts.clear();
    this.overBudgetCounts.clear();
  }
}
