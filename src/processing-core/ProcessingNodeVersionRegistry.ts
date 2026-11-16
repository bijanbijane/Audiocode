import { ProcessingNodeSpec } from './ProcessingGraphEngine';

export interface NodeParameterMigrationStep {
  readonly nodeType: ProcessingNodeSpec['type'];
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly migrateParameters: (
    oldParams: Record<string, number | string | boolean>,
  ) => Record<string, number | string | boolean>;
}

/**
 * Processing Graph Node Version Registry & Parameter Migration Engine
 * (Architecture Doc Sections 21 & 28)
 * Guarantees backward compatibility for saved projects when individual processing
 * nodes (e.g., COMPRESSOR, AI_DENOISER) evolve across major/minor parameter schemas.
 */
export class ProcessingNodeVersionRegistry {
  private readonly latestNodeVersions = new Map<ProcessingNodeSpec['type'], string>([
    ['TRACK_SOURCE', '1.0.0'],
    ['EQ_FILTER', '1.1.0'],
    ['COMPRESSOR', '1.2.0'],
    ['NOISE_GATE', '1.0.0'],
    ['AI_DENOISER', '1.1.0'],
    ['DE_REVERB', '1.0.0'],
    ['BUS_MIXER', '1.0.0'],
    ['MASTER_LIMITER', '1.0.0'],
  ]);

  private readonly migrations: NodeParameterMigrationStep[] = [
    {
      nodeType: 'COMPRESSOR',
      fromVersion: '1.0.0',
      toVersion: '1.2.0',
      migrateParameters: (old) => ({
        ...old,
        thresholdDb: typeof old.thresholdDb === 'number' ? old.thresholdDb : -18.0,
        ratio: typeof old.ratio === 'number' ? old.ratio : 3.0,
        lookaheadMs: typeof old.lookaheadMs === 'number' ? old.lookaheadMs : 5.0,
      }),
    },
    {
      nodeType: 'AI_DENOISER',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      migrateParameters: (old) => {
        const oldPct = typeof old.strengthPercent === 'number' ? old.strengthPercent : 85;
        return {
          reductionStrength: Number((oldPct / 100).toFixed(2)),
          preservePersianFricatives: true,
        };
      },
    },
  ];

  /**
   * Non-destructively upgrades older processing graph nodes to the latest catalog versions.
   */
  public upgradeGraphNodesToLatest(nodes: readonly ProcessingNodeSpec[]): {
    upgradedNodes: ProcessingNodeSpec[];
    migratedNodeIds: string[];
  } {
    const migratedNodeIds: string[] = [];

    const upgradedNodes = nodes.map((node) => {
      const targetLatest = this.latestNodeVersions.get(node.type) ?? node.version;
      if (node.version === targetLatest) return node;

      let currentVer = node.version;
      let currentParams = { ...node.committedParameters };

      let safetyCounter = 0;
      while (currentVer !== targetLatest && safetyCounter < 10) {
        safetyCounter++;
        const step = this.migrations.find(
          (m) => m.nodeType === node.type && m.fromVersion === currentVer,
        );
        if (!step) break;

        currentParams = step.migrateParameters(currentParams);
        currentVer = step.toVersion;
      }

      if (currentVer !== node.version) {
        migratedNodeIds.push(node.id);
      }

      return {
        ...node,
        version: currentVer,
        committedParameters: currentParams,
      };
    });

    return { upgradedNodes, migratedNodeIds };
  }
}
