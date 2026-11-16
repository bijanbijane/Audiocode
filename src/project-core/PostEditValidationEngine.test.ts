import test from 'node:test';
import assert from 'node:assert/strict';
import { PostEditValidationEngine } from './PostEditValidationEngine';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

function makeBaseDoc(tracks: ProjectDocument['tracks']): ProjectDocument {
  return {
    projectId: 'proj-post-edit-1',
    name: 'آزمون اعتبارسنجی تدوین',
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: 'persian-asr-v1',
    },
    revision: 3,
    tracks,
    recommendations: [],
  };
}

test('PostEditValidationEngine detects micro-slivers, overlaps, missing micro-fades, loudness jumps, and auto-heals them cleanly', () => {
  const doc = makeBaseDoc([
    {
      id: 'track-host',
      name: 'میزبان',
      syncGroupId: null,
      speakerId: 'host',
      muted: false,
      solo: false,
      clips: [
        {
          id: 'clip-main-1',
          trackId: 'track-host',
          kind: 'AUDIO_ASSET',
          assetId: 'asset-host',
          sourceRange: { start: 0, end: TimeMath.secondsToFlicks(2.0) },
          timelineRange: { start: 0, end: TimeMath.secondsToFlicks(2.0) },
          fadeInFlicks: 0,
          fadeOutFlicks: 0,
          gainDb: 0,
        },
        {
          id: 'clip-butt-2',
          trackId: 'track-host',
          kind: 'AUDIO_ASSET',
          assetId: 'asset-host',
          sourceRange: {
            start: TimeMath.secondsToFlicks(2.0),
            end: TimeMath.secondsToFlicks(2.5),
          },
          timelineRange: {
            start: TimeMath.secondsToFlicks(2.0),
            end: TimeMath.secondsToFlicks(2.5),
          },
          fadeInFlicks: 0,
          fadeOutFlicks: 0,
          gainDb: 0,
        },
        {
          id: 'clip-sliver-4ms',
          trackId: 'track-host',
          kind: 'AUDIO_ASSET',
          assetId: 'asset-host',
          sourceRange: {
            start: TimeMath.secondsToFlicks(2.5),
            end: TimeMath.secondsToFlicks(2.504),
          },
          timelineRange: {
            start: TimeMath.secondsToFlicks(2.5),
            end: TimeMath.secondsToFlicks(2.504),
          },
          fadeInFlicks: 0,
          fadeOutFlicks: 0,
          gainDb: 0,
        },
        {
          id: 'clip-overlap-3',
          trackId: 'track-host',
          kind: 'AUDIO_ASSET',
          assetId: 'asset-host',
          // Overlaps clip-butt-2 (starts at 2.40s < 2.50s) + +8.5dB gain jump
          sourceRange: {
            start: TimeMath.secondsToFlicks(3.0),
            end: TimeMath.secondsToFlicks(4.6),
          },
          timelineRange: {
            start: TimeMath.secondsToFlicks(2.4),
            end: TimeMath.secondsToFlicks(4.0),
          },
          fadeInFlicks: 0,
          fadeOutFlicks: 0,
          gainDb: 8.5,
        },
      ],
    },
  ]);

  const initial = PostEditValidationEngine.validateProjectTimeline(doc);
  assert.equal(initial.isValid, false);

  const codes = new Set(initial.issues.map((i) => i.issueCode));
  assert.ok(codes.has('ORPHAN_MICRO_SLIVER_CLIP'));
  assert.ok(codes.has('OVERLAPPING_TIMELINE_CLIPS'));
  assert.ok(codes.has('MISSING_BOUNDARY_MICRO_FADE'));

  const healed = PostEditValidationEngine.autoHealTimelineIssues(doc);
  assert.equal(healed.revision, doc.revision + 1);
  assert.equal(healed.tracks[0].clips.length, 3); // Sliver removed
  assert.equal(healed.tracks[0].clips[1].timelineRange.end, TimeMath.secondsToFlicks(2.4)); // Overlap trimmed cleanly

  const afterHeal = PostEditValidationEngine.validateProjectTimeline(healed);
  // Only the non-auto-healable gain discontinuity (0dB -> 8.5dB) remains; all micro-sliver/overlap/fade issues resolved
  assert.deepEqual(
    afterHeal.issues.map((i) => i.issueCode),
    ['LOUDNESS_GAIN_DISCONTINUITY'],
  );
});

test('PostEditValidationEngine flags SYNC_GROUP_DURATION_DRIFT when sibling sync tracks diverge', () => {
  const doc = makeBaseDoc([
    {
      id: 'track-host',
      name: 'میزبان',
      syncGroupId: 'interview-sync',
      speakerId: 'host',
      muted: false,
      solo: false,
      clips: [
        {
          id: 'h1',
          trackId: 'track-host',
          kind: 'AUDIO_ASSET',
          assetId: 'a1',
          sourceRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
          timelineRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
          fadeInFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
          gainDb: 0,
        },
      ],
    },
    {
      id: 'track-guest',
      name: 'مهمان',
      syncGroupId: 'interview-sync',
      speakerId: 'guest',
      muted: false,
      solo: false,
      clips: [
        {
          id: 'g1',
          trackId: 'track-guest',
          kind: 'AUDIO_ASSET',
          assetId: 'a2',
          sourceRange: { start: 0, end: TimeMath.secondsToFlicks(9.5) },
          timelineRange: { start: 0, end: TimeMath.secondsToFlicks(9.5) },
          fadeInFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
          gainDb: 0,
        },
      ],
    },
  ]);

  const res = PostEditValidationEngine.validateProjectTimeline(doc);
  assert.equal(res.isValid, false);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].issueCode, 'SYNC_GROUP_DURATION_DRIFT');
  assert.equal(res.issues[0].trackId, 'track-guest');
  assert.equal(res.issues[0].autoHealable, false);
});
