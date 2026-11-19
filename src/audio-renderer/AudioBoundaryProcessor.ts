import { SampleIndex, SampleRate } from '../contracts/timebase.contract';
import { BoundaryCheckRecord, BoundaryQualityClass } from './AudioRenderTypes';

function computePlanarRmsDb(channels: readonly Float32Array[], start: number, end: number): number {
  if (channels.length === 0) return -96;
  const minChLen = Math.min(...channels.map((ch) => ch.length));
  const s = Math.max(0, start);
  const e = Math.min(minChLen, end);
  const len = e - s;
  if (len <= 0) return -96;

  let sumSq = 0;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = s; i < e; i++) {
      const rawV = ch[i];
      const v = Number.isFinite(rawV) ? rawV : 0;
      sumSq += v * v;
    }
  }
  const rms = Math.sqrt(sumSq / (len * channels.length));
  if (!Number.isFinite(rms) || rms <= 1e-6) return -96;
  return Number((20 * Math.log10(rms)).toFixed(2));
}

function sampleMagnitudeAcrossChannels(channels: readonly Float32Array[], index: number): number {
  let maxAbs = 0;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    if (index >= 0 && index < ch.length) {
      const rawV = ch[index];
      const a = Number.isFinite(rawV) ? Math.abs(rawV) : 0;
      if (a > maxAbs) maxAbs = a;
    }
  }
  return maxAbs;
}

function isZeroCrossingAt(channels: readonly Float32Array[], index: number): boolean {
  if (index <= 0 || channels.length === 0) return false;
  const primary = channels[0];
  if (index >= primary.length) return false;
  const rawPrev = primary[index - 1];
  const rawCurr = primary[index];
  const prev = Number.isFinite(rawPrev) ? rawPrev : 0;
  const curr = Number.isFinite(rawCurr) ? rawCurr : 0;
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
    /** Optional planar audio window immediately after originalLeftSample (into removed gap) */
    readonly leftPostWindow?: readonly Float32Array[];
    /** Optional planar audio window immediately before originalRightSample (into removed gap) */
    readonly rightPreWindow?: readonly Float32Array[];
    /** When true, searches symmetric shifts (left += delta, right += delta) so total retained samples stay invariant */
    readonly preserveTotalLength?: boolean;
    readonly maxAdjustmentSamples: number;
    /** Hard clamp so left cut cannot pull back further than available retained segment */
    readonly maxLeftPullbackSamples: number;
    /** Hard clamp so right resume cannot advance further than available retained segment */
    readonly maxRightAdvanceSamples: number;
  }): BoundaryCheckRecord {
    const {
      transitionIndex,
      proposalId,
      sampleRate: rawSampleRate,
      originalLeftSample,
      originalRightSample,
      leftWindow,
      rightWindow,
      leftPostWindow,
      rightPreWindow,
      preserveTotalLength = false,
      maxAdjustmentSamples: rawMaxAdjustmentSamples,
      maxLeftPullbackSamples: rawMaxLeftPullbackSamples,
      maxRightAdvanceSamples: rawMaxRightAdvanceSamples,
    } = params;

    const sampleRate: SampleRate =
      Number.isFinite(rawSampleRate) && rawSampleRate > 0 ? rawSampleRate : 48000;
    const maxAdjustmentSamples =
      Number.isFinite(rawMaxAdjustmentSamples) && rawMaxAdjustmentSamples >= 0
        ? Math.floor(rawMaxAdjustmentSamples)
        : 0;
    const maxLeftPullbackSamples =
      Number.isFinite(rawMaxLeftPullbackSamples) && rawMaxLeftPullbackSamples >= 0
        ? Math.floor(rawMaxLeftPullbackSamples)
        : 0;
    const maxRightAdvanceSamples =
      Number.isFinite(rawMaxRightAdvanceSamples) && rawMaxRightAdvanceSamples >= 0
        ? Math.floor(rawMaxRightAdvanceSamples)
        : 0;

    const notes: string[] = [];
    const leftLen =
      leftWindow.length > 0 ? Math.min(...leftWindow.map((ch) => ch.length)) : 0;
    const rightLen =
      rightWindow.length > 0 ? Math.min(...rightWindow.map((ch) => ch.length)) : 0;

    if (
      leftWindow.length === 0 ||
      leftLen < 2 ||
      rightLen < 2 ||
      leftWindow.length !== rightWindow.length
    ) {
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
      const lRaw = leftWindow[c][leftLen - 1];
      const rRaw = rightWindow[c][0];
      const lVal = Number.isFinite(lRaw) ? lRaw : 0;
      const rVal = Number.isFinite(rRaw) ? rRaw : 0;
      const jump = Math.abs(lVal - rVal);
      if (jump > origJump) origJump = jump;
    }

    const lEnd = Number.isFinite(leftWindow[0][leftLen - 1]) ? leftWindow[0][leftLen - 1] : 0;
    const lPrev = Number.isFinite(leftWindow[0][leftLen - 2]) ? leftWindow[0][leftLen - 2] : 0;
    const rStart = Number.isFinite(rightWindow[0][0]) ? rightWindow[0][0] : 0;
    const rNext = Number.isFinite(rightWindow[0][1]) ? rightWindow[0][1] : 0;
    const leftSlope = lEnd - lPrev;
    const rightSlope = rNext - rStart;
    const slopeSignMatch = leftSlope * rightSlope >= 0;

    // Determine whether adjustment is safe & warranted
    let leftDelta = 0; // signed delta applied to originalLeftSample
    let rightDelta = 0; // signed delta applied to originalRightSample
    let finalJump = origJump;
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
    } else if (preserveTotalLength) {
      // Symmetric shift search: left += delta, right += delta -> net retained sample count delta is 0.
      const leftPostLen =
        leftPostWindow && leftPostWindow.length >= leftWindow.length
          ? Math.min(...leftPostWindow.map((ch) => ch.length))
          : 0;
      const rightPreLen =
        rightPreWindow && rightPreWindow.length >= leftWindow.length
          ? Math.min(...rightPreWindow.map((ch) => ch.length))
          : 0;
      const gapSamples = Math.max(0, originalRightSample - originalLeftSample);
      const maxNegShift = Math.min(allowedLeftSearch, rightPreLen, gapSamples);
      const maxPosShift = Math.min(allowedRightSearch, leftPostLen, gapSamples);

      let bestDelta = 0;
      let bestJump = origJump;
      let bestScore = origJump;

      for (let d = 1; d <= maxNegShift; d++) {
        // delta = -d: left end is leftWindow[leftLen - 1 - d], right start is rightPreWindow[rightPreLen - d]
        let jump = 0;
        let maxMag = 0;
        for (let c = 0; c < leftWindow.length; c++) {
          const lRaw = leftWindow[c][leftLen - 1 - d];
          const rRaw = rightPreWindow![c][rightPreLen - d];
          const lVal = Number.isFinite(lRaw) ? lRaw : 0;
          const rVal = Number.isFinite(rRaw) ? rRaw : 0;
          const j = Math.abs(lVal - rVal);
          if (j > jump) jump = j;
          const m = Math.max(Math.abs(lVal), Math.abs(rVal));
          if (m > maxMag) maxMag = m;
        }
        const zcBonus = isZeroCrossingAt(leftWindow, leftLen - 1 - d) ? 0.85 : 1.0;
        const score = (jump + maxMag * 0.15) * zcBonus + (d / Math.max(1, maxAdjustmentSamples)) * 0.002;
        if (score < bestScore) {
          bestScore = score;
          bestJump = jump;
          bestDelta = -d;
        }
      }

      for (let d = 1; d <= maxPosShift; d++) {
        // delta = +d: left end is leftPostWindow[d - 1], right start is rightWindow[d]
        let jump = 0;
        let maxMag = 0;
        for (let c = 0; c < leftWindow.length; c++) {
          const lRaw = leftPostWindow![c][d - 1];
          const rRaw = rightWindow[c][d];
          const lVal = Number.isFinite(lRaw) ? lRaw : 0;
          const rVal = Number.isFinite(rRaw) ? rRaw : 0;
          const j = Math.abs(lVal - rVal);
          if (j > jump) jump = j;
          const m = Math.max(Math.abs(lVal), Math.abs(rVal));
          if (m > maxMag) maxMag = m;
        }
        const zcBonus = isZeroCrossingAt(rightWindow, d) ? 0.85 : 1.0;
        const score = (jump + maxMag * 0.15) * zcBonus + (d / Math.max(1, maxAdjustmentSamples)) * 0.002;
        if (score < bestScore) {
          bestScore = score;
          bestJump = jump;
          bestDelta = d;
        }
      }

      if (bestDelta !== 0 && bestJump < origJump * 0.85) {
        leftDelta = bestDelta;
        rightDelta = bestDelta;
        finalJump = bestJump;
        adjustmentApplied = true;
        notes.push(
          `Length-preserving acoustic alignment reduced waveform jump from ${origJump.toFixed(4)} to ${bestJump.toFixed(4)} (shift=${bestDelta >= 0 ? '+' : ''}${bestDelta} smp).`,
        );
      } else {
        notes.push('No superior length-preserving acoustic shift found within allowed radius; kept original sample boundaries.');
      }
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
        const lRaw = leftWindow[c][leftLen - 1 - bestLeft];
        const rRaw = rightWindow[c][bestRight];
        const lVal = Number.isFinite(lRaw) ? lRaw : 0;
        const rVal = Number.isFinite(rRaw) ? rRaw : 0;
        const j = Math.abs(lVal - rVal);
        if (j > refinedJump) refinedJump = j;
      }

      if (refinedJump < origJump * 0.85 && (bestLeft > 0 || bestRight > 0)) {
        leftDelta = -bestLeft;
        rightDelta = bestRight;
        finalJump = refinedJump;
        adjustmentApplied = true;
        notes.push(
          `Bounded acoustic alignment reduced waveform jump from ${origJump.toFixed(4)} to ${refinedJump.toFixed(4)} (left=${leftDelta} smp, right=+${rightDelta} smp).`,
        );
      } else {
        notes.push('No superior bounded zero-crossing found within allowed radius; kept original sample boundaries.');
      }
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
      adjustedLeftSample: originalLeftSample + leftDelta,
      originalRightSample,
      adjustedRightSample: originalRightSample + rightDelta,
      leftAdjustmentSamples: leftDelta,
      rightAdjustmentSamples: rightDelta,
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
