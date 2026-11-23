import crypto from 'node:crypto';
import type { Request, Response } from 'express';

export interface PlatformApiCompatibilityProxyOptions {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const MAX_COMPATIBILITY_BODY_BYTES = 64 * 1024;
const DEFAULT_PROXY_TIMEOUT_MS = 15_000;
const MAX_LEGACY_DEVICE_FINGERPRINT_CHARS = 512;

/**
 * Convert the legacy raw device fingerprint into the SHA-256 value stored by
 * Platform API device-seat enforcement. The raw value is retained only in the
 * signed compatibility payload when the authenticated lease is issued.
 */
export function normalizeLegacyPlatformLeaseRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  // Preserve only compatibility fields that Fastify explicitly validates or consumes.
  // Client-supplied plan/grace values and arbitrary extra properties are never forwarded.
  if (record.userId !== undefined) normalized.userId = record.userId;
  if (record.displayName !== undefined) normalized.displayName = record.displayName;
  if (typeof record.deviceFingerprintHash === 'string') {
    normalized.deviceFingerprintHash = record.deviceFingerprintHash;
  }
  if (record.deviceFingerprint !== undefined) {
    // Preserve even malformed legacy values so Fastify can reject them explicitly.
    // Never silently drop a raw identifier and issue a lease bound only to its hash.
    normalized.deviceFingerprint = record.deviceFingerprint;
    if (typeof record.deviceFingerprint === 'string') {
      const rawFingerprint = record.deviceFingerprint.trim();
      if (
        rawFingerprint.length > 0 &&
        rawFingerprint.length <= MAX_LEGACY_DEVICE_FINGERPRINT_CHARS &&
        typeof record.deviceFingerprintHash !== 'string'
      ) {
        normalized.deviceFingerprint = rawFingerprint;
        normalized.deviceFingerprintHash = crypto
          .createHash('sha256')
          .update(rawFingerprint, 'utf8')
          .digest('hex');
      }
    }
  }

  return normalized;
}

function sendProxyError(res: Response, status: number, error: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.status(status).json({ error });
}

/**
 * Transitional adapter for legacy Express API paths.
 *
 * The destination is an operator-controlled internal origin, never a request
 * parameter. Only selected JSON metadata/license requests use this adapter.
 * Audio uploads, local ASR, Companion, and Smart Audio Edit never pass through it.
 */
export async function forwardPlatformApiCompatibilityRequest(
  req: Request,
  res: Response,
  options: PlatformApiCompatibilityProxyOptions,
): Promise<void> {
  const rawBaseUrl = options.baseUrl ?? process.env.PLATFORM_API_INTERNAL_ORIGIN;
  if (!rawBaseUrl?.trim()) {
    sendProxyError(res, 503, 'PLATFORM_API_INTERNAL_ORIGIN_REQUIRED');
    return;
  }

  let base: URL;
  try {
    base = new URL(rawBaseUrl);
  } catch {
    sendProxyError(res, 503, 'PLATFORM_API_INTERNAL_ORIGIN_INVALID');
    return;
  }
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.pathname !== '/' ||
    base.search.length > 0 ||
    base.hash.length > 0
  ) {
    sendProxyError(res, 503, 'PLATFORM_API_INTERNAL_ORIGIN_INVALID');
    return;
  }

  if (!options.path.startsWith('/') || options.path.startsWith('//')) {
    sendProxyError(res, 400, 'PLATFORM_API_PROXY_PATH_INVALID');
    return;
  }

  const targetUrl = new URL(options.path, base.origin);
  if (targetUrl.origin !== base.origin) {
    sendProxyError(res, 400, 'PLATFORM_API_PROXY_PATH_INVALID');
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS, 30_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onRequestAborted = (): void => controller.abort();
  const onResponseClosed = (): void => {
    if (!res.writableEnded) controller.abort();
  };

  req.on('aborted', onRequestAborted);
  res.on('close', onResponseClosed);

  try {
    const headers = new Headers({ Accept: 'application/json' });
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && authorization.length > 0) {
      headers.set('Authorization', authorization);
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      signal: controller.signal,
      redirect: 'manual',
    };

    if (options.method === 'POST') {
      const body = JSON.stringify(req.body ?? {});
      if (Buffer.byteLength(body, 'utf8') > MAX_COMPATIBILITY_BODY_BYTES) {
        sendProxyError(res, 413, 'PLATFORM_API_COMPATIBILITY_BODY_TOO_LARGE');
        return;
      }
      headers.set('Content-Type', 'application/json');
      init.body = body;
    }

    const upstream = await fetchImpl(targetUrl, init);
    const responseBody = await upstream.text();
    if (res.writableEnded || res.destroyed) return;

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    const cacheControl = upstream.headers.get('cache-control');
    const retryAfter = upstream.headers.get('retry-after');
    if (contentType) res.set('Content-Type', contentType);
    if (cacheControl) res.set('Cache-Control', cacheControl);
    if (retryAfter) res.set('Retry-After', retryAfter);
    res.send(responseBody);
  } catch {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    sendProxyError(
      res,
      controller.signal.aborted ? 504 : 502,
      controller.signal.aborted
        ? 'PLATFORM_API_UPSTREAM_TIMEOUT'
        : 'PLATFORM_API_UPSTREAM_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timeout);
    req.off('aborted', onRequestAborted);
    res.off('close', onResponseClosed);
  }
}
