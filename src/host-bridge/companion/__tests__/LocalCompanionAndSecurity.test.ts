/**
 * AVAPARDAZ — AUTOMATED INTEGRATION, LONG-AUDIO STRESS (UP TO 60 MIN) & RED-TEAM SECURITY SUITE
 *
 * Covers PHASE-08, PHASE-09, PHASE-10, PHASE-11, PHASE-12, PHASE-14, PHASE-15:
 * 1. Subtitle & Transcript Export (TXT / SRT / VTT / JSON) with Persian RTL & honest timestamps
 * 2. Bounded-Memory Long-Audio Streaming Pipeline (10s, 1 min, 10 min, 30 min, 60 min) + VAD valley snap + overlap deduplication + cancellation
 * 3. Adversarial Companion Security Red-Team Tests:
 *    - Loopback-only enforcement
 *    - DNS rebinding Host header rejection
 *    - Malicious third-party Origin CSRF rejection
 *    - Path traversal (`../../etc/passwd`) rejection
 *    - Missing / forged HMAC session token rejection
 *    - Nonce replay attack rejection
 *    - Malformed/corrupt WAV audio rejection
 * 4. Real Offline Local Neural CPU Transcription via Sherpa-ONNX (when local runtime & FLEURS dev WAV exist)
 * 5. Adobe Audition CEP Plugin Packaging Integrity Test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import os from 'node:os';
import {
  LocalCompanionService,
  isAllowedCompanionOrigin,
  isAllowedLoopbackHostHeader,
  validateLocalAudioFilePath,
} from '../LocalCompanionService';
import { verifyModelFilesIntegrity } from '../../../asr-core/LocalSherpaNeuralEngine';
import {
  deduplicateChunkOverlap,
  runBoundedLongAudioPipeline,
} from '../../../asr-core/LongAudioChunkedPipeline';
import {
  exportTranscript,
  formatSrtTimestamp,
  formatVttTimestamp,
} from '../../../utils/subtitleExporter';

// ── 1. Subtitle & Transcript Export Tests (Persian RTL + Mixed LTR + Honest Timestamps) ──
test('exportTranscript produces valid UTF-8 TXT, SRT, VTT, JSON with Persian RTL & no fabricated words', () => {
  const segments = [
    {
      id: 's1',
      startSec: 0.25,
      endSec: 3.75,
      text: 'سلام، امروز API آواپرداز روی CPU محلی اجرا می‌شود.',
      language: 'fa-en',
      speaker: 'گوینده ۱',
      timestampGranularity: 'SEGMENT' as const,
      words: [],
    },
    {
      id: 's2',
      startSec: 4.0,
      endSec: 7.125,
      text: 'This works 100% offline inside Adobe Audition.',
      language: 'en',
      timestampGranularity: 'SEGMENT' as const,
      words: [],
    },
  ];

  assert.equal(formatSrtTimestamp(3661.234), '01:01:01,234');
  assert.equal(formatVttTimestamp(3661.234), '01:01:01.234');

  const srt = exportTranscript({ format: 'srt', segments, timelineOffsetSec: 10 });
  assert.equal(srt.segmentCount, 2);
  assert.match(srt.content, /^1\n00:00:10,250 --> 00:00:13,750\nسلام، امروز API آواپرداز/m);
  assert.match(srt.content, /2\n00:00:14,000 --> 00:00:17,125\nThis works 100% offline/m);

  const vtt = exportTranscript({ format: 'vtt', segments });
  assert.ok(vtt.content.startsWith('WEBVTT\n\n'));
  assert.match(vtt.content, /00:00:00\.250 --> 00:00:03\.750/);

  const txtSelected = exportTranscript({
    format: 'txt',
    segments,
    selectedIds: ['s1'],
    includeSpeakerLabels: true,
  });
  assert.equal(txtSelected.segmentCount, 1);
  assert.equal(txtSelected.content, '[گوینده ۱] سلام، امروز API آواپرداز روی CPU محلی اجرا می‌شود.');

  const jsonOut = exportTranscript({ format: 'json', segments });
  const parsed = JSON.parse(jsonOut.content);
  assert.equal(parsed.schema, 'avapardaz.transcript.export.v1');
  assert.equal(parsed.segments[0].timestampGranularity, 'SEGMENT');
  // Must NEVER fabricate word-level timestamps from segment-level input
  assert.deepEqual(parsed.segments[0].words, []);
});

// ── 2. Long-Audio Streaming Pipeline Stress Tests (10s, 1m, 10m, 30m, 60m) ──
test('deduplicateChunkOverlap removes duplicated Persian/English seam tokens without mutating text', () => {
  const prev = ['بیشتر', 'دوران', 'زندگی', 'این', 'خانواده'];
  const { appendedWords, removedCount } = deduplicateChunkOverlap(
    prev,
    'این خانواده یهودی در فضای باز گذشت',
  );
  assert.equal(removedCount, 2);
  assert.deepEqual(appendedWords, ['یهودی', 'در', 'فضای', 'باز', 'گذشت']);
});

test('runBoundedLongAudioPipeline sustains O(1) memory stability across 10s, 1m, 10m, 30m, and 60m recordings', async () => {
  const durationsSec = [10, 60, 600, 1800, 3600];
  const sr = 16_000;

  for (const durSec of durationsSec) {
    const totalSamples = durSec * sr;
    // Virtual O(1) audio reader simulating a 60-minute disk stream with periodic silence valleys
    const readPcmWindow = (start: number, end: number) => {
      const len = Math.max(0, end - start);
      const buf = new Float32Array(len);
      for (let i = 0; i < len; i += 64) {
        const globalSec = (start + i) / sr;
        // Inject 0.4s silence valleys every 25s
        const inValley = globalSec % 25 > 24.6;
        buf[i] = inValley ? 0.0 : 0.25;
      }
      return buf;
    };

    const res = await runBoundedLongAudioPipeline({
      totalSamples,
      readPcmWindow,
      decodeChunk: async (_pcm, plan) => ({
        text: plan.chunkIndex === 0
          ? `بخش ${plan.chunkIndex} شروع جلسه آواپرداز`
          : `جلسه آواپرداز بخش ${plan.chunkIndex} ادامه`,
        language: 'fa',
      }),
      options: { maxChunkDurationSec: 25, overlapSec: 1.5 },
    });

    assert.equal(res.cancelled, false);
    assert.equal(res.totalAudioSec, durSec);
    assert.ok(res.chunkCount >= 1);
    if (durSec >= 60) {
      assert.ok(res.totalDeduplicatedWords >= 2, `Expected overlap dedup on ${durSec}s audio`);
    }
    // Strict bounded memory guarantee: RSS growth during 60-minute streaming must remain < 128 MiB
    assert.ok(
      res.rssDeltaMb < 128,
      `RSS delta ${res.rssDeltaMb} MiB exceeded 128 MiB bound on ${durSec}s recording`,
    );
  }
});

test('runBoundedLongAudioPipeline honours AbortSignal cancellation cleanly mid-stream', async () => {
  const abortCtrl = new AbortController();
  let chunksDecoded = 0;
  const res = await runBoundedLongAudioPipeline({
    totalSamples: 600 * 16_000,
    readPcmWindow: (s, e) => new Float32Array(e - s),
    decodeChunk: async (_pcm, plan) => {
      chunksDecoded++;
      if (chunksDecoded === 2) abortCtrl.abort();
      return { text: `chunk ${plan.chunkIndex}`, language: 'en' };
    },
    options: { maxChunkDurationSec: 25, overlapSec: 1.5, signal: abortCtrl.signal },
  });
  assert.equal(res.cancelled, true);
  assert.equal(chunksDecoded, 2);
});

// ── 3. Red-Team Security Controls (Host, Origin, Path Traversal, HMAC, Replay, Corrupt WAV) ──
test('Red-Team: Host DNS rebinding, untrusted Origin CSRF, and Path Traversal are blocked', () => {
  assert.equal(isAllowedLoopbackHostHeader('127.0.0.1:47291'), true);
  assert.equal(isAllowedLoopbackHostHeader('localhost:3000'), true);
  assert.equal(isAllowedLoopbackHostHeader('[::1]:47291'), true);
  assert.equal(isAllowedLoopbackHostHeader('evil.attacker.com:47291'), false);
  assert.equal(isAllowedLoopbackHostHeader('127.0.0.1.evil.com'), false);

  assert.equal(isAllowedCompanionOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedCompanionOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedCompanionOrigin('file://'), true);
  assert.equal(isAllowedCompanionOrigin('null'), true);
  assert.equal(isAllowedCompanionOrigin('https://evil-site.example'), false);

  const traversal = validateLocalAudioFilePath('/tmp/../../etc/passwd.wav');
  assert.equal(traversal.ok, false);
  assert.equal(traversal.code, 'PATH_TRAVERSAL_REJECTED');

  const badExt = validateLocalAudioFilePath('/etc/passwd');
  assert.equal(badExt.ok, false);
  assert.equal(badExt.code, 'UNSUPPORTED_AUDIO_EXTENSION');

  const nullByte = validateLocalAudioFilePath('/tmp/test.wav\0.txt');
  assert.equal(nullByte.ok, false);
});

test('Red-Team: Live Companion HTTP server enforces HMAC auth, nonce replay, Origin/Host checks, and real offline ASR', async () => {
  const service = new LocalCompanionService();
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter());

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}/api/v2/companion`;

  try {
    // A. Untrusted Origin blocked with 403
    const evilOriginResp = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://malicious.attacker.example' },
    });
    assert.equal(evilOriginResp.status, 403);

    // B. Trusted loopback health succeeds
    const healthResp = await fetch(`${baseUrl}/health`);
    assert.equal(healthResp.status, 200);
    const health = (await healthResp.json()) as {
      offlineOnlyEnforced: boolean;
      runtime: { available: boolean; installedModels: { modelId: string }[] };
    };
    assert.equal(health.offlineOnlyEnforced, true);

    // C. Unauthorized IPC without token rejected with 401
    const unauthResp = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: 'fake',
        nonce: 'n1',
        timestamp_ms: Date.now(),
        command: 'CAPABILITY_LIST',
        payload: {},
      }),
    });
    assert.equal(unauthResp.status, 401);

    // D. Valid handshake issues ephemeral HMAC session token
    const hsResp = await fetch(`${baseUrl}/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        host_id: 'cli-test',
        host_version: 'test-1.0.0',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: '2.0.0',
      }),
    });
    assert.equal(hsResp.status, 200);
    const hs = (await hsResp.json()) as {
      compatible: boolean;
      session_id: string;
      session_token: string;
    };
    assert.equal(hs.compatible, true);
    assert.ok(hs.session_token.length > 20);

    // E. Nonce replay attack rejected with 409
    const replayPayload = JSON.stringify({
      ipc_protocol_version: '1.0.0',
      session_id: hs.session_id,
      nonce: 'fixed-replay-nonce-001',
      timestamp_ms: Date.now(),
      command: 'CAPABILITY_LIST',
      payload: {},
    });
    const firstCall = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
      body: replayPayload,
    });
    assert.equal(firstCall.status, 200);
    const capListData = (await firstCall.json()) as { ok: boolean; capabilities?: string[] };
    assert.equal(capListData.ok, true);
    assert.ok(Array.isArray(capListData.capabilities) && capListData.capabilities.length >= 6);
    const replayCall = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
      body: replayPayload,
    });
    assert.equal(replayCall.status, 409);

    // E2. Bundled sample Persian WAV retrieval when runtime and sample audio exist
    if ((health as { sampleAudioAvailable?: boolean }).sampleAudioAvailable) {
      const sampleResp = await fetch(`${baseUrl}/ipc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: hs.session_id,
          nonce: 'nonce-sample-wav-001',
          timestamp_ms: Date.now(),
          command: 'CAPABILITY_EXECUTE',
          payload: { action: 'GET_SAMPLE_PERSIAN_AUDIO' },
        }),
      });
      assert.equal(sampleResp.status, 200);
      const sampleJson = (await sampleResp.json()) as {
        ok: boolean;
        audioBase64?: string;
        filename?: string;
      };
      assert.equal(sampleJson.ok, true);
      assert.ok(sampleJson.audioBase64 && sampleJson.audioBase64.length > 100);
      const wavBuf = Buffer.from(sampleJson.audioBase64, 'base64');
      assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
    }

    // F. Path traversal via JOB_SUBMIT rejected with 403
    const travCall = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: hs.session_id,
        nonce: 'nonce-trav-001',
        timestamp_ms: Date.now(),
        command: 'JOB_SUBMIT',
        payload: { filePath: '/tmp/../../etc/passwd.wav' },
      }),
    });
    assert.ok(travCall.status === 403 || travCall.status === 503);

    // G. Real Offline Local Neural CPU Transcription on real FLEURS Persian WAV (when installed locally)
    const sampleWav = '/tmp/avp-p02-bench/audio/canonical_16k/fleurs-fa-dev-01.wav';
    if (health.runtime.available && fs.existsSync(sampleWav)) {
      const submitResp = await fetch(`${baseUrl}/ipc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: hs.session_id,
          nonce: 'nonce-real-fa-001',
          timestamp_ms: Date.now(),
          command: 'JOB_SUBMIT',
          payload: {
            filePath: sampleWav,
            modelId: 'Reza2kn/Shenava-Rizeh',
            languageHint: 'fa',
          },
        }),
      });
      assert.equal(submitResp.status, 202);
      const submitted = (await submitResp.json()) as { ok: boolean; job: { jobId: string } };

      type PolledRealJob = { status: string; result?: { rawText: string; offlineVerified: boolean; timestampGranularity: string } };
      let finalJob: PolledRealJob | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((r) => setTimeout(r, 250));
        const stResp = await fetch(`${baseUrl}/ipc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
          body: JSON.stringify({
            ipc_protocol_version: '1.0.0',
            session_id: hs.session_id,
            nonce: `nonce-poll-${attempt}`,
            timestamp_ms: Date.now(),
            command: 'JOB_STATUS',
            payload: { jobId: submitted.job.jobId },
          }),
        });
        const st = (await stResp.json()) as { job: PolledRealJob | null };
        finalJob = st.job;
        if (finalJob && (finalJob.status === 'COMPLETED' || finalJob.status === 'FAILED')) break;
      }

      assert.equal(finalJob?.status, 'COMPLETED');
      assert.equal(finalJob?.result?.offlineVerified, true);
      assert.equal(finalJob?.result?.timestampGranularity, 'WORD');
      assert.ok((finalJob?.result?.rawText ?? '').includes('بیشتر'), 'Expected genuine Persian transcription output');

      // H. Corrupt WAV rejection test
      const corruptResp = await fetch(`${baseUrl}/ipc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: hs.session_id,
          nonce: 'nonce-corrupt-001',
          timestamp_ms: Date.now(),
          command: 'JOB_SUBMIT',
          payload: {
            audioBase64: Buffer.from('NOT_A_VALID_WAV_HEADER_DATA').toString('base64'),
            filename: 'corrupt.wav',
            modelId: 'Reza2kn/Shenava-Rizeh',
          },
        }),
      });
      assert.equal(corruptResp.status, 202);
      const corruptSub = (await corruptResp.json()) as { job: { jobId: string } };
      type PolledCorruptJob = { status: string; errorCode: string | null };
      let corruptJob: PolledCorruptJob | null = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const r = await fetch(`${baseUrl}/ipc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
          body: JSON.stringify({
            ipc_protocol_version: '1.0.0',
            session_id: hs.session_id,
            nonce: `nonce-corrupt-poll-${i}`,
            timestamp_ms: Date.now(),
            command: 'JOB_STATUS',
            payload: { jobId: corruptSub.job.jobId },
          }),
        });
        const d = (await r.json()) as { job: PolledCorruptJob | null };
        corruptJob = d.job;
        if (corruptJob && corruptJob.status !== 'RUNNING') break;
      }
      assert.equal(corruptJob?.status, 'FAILED');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── 4. Adobe Audition CEP Plugin Manifest & Asset Verification ──
test('Adobe Audition CEP plugin contains verified AUDT manifest, CSP-protected UI, and installers', () => {
  const root = path.resolve(process.cwd(), 'packages', 'audition-cep-plugin');
  const manifest = fs.readFileSync(path.join(root, 'CSXS', 'manifest.xml'), 'utf8');
  assert.ok(manifest.includes('Host Name="AUDT"'), 'Manifest must target Adobe Audition (AUDT)');
  assert.ok(manifest.includes('ir.avapardaz.audition.cep'));

  const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('dir="rtl"'));

  const jsx = fs.readFileSync(path.join(root, 'jsx', 'auditionHost.jsx'), 'utf8');
  assert.ok(jsx.includes('avpGetActiveDocumentInfo'));
});

test('Chunked Companion upload and same-origin reverse-proxy guard work securely', async () => {
  const service = new LocalCompanionService();
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter({ allowSameOriginProxyHost: true }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api/v2/companion`;

  try {
    // 1. Same-origin preview proxy Origin matches X-Forwarded-Host -> ALLOWED
    const previewHs = await fetch(`${baseUrl}/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'ais-dev-preview.run.app',
        Origin: 'https://ais-dev-preview.run.app',
      },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        host_id: 'cli-test',
        host_version: 'web-1.0.0',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: '2.0.0',
      }),
    });
    assert.equal(previewHs.status, 200);
    const hs = (await previewHs.json()) as { compatible: boolean; session_id: string; session_token: string };
    assert.equal(hs.compatible, true);

    // Session B must not append to or abort a staged upload owned by session A.
    const secondHsResp = await fetch(`${baseUrl}/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        host_id: 'cli-test',
        host_version: 'web-1.0.0',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: '2.0.0',
      }),
    });
    assert.equal(secondHsResp.status, 200);
    const secondHs = (await secondHsResp.json()) as { compatible: boolean; session_id: string; session_token: string };
    assert.equal(secondHs.compatible, true);

    const uploadInitResp = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: hs.session_id,
        nonce: 'owner-upload-init',
        timestamp_ms: Date.now(),
        command: 'CAPABILITY_EXECUTE',
        payload: { action: 'AUDIO_UPLOAD_INIT', filename: 'owner-isolation.wav' },
      }),
    });
    assert.equal(uploadInitResp.status, 200);
    const ownerUpload = (await uploadInitResp.json()) as { ok: boolean; uploadId: string };
    assert.equal(ownerUpload.ok, true);

    const foreignAppendResp = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secondHs.session_token}` },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: secondHs.session_id,
        nonce: 'owner-upload-foreign-append',
        timestamp_ms: Date.now(),
        command: 'CAPABILITY_EXECUTE',
        payload: {
          action: 'AUDIO_UPLOAD_CHUNK',
          uploadId: ownerUpload.uploadId,
          chunkBase64: Buffer.from('foreign').toString('base64'),
        },
      }),
    });
    assert.equal(foreignAppendResp.status, 403);
    assert.equal((await foreignAppendResp.json()).error, 'UPLOAD_OWNER_MISMATCH');

    const foreignAbortResp = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secondHs.session_token}` },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: secondHs.session_id,
        nonce: 'owner-upload-foreign-abort',
        timestamp_ms: Date.now(),
        command: 'CAPABILITY_EXECUTE',
        payload: { action: 'AUDIO_UPLOAD_ABORT', uploadId: ownerUpload.uploadId },
      }),
    });
    assert.equal(foreignAbortResp.status, 200);

    const ownerAppendResp = await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: hs.session_id,
        nonce: 'owner-upload-owner-append',
        timestamp_ms: Date.now(),
        command: 'CAPABILITY_EXECUTE',
        payload: {
          action: 'AUDIO_UPLOAD_CHUNK',
          uploadId: ownerUpload.uploadId,
          chunkBase64: Buffer.from('owner').toString('base64'),
        },
      }),
    });
    assert.equal(ownerAppendResp.status, 200);
    await fetch(`${baseUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: hs.session_id,
        nonce: 'owner-upload-owner-abort',
        timestamp_ms: Date.now(),
        command: 'CAPABILITY_EXECUTE',
        payload: { action: 'AUDIO_UPLOAD_ABORT', uploadId: ownerUpload.uploadId },
      }),
    });

    // 2. Foreign cross-origin CSRF Origin is STILL blocked with 403!
    const foreignCsrf = await fetch(`${baseUrl}/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'ais-dev-preview.run.app',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({}),
    });
    assert.equal(foreignCsrf.status, 403);

    // 3. Chunked upload -> real offline Persian transcription via uploadId
    const sampleWav = '/tmp/avp-p02-bench/audio/canonical_16k/fleurs-fa-dev-01.wav';
    if (service.getHealth().runtime.available && fs.existsSync(sampleWav)) {
      const wavBytes = fs.readFileSync(sampleWav);
      const initResp = await fetch(`${baseUrl}/ipc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: hs.session_id,
          nonce: 'chunk-init-1',
          timestamp_ms: Date.now(),
          command: 'CAPABILITY_EXECUTE',
          payload: { action: 'AUDIO_UPLOAD_INIT', filename: 'fleurs-chunked.wav' },
        }),
      });
      assert.equal(initResp.status, 200);
      const initData = (await initResp.json()) as { ok: boolean; uploadId: string };
      assert.equal(initData.ok, true);

      const mid = Math.floor(wavBytes.byteLength / 2);
      const parts = [wavBytes.subarray(0, mid), wavBytes.subarray(mid)];
      for (let i = 0; i < parts.length; i++) {
        const chResp = await fetch(`${baseUrl}/ipc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
          body: JSON.stringify({
            ipc_protocol_version: '1.0.0',
            session_id: hs.session_id,
            nonce: `chunk-part-${i}`,
            timestamp_ms: Date.now(),
            command: 'CAPABILITY_EXECUTE',
            payload: {
              action: 'AUDIO_UPLOAD_CHUNK',
              uploadId: initData.uploadId,
              chunkIndex: i,
              chunkBase64: parts[i].toString('base64'),
            },
          }),
        });
        assert.equal(chResp.status, 200);
      }

      const subResp = await fetch(`${baseUrl}/ipc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: hs.session_id,
          nonce: 'chunk-submit-1',
          timestamp_ms: Date.now(),
          command: 'JOB_SUBMIT',
          payload: {
            uploadId: initData.uploadId,
            filename: 'fleurs-chunked.wav',
            languageHint: 'fa',
          },
        }),
      });
      assert.equal(subResp.status, 202);
      const subData = (await subResp.json()) as { job: { jobId: string } };

      type PolledChunkJob = { status: string; result?: { rawText: string } };
      let finalJob: PolledChunkJob | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((r) => setTimeout(r, 250));
        const stResp = await fetch(`${baseUrl}/ipc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hs.session_token}` },
          body: JSON.stringify({
            ipc_protocol_version: '1.0.0',
            session_id: hs.session_id,
            nonce: `chunk-poll-${attempt}`,
            timestamp_ms: Date.now(),
            command: 'JOB_STATUS',
            payload: { jobId: subData.job.jobId },
          }),
        });
        const st = (await stResp.json()) as { job: PolledChunkJob | null };
        finalJob = st.job;
        if (finalJob && (finalJob.status === 'COMPLETED' || finalJob.status === 'FAILED')) break;
      }
      assert.equal(finalJob?.status, 'COMPLETED');
      assert.ok((finalJob?.result?.rawText ?? '').includes('بیشتر'));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('verifyModelFilesIntegrity verifies genuine Shenava-Rizeh SHA-256 digests and rejects tampered weights', () => {
  const realModelDir = path.join(
    os.homedir(),
    '.avapardaz',
    'models',
    'sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26',
  );
  const realOnnx = path.join(realModelDir, 'model.int8.onnx');
  const realTokens = path.join(realModelDir, 'tokens.txt');
  if (fs.existsSync(realOnnx) && fs.existsSync(realTokens)) {
    assert.equal(verifyModelFilesIntegrity([realOnnx, realTokens]), true);
  }

  // Tampered model file (wrong size / wrong digest) MUST fail strict integrity verification
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-integrity-test-'));
  try {
    const fakeOnnx = path.join(tmpDir, 'model.int8.onnx');
    const fakeTokens = path.join(tmpDir, 'tokens.txt');
    fs.writeFileSync(fakeOnnx, Buffer.from('corrupt-weights-placeholder'));
    fs.writeFileSync(fakeTokens, Buffer.from('<blk> 0\n'));
    assert.equal(verifyModelFilesIntegrity([fakeOnnx, fakeTokens]), false);
    assert.equal(verifyModelFilesIntegrity([]), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


