import crypto from 'node:crypto';
import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PgPoolLike,
  PlatformBackendServices,
} from './PlatformBackendServices';
import { BackendAuthAndPaymentService } from './BackendAuthAndPaymentService';
import { BackendLicenseAndModelRevocationService } from './BackendLicenseAndModelRevocationService';
import {
  extractUrlPathname,
  isProtectedLicenseRoute,
} from './license/DeviceSeatEnforcementService';

/**
 * In-memory Sliding-Window Rate Limiter for brute-force and CDN abuse protection
 */
function assertMatchingEd25519KeyPair(privateKeyPem: string, publicKeyPem: string): void {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const derivedPublicKey = crypto.createPublicKey(privateKey);
  const configuredPublicKey = crypto.createPublicKey(publicKeyPem);
  if (
    privateKey.asymmetricKeyType !== 'ed25519' ||
    derivedPublicKey.asymmetricKeyType !== 'ed25519' ||
    configuredPublicKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('BACKEND_ED25519_KEY_TYPE_INVALID');
  }
  const derivedDer = Buffer.from(derivedPublicKey.export({ type: 'spki', format: 'der' }));
  const configuredDer = Buffer.from(configuredPublicKey.export({ type: 'spki', format: 'der' }));

  if (
    derivedDer.byteLength !== configuredDer.byteLength ||
    !crypto.timingSafeEqual(derivedDer, configuredDer)
  ) {
    throw new Error('BACKEND_ED25519_KEYPAIR_MISMATCH');
  }
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  constructor(private readonly maxTrackedBuckets = 10_000) {
    if (!Number.isSafeInteger(maxTrackedBuckets) || maxTrackedBuckets < 1) {
      throw new Error('INVALID_RATE_LIMITER_BUCKET_CAPACITY');
    }
  }

  public get trackedBucketsCount(): number {
    return this.buckets.size;
  }

  public isAllowed(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (existing && now <= existing.resetAtMs) {
      // Refresh insertion order so the least-recently-used bucket is evicted first.
      this.buckets.delete(key);
      this.buckets.set(key, existing);
      if (existing.count >= maxRequests) return false;
      existing.count++;
      return true;
    }

    if (existing) this.buckets.delete(key);
    if (this.buckets.size >= this.maxTrackedBuckets) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (now > bucket.resetAtMs) this.buckets.delete(bucketKey);
      }
      // Never evict a live bucket: doing so would let an attacker rotate source keys
      // to reset their rate limit. Fail closed until an existing window expires.
      if (this.buckets.size >= this.maxTrackedBuckets) return false;
    }

    this.buckets.set(key, { count: 1, resetAtMs: now + windowMs });
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
  const host = env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

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

  // JWT issuance/verification and offline-license signing must share one Ed25519 key pair.
  // Fail at startup instead of issuing tokens that the configured public key cannot verify.
  assertMatchingEd25519KeyPair(ed25519PrivateKeyPem, ed25519PublicKeyPem);

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
      // Trust proxy headers only when an operator explicitly places this service behind
      // a sanitizing reverse proxy (the separated Compose Nginx edge does this).
      trustProxy: env.TRUST_PROXY === 'true',
    });
  }

  const rateLimiter = new SlidingWindowRateLimiter();

  // 1. Global Sliding-Window Rate Limiting Hook
  fastify.addHook('onRequest', async (request, reply) => {
    const clientIp = request.ip;
    const pathname = extractUrlPathname(request.url);
    const isAuthRoute = pathname.startsWith('/api/v1/auth/');
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

  const revocationService = new BackendLicenseAndModelRevocationService(
    pgPool,
    env.ADMIN_API_SECRET_KEY ?? '',
  );

  // 2. EdDSA JWT Authentication Middleware for protected license endpoints
  fastify.addHook('preHandler', async (request, reply) => {
    if (!isProtectedLicenseRoute(request.url)) return;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'MISSING_BEARER_TOKEN' });
    }
    try {
      const token = authHeader.slice(7).trim();
      const claims = authAndPayment.verifyEdDsaJwt(token);
      if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
        return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' });
      }
      request.authenticatedUserId = claims.sub.trim();
    } catch {
      return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' });
    }
  });

  // 3. Register service routes
  authAndPayment.registerRoutes(fastify);
  platformServices.registerAllRoutes(fastify);
  revocationService.registerRoutes(fastify);

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
