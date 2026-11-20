import crypto from 'node:crypto';
import type { FastifyInstanceLike, PgPoolLike } from './PlatformBackendServices';
import { withPinnedPostgresTransaction } from './db/PinnedPostgresTransaction';
import {
  enforceDeviceSeatsForAuthenticatedUser,
  sendClassifiedLicenseError,
  validateAndNormalizeDeviceFingerprintHash,
} from './license/DeviceSeatEnforcementService';

const MAX_SYNC_STATE_INSTALLED_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 64;
const MAX_MODEL_VERSION_LENGTH = 32;
const MAX_LEASE_ID_LENGTH = 128;

interface ValidatedInstalledModelRef {
  readonly modelId: string;
  readonly version: string;
}

function validateSyncStatePayload(body: unknown): {
  readonly leaseId: string;
  readonly installedModels: readonly ValidatedInstalledModelRef[];
} | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const candidate = body as {
    leaseId?: unknown;
    installedModels?: unknown;
  };
  if (
    typeof candidate.leaseId !== 'string' ||
    candidate.leaseId.trim().length === 0 ||
    candidate.leaseId.trim().length > MAX_LEASE_ID_LENGTH
  ) {
    return null;
  }
  if (
    !Array.isArray(candidate.installedModels) ||
    candidate.installedModels.length > MAX_SYNC_STATE_INSTALLED_MODELS
  ) {
    return null;
  }

  const normalizedModels: ValidatedInstalledModelRef[] = [];
  for (const item of candidate.installedModels) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const modelObj = item as { modelId?: unknown; version?: unknown };
    if (
      typeof modelObj.modelId !== 'string' ||
      modelObj.modelId.trim().length === 0 ||
      modelObj.modelId.length > MAX_MODEL_ID_LENGTH
    ) {
      return null;
    }
    if (
      typeof modelObj.version !== 'string' ||
      modelObj.version.trim().length === 0 ||
      modelObj.version.length > MAX_MODEL_VERSION_LENGTH
    ) {
      return null;
    }
    normalizedModels.push({
      modelId: modelObj.modelId.trim(),
      version: modelObj.version.trim(),
    });
  }

  return {
    leaseId: candidate.leaseId.trim(),
    installedModels: normalizedModels,
  };
}

/**
 * Section 118: Backend Device Seat Limiter, Client State Sync & Emergency Model Revocation Service
 */
export class BackendLicenseAndModelRevocationService {
  constructor(
    private readonly db: PgPoolLike,
    private readonly adminApiSecretKey: string,
  ) {}

  public registerRoutes(fastify: FastifyInstanceLike): void {
    /**
     * 1. Enforce per-plan maximum active device seats for the authenticated account.
     * Subscription tier and seat allowance are derived exclusively from PostgreSQL
     * inside a pinned row-locked transaction; client-supplied planTier is ignored.
     */
    fastify.post<{
      Body: {
        currentDeviceFingerprintHash: string;
        userId?: string;
        planTier?: string;
      };
    }>('/api/v1/license/enforce-device-seat', async (request, reply) => {
      const authenticatedUserId =
        typeof request.authenticatedUserId === 'string' &&
        request.authenticatedUserId.trim().length > 0
          ? request.authenticatedUserId.trim()
          : null;

      if (!authenticatedUserId) {
        return reply.status(401).send({
          error: 'AUTHENTICATION_REQUIRED',
          messageFa: 'احراز هویت معتبر برای بررسی سهمیه دستگاه الزامی است.',
        });
      }

      const body = (request.body ?? {}) as {
        currentDeviceFingerprintHash?: unknown;
        userId?: unknown;
        planTier?: unknown;
      };

      if (body.userId !== undefined) {
        if (typeof body.userId !== 'string' || body.userId !== authenticatedUserId) {
          return reply.status(403).send({
            error: 'FORBIDDEN_USER_MISMATCH',
            messageFa: 'شناسه کاربر درخواست با هویت احراز‌شده مطابقت ندارد.',
          });
        }
      }

      let normalizedFingerprint: string;
      try {
        normalizedFingerprint = validateAndNormalizeDeviceFingerprintHash(
          body.currentDeviceFingerprintHash,
        );
      } catch (err) {
        return sendClassifiedLicenseError(reply, err);
      }

      try {
        const result = await withPinnedPostgresTransaction(this.db, (txClient) =>
          enforceDeviceSeatsForAuthenticatedUser(
            txClient,
            authenticatedUserId,
            normalizedFingerprint,
          ),
        );

        return reply.send({
          seatAllowed: result.seatAllowed,
          maxDevicesAllowed: result.maxDevicesAllowed,
          activeDevicesAfterEnforcement: result.activeDevicesAfterEnforcement,
          evictedOldDevicesCount: result.evictedOldDevicesCount,
        });
      } catch (err) {
        return sendClassifiedLicenseError(reply, err);
      }
    });

    /**
     * 2. Authenticated client state synchronization endpoint when online:
     * Queries lease ownership strictly bound to `authenticatedUserId`, returns
     * indistinguishable REVOKED status for unknown or foreign leases, and reports
     * REVOKED / DEPRECATED alerts for validated installed models.
     */
    fastify.post<{
      Body: {
        leaseId: string;
        installedModels: { modelId: string; version: string }[];
      };
    }>('/api/v1/license/sync-state', async (request, reply) => {
      const authenticatedUserId =
        typeof request.authenticatedUserId === 'string' &&
        request.authenticatedUserId.trim().length > 0
          ? request.authenticatedUserId.trim()
          : null;

      if (!authenticatedUserId) {
        return reply.status(401).send({
          error: 'AUTHENTICATION_REQUIRED',
          messageFa: 'احراز هویت معتبر برای همگام‌سازی وضعیت مجوز الزامی است.',
        });
      }

      const validated = validateSyncStatePayload(request.body);
      if (!validated) {
        return reply.status(400).send({
          error: 'INVALID_SYNC_STATE_REQUEST',
          messageFa: 'ساختار درخواست همگام‌سازی وضعیت مجوز نامعتبر است.',
        });
      }

      try {
        const leaseRes = await this.db.query<{
          revoked: boolean;
          offline_grace_expires_at: Date;
        }>(
          `SELECT revoked, offline_grace_expires_at
           FROM offline_license_leases
           WHERE lease_id = $1 AND user_id = $2`,
          [validated.leaseId, authenticatedUserId],
        );

        const leaseStatus =
          leaseRes.rows.length === 0 || leaseRes.rows[0].revoked
            ? 'REVOKED'
            : new Date(leaseRes.rows[0].offline_grace_expires_at).getTime() < Date.now()
              ? 'EXPIRED'
              : 'ACTIVE';

        const modelAlerts: { modelId: string; version: string; status: string }[] = [];
        for (const m of validated.installedModels) {
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
      } catch (err) {
        return sendClassifiedLicenseError(reply, err);
      }
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
