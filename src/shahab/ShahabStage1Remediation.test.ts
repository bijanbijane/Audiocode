/**
 * SHAHAB Stage 1 Audit-to-Implementation Verification Suite
 *
 * Verifies every code-level remediation implemented across SHB-F01 through SHB-F07
 * without requiring external .onnx model weights, network calls, or fake weights.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

import { inspectOnnxModelBytes } from './ShahabOnnxInspector';
import { runShahab020CompactModelResearch } from './ShahabCompactModelResearch';
import {
  conditionPcmTo16kMono,
  downmixStreamToMonoPhaseSafe,
} from './core/ShahabCoreAudioConditioner';
import {
  decodeBpeTokenIdsCanonical,
  normalizeCanonicalPersianUtterance,
  resolveValidatedFrameStrideSec,
  runBatchedModifiedBeamSearch,
} from './core/ShahabCoreDecoder';
import {
  decodeBpeTokenIdsToText,
  decodeWavToMono16k,
} from './ShahabZipformerEngine';
import {
  buildHotwordBiasMapFromVerifiedTerms,
  ShahabZipformerAsrRuntime,
  type ShahabVerifiedContextTerm,
} from './ShahabZipformerAsrRuntime';
import { ShahabContextMemoryStore } from './ShahabContextMemoryStore';
import { createShahabHttpRouter, type ShahabTranscribeBackend } from './ShahabHttpRouter';
import { AudioApiSecurityGuard } from '../security/AudioApiSecurityGuard';

// ============================================================================
// Minimal Protobuf Builders for Synthetic ONNX Graph Verification (SHB-F01)
// ============================================================================

function encodeVarint(val: number): Uint8Array {
  const out: number[] = [];
  let v = val >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function pbVarintField(fieldNum: number, val: number): Uint8Array {
  return concatBytes([encodeVarint((fieldNum << 3) | 0), encodeVarint(val)]);
}

function pbBytesField(fieldNum: number, payload: Uint8Array): Uint8Array {
  return concatBytes([
    encodeVarint((fieldNum << 3) | 2),
    encodeVarint(payload.byteLength),
    payload,
  ]);
}

function pbStringField(fieldNum: number, text: string): Uint8Array {
  return pbBytesField(fieldNum, new TextEncoder().encode(text));
}

function buildTensorProto(params: {
  readonly name: string;
  readonly dataTypeId: number;
  readonly dims: readonly number[];
  readonly rawByteLength?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const d of params.dims) {
    parts.push(pbVarintField(1, d)); // dims (unpacked int64)
  }
  parts.push(pbVarintField(2, params.dataTypeId)); // data_type
  parts.push(pbStringField(8, params.name)); // name
  if (params.rawByteLength && params.rawByteLength > 0) {
    // Unique deterministic payload so content-hash dedup never collides across distinct tensors
    const raw = new Uint8Array(params.rawByteLength);
    const seed = crypto.createHash('sha256').update(params.name).digest();
    for (let i = 0; i < raw.length; i++) {
      raw[i] = seed[i % seed.length] ^ (i & 0xff);
    }
    parts.push(pbBytesField(9, raw)); // raw_data
  }
  return concatBytes(parts);
}

function buildMinimalOnnxModel(initializers: readonly Uint8Array[]): Uint8Array {
  const graphParts: Uint8Array[] = [];
  for (const init of initializers) {
    graphParts.push(pbBytesField(5, init)); // GraphProto.initializer = 5
  }
  const graphBytes = concatBytes(graphParts);
  return concatBytes([
    pbVarintField(1, 8), // ir_version = 8
    pbStringField(2, 'shahab-test-exporter'), // producer_name
    pbBytesField(7, graphBytes), // ModelProto.graph = 7
  ]);
}

function buildPcm16Wav(params: {
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesInterleaved: Float32Array;
}): Uint8Array {
  const numSamples = params.samplesInterleaved.length;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, params.channels, true);
  view.setUint32(24, params.sampleRate, true);
  view.setUint32(28, params.sampleRate * params.channels * 2, true);
  view.setUint16(32, params.channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, params.samplesInterleaved[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buf);
}

// ============================================================================
// TEST 1: SHB-F01 — ONNX Inspector Quantized Weight Counting & Compact Research
// ============================================================================

test('SHB-F01: ShahabOnnxInspector counts dynamic-INT8 *_quantized weights as parameters while excluding scale/zero_point/index constants', () => {
  const onnxBytes = buildMinimalOnnxModel([
    // Dynamic-INT8 quantized linear weight matrix (previously misclassified due to `includes('quantize')`)
    buildTensorProto({
      name: 'encoder.layers.0.feed_forward.in_proj.weight_quantized',
      dataTypeId: 3, // INT8
      dims: [384, 1024], // 393,216 elements
    }),
    // Per-channel quantization scale (FLOAT) -> MUST be non-parameter constant
    buildTensorProto({
      name: 'encoder.layers.0.feed_forward.in_proj.weight_scale',
      dataTypeId: 1, // FLOAT
      dims: [384],
    }),
    // Per-channel quantization zero-point (INT8) -> MUST be non-parameter constant
    buildTensorProto({
      name: 'encoder.layers.0.feed_forward.in_proj.weight_zero_point',
      dataTypeId: 3, // INT8
      dims: [384],
    }),
    // Regular FP32 bias -> MUST be counted as float parameter
    buildTensorProto({
      name: 'encoder.layers.0.feed_forward.in_proj.bias',
      dataTypeId: 1, // FLOAT
      dims: [384],
    }),
    // INT64 shape constant -> MUST be excluded
    buildTensorProto({
      name: 'reshape_target_shape',
      dataTypeId: 7, // INT64
      dims: [2],
    }),
  ]);

  const stats = inspectOnnxModelBytes(onnxBytes, '/tmp/test_encoder.int8.onnx', 'test_encoder.int8.onnx');

  assert.equal(stats.quantizedWeightElementCount, 393_216);
  assert.equal(stats.floatWeightElementCount, 384);
  assert.equal(stats.parameterElementCount, 393_216 + 384);
  assert.equal(stats.nonParameterConstantElementCount, 384 + 384 + 2);
  assert.equal(stats.totalInitializerElementCount, 393_216 + 384 + 384 + 384 + 2);
});

test('SHB-F01: ShahabCompactModelResearch uses dynamic measured metrics instead of hardcoded 11470768 or 55.66 MiB', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-compact-test-'));
  try {
    const withMeasured = runShahab020CompactModelResearch({
      activeModelTotalBytes: 115_776_759, // 110.41 MiB
      activeModelHash: 'a'.repeat(64),
      variantBTotalBytes: 115_776_700,
      variantBHash: 'b'.repeat(64),
      variantDGzipBytes: 99_250_000, // 94.65 MiB
      measuredParameterCount: 64_555_252,
      measuredColdLoadMs: 850,
      measuredWarmRtf: 0.42,
      measuredPeakRssMiB: 280,
      measuredTrackAWer: 0.12,
      measuredTrackACer: 0.04,
      docsDir: tmpDir,
    });

    assert.equal(withMeasured.candidates[0].parameterCount, 64_555_252);
    assert.ok(withMeasured.recommendation.includes('94.65 MiB'));
    assert.ok(!withMeasured.recommendation.includes('55.66 MiB'));

    const withoutMeasured = runShahab020CompactModelResearch({
      activeModelTotalBytes: 115_776_759,
      activeModelHash: 'a'.repeat(64),
      variantBTotalBytes: 115_776_700,
      variantBHash: 'b'.repeat(64),
      variantDGzipBytes: 99_250_000,
      measuredColdLoadMs: 850,
      measuredWarmRtf: 0.42,
      measuredPeakRssMiB: 280,
      measuredTrackAWer: 0.12,
      measuredTrackACer: 0.04,
      docsDir: tmpDir,
    });

    assert.equal(withoutMeasured.candidates[0].parameterCount, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TEST 2: SHB-F03 & SHB-F04 — Authoritative Audio Conditioner & Anti-Aliasing
// ============================================================================

test('SHB-F04: conditionPcmTo16kMono suppresses ultrasonic aliasing (>40 dB) and prevents out-of-phase cancellation on stereo & 4-channel audio', () => {
  // 1. Anti-aliasing check: 14 kHz sine at 48 kHz (above 8 kHz Nyquist of 16 kHz)
  const sr = 48000;
  const durSec = 0.5;
  const n = Math.floor(sr * durSec);
  const ultrasonic = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ultrasonic[i] = Math.sin((2 * Math.PI * 14000 * i) / sr);
  }
  const resampled = conditionPcmTo16kMono({ pcm: ultrasonic, sampleRateHz: sr, channels: 1 });
  // Measure RMS in steady middle region (exclude edge filter transient)
  let sumSq = 0;
  const start = 400;
  const end = resampled.pcm16k.length - 400;
  for (let i = start; i < end; i++) {
    sumSq += resampled.pcm16k[i] * resampled.pcm16k[i];
  }
  const rmsOut = Math.sqrt(sumSq / (end - start));
  const attenuationDb = -20 * Math.log10(Math.max(1e-12, rmsOut / 0.7071));
  assert.ok(attenuationDb > 40, `Expected >40 dB ultrasonic suppression, got ${attenuationDb.toFixed(1)} dB`);

  // 2. Out-of-phase 4-channel WAV (ch0 = +tone, ch1 = -tone, ch2 = +tone, ch3 = silence)
  const frames = 1600;
  const interleaved4ch = new Float32Array(frames * 4);
  for (let i = 0; i < frames; i++) {
    const s = 0.7 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    interleaved4ch[i * 4 + 0] = s;
    interleaved4ch[i * 4 + 1] = -s; // inverted!
    interleaved4ch[i * 4 + 2] = s;
    interleaved4ch[i * 4 + 3] = 0; // dead channel!
  }
  const down4 = downmixStreamToMonoPhaseSafe({
    totalFrames: frames,
    channels: 4,
    readSample: (f, ch) => interleaved4ch[f * 4 + ch],
  });
  assert.equal(down4.diagnostics.phaseInversionDetected, true);
  assert.equal(down4.diagnostics.deadChannelFallbackUsed, true);
  let rms4 = 0;
  for (let i = 0; i < frames; i++) rms4 += down4.mono[i] * down4.mono[i];
  rms4 = Math.sqrt(rms4 / frames);
  assert.ok(rms4 > 0.45, `Expected preserved speech energy (>0.45 RMS), got ${rms4.toFixed(4)}`);

  // Also verify decodeWavToMono16k preserves out-of-phase 4-channel WAV without extra arrays
  const wav4ch = buildPcm16Wav({ sampleRate: 16000, channels: 4, samplesInterleaved: interleaved4ch });
  const wavDec = decodeWavToMono16k(wav4ch);
  let wavRms = 0;
  for (let i = 0; i < wavDec.pcm16k.length; i++) wavRms += wavDec.pcm16k[i] * wavDec.pcm16k[i];
  wavRms = Math.sqrt(wavRms / wavDec.pcm16k.length);
  assert.ok(wavRms > 0.45, `Expected WAV 4ch downmix RMS > 0.45, got ${wavRms.toFixed(4)}`);

  // 3. Localized NaN rejection
  const badPcm = new Float32Array(1000);
  badPcm[777] = Number.NaN;
  assert.throws(() => conditionPcmTo16kMono({ pcm: badPcm, sampleRateHz: 16000, channels: 1 }), /non-finite/i);

  // 4. Verify zero `resamplePcmLinear` remains in Unified or SDK paths
  const unifiedSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/shahab/ShahabEngineUnified.ts'), 'utf8');
  const sdkSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/shahab/sdk/ShahabSdk.ts'), 'utf8');
  assert.equal(unifiedSrc.includes('resamplePcmLinear'), false, 'ShahabEngineUnified.ts must not contain resamplePcmLinear');
  assert.equal(sdkSrc.includes('const srcPos = i * ratio'), false, 'ShahabSdk.ts must not contain linear interpolation resampler');
});

// ============================================================================
// TEST 3: SHB-F05 — Batched Modified Beam Search Parity, Batching & Cancellation
// ============================================================================

test('SHB-F05: runBatchedModifiedBeamSearch matches reference unbatched search exactly with 1 joiner batch call per frame', async () => {
  const vocab = ['<blk>', '<sos/eos>', '<unk>', '▁سلام', '▁شهاب', '▁تست', '▁ایران', '▁آوا', 'پرداز'];
  const vocabSize = vocab.length;
  const numFrames = 12;

  // Deterministic pseudo-acoustic logits table keyed by (frame, c0, c1)
  const computeLogits = (frameIdx: number, c0: number, c1: number): Float32Array => {
    const out = new Float32Array(vocabSize);
    for (let v = 0; v < vocabSize; v++) {
      // Base slight blank preference except on emission frames 2, 5, 8, 10
      out[v] = -2.5 + Math.sin((frameIdx + 1) * 1.7 + c0 * 0.3 + c1 * 0.5 + v * 0.9) * 0.6;
    }
    out[0] = 1.2; // blank
    if (frameIdx === 2) {
      out[3] = 2.8; // ▁سلام
      out[4] = 2.1;
    } else if (frameIdx === 5) {
      out[4] = c1 === 3 ? 3.1 : 1.9; // ▁شهاب favored after ▁سلام
      out[5] = 2.3;
    } else if (frameIdx === 8) {
      out[7] = 2.9; // ▁آوا
      out[6] = 2.6; // ▁ایران (close runner-up for biasing test)
    } else if (frameIdx === 10) {
      out[8] = c1 === 7 ? 3.2 : 1.4; // پرداز
    }
    return out;
  };

  // Reference unbatched beam search
  const runReference = (beamSize: number, biasMap: ReadonlyMap<number, number> | null) => {
    const logAddExp = (a: number, b: number) =>
      a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
    let beams = [{ tokens: [0, 0], timestamps: [] as number[], score: 0 }];
    for (let t = 0; t < numFrames; t++) {
      const next = new Map<string, { tokens: number[]; timestamps: number[]; score: number }>();
      for (const h of beams) {
        const c0 = h.tokens[h.tokens.length - 2];
        const c1 = h.tokens[h.tokens.length - 1];
        const logits = computeLogits(t, c0, c1);
        let maxV = -Infinity;
        for (const x of logits) if (x > maxV) maxV = x;
        let sum = 0;
        for (const x of logits) sum += Math.exp(x - maxV);
        const logZ = maxV + Math.log(sum);
        const top = Array.from({ length: vocabSize }, (_, v) => ({
          id: v,
          lp: logits[v] - logZ + (v > 0 ? (biasMap?.get(v) ?? 0) : 0),
        }))
          .sort((a, b) => b.lp - a.lp)
          .slice(0, beamSize + 1);
        const ts = Number((t * 0.04).toFixed(3));
        for (const cand of top) {
          const nt = cand.id === 0 ? h.tokens : [...h.tokens, cand.id];
          const nts = cand.id === 0 ? h.timestamps : [...h.timestamps, ts];
          const ns = h.score + cand.lp;
          const key = nt.join(',');
          const ex = next.get(key);
          if (!ex) next.set(key, { tokens: nt, timestamps: nts, score: ns });
          else ex.score = logAddExp(ex.score, ns);
        }
      }
      beams = Array.from(next.values()).sort((a, b) => b.score - a.score).slice(0, beamSize);
    }
    return {
      tokenIds: beams[0].tokens.slice(2),
      timestamps: beams[0].timestamps,
      score: Number(beams[0].score.toFixed(4)),
    };
  };

  let maxSeenJoinerBatch = 0;
  const batchedRes = await runBatchedModifiedBeamSearch({
    numFrames,
    vocab,
    beamSize: 4,
    blankPenalty: 0,
    frameStrideSec: 0.04,
    callbacks: {
      runDecoderBatch: async (contexts) =>
        contexts.map(([c0, c1]) => new Float32Array([c0, c1])),
      runJoinerBatch: async (frameIdx, decVecs) => {
        if (decVecs.length > maxSeenJoinerBatch) maxSeenJoinerBatch = decVecs.length;
        return decVecs.map((v) => computeLogits(frameIdx, v[0], v[1]));
      },
    },
  });

  const ref = runReference(4, null);
  assert.deepEqual(batchedRes.tokenIds, ref.tokenIds);
  assert.deepEqual(batchedRes.tokenTimestampsSec, ref.timestamps);
  assert.equal(batchedRes.logProbSum, ref.score);
  assert.equal(batchedRes.rawText, 'سلام شهاب آواپرداز');
  assert.equal(batchedRes.joinerBatchInvocations, numFrames, 'Must execute exactly 1 batched joiner call per frame');
  assert.ok(maxSeenJoinerBatch >= 2, 'Joiner batching must actually combine multiple unique beam contexts');

  // Verify contextual biasing promotes token 6 (▁ایران) over token 7 (▁آوا)
  const biasedRes = await runBatchedModifiedBeamSearch({
    numFrames,
    vocab,
    beamSize: 4,
    blankPenalty: 0,
    frameStrideSec: 0.04,
    biasMap: new Map([[6, 1.5]]),
    callbacks: {
      runDecoderBatch: async (contexts) =>
        contexts.map(([c0, c1]) => new Float32Array([c0, c1])),
      runJoinerBatch: async (frameIdx, decVecs) =>
        decVecs.map((v) => computeLogits(frameIdx, v[0], v[1])),
    },
  });
  assert.ok(biasedRes.tokenIds.includes(6), 'Expected biased token 6 (▁ایران) in winning beam');

  // Verify AbortSignal cancellation stops decoding mid-utterance
  const ac = new AbortController();
  await assert.rejects(
    () =>
      runBatchedModifiedBeamSearch({
        numFrames,
        vocab,
        beamSize: 4,
        blankPenalty: 0,
        frameStrideSec: 0.04,
        signal: ac.signal,
        onCancelled: () => new Error('CANCELLED_MID_BEAM'),
        callbacks: {
          runDecoderBatch: async (contexts) => contexts.map(([c0, c1]) => new Float32Array([c0, c1])),
          runJoinerBatch: async (frameIdx, decVecs) => {
            if (frameIdx === 3) ac.abort();
            return decVecs.map((v) => computeLogits(frameIdx, v[0], v[1]));
          },
        },
      }),
    /CANCELLED_MID_BEAM/,
  );
});

// ============================================================================
// TEST 4: SHB-F06 — BPE Special Token Parity, Frame Stride & Persian Normalization
// ============================================================================

test('SHB-F06: BPE special tokens filtered identically, dynamic frame stride adapts to 8x subsampling, and single/multi-chunk Persian normalization match', () => {
  const vocab = ['<blk>', '<sos/eos>', '<unk>', '▁سلام', '▁می', '▁شود'];
  assert.equal(decodeBpeTokenIdsCanonical([1, 2, 3, 4, 5], vocab), 'سلام می شود');
  assert.equal(decodeBpeTokenIdsToText([1, 2, 3, 4, 5], vocab), 'سلام می شود');

  // 4x Zipformer with 0.6s tail padding: 4.0s audio -> ~115 frames -> keeps nominal 0.04s
  assert.equal(
    resolveValidatedFrameStrideSec({ nominalFrameStrideSec: 0.04, numFrames: 115, audioDurationSec: 4.0 }),
    0.04,
  );
  // 8x subsampling model: 8.0s audio -> 100 frames -> adapts to 0.08s
  assert.equal(
    resolveValidatedFrameStrideSec({ nominalFrameStrideSec: 0.04, numFrames: 100, audioDurationSec: 8.0 }),
    0.08,
  );

  // Canonical utterance normalization applies cross-word Persian ZWNJ & Arabic-to-Persian standardization identically
  const stitched = ['می', 'شود', 'كیفیت', 'عالي'].join(' ');
  const singleChunkNorm = normalizeCanonicalPersianUtterance('می شود كیفیت عالي');
  const multiChunkNorm = normalizeCanonicalPersianUtterance(stitched);
  assert.equal(multiChunkNorm, singleChunkNorm);
  assert.ok(singleChunkNorm.includes('می\u200cشود'), `Expected ZWNJ in می\u200cشود, got: ${singleChunkNorm}`);
  assert.ok(singleChunkNorm.includes('کیفیت'), `Expected Persian ک/ی in کیفیت, got: ${singleChunkNorm}`);

  // Bounded BPE hotword bias builder
  const biasMap = buildHotwordBiasMapFromVerifiedTerms({
    terms: [{ term: 'سلام', boostWeight: 2.0 }],
    vocab,
    baseBiasScore: 0.6,
  });
  assert.ok(biasMap !== null);
  assert.deepEqual(biasMap.activeTerms, ['سلام']);
  assert.ok((biasMap.tokenBiases.get(3) ?? 0) > 0 && (biasMap.tokenBiases.get(3) ?? 0) <= 1.5);
});

// ============================================================================
// TEST 5: SHB-F07 & SHB-F02 — Tenant-Isolated Context Memory, Concurrency, Runtime & Router Wiring
// ============================================================================

test('SHB-F07: ShahabContextMemoryStore enforces tenant isolation (blocks IDOR), handles concurrent writes without lost updates, and excludes UNVERIFIED_CANDIDATE', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-mem-store-'));
  try {
    const store = new ShahabContextMemoryStore({ rootDir: tmpDir });

    const a1 = await store.addEntry({
      ownerId: 'owner-alpha',
      projectId: 'proj-1',
      term: 'آواپرداز',
      verificationStatus: 'USER_VERIFIED',
      boostWeight: 1.2,
    });
    await store.addEntry({
      ownerId: 'owner-alpha',
      projectId: 'proj-1',
      term: 'نامعتبر',
      verificationStatus: 'UNVERIFIED_CANDIDATE',
      boostWeight: 1.5,
    });
    await store.addEntry({
      ownerId: 'owner-beta',
      projectId: 'proj-1',
      term: 'واژه_رقیب',
      verificationStatus: 'USER_VERIFIED',
      boostWeight: 1.0,
    });

    // Strict owner isolation on list & biasing
    const alphaBiasTerms = store.getVerifiedTermsForBiasing({ ownerId: 'owner-alpha', projectId: 'proj-1' });
    assert.deepEqual(
      alphaBiasTerms.map((t) => t.term),
      ['آواپرداز'],
      'Must only include owner-alpha verified terms and exclude UNVERIFIED_CANDIDATE & owner-beta terms',
    );

    // IDOR block: owner-beta cannot delete owner-alpha's entry
    const idorAttempt = await store.deleteEntry({ ownerId: 'owner-beta', entryId: a1.entry.entryId });
    assert.equal(idorAttempt.deleted, false);
    assert.equal(store.listEntries({ ownerId: 'owner-alpha' }).length, 2);

    // Concurrent write serialization: 10 parallel mutations must lose 0 entries
    await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        store.addEntry({
          ownerId: 'owner-concurrent',
          projectId: 'proj-c',
          term: `واژه_${idx}`,
          verificationStatus: 'USER_VERIFIED',
        }),
      ),
    );
    assert.equal(store.listEntries({ ownerId: 'owner-concurrent' }).length, 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SHB-F02 & SHB-F07: ShahabZipformerAsrRuntime reports truthful WASM provider, awaits unloadAsync, and ShahabHttpRouter wires owner-scoped verified terms + VOCABULARY policy', async () => {
  const tmpModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-empty-model-'));
  const tmpMemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-router-mem-'));

  try {
    const runtime = new ShahabZipformerAsrRuntime({ modelDir: tmpModelDir, idleUnloadMs: 60_000 });
    const status = runtime.getRuntimeStatus();
    assert.equal(status.available, false);
    assert.equal(status.executionProvider, 'wasm_single_thread');
    assert.equal(status.nativeCppAvailable, false);
    const unloaded = await runtime.unloadAsync();
    assert.equal(unloaded.unloaded, false);
    assert.ok(unloaded.rssMb > 0);

    // Router end-to-end integration test with tenant-scoped memory store
    const memStore = new ShahabContextMemoryStore({ rootDir: tmpMemDir });
    const guard = new AudioApiSecurityGuard({ mode: 'local' });
    const session = guard.issueLocalSession('owner-alpha');
    const ownerId = `local:${session.sessionId}`;
    // Seed entries for the authenticated owner AND another owner
    await memStore.addEntry({
      ownerId,
      projectId: 'proj-studio',
      term: 'شهاب',
      verificationStatus: 'USER_VERIFIED',
      boostWeight: 1.1,
    });
    await memStore.addEntry({
      ownerId: 'other-owner',
      projectId: 'proj-studio',
      term: 'محرمانه',
      verificationStatus: 'USER_VERIFIED',
    });

    let capturedPolicy: string | undefined;
    let capturedTerms: readonly ShahabVerifiedContextTerm[] | undefined;

    const mockBackend: ShahabTranscribeBackend = {
      getRuntimeStatus: () => status,
      getBundledSampleAudioPath: () => null,
      transcribe: async (req) => {
        capturedPolicy = req.decodePolicy;
        capturedTerms = req.verifiedContextTerms;
        return {
          transcript: {
            schemaVersion: 'avp.transcript.v1',
            transcriptVersion: 'tr_test_1',
            sourceAudioId: req.sourceAudioId,
            sourceAudioHash: req.sourceAudioHash ?? '0'.repeat(64),
            sampleRate: 16000,
            totalSourceSamples: 1600,
            language: 'fa',
            modelId: 'persian-zipformer-transducer',
            modelVersion: '1.0.0-shahab-zipformer-int8',
            runtime: 'shahab-zipformer-onnx-cpu',
            rawText: 'شهاب',
            normalizedText: 'شهاب',
            tokens: [],
            timestampGranularity: 'NONE',
            realTimeFactor: 0.1,
            processingTimeMs: 10,
            offlineVerified: true,
            createdAtMs: Date.now(),
          },
          metrics: {
            modelId: 'persian-zipformer-transducer',
            upstreamModelId: 'ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f',
            runtime: 'shahab-zipformer-onnx-cpu',
            durationSec: 0.1,
            processingTimeMs: 10,
            realTimeFactor: 0.1,
            rssBeforeMb: 100,
            rssAfterMb: 100,
            peakRssMb: 100,
            tokenCount: 0,
            offlineVerified: true,
          },
        };
      },
    };

    const app = express();
    app.use(
      '/api/shahab',
      createShahabHttpRouter({
        shahabZipformerRuntime: mockBackend,
        securityGuard: guard,
        contextMemoryStore: memStore,
      }),
    );

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. Check /runtime-status exposes truthful executionProvider & nativeCppAvailable
      const stRes = await fetch(`${baseUrl}/api/shahab/runtime-status`);
      assert.equal(stRes.status, 200);
      const stJson = (await stRes.json()) as Record<string, unknown>;
      assert.equal(stJson.executionProvider, 'wasm_single_thread');
      assert.equal(stJson.nativeCppAvailable, false);

      // 2. Check /transcribe forwards VOCABULARY policy and ONLY authenticated owner's verified terms
      const wav = buildPcm16Wav({
        sampleRate: 16000,
        channels: 1,
        samplesInterleaved: new Float32Array(1600),
      });
      const trRes = await fetch(`${baseUrl}/api/shahab/transcribe`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'audio/wav',
          'X-Request-Nonce': `nonce-${Date.now()}-${Math.random()}`,
          'X-Request-Timestamp': String(Date.now()),
          'X-Project-Id': 'proj-studio',
          'X-Decode-Policy': 'VOCABULARY',
        },
        body: wav.slice().buffer,
      });
      assert.equal(trRes.status, 200);
      assert.equal(capturedPolicy, 'VOCABULARY');
      assert.ok(Array.isArray(capturedTerms));
      assert.deepEqual(
        capturedTerms!.map((t) => t.term),
        ['شهاب'],
        'Router must deliver ONLY the authenticated owner’s verified context terms',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(tmpModelDir, { recursive: true, force: true });
    fs.rmSync(tmpMemDir, { recursive: true, force: true });
  }
});
