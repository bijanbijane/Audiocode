import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PgPoolLike } from '../PlatformBackendServices';
import { AdvisoryLockCoordinator } from '../ops/BackendJobOutboxAndAdvisoryLockService';
import {
  DatabaseCoordinationError,
  DatabaseCoordinationErrorCode,
} from './PinnedPostgresTransaction';

export interface MigrationRunSummary {
  readonly appliedMigrations: string[];
  readonly skippedAlreadyApplied: string[];
}

type MigrationTxState =
  | 'IDLE'
  | 'OPEN'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'UNCERTAIN';

export class DatabaseMigrationRunner {
  private static readonly MIGRATION_LOCK_ID = 90481201;

  constructor(private readonly db: PgPoolLike) {}

  /**
   * Applies all pending SQL migrations atomically on a single physically pinned PostgreSQL
   * connection owned by the cluster-wide session advisory lock.
   *
   * Invariants:
   * - `pg_try_advisory_lock`, `schema_migrations` initialization, applied checksum queries,
   *   every per-migration `BEGIN` / SQL / checksum `INSERT` / `COMMIT` / `ROLLBACK`, and
   *   `pg_advisory_unlock` execute exclusively on one pinned connection.
   * - Migration SQL and checksum recording commit atomically in the same transaction.
   * - The session advisory lock remains held across the entire migration batch.
   */
  public async applyPendingMigrations(migrationsDir: string): Promise<MigrationRunSummary> {
    const lockCoordinator = new AdvisoryLockCoordinator(this.db);
    let summary: MigrationRunSummary = {
      appliedMigrations: [],
      skippedAlreadyApplied: [],
    };

    const lockResult = await lockCoordinator.runWithAdvisoryLock(
      DatabaseMigrationRunner.MIGRATION_LOCK_ID,
      async (client) => {
        // 1. Ensure schema_migrations tracking table exists on the pinned session connection
        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(128) PRIMARY KEY,
            checksum_sha256 CHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        // 2. Load applied migration checksums on the same pinned connection
        const appliedRes = await client.query<{
          version: string;
          checksum_sha256: string;
        }>(`SELECT version, checksum_sha256 FROM schema_migrations`);

        const appliedMap = new Map<string, string>(
          appliedRes.rows.map((r) => [r.version, r.checksum_sha256]),
        );

        // 3. Discover and deterministically sort migration SQL files
        const files = fs
          .readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort((a, b) => {
            if (a === 'schema.sql') return b === 'schema.sql' ? 0 : -1;
            if (b === 'schema.sql') return 1;
            return a.localeCompare(b);
          });

        const appliedNow: string[] = [];
        const skipped: string[] = [];

        // 4. Execute each pending migration in its own atomic transaction on the pinned connection
        for (const fileName of files) {
          const fullPath = path.join(migrationsDir, fileName);
          const sqlContent = fs.readFileSync(fullPath, 'utf8');
          const checksum = crypto
            .createHash('sha256')
            .update(sqlContent, 'utf8')
            .digest('hex');

          const existingChecksum = appliedMap.get(fileName);
          if (existingChecksum) {
            if (existingChecksum !== checksum) {
              throw new Error(
                `MIGRATION_CHECKSUM_MISMATCH: فایل مهاجرت قبلی «${fileName}» پس از اجرا تغییر داده شده است!`,
              );
            }
            skipped.push(fileName);
            continue;
          }

          let txState: MigrationTxState = 'IDLE';
          try {
            await client.query('BEGIN');
            txState = 'OPEN';

            await client.query(sqlContent);
            await client.query(
              `INSERT INTO schema_migrations (version, checksum_sha256) VALUES ($1, $2)`,
              [fileName, checksum],
            );

            txState = 'COMMITTING';
            await client.query('COMMIT');
            txState = 'COMMITTED';
            appliedNow.push(fileName);
          } catch (primaryErr) {
            const primaryCode: DatabaseCoordinationErrorCode =
              txState === 'COMMITTING'
                ? 'MIGRATION_COMMIT_FAILED'
                : 'MIGRATION_TRANSACTION_FAILED';

            if (txState === 'COMMITTING') {
              txState = 'UNCERTAIN';
            }

            let rollbackError: unknown = undefined;
            let connectionInvalidated = false;

            if (txState === 'OPEN' || txState === 'UNCERTAIN') {
              try {
                await client.query('ROLLBACK');
                txState = 'ROLLED_BACK';
              } catch (rbErr) {
                rollbackError = rbErr;
                txState = 'UNCERTAIN';
                connectionInvalidated = true;
              }
            } else {
              // Failure occurred during BEGIN before transaction state could be confirmed
              txState = 'UNCERTAIN';
              connectionInvalidated = true;
            }

            if (connectionInvalidated) {
              client.release(
                new DatabaseCoordinationError(
                  'MIGRATION_CONNECTION_INVALID',
                  `Invalidating pinned PostgreSQL connection after uncertain transaction state on migration ${fileName}.`,
                  {
                    cause: rollbackError ?? primaryErr,
                    diagnostics: {
                      migrationVersion: fileName,
                      connectionInvalidated: true,
                    },
                  },
                ),
              );
            }

            throw new DatabaseCoordinationError(
              primaryCode,
              `Migration ${fileName} failed during ${
                primaryCode === 'MIGRATION_COMMIT_FAILED' ? 'COMMIT' : 'transaction execution'
              }.`,
              {
                cause: primaryErr,
                diagnostics: {
                  migrationVersion: fileName,
                  connectionInvalidated,
                  secondaryErrorCode:
                    rollbackError !== undefined ? 'MIGRATION_ROLLBACK_FAILED' : undefined,
                  secondaryErrorMessage:
                    rollbackError instanceof Error ? rollbackError.message : undefined,
                },
              },
            );
          }
        }

        summary = {
          appliedMigrations: appliedNow,
          skippedAlreadyApplied: skipped,
        };
      },
    );

    if (!lockResult.lockAcquired) {
      throw new Error(
        'MIGRATION_LOCK_BUSY: نمونه دیگری از سرور هم‌اکنون در حال اجرای مهاجرت دیتابیس است.',
      );
    }

    return summary;
  }
}
