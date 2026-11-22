import { OrtRuntimeProvider, OrtSessionLike } from './UnifiedOnnxPersianAsrEngine';
import { SampleIndex, TimeMath, TimeRange } from '../../contracts/timebase.contract';

export interface VadSpeechSegment {
  readonly startSample16k: SampleIndex;
  readonly endSample16k: SampleIndex;
  readonly range: TimeRange;
  readonly peakSpeechProb: number;
}

export interface ConsolidatedAsrBatch {
  readonly batchIndex: number;
  readonly speechSegments: VadSpeechSegment[];
  readonly totalSpeechDurationSec: number;
  /** Concatenated 16kHz PCM without long silences for multi-x ASR speedup with exact timestamp mapping */
  readonly concatenated16kPcm: Float32Array;
  readonly offsetMappings: {
    readonly batchStartSample: SampleIndex;
    readonly batchEndSample: SampleIndex;
    readonly originalAudioStartSample: SampleIndex;
  }[];
}

/**
 * Section 105: Silero VAD v5 Neural ONNX Runner with LSTM State Carryover & Smart Batch Consolidation
 */
export class SileroVadOnnxRunner {
  private static readonly SAMPLE_RATE = 16000;
  private static readonly WINDOW_SAMPLES = 512; // 32ms frame @ 16kHz
  private static readonly CONTEXT_SAMPLES = 64; // 4ms context window [Silero v5 spec]
  private static readonly STATE_SIZE = 2 * 1 * 128; // [2, 1, 128]

  private session: OrtSessionLike | null = null;

  constructor(private readonly ortProvider: OrtRuntimeProvider) {}

  public async loadModel(
    sileroModelBytesOrPath: Uint8Array | string,
    executionProviders: ('wasm' | 'cpu')[] = ['wasm'],
  ): Promise<void> {
    this.session = await this.ortProvider.createSession(
      sileroModelBytesOrPath,
      executionProviders,
    );
  }

  public async unloadModel(): Promise<void> {
    if (this.session?.release) await this.session.release();
    this.session = null;
  }

  /**
   * 1. Scan full 16kHz Mono audio with Silero VAD v5 neural network and extract exact speech intervals
   */
  public async detectSpeechSegments(
    pcm16kMono: Float32Array,
    options?: {
      startThreshold?: number; // Default 0.50
      endThreshold?: number; // Default 0.35 (hysteresis anti-flutter)
      minSpeechMs?: number; // Default 250ms
      minSilenceMs?: number; // Default 120ms
      speechPadMs?: number; // Default 30ms safety margin around Persian unvoiced plosives/fricatives
    },
  ): Promise<VadSpeechSegment[]> {
    if (!this.session) {
      throw new Error('SILERO_VAD_SESSION_NOT_LOADED');
    }

    const startThresh = options?.startThreshold ?? 0.5;
    const endThresh = options?.endThreshold ?? 0.35;
    const minSpeechSamples = Math.floor(
      (SileroVadOnnxRunner.SAMPLE_RATE * (options?.minSpeechMs ?? 250)) / 1000,
    );
    const minSilenceSamples = Math.floor(
      (SileroVadOnnxRunner.SAMPLE_RATE * (options?.minSilenceMs ?? 120)) / 1000,
    );
    const padSamples = Math.floor(
      (SileroVadOnnxRunner.SAMPLE_RATE * (options?.speechPadMs ?? 30)) / 1000,
    );

    let stateBuffer = new Float32Array(SileroVadOnnxRunner.STATE_SIZE); // Initial zeros [2, 1, 128]
    const contextBuffer = new Float32Array(SileroVadOnnxRunner.CONTEXT_SAMPLES);
    const frameWithContext = new Float32Array(
      SileroVadOnnxRunner.CONTEXT_SAMPLES + SileroVadOnnxRunner.WINDOW_SAMPLES,
    );
    // Silero VAD ONNX declares sr as a scalar int64 tensor (rank 0), not [1].
    const srTensor = this.ortProvider.createTensor(
      'int64',
      BigInt64Array.from([BigInt(SileroVadOnnxRunner.SAMPLE_RATE)]),
      [],
    );

    const frameProbs: { startSample: number; prob: number }[] = [];

    for (
      let pos = 0;
      pos < pcm16kMono.length;
      pos += SileroVadOnnxRunner.WINDOW_SAMPLES
    ) {
      const remaining = pcm16kMono.length - pos;
      frameWithContext.fill(0);
      frameWithContext.set(contextBuffer, 0);

      if (remaining >= SileroVadOnnxRunner.WINDOW_SAMPLES) {
        frameWithContext.set(
          pcm16kMono.subarray(pos, pos + SileroVadOnnxRunner.WINDOW_SAMPLES),
          SileroVadOnnxRunner.CONTEXT_SAMPLES,
        );
      } else {
        frameWithContext.set(
          pcm16kMono.subarray(pos),
          SileroVadOnnxRunner.CONTEXT_SAMPLES,
        );
      }

      // Preserve trailing 64 samples as context for next frame
      contextBuffer.set(
        frameWithContext.subarray(
          SileroVadOnnxRunner.WINDOW_SAMPLES,
          SileroVadOnnxRunner.WINDOW_SAMPLES + SileroVadOnnxRunner.CONTEXT_SAMPLES,
        ),
      );

      const inputTensor = this.ortProvider.createTensor('float32', frameWithContext, [
        1,
        frameWithContext.length,
      ]);
      const stateTensor = this.ortProvider.createTensor('float32', stateBuffer, [
        2,
        1,
        128,
      ]);

      const outputs = await this.session.run({
        input: inputTensor,
        state: stateTensor,
        sr: srTensor,
      });

      const probTensor = outputs['output'] ?? Object.values(outputs)[0];
      const nextStateTensor = outputs['stateN'] ?? Object.values(outputs)[1];

      const speechProb = (probTensor.data as Float32Array)[0];
      stateBuffer = new Float32Array(nextStateTensor.data as Float32Array);

      frameProbs.push({ startSample: pos, prob: speechProb });
    }

    // 2. Convert frame probabilities into contiguous speech segments with hysteresis and hangover
    const segments: VadSpeechSegment[] = [];
    let isTriggered = false;
    let currentSpeechStart = 0;
    let tempSilenceStart = -1;
    let peakProb = 0;

    for (const fp of frameProbs) {
      if (fp.prob >= startThresh) {
        if (!isTriggered) {
          isTriggered = true;
          currentSpeechStart = fp.startSample;
          peakProb = fp.prob;
        } else {
          if (fp.prob > peakProb) peakProb = fp.prob;
          tempSilenceStart = -1; // Speech resumed before hangover expired
        }
      } else if (isTriggered && fp.prob >= endThresh) {
        if (fp.prob > peakProb) peakProb = fp.prob;
        tempSilenceStart = -1; // Hysteresis: weak speech above end threshold cancels pending silence
      } else if (isTriggered && fp.prob < endThresh) {
        if (tempSilenceStart === -1) {
          tempSilenceStart = fp.startSample;
        }
        if (fp.startSample - tempSilenceStart >= minSilenceSamples) {
          const speechEnd = tempSilenceStart + SileroVadOnnxRunner.WINDOW_SAMPLES;
          if (speechEnd - currentSpeechStart >= minSpeechSamples) {
            const sSample = Math.max(0, currentSpeechStart - padSamples);
            const eSample = Math.min(pcm16kMono.length, speechEnd + padSamples);
            segments.push({
              startSample16k: sSample,
              endSample16k: eSample,
              range: {
                start: TimeMath.samplesToFlicks(sSample, 16000),
                end: TimeMath.samplesToFlicks(eSample, 16000),
              },
              peakSpeechProb: Number(peakProb.toFixed(3)),
            });
          }
          isTriggered = false;
          tempSilenceStart = -1;
          peakProb = 0;
        }
      }
    }

    if (isTriggered) {
      const sSample = Math.max(0, currentSpeechStart - padSamples);
      const eSample = pcm16kMono.length;
      if (eSample - sSample >= minSpeechSamples) {
        segments.push({
          startSample16k: sSample,
          endSample16k: eSample,
          range: {
            start: TimeMath.samplesToFlicks(sSample, 16000),
            end: TimeMath.samplesToFlicks(eSample, 16000),
          },
          peakSpeechProb: Number(peakProb.toFixed(3)),
        });
      }
    }

    return segments;
  }

  /**
   * 2. Consolidate speech segments into max 25-second batches for ASR acceleration while preserving original timeline offset mappings
   */
  public static buildConsolidatedAsrBatches(
    pcm16kMono: Float32Array,
    segments: VadSpeechSegment[],
    maxBatchDurationSec: number = 25.0,
  ): ConsolidatedAsrBatch[] {
    if (segments.length === 0) return [];
    const maxBatchSamples = Math.floor(SileroVadOnnxRunner.SAMPLE_RATE * maxBatchDurationSec);
    // Insert 100ms clean silence spacer between segments inside a batch so ASR doesn't fuse words across cuts
    const interSegmentSpacerSamples = Math.floor(SileroVadOnnxRunner.SAMPLE_RATE * 0.1);

    const batches: ConsolidatedAsrBatch[] = [];
    let currentGroup: VadSpeechSegment[] = [];
    let currentSamplesAccum = 0;

    const flushBatch = () => {
      if (currentGroup.length === 0) return;
      const concatBuf = new Float32Array(currentSamplesAccum);
      const mappings: ConsolidatedAsrBatch['offsetMappings'] = [];
      let writeCursor = 0;

      for (let i = 0; i < currentGroup.length; i++) {
        const seg = currentGroup[i];
        const segLen = seg.endSample16k - seg.startSample16k;
        concatBuf.set(pcm16kMono.subarray(seg.startSample16k, seg.endSample16k), writeCursor);
        mappings.push({
          batchStartSample: writeCursor,
          batchEndSample: writeCursor + segLen,
          originalAudioStartSample: seg.startSample16k,
        });
        writeCursor += segLen;
        if (i < currentGroup.length - 1) {
          writeCursor += interSegmentSpacerSamples;
        }
      }

      batches.push({
        batchIndex: batches.length,
        speechSegments: currentGroup,
        totalSpeechDurationSec: Number(
          (concatBuf.length / SileroVadOnnxRunner.SAMPLE_RATE).toFixed(2),
        ),
        concatenated16kPcm: concatBuf,
        offsetMappings: mappings,
      });

      currentGroup = [];
      currentSamplesAccum = 0;
    };

    for (const seg of segments) {
      const segLen = seg.endSample16k - seg.startSample16k;
      const neededWithSpacer =
        currentGroup.length > 0 ? segLen + interSegmentSpacerSamples : segLen;

      if (currentGroup.length > 0 && currentSamplesAccum + neededWithSpacer > maxBatchSamples) {
        flushBatch();
      }

      currentGroup.push(seg);
      currentSamplesAccum +=
        currentGroup.length > 1 ? segLen + interSegmentSpacerSamples : segLen;
    }
    flushBatch();

    return batches;
  }
}
