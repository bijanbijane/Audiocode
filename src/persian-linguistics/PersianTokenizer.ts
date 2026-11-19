import {
  normalizePersianSafely,
  PERSIAN_NORMALIZER_VERSION,
  PersianTranscriptDocument,
  PersianTranscriptTokenRecord,
} from './PersianTranscriptModel';

export type PersianTokenKind =
  | 'PERSIAN_WORD'
  | 'ARABIC_EMBEDDED_WORD'
  | 'ENGLISH_WORD'
  | 'MIXED_CODE_SWITCH'
  | 'NUMBER_OR_DATE'
  | 'CURRENCY_OR_UNIT'
  | 'URL'
  | 'EMAIL'
  | 'PUNCTUATION'
  | 'FILLER_OR_DISFLUENCY'
  | 'INCOMPLETE_WORD';

export interface DeterministicPersianToken {
  readonly tokenId: string;
  readonly index: number;
  readonly text: string;
  readonly normalizedText: string;
  readonly startCharOffset: number;
  readonly endCharOffset: number;
  readonly kind: PersianTokenKind;
  readonly language: PersianTranscriptTokenRecord['language'];
}

const KNOWN_PERSIAN_FILLERS = new Set([
  'اِ',
  'اَم',
  'اوم',
  'اومم',
  'امم',
  'آآ',
  'آآآ',
  'خب',
  'یعنی',
  'آره',
  'حالا',
  'مثلاً',
  'مثلا',
  'راستش',
  'البته',
  'ببین',
  'چیز',
]);

const CURRENCY_UNITS = new Set([
  'تومان',
  'تومن',
  'ریال',
  'دلار',
  'یورو',
  'درصد',
  'کیلومتر',
  'متر',
  'کیلوگرم',
  'میلی‌ثانیه',
  'ثانیه',
  'دقیقه',
  'ساعت',
]);

const TOKEN_SCAN_RE =
  /https?:\/\/[^\s]+|[\w.+-]+@[\w-]+\.[\w.-]+|[0-9۰-۹٠-٩]+(?:[.,/:٫٬][0-9۰-۹٠-٩]+)*%?|[A-Za-z][A-Za-z0-9_-]*(?:\u200c[\u0600-\u06FF]+)?|[\u0600-\u06FF]+(?:\u200c[\u0600-\u06FF]+)*(?:-[\u0600-\u06FF]*)?|[،؛؟«»()\[\]{}.,!?;:—–…]+/g;

function classifyToken(raw: string, normalized: string): {
  readonly kind: PersianTokenKind;
  readonly language: PersianTranscriptTokenRecord['language'];
} {
  if (/^https?:\/\//i.test(raw)) return { kind: 'URL', language: 'en' };
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(raw)) return { kind: 'EMAIL', language: 'en' };
  if (/^[،؛؟«»()\[\]{}.,!?;:—–…]+$/.test(raw)) return { kind: 'PUNCTUATION', language: 'punctuation' };
  if (/^[0-9۰-۹٠-٩]+(?:[.,/:٫٬][0-9۰-۹٠-٩]+)*%?$/.test(raw)) {
    return { kind: 'NUMBER_OR_DATE', language: 'numeric' };
  }

  const hasLatin = /[A-Za-z]/.test(raw);
  const hasPersianArabic = /[\u0600-\u06FF]/.test(raw);
  if (hasLatin && hasPersianArabic) {
    return { kind: 'MIXED_CODE_SWITCH', language: 'mixed' };
  }
  if (hasLatin) {
    return { kind: 'ENGLISH_WORD', language: 'en' };
  }
  if (raw.endsWith('-')) {
    return { kind: 'INCOMPLETE_WORD', language: 'fa' };
  }
  if (KNOWN_PERSIAN_FILLERS.has(raw) || KNOWN_PERSIAN_FILLERS.has(normalized)) {
    return { kind: 'FILLER_OR_DISFLUENCY', language: 'fa' };
  }
  if (CURRENCY_UNITS.has(normalized)) {
    return { kind: 'CURRENCY_OR_UNIT', language: 'fa' };
  }
  if (/[يكةؤإأ]/.test(raw)) {
    return { kind: 'ARABIC_EMBEDDED_WORD', language: 'ar' };
  }
  return { kind: 'PERSIAN_WORD', language: 'fa' };
}

/**
 * Deterministic Persian/Code-Switched Tokenizer (AVP-P13-001 Section 3).
 * Preserves exact original character offsets, punctuation separation, ZWNJ compounds,
 * URLs, emails, numbers, incomplete spoken words, fillers, and stable token IDs.
 */
export function tokenizePersianTranscript(
  verbatimText: string,
  idPrefix = 'ptok',
): readonly DeterministicPersianToken[] {
  const tokens: DeterministicPersianToken[] = [];
  TOKEN_SCAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = TOKEN_SCAN_RE.exec(verbatimText)) !== null) {
    const raw = match[0];
    const startCharOffset = match.index;
    const endCharOffset = startCharOffset + raw.length;
    const norm = normalizePersianSafely(raw).normalizedText;
    const cls = classifyToken(raw, norm);

    tokens.push({
      tokenId: `${idPrefix}_${idx}`,
      index: idx,
      text: raw,
      normalizedText: norm,
      startCharOffset,
      endCharOffset,
      kind: cls.kind,
      language: cls.language,
    });
    idx += 1;
  }

  return tokens;
}

/**
 * Builds a canonical 5-layer PersianTranscriptDocument from raw ASR text and optional P12 sample coordinates.
 */
export function createPersianTranscriptDocument(params: {
  readonly documentId: string;
  readonly rawAsrText: string;
  readonly sampleRate?: number;
  readonly tokenSampleSpans?: ReadonlyArray<{
    readonly sourceStartSample: number | null;
    readonly sourceEndSample: number | null;
    readonly speechEventIds?: readonly string[];
  }>;
}): PersianTranscriptDocument {
  const sampleRate =
    typeof params.sampleRate === 'number' && Number.isFinite(params.sampleRate) && params.sampleRate > 0
      ? Math.trunc(params.sampleRate)
      : 48000;
  const scanned = tokenizePersianTranscript(params.rawAsrText, `${params.documentId}_tok`);

  const tokens: PersianTranscriptTokenRecord[] = scanned.map((t, i) => {
    const span = params.tokenSampleSpans?.[i];
    const validStart =
      typeof span?.sourceStartSample === 'number' &&
      Number.isFinite(span.sourceStartSample) &&
      span.sourceStartSample >= 0
        ? Math.trunc(span.sourceStartSample)
        : null;
    const validEnd =
      typeof span?.sourceEndSample === 'number' &&
      Number.isFinite(span.sourceEndSample) &&
      span.sourceEndSample >= 0
        ? Math.max(validStart ?? 0, Math.trunc(span.sourceEndSample))
        : null;
    return {
      tokenId: t.tokenId,
      index: t.index,
      rawAsrText: t.text,
      verbatimText: t.text,
      normalizedText: t.normalizedText,
      readableText: t.text,
      userCorrectedText: null,
      userConfirmed: false,
      startCharOffset: t.startCharOffset,
      endCharOffset: t.endCharOffset,
      sourceStartSample: validStart,
      sourceEndSample: validEnd,
      sampleRate,
      language: t.language,
      epistemicSource: 'MODEL_GENERATED_RECOGNITION',
      speechEventIds: span?.speechEventIds ? [...span.speechEventIds] : [],
    };
  });

  return {
    documentId: params.documentId,
    version: 1,
    normalizerVersion: PERSIAN_NORMALIZER_VERSION,
    rawAsrFullText: params.rawAsrText,
    tokens,
    revisions: [
      {
        revisionId: 'rev_1',
        version: 1,
        createdAtIso: new Date().toISOString(),
        author: 'ASR_ENGINE',
        summary: 'Initial verbatim ASR transcript imported with immutable raw layer.',
        affectedTokenIds: tokens.map((t) => t.tokenId),
      },
    ],
  };
}
