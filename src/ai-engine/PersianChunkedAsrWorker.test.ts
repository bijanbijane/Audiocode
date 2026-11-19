import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AsrJobCancelledError,
  AsrModelRunnerAdapter,
  PersianChunkedAsrEngine,
} from './PersianChunkedAsrWorker';
import { TimeMath } from '../contracts/timebase.contract';
import { MemoryBudgetManager, MemoryPressureError } from '../runtime/memory/MemoryBudgetManager';
import { TimedPersianToken } from './PersianTextNormalizer';

function makeTightBudgetManager(hardLimitBytes: number): MemoryBudgetManager {
  return new MemoryBudgetManager({
    hardLimitBytes,
    targetBytes: Math.max(1, Math.floor(hardLimitBytes * 0.8)),
    throttleBytes: Math.max(1, Math.floor(hardLimitBytes * 0.88)),
    emergencyBytes: Math.max(1, Math.floor(hardLimitBytes * 0.94)),
    audioCacheBytes: 32 * 1024 * 1024,
  });
}

test('Windowed Persian ASR reconciles boundary words across 25s/3s overlap without duplication and skips pure silence', async () => {
  const transcribedWindowStarts: number[] = [];

  const mockAdapter: AsrModelRunnerAdapter = {
    modelId: 'whisper-fa-int8',
    modelVersion: '2.4.1',
    async detectVoiceActivity(pcm) {
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 64) energy += Math.abs(pcm[i]);
      const hasSpeech = energy > 0.01;
      return { hasSpeech, speechRatio: hasSpeech ? 0.45 : 0 };
    },
    async transcribeWindow(pcm) {
      const wIdx = Math.round(pcm[0]);
      if (wIdx === 0) {
        transcribedWindowStarts.push(0);
        return [
          { word: 'سلام', relativeStartSec: 1.0, relativeEndSec: 1.4, probability: 0.96 },
          { word: 'ما', relativeStartSec: 22.4, relativeEndSec: 22.8, probability: 0.95 },
          { word: 'فناوری', relativeStartSec: 23.3, relativeEndSec: 23.7, probability: 0.81 },
        ];
      }
      if (wIdx === 1) {
        transcribedWindowStarts.push(1);
        return [
          { word: 'فناوری', relativeStartSec: 1.32, relativeEndSec: 1.72, probability: 0.94 },
          { word: 'فارسی', relativeStartSec: 2.1, relativeEndSec: 2.5, probability: 0.97 },
        ];
      }
      transcribedWindowStarts.push(wIdx);
      return [{ word: 'پایان', relativeStartSec: 3.0, relativeEndSec: 3.4, probability: 0.95 }];
    },
  };

  const budgetMgr = new MemoryBudgetManager();
  const engine = new PersianChunkedAsrEngine(mockAdapter, budgetMgr);
  const checkpoints: number[] = [];

  const totalSamples = 70 * 16000;
  const tokens = await engine.transcribeLongAudioStream(
    totalSamples,
    async (startSample, count) => {
      // Reservation must already be active before readSamples16kFn allocates PCM window
      assert.equal(budgetMgr.getSnapshot().reservationCount, 1);
      assert.equal(budgetMgr.getSnapshot().accountedBytes, count * 4);
      const buf = new Float32Array(count);
      const windowIndex = Math.round(startSample / (22 * 16000));
      if (windowIndex !== 2) {
        buf[0] = windowIndex;
        buf[64] = 0.5;
      }
      return buf;
    },
    async (wIdx) => {
      checkpoints.push(wIdx);
    },
  );

  // All per-window reservations released cleanly
  assert.equal(budgetMgr.getSnapshot().accountedBytes, 0);
  assert.equal(budgetMgr.getSnapshot().reservationCount, 0);

  assert.deepEqual(checkpoints, [0, 1, 2, 3]);
  assert.deepEqual(transcribedWindowStarts, [0, 1, 3]);

  const techTokens = tokens.filter((t) => t.normalizedText === 'فناوری');
  assert.equal(techTokens.length, 1);
  assert.equal(techTokens[0].confidence, 0.94);

  assert.deepEqual(
    tokens.map((t) => t.normalizedText),
    ['سلام', 'ما', 'فناوری', 'فارسی', 'پایان'],
  );
  assert.ok(tokens[4].range.start > TimeMath.secondsToFlicks(68));
});

test('PersianChunkedAsrEngine reserves PCM + adapter working memory BEFORE reading and rejects cleanly on pressure without silently skipping speech', async () => {
  const window25sBytes = 25 * 16000 * 4; // 1,600,000 B
  const adapterExtra = 500_000;
  const budgetMgr = makeTightBudgetManager(window25sBytes + adapterExtra - 1);

  let readCalls = 0;
  const adapter: AsrModelRunnerAdapter = {
    modelId: 'test-onnx',
    modelVersion: '1.0',
    estimateWorkingMemoryBytes: () => adapterExtra,
    async detectVoiceActivity() {
      return { hasSpeech: true, speechRatio: 0.8 };
    },
    async transcribeWindow() {
      return [{ word: 'سلام', relativeStartSec: 0.1, relativeEndSec: 0.4, probability: 0.9 }];
    },
  };

  const engine = new PersianChunkedAsrEngine(adapter, budgetMgr);

  await assert.rejects(
    engine.transcribeLongAudioStream(
      25 * 16000,
      async (_start, count) => {
        readCalls++;
        return new Float32Array(count);
      },
      async () => {},
    ),
    MemoryPressureError,
  );

  // Window read was NEVER invoked because admission rejected beforehand; partial PCM reservation released
  assert.equal(readCalls, 0);
  assert.equal(budgetMgr.getSnapshot().accountedBytes, 0);
  assert.equal(budgetMgr.getSnapshot().reservationCount, 0);
});

test('PersianChunkedAsrEngine releases reservations on VAD, inference, and checkpoint failures', async () => {
  const scenarios: ('vad' | 'inference' | 'checkpoint')[] = ['vad', 'inference', 'checkpoint'];

  for (const failAt of scenarios) {
    const budgetMgr = new MemoryBudgetManager();
    const adapter: AsrModelRunnerAdapter = {
      modelId: 'fail-test',
      modelVersion: '1.0',
      estimateWorkingMemoryBytes: (n) => n * 2,
      async detectVoiceActivity() {
        assert.ok(budgetMgr.getSnapshot().accountedBytes > 0);
        if (failAt === 'vad') throw new Error('VAD failure');
        return { hasSpeech: true, speechRatio: 0.7 };
      },
      async transcribeWindow() {
        assert.ok(budgetMgr.getSnapshot().accountedBytes > 0);
        if (failAt === 'inference') throw new Error('Inference failure');
        return [{ word: 'تست', relativeStartSec: 0.2, relativeEndSec: 0.5, probability: 0.9 }];
      },
    };

    const engine = new PersianChunkedAsrEngine(adapter, budgetMgr);

    await assert.rejects(
      engine.transcribeLongAudioStream(
        16000,
        async (_s, c) => new Float32Array(c),
        async () => {
          if (failAt === 'checkpoint') throw new Error('Checkpoint failure');
        },
      ),
      new RegExp(`${failAt} failure`, 'i'),
    );

    assert.equal(budgetMgr.getSnapshot().accountedBytes, 0, `Leak detected on ${failAt} failure`);
    assert.equal(budgetMgr.getSnapshot().reservationCount, 0);
  }
});

test('PersianChunkedAsrEngine supports AbortSignal cancellation, preserves checkpoint, releases reservation, and avoids duplicate tokens on resume', async () => {
  const budgetMgr = new MemoryBudgetManager();
  const controller = new AbortController();
  let windowsRead = 0;

  const adapter: AsrModelRunnerAdapter = {
    modelId: 'resume-test',
    modelVersion: '1.0',
    estimateWorkingMemoryBytes: () => 64_000,
    async detectVoiceActivity() {
      return { hasSpeech: true, speechRatio: 0.9 };
    },
    async transcribeWindow(pcm) {
      const wIdx = Math.round(pcm[0]);
      if (wIdx === 0) {
        return [
          { word: 'سلام', relativeStartSec: 1.0, relativeEndSec: 1.4, probability: 0.96 },
          { word: 'دنیا', relativeStartSec: 23.3, relativeEndSec: 23.7, probability: 0.85 },
        ];
      }
      // Window 1 overlaps 'دنیا' near 23.5s
      return [
        { word: 'دنیا', relativeStartSec: 1.32, relativeEndSec: 1.72, probability: 0.95 },
        { word: 'قشنگ', relativeStartSec: 3.0, relativeEndSec: 3.5, probability: 0.98 },
      ];
    },
  };

  const engine = new PersianChunkedAsrEngine(adapter, budgetMgr);
  const savedCheckpoints: { windowIndex: number; tokens: TimedPersianToken[] }[] = [];

  await assert.rejects(
    engine.transcribeLongAudioStream(
      40 * 16000, // 2 windows: 0 [0..25), 1 [22..40)
      async (start, count) => {
        windowsRead++;
        const buf = new Float32Array(count);
        const wIdx = Math.round(start / (22 * 16000));
        buf[0] = wIdx;
        if (wIdx === 1) {
          controller.abort('User paused transcription');
        }
        return buf;
      },
      async (windowIndex, mergedTokensSoFar) => {
        savedCheckpoints.push({ windowIndex, tokens: mergedTokensSoFar });
      },
      0,
      [],
      'track-1',
      { signal: controller.signal, memoryBudgetManager: budgetMgr },
    ),
    AsrJobCancelledError,
  );

  assert.equal(budgetMgr.getSnapshot().accountedBytes, 0);
  assert.equal(budgetMgr.getSnapshot().reservationCount, 0);
  assert.equal(savedCheckpoints.length, 1);
  assert.equal(savedCheckpoints[0].windowIndex, 0);
  assert.equal(windowsRead, 2);

  // Resume from last completed checkpoint (windowIndex + 1 = 1)
  const lastCkpt = savedCheckpoints[savedCheckpoints.length - 1];
  const resumedTokens = await engine.transcribeLongAudioStream(
    40 * 16000,
    async (start, count) => {
      const buf = new Float32Array(count);
      buf[0] = Math.round(start / (22 * 16000));
      return buf;
    },
    async (windowIndex, mergedTokensSoFar) => {
      savedCheckpoints.push({ windowIndex, tokens: mergedTokensSoFar });
    },
    lastCkpt.windowIndex + 1,
    lastCkpt.tokens,
    'track-1',
    { memoryBudgetManager: budgetMgr },
  );

  assert.equal(budgetMgr.getSnapshot().accountedBytes, 0);
  assert.deepEqual(
    resumedTokens.map((t) => t.normalizedText),
    ['سلام', 'دنیا', 'قشنگ'],
  );
});
