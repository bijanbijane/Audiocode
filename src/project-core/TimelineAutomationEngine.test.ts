import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationLane, TimelineAutomationEngine } from './TimelineAutomationEngine';
import { TimeMath } from '../contracts/timebase.contract';

test('TimelineAutomationEngine evaluates STEP, LINEAR, and S_CURVE_COSINE accurately via binary search', () => {
  const lane: AutomationLane = {
    laneId: 'lane-1',
    targetNodeOrTrackId: 'track-voice',
    parameterName: 'GAIN_DB',
    defaultValue: 0,
    keyframes: [
      { timeFlicks: TimeMath.secondsToFlicks(1), value: 0, curveToNext: 'LINEAR' },
      { timeFlicks: TimeMath.secondsToFlicks(3), value: -10, curveToNext: 'S_CURVE_COSINE' },
      { timeFlicks: TimeMath.secondsToFlicks(5), value: 0, curveToNext: 'STEP' },
      { timeFlicks: TimeMath.secondsToFlicks(6), value: -20, curveToNext: 'LINEAR' },
    ],
  };

  assert.equal(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(0)), 0);
  assert.ok(Math.abs(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(2)) - -5) < 1e-6);
  // Cosine midpoint at t=4s is exact -5 dB, while t=3.5s is smoother than linear (-8.535 vs -7.5)
  assert.ok(Math.abs(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(4)) - -5) < 1e-6);
  assert.ok(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(3.5)) < -8.4);
  // STEP holds previous value until t=6
  assert.equal(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(5.9)), 0);
  assert.equal(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(7)), -20);
});

test('generatePodcastMusicDuckingLane merges short gaps to prevent pumping and applies gain cleanly in-place', () => {
  const lane = TimelineAutomationEngine.generatePodcastMusicDuckingLane({
    musicTrackId: 'bg-music',
    speechActiveRanges: [
      // Close gap (0.5s < 180ms + 600ms + 800ms) -> merged into one smooth dip
      { start: TimeMath.secondsToFlicks(2.0), end: TimeMath.secondsToFlicks(4.0) },
      { start: TimeMath.secondsToFlicks(4.5), end: TimeMath.secondsToFlicks(7.0) },
      // Far gap (4.0s later) -> music returns to 0 dB then ducks again
      { start: TimeMath.secondsToFlicks(11.0), end: TimeMath.secondsToFlicks(13.0) },
    ],
    normalMusicGainDb: 0,
    duckedMusicGainDb: -14,
  });

  // 2 merged speech islands * 4 keyframes = 8 keyframes
  assert.equal(lane.keyframes.length, 8);
  assert.ok(Math.abs(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(4.25)) - -14) < 1e-6);
  assert.ok(Math.abs(TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(9.5)) - 0) < 1e-6);

  // Apply to a 48kHz audio chunk sitting inside the ducked window [2.5s..3.5s]
  const musicChunk = [new Float32Array(4800).fill(1.0)];
  TimelineAutomationEngine.applyGainAutomationToChunkInPlace(
    lane,
    musicChunk,
    TimeMath.secondsToFlicks(2.5),
    48000,
  );
  const expectedLinear = Math.pow(10, -14 / 20);
  assert.ok(Math.abs(musicChunk[0][0] - expectedLinear) < 1e-5);
  assert.ok(Math.abs(musicChunk[0][4799] - expectedLinear) < 1e-5);
});
