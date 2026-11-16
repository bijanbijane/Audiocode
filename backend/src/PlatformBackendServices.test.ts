import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PlatformBackendServices,
} from './PlatformBackendServices';

test('Section 100: PlatformBackendServices issues Ed25519-signed license leases and enforces V1 local-only ASR policy', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const service = new PlatformBackendServices(
    {
      query: async <TRow>(sql: string): Promise<{ rows: TRow[]; rowCount: number | null }> => {
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
        return { rows: [], rowCount: 1 };
      },
    },
    {
      modelStorageRootDir: '/tmp',
      ed25519PrivateKeyPem: privatePem,
      keyId: 'ed25519_prod_k1',
      cdnBaseUrl: 'https://cdn.avapardaz.ir',
      enableServerSideAsrInference: false,
    },
  );

  const postRoutes = new Map<
    string,
    (
      req: { body: unknown; headers: Record<string, string | undefined> },
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

  await postRoutes.get('/api/v1/license/lease')!(
    {
      body: { userId: 'usr_100', deviceFingerprintHash: 'fp_hash_abc' },
      headers: {},
    },
    mockReply,
  );

  assert.equal(statusCode, 200);
  const env = sentBody as {
    payloadCanonicalBase64: string;
    ed25519SignatureHex: string;
  };
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
