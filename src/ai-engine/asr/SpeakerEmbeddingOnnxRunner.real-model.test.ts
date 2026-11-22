import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import type {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from './UnifiedOnnxPersianAsrEngine';
import { SpeakerEmbeddingOnnxRunner } from './SpeakerEmbeddingOnnxRunner';
import { TimeMath } from '../../contracts/timebase.contract';
import { decodeWavToMono16k } from '../../shahab/ShahabZipformerEngine';

const MODEL_PATH = path.resolve(
  process.cwd(),
  'models/speaker-embedding/1.0.0/voxceleb_ECAPA512_LM.onnx',
);
const SAMPLE_WAV_PATH = path.resolve(
  process.cwd(),
  'models/persian-zipformer-transducer/1.0.0/sample.wav',
);

function createRealWasmOrtProvider(): OrtRuntimeProvider {
  const wasmDirectory =
    path.resolve(process.cwd(), 'node_modules/onnxruntime-web/dist') + path.sep;
  ort.env.wasm.wasmPaths = wasmDirectory;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  return {
    createTensor(type, data, dims) {
      return new ort.Tensor(type, data, [...dims]) as unknown as OrtTensorLike;
    },
    async createSession(modelBytesOrPath, executionProviders) {
      void executionProviders;
      const modelBytes =
        typeof modelBytesOrPath === 'string'
          ? new Uint8Array(fs.readFileSync(modelBytesOrPath))
          : modelBytesOrPath;
      return (await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })) as unknown as OrtSessionLike;
    },
  };
}

test('WeSpeaker ECAPA-TDNN512-LM: real ONNX/WASM CPU inference returns a finite 192-D embedding', async () => {
  assert.ok(
    fs.existsSync(MODEL_PATH),
    'pinned WeSpeaker ECAPA ONNX asset must be provisioned and SHA-256 verified before the test',
  );
  assert.ok(
    fs.existsSync(SAMPLE_WAV_PATH),
    'pinned Persian WAV sample must be provisioned before the test',
  );

  const modelBytes = fs.readFileSync(MODEL_PATH);
  const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
  const { pcm16k, durationSec } = decodeWavToMono16k(sampleBytes);
  const requiredSamples = Math.ceil(2.02 * 16000);
  assert.ok(
    pcm16k.length >= requiredSamples,
    'real speaker smoke sample must contain at least 2.02 seconds for a 200-frame FBANK window',
  );

  const provider = createRealWasmOrtProvider();
  const runner = new SpeakerEmbeddingOnnxRunner(
    provider,
    'feats',
    'B_T_M',
    'KALDI_FBANK',
    'lens',
    'embs',
  );
  try {
    await runner.loadModel(new Uint8Array(modelBytes), ['wasm']);
    const segmentEnd = requiredSamples;
    const startedAt = performance.now();
    const embeddings = await runner.extractEmbeddingsForVadSegments(
      pcm16k,
      [
        {
          startSample16k: 0,
          endSample16k: segmentEnd,
          range: { start: 0, end: TimeMath.secondsToFlicks(segmentEnd / 16000) },
          peakSpeechProb: 0.95,
        },
      ],
      2.02,
      2.02,
    );
    const elapsedMs = performance.now() - startedAt;

    assert.equal(embeddings.length, 1);
    const vector = embeddings[0].embeddingVector;
    assert.equal(vector.length, 192);
    let normSq = 0;
    for (const value of vector) {
      assert.ok(Number.isFinite(value), 'real model embedding must be finite');
      normSq += value * value;
    }
    assert.ok(Math.abs(Math.sqrt(normSq) - 1) < 1e-4, 'embedding must be L2 normalized');

    console.log(
      JSON.stringify({
        test: 'wespeaker-ecapa-real-onnx',
        modelBytes: modelBytes.byteLength,
        sampleDurationSec: Number(durationSec.toFixed(3)),
        inputFrames: 200,
        embeddingDimensions: vector.length,
        inferenceElapsedMs: Number(elapsedMs.toFixed(2)),
        rtf: Number((elapsedMs / 2020).toFixed(4)),
        executionProvider: 'wasm-cpu',
      }),
    );
  } finally {
    await runner.unloadModel();
  }
});
