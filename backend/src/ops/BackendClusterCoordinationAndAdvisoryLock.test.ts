/**
 * @file backend/src/ops/BackendClusterCoordinationAndAdvisoryLock.test.ts
 * @description Deterministic connection-affinity, cross-replica exclusion, failure-matrix,
 *              poisoned-connection eviction, and cron daemon lock-ownership tests for AVP-006.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdvisoryLockCoordinator,
  AdvisoryLockReleaseFailureMetadata,
  adaptLegacyAdvisoryLockCallback,
} from './BackendJobOutboxAndAdvisoryLockService';
import { BackendBackgroundCronDaemon } from './BackendBackgroundCronDaemon';
import {
  DatabaseCoordinationError,
  PinnedPgClient,
  PinnedTransactionUnavailableError,
  ReleasedTransactionClientError,
  withPinnedPostgresConnection,
} from '../db/PinnedPostgresTransaction';
import type { PgPoolLike } from '../PlatformBackendServices';

interface RecordedQuery {
  readonly sql: string;
  readonly params?: unknown[];
}

class FakePhysicalPgConnection {
  public readonly id: string;
  public readonly ownedLocks = new Set<number>();
  public readonly queryHistory: RecordedQuery[] = [];
  public inTransaction = false;
  public checkedOut = false;
  public releaseCount = 0;
  public poisoned = false;
  public discarded = false;
  public lastReleaseArg: Error | boolean | undefined = undefined;

  public failAcquire = false;
  public failUnlockThrow = false;
  public forceUnlockFalse = false;
  public failReleaseThrow = false;

  constructor(
    id: string,
    private readonly lockRegistry: Map<number, FakePhysicalPgConnection>,
    private readonly onReleased: (conn: FakePhysicalPgConnection, evict: boolean) => void,
  ) {
    this.id = id;
  }

  public createClientHandle(): PinnedPgClient {
    let handleReleased = false;
    return {
      query: async <TRow = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<{ rows: TRow[]; rowCount: number | null }> => {
        if (handleReleased || this.discarded) {
          throw new Error(`Query attempted on released/discarded connection ${this.id}`);
        }
        this.queryHistory.push({ sql, params });

        if (sql.includes('pg_try_advisory_lock')) {
          if (this.failAcquire) {
            throw new Error(`Synthetic pg_try_advisory_lock error on ${this.id}`);
          }
          const lockId = Number(params?.[0]);
          const currentOwner = this.lockRegistry.get(lockId);
          if (currentOwner && currentOwner !== this) {
            return { rows: [{ acquired: false } as unknown as TRow], rowCount: 1 };
          }
          this.lockRegistry.set(lockId, this);
          this.ownedLocks.add(lockId);
          return { rows: [{ acquired: true } as unknown as TRow], rowCount: 1 };
        }

        if (sql.includes('pg_advisory_unlock')) {
          if (this.failUnlockThrow) {
            throw new Error(`Synthetic pg_advisory_unlock network drop on ${this.id}`);
          }
          if (this.forceUnlockFalse) {
            // Simulate unlock failing to release session lock while connection still holds it
            return { rows: [{ unlocked: false } as unknown as TRow], rowCount: 1 };
          }
          const lockId = Number(params?.[0]);
          const currentOwner = this.lockRegistry.get(lockId);
          if (currentOwner === this) {
            this.lockRegistry.delete(lockId);
            this.ownedLocks.delete(lockId);
            return { rows: [{ unlocked: true } as unknown as TRow], rowCount: 1 };
          }
          return { rows: [{ unlocked: false } as unknown as TRow], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      },
      release: (error?: Error | boolean): void => {
        if (handleReleased) {
          throw new Error(`Double release detected on ${this.id}`);
        }
        handleReleased = true;
        this.releaseCount++;
        this.lastReleaseArg = error;
        const evict = error instanceof Error || error === true;
        if (evict) {
          this.poisoned = true;
          this.discarded = true;
          // Physical session termination releases all session-level PostgreSQL advisory locks!
          for (const lockId of Array.from(this.ownedLocks)) {
            if (this.lockRegistry.get(lockId) === this) {
              this.lockRegistry.delete(lockId);
            }
          }
          this.ownedLocks.clear();
        }
        this.checkedOut = false;
        this.onReleased(this, evict);
        if (this.failReleaseThrow) {
          throw new Error(`Synthetic release failure on ${this.id}`);
        }
      },
    };
  }
}

class DeterministicMultiConnectionPool implements PgPoolLike {
  public readonly lockRegistry = new Map<number, FakePhysicalPgConnection>();
  public readonly allConnections: FakePhysicalPgConnection[] = [];
  public readonly availableQueue: FakePhysicalPgConnection[] = [];
  public poolQueryCalls: RecordedQuery[] = [];
  public connectCalls = 0;
  public failNextConnect = false;
  public customPoolQueryHandler?: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;

  private replacementCounter = 0;

  constructor() {
    for (const id of ['connection-A', 'connection-B', 'connection-C']) {
      const conn = new FakePhysicalPgConnection(id, this.lockRegistry, (c, evict) => {
        if (!evict) {
          this.availableQueue.push(c);
        } else {
          // Pool replaces evicted physical connection with a fresh physical session
          const fresh = new FakePhysicalPgConnection(
            `connection-replacement-${++this.replacementCounter}`,
            this.lockRegistry,
            (rc, rEvict) => {
              if (!rEvict) this.availableQueue.push(rc);
            },
          );
          this.allConnections.push(fresh);
          this.availableQueue.push(fresh);
        }
      });
      this.allConnections.push(conn);
      this.availableQueue.push(conn);
    }
  }

  public getConnection(id: string): FakePhysicalPgConnection {
    const found = this.allConnections.find((c) => c.id === id);
    if (!found) throw new Error(`Unknown connection ${id}`);
    return found;
  }

  public get checkedOutCount(): number {
    return this.allConnections.filter((c) => c.checkedOut).length;
  }

  public async query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }> {
    this.poolQueryCalls.push({ sql, params });
    if (this.customPoolQueryHandler) {
      return (await this.customPoolQueryHandler(sql, params)) as {
        rows: TRow[];
        rowCount: number | null;
      };
    }
    return { rows: [], rowCount: 0 };
  }

  public async connect(): Promise<PinnedPgClient> {
    this.connectCalls++;
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error('ECONNREFUSED: postgres://secret:pass@internal:5432/db');
    }
    const next = this.availableQueue.shift();
    if (!next) {
      throw new Error('Pool exhausted');
    }
    if (next.discarded || next.poisoned) {
      throw new Error(`Pool attempted to reuse poisoned connection ${next.id}`);
    }
    next.checkedOut = true;
    return next.createClientHandle();
  }
}

test('A. Same-Connection Guarantee: acquire, protected callback, unlock, and release all execute on connection-A only', async () => {
  const pool = new DeterministicMultiConnectionPool();
  const coordinator = new AdvisoryLockCoordinator(pool);
  const connA = pool.getConnection('connection-A');
  const connB = pool.getConnection('connection-B');
  const connC = pool.getConnection('connection-C');

  let callbackRan = false;
  const result = await coordinator.runWithAdvisoryLock(778899, async (client) => {
    callbackRan = true;
    // Connection-A must still be checked out and holding the lock during callback execution
    assert.equal(connA.checkedOut, true);
    assert.equal(connA.ownedLocks.has(778899), true);
    await client.query('SELECT 1 AS protected_work');
  });

  assert.equal(result.lockAcquired, true);
  assert.equal(callbackRan, true);
  assert.equal(pool.poolQueryCalls.length, 0, 'Must never use pool.query() for lock lifecycle');
  assert.equal(connB.queryHistory.length, 0);
  assert.equal(connC.queryHistory.length, 0);
  assert.equal(connB.releaseCount, 0);
  assert.equal(connC.releaseCount, 0);

  assert.equal(connA.queryHistory.length, 3);
  assert.ok(connA.queryHistory[0].sql.includes('pg_try_advisory_lock($1::bigint)'));
  assert.equal(connA.queryHistory[1].sql, 'SELECT 1 AS protected_work');
  assert.ok(connA.queryHistory[2].sql.includes('pg_advisory_unlock($1::bigint)'));
  assert.equal(connA.releaseCount, 1);
  assert.equal(connA.ownedLocks.size, 0);
  assert.equal(connA.poisoned, false);
  assert.equal(pool.checkedOutCount, 0);
});

test('B. Cross-Replica Exclusion: Replica B skips while Replica A owns lock 778899, then acquires after Replica A releases', async () => {
  const pool = new DeterministicMultiConnectionPool();
  const replicaA = new AdvisoryLockCoordinator(pool);
  const replicaB = new AdvisoryLockCoordinator(pool);

  let releaseGateA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseGateA = resolve;
  });
  let notifyAInside!: () => void;
  const aInside = new Promise<void>((resolve) => {
    notifyAInside = resolve;
  });

  let replicaACompleted = false;
  let replicaBExecutedWhileLocked = false;
  let replicaBExecutedAfterRelease = false;

  const taskA = replicaA.runWithAdvisoryLock(778899, async () => {
    notifyAInside();
    await gateA;
    replicaACompleted = true;
  });

  await aInside;

  // Replica B tries while Replica A holds lock on connection-A (B checks out connection-B)
  const resBWhileLocked = await replicaB.runWithAdvisoryLock(778899, async () => {
    replicaBExecutedWhileLocked = true;
  });
  assert.equal(resBWhileLocked.lockAcquired, false);
  assert.equal(replicaBExecutedWhileLocked, false);

  // Release Replica A
  releaseGateA();
  const resA = await taskA;
  assert.equal(resA.lockAcquired, true);
  assert.equal(replicaACompleted, true);

  // Now Replica B must be able to acquire lock 778899 cleanly
  const resBAfter = await replicaB.runWithAdvisoryLock(778899, async () => {
    replicaBExecutedAfterRelease = true;
  });
  assert.equal(resBAfter.lockAcquired, true);
  assert.equal(replicaBExecutedAfterRelease, true);
  assert.equal(pool.checkedOutCount, 0);
  assert.equal(pool.lockRegistry.size, 0);
});

test('C. Lock Failure Matrix: all 10 failure/edge modes preserve errors, prevent leaks, and never run callback without ownership', async () => {
  // 1a. Pool without connect() -> fails closed with PINNED_CONNECTION_UNAVAILABLE
  {
    const noConnectPool: PgPoolLike = {
      async query() {
        return { rows: [{ acquired: true }] as any, rowCount: 1 };
      },
    };
    const coord = new AdvisoryLockCoordinator(noConnectPool);
    let ran = false;
    await assert.rejects(
      () =>
        coord.runWithAdvisoryLock(101, async () => {
          ran = true;
        }),
      (err: unknown) =>
        err instanceof PinnedTransactionUnavailableError &&
        err.code === 'PINNED_CONNECTION_UNAVAILABLE',
    );
    assert.equal(ran, false);
  }

  // 1b. pool.connect() rejects
  {
    const pool = new DeterministicMultiConnectionPool();
    pool.failNextConnect = true;
    const coord = new AdvisoryLockCoordinator(pool);
    let ran = false;
    await assert.rejects(
      () =>
        coord.runWithAdvisoryLock(101, async () => {
          ran = true;
        }),
      (err: unknown) =>
        err instanceof PinnedTransactionUnavailableError &&
        err.code === 'PINNED_CONNECTION_UNAVAILABLE' &&
        !err.message.includes('secret:pass'),
    );
    assert.equal(ran, false);
    assert.equal(pool.checkedOutCount, 0);
  }

  // 2. Advisory lock query throws
  {
    const pool = new DeterministicMultiConnectionPool();
    pool.getConnection('connection-A').failAcquire = true;
    const coord = new AdvisoryLockCoordinator(pool);
    let ran = false;
    await assert.rejects(
      () =>
        coord.runWithAdvisoryLock(102, async () => {
          ran = true;
        }),
      (err: unknown) =>
        err instanceof DatabaseCoordinationError &&
        err.code === 'ADVISORY_LOCK_ACQUISITION_FAILED',
    );
    assert.equal(ran, false);
    assert.equal(pool.checkedOutCount, 0);
    assert.equal(pool.getConnection('connection-A').releaseCount, 1);
  }

  // 3. Lock returns false (already held externally)
  {
    const pool = new DeterministicMultiConnectionPool();
    const externalHolder = pool.getConnection('connection-C');
    pool.lockRegistry.set(103, externalHolder);
    const coord = new AdvisoryLockCoordinator(pool);
    let ran = false;
    const res = await coord.runWithAdvisoryLock(103, async () => {
      ran = true;
    });
    assert.equal(res.lockAcquired, false);
    assert.equal(ran, false);
    assert.equal(pool.checkedOutCount, 0);
    assert.equal(pool.getConnection('connection-A').poisoned, false);
  }

  // 4. Protected operation succeeds via explicit legacy callback adapter
  {
    const pool = new DeterministicMultiConnectionPool();
    const coord = new AdvisoryLockCoordinator(pool);
    let legacyRan = false;
    const res = await coord.runWithAdvisoryLock(
      104,
      adaptLegacyAdvisoryLockCallback(async () => {
        legacyRan = true;
      }),
    );
    assert.equal(res.lockAcquired, true);
    assert.equal(legacyRan, true);
    assert.equal(pool.checkedOutCount, 0);
  }

  // 5. Protected operation throws -> unlock still runs on connection-A and original error propagates
  {
    const pool = new DeterministicMultiConnectionPool();
    const coord = new AdvisoryLockCoordinator(pool);
    const boom = new Error('PROTECTED_TASK_EXPLODED');
    await assert.rejects(
      () =>
        coord.runWithAdvisoryLock(105, async () => {
          throw boom;
        }),
      (err: unknown) => err === boom,
    );
    const connA = pool.getConnection('connection-A');
    assert.equal(connA.ownedLocks.size, 0);
    assert.equal(connA.poisoned, false);
    assert.equal(connA.releaseCount, 1);
    assert.equal(pool.checkedOutCount, 0);
  }

  // 6. Unlock returns false -> throws ADVISORY_LOCK_RELEASE_FAILED & poisons/evicts connection-A
  {
    const pool = new DeterministicMultiConnectionPool();
    const connA = pool.getConnection('connection-A');
    connA.forceUnlockFalse = true;
    const coord = new AdvisoryLockCoordinator(pool);
    await assert.rejects(
      () => coord.runWithAdvisoryLock(106, async () => {}),
      (err: unknown) =>
        err instanceof DatabaseCoordinationError &&
        err.code === 'ADVISORY_LOCK_RELEASE_FAILED' &&
        err.diagnostics.connectionInvalidated === true,
    );
    assert.equal(connA.poisoned, true);
    assert.equal(connA.discarded, true);
    assert.ok(connA.lastReleaseArg instanceof Error);
    assert.equal(pool.checkedOutCount, 0);
    assert.equal(pool.lockRegistry.has(106), false);
  }

  // 7. Unlock query throws -> throws ADVISORY_LOCK_RELEASE_FAILED with cause & evicts connection-A
  {
    const pool = new DeterministicMultiConnectionPool();
    const connA = pool.getConnection('connection-A');
    connA.failUnlockThrow = true;
    const coord = new AdvisoryLockCoordinator(pool);
    await assert.rejects(
      () => coord.runWithAdvisoryLock(107, async () => {}),
      (err: unknown) =>
        err instanceof DatabaseCoordinationError &&
        err.code === 'ADVISORY_LOCK_RELEASE_FAILED' &&
        err.cause instanceof Error,
    );
    assert.equal(connA.poisoned, true);
    assert.equal(connA.discarded, true);
    assert.equal(pool.checkedOutCount, 0);
  }

  // 8. Protected operation throws AND unlock also throws -> original error preserved + structured metadata attached + connection evicted
  {
    const pool = new DeterministicMultiConnectionPool();
    const connA = pool.getConnection('connection-A');
    connA.failUnlockThrow = true;
    const coord = new AdvisoryLockCoordinator(pool);
    const primaryErr = new Error('PRIMARY_DOMAIN_FAILURE');

    let caught: any;
    try {
      await coord.runWithAdvisoryLock(108, async () => {
        throw primaryErr;
      });
    } catch (err) {
      caught = err;
    }

    assert.equal(caught, primaryErr);
    const meta = (
      caught as Error & { advisoryLockReleaseFailure?: AdvisoryLockReleaseFailureMetadata }
    ).advisoryLockReleaseFailure;
    assert.ok(meta);
    assert.equal(meta.code, 'ADVISORY_LOCK_RELEASE_FAILED');
    assert.equal(meta.diagnostics.connectionInvalidated, true);
    assert.equal(meta.diagnostics.lockId, 108);
    assert.equal(connA.poisoned, true);
    assert.equal(connA.discarded, true);
    assert.equal(pool.checkedOutCount, 0);
  }

  // 9. Pinned client release throws or client reused after release
  {
    const pool = new DeterministicMultiConnectionPool();
    const connA = pool.getConnection('connection-A');
    connA.failReleaseThrow = true;
    const coord = new AdvisoryLockCoordinator(pool);

    await assert.rejects(
      () => coord.runWithAdvisoryLock(109, async () => {}),
      (err: unknown) =>
        err instanceof DatabaseCoordinationError &&
        err.code === 'MIGRATION_CONNECTION_INVALID',
    );
    assert.equal(pool.checkedOutCount, 0);

    // Reusing client after withPinnedPostgresConnection finishes must throw ReleasedTransactionClientError
    let leakedClient!: PinnedPgClient;
    await withPinnedPostgresConnection(pool, async (client) => {
      leakedClient = client;
    });
    await assert.rejects(
      () => leakedClient.query('SELECT 1'),
      (err: unknown) => err instanceof ReleasedTransactionClientError,
    );
  }

  // 10. Invalid lock identifiers rejected before touching pool
  {
    const pool = new DeterministicMultiConnectionPool();
    const coord = new AdvisoryLockCoordinator(pool);
    for (const invalidId of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let ran = false;
      await assert.rejects(
        () =>
          coord.runWithAdvisoryLock(invalidId, async () => {
            ran = true;
          }),
        (err: unknown) =>
          err instanceof DatabaseCoordinationError &&
          err.code === 'ADVISORY_LOCK_ACQUISITION_FAILED',
      );
      assert.equal(ran, false);
    }
    assert.equal(pool.connectCalls, 0);
  }
});

test('D. Reacquisition & Poisoned Eviction: normal lock releases cleanly; failed unlock discards connection-A and never reuses it', async () => {
  const pool = new DeterministicMultiConnectionPool();
  const coord1 = new AdvisoryLockCoordinator(pool);
  const coord2 = new AdvisoryLockCoordinator(pool);

  // Normal cycle + reacquisition
  const r1 = await coord1.runWithAdvisoryLock(555001, async () => {});
  assert.equal(r1.lockAcquired, true);
  assert.equal(pool.getConnection('connection-A').ownedLocks.size, 0);

  const r2 = await coord2.runWithAdvisoryLock(555001, async () => {});
  assert.equal(r2.lockAcquired, true);

  // Now inject unlock failure on the next connection to be handed out
  const victimConn = pool.availableQueue[0];
  victimConn.forceUnlockFalse = true;

  await assert.rejects(
    () => coord1.runWithAdvisoryLock(555001, async () => {}),
    (err: unknown) =>
      err instanceof DatabaseCoordinationError &&
      err.code === 'ADVISORY_LOCK_RELEASE_FAILED',
  );

  // Victim connection must be poisoned/discarded and absent from availableQueue
  assert.equal(victimConn.poisoned, true);
  assert.equal(victimConn.discarded, true);
  assert.equal(pool.availableQueue.includes(victimConn), false);

  // Because physical session termination released the lock, coord2 can reacquire 555001 on a healthy connection
  const r3 = await coord2.runWithAdvisoryLock(555001, async () => {});
  assert.equal(r3.lockAcquired, true);

  // Run several more cycles and confirm victimConn is NEVER reused
  const prevReleaseCount = victimConn.releaseCount;
  for (let i = 0; i < 6; i++) {
    const r = await coord1.runWithAdvisoryLock(555001, async () => {});
    assert.equal(r.lockAcquired, true);
  }
  assert.equal(victimConn.releaseCount, prevReleaseCount);
  assert.equal(pool.checkedOutCount, 0);
});

test('E. BackendBackgroundCronDaemon: prevents overlapping sweeps across replicas and recovers cleanly after failure', async () => {
  const pool = new DeterministicMultiConnectionPool();
  let inFlightSweeps = 0;
  let maxConcurrentSweeps = 0;
  let shouldFailPublish = false;

  pool.customPoolQueryHandler = async (sql: string) => {
    if (sql.includes('WITH claimed AS')) {
      return {
        rows: [
          {
            event_id: 'evt_cluster_1',
            event_type: 'MODEL_REVOKED',
            payload_json: { modelId: 'whisper-fa' },
            attempts: 1,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  let releaseSweep1!: () => void;
  const sweep1Gate = new Promise<void>((resolve) => {
    releaseSweep1 = resolve;
  });
  let notifySweep1Started!: () => void;
  const sweep1Started = new Promise<void>((resolve) => {
    notifySweep1Started = resolve;
  });

  const daemonReplica1 = new BackendBackgroundCronDaemon(pool, async () => {
    inFlightSweeps++;
    maxConcurrentSweeps = Math.max(maxConcurrentSweeps, inFlightSweeps);
    notifySweep1Started();
    await sweep1Gate;
    inFlightSweeps--;
    if (shouldFailPublish) {
      throw new Error('OUTBOX_PUBLISH_FAILED');
    }
  });

  const daemonReplica2 = new BackendBackgroundCronDaemon(pool, async () => {
    inFlightSweeps++;
    maxConcurrentSweeps = Math.max(maxConcurrentSweeps, inFlightSweeps);
    inFlightSweeps--;
  });

  const tick1Promise = daemonReplica1.runSingleSweepTick();
  await sweep1Started;

  // Local re-entry on Replica 1 is guarded by isTickRunning
  const reentrantTick = await daemonReplica1.runSingleSweepTick();
  assert.equal(reentrantTick.executed, false);

  // Replica 2 attempts sweep concurrently -> blocked by pinned advisory lock
  const tick2Res = await daemonReplica2.runSingleSweepTick();
  assert.equal(tick2Res.executed, false);
  assert.equal(tick2Res.outboxDispatched, 0);

  releaseSweep1();
  const tick1Res = await tick1Promise;
  assert.equal(tick1Res.executed, true);
  assert.equal(tick1Res.outboxDispatched, 1);
  assert.equal(maxConcurrentSweeps, 1);
  assert.equal(pool.checkedOutCount, 0);
  assert.equal(pool.lockRegistry.size, 0);

  // Failure path: if outbox query throws, isTickRunning resets and pinned lock connection is released
  pool.customPoolQueryHandler = async (sql: string) => {
    if (sql.includes('backend_event_outbox')) {
      throw new Error('OUTBOX_SWEEP_DB_ERROR');
    }
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(() => daemonReplica2.runSingleSweepTick(), /OUTBOX_SWEEP_DB_ERROR/);
  assert.equal(pool.checkedOutCount, 0);
  assert.equal(pool.lockRegistry.size, 0);

  // Subsequent tick after failure executes cleanly (proves isTickRunning was reset & lock released)
  pool.customPoolQueryHandler = async () => ({ rows: [], rowCount: 0 });
  const recoveryTick = await daemonReplica2.runSingleSweepTick();
  assert.equal(recoveryTick.executed, true);
});
