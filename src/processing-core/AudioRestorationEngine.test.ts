import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioRestorationEngine,
  createWasmRestorationBridge,
  WasmRestorationBridge,
} from './AudioRestorationEngine';
import { ProcessingGraphEngine } from './ProcessingGraphEngine';

function rms(buf: Float32Array, start: number, end: number): number {
  let sumSq = 0;
  const count = Math.max(1, end - start);
  for (let i = start; i < end; i++) sumSq += buf[i] * buf[i];
  return Math.sqrt(sumSq / count);
}

test('De-Click removes short impulsive mouth clicks while preserving underlying waveform and sustained speech', () => {
  const sr = 48000;
  const n = 9600; // 200ms
  const clean = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    clean[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }

  const corrupted = new Float32Array(clean);
  // Inject two crisp mouth clicks at sample 2400 and 6000
  corrupted[2400] = 0.92;
  corrupted[2401] = -0.84;
  corrupted[6000] = 0.88;

  const engine = new AudioRestorationEngine();
  const { repairedChannels, telemetry } = engine.restoreChannels([corrupted], {
    sampleRate: sr,
    deClick: { enabled: true, sensitivity: 6.0, maxClickWidthMs: 2.5 },
    deClip: { enabled: false },
    deReverb: { enabled: false },
  });

  const repaired = repairedChannels[0];
  assert.equal(telemetry.backendUsed, 'TYPESCRIPT_FALLBACK');
  assert.equal(telemetry.clicksDetected, 2);
  assert.ok(Math.abs(repaired[2400] - clean[2400]) < 0.05);
  assert.ok(Math.abs(repaired[6000] - clean[6000]) < 0.05);
  // Untouched clean region remains bit-identical
  assert.ok(Math.abs(repaired[1000] - clean[1000]) < 1e-6);
});

test('De-Clip reconstructs hard-clipped sine peaks smoothly via cubic Hermite and recovers headroom', () => {
  const sr = 48000;
  const n = 4800;
  const trueOverdriven = new Float32Array(n);
  const clipped = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const s = 1.35 * Math.sin((2 * Math.PI * 250 * i) / sr);
    trueOverdriven[i] = s;
    clipped[i] = Math.max(-0.992, Math.min(0.992, s));
  }

  // Verify raw reconstruction recovers peak > 1.0 before headroom normalization
  const rawTest = new Float32Array(clipped);
  const rawStats = AudioRestorationEngine.deClipChannelInPlace(rawTest, {
    enabled: true,
    clipThreshold: 0.992,
    normalizeReconstructedHeadroom: false,
  });
  assert.ok(rawStats.clippedSegmentsRepaired >= 10);
  assert.ok(rawStats.preNormalizationPeak > 1.15, `Expected recovered peak > 1.15, got ${rawStats.preNormalizationPeak}`);

  // Verify pipeline with headroom normalization caps max peak <= 0.961 cleanly
  const engine = new AudioRestorationEngine();
  const { repairedChannels, telemetry } = engine.restoreChannels([clipped], {
    sampleRate: sr,
    deClick: { enabled: false },
    deClip: { enabled: true, clipThreshold: 0.992, normalizeReconstructedHeadroom: true },
    deReverb: { enabled: false },
  });

  let maxOut = 0;
  for (let i = 0; i < repairedChannels[0].length; i++) {
    maxOut = Math.max(maxOut, Math.abs(repairedChannels[0][i]));
  }
  assert.ok(maxOut <= 0.961, `Expected normalized ceiling <= 0.961, got ${maxOut}`);
  assert.ok(telemetry.clippedSegmentsRepaired >= 10);
});

test('Spectral De-Reverb suppresses late exponential room tail while preserving direct vocal onset', () => {
  const sr = 48000;
  const burstEnd = 7200; // 150ms direct speech burst
  const total = 33600; // 700ms total
  const sig = new Float32Array(total);

  for (let i = 0; i < total; i++) {
    const carrier =
      0.5 * Math.sin((2 * Math.PI * 350 * i) / sr) +
      0.25 * Math.sin((2 * Math.PI * 700 * i) / sr);
    if (i < burstEnd) {
      sig[i] = carrier;
    } else {
      const decayTime = (i - burstEnd) / sr;
      sig[i] = carrier * 0.45 * Math.exp(-decayTime / 0.25);
    }
  }

  const directRmsBefore = rms(sig, 1024, burstEnd - 512);
  const tailRmsBefore = rms(sig, burstEnd + 2400, total - 2048);

  const engine = new AudioRestorationEngine();
  const { repairedChannels, telemetry } = engine.restoreChannels([sig], {
    sampleRate: sr,
    deClick: { enabled: false },
    deClip: { enabled: false },
    deReverb: { enabled: true, reductionAmount: 0.85, estimatedRt60Seconds: 0.65, spectralFloor: 0.12 },
  });

  const out = repairedChannels[0];
  const directRmsAfter = rms(out, 1024, burstEnd - 512);
  const tailRmsAfter = rms(out, burstEnd + 2400, total - 2048);

  assert.equal(telemetry.reverbReductionApplied, true);
  assert.ok(directRmsAfter > directRmsBefore * 0.65, 'Direct speech onset preserved cleanly');
  assert.ok(
    tailRmsAfter < tailRmsBefore * 0.5,
    `Expected late reverb suppression (< 50%), before=${tailRmsBefore.toFixed(4)} after=${tailRmsAfter.toFixed(4)}`,
  );
});

test('AudioRestorationEngine delegates to injected Zero-Copy WASM bridge and reports accurate latency', () => {
  const heap = new Float32Array(4096);
  const calls: string[] = [];
  const mockBridge: WasmRestorationBridge = {
    allocF32() {
      calls.push('alloc');
      return 0;
    },
    freeF32() {
      calls.push('free');
    },
    getHeapF32View(ptr, len) {
      return heap.subarray(ptr, ptr + len);
    },
    deClipInPlace() {
      calls.push('deClip');
      return 3;
    },
    deClickInPlace() {
      calls.push('deClick');
      return 2;
    },
    deReverbInPlace() {
      calls.push('deReverb');
    },
  };

  const engine = new AudioRestorationEngine(mockBridge);
  const { telemetry } = engine.restoreChannels([new Float32Array(2048)], {
    sampleRate: 48000,
    deClick: { enabled: true },
    deClip: { enabled: true },
    deReverb: { enabled: true },
  });

  assert.equal(telemetry.backendUsed, 'WASM_NATIVE');
  assert.equal(telemetry.algorithmicLatencySamples, 1040);
  assert.equal(telemetry.clippedSegmentsRepaired, 3);
  assert.equal(telemetry.clicksDetected, 2);
  assert.deepEqual(calls, ['alloc', 'deClip', 'deClick', 'deReverb', 'free']);
});

test('createWasmRestorationBridge works over WebAssembly.Memory and integrates with ProcessingGraphEngine PDC', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let nextPtr = 64;
  const freed: number[] = [];

  const bridge = createWasmRestorationBridge({
    memory,
    alloc_f32(length) {
      const ptr = nextPtr;
      nextPtr += length * 4;
      return ptr;
    },
    free_f32(ptr) {
      freed.push(ptr);
    },
    de_clip_in_place() {
      return 1;
    },
    de_click_in_place(ptr, length) {
      const view = new Float32Array(memory.buffer, ptr, length);
      view[10] = 0.125;
      return 1;
    },
    de_reverb_in_place() {},
  });

  const engine = new AudioRestorationEngine(bridge);
  const cfg = {
    sampleRate: 48000 as const,
    deClick: { enabled: true },
    deClip: { enabled: true },
    deReverb: { enabled: true },
  };
  const { repairedChannels, telemetry } = engine.restoreChannels([new Float32Array(512)], cfg);
  assert.equal(telemetry.backendUsed, 'WASM_NATIVE');
  assert.equal(repairedChannels[0][10], 0.125);
  assert.equal(freed.length, 1);

  const graph = new ProcessingGraphEngine();
  const restorationNode = engine.buildProcessingGraphNodeSpec('restoration', cfg);
  const plan = graph.compileGraph(
    [
      {
        id: 'src_voice',
        type: 'TRACK_SOURCE',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
      {
        id: 'src_music',
        type: 'TRACK_SOURCE',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
      restorationNode,
      {
        id: 'bus',
        type: 'BUS_MIXER',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
    ],
    [
      { fromNodeId: 'src_voice', toNodeId: 'restoration' },
      { fromNodeId: 'restoration', toNodeId: 'bus' },
      { fromNodeId: 'src_music', toNodeId: 'bus' },
    ],
    48000,
    ['hash1'],
  );

  assert.equal(plan.totalGraphLatencySamples, 1040);
  assert.equal(plan.pdcInsertions.length, 1);
  assert.equal(plan.pdcInsertions[0].edge.fromNodeId, 'src_music');
  assert.equal(plan.pdcInsertions[0].compensationDelaySamples, 1040);
});

test('Section 28 TKEO removeMouthClicksInPlace, reconstructClippedPeaksInPlace, and reduceRoomReverbInPlace', () => {
  const sr = 48000;
  const sig = new Float32Array(9600);
  for (let i = 0; i < sig.length; i++) {
    sig[i] = 0.25 * Math.sin((2 * Math.PI * 200 * i) / sr);
  }
  const cleanRef = new Float32Array(sig);
  // High-frequency click inside vowel (alternating +/- sharp transient, also in trailing <20ms window)
  sig[1200] = 0.85;
  sig[1201] = -0.82;
  sig[9400] = 0.88;
  sig[9401] = -0.79;

  const tkeoRepaired = AudioRestorationEngine.removeMouthClicksInPlace(sig, sr, 14.0);
  assert.equal(tkeoRepaired, 2);
  assert.ok(Math.abs(sig[1200] - cleanRef[1200]) < 0.08);
  assert.ok(Math.abs(sig[9400] - cleanRef[9400]) < 0.08);

  // De-clip with headroomScale
  const clipped = new Float32Array(2400);
  for (let i = 0; i < clipped.length; i++) {
    clipped[i] = Math.max(-0.992, Math.min(0.992, 1.3 * Math.sin((2 * Math.PI * 300 * i) / sr)));
  }
  const clipReport = AudioRestorationEngine.reconstructClippedPeaksInPlace(clipped, 0.992, 0.75);
  assert.ok(clipReport.repairedClippedPeaksCount >= 10);
  assert.ok(clipReport.maxReconstructedPeakLinear < 1.0);

  // Envelope De-Reverb preserves onset while attenuating slow tail
  const reverbSig = new Float32Array(19200);
  for (let i = 0; i < reverbSig.length; i++) {
    const tone = 0.5 * Math.sin((2 * Math.PI * 320 * i) / sr);
    reverbSig[i] = i < 4800 ? tone : tone * 0.3 * Math.exp(-(i - 4800) / (0.18 * sr));
  }
  const tailBefore = rms(reverbSig, 9600, 18000);
  AudioRestorationEngine.reduceRoomReverbInPlace(reverbSig, sr, 0.7);
  const tailAfter = rms(reverbSig, 9600, 18000);
  assert.ok(tailAfter < tailBefore * 0.85);
});
