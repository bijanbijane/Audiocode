import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeMath } from '../../contracts/timebase.contract';
import { PersianWordToken } from '../../contracts/v1_2';
import { ProjectDocument } from '../../contracts/project-schema.contract';
import {
  SPEECH_EVENT_ENGINE_VERSION,
  SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
  SpeechEvent,
} from '../speech-events/SpeechEventContracts';
import { EditDecisionEngine } from './EditDecisionEngine';
import { EditConflictResolver } from './EditConflictResolver';
import { EditDecisionValidator } from './EditDecisionValidator';

function makeEvent(params: {
  id: string;
  startSec: number;
  endSec: number;
  text?: string;
}): SpeechEvent {
  const startFlicks = TimeMath.secondsToFlicks(params.startSec);
  const endFlicks = TimeMath.secondsToFlicks(params.endSec);
  return {
    eventId: params.id,
    trackId: 't1',
    category: 'FILLER',
    subtype: 'VOCAL_FILLED_PAUSE',
    detectionState: 'DETECTED',
    startSec: params.startSec,
    endSec: params.endSec,
    durationSec: params.endSec - params.startSec,
    startFlicks,
    endFlicks,
    durationFlicks: endFlicks - startFlicks,
    relatedTokenIds: [`tok-${params.id}`],
    relatedText: params.text ?? 'اممم',
    acousticEvidence: {
      rmsDb: -26,
      peakDb: -16,
      noiseFloorDbfs: -54,
      vadSpeechRatio: 0.85,
      vadActiveOverlap: false,
      digitalZeroRatio: 0,
    },
    linguisticEvidence: {
      matchedLexiconId: 'fa_vocal_filler_omm',
      canonicalForm: params.text ?? 'اممم',
      linguisticRole: 'VOCAL_FILLED_PAUSE',
    },
    detectionMethod: 'HYBRID_HEURISTIC_FUSION',
    confidence: 0.93,
    uncertaintyState: 'LOW_UNCERTAINTY',
    scores: {
      acousticScore: 0.91,
      linguisticScore: 0.94,
      ruleEvidenceCount: 3,
      modelTokenConfidence: 0.96,
      combinedDecisionScore: 0.93,
      calibratedProbability: null,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      conflicts: [],
    },
    provenance: {
      engineVersion: SPEECH_EVENT_ENGINE_VERSION,
      thresholdConfigVersion: SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
      detectorModule: 'test-fixture',
      capabilityMode: 'heuristic',
    },
    eligibleForEditSuggestion: true,
    requiresHumanReview: false,
    explanationFa: 'تپق تست',
  };
}

function makeToken(params: { id: string; startSec: number; endSec: number }): PersianWordToken {
  return {
    id: `tok-${params.id}`,
    trackId: 't1',
    speakerName: 'Host',
    originalText: 'اممم',
    normalizedText: 'اممم',
    displayText: 'اممم',
    range: {
      startFlicks: TimeMath.secondsToFlicks(params.startSec),
      endFlicks: TimeMath.secondsToFlicks(params.endSec),
    },
    confidence: 0.96,
    alignmentSource: 'ForcedAlignment',
    alignmentPrecision: 'forced_aligned',
    isDisfluency: true,
  };
}

test('EditDecisionValidator dry-run simulation shifts post-cut clips and sibling sync-group tracks without false drift', async () => {
  const sampleRate = 48_000 as const;
  const totalSamples = sampleRate * 10;
  const edl0 = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-edl-sim',
      sourceAudioId: 'a1',
      sourceAudioHash: 'sha256:sim',
      transcriptVersion: 'tr-1',
      sampleRate,
      channelLayout: 'mono',
      totalSourceSamples: totalSamples,
    },
    events: [makeEvent({ id: 'ev-1', startSec: 1.0, endSec: 2.0 })],
    tokens: [makeToken({ id: 'ev-1', startSec: 1.0, endSec: 2.0 })],
    nowMs: 1000,
  });

  const approved = EditDecisionEngine.approveProposal(edl0, edl0.proposals[0].proposalId, {
    nowMs: 1001,
  });
  assert.equal(approved.ok, true, approved.failure?.message);

  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const fade = TimeMath.secondsToFlicks(0.01);
  // Multi-clip synced project: t1 has two clips [0..4) and [4..10); sibling t2 has [0..10) in same syncGroupId
  const doc: ProjectDocument = {
    projectId: 'proj-edl-sim',
    name: 'Synced Dry-Run Test',
    canonicalSampleRate: sampleRate,
    versions: {
      projectSchemaVersion: 1,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0.0',
      activeModelBundleVersion: '1.0.0',
    },
    revision: 1,
    tracks: [
      {
        id: 't1',
        name: 'Host',
        syncGroupId: 'sync-pod',
        speakerId: 'host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'a1',
            sourceRange: { start: 0, end: s(4) },
            timelineRange: { start: 0, end: s(4) },
            fadeInFlicks: fade,
            fadeOutFlicks: fade,
            gainDb: 0,
          },
          {
            id: 'c2',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'a1',
            sourceRange: { start: s(4), end: s(10) },
            timelineRange: { start: s(4), end: s(10) },
            fadeInFlicks: fade,
            fadeOutFlicks: fade,
            gainDb: 0,
          },
        ],
      },
      {
        id: 't2',
        name: 'Guest',
        syncGroupId: 'sync-pod',
        speakerId: 'guest',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c3',
            trackId: 't2',
            kind: 'AUDIO_ASSET',
            assetId: 'a2',
            sourceRange: { start: 0, end: s(10) },
            timelineRange: { start: 0, end: s(10) },
            fadeInFlicks: fade,
            fadeOutFlicks: fade,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
  };

  const plan = EditDecisionValidator.validateForApplication({
    edl: approved.snapshot,
    projectDoc: doc,
    expectedSourceAudioHash: 'sha256:sim',
    expectedTranscriptVersion: 'tr-1',
    expectedEdlVersion: approved.snapshot.edlVersion,
    nowMs: 1002,
  });

  assert.equal(plan.readyToApply, true, plan.blockingFailures.map((f) => f.message).join('; '));
  assert.equal(plan.blockingFailures.length, 0);
  // Zero false SYNC_GROUP_DURATION_DRIFT or OVERLAPPING_TIMELINE_CLIPS warnings
  const driftWarnings = plan.postEditWarnings.filter((w) =>
    w.includes('SYNC_GROUP_DURATION_DRIFT') || w.includes('OVERLAPPING_TIMELINE_CLIPS'),
  );
  assert.equal(driftWarnings.length, 0);
});

test('EditConflictResolver catches overlap when a later proposal is revised backward across an earlier proposal', async () => {
  const sampleRate = 48_000 as const;
  const totalSamples = sampleRate * 10;
  const edl0 = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-conf',
      sourceAudioId: 'a1',
      sourceAudioHash: 'sha256:conf',
      transcriptVersion: 'tr-1',
      sampleRate,
      channelLayout: 'mono',
      totalSourceSamples: totalSamples,
    },
    events: [
      makeEvent({ id: 'ev-early', startSec: 1.0, endSec: 1.5 }),
      makeEvent({ id: 'ev-mid', startSec: 3.0, endSec: 3.5 }),
      makeEvent({ id: 'ev-late', startSec: 6.0, endSec: 6.5 }),
    ],
    nowMs: 2000,
  });

  const lateProp = edl0.proposals.find((p) => p.speechEventSourceIds.includes('ev-late'))!;
  // Revise ev-late backward so its proposedRange [1.2s..1.6s) overlaps ev-early [1.0s..1.5s),
  // even though ev-late.originalRange is still at [6.0s..6.5s) past ev-mid!
  const revised = EditDecisionEngine.reviseProposalBoundaries(
    edl0,
    lateProp.proposalId,
    {
      startSample: Math.round(sampleRate * 1.2),
      endSample: Math.round(sampleRate * 1.6),
    },
    { nowMs: 2001 },
  );

  assert.equal(revised.ok, true);
  assert.ok(revised.updatedProposal);
  // Conflict must be caught by EditConflictResolver (no premature early break!)
  const overlapConflict = revised.snapshot.conflicts.find(
    (c) =>
      c.involvedProposalIds.includes(revised.updatedProposal!.proposalId) &&
      (c.type === 'PARTIAL_OVERLAP' || c.type === 'NESTED_INTERVAL'),
  );
  assert.ok(overlapConflict, 'Expected overlap conflict between backward-revised late proposal and early proposal');
  // Re-validation must catch the unresolved blocking conflict (never silently hardcoding VALID)
  assert.equal(revised.updatedProposal.validationStatus, 'INVALID');
  assert.equal(revised.updatedProposal.requiresHumanReview, true);
  // Large boundary shift must lower boundaryConfidence from HIGH to MEDIUM
  assert.equal(revised.updatedProposal.boundary.boundaryConfidence, 'MEDIUM');

  // Also verify direct EditConflictResolver.resolve behavior
  const direct = EditConflictResolver.resolve({
    proposals: revised.snapshot.proposals,
    expectedTranscriptVersion: 'tr-1',
  });
  assert.ok(direct.conflicts.length >= 1);
});
