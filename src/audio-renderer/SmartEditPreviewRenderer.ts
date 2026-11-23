/**
 * AVAPARDAZ — ENGINE 03: SMART EDITOR RENDER CONFIG & REAL AUDIO PREVIEW RENDERER (AVP-RENDER-003)
 *
 * Generates genuine, playable WAV audio previews for:
 * - ORIGINAL: Unedited source window around a specific proposal (with lead-in/lead-out context)
 * - EDITED: Exact post-edit window around that proposal using the same length-preserving
 *   boundary refinement & centered crossfade math as AudioSegmentAssembler
 * - FULL: Complete edited recording preview routed directly through AudioRenderEngine
 *   (including 0-approved edits) so Preview and Export share the exact same canonical path
 *
 * Zero fake waveforms, zero full-file unbounded RAM loads, and strict non-destructive source protection.
 */

import type { SampleRate } from '../contracts/timebase.contract';
import type { EditDecisionListSnapshot } from '../ai-engine/edit-decision/EditDecisionTypes';
import type { AudioRenderConfig, AudioRenderResult, ChunkedPcmSource } from './AudioRenderTypes';
import { AudioRenderEngine } from './AudioRenderEngine';
import { AudioExportWriter, BoundedChunkedByteSink } from './AudioExportWriter';
import { AudioCrossfadeProcessor } from './AudioCrossfadeProcessor';
import { AudioBoundaryProcessor } from './AudioBoundaryProcessor';
import { AudioSourceReader } from './AudioSourceReader';
import {
  createCommittedRenderArtifact,
  readRenderArtifactToUint8Array,
} from './RenderOutputArtifact';
import { deterministicHexHash } from '../ai-engine/edit-decision/EditProvenance';
import type {
  PrecisionAudioRenderer,
  SmartEditPreviewRequest,
  SmartEditPreviewResult,
} from '../workflow/SmartAudioEditContracts';

export const SMART_EDITOR_RENDER_CONFIG: Readonly<
  Required<
    Pick<
      AudioRenderConfig,
      | 'encoding'
      | 'container'
      | 'autoUpgradeToRf64'
      | 'defaultCrossfadeMs'
      | 'minCrossfadeMs'
      | 'maxCrossfadeMs'
      | 'crossfadeCurve'
      | 'enableTransitionLimiter'
      | 'chunkSizeSamples'
      | 'maxBoundaryAdjustmentSamples'
    >
  >
> = Object.freeze({
  encoding: 'pcm24',
  container: 'wav',
  autoUpgradeToRf64: true,
  defaultCrossfadeMs: 10,
  minCrossfadeMs: 5,
  maxCrossfadeMs: 15,
  crossfadeCurve: 'equal-power',
  enableTransitionLimiter: true,
  chunkSizeSamples: 32768,
  maxBoundaryAdjustmentSamples: 240,
});

async function encodePlanarChannelsToWavBytes(params: {
  readonly channels: readonly Float32Array[];
  readonly sampleRate: SampleRate;
  readonly encoding: 'pcm16' | 'pcm24';
  readonly previewTag: string;
  readonly abortSignal?: AbortSignal;
}): Promise<Uint8Array> {
  const { channels, sampleRate, encoding, previewTag, abortSignal } = params;
  const totalSamples = channels[0]?.length ?? 0;
  const renderId = `prev_${deterministicHexHash(`${previewTag}:${sampleRate}:${encoding}:${totalSamples}`)}`;
  const artifactId = `art_${renderId}`;
  const sink = new BoundedChunkedByteSink();
  const writer = new AudioExportWriter({
    renderId,
    artifactId,
    container: 'wav',
    encoding,
    sampleRate,
    channelCount: channels.length,
    sink,
  });

  try {
    if (abortSignal?.aborted) {
      throw new Error('PREVIEW_CANCELLED');
    }
    await writer.begin();
    const chunkSize = SMART_EDITOR_RENDER_CONFIG.chunkSizeSamples;
    for (let offset = 0; offset < totalSamples; offset += chunkSize) {
      if (abortSignal?.aborted) {
        await writer.abort();
        throw new Error('PREVIEW_CANCELLED');
      }
      const end = Math.min(totalSamples, offset + chunkSize);
      const slice = channels.map((ch) => ch.subarray(offset, end));
      await writer.writePlanarChunk(slice, end - offset);
    }
    const metadata = await writer.finalize();
    const artifact = createCommittedRenderArtifact({
      artifactId: metadata.artifactId,
      sizeBytes: metadata.fileSizeBytes,
      sink,
    });
    try {
      return await readRenderArtifactToUint8Array(artifact, { abortSignal });
    } finally {
      await artifact.dispose();
    }
  } catch (err) {
    await writer.abort().catch(() => {});
    throw err;
  }
}

function concatPlanarSegments(segments: readonly (readonly Float32Array[])[]): Float32Array[] {
  const firstNonEmpty = segments.find((s) => s.length > 0);
  if (!firstNonEmpty) return [];
  const channelCount = firstNonEmpty.length;
  let totalLen = 0;
  for (const seg of segments) {
    if (seg.length > 0) {
      totalLen += seg[0].length;
    }
  }
  const out = Array.from({ length: channelCount }, () => new Float32Array(totalLen));
  let cursor = 0;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const len = seg[0].length;
    if (len === 0) continue;
    for (let c = 0; c < channelCount; c++) {
      out[c].set(seg[c], cursor);
    }
    cursor += len;
  }
  return out;
}

export class SmartEditPreviewRenderer implements PrecisionAudioRenderer {
  private readonly renderEngine: AudioRenderEngine;

  constructor(renderEngine?: AudioRenderEngine) {
    this.renderEngine = renderEngine ?? new AudioRenderEngine();
  }

  public async renderFinalAudio(params: {
    readonly edl: EditDecisionListSnapshot;
    readonly source: ChunkedPcmSource;
    readonly config?: Partial<AudioRenderConfig>;
    readonly proposalIds?: readonly string[];
    readonly abortSignal?: AbortSignal;
    readonly onProgress?: (progress: {
      readonly percent: number | null;
      readonly operation: string;
    }) => void;
  }): Promise<AudioRenderResult> {
    const mergedConfig: AudioRenderConfig = {
      ...SMART_EDITOR_RENDER_CONFIG,
      ...params.config,
    };

    return this.renderEngine.render({
      edl: params.edl,
      source: params.source,
      expectedSourceAudioHash: params.edl.sourceAudioHash,
      expectedTranscriptVersion: params.edl.transcriptVersion,
      expectedEdlVersion: params.edl.edlVersion,
      config: mergedConfig,
      proposalIds: params.proposalIds,
      abortSignal: params.abortSignal,
      onProgress: params.onProgress
        ? (snap) =>
            params.onProgress?.({
              percent: snap.progressPercent,
              operation: snap.currentOperation,
            })
        : undefined,
    });
  }

  public async generatePreview(request: SmartEditPreviewRequest): Promise<SmartEditPreviewResult> {
    const encoding = request.encoding ?? 'pcm16';
    const paddingMs = Math.max(250, Math.min(5000, request.contextPaddingMs ?? 1500));
    const rawCrossfadeMs =
      request.crossfadeMs !== undefined
        ? request.crossfadeMs
        : SMART_EDITOR_RENDER_CONFIG.defaultCrossfadeMs;
    const crossfadeMs =
      rawCrossfadeMs <= 0
        ? 0
        : Math.max(
            SMART_EDITOR_RENDER_CONFIG.minCrossfadeMs,
            Math.min(SMART_EDITOR_RENDER_CONFIG.maxCrossfadeMs, rawCrossfadeMs),
          );
    const { source, edl, mode } = request;

    if (request.abortSignal?.aborted) {
      return {
        ok: false,
        mode,
        proposalId: request.proposalId ?? null,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        durationSec: 0,
        totalSamples: 0,
        wavBytes: new Uint8Array(0),
        windowStartSample: 0,
        windowEndSample: 0,
        appliedProposalIds: [],
        failureReason: 'PREVIEW_CANCELLED',
      };
    }

    // FULL mode: ALWAYS route through the canonical AudioRenderEngine (including 0 approved edits)
    // so Preview and Final Export share the exact same bounded streaming, splice math, and validator.
    if (mode === 'FULL') {
      const approvedIds = edl.proposals
        .filter((p) => p.status === 'APPROVED')
        .map((p) => p.proposalId);

      const fullRender = await this.renderFinalAudio({
        edl,
        source,
        config: {
          ...SMART_EDITOR_RENDER_CONFIG,
          encoding,
          defaultCrossfadeMs: crossfadeMs,
        },
        proposalIds: approvedIds,
        abortSignal: request.abortSignal,
      });

      if (!fullRender.ok || !fullRender.outputArtifact || !fullRender.output) {
        return {
          ok: false,
          mode: 'FULL',
          proposalId: null,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
          durationSec: 0,
          totalSamples: 0,
          wavBytes: new Uint8Array(0),
          windowStartSample: 0,
          windowEndSample: source.totalSamples,
          appliedProposalIds: [],
          failureReason:
            fullRender.state === 'CANCELLED'
              ? 'PREVIEW_CANCELLED'
              : (fullRender.failureReason ?? 'FULL_PREVIEW_RENDER_FAILED'),
        };
      }

      try {
        const wavBytes = await readRenderArtifactToUint8Array(fullRender.outputArtifact, {
          abortSignal: request.abortSignal,
        });
        return {
          ok: true,
          mode: 'FULL',
          proposalId: null,
          sampleRate: fullRender.output.sampleRate,
          channelCount: fullRender.output.channelCount,
          durationSec: fullRender.output.durationSec,
          totalSamples: fullRender.output.totalOutputSamples,
          wavBytes,
          windowStartSample: 0,
          windowEndSample: source.totalSamples,
          appliedProposalIds: fullRender.appliedProposalIds,
        };
      } catch (err) {
        const reason =
          request.abortSignal?.aborted ||
          (err instanceof Error && err.message.includes('CANCELLED'))
            ? 'PREVIEW_CANCELLED'
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          ok: false,
          mode: 'FULL',
          proposalId: null,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
          durationSec: 0,
          totalSamples: 0,
          wavBytes: new Uint8Array(0),
          windowStartSample: 0,
          windowEndSample: source.totalSamples,
          appliedProposalIds: [],
          failureReason: reason,
        };
      } finally {
        await fullRender.outputArtifact.dispose();
      }
    }

    // Single-proposal A/B audition preview (ORIGINAL vs EDITED).
    // Strictly non-destructive: never mutates source audio or EDL approval status.
    const proposal = request.proposalId
      ? edl.proposals.find((p) => p.proposalId === request.proposalId)
      : edl.proposals.find(
          (p) =>
            p.operation === 'REMOVE_FILLER' ||
            p.operation === 'SHORTEN_SILENCE' ||
            p.operation === 'REMOVE_ACCIDENTAL_REPETITION',
        );

    if (!proposal || !proposal.originalRange) {
      return {
        ok: false,
        mode,
        proposalId: request.proposalId ?? null,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        durationSec: 0,
        totalSamples: 0,
        wavBytes: new Uint8Array(0),
        windowStartSample: 0,
        windowEndSample: 0,
        appliedProposalIds: [],
        failureReason: 'PROPOSAL_NOT_FOUND_OR_MISSING_RANGE',
      };
    }

    const paddingSamples = Math.round((paddingMs / 1000) * source.sampleRate);
    const removeStart = proposal.proposedRange?.startSample ?? proposal.originalRange.startSample;
    const removeEnd = proposal.proposedRange?.endSample ?? proposal.originalRange.endSample;

    if (
      !Number.isInteger(removeStart) ||
      !Number.isInteger(removeEnd) ||
      removeStart < 0 ||
      removeEnd <= removeStart ||
      removeEnd > source.totalSamples
    ) {
      return {
        ok: false,
        mode,
        proposalId: proposal.proposalId,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        durationSec: 0,
        totalSamples: 0,
        wavBytes: new Uint8Array(0),
        windowStartSample: 0,
        windowEndSample: 0,
        appliedProposalIds: [],
        failureReason: 'INVALID_SAMPLE_COORDINATES',
      };
    }

    const windowStart = Math.max(0, removeStart - paddingSamples);
    const windowEnd = Math.min(source.totalSamples, removeEnd + paddingSamples);

    const reader = new AudioSourceReader(source);
    try {
      if (mode === 'ORIGINAL') {
        const originalChannels = await reader.readRange(windowStart, windowEnd - windowStart);
        const wavBytes = await encodePlanarChannelsToWavBytes({
          channels: originalChannels,
          sampleRate: source.sampleRate,
          encoding,
          previewTag: `${proposal.proposalId}:ORIGINAL:${windowStart}:${windowEnd}`,
          abortSignal: request.abortSignal,
        });
        const totalSamples = originalChannels[0]?.length ?? 0;
        return {
          ok: true,
          mode: 'ORIGINAL',
          proposalId: proposal.proposalId,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
          durationSec: Number((totalSamples / source.sampleRate).toFixed(4)),
          totalSamples,
          wavBytes,
          windowStartSample: windowStart,
          windowEndSample: windowEnd,
          appliedProposalIds: [],
        };
      }

      // EDITED single-proposal audition preview using the EXACT same length-preserving
      // boundary refinement + centered 2*L crossfade algorithm as AudioSegmentAssembler.
      const leftLenRaw = Math.max(0, removeStart - windowStart);
      const rightLenRaw = Math.max(0, windowEnd - removeEnd);

      let effLeftEnd = removeStart;
      let effRightStart = removeEnd;

      if (leftLenRaw > 0 && rightLenRaw > 0) {
        const maxAdj = SMART_EDITOR_RENDER_CONFIG.maxBoundaryAdjustmentSamples;
        const evalRadius = Math.max(maxAdj + 64, Math.round(source.sampleRate * 0.02));
        const leftWinLen = Math.min(evalRadius, leftLenRaw);
        const rightWinLen = Math.min(evalRadius, rightLenRaw);

        const leftWindow = await reader.readRange(removeStart - leftWinLen, leftWinLen);
        const rightWindow = await reader.readRange(removeEnd, rightWinLen);

        const gapSamples = Math.max(0, removeEnd - removeStart);
        const extRadius = Math.min(maxAdj, gapSamples);
        const leftPostLen = Math.min(extRadius, Math.max(0, source.totalSamples - removeStart));
        const rightPreLen = Math.min(extRadius, Math.max(0, removeEnd));
        const leftPostWindow =
          leftPostLen > 0 ? await reader.readRange(removeStart, leftPostLen) : undefined;
        const rightPreWindow =
          rightPreLen > 0
            ? await reader.readRange(removeEnd - rightPreLen, rightPreLen)
            : undefined;

        const boundaryCheck = AudioBoundaryProcessor.evaluateAndRefineJunction({
          transitionIndex: 0,
          proposalId: proposal.proposalId,
          sampleRate: source.sampleRate,
          originalLeftSample: removeStart,
          originalRightSample: removeEnd,
          leftWindow,
          rightWindow,
          leftPostWindow,
          rightPreWindow,
          preserveTotalLength: true,
          maxAdjustmentSamples: maxAdj,
          maxLeftPullbackSamples: Math.max(0, Math.floor(leftLenRaw / 4)),
          maxRightAdvanceSamples: Math.max(0, Math.floor(rightLenRaw / 4)),
        });

        if (
          boundaryCheck.adjustmentApplied &&
          boundaryCheck.leftAdjustmentSamples === boundaryCheck.rightAdjustmentSamples &&
          boundaryCheck.adjustedLeftSample > windowStart + 2 &&
          boundaryCheck.adjustedRightSample < windowEnd - 2 &&
          boundaryCheck.adjustedLeftSample <= boundaryCheck.adjustedRightSample &&
          boundaryCheck.adjustedLeftSample <= source.totalSamples &&
          boundaryCheck.adjustedRightSample >= 0
        ) {
          effLeftEnd = boundaryCheck.adjustedLeftSample;
          effRightStart = boundaryCheck.adjustedRightSample;
        }
      }

      if (request.abortSignal?.aborted) {
        throw new Error('PREVIEW_CANCELLED');
      }

      const effLeftLen = Math.max(0, effLeftEnd - windowStart);
      const effRightLen = Math.max(0, windowEnd - effRightStart);
      const requestedFadeSamples =
        crossfadeMs === 0 ? 0 : Math.max(2, Math.round((crossfadeMs / 1000) * source.sampleRate));
      const requestedHalfFade = Math.floor(requestedFadeSamples / 2);
      const halfFade =
        effLeftLen > 0 && effRightLen > 0
          ? Math.max(
              0,
              Math.min(
                requestedHalfFade,
                Math.floor(effLeftLen / 3),
                Math.floor(effRightLen / 3),
                Math.max(0, source.totalSamples - effLeftEnd),
                Math.max(0, effRightStart),
              ),
            )
          : 0;

      let combined: Float32Array[];
      if (halfFade > 0) {
        const leftBodyLen = effLeftLen - halfFade;
        const rightBodyStart = effRightStart + halfFade;
        const rightBodyLen = effRightLen - halfFade;

        const leftBody =
          leftBodyLen > 0
            ? await reader.readRange(windowStart, leftBodyLen)
            : Array.from({ length: source.channelCount }, () => new Float32Array(0));
        const leftExt = await reader.readRange(effLeftEnd - halfFade, halfFade * 2);
        const rightExt = await reader.readRange(effRightStart - halfFade, halfFade * 2);
        const rightBody =
          rightBodyLen > 0
            ? await reader.readRange(rightBodyStart, rightBodyLen)
            : Array.from({ length: source.channelCount }, () => new Float32Array(0));

        const blended = AudioCrossfadeProcessor.blendTransition({
          transitionIndex: 0,
          proposalId: proposal.proposalId,
          leftTail: leftExt,
          rightHead: rightExt,
          preferredCurve: SMART_EDITOR_RENDER_CONFIG.crossfadeCurve,
          enableLimiter: SMART_EDITOR_RENDER_CONFIG.enableTransitionLimiter,
        });

        combined = concatPlanarSegments([leftBody, blended.blended, rightBody]);
      } else {
        const leftPart =
          effLeftLen > 0
            ? await reader.readRange(windowStart, effLeftLen)
            : Array.from({ length: source.channelCount }, () => new Float32Array(0));
        const rightPart =
          effRightLen > 0
            ? await reader.readRange(effRightStart, effRightLen)
            : Array.from({ length: source.channelCount }, () => new Float32Array(0));
        combined = concatPlanarSegments([leftPart, rightPart]);
      }

      const wavBytes = await encodePlanarChannelsToWavBytes({
        channels: combined,
        sampleRate: source.sampleRate,
        encoding,
        previewTag: `${proposal.proposalId}:EDITED:${windowStart}:${windowEnd}:${crossfadeMs}`,
        abortSignal: request.abortSignal,
      });
      const totalSamples = combined[0]?.length ?? 0;

      return {
        ok: true,
        mode: 'EDITED',
        proposalId: proposal.proposalId,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        durationSec: Number((totalSamples / source.sampleRate).toFixed(4)),
        totalSamples,
        wavBytes,
        windowStartSample: windowStart,
        windowEndSample: windowEnd,
        appliedProposalIds: [proposal.proposalId],
      };
    } catch (err) {
      const reason =
        request.abortSignal?.aborted ||
        (err instanceof Error && err.message.includes('CANCELLED'))
          ? 'PREVIEW_CANCELLED'
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        ok: false,
        mode,
        proposalId: proposal.proposalId,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        durationSec: 0,
        totalSamples: 0,
        wavBytes: new Uint8Array(0),
        windowStartSample: windowStart,
        windowEndSample: windowEnd,
        appliedProposalIds: [],
        failureReason: reason,
      };
    } finally {
      reader.dispose();
    }
  }
}
