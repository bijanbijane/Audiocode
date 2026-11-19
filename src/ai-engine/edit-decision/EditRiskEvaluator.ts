import { SpeechEvent } from '../speech-events/SpeechEventContracts';
import {
  EditOperationType,
  EditRiskAssessment,
  EditRiskLevel,
  RefinedBoundaryResult,
  RiskDimensionAssessment,
} from './EditDecisionTypes';
import { NormalizedTokenSpan } from './EditBoundaryRefiner';

const RISK_LEVEL_WEIGHT: Record<EditRiskLevel, number> = {
  LOW: 0.15,
  MEDIUM: 0.45,
  HIGH: 0.75,
  UNKNOWN: 0.85,
  CRITICAL: 1.0,
};

const RISK_PRECEDENCE: Record<EditRiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  UNKNOWN: 4,
  CRITICAL: 5,
};

export interface RiskEvaluationInput {
  readonly event: SpeechEvent;
  readonly operation: EditOperationType;
  readonly boundary: RefinedBoundaryResult;
  readonly tokenSpans?: readonly NormalizedTokenSpan[];
  readonly overlappingEventCount?: number;
  readonly overlapsProtectedEvent?: boolean;
  readonly isStale?: boolean;
  readonly stalenessReasons?: readonly string[];
}

/**
 * Multi-Dimensional Edit Risk Evaluator (AVP-P05-001 Section 6)
 * Preserves all 12 independent semantic, grammatical, phonetic, acoustic, and provenance
 * risk dimensions. Never reduces risk to a single probability claim.
 */
export class EditRiskEvaluator {
  public static evaluate(input: RiskEvaluationInput): EditRiskAssessment {
    const { event, operation, boundary } = input;
    const isDestructive =
      operation === 'REMOVE_FILLER' ||
      operation === 'SHORTEN_SILENCE' ||
      operation === 'REMOVE_ACCIDENTAL_REPETITION';

    const relatedIds = new Set(event.relatedTokenIds ?? []);
    const matchedTokens = (input.tokenSpans ?? []).filter((t) => relatedIds.has(t.tokenId));

    const dimensions: RiskDimensionAssessment[] = [];

    // 1. Acoustic boundary uncertainty
    let acousticBoundaryLevel: EditRiskLevel = 'LOW';
    if (!boundary.valid || boundary.boundaryConfidence === 'UNKNOWN') {
      acousticBoundaryLevel = isDestructive ? 'UNKNOWN' : 'MEDIUM';
    } else if (boundary.boundaryConfidence === 'LOW') {
      acousticBoundaryLevel = isDestructive ? 'HIGH' : 'MEDIUM';
    } else if (boundary.boundaryConfidence === 'MEDIUM') {
      acousticBoundaryLevel = 'MEDIUM';
    }
    dimensions.push({
      dimension: 'ACOUSTIC_BOUNDARY_UNCERTAINTY',
      level: acousticBoundaryLevel,
      reason: `Boundary measurement basis=${boundary.measurementBasis}, confidence=${boundary.boundaryConfidence}.`,
      evidenceNotes: boundary.appliedEvidence,
    });

    // 2. Word boundary uncertainty
    let wordBoundaryLevel: EditRiskLevel = 'LOW';
    if (event.category === 'SILENCE' && !event.relatedTokenIds?.length) {
      wordBoundaryLevel = boundary.boundaryConfidence === 'HIGH' ? 'LOW' : 'MEDIUM';
    } else if (matchedTokens.some((t) => t.alignmentPrecision === 'distributed_segment')) {
      wordBoundaryLevel = 'HIGH';
    } else if (
      (event.category === 'FILLER' || event.category === 'WORD_REPETITION') &&
      matchedTokens.length === 0
    ) {
      wordBoundaryLevel = 'UNKNOWN';
    } else if (matchedTokens.some((t) => t.confidence < 0.7)) {
      wordBoundaryLevel = 'MEDIUM';
    }
    dimensions.push({
      dimension: 'WORD_BOUNDARY_UNCERTAINTY',
      level: wordBoundaryLevel,
      reason:
        wordBoundaryLevel === 'LOW'
          ? 'Word boundaries are consistent with available timing metadata.'
          : 'Word alignment timestamps are estimated or unverified against forced alignment.',
      evidenceNotes: matchedTokens.map(
        (t) => `${t.tokenId}: precision=${t.alignmentPrecision ?? 'unspecified'}, conf=${t.confidence}`,
      ),
    });

    // 3. Phoneme truncation risk
    const phonemeLevel: EditRiskLevel = !isDestructive
      ? 'LOW'
      : boundary.phonemeBoundariesAvailable
        ? 'LOW'
        : boundary.boundaryConfidence === 'HIGH'
          ? 'MEDIUM'
          : 'HIGH';
    dimensions.push({
      dimension: 'PHONEME_TRUNCATION_RISK',
      level: phonemeLevel,
      reason: boundary.phonemeBoundariesAvailable
        ? 'Character/phoneme spans available to guard phoneme transitions.'
        : 'No waveform-level phoneme boundaries are provided; safety relies on adaptive margins.',
      evidenceNotes: [
        `leftMarginSamples=${boundary.leftSafetyMarginSamples}`,
        `rightMarginSamples=${boundary.rightSafetyMarginSamples}`,
      ],
    });

    // 4. Consonant onset or release truncation risk
    const hasConsonantWarning = boundary.warnings.some((w) => w.includes('consonant onset'));
    const consonantLevel: EditRiskLevel = !isDestructive
      ? 'LOW'
      : hasConsonantWarning
        ? 'HIGH'
        : boundary.rightSafetyMarginSamples > 0
          ? 'LOW'
          : 'MEDIUM';
    dimensions.push({
      dimension: 'CONSONANT_ONSET_OR_RELEASE_TRUNCATION',
      level: consonantLevel,
      reason: hasConsonantWarning
        ? 'Cut boundary sits tightly adjacent to a Persian stop consonant onset.'
        : 'No immediate stop-consonant onset collision detected.',
      evidenceNotes: boundary.warnings.filter((w) => w.includes('consonant')),
    });

    // 5. Vowel truncation risk
    const hasVowelWarning =
      boundary.warnings.some((w) => w.includes('vowel/Ezafe')) ||
      matchedTokens.some((t) => t.isStretchedVowel || t.hasTrailingEzafeRisk);
    const vowelLevel: EditRiskLevel = !isDestructive
      ? 'LOW'
      : hasVowelWarning
        ? 'HIGH'
        : 'LOW';
    dimensions.push({
      dimension: 'VOWEL_TRUNCATION_RISK',
      level: vowelLevel,
      reason: hasVowelWarning
        ? 'Adjacent stretched vowel or Persian Ezafe (-e) tail risks audible clipping.'
        : 'No stretched vowel or Ezafe clipping risk flagged.',
      evidenceNotes: boundary.warnings.filter((w) => w.includes('vowel')),
    });

    // 6. Semantic alteration risk
    let semanticLevel: EditRiskLevel = 'LOW';
    if (
      event.category === 'FALSE_START' ||
      event.category === 'SELF_CORRECTION' ||
      event.subtype === 'INTENTIONAL_EMPHASIS_REPETITION' ||
      event.subtype === 'LEGITIMATE_LEXICAL_REPETITION' ||
      event.subtype === 'MEANINGFUL_DISCOURSE_MARKER_PRESERVED'
    ) {
      semanticLevel = isDestructive ? 'CRITICAL' : 'HIGH';
    } else if (
      event.category === 'FILLER' &&
      (event.subtype === 'DISCOURSE_FILLER' || event.subtype === 'CONTEXT_DEPENDENT_COLLOQUIAL')
    ) {
      semanticLevel = 'MEDIUM';
    } else if (event.category === 'WORD_REPETITION' && isDestructive) {
      semanticLevel = 'MEDIUM';
    }
    dimensions.push({
      dimension: 'SEMANTIC_ALTERATION_RISK',
      level: semanticLevel,
      reason:
        semanticLevel === 'LOW'
          ? 'Non-semantic pause or vocal hesitation carries minimal semantic alteration risk.'
          : `Category ${event.category}/${event.subtype} can alter speaker meaning or emphasis if removed carelessly.`,
      evidenceNotes: event.linguisticEvidence?.notes ?? [],
    });

    // 7. Grammatical damage risk
    const grammaticalLevel: EditRiskLevel =
      event.category === 'SILENCE' || event.subtype === 'VOCAL_FILLED_PAUSE'
        ? 'LOW'
        : event.category === 'FALSE_START' ||
            event.category === 'SELF_CORRECTION' ||
            event.subtype === 'DISCOURSE_FILLER'
          ? 'HIGH'
          : 'MEDIUM';
    dimensions.push({
      dimension: 'GRAMMATICAL_DAMAGE_RISK',
      level: grammaticalLevel,
      reason:
        grammaticalLevel === 'LOW'
          ? 'Removing/shortening does not split Persian clause syntax.'
          : 'Clause connectivity, Ezafe phrasing, or verb phrasing may be affected.',
      evidenceNotes: [],
    });

    // 8. Prosodic disruption risk
    let prosodicLevel: EditRiskLevel = 'LOW';
    if (event.category === 'BREATH' || event.category === 'NON_VERBAL_VOCALIZATION') {
      prosodicLevel = isDestructive ? 'CRITICAL' : 'HIGH';
    } else if (
      event.subtype === 'NATURAL_SHORT_PAUSE' ||
      event.subtype === 'SENTENCE_BOUNDARY_PAUSE'
    ) {
      prosodicLevel = isDestructive ? 'CRITICAL' : 'MEDIUM';
    } else if (event.category === 'SILENCE' && operation === 'SHORTEN_SILENCE') {
      prosodicLevel = boundary.proposedInterval ? 'LOW' : 'MEDIUM';
    } else if (isDestructive) {
      prosodicLevel = 'MEDIUM';
    }
    dimensions.push({
      dimension: 'PROSODIC_DISRUPTION_RISK',
      level: prosodicLevel,
      reason:
        prosodicLevel === 'LOW'
          ? 'Natural spacing and speaker rhythm are preserved.'
          : 'Removal could disrupt natural breathing cadence, pacing, or expressive rhythm.',
      evidenceNotes: [],
    });

    // 9. Overlapping-event risk
    const overlapCount = input.overlappingEventCount ?? 0;
    const overlapLevel: EditRiskLevel = input.overlapsProtectedEvent
      ? 'CRITICAL'
      : overlapCount > 0
        ? 'HIGH'
        : 'LOW';
    dimensions.push({
      dimension: 'OVERLAPPING_EVENT_RISK',
      level: overlapLevel,
      reason: input.overlapsProtectedEvent
        ? 'Interval overlaps a protected breath, non-verbal, or meaningful speech event.'
        : overlapCount > 0
          ? `Interval overlaps ${overlapCount} other speech/edit event(s).`
          : 'No overlapping event collisions detected.',
      evidenceNotes: [`overlappingEventCount=${overlapCount}`],
    });

    // 10. Transcript-to-audio mismatch
    const hasVadConflict = Boolean(event.acousticEvidence?.vadActiveOverlap);
    const hasCrossSourceConflict = event.scores.conflicts.length > 0;
    const mismatchLevel: EditRiskLevel = hasVadConflict
      ? 'CRITICAL'
      : hasCrossSourceConflict
        ? 'HIGH'
        : 'LOW';
    dimensions.push({
      dimension: 'TRANSCRIPT_AUDIO_MISMATCH',
      level: mismatchLevel,
      reason: hasVadConflict
        ? 'VAD reports active speech where detector marked silence/filler.'
        : hasCrossSourceConflict
          ? `Evidence conflicts present: ${event.scores.conflicts.join('; ')}`
          : 'Transcript timing and acoustic evidence are consistent.',
      evidenceNotes: event.scores.conflicts,
    });

    // 11. Insufficient source evidence
    let insufficientLevel: EditRiskLevel = 'LOW';
    if (
      event.detectionState === 'UNSUPPORTED' ||
      event.uncertaintyState === 'UNSUPPORTED_CAPABILITY'
    ) {
      insufficientLevel = 'CRITICAL';
    } else if (
      event.detectionState === 'UNCERTAIN' ||
      event.uncertaintyState === 'INSUFFICIENT_EVIDENCE' ||
      (isDestructive && boundary.proposedInterval === null)
    ) {
      insufficientLevel = 'UNKNOWN';
    } else if (
      event.scores.acousticScore === null &&
      event.category !== 'PACING_ANOMALY' &&
      isDestructive
    ) {
      insufficientLevel = 'HIGH';
    }
    dimensions.push({
      dimension: 'INSUFFICIENT_SOURCE_EVIDENCE',
      level: insufficientLevel,
      reason:
        insufficientLevel === 'LOW'
          ? 'Required acoustic and/or linguistic evidence is present.'
          : 'Source evidence is missing, unsupported, or inconclusive.',
      evidenceNotes: [
        `acousticScore=${String(event.scores.acousticScore)}`,
        `linguisticScore=${String(event.scores.linguisticScore)}`,
        `uncertaintyState=${event.uncertaintyState}`,
      ],
    });

    // 12. Stale transcript or event data
    const staleLevel: EditRiskLevel = input.isStale ? 'CRITICAL' : 'LOW';
    dimensions.push({
      dimension: 'STALE_DATA_RISK',
      level: staleLevel,
      reason: input.isStale
        ? `Proposal provenance is stale: ${(input.stalenessReasons ?? []).join('; ')}`
        : 'Source audio hash, transcript version, and detector provenance match active state.',
      evidenceNotes: input.stalenessReasons ?? [],
    });

    // Aggregate overall level using strict worst-case safety lattice (CRITICAL > UNKNOWN > HIGH > MEDIUM > LOW)
    let overallLevel: EditRiskLevel = 'LOW';
    const blockingReasons: string[] = [];

    for (const d of dimensions) {
      if (RISK_PRECEDENCE[d.level] > RISK_PRECEDENCE[overallLevel]) {
        overallLevel = d.level;
      }
      if (d.level === 'CRITICAL' || d.level === 'UNKNOWN') {
        blockingReasons.push(`[${d.dimension}: ${d.level}] ${d.reason}`);
      }
    }

    // Heuristic ranking score (NOT a calibrated probability)
    const meanWeight =
      dimensions.reduce((acc, d) => acc + RISK_LEVEL_WEIGHT[d.level], 0) / dimensions.length;
    const maxWeight = Math.max(...dimensions.map((d) => RISK_LEVEL_WEIGHT[d.level]));
    const heuristicRankingScore = Number((0.65 * maxWeight + 0.35 * meanWeight).toFixed(3));

    return {
      overallLevel,
      dimensions,
      heuristicRankingScore,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      automaticApprovalEligible: false,
      approvalPermitted: overallLevel !== 'CRITICAL' && overallLevel !== 'UNKNOWN',
      mandatoryHumanReview: overallLevel !== 'LOW',
      blockingReasons,
    };
  }
}
