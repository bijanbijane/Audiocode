import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerEmbeddingOnnxRunner } from './SpeakerEmbeddingOnnxRunner';
import { OrtRuntimeProvider } from './UnifiedOnnxPersianAsrEngine';
import { TimeMath } from '../../contracts/timebase.contract';
import { TrackId } from '../../contracts/project-schema.contract';

describe('Section 113: SpeakerEmbeddingOnnxRunner & Hierarchical AHC Clustering', () => {
  it('extracts L2-normalized embeddings with CMVN and clusters alternating speakers accurately via AHC', async () => {
    const mockOrt: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run(feeds) {
            const feats = feeds.feats.data as Float32Array;
            // Verify CMVN zero-mean property across frames
            let sumFirstBin = 0;
            const T = feeds.feats.dims[1];
            const M = feeds.feats.dims[2];
            for (let t = 0; t < T; t++) sumFirstBin += feats[t * M + 0];
            assert.ok(Math.abs(sumFirstBin / T) < 1e-3, 'CMVN per-bin mean must be ~0');

            return {
              embs: {
                type: 'float32',
                data: new Float32Array([3.0, 4.0, 0.0, 0.0]),
                dims: [1, 4],
              },
            };
          },
        };
      },
    };

    const runner = new SpeakerEmbeddingOnnxRunner(mockOrt, 'feats', 'B_T_M');
    await runner.loadModel(new Uint8Array([1, 2]), ['wasm']);

    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000);

    const vadSegment = {
      startSample16k: 0,
      endSample16k: 16000,
      range: { start: 0, end: TimeMath.secondsToFlicks(1.0) },
      peakSpeechProb: 0.95,
    };

    await assert.rejects(
      runner.extractEmbeddingsForVadSegments(pcm, [vadSegment], 1.5, 0),
      /SPEAKER_EMBEDDING_HOP_MUST_BE_POSITIVE_AND_NOT_EXCEED_WINDOW/,
    );
    await assert.rejects(
      runner.extractEmbeddingsForVadSegments(pcm, [vadSegment], 0.5, 1),
      /SPEAKER_EMBEDDING_HOP_MUST_BE_POSITIVE_AND_NOT_EXCEED_WINDOW/,
    );
    await assert.rejects(
      runner.extractEmbeddingsForVadSegments(
        pcm,
        [{ ...vadSegment, endSample16k: pcm.length + 1 }],
      ),
      /SPEAKER_EMBEDDING_VAD_SEGMENT_OUT_OF_AUDIO_BOUNDS/,
    );

    const extracted = await runner.extractEmbeddingsForVadSegments(pcm, [vadSegment]);
    await runner.unloadModel();

    assert.equal(extracted.length, 1);
    // [3, 4, 0, 0] L2 normalized -> [0.6, 0.8, 0, 0]
    assert.ok(Math.abs(extracted[0].embeddingVector[0] - 0.6) < 1e-4);
    assert.ok(Math.abs(extracted[0].embeddingVector[1] - 0.8) < 1e-4);

    // Test AHC clustering on 4 turns: Speaker A, Speaker B, Speaker A, Speaker B
    const segments = SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc(
      'trk_1' as TrackId,
      [
        {
          range: { start: 0, end: 100 },
          embeddingVector: new Float32Array([0.99, 0.1, 0, 0]),
          vadProbability: 0.95,
        },
        {
          range: { start: 200, end: 300 },
          embeddingVector: new Float32Array([0.05, 0.99, 0, 0]),
          vadProbability: 0.94,
        },
        {
          range: { start: 400, end: 500 },
          embeddingVector: new Float32Array([0.98, 0.12, 0, 0]),
          vadProbability: 0.96,
        },
        {
          range: { start: 600, end: 700 },
          embeddingVector: new Float32Array([0.08, 0.98, 0, 0]),
          vadProbability: 0.93,
        },
      ],
      0.75,
    );

    assert.deepEqual(
      segments.map((s) => s.speakerId),
      ['SPEAKER_1', 'SPEAKER_2', 'SPEAKER_1', 'SPEAKER_2'],
    );
  });
});
