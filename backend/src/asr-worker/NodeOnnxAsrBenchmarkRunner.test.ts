import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeOnnxAsrBenchmarkRunner } from './NodeOnnxAsrBenchmarkRunner';
import { OrtRuntimeProvider } from '../../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';

describe('Section 102: NodeOnnxAsrBenchmarkRunner & RIFF/WAV Studio Parser', () => {
  it('parses WAV files containing broadcast bext/JUNK metadata chunks before fmt and data', () => {
    const numSamples = 16000; // 1.0 sec @ 16kHz
    const bextPayload = Buffer.alloc(31, 0x41); // Odd length (31 bytes) to test RIFF even-byte padding
    const fmtSize = 16;
    const dataSize = numSamples * 2; // 16-bit mono
    const totalRiffPayload = 4 + (8 + 31 + 1) + (8 + fmtSize) + (8 + dataSize);

    const buf = Buffer.alloc(8 + totalRiffPayload);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(totalRiffPayload, 4);
    buf.write('WAVE', 8, 'ascii');

    let offset = 12;
    // 1. Broadcast Wave 'bext' chunk with odd length 31 + 1 pad byte
    buf.write('bext', offset, 'ascii');
    buf.writeUInt32LE(bextPayload.length, offset + 4);
    bextPayload.copy(buf, offset + 8);
    offset += 8 + bextPayload.length + 1;

    // 2. 'fmt ' chunk
    buf.write('fmt ', offset, 'ascii');
    buf.writeUInt32LE(fmtSize, offset + 4);
    buf.writeUInt16LE(1, offset + 8); // PCM
    buf.writeUInt16LE(1, offset + 10); // 1 channel
    buf.writeUInt32LE(16000, offset + 12); // 16000 Hz
    buf.writeUInt32LE(32000, offset + 16); // byteRate
    buf.writeUInt16LE(2, offset + 20); // blockAlign
    buf.writeUInt16LE(16, offset + 22); // 16-bit
    offset += 8 + fmtSize;

    // 3. 'data' chunk
    buf.write('data', offset, 'ascii');
    buf.writeUInt32LE(dataSize, offset + 4);
    offset += 8;
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * 16384);
      buf.writeInt16LE(sample, offset + i * 2);
    }

    const parsed = NodeOnnxAsrBenchmarkRunner.parseWavBufferToFloat32Channels(buf);
    assert.equal(parsed.sampleRate, 16000);
    assert.equal(parsed.channels.length, 1);
    assert.equal(parsed.channels[0].length, numSamples);

    // Run end-to-end benchmark with mock OrtRuntimeProvider
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paudio-wav-'));
    const wavPath = path.join(tmpDir, 'test_studio.wav');
    fs.writeFileSync(wavPath, buf);

    const vocab = ['<blank>', ' ', 'س', 'ل', 'ا', 'م'];
    const mockOrtProvider: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run() {
            const frames = 10;
            const V = vocab.length;
            const logits = new Float32Array(frames * V).fill(-10);
            // Emit "سلام"
            logits[1 * V + 2] = 5; // س
            logits[2 * V + 3] = 5; // ل
            logits[3 * V + 4] = 5; // ا
            logits[4 * V + 5] = 5; // م
            for (let t = 0; t < frames; t++) {
              if (t < 1 || t > 4) logits[t * V + 0] = 5;
            }
            return {
              logits: {
                type: 'float32',
                data: logits,
                dims: [1, frames, V],
              },
            };
          },
        };
      },
    };

    return NodeOnnxAsrBenchmarkRunner.runWavBenchmark({
      wavFilePath: wavPath,
      architecture: 'FASTCONFORMER_CTC',
      encoderModelPath: 'mock_encoder.onnx',
      ctcVocabulary: vocab,
      groundTruthReferenceText: 'سلام',
      customOrtProvider: mockOrtProvider,
    }).then((res) => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      assert.equal(res.audioDurationSeconds, 1);
      assert.equal(res.recognizedDisplayTranscript, 'سلام');
      assert.equal(res.normalizedWerPercent, 0);
      assert.ok(res.peakRssMemoryMb > 0);
    });
  });
});
