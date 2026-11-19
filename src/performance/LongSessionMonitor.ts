import { PerformanceAggregator } from './PerformanceAggregator';
import { MemoryTrendPoint, PerformanceAnomalyDetector } from './PerformanceAnomalyDetector';
import { PerformanceBudget, PerformanceMetricName } from './PerformanceBudget';
import {
  PerformanceAnomaly,
  PerformanceSnapshot,
  SessionResourceCounters,
} from './PerformanceSample';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import { getSharedDiagnosticLogger, LocalDiagnosticLogger } from '../reliability/LocalDiagnosticLogger';

export interface LongSessionCounterPatch {
  readonly loadedAudioAssets?: number;
  readonly transcriptTokenCount?: number;
  readonly timelineEventCount?: number;
  readonly activeBackgroundJobs?: number;
  readonly workerCount?: number;
  readonly audioCacheBytes?: number;
  readonly repeatedOperationFailureCount?: number;
}

/**
 * Bounded Long-Session Performance Monitor (AVP-P11-001 Section 2)
 * - Strictly bounded sample windows and memory trend checkpoints.
 * - Pauses non-essential sampling during memory emergency.
 * - Emits privacy-safe anomaly diagnostics to P10 LocalDiagnosticLogger.
 */
export class LongSessionMonitor {
  private readonly budget: PerformanceBudget;
  private readonly aggregator: PerformanceAggregator;
  private readonly detector: PerformanceAnomalyDetector;
  private readonly memoryBudget: MemoryBudgetManager;
  private readonly logger: LocalDiagnosticLogger;
  private readonly startedAtMs: number;
  private readonly memoryTrend: MemoryTrendPoint[] = [];
  private readonly maxMemoryTrendPoints = 60;
  private readonly anomalies: PerformanceAnomaly[] = [];
  private readonly maxAnomalies = 30;

  private loadedAudioAssets = 0;
  private transcriptTokenCount = 0;
  private timelineEventCount = 0;
  private activeBackgroundJobs = 0;
  private workerCount = 0;
  private audioCacheBytes = 0;
  private longTaskCount = 0;
  private totalMainThreadBlockingMs = 0;
  private repeatedOperationFailureCount = 0;

  constructor(options?: {
    readonly budget?: PerformanceBudget;
    readonly memoryBudget?: MemoryBudgetManager;
    readonly logger?: LocalDiagnosticLogger;
    readonly maxWindowSamples?: number;
  }) {
    this.budget = options?.budget ?? new PerformanceBudget();
    this.aggregator = new PerformanceAggregator(
      options?.maxWindowSamples ?? this.budget.spec.maxDiagnosticSamples,
    );
    this.detector = new PerformanceAnomalyDetector();
    this.memoryBudget = options?.memoryBudget ?? getSharedMemoryBudgetManager();
    this.logger = options?.logger ?? getSharedDiagnosticLogger();
    this.startedAtMs = Date.now();
  }

  public isPausedForMemoryEmergency(): boolean {
    return this.memoryBudget.getPressureLevel() === 'emergency';
  }

  public updateCounters(patch: LongSessionCounterPatch): void {
    const sanitizeCounter = (val: number | undefined, current: number) =>
      typeof val === 'number' && Number.isFinite(val) ? Math.max(0, Math.floor(val)) : current;

    if (patch.loadedAudioAssets !== undefined) {
      this.loadedAudioAssets = sanitizeCounter(patch.loadedAudioAssets, this.loadedAudioAssets);
    }
    if (patch.transcriptTokenCount !== undefined) {
      this.transcriptTokenCount = sanitizeCounter(patch.transcriptTokenCount, this.transcriptTokenCount);
    }
    if (patch.timelineEventCount !== undefined) {
      this.timelineEventCount = sanitizeCounter(patch.timelineEventCount, this.timelineEventCount);
    }
    if (patch.activeBackgroundJobs !== undefined) {
      this.activeBackgroundJobs = sanitizeCounter(patch.activeBackgroundJobs, this.activeBackgroundJobs);
    }
    if (patch.workerCount !== undefined) {
      this.workerCount = sanitizeCounter(patch.workerCount, this.workerCount);
    }
    if (patch.audioCacheBytes !== undefined) {
      this.audioCacheBytes = sanitizeCounter(patch.audioCacheBytes, this.audioCacheBytes);
    }
    if (patch.repeatedOperationFailureCount !== undefined) {
      this.repeatedOperationFailureCount = sanitizeCounter(
        patch.repeatedOperationFailureCount,
        this.repeatedOperationFailureCount,
      );
    }
  }

  public recordMetric(metric: PerformanceMetricName, durationOrValue: number): void {
    if (!Number.isFinite(durationOrValue) || durationOrValue < 0) {
      return;
    }
    if (this.isPausedForMemoryEmergency()) {
      return;
    }
    const evalRes = this.budget.evaluate(metric, durationOrValue);
    this.aggregator.record(metric, durationOrValue, !evalRes.withinBudget);

    if (metric === 'main_thread_block_ms' && durationOrValue >= this.budget.spec.longTaskThresholdMs) {
      this.longTaskCount += 1;
      this.totalMainThreadBlockingMs += durationOrValue;
    }

    const windowValues = this.aggregator.getWindowValues(metric);
    const anomaly = this.detector.detectLatencyRegression(
      metric,
      windowValues,
      evalRes.budgetLimit,
    );
    if (anomaly) {
      this.pushAnomaly(anomaly);
    }
  }

  public sampleMemoryCheckpoint(): void {
    const snap = this.memoryBudget.getSnapshot();
    this.memoryTrend.push({
      timestampMs: Date.now(),
      accountedBytes: snap.accountedBytes,
    });
    if (this.memoryTrend.length > this.maxMemoryTrendPoints) {
      this.memoryTrend.shift();
    }
    const growthAnomaly = this.detector.detectProgressiveMemoryGrowth(this.memoryTrend);
    if (growthAnomaly) {
      this.pushAnomaly(growthAnomaly);
    }
  }

  public getStoredSampleCount(): number {
    return this.aggregator.getStoredSampleCount();
  }

  public getSnapshot(): PerformanceSnapshot {
    const memSnap = this.memoryBudget.getSnapshot();
    const counters: SessionResourceCounters = {
      sessionDurationMs: Math.max(0, Date.now() - this.startedAtMs),
      loadedAudioAssets: this.loadedAudioAssets,
      transcriptTokenCount: this.transcriptTokenCount,
      timelineEventCount: this.timelineEventCount,
      activeBackgroundJobs: this.activeBackgroundJobs,
      workerCount: this.workerCount,
      audioCacheBytes: this.audioCacheBytes,
      appAccountedMemoryBytes: memSnap.accountedBytes,
      appMemoryHardLimitBytes: memSnap.hardLimitBytes,
      longTaskCount: this.longTaskCount,
      totalMainThreadBlockingMs: Number(this.totalMainThreadBlockingMs.toFixed(2)),
      repeatedOperationFailureCount: this.repeatedOperationFailureCount,
    };

    return {
      capturedAtIso: new Date().toISOString(),
      monitoringPausedForMemoryEmergency: this.isPausedForMemoryEmergency(),
      counters,
      metrics: this.aggregator.getAllStats(),
      activeAnomalies: [...this.anomalies],
      memoryScopeNote: this.budget.memoryScopeNote,
    };
  }

  public reset(): void {
    this.aggregator.clear();
    this.memoryTrend.length = 0;
    this.anomalies.length = 0;
    this.longTaskCount = 0;
    this.totalMainThreadBlockingMs = 0;
  }

  private pushAnomaly(anomaly: PerformanceAnomaly): void {
    this.anomalies.push(anomaly);
    if (this.anomalies.length > this.maxAnomalies) {
      this.anomalies.shift();
    }
    this.logger.log({
      severity: anomaly.severity,
      subsystem: 'INTERNAL',
      code: anomaly.kind,
      message: anomaly.detail,
      metadata: {
        metric: anomaly.metric,
        baselineValue: anomaly.baselineValue,
        currentValue: anomaly.currentValue,
      },
    });
  }
}
