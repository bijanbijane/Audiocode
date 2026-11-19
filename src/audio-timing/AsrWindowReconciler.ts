import {
  asAsrWindowSourceOffset,
  asResampledFramePosition,
  asSourceSamplePosition,
  AsrWindowRelativeSec,
  AsrWindowSourceOffset,
  SourceSamplePosition,
} from './SamplePosition';
import { resampledFrameToSourceSample, sourceSampleToResampledFrame } from './TimeConversion';

export const DEFAULT_ASR_WINDOW_SEC = 25 as const;
export const DEFAULT_ASR_OVERLAP_SEC = 3 as const;

export interface AsrWindowMappingContract {
  readonly windowId: string;
  readonly windowIndex: number;
  readonly sourceSampleRate: number;
  readonly windowSampleRate: number;
  readonly sourceStartSample: SourceSamplePosition;
  readonly sourceEndSample: SourceSamplePosition;
  readonly sourceOffset: AsrWindowSourceOffset;
  readonly actualInputSampleCount: number;
  readonly padBeforeSamples: number;
  readonly padAfterSamples: number;
  readonly overlapLeftSamples: number;
  readonly overlapRightSamples: number;
  /** Authoritative valid non-duplicate ownership zone in source samples */
  readonly validOutputStartSample: SourceSamplePosition;
  readonly validOutputEndSample: SourceSamplePosition;
}

export interface WindowPredictedToken {
  readonly tokenId: string;
  readonly windowId: string;
  readonly windowIndex: number;
  readonly text: string;
  readonly relativeStartSec: AsrWindowRelativeSec;
  readonly relativeEndSec: AsrWindowRelativeSec;
  readonly confidence: number | null;
  readonly modelId: string;
  readonly modelVersion: string;
}

export type OverlapReconciliationState =
  | 'RECONCILED'
  | 'CONFLICT'
  | 'AMBIGUOUS'
  | 'INSUFFICIENT_EVIDENCE';

export interface ReconciledSourceToken {
  readonly tokenId: string;
  readonly text: string;
  readonly sourceStartSample: SourceSamplePosition;
  readonly sourceEndSample: SourceSamplePosition;
  readonly sampleRate: number;
  readonly ownerWindowId: string;
  readonly ownerWindowIndex: number;
  readonly confidence: number | null;
  readonly reconciliationState: OverlapReconciliationState;
  readonly alternativeCandidateTokenIds: readonly string[];
  readonly provenanceNote: string;
}

export interface WindowReconciliationOutput {
  readonly tokens: readonly ReconciledSourceToken[];
  readonly deduplicatedOverlapCount: number;
  readonly preservedGenuineRepetitionCount: number;
  readonly ambiguousCount: number;
  readonly paddedTokensRejectedCount: number;
}

/**
 * Builds deterministic integer-sample ASR window mappings preserving the 25s window / 3s overlap contract.
 */
export function buildAsrWindowMappings(params: {
  readonly totalSourceSamples: number;
  readonly sourceSampleRate: number;
  readonly windowSampleRate?: number;
  readonly windowDurationSec?: number;
  readonly overlapDurationSec?: number;
  readonly padBeforeSamples?: number;
  readonly padAfterSamples?: number;
}): readonly AsrWindowMappingContract[] {
  if (!Number.isSafeInteger(params.totalSourceSamples) || params.totalSourceSamples <= 0) {
    throw new RangeError('totalSourceSamples must be a positive safe integer.');
  }
  if (!Number.isFinite(params.sourceSampleRate) || params.sourceSampleRate <= 0) {
    throw new RangeError('sourceSampleRate must be a positive finite number.');
  }
  const windowRate = params.windowSampleRate ?? 16000;
  if (!Number.isFinite(windowRate) || windowRate <= 0) {
    throw new RangeError('windowSampleRate must be a positive finite number.');
  }
  const winSec = params.windowDurationSec ?? DEFAULT_ASR_WINDOW_SEC;
  const ovSec = params.overlapDurationSec ?? DEFAULT_ASR_OVERLAP_SEC;
  if (
    !Number.isFinite(winSec) ||
    !Number.isFinite(ovSec) ||
    winSec <= 0 ||
    ovSec < 0 ||
    ovSec >= winSec
  ) {
    throw new RangeError(`Invalid ASR window/overlap configuration: window=${winSec}s overlap=${ovSec}s`);
  }

  const windowSourceSamples = Math.max(1, Math.round(winSec * params.sourceSampleRate));
  const overlapSourceSamples = Math.max(
    0,
    Math.min(windowSourceSamples - 1, Math.round(ovSec * params.sourceSampleRate)),
  );
  const strideSourceSamples = Math.max(1, windowSourceSamples - overlapSourceSamples);
  const padBefore =
    Number.isFinite(params.padBeforeSamples) && (params.padBeforeSamples as number) > 0
      ? Math.trunc(params.padBeforeSamples as number)
      : 0;
  const padAfter =
    Number.isFinite(params.padAfterSamples) && (params.padAfterSamples as number) > 0
      ? Math.trunc(params.padAfterSamples as number)
      : 0;

  const windows: AsrWindowMappingContract[] = [];
  let start = 0;
  let idx = 0;

  while (start < params.totalSourceSamples) {
    const end = Math.min(params.totalSourceSamples, start + windowSourceSamples);
    const hasPrev = idx > 0;
    const hasNext = end < params.totalSourceSamples;
    const overlapLeft = hasPrev ? overlapSourceSamples : 0;
    const overlapRight = hasNext ? overlapSourceSamples : 0;

    // Midpoint cutover ownership inside overlap zones
    const validStart = hasPrev ? start + Math.floor(overlapLeft / 2) : start;
    const validEnd = hasNext ? end - Math.floor(overlapRight / 2) : end;

    const resampledInputCount = Math.max(
      1,
      sourceSampleToResampledFrame(asSourceSamplePosition(end), params.sourceSampleRate, windowRate) -
        sourceSampleToResampledFrame(asSourceSamplePosition(start), params.sourceSampleRate, windowRate),
    );

    windows.push({
      windowId: `asr_win_${idx}`,
      windowIndex: idx,
      sourceSampleRate: params.sourceSampleRate,
      windowSampleRate: windowRate,
      sourceStartSample: asSourceSamplePosition(start),
      sourceEndSample: asSourceSamplePosition(end),
      sourceOffset: asAsrWindowSourceOffset(start),
      actualInputSampleCount: resampledInputCount,
      padBeforeSamples: padBefore,
      padAfterSamples: padAfter,
      overlapLeftSamples: overlapLeft,
      overlapRightSamples: overlapRight,
      validOutputStartSample: asSourceSamplePosition(Math.min(validStart, end)),
      validOutputEndSample: asSourceSamplePosition(Math.max(validStart, Math.min(validEnd, end))),
    });

    if (end >= params.totalSourceSamples) break;
    start += strideSourceSamples;
    idx += 1;
  }

  return windows;
}

/**
 * Translates an ASR window-relative timestamp to authoritative source sample coordinates,
 * rejecting timestamps that fall strictly inside synthetic context padding.
 */
export function mapWindowTokenToSourceRange(
  window: AsrWindowMappingContract,
  relativeStartSec: AsrWindowRelativeSec,
  relativeEndSec: AsrWindowRelativeSec,
): {
  readonly valid: boolean;
  readonly insidePaddingOnly: boolean;
  readonly sourceStartSample: SourceSamplePosition;
  readonly sourceEndSample: SourceSamplePosition;
} {
  const fallbackSample =
    Number.isSafeInteger(window.sourceStartSample) && window.sourceStartSample >= 0
      ? window.sourceStartSample
      : asSourceSamplePosition(0);
  if (
    !Number.isFinite(relativeStartSec) ||
    !Number.isFinite(relativeEndSec) ||
    relativeEndSec <= relativeStartSec ||
    !Number.isSafeInteger(window.windowSampleRate) ||
    window.windowSampleRate <= 0 ||
    !Number.isSafeInteger(window.sourceSampleRate) ||
    window.sourceSampleRate <= 0 ||
    !Number.isFinite(window.actualInputSampleCount) ||
    window.actualInputSampleCount <= 0
  ) {
    return {
      valid: false,
      insidePaddingOnly: false,
      sourceStartSample: fallbackSample,
      sourceEndSample: fallbackSample,
    };
  }
  const padBefore =
    Number.isFinite(window.padBeforeSamples) && window.padBeforeSamples > 0
      ? Math.trunc(window.padBeforeSamples)
      : 0;
  const startWindowFrame = Math.round(relativeStartSec * window.windowSampleRate);
  const endWindowFrame = Math.round(relativeEndSec * window.windowSampleRate);

  // Subtract leading padding frames so padding is never mistaken for real audio
  const unpaddedStart = startWindowFrame - padBefore;
  const unpaddedEnd = endWindowFrame - padBefore;

  if (unpaddedEnd <= 0 || unpaddedStart >= window.actualInputSampleCount) {
    return {
      valid: false,
      insidePaddingOnly: true,
      sourceStartSample: fallbackSample,
      sourceEndSample: fallbackSample,
    };
  }

  const clampedStartFrame = asResampledFramePosition(Math.max(0, unpaddedStart));
  const clampedEndFrame = asResampledFramePosition(
    Math.min(Math.trunc(window.actualInputSampleCount), Math.max(clampedStartFrame, unpaddedEnd)),
  );

  const deltaStartSource = resampledFrameToSourceSample(
    clampedStartFrame,
    window.sourceSampleRate,
    window.windowSampleRate,
  );
  const deltaEndSource = resampledFrameToSourceSample(
    clampedEndFrame,
    window.sourceSampleRate,
    window.windowSampleRate,
  );

  const sourceStart = asSourceSamplePosition(
    Math.min(window.sourceEndSample, fallbackSample + deltaStartSource),
  );
  const sourceEnd = asSourceSamplePosition(
    Math.min(window.sourceEndSample, Math.max(sourceStart, fallbackSample + deltaEndSource)),
  );

  return {
    valid: sourceEnd > sourceStart,
    insidePaddingOnly: false,
    sourceStartSample: sourceStart,
    sourceEndSample: sourceEnd,
  };
}

/**
 * Reconciles out-of-order window predictions into a deterministic, chronologically sorted source transcript.
 * NEVER deduplicates solely by text equality: legitimate repeated Persian words (e.g. «بله بله» or stutters)
 * occupy distinct source sample coordinates and are preserved!
 */
export function reconcileOverlappingAsrWindows(params: {
  readonly windows: readonly AsrWindowMappingContract[];
  readonly predictionsByWindow: ReadonlyArray<{
    readonly windowId: string;
    readonly tokens: readonly WindowPredictedToken[];
  }>;
  readonly cancelled?: boolean;
}): WindowReconciliationOutput {
  if (params.cancelled) {
    return {
      tokens: [],
      deduplicatedOverlapCount: 0,
      preservedGenuineRepetitionCount: 0,
      ambiguousCount: 0,
      paddedTokensRejectedCount: 0,
    };
  }

  const sanitizeConfidence = (c: number | null | undefined): number | null =>
    typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;

  const windowById = new Map(params.windows.map((w) => [w.windowId, w]));
  // Sort by authoritative windowIndex regardless of async completion order!
  const sortedBatches = [...params.predictionsByWindow].sort((a, b) => {
    const wa = windowById.get(a.windowId)?.windowIndex ?? 0;
    const wb = windowById.get(b.windowId)?.windowIndex ?? 0;
    return wa - wb;
  });

  const mappedCandidates: Array<{
    readonly raw: WindowPredictedToken;
    readonly sanitizedConfidence: number | null;
    readonly window: AsrWindowMappingContract;
    readonly sourceStartSample: SourceSamplePosition;
    readonly sourceEndSample: SourceSamplePosition;
    readonly midpointSample: number;
  }> = [];

  let paddedTokensRejectedCount = 0;

  for (const batch of sortedBatches) {
    const win = windowById.get(batch.windowId);
    if (!win) continue;
    for (const tok of batch.tokens) {
      const mapped = mapWindowTokenToSourceRange(win, tok.relativeStartSec, tok.relativeEndSec);
      if (mapped.insidePaddingOnly || !mapped.valid) {
        paddedTokensRejectedCount += 1;
        continue;
      }
      mappedCandidates.push({
        raw: tok,
        sanitizedConfidence: sanitizeConfidence(tok.confidence),
        window: win,
        sourceStartSample: mapped.sourceStartSample,
        sourceEndSample: mapped.sourceEndSample,
        midpointSample: Math.floor((mapped.sourceStartSample + mapped.sourceEndSample) / 2),
      });
    }
  }

  // Sort chronologically by sourceStartSample, then windowIndex
  mappedCandidates.sort(
    (a, b) =>
      a.sourceStartSample - b.sourceStartSample ||
      a.window.windowIndex - b.window.windowIndex,
  );

  const accepted: ReconciledSourceToken[] = [];
  let deduplicatedOverlapCount = 0;
  let preservedGenuineRepetitionCount = 0;
  let ambiguousCount = 0;

  const normalizeForOverlapCheck = (t: string) =>
    t.trim().toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک');

  for (const cand of mappedCandidates) {
    const prev = accepted.length > 0 ? accepted[accepted.length - 1] : null;
    if (!prev) {
      accepted.push({
        tokenId: cand.raw.tokenId,
        text: cand.raw.text,
        sourceStartSample: cand.sourceStartSample,
        sourceEndSample: cand.sourceEndSample,
        sampleRate: cand.window.sourceSampleRate,
        ownerWindowId: cand.window.windowId,
        ownerWindowIndex: cand.window.windowIndex,
        confidence: cand.sanitizedConfidence,
        reconciliationState: 'RECONCILED',
        alternativeCandidateTokenIds: [],
        provenanceNote: `Owned by ${cand.window.windowId}`,
      });
      continue;
    }

    const fromDifferentAdjacentWindow = cand.window.windowIndex !== prev.ownerWindowIndex;
    const overlapSamples = Math.min(prev.sourceEndSample, cand.sourceEndSample) - Math.max(prev.sourceStartSample, cand.sourceStartSample);
    const minDuration = Math.max(1, Math.min(prev.sourceEndSample - prev.sourceStartSample, cand.sourceEndSample - cand.sourceStartSample));
    const temporalOverlapRatio = overlapSamples / minDuration;
    const sameNormalizedText =
      normalizeForOverlapCheck(prev.text) === normalizeForOverlapCheck(cand.raw.text);

    // Case 1: Genuine duplicate prediction of the SAME acoustic event across adjacent overlapping windows
    if (fromDifferentAdjacentWindow && temporalOverlapRatio >= 0.45 && sameNormalizedText) {
      deduplicatedOverlapCount += 1;
      // Keep the token belonging to the authoritative midpoint ownership region (or higher confidence)
      const candInValidZone =
        cand.midpointSample >= cand.window.validOutputStartSample &&
        cand.midpointSample <= cand.window.validOutputEndSample;
      if (candInValidZone && (cand.sanitizedConfidence ?? 0) >= (prev.confidence ?? 0)) {
        accepted[accepted.length - 1] = {
          tokenId: cand.raw.tokenId,
          text: cand.raw.text,
          sourceStartSample: cand.sourceStartSample,
          sourceEndSample: cand.sourceEndSample,
          sampleRate: cand.window.sourceSampleRate,
          ownerWindowId: cand.window.windowId,
          ownerWindowIndex: cand.window.windowIndex,
          confidence: cand.sanitizedConfidence,
          reconciliationState: 'RECONCILED',
          alternativeCandidateTokenIds: [...prev.alternativeCandidateTokenIds, prev.tokenId],
          provenanceNote: `Reconciled overlap duplicate from ${prev.ownerWindowId} -> ${cand.window.windowId}`,
        };
      }
      continue;
    }

    // Case 2: Temporal overlap across adjacent windows with DIFFERENT text -> AMBIGUOUS (preserve, do NOT silently delete!)
    if (fromDifferentAdjacentWindow && temporalOverlapRatio >= 0.55 && !sameNormalizedText) {
      ambiguousCount += 1;
      accepted.push({
        tokenId: cand.raw.tokenId,
        text: cand.raw.text,
        sourceStartSample: cand.sourceStartSample,
        sourceEndSample: cand.sourceEndSample,
        sampleRate: cand.window.sourceSampleRate,
        ownerWindowId: cand.window.windowId,
        ownerWindowIndex: cand.window.windowIndex,
        confidence: cand.sanitizedConfidence,
        reconciliationState: 'AMBIGUOUS',
        alternativeCandidateTokenIds: [prev.tokenId],
        provenanceNote: `Overlap disagreement with ${prev.ownerWindowId}; preserved without silent deletion.`,
      });
      continue;
    }

    // Case 3: Identical text at DISTINCT temporal positions -> genuine repeated Persian speech / stutter!
    if (sameNormalizedText && temporalOverlapRatio < 0.2) {
      preservedGenuineRepetitionCount += 1;
    }

    accepted.push({
      tokenId: cand.raw.tokenId,
      text: cand.raw.text,
      sourceStartSample: cand.sourceStartSample,
      sourceEndSample: cand.sourceEndSample,
      sampleRate: cand.window.sourceSampleRate,
      ownerWindowId: cand.window.windowId,
      ownerWindowIndex: cand.window.windowIndex,
      confidence: cand.sanitizedConfidence,
      reconciliationState: 'RECONCILED',
      alternativeCandidateTokenIds: [],
      provenanceNote: `Owned by ${cand.window.windowId}`,
    });
  }

  return {
    tokens: accepted,
    deduplicatedOverlapCount,
    preservedGenuineRepetitionCount,
    ambiguousCount,
    paddedTokensRejectedCount,
  };
}
