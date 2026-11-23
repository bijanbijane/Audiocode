import { FLICKS_PER_SECOND, SampleRate, TimeMath } from '../contracts/timebase.contract';
import { ProjectDocument, TimelineClip } from '../contracts/project-schema.contract';
import {
  EditDecisionListSnapshot,
  EditOperationType,
  EditProposal,
  UndoRedoEditMetadata,
} from '../ai-engine/edit-decision/EditDecisionTypes';
import { EditDecisionValidator } from '../ai-engine/edit-decision/EditDecisionValidator';
import {
  checkProposalProvenanceStaleness,
  deepFreeze,
  deterministicHexHash,
} from '../ai-engine/edit-decision/EditProvenance';
import { isSupportedSampleRate } from '../ai-engine/edit-decision/EditBoundaryRefiner';
import {
  AUDIO_RENDERER_VERSION,
  AudioRenderConfig,
  ImmutableRenderPlan,
  RemovedSourceSegment,
  RenderExportContainer,
  RenderExportEncoding,
  RenderTransitionPlan,
  RenderValidationFailure,
  RetainedSourceSegment,
  RIFF_WAV_MAX_DATA_BYTES,
  SourceToOutputMappingEntry,
} from './AudioRenderTypes';

const SUPPORTED_RENDER_OPERATIONS = new Set<EditOperationType>([
  'REMOVE_FILLER',
  'SHORTEN_SILENCE',
  'REMOVE_ACCIDENTAL_REPETITION',
]);

const SUPPORTED_ENCODINGS = new Set<RenderExportEncoding>(['pcm16', 'pcm24', 'float32']);

export function bytesPerSampleForEncoding(encoding: RenderExportEncoding): 2 | 3 | 4 {
  switch (encoding) {
    case 'pcm16':
      return 2;
    case 'pcm24':
      return 3;
    case 'float32':
      return 4;
  }
}

export function bitsPerSampleForEncoding(encoding: RenderExportEncoding): 16 | 24 | 32 {
  switch (encoding) {
    case 'pcm16':
      return 16;
    case 'pcm24':
      return 24;
    case 'float32':
      return 32;
  }
}

export function estimateContainerOutputBytes(params: {
  readonly outputSamples: number;
  readonly channelCount: number;
  readonly encoding: RenderExportEncoding;
  readonly container: RenderExportContainer;
}): { readonly headerBytes: number; readonly dataBytes: number; readonly totalBytes: number } {
  const bytesPerSample = bytesPerSampleForEncoding(params.encoding);
  const dataBytes = params.outputSamples * params.channelCount * bytesPerSample;
  // Classic WAV header = 44 bytes (RIFF + fmt + data); RF64 header = 80 bytes (RF64 + ds64 + fmt + data)
  const headerBytes = params.container === 'rf64' ? 80 : 44;
  return {
    headerBytes,
    dataBytes,
    totalBytes: headerBytes + dataBytes,
  };
}

export interface RenderPlanBuildResult {
  readonly ok: boolean;
  readonly plan: ImmutableRenderPlan | null;
  readonly failures: readonly RenderValidationFailure[];
}

/**
 * Deterministic Non-Destructive Render Planner (AVP-P06-001)
 *
 * Converts ONLY validated, explicitly APPROVED EDL proposals into an immutable
 * source-coordinate render plan. Never mutates source audio, transcript, or EDL.
 */
export class AudioRenderPlanner {
  public static buildPlan(params: {
    readonly edl: EditDecisionListSnapshot;
    readonly sourceAudioId: string;
    readonly sourceAudioHash: string;
    readonly sourceSampleRate: SampleRate;
    readonly channelCount: number;
    readonly totalSourceSamples: number;
    readonly expectedSourceAudioHash: string;
    readonly expectedTranscriptVersion: string;
    readonly expectedEdlVersion: number;
    readonly config: AudioRenderConfig;
    readonly projectDocument?: ProjectDocument;
    readonly proposalIds?: readonly string[];
    readonly nowMs?: number;
  }): RenderPlanBuildResult {
    const failures: RenderValidationFailure[] = [];
    const {
      edl,
      sourceAudioId,
      sourceAudioHash,
      sourceSampleRate,
      channelCount,
      totalSourceSamples,
      expectedSourceAudioHash,
      expectedTranscriptVersion,
      expectedEdlVersion,
      config,
      projectDocument,
    } = params;
    const nowMs = params.nowMs ?? Date.now();

    // 1. Source identity & audio dimensions
    if (!sourceAudioId || !sourceAudioHash || !edl.projectId) {
      failures.push({
        code: 'INVALID_SOURCE_IDENTITY',
        severity: 'ERROR',
        message: 'Source audio identity (sourceAudioId/sourceAudioHash/projectId) is incomplete.',
        actionableFix: 'Supply verified source audio metadata matching the EDL.',
      });
    }

    if (
      sourceAudioId !== edl.sourceAudioId ||
      sourceAudioHash !== edl.sourceAudioHash ||
      sourceAudioHash !== expectedSourceAudioHash
    ) {
      failures.push({
        code: 'STALE_EDL_OR_TRANSCRIPT',
        severity: 'ERROR',
        message: `Source audio identity/hash mismatch: source=${sourceAudioHash}, edl=${edl.sourceAudioHash}, expected=${expectedSourceAudioHash}.`,
        actionableFix: 'Regenerate or reload the EDL for the active source audio file.',
      });
    }

    if (edl.transcriptVersion !== expectedTranscriptVersion) {
      failures.push({
        code: 'STALE_EDL_OR_TRANSCRIPT',
        severity: 'ERROR',
        message: `Transcript version mismatch: edl=${edl.transcriptVersion}, active=${expectedTranscriptVersion}.`,
        actionableFix: 'Revalidate the EDL against the active transcript version.',
      });
    }

    if (edl.edlVersion !== expectedEdlVersion) {
      failures.push({
        code: 'STALE_EDL_OR_TRANSCRIPT',
        severity: 'ERROR',
        message: `EDL version mismatch: snapshot v${edl.edlVersion} != expected v${expectedEdlVersion}.`,
        actionableFix: 'Pass the latest immutable EDL snapshot version.',
      });
    }

    if (!isSupportedSampleRate(sourceSampleRate) || sourceSampleRate !== edl.sampleRate) {
      failures.push({
        code: 'INVALID_SAMPLE_COORDINATES',
        severity: 'ERROR',
        message: `Source sampleRate (${sourceSampleRate}) does not match supported EDL sampleRate (${edl.sampleRate}).`,
        actionableFix: 'Ensure the source audio sample rate matches the EDL timebase.',
      });
    }

    if (!Number.isInteger(totalSourceSamples) || totalSourceSamples <= 0) {
      failures.push({
        code: 'INVALID_SAMPLE_COORDINATES',
        severity: 'ERROR',
        message: `Invalid totalSourceSamples (${String(totalSourceSamples)}).`,
        actionableFix: 'Provide a positive integer source sample count.',
      });
    }

    if (totalSourceSamples !== edl.totalSourceSamples) {
      failures.push({
        code: 'INVALID_SAMPLE_COORDINATES',
        severity: 'ERROR',
        message: `Source sample length (${totalSourceSamples}) differs from EDL totalSourceSamples (${edl.totalSourceSamples}).`,
        actionableFix: 'Recompute EDL against the exact source audio file.',
      });
    }

    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 16) {
      failures.push({
        code: 'CHANNEL_MISMATCH',
        severity: 'ERROR',
        message: `Unsupported channelCount: ${String(channelCount)}.`,
        actionableFix: 'Use between 1 and 16 channels.',
      });
    }

    // 2. Export format validation
    if (!SUPPORTED_ENCODINGS.has(config.encoding)) {
      failures.push({
        code: 'UNSUPPORTED_EXPORT_FORMAT',
        severity: 'ERROR',
        message: `Unsupported render encoding "${String(config.encoding)}".`,
        actionableFix: 'Select one of pcm16, pcm24, or float32.',
      });
    }

    const outputSampleRate: SampleRate = config.targetSampleRate ?? sourceSampleRate;
    if (!isSupportedSampleRate(outputSampleRate)) {
      failures.push({
        code: 'UNSUPPORTED_EXPORT_FORMAT',
        severity: 'ERROR',
        message: `Unsupported targetSampleRate "${String(outputSampleRate)}".`,
        actionableFix: 'Use a canonical sample rate (16000..96000 Hz) or omit targetSampleRate to preserve source rate.',
      });
    }

    // 3. Select candidate proposals (explicit subset OR all approved proposals for target track)
    const targetTrackId =
      config.trackId ??
      edl.proposals.find((p) => p.status === 'APPROVED')?.trackId ??
      edl.proposals[0]?.trackId ??
      'track-primary';

    const selectedProposals: EditProposal[] = params.proposalIds
      ? params.proposalIds
          .map((id) => edl.proposals.find((p) => p.proposalId === id))
          .filter((p): p is EditProposal => Boolean(p))
      : edl.proposals.filter(
          (p) =>
            p.status === 'APPROVED' &&
            (config.trackId === undefined || p.trackId === config.trackId),
        );

    // If caller passed explicit proposalIds that do not exist in EDL, flag them
    if (params.proposalIds) {
      for (const reqId of params.proposalIds) {
        if (!edl.proposals.some((p) => p.proposalId === reqId)) {
          failures.push({
            code: 'UNAPPROVED_PROPOSAL',
            severity: 'ERROR',
            proposalId: reqId,
            message: `Requested proposal "${reqId}" does not exist in EDL v${edl.edlVersion}.`,
            actionableFix: 'Reference only existing APPROVED proposals from the active EDL.',
          });
        }
      }
    }

    // Protected events across the EDL on the active track
    const protectedProposals = edl.proposals.filter(
      (p) => p.protectedEvent && p.trackId === targetTrackId && p.originalRange !== null,
    );

    const validatedRemovals: RemovedSourceSegment[] = [];
    const seenProposalIds = new Set<string>();

    for (const prop of selectedProposals) {
      if (seenProposalIds.has(prop.proposalId)) {
        failures.push({
          code: 'DUPLICATE_OR_OVERLAPPING_REMOVAL',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Duplicate proposalId "${prop.proposalId}" submitted to render planner.`,
          actionableFix: 'Deduplicate proposalIds before rendering.',
        });
        continue;
      }
      seenProposalIds.add(prop.proposalId);

      if (prop.status !== 'APPROVED') {
        failures.push({
          code: 'UNAPPROVED_PROPOSAL',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal "${prop.proposalId}" has status "${prop.status}" and cannot be rendered.`,
          actionableFix: 'Only explicitly APPROVED proposals may enter the rendering pipeline.',
        });
        continue;
      }

      if (!SUPPORTED_RENDER_OPERATIONS.has(prop.operation)) {
        failures.push({
          code: 'UNSUPPORTED_OPERATION',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Operation "${prop.operation}" is review-only or unsupported for destructive rendering.`,
          actionableFix: 'Exclude review-only proposals from render execution.',
        });
        continue;
      }

      const staleCheck = checkProposalProvenanceStaleness(prop, {
        sourceAudioId,
        sourceAudioHash: expectedSourceAudioHash,
        transcriptVersion: expectedTranscriptVersion,
      });
      if (staleCheck.isStale) {
        failures.push({
          code: 'STALE_EDL_OR_TRANSCRIPT',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: staleCheck.reasons.join(' '),
          actionableFix: 'Revalidate proposal against active source audio and transcript.',
        });
        continue;
      }

      if (prop.risk.overallLevel === 'CRITICAL' || prop.risk.overallLevel === 'UNKNOWN') {
        failures.push({
          code: 'CRITICAL_OR_UNKNOWN_RISK',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal "${prop.proposalId}" carries ${prop.risk.overallLevel} risk and is blocked from rendering.`,
          actionableFix: 'Revise boundaries or reject the high-risk proposal.',
        });
        continue;
      }

      const unresolvedConflict = edl.conflicts.find(
        (c) => !c.resolved && c.involvedProposalIds.includes(prop.proposalId),
      );
      if (unresolvedConflict) {
        failures.push({
          code: 'UNRESOLVED_EDL_CONFLICT',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal "${prop.proposalId}" is involved in unresolved conflict ${unresolvedConflict.conflictId} (${unresolvedConflict.type}).`,
          actionableFix: 'Resolve or reject conflicting proposals before rendering.',
        });
        continue;
      }

      if (!prop.originalRange || !prop.proposedRange) {
        failures.push({
          code: 'INVALID_SAMPLE_COORDINATES',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal "${prop.proposalId}" is missing valid integer sample coordinates.`,
          actionableFix: 'Revise proposal boundaries within source audio bounds.',
        });
        continue;
      }

      const { startSample, endSample } = prop.proposedRange;
      if (
        !Number.isInteger(startSample) ||
        !Number.isInteger(endSample) ||
        startSample < 0 ||
        endSample <= startSample ||
        endSample > totalSourceSamples
      ) {
        failures.push({
          code: 'INVALID_SAMPLE_COORDINATES',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal "${prop.proposalId}" has out-of-range or reversed sample coordinates [${startSample}, ${endSample}) for source length ${totalSourceSamples}.`,
          actionableFix: 'Correct proposal boundaries to lie strictly within [0, totalSourceSamples].',
        });
        continue;
      }

      // Protected event overlap guard
      const overlappingProtected = protectedProposals.find(
        (prot) =>
          prot.proposalId !== prop.proposalId &&
          prot.originalRange !== null &&
          Math.min(prot.originalRange.endSample, endSample) >
            Math.max(prot.originalRange.startSample, startSample),
      );
      if (overlappingProtected) {
        failures.push({
          code: 'PROTECTED_EVENT_OVERLAP',
          severity: 'ERROR',
          proposalId: prop.proposalId,
          message: `Proposal "${prop.proposalId}" overlaps protected event "${overlappingProtected.proposalId}" (${overlappingProtected.eventCategory}).`,
          actionableFix: 'Retract cut boundaries away from the protected region.',
        });
        continue;
      }

      validatedRemovals.push({
        proposalId: prop.proposalId,
        proposalVersion: prop.proposalVersion,
        trackId: prop.trackId,
        operation: prop.operation as RemovedSourceSegment['operation'],
        originalRange: prop.originalRange,
        removedRange: prop.proposedRange,
        removedSampleCount: endSample - startSample,
        relatedEventIds: prop.speechEventSourceIds,
        relatedText: prop.relatedText,
      });
    }

    // Optional Mission 05 application-readiness cross-check when ProjectDocument is supplied
    if (projectDocument && validatedRemovals.length > 0 && failures.length === 0) {
      const appPlan = EditDecisionValidator.validateForApplication({
        edl,
        projectDoc: projectDocument,
        expectedSourceAudioHash,
        expectedTranscriptVersion,
        expectedEdlVersion,
        proposalIds: validatedRemovals.map((r) => r.proposalId),
        nowMs,
      });
      if (!appPlan.readyToApply) {
        for (const bf of appPlan.blockingFailures) {
          failures.push({
            code: 'UNRESOLVED_EDL_CONFLICT',
            severity: 'ERROR',
            proposalId: bf.proposalId,
            message: `Mission 05 dry-run gate rejected application: ${bf.message}`,
            actionableFix: bf.actionableFix,
          });
        }
      }
    }

    // 4. Sort removals deterministically by original source startSample and reject overlaps/duplicates
    validatedRemovals.sort((a, b) => {
      if (a.removedRange.startSample !== b.removedRange.startSample) {
        return a.removedRange.startSample - b.removedRange.startSample;
      }
      return a.proposalId.localeCompare(b.proposalId);
    });

    for (let i = 1; i < validatedRemovals.length; i++) {
      const prev = validatedRemovals[i - 1];
      const curr = validatedRemovals[i];
      if (curr.removedRange.startSample < prev.removedRange.endSample) {
        failures.push({
          code: 'DUPLICATE_OR_OVERLAPPING_REMOVAL',
          severity: 'ERROR',
          proposalId: curr.proposalId,
          message: `Approved removal "${curr.proposalId}" [${curr.removedRange.startSample}, ${curr.removedRange.endSample}) overlaps "${prev.proposalId}" [${prev.removedRange.startSample}, ${prev.removedRange.endSample}).`,
          actionableFix: 'Reject one overlapping proposal or revise boundaries so removals are strictly disjoint.',
        });
      }
    }

    if (failures.some((f) => f.severity === 'ERROR')) {
      return { ok: false, plan: null, failures };
    }

    // 5. Derive retained source segments & splice transitions on original integer coordinates
    const retainedSegments: RetainedSourceSegment[] = [];
    const transitions: RenderTransitionPlan[] = [];
    const sourceToOutputMap: SourceToOutputMappingEntry[] = [];
    const derivedTimelineClips: TimelineClip[] = [];

    const rawCrossfadeMs = config.defaultCrossfadeMs ?? 10;
    const minCfMs =
      typeof config.minCrossfadeMs === 'number' && Number.isFinite(config.minCrossfadeMs)
        ? Math.max(0, Math.min(50, config.minCrossfadeMs))
        : 0;
    const maxCfMs =
      typeof config.maxCrossfadeMs === 'number' && Number.isFinite(config.maxCrossfadeMs)
        ? Math.max(minCfMs, Math.min(50, config.maxCrossfadeMs))
        : 50;
    const normalizedCrossfadeMs = Number.isFinite(rawCrossfadeMs) ? rawCrossfadeMs : 10;
    const defaultCrossfadeMs =
      normalizedCrossfadeMs <= 0
        ? 0
        : Math.max(Math.max(1, minCfMs), Math.min(maxCfMs, normalizedCrossfadeMs));
    const requestedCrossfadeSamples =
      defaultCrossfadeMs === 0
        ? 0
        : Math.max(2, Math.round((defaultCrossfadeMs / 1000) * sourceSampleRate));
    const rawMaxAdjust =
      config.maxBoundaryAdjustmentSamples ?? Math.round(sourceSampleRate * 0.005);
    const maxAdjustmentSamples = Math.max(
      0,
      Math.trunc(Number.isFinite(rawMaxAdjust) ? rawMaxAdjust : Math.round(sourceSampleRate * 0.005)),
    );

    let srcCursor = 0;
    let outCursor = 0;
    let segIdx = 0;

    for (let rIdx = 0; rIdx < validatedRemovals.length; rIdx++) {
      const rem = validatedRemovals[rIdx];
      const cutStart = rem.removedRange.startSample;
      const cutEnd = rem.removedRange.endSample;

      if (cutStart > srcCursor) {
        const len = cutStart - srcCursor;
        const srcStartFlicks = TimeMath.samplesToFlicks(srcCursor, sourceSampleRate);
        const srcEndFlicks = TimeMath.samplesToFlicks(cutStart, sourceSampleRate);
        const outStartFlicks = TimeMath.samplesToFlicks(outCursor, sourceSampleRate);
        const outEndFlicks = TimeMath.samplesToFlicks(outCursor + len, sourceSampleRate);

        retainedSegments.push({
          segmentIndex: segIdx,
          sourceStartSample: srcCursor,
          sourceEndSample: cutStart,
          sampleCount: len,
          outputStartSample: outCursor,
          outputEndSample: outCursor + len,
          sourceStartFlicks: srcStartFlicks,
          sourceEndFlicks: srcEndFlicks,
          outputStartFlicks: outStartFlicks,
          outputEndFlicks: outEndFlicks,
        });

        sourceToOutputMap.push({
          segmentIndex: segIdx,
          sourceStartSample: srcCursor,
          sourceEndSample: cutStart,
          outputStartSample: outCursor,
          outputEndSample: outCursor + len,
        });

        derivedTimelineClips.push({
          id: `rendered_clip_${segIdx}_${deterministicHexHash(`${sourceAudioId}:${srcCursor}:${cutStart}`)}`,
          trackId: targetTrackId,
          assetId: sourceAudioId,
          kind: 'AUDIO_ASSET',
          sourceRange: { start: srcStartFlicks, end: srcEndFlicks },
          timelineRange: { start: outStartFlicks, end: outEndFlicks },
          fadeInFlicks: segIdx > 0 ? TimeMath.secondsToFlicks(defaultCrossfadeMs / 1000) : 0,
          fadeOutFlicks: TimeMath.secondsToFlicks(defaultCrossfadeMs / 1000),
          gainDb: 0,
        });

        outCursor += len;
        segIdx++;
      }

      // Record transition if audio remains after this removal AND there was audio before it
      if (segIdx > 0 && cutEnd < totalSourceSamples) {
        const nextRemovalStart =
          rIdx + 1 < validatedRemovals.length
            ? validatedRemovals[rIdx + 1].removedRange.startSample
            : totalSourceSamples;
        if (nextRemovalStart > cutEnd) {
          transitions.push({
            transitionIndex: transitions.length,
            leftSegmentIndex: segIdx - 1,
            rightSegmentIndex: segIdx,
            sourceLeftCutSample: cutStart,
            sourceRightResumeSample: cutEnd,
            removedProposalId: rem.proposalId,
            requestedCrossfadeSamples,
            maxAdjustmentSamples,
            preferredCurve: config.crossfadeCurve ?? 'auto',
          });
        }
      }

      srcCursor = cutEnd;
    }

    // Trailing retained segment
    if (srcCursor < totalSourceSamples) {
      const len = totalSourceSamples - srcCursor;
      const srcStartFlicks = TimeMath.samplesToFlicks(srcCursor, sourceSampleRate);
      const srcEndFlicks = TimeMath.samplesToFlicks(totalSourceSamples, sourceSampleRate);
      const outStartFlicks = TimeMath.samplesToFlicks(outCursor, sourceSampleRate);
      const outEndFlicks = TimeMath.samplesToFlicks(outCursor + len, sourceSampleRate);

      retainedSegments.push({
        segmentIndex: segIdx,
        sourceStartSample: srcCursor,
        sourceEndSample: totalSourceSamples,
        sampleCount: len,
        outputStartSample: outCursor,
        outputEndSample: outCursor + len,
        sourceStartFlicks: srcStartFlicks,
        sourceEndFlicks: srcEndFlicks,
        outputStartFlicks: outStartFlicks,
        outputEndFlicks: outEndFlicks,
      });

      sourceToOutputMap.push({
        segmentIndex: segIdx,
        sourceStartSample: srcCursor,
        sourceEndSample: totalSourceSamples,
        outputStartSample: outCursor,
        outputEndSample: outCursor + len,
      });

      derivedTimelineClips.push({
        id: `rendered_clip_${segIdx}_${deterministicHexHash(`${sourceAudioId}:${srcCursor}:${totalSourceSamples}`)}`,
        trackId: targetTrackId,
        assetId: sourceAudioId,
        kind: 'AUDIO_ASSET',
        sourceRange: { start: srcStartFlicks, end: srcEndFlicks },
        timelineRange: { start: outStartFlicks, end: outEndFlicks },
        fadeInFlicks: segIdx > 0 ? TimeMath.secondsToFlicks(defaultCrossfadeMs / 1000) : 0,
        fadeOutFlicks: 0,
        gainDb: 0,
      });

      outCursor += len;
    }

    if (outCursor <= 0 || retainedSegments.length === 0) {
      failures.push({
        code: 'INVALID_SAMPLE_COORDINATES',
        severity: 'ERROR',
        message: 'Approved edits would remove 100% of the source audio, leaving an empty output.',
        actionableFix: 'Reject at least one removal so non-empty audio remains.',
      });
      return { ok: false, plan: null, failures };
    }

    const removedSampleCount = totalSourceSamples - outCursor;
    const expectedPreResampleOutputSamples = outCursor;
    const expectedOutputSamples =
      outputSampleRate === sourceSampleRate
        ? expectedPreResampleOutputSamples
        : Math.floor((expectedPreResampleOutputSamples * outputSampleRate) / sourceSampleRate);

    // 6. Determine container & enforce RIFF 4 GiB ceiling / quota guard
    let container: RenderExportContainer = config.container ?? 'wav';
    let estimate = estimateContainerOutputBytes({
      outputSamples: expectedOutputSamples,
      channelCount,
      encoding: config.encoding,
      container,
    });

    if (container === 'wav' && estimate.dataBytes > RIFF_WAV_MAX_DATA_BYTES) {
      if (config.autoUpgradeToRf64) {
        container = 'rf64';
        estimate = estimateContainerOutputBytes({
          outputSamples: expectedOutputSamples,
          channelCount,
          encoding: config.encoding,
          container,
        });
      } else {
        failures.push({
          code: 'OUTPUT_SIZE_EXCEEDS_RIFF_LIMIT',
          severity: 'ERROR',
          message: `Estimated WAV data payload (${estimate.dataBytes} B) exceeds the 32-bit RIFF WAV ceiling (${RIFF_WAV_MAX_DATA_BYTES} B).`,
          actionableFix: 'Enable RF64 container (container: "rf64") or reduce bit depth / split export.',
        });
        return { ok: false, plan: null, failures };
      }
    }

    if (
      typeof config.maxOutputBytesQuota === 'number' &&
      estimate.totalBytes > config.maxOutputBytesQuota
    ) {
      failures.push({
        code: 'OUTPUT_QUOTA_EXCEEDED',
        severity: 'ERROR',
        message: `Estimated output size (${estimate.totalBytes} B) exceeds available local storage quota (${config.maxOutputBytesQuota} B).`,
        actionableFix: 'Free local storage space or export with a smaller bit depth (e.g., pcm16).',
      });
      return { ok: false, plan: null, failures };
    }

    // 7. Build Undo/Redo metadata linking back to Mission 05 proposals without mutating them
    const undoMetadataItems: UndoRedoEditMetadata[] = validatedRemovals.map((rem) => ({
      operationIdHint: `render_tx_${edl.edlId}_v${edl.edlVersion}_${rem.proposalId}`,
      expectedProjectRevision: projectDocument?.revision ?? 1,
      expectedSourceAudioHash: sourceAudioHash,
      expectedTranscriptVersion: expectedTranscriptVersion,
      expectedEdlVersion: edl.edlVersion,
      sourceInterval: rem.originalRange,
      proposedInterval: rem.removedRange,
      timelineRangeFlicks: {
        start: rem.removedRange.startFlicks,
        end: rem.removedRange.endFlicks,
      },
      cutStrategy: 'GLOBAL_SYNC_RIPPLE',
      fadeInDurationFlicks: TimeMath.secondsToFlicks(defaultCrossfadeMs / 1000),
      fadeOutDurationFlicks: TimeMath.secondsToFlicks(defaultCrossfadeMs / 1000),
      injectRoomToneFlicks: 0,
      prosodicWarnings: [],
      affectedTokenIds: [],
      reversible: true,
    }));

    const canonicalKey = [
      AUDIO_RENDERER_VERSION,
      edl.projectId,
      sourceAudioId,
      sourceAudioHash,
      edl.edlId,
      String(edl.edlVersion),
      edl.transcriptVersion,
      String(sourceSampleRate),
      String(outputSampleRate),
      String(channelCount),
      config.encoding,
      container,
      retainedSegments.map((s) => `${s.sourceStartSample}-${s.sourceEndSample}`).join(','),
      validatedRemovals.map((r) => `${r.proposalId}@${r.proposalVersion}`).join(','),
    ].join('|');

    const planHash = `plan_${deterministicHexHash(canonicalKey)}`;
    const planId = `rplan_${deterministicHexHash(`${planHash}:${expectedOutputSamples}`)}`;

    const plan: ImmutableRenderPlan = deepFreeze({
      planId,
      planHash,
      rendererVersion: AUDIO_RENDERER_VERSION,
      projectId: edl.projectId,
      trackId: targetTrackId,
      sourceAudioId,
      sourceAudioHash,
      edlId: edl.edlId,
      edlVersion: edl.edlVersion,
      transcriptVersion: edl.transcriptVersion,
      timebaseFlicksPerSecond: FLICKS_PER_SECOND,
      sourceSampleRate,
      outputSampleRate,
      channelCount,
      totalSourceSamples,
      expectedPreResampleOutputSamples,
      expectedOutputSamples,
      sourceDurationSec: totalSourceSamples / sourceSampleRate,
      expectedOutputDurationSec: expectedOutputSamples / outputSampleRate,
      removedSampleCount,
      removedDurationSec: removedSampleCount / sourceSampleRate,
      encoding: config.encoding,
      container,
      estimatedOutputBytes: estimate.totalBytes,
      approvedProposalIds: validatedRemovals.map((r) => r.proposalId),
      retainedSegments,
      removedSegments: validatedRemovals,
      transitions,
      sourceToOutputMap,
      derivedTimelineClips,
      undoMetadataItems,
      createdAtMs: nowMs,
    });

    return { ok: true, plan, failures: [] };
  }
}

export interface SourceToOutputSampleLookup {
  readonly mapped: boolean;
  readonly outputSample: number | null;
  readonly segmentIndex: number | null;
  readonly removedByProposalId: string | null;
}

export interface OutputToSourceSampleLookup {
  readonly mapped: boolean;
  readonly sourceSample: number | null;
  readonly segmentIndex: number | null;
}

/**
 * Deterministic source-sample -> output-sample timeline coordinate mapper (pre-resample coordinates).
 * Returns exact output sample if retained, or identifies the removing proposalId if cut.
 */
export function mapSourceSampleToOutputSample(
  plan: ImmutableRenderPlan,
  sourceSample: number,
): SourceToOutputSampleLookup {
  if (!Number.isInteger(sourceSample) || sourceSample < 0 || sourceSample > plan.totalSourceSamples) {
    return { mapped: false, outputSample: null, segmentIndex: null, removedByProposalId: null };
  }

  for (const entry of plan.sourceToOutputMap) {
    if (
      sourceSample >= entry.sourceStartSample &&
      (sourceSample < entry.sourceEndSample ||
        (sourceSample === entry.sourceEndSample && sourceSample === plan.totalSourceSamples))
    ) {
      return {
        mapped: true,
        outputSample: entry.outputStartSample + (sourceSample - entry.sourceStartSample),
        segmentIndex: entry.segmentIndex,
        removedByProposalId: null,
      };
    }
  }

  for (const rem of plan.removedSegments) {
    if (sourceSample >= rem.removedRange.startSample && sourceSample < rem.removedRange.endSample) {
      return {
        mapped: false,
        outputSample: null,
        segmentIndex: null,
        removedByProposalId: rem.proposalId,
      };
    }
  }

  return { mapped: false, outputSample: null, segmentIndex: null, removedByProposalId: null };
}

/**
 * Deterministic output-sample -> original source-sample timeline coordinate mapper.
 * Enables exact reverse provenance lookup from rendered audio back to original source audio.
 */
export function mapOutputSampleToSourceSample(
  plan: ImmutableRenderPlan,
  outputSample: number,
): OutputToSourceSampleLookup {
  if (
    !Number.isInteger(outputSample) ||
    outputSample < 0 ||
    outputSample > plan.expectedPreResampleOutputSamples
  ) {
    return { mapped: false, sourceSample: null, segmentIndex: null };
  }

  for (const entry of plan.sourceToOutputMap) {
    if (
      outputSample >= entry.outputStartSample &&
      (outputSample < entry.outputEndSample ||
        (outputSample === entry.outputEndSample &&
          outputSample === plan.expectedPreResampleOutputSamples))
    ) {
      return {
        mapped: true,
        sourceSample: entry.sourceStartSample + (outputSample - entry.outputStartSample),
        segmentIndex: entry.segmentIndex,
      };
    }
  }

  return { mapped: false, sourceSample: null, segmentIndex: null };
}

