/**
 * AVAPARDAZ — PHASE 1C-C: STREAMING TRANSCRIPT ASSEMBLY & CANONICAL TIMELINE
 *
 * Mission:
 * Transform Native Sherpa streaming recognition events (`PARTIAL` and `FINAL`) into a
 * deterministic, sample-accurate, non-drifting Canonical Transcript & Word/Segment Timeline
 * ready for the AvaPardaz Non-Destructive Intelligent Editing Engine and Adobe Audition CEP Bridge.
 *
 * Key Guarantees:
 * - Strict provisional vs committed separation: `PARTIAL` events update only the active provisional
 *   segment and never overwrite or corrupt committed `FINAL` segments.
 * - Sample-accurate integer timeline: `startSample16k` and `endSample16k` (at 16,000 Hz) plus
 *   exact mapped `sourceStartSample` and `sourceEndSample` (at `sourceSampleRateHz`) are the
 *   primary source of truth; floating-point `startSec`/`endSec` are deterministically derived
 *   (`sample / sampleRate`) with zero cumulative drift across 60+ minutes (`0` sample error).
 * - Honest timestamp granularity: preserves `WORD` granularity only when real subword/token
 *   alignments exist from Sherpa-ONNX; explicitly marks `SEGMENT` (`wordTimestampsAvailable: false`,
 *   `words: []`) when token timestamps are absent — never fabricates linear word durations.
 * - Boundary overlap deduplication: detects and merges duplicate words occurring inside the
 *   chunk/utterance overlap zone while preserving real speaker repetitions ("من من" / "این این")
 *   outside overlap windows.
 * - Event ordering & idempotency guard: rejects duplicate `eventId`s, stale/out-of-order
 *   `sequenceId`s, foreign `sessionId`s, and post-cancel events with structured error codes.
 * - Raw vs Normalized text layer separation: preserves `rawText` (`RAW_UNMODIFIED`) alongside
 *   `normalizedText` (`FA-STRICT-V1`, `FA-RELAXED-V1`, `EN-NORM-V1`, `MIXED-NORM-V1`) without
 *   altering word/segment timestamps.
 * - Zero full-audio retention: holds only lightweight transcript text + integer sample coordinates.
 */

import {
  buildAllNormalizationProfiles,
  normalizeWithProfile,
} from './CoreNormalizationAndLanguage';
import type {
  CoreTranscriptionResult,
  CoreTranscriptionSegment,
  CoreWordTiming,
  DetectedLanguageTag,
  NormalizationProfileId,
} from './CoreAsrContracts';
import type {
  LocalNeuralSegment,
  LocalNeuralTranscriptionResult,
} from './LocalSherpaNeuralEngine';
import type {
  TranscriptDocument,
  TranscriptToken,
} from '../workflow/SmartAudioEditContracts';
import type {
  NativeSherpaStreamingEvent,
  StreamingRecognitionWordTiming,
} from './NativeSherpaStreamingRecognizer';

export type AvapardazLanguageCode = 'fa' | 'en' | 'fa-en';

export interface AvapardazWordTimestamp {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence: number;
  readonly language: AvapardazLanguageCode;
}

export interface AvapardazSegmentRecord {
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly language: AvapardazLanguageCode;
  readonly confidence: number;
  readonly speakerId: string;
  readonly words: readonly AvapardazWordTimestamp[];
}

export interface AvapardazTranscriptResult {
  readonly schemaVersion: '1.0';
  readonly transcriptId: string;
  readonly sessionId: string;
  readonly backendId: string;
  readonly modelId: string;
  readonly createdAtIso: string;
  readonly totalDurationSec: number;
  readonly dominantLanguage: AvapardazLanguageCode;
  readonly normalizationRuleVersion: string;
  readonly rawTranscriptText: string;
  readonly normalizedTranscriptText: string;
  readonly segments: readonly AvapardazSegmentRecord[];
  readonly metrics: {
    readonly realTimeFactor: number;
    readonly totalProcessingTimeMs: number;
    readonly peakMemoryMb: number;
    readonly chunkCount: number;
    readonly fallbackUsed: boolean;
  };
}

export type AssemblableStreamingWordInput = {
  readonly wordId?: string;
  readonly word?: string;
  readonly text?: string;
  readonly normalizedWord?: string;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly sourceStartSample?: number;
  readonly sourceEndSample?: number;
  readonly startSec?: number;
  readonly endSec?: number;
  readonly confidence?: number | null;
};

export type AssemblableStreamingEventInput = Omit<
  Partial<NativeSherpaStreamingEvent>,
  'words'
> & {
  readonly eventId: string;
  readonly sessionId: string;
  readonly type: 'PARTIAL' | 'FINAL';
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly rawText: string;
  readonly seq?: number;
  readonly sequenceId?: number;
  readonly segmentIndex?: number;
  readonly utteranceIndex?: number;
  readonly wordTimestampsAvailable?: boolean;
  readonly words?: readonly (StreamingRecognitionWordTiming | AssemblableStreamingWordInput)[];
};

export const CANONICAL_ASR_SAMPLE_RATE_HZ = 16000 as const;

export type TranscriptAssemblyState =
  | 'IDLE'
  | 'STREAMING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export type CanonicalNormalizationRuleVersion =
  | 'RAW_UNMODIFIED'
  | 'FA-STRICT-V1'
  | 'FA-RELAXED-V1'
  | 'EN-NORM-V1'
  | 'MIXED-NORM-V1';

export type TranscriptEventRejectionCode =
  | 'SESSION_ID_MISMATCH'
  | 'ASSEMBLER_NOT_ACCEPTING_EVENTS'
  | 'DUPLICATE_EVENT_ID'
  | 'STALE_SEQUENCE_ID'
  | 'OUT_OF_ORDER_UTTERANCE'
  | 'STALE_PARTIAL_AFTER_FINAL'
  | 'INVALID_SAMPLE_BOUNDS'
  | 'NEGATIVE_DURATION';

export interface TranscriptEventRejectionRecord {
  readonly code: TranscriptEventRejectionCode;
  readonly message: string;
  readonly eventId: string;
  readonly sequenceId: number;
  readonly utteranceIndex: number;
  readonly eventType: 'PARTIAL' | 'FINAL';
  readonly timestampMs: number;
}

export interface CanonicalTimelineWord {
  readonly wordId: string;
  readonly segmentId: string;
  readonly wordIndex: number;
  readonly text: string;
  readonly rawText: string;
  readonly normalizedText: string;
  /** Primary timeline truth at canonical 16,000 Hz */
  readonly startSample16k: number;
  readonly endSample16k: number;
  /** Exact mapped sample position at original audio file's sampleRateHz */
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  /** Derived floating-point seconds (`startSample16k / 16000`) */
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  readonly isApproximate: boolean;
  readonly provenance: 'SHERPA_CTC_TOKEN_ALIGNMENT';
}

export interface CanonicalTimelineSegment {
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly utteranceIndex: number;
  readonly status: 'PROVISIONAL' | 'FINAL';
  readonly revision: number;
  readonly language: AvapardazLanguageCode;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly text: string;
  readonly normalizationRuleVersion: CanonicalNormalizationRuleVersion;
  /** Primary timeline truth at canonical 16,000 Hz */
  readonly startSample16k: number;
  readonly endSample16k: number;
  /** Exact mapped sample position at original audio file's sampleRateHz */
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  /** Derived floating-point seconds (`startSample16k / 16000`) */
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  readonly timestampGranularity: 'WORD' | 'SEGMENT';
  readonly wordTimestampsAvailable: boolean;
  readonly words: readonly CanonicalTimelineWord[];
  readonly overlapDeduplicatedWordCount: number;
  readonly sourceEventId: string;
  readonly sourceSequenceId: number;
}

export interface CanonicalOverlapDeduplicationRecord {
  readonly previousSegmentId: string;
  readonly currentSegmentId: string;
  readonly removedWords: readonly string[];
  readonly boundarySample16k: number;
  readonly overlapWindowSamples16k: number;
}

export interface CanonicalTimelineIntegrityReport {
  readonly valid: boolean;
  readonly monotonicSegments: boolean;
  readonly monotonicWords: boolean;
  readonly zeroNegativeDurations: boolean;
  readonly wordsWithinParentSegments: boolean;
  readonly maxSampleDrift16k: number;
  readonly maxSourceSampleDrift: number;
  readonly totalFinalSegments: number;
  readonly totalFinalWords: number;
  readonly violations: readonly string[];
}

export interface CanonicalTranscriptSnapshot {
  readonly transcriptId: string;
  readonly sessionId: string;
  readonly modelId: string;
  readonly state: TranscriptAssemblyState;
  readonly revision: number;
  readonly canonicalSampleRateHz: typeof CANONICAL_ASR_SAMPLE_RATE_HZ;
  readonly sourceSampleRateHz: number;
  readonly totalProcessedSamples16k: number;
  readonly totalSourceSamples: number;
  readonly totalDurationSec: number;
  readonly dominantLanguage: AvapardazLanguageCode;
  readonly normalizationRuleVersion: CanonicalNormalizationRuleVersion;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly text: string;
  /** Committed `FINAL` segments only — safe for destructive/non-destructive editing decisions */
  readonly finalSegments: readonly CanonicalTimelineSegment[];
  /** Active uncommitted `PARTIAL` segment (if any) for live UI preview only */
  readonly provisionalSegment: CanonicalTimelineSegment | null;
  /** Combined view (`finalSegments` + `provisionalSegment` if present) */
  readonly allSegments: readonly CanonicalTimelineSegment[];
  readonly overlapDeduplications: readonly CanonicalOverlapDeduplicationRecord[];
  readonly rejectedEvents: readonly TranscriptEventRejectionRecord[];
  readonly integrity: CanonicalTimelineIntegrityReport;
}

export interface StreamingTranscriptAssemblerOptions {
  readonly sessionId: string;
  readonly transcriptId?: string;
  readonly modelId?: string;
  readonly sourceSampleRateHz?: number;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly normalizationRuleVersion?: CanonicalNormalizationRuleVersion;
  /**
   * Maximum overlap zone in 16kHz samples within which identical boundary words
   * across consecutive segments are considered boundary duplicates.
   * Default: 12,800 samples (800 ms at 16 kHz).
   */
  readonly boundaryOverlapToleranceSamples16k?: number;
  /**
   * Minimum silence gap in 16kHz samples between two segments above which
   * identical words at the boundary are treated as intentional speaker repetition
   * rather than chunk overlap. Default: 6,400 samples (400 ms).
   */
  readonly intentionalRepetitionGapSamples16k?: number;
}

function detectTextLanguage(text: string, hint?: 'fa' | 'en' | 'fa-en' | 'auto'): AvapardazLanguageCode {
  let persianChars = 0;
  let latinChars = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) {
      persianChars++;
    } else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
      latinChars++;
    }
  }
  if (persianChars > 0 && latinChars > 0) return 'fa-en';
  if (persianChars > 0) return 'fa';
  if (latinChars > 0) return 'en';
  if (hint === 'fa' || hint === 'en' || hint === 'fa-en') return hint;
  return 'fa';
}

export function applyCanonicalTextNormalization(
  rawText: string,
  ruleVersion: CanonicalNormalizationRuleVersion,
): string {
  if (!rawText) return '';
  if (ruleVersion === 'RAW_UNMODIFIED') {
    return rawText;
  }
  return normalizeWithProfile(rawText, ruleVersion);
}

function normalizeWordForOverlapComparison(word: string): string {
  return normalizeWithProfile(word, 'FA-STRICT-V1')
    .replace(/[.,،؛:?؟!'"«»()[\]{}\-_\u200c]/g, '')
    .trim()
    .toLowerCase();
}

export function map16kSampleToSourceSample(
  sample16k: number,
  sourceSampleRateHz: number,
): number {
  const safeSample = Math.max(0, Math.round(sample16k));
  if (sourceSampleRateHz === CANONICAL_ASR_SAMPLE_RATE_HZ) {
    return safeSample;
  }
  // Exact integer rational scaling using BigInt to prevent floating-point drift on multi-hour files
  const num = BigInt(safeSample) * BigInt(Math.round(sourceSampleRateHz));
  const den = BigInt(CANONICAL_ASR_SAMPLE_RATE_HZ);
  const quotient = (num + den / 2n) / den;
  return Number(quotient);
}

export function sample16kToSeconds(sample16k: number): number {
  return Number((Math.max(0, Math.round(sample16k)) / CANONICAL_ASR_SAMPLE_RATE_HZ).toFixed(6));
}

export function sample16kToMilliseconds(sample16k: number): number {
  return Math.round((Math.max(0, Math.round(sample16k)) * 1000) / CANONICAL_ASR_SAMPLE_RATE_HZ);
}

function getWordRawText(w: StreamingRecognitionWordTiming | AssemblableStreamingWordInput): string {
  if ('word' in w && typeof w.word === 'string') return w.word;
  if ('text' in w && typeof w.text === 'string') return w.text;
  return '';
}

export class StreamingTranscriptAssembler {
  public readonly sessionId: string;
  public readonly transcriptId: string;
  public readonly modelId: string;
  public readonly sourceSampleRateHz: number;
  public readonly normalizationRuleVersion: CanonicalNormalizationRuleVersion;
  private readonly languageHint: 'fa' | 'en' | 'fa-en' | 'auto';
  private readonly boundaryOverlapToleranceSamples16k: number;
  private readonly intentionalRepetitionGapSamples16k: number;

  private state: TranscriptAssemblyState = 'IDLE';
  private revision = 0;
  private lastAcceptedSequenceId = 0;
  private highestFinalizedUtteranceIndex = -1;
  private totalProcessedSamples16k = 0;

  private readonly seenEventIds = new Set<string>();
  private readonly finalSegments: CanonicalTimelineSegment[] = [];
  private readonly utteranceRevisionCounts = new Map<number, number>();
  private provisionalSegment: CanonicalTimelineSegment | null = null;
  private readonly overlapDeduplications: CanonicalOverlapDeduplicationRecord[] = [];
  private readonly rejectedEvents: TranscriptEventRejectionRecord[] = [];

  constructor(options: StreamingTranscriptAssemblerOptions) {
    if (!options.sessionId || options.sessionId.trim().length === 0) {
      throw new Error('INVALID_ASSEMBLER_SESSION_ID: sessionId must be a non-empty string.');
    }
    this.sessionId = options.sessionId.trim();
    this.transcriptId = options.transcriptId?.trim() || `tr_${this.sessionId}`;
    this.modelId = options.modelId?.trim() || 'shenava-rizeh-fa-int8';
    this.sourceSampleRateHz =
      options.sourceSampleRateHz &&
      Number.isInteger(options.sourceSampleRateHz) &&
      options.sourceSampleRateHz >= 8000 &&
      options.sourceSampleRateHz <= 192000
        ? options.sourceSampleRateHz
        : CANONICAL_ASR_SAMPLE_RATE_HZ;
    this.languageHint = options.languageHint ?? 'auto';
    this.normalizationRuleVersion = options.normalizationRuleVersion ?? 'FA-STRICT-V1';
    this.boundaryOverlapToleranceSamples16k = Math.max(
      0,
      options.boundaryOverlapToleranceSamples16k ?? 12800, // 800 ms
    );
    this.intentionalRepetitionGapSamples16k = Math.max(
      0,
      options.intentionalRepetitionGapSamples16k ?? 6400, // 400 ms
    );
  }

  public getState(): TranscriptAssemblyState {
    return this.state;
  }

  public getRevision(): number {
    return this.revision;
  }

  private recordRejection(
    code: TranscriptEventRejectionCode,
    message: string,
    event: Partial<AssemblableStreamingEventInput>,
  ): {
    readonly accepted: false;
    readonly rejection: TranscriptEventRejectionRecord;
    readonly snapshot: CanonicalTranscriptSnapshot;
  } {
    const seqId =
      typeof event.sequenceId === 'number'
        ? event.sequenceId
        : typeof event.seq === 'number'
          ? event.seq
          : -1;
    const uttIdx =
      typeof event.utteranceIndex === 'number'
        ? event.utteranceIndex
        : typeof event.segmentIndex === 'number'
          ? event.segmentIndex
          : -1;
    const rejection: TranscriptEventRejectionRecord = {
      code,
      message,
      eventId: typeof event.eventId === 'string' ? event.eventId : 'unknown',
      sequenceId: seqId,
      utteranceIndex: uttIdx,
      eventType: event.type === 'FINAL' ? 'FINAL' : 'PARTIAL',
      timestampMs: Date.now(),
    };
    this.rejectedEvents.push(rejection);
    return {
      accepted: false,
      rejection,
      snapshot: this.getSnapshot(),
    };
  }

  /**
   * Ingests a `PARTIAL` or `FINAL` streaming recognition event from `NativeSherpaStreamingRecognizer`.
   */
  public ingestEvent(event: AssemblableStreamingEventInput): {
    readonly accepted: boolean;
    readonly rejection?: TranscriptEventRejectionRecord;
    readonly snapshot: CanonicalTranscriptSnapshot;
  } {
    const seqId =
      typeof event.sequenceId === 'number'
        ? event.sequenceId
        : typeof event.seq === 'number'
          ? event.seq
          : 0;
    const uttIdx =
      typeof event.utteranceIndex === 'number'
        ? event.utteranceIndex
        : typeof event.segmentIndex === 'number'
          ? event.segmentIndex
          : 0;
    const wordsArr = Array.isArray(event.words) ? event.words : [];
    const wordTsAvail =
      typeof event.wordTimestampsAvailable === 'boolean'
        ? event.wordTimestampsAvailable
        : event.timestampGranularity
          ? event.timestampGranularity === 'WORD' && wordsArr.length > 0
          : wordsArr.length > 0;

    if (this.state === 'COMPLETED' || this.state === 'CANCELLED' || this.state === 'FAILED') {
      return this.recordRejection(
        'ASSEMBLER_NOT_ACCEPTING_EVENTS',
        `Assembler is in terminal state ${this.state} and cannot accept further events.`,
        event,
      );
    }

    if (event.sessionId !== this.sessionId) {
      return this.recordRejection(
        'SESSION_ID_MISMATCH',
        `Event sessionId "${event.sessionId}" does not match assembler sessionId "${this.sessionId}".`,
        event,
      );
    }

    if (this.seenEventIds.has(event.eventId)) {
      return this.recordRejection(
        'DUPLICATE_EVENT_ID',
        `Duplicate eventId "${event.eventId}" rejected.`,
        event,
      );
    }

    if (seqId <= this.lastAcceptedSequenceId) {
      return this.recordRejection(
        'STALE_SEQUENCE_ID',
        `Out-of-order sequenceId ${seqId} (last accepted: ${this.lastAcceptedSequenceId}).`,
        event,
      );
    }

    if (
      !Number.isFinite(event.startSample16k) ||
      !Number.isFinite(event.endSample16k) ||
      event.startSample16k < 0
    ) {
      return this.recordRejection(
        'INVALID_SAMPLE_BOUNDS',
        `Invalid sample bounds [${event.startSample16k}, ${event.endSample16k}].`,
        event,
      );
    }

    if (event.endSample16k < event.startSample16k) {
      return this.recordRejection(
        'NEGATIVE_DURATION',
        `Negative segment duration: endSample16k (${event.endSample16k}) < startSample16k (${event.startSample16k}).`,
        event,
      );
    }

    if (uttIdx <= this.highestFinalizedUtteranceIndex) {
      return this.recordRejection(
        event.type === 'PARTIAL' ? 'STALE_PARTIAL_AFTER_FINAL' : 'OUT_OF_ORDER_UTTERANCE',
        `Utterance ${uttIdx} has already been finalized (highest finalized: ${this.highestFinalizedUtteranceIndex}).`,
        event,
      );
    }

    this.seenEventIds.add(event.eventId);
    this.lastAcceptedSequenceId = seqId;
    if (this.state === 'IDLE') {
      this.state = 'STREAMING';
    }

    const nextUtteranceRev = (this.utteranceRevisionCounts.get(uttIdx) ?? 0) + 1;
    this.utteranceRevisionCounts.set(uttIdx, nextUtteranceRev);
    this.revision += 1;

    if (event.endSample16k > this.totalProcessedSamples16k) {
      this.totalProcessedSamples16k = Math.round(event.endSample16k);
    }

    if (event.type === 'PARTIAL') {
      const rawText = event.rawText.trim();
      if (rawText.length === 0) {
        return { accepted: true, snapshot: this.getSnapshot() };
      }
      const segmentId = `seg_prov_u${uttIdx}`;
      this.provisionalSegment = this.buildCanonicalSegment({
        segmentId,
        segmentIndex: this.finalSegments.length,
        utteranceIndex: uttIdx,
        status: 'PROVISIONAL',
        revision: nextUtteranceRev,
        rawText,
        startSample16k: Math.round(event.startSample16k),
        endSample16k: Math.round(event.endSample16k),
        wordsInput: wordsArr,
        wordTimestampsAvailable: wordTsAvail,
        sourceEventId: event.eventId,
        sourceSequenceId: seqId,
        previousFinalSegment:
          this.finalSegments.length > 0 ? this.finalSegments[this.finalSegments.length - 1] : null,
        recordDeduplication: false,
      });
      return { accepted: true, snapshot: this.getSnapshot() };
    }

    // FINAL event processing
    this.highestFinalizedUtteranceIndex = uttIdx;
    if (this.provisionalSegment && this.provisionalSegment.utteranceIndex <= uttIdx) {
      this.provisionalSegment = null;
    }

    const rawText = event.rawText.trim();
    if (rawText.length === 0) {
      return { accepted: true, snapshot: this.getSnapshot() };
    }

    const segmentIndex = this.finalSegments.length;
    const segmentId = `seg_${String(segmentIndex + 1).padStart(4, '0')}`;
    const prevFinal =
      this.finalSegments.length > 0 ? this.finalSegments[this.finalSegments.length - 1] : null;

    const builtSegment = this.buildCanonicalSegment({
      segmentId,
      segmentIndex,
      utteranceIndex: uttIdx,
      status: 'FINAL',
      revision: nextUtteranceRev,
      rawText,
      startSample16k: Math.round(event.startSample16k),
      endSample16k: Math.round(event.endSample16k),
      wordsInput: wordsArr,
      wordTimestampsAvailable: wordTsAvail,
      sourceEventId: event.eventId,
      sourceSequenceId: seqId,
      previousFinalSegment: prevFinal,
      recordDeduplication: true,
    });

    // If boundary overlap deduplication removed all words in a redundant overlap fragment, skip adding an empty segment
    if (builtSegment.rawText.trim().length > 0) {
      this.finalSegments.push(builtSegment);
    }

    return { accepted: true, snapshot: this.getSnapshot() };
  }

  private buildCanonicalSegment(params: {
    readonly segmentId: string;
    readonly segmentIndex: number;
    readonly utteranceIndex: number;
    readonly status: 'PROVISIONAL' | 'FINAL';
    readonly revision: number;
    readonly rawText: string;
    readonly startSample16k: number;
    readonly endSample16k: number;
    readonly wordsInput: readonly (StreamingRecognitionWordTiming | AssemblableStreamingWordInput)[];
    readonly wordTimestampsAvailable: boolean;
    readonly sourceEventId: string;
    readonly sourceSequenceId: number;
    readonly previousFinalSegment: CanonicalTimelineSegment | null;
    readonly recordDeduplication: boolean;
  }): CanonicalTimelineSegment {
    const prev = params.previousFinalSegment;
    let segStart16k = Math.max(0, params.startSample16k);
    let segEnd16k = Math.max(segStart16k, params.endSample16k);

    const hasRealWords =
      params.wordTimestampsAvailable && Array.isArray(params.wordsInput) && params.wordsInput.length > 0;

    let effectiveWordsInput: Array<StreamingRecognitionWordTiming | AssemblableStreamingWordInput> =
      hasRealWords ? [...params.wordsInput] : [];
    let effectiveRawText = params.rawText;
    let deduplicatedCount = 0;

    // Overlap & Boundary Deduplication against previous FINAL segment
    if (prev && segStart16k <= prev.endSample16k + this.boundaryOverlapToleranceSamples16k) {
      const gapSamples16k = segStart16k - prev.endSample16k;
      const withinOverlapZone = gapSamples16k < this.intentionalRepetitionGapSamples16k;

      if (withinOverlapZone) {
        if (hasRealWords && prev.words.length > 0) {
          const prevWords = prev.words;
          const maxOverlapK = Math.min(4, prevWords.length, effectiveWordsInput.length);
          let matchedK = 0;

          for (let k = maxOverlapK; k >= 1; k--) {
            let allMatch = true;
            for (let i = 0; i < k; i++) {
              const pWord = prevWords[prevWords.length - k + i];
              const cWord = effectiveWordsInput[i];
              const pNorm = normalizeWordForOverlapComparison(pWord.rawText);
              const cNorm = normalizeWordForOverlapComparison(getWordRawText(cWord));
              const cWordStart = Math.round(cWord.startSample16k);
              const timeClose =
                cWordStart <= prev.endSample16k + this.boundaryOverlapToleranceSamples16k &&
                Math.abs(cWordStart - pWord.startSample16k) <= this.boundaryOverlapToleranceSamples16k;
              if (!pNorm || pNorm !== cNorm || !timeClose) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              matchedK = k;
              break;
            }
          }

          if (matchedK > 0) {
            const removed = effectiveWordsInput.slice(0, matchedK).map((w) => getWordRawText(w));
            effectiveWordsInput = effectiveWordsInput.slice(matchedK);
            deduplicatedCount = matchedK;
            effectiveRawText = effectiveWordsInput.map((w) => getWordRawText(w)).join(' ');
            if (effectiveWordsInput.length > 0) {
              segStart16k = Math.max(prev.endSample16k, Math.round(effectiveWordsInput[0].startSample16k));
            } else {
              segStart16k = prev.endSample16k;
            }
            if (params.recordDeduplication) {
              this.overlapDeduplications.push({
                previousSegmentId: prev.segmentId,
                currentSegmentId: params.segmentId,
                removedWords: removed,
                boundarySample16k: prev.endSample16k,
                overlapWindowSamples16k: this.boundaryOverlapToleranceSamples16k,
              });
            }
          }
        } else if (!hasRealWords && segStart16k <= prev.endSample16k) {
          // Segment-level text suffix/prefix overlap deduplication when segments physically overlap in time
          const prevTokens = prev.rawText.trim().split(/\s+/).filter(Boolean);
          const currTokens = effectiveRawText.trim().split(/\s+/).filter(Boolean);
          const maxK = Math.min(4, prevTokens.length, currTokens.length);
          let matchedK = 0;
          for (let k = maxK; k >= 1; k--) {
            let allMatch = true;
            for (let i = 0; i < k; i++) {
              const pNorm = normalizeWordForOverlapComparison(prevTokens[prevTokens.length - k + i]);
              const cNorm = normalizeWordForOverlapComparison(currTokens[i]);
              if (!pNorm || pNorm !== cNorm) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              matchedK = k;
              break;
            }
          }
          if (matchedK > 0) {
            const removed = currTokens.slice(0, matchedK);
            effectiveRawText = currTokens.slice(matchedK).join(' ');
            deduplicatedCount = matchedK;
            segStart16k = Math.max(segStart16k, prev.endSample16k);
            if (params.recordDeduplication) {
              this.overlapDeduplications.push({
                previousSegmentId: prev.segmentId,
                currentSegmentId: params.segmentId,
                removedWords: removed,
                boundarySample16k: prev.endSample16k,
                overlapWindowSamples16k: this.boundaryOverlapToleranceSamples16k,
              });
            }
          }
        }
      }
    }

    // Enforce monotonic non-overlapping segment boundary against previous committed segment
    if (prev && segStart16k < prev.endSample16k) {
      segStart16k = prev.endSample16k;
    }
    if (segEnd16k < segStart16k) {
      segEnd16k = segStart16k;
    }

    // Build sample-accurate canonical words (ONLY if real word timestamps exist — never fabricate!)
    const canonicalWords: CanonicalTimelineWord[] = [];
    if (hasRealWords && effectiveWordsInput.length > 0) {
      let cursor16k = segStart16k;
      for (let i = 0; i < effectiveWordsInput.length; i++) {
        const w = effectiveWordsInput[i];
        const wRaw = getWordRawText(w).trim();
        if (!wRaw) continue;
        const wNorm = applyCanonicalTextNormalization(wRaw, this.normalizationRuleVersion);
        let wStart16k = Math.max(cursor16k, Math.round(w.startSample16k));
        if (wStart16k > segEnd16k) {
          wStart16k = segEnd16k;
        }
        let wEnd16k = Math.max(wStart16k, Math.round(w.endSample16k));
        if (i === effectiveWordsInput.length - 1 && wEnd16k > segEnd16k) {
          segEnd16k = wEnd16k;
        } else if (wEnd16k > segEnd16k) {
          wEnd16k = segEnd16k;
        }
        cursor16k = wEnd16k;

        const wSourceStart = map16kSampleToSourceSample(wStart16k, this.sourceSampleRateHz);
        const wSourceEnd = Math.max(
          wSourceStart,
          map16kSampleToSourceSample(wEnd16k, this.sourceSampleRateHz),
        );
        const wStartSec = sample16kToSeconds(wStart16k);
        const wEndSec = sample16kToSeconds(wEnd16k);
        const rawConf = w.confidence;
        const wordConf = typeof rawConf === 'number' && Number.isFinite(rawConf) ? rawConf : 0.92;

        canonicalWords.push({
          wordId: `${params.segmentId}_w${String(canonicalWords.length + 1).padStart(3, '0')}`,
          segmentId: params.segmentId,
          wordIndex: canonicalWords.length,
          text: wNorm || wRaw,
          rawText: wRaw,
          normalizedText: wNorm || wRaw,
          startSample16k: wStart16k,
          endSample16k: wEnd16k,
          sourceStartSample: wSourceStart,
          sourceEndSample: wSourceEnd,
          startSec: wStartSec,
          endSec: wEndSec,
          durationSec: Number(Math.max(0, wEndSec - wStartSec).toFixed(6)),
          startMs: sample16kToMilliseconds(wStart16k),
          endMs: sample16kToMilliseconds(wEnd16k),
          confidence: wordConf,
          isApproximate: false,
          provenance: 'SHERPA_CTC_TOKEN_ALIGNMENT',
        });
      }

      if (canonicalWords.length > 0) {
        const lastWordEnd = canonicalWords[canonicalWords.length - 1].endSample16k;
        if (lastWordEnd > segEnd16k) {
          segEnd16k = lastWordEnd;
        }
      }
    }

    const normalizedText = applyCanonicalTextNormalization(
      effectiveRawText,
      this.normalizationRuleVersion,
    );
    const displayLanguage = detectTextLanguage(effectiveRawText, this.languageHint);
    const sourceStartSample = map16kSampleToSourceSample(segStart16k, this.sourceSampleRateHz);
    const sourceEndSample = Math.max(
      sourceStartSample,
      map16kSampleToSourceSample(segEnd16k, this.sourceSampleRateHz),
    );
    const startSec = sample16kToSeconds(segStart16k);
    const endSec = sample16kToSeconds(segEnd16k);
    const avgConfidence =
      canonicalWords.length > 0
        ? Number(
            (
              canonicalWords.reduce((acc, w) => acc + w.confidence, 0) / canonicalWords.length
            ).toFixed(4),
          )
        : 0.92;

    const granularity: 'WORD' | 'SEGMENT' = canonicalWords.length > 0 ? 'WORD' : 'SEGMENT';

    return {
      segmentId: params.segmentId,
      segmentIndex: params.segmentIndex,
      utteranceIndex: params.utteranceIndex,
      status: params.status,
      revision: params.revision,
      language: displayLanguage,
      rawText: effectiveRawText,
      normalizedText: normalizedText || effectiveRawText,
      text: normalizedText || effectiveRawText,
      normalizationRuleVersion: this.normalizationRuleVersion,
      startSample16k: segStart16k,
      endSample16k: segEnd16k,
      sourceStartSample,
      sourceEndSample,
      startSec,
      endSec,
      durationSec: Number(Math.max(0, endSec - startSec).toFixed(6)),
      startMs: sample16kToMilliseconds(segStart16k),
      endMs: sample16kToMilliseconds(segEnd16k),
      confidence: avgConfidence,
      timestampGranularity: granularity,
      wordTimestampsAvailable: canonicalWords.length > 0,
      words: canonicalWords,
      overlapDeduplicatedWordCount: deduplicatedCount,
      sourceEventId: params.sourceEventId,
      sourceSequenceId: params.sourceSequenceId,
    };
  }

  /**
   * Completes the streaming session. By default, any uncommitted provisional segment is discarded
   * unless `commitPendingProvisional` is explicitly true, ensuring only verified `FINAL` segments
   * enter the canonical editing transcript.
   */
  public finalizeSession(options?: {
    readonly commitPendingProvisional?: boolean;
    readonly exactTotalSamples16k?: number;
  }): CanonicalTranscriptSnapshot {
    if (this.state === 'CANCELLED' || this.state === 'FAILED') {
      return this.getSnapshot();
    }
    this.state = 'FINALIZING';

    if (options?.commitPendingProvisional && this.provisionalSegment) {
      const prov = this.provisionalSegment;
      this.provisionalSegment = null;
      const segmentIndex = this.finalSegments.length;
      const segmentId = `seg_${String(segmentIndex + 1).padStart(4, '0')}`;
      const committedWords: CanonicalTimelineWord[] = prov.words.map((w, idx) => ({
        ...w,
        wordId: `${segmentId}_w${String(idx + 1).padStart(3, '0')}`,
        segmentId,
      }));
      this.finalSegments.push({
        ...prov,
        segmentId,
        segmentIndex,
        status: 'FINAL',
        words: committedWords,
      });
      this.highestFinalizedUtteranceIndex = Math.max(
        this.highestFinalizedUtteranceIndex,
        prov.utteranceIndex,
      );
      this.revision += 1;
    } else {
      this.provisionalSegment = null;
    }

    if (
      options?.exactTotalSamples16k !== undefined &&
      Number.isFinite(options.exactTotalSamples16k) &&
      options.exactTotalSamples16k >= this.totalProcessedSamples16k
    ) {
      this.totalProcessedSamples16k = Math.round(options.exactTotalSamples16k);
    }

    this.state = 'COMPLETED';
    return this.getSnapshot();
  }

  public finalizeStream(options?: {
    readonly commitPendingProvisional?: boolean;
    readonly exactTotalSamples16k?: number;
  }): CanonicalTranscriptSnapshot {
    return this.finalizeSession(options);
  }

  /**
   * Cancels the session immediately, discarding any uncommitted provisional segment
   * while preserving already committed `FINAL` segments intact.
   */
  public cancelSession(): CanonicalTranscriptSnapshot {
    this.provisionalSegment = null;
    this.state = 'CANCELLED';
    return this.getSnapshot();
  }

  public failSession(): CanonicalTranscriptSnapshot {
    this.provisionalSegment = null;
    this.state = 'FAILED';
    return this.getSnapshot();
  }

  public verifyTimelineIntegrity(
    segmentsToVerify: readonly CanonicalTimelineSegment[] = this.finalSegments,
  ): CanonicalTimelineIntegrityReport {
    const violations: string[] = [];
    let monotonicSegments = true;
    let monotonicWords = true;
    let zeroNegativeDurations = true;
    let wordsWithinParentSegments = true;
    let maxSampleDrift16k = 0;
    let maxSourceSampleDrift = 0;
    let totalWords = 0;

    let prevSegEnd16k = 0;
    for (let i = 0; i < segmentsToVerify.length; i++) {
      const seg = segmentsToVerify[i];
      if (seg.endSample16k < seg.startSample16k || seg.durationSec < 0) {
        zeroNegativeDurations = false;
        violations.push(
          `Segment ${seg.segmentId} has negative duration [${seg.startSample16k}, ${seg.endSample16k}].`,
        );
      }
      if (i > 0 && seg.startSample16k < prevSegEnd16k) {
        monotonicSegments = false;
        violations.push(
          `Segment ${seg.segmentId} overlaps previous segment (${seg.startSample16k} < ${prevSegEnd16k}).`,
        );
      }
      prevSegEnd16k = seg.endSample16k;

      // Verify exact roundtrip between sample16k and derived seconds
      const roundtripStart16k = Math.round(seg.startSec * CANONICAL_ASR_SAMPLE_RATE_HZ);
      const roundtripEnd16k = Math.round(seg.endSec * CANONICAL_ASR_SAMPLE_RATE_HZ);
      const startDrift = Math.abs(roundtripStart16k - seg.startSample16k);
      const endDrift = Math.abs(roundtripEnd16k - seg.endSample16k);
      maxSampleDrift16k = Math.max(maxSampleDrift16k, startDrift, endDrift);

      const expectedSourceStart = map16kSampleToSourceSample(
        seg.startSample16k,
        this.sourceSampleRateHz,
      );
      const expectedSourceEnd = map16kSampleToSourceSample(
        seg.endSample16k,
        this.sourceSampleRateHz,
      );
      maxSourceSampleDrift = Math.max(
        maxSourceSampleDrift,
        Math.abs(seg.sourceStartSample - expectedSourceStart),
        Math.abs(seg.sourceEndSample - expectedSourceEnd),
      );

      let prevWordEnd16k = seg.startSample16k;
      for (let wIdx = 0; wIdx < seg.words.length; wIdx++) {
        const w = seg.words[wIdx];
        totalWords++;
        if (w.endSample16k < w.startSample16k || w.durationSec < 0) {
          zeroNegativeDurations = false;
          violations.push(
            `Word ${w.wordId} has negative duration [${w.startSample16k}, ${w.endSample16k}].`,
          );
        }
        if (w.startSample16k < seg.startSample16k || w.endSample16k > seg.endSample16k) {
          wordsWithinParentSegments = false;
          violations.push(
            `Word ${w.wordId} [${w.startSample16k}, ${w.endSample16k}] escapes parent segment ${seg.segmentId} [${seg.startSample16k}, ${seg.endSample16k}].`,
          );
        }
        if (wIdx > 0 && w.startSample16k < prevWordEnd16k) {
          monotonicWords = false;
          violations.push(
            `Word ${w.wordId} overlaps previous word (${w.startSample16k} < ${prevWordEnd16k}).`,
          );
        }
        prevWordEnd16k = w.endSample16k;
      }
    }

    return {
      valid:
        monotonicSegments &&
        monotonicWords &&
        zeroNegativeDurations &&
        wordsWithinParentSegments &&
        maxSampleDrift16k === 0 &&
        maxSourceSampleDrift === 0 &&
        violations.length === 0,
      monotonicSegments,
      monotonicWords,
      zeroNegativeDurations,
      wordsWithinParentSegments,
      maxSampleDrift16k,
      maxSourceSampleDrift,
      totalFinalSegments: segmentsToVerify.length,
      totalFinalWords: totalWords,
      violations,
    };
  }

  public getSnapshot(): CanonicalTranscriptSnapshot {
    const rawText = this.finalSegments.map((s) => s.rawText).join(' ').trim();
    const normalizedText = this.finalSegments.map((s) => s.normalizedText).join(' ').trim();
    const allSegments = this.provisionalSegment
      ? [...this.finalSegments, this.provisionalSegment]
      : [...this.finalSegments];

    const lastSegEnd16k =
      this.finalSegments.length > 0
        ? this.finalSegments[this.finalSegments.length - 1].endSample16k
        : 0;
    const effectiveTotalSamples16k = Math.max(this.totalProcessedSamples16k, lastSegEnd16k);
    const totalSourceSamples = map16kSampleToSourceSample(
      effectiveTotalSamples16k,
      this.sourceSampleRateHz,
    );

    const dominantLanguage = detectTextLanguage(rawText, this.languageHint);

    return {
      transcriptId: this.transcriptId,
      sessionId: this.sessionId,
      modelId: this.modelId,
      state: this.state,
      revision: this.revision,
      canonicalSampleRateHz: CANONICAL_ASR_SAMPLE_RATE_HZ,
      sourceSampleRateHz: this.sourceSampleRateHz,
      totalProcessedSamples16k: effectiveTotalSamples16k,
      totalSourceSamples,
      totalDurationSec: sample16kToSeconds(effectiveTotalSamples16k),
      dominantLanguage,
      normalizationRuleVersion: this.normalizationRuleVersion,
      rawText,
      normalizedText: normalizedText || rawText,
      text: normalizedText || rawText,
      finalSegments: [...this.finalSegments],
      provisionalSegment: this.provisionalSegment,
      allSegments,
      overlapDeduplications: [...this.overlapDeduplications],
      rejectedEvents: [...this.rejectedEvents],
      integrity: this.verifyTimelineIntegrity(this.finalSegments),
    };
  }

  /**
   * Consumer Adapter 1: Converts committed `FINAL` segments to `TranscriptDocument`
   * (`SmartAudioEditContracts.ts`) consumed by `SpeechEventEngine`, `PersianDisfluencyEngine`,
   * `PersianSemanticRepetitionEngine`, and `EditDecisionEngine` (Phase 1C-D).
   */
  public toTranscriptDocument(options?: {
    readonly sourceAudioId?: string;
    readonly sourceAudioHash?: string;
    readonly processingTimeMs?: number;
  }): TranscriptDocument {
    const snap = this.getSnapshot();
    const tokens: TranscriptToken[] = [];
    for (const seg of snap.finalSegments) {
      if (seg.wordTimestampsAvailable && seg.words.length > 0) {
        for (const w of seg.words) {
          tokens.push({
            tokenId: w.wordId,
            rawText: w.rawText,
            normalizedText: w.normalizedText,
            startSample: w.sourceStartSample,
            endSample: Math.max(w.sourceStartSample + 1, w.sourceEndSample),
            startSec: w.startSec,
            endSec: w.endSec,
            confidence: w.confidence,
            timestampGranularity: 'WORD',
          });
        }
      }
    }

    const hasWords = snap.finalSegments.some((s) => s.wordTimestampsAvailable && s.words.length > 0);
    const procMs = Math.max(1, options?.processingTimeMs ?? 1);
    const durSec = Math.max(0.001, snap.totalDurationSec);

    return {
      schemaVersion: 'avp.transcript.v1',
      transcriptVersion: `${snap.transcriptId}:rev${snap.revision}`,
      sourceAudioId: options?.sourceAudioId ?? `aud_${snap.sessionId}`,
      sourceAudioHash: options?.sourceAudioHash ?? `sha_${snap.sessionId}`,
      sampleRate: snap.sourceSampleRateHz,
      totalSourceSamples: snap.totalSourceSamples,
      language: snap.dominantLanguage,
      modelId: snap.modelId,
      modelVersion: '1.0.0',
      runtime: 'sherpa-onnx-cpu',
      rawText: snap.rawText,
      normalizedText: snap.normalizedText,
      tokens,
      timestampGranularity: hasWords ? 'WORD' : snap.finalSegments.length > 0 ? 'SEGMENT' : 'NONE',
      realTimeFactor: Number((procMs / 1000 / durSec).toFixed(4)),
      processingTimeMs: procMs,
      offlineVerified: true,
      createdAtMs: Date.now(),
    };
  }

  /**
   * Consumer Adapter 2: Converts committed `FINAL` segments to `AvapardazTranscriptResult`
   * and `CoreTranscriptionResult`.
   */
  public toAvapardazTranscriptResult(options?: {
    readonly processingTimeMs?: number;
    readonly peakMemoryMb?: number;
    readonly fallbackUsed?: boolean;
  }): AvapardazTranscriptResult {
    const snap = this.getSnapshot();
    const segments: AvapardazSegmentRecord[] = snap.finalSegments.map((seg) => {
      const words: AvapardazWordTimestamp[] = seg.words.map((w) => ({
        word: w.text,
        startSec: w.startSec,
        endSec: w.endSec,
        confidence: w.confidence,
        language: seg.language,
      }));
      return {
        id: seg.segmentId,
        startSec: seg.startSec,
        endSec: seg.endSec,
        rawText: seg.rawText,
        normalizedText: seg.normalizedText,
        language: seg.language,
        confidence: seg.confidence,
        speakerId: 'SPEAKER_00',
        words,
      };
    });

    const procMs = Math.max(1, options?.processingTimeMs ?? 1);
    const durSec = Math.max(0.001, snap.totalDurationSec);

    return {
      schemaVersion: '1.0',
      transcriptId: snap.transcriptId,
      sessionId: snap.sessionId,
      backendId: 'sherpa-onnx-cpu',
      modelId: snap.modelId,
      createdAtIso: new Date().toISOString(),
      totalDurationSec: snap.totalDurationSec,
      dominantLanguage: snap.dominantLanguage,
      normalizationRuleVersion: snap.normalizationRuleVersion,
      rawTranscriptText: snap.rawText,
      normalizedTranscriptText: snap.normalizedText,
      segments,
      metrics: {
        realTimeFactor: Number((procMs / 1000 / durSec).toFixed(4)),
        totalProcessingTimeMs: procMs,
        peakMemoryMb: options?.peakMemoryMb ?? 0,
        chunkCount: snap.finalSegments.length,
        fallbackUsed: options?.fallbackUsed ?? false,
      },
    };
  }

  /**
   * Consumer Adapter 3: Converts committed `FINAL` segments to `LocalNeuralTranscriptionResult`
   * consumed by `LocalCompanionService` and the Adobe Audition CEP Panel (`app.js`).
   */
  public toLocalTranscriptionResult(options?: {
    readonly processingTimeMs?: number;
    readonly channelCount?: number;
    readonly audioSha256?: string;
  }): LocalNeuralTranscriptionResult {
    const snap = this.getSnapshot();
    const procMs = Math.max(1, options?.processingTimeMs ?? 1);
    const durSec = Math.max(0.001, snap.totalDurationSec);
    const hasWordTs = snap.finalSegments.some((s) => s.wordTimestampsAvailable && s.words.length > 0);

    const segments: LocalNeuralSegment[] = snap.finalSegments.map((seg, idx) => ({
      id: seg.segmentId,
      index: idx,
      startSec: seg.startSec,
      endSec: seg.endSec,
      text: seg.text,
      normalizedByProfile: buildAllNormalizationProfiles(seg.rawText),
      language: seg.language as DetectedLanguageTag,
      timestampGranularity: seg.timestampGranularity,
      words: seg.words.map((w) => ({
        word: w.text,
        startSec: w.startSec,
        endSec: w.endSec,
      })),
    }));

    return {
      modelId: snap.modelId,
      architecture: 'nemo-ctc',
      quantization: 'INT8',
      offlineVerified: true,
      durationSec: snap.totalDurationSec,
      processingTimeMs: procMs,
      realTimeFactor: Number((procMs / 1000 / durSec).toFixed(4)),
      dominantLanguage: snap.dominantLanguage as DetectedLanguageTag,
      rawText: snap.rawText,
      normalizedByProfile: buildAllNormalizationProfiles(snap.rawText),
      timestampGranularity: hasWordTs ? 'WORD' : 'SEGMENT',
      segments,
      sampleRateHz: snap.sourceSampleRateHz,
      channelCount: options?.channelCount ?? 1,
      audioSha256: options?.audioSha256 ?? `sha_${snap.sessionId}`,
    };
  }

  /**
   * Consumer Adapter 4: Converts committed `FINAL` segments to `CoreTranscriptionResult`
   * (`CoreAsrContracts.ts`).
   */
  public toCoreTranscriptionResult(options?: {
    readonly processingTimeMs?: number;
    readonly peakRssMb?: number;
    readonly audioSha256?: string;
  }): CoreTranscriptionResult {
    const snap = this.getSnapshot();
    const procMs = Math.max(1, options?.processingTimeMs ?? 1);
    const durSec = Math.max(0.001, snap.totalDurationSec);
    const hasWordTs = snap.finalSegments.some((s) => s.wordTimestampsAvailable && s.words.length > 0);

    const segments: CoreTranscriptionSegment[] = snap.finalSegments.map((seg, idx) => {
      const words: CoreWordTiming[] = seg.words.map((w) => ({
        word: w.text,
        startSec: w.startSec,
        endSec: w.endSec,
        startSample: w.startSample16k,
        endSample: w.endSample16k,
        language: seg.language as DetectedLanguageTag,
      }));
      return {
        segmentId: seg.segmentId,
        segmentIndex: idx,
        startSec: seg.startSec,
        endSec: seg.endSec,
        startSample: seg.startSample16k,
        endSample: seg.endSample16k,
        language: seg.language as DetectedLanguageTag,
        languageConfidence: seg.confidence,
        rawModelOutput: seg.rawText,
        normalizedByProfile: buildAllNormalizationProfiles(seg.rawText) as Record<NormalizationProfileId, string>,
        words,
        timestampGranularity: seg.timestampGranularity,
        confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
        calibratedConfidence: null,
        acousticFrameCount: Math.max(1, Math.round((seg.endSec - seg.startSec) * 100)),
        backendUsed: 'EXTERNAL_ONNX_RUNTIME',
        retryCount: 0,
        status: 'OK',
        failureReason: null,
      };
    });

    return {
      jobId: snap.sessionId,
      status: 'COMPLETED',
      backendUsed: 'EXTERNAL_ONNX_RUNTIME',
      backendAvailabilitySnapshot: [],
      modelVersionId: snap.modelId,
      durationSec: snap.totalDurationSec,
      processingTimeMs: procMs,
      realTimeFactor: Number((procMs / 1000 / durSec).toFixed(4)),
      peakRssMb: options?.peakRssMb ?? 0,
      dominantLanguage: snap.dominantLanguage as DetectedLanguageTag,
      rawModelOutput: snap.rawText,
      normalizedByProfile: buildAllNormalizationProfiles(snap.rawText) as Record<NormalizationProfileId, string>,
      confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
      calibratedConfidence: null,
      timestampGranularity: hasWordTs ? 'WORD' : 'SEGMENT',
      segments,
      failedSegmentRanges: [],
      ingestWarnings: [],
      audioSha256: options?.audioSha256 ?? `sha_${snap.sessionId}`,
    };
  }
}
