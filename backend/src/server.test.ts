import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  bootstrapBackendServer,
  ProductionFastifyRequestLike,
  ProductionPgPoolLike,
  ProductionServerAppLike,
  SlidingWindowRateLimiter,
} from './server';
import { FastifyReplyLike } from './PlatformBackendServices';

describe('Section 106: Production Backend Server Bootstrap (Rate Limiter, JWT Hook, Health Probes)', () => {
  it('enforces sliding-window rate limits, validates Bearer EdDSA JWT on /api/v1/license/*, and serves /healthz + /readyz', async () => {
    const limiter = new SlidingWindowRateLimiter();
    assert.equal(limiter.isAllowed('127.0.0.1:auth', 2, 60_000), true);
    assert.equal(limiter.isAllowed('127.0.0.1:auth', 2, 60_000), true);
    assert.equal(limiter.isAllowed('127.0.0.1:auth', 2, 60_000), false);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const hooks: {
      onRequest: ((req: ProductionFastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>)[];
      preHandler: ((req: ProductionFastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>)[];
    } = { onRequest: [], preHandler: [] };
    const getRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();

    let poolEnded = false;
    const mockPool: ProductionPgPoolLike = {
      async query<TRow>() {
        return { rows: [{ '?column?': 1 } as unknown as TRow], rowCount: 1 };
      },
      async end() {
        poolEnded = true;
      },
    };

    const mockFastify: ProductionServerAppLike = {
      addHook(name, fn) {
        hooks[name].push(fn);
      },
      get(url, handler) {
        getRoutes.set(url, handler);
      },
      post() {},
      async listen() {},
      async close() {},
      log: { info() {} },
    };

    const boot = await bootstrapBackendServer({
      pgPool: mockPool,
      fastifyApp: mockFastify,
      env: {
        DATABASE_URL: 'postgres://localhost:5432/paudio',
        ED25519_PRIVATE_KEY_PEM: privatePem,
        ED25519_PUBLIC_KEY_PEM: publicPem,
        PAYMENT_WEBHOOK_HMAC_SECRET: 'hmac_secret_106',
      },
    });

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

    // Verify /readyz probe
    const readyRep = makeReply();
    await getRoutes.get('/readyz')!({ params: {}, headers: {} }, readyRep.reply);
    assert.equal(readyRep.getStatus(), 200);
    assert.equal(readyRep.getPayload().status, 'ready');

    // Verify preHandler blocks unauthenticated /api/v1/license/lease
    const unauthRep = makeReply();
    await hooks.preHandler[0](
      { ip: '10.0.0.1', url: '/api/v1/license/lease', headers: {} },
      unauthRep.reply,
    );
    assert.equal(unauthRep.getStatus(), 401);

    // Verify preHandler accepts valid EdDSA JWT
    const validJwt = boot.authAndPayment.issueEdDsaJwt({
      sub: 'usr_prod_1',
      email: 'prod@studio.ir',
    });
    const authReq: ProductionFastifyRequestLike = {
      ip: '10.0.0.1',
      url: '/api/v1/license/lease',
      headers: { authorization: `Bearer ${validJwt}` },
    };
    const authRep = makeReply();
    await hooks.preHandler[0](authReq, authRep.reply);
    assert.equal(authReq.authenticatedUserId, 'usr_prod_1');

    await boot.shutdown('SIGTERM');
    assert.equal(poolEnded, true);
  });
});
