import type { FastifyInstanceLike, PgPoolLike } from '../PlatformBackendServices';
import { EnterpriseApiKeyAndQuotaManager } from '../auth/EnterpriseApiKeyAndQuotaManager';
import { BackendAsrJobQueueAndPool } from '../queue/BackendAsrJobQueueAndPool';
import { BackendTranscriptFormatterAndWebhookService } from '../delivery/BackendTranscriptFormatterAndWebhookService';
import { PraatTextGridAndLinguisticExporter } from '../../../src/ai-engine/asr/PraatTextGridAndLinguisticExporter';
import { TimedPersianToken } from '../../../src/ai-engine/PersianTextNormalizer';

export interface CompletedAsrJobArtifactStore {
  getCompletedTokensForJob(jobId: string): Promise<{
    audioDurationSec: number;
    tokens: TimedPersianToken[];
    organizationId?: string;
  } | null>;
}

export class BackendBatchHttpSubmissionController {
  private readonly jobQueue: BackendAsrJobQueueAndPool;

  constructor(
    private readonly db: PgPoolLike,
    private readonly quotaManager: EnterpriseApiKeyAndQuotaManager,
    private readonly artifactStore: CompletedAsrJobArtifactStore,
    private readonly enableServerSideAsrInference: boolean
  ) {
    this.jobQueue = new BackendAsrJobQueueAndPool(db, enableServerSideAsrInference);
  }

  public registerRoutes(fastify: FastifyInstanceLike): void {
    /**
     * 1. Enqueues an enterprise batch ASR job after API key scope verification and atomic quota deduction.
     */
    fastify.post<{
      Headers: { 'x-enterprise-api-key'?: string };
      Body: {
        modelId?: string;
        audioDurationSeconds?: number;
        remoteStorageRef?: string;
      };
    }>('/api/v1/enterprise/asr/jobs', async (request, reply) => {
      if (!this.enableServerSideAsrInference) {
        return reply.status(501).send({
          error: 'CLOUD_ASR_DISABLED_IN_V1',
          messageFa: 'طبق قانون ۳ معماری، ثبت کارهای ASR ابری سمت سرور در نسخه اول غیرفعال است.',
        });
      }

      const rawKey = request.headers['x-enterprise-api-key'] ?? '';
      let keyCtx;
      try {
        keyCtx = await this.quotaManager.authenticateAndAuthorizeScope(
          rawKey,
          'CLOUD_ASR_ENTERPRISE'
        );
      } catch (err) {
        return reply.status(401).send({
          error: err instanceof Error ? err.message : 'UNAUTHORIZED',
        });
      }

      const b = request.body;
      if (
        !b ||
        typeof b.modelId !== 'string' ||
        b.modelId.trim().length === 0 ||
        typeof b.remoteStorageRef !== 'string' ||
        b.remoteStorageRef.trim().length === 0 ||
        typeof b.audioDurationSeconds !== 'number' ||
        !Number.isFinite(b.audioDurationSeconds) ||
        b.audioDurationSeconds <= 0
      ) {
        return reply.status(400).send({ error: 'INVALID_ASR_JOB_REQUEST' });
      }

      const quotaRes = await this.quotaManager.consumeAudioQuotaAtomically(
        keyCtx.keyId,
        b.audioDurationSeconds
      );
      if (!quotaRes.approved) {
        return reply.status(429).send({
          error: 'ENTERPRISE_MONTHLY_QUOTA_EXHAUSTED',
          messageFa: 'سهمیه صوتی ماهانه این کلید سازمانی کافی نیست.',
        });
      }

      let enqueued: { jobId: string; estimatedCreditsCost: number };
      try {
        enqueued = await this.jobQueue.enqueueJobWithAdmissionControl({
          userId: keyCtx.organizationId,
          modelId: b.modelId.trim(),
          audioDurationSeconds: b.audioDurationSeconds,
          remoteStorageRef: b.remoteStorageRef.trim(),
        });
      } catch (err) {
        // Refund deducted quota atomically when admission control or enqueue fails
        await this.quotaManager
          .refundAudioQuotaAtomically(keyCtx.keyId, b.audioDurationSeconds)
          .catch(() => {});
        const msg = err instanceof Error ? err.message : 'ENQUEUE_FAILED';
        if (msg.startsWith('ADMISSION_REJECTED_QUOTA')) {
          return reply.status(429).send({ error: 'ADMISSION_REJECTED_QUOTA', detail: msg });
        }
        if (
          msg.startsWith('INVALID_CLOUD_JOB_ENQUEUE_REQUEST') ||
          msg.startsWith('CLOUD_RUNTIME_DISABLED_IN_V1')
        ) {
          return reply.status(400).send({ error: 'JOB_ENQUEUE_REJECTED', detail: msg });
        }
        return reply.status(500).send({ error: 'JOB_ENQUEUE_FAILED' });
      }

      return reply.status(202).send({
        jobId: enqueued.jobId,
        status: 'QUEUED',
        remainingOrganizationQuotaSeconds: quotaRes.remainingSeconds,
      });
    });

    /**
     * 2. Exports a completed enterprise ASR job in JSON, SRT, Praat TextGrid, or NIST CTM format.
     */
    fastify.get<{
      Headers: { 'x-enterprise-api-key'?: string };
      Params: { jobId: string };
      Querystring: { format?: 'json' | 'srt' | 'textgrid' | 'ctm' };
    }>('/api/v1/enterprise/asr/jobs/:jobId/export', async (request, reply) => {
      const rawKey = request.headers['x-enterprise-api-key'] ?? '';
      let keyCtx;
      try {
        keyCtx = await this.quotaManager.authenticateAndAuthorizeScope(
          rawKey,
          'CLOUD_ASR_ENTERPRISE'
        );
      } catch (err) {
        return reply.status(401).send({
          error: err instanceof Error ? err.message : 'UNAUTHORIZED',
        });
      }

      const jobId = typeof request.params?.jobId === 'string' ? request.params.jobId.trim() : '';
      if (jobId.length === 0) {
        return reply.status(400).send({ error: 'INVALID_JOB_ID' });
      }

      const rawFmt = request.query?.format;
      const fmt = rawFmt === undefined ? 'json' : rawFmt;
      if (fmt !== 'json' && fmt !== 'srt' && fmt !== 'textgrid' && fmt !== 'ctm') {
        return reply.status(400).send({ error: 'UNSUPPORTED_EXPORT_FORMAT' });
      }

      const artifact = await this.artifactStore.getCompletedTokensForJob(jobId);
      if (!artifact) {
        return reply.status(404).send({ error: 'JOB_ARTIFACT_NOT_FOUND' });
      }
      if (artifact.organizationId && artifact.organizationId !== keyCtx.organizationId) {
        return reply.status(403).send({ error: 'FORBIDDEN_TENANT_MISMATCH' });
      }

      if (fmt === 'srt') {
        reply.header('Content-Type', 'application/x-subrip; charset=utf-8');
        return reply.send(
          BackendTranscriptFormatterAndWebhookService.formatTokensToPersianSrt(artifact.tokens)
        );
      }
      if (fmt === 'textgrid') {
        reply.header('Content-Type', 'text/plain; charset=utf-8');
        return reply.send(
          PraatTextGridAndLinguisticExporter.exportToPraatTextGrid({
            totalAudioDurationSec: artifact.audioDurationSec,
            tokens: artifact.tokens,
          })
        );
      }
      if (fmt === 'ctm') {
        reply.header('Content-Type', 'text/plain; charset=utf-8');
        return reply.send(
          PraatTextGridAndLinguisticExporter.exportToNistCtm(
            jobId,
            artifact.tokens,
            1
          )
        );
      }

      return reply.send({
        jobId,
        audioDurationSec: artifact.audioDurationSec,
        tokens: artifact.tokens,
      });
    });
  }
}
