import { PersianCtcForcedAligner } from '../ai-engine/PersianCtcForcedAligner';
import {
  asSourceSamplePosition,
  SourceSamplePosition,
  TimelineDisplaySec,
} from './SamplePosition';
import { flicksToSourceSampleExact, sourceSampleToDisplaySec } from './TimeConversion';

export type ForcedAlignmentState =
  | 'ALIGNED'
  | 'APPROXIMATE'
  | 'UNALIGNED'
  | 'AMBIGUOUS'
  | 'FAILED'
  | 'NOT_EVALUATED';

export type AlignmentMethodKind =
  | 'CTC_VITERBI_FORCED_ALIGNMENT'
  | 'ASR_TOKEN_TIMESTAMP'
  | 'PROPORTIONAL_APPROXIMATION'
  | 'NONE';

export interface AlignedTranscriptToken {
  readonly tokenId: string;
  /** Strictly untouched verbatim transcript token */
  readonly originalToken: string;
  /** Derived matching representation (never overwrites originalToken) */
  readonly alignmentNormalizedText: string;
  /** Derived display-normalized representation */
  readonly displayNormalizedText: string;
  readonly sourceStartSample: SourceSamplePosition | null;
  readonly sourceEndSample: SourceSamplePosition | null;
  readonly derivedStartSec: TimelineDisplaySec | null;
  readonly derivedEndSec: TimelineDisplaySec | null;
  readonly sampleRate: number;
  readonly alignmentState: ForcedAlignmentState;
  readonly alignmentMethod: AlignmentMethodKind;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly acousticScore: number | null;
  readonly evidenceProvenance: string;
  readonly warnings: readonly string[];
}

export interface PersianForcedAlignmentOutput {
  readonly tokens: readonly AlignedTranscriptToken[];
  readonly alignedCount: number;
  readonly approximateCount: number;
  readonly unalignedCount: number;
  readonly ambiguousCount: number;
}

const PUNCTUATION_ONLY_RE = /^[\s.,!?;:،؛؟«»()\[\]{}"'\-–—…]+$/;

export function buildAlignmentNormalizedForm(original: string): {
  readonly alignmentNormalized: string;
  readonly displayNormalized: string;
  readonly isPunctuationOnly: boolean;
  readonly ambiguousMapping: boolean;
} {
  const trimmed = original.trim();
  const isPunctuationOnly = PUNCTUATION_ONLY_RE.test(trimmed);
  // Display preserves Persian ی/ک and ZWNJ cleanly
  const displayNormalized = trimmed.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
  // Alignment form strips diacritics & punctuation while mapping Arabic variants for CTC vocab lookup
  const alignmentNormalized = displayNormalized
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[.,!?;:،؛؟«»()\[\]{}"']/g, '')
    .trim();
  const ambiguousMapping =
    !isPunctuationOnly && alignmentNormalized.length === 0 && trimmed.length > 0;

  return {
    alignmentNormalized,
    displayNormalized,
    isPunctuationOnly,
    ambiguousMapping,
  };
}

/**
 * Executes genuine CTC Viterbi forced alignment when acoustic frame log-probabilities are available.
 * NEVER fabricates acoustic alignment via proportional interpolation: if logProbs are absent,
 * tokens are explicitly marked UNALIGNED or APPROXIMATE with honest provenance.
 */
export function runPersianForcedAlignmentContract(params: {
  readonly words: readonly { readonly id: string; readonly text: string }[];
  readonly sourceSampleRate: number;
  readonly totalSourceSamples: number;
  readonly logProbsPerFrame?: readonly Float32Array[] | null;
  readonly charToVocabId?: ReadonlyMap<string, number> | null;
  readonly frameDurationSec?: number;
  readonly chunkStartSourceSample?: SourceSamplePosition;
  readonly modelId?: string | null;
  readonly modelVersion?: string | null;
  readonly allowApproximateFallback?: boolean;
}): PersianForcedAlignmentOutput {
  const { words, sourceSampleRate, totalSourceSamples } = params;
  if (words.length === 0) {
    return { tokens: [], alignedCount: 0, approximateCount: 0, unalignedCount: 0, ambiguousCount: 0 };
  }

  const chunkOffsetSamples = params.chunkStartSourceSample ?? asSourceSamplePosition(0);
  const hasGenuineAcousticEvidence =
    Array.isArray(params.logProbsPerFrame) &&
    params.logProbsPerFrame.length > 0 &&
    Boolean(params.charToVocabId && params.charToVocabId.size > 0);

  const normalizedMeta = words.map((w) => ({
    word: w,
    meta: buildAlignmentNormalizedForm(w.text),
  }));

  if (hasGenuineAcousticEvidence && params.logProbsPerFrame && params.charToVocabId) {
    // Only feed alignable non-punctuation words with characters present in CTC vocabulary
    const alignableInputs = normalizedMeta
      .filter((item) => !item.meta.isPunctuationOnly && item.meta.alignmentNormalized.length > 0)
      .map((item) => ({
        id: item.word.id,
        text: item.meta.alignmentNormalized.replace(/\u200c/g, ''),
      }))
      .filter((item) => Array.from(item.text).some((ch) => params.charToVocabId!.has(ch)));

    const ctcWords =
      alignableInputs.length > 0
        ? PersianCtcForcedAligner.alignPersianWordsToAudio(
            params.logProbsPerFrame,
            params.charToVocabId,
            alignableInputs,
            params.frameDurationSec ?? 0.02,
            0,
          )
        : [];

    const byId = new Map(ctcWords.map((cw) => [cw.wordId, cw]));
    const tokens: AlignedTranscriptToken[] = [];
    let alignedCount = 0;
    let unalignedCount = 0;
    let ambiguousCount = 0;

    for (const { word, meta } of normalizedMeta) {
      const matched = byId.get(word.id);
      if (matched && !meta.ambiguousMapping) {
        const relStart = flicksToSourceSampleExact(matched.alignedRange.start, sourceSampleRate);
        const relEnd = flicksToSourceSampleExact(matched.alignedRange.end, sourceSampleRate);
        const absStart = asSourceSamplePosition(Math.min(totalSourceSamples, chunkOffsetSamples + relStart));
        const absEnd = asSourceSamplePosition(
          Math.min(totalSourceSamples, Math.max(absStart, chunkOffsetSamples + relEnd)),
        );
        alignedCount += 1;
        tokens.push({
          tokenId: word.id,
          originalToken: word.text,
          alignmentNormalizedText: meta.alignmentNormalized,
          displayNormalizedText: meta.displayNormalized,
          sourceStartSample: absStart,
          sourceEndSample: absEnd,
          derivedStartSec: sourceSampleToDisplaySec(absStart, sourceSampleRate),
          derivedEndSec: sourceSampleToDisplaySec(absEnd, sourceSampleRate),
          sampleRate: sourceSampleRate,
          alignmentState: 'ALIGNED',
          alignmentMethod: 'CTC_VITERBI_FORCED_ALIGNMENT',
          modelId: params.modelId ?? 'ctc-viterbi-local',
          modelVersion: params.modelVersion ?? '1.0',
          acousticScore: Number(matched.acousticConfidence.toFixed(4)),
          evidenceProvenance: 'Genuine CTC Viterbi acoustic log-prob trellis alignment.',
          warnings: [],
        });
      } else {
        const state: ForcedAlignmentState = meta.ambiguousMapping ? 'AMBIGUOUS' : 'UNALIGNED';
        if (state === 'AMBIGUOUS') ambiguousCount += 1;
        else unalignedCount += 1;
        tokens.push({
          tokenId: word.id,
          originalToken: word.text,
          alignmentNormalizedText: meta.alignmentNormalized,
          displayNormalizedText: meta.displayNormalized,
          sourceStartSample: null,
          sourceEndSample: null,
          derivedStartSec: null,
          derivedEndSec: null,
          sampleRate: sourceSampleRate,
          alignmentState: state,
          alignmentMethod: 'NONE',
          modelId: params.modelId ?? null,
          modelVersion: params.modelVersion ?? null,
          acousticScore: null,
          evidenceProvenance: meta.isPunctuationOnly
            ? 'Punctuation token preserved separately from acoustic word spans.'
            : 'Token lacked CTC vocabulary/acoustic alignment evidence; verbatim text preserved.',
          warnings: [
            meta.isPunctuationOnly
              ? 'PUNCTUATION_NO_ACOUSTIC_SPAN'
              : 'NO_CTC_ACOUSTIC_ALIGNMENT_EVIDENCE',
          ],
        });
      }
    }

    return { tokens, alignedCount, approximateCount: 0, unalignedCount, ambiguousCount };
  }

  // No genuine acoustic frame probabilities available: NEVER label proportional timing as ALIGNED!
  const tokens: AlignedTranscriptToken[] = [];
  let approximateCount = 0;
  let unalignedCount = 0;

  const spanSamples = Math.max(1, totalSourceSamples - chunkOffsetSamples);
  const perWordSamples = Math.floor(spanSamples / Math.max(1, words.length));

  normalizedMeta.forEach(({ word, meta }, idx) => {
    if (params.allowApproximateFallback && !meta.isPunctuationOnly) {
      const start = asSourceSamplePosition(
        Math.min(totalSourceSamples, chunkOffsetSamples + idx * perWordSamples),
      );
      const end = asSourceSamplePosition(
        Math.min(totalSourceSamples, Math.max(start, start + perWordSamples)),
      );
      approximateCount += 1;
      tokens.push({
        tokenId: word.id,
        originalToken: word.text,
        alignmentNormalizedText: meta.alignmentNormalized,
        displayNormalizedText: meta.displayNormalized,
        sourceStartSample: start,
        sourceEndSample: end,
        derivedStartSec: sourceSampleToDisplaySec(start, sourceSampleRate),
        derivedEndSec: sourceSampleToDisplaySec(end, sourceSampleRate),
        sampleRate: sourceSampleRate,
        alignmentState: 'APPROXIMATE',
        alignmentMethod: 'PROPORTIONAL_APPROXIMATION',
        modelId: null,
        modelVersion: null,
        acousticScore: null,
        evidenceProvenance:
          'Approximate uniform span only (NO acoustic forced alignment evidence available).',
        warnings: ['APPROXIMATE_TIMING_NOT_ACOUSTICALLY_VERIFIED'],
      });
    } else {
      unalignedCount += 1;
      tokens.push({
        tokenId: word.id,
        originalToken: word.text,
        alignmentNormalizedText: meta.alignmentNormalized,
        displayNormalizedText: meta.displayNormalized,
        sourceStartSample: null,
        sourceEndSample: null,
        derivedStartSec: null,
        derivedEndSec: null,
        sampleRate: sourceSampleRate,
        alignmentState: 'UNALIGNED',
        alignmentMethod: 'NONE',
        modelId: null,
        modelVersion: null,
        acousticScore: null,
        evidenceProvenance:
          'Acoustic frame probabilities unavailable; verbatim text preserved without fabricated timing.',
        warnings: ['ACOUSTIC_ALIGNMENT_UNAVAILABLE'],
      });
    }
  });

  return { tokens, alignedCount: 0, approximateCount, unalignedCount, ambiguousCount: 0 };
}
