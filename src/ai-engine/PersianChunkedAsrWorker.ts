import { Flicks, SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import { PersianTextNormalizer, TimedPersianToken } from './PersianTextNormalizer';

export interface RawWordPrediction {
  readonly word: string;
  /** Relative start and end seconds within the current chunk window */
  readonly relativeStartSec: number;
  readonly relativeEndSec: number;
  readonly probability: number;
}

export interface AsrModelRunnerAdapter {
  readonly modelId: string;
  readonly modelVersion: string;
  /** Lightweight VAD pre-filter to skip silent windows before waking heavy ASR */
  detectVoiceActivity(
    pcm16kMono: Float32Array,
  ): Promise<{ hasSpeech: boolean; speechRatio: number }>;
  /** Executes Persian ASR model over a 16kHz Mono window */
  transcribeWindow(pcm16kMono: Float32Array): Promise<RawWordPrediction[]>;
  /**
   * Optional conservative estimate (in integer bytes) of explicitly allocated JS
   * transient working memory needed to process `sampleCount16k` samples.
   */
  estimateWorkingMemoryBytes?(sampleCount16k: number): number;
}

export interface ChunkedAsrExecutionOptions {
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly signal?: AbortSignal;
  readonly jobId?: string;
}

export class AsrJobCancelledError extends Error {
  public readonly code = 'ASR_JOB_CANCELLED';
  public readonly lastCompletedWindowIndex: number;
  public readonly checkpointTokens: TimedPersianToken[];

  constructor(params: {
    message?: string;
    lastCompletedWindowIndex: number;
    checkpointTokens: TimedPersianToken[];
    cause?: unknown;
  }) {
    super(params.message ?? 'Persian chunked ASR job was cancelled');
    this.name = 'AsrJobCancelledError';
    this.lastCompletedWindowIndex = params.lastCompletedWindowIndex;
    this.checkpointTokens = [...params.checkpointTokens];
    if (params.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = params.cause;
    }
  }
}

/**
 * Windowed Persian ASR engine using Overlapping Sliding Windows (25s window / 3s overlap)
 * + Midpoint Cutover & Cross-Chunk Token Reconciliation (Architecture Doc Sections 13, 30, 35)
 * with pre-allocation memory admission and deterministic finally-block release.
 */
export class PersianChunkedAsrEngine {
  private readonly sampleRate: SampleRate = 16000;
  private readonly windowDurationSec = 25;
  private readonly overlapDurationSec = 3;

  constructor(
    private readonly adapter: AsrModelRunnerAdapter,
    private readonly defaultMemoryBudgetManager?: MemoryBudgetManager,
  ) {}

  public async transcribeLongAudioStream(
    totalSamples16k: number,
    readSamples16kFn: (startSample: number, count: number) => Promise<Float32Array>,
    onWindowCheckpoint: (
      windowIndex: number,
      mergedTokensSoFar: TimedPersianToken[],
    ) => Promise<void>,
    resumeFromWindowIndex = 0,
    initialTokens: TimedPersianToken[] = [],
    trackId = 'track-1',
    options?: ChunkedAsrExecutionOptions,
  ): Promise<TimedPersianToken[]> {
    if (totalSamples16k <= 0) {
      return [...initialTokens];
    }

    const budgetManager =
      options?.memoryBudgetManager ??
      this.defaultMemoryBudgetManager ??
      getSharedMemoryBudgetManager();
    const signal = options?.signal;
    const jobId = options?.jobId ?? 'persian-chunked-asr';

    const windowSamples = this.windowDurationSec * this.sampleRate;
    const overlapSamples = this.overlapDurationSec * this.sampleRate;
    const strideSamples = windowSamples - overlapSamples; // 22s stride

    const totalWindows =
      totalSamples16k <= windowSamples
        ? 1
        : Math.ceil((totalSamples16k - overlapSamples) / strideSamples);

    let accumulatedTokens: TimedPersianToken[] = [...initialTokens];
    let lastCompletedWindowIndex = resumeFromWindowIndex - 1;

    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new AsrJobCancelledError({
          lastCompletedWindowIndex,
          checkpointTokens: accumulatedTokens,
          cause: signal.reason,
        });
      }
    };

    for (let wIdx = resumeFromWindowIndex; wIdx < totalWindows; wIdx++) {
      throwIfAborted();

      const startSample = wIdx * strideSamples;
      const count = Math.min(windowSamples, totalSamples16k - startSample);
      if (count <= 0) break;

      const pcmWindowBytes = count * Float32Array.BYTES_PER_ELEMENT;
      const rawAdapterEstimate = this.adapter.estimateWorkingMemoryBytes?.(count) ?? 0;
      const adapterWorkingBytes =
        typeof rawAdapterEstimate === 'number' &&
        Number.isFinite(rawAdapterEstimate) &&
        rawAdapterEstimate > 0
          ? Math.trunc(rawAdapterEstimate)
          : 0;

      let pcmReservation: MemoryReservation | null = null;
      let featureReservation: MemoryReservation | null = null;

      try {
        // Reserve BEFORE reading/allocating the window PCM or running feature extraction
        pcmReservation = budgetManager.reserve({
          owner: `${jobId}:window-${wIdx}:pcm`,
          category: 'asr-input-windows',
          bytes: pcmWindowBytes,
          priority: 'normal',
        });

        if (adapterWorkingBytes > 0) {
          featureReservation = budgetManager.reserve({
            owner: `${jobId}:window-${wIdx}:features`,
            category: 'asr-feature-buffers',
            bytes: adapterWorkingBytes,
            priority: 'normal',
          });
        }

        throwIfAborted();

        let pcmChunk: Float32Array | null = await readSamples16kFn(startSample, count);
        throwIfAborted();

        const windowStartSec = startSample / this.sampleRate;

        // 1. Silero VAD gate: keep short isolated utterances (>= 0.5% ~ 125ms)
        const vad = await this.adapter.detectVoiceActivity(pcmChunk);
        throwIfAborted();

        if (!vad.hasSpeech || vad.speechRatio < 0.005) {
          pcmChunk = null;
          await onWindowCheckpoint(wIdx, accumulatedTokens);
          lastCompletedWindowIndex = wIdx;
          continue;
        }

        // 2. Run Persian ASR over 25s window
        const rawPredictions = await this.adapter.transcribeWindow(pcmChunk);
        // Drop PCM window reference immediately — never accumulate completed windows
        pcmChunk = null;
        throwIfAborted();

        // 3. Project window-relative offsets into exact canonical Flicks
        const windowTokens = PersianTextNormalizer.buildThreeLayerTranscript(
          rawPredictions.map((pred, idx) => {
            const absStartSec = windowStartSec + pred.relativeStartSec;
            const absEndSec =
              windowStartSec + Math.max(pred.relativeEndSec, pred.relativeStartSec + 0.04);
            return {
              id: `tok_w${wIdx}_${idx}`,
              text: pred.word,
              range: {
                start: TimeMath.secondsToFlicks(absStartSec),
                end: TimeMath.secondsToFlicks(absEndSec),
              },
              confidence: pred.probability,
            };
          }),
          trackId,
        );

        // 4. Seamless Cross-Chunk Token Reconciliation across the 3-second overlap zone
        if (wIdx === 0 || accumulatedTokens.length === 0) {
          accumulatedTokens = windowTokens;
        } else {
          const overlapStartFlicks = TimeMath.secondsToFlicks(windowStartSec);
          const overlapEndFlicks = TimeMath.secondsToFlicks(
            windowStartSec + this.overlapDurationSec,
          );
          accumulatedTokens = this.mergeOverlappingTokens(accumulatedTokens, windowTokens, {
            start: overlapStartFlicks,
            end: overlapEndFlicks,
          });
        }

        // 5. Persist resumable window checkpoint (Section 31)
        await onWindowCheckpoint(wIdx, accumulatedTokens);
        lastCompletedWindowIndex = wIdx;
      } finally {
        budgetManager.release(featureReservation);
        budgetManager.release(pcmReservation);
      }
    }

    return accumulatedTokens;
  }

  /**
   * Reconciles boundary tokens inside the 3-second overlap zone using temporal midpoint
   * cutover and normalized Persian token deduplication.
   */
  private mergeOverlappingTokens(
    prevTokens: TimedPersianToken[],
    currentWindowTokens: TimedPersianToken[],
    overlapZone: TimeRange,
  ): TimedPersianToken[] {
    const midpointFlicks: Flicks = Math.floor((overlapZone.start + overlapZone.end) / 2);

    const keptFromPrev = prevTokens.filter((t) => {
      const center = (t.range.start + t.range.end) / 2;
      return center < midpointFlicks;
    });

    const candidatesFromCurr = currentWindowTokens.filter((t) => {
      const center = (t.range.start + t.range.end) / 2;
      return center >= midpointFlicks;
    });

    if (keptFromPrev.length > 0 && candidatesFromCurr.length > 0) {
      const lastPrev = keptFromPrev[keptFromPrev.length - 1];
      const firstCurr = candidatesFromCurr[0];

      const timeOverlap =
        Math.min(lastPrev.range.end, firstCurr.range.end) -
        Math.max(lastPrev.range.start, firstCurr.range.start);

      if (
        lastPrev.normalizedText === firstCurr.normalizedText &&
        timeOverlap > -TimeMath.secondsToFlicks(0.15)
      ) {
        if (firstCurr.confidence > lastPrev.confidence) {
          keptFromPrev.pop();
        } else {
          candidatesFromCurr.shift();
        }
      }
    }

    return [...keptFromPrev, ...candidatesFromCurr];
  }
}
