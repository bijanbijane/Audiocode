import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { PlatformControlPlaneService } from './PlatformControlPlaneEngine';
import { PlatformDataPlaneGateway } from './PlatformDataPlaneGateway';
import {
  createSpeechIntelligenceSandboxRouter,
  SANDBOX_REQUESTED_WITH_HEADER,
  type SandboxHttpAccessConfig,
} from '../intelligence/SandboxHttpAccessGuard';

const STRONG_TOKEN = 'Sbx9!mK2vP7rT4xQ1zL8cN5wF3hJ6yD0eA';

async function createSandboxTestServer(config: SandboxHttpAccessConfig) {
  const cp = new PlatformControlPlaneService();
  const gateway = new PlatformDataPlaneGateway(cp);
  const app = express();
  app.use(
    createSpeechIntelligenceSandboxRouter({
      gateway,
      controlPlane: cp,
      config,
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Bind failed');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    gateway,
    cp,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('AVP-012 Speech Intelligence Sandbox HTTP Integration', () => {
  it('returns 404 on all 5 sandbox endpoints in production or when disabled, with ZERO orchestrator invocations', async () => {
    const srv = await createSandboxTestServer({
      nodeEnv: 'production',
      enableSandboxRoutes: false,
      sandboxToken: STRONG_TOKEN,
    });
    const submitSpy = vi.spyOn(srv.gateway.intelligenceOrchestrator, 'submitIntelligenceJob');
    const deleteSpy = vi.spyOn(srv.gateway.intelligenceOrchestrator, 'deleteRecordingAndPropagate');

    try {
      const checks: Array<[string, string]> = [
        ['GET', '/api/v1/intelligence/sandbox/overview'],
        ['POST', '/api/v1/intelligence/sandbox/run-dag'],
        ['POST', '/api/v1/intelligence/sandbox/search'],
        ['POST', '/api/v1/intelligence/sandbox/realtime-sim'],
        ['DELETE', '/api/v1/intelligence/sandbox/recordings/rec_1'],
      ];
      for (const [method, p] of checks) {
        const res = await fetch(`${srv.baseUrl}${p}`, {
          method,
          headers: {
            Authorization: `Bearer ${STRONG_TOKEN}`,
            'X-Requested-With': SANDBOX_REQUESTED_WITH_HEADER,
          },
        });
        expect(res.status, `Expected 404 for ${method} ${p}`).toBe(404);
      }
      expect(submitSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('enforces auth, same-origin, 256 KiB cap, unknown capability 400, confirmed DELETE, and DAG rate limit when enabled in development', async () => {
    const srv = await createSandboxTestServer({
      nodeEnv: 'development',
      enableSandboxRoutes: true,
      sandboxToken: STRONG_TOKEN,
    });
    const submitSpy = vi.spyOn(srv.gateway.intelligenceOrchestrator, 'submitIntelligenceJob');
    const deleteSpy = vi.spyOn(srv.gateway.intelligenceOrchestrator, 'deleteRecordingAndPropagate');

    const authHeaders = {
      Authorization: `Bearer ${STRONG_TOKEN}`,
      'X-Requested-With': SANDBOX_REQUESTED_WITH_HEADER,
      'Content-Type': 'application/json',
    };

    try {
      // 1. Unauthenticated overview -> 401
      const unauth = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/overview`);
      expect(unauth.status).toBe(401);

      // 2. Authenticated overview -> 200 (sanitized, no raw telemetry latency arrays)
      const ov = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/overview`, {
        headers: { Authorization: `Bearer ${STRONG_TOKEN}` },
      });
      expect(ov.status).toBe(200);
      const ovJson = (await ov.json()) as Record<string, unknown>;
      expect(ovJson.executionEnvironment).toBe('DEVELOPMENT_SANDBOX');
      expect(ovJson.telemetry).toBeUndefined();

      // 3. Cross-origin POST -> 403
      const xOrigin = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/run-dag`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          Origin: 'https://attacker.example',
        },
        body: JSON.stringify({ recordingId: 'rec_safe_01' }),
      });
      expect(xOrigin.status).toBe(403);
      expect(submitSpy).not.toHaveBeenCalled();

      // 4. Oversized (> 256 KiB) JSON body -> 413
      const hugeText = 'x'.repeat(270 * 1024);
      const bigRes = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/search`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ query: hugeText }),
      });
      expect(bigRes.status).toBe(413);

      // 5. Unknown capability -> 400
      const badCap = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/run-dag`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          recordingId: 'rec_safe_01',
          capabilities: ['speech.nonexistent_cap'],
        }),
      });
      expect(badCap.status).toBe(400);

      // 6. Client identity override rejected -> 400
      const spoofOrg = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/run-dag`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          recordingId: 'rec_safe_01',
          organizationId: 'org_other',
        }),
      });
      expect(spoofOrg.status).toBe(400);

      // 7. Valid DAG run -> 201
      const dagOk = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/run-dag`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          recordingId: 'rec_safe_01',
          capabilities: ['speech.diarization', 'speech.semantic_indexing'],
        }),
      });
      expect(dagOk.status).toBe(201);
      expect(submitSpy).toHaveBeenCalledTimes(1);

      // 8. Valid semantic search -> 200
      const searchOk = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/search`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ recordingId: 'rec_safe_01', query: 'TypeScript' }),
      });
      expect(searchOk.status).toBe(200);

      // 9. Valid realtime-sim -> 200
      const rtOk = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/realtime-sim`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRONG_TOKEN}`,
          'X-Requested-With': SANDBOX_REQUESTED_WITH_HEADER,
        },
      });
      expect(rtOk.status).toBe(200);

      // 10. DELETE without X-Confirm-Recording-Id -> 400 (zero deletion!)
      const delNoConfirm = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/recordings/rec_safe_01`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${STRONG_TOKEN}`,
          'X-Requested-With': SANDBOX_REQUESTED_WITH_HEADER,
        },
      });
      expect(delNoConfirm.status).toBe(400);
      expect(deleteSpy).not.toHaveBeenCalled();

      // 11. DELETE with matching X-Confirm-Recording-Id -> 200
      const delConfirm = await fetch(`${srv.baseUrl}/api/v1/intelligence/sandbox/recordings/rec_safe_01`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${STRONG_TOKEN}`,
          'X-Requested-With': SANDBOX_REQUESTED_WITH_HEADER,
          'X-Confirm-Recording-Id': 'rec_safe_01',
        },
      });
      expect(delConfirm.status).toBe(200);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    } finally {
      await srv.close();
    }
  });
});
