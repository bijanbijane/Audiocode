import {
  EditConflictRecord,
  EditConflictType,
  EditProposal,
  EditProposalStatus,
} from './EditDecisionTypes';
import { deterministicHexHash } from './EditProvenance';

export interface ConflictResolutionResult {
  readonly proposals: readonly EditProposal[];
  readonly conflicts: readonly EditConflictRecord[];
  readonly cancelled: boolean;
}

const DESTRUCTIVE_OPS = new Set([
  'REMOVE_FILLER',
  'SHORTEN_SILENCE',
  'REMOVE_ACCIDENTAL_REPETITION',
]);

function isDestructive(proposal: EditProposal): boolean {
  return DESTRUCTIVE_OPS.has(proposal.operation);
}

function getEffectiveInterval(proposal: EditProposal): { start: number; end: number } | null {
  const interval = proposal.proposedRange ?? proposal.originalRange;
  if (!interval) return null;
  return { start: interval.startSample, end: interval.endSample };
}

function hasSharedToken(a: EditProposal, b: EditProposal): boolean {
  if (a.relatedTokenIds.length === 0 || b.relatedTokenIds.length === 0) return false;
  const setA = new Set(a.relatedTokenIds);
  return b.relatedTokenIds.some((id) => setA.has(id));
}

function hasSharedEventId(a: EditProposal, b: EditProposal): boolean {
  const setA = new Set(a.speechEventSourceIds);
  return b.speechEventSourceIds.some((id) => setA.has(id));
}

function makeConflictId(type: EditConflictType, ids: readonly string[]): string {
  const sorted = [...ids].sort().join(',');
  return `conf_${deterministicHexHash(`${type}|${sorted}`)}`;
}

/**
 * Deterministic Overlap & Conflict Resolver (AVP-P05-001 Section 8)
 * Reconciles duplicates, identical/overlapping/nested/adjacent intervals,
 * filler-inside-silence, breath-inside-silence, shared-word conflicts,
 * protected-event overlaps, and mixed transcript versions without losing provenance.
 */
export class EditConflictResolver {
  public static resolve(params: {
    readonly proposals: readonly EditProposal[];
    readonly expectedTranscriptVersion: string;
    readonly signal?: AbortSignal;
  }): ConflictResolutionResult {
    const conflicts: EditConflictRecord[] = [];
    const conflictMap = new Map<string, string[]>(); // proposalId -> conflictIds

    // Sort deterministically by trackId, startSample, endSample, proposalId
    const working: EditProposal[] = [...params.proposals].sort((a, b) => {
      if (a.trackId !== b.trackId) return a.trackId.localeCompare(b.trackId);
      const aStart = a.originalRange?.startSample ?? Number.MAX_SAFE_INTEGER;
      const bStart = b.originalRange?.startSample ?? Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;
      const aEnd = a.originalRange?.endSample ?? Number.MAX_SAFE_INTEGER;
      const bEnd = b.originalRange?.endSample ?? Number.MAX_SAFE_INTEGER;
      if (aEnd !== bEnd) return aEnd - bEnd;
      return a.proposalId.localeCompare(b.proposalId);
    });

    const statusOverrides = new Map<string, EditProposalStatus>();
    const supersededByMap = new Map<string, string>();
    const consolidatedFromMap = new Map<string, Set<string>>();

    const attachConflict = (record: EditConflictRecord) => {
      conflicts.push(record);
      for (const pid of record.involvedProposalIds) {
        const list = conflictMap.get(pid) ?? [];
        list.push(record.conflictId);
        conflictMap.set(pid, list);
      }
    };

    const markStatus = (proposalId: string, nextStatus: EditProposalStatus) => {
      const current = statusOverrides.get(proposalId);
      // Do not downgrade INVALID/STALE/SUPERSEDED back to NEEDS_REVIEW
      if (current === 'INVALID' || current === 'STALE' || current === 'SUPERSEDED') return;
      statusOverrides.set(proposalId, nextStatus);
    };

    // Pass 1: Detect mixed/stale transcript versions immediately
    for (const p of working) {
      if (params.signal?.aborted) {
        return { proposals: working, conflicts, cancelled: true };
      }
      if (p.transcriptVersion !== params.expectedTranscriptVersion) {
        const confId = makeConflictId('TRANSCRIPT_VERSION_MISMATCH', [p.proposalId]);
        attachConflict({
          conflictId: confId,
          type: 'TRANSCRIPT_VERSION_MISMATCH',
          involvedProposalIds: [p.proposalId],
          resolutionAction: 'REJECTED_STALE_VERSION',
          supersededProposalIds: [],
          blockedProposalIds: [p.proposalId],
          resolved: false,
          reason: `Proposal transcriptVersion "${p.transcriptVersion}" does not match active "${params.expectedTranscriptVersion}".`,
          reasonFa: `نسخه متن پیشنهاد (${p.transcriptVersion}) با نسخه فعال پروژه (${params.expectedTranscriptVersion}) هم‌خوانی ندارد و منقضی شد.`,
        });
        markStatus(p.proposalId, 'STALE');
      }
    }

    // Pass 2: Pairwise deterministic conflict inspection within same track
    const seenProposalIds = new Map<string, EditProposal>();
    for (let i = 0; i < working.length; i++) {
      if (params.signal?.aborted) {
        return { proposals: working, conflicts, cancelled: true };
      }
      const p = working[i];
      const existingSameId = seenProposalIds.get(p.proposalId);
      if (existingSameId) {
        const confId = makeConflictId('DUPLICATE_PROPOSAL', [p.proposalId, `dup_${i}`]);
        attachConflict({
          conflictId: confId,
          type: 'DUPLICATE_PROPOSAL',
          involvedProposalIds: [p.proposalId],
          resolutionAction: 'SUPERSEDED_DUPLICATE',
          winningProposalId: existingSameId.proposalId,
          supersededProposalIds: [p.proposalId],
          blockedProposalIds: [],
          resolved: true,
          reason: `Duplicate proposal ID "${p.proposalId}" detected; earlier record retained.`,
          reasonFa: `شناسه پیشنهاد تکراری «${p.proposalId}» شناسایی شد و نسخه تکراری جایگزین گردید.`,
        });
        // Mark the duplicate entry at index i uniquely so original provenance is preserved
        working[i] = {
          ...p,
          status: 'SUPERSEDED',
          supersededByProposalId: existingSameId.proposalId,
        };
        continue;
      }
      seenProposalIds.set(p.proposalId, p);
    }

    for (let i = 0; i < working.length; i++) {
      if (params.signal?.aborted) {
        return { proposals: working, conflicts, cancelled: true };
      }
      const a = working[i];
      const aStatus = statusOverrides.get(a.proposalId) ?? a.status;
      if (aStatus === 'INVALID' || aStatus === 'SUPERSEDED' || aStatus === 'STALE') continue;
      const aRange = getEffectiveInterval(a);
      if (!aRange) continue;

      const adjacentThresholdSamples = Math.round(a.sampleRate * 0.06); // 60ms

      for (let j = i + 1; j < working.length; j++) {
        const b = working[j];
        if (b.trackId !== a.trackId) continue;
        const bStatus = statusOverrides.get(b.proposalId) ?? b.status;
        if (bStatus === 'INVALID' || bStatus === 'SUPERSEDED' || bStatus === 'STALE') continue;
        const bRange = getEffectiveInterval(b);
        if (!bRange) continue;

        // Since sorted by startSample, if b starts well past a.end + adjacentThreshold, no further b can overlap a
        if (bRange.start > aRange.end + adjacentThresholdSamples && !hasSharedToken(a, b) && !hasSharedEventId(a, b)) {
          // Check originalRange too before breaking early
          const aOrigEnd = a.originalRange?.endSample ?? aRange.end;
          const bOrigStart = b.originalRange?.startSample ?? bRange.start;
          if (bOrigStart > aOrigEnd + adjacentThresholdSamples) {
            break;
          }
        }

        const overlapSamples = Math.min(aRange.end, bRange.end) - Math.max(aRange.start, bRange.start);
        const origA = a.originalRange ?? a.proposedRange;
        const origB = b.originalRange ?? b.proposedRange;
        const origOverlapSamples =
          origA && origB
            ? Math.min(origA.endSample, origB.endSample) - Math.max(origA.startSample, origB.startSample)
            : overlapSamples;

        const sharedEvent = hasSharedEventId(a, b);
        const sharedWord = hasSharedToken(a, b);

        // 2a. Duplicate event reference
        if (sharedEvent) {
          const winner = this.pickHigherConfidenceWinner(a, b);
          const loser = winner.proposalId === a.proposalId ? b : a;
          const confId = makeConflictId('DUPLICATE_EVENT_REFERENCE', [a.proposalId, b.proposalId]);
          attachConflict({
            conflictId: confId,
            type: 'DUPLICATE_EVENT_REFERENCE',
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'SUPERSEDED_DUPLICATE',
            winningProposalId: winner.proposalId,
            supersededProposalIds: [loser.proposalId],
            blockedProposalIds: [],
            resolved: true,
            reason: `Proposals ${a.proposalId} and ${b.proposalId} reference the same source speech event; ${loser.proposalId} superseded with provenance preserved.`,
            reasonFa: `دو پیشنهاد به یک رویداد گفتار مشترک ارجاع دارند؛ نسخه کم‌اعتبارتر با حفظ سابقه جایگزین شد.`,
          });
          markStatus(loser.proposalId, 'SUPERSEDED');
          supersededByMap.set(loser.proposalId, winner.proposalId);
          continue;
        }

        // 2b. Breath or protected event inside/overlapping a destructive proposal (e.g. breath inside silence)
        if (origOverlapSamples > 0 && ((a.protectedEvent && isDestructive(b)) || (b.protectedEvent && isDestructive(a)))) {
          const protectedProp = a.protectedEvent ? a : b;
          const destructiveProp = a.protectedEvent ? b : a;
          const isBreathInSilence =
            protectedProp.eventCategory === 'BREATH' && destructiveProp.eventCategory === 'SILENCE';
          const confType: EditConflictType = isBreathInSilence
            ? 'BREATH_INSIDE_SILENCE'
            : 'PROTECTED_EVENT_OVERLAP';
          const confId = makeConflictId(confType, [a.proposalId, b.proposalId]);
          attachConflict({
            conflictId: confId,
            type: confType,
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'BLOCKED_PROTECTED_OVERLAP',
            winningProposalId: protectedProp.proposalId,
            supersededProposalIds: [],
            blockedProposalIds: [destructiveProp.proposalId],
            resolved: false,
            reason: `Destructive proposal ${destructiveProp.proposalId} (${destructiveProp.operation}) overlaps protected event ${protectedProp.proposalId} (${protectedProp.eventCategory}); blocked to preserve protected speech/breath.`,
            reasonFa: `پیشنهاد حذفی با رویداد محافظت‌شده (${protectedProp.eventCategory}) هم‌پوشانی دارد و برای جلوگیری از آسیب به صدا مسدود شد.`,
          });
          markStatus(destructiveProp.proposalId, 'NEEDS_REVIEW');
          continue;
        }

        // 2c. Filler inside silence (or silence enclosing filler)
        if (
          origOverlapSamples > 0 &&
          ((a.eventCategory === 'SILENCE' && b.eventCategory === 'FILLER') ||
            (b.eventCategory === 'SILENCE' && a.eventCategory === 'FILLER'))
        ) {
          const silenceProp = a.eventCategory === 'SILENCE' ? a : b;
          const fillerProp = a.eventCategory === 'FILLER' ? a : b;
          const confId = makeConflictId('FILLER_INSIDE_SILENCE', [a.proposalId, b.proposalId]);
          attachConflict({
            conflictId: confId,
            type: 'FILLER_INSIDE_SILENCE',
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'CONSOLIDATED_WITH_PROVENANCE',
            winningProposalId: fillerProp.proposalId,
            supersededProposalIds: [],
            blockedProposalIds: [silenceProp.proposalId],
            consolidatedProposalId: fillerProp.proposalId,
            resolved: false, // Requires human review to confirm combined scope
            reason: `Filler ${fillerProp.proposalId} falls inside silence ${silenceProp.proposalId}; both records preserved and routed for human review before removal.`,
            reasonFa: `تپق در درون بازه سکوت قرار گرفته است؛ هر دو رکورد با حفظ سابقه برای بازبینی انسانی علامت‌گذاری شدند.`,
          });
          const set = consolidatedFromMap.get(fillerProp.proposalId) ?? new Set<string>();
          set.add(silenceProp.proposalId);
          consolidatedFromMap.set(fillerProp.proposalId, set);
          markStatus(silenceProp.proposalId, 'NEEDS_REVIEW');
          markStatus(fillerProp.proposalId, 'NEEDS_REVIEW');
          continue;
        }

        // 2d. Shared spoken word across two proposals
        if (sharedWord) {
          const confId = makeConflictId('SHARED_WORD_CONFLICT', [a.proposalId, b.proposalId]);
          attachConflict({
            conflictId: confId,
            type: 'SHARED_WORD_CONFLICT',
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'REQUIRES_HUMAN_REVIEW',
            supersededProposalIds: [],
            blockedProposalIds: [a.proposalId, b.proposalId],
            resolved: false,
            reason: `Proposals ${a.proposalId} (${a.operation}) and ${b.proposalId} (${b.operation}) both target the same spoken word token(s); human decision required.`,
            reasonFa: `دو پیشنهاد به یک واژه مشترک ارجاع دارند؛ برای جلوگیری از حذف مضاعف، تصمیم‌گیری انسانی لازم است.`,
          });
          markStatus(a.proposalId, 'NEEDS_REVIEW');
          markStatus(b.proposalId, 'NEEDS_REVIEW');
          continue;
        }

        // 2e. Identical intervals
        if (aRange.start === bRange.start && aRange.end === bRange.end) {
          if (a.operation === b.operation) {
            const winner = this.pickHigherConfidenceWinner(a, b);
            const loser = winner.proposalId === a.proposalId ? b : a;
            const confId = makeConflictId('IDENTICAL_INTERVAL', [a.proposalId, b.proposalId]);
            attachConflict({
              conflictId: confId,
              type: 'IDENTICAL_INTERVAL',
              involvedProposalIds: [a.proposalId, b.proposalId],
              resolutionAction: 'SUPERSEDED_DUPLICATE',
              winningProposalId: winner.proposalId,
              supersededProposalIds: [loser.proposalId],
              blockedProposalIds: [],
              resolved: true,
              reason: `Identical interval [${aRange.start}, ${aRange.end}) with same operation ${a.operation}; ${loser.proposalId} superseded.`,
              reasonFa: `دو پیشنهاد با بازه و عملیات یکسان شناسایی شدند؛ مورد کم‌اولویت‌تر جایگزین گردید.`,
            });
            markStatus(loser.proposalId, 'SUPERSEDED');
            supersededByMap.set(loser.proposalId, winner.proposalId);
          } else {
            const confId = makeConflictId('CONFLICTING_OPERATIONS', [a.proposalId, b.proposalId]);
            attachConflict({
              conflictId: confId,
              type: 'CONFLICTING_OPERATIONS',
              involvedProposalIds: [a.proposalId, b.proposalId],
              resolutionAction: 'REQUIRES_HUMAN_REVIEW',
              supersededProposalIds: [],
              blockedProposalIds: [a.proposalId, b.proposalId],
              resolved: false,
              reason: `Identical interval [${aRange.start}, ${aRange.end}) has conflicting operations (${a.operation} vs ${b.operation}).`,
              reasonFa: `بازه یکسان دارای دو عملیات متعارض (${a.operation} و ${b.operation}) است و نیازمند بازبینی انسانی است.`,
            });
            markStatus(a.proposalId, 'NEEDS_REVIEW');
            markStatus(b.proposalId, 'NEEDS_REVIEW');
          }
          continue;
        }

        // 2f. Nested intervals
        const aContainsB = aRange.start <= bRange.start && aRange.end >= bRange.end;
        const bContainsA = bRange.start <= aRange.start && bRange.end >= aRange.end;
        if (overlapSamples > 0 && (aContainsB || bContainsA)) {
          const confId = makeConflictId('NESTED_INTERVAL', [a.proposalId, b.proposalId]);
          attachConflict({
            conflictId: confId,
            type: 'NESTED_INTERVAL',
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'REQUIRES_HUMAN_REVIEW',
            supersededProposalIds: [],
            blockedProposalIds: isDestructive(a) && isDestructive(b) ? [a.proposalId, b.proposalId] : [],
            resolved: !(isDestructive(a) && isDestructive(b)),
            reason: `Nested source intervals between ${a.proposalId} and ${b.proposalId}; prevented double removal of nested samples.`,
            reasonFa: `تداخل تودرتو بین دو پیشنهاد؛ برای جلوگیری از حذف دوگانه نمونه‌ها نیازمند بازبینی انسانی است.`,
          });
          if (isDestructive(a) && isDestructive(b)) {
            markStatus(a.proposalId, 'NEEDS_REVIEW');
            markStatus(b.proposalId, 'NEEDS_REVIEW');
          }
          continue;
        }

        // 2g. Partial overlap
        if (overlapSamples > 0) {
          const confId = makeConflictId('PARTIAL_OVERLAP', [a.proposalId, b.proposalId]);
          const bothDestructive = isDestructive(a) && isDestructive(b);
          attachConflict({
            conflictId: confId,
            type: 'PARTIAL_OVERLAP',
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'REQUIRES_HUMAN_REVIEW',
            supersededProposalIds: [],
            blockedProposalIds: bothDestructive ? [a.proposalId, b.proposalId] : [],
            resolved: !bothDestructive,
            reason: `Partial sample overlap (${overlapSamples} samples) between ${a.proposalId} and ${b.proposalId}.`,
            reasonFa: `هم‌پوشانی جزئی (${overlapSamples} نمونه) بین دو پیشنهاد؛ حذف هم‌زمان هر دو مجاز نیست.`,
          });
          if (bothDestructive) {
            markStatus(a.proposalId, 'NEEDS_REVIEW');
            markStatus(b.proposalId, 'NEEDS_REVIEW');
          }
          continue;
        }

        // 2h. Adjacent intervals (non-overlapping, within 60ms)
        const gapSamples = Math.max(bRange.start - aRange.end, aRange.start - bRange.end);
        if (gapSamples >= 0 && gapSamples <= adjacentThresholdSamples && (isDestructive(a) || isDestructive(b))) {
          const confId = makeConflictId('ADJACENT_INTERVAL', [a.proposalId, b.proposalId]);
          attachConflict({
            conflictId: confId,
            type: 'ADJACENT_INTERVAL',
            involvedProposalIds: [a.proposalId, b.proposalId],
            resolutionAction: 'MARKED_ADJACENT_NOTICE',
            supersededProposalIds: [],
            blockedProposalIds: [],
            resolved: true,
            reason: `Adjacent proposals within ${Math.round((gapSamples / a.sampleRate) * 1000)}ms; crossfade/micro-sliver boundary validation required before future application.`,
            reasonFa: `دو پیشنهاد مجاور هم هستند (فاصله ${Math.round((gapSamples / a.sampleRate) * 1000)}ms)؛ کنترل خردهکلیپ پیش از اجرا لازم است.`,
          });
        }
      }
    }

    const updatedProposals = working.map((p) => {
      const nextStatus = statusOverrides.get(p.proposalId) ?? p.status;
      const cIds = conflictMap.get(p.proposalId) ?? [];
      const supBy = supersededByMap.get(p.proposalId) ?? p.supersededByProposalId;
      const consol = consolidatedFromMap.get(p.proposalId);
      const hasUnresolved = conflicts.some(
        (c) => !c.resolved && c.involvedProposalIds.includes(p.proposalId),
      );
      return {
        ...p,
        status: nextStatus,
        requiresHumanReview: p.requiresHumanReview || hasUnresolved,
        conflictIds: [...new Set([...p.conflictIds, ...cIds])],
        supersededByProposalId: supBy,
        consolidatedFromProposalIds: consol ? Array.from(consol) : p.consolidatedFromProposalIds,
      };
    });

    return {
      proposals: updatedProposals,
      conflicts,
      cancelled: false,
    };
  }

  private static pickHigherConfidenceWinner(a: EditProposal, b: EditProposal): EditProposal {
    const scoreA = a.eventConfidenceScore ?? 0;
    const scoreB = b.eventConfidenceScore ?? 0;
    if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
    return a.proposalId.localeCompare(b.proposalId) <= 0 ? a : b;
  }
}
