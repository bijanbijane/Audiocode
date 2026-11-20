/**
 * AVP-PLATFORM-CONTROL-PLANE-AUTHORIZATION-011
 * Express HTTP Router for Authenticated Platform Control Plane Administration.
 *
 * Replaces all unauthenticated inline `/api/v1/platform/*` handlers in `server.ts`.
 */

import express from 'express';
import type { PlatformControlPlaneGateway } from './PlatformControlPlaneGateway';

function extractClaimedTenantFromRequest(req: express.Request): string | null {
  const candidates = [
    req.headers['x-organization-id'],
    req.headers['x-tenant-id'],
    req.query?.organizationId,
    req.query?.tenantId,
    req.query?.orgId,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return null;
}

export function createPlatformControlPlaneHttpRouter(
  gateway: PlatformControlPlaneGateway,
): express.Router {
  const router = express.Router();

  // Restricted one-time owner credential bootstrap (disabled by default)
  router.post('/api/v1/platform/bootstrap/owner-key', (req, res) => {
    const headerToken =
      typeof req.headers['x-platform-bootstrap-token'] === 'string'
        ? req.headers['x-platform-bootstrap-token']
        : '';
    const out = gateway.bootstrapOwnerKey({
      bootstrapHeaderToken: headerToken,
      sourceAddress: req.ip || req.socket.remoteAddress || 'unknown',
      body: req.body,
    });
    res.status(out.status).json(out.body);
  });

  // 1. Read overview (PLATFORM_READ_OVERVIEW)
  router.get('/api/v1/platform/overview', async (req, res) => {
    const out = await gateway.getOverview({
      bearerToken: String(req.headers.authorization ?? ''),
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 2. Create project (PLATFORM_CREATE_PROJECT)
  router.post('/api/v1/platform/projects', (req, res) => {
    const out = gateway.createProject({
      bearerToken: String(req.headers.authorization ?? ''),
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 3. Issue API key (PLATFORM_ISSUE_API_KEY)
  router.post('/api/v1/platform/api-keys', (req, res) => {
    const out = gateway.issueApiKey({
      bearerToken: String(req.headers.authorization ?? ''),
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 4. Rotate API key (PLATFORM_ROTATE_API_KEY)
  router.post('/api/v1/platform/api-keys/:id/rotate', (req, res) => {
    const out = gateway.rotateApiKey({
      bearerToken: String(req.headers.authorization ?? ''),
      credentialId: req.params.id,
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 5. Revoke API key (PLATFORM_REVOKE_API_KEY)
  router.post('/api/v1/platform/api-keys/:id/revoke', (req, res) => {
    const out = gateway.revokeApiKey({
      bearerToken: String(req.headers.authorization ?? ''),
      credentialId: req.params.id,
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 6. Issue invoice (PLATFORM_ISSUE_INVOICE)
  router.post('/api/v1/platform/invoices/issue', (req, res) => {
    const out = gateway.issueInvoice({
      bearerToken: String(req.headers.authorization ?? ''),
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 7. Register webhook endpoint (PLATFORM_REGISTER_WEBHOOK)
  router.post('/api/v1/platform/webhooks', async (req, res) => {
    const out = await gateway.registerWebhook({
      bearerToken: String(req.headers.authorization ?? ''),
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 8. Test webhook dispatch (PLATFORM_TEST_WEBHOOKS — DEVELOPMENT only)
  router.post('/api/v1/platform/webhooks/test-dispatch', (req, res) => {
    const out = gateway.testWebhookDispatch({
      bearerToken: String(req.headers.authorization ?? ''),
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 9. Replay DLQ webhook delivery (PLATFORM_MANAGE_WEBHOOKS)
  router.post('/api/v1/platform/webhooks/:deliveryId/replay', (req, res) => {
    const out = gateway.replayWebhookDelivery({
      bearerToken: String(req.headers.authorization ?? ''),
      deliveryId: req.params.deliveryId,
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  // 10. Check region policy (PLATFORM_CHECK_REGION)
  router.post('/api/v1/platform/region-check', (req, res) => {
    const out = gateway.checkRegionPolicy({
      bearerToken: String(req.headers.authorization ?? ''),
      body: req.body,
      claimedTenantId: extractClaimedTenantFromRequest(req),
    });
    res.status(out.status).json(out.body);
  });

  return router;
}
