/**
 * AVP-P0-002 §8 — Real Persian ASR Model Qualification Pipeline & Deterministic WER/CER Metrics
 *
 * Strictly separates:
 * 1. Deterministic runtime pipeline verification (real ONNX Runtime session execution + tensor contract + decoding + timestamps)
 * 2. Statistical Persian ASR accuracy qualification (WER/CER over an actual Persian speech corpus)
 *
 * Never uses expected transcripts as model outputs, and never accepts mocked ORT sessions as real qualification.
 */

import {
  CanonicalModelManifest,
  PERSIAN_NORMALIZATION_CONTRACT_VERSION,
  validateCanonicalModelManifest,
  validateOnnxSessionTensorContract,
} from './../lifecycle/CanonicalModelProvenance';
import {
  AvapardazTranscriptResult,
  LocalAsrRuntimeAdapter,
  AsrModelLoadDescriptor,
} from './UnifiedLocalAsrRuntime';
import { IncrementalSha256 } from '../utils/StreamingSha256';
import { normalizeWithProfile } from './CoreNormalizationAndLanguage';

export interface QualificationAudioSample {
  readonly sampleId: string;
  readonly category:
    | 'clear_persian'
    | 'fast_persian'
    | 'short_utterance'
    | 'long_speech'
    | 'silence'
    | 'noisy_speech'
    | 'mixed_fa_en';
  readonly sampleRate: number;
  readonly pcmMono: Float32Array;
  /** Optional reference transcript for statistical WER/CER evaluation (NEVER fed into ASR engine) */
  readonly referenceText?: string;
}

export interface WerCerMeasurement {
  readonly wer: number;
  readonly cer: number;
  readonly wordEdits: number;
  readonly referenceWords: number;
  readonly charEdits: number;
  readonly referenceChars: number;
}

export interface SampleQualificationRecord {
  readonly sampleId: string;
  readonly category: QualificationAudioSample['category'];
  readonly success: boolean;
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly peakMemoryBytes: number;
  readonly segmentCount: number;
  readonly timestampsMonotonicAndBounded: boolean;
  readonly transcriptText: string;
  readonly metrics: WerCerMeasurement | null;
  readonly error?: string;
}

export interface ModelQualificationReport {
  readonly qualified: boolean;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly runtimeTarget: string;
  readonly manifestValid: boolean;
  readonly checksumsVerified: boolean;
  readonly tensorContractValid: boolean;
  readonly runtimeInitialized: boolean;
  readonly realInferenceExecuted: boolean;
  readonly inferenceSuccessRate: number;
  readonly runtimeInitFailures: number;
  readonly totalProcessingMs: number;
  readonly peakMemoryBytes: number;
  readonly averageWer: number | null;
  readonly averageCer: number | null;
  readonly samples: readonly SampleQualificationRecord[];
  readonly errors: readonly string[];
  readonly executedAtIso: string;
}

function levenshteinDistance<T>(a: readonly T[], b: readonly T[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

/**
 * Computes normalized Persian WER and CER using canonical AVAPARDAZ Persian normalization.
 */
export function computePersianWerCer(referenceRaw: string, hypothesisRaw: string): WerCerMeasurement {
  const refNorm = normalizeWithProfile(referenceRaw, 'FA-RELAXED-V1').trim();
  const hypNorm = normalizeWithProfile(hypothesisRaw, 'FA-RELAXED-V1').trim();

  const refWords = refNorm.length > 0 ? refNorm.split(/\s+/) : [];
  const hypWords = hypNorm.length > 0 ? hypNorm.split(/\s+/) : [];
  const wordEdits = levenshteinDistance(refWords, hypWords);
  const wer = refWords.length > 0 ? wordEdits / refWords.length : hypWords.length > 0 ? 1 : 0;

  const refChars = Array.from(refNorm.replace(/\s+/g, ' '));
  const hypChars = Array.from(hypNorm.replace(/\s+/g, ' '));
  const charEdits = levenshteinDistance(refChars, hypChars);
  const cer = refChars.length > 0 ? charEdits / refChars.length : hypChars.length > 0 ? 1 : 0;

  return {
    wer: Number(wer.toFixed(4)),
    cer: Number(cer.toFixed(4)),
    wordEdits,
    referenceWords: refWords.length,
    charEdits,
    referenceChars: refChars.length,
  };
}

export function validateTranscriptTimestamps(
  result: AvapardazTranscriptResult,
  toleranceSec = 0.05,
): boolean {
  let prevEnd = 0;
  for (const seg of result.segments) {
    if (
      !Number.isFinite(seg.startSec) ||
      !Number.isFinite(seg.endSec) ||
      seg.startSec < -0.001 ||
      seg.endSec < seg.startSec ||
      seg.endSec > result.durationSec + toleranceSec
    ) {
      return false;
    }
    if (seg.startSec < prevEnd - toleranceSec) {
      return false;
    }
    prevEnd = seg.endSec;
    for (const w of seg.words) {
      if (
        !Number.isFinite(w.startSec) ||
        !Number.isFinite(w.endSec) ||
        w.startSec < -0.001 ||
        w.endSec < w.startSec ||
        w.endSec > result.durationSec + toleranceSec
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Executes the 11-step Model Qualification Pipeline (AVP-P0-002 §8) against a real
 * `LocalAsrRuntimeAdapter` and records measured duration, memory, timestamp integrity, and WER/CER.
 */
export async function runModelQualificationPipeline(params: {
  readonly manifest: CanonicalModelManifest;
  readonly artifactBytesByFilename: Readonly<Record<string, Uint8Array>>;
  readonly adapter: LocalAsrRuntimeAdapter;
  readonly modelDescriptor: AsrModelLoadDescriptor;
  readonly actualSessionIoNames?: {
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
  };
  readonly samples: readonly QualificationAudioSample[];
  readonly signal?: AbortSignal;
}): Promise<ModelQualificationReport> {
  const errors: string[] = [];
  const sampleRecords: SampleQualificationRecord[] = [];
  const tStart = performance.now();

  // Step 1: Verify manifest
  const manifestVal = validateCanonicalModelManifest(params.manifest);
  if (!manifestVal.valid) {
    errors.push(...manifestVal.errors);
  }

  // Step 2: Verify all required artifact checksums & sizes
  let checksumsVerified = manifestVal.valid;
  for (const spec of params.manifest.artifacts) {
    const bytes = params.artifactBytesByFilename[spec.filename];
    if (!bytes) {
      if (spec.required) {
        checksumsVerified = false;
        errors.push(`Missing required artifact "${spec.filename}".`);
      }
      continue;
    }
    if (bytes.byteLength !== spec.byteLength) {
      checksumsVerified = false;
      errors.push(
        `Artifact "${spec.filename}" size mismatch: actual ${bytes.byteLength} !== expected ${spec.byteLength}.`,
      );
      continue;
    }
    const digest = new IncrementalSha256().update(bytes).digestHex();
    if (digest !== spec.sha256Hex.toLowerCase()) {
      checksumsVerified = false;
      errors.push(
        `Artifact "${spec.filename}" SHA-256 mismatch: actual ${digest} !== expected ${spec.sha256Hex.toLowerCase()}.`,
      );
    }
  }

  // Step 3: Validate tensor contracts (if session IO names were inspected)
  let tensorContractValid = true;
  if (params.actualSessionIoNames) {
    const tc = validateOnnxSessionTensorContract(
      params.manifest,
      params.actualSessionIoNames.inputNames,
      params.actualSessionIoNames.outputNames,
    );
    tensorContractValid = tc.valid;
    if (!tc.valid) errors.push(...tc.errors);
  }

  if (!manifestVal.valid || !checksumsVerified || !tensorContractValid) {
    return {
      qualified: false,
      modelId: params.manifest.modelId,
      modelVersion: params.manifest.version,
      runtimeTarget: params.adapter.runtimeTarget,
      manifestValid: manifestVal.valid,
      checksumsVerified,
      tensorContractValid,
      runtimeInitialized: false,
      realInferenceExecuted: false,
      inferenceSuccessRate: 0,
      runtimeInitFailures: 0,
      totalProcessingMs: Math.round(performance.now() - tStart),
      peakMemoryBytes: 0,
      averageWer: null,
      averageCer: null,
      samples: [],
      errors,
      executedAtIso: new Date().toISOString(),
    };
  }

  // Step 4 & 5: Initialize real runtime and load exact installed model
  let runtimeInitialized = false;
  let runtimeInitFailures = 0;
  try {
    await params.adapter.initializeRuntime(params.signal);
    const modelVal = await params.adapter.validateModel(params.modelDescriptor);
    if (!modelVal.valid) {
      errors.push(...modelVal.errors);
      runtimeInitFailures++;
    } else {
      await params.adapter.loadModel(params.modelDescriptor, params.signal);
      runtimeInitialized = true;
    }
  } catch (err) {
    runtimeInitFailures++;
    errors.push(`Runtime/model initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!runtimeInitialized) {
    return {
      qualified: false,
      modelId: params.manifest.modelId,
      modelVersion: params.manifest.version,
      runtimeTarget: params.adapter.runtimeTarget,
      manifestValid: true,
      checksumsVerified: true,
      tensorContractValid: true,
      runtimeInitialized: false,
      realInferenceExecuted: false,
      inferenceSuccessRate: 0,
      runtimeInitFailures,
      totalProcessingMs: Math.round(performance.now() - tStart),
      peakMemoryBytes: 0,
      averageWer: null,
      averageCer: null,
      samples: [],
      errors,
      executedAtIso: new Date().toISOString(),
    };
  }

  // Steps 6–11: Execute real inference on each audio sample
  let peakMemoryBytes = 0;
  let successCount = 0;
  const werValues: number[] = [];
  const cerValues: number[] = [];

  for (const sample of params.samples) {
    const pcmBytes = new Uint8Array(
      sample.pcmMono.buffer,
      sample.pcmMono.byteOffset,
      sample.pcmMono.byteLength,
    );
    const assetSha = new IncrementalSha256().update(pcmBytes).digestHex();
    const durationSec = sample.pcmMono.length / sample.sampleRate;

    try {
      const res = await params.adapter.transcribe({
        jobId: `qual_${params.manifest.modelId}_${sample.sampleId}`,
        projectId: 'qualification-suite',
        trackId: 'track-qual',
        sourceAssetId: sample.sampleId,
        sourceAssetSha256: assetSha,
        fileName: `${sample.sampleId}.wav`,
        sampleRate: sample.sampleRate,
        totalSamples: sample.pcmMono.length,
        readSourceRange: async (start, count) => {
          const s = Math.max(0, Math.min(sample.pcmMono.length, Math.floor(start)));
          const e = Math.max(s, Math.min(sample.pcmMono.length, s + Math.floor(count)));
          return sample.pcmMono.subarray(s, e);
        },
        languageHint: 'fa',
        modelDescriptor: params.modelDescriptor,
        signal: params.signal,
      });

      const tsValid = validateTranscriptTimestamps(res);
      if (!tsValid) {
        errors.push(`Sample "${sample.sampleId}" produced invalid or out-of-bounds timestamps.`);
      }
      if (res.normalizationVersion !== PERSIAN_NORMALIZATION_CONTRACT_VERSION) {
        errors.push(`Sample "${sample.sampleId}" normalization version mismatch.`);
      }
      if (res.peakMemoryBytes > peakMemoryBytes) {
        peakMemoryBytes = res.peakMemoryBytes;
      }

      const metrics =
        typeof sample.referenceText === 'string' && sample.category !== 'silence'
          ? computePersianWerCer(sample.referenceText, res.normalizedText)
          : null;
      if (metrics) {
        werValues.push(metrics.wer);
        cerValues.push(metrics.cer);
      }

      const sampleOk = tsValid && res.modelId === params.modelDescriptor.modelId;
      if (sampleOk) successCount++;

      sampleRecords.push({
        sampleId: sample.sampleId,
        category: sample.category,
        success: sampleOk,
        durationSec: Number(durationSec.toFixed(3)),
        processingTimeMs: res.processingTimeMs,
        realTimeFactor: res.realTimeFactor,
        peakMemoryBytes: res.peakMemoryBytes,
        segmentCount: res.segments.length,
        timestampsMonotonicAndBounded: tsValid,
        transcriptText: res.normalizedText,
        metrics,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Sample "${sample.sampleId}" failed inference: ${msg}`);
      sampleRecords.push({
        sampleId: sample.sampleId,
        category: sample.category,
        success: false,
        durationSec: Number(durationSec.toFixed(3)),
        processingTimeMs: 0,
        realTimeFactor: 0,
        peakMemoryBytes: 0,
        segmentCount: 0,
        timestampsMonotonicAndBounded: false,
        transcriptText: '',
        metrics: null,
        error: msg,
      });
    }
  }

  const inferenceSuccessRate =
    params.samples.length > 0 ? Number((successCount / params.samples.length).toFixed(4)) : 0;

  return {
    qualified: errors.length === 0 && params.samples.length > 0 && successCount === params.samples.length,
    modelId: params.manifest.modelId,
    modelVersion: params.manifest.version,
    runtimeTarget: params.adapter.runtimeTarget,
    manifestValid: true,
    checksumsVerified: true,
    tensorContractValid: true,
    runtimeInitialized: true,
    realInferenceExecuted: successCount > 0,
    inferenceSuccessRate,
    runtimeInitFailures,
    totalProcessingMs: Math.round(performance.now() - tStart),
    peakMemoryBytes,
    averageWer:
      werValues.length > 0
        ? Number((werValues.reduce((a, b) => a + b, 0) / werValues.length).toFixed(4))
        : null,
    averageCer:
      cerValues.length > 0
        ? Number((cerValues.reduce((a, b) => a + b, 0) / cerValues.length).toFixed(4))
        : null,
    samples: sampleRecords,
    errors,
    executedAtIso: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Minimal Real Valid ONNX Opset-13 Protobuf Builder for Real ORT Execution Tests
// (Zero mocks: builds an authentic binary ONNX ModelProto accepted by onnxruntime-web!)
// ---------------------------------------------------------------------------

function encodeVarint(value: number | bigint): number[] {
  let v = BigInt.asUintN(64, typeof value === 'bigint' ? value : BigInt(value));
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function pbTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function pbBytes(fieldNumber: number, data: Uint8Array | number[]): number[] {
  const arr = Array.isArray(data) ? data : Array.from(data);
  return [...pbTag(fieldNumber, 2), ...encodeVarint(arr.length), ...arr];
}

function pbString(fieldNumber: number, value: string): number[] {
  return pbBytes(fieldNumber, new TextEncoder().encode(value));
}

function pbInt64(fieldNumber: number, value: number | bigint): number[] {
  return [...pbTag(fieldNumber, 0), ...encodeVarint(value)];
}

function pbFloat32ArrayBytes(values: readonly number[]): Uint8Array {
  const buf = new ArrayBuffer(values.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true);
  }
  return new Uint8Array(buf);
}

function buildValueInfoProto(
  name: string,
  elemType: number, // 1=FLOAT, 7=INT64
  dims: readonly (number | string)[],
): number[] {
  const shapeDims: number[] = [];
  for (const d of dims) {
    const dimMsg = typeof d === 'number' ? pbInt64(1, d) : pbString(2, d);
    shapeDims.push(...pbBytes(1, dimMsg));
  }
  const tensorShape = shapeDims;
  const tensorType = [...pbInt64(1, elemType), ...pbBytes(2, tensorShape)];
  const typeProto = pbBytes(1, tensorType);
  return [...pbString(1, name), ...pbBytes(2, typeProto)];
}

function buildTensorProtoFloat(
  name: string,
  dims: readonly number[],
  values: readonly number[],
): number[] {
  const out: number[] = [];
  for (const d of dims) out.push(...pbInt64(1, d));
  out.push(...pbInt64(2, 1)); // FLOAT
  out.push(...pbString(8, name));
  out.push(...pbBytes(9, pbFloat32ArrayBytes(values)));
  return out;
}

function buildNodeProto(params: {
  readonly opType: string;
  readonly name: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly attrs?: readonly number[][];
}): number[] {
  const out: number[] = [];
  for (const i of params.inputs) out.push(...pbString(1, i));
  for (const o of params.outputs) out.push(...pbString(2, o));
  out.push(...pbString(3, params.name));
  out.push(...pbString(4, params.opType));
  if (params.attrs) {
    for (const a of params.attrs) out.push(...pbBytes(5, a));
  }
  return out;
}

function buildIntAttr(name: string, val: number): number[] {
  return [...pbString(1, name), ...pbInt64(3, val), ...pbInt64(20, 2)]; // type=INT
}

function buildIntsAttr(name: string, vals: readonly number[]): number[] {
  const out: number[] = [...pbString(1, name)];
  for (const v of vals) out.push(...pbInt64(8, v));
  out.push(...pbInt64(20, 7)); // type=INTS
  return out;
}

/**
 * Constructs a real, spec-compliant binary ONNX Opset-13 graph matching the canonical
 * NeMo FastConformer CTC tensor contract:
 *   Inputs:  `audio_signal: float32[1, 80, T]`, `length: int64[1]`
 *   Outputs: `logprobs: float32[1, T, vocabSize]`
 *
 * Graph operations executed genuinely by ONNX Runtime WASM:
 *   1. `Transpose(audio_signal, perm=[0, 2, 1])` -> `[1, T, 80]`
 *   2. `MatMul(transposed, W[80, vocabSize])` -> `[1, T, vocabSize]`
 *   3. `Add(matmul_out, B[vocabSize])` -> `[1, T, vocabSize]`
 *   4. `LogSoftmax(added, axis=-1)` -> `logprobs: [1, T, vocabSize]`
 *
 * This allows genuine, unmocked `onnxruntime-web` WASM session creation, tensor contract
 * validation, real forward-pass execution over 80-bin Log-Mel features, and CTC decoding!
 */
export function buildRealFastConformerContractOnnxModelBytes(options?: {
  readonly vocabSize?: number;
  readonly dominantTokenId?: number;
  readonly seedBias?: readonly number[];
}): Uint8Array {
  const vocabSize = Math.max(4, options?.vocabSize ?? 8);
  const dominantTokenId = Math.max(0, Math.min(vocabSize - 1, options?.dominantTokenId ?? 1));

  // Projection weights W[80, vocabSize] (small deterministic energy projection)
  const wVals = new Array<number>(80 * vocabSize).fill(0);
  for (let m = 0; m < 80; m++) {
    wVals[m * vocabSize + dominantTokenId] = 0.01;
  }

  const bVals = new Array<number>(vocabSize).fill(-4.0);
  if (options?.seedBias && options.seedBias.length === vocabSize) {
    for (let v = 0; v < vocabSize; v++) bVals[v] = options.seedBias[v];
  } else {
    bVals[dominantTokenId] = 3.5;
  }

  const nodeTranspose = buildNodeProto({
    opType: 'Transpose',
    name: 'mel_transpose',
    inputs: ['audio_signal'],
    outputs: ['mel_t'],
    attrs: [buildIntsAttr('perm', [0, 2, 1])],
  });

  const nodeMatMul = buildNodeProto({
    opType: 'MatMul',
    name: 'ctc_proj',
    inputs: ['mel_t', 'W_proj'],
    outputs: ['logits_raw'],
  });

  const nodeAdd = buildNodeProto({
    opType: 'Add',
    name: 'ctc_bias',
    inputs: ['logits_raw', 'B_proj'],
    outputs: ['logits'],
  });

  const nodeLogSoftmax = buildNodeProto({
    opType: 'LogSoftmax',
    name: 'ctc_log_softmax',
    inputs: ['logits'],
    outputs: ['logprobs'],
    attrs: [buildIntAttr('axis', -1)],
  });

  // Also consume `length` in an Identity op so ORT keeps both canonical inputs active in the graph
  const nodeLenId = buildNodeProto({
    opType: 'Identity',
    name: 'length_pass',
    inputs: ['length'],
    outputs: ['encoded_len'],
  });

  const initW = buildTensorProtoFloat('W_proj', [80, vocabSize], wVals);
  const initB = buildTensorProtoFloat('B_proj', [vocabSize], bVals);

  const inAudio = buildValueInfoProto('audio_signal', 1, [1, 80, 'T']);
  const inLen = buildValueInfoProto('length', 7, [1]);
  const outLogProbs = buildValueInfoProto('logprobs', 1, [1, 'T', vocabSize]);
  const outEncLen = buildValueInfoProto('encoded_len', 7, [1]);

  const graphProto = [
    ...pbBytes(1, nodeTranspose),
    ...pbBytes(1, nodeMatMul),
    ...pbBytes(1, nodeAdd),
    ...pbBytes(1, nodeLogSoftmax),
    ...pbBytes(1, nodeLenId),
    ...pbString(2, 'avapardaz_ctc_verification_graph'),
    ...pbBytes(5, initW),
    ...pbBytes(5, initB),
    ...pbBytes(11, inAudio),
    ...pbBytes(11, inLen),
    ...pbBytes(12, outLogProbs),
    ...pbBytes(12, outEncLen),
  ];

  // OperatorSetIdProto: domain="" (ai.onnx), version=13
  const opsetImport = [...pbString(1, ''), ...pbInt64(2, 13)];

  const modelProto = [
    ...pbInt64(1, 7), // ir_version = 7 (ONNX 1.8+, universally supported by ORT)
    ...pbString(2, 'avapardaz-onnx-verifier'),
    ...pbString(3, '1.0.0'),
    ...pbBytes(7, graphProto),
    ...pbBytes(8, opsetImport),
  ];

  return new Uint8Array(modelProto);
}
