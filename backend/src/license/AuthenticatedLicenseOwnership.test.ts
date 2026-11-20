/**
 * @file backend/src/license/AuthenticatedLicenseOwnership.test.ts
 * @description Comprehensive verification suite for AVP-AUTHENTICATED-LICENSE-OWNERSHIP-005:
 *              A. IDOR prevention & route-level + defense-in-depth authentication
 *              B. Authoritative database-backed subscription entitlement & FREE_TRIAL enforcement
 *              C. Device-seat enforcement correctness & direct lease-endpoint atomicity
 *              D. Pinned PostgreSQL transaction atomicity & all failure-injection points
 *              E. Deterministic per-account row-lock concurrency & cross-account parallelism
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  buildBackendApplication,
  BuiltBackendApplication,
} from '../BackendApplicationFactory';
import { BackendAuthAndPaymentService } from '../BackendAuthAndPaymentService';
import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PgPoolLike,
  PlatformBackendServices,
} from '../PlatformBackendServices';
import { BackendLicenseAndModelRevocationService } from '../BackendLicenseAndModelRevocationService';
import {
  PgTransactionClient,
  PinnedTransactionUnavailableError,
  ReleasedTransactionClientError,
  withPinnedPostgresTransaction,
} from '../db/PinnedPostgresTransaction';
import { LicensePlanTier } from './DeviceSeatEnforcementService';

const FP_DEV_1 = 'a'.repeat(64);
const FP_DEV_2 = 'b'.repeat(64);
const FP_DEV_3 = 'c'.repeat(64);
const FP_DEV_4 = 'd'.repeat(64);
const FP_DEV_5 = 'e'.repeat(64);

interface SimUserRow {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
}

interface SimSubRow {
  id: string;
  user_id: string;
  plan_tier: string;
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
  current_period_end: Date;
  offline_grace_hours: number;
}

interface SimLeaseRow {
  lease_id: string;
  user_id: string;
  subscription_id: string;
  device_fingerprint_hash: string;
  signing_key_id: string;
  issued_at: Date;
  offline_grace_expires_at: Date;
  revoked: boolean;
}

interface SimModelRow {
  model_id: string;
  version: string;
  release_status: string;
}

type FailureStage =
  | 'connect'
  | 'begin'
  | 'user_lock'
  | 'subscription'
  | 'active_leases'
  | 'eviction_update'
  | 'lease_insert'
  | 'commit'
  | 'rollback';

/**
 * Deterministic in-memory PostgreSQL transactional simulator supporting:
 * - Pinned connections (`connect() -> client`)
 * - Real `BEGIN` / `COMMIT` / `ROLLBACK` isolation via transaction-scoped working copy
 * - True per-user async `FOR UPDATE` mutex queue for deterministic concurrency testing
 * - Per-stage failure injection & query-routing telemetry
 */
class TransactionalPostgresSimulator implements PgPoolLike {
  public users = new Map<string, SimUserRow>();
  public subscriptions: SimSubRow[] = [];
  public leases: SimLeaseRow[] = [];
  public models: SimModelRow[] = [];

  public poolQueryCount = 0;
  public connectCount = 0;
  public releaseCount = 0;
  public destroyedReleaseCount = 0;
  public commitCount = 0;
  public rollbackCount = 0;
  public leaseSequenceMs = Date.now() - 10_000;

  public failStages = new Set<FailureStage>();
  public artificialDelayAfterUserLockMs = 0;
  public onUserLockAcquired?: (userId: string) => void;
  public onUserLockReleased?: (userId: string) => void;

  private readonly userLocks = new Map<string, Promise<void>>();
  private readonly userLockResolvers = new Map<string, () => void>();
  private clientIdCounter = 0;

  private async acquireUserLock(userId: string): Promise<void> {
    while (this.userLocks.has(userId)) {
      await this.userLocks.get(userId);
    }
    let releaseFn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.userLocks.set(userId, gate);
    this.userLockResolvers.set(userId, releaseFn);
    this.onUserLockAcquired?.(userId);
  }

  private releaseUserLocks(heldUsers: Set<string>): void {
    for (const userId of heldUsers) {
      const resolver = this.userLockResolvers.get(userId);
      this.userLocks.delete(userId);
      this.userLockResolvers.delete(userId);
      this.onUserLockReleased?.(userId);
      resolver?.();
    }
    heldUsers.clear();
  }

  public async query<TRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: TRow[]; rowCount: number | null }> {
    this.poolQueryCount++;
    return this.executeReadOrWrite(
      sql,
      params,
      {
        users: this.users,
        subscriptions: this.subscriptions,
        leases: this.leases,
        models: this.models,
      },
      false,
    );
  }

  public async connect(): Promise<PgTransactionClient> {
    this.connectCount++;
    if (this.failStages.has('connect')) {
      throw new Error('PG_INTERNAL_ECONNREFUSED: sensitive internal host 10.2.3.4:5432');
    }

    const clientId = ++this.clientIdCounter;
    let inTx = false;
    let isReleased = false;
    const heldUserLocks = new Set<string>();
    let txLeasesSnapshot: SimLeaseRow[] | null = null;
    let txSubsSnapshot: SimSubRow[] | null = null;

    const getWorkingState = () => ({
      users: this.users,
      subscriptions: txSubsSnapshot ?? this.subscriptions,
      leases: txLeasesSnapshot ?? this.leases,
      models: this.models,
    });

    const refreshSnapshotUnderLock = () => {
      // Read committed state after acquiring row locks (PostgreSQL READ COMMITTED semantics).
      txSubsSnapshot = this.subscriptions.map((s) => ({ ...s }));
      txLeasesSnapshot = this.leases.map((l) => ({ ...l }));
    };

    const client: PgTransactionClient = {
      query: async <TRow = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<{ rows: TRow[]; rowCount: number | null }> => {
        if (isReleased) {
          throw new Error(`Client #${clientId} already released`);
        }

        const trimmed = sql.trim().toUpperCase();
        if (trimmed === 'BEGIN') {
          if (this.failStages.has('begin')) {
            throw new Error('PG_INTERNAL_BEGIN_FAILURE: secret_pg_detail');
          }
          inTx = true;
          refreshSnapshotUnderLock();
          return { rows: [], rowCount: null };
        }

        if (trimmed === 'COMMIT') {
          if (this.failStages.has('commit')) {
            throw new Error('PG_INTERNAL_COMMIT_SERIALIZATION_FAILURE: secret_pg_detail');
          }
          if (inTx && txLeasesSnapshot && txSubsSnapshot) {
            this.leases = txLeasesSnapshot;
            this.subscriptions = txSubsSnapshot;
          }
          inTx = false;
          txLeasesSnapshot = null;
          txSubsSnapshot = null;
          this.commitCount++;
          this.releaseUserLocks(heldUserLocks);
          return { rows: [], rowCount: null };
        }

        if (trimmed === 'ROLLBACK') {
          this.rollbackCount++;
          inTx = false;
          txLeasesSnapshot = null;
          txSubsSnapshot = null;
          this.releaseUserLocks(heldUserLocks);
          if (this.failStages.has('rollback')) {
            throw new Error('PG_INTERNAL_ROLLBACK_BROKEN_PIPE: secret_pg_detail');
          }
          return { rows: [], rowCount: null };
        }

        if (sql.includes('FROM users WHERE id = $1 FOR UPDATE')) {
          const userId = String(params[0]);
          if (!heldUserLocks.has(userId)) {
            await this.acquireUserLock(userId);
            heldUserLocks.add(userId);
            // Re-sync working snapshot with latest committed state after acquiring lock
            if (inTx) {
              refreshSnapshotUnderLock();
            }
          }
          if (this.artificialDelayAfterUserLockMs > 0) {
            await new Promise((r) => setTimeout(r, this.artificialDelayAfterUserLockMs));
          }
          if (this.failStages.has('user_lock')) {
            throw new Error('PG_INTERNAL_USER_LOCK_TIMEOUT: secret_pg_detail');
          }
        }

        if (sql.includes('FROM subscriptions') && this.failStages.has('subscription')) {
          throw new Error('PG_INTERNAL_SUBSCRIPTION_IO_ERROR: secret_pg_detail');
        }
        if (
          sql.includes('SELECT lease_id, device_fingerprint_hash') &&
          this.failStages.has('active_leases')
        ) {
          throw new Error('PG_INTERNAL_LEASES_READ_ERROR: secret_pg_detail');
        }
        if (
          sql.includes('UPDATE offline_license_leases') &&
          this.failStages.has('eviction_update')
        ) {
          throw new Error('PG_INTERNAL_EVICTION_DEADLOCK: secret_pg_detail');
        }
        if (
          sql.includes('INSERT INTO offline_license_leases') &&
          this.failStages.has('lease_insert')
        ) {
          throw new Error('PG_INTERNAL_UNIQUE_VIOLATION_23505: secret_pg_detail');
        }

        return this.executeReadOrWrite<TRow>(sql, params, getWorkingState(), inTx);
      },
      release: (destroy?: boolean): void => {
        if (isReleased) return;
        isReleased = true;
        this.releaseCount++;
        if (destroy) this.destroyedReleaseCount++;
        this.releaseUserLocks(heldUserLocks);
      },
    };

    return client;
  }

  private executeReadOrWrite<TRow>(
    sql: string,
    params: unknown[],
    state: {
      users: Map<string, SimUserRow>;
      subscriptions: SimSubRow[];
      leases: SimLeaseRow[];
      models: SimModelRow[];
    },
    _inTx: boolean,
  ): { rows: TRow[]; rowCount: number | null } {
    if (sql.trim() === 'SELECT 1') {
      return { rows: [{ '?column?': 1 } as unknown as TRow], rowCount: 1 };
    }

    if (sql.includes('FROM users WHERE id = $1')) {
      const u = state.users.get(String(params[0]));
      return {
        rows: u ? ([{ id: u.id, status: u.status }] as unknown as TRow[]) : [],
        rowCount: u ? 1 : 0,
      };
    }

    if (sql.includes('FROM subscriptions')) {
      const userId = String(params[0]);
      const nowMs = Date.now();
      const matching = state.subscriptions
        .filter(
          (s) =>
            s.user_id === userId &&
            s.status === 'ACTIVE' &&
            s.current_period_end.getTime() > nowMs,
        )
        .sort((a, b) => b.current_period_end.getTime() - a.current_period_end.getTime());
      const top = matching[0];
      return {
        rows: top ? ([top] as unknown as TRow[]) : [],
        rowCount: top ? 1 : 0,
      };
    }

    if (sql.includes('SELECT lease_id, device_fingerprint_hash')) {
      const userId = String(params[0]);
      const nowMs = Date.now();
      const active = state.leases
        .filter(
          (l) =>
            l.user_id === userId &&
            !l.revoked &&
            l.offline_grace_expires_at.getTime() > nowMs,
        )
        .sort((a, b) => a.issued_at.getTime() - b.issued_at.getTime());
      return {
        rows: active as unknown as TRow[],
        rowCount: active.length,
      };
    }

    if (sql.includes('UPDATE offline_license_leases') && sql.includes('ANY($2)')) {
      const userId = String(params[0]);
      const targets = new Set((params[1] as string[]).map((v) => String(v)));
      let count = 0;
      for (const lease of state.leases) {
        if (
          lease.user_id === userId &&
          !lease.revoked &&
          targets.has(lease.device_fingerprint_hash)
        ) {
          lease.revoked = true;
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.includes('INSERT INTO offline_license_leases')) {
      const [leaseId, userId, subId, fpHash, keyId, graceEndUnixSec] = params as [
        string,
        string,
        string,
        string,
        string,
        number,
      ];
      this.leaseSequenceMs += 10;
      state.leases.push({
        lease_id: leaseId,
        user_id: userId,
        subscription_id: subId,
        device_fingerprint_hash: fpHash,
        signing_key_id: keyId,
        issued_at: new Date(this.leaseSequenceMs),
        offline_grace_expires_at: new Date(graceEndUnixSec * 1000),
        revoked: false,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('SELECT revoked, offline_grace_expires_at') && sql.includes('user_id = $2')) {
      const leaseId = String(params[0]);
      const userId = String(params[1]);
      const found = state.leases.find(
        (l) => l.lease_id === leaseId && l.user_id === userId,
      );
      return {
        rows: found
          ? ([
              {
                revoked: found.revoked,
                offline_grace_expires_at: found.offline_grace_expires_at,
              },
            ] as unknown as TRow[])
          : [],
        rowCount: found ? 1 : 0,
      };
    }

    if (sql.includes('SELECT release_status') && sql.includes('FROM ai_models_catalog')) {
      const modelId = String(params[0]);
      const version = String(params[1]);
      const found = state.models.find(
        (m) => m.model_id === modelId && m.version === version,
      );
      return {
        rows: found ? ([{ release_status: found.release_status }] as unknown as TRow[]) : [],
        rowCount: found ? 1 : 0,
      };
    }

    return { rows: [], rowCount: 0 };
  }
}

function createTestBackend(sim: TransactionalPostgresSimulator): {
  app: BuiltBackendApplication;
  authService: BackendAuthAndPaymentService;
  publicKey: crypto.KeyObject;
  privatePem: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const authService = new BackendAuthAndPaymentService(sim, {
    ed25519PrivateKeyPem: privatePem,
    ed25519PublicKeyPem: publicPem,
    paymentWebhookHmacSecret: 'test_hmac_secret',
  });

  const app = buildBackendApplication(sim, {
    ed25519PrivateKeyPem: privatePem,
    ed25519PublicKeyPem: publicPem,
    keyId: 'ed25519_test_k1',
    paymentWebhookHmacSecret: 'test_hmac_secret',
    adminApiSecretKey: 'test_admin_secret',
    modelStorageRootDir: os.tmpdir(),
    cdnBaseUrl: 'https://cdn.test.local',
    enableServerSideAsrInference: false,
  });

  return { app, authService, publicKey, privatePem };
}

function seedAccount(
  sim: TransactionalPostgresSimulator,
  userId: string,
  planTier: LicensePlanTier | string,
  opts?: {
    subStatus?: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
    periodEndOffsetMs?: number;
    offlineGraceHours?: number;
    userStatus?: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
    skipSubscription?: boolean;
  },
) {
  sim.users.set(userId, { id: userId, status: opts?.userStatus ?? 'ACTIVE' });
  if (!opts?.skipSubscription) {
    sim.subscriptions.push({
      id: `sub_${userId}`,
      user_id: userId,
      plan_tier: planTier,
      status: opts?.subStatus ?? 'ACTIVE',
      current_period_end: new Date(Date.now() + (opts?.periodEndOffsetMs ?? 30 * 86400_000)),
      offline_grace_hours: opts?.offlineGraceHours ?? 168,
    });
  }
}

// ============================================================================
// SECTION A: IDOR PREVENTION & AUTHENTICATION BOUNDARIES
// ============================================================================

test('A. IDOR prevention: JWT route guards (including sync-state & query strings), cross-account spoofing rejection, and defense-in-depth handler checks', async () => {
  const sim = new TransactionalPostgresSimulator();
  seedAccount(sim, 'user_a', 'PRO_MONTHLY');
  seedAccount(sim, 'user_b', 'STUDIO_ENTERPRISE');

  const { app, authService, publicKey, privatePem } = createTestBackend(sim);
  const tokenA = authService.issueEdDsaJwt({ sub: 'user_a', email: 'a@studio.ir' });
  const tokenB = authService.issueEdDsaJwt({ sub: 'user_b', email: 'b@studio.ir' });

  // 1. Unauthenticated requests to all 3 endpoints (with & without query strings) -> 401
  for (const url of [
    '/api/v1/license/lease',
    '/api/v1/license/lease?source=desktop',
    '/api/v1/license/enforce-device-seat',
    '/api/v1/license/enforce-device-seat?check=1',
    '/api/v1/license/sync-state',
    '/api/v1/license/sync-state?v=2',
  ]) {
    const res = await app.fastify.inject({
      method: 'POST',
      url,
      payload: { deviceFingerprintHash: FP_DEV_1, currentDeviceFingerprintHash: FP_DEV_1, leaseId: 'lic_1', installedModels: [] },
    });
    assert.equal(res.statusCode, 401, `Expected 401 on unauthenticated ${url}`);
  }

  // 2. Expired or invalid JWT -> 401
  const expiredAuth = new BackendAuthAndPaymentService(sim, {
    ed25519PrivateKeyPem: privatePem,
    ed25519PublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    paymentWebhookHmacSecret: 's',
    accessTokenTtlSeconds: -10,
  });
  const expiredToken = expiredAuth.issueEdDsaJwt({ sub: 'user_a', email: 'a@studio.ir' });
  const expRes = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/sync-state',
    headers: { authorization: `Bearer ${expiredToken}` },
    payload: { leaseId: 'lic_1', installedModels: [] },
  });
  assert.equal(expRes.statusCode, 401);

  const badSigRes = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers: { authorization: `Bearer ${tokenA}tampered` },
    payload: { deviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(badSigRes.statusCode, 401);

  // 3. Authenticated user A spoofing user_b in /api/v1/license/lease -> 403 before ANY DB op
  const connectsBefore = sim.connectCount;
  const queriesBefore = sim.poolQueryCount;
  const spoofLease = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { userId: 'user_b', deviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(spoofLease.statusCode, 403);
  assert.equal(spoofLease.json().error, 'FORBIDDEN_USER_MISMATCH');
  assert.equal(sim.connectCount, connectsBefore);
  assert.equal(sim.poolQueryCount, queriesBefore);

  // 4. Authenticated user A spoofing user_b in /api/v1/license/enforce-device-seat -> 403 before ANY DB op
  const spoofSeat = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/enforce-device-seat',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { userId: 'user_b', planTier: 'STUDIO_ENTERPRISE', currentDeviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(spoofSeat.statusCode, 403);
  assert.equal(spoofSeat.json().error, 'FORBIDDEN_USER_MISMATCH');
  assert.equal(sim.connectCount, connectsBefore);
  assert.equal(sim.poolQueryCount, queriesBefore);

  // 5. Authenticated user A succeeds with omitted userId AND with matching userId
  const leaseA1 = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { deviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(leaseA1.statusCode, 200);
  const envA1 = leaseA1.json();
  assert.equal(envA1.payload.userId, 'user_a');
  assert.equal(envA1.payload.planTier, 'PRO_MONTHLY');
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(envA1.payloadCanonicalBase64, 'utf8'),
      publicKey,
      Buffer.from(envA1.ed25519SignatureHex, 'hex'),
    ),
    true,
  );

  const leaseA2 = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { userId: 'user_a', deviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(leaseA2.statusCode, 200);
  assert.equal(leaseA2.json().payload.userId, 'user_a');

  // 6. Issue a lease for user B, then verify user A inspecting user B's lease via /sync-state
  //    receives the EXACT same REVOKED response as an unknown lease (no ownership disclosure)
  const leaseB = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { deviceFingerprintHash: FP_DEV_2 },
  });
  assert.equal(leaseB.statusCode, 200);
  const leaseIdB: string = leaseB.json().payload.licenseId;

  const syncOwnB = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/sync-state',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { leaseId: leaseIdB, installedModels: [] },
  });
  assert.equal(syncOwnB.statusCode, 200);
  assert.equal(syncOwnB.json().leaseStatus, 'ACTIVE');

  const syncForeign = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/sync-state',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { leaseId: leaseIdB, installedModels: [] },
  });
  const syncUnknown = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/sync-state',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { leaseId: 'lic_nonexistent_999', installedModels: [] },
  });
  assert.equal(syncForeign.statusCode, 200);
  assert.equal(syncUnknown.statusCode, 200);
  assert.equal(syncForeign.json().leaseStatus, 'REVOKED');
  assert.equal(syncUnknown.json().leaseStatus, 'REVOKED');
  assert.deepEqual(Object.keys(syncForeign.json()).sort(), Object.keys(syncUnknown.json()).sort());

  // 7. Malformed sync-state payloads rejected with 400 before DB lookup
  const qBeforeBadSync = sim.poolQueryCount;
  const badSyncPayloads = [
    { leaseId: '', installedModels: [] },
    { leaseId: 'lic_ok', installedModels: 'not-an-array' },
    {
      leaseId: 'lic_ok',
      installedModels: Array.from({ length: 257 }, (_, i) => ({
        modelId: `m${i}`,
        version: '1.0.0',
      })),
    },
    { leaseId: 'lic_ok', installedModels: [{ modelId: 'x'.repeat(65), version: '1.0.0' }] },
    { leaseId: 'lic_ok', installedModels: [{ modelId: 'm1', version: 'v'.repeat(33) }] },
    { leaseId: 'lic_ok', installedModels: [{ modelId: '', version: '1.0.0' }] },
  ];
  for (const payload of badSyncPayloads) {
    const badRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/sync-state',
      headers: { authorization: `Bearer ${tokenA}` },
      payload,
    });
    assert.equal(badRes.statusCode, 400);
  }
  assert.equal(sim.poolQueryCount, qBeforeBadSync);

  // 8. Defense-in-depth: direct route handler invocation without authenticatedUserId -> 401 & zero DB calls
  const directHandlers = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
  const stubFastify: FastifyInstanceLike = {
    get() {},
    post(url, handler) {
      directHandlers.set(url, handler as any);
    },
  };
  new PlatformBackendServices(sim, {
    modelStorageRootDir: os.tmpdir(),
    ed25519PrivateKeyPem: privatePem,
    keyId: 'k1',
    cdnBaseUrl: 'https://cdn.local',
    enableServerSideAsrInference: false,
  }).registerAllRoutes(stubFastify);
  new BackendLicenseAndModelRevocationService(sim, 'admin_sec').registerRoutes(stubFastify);

  const dbOpsBeforeDirect = sim.connectCount + sim.poolQueryCount;
  for (const route of [
    '/api/v1/license/lease',
    '/api/v1/license/enforce-device-seat',
    '/api/v1/license/sync-state',
  ]) {
    let status = 200;
    let body: any = null;
    const reply: FastifyReplyLike = {
      status(c) {
        status = c;
        return reply;
      },
      header() {
        return reply;
      },
      send(p) {
        body = p;
        return p;
      },
    };
    await directHandlers.get(route)!(
      {
        body: {
          userId: 'user_a',
          deviceFingerprintHash: FP_DEV_1,
          currentDeviceFingerprintHash: FP_DEV_1,
          leaseId: 'lic_1',
          installedModels: [],
        },
        params: {},
        headers: {},
      },
      reply,
    );
    assert.equal(status, 401, `Direct handler ${route} must return 401 without authenticatedUserId`);
    assert.equal(body.error, 'AUTHENTICATION_REQUIRED');
  }
  assert.equal(sim.connectCount + sim.poolQueryCount, dbOpsBeforeDirect);
});

// ============================================================================
// SECTION B: SUBSCRIPTION ENTITLEMENT AUTHORITY & FREE_TRIAL
// ============================================================================

test('B. Subscription entitlement authority: DB-only plan resolution, FREE_TRIAL (1 device), expired/cancelled/missing rejection, and fingerprint validation', async () => {
  const sim = new TransactionalPostgresSimulator();
  seedAccount(sim, 'u_free', 'FREE_TRIAL');
  seedAccount(sim, 'u_monthly', 'PRO_MONTHLY');
  seedAccount(sim, 'u_annual', 'PRO_ANNUAL');
  seedAccount(sim, 'u_ent', 'STUDIO_ENTERPRISE');
  seedAccount(sim, 'u_expired', 'PRO_MONTHLY', { periodEndOffsetMs: -60_000 });
  seedAccount(sim, 'u_cancelled', 'PRO_MONTHLY', { subStatus: 'CANCELLED' });
  seedAccount(sim, 'u_nosub', 'PRO_MONTHLY', { skipSubscription: true });
  seedAccount(sim, 'u_badtier', 'UNKNOWN_UNLIMITED_TIER');
  seedAccount(sim, 'u_badgrace', 'PRO_MONTHLY', { offlineGraceHours: -5 });

  const { app, authService } = createTestBackend(sim);

  const authHeader = (sub: string) => ({
    authorization: `Bearer ${authService.issueEdDsaJwt({ sub, email: `${sub}@studio.ir` })}`,
  });

  // 1. FREE_TRIAL user tries to pass client-supplied planTier='STUDIO_ENTERPRISE' -> IGNORED, enforced as 1 device!
  const freeLease1 = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers: authHeader('u_free'),
    payload: { deviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(freeLease1.statusCode, 200);
  assert.equal(freeLease1.json().payload.planTier, 'FREE_TRIAL');

  const freeElevateAttempt = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/enforce-device-seat',
    headers: authHeader('u_free'),
    payload: {
      planTier: 'STUDIO_ENTERPRISE',
      currentDeviceFingerprintHash: FP_DEV_2,
    },
  });
  assert.equal(freeElevateAttempt.statusCode, 200);
  assert.equal(freeElevateAttempt.json().maxDevicesAllowed, 1);
  assert.equal(freeElevateAttempt.json().evictedOldDevicesCount, 1);
  assert.equal(freeElevateAttempt.json().activeDevicesAfterEnforcement, 1);

  // 2. Verify authoritative limits across all 4 tiers
  for (const [uid, expectedMax] of [
    ['u_monthly', 2],
    ['u_annual', 3],
    ['u_ent', 10],
  ] as const) {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/enforce-device-seat',
      headers: authHeader(uid),
      payload: {
        planTier: 'FREE_TRIAL', // client attempt to override in either direction is ignored
        currentDeviceFingerprintHash: FP_DEV_1,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().maxDevicesAllowed, expectedMax);
  }

  // 3. Expired, cancelled, missing subscription, and nonexistent user -> 403 NO_ACTIVE_SUBSCRIPTION
  for (const uid of ['u_expired', 'u_cancelled', 'u_nosub', 'u_ghost']) {
    const leaseRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/lease',
      headers: authHeader(uid),
      payload: { deviceFingerprintHash: FP_DEV_1 },
    });
    assert.equal(leaseRes.statusCode, 403, `Expected 403 for ${uid} on /lease`);
    assert.equal(leaseRes.json().error, 'NO_ACTIVE_SUBSCRIPTION');

    const seatRes = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/enforce-device-seat',
      headers: authHeader(uid),
      payload: { currentDeviceFingerprintHash: FP_DEV_1 },
    });
    assert.equal(seatRes.statusCode, 403, `Expected 403 for ${uid} on /enforce-device-seat`);
    assert.equal(seatRes.json().error, 'NO_ACTIVE_SUBSCRIPTION');
  }

  // 4. Unsupported plan tier & invalid offline_grace_hours -> 409 DEVICE_SEAT_POLICY_VIOLATION
  for (const uid of ['u_badtier', 'u_badgrace']) {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/lease',
      headers: authHeader(uid),
      payload: { deviceFingerprintHash: FP_DEV_1 },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'DEVICE_SEAT_POLICY_VIOLATION');
  }

  // 5. Invalid device fingerprints -> 400 INVALID_DEVICE_FINGERPRINT before DB access
  const connectsBeforeFp = sim.connectCount;
  for (const badFp of ['', 'short', 'g'.repeat(64), `${'a'.repeat(63)} `, 'a'.repeat(65), null]) {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/lease',
      headers: authHeader('u_monthly'),
      payload: { deviceFingerprintHash: badFp },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'INVALID_DEVICE_FINGERPRINT');
  }
  assert.equal(sim.connectCount, connectsBeforeFp);
});

// ============================================================================
// SECTION C: DEVICE-SEAT CORRECTNESS & DIRECT LEASE ATOMICITY
// ============================================================================

test('C. Device-seat correctness: direct /lease enforcement without /enforce-device-seat, case-insensitive known-device renewal, multi-lease dedup, and oldest-device eviction', async () => {
  const sim = new TransactionalPostgresSimulator();
  seedAccount(sim, 'u_seats', 'PRO_MONTHLY'); // limit 2

  const { app, authService } = createTestBackend(sim);
  const headers = {
    authorization: `Bearer ${authService.issueEdDsaJwt({ sub: 'u_seats', email: 's@studio.ir' })}`,
  };

  // Issue 2 leases on DEV_1 (same device, mixed case) -> counts as 1 distinct device
  const r1 = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers,
    payload: { deviceFingerprintHash: FP_DEV_1.toUpperCase() },
  });
  assert.equal(r1.statusCode, 200);

  const r1Renew = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers,
    payload: { deviceFingerprintHash: FP_DEV_1 },
  });
  assert.equal(r1Renew.statusCode, 200);

  // Issue lease on DEV_2 -> now at capacity (2 distinct devices: DEV_1, DEV_2)
  const r2 = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers,
    payload: { deviceFingerprintHash: FP_DEV_2 },
  });
  assert.equal(r2.statusCode, 200);

  // Renew DEV_2 at capacity -> ZERO devices evicted!
  const checkRenew = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/enforce-device-seat',
    headers,
    payload: { currentDeviceFingerprintHash: FP_DEV_2.toUpperCase() },
  });
  assert.equal(checkRenew.statusCode, 200);
  assert.equal(checkRenew.json().evictedOldDevicesCount, 0);
  assert.equal(checkRenew.json().activeDevicesAfterEnforcement, 2);

  // Directly call /api/v1/license/lease for DEV_3 WITHOUT calling /enforce-device-seat first:
  // MUST atomically evict ALL leases of DEV_1 (oldest distinct device) and keep DEV_2 + DEV_3 active!
  const r3 = await app.fastify.inject({
    method: 'POST',
    url: '/api/v1/license/lease',
    headers,
    payload: { deviceFingerprintHash: FP_DEV_3 },
  });
  assert.equal(r3.statusCode, 200);

  const activeDevices = new Set(
    sim.leases
      .filter((l) => l.user_id === 'u_seats' && !l.revoked)
      .map((l) => l.device_fingerprint_hash),
  );
  assert.deepEqual(Array.from(activeDevices).sort(), [FP_DEV_2, FP_DEV_3].sort());

  // Both leases for DEV_1 must be revoked
  const dev1Leases = sim.leases.filter((l) => l.device_fingerprint_hash === FP_DEV_1);
  assert.equal(dev1Leases.length, 2);
  assert.ok(dev1Leases.every((l) => l.revoked === true));
});

// ============================================================================
// SECTION D: PINNED TRANSACTION ATOMICITY & ALL FAILURE INJECTION POINTS
// ============================================================================

test('D. Transaction atomicity: fail-closed when connect() missing, released-client guard, rollback on every failure point, and zero Ed25519 signing before COMMIT', async () => {
  // 1. Pool missing connect() -> PinnedTransactionUnavailableError & HTTP 503
  const poolWithoutConnect: PgPoolLike = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => withPinnedPostgresTransaction(poolWithoutConnect, async () => 'ok'),
    (err: unknown) => err instanceof PinnedTransactionUnavailableError,
  );

  // 2. Using transaction client after release throws ReleasedTransactionClientError
  const simBasic = new TransactionalPostgresSimulator();
  let capturedClient!: PgTransactionClient;
  await withPinnedPostgresTransaction(simBasic, async (tx) => {
    capturedClient = tx;
    await tx.query('SELECT 1');
  });
  await assert.rejects(
    () => capturedClient.query('SELECT 1'),
    (err: unknown) => err instanceof ReleasedTransactionClientError,
  );

  // 3. Failure injection across every transaction stage on /api/v1/license/lease
  const failureStages: Array<{ stage: FailureStage; expectedStatus: number; expectRollback: boolean }> = [
    { stage: 'connect', expectedStatus: 503, expectRollback: false },
    { stage: 'begin', expectedStatus: 500, expectRollback: false },
    { stage: 'user_lock', expectedStatus: 500, expectRollback: true },
    { stage: 'subscription', expectedStatus: 500, expectRollback: true },
    { stage: 'active_leases', expectedStatus: 500, expectRollback: true },
    { stage: 'eviction_update', expectedStatus: 500, expectRollback: true },
    { stage: 'lease_insert', expectedStatus: 500, expectRollback: true },
    { stage: 'commit', expectedStatus: 500, expectRollback: true },
  ];

  for (const { stage, expectedStatus, expectRollback } of failureStages) {
    const sim = new TransactionalPostgresSimulator();
    seedAccount(sim, 'u_tx', 'FREE_TRIAL');
    // Pre-seed 1 active device so eviction_update IS executed before lease_insert
    sim.leases.push({
      lease_id: 'lic_existing',
      user_id: 'u_tx',
      subscription_id: 'sub_u_tx',
      device_fingerprint_hash: FP_DEV_1,
      signing_key_id: 'ed25519_test_k1',
      issued_at: new Date(Date.now() - 60_000),
      offline_grace_expires_at: new Date(Date.now() + 86400_000),
      revoked: false,
    });
    sim.failStages.add(stage);

    const { app, authService } = createTestBackend(sim);
    const token = authService.issueEdDsaJwt({ sub: 'u_tx', email: 'tx@studio.ir' });

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/v1/license/lease',
      headers: { authorization: `Bearer ${token}` },
      payload: { deviceFingerprintHash: FP_DEV_2 },
    });

    assert.equal(res.statusCode, expectedStatus, `Stage ${stage} expected HTTP ${expectedStatus}`);
    // Raw PG internals MUST NEVER leak in HTTP response
    assert.ok(!res.body.includes('PG_INTERNAL_'), `Stage ${stage} leaked internal PG error`);
    assert.ok(!res.body.includes('secret_pg_detail'), `Stage ${stage} leaked sensitive PG detail`);
    // No signed license envelope returned
    assert.equal(res.json().ed25519SignatureHex, undefined);
    // Original existing lease MUST remain unrevoked (atomic rollback!) and no new lease persisted
    assert.equal(sim.leases.length, 1, `Stage ${stage} leaked uncommitted lease`);
    assert.equal(sim.leases[0].revoked, false, `Stage ${stage} failed to rollback eviction`);
    if (expectRollback) {
      assert.ok(sim.rollbackCount >= 1, `Stage ${stage} must execute ROLLBACK`);
    }
    if (stage !== 'connect') {
      assert.equal(sim.releaseCount, sim.connectCount, `Stage ${stage} leaked connection`);
    }
    // Zero direct pool.query() calls during transactional lease issuance
    assert.equal(sim.poolQueryCount, 0, `Stage ${stage} bypassed pinned transaction client`);
  }

  // 4. ROLLBACK failure itself preserves original exception and destroys the broken connection
  const simRollbackFail = new TransactionalPostgresSimulator();
  seedAccount(simRollbackFail, 'u_rb', 'PRO_MONTHLY');
  simRollbackFail.failStages.add('lease_insert');
  simRollbackFail.failStages.add('rollback');

  await assert.rejects(
    () =>
      withPinnedPostgresTransaction(simRollbackFail, async (tx) => {
        await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', ['u_rb']);
        await tx.query('INSERT INTO offline_license_leases VALUES ($1,$2,$3,$4,$5,$6)', [
          'l1',
          'u_rb',
          'sub_u_rb',
          FP_DEV_1,
          'k1',
          Math.floor(Date.now() / 1000) + 3600,
        ]);
      }),
    /PG_INTERNAL_UNIQUE_VIOLATION_23505/,
  );
  assert.equal(simRollbackFail.destroyedReleaseCount, 1);
  assert.equal(simRollbackFail.releaseCount, 1);
});

// ============================================================================
// SECTION E: DETERMINISTIC CONCURRENCY & PER-ACCOUNT LOCK SERIALIZATION
// ============================================================================

test('E. Concurrency: same-device race, multi-device capacity race, concurrent lease+enforce, and parallel independent accounts', async () => {
  // 1. Four concurrent new-device lease requests on PRO_MONTHLY (limit 2) -> active devices strictly <= 2
  {
    const sim = new TransactionalPostgresSimulator();
    seedAccount(sim, 'u_race', 'PRO_MONTHLY');
    sim.artificialDelayAfterUserLockMs = 10;

    const { app, authService } = createTestBackend(sim);
    const headers = {
      authorization: `Bearer ${authService.issueEdDsaJwt({ sub: 'u_race', email: 'r@studio.ir' })}`,
    };

    const responses = await Promise.all(
      [FP_DEV_1, FP_DEV_2, FP_DEV_3, FP_DEV_4].map((fp) =>
        app.fastify.inject({
          method: 'POST',
          url: '/api/v1/license/lease',
          headers,
          payload: { deviceFingerprintHash: fp },
        }),
      ),
    );

    assert.ok(responses.every((r) => r.statusCode === 200));
    const activeDistinct = new Set(
      sim.leases
        .filter((l) => l.user_id === 'u_race' && !l.revoked)
        .map((l) => l.device_fingerprint_hash),
    );
    assert.ok(
      activeDistinct.size <= 2,
      `Concurrent capacity race exceeded limit 2: got ${activeDistinct.size}`,
    );
    assert.equal(activeDistinct.size, 2);
    assert.equal(sim.releaseCount, sim.connectCount);
  }

  // 2. Concurrent same-device renewals -> zero evictions, 1 active distinct device
  {
    const sim = new TransactionalPostgresSimulator();
    seedAccount(sim, 'u_same', 'FREE_TRIAL'); // limit 1
    sim.artificialDelayAfterUserLockMs = 5;

    const { app, authService } = createTestBackend(sim);
    const headers = {
      authorization: `Bearer ${authService.issueEdDsaJwt({ sub: 'u_same', email: 'same@studio.ir' })}`,
    };

    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        app.fastify.inject({
          method: 'POST',
          url: '/api/v1/license/lease',
          headers,
          payload: { deviceFingerprintHash: FP_DEV_1 },
        }),
      ),
    );
    assert.ok(responses.every((r) => r.statusCode === 200));
    const activeDistinct = new Set(
      sim.leases
        .filter((l) => l.user_id === 'u_same' && !l.revoked)
        .map((l) => l.device_fingerprint_hash),
    );
    assert.equal(activeDistinct.size, 1);
    assert.ok(sim.leases.every((l) => l.revoked === false));
  }

  // 3. Concurrent /lease and /enforce-device-seat on same account -> committed active seats strictly <= maxDevices
  {
    const sim = new TransactionalPostgresSimulator();
    seedAccount(sim, 'u_mix', 'PRO_MONTHLY'); // limit 2
    sim.artificialDelayAfterUserLockMs = 8;

    const { app, authService } = createTestBackend(sim);
    const headers = {
      authorization: `Bearer ${authService.issueEdDsaJwt({ sub: 'u_mix', email: 'mix@studio.ir' })}`,
    };

    const [r1, r2, r3, r4] = await Promise.all([
      app.fastify.inject({
        method: 'POST',
        url: '/api/v1/license/lease',
        headers,
        payload: { deviceFingerprintHash: FP_DEV_1 },
      }),
      app.fastify.inject({
        method: 'POST',
        url: '/api/v1/license/enforce-device-seat',
        headers,
        payload: { currentDeviceFingerprintHash: FP_DEV_2 },
      }),
      app.fastify.inject({
        method: 'POST',
        url: '/api/v1/license/lease',
        headers,
        payload: { deviceFingerprintHash: FP_DEV_3 },
      }),
      app.fastify.inject({
        method: 'POST',
        url: '/api/v1/license/lease',
        headers,
        payload: { deviceFingerprintHash: FP_DEV_5 },
      }),
    ]);

    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.equal(r3.statusCode, 200);
    assert.equal(r4.statusCode, 200);

    const activeDistinct = new Set(
      sim.leases
        .filter((l) => l.user_id === 'u_mix' && !l.revoked)
        .map((l) => l.device_fingerprint_hash),
    );
    assert.ok(activeDistinct.size <= 2, `Expected <= 2 active devices, got ${activeDistinct.size}`);
  }

  // 4. Concurrent operations on DIFFERENT accounts overlap in parallel (no global lock)
  {
    const sim = new TransactionalPostgresSimulator();
    seedAccount(sim, 'u_par_1', 'PRO_MONTHLY');
    seedAccount(sim, 'u_par_2', 'PRO_MONTHLY');
    sim.artificialDelayAfterUserLockMs = 30;

    let currentlyHeld = 0;
    let maxConcurrentAccountsLocked = 0;
    sim.onUserLockAcquired = () => {
      currentlyHeld++;
      if (currentlyHeld > maxConcurrentAccountsLocked) {
        maxConcurrentAccountsLocked = currentlyHeld;
      }
    };
    sim.onUserLockReleased = () => {
      currentlyHeld--;
    };

    const { app, authService } = createTestBackend(sim);
    const [res1, res2] = await Promise.all([
      app.fastify.inject({
        method: 'POST',
        url: '/api/v1/license/lease',
        headers: {
          authorization: `Bearer ${authService.issueEdDsaJwt({ sub: 'u_par_1', email: 'p1@studio.ir' })}`,
        },
        payload: { deviceFingerprintHash: FP_DEV_1 },
      }),
      app.fastify.inject({
        method: 'POST',
        url: '/api/v1/license/lease',
        headers: {
          authorization: `Bearer ${authService.issueEdDsaJwt({ sub: 'u_par_2', email: 'p2@studio.ir' })}`,
        },
        payload: { deviceFingerprintHash: FP_DEV_1 },
      }),
    ]);

    assert.equal(res1.statusCode, 200);
    assert.equal(res2.statusCode, 200);
    assert.equal(
      maxConcurrentAccountsLocked,
      2,
      'Independent user accounts must not block each other',
    );
  }
});
