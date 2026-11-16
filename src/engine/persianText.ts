import { PersianWordToken } from '../contracts/v1_2';

/**
 * 3-Layer Persian Text Normalization (Section 27 of Spec v1.2)
 * Keeps Original Transcript untouched while producing Normalized & Display forms
 * and flagging potential Trailing Ezafe (کسره اضافه) risk before deleted modifiers.
 */

export interface NormalizedPersianResult {
  original: string;
  normalized: string;
  display: string;
}

const ARABIC_TO_PERSIAN_CHARS: Record<string, string> = {
  '\u064a': '\u06cc', // ي -> ی
  '\u0649': '\u06cc', // ى -> ی
  '\u0643': '\u06a9', // ك -> ک
  '\u0629': '\u0647', // ة -> ه
  '\u0623': '\u0627', // أ -> ا
  '\u0625': '\u0627', // إ -> ا
};

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function toPersianDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

export function normalizePersianText(original: string): NormalizedPersianResult {
  let normalized = original;

  // 1. Arabic Yeh/Kaf unification
  normalized = normalized.replace(/[\u064a\u0649\u0643\u0629\u0623\u0625]/g, (ch) => {
    return ARABIC_TO_PERSIAN_CHARS[ch] ?? ch;
  });

  // 2. ZWNJ (نیم‌فاصله) standardization for common Persian prefixes/suffixes
  // Note: JS \b only matches ASCII word chars, so we use explicit Unicode whitespace/punctuation boundaries.
  normalized = normalized
    .replace(/(^|[\s،؛.!؟«»()[\]])(می|نمی)\s+(?=[^\s،؛.!؟«»()[\]])/g, '$1$2\u200c')
    .replace(/([^\s\u200c،؛.!؟«»()[\]])\s+(ها|های|هایم|هایت|هایش|تر|ترین|ام|ات|اش)(?=$|[\s،؛.!؟«»()[\]])/g, '$1\u200c$2')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. Display form converts Latin digits to Persian numerals for clean editorial reading
  const display = toPersianDigits(normalized);

  return {
    original,
    normalized,
    display,
  };
}

/**
 * Checks if deleting token[targetIndex] risks exposing a dangling Ezafe («ـِ»)
 * on the preceding noun/headword token[targetIndex - 1].
 */
export function assessTrailingEzafeRisk(
  tokens: PersianWordToken[],
  targetIndex: number,
): { hasRisk: boolean; headword?: string } {
  if (targetIndex <= 0 || targetIndex >= tokens.length) {
    return { hasRisk: false };
  }
  const prev = tokens[targetIndex - 1];
  const curr = tokens[targetIndex];
  if (prev.trackId !== curr.trackId) {
    return { hasRisk: false };
  }

  // Gap between headword and modifier < 120ms implies co-articulated Ezafe linkage
  const gapFlicks = curr.range.startFlicks - prev.range.endFlicks;
  const maxEzafeGapFlicks = 705_600_000 * 0.12;
  if (gapFlicks > maxEzafeGapFlicks) {
    return { hasRisk: false };
  }

  const head = normalizePersianText(prev.originalText).normalized;
  // Heuristic: non-punctuation Persian nouns/adjectives ending in consonant or silent ه often carry spoken Ezafe -e/-ye
  const nonHeadWords = new Set(['و', 'یا', 'که', 'به', 'از', 'در', 'با', 'برای', 'تا', 'اما', 'ولی']);
  if (nonHeadWords.has(head) || prev.isDisfluency) {
    return { hasRisk: false };
  }

  return {
    hasRisk: Boolean(prev.hasTrailingEzafeRisk || head.length >= 2),
    headword: prev.displayText,
  };
}
