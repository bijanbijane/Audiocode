import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UserDecisionHistoryLedger } from './UserDecisionHistoryLedger';
import { TimeMath } from '../contracts/timebase.contract';
import { AIRecommendationRecord } from '../contracts/project-schema.contract';

describe('UserDecisionHistoryLedger (Section 37)', () => {
  const sampleRec: AIRecommendationRecord = {
    id: 'rec_pause_1',
    targetTrackId: 'trk_1',
    disfluencyType: 'LONG_PAUSE',
    associatedText: '[مکث ۱.۴ ثانیه]',
    status: 'PENDING',
    createdAtProjectRevision: 1,
    spliceDescriptor: {
      rawAiRange: {
        start: TimeMath.secondsToFlicks(10),
        end: TimeMath.secondsToFlicks(11.4),
      },
      snappedAcousticRange: {
        start: TimeMath.secondsToFlicks(10),
        end: TimeMath.secondsToFlicks(11.4),
      },
      fadeInDurationFlicks: 0,
      fadeOutDurationFlicks: 0,
      injectRoomToneFlicks: 0,
      cutStrategy: 'GLOBAL_SYNC_RIPPLE',
      prosodicWarnings: [],
      confidence: 0.89,
    },
  };

  it('records user rejections with reason codes while keeping autoMutateModelBehaviorOnRejection strictly false', () => {
    const ledger = new UserDecisionHistoryLedger();
    assert.equal(ledger.autoMutateModelBehaviorOnRejection, false);

    const entry = ledger.recordUserDecision({
      rec: sampleRec,
      analysisSourceModelId: 'persian-disfluency-v1.2',
      inputAssetContentVersion: 1,
      decision: 'REJECTED',
      rejectionReason: 'INTENTIONAL_EMPHASIS_PAUSE',
      rejectionNoteFa: 'مکث دراماتیک داستان صوتی',
    });

    assert.equal(entry.decisionStatus, 'REJECTED');
    assert.equal(entry.optionalRejectionReason, 'INTENTIONAL_EMPHASIS_PAUSE');
    assert.equal(ledger.getAllLedgerEntries().length, 1);
  });

  it('marks overlapping entries as SUPERSEDED when input asset content version increments', () => {
    const ledger = new UserDecisionHistoryLedger();
    ledger.recordUserDecision({
      rec: sampleRec,
      analysisSourceModelId: 'persian-disfluency-v1.2',
      inputAssetContentVersion: 1,
      decision: 'MODIFIED',
      userModifiedRange: {
        start: TimeMath.secondsToFlicks(10.1),
        end: TimeMath.secondsToFlicks(11.2),
      },
    });

    const supersededCount = ledger.markEntriesSupersededForRange(
      {
        start: TimeMath.secondsToFlicks(9.5),
        end: TimeMath.secondsToFlicks(12.0),
      },
      2,
    );

    assert.equal(supersededCount, 1);
    assert.equal(ledger.getAllLedgerEntries()[0].decisionStatus, 'SUPERSEDED');
  });
});
