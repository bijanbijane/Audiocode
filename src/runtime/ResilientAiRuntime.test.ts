import test from 'node:test';
import assert from 'node:assert/strict';
import { AntiAliasedResampler } from '../ai-engine/AntiAliasedResampler';
import { PersianAcousticSnapper } from '../audio-engine/PersianAcousticSnapper';
import { ChunkedModelDownloader, ChunkedModelManifest } from '../platform/ChunkedModelDelivery';
import { ResilientAiRuntimeManager } from './ResilientAiRuntime';

test('AntiAliasedResampler attenuates 14kHz high frequency before 16kHz ASR input', () => {
  const resampler = new AntiAliasedResampler(48000, 16000, 63);
  const len = 24000;
  const passTone = new Float32Array(len);
  const aliasTone = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    passTone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    aliasTone[i] = 0.5 * Math.sin((2 * Math.PI * 14000 * i) / 48000);
  }
  const outPass = resampler.processToMono16k([passTone]);
  const outAlias = resampler.processToMono16k([aliasTone]);
  const rms = (arr: Float32Array) =>
    Math.sqrt(arr.reduce((s, x) => s + x * x, 0) / Math.max(1, arr.length));

  const attenDb = 20 * Math.log10(Math.max(rms(outAlias), 1e-9) / rms(outPass));
  assert.ok(attenDb < -45, `Expected >45dB attenuation, got ${attenDb.toFixed(1)}dB`);
});

test('PersianAcousticSnapper matches rising slope zero-crossings and splices smoothly', () => {
  const sr = 48000;
  const buf = new Float32Array(2400);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr);
  }
  const leftEdge = PersianAcousticSnapper.snapToZeroCrossing(buf, 500, sr, true);
  const rightEdge = PersianAcousticSnapper.snapToZeroCrossing(buf, 1500, sr, true);
  assert.ok(buf[leftEdge - 1] < 0 && buf[leftEdge] >= 0);
  assert.ok(buf[rightEdge - 1] < 0 && buf[rightEdge] >= 0);

  const leftSeg = buf.slice(0, leftEdge);
  const rightSeg = buf.slice(rightEdge);
  const roomTone = new Float32Array(2400).fill(0.001);
  const spliced = PersianAcousticSnapper.applySeamlessSplice(leftSeg, rightSeg, roomTone, sr, 10, 0);
  assert.ok(spliced.length > 0);
});

test('ChunkedModelDownloader resumes from already verified chunks with zero duplicate fetch', async () => {
  const downloader = new ChunkedModelDownloader();
  const c0 = new Uint8Array([1, 2, 3, 4]).buffer;
  const c1 = new Uint8Array([5, 6, 7, 8]).buffer;

  const shaHex = async (buf: ArrayBuffer) => {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const manifest: ChunkedModelManifest = {
    modelId: 'persian-conformer-q5',
    version: '1.2.0',
    totalBytes: 8,
    chunks: [
      { index: 0, url: 'https://cdn.example/c0.bin', sha256Hex: await shaHex(c0), byteLength: 4 },
      { index: 1, url: 'https://cdn.example/c1.bin', sha256Hex: await shaHex(c1), byteLength: 4 },
    ],
  };

  // First run: fail on chunk 1 after chunk 0 succeeds
  let fetchesRun1 = 0;
  await assert.rejects(() =>
    downloader.downloadOrResumeModel(
      manifest,
      () => {},
      undefined,
      async (url) => {
        fetchesRun1++;
        if (url.endsWith('c0.bin')) return c0;
        throw new Error('NETWORK_DROP');
      },
      { retryPolicy: { maxRetries: 0 } },
    ),
  );
  assert.equal(fetchesRun1, 2);

  // Second run: chunk 0 is resumed without fetching, only chunk 1 is fetched!
  let fetchesRun2 = 0;
  const res = await downloader.downloadOrResumeModel(
    manifest,
    () => {},
    undefined,
    async (url) => {
      fetchesRun2++;
      return url.endsWith('c1.bin') ? c1 : c0;
    },
  );
  assert.equal(fetchesRun2, 1);
  assert.equal(res.resumedChunks, 1);
  assert.equal(res.completedChunks, 2);
});

test('ResilientAiRuntimeManager enforces Single-Active-Heavy-Model and falls back from WEBGPU to WASM_SIMD on GPUDevice.lost', async () => {
  const mgr = new ResilientAiRuntimeManager('WEBGPU');
  const unloaded: string[] = [];
  const checkpoints: number[] = [];

  // Run model A first
  await mgr.executeChunkedJobWithCheckpoint(
    'model-A',
    2,
    -1,
    async (idx, backend) => `${idx}:${backend}`,
    async (idx) => {
      checkpoints.push(idx);
    },
    async (prev) => {
      unloaded.push(prev);
    },
  );

  // Switch to model B: must unload model A, then fail on chunk 1 with WEBGPU and recover via WASM_SIMD
  const res = await mgr.executeChunkedJobWithCheckpoint(
    'model-B',
    3,
    -1,
    async (idx, backend) => {
      if (idx === 1 && backend === 'WEBGPU') {
        throw new Error('GPUDevice.lost');
      }
      return `${idx}:${backend}`;
    },
    async (idx) => {
      checkpoints.push(idx);
    },
    async (prev) => {
      unloaded.push(prev);
    },
  );

  assert.deepEqual(unloaded, ['model-A']);
  assert.equal(res.fallbackTriggered, true);
  assert.equal(res.finalBackend, 'WASM_SIMD');
  assert.deepEqual(checkpoints, [0, 1, 0, 1, 2]);
});
