import { Flicks, TimeRange } from '../contracts/timebase.contract';
import { normalizePersianText } from '../engine/persianText';

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
}

export const PersianTextNormalizer = {
  normalize(originalText: string) {
    return normalizePersianText(originalText);
  },

  normalizeTokenText(rawText: string): string {
    return normalizePersianText(rawText).normalized;
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
  }): TimedPersianToken {
    const res = normalizePersianText(params.originalText);
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
    };
  },

  buildThreeLayerTranscript(
    rawTokens: { id: string; text: string; range: TimeRange; confidence: number }[],
    targetTrackId = 'track-1',
  ): TimedPersianToken[] {
    return rawTokens.map((raw) => {
      const res = normalizePersianText(raw.text);
      return {
        tokenId: raw.id,
        trackId: targetTrackId,
        originalText: res.original,
        normalizedText: res.normalized,
        displayText: res.display,
        range: raw.range,
        confidence: raw.confidence,
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
