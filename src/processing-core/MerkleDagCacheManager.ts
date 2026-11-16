import { SampleRate } from '../contracts/timebase.contract';
import { GraphEdge, NodeId, ProcessingNodeSpec } from './ProcessingGraphEngine';

export interface CachedNodeArtifact<TData = Float32Array[]> {
  readonly nodeId: NodeId;
  readonly nodeMerkleHash: string;
  readonly createdAtMs: number;
  readonly byteSize: number;
  readonly data: TData;
}

/**
 * Merkle-DAG Processing Cache Manager with Selective Downstream Subgraph Invalidation
 * (Architecture Doc Section 7 Domain 5 & Section 32)
 * Computes per-node Merkle hashes from parent node hashes + deterministic node parameters,
 * ensuring upstream heavy AI nodes (e.g., AI_DENOISER, DE_REVERB) remain CACHE_HIT when
 * downstream nodes (e.g., EQ_FILTER, MASTER_LIMITER) are tweaked, and guaranteeing that
 * renaming the project never invalidates any processing cache.
 */
export class MerkleDagCacheManager<TData = Float32Array[]> {
  private readonly store = new Map<string, CachedNodeArtifact<TData>>();

  /**
   * 1. Computes per-node Merkle hashes in topological order.
   * Project name is strictly excluded from hash computation (Section 32 rule).
   */
  public computePerNodeMerkleHashes(params: {
    topologicalOrder: readonly NodeId[];
    nodes: readonly ProcessingNodeSpec[];
    edges: readonly GraphEdge[];
    sampleRate: SampleRate;
    channelCount: number;
    runtimeBackend: string;
    sourceAssetContentHashes: readonly string[];
  }): Map<NodeId, string> {
    const nodeMap = new Map<NodeId, ProcessingNodeSpec>(
      params.nodes.map((n) => [n.id, n]),
    );
    const incomingParents = new Map<NodeId, NodeId[]>();
    for (const n of params.nodes) incomingParents.set(n.id, []);
    for (const e of params.edges) {
      incomingParents.get(e.toNodeId)?.push(e.fromNodeId);
    }

    const merkleHashes = new Map<NodeId, string>();
    const sortedAssetsKey = [...params.sourceAssetContentHashes].sort().join('|');

    for (const nodeId of params.topologicalOrder) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const parentIds = (incomingParents.get(nodeId) ?? []).sort();
      const parentMerkleSignatures = parentIds.map(
        (pid) => `${pid}:${merkleHashes.get(pid) ?? 'root'}`,
      );

      // If a single-input node is bypassed, it inherits its parent's Merkle hash directly
      if (!node.enabled && parentIds.length === 1) {
        merkleHashes.set(nodeId, merkleHashes.get(parentIds[0])!);
        continue;
      }

      const canonicalNodePayload = JSON.stringify({
        parents: parentMerkleSignatures.length > 0 ? parentMerkleSignatures : [sortedAssetsKey],
        type: node.type,
        ver: node.version,
        enabled: node.enabled,
        sr: params.sampleRate,
        ch: params.channelCount,
        rt: params.runtimeBackend,
        params: this.sortObjectKeysDeterministically(node.committedParameters),
      });

      merkleHashes.set(nodeId, this.fnv1a64Hex(canonicalNodePayload));
    }

    return merkleHashes;
  }

  /**
   * 2. Partitions graph nodes into CACHE_HIT vs CACHE_MISS_INVALIDATED based on stored Merkle hashes.
   */
  public resolveGraphCacheStatus(
    nodeMerkleHashes: ReadonlyMap<NodeId, string>,
  ): {
    hitNodeIds: NodeId[];
    missInvalidatedNodeIds: NodeId[];
  } {
    const hitNodeIds: NodeId[] = [];
    const missInvalidatedNodeIds: NodeId[] = [];

    for (const [nodeId, merkleHash] of nodeMerkleHashes.entries()) {
      if (this.store.has(merkleHash)) {
        hitNodeIds.push(nodeId);
      } else {
        missInvalidatedNodeIds.push(nodeId);
      }
    }

    return { hitNodeIds, missInvalidatedNodeIds };
  }

  public putNodeArtifact(
    nodeId: NodeId,
    nodeMerkleHash: string,
    data: TData,
    byteSize: number,
  ): void {
    this.store.set(nodeMerkleHash, {
      nodeId,
      nodeMerkleHash,
      createdAtMs: Date.now(),
      byteSize,
      data,
    });
  }

  public getNodeArtifact(nodeMerkleHash: string): CachedNodeArtifact<TData> | undefined {
    return this.store.get(nodeMerkleHash);
  }

  /**
   * 3. Evicts unreferenced Merkle cache entries not present in the active set.
   */
  public evictUnreferencedMerkleEntries(activeMerkleHashes: Set<string>): number {
    let evictedCount = 0;
    for (const key of this.store.keys()) {
      if (!activeMerkleHashes.has(key)) {
        this.store.delete(key);
        evictedCount++;
      }
    }
    return evictedCount;
  }

  private sortObjectKeysDeterministically(
    obj: Record<string, number | string | boolean>,
  ): Record<string, number | string | boolean> {
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, number | string | boolean> = {};
    for (const k of sortedKeys) {
      out[k] = obj[k];
    }
    return out;
  }

  private fnv1a64Hex(str: string): string {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `mkl_${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
  }
}
