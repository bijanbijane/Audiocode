import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PgTransactionClient,
  PinnedPgClient,
  withPinnedPostgresTransaction,
} from './db/PinnedPostgresTransaction';
import {
  LicensePlanTier,
  enforceDeviceSeatsForAuthenticatedUser,
  sendClassifiedLicenseError,
  validateAndNormalizeDeviceFingerprintHash,
} from './license/DeviceSeatEnforcementService';

export type { PgTransactionClient, PinnedPgClient };

export interface AuthenticatedRequestContext {
  readonly authenticatedUserId?: string;
}

export interface BackendOfflineLicenseLeasePayload {
  readonly licenseId: string;
  readonly userId: string;
  readonly planTier: LicensePlanTier;
  readonly issuedAtUnixSec: number;
  readonly offlineGraceExpiresAtUnixSec: number;
  readonly subscriptionExpiresAtUnixSec: number;
  readonly allowedModelTiers: readonly ('GROUP_A' | 'GROUP_B')[];
  // Compatibility fields consumed by src/security/OfflineCryptoVerifier.ts.
  readonly displayName: string;
  readonly plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  readonly issuedAtMs: number;
  readonly offlineGraceExpiresAtMs: number;
  readonly deviceFingerprint: string;
}

export interface BackendSignedEnvelope<T> {
  readonly payload: T;
  readonly payloadCanonicalBase64: string;
  readonly ed25519SignatureHex: string;
  readonly keyId: string;
}

export interface BackendSignedOfflineLicenseEnvelope
  extends BackendSignedEnvelope<BackendOfflineLicenseLeasePayload> {
  readonly payloadBase64: string;
  readonly signatureBase64: string;
  readonly algorithm: 'Ed25519';
  readonly keyVersion: number;
  readonly decodedPreview: BackendOfflineLicenseLeasePayload;
}

export interface BackendLegacySignedEnvelope<T> {
  readonly payloadBase64: string;
  readonly signatureBase64: string;
  readonly algorithm: 'Ed25519';
  readonly keyVersion: number;
  readonly decodedPreview: T;
}

export type BackendModelTier = 'GROUP_A' | 'GROUP_B';
export type BackendModelLifecycleStatus = 'ACTIVE' | 'SUPPORTED' | 'DEPRECATED' | 'REVOKED';

export interface BackendLegacySignedModelManifest {
  readonly modelId: string;
  readonly version: string;
  readonly status: BackendModelLifecycleStatus;
  readonly tier: BackendModelTier;
  readonly totalBytes: number;
  readonly chunkSizeBytes: number;
  readonly chunks: readonly {
    readonly index: number;
    readonly url: string;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly sha256Hex: string;
  }[];
  readonly issuedAtMs: number;
}

export interface PgPoolLike {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
  connect?(): Promise<PinnedPgClient>;
}

export interface BackendRuntimeConfig {
  readonly modelStorageRootDir: string;
  readonly ed25519PrivateKeyPem: string;
  readonly keyId: string;
  readonly cdnBaseUrl: string;
  /** قانون ۳ سند معماری: در نسخه اول پردازش ابری روی سرور خاموش است */
  readonly enableServerSideAsrInference: boolean;
}

export interface FastifyReplyLike {
  status(code: number): FastifyReplyLike;
  header(name: string, value: string | number): FastifyReplyLike;
  send(payload: unknown): unknown;
}

export interface FastifyInstanceLike {
  get<
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
  ): void;
  post<
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
        headers: T extends { Headers: infer H } ? H : Record<string, string | undefined>;
      },
      reply: FastifyReplyLike,
    ) => Promise<unknown>,
  ): void;
}

export class PlatformBackendServices {
  private readonly privateKeyObj: crypto.KeyObject;
  private readonly publicKeySpkiBase64: string;

  constructor(
    private readonly db: PgPoolLike,
    private readonly config: BackendRuntimeConfig,
  ) {
    this.privateKeyObj = crypto.createPrivateKey(config.ed25519PrivateKeyPem);
    const publicKey = crypto.createPublicKey(this.privateKeyObj);
    this.publicKeySpkiBase64 = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }),
    ).toString('base64');
  }

  public getPublicKeyInfo(): {
    publicKeySpkiBase64: string;
    algorithm: 'Ed25519';
    keyVersion: number;
    keyId: string;
  } {
    return {
      publicKeySpkiBase64: this.publicKeySpkiBase64,
      algorithm: 'Ed25519',
      keyVersion: 1,
      keyId: this.config.keyId,
    };
  }

  /**
   * ثبت تمام مسیرهای رسمی API سرور Backend روی Fastify
   */
  public registerAllRoutes(fastify: FastifyInstanceLike): void {
    fastify.get('/api/v1/crypto/public-key', async (_request, reply) => {
      return reply.send(this.getPublicKeyInfo());
    });

    // ۱. صدور و تمدید گواهی اجاره آفلاین (Ed25519 Offline License Lease) بر اساس هویت احراز‌شده و تراکنش اتمی
    fastify.post<{
      Body: { deviceFingerprintHash: string; userId?: string; displayName?: string; deviceFingerprint?: string };
    }>('/api/v1/license/lease', async (request, reply) => {
      const authenticatedUserId =
        typeof request.authenticatedUserId === 'string' &&
        request.authenticatedUserId.trim().length > 0
          ? request.authenticatedUserId.trim()
          : null;

      if (!authenticatedUserId) {
        return reply.status(401).send({
          error: 'AUTHENTICATION_REQUIRED',
          messageFa: 'احراز هویت معتبر برای صدور مجوز الزامی است.',
        });
      }

      const body = (request.body ?? {}) as {
        deviceFingerprintHash?: unknown;
        userId?: unknown;
        displayName?: unknown;
        deviceFingerprint?: unknown;
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
          body.deviceFingerprintHash,
        );
      } catch (err) {
        return sendClassifiedLicenseError(reply, err);
      }

      let legacyDeviceFingerprint: string | null = null;
      if (body.deviceFingerprint !== undefined) {
        if (
          typeof body.deviceFingerprint !== 'string' ||
          body.deviceFingerprint.trim().length === 0 ||
          body.deviceFingerprint.trim().length > 512
        ) {
          return reply.status(400).send({ error: 'INVALID_DEVICE_FINGERPRINT' });
        }
        legacyDeviceFingerprint = body.deviceFingerprint.trim();
        const derivedHash = crypto
          .createHash('sha256')
          .update(legacyDeviceFingerprint, 'utf8')
          .digest('hex');
        const expectedBytes = Buffer.from(normalizedFingerprint, 'utf8');
        const derivedBytes = Buffer.from(derivedHash, 'utf8');
        if (
          expectedBytes.byteLength !== derivedBytes.byteLength ||
          !crypto.timingSafeEqual(expectedBytes, derivedBytes)
        ) {
          return reply.status(403).send({ error: 'DEVICE_FINGERPRINT_HASH_MISMATCH' });
        }
      }

      try {
        const leasePayload = await withPinnedPostgresTransaction(this.db, async (txClient) => {
          const seatResult = await enforceDeviceSeatsForAuthenticatedUser(
            txClient,
            authenticatedUserId,
            normalizedFingerprint,
          );
          const sub = seatResult.subscription;
          const nowSec = Math.floor(Date.now() / 1000);
          const subEndSec = Math.floor(sub.currentPeriodEnd.getTime() / 1000);
          // A paid offline entitlement remains valid for the full paid period.
          // offline_grace_hours is not used to truncate already-paid local access.
          const offlineEntitlementEndSec = subEndSec;
          // The PostgreSQL lease_id column is UUID; do not prefix the stored value.
          const leaseId = crypto.randomUUID();
          const legacyPlan =
            sub.planTier === 'FREE_TRIAL'
              ? 'FREE'
              : sub.planTier === 'STUDIO_ENTERPRISE'
                ? 'ENTERPRISE'
                : 'PRO';
          const displayName =
            typeof body.displayName === 'string' && body.displayName.trim().length > 0
              ? body.displayName.trim().slice(0, 128)
              : authenticatedUserId;

          await txClient.query(
            `INSERT INTO offline_license_leases
             (lease_id, user_id, subscription_id, device_fingerprint_hash, signing_key_id, offline_grace_expires_at)
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
            [
              leaseId,
              authenticatedUserId,
              sub.id,
              seatResult.normalizedDeviceFingerprintHash,
              this.config.keyId,
              offlineEntitlementEndSec,
            ],
          );

          const issuedAtMs = Date.now();
          const offlineEntitlementEndMs = offlineEntitlementEndSec * 1000;
          const allowedModelTiers: readonly ('GROUP_A' | 'GROUP_B')[] =
            legacyPlan === 'FREE' ? ['GROUP_A'] : ['GROUP_A', 'GROUP_B'];
          const payload: BackendOfflineLicenseLeasePayload = {
            licenseId: leaseId,
            userId: authenticatedUserId,
            planTier: sub.planTier,
            issuedAtUnixSec: nowSec,
            offlineGraceExpiresAtUnixSec: offlineEntitlementEndSec,
            subscriptionExpiresAtUnixSec: subEndSec,
            allowedModelTiers,
            displayName,
            plan: legacyPlan,
            issuedAtMs,
            offlineGraceExpiresAtMs: offlineEntitlementEndMs,
            deviceFingerprint: legacyDeviceFingerprint ?? seatResult.normalizedDeviceFingerprintHash,
          };
          return payload;
        });

        // Ed25519 envelope signing runs strictly after COMMIT succeeds.
        return reply.send(this.signOfflineLicenseLeaseEnvelope(leasePayload));
      } catch (err) {
        return sendClassifiedLicenseError(reply, err);
      }
    });

    // ۲. دریافت کاتالوگ مدل‌های فارسی فعال (حذف خودکار مدل‌های REVOKED)
    fastify.get('/api/v1/models/catalog', async (_request, reply) => {
      const res = await this.db.query(
        `SELECT model_id, version, task_type, tier_group, release_status, spdx_license,
                quantization_format, min_ram_mb, recommended_ram_mb, total_size_bytes
         FROM ai_models_catalog
         WHERE release_status IN ('ACTIVE', 'SUPPORTED', 'LIMITED_RELEASE')
         ORDER BY created_at DESC`,
      );
      return reply.send({ models: res.rows });
    });

    // Legacy browser-compatible manifest route backed by the PostgreSQL catalog.
    fastify.get<{ Params: { modelId: string } }>(
      '/api/v1/models/:modelId/manifest',
      async (request, reply) => {
        const modelId = request.params.modelId.trim();
        if (!modelId || !/^[a-zA-Z0-9_-]{1,64}$/.test(modelId)) {
          return reply.status(400).send({ error: 'INVALID_MODEL_ID' });
        }

        const catalogResult = await this.db.query<{
          version: string;
          release_status: string;
          tier_group: string;
          total_size_bytes: string | number;
        }>(
          `SELECT version, release_status, tier_group, total_size_bytes
           FROM ai_models_catalog
           WHERE model_id = $1
             AND release_status IN ('ACTIVE', 'SUPPORTED', 'DEPRECATED', 'REVOKED')
           ORDER BY created_at DESC
           LIMIT 1`,
          [modelId],
        );

        if (catalogResult.rows.length === 0) {
          return reply.status(404).send({ error: 'MODEL_NOT_FOUND', modelId });
        }

        const entry = catalogResult.rows[0];
        if (!['GROUP_A', 'GROUP_B'].includes(entry.tier_group)) {
          return reply.status(409).send({ error: 'MODEL_TIER_UNSUPPORTED_BY_LEGACY_CLIENT', modelId });
        }
        if (!['ACTIVE', 'SUPPORTED', 'DEPRECATED', 'REVOKED'].includes(entry.release_status)) {
          return reply.status(409).send({ error: 'MODEL_STATUS_UNSUPPORTED_BY_LEGACY_CLIENT', modelId });
        }

        const chunkResult = await this.db.query<{
          chunk_index: number;
          sha256_hex: string;
          byte_length: number;
        }>(
          `SELECT chunk_index, sha256_hex, byte_length
           FROM ai_model_chunks
           WHERE model_id = $1 AND version = $2
           ORDER BY chunk_index ASC`,
          [modelId, entry.version],
        );
        if (chunkResult.rows.length === 0) {
          return reply.status(404).send({
            error: 'MODEL_MANIFEST_CHUNKS_NOT_FOUND',
            modelId,
            version: entry.version,
          });
        }

        const expectedTotalBytes = Number(entry.total_size_bytes);
        const hasInvalidChunk = chunkResult.rows.some((chunk, index) =>
          !Number.isSafeInteger(chunk.chunk_index) ||
          chunk.chunk_index !== index ||
          !Number.isSafeInteger(chunk.byte_length) ||
          chunk.byte_length <= 0 ||
          !/^[a-f0-9]{64}$/i.test(chunk.sha256_hex),
        );
        const actualTotalBytes = chunkResult.rows.reduce(
          (sum, chunk) => sum + chunk.byte_length,
          0,
        );
        if (
          !Number.isSafeInteger(expectedTotalBytes) ||
          expectedTotalBytes <= 0 ||
          hasInvalidChunk ||
          !Number.isSafeInteger(actualTotalBytes) ||
          actualTotalBytes !== expectedTotalBytes
        ) {
          return reply.status(409).send({
            error: 'MODEL_MANIFEST_INTEGRITY_MISMATCH',
            modelId,
            version: entry.version,
          });
        }

        let byteOffset = 0;
        const chunks = chunkResult.rows.map((chunk) => {
          const offset = byteOffset;
          byteOffset += chunk.byte_length;
          return {
            index: chunk.chunk_index,
            url: `${this.config.cdnBaseUrl.replace(/\\/+$/, '')}/api/v1/models/${encodeURIComponent(modelId)}/${encodeURIComponent(entry.version)}/chunks/${chunk.chunk_index}`,
            byteOffset: offset,
            byteLength: chunk.byte_length,
            sha256Hex: chunk.sha256_hex,
          };
        });

        const payload: BackendLegacySignedModelManifest = {
          modelId,
          version: entry.version,
          status: entry.release_status as BackendModelLifecycleStatus,
          tier: entry.tier_group as BackendModelTier,
          totalBytes: Number(entry.total_size_bytes),
          chunkSizeBytes: Math.max(...chunks.map((chunk) => chunk.byteLength)),
          chunks,
          issuedAtMs: Date.now(),
        };
        return reply.send(this.signLegacyEnvelope(payload));
      },
    );

    // ۳. دریافت مانیفست امضاشده یک مدل همراه با فهرست قطعات 8MB (بخش ۴۰)
    fastify.get<{ Params: { modelId: string; version: string } }>(
      '/api/v1/models/:modelId/:version/manifest',
      async (request, reply) => {
        const { modelId, version } = request.params;

        const catRes = await this.db.query<{
          release_status: string;
          spdx_license: string;
          min_ram_mb: number;
          quantization_format: string;
          total_size_bytes: string;
        }>(
          `SELECT release_status, spdx_license, min_ram_mb, quantization_format, total_size_bytes
           FROM ai_models_catalog
           WHERE model_id = $1 AND version = $2`,
          [modelId, version],
        );

        if (catRes.rows.length === 0) {
          return reply.status(404).send({ error: 'MODEL_VERSION_NOT_FOUND' });
        }
        const meta = catRes.rows[0];
        if (meta.release_status === 'REVOKED') {
          return reply.status(410).send({
            error: 'MODEL_VERSION_REVOKED',
            messageFa: 'این نسخه از مدل به دلایل امنیتی یا کیفی ابطال شده است.',
          });
        }

        const chunksRes = await this.db.query<{
          chunk_index: number;
          sha256_hex: string;
          byte_length: number;
        }>(
          `SELECT chunk_index, sha256_hex, byte_length
           FROM ai_model_chunks
           WHERE model_id = $1 AND version = $2
           ORDER BY chunk_index ASC`,
          [modelId, version],
        );

        const manifestPayload = {
          modelId,
          version,
          status: meta.release_status,
          license: meta.spdx_license,
          minRamMb: meta.min_ram_mb,
          quantization: meta.quantization_format,
          totalBytes: Number(meta.total_size_bytes),
          chunks: chunksRes.rows.map((c) => ({
            index: c.chunk_index,
            url: `${this.config.cdnBaseUrl.replace(/\\/+$/, '')}/api/v1/models/${modelId}/${version}/chunks/${c.chunk_index}`,
            sha256Hex: c.sha256_hex,
            byteLength: c.byte_length,
          })),
        };

        return reply.send(this.signEnvelope(manifestPayload));
      },
    );

    // ۴. سروینگ جریانی قطعات مدل با پشتیبانی کامل از HTTP 206 Byte-Range Resume
    fastify.get<{ Params: { modelId: string; version: string; chunkIndex: string } }>(
      '/api/v1/models/:modelId/:version/chunks/:chunkIndex',
      async (request, reply) => {
        const { modelId, version, chunkIndex } = request.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(modelId)) {
          return reply.status(400).send({ error: 'INVALID_MODEL_ID' });
        }
        if (!/^[a-zA-Z0-9._-]{1,32}$/.test(version)) {
          return reply.status(400).send({ error: 'INVALID_MODEL_VERSION' });
        }
        if (!/^(0|[1-9][0-9]{0,8})$/.test(chunkIndex)) {
          return reply.status(400).send({ error: 'INVALID_CHUNK_INDEX' });
        }
        const safeIdx = Number(chunkIndex);
        if (!Number.isSafeInteger(safeIdx)) {
          return reply.status(400).send({ error: 'INVALID_CHUNK_INDEX' });
        }

        // Re-check the authoritative catalog state at download time. A signed
        // REVOKED manifest is useful to clients, but the server must never serve
        // the underlying revoked model bytes.
        const modelState = await this.db.query<{ release_status: string }>(
          `SELECT release_status
           FROM ai_models_catalog
           WHERE model_id = $1 AND version = $2`,
          [modelId, version],
        );
        if (modelState.rows.length === 0) {
          return reply.status(404).send({ error: 'MODEL_VERSION_NOT_FOUND' });
        }
        if (modelState.rows[0].release_status === 'REVOKED') {
          return reply.status(410).send({ error: 'MODEL_VERSION_REVOKED' });
        }

        // Both path segments have strict allow-list validation before joining.
        const safeModel = modelId;
        const safeVer = version;
        const fileName = `chunk_${String(safeIdx).padStart(4, '0')}.bin`;
        const fullPath = path.join(
          this.config.modelStorageRootDir,
          safeModel,
          safeVer,
          fileName,
        );

        if (!fs.existsSync(fullPath)) {
          return reply.status(404).send({ error: 'CHUNK_FILE_NOT_FOUND' });
        }

        const stat = fs.statSync(fullPath);
        const totalSize = stat.size;
        const rangeHeader = request.headers.range;

        reply.header('Accept-Ranges', 'bytes');
        reply.header('Cross-Origin-Resource-Policy', 'same-origin');
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        reply.header('Content-Type', 'application/octet-stream');

        if (rangeHeader) {
          const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
          if (!match) {
            return reply.status(416).send({ error: 'RANGE_NOT_SATISFIABLE' });
          }
          const start = parseInt(match[1], 10);
          const end = match[2]
            ? Math.min(totalSize - 1, parseInt(match[2], 10))
            : totalSize - 1;
          if (start >= totalSize || start > end) {
            return reply.status(416).send({ error: 'RANGE_NOT_SATISFIABLE' });
          }

          reply.status(206);
          reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
          reply.header('Content-Length', end - start + 1);
          return reply.send(fs.createReadStream(fullPath, { start, end }));
        }

        reply.header('Content-Length', totalSize);
        return reply.send(fs.createReadStream(fullPath));
      },
    );

    // ۵. ثبت متریک‌های توزیع مدل (بخش ۵۷ - بدون دریافت هیچ صوت یا متنی از پروژه کاربر)
    fastify.post<{
      Body: {
        modelId: string;
        version: string;
        eventType: 'CHUNK_DOWNLOAD_OK' | 'CHUNK_FAILURE' | 'RESUME_SUCCESS' | 'CACHE_HIT';
        chunkIndex?: number;
        bytesTransferred: number;
        deviceTier?: string;
      };
    }>('/api/v1/telemetry/model-delivery', async (request, reply) => {
      const b = request.body;
      await this.db.query(
        `INSERT INTO model_delivery_telemetry
         (model_id, version, event_type, chunk_index, bytes_transferred, device_tier)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          b.modelId,
          b.version,
          b.eventType,
          b.chunkIndex ?? null,
          b.bytesTransferred,
          b.deviceTier ?? null,
        ],
      );
      return reply.status(202).send({ accepted: true });
    });

    // ۶. نقطه اتصال استنتاج در Node.js (غیرفعال در نسخه اول وب طبق قانون ۳؛ قابل فعال‌سازی فقط در محیط Desktop/Cloud آینده)
    fastify.post('/api/v1/asr/transcribe-chunk', async (_request, reply) => {
      if (!this.config.enableServerSideAsrInference) {
        return reply.status(501).send({
          error: 'CLOUD_ASR_DISABLED_IN_V1',
          messageFa:
            'مطابق قانون پردازش محلی نسخه اول، استنتاج تشخیص گفتار روی دستگاه کاربر انجام می‌شود.',
        });
      }
      return reply.status(200).send({ ready: true });
    });
  }

  public signLegacyEnvelope<T>(payload: T): BackendLegacySignedEnvelope<T> {
    const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const signature = crypto.sign(null, Buffer.from(payloadBase64, 'utf8'), this.privateKeyObj);
    return {
      payloadBase64,
      signatureBase64: signature.toString('base64'),
      algorithm: 'Ed25519',
      keyVersion: 1,
      decodedPreview: payload,
    };
  }

  public signOfflineLicenseLeaseEnvelope(
    payload: BackendOfflineLicenseLeasePayload,
  ): BackendSignedOfflineLicenseEnvelope {
    const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const signature = crypto.sign(
      null,
      Buffer.from(payloadBase64, 'utf8'),
      this.privateKeyObj,
    );
    return {
      payload,
      payloadCanonicalBase64: payloadBase64,
      ed25519SignatureHex: signature.toString('hex'),
      keyId: this.config.keyId,
      // Exact envelope fields expected by the current OfflineCryptoVerifier.
      payloadBase64,
      signatureBase64: signature.toString('base64'),
      algorithm: 'Ed25519',
      keyVersion: 1,
      decodedPreview: payload,
    };
  }

  public signEnvelope<T>(payload: T): BackendSignedEnvelope<T> {
    const canonicalJson = JSON.stringify(payload);
    const payloadCanonicalBase64 = Buffer.from(canonicalJson, 'utf8').toString('base64');
    const signature = crypto.sign(
      null,
      Buffer.from(payloadCanonicalBase64, 'utf8'),
      this.privateKeyObj,
    );

    return {
      payload,
      payloadCanonicalBase64,
      ed25519SignatureHex: signature.toString('hex'),
      keyId: this.config.keyId,
    };
  }
}
