const RTL_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/g;
const LTR_CHAR_REGEX = /[A-Za-z]/g;

export function hasRtlCharacters(text: string): boolean {
  if (!text) return false;
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/.test(text);
}

/**
 * Determines base BiDi paragraph direction ('rtl' | 'ltr') by comparing strong RTL
 * (Persian/Arabic) letters against strong Latin letters so mixed Persian+English
 * technical phrases stay properly RTL while pure Latin filenames/terms render LTR.
 */
export function detectContentDirection(
  text: string,
  fallback: 'rtl' | 'ltr' = 'ltr',
): 'rtl' | 'ltr' {
  if (!text) return fallback;
  const rtlMatches = text.match(RTL_CHAR_REGEX);
  const ltrMatches = text.match(LTR_CHAR_REGEX);
  const rtlCount = rtlMatches ? rtlMatches.length : 0;
  const ltrCount = ltrMatches ? ltrMatches.length : 0;

  if (rtlCount === 0 && ltrCount === 0) {
    return fallback;
  }
  if (rtlCount === 0) {
    return 'ltr';
  }
  if (ltrCount === 0) {
    return 'rtl';
  }
  if (rtlCount > ltrCount) {
    return 'rtl';
  }
  if (ltrCount > rtlCount) {
    return 'ltr';
  }
  return fallback;
}

export function detectContentLang(text: string): 'fa' | undefined {
  return hasRtlCharacters(text) ? 'fa' : undefined;
}
