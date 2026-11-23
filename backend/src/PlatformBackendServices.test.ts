import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { OfflineCryptoVerifier } from '../../src/security/OfflineCryptoVerifier';
import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PgPoolLike,
  PlatformBackendServices,
} from './PlatformBackendServices';

const VALID_FP_1 = '1'.repeat(64);

test('Section 100: PlatformBackendServices issues Ed25519-signed license leases using authenticatedUserId inside a pinned transaction and enforces V1 local-only ASR policy', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const txLog: string[] = [];
  const runQuery = async <TRow>(
    sql: string,
  ): Promise<{ rows: TRow[]; rowCount: number | null }> => {
    txLog.push(sql.trim().split('\n')[0]);
    if (sql.includes('FROM users WHERE id = $1')) {
      return { rows: [{ id: 'usr_100' } as unknown as TRow], rowCount: 1 };
    }
    if (sql.includes('FROM subscriptions')) {
      return {
        rows: [
          {
            id: 'sub_1',
            plan_tier: 'PRO_MONTHLY',
            current_period_end: new Date(Date.now() + 7 * 86400 * 1000),
            offline_grace_hours: 72,
          } as unknown as TRow,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT lease_id, device_fingerprint_hash')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  };

  let released = false;
  const mockDb: PgPoolLike = {
    query: runQuery,
    async connect() {
      return {
        query: runQuery,
        release() {
          released = true;
        },
      };
    },
  };

  const service = new PlatformBackendServices(mockDb, {
    modelStorageRootDir: '/tmp',
    ed25519PrivateKeyPem: privatePem,
    keyId: 'ed25519_prod_k1',
    cdnBaseUrl: 'https://cdn.avapardaz.ir',
    enableServerSideAsrInference: false,
  });

  const postRoutes = new Map<
    string,
    (
      req: {
        authenticatedUserId?: string;
        body: unknown;
        headers: Record<string, string | undefined>;
      },
      reply: FastifyReplyLike,
    ) => Promise<unknown>
  >();
  const getRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();

  const mockFastify: FastifyInstanceLike = {
    get: (url, handler) => {
      getRoutes.set(url, handler as never);
    },
    post: (url, handler) => {
      postRoutes.set(url, handler as never);
    },
  };

  service.registerAllRoutes(mockFastify);

  let statusCode = 200;
  let sentBody: unknown = null;
  const mockReply: FastifyReplyLike = {
    status(c) {
      statusCode = c;
      return this;
    },
    header() {
      return this;
    },
    send(b) {
      sentBody = b;
      return b;
    },
  };

  // Public key discovery uses the same SPKI base64 format as the current browser verifier.
  await getRoutes.get('/api/v1/crypto/public-key')!(
    { params: {}, query: {}, headers: {} },
    mockReply,
  );
  const publicKeyInfo = sentBody as {
    publicKeySpkiBase64: string;
    algorithm: string;
    keyVersion: number;
    keyId: string;
  };
  assert.equal(publicKeyInfo.algorithm, 'Ed25519');
  assert.equal(publicKeyInfo.keyVersion, 1);
  assert.equal(publicKeyInfo.keyId, 'ed25519_prod_k1');

  // Reject unauthenticated call directly (defense-in-depth)
  await postRoutes.get('/api/v1/license/lease')!(
    {
      body: { deviceFingerprintHash: VALID_FP_1 },
      headers: {},
    },
    mockReply,
  );
  assert.equal(statusCode, 401);

  // Reject cross-account userId mismatch
  statusCode = 200;
  await postRoutes.get('/api/v1/license/lease')!(
    {
      authenticatedUserId: 'usr_100',
      body: { userId: 'usr_other', deviceFingerprintHash: VALID_FP_1 },
      headers: {},
    },
    mockReply,
  );
  assert.equal(statusCode, 403);

  // Succeed for authenticated user inside pinned transaction
  statusCode = 200;
  await postRoutes.get('/api/v1/license/lease')!(
    {
      authenticatedUserId: 'usr_100',
      body: { deviceFingerprintHash: VALID_FP_1 },
      headers: {},
    },
    mockReply,
  );

  assert.equal(statusCode, 200);
  assert.equal(released, true);
  assert.equal(txLog[0], 'BEGIN');
  assert.equal(txLog[txLog.length - 1], 'COMMIT');

  const env = sentBody as {
    payload: {
      licenseId: string;
      userId: string;
      planTier: string;
      plan: string;
      issuedAtMs: number;
      offlineGraceExpiresAtMs: number;
      offlineGraceExpiresAtUnixSec: number;
      subscriptionExpiresAtUnixSec: number;
      allowedModelTiers: readonly string[];
      deviceFingerprint: string;
    };
    payloadCanonicalBase64: string;
    ed25519SignatureHex: string;
    payloadBase64: string;
    signatureBase64: string;
    algorithm: 'Ed25519';
    keyVersion: number;
    decodedPreview: unknown;
  };
  assert.equal(env.payload.userId, 'usr_100');
  assert.equal(env.payload.planTier, 'PRO_MONTHLY');
  assert.equal(env.payload.plan, 'PRO');
  assert.equal(env.payload.deviceFingerprint, VALID_FP_1);
  assert.match(env.payload.licenseId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(env.payload.allowedModelTiers, ['GROUP_A', 'GROUP_B']);

  // The old 72-hour offline_grace_hours value must not truncate a paid 7-day subscription.
  assert.equal(env.payload.offlineGraceExpiresAtUnixSec, env.payload.subscriptionExpiresAtUnixSec);
  assert.equal(env.payload.offlineGraceExpiresAtMs, env.payload.subscriptionExpiresAtUnixSec * 1000);

  const verified = crypto.verify(
    null,
    Buffer.from(env.payloadCanonicalBase64, 'utf8'),
    publicKey,
    Buffer.from(env.ed25519SignatureHex, 'hex'),
  );
  assert.equal(verified, true);
  assert.equal(env.payloadBase64, env.payloadCanonicalBase64);
  assert.equal(env.algorithm, 'Ed25519');
  assert.equal(env.signatureBase64, Buffer.from(env.ed25519SignatureHex, 'hex').toString('base64'));

  // Verify the exact response with the existing browser OfflineCryptoVerifier four days later.
  const verifyAtMs = Date.now();
  const clientResult = await OfflineCryptoVerifier.verifyOfflineLicense(
    {
      payloadBase64: env.payloadBase64,
      signatureBase64: env.signatureBase64,
      algorithm: env.algorithm,
      keyVersion: env.keyVersion,
      decodedPreview: env.decodedPreview as never,
    },
    publicKeyInfo.publicKeySpkiBase64,
    verifyAtMs,
    verifyAtMs + 4 * 24 * 60 * 60 * 1000,
  );
  assert.equal(clientResult.isValid, true);
  assert.equal(clientResult.reason, 'VALID');
  assert.equal(clientResult.payload?.plan, 'PRO');
  assert.deepEqual(clientResult.allowedModelTiers, ['GROUP_A', 'GROUP_B']);

  await postRoutes.get('/api/v1/asr/transcribe-chunk')!(
    { body: {}, headers: {} },
    mockReply,
  );
  assert.equal(statusCode, 501);
});
