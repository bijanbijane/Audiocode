import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendLicenseAndModelRevocationService } from './BackendLicenseAndModelRevocationService';
import { FastifyInstanceLike, FastifyReplyLike, PgPoolLike } from './PlatformBackendServices';

describe('Section 118: BackendLicenseAndModelRevocationService', () => {
  it('evicts oldest device seat when PRO_MONTHLY limit (2) is exceeded and syncs REVOKED model alerts', async () => {
    const evictedDevices: string[] = [];
    const mockDb: PgPoolLike = {
      async query<TRow>(sql: string, params: unknown[] = []) {
        if (sql.includes('SELECT lease_id, device_fingerprint_hash')) {
          return {
            rows: [
              {
                lease_id: 'l1',
                device_fingerprint_hash: 'dev_oldest',
                issued_at: new Date(Date.now() - 86400000),
              },
              {
                lease_id: 'l2',
                device_fingerprint_hash: 'dev_second',
                issued_at: new Date(Date.now() - 3600000),
              },
            ] as unknown as TRow[],
            rowCount: 2,
          };
        }
        if (sql.includes('UPDATE offline_license_leases')) {
          evictedDevices.push(String(params[1]));
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT revoked, offline_grace_expires_at')) {
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
        if (sql.includes('SELECT release_status')) {
          return {
            rows: [{ release_status: 'REVOKED' }] as unknown as TRow[],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
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
      let payload: any = null;
      const reply: FastifyReplyLike = {
        status() {
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
      return { reply, getPayload: () => payload };
    };

    const seatRep = makeReply();
    await postRoutes.get('/api/v1/license/enforce-device-seat')!(
      {
        body: {
          userId: 'u1',
          planTier: 'PRO_MONTHLY',
          currentDeviceFingerprintHash: 'dev_third_new',
        },
        params: {},
        headers: {},
      },
      seatRep.reply,
    );

    assert.equal(seatRep.getPayload().evictedOldDevicesCount, 1);
    assert.deepEqual(evictedDevices, ['dev_oldest']);

    const syncRep = makeReply();
    await postRoutes.get('/api/v1/license/sync-state')!(
      {
        body: {
          leaseId: 'l2',
          installedModels: [{ modelId: 'conformer-fa', version: '1.0.0' }],
        },
        params: {},
        headers: {},
      },
      syncRep.reply,
    );

    assert.equal(syncRep.getPayload().leaseStatus, 'ACTIVE');
    assert.equal(syncRep.getPayload().revokedOrDeprecatedModels.length, 1);
    assert.equal(syncRep.getPayload().revokedOrDeprecatedModels[0].status, 'REVOKED');
  });
});
