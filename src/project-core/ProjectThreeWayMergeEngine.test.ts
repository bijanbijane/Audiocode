import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectThreeWayMergeEngine } from './ProjectThreeWayMergeEngine';
import { ProjectDocument, TimelineTrack } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

function makeTrack(id: string, name: string, gainDb: number): TimelineTrack {
  return {
    id,
    name,
    syncGroupId: 'sync_main',
    speakerId: id,
    muted: false,
    solo: false,
    clips: [
      {
        id: `clip_${id}`,
        trackId: id,
        kind: 'AUDIO_ASSET',
        assetId: `asset_${id}`,
        sourceRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
        timelineRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
        fadeInFlicks: TimeMath.secondsToFlicks(0.01),
        fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
        gainDb,
      },
    ],
  };
}

function makeBaseDoc(): ProjectDocument {
  return {
    projectId: 'proj_team_1',
    name: 'اپیزود تیمی',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2.0',
      activeModelBundleVersion: '1.2.0',
    },
    revision: 5,
    tracks: [makeTrack('trk_host', 'میزبان', 0), makeTrack('trk_guest', 'مهمان', 0)],
    recommendations: [
      {
        id: 'rec_1',
        targetTrackId: 'trk_host',
        disfluencyType: 'INDEPENDENT_FILLER',
        associatedText: 'اممم',
        status: 'PENDING',
        createdAtProjectRevision: 5,
        spliceDescriptor: {
          rawAiRange: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
          snappedAcousticRange: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
          fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
          injectRoomToneFlicks: 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: [],
          confidence: 0.9,
        },
      },
    ],
  };
}

test('Section 59: ProjectThreeWayMergeEngine merges non-overlapping track and recommendation edits cleanly', () => {
  const base = makeBaseDoc();

  // Editor A edits Host track gain; Editor B edits Guest track gain & accepts rec_1
  const localBranch: ProjectDocument = {
    ...structuredClone(base),
    revision: 6,
    tracks: [makeTrack('trk_host', 'میزبان', -2.5), makeTrack('trk_guest', 'مهمان', 0)],
  };

  const incomingBranch: ProjectDocument = {
    ...structuredClone(base),
    revision: 6,
    tracks: [makeTrack('trk_host', 'میزبان', 0), makeTrack('trk_guest', 'مهمان', +1.5)],
    recommendations: [{ ...base.recommendations[0], status: 'ACCEPTED', userDecisionTimestamp: 1000 }],
  };

  const result = ProjectThreeWayMergeEngine.mergeProjectBranches(base, localBranch, incomingBranch);

  assert.equal(result.mergedCleanly, true);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.conflictRecoveryCopy, null);
  assert.equal(result.mergedDocument.revision, 7);
  assert.equal(result.mergedDocument.tracks[0].clips[0].gainDb, -2.5);
  assert.equal(result.mergedDocument.tracks[1].clips[0].gainDb, 1.5);
  assert.equal(result.mergedDocument.recommendations[0].status, 'ACCEPTED');
});

test('Section 59: ProjectThreeWayMergeEngine detects same-track concurrent edits and generates a Conflict Recovery Copy', () => {
  const base = makeBaseDoc();

  const localBranch: ProjectDocument = {
    ...structuredClone(base),
    revision: 7,
    tracks: [makeTrack('trk_host', 'میزبان', -3.0), makeTrack('trk_guest', 'مهمان', 0)],
  };

  const incomingBranch: ProjectDocument = {
    ...structuredClone(base),
    revision: 8,
    tracks: [makeTrack('trk_host', 'میزبان', +2.0), makeTrack('trk_guest', 'مهمان', 0)],
  };

  const result = ProjectThreeWayMergeEngine.mergeProjectBranches(base, localBranch, incomingBranch);

  assert.equal(result.mergedCleanly, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].trackId, 'trk_host');
  assert.equal(result.mergedDocument.tracks[0].clips[0].gainDb, -3.0);
  assert.ok(result.conflictRecoveryCopy !== null);
  assert.match(result.conflictRecoveryCopy!.name, /نسخه بازیابی تعارض/);
  assert.equal(result.conflictRecoveryCopy!.tracks[0].clips[0].gainDb, 2.0);
});
