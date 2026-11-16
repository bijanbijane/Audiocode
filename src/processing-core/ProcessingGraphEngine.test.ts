import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessingGraphEngine, ProcessingNodeSpec } from './ProcessingGraphEngine';

function makeParallelNodes(compEnabled = true): ProcessingNodeSpec[] {
  return [
    {
      id: 'src',
      type: 'TRACK_SOURCE',
      version: '1.0',
      enabled: true,
      latencySamples: 0,
      preRollSamples: 0,
      tailSamples: 0,
      committedParameters: {},
    },
    {
      id: 'denoiser',
      type: 'AI_DENOISER',
      version: '1.0',
      enabled: compEnabled,
      latencySamples: 2048,
      preRollSamples: 4096,
      tailSamples: 512,
      committedParameters: { strength: 0.7 },
    },
    {
      id: 'dry-bus',
      type: 'EQ_FILTER',
      version: '1.0',
      enabled: true,
      latencySamples: 64,
      preRollSamples: 1024,
      tailSamples: 128,
      committedParameters: { highPassHz: 80 },
    },
    {
      id: 'mixer',
      type: 'BUS_MIXER',
      version: '1.0',
      enabled: true,
      latencySamples: 0,
      preRollSamples: 0,
      tailSamples: 0,
      committedParameters: {},
    },
    {
      id: 'limiter',
      type: 'MASTER_LIMITER',
      version: '1.0',
      enabled: true,
      latencySamples: 128,
      preRollSamples: 2400,
      tailSamples: 512,
      committedParameters: { ceilingDb: -1 },
    },
  ];
}

test('ProcessingGraphEngine computes exact Automatic PDC insertions and Pre-Roll feed window', () => {
  const engine = new ProcessingGraphEngine();
  const nodes = makeParallelNodes(true);
  const edges = [
    { fromNodeId: 'src', toNodeId: 'denoiser' },
    { fromNodeId: 'src', toNodeId: 'dry-bus' },
    { fromNodeId: 'denoiser', toNodeId: 'mixer' },
    { fromNodeId: 'dry-bus', toNodeId: 'mixer' },
    { fromNodeId: 'mixer', toNodeId: 'limiter' },
  ];

  const plan = engine.compileGraph(nodes, edges, 48000, ['hash-a']);

  // Total latency = max(2048, 64) + 128 = 2176 samples
  assert.equal(plan.totalGraphLatencySamples, 2176);
  // Pre-Roll sum = 4096 + 1024 + 2400 = 7520 samples
  assert.equal(plan.requiredPreRollSamples, 7520);
  // Dry branch (64) entering mixer must get +1984 sample delay compensation vs denoiser (2048)
  assert.equal(plan.pdcInsertions.length, 1);
  assert.equal(plan.pdcInsertions[0].edge.fromNodeId, 'dry-bus');
  assert.equal(plan.pdcInsertions[0].compensationDelaySamples, 2048 - 64);

  const feed = engine.computeChunkFeedWindow(48000, 96000, plan);
  assert.equal(feed.diskReadStartSample, 48000 - 7520);
  assert.equal(feed.discardOutputPrefixSamples, 7520 + 2176);
});

test('ProcessingGraphEngine detects cyclic routing errors', () => {
  const engine = new ProcessingGraphEngine();
  const nodes = makeParallelNodes(true);
  const cyclicEdges = [
    { fromNodeId: 'src', toNodeId: 'denoiser' },
    { fromNodeId: 'denoiser', toNodeId: 'mixer' },
    { fromNodeId: 'mixer', toNodeId: 'denoiser' },
  ];

  assert.throws(
    () => engine.compileGraph(nodes, cyclicEdges, 48000, ['hash-a']),
    /PROCESSING_GRAPH_CYCLE_DETECTED/,
  );
});

test('ProcessingGraphEngine produces deterministic cache key sensitive to committed parameters', () => {
  const engine = new ProcessingGraphEngine();
  const nodesA = makeParallelNodes(true);
  const nodesB = makeParallelNodes(true);
  nodesB[1] = { ...nodesB[1], committedParameters: { strength: 0.9 } };

  const edges = [
    { fromNodeId: 'src', toNodeId: 'denoiser' },
    { fromNodeId: 'denoiser', toNodeId: 'mixer' },
  ];

  const planA1 = engine.compileGraph(nodesA, edges, 48000, ['hash-a']);
  const planA2 = engine.compileGraph(nodesA, edges, 48000, ['hash-a']);
  const planB = engine.compileGraph(nodesB, edges, 48000, ['hash-a']);

  assert.equal(planA1.deterministicCacheKey, planA2.deterministicCacheKey);
  assert.notEqual(planA1.deterministicCacheKey, planB.deterministicCacheKey);
});
