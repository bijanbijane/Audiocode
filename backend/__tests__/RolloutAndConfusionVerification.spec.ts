import { describe, it, expect } from 'vitest';
import { CompactPersianLanguageModelScorer } from '../../src/ai-engine/asr/CompactPersianLanguageModelScorer';
import { PersianPhoneticConfusionCorrector } from '../../src/ai-engine/asr/PersianPhoneticConfusionCorrector';
import {
  WhisperPromptAndControlResolver,
  PersianNBestConfusionNetworkBuilder,
} from '../../src/ai-engine/asr/PersianNBestLatticeAndWhisperPromptEngine';
import { AsrRegressionDiffRunner } from '../src/cli/AsrRegressionDiffRunner';
import { PersianAsrBaselineReport } from '../src/cli/batch-persian-corpus-benchmark-cli';
import { BackendModelCanaryRolloutService } from '../src/rollout/BackendModelCanaryRolloutService';
import { SingleFlightReadThroughCache } from '../src/cache/BackendReadThroughCacheAndMetrics';
import {
  FastifyInstanceLike,
  FastifyReplyLike,
  PgPoolLike,
} from '../src/PlatformBackendServices';
import { PersianTextNormalizer } from '../../src/ai-engine/PersianTextNormalizer';
import { TimeMath } from '../../src/contracts/timebase.contract';

describe('Section 130: Phonetic Confusion, Whisper v3 Prompting, Regression Diff & Canary Rollout Suite', () => {
  it('1. PersianPhoneticConfusionCorrector fixes homophone errors using bilateral LM context while preserving originalText', () => {
    const lm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(
      [
        'ثبت نام در سامانه انجام شد',
        'ثبت نام کاربران جدید آغاز گردید',
        'فرایند ثبت نام سریع است',
        'تضمین کیفیت نرم‌افزار الزامی است',
        'این سیستم تضمین کیفیت دارد',
      ],
      1,
      1,
    );

    const corrector = new PersianPhoneticConfusionCorrector(
      lm,
      ['ثبت', 'تضمین', 'کیفیت', 'سامانه'],
      [{ confusedForm: 'سبت', intendedForm: 'ثبت', empiricalPriorBonus: 1.5 }],
    );

    const rawTokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 't1',
        text: 'فرایند',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.4) },
        confidence: 0.95,
      },
      {
        id: 't2',
        text: 'سبت',
        range: { start: TimeMath.secondsToFlicks(0.45), end: TimeMath.secondsToFlicks(0.8) },
        confidence: 0.72,
      },
      {
        id: 't3',
        text: 'نام',
        range: { start: TimeMath.secondsToFlicks(0.85), end: TimeMath.secondsToFlicks(1.2) },
        confidence: 0.94,
      },
    ]);

    const { correctedTokens, appliedCorrections } =
      corrector.correctTranscriptWithContextRescoring(rawTokens);

    expect(appliedCorrections).toHaveLength(1);
    expect(correctedTokens[1].displayText).toBe('ثبت');
    expect(correctedTokens[1].originalText).toBe('سبت');
  });

  it('2. WhisperPromptAndControlResolver resolves exact v2 (51865) vs v3-turbo (51866) IDs and truncates prompt to 224 tokens', () => {
    const v2Tokens = WhisperPromptAndControlResolver.resolveSpecialTokensForVocabSize(51865);
    const v3Tokens = WhisperPromptAndControlResolver.resolveSpecialTokensForVocabSize(51866);

    expect(v2Tokens.startOfPrevTokenId).toBe(50361);
    expect(v3Tokens.startOfPrevTokenId).toBe(50362);
    expect(v3Tokens.timestampBeginId).toBe(50365);

    const longMockEncoder = (_text: string) =>
      Array.from({ length: 300 }, (_, i) => 100 + i);
    const built = WhisperPromptAndControlResolver.buildInitialDecoderPromptSequence({
      vocabSize: 51866,
      encodeTextToTokenIds: longMockEncoder,
      domainHotwordsFa: ['کوبرنتیز', 'تایپ‌اسکریپت'],
    });

    expect(built.initialTokenIds).toHaveLength(228);
    expect(built.initialTokenIds[0]).toBe(50362);
    expect(built.initialTokenIds[1]).toBe(100 + (300 - 224));
  });

  it('3. PersianNBestConfusionNetworkBuilder aligns N-Best beams and surfaces uncertain word alternatives', () => {
    const network = PersianNBestConfusionNetworkBuilder.buildWordConfusionNetwork([
      { transcript: 'دکتر تباتبایی آمد', totalLogScore: -2.1 },
      { transcript: 'دکتر طباطبایی آمد', totalLogScore: -2.3 },
      { transcript: 'دکتر تبایی آمد', totalLogScore: -4.8 },
    ]);

    expect(network).toHaveLength(3);
    expect(network[1].isUncertain).toBe(true);
    expect(network[1].alternatives.map((a) => a.word)).toContain('طباطبایی');
    expect(network[1].alternatives[0].posteriorProb).toBeLessThan(0.78);
  });

  it('4. AsrRegressionDiffRunner catches Simpson Paradox when colloquial WER degrades despite overall improvement', () => {
    const makeReport = (
      ver: string,
      overall: number,
      formal: number,
      colloquial: number,
      noisy: number,
    ): PersianAsrBaselineReport => ({
      modelId: 'fastconformer-fa',
      modelVersion: ver,
      generatedAtIso: new Date().toISOString(),
      corpusAudit: {
        totalSamplesCount: 20,
        totalDurationMinutes: 120,
        distinctAccentsCount: 4,
        missingMandatoryAxes: [],
        baselineReadyForThresholdApproval: true,
      },
      totalAudioMinutesEvaluated: 120,
      durationWeightedNormalizedWerPercent: overall,
      durationWeightedRawWerPercent: overall + 1.5,
      breakdownByStyle: {
        formalNormalizedWerPercent: formal,
        colloquialNormalizedWerPercent: colloquial,
        noisyNormalizedWerPercent: noisy,
      },
      meanRealTimeFactor: 0.12,
      maxPeakRssMemoryMb: 420,
      perSampleResults: [],
    });

    const baseline = makeReport('1.1.0', 10.5, 8.0, 12.0, 14.0);
    const sneakyCandidate = makeReport('1.2.0', 10.2, 6.2, 14.5, 14.1);

    const verdict = AsrRegressionDiffRunner.compareCandidateAgainstBaseline(
      baseline,
      sneakyCandidate,
    );

    expect(verdict.promotionApproved).toBe(false);
    expect(
      verdict.blockingReasons.some((r) => r.startsWith('REGRESSION_COLLOQUIAL_SLICE')),
    ).toBe(true);
  });

  it('5. BackendModelCanaryRolloutService triggers automatic PostgreSQL rollback and cache invalidation when failure rate spikes', async () => {
    const adminKey = 'admin_secret_999';
    let currentRolloutState = 'CANARY_ACTIVE';
    let catalogCandidateStatus = 'LIMITED_RELEASE';

    const mockDb: PgPoolLike = {
      async query<TRow>(sql: string) {
        if (sql.includes('SELECT * FROM model_rollout_policies')) {
          return {
            rows: [
              {
                model_id: 'fastconformer-fa',
                stable_version: '1.1.0',
                candidate_version: '1.2.0',
                canary_percentage: 10,
                rollout_state: currentRolloutState,
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
          currentRolloutState = 'HALTED_ROLLBACK';
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SET release_status = 'DEPRECATED'")) {
          catalogCandidateStatus = 'DEPRECATED';
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    const cache = new SingleFlightReadThroughCache();
    await cache.getOrComputeSingleFlight(
      'rollout_policy:fastconformer-fa',
      60_000,
      async () => ({
        rollout_state: 'CANARY_ACTIVE',
      }),
    );

    const postRoutes = new Map<string, (req: any, reply: FastifyReplyLike) => Promise<unknown>>();
    const mockFastify: FastifyInstanceLike = {
      get() {},
      post(url, handler) {
        postRoutes.set(url, handler);
      },
    };

    const rolloutSvc = new BackendModelCanaryRolloutService(mockDb, cache, adminKey);
    rolloutSvc.registerRoutes(mockFastify);

    let statusCode = 200;
    let payload: any = null;
    const reply: FastifyReplyLike = {
      status(c) {
        statusCode = c;
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
        headers: { 'x-admin-api-key': adminKey },
      },
      reply,
    );

    expect(statusCode).toBe(200);
    expect(payload.action).toBe('AUTO_ROLLBACK_TRIGGERED');
    expect(payload.revertedToVersion).toBe('1.1.0');
    expect(currentRolloutState).toBe('HALTED_ROLLBACK');
    expect(catalogCandidateStatus).toBe('DEPRECATED');
    expect(cache.invalidateByPrefix('rollout_policy:fastconformer-fa')).toBe(0);
  });
});
