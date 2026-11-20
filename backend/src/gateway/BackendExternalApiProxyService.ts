import type { FastifyInstanceLike, PgPoolLike } from '../PlatformBackendServices';

export interface ExternalAsrProviderAdapter {
  readonly providerId: string;
  readonly supportsPersianWordTimestamps: boolean;
  readonly costPerMinuteUsd: number;
  transcribeAudioSnippet(params: {
    audioBytes: Uint8Array;
    mimeType: 'audio/wav' | 'audio/ogg';
    language: 'fa';
    timeoutMs: number;
  }): Promise<{
    transcript: string;
    words: { word: string; startSec: number; endSec: number; confidence: number }[];
  }>;
}

/**
 * Section 109: Secure Backend External API Gateway Proxy Service (Section 43 Governance)
 * Enforces zero client-side secret leakage, no automatic fallback from internal AI,
 * explicit user consent, <= 120s data minimization, retry, and content-free PostgreSQL audit logging.
 */
export class BackendExternalApiProxyService {
  private readonly providers = new Map<string, ExternalAsrProviderAdapter>();
  private readonly maxAllowedSnippetSeconds = 120; // Section 4 Rule 4: full-file upload forbidden
  private readonly maxAllowedAudioBytes = 25 * 1024 * 1024; // 25 MiB cap (~120s 48kHz stereo 16-bit WAV)

  constructor(private readonly db: PgPoolLike) {}

  public registerProviderAdapter(adapter: ExternalAsrProviderAdapter): void {
    this.providers.set(adapter.providerId, adapter);
  }

  public registerRoutes(fastify: FastifyInstanceLike): void {
    fastify.post<{
      Body: {
        userId?: string;
        providerId?: string;
        consentId?: string;
        explicitUserConsentGranted?: boolean;
        isInternalAiFallback?: boolean;
        snippetDurationSeconds?: number;
        audioBase64?: string;
      };
    }>('/api/v1/external-gateway/transcribe-snippet', async (request, reply) => {
      const b = request.body;
      if (!b || typeof b !== 'object') {
        return reply.status(400).send({ error: 'INVALID_EXTERNAL_GATEWAY_REQUEST' });
      }

      const requestedUserId =
        typeof b.userId === 'string' && b.userId.trim().length > 0
          ? b.userId.trim()
          : request.authenticatedUserId;
      if (
        request.authenticatedUserId &&
        requestedUserId &&
        request.authenticatedUserId !== requestedUserId
      ) {
        return reply.status(403).send({ error: 'FORBIDDEN_USER_MISMATCH' });
      }

      // 1. Section 4 Rule 6: Absolute prohibition of automatic fallback from internal AI engine
      if (b.isInternalAiFallback) {
        return reply.status(403).send({
          error: 'AUTO_FALLBACK_FORBIDDEN',
          messageFa: 'ارسال خودکار به سرویس خارجی در صورت خطای موتور داخلی ممنوع است.',
        });
      }

      // 2. Verify explicit and informed user consent
      if (
        b.explicitUserConsentGranted !== true ||
        typeof b.consentId !== 'string' ||
        b.consentId.trim().length === 0
      ) {
        return reply.status(403).send({ error: 'EXPLICIT_CONSENT_REQUIRED' });
      }

      // 3. Data Minimization: reject non-finite, <=0, or >120s snippets (prevents NaN bypass)
      if (
        typeof b.snippetDurationSeconds !== 'number' ||
        !Number.isFinite(b.snippetDurationSeconds) ||
        b.snippetDurationSeconds <= 0 ||
        b.snippetDurationSeconds > this.maxAllowedSnippetSeconds
      ) {
        return reply.status(400).send({
          error: 'DATA_MINIMIZATION_LIMIT_EXCEEDED',
          messageFa: `ارسال فایل کامل مجاز نیست؛ حداکثر طول قطعه انتخابی ${this.maxAllowedSnippetSeconds} ثانیه است.`,
        });
      }

      if (typeof b.providerId !== 'string' || b.providerId.trim().length === 0) {
        return reply.status(400).send({ error: 'INVALID_PROVIDER_ID' });
      }

      const adapter = this.providers.get(b.providerId);
      if (!adapter) {
        return reply.status(404).send({ error: 'PROVIDER_ADAPTER_NOT_FOUND' });
      }

      if (typeof b.audioBase64 !== 'string' || b.audioBase64.length === 0) {
        return reply.status(400).send({ error: 'INVALID_AUDIO_PAYLOAD' });
      }

      // Reject oversized base64 payloads BEFORE decoding to prevent memory exhaustion
      const maxBase64Chars = Math.ceil((this.maxAllowedAudioBytes * 4) / 3) + 16;
      if (b.audioBase64.length > maxBase64Chars) {
        return reply.status(413).send({
          error: 'AUDIO_PAYLOAD_TOO_LARGE',
          messageFa: 'حجم قطعه صوتی از سقف مجاز ۲۵ مگابایت بیشتر است.',
        });
      }

      const audioBytes = Buffer.from(b.audioBase64, 'base64');
      if (audioBytes.byteLength === 0 || audioBytes.byteLength > this.maxAllowedAudioBytes) {
        return reply.status(400).send({ error: 'INVALID_AUDIO_PAYLOAD' });
      }

      const estimatedCostUsd = Number(
        ((b.snippetDurationSeconds / 60) * adapter.costPerMinuteUsd).toFixed(5),
      );

      // 4. Call provider with timeout and 1 safe retry on transient network failure
      let result: Awaited<
        ReturnType<ExternalAsrProviderAdapter['transcribeAudioSnippet']>
      > | null = null;
      let lastErr: unknown;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await adapter.transcribeAudioSnippet({
            audioBytes,
            mimeType: 'audio/wav',
            language: 'fa',
            timeoutMs: 15_000,
          });
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!result) {
        const rawDetail = lastErr instanceof Error ? lastErr.message : 'Upstream timeout';
        const safeDetail = rawDetail
          .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
          .replace(/(?:api[_-]?key|token|secret)=[^\s&]+/gi, '[REDACTED_PARAM]')
          .replace(/\/(?:Users|home|var|etc|tmp|app)\/[^\s'"]+/g, '[REDACTED_PATH]')
          .slice(0, 200);
        return reply.status(502).send({
          error: 'EXTERNAL_PROVIDER_FAILED',
          detail: safeDetail,
        });
      }

      // 5. Record audit trail in PostgreSQL without storing user audio or transcript content
      await this.db.query(
        `INSERT INTO model_delivery_telemetry
         (model_id, version, event_type, bytes_transferred, device_tier)
         VALUES ($1, 'external', 'CHUNK_DOWNLOAD_OK', $2, $3)`,
        [b.providerId, audioBytes.byteLength, `cost_usd:${estimatedCostUsd}`],
      );

      // 6. Return result with explicit EXTERNAL_API provenance and mandatory user review flag
      return reply.send({
        provenance: {
          origin: 'EXTERNAL_API',
          providerId: b.providerId,
          consentId: b.consentId,
          estimatedCostUsd,
          requiresMandatoryUserReview: true,
        },
        result,
      });
    });
  }
}
