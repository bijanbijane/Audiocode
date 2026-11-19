import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateFullResamplingMemory,
  IntegratedPersianAsrService,
} from './IntegratedPersianAsrService';
import { MemoryBudgetManager, MemoryPressureError } from '../../runtime/memory/MemoryBudgetManager';

function makeTightBudgetManager(hardLimitBytes: number): MemoryBudgetManager {
  return new MemoryBudgetManager({
    hardLimitBytes,
    targetBytes: Math.max(1, Math.floor(hardLimitBytes * 0.8)),
    throttleBytes: Math.max(1, Math.floor(hardLimitBytes * 0.88)),
    emergencyBytes: Math.max(1, Math.floor(hardLimitBytes * 0.94)),
    audioCacheBytes: 32 * 1024 * 1024,
  });
}

describe('Section 123: IntegratedPersianAsrService End-to-End Orchestration', () => {
  it('resamples 48kHz audio, restores compounds/numerals/formal layer, and snaps disfluency splices', async () => {
    const budgetMgr = new MemoryBudgetManager();
    const svc = new IntegratedPersianAsrService(
      {
        modelId: 'mock-asr',
        modelVersion: '1.0.0',
        async detectVoiceActivity() {
          // Resampling + source reservations must be active while ASR runs
          assert.ok(budgetMgr.getSnapshot().accountedBytes > 0);
          return { hasSpeech: true, speechRatio: 0.9 };
        },
        async transcribeWindow() {
          return [
            { word: 'اونا', relativeStartSec: 0.1, relativeEndSec: 0.4, probability: 0.95 },
            { word: 'کتاب', relativeStartSec: 0.45, relativeEndSec: 0.75, probability: 0.96 },
            { word: 'ها', relativeStartSec: 0.78, relativeEndSec: 0.95, probability: 0.96 },
            { word: 'اممم', relativeStartSec: 1.1, relativeEndSec: 1.5, probability: 0.92 },
            { word: 'می‌خونن', relativeStartSec: 1.6, relativeEndSec: 2.0, probability: 0.94 },
          ];
        },
      },
      undefined,
      budgetMgr,
    );

    const pcm48k = new Float32Array(48000 * 3);
    const res = await svc.transcribeAndAnalyzeAudio([pcm48k], {
      sourceSampleRate: 48000,
      enableCompoundAndBilingualRestoration: true,
      enableSpokenNumeralFormatting: true,
      enableProsodicPunctuation: false,
      convertDisplayToFormalPersian: false,
      detectSpeechDisfluenciesAndSnapBoundaries: true,
    });

    assert.equal(res.tokens.length, 4); // «کتاب» + «ها» merged into «کتاب‌ها»
    assert.equal(res.tokens[0].formalStandardEquivalent, 'آن\u200cها');
    assert.equal(res.tokens[1].displayText, 'کتاب\u200cها');
    assert.ok(res.detectedIssuesWithSnappedSplices.length >= 1);

    // All reservations released cleanly after completion
    assert.equal(budgetMgr.getSnapshot().accountedBytes, 0);
    assert.equal(budgetMgr.getSnapshot().reservationCount, 0);
  });

  it('rejects resampling cleanly on insufficient memory budget before running ASR and leaks zero reservations', async () => {
    const pcm48k = new Float32Array(48000 * 3); // 576,000 B source
    const estimate = estimateFullResamplingMemory([pcm48k], 48000);
    assert.equal(estimate.sourceBackingBytes, 576_000);
    assert.equal(estimate.monoIntermediateBytes, 576_000);
    assert.equal(estimate.mono16kOutputBytes, 192_000);

    // Cap below required working set (source + mono intermediate + 16k mono output)
    const tightBudget = makeTightBudgetManager(estimate.sourceBackingBytes + 100_000);
    let vadCalled = false;
    let asrCalled = false;

    const svc = new IntegratedPersianAsrService(
      {
        modelId: 'mock-asr',
        modelVersion: '1.0.0',
        async detectVoiceActivity() {
          vadCalled = true;
          return { hasSpeech: true, speechRatio: 0.9 };
        },
        async transcribeWindow() {
          asrCalled = true;
          return [];
        },
      },
      undefined,
      tightBudget,
    );

    await assert.rejects(
      svc.transcribeAndAnalyzeAudio([pcm48k], {
        sourceSampleRate: 48000,
        enableCompoundAndBilingualRestoration: true,
        enableSpokenNumeralFormatting: true,
        enableProsodicPunctuation: false,
        convertDisplayToFormalPersian: false,
        detectSpeechDisfluenciesAndSnapBoundaries: true,
      }),
      MemoryPressureError,
    );

    assert.equal(vadCalled, false);
    assert.equal(asrCalled, false);
    assert.equal(tightBudget.getSnapshot().accountedBytes, 0);
    assert.equal(tightBudget.getSnapshot().reservationCount, 0);
  });

  it('accounts conservatively for large subarray backing buffers and releases reservations on downstream ASR failure', async () => {
    const bigBacking = new Float32Array(48000 * 20); // 3,840,000 B backing
    const shortView = bigBacking.subarray(0, 48000); // 1s view, but retains 3.84 MB
    const est = estimateFullResamplingMemory([shortView], 48000);
    assert.equal(est.sourceBackingBytes, bigBacking.byteLength);

    const budgetMgr = new MemoryBudgetManager();
    const svc = new IntegratedPersianAsrService(
      {
        modelId: 'failing-asr',
        modelVersion: '1.0.0',
        async detectVoiceActivity() {
          return { hasSpeech: true, speechRatio: 0.8 };
        },
        async transcribeWindow() {
          throw new Error('Downstream inference boom');
        },
      },
      undefined,
      budgetMgr,
    );

    await assert.rejects(
      svc.transcribeAndAnalyzeAudio([shortView], {
        sourceSampleRate: 48000,
        enableCompoundAndBilingualRestoration: false,
        enableSpokenNumeralFormatting: false,
        enableProsodicPunctuation: false,
        convertDisplayToFormalPersian: false,
        detectSpeechDisfluenciesAndSnapBoundaries: false,
      }),
      /Downstream inference boom/,
    );

    assert.equal(budgetMgr.getSnapshot().accountedBytes, 0);
    assert.equal(budgetMgr.getSnapshot().reservationCount, 0);
  });
});
