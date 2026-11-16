import { SampleIndex, SampleRate } from '../contracts/timebase.contract';
import { CompiledRenderPlan, ProcessingGraphEngine } from './ProcessingGraphEngine';

export interface RenderChunkTaskPayload {
  readonly chunkIndex: number;
  readonly validTargetStartSample: SampleIndex;
  readonly validTargetEndSample: SampleIndex;
  readonly diskReadStartSample: SampleIndex;
  readonly diskReadEndSample: SampleIndex;
  readonly discardPrefixSamples: SampleIndex;
}

export interface RenderProgressReport {
  readonly totalChunks: number;
  readonly completedChunksFlushedToDisk: number;
  readonly percentComplete: number;
  readonly estimatedRemainingSeconds: number;
}

export class ParallelChunkRenderCoordinator {
  constructor(private readonly graphEngine: ProcessingGraphEngine) {}

  /**
   * اجرای رندر موازی کل تایم‌لاین همراه با تغذیه Pre-Roll هر قطعه، پشتیبانی از لغو (Cancel)
   * و نوشتن جریانی مرتب (In-Order Flush) به دیسک OPFS بدون سرریز حافظه RAM
   */
  public async executeParallelStreamingRender(params: {
    totalTimelineSamples: SampleIndex;
    sampleRate: SampleRate;
    compiledPlan: CompiledRenderPlan;
    chunkDurationSeconds?: number; // پیش‌فرض ۱۰ ثانیه برای هر قطعه
    maxConcurrentWorkers?: number;
    abortSignal?: AbortSignal;
    renderChunkOnWorkerFn: (
      task: RenderChunkTaskPayload,
    ) => Promise<Float32Array[]>; // خروجی برش‌خورده دقیق [validTargetStart, validTargetEnd)
    flushOrderedChunkToEncoderFn: (
      chunkIndex: number,
      channels: Float32Array[],
    ) => Promise<void>;
    onProgress?: (report: RenderProgressReport) => void;
  }): Promise<{ totalSamplesRendered: number; durationMs: number }> {
    const startTimeMs = performance.now();
    const chunkSamples = Math.floor(
      params.sampleRate * (params.chunkDurationSeconds ?? 10),
    );
    const totalChunks = Math.max(
      1,
      Math.ceil(params.totalTimelineSamples / chunkSamples),
    );
    const concurrency = Math.max(1, Math.min(4, params.maxConcurrentWorkers ?? 2));

    // بافر کشویی مرتب‌ساز برای نگهداری موقت قطعاتی که زودتر از قطعه قبلی تمام شده‌اند
    const completedPendingFlush = new Map<number, Float32Array[]>();
    let nextChunkToFlush = 0;
    let nextChunkToDispatch = 0;
    let totalSamplesRendered = 0;

    const flushReadyChunksInStrictOrder = async () => {
      while (completedPendingFlush.has(nextChunkToFlush)) {
        const channels = completedPendingFlush.get(nextChunkToFlush)!;
        completedPendingFlush.delete(nextChunkToFlush);

        await params.flushOrderedChunkToEncoderFn(nextChunkToFlush, channels);
        totalSamplesRendered += channels[0]?.length ?? 0;
        nextChunkToFlush++;

        if (params.onProgress) {
          const elapsedSec = (performance.now() - startTimeMs) / 1000;
          const avgSecPerChunk = elapsedSec / Math.max(1, nextChunkToFlush);
          const remainingChunks = totalChunks - nextChunkToFlush;
          params.onProgress({
            totalChunks,
            completedChunksFlushedToDisk: nextChunkToFlush,
            percentComplete: Math.round((nextChunkToFlush / totalChunks) * 100),
            estimatedRemainingSeconds: Math.ceil(remainingChunks * avgSecPerChunk),
          });
        }
      }
    };

    const runWorkerLoop = async (): Promise<void> => {
      while (true) {
        if (params.abortSignal?.aborted) {
          throw new Error('RENDER_CANCELLED_BY_USER');
        }

        // اعمال Backpressure: اگر بافر انتظار فلاش پر شد، کارگر جدید تا زمان نوشته شدن قطعات قبلی صبر می‌کند
        while (completedPendingFlush.size >= concurrency * 2) {
          if (params.abortSignal?.aborted) throw new Error('RENDER_CANCELLED_BY_USER');
          await new Promise((r) => setTimeout(r, 15));
        }

        const chunkIdx = nextChunkToDispatch;
        if (chunkIdx >= totalChunks) break;
        nextChunkToDispatch++;

        const validStart = chunkIdx * chunkSamples;
        const validEnd = Math.min(
          params.totalTimelineSamples,
          validStart + chunkSamples,
        );

        const feedWin = this.graphEngine.computeChunkFeedWindow(
          validStart,
          validEnd,
          params.compiledPlan,
        );

        const taskPayload: RenderChunkTaskPayload = {
          chunkIndex: chunkIdx,
          validTargetStartSample: validStart,
          validTargetEndSample: validEnd,
          diskReadStartSample: feedWin.diskReadStartSample,
          diskReadEndSample: feedWin.diskReadEndSample,
          discardPrefixSamples: feedWin.discardOutputPrefixSamples,
        };

        const renderedChannels = await params.renderChunkOnWorkerFn(taskPayload);
        completedPendingFlush.set(chunkIdx, renderedChannels);
        await flushReadyChunksInStrictOrder();
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, totalChunks) },
      () => runWorkerLoop(),
    );
    await Promise.all(workers);
    await flushReadyChunksInStrictOrder();

    return {
      totalSamplesRendered,
      durationMs: Math.round(performance.now() - startTimeMs),
    };
  }
}
