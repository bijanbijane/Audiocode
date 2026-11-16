import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendModelCanaryRolloutService } from './BackendModelCanaryRolloutService';
import { SingleFlightReadThroughCache } from '../cache/BackendReadThroughCacheAndMetrics';
import { FastifyInstanceLike, FastifyReplyLike, PgPoolLike } from '../PlatformBackendServices';

describe('Section 127: BackendModelCanaryRolloutService', () => {
  it('assigns sticky SHA-256 canary cohorts and triggers auto-rollback on chunk failure spike', async () => {
    let rolloutState = 'CANARY_ACTIVE';
    const mockDb: PgPoolLike = {
      async query<TRow>(sql: string) {
        if (sql.includes('FROM model_rollout_policies')) {
          return {
            rows: [
              {
                model_id: 'fastconformer-fa',
                stable_version: '1.1.0',
                candidate_version: '1.2.0',
                canary_percentage: 50,
                rollout_state: rolloutState,
                max_failure_rate_pct: 5.0,
                min_telemetry_samples: 50,
                rollout_started_at: new Date(),
              },
            ] as unknown as TRow[],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM model_delivery_telemetry')) {
          return {
            rows: [{ ok_cnt: '90', fail_cnt: '10' }] as unknown as TRow[],
            rowCount: 1,
          };
        }
        if (sql.includes("SET rollout_state = 'HALTED_ROLLBACK'")) {
          rolloutState = 'HALTED_ROLLBACK';
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    const cache = new SingleFlightReadThroughCache();
    const svc = new BackendModelCanaryRolloutService(mockDb, cache, 'admin_127');

    const postRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
    const mockFastify: FastifyInstanceLike = {
      get() {},
      post(url, handler) {
        postRoutes.set(url, handler);
      },
    };
    svc.registerRoutes(mockFastify);

    const b1 = svc.computeDeterministicBucket('usr_42', 'fastconformer-fa');
    const b2 = svc.computeDeterministicBucket('usr_42', 'fastconformer-fa');
    assert.equal(b1, b2, 'Sticky canary bucket must be deterministic');

    let payload: any = null;
    const reply: FastifyReplyLike = {
      status() {
        return reply;
      },
      header() {
        return reply;
      },
      send(p) {
        payload = p;
        return p;
      },
    };

    await postRoutes.get('/api/v1/admin/models/:modelId/rollout/evaluate')!(
      {
        params: { modelId: 'fastconformer-fa' },
        body: {},
        headers: { 'x-admin-api-key': 'admin_127' },
      },
      reply,
    );

    assert.equal(payload.action, 'AUTO_ROLLBACK_TRIGGERED');
    assert.equal(rolloutState, 'HALTED_ROLLBACK');
  });
});
