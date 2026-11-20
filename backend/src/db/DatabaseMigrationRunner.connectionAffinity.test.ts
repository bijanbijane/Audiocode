/**
 * @file backend/src/db/DatabaseMigrationRunner.connectionAffinity.test.ts
 * @description Deterministic connection-affinity and atomic transaction verification suite
 *              for DatabaseMigrationRunner (AVP-CLUSTER-COORDINATION-006).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseMigrationRunner } from './DatabaseMigrationRunner';
import {
  DatabaseCoordinationError,
  PinnedPgClient,
} from './PinnedPostgresTransaction';
import type { PgPoolLike } from '../PlatformBackendServices';

interface MigrationOpLog {
  readonly connectionId: string;
  readonly sql: string;
  readonly params?: unknown[];
  readonly lockHeldDuringOp: boolean;
}

class TransactionalMigrationPoolSimulator implements PgPoolLike {
  public readonly committedTables = new Set<string>();
  public readonly committedMigrations = new Map<string, string>();
  public readonly opLog: MigrationOpLog[] = [];
  public readonly poolDirectQueries: string[] = [];

  public readonly lockRegistry = new Map<number, string>();
  public readonly connectionMeta = new Map<
    string,
    { releaseCount: number; poisoned: boolean; discarded: boolean; checkedOut: boolean }
  >();

  public failSqlContaining?: string;
  public failChecksumInsertForVersion?: string;
  public failCommitForVersion?: string;
  public failRollback = false;

  private readonly availableIds: string[] = ['connection-A', 'connection-B', 'connection-C'];
  private replacementSeq = 0;

  constructor() {
    for (const id of this.availableIds) {
      this.connectionMeta.set(id, {
        releaseCount: 0,
        poisoned: false,
        discarded: false,
        checkedOut: false,
      });
    }
  }

  public async query<TRow = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: TRow[]; rowCount: number | null }> {
    this.poolDirectQueries.push(sql);
    return { rows: [], rowCount: 0 };
  }

  public async connect(): Promise<PinnedPgClient> {
    const connId = this.availableIds.shift();
    if (!connId) throw new Error('Pool exhausted');
    const meta = this.connectionMeta.get(connId)!;
    meta.checkedOut = true;

    let released = false;
    let inTx = false;
    let pendingTables = new Set<string>();
    let pendingMigrations = new Map<string, string>();
    let lastInsertedVersion: string | null = null;
    const ownedLocks = new Set<number>();

    return {
      query: async <TRow = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<{ rows: TRow[]; rowCount: number | null }> => {
        if (released || meta.discarded) {
          throw new Error(`Attempted query on released/discarded connection ${connId}`);
        }

        const trimmed = sql.trim();
        this.opLog.push({
          connectionId: connId,
          sql: trimmed,
          params,
          lockHeldDuringOp: ownedLocks.size > 0,
        });

        if (trimmed.includes('pg_try_advisory_lock')) {
          const lockId = Number(params?.[0]);
          const holder = this.lockRegistry.get(lockId);
          if (holder && holder !== connId) {
            return { rows: [{ acquired: false } as unknown as TRow], rowCount: 1 };
          }
          this.lockRegistry.set(lockId, connId);
          ownedLocks.add(lockId);
          return { rows: [{ acquired: true } as unknown as TRow], rowCount: 1 };
        }

        if (trimmed.includes('pg_advisory_unlock')) {
          const lockId = Number(params?.[0]);
          if (this.lockRegistry.get(lockId) === connId) {
            this.lockRegistry.delete(lockId);
            ownedLocks.delete(lockId);
            return { rows: [{ unlocked: true } as unknown as TRow], rowCount: 1 };
          }
          return { rows: [{ unlocked: false } as unknown as TRow], rowCount: 1 };
        }

        if (trimmed.toUpperCase() === 'BEGIN') {
          inTx = true;
          pendingTables = new Set<string>();
          pendingMigrations = new Map<string, string>();
          lastInsertedVersion = null;
          return { rows: [], rowCount: null };
        }

        if (trimmed.toUpperCase() === 'COMMIT') {
          if (
            this.failCommitForVersion &&
            lastInsertedVersion === this.failCommitForVersion
          ) {
            throw new Error(`SYNTHETIC_COMMIT_ERROR:${lastInsertedVersion}`);
          }
          if (inTx) {
            for (const t of pendingTables) this.committedTables.add(t);
            for (const [k, v] of pendingMigrations.entries()) {
              this.committedMigrations.set(k, v);
            }
          }
          inTx = false;
          pendingTables.clear();
          pendingMigrations.clear();
          lastInsertedVersion = null;
          return { rows: [], rowCount: null };
        }

        if (trimmed.toUpperCase() === 'ROLLBACK') {
          if (this.failRollback) {
            throw new Error('SYNTHETIC_ROLLBACK_CONNECTION_BROKEN');
          }
          inTx = false;
          pendingTables.clear();
          pendingMigrations.clear();
          lastInsertedVersion = null;
          return { rows: [], rowCount: null };
        }

        if (trimmed.includes('SELECT version, checksum_sha256 FROM schema_migrations')) {
          const rows = Array.from(this.committedMigrations.entries()).map(
            ([version, checksum_sha256]) => ({ version, checksum_sha256 }),
          );
          return { rows: rows as unknown as TRow[], rowCount: rows.length };
        }

        if (trimmed.includes('INSERT INTO schema_migrations')) {
          const version = String(params?.[0]);
          const checksum = String(params?.[1]);
          if (this.failChecksumInsertForVersion === version) {
            throw new Error(`SYNTHETIC_CHECKSUM_INSERT_ERROR:${version}`);
          }
          lastInsertedVersion = version;
          if (inTx) {
            pendingMigrations.set(version, checksum);
          } else {
            this.committedMigrations.set(version, checksum);
          }
          return { rows: [], rowCount: 1 };
        }

        if (this.failSqlContaining && trimmed.includes(this.failSqlContaining)) {
          throw new Error(`SYNTHETIC_MIGRATION_SQL_ERROR:${this.failSqlContaining}`);
        }

        const createMatch = trimmed.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z0-9_]+)/i);
        if (createMatch) {
          const tableName = createMatch[1];
          if (inTx) {
            pendingTables.add(tableName);
          } else {
            this.committedTables.add(tableName);
          }
        }

        return { rows: [], rowCount: 0 };
      },
      release: (error?: Error | boolean): void => {
        if (released) throw new Error(`Double release on ${connId}`);
        released = true;
        meta.releaseCount++;
        meta.checkedOut = false;
        const evict = error instanceof Error || error === true;
        if (evict) {
          meta.poisoned = true;
          meta.discarded = true;
          for (const lockId of Array.from(ownedLocks)) {
            if (this.lockRegistry.get(lockId) === connId) {
              this.lockRegistry.delete(lockId);
            }
          }
          ownedLocks.clear();
          const freshId = `connection-fresh-${++this.replacementSeq}`;
          this.connectionMeta.set(freshId, {
            releaseCount: 0,
            poisoned: false,
            discarded: false,
            checkedOut: false,
          });
          this.availableIds.push(freshId);
        } else {
          this.availableIds.push(connId);
        }
      },
    };
  }
}

function withTempMigrationsDir(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp006_mig_'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('A. All migration operations (lock, init, BEGIN, SQL, checksum INSERT, COMMIT, unlock) execute strictly on connection-A', async () => {
  await withTempMigrationsDir(
    { '001_create_alpha.sql': 'CREATE TABLE alpha_tbl (id INT);' },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      const runner = new DatabaseMigrationRunner(pool);
      const summary = await runner.applyPendingMigrations(dir);

      assert.deepEqual(summary.appliedMigrations, ['001_create_alpha.sql']);
      assert.deepEqual(summary.skippedAlreadyApplied, []);
      assert.equal(pool.poolDirectQueries.length, 0, 'Must never call pool.query() directly');

      const usedConnections = new Set(pool.opLog.map((op) => op.connectionId));
      assert.deepEqual(Array.from(usedConnections), ['connection-A']);
      assert.equal(pool.connectionMeta.get('connection-B')!.releaseCount, 0);
      assert.equal(pool.connectionMeta.get('connection-C')!.releaseCount, 0);

      // Verify exact sequence on connection-A
      const sqls = pool.opLog.map((op) => op.sql);
      assert.ok(sqls[0].includes('pg_try_advisory_lock'));
      assert.ok(sqls[1].includes('CREATE TABLE IF NOT EXISTS schema_migrations'));
      assert.ok(sqls[2].includes('SELECT version, checksum_sha256 FROM schema_migrations'));
      assert.equal(sqls[3], 'BEGIN');
      assert.equal(sqls[4], 'CREATE TABLE alpha_tbl (id INT);');
      assert.ok(sqls[5].includes('INSERT INTO schema_migrations'));
      assert.equal(sqls[6], 'COMMIT');
      assert.ok(sqls[7].includes('pg_advisory_unlock'));

      // Advisory lock held across every operation between acquire and unlock
      for (let i = 1; i <= 7; i++) {
        assert.equal(pool.opLog[i].lockHeldDuringOp, true);
      }
      assert.equal(pool.lockRegistry.size, 0);
      assert.equal(pool.committedTables.has('alpha_tbl'), true);
      assert.equal(pool.committedMigrations.has('001_create_alpha.sql'), true);
    },
  );
});

test('B. Multiple pending migrations execute in separate BEGIN/COMMIT transactions on the same pinned connection while advisory lock stays held', async () => {
  await withTempMigrationsDir(
    {
      '001_m1.sql': 'CREATE TABLE m1_tbl (id INT);',
      '002_m2.sql': 'CREATE TABLE m2_tbl (id INT);',
      '003_m3.sql': 'CREATE TABLE m3_tbl (id INT);',
    },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      const runner = new DatabaseMigrationRunner(pool);
      const summary = await runner.applyPendingMigrations(dir);

      assert.deepEqual(summary.appliedMigrations, ['001_m1.sql', '002_m2.sql', '003_m3.sql']);
      assert.equal(pool.poolDirectQueries.length, 0);
      assert.ok(pool.opLog.every((op) => op.connectionId === 'connection-A'));

      const begins = pool.opLog.filter((op) => op.sql === 'BEGIN').length;
      const commits = pool.opLog.filter((op) => op.sql === 'COMMIT').length;
      const locks = pool.opLog.filter((op) => op.sql.includes('pg_try_advisory_lock')).length;
      const unlocks = pool.opLog.filter((op) => op.sql.includes('pg_advisory_unlock')).length;

      assert.equal(begins, 3);
      assert.equal(commits, 3);
      assert.equal(locks, 1);
      assert.equal(unlocks, 1);
      assert.equal(pool.committedMigrations.size, 3);
      assert.ok(pool.committedTables.has('m1_tbl'));
      assert.ok(pool.committedTables.has('m2_tbl'));
      assert.ok(pool.committedTables.has('m3_tbl'));
      assert.equal(pool.lockRegistry.size, 0);
    },
  );
});

test('C. SQL failure in migration 2 preserves migration 1, rolls back migration 2, skips migration 3, omits checksum, and unlocks on same connection', async () => {
  await withTempMigrationsDir(
    {
      '001_ok.sql': 'CREATE TABLE ok_tbl (id INT);',
      '002_bad.sql': 'CREATE TABLE bad_tbl (id INT); -- FAIL_HERE',
      '003_never.sql': 'CREATE TABLE never_tbl (id INT);',
    },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      pool.failSqlContaining = 'FAIL_HERE';
      const runner = new DatabaseMigrationRunner(pool);

      await assert.rejects(
        () => runner.applyPendingMigrations(dir),
        (err: unknown) =>
          err instanceof DatabaseCoordinationError &&
          err.code === 'MIGRATION_TRANSACTION_FAILED' &&
          err.cause instanceof Error &&
          err.cause.message.includes('SYNTHETIC_MIGRATION_SQL_ERROR:FAIL_HERE'),
      );

      assert.equal(pool.committedTables.has('ok_tbl'), true);
      assert.equal(pool.committedMigrations.has('001_ok.sql'), true);

      assert.equal(pool.committedTables.has('bad_tbl'), false);
      assert.equal(pool.committedMigrations.has('002_bad.sql'), false);

      assert.equal(pool.committedTables.has('never_tbl'), false);
      assert.equal(pool.committedMigrations.has('003_never.sql'), false);

      assert.ok(pool.opLog.every((op) => op.connectionId === 'connection-A'));
      assert.ok(pool.opLog.some((op) => op.sql === 'ROLLBACK'));
      assert.ok(pool.opLog.some((op) => op.sql.includes('pg_advisory_unlock')));
      assert.equal(pool.lockRegistry.size, 0);
      assert.equal(pool.connectionMeta.get('connection-A')!.checkedOut, false);
    },
  );
});

test('D. Checksum insertion failure rolls back migration SQL, commits no checksum, rejects, and releases lock', async () => {
  await withTempMigrationsDir(
    {
      '001_checksum_fail.sql': 'CREATE TABLE rollback_me_tbl (id INT);',
    },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      pool.failChecksumInsertForVersion = '001_checksum_fail.sql';
      const runner = new DatabaseMigrationRunner(pool);

      await assert.rejects(
        () => runner.applyPendingMigrations(dir),
        (err: unknown) =>
          err instanceof DatabaseCoordinationError &&
          err.code === 'MIGRATION_TRANSACTION_FAILED' &&
          err.cause instanceof Error &&
          err.cause.message.includes('SYNTHETIC_CHECKSUM_INSERT_ERROR'),
      );

      assert.equal(pool.committedTables.has('rollback_me_tbl'), false);
      assert.equal(pool.committedMigrations.has('001_checksum_fail.sql'), false);
      assert.ok(pool.opLog.some((op) => op.sql === 'ROLLBACK'));
      assert.equal(pool.lockRegistry.size, 0);
      assert.equal(pool.connectionMeta.get('connection-A')!.checkedOut, false);
    },
  );
});

test('E. COMMIT failure stops later migrations, attempts rollback, preserves primary commit error, and discards unusable connections', async () => {
  // E1: COMMIT fails on usable connection -> ROLLBACK attempted, primary commit error preserved, lock released
  await withTempMigrationsDir(
    {
      '001_commit_fail.sql': 'CREATE TABLE commit_fail_tbl (id INT);',
      '002_after_commit_fail.sql': 'CREATE TABLE never_after_commit (id INT);',
    },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      pool.failCommitForVersion = '001_commit_fail.sql';
      const runner = new DatabaseMigrationRunner(pool);

      await assert.rejects(
        () => runner.applyPendingMigrations(dir),
        (err: unknown) =>
          err instanceof DatabaseCoordinationError &&
          err.code === 'MIGRATION_COMMIT_FAILED' &&
          err.cause instanceof Error &&
          err.cause.message.includes('SYNTHETIC_COMMIT_ERROR:001_commit_fail.sql'),
      );

      assert.equal(pool.committedTables.has('commit_fail_tbl'), false);
      assert.equal(pool.committedTables.has('never_after_commit'), false);
      assert.equal(pool.committedMigrations.size, 0);
      assert.ok(pool.opLog.some((op) => op.sql === 'ROLLBACK'));
      assert.equal(pool.lockRegistry.size, 0);
    },
  );

  // E2: COMMIT fails AND ROLLBACK fails (unusable connection) -> primary commit error preserved AND connection-A discarded!
  await withTempMigrationsDir(
    {
      '001_commit_broken.sql': 'CREATE TABLE broken_conn_tbl (id INT);',
      '002_never_runs.sql': 'CREATE TABLE never_runs_tbl (id INT);',
    },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      pool.failCommitForVersion = '001_commit_broken.sql';
      pool.failRollback = true;
      const runner = new DatabaseMigrationRunner(pool);

      await assert.rejects(
        () => runner.applyPendingMigrations(dir),
        (err: unknown) =>
          err instanceof DatabaseCoordinationError &&
          err.code === 'MIGRATION_COMMIT_FAILED' &&
          err.diagnostics.connectionInvalidated === true &&
          err.diagnostics.secondaryErrorCode === 'MIGRATION_ROLLBACK_FAILED' &&
          err.cause instanceof Error &&
          err.cause.message.includes('SYNTHETIC_COMMIT_ERROR:001_commit_broken.sql'),
      );

      const metaA = pool.connectionMeta.get('connection-A')!;
      assert.equal(metaA.poisoned, true);
      assert.equal(metaA.discarded, true);
      assert.equal(metaA.checkedOut, false);
      assert.equal(pool.committedTables.has('never_runs_tbl'), false);
      assert.equal(pool.lockRegistry.size, 0);
    },
  );
});

test('F. Checksum mismatch rejects before applying later migrations and cleanly releases advisory lock on same connection', async () => {
  await withTempMigrationsDir(
    {
      '001_base.sql': 'CREATE TABLE base_tbl (id INT);',
      '002_later.sql': 'CREATE TABLE later_tbl (id INT);',
    },
    async (dir) => {
      const pool = new TransactionalMigrationPoolSimulator();
      const runner = new DatabaseMigrationRunner(pool);

      // Apply 001_base only first by temporarily removing 002_later
      const laterPath = path.join(dir, '002_later.sql');
      const laterContent = fs.readFileSync(laterPath, 'utf8');
      fs.rmSync(laterPath);
      const first = await runner.applyPendingMigrations(dir);
      assert.deepEqual(first.appliedMigrations, ['001_base.sql']);

      // Now tamper with 001_base.sql and add 002_later.sql
      fs.writeFileSync(path.join(dir, '001_base.sql'), 'CREATE TABLE base_tbl (id BIGINT);', 'utf8');
      fs.writeFileSync(laterPath, laterContent, 'utf8');
      pool.opLog.length = 0;

      await assert.rejects(
        () => runner.applyPendingMigrations(dir),
        /MIGRATION_CHECKSUM_MISMATCH/,
      );

      assert.equal(pool.committedTables.has('later_tbl'), false);
      assert.equal(pool.committedMigrations.has('002_later.sql'), false);
      assert.equal(
        pool.opLog.some((op) => op.sql === 'BEGIN'),
        false,
        'No migration transaction may start after checksum mismatch',
      );
      assert.ok(pool.opLog.some((op) => op.sql.includes('pg_advisory_unlock')));
      assert.equal(pool.lockRegistry.size, 0);
    },
  );
});
