/**
 * CORE ASR ENGINE — NORMALIZATION PROFILES & CODE-SWITCHING LANGUAGE ID
 *
 * Strictly separates raw acoustic decoder output from versioned normalization:
 *   - RAW_UNMODIFIED
 *   - FA-STRICT-V1   (preserves ZWNJ/half-space & distinct punctuation rules)
 *   - FA-RELAXED-V1  (folds Arabic ي/ك, collapses ZWNJ differences for CER/WER parity check)
 *   - EN-NORM-V1     (case-folds & normalizes English punctuation/contractions)
 *   - MIXED-NORM-V1  (preserves Latin technical words inline with Persian ZWNJ normalization)
 */

import type { DetectedLanguageTag, NormalizationProfileId } from './CoreAsrContracts';

const PERSIAN_SCRIPT_RE = /[\u0600-\u06FF]/;
const LATIN_SCRIPT_RE = /[A-Za-z]/;
const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const ZWNJ = '\u200c';

const FA_COMPOUND_PREFIXES = ['می', 'نمی'];
const FA_COMPOUND_SUFFIXES = ['ها', 'های', 'هایی', 'ام', 'ات', 'اش', 'ایم', 'اید', 'اند', 'تر', 'ترین'];

/** Converts Arabic presentation / compatibility letters to standard Persian forms */
export function standardizePersianCharacters(text: string): string {
  return text
    .replace(/\u064A/g, '\u06CC') // ي -> ی
    .replace(/\u0649/g, '\u06CC') // ى -> ی
    .replace(/\u0643/g, '\u06A9') // ك -> ک
    .replace(/\u0629/g, '\u0647') // ة -> ه
    .replace(/\u06C0/g, '\u0647\u200c\u06CC')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Restores explicit Persian half-space (ZWNJ) around common prefixes/suffixes */
export function enforcePersianHalfSpaceRules(text: string): string {
  let out = text;
  for (const p of FA_COMPOUND_PREFIXES) {
    const re = new RegExp(`(^|\\s)(${p})\\s+([\\u0600-\\u06FF]{2,})`, 'g');
    out = out.replace(re, `$1$2${ZWNJ}$3`);
  }
  for (const s of FA_COMPOUND_SUFFIXES) {
    const re = new RegExp(`([\\u0600-\\u06FF]{2,})\\s+(${s})(?=\\s|$|[،.!؟؛:])`, 'g');
    out = out.replace(re, `$1${ZWNJ}$2`);
  }
  return out;
}

export function normalizeWithProfile(rawText: string, profile: NormalizationProfileId): string {
  if (profile === 'RAW_UNMODIFIED') {
    return rawText;
  }

  const collapsed = rawText.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';

  if (profile === 'FA-STRICT-V1') {
    const std = standardizePersianCharacters(collapsed).replace(ARABIC_DIACRITICS_RE, '');
    const withZwnj = enforcePersianHalfSpaceRules(std);
    return withZwnj.replace(/[،؛؟!.,:;?]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (profile === 'FA-RELAXED-V1') {
    const std = standardizePersianCharacters(collapsed)
      .replace(ARABIC_DIACRITICS_RE, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/\u200c+/g, ' ');
    return std.replace(/[،؛؟!.,:;?«»"'()-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (profile === 'EN-NORM-V1') {
    return collapsed
      .toLowerCase()
      .replace(/['’]re\b/g, ' are')
      .replace(/['’]ve\b/g, ' have')
      .replace(/n['’]t\b/g, ' not')
      .replace(/[.,!?;:"'()\[\]{}]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // MIXED-NORM-V1: keep Latin tokens intact (lower-cased) while normalizing Persian tokens with ZWNJ
  const stdMixed = standardizePersianCharacters(collapsed).replace(ARABIC_DIACRITICS_RE, '');
  const withZwnj = enforcePersianHalfSpaceRules(stdMixed);
  return withZwnj
    .split(/\s+/)
    .map((tok) => {
      const cleaned = tok.replace(/^[،؛؟!.,:;"'()«»]+|[،؛؟!.,:;"'()«»]+$/g, '');
      if (!cleaned) return '';
      if (LATIN_SCRIPT_RE.test(cleaned) && !PERSIAN_SCRIPT_RE.test(cleaned)) {
        return cleaned.toLowerCase();
      }
      return cleaned;
    })
    .filter(Boolean)
    .join(' ');
}

export function buildAllNormalizationProfiles(rawText: string): Record<NormalizationProfileId, string> {
  return {
    RAW_UNMODIFIED: normalizeWithProfile(rawText, 'RAW_UNMODIFIED'),
    'FA-STRICT-V1': normalizeWithProfile(rawText, 'FA-STRICT-V1'),
    'FA-RELAXED-V1': normalizeWithProfile(rawText, 'FA-RELAXED-V1'),
    'EN-NORM-V1': normalizeWithProfile(rawText, 'EN-NORM-V1'),
    'MIXED-NORM-V1': normalizeWithProfile(rawText, 'MIXED-NORM-V1'),
  };
}

/**
 * Classifies language script truthfully at token and utterance level.
 * Never forces code-switched ('fa-en') phrases into mono-script labels.
 */
export function detectTextLanguageTag(text: string): {
  language: DetectedLanguageTag;
  persianTokens: number;
  englishTokens: number;
  mixedTokens: number;
  uncertainTokens: number;
} {
  const tokens = text
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[،؛؟!.,:;"'()«»\d]/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) {
    return {
      language: 'unknown',
      persianTokens: 0,
      englishTokens: 0,
      mixedTokens: 0,
      uncertainTokens: 0,
    };
  }

  let persianTokens = 0;
  let englishTokens = 0;
  let mixedTokens = 0;
  let uncertainTokens = 0;

  for (const tok of tokens) {
    const hasFa = PERSIAN_SCRIPT_RE.test(tok);
    const hasEn = LATIN_SCRIPT_RE.test(tok);
    if (hasFa && hasEn) mixedTokens++;
    else if (hasFa) persianTokens++;
    else if (hasEn) englishTokens++;
    else uncertainTokens++;
  }

  let language: DetectedLanguageTag = 'unknown';
  if ((persianTokens > 0 && englishTokens > 0) || mixedTokens > 0) {
    language = 'fa-en';
  } else if (persianTokens > 0 && englishTokens === 0) {
    language = 'fa';
  } else if (englishTokens > 0 && persianTokens === 0) {
    language = 'en';
  } else if (uncertainTokens > 0) {
    language = 'uncertain';
  }

  return {
    language,
    persianTokens,
    englishTokens,
    mixedTokens,
    uncertainTokens,
  };
}
