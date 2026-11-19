import { ImmutableRenderPlan } from '../audio-renderer/AudioRenderTypes';
import { AlignedTranscriptToken } from './PersianAlignmentContract';
import { sourceSampleToDisplaySec } from './TimeConversion';

export type TemporalViolationCode =
  | 'NEGATIVE_TIMESTAMP'
  | 'START_AFTER_END'
  | 'EXCEEDS_SOURCE_DURATION'
  | 'INVALID_SAMPLE_INDEX'
  | 'ZERO_LENGTH_FORBIDDEN'
  | 'UNORDERED_TOKENS'
  | 'DUPLICATE_TOKEN_ID'
  | 'SAMPLE_RATE_MISMATCH'
  | 'TIME_SAMPLE_DISAGREEMENT'
  | 'INVALID_CROSSFADE_BOUNDS'
  | 'RENDER_PLAN_OUTPUT_DRIFT';

export interface TemporalIntegrityViolation {
  readonly code: TemporalViolationCode;
  readonly severity: 'ERROR' | 'WARNING';
  readonly entityId: string;
  readonly message: string;
}

export interface TemporalIntegrityReport {
  readonly valid: boolean;
  readonly violations: readonly TemporalIntegrityViolation[];
  readonly pausesDetectedCount: number;
  readonly overlapsDetectedCount: number;
}

export interface RealAudioAlignmentBenchmarkReport {
  readonly status: 'EVALUATED' | 'NOT_EVALUATED';
  readonly datasetKind: 'REAL_HUMAN_ANNOTATED_PERSIAN' | 'NONE';
  readonly medianAbsBoundaryErrorMs: number | null;
  readonly p95BoundaryErrorMs: number | null;
  readonly startBoundaryMeanErrorMs: number | null;
  readonly endBoundaryMeanErrorMs: number | null;
  readonly tokenOmissionRate: number | null;
  readonly tokenDuplicationRate: number | null;
  readonly alignmentCoverage: number | null;
  readonly note: string;
}

/**
 * Validates token temporal integrity against authoritative source duration and sample rate
 * without silently shifting timestamps to look plausible.
 */
export function validateTranscriptTemporalIntegrity(params: {
  readonly tokens: readonly AlignedTranscriptToken[];
  readonly authoritativeSampleRate: number;
  readonly totalSourceSamples: number;
}): TemporalIntegrityReport {
  const violations: TemporalIntegrityViolation[] = [];
  const seenIds = new Set<string>();
  let prevStart = -1;
  let prevEnd = -1;
  let pausesDetectedCount = 0;
  let overlapsDetectedCount = 0;

  for (const tok of params.tokens) {
    if (seenIds.has(tok.tokenId)) {
      violations.push({
        code: 'DUPLICATE_TOKEN_ID',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Duplicate tokenId "${tok.tokenId}" detected.`,
      });
    }
    seenIds.add(tok.tokenId);

    if (tok.sampleRate !== params.authoritativeSampleRate) {
      violations.push({
        code: 'SAMPLE_RATE_MISMATCH',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Token sampleRate ${tok.sampleRate} disagrees with authoritative ${params.authoritativeSampleRate}.`,
      });
    }

    if (tok.sourceStartSample === null || tok.sourceEndSample === null) {
      continue;
    }

    const s = tok.sourceStartSample as number;
    const e = tok.sourceEndSample as number;

    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e)) {
      violations.push({
        code: 'INVALID_SAMPLE_INDEX',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Non-integer sample coordinates [${s}, ${e}].`,
      });
      continue;
    }

    if (s < 0 || e < 0) {
      violations.push({
        code: 'NEGATIVE_TIMESTAMP',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Negative sample position [${s}, ${e}].`,
      });
    }

    if (s > e) {
      violations.push({
        code: 'START_AFTER_END',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Start sample ${s} > end sample ${e}.`,
      });
    } else if (s === e && tok.alignmentState === 'ALIGNED') {
      violations.push({
        code: 'ZERO_LENGTH_FORBIDDEN',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Aligned word token "${tok.tokenId}" has zero sample length.`,
      });
    }

    if (e > params.totalSourceSamples) {
      violations.push({
        code: 'EXCEEDS_SOURCE_DURATION',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `End sample ${e} exceeds decoded source length ${params.totalSourceSamples}.`,
      });
    }

    if (tok.derivedStartSec !== null) {
      const expectedSec = sourceSampleToDisplaySec(tok.sourceStartSample, params.authoritativeSampleRate);
      if (Math.abs(tok.derivedStartSec - expectedSec) > 0.002) {
        violations.push({
          code: 'TIME_SAMPLE_DISAGREEMENT',
          severity: 'ERROR',
          entityId: tok.tokenId,
          message: `Derived startSec ${tok.derivedStartSec} disagrees with sample-derived ${expectedSec}.`,
        });
      }
    }

    if (prevStart >= 0 && s < prevStart) {
      violations.push({
        code: 'UNORDERED_TOKENS',
        severity: 'ERROR',
        entityId: tok.tokenId,
        message: `Token start ${s} precedes previous token start ${prevStart}.`,
      });
    }

    if (prevEnd >= 0) {
      if (s > prevEnd + Math.round(params.authoritativeSampleRate * 0.15)) {
        pausesDetectedCount += 1;
      } else if (s < prevEnd) {
        overlapsDetectedCount += 1;
      }
    }

    prevStart = s;
    prevEnd = e;
  }

  return {
    valid: violations.every((v) => v.severity !== 'ERROR'),
    violations,
    pausesDetectedCount,
    overlapsDetectedCount,
  };
}

/**
 * Validates P06 ImmutableRenderPlan crossfade bounds and cumulative sample continuity.
 */
export function validateRenderPlanTiming(plan: ImmutableRenderPlan): TemporalIntegrityReport {
  const violations: TemporalIntegrityViolation[] = [];

  let cumulativeSamples = 0;
  for (const seg of plan.retainedSegments) {
    if (seg.sourceEndSample < seg.sourceStartSample || seg.sampleCount !== seg.sourceEndSample - seg.sourceStartSample) {
      violations.push({
        code: 'START_AFTER_END',
        severity: 'ERROR',
        entityId: `seg_${seg.segmentIndex}`,
        message: `Retained segment ${seg.segmentIndex} sampleCount mismatch.`,
      });
    }
    if (seg.outputStartSample !== cumulativeSamples) {
      violations.push({
        code: 'RENDER_PLAN_OUTPUT_DRIFT',
        severity: 'ERROR',
        entityId: `seg_${seg.segmentIndex}`,
        message: `Output start sample ${seg.outputStartSample} drifted from cumulative ${cumulativeSamples}.`,
      });
    }
    cumulativeSamples += seg.sampleCount;
  }

  if (cumulativeSamples !== plan.expectedPreResampleOutputSamples) {
    violations.push({
      code: 'RENDER_PLAN_OUTPUT_DRIFT',
      severity: 'ERROR',
      entityId: plan.planId,
      message: `Sum of retained segment samples (${cumulativeSamples}) != expectedPreResampleOutputSamples (${plan.expectedPreResampleOutputSamples}).`,
    });
  }

  for (const tr of plan.transitions) {
    const leftSeg = plan.retainedSegments[tr.leftSegmentIndex];
    const rightSeg = plan.retainedSegments[tr.rightSegmentIndex];
    if (tr.requestedCrossfadeSamples < 0) {
      violations.push({
        code: 'INVALID_CROSSFADE_BOUNDS',
        severity: 'ERROR',
        entityId: `tr_${tr.transitionIndex}`,
        message: `Negative crossfade sample length ${tr.requestedCrossfadeSamples}.`,
      });
    }
    if (leftSeg && rightSeg) {
      const maxFeasible = Math.min(leftSeg.sampleCount, rightSeg.sampleCount);
      if (tr.requestedCrossfadeSamples > maxFeasible && maxFeasible > 0) {
        violations.push({
          code: 'INVALID_CROSSFADE_BOUNDS',
          severity: 'WARNING',
          entityId: `tr_${tr.transitionIndex}`,
          message: `Requested crossfade (${tr.requestedCrossfadeSamples}) exceeds adjacent segment length (${maxFeasible}); renderer will clamp safely.`,
        });
      }
    }
  }

  return {
    valid: violations.every((v) => v.severity !== 'ERROR'),
    violations,
    pausesDetectedCount: 0,
    overlapsDetectedCount: 0,
  };
}

/**
 * Honest Real-Audio Alignment Evaluation Contract (AVP-P12-001 Section 13).
 * Never substitutes synthetic fixtures as real Persian speech alignment evidence.
 */
export function evaluateRealAudioAlignmentBenchmark(params: {
  readonly realHumanAnnotatedReferences?: ReadonlyArray<{
    readonly tokenId: string;
    readonly refStartMs: number;
    readonly refEndMs: number;
    readonly predStartMs: number | null;
    readonly predEndMs: number | null;
  }> | null;
}): RealAudioAlignmentBenchmarkReport {
  const refs = params.realHumanAnnotatedReferences;
  if (!refs || refs.length === 0) {
    return {
      status: 'NOT_EVALUATED',
      datasetKind: 'NONE',
      medianAbsBoundaryErrorMs: null,
      p95BoundaryErrorMs: null,
      startBoundaryMeanErrorMs: null,
      endBoundaryMeanErrorMs: null,
      tokenOmissionRate: null,
      tokenDuplicationRate: null,
      alignmentCoverage: null,
      note: 'No human-annotated real Persian speech alignment dataset is bundled in this environment. Synthetic signal tests are strictly excluded from real-world accuracy claims.',
    };
  }

  const startErrors: number[] = [];
  const endErrors: number[] = [];
  const allAbsErrors: number[] = [];
  let omitted = 0;

  for (const r of refs) {
    if (r.predStartMs === null || r.predEndMs === null) {
      omitted += 1;
      continue;
    }
    const se = Math.abs(r.predStartMs - r.refStartMs);
    const ee = Math.abs(r.predEndMs - r.refEndMs);
    startErrors.push(se);
    endErrors.push(ee);
    allAbsErrors.push(se, ee);
  }

  allAbsErrors.sort((a, b) => a - b);
  const median =
    allAbsErrors.length > 0 ? allAbsErrors[Math.floor(allAbsErrors.length / 2)] : null;
  const p95 =
    allAbsErrors.length > 0
      ? allAbsErrors[Math.min(allAbsErrors.length - 1, Math.ceil(allAbsErrors.length * 0.95) - 1)]
      : null;

  return {
    status: 'EVALUATED',
    datasetKind: 'REAL_HUMAN_ANNOTATED_PERSIAN',
    medianAbsBoundaryErrorMs: median !== null ? Number(median.toFixed(2)) : null,
    p95BoundaryErrorMs: p95 !== null ? Number(p95.toFixed(2)) : null,
    startBoundaryMeanErrorMs:
      startErrors.length > 0
        ? Number((startErrors.reduce((a, b) => a + b, 0) / startErrors.length).toFixed(2))
        : null,
    endBoundaryMeanErrorMs:
      endErrors.length > 0
        ? Number((endErrors.reduce((a, b) => a + b, 0) / endErrors.length).toFixed(2))
        : null,
    tokenOmissionRate: Number((omitted / refs.length).toFixed(4)),
    tokenDuplicationRate: 0,
    alignmentCoverage: Number(((refs.length - omitted) / refs.length).toFixed(4)),
    note: `Evaluated on ${refs.length} human-annotated Persian reference tokens.`,
  };
}
