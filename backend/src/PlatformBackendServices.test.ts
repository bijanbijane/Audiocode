import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

  const mockFastify: FastifyInstanceLike = {
    get: () => {},
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
    payload: { userId: string; planTier: string };
    payloadCanonicalBase64: string;
    ed25519SignatureHex: string;
  };
  assert.equal(env.payload.userId, 'usr_100');
  assert.equal(env.payload.planTier, 'PRO_MONTHLY');
  const verified = crypto.verify(
    null,
    Buffer.from(env.payloadCanonicalBase64, 'utf8'),
    publicKey,
    Buffer.from(env.ed25519SignatureHex, 'hex'),
  );
  assert.equal(verified, true);

  await postRoutes.get('/api/v1/asr/transcribe-chunk')!(
    { body: {}, headers: {} },
    mockReply,
  );
  assert.equal(statusCode, 501);
});
