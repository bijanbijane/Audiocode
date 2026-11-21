/**
 * AVP-P0-010 — Evidence-Based Persian Transcript Correction, Linguistic Error Taxonomy & Safe Repair Engine
 *
 * Core Principle: ACOUSTIC EVIDENCE HAS STRICT PRIORITY OVER LINGUISTIC PLAUSIBILITY.
 * - Enforces a 6-tier Evidence Hierarchy (`DIRECT_ACOUSTIC > ASR_RECOGNITION > ALIGNMENT > LINGUISTIC > DOMAIN > EDITORIAL_PREFERENCE`).
 * - Protects meaning-critical tokens (negation, quantifiers, numbers, dates, currency, proper names, modals, conditionals, directionals).
 * - Preserves colloquial Persian without forced formalization.
 * - Keeps raw recognized speech immutable and recoverable across all human approval, rejection, modification, and undo/redo operations.
 * - Never fabricates missing ASR confidence; disables automatic semantic correction when no qualified calibration dataset exists.
 */

import {
  normalizeUnicodeScriptAware,
  PERSIAN_LINGUISTIC_POLICY_VERSION,
} from './PersianLinguisticQualityEngine';

export const CORRECTION_POLICY_VERSION = 'FA-EVIDENCE-CORRECTION-V1.0.0' as const;

export type EvidenceTier =
  | 'DIRECT_ACOUSTIC'
  | 'ASR_RECOGNITION'
  | 'ALIGNMENT'
  | 'LINGUISTIC'
  | 'DOMAIN'
  | 'EDITORIAL_PREFERENCE';

export const EVIDENCE_TIER_PRIORITY: Readonly<Record<EvidenceTier, number>> = {
  DIRECT_ACOUSTIC: 6,
  ASR_RECOGNITION: 5,
  ALIGNMENT: 4,
  LINGUISTIC: 3,
  DOMAIN: 2,
  EDITORIAL_PREFERENCE: 1,
};

export interface CorrectionEvidenceItem {
  readonly evidenceId: string;
  readonly tier: EvidenceTier;
  readonly polarity: 'SUPPORTING' | 'CONTRADICTORY' | 'AMBIGUOUS';
  readonly source: string;
  readonly summary: string;
  /** Optional raw score strictly bound to its provenance — never converted across tiers */
  readonly rawScore?: number;
}

export type PersianErrorFamily =
  | 'PHONETIC_ACOUSTIC'
  | 'MORPHOLOGICAL'
  | 'LEXICAL_SEMANTIC'
  | 'DISCOURSE_CONVERSATIONAL'
  | 'TEXT_REPRESENTATION';

export type PersianErrorCategoryId =
  | 'PHON_SIMILAR_PHONEME'
  | 'PHON_CONSONANT_SUBSTITUTION'
  | 'PHON_VOWEL_AMBIGUITY'
  | 'PHON_WORD_BOUNDARY'
  | 'PHON_CLIPPED_UTTERANCE'
  | 'MORPH_NEGATION_PREFIX'
  | 'MORPH_VERB_INFLECTION'
  | 'MORPH_CLITIC_ATTACHMENT'
  | 'MORPH_EZAFE_AMBIGUITY'
  | 'MORPH_COMPOUND_BOUNDARY'
  | 'LEX_HOMOPHONE'
  | 'LEX_PROPER_NAME_SUBSTITUTION'
  | 'LEX_TECHNICAL_TERM'
  | 'LEX_DOMAIN_VOCABULARY'
  | 'LEX_NUMBER_OR_QUANTIFIER'
  | 'DISC_REPEATED_WORD'
  | 'DISC_FALSE_START_OR_SELF_CORRECTION'
  | 'DISC_FILLER'
  | 'DISC_INCOMPLETE_PHRASE'
  | 'DISC_SPEAKER_BOUNDARY'
  | 'TEXT_UNICODE_VARIANT'
  | 'TEXT_ZWNJ_ERROR'
  | 'TEXT_PUNCTUATION'
  | 'TEXT_DIGIT_FORMAT'
  | 'TEXT_SCRIPT_MIXING';

export interface PersianErrorTaxonomyEntry {
  readonly id: PersianErrorCategoryId;
  readonly family: PersianErrorFamily;
  readonly definition: string;
  readonly detectionMethod: string;
  readonly requiredEvidence: readonly EvidenceTier[];
  readonly severity: 'CRITICAL_MEANING' | 'HIGH' | 'MEDIUM' | 'LOW_ORTHOGRAPHIC';
  readonly autoCorrectionEligible: boolean;
  readonly knownFalsePositives: readonly string[];
  readonly regressionTestRef: string;
}

export const PERSIAN_ASR_ERROR_TAXONOMY_V1: Readonly<
  Record<PersianErrorCategoryId, PersianErrorTaxonomyEntry>
> = {
  PHON_SIMILAR_PHONEME: {
    id: 'PHON_SIMILAR_PHONEME',
    family: 'PHONETIC_ACOUSTIC',
    definition: 'Substitution between acoustically similar Persian phonemes.',
    detectionMethod: 'Acoustic lattice / N-best comparison with phoneme similarity.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ASR_RECOGNITION'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Minimal pairs intentionally spoken by speaker'],
    regressionTestRef: 'AVP-P0-010-T01',
  },
  PHON_CONSONANT_SUBSTITUTION: {
    id: 'PHON_CONSONANT_SUBSTITUTION',
    family: 'PHONETIC_ACOUSTIC',
    definition: 'Consonant misrecognition (e.g., س/ش, غ/ق, ت/د).',
    detectionMethod: 'ASR alternative hypothesis + acoustic evidence check.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ASR_RECOGNITION'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Regional pronunciation variants'],
    regressionTestRef: 'AVP-P0-010-T02',
  },
  PHON_VOWEL_AMBIGUITY: {
    id: 'PHON_VOWEL_AMBIGUITY',
    family: 'PHONETIC_ACOUSTIC',
    definition: 'Short vowel omission or ambiguity in Persian orthography.',
    detectionMethod: 'Alignment + linguistic compatibility inspection.',
    requiredEvidence: ['ASR_RECOGNITION', 'ALIGNMENT'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Colloquial vowel raising (آن -> اون)'],
    regressionTestRef: 'AVP-P0-010-T03',
  },
  PHON_WORD_BOUNDARY: {
    id: 'PHON_WORD_BOUNDARY',
    family: 'PHONETIC_ACOUSTIC',
    definition: 'Word boundary split/merge error during coarticulation.',
    detectionMethod: 'Token alignment boundary + ZWNJ/compound validation.',
    requiredEvidence: ['ALIGNMENT', 'ASR_RECOGNITION'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Valid two-word phrases resembling compounds'],
    regressionTestRef: 'AVP-P0-010-T04',
  },
  PHON_CLIPPED_UTTERANCE: {
    id: 'PHON_CLIPPED_UTTERANCE',
    family: 'PHONETIC_ACOUSTIC',
    definition: 'Truncated or clipped utterance at noise/segment edge.',
    detectionMethod: 'Acoustic energy truncation check at boundary.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ALIGNMENT'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Intentional incomplete spoken clause'],
    regressionTestRef: 'AVP-P0-010-T05',
  },
  MORPH_NEGATION_PREFIX: {
    id: 'MORPH_NEGATION_PREFIX',
    family: 'MORPHOLOGICAL',
    definition: 'Addition or omission of Persian negation prefix (نـ / نمی‌ـ / هیچ).',
    detectionMethod: 'Meaning-critical negation guard + direct acoustic verification.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ASR_RECOGNITION'],
    severity: 'CRITICAL_MEANING',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Speaker genuinely uttered unexpected polarity'],
    regressionTestRef: 'AVP-P0-010-ADV-NEGATION',
  },
  MORPH_VERB_INFLECTION: {
    id: 'MORPH_VERB_INFLECTION',
    family: 'MORPHOLOGICAL',
    definition: 'Verb tense, person, number, or aspect mismatch.',
    detectionMethod: 'Morphological analyzer + acoustic agreement check.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ASR_RECOGNITION'],
    severity: 'CRITICAL_MEANING',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Colloquial tense shift or speaker self-correction'],
    regressionTestRef: 'AVP-P0-010-ADV-VERB',
  },
  MORPH_CLITIC_ATTACHMENT: {
    id: 'MORPH_CLITIC_ATTACHMENT',
    family: 'MORPHOLOGICAL',
    definition: 'Detached or fused pronominal clitics (ـم، ـت، ـش).',
    detectionMethod: 'Persian morphological clitic boundary inspection.',
    requiredEvidence: ['ALIGNMENT', 'LINGUISTIC'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Independent short words (ام as filler vs clitic)'],
    regressionTestRef: 'AVP-P0-010-T08',
  },
  MORPH_EZAFE_AMBIGUITY: {
    id: 'MORPH_EZAFE_AMBIGUITY',
    family: 'MORPHOLOGICAL',
    definition: 'Ezafe linkage mis-segmented as independent ی/ای token.',
    detectionMethod: 'Alignment gap + nominal phrase inspection.',
    requiredEvidence: ['ALIGNMENT', 'ASR_RECOGNITION'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Indefinite suffix ی or vocative ای'],
    regressionTestRef: 'AVP-P0-010-T09',
  },
  MORPH_COMPOUND_BOUNDARY: {
    id: 'MORPH_COMPOUND_BOUNDARY',
    family: 'MORPHOLOGICAL',
    definition: 'Light-verb or compound nominal spacing/ZWNJ boundary error.',
    detectionMethod: 'Verified ZWNJ compound table.',
    requiredEvidence: ['LINGUISTIC'],
    severity: 'LOW_ORTHOGRAPHIC',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Syntactic modifier vs compound noun'],
    regressionTestRef: 'AVP-P0-010-T10',
  },
  LEX_HOMOPHONE: {
    id: 'LEX_HOMOPHONE',
    family: 'LEXICAL_SEMANTIC',
    definition: 'Persian homophone substitution (e.g., خوار/خار، سواب/ثواب، خواست/خاست).',
    detectionMethod: 'Homophone inventory + local context check (human review required).',
    requiredEvidence: ['ASR_RECOGNITION', 'LINGUISTIC'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Rare domain usage of less-frequent homophone'],
    regressionTestRef: 'AVP-P0-010-ADV-HOMOPHONE',
  },
  LEX_PROPER_NAME_SUBSTITUTION: {
    id: 'LEX_PROPER_NAME_SUBSTITUTION',
    family: 'LEXICAL_SEMANTIC',
    definition: 'Proper person/place/brand name distorted into common noun.',
    detectionMethod: 'User-provided domain glossary match.',
    requiredEvidence: ['DOMAIN', 'ASR_RECOGNITION'],
    severity: 'CRITICAL_MEANING',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Common word that happens to match a person name'],
    regressionTestRef: 'AVP-P0-010-ADV-NAME',
  },
  LEX_TECHNICAL_TERM: {
    id: 'LEX_TECHNICAL_TERM',
    family: 'LEXICAL_SEMANTIC',
    definition: 'Technical or English loanword misrecognized in Persian script.',
    detectionMethod: 'Verified technical lexicon + acoustic match.',
    requiredEvidence: ['DOMAIN', 'ASR_RECOGNITION'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Persian word phonetically near English acronym'],
    regressionTestRef: 'AVP-P0-010-ADV-TECH',
  },
  LEX_DOMAIN_VOCABULARY: {
    id: 'LEX_DOMAIN_VOCABULARY',
    family: 'LEXICAL_SEMANTIC',
    definition: 'Domain-specific terminology mismatch against approved user dictionary.',
    detectionMethod: 'Validated local domain dictionary lookup.',
    requiredEvidence: ['DOMAIN', 'ASR_RECOGNITION'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['General-language homonyms'],
    regressionTestRef: 'AVP-P0-010-T14',
  },
  LEX_NUMBER_OR_QUANTIFIER: {
    id: 'LEX_NUMBER_OR_QUANTIFIER',
    family: 'LEXICAL_SEMANTIC',
    definition: 'Numeric value, date, currency, or quantifier alteration.',
    detectionMethod: 'Meaning-critical quantifier/numeric guard.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ASR_RECOGNITION'],
    severity: 'CRITICAL_MEANING',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Unusual spoken numbers (e.g., prices/IDs)'],
    regressionTestRef: 'AVP-P0-010-ADV-NUMBER',
  },
  DISC_REPEATED_WORD: {
    id: 'DISC_REPEATED_WORD',
    family: 'DISCOURSE_CONVERSATIONAL',
    definition: 'Adjacent repeated word in spoken delivery.',
    detectionMethod: 'Adjacent token comparison with alignment verification.',
    requiredEvidence: ['ALIGNMENT', 'ASR_RECOGNITION'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Intentional Persian reduplication (کم‌کم، تندتند، خوب خوب)'],
    regressionTestRef: 'AVP-P0-010-ADV-REPEAT',
  },
  DISC_FALSE_START_OR_SELF_CORRECTION: {
    id: 'DISC_FALSE_START_OR_SELF_CORRECTION',
    family: 'DISCOURSE_CONVERSATIONAL',
    definition: 'Speaker abandoned or repaired phrase mid-utterance.',
    detectionMethod: 'Acoustic pause + partial prefix overlap.',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ALIGNMENT'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Deliberate rhetorical pause'],
    regressionTestRef: 'AVP-P0-010-ADV-SELFCORR',
  },
  DISC_FILLER: {
    id: 'DISC_FILLER',
    family: 'DISCOURSE_CONVERSATIONAL',
    definition: 'Spoken disfluency/filler (امم، اِه، خب).',
    detectionMethod: 'Filler list + pause boundary check.',
    requiredEvidence: ['ASR_RECOGNITION', 'ALIGNMENT'],
    severity: 'LOW_ORTHOGRAPHIC',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Meaningful word خب/یعنی in discourse'],
    regressionTestRef: 'AVP-P0-010-T18',
  },
  DISC_INCOMPLETE_PHRASE: {
    id: 'DISC_INCOMPLETE_PHRASE',
    family: 'DISCOURSE_CONVERSATIONAL',
    definition: 'Speaker stopped before finishing syntactic clause.',
    detectionMethod: 'Segment end boundary inspection (never invent missing words).',
    requiredEvidence: ['DIRECT_ACOUSTIC', 'ALIGNMENT'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Elliptical natural Persian answer'],
    regressionTestRef: 'AVP-P0-010-ADV-INCOMPLETE',
  },
  DISC_SPEAKER_BOUNDARY: {
    id: 'DISC_SPEAKER_BOUNDARY',
    family: 'DISCOURSE_CONVERSATIONAL',
    definition: 'Cross-speaker turn boundary risk.',
    detectionMethod: 'Speaker track/turn ID boundary guard.',
    requiredEvidence: ['ALIGNMENT'],
    severity: 'HIGH',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Single-speaker rapid intonation shift'],
    regressionTestRef: 'AVP-P0-010-ADV-SPEAKER',
  },
  TEXT_UNICODE_VARIANT: {
    id: 'TEXT_UNICODE_VARIANT',
    family: 'TEXT_REPRESENTATION',
    definition: 'Arabic ي/ك or presentation-form Unicode codepoints in Persian text.',
    detectionMethod: 'Deterministic Unicode codepoint scan.',
    requiredEvidence: ['LINGUISTIC'],
    severity: 'LOW_ORTHOGRAPHIC',
    autoCorrectionEligible: true,
    knownFalsePositives: ['Explicit Arabic quotation where ي/ك must remain'],
    regressionTestRef: 'AVP-P0-010-T21',
  },
  TEXT_ZWNJ_ERROR: {
    id: 'TEXT_ZWNJ_ERROR',
    family: 'TEXT_REPRESENTATION',
    definition: 'Missing standard Persian half-space (ZWNJ) in unambiguous lexical forms.',
    detectionMethod: 'Deterministic verified ZWNJ lexicon check.',
    requiredEvidence: ['LINGUISTIC'],
    severity: 'LOW_ORTHOGRAPHIC',
    autoCorrectionEligible: true,
    knownFalsePositives: ['Proper names or archaic spellings'],
    regressionTestRef: 'AVP-P0-010-T22',
  },
  TEXT_PUNCTUATION: {
    id: 'TEXT_PUNCTUATION',
    family: 'TEXT_REPRESENTATION',
    definition: 'Missing or ambiguous punctuation.',
    detectionMethod: 'Acoustic pause vs linguistic heuristic (separated).',
    requiredEvidence: ['ALIGNMENT'],
    severity: 'LOW_ORTHOGRAPHIC',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Pause within noun phrase'],
    regressionTestRef: 'AVP-P0-010-T23',
  },
  TEXT_DIGIT_FORMAT: {
    id: 'TEXT_DIGIT_FORMAT',
    family: 'TEXT_REPRESENTATION',
    definition: 'Digit glyph style difference (۰-۹ vs 0-9) with identical numeric value.',
    detectionMethod: 'Strict numeric value equivalence verification.',
    requiredEvidence: ['LINGUISTIC'],
    severity: 'LOW_ORTHOGRAPHIC',
    autoCorrectionEligible: true,
    knownFalsePositives: ['Latin technical identifiers containing digits'],
    regressionTestRef: 'AVP-P0-010-T24',
  },
  TEXT_SCRIPT_MIXING: {
    id: 'TEXT_SCRIPT_MIXING',
    family: 'TEXT_REPRESENTATION',
    definition: 'Unexpected mixed Arabic/Latin script corruption inside single token.',
    detectionMethod: 'Per-token Unicode script boundary detector.',
    requiredEvidence: ['LINGUISTIC'],
    severity: 'MEDIUM',
    autoCorrectionEligible: false,
    knownFalsePositives: ['Intentional code-switched suffix (e.g., APIها)'],
    regressionTestRef: 'AVP-P0-010-T25',
  },
};

export type CorrectionDecisionOutcome =
  | 'NO_CHANGE'
  | 'SAFE_NORMALIZATION'
  | 'SUGGESTED_CORRECTION'
  | 'REQUIRES_HUMAN_REVIEW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'REJECTED_CORRECTION';

export type MeaningCriticalTokenKind =
  | 'NEGATION'
  | 'QUANTIFIER'
  | 'COMPARATIVE'
  | 'NUMBER'
  | 'DATE_TIME'
  | 'CURRENCY'
  | 'PROPER_NAME'
  | 'PRONOUN'
  | 'MODAL'
  | 'CONDITIONAL'
  | 'QUESTION'
  | 'DIRECTIONAL';

export interface ConfidenceProvenanceRecord {
  readonly providerRawConfidence?: number;
  readonly providerSource: 'ASR_TOKEN_LOGPROB' | 'ASR_SEGMENT_AVG' | 'UNAVAILABLE';
  readonly calibratedConfidence?: number;
  readonly calibrationMethodVersion?: string;
  readonly linguisticCompatibilityScore?: number;
  readonly calibrationDatasetQualified: boolean;
}

export interface ProposedCorrectionRequest {
  readonly proposalId: string;
  readonly transcriptRevision: number;
  readonly segmentId: string;
  readonly tokenIds: readonly string[];
  readonly speakerId?: string;
  readonly crossesSpeakerBoundary?: boolean;
  readonly originalText: string;
  readonly proposedText: string;
  readonly category: PersianErrorCategoryId;
  readonly evidence: readonly CorrectionEvidenceItem[];
  readonly confidence: ConfidenceProvenanceRecord;
  readonly knownProperNames?: readonly string[];
  readonly isColloquialSpokenSource?: boolean;
}

export interface CorrectionDecisionRecord {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly transcriptRevision: number;
  readonly segmentId: string;
  readonly tokenIds: readonly string[];
  readonly originalText: string;
  readonly proposedAlternative: string;
  readonly category: PersianErrorCategoryId;
  readonly meaningCriticalFlags: readonly MeaningCriticalTokenKind[];
  readonly outcome: CorrectionDecisionOutcome;
  readonly safeToAutoApply: boolean;
  readonly requiresHumanReview: boolean;
  readonly supportingEvidence: readonly CorrectionEvidenceItem[];
  readonly contradictoryEvidence: readonly CorrectionEvidenceItem[];
  readonly uncertaintyStatus: 'LOW_UNCERTAINTY' | 'MODERATE_UNCERTAINTY' | 'HIGH_UNCERTAINTY' | 'CONFIDENCE_UNAVAILABLE';
  readonly rejectionReason: string | null;
  readonly confidenceProvenance: ConfidenceProvenanceRecord;
  readonly normalizationPolicyVersion: typeof PERSIAN_LINGUISTIC_POLICY_VERSION;
  readonly correctionPolicyVersion: typeof CORRECTION_POLICY_VERSION;
}

/** Persian morphological analysis abstraction (`AVP-P0-010 §4`) */
export interface PersianMorphologicalAnalysis {
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly hasNegationPrefix: boolean;
  readonly hasContinuousPrefix: boolean;
  readonly detectedCliticSuffix: string | null;
  readonly possibleCompoundVerb: boolean;
  readonly colloquialSpokenForm: boolean;
  readonly analyzerKind: 'RULE_BASED_LIGHT_INSPECTOR' | 'EXTERNAL_STATISTICAL_MODEL';
  readonly fullStatisticalModelAvailable: boolean;
}

export interface PersianMorphologicalAnalyzerProvider {
  readonly providerId: string;
  readonly fullStatisticalModelAvailable: boolean;
  analyze(surfaceToken: string): PersianMorphologicalAnalysis;
}

export class RuleBasedPersianMorphologyInspector implements PersianMorphologicalAnalyzerProvider {
  public readonly providerId = 'avapardaz-rule-morphology-v1';
  public readonly fullStatisticalModelAvailable = false;

  public analyze(surfaceToken: string): PersianMorphologicalAnalysis {
    const norm = normalizeUnicodeScriptAware(surfaceToken);
    const hasNegationPrefix =
      norm.startsWith('نمی') ||
      norm.startsWith('نمی\u200c') ||
      /^(ن|نه|نیست|ندارد|ندارم|نباید|نشده|نشد|نکرد|نمی‌)/.test(norm);
    const hasContinuousPrefix = norm.startsWith('می\u200c') || norm.startsWith('نمی\u200c');
    const cliticMatch = norm.match(/\u200c(ام|ات|اش|ایم|اید|اند)$/);
    const colloquialSet = new Set(['میخوام', 'می‌خوام', 'میشه', 'می‌شه', 'نمیشه', 'نمی‌شه', 'واسه', 'خونه', 'آره', 'بگم', 'برم']);
    return {
      surfaceForm: surfaceToken,
      normalizedForm: norm,
      hasNegationPrefix,
      hasContinuousPrefix,
      detectedCliticSuffix: cliticMatch ? cliticMatch[1] : null,
      possibleCompoundVerb: /\s+(کرد|شد|داد|زد|گرفت|داشت)$/.test(norm),
      colloquialSpokenForm: colloquialSet.has(norm),
      analyzerKind: 'RULE_BASED_LIGHT_INSPECTOR',
      fullStatisticalModelAvailable: false,
    };
  }
}

const NEGATION_TOKENS = new Set([
  'نه', 'نخیر', 'نیست', 'نیستم', 'نیستی', 'نیستیم', 'نیستند',
  'ندارد', 'ندارم', 'نداری', 'نداریم', 'ندارند',
  'نباید', 'نمی‌شود', 'نمیشود', 'نمی‌شه', 'نمیشه',
  'نمی‌تواند', 'نمیتواند', 'نمی‌خواهم', 'نمیخواهم', 'هیچ', 'هیچ‌کدام', 'هیچکدام', 'هرگز', 'اصلاً',
]);
const QUANTIFIER_TOKENS = new Set(['همه', 'هیچ‌کدام', 'هیچکدام', 'بعضی', 'برخی', 'اکثر', 'بسیاری', 'اندکی', 'تمام', 'کل', 'فقط', 'تنها']);
const COMPARATIVE_TOKENS = new Set(['بیشتر', 'کمتر', 'بهتر', 'بدتر', 'بزرگ‌تر', 'کوچک‌تر', 'بالاتر', 'پایین‌تر', 'بیشترین', 'کمترین']);
const MODAL_TOKENS = new Set(['باید', 'نباید', 'می‌تواند', 'نمی‌تواند', 'شاید', 'ممكن', 'ممکن', 'لازم']);
const CONDITIONAL_TOKENS = new Set(['اگر', 'اگه', 'درصورتی‌که', 'به‌شرطی', 'مگر', 'چنانچه']);
const QUESTION_TOKENS = new Set(['آیا', 'چرا', 'چطور', 'چگونه', 'کجا', 'کی', 'چند', 'کدام', 'چی']);
const DIRECTIONAL_TOKENS = new Set(['قبل', 'بعد', 'بالا', 'پایین', 'چپ', 'راست', 'داخل', 'خارج', 'شمال', 'جنوب', 'شرق', 'غرب', 'پیش', 'پس']);
const PRONOUN_TOKENS = new Set(['من', 'تو', 'او', 'ما', 'شما', 'آنها', 'آن‌ها', 'ایشان', 'خودم', 'خودت', 'خودش']);
const CURRENCY_RE = /(تومان|تومن|ریال|دلار|یورو|درهم|پوند|\$|€)/;
const DATE_TIME_RE = /(شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنج‌شنبه|جمعه|فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند|ساعت|دقیقه|ثانیه|سال|ماه|روز)/;
const NUMBER_RE = /[\d۰-۹٠-٩]|(صفر|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|بیست|سی|چهل|پنجاه|صد|هزار|میلیون|میلیارد)/;

export function detectMeaningCriticalTokens(
  text: string,
  knownProperNames: readonly string[] = [],
): MeaningCriticalTokenKind[] {
  const norm = normalizeUnicodeScriptAware(text);
  const words = norm.split(/\s+/).filter(Boolean);
  const flags = new Set<MeaningCriticalTokenKind>();

  const morph = new RuleBasedPersianMorphologyInspector();
  for (const w of words) {
    if (NEGATION_TOKENS.has(w) || morph.analyze(w).hasNegationPrefix) flags.add('NEGATION');
    if (QUANTIFIER_TOKENS.has(w)) flags.add('QUANTIFIER');
    if (COMPARATIVE_TOKENS.has(w)) flags.add('COMPARATIVE');
    if (MODAL_TOKENS.has(w)) flags.add('MODAL');
    if (CONDITIONAL_TOKENS.has(w)) flags.add('CONDITIONAL');
    if (QUESTION_TOKENS.has(w)) flags.add('QUESTION');
    if (DIRECTIONAL_TOKENS.has(w)) flags.add('DIRECTIONAL');
    if (PRONOUN_TOKENS.has(w)) flags.add('PRONOUN');
    if (CURRENCY_RE.test(w)) flags.add('CURRENCY');
    if (DATE_TIME_RE.test(w)) flags.add('DATE_TIME');
    if (NUMBER_RE.test(w)) flags.add('NUMBER');
    if (knownProperNames.some((n) => normalizeUnicodeScriptAware(n) === w)) {
      flags.add('PROPER_NAME');
    }
  }
  return Array.from(flags);
}

/**
 * Deterministic Evidence-Constrained Persian Correction Decision Engine (`AVP-P0-010 §1, §3, §5, §6, §7, §8`).
 */
export function evaluateProposedCorrection(req: ProposedCorrectionRequest): CorrectionDecisionRecord {
  const supporting = req.evidence.filter((e) => e.polarity === 'SUPPORTING');
  const contradictory = req.evidence.filter((e) => e.polarity === 'CONTRADICTORY');
  const decisionId = `dec_${req.proposalId}`;

  const origNorm = normalizeUnicodeScriptAware(req.originalText);
  const propNorm = normalizeUnicodeScriptAware(req.proposedText);
  const meaningFlags = Array.from(
    new Set([
      ...detectMeaningCriticalTokens(req.originalText, req.knownProperNames),
      ...detectMeaningCriticalTokens(req.proposedText, req.knownProperNames),
    ]),
  );

  const uncertaintyStatus: CorrectionDecisionRecord['uncertaintyStatus'] =
    req.confidence.providerSource === 'UNAVAILABLE' || req.confidence.providerRawConfidence === undefined
      ? 'CONFIDENCE_UNAVAILABLE'
      : req.confidence.providerRawConfidence >= 0.85
        ? 'LOW_UNCERTAINTY'
        : req.confidence.providerRawConfidence >= 0.55
          ? 'MODERATE_UNCERTAINTY'
          : 'HIGH_UNCERTAINTY';

  const makeRecord = (
    outcome: CorrectionDecisionOutcome,
    safeToAutoApply: boolean,
    requiresHumanReview: boolean,
    rejectionReason: string | null,
  ): CorrectionDecisionRecord => ({
    decisionId,
    proposalId: req.proposalId,
    transcriptRevision: req.transcriptRevision,
    segmentId: req.segmentId,
    tokenIds: [...req.tokenIds],
    originalText: req.originalText,
    proposedAlternative: req.proposedText,
    category: req.category,
    meaningCriticalFlags: meaningFlags,
    outcome,
    safeToAutoApply,
    requiresHumanReview,
    supportingEvidence: supporting,
    contradictoryEvidence: contradictory,
    uncertaintyStatus,
    rejectionReason,
    confidenceProvenance: req.confidence,
    normalizationPolicyVersion: PERSIAN_LINGUISTIC_POLICY_VERSION,
    correctionPolicyVersion: CORRECTION_POLICY_VERSION,
  });

  // 1. Identical surface form -> NO_CHANGE
  if (req.originalText === req.proposedText) {
    return makeRecord('NO_CHANGE', false, false, null);
  }

  // 2. Speaker boundary violation -> REJECTED_CORRECTION
  if (req.crossesSpeakerBoundary) {
    return makeRecord(
      'REJECTED_CORRECTION',
      false,
      false,
      'SPEAKER_BOUNDARY_VIOLATION: Correction cannot span or propagate across speaker boundaries.',
    );
  }

  // 3. Acoustic evidence has STRICT PRIORITY over linguistic / editorial plausibility
  const hasContradictoryAcoustic = contradictory.some(
    (e) => e.tier === 'DIRECT_ACOUSTIC' || e.tier === 'ASR_RECOGNITION',
  );
  const maxSupportPriority = supporting.reduce(
    (max, e) => Math.max(max, EVIDENCE_TIER_PRIORITY[e.tier]),
    0,
  );
  const maxContraPriority = contradictory.reduce(
    (max, e) => Math.max(max, EVIDENCE_TIER_PRIORITY[e.tier]),
    0,
  );
  if (hasContradictoryAcoustic && maxSupportPriority < maxContraPriority) {
    return makeRecord(
      'REJECTED_CORRECTION',
      false,
      false,
      'CONTRADICTORY_ACOUSTIC_EVIDENCE: Lower-priority linguistic/editorial preference cannot override contradictory acoustic or ASR recognition evidence.',
    );
  }

  // 4. Colloquial spoken form formalization protection (never auto-rewrite spoken speech into formal prose)
  const morphInspector = new RuleBasedPersianMorphologyInspector();
  const origMorph = morphInspector.analyze(req.originalText);
  if (req.isColloquialSpokenSource || origMorph.colloquialSpokenForm) {
    const onlyEditorialOrLinguistic = supporting.every(
      (e) => e.tier === 'EDITORIAL_PREFERENCE' || e.tier === 'LINGUISTIC',
    );
    if (onlyEditorialOrLinguistic) {
      return makeRecord(
        'REJECTED_CORRECTION',
        false,
        false,
        'COLLOQUIAL_SPEECH_PRESERVATION: Spoken colloquial Persian form cannot be overwritten based solely on formal linguistic or editorial preference.',
      );
    }
  }

  // 5. Pure orthographic normalization (exact same lexical meaning: Arabic ی/ک, ZWNJ, or same-value digit glyph)
  const taxonomyEntry = PERSIAN_ASR_ERROR_TAXONOMY_V1[req.category];
  const isPureOrthographicSafe =
    taxonomyEntry.autoCorrectionEligible &&
    (req.category === 'TEXT_UNICODE_VARIANT' ||
      req.category === 'TEXT_ZWNJ_ERROR' ||
      req.category === 'TEXT_DIGIT_FORMAT') &&
    origNorm.replace(/\u200c/g, '') === propNorm.replace(/\u200c/g, '') &&
    !hasContradictoryAcoustic;

  if (isPureOrthographicSafe) {
    return makeRecord('SAFE_NORMALIZATION', true, false, null);
  }

  // 6. Meaning-critical token protection (negation, quantifiers, numbers, dates, currency, proper names, modals, directionals)
  const origNoSpace = origNorm.replace(/\s+/g, '');
  const propNoSpace = propNorm.replace(/\s+/g, '');
  if (meaningFlags.length > 0 && origNoSpace !== propNoSpace) {
    const hasAcousticSupport = supporting.some(
      (e) => e.tier === 'DIRECT_ACOUSTIC' || e.tier === 'ASR_RECOGNITION',
    );
    if (!hasAcousticSupport) {
      return makeRecord(
        'INSUFFICIENT_EVIDENCE',
        false,
        true,
        `MEANING_CRITICAL_PROTECTION (${meaningFlags.join(', ')}): Cannot alter meaning-critical token without direct acoustic or ASR recognition evidence.`,
      );
    }
    return makeRecord('REQUIRES_HUMAN_REVIEW', false, true, null);
  }

  // 7. No supporting evidence at all -> INSUFFICIENT_EVIDENCE
  if (supporting.length === 0) {
    return makeRecord(
      'INSUFFICIENT_EVIDENCE',
      false,
      true,
      'No supporting evidence supplied for proposed correction.',
    );
  }

  // 8. Non-orthographic semantic/phonetic/morphological change:
  // Automatic semantic correction is ALWAYS disabled unless a qualified validation calibration dataset exists!
  if (!req.confidence.calibrationDatasetQualified) {
    const hasStrongEvidence = supporting.some(
      (e) => e.tier === 'DIRECT_ACOUSTIC' || e.tier === 'ASR_RECOGNITION' || e.tier === 'DOMAIN',
    );
    if (!hasStrongEvidence) {
      return makeRecord(
        'INSUFFICIENT_EVIDENCE',
        false,
        true,
        'Linguistic/editorial preference alone is insufficient without acoustic, recognition, or verified domain evidence.',
      );
    }
    return makeRecord(
      taxonomyEntry.severity === 'CRITICAL_MEANING' || taxonomyEntry.severity === 'HIGH'
        ? 'REQUIRES_HUMAN_REVIEW'
        : 'SUGGESTED_CORRECTION',
      false,
      true,
      null,
    );
  }

  return makeRecord('SUGGESTED_CORRECTION', false, true, null);
}

/**
 * Human-in-the-loop Transcript Correction Ledger (`AVP-P0-010 §9`).
 * Guarantees:
 * - Immutable raw recognized text is always recoverable.
 * - Suggestions never mutate canonical transcript before explicit human approval.
 * - Stale suggestions (wrong transcriptRevision) are rejected atomically.
 * - Undo/redo preserves full decision provenance.
 */
export interface TranscriptCorrectionHistoryEntry {
  readonly actionId: string;
  readonly action: 'ACCEPT_CORRECTION' | 'REJECT_CORRECTION' | 'USER_EDIT' | 'REVERT_TO_ORIGINAL';
  readonly decisionId: string | null;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly beforeText: string;
  readonly afterText: string;
  readonly timestampMs: number;
}

export class HumanInTheLoopCorrectionLedger {
  public readonly originalRecognizedText: string;
  private currentText: string;
  private revision = 1;
  private readonly decisions = new Map<string, CorrectionDecisionRecord>();
  private readonly acceptedIds = new Set<string>();
  private readonly rejectedIds = new Set<string>();
  private readonly history: TranscriptCorrectionHistoryEntry[] = [];
  private readonly redoStack: TranscriptCorrectionHistoryEntry[] = [];

  constructor(originalRecognizedText: string) {
    this.originalRecognizedText = originalRecognizedText;
    this.currentText = originalRecognizedText;
  }

  public getState() {
    return {
      originalRecognizedText: this.originalRecognizedText,
      currentText: this.currentText,
      revision: this.revision,
      pendingDecisions: Array.from(this.decisions.values()).filter(
        (d) => !this.acceptedIds.has(d.decisionId) && !this.rejectedIds.has(d.decisionId),
      ),
      acceptedDecisionIds: Array.from(this.acceptedIds),
      rejectedDecisionIds: Array.from(this.rejectedIds),
      history: [...this.history],
    };
  }

  public registerDecision(decision: CorrectionDecisionRecord): void {
    this.decisions.set(decision.decisionId, decision);
    if (decision.outcome === 'REJECTED_CORRECTION') {
      this.rejectedIds.add(decision.decisionId);
    }
  }

  public acceptDecision(
    decisionId: string,
    nowMs = Date.now(),
  ): { readonly ok: boolean; readonly errorCode?: string; readonly errorMessage?: string } {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      return { ok: false, errorCode: 'DECISION_NOT_FOUND', errorMessage: `Unknown decisionId "${decisionId}".` };
    }
    if (decision.outcome === 'REJECTED_CORRECTION' || this.rejectedIds.has(decisionId)) {
      return {
        ok: false,
        errorCode: 'CANNOT_ACCEPT_REJECTED_CORRECTION',
        errorMessage: 'A rejected correction cannot be accepted into the transcript.',
      };
    }
    if (decision.transcriptRevision !== this.revision) {
      return {
        ok: false,
        errorCode: 'STALE_TRANSCRIPT_REVISION',
        errorMessage: `Suggestion targets revision ${decision.transcriptRevision}, but current transcript is revision ${this.revision}.`,
      };
    }
    if (!this.currentText.includes(decision.originalText)) {
      return {
        ok: false,
        errorCode: 'TARGET_SPAN_NOT_FOUND',
        errorMessage: 'Original span is no longer present in current transcript.',
      };
    }

    const before = this.currentText;
    const after = this.currentText.replace(decision.originalText, decision.proposedAlternative);
    const prevRev = this.revision;
    this.revision += 1;
    this.currentText = after;
    this.acceptedIds.add(decisionId);
    this.redoStack.length = 0;
    this.history.push({
      actionId: `act_${this.history.length + 1}`,
      action: 'ACCEPT_CORRECTION',
      decisionId,
      previousRevision: prevRev,
      nextRevision: this.revision,
      beforeText: before,
      afterText: after,
      timestampMs: nowMs,
    });
    return { ok: true };
  }

  public rejectDecision(decisionId: string, nowMs = Date.now()): { readonly ok: boolean } {
    const decision = this.decisions.get(decisionId);
    if (!decision) return { ok: false };
    this.rejectedIds.add(decisionId);
    this.history.push({
      actionId: `act_${this.history.length + 1}`,
      action: 'REJECT_CORRECTION',
      decisionId,
      previousRevision: this.revision,
      nextRevision: this.revision,
      beforeText: this.currentText,
      afterText: this.currentText,
      timestampMs: nowMs,
    });
    return { ok: true };
  }

  public applyUserManualEdit(newText: string, nowMs = Date.now()): void {
    const before = this.currentText;
    const prevRev = this.revision;
    this.revision += 1;
    this.currentText = newText;
    this.redoStack.length = 0;
    this.history.push({
      actionId: `act_${this.history.length + 1}`,
      action: 'USER_EDIT',
      decisionId: null,
      previousRevision: prevRev,
      nextRevision: this.revision,
      beforeText: before,
      afterText: newText,
      timestampMs: nowMs,
    });
  }

  public revertToOriginal(nowMs = Date.now()): void {
    const before = this.currentText;
    const prevRev = this.revision;
    this.revision += 1;
    this.currentText = this.originalRecognizedText;
    this.redoStack.length = 0;
    this.history.push({
      actionId: `act_${this.history.length + 1}`,
      action: 'REVERT_TO_ORIGINAL',
      decisionId: null,
      previousRevision: prevRev,
      nextRevision: this.revision,
      beforeText: before,
      afterText: this.originalRecognizedText,
      timestampMs: nowMs,
    });
  }

  public undo(): boolean {
    const last = this.history.pop();
    if (!last) return false;
    this.currentText = last.beforeText;
    this.revision = last.previousRevision;
    if (last.action === 'ACCEPT_CORRECTION' && last.decisionId) {
      this.acceptedIds.delete(last.decisionId);
    }
    this.redoStack.push(last);
    return true;
  }

  public redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.currentText = next.afterText;
    this.revision = next.nextRevision;
    if (next.action === 'ACCEPT_CORRECTION' && next.decisionId) {
      this.acceptedIds.add(next.decisionId);
    }
    this.history.push(next);
    return true;
  }
}

/** Reproducible correction quality & adversarial false-correction metrics (`AVP-P0-010 §10`) */
export interface CorrectionEvaluationCase {
  readonly caseId: string;
  readonly category: PersianErrorCategoryId;
  readonly isTrueErrorInAudio: boolean;
  readonly altersSpokenMeaning: boolean;
  readonly isNegationCase: boolean;
  readonly isColloquialPreservationCase: boolean;
  readonly decision: CorrectionDecisionRecord;
}

export interface CorrectionQualityMetricsReport {
  readonly policyVersion: typeof CORRECTION_POLICY_VERSION;
  readonly totalCases: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly autoCorrectionRate: number;
  readonly humanReviewRequirementRate: number;
  readonly falseAutoCorrectionRate: number;
  readonly meaningChangingAutoCorrectionCount: number;
  readonly negationAutoCorruptions: number;
  readonly colloquialPreservationRate: number;
  readonly frequencyByCategory: Readonly<Record<string, number>>;
}

export function computeCorrectionQualityMetrics(
  cases: readonly CorrectionEvaluationCase[],
): CorrectionQualityMetricsReport {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let autoApplied = 0;
  let falseAuto = 0;
  let humanReview = 0;
  let meaningChangingAuto = 0;
  let negationAutoCorruptions = 0;
  let colloquialTotal = 0;
  let colloquialPreserved = 0;
  const freq: Record<string, number> = {};

  for (const c of cases) {
    freq[c.category] = (freq[c.category] ?? 0) + 1;
    const predictedActionable =
      c.decision.outcome === 'SAFE_NORMALIZATION' ||
      c.decision.outcome === 'SUGGESTED_CORRECTION' ||
      c.decision.outcome === 'REQUIRES_HUMAN_REVIEW';

    if (c.isTrueErrorInAudio && predictedActionable) tp++;
    else if (!c.isTrueErrorInAudio && predictedActionable) fp++;
    else if (!c.isTrueErrorInAudio && !predictedActionable) tn++;
    else fn++;

    if (c.decision.safeToAutoApply) {
      autoApplied++;
      if (!c.isTrueErrorInAudio) falseAuto++;
      if (c.altersSpokenMeaning) meaningChangingAuto++;
      if (c.isNegationCase) negationAutoCorruptions++;
    }
    if (c.decision.requiresHumanReview) humanReview++;
    if (c.isColloquialPreservationCase) {
      colloquialTotal++;
      if (!c.decision.safeToAutoApply && c.decision.outcome !== 'SUGGESTED_CORRECTION') {
        colloquialPreserved++;
      }
    }
  }

  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 1;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 1;
  const f1 = precision + recall > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
  const n = Math.max(1, cases.length);

  return {
    policyVersion: CORRECTION_POLICY_VERSION,
    totalCases: cases.length,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    autoCorrectionRate: Number((autoApplied / n).toFixed(4)),
    humanReviewRequirementRate: Number((humanReview / n).toFixed(4)),
    falseAutoCorrectionRate: Number((falseAuto / n).toFixed(4)),
    meaningChangingAutoCorrectionCount: meaningChangingAuto,
    negationAutoCorruptions,
    colloquialPreservationRate:
      colloquialTotal > 0 ? Number((colloquialPreserved / colloquialTotal).toFixed(4)) : 1,
    frequencyByCategory: freq,
  };
}
