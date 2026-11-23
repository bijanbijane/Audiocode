import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import {
  forwardPlatformApiCompatibilityRequest,
  normalizeLegacyPlatformLeaseRequestBody,
} from './PlatformApiCompatibilityProxy';

function makeRequest(params: {
  readonly body?: unknown;
  readonly authorization?: string;
  readonly forwardedFor?: string;
} = {}): Request {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    body: params.body,
    aborted: false,
    headers: {
      ...(params.authorization ? { authorization: params.authorization } : {}),
      ...(params.forwardedFor ? { 'x-forwarded-for': params.forwardedFor } : {}),
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return this;
    },
  } as unknown as Request;
}

class FakeResponse {
  public statusCode = 200;
  public body: unknown;
  public writableEnded = false;
  public destroyed = false;
  public headersSent = false;
  public readonly headers = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(value: unknown): this {
    this.body = value;
    this.writableEnded = true;
    return this;
  }

  send(value: unknown): this {
    this.body = value;
    this.writableEnded = true;
    return this;
  }

  set(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  asResponse(): Response {
    return this as unknown as Response;
  }
}

test('legacy raw device fingerprints are hashed before entering the Platform API contract', () => {
  const rawFingerprint = 'legacy-device-fingerprint-01';
  const normalized = normalizeLegacyPlatformLeaseRequestBody({
    userId: 'authenticated-user',
    deviceFingerprint: rawFingerprint,
    displayName: 'Editor',
    plan: 'PRO',
    graceDays: 90,
    unexpectedAdminOverride: true,
  }) as Record<string, unknown>;

  const expectedHash = crypto.createHash('sha256').update(rawFingerprint, 'utf8').digest('hex');
  assert.equal(normalized.deviceFingerprint, rawFingerprint);
  assert.equal(normalized.deviceFingerprintHash, expectedHash);
  assert.equal(normalized.userId, 'authenticated-user');
  assert.equal('plan' in normalized, false);
  assert.equal('graceDays' in normalized, false);
  assert.equal('unexpectedAdminOverride' in normalized, false);

  const malformed = normalizeLegacyPlatformLeaseRequestBody({
    deviceFingerprint: '   ',
    deviceFingerprintHash: 'a'.repeat(64),
  }) as Record<string, unknown>;
  assert.equal(malformed.deviceFingerprint, '   ');
});

test('legacy Express adapter forwards only Bearer auth and bounded JSON to the internal Platform API', async () => {
  const req = makeRequest({
    authorization: 'Bearer user-jwt',
    forwardedFor: '192.0.2.44',
    body: { deviceFingerprintHash: 'a'.repeat(64), displayName: 'Editor' },
  });
  const res = new FakeResponse();
  let calledUrl = '';
  let capturedInit: RequestInit | undefined;

  await forwardPlatformApiCompatibilityRequest(req, res.asResponse(), {
    baseUrl: 'http://platform-internal:4000',
    path: '/api/v1/license/lease',
    method: 'POST',
    fetchImpl: async (input, init) => {
      calledUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ licenseId: 'uuid' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    },
  });

  assert.equal(calledUrl, 'http://platform-internal:4000/api/v1/license/lease');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.redirect, 'manual');
  assert.equal(new Headers(capturedInit?.headers).get('authorization'), 'Bearer user-jwt');
  assert.equal(new Headers(capturedInit?.headers).get('x-forwarded-for'), '192.0.2.44');
  assert.equal(new Headers(capturedInit?.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    deviceFingerprintHash: 'a'.repeat(64),
    displayName: 'Editor',
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(JSON.parse(String(res.body)), { licenseId: 'uuid' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('legacy adapter discards spoofable multi-hop or malformed forwarded IP values', async () => {
  for (const forwardedFor of [
    '192.0.2.44, 10.0.0.1',
    'not-an-ip',
    ' 192.0.2.44',
  ]) {
    const req = makeRequest({ forwardedFor });
    const res = new FakeResponse();
    let capturedHeaders: Headers | undefined;
    await forwardPlatformApiCompatibilityRequest(req, res.asResponse(), {
      baseUrl: 'http://platform-internal:4000',
      path: '/api/v1/crypto/public-key',
      method: 'GET',
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('{}', { status: 200 });
      },
    });
    assert.equal(capturedHeaders?.has('x-forwarded-for'), false);
  }
});

test('legacy adapter fails closed when the internal Platform API origin is absent or unsafe', async () => {
  for (const baseUrl of ['', 'ftp://platform-internal:4000', 'http://user:secret@platform-internal:4000', 'http://platform-internal:4000/platform-api']) {
    const res = new FakeResponse();
    let fetchCalls = 0;
    await forwardPlatformApiCompatibilityRequest(makeRequest(), res.asResponse(), {
      baseUrl,
      path: '/api/v1/crypto/public-key',
      method: 'GET',
      fetchImpl: async () => {
        fetchCalls++;
        return new Response('{}');
      },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(fetchCalls, 0);
  }
});

test('legacy adapter rejects external proxy paths and oversized license payloads before fetch', async () => {
  let fetchCalls = 0;
  for (const path of ['//attacker.example/steal', 'https://attacker.example/steal']) {
    const res = new FakeResponse();
    await forwardPlatformApiCompatibilityRequest(makeRequest(), res.asResponse(), {
      baseUrl: 'http://platform-internal:4000',
      path,
      method: 'GET',
      fetchImpl: async () => {
        fetchCalls++;
        return new Response('{}');
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.body as { error: string }).error, 'PLATFORM_API_PROXY_PATH_INVALID');
  }

  const body = { displayName: 'x'.repeat(70 * 1024) };
  const res = new FakeResponse();
  await forwardPlatformApiCompatibilityRequest(makeRequest({ body }), res.asResponse(), {
    baseUrl: 'http://platform-internal:4000',
    path: '/api/v1/license/lease',
    method: 'POST',
    fetchImpl: async () => {
      fetchCalls++;
      return new Response('{}');
    },
  });
  assert.equal(res.statusCode, 413);
  assert.equal((res.body as { error: string }).error, 'PLATFORM_API_COMPATIBILITY_BODY_TOO_LARGE');
  assert.equal(fetchCalls, 0);
});
