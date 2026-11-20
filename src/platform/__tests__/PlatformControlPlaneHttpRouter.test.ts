import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { PlatformControlPlaneService } from '../PlatformControlPlaneEngine';
import {
  BOOTSTRAP_OWNER_SCOPES,
  PlatformControlPlaneGateway,
} from '../PlatformControlPlaneGateway';
import { createPlatformControlPlaneHttpRouter } from '../PlatformControlPlaneHttpRouter';
import type { WebhookDnsLookupFn } from '../PlatformWebhookSecurity';

const PUBLIC_DNS: WebhookDnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

async function startTestApp(router: express.Router) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('AVP-011 PlatformControlPlaneHttpRouter Live HTTP Integration', () => {
  it('blocks all 10 control plane routes without Bearer token (401) and supports full authenticated bootstrap -> manage lifecycle', async () => {
    const cp = new PlatformControlPlaneService();
    const bootstrapSecret = 'Bst_HTTP_9!xQ2mK7pR4vL8zN1cF5hJ3wT6yA0';
    const gw = new PlatformControlPlaneGateway(cp, {
      isProduction: false,
      bootstrapEnabled: true,
      bootstrapToken: bootstrapSecret,
      dnsLookup: PUBLIC_DNS,
    });
    const srv = await startTestApp(createPlatformControlPlaneHttpRouter(gw));

    try {
      // 1. All 10 endpoints return 401 when unauthenticated
      const endpoints: Array<[string, string]> = [
        ['GET', '/api/v1/platform/overview'],
        ['POST', '/api/v1/platform/projects'],
        ['POST', '/api/v1/platform/api-keys'],
        ['POST', '/api/v1/platform/api-keys/cred_1/rotate'],
        ['POST', '/api/v1/platform/api-keys/cred_1/revoke'],
        ['POST', '/api/v1/platform/invoices/issue'],
        ['POST', '/api/v1/platform/webhooks'],
        ['POST', '/api/v1/platform/webhooks/test-dispatch'],
        ['POST', '/api/v1/platform/webhooks/del_1/replay'],
        ['POST', '/api/v1/platform/region-check'],
      ];
      for (const [method, path] of endpoints) {
        const res = await fetch(`${srv.baseUrl}${path}`, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
          body: method === 'POST' ? '{}' : undefined,
        });
        expect(res.status, `Expected 401 for unauthenticated ${method} ${path}`).toBe(401);
      }

      // 2. Bootstrap owner key via X-Platform-Bootstrap-Token
      const bootRes = await fetch(`${srv.baseUrl}/api/v1/platform/bootstrap/owner-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Bootstrap-Token': bootstrapSecret,
        },
        body: JSON.stringify({ name: 'HTTP Owner Key' }),
      });
      expect(bootRes.status).toBe(201);
      const bootJson = (await bootRes.json()) as {
        plaintextSecretOnce: string;
        credential: { scopes: string[] };
      };
      expect(bootJson.credential.scopes).toEqual([...BOOTSTRAP_OWNER_SCOPES]);

      const authHeaders = {
        Authorization: `Bearer ${bootJson.plaintextSecretOnce}`,
        'Content-Type': 'application/json',
      };

      // 3. Authenticated overview succeeds (200) and rejects conflicting X-Organization-Id (403)
      const ovOk = await fetch(`${srv.baseUrl}/api/v1/platform/overview`, { headers: authHeaders });
      expect(ovOk.status).toBe(200);
      const ovSpoof = await fetch(`${srv.baseUrl}/api/v1/platform/overview`, {
        headers: { ...authHeaders, 'X-Organization-Id': 'org_other_tenant' },
      });
      expect(ovSpoof.status).toBe(403);

      // 4. Create project, issue key, rotate, revoke, issue invoice, register webhook, region-check
      const prjRes = await fetch(`${srv.baseUrl}/api/v1/platform/projects`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ projectName: 'HTTP Dev Project', environment: 'DEVELOPMENT' }),
      });
      expect(prjRes.status).toBe(201);
      const prjJson = (await prjRes.json()) as { id: string };

      const keyRes = await fetch(`${srv.baseUrl}/api/v1/platform/api-keys`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          projectId: prjJson.id,
          name: 'Runtime Key',
          scopes: ['audio:transcribe', 'models:read'],
        }),
      });
      expect(keyRes.status).toBe(201);
      const keyJson = (await keyRes.json()) as { credential: { id: string } };

      const rotRes = await fetch(`${srv.baseUrl}/api/v1/platform/api-keys/${keyJson.credential.id}/rotate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ overlapHours: 6 }),
      });
      expect(rotRes.status).toBe(200);

      const revRes = await fetch(`${srv.baseUrl}/api/v1/platform/api-keys/${keyJson.credential.id}/revoke`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(revRes.status).toBe(200);

      const invRes = await fetch(`${srv.baseUrl}/api/v1/platform/invoices/issue`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(invRes.status).toBe(201);

      const whRes = await fetch(`${srv.baseUrl}/api/v1/platform/webhooks`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          url: 'https://hooks.example.com/events',
          eventSubscriptions: ['transcription.completed'],
        }),
      });
      expect(whRes.status).toBe(201);

      const regOk = await fetch(`${srv.baseUrl}/api/v1/platform/region-check`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ regionId: 'ir-thr-01', projectId: prjJson.id }),
      });
      expect(regOk.status).toBe(200);

      const regDenied = await fetch(`${srv.baseUrl}/api/v1/platform/region-check`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ regionId: 'eu-central-01', projectId: prjJson.id }),
      });
      expect(regDenied.status).toBe(422);
    } finally {
      await srv.close();
    }
  });
});
