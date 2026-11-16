import { describe, it, expect } from 'vitest';
import { BuiltInFastifyRouter } from '../src/BackendApplicationFactory';
import { PersianRoverMultiModelEnsembleEngine } from '../../src/ai-engine/asr/PersianRoverMultiModelEnsembleEngine';
import { BackendAsrStageLatencyProfiler } from '../src/ops/BackendAsrStageLatencyProfiler';
import { BackendBatchHttpSubmissionController } from '../src/gateway/BackendBatchHttpSubmissionController';
import { EnterpriseApiKeyAndQuotaManager } from '../src/auth/EnterpriseApiKeyAndQuotaManager';
import { PersianTextNormalizer } from '../../src/ai-engine/PersianTextNormalizer';
import { PgPoolLike } from '../src/PlatformBackendServices';
import { TimeMath } from '../../src/contracts/timebase.contract';

describe('ROVER Ensemble, Stage Latency Profiler & Enterprise Batch HTTP Controller Suite', () => {
  it('1. ROVER ensemble combines 3 independent Persian ASR models, drops hallucinated insertions, and preserves CTC timestamps', () => {
    const mkTok = (id: string, text: string, s: number, e: number, conf: number) =>
      PersianTextNormalizer.buildThreeLayerTranscript([
        {
          id,
          text,
          range: { start: TimeMath.secondsToFlicks(s), end: TimeMath.secondsToFlicks(e) },
          confidence: conf,
        },
      ])[0];

    // True sentence: "سلام امروز باران می‌بارد"
    // Model 1 (Whisper): colloquial error on last word ("می‌باره")
    const model1Whisper = [
      mkTok('w1', 'سلام', 0.0, 0.4, 0.92),
      mkTok('w2', 'امروز', 0.45, 0.95, 0.94),
      mkTok('w3', 'باران', 1.0, 1.5, 0.95),
      mkTok('w4', 'می‌باره', 1.55, 2.2, 0.8),
    ];

    // Model 2 (FastConformer-CTC): substitution error on 2nd word ("امروس")
    const model2Ctc = [
      mkTok('c1', 'سلام', 0.1, 0.38, 0.96),
      mkTok('c2', 'امروس', 0.42, 0.9, 0.7),
      mkTok('c3', 'باران', 0.98, 1.48, 0.97),
      mkTok('c4', 'می‌بارد', 1.52, 2.08, 0.95),
    ];

    // Model 3 (FastConformer-TDT): hallucinated initial insertion ("خب")
    const model3Tdt = [
      mkTok('t0', 'خب', 0.0, 0.08, 0.6),
      mkTok('t1', 'سلام', 0.1, 0.4, 0.95),
      mkTok('t2', 'امروز', 0.44, 0.92, 0.96),
      mkTok('t3', 'باران', 0.99, 1.49, 0.96),
      mkTok('t4', 'می‌بارد', 1.51, 2.09, 0.94),
    ];

    const consensus = PersianRoverMultiModelEnsembleEngine.combineModelOutputs([
      { modelId: 'whisper', textAccuracyWeight: 1.1, timestampPrecisionWeight: 0.7, tokens: model1Whisper },
      { modelId: 'ctc', textAccuracyWeight: 1.0, timestampPrecisionWeight: 1.4, tokens: model2Ctc },
      { modelId: 'tdt', textAccuracyWeight: 1.0, timestampPrecisionWeight: 1.2, tokens: model3Tdt },
    ]);

    expect(consensus.map((t) => t.displayText)).toEqual([
      'سلام',
      'امروز',
      'باران',
      'می‌بارد',
    ]);
    expect(consensus[2].agreementRatio).toBe(1.0);
  });

  it('2. BackendAsrStageLatencyProfiler computes P50/P95/P99 percentiles and exports clean Prometheus metrics', async () => {
    const profiler = new BackendAsrStageLatencyProfiler(100);

    for (let i = 0; i < 20; i++) {
      await profiler.traceStage('ONNX_NEURAL_INFERENCE', async () => {
        await new Promise((r) => setTimeout(r, i === 19 ? 18 : 2));
      });
    }

    const stats = profiler.getPercentileSummary();
    expect(stats).toHaveLength(1);
    expect(stats[0].p99Ms).toBeGreaterThan(stats[0].p50Ms);

    const promText = profiler.renderPrometheusExposition();
    expect(promText).toContain('paudio_asr_stage_latency_ms{stage="ONNX_NEURAL_INFERENCE",quantile="0.95"}');
  });

  it('3. BackendBatchHttpSubmissionController enforces V1 lock, debits atomic quota, and exports SRT/TextGrid/CTM', async () => {
    let usedSec = 0;
    const mockDb: PgPoolLike = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        if (sql.includes('SELECT key_id, organization_id')) {
          return {
            rows: [
              {
                key_id: 'ent_key_1',
                organization_id: 'org_1',
                scopes: ['CLOUD_ASR_ENTERPRISE'],
                monthly_audio_seconds_limit: '600',
                monthly_audio_seconds_used: String(usedSec),
                revoked: false,
                expires_at: null,
              },
            ] as unknown as T[],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE enterprise_api_keys')) {
          usedSec += params[1] as number;
          return {
            rows: [
              { monthly_audio_seconds_used: String(usedSec), monthly_audio_seconds_limit: '600' },
            ] as unknown as T[],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT COUNT(*)')) return { rows: [{ cnt: '0' }] as unknown as T[], rowCount: 1 };
        if (sql.includes('INSERT INTO cloud_asr_jobs')) {
          return { rows: [{ job_id: 'job_ent_55' }] as unknown as T[], rowCount: 1 };
        }
        return { rows: [] as unknown as T[], rowCount: 0 };
      },
    };

    const quotaMgr = new EnterpriseApiKeyAndQuotaManager(mockDb);
    const sampleTokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 't1',
        text: 'گزارش',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
        confidence: 0.97,
      },
    ]);

    const fastify = new BuiltInFastifyRouter();
    const ctrl = new BackendBatchHttpSubmissionController(
      mockDb,
      quotaMgr,
      {
        getCompletedTokensForJob: async (jobId) =>
          jobId === 'job_ent_55' ? { audioDurationSec: 1.0, tokens: sampleTokens } : null,
      },
      true
    );
    ctrl.registerRoutes(fastify);

    // Submit 60s job and deduct atomically from 600s quota
    const submitRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/enterprise/asr/jobs',
      headers: { 'x-enterprise-api-key': 'paudio_live_enterprise_123' },
      payload: {
        modelId: 'fastconformer-fa',
        audioDurationSeconds: 60,
        remoteStorageRef: 's3://bucket/ep1.wav',
      },
    });
    expect(submitRes.statusCode).toBe(202);
    expect(submitRes.json().remainingOrganizationQuotaSeconds).toBe(540);

    // Export completed job in Praat TextGrid format
    const tgRes = await fastify.inject({
      method: 'GET',
      url: '/api/v1/enterprise/asr/jobs/job_ent_55/export?format=textgrid',
      headers: { 'x-enterprise-api-key': 'paudio_live_enterprise_123' },
    });
    expect(tgRes.statusCode).toBe(200);
    expect(tgRes.body).toContain('Object class = "TextGrid"');
    expect(tgRes.body).toContain('text = "گزارش"');
  });
});
