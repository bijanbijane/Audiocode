import type { PgPoolLike, PinnedPgClient } from '../PlatformBackendServices';
import {
  DatabaseCoordinationError,
  DatabaseCoordinationErrorDiagnostics,
  withPinnedPostgresConnection,
} from '../db/PinnedPostgresTransaction';

export type AdvisoryLockTaskFn = (client: PinnedPgClient) => Promise<void>;
export type LegacyAdvisoryLockTaskFn = () => Promise<void>;

export interface AdvisoryLockReleaseFailureMetadata {
  readonly code: 'ADVISORY_LOCK_RELEASE_FAILED';
  readonly message: string;
  readonly diagnostics: DatabaseCoordinationErrorDiagnostics;
  readonly cause?: unknown;
}

/**
 * Legacy callback compatibility adapter allowing zero-argument callbacks to run inside
 * `AdvisoryLockCoordinator.runWithAdvisoryLock()` while retaining pinned session-lock ownership.
 */
export function adaptLegacyAdvisoryLockCallback(
  legacyTaskFn: LegacyAdvisoryLockTaskFn,
): AdvisoryLockTaskFn {
  return async (_client: PinnedPgClient): Promise<void> => {
    await legacyTaskFn();
  };
}

/**
 * Section 133: PostgreSQL Distributed Advisory Lock Coordinator & Transactional Outbox Dispatcher
 */
export class AdvisoryLockCoordinator {
  constructor(private readonly db: PgPoolLike) {}

  /**
   * Executes a protected task on at most one Backend replica across a multi-replica cluster
   * using a session-level PostgreSQL advisory lock bound to a single physically pinned connection.
   *
   * Guarantees:
   * - `pg_try_advisory_lock($1::bigint)`, `taskFn(client)`, and `pg_advisory_unlock($1::bigint)`
   *   all execute on the exact same physical PostgreSQL session connection.
   * - If `pg_advisory_unlock` returns false or throws, the pinned connection is marked unusable
   *   and evicted from the pool so no lock-owning session can return to circulation.
   * - Original task exceptions are preserved if unlock also fails, with structured unlock-failure
   *   metadata attached under `advisoryLockReleaseFailure`.
   */
  public async runWithAdvisoryLock(
    numericLockId: number,
    taskFn: (client: PinnedPgClient) => Promise<void>,
  ): Promise<{ lockAcquired: boolean }> {
    if (typeof numericLockId !== 'number' || !Number.isSafeInteger(numericLockId)) {
      throw new DatabaseCoordinationError(
        'ADVISORY_LOCK_ACQUISITION_FAILED',
        `Invalid PostgreSQL advisory lock identifier: ${String(numericLockId)}`,
        {
          diagnostics: {
            lockId: Number.isFinite(numericLockId) ? numericLockId : undefined,
            connectionInvalidated: false,
          },
        },
      );
    }

    return withPinnedPostgresConnection(this.db, async (client) => {
      let acquired = false;
      try {
        const lockRes = await client.query<{ acquired: unknown }>(
          `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
          [numericLockId],
        );
        acquired = lockRes.rows[0]?.acquired === true;
      } catch (acquireErr) {
        throw new DatabaseCoordinationError(
          'ADVISORY_LOCK_ACQUISITION_FAILED',
          `Failed to acquire PostgreSQL advisory lock ${numericLockId}.`,
          {
            cause: acquireErr,
            diagnostics: {
              lockId: numericLockId,
              connectionInvalidated: false,
            },
          },
        );
      }

      if (!acquired) {
        return { lockAcquired: false };
      }

      let taskFailed = false;
      let taskError: unknown = undefined;
      try {
        await taskFn(client);
      } catch (err) {
        taskFailed = true;
        taskError = err;
      }

      let unlockError: DatabaseCoordinationError | null = null;
      try {
        const unlockRes = await client.query<{ unlocked: unknown }>(
          `SELECT pg_advisory_unlock($1::bigint) AS unlocked`,
          [numericLockId],
        );
        if (unlockRes.rows[0]?.unlocked !== true) {
          unlockError = new DatabaseCoordinationError(
            'ADVISORY_LOCK_RELEASE_FAILED',
            `PostgreSQL advisory unlock did not confirm release for lock ${numericLockId}; evicting connection.`,
            {
              diagnostics: {
                lockId: numericLockId,
                connectionInvalidated: true,
              },
            },
          );
        }
      } catch (err) {
        unlockError = new DatabaseCoordinationError(
          'ADVISORY_LOCK_RELEASE_FAILED',
          `PostgreSQL advisory unlock failed for lock ${numericLockId}; evicting connection.`,
          {
            cause: err,
            diagnostics: {
              lockId: numericLockId,
              connectionInvalidated: true,
            },
          },
        );
      }

      if (unlockError !== null) {
        client.release(unlockError);

        if (taskFailed) {
          if (taskError !== null && typeof taskError === 'object') {
            const metadata: AdvisoryLockReleaseFailureMetadata = Object.freeze({
              code: 'ADVISORY_LOCK_RELEASE_FAILED',
              message: unlockError.message,
              diagnostics: unlockError.diagnostics,
              cause: unlockError.cause,
            });
            try {
              Object.defineProperty(taskError, 'advisoryLockReleaseFailure', {
                value: metadata,
                enumerable: true,
                configurable: true,
              });
            } catch {
              // If the thrown error object is frozen/non-extensible, preserve it unchanged.
            }
          }
          throw taskError;
        }

        throw unlockError;
      }

      if (taskFailed) {
        throw taskError;
      }

      return { lockAcquired: true };
    });
  }
}

export class TransactionalOutboxDispatcher {
  constructor(private readonly db: PgPoolLike) {}

  /**
   * Enqueue domain event inside the same PostgreSQL transaction
   */
  public async enqueueOutboxEvent(params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO backend_event_outbox
       (aggregate_type, aggregate_id, event_type, payload_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        params.aggregateType,
        params.aggregateId,
        params.eventType,
        JSON.stringify(params.payload),
      ],
    );
  }

  /**
   * Process pending outbox events with FOR UPDATE SKIP LOCKED and Exponential Backoff
   */
  public async processPendingOutboxBatch(
    publishHandler: (event: {
      eventId: string;
      eventType: string;
      payload: Record<string, unknown>;
    }) => Promise<void>,
    batchSize: number = 25,
  ): Promise<{ dispatchedCount: number; failedCount: number }> {
    const res = await this.db.query<{
      event_id: string;
      event_type: string;
      payload_json: Record<string, unknown>;
      attempts: number;
    }>(
      `WITH claimed AS (
         SELECT event_id
         FROM backend_event_outbox
         WHERE status = 'PENDING' AND next_attempt_at <= NOW()
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE backend_event_outbox o
       SET attempts = o.attempts + 1
       FROM claimed
       WHERE o.event_id = claimed.event_id
       RETURNING o.event_id, o.event_type, o.payload_json, o.attempts`,
      [batchSize],
    );

    let dispatchedCount = 0;
    let failedCount = 0;

    for (const row of res.rows) {
      try {
        await publishHandler({
          eventId: row.event_id,
          eventType: row.event_type,
          payload: row.payload_json,
        });
        await this.db.query(
          `UPDATE backend_event_outbox SET status = 'DISPATCHED' WHERE event_id = $1`,
          [row.event_id],
        );
        dispatchedCount++;
      } catch {
        failedCount++;
        if (row.attempts >= 5) {
          await this.db.query(
            `UPDATE backend_event_outbox SET status = 'DEAD_LETTER' WHERE event_id = $1`,
            [row.event_id],
          );
        } else {
          const backoffSeconds = Math.pow(2, row.attempts) * 15;
          await this.db.query(
            `UPDATE backend_event_outbox
             SET next_attempt_at = NOW() + ($2 || ' seconds')::interval
             WHERE event_id = $1`,
            [row.event_id, backoffSeconds],
          );
        }
      }
    }

    return { dispatchedCount, failedCount };
  }
}
