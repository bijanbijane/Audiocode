import { Flicks, TimeRange } from '../contracts/timebase.contract';
import { normalizePersianText } from '../engine/persianText';

export type TokenAlignmentPrecision =
  | 'forced_aligned'
  | 'ctc_frame_aligned'
  | 'model_timestamps'
  | 'distributed_segment'
  | 'segment_only'
  | 'missing';

/**
 * 3-Layer Timed Persian Word Token (Architecture Doc Section 27)
 * Preserves immutable ASR originalText alongside normalized & display forms.
 */
export interface TimedPersianToken {
  readonly tokenId: string;
  readonly trackId: string;
  readonly originalText: string;
  readonly normalizedText: string;
  readonly displayText: string;
  readonly range: TimeRange;
  readonly confidence: number;
  readonly isDisfluency?: boolean;
  readonly hasTrailingEzafeRisk?: boolean;
  readonly alignmentPrecision?: TokenAlignmentPrecision;
  readonly timingValid?: boolean;
}

const PERSIAN_TO_ASCII_DIGITS: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

export const PersianTextNormalizer = {
  normalize(originalText: string) {
    return normalizePersianText(originalText);
  },

  normalizeTokenText(rawText: string): string {
    return normalizePersianText(rawText).normalized;
  },

  /**
   * Produces a non-destructive comparison string unifying Persian/Arabic orthography,
   * numerals (Persian/Arabic-Indic/Latin), ZWNJ, diacritics, and surrounding punctuation.
   * NEVER used to overwrite originalText or displayText.
   */
  toCanonicalComparisonForm(rawText: string): string {
    const norm = normalizePersianText(rawText).normalized;
    return norm
      .replace(/[۰-۹٠-٩]/g, (ch) => PERSIAN_TO_ASCII_DIGITS[ch] ?? ch)
      .replace(/[\u064B-\u0652\u0670\u0640\u200c]/g, '')
      .replace(/[،؛.!؟«»()[\]{}…:,;\-–—"'`]/g, '')
      .replace(/\s+/g, '')
      .trim();
  },

  createToken(params: {
    tokenId: string;
    trackId: string;
    originalText: string;
    startFlicks: Flicks;
    endFlicks: Flicks;
    confidence: number;
    isDisfluency?: boolean;
    hasTrailingEzafeRisk?: boolean;
    alignmentPrecision?: TokenAlignmentPrecision;
    timingValid?: boolean;
  }): TimedPersianToken {
    const res = normalizePersianText(params.originalText);
    const hasValidTiming =
      params.timingValid ??
      (Number.isFinite(params.startFlicks) &&
        Number.isFinite(params.endFlicks) &&
        params.startFlicks >= 0 &&
        params.endFlicks > params.startFlicks);
    return {
      tokenId: params.tokenId,
      trackId: params.trackId,
      originalText: res.original,
      normalizedText: res.normalized,
      displayText: res.display,
      range: { start: params.startFlicks, end: params.endFlicks },
      confidence: params.confidence,
      isDisfluency: params.isDisfluency,
      hasTrailingEzafeRisk: params.hasTrailingEzafeRisk,
      alignmentPrecision: params.alignmentPrecision,
      timingValid: hasValidTiming,
    };
  },

  buildThreeLayerTranscript(
    rawTokens: { id: string; text: string; range: TimeRange; confidence: number }[],
    targetTrackId = 'track-1',
  ): TimedPersianToken[] {
    return rawTokens.map((raw) => {
      const res = normalizePersianText(raw.text);
      const hasValidTiming =
        Number.isFinite(raw.range.start) &&
        Number.isFinite(raw.range.end) &&
        raw.range.start >= 0 &&
        raw.range.end > raw.range.start;
      return {
        tokenId: raw.id,
        trackId: targetTrackId,
        originalText: res.original,
        normalizedText: res.normalized,
        displayText: res.display,
        range: raw.range,
        confidence: raw.confidence,
        timingValid: hasValidTiming,
      };
    });
  },

  /** Preserves raw model-generated word strings verbatim without post-hoc rewriting. */
  extractRawTranscript(tokens: readonly TimedPersianToken[]): string {
    return tokens
      .map((t) => t.originalText.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  },

  /** Extracts normalized display text separately from raw model output. */
  extractNormalizedTranscript(tokens: readonly TimedPersianToken[]): string {
    return tokens
      .map((t) => t.displayText.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  },
} as const;

export function normalizePersianTranscript(
  rawText: string,
  mode: 'display' | 'normalized' | 'original' = 'display',
): string {
  const res = normalizePersianText(rawText);
  if (mode === 'original') return res.original;
  if (mode === 'normalized') return res.normalized;
  return res.display;
}
