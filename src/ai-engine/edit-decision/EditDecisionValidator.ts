import { FLICKS_PER_SECOND, TimeMath } from '../../contracts/timebase.contract';
import { ProjectDocument, TimelineClip, TimelineTrack } from '../../contracts/project-schema.contract';
import { PostEditValidationEngine } from '../../project-core/PostEditValidationEngine';
import {
  ApplicationReadyEditItem,
  ApplicationReadyEditPlan,
  EDL_SCHEMA_VERSION,
  EditConflictRecord,
  EditDecisionListSnapshot,
  EditOperationType,
  EditProposal,
  EditProposalStatus,
  EditValidationFailure,
  EditValidationStatus,
  EdlSourceContext,
  EdlValidationSummary,
} from './EditDecisionTypes';
import { isSupportedSampleRate } from './EditBoundaryRefiner';
import { checkProposalProvenanceStaleness } from './EditProvenance';

const VALID_OPERATIONS = new Set<EditOperationType>([
  'REMOVE_FILLER',
  'SHORTEN_SILENCE',
  'REMOVE_ACCIDENTAL_REPETITION',
  'REVIEW_FALSE_START',
  'REVIEW_SELF_CORRECTION',
  'REVIEW_BREATH',
  'REVIEW_NON_VERBAL_EVENT',
  'NO_EDIT_RECOMMENDED',
]);

const DESTRUCTIVE_OPERATIONS = new Set<EditOperationType>([
  'REMOVE_FILLER',
  'SHORTEN_SILENCE',
  'REMOVE_ACCIDENTAL_REPETITION',
]);

/**
 * Valid human-review state transitions inside Mission 05.
 * Note: Transitioning to APPLIED is strictly disallowed in Mission 05.
 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<EditProposalStatus, readonly EditProposalStatus[]>
> = {
  PROPOSED: ['PROPOSED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'STALE', 'INVALID', 'SUPERSEDED'],
  NEEDS_REVIEW: ['NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'STALE', 'INVALID', 'SUPERSEDED'],
  APPROVED: ['APPROVED', 'NEEDS_REVIEW', 'REJECTED', 'STALE', 'SUPERSEDED'],
  REJECTED: ['REJECTED', 'NEEDS_REVIEW', 'STALE', 'SUPERSEDED'],
  STALE: ['STALE', 'REJECTED', 'SUPERSEDED'],
  INVALID: ['INVALID', 'REJECTED'],
  SUPERSEDED: ['SUPERSEDED'],
  APPLIED: ['APPLIED'],
};

/**
 * Comprehensive Edit Decision & EDL Validator (AVP-P05-001 Sections 12 & 13)
 * Produces explicit typed failures and never silently discards invalid proposals.
 */
export class EditDecisionValidator {
  public static validateSourceContext(context: EdlSourceContext): EditValidationFailure[] {
    const failures: EditValidationFailure[] = [];

    if (!context.projectId || context.projectId.trim().length === 0) {
      failures.push({
        code: 'MISSING_SOURCE_IDENTITY',
        severity: 'ERROR',
        message: 'Missing projectId in EDL source context.',
        actionableFix: 'Provide a non-empty projectId.',
      });
    }

    if (!context.sourceAudioId || context.sourceAudioId.trim().length === 0) {
      failures.push({
        code: 'MISSING_SOURCE_IDENTITY',
        severity: 'ERROR',
        message: 'Missing sourceAudioId in EDL source context.',
        actionableFix: 'Provide the canonical audio asset identifier.',
      });
    }

    if (!context.sourceAudioHash || context.sourceAudioHash.trim().length === 0) {
      failures.push({
        code: 'MISSING_SOURCE_IDENTITY',
        severity: 'ERROR',
        message: 'Missing sourceAudioHash in EDL source context.',
        actionableFix: 'Provide the content hash (SHA-256) of the original audio file.',
      });
    }

    if (!context.transcriptVersion || context.transcriptVersion.trim().length === 0) {
      failures.push({
        code: 'MISSING_TRANSCRIPT_VERSION',
        severity: 'ERROR',
        message: 'Missing transcriptVersion in EDL source context.',
        actionableFix: 'Specify the exact transcript version used for speech event analysis.',
      });
    }

    if (
      context.timebaseFlicksPerSecond !== undefined &&
      context.timebaseFlicksPerSecond !== FLICKS_PER_SECOND
    ) {
      failures.push({
        code: 'INVALID_TIMEBASE',
        severity: 'ERROR',
        message: `Invalid timebase ${String(context.timebaseFlicksPerSecond)}; expected ${FLICKS_PER_SECOND} Flicks/sec.`,
        actionableFix: `Use canonical FLICKS_PER_SECOND (${FLICKS_PER_SECOND}).`,
      });
    }

    if (!isSupportedSampleRate(context.sampleRate)) {
      failures.push({
        code: 'INVALID_SAMPLE_RATE',
        severity: 'ERROR',
        message: `Unsupported sample rate: ${String(context.sampleRate)}.`,
        actionableFix: 'Use a supported canonical sample rate (16000..96000 Hz).',
      });
    }

    if (
      !Number.isInteger(context.totalSourceSamples) ||
      context.totalSourceSamples <= 0
    ) {
      failures.push({
        code: 'INVALID_SAMPLE_POSITIONS',
        severity: 'ERROR',
        message: `Invalid totalSourceSamples: ${String(context.totalSourceSamples)}.`,
        actionableFix: 'Provide a positive integer source audio sample count.',
      });
    }

    return failures;
  }

  public static validateStateTransition(
    fromStatus: EditProposalStatus,
    toStatus: EditProposalStatus,
    proposalId: string,
  ): EditValidationFailure | null {
    if (toStatus === 'APPLIED') {
      return {
        code: 'INVALID_STATE_TRANSITION',
        severity: 'ERROR',
        proposalId,
        message: 'Proposals cannot transition to APPLIED in EditDecisionEngine (Mission 05 generates proposals only).',
        actionableFix: 'Hand off an ApplicationReadyEditPlan to Mission 06 rendering/transaction execution.',
      };
    }

    const allowed = ALLOWED_STATUS_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      return {
        code: 'INVALID_STATE_TRANSITION',
        severity: 'ERROR',
        proposalId,
        message: `Illegal proposal state transition from ${fromStatus} to ${toStatus}.`,
        actionableFix: `Only transitions to [${allowed.join(', ')}] are permitted from ${fromStatus}.`,
      };
    }
    return null;
  }

  public static validateProposal(
    proposal: EditProposal,
    totalSourceSamples: number,
    conflicts: readonly EditConflictRecord[] = [],
  ): EditValidationFailure[] {
    const failures: EditValidationFailure[] = [];

    if (!proposal.sourceAudioId || !proposal.sourceAudioHash || !proposal.projectId) {
      failures.push({
        code: 'MISSING_SOURCE_IDENTITY',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: 'Proposal is missing projectId, sourceAudioId, or sourceAudioHash.',
        actionableFix: 'Attach complete source identity metadata to the proposal.',
      });
    }

    if (!proposal.transcriptVersion || proposal.transcriptVersion.trim().length === 0) {
      failures.push({
        code: 'MISSING_TRANSCRIPT_VERSION',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: 'Proposal is missing transcriptVersion.',
        actionableFix: 'Bind proposal to an explicit transcript version.',
      });
    }

    if (
      !proposal.speechEventSourceIds ||
      proposal.speechEventSourceIds.length === 0 ||
      !proposal.eventDetectorVersion
    ) {
      failures.push({
        code: 'MISSING_EVENT_PROVENANCE',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: 'Proposal lacks traceable speechEventSourceIds or eventDetectorVersion.',
        actionableFix: 'Preserve upstream SpeechEvent IDs and detector version in provenance.',
      });
    }

    if (proposal.timebaseFlicksPerSecond !== FLICKS_PER_SECOND) {
      failures.push({
        code: 'INVALID_TIMEBASE',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: `Proposal timebase ${proposal.timebaseFlicksPerSecond} != ${FLICKS_PER_SECOND}.`,
        actionableFix: 'Recompute proposal intervals on canonical Flicks timebase.',
      });
    }

    if (!isSupportedSampleRate(proposal.sampleRate)) {
      failures.push({
        code: 'INVALID_SAMPLE_RATE',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: `Invalid proposal sampleRate: ${String(proposal.sampleRate)}.`,
        actionableFix: 'Use a supported sample rate.',
      });
    }

    if (!VALID_OPERATIONS.has(proposal.operation)) {
      failures.push({
        code: 'UNSUPPORTED_OPERATION',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: `Unsupported edit operation: ${String(proposal.operation)}.`,
        actionableFix: 'Map proposal to one of the 8 canonical EditOperationType values.',
      });
    }

    // Validate original & proposed integer sample coordinates
    if (!proposal.boundary.valid || !proposal.originalRange) {
      failures.push({
        code: this.classifyBoundaryRejectionCode(proposal.boundary.rejectionReason),
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: proposal.boundary.rejectionReason ?? 'Original boundary coordinates are invalid.',
        actionableFix: 'Reject or repair out-of-range/reversed source coordinates.',
      });
    } else {
      failures.push(
        ...this.validateSampleInterval(
          proposal.originalRange.startSample,
          proposal.originalRange.endSample,
          totalSourceSamples,
          proposal.proposalId,
          'originalRange',
        ),
      );
    }

    if (proposal.proposedRange) {
      failures.push(
        ...this.validateSampleInterval(
          proposal.proposedRange.startSample,
          proposal.proposedRange.endSample,
          totalSourceSamples,
          proposal.proposalId,
          'proposedRange',
        ),
      );
    } else if (DESTRUCTIVE_OPERATIONS.has(proposal.operation) && proposal.status !== 'INVALID') {
      failures.push({
        code: 'INVALID_SAMPLE_POSITIONS',
        severity: 'WARNING',
        proposalId: proposal.proposalId,
        message:
          'Destructive proposal has no safe proposed sample range after applying safety margins.',
        actionableFix: 'Require human boundary revision or mark NO_EDIT_RECOMMENDED.',
      });
    }

    if (proposal.status === 'STALE') {
      failures.push({
        code: 'STALE_PROPOSAL',
        severity: 'ERROR',
        proposalId: proposal.proposalId,
        message: 'Proposal is STALE due to source, transcript, alignment, or detector version drift.',
        actionableFix: 'Regenerate EDL against the current source and transcript versions.',
      });
    }

    // Conflict checks
    const relatedConflicts = conflicts.filter((c) =>
      c.involvedProposalIds.includes(proposal.proposalId),
    );
    for (const conf of relatedConflicts) {
      if (!conf.resolved && conf.blockedProposalIds.includes(proposal.proposalId)) {
        failures.push({
          code:
            conf.type === 'BREATH_INSIDE_SILENCE' || conf.type === 'PROTECTED_EVENT_OVERLAP'
              ? 'PROTECTED_EVENT_OVERLAP'
              : 'UNRESOLVED_CONFLICT',
          severity: 'ERROR',
          proposalId: proposal.proposalId,
          message: conf.reason,
          actionableFix: 'Resolve conflict via human review or revise non-overlapping boundaries.',
        });
      }
    }

    return failures;
  }

  public static validateEdlSnapshot(edl: EditDecisionListSnapshot): EdlValidationSummary {
    const failures: EditValidationFailure[] = [];

    if (edl.edlSchemaVersion !== EDL_SCHEMA_VERSION) {
      failures.push({
        code: 'INCOMPATIBLE_EDL_VERSION',
        severity: 'ERROR',
        message: `EDL schema version "${edl.edlSchemaVersion}" is incompatible with "${EDL_SCHEMA_VERSION}".`,
        actionableFix: 'Regenerate EDL with current schema version.',
      });
    }

    failures.push(
      ...this.validateSourceContext({
        projectId: edl.projectId,
        sourceAudioId: edl.sourceAudioId,
        sourceAudioHash: edl.sourceAudioHash,
        transcriptVersion: edl.transcriptVersion,
        sampleRate: edl.sampleRate,
        totalSourceSamples: edl.totalSourceSamples,
        timebaseFlicksPerSecond: edl.timebaseFlicksPerSecond,
      }),
    );

    const seenActiveIds = new Set<string>();
    for (const prop of edl.proposals) {
      if (prop.status !== 'SUPERSEDED') {
        if (seenActiveIds.has(prop.proposalId)) {
          failures.push({
            code: 'DUPLICATE_PROPOSAL_ID',
            severity: 'ERROR',
            proposalId: prop.proposalId,
            message: `Duplicate active proposalId "${prop.proposalId}" in EDL.`,
            actionableFix: 'Deduplicate or supersede duplicate proposal records.',
          });
        }
        seenActiveIds.add(prop.proposalId);
      }

      if (prop.status !== 'SUPERSEDED' && prop.status !== 'REJECTED') {
        failures.push(...this.validateProposal(prop, edl.totalSourceSamples, edl.conflicts));
      }
    }

    const errorCount = failures.filter((f) => f.severity === 'ERROR').length;
    const warningCount = failures.filter((f) => f.severity === 'WARNING').length;

    let status: EditValidationStatus = 'VALID';
    if (failures.some((f) => f.code === 'STALE_PROPOSAL')) {
      status = 'STALE';
    } else if (errorCount > 0) {
      status = 'INVALID';
    } else if (warningCount > 0) {
      status = 'WARNING';
    }

    return {
      isValid: errorCount === 0,
      status,
      errorCount,
      warningCount,
      failures,
    };
  }

  /**
   * Validates Mission 06 application preconditions & PostEditValidationEngine invariants
   * on a read-only dry-run projection without mutating the ProjectDocument or audio.
   */
  public static validateForApplication(params: {
    readonly edl: EditDecisionListSnapshot;
    readonly projectDoc: ProjectDocument;
    readonly expectedSourceAudioHash: string;
    readonly expectedTranscriptVersion: string;
    readonly expectedEdlVersion: number;
    readonly proposalIds?: readonly string[];
    readonly nowMs?: number;
  }): ApplicationReadyEditPlan {
    const {
      edl,
      projectDoc,
      expectedSourceAudioHash,
      expectedTranscriptVersion,
      expectedEdlVersion,
    } = params;
    const nowMs = params.nowMs ?? Date.now();
    const blockingFailures: EditValidationFailure[] = [];
    const postEditWarnings: string[] = [];

    if (edl.sourceAudioHash !== expectedSourceAudioHash) {
      blockingFailures.push({
        code: 'STALE_PROPOSAL',
        severity: 'ERROR',
        message: `Source audio hash mismatch: EDL=${edl.sourceAudioHash}, active=${expectedSourceAudioHash}.`,
        actionableFix: 'Regenerate EDL for the active source audio file.',
      });
    }

    if (edl.transcriptVersion !== expectedTranscriptVersion) {
      blockingFailures.push({
        code: 'STALE_PROPOSAL',
        severity: 'ERROR',
        message: `Transcript version mismatch: EDL=${edl.transcriptVersion}, active=${expectedTranscriptVersion}.`,
        actionableFix: 'Revalidate or regenerate EDL against the latest transcript version.',
      });
    }

    if (edl.edlVersion !== expectedEdlVersion) {
      blockingFailures.push({
        code: 'INCOMPATIBLE_EDL_VERSION',
        severity: 'ERROR',
        message: `EDL version mismatch: snapshot v${edl.edlVersion} != expected v${expectedEdlVersion}.`,
        actionableFix: 'Load the latest immutable EDL snapshot before preparing application.',
      });
    }

    const candidateProposals = params.proposalIds
      ? edl.proposals.filter((p) => params.proposalIds!.includes(p.proposalId))
      : edl.proposals.filter((p) => p.status === 'APPROVED');

    const protectedIntervals = edl.proposals.filter(
      (p) => p.protectedEvent && p.originalRange !== null,
    );

    const readyItems: ApplicationReadyEditItem[] = [];
    const acceptedRangesByTrack = new Map<
      string,
      Array<{ proposalId: string; startSample: number; endSample: number }>
    >();

    for (const prop of candidateProposals) {
      if (prop.status !== 'APPROVED') {
        blockingFailures.push({
          code: 'PROPOSAL_NOT_APPROVED',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal ${prop.proposalId} has status "${prop.status}" and is not APPROVED.`,
          actionableFix: 'Explicitly approve the proposal through human review before application.',
        });
        continue;
      }

      if (!DESTRUCTIVE_OPERATIONS.has(prop.operation)) {
        blockingFailures.push({
          code: 'UNSUPPORTED_OPERATION',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Review-only or no-edit operation "${prop.operation}" cannot be applied as an audio edit.`,
          actionableFix: 'Only REMOVE_FILLER, SHORTEN_SILENCE, or REMOVE_ACCIDENTAL_REPETITION can be applied.',
        });
        continue;
      }

      // Provenance staleness check
      const stale = checkProposalProvenanceStaleness(prop, {
        sourceAudioHash: expectedSourceAudioHash,
        transcriptVersion: expectedTranscriptVersion,
      });
      if (stale.isStale) {
        blockingFailures.push({
          code: 'STALE_PROPOSAL',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: stale.reasons.join(' '),
          actionableFix: 'Regenerate proposal against the active source and transcript versions.',
        });
        continue;
      }

      if (prop.risk.overallLevel === 'CRITICAL' || prop.risk.overallLevel === 'UNKNOWN') {
        blockingFailures.push({
          code: 'CRITICAL_OR_UNKNOWN_RISK',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal ${prop.proposalId} carries ${prop.risk.overallLevel} risk and cannot be applied safely.`,
          actionableFix: 'Inspect blocking risk dimensions and revise boundaries or reject proposal.',
        });
        continue;
      }

      // Unresolved conflict check
      const unresolved = edl.conflicts.filter(
        (c) => !c.resolved && c.involvedProposalIds.includes(prop.proposalId),
      );
      if (unresolved.length > 0) {
        blockingFailures.push({
          code: 'UNRESOLVED_CONFLICT',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal ${prop.proposalId} has ${unresolved.length} unresolved conflict(s): ${unresolved.map((u) => u.type).join(', ')}.`,
          actionableFix: 'Resolve or reject conflicting proposals before application.',
        });
        continue;
      }

      // Coordinate check
      if (!prop.originalRange || !prop.proposedRange) {
        blockingFailures.push({
          code: 'INVALID_SAMPLE_POSITIONS',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal ${prop.proposalId} lacks valid integer source coordinates.`,
          actionableFix: 'Revise proposal boundaries within source audio sample range.',
        });
        continue;
      }

      const coordErrors = this.validateSampleInterval(
        prop.proposedRange.startSample,
        prop.proposedRange.endSample,
        edl.totalSourceSamples,
        prop.proposalId,
        'proposedRange',
      );
      if (coordErrors.length > 0) {
        blockingFailures.push(...coordErrors);
        continue;
      }

      // Protected event overlap check
      const hitsProtected = protectedIntervals.find(
        (prot) =>
          prot.proposalId !== prop.proposalId &&
          prot.trackId === prop.trackId &&
          prot.originalRange !== null &&
          Math.min(prot.originalRange.endSample, prop.proposedRange!.endSample) >
            Math.max(prot.originalRange.startSample, prop.proposedRange!.startSample),
      );
      if (hitsProtected) {
        blockingFailures.push({
          code: 'PROTECTED_EVENT_OVERLAP',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposed removal overlaps protected event ${hitsProtected.proposalId} (${hitsProtected.eventCategory}).`,
          actionableFix: 'Retract boundaries around the protected breath/non-verbal/meaningful span.',
        });
        continue;
      }

      // Duplicate/overlapping source sample removal check across approved proposals
      const trackAccepted = acceptedRangesByTrack.get(prop.trackId) ?? [];
      const dupOverlap = trackAccepted.find(
        (prev) =>
          Math.min(prev.endSample, prop.proposedRange!.endSample) >
          Math.max(prev.startSample, prop.proposedRange!.startSample),
      );
      if (dupOverlap) {
        blockingFailures.push({
          code: 'DUPLICATE_SOURCE_REMOVAL',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal ${prop.proposalId} removes source samples already targeted by approved proposal ${dupOverlap.proposalId}.`,
          actionableFix: 'Reject one of the overlapping proposals or revise boundaries to be disjoint.',
        });
        continue;
      }
      trackAccepted.push({
        proposalId: prop.proposalId,
        startSample: prop.proposedRange.startSample,
        endSample: prop.proposedRange.endSample,
      });
      acceptedRangesByTrack.set(prop.trackId, trackAccepted);

      // Construct undo/redo metadata for Mission 06 without mutating projectDoc
      const targetTrack = projectDoc.tracks.find((t) => t.id === prop.trackId);
      const hasSiblingSyncTracks = Boolean(
        targetTrack?.syncGroupId &&
          projectDoc.tracks.some(
            (t) =>
              t.id !== prop.trackId &&
              t.syncGroupId === targetTrack.syncGroupId &&
              !t.muted,
          ),
      );

      const cutStrategy = hasSiblingSyncTracks ? 'IN_PLACE_ROOM_TONE' : 'GLOBAL_SYNC_RIPPLE';
      const fadeFlicks = TimeMath.secondsToFlicks(0.01); // 10ms equal-power micro-fade

      readyItems.push({
        proposalId: prop.proposalId,
        proposalVersion: prop.proposalVersion,
        trackId: prop.trackId,
        operation: prop.operation as ApplicationReadyEditItem['operation'],
        originalRange: prop.originalRange,
        proposedRange: prop.proposedRange,
        provenance: prop.provenance,
        undoMetadata: {
          operationIdHint: `edl_tx_${edl.edlId}_v${edl.edlVersion}_${prop.proposalId}`,
          expectedProjectRevision: projectDoc.revision,
          expectedSourceAudioHash: expectedSourceAudioHash,
          expectedTranscriptVersion: expectedTranscriptVersion,
          expectedEdlVersion: expectedEdlVersion,
          sourceInterval: prop.originalRange,
          proposedInterval: prop.proposedRange,
          timelineRangeFlicks: {
            start: prop.proposedRange.startFlicks,
            end: prop.proposedRange.endFlicks,
          },
          cutStrategy,
          fadeInDurationFlicks: fadeFlicks,
          fadeOutDurationFlicks: fadeFlicks,
          injectRoomToneFlicks:
            cutStrategy === 'IN_PLACE_ROOM_TONE'
              ? prop.proposedRange.endFlicks - prop.proposedRange.startFlicks
              : TimeMath.secondsToFlicks(0.05),
          prosodicWarnings: prop.boundary.warnings.some((w) => w.includes('Ezafe'))
            ? ['TRAILING_EZAFE_RISK']
            : [],
          affectedTokenIds: prop.relatedTokenIds,
          reversible: true,
        },
      });
    }

    // Read-only PostEditValidationEngine dry-run check on cloned ProjectDocument (NEVER mutates input projectDoc)
    if (readyItems.length > 0 && blockingFailures.length === 0) {
      const simulatedDoc = this.simulateDryRunTimeline(projectDoc, readyItems);
      const postCheck = PostEditValidationEngine.validateProjectTimeline(simulatedDoc);
      if (!postCheck.isValid) {
        for (const issue of postCheck.issues) {
          if (
            issue.issueCode === 'ORPHAN_MICRO_SLIVER_CLIP' ||
            issue.issueCode === 'OVERLAPPING_TIMELINE_CLIPS' ||
            issue.issueCode === 'SYNC_GROUP_DURATION_DRIFT'
          ) {
            blockingFailures.push({
              code: 'POST_EDIT_VALIDATION_FAILED',
              severity: 'ERROR',
              message: `Dry-run PostEditValidation failed (${issue.issueCode}) on track ${issue.trackId} at ${issue.timeSeconds}s: ${issue.messageFa}`,
              actionableFix: 'Adjust edit boundaries to avoid micro-slivers (<15ms), clip overlaps, or sync drift.',
            });
          } else {
            postEditWarnings.push(
              `[${issue.issueCode}] track=${issue.trackId} @ ${issue.timeSeconds}s: ${issue.messageFa}`,
            );
          }
        }
      }
    }

    return {
      readyToApply: blockingFailures.length === 0 && readyItems.length > 0,
      edlId: edl.edlId,
      edlVersion: edl.edlVersion,
      projectId: edl.projectId,
      sourceAudioHash: edl.sourceAudioHash,
      transcriptVersion: edl.transcriptVersion,
      validatedAtMs: nowMs,
      items: readyItems,
      blockingFailures,
      postEditWarnings,
      executed: false,
    };
  }

  /**
   * Read-only timeline projection on a deep clone strictly for PostEditValidationEngine dry-run checking.
   * Never modifies the caller's ProjectDocument or audio.
   */
  private static simulateDryRunTimeline(
    doc: ProjectDocument,
    items: readonly ApplicationReadyEditItem[],
  ): ProjectDocument {
    // Sort cuts descending by startFlicks so earlier cuts never invalidate later dry-run coordinates
    const clonedTracks: TimelineTrack[] = structuredClone(doc.tracks);
    const sortedDesc = [...items].sort(
      (a, b) => b.proposedRange.startFlicks - a.proposedRange.startFlicks,
    );

    const applyCutToClips = (
      clips: TimelineClip[],
      trackId: string,
      item: ApplicationReadyEditItem,
    ): TimelineClip[] => {
      const cutStart = item.proposedRange.startFlicks;
      const cutEnd = item.proposedRange.endFlicks;
      const cutDur = cutEnd - cutStart;
      const isInPlaceRoomTone = item.undoMetadata.cutStrategy === 'IN_PLACE_ROOM_TONE';
      const fade = item.undoMetadata.fadeInDurationFlicks;
      const nextClips: TimelineClip[] = [];
      let roomToneInserted = false;

      for (const clip of clips) {
        if (clip.timelineRange.end <= cutStart) {
          nextClips.push(clip);
          continue;
        }
        if (clip.timelineRange.start >= cutEnd) {
          nextClips.push(
            isInPlaceRoomTone
              ? clip
              : {
                  ...clip,
                  timelineRange: {
                    start: clip.timelineRange.start - cutDur,
                    end: clip.timelineRange.end - cutDur,
                  },
                },
          );
          continue;
        }
        if (clip.timelineRange.start < cutStart) {
          const leftDur = cutStart - clip.timelineRange.start;
          const safeFadeOut = Math.min(fade, Math.floor(leftDur / 2));
          nextClips.push({
            ...clip,
            id: `${clip.id}_simL`,
            sourceRange: {
              start: clip.sourceRange.start,
              end: clip.sourceRange.start + leftDur,
            },
            timelineRange: { start: clip.timelineRange.start, end: cutStart },
            fadeOutFlicks: safeFadeOut,
          });
        }
        if (isInPlaceRoomTone && !roomToneInserted && cutDur > 0) {
          roomToneInserted = true;
          const safeRtFade = Math.min(fade, Math.floor(cutDur / 2));
          nextClips.push({
            id: `sim_rt_${trackId}_${cutStart}`,
            trackId,
            kind: 'ROOM_TONE_FILL',
            assetId: clip.assetId,
            sourceRange: { start: 0, end: cutDur },
            timelineRange: { start: cutStart, end: cutEnd },
            fadeInFlicks: safeRtFade,
            fadeOutFlicks: safeRtFade,
            gainDb: 0,
          });
        }
        if (clip.timelineRange.end > cutEnd) {
          const rightDur = clip.timelineRange.end - cutEnd;
          const safeFadeIn = Math.min(fade, Math.floor(rightDur / 2));
          nextClips.push({
            ...clip,
            id: `${clip.id}_simR`,
            sourceRange: {
              start: clip.sourceRange.end - rightDur,
              end: clip.sourceRange.end,
            },
            timelineRange: {
              start: isInPlaceRoomTone ? cutEnd : cutStart,
              end: isInPlaceRoomTone ? clip.timelineRange.end : cutStart + rightDur,
            },
            fadeInFlicks: safeFadeIn,
          });
        }
      }

      return nextClips;
    };

    for (const item of sortedDesc) {
      const targetTrack = clonedTracks.find((t) => t.id === item.trackId);
      if (!targetTrack) continue;
      const syncGroupId =
        item.undoMetadata.cutStrategy === 'GLOBAL_SYNC_RIPPLE' ? targetTrack.syncGroupId : null;

      for (let tIdx = 0; tIdx < clonedTracks.length; tIdx++) {
        const track = clonedTracks[tIdx];
        const affected =
          track.id === targetTrack.id ||
          (syncGroupId !== null && track.syncGroupId === syncGroupId);
        if (!affected) continue;
        clonedTracks[tIdx] = {
          ...track,
          clips: applyCutToClips(track.clips, track.id, item),
        };
      }
    }

    return {
      ...doc,
      tracks: clonedTracks,
    };
  }

  private static validateSampleInterval(
    startSample: number,
    endSample: number,
    totalSourceSamples: number,
    proposalId: string,
    fieldName: string,
  ): EditValidationFailure[] {
    const failures: EditValidationFailure[] = [];

    if (
      !Number.isFinite(startSample) ||
      !Number.isFinite(endSample) ||
      !Number.isInteger(startSample) ||
      !Number.isInteger(endSample) ||
      startSample < 0 ||
      endSample < 0
    ) {
      failures.push({
        code: 'INVALID_SAMPLE_POSITIONS',
        severity: 'ERROR',
        proposalId,
        message: `${fieldName} contains negative, non-integer, or non-finite sample coordinates (${startSample}, ${endSample}).`,
        actionableFix: 'Use non-negative integer sample positions.',
      });
      return failures;
    }

    if (startSample >= endSample) {
      failures.push({
        code: 'START_GTE_END',
        severity: 'ERROR',
        proposalId,
        message: `${fieldName} has startSample (${startSample}) >= endSample (${endSample}).`,
        actionableFix: 'Ensure endSample is strictly greater than startSample.',
      });
    }

    if (endSample > totalSourceSamples) {
      failures.push({
        code: 'OUT_OF_RANGE_COORDINATES',
        severity: 'ERROR',
        proposalId,
        message: `${fieldName} endSample (${endSample}) exceeds totalSourceSamples (${totalSourceSamples}).`,
        actionableFix: 'Clamp or reject coordinates outside original audio bounds.',
      });
    }

    return failures;
  }

  private static classifyBoundaryRejectionCode(reason?: string): EditValidationFailure['code'] {
    if (!reason) return 'INVALID_SAMPLE_POSITIONS';
    if (reason.includes('Reversed') || reason.includes('zero-length')) return 'START_GTE_END';
    if (reason.includes('exceed source length')) return 'OUT_OF_RANGE_COORDINATES';
    if (reason.includes('sample rate')) return 'INVALID_SAMPLE_RATE';
    return 'INVALID_SAMPLE_POSITIONS';
  }
}
