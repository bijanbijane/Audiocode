import { describe, it, expect } from 'vitest';
import { WhisperBeamSearchAndTempFallbackEngine } from '../../src/ai-engine/asr/WhisperBeamSearchAndTempFallbackEngine';
import { PreAsrMusicAndJingleBoundaryFilter } from '../../src/ai-engine/asr/PreAsrMusicAndJingleBoundaryFilter';
import { AdvisoryLockCoordinator } from '../src/ops/BackendJobOutboxAndAdvisoryLockService';
import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from '../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';
import { PgPoolLike } from '../src/PlatformBackendServices';

describe('Section 133: Whisper Beam Search Temp Fallback, Music Filter & Advisory Lock Suite', () => {
  it('1. LZ77 Compression Ratio cleanly separates looping Persian hallucinations from natural speech', () => {
    const naturalText = 'امروز درباره طراحی معماری پایدار سیستم‌های صوتی صحبت می‌کنیم';
    const hallucinatedLoop = 'بله بله بله بله بله بله بله بله بله بله بله بله بله بله';

    const naturalRatio =
      WhisperBeamSearchAndTempFallbackEngine.computeUtf8TextCompressionRatio(naturalText);
    const loopRatio =
      WhisperBeamSearchAndTempFallbackEngine.computeUtf8TextCompressionRatio(
        hallucinatedLoop,
      );

    expect(naturalRatio).toBeLessThan(1.8);
    expect(loopRatio).toBeGreaterThan(2.4);
  });

  it('2. WhisperBeamSearchAndTempFallbackEngine detects T=0 loop hallucination and recovers cleanly via Temperature Fallback', async () => {
    const vocab: Record<number, string> = {
      10: 'بله ',
      11: 'سلام ',
      12: 'دنیا',
    };
    const eotId = 50257;
    let stepCallsInRun = 0;
    let runCount = 0;

    const mockOrt: OrtRuntimeProvider = {
      createTensor: (type, data, dims) => ({ type, data, dims }) as OrtTensorLike,
      createSession: async (): Promise<OrtSessionLike> => ({
        run: async (feeds) => {
          const inputArr = feeds['input_ids'].data as BigInt64Array;
          if (inputArr.length > 1) {
            runCount++;
            stepCallsInRun = 0;
          }
          stepCallsInRun++;

          const logits = new Float32Array(50370).fill(-20);
          if (runCount === 1) {
            if (stepCallsInRun <= 14) logits[10] = 8.0;
            else logits[eotId] = 8.0;
          } else {
            if (stepCallsInRun === 1) logits[11] = 8.0;
            else if (stepCallsInRun === 2) logits[12] = 8.0;
            else logits[eotId] = 8.0;
          }

          return {
            logits: { type: 'float32', dims: [1, 1, logits.length], data: logits },
          };
        },
      }),
    };

    const decoderSession = await mockOrt.createSession('mock', ['cpu']);
    const engine = new WhisperBeamSearchAndTempFallbackEngine(
      mockOrt,
      {
        sotTokenId: 50258,
        persianLangTokenId: 50300,
        transcribeTaskTokenId: 50359,
        eotTokenId: eotId,
        timestampBeginId: 50364,
      },
      (ids) => ids.map((id) => vocab[id] ?? '').join(''),
    );

    const outcome = await engine.decodeWithTemperatureFallback({
      decoderWithPastSession: decoderSession,
      encoderHiddenStates: mockOrt.createTensor(
        'float32',
        new Float32Array(8),
        [1, 1, 8],
      ),
      initialPromptTokenIds: [50258, 50300, 50359],
      options: {
        numDecoderLayers: 0,
        numAttentionHeads: 1,
        headDim: 8,
        beamSize: 1,
        temperatures: [0.0, 0.2],
        compressionRatioThreshold: 2.4,
      },
    });

    expect(outcome.temperatureUsed).toBe(0.2);
    expect(outcome.compressionRatio).toBeLessThan(2.4);
    expect(outcome.tokenIds).toEqual([11, 12]);
  });

  it('3. PreAsrMusicAndJingleBoundaryFilter distinguishes sustained intro music from syllable-modulated speech', () => {
    const sr = 16000;
    const totalSamples = sr * 4;
    const pcm = new Float32Array(totalSamples);

    for (let i = 0; i < sr * 2; i++) {
      const t = i / sr;
      pcm[i] =
        0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 330 * t);
    }

    for (let i = sr * 2; i < totalSamples; i++) {
      const t = i / sr;
      const syllableCycle = (t * 4) % 1.0;
      if (syllableCycle < 0.25) {
        pcm[i] = 0.002 * Math.sin(2 * Math.PI * 100 * t);
      } else if (syllableCycle < 0.45) {
        pcm[i] = 0.18 * Math.sin(2 * Math.PI * 4200 * t);
      } else {
        pcm[i] = 0.3 * Math.sin(2 * Math.PI * 160 * t);
      }
    }

    const regions = PreAsrMusicAndJingleBoundaryFilter.classifyAudioRegionsBeforeAsr(
      pcm,
      1.0,
    );
    expect(regions[0].classification).toBe('PURE_MUSIC_OR_JINGLE');
    expect(regions[regions.length - 1].classification).toBe('SPEECH_CANDIDATE');
  });

  it('4. AdvisoryLockCoordinator skips execution cleanly when another backend replica holds the lock', async () => {
    let taskExecuted = false;
    let clientReleased = false;
    let directPoolQueryCount = 0;

    const mockDb: PgPoolLike = {
      async query() {
        directPoolQueryCount++;
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          async query<TRow>(sql: string) {
            if (sql.includes('pg_try_advisory_lock')) {
              return { rows: [{ acquired: false }] as unknown as TRow[], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    };

    const coordinator = new AdvisoryLockCoordinator(mockDb);
    const res = await coordinator.runWithAdvisoryLock(778899, async () => {
      taskExecuted = true;
    });

    expect(res.lockAcquired).toBe(false);
    expect(taskExecuted).toBe(false);
    expect(clientReleased).toBe(true);
    expect(directPoolQueryCount).toBe(0);
  });
});
