import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  isSandboxTokenStrong,
  resolveSandboxRuntimePolicy,
  SANDBOX_REQUESTED_WITH_HEADER,
  SandboxHttpAccessGuard,
} from './SandboxHttpAccessGuard';

const STRONG_TOKEN = 'Sbx9!mK2vP7rT4xQ1zL8cN5wF3hJ6yD0eA';

function makeMockReq(overrides: {
  method?: string;
  headers?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  ip?: string;
} = {}): Request {
  return {
    method: overrides.method ?? 'GET',
    headers: {
      host: 'localhost:3000',
      ...(overrides.headers ?? {}),
    },
    query: overrides.query ?? {},
    ip: overrides.ip ?? '127.0.0.1',
    socket: { remoteAddress: overrides.ip ?? '127.0.0.1' },
  } as unknown as Request;
}

describe('AVP-012 SandboxHttpAccessGuard Unit Security Invariants', () => {
  it('throws startup configuration error when NODE_ENV=production and ENABLE_INTELLIGENCE_SANDBOX_ROUTES=true', () => {
    expect(() =>
      resolveSandboxRuntimePolicy({
        NODE_ENV: 'production',
        ENABLE_INTELLIGENCE_SANDBOX_ROUTES: 'true',
        INTELLIGENCE_SANDBOX_TOKEN: STRONG_TOKEN,
      })
    ).toThrow(/CONFIGURATION_ERROR/);

    const prodDefault = resolveSandboxRuntimePolicy({
      NODE_ENV: 'production',
      ENABLE_INTELLIGENCE_SANDBOX_ROUTES: 'false',
    });
    expect(prodDefault.enableSandboxRoutes).toBe(false);
  });

  it('rejects weak, short, whitespace, repeated-char, and placeholder tokens', () => {
    expect(isSandboxTokenStrong(undefined)).toBe(false);
    expect(isSandboxTokenStrong('too-short')).toBe(false);
    expect(isSandboxTokenStrong('replace-me-with-a-very-long-32-byte-token')).toBe(false);
    expect(isSandboxTokenStrong('sandbox-token-01234567890123456789')).toBe(false);
    expect(isSandboxTokenStrong('a'.repeat(40))).toBe(false);
    expect(isSandboxTokenStrong('has spaces inside 12345678901234567890')).toBe(false);
    expect(isSandboxTokenStrong(STRONG_TOKEN)).toBe(true);
  });

  it('validates Bearer token in constant time, rejects query-string tokens, and throttles 5 failures -> 429', () => {
    let now = 1_700_000_000_000;
    const guard = new SandboxHttpAccessGuard({
      nodeEnv: 'development',
      enableSandboxRoutes: true,
      sandboxToken: STRONG_TOKEN,
      nowFn: () => now,
    });

    // Reject query-string token even if valid Bearer also present
    const queryReject = guard.authenticateRequest(
      makeMockReq({
        headers: { authorization: `Bearer ${STRONG_TOKEN}` },
        query: { token: STRONG_TOKEN },
        ip: '10.0.0.1',
      })
    );
    expect(queryReject.ok).toBe(false);
    if (!queryReject.ok) expect(queryReject.status).toBe(401);

    // 5 failed attempts from IP 10.0.0.2 -> 6th attempt returns 429
    for (let i = 0; i < 5; i += 1) {
      const r = guard.authenticateRequest(
        makeMockReq({
          headers: { authorization: `Bearer wrong-len-${i}` },
          ip: '10.0.0.2',
        })
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(401);
    }
    const sixth = guard.authenticateRequest(
      makeMockReq({
        headers: { authorization: `Bearer ${STRONG_TOKEN}` },
        ip: '10.0.0.2',
      })
    );
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.status).toBe(429);

    // After 15-minute window expires, valid token succeeds
    now += 16 * 60 * 1000;
    const recovered = guard.authenticateRequest(
      makeMockReq({
        headers: { authorization: `Bearer ${STRONG_TOKEN}` },
        ip: '10.0.0.2',
      })
    );
    expect(recovered.ok).toBe(true);
  });

  it('enforces same-origin checks, ignores spoofed X-Forwarded-Host, and requires X-Requested-With on mutations', () => {
    const guard = new SandboxHttpAccessGuard({
      nodeEnv: 'development',
      enableSandboxRoutes: true,
      sandboxToken: STRONG_TOKEN,
    });

    // Sec-Fetch-Site: cross-site -> 403
    const crossSite = guard.authenticateRequest(
      makeMockReq({
        method: 'GET',
        headers: {
          authorization: `Bearer ${STRONG_TOKEN}`,
          'sec-fetch-site': 'cross-site',
        },
      })
    );
    expect(crossSite.ok).toBe(false);
    if (!crossSite.ok) expect(crossSite.status).toBe(403);

    // Mismatched Origin even with spoofed X-Forwarded-Host -> 403
    const spoofedOrigin = guard.authenticateRequest(
      makeMockReq({
        method: 'POST',
        headers: {
          authorization: `Bearer ${STRONG_TOKEN}`,
          host: 'localhost:3000',
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          'x-requested-with': SANDBOX_REQUESTED_WITH_HEADER,
        },
      })
    );
    expect(spoofedOrigin.ok).toBe(false);
    if (!spoofedOrigin.ok) expect(spoofedOrigin.status).toBe(403);

    // Missing X-Requested-With on POST -> 403
    const missingHeader = guard.authenticateRequest(
      makeMockReq({
        method: 'POST',
        headers: {
          authorization: `Bearer ${STRONG_TOKEN}`,
          origin: 'http://localhost:3000',
        },
      })
    );
    expect(missingHeader.ok).toBe(false);
    if (!missingHeader.ok) expect(missingHeader.status).toBe(403);

    // Valid same-origin POST with X-Requested-With -> ok
    const validPost = guard.authenticateRequest(
      makeMockReq({
        method: 'POST',
        headers: {
          authorization: `Bearer ${STRONG_TOKEN}`,
          origin: 'http://localhost:3000',
          'x-requested-with': SANDBOX_REQUESTED_WITH_HEADER,
          'content-type': 'application/json',
          'content-length': '2',
        },
      })
    );
    expect(validPost.ok).toBe(true);
  });
});
