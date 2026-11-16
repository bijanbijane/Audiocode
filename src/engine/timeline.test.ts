import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySyncSafeCut,
  computeTimelineDurationFlicks,
  determineSyncSafeEditMode,
  TimelineHistoryManager,
} from './timeline';
import { PersianWordToken, Track } from '../contracts/v1_2';
import { secondsToFlicks } from './timebase';

function makeSyncedTracks(): Track[] {
  return [
    {
      id: 't1',
      name: 'میزبان',
      speakerLabel: 'سارا',
      syncGroupId: 'podcast-sync',
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 't1',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(10) },
          sourceStartFlicks: 0,
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        },
      ],
    },
    {
      id: 't2',
      name: 'مهمان',
      speakerLabel: 'آرش',
      syncGroupId: 'podcast-sync',
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c2',
          assetId: 'a2',
          trackId: 't2',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(10) },
          sourceStartFlicks: 0,
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        },
      ],
    },
  ];
}

test('Multi-track sync protection chooses In-Place Room Tone when peer track is speaking', () => {
  const tracks = makeSyncedTracks();
  const tokens: PersianWordToken[] = [
    {
      id: 'tok-peer',
      trackId: 't2',
      speakerName: 'آرش',
      originalText: 'دقیقاً',
      normalizedText: 'دقیقاً',
      displayText: 'دقیقاً',
      range: { startFlicks: secondsToFlicks(3.0), endFlicks: secondsToFlicks(3.8) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
  ];

  const decision = determineSyncSafeEditMode(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(3.1), endFlicks: secondsToFlicks(3.6) },
    tokens,
  );
  assert.equal(decision.mode, 'in-place-room-tone-suppression');

  const edited = applySyncSafeCut(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(3.1), endFlicks: secondsToFlicks(3.6) },
    decision.mode,
  );

  // Total timeline duration must stay exact 10s so Track 2 remains in sync!
  assert.equal(computeTimelineDurationFlicks(edited), secondsToFlicks(10));
  const roomToneClip = edited[0].clips.find((c) => c.kind === 'room-tone-fill');
  assert.ok(roomToneClip !== undefined);
});

test('Sync-Locked Ripple Cut shortens both synced tracks equally when all peers are silent', () => {
  const tracks = makeSyncedTracks();
  const decision = determineSyncSafeEditMode(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(5.0), endFlicks: secondsToFlicks(6.5) },
    [],
  );
  assert.equal(decision.mode, 'sync-locked-ripple-cut');

  const edited = applySyncSafeCut(
    tracks,
    't1',
    { startFlicks: secondsToFlicks(5.0), endFlicks: secondsToFlicks(6.5) },
    decision.mode,
  );

  // Both Track 1 and Track 2 shorten from 10s to 8.5s in lockstep
  assert.equal(computeTimelineDurationFlicks([edited[0]]), secondsToFlicks(8.5));
  assert.equal(computeTimelineDurationFlicks([edited[1]]), secondsToFlicks(8.5));
});

test('TimelineHistoryManager supports Undo/Redo and coalescing key merging', () => {
  const mgr = new TimelineHistoryManager();
  const base = makeSyncedTracks();
  const next = applySyncSafeCut(
    base,
    't1',
    { startFlicks: secondsToFlicks(1), endFlicks: secondsToFlicks(2) },
    'sync-locked-ripple-cut',
  );

  mgr.commitTransaction({
    coalescingKey: 'slider-gain',
    type: 'dsp-parameter-change',
    description: 'تغییر گین مستر',
    beforeTracks: base,
    afterTracks: base,
  });
  mgr.commitTransaction({
    coalescingKey: 'slider-gain',
    type: 'dsp-parameter-change',
    description: 'تغییر گین مستر نهایی',
    beforeTracks: base,
    afterTracks: next,
  });

  // Coalesced into 1 transaction
  assert.equal(mgr.getHistory().length, 1);
  assert.equal(mgr.canUndo(), true);
  const undone = mgr.undo();
  assert.ok(undone !== null);
  assert.equal(mgr.canRedo(), true);
});
