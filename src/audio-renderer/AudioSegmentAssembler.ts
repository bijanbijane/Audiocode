import { StreamingKaiserSincResampler } from '../engine/resampler';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import { AudioBoundaryProcessor } from './AudioBoundaryProcessor';
import { AudioCrossfadeProcessor } from './AudioCrossfadeProcessor';
import { AudioSourceReader } from './AudioSourceReader';
import {
  BoundaryCheckRecord,
  CrossfadeTransitionResult,
  ImmutableRenderPlan,
  RenderCheckpoint,
} from './AudioRenderTypes';

export interface AssemblyChunkCallbackPayload {
  readonly planarChannels: Float32Array[];
  readonly sampleCount: number;
  readonly segmentIndex: number;
  readonly nextSegmentSampleOffset: number;
  readonly processedSourceSamples: number;
}

export interface SegmentAssemblyOptions {
  readonly plan: ImmutableRenderPlan;
  readonly reader: AudioSourceReader;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly baseChunkSizeSamples?: number;
  readonly enableTransitionLimiter?: boolean;
  readonly resumeFromCheckpoint?: RenderCheckpoint | null;
  readonly abortSignal?: AbortSignal;
  readonly shouldPauseUser?: () => boolean;
  readonly onChunkReady: (payload: AssemblyChunkCallbackPayload) => Promise<void> | void;
  readonly onProgress?: (info: {
    readonly segmentIndex: number;
    readonly processedSourceSamples: number;
    readonly writtenOutputSamples: number;
  }) => void;
}

export interface SegmentAssemblyOutcome {
  readonly status: 'COMPLETED' | 'CANCELLED' | 'PAUSED_MEMORY_PRESSURE' | 'PAUSED_USER';
  readonly boundaryChecks: readonly BoundaryCheckRecord[];
  readonly crossfadeResults: readonly CrossfadeTransitionResult[];
  readonly lastCompletedSegmentIndex: number;
  readonly nextSegmentSampleOffset: number;
  readonly totalEmittedOutputSamples: number;
  readonly peakReservedBytes: number;
  readonly reason?: string;
}

function yieldCooperatively(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Memory-Bounded Streaming Audio Segment Assembler (AVP-P06-001)
 *
 * Streams retained segments sequentially in bounded chunks, applies bounded
 * acoustic boundary evaluation & crossfades at splice junctions, optionally
 * resamples per-channel when intentionally requested, adapts chunk size under
 * memory pressure, and yields cooperatively to keep the UI responsive.
 * Never allocates a full-file PCM buffer.
 */
export class AudioSegmentAssembler {
  public static async assembleStream(
    options: SegmentAssemblyOptions,
  ): Promise<SegmentAssemblyOutcome> {
    const {
      plan,
      reader,
      enableTransitionLimiter = true,
      resumeFromCheckpoint,
      abortSignal,
      shouldPauseUser,
      onChunkReady,
      onProgress,
    } = options;

    const budget = options.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    const baseChunkSamples = Math.max(
      1024,
      Math.min(65536, Math.trunc(options.baseChunkSizeSamples ?? 16384)),
    );

    const needsResample = plan.outputSampleRate !== plan.sourceSampleRate;
    const resamplers = needsResample
      ? Array.from(
          { length: plan.channelCount },
          () => new StreamingKaiserSincResampler(plan.sourceSampleRate, plan.outputSampleRate),
        )
      : null;

    const boundaryChecks: BoundaryCheckRecord[] = [];
    const crossfadeResults: CrossfadeTransitionResult[] = [];

    // Pre-compute effective segment boundaries (original coordinates + bounded transition analysis)
    const effectiveStarts = plan.retainedSegments.map((s) => s.sourceStartSample);
    const effectiveEnds = plan.retainedSegments.map((s) => s.sourceEndSample);
    const transitionFadeLengths = new Map<number, number>(); // key = leftSegmentIndex
    const transitionByLeftSeg = new Map<number, (typeof plan.transitions)[number]>();

    for (const tr of plan.transitions) {
      transitionByLeftSeg.set(tr.leftSegmentIndex, tr);
    }

    // Evaluate each transition junction using small bounded windows only
    for (const tr of plan.transitions) {
      const leftSeg = plan.retainedSegments[tr.leftSegmentIndex];
      const rightSeg = plan.retainedSegments[tr.rightSegmentIndex];
      if (!leftSeg || !rightSeg) continue;

      const evalRadius = Math.max(
        tr.maxAdjustmentSamples + 64,
        Math.round(plan.sourceSampleRate * 0.02),
      );
      const leftWinLen = Math.min(evalRadius, leftSeg.sampleCount);
      const rightWinLen = Math.min(evalRadius, rightSeg.sampleCount);

      const leftWindow = await reader.readRange(
        leftSeg.sourceEndSample - leftWinLen,
        leftWinLen,
      );
      const rightWindow = await reader.readRange(rightSeg.sourceStartSample, rightWinLen);

      const check = AudioBoundaryProcessor.evaluateAndRefineJunction({
        transitionIndex: tr.transitionIndex,
        proposalId: tr.removedProposalId,
        sampleRate: plan.sourceSampleRate,
        originalLeftSample: leftSeg.sourceEndSample,
        originalRightSample: rightSeg.sourceStartSample,
        leftWindow,
        rightWindow,
        maxAdjustmentSamples: tr.maxAdjustmentSamples,
        maxLeftPullbackSamples: Math.max(0, Math.floor(leftSeg.sampleCount / 4)),
        maxRightAdvanceSamples: Math.max(0, Math.floor(rightSeg.sampleCount / 4)),
      });
      boundaryChecks.push(check);

      // Keep exact total output sample count invariant by NOT altering segment length when
      // applying in-place crossfade over the junction edges, unless bounded shift is symmetric.
      // We clamp crossfade length strictly within both segments' available samples.
      const maxSafeFade = Math.min(
        tr.requestedCrossfadeSamples,
        Math.floor(leftSeg.sampleCount / 3),
        Math.floor(rightSeg.sampleCount / 3),
      );
      transitionFadeLengths.set(tr.leftSegmentIndex, Math.max(0, maxSafeFade));
    }

    let startSegmentIndex = 0;
    let initialSegmentOffset = 0;
    let totalEmittedOutputSamples = 0;
    let processedSourceSamples = 0;

    if (resumeFromCheckpoint) {
      startSegmentIndex = Math.max(0, resumeFromCheckpoint.completedSegmentIndex);
      initialSegmentOffset = Math.max(0, resumeFromCheckpoint.nextSegmentSampleOffset);
      totalEmittedOutputSamples = Math.max(0, resumeFromCheckpoint.writtenOutputSamples);
      for (let i = 0; i < startSegmentIndex && i < plan.retainedSegments.length; i++) {
        processedSourceSamples += plan.retainedSegments[i].sampleCount;
      }
      processedSourceSamples += initialSegmentOffset;
    }

    let peakReservedBytes = budget.getSnapshot().accountedBytes;
    let pendingLeftTail: Float32Array[] | null = null;
    let pendingTransitionForTail: (typeof plan.transitions)[number] | null = null;

    const emitPlanarChunk = async (
      channels: Float32Array[],
      segIdx: number,
      nextOffset: number,
    ): Promise<void> => {
      if (channels.length === 0 || channels[0].length === 0) return;

      if (!resamplers) {
        const len = channels[0].length;
        await onChunkReady({
          planarChannels: channels,
          sampleCount: len,
          segmentIndex: segIdx,
          nextSegmentSampleOffset: nextOffset,
          processedSourceSamples,
        });
        totalEmittedOutputSamples += len;
        onProgress?.({
          segmentIndex: segIdx,
          processedSourceSamples,
          writtenOutputSamples: totalEmittedOutputSamples,
        });
        return;
      }

      const resampled = resamplers.map((r, c) => r.pushChunk(channels[c]));
      const outLen = resampled[0]?.length ?? 0;
      if (outLen > 0) {
        await onChunkReady({
          planarChannels: resampled,
          sampleCount: outLen,
          segmentIndex: segIdx,
          nextSegmentSampleOffset: nextOffset,
          processedSourceSamples,
        });
        totalEmittedOutputSamples += outLen;
        onProgress?.({
          segmentIndex: segIdx,
          processedSourceSamples,
          writtenOutputSamples: totalEmittedOutputSamples,
        });
      }
    };

    for (let segIdx = startSegmentIndex; segIdx < plan.retainedSegments.length; segIdx++) {
      const seg = plan.retainedSegments[segIdx];
      const segStart = effectiveStarts[segIdx];
      const segEnd = effectiveEnds[segIdx];
      const segTotal = segEnd - segStart;

      // Crossfade tail reserved at the END of this segment if there is an outgoing transition
      const outgoingFadeSamples = transitionFadeLengths.get(segIdx) ?? 0;
      const bodyEndOffset = Math.max(0, segTotal - outgoingFadeSamples);

      let offset = segIdx === startSegmentIndex ? initialSegmentOffset : 0;

      // If previous segment left a pending tail for an incoming transition, blend with head of this segment
      if (pendingLeftTail && pendingTransitionForTail && offset === 0) {
        const fadeLen = pendingLeftTail[0].length;
        const rightHead = await reader.readRange(segStart, fadeLen);
        const { blended, result } = AudioCrossfadeProcessor.blendTransition({
          transitionIndex: pendingTransitionForTail.transitionIndex,
          proposalId: pendingTransitionForTail.removedProposalId,
          leftTail: pendingLeftTail,
          rightHead,
          preferredCurve: pendingTransitionForTail.preferredCurve,
          enableLimiter: enableTransitionLimiter,
        });
        crossfadeResults.push(result);
        // To preserve exact integer sample count equal to sum(retainedSegments.sampleCount),
        // we emit the blended crossfade window over the outgoing tail's duration and also keep
        // the incoming head's second half seamlessly so zero samples are lost:
        // Specifically: left tail had length L, right head had length L.
        // We emit a 2*L smooth junction (L samples transitioning left->mid, L samples mid->right)
        // by fading leftTail out over its L samples and fading rightHead in over its L samples.
        const outLeftHalf = Array.from({ length: plan.channelCount }, () => new Float32Array(fadeLen));
        const outRightHalf = Array.from({ length: plan.channelCount }, () => new Float32Array(fadeLen));
        const denom = Math.max(1, fadeLen - 1);
        for (let i = 0; i < fadeLen; i++) {
          const halfT = i / denom;
          const wOut = 0.5 * (1 + Math.cos(Math.PI * 0.5 * halfT));
          const wIn = 0.5 * (1 - Math.cos(Math.PI * 0.5 * halfT));
          for (let c = 0; c < plan.channelCount; c++) {
            outLeftHalf[c][i] = pendingLeftTail[c][i] * wOut + blended[c][i] * (1 - wOut);
            outRightHalf[c][i] = blended[c][i] * (1 - wIn) + rightHead[c][i] * wIn;
          }
        }
        processedSourceSamples += fadeLen;
        offset = fadeLen;
        pendingLeftTail = null;
        pendingTransitionForTail = null;

        await emitPlanarChunk(outLeftHalf, segIdx, offset);
        await emitPlanarChunk(outRightHalf, segIdx, offset);
      }

      // Stream the body of this segment up to bodyEndOffset in adaptive memory-bounded chunks
      while (offset < bodyEndOffset) {
        if (abortSignal?.aborted) {
          return {
            status: 'CANCELLED',
            boundaryChecks,
            crossfadeResults,
            lastCompletedSegmentIndex: segIdx,
            nextSegmentSampleOffset: offset,
            totalEmittedOutputSamples,
            peakReservedBytes,
            reason: 'Render cancelled by AbortSignal.',
          };
        }

        if (shouldPauseUser?.()) {
          return {
            status: 'PAUSED_USER',
            boundaryChecks,
            crossfadeResults,
            lastCompletedSegmentIndex: segIdx,
            nextSegmentSampleOffset: offset,
            totalEmittedOutputSamples,
            peakReservedBytes,
            reason: 'Render paused by user request.',
          };
        }

        const snap = budget.getSnapshot();
        if (snap.pressureLevel === 'emergency') {
          reader.evictAll();
          if (budget.getPressureLevel() === 'emergency') {
            return {
              status: 'PAUSED_MEMORY_PRESSURE',
              boundaryChecks,
              crossfadeResults,
              lastCompletedSegmentIndex: segIdx,
              nextSegmentSampleOffset: offset,
              totalEmittedOutputSamples,
              peakReservedBytes,
              reason: `Emergency memory pressure (${budget.getSnapshot().accountedBytes} B accounted); paused cleanly with recoverable checkpoint.`,
            };
          }
        }

        const adaptiveChunkSamples =
          snap.pressureLevel === 'throttle'
            ? Math.max(1024, Math.floor(baseChunkSamples / 4))
            : snap.pressureLevel === 'elevated'
              ? Math.max(2048, Math.floor(baseChunkSamples / 2))
              : baseChunkSamples;

        const count = Math.min(adaptiveChunkSamples, bodyEndOffset - offset);
        const workingBytes =
          count * plan.channelCount * Float32Array.BYTES_PER_ELEMENT * 2;

        let reservation: MemoryReservation | null = null;
        try {
          reservation = budget.reserve({
            owner: `AudioSegmentAssembler:seg${segIdx}@${offset}`,
            category: 'render-export-buffers',
            bytes: workingBytes,
            priority: 'normal',
          });
          const afterSnap = budget.getSnapshot();
          if (afterSnap.accountedBytes > peakReservedBytes) {
            peakReservedBytes = afterSnap.accountedBytes;
          }
        } catch {
          reader.evictAll();
          return {
            status: 'PAUSED_MEMORY_PRESSURE',
            boundaryChecks,
            crossfadeResults,
            lastCompletedSegmentIndex: segIdx,
            nextSegmentSampleOffset: offset,
            totalEmittedOutputSamples,
            peakReservedBytes,
            reason: `Unable to reserve ${workingBytes} B working render buffer within hard memory limit.`,
          };
        }

        try {
          const chunk = await reader.readRange(segStart + offset, count);
          offset += count;
          processedSourceSamples += count;
          await emitPlanarChunk(chunk, segIdx, offset);
        } finally {
          budget.release(reservation);
        }

        await yieldCooperatively();
      }

      // Hold the outgoing tail in a tiny bounded buffer strictly for the transition with segIdx + 1
      if (outgoingFadeSamples > 0) {
        const tailStart = segStart + bodyEndOffset;
        pendingLeftTail = await reader.readRange(tailStart, outgoingFadeSamples);
        pendingTransitionForTail = transitionByLeftSeg.get(segIdx) ?? null;
        processedSourceSamples += outgoingFadeSamples;
      }

      // If no next segment exists (defensive guard), flush any held tail directly
      if (segIdx === plan.retainedSegments.length - 1 && pendingLeftTail) {
        await emitPlanarChunk(pendingLeftTail, segIdx, segTotal);
        pendingLeftTail = null;
        pendingTransitionForTail = null;
      }
    }

    // Flush resampler tails if intentional sample-rate conversion was active
    if (resamplers) {
      const flushed = resamplers.map((r) => r.flush());
      const len = flushed[0]?.length ?? 0;
      if (len > 0) {
        await onChunkReady({
          planarChannels: flushed,
          sampleCount: len,
          segmentIndex: plan.retainedSegments.length,
          nextSegmentSampleOffset: 0,
          processedSourceSamples,
        });
        totalEmittedOutputSamples += len;
      }
    }

    return {
      status: 'COMPLETED',
      boundaryChecks,
      crossfadeResults,
      lastCompletedSegmentIndex: plan.retainedSegments.length,
      nextSegmentSampleOffset: 0,
      totalEmittedOutputSamples,
      peakReservedBytes,
    };
  }
}
