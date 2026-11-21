/**
 * AVP-P0-009 — Persian ASR Linguistic Fidelity, Text Normalization & Transcript Quality Engine
 *
 * Strictly preserves spoken Persian fidelity while enforcing:
 * 1. Canonical 5-layer representation:
 *    - Raw ASR Output (immutable recognized tokens & timestamps)
 *    - Normalized Text (deterministic, versioned Unicode/ZWNJ/script-aware)
 *    - Display-Ready Text (configurable digits/punctuation without mutating raw)
 *    - User-Corrected Text (explicit human edits preserving raw trace)
 *    - Machine-Generated Linguistic Suggestions (never auto-applied to raw)
 * 2. Spoken vs Written Persian distinction (`VERBATIM | LIGHT_NORMALIZED | EDITORIAL_SUGGESTED`).
 * 3. Script-aware mixed Persian-English preservation (Latin words/acronyms/numbers intact).
 * 4. Alignment tracking for 1:1, 1:N, N:1, punctuation, and ZWNJ transforms (never fabricates timestamps).
 * 5. Reproducible versioned Persian WER/CER/number/entity/code-switching evaluation framework.
 */

import { detectTextLanguageTag, normalizeWithProfile, standardizePersianCharacters } from './CoreNormalizationAndLanguage';

export const PERSIAN_LINGUISTIC_POLICY_VERSION = 'FA-LINGUISTIC-V2.0.0' as const;

export type PersianTranscriptionMode =
  | 'VERBATIM'
  | 'LIGHT_NORMALIZED'
  | 'EDITORIAL_SUGGESTED';

export type DigitFormattingPolicy = 'PRESERVE' | 'PERSIAN_DIGITS' | 'LATIN_DIGITS';

export type AlignmentFidelityStatus =
  | 'EXACT_WORD_ALIGNED'
  | 'APPROXIMATE_DERIVED'
  | 'SEGMENT_ONLY'
  | 'UNAVAILABLE';

export interface RawRecognizedToken {
  readonly tokenId: string;
  readonly text: string;
  readonly startSec: number | null;
  readonly endSec: number | null;
  /** Undefined when ASR engine does not expose token confidence — NEVER fabricated */
  readonly providerConfidence?: number;
  readonly confidenceSource?: 'PROVIDER_LOGPROB' | 'PROVIDER_POSTERIOR' | 'UNAVAILABLE';
  readonly alternatives?: readonly string[];
}

export interface AlignedNormalizedToken {
  readonly normalizedTokenId: string;
  readonly sourceTokenIds: readonly string[];
  readonly mappingKind: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE' | 'INSERTED_PUNCTUATION';
  readonly rawText: string;
  readonly normalizedText: string;
  readonly displayText: string;
  readonly scriptClass: 'PERSIAN' | 'LATIN' | 'NUMERIC' | 'MIXED' | 'PUNCTUATION';
  readonly startSec: number | null;
  readonly endSec: number | null;
  readonly alignmentStatus: AlignmentFidelityStatus;
  readonly providerConfidence?: number;
  readonly isColloquialSpokenForm: boolean;
  readonly isDisfluencyOrFiller: boolean;
}

export interface PunctuationAnnotation {
  readonly afterTokenIndex: number;
  readonly symbol: '،' | '.' | '؟' | ':' | '؛';
  readonly evidenceType: 'ACOUSTIC_PAUSE_EVIDENCE' | 'LINGUISTIC_INFERENCE';
  readonly pauseDurationSec?: number;
  /** Explicitly undefined when no calibrated statistical punctuation model exists */
  readonly confidence?: undefined;
  readonly rationale: string;
}

export interface MachineLinguisticSuggestion {
  readonly suggestionId: string;
  readonly sourceTokenIds: readonly string[];
  readonly originalText: string;
  readonly suggestedText: string;
  readonly category: 'EDITORIAL_FORMALIZATION' | 'ORTHOGRAPHY' | 'PUNCTUATION' | 'NUMBER_FORMAT';
  readonly autoApplicable: false;
  readonly rationale: string;
}

export interface CanonicalPersianTranscriptSegment {
  readonly segmentId: string;
  readonly policyVersion: typeof PERSIAN_LINGUISTIC_POLICY_VERSION;
  readonly mode: PersianTranscriptionMode;
  readonly rawTokens: readonly RawRecognizedToken[];
  readonly alignedTokens: readonly AlignedNormalizedToken[];
  readonly rawText: string;
  readonly normalizedText: string;
  readonly displayText: string;
  readonly userCorrectedText: string | null;
  readonly punctuationAnnotations: readonly PunctuationAnnotation[];
  readonly machineSuggestions: readonly MachineLinguisticSuggestion[];
  readonly dominantLanguage: 'fa' | 'en' | 'fa-en' | 'unknown' | 'uncertain';
  readonly startSec: number | null;
  readonly endSec: number | null;
  readonly alignmentStatus: AlignmentFidelityStatus;
}

const ZWNJ = '\u200c';
const TATWEEL_RE = /\u0640+/g;
const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const INVISIBLE_CONTROL_RE = /[\u200B\u200D\u200E\u200F\u202A-\u202E\uFEFF]/g;
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

const PERSIAN_SCRIPT_RE = /[\u0600-\u06FF]/;
const LATIN_SCRIPT_RE = /[A-Za-z]/;
const NUMERIC_TOKEN_RE = /^[+\-−]?[\d۰-۹٠-٩]+([.,٫/:%-][\d۰-۹٠-٩]+)*[%٪]?$/;

/** Safe lexical dictionary of fused Persian forms that unambiguously need ZWNJ (never breaks valid words like میوه/کتابخانه) */
const UNAMBIGUOUS_ZWNJ_LEXICON: Readonly<Record<string, string>> = {
  'میروم': `می${ZWNJ}روم`,
  'میرود': `می${ZWNJ}رود`,
  'میشود': `می${ZWNJ}شود`,
  'میکنم': `می${ZWNJ}کنم`,
  'میکند': `می${ZWNJ}کند`,
  'میکرد': `می${ZWNJ}کرد`,
  'میخواهم': `می${ZWNJ}خواهم`,
  'میگویم': `می${ZWNJ}گویم`,
  'نمیشود': `نمی${ZWNJ}شود`,
  'نمیروم': `نمی${ZWNJ}روم`,
  'نمیکنم': `نمی${ZWNJ}کنم`,
  'نمیکند': `نمی${ZWNJ}کند`,
  'نمیخواهم': `نمی${ZWNJ}خواهم`,
  'نمیگویم': `نمی${ZWNJ}گویم`,
  'کتابها': `کتاب${ZWNJ}ها`,
  'کتابهای': `کتاب${ZWNJ}های`,
  'خانهها': `خانه${ZWNJ}ها`,
  'خانهام': `خانه${ZWNJ}ام`,
  'برنامهها': `برنامه${ZWNJ}ها`,
  'برنامهام': `برنامه${ZWNJ}ام`,
  'بچهها': `بچه${ZWNJ}ها`,
  'هیچکدام': `هیچ${ZWNJ}کدام`,
};

/** Spoken colloquial Persian forms that MUST be preserved verbatim (NEVER auto-rewritten to formal prose) */
const COLLOQUIAL_SPOKEN_FORMS: Readonly<Record<string, string>> = {
  'میخوام': 'می‌خواهم',
  'می‌خوام': 'می‌خواهم',
  'نمیشه': 'نمی‌شود',
  'نمی‌شه': 'نمی‌شود',
  'میشه': 'می‌شود',
  'می‌شه': 'می‌شود',
  'خونه': 'خانه',
  'بگم': 'بگویم',
  'برم': 'بروم',
  'دارم میرم': 'دارم می‌روم',
  'چطوری': 'چطور هستی',
  'اینجوری': 'این‌گونه',
  'واسه': 'برای',
  'آره': 'بله',
  'نه': 'خیر',
};

const PERSIAN_DISFLUENCY_FILLERS = new Set(['ام', 'امم', 'اِ', 'اِه', 'آ', 'آه', 'خب', 'یعنی']);
const PERSIAN_QUESTION_STARTERS = new Set(['آیا', 'چرا', 'چطور', 'چگونه', 'کجا', 'کی', 'چند', 'کدام', 'چی', 'مگه', 'مگر']);

export function normalizeUnicodeScriptAware(raw: string, options?: {
  readonly stripDiacritics?: boolean;
  readonly preserveZwnj?: boolean;
}): string {
  if (!raw) return '';
  // NFKC converts Arabic presentation forms (e.g., ﮎ, ﯼ, ﻻ) into canonical forms without harming ASCII Latin
  const nfkc = raw.normalize('NFKC');
  const tokens = nfkc.split(/(\s+)/);
  return tokens
    .map((part) => {
      if (/^\s+$/.test(part)) return ' ';
      const hasLatin = LATIN_SCRIPT_RE.test(part);
      const hasPersian = PERSIAN_SCRIPT_RE.test(part);
      // Pure Latin technical tokens (e.g., ONNX, TensorRT, WebGPU, UTF-8) are NEVER mutated by Persian rules
      if (hasLatin && !hasPersian) {
        return part.replace(INVISIBLE_CONTROL_RE, '');
      }
      let out = part
        .replace(INVISIBLE_CONTROL_RE, '')
        .replace(TATWEEL_RE, '')
        .replace(/\u064A/g, '\u06CC') // ي -> ی
        .replace(/\u0649/g, '\u06CC') // ى -> ی
        .replace(/\u0643/g, '\u06A9') // ك -> ک
        .replace(/\u0629/g, '\u0647') // ة -> ه
        .replace(/\u06C0/g, `\u0647${ZWNJ}\u06CC`);
      if (options?.stripDiacritics ?? true) {
        out = out.replace(ARABIC_DIACRITICS_RE, '');
      }
      // Collapse duplicate ZWNJ and strip leading/trailing ZWNJ
      out = out.replace(/\u200c{2,}/g, ZWNJ).replace(/^\u200c+|\u200c+$/g, '');
      if (options?.preserveZwnj === false) {
        out = out.replace(/\u200c/g, ' ');
      }
      return out;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function applySafePersianZwnjToken(token: string): string {
  // Never alter Latin or numeric tokens
  if (LATIN_SCRIPT_RE.test(token) && !PERSIAN_SCRIPT_RE.test(token)) return token;
  if (NUMERIC_TOKEN_RE.test(token)) return token;

  // Explicit verified lexicon for fused spellings (avoids corrupting valid stems like میوه / کتابخانه)
  if (Object.prototype.hasOwnProperty.call(UNAMBIGUOUS_ZWNJ_LEXICON, token)) {
    return UNAMBIGUOUS_ZWNJ_LEXICON[token];
  }
  return token;
}

export function formatDigitsByPolicy(text: string, policy: DigitFormattingPolicy): string {
  if (policy === 'PRESERVE') return text;
  // Script-aware: do NOT convert digits embedded inside Latin technical tokens like "UTF-8", "v2.0", "GPT4"
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return part;
      if (LATIN_SCRIPT_RE.test(part)) {
        // Keep Latin-embedded numbers intact
        return part;
      }
      if (policy === 'LATIN_DIGITS') {
        return part
          .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
          .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
      }
      // PERSIAN_DIGITS
      return part
        .replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)])
        .replace(/[\u0660-\u0669]/g, (d) => PERSIAN_DIGITS[d.charCodeAt(0) - 0x0660]);
    })
    .join('');
}

export function classifyTokenScript(token: string): AlignedNormalizedToken['scriptClass'] {
  if (/^[،؛؟!.,:;()«»"'-]+$/.test(token)) return 'PUNCTUATION';
  if (NUMERIC_TOKEN_RE.test(token)) return 'NUMERIC';
  const hasFa = PERSIAN_SCRIPT_RE.test(token);
  const hasEn = LATIN_SCRIPT_RE.test(token);
  if (hasFa && hasEn) return 'MIXED';
  if (hasEn) return 'LATIN';
  return 'PERSIAN';
}

/**
 * Builds a complete canonical 5-layer Persian transcript segment from raw ASR tokens.
 * - Preserves raw spoken tokens immutably.
 * - Merges detached ZWNJ prefixes/suffixes (e.g., ["می", "روم"] -> "می‌روم") as MANY_TO_ONE while
 *   explicitly tracking combined sourceTokenIds & time span.
 * - Never silently rewrites colloquial Persian into formal prose (records separate editorial suggestions instead).
 * - Never fabricates missing timestamps or missing confidence scores.
 */
export function buildCanonicalPersianTranscriptSegment(params: {
  readonly segmentId: string;
  readonly rawTokens: readonly RawRecognizedToken[];
  readonly mode?: PersianTranscriptionMode;
  readonly digitPolicy?: DigitFormattingPolicy;
  readonly enableNonDestructivePunctuation?: boolean;
  readonly userCorrectedText?: string | null;
}): CanonicalPersianTranscriptSegment {
  const mode = params.mode ?? 'LIGHT_NORMALIZED';
  const digitPolicy = params.digitPolicy ?? 'PRESERVE';
  const rawTokens = params.rawTokens;

  const rawText = rawTokens.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
  const alignedTokens: AlignedNormalizedToken[] = [];
  const machineSuggestions: MachineLinguisticSuggestion[] = [];

  const DETACHED_PREFIXES = new Set(['می', 'نمی']);
  const DETACHED_SUFFIXES = new Set(['ها', 'های', 'هایی', 'ام', 'ات', 'اش', 'ایم', 'اید', 'اند', 'تر', 'ترین']);

  let i = 0;
  let outCounter = 0;

  while (i < rawTokens.length) {
    const cur = rawTokens[i];
    const curNormBase = normalizeUnicodeScriptAware(cur.text);

    // Check MANY_TO_ONE detached Persian prefix ("می" + "روم" -> "می‌روم") in LIGHT_NORMALIZED / EDITORIAL_SUGGESTED
    const next = i + 1 < rawTokens.length ? rawTokens[i + 1] : null;
    const nextNormBase = next ? normalizeUnicodeScriptAware(next.text) : '';
    const canJoinPrefix =
      mode !== 'VERBATIM' &&
      next !== null &&
      DETACHED_PREFIXES.has(curNormBase) &&
      PERSIAN_SCRIPT_RE.test(nextNormBase) &&
      !LATIN_SCRIPT_RE.test(nextNormBase) &&
      nextNormBase.length >= 2;

    if (canJoinPrefix && next) {
      const joinedNorm = `${curNormBase}${ZWNJ}${nextNormBase}`;
      const display = formatDigitsByPolicy(joinedNorm, digitPolicy);
      const startSec = cur.startSec;
      const endSec = next.endSec ?? cur.endSec;
      const alignmentStatus: AlignmentFidelityStatus =
        startSec !== null && endSec !== null ? 'APPROXIMATE_DERIVED' : 'UNAVAILABLE';
      const combinedConf =
        typeof cur.providerConfidence === 'number' && typeof next.providerConfidence === 'number'
          ? Number(Math.min(cur.providerConfidence, next.providerConfidence).toFixed(4))
          : undefined;

      alignedTokens.push({
        normalizedTokenId: `${params.segmentId}_ntok_${++outCounter}`,
        sourceTokenIds: [cur.tokenId, next.tokenId],
        mappingKind: 'MANY_TO_ONE',
        rawText: `${cur.text} ${next.text}`,
        normalizedText: joinedNorm,
        displayText: display,
        scriptClass: 'PERSIAN',
        startSec,
        endSec,
        alignmentStatus,
        providerConfidence: combinedConf,
        isColloquialSpokenForm: Object.prototype.hasOwnProperty.call(COLLOQUIAL_SPOKEN_FORMS, joinedNorm),
        isDisfluencyOrFiller: false,
      });
      i += 2;
      continue;
    }

    // Check MANY_TO_ONE detached Persian suffix ("کتاب" + "ها" -> "کتاب‌ها")
    const canJoinSuffix =
      mode !== 'VERBATIM' &&
      next !== null &&
      PERSIAN_SCRIPT_RE.test(curNormBase) &&
      !LATIN_SCRIPT_RE.test(curNormBase) &&
      curNormBase.length >= 2 &&
      DETACHED_SUFFIXES.has(nextNormBase);

    if (canJoinSuffix && next) {
      const joinedNorm = `${curNormBase}${ZWNJ}${nextNormBase}`;
      const display = formatDigitsByPolicy(joinedNorm, digitPolicy);
      const startSec = cur.startSec;
      const endSec = next.endSec ?? cur.endSec;
      const alignmentStatus: AlignmentFidelityStatus =
        startSec !== null && endSec !== null ? 'APPROXIMATE_DERIVED' : 'UNAVAILABLE';
      const combinedConf =
        typeof cur.providerConfidence === 'number' && typeof next.providerConfidence === 'number'
          ? Number(Math.min(cur.providerConfidence, next.providerConfidence).toFixed(4))
          : undefined;

      alignedTokens.push({
        normalizedTokenId: `${params.segmentId}_ntok_${++outCounter}`,
        sourceTokenIds: [cur.tokenId, next.tokenId],
        mappingKind: 'MANY_TO_ONE',
        rawText: `${cur.text} ${next.text}`,
        normalizedText: joinedNorm,
        displayText: display,
        scriptClass: 'PERSIAN',
        startSec,
        endSec,
        alignmentStatus,
        providerConfidence: combinedConf,
        isColloquialSpokenForm: false,
        isDisfluencyOrFiller: false,
      });
      i += 2;
      continue;
    }

    // Standard 1:1 token normalization (VERBATIM only standardizes Unicode without ZWNJ rewriting)
    const norm = mode === 'VERBATIM' ? curNormBase : applySafePersianZwnjToken(curNormBase);
    const display = formatDigitsByPolicy(norm, digitPolicy);
    const isColloquial = Object.prototype.hasOwnProperty.call(COLLOQUIAL_SPOKEN_FORMS, norm);
    const isDisfluency = PERSIAN_DISFLUENCY_FILLERS.has(norm);

    if (mode === 'EDITORIAL_SUGGESTED' && isColloquial) {
      machineSuggestions.push({
        suggestionId: `${params.segmentId}_sug_${machineSuggestions.length + 1}`,
        sourceTokenIds: [cur.tokenId],
        originalText: norm,
        suggestedText: COLLOQUIAL_SPOKEN_FORMS[norm],
        category: 'EDITORIAL_FORMALIZATION',
        autoApplicable: false,
        rationale: 'Spoken colloquial form detected; preserved verbatim in transcript and offered as optional editorial suggestion only.',
      });
    }

    alignedTokens.push({
      normalizedTokenId: `${params.segmentId}_ntok_${++outCounter}`,
      sourceTokenIds: [cur.tokenId],
      mappingKind: 'ONE_TO_ONE',
      rawText: cur.text,
      normalizedText: norm,
      displayText: display,
      scriptClass: classifyTokenScript(norm),
      startSec: cur.startSec,
      endSec: cur.endSec,
      alignmentStatus:
        cur.startSec !== null && cur.endSec !== null ? 'EXACT_WORD_ALIGNED' : 'UNAVAILABLE',
      providerConfidence: cur.providerConfidence,
      isColloquialSpokenForm: isColloquial,
      isDisfluencyOrFiller: isDisfluency,
    });
    i += 1;
  }

  // Non-destructive punctuation restoration (separates acoustic pause evidence from linguistic inference)
  const punctuationAnnotations: PunctuationAnnotation[] = [];
  if ((params.enableNonDestructivePunctuation ?? true) && mode !== 'VERBATIM' && alignedTokens.length > 0) {
    for (let idx = 0; idx < alignedTokens.length - 1; idx++) {
      const a = alignedTokens[idx];
      const b = alignedTokens[idx + 1];
      if (a.endSec !== null && b.startSec !== null) {
        const gapSec = b.startSec - a.endSec;
        if (gapSec >= 0.85) {
          punctuationAnnotations.push({
            afterTokenIndex: idx,
            symbol: '.',
            evidenceType: 'ACOUSTIC_PAUSE_EVIDENCE',
            pauseDurationSec: Number(gapSec.toFixed(3)),
            rationale: `Acoustic pause of ${gapSec.toFixed(2)}s observed between aligned tokens.`,
          });
        } else if (gapSec >= 0.42) {
          punctuationAnnotations.push({
            afterTokenIndex: idx,
            symbol: '،',
            evidenceType: 'ACOUSTIC_PAUSE_EVIDENCE',
            pauseDurationSec: Number(gapSec.toFixed(3)),
            rationale: `Medium acoustic pause of ${gapSec.toFixed(2)}s observed between aligned tokens.`,
          });
        }
      }
    }

    // Sentence-final punctuation based on explicit Persian interrogative starters (clearly tagged as LINGUISTIC_INFERENCE)
    const firstWord = alignedTokens[0]?.normalizedText ?? '';
    const lastWord = alignedTokens[alignedTokens.length - 1]?.normalizedText ?? '';
    if (!/[.!؟،؛:]$/.test(lastWord)) {
      if (PERSIAN_QUESTION_STARTERS.has(firstWord)) {
        punctuationAnnotations.push({
          afterTokenIndex: alignedTokens.length - 1,
          symbol: '؟',
          evidenceType: 'LINGUISTIC_INFERENCE',
          rationale: `Interrogative starter "${firstWord}" suggests question boundary (linguistic inference, not acoustic fact).`,
        });
      }
    }
  }

  const normalizedText = alignedTokens.map((t) => t.normalizedText).filter(Boolean).join(' ').trim();

  // Build displayText with punctuation annotations without mutating normalizedTokens
  const punctByIdx = new Map<number, string>();
  for (const p of punctuationAnnotations) {
    punctByIdx.set(p.afterTokenIndex, p.symbol);
  }
  const displayParts = alignedTokens.map((t, idx) => {
    const sym = punctByIdx.get(idx);
    return sym ? `${t.displayText}${sym}` : t.displayText;
  });
  const displayText = displayParts.join(' ').trim();

  const validStarts = alignedTokens.map((t) => t.startSec).filter((x): x is number => x !== null);
  const validEnds = alignedTokens.map((t) => t.endSec).filter((x): x is number => x !== null);
  const startSec = validStarts.length > 0 ? Math.min(...validStarts) : null;
  const endSec = validEnds.length > 0 ? Math.max(...validEnds) : null;

  const hasExact = alignedTokens.some((t) => t.alignmentStatus === 'EXACT_WORD_ALIGNED');
  const hasApprox = alignedTokens.some((t) => t.alignmentStatus === 'APPROXIMATE_DERIVED');
  const alignmentStatus: AlignmentFidelityStatus =
    alignedTokens.length === 0 || (startSec === null && endSec === null)
      ? 'UNAVAILABLE'
      : hasApprox
        ? 'APPROXIMATE_DERIVED'
        : hasExact
          ? 'EXACT_WORD_ALIGNED'
          : 'SEGMENT_ONLY';

  return {
    segmentId: params.segmentId,
    policyVersion: PERSIAN_LINGUISTIC_POLICY_VERSION,
    mode,
    rawTokens,
    alignedTokens,
    rawText,
    normalizedText,
    displayText,
    userCorrectedText: params.userCorrectedText ?? null,
    punctuationAnnotations,
    machineSuggestions,
    dominantLanguage: detectTextLanguageTag(normalizedText || rawText).language,
    startSec,
    endSec,
    alignmentStatus,
  };
}

/**
 * Reproducible Persian Evaluation Framework (`AVP-P0-009 §10`).
 * Strictly separates RAW WER/CER from versioned NORMALIZED WER/CER, and tracks
 * number accuracy, named-entity preservation, code-switching accuracy, and corpus provenance.
 */
export interface PersianEvaluationItem {
  readonly sampleId: string;
  readonly referenceText: string;
  readonly hypothesisText: string;
  readonly referenceProvenance: 'HUMAN_VERIFIED' | 'SYNTHETIC_FIXTURE' | 'AUTO_GENERATED';
  readonly annotatedNumbers?: readonly string[];
  readonly annotatedNamedEntities?: readonly string[];
  readonly annotatedLatinTerms?: readonly string[];
}

export interface PersianEvaluationReport {
  readonly policyVersion: typeof PERSIAN_LINGUISTIC_POLICY_VERSION;
  readonly normalizationProfile: 'FA-STRICT-V1' | 'FA-RELAXED-V1' | 'MIXED-NORM-V1';
  readonly status: 'EVALUATED' | 'BLOCKED_MISSING_HUMAN_CORPUS';
  readonly sampleCount: number;
  readonly humanVerifiedSampleCount: number;
  readonly syntheticSampleCount: number;
  readonly rawWer: number | null;
  readonly rawCer: number | null;
  readonly normalizedWer: number | null;
  readonly normalizedCer: number | null;
  readonly numberAccuracy: number | null;
  readonly namedEntityPreservationRate: number | null;
  readonly codeSwitchingPreservationRate: number | null;
  readonly limitations: readonly string[];
}

function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  const m = a.length;
  const n = b.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = dp[(i - 1) * (n + 1) + j] + 1;
      const ins = dp[i * (n + 1) + (j - 1)] + 1;
      const sub = dp[(i - 1) * (n + 1) + (j - 1)] + cost;
      dp[i * (n + 1) + j] = Math.min(del, ins, sub);
    }
  }
  return dp[m * (n + 1) + n];
}

export function evaluatePersianTranscriptCorpus(
  items: readonly PersianEvaluationItem[],
  normalizationProfile: 'FA-STRICT-V1' | 'FA-RELAXED-V1' | 'MIXED-NORM-V1' = 'MIXED-NORM-V1',
): PersianEvaluationReport {
  const humanCount = items.filter((i) => i.referenceProvenance === 'HUMAN_VERIFIED').length;
  const syntheticCount = items.length - humanCount;

  if (items.length === 0) {
    return {
      policyVersion: PERSIAN_LINGUISTIC_POLICY_VERSION,
      normalizationProfile,
      status: 'BLOCKED_MISSING_HUMAN_CORPUS',
      sampleCount: 0,
      humanVerifiedSampleCount: 0,
      syntheticSampleCount: 0,
      rawWer: null,
      rawCer: null,
      normalizedWer: null,
      normalizedCer: null,
      numberAccuracy: null,
      namedEntityPreservationRate: null,
      codeSwitchingPreservationRate: null,
      limitations: [
        'BLOCKED: No Persian reference evaluation corpus supplied; statistical ASR WER/CER qualification cannot be claimed.',
      ],
    };
  }

  let rawWordEdits = 0;
  let rawRefWords = 0;
  let rawCharEdits = 0;
  let rawRefChars = 0;

  let normWordEdits = 0;
  let normRefWords = 0;
  let normCharEdits = 0;
  let normRefChars = 0;

  let totalNumbers = 0;
  let matchedNumbers = 0;
  let totalEntities = 0;
  let matchedEntities = 0;
  let totalLatin = 0;
  let matchedLatin = 0;

  for (const item of items) {
    const rw = item.referenceText.trim().split(/\s+/).filter(Boolean);
    const hw = item.hypothesisText.trim().split(/\s+/).filter(Boolean);
    rawWordEdits += editDistance(rw, hw);
    rawRefWords += rw.length;

    const rc = Array.from(item.referenceText.replace(/\s+/g, ''));
    const hc = Array.from(item.hypothesisText.replace(/\s+/g, ''));
    rawCharEdits += editDistance(rc, hc);
    rawRefChars += rc.length;

    const refNorm = normalizeWithProfile(item.referenceText, normalizationProfile);
    const hypNorm = normalizeWithProfile(item.hypothesisText, normalizationProfile);
    const nrw = refNorm.split(/\s+/).filter(Boolean);
    const nhw = hypNorm.split(/\s+/).filter(Boolean);
    normWordEdits += editDistance(nrw, nhw);
    normRefWords += nrw.length;

    const nrc = Array.from(refNorm.replace(/\s+/g, ''));
    const nhc = Array.from(hypNorm.replace(/\s+/g, ''));
    normCharEdits += editDistance(nrc, nhc);
    normRefChars += nrc.length;

    const hypStdDigits = standardizePersianCharacters(item.hypothesisText);
    for (const num of item.annotatedNumbers ?? []) {
      totalNumbers++;
      if (hypStdDigits.includes(standardizePersianCharacters(num))) matchedNumbers++;
    }
    const hypStd = normalizeUnicodeScriptAware(item.hypothesisText);
    for (const ent of item.annotatedNamedEntities ?? []) {
      totalEntities++;
      if (hypStd.includes(normalizeUnicodeScriptAware(ent))) matchedEntities++;
    }
    for (const lat of item.annotatedLatinTerms ?? []) {
      totalLatin++;
      if (item.hypothesisText.toLowerCase().includes(lat.toLowerCase())) matchedLatin++;
    }
  }

  const limitations: string[] = [];
  if (humanCount === 0) {
    limitations.push(
      'Corpus contains only synthetic/fixture references (0 human-verified Persian audio transcripts); results verify metric computation only, not production Persian ASR WER.',
    );
  }

  return {
    policyVersion: PERSIAN_LINGUISTIC_POLICY_VERSION,
    normalizationProfile,
    status: humanCount > 0 ? 'EVALUATED' : 'BLOCKED_MISSING_HUMAN_CORPUS',
    sampleCount: items.length,
    humanVerifiedSampleCount: humanCount,
    syntheticSampleCount: syntheticCount,
    rawWer: rawRefWords > 0 ? Number((rawWordEdits / rawRefWords).toFixed(4)) : 0,
    rawCer: rawRefChars > 0 ? Number((rawCharEdits / rawRefChars).toFixed(4)) : 0,
    normalizedWer: normRefWords > 0 ? Number((normWordEdits / normRefWords).toFixed(4)) : 0,
    normalizedCer: normRefChars > 0 ? Number((normCharEdits / normRefChars).toFixed(4)) : 0,
    numberAccuracy: totalNumbers > 0 ? Number((matchedNumbers / totalNumbers).toFixed(4)) : null,
    namedEntityPreservationRate:
      totalEntities > 0 ? Number((matchedEntities / totalEntities).toFixed(4)) : null,
    codeSwitchingPreservationRate:
      totalLatin > 0 ? Number((matchedLatin / totalLatin).toFixed(4)) : null,
    limitations,
  };
}
