import { PersianTranscriptDocument } from './PersianTranscriptModel';

export type PunctuationEvidenceKind = 'PROSODIC_PAUSE' | 'GRAMMATICAL_CUE' | 'COMBINED';

export interface PersianPunctuationProposal {
  readonly proposalId: string;
  readonly afterTokenId: string;
  readonly proposedMark: '،' | '.' | '؟' | '!' | '؛' | ':';
  readonly evidenceKind: PunctuationEvidenceKind;
  readonly pauseDurationMs: number | null;
  readonly confidenceStatus: 'MODERATE_EVIDENCE' | 'WEAK_EVIDENCE' | 'AMBIGUOUS';
  readonly rationale: string;
  readonly affectsMeaningRisk: boolean;
  readonly preservesConfirmedPunctuation: true;
  readonly alignmentImpact: 'NONE';
}

export interface SpokenNumberExpressionProposal {
  readonly proposalId: string;
  readonly tokenIds: readonly string[];
  readonly originalSpokenText: string;
  readonly formattedDisplayValue: string | null;
  readonly parsedNumericValue: number | null;
  readonly unit: string | null;
  readonly category: 'CARDINAL' | 'CURRENCY' | 'PERCENTAGE' | 'TIME_OR_DATE' | 'AMBIGUOUS_SEQUENCE';
  readonly status: 'PARSEABLE_DISPLAY_PROPOSAL' | 'AMBIGUOUS_DO_NOT_CONVERT';
  readonly rationale: string;
}

const QUESTION_MARKERS = new Set(['آیا', 'چرا', 'چطور', 'چگونه', 'کجا', 'کی', 'چقدر', 'کدام', 'چی']);
const EXISTING_PUNCT_RE = /^[،؛؟.!:,;«»]+$/;

/**
 * Verbatim-Preserving Persian Punctuation Analyzer (AVP-P13-001 Section 5).
 * - Never overwrites human-confirmed punctuation.
 * - Explicitly separates pause-based evidence from grammatical inference.
 * - Does not treat every pause as a sentence boundary.
 */
export function analyzePersianPunctuationProposals(
  doc: PersianTranscriptDocument,
): readonly PersianPunctuationProposal[] {
  const proposals: PersianPunctuationProposal[] = [];
  let seq = 0;

  let sentenceHasQuestionCue = false;
  let sentenceTokenCount = 0;

  for (let i = 0; i < doc.tokens.length; i += 1) {
    const tok = doc.tokens[i];
    const text = tok.userCorrectedText ?? tok.verbatimText;

    if (tok.language === 'punctuation' || EXISTING_PUNCT_RE.test(text)) {
      sentenceHasQuestionCue = false;
      sentenceTokenCount = 0;
      continue;
    }

    sentenceTokenCount += 1;
    if (QUESTION_MARKERS.has(tok.normalizedText)) {
      sentenceHasQuestionCue = true;
    }

    const next = doc.tokens[i + 1];
    // Never propose punctuation if human/existing punctuation already follows
    if (next && (next.language === 'punctuation' || EXISTING_PUNCT_RE.test(next.verbatimText))) {
      continue;
    }

    let pauseMs: number | null = null;
    if (
      tok.sourceEndSample !== null &&
      next?.sourceStartSample !== null &&
      next?.sourceStartSample !== undefined &&
      tok.sampleRate > 0
    ) {
      const gapSamples = next.sourceStartSample - tok.sourceEndSample;
      if (gapSamples > 0) {
        pauseMs = Math.round((gapSamples / tok.sampleRate) * 1000);
      }
    }

    const isEndOfTranscript = i === doc.tokens.length - 1;

    // Sentence boundary proposal: requires substantial pause (>= 750ms) OR end of utterance with >= 3 tokens
    if ((pauseMs !== null && pauseMs >= 750 && sentenceTokenCount >= 3) || (isEndOfTranscript && sentenceTokenCount >= 3)) {
      const mark: '.' | '؟' = sentenceHasQuestionCue ? '؟' : '.';
      const evidenceKind: PunctuationEvidenceKind =
        pauseMs !== null && sentenceHasQuestionCue
          ? 'COMBINED'
          : pauseMs !== null
            ? 'PROSODIC_PAUSE'
            : 'GRAMMATICAL_CUE';

      proposals.push({
        proposalId: `punct_${++seq}`,
        afterTokenId: tok.tokenId,
        proposedMark: mark,
        evidenceKind,
        pauseDurationMs: pauseMs,
        confidenceStatus: evidenceKind === 'COMBINED' ? 'MODERATE_EVIDENCE' : 'WEAK_EVIDENCE',
        rationale:
          mark === '؟'
            ? 'نشانه پرسشی در جمله و مکث/پایان عبارت مشاهده شد (استنباط نگارشی، نه قطعیت قصد گوینده).'
            : 'مکث طولانی یا پایان عبارت شناسایی شد؛ پیشنهاد نقطه در لایه خوانا بدون تغییر واژگان.',
        affectsMeaningRisk: mark === '؟',
        preservesConfirmedPunctuation: true,
        alignmentImpact: 'NONE',
      });
      sentenceHasQuestionCue = false;
      sentenceTokenCount = 0;
    } else if (pauseMs !== null && pauseMs >= 380 && pauseMs < 750 && sentenceTokenCount >= 2) {
      proposals.push({
        proposalId: `punct_${++seq}`,
        afterTokenId: tok.tokenId,
        proposedMark: '،',
        evidenceKind: 'PROSODIC_PAUSE',
        pauseDurationMs: pauseMs,
        confidenceStatus: 'WEAK_EVIDENCE',
        rationale: `مکث میانی (${pauseMs}ms) مشاهده شد؛ پیشنهاد ویرگول اختیاری در لایه خوانا.`,
        affectsMeaningRisk: false,
        preservesConfirmedPunctuation: true,
        alignmentImpact: 'NONE',
      });
    }
  }

  return proposals;
}

const PERSIAN_NUMBER_WORDS: Readonly<Record<string, number>> = {
  صفر: 0,
  یک: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  شیش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
  یازده: 11,
  دوازده: 12,
  سیزده: 13,
  چهارده: 14,
  پانزده: 15,
  شانزده: 16,
  هفده: 17,
  هجده: 18,
  نوزده: 19,
  بیست: 20,
  سی: 30,
  چهل: 40,
  پنجاه: 50,
  شصت: 60,
  هفتاد: 70,
  هشتاد: 80,
  نود: 90,
  صد: 100,
  دویست: 200,
  سیصد: 300,
  چهارصد: 400,
  پانصد: 500,
  هزار: 1000,
  میلیون: 1_000_000,
  میلیارد: 1_000_000_000,
};

const UNIT_WORDS = new Set(['تومان', 'تومن', 'ریال', 'دلار', 'یورو', 'درصد', 'کیلومتر', 'متر', 'ثانیه', 'دقیقه', 'ساعت']);

function toPersianDigits(num: number): string {
  return num
    .toLocaleString('en-US')
    .replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
}

/**
 * Spoken Persian Number & Currency Expression Analyzer (AVP-P13-001 Section 8).
 * Keeps original spoken wording strictly intact; detects ambiguous digit sequences (e.g. phone-like
 * sequences «سه دو پنج چهار») and refuses automatic conversion.
 */
export function analyzePersianSpokenNumbers(
  doc: PersianTranscriptDocument,
): readonly SpokenNumberExpressionProposal[] {
  const proposals: SpokenNumberExpressionProposal[] = [];
  let seq = 0;

  let i = 0;
  while (i < doc.tokens.length) {
    const startTok = doc.tokens[i];
    const startVal = PERSIAN_NUMBER_WORDS[startTok.normalizedText];
    if (startVal === undefined) {
      i += 1;
      continue;
    }

    const runIndices: number[] = [i];
    let j = i + 1;
    while (j < doc.tokens.length) {
      const next = doc.tokens[j];
      if (next.normalizedText === 'و' && j + 1 < doc.tokens.length && PERSIAN_NUMBER_WORDS[doc.tokens[j + 1].normalizedText] !== undefined) {
        runIndices.push(j, j + 1);
        j += 2;
      } else if (PERSIAN_NUMBER_WORDS[next.normalizedText] !== undefined) {
        runIndices.push(j);
        j += 1;
      } else {
        break;
      }
    }

    const numberTokens = runIndices.map((idx) => doc.tokens[idx]);
    const numericWords = numberTokens
      .filter((t) => t.normalizedText !== 'و')
      .map((t) => PERSIAN_NUMBER_WORDS[t.normalizedText]);

    // Check optional trailing unit/currency
    let unit: string | null = null;
    if (j < doc.tokens.length && UNIT_WORDS.has(doc.tokens[j].normalizedText)) {
      unit = doc.tokens[j].userCorrectedText ?? doc.tokens[j].verbatimText;
      runIndices.push(j);
      j += 1;
    }

    const allTokens = runIndices.map((idx) => doc.tokens[idx]);
    const originalSpokenText = allTokens.map((t) => t.userCorrectedText ?? t.verbatimText).join(' ');

    // Ambiguity detection: >= 3 small single-digit words spoken consecutively without conjunction or multiplier
    // (e.g. telephone / code sequence «دو پنج هشت یک») -> NEVER auto-sum or silently convert!
    const hasConjunctionOrMultiplier =
      numberTokens.some((t) => t.normalizedText === 'و') ||
      numericWords.some((v) => v >= 100);
    const isAmbiguousDigitSequence =
      numericWords.length >= 3 &&
      !hasConjunctionOrMultiplier &&
      numericWords.every((v) => v >= 0 && v <= 9);

    if (isAmbiguousDigitSequence) {
      proposals.push({
        proposalId: `num_${++seq}`,
        tokenIds: allTokens.map((t) => t.tokenId),
        originalSpokenText,
        formattedDisplayValue: null,
        parsedNumericValue: null,
        unit,
        category: 'AMBIGUOUS_SEQUENCE',
        status: 'AMBIGUOUS_DO_NOT_CONVERT',
        rationale:
          'توالی چند رقم گفتاری بدون پیوند عددی (احتمال شماره تلفن یا کد)؛ تبدیل خودکار متوقف شد و متن گفتاری حفظ گردید.',
      });
      i = j;
      continue;
    }

    // Deterministic hierarchical Persian number accumulation
    let total = 0;
    let currentGroup = 0;
    for (const val of numericWords) {
      if (val >= 1000) {
        currentGroup = (currentGroup === 0 ? 1 : currentGroup) * val;
        total += currentGroup;
        currentGroup = 0;
      } else {
        currentGroup += val;
      }
    }
    total += currentGroup;

    const category: SpokenNumberExpressionProposal['category'] =
      unit === 'تومان' || unit === 'تومن' || unit === 'ریال' || unit === 'دلار' || unit === 'یورو'
        ? 'CURRENCY'
        : unit === 'درصد'
          ? 'PERCENTAGE'
          : 'CARDINAL';

    proposals.push({
      proposalId: `num_${++seq}`,
      tokenIds: allTokens.map((t) => t.tokenId),
      originalSpokenText,
      formattedDisplayValue: unit ? `${toPersianDigits(total)} ${unit}` : toPersianDigits(total),
      parsedNumericValue: total,
      unit,
      category,
      status: 'PARSEABLE_DISPLAY_PROPOSAL',
      rationale:
        'پیشنهاد نمایش عددی در لایه خوانا؛ صورت گفتاری اصلی در لایه Verbatim به‌طور کامل حفظ می‌شود.',
    });

    i = j;
  }

  return proposals;
}
