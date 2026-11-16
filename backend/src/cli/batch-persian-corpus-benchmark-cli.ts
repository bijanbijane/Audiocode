import fs from 'node:fs';
import {
  EvaluationCorpusSampleEntry,
  PersianSpeechEvaluationCorpusBuilder,
  CorpusCoverageAuditReport,
} from '../../../src/ai-engine/evaluation/PersianSpeechEvaluationCorpusBuilder';
import {
  NodeOnnxAsrBenchmarkRunner,
  NodeAsrBenchmarkResult,
} from '../asr-worker/NodeOnnxAsrBenchmarkRunner';
import {
  AsrArchitectureKind,
  OrtRuntimeProvider,
} from '../../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';
import { PersianLanguageModelScorer } from '../../../src/ai-engine/asr/PersianCtcPrefixBeamSearchDecoder';

export interface BenchmarkDatasetItem {
  readonly meta: EvaluationCorpusSampleEntry;
  readonly wavFilePath: string;
  readonly groundTruthTranscriptPath: string;
}

export interface PersianAsrBaselineReport {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly generatedAtIso: string;
  readonly corpusAudit: CorpusCoverageAuditReport;
  readonly totalAudioMinutesEvaluated: number;
  readonly durationWeightedNormalizedWerPercent: number;
  readonly durationWeightedRawWerPercent: number;
  readonly breakdownByStyle: {
    readonly formalNormalizedWerPercent: number;
    readonly colloquialNormalizedWerPercent: number;
    readonly noisyNormalizedWerPercent: number;
  };
  readonly meanRealTimeFactor: number;
  readonly maxPeakRssMemoryMb: number;
  readonly perSampleResults: { sampleId: string; result: NodeAsrBenchmarkResult }[];
}

/**
 * Section 117: Batch Persian Speech Corpus Benchmark CLI & Section 39 Baseline Report Generator
 */
export class BatchPersianCorpusBenchmarkCli {
  public static async executeFullCorpusBaseline(params: {
    modelId: string;
    modelVersion: string;
    architecture: AsrArchitectureKind;
    encoderModelPath: string;
    decoderModelPath?: string;
    ctcVocabulary?: readonly string[];
    persianLmScorer?: PersianLanguageModelScorer;
    datasetItems: BenchmarkDatasetItem[];
    useCuda?: boolean;
    outputReportJsonPath?: string;
    customOrtProvider?: OrtRuntimeProvider;
  }): Promise<PersianAsrBaselineReport> {
    // 1. Audit legal consent & 12-axis diversity coverage (Section 39) prior to benchmark execution
    const corpusAudit = PersianSpeechEvaluationCorpusBuilder.auditCorpusCoverageAndLegality(
      params.datasetItems.map((d) => d.meta),
    );

    const perSampleResults: { sampleId: string; result: NodeAsrBenchmarkResult }[] = [];

    let totalDurationSec = 0;
    let weightedNormWerSum = 0;
    let weightedRawWerSum = 0;

    let formalDur = 0;
    let formalWerSum = 0;
    let colDur = 0;
    let colWerSum = 0;
    let noisyDur = 0;
    let noisyWerSum = 0;

    let rtfSum = 0;
    let maxPeakRssMemoryMb = 0;

    // 2. Sequentially evaluate model on every WAV + ground-truth item in the corpus
    for (const item of params.datasetItems) {
      const refText = fs.readFileSync(item.groundTruthTranscriptPath, 'utf8').trim();
      const res = await NodeOnnxAsrBenchmarkRunner.runWavBenchmark({
        wavFilePath: item.wavFilePath,
        architecture: params.architecture,
        encoderModelPath: params.encoderModelPath,
        decoderModelPath: params.decoderModelPath,
        ctcVocabulary: params.ctcVocabulary,
        persianLmScorer: params.persianLmScorer,
        groundTruthReferenceText: refText,
        useCuda: params.useCuda,
        customOrtProvider: params.customOrtProvider,
      });

      perSampleResults.push({ sampleId: item.meta.sampleId, result: res });

      const dur = res.audioDurationSeconds;
      const normWer = res.normalizedWerPercent ?? 0;
      const rawWer = res.rawWerPercent ?? 0;

      totalDurationSec += dur;
      weightedNormWerSum += normWer * dur;
      weightedRawWerSum += rawWer * dur;
      rtfSum += res.realTimeFactor;
      if (res.peakRssMemoryMb > maxPeakRssMemoryMb) {
        maxPeakRssMemoryMb = res.peakRssMemoryMb;
      }

      if (item.meta.style === 'FORMAL') {
        formalDur += dur;
        formalWerSum += normWer * dur;
      } else if (item.meta.style === 'COLLOQUIAL') {
        colDur += dur;
        colWerSum += normWer * dur;
      }

      if (item.meta.noiseTier !== 'CLEAN_STUDIO') {
        noisyDur += dur;
        noisyWerSum += normWer * dur;
      }
    }

    const safeDiv = (num: number, den: number) =>
      den > 0 ? Number((num / den).toFixed(2)) : 0;

    const report: PersianAsrBaselineReport = {
      modelId: params.modelId,
      modelVersion: params.modelVersion,
      generatedAtIso: new Date().toISOString(),
      corpusAudit,
      totalAudioMinutesEvaluated: Number((totalDurationSec / 60).toFixed(2)),
      durationWeightedNormalizedWerPercent: safeDiv(weightedNormWerSum, totalDurationSec),
      durationWeightedRawWerPercent: safeDiv(weightedRawWerSum, totalDurationSec),
      breakdownByStyle: {
        formalNormalizedWerPercent: safeDiv(formalWerSum, formalDur),
        colloquialNormalizedWerPercent: safeDiv(colWerSum, colDur),
        noisyNormalizedWerPercent: safeDiv(noisyWerSum, noisyDur),
      },
      meanRealTimeFactor:
        perSampleResults.length > 0
          ? Number((rtfSum / perSampleResults.length).toFixed(3))
          : 0,
      maxPeakRssMemoryMb,
      perSampleResults,
    };

    if (params.outputReportJsonPath) {
      fs.writeFileSync(
        params.outputReportJsonPath,
        JSON.stringify(report, null, 2),
        'utf8',
      );
    }

    return report;
  }
}
