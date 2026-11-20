import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PlatformControlPlaneService } from '../PlatformControlPlaneEngine';
import {
  BOOTSTRAP_OWNER_SCOPES,
  PlatformControlPlaneGateway,
} from '../PlatformControlPlaneGateway';

describe('AVP-011 PlatformControlPlaneAuthorization Regression Matrix', () => {
  it('verifies zero hardcoded tenant/principal fallbacks remain in server.ts and DeveloperPlatformPortalModal uses in-memory Bearer token only', async () => {
    const serverSrc = await fs.readFile(path.resolve(process.cwd(), 'server.ts'), 'utf8');
    // No inline unauthenticated /api/v1/platform/* route registrations with org_avapardaz_sandbox
    expect(serverSrc).not.toMatch(/app\.(get|post)\('\/api\/v1\/platform\//);
    expect(serverSrc).not.toMatch(/org_avapardaz_sandbox/);
    expect(serverSrc).not.toMatch(/prj_avapardaz_dev_01/);
    expect(serverSrc).not.toMatch(/studio_sandbox_ui/);

    const modalSrc = await fs.readFile(
      path.resolve(process.cwd(), 'src/components/DeveloperPlatformPortalModal.tsx'),
      'utf8'
    );
    expect(modalSrc).toContain('adminBearerToken');
    expect(modalSrc).toContain('platformFetch');
    expect(modalSrc).toContain('type="password"');
    expect(modalSrc).not.toContain('localStorage');
    expect(modalSrc).not.toContain('sessionStorage');
    expect(modalSrc).not.toContain('raw_text_hint');
    expect(modalSrc).not.toContain('audio_duration_ms');
  });

  it('prevents privilege escalation when a DEVELOPER attempts to issue an api-keys:manage key', () => {
    const cp = new PlatformControlPlaneService();
    cp.createUser({ id: 'usr_dev_esc', email: 'dev@local.test', displayName: 'Dev' });
    cp.setOrganizationMembership({
      organizationId: 'org_avapardaz_sandbox',
      userId: 'usr_dev_esc',
      role: 'DEVELOPER',
      membershipStatus: 'ACTIVE',
    });
    expect(() =>
      cp.issueApiKey({
        organizationId: 'org_avapardaz_sandbox',
        projectId: 'prj_avapardaz_dev_01',
        principalId: 'usr_dev_esc',
        name: 'Escalation Attempt',
        scopes: ['api-keys:manage'],
      })
    ).toThrow();
  });

  it('prevents webhook test-dispatch in production (403) and enforces 25-endpoint cap per organization', async () => {
    const cp = new PlatformControlPlaneService();
    const gwProd = new PlatformControlPlaneGateway(cp, {
      isProduction: true,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const owner = cp.issueApiKey({
      organizationId: 'org_avapardaz_sandbox',
      projectId: 'prj_avapardaz_dev_01',
      principalId: 'usr_studio_owner_01',
      name: 'Owner Key',
      scopes: [...BOOTSTRAP_OWNER_SCOPES],
    });
    const bearer = `Bearer ${owner.plaintextSecretOnce}`;

    expect(gwProd.testWebhookDispatch({ bearerToken: bearer, body: { simulateFailure: true } }).status).toBe(403);

    // Sandbox already has 1 seeded endpoint; add 24 more to reach 25, then 26th must fail (409/400)
    for (let i = 0; i < 24; i += 1) {
      const r = await gwProd.registerWebhook({
        bearerToken: bearer,
        body: {
          url: `https://hooks.example.com/ep-${i}`,
          eventSubscriptions: ['transcription.completed'],
        },
      });
      expect(r.status).toBe(201);
    }
    const overflow = await gwProd.registerWebhook({
      bearerToken: bearer,
      body: {
        url: 'https://hooks.example.com/ep-overflow',
        eventSubscriptions: ['transcription.completed'],
      },
    });
    expect(overflow.status).toBe(409);
  });
});
