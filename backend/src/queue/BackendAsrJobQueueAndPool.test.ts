import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendAsrJobQueueAndPool } from './BackendAsrJobQueueAndPool';
import { PgPoolLike } from '../PlatformBackendServices';

describe('Section 108: BackendAsrJobQueueAndPool (Golden Rule 3 + Admission Control + Worker Claim)', () => {
  it('blocks enqueue in v1 when cloudRuntimeEnabled=false, and enforces quota + atomic claim when enabled', async () => {
    let activeCount = 0;
    const mockDb: PgPoolLike = {
      async query<TRow>(sql: string) {
        if (sql.includes('SELECT COUNT(*)')) {
          return { rows: [{ cnt: String(activeCount) } as unknown as TRow], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO cloud_asr_jobs')) {
          activeCount++;
          return { rows: [{ job_id: `job_${activeCount}` } as unknown as TRow], rowCount: 1 };
        }
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          return {
            rows: [
              {
                job_id: 'job_1',
                user_id: 'usr_1',
                model_id: 'fastconformer-fa',
                audio_duration_seconds: 125,
                remote_storage_ref: 's3://bucket/a.wav',
                attempts: 1,
              } as unknown as TRow,
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    const disabledQueue = new BackendAsrJobQueueAndPool(mockDb, false, 2);
    await assert.rejects(
      () =>
        disabledQueue.enqueueJobWithAdmissionControl({
          userId: 'usr_1',
          modelId: 'fastconformer-fa',
          audioDurationSeconds: 125,
          remoteStorageRef: 's3://bucket/a.wav',
        }),
      /CLOUD_RUNTIME_DISABLED_IN_V1/,
    );

    const enabledQueue = new BackendAsrJobQueueAndPool(mockDb, true, 2);
    const j1 = await enabledQueue.enqueueJobWithAdmissionControl({
      userId: 'usr_1',
      modelId: 'fastconformer-fa',
      audioDurationSeconds: 125, // 3 started minutes -> 30 credits
      remoteStorageRef: 's3://bucket/a.wav',
    });
    assert.equal(j1.estimatedCreditsCost, 30);

    await enabledQueue.enqueueJobWithAdmissionControl({
      userId: 'usr_1',
      modelId: 'fastconformer-fa',
      audioDurationSeconds: 50,
      remoteStorageRef: 's3://bucket/b.wav',
    });

    // 3rd concurrent job exceeds maxConcurrentActiveJobsPerUser = 2
    await assert.rejects(
      () =>
        enabledQueue.enqueueJobWithAdmissionControl({
          userId: 'usr_1',
          modelId: 'fastconformer-fa',
          audioDurationSeconds: 50,
          remoteStorageRef: 's3://bucket/c.wav',
        }),
      /ADMISSION_REJECTED_QUOTA/,
    );

    const claimed = await enabledQueue.claimNextJobForWorker('gpu_worker_01');
    assert.equal(claimed?.jobId, 'job_1');
    assert.equal(claimed?.attempts, 1);
  });
});
