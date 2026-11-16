import {
  EphemeralDspParams,
  PdcBranchCompensation,
  PdcPlan,
  ProcessingGraphEdge,
  ProcessingNodeDescriptor,
} from '../contracts/v1_2';

/**
 * Processing Graph Engine (v1.2 Spec Sections 28, 30, 33)
 * - DAG Cycle Validation & Topological Sorting
 * - Automatic Plugin Delay Compensation (PDC) to prevent Comb Filtering across parallel branches
 * - Pre-Roll State Priming for stateful DSP nodes (EQ, Gate, Compressor)
 */

export function createDefaultStudioGraph(): {
  nodes: ProcessingNodeDescriptor[];
  edges: ProcessingGraphEdge[];
} {
  const nodes: ProcessingNodeDescriptor[] = [
    {
      id: 'src-speech',
      name: 'Dry Vocal Input',
      labelFa: 'ورودی صدای گوینده',
      kind: 'source',
      executionMode: 'Real-Time',
      chunkSafe: true,
      latencySamples: 0,
      preRollSamples: 0,
      tailSamples: 0,
      bypassed: false,
    },
    {
      id: 'branch-eq',
      name: 'High-Pass & De-Rumble EQ',
      labelFa: 'فیلتر بالاگذر (HPF) و حذف بم',
      kind: 'eq',
      executionMode: 'Real-Time',
      chunkSafe: true,
      latencySamples: 64,
      preRollSamples: 2048,
      tailSamples: 256,
      bypassed: false,
    },
    {
      id: 'branch-comp',
      name: 'Lookahead Vocal Compressor',
      labelFa: 'کمپرسور پیش‌نگر صدا (Lookahead)',
      kind: 'compressor',
      executionMode: 'Real-Time',
      chunkSafe: true,
      latencySamples: 512,
      preRollSamples: 9600, // 200ms @ 48kHz for smooth envelope priming
      tailSamples: 4800,
      bypassed: false,
    },
    {
      id: 'branch-parallel-dry',
      name: 'Parallel Clarity Blend',
      labelFa: 'مسیر موازی شفافیت صدا',
      kind: 'gate',
      executionMode: 'Real-Time',
      chunkSafe: true,
      latencySamples: 32,
      preRollSamples: 1024,
      tailSamples: 128,
      bypassed: false,
    },
    {
      id: 'bus-master',
      name: 'Master Bus & True-Peak Limiter',
      labelFa: 'باس خروجی و لیمیتر استاندارد (-1 dBTP)',
      kind: 'limiter',
      executionMode: 'Real-Time',
      chunkSafe: true,
      latencySamples: 128,
      preRollSamples: 2400,
      tailSamples: 512,
      bypassed: false,
    },
  ];

  const edges: ProcessingGraphEdge[] = [
    { fromNodeId: 'src-speech', toNodeId: 'branch-eq' },
    { fromNodeId: 'branch-eq', toNodeId: 'branch-comp' },
    { fromNodeId: 'branch-comp', toNodeId: 'bus-master' },
    // Parallel branch bypassing heavy lookahead compressor
    { fromNodeId: 'src-speech', toNodeId: 'branch-parallel-dry' },
    { fromNodeId: 'branch-parallel-dry', toNodeId: 'bus-master' },
  ];

  return { nodes, edges };
}

export function planProcessingGraphPdc(
  nodes: ProcessingNodeDescriptor[],
  edges: ProcessingGraphEdge[],
): PdcPlan {
  const nodeMap = new Map<string, ProcessingNodeDescriptor>();
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const n of nodes) {
    nodeMap.set(n.id, n);
    inDegree.set(n.id, 0);
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }

  for (const e of edges) {
    if (!nodeMap.has(e.fromNodeId) || !nodeMap.has(e.toNodeId)) continue;
    outgoing.get(e.fromNodeId)!.push(e.toNodeId);
    incoming.get(e.toNodeId)!.push(e.fromNodeId);
    inDegree.set(e.toNodeId, (inDegree.get(e.toNodeId) ?? 0) + 1);
  }

  // Kahn's algorithm for DAG validation & topological order
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }

  if (topologicalOrder.length !== nodes.length) {
    return {
      isValidDag: false,
      topologicalOrder: [],
      totalGraphLatencySamples: 0,
      totalPreRollSamples: 0,
      totalTailSamples: 0,
      branchCompensations: [],
    };
  }

  // Cumulative arrival latency at each node
  const arrivalLatency = new Map<string, number>();
  const branchCompensations: PdcBranchCompensation[] = [];
  let maxPreRoll = 0;
  let maxTail = 0;

  for (const id of topologicalOrder) {
    const node = nodeMap.get(id)!;
    const nodeOwnLatency = node.bypassed ? 0 : node.latencySamples;
    const parents = incoming.get(id) ?? [];

    if (parents.length === 0) {
      arrivalLatency.set(id, nodeOwnLatency);
    } else {
      const parentTotals = parents.map((pId) => arrivalLatency.get(pId) ?? 0);
      const maxParentLatency = Math.max(...parentTotals);

      // Insert Automatic PDC delay lines on any faster parallel branch entering this node
      if (parents.length > 1) {
        for (let i = 0; i < parents.length; i++) {
          const pId = parents[i];
          const pLatency = parentTotals[i];
          const delayNeeded = maxParentLatency - pLatency;
          branchCompensations.push({
            branchRootNodeId: pId,
            pathLatencySamples: pLatency,
            maxBusLatencySamples: maxParentLatency,
            insertedDelaySamples: delayNeeded,
          });
        }
      }

      arrivalLatency.set(id, maxParentLatency + nodeOwnLatency);
    }

    if (!node.bypassed) {
      maxPreRoll = Math.max(maxPreRoll, node.preRollSamples);
      maxTail = Math.max(maxTail, node.tailSamples);
    }
  }

  const totalGraphLatencySamples =
    topologicalOrder.length > 0
      ? Math.max(...topologicalOrder.map((id) => arrivalLatency.get(id) ?? 0))
      : 0;

  return {
    isValidDag: true,
    topologicalOrder,
    totalGraphLatencySamples,
    totalPreRollSamples: maxPreRoll,
    totalTailSamples: maxTail,
    branchCompensations,
  };
}

/**
 * Applies stateful DSP chain (High-Pass Filter + Noise Gate + Compressor + Master Gain)
 * with mandatory Pre-Roll Priming: processes [0 .. preRollLen + mainLen) and slices out
 * [preRollLen .. preRollLen + mainLen) so filter/compressor envelopes are primed cleanly.
 */
export function processChunkWithPreRoll(
  preRollAndChunk: Float32Array,
  preRollSamples: number,
  sampleRate: number,
  params: EphemeralDspParams,
): Float32Array {
  const totalLen = preRollAndChunk.length;
  const outputLen = Math.max(0, totalLen - preRollSamples);
  if (outputLen === 0) return new Float32Array(0);

  // 1-pole High-Pass Filter coefficients
  const fc = Math.max(20, Math.min(400, params.highPassHz));
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / sampleRate;
  const alphaHpf = rc / (rc + dt);

  let prevIn = 0;
  let prevHpfOut = 0;

  // Envelope follower for Noise Gate + Compressor
  let env = 0;
  const attackCoeff = Math.exp(-1 / (sampleRate * 0.005));
  const releaseCoeff = Math.exp(-1 / (sampleRate * 0.08));

  const gateThreshLin = Math.pow(10, params.noiseGateThresholdDb / 20);
  const compThreshDb = params.compressorThresholdDb;
  const ratio = Math.max(1, params.compressorRatio);
  const masterLin = Math.pow(10, params.masterGainDb / 20);

  const result = new Float32Array(outputLen);

  for (let i = 0; i < totalLen; i++) {
    const x = preRollAndChunk[i];
    // High-pass
    const hpf = alphaHpf * (prevHpfOut + x - prevIn);
    prevIn = x;
    prevHpfOut = hpf;

    // Envelope tracking
    const absX = Math.abs(hpf);
    env = absX > env
      ? attackCoeff * env + (1 - attackCoeff) * absX
      : releaseCoeff * env + (1 - releaseCoeff) * absX;

    // Soft Noise Gate
    let gain = 1.0;
    if (env < gateThreshLin) {
      const ratioBelow = env / Math.max(gateThreshLin, 1e-6);
      gain *= Math.max(0.05, ratioBelow * ratioBelow);
    }

    // Downward Compressor
    const envDb = 20 * Math.log10(Math.max(env, 1e-6));
    if (envDb > compThreshDb) {
      const overDb = envDb - compThreshDb;
      const compressedDb = compThreshDb + overDb / ratio;
      const reductionDb = compressedDb - envDb;
      gain *= Math.pow(10, reductionDb / 20);
    }

    // Apply master gain + soft ceiling limiter at -0.5 dBFS (~0.944)
    let y = hpf * gain * masterLin;
    if (Math.abs(y) > 0.944) {
      y = Math.sign(y) * (0.944 + 0.05 * Math.tanh((Math.abs(y) - 0.944) * 10));
    }

    if (i >= preRollSamples) {
      result[i - preRollSamples] = y;
    }
  }

  return result;
}
