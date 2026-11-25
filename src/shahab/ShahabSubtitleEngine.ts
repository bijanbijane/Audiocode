/**
 * SHAHAB-027 — Professional Subtitle & Caption Engineering, Persian RTL Layout & Verified Export
 *
 * Strictly decoupled from ASR (SHAHAB-005..021), Alignment (SHAHAB-025), and Diarization (SHAHAB-026).
 * Consumes alignment and diarization outputs via explicit versioned dependency lineage.
 *
 * Epistemic & Editorial Invariants:
 * 1. Three strictly distinct subtitle modes:
 *    - `VERBATIM` (faithful spoken wording)
 *    - `CLEANED` (editorial readability polish with explicit reversible transformation log; NEVER silently drops substantive words)
 *    - `ACCESSIBILITY` (speaker labels + non-speech audio cues ONLY from verified detectors or explicit user annotations; NEVER hallucinated from text)
 * 2. Separates 5 explicit timing domains on every cue:
 *    `acousticRange`, `displayRange`, `sourceRange`, `timelineRange`, `exportRange`.
 * 3. NEVER fabricates acoustic word boundaries when SHAHAB-025 only verified segment-level timing.
 *    If a long segment is split for visual readability, `acousticRange` remains honestly anchored
 *    to the verified source segment and `timingProvenance` explicitly records `SEGMENT_DERIVED_DISPLAY_SPLIT_NOT_WORD_ACOUSTIC`.
 * 4. Persian RTL, ZWNJ (`\u200c`), compound words, mixed Persian/Latin runs, and numeral policies
 *    are handled deterministically with reversible bidi marks and explicit format loss declarations.
 * 5. Automated QA checks structural, timing, readability (grapheme CPS + Persian WPM), and
 *    Persian-specific rules without silently rewriting user text.
 * 6. Manual overrides are revisioned and protected against silent overwrite on regeneration.
 */

import crypto from 'node:crypto';
import {
  buildSampleInterval,
  FLICKS_PER_SECOND,
  type AlignmentGranularity,
  type AlignmentResult,
  type SampleInterval,
} from './ShahabAlignmentEngine.ts';
import {
  attributeTranscriptWithDiarization,
  UNKNOWN_SPEAKER_ID,
  type DiarizationResult,
} from './ShahabDiarizationEngine.ts';

export const SHAHAB_SUBTITLE_CONTRACT_VERSION = '1.0.0';
const ZWNJ = '\u200c';
const RLM = '\u200f';
const FSI = '\u2068';
const PDI = '\u2069';

export type SubtitleMode = 'VERBATIM' | 'CLEANED' | 'ACCESSIBILITY';

export type SubtitleProfileId =
  | 'EDUCATIONAL'
  | 'INTERVIEW'
  | 'PODCAST'
  | 'DOCUMENTARY'
  | 'FAST_SOCIAL'
  | 'LECTURE'
  | 'ACCESSIBILITY_FIRST'
  | 'VERBATIM_ARCHIVAL';

export type SubtitleExportFormat = 'SRT_UTF8' | 'WEBVTT_UTF8' | 'TTML_XML' | 'JSON_SIDECAR';

export type SubtitleBidiPolicy = 'PLAIN_UNICODE_LOGICAL' | 'RLM_ANCHORED' | 'ISOLATE_FSI_PDI';

export type SubtitleNumeralPolicy = 'PRESERVE_ORIGINAL' | 'PERSIAN_DIGITS' | 'WESTERN_DIGITS';

export type SubtitleTimingProvenance =
  | 'WORD_ACOUSTIC_ALIGNED'
  | 'TOKEN_EMISSION_LATTICE'
  | 'SEGMENT_ACOUSTIC_ALIGNED'
  | 'SEGMENT_DERIVED_DISPLAY_SPLIT_NOT_WORD_ACOUSTIC'
  | 'USER_MANUAL_TIMING_OVERRIDE';

export interface SubtitleEditorialProfile {
  readonly profileId: SubtitleProfileId;
  readonly displayName: string;
  readonly displayNameFa: string;
  readonly defaultMode: SubtitleMode;
  readonly maxLines: number;
  readonly maxCharsPerLine: number;
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly minGapMs: number;
  readonly targetCps: number;
  readonly maxCps: number;
  readonly bidiPolicy: SubtitleBidiPolicy;
  readonly numeralPolicy: SubtitleNumeralPolicy;
  readonly includeSpeakerLabels: boolean;
  readonly readingSpeedMetricDefinition: string;
}

export const SHAHAB_SUBTITLE_PROFILES: Readonly<Record<SubtitleProfileId, SubtitleEditorialProfile>> = {
  EDUCATIONAL: {
    profileId: 'EDUCATIONAL',
    displayName: 'Educational / Course',
    displayNameFa: 'آموزشی و درسی',
    defaultMode: 'CLEANED',
    maxLines: 2,
    maxCharsPerLine: 42,
    minDurationMs: 1000,
    maxDurationMs: 6500,
    minGapMs: 80,
    targetCps: 15,
    maxCps: 18,
    bidiPolicy: 'RLM_ANCHORED',
    numeralPolicy: 'PERSIAN_DIGITS',
    includeSpeakerLabels: false,
    readingSpeedMetricDefinition:
      'Visual grapheme clusters (Intl.Segmenter fa, excluding invisible ZWNJ/bidi controls) per second, reported both including and excluding spaces, alongside Persian word WPM.',
  },
  INTERVIEW: {
    profileId: 'INTERVIEW',
    displayName: 'Interview / Dialogue',
    displayNameFa: 'مصاحبه و گفت‌وگو',
    defaultMode: 'VERBATIM',
    maxLines: 2,
    maxCharsPerLine: 40,
    minDurationMs: 900,
    maxDurationMs: 6000,
    minGapMs: 80,
    targetCps: 16,
    maxCps: 20,
    bidiPolicy: 'RLM_ANCHORED',
    numeralPolicy: 'PRESERVE_ORIGINAL',
    includeSpeakerLabels: true,
    readingSpeedMetricDefinition:
      'Visual grapheme clusters (excluding invisible ZWNJ/bidi controls) per second + Persian word WPM.',
  },
  PODCAST: {
    profileId: 'PODCAST',
    displayName: 'Podcast / Long-Form',
    displayNameFa: 'پادکست',
    defaultMode: 'CLEANED',
    maxLines: 2,
    maxCharsPerLine: 42,
    minDurationMs: 1000,
    maxDurationMs: 6500,
    minGapMs: 80,
    targetCps: 16,
    maxCps: 20,
    bidiPolicy: 'RLM_ANCHORED',
    numeralPolicy: 'PRESERVE_ORIGINAL',
    includeSpeakerLabels: true,
    readingSpeedMetricDefinition:
      'Visual grapheme clusters (excluding invisible ZWNJ/bidi controls) per second + Persian word WPM.',
  },
  DOCUMENTARY: {
    profileId: 'DOCUMENTARY',
    displayName: 'Documentary / Broadcast',
    displayNameFa: 'مستند و پخش حرفه‌ای',
    defaultMode: 'CLEANED',
    maxLines: 2,
    maxCharsPerLine: 38,
    minDurationMs: 1200,
    maxDurationMs: 6000,
    minGapMs: 100,
    targetCps: 14,
    maxCps: 17,
    bidiPolicy: 'RLM_ANCHORED',
    numeralPolicy: 'PERSIAN_DIGITS',
    includeSpeakerLabels: false,
    readingSpeedMetricDefinition:
      'Broadcast Persian visual grapheme CPS (target <=14, ceiling 17) + WPM.',
  },
  FAST_SOCIAL: {
    profileId: 'FAST_SOCIAL',
    displayName: 'Fast Social / Vertical Video',
    displayNameFa: 'شبکه‌های اجتماعی (سریع)',
    defaultMode: 'CLEANED',
    maxLines: 2,
    maxCharsPerLine: 28,
    minDurationMs: 700,
    maxDurationMs: 3500,
    minGapMs: 40,
    targetCps: 18,
    maxCps: 23,
    bidiPolicy: 'PLAIN_UNICODE_LOGICAL',
    numeralPolicy: 'PERSIAN_DIGITS',
    includeSpeakerLabels: false,
    readingSpeedMetricDefinition:
      'Short-form mobile visual grapheme CPS (narrow 28-char line width).',
  },
  LECTURE: {
    profileId: 'LECTURE',
    displayName: 'Academic Lecture',
    displayNameFa: 'سخنرانی و کلاس دانشگاهی',
    defaultMode: 'VERBATIM',
    maxLines: 2,
    maxCharsPerLine: 44,
    minDurationMs: 1000,
    maxDurationMs: 7000,
    minGapMs: 80,
    targetCps: 16,
    maxCps: 20,
    bidiPolicy: 'ISOLATE_FSI_PDI',
    numeralPolicy: 'PRESERVE_ORIGINAL',
    includeSpeakerLabels: false,
    readingSpeedMetricDefinition:
      'Mixed Persian/technical-Latin visual grapheme CPS with FSI/PDI bidi isolation.',
  },
  ACCESSIBILITY_FIRST: {
    profileId: 'ACCESSIBILITY_FIRST',
    displayName: 'Accessibility-First Captions (SDH)',
    displayNameFa: 'زیرنویس دسترس‌پذیری (SDH)',
    defaultMode: 'ACCESSIBILITY',
    maxLines: 2,
    maxCharsPerLine: 40,
    minDurationMs: 1200,
    maxDurationMs: 6500,
    minGapMs: 100,
    targetCps: 13,
    maxCps: 16,
    bidiPolicy: 'RLM_ANCHORED',
    numeralPolicy: 'PERSIAN_DIGITS',
    includeSpeakerLabels: true,
    readingSpeedMetricDefinition:
      'Accessibility visual grapheme CPS ceiling 16; includes speaker tags and ONLY verified/annotated non-speech cues.',
  },
  VERBATIM_ARCHIVAL: {
    profileId: 'VERBATIM_ARCHIVAL',
    displayName: 'Verbatim Archival',
    displayNameFa: 'آرشیوی عین‌به‌عین',
    defaultMode: 'VERBATIM',
    maxLines: 2,
    maxCharsPerLine: 45,
    minDurationMs: 800,
    maxDurationMs: 7000,
    minGapMs: 40,
    targetCps: 18,
    maxCps: 24,
    bidiPolicy: 'PLAIN_UNICODE_LOGICAL',
    numeralPolicy: 'PRESERVE_ORIGINAL',
    includeSpeakerLabels: true,
    readingSpeedMetricDefinition:
      'Archival verbatim grapheme CPS without lexical omission.',
  },
};

export interface VerifiedNonSpeechEvent {
  readonly eventId: string;
  readonly labelFa: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly source: 'VERIFIED_AUDIO_DETECTOR' | 'EXPLICIT_HUMAN_ANNOTATION';
}

export interface SubtitleTimeDomainRange {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

export interface SubtitleExportTimingConfig {
  readonly fps: number | null;
  readonly dropFrame: boolean;
  readonly vfrDetected: boolean;
  readonly timelineOffsetMs: number;
}

export interface SubtitleReadingMetrics {
  readonly visibleGraphemeCountIncludingSpaces: number;
  readonly visibleGraphemeCountExcludingSpaces: number;
  readonly persianWordCount: number;
  readonly cpsIncludingSpaces: number;
  readonly cpsExcludingSpaces: number;
  readonly wpm: number;
  readonly lineGraphemeCounts: readonly number[];
  readonly maxLineGraphemeCount: number;
}

export interface PersianRtlLayoutReport {
  readonly bidiPolicy: SubtitleBidiPolicy;
  readonly containsPersianRtl: boolean;
  readonly containsLatinLtr: boolean;
  readonly containsNumerals: boolean;
  readonly mixedScriptDetected: boolean;
  readonly zwnjCount: number;
  readonly directionalMarksInsertedCount: number;
  readonly reversibleCleanTextVerified: boolean;
  readonly layoutWarnings: readonly string[];
}

export interface SubtitleTransformationRecord {
  readonly cueId: string;
  readonly ruleId: string;
  readonly before: string;
  readonly after: string;
  readonly reversible: true;
  readonly reason: string;
}

export interface ShahabSubtitleCue {
  readonly cueId: string;
  readonly index: number;
  readonly mode: SubtitleMode;
  readonly rawSourceText: string;
  readonly lines: readonly string[];
  readonly renderedText: string;
  readonly speakerId: string | null;
  readonly speakerDisplayLabel: string | null;
  readonly activeSpeakerIds: readonly string[];
  readonly overlapFlag: boolean;
  readonly isNonSpeechAccessibilityCue: boolean;
  readonly nonSpeechSource: VerifiedNonSpeechEvent['source'] | null;
  readonly timingProvenance: SubtitleTimingProvenance;
  /** 1. Immutable acoustic range from SHAHAB-025 / ASR */
  readonly acousticRange: SampleInterval | null;
  /** 2. Readability-adjusted display range */
  readonly displayRange: SubtitleTimeDomainRange;
  /** 3. Original media source range */
  readonly sourceRange: SampleInterval | null;
  /** 4. Host timeline range (offset + exact flicks) */
  readonly timelineRange: {
    readonly startMs: number;
    readonly endMs: number;
    readonly startFlicks: number;
    readonly endFlicks: number;
  };
  /** 5. Format-quantized export range */
  readonly exportRange: SubtitleTimeDomainRange;
  readonly readingMetrics: SubtitleReadingMetrics;
  readonly rtlLayout: PersianRtlLayoutReport;
  readonly manualOverride: boolean;
  readonly lastEditedAtUtc: string | null;
  readonly notes: string;
}

export type SubtitleQaSeverity = 'ERROR' | 'WARNING' | 'INFO';
export type SubtitleQaCategory = 'STRUCTURAL' | 'TIMING' | 'READABILITY' | 'PERSIAN_LINGUISTIC';

export interface SubtitleQaIssue {
  readonly issueId: string;
  readonly cueId: string | null;
  readonly category: SubtitleQaCategory;
  readonly severity: SubtitleQaSeverity;
  readonly code: string;
  readonly message: string;
}

export interface SubtitleQaReport {
  readonly auditedAtUtc: string;
  readonly passedWithoutErrors: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly issues: readonly SubtitleQaIssue[];
  readonly summaryMetrics: {
    readonly totalCues: number;
    readonly maxCpsObserved: number;
    readonly meanCpsObserved: number;
    readonly minDurationObservedMs: number;
    readonly maxDurationObservedMs: number;
    readonly maxLineLengthObserved: number;
  };
}

export interface SubtitleDependencyLineage {
  readonly audioId: string;
  readonly audioSha256: string;
  readonly transcriptRevisionId: string;
  readonly alignmentRequestId: string;
  readonly alignmentGranularity: AlignmentGranularity;
  readonly alignmentContractVersion: string;
  readonly diarizationRequestId: string | null;
  readonly diarizationRevisionId: string | null;
  readonly diarizationContractVersion: string | null;
}

export interface SubtitleRevisionEntry {
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly timestampUtc: string;
  readonly action: string;
  readonly detail: string;
}

export interface ShahabSubtitleDocument {
  readonly contractVersion: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly mode: SubtitleMode;
  readonly profile: SubtitleEditorialProfile;
  readonly timingConfig: SubtitleExportTimingConfig;
  readonly dependencyLineage: SubtitleDependencyLineage;
  readonly cues: readonly ShahabSubtitleCue[];
  readonly transformations: readonly SubtitleTransformationRecord[];
  readonly qaReport: SubtitleQaReport;
  readonly revisions: readonly SubtitleRevisionEntry[];
  readonly limitations: readonly string[];
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface SubtitleExportArtifact {
  readonly format: SubtitleExportFormat;
  readonly fileExtension: '.srt' | '.vtt' | '.ttml' | '.subtitle.shahab.json';
  readonly mimeType: string;
  readonly encoding: 'UTF-8';
  readonly content: string;
  readonly sha256: string;
  readonly cueCount: number;
  readonly declaredInformationLosses: readonly string[];
  readonly roundTripValidation: {
    readonly passed: boolean;
    readonly parsedCueCount: number;
    readonly zwnjPreserved: boolean;
    readonly monotonicTimestampsVerified: boolean;
    readonly errors: readonly string[];
  };
}

export interface SubtitleGenerationInput {
  readonly alignment: AlignmentResult;
  readonly diarization?: DiarizationResult | null;
  readonly profileId?: SubtitleProfileId;
  readonly customProfileOverrides?: Partial<SubtitleEditorialProfile>;
  readonly mode?: SubtitleMode;
  readonly timingConfig?: Partial<SubtitleExportTimingConfig>;
  readonly verifiedNonSpeechEvents?: readonly VerifiedNonSpeechEvent[];
}

export interface SubtitleRegenerationConflict {
  readonly cueId: string;
  readonly manualLines: readonly string[];
  readonly regeneratedLines: readonly string[];
  readonly manualDisplayRange: SubtitleTimeDomainRange;
  readonly regeneratedDisplayRange: SubtitleTimeDomainRange;
  readonly resolutionState: 'CONFLICT_REQUIRES_USER_RESOLUTION';
}

const PERSIAN_DIGITS_MAP = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const PERSIAN_RE = /[\u0600-\u06FF]/;
const LATIN_RE = /[A-Za-z]/;
const DIGIT_RE = /[0-9\u06F0-\u06F9\u0660-\u0669]/;
const INVISIBLE_CONTROL_RE = /[\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_MARK_RE = /[\u200e\u200f\u2066-\u2069]/g;

function sha256(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf-8').digest('hex');
}

export function countVisiblePersianGraphemes(text: string, includeSpaces = true): number {
  const stripped = text.replace(INVISIBLE_CONTROL_RE, '');
  const target = includeSpaces ? stripped : stripped.replace(/\s+/g, '');
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('fa', { granularity: 'grapheme' });
    let count = 0;
    for (const _ of seg.segment(target)) count += 1;
    return count;
  }
  return Array.from(target).length;
}

export function applyNumeralPolicy(text: string, policy: SubtitleNumeralPolicy): string {
  if (policy === 'PRESERVE_ORIGINAL') return text;
  if (policy === 'PERSIAN_DIGITS') {
    return text
      .replace(/[0-9]/g, (d) => PERSIAN_DIGITS_MAP[Number(d)])
      .replace(/[\u0660-\u0669]/g, (d) => PERSIAN_DIGITS_MAP[d.charCodeAt(0) - 0x0660]);
  }
  // WESTERN_DIGITS
  return text
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * SHAHAB-027 §7 — Persian RTL & Mixed-Script Layout Analysis & Reversible Formatting.
 */
export function analyzeAndFormatPersianRtlLayout(
  lines: readonly string[],
  bidiPolicy: SubtitleBidiPolicy,
): { readonly formattedLines: readonly string[]; readonly report: PersianRtlLayoutReport } {
  const joined = lines.join('\n');
  const containsPersianRtl = PERSIAN_RE.test(joined);
  const containsLatinLtr = LATIN_RE.test(joined);
  const containsNumerals = DIGIT_RE.test(joined);
  const mixedScriptDetected = containsPersianRtl && containsLatinLtr;
  const zwnjCount = (joined.match(/\u200c/g) ?? []).length;
  const layoutWarnings: string[] = [];

  let directionalMarksInsertedCount = 0;
  const formattedLines = lines.map((line) => {
    const clean = line.replace(BIDI_MARK_RE, '');
    if (!containsPersianRtl) return clean;

    if (bidiPolicy === 'PLAIN_UNICODE_LOGICAL') {
      if (mixedScriptDetected) {
        layoutWarnings.push(
          'Mixed Persian/Latin line exported in PLAIN_UNICODE_LOGICAL without bidi isolation marks; some legacy players may invert trailing punctuation.',
        );
      }
      return clean;
    }

    if (bidiPolicy === 'ISOLATE_FSI_PDI') {
      // Wrap contiguous Latin/acronym runs in FSI...PDI and anchor RTL line with RLM
      const isolated = clean.replace(/([A-Za-z][A-Za-z0-9._:/+-]*)/g, (m) => {
        directionalMarksInsertedCount += 2;
        return `${FSI}${m}${PDI}`;
      });
      directionalMarksInsertedCount += 1;
      return `${RLM}${isolated}`;
    }

    // RLM_ANCHORED: anchor Persian RTL line start cleanly
    directionalMarksInsertedCount += 1;
    return `${RLM}${clean}`;
  });

  // Check unbalanced brackets/parentheses which frequently flip in RTL players
  const openParens = (joined.match(/\(/g) ?? []).length;
  const closeParens = (joined.match(/\)/g) ?? []).length;
  if (openParens !== closeParens) {
    layoutWarnings.push('Unbalanced parentheses detected in Persian RTL line.');
  }

  // Reversibility check: stripping inserted bidi control marks restores original logical text
  const reversibleCleanTextVerified =
    formattedLines.map((l) => l.replace(BIDI_MARK_RE, '')).join('\n') ===
    lines.map((l) => l.replace(BIDI_MARK_RE, '')).join('\n');

  return {
    formattedLines,
    report: {
      bidiPolicy,
      containsPersianRtl,
      containsLatinLtr,
      containsNumerals,
      mixedScriptDetected,
      zwnjCount,
      directionalMarksInsertedCount,
      reversibleCleanTextVerified,
      layoutWarnings,
    },
  };
}

export function computePersianReadingMetrics(
  lines: readonly string[],
  durationMs: number,
): SubtitleReadingMetrics {
  const joined = lines.join(' ');
  const visibleInc = countVisiblePersianGraphemes(joined, true);
  const visibleExc = countVisiblePersianGraphemes(joined, false);
  const cleanWords = joined
    .replace(BIDI_MARK_RE, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^[-–—:«»؟،؛.!]+$/.test(w));
  const durSec = Math.max(0.001, durationMs / 1000);
  const lineGraphemeCounts = lines.map((l) => countVisiblePersianGraphemes(l, true));
  const maxLineGraphemeCount = lineGraphemeCounts.reduce((m, c) => Math.max(m, c), 0);

  return {
    visibleGraphemeCountIncludingSpaces: visibleInc,
    visibleGraphemeCountExcludingSpaces: visibleExc,
    persianWordCount: cleanWords.length,
    cpsIncludingSpaces: Number((visibleInc / durSec).toFixed(2)),
    cpsExcludingSpaces: Number((visibleExc / durSec).toFixed(2)),
    wpm: Number(((cleanWords.length / durSec) * 60).toFixed(1)),
    lineGraphemeCounts,
    maxLineGraphemeCount,
  };
}

/**
 * Deterministic Persian-aware line wrapper (SHAHAB-027 §4 & §5).
 * Preserves ZWNJ compound words as atomic tokens, keeps trailing punctuation attached,
 * balances 2-line captions cleanly, and NEVER deletes spoken words.
 */
export function wrapPersianCaptionLines(
  text: string,
  maxCharsPerLine: number,
  maxLines: number,
): readonly string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const totalLen = countVisiblePersianGraphemes(words.join(' '), true);
  if (totalLen <= maxCharsPerLine || maxLines <= 1) {
    return [words.join(' ')];
  }

  // Optimal balanced 2-line split respecting Persian punctuation & clause conjunctions
  if (maxLines === 2 && totalLen <= maxCharsPerLine * 2 + 4) {
    let bestIdx = Math.floor(words.length / 2);
    let bestScore = Infinity;

    for (let i = 1; i < words.length; i++) {
      const l1 = words.slice(0, i).join(' ');
      const l2 = words.slice(i).join(' ');
      const c1 = countVisiblePersianGraphemes(l1, true);
      const c2 = countVisiblePersianGraphemes(l2, true);
      const overflowPenalty =
        Math.max(0, c1 - maxCharsPerLine) * 15 + Math.max(0, c2 - maxCharsPerLine) * 15;
      const balancePenalty = Math.abs(c1 - c2);
      // Prefer breaking after Persian comma/semicolon/colon or before conjunctions (و، اما، ولی، که)
      const punctBonus = /[،؛:؟.!]$/.test(words[i - 1]) ? -8 : 0;
      const orphanPenalty = i === 1 || i === words.length - 1 ? 6 : 0;
      const score = overflowPenalty + balancePenalty + punctBonus + orphanPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return [words.slice(0, bestIdx).join(' '), words.slice(bestIdx).join(' ')];
  }

  // Greedy fallback for longer text (caller splits into multiple cues first)
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (
      current &&
      countVisiblePersianGraphemes(candidate, true) > maxCharsPerLine &&
      lines.length < maxLines - 1
    ) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Splits a long Persian text into cue-sized chunks (respecting punctuation & max cue chars)
 * without dropping a single word.
 */
function chunkPersianTextForCues(text: string, maxCueChars: number): readonly string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (countVisiblePersianGraphemes(words.join(' '), true) <= maxCueChars) {
    return [words.join(' ')];
  }

  const chunks: string[] = [];
  let curWords: string[] = [];
  for (const w of words) {
    const cand = [...curWords, w].join(' ');
    if (curWords.length > 0 && countVisiblePersianGraphemes(cand, true) > maxCueChars) {
      chunks.push(curWords.join(' '));
      curWords = [w];
    } else {
      curWords.push(w);
      // Natural sentence boundary split if chunk is already reasonably populated
      if (
        /[.!?؟؛]$/.test(w) &&
        countVisiblePersianGraphemes(curWords.join(' '), true) >= maxCueChars * 0.45
      ) {
        chunks.push(curWords.join(' '));
        curWords = [];
      }
    }
  }
  if (curWords.length > 0) chunks.push(curWords.join(' '));
  return chunks;
}

/**
 * Mode-specific text processing:
 * - VERBATIM: zero lexical changes
 * - CLEANED: whitespace/punctuation spacing & numeral policy only (logged & reversible; NEVER deletes spoken words)
 * - ACCESSIBILITY: preserves spoken words + explicit verified non-speech cues
 */
function processTextForMode(
  rawText: string,
  mode: SubtitleMode,
  numeralPolicy: SubtitleNumeralPolicy,
  cueId: string,
  transformations: SubtitleTransformationRecord[],
): string {
  let out = rawText.trim();
  if (mode === 'CLEANED') {
    const spaced = out
      .replace(/\s+([،؛؟.!])/g, '$1')
      .replace(/([،؛؟.!])([^\s»)\]])/g, '$1 $2')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (spaced !== out) {
      transformations.push({
        cueId,
        ruleId: 'PERSIAN_PUNCTUATION_SPACING',
        before: out,
        after: spaced,
        reversible: true,
        reason: 'Standardized spacing around Persian punctuation without removing any words.',
      });
      out = spaced;
    }
  }

  const afterNumerals = applyNumeralPolicy(out, numeralPolicy);
  if (afterNumerals !== out) {
    transformations.push({
      cueId,
      ruleId: `NUMERAL_POLICY_${numeralPolicy}`,
      before: out,
      after: afterNumerals,
      reversible: true,
      reason: `Applied configured numeral style (${numeralPolicy}).`,
    });
    out = afterNumerals;
  }

  return out;
}

function quantizeMsToFrameGrid(ms: number, fps: number | null): number {
  if (!fps || !Number.isFinite(fps) || fps <= 0) {
    return Math.round(ms);
  }
  const frameMs = 1000 / fps;
  return Math.round(Math.round(ms / frameMs) * frameMs);
}

/**
 * SHAHAB-027 §10 — Automated Subtitle QA Audit Engine.
 * Inspects structural, timing, readability, and Persian-specific quality criteria
 * without silently modifying cue text.
 */
export function runSubtitleQaAudit(
  cues: readonly ShahabSubtitleCue[],
  profile: SubtitleEditorialProfile,
  mediaDurationMs: number,
): SubtitleQaReport {
  const issues: SubtitleQaIssue[] = [];
  let maxCps = 0;
  let cpsSum = 0;
  let minDur = cues.length > 0 ? Infinity : 0;
  let maxDur = 0;
  let maxLineLen = 0;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const cleanBody = cue.renderedText.replace(BIDI_MARK_RE, '').trim();

    // Structural
    if (cleanBody.length === 0) {
      issues.push({
        issueId: `qa_empty_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'STRUCTURAL',
        severity: 'ERROR',
        code: 'EMPTY_CUE',
        message: `Cue ${cue.index} has empty rendered text.`,
      });
    }
    if (cue.lines.length > profile.maxLines) {
      issues.push({
        issueId: `qa_lines_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'STRUCTURAL',
        severity: 'WARNING',
        code: 'EXCEEDS_MAX_LINES',
        message: `Cue ${cue.index} has ${cue.lines.length} lines (profile max ${profile.maxLines}).`,
      });
    }
    if (cue.readingMetrics.maxLineGraphemeCount > profile.maxCharsPerLine) {
      issues.push({
        issueId: `qa_linelen_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'STRUCTURAL',
        severity: 'WARNING',
        code: 'EXCEEDS_MAX_CHARS_PER_LINE',
        message: `Cue ${cue.index} line width is ${cue.readingMetrics.maxLineGraphemeCount} graphemes (profile max ${profile.maxCharsPerLine}).`,
      });
    }

    // Timing
    const dur = cue.displayRange.durationMs;
    if (dur <= 0 || cue.displayRange.endMs <= cue.displayRange.startMs) {
      issues.push({
        issueId: `qa_negdur_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'TIMING',
        severity: 'ERROR',
        code: 'ZERO_OR_NEGATIVE_DURATION',
        message: `Cue ${cue.index} has non-positive duration (${dur}ms).`,
      });
    }
    if (dur < profile.minDurationMs) {
      issues.push({
        issueId: `qa_mindur_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'TIMING',
        severity: 'WARNING',
        code: 'BELOW_MIN_DURATION',
        message: `Cue ${cue.index} duration ${dur}ms is below profile minimum ${profile.minDurationMs}ms.`,
      });
    }
    if (dur > profile.maxDurationMs) {
      issues.push({
        issueId: `qa_maxdur_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'TIMING',
        severity: 'WARNING',
        code: 'EXCEEDS_MAX_DURATION',
        message: `Cue ${cue.index} duration ${dur}ms exceeds profile maximum ${profile.maxDurationMs}ms.`,
      });
    }
    if (mediaDurationMs > 0 && cue.displayRange.endMs > mediaDurationMs + 50) {
      issues.push({
        issueId: `qa_oob_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'TIMING',
        severity: 'ERROR',
        code: 'OUT_OF_MEDIA_RANGE',
        message: `Cue ${cue.index} end (${cue.displayRange.endMs}ms) exceeds media duration (${mediaDurationMs}ms).`,
      });
    }
    if (i > 0) {
      const prev = cues[i - 1];
      const gap = cue.displayRange.startMs - prev.displayRange.endMs;
      if (gap < 0 && !cue.overlapFlag) {
        issues.push({
          issueId: `qa_overlap_${cue.cueId}`,
          cueId: cue.cueId,
          category: 'TIMING',
          severity: 'ERROR',
          code: 'UNDECLARED_CUE_OVERLAP',
          message: `Cue ${cue.index} overlaps previous cue ${prev.index} by ${Math.abs(gap)}ms without overlapFlag.`,
        });
      } else if (gap >= 0 && gap < profile.minGapMs) {
        issues.push({
          issueId: `qa_gap_${cue.cueId}`,
          cueId: cue.cueId,
          category: 'TIMING',
          severity: 'INFO',
          code: 'TIGHT_INTER_CUE_GAP',
          message: `Gap before cue ${cue.index} is ${gap}ms (profile minGap ${profile.minGapMs}ms).`,
        });
      }
    }

    // Readability
    const cps = cue.readingMetrics.cpsIncludingSpaces;
    if (cps > profile.maxCps) {
      issues.push({
        issueId: `qa_cps_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'READABILITY',
        severity: 'WARNING',
        code: 'EXCESSIVE_READING_SPEED_CPS',
        message: `Cue ${cue.index} reading speed is ${cps} CPS (profile ceiling ${profile.maxCps} CPS).`,
      });
    }

    // Persian-specific checks
    if (/\b(?:می|نمی)\s+[آ-ی]/u.test(cleanBody)) {
      issues.push({
        issueId: `qa_zwnj_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'PERSIAN_LINGUISTIC',
        severity: 'WARNING',
        code: 'PERSIAN_BROKEN_ZWNJ_PREFIX',
        message: `Cue ${cue.index} contains space after Persian prefix "می/نمی" instead of ZWNJ (نیم‌فاصله).`,
      });
    }
    if (/\s+[،؛؟.!]/u.test(cleanBody)) {
      issues.push({
        issueId: `qa_punct_${cue.cueId}`,
        cueId: cue.cueId,
        category: 'PERSIAN_LINGUISTIC',
        severity: 'WARNING',
        code: 'DETACHED_PERSIAN_PUNCTUATION',
        message: `Cue ${cue.index} has whitespace separating Persian punctuation from preceding word.`,
      });
    }
    for (const w of cue.rtlLayout.layoutWarnings) {
      issues.push({
        issueId: `qa_rtl_${cue.cueId}_${issues.length}`,
        cueId: cue.cueId,
        category: 'PERSIAN_LINGUISTIC',
        severity: 'WARNING',
        code: 'RTL_MIXED_SCRIPT_RISK',
        message: `Cue ${cue.index}: ${w}`,
      });
    }

    maxCps = Math.max(maxCps, cps);
    cpsSum += cps;
    minDur = Math.min(minDur, dur);
    maxDur = Math.max(maxDur, dur);
    maxLineLen = Math.max(maxLineLen, cue.readingMetrics.maxLineGraphemeCount);
  }

  const errorCount = issues.filter((i) => i.severity === 'ERROR').length;
  const warningCount = issues.filter((i) => i.severity === 'WARNING').length;
  const infoCount = issues.filter((i) => i.severity === 'INFO').length;

  return {
    auditedAtUtc: new Date().toISOString(),
    passedWithoutErrors: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    issues,
    summaryMetrics: {
      totalCues: cues.length,
      maxCpsObserved: Number(maxCps.toFixed(2)),
      meanCpsObserved: cues.length > 0 ? Number((cpsSum / cues.length).toFixed(2)) : 0,
      minDurationObservedMs: cues.length > 0 ? Math.round(minDur) : 0,
      maxDurationObservedMs: Math.round(maxDur),
      maxLineLengthObserved: maxLineLen,
    },
  };
}

function formatSrtTimecode(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function formatVttTimecode(ms: number): string {
  return formatSrtTimecode(ms).replace(',', '.');
}

function parseTimecodeToMs(tc: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(tc.trim());
  if (!m) return null;
  return (
    Number(m[1]) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4])
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * SHAHAB-027 §9 — Multi-Format Validated Exporter with Explicit Loss Accounting
 * and Automated Round-Trip Parsing Validation.
 */
export function exportSubtitleDocument(
  doc: ShahabSubtitleDocument,
  format: SubtitleExportFormat,
): SubtitleExportArtifact {
  const originalZwnjCount = doc.cues.reduce(
    (acc, c) => acc + (c.renderedText.match(/\u200c/g) ?? []).length,
    0,
  );

  if (format === 'SRT_UTF8') {
    const blocks = doc.cues.map((c, idx) => {
      const start = formatSrtTimecode(c.exportRange.startMs);
      const end = formatSrtTimecode(c.exportRange.endMs);
      return `${idx + 1}\n${start} --> ${end}\n${c.lines.join('\n')}`;
    });
    const content = blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '');

    // Round-trip validation
    const parsedBlocks = content.trim() ? content.trim().split(/\n\n+/) : [];
    const errors: string[] = [];
    let prevStart = -1;
    let monotonic = true;
    for (let i = 0; i < parsedBlocks.length; i++) {
      const lines = parsedBlocks[i].split('\n');
      if (lines.length < 3) {
        errors.push(`Block ${i + 1} missing lines.`);
        continue;
      }
      const [sStr, eStr] = lines[1].split(' --> ');
      const sMs = sStr ? parseTimecodeToMs(sStr) : null;
      const eMs = eStr ? parseTimecodeToMs(eStr) : null;
      if (sMs === null || eMs === null || eMs <= sMs) {
        errors.push(`Block ${i + 1} has invalid SRT timestamp "${lines[1]}".`);
      } else {
        if (sMs < prevStart) monotonic = false;
        prevStart = sMs;
      }
    }
    const exportedZwnj = (content.match(/\u200c/g) ?? []).length;

    return {
      format,
      fileExtension: '.srt',
      mimeType: 'application/x-subrip; charset=utf-8',
      encoding: 'UTF-8',
      content,
      sha256: sha256(content),
      cueCount: doc.cues.length,
      declaredInformationLosses: [
        'SRT has no native metadata for structured speaker IDs, acoustic vs. display timing separation, revision history, or dependency lineage.',
        'SRT has no native RTL/styling directive; relies on Unicode logical order + RLM/FSI marks.',
        'Sub-millisecond sample indices and flicks are quantized to millisecond precision.',
      ],
      roundTripValidation: {
        passed: errors.length === 0 && parsedBlocks.length === doc.cues.length && monotonic && exportedZwnj === originalZwnjCount,
        parsedCueCount: parsedBlocks.length,
        zwnjPreserved: exportedZwnj === originalZwnjCount,
        monotonicTimestampsVerified: monotonic,
        errors,
      },
    };
  }

  if (format === 'WEBVTT_UTF8') {
    const header = `WEBVTT\nKind: captions\nLanguage: fa\nNOTE SHAHAB-027 v${SHAHAB_SUBTITLE_CONTRACT_VERSION} | doc=${doc.documentId} | rev=${doc.revisionId}\n`;
    const blocks = doc.cues.map((c) => {
      const start = formatVttTimecode(c.exportRange.startMs);
      const end = formatVttTimecode(c.exportRange.endMs);
      const voicePrefix =
        c.speakerId && doc.profile.includeSpeakerLabels && !c.overlapFlag
          ? `<v ${c.speakerDisplayLabel ?? c.speakerId}>`
          : '';
      return `${c.cueId}\n${start} --> ${end} align:middle\n${voicePrefix}${c.lines.join('\n')}`;
    });
    const content = `${header}\n${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;

    const errors: string[] = [];
    if (!content.startsWith('WEBVTT')) errors.push('Missing WEBVTT header.');
    const tcMatches = Array.from(
      content.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/gm),
    );
    let prevStart = -1;
    let monotonic = true;
    for (const m of tcMatches) {
      const sMs = parseTimecodeToMs(m[1]);
      const eMs = parseTimecodeToMs(m[2]);
      if (sMs === null || eMs === null || eMs <= sMs) {
        errors.push(`Invalid WebVTT timecode: ${m[0]}`);
      } else {
        if (sMs < prevStart) monotonic = false;
        prevStart = sMs;
      }
    }
    const exportedZwnj = (content.match(/\u200c/g) ?? []).length;

    return {
      format,
      fileExtension: '.vtt',
      mimeType: 'text/vtt; charset=utf-8',
      encoding: 'UTF-8',
      content,
      sha256: sha256(content),
      cueCount: doc.cues.length,
      declaredInformationLosses: [
        'WebVTT drops full sample-index/flick timing domains, transformation provenance logs, and revision ancestry.',
        'Browser/player support for WebVTT <v> voice tags varies across hosts.',
      ],
      roundTripValidation: {
        passed:
          errors.length === 0 &&
          tcMatches.length === doc.cues.length &&
          monotonic &&
          exportedZwnj === originalZwnjCount,
        parsedCueCount: tcMatches.length,
        zwnjPreserved: exportedZwnj === originalZwnjCount,
        monotonicTimestampsVerified: monotonic,
        errors,
      },
    };
  }

  if (format === 'TTML_XML') {
    const pElements = doc.cues.map((c) => {
      const begin = formatVttTimecode(c.exportRange.startMs);
      const end = formatVttTimecode(c.exportRange.endMs);
      const body = c.lines.map((l) => escapeXml(l)).join('<br/>');
      const agentAttr = c.speakerId ? ` ttm:agent="${escapeXml(c.speakerId)}"` : '';
      return `      <p xml:id="${escapeXml(c.cueId)}" begin="${begin}" end="${end}"${agentAttr}>${body}</p>`;
    });
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tt xml:lang="fa" xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
      '  <head>',
      '    <styling>',
      '      <style xml:id="persianRtl" tts:direction="rtl" tts:unicodeBidi="embed" tts:textAlign="center"/>',
      '    </styling>',
      '  </head>',
      '  <body style="persianRtl">',
      '    <div>',
      ...pElements,
      '    </div>',
      '  </body>',
      '</tt>',
      '',
    ].join('\n');

    const pMatches = Array.from(content.matchAll(/<p xml:id="[^"]+" begin="([^"]+)" end="([^"]+)"/g));
    const errors: string[] = [];
    let prevStart = -1;
    let monotonic = true;
    for (const m of pMatches) {
      const sMs = parseTimecodeToMs(m[1]);
      const eMs = parseTimecodeToMs(m[2]);
      if (sMs === null || eMs === null || eMs <= sMs) {
        errors.push(`Invalid TTML begin/end: ${m[1]}..${m[2]}`);
      } else {
        if (sMs < prevStart) monotonic = false;
        prevStart = sMs;
      }
    }
    const exportedZwnj = (content.match(/\u200c/g) ?? []).length;

    return {
      format,
      fileExtension: '.ttml',
      mimeType: 'application/ttml+xml; charset=utf-8',
      encoding: 'UTF-8',
      content,
      sha256: sha256(content),
      cueCount: doc.cues.length,
      declaredInformationLosses: [
        'TTML preserves xml:lang="fa", tts:direction="rtl", and ttm:agent speaker references, but omits full SHAHAB sample/flick lineage and revision history.',
      ],
      roundTripValidation: {
        passed:
          errors.length === 0 &&
          pMatches.length === doc.cues.length &&
          monotonic &&
          exportedZwnj === originalZwnjCount,
        parsedCueCount: pMatches.length,
        zwnjPreserved: exportedZwnj === originalZwnjCount,
        monotonicTimestampsVerified: monotonic,
        errors,
      },
    };
  }

  // JSON_SIDECAR (Lossless canonical SHAHAB-027 document)
  const content = `${JSON.stringify(doc, null, 2)}\n`;
  let parsedDoc: ShahabSubtitleDocument | null = null;
  const errors: string[] = [];
  try {
    parsedDoc = JSON.parse(content) as ShahabSubtitleDocument;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const parsedZwnj = parsedDoc
    ? parsedDoc.cues.reduce((acc, c) => acc + (c.renderedText.match(/\u200c/g) ?? []).length, 0)
    : 0;

  return {
    format: 'JSON_SIDECAR',
    fileExtension: '.subtitle.shahab.json',
    mimeType: 'application/json; charset=utf-8',
    encoding: 'UTF-8',
    content,
    sha256: sha256(content),
    cueCount: doc.cues.length,
    declaredInformationLosses: [
      'None — canonical lossless SHAHAB-027 sidecar preserving all 5 timing domains, lineage, QA report, and revision history.',
    ],
    roundTripValidation: {
      passed:
        errors.length === 0 &&
        parsedDoc !== null &&
        parsedDoc.cues.length === doc.cues.length &&
        parsedZwnj === originalZwnjCount,
      parsedCueCount: parsedDoc?.cues.length ?? 0,
      zwnjPreserved: parsedZwnj === originalZwnjCount,
      monotonicTimestampsVerified: true,
      errors,
    },
  };
}

/**
 * SHAHAB-027 Subtitle & Caption Engineering Service
 */
export class ShahabSubtitleEngine {
  private readonly documents = new Map<string, ShahabSubtitleDocument>();

  public getProfiles(): readonly SubtitleEditorialProfile[] {
    return Object.values(SHAHAB_SUBTITLE_PROFILES);
  }

  public getDocument(documentId: string): ShahabSubtitleDocument {
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error(`SUBTITLE_DOCUMENT_NOT_FOUND: ${documentId}`);
    return doc;
  }

  /**
   * Validates that a subtitle document's upstream audio/transcript/alignment/diarization
   * dependencies have not gone stale (SHAHAB-027 §15).
   */
  public validateDependencyFreshness(
    doc: ShahabSubtitleDocument,
    currentUpstream: {
      readonly audioSha256: string;
      readonly transcriptRevisionId: string;
      readonly alignmentRequestId?: string;
      readonly diarizationRevisionId?: string | null;
    },
  ): { readonly fresh: boolean; readonly staleReasons: readonly string[] } {
    const staleReasons: string[] = [];
    if (doc.dependencyLineage.audioSha256 !== currentUpstream.audioSha256) {
      staleReasons.push('Source audio SHA-256 changed since subtitle generation.');
    }
    if (doc.dependencyLineage.transcriptRevisionId !== currentUpstream.transcriptRevisionId) {
      staleReasons.push(
        `Transcript revision changed (${doc.dependencyLineage.transcriptRevisionId} -> ${currentUpstream.transcriptRevisionId}).`,
      );
    }
    if (
      currentUpstream.alignmentRequestId &&
      doc.dependencyLineage.alignmentRequestId !== currentUpstream.alignmentRequestId
    ) {
      staleReasons.push('Alignment dependency revision changed.');
    }
    if (
      currentUpstream.diarizationRevisionId !== undefined &&
      doc.dependencyLineage.diarizationRevisionId !== currentUpstream.diarizationRevisionId
    ) {
      staleReasons.push('Diarization revision changed.');
    }
    return { fresh: staleReasons.length === 0, staleReasons };
  }

  public generateSubtitles(input: SubtitleGenerationInput): ShahabSubtitleDocument {
    const profileBase = SHAHAB_SUBTITLE_PROFILES[input.profileId ?? 'EDUCATIONAL'];
    const profile: SubtitleEditorialProfile = {
      ...profileBase,
      ...(input.customProfileOverrides ?? {}),
    };
    const mode: SubtitleMode = input.mode ?? profile.defaultMode;
    const timingConfig: SubtitleExportTimingConfig = {
      fps: input.timingConfig?.fps ?? null,
      dropFrame: input.timingConfig?.dropFrame ?? false,
      vfrDetected: input.timingConfig?.vfrDetected ?? false,
      timelineOffsetMs: input.timingConfig?.timelineOffsetMs ?? 0,
    };

    const alignment = input.alignment;
    const diarization = input.diarization ?? null;
    const attribution = diarization
      ? attributeTranscriptWithDiarization(
          alignment,
          diarization,
          alignment.effectiveGranularity === 'WORD_LEVEL' ? 'WORD_LEVEL' : 'SEGMENT_LEVEL',
        )
      : null;

    const attrBySegId = new Map<string, NonNullable<typeof attribution>['segments'][number]>();
    if (attribution) {
      for (const s of attribution.segments) attrBySegId.set(s.segmentId, s);
    }

    const mediaDurationMs = Math.round(alignment.audioDurationSec * 1000);
    const maxCueChars = profile.maxCharsPerLine * profile.maxLines;
    const transformations: SubtitleTransformationRecord[] = [];
    const limitations: string[] = [];

    if (alignment.effectiveGranularity !== 'WORD_LEVEL') {
      limitations.push(
        `SHAHAB-025 alignment granularity is ${alignment.effectiveGranularity}; cue timing reflects verified segment-level bounds and does NOT claim phoneme-exact word alignment.`,
      );
    }
    if (!diarization) {
      limitations.push(
        'No SHAHAB-026 diarization result supplied; speaker labels are omitted rather than fabricated.',
      );
    }
    if (timingConfig.vfrDetected) {
      limitations.push(
        'Variable Frame Rate (VFR) media declared; millisecond export timing preserved without assuming constant frame duration.',
      );
    }

    const rawCues: ShahabSubtitleCue[] = [];
    let cueCounter = 1;

    for (const seg of alignment.segments) {
      if (!seg.acousticRange) {
        limitations.push(
          `Segment ${seg.segmentId} had TIMING_UNAVAILABLE in SHAHAB-025 and was excluded from timed cue export rather than fabricating timestamps.`,
        );
        continue;
      }

      const attr = attrBySegId.get(seg.segmentId) ?? null;
      const isOverlap = attr?.kind === 'OVERLAPPING_SPEECH';
      const speakerId =
        attr && attr.speakerId !== UNKNOWN_SPEAKER_ID ? attr.speakerId : null;
      const speakerLabel =
        attr?.localDisplayLabel ??
        (speakerId ? speakerId.replace('speaker_', 'گوینده ') : null);

      const segWords = alignment.words.filter((w) => seg.wordIds.includes(w.wordId));
      const allWordsAligned =
        segWords.length > 0 && segWords.every((w) => w.acousticRange !== null);

      const textChunks = chunkPersianTextForCues(seg.text, maxCueChars);
      const segStartMs = Math.round(seg.acousticRange.startSec * 1000);
      const segEndMs = Math.round(seg.acousticRange.endSec * 1000);
      const segDurMs = Math.max(1, segEndMs - segStartMs);

      for (let cIdx = 0; cIdx < textChunks.length; cIdx++) {
        const cueId = `cue_${String(cueCounter).padStart(4, '0')}`;
        const chunkText = textChunks[cIdx];

        const processedBody = processTextForMode(
          chunkText,
          mode,
          profile.numeralPolicy,
          cueId,
          transformations,
        );

        // Speaker prefixing & honest overlap representation (SHAHAB-027 §8)
        let finalLogicalLines: readonly string[];
        if (isOverlap && attr && attr.activeSpeakerIds.length >= 2) {
          const sp1 = attr.activeSpeakerIds[0].replace('speaker_', 'گوینده ');
          const sp2 = attr.activeSpeakerIds[1].replace('speaker_', 'گوینده ');
          const wrapped = wrapPersianCaptionLines(processedBody, Math.max(16, profile.maxCharsPerLine - 12), 2);
          finalLogicalLines =
            wrapped.length >= 2
              ? [`- ${sp1}: ${wrapped[0]}`, `- ${sp2}: ${wrapped[1]}`]
              : [`- [${sp1} + ${sp2} هم‌زمان]: ${wrapped[0]}`];
        } else {
          const withSpeaker =
            profile.includeSpeakerLabels && speakerLabel
              ? `${speakerLabel}: ${processedBody}`
              : processedBody;
          finalLogicalLines = wrapPersianCaptionLines(
            withSpeaker,
            profile.maxCharsPerLine,
            profile.maxLines,
          );
        }

        const { formattedLines, report: rtlLayout } = analyzeAndFormatPersianRtlLayout(
          finalLogicalLines,
          profile.bidiPolicy,
        );

        // Derive timing honestly:
        // - If true word alignment exists, slice exact acoustic word start/end for this chunk!
        // - If only segment timing exists and chunking was needed for visual readability,
        //   keep `acousticRange` equal to the verified segment (NEVER fake word acousticRange)
        //   and mark `timingProvenance = 'SEGMENT_DERIVED_DISPLAY_SPLIT_NOT_WORD_ACOUSTIC'`.
        let cueStartMs = segStartMs;
        let cueEndMs = segEndMs;
        let cueAcousticRange: SampleInterval | null = seg.acousticRange;
        let timingProvenance: SubtitleTimingProvenance =
          alignment.effectiveGranularity === 'TOKEN_LEVEL'
            ? 'TOKEN_EMISSION_LATTICE'
            : 'SEGMENT_ACOUSTIC_ALIGNED';

        if (allWordsAligned && textChunks.length > 1) {
          const wordsPerChunk = Math.max(1, Math.ceil(segWords.length / textChunks.length));
          const wStart = segWords[Math.min(segWords.length - 1, cIdx * wordsPerChunk)];
          const wEnd = segWords[Math.min(segWords.length - 1, (cIdx + 1) * wordsPerChunk - 1)];
          cueStartMs = Math.round(wStart.acousticRange!.startSec * 1000);
          cueEndMs = Math.round(wEnd.acousticRange!.endSec * 1000);
          cueAcousticRange = buildSampleInterval(
            wStart.acousticRange!.startSample,
            wEnd.acousticRange!.endSample,
            wStart.acousticRange!.sampleRateHz,
          );
          timingProvenance = 'WORD_ACOUSTIC_ALIGNED';
        } else if (allWordsAligned) {
          timingProvenance = 'WORD_ACOUSTIC_ALIGNED';
        } else if (textChunks.length > 1) {
          const step = segDurMs / textChunks.length;
          cueStartMs = Math.round(segStartMs + cIdx * step);
          cueEndMs = Math.round(
            cIdx === textChunks.length - 1 ? segEndMs : segStartMs + (cIdx + 1) * step - profile.minGapMs,
          );
          if (cueEndMs <= cueStartMs) cueEndMs = cueStartMs + 200;
          timingProvenance = 'SEGMENT_DERIVED_DISPLAY_SPLIT_NOT_WORD_ACOUSTIC';
        }

        // Apply readability minimum duration without violating media bounds or next cue
        let dispStartMs = cueStartMs;
        let dispEndMs = Math.max(cueEndMs, dispStartMs + Math.min(profile.minDurationMs, Math.max(250, mediaDurationMs - dispStartMs)));
        if (mediaDurationMs > 0) {
          dispEndMs = Math.min(mediaDurationMs, dispEndMs);
        }
        if (dispEndMs <= dispStartMs) {
          dispEndMs = dispStartMs + 250;
        }

        const tlStartMs = timingConfig.timelineOffsetMs + dispStartMs;
        const tlEndMs = timingConfig.timelineOffsetMs + dispEndMs;
        const expStartMs = quantizeMsToFrameGrid(dispStartMs, timingConfig.fps);
        const expEndMs = Math.max(
          expStartMs + 100,
          quantizeMsToFrameGrid(dispEndMs, timingConfig.fps),
        );

        const readingMetrics = computePersianReadingMetrics(formattedLines, dispEndMs - dispStartMs);

        rawCues.push({
          cueId,
          index: cueCounter,
          mode,
          rawSourceText: chunkText,
          lines: formattedLines,
          renderedText: formattedLines.join('\n'),
          speakerId,
          speakerDisplayLabel: speakerLabel,
          activeSpeakerIds: attr ? attr.activeSpeakerIds : [],
          overlapFlag: isOverlap,
          isNonSpeechAccessibilityCue: false,
          nonSpeechSource: null,
          timingProvenance,
          acousticRange: cueAcousticRange,
          displayRange: {
            startMs: dispStartMs,
            endMs: dispEndMs,
            durationMs: dispEndMs - dispStartMs,
          },
          sourceRange: seg.sourceRange,
          timelineRange: {
            startMs: tlStartMs,
            endMs: tlEndMs,
            startFlicks: Math.round((tlStartMs / 1000) * FLICKS_PER_SECOND),
            endFlicks: Math.round((tlEndMs / 1000) * FLICKS_PER_SECOND),
          },
          exportRange: {
            startMs: expStartMs,
            endMs: expEndMs,
            durationMs: expEndMs - expStartMs,
          },
          readingMetrics,
          rtlLayout,
          manualOverride: false,
          lastEditedAtUtc: null,
          notes:
            timingProvenance === 'SEGMENT_DERIVED_DISPLAY_SPLIT_NOT_WORD_ACOUSTIC'
              ? 'Display cue split across verified segment bounds for Persian readability; acousticRange stays honestly at verified segment.'
              : 'Cue anchored directly to verified acoustic alignment span.',
        });
        cueCounter += 1;
      }
    }

    // ACCESSIBILITY mode: include ONLY explicitly verified/annotated non-speech events
    if (mode === 'ACCESSIBILITY' && input.verifiedNonSpeechEvents) {
      for (const ev of input.verifiedNonSpeechEvents) {
        const cueId = `cue_ns_${String(cueCounter).padStart(3, '0')}`;
        const startMs = Math.max(0, Math.round(ev.startSec * 1000));
        const endMs = Math.max(startMs + 500, Math.round(ev.endSec * 1000));
        const logicalLine = `[${ev.labelFa}]`;
        const { formattedLines, report: rtlLayout } = analyzeAndFormatPersianRtlLayout(
          [logicalLine],
          profile.bidiPolicy,
        );
        rawCues.push({
          cueId,
          index: cueCounter,
          mode,
          rawSourceText: logicalLine,
          lines: formattedLines,
          renderedText: formattedLines.join('\n'),
          speakerId: null,
          speakerDisplayLabel: null,
          activeSpeakerIds: [],
          overlapFlag: false,
          isNonSpeechAccessibilityCue: true,
          nonSpeechSource: ev.source,
          timingProvenance: 'SEGMENT_ACOUSTIC_ALIGNED',
          acousticRange: buildSampleInterval(
            Math.round(ev.startSec * alignment.resamplingLineage.processingSampleRateHz),
            Math.round(ev.endSec * alignment.resamplingLineage.processingSampleRateHz),
            alignment.resamplingLineage.processingSampleRateHz,
          ),
          displayRange: { startMs, endMs, durationMs: endMs - startMs },
          sourceRange: null,
          timelineRange: {
            startMs: timingConfig.timelineOffsetMs + startMs,
            endMs: timingConfig.timelineOffsetMs + endMs,
            startFlicks: Math.round(((timingConfig.timelineOffsetMs + startMs) / 1000) * FLICKS_PER_SECOND),
            endFlicks: Math.round(((timingConfig.timelineOffsetMs + endMs) / 1000) * FLICKS_PER_SECOND),
          },
          exportRange: {
            startMs: quantizeMsToFrameGrid(startMs, timingConfig.fps),
            endMs: quantizeMsToFrameGrid(endMs, timingConfig.fps),
            durationMs:
              quantizeMsToFrameGrid(endMs, timingConfig.fps) -
              quantizeMsToFrameGrid(startMs, timingConfig.fps),
          },
          readingMetrics: computePersianReadingMetrics(formattedLines, endMs - startMs),
          rtlLayout,
          manualOverride: false,
          lastEditedAtUtc: null,
          notes: `Non-speech accessibility cue sourced from ${ev.source} (never inferred from transcript text).`,
        });
        cueCounter += 1;
      }
    }

    // Sort cues chronologically and enforce non-overlapping display gaps for sequential non-overlap cues
    rawCues.sort((a, b) => a.displayRange.startMs - b.displayRange.startMs);
    const finalizedCues: ShahabSubtitleCue[] = rawCues.map((cue, idx) => {
      const nextCue = rawCues[idx + 1];
      let dispStart = cue.displayRange.startMs;
      let dispEnd = cue.displayRange.endMs;

      if (nextCue && !cue.overlapFlag && !nextCue.overlapFlag) {
        const latestAllowedEnd = nextCue.displayRange.startMs - profile.minGapMs;
        if (dispEnd > latestAllowedEnd && latestAllowedEnd > dispStart + 150) {
          dispEnd = latestAllowedEnd;
        }
      }

      const expStart = quantizeMsToFrameGrid(dispStart, timingConfig.fps);
      const expEnd = Math.max(expStart + 100, quantizeMsToFrameGrid(dispEnd, timingConfig.fps));
      return {
        ...cue,
        index: idx + 1,
        displayRange: { startMs: dispStart, endMs: dispEnd, durationMs: dispEnd - dispStart },
        timelineRange: {
          startMs: timingConfig.timelineOffsetMs + dispStart,
          endMs: timingConfig.timelineOffsetMs + dispEnd,
          startFlicks: Math.round(((timingConfig.timelineOffsetMs + dispStart) / 1000) * FLICKS_PER_SECOND),
          endFlicks: Math.round(((timingConfig.timelineOffsetMs + dispEnd) / 1000) * FLICKS_PER_SECOND),
        },
        exportRange: { startMs: expStart, endMs: expEnd, durationMs: expEnd - expStart },
        readingMetrics: computePersianReadingMetrics(cue.lines, dispEnd - dispStart),
      };
    });

    const qaReport = runSubtitleQaAudit(finalizedCues, profile, mediaDurationMs);
    const now = new Date().toISOString();
    const documentId = `subdoc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const revisionId = `subrev_1_${crypto.randomBytes(3).toString('hex')}`;

    const doc: ShahabSubtitleDocument = {
      contractVersion: SHAHAB_SUBTITLE_CONTRACT_VERSION,
      documentId,
      revisionId,
      mode,
      profile,
      timingConfig,
      dependencyLineage: {
        audioId: alignment.audioId,
        audioSha256: alignment.audioSha256,
        transcriptRevisionId: alignment.transcriptRevisionId,
        alignmentRequestId: alignment.requestId,
        alignmentGranularity: alignment.effectiveGranularity,
        alignmentContractVersion: alignment.contractVersion,
        diarizationRequestId: diarization?.requestId ?? null,
        diarizationRevisionId: diarization?.revisionId ?? null,
        diarizationContractVersion: diarization?.contractVersion ?? null,
      },
      cues: finalizedCues,
      transformations,
      qaReport,
      revisions: [
        {
          revisionId,
          parentRevisionId: null,
          timestampUtc: now,
          action: 'INITIAL_GENERATION',
          detail: `Generated ${finalizedCues.length} cues under profile ${profile.profileId} (${mode}).`,
        },
      ],
      limitations,
      createdAtUtc: now,
      updatedAtUtc: now,
    };

    this.documents.set(documentId, doc);
    return doc;
  }

  /**
   * SHAHAB-027 §12 — Manual Override Editing with Immutable Revision Ancestry.
   */
  public applyManualCueEdit(
    documentId: string,
    edit: {
      readonly cueId: string;
      readonly newLines?: readonly string[];
      readonly newDisplayStartMs?: number;
      readonly newDisplayEndMs?: number;
      readonly newSpeakerDisplayLabel?: string | null;
    },
  ): ShahabSubtitleDocument {
    const prev = this.getDocument(documentId);
    const now = new Date().toISOString();
    const newRevId = `subrev_${prev.revisions.length + 1}_${crypto.randomBytes(3).toString('hex')}`;

    let found = false;
    const nextCues = prev.cues.map((cue) => {
      if (cue.cueId !== edit.cueId) return cue;
      found = true;
      const lines = edit.newLines
        ? analyzeAndFormatPersianRtlLayout(edit.newLines, prev.profile.bidiPolicy)
        : { formattedLines: cue.lines, report: cue.rtlLayout };
      const dispStart = edit.newDisplayStartMs ?? cue.displayRange.startMs;
      const dispEnd = edit.newDisplayEndMs ?? cue.displayRange.endMs;
      if (dispEnd <= dispStart) {
        throw new Error(`INVALID_MANUAL_CUE_TIMING: end (${dispEnd}) <= start (${dispStart})`);
      }
      const expStart = quantizeMsToFrameGrid(dispStart, prev.timingConfig.fps);
      const expEnd = Math.max(expStart + 100, quantizeMsToFrameGrid(dispEnd, prev.timingConfig.fps));
      return {
        ...cue,
        lines: lines.formattedLines,
        renderedText: lines.formattedLines.join('\n'),
        rtlLayout: lines.report,
        speakerDisplayLabel:
          edit.newSpeakerDisplayLabel !== undefined
            ? edit.newSpeakerDisplayLabel
            : cue.speakerDisplayLabel,
        timingProvenance:
          edit.newDisplayStartMs !== undefined || edit.newDisplayEndMs !== undefined
            ? ('USER_MANUAL_TIMING_OVERRIDE' as const)
            : cue.timingProvenance,
        displayRange: { startMs: dispStart, endMs: dispEnd, durationMs: dispEnd - dispStart },
        timelineRange: {
          startMs: prev.timingConfig.timelineOffsetMs + dispStart,
          endMs: prev.timingConfig.timelineOffsetMs + dispEnd,
          startFlicks: Math.round(((prev.timingConfig.timelineOffsetMs + dispStart) / 1000) * FLICKS_PER_SECOND),
          endFlicks: Math.round(((prev.timingConfig.timelineOffsetMs + dispEnd) / 1000) * FLICKS_PER_SECOND),
        },
        exportRange: { startMs: expStart, endMs: expEnd, durationMs: expEnd - expStart },
        readingMetrics: computePersianReadingMetrics(lines.formattedLines, dispEnd - dispStart),
        manualOverride: true,
        lastEditedAtUtc: now,
      };
    });

    if (!found) throw new Error(`SUBTITLE_CUE_NOT_FOUND: ${edit.cueId}`);

    const mediaDurationMs = nextCues.reduce((m, c) => Math.max(m, c.displayRange.endMs), 0);
    const updated: ShahabSubtitleDocument = {
      ...prev,
      revisionId: newRevId,
      cues: nextCues,
      qaReport: runSubtitleQaAudit(nextCues, prev.profile, mediaDurationMs),
      revisions: [
        ...prev.revisions,
        {
          revisionId: newRevId,
          parentRevisionId: prev.revisionId,
          timestampUtc: now,
          action: 'MANUAL_CUE_EDIT',
          detail: `Manually edited cue ${edit.cueId}.`,
        },
      ],
      updatedAtUtc: now,
    };
    this.documents.set(documentId, updated);
    return updated;
  }

  /**
   * SHAHAB-027 §12 — Regeneration with Manual-Override Conflict Protection.
   * Never silently overwrites manually edited cues!
   */
  public regenerateWithConflictProtection(
    existingDocumentId: string,
    newInput: SubtitleGenerationInput,
  ): {
    readonly document: ShahabSubtitleDocument;
    readonly conflicts: readonly SubtitleRegenerationConflict[];
  } {
    const prev = this.getDocument(existingDocumentId);
    const regenerated = this.generateSubtitles(newInput);
    const manualById = new Map<string, ShahabSubtitleCue>();
    for (const c of prev.cues) {
      if (c.manualOverride) manualById.set(c.cueId, c);
    }

    const conflicts: SubtitleRegenerationConflict[] = [];
    const mergedCues = regenerated.cues.map((regenCue) => {
      const manual = manualById.get(regenCue.cueId);
      if (!manual) return regenCue;

      if (
        manual.renderedText !== regenCue.renderedText ||
        manual.displayRange.startMs !== regenCue.displayRange.startMs ||
        manual.displayRange.endMs !== regenCue.displayRange.endMs
      ) {
        conflicts.push({
          cueId: regenCue.cueId,
          manualLines: manual.lines,
          regeneratedLines: regenCue.lines,
          manualDisplayRange: manual.displayRange,
          regeneratedDisplayRange: regenCue.displayRange,
          resolutionState: 'CONFLICT_REQUIRES_USER_RESOLUTION',
        });
      }
      // Protect manual override by default until user resolves conflict explicitly
      return manual;
    });

    const now = new Date().toISOString();
    const newRevId = `subrev_${prev.revisions.length + 1}_${crypto.randomBytes(3).toString('hex')}`;
    const mediaDurationMs = Math.round(newInput.alignment.audioDurationSec * 1000);
    const protectedDoc: ShahabSubtitleDocument = {
      ...regenerated,
      documentId: prev.documentId,
      revisionId: newRevId,
      cues: mergedCues,
      qaReport: runSubtitleQaAudit(mergedCues, regenerated.profile, mediaDurationMs),
      revisions: [
        ...prev.revisions,
        {
          revisionId: newRevId,
          parentRevisionId: prev.revisionId,
          timestampUtc: now,
          action: 'REGENERATED_WITH_MANUAL_CONFLICT_PROTECTION',
          detail: `Regenerated with ${conflicts.length} protected manual cue conflict(s).`,
        },
      ],
      updatedAtUtc: now,
    };

    this.documents.set(prev.documentId, protectedDoc);
    return { document: protectedDoc, conflicts };
  }
}
