import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGpuAcceleratedKernelRunner } from './WebGpuAcceleratedKernelRunner';

test('Section 93: WebGpuAcceleratedKernelRunner computes Hann-windowed RMS via CPU fallback when WebGPU is unavailable', async () => {
  const runner = new WebGpuAcceleratedKernelRunner();
  const initialized = await runner.initAsync();
  assert.equal(initialized, false);

  const pcm = new Float32Array(16000);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }

  const res = await runner.computeWindowedRmsWithSlicedDispatch(pcm, 400, 160);
  assert.equal(res.executedOn, 'CPU_FALLBACK');
  assert.equal(res.rmsPerFrame.length, 98);
  assert.ok(res.rmsPerFrame[10] > 0.1);
});
