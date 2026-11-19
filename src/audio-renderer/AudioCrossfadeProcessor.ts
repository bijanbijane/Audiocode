import {
  CrossfadeCurve,
  CrossfadeTransitionResult,
} from './AudioRenderTypes';

/** Computes Pearson correlation coefficient across channel 0 of the overlap region */
function computeOverlapCorrelation(
  leftTail: Float32Array,
  rightHead: Float32Array,
  length: number,
): number {
  if (length < 4) return 0;
  let sumL = 0;
  let sumR = 0;
  for (let i = 0; i < length; i++) {
    const l = Number.isFinite(leftTail[i]) ? leftTail[i] : 0;
    const r = Number.isFinite(rightHead[i]) ? rightHead[i] : 0;
    sumL += l;
    sumR += r;
  }
  const meanL = sumL / length;
  const meanR = sumR / length;
  let cov = 0;
  let varL = 0;
  let varR = 0;
  for (let i = 0; i < length; i++) {
    const l = Number.isFinite(leftTail[i]) ? leftTail[i] : 0;
    const r = Number.isFinite(rightHead[i]) ? rightHead[i] : 0;
    const dl = l - meanL;
    const dr = r - meanR;
    cov += dl * dr;
    varL += dl * dl;
    varR += dr * dr;
  }
  const denom = Math.sqrt(varL * varR);
  if (!Number.isFinite(denom) || denom < 1e-10) return 0;
  return Number((cov / denom).toFixed(4));
}

function softLimitSample(v: number, ceiling = 0.999): number {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) <= ceiling) return v;
  const sign = v < 0 ? -1 : 1;
  const excess = Math.abs(v) - ceiling;
  return sign * (ceiling + (1 - ceiling) * Math.tanh(excess / (1 - ceiling)));
}

/**
 * Multi-Channel Context-Aware Crossfade Processor (AVP-P06-001)
 *
 * Supports linear, equal-power, and smooth-cosine curves with contextual selection:
 * - Correlated/coherent signals use smooth-cosine or linear to avoid +3 dB loudness bumps.
 * - Uncorrelated/ambient room-tone transitions use equal-power to avoid energy dips.
 * Preserves exact channel alignment, detects phase-cancellation risks, and prevents
 * transition clipping overshoot.
 */
export class AudioCrossfadeProcessor {
  public static computeGainPair(
    curve: CrossfadeCurve,
    progress01: number,
  ): { readonly fadeOutGain: number; readonly fadeInGain: number } {
    const safeProgress = Number.isFinite(progress01) ? progress01 : 0;
    const t = Math.max(0, Math.min(1, safeProgress));
    switch (curve) {
      case 'linear':
        return {
          fadeOutGain: 1 - t,
          fadeInGain: t,
        };
      case 'equal-power':
        return {
          fadeOutGain: Math.cos(t * Math.PI * 0.5),
          fadeInGain: Math.sin(t * Math.PI * 0.5),
        };
      case 'smooth-cosine': {
        const s = 0.5 * (1 - Math.cos(Math.PI * t));
        return {
          fadeOutGain: 1 - s,
          fadeInGain: s,
        };
      }
    }
  }

  public static selectCurveForOverlap(
    preferred: CrossfadeCurve | 'auto',
    correlation: number,
  ): CrossfadeCurve {
    if (preferred !== 'auto') return preferred;
    const safeCorr = Number.isFinite(correlation) ? correlation : 0;
    // Highly correlated / coherent periodic signals -> smooth-cosine prevents +3dB equal-power bump
    if (safeCorr > 0.35) {
      return 'smooth-cosine';
    }
    // Strongly anti-correlated signals -> linear avoids mid-fade phase dip amplification
    if (safeCorr < -0.35) {
      return 'linear';
    }
    // Uncorrelated speech/ambient room tone -> equal-power maintains perceived loudness
    return 'equal-power';
  }

  /**
   * Blends the tail of the outgoing segment with the head of the incoming segment across
   * all channels with strict channel alignment and bounded transition length.
   */
  public static blendTransition(params: {
    readonly transitionIndex: number;
    readonly proposalId: string;
    readonly leftTail: readonly Float32Array[];
    readonly rightHead: readonly Float32Array[];
    readonly preferredCurve: CrossfadeCurve | 'auto';
    readonly enableLimiter?: boolean;
  }): {
    readonly blended: Float32Array[];
    readonly result: CrossfadeTransitionResult;
  } {
    const {
      transitionIndex,
      proposalId,
      leftTail,
      rightHead,
      preferredCurve,
      enableLimiter = true,
    } = params;

    if (leftTail.length === 0 || leftTail.length !== rightHead.length) {
      throw new Error(
        `CHANNEL_MISMATCH: Crossfade received left=${leftTail.length}ch, right=${rightHead.length}ch.`,
      );
    }

    const channelCount = leftTail.length;
    const length = Math.min(leftTail[0].length, rightHead[0].length);
    for (let c = 1; c < channelCount; c++) {
      if (leftTail[c].length < length || rightHead[c].length < length) {
        throw new Error(
          `CHANNEL_MISMATCH: Channel ${c} shorter than primary channel during crossfade.`,
        );
      }
    }

    if (length < 2) {
      // Fallback: no crossfade possible; preserve exact rightHead samples
      return {
        blended: rightHead.map((ch) => {
          const out = new Float32Array(length);
          for (let i = 0; i < length; i++) {
            const v = ch[i];
            out[i] = Number.isFinite(v) ? v : 0;
          }
          return out;
        }),
        result: {
          transitionIndex,
          proposalId,
          applied: false,
          curveUsed: 'none',
          crossfadeSamples: 0,
          channelCount,
          correlationCoefficient: 0,
          phaseCancellationRisk: false,
          peakBeforeLimit: 0,
          peakAfterLimit: 0,
          limiterEngaged: false,
          fallbackUsed: true,
          notes: ['Available overlap shorter than 2 samples; fell back to direct boundary cut.'],
        },
      };
    }

    const correlation = computeOverlapCorrelation(leftTail[0], rightHead[0], length);
    const phaseCancellationRisk = correlation < -0.5;
    const curve = this.selectCurveForOverlap(preferredCurve, correlation);
    const notes: string[] = [];

    if (phaseCancellationRisk) {
      notes.push(
        `Negative inter-segment correlation (${correlation}) indicates potential phase cancellation; selected ${curve} curve.`,
      );
    } else if (preferredCurve === 'auto') {
      notes.push(`Auto-selected ${curve} curve based on overlap correlation (${correlation}).`);
    }

    const blended = Array.from({ length: channelCount }, () => new Float32Array(length));
    let peakBeforeLimit = 0;
    let peakAfterLimit = 0;
    let limiterEngaged = false;

    const denom = Math.max(1, length - 1);
    for (let i = 0; i < length; i++) {
      const progress = i / denom;
      const { fadeOutGain, fadeInGain } = this.computeGainPair(curve, progress);

      for (let c = 0; c < channelCount; c++) {
        const rawL = leftTail[c][i];
        const rawR = rightHead[c][i];
        const lSample = Number.isFinite(rawL) ? rawL : 0;
        const rSample = Number.isFinite(rawR) ? rawR : 0;
        let mixed = lSample * fadeOutGain + rSample * fadeInGain;
        const absRaw = Math.abs(mixed);
        if (absRaw > peakBeforeLimit) peakBeforeLimit = absRaw;

        if (enableLimiter && absRaw > 0.999) {
          mixed = softLimitSample(mixed, 0.999);
          limiterEngaged = true;
        }
        const absFinal = Math.abs(mixed);
        if (absFinal > peakAfterLimit) peakAfterLimit = absFinal;
        blended[c][i] = mixed;
      }
    }

    if (limiterEngaged) {
      notes.push(
        `Transition soft limiter prevented peak overshoot (${peakBeforeLimit.toFixed(4)} -> ${peakAfterLimit.toFixed(4)}).`,
      );
    }

    return {
      blended,
      result: {
        transitionIndex,
        proposalId,
        applied: true,
        curveUsed: curve,
        crossfadeSamples: length,
        channelCount,
        correlationCoefficient: correlation,
        phaseCancellationRisk,
        peakBeforeLimit: Number(peakBeforeLimit.toFixed(6)),
        peakAfterLimit: Number(peakAfterLimit.toFixed(6)),
        limiterEngaged,
        fallbackUsed: false,
        notes,
      },
    };
  }
}
