/**
 * SHAHAB SHARED CORE — Single-Pass Persian Display Normalizer (SHB-F08)
 *
 * Host-independent, zero-dependency Persian transcript post-processor:
 * - Converts Arabic compatibility glyphs (`ي`/`ى` -> `ی`, `ك` -> `ک`, `ة` -> `ه`, `ۀ` -> `ه\u200cی`).
 * - Strips transient Arabic harakat/tashkeel marks.
 * - Preserves Persian digits (`۰-۹`) and Latin technical acronyms without case destruction.
 * - Applies single-pass exception-aware Persian ZWNJ (نیم‌فاصله) rules ported from upstream
 *   `PersianPostProcessor` (`transcribe.py`):
 *     - Protects `non_verbs_mi` nouns (`میوه`, `میراث`, `میزان`, `میهن`, `میلاد`, `میز`, `میدان`, ...)
 *     - Preserves colloquial verbs (`میاد`, `میام`, `میان`, `نمیاد`, `نمیام`, `نمیان`)
 *     - Applies ZWNJ on verb prefixes (`می`/`نمی`), plural suffixes (`ها`/`های`...),
 *       silent-h suffixes (`خانه\u200cای`, `بزرگ\u200cتر`), while protecting `انتهای`/`اشتهای`/`منتهای`/`روستای`.
 * - Separates evaluation scoring normalization (`normalizePersianForEvaluation`) from display output.
 */

const ZWNJ = '\u200c';
const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const PERSIAN_LETTER_CLASS = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';

const NON_VERBS_MI = new Set<string>([
  'میوه',
  'میوه‌ها',
  'میوه‌های',
  'میراث',
  'میزان',
  'میخ',
  'میهن',
  'میلاد',
  'میز',
  'میدان',
  'میدان‌ها',
  'میکروب',
  'میلیون',
  'میلیارد',
  'مینو',
  'میگون',
  'میثم',
  'میعاد',
  'میش',
  'میخانه',
  'مینا',
  'میبد',
  'مینی',
  'نمیم',
  'نمین',
  'میثاق',
  'میکروسکوپ',
  'میلی‌متر',
  'میلی‌گرم',
  'میلی‌ثانیه',
  'می‌گرن', // handled cleanly if pre-segmented
  'میگرن',
  'میخانه',
  'میترا',
  'میدانی',
  'میزبانی',
  'میزبان',
]);

const SPLIT_MI_PROTECTED_STEMS = new Set<string>([
  'ان',
  'وه',
  'ز',
  'هن',
  'راث',
  'لاد',
  'خ',
]);

const COLLOQUIAL_AMADAN_STEMS = new Set<string>(['ام', 'ای', 'اد', 'ایم', 'ان']);

const PROTECTED_SILENT_H_WORDS = new Set<string>([
  'انتهای',
  'اشتهای',
  'منتهای',
  'روستای',
  'کوتاه',
  'پادشاه',
  'همراه',
]);

const MI_SPACE_RE = new RegExp(
  `(^|\\s)(ن?می)\\s+([${PERSIAN_LETTER_CLASS}]{2,})(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const MI_ATTACHED_RE = new RegExp(
  `(^|\\s)(ن?می)([${PERSIAN_LETTER_CLASS}]{2,})(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const HA_ATTACHED_RE = new RegExp(
  `([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)(های(?:م|ت|ش|مان|تان|شان|ی)?|ها)(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const HA_SPACE_RE = new RegExp(
  `([${PERSIAN_LETTER_CLASS}]+)\\s+(های(?:م|ت|ش|مان|تان|شان|ی)?|ها)(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const SILENT_H_SUFFIX_RE = new RegExp(
  `([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)(ای|ام|ات|اش|اید|اند|ی)(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const SILENT_H_SPACE_SUFFIX_RE = new RegExp(
  `([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)\\s+(ای|ام|ات|اش|اید|اند)(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const TAR_ATTACHED_RE = new RegExp(
  `([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)(تر|ترین)(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const TAR_SPACE_RE = new RegExp(
  `([${PERSIAN_LETTER_CLASS}]{2,})\\s+(تر|ترین)(?=$|\\s|[،؛؟!.,:;?«»"'()])`,
  'g',
);

const COMMON_COMPOUND_SPACE_RE = /(^|\s)(نرم|سخت)\s+(افزار(?:ی|ها|های)?)(?=$|\s|[،؛؟!.,:;?])/g;

/**
 * Standardizes Arabic-script presentation forms to canonical Persian Unicode
 * while preserving Persian digits (`۰-۹`) and Latin case.
 */
export function standardizePersianDisplayCharacters(text: string): string {
  return text
    .replace(/\u064A/g, '\u06CC') // ي -> ی
    .replace(/\u0649/g, '\u06CC') // ى -> ی
    .replace(/\u0643/g, '\u06A9') // ك -> ک
    .replace(/\u0629/g, '\u0647') // ة -> ه
    .replace(/\u06C0/g, `\u0647${ZWNJ}\u06CC`) // ۀ -> ه‌ی
    .replace(/\u0640/g, '') // tatweel / kashida
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(0x06f0 + (d.charCodeAt(0) - 0x0660)));
}

/**
 * Single authoritative Persian utterance display normalizer (SHB-F08).
 * Replaces previous double-chained `normalizePersianTextDeterministic` + `MIXED-NORM-V1`
 * so Persian digits (`۰-۹`), non-verb `می` nouns (`میوه`, `میراث`), colloquial forms (`میاد`),
 * silent-h exceptions (`انتهای`, `روستای`), and Latin casing remain intact in one pass.
 */
export function normalizeCanonicalPersianUtterance(rawText: string): string {
  const collapsed = rawText.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';

  let out = standardizePersianDisplayCharacters(collapsed);

  // 1. Attached `می` / `نمی` prefixes (with non-verb and colloquial protection)
  out = out.replace(MI_ATTACHED_RE, (full, lead: string, prefix: string, stem: string) => {
    const word = `${prefix}${stem}`;
    if (NON_VERBS_MI.has(word) || NON_VERBS_MI.has(stem)) {
      return full;
    }
    if (COLLOQUIAL_AMADAN_STEMS.has(stem)) {
      return full;
    }
    let normalizedStem = stem;
    if (stem.startsWith('آمد') || stem.startsWith('آید')) {
      // Keep canonical alef-madda
    } else if (stem.startsWith('امد')) {
      normalizedStem = `آمد${stem.slice(3)}`;
    } else if (stem.startsWith('اید')) {
      normalizedStem = `آید${stem.slice(3)}`;
    }
    return `${lead}${prefix}${ZWNJ}${normalizedStem}`;
  });

  // 2. Spaced `می` / `نمی` prefixes (`می شود` -> `می‌شود`, `می اد` -> `میاد`)
  out = out.replace(MI_SPACE_RE, (full, lead: string, prefix: string, stem: string) => {
    if (SPLIT_MI_PROTECTED_STEMS.has(stem) || NON_VERBS_MI.has(`${prefix}${stem}`)) {
      return full;
    }
    if (COLLOQUIAL_AMADAN_STEMS.has(stem)) {
      return `${lead}${prefix}${stem}`;
    }
    let normalizedStem = stem;
    if (stem === 'امد') normalizedStem = 'آمد';
    else if (stem === 'اید') normalizedStem = 'آید';
    return `${lead}${prefix}${ZWNJ}${normalizedStem}`;
  });

  // 3. Plural `ها` / `های*` suffixes (attached after silent-h or space-separated)
  out = out.replace(HA_ATTACHED_RE, `$1${ZWNJ}$2`);
  out = out.replace(HA_SPACE_RE, `$1${ZWNJ}$2`);

  // 3.1. Canonicalize a small, curated set of technical compounds.
  out = out.replace(COMMON_COMPOUND_SPACE_RE, (_full, lead: string, first: string, second: string) =>
    `${lead}${first}${ZWNJ}${second}`,
  );

  // 4. Silent-`ه` inflection suffixes (`خانه‌ای`, `نامه‌ام`), protecting `انتهای`/`اشتهای`/`روستای`
  out = out.replace(SILENT_H_SUFFIX_RE, (full, stem: string, suffix: string) => {
    if (
      full.endsWith('تهای') ||
      full.endsWith('شتهای') ||
      full.endsWith('ستای') ||
      PROTECTED_SILENT_H_WORDS.has(full)
    ) {
      return full;
    }
    return `${stem}${ZWNJ}${suffix}`;
  });
  out = out.replace(SILENT_H_SPACE_SUFFIX_RE, `$1${ZWNJ}$2`);

  // 5. Comparative/superlative `تر` / `ترین`
  out = out.replace(TAR_ATTACHED_RE, `$1${ZWNJ}$2`);
  out = out.replace(TAR_SPACE_RE, (full, base: string, suffix: string) => {
    if (base === 'به' || base === 'بیش' || base === 'کم') {
      // `بهتر`/`بهترین` etc. in compound spacing: leave `به تر` normalized cleanly with ZWNJ only after silent-h if needed
      return `${base}${ZWNJ}${suffix}`;
    }
    return `${base}${ZWNJ}${suffix}`;
  });

  // 6. Clean redundant ZWNJs and normalize whitespace around ZWNJ
  out = out
    .replace(/\u200c+/g, ZWNJ)
    .replace(/\s*\u200c\s*/g, ZWNJ)
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

/**
 * Separate normalization helper strictly for WER/CER evaluation benchmarks
 * (never used as display output).
 */
export function normalizePersianForEvaluation(
  text: string,
  mode: 'STRICT' | 'RELAXED' = 'STRICT',
): string {
  const display = normalizeCanonicalPersianUtterance(text)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (mode === 'RELAXED') {
    return display
      .replace(/[أإآ]/g, 'ا')
      .replace(/\u200c+/g, ' ')
      .replace(/[،؛؟!.,:;?«»"'()[\]-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  return display
    .replace(/[،؛؟!.,:;?«»"'()[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
