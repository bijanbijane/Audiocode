import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PgPoolLike,
  PlatformBackendServices,
} from './PlatformBackendServices';
import { BackendAuthAndPaymentService } from './BackendAuthAndPaymentService';

/**
 * In-memory Sliding-Window Rate Limiter for brute-force and CDN abuse protection
 */
export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  public isAllowed(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || now > existing.resetAtMs) {
      this.buckets.set(key, { count: 1, resetAtMs: now + windowMs });
      return true;
    }
    if (existing.count >= maxRequests) {
      return false;
    }
    existing.count++;
    return true;
  }
}

export interface ProductionFastifyRequestLike {
  readonly ip: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  authenticatedUserId?: string;
}

export interface ProductionServerAppLike extends FastifyInstanceLike {
  addHook(
    hookName: 'onRequest' | 'preHandler',
    hookFn: (request: ProductionFastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>,
  ): void;
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
  log: {
    info(msg: string): void;
  };
}

export interface ProductionPgPoolLike extends PgPoolLike {
  end(): Promise<void>;
}

/**
 * Section 106: Production Backend Server Bootstrap (Rate Limiter, EdDSA JWT Middleware, /healthz, /readyz, Graceful Shutdown)
 */
export async function bootstrapBackendServer(deps?: {
  pgPool?: ProductionPgPoolLike;
  fastifyApp?: ProductionServerAppLike;
  env?: Record<string, string | undefined>;
}) {
  const env = deps?.env ?? process.env;
  const port = Number(env.PORT ?? 4000);
  const host = env.HOST ?? '0.0.0.0';

  const databaseUrl = env.DATABASE_URL;
  const ed25519PrivateKeyPem = env.ED25519_PRIVATE_KEY_PEM;
  const ed25519PublicKeyPem = env.ED25519_PUBLIC_KEY_PEM;
  const paymentWebhookHmacSecret = env.PAYMENT_WEBHOOK_HMAC_SECRET;

  if (
    !databaseUrl ||
    !ed25519PrivateKeyPem ||
    !ed25519PublicKeyPem ||
    !paymentWebhookHmacSecret
  ) {
    throw new Error(
      'BACKEND_ENV_MISSING: متغیرهای حیاتی DATABASE_URL، کلیدهای Ed25519 یا سکرت پرداخت تنظیم نشده‌اند.',
    );
  }

  let pgPool = deps?.pgPool;
  if (!pgPool) {
    const pgModName = 'pg';
    const pgMod = (await import(/* @vite-ignore */ pgModName)) as {
      Pool: new (opts: Record<string, unknown>) => ProductionPgPoolLike;
    };
    pgPool = new pgMod.Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  let fastify = deps?.fastifyApp;
  if (!fastify) {
    const fastifyModName = 'fastify';
    const fastifyMod = (await import(/* @vite-ignore */ fastifyModName)) as {
      default: (opts: Record<string, unknown>) => ProductionServerAppLike;
    };
    fastify = fastifyMod.default({
      logger: {
        level: env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers["x-gateway-signature"]'],
      },
      trustProxy: true,
    });
  }

  const rateLimiter = new SlidingWindowRateLimiter();

  // 1. Global Sliding-Window Rate Limiting Hook
  fastify.addHook('onRequest', async (request, reply) => {
    const clientIp = request.ip;
    const isAuthRoute = request.url.startsWith('/api/v1/auth/');
    const limit = isAuthRoute ? 15 : 180; // Stricter limit on auth routes
    if (!rateLimiter.isAllowed(`${clientIp}:${isAuthRoute ? 'auth' : 'api'}`, limit, 60_000)) {
      return reply.status(429).send({
        error: 'RATE_LIMIT_EXCEEDED',
        messageFa: 'تعداد درخواست‌های شما بیش از حد مجاز است؛ لطفاً لحظاتی صبر کنید.',
      });
    }
  });

  const authAndPayment = new BackendAuthAndPaymentService(pgPool, {
    ed25519PrivateKeyPem,
    ed25519PublicKeyPem,
    paymentWebhookHmacSecret,
  });

  const platformServices = new PlatformBackendServices(pgPool, {
    modelStorageRootDir: env.MODEL_STORAGE_DIR ?? '/var/lib/paudio/models',
    ed25519PrivateKeyPem,
    keyId: env.ED25519_KEY_ID ?? 'ed25519_prod_key_v1',
    cdnBaseUrl: env.PUBLIC_CDN_BASE_URL ?? 'https://cdn.example.com',
    // Architecture Rule 3: Cloud ASR inference disabled in v1
    enableServerSideAsrInference: env.ENABLE_CLOUD_ASR === 'true',
  });

  // 2. EdDSA JWT Authentication Middleware for protected license endpoints
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/license/')) return;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'MISSING_BEARER_TOKEN' });
    }
    try {
      const token = authHeader.slice(7).trim();
      const claims = authAndPayment.verifyEdDsaJwt(token);
      request.authenticatedUserId = claims.sub;
    } catch {
      return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' });
    }
  });

  // 3. Register service routes
  authAndPayment.registerRoutes(fastify);
  platformServices.registerAllRoutes(fastify);

  // 4. Container Liveness & Readiness Probes
  fastify.get('/healthz', async () => ({
    status: 'alive',
    uptimeSec: Math.round(process.uptime()),
  }));

  const poolRef = pgPool;
  fastify.get('/readyz', async (_request, reply) => {
    try {
      await poolRef.query('SELECT 1');
      return reply.send({ status: 'ready', postgres: 'connected' });
    } catch {
      return reply.status(503).send({ status: 'not_ready', postgres: 'disconnected' });
    }
  });

  await fastify.listen({ port, host });
  return {
    fastify,
    pgPool,
    authAndPayment,
    shutdown: async (signal: string) => {
      fastify.log.info(`Received ${signal}. Shutting down Fastify and PostgreSQL pool...`);
      await fastify.close();
      await poolRef.end();
    },
  };
}
