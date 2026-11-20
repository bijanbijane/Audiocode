import type { PgPoolLike } from '../PlatformBackendServices';

export interface CloudJobEnqueueRequest {
  readonly userId: string;
  readonly modelId: string;
  readonly audioDurationSeconds: number;
  readonly remoteStorageRef: string;
}

export interface ClaimedAsrWorkerJob {
  readonly jobId: string;
  readonly userId: string;
  readonly modelId: string;
  readonly audioDurationSeconds: number;
  readonly remoteStorageRef: string;
  readonly attempts: number;
}

/**
 * Section 108: Future Cloud ASR Job Queue, Admission Control, Cost Metering & Stale Worker Recovery
 * (Architecture Section 8.2 & Golden Rule 3: disabled by default in v1)
 */
export class BackendAsrJobQueueAndPool {
  constructor(
    private readonly db: PgPoolLike,
    /** Golden Rule 3: Cloud Runtime is disabled in v1 */
    private readonly cloudRuntimeEnabled: boolean = false,
    private readonly maxConcurrentActiveJobsPerUser: number = 3,
  ) {}

  /**
   * 1. Enqueue job with per-user Admission Control and Credit Cost Metering
   */
  public async enqueueJobWithAdmissionControl(
    req: CloudJobEnqueueRequest,
  ): Promise<{ jobId: string; estimatedCreditsCost: number }> {
    if (!this.cloudRuntimeEnabled) {
      throw new Error(
        'CLOUD_RUNTIME_DISABLED_IN_V1: طبق قانون ۳ معماری، صف پردازش ابری در نسخه اول غیرفعال است.',
      );
    }

    if (
      typeof req.userId !== 'string' ||
      req.userId.trim().length === 0 ||
      typeof req.modelId !== 'string' ||
      req.modelId.trim().length === 0 ||
      typeof req.remoteStorageRef !== 'string' ||
      req.remoteStorageRef.trim().length === 0 ||
      typeof req.audioDurationSeconds !== 'number' ||
      !Number.isFinite(req.audioDurationSeconds) ||
      req.audioDurationSeconds <= 0
    ) {
      throw new Error('INVALID_CLOUD_JOB_ENQUEUE_REQUEST');
    }

    // Admission Control: prevent queue saturation by a single user
    const activeRes = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM cloud_asr_jobs
       WHERE user_id = $1 AND status IN ('QUEUED', 'RUNNING')`,
      [req.userId],
    );
    const activeCount = parseInt(activeRes.rows[0]?.cnt ?? '0', 10);
    if (activeCount >= this.maxConcurrentActiveJobsPerUser) {
      throw new Error(
        `ADMISSION_REJECTED_QUOTA: حداکثر ${this.maxConcurrentActiveJobsPerUser} کار هم‌زمان مجاز است.`,
      );
    }

    // Transparent Cost Metering (10 credits per started minute of audio)
    const estimatedCreditsCost = Math.max(1, Math.ceil(req.audioDurationSeconds / 60) * 10);

    const insRes = await this.db.query<{ job_id: string }>(
      `INSERT INTO cloud_asr_jobs
       (user_id, model_id, audio_duration_seconds, remote_storage_ref, status, compute_cost_credits)
       VALUES ($1, $2, $3, $4, 'QUEUED', $5)
       RETURNING job_id`,
      [
        req.userId,
        req.modelId,
        req.audioDurationSeconds,
        req.remoteStorageRef,
        estimatedCreditsCost,
      ],
    );

    return {
      jobId: insRes.rows[0].job_id,
      estimatedCreditsCost,
    };
  }

  /**
   * 2. Atomic lock-free worker job claim via PostgreSQL FOR UPDATE SKIP LOCKED
   */
  public async claimNextJobForWorker(
    workerId: string,
    leaseDurationSeconds: number = 120,
  ): Promise<ClaimedAsrWorkerJob | null> {
    if (!this.cloudRuntimeEnabled) return null;
    if (typeof workerId !== 'string' || workerId.trim().length === 0) {
      throw new Error('INVALID_WORKER_ID');
    }
    const safeLeaseSec =
      Number.isFinite(leaseDurationSeconds) && leaseDurationSeconds > 0
        ? Math.min(3600, Math.floor(leaseDurationSeconds))
        : 120;

    const res = await this.db.query<{
      job_id: string;
      user_id: string;
      model_id: string;
      audio_duration_seconds: number;
      remote_storage_ref: string;
      attempts: number;
    }>(
      `WITH next_job AS (
         SELECT job_id
         FROM cloud_asr_jobs
         WHERE status = 'QUEUED'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE cloud_asr_jobs j
       SET status = 'RUNNING',
           assigned_worker_id = $1,
           attempts = j.attempts + 1,
           lease_expires_at = NOW() + ($2 || ' seconds')::interval,
           updated_at = NOW()
       FROM next_job
       WHERE j.job_id = next_job.job_id
       RETURNING j.job_id, j.user_id, j.model_id, j.audio_duration_seconds, j.remote_storage_ref, j.attempts`,
      [workerId, safeLeaseSec],
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      jobId: r.job_id,
      userId: r.user_id,
      modelId: r.model_id,
      audioDurationSeconds: r.audio_duration_seconds,
      remoteStorageRef: r.remote_storage_ref,
      attempts: r.attempts,
    };
  }

  /**
   * 3. Automatic stale worker job recovery when heartbeat lease expires
   */
  public async recoverStaleWorkerJobs(): Promise<{
    requeuedCount: number;
    deadLetteredCount: number;
  }> {
    if (!this.cloudRuntimeEnabled) return { requeuedCount: 0, deadLetteredCount: 0 };

    const deadRes = await this.db.query(
      `UPDATE cloud_asr_jobs
       SET status = 'DEAD_LETTER', error_code = 'MAX_RETRIES_WORKER_CRASH', updated_at = NOW()
       WHERE status = 'RUNNING' AND lease_expires_at < NOW() AND attempts >= max_attempts`,
    );

    const reqRes = await this.db.query(
      `UPDATE cloud_asr_jobs
       SET status = 'QUEUED', assigned_worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE status = 'RUNNING' AND lease_expires_at < NOW() AND attempts < max_attempts`,
    );

    return {
      requeuedCount: reqRes.rowCount ?? 0,
      deadLetteredCount: deadRes.rowCount ?? 0,
    };
  }
}
