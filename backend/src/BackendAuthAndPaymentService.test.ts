import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BackendAuthAndPaymentService } from './BackendAuthAndPaymentService';
import { FastifyInstanceLike, FastifyReplyLike, PgPoolLike } from './PlatformBackendServices';

describe('Section 103: BackendAuthAndPaymentService (scrypt + EdDSA JWT + Idempotent Webhook)', () => {
  it('registers user with scrypt, logs in with EdDSA JWT, and prevents duplicate webhook subscription extensions', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const hmacSecret = 'test_zarinpal_webhook_secret_key_2026';

    const users = new Map<string, { id: string; password_hash: string; status: string }>();
    const seenTransactions = new Set<string>();
    let subscriptionInsertCount = 0;

    const mockDb: PgPoolLike = {
      async query<TRow>(sql: string, params: unknown[] = []) {
        if (sql.includes('INSERT INTO users')) {
          const email = String(params[0]);
          const hash = String(params[1]);
          if (users.has(email)) throw new Error('UNIQUE_VIOLATION');
          const id = 'usr_103';
          users.set(email, { id, password_hash: hash, status: 'ACTIVE' });
          return { rows: [{ id } as unknown as TRow], rowCount: 1 };
        }
        if (sql.includes('SELECT id, password_hash, status FROM users')) {
          const u = users.get(String(params[0]));
          return { rows: u ? ([u] as unknown as TRow[]) : [], rowCount: u ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO payment_transactions')) {
          const key = `${params[1]}:${params[2]}`;
          if (seenTransactions.has(key)) {
            return { rows: [], rowCount: 0 };
          }
          seenTransactions.add(key);
          return { rows: [{ id: 'tx_001' } as unknown as TRow], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO subscriptions')) {
          subscriptionInsertCount++;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const postRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
    const mockFastify: FastifyInstanceLike = {
      get() {},
      post(url, handler) {
        postRoutes.set(url, handler);
      },
    };

    const service = new BackendAuthAndPaymentService(mockDb, {
      ed25519PrivateKeyPem: privatePem,
      ed25519PublicKeyPem: publicPem,
      paymentWebhookHmacSecret: hmacSecret,
    });
    service.registerRoutes(mockFastify);

    const makeReply = () => {
      let statusCode = 200;
      let payload: any = null;
      const reply: FastifyReplyLike = {
        status(c) {
          statusCode = c;
          return reply;
        },
        header() {
          return reply;
        },
        send(p) {
          payload = p;
          return p;
        },
      };
      return { reply, getStatus: () => statusCode, getPayload: () => payload };
    };

    // 1. Register user
    const regRep = makeReply();
    await postRoutes.get('/api/v1/auth/register')!(
      { body: { email: 'Editor@Studio.ir', password: 'StrongPassword2026!' }, headers: {} },
      regRep.reply,
    );
    assert.equal(regRep.getStatus(), 201);
    const token = regRep.getPayload().accessToken;
    const claims = service.verifyEdDsaJwt(token);
    assert.equal(claims.sub, 'usr_103');
    assert.equal(claims.email, 'editor@studio.ir');

    // 2. Login user
    const loginRep = makeReply();
    await postRoutes.get('/api/v1/auth/login')!(
      { body: { email: 'editor@studio.ir', password: 'StrongPassword2026!' }, headers: {} },
      loginRep.reply,
    );
    assert.equal(loginRep.getStatus(), 200);
    assert.equal(loginRep.getPayload().userId, 'usr_103');

    // 3. Process payment webhook twice (idempotency check)
    const webhookBody = {
      gatewayName: 'ZARINPAL',
      gatewayTxId: 'A00000000000000000000000000123456',
      userId: 'usr_103',
      planTier: 'PRO_ANNUAL' as const,
      amountMinorUnits: 25000000,
      currency: 'IRR',
      status: 'PAID' as const,
    };
    const sigHex = crypto
      .createHmac('sha256', hmacSecret)
      .update(JSON.stringify(webhookBody), 'utf8')
      .digest('hex');

    const whRep1 = makeReply();
    await postRoutes.get('/api/v1/payments/webhook')!(
      { body: webhookBody, headers: { 'x-gateway-signature': sigHex } },
      whRep1.reply,
    );
    assert.equal(whRep1.getPayload().processed, true);
    assert.equal(subscriptionInsertCount, 1);

    const whRep2 = makeReply();
    await postRoutes.get('/api/v1/payments/webhook')!(
      { body: webhookBody, headers: { 'x-gateway-signature': sigHex } },
      whRep2.reply,
    );
    assert.equal(whRep2.getPayload().processed, false);
    assert.equal(whRep2.getPayload().idempotentDuplicate, true);
    assert.equal(subscriptionInsertCount, 1, 'Duplicate webhook must not extend subscription twice');
  });
});
