import { AntiAliasedResampler } from '../AntiAliasedResampler';
import { SampleRate, TimeMath } from '../../contracts/timebase.contract';
import { SileroVadOnnxRunner, VadSpeechSegment } from './SileroVadOnnxRunner';
import { AsrModelRunnerAdapter, PersianChunkedAsrEngine } from '../PersianChunkedAsrWorker';
import { TimedPersianToken } from '../PersianTextNormalizer';
import { PersianPostAsrSpellingAndCompoundRestorer } from './PersianPostAsrSpellingAndCompoundRestorer';
import { PersianNumeralAndCurrencyNormalizer } from '../PersianNumeralAndCurrencyNormalizer';
import { PersianProsodicPunctuationRestorer } from '../PersianProsodicPunctuationRestorer';
import { PersianDisfluencyEngine, DetectedSpeechIssue } from '../PersianDisfluencyEngine';
import {
  ColloquialMappedPersianToken,
  PersianColloquialAndDialectNormalizer,
} from '../PersianColloquialAndDialectNormalizer';
import { PersianAcousticSnapper } from '../../audio-engine/PersianAcousticSnapper';
import { SmartSpliceDescriptor } from '../../contracts/persian-editing.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../../runtime/memory/MemoryBudgetManager';
import { measureTypedArrayListBackingBytes } from '../../runtime/memory/MemoryPolicy';

export interface IntegratedPersianAsrOptions {
  readonly sourceSampleRate: SampleRate;
  readonly enableCompoundAndBilingualRestoration: boolean;
  readonly enableSpokenNumeralFormatting: boolean;
  readonly enableProsodicPunctuation: boolean;
  readonly convertDisplayToFormalPersian: boolean;
  readonly detectSpeechDisfluenciesAndSnapBoundaries: boolean;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly signal?: AbortSignal;
  readonly sourceMemoryAccounted?: boolean;
}

export interface IntegratedPersianAsrResult {
  readonly vadSpeechSegments: VadSpeechSegment[];
  readonly tokens: ColloquialMappedPersianToken[];
  readonly fullDisplayTranscript: string;
  readonly fullFormalTranscript: string;
  readonly detectedIssuesWithSnappedSplices: {
    readonly issue: DetectedSpeechIssue;
    readonly spliceDescriptor: SmartSpliceDescriptor;
  }[];
  readonly executionTimeMs: number;
}

export interface ResamplingWorkingSetEstimate {
  readonly sourceBackingBytes: number;
  readonly monoIntermediateBytes: number;
  readonly mono16kOutputBytes: number;
  readonly totalResamplingWorkingBytes: number;
}

/**
 * Estimates conservative source backing-buffer footprint and full 16 kHz Mono
 * allocation working set before invoking AntiAliasedResampler.processToMono16k.
 */
export function estimateFullResamplingMemory(
  sourceChannels: Float32Array[],
  sourceSampleRate: SampleRate,
): ResamplingWorkingSetEstimate {
  if (!Array.isArray(sourceChannels) || sourceChannels.length === 0 || sourceChannels[0].length === 0) {
    return {
      sourceBackingBytes: 0,
      monoIntermediateBytes: 0,
      mono16kOutputBytes: 0,
      totalResamplingWorkingBytes: 0,
    };
  }

  const measuredSourceBytes = measureTypedArrayListBackingBytes(sourceChannels);
  const sourceBackingBytes =
    measuredSourceBytes !== null
      ? measuredSourceBytes
      : sourceChannels.reduce((acc, ch) => acc + ch.byteLength, 0);

  const inputFrames = sourceChannels[0].length;
  const ratio = sourceSampleRate / 16000;
  const outputFrames =
    sourceSampleRate === 16000 ? inputFrames : Math.floor(inputFrames / ratio);

  const monoIntermediateBytes =
    sourceSampleRate === 16000 ? 0 : inputFrames * Float32Array.BYTES_PER_ELEMENT;
  const mono16kOutputBytes = outputFrames * Float32Array.BYTES_PER_ELEMENT;

  return {
    sourceBackingBytes,
    monoIntermediateBytes,
    mono16kOutputBytes,
    totalResamplingWorkingBytes: monoIntermediateBytes + mono16kOutputBytes,
  };
}

/**
 * Section 123: Runtime-Agnostic Integrated Persian ASR & Prosodic Disfluency Orchestration Service
 */
export class IntegratedPersianAsrService {
  private readonly compoundRestorer = new PersianPostAsrSpellingAndCompoundRestorer();

  constructor(
    private readonly asrRunner: AsrModelRunnerAdapter,
    private readonly vadRunner?: SileroVadOnnxRunner,
    private readonly defaultMemoryBudgetManager?: MemoryBudgetManager,
  ) {}

  /**
   * Execute complete Persian speech recognition, compound/numeral/prosodic normalization,
   * and acoustically snapped splice generation across any source sample rate
   */
  public async transcribeAndAnalyzeAudio(
    sourceChannels: Float32Array[],
    options: IntegratedPersianAsrOptions,
  ): Promise<IntegratedPersianAsrResult> {
    const t0 = performance.now();

    if (
      !Array.isArray(sourceChannels) ||
      sourceChannels.length === 0 ||
      sourceChannels[0].length === 0
    ) {
      return {
        vadSpeechSegments: [],
        tokens: [],
        fullDisplayTranscript: '',
        fullFormalTranscript: '',
        detectedIssuesWithSnappedSplices: [],
        executionTimeMs: Math.round(performance.now() - t0),
      };
    }

    const budgetManager =
      options.memoryBudgetManager ??
      this.defaultMemoryBudgetManager ??
      getSharedMemoryBudgetManager();

    const estimate = estimateFullResamplingMemory(sourceChannels, options.sourceSampleRate);

    let sourceReservation: MemoryReservation | null = null;
    let resamplerTransientReservation: MemoryReservation | null = null;
    let pcm16kReservation: MemoryReservation | null = null;

    try {
      // Reserve full expected working set BEFORE allocating full-audio buffers in processToMono16k
      if (!options.sourceMemoryAccounted && estimate.sourceBackingBytes > 0) {
        sourceReservation = budgetManager.reserve({
          owner: 'integrated-asr:source-backing',
          category: 'decoded-audio',
          bytes: estimate.sourceBackingBytes,
          priority: 'protected',
          protectedUserData: true,
        });
      }

      if (estimate.monoIntermediateBytes > 0) {
        resamplerTransientReservation = budgetManager.reserve({
          owner: 'integrated-asr:resampler-mono-intermediate',
          category: 'render-export-buffers',
          bytes: estimate.monoIntermediateBytes,
          priority: 'normal',
        });
      }

      if (estimate.mono16kOutputBytes > 0) {
        pcm16kReservation = budgetManager.reserve({
          owner: 'integrated-asr:pcm16k-mono',
          category: 'asr-input-windows',
          bytes: estimate.mono16kOutputBytes,
          priority: 'normal',
        });
      }

      // 1. Anti-aliased downsampling to 16kHz Mono (Golden Rule 14)
      const resampler = new AntiAliasedResampler(options.sourceSampleRate, 16000);
      const pcm16kMono = resampler.processToMono16k(sourceChannels);

      // Transient monoSource inside processToMono16k is no longer referenced once resampled
      if (resamplerTransientReservation) {
        budgetManager.release(resamplerTransientReservation);
        resamplerTransientReservation = null;
      }

      // 2. Run neural VAD (if provided) and windowed ASR transcription
      let vadSpeechSegments: VadSpeechSegment[] = [];
      if (this.vadRunner) {
        vadSpeechSegments = await this.vadRunner.detectSpeechSegments(pcm16kMono);
      }

      const chunkedAsr = new PersianChunkedAsrEngine(this.asrRunner, budgetManager);
      let tokens: TimedPersianToken[] = await chunkedAsr.transcribeLongAudioStream(
        pcm16kMono.length,
        async (start, count) => pcm16kMono.subarray(start, start + count),
        async () => {},
        0,
        [],
        'track-1',
        {
          memoryBudgetManager: budgetManager,
          signal: options.signal,
        },
      );

      // 3. Restore split Persian compounds, ZWNJ prefixes/suffixes, and bilingual terms (gap <= 180ms)
      if (options.enableCompoundAndBilingualRestoration) {
        tokens = this.compoundRestorer.restoreCompoundsAndBilingualTerms(tokens, 180);
      }

      // 4. Format spoken Persian numerals & currencies in Display layer only
      if (options.enableSpokenNumeralFormatting) {
        tokens = PersianNumeralAndCurrencyNormalizer.formatSpokenNumbersInDisplayLayer(tokens);
      }

      // 5. Restore prosodic punctuation (، . ؟) from F0 pitch contour and pauses
      if (options.enableProsodicPunctuation) {
        tokens = PersianProsodicPunctuationRestorer.restorePunctuationInDisplayLayer(
          tokens,
          pcm16kMono,
          16000,
        );
      }

      // 6. Detect Persian disfluencies and snap splice boundaries to RMS energy valleys + in-phase zero crossings
      const detectedIssuesWithSnappedSplices: IntegratedPersianAsrResult['detectedIssuesWithSnappedSplices'] =
        [];

      if (options.detectSpeechDisfluenciesAndSnapBoundaries) {
        const issues = PersianDisfluencyEngine.analyzeTranscript(tokens);
        for (const issue of issues) {
          const rawStartS = TimeMath.flicksToSamplesFloor(issue.targetRange.start, 16000);
          const rawEndS = TimeMath.flicksToSamplesFloor(issue.targetRange.end, 16000);

          const valleyStart = PersianAcousticSnapper.findMinimumEnergySample(
            pcm16kMono,
            rawStartS,
            16000,
          );
          const valleyEnd = PersianAcousticSnapper.findMinimumEnergySample(
            pcm16kMono,
            rawEndS,
            16000,
          );

          const snappedStartS = PersianAcousticSnapper.snapToZeroCrossing(
            pcm16kMono,
            valleyStart,
            16000,
            true,
          );
          const snappedEndS = PersianAcousticSnapper.snapToZeroCrossing(
            pcm16kMono,
            valleyEnd,
            16000,
            true,
          );

          detectedIssuesWithSnappedSplices.push({
            issue,
            spliceDescriptor: {
              rawAiRange: issue.targetRange,
              snappedAcousticRange: {
                start: TimeMath.samplesToFlicks(snappedStartS, 16000),
                end: TimeMath.samplesToFlicks(snappedEndS, 16000),
              },
              fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
              fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
              injectRoomToneFlicks: issue.suggestedRemainingPauseFlicks,
              cutStrategy: 'GLOBAL_SYNC_RIPPLE',
              prosodicWarnings: [],
              confidence: issue.compositeConfidence,
            },
          });
        }
      }

      // 7. Enrich with formal standard Persian layer while preserving originalText provenance
      const enrichedTokens = PersianColloquialAndDialectNormalizer.enrichTranscriptWithFormalLayer(
        tokens,
        options.convertDisplayToFormalPersian,
      );

      return {
        vadSpeechSegments,
        tokens: enrichedTokens,
        fullDisplayTranscript: enrichedTokens.map((t) => t.displayText).join(' '),
        fullFormalTranscript: enrichedTokens
          .map((t) => t.formalStandardEquivalent)
          .join(' '),
        detectedIssuesWithSnappedSplices,
        executionTimeMs: Math.round(performance.now() - t0),
      };
    } finally {
      budgetManager.release(resamplerTransientReservation);
      budgetManager.release(pcm16kReservation);
      budgetManager.release(sourceReservation);
    }
  }
}
