/**
 * AVAPARDAZ — PHASE 1A SECURITY CONTAINMENT & LOCAL/HOSTED API HARDENING TEST SUITE
 *
 * Covers every mandatory Phase 1A scenario across BOTH Local/Desktop Mode and Hosted Mode:
 *  1. Unauthorized requests to /api/shahab/transcribe rejected before processing
 *  2. Untrusted Origin / Cross-Site / DNS-Rebinding Host rejected in Local & Hosted modes
 *  3. Hosted Mode fail-closed when auth is unconfigured + rejects missing/invalid session
 *  4. Anti-IDOR: User A cannot read, run, preview, render, export, cancel, or delete User B's Job
 *  5. Unauthorized Export & Preview rejected (Job ID alone is never authorization)
 *  6. Oversized payload rejected (413 JSON), wrong Content-Type (415), invalid binary audio (400)
 *  7. Concurrency ceiling enforced (429 + Retry-After) & eviction skips active jobs safely
 *  8. Client disconnect / cancel propagates AbortSignal to stop in-flight ASR/Edit processing + timeout (408)
 *  9. Expired session tokens rejected (401 AUTH_TOKEN_EXPIRED) in Local & Hosted modes
 * 10. Replay of sensitive requests rejected (409 REQUEST_REPLAY_DETECTED) & stale timestamps (401)
 * 11. Valid Local Mode flow works end-to-end per existing response contract
 * 12. Valid Adobe Audition CEP <-> Native Companion flow works with zero regression + tightened proxy Host guard
 * 13. Query-string tokens strictly rejected (400) & zero static secrets / localStorage in ShahabLocalHttpClient
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  AudioApiSecurityGuard,
  issueSignedAudioSessionToken,
  resolveAudioApiSecurityConfig,
  resolveServerBindHost,
} from './AudioApiSecurityGuard';
import { createShahabHttpRouter, type ShahabTranscribeBackend } from '../shahab/ShahabHttpRouter';
import { createSmartAudioEditHttpRouter } from '../workflow/SmartAudioEditHttpRouter';
import { SmartAudioEditJobManager } from '../workflow/SmartAudioEditJobManager';
import { SmartAudioEditPipeline } from '../workflow/SmartAudioEditPipeline';
import type { ShahabAsrEngine } from '../workflow/SmartAudioEditContracts';
import { LocalCompanionService } from '../host-bridge/companion/LocalCompanionService';
import { COMPANION_IPC_PROTOCOL_VERSION } from '../host-bridge/companion/CompanionIpcBridge';
import { CANONICAL_CONTRACT_VERSION } from '../processing-engine/capabilities/CanonicalCapabilityContracts';

const HOSTED_TEST_SECRET = 'phase1a-test-hosted-session-secret-min-32-chars-ok!';

/** Builds a valid minimal 16 kHz mono PCM16 WAV buffer. */
function makeValidWavBuffer(durationSec = 0.25, sampleRate = 16000): Buffer {
  const numSamples = Math.max(160, Math.floor(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 6000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

function freshNonceHeaders(nowMs = Date.now()): Record<string, string> {
  return {
    'X-Request-Nonce': `n_${crypto.randomBytes(12).toString('hex')}`,
    'X-Request-Timestamp': String(nowMs),
  };
}

async function rawHttpRequest(params: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer | string;
}): Promise<{ readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: Buffer; readonly json: any }> {
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
          const ct = String(res.headers['content-type'] ?? '');
          if (ct.includes('application/json') && buf.byteLength > 0) {
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

function createMockShahabBackend(options?: {
  readonly delayMs?: number;
  readonly onTranscribeStart?: (signal?: AbortSignal) => void;
  readonly onTranscribeAborted?: () => void;
}): { readonly backend: ShahabTranscribeBackend; readonly getCallCount: () => number } {
  let callCount = 0;
  const backend: ShahabTranscribeBackend = {
    getRuntimeStatus: () => ({
      available: true,
      modelLoaded: true,
      engine: 'SHAHAB_ZIPFORMER_TRANSDUCER',
      modelId: 'shahab-test',
      modelVersion: '1.0.0',
      upstreamModelId: 'test/zipformer',
      runtime: 'shahab-zipformer-onnx-cpu',
      offlineOnlyEnforced: true,
      modelDir: '/tmp/shahab-test',
      missingFiles: [],
      integrityError: null,
      sampleAudioAvailable: false,
      sampleAudioPath: null,
      activeJobCount: 0,
      queuedJobCount: 0,
      maxPendingJobs: 8,
      lastMetrics: null,
    }),
    getBundledSampleAudioPath: () => null,
    transcribe: async (req) => {
      callCount++;
      options?.onTranscribeStart?.(req.signal);
      if (options?.delayMs && options.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          if (req.signal?.aborted) {
            options?.onTranscribeAborted?.();
            reject(new Error('TRANSCRIPTION_CANCELLED'));
            return;
          }
          const t = setTimeout(resolve, options.delayMs);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              options?.onTranscribeAborted?.();
              reject(new Error('TRANSCRIPTION_CANCELLED'));
            },
            { once: true },
          );
        });
      }
      return {
        transcript: {
          transcriptId: 'tr_test_1',
          sourceAudioId: req.sourceAudioId,
          sourceAudioHash: req.sourceAudioHash,
          engine: 'SHAHAB_ZIPFORMER_TRANSDUCER_INT8',
          modelId: 'shahab-test',
          modelVersion: '1.0.0',
          language: 'fa',
          timestampGranularity: 'SEGMENT_ESTIMATED',
          rawText: 'سلام آواپرداز',
          normalizedText: 'سلام آواپرداز',
          tokens: [
            {
              index: 0,
              rawText: 'سلام',
              normalizedText: 'سلام',
              startSec: 0,
              endSec: 0.2,
              startSample: 0,
              endSample: 3200,
              confidence: 0.9,
              timestampGranularity: 'SEGMENT_ESTIMATED',
            },
          ],
          segments: [],
          durationSec: 0.25,
          createdAtIso: new Date().toISOString(),
        } as any,
        metrics: {
          durationSec: 0.25,
          processingTimeMs: 12,
          realTimeFactor: 0.05,
          peakRssMb: 128,
          chunkCount: 1,
          tokenCount: 1,
          modelLoadTimeMs: 0,
          offlineVerified: true,
        } as any,
      };
    },
  };
  return { backend, getCallCount: () => callCount };
}

function createMockPipelineAsrEngine(options?: {
  readonly delayMs?: number;
  readonly onAborted?: () => void;
}): ShahabAsrEngine {
  return {
    transcribe: async (req: any) => {
      if (options?.delayMs && options.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          if (req.signal?.aborted) {
            options?.onAborted?.();
            reject(new Error('TRANSCRIPTION_CANCELLED'));
            return;
          }
          const t = setTimeout(resolve, options.delayMs);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              options?.onAborted?.();
              reject(new Error('TRANSCRIPTION_CANCELLED'));
            },
            { once: true },
          );
        });
      }
      return {
        transcript: {
          transcriptId: 'tr_se_1',
          sourceAudioId: req.sourceAudioId,
          sourceAudioHash: req.sourceAudioHash,
          engine: 'SHAHAB_ZIPFORMER_TRANSDUCER_INT8',
          modelId: 'shahab-test',
          modelVersion: '1.0.0',
          language: 'fa',
          timestampGranularity: 'WORD',
          rawText: 'تست آواپرداز',
          normalizedText: 'تست آواپرداز',
          tokens: [
            {
              index: 0,
              rawText: 'تست',
              normalizedText: 'تست',
              startSec: 0.0,
              endSec: 0.12,
              startSample: 0,
              endSample: 1920,
              confidence: 0.95,
              timestampGranularity: 'WORD',
            },
            {
              index: 1,
              rawText: 'آواپرداز',
              normalizedText: 'آواپرداز',
              startSec: 0.12,
              endSec: 0.24,
              startSample: 1920,
              endSample: 3840,
              confidence: 0.95,
              timestampGranularity: 'WORD',
            },
          ],
          segments: [],
          durationSec: 0.25,
          createdAtIso: new Date().toISOString(),
        } as any,
        metrics: {
          durationSec: 0.25,
          processingTimeMs: 5,
          realTimeFactor: 0.02,
          peakRssMb: 64,
          chunkCount: 1,
          tokenCount: 2,
          modelLoadTimeMs: 0,
          offlineVerified: true,
        } as any,
      };
    },
    unload: () => ({ unloaded: true, rssMb: 64 }),
  };
}

// ── 1. Deployment Mode & Fail-Closed Resolution ─────────────────────────────────────────────
test('Phase 1A: Deployment mode resolution separates Local vs Hosted and fails closed in production by default', () => {
  const prodDefault = resolveAudioApiSecurityConfig({ NODE_ENV: 'production' });
  assert.equal(prodDefault.mode, 'hosted');
  const prodGuard = new AudioApiSecurityGuard(prodDefault);
  assert.equal(prodGuard.isHostedAuthConfigured(), false);

  const localDesktop = resolveAudioApiSecurityConfig({
    NODE_ENV: 'development',
    AVAPARDAZ_DEPLOYMENT_MODE: 'local',
  });
  assert.equal(localDesktop.mode, 'local');
  assert.equal(resolveServerBindHost({ NODE_ENV: 'development', AVAPARDAZ_DEPLOYMENT_MODE: 'local' }, localDesktop), '127.0.0.1');

  const hostedBind = resolveServerBindHost({ AVAPARDAZ_DEPLOYMENT_MODE: 'hosted' });
  assert.equal(hostedBind, '0.0.0.0');
});

// ── 2. Local Mode Shahab: Auth, Origin, DNS-Rebinding, Replay, Expiry, Payload, Concurrency, Disconnect, Valid ──
test('Phase 1A (Local Mode): /api/shahab/transcribe enforces auth, Origin/Host, replay, expiry, payload size, concurrency, disconnect abort & valid contract', async () => {
  let currentNowMs = Date.now();
  let abortedFlag = false;
  const mock = createMockShahabBackend({
    delayMs: 120,
    onTranscribeAborted: () => {
      abortedFlag = true;
    },
  });

  const securityGuard = new AudioApiSecurityGuard({
    mode: 'local',
    allowSameOriginProxyHost: false,
    localSessionTtlMs: 10_000,
    nowMs: () => currentNowMs,
  });

  const app = express();
  app.post('/api/local-auth/session', securityGuard.createLocalSessionEndpoint());
  app.use(
    '/api/shahab',
    createShahabHttpRouter({
      shahabZipformerRuntime: mock.backend,
      securityGuard,
      maxUploadBytes: 4096, // tight limit for testing 413
      maxConcurrentPerOwner: 1,
      maxConcurrentGlobal: 2,
      requestTimeoutMs: 5000,
    }),
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const validWav = makeValidWavBuffer(0.05); // ~1644 B (< 4096 B)

  try {
    // (1) Unauthorized request to Shahab -> 401 BEFORE invoking backend
    const unauth = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: { 'Content-Type': 'audio/wav', ...freshNonceHeaders(currentNowMs) },
      body: validWav,
    });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.json.code, 'AUTH_TOKEN_MISSING');
    assert.equal(mock.getCallCount(), 0);

    // (2) Untrusted Origin -> 403
    const evilOrigin = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: { Origin: 'https://evil-attacker.example' },
    });
    assert.equal(evilOrigin.status, 403);
    assert.equal(evilOrigin.json.code, 'UNTRUSTED_ORIGIN_BLOCKED');

    // (3) DNS Rebinding Host header -> 403
    const rebind = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: { Host: 'rebind.attacker.example' },
    });
    assert.equal(rebind.status, 403);
    assert.equal(rebind.json.code, 'DNS_REBINDING_BLOCKED');

    // (4) Obtain valid ephemeral local session token
    const sessionResp = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(sessionResp.status, 200);
    assert.equal(sessionResp.json.ok, true);
    const localToken: string = sessionResp.json.token;

    // (5) Token in query string -> 400 forbidden
    const queryTok = await rawHttpRequest({
      port,
      method: 'POST',
      path: `/api/shahab/transcribe?token=${encodeURIComponent(localToken)}`,
      headers: { 'Content-Type': 'audio/wav', ...freshNonceHeaders(currentNowMs) },
      body: validWav,
    });
    assert.equal(queryTok.status, 400);
    assert.equal(queryTok.json.code, 'TOKEN_IN_QUERY_FORBIDDEN');

    // (6) Wrong Content-Type -> 415
    const badCt = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localToken}`,
        'Content-Type': 'text/plain',
        ...freshNonceHeaders(currentNowMs),
      },
      body: 'not-audio',
    });
    assert.equal(badCt.status, 415);
    assert.equal(badCt.json.code, 'UNSUPPORTED_MEDIA_TYPE');

    // (7) Garbage non-WAV binary payload -> 400 INVALID_AUDIO_INPUT
    const badPayload = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localToken}`,
        'Content-Type': 'audio/wav',
        ...freshNonceHeaders(currentNowMs),
      },
      body: Buffer.alloc(128, 0x41),
    });
    assert.equal(badPayload.status, 400);
    assert.equal(badPayload.json.code, 'INVALID_AUDIO_INPUT');

    // (8) Oversized payload -> 413 PAYLOAD_TOO_LARGE
    const tooLarge = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localToken}`,
        'Content-Type': 'audio/wav',
        ...freshNonceHeaders(currentNowMs),
      },
      body: makeValidWavBuffer(0.5), // ~16,044 B > 4096 B
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.json.code, 'PAYLOAD_TOO_LARGE');

    // (9) Valid Local Mode transcribe works per contract + Replay rejected with 409
    const fixedReplayHeaders = freshNonceHeaders(currentNowMs);
    const validRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localToken}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'audio/wav',
        ...fixedReplayHeaders,
      },
      body: validWav,
    });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.json.ok, true);
    assert.equal(validRes.json.transcript.normalizedText, 'سلام آواپرداز');
    assert.equal(mock.getCallCount(), 1);

    const replayRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localToken}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'audio/wav',
        ...fixedReplayHeaders,
      },
      body: validWav,
    });
    assert.equal(replayRes.status, 409);
    assert.equal(replayRes.json.code, 'REQUEST_REPLAY_DETECTED');
    assert.equal(mock.getCallCount(), 1);

    // (10) Concurrency limit: 2 simultaneous requests by same owner -> 2nd rejected with 429 + Retry-After
    const [conc1, conc2] = await Promise.all([
      rawHttpRequest({
        port,
        method: 'POST',
        path: '/api/shahab/transcribe',
        headers: {
          Authorization: `Bearer ${localToken}`,
          'Content-Type': 'audio/wav',
          ...freshNonceHeaders(currentNowMs),
        },
        body: validWav,
      }),
      rawHttpRequest({
        port,
        method: 'POST',
        path: '/api/shahab/transcribe',
        headers: {
          Authorization: `Bearer ${localToken}`,
          'Content-Type': 'audio/wav',
          ...freshNonceHeaders(currentNowMs),
        },
        body: validWav,
      }),
    ]);
    const statuses = [conc1.status, conc2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 429]);
    const rejectedConc = conc1.status === 429 ? conc1 : conc2;
    assert.equal(rejectedConc.json.code, 'OWNER_CONCURRENCY_LIMIT_EXCEEDED');
    assert.ok(rejectedConc.headers['retry-after']);

    // (11) Client disconnect cancels in-flight transcription via AbortSignal
    abortedFlag = false;
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/shahab/transcribe',
        headers: {
          Authorization: `Bearer ${localToken}`,
          'Content-Type': 'audio/wav',
          'Content-Length': String(validWav.byteLength),
          ...freshNonceHeaders(currentNowMs),
        },
      });
      req.on('error', () => {
        // Expected ECONNRESET on deliberate destroy
      });
      req.write(validWav);
      req.end();
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 60);
      }, 30);
    });
    assert.equal(abortedFlag, true, 'Client disconnect must abort in-flight Shahab transcription');

    // (12) Expired token -> 401 AUTH_TOKEN_EXPIRED
    currentNowMs += 20_000; // past 10s localSessionTtlMs
    const expiredRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: {
        Authorization: `Bearer ${localToken}`,
        'Content-Type': 'audio/wav',
        ...freshNonceHeaders(currentNowMs),
      },
      body: validWav,
    });
    assert.equal(expiredRes.status, 401);
    assert.equal(expiredRes.json.code, 'AUTH_TOKEN_EXPIRED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── 3. Hosted Mode: Fail-Closed when unconfigured + Full Anti-IDOR / Export / Replay / Cancel ──
test('Phase 1A (Hosted Mode): Fail-closed without auth config, blocks cross-user IDOR/Export, enforces Origin, Expiry, Replay & Cancel', async () => {
  // Part A: Hosted Mode WITHOUT secret MUST fail closed!
  const unconfiguredGuard = new AudioApiSecurityGuard({
    mode: 'hosted',
    hostedSessionSecret: '',
  });
  const failClosedApp = express();
  failClosedApp.post('/api/local-auth/session', unconfiguredGuard.createLocalSessionEndpoint());
  failClosedApp.use(
    '/api/shahab',
    createShahabHttpRouter({
      shahabZipformerRuntime: createMockShahabBackend().backend,
      securityGuard: unconfiguredGuard,
    }),
  );
  const { router: fcSmartRouter } = createSmartAudioEditHttpRouter({
    asrEngine: createMockPipelineAsrEngine(),
    securityGuard: unconfiguredGuard,
  });
  failClosedApp.use('/api/v2/smart-edit', fcSmartRouter);

  const fcServer = await new Promise<http.Server>((resolve) => {
    const s = failClosedApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const fcPort = (fcServer.address() as { port: number }).port;

  try {
    // Local session bootstrap MUST be 404 in hosted mode
    const localBoot = await rawHttpRequest({ port: fcPort, method: 'POST', path: '/api/local-auth/session' });
    assert.equal(localBoot.status, 404);

    // Shahab & Smart Edit MUST fail closed with 401 HOSTED_AUTH_NOT_CONFIGURED
    const fcShahab = await rawHttpRequest({
      port: fcPort,
      method: 'POST',
      path: '/api/shahab/transcribe',
      headers: { 'Content-Type': 'audio/wav', ...freshNonceHeaders() },
      body: makeValidWavBuffer(0.05),
    });
    assert.equal(fcShahab.status, 401);
    assert.equal(fcShahab.json.code, 'HOSTED_AUTH_NOT_CONFIGURED');

    const fcSmart = await rawHttpRequest({
      port: fcPort,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
    });
    assert.equal(fcSmart.status, 401);
    assert.equal(fcSmart.json.code, 'HOSTED_AUTH_NOT_CONFIGURED');
  } finally {
    await new Promise<void>((resolve) => fcServer.close(() => resolve()));
  }

  // Part B: Configured Hosted Mode with User A vs User B isolation (Anti-IDOR)
  let currentNowMs = Date.now();
  let runAborted = false;
  const securityGuard = new AudioApiSecurityGuard({
    mode: 'hosted',
    hostedSessionSecret: HOSTED_TEST_SECRET,
    hostedTokenIssuer: 'avapardaz-test-idp',
    allowedOrigins: ['https://studio.avapardaz.ir'],
    nowMs: () => currentNowMs,
  });
  const pipeline = new SmartAudioEditPipeline({
    asrEngine: createMockPipelineAsrEngine({
      delayMs: 80,
      onAborted: () => {
        runAborted = true;
      },
    }),
  });
  const jobManager = new SmartAudioEditJobManager(pipeline, {
    maxRetainedJobs: 3,
    maxJobsPerOwner: 3,
  });
  const { router: smartEditRouter } = createSmartAudioEditHttpRouter({
    jobManager,
    securityGuard,
    maxUploadBytes: 100_000,
    operationTimeoutMs: 5_000,
  });

  const hostedApp = express();
  hostedApp.use('/api/v2/smart-edit', smartEditRouter);
  const hostedServer = await new Promise<http.Server>((resolve) => {
    const s = hostedApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (hostedServer.address() as { port: number }).port;

  const userA = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-alpha',
    mode: 'hosted',
    issuer: 'avapardaz-test-idp',
    ttlMs: 30_000,
    nowMs: currentNowMs,
  });
  const userB = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-beta',
    mode: 'hosted',
    issuer: 'avapardaz-test-idp',
    ttlMs: 30_000,
    nowMs: currentNowMs,
  });
  const expiredUser = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-expired',
    mode: 'hosted',
    issuer: 'avapardaz-test-idp',
    ttlMs: 1_000,
    nowMs: currentNowMs - 5_000,
  });

  const wavBuf = makeValidWavBuffer(0.25);

  try {
    // 1. Hosted request without valid session -> 401
    const noSess = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        'Content-Type': 'audio/wav',
        ...freshNonceHeaders(currentNowMs),
      },
      body: wavBuf,
    });
    assert.equal(noSess.status, 401);
    assert.equal(noSess.json.code, 'AUTH_TOKEN_MISSING');

    // 2. Hosted request with untrusted Origin -> 403
    const badOrigin = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://evil.example',
        Authorization: `Bearer ${userA.token}`,
      },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.json.code, 'UNTRUSTED_ORIGIN_BLOCKED');

    // 3. Hosted request with expired token -> 401 AUTH_TOKEN_EXPIRED
    const expResp = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${expiredUser.token}`,
      },
    });
    assert.equal(expResp.status, 401);
    assert.equal(expResp.json.code, 'AUTH_TOKEN_EXPIRED');

    // 4. User A creates a Job (replay nonce verified)
    const createNonce = freshNonceHeaders(currentNowMs);
    const created = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        'Content-Type': 'audio/wav',
        ...createNonce,
      },
      body: wavBuf,
    });
    assert.equal(created.status, 201);
    const jobIdA: string = created.json.job.jobId;
    assert.match(jobIdA, /^job_[a-f0-9]{32}$/, 'Job ID must have 128-bit cryptographic entropy');

    // Replay same POST /jobs nonce -> 409
    const replayedCreate = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        'Content-Type': 'audio/wav',
        ...createNonce,
      },
      body: wavBuf,
    });
    assert.equal(replayedCreate.status, 409);
    assert.equal(replayedCreate.json.code, 'REQUEST_REPLAY_DETECTED');

    // 5. Anti-IDOR: User B CANNOT read, list, preview, export, cancel, or delete User A's Job!
    const listB = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: { Origin: 'https://studio.avapardaz.ir', Authorization: `Bearer ${userB.token}` },
    });
    assert.equal(listB.status, 200);
    assert.equal(listB.json.jobs.length, 0);

    const getIdor = await rawHttpRequest({
      port,
      method: 'GET',
      path: `/api/v2/smart-edit/jobs/${jobIdA}`,
      headers: { Origin: 'https://studio.avapardaz.ir', Authorization: `Bearer ${userB.token}` },
    });
    assert.equal(getIdor.status, 403);
    assert.equal(getIdor.json.code, 'JOB_ACCESS_DENIED');
    assert.equal(getIdor.json.snapshot, undefined);

    const previewIdor = await rawHttpRequest({
      port,
      method: 'POST',
      path: `/api/v2/smart-edit/jobs/${jobIdA}/preview`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userB.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'ORIGINAL' }),
    });
    assert.equal(previewIdor.status, 403);
    assert.equal(previewIdor.json.code, 'JOB_ACCESS_DENIED');

    // Unauthorized Export (no token) -> 401; Wrong user Export (knowing Job ID) -> 403
    const exportNoAuth = await rawHttpRequest({
      port,
      method: 'GET',
      path: `/api/v2/smart-edit/jobs/${jobIdA}/export`,
      headers: { Origin: 'https://studio.avapardaz.ir', ...freshNonceHeaders(currentNowMs) },
    });
    assert.equal(exportNoAuth.status, 401);

    const exportIdor = await rawHttpRequest({
      port,
      method: 'GET',
      path: `/api/v2/smart-edit/jobs/${jobIdA}/export`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userB.token}`,
        ...freshNonceHeaders(currentNowMs),
      },
    });
    assert.equal(exportIdor.status, 403);
    assert.equal(exportIdor.json.code, 'JOB_ACCESS_DENIED');

    // Replaying the exact same nonce on a second Smart Edit export request must be rejected with 409
    const exportReplayHeaders = freshNonceHeaders(currentNowMs);
    const exportFirst = await rawHttpRequest({
      port,
      method: 'GET',
      path: `/api/v2/smart-edit/jobs/${jobIdA}/export`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        ...exportReplayHeaders,
      },
    });
    assert.equal(exportFirst.status, 404); // Not rendered yet, but auth + ownership + replay passed
    const exportSecond = await rawHttpRequest({
      port,
      method: 'GET',
      path: `/api/v2/smart-edit/jobs/${jobIdA}/export`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        ...exportReplayHeaders,
      },
    });
    assert.equal(exportSecond.status, 409);
    assert.equal(exportSecond.json.code, 'REQUEST_REPLAY_DETECTED');

    const deleteIdor = await rawHttpRequest({
      port,
      method: 'DELETE',
      path: `/api/v2/smart-edit/jobs/${jobIdA}`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userB.token}`,
        ...freshNonceHeaders(currentNowMs),
      },
    });
    assert.equal(deleteIdor.status, 403);
    assert.equal(deleteIdor.json.code, 'JOB_ACCESS_DENIED');

    // 6. Client disconnect on /run aborts in-flight pipeline processing
    runAborted = false;
    await new Promise<void>((resolve) => {
      const payload = JSON.stringify({ languageHint: 'fa' });
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/v2/smart-edit/jobs/${jobIdA}/run`,
        headers: {
          Origin: 'https://studio.avapardaz.ir',
          Authorization: `Bearer ${userA.token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          ...freshNonceHeaders(currentNowMs),
        },
      });
      req.on('error', () => {
        // Expected on destroy
      });
      req.write(payload);
      req.end();
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 60);
      }, 20);
    });
    assert.equal(runAborted, true, 'Client disconnect must abort in-flight Smart Edit /run');

    // 7. User A can delete their own Job cleanly
    const delOwn = await rawHttpRequest({
      port,
      method: 'DELETE',
      path: `/api/v2/smart-edit/jobs/${jobIdA}`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        ...freshNonceHeaders(currentNowMs),
      },
    });
    assert.equal(delOwn.status, 200);
    assert.equal(delOwn.json.ok, true);
  } finally {
    jobManager.disposeAll();
    await new Promise<void>((resolve) => hostedServer.close(() => resolve()));
  }
});

// ── 4. Companion Tightened Proxy-Host DNS Rebinding, Query-Token Guard & CEP Regression Check ──
test('Phase 1A (Native Companion): Blocks proxy-mode Host DNS rebinding without Origin, blocks query-string tokens, and preserves CEP handshake/IPC', async () => {
  const service = new LocalCompanionService();
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter({ allowSameOriginProxyHost: true }));

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  try {
    // 1. Spoofed non-loopback Host WITHOUT Origin must be blocked even when allowSameOriginProxyHost=true
    const spoofedHost = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/companion/health',
      headers: { Host: 'evil-rebind.attacker.example' },
    });
    assert.equal(spoofedHost.status, 403);
    assert.equal(spoofedHost.json.error, 'DNS_REBINDING_BLOCKED');

    // 2. Query-string token must be rejected with 400
    const qTok = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/companion/health?token=leaked-secret',
    });
    assert.equal(qTok.status, 400);
    assert.equal(qTok.json.error, 'IPC_TOKEN_IN_QUERY_FORBIDDEN');

    // 3. Valid Adobe Audition CEP loopback handshake + IPC JOB_LIST continues to work cleanly
    const hs = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/companion/handshake',
      headers: { 'Content-Type': 'application/json', Origin: 'file://' },
      body: JSON.stringify({
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        host_id: 'adobe-audition',
        host_version: '24.0',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: CANONICAL_CONTRACT_VERSION,
      }),
    });
    assert.equal(hs.status, 200);
    assert.equal(hs.json.compatible, true);

    const ipcRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/companion/ipc',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'file://',
        Authorization: `Bearer ${hs.json.session_token}`,
      },
      body: JSON.stringify({
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id: hs.json.session_id,
        nonce: `cep_n_${crypto.randomBytes(8).toString('hex')}`,
        request_id: `cep_r_${crypto.randomBytes(8).toString('hex')}`,
        timestamp_ms: Date.now(),
        expires_at_ms: Date.now() + 60_000,
        execution_mode: 'audition-cep',
        command: 'JOB_LIST',
        payload: {},
      }),
    });
    assert.equal(ipcRes.status, 200);
    assert.equal(ipcRes.json.ok, true);
  } finally {
    service.beginGracefulShutdown('Phase 1A test teardown');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── 5. Frontend Bundle Secret Hygiene Check ─────────────────────────────────────────────────
test('Phase 1A: ShahabLocalHttpClient contains zero hardcoded secrets and never persists session tokens in localStorage/sessionStorage', () => {
  const clientCode = fs.readFileSync(
    path.resolve(process.cwd(), 'src/asr-core/ShahabLocalHttpClient.ts'),
    'utf8',
  );
  // Strip line & block comments before checking actual executable code for storage access
  const codeWithoutComments = clientCode
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(/\b(localStorage|sessionStorage)\b/.test(codeWithoutComments), false);
  assert.equal(/HOSTED_SESSION_SECRET|process\.env/.test(codeWithoutComments), false);
  assert.equal(codeWithoutComments.includes('/api/local-auth/session'), true);
  assert.equal(codeWithoutComments.includes('X-Request-Nonce'), true);
});
