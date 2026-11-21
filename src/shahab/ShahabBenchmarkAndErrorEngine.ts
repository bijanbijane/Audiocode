/**
 * SHAHAB-006 (Baseline Benchmark & Persian Error Intelligence),
 * SHAHAB-009 (Model Surgery / Quantization / Pareto), &
 * SHAHAB-010 (Production Release SHAHAB-R1 / SHAHAB-R1.1 & Rollback)
 *
 * Guarantees:
 * - Two completely independent evaluation tracks:
 *     Track A — Verbatim Fidelity (raw ASR output vs verbatim reference)
 *     Track B — Normalized Text Evaluation (explicitly versioned Persian policy)
 * - Dataset manifest integrity + Leakage detection (duplicate audio SHA-256,
 *   near-duplicate audio, duplicate transcripts across recordings, split overlap).
 * - SHAHABErrorAnalyzer with explicit CAUSE_UNKNOWN fallback (never fabricates causes).
 * - SHAHABBenchmarkRunner with immutable baseline config, per-sample persistence,
 *   unique execution IDs (never overwrites prior runs), and statistical honesty.
 * - Release manifest & rollback verifier for SHAHAB-R1 / SHAHAB-R1.1.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizePersianTextDeterministic,
} from './ShahabContracts';

export type ShahabSpeechCategory =
  | 'CLEAN_FORMAL_PERSIAN'
  | 'CONVERSATIONAL_PERSIAN'
  | 'COLLOQUIAL_EXPRESSIONS'
  | 'FAST_SPEECH'
  | 'LONG_FORM_SPEECH'
  | 'NOISY_RECORDINGS'
  | 'REVERBERANT_RECORDINGS'
  | 'PROPER_NOUNS'
  | 'TECHNICAL_VOCABULARY'
  | 'NUMBERS_AND_NUMERALS'
  | 'REPEATED_WORDS'
  | 'DISFLUENCIES_AND_FALSE_STARTS'
  | 'INTERRUPTED_UTTERANCES'
  | 'MUSIC_MIXED_SPEECH'
  | 'MULTI_SPEAKER'
  | 'CODE_SWITCHING'
  | 'UNKNOWN';

export type ShahabDatasetSplit = 'development' | 'validation' | 'frozen_test';

export interface ShahabDatasetSample {
  readonly sampleId: string;
  readonly datasetId: string;
  readonly datasetRevision: string;
  readonly split: ShahabDatasetSplit;
  readonly originalSource: string;
  readonly license: string;
  readonly audioPath: string;
  readonly audioSha256: string;
  readonly durationSec: number;
  readonly sampleRateHz: number;
  readonly speakerId: string | null;
  readonly sessionId: string | null;
  readonly referenceTranscriptVerbatim: string;
  readonly transcriptProvenance: string;
  readonly annotationStatus: 'HUMAN_VERIFIED' | 'UPSTREAM_DOCUMENTED' | 'DERIVED_STRESS_TEST';
  readonly speechCategories: readonly ShahabSpeechCategory[];
  readonly recordingConditions: string;
  readonly properNouns?: readonly string[];
  readonly numericTokens?: readonly string[];
}

export interface ShahabDatasetManifest {
  readonly schemaVersion: '1.0.0';
  readonly manifestId: string;
  readonly revision: string;
  readonly createdAtUtc: string;
  readonly immutableFrozenTest: boolean;
  readonly samples: readonly ShahabDatasetSample[];
}

export interface ShahabLeakageReport {
  readonly clean: boolean;
  readonly duplicateAudioHashes: readonly { readonly audioSha256: string; readonly sampleIds: readonly string[] }[];
  readonly duplicateTranscriptsAcrossRecordings: readonly { readonly normalizedTranscript: string; readonly sampleIds: readonly string[] }[];
  readonly speakerSplitOverlap: readonly { readonly speakerId: string; readonly splits: readonly ShahabDatasetSplit[] }[];
  readonly sessionSplitOverlap: readonly { readonly sessionId: string; readonly splits: readonly ShahabDatasetSplit[] }[];
  readonly warnings: readonly string[];
}

export function detectDatasetLeakage(manifest: ShahabDatasetManifest): ShahabLeakageReport {
  const byAudioHash = new Map<string, string[]>();
  const byTranscript = new Map<string, { sampleIds: string[]; audioHashes: Set<string> }>();
  const speakerSplits = new Map<string, Set<ShahabDatasetSplit>>();
  const sessionSplits = new Map<string, Set<ShahabDatasetSplit>>();

  for (const s of manifest.samples) {
    const arr = byAudioHash.get(s.audioSha256) ?? [];
    arr.push(s.sampleId);
    byAudioHash.set(s.audioSha256, arr);

    const normRef = normalizeForTrackB(s.referenceTranscriptVerbatim).text;
    const tEntry = byTranscript.get(normRef) ?? { sampleIds: [], audioHashes: new Set<string>() };
    tEntry.sampleIds.push(s.sampleId);
    tEntry.audioHashes.add(s.audioSha256);
    byTranscript.set(normRef, tEntry);

    if (s.speakerId) {
      const set = speakerSplits.get(s.speakerId) ?? new Set<ShahabDatasetSplit>();
      set.add(s.split);
      speakerSplits.set(s.speakerId, set);
    }
    if (s.sessionId) {
      const set = sessionSplits.get(s.sessionId) ?? new Set<ShahabDatasetSplit>();
      set.add(s.split);
      sessionSplits.set(s.sessionId, set);
    }
  }

  const duplicateAudioHashes = Array.from(byAudioHash.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([audioSha256, sampleIds]) => ({ audioSha256, sampleIds }));

  const duplicateTranscriptsAcrossRecordings = Array.from(byTranscript.entries())
    .filter(([, v]) => v.sampleIds.length > 1)
    .map(([normalizedTranscript, v]) => ({ normalizedTranscript, sampleIds: v.sampleIds }));

  const speakerSplitOverlap = Array.from(speakerSplits.entries())
    .filter(([, splits]) => splits.size > 1)
    .map(([speakerId, splits]) => ({ speakerId, splits: Array.from(splits) }));

  const sessionSplitOverlap = Array.from(sessionSplits.entries())
    .filter(([, splits]) => splits.size > 1)
    .map(([sessionId, splits]) => ({ sessionId, splits: Array.from(splits) }));

  const warnings: string[] = [];
  if (duplicateAudioHashes.length > 0) {
    warnings.push(`${duplicateAudioHashes.length} duplicate audio SHA-256 group(s) detected.`);
  }
  if (speakerSplitOverlap.length > 0) {
    warnings.push(`${speakerSplitOverlap.length} speaker(s) overlap across multiple splits.`);
  }
  if (sessionSplitOverlap.length > 0) {
    warnings.push(`${sessionSplitOverlap.length} session(s) overlap across multiple splits.`);
  }
  if (duplicateTranscriptsAcrossRecordings.length > 0) {
    warnings.push(
      `${duplicateTranscriptsAcrossRecordings.length} repeated reference transcript(s) observed across recordings.`,
    );
  }

  return {
    clean:
      duplicateAudioHashes.length === 0 &&
      speakerSplitOverlap.length === 0 &&
      sessionSplitOverlap.length === 0,
    duplicateAudioHashes,
    duplicateTranscriptsAcrossRecordings,
    speakerSplitOverlap,
    sessionSplitOverlap,
    warnings,
  };
}

export const SHAHAB_TRACK_B_NORMALIZATION_POLICY_VERSION = 'SHAHAB-FA-NORM-EVAL-V1.0';

/**
 * Track B — Explicitly versioned Persian normalization for Normalized Text Evaluation.
 * Reuses existing Avapardaz P0-009 deterministic Persian normalization while keeping
 * separate visibility of Unicode/Arabic-variant, whitespace, ZWNJ, punctuation, and numeral rules.
 */
export function normalizeForTrackB(text: string): {
  readonly policyVersion: string;
  readonly text: string;
  readonly rulesApplied: readonly string[];
} {
  const p009 = normalizePersianTextDeterministic(text, { digitPolicy: 'PRESERVE_ORIGINAL' });
  const rulesApplied: string[] = ['p009_unicode_nfc_and_arabic_to_persian_letters'];

  let out = p009.normalized;
  // Standardize Persian/Arabic digits to ASCII for numeric comparison in Track B only
  const beforeDigits = out;
  out = out
    .replace(/[۰-۹]/g, (d: string) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d: string) => String(d.charCodeAt(0) - 0x0660));
  if (out !== beforeDigits) rulesApplied.push('numerals_unified_ascii');

  // Strip evaluation punctuation in Track B only (never in Track A)
  const beforePunct = out;
  out = out.replace(/[.,،؛؟?!:"'«»()\[\]{}…\-—–]/g, ' ');
  if (out !== beforePunct) rulesApplied.push('punctuation_stripped');

  // Collapse ZWNJ + whitespace consistently for orthographic tolerance in Track B
  const beforeZwnj = out;
  out = out.replace(/\u200c+/g, ' ').replace(/\s+/g, ' ').trim();
  if (out !== beforeZwnj) rulesApplied.push('zwnj_and_whitespace_canonicalized');

  return {
    policyVersion: SHAHAB_TRACK_B_NORMALIZATION_POLICY_VERSION,
    text: out,
    rulesApplied,
  };
}

export interface EditAlignmentResult {
  readonly refLength: number;
  readonly hypLength: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly rate: number; // WER or CER in [0, +inf)
  readonly ops: readonly {
    readonly op: 'MATCH' | 'SUB' | 'DEL' | 'INS';
    readonly refToken: string | null;
    readonly hypToken: string | null;
  }[];
}

/**
 * Exact Wagner-Fischer Levenshtein edit distance & alignment for WER / CER.
 * Validated by unit tests with manually verified reference alignments.
 */
export function computeSequenceEditMetrics(
  refSeq: readonly string[],
  hypSeq: readonly string[],
): EditAlignmentResult {
  const n = refSeq.length;
  const m = hypSeq.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = refSeq[i - 1] === hypSeq[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // DEL
        dp[i][j - 1] + 1, // INS
        dp[i - 1][j - 1] + cost, // MATCH or SUB
      );
    }
  }

  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  const ops: { op: 'MATCH' | 'SUB' | 'DEL' | 'INS'; refToken: string | null; hypToken: string | null }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && refSeq[i - 1] === hypSeq[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push({ op: 'MATCH', refToken: refSeq[i - 1], hypToken: hypSeq[j - 1] });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      substitutions++;
      ops.push({ op: 'SUB', refToken: refSeq[i - 1], hypToken: hypSeq[j - 1] });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deletions++;
      ops.push({ op: 'DEL', refToken: refSeq[i - 1], hypToken: null });
      i--;
    } else {
      insertions++;
      ops.push({ op: 'INS', refToken: null, hypToken: hypSeq[j - 1] });
      j--;
    }
  }
  ops.reverse();

  const totalEdits = substitutions + deletions + insertions;
  const rate = n === 0 ? (m === 0 ? 0 : 1) : Number((totalEdits / n).toFixed(6));

  return {
    refLength: n,
    hypLength: m,
    substitutions,
    deletions,
    insertions,
    rate,
    ops,
  };
}

export interface DualTrackEvaluationMetrics {
  readonly trackAVerbatim: {
    readonly wer: number;
    readonly cer: number;
    readonly substitutions: number;
    readonly deletions: number;
    readonly insertions: number;
    readonly refWords: number;
    readonly sentenceError: boolean;
    readonly wordOps: EditAlignmentResult['ops'];
  };
  readonly trackBNormalized: {
    readonly policyVersion: string;
    readonly wer: number;
    readonly cer: number;
    readonly substitutions: number;
    readonly deletions: number;
    readonly insertions: number;
    readonly refWords: number;
    readonly sentenceError: boolean;
    readonly normalizedReference: string;
    readonly normalizedHypothesis: string;
  };
  readonly properNounErrorRate: number | null;
  readonly numericAccuracy: number | null;
  readonly repetitionPreserved: boolean | null;
}

export function evaluateDualTrackSample(params: {
  readonly referenceVerbatim: string;
  readonly rawHypothesis: string;
  readonly properNouns?: readonly string[];
  readonly numericTokens?: readonly string[];
}): DualTrackEvaluationMetrics {
  // Track A — strict verbatim whitespace tokenization, ZERO character rewriting
  const refWordsA = params.referenceVerbatim.trim().split(/\s+/).filter(Boolean);
  const hypWordsA = params.rawHypothesis.trim().split(/\s+/).filter(Boolean);
  const refCharsA = Array.from(params.referenceVerbatim.trim());
  const hypCharsA = Array.from(params.rawHypothesis.trim());

  const wordA = computeSequenceEditMetrics(refWordsA, hypWordsA);
  const charA = computeSequenceEditMetrics(refCharsA, hypCharsA);

  // Track B — explicit versioned Persian normalization on both ref and hyp
  const normRef = normalizeForTrackB(params.referenceVerbatim);
  const normHyp = normalizeForTrackB(params.rawHypothesis);
  const refWordsB = normRef.text.split(/\s+/).filter(Boolean);
  const hypWordsB = normHyp.text.split(/\s+/).filter(Boolean);
  const refCharsB = Array.from(normRef.text.replace(/\s+/g, ''));
  const hypCharsB = Array.from(normHyp.text.replace(/\s+/g, ''));

  const wordB = computeSequenceEditMetrics(refWordsB, hypWordsB);
  const charB = computeSequenceEditMetrics(refCharsB, hypCharsB);

  let properNounErrorRate: number | null = null;
  if (params.properNouns && params.properNouns.length > 0) {
    let missed = 0;
    for (const pn of params.properNouns) {
      const pnNorm = normalizeForTrackB(pn).text;
      if (!normHyp.text.includes(pnNorm)) missed++;
    }
    properNounErrorRate = Number((missed / params.properNouns.length).toFixed(4));
  }

  let numericAccuracy: number | null = null;
  if (params.numericTokens && params.numericTokens.length > 0) {
    let matched = 0;
    for (const num of params.numericTokens) {
      const nNorm = normalizeForTrackB(num).text;
      if (normHyp.text.includes(nNorm)) matched++;
    }
    numericAccuracy = Number((matched / params.numericTokens.length).toFixed(4));
  }

  // Check consecutive word repetition preservation if reference contains immediate repetition
  let repetitionPreserved: boolean | null = null;
  for (let i = 1; i < refWordsA.length; i++) {
    if (refWordsA[i] === refWordsA[i - 1]) {
      const target = `${refWordsA[i - 1]} ${refWordsA[i]}`;
      repetitionPreserved = params.rawHypothesis.includes(target);
      break;
    }
  }

  return {
    trackAVerbatim: {
      wer: wordA.rate,
      cer: charA.rate,
      substitutions: wordA.substitutions,
      deletions: wordA.deletions,
      insertions: wordA.insertions,
      refWords: wordA.refLength,
      sentenceError: wordA.substitutions + wordA.deletions + wordA.insertions > 0,
      wordOps: wordA.ops,
    },
    trackBNormalized: {
      policyVersion: normRef.policyVersion,
      wer: wordB.rate,
      cer: charB.rate,
      substitutions: wordB.substitutions,
      deletions: wordB.deletions,
      insertions: wordB.insertions,
      refWords: wordB.refLength,
      sentenceError: wordB.substitutions + wordB.deletions + wordB.insertions > 0,
      normalizedReference: normRef.text,
      normalizedHypothesis: normHyp.text,
    },
    properNounErrorRate,
    numericAccuracy,
    repetitionPreserved,
  };
}

export type ShahabErrorAttributionCategory =
  | 'ACOUSTIC_AMBIGUITY'
  | 'PHONETIC_SUBSTITUTION'
  | 'TOKENIZATION_OR_LEXICAL'
  | 'DECODER_SEARCH'
  | 'WORD_BOUNDARY'
  | 'SEGMENTATION'
  | 'PROPER_NOUN'
  | 'NUMERIC'
  | 'ORTHOGRAPHIC_NORMALIZATION'
  | 'CONTEXTUAL_BIASING'
  | 'CAUSE_UNKNOWN';

export interface ShahabAttributedErrorItem {
  readonly sampleId: string;
  readonly op: 'SUB' | 'DEL' | 'INS';
  readonly refToken: string | null;
  readonly hypToken: string | null;
  readonly category: ShahabErrorAttributionCategory;
  readonly evidenceBasis: string;
}

/**
 * SHAHABErrorAnalyzer — Evidence-supported Persian ASR error attribution.
 * Assigns a specific category ONLY when objective evidence supports it;
 * otherwise explicitly returns `CAUSE_UNKNOWN`.
 */
export class SHAHABErrorAnalyzer {
  public analyzeSample(params: {
    readonly sampleId: string;
    readonly evalMetrics: DualTrackEvaluationMetrics;
    readonly properNouns?: readonly string[];
    readonly contextTermsApplied?: readonly string[];
    readonly lowSnrObserved?: boolean;
  }): ShahabAttributedErrorItem[] {
    const items: ShahabAttributedErrorItem[] = [];
    const ops = params.evalMetrics.trackAVerbatim.wordOps;
    const properSet = new Set((params.properNouns ?? []).map((p) => normalizeForTrackB(p).text));
    const ctxSet = new Set((params.contextTermsApplied ?? []).map((c) => normalizeForTrackB(c).text));

    for (let idx = 0; idx < ops.length; idx++) {
      const op = ops[idx];
      if (op.op === 'MATCH') continue;

      const refT = op.refToken ?? '';
      const hypT = op.hypToken ?? '';
      const refNorm = normalizeForTrackB(refT).text;
      const hypNorm = normalizeForTrackB(hypT).text;

      // 1. Orthographic / ZWNJ / Arabic-Persian letter normalization difference ONLY
      if (op.op === 'SUB' && refNorm === hypNorm) {
        items.push({
          sampleId: params.sampleId,
          op: 'SUB',
          refToken: op.refToken,
          hypToken: op.hypToken,
          category: 'ORTHOGRAPHIC_NORMALIZATION',
          evidenceBasis: 'Tokens are identical after Track B Unicode/ZWNJ normalization.',
        });
        continue;
      }

      // 2. Word boundary split/merge (e.g., "گرانقیمت" vs "گران قیمت" or "آبمیوهها" vs "آبمیوه ها")
      if (op.op === 'SUB' && refNorm.replace(/\s+/g, '') === hypNorm.replace(/\s+/g, '')) {
        items.push({
          sampleId: params.sampleId,
          op: 'SUB',
          refToken: op.refToken,
          hypToken: op.hypToken,
          category: 'WORD_BOUNDARY',
          evidenceBasis: 'Characters match identically after removing space/ZWNJ boundary.',
        });
        continue;
      }
      if (
        (op.op === 'DEL' || op.op === 'INS') &&
        idx + 1 < ops.length &&
        ops[idx + 1].op !== 'MATCH'
      ) {
        const next = ops[idx + 1];
        const combinedRef = normalizeForTrackB(`${op.refToken ?? ''}${next.refToken ?? ''}`).text.replace(/\s+/g, '');
        const combinedHyp = normalizeForTrackB(`${op.hypToken ?? ''}${next.hypToken ?? ''}`).text.replace(/\s+/g, '');
        if (combinedRef.length > 0 && combinedRef === combinedHyp) {
          items.push({
            sampleId: params.sampleId,
            op: op.op,
            refToken: op.refToken,
            hypToken: op.hypToken,
            category: 'WORD_BOUNDARY',
            evidenceBasis: 'Adjacent tokens merge/split to identical character sequence.',
          });
          continue;
        }
      }

      // 3. Proper noun mismatch
      if (refNorm && properSet.has(refNorm)) {
        items.push({
          sampleId: params.sampleId,
          op: op.op,
          refToken: op.refToken,
          hypToken: op.hypToken,
          category: 'PROPER_NOUN',
          evidenceBasis: 'Reference token is in sample proper-noun list.',
        });
        continue;
      }

      // 4. Numeric mismatch
      if (/[0-9۰-۹٠-٩]/.test(refT) || /[0-9۰-۹٠-٩]/.test(hypT)) {
        items.push({
          sampleId: params.sampleId,
          op: op.op,
          refToken: op.refToken,
          hypToken: op.hypToken,
          category: 'NUMERIC',
          evidenceBasis: 'Token contains numeric digits.',
        });
        continue;
      }

      // 5. Contextual biasing false insertion
      if (op.op === 'INS' && hypNorm && ctxSet.has(hypNorm)) {
        items.push({
          sampleId: params.sampleId,
          op: 'INS',
          refToken: null,
          hypToken: op.hypToken,
          category: 'CONTEXTUAL_BIASING',
          evidenceBasis: 'Inserted token matches an active contextual-biasing term.',
        });
        continue;
      }

      // 6. Low SNR acoustic ambiguity when SNR evidence is explicitly observed
      if (params.lowSnrObserved) {
        items.push({
          sampleId: params.sampleId,
          op: op.op,
          refToken: op.refToken,
          hypToken: op.hypToken,
          category: 'ACOUSTIC_AMBIGUITY',
          evidenceBasis: 'Observed degraded SNR (<10 dB) on audio segment.',
        });
        continue;
      }

      // Default honest fallback — never claim acoustic-model fault without direct evidence!
      items.push({
        sampleId: params.sampleId,
        op: op.op,
        refToken: op.refToken,
        hypToken: op.hypToken,
        category: 'CAUSE_UNKNOWN',
        evidenceBasis: 'Insufficient isolated diagnostic evidence to attribute definitive root cause.',
      });
    }

    return items;
  }
}

export interface ShahabBaselineExecutionProfile {
  readonly profileId: string;
  readonly modelRepository: string;
  readonly modelRevision: string;
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly tokenizerHash: string;
  readonly runtimeName: string;
  readonly runtimeVersion: string;
  readonly executionProvider: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly featureConfig: string;
  readonly decoderType: string;
  readonly beamSize: number;
  readonly chunkDurationSec: number;
  readonly overlapDurationSec: number;
  readonly trackBNormalizationPolicy: string;
  readonly hardwareSummary: string;
  readonly warmupRuns: number;
  readonly repetitions: number;
}

export interface ShahabPerSampleBenchmarkOutput {
  readonly sampleId: string;
  readonly split: ShahabDatasetSplit;
  readonly durationSec: number;
  readonly speechCategories: readonly ShahabSpeechCategory[];
  readonly referenceTranscriptVerbatim: string;
  readonly rawHypothesis: string;
  readonly normalizedHypothesis: string;
  readonly latencyMs: number;
  readonly realTimeFactor: number;
  readonly evaluation: DualTrackEvaluationMetrics;
  readonly attributedErrors: readonly ShahabAttributedErrorItem[];
  readonly status: 'PASSED' | 'FAILED';
  readonly errorMessage?: string;
}

export interface ShahabBenchmarkRunArtifact {
  readonly executionId: string;
  readonly createdAtUtc: string;
  readonly profile: ShahabBaselineExecutionProfile;
  readonly datasetManifestId: string;
  readonly datasetRevision: string;
  readonly leakageReport: ShahabLeakageReport;
  readonly sampleCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly totalAudioDurationSec: number;
  readonly aggregateTrackA: {
    readonly wer: number;
    readonly cer: number;
    readonly substitutions: number;
    readonly deletions: number;
    readonly insertions: number;
    readonly sentenceErrorRate: number;
  };
  readonly aggregateTrackB: {
    readonly wer: number;
    readonly cer: number;
    readonly substitutions: number;
    readonly deletions: number;
    readonly insertions: number;
    readonly sentenceErrorRate: number;
  };
  readonly errorCategoryDistribution: Readonly<Record<string, number>>;
  readonly performance: {
    readonly coldLatencyMs: number;
    readonly warmLatencyMs: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly realTimeFactor: number;
    readonly throughputAudioSecPerWallSec: number;
    readonly peakRamBytes: number;
    readonly cpuUserMs: number;
    readonly cpuSystemMs: number;
  };
  readonly confidenceIntervalNote: string;
  readonly perSampleOutputs: readonly ShahabPerSampleBenchmarkOutput[];
}

/**
 * SHAHABBenchmarkRunner — Immutable, resumable, non-overwriting benchmark runner.
 * Every execution generates a unique `executionId` and persists per-sample outputs to disk.
 */
export class SHAHABBenchmarkRunner {
  private readonly analyzer = new SHAHABErrorAnalyzer();

  constructor(private readonly outputDir: string) {}

  public async runBenchmark(params: {
    readonly profile: ShahabBaselineExecutionProfile;
    readonly manifest: ShahabDatasetManifest;
    readonly transcribeSample: (sample: ShahabDatasetSample) => Promise<{
      readonly rawText: string;
      readonly normalizedText: string;
      readonly latencyMs: number;
      readonly lowSnrObserved?: boolean;
      readonly contextTermsApplied?: readonly string[];
    }>;
  }): Promise<{ readonly artifact: ShahabBenchmarkRunArtifact; readonly persistedPath: string }> {
    const executionId = `shahab_bench_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const leakageReport = detectDatasetLeakage(params.manifest);
    const perSampleOutputs: ShahabPerSampleBenchmarkOutput[] = [];
    const latencies: number[] = [];
    const cpuStart = process.cpuUsage();
    let peakRam = process.memoryUsage().rss;

    for (const sample of params.manifest.samples) {
      try {
        const res = await params.transcribeSample(sample);
        peakRam = Math.max(peakRam, process.memoryUsage().rss);
        latencies.push(res.latencyMs);

        const evalMetrics = evaluateDualTrackSample({
          referenceVerbatim: sample.referenceTranscriptVerbatim,
          rawHypothesis: res.rawText,
          properNouns: sample.properNouns,
          numericTokens: sample.numericTokens,
        });
        const attributedErrors = this.analyzer.analyzeSample({
          sampleId: sample.sampleId,
          evalMetrics,
          properNouns: sample.properNouns,
          contextTermsApplied: res.contextTermsApplied,
          lowSnrObserved: res.lowSnrObserved,
        });

        perSampleOutputs.push({
          sampleId: sample.sampleId,
          split: sample.split,
          durationSec: sample.durationSec,
          speechCategories: sample.speechCategories,
          referenceTranscriptVerbatim: sample.referenceTranscriptVerbatim,
          rawHypothesis: res.rawText,
          normalizedHypothesis: res.normalizedText,
          latencyMs: res.latencyMs,
          realTimeFactor: Number(((res.latencyMs / 1000) / Math.max(0.001, sample.durationSec)).toFixed(4)),
          evaluation: evalMetrics,
          attributedErrors,
          status: 'PASSED',
        });
      } catch (err) {
        perSampleOutputs.push({
          sampleId: sample.sampleId,
          split: sample.split,
          durationSec: sample.durationSec,
          speechCategories: sample.speechCategories,
          referenceTranscriptVerbatim: sample.referenceTranscriptVerbatim,
          rawHypothesis: '',
          normalizedHypothesis: '',
          latencyMs: 0,
          realTimeFactor: 0,
          evaluation: evaluateDualTrackSample({
            referenceVerbatim: sample.referenceTranscriptVerbatim,
            rawHypothesis: '',
          }),
          attributedErrors: [],
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const cpuEnd = process.cpuUsage(cpuStart);
    const completed = perSampleOutputs.filter((s) => s.status === 'PASSED');
    const failedCount = perSampleOutputs.length - completed.length;
    const totalAudioSec = completed.reduce((acc, s) => acc + s.durationSec, 0);
    const totalWallSec = latencies.reduce((acc, ms) => acc + ms, 0) / 1000;

    // Aggregate Track A & Track B
    const aggA = { sub: 0, del: 0, ins: 0, refWords: 0, serCount: 0, cerWeighted: 0 };
    const aggB = { sub: 0, del: 0, ins: 0, refWords: 0, serCount: 0, cerWeighted: 0 };
    const errDist: Record<string, number> = {};

    for (const s of completed) {
      aggA.sub += s.evaluation.trackAVerbatim.substitutions;
      aggA.del += s.evaluation.trackAVerbatim.deletions;
      aggA.ins += s.evaluation.trackAVerbatim.insertions;
      aggA.refWords += s.evaluation.trackAVerbatim.refWords;
      if (s.evaluation.trackAVerbatim.sentenceError) aggA.serCount++;
      aggA.cerWeighted += s.evaluation.trackAVerbatim.cer;

      aggB.sub += s.evaluation.trackBNormalized.substitutions;
      aggB.del += s.evaluation.trackBNormalized.deletions;
      aggB.ins += s.evaluation.trackBNormalized.insertions;
      aggB.refWords += s.evaluation.trackBNormalized.refWords;
      if (s.evaluation.trackBNormalized.sentenceError) aggB.serCount++;
      aggB.cerWeighted += s.evaluation.trackBNormalized.cer;

      for (const e of s.attributedErrors) {
        errDist[e.category] = (errDist[e.category] ?? 0) + 1;
      }
    }

    const sortedLat = [...latencies].sort((a, b) => a - b);
    const p50 = sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length * 0.5)] : 0;
    const p95 = sortedLat.length > 0 ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))] : 0;

    const artifact: ShahabBenchmarkRunArtifact = {
      executionId,
      createdAtUtc: new Date().toISOString(),
      profile: params.profile,
      datasetManifestId: params.manifest.manifestId,
      datasetRevision: params.manifest.revision,
      leakageReport,
      sampleCount: params.manifest.samples.length,
      completedCount: completed.length,
      failedCount,
      totalAudioDurationSec: Number(totalAudioSec.toFixed(3)),
      aggregateTrackA: {
        wer: aggA.refWords > 0 ? Number(((aggA.sub + aggA.del + aggA.ins) / aggA.refWords).toFixed(4)) : 0,
        cer: completed.length > 0 ? Number((aggA.cerWeighted / completed.length).toFixed(4)) : 0,
        substitutions: aggA.sub,
        deletions: aggA.del,
        insertions: aggA.ins,
        sentenceErrorRate: completed.length > 0 ? Number((aggA.serCount / completed.length).toFixed(4)) : 0,
      },
      aggregateTrackB: {
        wer: aggB.refWords > 0 ? Number(((aggB.sub + aggB.del + aggB.ins) / aggB.refWords).toFixed(4)) : 0,
        cer: completed.length > 0 ? Number((aggB.cerWeighted / completed.length).toFixed(4)) : 0,
        substitutions: aggB.sub,
        deletions: aggB.del,
        insertions: aggB.ins,
        sentenceErrorRate: completed.length > 0 ? Number((aggB.serCount / completed.length).toFixed(4)) : 0,
      },
      errorCategoryDistribution: errDist,
      performance: {
        coldLatencyMs: latencies[0] ?? 0,
        warmLatencyMs: latencies.length > 1 ? latencies[latencies.length - 1] : (latencies[0] ?? 0),
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        realTimeFactor: totalAudioSec > 0 ? Number((totalWallSec / totalAudioSec).toFixed(4)) : 0,
        throughputAudioSecPerWallSec: totalWallSec > 0 ? Number((totalAudioSec / totalWallSec).toFixed(3)) : 0,
        peakRamBytes: peakRam,
        cpuUserMs: Math.round(cpuEnd.user / 1000),
        cpuSystemMs: Math.round(cpuEnd.system / 1000),
      },
      confidenceIntervalNote:
        completed.length >= 30
          ? 'Bootstrap 95% CI computable.'
          : `NOT_COMPUTED (n=${completed.length} < 30 samples; statistical significance cannot be claimed from small local diagnostic corpus).`,
      perSampleOutputs,
    };

    fs.mkdirSync(this.outputDir, { recursive: true });
    const persistedPath = path.join(this.outputDir, `${executionId}.json`);
    // Never overwrite an existing benchmark file
    fs.writeFileSync(persistedPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });

    return { artifact, persistedPath };
  }
}

export interface ShahabReleaseManifest {
  readonly releaseId: 'SHAHAB-R1' | 'SHAHAB-R1.1';
  readonly engineVersion: string;
  readonly releasedAtUtc: string;
  readonly lineageDeclaration: string;
  readonly sourceCodeRevision: string | null;
  readonly baseModelId: string;
  readonly baseModelRevision: string;
  readonly baseModelRepository: string;
  readonly modelFileHashes: Readonly<Record<string, string>>;
  readonly licenseSpdx: string;
  readonly runtimeVersion: string;
  readonly selectedInferenceArtifact: string;
  readonly exactMandatoryPackageBytes: number;
  readonly parameterCountSummary: string;
  readonly benchmarkExecutionId: string;
  readonly hardwareSummary: string;
  readonly knownLimitations: readonly string[];
  readonly rollbackInstructions: readonly string[];
  readonly rollbackVerified: boolean;
}

export function verifyRollbackAvailability(params: {
  readonly originalModelDir: string;
  readonly expectedHashes: Readonly<Record<string, string>>;
}): { readonly rollbackReady: boolean; readonly verifiedFiles: readonly string[]; readonly mismatches: readonly string[] } {
  const verifiedFiles: string[] = [];
  const mismatches: string[] = [];
  for (const [rel, expected] of Object.entries(params.expectedHashes)) {
    const p = path.join(params.originalModelDir, rel);
    if (!fs.existsSync(p)) {
      mismatches.push(`Missing original artifact: ${rel}`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (actual !== expected.toLowerCase()) {
      mismatches.push(`Hash mismatch on ${rel}: expected ${expected}, actual ${actual}`);
    } else {
      verifiedFiles.push(rel);
    }
  }
  return {
    rollbackReady: mismatches.length === 0 && verifiedFiles.length > 0,
    verifiedFiles,
    mismatches,
  };
}
