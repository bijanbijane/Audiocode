import type { PgPoolLike } from '../PlatformBackendServices';
import {
  AdvisoryLockCoordinator,
  TransactionalOutboxDispatcher,
} from './BackendJobOutboxAndAdvisoryLockService';
import { BackendAsrJobQueueAndPool } from '../queue/BackendAsrJobQueueAndPool';

export class BackendBackgroundCronDaemon {
  private static readonly SWEEP_LOCK_ID = 77100234;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isTickRunning = false;

  private readonly lockCoordinator: AdvisoryLockCoordinator;
  private readonly outboxDispatcher: TransactionalOutboxDispatcher;
  private readonly jobQueuePool: BackendAsrJobQueueAndPool;

  constructor(
    db: PgPoolLike,
    private readonly outboxPublisherFn: (event: {
      eventId: string;
      eventType: string;
      payload: Record<string, unknown>;
    }) => Promise<void>,
    cloudRuntimeEnabled: boolean = false
  ) {
    this.lockCoordinator = new AdvisoryLockCoordinator(db);
    this.outboxDispatcher = new TransactionalOutboxDispatcher(db);
    this.jobQueuePool = new BackendAsrJobQueueAndPool(db, cloudRuntimeEnabled);
  }

  public start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runSingleSweepTick();
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes a single cluster-safe maintenance tick under a PostgreSQL advisory lock.
   */
  public async runSingleSweepTick(): Promise<{
    executed: boolean;
    outboxDispatched: number;
    staleJobsRequeued: number;
  }> {
    if (this.isTickRunning) {
      return { executed: false, outboxDispatched: 0, staleJobsRequeued: 0 };
    }

    this.isTickRunning = true;
    let outboxDispatched = 0;
    let staleJobsRequeued = 0;

    try {
      const res = await this.lockCoordinator.runWithAdvisoryLock(
        BackendBackgroundCronDaemon.SWEEP_LOCK_ID,
        async () => {
          const outboxRes = await this.outboxDispatcher.processPendingOutboxBatch(
            this.outboxPublisherFn,
            25
          );
          outboxDispatched = outboxRes.dispatchedCount;

          const recoveryRes = await this.jobQueuePool.recoverStaleWorkerJobs();
          staleJobsRequeued = recoveryRes.requeuedCount;
        }
      );

      return {
        executed: res.lockAcquired,
        outboxDispatched,
        staleJobsRequeued,
      };
    } finally {
      this.isTickRunning = false;
    }
  }
}
