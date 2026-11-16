import { SampleRate, TimeMath } from '../contracts/timebase.contract';
import { PersianTextNormalizer } from '../ai-engine/PersianTextNormalizer';
import { PersianAcousticSnapper } from '../audio-engine/PersianAcousticSnapper';
import {
  GraphEdge,
  ProcessingGraphEngine,
  ProcessingNodeSpec,
} from '../processing-core/ProcessingGraphEngine';

export interface QualityGateResult {
  readonly gateName: string;
  readonly passed: boolean;
  readonly measuredValue: string;
  readonly threshold: string;
  readonly details: string;
}

export interface PoCTechnologyEvaluationReport {
  readonly generatedAtIso: string;
  readonly allGatesPassed: boolean;
  readonly results: QualityGateResult[];
}

/**
 * Automated Benchmark, Persian WER Evaluator & Release Quality Gate Runner
 * (Architecture Doc Sections 39, 62-65 & Appendix 1 Section 68)
 */
export class AutomatedQualityGateRunner {
  public static computePersianWER(
    referenceText: string,
    hypothesisText: string,
  ): {
    rawWerPercent: number;
    normalizedWerPercent: number;
  } {
    const rawRefWords = referenceText.trim().split(/\s+/).filter(Boolean);
    const rawHypWords = hypothesisText.trim().split(/\s+/).filter(Boolean);

    const normRefWords = PersianTextNormalizer.normalizeTokenText(referenceText)
      .split(/\s+/)
      .filter(Boolean);
    const normHypWords = PersianTextNormalizer.normalizeTokenText(hypothesisText)
      .split(/\s+/)
      .filter(Boolean);

    return {
      rawWerPercent: Number((this.levenshteinWordRatio(rawRefWords, rawHypWords) * 100).toFixed(2)),
      normalizedWerPercent: Number(
        (this.levenshteinWordRatio(normRefWords, normHypWords) * 100).toFixed(2),
      ),
    };
  }

  private static levenshteinWordRatio(ref: string[], hyp: string[]): number {
    if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
    const dp: number[][] = Array.from({ length: ref.length + 1 }, () =>
      new Array<number>(hyp.length + 1).fill(0),
    );

    for (let i = 0; i <= ref.length; i++) dp[i][0] = i;
    for (let j = 0; j <= hyp.length; j++) dp[0][j] = j;

    for (let i = 1; i <= ref.length; i++) {
      for (let j = 1; j <= hyp.length; j++) {
        const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[ref.length][hyp.length] / ref.length;
  }

  public static runAllCoreQualityGates(): PoCTechnologyEvaluationReport {
    const results: QualityGateResult[] = [
      this.testTimebaseZeroDriftGate(),
      this.testAcousticSpliceZeroClickGate(),
      this.testGraphAutomaticPdcGate(),
      this.testPersianNormalizationProvenanceGate(),
    ];

    return {
      generatedAtIso: new Date().toISOString(),
      allGatesPassed: results.every((r) => r.passed),
      results,
    };
  }

  private static testTimebaseZeroDriftGate(): QualityGateResult {
    const rates: SampleRate[] = [16000, 44100, 48000];
    const tenHoursSeconds = 10 * 3600;
    let maxSampleError = 0;

    for (const rate of rates) {
      const exactSamples = tenHoursSeconds * rate;
      const flicks = TimeMath.samplesToFlicks(exactSamples, rate);
      const roundtripSamples = TimeMath.flicksToSamplesFloor(flicks, rate);
      const err = Math.abs(exactSamples - roundtripSamples);
      if (err > maxSampleError) maxSampleError = err;
    }

    return {
      gateName: 'Timebase Zero-Drift Gate (10-Hour Multi-Rate Roundtrip)',
      passed: maxSampleError === 0,
      measuredValue: `${maxSampleError} samples drift`,
      threshold: '0 samples drift',
      details: 'تبدیل دوطرفه ۱۰ ساعت صوت بین نرخ‌های 16kHz، 44.1kHz و 48kHz با پایه Flicks.',
    };
  }

  private static testAcousticSpliceZeroClickGate(): QualityGateResult {
    const sampleRate: SampleRate = 48000;
    const len = 4800; // 100ms
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    const roomTone = new Float32Array(2400);

    for (let i = 0; i < len; i++) {
      left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
      right[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate + 1.7);
    }
    for (let i = 0; i < roomTone.length; i++) {
      roomTone[i] = 0.002 * Math.sin((2 * Math.PI * 60 * i) / sampleRate);
    }

    const spliced = PersianAcousticSnapper.applySeamlessSplice(
      left,
      right,
      roomTone,
      sampleRate,
      10,
      40,
    );

    let maxStepDelta = 0;
    for (let i = 1; i < spliced.length; i++) {
      const delta = Math.abs(spliced[i] - spliced[i - 1]);
      if (delta > maxStepDelta) maxStepDelta = delta;
    }

    const passed = maxStepDelta < 0.05;

    return {
      gateName: 'Persian Acoustic Splice Smoothness & Room-Tone Gate',
      passed,
      measuredValue: `Max Sample Step Delta = ${maxStepDelta.toFixed(4)}`,
      threshold: 'Delta < 0.0500 (Zero Audible Click)',
      details: 'بررسی پیوستگی مشتق اول سیگنال در نقطه برش همراه با Equal-Power Crossfade و Room Tone.',
    };
  }

  private static testGraphAutomaticPdcGate(): QualityGateResult {
    const engine = new ProcessingGraphEngine();
    const nodes: ProcessingNodeSpec[] = [
      {
        id: 'src',
        type: 'TRACK_SOURCE',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
      {
        id: 'dry_eq',
        type: 'EQ_FILTER',
        version: '1.0',
        enabled: true,
        latencySamples: 64,
        preRollSamples: 256,
        tailSamples: 0,
        committedParameters: {},
      },
      {
        id: 'heavy_ai_denoiser',
        type: 'AI_DENOISER',
        version: '1.0',
        enabled: true,
        latencySamples: 2048,
        preRollSamples: 1024,
        tailSamples: 512,
        committedParameters: {},
      },
      {
        id: 'master_bus',
        type: 'BUS_MIXER',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
    ];

    const edges: GraphEdge[] = [
      { fromNodeId: 'src', toNodeId: 'dry_eq' },
      { fromNodeId: 'src', toNodeId: 'heavy_ai_denoiser' },
      { fromNodeId: 'dry_eq', toNodeId: 'master_bus' },
      { fromNodeId: 'heavy_ai_denoiser', toNodeId: 'master_bus' },
    ];

    const plan = engine.compileGraph(nodes, edges, 48000, ['asset_hash_1']);
    const expectedCompensation = 2048 - 64;
    const actualCompensation = plan.pdcInsertions[0]?.compensationDelaySamples ?? -1;

    return {
      gateName: 'Processing Graph Automatic PDC & Pre-Roll Gate',
      passed: actualCompensation === expectedCompensation && plan.requiredPreRollSamples === 1280,
      measuredValue: `PDC = ${actualCompensation} samples, Pre-Roll = ${plan.requiredPreRollSamples} samples`,
      threshold: `PDC = ${expectedCompensation} samples, Pre-Roll = 1280 samples`,
      details: 'هم‌فازسازی خودکار شاخه موازی سریع (64 نمونه) با شاخه هوش مصنوعی (2048 نمونه).',
    };
  }

  private static testPersianNormalizationProvenanceGate(): QualityGateResult {
    const rawInput = [
      {
        id: 'tok_1',
        text: 'می كنم',
        range: { start: 1000, end: 5000 },
        confidence: 0.92,
      },
    ];

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript(rawInput);
    const t = tokens[0];
    const ZWNJ = '\u200c';

    const passed =
      t.originalText === 'می كنم' &&
      t.normalizedText === `می${ZWNJ}کنم` &&
      t.range.start === 1000 &&
      t.range.end === 5000;

    return {
      gateName: 'Persian 3-Layer Normalization & Provenance Gate',
      passed,
      measuredValue: `Orig="${t.originalText}" -> Norm="${t.normalizedText}"`,
      threshold: 'Orig preserved & Norm="می‌کنم" with ZWNJ',
      details: 'حفظ متن خام اصلی در کنار تبدیل ک عربی و درج نیم‌فاصله استاندارد بدون تغییر Timestamp.',
    };
  }
}
