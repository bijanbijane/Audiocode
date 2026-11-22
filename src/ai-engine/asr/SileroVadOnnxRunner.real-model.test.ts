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
import { SileroVadOnnxRunner } from './SileroVadOnnxRunner';
import { decodeWavToMono16k } from '../../shahab/ShahabZipformerEngine';

const MODEL_PATH = path.resolve(process.cwd(), 'models/silero-vad/1.0.0/silero_vad.onnx');
const SAMPLE_WAV_PATH = path.resolve(
  process.cwd(),
  'models/persian-zipformer-transducer/1.0.0/sample.wav',
);

function createRealWasmOrtProvider(): OrtRuntimeProvider {
  const wasmDirectory = path.resolve(process.cwd(), 'node_modules/onnxruntime-web/dist') + path.sep;
  ort.env.wasm.wasmPaths = wasmDirectory;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  return {
    createTensor(type, data, dims) {
      return new ort.Tensor(type, data, [...dims]) as unknown as OrtTensorLike;
    },
    async createSession(modelBytesOrPath, executionProviders) {
      void executionProviders;
      return (await ort.InferenceSession.create(modelBytesOrPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })) as unknown as OrtSessionLike;
    },
  };
}

test('Silero VAD v5: real ONNX/WASM CPU inference detects speech on the pinned Persian sample', async () => {
  assert.ok(fs.existsSync(MODEL_PATH), 'pinned Silero VAD ONNX asset must be provisioned before the test');
  assert.ok(fs.existsSync(SAMPLE_WAV_PATH), 'pinned Persian sample WAV must be provisioned before the test');

  const modelBytes = fs.readFileSync(MODEL_PATH);
  const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
  const { pcm16k, durationSec } = decodeWavToMono16k(sampleBytes);
  assert.ok(pcm16k.length >= 16000, 'sample must contain at least one second of audio');

  const runner = new SileroVadOnnxRunner(createRealWasmOrtProvider());
  try {
    await runner.loadModel(new Uint8Array(modelBytes), ['wasm']);
    const startedAt = performance.now();
    const segments = await runner.detectSpeechSegments(pcm16k, {
      startThreshold: 0.5,
      endThreshold: 0.35,
      minSpeechMs: 100,
      minSilenceMs: 120,
      speechPadMs: 30,
    });
    const elapsedMs = performance.now() - startedAt;

    assert.ok(segments.length > 0, 'real Silero model must identify at least one speech segment');
    for (const segment of segments) {
      assert.ok(segment.startSample16k >= 0);
      assert.ok(segment.endSample16k <= pcm16k.length);
      assert.ok(segment.startSample16k < segment.endSample16k);
      assert.ok(segment.peakSpeechProb >= 0.5 && segment.peakSpeechProb <= 1);
    }

    const speechDurationSec = segments.reduce(
      (total, segment) =>
        total + (segment.endSample16k - segment.startSample16k) / 16000,
      0,
    );
    console.log(
      JSON.stringify({
        test: 'silero-vad-real-onnx',
        modelBytes: modelBytes.byteLength,
        sampleDurationSec: Number(durationSec.toFixed(3)),
        speechSegments: segments.length,
        speechDurationSec: Number(speechDurationSec.toFixed(3)),
        inferenceElapsedMs: Number(elapsedMs.toFixed(2)),
        rtf: Number((elapsedMs / (durationSec * 1000)).toFixed(4)),
        executionProvider: 'wasm-cpu',
      }),
    );
  } finally {
    await runner.unloadModel();
  }
});
