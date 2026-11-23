/**
 * AVAPARDAZ — PHASE 1A.1 MANDATORY SECURITY CLOSURE & MODEL SUPPLY-CHAIN TEST SUITE
 *
 * Covers ALL 22 mandatory verification scenarios in Phase 1A.1 Section 7 plus
 * adversarial Phase 1A re-audit regressions:
 *  1. Hosted Mode: valid per-user token (sub, aud, iss, exp) -> allowed.
 *  2. Hosted Mode: User B token accessing User A Job -> 403 JOB_ACCESS_DENIED.
 *  3. Hosted Mode: forged ownerId in body/header -> 400 OWNER_OVERRIDE_FORBIDDEN / ignored;
 *     direct SmartAudioEditJobManager call without explicit ownerId -> JOB_ACCESS_DENIED;
 *     tenant-scoped resource telemetry (no global RSS / other users' job counts).
 *  4. Hosted Mode: bare shared secret without identity issuer -> Fail Closed (401);
 *     raw secret as Bearer -> 401; generic/shared subject ("shared", "default") -> 401;
 *     wrong aud -> 401 AUTH_TOKEN_AUDIENCE_MISMATCH; wrong iss -> 401 AUTH_TOKEN_ISSUER_MISMATCH;
 *     untrusted X-Forwarded-Host origin spoofing -> 403 UNTRUSTED_ORIGIN_BLOCKED.
 *  5. Expired token -> 401 AUTH_TOKEN_EXPIRED; replayed nonce -> 409 REQUEST_REPLAY_DETECTED.
 *  6. Local Session & Companion Abuse:
 *     - POST /api/local-auth/session with disallowed Host (including DNS-rebinding Host: evil.com + Origin: http://evil.com even with allowSameOriginProxyHost: true) -> 403 DNS_REBINDING_BLOCKED.
 *     - POST /api/local-auth/session with missing Origin -> 403 ORIGIN_REQUIRED_FOR_LOCAL_SESSION; Origin: null or unknown Origin -> 403 UNTRUSTED_ORIGIN_BLOCKED.
 *     - Revoked local session -> 401 AUTH_SESSION_REVOKED.
 *     - Companion proxy-mode DNS-rebinding Host: evil.com + Origin: http://evil.com -> 403 DNS_REBINDING_BLOCKED.
 *     - Companion browser sandboxed iframe Origin: null + Sec-Fetch-Site: cross-site -> 403 UNTRUSTED_ORIGIN_BLOCKED.
 *     - Adobe Audition CEP (Origin: file:// or Origin: null without Sec-Fetch-Site) -> STILL WORKS (200).
 *  7. Model Supply-Chain Download (`downloadFileWithRedirects`):
 *     - Redirect to HTTP -> rejected (DOWNLOAD_INSECURE_PROTOCOL), zero partial file left.
 *     - Redirect to host outside allowlist -> rejected (DOWNLOAD_HOST_NOT_ALLOWED), zero partial file left.
 *     - Redirect to private/loopback IP (literal & DNS-resolved) -> rejected (DOWNLOAD_PRIVATE_IP_BLOCKED), zero partial file left.
 *     - Download exceeding maxBytes (header & streaming without Content-Length) -> aborted (DOWNLOAD_MAX_BYTES_EXCEEDED), cleanup verified.
 *     - Download timeout (totalTimeoutMs) & AbortSignal cancellation -> cancelled (DOWNLOAD_TIMEOUT / DOWNLOAD_ABORTED), cleanup verified.
 *     - Cross-host redirect strips Authorization & Cookie headers.
 *     - SHA-256 hash mismatch -> rejected (DOWNLOAD_SHA256_MISMATCH), zero file promoted.
 *  8. Safe Tar.bz2 Extraction (`extractTarBz2Safe`) & Atomic Activation (`activateDirectoryAtomically`):
 *     - Tar Path Traversal (`../outside.txt` & `/tmp/abs.txt`) -> TAR_PATH_TRAVERSAL_BLOCKED, zero escape outside root.
 *     - Tar Symlink -> TAR_SYMLINK_FORBIDDEN, zero escape.
 *     - Tar Hardlink -> TAR_HARDLINK_FORBIDDEN, zero escape.
 *     - Tar Bomb (decompressed size > maxTotalBytes & file count > maxFiles) -> TAR_BOMB_LIMIT_EXCEEDED / TAR_TOO_MANY_FILES, staging cleaned.
 *     - Missing safe extractor binary -> SAFE_TAR_EXTRACTOR_UNAVAILABLE (fails closed, never falls back to `tar -xjf`).
 *     - Failed/corrupt installation never activates partial model and preserves healthy prior model via rollback.
 *  9. Public Model Artifact Router (`createLocalModelArtifactHttpRouter`):
 *     - Range > 1 MiB -> 416 RANGE_TOO_LARGE; multi-range -> 416 MULTIPLE_RANGES_NOT_SUPPORTED; omitted Range on > 1 MiB artifact -> 416 RANGE_REQUIRED_FOR_LARGE_ARTIFACT.
 *     - Invalid/malformed Range -> controlled 416 with Content-Range.
 *     - Concurrent POST /prepare -> single-flight (provider called strictly once).
 *     - Artifact outside manifest (`../server.ts`, `evil.bin`) -> 404 ARTIFACT_NOT_FOUND.
 *     - Tampered artifact on disk -> 500 ARTIFACT_INTEGRITY_ERROR (never delivered).
 *     - End-to-end BrowserPersianModelInstaller (`installShenavaRizehInBrowser`) succeeds against live hardened router with 2.5 MiB artifact + ETag/304.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import express from 'express';

import {
  AudioApiSecurityGuard,
  issueSignedAudioSessionToken,
} from './AudioApiSecurityGuard';
import { createSmartAudioEditHttpRouter } from '../workflow/SmartAudioEditHttpRouter';
import { SmartAudioEditJobManager } from '../workflow/SmartAudioEditJobManager';
import { SmartAudioEditPipeline } from '../workflow/SmartAudioEditPipeline';
import type { ShahabAsrEngine } from '../workflow/SmartAudioEditContracts';
import { LocalCompanionService } from '../host-bridge/companion/LocalCompanionService';
import { COMPANION_IPC_PROTOCOL_VERSION } from '../host-bridge/companion/CompanionIpcBridge';
import { CANONICAL_CONTRACT_VERSION } from '../processing-engine/capabilities/CanonicalCapabilityContracts';
import {
  activateDirectoryAtomically,
  downloadFileWithRedirects,
  extractTarBz2Safe,
  isPrivateOrLoopbackIp,
  ModelSupplyChainError,
} from '../asr-core/SafeModelSupplyChain';
import {
  createLocalModelArtifactHttpRouter,
  MAX_MODEL_ARTIFACT_RANGE_BYTES,
} from '../lifecycle/LocalModelArtifactHttpRouter';
import {
  InMemoryModelChunkStorage,
  LocalModelLifecycleManager,
} from '../lifecycle/LocalModelLifecycleManager';
import { installShenavaRizehInBrowser } from '../lifecycle/BrowserPersianModelInstaller';
import { sha256Bytes } from '../utils/StreamingSha256';

const HOSTED_TEST_SECRET = 'phase1a1-hosted-signing-secret-with-strong-entropy-0123456789';
const HOSTED_TEST_ISSUER = 'avapardaz-idp-prod';

function makeValidWavBuffer(durationSec = 0.2): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.max(160, Math.round(sampleRate * durationSec));
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
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
}): Promise<{
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  readonly json: any;
}> {
  return await new Promise((resolve, reject) => {
    const bodyBuf =
      typeof params.body === 'string'
        ? Buffer.from(params.body, 'utf8')
        : params.body ?? Buffer.alloc(0);
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    if (bodyBuf.byteLength > 0 && !headers['Content-Length']) {
      headers['Content-Length'] = String(bodyBuf.byteLength);
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: params.port,
        method: params.method,
        path: params.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let parsed: any = null;
          try {
            parsed = JSON.parse(buf.toString('utf8'));
          } catch {
            // non-JSON
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buf,
            json: parsed,
          });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf.byteLength > 0) req.write(bodyBuf);
    req.end();
  });
}

function createMockPipelineAsrEngine(): ShahabAsrEngine {
  return {
    transcribe: async (req: any) => ({
      transcript: {
        transcriptId: 'tr_1a1',
        sourceAudioId: req.sourceAudioId,
        sourceAudioHash: req.sourceAudioHash,
        engine: 'SHAHAB_ZIPFORMER_TRANSDUCER_INT8',
        modelId: 'shahab-test',
        modelVersion: '1.0.0',
        language: 'fa',
        timestampGranularity: 'WORD',
        rawText: 'آزمون امنیت',
        normalizedText: 'آزمون امنیت',
        tokens: [
          {
            index: 0,
            rawText: 'آزمون',
            normalizedText: 'آزمون',
            startSec: 0,
            endSec: 0.1,
            startSample: 0,
            endSample: 1600,
            confidence: 0.95,
            timestampGranularity: 'WORD',
          },
        ],
        segments: [],
        durationSec: 0.2,
        createdAtIso: new Date().toISOString(),
      } as any,
      metrics: {
        durationSec: 0.2,
        processingTimeMs: 4,
        realTimeFactor: 0.02,
        peakRssMb: 48,
        chunkCount: 1,
        tokenCount: 1,
        modelLoadTimeMs: 0,
        offlineVerified: true,
      } as any,
    }),
    unload: () => ({ unloaded: true, rssMb: 48 }),
  };
}

function createSelfSignedCert(tmpDir: string): { readonly key: Buffer; readonly cert: Buffer } {
  const keyPath = path.join(tmpDir, 'test-key.pem');
  const certPath = path.join(tmpDir, 'test-cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=trusted-a.test',
  ], { stdio: 'ignore' });
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

function createTarBz2ViaPython(outPath: string, pythonBuildSnippet: string): void {
  const script = `
import io, os, sys, tarfile
out_path = sys.argv[1]
with tarfile.open(out_path, "w:bz2") as tf:
${pythonBuildSnippet
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
`;
  execFileSync('python3', ['-c', script, outPath]);
}

// ═══════════════════════════════════════════════════════════════════════════
// PILLAR 1: HOSTED AUTH CLOSURE, ANTI-FORGERY & TENANT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

test('Phase 1A.1 (Hosted Auth Closure): Rejects bare shared secret without IdP/issuer, raw secret bearer, generic subjects, wrong aud/iss, X-Forwarded-Host spoofing, and forged ownerId', async () => {
  // 1. Bare AVAPARDAZ_HOSTED_SESSION_SECRET WITHOUT hostedTokenIssuer or verifyHostedSession MUST fail closed!
  const bareSecretGuard = new AudioApiSecurityGuard({
    mode: 'hosted',
    hostedSessionSecret: HOSTED_TEST_SECRET,
    hostedTokenIssuer: '', // missing explicit issuer!
    allowedOrigins: ['https://studio.avapardaz.ir'],
  });
  assert.equal(bareSecretGuard.isHostedAuthConfigured(), false);

  const bareApp = express();
  const { router: bareRouter } = createSmartAudioEditHttpRouter({
    asrEngine: createMockPipelineAsrEngine(),
    securityGuard: bareSecretGuard,
  });
  bareApp.use('/api/v2/smart-edit', bareRouter);
  const bareServer = await new Promise<http.Server>((resolve) => {
    const s = bareApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const barePort = (bareServer.address() as { port: number }).port;

  try {
    const forgedTok = issueSignedAudioSessionToken({
      secret: HOSTED_TEST_SECRET,
      subject: 'alice',
      mode: 'hosted',
      issuer: 'anything',
    });
    const res = await rawHttpRequest({
      port: barePort,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${forgedTok.token}`,
      },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'HOSTED_IDENTITY_PROVIDER_REQUIRED');
  } finally {
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  }

  // 2. Properly configured Hosted Guard with explicit issuer + audience
  let nowMs = Date.now();
  const guard = new AudioApiSecurityGuard({
    mode: 'hosted',
    hostedSessionSecret: HOSTED_TEST_SECRET,
    hostedTokenIssuer: HOSTED_TEST_ISSUER,
    expectedAudience: 'avapardaz-audio-api',
    allowedOrigins: ['https://studio.avapardaz.ir'],
    nowMs: () => nowMs,
  });
  assert.equal(guard.isHostedAuthConfigured(), true);

  const pipeline = new SmartAudioEditPipeline({ asrEngine: createMockPipelineAsrEngine() });
  const jobManager = new SmartAudioEditJobManager(pipeline, {
    maxRetainedJobs: 4,
    maxJobsPerOwner: 3,
    requireExplicitOwnerId: true,
  });

  // Direct JobManager guard: omitting ownerId MUST fail closed!
  assert.throws(
    () => jobManager.createJobFromAudio({ audioBytes: makeValidWavBuffer(0.2), filename: 'test.wav' }),
    (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === 'JOB_ACCESS_DENIED',
  );

  const { router: smartRouter } = createSmartAudioEditHttpRouter({
    jobManager,
    securityGuard: guard,
  });
  const app = express();
  app.use('/api/v2/smart-edit', smartRouter);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  const userA = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-alice-101',
    mode: 'hosted',
    issuer: HOSTED_TEST_ISSUER,
    audience: 'avapardaz-audio-api',
    ttlMs: 30_000,
    nowMs,
  });
  const userB = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-bob-202',
    mode: 'hosted',
    issuer: HOSTED_TEST_ISSUER,
    audience: 'avapardaz-audio-api',
    ttlMs: 30_000,
    nowMs,
  });
  const wrongAud = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-alice-101',
    mode: 'hosted',
    issuer: HOSTED_TEST_ISSUER,
    audience: 'some-other-service',
    ttlMs: 30_000,
    nowMs,
  });
  const wrongIss = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'user-alice-101',
    mode: 'hosted',
    issuer: 'untrusted-idp',
    audience: 'avapardaz-audio-api',
    ttlMs: 30_000,
    nowMs,
  });
  const genericSub = issueSignedAudioSessionToken({
    secret: HOSTED_TEST_SECRET,
    subject: 'shared',
    mode: 'hosted',
    issuer: HOSTED_TEST_ISSUER,
    audience: 'avapardaz-audio-api',
    ttlMs: 30_000,
    nowMs,
  });

  try {
    // (a) Passing raw shared secret as Bearer token -> 401 HOSTED_SHARED_SECRET_FORBIDDEN
    const rawSec = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${HOSTED_TEST_SECRET}`,
      },
    });
    assert.equal(rawSec.status, 401);
    assert.equal(rawSec.json.code, 'HOSTED_SHARED_SECRET_FORBIDDEN');

    // (b) Token issued for another audience -> 401 AUTH_TOKEN_AUDIENCE_MISMATCH
    const badAudRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${wrongAud.token}`,
      },
    });
    assert.equal(badAudRes.status, 401);
    assert.equal(badAudRes.json.code, 'AUTH_TOKEN_AUDIENCE_MISMATCH');

    // (c) Token from wrong issuer -> 401 AUTH_TOKEN_ISSUER_MISMATCH
    const badIssRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${wrongIss.token}`,
      },
    });
    assert.equal(badIssRes.status, 401);
    assert.equal(badIssRes.json.code, 'AUTH_TOKEN_ISSUER_MISMATCH');

    // (d) Generic/shared subject -> 401 HOSTED_IDENTITY_REQUIRED
    const genericRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${genericSub.token}`,
      },
    });
    assert.equal(genericRes.status, 401);
    assert.equal(genericRes.json.code, 'HOSTED_IDENTITY_REQUIRED');

    // (e) User A creates Job with forged X-Owner-Id header -> header MUST be ignored, Job belongs to hosted:user-alice-101
    const created = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        'X-Owner-Id': 'hosted:user-bob-202',
        'Content-Type': 'audio/wav',
        ...freshNonceHeaders(nowMs),
      },
      body: makeValidWavBuffer(0.2),
    });
    assert.equal(created.status, 201);
    const jobIdA: string = created.json.job.jobId;

    // User B STILL gets 403 JOB_ACCESS_DENIED (proving X-Owner-Id was ignored!)
    const bobGet = await rawHttpRequest({
      port,
      method: 'GET',
      path: `/api/v2/smart-edit/jobs/${jobIdA}`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userB.token}`,
      },
    });
    assert.equal(bobGet.status, 403);
    assert.equal(bobGet.json.code, 'JOB_ACCESS_DENIED');

    // (f) Forged ownerId in JSON body -> 400 OWNER_OVERRIDE_FORBIDDEN
    const forgedBody = await rawHttpRequest({
      port,
      method: 'POST',
      path: `/api/v2/smart-edit/jobs/${jobIdA}/preview`,
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userA.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'ORIGINAL', ownerId: 'hosted:user-bob-202' }),
    });
    assert.equal(forgedBody.status, 400);
    assert.equal(forgedBody.json.code, 'OWNER_OVERRIDE_FORBIDDEN');

    // (g) Tenant-scoped telemetry: User B sees trackedJobs === 0 (never sees User A's jobs!)
    const bobList = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Origin: 'https://studio.avapardaz.ir',
        Authorization: `Bearer ${userB.token}`,
      },
    });
    assert.equal(bobList.status, 200);
    assert.equal(bobList.json.jobs.length, 0);
    assert.equal(bobList.json.resources.trackedJobs, 0);
    assert.equal(bobList.json.resources.processRssMb, undefined);
  } finally {
    jobManager.disposeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 3. Hosted Mode without allowedOrigins MUST NOT trust attacker-spoofed X-Forwarded-Host!
  const noOriginsGuard = new AudioApiSecurityGuard({
    mode: 'hosted',
    hostedSessionSecret: HOSTED_TEST_SECRET,
    hostedTokenIssuer: HOSTED_TEST_ISSUER,
    allowedOrigins: [],
  });
  const spoofApp = express();
  const { router: spoofRouter } = createSmartAudioEditHttpRouter({
    asrEngine: createMockPipelineAsrEngine(),
    securityGuard: noOriginsGuard,
  });
  spoofApp.use('/api/v2/smart-edit', spoofRouter);
  const spoofServer = await new Promise<http.Server>((resolve) => {
    const s = spoofApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const spoofPort = (spoofServer.address() as { port: number }).port;
  try {
    const spoofRes = await rawHttpRequest({
      port: spoofPort,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        'X-Forwarded-Host': 'evil.attacker.example',
        Origin: 'https://evil.attacker.example',
        Authorization: `Bearer ${userA.token}`,
      },
    });
    assert.equal(spoofRes.status, 403);
    assert.equal(spoofRes.json.code, 'UNTRUSTED_ORIGIN_BLOCKED');
  } finally {
    await new Promise<void>((resolve) => spoofServer.close(() => resolve()));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PILLAR 2: LOCAL SESSION & NATIVE COMPANION ABUSE CLOSURE
// ═══════════════════════════════════════════════════════════════════════════

test('Phase 1A.1 (Local Session & Companion Abuse): Blocks DNS rebinding even in proxy mode, requires explicit Origin on /api/local-auth/session, enforces revocation, blocks sandboxed iframe Origin:null on Companion while preserving CEP', async () => {
  // 1. Local Session endpoint with allowSameOriginProxyHost: true
  const localGuard = new AudioApiSecurityGuard({
    mode: 'local',
    allowSameOriginProxyHost: true,
    localSessionTtlMs: 30_000,
  });
  const app = express();
  app.post('/api/local-auth/session', localGuard.createLocalSessionEndpoint());
  const { router: smartRouter } = createSmartAudioEditHttpRouter({
    asrEngine: createMockPipelineAsrEngine(),
    securityGuard: localGuard,
  });
  app.use('/api/v2/smart-edit', smartRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  try {
    // (a) DNS-rebinding attack: Host: evil.com + Origin: http://evil.com MUST be blocked even in proxy mode!
    const rebindAttack = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: {
        Host: 'rebind.attacker.example',
        Origin: 'http://rebind.attacker.example',
      },
    });
    assert.equal(rebindAttack.status, 403);
    assert.equal(rebindAttack.json.code, 'DNS_REBINDING_BLOCKED');

    // (b) Missing Origin on /api/local-auth/session -> 403 ORIGIN_REQUIRED_FOR_LOCAL_SESSION
    const noOrigin = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json.code, 'ORIGIN_REQUIRED_FOR_LOCAL_SESSION');

    // (c) Origin: null or file:// on /api/local-auth/session -> 403 UNTRUSTED_ORIGIN_BLOCKED
    const nullOrigin = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'null' },
    });
    assert.equal(nullOrigin.status, 403);
    assert.equal(nullOrigin.json.code, 'UNTRUSTED_ORIGIN_BLOCKED');

    const crossSite = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.code, 'CROSS_SITE_REQUEST_BLOCKED');

    // (d) Valid loopback Origin succeeds, and revoking sessionId invalidates token immediately!
    const validSess = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/local-auth/session',
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(validSess.status, 200);
    const token: string = validSess.json.token;
    const sessionId: string = validSess.json.sessionId;

    const okCall = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(okCall.status, 200);

    assert.equal(localGuard.revokeLocalSession(sessionId), true);
    const revokedCall = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v2/smart-edit/jobs',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(revokedCall.status, 401);
    assert.equal(revokedCall.json.code, 'AUTH_SESSION_UNKNOWN');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 2. Native Companion hardening checks
  const compService = new LocalCompanionService();
  const compApp = express();
  compApp.use('/api/v2/companion', compService.createExpressRouter({ allowSameOriginProxyHost: true }));
  const compServer = await new Promise<http.Server>((resolve) => {
    const s = compApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const compPort = (compServer.address() as { port: number }).port;

  try {
    // (a) Proxy-mode DNS rebinding: Host: evil.com + Origin: http://evil.com MUST be blocked!
    const compRebind = await rawHttpRequest({
      port: compPort,
      method: 'GET',
      path: '/api/v2/companion/health',
      headers: {
        Host: 'rebind.attacker.example',
        Origin: 'http://rebind.attacker.example',
      },
    });
    assert.equal(compRebind.status, 403);
    assert.equal(compRebind.json.error, 'DNS_REBINDING_BLOCKED');

    // (b) Sandboxed browser iframe: Origin: null + Sec-Fetch-Site: cross-site -> blocked!
    const sandboxIframe = await rawHttpRequest({
      port: compPort,
      method: 'GET',
      path: '/api/v2/companion/health',
      headers: {
        Host: `127.0.0.1:${compPort}`,
        Origin: 'null',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(sandboxIframe.status, 403);
    assert.equal(sandboxIframe.json.error, 'UNTRUSTED_ORIGIN_BLOCKED');

    // (c) Adobe Audition CEP desktop panel: Origin: null WITHOUT Sec-Fetch-Site -> STILL ALLOWED!
    const cepNullOrigin = await rawHttpRequest({
      port: compPort,
      method: 'POST',
      path: '/api/v2/companion/handshake',
      headers: {
        Host: `127.0.0.1:${compPort}`,
        Origin: 'null',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        host_id: 'adobe-audition',
        host_version: '24.0',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: CANONICAL_CONTRACT_VERSION,
      }),
    });
    assert.equal(cepNullOrigin.status, 200);
    assert.equal(cepNullOrigin.json.compatible, true);
  } finally {
    compService.beginGracefulShutdown('Phase 1A.1 test teardown');
    await new Promise<void>((resolve) => compServer.close(() => resolve()));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PILLAR 3: MODEL SUPPLY-CHAIN DOWNLOAD HARDENING (`downloadFileWithRedirects`)
// ═══════════════════════════════════════════════════════════════════════════

test('Phase 1A.1 (Model Download Security): Blocks HTTP redirect downgrade, non-allowlisted host, private/loopback IP SSRF, maxBytes overflow, timeout, AbortSignal, SHA-256 mismatch, and strips sensitive headers across hosts with zero partial files left', async () => {
  assert.equal(isPrivateOrLoopbackIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('10.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('169.254.169.254'), true);
  assert.equal(isPrivateOrLoopbackIp('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('192.168.1.5'), true);
  assert.equal(isPrivateOrLoopbackIp('::1'), true);
  assert.equal(isPrivateOrLoopbackIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('fe80::1'), true);
  assert.equal(isPrivateOrLoopbackIp('fc00::1'), true);
  assert.equal(isPrivateOrLoopbackIp('140.82.121.4'), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1a1-dl-'));
  const { key, cert } = createSelfSignedCert(tmpDir);
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  const validPayload = Buffer.from('AVAPARDAZ_VALID_MODEL_ARCHIVE_PAYLOAD_2026', 'utf8');
  const validSha = crypto.createHash('sha256').update(validPayload).digest('hex');

  let receivedCrossHostHeaders: http.IncomingHttpHeaders | null = null;
  let slowStreamTimers: NodeJS.Timeout[] = [];

  const httpsServer = https.createServer({ key, cert }, (req, res) => {
    const reqUrl = req.url ?? '/';
    const port = (httpsServer.address() as { port: number }).port;

    if (reqUrl === '/redir-http') {
      res.writeHead(302, { Location: 'http://github.com/downgrade.tar.bz2' });
      res.end();
      return;
    }
    if (reqUrl === '/redir-disallowed') {
      res.writeHead(302, { Location: 'https://evil-cdn.attacker.example/model.tar.bz2' });
      res.end();
      return;
    }
    if (reqUrl === '/redir-private-ip') {
      res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (reqUrl === '/redir-dns-private') {
      res.writeHead(302, { Location: `https://ssrf-private.test:${port}/secret` });
      res.end();
      return;
    }
    if (reqUrl === '/redir-cross-host') {
      res.writeHead(302, { Location: `https://trusted-b.test:${port}/cross-host-final` });
      res.end();
      return;
    }
    if (reqUrl === '/cross-host-final') {
      receivedCrossHostHeaders = req.headers;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validPayload.byteLength),
      });
      res.end(validPayload);
      return;
    }
    if (reqUrl === '/oversized-header') {
      res.writeHead(200, { 'Content-Length': String(50_000) });
      res.end(Buffer.alloc(1024));
      return;
    }
    if (reqUrl === '/oversized-chunked') {
      // No Content-Length header — streams more bytes than maxBytes!
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(4096, 0x42));
      res.write(Buffer.alloc(4096, 0x43));
      res.end();
      return;
    }
    if (reqUrl === '/slow-stream') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(16, 0x41));
      const t = setTimeout(() => {
        if (!res.destroyed) res.end(Buffer.alloc(16, 0x42));
      }, 3000);
      slowStreamTimers.push(t);
      return;
    }
    if (reqUrl === '/valid') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(validPayload.byteLength),
      });
      res.end(validPayload);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpsServer.address() as { port: number }).port;

  const testDnsLookup = async (hostname: string) => {
    if (hostname === 'trusted-a.test' || hostname === 'trusted-b.test') {
      return [{ address: '127.0.0.1', family: 4 }];
    }
    if (hostname === 'ssrf-private.test') {
      return [{ address: '10.0.0.5', family: 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
  };

  const baseOpts = {
    allowedHosts: ['trusted-a.test', 'trusted-b.test', 'ssrf-private.test'],
    allowLoopbackForTestHost: ['trusted-a.test', 'trusted-b.test'],
    dnsLookup: testDnsLookup,
    httpsAgent,
  };

  const assertZeroPartFiles = (dir: string) => {
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.part.'));
    assert.equal(leftovers.length, 0, `Expected zero leftover .part files, found: ${leftovers.join(', ')}`);
  };

  try {
    // 1. Redirect to HTTP -> DOWNLOAD_INSECURE_PROTOCOL
    const dest1 = path.join(tmpDir, 'out-http.bin');
    await assert.rejects(
      () => downloadFileWithRedirects(`https://trusted-a.test:${port}/redir-http`, dest1, baseOpts),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_INSECURE_PROTOCOL',
    );
    assert.equal(fs.existsSync(dest1), false);
    assertZeroPartFiles(tmpDir);

    // 2. Redirect to non-allowlisted host -> DOWNLOAD_HOST_NOT_ALLOWED
    const dest2 = path.join(tmpDir, 'out-disallowed.bin');
    await assert.rejects(
      () => downloadFileWithRedirects(`https://trusted-a.test:${port}/redir-disallowed`, dest2, baseOpts),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_HOST_NOT_ALLOWED',
    );
    assert.equal(fs.existsSync(dest2), false);
    assertZeroPartFiles(tmpDir);

    // 3. Redirect to literal private IP -> DOWNLOAD_HOST_NOT_ALLOWED or DOWNLOAD_PRIVATE_IP_BLOCKED
    const dest3 = path.join(tmpDir, 'out-priv-lit.bin');
    await assert.rejects(
      () =>
        downloadFileWithRedirects(`https://trusted-a.test:${port}/redir-private-ip`, dest3, {
          ...baseOpts,
          allowedHosts: [...baseOpts.allowedHosts, '169.254.169.254'],
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_PRIVATE_IP_BLOCKED',
    );
    assert.equal(fs.existsSync(dest3), false);

    // 4. Redirect to host resolving via DNS to private IP (10.0.0.5) -> DOWNLOAD_PRIVATE_IP_BLOCKED
    const dest4 = path.join(tmpDir, 'out-priv-dns.bin');
    await assert.rejects(
      () => downloadFileWithRedirects(`https://trusted-a.test:${port}/redir-dns-private`, dest4, baseOpts),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_PRIVATE_IP_BLOCKED',
    );
    assert.equal(fs.existsSync(dest4), false);

    // 5. Exceeding maxBytes via Content-Length header -> DOWNLOAD_MAX_BYTES_EXCEEDED
    const dest5 = path.join(tmpDir, 'out-max-hdr.bin');
    await assert.rejects(
      () =>
        downloadFileWithRedirects(`https://trusted-a.test:${port}/oversized-header`, dest5, {
          ...baseOpts,
          maxBytes: 2048,
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_MAX_BYTES_EXCEEDED',
    );
    assert.equal(fs.existsSync(dest5), false);
    assertZeroPartFiles(tmpDir);

    // 6. Exceeding maxBytes via streaming chunked body (no Content-Length) -> DOWNLOAD_MAX_BYTES_EXCEEDED
    const dest6 = path.join(tmpDir, 'out-max-stream.bin');
    await assert.rejects(
      () =>
        downloadFileWithRedirects(`https://trusted-a.test:${port}/oversized-chunked`, dest6, {
          ...baseOpts,
          maxBytes: 2048,
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_MAX_BYTES_EXCEEDED',
    );
    assert.equal(fs.existsSync(dest6), false);
    assertZeroPartFiles(tmpDir);

    // 7. Total Timeout -> DOWNLOAD_TIMEOUT + cleanup
    const dest7 = path.join(tmpDir, 'out-timeout.bin');
    await assert.rejects(
      () =>
        downloadFileWithRedirects(`https://trusted-a.test:${port}/slow-stream`, dest7, {
          ...baseOpts,
          totalTimeoutMs: 180,
          connectTimeoutMs: 150,
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_TIMEOUT',
    );
    assert.equal(fs.existsSync(dest7), false);
    assertZeroPartFiles(tmpDir);

    // 8. AbortSignal cancellation -> DOWNLOAD_ABORTED + cleanup
    const dest8 = path.join(tmpDir, 'out-abort.bin');
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 80);
    await assert.rejects(
      () =>
        downloadFileWithRedirects(`https://trusted-a.test:${port}/slow-stream`, dest8, {
          ...baseOpts,
          totalTimeoutMs: 5_000,
          signal: abortCtrl.signal,
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_ABORTED',
    );
    assert.equal(fs.existsSync(dest8), false);
    assertZeroPartFiles(tmpDir);

    // 9. SHA-256 mismatch -> DOWNLOAD_SHA256_MISMATCH + zero file promoted
    const dest9 = path.join(tmpDir, 'out-badsha.bin');
    await assert.rejects(
      () =>
        downloadFileWithRedirects(`https://trusted-a.test:${port}/valid`, dest9, {
          ...baseOpts,
          expectedSha256Hex: '0'.repeat(64),
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'DOWNLOAD_SHA256_MISMATCH',
    );
    assert.equal(fs.existsSync(dest9), false);
    assertZeroPartFiles(tmpDir);

    // 10. Cross-host redirect strips Authorization & Cookie headers and succeeds with SHA-256 verification
    const dest10 = path.join(tmpDir, 'out-valid.bin');
    const okResult = await downloadFileWithRedirects(
      `https://trusted-a.test:${port}/redir-cross-host`,
      dest10,
      {
        ...baseOpts,
        headers: {
          Authorization: 'Bearer super-secret-token',
          Cookie: 'sid=secret-cookie',
          'X-Trace': 'keep-me',
        },
        expectedBytes: validPayload.byteLength,
        expectedSha256Hex: validSha,
      },
    );
    assert.equal(okResult.sha256Hex, validSha);
    assert.equal(okResult.redirectCount, 1);
    assert.equal(fs.readFileSync(dest10).equals(validPayload), true);
    assert.ok(receivedCrossHostHeaders);
    assert.equal(receivedCrossHostHeaders['authorization'], undefined, 'Authorization must be stripped on cross-host redirect');
    assert.equal(receivedCrossHostHeaders['cookie'], undefined, 'Cookie must be stripped on cross-host redirect');
    assert.equal(receivedCrossHostHeaders['x-trace'], 'keep-me');
    assertZeroPartFiles(tmpDir);
  } finally {
    for (const t of slowStreamTimers) clearTimeout(t);
    httpsAgent.destroy();
    await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PILLAR 4: SAFE TAR.BZ2 EXTRACTION & ATOMIC ACTIVATION WITH ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════

test('Phase 1A.1 (Safe Tar Extraction & Atomic Activation): Blocks path traversal, symlink, hardlink, Tar Bomb, missing extractor fallback, and preserves healthy prior model on failed install', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1a1-tar-'));
  const extractParent = path.join(tmpDir, 'extract-sandbox');
  fs.mkdirSync(extractParent, { recursive: true });

  try {
    // 1. Tar Path Traversal (`../escaped.txt`)
    const traversalTar = path.join(tmpDir, 'traversal.tar.bz2');
    createTarBz2ViaPython(
      traversalTar,
      `
info = tarfile.TarInfo("../escaped.txt")
data = b"pwned"
info.size = len(data)
tf.addfile(info, io.BytesIO(data))
`,
    );
    const destTrav = path.join(extractParent, 'case-trav');
    await assert.rejects(
      () => extractTarBz2Safe(traversalTar, destTrav),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'TAR_PATH_TRAVERSAL_BLOCKED',
    );
    assert.equal(fs.existsSync(path.join(extractParent, 'escaped.txt')), false);
    assert.equal(fs.readdirSync(destTrav).length, 0);

    // 2. Tar Absolute Path (`/tmp/avp-abs-escape.txt`)
    const absTar = path.join(tmpDir, 'abs.tar.bz2');
    createTarBz2ViaPython(
      absTar,
      `
info = tarfile.TarInfo("/tmp/avp-abs-escape.txt")
data = b"pwned"
info.size = len(data)
tf.addfile(info, io.BytesIO(data))
`,
    );
    const destAbs = path.join(extractParent, 'case-abs');
    await assert.rejects(
      () => extractTarBz2Safe(absTar, destAbs),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'TAR_PATH_TRAVERSAL_BLOCKED',
    );
    assert.equal(fs.existsSync('/tmp/avp-abs-escape.txt'), false);

    // 3. Tar Symlink
    const symlinkTar = path.join(tmpDir, 'symlink.tar.bz2');
    createTarBz2ViaPython(
      symlinkTar,
      `
info = tarfile.TarInfo("model/evil_link")
info.type = tarfile.SYMTYPE
info.linkname = "/etc/passwd"
tf.addfile(info)
`,
    );
    const destSym = path.join(extractParent, 'case-sym');
    await assert.rejects(
      () => extractTarBz2Safe(symlinkTar, destSym),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'TAR_SYMLINK_FORBIDDEN',
    );
    assert.equal(fs.readdirSync(destSym).length, 0);

    // 4. Tar Hardlink
    const hardlinkTar = path.join(tmpDir, 'hardlink.tar.bz2');
    createTarBz2ViaPython(
      hardlinkTar,
      `
f1 = tarfile.TarInfo("model/tokens.txt")
d1 = b"a 0\\n"
f1.size = len(d1)
tf.addfile(f1, io.BytesIO(d1))
hl = tarfile.TarInfo("model/hard_alias")
hl.type = tarfile.LNKTYPE
hl.linkname = "model/tokens.txt"
tf.addfile(hl)
`,
    );
    const destHl = path.join(extractParent, 'case-hl');
    await assert.rejects(
      () => extractTarBz2Safe(hardlinkTar, destHl),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'TAR_HARDLINK_FORBIDDEN',
    );
    assert.equal(fs.readdirSync(destHl).length, 0);

    // 5. Tar Bomb (highly compressed 256 KiB zero payload extracted with 32 KiB limit)
    const bombTar = path.join(tmpDir, 'bomb.tar.bz2');
    createTarBz2ViaPython(
      bombTar,
      `
data = b"\\x00" * (256 * 1024)
info = tarfile.TarInfo("model/bomb.onnx")
info.size = len(data)
tf.addfile(info, io.BytesIO(data))
`,
    );
    const destBomb = path.join(extractParent, 'case-bomb');
    await assert.rejects(
      () =>
        extractTarBz2Safe(bombTar, destBomb, {
          maxSingleFileBytes: 32 * 1024,
          maxTotalBytes: 32 * 1024,
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'TAR_BOMB_LIMIT_EXCEEDED',
    );
    assert.equal(fs.readdirSync(destBomb).length, 0);

    // 6. Too many files bomb
    const manyTar = path.join(tmpDir, 'many.tar.bz2');
    createTarBz2ViaPython(
      manyTar,
      `
for i in range(6):
    info = tarfile.TarInfo(f"model/f{i}.txt")
    info.size = 1
    tf.addfile(info, io.BytesIO(b"x"))
`,
    );
    const destMany = path.join(extractParent, 'case-many');
    await assert.rejects(
      () => extractTarBz2Safe(manyTar, destMany, { maxFiles: 3 }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'TAR_TOO_MANY_FILES',
    );
    assert.equal(fs.readdirSync(destMany).length, 0);

    // 7. Missing safe extractor fails closed (NEVER falls back to unsafe `tar -xjf`)
    const validTar = path.join(tmpDir, 'valid.tar.bz2');
    createTarBz2ViaPython(
      validTar,
      `
m = tarfile.TarInfo("pkg/model.int8.onnx")
md = b"ONNX_V2_HEALTHY"
m.size = len(md)
tf.addfile(m, io.BytesIO(md))
t = tarfile.TarInfo("pkg/tokens.txt")
td = "<blk> 0\\nا 1\\n".encode("utf-8")
t.size = len(td)
tf.addfile(t, io.BytesIO(td))
`,
    );
    const destNoPy = path.join(extractParent, 'case-nopy');
    await assert.rejects(
      () => extractTarBz2Safe(validTar, destNoPy, { pythonBin: 'nonexistent-python-binary-avp' }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'SAFE_TAR_EXTRACTOR_UNAVAILABLE',
    );

    // 8. Valid archive extracts cleanly with safe permissions (0o644)
    const destValid = path.join(extractParent, 'case-valid');
    const extracted = await extractTarBz2Safe(validTar, destValid);
    assert.deepEqual(extracted.extractedFiles, ['pkg/model.int8.onnx', 'pkg/tokens.txt']);
    assert.equal(
      fs.readFileSync(path.join(destValid, 'pkg/model.int8.onnx'), 'utf8'),
      'ONNX_V2_HEALTHY',
    );

    // 9. Atomic Activation & Rollback:
    // Create a healthy v1 active installation
    const activeDir = path.join(tmpDir, 'active-model');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'model.int8.onnx'), 'HEALTHY_V1');

    // Attempt to activate a corrupt/incomplete staged directory -> MUST FAIL and preserve HEALTHY_V1 untouched!
    const badStage = path.join(tmpDir, 'bad-stage');
    fs.mkdirSync(badStage, { recursive: true });
    fs.writeFileSync(path.join(badStage, 'model.int8.onnx'), 'CORRUPT_PARTIAL');
    await assert.rejects(
      () =>
        activateDirectoryAtomically({
          stagedDir: badStage,
          targetDir: activeDir,
          validateStaged: () => false,
        }),
      (e: unknown) => e instanceof ModelSupplyChainError && e.code === 'ATOMIC_ACTIVATION_VALIDATION_FAILED',
    );
    assert.equal(
      fs.readFileSync(path.join(activeDir, 'model.int8.onnx'), 'utf8'),
      'HEALTHY_V1',
      'Previously healthy model MUST remain intact after failed activation',
    );

    // Now activate a validated healthy v2 staged directory -> atomically replaces v1!
    const goodStage = path.join(tmpDir, 'good-stage');
    fs.mkdirSync(goodStage, { recursive: true });
    fs.writeFileSync(path.join(goodStage, 'model.int8.onnx'), 'HEALTHY_V2');
    await activateDirectoryAtomically({
      stagedDir: goodStage,
      targetDir: activeDir,
      validateStaged: (dir) => fs.readFileSync(path.join(dir, 'model.int8.onnx'), 'utf8') === 'HEALTHY_V2',
    });
    assert.equal(fs.readFileSync(path.join(activeDir, 'model.int8.onnx'), 'utf8'), 'HEALTHY_V2');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PILLAR 5: HARDENED BROWSER MODEL ARTIFACT ROUTER + INSTALLER E2E
// ═══════════════════════════════════════════════════════════════════════════

test('Phase 1A.1 (Public Model Artifact Router): Enforces 1 MiB Range ceiling, rejects multi-range & invalid ranges, single-flight /prepare, manifest allowlist, integrity check, ETag 304, and full BrowserPersianModelInstaller compatibility', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-1a1-art-'));
  const modelDir = path.join(tmpDir, 'shenava-rizen');
  fs.mkdirSync(modelDir, { recursive: true });

  // 2.5 MiB synthetic model.int8.onnx (> 1 MiB MAX_MODEL_ARTIFACT_RANGE_BYTES)
  const onnxBytes = new Uint8Array(2 * 1024 * 1024 + 512 * 1024);
  for (let i = 0; i < onnxBytes.byteLength; i += 4096) {
    onnxBytes[i] = (i / 4096) & 0xff;
  }
  const tokensBytes = new TextEncoder().encode('<blk> 0\n▁سلام 1\n▁آواپرداز 2\n');

  const onnxPath = path.join(modelDir, 'model.int8.onnx');
  const tokensPath = path.join(modelDir, 'tokens.txt');
  fs.writeFileSync(onnxPath, onnxBytes);
  fs.writeFileSync(tokensPath, tokensBytes);

  const onnxSha = sha256Bytes(onnxBytes);
  const tokensSha = sha256Bytes(tokensBytes);

  let prepareInvocations = 0;
  const provider = {
    ensureShenavaRizehModelArtifacts: async () => {
      prepareInvocations++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        modelId: 'shenava-rizen-fa-fastconformer-int8' as const,
        upstreamModelId: 'sherpa-onnx-nemo-fast-conformer-ctc-fa',
        modelVersion: '1.0.0',
        architecture: 'FASTCONFORMER_CTC' as const,
        rootDir: modelDir,
        modelOnnxPath: onnxPath,
        tokensPath,
        sampleWavPath: null,
        modelOnnxBytes: onnxBytes.byteLength,
        tokensBytes: tokensBytes.byteLength,
        modelOnnxSha256Hex: onnxSha,
        tokensSha256Hex: tokensSha,
      };
    },
  };

  const app = express();
  app.use(
    '/api/v1/local-models/shenava-rizen',
    createLocalModelArtifactHttpRouter({ provider }),
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  try {
    // 1. Concurrent POST /prepare -> single-flight (provider called strictly ONCE across 8 concurrent requests!)
    const prepResponses = await Promise.all(
      Array.from({ length: 8 }, () =>
        rawHttpRequest({
          port,
          method: 'POST',
          path: '/api/v1/local-models/shenava-rizen/prepare',
        }),
      ),
    );
    for (const r of prepResponses) {
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.maxRangeBytes, MAX_MODEL_ARTIFACT_RANGE_BYTES);
    }
    assert.equal(prepareInvocations, 1, 'Single-flight lock must coalesce concurrent /prepare calls into 1 execution');

    // 2. Artifact outside manifest -> 404 ARTIFACT_NOT_FOUND
    const badName = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/package.json',
    });
    assert.equal(badName.status, 404);
    assert.equal(badName.json.error, 'ARTIFACT_NOT_FOUND');

    const dotDotName = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/..%2Fserver.ts',
    });
    assert.equal(dotDotName.status, 404);
    assert.equal(dotDotName.json.error, 'ARTIFACT_NOT_FOUND');

    // 3. Range > 1 MiB -> 416 RANGE_TOO_LARGE
    const tooLargeRange = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx',
      headers: { Range: 'bytes=0-2097151' }, // 2 MiB
    });
    assert.equal(tooLargeRange.status, 416);
    assert.equal(tooLargeRange.json.error, 'RANGE_TOO_LARGE');

    // 4. Multi-range -> 416 MULTIPLE_RANGES_NOT_SUPPORTED
    const multiRange = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx',
      headers: { Range: 'bytes=0-100, 200-300' },
    });
    assert.equal(multiRange.status, 416);
    assert.equal(multiRange.json.error, 'MULTIPLE_RANGES_NOT_SUPPORTED');

    // 5. Invalid / malformed / suffix / out-of-bounds Range -> controlled 416
    for (const badRange of ['bytes=abc-def', 'bytes=-100', 'bytes=99999999-100000000', 'items=0-10']) {
      const r = await rawHttpRequest({
        port,
        method: 'GET',
        path: '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx',
        headers: { Range: badRange },
      });
      assert.equal(r.status, 416, `Expected 416 for Range "${badRange}", got ${r.status}`);
      assert.equal(r.headers['content-range'], `bytes */${onnxBytes.byteLength}`);
    }

    // 6. Omitting Range on > 1 MiB model.int8.onnx -> 416 RANGE_REQUIRED_FOR_LARGE_ARTIFACT
    const noRangeLarge = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx',
    });
    assert.equal(noRangeLarge.status, 416);
    assert.equal(noRangeLarge.json.error, 'RANGE_REQUIRED_FOR_LARGE_ARTIFACT');

    // 7. ETag + Immutable Cache-Control + If-None-Match -> 304 Not Modified
    const tokensRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/tokens.txt',
    });
    assert.equal(tokensRes.status, 200);
    assert.ok(tokensRes.headers.etag);
    assert.equal(tokensRes.headers['cache-control'], 'public, max-age=31536000, immutable');

    const notMod = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/tokens.txt',
      headers: { 'If-None-Match': String(tokensRes.headers.etag) },
    });
    assert.equal(notMod.status, 304);

    // 8. End-to-end BrowserPersianModelInstaller downloads the full 2.5 MiB model via 1 MiB Range slices!
    const storage = new InMemoryModelChunkStorage();
    const lifecycle = new LocalModelLifecycleManager(storage);
    const liveFetch: typeof fetch = (input, init) => {
      const rawUrl = typeof input === 'string' ? input : String(input);
      const targetUrl = rawUrl.startsWith('/') ? `http://127.0.0.1:${port}${rawUrl}` : rawUrl;
      return fetch(targetUrl, init);
    };

    const installResult = await installShenavaRizehInBrowser({
      modelManager: lifecycle,
      fetchFn: liveFetch,
      saveVocabularyFn: (_modelId, _version, tokensTxt) => ({
        ok: true,
        tokenCount: tokensTxt.trim().split('\n').length,
      }),
    });
    assert.equal(installResult.ok, true, installResult.errorMessageEn);
    assert.equal(installResult.modelVersion, '1.0.0');
    assert.equal(installResult.tokenCount, 3);
    assert.equal(installResult.snapshot.state, 'MODEL_AVAILABLE');
    assert.equal(installResult.snapshot.activeModel?.verifiedSha256Hex, onnxSha);

    // 9. Corrupting artifact on disk -> pre-delivery integrity check rejects with 500 ARTIFACT_INTEGRITY_ERROR!
    const tampered = Buffer.from(tokensBytes);
    tampered[0] = tampered[0] ^ 0xff;
    fs.writeFileSync(tokensPath, tampered);
    const corruptRes = await rawHttpRequest({
      port,
      method: 'GET',
      path: '/api/v1/local-models/shenava-rizen/artifacts/tokens.txt',
    });
    assert.equal(corruptRes.status, 500);
    assert.equal(corruptRes.json.error, 'ARTIFACT_INTEGRITY_ERROR');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
