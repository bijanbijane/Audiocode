import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface BackendOfflineLicenseLeasePayload {
  readonly licenseId: string;
  readonly userId: string;
  readonly planTier: 'PRO_MONTHLY' | 'PRO_ANNUAL' | 'STUDIO_ENTERPRISE';
  readonly issuedAtUnixSec: number;
  readonly offlineGraceExpiresAtUnixSec: number;
  readonly subscriptionExpiresAtUnixSec: number;
  readonly allowedModelTiers: readonly ('GROUP_A' | 'GROUP_B')[];
}

export interface BackendSignedEnvelope<T> {
  readonly payload: T;
  readonly payloadCanonicalBase64: string;
  readonly ed25519SignatureHex: string;
  readonly keyId: string;
}

export interface PgPoolLike {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
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
      request: {
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
      request: {
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

  constructor(
    private readonly db: PgPoolLike,
    private readonly config: BackendRuntimeConfig,
  ) {
    this.privateKeyObj = crypto.createPrivateKey(config.ed25519PrivateKeyPem);
  }

  /**
   * ثبت تمام مسیرهای رسمی API سرور Backend روی Fastify
   */
  public registerAllRoutes(fastify: FastifyInstanceLike): void {
    // ۱. صدور و تمدید گواهی اجاره آفلاین (Ed25519 Offline License Lease) بر اساس وضعیت اشتراک در PostgreSQL
    fastify.post<{
      Body: { userId: string; deviceFingerprintHash: string };
    }>('/api/v1/license/lease', async (request, reply) => {
      const { userId, deviceFingerprintHash } = request.body;

      const subRes = await this.db.query<{
        id: string;
        plan_tier: 'PRO_MONTHLY' | 'PRO_ANNUAL' | 'STUDIO_ENTERPRISE';
        current_period_end: Date;
        offline_grace_hours: number;
      }>(
        `SELECT id, plan_tier, current_period_end, offline_grace_hours
         FROM subscriptions
         WHERE user_id = $1 AND status = 'ACTIVE' AND current_period_end > NOW()
         ORDER BY current_period_end DESC
         LIMIT 1`,
        [userId],
      );

      if (subRes.rows.length === 0) {
        return reply.status(403).send({
          error: 'NO_ACTIVE_SUBSCRIPTION',
          messageFa: 'اشتراک فعالی برای این حساب کاربری یافت نشد.',
        });
      }

      const sub = subRes.rows[0];
      const nowSec = Math.floor(Date.now() / 1000);
      const subEndSec = Math.floor(new Date(sub.current_period_end).getTime() / 1000);
      const graceEndSec = Math.min(subEndSec, nowSec + sub.offline_grace_hours * 3600);
      const leaseId = `lic_${crypto.randomUUID()}`;

      await this.db.query(
        `INSERT INTO offline_license_leases
         (lease_id, user_id, subscription_id, device_fingerprint_hash, signing_key_id, offline_grace_expires_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
        [leaseId, userId, sub.id, deviceFingerprintHash, this.config.keyId, graceEndSec],
      );

      const leasePayload: BackendOfflineLicenseLeasePayload = {
        licenseId: leaseId,
        userId,
        planTier: sub.plan_tier,
        issuedAtUnixSec: nowSec,
        offlineGraceExpiresAtUnixSec: graceEndSec,
        subscriptionExpiresAtUnixSec: subEndSec,
        allowedModelTiers: ['GROUP_A', 'GROUP_B'],
      };

      return reply.send(this.signEnvelope(leasePayload));
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
            url: `${this.config.cdnBaseUrl}/api/v1/models/${modelId}/${version}/chunks/${c.chunk_index}`,
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
        const safeIdx = parseInt(chunkIndex, 10);
        if (!Number.isInteger(safeIdx) || safeIdx < 0) {
          return reply.status(400).send({ error: 'INVALID_CHUNK_INDEX' });
        }

        // جلوگیری از Path Traversal
        const safeModel = modelId.replace(/[^a-zA-Z0-9_-]/g, '');
        const safeVer = version.replace(/[^a-zA-Z0-9._-]/g, '');
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
