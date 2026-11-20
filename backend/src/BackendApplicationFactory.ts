/**
 * @file backend/src/BackendApplicationFactory.ts
 * @description Section 140: Unified Backend Application Factory (`buildBackendApplication`).
 *              Wires all Backend routers, PostgreSQL repositories, Single-Flight read-through cache,
 *              Prometheus metrics exporter, Enterprise B2B API keys, EdDSA JWT guards, Canary Rollout,
 *              and Advisory Lock Coordinator into a single testable and deployable application instance.
 */

import type {
  AuthenticatedRequestContext,
  FastifyInstanceLike,
  FastifyReplyLike,
  PgPoolLike,
} from './PlatformBackendServices';
import { PlatformBackendServices } from './PlatformBackendServices';
import { BackendAuthAndPaymentService } from './BackendAuthAndPaymentService';
import { BackendLicenseAndModelRevocationService } from './BackendLicenseAndModelRevocationService';
import { isProtectedLicenseRoute } from './license/DeviceSeatEnforcementService';
import { BackendModelCanaryRolloutService } from './rollout/BackendModelCanaryRolloutService';
import { BackendExternalApiProxyService } from './gateway/BackendExternalApiProxyService';
import {
  EnterpriseApiKeyAndQuotaManager,
  EnterpriseKeyScope,
} from './auth/EnterpriseApiKeyAndQuotaManager';
import {
  BackendMetricsExporter,
  SingleFlightReadThroughCache,
} from './cache/BackendReadThroughCacheAndMetrics';
import { AdvisoryLockCoordinator } from './ops/BackendJobOutboxAndAdvisoryLockService';

export interface BackendAppFactoryConfig {
  readonly ed25519PrivateKeyPem: string;
  readonly ed25519PublicKeyPem: string;
  readonly keyId: string;
  readonly paymentWebhookHmacSecret: string;
  readonly adminApiSecretKey: string;
  readonly modelStorageRootDir: string;
  readonly cdnBaseUrl: string;
  readonly enableServerSideAsrInference: boolean;
  readonly enableRequestLogging?: boolean;
}

export interface FastifyInjectOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly payload?: unknown;
}

export interface FastifyInjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | number>;
  readonly body: string;
  json<T = any>(): T;
}

export interface TestableFastifyInstance extends FastifyInstanceLike {
  addHook(
    name: 'preHandler' | 'onResponse',
    fn: (req: any, reply: any) => Promise<unknown>,
  ): void;
  inject(opts: FastifyInjectOptions): Promise<FastifyInjectResponse>;
}

/**
 * Lightweight deterministic Fastify-compatible HTTP router with `.inject()` support
 * for zero-overhead integration testing and embedded execution when external `fastify` is not injected.
 */
export class BuiltInFastifyRouter implements TestableFastifyInstance {
  private readonly routes: {
    method: 'GET' | 'POST';
    pattern: string;
    handler: (req: any, reply: FastifyReplyLike) => Promise<unknown>;
  }[] = [];

  private readonly preHandlers: ((
    req: any,
    reply: FastifyReplyLike,
  ) => Promise<unknown>)[] = [];

  private readonly onResponseHooks: ((
    req: { url: string },
    reply: { statusCode: number; elapsedTime: number },
  ) => Promise<unknown>)[] = [];

  public get<
    T extends {
      Params?: unknown;
      Querystring?: unknown;
      Headers?: Record<string, string | undefined>;
    } = {
      Params?: Record<string, string>;
      Querystring?: Record<string, string>;
      Headers?: Record<string, string | undefined>;
    },
  >(
    url: string,
    handler: (
      request: AuthenticatedRequestContext & {
        params: T['Params'];
        query: T['Querystring'];
        headers: T extends { Headers: infer H }
          ? H
          : Record<string, string | undefined>;
      },
      reply: FastifyReplyLike,
    ) => Promise<unknown>,
  ): void {
    this.routes.push({ method: 'GET', pattern: url, handler });
  }

  public post<
    T extends {
      Body?: unknown;
      Params?: unknown;
      Headers?: Record<string, string | undefined>;
    } = {
      Body?: unknown;
      Params?: Record<string, string>;
      Headers?: Record<string, string | undefined>;
    },
  >(
    url: string,
    handler: (
      request: AuthenticatedRequestContext & {
        body: T['Body'];
        params: T['Params'];
        headers: T extends { Headers: infer H }
          ? H
          : Record<string, string | undefined>;
      },
      reply: FastifyReplyLike,
    ) => Promise<unknown>,
  ): void {
    this.routes.push({ method: 'POST', pattern: url, handler });
  }

  public addHook(
    name: 'preHandler' | 'onResponse',
    fn: (req: any, reply: any) => Promise<unknown>,
  ): void {
    if (name === 'preHandler') {
      this.preHandlers.push(fn);
    } else if (name === 'onResponse') {
      this.onResponseHooks.push(fn);
    }
  }

  public async inject(opts: FastifyInjectOptions): Promise<FastifyInjectResponse> {
    const t0 = performance.now();
    const [rawPath, rawQuery = ''] = opts.url.split('?');
    const query: Record<string, string> = {};
    if (rawQuery) {
      for (const pair of rawQuery.split('&')) {
        const [k, v] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      }
    }

    const normalizedHeaders: Record<string, string | undefined> = {};
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        normalizedHeaders[k.toLowerCase()] = v;
      }
    }

    let statusCode = 200;
    const responseHeaders: Record<string, string | number> = {};
    let sentPayload: unknown = undefined;
    let isSent = false;

    const reply: FastifyReplyLike = {
      status(code: number) {
        statusCode = code;
        return reply;
      },
      header(name: string, value: string | number) {
        responseHeaders[name.toLowerCase()] = value;
        return reply;
      },
      send(payload: unknown) {
        sentPayload = payload;
        isSent = true;
        return payload;
      },
    };

    const matched = this.matchRoute(opts.method, rawPath);
    const reqObj: any = {
      url: opts.url,
      ip: '127.0.0.1',
      params: matched?.params ?? {},
      query,
      headers: normalizedHeaders,
      body: opts.payload ?? {},
      authenticatedUserId: undefined,
    };

    for (const pre of this.preHandlers) {
      await pre(reqObj, reply);
      if (isSent) break;
    }

    if (!isSent) {
      if (!matched) {
        statusCode = 404;
        sentPayload = { error: 'ROUTE_NOT_FOUND', url: opts.url };
      } else {
        const returned = await matched.route.handler(reqObj, reply);
        if (!isSent && returned !== undefined) {
          sentPayload = returned;
        }
      }
    }

    const elapsedTime = Math.max(0.05, performance.now() - t0);
    for (const hook of this.onResponseHooks) {
      await hook({ url: rawPath }, { statusCode, elapsedTime });
    }

    const bodyString =
      typeof sentPayload === 'string'
        ? sentPayload
        : Buffer.isBuffer(sentPayload)
          ? sentPayload.toString('utf8')
          : JSON.stringify(sentPayload ?? {});

    return {
      statusCode,
      headers: responseHeaders,
      body: bodyString,
      json<T = any>(): T {
        return JSON.parse(bodyString) as T;
      },
    };
  }

  private matchRoute(
    method: 'GET' | 'POST',
    actualPath: string,
  ): {
    route: {
      method: 'GET' | 'POST';
      pattern: string;
      handler: (req: any, reply: FastifyReplyLike) => Promise<unknown>;
    };
    params: Record<string, string>;
  } | null {
    const actualParts = actualPath.split('/').filter(Boolean);

    for (const r of this.routes) {
      if (r.method !== method) continue;
      const patternParts = r.pattern.split('/').filter(Boolean);
      if (patternParts.length !== actualParts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          params[patternParts[i].slice(1)] = decodeURIComponent(actualParts[i]);
        } else if (patternParts[i] !== actualParts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return { route: r, params };
      }
    }
    return null;
  }
}

export interface BuiltBackendApplication {
  readonly fastify: TestableFastifyInstance;
  readonly sharedCache: SingleFlightReadThroughCache;
  readonly enterpriseKeys: EnterpriseApiKeyAndQuotaManager;
  readonly externalGateway: BackendExternalApiProxyService;
  readonly advisoryLocks: AdvisoryLockCoordinator;
}

export function buildBackendApplication(
  db: PgPoolLike,
  config: BackendAppFactoryConfig,
  customFastifyInstance?: TestableFastifyInstance,
): BuiltBackendApplication {
  const fastify: TestableFastifyInstance =
    customFastifyInstance ?? new BuiltInFastifyRouter();

  const sharedCache = new SingleFlightReadThroughCache();
  const metricsExporter = new BackendMetricsExporter(sharedCache);
  metricsExporter.registerHooksAndEndpoint(fastify);

  const authAndPayment = new BackendAuthAndPaymentService(db, {
    ed25519PrivateKeyPem: config.ed25519PrivateKeyPem,
    ed25519PublicKeyPem: config.ed25519PublicKeyPem,
    paymentWebhookHmacSecret: config.paymentWebhookHmacSecret,
  });

  const platformServices = new PlatformBackendServices(db, {
    modelStorageRootDir: config.modelStorageRootDir,
    ed25519PrivateKeyPem: config.ed25519PrivateKeyPem,
    keyId: config.keyId,
    cdnBaseUrl: config.cdnBaseUrl,
    enableServerSideAsrInference: config.enableServerSideAsrInference,
  });

  const revocationService = new BackendLicenseAndModelRevocationService(
    db,
    config.adminApiSecretKey,
  );
  const canaryRolloutService = new BackendModelCanaryRolloutService(
    db,
    sharedCache,
    config.adminApiSecretKey,
  );
  const externalGateway = new BackendExternalApiProxyService(db);
  const enterpriseKeys = new EnterpriseApiKeyAndQuotaManager(db);
  const advisoryLocks = new AdvisoryLockCoordinator(db);

  // 1. Security preHandler guarding all user license endpoints with EdDSA (Ed25519) JWT verification
  fastify.addHook('preHandler', async (request, reply) => {
    if (!isProtectedLicenseRoute(request.url)) return;

    const authHeader = request.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'MISSING_BEARER_TOKEN' });
    }
    try {
      const claims = authAndPayment.verifyEdDsaJwt(authHeader.slice(7).trim());
      if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
        return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' });
      }
      request.authenticatedUserId = claims.sub.trim();
    } catch {
      return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' });
    }
  });

  // 2. Register all core Backend domain routers
  authAndPayment.registerRoutes(fastify);
  platformServices.registerAllRoutes(fastify);
  revocationService.registerRoutes(fastify);
  canaryRolloutService.registerRoutes(fastify);
  externalGateway.registerRoutes(fastify);

  // 3. Admin-only endpoint for issuing B2B Enterprise API Keys
  fastify.post<{
    Headers: { 'x-admin-api-key'?: string };
    Body: {
      organizationId: string;
      scopes: EnterpriseKeyScope[];
      monthlyAudioSecondsLimit: number;
    };
  }>('/api/v1/admin/enterprise-keys', async (request, reply) => {
    if (request.headers['x-admin-api-key'] !== config.adminApiSecretKey) {
      return reply.status(401).send({ error: 'ADMIN_UNAUTHORIZED' });
    }
    const created = await enterpriseKeys.issueNewEnterpriseApiKey(request.body);
    return reply.status(201).send(created);
  });

  // 4. Liveness & Readiness probes for Docker / Kubernetes orchestration
  fastify.get('/healthz', async () => ({
    status: 'alive',
    uptimeSec: Math.round(process.uptime()),
  }));

  fastify.get('/readyz', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return reply.send({ status: 'ready', postgres: 'connected' });
    } catch {
      return reply
        .status(503)
        .send({ status: 'not_ready', postgres: 'disconnected' });
    }
  });

  return {
    fastify,
    sharedCache,
    enterpriseKeys,
    externalGateway,
    advisoryLocks,
  };
}
