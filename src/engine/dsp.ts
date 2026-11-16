import { AcousticProfile, FlickRange, ProsodicBoundaryDetail } from '../contracts/v1_2';
import { flicksToSamples, msToFlicks, samplesToFlicks } from './timebase';

/**
 * Group A DSP & Persian Acoustic/Prosodic Boundary Engine (v1.2)
 * Operates at zero-second Cold Start without requiring heavy ASR models.
 */

export function extractAcousticProfile(
  assetId: string,
  samples: Float32Array,
  sampleRate: number,
): AcousticProfile {
  const frameLen = Math.max(1, Math.round(sampleRate * 0.02)); // 20ms frames
  const frameRmsList: { idx: number; rms: number }[] = [];

  for (let i = 0; i + frameLen <= samples.length; i += frameLen) {
    let sumSq = 0;
    for (let j = 0; j < frameLen; j++) {
      const s = samples[i + j];
      sumSq += s * s;
    }
    frameRmsList.push({ idx: i, rms: Math.sqrt(sumSq / frameLen) });
  }

  if (frameRmsList.length === 0) {
    return {
      assetId,
      noiseFloorDbfs: -60,
      roomToneRms: 0.001,
      roomToneSample: new Float32Array(Math.round(sampleRate * 0.5)),
      sampleRate,
    };
  }

  // Noise floor is estimated from the 10th percentile quietest non-digital-zero frames
  const sorted = [...frameRmsList].sort((a, b) => a.rms - b.rms);
  const nonZero = sorted.filter((f) => f.rms > 1e-6);
  const targetPool = nonZero.length > 0 ? nonZero : sorted;
  const p10 = targetPool[Math.floor(targetPool.length * 0.1)];
  const roomToneRms = Math.max(p10.rms, 0.0005);
  const noiseFloorDbfs = 20 * Math.log10(Math.max(roomToneRms, 1e-6));

  // Extract up to 0.5 seconds of quiet room tone around p10 frame
  const desiredLen = Math.round(sampleRate * 0.5);
  const roomToneSample = new Float32Array(desiredLen);
  const quietFrames = targetPool.slice(0, Math.min(25, targetPool.length));

  let writeOffset = 0;
  let frameCursor = 0;
  while (writeOffset < desiredLen && quietFrames.length > 0) {
    const srcStart = quietFrames[frameCursor % quietFrames.length].idx;
    const copyLen = Math.min(frameLen, desiredLen - writeOffset, samples.length - srcStart);
    for (let k = 0; k < copyLen; k++) {
      roomToneSample[writeOffset + k] = samples[srcStart + k];
    }
    writeOffset += copyLen;
    frameCursor++;
  }

  return {
    assetId,
    noiseFloorDbfs,
    roomToneRms,
    roomToneSample,
    sampleRate,
  };
}

/** Synthesizes natural Room Tone fill of targetLength samples with subtle overlap fade */
export function synthesizeRoomToneFill(
  profile: AcousticProfile,
  targetLength: number,
): Float32Array {
  const out = new Float32Array(targetLength);
  const src = profile.roomToneSample;
  if (src.length === 0) return out;

  for (let i = 0; i < targetLength; i++) {
    // Ping-pong wrap prevents discontinuity clicks when looping short room-tone samples
    const cycle = src.length * 2;
    const pos = i % cycle;
    const idx = pos < src.length ? pos : cycle - pos - 1;
    out[i] = src[idx];
  }
  return out;
}

/** Searches ±searchWindowMs around candidateSample for the Minimum RMS Energy Valley */
export function findMinimumRmsValley(
  samples: Float32Array,
  sampleRate: number,
  candidateSample: number,
  searchWindowMs = 35,
): number {
  const halfSearch = Math.round((sampleRate * searchWindowMs) / 1000);
  const rmsWin = Math.max(16, Math.round(sampleRate * 0.008)); // 8ms RMS window
  const minCenter = Math.max(rmsWin, candidateSample - halfSearch);
  const maxCenter = Math.min(samples.length - rmsWin - 1, candidateSample + halfSearch);

  if (minCenter >= maxCenter) {
    return Math.max(0, Math.min(samples.length - 1, candidateSample));
  }

  let bestIdx = candidateSample;
  let bestEnergy = Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.round(sampleRate * 0.001)); // 1ms step

  for (let c = minCenter; c <= maxCenter; c += step) {
    let sumSq = 0;
    const halfW = Math.floor(rmsWin / 2);
    for (let k = c - halfW; k < c + halfW; k++) {
      const s = samples[k];
      sumSq += s * s;
    }
    if (sumSq < bestEnergy) {
      bestEnergy = sumSq;
      bestIdx = c;
    }
  }

  return bestIdx;
}

/** Snaps sample index to nearest positive-going zero crossing within ±maxShiftSamples */
export function snapToZeroCrossing(
  samples: Float32Array,
  sampleIdx: number,
  maxShiftSamples = 240, // ±5ms at 48kHz
): { index: number; adjusted: boolean } {
  const clamped = Math.max(1, Math.min(samples.length - 2, sampleIdx));
  if (Math.abs(samples[clamped]) < 1e-5) {
    return { index: clamped, adjusted: false };
  }

  for (let delta = 0; delta <= maxShiftSamples; delta++) {
    const right = clamped + delta;
    if (right < samples.length - 1) {
      if ((samples[right] <= 0 && samples[right + 1] > 0) || (samples[right] >= 0 && samples[right + 1] < 0)) {
        return { index: right, adjusted: delta > 0 };
      }
    }
    const left = clamped - delta;
    if (left > 0) {
      if ((samples[left] <= 0 && samples[left + 1] > 0) || (samples[left] >= 0 && samples[left + 1] < 0)) {
        return { index: left, adjusted: delta > 0 };
      }
    }
  }

  return { index: clamped, adjusted: false };
}

/**
 * Equal-Power Micro-Crossfade (5-15ms cosine/sine curve) between leftTail and rightHead.
 * Eliminates splice clicks while maintaining constant perceived power (cos^2 + sin^2 = 1).
 */
export function applyEqualPowerMicroCrossfade(
  leftTail: Float32Array,
  rightHead: Float32Array,
): Float32Array {
  const len = Math.min(leftTail.length, rightHead.length);
  const out = new Float32Array(len);
  if (len === 0) return out;
  if (len === 1) {
    out[0] = (leftTail[0] + rightHead[0]) * 0.5;
    return out;
  }

  for (let i = 0; i < len; i++) {
    const t = i / (len - 1);
    const fadeOut = Math.cos(t * Math.PI * 0.5);
    const fadeIn = Math.sin(t * Math.PI * 0.5);
    out[i] = leftTail[i] * fadeOut + rightHead[i] * fadeIn;
  }
  return out;
}

/**
 * Detects Pitch/Formant Plateau (sustained vowel stretch like «رفتیممممم» or «بههههه»)
 * where no RMS silence valley exists because the vowel is continuously voiced.
 * Uses short-time autocorrelation periodicity + RMS envelope flatness.
 */
export function detectPitchPlateauSegments(
  samples: Float32Array,
  sampleRate: number,
  minDurationMs = 260,
): { startSample: number; endSample: number; confidence: number; f0Hz: number }[] {
  const frameLen = Math.round(sampleRate * 0.03); // 30ms
  const hopLen = Math.round(sampleRate * 0.015); // 15ms
  const minLag = Math.floor(sampleRate / 320); // max 320Hz F0
  const maxLag = Math.floor(sampleRate / 75); // min 75Hz F0

  interface FrameFeature {
    start: number;
    rms: number;
    f0Hz: number;
    periodicity: number;
  }

  const features: FrameFeature[] = [];

  for (let pos = 0; pos + frameLen <= samples.length; pos += hopLen) {
    let sumSq = 0;
    for (let i = 0; i < frameLen; i++) {
      const s = samples[pos + i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameLen);
    if (rms < 0.015) {
      features.push({ start: pos, rms, f0Hz: 0, periodicity: 0 });
      continue;
    }

    let bestLag = minLag;
    let bestCorr = -1;
    for (let lag = minLag; lag <= maxLag && lag < frameLen; lag++) {
      let num = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < frameLen - lag; i++) {
        const a = samples[pos + i];
        const b = samples[pos + i + lag];
        num += a * b;
        normA += a * a;
        normB += b * b;
      }
      const denom = Math.sqrt(normA * normB);
      const corr = denom > 1e-8 ? num / denom : 0;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    features.push({
      start: pos,
      rms,
      f0Hz: bestCorr > 0.72 ? sampleRate / bestLag : 0,
      periodicity: bestCorr,
    });
  }

  const results: { startSample: number; endSample: number; confidence: number; f0Hz: number }[] = [];
  const minFrames = Math.ceil(minDurationMs / 15);
  let runStart = -1;

  for (let i = 1; i < features.length; i++) {
    const prev = features[i - 1];
    const curr = features[i];
    const isStableVoiced =
      curr.periodicity > 0.78 &&
      prev.periodicity > 0.78 &&
      curr.f0Hz > 0 &&
      prev.f0Hz > 0 &&
      Math.abs(curr.f0Hz - prev.f0Hz) <= 6.0 &&
      Math.abs(curr.rms - prev.rms) / Math.max(prev.rms, 1e-5) < 0.25;

    if (isStableVoiced) {
      if (runStart === -1) runStart = i - 1;
    } else {
      if (runStart !== -1 && i - runStart >= minFrames) {
        const avgF0 =
          features.slice(runStart, i).reduce((acc, f) => acc + f.f0Hz, 0) / (i - runStart);
        results.push({
          startSample: features[runStart].start,
          endSample: features[i - 1].start + frameLen,
          confidence: Math.min(0.96, 0.74 + (i - runStart) * 0.015),
          f0Hz: Math.round(avgF0),
        });
      }
      runStart = -1;
    }
  }

  if (runStart !== -1 && features.length - runStart >= minFrames) {
    const avgF0 =
      features.slice(runStart).reduce((acc, f) => acc + f.f0Hz, 0) /
      (features.length - runStart);
    results.push({
      startSample: features[runStart].start,
      endSample: features[features.length - 1].start + frameLen,
      confidence: Math.min(0.96, 0.74 + (features.length - runStart) * 0.015),
      f0Hz: Math.round(avgF0),
    });
  }

  return results;
}

/** Group A Silence/Pause detector based on adaptive noise floor */
export function detectLongPauses(
  samples: Float32Array,
  sampleRate: number,
  profile: AcousticProfile,
  minPauseMs = 650,
): { startSample: number; endSample: number; durationMs: number }[] {
  const frameLen = Math.round(sampleRate * 0.025); // 25ms
  const threshold = Math.max(profile.roomToneRms * 2.2, 0.008);
  const pauses: { startSample: number; endSample: number; durationMs: number }[] = [];

  let silentStart = -1;
  for (let i = 0; i + frameLen <= samples.length; i += frameLen) {
    let sumSq = 0;
    for (let j = 0; j < frameLen; j++) {
      const s = samples[i + j];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameLen);
    if (rms <= threshold) {
      if (silentStart === -1) silentStart = i;
    } else if (silentStart !== -1) {
      const durMs = ((i - silentStart) * 1000) / sampleRate;
      if (durMs >= minPauseMs) {
        pauses.push({ startSample: silentStart, endSample: i, durationMs: Math.round(durMs) });
      }
      silentStart = -1;
    }
  }

  if (silentStart !== -1) {
    const durMs = ((samples.length - silentStart) * 1000) / sampleRate;
    if (durMs >= minPauseMs) {
      pauses.push({
        startSample: silentStart,
        endSample: samples.length,
        durationMs: Math.round(durMs),
      });
    }
  }

  return pauses;
}

/**
 * Computes full Persian Acoustic & Prosodic Boundary Detail for a candidate cut range.
 */
export function refinePersianCutBoundary(
  samples: Float32Array,
  sampleRate: number,
  rawRange: FlickRange,
  options: {
    pitchPlateauDetected?: boolean;
    trailingEzafeRisk?: boolean;
    trailingEzafeWord?: string;
    microCrossfadeMs?: number;
  } = {},
): ProsodicBoundaryDetail {
  const rawStartSample = flicksToSamples(rawRange.startFlicks, sampleRate);
  const rawEndSample = flicksToSamples(rawRange.endFlicks, sampleRate);

  const valleyStart = options.pitchPlateauDetected
    ? rawStartSample
    : findMinimumRmsValley(samples, sampleRate, rawStartSample, 30);
  const valleyEnd = findMinimumRmsValley(samples, sampleRate, rawEndSample, 30);

  const zcStart = snapToZeroCrossing(samples, valleyStart);
  const zcEnd = snapToZeroCrossing(samples, valleyEnd);

  const snappedStart = Math.min(zcStart.index, zcEnd.index - Math.round(sampleRate * 0.04));
  const snappedEnd = Math.max(zcEnd.index, snappedStart + Math.round(sampleRate * 0.04));

  const shiftMs = Math.round(((snappedStart - rawStartSample) * 1000) / sampleRate);
  const microCrossfadeMs = options.microCrossfadeMs ?? 10;

  let reasonFa = 'تراز شده با دره انرژی (Minimum RMS) و عبور از صفر (Zero-Crossing)';
  if (options.pitchPlateauDetected) {
    reasonFa = 'تشخیص کشیدگی واکه (Pitch/Formant Plateau) بدون دره سکوت میانی + قفل عبور از صفر';
  }
  if (options.trailingEzafeRisk && options.trailingEzafeWord) {
    reasonFa = `هشدار دنباله کسره اضافه روی «${options.trailingEzafeWord}» — اعمال هم‌پوشانی نرم ${microCrossfadeMs}ms`;
  }

  return {
    rawRange,
    snappedRange: {
      startFlicks: samplesToFlicks(snappedStart, sampleRate),
      endFlicks: samplesToFlicks(snappedEnd, sampleRate),
    },
    rmsValleyShiftMs: shiftMs,
    zeroCrossingAdjusted: zcStart.adjusted || zcEnd.adjusted,
    microCrossfadeMs,
    pitchPlateauDetected: Boolean(options.pitchPlateauDetected),
    trailingEzafeRisk: Boolean(options.trailingEzafeRisk),
    trailingEzafeWord: options.trailingEzafeWord,
    reasonFa,
  };
}

/** Detects Mic Bleed / Crosstalk where Track B carries attenuated bleed of active Track A */
export function detectCrosstalkBleed(
  primarySamples: Float32Array,
  secondarySamples: Float32Array,
  sampleRate: number,
  range: FlickRange,
): { isCrosstalk: boolean; bleedRatioDb: number } {
  const start = Math.max(0, flicksToSamples(range.startFlicks, sampleRate));
  const end = Math.min(primarySamples.length, secondarySamples.length, flicksToSamples(range.endFlicks, sampleRate));
  if (end <= start) return { isCrosstalk: false, bleedRatioDb: 0 };

  let sumA = 0;
  let sumB = 0;
  for (let i = start; i < end; i++) {
    sumA += primarySamples[i] * primarySamples[i];
    sumB += secondarySamples[i] * secondarySamples[i];
  }
  const rmsA = Math.sqrt(sumA / (end - start));
  const rmsB = Math.sqrt(sumB / (end - start));
  const ratioDb = 20 * Math.log10(Math.max(rmsB, 1e-6) / Math.max(rmsA, 1e-6));

  // If primary track is speaking strongly and secondary track is 12dB..34dB quieter in exact window -> mic bleed
  const isCrosstalk = rmsA > 0.04 && ratioDb <= -12 && ratioDb >= -36;
  return { isCrosstalk, bleedRatioDb: Number(ratioDb.toFixed(1)) };
}

export function clampMicroCrossfadeFlicks(ms: number): number {
  return msToFlicks(Math.max(5, Math.min(15, ms)));
}
