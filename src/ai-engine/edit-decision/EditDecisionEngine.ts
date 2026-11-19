import { FLICKS_PER_SECOND, SampleIndex } from '../../contracts/timebase.contract';
import { ProjectDocument } from '../../contracts/project-schema.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../../runtime/memory/MemoryBudgetManager';
import { PERSIAN_FILLER_LEXICON_VERSION } from '../PersianDisfluencyEngine';
import {
  SPEECH_EVENT_ENGINE_VERSION,
  SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
  SpeechEvent,
} from '../speech-events/SpeechEventContracts';
import {
  ApplicationReadyEditPlan,
  EDL_SCHEMA_VERSION,
  EDIT_DECISION_ENGINE_VERSION,
  EditDecisionGenerationRequest,
  EditDecisionHistoryEntry,
  EditDecisionListSnapshot,
  EditEvidenceReference,
  EditProposal,
  EditProposalStatus,
  EditValidationFailure,
} from './EditDecisionTypes';
import {
  createSourceSampleInterval,
  EditBoundaryRefiner,
  isSupportedSampleRate,
  normalizeTokensToSampleSpans,
} from './EditBoundaryRefiner';
import { EditCandidateEvaluator } from './EditCandidateEvaluator';
import { EditConflictResolver } from './EditConflictResolver';
import { EditDecisionValidator } from './EditDecisionValidator';
import {
  buildDeterministicEdlId,
  buildDeterministicProposalId,
  checkProposalProvenanceStaleness,
  deepFreeze,
  deterministicHexHash,
} from './EditProvenance';
import { EditRiskEvaluator } from './EditRiskEvaluator';

export interface HumanDecisionResult {
  readonly ok: boolean;
  readonly snapshot: EditDecisionListSnapshot;
  readonly updatedProposal: EditProposal | null;
  readonly failure: EditValidationFailure | null;
}

/**
 * Risk-Aware Edit Decision Engine & Immutable EDL Manager (AVP-P05-001)
 *
 * Converts Mission 04 SpeechEvents into immutable, versioned, evidence-backed
 * Edit Decision List (EDL) snapshots with integer source-sample coordinates,
 * multi-dimensional risk evaluation, deterministic conflict resolution,
 * human-review lifecycle, and Mission 06 application-readiness validation.
 *
 * CRITICAL GUARANTEE:
 * - Never deletes or modifies audio.
 * - Never rewrites raw transcript text.
 * - Never automatically approves or applies edits.
 */
export class EditDecisionEngine {
  /**
   * Generates an immutable, deterministic EditDecisionListSnapshot from SpeechEvents
   * in bounded metadata batches under MemoryBudgetManager and AbortSignal governance.
   */
  public static async generateEdl(
    request: EditDecisionGenerationRequest,
    memoryBudgetManager?: MemoryBudgetManager,
  ): Promise<EditDecisionListSnapshot> {
    const { context, events } = request;
    const rawNowMs = request.nowMs ?? Date.now();
    const nowMs = Number.isFinite(rawNowMs) ? Math.trunc(rawNowMs) : Date.now();
    const rawBatchSize = request.batchSize ?? 64;
    const batchSize =
      Number.isFinite(rawBatchSize) && rawBatchSize > 0
        ? Math.max(1, Math.min(256, Math.trunc(rawBatchSize)))
        : 64;
    const budget = memoryBudgetManager ?? getSharedMemoryBudgetManager();

    const contextFailures = EditDecisionValidator.validateSourceContext(context);
    const edlId = buildDeterministicEdlId(context);

    const detectorVersion =
      context.eventDetectorVersion ??
      events[0]?.provenance.engineVersion ??
      SPEECH_EVENT_ENGINE_VERSION;
    const lexiconVersion = context.lexiconVersion ?? PERSIAN_FILLER_LEXICON_VERSION;
    const thresholdConfigVersion =
      context.thresholdConfigVersion ??
      events[0]?.provenance.thresholdConfigVersion ??
      SPEECH_EVENT_THRESHOLD_CONFIG_VERSION;
    const modelVersions: Record<string, string> = { ...(context.modelVersions ?? {}) };
    for (const ev of events) {
      if (ev.provenance.modelId) {
        modelVersions[ev.provenance.modelId] = ev.provenance.modelVersion ?? 'unknown';
      }
    }

    // If the source context itself is invalid (e.g. missing hash / invalid sample rate),
    // return an explicitly INVALID EDL rather than silently returning an empty valid EDL.
    if (contextFailures.length > 0) {
      return deepFreeze({
        edlId,
        edlSchemaVersion: EDL_SCHEMA_VERSION,
        edlVersion: 1,
        projectId: context.projectId ?? '',
        sourceAudioId: context.sourceAudioId ?? '',
        sourceAudioHash: context.sourceAudioHash ?? '',
        transcriptVersion: context.transcriptVersion ?? '',
        alignmentVersion: context.alignmentVersion,
        timebaseFlicksPerSecond: FLICKS_PER_SECOND,
        sampleRate: isSupportedSampleRate(context.sampleRate) ? context.sampleRate : 48000,
        channelLayout: context.channelLayout,
        totalSourceSamples: Number.isFinite(context.totalSourceSamples)
          ? Math.max(0, Math.trunc(context.totalSourceSamples))
          : 0,
        eventSourceVersions: {
          eventDetectorVersion: detectorVersion,
          decisionEngineVersion: EDIT_DECISION_ENGINE_VERSION,
          lexiconVersion,
          thresholdConfigVersion,
          modelVersions,
        },
        proposals: [],
        conflicts: [],
        validation: {
          isValid: false,
          status: 'INVALID',
          errorCount: contextFailures.filter((f) => f.severity === 'ERROR').length,
          warningCount: contextFailures.filter((f) => f.severity === 'WARNING').length,
          failures: contextFailures,
        },
        decisionHistory: [],
        createdAtMs: nowMs,
        modifiedAtMs: nowMs,
        cancelled: false,
        processedEventCount: 0,
        totalInputEventCount: events.length,
        persistenceStatus: 'IN_MEMORY_ONLY',
        persistenceNote:
          'EDL generation rejected due to invalid source context; snapshot kept in memory only.',
      });
    }

    // Normalize tokens to read-only sample spans (never mutating caller tokens)
    const tokenSpans = normalizeTokensToSampleSpans(request.tokens, context.sampleRate);

    // Deterministic event ordering independent of batch size
    const orderedEvents: SpeechEvent[] = [...events].sort((a, b) => {
      if (a.trackId !== b.trackId) return a.trackId.localeCompare(b.trackId);
      const aStart = Number.isFinite(a.startSec) ? a.startSec : Number.MAX_SAFE_INTEGER;
      const bStart = Number.isFinite(b.startSec) ? b.startSec : Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;
      return a.eventId.localeCompare(b.eventId);
    });

    const rawProposals: EditProposal[] = [];
    let processedEventCount = 0;
    let cancelled = false;

    for (let offset = 0; offset < orderedEvents.length; offset += batchSize) {
      if (request.signal?.aborted) {
        cancelled = true;
        break;
      }

      const batch = orderedEvents.slice(offset, offset + batchSize);
      // Bounded metadata-only reservation (~2KB per candidate metadata record, never PCM)
      const estBytes = Math.max(1024, batch.length * 2048);
      let reservation: MemoryReservation | null = null;

      try {
        reservation = budget.reserve({
          owner: `edit-decision:${edlId}:batch-${offset}`,
          category: 'other',
          bytes: estBytes,
          priority: 'normal',
        });

        for (const event of batch) {
          if (request.signal?.aborted) {
            cancelled = true;
            break;
          }

          const proposal = this.evaluateSingleEvent({
            event,
            allEvents: orderedEvents,
            tokenSpans,
            context,
            eventTranscriptVersion:
              request.eventTranscriptVersions?.[event.eventId] ?? context.transcriptVersion,
            detectorVersion,
            lexiconVersion,
            thresholdConfigVersion,
            modelVersions,
            nowMs,
          });
          rawProposals.push(proposal);
          processedEventCount++;
        }
      } finally {
        if (reservation) budget.release(reservation);
      }

      // Cooperative yield on large batches so UI thread is never blocked
      if (offset + batchSize < orderedEvents.length && !request.signal?.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // Deterministic overlap & conflict resolution
    const conflictResult = EditConflictResolver.resolve({
      proposals: rawProposals,
      expectedTranscriptVersion: context.transcriptVersion,
      signal: request.signal,
    });
    if (conflictResult.cancelled) {
      cancelled = true;
    }

    // Re-evaluate per-proposal validation issues & status with conflict info attached
    const finalizedProposals: EditProposal[] = conflictResult.proposals.map((prop) => {
      const propConflicts = conflictResult.conflicts.filter((c) =>
        c.involvedProposalIds.includes(prop.proposalId),
      );
      const overlapsProtected = propConflicts.some(
        (c) => c.type === 'BREATH_INSIDE_SILENCE' || c.type === 'PROTECTED_EVENT_OVERLAP',
      );
      const isStaleVersion = prop.transcriptVersion !== context.transcriptVersion;

      // Refresh risk dimensions if conflicts or staleness were discovered during conflict resolution
      let updatedRisk = prop.risk;
      if (propConflicts.length > 0 || isStaleVersion) {
        const sourceEv = orderedEvents.find((e) => e.eventId === prop.speechEventSourceIds[0]);
        if (sourceEv) {
          updatedRisk = EditRiskEvaluator.evaluate({
            event: sourceEv,
            operation: prop.operation,
            boundary: prop.boundary,
            tokenSpans,
            overlappingEventCount: propConflicts.filter((c) => c.type !== 'ADJACENT_INTERVAL')
              .length,
            overlapsProtectedEvent: overlapsProtected,
            isStale: isStaleVersion,
            stalenessReasons: isStaleVersion
              ? [`Event transcriptVersion=${prop.transcriptVersion} != active=${context.transcriptVersion}`]
              : [],
          });
        }
      }

      const propWithRisk: EditProposal = {
        ...prop,
        risk: updatedRisk,
        requiresHumanReview: prop.requiresHumanReview || updatedRisk.mandatoryHumanReview,
      };

      const issues = EditDecisionValidator.validateProposal(
        propWithRisk,
        context.totalSourceSamples,
        conflictResult.conflicts,
      );
      const hasErrors = issues.some((i) => i.severity === 'ERROR');
      const hasWarnings = issues.some((i) => i.severity === 'WARNING');

      let finalStatus = propWithRisk.status;
      if (isStaleVersion) {
        finalStatus = 'STALE';
      } else if (!propWithRisk.boundary.valid) {
        finalStatus = 'INVALID';
      } else if (
        finalStatus === 'PROPOSED' &&
        (propWithRisk.requiresHumanReview || updatedRisk.mandatoryHumanReview || hasWarnings)
      ) {
        finalStatus = 'NEEDS_REVIEW';
      }

      const validationStatus =
        finalStatus === 'STALE'
          ? 'STALE'
          : hasErrors
            ? 'INVALID'
            : hasWarnings
              ? 'WARNING'
              : 'VALID';

      return {
        ...propWithRisk,
        status: finalStatus,
        validationStatus,
        validationIssues: issues,
      };
    });

    const draftEdl: EditDecisionListSnapshot = {
      edlId,
      edlSchemaVersion: EDL_SCHEMA_VERSION,
      edlVersion: 1,
      projectId: context.projectId,
      sourceAudioId: context.sourceAudioId,
      sourceAudioHash: context.sourceAudioHash,
      transcriptVersion: context.transcriptVersion,
      alignmentVersion: context.alignmentVersion,
      timebaseFlicksPerSecond: FLICKS_PER_SECOND,
      sampleRate: context.sampleRate,
      channelLayout: context.channelLayout,
      totalSourceSamples: context.totalSourceSamples,
      eventSourceVersions: {
        eventDetectorVersion: detectorVersion,
        decisionEngineVersion: EDIT_DECISION_ENGINE_VERSION,
        lexiconVersion,
        thresholdConfigVersion,
        modelVersions,
      },
      proposals: finalizedProposals,
      conflicts: conflictResult.conflicts,
      validation: {
        isValid: true,
        status: 'UNVALIDATED',
        errorCount: 0,
        warningCount: 0,
        failures: [],
      },
      decisionHistory: [],
      createdAtMs: nowMs,
      modifiedAtMs: nowMs,
      cancelled,
      processedEventCount,
      totalInputEventCount: orderedEvents.length,
      persistenceStatus: 'IN_MEMORY_ONLY',
      persistenceNote: 'Immutable EDL snapshot created in memory; call persistEdlSnapshotLocally() for durable storage.',
    };

    const validation = EditDecisionValidator.validateEdlSnapshot(draftEdl);

    return deepFreeze({
      ...draftEdl,
      validation,
    });
  }

  /**
   * Explicitly approves a proposal (NEVER executes audio deletion or timeline edits).
   * Blocks approval of STALE, INVALID, SUPERSEDED, CRITICAL/UNKNOWN risk, or unresolved-conflict proposals.
   */
  public static approveProposal(
    edl: EditDecisionListSnapshot,
    proposalId: string,
    options?: {
      readonly reason?: string;
      readonly actorId?: string;
      readonly nowMs?: number;
    },
  ): HumanDecisionResult {
    const nowMs = options?.nowMs ?? Date.now();
    const target = edl.proposals.find((p) => p.proposalId === proposalId);
    if (!target) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: null,
        failure: {
          code: 'MISSING_EVENT_PROVENANCE',
          severity: 'ERROR',
          proposalId,
          message: `Proposal "${proposalId}" was not found in EDL ${edl.edlId}.`,
          actionableFix: 'Verify the proposalId against the active EDL snapshot.',
        },
      };
    }

    const transErr = EditDecisionValidator.validateStateTransition(
      target.status,
      'APPROVED',
      proposalId,
    );
    if (transErr) {
      return { ok: false, snapshot: edl, updatedProposal: target, failure: transErr };
    }

    if (target.status === 'STALE') {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'STALE_PROPOSAL',
          severity: 'ERROR',
          proposalId,
          message: `Cannot approve stale proposal "${proposalId}".`,
          actionableFix: 'Regenerate EDL against the active transcript and source audio.',
        },
      };
    }

    if (!target.boundary.valid || !target.proposedRange) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'INVALID_SAMPLE_POSITIONS',
          severity: 'ERROR',
          proposalId,
          message: `Cannot approve proposal "${proposalId}" without valid proposed source coordinates.`,
          actionableFix: 'Revise proposal boundaries first or reject the proposal.',
        },
      };
    }

    if (target.risk.overallLevel === 'CRITICAL' || target.risk.overallLevel === 'UNKNOWN') {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'CRITICAL_OR_UNKNOWN_RISK',
          severity: 'ERROR',
          proposalId,
          message: `Cannot approve proposal "${proposalId}" because risk level is ${target.risk.overallLevel}.`,
          actionableFix: 'Resolve blocking risks or reject this proposal.',
        },
      };
    }

    // Check unresolved conflicts
    const unresolved = edl.conflicts.filter(
      (c) => !c.resolved && c.involvedProposalIds.includes(proposalId),
    );
    if (unresolved.length > 0) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'UNRESOLVED_CONFLICT',
          severity: 'ERROR',
          proposalId,
          message: `Cannot approve proposal "${proposalId}" while unresolved conflicts exist (${unresolved.map((u) => u.type).join(', ')}).`,
          actionableFix: 'Reject conflicting proposals or revise boundaries so intervals do not collide.',
        },
      };
    }

    // Ensure no already-approved proposal removes overlapping samples on the same track
    const conflictingApproved = edl.proposals.find(
      (other) =>
        other.proposalId !== proposalId &&
        other.status === 'APPROVED' &&
        other.trackId === target.trackId &&
        other.proposedRange !== null &&
        target.proposedRange !== null &&
        Math.min(other.proposedRange.endSample, target.proposedRange.endSample) >
          Math.max(other.proposedRange.startSample, target.proposedRange.startSample),
    );
    if (conflictingApproved) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'DUPLICATE_SOURCE_REMOVAL',
          severity: 'ERROR',
          proposalId,
          message: `Proposal "${proposalId}" overlaps already-approved proposal "${conflictingApproved.proposalId}".`,
          actionableFix: 'Reject one of the overlapping proposals or revise boundaries.',
        },
      };
    }

    return this.applyStatusChange(edl, target, 'APPROVED', 'APPROVE', {
      reason: options?.reason ?? 'Human reviewer approved proposal (no audio modified yet).',
      actorId: options?.actorId,
      nowMs,
    });
  }

  public static rejectProposal(
    edl: EditDecisionListSnapshot,
    proposalId: string,
    options?: {
      readonly reason?: string;
      readonly actorId?: string;
      readonly nowMs?: number;
    },
  ): HumanDecisionResult {
    const nowMs = options?.nowMs ?? Date.now();
    const target = edl.proposals.find((p) => p.proposalId === proposalId);
    if (!target) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: null,
        failure: {
          code: 'MISSING_EVENT_PROVENANCE',
          severity: 'ERROR',
          proposalId,
          message: `Proposal "${proposalId}" not found.`,
          actionableFix: 'Provide an existing proposalId.',
        },
      };
    }

    const transErr = EditDecisionValidator.validateStateTransition(
      target.status,
      'REJECTED',
      proposalId,
    );
    if (transErr) {
      return { ok: false, snapshot: edl, updatedProposal: target, failure: transErr };
    }

    // Rejecting a proposal can resolve pairwise conflicts involving only this rejected proposal + one other
    const result = this.applyStatusChange(edl, target, 'REJECTED', 'REJECT', {
      reason: options?.reason ?? 'Rejected by human reviewer.',
      actorId: options?.actorId,
      nowMs,
    });
    if (!result.ok) return result;

    const updatedConflicts = result.snapshot.conflicts.map((conf) => {
      if (conf.resolved || !conf.involvedProposalIds.includes(proposalId)) return conf;
      const remainingActive = conf.involvedProposalIds.filter((id) => {
        const p = result.snapshot.proposals.find((x) => x.proposalId === id);
        return p && p.status !== 'REJECTED' && p.status !== 'SUPERSEDED';
      });
      if (remainingActive.length <= 1) {
        return {
          ...conf,
          resolved: true,
          reason: `${conf.reason} Resolved by rejecting ${proposalId}.`,
        };
      }
      return conf;
    });

    const refreshed = {
      ...result.snapshot,
      conflicts: updatedConflicts,
    };
    const validation = EditDecisionValidator.validateEdlSnapshot(refreshed);
    return {
      ...result,
      snapshot: deepFreeze({ ...refreshed, validation }),
    };
  }

  public static requestReview(
    edl: EditDecisionListSnapshot,
    proposalId: string,
    options?: {
      readonly reason?: string;
      readonly actorId?: string;
      readonly nowMs?: number;
    },
  ): HumanDecisionResult {
    const nowMs = options?.nowMs ?? Date.now();
    const target = edl.proposals.find((p) => p.proposalId === proposalId);
    if (!target) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: null,
        failure: {
          code: 'MISSING_EVENT_PROVENANCE',
          severity: 'ERROR',
          proposalId,
          message: `Proposal "${proposalId}" not found.`,
          actionableFix: 'Provide an existing proposalId.',
        },
      };
    }

    const transErr = EditDecisionValidator.validateStateTransition(
      target.status,
      'NEEDS_REVIEW',
      proposalId,
    );
    if (transErr) {
      return { ok: false, snapshot: edl, updatedProposal: target, failure: transErr };
    }

    return this.applyStatusChange(edl, target, 'NEEDS_REVIEW', 'REQUEST_REVIEW', {
      reason: options?.reason ?? 'Flagged for additional human review.',
      actorId: options?.actorId,
      nowMs,
    });
  }

  /**
   * Revises proposed integer sample boundaries by creating a new immutable successor proposal
   * (version + 1), marking the previous version SUPERSEDED, and preserving all historical decisions.
   * Original source coordinates on the proposal are NEVER overwritten!
   */
  public static reviseProposalBoundaries(
    edl: EditDecisionListSnapshot,
    proposalId: string,
    newProposedSamples: {
      readonly startSample: SampleIndex;
      readonly endSample: SampleIndex;
    },
    options?: {
      readonly reason?: string;
      readonly actorId?: string;
      readonly nowMs?: number;
    },
  ): HumanDecisionResult {
    const nowMs = options?.nowMs ?? Date.now();
    const target = edl.proposals.find((p) => p.proposalId === proposalId);
    if (!target) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: null,
        failure: {
          code: 'MISSING_EVENT_PROVENANCE',
          severity: 'ERROR',
          proposalId,
          message: `Proposal "${proposalId}" not found.`,
          actionableFix: 'Provide an existing proposalId.',
        },
      };
    }

    if (target.status === 'STALE' || target.status === 'SUPERSEDED') {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'INVALID_STATE_TRANSITION',
          severity: 'ERROR',
          proposalId,
          message: `Cannot revise boundaries on ${target.status} proposal "${proposalId}".`,
          actionableFix: 'Regenerate EDL or revise the active successor proposal.',
        },
      };
    }

    const { startSample, endSample } = newProposedSamples;
    if (
      !Number.isInteger(startSample) ||
      !Number.isInteger(endSample) ||
      startSample < 0 ||
      endSample < 0
    ) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'INVALID_SAMPLE_POSITIONS',
          severity: 'ERROR',
          proposalId,
          message: `Revised coordinates must be non-negative integers (${startSample}, ${endSample}).`,
          actionableFix: 'Provide valid non-negative integer sample positions.',
        },
      };
    }

    if (startSample >= endSample) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'START_GTE_END',
          severity: 'ERROR',
          proposalId,
          message: `Revised startSample (${startSample}) >= endSample (${endSample}).`,
          actionableFix: 'Ensure endSample > startSample.',
        },
      };
    }

    if (endSample > edl.totalSourceSamples) {
      return {
        ok: false,
        snapshot: edl,
        updatedProposal: target,
        failure: {
          code: 'OUT_OF_RANGE_COORDINATES',
          severity: 'ERROR',
          proposalId,
          message: `Revised endSample (${endSample}) exceeds totalSourceSamples (${edl.totalSourceSamples}).`,
          actionableFix: 'Clamp revised boundaries inside source audio length.',
        },
      };
    }

    const nextVersion = target.proposalVersion + 1;
    const successorId = `${target.proposalId}_v${nextVersion}`;
    const revisedInterval = createSourceSampleInterval(startSample, endSample, target.sampleRate);

    const supersededOld: EditProposal = {
      ...target,
      status: 'SUPERSEDED',
      supersededByProposalId: successorId,
    };

    const origStart = target.originalRange?.startSample ?? startSample;
    const origEnd = target.originalRange?.endSample ?? endSample;
    const origDur = Math.max(1, origEnd - origStart);
    const revisedDur = endSample - startSample;
    const shiftSamples = Math.max(Math.abs(startSample - origStart), Math.abs(endSample - origEnd));
    const significantExpansion =
      revisedDur > origDur * 1.5 || shiftSamples > Math.round(target.sampleRate * 0.25);

    const draftSuccessor: EditProposal = {
      ...target,
      proposalId: successorId,
      proposalVersion: nextVersion,
      // Original range strictly preserved!
      originalRange: target.originalRange,
      proposedRange: revisedInterval,
      boundary: {
        ...target.boundary,
        valid: true,
        proposedInterval: revisedInterval,
        refinementMethod: 'human-revised-sample-boundaries',
        boundaryConfidence: significantExpansion ? 'MEDIUM' : 'HIGH',
        boundaryConfidenceScore: significantExpansion ? 0.72 : 0.9,
        boundaryScoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
        appliedEvidence: [
          ...target.boundary.appliedEvidence,
          `Human boundary revision [${startSample}, ${endSample}) samples.`,
        ],
      },
      status: 'NEEDS_REVIEW',
      validationStatus: 'VALID',
      validationIssues: [],
      requiresHumanReview: true,
      supersedesProposalId: target.proposalId,
      supersededByProposalId: undefined,
      conflictIds: [],
      createdAtMs: nowMs,
    };

    const nextProposals = edl.proposals
      .map((p) => (p.proposalId === target.proposalId ? supersededOld : p))
      .concat(draftSuccessor);

    const historyEntries: EditDecisionHistoryEntry[] = [
      {
        decisionId: `dec_${deterministicHexHash(`${target.proposalId}|SUPERSEDE|${nowMs}|${edl.decisionHistory.length}`)}`,
        proposalId: target.proposalId,
        proposalVersion: target.proposalVersion,
        previousStatus: target.status,
        newStatus: 'SUPERSEDED',
        action: 'SUPERSEDE',
        timestampMs: nowMs,
        reason: options?.reason ?? `Superseded by revised proposal ${successorId}.`,
        actorId: options?.actorId,
        sourceAudioHash: edl.sourceAudioHash,
        transcriptVersion: edl.transcriptVersion,
        supersededByProposalId: successorId,
      },
      {
        decisionId: `dec_${deterministicHexHash(`${successorId}|REVISE_BOUNDARIES|${nowMs}|${edl.decisionHistory.length + 1}`)}`,
        proposalId: successorId,
        proposalVersion: nextVersion,
        previousStatus: target.status,
        newStatus: 'NEEDS_REVIEW',
        action: 'REVISE_BOUNDARIES',
        timestampMs: nowMs,
        reason:
          options?.reason ??
          `Revised proposed boundaries to [${startSample}, ${endSample}) samples.`,
        actorId: options?.actorId,
        sourceAudioHash: edl.sourceAudioHash,
        transcriptVersion: edl.transcriptVersion,
      },
    ];

    // Re-run conflict detection on active proposals so revised boundaries are checked cleanly
    const rechecked = EditConflictResolver.resolve({
      proposals: nextProposals,
      expectedTranscriptVersion: edl.transcriptVersion,
    });

    // Re-validate the revised successor proposal against source bounds, provenance, and newly detected conflicts
    const validatedProposals = rechecked.proposals.map((p) => {
      if (p.proposalId !== successorId) return p;
      const issues = EditDecisionValidator.validateProposal(
        p,
        edl.totalSourceSamples,
        rechecked.conflicts,
      );
      const hasErrors = issues.some((i) => i.severity === 'ERROR');
      const hasNonConflictErrors = issues.some(
        (i) =>
          i.severity === 'ERROR' &&
          i.code !== 'UNRESOLVED_CONFLICT' &&
          i.code !== 'PROTECTED_EVENT_OVERLAP',
      );
      const hasWarnings = issues.some((i) => i.severity === 'WARNING') || p.conflictIds.length > 0;
      const validationStatus: EditProposal['validationStatus'] = hasErrors
        ? 'INVALID'
        : hasWarnings
          ? 'WARNING'
          : 'VALID';
      const nextStatus: EditProposal['status'] =
        !p.boundary.valid || hasNonConflictErrors ? 'INVALID' : p.status;
      return {
        ...p,
        status: nextStatus,
        validationStatus,
        validationIssues: issues,
        requiresHumanReview: true,
      };
    });

    const draft: EditDecisionListSnapshot = {
      ...edl,
      edlVersion: edl.edlVersion + 1,
      proposals: validatedProposals,
      conflicts: rechecked.conflicts,
      decisionHistory: [...edl.decisionHistory, ...historyEntries],
      modifiedAtMs: nowMs,
    };
    const validation = EditDecisionValidator.validateEdlSnapshot(draft);
    const frozen = deepFreeze({ ...draft, validation });

    return {
      ok: true,
      snapshot: frozen,
      updatedProposal: frozen.proposals.find((p) => p.proposalId === successorId) ?? null,
      failure: null,
    };
  }

  /**
   * Detects source audio hash, transcript version, alignment version, or detector version drift
   * and marks all affected proposals STALE while preserving decision history.
   */
  public static revalidateAndMarkStale(
    edl: EditDecisionListSnapshot,
    currentVersions: {
      readonly sourceAudioHash?: string;
      readonly sourceAudioId?: string;
      readonly transcriptVersion?: string;
      readonly alignmentVersion?: string;
      readonly eventDetectorVersion?: string;
      readonly nowMs?: number;
      readonly actorId?: string;
    },
  ): EditDecisionListSnapshot {
    const nowMs = currentVersions.nowMs ?? Date.now();
    const appendedHistory: EditDecisionHistoryEntry[] = [];
    let anyChanged = false;

    const updatedProposals = edl.proposals.map((prop) => {
      if (prop.status === 'SUPERSEDED') return prop;
      const stale = checkProposalProvenanceStaleness(prop, currentVersions);
      if (!stale.isStale) return prop;

      anyChanged = true;
      appendedHistory.push({
        decisionId: `dec_${deterministicHexHash(`${prop.proposalId}|MARK_STALE|${nowMs}|${appendedHistory.length}`)}`,
        proposalId: prop.proposalId,
        proposalVersion: prop.proposalVersion,
        previousStatus: prop.status,
        newStatus: 'STALE',
        action: 'MARK_STALE',
        timestampMs: nowMs,
        reason: stale.reasons.join(' '),
        actorId: currentVersions.actorId ?? 'system-revalidator',
        sourceAudioHash: prop.sourceAudioHash,
        transcriptVersion: prop.transcriptVersion,
      });

      return {
        ...prop,
        status: 'STALE' as const,
        validationStatus: 'STALE' as const,
        risk: {
          ...prop.risk,
          overallLevel: 'CRITICAL' as const,
          approvalPermitted: false,
          mandatoryHumanReview: true,
          blockingReasons: [...prop.risk.blockingReasons, ...stale.reasons],
        },
        validationIssues: [
          ...prop.validationIssues,
          {
            code: 'STALE_PROPOSAL' as const,
            severity: 'ERROR' as const,
            proposalId: prop.proposalId,
            message: stale.reasons.join(' '),
            actionableFix: 'Regenerate EDL from the active source audio and transcript version.',
          },
        ],
      };
    });

    if (!anyChanged) {
      return edl;
    }

    const draft: EditDecisionListSnapshot = {
      ...edl,
      edlVersion: edl.edlVersion + 1,
      proposals: updatedProposals,
      decisionHistory: [...edl.decisionHistory, ...appendedHistory],
      modifiedAtMs: nowMs,
    };
    const validation = EditDecisionValidator.validateEdlSnapshot(draft);
    return deepFreeze({ ...draft, validation });
  }

  /**
   * Produces a validated Mission 06 ApplicationReadyEditPlan with Undo/Redo metadata
   * without executing any timeline transaction or modifying audio.
   */
  public static prepareApplicationPlan(params: {
    readonly edl: EditDecisionListSnapshot;
    readonly projectDoc: ProjectDocument;
    readonly expectedSourceAudioHash: string;
    readonly expectedTranscriptVersion: string;
    readonly expectedEdlVersion?: number;
    readonly proposalIds?: readonly string[];
    readonly nowMs?: number;
  }): ApplicationReadyEditPlan {
    return EditDecisionValidator.validateForApplication({
      edl: params.edl,
      projectDoc: params.projectDoc,
      expectedSourceAudioHash: params.expectedSourceAudioHash,
      expectedTranscriptVersion: params.expectedTranscriptVersion,
      expectedEdlVersion: params.expectedEdlVersion ?? params.edl.edlVersion,
      proposalIds: params.proposalIds,
      nowMs: params.nowMs,
    });
  }

  private static applyStatusChange(
    edl: EditDecisionListSnapshot,
    target: EditProposal,
    nextStatus: EditProposalStatus,
    action: EditDecisionHistoryEntry['action'],
    options: { readonly reason?: string; readonly actorId?: string; readonly nowMs: number },
  ): HumanDecisionResult {
    const updatedProp: EditProposal = {
      ...target,
      status: nextStatus,
    };

    const historyEntry: EditDecisionHistoryEntry = {
      decisionId: `dec_${deterministicHexHash(`${target.proposalId}|${action}|${options.nowMs}|${edl.decisionHistory.length}`)}`,
      proposalId: target.proposalId,
      proposalVersion: target.proposalVersion,
      previousStatus: target.status,
      newStatus: nextStatus,
      action,
      timestampMs: options.nowMs,
      reason: options.reason,
      actorId: options.actorId,
      sourceAudioHash: edl.sourceAudioHash,
      transcriptVersion: edl.transcriptVersion,
    };

    const nextProposals = edl.proposals.map((p) =>
      p.proposalId === target.proposalId ? updatedProp : p,
    );

    const draft: EditDecisionListSnapshot = {
      ...edl,
      edlVersion: edl.edlVersion + 1,
      proposals: nextProposals,
      decisionHistory: [...edl.decisionHistory, historyEntry],
      modifiedAtMs: options.nowMs,
    };

    const validation = EditDecisionValidator.validateEdlSnapshot(draft);
    const frozen = deepFreeze({ ...draft, validation });

    return {
      ok: true,
      snapshot: frozen,
      updatedProposal: frozen.proposals.find((p) => p.proposalId === target.proposalId) ?? null,
      failure: null,
    };
  }

  private static evaluateSingleEvent(params: {
    readonly event: SpeechEvent;
    readonly allEvents: readonly SpeechEvent[];
    readonly tokenSpans: ReturnType<typeof normalizeTokensToSampleSpans>;
    readonly context: EditDecisionGenerationRequest['context'];
    readonly eventTranscriptVersion: string;
    readonly detectorVersion: string;
    readonly lexiconVersion: string;
    readonly thresholdConfigVersion: string;
    readonly modelVersions: Readonly<Record<string, string>>;
    readonly nowMs: number;
  }): EditProposal {
    const {
      event,
      allEvents,
      tokenSpans,
      context,
      eventTranscriptVersion,
      detectorVersion,
      lexiconVersion,
      thresholdConfigVersion,
      modelVersions,
      nowMs,
    } = params;

    const evalRes = EditCandidateEvaluator.evaluate(event, {
      allEventsInRecording: allEvents,
    });

    const boundary = EditBoundaryRefiner.refine({
      event,
      operation: evalRes.operation,
      sampleRate: context.sampleRate,
      totalSourceSamples: context.totalSourceSamples,
      tokenSpans,
      siblingEvents: allEvents,
    });

    // If boundary quality is insufficient on a destructive candidate, downgrade to review
    const boundaryTooWeakForDeletion =
      !boundary.valid ||
      boundary.proposedInterval === null ||
      boundary.boundaryConfidence === 'LOW' ||
      boundary.boundaryConfidence === 'UNKNOWN';

    const effectiveRequiresReview =
      evalRes.requiresHumanReview || boundaryTooWeakForDeletion;

    const isStaleVersion = eventTranscriptVersion !== context.transcriptVersion;

    const risk = EditRiskEvaluator.evaluate({
      event,
      operation: evalRes.operation,
      boundary,
      tokenSpans,
      isStale: isStaleVersion,
      stalenessReasons: isStaleVersion
        ? [`Event transcriptVersion=${eventTranscriptVersion} != active=${context.transcriptVersion}`]
        : [],
    });

    const evidenceRefs: EditEvidenceReference[] = [
      {
        refId: `evref_${event.eventId}`,
        kind: 'SPEECH_EVENT',
        sourceId: event.eventId,
        summary: `${event.category}/${event.subtype} (${event.detectionState}, method=${event.detectionMethod})`,
        metrics: {
          acousticScore: event.scores.acousticScore,
          linguisticScore: event.scores.linguisticScore,
          combinedDecisionScore: event.scores.combinedDecisionScore,
          calibratedProbability: event.scores.calibratedProbability,
          ruleEvidenceCount: event.scores.ruleEvidenceCount,
          modelTokenConfidence: event.scores.modelTokenConfidence,
        },
      },
    ];

    if (event.relatedTokenIds && event.relatedTokenIds.length > 0) {
      evidenceRefs.push({
        refId: `tokref_${event.eventId}`,
        kind: 'TRANSCRIPT_TOKEN',
        sourceId: event.relatedTokenIds.join(','),
        summary: `Related tokens: ${event.relatedText ?? event.relatedTokenIds.join(', ')}`,
      });
    }

    if (event.acousticEvidence) {
      evidenceRefs.push({
        refId: `acref_${event.eventId}`,
        kind: event.acousticEvidence.vadSpeechRatio !== undefined ? 'VAD' : 'ACOUSTIC_WINDOW',
        sourceId: `${event.trackId}:${event.startSec}-${event.endSec}`,
        summary: `rmsDb=${event.acousticEvidence.rmsDb ?? 'na'}, noiseFloor=${event.acousticEvidence.noiseFloorDbfs ?? 'na'}, vadRatio=${event.acousticEvidence.vadSpeechRatio ?? 'na'}`,
      });
    }

    if (event.linguisticEvidence?.matchedLexiconId) {
      evidenceRefs.push({
        refId: `lexref_${event.eventId}`,
        kind: 'LEXICON',
        sourceId: event.linguisticEvidence.matchedLexiconId,
        summary: `Lexicon=${lexiconVersion}, canonical=${event.linguisticEvidence.canonicalForm ?? ''}`,
      });
    }

    const proposalId = buildDeterministicProposalId({
      projectId: context.projectId,
      sourceAudioHash: context.sourceAudioHash,
      transcriptVersion: eventTranscriptVersion,
      eventIds: [event.eventId],
      operation: evalRes.operation,
      startSample: boundary.originalInterval?.startSample ?? null,
      endSample: boundary.originalInterval?.endSample ?? null,
    });

    let initialStatus: EditProposalStatus = 'PROPOSED';
    if (isStaleVersion) {
      initialStatus = 'STALE';
    } else if (!boundary.valid) {
      initialStatus = 'INVALID';
    } else if (
      effectiveRequiresReview ||
      risk.mandatoryHumanReview ||
      evalRes.eligibility !== 'SAFE_EDIT_CANDIDATE'
    ) {
      initialStatus = 'NEEDS_REVIEW';
    }

    return {
      proposalId,
      proposalVersion: 1,
      projectId: context.projectId,
      trackId: event.trackId,
      sourceAudioId: context.sourceAudioId,
      sourceAudioHash: context.sourceAudioHash,
      transcriptVersion: eventTranscriptVersion,
      alignmentVersion: context.alignmentVersion,
      speechEventSourceIds: [event.eventId],
      eventDetectorVersion: event.provenance.engineVersion || detectorVersion,
      modelVersions,
      lexiconVersion,
      timebaseFlicksPerSecond: FLICKS_PER_SECOND,
      sampleRate: context.sampleRate,
      channelLayout: context.channelLayout,
      originalRange: boundary.originalInterval,
      proposedRange: boundary.proposedInterval,
      operation: evalRes.operation,
      eventCategory: event.category,
      eventSubtype: event.subtype,
      candidateEligibility: boundary.valid ? evalRes.eligibility : 'INVALID_CANDIDATE',
      evidenceReferences: evidenceRefs,
      confidenceClassification: evalRes.confidenceClassification,
      eventConfidenceScore:
        event.detectionState === 'UNSUPPORTED' || !Number.isFinite(event.confidence)
          ? null
          : event.confidence,
      scoreCalibrationStatus: event.scores.scoreCalibrationStatus,
      calibratedProbability: event.scores.calibratedProbability,
      boundary,
      risk,
      requiresHumanReview: effectiveRequiresReview || risk.mandatoryHumanReview,
      protectedEvent: evalRes.protectedEvent,
      createdAtMs: nowMs,
      status: initialStatus,
      validationStatus: boundary.valid ? 'VALID' : 'INVALID',
      validationIssues: [],
      provenance: {
        projectId: context.projectId,
        sourceAudioId: context.sourceAudioId,
        sourceAudioHash: context.sourceAudioHash,
        transcriptVersion: eventTranscriptVersion,
        alignmentVersion: context.alignmentVersion,
        speechEventSourceIds: [event.eventId],
        eventDetectorVersion: event.provenance.engineVersion || detectorVersion,
        decisionEngineVersion: EDIT_DECISION_ENGINE_VERSION,
        modelVersions,
        lexiconVersion,
        thresholdConfigVersion: event.provenance.thresholdConfigVersion || thresholdConfigVersion,
      },
      relatedTokenIds: [...(event.relatedTokenIds ?? [])],
      relatedText: event.relatedText,
      explanationFa: evalRes.explanationFa,
      conflictIds: [],
    };
  }
}
