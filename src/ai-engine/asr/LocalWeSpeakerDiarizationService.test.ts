import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Bytes } from '../../utils/StreamingSha256';
import { LocalWeSpeakerDiarizationService } from './LocalWeSpeakerDiarizationService';
import type {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from './UnifiedOnnxPersianAsrEngine';

function createMockProvider(options: { failSpeakerLoad?: boolean } = {}) {
  let sessionIndex = 0;
  let releasedSessions = 0;
  const provider: OrtRuntimeProvider = {
    createTensor(type, data, dims) {
      return { type, data, dims };
    },
    async createSession(): Promise<OrtSessionLike> {
      const current = sessionIndex++;
      if (current === 1 && options.failSpeakerLoad) {
        throw new Error('MOCK_SPEAKER_MODEL_LOAD_FAILED');
      }
      return {
        async run(): Promise<Record<string, OrtTensorLike>> {
          if (current === 0) {
            return {
              output: {
                type: 'float32',
                data: new Float32Array([0.95]),
                dims: [1, 1],
              },
              stateN: {
                type: 'float32',
                data: new Float32Array(2 * 1 * 128),
                dims: [2, 1, 128],
              },
            };
          }

          const embedding = new Float32Array(192);
          embedding[0] = 1;
          return {
            embs: {
              type: 'float32',
              data: embedding,
              dims: [1, 192],
            },
          };
        },
        async release() {
          releasedSessions++;
        },
      };
    },
  };
  return {
    provider,
    get sessionsCreated() {
      return sessionIndex;
    },
    get releasedSessions() {
      return releasedSessions;
    },
  };
}

function asset(modelId: string, bytes: Uint8Array) {
  return {
    bytes,
    expectedByteLength: bytes.byteLength,
    expectedSha256Hex: sha256Bytes(bytes),
    modelId,
    modelVersion: 'test-1.0.0',
  };
}

test('local diarization verifies both model assets before opening ONNX sessions', async () => {
  const mock = createMockProvider();
  const service = new LocalWeSpeakerDiarizationService(mock.provider);
  const vadBytes = new Uint8Array([1, 2, 3]);
  const speakerBytes = new Uint8Array([4, 5, 6]);

  await assert.rejects(
    service.loadModels({
      vadModel: asset('silero-vad-v5', vadBytes),
      speakerEmbeddingModel: {
        ...asset('wespeaker-ecapa', speakerBytes),
        expectedSha256Hex: '0'.repeat(64),
      },
    }),
    /LOCAL_DIARIZATION_WESPEAKER_MODEL_SHA256_MISMATCH/,
  );

  assert.equal(mock.sessionsCreated, 0);
  assert.equal(service.getReadiness().ready, false);
});

test('local diarization loads, runs real pipeline wiring and unloads both local ONNX sessions', async () => {
  const mock = createMockProvider();
  const service = new LocalWeSpeakerDiarizationService(
    mock.provider,
    ['wasm'],
    {
      embeddingWindowDurationSec: 1.5,
      embeddingHopDurationSec: 0.75,
    },
  );
  const vadBytes = new Uint8Array([1, 2, 3]);
  const speakerBytes = new Uint8Array([4, 5, 6]);

  await service.loadModels({
    vadModel: asset('silero-vad-v5', vadBytes),
    speakerEmbeddingModel: asset('wespeaker-ecapa-tdnn512-lm', speakerBytes),
  });

  assert.equal(service.getReadiness().ready, true);
  assert.equal(mock.sessionsCreated, 2);

  const pcm = new Float32Array(2 * 16000).fill(0.05);
  const result = await service.diarize({
    recordingId: 'local-diarization-service-test',
    pcm16kMono: pcm,
  });

  assert.equal(result.provenance.modelId, 'wespeaker-ecapa-tdnn512-lm');
  assert.equal(result.provenance.adapterKind, 'LOCAL_CPU_ONNX_EMBEDDING_AHC');
  assert.equal(result.speakers.length, 1);
  assert.equal(result.speakers[0].speakerId, 'speaker_1');
  assert.ok(result.segments.length > 0);
  assert.ok(result.segments.every((segment) => segment.confidence === null));

  await service.dispose();
  assert.equal(service.getReadiness().ready, false);
  assert.equal(mock.releasedSessions, 2);
});

test('local diarization rolls back the VAD session when speaker model loading fails', async () => {
  const mock = createMockProvider({ failSpeakerLoad: true });
  const service = new LocalWeSpeakerDiarizationService(mock.provider);
  const vadBytes = new Uint8Array([1, 2, 3]);
  const speakerBytes = new Uint8Array([4, 5, 6]);

  await assert.rejects(
    service.loadModels({
      vadModel: asset('silero-vad-v5', vadBytes),
      speakerEmbeddingModel: asset('wespeaker-ecapa-tdnn512-lm', speakerBytes),
    }),
    /MOCK_SPEAKER_MODEL_LOAD_FAILED/,
  );
  assert.equal(service.getReadiness().ready, false);
  assert.equal(mock.releasedSessions, 1);
});
