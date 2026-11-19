/**
 * PHASE 14 — HARDENED EXPRESS HTTP ROUTER (`/v1/security/*`)
 *
 * Mounted directly by `/server.ts` and exercised in adversarial HTTP integration tests.
 * Never reads or trusts `x-avapardaz-role`, `req.query.role`, or client-supplied tenant headers.
 */

import express from 'express';
import type { PiiRedactionConfig } from './SpeechSecurityContracts';
import type { SpeechSecurityGateway } from './SpeechSecurityGateway';

function extractCrossTenantHint(req: express.Request): string | null {
  const candidates: unknown[] = [
    req.headers['x-tenant-id'],
    req.headers['x-organization-id'],
    req.query.tenantId,
    req.query.organizationId,
    (req.body as Record<string, unknown> | undefined)?.tenantId,
    (req.body as Record<string, unknown> | undefined)?.organizationId,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return null;
}

export function createSpeechSecurityHttpRouter(
  speechSecurityGateway: SpeechSecurityGateway
): express.Router {
  const router = express.Router();

  router.get('/v1/security/threat-model', (req, res) => {
    const out = speechSecurityGateway.getThreatModel(String(req.headers.authorization ?? ''), {
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/security/inspect-audio', (req, res) => {
    const rawBody = ((req.body ?? {}) as Record<string, unknown>);
    const claimed = extractCrossTenantHint(req);
    const out = speechSecurityGateway.inspectUpload({
      bearerToken: String(req.headers.authorization ?? ''),
      body: claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody,
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/security/validate-url', (req, res) => {
    const body = (req.body ?? {}) as { url?: string };
    const out = speechSecurityGateway.validateRemoteUrl({
      bearerToken: String(req.headers.authorization ?? ''),
      url: typeof body.url === 'string' ? body.url : '',
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/security/robustness/evaluate', (req, res) => {
    const body = (req.body ?? {}) as { modelVersionId?: string };
    // Strictly ignore x-avapardaz-role and any client-supplied role fields
    const out = speechSecurityGateway.runRobustnessSuite({
      bearerToken: String(req.headers.authorization ?? ''),
      modelVersionId: typeof body.modelVersionId === 'string' ? body.modelVersionId : undefined,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/security/transcript/trust-boundary', (req, res) => {
    const body = (req.body ?? {}) as { recordingId?: string; transcriptText?: string };
    const out = speechSecurityGateway.evaluateTranscriptBoundary({
      bearerToken: String(req.headers.authorization ?? ''),
      recordingId: typeof body.recordingId === 'string' ? body.recordingId : undefined,
      transcriptText: typeof body.transcriptText === 'string' ? body.transcriptText : undefined,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/security/privacy/redact', (req, res) => {
    const rawBody = (req.body ?? {}) as {
      recordingId?: string;
      originalTranscript?: string;
      config?: Partial<PiiRedactionConfig>;
      [extra: string]: unknown;
    };
    const claimed = extractCrossTenantHint(req);
    const out = speechSecurityGateway.createRedactedDerivative({
      bearerToken: String(req.headers.authorization ?? ''),
      body: claimed && !('tenantId' in rawBody) ? { ...rawBody, tenantId: claimed } : rawBody,
    });
    res.status(out.status).json(out.body);
  });

  router.put('/v1/security/privacy/retention', (req, res) => {
    // Strictly ignore x-avapardaz-role; pass raw JSON body so unknown/immutable fields are rejected cleanly
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const headerOrQueryTenant =
      (typeof req.headers['x-tenant-id'] === 'string' && req.headers['x-tenant-id'].trim()) ||
      (typeof req.headers['x-organization-id'] === 'string' && req.headers['x-organization-id'].trim()) ||
      (typeof req.query.tenantId === 'string' && req.query.tenantId.trim()) ||
      (typeof req.query.organizationId === 'string' && req.query.organizationId.trim()) ||
      null;
    const out = speechSecurityGateway.updateRetentionPolicy({
      bearerToken: String(req.headers.authorization ?? ''),
      body:
        headerOrQueryTenant && !('tenantId' in rawBody) && !('organizationId' in rawBody)
          ? { ...rawBody, tenantId: headerOrQueryTenant }
          : rawBody,
    });
    res.status(out.status).json(out.body);
  });

  router.delete('/v1/security/privacy/recordings/:recordingId', (req, res) => {
    // Strictly ignore x-avapardaz-role
    const out = speechSecurityGateway.executeDeletion({
      bearerToken: String(req.headers.authorization ?? ''),
      recordingId: req.params.recordingId,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.post('/v1/security/red-team/run', (req, res) => {
    // Strictly ignore x-avapardaz-role
    const out = speechSecurityGateway.runRedTeamSuite({
      bearerToken: String(req.headers.authorization ?? ''),
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  router.get('/v1/security/audit-events', (req, res) => {
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const out = speechSecurityGateway.getAuditEvents(String(req.headers.authorization ?? ''), {
      limit: rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined,
      eventType: typeof req.query.eventType === 'string' ? req.query.eventType : undefined,
      claimedTenantId: extractCrossTenantHint(req),
    });
    res.status(out.status).json(out.body);
  });

  return router;
}
