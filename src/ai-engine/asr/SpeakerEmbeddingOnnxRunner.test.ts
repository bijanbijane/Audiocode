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

  it('supports waveform-native ONNX speaker models with explicit waveform and length tensors', async () => {
    const mockOrt: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run(feeds) {
            assert.deepEqual(feeds.wav.dims, [1, 8000]);
            assert.deepEqual(feeds.lens.dims, [1]);
            assert.equal((feeds.lens.data as Float32Array)[0], 1);
            return {
              emb: {
                type: 'float32',
                data: new Float32Array([3, 4]),
                dims: [1, 1, 2],
              },
            };
          },
        };
      },
    };

    const runner = new SpeakerEmbeddingOnnxRunner(
      mockOrt,
      'wav',
      'B_T_M',
      'WAVEFORM',
      'lens',
      'emb',
    );
    await runner.loadModel(new Uint8Array([1, 2, 3]), ['wasm']);

    const pcm = new Float32Array(8000);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000);
    }
    const extracted = await runner.extractEmbeddingsForVadSegments(pcm, [
      {
        startSample16k: 0,
        endSample16k: pcm.length,
        range: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
        peakSpeechProb: 0.9,
      },
    ]);
    await runner.unloadModel();

    assert.equal(extracted.length, 1);
    assert.ok(Math.abs(extracted[0].embeddingVector[0] - 0.6) < 1e-4);
    assert.ok(Math.abs(extracted[0].embeddingVector[1] - 0.8) < 1e-4);
  });


  it('validates embedding dimensions, norms and clustering parameters before AHC', () => {
    const validFrame = {
      range: { start: 0, end: TimeMath.secondsToFlicks(1) },
      embeddingVector: new Float32Array([1, 0]),
      vadProbability: 0.9,
    };

    assert.throws(
      () =>
        SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc('track-ahc', [
          validFrame,
          {
            ...validFrame,
            range: {
              start: TimeMath.secondsToFlicks(2),
              end: TimeMath.secondsToFlicks(3),
            },
            embeddingVector: new Float32Array([1, 0, 0]),
          },
        ]),
      /SPEAKER_AHC_EMBEDDING_DIMENSION_MISMATCH/,
    );
    assert.throws(
      () =>
        SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc('track-ahc', [
          { ...validFrame, embeddingVector: new Float32Array([0, 0]) },
        ]),
      /SPEAKER_AHC_EMBEDDING_ZERO_OR_INVALID_NORM/,
    );
    assert.throws(
      () =>
        SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc(
          'track-ahc',
          [validFrame],
          1.1,
        ),
      /SPEAKER_AHC_COSINE_THRESHOLD_MUST_BE_BETWEEN_MINUS_ONE_AND_ONE/,
    );
    assert.throws(
      () =>
        SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc(
          'track-ahc',
          [validFrame],
          0.68,
          0,
        ),
      /SPEAKER_AHC_MAX_SPEAKERS_MUST_BE_A_POSITIVE_INTEGER/,
    );
  });


  it('uses the dedicated Kaldi FBANK frontend for WeSpeaker feature-input models', async () => {
    const mockOrt: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run(feeds) {
            assert.deepEqual(feeds.feats.dims, [1, 150, 80]);
            const features = feeds.feats.data as Float32Array;
            for (let mel = 0; mel < 80; mel++) {
              let mean = 0;
              for (let frame = 0; frame < 150; frame++) {
                mean += features[frame * 80 + mel];
              }
              assert.ok(Math.abs(mean / 150) < 1e-4);
            }
            return {
              embs: {
                type: 'float32',
                data: new Float32Array([3, 4]),
                dims: [1, 2],
              },
            };
          },
        };
      },
    };

    const runner = new SpeakerEmbeddingOnnxRunner(
      mockOrt,
      'feats',
      'B_T_M',
      'KALDI_FBANK',
      'lens',
      'embs',
    );
    await runner.loadModel(new Uint8Array([1, 2, 3]), ['wasm']);

    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000);
    }
    const extracted = await runner.extractEmbeddingsForVadSegments(pcm, [
      {
        startSample16k: 0,
        endSample16k: pcm.length,
        range: { start: 0, end: TimeMath.secondsToFlicks(1) },
        peakSpeechProb: 0.9,
      },
    ]);
    await runner.unloadModel();

    assert.equal(extracted.length, 1);
    assert.ok(Math.abs(extracted[0].embeddingVector[0] - 0.6) < 1e-4);
    assert.ok(Math.abs(extracted[0].embeddingVector[1] - 0.8) < 1e-4);
  });

});
