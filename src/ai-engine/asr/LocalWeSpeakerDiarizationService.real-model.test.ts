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
import { decodeWavToMono16k } from '../../shahab/ShahabZipformerEngine';
import { LocalWeSpeakerDiarizationService } from './LocalWeSpeakerDiarizationService';

const VAD_MODEL_PATH = path.resolve(process.cwd(), 'models/silero-vad/1.0.0/silero_vad.onnx');
const SPEAKER_MODEL_PATH = path.resolve(
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

test(
  'Local WeSpeaker service: real Silero VAD + real ECAPA ONNX models diarize the pinned audio sample on CPU/WASM',
  { skip: fs.existsSync(VAD_MODEL_PATH) && fs.existsSync(SPEAKER_MODEL_PATH) && fs.existsSync(SAMPLE_WAV_PATH)
      ? false
      : 'Pinned VAD, speaker model and WAV sample are provisioned only in the product model-smoke workflow' },
  async () => {
    const vadBytes = new Uint8Array(fs.readFileSync(VAD_MODEL_PATH));
    const speakerBytes = new Uint8Array(fs.readFileSync(SPEAKER_MODEL_PATH));
    const sampleBytes = fs.readFileSync(SAMPLE_WAV_PATH);
    const { pcm16k, durationSec } = decodeWavToMono16k(sampleBytes);

    const service = new LocalWeSpeakerDiarizationService(
      createRealWasmOrtProvider(),
      ['wasm'],
      {
        vadMinSpeechMs: 100,
        vadMinSilenceMs: 120,
        vadSpeechPadMs: 30,
        embeddingWindowDurationSec: 1.5,
        embeddingHopDurationSec: 0.75,
      },
    );

    try {
      await service.loadModels({
        vadModel: {
          bytes: vadBytes,
          expectedByteLength: 2327524,
          expectedSha256Hex: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
          modelId: 'silero-vad-v5',
          modelVersion: '1.0.0+ab3ea3fe',
        },
        speakerEmbeddingModel: {
          bytes: speakerBytes,
          expectedByteLength: 24861931,
          expectedSha256Hex: 'd71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0',
          modelId: 'wespeaker-ecapa-tdnn512-lm',
          modelVersion: '1.0.0+a2f3dcb1',
        },
      });

      assert.equal(service.getReadiness().ready, true);
      const startedAt = performance.now();
      const result = await service.diarize({
        recordingId: 'wespeaker-local-service-real-smoke',
        pcm16kMono: pcm16k,
      });
      const elapsedMs = performance.now() - startedAt;

      assert.equal(result.provenance.modelId, 'wespeaker-ecapa-tdnn512-lm');
      assert.equal(result.provenance.adapterKind, 'LOCAL_CPU_ONNX_EMBEDDING_AHC');
      assert.ok(result.segments.length > 0, 'real VAD speech intervals must be returned');
      assert.ok(result.speakers.length > 0, 'real speaker embeddings must create at least one anonymous cluster');
      assert.ok(result.segments.every((segment) => segment.confidence === null));
      assert.ok(
        result.segments.every(
          (segment) => segment.speakerId === 'UNKNOWN_SPEAKER' || /^speaker_\d+$/.test(segment.speakerId),
        ),
        'speaker labels must be anonymous and recording-local',
      );

      console.log(
        JSON.stringify({
          test: 'wespeaker-local-service-real-onnx',
          sampleDurationSec: Number(durationSec.toFixed(3)),
          assignedSpeakerCount: result.speakers.length,
          outputSegmentCount: result.segments.length,
          unassignedDurationSec: result.unassignedDurationSec,
          inferenceElapsedMs: Number(elapsedMs.toFixed(2)),
          rtf: Number((elapsedMs / (durationSec * 1000)).toFixed(4)),
          executionProvider: 'wasm-cpu',
        }),
      );
    } finally {
      await service.dispose();
    }
  },
);
