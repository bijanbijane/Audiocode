import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WhisperCrossAttentionDtwAligner,
  WhisperTokenWithLogProb,
} from '../../src/ai-engine/asr/WhisperCrossAttentionDtwAligner';
import { DatabaseMigrationRunner } from '../src/db/DatabaseMigrationRunner';
import { BackendBackgroundCronDaemon } from '../src/ops/BackendBackgroundCronDaemon';
import { PgPoolLike } from '../src/PlatformBackendServices';

describe('Whisper Cross-Attention DTW, Idempotent SQL Migrations & Cron Daemon Suite', () => {
  it('1. WhisperCrossAttentionDtwAligner extracts exact unequal word durations and ignores 30s silence padding', () => {
    // Simulate two Persian words in 2s of real audio (100 frames @ 20ms) inside a 1500-frame (30s) buffer
    // First word "سلام" in frames 10..30 (0.2s..0.6s), second elongated word "جهان" in frames 40..90 (0.8s..1.8s)
    const tokens: WhisperTokenWithLogProb[] = [
      { tokenId: 100, decodedUtf8Piece: 'سلام', probability: 0.96 },
      { tokenId: 101, decodedUtf8Piece: ' جهان', probability: 0.94 },
    ];

    const totalEncFrames = 1500;
    const head1 = new Float32Array(tokens.length * totalEncFrames).fill(0.001);

    // Token 0 attention concentrated around frames 10..30
    for (let f = 10; f < 30; f++) head1[0 * totalEncFrames + f] = 0.85;
    // Token 1 attention concentrated around frames 40..90
    for (let f = 40; f < 90; f++) head1[1 * totalEncFrames + f] = 0.85;

    const words = WhisperCrossAttentionDtwAligner.alignTokensAndGroupWords({
      tokens,
      crossAttentionHeads: [head1],
      totalEncoderFramesPerRow: totalEncFrames,
      actualAudioSamples16k: 32000, // Exactly 2 seconds of real audio (100 encoder frames)
      medianFilterWidth: 5,
    });

    expect(words).toHaveLength(2);
    expect(words[0].word).toBe('سلام');
    expect(words[1].word).toBe('جهان');
    // Second word must not bleed into the 1500-frame padding beyond 2.0s
    expect(words[0].relativeEndSec).toBeLessThanOrEqual(words[1].relativeStartSec + 0.15);
    expect(words[1].relativeEndSec).toBeLessThanOrEqual(2.02);
  });

  it('2. DatabaseMigrationRunner applies pending SQL files once on one pinned connection and rejects tampered applied SQL checksums', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paudio_mig_'));
    const mig1Path = path.join(tmpDir, '001_init.sql');
    fs.writeFileSync(mig1Path, 'CREATE TABLE demo_t (id INT);', 'utf8');

    const appliedRows = new Map<string, string>();
    const activeLocks = new Set<number>();
    let directPoolQueries = 0;

    const mockDb: PgPoolLike = {
      async query() {
        directPoolQueries++;
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        const ownedLocks = new Set<number>();
        let inTx = false;
        let stagedMigrations = new Map<string, string>();

        return {
          async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            const trimmed = sql.trim();
            if (trimmed.includes('pg_try_advisory_lock')) {
              const id = Number(params[0]);
              if (activeLocks.has(id)) {
                return { rows: [{ acquired: false }] as unknown as T[], rowCount: 1 };
              }
              activeLocks.add(id);
              ownedLocks.add(id);
              return { rows: [{ acquired: true }] as unknown as T[], rowCount: 1 };
            }
            if (trimmed.includes('pg_advisory_unlock')) {
              const id = Number(params[0]);
              const ok = ownedLocks.delete(id);
              if (ok) activeLocks.delete(id);
              return { rows: [{ unlocked: ok }] as unknown as T[], rowCount: 1 };
            }
            if (trimmed === 'BEGIN') {
              inTx = true;
              stagedMigrations = new Map();
              return { rows: [] as unknown as T[], rowCount: null };
            }
            if (trimmed === 'COMMIT') {
              for (const [k, v] of stagedMigrations.entries()) appliedRows.set(k, v);
              stagedMigrations.clear();
              inTx = false;
              return { rows: [] as unknown as T[], rowCount: null };
            }
            if (trimmed === 'ROLLBACK') {
              stagedMigrations.clear();
              inTx = false;
              return { rows: [] as unknown as T[], rowCount: null };
            }
            if (trimmed.includes('SELECT version, checksum_sha256')) {
              return {
                rows: Array.from(appliedRows.entries()).map(([version, checksum_sha256]) => ({
                  version,
                  checksum_sha256,
                })) as unknown as T[],
                rowCount: appliedRows.size,
              };
            }
            if (trimmed.includes('INSERT INTO schema_migrations')) {
              const ver = params[0] as string;
              const sum = params[1] as string;
              if (inTx) stagedMigrations.set(ver, sum);
              else appliedRows.set(ver, sum);
              return { rows: [] as unknown as T[], rowCount: 1 };
            }
            return { rows: [] as unknown as T[], rowCount: 0 };
          },
          release() {
            for (const id of ownedLocks) activeLocks.delete(id);
            ownedLocks.clear();
          },
        };
      },
    };

    try {
      const runner = new DatabaseMigrationRunner(mockDb);

      // First run: applies 001_init.sql atomically on pinned connection
      const run1 = await runner.applyPendingMigrations(tmpDir);
      expect(run1.appliedMigrations).toEqual(['001_init.sql']);
      expect(directPoolQueries).toBe(0);
      expect(activeLocks.size).toBe(0);

      // Second run without changes: skips idempotently
      const run2 = await runner.applyPendingMigrations(tmpDir);
      expect(run2.appliedMigrations).toEqual([]);
      expect(run2.skippedAlreadyApplied).toEqual(['001_init.sql']);

      // Tamper with previously applied migration file -> must throw checksum error & release lock
      fs.writeFileSync(mig1Path, 'CREATE TABLE demo_t (id BIGINT);', 'utf8');
      await expect(runner.applyPendingMigrations(tmpDir)).rejects.toThrow(
        'MIGRATION_CHECKSUM_MISMATCH',
      );
      expect(activeLocks.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. BackendBackgroundCronDaemon runs outbox batch cleanly under pinned PostgreSQL advisory lock', async () => {
    const publishedIds: string[] = [];
    const activeLocks = new Set<number>();

    const mockDb: PgPoolLike = {
      async query<T = Record<string, unknown>>(sql: string) {
        if (sql.includes('WITH claimed AS')) {
          return {
            rows: [
              {
                event_id: 'evt_1',
                event_type: 'MODEL_REVOKED',
                payload_json: { modelId: 'whisper-fa' },
                attempts: 1,
              },
            ] as unknown as T[],
            rowCount: 1,
          };
        }
        return { rows: [] as unknown as T[], rowCount: 1 };
      },
      async connect() {
        const ownedLocks = new Set<number>();
        return {
          async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            if (sql.includes('pg_try_advisory_lock')) {
              const id = Number(params[0]);
              if (activeLocks.has(id)) {
                return { rows: [{ acquired: false }] as unknown as T[], rowCount: 1 };
              }
              activeLocks.add(id);
              ownedLocks.add(id);
              return { rows: [{ acquired: true }] as unknown as T[], rowCount: 1 };
            }
            if (sql.includes('pg_advisory_unlock')) {
              const id = Number(params[0]);
              const ok = ownedLocks.delete(id);
              if (ok) activeLocks.delete(id);
              return { rows: [{ unlocked: ok }] as unknown as T[], rowCount: 1 };
            }
            return { rows: [] as unknown as T[], rowCount: 0 };
          },
          release() {
            for (const id of ownedLocks) activeLocks.delete(id);
            ownedLocks.clear();
          },
        };
      },
    };

    const daemon = new BackendBackgroundCronDaemon(
      mockDb,
      async (evt) => {
        publishedIds.push(evt.eventId);
      },
      false,
    );

    const tickRes = await daemon.runSingleSweepTick();
    expect(tickRes.executed).toBe(true);
    expect(tickRes.outboxDispatched).toBe(1);
    expect(publishedIds).toEqual(['evt_1']);
    expect(activeLocks.size).toBe(0);
  });

  it('4. Two simulated backend replicas cannot execute the same lock-protected maintenance sweep simultaneously', async () => {
    const activeLocks = new Map<number, string>();
    let connSeq = 0;

    const sharedDb: PgPoolLike = {
      async query<T = Record<string, unknown>>(sql: string) {
        if (sql.includes('WITH claimed AS')) {
          return {
            rows: [
              {
                event_id: 'evt_shared_1',
                event_type: 'LICENSE_REVOKED',
                payload_json: {},
                attempts: 1,
              },
            ] as unknown as T[],
            rowCount: 1,
          };
        }
        return { rows: [] as unknown as T[], rowCount: 0 };
      },
      async connect() {
        const sessionId = `session_${++connSeq}`;
        const ownedLocks = new Set<number>();
        return {
          async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            if (sql.includes('pg_try_advisory_lock')) {
              const id = Number(params[0]);
              const current = activeLocks.get(id);
              if (current && current !== sessionId) {
                return { rows: [{ acquired: false }] as unknown as T[], rowCount: 1 };
              }
              activeLocks.set(id, sessionId);
              ownedLocks.add(id);
              return { rows: [{ acquired: true }] as unknown as T[], rowCount: 1 };
            }
            if (sql.includes('pg_advisory_unlock')) {
              const id = Number(params[0]);
              if (activeLocks.get(id) === sessionId) {
                activeLocks.delete(id);
                ownedLocks.delete(id);
                return { rows: [{ unlocked: true }] as unknown as T[], rowCount: 1 };
              }
              return { rows: [{ unlocked: false }] as unknown as T[], rowCount: 1 };
            }
            return { rows: [] as unknown as T[], rowCount: 0 };
          },
          release() {
            for (const id of ownedLocks) {
              if (activeLocks.get(id) === sessionId) activeLocks.delete(id);
            }
            ownedLocks.clear();
          },
        };
      },
    };

    let releaseReplica1!: () => void;
    const replica1Gate = new Promise<void>((resolve) => {
      releaseReplica1 = resolve;
    });
    let notifyReplica1Running!: () => void;
    const replica1Running = new Promise<void>((resolve) => {
      notifyReplica1Running = resolve;
    });

    let activeSweeps = 0;
    let peakConcurrentSweeps = 0;

    const replica1 = new BackendBackgroundCronDaemon(sharedDb, async () => {
      activeSweeps++;
      peakConcurrentSweeps = Math.max(peakConcurrentSweeps, activeSweeps);
      notifyReplica1Running();
      await replica1Gate;
      activeSweeps--;
    });

    const replica2 = new BackendBackgroundCronDaemon(sharedDb, async () => {
      activeSweeps++;
      peakConcurrentSweeps = Math.max(peakConcurrentSweeps, activeSweeps);
      activeSweeps--;
    });

    const p1 = replica1.runSingleSweepTick();
    await replica1Running;

    const r2 = await replica2.runSingleSweepTick();
    expect(r2.executed).toBe(false);
    expect(r2.outboxDispatched).toBe(0);

    releaseReplica1();
    const r1 = await p1;
    expect(r1.executed).toBe(true);
    expect(r1.outboxDispatched).toBe(1);
    expect(peakConcurrentSweeps).toBe(1);
    expect(activeLocks.size).toBe(0);

    // After replica 1 releases, replica 2 can execute the next sweep
    const r2Next = await replica2.runSingleSweepTick();
    expect(r2Next.executed).toBe(true);
    expect(activeLocks.size).toBe(0);
  });
});
