import test from 'node:test';
import assert from 'node:assert/strict';
import { AsrModelRunnerAdapter, PersianChunkedAsrEngine } from './PersianChunkedAsrWorker';
import { TimeMath } from '../contracts/timebase.contract';

test('Windowed Persian ASR reconciles boundary words across 25s/3s overlap without duplication and skips pure silence', async () => {
  const transcribedWindowStarts: number[] = [];

  const mockAdapter: AsrModelRunnerAdapter = {
    modelId: 'whisper-fa-int8',
    modelVersion: '2.4.1',
    async detectVoiceActivity(pcm) {
      // Simulate silent window #1 (22s..47s)
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 64) energy += Math.abs(pcm[i]);
      const hasSpeech = energy > 0.01;
      return { hasSpeech, speechRatio: hasSpeech ? 0.45 : 0 };
    },
    async transcribeWindow(pcm) {
      // Marker encoded in sample[0] = windowIndex
      const wIdx = Math.round(pcm[0]);
      if (wIdx === 0) {
        transcribedWindowStarts.push(0);
        return [
          { word: 'سلام', relativeStartSec: 1.0, relativeEndSec: 1.4, probability: 0.96 },
          // Overlapping boundary region [22s..25s), midpoint at 23.5s
          { word: 'ما', relativeStartSec: 22.4, relativeEndSec: 22.8, probability: 0.95 },
          // Sits right on 23.5s midpoint with lower confidence in window 0
          { word: 'فناوری', relativeStartSec: 23.3, relativeEndSec: 23.7, probability: 0.81 },
        ];
      }
      if (wIdx === 1) {
        transcribedWindowStarts.push(1);
        return [
          // Duplicate prediction of 'فناوری' near 23.5s midpoint with higher confidence
          { word: 'فناوری', relativeStartSec: 1.32, relativeEndSec: 1.72, probability: 0.94 },
          { word: 'فارسی', relativeStartSec: 2.1, relativeEndSec: 2.5, probability: 0.97 },
        ];
      }
      transcribedWindowStarts.push(wIdx);
      return [{ word: 'پایان', relativeStartSec: 3.0, relativeEndSec: 3.4, probability: 0.95 }];
    },
  };

  const engine = new PersianChunkedAsrEngine(mockAdapter);
  const checkpoints: number[] = [];

  // Total 70 seconds @ 16kHz -> Window 0 [0..25), Window 1 [22..47), Window 2 [44..69), Window 3 [66..70)
  const totalSamples = 70 * 16000;
  const tokens = await engine.transcribeLongAudioStream(
    totalSamples,
    async (startSample, count) => {
      const buf = new Float32Array(count);
      const windowIndex = Math.round(startSample / (22 * 16000));
      if (windowIndex !== 2) {
        // Window 2 left all-zeros to exercise VAD skip
        buf[0] = windowIndex;
        buf[64] = 0.5;
      }
      return buf;
    },
    async (wIdx) => {
      checkpoints.push(wIdx);
    },
  );

  // Window 2 (silence) triggered checkpoint without invoking transcribeWindow
  assert.deepEqual(checkpoints, [0, 1, 2, 3]);
  assert.deepEqual(transcribedWindowStarts, [0, 1, 3]);

  // 'فناوری' must appear ONLY ONCE with the higher confidence (0.94)
  const techTokens = tokens.filter((t) => t.normalizedText === 'فناوری');
  assert.equal(techTokens.length, 1);
  assert.equal(techTokens[0].confidence, 0.94);

  assert.deepEqual(
    tokens.map((t) => t.normalizedText),
    ['سلام', 'ما', 'فناوری', 'فارسی', 'پایان'],
  );
  assert.ok(tokens[4].range.start > TimeMath.secondsToFlicks(68));
});
