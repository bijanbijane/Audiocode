import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineTransactionEngine } from './TimelineTransactionEngine';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

function makeBaseDoc(): ProjectDocument {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  return {
    projectId: 'proj-1',
    name: 'Test Podcast',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 1,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0.0',
      activeModelBundleVersion: 'fa-asr-bundle-1.2',
    },
    revision: 1,
    tracks: [
      {
        id: 't1',
        name: 'Host',
        syncGroupId: 'podcast-sync',
        speakerId: 'host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'a1',
            sourceRange: { start: 0, end: s(10) },
            timelineRange: { start: 0, end: s(10) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
      {
        id: 't2',
        name: 'Guest',
        syncGroupId: 'podcast-sync',
        speakerId: 'guest',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c2-speech',
            trackId: 't2',
            kind: 'AUDIO_ASSET',
            assetId: 'a2',
            sourceRange: { start: s(5), end: s(10) },
            timelineRange: { start: s(5), end: s(10) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [
      {
        id: 'rec-ripple',
        targetTrackId: 't1',
        disfluencyType: 'INDEPENDENT_FILLER',
        associatedText: 'اممم',
        spliceDescriptor: {
          rawAiRange: { start: s(2), end: s(3) },
          snappedAcousticRange: { start: s(2), end: s(3) },
          fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
          injectRoomToneFlicks: 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: [],
          confidence: 0.94,
        },
        status: 'PENDING',
        createdAtProjectRevision: 1,
      },
      {
        id: 'rec-overlap',
        targetTrackId: 't1',
        disfluencyType: 'LONG_PAUSE',
        associatedText: 'مکث هم‌پوشان',
        spliceDescriptor: {
          rawAiRange: { start: s(2.5), end: s(3.5) },
          snappedAcousticRange: { start: s(2.5), end: s(3.5) },
          fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
          injectRoomToneFlicks: 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: [],
          confidence: 0.88,
        },
        status: 'PENDING',
        createdAtProjectRevision: 1,
      },
      {
        id: 'rec-crosstalk',
        targetTrackId: 't1',
        disfluencyType: 'INDEPENDENT_FILLER',
        associatedText: 'آره',
        spliceDescriptor: {
          rawAiRange: { start: s(6), end: s(7) },
          snappedAcousticRange: { start: s(6), end: s(7) },
          fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
          injectRoomToneFlicks: 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: ['CROSSTALK_BLEED_ACTIVE'],
          confidence: 0.85,
        },
        status: 'PENDING',
        createdAtProjectRevision: 1,
      },
    ],
  };
}

test('TimelineTransactionEngine coalesces 60fps ephemeral gesture into one Undo/Redo transaction', () => {
  const engine = new TimelineTransactionEngine(makeBaseDoc());
  engine.beginEphemeralGesture('clip-gain-drag');

  engine.updateEphemeralGesture((draft) => {
    draft.tracks[0].clips[0] = { ...draft.tracks[0].clips[0], gainDb: -3 };
  });
  engine.updateEphemeralGesture((draft) => {
    draft.tracks[0].clips[0] = { ...draft.tracks[0].clips[0], gainDb: -6 };
  });

  // Committed revision must remain 1 until pointerUp commit
  assert.equal(engine.getCommittedState().revision, 1);
  assert.equal(engine.getActiveState().tracks[0].clips[0].gainDb, -6);

  const tx = engine.commitEphemeralGesture('تنظیم Gain کلیپ');
  assert.ok(tx);
  assert.equal(tx.coalescingKey, 'clip-gain-drag');
  assert.equal(engine.getCommittedState().revision, 2);
  assert.equal(engine.getCommittedState().tracks[0].clips[0].gainDb, -6);

  const undone = engine.undo();
  assert.ok(undone);
  assert.equal(undone.tracks[0].clips[0].gainDb, 0);
  assert.equal(undone.revision, 1);

  const redone = engine.redo();
  assert.ok(redone);
  assert.equal(redone.tracks[0].clips[0].gainDb, -6);
  assert.equal(redone.revision, 2);
});

test('TimelineTransactionEngine executes GLOBAL_SYNC_RIPPLE when sibling tracks are silent and invalidates overlapping recommendations', () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const engine = new TimelineTransactionEngine(makeBaseDoc());

  const tx = engine.applySmartSpliceRecommendation('rec-ripple', { start: 0, end: s(0.5) });
  assert.equal(tx.invalidatedRecommendationIds.includes('rec-overlap'), true);

  const state = engine.getCommittedState();
  // Host track [0..10) minus [2..3) => [0..2) + [2..9) => total end 9s
  const t1End = state.tracks[0].clips[state.tracks[0].clips.length - 1].timelineRange.end;
  // Guest track [5..10) shifted left by 1s => [4..9)
  const t2Start = state.tracks[1].clips[0].timelineRange.start;
  const t2End = state.tracks[1].clips[0].timelineRange.end;

  assert.equal(t1End, s(9));
  assert.equal(t2Start, s(4));
  assert.equal(t2End, s(9));

  assert.equal(state.recommendations.find((r) => r.id === 'rec-ripple')?.status, 'ACCEPTED');
  assert.equal(state.recommendations.find((r) => r.id === 'rec-overlap')?.status, 'INVALIDATED');

  // Undo restores both ACCEPTED and INVALIDATED back to PENDING
  const undone = engine.undo()!;
  assert.equal(undone.recommendations.find((r) => r.id === 'rec-ripple')?.status, 'PENDING');
  assert.equal(undone.recommendations.find((r) => r.id === 'rec-overlap')?.status, 'PENDING');
  assert.equal(undone.tracks[1].clips[0].timelineRange.start, s(5));
});

test('TimelineTransactionEngine falls back to IN_PLACE_ROOM_TONE when sibling track has active speech or crosstalk', () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const engine = new TimelineTransactionEngine(makeBaseDoc());

  engine.applySmartSpliceRecommendation('rec-crosstalk', { start: 0, end: s(1) });
  const state = engine.getCommittedState();

  // Host track must contain ROOM_TONE_FILL at [6..7) and preserve total timeline length = 10s
  const roomToneClip = state.tracks[0].clips.find((c) => c.kind === 'ROOM_TONE_FILL');
  assert.ok(roomToneClip);
  assert.equal(roomToneClip.timelineRange.start, s(6));
  assert.equal(roomToneClip.timelineRange.end, s(7));

  const t1End = state.tracks[0].clips[state.tracks[0].clips.length - 1].timelineRange.end;
  const t2End = state.tracks[1].clips[0].timelineRange.end;
  assert.equal(t1End, s(10));
  assert.equal(t2End, s(10));
});

test('TimelineTransactionEngine shifts subsequent PENDING recommendations after GLOBAL_SYNC_RIPPLE and restores exact ranges on Undo/Redo', () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const engine = new TimelineTransactionEngine(makeBaseDoc());

  // rec-crosstalk starts at [6s..7s) — strictly after rec-ripple [2s..3s) (1s ripple cut)
  engine.applySmartSpliceRecommendation('rec-ripple', { start: 0, end: s(0.5) });
  const afterApply = engine.getCommittedState();
  const shiftedLaterRec = afterApply.recommendations.find((r) => r.id === 'rec-crosstalk')!;
  assert.equal(shiftedLaterRec.status, 'PENDING');
  assert.equal(shiftedLaterRec.spliceDescriptor.snappedAcousticRange.start, s(5));
  assert.equal(shiftedLaterRec.spliceDescriptor.snappedAcousticRange.end, s(6));

  // Undo restores rec-crosstalk back to [6s..7s)
  const afterUndo = engine.undo()!;
  const restoredRec = afterUndo.recommendations.find((r) => r.id === 'rec-crosstalk')!;
  assert.equal(restoredRec.spliceDescriptor.snappedAcousticRange.start, s(6));
  assert.equal(restoredRec.spliceDescriptor.snappedAcousticRange.end, s(7));

  // Redo shifts rec-crosstalk back to [5s..6s)
  const afterRedo = engine.redo()!;
  const reShiftedRec = afterRedo.recommendations.find((r) => r.id === 'rec-crosstalk')!;
  assert.equal(reShiftedRec.spliceDescriptor.snappedAcousticRange.start, s(5));
  assert.equal(reShiftedRec.spliceDescriptor.snappedAcousticRange.end, s(6));
});

