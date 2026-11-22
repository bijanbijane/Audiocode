import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SileroVadOnnxRunner } from './SileroVadOnnxRunner';
import { OrtRuntimeProvider } from './UnifiedOnnxPersianAsrEngine';

describe('Section 105: SileroVadOnnxRunner (Silero v5 ONNX + LSTM State Carryover + Batch Consolidation)', () => {
  it('verifies [1, 576] context-padded input tensor, carries [2, 1, 128] LSTM state, and builds consolidated ASR batches', async () => {
    let observedInputDims: readonly number[] = [];
    let observedStateStep = 0;

    const mockOrtProvider: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run(feeds) {
            observedInputDims = feeds.input.dims;
            const inputData = feeds.input.data as Float32Array;
            const prevState = feeds.state.data as Float32Array;
            observedStateStep = prevState[0];

            // Compute energy of active 512-sample window (after 64 context samples)
            let energy = 0;
            for (let i = 64; i < inputData.length; i++) {
              energy += inputData[i] * inputData[i];
            }
            const rms = Math.sqrt(energy / 512);
            const prob = rms > 0.05 ? 0.92 : 0.04;

            const nextState = new Float32Array(2 * 1 * 128);
            nextState[0] = prevState[0] + 1;

            return {
              output: {
                type: 'float32',
                data: new Float32Array([prob]),
                dims: [1, 1],
              },
              stateN: {
                type: 'float32',
                data: nextState,
                dims: [2, 1, 128],
              },
            };
          },
        };
      },
    };

    // Build 3.0 seconds of 16kHz audio with two speech islands: [0.3s..0.9s] and [1.8s..2.5s]
    const pcm = new Float32Array(16000 * 3);
    for (let i = Math.floor(0.3 * 16000); i < Math.floor(0.9 * 16000); i++) {
      pcm[i] = 0.25 * Math.sin((2 * Math.PI * 200 * i) / 16000);
    }
    for (let i = Math.floor(1.8 * 16000); i < Math.floor(2.5 * 16000); i++) {
      pcm[i] = 0.3 * Math.sin((2 * Math.PI * 240 * i) / 16000);
    }

    const vad = new SileroVadOnnxRunner(mockOrtProvider);
    await vad.loadModel(new Uint8Array([0, 1, 2]));

    const segments = await vad.detectSpeechSegments(pcm);
    await vad.unloadModel();

    assert.deepEqual(observedInputDims, [1, 576]);
    assert.ok(observedStateStep > 80, 'LSTM state must increment across frames');
    assert.equal(segments.length, 2);
    assert.equal(segments[0].peakSpeechProb, 0.92);

    const batches = SileroVadOnnxRunner.buildConsolidatedAsrBatches(pcm, segments, 25.0);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].offsetMappings.length, 2);
    assert.ok(batches[0].concatenated16kPcm.length < pcm.length);
  });

  it('does not split speech when weak frames remain above the end threshold', async () => {
    const frameProbabilities = [
      ...Array(10).fill(0.92),
      0.04,
      0.04,
      0.4,
      0.04,
      0.04,
      0.04,
      0.92,
      0.92,
      0.92,
      0.92,
    ];
    let frameIndex = 0;

    const mockOrtProvider: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run() {
            const prob = frameProbabilities[frameIndex++] ?? 0.92;
            return {
              output: {
                type: 'float32',
                data: new Float32Array([prob]),
                dims: [1, 1],
              },
              stateN: {
                type: 'float32',
                data: new Float32Array(2 * 1 * 128),
                dims: [2, 1, 128],
              },
            };
          },
        };
      },
    };

    const pcm = new Float32Array(frameProbabilities.length * 512);
    const vad = new SileroVadOnnxRunner(mockOrtProvider);
    await vad.loadModel(new Uint8Array([0, 1, 2]));

    const segments = await vad.detectSpeechSegments(pcm, {
      minSilenceMs: 120,
      speechPadMs: 0,
    });
    await vad.unloadModel();

    assert.equal(frameIndex, frameProbabilities.length);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].startSample16k, 0);
    assert.equal(segments[0].endSample16k, pcm.length);
  });

});
