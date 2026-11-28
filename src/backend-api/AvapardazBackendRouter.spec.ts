import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionIpcBridge, COMPANION_IPC_PROTOCOL_VERSION } from '../host-bridge/companion/CompanionIpcBridge';
import { ProcessingJobManager } from '../processing-engine/capabilities/ProcessingJobManager';
import { CANONICAL_CONTRACT_VERSION, type CanonicalOperationEnvelope, type CanonicalOperationResult } from '../processing-engine/capabilities/CanonicalCapabilityContracts';
import type { ProcessingCapabilityRegistry } from '../processing-engine/capabilities/CapabilityRegistry';
import { createAvapardazBackendRouter } from './AvapardazBackendRouter';

const HOST_ADAPTER_VERSION = '1.0.0';

function makeOperationEnvelope(idempotencyKey: string, requestId: string): CanonicalOperationEnvelope {
  return {
    request_id: requestId,
    capability_id: 'speech.transcription',
    operation_version: '1.0.0',
    contract_version: CANONICAL_CONTRACT_VERSION,
    project_id: 'router-test-project',
    project_revision: 0,
    media_references: [],
    input_payload: {},
    configuration: {},
    execution_policy: 'LOCAL_ONLY',
    requested_model_policy: 'AUTO_BEST_LOCAL',
    idempotency_key: idempotencyKey,
    created_at: new Date(0).toISOString(),
    correlation_id: requestId,
  };
}

describe('AvapardazBackendRouter Companion IPC isolation', () => {
  let server: Server | undefined;
  let baseUrl = '';

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
    baseUrl = '';
  });

  async function startRouter(): Promise<void> {
    const registry = {
      executeEnvelope: vi.fn(async () => ({
        status: 'COMPLETED',
        actual_execution_environment: 'LOCAL',
        errors: [],
      } as unknown as CanonicalOperationResult)),
      listCapabilities: vi.fn(async () => []),
    } as unknown as ProcessingCapabilityRegistry;
    const jobManager = new ProcessingJobManager({ registry });
    const bridge = new CompanionIpcBridge();
    const app = express();
    app.use(express.json());
    const created = createAvapardazBackendRouter({
      services: { capabilityRegistry: registry, jobManager, companionIpcBridge: bridge },
      resolveRemoteAddress: () => '127.0.0.1',
    });
    app.use(created.router);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function post(path: string, body: unknown, options?: { token?: string; origin?: string; secFetchSite?: string }): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options?.origin ? { origin: options.origin } : {}),
        ...(options?.secFetchSite ? { 'sec-fetch-site': options.secFetchSite } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function handshake(clientId: string): Promise<{ session_id: string; session_token: string }> {
    const response = await post('/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'cli-test',
      host_version: '1.0.0',
      panel_version: '1.0.0',
      host_adapter_version: HOST_ADAPTER_VERSION,
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      client_instance_id: clientId,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { session_id: string; session_token: string };
    return body;
  }

  async function ipc(
    session: { session_id: string; session_token: string },
    command: string,
    payload: unknown,
  ): Promise<Response> {
    return post('/companion/ipc', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      session_id: session.session_id,
      nonce: randomUUID(),
      timestamp_ms: Date.now(),
      execution_mode: 'web-client',
      command,
      payload,
    }, { token: session.session_token });
  }

  it('binds IPC job submit, idempotency, listing, status, and cancellation to the authenticated owner', async () => {
    await startRouter();
    const ownerA = await handshake('a'.repeat(64));
    const ownerB = await handshake('b'.repeat(64));

    const submitA = await ipc(ownerA, 'JOB_SUBMIT', makeOperationEnvelope('same-idempotency-key', 'request-a'));
    expect(submitA.status).toBe(202);
    const submitABody = await submitA.json() as { job: { job_id: string } };
    const jobAId = submitABody.job.job_id;

    const duplicateA = await ipc(ownerA, 'JOB_SUBMIT', makeOperationEnvelope('same-idempotency-key', 'request-a-duplicate'));
    expect(duplicateA.status).toBe(200);
    expect((await duplicateA.json() as { job: { job_id: string } }).job.job_id).toBe(jobAId);

    const submitB = await ipc(ownerB, 'JOB_SUBMIT', makeOperationEnvelope('same-idempotency-key', 'request-b'));
    expect(submitB.status).toBe(202);
    const jobBId = (await submitB.json() as { job: { job_id: string } }).job.job_id;
    expect(jobBId).not.toBe(jobAId);

    expect((await ipc(ownerA, 'JOB_STATUS', { job_id: jobAId })).status).toBe(200);
    const reconnectA = await ipc(ownerA, 'JOB_RECONNECT', { job_id: jobAId });
    expect(reconnectA.status).toBe(200);
    expect((await reconnectA.json() as { reconnected: boolean }).reconnected).toBe(true);
    expect((await ipc(ownerB, 'JOB_RECONNECT', { job_id: jobAId })).status).toBe(404);
    expect((await ipc(ownerB, 'JOB_STATUS', { job_id: jobAId })).status).toBe(404);
    expect((await ipc(ownerB, 'JOB_CANCEL', { job_id: jobAId })).status).toBe(404);
    expect((await ipc(ownerA, 'JOB_CANCEL', { job_id: jobAId })).status).toBe(200);

    const listA = await ipc(ownerA, 'JOB_LIST', {});
    const listB = await ipc(ownerB, 'JOB_LIST', {});
    expect((await listA.json() as { jobs: Array<{ job_id: string }> }).jobs.map((job) => job.job_id)).toEqual([jobAId]);
    expect((await listB.json() as { jobs: Array<{ job_id: string }> }).jobs.map((job) => job.job_id)).toEqual([jobBId]);
  });

  it('rejects sandboxed null-Origin cross-site Companion handshakes', async () => {
    await startRouter();
    const response = await post('/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'cli-test',
      host_version: '1.0.0',
      panel_version: '1.0.0',
      host_adapter_version: HOST_ADAPTER_VERSION,
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      client_instance_id: 'd'.repeat(64),
    }, { origin: 'null', secFetchSite: 'cross-site' });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('COMPANION_ORIGIN_BLOCKED');
  });

  it('rejects Companion handshakes from an untrusted Origin', async () => {
    await startRouter();
    const response = await post('/companion/handshake', {
      ipc_protocol_version: COMPANION_IPC_PROTOCOL_VERSION,
      host_id: 'cli-test',
      host_version: '1.0.0',
      panel_version: '1.0.0',
      host_adapter_version: HOST_ADAPTER_VERSION,
      expected_contract_version: CANONICAL_CONTRACT_VERSION,
      client_instance_id: 'c'.repeat(64),
    }, { origin: 'https://untrusted.example' });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('COMPANION_ORIGIN_BLOCKED');
  });
});
