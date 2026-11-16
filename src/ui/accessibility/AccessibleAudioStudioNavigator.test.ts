import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccessibleAudioStudioNavigator } from './AccessibleAudioStudioNavigator';
import { PersianTextNormalizer } from '../../ai-engine/PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';
import { AIRecommendationRecord } from '../../contracts/project-schema.contract';

describe('AccessibleAudioStudioNavigator (Sections 50 & 51)', () => {
  it('navigates Persian words step-by-step and emits 60ms acoustic scrubbing grains', () => {
    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 't1',
        text: 'سلام',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
        confidence: 0.98,
      },
      {
        id: 't2',
        text: 'شنوندگان',
        range: {
          start: TimeMath.secondsToFlicks(1.0),
          end: TimeMath.secondsToFlicks(1.6),
        },
        confidence: 0.92,
      },
    ]);

    const nav = new AccessibleAudioStudioNavigator();
    const step1 = nav.navigateTokensByStep(tokens, 1, 48000);
    assert.ok(step1);
    assert.equal(step1.politeness, 'polite');
    assert.ok(step1.messageFa.includes('شنوندگان'));
    assert.ok(step1.messageFa.includes('۹۲') || step1.messageFa.includes('92'));
    assert.equal(step1.acousticScrubGrainRange.startSample, 48000);
    assert.equal(step1.acousticScrubGrainRange.frameCount, Math.floor(48000 * 0.06));
  });

  it('cycles through pending recommendations and announces Ezafe/prosodic warnings', () => {
    const recs: AIRecommendationRecord[] = [
      {
        id: 'r1',
        targetTrackId: 'trk_1',
        disfluencyType: 'INDEPENDENT_FILLER',
        associatedText: 'اممم',
        status: 'PENDING',
        createdAtProjectRevision: 1,
        spliceDescriptor: {
          rawAiRange: {
            start: TimeMath.secondsToFlicks(2.0),
            end: TimeMath.secondsToFlicks(2.4),
          },
          snappedAcousticRange: {
            start: TimeMath.secondsToFlicks(2.0),
            end: TimeMath.secondsToFlicks(2.4),
          },
          fadeInDurationFlicks: 0,
          fadeOutDurationFlicks: 0,
          injectRoomToneFlicks: 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: ['TRAILING_EZAFE_RISK'],
          confidence: 0.91,
        },
      },
    ];

    const nav = new AccessibleAudioStudioNavigator();
    const res = nav.navigatePendingRecommendations(recs, 1, 48000);
    assert.ok(res);
    assert.equal(res.selectedRecommendation.id, 'r1');
    assert.equal(res.announcement.politeness, 'assertive');
    assert.ok(res.announcement.messageFa.includes('کسره اضافه'));
    assert.ok(res.announcement.messageFa.includes('400'));
  });

  it('builds semantic ARIA track summaries', () => {
    const summary = AccessibleAudioStudioNavigator.buildAriaTrackSummary('گوینده اول', [
      {
        id: 'c1',
        trackId: 'trk_1',
        kind: 'AUDIO_ASSET',
        assetId: 'a1',
        sourceRange: { start: 0, end: TimeMath.secondsToFlicks(12.5) },
        timelineRange: { start: 0, end: TimeMath.secondsToFlicks(12.5) },
        fadeInFlicks: 0,
        fadeOutFlicks: 0,
        gainDb: 0,
      },
      {
        id: 'c2',
        trackId: 'trk_1',
        kind: 'ROOM_TONE_FILL',
        assetId: 'rt1',
        sourceRange: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
        timelineRange: {
          start: TimeMath.secondsToFlicks(12.5),
          end: TimeMath.secondsToFlicks(13.0),
        },
        fadeInFlicks: 0,
        fadeOutFlicks: 0,
        gainDb: 0,
      },
    ]);

    assert.ok(summary.includes('گوینده اول'));
    assert.ok(summary.includes('2 قطعه صوتی'));
    assert.ok(summary.includes('1 پیوند صدای محیط'));
    assert.ok(summary.includes('13.0 ثانیه'));
  });
});
