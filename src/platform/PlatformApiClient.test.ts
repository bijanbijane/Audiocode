import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlatformApiClient,
  PlatformApiHttpError,
} from './PlatformApiClient';

test('PlatformApiClient sends login to the isolated same-origin prefix', async () => {
  let calledUrl = '';
  let capturedInit: RequestInit | undefined;
  const client = new PlatformApiClient({
    fetchImpl: async (input, init) => {
      calledUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ userId: 'user-1', accessToken: 'jwt-test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const session = await client.login('user@example.com', 'long-password');
  assert.equal(calledUrl, '/platform-api/api/v1/auth/login');
  assert.equal(session.userId, 'user-1');
  assert.equal(session.accessToken, 'jwt-test');
  assert.equal(capturedInit?.credentials, 'same-origin');
  assert.equal(capturedInit?.method, 'POST');
});

test('public key and model manifest use the isolated prefix and validate the model identifier', async () => {
  const urls: string[] = [];
  const client = new PlatformApiClient({
    fetchImpl: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ publicKeySpkiBase64: 'key', algorithm: 'Ed25519', keyVersion: 1, keyId: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.getPublicKeyInfo();
  await client.getSignedModelManifest('model-fa_v1');
  assert.deepEqual(urls, [
    '/platform-api/api/v1/crypto/public-key',
    '/platform-api/api/v1/models/model-fa_v1/manifest',
  ]);

  assert.throws(
    () => client.getSignedModelManifest('../other'),
    /PLATFORM_API_MODEL_ID_INVALID/,
  );
});

test('Platform API base path rejects external and protocol-relative URLs', () => {
  assert.throws(
    () => new PlatformApiClient({ basePath: 'https://attacker.example' }),
    /PLATFORM_API_BASE_PATH_MUST_BE_SAME_ORIGIN/,
  );
  assert.throws(
    () => new PlatformApiClient({ basePath: '//attacker.example' }),
    /PLATFORM_API_BASE_PATH_MUST_BE_SAME_ORIGIN/,
  );
});

test('model catalogue uses the isolated Platform API prefix', async () => {
  let calledUrl = '';
  const client = new PlatformApiClient({
    fetchImpl: async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await client.getModelCatalog();
  assert.equal(calledUrl, '/platform-api/api/v1/models/catalog');
  assert.deepEqual(result.models, []);
});

test('license issuance sends only a hashed device identity and bearer token, never plan or user override', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const client = new PlatformApiClient({
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ payloadBase64: 'a', signatureBase64: 'b', algorithm: 'Ed25519', keyVersion: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.issueOfflineLicenseLease('valid-jwt', 'A'.repeat(64), 'Editor');
  assert.equal(capturedUrl, '/platform-api/api/v1/license/lease');
  assert.equal(new Headers(capturedInit?.headers).get('authorization'), 'Bearer valid-jwt');
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.deviceFingerprintHash, 'a'.repeat(64));
  assert.equal(body.displayName, 'Editor');
  assert.equal('userId' in body, false);
  assert.equal('plan' in body, false);
  assert.equal('graceDays' in body, false);
});

test('invalid device hash is rejected before a network request', async () => {
  let calls = 0;
  const client = new PlatformApiClient({
    fetchImpl: async () => {
      calls++;
      return new Response('{}', { status: 200 });
    },
  });
  assert.throws(
    () => client.issueOfflineLicenseLease('valid-jwt', 'not-a-sha256'),
    /PLATFORM_API_DEVICE_FINGERPRINT_HASH_INVALID/,
  );
  assert.equal(calls, 0);
});

test('non-2xx responses preserve the Platform API error code and status', async () => {
  const client = new PlatformApiClient({
    fetchImpl: async () => new Response(JSON.stringify({
      error: 'NO_ACTIVE_SUBSCRIPTION',
      messageFa: 'اشتراک فعالی وجود ندارد.',
    }), { status: 403 }),
  });

  await assert.rejects(
    () => client.issueOfflineLicenseLease('valid-jwt', 'f'.repeat(64)),
    (error: unknown) =>
      error instanceof PlatformApiHttpError &&
      error.status === 403 &&
      error.code === 'NO_ACTIVE_SUBSCRIPTION',
  );
});
