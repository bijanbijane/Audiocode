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
        modelId: string;
        audioDurationSeconds: number;
        remoteStorageRef: string;
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

      const quotaRes = await this.quotaManager.consumeAudioQuotaAtomically(
        keyCtx.keyId,
        request.body.audioDurationSeconds
      );
      if (!quotaRes.approved) {
        return reply.status(429).send({
          error: 'ENTERPRISE_MONTHLY_QUOTA_EXHAUSTED',
          messageFa: 'سهمیه صوتی ماهانه این کلید سازمانی کافی نیست.',
        });
      }

      const enqueued = await this.jobQueue.enqueueJobWithAdmissionControl({
        userId: keyCtx.organizationId,
        modelId: request.body.modelId,
        audioDurationSeconds: request.body.audioDurationSeconds,
        remoteStorageRef: request.body.remoteStorageRef,
      });

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
      try {
        await this.quotaManager.authenticateAndAuthorizeScope(
          rawKey,
          'CLOUD_ASR_ENTERPRISE'
        );
      } catch (err) {
        return reply.status(401).send({
          error: err instanceof Error ? err.message : 'UNAUTHORIZED',
        });
      }

      const artifact = await this.artifactStore.getCompletedTokensForJob(request.params.jobId);
      if (!artifact) {
        return reply.status(404).send({ error: 'JOB_ARTIFACT_NOT_FOUND' });
      }

      const fmt = request.query.format ?? 'json';
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
            request.params.jobId,
            artifact.tokens,
            1
          )
        );
      }

      return reply.send({
        jobId: request.params.jobId,
        audioDurationSec: artifact.audioDurationSec,
        tokens: artifact.tokens,
      });
    });
  }
}
