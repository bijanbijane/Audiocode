/**
 * AVAPARDAZ — AUDIO PROCESSING API SECURITY GUARD (PHASE 1A)
 *
 * Enforces explicit separation between:
 *  A) Local/Desktop Mode (`mode: 'local'`):
 *     - Loopback socket enforcement (`127.0.0.1` / `::1`)
 *     - Host header DNS-rebinding defense (plus strict same-origin proxy match only when opted in)
 *     - Strict Origin & Sec-Fetch-Site validation (rejects cross-origin/cross-site CSRF)
 *     - Short-lived per-process ephemeral HMAC session tokens via `/api/local-auth/session`
 *       (zero static secrets in frontend bundle; held strictly in memory)
 *     - Per-session replay protection (nonce + timestamp window)
 *     - Per-owner rate & concurrency limits
 *
 *  B) Hosted Mode (`mode: 'hosted'`):
 *     - Fail-closed when no valid session secret or custom verifier is configured
 *     - Mandatory verified Bearer session token (query-string tokens strictly rejected)
 *     - Mandatory Origin / CSRF validation against explicit allowlist or exact same-origin Host
 *     - Per-owner isolation (ownerId derived exclusively from verified token)
 *     - Per-session replay protection (nonce + timestamp window)
 *     - Per-owner rate & concurrency limits
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isLoopbackRemoteAddress } from '../host-bridge/companion/CompanionIpcBridge';
import { isAllowedLoopbackHostHeader } from '../host-bridge/companion/LocalCompanionService';
import { sanitizeDiagnosticRecord, sanitizeDiagnosticString } from './SecurityTrustBoundaryGuards';

export type AudioApiDeploymentMode = 'local' | 'hosted';

export interface AudioApiPrincipal {
  readonly mode: AudioApiDeploymentMode;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly expiresAtMs: number;
}

export interface VerifiedSessionResult {
  readonly ok: boolean;
  readonly statusCode?: number;
  readonly code?: string;
  readonly message?: string;
  readonly principal?: AudioApiPrincipal;
}

export type HostedSessionVerifier = (
  bearerToken: string,
  req: Request,
) => VerifiedSessionResult | Promise<VerifiedSessionResult>;

export interface AudioApiSecurityEvent {
  readonly timestampIso: string;
  readonly eventType:
    | 'AUTH_REJECTED'
    | 'LOOPBACK_BLOCKED'
    | 'DNS_REBINDING_BLOCKED'
    | 'ORIGIN_BLOCKED'
    | 'CROSS_SITE_BLOCKED'
    | 'TOKEN_IN_QUERY_BLOCKED'
    | 'REPLAY_BLOCKED'
    | 'RATE_LIMITED'
    | 'CONCURRENCY_LIMITED'
    | 'PAYLOAD_REJECTED'
    | 'IDOR_ATTEMPT_BLOCKED'
    | 'JOB_CANCELLED'
    | 'LOCAL_SESSION_ISSUED';
  readonly mode: AudioApiDeploymentMode;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly code: string;
  readonly ownerId?: string;
  readonly details?: Record<string, unknown>;
}

export interface AudioApiSecurityConfig {
  readonly mode: AudioApiDeploymentMode;
  /**
   * When true in local mode, allows a local reverse proxy (e.g. dev preview) ONLY when
   * Origin host strictly matches Host / X-Forwarded-Host or host is explicitly trusted.
   * Never weakens foreign-Origin or non-loopback checks.
   */
  readonly allowSameOriginProxyHost: boolean;
  /** Explicit Origin allowlist (e.g. ['https://studio.avapardaz.ir']). */
  readonly allowedOrigins: readonly string[];
  /** Optional trusted proxy host headers (lowercase host[:port]). */
  readonly trustedProxyHosts: readonly string[];
  /** Hosted mode HMAC session verification secret (>= 32 chars). Never hardcoded. */
  readonly hostedSessionSecret?: string;
  /**
   * Required identity issuer ID (`iss`) when using HMAC-signed Hosted session tokens.
   * A shared secret alone without an identity issuer MUST fail closed so a bare shared
   * secret can never masquerade as multi-user authentication.
   */
  readonly hostedTokenIssuer?: string;
  /** Expected JWT/session audience (`aud`). Defaults to 'avapardaz-audio-api'. */
  readonly expectedAudience: string;
  /** Maximum permitted token lifetime (exp - iat) in ms (default 24h). */
  readonly maxTokenLifetimeMs: number;
  /** Optional custom hosted session verifier (e.g. external IdP / JWT / DB session). */
  readonly verifyHostedSession?: HostedSessionVerifier;
  /** Ephemeral local session TTL in ms (default 15 minutes). */
  readonly localSessionTtlMs: number;
  /** Replay clock-skew window in ms (default 5 minutes). */
  readonly replayWindowMs: number;
  /** Max requests per owner/IP per rate window (default 60). */
  readonly rateLimitMaxRequests: number;
  /** Rate window duration in ms (default 60s). */
  readonly rateLimitWindowMs: number;
  /** Optional clock provider for deterministic tests. */
  readonly nowMs?: () => number;
  /** Optional security event sink (sanitized; never receives audio/tokens). */
  readonly onSecurityEvent?: (event: AudioApiSecurityEvent) => void;
}

export interface AudioApiGuardOptions {
  /** Require verified Bearer session token (default: true). */
  readonly requireAuth?: boolean;
  /** Require X-Request-Nonce + X-Request-Timestamp replay protection (default: false). */
  readonly requireReplayProtection?: boolean;
  /** Required scope string if any. */
  readonly requiredScope?: string;
  /** Override rate limit bucket name & ceiling for heavy endpoints (e.g., shahab-transcribe). */
  readonly rateLimitBucket?: string;
  readonly rateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      avapardazAuth?: AudioApiPrincipal;
      avapardazTransportVerified?: boolean;
      avapardazReplayVerified?: boolean;
    }
  }
}

const FORBIDDEN_QUERY_TOKEN_KEYS = new Set([
  'token',
  'access_token',
  'auth_token',
  'session_token',
  'api_key',
  'apikey',
  'authorization',
  'bearer',
  'secret',
]);

export function parseAllowedOriginsEnv(raw: string | undefined): readonly string[] {
  if (!raw || typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        out.push(u.origin.toLowerCase());
      }
    } catch {
      // ignore malformed origin entries
    }
  }
  return Object.freeze(Array.from(new Set(out)));
}

export function resolveAudioApiSecurityConfig(
  env: Record<string, string | undefined> = process.env,
  overrides?: Partial<AudioApiSecurityConfig>,
): AudioApiSecurityConfig {
  const rawMode = (overrides?.mode ?? env.AVAPARDAZ_DEPLOYMENT_MODE ?? '').trim().toLowerCase();
  const isProd = env.NODE_ENV === 'production';

  let mode: AudioApiDeploymentMode;
  if (rawMode === 'hosted') {
    mode = 'hosted';
  } else if (rawMode === 'local') {
    mode = 'local';
  } else {
    // Fail-closed default: production without explicit mode defaults to 'hosted' (which blocks
    // sensitive endpoints unless valid hosted auth is configured); non-prod defaults to 'local'.
    mode = isProd ? 'hosted' : 'local';
  }

  const allowSameOriginProxyHost =
    overrides?.allowSameOriginProxyHost ??
    (env.AVAPARDAZ_ALLOW_PROXY_HOST === 'true' ||
      Boolean(env.K_SERVICE || env.GOOGLE_CLOUD_PROJECT || env.CLOUD_RUN_JOB));

  const allowedOrigins = overrides?.allowedOrigins ?? parseAllowedOriginsEnv(env.AVAPARDAZ_ALLOWED_ORIGINS);
  const trustedProxyHosts =
    overrides?.trustedProxyHosts ??
    (env.AVAPARDAZ_TRUSTED_PROXY_HOSTS
      ? env.AVAPARDAZ_TRUSTED_PROXY_HOSTS.split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean)
      : []);

  const hostedSessionSecret = overrides?.hostedSessionSecret ?? env.AVAPARDAZ_HOSTED_SESSION_SECRET?.trim();
  const hostedTokenIssuer = overrides?.hostedTokenIssuer ?? env.AVAPARDAZ_HOSTED_TOKEN_ISSUER?.trim();
  const expectedAudience =
    (overrides?.expectedAudience ?? env.AVAPARDAZ_TOKEN_AUDIENCE ?? 'avapardaz-audio-api').trim() ||
    'avapardaz-audio-api';

  return {
    mode,
    allowSameOriginProxyHost,
    allowedOrigins,
    trustedProxyHosts,
    hostedSessionSecret,
    hostedTokenIssuer,
    expectedAudience,
    maxTokenLifetimeMs: Math.max(60_000, overrides?.maxTokenLifetimeMs ?? 24 * 60 * 60 * 1000),
    verifyHostedSession: overrides?.verifyHostedSession,
    localSessionTtlMs: Math.max(5_000, overrides?.localSessionTtlMs ?? 15 * 60 * 1000),
    replayWindowMs: Math.max(5_000, overrides?.replayWindowMs ?? 5 * 60 * 1000),
    rateLimitMaxRequests: Math.max(1, overrides?.rateLimitMaxRequests ?? 60),
    rateLimitWindowMs: Math.max(1_000, overrides?.rateLimitWindowMs ?? 60_000),
    nowMs: overrides?.nowMs,
    onSecurityEvent: overrides?.onSecurityEvent,
  };
}

/**
 * Resolves the network bind host for server.ts:
 * - Explicit AVAPARDAZ_BIND_HOST wins.
 * - Hosted mode or managed container proxy environments bind 0.0.0.0.
 * - Pure local/desktop runs bind strictly to 127.0.0.1.
 */
export function resolveServerBindHost(
  env: Record<string, string | undefined> = process.env,
  config?: Pick<AudioApiSecurityConfig, 'mode' | 'allowSameOriginProxyHost'>,
): string {
  const explicit = env.AVAPARDAZ_BIND_HOST?.trim();
  if (explicit) return explicit;
  const resolved = config ?? resolveAudioApiSecurityConfig(env);
  if (resolved.mode === 'hosted' || resolved.allowSameOriginProxyHost) {
    return '0.0.0.0';
  }
  return '127.0.0.1';
}

export function isAllowedLocalHttpOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  const cleaned = originHeader.trim().toLowerCase();
  if (!cleaned) return true;
  if (cleaned === 'null' || cleaned.startsWith('file://')) return false;
  return (
    /^https?:\/\/localhost(:\d{1,5})?$/.test(cleaned) ||
    /^https?:\/\/127\.0\.0\.1(:\d{1,5})?$/.test(cleaned) ||
    /^https?:\/\/\[::1\](:\d{1,5})?$/.test(cleaned)
  );
}

export const DEFAULT_AUDIO_API_AUDIENCE = 'avapardaz-audio-api';
export const DEFAULT_LOCAL_TOKEN_ISSUER = 'avapardaz-local-session';

const DISALLOWED_HOSTED_SUBJECTS = new Set([
  'default',
  'shared',
  'anonymous',
  'anon',
  'guest',
  'public',
  'local-studio',
  'system',
  'unknown',
  'user',
  'admin',
  'root',
  'service',
  '*',
]);

export function isValidHostedSubject(subject: unknown): subject is string {
  if (typeof subject !== 'string') return false;
  const trimmed = subject.trim();
  if (trimmed.length < 3 || trimmed.length > 128) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return false;
  if (DISALLOWED_HOSTED_SUBJECTS.has(trimmed.toLowerCase())) return false;
  return true;
}

interface SignedSessionPayload {
  readonly sub: string;
  readonly sid: string;
  readonly aud: string;
  readonly iss: string;
  readonly mode: AudioApiDeploymentMode;
  readonly scopes: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

export function issueSignedAudioSessionToken(params: {
  readonly secret: string | Buffer;
  readonly subject: string;
  readonly sessionId?: string;
  readonly mode: AudioApiDeploymentMode;
  readonly audience?: string;
  readonly issuer?: string;
  readonly scopes?: readonly string[];
  readonly ttlMs?: number;
  readonly nowMs?: number;
}): { readonly token: string; readonly sessionId: string; readonly expiresAtMs: number } {
  const now = params.nowMs ?? Date.now();
  const ttlMs = Math.max(1_000, params.ttlMs ?? 15 * 60 * 1000);
  const sessionId = params.sessionId ?? `sess_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAtMs = now + ttlMs;
  const payload: SignedSessionPayload = {
    sub: params.subject,
    sid: sessionId,
    aud: (params.audience ?? DEFAULT_AUDIO_API_AUDIENCE).trim() || DEFAULT_AUDIO_API_AUDIENCE,
    iss:
      (params.issuer ?? (params.mode === 'local' ? DEFAULT_LOCAL_TOKEN_ISSUER : 'avapardaz-hosted-idp')).trim() ||
      DEFAULT_LOCAL_TOKEN_ISSUER,
    mode: params.mode,
    scopes: params.scopes ?? ['shahab:transcribe', 'smart-edit:*'],
    iat: now,
    exp: expiresAtMs,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', params.secret)
    .update(`v1.${encodedPayload}`)
    .digest('hex');
  return {
    token: `v1.${encodedPayload}.${sig}`,
    sessionId,
    expiresAtMs,
  };
}

export function verifySignedAudioSessionToken(params: {
  readonly token: string;
  readonly secret: string | Buffer;
  readonly expectedMode: AudioApiDeploymentMode;
  readonly expectedAudience?: string;
  readonly expectedIssuer?: string;
  readonly maxTokenLifetimeMs?: number;
  readonly nowMs?: number;
}): VerifiedSessionResult {
  const raw = params.token.trim();
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'توکن احراز هویت نامعتبر است.',
    };
  }

  const expectedSig = crypto
    .createHmac('sha256', params.secret)
    .update(`v1.${parts[1]}`)
    .digest('hex');
  const providedBuf = Buffer.from(parts[2], 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (
    providedBuf.byteLength !== expectedBuf.byteLength ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'امضای توکن احراز هویت معتبر نیست.',
    };
  }

  let parsed: Partial<SignedSessionPayload>;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    parsed = JSON.parse(json) as Partial<SignedSessionPayload>;
  } catch {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'ساختار توکن احراز هویت معتبر نیست.',
    };
  }

  if (
    typeof parsed.sub !== 'string' ||
    parsed.sub.trim().length === 0 ||
    parsed.sub.length > 128 ||
    typeof parsed.sid !== 'string' ||
    parsed.sid.trim().length === 0 ||
    parsed.sid.length > 128 ||
    typeof parsed.aud !== 'string' ||
    parsed.aud.trim().length === 0 ||
    typeof parsed.iss !== 'string' ||
    parsed.iss.trim().length === 0 ||
    parsed.mode !== params.expectedMode ||
    typeof parsed.exp !== 'number' ||
    !Number.isFinite(parsed.exp) ||
    typeof parsed.iat !== 'number' ||
    !Number.isFinite(parsed.iat) ||
    !Array.isArray(parsed.scopes)
  ) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'ادعاهای توکن احراز هویت معتبر یا منطبق با حالت اجرا نیستند.',
    };
  }

  const expectedAud = (params.expectedAudience ?? DEFAULT_AUDIO_API_AUDIENCE).trim();
  if (parsed.aud.trim() !== expectedAud) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_AUDIENCE_MISMATCH',
      message: 'توکن برای سرویس دیگری صادر شده است (Audience نامنطبق).',
    };
  }

  if (params.expectedIssuer && parsed.iss.trim() !== params.expectedIssuer.trim()) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_ISSUER_MISMATCH',
      message: 'صادرکننده توکن احراز هویت معتبر نیست (Issuer نامنطبق).',
    };
  }

  const now = params.nowMs ?? Date.now();
  if (now > parsed.exp) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_EXPIRED',
      message: 'توکن نشست منقضی شده است؛ لطفاً مجدداً احراز هویت کنید.',
    };
  }
  const maxLifetime = params.maxTokenLifetimeMs ?? 24 * 60 * 60 * 1000;
  if (parsed.iat > now + 60_000 || parsed.exp <= parsed.iat || parsed.exp - parsed.iat > maxLifetime) {
    return {
      ok: false,
      statusCode: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'بازه زمانی توکن احراز هویت نامعتبر است.',
    };
  }

  if (params.expectedMode === 'hosted' && !isValidHostedSubject(parsed.sub)) {
    return {
      ok: false,
      statusCode: 401,
      code: 'HOSTED_IDENTITY_REQUIRED',
      message: 'در حالت میزبانی‌شده، هویت مستقل و معتبر کاربر در توکن الزامی است.',
    };
  }

  const scopes = parsed.scopes.filter((s): s is string => typeof s === 'string');
  const ownerId =
    params.expectedMode === 'hosted'
      ? `hosted:${parsed.sub.trim()}`
      : `local:${parsed.sid.trim()}`;

  return {
    ok: true,
    principal: {
      mode: params.expectedMode,
      ownerId,
      sessionId: parsed.sid.trim(),
      subject: parsed.sub.trim(),
      scopes,
      expiresAtMs: parsed.exp,
    },
  };
}

export function hasTokenInQueryString(req: Request): boolean {
  const q = req.query as Record<string, unknown> | undefined;
  if (!q || typeof q !== 'object') return false;
  for (const key of Object.keys(q)) {
    if (FORBIDDEN_QUERY_TOKEN_KEYS.has(key.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Validates binary audio payload magic headers to reject arbitrary non-audio uploads
 * before passing bytes to ASR or DSP decoders.
 */
export function validateBinaryAudioPayload(
  buf: Buffer,
  options?: { readonly requireWav?: boolean; readonly minBytes?: number },
): { readonly ok: boolean; readonly format?: string; readonly code?: string; readonly message?: string } {
  const minBytes = options?.minBytes ?? 44;
  if (!Buffer.isBuffer(buf) || buf.byteLength < minBytes) {
    return {
      ok: false,
      code: 'INVALID_AUDIO_INPUT',
      message: 'بدنه درخواست باید فایل صوتی باینری معتبر باشد.',
    };
  }

  const isWav =
    buf.byteLength >= 44 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE';
  if (isWav) {
    return { ok: true, format: 'wav' };
  }
  if (options?.requireWav) {
    return {
      ok: false,
      code: 'INVALID_AUDIO_INPUT',
      message: 'ساختار فایل WAV معتبر نیست (هدر RIFF/WAVE یافت نشد).',
    };
  }

  const isFlac = buf.subarray(0, 4).toString('ascii') === 'fLaC';
  if (isFlac) return { ok: true, format: 'flac' };

  const isOgg = buf.subarray(0, 4).toString('ascii') === 'OggS';
  if (isOgg) return { ok: true, format: 'ogg' };

  const isMp3Id3 = buf.subarray(0, 3).toString('ascii') === 'ID3';
  const isMp3Sync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  if (isMp3Id3 || isMp3Sync) return { ok: true, format: 'mp3' };

  const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (isWebm) return { ok: true, format: 'webm' };

  const isMp4 = buf.byteLength >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
  if (isMp4) return { ok: true, format: 'mp4' };

  const isAiff =
    buf.byteLength >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'FORM' &&
    (buf.subarray(8, 12).toString('ascii') === 'AIFF' ||
      buf.subarray(8, 12).toString('ascii') === 'AIFC');
  if (isAiff) return { ok: true, format: 'aiff' };

  return {
    ok: false,
    code: 'INVALID_AUDIO_INPUT',
    message: 'ساختار باینری فایل صوتی شناخته‌شده نیست (WAV/FLAC/MP3/OGG/M4A/WebM معتبر ارسال کنید).',
  };
}

class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  public checkAndConsume(
    key: string,
    maxRequests: number,
    windowMs: number,
    nowMs: number,
  ): { readonly allowed: boolean; readonly retryAfterSec: number } {
    const cutoff = nowMs - windowMs;
    const prev = this.buckets.get(key) ?? [];
    const active = prev.filter((ts) => ts > cutoff);
    if (active.length >= maxRequests) {
      const oldest = active[0] ?? nowMs;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
      this.buckets.set(key, active);
      return { allowed: false, retryAfterSec };
    }
    active.push(nowMs);
    this.buckets.set(key, active);
    if (this.buckets.size > 5_000) {
      const firstKey = this.buckets.keys().next().value;
      if (firstKey && firstKey !== key) this.buckets.delete(firstKey);
    }
    return { allowed: true, retryAfterSec: 0 };
  }
}

class NonceReplayStore {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries = 20_000;

  public consume(key: string, expiresAtMs: number, nowMs: number): boolean {
    // Periodic sweep of expired nonces
    if (this.entries.size > 512) {
      for (const [k, exp] of this.entries.entries()) {
        if (nowMs > exp) this.entries.delete(k);
      }
    }
    const existingExp = this.entries.get(key);
    if (existingExp !== undefined && nowMs <= existingExp) {
      return false;
    }
    this.entries.set(key, expiresAtMs);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
    return true;
  }
}

export class AudioApiSecurityGuard {
  public readonly config: AudioApiSecurityConfig;
  private readonly localEphemeralSecret: Buffer;
  private readonly localSessionRegistry = new Map<string, number>();
  private readonly rateLimiter = new SlidingWindowRateLimiter();
  private readonly replayStore = new NonceReplayStore();
  private readonly activeConcurrencyByBucketOwner = new Map<string, number>();
  private readonly activeConcurrencyByBucketGlobal = new Map<string, number>();
  private readonly recentEvents: AudioApiSecurityEvent[] = [];

  constructor(config?: Partial<AudioApiSecurityConfig>) {
    this.config = resolveAudioApiSecurityConfig(process.env, config);
    // Ephemeral per-process secret for local desktop mode — never persisted or sent to clients.
    this.localEphemeralSecret = crypto.randomBytes(32);
  }

  private now(): number {
    return this.config.nowMs ? this.config.nowMs() : Date.now();
  }

  public isHostedAuthConfigured(): boolean {
    if (typeof this.config.verifyHostedSession === 'function') return true;
    const hasStrongSecret =
      typeof this.config.hostedSessionSecret === 'string' &&
      this.config.hostedSessionSecret.length >= 32;
    const hasIdentityIssuer =
      typeof this.config.hostedTokenIssuer === 'string' &&
      this.config.hostedTokenIssuer.trim().length >= 3;
    return hasStrongSecret && hasIdentityIssuer;
  }

  public revokeLocalSession(sessionId: string): boolean {
    return this.localSessionRegistry.delete(sessionId);
  }

  public getRecentSecurityEvents(): readonly AudioApiSecurityEvent[] {
    return this.recentEvents.slice(-100);
  }

  public recordSecurityEvent(event: Omit<AudioApiSecurityEvent, 'timestampIso' | 'mode'>): void {
    const sanitizedDetails = event.details
      ? (sanitizeDiagnosticRecord(event.details) as Record<string, unknown>)
      : undefined;
    const full: AudioApiSecurityEvent = {
      timestampIso: new Date(this.now()).toISOString(),
      mode: this.config.mode,
      eventType: event.eventType,
      method: sanitizeDiagnosticString(event.method).slice(0, 16),
      path: sanitizeDiagnosticString(event.path).slice(0, 160),
      statusCode: event.statusCode,
      code: sanitizeDiagnosticString(event.code).slice(0, 64),
      ownerId: event.ownerId ? sanitizeDiagnosticString(event.ownerId).slice(0, 128) : undefined,
      details: sanitizedDetails,
    };
    this.recentEvents.push(full);
    if (this.recentEvents.length > 500) {
      this.recentEvents.splice(0, this.recentEvents.length - 500);
    }
    this.config.onSecurityEvent?.(full);
  }

  /**
   * Issues an ephemeral local session token (only allowed in local mode).
   */
  public issueLocalSession(subject = 'local-studio'): {
    readonly token: string;
    readonly sessionId: string;
    readonly expiresAtMs: number;
  } {
    const now = this.now();
    for (const [sid, exp] of this.localSessionRegistry.entries()) {
      if (now > exp) this.localSessionRegistry.delete(sid);
    }
    while (this.localSessionRegistry.size >= 1000) {
      const oldest = this.localSessionRegistry.keys().next().value;
      if (!oldest) break;
      this.localSessionRegistry.delete(oldest);
    }
    const issued = issueSignedAudioSessionToken({
      secret: this.localEphemeralSecret,
      subject,
      mode: 'local',
      audience: this.config.expectedAudience,
      issuer: DEFAULT_LOCAL_TOKEN_ISSUER,
      ttlMs: this.config.localSessionTtlMs,
      nowMs: now,
    });
    this.localSessionRegistry.set(issued.sessionId, issued.expiresAtMs);
    return issued;
  }

  /**
   * Express handler for `POST /api/local-auth/session` (Local Mode only).
   * Requires explicit valid Host + Origin before issuing any ephemeral session token.
   * In Hosted Mode, fails closed with 404.
   */
  public createLocalSessionEndpoint(): RequestHandler {
    return (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      if (this.config.mode !== 'local') {
        this.recordSecurityEvent({
          eventType: 'AUTH_REJECTED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 404,
          code: 'LOCAL_AUTH_DISABLED_IN_HOSTED_MODE',
        });
        res.status(404).json({
          error: 'LOCAL_AUTH_DISABLED_IN_HOSTED_MODE',
          message: 'Local session bootstrap is disabled in hosted mode.',
        });
        return;
      }

      const boundary = this.validateTransportBoundary(req, res, { requireExplicitOrigin: true });
      if (!boundary.ok) return;

      const remoteKey = `local-session:${req.socket?.remoteAddress ?? req.ip ?? 'unknown'}`;
      const rate = this.rateLimiter.checkAndConsume(remoteKey, 60, 60_000, this.now());
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        this.recordSecurityEvent({
          eventType: 'RATE_LIMITED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 429,
          code: 'RATE_LIMIT_EXCEEDED',
        });
        res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'تعداد درخواست‌های ایجاد نشست محلی از حد مجاز فراتر رفت.',
        });
        return;
      }

      const issued = this.issueLocalSession();
      this.recordSecurityEvent({
        eventType: 'LOCAL_SESSION_ISSUED',
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: 200,
        code: 'LOCAL_SESSION_ISSUED',
        ownerId: `local:${issued.sessionId}`,
      });
      res.json({
        ok: true,
        mode: 'local',
        sessionId: issued.sessionId,
        token: issued.token,
        expiresAtMs: issued.expiresAtMs,
      });
    };
  }

  /**
   * Acquires a concurrency slot for an owner and global bucket.
   * Returns a release callback on success, or an error object if ceiling exceeded.
   */
  public acquireConcurrencySlot(params: {
    readonly bucket: string;
    readonly ownerId: string;
    readonly maxPerOwner: number;
    readonly maxGlobal: number;
  }): { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly code: string; readonly message: string } {
    const globalCount = this.activeConcurrencyByBucketGlobal.get(params.bucket) ?? 0;
    if (globalCount >= params.maxGlobal) {
      return {
        ok: false,
        code: 'CONCURRENCY_LIMIT_EXCEEDED',
        message: 'سقف درخواست‌های هم‌زمان سرور تکمیل است؛ لطفاً چند لحظه بعد تلاش کنید.',
      };
    }
    const ownerKey = `${params.bucket}:${params.ownerId}`;
    const ownerCount = this.activeConcurrencyByBucketOwner.get(ownerKey) ?? 0;
    if (ownerCount >= params.maxPerOwner) {
      return {
        ok: false,
        code: 'OWNER_CONCURRENCY_LIMIT_EXCEEDED',
        message: 'سقف درخواست‌های هم‌زمان برای این نشست/کاربر تکمیل است.',
      };
    }

    this.activeConcurrencyByBucketGlobal.set(params.bucket, globalCount + 1);
    this.activeConcurrencyByBucketOwner.set(ownerKey, ownerCount + 1);

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const g = Math.max(0, (this.activeConcurrencyByBucketGlobal.get(params.bucket) ?? 1) - 1);
        if (g === 0) this.activeConcurrencyByBucketGlobal.delete(params.bucket);
        else this.activeConcurrencyByBucketGlobal.set(params.bucket, g);

        const o = Math.max(0, (this.activeConcurrencyByBucketOwner.get(ownerKey) ?? 1) - 1);
        if (o === 0) this.activeConcurrencyByBucketOwner.delete(ownerKey);
        else this.activeConcurrencyByBucketOwner.set(ownerKey, o);
      },
    };
  }

  /**
   * Express middleware enforcing transport boundary, authentication, replay defense, and rate limits.
   * MUST be mounted BEFORE express.raw() / express.json() on protected routes.
   */
  public middleware(options?: AudioApiGuardOptions): RequestHandler {
    const requireAuth = options?.requireAuth ?? true;
    const requireReplay = options?.requireReplayProtection ?? false;

    return async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');

      // 1 & 2. Query token guard + Network/Host/Origin/Cross-Site checks (once per request)
      if (!res.locals.avapardazTransportVerified) {
        if (hasTokenInQueryString(req)) {
          this.recordSecurityEvent({
            eventType: 'TOKEN_IN_QUERY_BLOCKED',
            method: req.method,
            path: req.originalUrl || req.path,
            statusCode: 400,
            code: 'TOKEN_IN_QUERY_FORBIDDEN',
          });
          res.status(400).json({
            error: 'TOKEN_IN_QUERY_FORBIDDEN',
            code: 'TOKEN_IN_QUERY_FORBIDDEN',
            message: 'ارسال توکن یا کلید در Query String ممنوع است.',
          });
          return;
        }

        const boundary = this.validateTransportBoundary(req, res);
        if (!boundary.ok) return;

        if (req.method === 'OPTIONS') {
          res.status(204).end();
          return;
        }
        res.locals.avapardazTransportVerified = true;
      }

      // 3. Authentication & Fail-Closed Hosted Check
      let principal: AudioApiPrincipal | undefined = res.locals.avapardazAuth;
      if (requireAuth) {
        if (!principal) {
          if (this.config.mode === 'hosted' && !this.isHostedAuthConfigured()) {
            const hasBareSecret =
              typeof this.config.hostedSessionSecret === 'string' &&
              this.config.hostedSessionSecret.length >= 32;
            const code = hasBareSecret
              ? 'HOSTED_IDENTITY_PROVIDER_REQUIRED'
              : 'HOSTED_AUTH_NOT_CONFIGURED';
            this.recordSecurityEvent({
              eventType: 'AUTH_REJECTED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: 401,
              code,
            });
            res.status(401).json({
              error: code,
              code,
              message: hasBareSecret
                ? 'Secret مشترک بدون ارائه‌دهنده هویت مستقل برای حالت میزبانی‌شده مجاز نیست؛ دسترسی به‌صورت ایمن مسدود شد.'
                : 'احراز هویت حالت میزبانی‌شده پیکربندی نشده است؛ دسترسی به‌صورت ایمن مسدود شد.',
            });
            return;
          }

          const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
          const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
          if (!bearerToken) {
            this.recordSecurityEvent({
              eventType: 'AUTH_REJECTED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: 401,
              code: 'AUTH_TOKEN_MISSING',
            });
            res.status(401).json({
              error: 'AUTH_TOKEN_MISSING',
              code: 'AUTH_TOKEN_MISSING',
              message: 'توکن احراز هویت معتبر در هدر Authorization الزامی است.',
            });
            return;
          }

          const verification = await this.verifyBearerToken(bearerToken, req);
          if (!verification.ok || !verification.principal) {
            const status = verification.statusCode ?? 401;
            const code = verification.code ?? 'AUTH_TOKEN_INVALID';
            this.recordSecurityEvent({
              eventType: 'AUTH_REJECTED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: status,
              code,
            });
            res.status(status).json({
              error: code,
              code,
              message: verification.message ?? 'احراز هویت نامعتبر است.',
            });
            return;
          }

          principal = verification.principal;
          res.locals.avapardazAuth = principal;
        }

        if (
          options?.requiredScope &&
          !principal.scopes.includes(options.requiredScope) &&
          !principal.scopes.includes('*') &&
          !principal.scopes.includes(`${options.requiredScope.split(':')[0]}:*`)
        ) {
          this.recordSecurityEvent({
            eventType: 'AUTH_REJECTED',
            method: req.method,
            path: req.originalUrl || req.path,
            statusCode: 403,
            code: 'INSUFFICIENT_SCOPE',
            ownerId: principal.ownerId,
          });
          res.status(403).json({
            error: 'INSUFFICIENT_SCOPE',
            code: 'INSUFFICIENT_SCOPE',
            message: 'مجوز لازم برای این عملیات وجود ندارد.',
          });
          return;
        }
      }

      // 4. Replay protection (mandatory when requireReplayProtection=true, or whenever X-Request-Nonce is supplied)
      // Avoid double-consuming the same nonce when both router-level and route-level guards run on one request.
      if (!res.locals.avapardazReplayVerified) {
        const rawNonce =
          typeof req.headers['x-request-nonce'] === 'string' ? req.headers['x-request-nonce'].trim() : '';
        const rawTs =
          typeof req.headers['x-request-timestamp'] === 'string'
            ? req.headers['x-request-timestamp'].trim()
            : '';
        if (requireReplay || rawNonce.length > 0 || rawTs.length > 0) {
          if (!rawNonce || rawNonce.length < 8 || rawNonce.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(rawNonce)) {
            this.recordSecurityEvent({
              eventType: 'REPLAY_BLOCKED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: 400,
              code: 'REPLAY_NONCE_INVALID',
              ownerId: principal?.ownerId,
            });
            res.status(400).json({
              error: 'REPLAY_NONCE_INVALID',
              code: 'REPLAY_NONCE_INVALID',
              message: 'هدر معتبر X-Request-Nonce (حداقل ۸ کاراکتر) برای جلوگیری از Replay الزامی است.',
            });
            return;
          }
          const parsedTs = Number(rawTs);
          const now = this.now();
          if (!rawTs || !Number.isFinite(parsedTs) || Math.abs(now - parsedTs) > this.config.replayWindowMs) {
            this.recordSecurityEvent({
              eventType: 'REPLAY_BLOCKED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: 401,
              code: 'REQUEST_TIMESTAMP_OUT_OF_WINDOW',
              ownerId: principal?.ownerId,
            });
            res.status(401).json({
              error: 'REQUEST_TIMESTAMP_OUT_OF_WINDOW',
              code: 'REQUEST_TIMESTAMP_OUT_OF_WINDOW',
              message: 'زمان درخواست (X-Request-Timestamp) خارج از پنجره مجاز است.',
            });
            return;
          }
          const replayScope = principal?.sessionId ?? req.socket?.remoteAddress ?? 'anon';
          const replayKey = `${replayScope}:${req.method}:${rawNonce}`;
          const fresh = this.replayStore.consume(replayKey, now + this.config.replayWindowMs, now);
          if (!fresh) {
            this.recordSecurityEvent({
              eventType: 'REPLAY_BLOCKED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: 409,
              code: 'REQUEST_REPLAY_DETECTED',
              ownerId: principal?.ownerId,
            });
            res.status(409).json({
              error: 'REQUEST_REPLAY_DETECTED',
              code: 'REQUEST_REPLAY_DETECTED',
              message: 'درخواست تکراری (Replay) شناسایی و مسدود شد.',
            });
            return;
          }
          res.locals.avapardazReplayVerified = true;
        }
      }

      // 5. Rate limiting per owner / remote address
      const bucket = options?.rateLimitBucket ?? 'audio-api';
      const maxReqs = options?.rateLimitMax ?? this.config.rateLimitMaxRequests;
      const winMs = options?.rateLimitWindowMs ?? this.config.rateLimitWindowMs;
      const rateKey = `${bucket}:${principal?.ownerId ?? req.socket?.remoteAddress ?? req.ip ?? 'unknown'}`;
      const rate = this.rateLimiter.checkAndConsume(rateKey, maxReqs, winMs, this.now());
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        this.recordSecurityEvent({
          eventType: 'RATE_LIMITED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 429,
          code: 'RATE_LIMIT_EXCEEDED',
          ownerId: principal?.ownerId,
        });
        res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'تعداد درخواست‌ها از سقف مجاز فراتر رفت؛ لطفاً کمی بعد تلاش کنید.',
        });
        return;
      }

      next();
    };
  }

  private async verifyBearerToken(token: string, req: Request): Promise<VerifiedSessionResult> {
    const now = this.now();
    if (this.config.mode === 'local') {
      const res = verifySignedAudioSessionToken({
        token,
        secret: this.localEphemeralSecret,
        expectedMode: 'local',
        expectedAudience: this.config.expectedAudience,
        expectedIssuer: DEFAULT_LOCAL_TOKEN_ISSUER,
        maxTokenLifetimeMs: this.config.maxTokenLifetimeMs,
        nowMs: now,
      });
      if (!res.ok || !res.principal) return res;
      const registeredExp = this.localSessionRegistry.get(res.principal.sessionId);
      if (registeredExp === undefined || now > registeredExp) {
        this.localSessionRegistry.delete(res.principal.sessionId);
        return {
          ok: false,
          statusCode: 401,
          code: 'AUTH_SESSION_UNKNOWN',
          message: 'نشست محلی ناشناخته یا منقضی شده است.',
        };
      }
      return res;
    }

    // Hosted mode: reject passing raw shared secret directly as a bearer token
    if (
      typeof this.config.hostedSessionSecret === 'string' &&
      this.config.hostedSessionSecret.length > 0 &&
      token === this.config.hostedSessionSecret
    ) {
      return {
        ok: false,
        statusCode: 401,
        code: 'HOSTED_SHARED_SECRET_FORBIDDEN',
        message: 'استفاده مستقیم از کلید مشترک به‌جای توکن هویت مستقل کاربر ممنوع است.',
      };
    }

    if (typeof this.config.verifyHostedSession === 'function') {
      const verified = await this.config.verifyHostedSession(token, req);
      if (!verified.ok || !verified.principal) return verified;
      if (!isValidHostedSubject(verified.principal.subject)) {
        return {
          ok: false,
          statusCode: 401,
          code: 'HOSTED_IDENTITY_REQUIRED',
          message: 'هویت مستقل و معتبر کاربر توسط Verifier تأیید نشد.',
        };
      }
      const derivedOwner = `hosted:${verified.principal.subject.trim()}`;
      return {
        ok: true,
        principal: {
          ...verified.principal,
          mode: 'hosted',
          ownerId: derivedOwner,
          subject: verified.principal.subject.trim(),
        },
      };
    }

    if (
      typeof this.config.hostedSessionSecret === 'string' &&
      this.config.hostedSessionSecret.length >= 32 &&
      typeof this.config.hostedTokenIssuer === 'string' &&
      this.config.hostedTokenIssuer.trim().length >= 3
    ) {
      return verifySignedAudioSessionToken({
        token,
        secret: this.config.hostedSessionSecret,
        expectedMode: 'hosted',
        expectedAudience: this.config.expectedAudience,
        expectedIssuer: this.config.hostedTokenIssuer.trim(),
        maxTokenLifetimeMs: this.config.maxTokenLifetimeMs,
        nowMs: now,
      });
    }

    return {
      ok: false,
      statusCode: 401,
      code:
        typeof this.config.hostedSessionSecret === 'string' && this.config.hostedSessionSecret.length >= 32
          ? 'HOSTED_IDENTITY_PROVIDER_REQUIRED'
          : 'HOSTED_AUTH_NOT_CONFIGURED',
      message: 'احراز هویت مستقل حالت میزبانی‌شده پیکربندی نشده است.',
    };
  }

  private validateTransportBoundary(
    req: Request,
    res: Response,
    options?: { readonly requireExplicitOrigin?: boolean },
  ): { readonly ok: boolean } {
    const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
    const rawForwardedHost =
      typeof req.headers['x-forwarded-host'] === 'string'
        ? req.headers['x-forwarded-host'].split(',')[0].trim().toLowerCase()
        : '';

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : undefined;
    const secFetchSite =
      typeof req.headers['sec-fetch-site'] === 'string'
        ? req.headers['sec-fetch-site'].trim().toLowerCase()
        : undefined;

    if (secFetchSite === 'cross-site' || (options?.requireExplicitOrigin && secFetchSite === 'cross-origin')) {
      this.recordSecurityEvent({
        eventType: 'CROSS_SITE_BLOCKED',
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: 403,
        code: 'CROSS_SITE_REQUEST_BLOCKED',
      });
      res.status(403).json({
        error: 'CROSS_SITE_REQUEST_BLOCKED',
        code: 'CROSS_SITE_REQUEST_BLOCKED',
        message: 'درخواست Cross-Site مسدود شد.',
      });
      return { ok: false };
    }

    let normalizedOrigin = '';
    let originHost = '';
    if (origin && origin.toLowerCase() !== 'null') {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          normalizedOrigin = parsed.origin.toLowerCase();
          originHost = parsed.host.toLowerCase();
        }
      } catch {
        normalizedOrigin = '';
        originHost = '';
      }
    }

    if (this.config.mode === 'local') {
      // 1. Strict Loopback check
      const remoteAddr = req.socket?.remoteAddress ?? req.ip;
      if (!isLoopbackRemoteAddress(remoteAddr)) {
        this.recordSecurityEvent({
          eventType: 'LOOPBACK_BLOCKED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 403,
          code: 'LOOPBACK_REQUIRED',
        });
        res.status(403).json({
          error: 'LOOPBACK_REQUIRED',
          code: 'LOOPBACK_REQUIRED',
          message: 'در حالت محلی فقط اتصالات Loopback (127.0.0.1 / ::1) مجاز هستند.',
        });
        return { ok: false };
      }

      // 2. Strict DNS Rebinding Host check:
      // rawHost MUST be loopback OR explicitly in trustedProxyHosts.
      // NEVER accept an arbitrary non-loopback Host merely because Origin also equals that Host
      // (that exact pattern is how DNS rebinding attacks operate).
      const rawHostIsLoopback = isAllowedLoopbackHostHeader(req.headers.host);
      const rawHostIsExplicitTrustedProxy =
        Boolean(rawHost) && this.config.trustedProxyHosts.includes(rawHost);
      const hostOk = rawHostIsLoopback || rawHostIsExplicitTrustedProxy;

      if (!hostOk) {
        this.recordSecurityEvent({
          eventType: 'DNS_REBINDING_BLOCKED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 403,
          code: 'DNS_REBINDING_BLOCKED',
        });
        res.status(403).json({
          error: 'DNS_REBINDING_BLOCKED',
          code: 'DNS_REBINDING_BLOCKED',
          message: 'هدر Host معتبر نیست (حفاظت در برابر DNS Rebinding).',
        });
        return { ok: false };
      }

      // Same-origin proxy check is only valid when the backend socket received a trusted/loopback Host
      // and a reverse proxy forwarded X-Forwarded-Host matching Origin.
      const proxyForwardedOriginMatch =
        this.config.allowSameOriginProxyHost &&
        Boolean(originHost) &&
        ((Boolean(rawForwardedHost) && originHost === rawForwardedHost) ||
          (rawHostIsExplicitTrustedProxy && originHost === rawHost));

      // 3. Origin check (strictly required on /api/local-auth/session)
      if (options?.requireExplicitOrigin && (!origin || origin.length === 0)) {
        this.recordSecurityEvent({
          eventType: 'ORIGIN_BLOCKED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 403,
          code: 'ORIGIN_REQUIRED_FOR_LOCAL_SESSION',
        });
        res.status(403).json({
          error: 'ORIGIN_REQUIRED_FOR_LOCAL_SESSION',
          code: 'ORIGIN_REQUIRED_FOR_LOCAL_SESSION',
          message: 'ارسال هدر معتبر Origin برای دریافت نشست محلی الزامی است.',
        });
        return { ok: false };
      }

      const originOk =
        (!origin && !options?.requireExplicitOrigin) ||
        (Boolean(origin) && isAllowedLocalHttpOrigin(origin)) ||
        proxyForwardedOriginMatch ||
        (normalizedOrigin.length > 0 && this.config.allowedOrigins.includes(normalizedOrigin));

      if (!originOk) {
        this.recordSecurityEvent({
          eventType: 'ORIGIN_BLOCKED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 403,
          code: 'UNTRUSTED_ORIGIN_BLOCKED',
        });
        res.status(403).json({
          error: 'UNTRUSTED_ORIGIN_BLOCKED',
          code: 'UNTRUSTED_ORIGIN_BLOCKED',
          message: 'مبدأ درخواست (Origin) در فهرست مجاز نیست.',
        });
        return { ok: false };
      }

      if (origin && normalizedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Audio-Filename, X-Decode-Policy, X-Request-Nonce, X-Request-Timestamp',
        );
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      }

      return { ok: true };
    }

    // Hosted Mode Origin & CSRF validation
    // NEVER trust arbitrary X-Forwarded-Host unless explicitly listed in trustedProxyHosts.
    const trustedHostedHost =
      rawForwardedHost && this.config.trustedProxyHosts.includes(rawForwardedHost)
        ? rawForwardedHost
        : rawHost;
    const hostedOriginMatchesHost = Boolean(originHost) && originHost === trustedHostedHost;

    if (origin !== undefined) {
      if (origin.length === 0 || origin.toLowerCase() === 'null') {
        this.recordSecurityEvent({
          eventType: 'ORIGIN_BLOCKED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 403,
          code: 'UNTRUSTED_ORIGIN_BLOCKED',
        });
        res.status(403).json({
          error: 'UNTRUSTED_ORIGIN_BLOCKED',
          code: 'UNTRUSTED_ORIGIN_BLOCKED',
          message: 'مبدأ درخواست (Origin: null) در حالت میزبانی‌شده مجاز نیست.',
        });
        return { ok: false };
      }
      const originInAllowlist =
        normalizedOrigin.length > 0 && this.config.allowedOrigins.includes(normalizedOrigin);
      const originOk =
        this.config.allowedOrigins.length > 0 ? originInAllowlist : hostedOriginMatchesHost;
      if (!originOk) {
        this.recordSecurityEvent({
          eventType: 'ORIGIN_BLOCKED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 403,
          code: 'UNTRUSTED_ORIGIN_BLOCKED',
        });
        res.status(403).json({
          error: 'UNTRUSTED_ORIGIN_BLOCKED',
          code: 'UNTRUSTED_ORIGIN_BLOCKED',
          message: 'مبدأ درخواست (Origin) در حالت میزبانی‌شده مجاز نیست.',
        });
        return { ok: false };
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Audio-Filename, X-Decode-Policy, X-Request-Nonce, X-Request-Timestamp',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }

    return { ok: true };
  }
}
