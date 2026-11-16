import { SampleIndex, SampleRate } from '../contracts/timebase.contract';

export type NodeId = string;

export interface ProcessingNodeSpec {
  readonly id: NodeId;
  readonly type:
    | 'TRACK_SOURCE'
    | 'EQ_FILTER'
    | 'COMPRESSOR'
    | 'NOISE_GATE'
    | 'AI_DENOISER'
    | 'DE_REVERB'
    | 'BUS_MIXER'
    | 'MASTER_LIMITER';
  readonly version: string;
  readonly enabled: boolean;
  /** Inherent algorithmic latency in samples (e.g., Lookahead limiter or FFT denoiser frame) */
  readonly latencySamples: SampleIndex;
  /** Required priming audio ahead of target start to stabilize filter/envelope state */
  readonly preRollSamples: SampleIndex;
  /** Trailing decay tail after input ends */
  readonly tailSamples: SampleIndex;
  readonly committedParameters: Record<string, number | string | boolean>;
}

export interface GraphEdge {
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId;
}

export interface DelayCompensationInsertion {
  readonly edge: GraphEdge;
  /** Compensation delay samples inserted on this branch before merging into a bus */
  readonly compensationDelaySamples: SampleIndex;
}

export interface CompiledRenderPlan {
  readonly topologicalOrder: NodeId[];
  readonly totalGraphLatencySamples: SampleIndex;
  readonly requiredPreRollSamples: SampleIndex;
  readonly requiredTailSamples: SampleIndex;
  readonly pdcInsertions: DelayCompensationInsertion[];
  readonly deterministicCacheKey: string;
}

/**
 * Processing Graph Compiler (Architecture Doc Sections 28-34)
 * - Topological Sort + Cycle Detection (Kahn's DAG Algorithm)
 * - Automatic Plugin Delay Compensation (PDC) on multi-input nodes
 * - Pre-Roll State Priming & Deterministic FNV-1a Cache Key
 */
export class ProcessingGraphEngine {
  public compileGraph(
    nodes: ProcessingNodeSpec[],
    edges: GraphEdge[],
    sampleRate: SampleRate,
    inputAssetHashes: string[],
  ): CompiledRenderPlan {
    const nodeMap = new Map<NodeId, ProcessingNodeSpec>();
    for (const n of nodes) nodeMap.set(n.id, n);

    const inDegree = new Map<NodeId, number>();
    const adj = new Map<NodeId, NodeId[]>();
    const incomingEdges = new Map<NodeId, GraphEdge[]>();

    for (const n of nodes) {
      inDegree.set(n.id, 0);
      adj.set(n.id, []);
      incomingEdges.set(n.id, []);
    }

    for (const edge of edges) {
      if (!nodeMap.has(edge.fromNodeId) || !nodeMap.has(edge.toNodeId)) {
        throw new Error(`INVALID_GRAPH_EDGE: ${edge.fromNodeId} -> ${edge.toNodeId}`);
      }
      adj.get(edge.fromNodeId)!.push(edge.toNodeId);
      incomingEdges.get(edge.toNodeId)!.push(edge);
      inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) ?? 0) + 1);
    }

    const queue: NodeId[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const topologicalOrder: NodeId[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      topologicalOrder.push(current);

      for (const neighbor of adj.get(current)!) {
        const nextDeg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, nextDeg);
        if (nextDeg === 0) queue.push(neighbor);
      }
    }

    if (topologicalOrder.length !== nodes.length) {
      throw new Error(
        'PROCESSING_GRAPH_CYCLE_DETECTED: چرخه غیرمجاز در گراف پردازش صوت شناسایی شد.',
      );
    }

    const cumulativeArrivalLatency = new Map<NodeId, SampleIndex>();
    const cumulativeDepartureLatency = new Map<NodeId, SampleIndex>();
    const pdcInsertions: DelayCompensationInsertion[] = [];

    let totalPreRoll = 0;
    let maxTail = 0;

    for (const nodeId of topologicalOrder) {
      const node = nodeMap.get(nodeId)!;
      const inEdges = incomingEdges.get(nodeId)!;

      let maxIncomingLatency = 0;
      for (const e of inEdges) {
        const depLat = cumulativeDepartureLatency.get(e.fromNodeId) ?? 0;
        if (depLat > maxIncomingLatency) maxIncomingLatency = depLat;
      }

      if (inEdges.length > 1) {
        for (const e of inEdges) {
          const branchLat = cumulativeDepartureLatency.get(e.fromNodeId) ?? 0;
          const diff = maxIncomingLatency - branchLat;
          if (diff > 0) {
            pdcInsertions.push({
              edge: e,
              compensationDelaySamples: diff,
            });
          }
        }
      }

      cumulativeArrivalLatency.set(nodeId, maxIncomingLatency);
      const selfLatency = node.enabled ? node.latencySamples : 0;
      cumulativeDepartureLatency.set(nodeId, maxIncomingLatency + selfLatency);

      if (node.enabled) {
        totalPreRoll += node.preRollSamples;
        if (node.tailSamples > maxTail) maxTail = node.tailSamples;
      }
    }

    const totalGraphLatencySamples =
      cumulativeDepartureLatency.size > 0
        ? Math.max(0, ...Array.from(cumulativeDepartureLatency.values()))
        : 0;

    const deterministicCacheKey = this.computeGraphCacheKey(
      topologicalOrder.map((id) => nodeMap.get(id)!),
      edges,
      sampleRate,
      inputAssetHashes,
    );

    return {
      topologicalOrder,
      totalGraphLatencySamples,
      requiredPreRollSamples: totalPreRoll,
      requiredTailSamples: maxTail,
      pdcInsertions,
      deterministicCacheKey,
    };
  }

  public computeChunkFeedWindow(
    targetChunkStartSample: SampleIndex,
    targetChunkEndSample: SampleIndex,
    plan: CompiledRenderPlan,
  ): {
    diskReadStartSample: SampleIndex;
    diskReadEndSample: SampleIndex;
    discardOutputPrefixSamples: SampleIndex;
  } {
    const diskReadStartSample = Math.max(0, targetChunkStartSample - plan.requiredPreRollSamples);
    const actualPreRollFed = targetChunkStartSample - diskReadStartSample;

    return {
      diskReadStartSample,
      diskReadEndSample: targetChunkEndSample,
      discardOutputPrefixSamples: actualPreRollFed + plan.totalGraphLatencySamples,
    };
  }

  private computeGraphCacheKey(
    orderedNodes: ProcessingNodeSpec[],
    edges: GraphEdge[],
    sampleRate: SampleRate,
    inputAssetHashes: string[],
  ): string {
    const payload = JSON.stringify({
      assets: inputAssetHashes,
      rate: sampleRate,
      nodes: orderedNodes.map((n) => ({
        id: n.id,
        type: n.type,
        v: n.version,
        en: n.enabled,
        p: n.committedParameters,
      })),
      edges,
    });

    let hash = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
      hash ^= payload.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `graph_cache_${(hash >>> 0).toString(16)}`;
  }
}
