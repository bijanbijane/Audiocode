import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessingNodeVersionRegistry } from './ProcessingNodeVersionRegistry';
import { ProcessingNodeSpec } from './ProcessingGraphEngine';

describe('ProcessingNodeVersionRegistry (Sections 21 & 28)', () => {
  it('migrates legacy AI_DENOISER v1.0.0 and COMPRESSOR v1.0.0 parameters to latest versions', () => {
    const registry = new ProcessingNodeVersionRegistry();
    const legacyNodes: ProcessingNodeSpec[] = [
      {
        id: 'node_denoise_old',
        type: 'AI_DENOISER',
        version: '1.0.0',
        enabled: true,
        latencySamples: 512,
        preRollSamples: 1024,
        tailSamples: 512,
        committedParameters: { strengthPercent: 80 },
      },
      {
        id: 'node_comp_old',
        type: 'COMPRESSOR',
        version: '1.0.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 256,
        tailSamples: 0,
        committedParameters: { thresholdDb: -20.0 },
      },
    ];

    const { upgradedNodes, migratedNodeIds } = registry.upgradeGraphNodesToLatest(legacyNodes);
    assert.deepEqual(migratedNodeIds, ['node_denoise_old', 'node_comp_old']);

    assert.equal(upgradedNodes[0].version, '1.1.0');
    assert.equal(upgradedNodes[0].committedParameters.reductionStrength, 0.8);
    assert.equal(upgradedNodes[0].committedParameters.preservePersianFricatives, true);

    assert.equal(upgradedNodes[1].version, '1.2.0');
    assert.equal(upgradedNodes[1].committedParameters.thresholdDb, -20.0);
    assert.equal(upgradedNodes[1].committedParameters.lookaheadMs, 5.0);
  });
});
