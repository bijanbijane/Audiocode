import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendLicenseAndModelRevocationService } from './BackendLicenseAndModelRevocationService';
import { FastifyInstanceLike, FastifyReplyLike, PgPoolLike } from './PlatformBackendServices';

const DEV_OLDEST = 'a'.repeat(64);
const DEV_SECOND = 'b'.repeat(64);
const DEV_THIRD_NEW = 'c'.repeat(64);

describe('Section 118: BackendLicenseAndModelRevocationService', () => {
  it('evicts oldest device seat using DB-backed PRO_MONTHLY limit (2) inside a pinned transaction and syncs owner-scoped lease + REVOKED model alerts', async () => {
    const evictedDevices: string[] = [];
    const syncStateCheckedOwners: string[] = [];

    const runQuery = async <TRow>(sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM users WHERE id = $1')) {
        return { rows: [{ id: String(params[0]) }] as unknown as TRow[], rowCount: 1 };
      }
      if (sql.includes('FROM subscriptions')) {
        return {
          rows: [
            {
              id: 'sub_u1',
              plan_tier: 'PRO_MONTHLY',
              current_period_end: new Date(Date.now() + 30 * 86400_000),
              offline_grace_hours: 168,
            },
          ] as unknown as TRow[],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT lease_id, device_fingerprint_hash')) {
        return {
          rows: [
            {
              lease_id: 'l1',
              device_fingerprint_hash: DEV_OLDEST,
              issued_at: new Date(Date.now() - 86400000),
            },
            {
              lease_id: 'l2',
              device_fingerprint_hash: DEV_SECOND,
              issued_at: new Date(Date.now() - 3600000),
            },
          ] as unknown as TRow[],
          rowCount: 2,
        };
      }
      if (sql.includes('UPDATE offline_license_leases')) {
        const targets = params[1] as string[];
        evictedDevices.push(...targets);
        return { rows: [], rowCount: targets.length };
      }
      if (sql.includes('SELECT revoked, offline_grace_expires_at')) {
        assert.ok(sql.includes('user_id = $2'), 'sync-state query must bind owner user_id');
        syncStateCheckedOwners.push(String(params[1]));
        if (params[0] === 'l2' && params[1] === 'u1') {
          return {
            rows: [
              {
                revoked: false,
                offline_grace_expires_at: new Date(Date.now() + 86400000),
              },
            ] as unknown as TRow[],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT release_status')) {
        return {
          rows: [{ release_status: 'REVOKED' }] as unknown as TRow[],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };

    const mockDb: PgPoolLike = {
      query: runQuery,
      async connect() {
        return {
          query: runQuery,
          release() {},
        };
      },
    };

    const postRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
    const mockFastify: FastifyInstanceLike = {
      get() {},
      post(url, handler) {
        postRoutes.set(url, handler);
      },
    };

    const svc = new BackendLicenseAndModelRevocationService(mockDb, 'admin_secret_118');
    svc.registerRoutes(mockFastify);

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

    // Client tries to claim STUDIO_ENTERPRISE in body, but DB has PRO_MONTHLY (limit 2) -> oldest evicted!
    const seatRep = makeReply();
    await postRoutes.get('/api/v1/license/enforce-device-seat')!(
      {
        authenticatedUserId: 'u1',
        body: {
          planTier: 'STUDIO_ENTERPRISE',
          currentDeviceFingerprintHash: DEV_THIRD_NEW,
        },
        params: {},
        headers: {},
      },
      seatRep.reply,
    );

    assert.equal(seatRep.getStatus(), 200);
    assert.equal(seatRep.getPayload().maxDevicesAllowed, 2);
    assert.equal(seatRep.getPayload().evictedOldDevicesCount, 1);
    assert.deepEqual(evictedDevices, [DEV_OLDEST]);

    const syncRep = makeReply();
    await postRoutes.get('/api/v1/license/sync-state')!(
      {
        authenticatedUserId: 'u1',
        body: {
          leaseId: 'l2',
          installedModels: [{ modelId: 'conformer-fa', version: '1.0.0' }],
        },
        params: {},
        headers: {},
      },
      syncRep.reply,
    );

    assert.equal(syncRep.getStatus(), 200);
    assert.equal(syncRep.getPayload().leaseStatus, 'ACTIVE');
    assert.equal(syncRep.getPayload().revokedOrDeprecatedModels.length, 1);
    assert.equal(syncRep.getPayload().revokedOrDeprecatedModels[0].status, 'REVOKED');
    assert.deepEqual(syncStateCheckedOwners, ['u1']);

    // Different authenticated user querying u1's lease gets REVOKED without ownership leak
    const foreignSyncRep = makeReply();
    await postRoutes.get('/api/v1/license/sync-state')!(
      {
        authenticatedUserId: 'u2',
        body: {
          leaseId: 'l2',
          installedModels: [],
        },
        params: {},
        headers: {},
      },
      foreignSyncRep.reply,
    );
    assert.equal(foreignSyncRep.getStatus(), 200);
    assert.equal(foreignSyncRep.getPayload().leaseStatus, 'REVOKED');
  });
});
