import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PgPoolLike } from '../PlatformBackendServices';
import { AdvisoryLockCoordinator } from '../ops/BackendJobOutboxAndAdvisoryLockService';

export interface MigrationRunSummary {
  readonly appliedMigrations: string[];
  readonly skippedAlreadyApplied: string[];
}

export class DatabaseMigrationRunner {
  private static readonly MIGRATION_LOCK_ID = 90481201;

  constructor(private readonly db: PgPoolLike) {}

  public async applyPendingMigrations(migrationsDir: string): Promise<MigrationRunSummary> {
    const lockCoordinator = new AdvisoryLockCoordinator(this.db);
    let summary: MigrationRunSummary = {
      appliedMigrations: [],
      skippedAlreadyApplied: [],
    };

    const lockResult = await lockCoordinator.runWithAdvisoryLock(
      DatabaseMigrationRunner.MIGRATION_LOCK_ID,
      async () => {
        // 1. Ensure schema_migrations tracking table exists
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(128) PRIMARY KEY,
            checksum_sha256 CHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        const appliedRes = await this.db.query<{
          version: string;
          checksum_sha256: string;
        }>(`SELECT version, checksum_sha256 FROM schema_migrations`);

        const appliedMap = new Map<string, string>(
          appliedRes.rows.map((r) => [r.version, r.checksum_sha256])
        );

        const files = fs
          .readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort((a, b) => a.localeCompare(b));

        const appliedNow: string[] = [];
        const skipped: string[] = [];

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
                `MIGRATION_CHECKSUM_MISMATCH: فایل مهاجرت قبلی «${fileName}» پس از اجرا تغییر داده شده است!`
              );
            }
            skipped.push(fileName);
            continue;
          }

          await this.db.query('BEGIN');
          try {
            await this.db.query(sqlContent);
            await this.db.query(
              `INSERT INTO schema_migrations (version, checksum_sha256) VALUES ($1, $2)`,
              [fileName, checksum]
            );
            await this.db.query('COMMIT');
            appliedNow.push(fileName);
          } catch (err) {
            await this.db.query('ROLLBACK');
            throw err;
          }
        }

        summary = {
          appliedMigrations: appliedNow,
          skippedAlreadyApplied: skipped,
        };
      }
    );

    if (!lockResult.lockAcquired) {
      throw new Error(
        'MIGRATION_LOCK_BUSY: نمونه دیگری از سرور هم‌اکنون در حال اجرای مهاجرت دیتابیس است.'
      );
    }

    return summary;
  }
}
