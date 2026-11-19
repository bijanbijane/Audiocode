import { SampleIndex, SampleRate } from '../contracts/timebase.contract';
import { BoundaryCheckRecord, BoundaryQualityClass } from './AudioRenderTypes';

function computePlanarRmsDb(channels: readonly Float32Array[], start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(channels[0]?.length ?? 0, end);
  const len = e - s;
  if (len <= 0 || channels.length === 0) return -96;

  let sumSq = 0;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = s; i < e; i++) {
      const v = ch[i];
      sumSq += v * v;
    }
  }
  const rms = Math.sqrt(sumSq / (len * channels.length));
  if (rms <= 1e-6) return -96;
  return Number((20 * Math.log10(rms)).toFixed(2));
}

function sampleMagnitudeAcrossChannels(channels: readonly Float32Array[], index: number): number {
  let maxAbs = 0;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    if (index >= 0 && index < ch.length) {
      const a = Math.abs(ch[index]);
      if (a > maxAbs) maxAbs = a;
    }
  }
  return maxAbs;
}

function isZeroCrossingAt(channels: readonly Float32Array[], index: number): boolean {
  if (index <= 0 || channels.length === 0) return false;
  const primary = channels[0];
  if (index >= primary.length) return false;
  const prev = primary[index - 1];
  const curr = primary[index];
  return (prev <= 0 && curr >= 0) || (prev >= 0 && curr <= 0);
}

/**
 * Acoustic Boundary Processor (AVP-P06-001)
 *
 * Evaluates local RMS energy, waveform discontinuity jump, slope continuity,
 * and bounded zero-crossing alignment around each approved splice junction.
 * Never blindly shifts cuts into high-energy speech onsets or beyond maxAdjustmentSamples.
 */
export class AudioBoundaryProcessor {
  public static evaluateAndRefineJunction(params: {
    readonly transitionIndex: number;
    readonly proposalId: string;
    readonly sampleRate: SampleRate;
    readonly originalLeftSample: SampleIndex;
    readonly originalRightSample: SampleIndex;
    /** Planar audio window ending at originalLeftSample (length >= analysisWindowSamples) */
    readonly leftWindow: readonly Float32Array[];
    /** Planar audio window starting at originalRightSample (length >= analysisWindowSamples) */
    readonly rightWindow: readonly Float32Array[];
    readonly maxAdjustmentSamples: number;
    /** Hard clamp so left cut cannot pull back further than available retained segment */
    readonly maxLeftPullbackSamples: number;
    /** Hard clamp so right resume cannot advance further than available retained segment */
    readonly maxRightAdvanceSamples: number;
  }): BoundaryCheckRecord {
    const {
      transitionIndex,
      proposalId,
      sampleRate,
      originalLeftSample,
      originalRightSample,
      leftWindow,
      rightWindow,
      maxAdjustmentSamples,
      maxLeftPullbackSamples,
      maxRightAdvanceSamples,
    } = params;

    const notes: string[] = [];
    const leftLen = leftWindow[0]?.length ?? 0;
    const rightLen = rightWindow[0]?.length ?? 0;

    if (leftLen < 2 || rightLen < 2 || leftWindow.length !== rightWindow.length) {
      return {
        transitionIndex,
        proposalId,
        originalLeftSample,
        adjustedLeftSample: originalLeftSample,
        originalRightSample,
        adjustedRightSample: originalRightSample,
        leftAdjustmentSamples: 0,
        rightAdjustmentSamples: 0,
        maxAllowedAdjustmentSamples: maxAdjustmentSamples,
        leftRmsDb: -96,
        rightRmsDb: -96,
        energyDeltaDb: 0,
        discontinuityJump: 0,
        slopeSignMatch: true,
        qualityClass: 'UNSAFE',
        adjustmentApplied: false,
        rejectedAdjustmentReason:
          'Insufficient audio window or channel mismatch around splice junction.',
        notes: ['Boundary window too short or channel count mismatched.'],
      };
    }

    const analysisWin = Math.min(
      Math.max(32, Math.round(sampleRate * 0.015)), // 15ms local energy window
      leftLen,
      rightLen,
    );

    const leftRmsDb = computePlanarRmsDb(leftWindow, leftLen - analysisWin, leftLen);
    const rightRmsDb = computePlanarRmsDb(rightWindow, 0, analysisWin);
    const energyDeltaDb = Number(Math.abs(leftRmsDb - rightRmsDb).toFixed(2));

    // Evaluate original splice discontinuity across all channels
    let origJump = 0;
    for (let c = 0; c < leftWindow.length; c++) {
      const jump = Math.abs(leftWindow[c][leftLen - 1] - rightWindow[c][0]);
      if (jump > origJump) origJump = jump;
    }

    const leftSlope = leftWindow[0][leftLen - 1] - leftWindow[0][leftLen - 2];
    const rightSlope = rightWindow[0][1] - rightWindow[0][0];
    const slopeSignMatch = leftSlope * rightSlope >= 0;

    // Determine whether adjustment is safe & warranted
    let leftOffset = 0; // pullback into leftWindow (>= 0)
    let rightOffset = 0; // advance into rightWindow (>= 0)
    let adjustmentApplied = false;
    let rejectedAdjustmentReason: string | undefined;

    const allowedLeftSearch = Math.max(
      0,
      Math.min(maxAdjustmentSamples, maxLeftPullbackSamples, leftLen - 2),
    );
    const allowedRightSearch = Math.max(
      0,
      Math.min(maxAdjustmentSamples, maxRightAdvanceSamples, rightLen - 2),
    );

    // Protect high-energy active speech (> -18 dBFS) from aggressive boundary shifting
    const highEnergySpeech = leftRmsDb > -18 || rightRmsDb > -18;
    const alreadyQuietAndSmooth = origJump < 0.008 && leftRmsDb < -42 && rightRmsDb < -42;

    if (alreadyQuietAndSmooth) {
      notes.push('Original boundary is already near silence floor with minimal discontinuity; no shift required.');
    } else if (maxAdjustmentSamples <= 0) {
      notes.push('Zero-adjustment policy active; original approved sample coordinates preserved.');
    } else if (highEnergySpeech && origJump < 0.04) {
      notes.push(
        'High-energy speech detected near boundary; preserving exact approved coordinates and relying on bounded crossfade.',
      );
      rejectedAdjustmentReason =
        'Skipped zero-crossing shift to avoid truncating adjacent high-energy speech phoneme.';
    } else {
      // Bounded local search for low-amplitude zero crossing within [0..allowedSearch]
      let bestLeft = 0;
      let bestLeftScore = sampleMagnitudeAcrossChannels(leftWindow, leftLen - 1);
      for (let d = 1; d <= allowedLeftSearch; d++) {
        const idx = leftLen - 1 - d;
        const mag = sampleMagnitudeAcrossChannels(leftWindow, idx);
        const zcBonus = isZeroCrossingAt(leftWindow, idx) ? 0.5 : 1.0;
        const score = mag * zcBonus + (d / Math.max(1, allowedLeftSearch)) * 0.002;
        if (score < bestLeftScore) {
          bestLeftScore = score;
          bestLeft = d;
        }
      }

      let bestRight = 0;
      let bestRightScore = sampleMagnitudeAcrossChannels(rightWindow, 0);
      for (let d = 1; d <= allowedRightSearch; d++) {
        const idx = d;
        const mag = sampleMagnitudeAcrossChannels(rightWindow, idx);
        const zcBonus = isZeroCrossingAt(rightWindow, idx) ? 0.5 : 1.0;
        const score = mag * zcBonus + (d / Math.max(1, allowedRightSearch)) * 0.002;
        if (score < bestRightScore) {
          bestRightScore = score;
          bestRight = d;
        }
      }

      // Compute jump after candidate shift
      let refinedJump = 0;
      for (let c = 0; c < leftWindow.length; c++) {
        const lVal = leftWindow[c][leftLen - 1 - bestLeft];
        const rVal = rightWindow[c][bestRight];
        const j = Math.abs(lVal - rVal);
        if (j > refinedJump) refinedJump = j;
      }

      if (refinedJump < origJump * 0.85 && (bestLeft > 0 || bestRight > 0)) {
        leftOffset = bestLeft;
        rightOffset = bestRight;
        adjustmentApplied = true;
        notes.push(
          `Bounded acoustic alignment reduced waveform jump from ${origJump.toFixed(4)} to ${refinedJump.toFixed(4)} (left=-${leftOffset} smp, right=+${rightOffset} smp).`,
        );
      } else {
        notes.push('No superior bounded zero-crossing found within allowed radius; kept original sample boundaries.');
      }
    }

    // Recompute final discontinuity at chosen boundary
    let finalJump = 0;
    for (let c = 0; c < leftWindow.length; c++) {
      const lVal = leftWindow[c][leftLen - 1 - leftOffset];
      const rVal = rightWindow[c][rightOffset];
      const j = Math.abs(lVal - rVal);
      if (j > finalJump) finalJump = j;
    }

    let qualityClass: BoundaryQualityClass = 'CLEAN';
    if (finalJump > 0.35 || energyDeltaDb > 28) {
      qualityClass = 'UNSAFE';
    } else if (finalJump > 0.12 || energyDeltaDb > 16 || highEnergySpeech) {
      qualityClass = 'RISKY';
    } else if (finalJump > 0.025 || energyDeltaDb > 8) {
      qualityClass = 'ACCEPTABLE';
    }

    return {
      transitionIndex,
      proposalId,
      originalLeftSample,
      adjustedLeftSample: originalLeftSample - leftOffset,
      originalRightSample,
      adjustedRightSample: originalRightSample + rightOffset,
      leftAdjustmentSamples: -leftOffset,
      rightAdjustmentSamples: rightOffset,
      maxAllowedAdjustmentSamples: maxAdjustmentSamples,
      leftRmsDb,
      rightRmsDb,
      energyDeltaDb,
      discontinuityJump: Number(finalJump.toFixed(6)),
      slopeSignMatch,
      qualityClass,
      adjustmentApplied,
      rejectedAdjustmentReason,
      notes,
    };
  }
}
