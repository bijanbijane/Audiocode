/**
 * AVP-SPEECH-INTELLIGENCE-SANDBOX-BOUNDARY-012
 * Dedicated Development-Only Access Guard & Express Router for Phase 11 Speech Intelligence Sandbox.
 *
 * Security Invariants:
 * 1. Production fail-closed: NODE_ENV === 'production' with ENABLE_INTELLIGENCE_SANDBOX_ROUTES === 'true'
 *    throws a startup configuration error. In production (or when disabled), sandbox routes are NEVER registered
 *    and every request to /api/v1/intelligence/sandbox* receives a sanitized 404 without invoking the orchestrator.
 * 2. Dedicated Bearer token authentication (>= 32 bytes, placeholder rejection, SHA-256 + timingSafeEqual),
 *    strictly rejecting query/body/cookie tokens.
 * 3. Bounded per-source failed-auth throttling (5 failures / 15 min -> 429, max 10,000 tracked sources).
 * 4. Same-origin mutation protection: Sec-Fetch-Site cross-site rejection, Origin vs actual Host check
 *    (ignoring untrusted X-Forwarded-Host/Proto), required X-Requested-With: AvapardazSandbox on mutations.
 * 5. Route-scoped 256 KiB JSON payload cap, strict schema validation, per-source DAG rate limiting (5/min, 20/hr),
 *    explicit X-Confirm-Recording-Id confirmation header on cascading deletion, and zero raw-secret audit logging.
 */

import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import {
  DEFAULT_FULL_SANDBOX_CONSENT,
  PHASE11_CAPABILITY_REGISTRY,
} from './CapabilityRegistryAndOrchestrator';
import { RealtimeIntelligenceStreamCoordinator } from './MeetingAnalyticsSearchEngine';
import type {
  GranularProcessingConsent,
  SpeechCapabilityId,
} from './SpeechIntelligenceContracts';
import type { TimedSegmentInput } from './DiarizationAlignmentEngine';
import type { PlatformDataPlaneGateway } from '../platform/PlatformDataPlaneGateway';
import type { PlatformControlPlaneService } from '../platform/PlatformControlPlaneEngine';

export const SANDBOX_MIN_TOKEN_BYTES = 32;
export const SANDBOX_MAX_FAILED_AUTH_ATTEMPTS = 5;
export const SANDBOX_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const SANDBOX_MAX_TRACKED_SOURCES = 10_000;
export const SANDBOX_MAX_REQUEST_BYTES = 256 * 1024;
export const SANDBOX_MAX_SEGMENTS_PER_REQUEST = 200;
export const SANDBOX_MAX_TOTAL_SEGMENT_TEXT_CHARS = 128 * 1024;
export const SANDBOX_MAX_RECORDING_ID_LENGTH = 128;
export const SANDBOX_MAX_SEARCH_QUERY_CHARS = 1024;
export const SANDBOX_MAX_SELECTED_CAPABILITIES = 9;
export const SANDBOX_DAG_MAX_PER_MINUTE = 5;
export const SANDBOX_DAG_MAX_PER_HOUR = 20;
export const SANDBOX_REQUESTED_WITH_HEADER = 'AvapardazSandbox';

const VALID_RECORDING_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const VALID_CAPABILITY_IDS = new Set<string>(PHASE11_CAPABILITY_REGISTRY.map((c) => c.capabilityId));
const FORBIDDEN_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /replace[-_ ]?me/i,
  /change[-_ ]?me/i,
  /placeholder/i,
  /example/i,
  /default[-_ ]?token/i,
  /sandbox[-_ ]?token/i,
  /dev[-_ ]?token/i,
  /your[-_ ]?token/i,
  /todo/i,
  /^0+$/,
  /^1+$/,
  /^a+$/i,
  /^x+$/i,
];

const FORBIDDEN_IDENTITY_OVERRIDE_FIELDS = [
  'organizationId',
  'organization_id',
  'projectId',
  'project_id',
  'credentialId',
  'credential_id',
  'userId',
  'user_id',
  'actorId',
  'role',
] as const;

export interface SandboxHttpAccessConfig {
  nodeEnv: string;
  enableSandboxRoutes: boolean;
  sandboxToken: string | undefined;
  sandboxOrganizationId?: string;
  sandboxProjectId?: string;
  nowFn?: () => number;
}

export interface SandboxAccessContext {
  executionEnvironment: 'DEVELOPMENT_SANDBOX';
  organizationId: string;
  projectId: string;
  credentialId: string;
  sourceIp: string;
  authenticatedAtIso: string;
}

interface AuthFailureTracker {
  failures: number;
  windowStartMs: number;
}

interface DagRateTracker {
  timestampsMs: number[];
}

export function isSandboxTokenStrong(token: string | undefined): token is string {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (trimmed !== token) return false;
  if (Buffer.byteLength(trimmed, 'utf8') < SANDBOX_MIN_TOKEN_BYTES) return false;
  if (/\s/.test(trimmed)) return false;
  const uniqueChars = new Set(trimmed.split('')).size;
  if (uniqueChars < 8) return false;
  for (const pattern of FORBIDDEN_PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  return true;
}

export function resolveSandboxRuntimePolicy(env: {
  NODE_ENV?: string;
  ENABLE_INTELLIGENCE_SANDBOX_ROUTES?: string;
  INTELLIGENCE_SANDBOX_TOKEN?: string;
}): SandboxHttpAccessConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development').trim().toLowerCase();
  const enableRaw = (env.ENABLE_INTELLIGENCE_SANDBOX_ROUTES ?? 'false').trim().toLowerCase();
  const enableRequested = enableRaw === 'true';

  if (nodeEnv === 'production' && enableRequested) {
    throw new Error(
      'CONFIGURATION_ERROR: ENABLE_INTELLIGENCE_SANDBOX_ROUTES=true is forbidden when NODE_ENV=production. Speech Intelligence sandbox routes cannot be enabled in production.'
    );
  }

  return {
    nodeEnv,
    enableSandboxRoutes: nodeEnv !== 'production' && enableRequested,
    sandboxToken: env.INTELLIGENCE_SANDBOX_TOKEN,
    sandboxOrganizationId: 'org_avapardaz_sandbox',
    sandboxProjectId: 'prj_avapardaz_dev_01',
  };
}

function sha256Digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeCompareTokens(supplied: string, expected: string): boolean {
  const a = sha256Digest(supplied);
  const b = sha256Digest(expected);
  return crypto.timingSafeEqual(a, b);
}

function extractClientSourceIp(req: Request): string {
  const direct = req.socket?.remoteAddress || req.ip || 'unknown';
  return String(direct).slice(0, 128);
}

function parseBearerTokenStrict(req: Request): { ok: true; token: string } | { ok: false; reason: string } {
  // Reject query-string or cookie token attempts explicitly
  const query = req.query as Record<string, unknown> | undefined;
  if (
    query &&
    (query.token !== undefined ||
      query.access_token !== undefined ||
      query.sandbox_token !== undefined ||
      query.api_key !== undefined)
  ) {
    return { ok: false, reason: 'Tokens must be provided exclusively via the Authorization Bearer header.' };
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'Missing Authorization Bearer token.' };
  }
  const token = authHeader.slice('Bearer '.length);
  if (!token || token.trim() !== token || /\s/.test(token)) {
    return { ok: false, reason: 'Malformed Authorization Bearer token.' };
  }
  return { ok: true, token };
}

function checkSameOriginAndMutationHeaders(req: Request): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string'
    ? req.headers['sec-fetch-site'].trim().toLowerCase()
    : '';
  if (secFetchSite === 'cross-site') {
    return {
      ok: false,
      status: 403,
      code: 'SANDBOX_CROSS_ORIGIN_DENIED',
      message: 'Cross-site requests to Speech Intelligence sandbox routes are forbidden.',
    };
  }

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (originHeader) {
    // Strictly compare against actual Host header; never trust X-Forwarded-Host or X-Forwarded-Proto
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
    let originHost = '';
    try {
      const parsed = new URL(originHeader);
      originHost = parsed.host.toLowerCase();
    } catch {
      return {
        ok: false,
        status: 403,
        code: 'SANDBOX_CROSS_ORIGIN_DENIED',
        message: 'Invalid Origin header.',
      };
    }
    if (!hostHeader || originHost !== hostHeader) {
      return {
        ok: false,
        status: 403,
        code: 'SANDBOX_CROSS_ORIGIN_DENIED',
        message: 'Origin does not match target host.',
      };
    }
  }

  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const requestedWith = typeof req.headers['x-requested-with'] === 'string'
      ? req.headers['x-requested-with'].trim()
      : '';
    if (requestedWith !== SANDBOX_REQUESTED_WITH_HEADER) {
      return {
        ok: false,
        status: 403,
        code: 'SANDBOX_ORIGIN_HEADER_REQUIRED',
        message: `State-changing sandbox requests require header X-Requested-With: ${SANDBOX_REQUESTED_WITH_HEADER}.`,
      };
    }

    const contentLengthHeader = req.headers['content-length'];
    const parsedLength = typeof contentLengthHeader === 'string' ? Number(contentLengthHeader) : 0;
    const hasBody =
      (Number.isFinite(parsedLength) && parsedLength > 0) ||
      Boolean(req.headers['transfer-encoding']);
    if (hasBody) {
      const contentType = typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type'].trim().toLowerCase()
        : '';
      if (!contentType.startsWith('application/json')) {
        return {
          ok: false,
          status: 415,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Sandbox request bodies must use Content-Type: application/json.',
        };
      }
    }
  }

  return { ok: true };
}

function sendSanitizedError(res: Response, status: number, code: string, message: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({
    error: {
      code,
      message,
    },
  });
}

function validateRecordingIdStrict(raw: unknown): { ok: true; recordingId: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') {
    return { ok: false, message: 'recordingId must be a non-empty string.' };
  }
  const trimmed = raw.trim();
  if (trimmed !== raw) {
    return { ok: false, message: 'recordingId must not contain leading or trailing whitespace.' };
  }
  if (
    trimmed.length === 0 ||
    trimmed.length > SANDBOX_MAX_RECORDING_ID_LENGTH ||
    trimmed.includes('..') ||
    !VALID_RECORDING_ID_REGEX.test(trimmed)
  ) {
    return {
      ok: false,
      message: 'recordingId must match ^[A-Za-z0-9._-]{1,128}$ and must not contain path traversal sequences.',
    };
  }
  return { ok: true, recordingId: trimmed };
}

function checkNoForbiddenIdentityOverrides(body: Record<string, unknown>): string | null {
  for (const field of FORBIDDEN_IDENTITY_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) {
      return `Client-supplied identity field "${field}" is not permitted on sandbox endpoints.`;
    }
  }
  return null;
}

export class SandboxHttpAccessGuard {
  private readonly authFailures = new Map<string, AuthFailureTracker>();
  private readonly dagRateLimit = new Map<string, DagRateTracker>();
  private readonly nowFn: () => number;
  private readonly configuredToken: string | null;
  private readonly credentialFingerprint: string;
  public readonly sandboxOrganizationId: string;
  public readonly sandboxProjectId: string;

  constructor(private readonly config: SandboxHttpAccessConfig) {
    if (config.nodeEnv === 'production' && config.enableSandboxRoutes) {
      throw new Error(
        'CONFIGURATION_ERROR: SandboxHttpAccessGuard cannot be initialized with sandbox routes enabled in production.'
      );
    }
    this.nowFn = config.nowFn ?? (() => Date.now());
    this.configuredToken = isSandboxTokenStrong(config.sandboxToken) ? config.sandboxToken : null;
    this.credentialFingerprint = this.configuredToken
      ? `sandbox_token_${sha256Digest(this.configuredToken).toString('hex').slice(0, 12)}`
      : 'sandbox_unconfigured';
    this.sandboxOrganizationId = config.sandboxOrganizationId ?? 'org_avapardaz_sandbox';
    this.sandboxProjectId = config.sandboxProjectId ?? 'prj_avapardaz_dev_01';
  }

  public isConfiguredAndEnabled(): boolean {
    return this.config.nodeEnv !== 'production' && this.config.enableSandboxRoutes && this.configuredToken !== null;
  }

  private evictBoundedMap<T>(map: Map<string, T>, isExpired: (entry: T) => boolean): void {
    if (map.size < SANDBOX_MAX_TRACKED_SOURCES) return;
    for (const [k, v] of map.entries()) {
      if (isExpired(v)) {
        map.delete(k);
      }
    }
    while (map.size >= SANDBOX_MAX_TRACKED_SOURCES) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  private recordAuthFailure(sourceIp: string, now: number): { blocked: boolean; retryAfterSec: number } {
    this.evictBoundedMap(this.authFailures, (e) => now - e.windowStartMs >= SANDBOX_AUTH_FAILURE_WINDOW_MS);
    const existing = this.authFailures.get(sourceIp);
    if (!existing || now - existing.windowStartMs >= SANDBOX_AUTH_FAILURE_WINDOW_MS) {
      this.authFailures.set(sourceIp, { failures: 1, windowStartMs: now });
      return { blocked: false, retryAfterSec: 0 };
    }
    existing.failures += 1;
    const remainingMs = Math.max(1000, SANDBOX_AUTH_FAILURE_WINDOW_MS - (now - existing.windowStartMs));
    return {
      blocked: existing.failures > SANDBOX_MAX_FAILED_AUTH_ATTEMPTS,
      retryAfterSec: Math.ceil(remainingMs / 1000),
    };
  }

  private isAuthRateLimited(sourceIp: string, now: number): { blocked: boolean; retryAfterSec: number } {
    const existing = this.authFailures.get(sourceIp);
    if (!existing) return { blocked: false, retryAfterSec: 0 };
    if (now - existing.windowStartMs >= SANDBOX_AUTH_FAILURE_WINDOW_MS) {
      this.authFailures.delete(sourceIp);
      return { blocked: false, retryAfterSec: 0 };
    }
    if (existing.failures >= SANDBOX_MAX_FAILED_AUTH_ATTEMPTS) {
      const remainingMs = Math.max(1000, SANDBOX_AUTH_FAILURE_WINDOW_MS - (now - existing.windowStartMs));
      return { blocked: true, retryAfterSec: Math.ceil(remainingMs / 1000) };
    }
    return { blocked: false, retryAfterSec: 0 };
  }

  public checkDagRateLimit(sourceIp: string): { allowed: true } | { allowed: false; retryAfterSec: number; reason: string } {
    const now = this.nowFn();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneMinuteAgo = now - 60 * 1000;

    this.evictBoundedMap(this.dagRateLimit, (e) => e.timestampsMs.every((t) => t < oneHourAgo));

    const tracker = this.dagRateLimit.get(sourceIp) ?? { timestampsMs: [] };
    tracker.timestampsMs = tracker.timestampsMs.filter((t) => t >= oneHourAgo);

    const lastMinuteCount = tracker.timestampsMs.filter((t) => t >= oneMinuteAgo).length;
    if (lastMinuteCount >= SANDBOX_DAG_MAX_PER_MINUTE) {
      this.dagRateLimit.set(sourceIp, tracker);
      return {
        allowed: false,
        retryAfterSec: 60,
        reason: `Sandbox DAG rate limit exceeded (${SANDBOX_DAG_MAX_PER_MINUTE} executions per minute).`,
      };
    }

    if (tracker.timestampsMs.length >= SANDBOX_DAG_MAX_PER_HOUR) {
      this.dagRateLimit.set(sourceIp, tracker);
      return {
        allowed: false,
        retryAfterSec: 300,
        reason: `Sandbox DAG rate limit exceeded (${SANDBOX_DAG_MAX_PER_HOUR} executions per hour).`,
      };
    }

    tracker.timestampsMs.push(now);
    this.dagRateLimit.set(sourceIp, tracker);
    return { allowed: true };
  }

  public authenticateRequest(req: Request):
    | { ok: true; context: SandboxAccessContext }
    | { ok: false; status: number; code: string; message: string; retryAfterSec?: number } {
    if (this.config.nodeEnv === 'production' || !this.config.enableSandboxRoutes) {
      return {
        ok: false,
        status: 404,
        code: 'NOT_FOUND',
        message: 'Endpoint not found.',
      };
    }

    if (!this.configuredToken) {
      return {
        ok: false,
        status: 503,
        code: 'SANDBOX_UNAVAILABLE',
        message:
          'Speech Intelligence sandbox is enabled but INTELLIGENCE_SANDBOX_TOKEN is missing, weak (< 32 bytes), or a placeholder.',
      };
    }

    const originCheck = checkSameOriginAndMutationHeaders(req);
    if (!originCheck.ok) {
      return originCheck;
    }

    const sourceIp = extractClientSourceIp(req);
    const now = this.nowFn();
    const rateState = this.isAuthRateLimited(sourceIp, now);
    if (rateState.blocked) {
      return {
        ok: false,
        status: 429,
        code: 'SANDBOX_AUTH_RATE_LIMITED',
        message: 'Too many failed sandbox authentication attempts. Retry later.',
        retryAfterSec: rateState.retryAfterSec,
      };
    }

    const parsed = parseBearerTokenStrict(req);
    if (!parsed.ok) {
      this.recordAuthFailure(sourceIp, now);
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: parsed.reason,
      };
    }

    if (!constantTimeCompareTokens(parsed.token, this.configuredToken)) {
      const postFailure = this.recordAuthFailure(sourceIp, now);
      if (postFailure.blocked) {
        return {
          ok: false,
          status: 429,
          code: 'SANDBOX_AUTH_RATE_LIMITED',
          message: 'Too many failed sandbox authentication attempts. Retry later.',
          retryAfterSec: postFailure.retryAfterSec,
        };
      }
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Invalid sandbox access token.',
      };
    }

    // Successful authentication clears failure history for this source
    this.authFailures.delete(sourceIp);

    return {
      ok: true,
      context: {
        executionEnvironment: 'DEVELOPMENT_SANDBOX',
        organizationId: this.sandboxOrganizationId,
        projectId: this.sandboxProjectId,
        credentialId: this.credentialFingerprint,
        sourceIp,
        authenticatedAtIso: new Date(now).toISOString(),
      },
    };
  }
}

export function createSandboxNotFoundRouter(): Router {
  const router = express.Router();
  const handleNotFound = (_req: Request, res: Response) => {
    sendSanitizedError(res, 404, 'NOT_FOUND', 'Endpoint not found.');
  };
  router.all('/api/v1/intelligence/sandbox', handleNotFound);
  router.all('/api/v1/intelligence/sandbox/{*rest}', handleNotFound);
  return router;
}

export function createSpeechIntelligenceSandboxRouter(params: {
  gateway: PlatformDataPlaneGateway;
  controlPlane?: PlatformControlPlaneService;
  config: SandboxHttpAccessConfig;
}): Router {
  const { gateway, controlPlane, config } = params;

  if (config.nodeEnv === 'production' && config.enableSandboxRoutes) {
    throw new Error(
      'CONFIGURATION_ERROR: Cannot mount Speech Intelligence sandbox router when NODE_ENV=production.'
    );
  }

  if (!config.enableSandboxRoutes) {
    return createSandboxNotFoundRouter();
  }

  const guard = new SandboxHttpAccessGuard(config);
  const router = express.Router();

  const auditSandbox = (entry: {
    action: string;
    resourceType: string;
    resourceId: string;
    outcome: 'ALLOWED' | 'DENIED';
    actorId: string;
    reason: string;
  }) => {
    if (!controlPlane) return;
    controlPlane.recordAuditLog({
      organizationId: guard.sandboxOrganizationId,
      actorType: 'API_KEY',
      actorId: entry.actorId,
      action: `SANDBOX_${entry.action}`,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      reason: `[DEVELOPMENT_SANDBOX] ${entry.reason}`,
    });
  };

  // Mount route-scoped JSON parser with strict 256 KiB cap BEFORE handlers
  const sandboxJsonParser = express.json({
    limit: SANDBOX_MAX_REQUEST_BYTES,
    strict: true,
  });

  const requireSandboxAuth = (req: Request, res: Response, next: NextFunction) => {
    const result = guard.authenticateRequest(req);
    if (!result.ok) {
      if (result.retryAfterSec !== undefined) {
        res.setHeader('Retry-After', String(result.retryAfterSec));
      }
      auditSandbox({
        action: `${req.method.toUpperCase()}_${req.path}`,
        resourceType: 'sandbox_endpoint',
        resourceId: req.path,
        outcome: 'DENIED',
        actorId: `ip:${extractClientSourceIp(req)}`,
        reason: `${result.code}: ${result.message}`,
      });
      sendSanitizedError(res, result.status, result.code, result.message);
      return;
    }

    (req as Request & { sandboxContext?: SandboxAccessContext }).sandboxContext = result.context;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Avapardaz-Execution-Environment', 'DEVELOPMENT_SANDBOX');
    next();
  };

  const jsonBodyErrorHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const maybeErr = err as { type?: string; status?: number; message?: string };
    if (maybeErr.type === 'entity.too.large' || maybeErr.status === 413) {
      sendSanitizedError(
        res,
        413,
        'PAYLOAD_TOO_LARGE',
        `Sandbox request body exceeds maximum allowed size (${SANDBOX_MAX_REQUEST_BYTES} bytes).`
      );
      return;
    }
    if (err instanceof SyntaxError || maybeErr.status === 400) {
      sendSanitizedError(res, 400, 'INVALID_JSON', 'Malformed JSON request body.');
      return;
    }
    next(err);
  };

  router.use('/api/v1/intelligence/sandbox', requireSandboxAuth, sandboxJsonParser, jsonBodyErrorHandler);

  // 1. GET /api/v1/intelligence/sandbox/overview (sanitized, sandbox-scoped only)
  router.get('/api/v1/intelligence/sandbox/overview', (req, res) => {
    const ctx = (req as Request & { sandboxContext: SandboxAccessContext }).sandboxContext;
    auditSandbox({
      action: 'OVERVIEW_READ',
      resourceType: 'sandbox_overview',
      resourceId: ctx.projectId,
      outcome: 'ALLOWED',
      actorId: ctx.credentialId,
      reason: 'Authenticated development sandbox overview access.',
    });

    const connectors = gateway.intelligenceOrchestrator
      .listConnectors(ctx.organizationId, ctx.projectId)
      .map((c) => ({
        connectorId: c.connectorId,
        organizationId: c.organizationId,
        projectId: c.projectId,
        kind: c.kind,
        name: c.name,
        status: c.status,
        isLiveProductionVerified: c.isLiveProductionVerified,
        blockerReason: c.blockerReason,
        configSummary: { configured: false },
        createdAtIso: c.createdAtIso,
        updatedAtIso: c.updatedAtIso,
      }));

    res.status(200).json({
      executionEnvironment: 'DEVELOPMENT_SANDBOX',
      capabilities: PHASE11_CAPABILITY_REGISTRY,
      connectors,
    });
  });

  // 2. POST /api/v1/intelligence/sandbox/run-dag
  router.post('/api/v1/intelligence/sandbox/run-dag', (req, res) => {
    const ctx = (req as Request & { sandboxContext: SandboxAccessContext }).sandboxContext;
    const rawBody = req.body;
    if (rawBody !== undefined && (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody))) {
      sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
      return;
    }
    const body = (rawBody ?? {}) as Record<string, unknown>;

    const overrideErr = checkNoForbiddenIdentityOverrides(body);
    if (overrideErr) {
      sendSanitizedError(res, 400, 'FORBIDDEN_IDENTITY_OVERRIDE', overrideErr);
      return;
    }

    const rateRes = guard.checkDagRateLimit(ctx.sourceIp);
    if (!rateRes.allowed) {
      res.setHeader('Retry-After', String(rateRes.retryAfterSec));
      auditSandbox({
        action: 'RUN_DAG',
        resourceType: 'intelligence_job',
        resourceId: String(body.recordingId ?? 'default'),
        outcome: 'DENIED',
        actorId: ctx.credentialId,
        reason: rateRes.reason,
      });
      sendSanitizedError(res, 429, 'SANDBOX_EXECUTION_RATE_LIMITED', rateRes.reason);
      return;
    }

    const recordingIdInput = body.recordingId === undefined ? 'rec_studio_demo_01' : body.recordingId;
    const recCheck = validateRecordingIdStrict(recordingIdInput);
    if (!recCheck.ok) {
      sendSanitizedError(res, 400, 'VALIDATION_ERROR', recCheck.message);
      return;
    }

    // Validate capabilities
    let selectedCaps: SpeechCapabilityId[] = [
      'speech.diarization',
      'speech.alignment',
      'speech.translation',
      'speech.subtitles',
      'speech.meeting_intelligence',
      'speech.conversation_analytics',
      'speech.semantic_indexing',
      'speech.structured_extraction',
    ];
    if (body.capabilities !== undefined) {
      if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
        sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'capabilities must be a non-empty array of known capability IDs.');
        return;
      }
      if (body.capabilities.length > SANDBOX_MAX_SELECTED_CAPABILITIES) {
        sendSanitizedError(
          res,
          400,
          'VALIDATION_ERROR',
          `capabilities may not exceed ${SANDBOX_MAX_SELECTED_CAPABILITIES} items.`
        );
        return;
      }
      const deduped: SpeechCapabilityId[] = [];
      for (const item of body.capabilities) {
        if (typeof item !== 'string' || !VALID_CAPABILITY_IDS.has(item)) {
          sendSanitizedError(res, 400, 'UNKNOWN_CAPABILITY', `Unknown capability ID: "${String(item)}".`);
          return;
        }
        if (!deduped.includes(item as SpeechCapabilityId)) {
          deduped.push(item as SpeechCapabilityId);
        }
      }
      selectedCaps = deduped;
    }

    // Validate segments
    let parsedSegments: TimedSegmentInput[];
    if (body.segments !== undefined) {
      if (!Array.isArray(body.segments) || body.segments.length === 0) {
        sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'segments, when provided, must be a non-empty array.');
        return;
      }
      if (body.segments.length > SANDBOX_MAX_SEGMENTS_PER_REQUEST) {
        sendSanitizedError(
          res,
          400,
          'VALIDATION_ERROR',
          `segments exceeds maximum allowed count (${SANDBOX_MAX_SEGMENTS_PER_REQUEST}).`
        );
        return;
      }
      let totalChars = 0;
      const validated: TimedSegmentInput[] = [];
      for (let i = 0; i < body.segments.length; i += 1) {
        const seg = body.segments[i] as Record<string, unknown> | null;
        if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
          sendSanitizedError(res, 400, 'VALIDATION_ERROR', `segments[${i}] must be an object.`);
          return;
        }
        if (typeof seg.segmentId !== 'string' || seg.segmentId.trim().length === 0 || seg.segmentId.length > 64) {
          sendSanitizedError(res, 400, 'VALIDATION_ERROR', `segments[${i}].segmentId must be a non-empty string (<= 64 chars).`);
          return;
        }
        if (
          typeof seg.startSec !== 'number' ||
          typeof seg.endSec !== 'number' ||
          !Number.isFinite(seg.startSec) ||
          !Number.isFinite(seg.endSec) ||
          seg.startSec < 0 ||
          seg.endSec <= seg.startSec
        ) {
          sendSanitizedError(
            res,
            400,
            'VALIDATION_ERROR',
            `segments[${i}] must have finite timestamps with 0 <= startSec < endSec.`
          );
          return;
        }
        if (typeof seg.text !== 'string' || seg.text.trim().length === 0) {
          sendSanitizedError(res, 400, 'VALIDATION_ERROR', `segments[${i}].text must be a non-empty string.`);
          return;
        }
        totalChars += seg.text.length;
        if (totalChars > SANDBOX_MAX_TOTAL_SEGMENT_TEXT_CHARS) {
          sendSanitizedError(
            res,
            400,
            'VALIDATION_ERROR',
            `Total segment text exceeds maximum limit (${SANDBOX_MAX_TOTAL_SEGMENT_TEXT_CHARS} characters).`
          );
          return;
        }
        const speakerHint =
          seg.speakerHint === undefined
            ? undefined
            : typeof seg.speakerHint === 'string' && seg.speakerHint.length <= 64
              ? seg.speakerHint
              : null;
        if (speakerHint === null) {
          sendSanitizedError(res, 400, 'VALIDATION_ERROR', `segments[${i}].speakerHint must be a string <= 64 chars.`);
          return;
        }
        validated.push({
          segmentId: seg.segmentId.trim(),
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: seg.text,
          ...(speakerHint ? { speakerHint } : {}),
        });
      }
      parsedSegments = validated;
    } else {
      parsedSegments = [
        {
          segmentId: 'seg_1',
          startSec: 0.3,
          endSec: 4.1,
          text: 'سلام، امروز وضعیت سرویس TypeScript و قرارداد PRJ-204 را در آواپرداز بررسی می‌کنیم.',
          speakerHint: 'speaker_1',
        },
        {
          segmentId: 'seg_2',
          startSec: 4.2,
          endSec: 8.3,
          text: 'توافق شد مبلغ 500 USD در تاریخ 2026-11-25 پرداخت شود و باید گزارش جلسه آماده شود.',
          speakerHint: 'speaker_2',
        },
        {
          segmentId: 'seg_3',
          startSec: 8.5,
          endSec: 11.4,
          text: 'آیا حدود یکی دو هفته برای تحویل نهایی زمان کافی داریم؟',
          speakerHint: 'speaker_1',
        },
      ];
    }

    // Validate consent object strictly
    let effectiveConsent: GranularProcessingConsent = { ...DEFAULT_FULL_SANDBOX_CONSENT };
    if (body.consent !== undefined) {
      if (typeof body.consent !== 'object' || body.consent === null || Array.isArray(body.consent)) {
        sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'consent must be an object of boolean flags.');
        return;
      }
      const allowedConsentKeys = new Set<string>(Object.keys(DEFAULT_FULL_SANDBOX_CONSENT));
      for (const [k, v] of Object.entries(body.consent as Record<string, unknown>)) {
        if (!allowedConsentKeys.has(k) || typeof v !== 'boolean') {
          sendSanitizedError(res, 400, 'VALIDATION_ERROR', `Invalid consent flag "${k}".`);
          return;
        }
        (effectiveConsent as unknown as Record<string, boolean>)[k] = v;
      }
    }

    try {
      const durationSec = Math.max(
        1,
        Math.ceil(Math.max(...parsedSegments.map((s) => s.endSec)))
      );
      const job = gateway.intelligenceOrchestrator.submitIntelligenceJob({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        credentialId: ctx.credentialId,
        recordingId: recCheck.recordingId,
        language: 'fa-en',
        durationSec,
        sourceTranscriptSegments: parsedSegments,
        consent: effectiveConsent,
        capabilities: selectedCaps.map((id) => ({ id })),
      });
      const artifacts = gateway.intelligenceOrchestrator.getJobArtifacts({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        jobId: job.jobId,
      });

      auditSandbox({
        action: 'RUN_DAG',
        resourceType: 'intelligence_job',
        resourceId: job.jobId,
        outcome: 'ALLOWED',
        actorId: ctx.credentialId,
        reason: `Executed sandbox DAG for recording ${recCheck.recordingId} (${selectedCaps.length} capabilities).`,
      });

      res.status(201).json({
        executionEnvironment: 'DEVELOPMENT_SANDBOX',
        job,
        artifacts,
      });
    } catch {
      sendSanitizedError(res, 400, 'INTELLIGENCE_JOB_FAILED', 'Failed to execute sandbox intelligence DAG job.');
    }
  });

  // 3. POST /api/v1/intelligence/sandbox/search
  router.post('/api/v1/intelligence/sandbox/search', (req, res) => {
    const ctx = (req as Request & { sandboxContext: SandboxAccessContext }).sandboxContext;
    const rawBody = req.body;
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
      return;
    }
    const body = rawBody as Record<string, unknown>;
    const overrideErr = checkNoForbiddenIdentityOverrides(body);
    if (overrideErr) {
      sendSanitizedError(res, 400, 'FORBIDDEN_IDENTITY_OVERRIDE', overrideErr);
      return;
    }

    if (typeof body.query !== 'string' || body.query.trim().length === 0 || body.query.length > SANDBOX_MAX_SEARCH_QUERY_CHARS) {
      sendSanitizedError(
        res,
        400,
        'VALIDATION_ERROR',
        `query must be a non-empty string with length <= ${SANDBOX_MAX_SEARCH_QUERY_CHARS}.`
      );
      return;
    }

    let validatedRecordingId: string | undefined;
    if (body.recordingId !== undefined && body.recordingId !== '') {
      const recCheck = validateRecordingIdStrict(body.recordingId);
      if (!recCheck.ok) {
        sendSanitizedError(res, 400, 'VALIDATION_ERROR', recCheck.message);
        return;
      }
      validatedRecordingId = recCheck.recordingId;
    }

    let validatedSpeakerId: string | undefined;
    if (body.speakerId !== undefined && body.speakerId !== '') {
      if (typeof body.speakerId !== 'string' || body.speakerId.length > 64) {
        sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'speakerId must be a string <= 64 chars.');
        return;
      }
      validatedSpeakerId = body.speakerId;
    }

    const results = gateway.intelligenceOrchestrator.getSemanticIndex().searchAuthorized({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      recordingId: validatedRecordingId,
      query: body.query,
      speakerId: validatedSpeakerId,
    });

    auditSandbox({
      action: 'SEMANTIC_SEARCH',
      resourceType: 'semantic_index',
      resourceId: validatedRecordingId ?? ctx.projectId,
      outcome: 'ALLOWED',
      actorId: ctx.credentialId,
      reason: `Sandbox semantic search returned ${results.length} matches.`,
    });

    res.status(200).json({
      executionEnvironment: 'DEVELOPMENT_SANDBOX',
      results,
    });
  });

  // 4. POST /api/v1/intelligence/sandbox/realtime-sim
  router.post('/api/v1/intelligence/sandbox/realtime-sim', (req, res) => {
    const ctx = (req as Request & { sandboxContext: SandboxAccessContext }).sandboxContext;
    if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
      sendSanitizedError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object when provided.');
      return;
    }
    if (req.body && typeof req.body === 'object') {
      const overrideErr = checkNoForbiddenIdentityOverrides(req.body as Record<string, unknown>);
      if (overrideErr) {
        sendSanitizedError(res, 400, 'FORBIDDEN_IDENTITY_OVERRIDE', overrideErr);
        return;
      }
    }

    const sessionId = `sess_sandbox_${crypto.randomUUID().slice(0, 8)}`;
    const coord = new RealtimeIntelligenceStreamCoordinator(sessionId, 0.1);
    const step1 = coord.emitChunkEvents({
      asrBaselineLatencyMs: 28,
      chunkStartSample: 0,
      chunkEndSample: 16000,
      partialText: 'امروز سرویس',
      speakerId: 'speaker_1',
      enableOptionalIntelligence: true,
      simulatedOptionalWorkerLatencyMs: 2,
    });
    const step2 = coord.emitChunkEvents({
      asrBaselineLatencyMs: 28,
      chunkStartSample: 16000,
      chunkEndSample: 48000,
      finalText: 'امروز سرویس TypeScript آماده شد.',
      speakerId: 'speaker_1',
      enableOptionalIntelligence: true,
      simulatedOptionalWorkerLatencyMs: 2,
    });
    const step3Throttled = coord.emitChunkEvents({
      asrBaselineLatencyMs: 28,
      chunkStartSample: 48000,
      chunkEndSample: 64000,
      finalText: 'کیفیت صوتی اصلی حفظ شد.',
      speakerId: 'speaker_2',
      enableOptionalIntelligence: true,
      simulatedOptionalWorkerLatencyMs: 35,
    });

    auditSandbox({
      action: 'REALTIME_SIM',
      resourceType: 'realtime_simulation',
      resourceId: sessionId,
      outcome: 'ALLOWED',
      actorId: ctx.credentialId,
      reason: 'Executed sandbox realtime intelligence backpressure simulation.',
    });

    res.status(200).json({
      executionEnvironment: 'DEVELOPMENT_SANDBOX',
      sessionId: coord.sessionId,
      events: coord.listOrderedEvents(),
      asrStreamAliveThroughout: step1.asrStreamAlive && step2.asrStreamAlive && step3Throttled.asrStreamAlive,
      backpressureTriggeredOnOverload: step3Throttled.throttledOptionalWorkers,
    });
  });

  // 5. DELETE /api/v1/intelligence/sandbox/recordings/:recordingId
  router.delete('/api/v1/intelligence/sandbox/recordings/:recordingId', (req, res) => {
    const ctx = (req as unknown as Request & { sandboxContext: SandboxAccessContext }).sandboxContext;
    const recCheck = validateRecordingIdStrict(req.params.recordingId);
    if (!recCheck.ok) {
      sendSanitizedError(res, 400, 'VALIDATION_ERROR', recCheck.message);
      return;
    }

    const confirmHeader = typeof req.headers['x-confirm-recording-id'] === 'string'
      ? req.headers['x-confirm-recording-id'].trim()
      : '';
    if (confirmHeader !== recCheck.recordingId) {
      auditSandbox({
        action: 'CASCADE_DELETE_RECORDING',
        resourceType: 'recording',
        resourceId: recCheck.recordingId,
        outcome: 'DENIED',
        actorId: ctx.credentialId,
        reason: 'Missing or mismatched X-Confirm-Recording-Id confirmation header.',
      });
      sendSanitizedError(
        res,
        400,
        'CONFIRMATION_REQUIRED',
        'Destructive sandbox deletion requires header X-Confirm-Recording-Id matching the target recordingId.'
      );
      return;
    }

    const deleted = gateway.intelligenceOrchestrator.deleteRecordingAndPropagate({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      recordingId: recCheck.recordingId,
    });

    auditSandbox({
      action: 'CASCADE_DELETE_RECORDING',
      resourceType: 'recording',
      resourceId: recCheck.recordingId,
      outcome: 'ALLOWED',
      actorId: ctx.credentialId,
      reason: `Cascade deleted ${deleted.deletedArtifactsCount} artifacts and ${deleted.deletedVectorsCount} vectors.`,
    });

    res.status(200).json({
      executionEnvironment: 'DEVELOPMENT_SANDBOX',
      recordingId: recCheck.recordingId,
      ...deleted,
    });
  });

  // Catch-all for unknown sandbox sub-routes
  router.all('/api/v1/intelligence/sandbox/{*rest}', (_req, res) => {
    sendSanitizedError(res, 404, 'NOT_FOUND', 'Sandbox endpoint not found.');
  });

  return router;
}
