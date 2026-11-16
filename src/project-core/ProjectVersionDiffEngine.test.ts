import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectVersionDiffEngine } from './ProjectVersionDiffEngine';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

describe('ProjectVersionDiffEngine (Sections 2.5, 15 & 21)', () => {
  const createRevision1 = (): ProjectDocument => ({
    projectId: 'proj_diff_1',
    name: 'پادکست فناوری',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2.0',
      activeModelBundleVersion: '1.2.0',
    },
    revision: 1,
    tracks: [
      {
        id: 'trk_host',
        name: 'میزبان',
        syncGroupId: null,
        speakerId: 'S1',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'clip_full',
            trackId: 'trk_host',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_main',
            sourceRange: {
              start: 0,
              end: TimeMath.secondsToFlicks(30),
            },
            timelineRange: {
              start: 0,
              end: TimeMath.secondsToFlicks(30),
            },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
  });

  const createRevision3WithTwoCuts = (): ProjectDocument => ({
    ...createRevision1(),
    revision: 3,
    tracks: [
      {
        id: 'trk_host',
        name: 'میزبان',
        syncGroupId: null,
        speakerId: 'S1',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'clip_part_1',
            trackId: 'trk_host',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_main',
            sourceRange: {
              start: 0,
              end: TimeMath.secondsToFlicks(10),
            },
            timelineRange: {
              start: 0,
              end: TimeMath.secondsToFlicks(10),
            },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
          // Cut 1: [10s .. 12s] removed (2 seconds)
          {
            id: 'clip_part_2',
            trackId: 'trk_host',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_main',
            sourceRange: {
              start: TimeMath.secondsToFlicks(12),
              end: TimeMath.secondsToFlicks(20),
            },
            timelineRange: {
              start: TimeMath.secondsToFlicks(10),
              end: TimeMath.secondsToFlicks(18),
            },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
          // Cut 2: [20s .. 25s] removed (5 seconds)
          {
            id: 'clip_part_3',
            trackId: 'trk_host',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_main',
            sourceRange: {
              start: TimeMath.secondsToFlicks(25),
              end: TimeMath.secondsToFlicks(30),
            },
            timelineRange: {
              start: TimeMath.secondsToFlicks(18),
              end: TimeMath.secondsToFlicks(23),
            },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [
      {
        id: 'rec_cut_1',
        targetTrackId: 'trk_host',
        disfluencyType: 'INDEPENDENT_FILLER',
        associatedText: 'اممم',
        status: 'ACCEPTED',
        createdAtProjectRevision: 2,
        spliceDescriptor: {
          rawAiRange: {
            start: TimeMath.secondsToFlicks(10),
            end: TimeMath.secondsToFlicks(12),
          },
          snappedAcousticRange: {
            start: TimeMath.secondsToFlicks(10),
            end: TimeMath.secondsToFlicks(12),
          },
          fadeInDurationFlicks: 0,
          fadeOutDurationFlicks: 0,
          injectRoomToneFlicks: 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: [],
          confidence: 0.94,
        },
      },
    ],
  });

  it('identifies exact deleted source spans and links accepted recommendations', () => {
    const rev1 = createRevision1();
    const rev3 = createRevision3WithTwoCuts();

    const report = ProjectVersionDiffEngine.compareProjectVersions(rev1, rev3);
    assert.equal(report.olderRevision, 1);
    assert.equal(report.newerRevision, 3);
    assert.equal(report.netTimeSavedSeconds, 7);
    assert.equal(report.deletedSourceSpans.length, 2);
    assert.equal(report.deletedSourceSpans[0].durationRemovedSeconds, 2);
    assert.equal(report.deletedSourceSpans[0].associatedRecommendationId, 'rec_cut_1');
    assert.equal(report.deletedSourceSpans[1].durationRemovedSeconds, 5);
  });

  it('cherry-picks and restores an earlier deleted cut without losing subsequent cuts', () => {
    const rev1 = createRevision1();
    const rev3 = createRevision3WithTwoCuts();
    const report = ProjectVersionDiffEngine.compareProjectVersions(rev1, rev3);

    // Restore Cut 1 (2s) while keeping Cut 2 (5s) removed
    const restoredDoc = ProjectVersionDiffEngine.cherryPickRestoreDeletedSpan(
      rev3,
      report.deletedSourceSpans[0],
    );

    assert.equal(restoredDoc.revision, 4);
    assert.equal(restoredDoc.tracks[0].clips.length, 4);

    // Verify new comparison against rev1 only has Cut 2 (5s) remaining deleted
    const afterRestoreDiff = ProjectVersionDiffEngine.compareProjectVersions(rev1, restoredDoc);
    assert.equal(afterRestoreDiff.deletedSourceSpans.length, 1);
    assert.equal(afterRestoreDiff.deletedSourceSpans[0].durationRemovedSeconds, 5);
    assert.equal(afterRestoreDiff.netTimeSavedSeconds, 5);
  });
});
