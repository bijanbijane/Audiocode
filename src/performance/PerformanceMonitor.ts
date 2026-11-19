import { LongSessionMonitor } from './LongSessionMonitor';
import { PerformanceBudget, PerformanceMetricName } from './PerformanceBudget';
import { PerformanceSnapshot } from './PerformanceSample';

export class PerformanceMonitor {
  public readonly session: LongSessionMonitor;
  public readonly budget: PerformanceBudget;

  constructor(budget: PerformanceBudget = new PerformanceBudget()) {
    this.budget = budget;
    this.session = new LongSessionMonitor({ budget });
  }

  public measureSync<T>(metric: PerformanceMetricName, fn: () => T): T {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      return fn();
    } finally {
      const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.session.recordMetric(metric, Math.max(0, end - start));
    }
  }

  public async measureAsync<T>(metric: PerformanceMetricName, fn: () => Promise<T>): Promise<T> {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      return await fn();
    } finally {
      const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.session.recordMetric(metric, Math.max(0, end - start));
    }
  }

  public getSnapshot(): PerformanceSnapshot {
    return this.session.getSnapshot();
  }
}

let sharedPerformanceMonitor: PerformanceMonitor | null = null;

export function getSharedPerformanceMonitor(): PerformanceMonitor {
  if (!sharedPerformanceMonitor) {
    sharedPerformanceMonitor = new PerformanceMonitor();
  }
  return sharedPerformanceMonitor;
}
