import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { CompanionWebClient } from '../CompanionWebClient';
import { LocalCompanionService } from '../LocalCompanionService';
import { LocalSherpaNeuralEngine as RealLocalSherpaNeuralEngine } from '../../../asr-core/LocalSherpaNeuralEngine';
import type {
  InstalledLocalNeuralModel,
  LocalNeuralRuntimeStatus,
  LocalNeuralTranscriptionRequest,
  LocalNeuralTranscriptionResult,
  LocalSherpaNeuralEngine,
} from '../../../asr-core/LocalSherpaNeuralEngine';

const MODEL: InstalledLocalNeuralModel = {
  modelId: 'test/shahab-persian-fixture',
  profileId: 'AVP_MODEL_QUALITY',
  displayName: 'Test Persian CTC',
  architecture: 'nemo-ctc',
  quantization: 'FP32',
  licenseSpdx: 'Apache-2.0',
  supportedLanguages: ['fa'],
  supportsNativeWordTimestamps: true,
  rootDir: '/test/model',
  diskSizeBytes: 1024,
  requiredFiles: [],
  integrityVerified: true,
  extraCliArgs: [],
};

function makeMockEngine(onTranscribe: (request: LocalNeuralTranscriptionRequest) => Promise<LocalNeuralTranscriptionResult>) {
  const status: LocalNeuralRuntimeStatus = {
    runtimeName: 'sherpa-onnx-cpu',
    binaryPath: '/test/sherpa-onnx-offline',
    libDir: null,
    available: true,
    offlineOnlyEnforced: true,
    cpuThreads: 4,
    activeModelId: null,
    installedModels: [MODEL],
    processRssMb: 64,
  };
  return {
    getStatus: () => status,
    getBundledSampleAudioPath: () => null,
    selectModel: () => MODEL,
    transcribe: onTranscribe,
    unloadActiveModel: () => ({ unloaded: true }),
  } as unknown as LocalSherpaNeuralEngine;
}

test('Browser Companion client streams a 48 kHz source through file-backed transfer and the native ASR job without full-file PCM allocation', async () => {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-streaming-client-test-'));
  let receivedAudioPath: string | null = null;
  let receivedAudioBytes = 0;
  let receivedFrames = 0;
  let maxRequestedSamples = 0;

  const engine = makeMockEngine(async (request) => {
    assert.ok(request.audioFilePath, 'Companion must pass a file-backed source to the engine');
    receivedAudioPath = request.audioFilePath!;
    const stat = await fs.promises.stat(receivedAudioPath);
    receivedAudioBytes = stat.size;
    const headerHandle = await fs.promises.open(receivedAudioPath, 'r');
    try {
      const header = Buffer.alloc(44);
      await headerHandle.read(header, 0, header.length, 0);
      assert.equal(header.toString('ascii', 0, 4), 'RIFF');
      assert.equal(header.toString('ascii', 8, 12), 'WAVE');
      assert.equal(header.readUInt16LE(20), 3, 'canonical transfer is IEEE Float32 WAV');
      assert.equal(header.readUInt16LE(22), 1);
      assert.equal(header.readUInt32LE(24), 16_000);
      assert.equal(header.readUInt16LE(34), 32);
      receivedFrames = header.readUInt32LE(40) / 4;
    } finally {
      await headerHandle.close();
    }

    const text = 'سلام. این یک آزمون انتقال جریانی شهاب است.';
    const profiles = {
      RAW_UNMODIFIED: text,
      'FA-STRICT-V1': text,
      'FA-RELAXED-V1': text,
      'EN-NORM-V1': text,
      'MIXED-NORM-V1': text,
    };
    return {
      modelId: MODEL.modelId,
      architecture: 'nemo-ctc',
      quantization: 'FP32',
      offlineVerified: true,
      durationSec: 10,
      processingTimeMs: 125,
      realTimeFactor: 0.0125,
      dominantLanguage: 'fa',
      rawText: text,
      normalizedByProfile: profiles,
      timestampGranularity: 'SEGMENT',
      segments: [{
        id: 'seg_0',
        index: 0,
        startSec: 0,
        endSec: 10,
        text,
        normalizedByProfile: profiles,
        language: 'fa',
        timestampGranularity: 'SEGMENT',
        words: [],
      }],
      sampleRateHz: 16_000,
      channelCount: 1,
      audioSha256: 'a'.repeat(64),
    };
  });

  const service = new LocalCompanionService({
    neuralEngine: engine,
    transferStagingDir: stagingDir,
    maxTransferBytes: 512 * 1024 * 1024,
    maxTotalStagingBytes: 1024 * 1024 * 1024,
  });
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const client = new CompanionWebClient(`http://127.0.0.1:${port}/api/v2/companion`);
    const sampleRate = 48_000;
    const source = new Float32Array(sampleRate * 10);
    for (let i = 0; i < source.length; i++) {
      source[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const result = await client.transcribeAudioSource({
      sampleRate,
      totalSamples: source.length,
      filename: 'long-persian-recording.wav',
      languageHint: 'fa',
      modelId: MODEL.modelId,
      readSourceRange: async (startSample, count) => {
        maxRequestedSamples = Math.max(maxRequestedSamples, count);
        return source.subarray(startSample, startSample + count);
      },
    });

    assert.equal(result.rawText, 'سلام. این یک آزمون انتقال جریانی شهاب است.');
    assert.equal(result.modelId, MODEL.modelId);
    assert.equal(receivedFrames, 160_000);
    assert.equal(receivedAudioBytes, 44 + 160_000 * 4);
    assert.ok(maxRequestedSamples <= 16_384, `source range unexpectedly large: ${maxRequestedSamples}`);
    assert.ok(maxRequestedSamples < source.length, 'the client must never request the entire recording');
    assert.equal(service.audioTransfers.getActiveSessionCount(), 0, 'transfer source must be released after the job');
    assert.ok(receivedAudioPath, 'the native engine should receive a staged file path');
    await assert.rejects(fs.promises.access(receivedAudioPath!), 'staged transfer must be cleaned after inference');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('real SHAHAB Koochik inference completes end-to-end through streamed Browser-to-Companion upload', {
  skip: (() => {
    const probe = new RealLocalSherpaNeuralEngine();
    const status = probe.getStatus();
    return !status.available || !status.installedModels.some((model: InstalledLocalNeuralModel) =>
      model.modelId === 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx' && model.integrityVerified,
    );
  })(),
}, async () => {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-shahab-e2e-streaming-'));
  const fixturePath = path.join(process.cwd(), 'e2e', 'fixtures', 'shahab-fleurs-fa-ir-test.wav');
  const fixture = await fs.promises.readFile(fixturePath);
  assert.equal(fixture.toString('ascii', 0, 4), 'RIFF');
  const channels = fixture.readUInt16LE(22);
  const sampleRate = fixture.readUInt32LE(24);
  const bitsPerSample = fixture.readUInt16LE(34);
  const dataOffset = fixture.indexOf(Buffer.from('data')) + 8;
  assert.equal(channels, 1);
  assert.equal(sampleRate, 16_000);
  assert.equal(bitsPerSample, 16);
  const sampleCount = Math.floor((fixture.length - dataOffset) / 2);
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) pcm[i] = fixture.readInt16LE(dataOffset + i * 2) / 32768;

  const service = new LocalCompanionService({
    neuralEngine: new RealLocalSherpaNeuralEngine(),
    transferStagingDir: stagingDir,
    maxTransferBytes: 512 * 1024 * 1024,
    maxTotalStagingBytes: 1024 * 1024 * 1024,
  });
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const client = new CompanionWebClient(`http://127.0.0.1:${port}/api/v2/companion`);
    let largestRead = 0;
    const result = await client.transcribeAudioSource({
      sampleRate,
      totalSamples: pcm.length,
      filename: 'shahab-fleurs-fa-ir-test.wav',
      languageHint: 'fa',
      readSourceRange: async (start, count) => {
        largestRead = Math.max(largestRead, count);
        return pcm.subarray(start, start + count);
      },
    });

    assert.match(result.rawText, /کشتی\s*گیران همکار نیز به لونا ادای احترام کردند/);
    assert.equal(result.timestampGranularity, 'SEGMENT');
    assert.equal(service.audioTransfers.getActiveSessionCount(), 0);
    assert.ok(largestRead <= 16_384);
    assert.ok(largestRead < pcm.length);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});
