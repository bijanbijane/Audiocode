/**
 * AVAPARDAZ — PRODUCTION NATIVE COMPANION IPC, LIFECYCLE, CHUNKED TRANSFER & CEP SECURITY SUITE
 * Missions: AVP-P0-004 (Audition CEP <-> Native Companion Integration & Hardened IPC),
 *           AVP-P0-006 (Security Hardening: IPC, Symlink/Path Confinement, Replay/Expiry)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {
  COMPANION_IPC_ERROR_CODES,
  COMPANION_IPC_PROTOCOL_VERSION,
} from '../CompanionIpcBridge';
import {
  CompanionLifecycleManager,
  CompanionSingleInstanceLock,
} from '../CompanionLifecycleManager';
import { CompanionAudioTransferManager } from '../CompanionAudioTransfer';
import { LocalCompanionService } from '../LocalCompanionService';
import { CANONICAL_CONTRACT_VERSION } from '../../../processing-engine/capabilities/CanonicalCapabilityContracts';

async function httpJson(
  port: number,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('AVP-P0-004: 12-state CompanionLifecycleManager & single-instance lockfile with stale-PID recovery', () => {
  assert.equal(COMPANION_IPC_ERROR_CODES.length, 17);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-cmp-lock-'));
  const lockPath = path.join(tmpDir, 'companion.lock');

  try {
    const mgr = new CompanionLifecycleManager({
      serviceVersion: '1.0.0',
      ipcProtocolVersion: COMPANION_IPC_PROTOCOL_VERSION,
      lockFilePath: lockPath,
      initialState: 'PROCESS_NOT_FOUND',
    });

    assert.equal(mgr.transition('STARTING', 'Boot').ok, true);
    assert.equal(mgr.transition('PORT_BOUND', 'Socket bound').ok, true);
    assert.equal(mgr.transition('AUTH_READY', 'HMAC ready').ok, true);
    assert.equal(mgr.transition('INFERENCE_READY', 'Model ready').ok, true);
    assert.equal(mgr.transition('BUSY', 'Running job').ok, true);
    // Illegal jump from BUSY directly to PORT_BOUND must fail
    assert.equal(mgr.transition('PORT_BOUND', 'Illegal').ok, false);

    // Acquire lock -> second live instance rejected
    const lock1 = new CompanionSingleInstanceLock(lockPath);
    const acq1 = lock1.acquire(
      {
        instanceId: 'inst-live-1',
        installationId: 'install-1',
        pid: process.pid,
        bindHost: '127.0.0.1',
        bindPort: 47291,
        serviceVersion: '1.0.0',
        startedAtIso: new Date().toISOString(),
      },
      () => true,
    );
    assert.equal(acq1.ok, true);

    const lock2 = new CompanionSingleInstanceLock(lockPath);
    const acq2 = lock2.acquire(
      {
        instanceId: 'inst-live-2',
        installationId: 'install-1',
        pid: process.pid + 1000,
        bindHost: '127.0.0.1',
        bindPort: 47291,
        serviceVersion: '1.0.0',
        startedAtIso: new Date().toISOString(),
      },
      () => true, // simulated live PID
    );
    assert.equal(acq2.ok, false);
    assert.equal(acq2.code, 'LOCK_HELD_BY_LIVE_INSTANCE');

    // Stale PID lockfile is automatically recovered
    const lock3 = new CompanionSingleInstanceLock(lockPath);
    const acq3 = lock3.acquire(
      {
        instanceId: 'inst-recover-3',
        installationId: 'install-1',
        pid: process.pid + 2000,
        bindHost: '127.0.0.1',
        bindPort: 47291,
        serviceVersion: '1.0.0',
        startedAtIso: new Date().toISOString(),
      },
      () => false, // previous PID is dead!
    );
    assert.equal(acq3.ok, true);
    assert.equal(acq3.recoveredStaleLock, true);
    lock3.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AVP-P0-004: CompanionAudioTransferManager validates PCM metadata, enforces chunk order/SHA-256, rejects duplicates/truncation, and cleans up', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-xfr-'));
  const mgr = new CompanionAudioTransferManager({ stagingDir: tmpDir });

  try {
    // 100 frames of mono pcm_f32le = 400 bytes across 2 chunks of 200 bytes
    const pcm = Buffer.alloc(400);
    for (let i = 0; i < 100; i++) pcm.writeFloatLE(0.25 * Math.sin(i * 0.1), i * 4);
    const fullSha = crypto.createHash('sha256').update(pcm).digest('hex');
    const c0 = pcm.subarray(0, 200);
    const c1 = pcm.subarray(200, 400);
    const c0Sha = crypto.createHash('sha256').update(c0).digest('hex');
    const c1Sha = crypto.createHash('sha256').update(c1).digest('hex');

    // Reject metadata byte mismatch
    const badInit = mgr.initTransfer({
      format: 'pcm_f32le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 999,
      expectedFrames: 100,
      totalChunks: 2,
    });
    assert.equal(badInit.ok, false);
    assert.equal(badInit.code, 'AUDIO_METADATA_MISMATCH');

    const init = mgr.initTransfer({
      filename: 'audition_clip.pcm',
      format: 'pcm_f32le',
      sampleRateHz: 16000,
      channels: 1,
      endianness: 'little',
      expectedBytes: 400,
      expectedFrames: 100,
      totalChunks: 2,
      expectedSha256: fullSha,
    });
    assert.equal(init.ok, true);
    const tid = init.transferId!;

    // Out-of-order chunk 1 before chunk 0 rejected
    const ooo = mgr.appendChunk({ transferId: tid, chunkIndex: 1, chunkBase64: c1.toString('base64'), chunkSha256: c1Sha });
    assert.equal(ooo.ok, false);
    assert.equal(ooo.code, 'OUT_OF_ORDER_CHUNK_REJECTED');

    // Corrupted chunk checksum rejected
    const badHash = mgr.appendChunk({ transferId: tid, chunkIndex: 0, chunkBase64: c0.toString('base64'), chunkSha256: '0'.repeat(64) });
    assert.equal(badHash.ok, false);
    assert.equal(badHash.code, 'CHUNK_CHECKSUM_MISMATCH');

    // Valid chunk 0
    assert.equal(mgr.appendChunk({ transferId: tid, chunkIndex: 0, chunkBase64: c0.toString('base64'), chunkSha256: c0Sha }).ok, true);

    // Duplicate chunk 0 rejected
    const dup = mgr.appendChunk({ transferId: tid, chunkIndex: 0, chunkBase64: c0.toString('base64'), chunkSha256: c0Sha });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'DUPLICATE_CHUNK_REJECTED');

    // Valid chunk 1 & finalize
    assert.equal(mgr.appendChunk({ transferId: tid, chunkIndex: 1, chunkBase64: c1.toString('base64'), chunkSha256: c1Sha }).ok, true);
    const fin = mgr.finalizeTransfer(tid);
    assert.equal(fin.ok, true);
    assert.equal(fin.sha256, fullSha);

    // Consume converts to valid RIFF/WAVE and cleans up staging temp file
    const consumed = mgr.consumeFinalizedTransferAsWav(tid);
    assert.equal(consumed.ok, true);
    assert.equal(consumed.wavBytes!.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(mgr.getActiveSessionCount(), 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AVP-P0-004 + AVP-P0-006: Hardened loopback HTTP Companion IPC enforces request_id dedup, expires_at_ms, Origin/Host guards, JOB_LIST/JOB_RECONNECT, and CEP static hygiene', async () => {
  const service = new LocalCompanionService({ maxConcurrentJobs: 2 });
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    // Health includes 12-state lifecycle & instance identity
    const health = await httpJson(port, 'GET', '/api/v2/companion/health');
    assert.equal(health.status, 200);
    assert.ok(health.json.instanceId);
    assert.ok(health.json.lifecycleState);

    // Untrusted web origin rejected with 403
    const evilOrigin = await httpJson(port, 'GET', '/api/v2/companion/health', undefined, {
      Origin: 'https://evil.example.com',
    });
    assert.equal(evilOrigin.status, 403);
    assert.equal(evilOrigin.json.error, 'UNTRUSTED_ORIGIN_BLOCKED');

    // Audition handshake rejects missing ASR and CEP DTO versions independently of IPC.
    const missingAsrVersion = await httpJson(port, 'POST', '/api/v2/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'adobe-audition',
      host_version: '24.0',
      panel_version: '1.0.0',
      host_adapter_version: '1.0.0',
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      expected_cep_transcript_schema_version: '1.0.0',
    });
    assert.equal(missingAsrVersion.status, 409);
    assert.ok(missingAsrVersion.json.incompatibility_reasons.some((reason: string) => reason.includes('ASR contract mismatch')));

    const unsupportedCepSchema = await httpJson(port, 'POST', '/api/v2/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'adobe-audition',
      host_version: '24.0',
      panel_version: '1.0.0',
      host_adapter_version: '1.0.0',
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      expected_asr_contract_version: '2.0.0',
      expected_cep_transcript_schema_version: '9.0.0',
    });
    assert.equal(unsupportedCepSchema.status, 409);
    assert.ok(unsupportedCepSchema.json.incompatibility_reasons.some((reason: string) => reason.includes('CEP transcript schema mismatch')));

    // Handshake succeeds only when IPC, canonical capability, ASR and CEP DTO versions agree.
    const hs = await httpJson(port, 'POST', '/api/v2/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'adobe-audition',
      host_version: '24.0',
      panel_version: '1.0.0',
      host_adapter_version: '1.0.0',
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      expected_asr_contract_version: '2.0.0',
      expected_cep_transcript_schema_version: '1.0.0',
    });
    assert.equal(hs.status, 200);
    assert.equal(hs.json.compatible, true);
    assert.equal(hs.json.asr_contract_version, '2.0.0');
    assert.equal(hs.json.cep_transcript_schema_version, '1.0.0');

    // Existing Web Companion / CLI clients remain compatible without CEP-only request fields.
    const webHandshake = await httpJson(port, 'POST', '/api/v2/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'cli-test',
      host_version: 'web-1.0.0',
      panel_version: '1.0.0',
      host_adapter_version: '1.0.0',
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
    });
    assert.equal(webHandshake.status, 200);
    assert.equal(webHandshake.json.compatible, true);

    // A non-Audition session cannot opt into the CEP result DTO at request time.
    const wrongHostMode = await httpJson(
      port,
      'POST',
      '/api/v2/companion/ipc',
      {
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id: webHandshake.json.session_id,
        nonce: 'n-wrong-host-mode',
        timestamp_ms: Date.now(),
        execution_mode: 'audition-cep',
        command: 'JOB_LIST',
        payload: {},
      },
      { Authorization: `Bearer ${webHandshake.json.session_token}` },
    );
    assert.equal(wrongHostMode.status, 409);
    assert.equal(wrongHostMode.json.error, 'IPC_VERSION_MISMATCH');

    // Unknown execution modes are rejected before command dispatch.
    const invalidMode = await httpJson(
      port,
      'POST',
      '/api/v2/companion/ipc',
      {
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id: webHandshake.json.session_id,
        nonce: 'n-invalid-mode',
        timestamp_ms: Date.now(),
        execution_mode: 'unknown-client',
        command: 'JOB_LIST',
        payload: {},
      },
      { Authorization: `Bearer ${webHandshake.json.session_token}` },
    );
    assert.equal(invalidMode.status, 400);
    assert.equal(invalidMode.json.error, 'IPC_INVALID_ENVELOPE');

    // Audition sessions cannot downgrade to a non-CEP serialization mode.
    const wrongAuditionMode = await httpJson(
      port,
      'POST',
      '/api/v2/companion/ipc',
      {
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id: hs.json.session_id,
        nonce: 'n-wrong-audition-mode',
        timestamp_ms: Date.now(),
        execution_mode: 'web-client',
        command: 'JOB_LIST',
        payload: {},
      },
      { Authorization: `Bearer ${hs.json.session_token}` },
    );
    assert.equal(wrongAuditionMode.status, 409);
    assert.equal(wrongAuditionMode.json.error, 'IPC_VERSION_MISMATCH');

    const { session_id, session_token } = hs.json;

    // Expired request_id envelope rejected with IPC_REQUEST_EXPIRED
    const expired = await httpJson(
      port,
      'POST',
      '/api/v2/companion/ipc',
      {
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id,
        nonce: 'n-exp-1',
        request_id: 'req-exp-1',
        timestamp_ms: Date.now(),
        expires_at_ms: Date.now() - 1000,
        command: 'JOB_LIST',
        payload: {},
      },
      { Authorization: `Bearer ${session_token}` },
    );
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error, 'IPC_REQUEST_EXPIRED');

    // Valid JOB_LIST succeeds and correlates request_id
    const list1 = await httpJson(
      port,
      'POST',
      '/api/v2/companion/ipc',
      {
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id,
        nonce: 'n-list-1',
        request_id: 'req-list-1',
        timestamp_ms: Date.now(),
        expires_at_ms: Date.now() + 60_000,
        execution_mode: 'audition-cep',
        command: 'JOB_LIST',
        payload: {},
      },
      { Authorization: `Bearer ${session_token}` },
    );
    assert.equal(list1.status, 200);
    assert.equal(list1.json.ok, true);
    assert.equal(list1.json.request_id, 'req-list-1');

    // Duplicate request_id with fresh nonce rejected with IPC_DUPLICATE_REQUEST_ID
    const dupReq = await httpJson(
      port,
      'POST',
      '/api/v2/companion/ipc',
      {
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        session_id,
        nonce: 'n-list-2-fresh',
        request_id: 'req-list-1',
        timestamp_ms: Date.now(),
        expires_at_ms: Date.now() + 60_000,
        command: 'JOB_LIST',
        payload: {},
      },
      { Authorization: `Bearer ${session_token}` },
    );
    assert.equal(dupReq.status, 409);
    assert.equal(dupReq.json.error, 'IPC_DUPLICATE_REQUEST_ID');

    // Verify CEP client & host scripts contain sourceIdentity + SOURCE_CHANGED guard & zero innerHTML XSS
    const cepApp = fs.readFileSync(path.resolve(process.cwd(), 'packages/audition-cep-plugin/client/app.js'), 'utf8');
    const cepJsx = fs.readFileSync(path.resolve(process.cwd(), 'packages/audition-cep-plugin/jsx/auditionHost.jsx'), 'utf8');
    const webClient = fs.readFileSync(path.resolve(process.cwd(), 'src/host-bridge/companion/CompanionWebClient.ts'), 'utf8');
    assert.equal((webClient.match(/execution_mode: 'web-client'/g) || []).length, 2);
    assert.equal(cepApp.includes('SOURCE_CHANGED'), true);
    assert.equal(cepApp.includes('JOB_RECONNECT'), true);
    assert.equal(cepApp.includes('expected_asr_contract_version'), true);
    assert.equal(cepApp.includes('expected_cep_transcript_schema_version'), true);
    assert.equal(cepApp.includes('job.result.schemaVersion'), true);
    assert.equal(/\.innerHTML\s*=/.test(cepApp), false);
    assert.equal(cepJsx.includes('fileSizeBytes'), true);
    assert.equal(cepJsx.includes('fileModifiedMs'), true);
  } finally {
    service.beginGracefulShutdown('Test teardown');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
