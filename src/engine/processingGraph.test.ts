import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultStudioGraph,
  planProcessingGraphPdc,
  processChunkWithPreRoll,
} from './processingGraph';
import { EphemeralDspParams, ProcessingGraphEdge } from '../contracts/v1_2';

test('Automatic PDC calculates exact delay compensation for faster parallel branches', () => {
  const { nodes, edges } = createDefaultStudioGraph();
  const plan = planProcessingGraphPdc(nodes, edges);

  assert.equal(plan.isValidDag, true);
  // Path 1: src(0) -> eq(64) -> comp(512) = 576 samples
  // Path 2: src(0) -> parallel-dry(32) = 32 samples
  // Master Bus receives both -> parallel-dry needs 576 - 32 = 544 samples of delay compensation!
  const dryComp = plan.branchCompensations.find((b) => b.branchRootNodeId === 'branch-parallel-dry');
  assert.ok(dryComp !== undefined);
  assert.equal(dryComp.insertedDelaySamples, 544);
  assert.equal(plan.totalGraphLatencySamples, 576 + 128); // +128 master limiter
});

test('DAG validator detects circular routing cycles', () => {
  const { nodes, edges } = createDefaultStudioGraph();
  const cyclicEdges: ProcessingGraphEdge[] = [
    ...edges,
    { fromNodeId: 'bus-master', toNodeId: 'branch-eq' },
  ];
  const plan = planProcessingGraphPdc(nodes, cyclicEdges);
  assert.equal(plan.isValidDag, false);
});

test('Pre-Roll priming prevents initial gain transient jump compared to zero-state start', () => {
  const sampleRate = 48_000;
  const preRollSamples = 4800; // 100ms
  const chunkSamples = 2400; // 50ms
  const fullSignal = new Float32Array(preRollSamples + chunkSamples);
  for (let i = 0; i < fullSignal.length; i++) {
    fullSignal[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }

  const params: EphemeralDspParams = {
    highPassHz: 90,
    compressorThresholdDb: -18,
    compressorRatio: 4,
    noiseGateThresholdDb: -50,
    masterGainDb: 0,
  };

  // Primed chunk: feed preRoll + chunk, slice output after preRoll
  const primedOut = processChunkWithPreRoll(fullSignal, preRollSamples, sampleRate, params);
  assert.equal(primedOut.length, chunkSamples);

  // Unprimed chunk: feed only chunk with 0 preRoll -> initial envelope starts at 0 so first sample is uncompressed!
  const rawChunk = fullSignal.slice(preRollSamples);
  const unprimedOut = processChunkWithPreRoll(rawChunk, 0, sampleRate, params);

  // Primed compressor already settled into steady gain reduction at sample 0..20, unlike unprimed
  const peakPrimedStart = Math.max(...Array.from(primedOut.slice(0, 100)).map(Math.abs));
  const peakUnprimedStart = Math.max(...Array.from(unprimedOut.slice(0, 100)).map(Math.abs));
  assert.ok(peakPrimedStart < peakUnprimedStart);
});
