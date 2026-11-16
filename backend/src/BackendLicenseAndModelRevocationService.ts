import crypto from 'node:crypto';
import type { FastifyInstanceLike, PgPoolLike } from './PlatformBackendServices';

/**
 * Section 118: Backend Device Seat Limiter, Client State Sync & Emergency Model Revocation Service
 */
export class BackendLicenseAndModelRevocationService {
  private static readonly PLAN_MAX_DEVICES: Readonly<Record<string, number>> = {
    FREE_TRIAL: 1,
    PRO_MONTHLY: 2,
    PRO_ANNUAL: 3,
    STUDIO_ENTERPRISE: 10,
  };

  constructor(
    private readonly db: PgPoolLike,
    private readonly adminApiSecretKey: string,
  ) {}

  public registerRoutes(fastify: FastifyInstanceLike): void {
    /**
     * 1. Enforce per-plan maximum active device seats prior to issuing a new offline lease.
     * Automatically evicts the oldest device lease when capacity is exceeded.
     */
    fastify.post<{
      Body: { userId: string; planTier: string; currentDeviceFingerprintHash: string };
    }>('/api/v1/license/enforce-device-seat', async (request, reply) => {
      const { userId, planTier, currentDeviceFingerprintHash } = request.body;
      const maxDevices =
        BackendLicenseAndModelRevocationService.PLAN_MAX_DEVICES[planTier] ?? 2;

      const activeLeasesRes = await this.db.query<{
        lease_id: string;
        device_fingerprint_hash: string;
        issued_at: Date;
      }>(
        `SELECT lease_id, device_fingerprint_hash, issued_at
         FROM offline_license_leases
         WHERE user_id = $1 AND revoked = FALSE AND offline_grace_expires_at > NOW()
         ORDER BY issued_at ASC`,
        [userId],
      );

      const distinctDevices = new Map<string, string[]>();
      for (const row of activeLeasesRes.rows) {
        const list = distinctDevices.get(row.device_fingerprint_hash) ?? [];
        list.push(row.lease_id);
        distinctDevices.set(row.device_fingerprint_hash, list);
      }

      const isKnownDevice = distinctDevices.has(currentDeviceFingerprintHash);
      let evictedDeviceCount = 0;

      if (!isKnownDevice && distinctDevices.size >= maxDevices) {
        const devicesToEvictCount = distinctDevices.size - maxDevices + 1;
        const oldestDeviceHashes = Array.from(distinctDevices.keys()).slice(
          0,
          devicesToEvictCount,
        );

        for (const oldHash of oldestDeviceHashes) {
          await this.db.query(
            `UPDATE offline_license_leases
             SET revoked = TRUE
             WHERE user_id = $1 AND device_fingerprint_hash = $2`,
            [userId, oldHash],
          );
          evictedDeviceCount++;
        }
      }

      return reply.send({
        seatAllowed: true,
        maxDevicesAllowed: maxDevices,
        activeDevicesAfterEnforcement: isKnownDevice
          ? distinctDevices.size
          : Math.min(maxDevices, distinctDevices.size + 1),
        evictedOldDevicesCount: evictedDeviceCount,
      });
    });

    /**
     * 2. Lightweight client state synchronization endpoint when online:
     * Checks device lease revocation + returns REVOKED or DEPRECATED alerts for installed models
     */
    fastify.post<{
      Body: {
        leaseId: string;
        installedModels: { modelId: string; version: string }[];
      };
    }>('/api/v1/license/sync-state', async (request, reply) => {
      const { leaseId, installedModels } = request.body;

      const leaseRes = await this.db.query<{
        revoked: boolean;
        offline_grace_expires_at: Date;
      }>(
        `SELECT revoked, offline_grace_expires_at
         FROM offline_license_leases
         WHERE lease_id = $1`,
        [leaseId],
      );

      const leaseStatus =
        leaseRes.rows.length === 0 || leaseRes.rows[0].revoked
          ? 'REVOKED'
          : new Date(leaseRes.rows[0].offline_grace_expires_at).getTime() < Date.now()
            ? 'EXPIRED'
            : 'ACTIVE';

      const modelAlerts: { modelId: string; version: string; status: string }[] = [];
      for (const m of installedModels) {
        const modRes = await this.db.query<{ release_status: string }>(
          `SELECT release_status
           FROM ai_models_catalog
           WHERE model_id = $1 AND version = $2`,
          [m.modelId, m.version],
        );
        if (modRes.rows.length > 0) {
          const st = modRes.rows[0].release_status;
          if (st === 'REVOKED' || st === 'DEPRECATED') {
            modelAlerts.push({ modelId: m.modelId, version: m.version, status: st });
          }
        }
      }

      return reply.send({
        leaseStatus,
        revokedOrDeprecatedModels: modelAlerts,
        serverTimeUnixSec: Math.floor(Date.now() / 1000),
      });
    });

    /**
     * 3. Emergency Admin Model Revocation (Section 40 Lifecycle)
     */
    fastify.post<{
      Headers: { 'x-admin-api-key'?: string };
      Params: { modelId: string; version: string };
      Body: { reason: string };
    }>('/api/v1/admin/models/:modelId/:version/revoke', async (request, reply) => {
      const providedKey = request.headers['x-admin-api-key'] ?? '';
      if (!this.verifyAdminKey(providedKey)) {
        return reply.status(401).send({ error: 'ADMIN_UNAUTHORIZED' });
      }

      const { modelId, version } = request.params;
      const updateRes = await this.db.query(
        `UPDATE ai_models_catalog
         SET release_status = 'REVOKED'
         WHERE model_id = $1 AND version = $2`,
        [modelId, version],
      );

      if ((updateRes.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: 'MODEL_VERSION_NOT_FOUND' });
      }

      return reply.send({
        revoked: true,
        modelId,
        version,
        reason: request.body.reason,
        revokedAtIso: new Date().toISOString(),
      });
    });
  }

  private verifyAdminKey(provided: string): boolean {
    if (!provided || !this.adminApiSecretKey) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(this.adminApiSecretKey, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
