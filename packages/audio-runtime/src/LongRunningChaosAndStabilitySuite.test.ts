import test from 'node:test';
import assert from 'node:assert/strict';
import { LongRunningChaosAndStabilitySuite } from './LongRunningChaosAndStabilitySuite';

test('LongRunningChaosAndStabilitySuite passes 50 clean cycles even with initial warm-up allocations', async () => {
  const report = await LongRunningChaosAndStabilitySuite.runFullStabilityAndChaosTest({
    cyclesCount: 50,
    runSingleLifecycleCycle: async (idx) => {
      // Warm-up growth during cycles 0..4 should be excluded cleanly from steady-state OLS slope
      if (idx < 5) {
        return { usedHeapMb: 40 + idx * 5, wasmMemoryMb: 16 + idx * 2 };
      }
      const jitter = (idx % 3) * 0.2;
      return { usedHeapMb: 65 + jitter, wasmMemoryMb: 24 };
    },
    simulateQuotaExhaustionFn: async () => true,
    simulateLowBatteryModeFn: async () => true,
    simulateNetworkFlapFn: async () => true,
    simulateGpuDeviceLostFn: async () => true,
  });

  assert.equal(report.totalCyclesExecuted, 50);
  assert.equal(report.steadyStateSampleCount, 45);
  assert.ok(Math.abs(report.memoryLeakSlopeMbPerCycle) < 0.05);
  assert.equal(report.quotaExhaustionHandledCleanly, true);
  assert.equal(report.batteryThrottlingAdaptedCleanly, true);
  assert.equal(report.passedAllStabilityCriteria, true);
});

test('LongRunningChaosAndStabilitySuite detects steady-state WASM/JS memory leak via OLS slope Beta_1', async () => {
  const report = await LongRunningChaosAndStabilitySuite.runFullStabilityAndChaosTest({
    cyclesCount: 40,
    runSingleLifecycleCycle: async (idx) => ({
      usedHeapMb: 50 + idx * 0.35,
      wasmMemoryMb: 16 + idx * 0.15,
    }),
    simulateQuotaExhaustionFn: async () => true,
    simulateLowBatteryModeFn: async () => true,
  });

  assert.ok(
    Math.abs(report.memoryLeakSlopeMbPerCycle - 0.5) < 0.02,
    `Expected ~0.5 MB/cycle slope, got ${report.memoryLeakSlopeMbPerCycle}`,
  );
  assert.equal(report.passedAllStabilityCriteria, false);
});

test('LongRunningChaosAndStabilitySuite fails stability gate when quota exhaustion handler rejects', async () => {
  const report = await LongRunningChaosAndStabilitySuite.runFullStabilityAndChaosTest({
    cyclesCount: 20,
    runSingleLifecycleCycle: async () => ({ usedHeapMb: 42, wasmMemoryMb: 12 }),
    simulateQuotaExhaustionFn: async () => {
      throw new Error('QuotaExceededError unhandled');
    },
    simulateLowBatteryModeFn: async () => true,
  });

  assert.equal(report.quotaExhaustionHandledCleanly, false);
  assert.equal(report.passedAllStabilityCriteria, false);
});
