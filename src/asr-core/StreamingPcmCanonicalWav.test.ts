import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resampleTo16kMono } from '../engine/resampler';
import { streamPcmSourceAsCanonicalWav } from './StreamingCanonicalPcmWav';
import { stagePcmSourceAsCanonicalWav } from './StreamingPcmCanonicalWavStager';

function buildTone(sampleRate: number, seconds: number): Float32Array {
  const samples = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.35 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return samples;
}

test('canonical WAV streamer resamples 48 kHz source in bounded range reads and emits a valid 16 kHz float WAV', async () => {
  const sampleRate = 48_000;
  const source = buildTone(sampleRate, 2);
  const received: Buffer[] = [];
  const readSizes: number[] = [];

  const result = await streamPcmSourceAsCanonicalWav({
    sampleRate,
    totalSamples: source.length,
    chunkSizeSamples: 4096,
    readSourceRange: async (start, count) => {
      readSizes.push(count);
      return source.subarray(start, start + count);
    },
    onWavChunk: (chunk) => { received.push(Buffer.from(chunk)); },
  });

  const wav = Buffer.concat(received);
  assert.equal(result.sampleCount, 32_000);
  assert.equal(wav.length, 44 + result.sampleCount * 4);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 3);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 32);
  assert.equal(wav.readUInt32LE(40), result.sampleCount * 4);
  assert.ok(readSizes.length > 1);
  assert.ok(Math.max(...readSizes) <= 4096);

  const reference = resampleTo16kMono([source], sampleRate, 16_000).samples;
  let squaredError = 0;
  for (let i = 0; i < reference.length; i++) {
    const actual = wav.readFloatLE(44 + i * 4);
    const delta = actual - reference[i];
    squaredError += delta * delta;
  }
  const rmse = Math.sqrt(squaredError / reference.length);
  assert.ok(rmse < 0.003, `streaming/offline resampler RMSE was ${rmse}`);
});

test('canonical WAV stager writes a private, size-verified file and cleans it up', async () => {
  const sampleRate = 16_000;
  const source = buildTone(sampleRate, 1);
  const staged = await stagePcmSourceAsCanonicalWav({
    sampleRate,
    totalSamples: source.length,
    readSourceRange: async (start, count) => source.subarray(start, start + count),
  });
  try {
    const stat = await fs.promises.stat(staged.filePath);
    assert.equal(stat.size, staged.totalWavBytes);
    assert.equal((stat.mode & 0o777), 0o600);
    assert.equal(staged.sampleCount, source.length);
    const fd = await fs.promises.open(staged.filePath, 'r');
    try {
      const header = Buffer.alloc(44);
      await fd.read(header, 0, header.length, 0);
      assert.equal(header.readUInt16LE(20), 3);
      assert.equal(header.readUInt32LE(24), 16_000);
    } finally {
      await fd.close();
    }
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(fs.promises.access(staged.directoryPath));
});

test('canonical WAV streamer propagates cancellation and rejects short range reads', async () => {
  const source = buildTone(16_000, 1);
  const controller = new AbortController();
  await assert.rejects(
    streamPcmSourceAsCanonicalWav({
      sampleRate: 16_000,
      totalSamples: source.length,
      signal: controller.signal,
      readSourceRange: async (start, count) => {
        controller.abort();
        return source.subarray(start, start + count);
      },
      onWavChunk: () => {},
    }),
    /TRANSCRIPTION_CANCELLED|RESAMPLE_ABORTED/,
  );
  await assert.rejects(
    streamPcmSourceAsCanonicalWav({
      sampleRate: 16_000,
      totalSamples: source.length,
      readSourceRange: async () => new Float32Array(2),
      onWavChunk: () => {},
    }),
    /SOURCE_RANGE_LENGTH_MISMATCH/,
  );
});
