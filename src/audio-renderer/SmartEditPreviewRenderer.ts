/**
 * AVAPARDAZ — ENGINE 03: SMART EDITOR RENDER CONFIG & REAL AUDIO PREVIEW RENDERER (AVP-RENDER-003)
 *
 * Generates genuine, playable WAV audio previews for:
 * - ORIGINAL: Unedited source window around a specific proposal (with lead-in/lead-out context)
 * - EDITED: Exact post-edit window around that proposal with boundary refinement & equal-power crossfade
 * - FULL: Complete edited recording preview using currently approved proposals
 *
 * Zero fake waveforms or simulated previews — every preview is rendered through the real
 * sample-exact AudioRenderEngine / AudioCrossfadeProcessor / AudioExportWriter pipeline.
 */

import type { SampleRate } from '../contracts/timebase.contract';
import type { EditDecisionListSnapshot } from '../ai-engine/edit-decision/EditDecisionTypes';
import type { AudioRenderConfig, AudioRenderResult, ChunkedPcmSource } from './AudioRenderTypes';
import { AudioRenderEngine } from './AudioRenderEngine';
import { AudioExportWriter } from './AudioExportWriter';
import { AudioCrossfadeProcessor } from './AudioCrossfadeProcessor';
import { AudioBoundaryProcessor } from './AudioBoundaryProcessor';
import { AudioSourceReader } from './AudioSourceReader';
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
}): Promise<Uint8Array> {
  const { channels, sampleRate, encoding } = params;
  const totalSamples = channels[0]?.length ?? 0;
  const writer = new AudioExportWriter({
    container: 'wav',
    encoding,
    sampleRate,
    channelCount: channels.length,
    expectedOutputSamples: totalSamples,
  });
  await writer.initialize();
  const chunkSize = SMART_EDITOR_RENDER_CONFIG.chunkSizeSamples;
  for (let offset = 0; offset < totalSamples; offset += chunkSize) {
    const end = Math.min(totalSamples, offset + chunkSize);
    const slice = channels.map((ch) => ch.subarray(offset, end));
    await writer.writePlanarChunk(slice);
  }
  const finalized = await writer.finalize();
  const totalBytes = finalized.artifact.sizeBytes;
  const bytes = await finalized.artifact.readRange(0, totalBytes);
  await finalized.artifact.dispose();
  return bytes;
}

function concatPlanar(a: readonly Float32Array[], b: readonly Float32Array[]): Float32Array[] {
  return a.map((chA, c) => {
    const chB = b[c];
    const out = new Float32Array(chA.length + chB.length);
    out.set(chA, 0);
    out.set(chB, chA.length);
    return out;
  });
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
    const crossfadeMs = Math.max(
      SMART_EDITOR_RENDER_CONFIG.minCrossfadeMs,
      Math.min(
        SMART_EDITOR_RENDER_CONFIG.maxCrossfadeMs,
        request.crossfadeMs ?? SMART_EDITOR_RENDER_CONFIG.defaultCrossfadeMs,
      ),
    );
    const { source, edl, mode } = request;

    if (mode === 'FULL') {
      const approvedIds = edl.proposals
        .filter((p) => p.status === 'APPROVED')
        .map((p) => p.proposalId);

      // If nothing is approved yet, stream the unmodified source into a clean preview WAV
      if (approvedIds.length === 0) {
        const reader = new AudioSourceReader(source);
        try {
          const allChannels = await reader.readRange(0, source.totalSamples);
          const wavBytes = await encodePlanarChannelsToWavBytes({
            channels: allChannels,
            sampleRate: source.sampleRate,
            encoding,
          });
          return {
            ok: true,
            mode: 'FULL',
            proposalId: null,
            sampleRate: source.sampleRate,
            channelCount: source.channelCount,
            durationSec: Number((source.totalSamples / source.sampleRate).toFixed(4)),
            totalSamples: source.totalSamples,
            wavBytes,
            windowStartSample: 0,
            windowEndSample: source.totalSamples,
            appliedProposalIds: [],
          };
        } finally {
          reader.dispose();
        }
      }

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
          failureReason: fullRender.failureReason ?? 'FULL_PREVIEW_RENDER_FAILED',
        };
      }

      try {
        const wavBytes = await fullRender.outputArtifact.readRange(
          0,
          fullRender.outputArtifact.sizeBytes,
        );
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
      } finally {
        await fullRender.outputArtifact.dispose();
      }
    }

    // Single-proposal A/B preview (ORIGINAL vs EDITED)
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

      // EDITED single-proposal preview with acoustic boundary refinement + equal-power crossfade
      const maxAdj = SMART_EDITOR_RENDER_CONFIG.maxBoundaryAdjustmentSamples;
      const boundaryCheck = await AudioBoundaryProcessor.refineAndAssessTransition({
        reader,
        transitionIndex: 0,
        proposalId: proposal.proposalId,
        leftCutSample: removeStart,
        rightResumeSample: removeEnd,
        leftSegmentStartSample: windowStart,
        rightSegmentEndSample: windowEnd,
        maxAdjustmentSamples: maxAdj,
        sampleRate: source.sampleRate,
      });

      const leftEnd = Math.max(windowStart, Math.min(removeStart, boundaryCheck.adjustedLeftSample));
      const rightStart = Math.min(
        windowEnd,
        Math.max(removeEnd, boundaryCheck.adjustedRightSample),
      );

      const leftPart = await reader.readRange(windowStart, Math.max(0, leftEnd - windowStart));
      const rightPart = await reader.readRange(rightStart, Math.max(0, windowEnd - rightStart));

      const leftLen = leftPart[0]?.length ?? 0;
      const rightLen = rightPart[0]?.length ?? 0;
      const requestedFadeSamples = Math.round((crossfadeMs / 1000) * source.sampleRate);
      const effectiveFade = Math.min(requestedFadeSamples, Math.floor(leftLen / 2), Math.floor(rightLen / 2));

      let combined: Float32Array[];
      if (effectiveFade >= 8) {
        const leftBody = leftPart.map((ch) => ch.subarray(0, leftLen - effectiveFade));
        const leftTail = leftPart.map((ch) => ch.subarray(leftLen - effectiveFade, leftLen));
        const rightHead = rightPart.map((ch) => ch.subarray(0, effectiveFade));
        const rightBody = rightPart.map((ch) => ch.subarray(effectiveFade, rightLen));

        const faded = AudioCrossfadeProcessor.applyTransition({
          transitionIndex: 0,
          proposalId: proposal.proposalId,
          leftTail,
          rightHead,
          requestedSamples: effectiveFade,
          minSamples: Math.min(
            effectiveFade,
            Math.round((SMART_EDITOR_RENDER_CONFIG.minCrossfadeMs / 1000) * source.sampleRate),
          ),
          maxSamples: Math.round(
            (SMART_EDITOR_RENDER_CONFIG.maxCrossfadeMs / 1000) * source.sampleRate,
          ),
          preferredCurve: SMART_EDITOR_RENDER_CONFIG.crossfadeCurve,
          enableLimiter: SMART_EDITOR_RENDER_CONFIG.enableTransitionLimiter,
        });

        combined = concatPlanar(concatPlanar(leftBody, faded.mixedChannels), rightBody);
      } else {
        combined = concatPlanar(leftPart, rightPart);
      }

      const wavBytes = await encodePlanarChannelsToWavBytes({
        channels: combined,
        sampleRate: source.sampleRate,
        encoding,
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
    } finally {
      reader.dispose();
    }
  }
}
