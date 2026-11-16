import {
  AIRecommendationRecord,
  RecommendationId,
  RecommendationStatus,
} from '../contracts/project-schema.contract';
import { DisfluencyType } from '../contracts/persian-editing.contract';
import { TimeRange } from '../contracts/timebase.contract';

export type RejectionReasonCode =
  | 'INTENTIONAL_EMPHASIS_PAUSE' // مکث عمدی گوینده برای تاکید معنایی بوده است
  | 'FALSE_POSITIVE_ASR_WORD'    // کلمه بخشی از جمله اصلی است و تپق نیست
  | 'UNNATURAL_SPLICE_SOUND'     // صدای برش‌خورده در پیش‌نمایش طبیعی نبود
  | 'USER_CUSTOM_REASON';

export interface UserDecisionLedgerEntry {
  readonly decisionEntryId: string;
  readonly recommendationId: RecommendationId;
  readonly analysisSourceModelId: string;
  readonly originalAudioRange: TimeRange;
  readonly userModifiedAudioRange?: TimeRange;
  readonly recommendationType: DisfluencyType;
  readonly originalConfidence: number;
  readonly inputAssetContentVersion: number;
  readonly decisionStatus: RecommendationStatus;
  readonly timestampMs: number;
  readonly optionalRejectionReason?: RejectionReasonCode;
  readonly optionalRejectionNoteFa?: string;
}

/**
 * User Decision History Ledger without Implicit Model Mutation (Architecture Doc Section 37)
 * Tracks every recommendation lifecycle transition (PENDING -> ACCEPTED / REJECTED / MODIFIED /
 * SUPERSEDED / INVALIDATED) with full provenance and optional rejection reasons, while strictly
 * enforcing Section 37: rejecting a suggestion never implicitly mutates or trains the AI model.
 */
export class UserDecisionHistoryLedger {
  /** Section 37 invariant: rejecting a suggestion never auto-mutates or trains the model */
  public readonly autoMutateModelBehaviorOnRejection = false as const;

  private readonly entries: UserDecisionLedgerEntry[] = [];

  /**
   * 1. Records a user decision (ACCEPTED, REJECTED, or MODIFIED) without hidden model mutation.
   */
  public recordUserDecision(params: {
    rec: AIRecommendationRecord;
    analysisSourceModelId: string;
    inputAssetContentVersion: number;
    decision: 'ACCEPTED' | 'REJECTED' | 'MODIFIED';
    userModifiedRange?: TimeRange;
    rejectionReason?: RejectionReasonCode;
    rejectionNoteFa?: string;
  }): UserDecisionLedgerEntry {
    const entry: UserDecisionLedgerEntry = {
      decisionEntryId: `dec_${params.rec.id}_${Date.now()}`,
      recommendationId: params.rec.id,
      analysisSourceModelId: params.analysisSourceModelId,
      originalAudioRange: { ...params.rec.spliceDescriptor.snappedAcousticRange },
      userModifiedAudioRange: params.userModifiedRange
        ? { ...params.userModifiedRange }
        : undefined,
      recommendationType: params.rec.disfluencyType,
      originalConfidence: params.rec.spliceDescriptor.confidence,
      inputAssetContentVersion: params.inputAssetContentVersion,
      decisionStatus: params.decision,
      timestampMs: Date.now(),
      optionalRejectionReason: params.rejectionReason,
      optionalRejectionNoteFa: params.rejectionNoteFa,
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * 2. Marks overlapping historical entries as SUPERSEDED when the underlying input asset version advances.
   */
  public markEntriesSupersededForRange(
    mutatedRange: TimeRange,
    newInputVersion: number,
  ): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const overlaps =
        e.originalAudioRange.start < mutatedRange.end &&
        e.originalAudioRange.end > mutatedRange.start;

      if (overlaps && e.inputAssetContentVersion < newInputVersion) {
        this.entries[i] = {
          ...e,
          decisionStatus: 'SUPERSEDED',
        };
        count++;
      }
    }
    return count;
  }

  public getAllLedgerEntries(): readonly UserDecisionLedgerEntry[] {
    return this.entries;
  }
}
