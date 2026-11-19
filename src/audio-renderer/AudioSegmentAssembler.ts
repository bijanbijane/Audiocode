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
    const rawBaseChunk = options.baseChunkSizeSamples ?? 16384;
    const baseChunkSamples = Math.max(
      1024,
      Math.min(65536, Math.trunc(Number.isFinite(rawBaseChunk) ? rawBaseChunk : 16384)),
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
      const leftIdx = tr.leftSegmentIndex;
      const rightIdx = tr.rightSegmentIndex;
      const leftSeg = plan.retainedSegments[leftIdx];
      const rightSeg = plan.retainedSegments[rightIdx];
      if (!leftSeg || !rightSeg) continue;

      const curLeftStart = effectiveStarts[leftIdx];
      const curLeftEnd = effectiveEnds[leftIdx];
      const curRightStart = effectiveStarts[rightIdx];
      const curRightEnd = effectiveEnds[rightIdx];
      const curLeftLen = curLeftEnd - curLeftStart;
      const curRightLen = curRightEnd - curRightStart;

      const evalRadius = Math.max(
        tr.maxAdjustmentSamples + 64,
        Math.round(plan.sourceSampleRate * 0.02),
      );
      const leftWinLen = Math.min(evalRadius, curLeftLen);
      const rightWinLen = Math.min(evalRadius, curRightLen);

      const leftWindow = await reader.readRange(curLeftEnd - leftWinLen, leftWinLen);
      const rightWindow = await reader.readRange(curRightStart, rightWinLen);

      const gapSamples = Math.max(0, curRightStart - curLeftEnd);
      const extRadius = Math.min(tr.maxAdjustmentSamples, gapSamples);
      const leftPostLen = Math.min(extRadius, Math.max(0, plan.totalSourceSamples - curLeftEnd));
      const rightPreLen = Math.min(extRadius, Math.max(0, curRightStart));
      const leftPostWindow =
        leftPostLen > 0 ? await reader.readRange(curLeftEnd, leftPostLen) : undefined;
      const rightPreWindow =
        rightPreLen > 0
          ? await reader.readRange(curRightStart - rightPreLen, rightPreLen)
          : undefined;

      const check = AudioBoundaryProcessor.evaluateAndRefineJunction({
        transitionIndex: tr.transitionIndex,
        proposalId: tr.removedProposalId,
        sampleRate: plan.sourceSampleRate,
        originalLeftSample: curLeftEnd,
        originalRightSample: curRightStart,
        leftWindow,
        rightWindow,
        leftPostWindow,
        rightPreWindow,
        preserveTotalLength: true,
        maxAdjustmentSamples: tr.maxAdjustmentSamples,
        maxLeftPullbackSamples: Math.max(0, Math.floor(curLeftLen / 4)),
        maxRightAdvanceSamples: Math.max(0, Math.floor(curRightLen / 4)),
      });

      let recordedCheck = check;
      if (
        check.adjustmentApplied &&
        check.leftAdjustmentSamples === check.rightAdjustmentSamples &&
        check.adjustedLeftSample > curLeftStart + 2 &&
        check.adjustedRightSample < curRightEnd - 2 &&
        check.adjustedLeftSample <= check.adjustedRightSample &&
        check.adjustedLeftSample <= plan.totalSourceSamples &&
        check.adjustedRightSample >= 0
      ) {
        effectiveEnds[leftIdx] = check.adjustedLeftSample;
        effectiveStarts[rightIdx] = check.adjustedRightSample;
      } else if (check.adjustmentApplied) {
        recordedCheck = {
          ...check,
          adjustedLeftSample: curLeftEnd,
          adjustedRightSample: curRightStart,
          leftAdjustmentSamples: 0,
          rightAdjustmentSamples: 0,
          adjustmentApplied: false,
          rejectedAdjustmentReason:
            'Candidate boundary shift violated segment bounds; preserved original coordinates.',
        };
      }
      boundaryChecks.push(recordedCheck);

      // Compute half-fade length L so the centered 2*L crossfade stays strictly inside both
      // adjacent segments and available source pre/post-roll, preserving exact sample count.
      const effLeftEnd = effectiveEnds[leftIdx];
      const effRightStart = effectiveStarts[rightIdx];
      const effLeftLen = effLeftEnd - effectiveStarts[leftIdx];
      const effRightLen = effectiveEnds[rightIdx] - effRightStart;
      const requestedHalfFade = Math.floor(tr.requestedCrossfadeSamples / 2);
      const maxSafeHalfFade = Math.min(
        requestedHalfFade,
        Math.floor(effLeftLen / 3),
        Math.floor(effRightLen / 3),
        Math.max(0, plan.totalSourceSamples - effLeftEnd),
        Math.max(0, effRightStart),
      );
      transitionFadeLengths.set(leftIdx, Math.max(0, maxSafeHalfFade));
    }

    let startSegmentIndex = 0;
    let initialSegmentOffset = 0;
    let totalEmittedOutputSamples = 0;
    let processedSourceSamples = 0;

    if (resumeFromCheckpoint) {
      const safeCompletedSeg = Number.isFinite(resumeFromCheckpoint.completedSegmentIndex)
        ? Math.trunc(resumeFromCheckpoint.completedSegmentIndex)
        : 0;
      const safeNextOffset = Number.isFinite(resumeFromCheckpoint.nextSegmentSampleOffset)
        ? Math.trunc(resumeFromCheckpoint.nextSegmentSampleOffset)
        : 0;
      const safeWrittenOut = Number.isFinite(resumeFromCheckpoint.writtenOutputSamples)
        ? Math.trunc(resumeFromCheckpoint.writtenOutputSamples)
        : 0;
      startSegmentIndex = Math.max(0, safeCompletedSeg);
      initialSegmentOffset = Math.max(0, safeNextOffset);
      totalEmittedOutputSamples = Math.max(0, safeWrittenOut);
      for (let i = 0; i < startSegmentIndex && i < plan.retainedSegments.length; i++) {
        processedSourceSamples += effectiveEnds[i] - effectiveStarts[i];
      }
      processedSourceSamples += initialSegmentOffset;
    }

    let peakReservedBytes = budget.getSnapshot().accountedBytes;
    let lastYieldMs = Date.now();
    let pendingLeftExt: Float32Array[] | null = null;
    let pendingHalfFade = 0;
    let pendingTransitionForTail: (typeof plan.transitions)[number] | null = null;

    // If resuming cleanly at offset 0 of a segment with an incoming crossfade,
    // restore the held outgoing pre/post-roll window from the previous segment.
    if (
      resumeFromCheckpoint &&
      startSegmentIndex > 0 &&
      initialSegmentOffset === 0 &&
      startSegmentIndex < plan.retainedSegments.length
    ) {
      const prevIdx = startSegmentIndex - 1;
      const prevHalfFade = transitionFadeLengths.get(prevIdx) ?? 0;
      const prevTr = transitionByLeftSeg.get(prevIdx) ?? null;
      if (prevHalfFade > 0 && prevTr) {
        pendingLeftExt = await reader.readRange(
          effectiveEnds[prevIdx] - prevHalfFade,
          prevHalfFade * 2,
        );
        pendingHalfFade = prevHalfFade;
        pendingTransitionForTail = prevTr;
      }
    }

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
      const segStart = effectiveStarts[segIdx];
      const segEnd = effectiveEnds[segIdx];
      const segTotal = segEnd - segStart;

      // Half-fade tail reserved at the END of this segment if there is an outgoing transition
      const outgoingHalfFade = transitionFadeLengths.get(segIdx) ?? 0;
      const bodyEndOffset = Math.max(0, segTotal - outgoingHalfFade);

      let offset = segIdx === startSegmentIndex ? initialSegmentOffset : 0;

      // If previous segment left a pending centered-crossfade tail, blend continuously over 2*halfFade
      // using real source post-roll (left) and real source pre-roll (right).
      // Sample count emitted = 2*halfFade = outgoingHalfFade (left) + incomingHalfFade (right),
      // preserving exact expectedOutputSamples with zero backward time jump and full limiter coverage.
      if (pendingLeftExt && pendingTransitionForTail && pendingHalfFade > 0 && offset === 0) {
        const halfFade = pendingHalfFade;
        const fullFadeLen = halfFade * 2;
        const rightExt = await reader.readRange(segStart - halfFade, fullFadeLen);
        const { blended, result } = AudioCrossfadeProcessor.blendTransition({
          transitionIndex: pendingTransitionForTail.transitionIndex,
          proposalId: pendingTransitionForTail.removedProposalId,
          leftTail: pendingLeftExt,
          rightHead: rightExt,
          preferredCurve: pendingTransitionForTail.preferredCurve,
          enableLimiter: enableTransitionLimiter,
        });
        crossfadeResults.push(result);

        processedSourceSamples += halfFade;
        offset = halfFade;
        pendingLeftExt = null;
        pendingHalfFade = 0;
        pendingTransitionForTail = null;

        await emitPlanarChunk(blended, segIdx, offset);
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

        const nowYieldMs = Date.now();
        if (nowYieldMs - lastYieldMs >= 8) {
          await yieldCooperatively();
          lastYieldMs = Date.now();
        }
      }

      // Hold the outgoing tail + source post-roll (2*outgoingHalfFade) for centered transition with segIdx + 1
      if (outgoingHalfFade > 0) {
        const tailStart = segStart + bodyEndOffset;
        pendingLeftExt = await reader.readRange(tailStart, outgoingHalfFade * 2);
        pendingHalfFade = outgoingHalfFade;
        pendingTransitionForTail = transitionByLeftSeg.get(segIdx) ?? null;
        processedSourceSamples += outgoingHalfFade;
      }

      // If no next segment exists (defensive guard), flush only the retained outgoingHalfFade samples
      if (segIdx === plan.retainedSegments.length - 1 && pendingLeftExt && pendingHalfFade > 0) {
        const retainedOnly = pendingLeftExt.map((ch) => ch.subarray(0, pendingHalfFade));
        await emitPlanarChunk(retainedOnly, segIdx, segTotal);
        pendingLeftExt = null;
        pendingHalfFade = 0;
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
