/**
 * SHAHAB SHARED CORE — Authoritative Transducer Decoder & Persian Text Canonicalizer
 *
 * Host-independent, zero-Node-fs core decoding algorithms:
 * 1. Canonical BPE token filtering (consistently excludes <blk>, <sos/eos>, <unk> across rawText & tokens).
 * 2. Batched Modified Beam Search with Parent-Pointer Prefix Trie:
 *    - Eliminates O(T * B * L) token array cloning & `tokens.join(',')` string keys.
 *    - Batches all K unique active contexts at frame t into ONE joiner([K, dim]) call
 *      and all cache-miss contexts into ONE decoder([M, 2]) call.
 *    - Reuses pre-allocated logSoftmax scratchpad buffers (zero per-frame per-beam allocations).
 * 3. Dynamic frame-stride validation against encoder output length and audio duration.
 * 4. Single authoritative Persian canonical normalization (`normalizeCanonicalPersianUtterance`)
 *    shared identically by single-chunk server execution and multi-chunk client stitching.
 */

import { normalizeCanonicalPersianUtterance } from './ShahabCorePersianNormalizer';

export { normalizeCanonicalPersianUtterance };

const SPECIAL_BPE_PIECES = new Set(['<blk>', '<sos/eos>', '<unk>', '<pad>', '<s>', '</s>']);

export function isSpecialBpeToken(id: number, piece: string | undefined): boolean {
  if (id <= 0 || !piece) return true;
  return SPECIAL_BPE_PIECES.has(piece);
}

/**
 * Canonical BPE-to-text reconstruction matching `projectBpeEmissionsToTimedWords`:
 * filters `<blk>`, `<sos/eos>`, and `<unk>` identically so `rawText` and `tokens` never diverge.
 */
export function decodeBpeTokenIdsCanonical(
  tokenIds: readonly number[],
  vocab: readonly string[],
): string {
  let text = '';
  for (let i = 0; i < tokenIds.length; i++) {
    const id = tokenIds[i];
    if (id <= 0 || id >= vocab.length) continue;
    const piece = vocab[id];
    if (isSpecialBpeToken(id, piece)) continue;
    text += piece;
  }
  return text.replace(/▁/g, ' ').replace(/\s+/g, ' ').trim();
}



/**
 * Computes validated frame stride in seconds.
 * Defaults to nominal `subsamplingFactor * frameShiftSec` (e.g. 4 * 0.01 = 0.04s),
 * while guarding against mismatched encoder subsampling if audioDurationSec is provided.
 */
export function resolveValidatedFrameStrideSec(params: {
  readonly nominalFrameStrideSec?: number;
  readonly numFrames: number;
  readonly audioDurationSec?: number;
}): number {
  const nominal =
    typeof params.nominalFrameStrideSec === 'number' &&
    Number.isFinite(params.nominalFrameStrideSec) &&
    params.nominalFrameStrideSec > 0
      ? params.nominalFrameStrideSec
      : 0.04;

  if (
    typeof params.audioDurationSec === 'number' &&
    Number.isFinite(params.audioDurationSec) &&
    params.audioDurationSec > 0.5 &&
    params.numFrames > 10
  ) {
    // Allow generous tolerance for 0.6s tail padding; only adapt if actual stride differs > 25%
    // (indicating a different subsampling model such as 8x FastConformer vs 4x Zipformer).
    const implied = params.audioDurationSec / params.numFrames;
    if (implied > 0.005 && implied < 0.25 && Math.abs(implied - nominal) / nominal > 0.35) {
      return Number(implied.toFixed(6));
    }
  }
  return nominal;
}

interface TrieNode {
  readonly nodeId: number;
  readonly parent: TrieNode | null;
  readonly tokenId: number;
  readonly c0: number;
  readonly c1: number;
  frameTsSec: number;
  children: Map<number, TrieNode> | null;
}

function logAddExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
}

function logSoftmaxInto(logits: Float32Array, dst: Float32Array): void {
  const len = logits.length;
  let maxVal = -Infinity;
  for (let i = 0; i < len; i++) {
    const v = logits[i];
    if (v > maxVal) maxVal = v;
  }
  let sumExp = 0;
  for (let i = 0; i < len; i++) {
    sumExp += Math.exp(logits[i] - maxVal);
  }
  const logSum = maxVal + Math.log(sumExp);
  for (let i = 0; i < len; i++) {
    dst[i] = logits[i] - logSum;
  }
}

export interface BatchedTransducerDecodeResult {
  readonly rawText: string;
  readonly tokenIds: readonly number[];
  readonly tokenTimestampsSec: readonly number[];
  readonly logProbSum: number;
  readonly decoderBatchInvocations: number;
  readonly joinerBatchInvocations: number;
  readonly totalDecoderJoinerInvocations: number;
  readonly frameStrideSec: number;
}

export interface BatchedTransducerCallbacks {
  readonly runDecoderBatch: (
    contexts: readonly (readonly [number, number])[],
  ) => Promise<readonly Float32Array[]>;
  readonly runJoinerBatch: (
    frameIdx: number,
    decoderVectors: readonly Float32Array[],
  ) => Promise<readonly Float32Array[]>;
}

/**
 * Batched Modified Beam Search with Parent-Pointer Prefix Trie and Scratchpad Reuse.
 *
 * Complexity & allocation improvements over per-beam unbatched JS loop:
 * - Joiner runtime invocations drop from O(T * K) to O(T) (1 batched [K, dim] call per frame).
 * - Decoder cache misses at frame t are batched into 1 batched [M, 2] call.
 * - Zero token-array cloning and zero `tokens.join(',')` string allocations (uses Trie `nodeId`).
 * - Pre-allocated `logProbScratch` buffers reused across all frames (no per-frame Float32Array GC churn).
 */
export async function runBatchedModifiedBeamSearch(params: {
  readonly numFrames: number;
  readonly vocab: readonly string[];
  readonly beamSize: number;
  readonly blankPenalty: number;
  readonly frameStrideSec: number;
  readonly biasMap?: ReadonlyMap<number, number> | null;
  readonly signal?: AbortSignal;
  readonly onCancelled?: () => Error;
  readonly callbacks: BatchedTransducerCallbacks;
}): Promise<BatchedTransducerDecodeResult> {
  const { numFrames, vocab, blankPenalty, frameStrideSec, biasMap, signal, callbacks } = params;
  const beamSize = Math.max(2, Math.min(12, Math.floor(params.beamSize)));
  const maxK = beamSize + 1;

  const decCache = new Map<number, Float32Array>();
  let decoderBatchInvocations = 0;
  let joinerBatchInvocations = 0;

  // Pack (c0, c1) into a single safe integer key (vocab <= 65536) — zero string allocation!
  const packCtxKey = (c0: number, c1: number): number => c0 * 65536 + c1;

  let nextNodeId = 1;
  const rootNode: TrieNode = {
    nodeId: 0,
    parent: null,
    tokenId: 0,
    c0: 0,
    c1: 0,
    frameTsSec: 0,
    children: null,
  };

  const getOrCreateChild = (parent: TrieNode, tokenId: number, frameTsSec: number): TrieNode => {
    if (!parent.children) {
      parent.children = new Map<number, TrieNode>();
    }
    const existing = parent.children.get(tokenId);
    if (existing) return existing;
    const created: TrieNode = {
      nodeId: nextNodeId++,
      parent,
      tokenId,
      c0: parent.c1,
      c1: tokenId,
      frameTsSec,
      children: null,
    };
    parent.children.set(tokenId, created);
    return created;
  };

  interface ActiveBeam {
    readonly node: TrieNode;
    score: number;
    bestArrivalScore: number;
  }

  let beams: ActiveBeam[] = [{ node: rootNode, score: 0, bestArrivalScore: 0 }];

  const topIds = new Int32Array(maxK);
  const topLps = new Float64Array(maxK);

  // Reusable scratchpad pool for logSoftmax (sized lazily on first joiner result)
  const scratchLogProbs: Float32Array[] = [];
  const nextMap = new Map<number, ActiveBeam>();
  const ctxKeyToSlot = new Map<number, number>();

  for (let t = 0; t < numFrames; t++) {
    if (signal?.aborted) {
      throw params.onCancelled?.() ?? new Error('JOB_CANCELLED');
    }

    // 1. Collect unique (c0, c1) contexts across active beams at frame t
    ctxKeyToSlot.clear();
    const uniqueContexts: [number, number][] = [];
    const uniqueCtxKeys: number[] = [];
    const missingDecoderContexts: [number, number][] = [];
    const missingDecoderKeys: number[] = [];

    for (let b = 0; b < beams.length; b++) {
      const node = beams[b].node;
      const ctxKey = packCtxKey(node.c0, node.c1);
      if (!ctxKeyToSlot.has(ctxKey)) {
        const slot = uniqueContexts.length;
        ctxKeyToSlot.set(ctxKey, slot);
        uniqueContexts.push([node.c0, node.c1]);
        uniqueCtxKeys.push(ctxKey);
        if (!decCache.has(ctxKey)) {
          missingDecoderContexts.push([node.c0, node.c1]);
          missingDecoderKeys.push(ctxKey);
        }
      }
    }

    // 2. Batch all decoder cache misses into ONE runtime invocation
    if (missingDecoderContexts.length > 0) {
      const decOuts = await callbacks.runDecoderBatch(missingDecoderContexts);
      decoderBatchInvocations++;
      for (let i = 0; i < missingDecoderKeys.length; i++) {
        decCache.set(missingDecoderKeys[i], decOuts[i]);
      }
    }

    // 3. Batch all unique frame contexts into ONE joiner runtime invocation
    const frameDecVecs: Float32Array[] = new Array(uniqueCtxKeys.length);
    for (let i = 0; i < uniqueCtxKeys.length; i++) {
      frameDecVecs[i] = decCache.get(uniqueCtxKeys[i])!;
    }
    const frameLogits = await callbacks.runJoinerBatch(t, frameDecVecs);
    joinerBatchInvocations++;

    // Ensure scratchpad pool has enough reusable Float32Array buffers
    for (let i = 0; i < frameLogits.length; i++) {
      const logits = frameLogits[i];
      if (!scratchLogProbs[i] || scratchLogProbs[i].length !== logits.length) {
        scratchLogProbs[i] = new Float32Array(logits.length);
      }
      logSoftmaxInto(logits, scratchLogProbs[i]);
    }

    // 4. Expand beams via Trie nodes (zero array copying, integer Map keys)
    nextMap.clear();
    const frameTs = Number((t * frameStrideSec).toFixed(3));

    for (let b = 0; b < beams.length; b++) {
      const hyp = beams[b];
      const ctxKey = packCtxKey(hyp.node.c0, hyp.node.c1);
      const slot = ctxKeyToSlot.get(ctxKey)!;
      const logProbs = scratchLogProbs[slot];

      topIds[0] = 0;
      topLps[0] = logProbs[0] - blankPenalty;
      let count = 1;

      for (let v = 1; v < logProbs.length; v++) {
        const bias = biasMap?.get(v) ?? 0;
        const lp = logProbs[v] + bias;
        if (count < maxK) {
          let pos = count;
          while (pos > 0 && lp > topLps[pos - 1]) {
            topIds[pos] = topIds[pos - 1];
            topLps[pos] = topLps[pos - 1];
            pos--;
          }
          topIds[pos] = v;
          topLps[pos] = lp;
          count++;
        } else if (lp > topLps[maxK - 1]) {
          let pos = maxK - 1;
          while (pos > 0 && lp > topLps[pos - 1]) {
            topIds[pos] = topIds[pos - 1];
            topLps[pos] = topLps[pos - 1];
            pos--;
          }
          topIds[pos] = v;
          topLps[pos] = lp;
        }
      }

      for (let i = 0; i < count; i++) {
        const candId = topIds[i];
        const newScore = hyp.score + topLps[i];
        const targetNode = candId === 0 ? hyp.node : getOrCreateChild(hyp.node, candId, frameTs);
        const existing = nextMap.get(targetNode.nodeId);
        if (!existing) {
          if (candId !== 0) {
            // Update timestamp on first active arrival at this frame so stale timestamps
            // from previously pruned branches never leak into winning hypotheses.
            targetNode.frameTsSec = frameTs;
          }
          nextMap.set(targetNode.nodeId, {
            node: targetNode,
            score: newScore,
            bestArrivalScore: newScore,
          });
        } else {
          existing.score = logAddExp(existing.score, newScore);
          if (newScore > existing.bestArrivalScore) {
            existing.bestArrivalScore = newScore;
            if (candId !== 0) {
              targetNode.frameTsSec = frameTs;
            }
          }
        }
      }
    }

    beams = Array.from(nextMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, beamSize);
  }

  // Reconstruct winning token sequence once at the end by walking Trie parent pointers
  const best = beams[0] ?? { node: rootNode, score: 0 };
  const emitted: number[] = [];
  const timestamps: number[] = [];
  let cursor: TrieNode | null = best.node;
  while (cursor && cursor.parent !== null) {
    emitted.push(cursor.tokenId);
    timestamps.push(cursor.frameTsSec);
    cursor = cursor.parent;
  }
  emitted.reverse();
  timestamps.reverse();

  return {
    rawText: decodeBpeTokenIdsCanonical(emitted, vocab),
    tokenIds: emitted,
    tokenTimestampsSec: timestamps,
    logProbSum: Number(best.score.toFixed(4)),
    decoderBatchInvocations,
    joinerBatchInvocations,
    totalDecoderJoinerInvocations: decoderBatchInvocations + joinerBatchInvocations,
    frameStrideSec,
  };
}

/**
 * Reusable-scratchpad Greedy Transducer Search with dynamic frameStrideSec.
 */
export async function runGreedyTransducerSearch(params: {
  readonly numFrames: number;
  readonly vocab: readonly string[];
  readonly blankPenalty: number;
  readonly frameStrideSec: number;
  readonly signal?: AbortSignal;
  readonly onCancelled?: () => Error;
  readonly callbacks: BatchedTransducerCallbacks;
}): Promise<BatchedTransducerDecodeResult> {
  const { numFrames, vocab, blankPenalty, frameStrideSec, signal, callbacks } = params;
  const decCache = new Map<number, Float32Array>();
  let decoderBatchInvocations = 0;
  let joinerBatchInvocations = 0;
  const packCtxKey = (c0: number, c1: number): number => c0 * 65536 + c1;

  const getDecoderVec = async (c0: number, c1: number): Promise<Float32Array> => {
    const key = packCtxKey(c0, c1);
    const hit = decCache.get(key);
    if (hit) return hit;
    const [vec] = await callbacks.runDecoderBatch([[c0, c1]]);
    decoderBatchInvocations++;
    decCache.set(key, vec);
    return vec;
  };

  const emitted: number[] = [];
  const timestamps: number[] = [];
  let ctx0 = 0;
  let ctx1 = 0;
  let logProbSum = 0;
  let decVec = await getDecoderVec(ctx0, ctx1);
  let logProbScratch: Float32Array | null = null;

  for (let t = 0; t < numFrames; t++) {
    if (signal?.aborted) {
      throw params.onCancelled?.() ?? new Error('JOB_CANCELLED');
    }
    const [logits] = await callbacks.runJoinerBatch(t, [decVec]);
    joinerBatchInvocations++;
    if (!logProbScratch || logProbScratch.length !== logits.length) {
      logProbScratch = new Float32Array(logits.length);
    }
    logSoftmaxInto(logits, logProbScratch);

    let bestId = 0;
    let bestScore = logProbScratch[0] - blankPenalty;
    for (let v = 1; v < logProbScratch.length; v++) {
      const score = logProbScratch[v];
      if (score > bestScore) {
        bestScore = score;
        bestId = v;
      }
    }
    if (bestId !== 0) {
      emitted.push(bestId);
      timestamps.push(Number((t * frameStrideSec).toFixed(3)));
      logProbSum += bestScore;
      ctx0 = ctx1;
      ctx1 = bestId;
      decVec = await getDecoderVec(ctx0, ctx1);
    }
  }

  return {
    rawText: decodeBpeTokenIdsCanonical(emitted, vocab),
    tokenIds: emitted,
    tokenTimestampsSec: timestamps,
    logProbSum: Number(logProbSum.toFixed(4)),
    decoderBatchInvocations,
    joinerBatchInvocations,
    totalDecoderJoinerInvocations: decoderBatchInvocations + joinerBatchInvocations,
    frameStrideSec,
  };
}
