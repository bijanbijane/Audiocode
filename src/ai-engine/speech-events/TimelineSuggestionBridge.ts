import { TimeMath } from '../../contracts/timebase.contract';
import {
  FlickRange,
  SmartRecommendation,
  Track,
} from '../../contracts/v1_2';
import { TimelineTrack } from '../../contracts/project-schema.contract';
import { refinePersianCutBoundary } from '../../engine/dsp';
import {
  SpeechEditSuggestion,
  SpeechEvent,
  SuggestionRiskClassification,
  TimelineSuggestionClass,
} from './SpeechEventContracts';

export interface SuggestionBuildOptions {
  /** Optional upper bound on valid timeline duration in seconds (rejects out-of-bounds spans) */
  readonly maxTimelineDurationSec?: number;
  /** Optional timeline tracks to verify track membership and bounds non-destructively */
  readonly tracks?: readonly (Track | TimelineTrack)[];
  /** Include informational NO_EDIT_RECOMMENDED suggestions in the returned list (default: true) */
  readonly includeNoEditRecommendations?: boolean;
}

export interface SuggestionBridgeResult {
  readonly suggestions: readonly SpeechEditSuggestion[];
  readonly rejectedInvalidBoundaryCount: number;
  readonly skippedUnsupportedCount: number;
}

/**
 * Timeline & Editing Suggestion Bridge (AVP-P04-001 Section 13)
 * Maps SpeechEvents into structured, strictly reversible, non-auto-applied SpeechEditSuggestions.
 * Rejects invalid/out-of-bounds boundaries and guarantees low-confidence/unsupported detections
 * never produce deletion operations.
 */
export function buildTimelineSuggestionsFromSpeechEvents(
  events: readonly SpeechEvent[],
  options: SuggestionBuildOptions = {},
): SuggestionBridgeResult {
  const includeNoEdit = options.includeNoEditRecommendations ?? true;
  const suggestions: SpeechEditSuggestion[] = [];
  let rejectedInvalidBoundaryCount = 0;
  let skippedUnsupportedCount = 0;

  const trackEndMap = new Map<string, number>();
  if (options.tracks) {
    for (const trk of options.tracks) {
      let maxEndSec = 0;
      for (const clip of trk.clips) {
        const endFlicks =
          'endFlicks' in clip.timelineRange
            ? clip.timelineRange.endFlicks
            : Number(clip.timelineRange.end);
        const endSec = TimeMath.flicksToSeconds(endFlicks);
        if (endSec > maxEndSec) maxEndSec = endSec;
      }
      trackEndMap.set(trk.id, maxEndSec);
    }
  }

  for (const ev of events) {
    if (ev.detectionState === 'UNSUPPORTED' || ev.uncertaintyState === 'UNSUPPORTED_CAPABILITY') {
      skippedUnsupportedCount++;
      continue;
    }

    // Strict boundary validation
    const trackLimitSec = trackEndMap.get(ev.trackId) ?? options.maxTimelineDurationSec;
    if (
      !Number.isFinite(ev.startSec) ||
      !Number.isFinite(ev.endSec) ||
      ev.startSec < 0 ||
      ev.endSec <= ev.startSec ||
      (trackLimitSec !== undefined && trackLimitSec > 0 && ev.endSec > trackLimitSec + 0.05)
    ) {
      rejectedInvalidBoundaryCount++;
      continue;
    }

    let proposedStartSec = ev.candidateStartSec ?? ev.startSec;
    let proposedEndSec = ev.candidateEndSec ?? ev.endSec;

    if (
      !Number.isFinite(proposedStartSec) ||
      !Number.isFinite(proposedEndSec) ||
      proposedStartSec < 0 ||
      proposedEndSec <= proposedStartSec ||
      proposedStartSec < ev.startSec - 0.01 ||
      proposedEndSec > ev.endSec + 0.01
    ) {
      rejectedInvalidBoundaryCount++;
      continue;
    }

    // Clamp tiny floating-point overshoot against trackLimitSec
    if (trackLimitSec !== undefined && trackLimitSec > 0) {
      proposedEndSec = Math.min(proposedEndSec, trackLimitSec);
      if (proposedEndSec <= proposedStartSec) {
        rejectedInvalidBoundaryCount++;
        continue;
      }
    }

    const mapped = classifyEventToSuggestion(ev);
    if (mapped.suggestionClass === 'NO_EDIT_RECOMMENDED' && !includeNoEdit) {
      continue;
    }

    const originalRangeFlicks: FlickRange = {
      startFlicks: Number(ev.startFlicks),
      endFlicks: Number(ev.endFlicks),
    };
    const proposedRangeFlicks: FlickRange = {
      startFlicks: Number(TimeMath.secondsToFlicks(proposedStartSec)),
      endFlicks: Number(TimeMath.secondsToFlicks(proposedEndSec)),
    };

    const scoreNote =
      ev.scores.scoreCalibrationStatus === 'CALIBRATED_EMPIRICAL'
        ? `احتمال کالیبره‌شده: ${Math.round((ev.scores.calibratedProbability ?? 0) * 100)}٪`
        : ev.scores.scoreCalibrationStatus === 'MODEL_RAW_CONFIDENCE'
          ? `اطمینان خام مدل: ${Math.round(ev.confidence * 100)}٪`
          : `امتیاز هیوریستیک (غیرکالیبره): ${Math.round(ev.confidence * 100)}٪`;

    const evidenceSummary = [
      `روش: ${ev.provenance.capabilityMode === 'model-based' ? 'مدل عصبی' : 'هیوریستیک سیگنال/زبانی'}`,
      scoreNote,
      ev.scores.acousticScore !== null ? `آکوستیک=${ev.scores.acousticScore.toFixed(2)}` : 'آکوستیک=ندارد',
      ev.scores.linguisticScore !== null ? `زبانی=${ev.scores.linguisticScore.toFixed(2)}` : 'زبانی=ندارد',
      ev.scores.conflicts.length > 0 ? `تعارض=${ev.scores.conflicts.length}` : 'بدون تعارض شواهد',
    ].join(' | ');

    suggestions.push({
      suggestionId: `sug_${ev.eventId}`,
      suggestionClass: mapped.suggestionClass,
      suggestedOperation: mapped.suggestedOperation,
      sourceEventId: ev.eventId,
      trackId: ev.trackId,
      originalStartSec: ev.startSec,
      originalEndSec: ev.endSec,
      originalRangeFlicks,
      proposedStartSec,
      proposedEndSec,
      proposedRangeFlicks,
      reason: mapped.reasonEn,
      reasonFa: ev.explanationFa,
      evidenceSummary,
      confidence: ev.confidence,
      scoreCalibrationStatus: ev.scores.scoreCalibrationStatus,
      riskClassification: mapped.riskClassification,
      requiresHumanReview: ev.requiresHumanReview || mapped.riskClassification !== 'LOW',
      reversible: true,
      autoApplyPermitted: false,
      recommendedMode: mapped.recommendedMode,
    });
  }

  return {
    suggestions,
    rejectedInvalidBoundaryCount,
    skippedUnsupportedCount,
  };
}

function classifyEventToSuggestion(ev: SpeechEvent): {
  suggestionClass: TimelineSuggestionClass;
  suggestedOperation: string;
  reasonEn: string;
  riskClassification: SuggestionRiskClassification;
  recommendedMode: SmartRecommendation['recommendedMode'] | 'no-op-review';
} {
  // Guardrail: low-confidence, uncertain, non-detections, or preserved meaningful markers NEVER become deletions
  if (
    ev.detectionState === 'UNCERTAIN' ||
    ev.detectionState === 'NOT_DETECTED' ||
    ev.uncertaintyState === 'CONFLICTING_EVIDENCE' ||
    ev.uncertaintyState === 'INSUFFICIENT_EVIDENCE' ||
    ev.subtype === 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED' ||
    ev.subtype === 'INTENTIONAL_EMPHASIS_REPETITION' ||
    ev.subtype === 'LEGITIMATE_LEXICAL_REPETITION' ||
    ev.subtype === 'NATURAL_SHORT_PAUSE' ||
    ev.subtype === 'SENTENCE_BOUNDARY_PAUSE' ||
    ev.category === 'PACING_ANOMALY'
  ) {
    return {
      suggestionClass: 'NO_EDIT_RECOMMENDED',
      suggestedOperation: 'Preserve original audio and transcript (informational inspection only)',
      reasonEn: `Preserved (${ev.subtype}); no destructive edit recommended.`,
      riskClassification: 'LOW',
      recommendedMode: 'no-op-review',
    };
  }

  if (ev.category === 'FILLER') {
    if (!ev.eligibleForEditSuggestion) {
      return {
        suggestionClass: 'NO_EDIT_RECOMMENDED',
        suggestedOperation: 'Review filler context manually before any edit',
        reasonEn: `Filler candidate (${ev.subtype}) below deletion threshold or context-sensitive.`,
        riskClassification: 'MEDIUM',
        recommendedMode: 'no-op-review',
      };
    }
    return {
      suggestionClass: 'REMOVE_FILLER',
      suggestedOperation: 'Non-destructive ripple cut or in-place Room Tone fill for vocal filler',
      reasonEn: `Eligible Persian filler (${ev.subtype}) with corroborated evidence.`,
      riskClassification: ev.subtype === 'VOCAL_FILLED_PAUSE' ? 'LOW' : 'MEDIUM',
      recommendedMode: 'sync-locked-ripple-cut',
    };
  }

  if (ev.category === 'SILENCE') {
    if (
      !ev.eligibleForEditSuggestion ||
      ev.subtype === 'INPUT_FAILURE_OR_DIGITAL_ZERO' ||
      ev.subtype === 'BREATH_RELATED_PAUSE' ||
      ev.subtype === 'UTTERANCE_INTERNAL_SILENCE'
    ) {
      return {
        suggestionClass: 'NO_EDIT_RECOMMENDED',
        suggestedOperation: 'Inspect silence/gap region without automatic trimming',
        reasonEn: `Silence subtype (${ev.subtype}) requires inspection rather than automatic trim.`,
        riskClassification: ev.subtype === 'INPUT_FAILURE_OR_DIGITAL_ZERO' ? 'HIGH' : 'MEDIUM',
        recommendedMode: 'no-op-review',
      };
    }
    return {
      suggestionClass: 'SHORTEN_SILENCE',
      suggestedOperation: 'Trim interior silence window while preserving speech boundary padding',
      reasonEn: `Long/hesitation silence (${ev.subtype}) eligible for reversible shortening.`,
      riskClassification: ev.subtype === 'RECORDING_GAP' ? 'MEDIUM' : 'LOW',
      recommendedMode: 'sync-locked-ripple-cut',
    };
  }

  if (ev.category === 'WORD_REPETITION') {
    if (!ev.eligibleForEditSuggestion || ev.subtype !== 'ACCIDENTAL_WORD_REPETITION') {
      return {
        suggestionClass: 'NO_EDIT_RECOMMENDED',
        suggestedOperation: 'Review word repetition to confirm it is not rhetorical emphasis',
        reasonEn: `Repetition (${ev.subtype}) held for manual verification.`,
        riskClassification: 'MEDIUM',
        recommendedMode: 'no-op-review',
      };
    }
    return {
      suggestionClass: 'REMOVE_ACCIDENTAL_REPETITION',
      suggestedOperation: 'Remove first accidental repeated word while keeping final fluent word',
      reasonEn: 'Corroborated accidental consecutive word repetition.',
      riskClassification: 'MEDIUM',
      recommendedMode: 'sync-locked-ripple-cut',
    };
  }

  if (ev.category === 'SYLLABLE_REPETITION' || ev.category === 'STUTTER') {
    return {
      suggestionClass: 'REVIEW_FALSE_START',
      suggestedOperation: 'Manual audition & review of syllable/phoneme repetition (never auto-deleted)',
      reasonEn: `Observable ${ev.subtype} pattern held for human review.`,
      riskClassification: 'HIGH',
      recommendedMode: 'no-op-review',
    };
  }

  if (ev.category === 'FALSE_START') {
    return {
      suggestionClass: 'REVIEW_FALSE_START',
      suggestedOperation: 'Audition abandoned phrase vs continuation; user decides what to keep',
      reasonEn: `Potential false start (${ev.subtype}); original wording preserved for human review.`,
      riskClassification: 'HIGH',
      recommendedMode: 'no-op-review',
    };
  }

  if (ev.category === 'SELF_CORRECTION') {
    return {
      suggestionClass: 'REVIEW_SELF_CORRECTION',
      suggestedOperation: 'Audition original statement and reformulation side-by-side before editing',
      reasonEn: `Potential self-correction (${ev.subtype}); never assumes first statement is wrong.`,
      riskClassification: 'HIGH',
      recommendedMode: 'no-op-review',
    };
  }

  if (ev.category === 'BREATH') {
    return {
      suggestionClass: 'REVIEW_BREATH',
      suggestedOperation: 'Review audible breath for soft -10dB gain attenuation instead of hard cut',
      reasonEn: `Audible breath (${ev.subtype}); soft attenuation preserves naturalness.`,
      riskClassification: 'MEDIUM',
      recommendedMode: 'in-place-room-tone-suppression',
    };
  }

  if (ev.category === 'NON_VERBAL_VOCALIZATION') {
    const isDisruptive = ev.subtype === 'COUGH' || ev.subtype === 'THROAT_CLEARING';
    return {
      suggestionClass: 'REVIEW_NON_VERBAL_EVENT',
      suggestedOperation: isDisruptive
        ? 'Review cough/throat-clearing for in-place Room Tone replacement'
        : 'Review non-verbal vocalization (preserve expressive vocalization unless unwanted)',
      reasonEn: `Non-verbal vocalization (${ev.subtype}) flagged for human review.`,
      riskClassification: isDisruptive ? 'MEDIUM' : 'HIGH',
      recommendedMode: isDisruptive ? 'in-place-room-tone-suppression' : 'no-op-review',
    };
  }

  return {
    suggestionClass: 'NO_EDIT_RECOMMENDED',
    suggestedOperation: 'Informational inspection only',
    reasonEn: 'Informational speech event.',
    riskClassification: 'LOW',
    recommendedMode: 'no-op-review',
  };
}

/**
 * Converts eligible edit suggestions into legacy SmartRecommendation objects (always Pending,
 * never auto-applied, never mutating tracks or raw transcript tokens).
 */
export function speechSuggestionsToSmartRecommendations(params: {
  readonly suggestions: readonly SpeechEditSuggestion[];
  readonly eventsById: ReadonlyMap<string, SpeechEvent>;
  readonly pcm?: Float32Array;
  readonly sampleRate: number;
  readonly existingRecommendations: readonly SmartRecommendation[];
}): SmartRecommendation[] {
  const merged: SmartRecommendation[] = [...params.existingRecommendations];
  const overlapsExisting = (trackId: string, range: FlickRange) =>
    merged.some(
      (r) =>
        r.trackId === trackId &&
        r.status === 'Pending' &&
        Math.min(r.range.endFlicks, range.endFlicks) >
          Math.max(r.range.startFlicks, range.startFlicks),
    );

  for (const sug of params.suggestions) {
    if (sug.recommendedMode === 'no-op-review' || sug.suggestionClass === 'NO_EDIT_RECOMMENDED') {
      continue;
    }
    if (
      sug.proposedRangeFlicks.endFlicks <= sug.proposedRangeFlicks.startFlicks ||
      overlapsExisting(sug.trackId, sug.proposedRangeFlicks)
    ) {
      continue;
    }

    const sourceEv = params.eventsById.get(sug.sourceEventId);
    const kind: SmartRecommendation['kind'] =
      sug.suggestionClass === 'SHORTEN_SILENCE'
        ? 'long-pause'
        : sug.suggestionClass === 'REMOVE_ACCIDENTAL_REPETITION'
          ? 'repetition'
          : 'standalone-filler';

    const boundary =
      params.pcm && params.pcm.length > 0
        ? refinePersianCutBoundary(params.pcm, params.sampleRate, sug.proposedRangeFlicks, {
            microCrossfadeMs: 12,
          })
        : {
            rawRange: sug.proposedRangeFlicks,
            snappedRange: sug.proposedRangeFlicks,
            rmsValleyShiftMs: 0,
            zeroCrossingAdjusted: false,
            microCrossfadeMs: 10,
            pitchPlateauDetected: false,
            trailingEzafeRisk: false,
            reasonFa: 'مرز پیشنهادی مبتنی بر تحلیل رویداد گفتار',
          };

    merged.push({
      id: `rec-speechev-${sug.suggestionId}`,
      trackId: sug.trackId,
      kind,
      recommendedMode: sug.recommendedMode,
      range: sug.proposedRangeFlicks,
      relatedText:
        sourceEv?.relatedText ??
        `[${sug.suggestionClass} · ${(sug.proposedEndSec - sug.proposedStartSec).toFixed(2)}s]`,
      reasonFa: `${sug.reasonFa} (${sug.evidenceSummary})`,
      confidence: sug.confidence,
      sourceTier:
        sourceEv?.provenance.capabilityMode === 'model-based'
          ? 'Group-B-Persian-ASR'
          : 'Group-A-DSP',
      status: 'Pending',
      boundary,
    });
  }

  return merged;
}
