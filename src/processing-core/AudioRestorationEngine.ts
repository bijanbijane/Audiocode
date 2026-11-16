import { SampleIndex, SampleRate } from '../contracts/timebase.contract';
import { ProcessingNodeSpec } from './ProcessingGraphEngine';

export type RestorationBackend = 'WASM_NATIVE' | 'TYPESCRIPT_FALLBACK';

export interface WasmRestorationBridge {
  allocF32(length: number): number;
  freeF32(ptr: number): void;
  getHeapF32View(ptr: number, length: number): Float32Array;
  deClickInPlace(ptr: number, length: number, sampleRate: number, sensitivity: number, maxClickMs: number): number;
  deClipInPlace(ptr: number, length: number, threshold: number, autoHeadroom: boolean): number;
  deReverbInPlace(
    ptr: number,
    length: number,
    sampleRate: number,
    reductionAmount: number,
    estimatedRt60Sec: number,
  ): void;
}

export interface RawWasmRestorationExports {
  readonly memory: WebAssembly.Memory;
  alloc_f32(length: number): number;
  free_f32(ptr: number, length: number): void;
  de_click_in_place(ptr: number, length: number, sampleRate: number, sensitivity: number, maxClickMs: number): number;
  de_clip_in_place(ptr: number, length: number, threshold: number, autoHeadroom: number): number;
  de_reverb_in_place(
    ptr: number,
    length: number,
    sampleRate: number,
    reductionAmount: number,
    estimatedRt60Sec: number,
  ): void;
}

/**
 * Wraps raw wasm-bindgen / C-ABI WebAssembly exports + linear WebAssembly.Memory
 * into a Zero-Copy WasmRestorationBridge.
 */
export function createWasmRestorationBridge(
  exports: RawWasmRestorationExports,
): WasmRestorationBridge {
  const allocatedLengths = new Map<number, number>();
  return {
    allocF32(length: number): number {
      const ptr = exports.alloc_f32(length);
      allocatedLengths.set(ptr, length);
      return ptr;
    },
    freeF32(ptr: number): void {
      const len = allocatedLengths.get(ptr) ?? 0;
      allocatedLengths.delete(ptr);
      exports.free_f32(ptr, len);
    },
    getHeapF32View(ptr: number, length: number): Float32Array {
      return new Float32Array(exports.memory.buffer, ptr, length);
    },
    deClickInPlace(ptr, length, sampleRate, sensitivity, maxClickMs) {
      return exports.de_click_in_place(ptr, length, sampleRate, sensitivity, maxClickMs);
    },
    deClipInPlace(ptr, length, threshold, autoHeadroom) {
      return exports.de_clip_in_place(ptr, length, threshold, autoHeadroom ? 1 : 0);
    },
    deReverbInPlace(ptr, length, sampleRate, reductionAmount, estimatedRt60Sec) {
      exports.de_reverb_in_place(ptr, length, sampleRate, reductionAmount, estimatedRt60Sec);
    },
  };
}

export interface DeClickConfig {
  readonly enabled: boolean;
  /** Detection algorithm: TKEO (Teager-Kaiser Energy Operator) or HIGHPASS (2nd-order diff) */
  readonly detectorMode?: 'HIGHPASS' | 'TKEO';
  /** Threshold multiplier above local baseline (HIGHPASS default 6.5, TKEO default 14.0) */
  readonly sensitivity?: number;
  /** Maximum impulse duration in milliseconds so Persian plosives (/پ/, /ت/, /ق/) stay intact (default 2.5ms) */
  readonly maxClickWidthMs?: number;
}

export interface DeClipConfig {
  readonly enabled: boolean;
  /** Absolute sample amplitude considered clipped plateau (default 0.992) */
  readonly clipThreshold?: number;
  /** Scales output down so reconstructed peaks above 1.0 stay safe without re-clipping (default true) */
  readonly normalizeReconstructedHeadroom?: boolean;
}

export interface SpectralDeReverbConfig {
  readonly enabled: boolean;
  /** De-reverb algorithm: SPECTRAL_STFT (1024-pt STFT) or ENVELOPE_DIFF (time-domain fast/slow envelope) */
  readonly mode?: 'SPECTRAL_STFT' | 'ENVELOPE_DIFF';
  /** Suppression strength in [0.0, 1.0] (default 0.55) */
  readonly reductionAmount?: number;
  /** Target room reverberation time RT60 in seconds (default 0.65s) */
  readonly estimatedRt60Seconds?: number;
  /** Minimum spectral floor gain to keep natural room ambience (default 0.16 ≈ -16 dB) */
  readonly spectralFloor?: number;
}

export interface AudioRestorationPipelineConfig {
  readonly sampleRate: SampleRate;
  readonly deClick: DeClickConfig;
  readonly deClip: DeClipConfig;
  readonly deReverb: SpectralDeReverbConfig;
}

export interface RestorationTelemetrySummary {
  readonly backendUsed: RestorationBackend;
  readonly algorithmicLatencySamples: SampleIndex;
  readonly clicksDetected: number;
  readonly clickSamplesRepaired: number;
  readonly clippedSegmentsRepaired: number;
  readonly peakPreNormalizationMax: number;
  readonly reverbReductionApplied: boolean;
}

// ============================================================================
// In-Place Radix-2 Cooley-Tukey Complex FFT (1024-point Spectral De-Reverb)
// ============================================================================
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >>> 1;
    while (j & bit) {
      j ^= bit;
      bit >>>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >>> 1;
    const angle = (sign * 2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let j = 0; j < half; j++) {
        const even = i + j;
        const odd = even + half;
        const oddRe = re[odd] * wRe - im[odd] * wIm;
        const oddIm = re[odd] * wIm + im[odd] * wRe;

        re[odd] = re[even] - oddRe;
        im[odd] = im[even] - oddIm;
        re[even] += oddRe;
        im[even] += oddIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    const invN = 1.0 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

/**
 * Audio Restoration Engine (Architecture Doc Section 2.4):
 * - De-Click: localized high-pass transient detection + Catmull-Rom cubic repair (preserves speech plosives)
 * - De-Clip: flat-top plateau detection + derivative-matched cubic Hermite peak reconstruction
 * - Spectral De-Reverb: 1024-pt STFT Lebart delayed late-reverb suppression with 75% COLA overlap-add
 *
 * Uses an injected Zero-Copy WASM linear memory bridge when compiled WASM DSP kernels are mounted,
 * and falls back cleanly to bit-equivalent Float32Array DSP execution in TypeScript.
 */
export class AudioRestorationEngine {
  public static readonly STFT_FFT_SIZE = 1024;
  public static readonly STFT_HOP_SIZE = 256;

  private readonly wasmBridge: WasmRestorationBridge | null;

  constructor(wasmBridge: WasmRestorationBridge | null = null) {
    this.wasmBridge = wasmBridge;
  }

  public getAlgorithmicLatencySamples(config: AudioRestorationPipelineConfig): SampleIndex {
    let latency = 0;
    if (config.deClick.enabled) latency += 16;
    if (config.deReverb.enabled) latency += AudioRestorationEngine.STFT_FFT_SIZE;
    return latency;
  }

  /**
   * Produces a deterministic ProcessingNodeSpec so ProcessingGraphEngine
   * computes exact Automatic PDC compensation and Pre-Roll priming for restoration stages.
   */
  public buildProcessingGraphNodeSpec(
    nodeId: string,
    config: AudioRestorationPipelineConfig,
  ): ProcessingNodeSpec {
    const anyEnabled =
      config.deClick.enabled || config.deClip.enabled || config.deReverb.enabled;
    const latencySamples = this.getAlgorithmicLatencySamples(config);
    const tailSamples = config.deReverb.enabled
      ? Math.round(config.sampleRate * 0.04)
      : 0;

    return {
      id: nodeId,
      type: 'DE_REVERB',
      version: '1.2.0',
      enabled: anyEnabled,
      latencySamples,
      preRollSamples: config.deReverb.enabled ? AudioRestorationEngine.STFT_FFT_SIZE : 32,
      tailSamples,
      committedParameters: {
        deClickEnabled: config.deClick.enabled,
        deClickSensitivity: config.deClick.sensitivity ?? 6.5,
        deClickMaxMs: config.deClick.maxClickWidthMs ?? 2.5,
        deClipEnabled: config.deClip.enabled,
        deClipThreshold: config.deClip.clipThreshold ?? 0.992,
        deReverbEnabled: config.deReverb.enabled,
        deReverbAmount: config.deReverb.reductionAmount ?? 0.55,
        deReverbRt60: config.deReverb.estimatedRt60Seconds ?? 0.65,
      },
    };
  }

  /**
   * Executes the full restoration pipeline non-destructively (returns repaired cloned channels)
   * or delegates into Zero-Copy WASM linear memory when `wasmBridge` is available.
   */
  public restoreChannels(
    channels: readonly Float32Array[],
    config: AudioRestorationPipelineConfig,
  ): {
    repairedChannels: Float32Array[];
    telemetry: RestorationTelemetrySummary;
  } {
    const repairedChannels = channels.map((ch) => new Float32Array(ch));
    let clicksDetected = 0;
    let clickSamplesRepaired = 0;
    let clippedSegmentsRepaired = 0;
    let peakPreNormalizationMax = 0;
    let backendUsed: RestorationBackend = 'TYPESCRIPT_FALLBACK';

    for (let c = 0; c < repairedChannels.length; c++) {
      const ch = repairedChannels[c];
      if (ch.length === 0) continue;

      if (this.wasmBridge) {
        backendUsed = 'WASM_NATIVE';
        const ptr = this.wasmBridge.allocF32(ch.length);
        try {
          const wasmView = this.wasmBridge.getHeapF32View(ptr, ch.length);
          wasmView.set(ch);

          if (config.deClip.enabled) {
            clippedSegmentsRepaired += this.wasmBridge.deClipInPlace(
              ptr,
              ch.length,
              config.deClip.clipThreshold ?? 0.992,
              config.deClip.normalizeReconstructedHeadroom ?? true,
            );
          }
          if (config.deClick.enabled) {
            clicksDetected += this.wasmBridge.deClickInPlace(
              ptr,
              ch.length,
              config.sampleRate,
              config.deClick.sensitivity ?? 6.5,
              config.deClick.maxClickWidthMs ?? 2.5,
            );
          }
          if (config.deReverb.enabled) {
            this.wasmBridge.deReverbInPlace(
              ptr,
              ch.length,
              config.sampleRate,
              config.deReverb.reductionAmount ?? 0.55,
              config.deReverb.estimatedRt60Seconds ?? 0.65,
            );
          }

          ch.set(wasmView);
          continue;
        } finally {
          this.wasmBridge.freeF32(ptr);
        }
      }

      // Order: De-Clip first (restores peak waveform continuity) -> De-Click -> Spectral De-Reverb
      if (config.deClip.enabled) {
        const clipStats = AudioRestorationEngine.deClipChannelInPlace(ch, config.deClip);
        clippedSegmentsRepaired += clipStats.clippedSegmentsRepaired;
        if (clipStats.preNormalizationPeak > peakPreNormalizationMax) {
          peakPreNormalizationMax = clipStats.preNormalizationPeak;
        }
      }

      if (config.deClick.enabled) {
        if (config.deClick.detectorMode === 'TKEO') {
          const repairedClicks = AudioRestorationEngine.removeMouthClicksInPlace(
            ch,
            config.sampleRate,
            config.deClick.sensitivity ?? 14.0,
          );
          clicksDetected += repairedClicks;
        } else {
          const clickStats = AudioRestorationEngine.deClickChannelInPlace(
            ch,
            config.sampleRate,
            config.deClick,
          );
          clicksDetected += clickStats.clicksDetected;
          clickSamplesRepaired += clickStats.clickSamplesRepaired;
        }
      }

      if (config.deReverb.enabled) {
        if (config.deReverb.mode === 'ENVELOPE_DIFF') {
          AudioRestorationEngine.reduceRoomReverbInPlace(
            ch,
            config.sampleRate,
            config.deReverb.reductionAmount ?? 0.55,
          );
        } else {
          AudioRestorationEngine.deReverbChannelInPlace(ch, config.sampleRate, config.deReverb);
        }
      }
    }

    return {
      repairedChannels,
      telemetry: {
        backendUsed,
        algorithmicLatencySamples: this.getAlgorithmicLatencySamples(config),
        clicksDetected,
        clickSamplesRepaired,
        clippedSegmentsRepaired,
        peakPreNormalizationMax: Number(peakPreNormalizationMax.toFixed(4)),
        reverbReductionApplied: config.deReverb.enabled,
      },
    };
  }

  // --------------------------------------------------------------------------
  // 1. De-Click (Mouth Click / Lip Smack Impulsive Transient Repair)
  // --------------------------------------------------------------------------
  public static deClickChannelInPlace(
    samples: Float32Array,
    sampleRate: SampleRate,
    config: DeClickConfig,
  ): { clicksDetected: number; clickSamplesRepaired: number } {
    const n = samples.length;
    if (n < 32) return { clicksDetected: 0, clickSamplesRepaired: 0 };

    const sensitivity = Math.max(2.5, config.sensitivity ?? 6.5);
    const maxClickSamples = Math.max(
      4,
      Math.round(((config.maxClickWidthMs ?? 2.5) / 1000) * sampleRate),
    );

    // 2nd-order difference highlights abrupt discontinuities (mouth clicks) while ignoring slow vowels
    const hp = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      hp[i] = Math.abs(samples[i] - 0.5 * (samples[i - 1] + samples[i + 1]));
    }

    // Compute local envelope excluding immediate center impulse radius
    const halfWin = Math.max(64, Math.round(0.012 * sampleRate)); // 12ms context each side
    const flagged = new Uint8Array(n);
    const minAbsoluteImpulse = 0.012;

    // Prefix sum of hp magnitudes for O(N) outer-ring average calculation
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      prefix[i + 1] = prefix[i] + hp[i];
    }

    const guard = 6;
    for (let i = 2; i < n - 2; i++) {
      const leftStart = Math.max(0, i - halfWin);
      const leftEnd = Math.max(leftStart, i - guard);
      const rightStart = Math.min(n, i + guard + 1);
      const rightEnd = Math.min(n, i + halfWin + 1);

      const leftSum = prefix[leftEnd] - prefix[leftStart];
      const rightSum = prefix[rightEnd] - prefix[rightStart];
      const count = leftEnd - leftStart + (rightEnd - rightStart);
      const localMean = count > 0 ? (leftSum + rightSum) / count : 0;

      if (hp[i] > minAbsoluteImpulse && hp[i] > localMean * sensitivity) {
        flagged[i] = 1;
      }
    }

    // Group adjacent impulsive flags (bridging gaps <= 3 samples)
    let clicksDetected = 0;
    let clickSamplesRepaired = 0;
    let i = 2;

    while (i < n - 2) {
      if (!flagged[i]) {
        i++;
        continue;
      }
      const start = Math.max(2, i - 1);
      let end = i;
      let gap = 0;
      let j = i + 1;

      while (j < n - 2 && gap <= 3) {
        if (flagged[j]) {
          end = j;
          gap = 0;
        } else {
          gap++;
        }
        j++;
      }
      end = Math.min(n - 3, end + 1);

      const width = end - start + 1;
      // Only repair short impulsive clicks; preserve sustained speech fricatives/plosives
      if (width <= maxClickSamples) {
        const p0 = samples[start - 2];
        const p1 = samples[start - 1];
        const p2 = samples[end + 1];
        const p3 = samples[end + 2];

        const span = end - start + 2;
        for (let k = start; k <= end; k++) {
          const t = (k - (start - 1)) / span;
          // Catmull-Rom spline interpolation through clean neighbor anchors
          const t2 = t * t;
          const t3 = t2 * t;
          const val =
            0.5 *
            (2 * p1 +
              (-p0 + p2) * t +
              (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
              (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
          samples[k] = Math.max(-1.0, Math.min(1.0, val));
        }

        clicksDetected++;
        clickSamplesRepaired += width;
      }

      i = end + 2;
    }

    return { clicksDetected, clickSamplesRepaired };
  }

  // --------------------------------------------------------------------------
  // 2. De-Clip (Cubic Hermite Peak Reconstruction & Headroom Recovery)
  // --------------------------------------------------------------------------
  public static deClipChannelInPlace(
    samples: Float32Array,
    config: DeClipConfig,
  ): { clippedSegmentsRepaired: number; preNormalizationPeak: number } {
    const n = samples.length;
    if (n < 8) return { clippedSegmentsRepaired: 0, preNormalizationPeak: 0 };

    const threshold = Math.fround(Math.max(0.8, Math.min(0.9999, config.clipThreshold ?? 0.992))) - 1e-5;
    const normalizeHeadroom = config.normalizeReconstructedHeadroom ?? true;

    let clippedSegmentsRepaired = 0;
    let maxPeak = 0;
    let i = 2;

    while (i < n - 2) {
      if (Math.abs(samples[i]) < threshold) {
        if (Math.abs(samples[i]) > maxPeak) maxPeak = Math.abs(samples[i]);
        i++;
        continue;
      }

      const sign = samples[i] >= 0 ? 1 : -1;
      const start = i;
      let end = i;
      while (
        end + 1 < n - 2 &&
        Math.abs(samples[end + 1]) >= threshold &&
        (samples[end + 1] >= 0 ? 1 : -1) === sign
      ) {
        end++;
      }

      const runLen = end - start + 1;
      // Requires >= 2 contiguous plateau samples to confirm hard clipping vs clean single peak
      if (runLen >= 2) {
        const y0 = samples[start - 1];
        const y1 = samples[end + 1];
        const m0 = samples[start - 1] - samples[start - 2];
        const m1 = samples[end + 2] - samples[end + 1];
        const span = end - start + 2;

        for (let k = start; k <= end; k++) {
          const t = (k - (start - 1)) / span;
          const t2 = t * t;
          const t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;

          let reconstructed = h00 * y0 + h10 * (m0 * span) + h01 * y1 + h11 * (m1 * span);
          reconstructed = Math.max(-2.5, Math.min(2.5, reconstructed));
          samples[k] = reconstructed;

          const absR = Math.abs(reconstructed);
          if (absR > maxPeak) maxPeak = absR;
        }
        clippedSegmentsRepaired++;
      }

      i = end + 2;
    }

    if (normalizeHeadroom && maxPeak > 0.96) {
      // Scale smoothly to -0.35 dBFS headroom so restored peaks never re-clip downstream
      const scale = 0.96 / maxPeak;
      for (let k = 0; k < n; k++) {
        samples[k] *= scale;
      }
    }

    return { clippedSegmentsRepaired, preNormalizationPeak: maxPeak };
  }

  // --------------------------------------------------------------------------
  // 3. Spectral De-Reverb (1024-pt STFT Delayed Late-Reverberation Suppression)
  // --------------------------------------------------------------------------
  public static deReverbChannelInPlace(
    samples: Float32Array,
    sampleRate: SampleRate,
    config: SpectralDeReverbConfig,
  ): void {
    const n = samples.length;
    const fftSize = AudioRestorationEngine.STFT_FFT_SIZE;
    const hopSize = AudioRestorationEngine.STFT_HOP_SIZE;
    if (n < fftSize) return;

    const reduction = Math.max(0, Math.min(1, config.reductionAmount ?? 0.55));
    if (reduction === 0) return;

    const rt60Sec = Math.max(0.15, Math.min(3.0, config.estimatedRt60Seconds ?? 0.65));
    const minGain = Math.max(0.05, Math.min(0.8, config.spectralFloor ?? 0.16));

    // Periodic Hann window for exact COLA reconstruction at 75% overlap (hop = fftSize / 4)
    const window = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / fftSize));
    }

    const paddedLen = Math.ceil((n - fftSize) / hopSize) * hopSize + fftSize;
    const output = new Float64Array(paddedLen);
    const norm = new Float64Array(paddedLen);

    const numBins = fftSize / 2 + 1;
    const hopSec = hopSize / sampleRate;
    // RT60 corresponds to 60 dB (10^-6) power decay: ln(10^6) ≈ 13.8155
    const decayFactor = Math.exp((-13.8155 * hopSec) / rt60Sec);

    // Delay past frames by ~16ms so direct speech onsets and early reflections stay untouched
    const delayFrames = Math.max(2, Math.round(0.016 / hopSec));
    const powerRing: Float64Array[] = Array.from(
      { length: delayFrames },
      () => new Float64Array(numBins),
    );
    let ringIdx = 0;

    const lateReverbPower = new Float64Array(numBins);
    const gains = new Float64Array(numBins);
    const smoothedGains = new Float64Array(numBins);

    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);

    for (let pos = 0; pos + fftSize <= paddedLen; pos += hopSize) {
      for (let i = 0; i < fftSize; i++) {
        const s = pos + i < n ? samples[pos + i] : 0;
        re[i] = s * window[i];
        im[i] = 0;
      }

      fftRadix2(re, im, false);

      const delayedPower = powerRing[ringIdx];
      const currentPower = new Float64Array(numBins);

      for (let k = 0; k < numBins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        currentPower[k] = p;

        // Physical direct-to-reverberant coupling: late diffuse reflections carry a fraction (~0.25..0.42)
        // of prior direct frame power and decay exponentially at room RT60.
        const acousticCoupling = 0.22 + reduction * 0.20;
        lateReverbPower[k] = Math.max(
          decayFactor * lateReverbPower[k],
          acousticCoupling * delayedPower[k],
        );

        const cleanEst = Math.max(0, p - (0.6 + reduction * 0.8) * lateReverbPower[k]);
        const rawGain = p > 1e-18 ? cleanEst / p : 1.0;
        gains[k] = Math.max(minGain, Math.min(1.0, Math.sqrt(rawGain)));
      }

      // 3-bin spectral smoothing prevents "musical noise" water-droplet artifacts
      for (let k = 0; k < numBins; k++) {
        const left = gains[Math.max(0, k - 1)];
        const mid = gains[k];
        const right = gains[Math.min(numBins - 1, k + 1)];
        smoothedGains[k] = 0.25 * left + 0.5 * mid + 0.25 * right;
      }

      // Apply symmetric real gain across positive and conjugate negative frequency bins
      re[0] *= smoothedGains[0];
      im[0] *= smoothedGains[0];
      re[fftSize / 2] *= smoothedGains[fftSize / 2];
      im[fftSize / 2] *= smoothedGains[fftSize / 2];
      for (let k = 1; k < fftSize / 2; k++) {
        const g = smoothedGains[k];
        re[k] *= g;
        im[k] *= g;
        re[fftSize - k] *= g;
        im[fftSize - k] *= g;
      }

      powerRing[ringIdx] = currentPower;
      ringIdx = (ringIdx + 1) % delayFrames;

      fftRadix2(re, im, true);

      for (let i = 0; i < fftSize; i++) {
        const w = window[i];
        output[pos + i] += re[i] * w;
        norm[pos + i] += w * w;
      }
    }

    for (let i = 0; i < n; i++) {
      samples[i] = norm[i] > 1e-9 ? output[i] / norm[i] : samples[i];
    }
  }

  // --------------------------------------------------------------------------
  // 4. Section 28 TKEO De-Click, Headroom De-Clip & Envelope Differential De-Reverb
  // --------------------------------------------------------------------------

  /**
   * Teager-Kaiser Energy Operator (Psi[n] = x[n]^2 - x[n-1]*x[n+1]) Mouth Click Removal
   * with Cubic Hermite Spline repair (Architecture Doc Section 2.4 / Section 28).
   */
  public static removeMouthClicksInPlace(
    pcm: Float32Array,
    sampleRate: SampleRate,
    sensitivityThreshold = 14.0,
  ): number {
    const len = pcm.length;
    if (len < 64) return 0;

    const maxClickSamples = Math.max(4, Math.floor((sampleRate * 2.5) / 1000));
    const windowSize = Math.max(64, Math.floor((sampleRate * 20) / 1000));

    const tkeo = new Float32Array(len);
    for (let i = 1; i < len - 1; i++) {
      tkeo[i] = Math.abs(pcm[i] * pcm[i] - pcm[i - 1] * pcm[i + 1]);
    }

    let repairedClicksCount = 0;

    for (let winStart = 2; winStart < len - 2; winStart += windowSize) {
      const winEnd = Math.min(len - 2, winStart + windowSize);
      const winLen = winEnd - winStart;
      if (winLen <= 4) break;

      let sumTkeo = 0;
      for (let i = winStart; i < winEnd; i++) {
        sumTkeo += tkeo[i];
      }
      const meanTkeo = sumTkeo / winLen + 1e-9;
      const threshold = meanTkeo * sensitivityThreshold;

      let i = winStart;
      while (i < winEnd) {
        if (tkeo[i] > threshold && tkeo[i] > 1e-5) {
          const clickStart = Math.max(2, i - 2);
          let clickEnd = i + 1;
          while (
            clickEnd < len - 3 &&
            clickEnd - clickStart < maxClickSamples &&
            tkeo[clickEnd] > meanTkeo * 2.5
          ) {
            clickEnd++;
          }
          clickEnd = Math.min(len - 3, clickEnd + 2);

          if (clickEnd - clickStart <= maxClickSamples) {
            this.interpolateHermiteSpanInPlace(pcm, clickStart, clickEnd);
            repairedClicksCount++;
          }
          i = clickEnd + 4;
        } else {
          i++;
        }
      }
    }

    return repairedClicksCount;
  }

  /**
   * Flat-top De-Clipper using slope-matched Cubic Hermite peak reconstruction and headroom scaling.
   */
  public static reconstructClippedPeaksInPlace(
    pcm: Float32Array,
    clipThreshold = 0.992,
    headroomScale = 0.75,
  ): { repairedClippedPeaksCount: number; maxReconstructedPeakLinear: number } {
    const len = pcm.length;
    if (len < 8) {
      return { repairedClippedPeaksCount: 0, maxReconstructedPeakLinear: 0 };
    }

    const thresh = Math.fround(clipThreshold) - 1e-5;
    let repairedCount = 0;
    let maxPeak = 0;

    let i = 2;
    while (i < len - 2) {
      if (Math.abs(pcm[i]) >= thresh) {
        const clipStart = i;
        let clipEnd = i;
        const sign = Math.sign(pcm[i]);

        while (
          clipEnd + 1 < len - 2 &&
          Math.abs(pcm[clipEnd + 1]) >= thresh &&
          Math.sign(pcm[clipEnd + 1]) === sign
        ) {
          clipEnd++;
        }

        const runLength = clipEnd - clipStart + 1;
        if (runLength >= 2 && runLength <= 96) {
          this.interpolateHermiteSpanInPlace(pcm, clipStart, clipEnd + 1);
          repairedCount++;
        }
        i = clipEnd + 2;
      } else {
        i++;
      }
    }

    for (let k = 0; k < len; k++) {
      const scaled = pcm[k] * headroomScale;
      pcm[k] = scaled;
      const abs = Math.abs(scaled);
      if (abs > maxPeak) maxPeak = abs;
    }

    return {
      repairedClippedPeaksCount: repairedCount,
      maxReconstructedPeakLinear: Number(maxPeak.toFixed(4)),
    };
  }

  /**
   * Time-domain Envelope Differential De-Reverb separating fast vocal attacks from slow room tail.
   */
  public static reduceRoomReverbInPlace(
    pcm: Float32Array,
    sampleRate: SampleRate,
    reductionAmount = 0.55,
  ): void {
    const fastAttack = Math.exp(-1.0 / (0.003 * sampleRate));
    const fastRelease = Math.exp(-1.0 / (0.025 * sampleRate));
    const slowDecay = Math.exp(-1.0 / (0.18 * sampleRate));

    let fastEnv = 0;
    let reverbTailEnv = 0;

    for (let i = 0; i < pcm.length; i++) {
      const abs = Math.abs(pcm[i]);

      if (abs > fastEnv) {
        fastEnv = fastAttack * fastEnv + (1.0 - fastAttack) * abs;
      } else {
        fastEnv = fastRelease * fastEnv + (1.0 - fastRelease) * abs;
      }

      if (abs > reverbTailEnv) {
        reverbTailEnv = 0.98 * reverbTailEnv + 0.02 * abs;
      } else {
        reverbTailEnv = slowDecay * reverbTailEnv + (1.0 - slowDecay) * abs;
      }

      const directToReverbRatio = Math.min(1.0, fastEnv / (reverbTailEnv + 1e-8));
      const gain = 1.0 - reductionAmount * (1.0 - directToReverbRatio * directToReverbRatio);
      pcm[i] *= Math.max(0.18, gain);
    }
  }

  private static interpolateHermiteSpanInPlace(
    pcm: Float32Array,
    startIdx: number,
    endIdx: number,
  ): void {
    if (startIdx < 2 || endIdx + 1 >= pcm.length) return;
    const span = endIdx - startIdx + 1;
    if (span <= 0) return;

    const p0 = pcm[startIdx - 1];
    const p1 = pcm[endIdx];
    const m0 = (pcm[startIdx - 1] - pcm[startIdx - 2]) * span;
    const m1 = (pcm[endIdx + 1] - pcm[endIdx]) * span;

    for (let k = startIdx; k < endIdx; k++) {
      const t = (k - startIdx + 1) / span;
      const t2 = t * t;
      const t3 = t2 * t;

      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      pcm[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
  }
}
