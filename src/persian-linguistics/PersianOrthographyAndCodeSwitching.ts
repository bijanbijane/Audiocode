import { PersianTranscriptDocument, PersianTranscriptTokenRecord } from './PersianTranscriptModel';

export type OrthographyProposalCategory =
  | 'ZWNJ_VERB_PREFIX'
  | 'ZWNJ_PLURAL_OR_SUFFIX'
  | 'ZWNJ_COMPOUND'
  | 'ARABIC_TO_PERSIAN_CHAR'
  | 'COLLOQUIAL_PRESERVED_NOTICE';

export type OrthographyClassification =
  | 'GENUINE_ORTHOGRAPHY_REFINEMENT'
  | 'LEGITIMATE_COLLOQUIAL'
  | 'ALTERNATIVE_ORTHOGRAPHY'
  | 'UNCERTAIN';

export interface PersianOrthographyProposal {
  readonly proposalId: string;
  readonly tokenIds: readonly string[];
  readonly originalText: string;
  readonly proposedText: string;
  readonly category: OrthographyProposalCategory;
  readonly classification: OrthographyClassification;
  readonly linguisticRationale: string;
  readonly evidenceSource: 'PERSIAN_MORPHOLOGY_RULE';
  readonly confidenceStatus: 'STRONG_EVIDENCE' | 'MODERATE_EVIDENCE' | 'UNCERTAIN';
  readonly affectsMeaning: boolean;
  readonly alignmentRecalculationNeeded: boolean;
  readonly targetLayer: 'READABLE';
}

export interface CodeSwitchingSpan {
  readonly spanId: string;
  readonly language: 'fa' | 'en' | 'ar' | 'mixed' | 'uncertain';
  readonly tokenIds: readonly string[];
  readonly surfaceText: string;
  readonly hasPersianAffixOnEnglish: boolean;
  readonly preserveOriginalScript: true;
}

const COLLOQUIAL_VALID_FORMS = new Set([
  'می‌خوام',
  'میخوام',
  'می‌رم',
  'میرم',
  'می‌گم',
  'میگم',
  'می‌شه',
  'میشه',
  'نمی‌شه',
  'نمیشه',
  'دیگه',
  'خونه',
  'تومن',
  'واسه',
  'آره',
]);

const VERB_PREFIXES = new Set(['می', 'نمی']);
const DETACHED_SUFFIXES = new Set(['ها', 'های', 'هایی', 'تر', 'ترین', 'ام', 'ات', 'اش']);

/**
 * Contextual Persian Orthography Analyzer (AVP-P13-001 Section 4).
 * Produces explicit non-destructive proposals targeting the READABLE layer only —
 * NEVER forces formal Persian over verbatim spoken transcripts.
 */
export function analyzePersianOrthography(
  doc: PersianTranscriptDocument,
): readonly PersianOrthographyProposal[] {
  const proposals: PersianOrthographyProposal[] = [];
  let seq = 0;

  for (let i = 0; i < doc.tokens.length; i += 1) {
    const tok = doc.tokens[i];
    if (tok.language === 'en' || tok.language === 'punctuation' || tok.language === 'numeric') {
      continue;
    }

    const activeText = tok.userCorrectedText ?? tok.verbatimText;

    // 1. Arabic ي/ك character normalization proposal for readable layer
    if (/[يك]/.test(activeText)) {
      const fixed = activeText.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
      if (fixed !== activeText) {
        proposals.push({
          proposalId: `orth_${++seq}`,
          tokenIds: [tok.tokenId],
          originalText: activeText,
          proposedText: fixed,
          category: 'ARABIC_TO_PERSIAN_CHAR',
          classification: 'GENUINE_ORTHOGRAPHY_REFINEMENT',
          linguisticRationale: 'یکسان‌سازی نویسه‌های عربی (ي/ك) با معادل استاندارد فارسی (ی/ک) در لایه خوانا.',
          evidenceSource: 'PERSIAN_MORPHOLOGY_RULE',
          confidenceStatus: 'STRONG_EVIDENCE',
          affectsMeaning: false,
          alignmentRecalculationNeeded: false,
          targetLayer: 'READABLE',
        });
      }
    }

    // 2. Legitimate colloquial word detection — DO NOT rewrite automatically to formal!
    if (COLLOQUIAL_VALID_FORMS.has(activeText)) {
      continue;
    }

    // 3. Detached verb prefix «می» / «نمی» + following Persian verb token -> contextual ZWNJ proposal
    if (VERB_PREFIXES.has(activeText) && i + 1 < doc.tokens.length) {
      const next = doc.tokens[i + 1];
      const nextText = next.userCorrectedText ?? next.verbatimText;
      if (next.language === 'fa' && nextText.length >= 2 && !nextText.startsWith('\u200c')) {
        proposals.push({
          proposalId: `orth_${++seq}`,
          tokenIds: [tok.tokenId, next.tokenId],
          originalText: `${activeText} ${nextText}`,
          proposedText: `${activeText}\u200c${nextText}`,
          category: 'ZWNJ_VERB_PREFIX',
          classification: 'GENUINE_ORTHOGRAPHY_REFINEMENT',
          linguisticRationale: `اتصال پیشوند فعلی «${activeText}» با نیم‌فاصله به فعل «${nextText}» در لایه خوانا بدون تغییر متن خام.`,
          evidenceSource: 'PERSIAN_MORPHOLOGY_RULE',
          confidenceStatus: 'STRONG_EVIDENCE',
          affectsMeaning: false,
          alignmentRecalculationNeeded: true,
          targetLayer: 'READABLE',
        });
      }
    }

    // 4. Detached plural/comparative suffix «ها / تر / ترین» after Persian noun/adjective
    if (
      tok.language === 'fa' &&
      !VERB_PREFIXES.has(activeText) &&
      i + 1 < doc.tokens.length
    ) {
      const next = doc.tokens[i + 1];
      const nextText = next.userCorrectedText ?? next.verbatimText;
      if (next.language === 'fa' && DETACHED_SUFFIXES.has(nextText)) {
        proposals.push({
          proposalId: `orth_${++seq}`,
          tokenIds: [tok.tokenId, next.tokenId],
          originalText: `${activeText} ${nextText}`,
          proposedText: `${activeText}\u200c${nextText}`,
          category: 'ZWNJ_PLURAL_OR_SUFFIX',
          classification: 'ALTERNATIVE_ORTHOGRAPHY',
          linguisticRationale: `پیشنهاد نیم‌فاصله بین «${activeText}» و پسوند «${nextText}» در نمایش خوانا.`,
          evidenceSource: 'PERSIAN_MORPHOLOGY_RULE',
          confidenceStatus: 'MODERATE_EVIDENCE',
          affectsMeaning: false,
          alignmentRecalculationNeeded: true,
          targetLayer: 'READABLE',
        });
      }
    }
  }

  return proposals;
}

/**
 * Persian-English Code-Switching Analyzer (AVP-P13-001 Section 7).
 * Preserves original Latin script, product/brand names, acronyms, and Persian affixes
 * attached to English terms (e.g., «APIها», «Docker‌سازی») without translating them.
 */
export function analyzeCodeSwitchingSpans(
  tokens: readonly PersianTranscriptTokenRecord[],
): readonly CodeSwitchingSpan[] {
  const spans: CodeSwitchingSpan[] = [];
  let seq = 0;

  let currentLang: CodeSwitchingSpan['language'] | null = null;
  let bucket: PersianTranscriptTokenRecord[] = [];

  const flush = () => {
    if (!currentLang || bucket.length === 0) return;
    const text = bucket.map((t) => t.userCorrectedText ?? t.verbatimText).join(' ');
    const hasAffix = bucket.some(
      (t) =>
        t.language === 'mixed' ||
        (/[A-Za-z]/.test(t.verbatimText) && /[\u0600-\u06FF]/.test(t.verbatimText)),
    );
    spans.push({
      spanId: `langspan_${++seq}`,
      language: currentLang,
      tokenIds: bucket.map((t) => t.tokenId),
      surfaceText: text,
      hasPersianAffixOnEnglish: hasAffix,
      preserveOriginalScript: true,
    });
    bucket = [];
  };

  for (const tok of tokens) {
    if (tok.language === 'punctuation' || tok.language === 'numeric') {
      continue;
    }
    const lang: CodeSwitchingSpan['language'] =
      tok.language === 'fa' || tok.language === 'en' || tok.language === 'ar' || tok.language === 'mixed'
        ? tok.language
        : 'uncertain';

    if (currentLang !== null && currentLang !== lang) {
      flush();
    }
    currentLang = lang;
    bucket.push(tok);
  }
  flush();

  return spans;
}
