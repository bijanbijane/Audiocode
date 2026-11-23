import {
  FLICKS_PER_SECOND,
  SampleIndex,
  SampleRate,
  TimeMath,
} from '../../contracts/timebase.contract';
import { PersianWordToken } from '../../contracts/v1_2';
import { SpeechEvent } from '../speech-events/SpeechEventContracts';
import { TimedPersianToken } from '../PersianTextNormalizer';
import {
  BoundaryConfidenceClassification,
  BoundaryMeasurementBasis,
  EditOperationType,
  RefinedBoundaryResult,
  SourceSampleInterval,
} from './EditDecisionTypes';

export interface NormalizedTokenSpan {
  readonly tokenId: string;
  readonly trackId: string;
  readonly text: string;
  readonly startSample: SampleIndex;
  readonly endSample: SampleIndex;
  readonly confidence: number;
  readonly alignmentPrecision?: PersianWordToken['alignmentPrecision'] | 'segment_only' | 'missing';
  readonly alignmentSource?: PersianWordToken['alignmentSource'];
  readonly timingValid?: boolean;
  readonly hasTrailingEzafeRisk?: boolean;
  readonly isStretchedVowel?: boolean;
  readonly hasCharacterSpans: boolean;
}

const VALID_SAMPLE_RATES = new Set<number>([16000, 22050, 24000, 32000, 44100, 48000, 96000]);

/** Persian stop/plosive & affricate initial consonants sensitive to onset truncation */
const PERSIAN_PLOSIVE_ONSETS = new Set(['پ', 'ت', 'چ', 'ک', 'ق', 'ب', 'د', 'گ', 'ج', 'ط']);
/** Persian vowel/sonorant trailing letters sensitive to vowel or Ezafe clipping */
const PERSIAN_VOWEL_ENDINGS = new Set(['ا', 'آ', 'و', 'ی', 'ه', 'ئ']);

export function isSupportedSampleRate(rate: number): rate is SampleRate {
  return Number.isInteger(rate) && VALID_SAMPLE_RATES.has(rate);
}

/**
 * Constructs an authoritative integer-sample SourceSampleInterval without floating-point drift.
 */
export function createSourceSampleInterval(
  startSample: number,
  endSample: number,
  sampleRate: SampleRate,
): SourceSampleInterval {
  const s = Math.trunc(startSample);
  const e = Math.trunc(endSample);
  const startFlicks = TimeMath.samplesToFlicks(s, sampleRate);
  const endFlicks = TimeMath.samplesToFlicks(e, sampleRate);
  const startSec = Number((s / sampleRate).toFixed(6));
  const endSec = Number((e / sampleRate).toFixed(6));
  const durationMs = Number((((e - s) / sampleRate) * 1000).toFixed(3));
  return {
    startSample: s,
    endSample: e,
    sampleRate,
    timebaseFlicksPerSecond: FLICKS_PER_SECOND,
    startFlicks,
    endFlicks,
    startSec,
    endSec,
    durationMs,
  };
}

/**
 * Converts a TimedPersianToken or PersianWordToken into integer sample coordinates
 * on the original source timeline without mutating the source token.
 */
export function normalizeTokensToSampleSpans(
  tokens: readonly (TimedPersianToken | PersianWordToken)[] | undefined,
  sampleRate: SampleRate,
): NormalizedTokenSpan[] {
  if (!tokens || tokens.length === 0) return [];
  const flicksPerSample = FLICKS_PER_SECOND / sampleRate;
  const spans: NormalizedTokenSpan[] = [];

  for (const tok of tokens) {
    if ('tokenId' in tok) {
      const startFlicks = Number(tok.range.start);
      const endFlicks = Number(tok.range.end);
      if (!Number.isFinite(startFlicks) || !Number.isFinite(endFlicks)) continue;
      const safeConfidence = Number.isFinite(tok.confidence)
        ? Math.max(0, Math.min(1, tok.confidence))
        : 0.7;
      spans.push({
        tokenId: tok.tokenId,
        trackId: tok.trackId,
        text: tok.originalText,
        startSample: Math.round(startFlicks / flicksPerSample),
        endSample: Math.round(endFlicks / flicksPerSample),
        confidence: safeConfidence,
        alignmentPrecision: tok.alignmentPrecision,
        timingValid: tok.timingValid,
        hasTrailingEzafeRisk: tok.hasTrailingEzafeRisk,
        hasCharacterSpans: false,
      });
    } else {
      const startFlicks = Number(tok.range.startFlicks);
      const endFlicks = Number(tok.range.endFlicks);
      if (!Number.isFinite(startFlicks) || !Number.isFinite(endFlicks)) continue;
      const safeConfidence = Number.isFinite(tok.confidence)
        ? Math.max(0, Math.min(1, tok.confidence))
        : 0.7;
      spans.push({
        tokenId: tok.id,
        trackId: tok.trackId,
        text: tok.originalText,
        startSample: Math.round(startFlicks / flicksPerSample),
        endSample: Math.round(endFlicks / flicksPerSample),
        confidence: safeConfidence,
        alignmentPrecision: tok.alignmentPrecision,
        alignmentSource: tok.alignmentSource,
        hasTrailingEzafeRisk: tok.hasTrailingEzafeRisk,
        isStretchedVowel: tok.isStretchedVowel,
        hasCharacterSpans: Boolean(tok.characterSpans && tok.characterSpans.length > 0),
      });
    }
  }

  spans.sort((a, b) => a.startSample - b.startSample);
  return spans;
}

export interface BoundaryRefinementInput {
  readonly event: SpeechEvent;
  readonly operation: EditOperationType;
  readonly sampleRate: SampleRate;
  readonly totalSourceSamples: number;
  readonly tokenSpans?: readonly NormalizedTokenSpan[];
  readonly siblingEvents?: readonly SpeechEvent[];
}

/**
 * Source-Coordinate Edit Boundary Refiner (AVP-P05-001 Section 7)
 * Operates strictly in integer sample coordinates on the original source timeline.
 * Preserves original vs proposed boundaries, measures boundary confidence independently
 * from event confidence, never invents phoneme alignment when absent, and uses
 * acoustic/phonetic context-adaptive safety margins.
 */
export class EditBoundaryRefiner {
  public static refine(input: BoundaryRefinementInput): RefinedBoundaryResult {
    const { event, operation, sampleRate, totalSourceSamples } = input;
    const warnings: string[] = [];
    const appliedEvidence: string[] = [];

    if (!isSupportedSampleRate(sampleRate)) {
      return {
        valid: false,
        originalInterval: null,
        proposedInterval: null,
        measurementBasis: 'UNKNOWN',
        boundaryConfidence: 'UNKNOWN',
        boundaryConfidenceScore: null,
        boundaryScoreCalibrationStatus: 'UNAVAILABLE',
        refinementMethod: 'rejected-invalid-sample-rate',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence,
        warnings,
        rejectionReason: `Unsupported sample rate: ${String(sampleRate)}`,
      };
    }

    if (!Number.isFinite(totalSourceSamples) || totalSourceSamples <= 0) {
      return {
        valid: false,
        originalInterval: null,
        proposedInterval: null,
        measurementBasis: 'UNKNOWN',
        boundaryConfidence: 'UNKNOWN',
        boundaryConfidenceScore: null,
        boundaryScoreCalibrationStatus: 'UNAVAILABLE',
        refinementMethod: 'rejected-invalid-source-length',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence,
        warnings,
        rejectionReason: `Invalid totalSourceSamples: ${String(totalSourceSamples)}`,
      };
    }

    // 1. Validate raw timestamps (reject NaN, Infinity, negative, reversed, out-of-range)
    if (
      !Number.isFinite(event.startSec) ||
      !Number.isFinite(event.endSec) ||
      !Number.isFinite(event.startFlicks) ||
      !Number.isFinite(event.endFlicks)
    ) {
      return {
        valid: false,
        originalInterval: null,
        proposedInterval: null,
        measurementBasis: 'UNKNOWN',
        boundaryConfidence: 'UNKNOWN',
        boundaryConfidenceScore: null,
        boundaryScoreCalibrationStatus: 'UNAVAILABLE',
        refinementMethod: 'rejected-non-finite',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence,
        warnings,
        rejectionReason: 'Event timestamps contain non-finite (NaN/Infinity) values.',
      };
    }

    if (event.startSec < 0 || event.endSec < 0 || event.startFlicks < 0 || event.endFlicks < 0) {
      return {
        valid: false,
        originalInterval: null,
        proposedInterval: null,
        measurementBasis: 'UNKNOWN',
        boundaryConfidence: 'UNKNOWN',
        boundaryConfidenceScore: null,
        boundaryScoreCalibrationStatus: 'UNAVAILABLE',
        refinementMethod: 'rejected-negative',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence,
        warnings,
        rejectionReason: `Negative boundary coordinates are invalid (startSec=${event.startSec}, endSec=${event.endSec}).`,
      };
    }

    // Convert original coordinates using exact flicks-per-sample integer division when flicks match seconds,
    // avoiding conversion drift across sample rates.
    const flicksPerSample = FLICKS_PER_SECOND / sampleRate;
    const flicksMatchSec =
      Math.abs(TimeMath.flicksToSeconds(event.startFlicks) - event.startSec) < 0.005 &&
      Math.abs(TimeMath.flicksToSeconds(event.endFlicks) - event.endSec) < 0.005;

    const origStartSample = flicksMatchSec
      ? Math.round(event.startFlicks / flicksPerSample)
      : Math.round(event.startSec * sampleRate);
    const origEndSample = flicksMatchSec
      ? Math.round(event.endFlicks / flicksPerSample)
      : Math.round(event.endSec * sampleRate);

    if (origStartSample >= origEndSample) {
      return {
        valid: false,
        originalInterval: null,
        proposedInterval: null,
        measurementBasis: 'UNKNOWN',
        boundaryConfidence: 'UNKNOWN',
        boundaryConfidenceScore: null,
        boundaryScoreCalibrationStatus: 'UNAVAILABLE',
        refinementMethod: 'rejected-reversed-or-zero',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence,
        warnings,
        rejectionReason: `Reversed or zero-length interval (startSample=${origStartSample} >= endSample=${origEndSample}).`,
      };
    }

    // Allow a tiny 2-sample rounding tolerance at the very end of the file, reject genuine out-of-range
    if (origEndSample > totalSourceSamples + 2 || origStartSample >= totalSourceSamples) {
      return {
        valid: false,
        originalInterval: null,
        proposedInterval: null,
        measurementBasis: 'UNKNOWN',
        boundaryConfidence: 'UNKNOWN',
        boundaryConfidenceScore: null,
        boundaryScoreCalibrationStatus: 'UNAVAILABLE',
        refinementMethod: 'rejected-out-of-range',
        leftSafetyMarginSamples: 0,
        rightSafetyMarginSamples: 0,
        phonemeBoundariesAvailable: false,
        appliedEvidence,
        warnings,
        rejectionReason: `Coordinates [${origStartSample}, ${origEndSample}) exceed source length (${totalSourceSamples} samples).`,
      };
    }

    const clampedOrigEnd = Math.min(origEndSample, totalSourceSamples);
    const originalInterval = createSourceSampleInterval(
      origStartSample,
      clampedOrigEnd,
      sampleRate,
    );

    // 2. Inspect alignment & surrounding speech token evidence
    const trackTokens = (input.tokenSpans ?? []).filter((t) => t.trackId === event.trackId);
    const relatedIds = new Set(event.relatedTokenIds ?? []);
    const matchedTokens = trackTokens.filter((t) => relatedIds.has(t.tokenId));

    const prevToken = this.findNearestLeftToken(trackTokens, origStartSample, relatedIds);
    const nextToken = this.findNearestRightToken(trackTokens, clampedOrigEnd, relatedIds);

    const hasMissingTiming =
      event.provenance.timingPrecision === 'NONE' ||
      matchedTokens.some((t) => t.alignmentPrecision === 'missing' || t.timingValid === false) ||
      (Boolean(event.provenance.hasIncompleteTimestamps) && event.category !== 'SILENCE');
    const hasSegmentOnlyTiming =
      !hasMissingTiming &&
      (matchedTokens.some((t) => t.alignmentPrecision === 'segment_only') ||
        (event.provenance.timingPrecision === 'SEGMENT_ONLY' && event.category !== 'SILENCE'));

    const hasForcedAlignment =
      !hasMissingTiming &&
      !hasSegmentOnlyTiming &&
      matchedTokens.some(
        (t) =>
          t.alignmentPrecision === 'forced_aligned' ||
          t.alignmentPrecision === 'ctc_frame_aligned' ||
          t.alignmentSource === 'ForcedAlignment',
      );
    const hasDistributedApprox =
      hasSegmentOnlyTiming ||
      matchedTokens.some((t) => t.alignmentPrecision === 'distributed_segment');
    const hasModelTimestamps =
      !hasMissingTiming &&
      !hasSegmentOnlyTiming &&
      matchedTokens.some((t) => t.alignmentPrecision === 'model_timestamps');
    const phonemeBoundariesAvailable =
      !hasMissingTiming && !hasSegmentOnlyTiming && matchedTokens.some((t) => t.hasCharacterSpans);

    const hasAcousticEnergy =
      event.acousticEvidence?.rmsDb !== undefined ||
      event.acousticEvidence?.noiseFloorDbfs !== undefined;
    const hasVadSignal = event.acousticEvidence?.vadSpeechRatio !== undefined;
    const hasHysteresisPadding = Boolean(event.acousticEvidence?.hysteresisApplied);

    // Determine honest measurement basis
    let measurementBasis: BoundaryMeasurementBasis = 'UNKNOWN';
    if (hasMissingTiming) {
      measurementBasis = 'UNKNOWN';
      warnings.push(
        'زمان‌بندی توکن‌های مرتبط ناقص یا نامعتبر است؛ مختصات برش دقیق قابل اتکا نیست.',
      );
    } else if (hasSegmentOnlyTiming) {
      measurementBasis = 'ESTIMATED_HEURISTIC';
      warnings.push(
        'فقط زمان‌بندی در سطح سگمنت موجود است؛ برش خودکار واژه بدون تراز کلمه‌ای مجاز نیست.',
      );
      appliedEvidence.push('Segment-level timestamps only (word-level boundaries unavailable).');
    } else if (hasForcedAlignment) {
      measurementBasis = 'FORCED_ALIGNED';
      appliedEvidence.push('Forced/CTC token alignment timestamps available.');
    } else if (
      hasAcousticEnergy &&
      (hasHysteresisPadding ||
        event.category === 'SILENCE' ||
        event.category === 'BREATH' ||
        event.category === 'NON_VERBAL_VOCALIZATION')
    ) {
      measurementBasis = 'MEASURED_ACOUSTIC';
      appliedEvidence.push('Acoustic short-time energy & hysteresis envelope measured.');
    } else if (hasModelTimestamps || matchedTokens.length > 0) {
      measurementBasis = hasDistributedApprox ? 'ESTIMATED_HEURISTIC' : 'ESTIMATED_ASR_TOKEN';
      appliedEvidence.push(
        hasDistributedApprox
          ? 'Token timestamps are proportionally distributed segment estimates (low boundary precision).'
          : 'ASR word-level timestamps used (no waveform-level phoneme boundaries).',
      );
    } else if (hasAcousticEnergy) {
      measurementBasis = 'ESTIMATED_HEURISTIC';
      appliedEvidence.push('Coarse acoustic window features only.');
    } else {
      measurementBasis = 'UNKNOWN';
      warnings.push('No alignment or acoustic boundary measurement data available.');
    }

    if (hasVadSignal) {
      appliedEvidence.push(
        `VAD speech ratio=${event.acousticEvidence?.vadSpeechRatio} correlated.`,
      );
    }
    if (!phonemeBoundariesAvailable) {
      warnings.push('Waveform-level phoneme boundaries are unavailable in the current pipeline.');
    }

    // 3. Compute context-adaptive safety margins in integer samples (NOT one fixed ms constant!)
    let leftMarginMs = 0;
    let rightMarginMs = 0;

    if (operation === 'SHORTEN_SILENCE') {
      // Adaptive silence margin depends on noise floor and proximity to active speech/plosive onsets
      const rawNoiseFloorDb = event.acousticEvidence?.noiseFloorDbfs;
      const noiseFloorDb =
        rawNoiseFloorDb !== undefined && Number.isFinite(rawNoiseFloorDb) ? rawNoiseFloorDb : -55;
      const noisyRoomExtraMs = noiseFloorDb > -42 ? 25 : 0;
      leftMarginMs = 55 + noisyRoomExtraMs;
      rightMarginMs = 65 + noisyRoomExtraMs;

      if (nextToken && this.startsWithPersianPlosive(nextToken.text)) {
        rightMarginMs += 30;
        appliedEvidence.push(
          `Expanded right silence margin (+30ms) to protect Persian stop consonant onset on «${nextToken.text}».`,
        );
      }
      if (prevToken && (prevToken.hasTrailingEzafeRisk || this.endsWithPersianVowel(prevToken.text))) {
        leftMarginMs += 25;
        appliedEvidence.push(
          `Expanded left silence margin (+25ms) to protect vowel/Ezafe decay on «${prevToken.text}».`,
        );
      }
    } else if (operation === 'REMOVE_FILLER' || operation === 'REMOVE_ACCIDENTAL_REPETITION') {
      // Check actual gaps to adjacent words so we never intrude into neighboring speech
      const leftGapMs = prevToken
        ? ((origStartSample - prevToken.endSample) / sampleRate) * 1000
        : 120;
      const rightGapMs = nextToken
        ? ((nextToken.startSample - clampedOrigEnd) / sampleRate) * 1000
        : 120;

      if (leftGapMs < 35) {
        leftMarginMs = Math.min(28, Math.max(8, 22 - leftGapMs * 0.4));
        if (prevToken && (prevToken.hasTrailingEzafeRisk || this.endsWithPersianVowel(prevToken.text))) {
          leftMarginMs += 15;
          warnings.push(
            `Left boundary sits close (${Math.round(leftGapMs)}ms) to vowel/Ezafe ending on «${prevToken.text}».`,
          );
        }
      }
      if (rightGapMs < 35) {
        rightMarginMs = Math.min(28, Math.max(8, 22 - rightGapMs * 0.4));
        if (nextToken && this.startsWithPersianPlosive(nextToken.text)) {
          rightMarginMs += 18;
          warnings.push(
            `Right boundary sits close (${Math.round(rightGapMs)}ms) to stop consonant onset on «${nextToken.text}».`,
          );
        }
      }
    }

    // 4. Determine initial proposed sample bounds (without overwriting originalInterval)
    let propStartSample = origStartSample;
    let propEndSample = clampedOrigEnd;

    if (
      operation === 'SHORTEN_SILENCE' &&
      event.candidateStartSec !== undefined &&
      event.candidateEndSec !== undefined &&
      Number.isFinite(event.candidateStartSec) &&
      Number.isFinite(event.candidateEndSec) &&
      event.candidateEndSec > event.candidateStartSec
    ) {
      const candStart =
        event.candidateStartFlicks !== undefined && Number.isFinite(event.candidateStartFlicks)
          ? Math.round(event.candidateStartFlicks / flicksPerSample)
          : Math.round(event.candidateStartSec * sampleRate);
      const candEnd =
        event.candidateEndFlicks !== undefined && Number.isFinite(event.candidateEndFlicks)
          ? Math.round(event.candidateEndFlicks / flicksPerSample)
          : Math.round(event.candidateEndSec * sampleRate);
      propStartSample = Math.max(origStartSample, candStart);
      propEndSample = Math.min(clampedOrigEnd, candEnd);
      appliedEvidence.push('Adopted silence analyzer candidate interior bounds as starting point.');
    }

    const leftMarginSamples = Math.round((leftMarginMs / 1000) * sampleRate);
    const rightMarginSamples = Math.round((rightMarginMs / 1000) * sampleRate);

    if (
      operation === 'SHORTEN_SILENCE' ||
      operation === 'REMOVE_FILLER' ||
      operation === 'REMOVE_ACCIDENTAL_REPETITION'
    ) {
      propStartSample = Math.max(propStartSample, origStartSample + leftMarginSamples);
      propEndSample = Math.min(propEndSample, clampedOrigEnd - rightMarginSamples);
    }

    // Never intrude into adjacent breath / non-verbal vocal events
    const siblingProtected = (input.siblingEvents ?? []).filter(
      (s) =>
        s.eventId !== event.eventId &&
        s.trackId === event.trackId &&
        (s.category === 'BREATH' || s.category === 'NON_VERBAL_VOCALIZATION') &&
        Number.isFinite(s.startSec) &&
        Number.isFinite(s.endSec),
    );

    for (const prot of siblingProtected) {
      const protStart = Math.round(prot.startSec * sampleRate);
      const protEnd = Math.round(prot.endSec * sampleRate);
      const bufferSamples = Math.round(0.025 * sampleRate); // 25ms guard around breath
      // If protected event is near right tail of silence/filler, pull propEnd back
      if (protStart > propStartSample && protStart - bufferSamples < propEndSample && protEnd >= propEndSample) {
        propEndSample = Math.max(propStartSample, protStart - bufferSamples);
        appliedEvidence.push(
          `Retracted right boundary by 25ms guard to protect adjacent ${prot.category} (${prot.eventId}).`,
        );
      }
      // If protected event is near left head, push propStart forward
      if (protEnd < propEndSample && protEnd + bufferSamples > propStartSample && protStart <= propStartSample) {
        propStartSample = Math.min(propEndSample, protEnd + bufferSamples);
        appliedEvidence.push(
          `Advanced left boundary by 25ms guard to protect adjacent ${prot.category} (${prot.eventId}).`,
        );
      }
    }

    // Clamp to [0, totalSourceSamples]
    propStartSample = Math.max(0, Math.min(totalSourceSamples, propStartSample));
    propEndSample = Math.max(0, Math.min(totalSourceSamples, propEndSample));

    // For review-only or NO_EDIT_RECOMMENDED operations, proposed interval equals original interval
    const isDestructiveOp =
      operation === 'REMOVE_FILLER' ||
      operation === 'SHORTEN_SILENCE' ||
      operation === 'REMOVE_ACCIDENTAL_REPETITION';

    let proposedInterval: SourceSampleInterval | null = null;
    if (!isDestructiveOp) {
      proposedInterval = originalInterval;
    } else if (hasMissingTiming || hasSegmentOnlyTiming) {
      warnings.push(
        hasSegmentOnlyTiming
          ? 'Destructive word cut suppressed because only segment-level timestamps exist.'
          : 'Destructive cut suppressed because token timing is incomplete or missing.',
      );
      proposedInterval = null;
    } else if (propEndSample - propStartSample >= Math.round(sampleRate * 0.02)) {
      proposedInterval = createSourceSampleInterval(propStartSample, propEndSample, sampleRate);
    } else {
      warnings.push(
        'After applying acoustic/phonetic safety margins, remaining removable span is <20ms; edit cannot safely proceed without manual boundary adjustment.',
      );
      proposedInterval = null;
    }

    // 5. Compute INDEPENDENT boundary confidence (never copying event.confidence!)
    let boundaryScore: number | null = null;
    if (measurementBasis === 'FORCED_ALIGNED') {
      boundaryScore = 0.86;
    } else if (measurementBasis === 'MEASURED_ACOUSTIC') {
      boundaryScore = hasVadSignal && !event.acousticEvidence?.vadActiveOverlap ? 0.84 : 0.75;
    } else if (measurementBasis === 'ESTIMATED_ASR_TOKEN') {
      const finiteConfs = matchedTokens
        .map((t) => t.confidence)
        .filter((c) => Number.isFinite(c));
      const minTokConf =
        finiteConfs.length > 0
          ? Math.max(0, Math.min(1, Math.min(...finiteConfs)))
          : 0.7;
      boundaryScore = Number(Math.min(0.76, 0.45 + minTokConf * 0.3).toFixed(3));
    } else if (measurementBasis === 'ESTIMATED_HEURISTIC') {
      boundaryScore = hasDistributedApprox ? 0.42 : 0.56;
    } else {
      boundaryScore = null;
    }

    if (boundaryScore !== null) {
      if (event.acousticEvidence?.vadActiveOverlap) {
        boundaryScore = Math.max(0.25, boundaryScore - 0.3);
      }
      if (warnings.length >= 2) {
        boundaryScore = Math.max(0.3, boundaryScore - 0.12);
      }
      if (proposedInterval === null && isDestructiveOp) {
        boundaryScore = Math.min(boundaryScore, 0.35);
      }
      boundaryScore = Number(boundaryScore.toFixed(3));
    }

    let boundaryConfidence: BoundaryConfidenceClassification = 'UNKNOWN';
    if (boundaryScore === null) {
      boundaryConfidence = 'UNKNOWN';
    } else if (boundaryScore >= 0.8) {
      boundaryConfidence = 'HIGH';
    } else if (boundaryScore >= 0.58) {
      boundaryConfidence = 'MEDIUM';
    } else {
      boundaryConfidence = 'LOW';
    }

    return {
      valid: true,
      originalInterval,
      proposedInterval,
      measurementBasis,
      boundaryConfidence,
      boundaryConfidenceScore: boundaryScore,
      boundaryScoreCalibrationStatus:
        boundaryScore === null ? 'UNAVAILABLE' : 'UNCALIBRATED_HEURISTIC',
      refinementMethod: isDestructiveOp
        ? `context-adaptive-sample-margin(${measurementBasis})`
        : `preserve-original-for-review(${measurementBasis})`,
      leftSafetyMarginSamples: leftMarginSamples,
      rightSafetyMarginSamples: rightMarginSamples,
      phonemeBoundariesAvailable,
      appliedEvidence,
      warnings,
    };
  }

  private static findNearestLeftToken(
    tokens: readonly NormalizedTokenSpan[],
    startSample: SampleIndex,
    excludeIds: ReadonlySet<string>,
  ): NormalizedTokenSpan | null {
    let best: NormalizedTokenSpan | null = null;
    for (const t of tokens) {
      if (excludeIds.has(t.tokenId)) continue;
      if (t.endSample <= startSample + 800) {
        if (!best || t.endSample > best.endSample) best = t;
      }
    }
    return best;
  }

  private static findNearestRightToken(
    tokens: readonly NormalizedTokenSpan[],
    endSample: SampleIndex,
    excludeIds: ReadonlySet<string>,
  ): NormalizedTokenSpan | null {
    let best: NormalizedTokenSpan | null = null;
    for (const t of tokens) {
      if (excludeIds.has(t.tokenId)) continue;
      if (t.startSample >= endSample - 800) {
        if (!best || t.startSample < best.startSample) best = t;
      }
    }
    return best;
  }

  private static startsWithPersianPlosive(word: string): boolean {
    const clean = word.replace(/[،؛.!؟«»()[\]\s\u200c]/g, '');
    return clean.length > 0 && PERSIAN_PLOSIVE_ONSETS.has(clean[0]);
  }

  private static endsWithPersianVowel(word: string): boolean {
    const clean = word.replace(/[،؛.!؟«»()[\]\s\u200c]/g, '');
    return clean.length > 0 && PERSIAN_VOWEL_ENDINGS.has(clean[clean.length - 1]);
  }
}
