import type { LocalNeuralTranscriptionResult } from '../../asr-core/LocalSherpaNeuralEngine';

export const CEP_TRANSCRIPT_SCHEMA_VERSION = '1.0.0' as const;

export interface CepTranscriptSegmentV1 {
  readonly id: string;
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  /** Compatibility alias retained for the current CEP editor. */
  readonly text: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly language: LocalNeuralTranscriptionResult['dominantLanguage'];
  readonly timestampGranularity: LocalNeuralTranscriptionResult['timestampGranularity'];
  readonly confidence: null;
  readonly confidenceStatus: 'UNAVAILABLE_UNCALIBRATED';
  readonly words: readonly {
    readonly word: string;
    readonly startSec: number;
    readonly endSec: number;
  }[];
}

export interface CepTranscriptResultV1 {
  readonly schemaVersion: typeof CEP_TRANSCRIPT_SCHEMA_VERSION;
  readonly modelId: string;
  readonly architecture: LocalNeuralTranscriptionResult['architecture'];
  readonly quantization: LocalNeuralTranscriptionResult['quantization'];
  readonly offlineVerified: true;
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly dominantLanguage: LocalNeuralTranscriptionResult['dominantLanguage'];
  readonly rawText: string;
  readonly normalizedText: string;
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly audioSha256: string;
  readonly timestampGranularity: LocalNeuralTranscriptionResult['timestampGranularity'];
  readonly confidenceStatus: 'UNAVAILABLE_UNCALIBRATED';
  readonly segments: readonly CepTranscriptSegmentV1[];
}

/**
 * Maps the native inference DTO into the versioned Adobe Audition panel contract.
 * The core LocalNeuralTranscriptionResult remains unchanged for other consumers.
 */
export function mapLocalNeuralResultToCepTranscriptDto(
  result: LocalNeuralTranscriptionResult,
): CepTranscriptResultV1 {
  return Object.freeze({
    schemaVersion: CEP_TRANSCRIPT_SCHEMA_VERSION,
    modelId: result.modelId,
    architecture: result.architecture,
    quantization: result.quantization,
    offlineVerified: result.offlineVerified,
    durationSec: result.durationSec,
    processingTimeMs: result.processingTimeMs,
    realTimeFactor: result.realTimeFactor,
    dominantLanguage: result.dominantLanguage,
    rawText: result.rawText,
    normalizedText: result.normalizedByProfile['FA-RELAXED-V1'] ?? result.rawText,
    sampleRateHz: result.sampleRateHz,
    channelCount: result.channelCount,
    audioSha256: result.audioSha256,
    timestampGranularity: result.timestampGranularity,
    confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
    segments: Object.freeze(result.segments.map((segment) => {
      const rawText = segment.text;
      return Object.freeze({
        id: segment.id,
        index: segment.index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: rawText,
        rawText,
        normalizedText: segment.normalizedByProfile['FA-RELAXED-V1'] ?? rawText,
        language: segment.language,
        timestampGranularity: segment.timestampGranularity,
        confidence: null,
        confidenceStatus: 'UNAVAILABLE_UNCALIBRATED' as const,
        words: Object.freeze(segment.words.map((word) => Object.freeze({
          word: word.word,
          startSec: word.startSec,
          endSec: word.endSec,
        }))),
      });
    })),
  });
}
