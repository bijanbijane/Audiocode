import test from 'node:test';
import assert from 'node:assert/strict';
import { ParallelChunkRenderCoordinator } from './ParallelChunkRenderCoordinator';
import { ProcessingGraphEngine } from './ProcessingGraphEngine';

test('Section 96: ParallelChunkRenderCoordinator dispatches chunks concurrently and flushes strictly in ascending order (0, 1, 2, 3)', async () => {
  const graphEngine = new ProcessingGraphEngine();
  const plan = graphEngine.compileGraph(
    [
      {
        id: 'n1',
        type: 'EQ_FILTER',
        version: '1.0.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 480,
        tailSamples: 0,
        committedParameters: {},
      },
    ],
    [],
    48000,
    ['asset_1'],
  );

  const coordinator = new ParallelChunkRenderCoordinator(graphEngine);
  const flushedOrder: number[] = [];

  const res = await coordinator.executeParallelStreamingRender({
    totalTimelineSamples: 48000 * 4, // 4 seconds -> 4 chunks of 1 second
    sampleRate: 48000,
    compiledPlan: plan,
    chunkDurationSeconds: 1,
    maxConcurrentWorkers: 3,
    renderChunkOnWorkerFn: async (task) => {
      // Complete odd chunks faster than even chunks to test out-of-order completion handling
      const delayMs = task.chunkIndex % 2 === 1 ? 2 : 12;
      await new Promise((r) => setTimeout(r, delayMs));
      const len = task.validTargetEndSample - task.validTargetStartSample;
      return [new Float32Array(len)];
    },
    flushOrderedChunkToEncoderFn: async (chunkIdx) => {
      flushedOrder.push(chunkIdx);
    },
  });

  assert.deepEqual(flushedOrder, [0, 1, 2, 3]);
  assert.equal(res.totalSamplesRendered, 48000 * 4);
});
