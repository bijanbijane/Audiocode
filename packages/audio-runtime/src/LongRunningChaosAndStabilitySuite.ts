export interface StabilityCycleSample {
  readonly cycleIndex: number;
  readonly usedHeapMb: number;
  readonly wasmLinearMemoryMb: number;
  readonly cycleExecutionDurationMs: number;
}

export interface LongRunningStabilityReport {
  readonly totalCyclesExecuted: number;
  readonly steadyStateSampleCount: number;
  readonly memoryLeakSlopeMbPerCycle: number;
  readonly firstQuarterAvgMs: number;
  readonly lastQuarterAvgMs: number;
  readonly performanceDegradationRatio: number;
  readonly quotaExhaustionHandledCleanly: boolean;
  readonly batteryThrottlingAdaptedCleanly: boolean;
  readonly networkFlapRecoveredCleanly: boolean;
  readonly gpuLostRecoveredCleanly: boolean;
  readonly passedAllStabilityCriteria: boolean;
  readonly samples: readonly StabilityCycleSample[];
}

export interface RunStabilityAndChaosParams {
  /** Number of consecutive lifecycle iterations (e.g. 50+ open/close project & load/unload model cycles). */
  readonly cyclesCount: number;
  readonly runSingleLifecycleCycle: (cycleIdx: number) => Promise<{
    usedHeapMb: number;
    wasmMemoryMb: number;
  }>;
  readonly simulateQuotaExhaustionFn: () => Promise<boolean>;
  readonly simulateLowBatteryModeFn: () => Promise<boolean>;
  readonly simulateNetworkFlapFn?: () => Promise<boolean>;
  readonly simulateGpuDeviceLostFn?: () => Promise<boolean>;
  /** Default strict threshold: <= 0.15 MB/cycle steady-state OLS slope. */
  readonly maxAllowedMemorySlopeMbPerCycle?: number;
  /** Default strict threshold: <= 1.25 (max 25% latency drift between first and last quarter). */
  readonly maxAllowedDegradationRatio?: number;
}

/**
 * Long-Running Chaos & OLS Memory Leak Stability Suite (Architecture Doc Section 63)
 * Validates project open/close cycles, model load/unload cycles, quota exhaustion,
 * battery throttling adaptation, network interruption, and OLS regression memory leak slope (Beta_1).
 */
export class LongRunningChaosAndStabilitySuite {
  public static async runFullStabilityAndChaosTest(
    params: RunStabilityAndChaosParams,
  ): Promise<LongRunningStabilityReport> {
    if (!Number.isFinite(params.cyclesCount) || params.cyclesCount < 2) {
      throw new Error('INVALID_STABILITY_CYCLES: cyclesCount must be at least 2');
    }

    const samples: StabilityCycleSample[] = [];
    for (let i = 0; i < params.cyclesCount; i++) {
      const t0 = performance.now();
      const mem = await params.runSingleLifecycleCycle(i);
      const elapsedMs = performance.now() - t0;

      samples.push({
        cycleIndex: i,
        usedHeapMb: mem.usedHeapMb,
        wasmLinearMemoryMb: mem.wasmMemoryMb,
        cycleExecutionDurationMs: elapsedMs,
      });
    }

    // 1. Discard initial warm-up cycles and compute OLS regression slope (Beta_1)
    const warmupSkip = Math.min(5, Math.floor(samples.length / 4));
    const steadySamples = samples.slice(warmupSkip);

    const memoryLeakSlopeMbPerCycle = this.computeLinearRegressionSlope(
      steadySamples.map((s) => s.cycleIndex),
      steadySamples.map((s) => s.usedHeapMb + s.wasmLinearMemoryMb),
    );

    // 2. Compare first vs last quarter execution duration to detect thermal/GC degradation
    const quarterSize = Math.max(1, Math.floor(steadySamples.length / 4));
    const firstQuarterAvgMs =
      steadySamples
        .slice(0, quarterSize)
        .reduce((acc, s) => acc + s.cycleExecutionDurationMs, 0) / quarterSize;
    const lastQuarterAvgMs =
      steadySamples
        .slice(-quarterSize)
        .reduce((acc, s) => acc + s.cycleExecutionDurationMs, 0) / quarterSize;

    const performanceDegradationRatio = lastQuarterAvgMs / Math.max(0.1, firstQuarterAvgMs);

    // 3. Chaos fault-injection checks (isolated so unexpected throws cleanly record failure)
    const quotaExhaustionHandledCleanly = await params
      .simulateQuotaExhaustionFn()
      .catch(() => false);
    const batteryThrottlingAdaptedCleanly = await params
      .simulateLowBatteryModeFn()
      .catch(() => false);
    const networkFlapRecoveredCleanly = params.simulateNetworkFlapFn
      ? await params.simulateNetworkFlapFn().catch(() => false)
      : true;
    const gpuLostRecoveredCleanly = params.simulateGpuDeviceLostFn
      ? await params.simulateGpuDeviceLostFn().catch(() => false)
      : true;

    const maxSlope = params.maxAllowedMemorySlopeMbPerCycle ?? 0.15;
    const maxDegradation = params.maxAllowedDegradationRatio ?? 1.25;

    const passedAllStabilityCriteria =
      memoryLeakSlopeMbPerCycle <= maxSlope &&
      performanceDegradationRatio <= maxDegradation &&
      quotaExhaustionHandledCleanly &&
      batteryThrottlingAdaptedCleanly &&
      networkFlapRecoveredCleanly &&
      gpuLostRecoveredCleanly;

    return {
      totalCyclesExecuted: params.cyclesCount,
      steadyStateSampleCount: steadySamples.length,
      memoryLeakSlopeMbPerCycle: Number(memoryLeakSlopeMbPerCycle.toFixed(4)),
      firstQuarterAvgMs: Number(firstQuarterAvgMs.toFixed(4)),
      lastQuarterAvgMs: Number(lastQuarterAvgMs.toFixed(4)),
      performanceDegradationRatio: Number(performanceDegradationRatio.toFixed(3)),
      quotaExhaustionHandledCleanly,
      batteryThrottlingAdaptedCleanly,
      networkFlapRecoveredCleanly,
      gpuLostRecoveredCleanly,
      passedAllStabilityCriteria,
      samples,
    };
  }

  /**
   * Computes OLS slope Beta_1 = Sum((x_i - meanX)(y_i - meanY)) / Sum((x_i - meanX)^2).
   */
  public static computeLinearRegressionSlope(x: readonly number[], y: readonly number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;

    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
    }
    const meanX = sumX / n;
    const meanY = sumY / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      num += dx * (y[i] - meanY);
      den += dx * dx;
    }
    return den === 0 ? 0 : num / den;
  }
}
