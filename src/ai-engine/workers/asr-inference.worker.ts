import {
  OpfsRootDirectoryLike,
  WebWorkerOrtRuntimeProvider,
} from '../asr/WebWorkerOrtRuntimeProvider';
import {
  ConsolidatedAsrBatch,
  SileroVadOnnxRunner,
  VadSpeechSegment,
} from '../asr/SileroVadOnnxRunner';
import {
  AsrArchitectureKind,
  OrtRuntimeProvider,
  UnifiedOnnxPersianAsrEngine,
} from '../asr/UnifiedOnnxPersianAsrEngine';
import { SpeakerEmbeddingOnnxRunner } from '../asr/SpeakerEmbeddingOnnxRunner';
import { PersianLanguageModelScorer } from '../asr/PersianCtcPrefixBeamSearchDecoder';
import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import { PersianPostAsrSpellingAndCompoundRestorer } from '../asr/PersianPostAsrSpellingAndCompoundRestorer';
import { PersianDisfluencyEngine, DetectedSpeechIssue } from '../PersianDisfluencyEngine';
import { SpeakerTimelineSegment } from '../MultiSpeakerDiarizationAndCrosstalkEngine';
import { ChunkedModelManifest } from '../../platform/ChunkedModelDelivery';
import { TimeMath } from '../../contracts/timebase.contract';
import { TrackId } from '../../contracts/project-schema.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../../runtime/memory/MemoryBudgetManager';
import { RawWordPrediction } from '../PersianChunkedAsrWorker';

export interface AsrPipelineExecutionRequest {
  readonly jobId: string;
  readonly trackId: TrackId;
  readonly pcm16kMono: Float32Array;
  readonly vadManifest: ChunkedModelManifest;
  readonly asrManifest: ChunkedModelManifest;
  readonly asrArchitecture: AsrArchitectureKind;
  readonly ctcVocabulary?: readonly string[];
  readonly speakerEmbeddingManifest?: ChunkedModelManifest;
  readonly persianLmScorer?: PersianLanguageModelScorer;
  readonly preferredBackend: 'webgpu' | 'wasm';
  readonly resumeFromBatchIndex?: number;
  readonly existingTokensFromCheckpoint?: TimedPersianToken[];
}

export interface AsrPipelineCheckpointPayload {
  readonly jobId: string;
  readonly completedBatchIndex: number;
  readonly totalBatches: number;
  readonly tokensSoFar: TimedPersianToken[];
}

export interface AsrPipelineFinalResult {
  readonly jobId: string;
  readonly vadSegments: VadSpeechSegment[];
  readonly finalTokens: TimedPersianToken[];
  readonly detectedSpeechIssues: DetectedSpeechIssue[];
  readonly speakerSegments: SpeakerTimelineSegment[];
  readonly totalProcessingWallMs: number;
}

/**
 * Section 116: Sequential Background ASR & Diarization Worker Pipeline (VAD -> ASR -> Diarization -> Post-NLP)
 * Enforces Single-Active-Heavy-Model unloading, MemoryBudgetManager admission, and exact inverse batch-to-timeline Flicks timestamp mapping.
 */
export class SequentialPersianAiPipelineRunner {
  private readonly ortProvider: OrtRuntimeProvider;
  private readonly compoundRestorer = new PersianPostAsrSpellingAndCompoundRestorer();
  private readonly memoryBudgetManager: MemoryBudgetManager;
  private disposed = false;

  constructor(
    customOrtProvider?: OrtRuntimeProvider,
    private readonly opfsRootOverride?: OpfsRootDirectoryLike,
    memoryBudgetManager?: MemoryBudgetManager,
  ) {
    this.ortProvider = customOrtProvider ?? new WebWorkerOrtRuntimeProvider('/ort/');
    this.memoryBudgetManager = memoryBudgetManager ?? getSharedMemoryBudgetManager();
  }

  public isOperational(): boolean {
    return !this.disposed;
  }

  public dispose(): void {
    this.disposed = true;
  }

  /**
   * Run full sequential AI pipeline (VAD -> ASR -> Speaker Diarization -> Disfluency)
   * with immediate model unloading and memory reservation release between stages (Single-Active-Heavy-Model Rule)
   */
  public async runFullSequentialPipeline(
    req: AsrPipelineExecutionRequest,
    callbacks: {
      onStageProgress: (
        stage: 'VAD' | 'ASR' | 'DIARIZATION' | 'POST_NLP',
        percent: number,
      ) => void;
      onSaveBatchCheckpoint: (checkpoint: AsrPipelineCheckpointPayload) => Promise<void>;
      abortSignal?: AbortSignal;
    },
  ): Promise<AsrPipelineFinalResult> {
    if (this.disposed) {
      throw new Error('ASR_WORKER_OFFLINE: Pipeline runner has been disposed.');
    }
    if (callbacks.abortSignal?.aborted) {
      throw new Error('ASR_JOB_ABORTED_BEFORE_START');
    }

    const startMs = performance.now();

    // =========================================================================
    // Stage 1: Load & execute Silero VAD v5 (~2MB) and immediately unload
    // =========================================================================
    callbacks.onStageProgress('VAD', 5);
    let vadReservation: MemoryReservation | null = null;
    const vadRunner = new SileroVadOnnxRunner(this.ortProvider);
    let vadSegments: VadSpeechSegment[] = [];
    try {
      const vadModelBytes = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
        req.vadManifest,
        this.opfsRootOverride,
        {
          memoryBudgetManager: this.memoryBudgetManager,
          onReservation: (res) => {
            vadReservation = res;
          },
          signal: callbacks.abortSignal,
        },
      );
      await vadRunner.loadModel(vadModelBytes, ['wasm']);

      vadSegments = await vadRunner.detectSpeechSegments(req.pcm16kMono, {
        startThreshold: 0.5,
        endThreshold: 0.35,
        minSpeechMs: 250,
        minSilenceMs: 120,
        speechPadMs: 30,
      });
    } finally {
      await vadRunner.unloadModel(); // Immediate VAD memory release
      this.memoryBudgetManager.release(vadReservation);
    }

    if (callbacks.abortSignal?.aborted) {
      throw new Error('ASR_JOB_ABORTED_AT_CHECKPOINT');
    }

    const consolidatedBatches = SileroVadOnnxRunner.buildConsolidatedAsrBatches(
      req.pcm16kMono,
      vadSegments,
      25.0,
    );

    // =========================================================================
    // Stage 2: Load Persian ASR model (FastConformer or Whisper) & run batched inference with Checkpoints
    // =========================================================================
    callbacks.onStageProgress('ASR', 15);
    const accumulatedTokens: TimedPersianToken[] = [
      ...(req.existingTokensFromCheckpoint ?? []),
    ];
    const startBatchIdx = req.resumeFromBatchIndex ?? 0;

    if (consolidatedBatches.length > 0 && startBatchIdx < consolidatedBatches.length) {
      let asrReservation: MemoryReservation | null = null;
      const asrEngine = new UnifiedOnnxPersianAsrEngine(
        this.ortProvider,
        req.asrArchitecture,
        {
          modelId: req.asrManifest.modelId,
          modelVersion: req.asrManifest.version,
          ctcVocabulary: req.ctcVocabulary,
          persianLmScorer: req.persianLmScorer,
        },
      );

      try {
        const asrModelBytes =
          await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
            req.asrManifest,
            this.opfsRootOverride,
            {
              memoryBudgetManager: this.memoryBudgetManager,
              onReservation: (res) => {
                asrReservation = res;
              },
              signal: callbacks.abortSignal,
            },
          );

        const providers: ('webgpu' | 'wasm')[] =
          req.preferredBackend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
        await asrEngine.loadModels({
          encoderModelBytesOrPath: asrModelBytes,
          executionProviders: providers,
        });

        for (let bIdx = startBatchIdx; bIdx < consolidatedBatches.length; bIdx++) {
          if (callbacks.abortSignal?.aborted) {
            throw new Error('ASR_JOB_ABORTED_AT_CHECKPOINT');
          }

          const batch = consolidatedBatches[bIdx];
          const batchRawWords = await asrEngine.transcribeWindow(batch.concatenated16kPcm);

          // Inverse map word timestamps from consolidated VAD batch coordinates back to original timeline Flicks
          const mappedTokens = this.mapBatchWordsToOriginalAudioTokens(batch, batchRawWords);
          accumulatedTokens.push(...mappedTokens);

          await callbacks.onSaveBatchCheckpoint({
            jobId: req.jobId,
            completedBatchIndex: bIdx,
            totalBatches: consolidatedBatches.length,
            tokensSoFar: accumulatedTokens,
          });

          const pct = 15 + Math.round(((bIdx + 1) / consolidatedBatches.length) * 60);
          callbacks.onStageProgress('ASR', pct);
        }
      } finally {
        // Guarantee heavy ASR model unloading from RAM even on cancellation or error
        await asrEngine.unloadModels();
        this.memoryBudgetManager.release(asrReservation);
      }
    }

    // =========================================================================
    // Stage 3: Multi-Speaker Diarization (ECAPA-TDNN + AHC) if requested
    // =========================================================================
    let speakerSegments: SpeakerTimelineSegment[] = [];
    if (req.speakerEmbeddingManifest && vadSegments.length > 0) {
      if (callbacks.abortSignal?.aborted) {
        throw new Error('ASR_JOB_ABORTED_AT_CHECKPOINT');
      }
      callbacks.onStageProgress('DIARIZATION', 80);
      let spkReservation: MemoryReservation | null = null;
      const spkRunner = new SpeakerEmbeddingOnnxRunner(this.ortProvider, 'feats', 'B_T_M');
      try {
        const spkBytes = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
          req.speakerEmbeddingManifest,
          this.opfsRootOverride,
          {
            memoryBudgetManager: this.memoryBudgetManager,
            onReservation: (res) => {
              spkReservation = res;
            },
            signal: callbacks.abortSignal,
          },
        );
        await spkRunner.loadModel(spkBytes, ['wasm']);

        const frameEmbeddings = await spkRunner.extractEmbeddingsForVadSegments(
          req.pcm16kMono,
          vadSegments,
        );
        speakerSegments = SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc(
          req.trackId,
          frameEmbeddings,
        );
      } finally {
        await spkRunner.unloadModel();
        this.memoryBudgetManager.release(spkReservation);
      }
    }

    // =========================================================================
    // Stage 4: Restore Persian compounds/ZWNJ & detect speech disfluencies
    // =========================================================================
    callbacks.onStageProgress('POST_NLP', 95);
    const finalTokens = this.compoundRestorer.restoreCompoundsAndBilingualTerms(
      accumulatedTokens,
      180,
    );
    const detectedSpeechIssues = PersianDisfluencyEngine.analyzeTranscript(finalTokens);

    callbacks.onStageProgress('POST_NLP', 100);

    return {
      jobId: req.jobId,
      vadSegments,
      finalTokens,
      detectedSpeechIssues,
      speakerSegments,
      totalProcessingWallMs: Math.round(performance.now() - startMs),
    };
  }

  /**
   * Exact inverse timestamp mapping from a ConsolidatedAsrBatch back to original source audio Flicks
   */
  public mapBatchWordsToOriginalAudioTokens(
    batch: ConsolidatedAsrBatch,
    batchRawWords: RawWordPrediction[],
  ): TimedPersianToken[] {
    const sr = 16000;
    const rawItems: {
      id: string;
      text: string;
      range: { start: number; end: number };
      confidence: number;
    }[] = [];

    for (let i = 0; i < batchRawWords.length; i++) {
      const w = batchRawWords[i];
      const bStartSample = Math.round(w.relativeStartSec * sr);
      const bEndSample = Math.round(w.relativeEndSec * sr);
      const bMidSample = Math.floor((bStartSample + bEndSample) / 2);

      // Find the original VAD segment corresponding to this word in the offset mapping table
      let mapping = batch.offsetMappings.find(
        (m) => bMidSample >= m.batchStartSample && bMidSample <= m.batchEndSample,
      );
      if (!mapping) {
        mapping = batch.offsetMappings.reduce((closest, curr) => {
          const distCurr = Math.min(
            Math.abs(bMidSample - curr.batchStartSample),
            Math.abs(bMidSample - curr.batchEndSample),
          );
          const distBest = Math.min(
            Math.abs(bMidSample - closest.batchStartSample),
            Math.abs(bMidSample - closest.batchEndSample),
          );
          return distCurr < distBest ? curr : closest;
        }, batch.offsetMappings[0]);
      }

      const segDuration = mapping.batchEndSample - mapping.batchStartSample;
      const localStart = Math.max(
        0,
        Math.min(segDuration, bStartSample - mapping.batchStartSample),
      );
      const localEnd = Math.max(
        localStart + 640, // Minimum 40ms
        Math.min(segDuration, bEndSample - mapping.batchStartSample),
      );

      const origStart16k = mapping.originalAudioStartSample + localStart;
      const origEnd16k = mapping.originalAudioStartSample + localEnd;

      rawItems.push({
        id: `tok_b${batch.batchIndex}_${i}`,
        text: w.word,
        range: {
          start: TimeMath.samplesToFlicks(origStart16k, 16000),
          end: TimeMath.samplesToFlicks(origEnd16k, 16000),
        },
        confidence: w.probability,
      });
    }

    return PersianTextNormalizer.buildThreeLayerTranscript(rawItems);
  }
}
