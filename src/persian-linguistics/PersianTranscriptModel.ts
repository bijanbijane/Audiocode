/**
 * Canonical Multi-Layer Persian Transcript Representation & Safe Unicode Normalization
 * (AVP-P13-001 Sections 1, 2 & 12)
 * Maintains 5 strictly separate representations:
 *   1. rawAsr       — exact immutable ASR output as received
 *   2. verbatim     — faithful spoken wording (human-confirmed or raw ASR)
 *   3. normalized   — derived deterministic machine-matching form
 *   4. readable     — optional explicitly controlled presentation form
 *   5. userCorrected — explicit human corrections that ALWAYS take precedence
 */

export const PERSIAN_NORMALIZER_VERSION = '13.0.0-avp-p13' as const;

export type TranscriptLayerKind =
  | 'RAW_ASR'
  | 'VERBATIM'
  | 'NORMALIZED'
  | 'READABLE'
  | 'USER_CORRECTED';

export type EpistemicSourceCategory =
  | 'DIRECTLY_OBSERVED_TRANSCRIPT'
  | 'MODEL_GENERATED_RECOGNITION'
  | 'DETERMINISTIC_NORMALIZATION'
  | 'RULE_BASED_LINGUISTIC_INFERENCE'
  | 'MODEL_GENERATED_SUGGESTION'
  | 'HUMAN_CORRECTION'
  | 'UNKNOWN_OR_UNSUPPORTED';

export interface NormalizationStepRecord {
  readonly ruleId: string;
  readonly description: string;
  readonly replacementCount: number;
}

export interface SafeUnicodeNormalizationResult {
  readonly normalizerVersion: typeof PERSIAN_NORMALIZER_VERSION;
  readonly originalText: string;
  readonly normalizedText: string;
  readonly appliedSteps: readonly NormalizationStepRecord[];
  readonly reversibleHint: boolean;
}

/**
 * Deterministic, non-destructive Persian Unicode normalizer.
 * Preserves URLs, emails, and Latin technical spans untouched; preserves contextual ZWNJ.
 * NEVER mutates the caller's verbatim or raw ASR string.
 */
export function normalizePersianSafely(originalText: string): SafeUnicodeNormalizationResult {
  const appliedSteps: NormalizationStepRecord[] = [];
  // Protect URLs, emails, and pure Latin technical tokens from Persian character/digit rewriting
  const protectedTokens: string[] = [];
  const masked = originalText.replace(
    /(?:https?:\/\/[^\s]+|[\w.+-]+@[\w-]+\.[\w.-]+|[A-Za-z][A-Za-z0-9_./:-]*)/g,
    (match) => {
      const idx = protectedTokens.push(match) - 1;
      return `\uE000${idx}\uE001`;
    },
  );

  let working = masked.normalize('NFC');

  const applyStep = (ruleId: string, description: string, regex: RegExp, replacement: string) => {
    let count = 0;
    working = working.replace(regex, () => {
      count += 1;
      return replacement;
    });
    if (count > 0) {
      appliedSteps.push({ ruleId, description, replacementCount: count });
    }
  };

  applyStep('ARABIC_YEH_TO_PERSIAN', 'Unify Arabic ي/ى to Persian ی', /[يى]/g, 'ی');
  applyStep('ARABIC_KAF_TO_PERSIAN', 'Unify Arabic ك to Persian ک', /ك/g, 'ک');
  applyStep('HEH_YEH_DECOMPOSE', 'Normalize ۀ to ه‌ی', /ۀ/g, 'ه\u200cی');
  applyStep('STRIP_OPTIONAL_DIACRITICS', 'Remove optional Arabic diacritics for matching layer', /[\u064b-\u065f\u0670\u0640]/g, '');
  applyStep('COLLAPSE_ZWNJ_RUNS', 'Collapse consecutive ZWNJ characters to single ZWNJ', /\u200c{2,}/g, '\u200c');
  applyStep('STRIP_NON_MEANINGFUL_ZW', 'Strip invisible zero-width joiner/marks except ZWNJ', /[\u200d\u200e\u200f\ufeff]/g, '');
  applyStep('NBSP_TO_SPACE', 'Convert non-breaking space to regular space', /\u00a0/g, ' ');
  applyStep('COLLAPSE_SPACES', 'Collapse repeated horizontal whitespace', /[ \t]{2,}/g, ' ');

  // Convert Arabic-Indic digits (٠-٩) to Persian digits (۰-۹) in Persian spans only
  let digitCount = 0;
  working = working.replace(/[٠-٩]/g, (d) => {
    digitCount += 1;
    return String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x06f0);
  });
  if (digitCount > 0) {
    appliedSteps.push({
      ruleId: 'ARABIC_INDIC_DIGITS_TO_PERSIAN',
      description: 'Normalize Arabic-Indic digits to Persian digits',
      replacementCount: digitCount,
    });
  }

  // Restore protected Latin/URL/email spans verbatim
  const normalizedText = working
    .replace(/\uE000(\d+)\uE001/g, (_m, idxStr) => protectedTokens[Number(idxStr)] ?? '')
    .trim();

  return {
    normalizerVersion: PERSIAN_NORMALIZER_VERSION,
    originalText,
    normalizedText,
    appliedSteps,
    reversibleHint: appliedSteps.every((s) => s.ruleId !== 'STRIP_OPTIONAL_DIACRITICS'),
  };
}

export interface PersianTranscriptTokenRecord {
  readonly tokenId: string;
  readonly index: number;
  readonly rawAsrText: string;
  readonly verbatimText: string;
  readonly normalizedText: string;
  readonly readableText: string;
  readonly userCorrectedText: string | null;
  readonly userConfirmed: boolean;
  readonly startCharOffset: number;
  readonly endCharOffset: number;
  readonly sourceStartSample: number | null;
  readonly sourceEndSample: number | null;
  readonly sampleRate: number;
  readonly language: 'fa' | 'en' | 'ar' | 'mixed' | 'numeric' | 'punctuation' | 'uncertain';
  readonly epistemicSource: EpistemicSourceCategory;
  readonly speechEventIds: readonly string[];
}

export interface PersianTranscriptRevisionRecord {
  readonly revisionId: string;
  readonly version: number;
  readonly createdAtIso: string;
  readonly author: 'ASR_ENGINE' | 'LINGUISTIC_PROPOSAL_ACCEPTED' | 'USER_MANUAL_EDIT' | 'REVERT';
  readonly summary: string;
  readonly affectedTokenIds: readonly string[];
}

export interface PersianTranscriptDocument {
  readonly documentId: string;
  readonly version: number;
  readonly normalizerVersion: typeof PERSIAN_NORMALIZER_VERSION;
  readonly rawAsrFullText: string;
  readonly tokens: readonly PersianTranscriptTokenRecord[];
  readonly revisions: readonly PersianTranscriptRevisionRecord[];
}

export function renderTranscriptLayerText(
  doc: PersianTranscriptDocument,
  layer: TranscriptLayerKind,
): string {
  return doc.tokens
    .map((tok) => {
      switch (layer) {
        case 'RAW_ASR':
          return tok.rawAsrText;
        case 'VERBATIM':
          return tok.userCorrectedText ?? tok.verbatimText;
        case 'NORMALIZED':
          return tok.normalizedText;
        case 'READABLE':
          return tok.userCorrectedText ?? tok.readableText;
        case 'USER_CORRECTED':
          return tok.userCorrectedText ?? tok.verbatimText;
      }
    })
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+([،؛؟.!:,;])/g, '$1');
}

/**
 * Merges incoming ASR/analysis refresh without EVER overwriting explicit human corrections
 * and without mutating rawAsrText on existing tokens.
 */
export function mergeNewAsrPreservingUserCorrections(
  existing: PersianTranscriptDocument,
  incomingTokens: readonly PersianTranscriptTokenRecord[],
): PersianTranscriptDocument {
  const existingById = new Map(existing.tokens.map((t) => [t.tokenId, t]));
  const merged = incomingTokens.map((inc) => {
    const prev = existingById.get(inc.tokenId);
    if (prev && (prev.userConfirmed || prev.userCorrectedText !== null)) {
      return {
        ...inc,
        rawAsrText: prev.rawAsrText,
        readableText: prev.userCorrectedText ?? prev.readableText,
        userCorrectedText: prev.userCorrectedText,
        userConfirmed: prev.userConfirmed,
        epistemicSource: 'HUMAN_CORRECTION' as const,
      };
    }
    return inc;
  });

  const nextVersion = existing.version + 1;
  return {
    ...existing,
    version: nextVersion,
    tokens: merged,
    revisions: [
      ...existing.revisions,
      {
        revisionId: `rev_${nextVersion}`,
        version: nextVersion,
        createdAtIso: new Date().toISOString(),
        author: 'ASR_ENGINE',
        summary: 'Merged refreshed ASR/analysis output while preserving all user-confirmed corrections.',
        affectedTokenIds: merged.map((t) => t.tokenId),
      },
    ],
  };
}
