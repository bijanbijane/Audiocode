import {
  OrtRuntimeProvider,
  OrtSessionLike,
} from './UnifiedOnnxPersianAsrEngine';
import { OnnxPersianAsrAndVadAdapter } from '../OnnxPersianAsrAndVadAdapter';
import { VadSpeechSegment } from './SileroVadOnnxRunner';
import { PersianCtcPrefixBeamSearchDecoder } from './PersianCtcPrefixBeamSearchDecoder';
import { PersianTextNormalizer, TimedPersianToken } from '../PersianTextNormalizer';
import { TimeMath } from '../../contracts/timebase.contract';

export interface DynamicBatchConfig {
  readonly maxBatchSize: number;          // e.g. 8 concurrent segments
  readonly maxBatchTotalFrames: number;   // Max total frames (B * maxLen) to bound RAM usage
  readonly maxAllowedPaddingRatio: number;// e.g. 0.30 (max 30% length difference inside a batch)
  readonly encoderSubsamplingFactor: number; // Typically 4 for FastConformer (40ms/frame)
  readonly melHopDurationSec: number;     // 0.01s (10ms)
}

interface PreparedSegmentMel {
  readonly originalIndex: number;
  readonly segment: VadSpeechSegment;
  readonly melTensor: Float32Array; // [numFrames, nMels]
  readonly numFrames: number;
  readonly nMels: number;
}

export class DynamicLengthBatchedCtcRunner {
  private session: OrtSessionLike | null = null;
  private readonly featureExtractor = new OnnxPersianAsrAndVadAdapter(
    'fastconformer-batched-fa',
    '1.0.0'
  );

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly ctcDecoder: PersianCtcPrefixBeamSearchDecoder,
    private readonly cfg: DynamicBatchConfig = {
      maxBatchSize: 8,
      maxBatchTotalFrames: 12000,
      maxAllowedPaddingRatio: 0.35,
      encoderSubsamplingFactor: 4,
      melHopDurationSec: 0.01,
    }
  ) {}

  public async loadModel(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[]
  ): Promise<void> {
    this.session = await this.ortProvider.createSession(
      modelBytesOrPath,
      executionProviders
    );
  }

  public async unloadModel(): Promise<void> {
    if (this.session?.release) await this.session.release();
    this.session = null;
  }

  /**
   * Executes dynamic length-bucketed batch inference across all VAD segments with minimal padding waste.
   */
  public async transcribeVadSegmentsBatched(
    pcm16kMono: Float32Array,
    vadSegments: VadSpeechSegment[]
  ): Promise<{
    tokens: TimedPersianToken[];
    batchesExecuted: number;
    averagePaddingWasteRatio: number;
  }> {
    if (!this.session) throw new Error('BATCHED_CTC_SESSION_NOT_LOADED');
    if (vadSegments.length === 0) {
      return { tokens: [], batchesExecuted: 0, averagePaddingWasteRatio: 0 };
    }

    // 1. Compute Log-Mel spectrograms for each segment and sort shortest-to-longest
    const prepared: PreparedSegmentMel[] = [];
    for (let i = 0; i < vadSegments.length; i++) {
      const seg = vadSegments[i];
      const slice = pcm16kMono.subarray(seg.startSample16k, seg.endSample16k);
      const { melTensor, numFrames, nMels } =
        this.featureExtractor.computeLogMelSpectrogram(slice);
      if (numFrames > 0) {
        prepared.push({
          originalIndex: i,
          segment: seg,
          melTensor,
          numFrames,
          nMels,
        });
      }
    }

    prepared.sort((a, b) => a.numFrames - b.numFrames);

    // 2. Pack into length-bounded micro-batches respecting memory ceiling and max padding ratio
    const batches = this.packIntoLengthBoundedBatches(prepared);
    const resultsByOriginalIdx = new Map<number, TimedPersianToken[]>();

    let totalRealFrames = 0;
    let totalPaddedFrames = 0;

    // 3. Execute each micro-batch on ONNX Runtime with shape [B, 80, T_max]
    for (const batch of batches) {
      const B = batch.length;
      const nMels = batch[0].nMels;
      const maxFrames = batch[B - 1].numFrames;

      const batchMel = new Float32Array(B * nMels * maxFrames);
      const batchLengths = new BigInt64Array(B);

      for (let b = 0; b < B; b++) {
        const item = batch[b];
        batchLengths[b] = BigInt(item.numFrames);
        totalRealFrames += item.numFrames;
        totalPaddedFrames += maxFrames;

        const batchItemOffset = b * nMels * maxFrames;
        for (let t = 0; t < item.numFrames; t++) {
          const srcRowOff = t * nMels;
          for (let m = 0; m < nMels; m++) {
            batchMel[batchItemOffset + m * maxFrames + t] =
              item.melTensor[srcRowOff + m];
          }
        }
      }

      const audioTensor = this.ortProvider.createTensor('float32', batchMel, [
        B,
        nMels,
        maxFrames,
      ]);
      const lengthTensor = this.ortProvider.createTensor('int64', batchLengths, [B]);

      const outputs = await this.session.run({
        audio_signal: audioTensor,
        length: lengthTensor,
      });

      const logProbsTensor = outputs['logprobs'] ?? Object.values(outputs)[0];
      const [, outMaxFrames, vocabSize] = logProbsTensor.dims;
      const flatData = logProbsTensor.data as Float32Array;
      const outFrameSec = this.cfg.melHopDurationSec * this.cfg.encoderSubsamplingFactor;

      // 4. Slice each batch member's output to its true subsampled frame length and decode
      for (let b = 0; b < B; b++) {
        const item = batch[b];
        const validOutFrames = Math.min(
          outMaxFrames,
          Math.max(1, Math.ceil(item.numFrames / this.cfg.encoderSubsamplingFactor))
        );

        const itemBaseOffset = b * outMaxFrames * vocabSize;
        const itemFrames: Float32Array[] = new Array(validOutFrames);
        for (let t = 0; t < validOutFrames; t++) {
          const start = itemBaseOffset + t * vocabSize;
          itemFrames[t] = flatData.subarray(start, start + vocabSize);
        }

        const decoded = this.ctcDecoder.decodeWithWordTimestamps({
          logProbsPerFrame: itemFrames,
          frameDurationSec: outFrameSec,
          beamWidth: 12,
        });

        const segStartSec = item.segment.startSample16k / 16000;
        const rawTokens = decoded.words.map((w, wIdx) => ({
          id: `tok_s${item.originalIndex}_${wIdx}`,
          text: w.word,
          range: {
            start: TimeMath.secondsToFlicks(segStartSec + w.relativeStartSec),
            end: TimeMath.secondsToFlicks(segStartSec + w.relativeEndSec),
          },
          confidence: w.probability,
        }));

        resultsByOriginalIdx.set(
          item.originalIndex,
          PersianTextNormalizer.buildThreeLayerTranscript(rawTokens)
        );
      }
    }

    // 5. Restore all tokens in their original chronological timeline order
    const orderedAllTokens: TimedPersianToken[] = [];
    for (let i = 0; i < vadSegments.length; i++) {
      const segTokens = resultsByOriginalIdx.get(i);
      if (segTokens) orderedAllTokens.push(...segTokens);
    }

    const averagePaddingWasteRatio =
      totalPaddedFrames > 0
        ? Number(((totalPaddedFrames - totalRealFrames) / totalPaddedFrames).toFixed(3))
        : 0;

    return {
      tokens: orderedAllTokens,
      batchesExecuted: batches.length,
      averagePaddingWasteRatio,
    };
  }

  private packIntoLengthBoundedBatches(
    sortedItems: PreparedSegmentMel[]
  ): PreparedSegmentMel[][] {
    const batches: PreparedSegmentMel[][] = [];
    let currentBatch: PreparedSegmentMel[] = [];

    for (const item of sortedItems) {
      if (currentBatch.length === 0) {
        currentBatch.push(item);
        continue;
      }

      const shortestInBatch = currentBatch[0].numFrames;
      const nextBatchCount = currentBatch.length + 1;
      const projectedTotalFrames = nextBatchCount * item.numFrames;
      const paddingIncreaseRatio = (item.numFrames - shortestInBatch) / item.numFrames;

      if (
        nextBatchCount <= this.cfg.maxBatchSize &&
        projectedTotalFrames <= this.cfg.maxBatchTotalFrames &&
        paddingIncreaseRatio <= this.cfg.maxAllowedPaddingRatio
      ) {
        currentBatch.push(item);
      } else {
        batches.push(currentBatch);
        currentBatch = [item];
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    return batches;
  }
}
