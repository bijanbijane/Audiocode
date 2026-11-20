/**
 * AVP-ARCH-001 (Version 4.0) — Full Backend v2 Integration & Conformance Test Suite
 *
 * Tests live Express HTTP routes (`/api/v2/*`):
 * 1. Health & Authoritative Capability Registry (all 6 capabilities)
 * 2. Direct execution of speech.transcription, audio.quality_analysis, silence/filler/repetition, intelligent_editing
 * 3. Strict Local/Cloud routing policy (CLOUD_ONLY fails explicitly with 503; zero silent Local fallback)
 * 4. Async Job Lifecycle: submission, idempotency deduplication, completion, and active cancellation
 * 5. Host-Neutral Canonical Project: non-destructive EditPlan approval, stale-revision 409 guard, commit & rollback
 * 6. Adobe Audition Host Capability Matrix + SESX v1.9 export & validator (valid + malformed rejection)
 * 7. Companion IPC Security Bridge: loopback enforcement, version handshake, HMAC auth, nonce replay rejection
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAvapardazBackendRouter } from '../AvapardazBackendRouter';
import {
  CANONICAL_CONTRACT_VERSION,
  CanonicalOperationEnvelope,
} from '../../processing-engine/capabilities/CanonicalCapabilityContracts';
import { uint8ArrayToTransportSafeAudioInput } from '../../processing-engine/UnifiedProcessingContract';
import { synthesizeAcousticSpeechFromText } from '../../asr-core/CoreAcousticCtcEngine';
import { float32ToPcm16Buffer } from '../../asr-core/CoreAudioIngestion';
import {
  COMPANION_IPC_PROTOCOL_VERSION,
  CompanionIpcBridge,
} from '../../host-bridge/companion/CompanionIpcBridge';

async function startTestServer(remoteAddressOverride?: () => string | undefined) {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  const { router, services } = createAvapardazBackendRouter(
    remoteAddressOverride ? { resolveRemoteAddress: () => remoteAddressOverride() } : undefined,
  );
  app.use('/api/v2', router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v2`;

  return {
    baseUrl,
    services,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function makeSyntheticPcm16AudioInput(text = 'سلام امروز سرویس گفتار آماده') {
  const pcm = synthesizeAcousticSpeechFromText(text, { speakerPitchHz: 145 });
  // Pad 1.2s trailing silence so silence detector has a real pause interval too
  const padded = new Float32Array(pcm.length + 16_000 * 1.2);
  padded.set(pcm, 0);
  const buf = float32ToPcm16Buffer(padded);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    sha,
    totalSamples: padded.length,
    audio: uint8ArrayToTransportSafeAudioInput({
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      encoding: 'BASE64_PCM16_16K_MONO',
      metadata: {
        filename: 'test-sample.pcm',
        mimeType: 'audio/pcm',
        containerFormat: 'pcm16',
        sampleRateHz: 16000,
        channelCount: 1,
        durationSecEstimate: Number((padded.length / 16000).toFixed(3)),
        sha256Hex: sha,
      },
    }),
  };
}

function buildEnvelope<T>(
  capabilityId: CanonicalOperationEnvelope['capability_id'],
  inputPayload: T,
  overrides?: Partial<CanonicalOperationEnvelope<T>>,
): CanonicalOperationEnvelope<T> {
  const reqId = `req_${crypto.randomBytes(4).toString('hex')}`;
  return {
    request_id: reqId,
    capability_id: capabilityId,
    operation_version: '1.0.0',
    contract_version: CANONICAL_CONTRACT_VERSION,
    project_id: 'proj_test_1',
    project_revision: 1,
    media_references: [
      {
        media_id: 'med_test_1',
        filename: 'test-sample.pcm',
        sha256_hex: 'a'.repeat(64),
        sample_rate_hz: 16000,
        channel_count: 1,
        byte_length: 64000,
      },
    ],
    input_payload: inputPayload,
    configuration: {},
    execution_policy: 'LOCAL_ONLY',
    requested_model_policy: 'AUTO_BEST_LOCAL',
    idempotency_key: `idem_${reqId}`,
    created_at: new Date().toISOString(),
    correlation_id: `corr_${reqId}`,
    ...overrides,
  };
}

test('AVP-ARCH-001 Backend v2: Health, Capability Registry & All 6 Core Capabilities + Zero Silent Cloud Fallback', async () => {
  const srv = await startTestServer();
  try {
    // 1. Health & Capability Discovery
    const healthRes = await fetch(`${srv.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health.policy_id, 'AVP-ARCH-001');
    assert.equal(health.registered_capabilities, 6);

    const capsRes = await fetch(`${srv.baseUrl}/capabilities`);
    assert.equal(capsRes.status, 200);
    const capsJson = (await capsRes.json()) as { capabilities: Array<{ capability_id: string }> };
    assert.equal(capsJson.capabilities.length, 6);

    const { audio, sha } = makeSyntheticPcm16AudioInput();
    const timedTokens = [
      { id: 'w1', track_id: 'trk_1', original_text: 'سلام', start_sec: 0.1, end_sec: 0.4 },
      { id: 'w2', track_id: 'trk_1', original_text: 'اممم', start_sec: 0.45, end_sec: 0.85 },
      { id: 'w3', track_id: 'trk_1', original_text: 'خب', start_sec: 0.9, end_sec: 1.15 },
      { id: 'w4', track_id: 'trk_1', original_text: 'امروز', start_sec: 1.2, end_sec: 1.5 },
      { id: 'w5', track_id: 'trk_1', original_text: 'امروز', start_sec: 1.55, end_sec: 1.85 },
      { id: 'w6', track_id: 'trk_1', original_text: 'برنامه', start_sec: 1.9, end_sec: 2.3 },
    ];

    // 2. speech.transcription (LOCAL_ONLY)
    const trRes = await fetch(`${srv.baseUrl}/capabilities/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildEnvelope('speech.transcription', {
          audio,
          processing_mode: 'batch',
          language_hint: 'fa',
          normalization_profile: 'FA-STRICT-V1',
        }),
      ),
    });
    assert.equal(trRes.status, 200);
    const trBody = (await trRes.json()) as {
      status: string;
      actual_execution_environment: string;
      result_payload: { raw_model_output: string };
    };
    assert.equal(trBody.status, 'COMPLETED');
    assert.equal(trBody.actual_execution_environment, 'LOCAL');
    assert.equal(typeof trBody.result_payload.raw_model_output, 'string');

    // 3. audio.quality_analysis
    const qaRes = await fetch(`${srv.baseUrl}/capabilities/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildEnvelope('audio.quality_analysis', { audio })),
    });
    assert.equal(qaRes.status, 200);
    const qaBody = (await qaRes.json()) as { result_payload: { duration_sec: number; estimated_snr_db: number } };
    assert.ok(qaBody.result_payload.duration_sec > 1.5);
    assert.ok(Number.isFinite(qaBody.result_payload.estimated_snr_db));

    // 4. audio.silence_detection, speech.filler_detection, speech.repetition_detection
    for (const capId of [
      'audio.silence_detection',
      'speech.filler_detection',
      'speech.repetition_detection',
    ] as const) {
      const evRes = await fetch(`${srv.baseUrl}/capabilities/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          buildEnvelope(capId, {
            track_id: 'trk_1',
            sample_rate_hz: 16000,
            audio,
            tokens: timedTokens,
          }),
        ),
      });
      assert.equal(evRes.status, 200, `Capability ${capId} failed`);
      const evBody = (await evRes.json()) as { status: string; capability_id: string };
      assert.equal(evBody.status, 'COMPLETED');
      assert.equal(evBody.capability_id, capId);
    }

    // 5. speech.intelligent_editing (Non-Destructive EDL)
    const edlRes = await fetch(`${srv.baseUrl}/capabilities/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildEnvelope('speech.intelligent_editing', {
          track_id: 'trk_1',
          source_audio_id: 'med_test_1',
          source_audio_hash: sha,
          transcript_version: 'raw-v1',
          sample_rate_hz: 16000,
          audio,
          tokens: timedTokens,
        }),
      ),
    });
    assert.equal(edlRes.status, 200);
    const edlBody = (await edlRes.json()) as {
      result_payload: { non_destructive_guarantee: boolean; auto_applied: boolean; edl_snapshot: { edlId: string } };
    };
    assert.equal(edlBody.result_payload.non_destructive_guarantee, true);
    assert.equal(edlBody.result_payload.auto_applied, false);
    assert.ok(edlBody.result_payload.edl_snapshot.edlId.length > 0);

    // 6. Strict Section 7.3 Rule: CLOUD_ONLY fails with 503 — ZERO silent fallback to LOCAL
    const cloudFailRes = await fetch(`${srv.baseUrl}/capabilities/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildEnvelope(
          'audio.quality_analysis',
          { audio },
          { execution_policy: 'CLOUD_ONLY' },
        ),
      ),
    });
    assert.equal(cloudFailRes.status, 503);
    const cloudErr = (await cloudFailRes.json()) as { error: { code: string } };
    assert.equal(cloudErr.error.code, 'CLOUD_PROVIDER_UNAVAILABLE');
  } finally {
    await srv.close();
  }
});

test('AVP-ARCH-001 Backend v2: Async Job Lifecycle, Idempotency Deduplication & Cancellation', async () => {
  const srv = await startTestServer();
  try {
    const { audio } = makeSyntheticPcm16AudioInput();
    const fixedKey = 'idem_fixed_job_001';
    const env = buildEnvelope('audio.quality_analysis', { audio }, { idempotency_key: fixedKey });

    const r1 = await fetch(`${srv.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: env }),
    });
    assert.equal(r1.status, 202);
    const j1 = (await r1.json()) as { deduplicated: boolean; job: { job_id: string } };
    assert.equal(j1.deduplicated, false);

    // Duplicate submission with identical idempotency_key returns existing job cleanly
    const r2 = await fetch(`${srv.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: env }),
    });
    assert.equal(r2.status, 200);
    const j2 = (await r2.json()) as { deduplicated: boolean; job: { job_id: string } };
    assert.equal(j2.deduplicated, true);
    assert.equal(j2.job.job_id, j1.job.job_id);

    // Poll until completed
    let finalState = 'QUEUED';
    for (let i = 0; i < 20; i++) {
      const poll = await fetch(`${srv.baseUrl}/jobs/${j1.job.job_id}`);
      const pj = (await poll.json()) as { job: { state: string } };
      finalState = pj.job.state;
      if (finalState === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(finalState, 'COMPLETED');

    // Deferred job cancellation
    const cancelEnv = buildEnvelope('audio.quality_analysis', { audio }, { idempotency_key: 'idem_cancel_me' });
    const subCancel = await fetch(`${srv.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: cancelEnv, defer_execution_ms: 800 }),
    });
    const jc = (await subCancel.json()) as { job: { job_id: string } };
    const cancelRes = await fetch(`${srv.baseUrl}/jobs/${jc.job.job_id}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    const cancelledBody = (await cancelRes.json()) as { job: { state: string } };
    assert.equal(cancelledBody.job.state, 'CANCELLED');
  } finally {
    await srv.close();
  }
});

test('AVP-ARCH-001 Backend v2: Canonical Project Non-Destructive EditPlan, Stale Revision 409, Rollback & Audition SESX', async () => {
  const srv = await startTestServer();
  try {
    // 1. Create neutral project with exact integer sample positions
    const createRes = await fetch(`${srv.baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Episode 42 — Audition Production',
        sample_rate_hz: 48000,
        media: [
          {
            media_id: 'med_host_1',
            display_name: 'Host_Sara_48k.wav',
            sha256_hex: 'b'.repeat(64),
            sample_rate_hz: 48000,
            channel_count: 1,
            total_samples: 480_000,
            bit_depth: 24,
            encoding: 'wav',
            storage_ref: '/Users/studio/Audio/Host_Sara_48k.wav',
            availability: 'AVAILABLE',
            registered_at: new Date().toISOString(),
          },
        ],
        tracks: [
          {
            track_id: 'trk_host',
            name: 'Host Track',
            speaker_label: 'Sara',
            channel_count: 1,
            muted: false,
            solo: false,
            gain_db: 0,
            clips: [
              {
                clip_id: 'clip_1',
                media_id: 'med_host_1',
                timeline_start_sample: 0,
                timeline_end_sample: 480_000,
                source_in_sample: 0,
                gain_db: 0,
                muted: false,
              },
            ],
          },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const { project } = (await createRes.json()) as { project: { project_id: string; revision: number } };
    assert.equal(project.revision, 1);

    // 2. Propose EditPlan anchored at revision 1
    const planRes = await fetch(`${srv.baseUrl}/projects/${project.project_id}/edit-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            track_id: 'trk_host',
            action: 'CUT_RANGE',
            start_sample: 48_000,
            end_sample: 96_000,
            reason: 'Remove filler interval [1.0s..2.0s]',
          },
        ],
      }),
    });
    assert.equal(planRes.status, 201);
    const { edit_plan: plan1 } = (await planRes.json()) as { edit_plan: { plan_id: string } };

    // 3. Unapproved commit MUST be rejected (Section 11)
    const unapprovedCommit = await fetch(
      `${srv.baseUrl}/projects/${project.project_id}/edit-plans/${plan1.plan_id}/commit`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(unapprovedCommit.status, 409);

    // 4. Approve plan1, then mutate project concurrently via media registration (revision 1 -> 2)
    await fetch(`${srv.baseUrl}/projects/${project.project_id}/edit-plans/${plan1.plan_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const medRes = await fetch(`${srv.baseUrl}/projects/${project.project_id}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Guest_Arash_48k.wav',
        sha256_hex: 'c'.repeat(64),
        sample_rate_hz: 48000,
        channel_count: 1,
        total_samples: 480_000,
        bit_depth: 24,
        encoding: 'wav',
        storage_ref: '/Users/studio/Audio/Guest_Arash_48k.wav',
        availability: 'AVAILABLE',
      }),
    });
    assert.equal(medRes.status, 201);

    // 5. Committing stale plan1 MUST fail with 409 STALE_PROJECT_REVISION (Section 11.3)
    const staleCommit = await fetch(
      `${srv.baseUrl}/projects/${project.project_id}/edit-plans/${plan1.plan_id}/commit`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(staleCommit.status, 409);
    const staleErr = (await staleCommit.json()) as { error: string };
    assert.equal(staleErr.error, 'STALE_PROJECT_REVISION');

    // 6. Fresh plan at revision 2 -> approve -> commit -> splits clip non-destructively into 2 clips
    const plan2Res = await fetch(`${srv.baseUrl}/projects/${project.project_id}/edit-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            track_id: 'trk_host',
            action: 'CUT_RANGE',
            start_sample: 48_000,
            end_sample: 96_000,
            reason: 'Approved non-destructive filler cut',
          },
        ],
      }),
    });
    const { edit_plan: plan2 } = (await plan2Res.json()) as { edit_plan: { plan_id: string } };
    await fetch(`${srv.baseUrl}/projects/${project.project_id}/edit-plans/${plan2.plan_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const commit2Res = await fetch(
      `${srv.baseUrl}/projects/${project.project_id}/edit-plans/${plan2.plan_id}/commit`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: 2 }) },
    );
    assert.equal(commit2Res.status, 200);
    const committed = (await commit2Res.json()) as {
      project: { revision: number; tracks: Array<{ clips: Array<{ clip_id: string }> }> };
    };
    assert.equal(committed.project.revision, 3);
    assert.equal(committed.project.tracks[0].clips.length, 2);

    // 7. Export validated Adobe Audition SESX v1.9 interchange XML
    const sesxRes = await fetch(`${srv.baseUrl}/hosts/audition/sesx/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.project_id }),
    });
    assert.equal(sesxRes.status, 200);
    const sesxBody = (await sesxRes.json()) as {
      sesx_xml: string;
      validation: {
        valid_xml_structure: boolean;
        valid_sesx_semantics: boolean;
        verified_in_desktop_audition: boolean;
        clip_count: number;
      };
    };
    assert.equal(sesxBody.validation.valid_xml_structure, true);
    assert.equal(sesxBody.validation.valid_sesx_semantics, true);
    assert.equal(sesxBody.validation.verified_in_desktop_audition, false);
    assert.equal(sesxBody.validation.clip_count, 2);

    // Malformed SESX with dangling fileID is caught explicitly
    const badSesxRes = await fetch(`${srv.baseUrl}/hosts/audition/sesx/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sesx_xml: '<sesx version="1.9"><session sampleRate="48000"><audioClip fileID="999" startPoint="10" endPoint="5" /></session><files></files></sesx>',
      }),
    });
    const badSesx = (await badSesxRes.json()) as { validation: { valid_sesx_semantics: boolean; issues: unknown[] } };
    assert.equal(badSesx.validation.valid_sesx_semantics, false);
    assert.ok(badSesx.validation.issues.length >= 2);

    // 8. Rollback back to revision 1 restores original untouched single clip
    const rbRes = await fetch(`${srv.baseUrl}/projects/${project.project_id}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_revision: 1 }),
    });
    assert.equal(rbRes.status, 200);
    const rbBody = (await rbRes.json()) as { project: { revision: number; tracks: Array<{ clips: unknown[] }> } };
    assert.equal(rbBody.project.revision, 4);
    assert.equal(rbBody.project.tracks[0].clips.length, 1);
  } finally {
    await srv.close();
  }
});

test('AVP-ARCH-001 Backend v2: Companion IPC Loopback Security, Version Handshake, HMAC Auth & Nonce Replay Defense', async () => {
  // Direct non-loopback rejection check (Section 15.2)
  const bridge = new CompanionIpcBridge();
  const nonLoopback = bridge.handshake(
    {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'adobe-audition',
      host_version: '24.2',
      panel_version: '1.0.0',
      host_adapter_version: '1.0.0',
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
    },
    '198.51.100.42',
  );
  assert.equal(nonLoopback.statusCode, 403);
  assert.equal(nonLoopback.body.compatible, false);

  const srv = await startTestServer();
  try {
    // Version mismatch handshake rejected with 409
    const badHandshake = await fetch(`${srv.baseUrl}/companion/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ipc_protocol_version: '9.9.9',
        host_id: 'adobe-audition',
        host_version: '24.2',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: CANONICAL_CONTRACT_VERSION,
      }),
    });
    assert.equal(badHandshake.status, 409);

    // Valid loopback handshake issues session_token
    const okHandshake = await fetch(`${srv.baseUrl}/companion/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
        host_id: 'adobe-audition',
        host_version: '24.2',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: CANONICAL_CONTRACT_VERSION,
      }),
    });
    assert.equal(okHandshake.status, 200);
    const hs = (await okHandshake.json()) as {
      compatible: boolean;
      session_id: string;
      session_token: string;
    };
    assert.equal(hs.compatible, true);
    assert.ok(hs.session_token.length > 20);

    // Authorized Companion IPC call succeeds
    const ipcPayload = {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      session_id: hs.session_id,
      nonce: 'nonce_unique_001',
      timestamp_ms: Date.now(),
      command: 'HOST_CAPABILITY_MATRIX',
      payload: {},
    };
    const ipcOk = await fetch(`${srv.baseUrl}/companion/ipc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${hs.session_token}`,
      },
      body: JSON.stringify(ipcPayload),
    });
    assert.equal(ipcOk.status, 200);
    const matrixBody = (await ipcOk.json()) as { host_id: string; capabilities: unknown[] };
    assert.equal(matrixBody.host_id, 'adobe-audition');
    assert.ok(matrixBody.capabilities.length >= 4);

    // Replaying exact same nonce MUST be rejected with 409 IPC_NONCE_REPLAY
    const ipcReplay = await fetch(`${srv.baseUrl}/companion/ipc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${hs.session_token}`,
      },
      body: JSON.stringify(ipcPayload),
    });
    assert.equal(ipcReplay.status, 409);
    const replayErr = (await ipcReplay.json()) as { error: string };
    assert.equal(replayErr.error, 'IPC_NONCE_REPLAY');

    // Missing/bad token MUST be rejected with 401
    const ipcNoAuth = await fetch(`${srv.baseUrl}/companion/ipc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ipcPayload, nonce: 'nonce_unique_002' }),
    });
    assert.equal(ipcNoAuth.status, 401);
  } finally {
    await srv.close();
  }
});
