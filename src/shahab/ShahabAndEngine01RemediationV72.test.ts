/**
 * AVAPARDAZ — V7.2 FORENSIC AUDIT REMEDIATION REGRESSION SUITE
 *
 * Verifies every V7.2 remediation across SHAHAB ASR Engine, ENGINE 01 Audio Core,
 * and SHAHAB <-> ENGINE 01 security/data boundaries with real behavioral assertions:
 *  - SEC-01: Legacy v1 ASR/processing/benchmark route protection & hosted benchmark block
 *  - SEC-02: /api/shahab/{state,memory,operations/*} mandatory auth, admin scope & replay protection
 *  - SEC-03: AudioApiSecurityGuard X-Forwarded-Host trust-boundary closure in local proxy mode
 *  - REM-04: Anti-aliased client WAV resampling, honest confidence/alignmentSource, full-audio chunk hash
 *  - REM-05: Full NaN/Infinity PCM scan, RF64 + WAVE_FORMAT_EXTENSIBLE (0xFFFE), truncated WAV rejection,
 *            anti-aliased engine WAV resampling, bounded 1 MiB SHA-256 weight check, path guard
 *  - REM-06: Zero-FFmpeg native WAV fast path in SmartAudioEditPipeline, CoreAudioIngestion rawPcm16 guard
 *            & orphaned temp directory cleanup
 *  - REM-07: Tenant-scoped SHAHAB encoder cache isolation, strict X-Project-Id validation (400) & filtering
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  AudioApiSecurityGuard,
  issueSignedAudioSessionToken,
} from '../security/AudioApiSecurityGuard';
import {
  encodeMonoFloat32To16kWavBytes,
  mapShahabResponseToPersianWordTokens,
  transcribePcmWithShahabLocal,
  type ShahabServerTranscribeResponse,
} from '../asr-core/ShahabLocalHttpClient';
import {
  SHAHABFrozenModelAdapter,
  SHAHABMemoryGovernor,
  decodeWavToMono16k,
  serializeCacheIdentity,
  type ShahabCacheIdentityKey,
  type ShahabEncoderOutputTensor,
} from './ShahabZipformerEngine';
import {
  ShahabZipformerAsrRuntime,
  ShahabZipformerRuntimeError,
} from './ShahabZipformerAsrRuntime';
import { createShahabHttpRouter, type ShahabTranscribeBackend } from './ShahabHttpRouter';
import { decodeNativeWavToPlanar } from '../workflow/WavNativeDecoder';
import { SmartAudioEditPipeline, SmartAudioEditError } from '../workflow/SmartAudioEditPipeline';
import { SmartAudioEditJobManager } from '../workflow/SmartAudioEditJobManager';
import { createSmartAudioEditHttpRouter } from '../workflow/SmartAudioEditHttpRouter';
import type { ShahabAsrEngine } from '../workflow/SmartAudioEditContracts';
import {
  cleanupOrphanedCoreIngestionTempFiles,
  ingestAudioBufferToCanonical16kMono,
} from '../asr-core/CoreAudioIngestion';

const TEST_HOSTED_SECRET = 'v72-remediation-hosted-secret-at-least-32-bytes!';

function freshNonceHeaders(nowMs = Date.now()): Record<string, string> {
  return {
    'X-Request-Nonce': `v72_${crypto.randomBytes(12).toString('hex')}`,
    'X-Request-Timestamp': String(nowMs),
  };
}

async function rawHttpRequest(params: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer | string;
}): Promise<{
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  readonly json: any;
}> {
  return new Promise((resolve, reject) => {
    const payload =
      params.body === undefined
        ? undefined
        : Buffer.isBuffer(params.body)
          ? params.body
          : Buffer.from(params.body, 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: params.port,
        method: params.method,
        path: params.path,
        headers: {
          ...(payload ? { 'Content-Length': String(payload.byteLength) } : {}),
          ...params.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json: any = null;
          if (String(res.headers['content-type'] ?? '').includes('application/json') && buf.byteLength > 0) {
            try {
              json = JSON.parse(buf.toString('utf8'));
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
}

function buildPcm16Wav(params: {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly sampleFn?: (frame: number, ch: number) => number;
}): Buffer {
  const bytesPerSample = 2;
  const frameBytes = bytesPerSample * params.channels;
  const dataSize = params.frames * frameBytes;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(params.channels, 22);
  buf.writeUInt32LE(params.sampleRate, 24);
  buf.writeUInt32LE(params.sampleRate * frameBytes, 28);
  buf.writeUInt16LE(frameBytes, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < params.frames; i++) {
    for (let c = 0; c < params.channels; c++) {
      const s = params.sampleFn ? params.sampleFn(i, c) : Math.sin((2 * Math.PI * 440 * i) / params.sampleRate) * 0.4;
      const clamped = Math.max(-1, Math.min(1, s));
      buf.writeInt16LE(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), 44 + (i * params.channels + c) * 2);
    }
  }
  return buf;
}

function buildRf64Pcm16Wav(sampleRate: number, frames: number): Buffer {
  const dataSize = frames * 2;
  // RF64 header (12) + ds64 chunk (8+28=36) + fmt chunk (8+16=24) + data header (8) + payload
  const totalLen = 12 + 36 + 24 + 8 + dataSize;
  const buf = Buffer.alloc(totalLen);
  buf.write('RF64', 0, 'ascii');
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write('WAVE', 8, 'ascii');
  // ds64 chunk
  buf.write('ds64', 12, 'ascii');
  buf.writeUInt32LE(28, 16);
  buf.writeBigUInt64LE(BigInt(totalLen - 8), 20); // riffSize
  buf.writeBigUInt64LE(BigInt(dataSize), 28); // dataSize
  buf.writeBigUInt64LE(BigInt(frames), 36); // sampleCount
  buf.writeUInt32LE(0, 44); // tableLength
  // fmt chunk
  const fmtOff = 48;
  buf.write('fmt ', fmtOff, 'ascii');
  buf.writeUInt32LE(16, fmtOff + 4);
  buf.writeUInt16LE(1, fmtOff + 8);
  buf.writeUInt16LE(1, fmtOff + 10);
  buf.writeUInt32LE(sampleRate, fmtOff + 12);
  buf.writeUInt32LE(sampleRate * 2, fmtOff + 16);
  buf.writeUInt16LE(2, fmtOff + 20);
  buf.writeUInt16LE(16, fmtOff + 22);
  // data chunk with RF64 0xffffffff marker
  const dataOff = fmtOff + 24;
  buf.write('data', dataOff, 'ascii');
  buf.writeUInt32LE(0xffffffff, dataOff + 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 500 * i) / sampleRate) * 12000);
    buf.writeInt16LE(v, dataOff + 8 + i * 2);
  }
  return buf;
}

function buildWaveFormatExtensibleWav(params: {
  readonly sampleRate: number;
  readonly frames: number;
  readonly subFormat: 1 | 3; // 1 = PCM16, 3 = IEEE Float32
}): Buffer {
  const bitsPerSample = params.subFormat === 1 ? 16 : 32;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = params.frames * bytesPerSample;
  const fmtChunkSize = 40;
  const buf = Buffer.alloc(12 + 8 + fmtChunkSize + 8 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.byteLength - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(fmtChunkSize, 16);
  buf.writeUInt16LE(0xfffe, 20); // WAVE_FORMAT_EXTENSIBLE
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(params.sampleRate, 24);
  buf.writeUInt32LE(params.sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.writeUInt16LE(22, 36); // cbSize
  buf.writeUInt16LE(bitsPerSample, 38); // validBitsPerSample
  buf.writeUInt32LE(4, 40); // dwChannelMask (mono front center)
  // SubFormat GUID: {subFormat}-0000-0010-8000-00aa00389b71
  buf.writeUInt16LE(params.subFormat, 44);
  buf.writeUInt16LE(0x0000, 46);
  buf.writeUInt16LE(0x0000, 48);
  buf.writeUInt16LE(0x0010, 50);
  const tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
  for (let i = 0; i < tail.length; i++) buf[52 + i] = tail[i];
  const dataOff = 60;
  buf.write('data', dataOff, 'ascii');
  buf.writeUInt32LE(dataSize, dataOff + 4);
  for (let i = 0; i < params.frames; i++) {
    const s = Math.sin((2 * Math.PI * 440 * i) / params.sampleRate) * 0.5;
    if (params.subFormat === 1) {
      buf.writeInt16LE(Math.round(s * 32767), dataOff + 8 + i * 2);
    } else {
      buf.writeFloatLE(s, dataOff + 8 + i * 4);
    }
  }
  return buf;
}

// ── 1. SEC-03: X-Forwarded-Host Origin Spoofing Blocked in Local Mode ───────────────────────
test('V7.2 SEC-03: AudioApiSecurityGuard rejects spoofed X-Forwarded-Host even with allowSameOriginProxyHost=true, allows only explicit trustedProxyHosts', async () => {
  const guard = new AudioApiSecurityGuard({
    mode: 'local',
    allowSameOriginProxyHost: true,
    trustedProxyHosts: ['studio-proxy.internal:8443'],
  });
  const app = express();
  app.post('/api/local-auth/session', guard.createLocalSessionEndpoint());

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  try {
    // Attacker spoofs matching Origin + X-Forwarded-Host on loopback -> MUST be rejected (403)
    const spoofed = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: {
        Origin: 'https://evil-attacker.example',
        'X-Forwarded-Host': 'evil-attacker.example',
      },
    });
    assert.equal(spoofed.status, 403);
    assert.equal(spoofed.json.code, 'UNTRUSTED_ORIGIN_BLOCKED');

    // Legitimate reverse proxy in trustedProxyHosts -> allowed (200)
    const trusted = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: {
        Origin: 'https://studio-proxy.internal:8443',
        'X-Forwarded-Host': 'studio-proxy.internal:8443',
      },
    });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.json.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── 2. SEC-01 & SEC-02: Scope Separation, Replay Enforcement & Server Route Coverage ────────
test('V7.2 SEC-01 & SEC-02: Hosted default tokens lack shahab:admin, ops routes enforce auth+scope+replay, and server.ts guards all legacy ASR/processing/shahab ops routes', async () => {
  const guard = new AudioApiSecurityGuard({
    mode: 'hosted',
    hostedSessionSecret: TEST_HOSTED_SECRET,
    hostedTokenIssuer: 'avapardaz-test-idp',
    allowedOrigins: ['https://studio.avapardaz.ir'],
  });

  const ordinaryUser = issueSignedAudioSessionToken({
    secret: TEST_HOSTED_SECRET,
    subject: 'ordinary-user',
    mode: 'hosted',
    issuer: 'avapardaz-test-idp',
  });
  const adminUser = issueSignedAudioSessionToken({
    secret: TEST_HOSTED_SECRET,
    subject: 'ops-admin',
    mode: 'hosted',
    issuer: 'avapardaz-test-idp',
    scopes: ['shahab:transcribe', 'shahab:admin', 'smart-edit:*'],
  });

  const app = express();
  app.use(express.json());
  const readGuard = guard.middleware({ requireAuth: true, requiredScope: 'shahab:admin' });
  const writeGuard = guard.middleware({
    requireAuth: true,
    requireReplayProtection: true,
    requiredScope: 'shahab:admin',
  });
  app.get('/api/shahab/state', readGuard, (_req, res) => res.json({ ok: true }));
  app.post('/api/shahab/memory', writeGuard, (_req, res) => res.status(201).json({ ok: true }));

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  try {
    // Unauthenticated -> 401
    const unauth = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/shahab/state',
      headers: { Origin: 'https://studio.avapardaz.ir' },
    });
    assert.equal(unauth.status, 401);

    // Ordinary hosted user -> 403 INSUFFICIENT_SCOPE
    const forbidden = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/shahab/state',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${ordinaryUser.token}`,
      },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.code, 'INSUFFICIENT_SCOPE');

    // Admin without replay nonce on POST -> 400 REPLAY_NONCE_INVALID
    const missingNonce = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/memory',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${adminUser.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ term: 'آواپرداز' }),
    });
    assert.equal(missingNonce.status, 400);
    assert.equal(missingNonce.json.code, 'REPLAY_NONCE_INVALID');

    // Admin with fresh replay nonce -> 201
    const okWrite = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/memory',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${adminUser.token}`,
        'Content-Type': 'application/json',
        ...freshNonceHeaders(),
      },
      body: JSON.stringify({ term: 'آواپرداز' }),
    });
    assert.equal(okWrite.status, 201);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Static wiring audit on server.ts: confirm every previously unauthenticated route now uses audioApiSecurityGuard
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  for (const route of [
    "'/api/v1/asr/transcriptions'",
    "'/api/v1/asr/checkpoints/rollback'",
    "'/api/v1/continuous-learning/feedback'",
    "'/api/v1/asr-core/batch'",
    "'/api/v1/asr-core/benchmark'",
    "'/api/v1/processing/execute'",
    "'/api/v1/processing/trace'",
  ]) {
    const idx = serverSource.indexOf(route);
    assert.ok(idx > 0, `Expected ${route} in server.ts`);
    const slice = serverSource.slice(idx, idx + 320);
    assert.ok(
      slice.includes('audioApiSecurityGuard.middleware'),
      `Route ${route} must be guarded by audioApiSecurityGuard.middleware`,
    );
  }
  assert.ok(
    serverSource.includes('BENCHMARK_DISABLED_IN_HOSTED_MODE'),
    'Benchmark endpoint must fail closed in hosted mode',
  );
  assert.ok(
    serverSource.includes('shahabOpsMutationGuard') && serverSource.includes("requiredScope: 'shahab:admin'"),
    'Shahab state/memory/operations routes must enforce auth + shahab:admin + replay protection',
  );
  assert.ok(
    serverSource.includes('cleanupOrphanedCoreIngestionTempFiles'),
    'Server startup must clean up orphaned CoreAudioIngestion temp directories',
  );
});

// ── 3. REM-04: Client Anti-Aliasing, Honest Metadata & Full-Audio Chunk Hash ────────────────
test('V7.2 REM-04: encodeMonoFloat32To16kWavBytes suppresses 14kHz aliasing, mapShahabResponseToPersianWordTokens never fabricates confidence/AcousticSnap, and chunked hash covers full PCM', async () => {
  // 3A. 14 kHz tone at 48 kHz (above 8 kHz Nyquist of 16 kHz) MUST be attenuated > 40 dB
  const sr48k = 48_000;
  const tone14k = new Float32Array(sr48k);
  for (let i = 0; i < sr48k; i++) {
    tone14k[i] = Math.sin((2 * Math.PI * 14_000 * i) / sr48k) * 0.8;
  }
  const wavBytes = encodeMonoFloat32To16kWavBytes(tone14k, sr48k);
  assert.equal(wavBytes.byteLength, 44 + 16_000 * 2);
  const decoded = decodeWavToMono16k(wavBytes);
  // Skip edge transient (first/last 500 samples)
  const interior = decoded.pcm16k.subarray(500, decoded.pcm16k.length - 500);
  const inRms = computeRms(tone14k);
  const outRms = computeRms(interior);
  const attenuationDb = 20 * Math.log10(inRms / Math.max(outRms, 1e-12));
  assert.ok(
    attenuationDb > 40,
    `Expected > 40 dB ultrasonic aliasing attenuation in client resampler, got ${attenuationDb.toFixed(1)} dB`,
  );

  // 3B. Honest token mapping: null confidence -> 0 + confidenceAvailable=false; SEGMENT_ESTIMATED -> Estimated (never AcousticSnap)
  const mockResp: ShahabServerTranscribeResponse = {
    ok: true,
    transcript: {
      schemaVersion: 'avp.transcript.v1',
      transcriptVersion: 'tr_v72',
      sourceAudioId: 'aud_test',
      sourceAudioHash: 'abc123',
      sampleRate: 16000,
      totalSourceSamples: 16000,
      language: 'fa',
      modelId: 'persian-zipformer-transducer',
      modelVersion: '1.0.0',
      runtime: 'shahab-zipformer-onnx-cpu',
      rawText: 'سلام دنیا',
      normalizedText: 'سلام دنیا',
      tokens: [
        {
          tokenId: 't0',
          rawText: 'سلام',
          normalizedText: 'سلام',
          startSample: 0,
          endSample: 8000,
          startSec: 0,
          endSec: 0.5,
          confidence: null,
          timestampGranularity: 'SEGMENT_ESTIMATED',
        },
        {
          tokenId: 't1',
          rawText: 'دنیا',
          normalizedText: 'دنیا',
          startSample: 8000,
          endSample: 16000,
          startSec: 0.5,
          endSec: 1.0,
          confidence: 0.92,
          timestampGranularity: 'WORD',
        },
      ],
      timestampGranularity: 'SEGMENT',
      realTimeFactor: 0.2,
      processingTimeMs: 200,
      offlineVerified: true,
    },
    metrics: {
      modelId: 'persian-zipformer-transducer',
      upstreamModelId: 'ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f',
      runtime: 'shahab-zipformer-onnx-cpu',
      durationSec: 1.0,
      processingTimeMs: 200,
      realTimeFactor: 0.2,
      tokenCount: 2,
      offlineVerified: true,
    },
  };

  const mapped = mapShahabResponseToPersianWordTokens({
    response: mockResp,
    trackId: 'track-main',
    speakerName: 'سارا',
  });
  assert.equal(mapped[0].confidence, 0);
  assert.equal(mapped[0].confidenceAvailable, false);
  assert.equal(mapped[0].alignmentSource, 'Estimated');
  assert.equal(mapped[0].alignmentPrecision, 'distributed_segment');
  assert.equal(mapped[1].confidence, 0.92);
  assert.equal(mapped[1].confidenceAvailable, true);
  assert.equal(mapped[1].alignmentSource, 'ASR');
  assert.equal(mapped[1].alignmentPrecision, 'model_timestamps');

  // 3C. Chunked (>24s) transcription computes full-audio sourceAudioHash instead of last chunk's hash
  const originalFetch = globalThis.fetch;
  let chunkCall = 0;
  let seenProjectHeader: string | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/local-auth/session')) {
      return new Response(
        JSON.stringify({ ok: true, token: 'v1.mocktokenpayload.mocksignature123456', expiresAtMs: Date.now() + 60_000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    chunkCall++;
    const hdrs = new Headers(init?.headers);
    seenProjectHeader = hdrs.get('x-project-id');
    return new Response(
      JSON.stringify({
        ...mockResp,
        transcript: {
          ...mockResp.transcript,
          sourceAudioId: `aud_chunk_only_${chunkCall}`,
          sourceAudioHash: `chunk_only_hash_${chunkCall}`,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const pcmA = new Float32Array(16_000 * 30); // 30s -> 2 chunks
    const pcmB = new Float32Array(16_000 * 30);
    pcmA[100] = 0.25; // difference only in chunk 1
    pcmB[100] = -0.25;

    const outA = await transcribePcmWithShahabLocal({
      pcm: pcmA,
      sampleRate: 16_000,
      trackId: 't1',
      speakerName: 'سارا',
      projectId: 'proj_v72_test',
    });
    const outB = await transcribePcmWithShahabLocal({
      pcm: pcmB,
      sampleRate: 16_000,
      trackId: 't1',
      speakerName: 'سارا',
      projectId: 'proj_v72_test',
    });
    assert.equal(seenProjectHeader, 'proj_v72_test');
    assert.notEqual(outA.response.transcript.sourceAudioHash, 'chunk_only_hash_2');
    assert.notEqual(
      outA.response.transcript.sourceAudioHash,
      outB.response.transcript.sourceAudioHash,
      'Chunked sourceAudioHash must depend on the entire audio, not only the last chunk',
    );
    assert.equal(
      outA.response.transcript.sourceAudioId,
      `aud_${outA.response.transcript.sourceAudioHash.slice(0, 16)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 4. REM-05: Full NaN Scan, Truncated WAV, RF64, WAVE_FORMAT_EXTENSIBLE, Bounded Hash & Path Guard ──
test('V7.2 REM-05: Full PCM NaN/Inf scan, RF64 + 0xFFFE WAV support, truncated WAV rejection, engine anti-aliasing, bounded SHA-256 & path guard', async () => {
  // 4A. Single NaN at index 17 (missed by old stride-256 loop!) MUST be rejected
  const runtime = new ShahabZipformerAsrRuntime({
    modelDir: path.resolve(process.cwd(), 'models/__nonexistent_v72__'),
  });
  const poisonedPcm = new Float32Array(16_000);
  poisonedPcm[17] = Number.NaN;
  await assert.rejects(
    () =>
      runtime.transcribe({
        sourceAudioId: 'aud_nan',
        canonicalPcm16kMono: poisonedPcm,
      }),
    (err: unknown) => err instanceof ShahabZipformerRuntimeError && err.code === 'INVALID_AUDIO_INPUT',
  );

  // 4B. NUL byte & directory paths rejected safely
  await assert.rejects(
    () => runtime.transcribe({ sourceAudioId: 'aud_nul', audioFilePath: '/tmp/bad\0.wav' }),
    (err: unknown) => err instanceof ShahabZipformerRuntimeError && err.code === 'INVALID_AUDIO_INPUT',
  );
  await assert.rejects(
    () => runtime.transcribe({ sourceAudioId: 'aud_dir', audioFilePath: os.tmpdir() }),
    (err: unknown) => err instanceof ShahabZipformerRuntimeError && err.code === 'INVALID_AUDIO_INPUT',
  );

  // 4C. Truncated WAV rejected with INVALID_WAV_TRUNCATED (never silently clamped!)
  const fullWav = buildPcm16Wav({ sampleRate: 16_000, channels: 1, frames: 8000 });
  const truncatedWav = fullWav.subarray(0, 44 + 100); // header declares 16,000 B, only 100 B present
  assert.throws(
    () => decodeWavToMono16k(new Uint8Array(truncatedWav)),
    /INVALID_WAV_TRUNCATED/,
  );

  // 4D. RF64 WAV decoded cleanly by both decodeWavToMono16k and decodeNativeWavToPlanar
  const rf64Wav = buildRf64Pcm16Wav(16_000, 1600);
  const rf64Engine = decodeWavToMono16k(new Uint8Array(rf64Wav));
  const rf64Native = decodeNativeWavToPlanar(rf64Wav);
  assert.equal(rf64Engine.pcm16k.length, 1600);
  assert.ok(rf64Native !== null && rf64Native.totalSamples === 1600);

  // 4E. WAVE_FORMAT_EXTENSIBLE (0xFFFE) PCM16 and IEEE Float32 decoded cleanly by both decoders
  for (const subFormat of [1, 3] as const) {
    const extWav = buildWaveFormatExtensibleWav({ sampleRate: 16_000, frames: 1600, subFormat });
    const engOut = decodeWavToMono16k(new Uint8Array(extWav));
    const natOut = decodeNativeWavToPlanar(extWav);
    assert.equal(engOut.pcm16k.length, 1600);
    assert.ok(natOut !== null && natOut.totalSamples === 1600);
    assert.equal(natOut.audioFormat, subFormat);
  }

  // 4F. Engine WAV downsampling 48k -> 16k suppresses 14 kHz aliasing > 40 dB
  const wav48k14k = buildPcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    frames: 48_000,
    sampleFn: (i) => Math.sin((2 * Math.PI * 14_000 * i) / 48_000) * 0.8,
  });
  const engResampled = decodeWavToMono16k(new Uint8Array(wav48k14k));
  const rmsOut = computeRms(engResampled.pcm16k.subarray(500, engResampled.pcm16k.length - 500));
  const attenDb = 20 * Math.log10((0.8 / Math.SQRT2) / Math.max(rmsOut, 1e-12));
  assert.ok(attenDb > 40, `Expected > 40 dB attenuation in decodeWavToMono16k, got ${attenDb.toFixed(1)} dB`);

  // 4G. Bounded 1 MiB chunked SHA-256 verification matches exact crypto SHA-256 on > 2 MiB file
  const tmpModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v72-hash-test-'));
  try {
    const bigEncoder = crypto.randomBytes(2 * 1024 * 1024 + 12345); // > 2 MiB -> multiple 1 MiB chunks
    const smallDec = Buffer.from('decoder-stub');
    const smallJoin = Buffer.from('joiner-stub');
    const smallTok = Buffer.from('<blk> 0\n');
    fs.writeFileSync(path.join(tmpModelDir, 'encoder.int8.onnx'), bigEncoder);
    fs.writeFileSync(path.join(tmpModelDir, 'decoder.int8.onnx'), smallDec);
    fs.writeFileSync(path.join(tmpModelDir, 'joiner.int8.onnx'), smallJoin);
    fs.writeFileSync(path.join(tmpModelDir, 'tokens.txt'), smallTok);

    const adapter = new SHAHABFrozenModelAdapter({ modelDir: tmpModelDir });
    const immut = adapter.verifyWeightImmutability();
    assert.equal(immut.hashes.encoder, crypto.createHash('sha256').update(bigEncoder).digest('hex'));
    assert.equal(immut.hashes.decoder, crypto.createHash('sha256').update(smallDec).digest('hex'));
    assert.equal(immut.hashes.joiner, crypto.createHash('sha256').update(smallJoin).digest('hex'));
    assert.equal(immut.hashes.tokens, crypto.createHash('sha256').update(smallTok).digest('hex'));
    assert.equal(immut.immutable, false); // Expected hashes remain locked to official weights!
  } finally {
    fs.rmSync(tmpModelDir, { recursive: true, force: true });
  }
});

// ── 5. REM-06: Zero-FFmpeg Native WAV Pipeline, rawPcm16 Guard & Orphan Temp Cleanup ────────
test('V7.2 REM-06: SmartAudioEditPipeline decodes native WAV in-process without FFmpeg, CoreAudioIngestion guards rawPcm16 and cleans orphaned temp dirs', () => {
  // 5A. Native 48 kHz stereo WAV uses in-process path (no FFmpeg spawn) and preserves native stereo + anti-aliased 16k mono
  const wavStereo48k = buildPcm16Wav({
    sampleRate: 48_000,
    channels: 2,
    frames: 24_000, // 0.5s
    sampleFn: (i, ch) => (ch === 0 ? Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5 : Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5),
  });
  const pipeline = new SmartAudioEditPipeline();
  const imported = pipeline.importAndNormalizeAudio({
    audioBytes: wavStereo48k,
    filename: 'studio-stereo.wav',
    projectId: 'proj_wav_fast',
  });
  assert.equal(imported.audio.sourceSampleRate, 48_000);
  assert.equal(imported.audio.sourceChannels, 2);
  assert.equal(imported.audio.totalSourceSamples, 24_000);
  assert.equal(imported.audio.canonical16kMono.length, 8_000); // 0.5s @ 16 kHz
  const normStage = imported.session.stageTrace.find((s) => s.stage === 'LOCAL_AUDIO_NORMALIZATION');
  assert.ok(normStage?.detail.includes('in-process-wav'), 'Native WAV must use zero-FFmpeg in-process path');

  // Path guard on SmartAudioEditPipeline
  assert.throws(
    () => pipeline.importAndNormalizeAudio({ audioFilePath: '/tmp/evil\0.wav' }),
    (err: unknown) => err instanceof SmartAudioEditError && err.code === 'INVALID_AUDIO_INPUT',
  );
  assert.throws(
    () => pipeline.importAndNormalizeAudio({ audioFilePath: os.tmpdir() }),
    (err: unknown) => err instanceof SmartAudioEditError && err.code === 'INVALID_AUDIO_INPUT',
  );

  // 5B. CoreAudioIngestion rejects odd-byte rawPcm16Hint
  assert.throws(
    () =>
      ingestAudioBufferToCanonical16kMono({
        filename: 'broken.pcm',
        rawBytes: Buffer.alloc(101),
        rawPcm16Hint: true,
      }),
    /AUDIO_INGEST_INVALID_PCM16/,
  );

  // 5C. Orphaned temp directory cleanup removes stale avapardaz-ingest-* dirs and spares unrelated dirs
  const sandboxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v72-orphan-root-'));
  try {
    const staleDir = path.join(sandboxTmp, 'avapardaz-ingest-stale123');
    const unrelatedDir = path.join(sandboxTmp, 'keep-me-dir');
    fs.mkdirSync(staleDir);
    fs.writeFileSync(path.join(staleDir, 'input.wav'), 'stale');
    fs.mkdirSync(unrelatedDir);

    const res = cleanupOrphanedCoreIngestionTempFiles({ tmpRoot: sandboxTmp, maxAgeMs: 0 });
    assert.equal(res.removedCount, 1);
    assert.equal(fs.existsSync(staleDir), false);
    assert.equal(fs.existsSync(unrelatedDir), true);
  } finally {
    fs.rmSync(sandboxTmp, { recursive: true, force: true });
  }
});

// ── 6. REM-07: Tenant-Scoped Encoder Cache Isolation, X-Project-Id Validation & Filtering ───
test('V7.2 REM-07: SHAHABMemoryGovernor isolates cache entries by tenantScope, routers reject invalid X-Project-Id (400), and GET /jobs filters by projectId', async () => {
  // 6A. Tenant-scoped encoder cache isolation
  const gov = new SHAHABMemoryGovernor();
  const baseKey: Omit<ShahabCacheIdentityKey, 'tenantScope'> = {
    audioSha256: 'deadbeef'.repeat(8),
    segmentId: 'seg_0',
    segmentStartSample: 0,
    segmentEndSample: 16_000,
    modelId: 'persian-zipformer-transducer',
    modelRevision: '1.0.0',
    encoderSha256: 'e',
    decoderSha256: 'd',
    joinerSha256: 'j',
    sampleRateHz: 16_000,
    channels: 1,
    featureConfigVersion: 'kaldi-fbank-80',
    runtimeVersion: 'onnxruntime-web@1.31.1',
    decoderInterfaceVersion: 'v1',
  };
  const keyA: ShahabCacheIdentityKey = { ...baseKey, tenantScope: 'user-a:proj-1' };
  const keyB: ShahabCacheIdentityKey = { ...baseKey, tenantScope: 'user-b:proj-1' };
  assert.notEqual(serializeCacheIdentity(keyA), serializeCacheIdentity(keyB));

  const tensorA: ShahabEncoderOutputTensor = {
    data: new Float32Array([1, 2, 3, 4]),
    numFrames: 1,
    dim: 4,
    dtype: 'float32',
    byteLength: 16,
    encoderTimeMs: 5,
  };
  gov.encoderCache.set(keyA, tensorA, 16);
  assert.ok(gov.encoderCache.get(keyA) !== null, 'Same tenant must hit cache');
  assert.equal(gov.encoderCache.get(keyB), null, 'Different tenant must NEVER hit another tenant cache entry');

  // 6B. Router X-Project-Id validation (400 INVALID_PROJECT_ID) & GET /jobs?projectId=... filtering & Shahab forwarding
  const guard = new AudioApiSecurityGuard({ mode: 'local' });
  const localSess = guard.issueLocalSession();

  let capturedShahabOwner: string | undefined;
  let capturedShahabProject: string | undefined;
  const mockShahab: ShahabTranscribeBackend = {
    getRuntimeStatus: () => ({
      available: true,
      modelLoaded: true,
      engine: 'SHAHAB_ZIPFORMER_TRANSDUCER',
      modelId: 'shahab-test',
      modelVersion: '1.0.0',
      upstreamModelId: 'test',
      runtime: 'shahab-zipformer-onnx-cpu',
      offlineOnlyEnforced: true,
      modelDir: '/tmp',
      missingFiles: [],
      integrityError: null,
      sampleAudioAvailable: false,
      sampleAudioPath: null,
      activeJobCount: 0,
      queuedJobCount: 0,
      maxPendingJobs: 4,
      lastMetrics: null,
    }),
    getBundledSampleAudioPath: () => null,
    transcribe: async (req) => {
      capturedShahabOwner = req.ownerId;
      capturedShahabProject = req.projectId;
      return {
        transcript: {
          schemaVersion: 'avp.transcript.v1',
          transcriptVersion: 'tr_1',
          sourceAudioId: req.sourceAudioId,
          sourceAudioHash: req.sourceAudioHash ?? '',
          sampleRate: 16000,
          totalSourceSamples: 1600,
          language: 'fa',
          modelId: 'shahab-test',
          modelVersion: '1.0.0',
          runtime: 'shahab-zipformer-onnx-cpu',
          rawText: 'سلام',
          normalizedText: 'سلام',
          tokens: [],
          timestampGranularity: 'NONE',
          realTimeFactor: 0.1,
          processingTimeMs: 10,
          offlineVerified: true,
          createdAtMs: Date.now(),
        },
        metrics: {
          modelId: 'shahab-test',
          upstreamModelId: 'test',
          runtime: 'shahab-zipformer-onnx-cpu',
          durationSec: 0.1,
          processingTimeMs: 10,
          realTimeFactor: 0.1,
          rssBeforeMb: 10,
          rssAfterMb: 10,
          peakRssMb: 10,
          tokenCount: 0,
          offlineVerified: true,
        },
      };
    },
  };

  const mockEngine: ShahabAsrEngine = {
    transcribe: async () => {
      throw new Error('not called');
    },
    unload: () => ({ unloaded: true, rssMb: 10 }),
  };
  const jobManager = new SmartAudioEditJobManager(new SmartAudioEditPipeline({ asrEngine: mockEngine }));
  const { router: smartRouter } = createSmartAudioEditHttpRouter({ jobManager, securityGuard: guard });
  const shahabRouter = createShahabHttpRouter({ shahabZipformerRuntime: mockShahab, securityGuard: guard });

  const app = express();
  app.use('/api/v2/smart-edit', smartRouter);
  app.use('/api/shahab', shahabRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const wav = buildPcm16Wav({ sampleRate: 16_000, channels: 1, frames: 1600 });

  try {
    // Malformed X-Project-Id rejected with 400 INVALID_PROJECT_ID on both routers
    const badSmart = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Authorization: `Bearer ${localSess.token}`,
        'Content-Type': 'audio/wav',
        'X-Project-Id': '../bad/project!',
        ...freshNonceHeaders(),
      },
      body: wav,
    });
    assert.equal(badSmart.status, 400);
    assert.equal(badSmart.json.code, 'INVALID_PROJECT_ID');

    const badShahab = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localSess.token}`,
        'Content-Type': 'audio/wav',
        'X-Project-Id': '../bad/project!',
        ...freshNonceHeaders(),
      },
      body: wav,
    });
    assert.equal(badShahab.status, 400);
    assert.equal(badShahab.json.code, 'INVALID_PROJECT_ID');

    // Valid X-Project-Id forwarded to Shahab runtime along with ownerId
    const okShahab = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localSess.token}`,
        'Content-Type': 'audio/wav',
        'X-Project-Id': 'proj-iran-01',
        ...freshNonceHeaders(),
      },
      body: wav,
    });
    assert.equal(okShahab.status, 200);
    assert.ok(capturedShahabOwner?.startsWith('local:'));
    assert.equal(capturedShahabProject, 'proj-iran-01');

    // Create 2 jobs in different projects & verify GET /jobs?projectId=... filters accurately
    const j1 = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Authorization: `Bearer ${localSess.token}`,
        'Content-Type': 'audio/wav',
        'X-Project-Id': 'proj-alpha',
        ...freshNonceHeaders(),
      },
      body: wav,
    });
    const j2 = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Authorization: `Bearer ${localSess.token}`,
        'Content-Type': 'audio/wav',
        'X-Project-Id': 'proj-beta',
        ...freshNonceHeaders(),
      },
      body: wav,
    });
    assert.equal(j1.status, 201);
    assert.equal(j2.status, 201);

    const filtered = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs?projectId=proj-alpha',
      headers: { Authorization: `Bearer ${localSess.token}` },
    });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.jobs.length, 1);
    assert.equal(filtered.json.jobs[0].jobId, j1.json.job.jobId);

    const badFilter = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs?projectId=../evil',
      headers: { Authorization: `Bearer ${localSess.token}` },
    });
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.json.code, 'INVALID_PROJECT_ID');
  } finally {
    jobManager.disposeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
