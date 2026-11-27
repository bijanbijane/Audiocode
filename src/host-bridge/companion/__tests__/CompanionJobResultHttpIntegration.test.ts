import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { LocalCompanionService } from '../LocalCompanionService';
import { COMPANION_IPC_PROTOCOL_VERSION } from '../CompanionIpcBridge';
import { CANONICAL_CONTRACT_VERSION } from '../../../processing-engine/capabilities/CanonicalCapabilityContracts';
import { AVAPARDAZ_ASR_CONTRACT_VERSION } from '../../../asr-core/AsrContractVersion';
import type {
  LocalNeuralTranscriptionResult,
  LocalSherpaNeuralEngine,
} from '../../../asr-core/LocalSherpaNeuralEngine';

const FIXTURE_RESULT: LocalNeuralTranscriptionResult = {
  modelId: 'fixture-model',
  architecture: 'nemo-ctc',
  quantization: 'INT8',
  offlineVerified: true,
  durationSec: 1.25,
  processingTimeMs: 12,
  realTimeFactor: 0.01,
  dominantLanguage: 'fa',
  rawText: 'متن خام',
  normalizedByProfile: {
    'FA-RELAXED-V1': 'متن نرمال‌شده',
    'FA-STRICT-V1': 'متن نرمال‌شده',
    'EN-NORM-V1': 'raw text',
    'MIXED-NORM-V1': 'متن نرمال‌شده',
    'RAW_UNMODIFIED': 'متن خام',
  },
  timestampGranularity: 'SEGMENT',
  segments: [{
    id: 'segment-1',
    index: 0,
    startSec: 0,
    endSec: 1.25,
    text: 'متن خام',
    normalizedByProfile: {
      'FA-RELAXED-V1': 'متن نرمال‌شده',
      'FA-STRICT-V1': 'متن نرمال‌شده',
      'EN-NORM-V1': 'raw text',
      'MIXED-NORM-V1': 'متن نرمال‌شده',
      'RAW_UNMODIFIED': 'متن خام',
    },
    language: 'fa',
    timestampGranularity: 'SEGMENT',
    words: [],
  }],
  sampleRateHz: 16000,
  channelCount: 1,
  audioSha256: 'a'.repeat(64),
};

class FixtureNeuralEngine {
  public getStatus() {
    return {
      runtimeName: 'sherpa-onnx-cpu' as const,
      binaryPath: '/fixture/sherpa-onnx-offline',
      libDir: null,
      available: true,
      offlineOnlyEnforced: true as const,
      cpuThreads: 1,
      activeModelId: 'fixture-model',
      installedModels: [],
      processRssMb: 1,
    };
  }

  public selectModel() {
    return { modelId: 'fixture-model' };
  }

  public async transcribe(): Promise<LocalNeuralTranscriptionResult> {
    return FIXTURE_RESULT;
  }

  public unloadActiveModel(): void {}
}

async function httpJson(
  port: number,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: responseText ? JSON.parse(responseText) : {} });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Companion HTTP IPC returns CEP DTO only to Audition and preserves canonical Web result for completed jobs', async () => {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-job-result-http-'));
  const service = new LocalCompanionService({
    neuralEngine: new FixtureNeuralEngine() as unknown as LocalSherpaNeuralEngine,
    transferStagingDir: stagingDir,
  });
  const app = express();
  app.use('/api/v2/companion', service.createExpressRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const handshake = async (hostId: 'adobe-audition' | 'cli-test') => {
    const audition = hostId === 'adobe-audition';
    const response = await httpJson(port, 'POST', '/api/v2/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: hostId,
      host_version: '24.0',
      panel_version: '1.0.0',
      host_adapter_version: '1.0.0',
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      ...(audition ? {
        expected_asr_contract_version: AVAPARDAZ_ASR_CONTRACT_VERSION,
        expected_cep_transcript_schema_version: '1.0.0',
      } : {}),
    });
    assert.equal(response.status, 200);
    return response.json;
  };

  let nonceCounter = 0;
  const ipc = async (
    session: any,
    executionMode: 'audition-cep' | 'web-client',
    command: 'JOB_SUBMIT' | 'JOB_STATUS' | 'JOB_LIST' | 'JOB_RECONNECT' | 'JOB_CANCEL',
    payload: Record<string, unknown>,
  ) => httpJson(port, 'POST', '/api/v2/companion/ipc', {
    ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
    session_id: session.session_id,
    nonce: `nonce-${executionMode}-${command}-${++nonceCounter}`,
    timestamp_ms: Date.now(),
    execution_mode: executionMode,
    command,
    payload,
  }, { Authorization: `Bearer ${session.session_token}` });

  try {
    const auditionSession = await handshake('adobe-audition');
    const webSession = await handshake('cli-test');

    const submitAndWait = async (
      session: any,
      executionMode: 'audition-cep' | 'web-client',
      filename: string,
    ): Promise<string> => {
      const submitted = await ipc(session, executionMode, 'JOB_SUBMIT', {
        audioBase64: Buffer.from('fixture-audio').toString('base64'),
        filename,
        languageHint: 'fa',
      });
      assert.equal(submitted.status, 202);
      assert.ok(submitted.json.job?.jobId);
      const jobId = submitted.json.job.jobId as string;

      let completed = service.getJob(jobId);
      for (let attempt = 0; attempt < 20 && completed?.status !== 'COMPLETED'; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        completed = service.getJob(jobId);
      }
      assert.equal(completed?.status, 'COMPLETED');
      assert.ok(completed?.result);
      return jobId;
    };

    // Each authenticated session owns a distinct job. Results must never cross session boundaries.
    const auditionJobId = await submitAndWait(auditionSession, 'audition-cep', 'audition-fixture.wav');
    const webJobId = await submitAndWait(webSession, 'web-client', 'web-fixture.wav');

    const auditionStatus = await ipc(auditionSession, 'audition-cep', 'JOB_STATUS', { jobId: auditionJobId });
    const webStatus = await ipc(webSession, 'web-client', 'JOB_STATUS', { jobId: webJobId });
    assert.equal(auditionStatus.status, 200);
    assert.equal(webStatus.status, 200);
    assert.equal(auditionStatus.json.job.result.schemaVersion, '1.0.0');
    assert.equal(auditionStatus.json.job.result.rawText, 'متن خام');
    assert.equal(auditionStatus.json.job.result.normalizedText, 'متن نرمال‌شده');
    assert.equal(auditionStatus.json.job.result.segments[0].text, 'متن خام');
    assert.equal(webStatus.json.job.result.rawText, 'متن خام');
    assert.equal('schemaVersion' in webStatus.json.job.result, false);
    assert.equal('normalizedText' in webStatus.json.job.result, false);

    // A valid but different session cannot read, reconnect to, or cancel another session's job.
    const crossSessionStatus = await ipc(webSession, 'web-client', 'JOB_STATUS', { jobId: auditionJobId });
    const crossSessionReconnect = await ipc(webSession, 'web-client', 'JOB_RECONNECT', { jobId: auditionJobId });
    const crossSessionCancel = await ipc(webSession, 'web-client', 'JOB_CANCEL', { jobId: auditionJobId });
    assert.equal(crossSessionStatus.status, 404);
    assert.equal(crossSessionReconnect.status, 404);
    assert.equal(crossSessionCancel.status, 404);

    const auditionReconnect = await ipc(auditionSession, 'audition-cep', 'JOB_RECONNECT', { jobId: auditionJobId });
    const webReconnect = await ipc(webSession, 'web-client', 'JOB_RECONNECT', { jobId: webJobId });
    assert.equal(auditionReconnect.status, 200);
    assert.equal(webReconnect.status, 200);
    assert.equal(auditionReconnect.json.reconnected, true);
    assert.equal(webReconnect.json.reconnected, true);
    assert.equal(auditionReconnect.json.job.result.schemaVersion, '1.0.0');
    assert.equal(webReconnect.json.job.result.rawText, 'متن خام');
    assert.equal('schemaVersion' in webReconnect.json.job.result, false);

    const auditionList = await ipc(auditionSession, 'audition-cep', 'JOB_LIST', {});
    const webList = await ipc(webSession, 'web-client', 'JOB_LIST', {});
    assert.equal(auditionList.status, 200);
    assert.equal(webList.status, 200);
    assert.deepEqual(auditionList.json.jobs.map((job: { jobId: string }) => job.jobId), [auditionJobId]);
    assert.deepEqual(webList.json.jobs.map((job: { jobId: string }) => job.jobId), [webJobId]);
    assert.equal(auditionList.json.jobs[0].result.schemaVersion, '1.0.0');
    assert.equal(webList.json.jobs[0].result.rawText, 'متن خام');
    assert.equal('schemaVersion' in webList.json.jobs[0].result, false);
  } finally {
    service.beginGracefulShutdown('Test teardown');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});
