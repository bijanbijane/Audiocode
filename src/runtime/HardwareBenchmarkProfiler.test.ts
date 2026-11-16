import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareBenchmarkProfiler } from './HardwareBenchmarkProfiler';

test('HardwareBenchmarkProfiler calibrates empirical GFLOPS, throughput, and RTF limits honestly', async () => {
  const cpuProfile = await HardwareBenchmarkProfiler.runEmpiricalCalibration('DESKTOP_STUDIO', 'WASM_SIMD');
  const gpuProfile = await HardwareBenchmarkProfiler.runEmpiricalCalibration('DESKTOP_STUDIO', 'WEBGPU');

  assert.ok(cpuProfile.cpuComputeGflops > 0 && Number.isFinite(cpuProfile.cpuComputeGflops));
  assert.ok(cpuProfile.opfsSequentialWriteMbPerSec > 0);
  assert.equal(cpuProfile.storageBenchmarkSource, 'MEMORY_BANDWIDTH_FALLBACK');
  assert.equal(cpuProfile.maxSafeFileDurationMinutes, 240);
  assert.ok(cpuProfile.estimatedAsrRealTimeFactor >= 0.01);
  assert.ok(gpuProfile.estimatedAsrRealTimeFactor <= cpuProfile.estimatedAsrRealTimeFactor);
});

test('estimateJobProcessingDuration scales task factors and flags mobile duration ceilings', async () => {
  const mobileProfile = await HardwareBenchmarkProfiler.runEmpiricalCalibration('MOBILE_COMPANION', 'WASM_SIMD');
  assert.equal(mobileProfile.maxSafeFileDurationMinutes, 35);

  const asrEta = HardwareBenchmarkProfiler.estimateJobProcessingDuration(1800, mobileProfile, 'GROUP_B_PERSIAN_ASR');
  const vadEta = HardwareBenchmarkProfiler.estimateJobProcessingDuration(1800, mobileProfile, 'GROUP_A_VAD_DSP');
  const exportEta = HardwareBenchmarkProfiler.estimateJobProcessingDuration(1800, mobileProfile, 'EXPORT_RENDER');

  assert.equal(asrEta.exceedsDeviceSafeDuration, false);
  assert.ok(vadEta.estimatedSeconds <= asrEta.estimatedSeconds);
  assert.ok(exportEta.estimatedSeconds <= asrEta.estimatedSeconds);
  assert.ok(asrEta.humanReadableEstimateFa.includes('حدود'));

  const longFile = HardwareBenchmarkProfiler.estimateJobProcessingDuration(3600, mobileProfile, 'GROUP_B_PERSIAN_ASR');
  assert.equal(longFile.exceedsDeviceSafeDuration, true);
});
