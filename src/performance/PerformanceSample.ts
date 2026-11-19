import { PerformanceMetricName } from './PerformanceBudget';

export interface PerformanceSample {
  readonly metric: PerformanceMetricName;
  readonly value: number;
  readonly timestampMs: number;
}

export interface AggregatedMetricStats {
  readonly metric: PerformanceMetricName;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number | null;
  readonly overBudgetCount: number;
}

export interface SessionResourceCounters {
  readonly sessionDurationMs: number;
  readonly loadedAudioAssets: number;
  readonly transcriptTokenCount: number;
  readonly timelineEventCount: number;
  readonly activeBackgroundJobs: number;
  readonly workerCount: number;
  readonly audioCacheBytes: number;
  readonly appAccountedMemoryBytes: number;
  readonly appMemoryHardLimitBytes: number;
  readonly longTaskCount: number;
  readonly totalMainThreadBlockingMs: number;
  readonly repeatedOperationFailureCount: number;
}

export interface PerformanceAnomaly {
  readonly anomalyId: string;
  readonly kind: 'PERSISTENT_LATENCY_REGRESSION' | 'PROGRESSIVE_MEMORY_GROWTH' | 'LONG_TASK_STORM';
  readonly metric: PerformanceMetricName | 'memory_growth';
  readonly detectedAtIso: string;
  readonly severity: 'WARNING' | 'ERROR';
  readonly detail: string;
  readonly baselineValue: number;
  readonly currentValue: number;
}

export interface PerformanceSnapshot {
  readonly capturedAtIso: string;
  readonly monitoringPausedForMemoryEmergency: boolean;
  readonly counters: SessionResourceCounters;
  readonly metrics: Readonly<Partial<Record<PerformanceMetricName, AggregatedMetricStats>>>;
  readonly activeAnomalies: readonly PerformanceAnomaly[];
  readonly memoryScopeNote: string;
}
