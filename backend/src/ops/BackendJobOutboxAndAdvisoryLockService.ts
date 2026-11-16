import type { PgPoolLike } from '../PlatformBackendServices';

/**
 * Section 133: PostgreSQL Distributed Advisory Lock Coordinator & Transactional Outbox Dispatcher
 */
export class AdvisoryLockCoordinator {
  constructor(private readonly db: PgPoolLike) {}

  /**
   * Execute a scheduled maintenance task (e.g. Canary evaluation or stale job recovery)
   * on at most one Backend replica across a multi-replica cluster via pg_try_advisory_lock
   */
  public async runWithAdvisoryLock(
    numericLockId: number,
    taskFn: () => Promise<void>,
  ): Promise<{ lockAcquired: boolean }> {
    const lockRes = await this.db.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [numericLockId],
    );
    const acquired = Boolean(lockRes.rows[0]?.acquired);
    if (!acquired) {
      return { lockAcquired: false };
    }

    try {
      await taskFn();
      return { lockAcquired: true };
    } finally {
      await this.db.query(`SELECT pg_advisory_unlock($1)`, [numericLockId]).catch(() => {});
    }
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
