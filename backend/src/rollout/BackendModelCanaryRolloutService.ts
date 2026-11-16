import crypto from 'node:crypto';
import type { FastifyInstanceLike, PgPoolLike } from '../PlatformBackendServices';
import { SingleFlightReadThroughCache } from '../cache/BackendReadThroughCacheAndMetrics';

export interface ModelAssignmentResolution {
  readonly modelId: string;
  readonly assignedVersion: string;
  readonly cohort: 'STABLE' | 'CANARY';
}

/**
 * Section 127: Sticky Canary Rollout Assignment, Telemetry Health Evaluation & Automatic Rollback Service
 */
export class BackendModelCanaryRolloutService {
  constructor(
    private readonly db: PgPoolLike,
    private readonly sharedCache: SingleFlightReadThroughCache,
    private readonly adminApiKey: string,
  ) {}

  public registerRoutes(fastify: FastifyInstanceLike): void {
    /**
     * 1. Sticky Deterministic Model Version Assignment (SHA-256 user+model bucket 0..99)
     */
    fastify.get<{
      Querystring: { userId: string; modelId: string };
    }>('/api/v1/models/resolve-assignment', async (request, reply) => {
      const { userId, modelId } = request.query;
      if (!userId || !modelId) {
        return reply.status(400).send({ error: 'MISSING_USER_OR_MODEL_ID' });
      }

      const policy = await this.sharedCache.getOrComputeSingleFlight(
        `rollout_policy:${modelId}`,
        15_000,
        async () => {
          const res = await this.db.query<{
            stable_version: string;
            candidate_version: string | null;
            canary_percentage: number;
            rollout_state: string;
          }>(
            `SELECT stable_version, candidate_version, canary_percentage, rollout_state
             FROM model_rollout_policies
             WHERE model_id = $1`,
            [modelId],
          );
          return res.rows[0] ?? null;
        },
      );

      if (!policy) {
        return reply.status(404).send({ error: 'ROLLOUT_POLICY_NOT_FOUND' });
      }

      let assignedVersion = policy.stable_version;
      let cohort: 'STABLE' | 'CANARY' = 'STABLE';

      if (
        policy.rollout_state === 'CANARY_ACTIVE' &&
        policy.candidate_version &&
        policy.canary_percentage > 0
      ) {
        const bucket0To99 = this.computeDeterministicBucket(userId, modelId);
        if (bucket0To99 < policy.canary_percentage) {
          assignedVersion = policy.candidate_version;
          cohort = 'CANARY';
        }
      }

      const resolution: ModelAssignmentResolution = {
        modelId,
        assignedVersion,
        cohort,
      };
      return reply.send(resolution);
    });

    /**
     * 2. Automated Canary Health Evaluation from Telemetry & Atomic Rollback on Failure Spike
     */
    fastify.post<{
      Headers: { 'x-admin-api-key'?: string };
      Params: { modelId: string };
    }>('/api/v1/admin/models/:modelId/rollout/evaluate', async (request, reply) => {
      if (!this.verifyAdminKey(request.headers['x-admin-api-key'] ?? '')) {
        return reply.status(401).send({ error: 'ADMIN_UNAUTHORIZED' });
      }

      const { modelId } = request.params;
      const polRes = await this.db.query<{
        stable_version: string;
        candidate_version: string | null;
        rollout_state: string;
        max_failure_rate_pct: number;
        min_telemetry_samples: number;
        rollout_started_at: Date;
      }>(`SELECT * FROM model_rollout_policies WHERE model_id = $1`, [modelId]);

      if (polRes.rows.length === 0) {
        return reply.status(404).send({ error: 'ROLLOUT_POLICY_NOT_FOUND' });
      }

      const pol = polRes.rows[0];
      if (pol.rollout_state !== 'CANARY_ACTIVE' || !pol.candidate_version) {
        return reply.send({ evaluated: false, state: pol.rollout_state });
      }

      const statsRes = await this.db.query<{
        ok_cnt: string;
        fail_cnt: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'CHUNK_DOWNLOAD_OK')::text AS ok_cnt,
           COUNT(*) FILTER (WHERE event_type = 'CHUNK_FAILURE')::text AS fail_cnt
         FROM model_delivery_telemetry
         WHERE model_id = $1 AND version = $2 AND recorded_at >= $3`,
        [modelId, pol.candidate_version, pol.rollout_started_at],
      );

      const okCount = parseInt(statsRes.rows[0]?.ok_cnt ?? '0', 10);
      const failCount = parseInt(statsRes.rows[0]?.fail_cnt ?? '0', 10);
      const totalSamples = okCount + failCount;

      if (totalSamples < pol.min_telemetry_samples) {
        return reply.send({
          evaluated: true,
          action: 'WAIT_FOR_MORE_SAMPLES',
          totalSamples,
          requiredMinSamples: pol.min_telemetry_samples,
        });
      }

      const failureRatePct = Number(((failCount / totalSamples) * 100).toFixed(2));

      if (failureRatePct > pol.max_failure_rate_pct) {
        await this.db.query('BEGIN');
        try {
          await this.db.query(
            `UPDATE model_rollout_policies
             SET rollout_state = 'HALTED_ROLLBACK', canary_percentage = 0, updated_at = NOW()
             WHERE model_id = $1`,
            [modelId],
          );
          await this.db.query(
            `UPDATE ai_models_catalog
             SET release_status = 'DEPRECATED'
             WHERE model_id = $1 AND version = $2`,
            [modelId, pol.candidate_version],
          );
          await this.db.query('COMMIT');
        } catch (err) {
          await this.db.query('ROLLBACK');
          throw err;
        }

        this.sharedCache.invalidateByPrefix(`rollout_policy:${modelId}`);
        this.sharedCache.invalidateByPrefix(`manifest:${modelId}:`);

        return reply.send({
          evaluated: true,
          action: 'AUTO_ROLLBACK_TRIGGERED',
          failureRatePct,
          thresholdPct: pol.max_failure_rate_pct,
          revertedToVersion: pol.stable_version,
        });
      }

      return reply.send({
        evaluated: true,
        action: 'CANARY_HEALTHY',
        failureRatePct,
        totalSamples,
      });
    });

    /**
     * 3. Promote Candidate Canary to General Release (100% users)
     */
    fastify.post<{
      Headers: { 'x-admin-api-key'?: string };
      Params: { modelId: string };
    }>('/api/v1/admin/models/:modelId/rollout/promote', async (request, reply) => {
      if (!this.verifyAdminKey(request.headers['x-admin-api-key'] ?? '')) {
        return reply.status(401).send({ error: 'ADMIN_UNAUTHORIZED' });
      }

      const { modelId } = request.params;
      const polRes = await this.db.query<{
        stable_version: string;
        candidate_version: string | null;
      }>(
        `SELECT stable_version, candidate_version FROM model_rollout_policies WHERE model_id = $1`,
        [modelId],
      );

      const pol = polRes.rows[0];
      if (!pol || !pol.candidate_version) {
        return reply.status(400).send({ error: 'NO_CANDIDATE_TO_PROMOTE' });
      }

      await this.db.query('BEGIN');
      try {
        await this.db.query(
          `UPDATE ai_models_catalog SET release_status = 'SUPPORTED' WHERE model_id = $1 AND version = $2`,
          [modelId, pol.stable_version],
        );
        await this.db.query(
          `UPDATE ai_models_catalog SET release_status = 'ACTIVE' WHERE model_id = $1 AND version = $2`,
          [modelId, pol.candidate_version],
        );
        await this.db.query(
          `UPDATE model_rollout_policies
           SET stable_version = $2, candidate_version = NULL, canary_percentage = 0, rollout_state = 'PROMOTED_GENERAL', updated_at = NOW()
           WHERE model_id = $1`,
          [modelId, pol.candidate_version],
        );
        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK');
        throw err;
      }

      this.sharedCache.invalidateByPrefix(`rollout_policy:${modelId}`);
      return reply.send({
        promotedVersion: pol.candidate_version,
        status: 'ACTIVE',
      });
    });
  }

  public computeDeterministicBucket(userId: string, modelId: string): number {
    const digest = crypto.createHash('sha256').update(`${userId}:${modelId}`).digest();
    return digest.readUInt32BE(0) % 100;
  }

  private verifyAdminKey(provided: string): boolean {
    if (!provided || !this.adminApiKey) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(this.adminApiKey, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
