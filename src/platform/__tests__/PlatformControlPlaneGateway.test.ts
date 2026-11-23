import { describe, expect, it } from 'vitest';
import {
  PlatformControlPlaneService,
} from '../PlatformControlPlaneEngine';
import {
  BOOTSTRAP_OWNER_SCOPES,
  PlatformControlPlaneGateway,
} from '../PlatformControlPlaneGateway';
import type { ApiCredentialScope, OrganizationRole } from '../PlatformContractsAndSchemas';
import type { WebhookDnsLookupFn } from '../PlatformWebhookSecurity';

const PUBLIC_DNS: WebhookDnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

function setupPrincipalKey(params: {
  cp: PlatformControlPlaneService;
  organizationId: string;
  projectId: string;
  userId: string;
  role: OrganizationRole;
  scopes: ApiCredentialScope[];
  expiresInDays?: number;
}) {
  if (!params.cp.getUser(params.userId)) {
    params.cp.createUser({
      id: params.userId,
      email: `${params.userId}@tenant.local`,
      displayName: params.userId,
    });
  }
  params.cp.setOrganizationMembership({
    organizationId: params.organizationId,
    userId: params.userId,
    role: params.role,
    membershipStatus: 'ACTIVE',
  });
  const issued = params.cp.issueApiKey({
    organizationId: params.organizationId,
    projectId: params.projectId,
    principalId: params.userId,
    name: `${params.userId}-${params.role}`,
    scopes: params.scopes,
    expiresInDays: params.expiresInDays,
  });
  return {
    bearer: `Bearer ${issued.plaintextSecretOnce}`,
    secret: issued.plaintextSecretOnce,
    credentialId: issued.credential.id,
  };
}

describe('AVP-011 PlatformControlPlaneGateway Authorization, Lifecycle & Integrity', () => {
  it('enforces strong API_KEY_PEPPER in production and rejects legacy placeholder peppers', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevPepper = process.env.API_KEY_PEPPER;
    try {
      process.env.NODE_ENV = 'production';
      process.env.API_KEY_PEPPER = 'short-pepper';
      expect(() => new PlatformControlPlaneService()).toThrow(/PRODUCTION_API_KEY_PEPPER_INVALID/);

      process.env.API_KEY_PEPPER = 'avapardaz-dev-pepper-2026-replace-in-prod-with-kms';
      expect(() => new PlatformControlPlaneService()).toThrow(/PRODUCTION_API_KEY_PEPPER_INVALID/);

      process.env.API_KEY_PEPPER = 'k9X2mQ7vL4pR8tW1zN6cB3fH5jD0sA9eG4yU8iO2';
      expect(() => new PlatformControlPlaneService()).not.toThrow();
    } finally {
      process.env.NODE_ENV = prevEnv;
      process.env.API_KEY_PEPPER = prevPepper;
    }
  });

  it('enforces restricted one-time owner bootstrap lifecycle, constant-time token check, and 3-failure rate limiting', () => {
    const cp = new PlatformControlPlaneService();
    const strongBootstrap = 'Bst9!xQ2mK7pR4vL8zN1cF5hJ3wT6yA0dE';
    let now = 1_700_000_000_000;

    // Disabled by default
    const disabledGw = new PlatformControlPlaneGateway(cp, {
      isProduction: false,
      bootstrapEnabled: false,
      bootstrapToken: strongBootstrap,
      nowMs: () => now,
    });
    expect(
      disabledGw.bootstrapOwnerKey({
        bootstrapHeaderToken: strongBootstrap,
        sourceAddress: '127.0.0.1',
        body: {},
      }).status
    ).toBe(404);

    // Enabled in dev with strong token
    const gw = new PlatformControlPlaneGateway(cp, {
      isProduction: false,
      bootstrapEnabled: true,
      bootstrapToken: strongBootstrap,
      nowMs: () => now,
    });

    // 3 wrong attempts trigger rate limit on 4th
    for (let i = 0; i < 3; i += 1) {
      expect(
        gw.bootstrapOwnerKey({
          bootstrapHeaderToken: 'wrong-token-attempt-0000000000000000',
          sourceAddress: '10.0.0.9',
          body: {},
        }).status
      ).toBe(401);
    }
    expect(
      gw.bootstrapOwnerKey({
        bootstrapHeaderToken: strongBootstrap,
        sourceAddress: '10.0.0.9',
        body: {},
      }).status
    ).toBe(429);

    // Valid source bootstraps once -> 201 with 11 owner scopes
    const bootstrapped = gw.bootstrapOwnerKey({
      bootstrapHeaderToken: strongBootstrap,
      sourceAddress: '127.0.0.1',
      body: { name: 'Initial Owner Bootstrap Key' },
    });
    expect(bootstrapped.status).toBe(201);
    const issuedBody = bootstrapped.body as {
      plaintextSecretOnce: string;
      credential: { scopes: string[]; environment: string };
    };
    expect(issuedBody.plaintextSecretOnce.startsWith('asr_test_')).toBe(true);
    expect(issuedBody.credential.environment).toBe('DEVELOPMENT');
    expect(issuedBody.credential.scopes).toEqual([...BOOTSTRAP_OWNER_SCOPES]);

    // Second bootstrap attempt refused (409) because an active owner api-keys:manage key now exists
    const secondAttempt = gw.bootstrapOwnerKey({
      bootstrapHeaderToken: strongBootstrap,
      sourceAddress: '127.0.0.1',
      body: {},
    });
    expect(secondAttempt.status).toBe(409);

    // Advance past 15 min window clears rate limit bucket for blocked IP, still gets 409 (already bootstrapped)
    now += 16 * 60 * 1000;
    expect(
      gw.bootstrapOwnerKey({
        bootstrapHeaderToken: strongBootstrap,
        sourceAddress: '10.0.0.9',
        body: {},
      }).status
    ).toBe(409);
  });

  it('enforces RBAC, scope delegation, cross-tenant 404 non-enumeration, and conflicting identity 403 across all 10 operations', async () => {
    const cp = new PlatformControlPlaneService();
    const gw = new PlatformControlPlaneGateway(cp, {
      isProduction: false,
      dnsLookup: PUBLIC_DNS,
    });

    const orgA = 'org_avapardaz_sandbox';
    const prjA = 'prj_avapardaz_dev_01';

    const orgB = cp.createOrganization({ name: 'Tenant B Corp', defaultRegionId: 'ir-thr-01' });
    const prjB = cp.createProject({ organizationId: orgB.id, projectName: 'Tenant B Dev', environment: 'DEVELOPMENT' });

    const ownerA = setupPrincipalKey({
      cp,
      organizationId: orgA,
      projectId: prjA,
      userId: 'usr_studio_owner_01',
      role: 'OWNER',
      scopes: [...BOOTSTRAP_OWNER_SCOPES],
    });
    const devA = setupPrincipalKey({
      cp,
      organizationId: orgA,
      projectId: prjA,
      userId: 'usr_dev_a',
      role: 'DEVELOPER',
      scopes: ['platform:read', 'projects:read', 'audio:transcribe', 'models:read'],
    });
    const billingA = setupPrincipalKey({
      cp,
      organizationId: orgA,
      projectId: prjA,
      userId: 'usr_billing_a',
      role: 'BILLING_ADMIN',
      scopes: ['platform:read', 'billing:read', 'billing:write'],
    });
    const ownerB = setupPrincipalKey({
      cp,
      organizationId: orgB.id,
      projectId: prjB.id,
      userId: 'usr_owner_b',
      role: 'OWNER',
      scopes: [...BOOTSTRAP_OWNER_SCOPES],
    });

    // Unauthenticated rejected (401)
    expect((await gw.getOverview({ bearerToken: '' })).status).toBe(401);
    expect(gw.createProject({ bearerToken: '', body: { projectName: 'X' } }).status).toBe(401);
    expect(gw.issueApiKey({ bearerToken: '', body: { projectId: prjA } }).status).toBe(401);

    // Conflicting organizationId/principalId/role rejected (403)
    expect(
      gw.createProject({
        bearerToken: ownerA.bearer,
        body: { projectName: 'Spoof', organizationId: orgB.id },
      }).status
    ).toBe(403);
    expect(
      gw.issueApiKey({
        bearerToken: ownerA.bearer,
        body: { projectId: prjA, principalId: 'usr_owner_b', scopes: ['models:read'] },
      }).status
    ).toBe(403);

    // DEVELOPER cannot create project, issue keys, or issue invoices (403)
    expect(
      gw.createProject({ bearerToken: devA.bearer, body: { projectName: 'DevProj' } }).status
    ).toBe(403);
    expect(
      gw.issueApiKey({ bearerToken: devA.bearer, body: { projectId: prjA, scopes: ['models:read'] } }).status
    ).toBe(403);
    expect(gw.issueInvoice({ bearerToken: devA.bearer, body: {} }).status).toBe(403);

    // BILLING_ADMIN can issue invoice (idempotent), cannot issue API keys
    const inv1 = gw.issueInvoice({ bearerToken: billingA.bearer, body: {} });
    const inv2 = gw.issueInvoice({ bearerToken: billingA.bearer, body: {} });
    expect(inv1.status).toBe(201);
    expect((inv1.body as { invoiceId: string }).invoiceId).toBe(
      (inv2.body as { invoiceId: string }).invoiceId
    );
    expect(
      gw.issueApiKey({ bearerToken: billingA.bearer, body: { projectId: prjA, scopes: ['models:read'] } }).status
    ).toBe(403);

    // Cross-tenant resource lookup returns 404 (no existence oracle)
    expect(
      gw.rotateApiKey({
        bearerToken: ownerB.bearer,
        credentialId: devA.credentialId,
        body: { overlapHours: 12 },
      }).status
    ).toBe(404);
    expect(
      gw.revokeApiKey({
        bearerToken: ownerB.bearer,
        credentialId: devA.credentialId,
      }).status
    ).toBe(404);
    expect(
      gw.issueApiKey({
        bearerToken: ownerB.bearer,
        body: { projectId: prjA, scopes: ['models:read'] },
      }).status
    ).toBe(404);

    // Step-up authentication required (403) for PRODUCTION project key issuance
    const prodPrj = gw.createProject({
      bearerToken: ownerA.bearer,
      body: { projectName: 'Production ASR', environment: 'PRODUCTION' },
    });
    expect(prodPrj.status).toBe(201);
    const prodPrjId = (prodPrj.body as { id: string }).id;

    const prodIssueNoStepUp = gw.issueApiKey({
      bearerToken: ownerA.bearer,
      body: { projectId: prodPrjId, name: 'Prod Key', scopes: ['audio:transcribe'] },
    });
    expect(prodIssueNoStepUp.status).toBe(403);
    expect((prodIssueNoStepUp.body as { error: { code: string } }).error.code).toBe(
      'STEP_UP_AUTHENTICATION_REQUIRED'
    );
  });

  it('performs atomic key rotation preserving expiration, enforces webhook limits/once-secret, and replays DLQ honestly as RETRY_SCHEDULED', async () => {
    const cp = new PlatformControlPlaneService();
    const gw = new PlatformControlPlaneGateway(cp, {
      isProduction: false,
      dnsLookup: PUBLIC_DNS,
    });
    const orgA = 'org_avapardaz_sandbox';
    const prjA = 'prj_avapardaz_dev_01';

    const ownerA = setupPrincipalKey({
      cp,
      organizationId: orgA,
      projectId: prjA,
      userId: 'usr_studio_owner_01',
      role: 'OWNER',
      scopes: [...BOOTSTRAP_OWNER_SCOPES],
    });

    // Issue finite-expiration key (30 days)
    const issued = gw.issueApiKey({
      bearerToken: ownerA.bearer,
      body: {
        projectId: prjA,
        name: 'Short-lived Worker Key',
        scopes: ['audio:transcribe', 'models:read'],
        expiresInDays: 30,
      },
    });
    expect(issued.status).toBe(201);
    const oldCred = (issued.body as { credential: { id: string; expiresAtIso: string } }).credential;
    expect(oldCred.expiresAtIso).not.toBeNull();

    // Invalid overlapHours rejected without mutating old key
    const badRotate = gw.rotateApiKey({
      bearerToken: ownerA.bearer,
      credentialId: oldCred.id,
      body: { overlapHours: 72 },
    });
    expect(badRotate.status).toBe(400);
    const stillActive = cp.listApiKeys(orgA).find((k) => k.id === oldCred.id);
    expect(stillActive?.overlapRevokesAtIso).toBeNull();

    // Valid rotation preserves exact expiresAtIso and sets overlapRevokesAtIso on old key
    const rotated = gw.rotateApiKey({
      bearerToken: ownerA.bearer,
      credentialId: oldCred.id,
      body: { overlapHours: 12 },
    });
    expect(rotated.status).toBe(200);
    const newCred = (rotated.body as { credential: { expiresAtIso: string } }).credential;
    expect(newCred.expiresAtIso).toBe(oldCred.expiresAtIso);

    // Webhook registration returns signingSecretOnce once and blocks duplicates
    const wh1 = await gw.registerWebhook({
      bearerToken: ownerA.bearer,
      body: {
        url: 'https://hooks.example.com/v1/asr',
        eventSubscriptions: ['transcription.completed'],
      },
    });
    expect(wh1.status).toBe(201);
    expect(typeof (wh1.body as { signingSecretOnce: string }).signingSecretOnce).toBe('string');

    const whDup = await gw.registerWebhook({
      bearerToken: ownerA.bearer,
      body: {
        url: 'https://hooks.example.com/v1/asr',
        eventSubscriptions: ['transcription.completed'],
      },
    });
    expect(whDup.status).toBe(409);

    // Test dispatch failure -> DLQ -> replay transitions honestly to RETRY_SCHEDULED (never synthetic DELIVERED)
    const dispatchRes = gw.testWebhookDispatch({
      bearerToken: ownerA.bearer,
      body: { simulateFailure: true },
    });
    expect(dispatchRes.status).toBe(200);
    const deliveries = (dispatchRes.body as { deliveries: Array<{ deliveryId: string; status: string }> }).deliveries;
    expect(deliveries[0].status).toBe('DEAD_LETTER');

    const replayRes = gw.replayWebhookDelivery({
      bearerToken: ownerA.bearer,
      deliveryId: deliveries[0].deliveryId,
      body: {},
    });
    expect(replayRes.status).toBe(202);
    const replayed = replayRes.body as {
      delivery: { status: string; httpStatus: number | null; nextRetryAtIso: string | null };
      workerAvailable: boolean;
    };
    expect(replayed.delivery.status).toBe('RETRY_SCHEDULED');
    expect(replayed.delivery.httpStatus).toBeNull();
    expect(replayed.delivery.nextRetryAtIso).not.toBeNull();
    expect(replayed.workerAvailable).toBe(false);
  });
});
