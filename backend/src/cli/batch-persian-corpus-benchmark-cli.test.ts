import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BatchPersianCorpusBenchmarkCli } from './batch-persian-corpus-benchmark-cli';
import { OrtRuntimeProvider } from '../../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';

describe('Section 117: BatchPersianCorpusBenchmarkCli', () => {
  it('audits corpus metadata, runs batch WAV benchmarks, and computes style-stratified WER baseline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paudio-bench117-'));
    const wavPath = path.join(tmpDir, 's1.wav');
    const txtPath = path.join(tmpDir, 's1.txt');

    // Create valid 0.5s 16kHz 16-bit mono WAV
    const numSamples = 8000;
    const dataSize = numSamples * 2;
    const wavBuf = Buffer.alloc(44 + dataSize);
    wavBuf.write('RIFF', 0);
    wavBuf.writeUInt32LE(36 + dataSize, 4);
    wavBuf.write('WAVE', 8);
    wavBuf.write('fmt ', 12);
    wavBuf.writeUInt32LE(16, 16);
    wavBuf.writeUInt16LE(1, 20);
    wavBuf.writeUInt16LE(1, 22);
    wavBuf.writeUInt32LE(16000, 24);
    wavBuf.writeUInt32LE(32000, 28);
    wavBuf.writeUInt16LE(2, 32);
    wavBuf.writeUInt16LE(16, 34);
    wavBuf.write('data', 36);
    wavBuf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * 16384);
      wavBuf.writeInt16LE(sample, 44 + i * 2);
    }
    fs.writeFileSync(wavPath, wavBuf);
    fs.writeFileSync(txtPath, 'سلام', 'utf8');

    const vocab = ['<blank>', ' ', 'س', 'ل', 'ا', 'م'];
    const mockOrt: OrtRuntimeProvider = {
      createTensor(type, data, dims) {
        return { type, data, dims };
      },
      async createSession() {
        return {
          async run() {
            const frames = 6;
            const V = vocab.length;
            const logits = new Float32Array(frames * V).fill(-10);
            logits[1 * V + 2] = 5;
            logits[2 * V + 3] = 5;
            logits[3 * V + 4] = 5;
            logits[4 * V + 5] = 5;
            logits[0 * V + 0] = 5;
            logits[5 * V + 0] = 5;
            return {
              logits: { type: 'float32', data: logits, dims: [1, frames, V] },
            };
          },
        };
      },
    };

    const report = await BatchPersianCorpusBenchmarkCli.executeFullCorpusBaseline({
      modelId: 'conformer-fa-v1',
      modelVersion: '1.0.0',
      architecture: 'FASTCONFORMER_CTC',
      encoderModelPath: 'mock.onnx',
      ctcVocabulary: vocab,
      customOrtProvider: mockOrt,
      datasetItems: [
        {
          wavFilePath: wavPath,
          groundTruthTranscriptPath: txtPath,
          meta: {
            sampleId: 'sample_formal_1',
            legalLicenseSource: 'CC-BY-4.0',
            speakerConsentVerified: true,
            style: 'FORMAL',
            accentOrDialectRegion: 'تهرانی',
            genre: 'PODCAST',
            speakingRate: 'NORMAL',
            noiseTier: 'CLEAN_STUDIO',
            durationClass: 'SHORT_UNDER_3MIN',
            speakerCount: 1,
            containsStuttersAndFillers: false,
            containsLongPauses: false,
            containsEzafeChains: true,
            audioDurationSeconds: 0.5,
          },
        },
      ],
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    assert.equal(report.perSampleResults.length, 1);
    assert.equal(report.durationWeightedNormalizedWerPercent, 0);
    assert.equal(report.breakdownByStyle.formalNormalizedWerPercent, 0);
  });
});
