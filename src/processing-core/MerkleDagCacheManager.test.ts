import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MerkleDagCacheManager } from './MerkleDagCacheManager';
import { GraphEdge, ProcessingNodeSpec } from './ProcessingGraphEngine';

describe('MerkleDagCacheManager (Section 32)', () => {
  const createFiveNodeChain = (eqGainDb: number): {
    order: string[];
    nodes: ProcessingNodeSpec[];
    edges: GraphEdge[];
  } => ({
    order: ['n1_source', 'n2_denoiser', 'n3_dereverb', 'n4_eq', 'n5_limiter'],
    nodes: [
      {
        id: 'n1_source',
        type: 'TRACK_SOURCE',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: { trackId: 'trk_1' },
      },
      {
        id: 'n2_denoiser',
        type: 'AI_DENOISER',
        version: '1.2',
        enabled: true,
        latencySamples: 512,
        preRollSamples: 1024,
        tailSamples: 512,
        committedParameters: { suppressionStrength: 0.85 },
      },
      {
        id: 'n3_dereverb',
        type: 'DE_REVERB',
        version: '1.1',
        enabled: true,
        latencySamples: 256,
        preRollSamples: 2048,
        tailSamples: 1024,
        committedParameters: { rt60TargetSec: 0.25 },
      },
      {
        id: 'n4_eq',
        type: 'EQ_FILTER',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 128,
        tailSamples: 0,
        committedParameters: { freqHz: 2500, gainDb: eqGainDb },
      },
      {
        id: 'n5_limiter',
        type: 'MASTER_LIMITER',
        version: '1.0',
        enabled: true,
        latencySamples: 64,
        preRollSamples: 128,
        tailSamples: 64,
        committedParameters: { ceilingDbtp: -1.0 },
      },
    ],
    edges: [
      { fromNodeId: 'n1_source', toNodeId: 'n2_denoiser' },
      { fromNodeId: 'n2_denoiser', toNodeId: 'n3_dereverb' },
      { fromNodeId: 'n3_dereverb', toNodeId: 'n4_eq' },
      { fromNodeId: 'n4_eq', toNodeId: 'n5_limiter' },
    ],
  });

  it('preserves upstream cache hits (n1..n3) and invalidates only n4_eq and n5_limiter when n4_eq changes', () => {
    const cache = new MerkleDagCacheManager<string>();
    const initialGraph = createFiveNodeChain(2.0);

    const hashesBefore = cache.computePerNodeMerkleHashes({
      topologicalOrder: initialGraph.order,
      nodes: initialGraph.nodes,
      edges: initialGraph.edges,
      sampleRate: 48000,
      channelCount: 2,
      runtimeBackend: 'WASM_SIMD',
      sourceAssetContentHashes: ['sha256_asset_a'],
    });

    for (const [nodeId, hash] of hashesBefore.entries()) {
      cache.putNodeArtifact(nodeId, hash, `cached_${nodeId}`, 1024);
    }

    // Mutate only node 4 (EQ gain from +2.0dB to -3.5dB)
    const mutatedGraph = createFiveNodeChain(-3.5);
    const hashesAfter = cache.computePerNodeMerkleHashes({
      topologicalOrder: mutatedGraph.order,
      nodes: mutatedGraph.nodes,
      edges: mutatedGraph.edges,
      sampleRate: 48000,
      channelCount: 2,
      runtimeBackend: 'WASM_SIMD',
      sourceAssetContentHashes: ['sha256_asset_a'],
    });

    const status = cache.resolveGraphCacheStatus(hashesAfter);
    assert.deepEqual(status.hitNodeIds, ['n1_source', 'n2_denoiser', 'n3_dereverb']);
    assert.deepEqual(status.missInvalidatedNodeIds, ['n4_eq', 'n5_limiter']);

    // Evict stale Merkle entries (old n4_eq and n5_limiter)
    const evicted = cache.evictUnreferencedMerkleEntries(new Set(hashesAfter.values()));
    assert.equal(evicted, 2);
  });
});
