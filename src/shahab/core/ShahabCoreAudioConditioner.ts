/**
 * SHAHAB SHARED CORE — Single Authoritative Audio Conditioner
 *
 * Host-independent, zero-Node-fs audio validation, phase-aware downmixing,
 * and anti-aliased Kaiser-windowed sinc resampling to 16 kHz mono Float32 PCM.
 *
 * Eliminates:
 * - Unfiltered linear interpolation aliasing (`resamplePcmLinear`) in SDK/Unified paths
 * - 3x peak PCM memory (`ch0`/`ch1` full-file allocations) during stereo WAV decoding
 * - Phase cancellation on out-of-phase stereo/multi-channel audio (`L = -R`)
 */

import { resampleTo16kMono } from '../../engine/resampler';

export const SHAHAB_TARGET_SAMPLE_RATE_HZ = 16000 as const;

export interface DownmixDiagnostics {
  readonly phaseInversionDetected: boolean;
  readonly deadChannelFallbackUsed: boolean;
  readonly selectedChannelIndex: number | null;
}

/**
 * Full-array finite check ensuring localized NaN/Infinity bursts never enter FBANK/ONNX tensors.
 */
export function assertFinitePcmSamples(samples: Float32Array, contextLabel = 'PCM'): void {
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) {
      throw new Error(`INVALID_AUDIO_INPUT: ${contextLabel} contains non-finite sample (NaN/Infinity) at index ${i}.`);
    }
  }
}

/**
 * Zero-extra-array 2-pass phase-aware & dead-channel-aware downmix directly from
 * a sample reader callback (e.g., WAV DataView or interleaved Float32 buffer).
 *
 * Pass 1 accumulates per-channel energy and correlation against channel 0 (O(1) extra RAM).
 * Pass 2 writes directly into a single output `Float32Array(totalFrames)`.
 * For >2 channels, channels anti-correlated with the dominant channel (`corr < -0.55`)
 * or dead channels (`< -72 dB` when another channel is `> -50 dB`) are excluded from averaging
 * so out-of-phase tracks never cancel speech to silence.
 */
export function downmixStreamToMonoPhaseSafe(params: {
  readonly totalFrames: number;
  readonly channels: number;
  readonly readSample: (frameIdx: number, channelIdx: number) => number;
}): { readonly mono: Float32Array; readonly diagnostics: DownmixDiagnostics } {
  const { totalFrames, channels, readSample } = params;
  if (totalFrames <= 0) {
    return {
      mono: new Float32Array(0),
      diagnostics: { phaseInversionDetected: false, deadChannelFallbackUsed: false, selectedChannelIndex: null },
    };
  }

  const mono = new Float32Array(totalFrames);
  if (channels <= 1) {
    for (let i = 0; i < totalFrames; i++) {
      mono[i] = readSample(i, 0);
    }
    return {
      mono,
      diagnostics: { phaseInversionDetected: false, deadChannelFallbackUsed: false, selectedChannelIndex: 0 },
    };
  }

  // Pass 1: O(channels) statistics — zero full-length per-channel buffer allocation
  const sumSq = new Float64Array(channels);
  const dotWithCh0 = new Float64Array(channels);
  for (let i = 0; i < totalFrames; i++) {
    const s0 = readSample(i, 0);
    sumSq[0] += s0 * s0;
    dotWithCh0[0] += s0 * s0;
    for (let ch = 1; ch < channels; ch++) {
      const sc = readSample(i, ch);
      sumSq[ch] += sc * sc;
      dotWithCh0[ch] += s0 * sc;
    }
  }

  let dominantCh = 0;
  let maxSumSq = sumSq[0];
  for (let ch = 1; ch < channels; ch++) {
    if (sumSq[ch] > maxSumSq) {
      maxSumSq = sumSq[ch];
      dominantCh = ch;
    }
  }

  const rms = new Float64Array(channels);
  const db = new Float64Array(channels);
  for (let ch = 0; ch < channels; ch++) {
    rms[ch] = Math.sqrt(sumSq[ch] / totalFrames);
    db[ch] = rms[ch] > 1e-6 ? 20 * Math.log10(rms[ch]) : -120;
  }

  if (channels === 2) {
    const denom = Math.sqrt(sumSq[0] * sumSq[1]);
    const corr = denom > 1e-12 ? dotWithCh0[1] / denom : 0;
    const phaseInversionDetected = corr < -0.55;
    const deadChannelFallbackUsed =
      (db[0] < -72 && db[1] > -50) || (db[1] < -72 && db[0] > -50);

    if (phaseInversionDetected || deadChannelFallbackUsed) {
      for (let i = 0; i < totalFrames; i++) {
        mono[i] = readSample(i, dominantCh);
      }
      return {
        mono,
        diagnostics: {
          phaseInversionDetected,
          deadChannelFallbackUsed,
          selectedChannelIndex: dominantCh,
        },
      };
    }

    for (let i = 0; i < totalFrames; i++) {
      mono[i] = (readSample(i, 0) + readSample(i, 1)) * 0.5;
    }
    return {
      mono,
      diagnostics: { phaseInversionDetected: false, deadChannelFallbackUsed: false, selectedChannelIndex: null },
    };
  }

  // Multi-channel (>2): compute correlation against dominant channel if dominantCh !== 0
  const dotWithDom = new Float64Array(channels);
  if (dominantCh === 0) {
    dotWithDom.set(dotWithCh0);
  } else {
    for (let i = 0; i < totalFrames; i++) {
      const sd = readSample(i, dominantCh);
      for (let ch = 0; ch < channels; ch++) {
        dotWithDom[ch] += sd * readSample(i, ch);
      }
    }
  }

  const activeChannels: number[] = [];
  let phaseInversionDetected = false;
  let deadChannelFallbackUsed = false;
  const domActive = db[dominantCh] > -50;

  for (let ch = 0; ch < channels; ch++) {
    if (ch === dominantCh) {
      activeChannels.push(ch);
      continue;
    }
    if (domActive && db[ch] < -72) {
      deadChannelFallbackUsed = true;
      continue;
    }
    const denom = Math.sqrt(sumSq[dominantCh] * sumSq[ch]);
    const corr = denom > 1e-12 ? dotWithDom[ch] / denom : 0;
    if (corr < -0.55) {
      phaseInversionDetected = true;
      continue;
    }
    activeChannels.push(ch);
  }

  if (activeChannels.length === 1) {
    const chIdx = activeChannels[0];
    for (let i = 0; i < totalFrames; i++) {
      mono[i] = readSample(i, chIdx);
    }
    return {
      mono,
      diagnostics: { phaseInversionDetected, deadChannelFallbackUsed, selectedChannelIndex: chIdx },
    };
  }

  const invCount = 1 / activeChannels.length;
  for (let i = 0; i < totalFrames; i++) {
    let acc = 0;
    for (let k = 0; k < activeChannels.length; k++) {
      acc += readSample(i, activeChannels[k]);
    }
    mono[i] = acc * invCount;
  }
  return {
    mono,
    diagnostics: { phaseInversionDetected, deadChannelFallbackUsed, selectedChannelIndex: null },
  };
}

/**
 * Single authoritative PCM conditioning entry point for all SHAHAB hosts:
 * 1. Validates finite sample values and sample rate bounds (8 kHz – 192 kHz).
 * 2. Performs phase-safe, dead-channel-safe downmix to mono (zero full-file extra arrays).
 * 3. Applies anti-aliased Kaiser-windowed sinc resampling to 16 kHz.
 */
export function conditionPcmTo16kMono(params: {
  readonly pcm: Float32Array;
  readonly sampleRateHz: number;
  readonly channels?: number;
  readonly layout?: 'interleaved' | 'planar';
}): {
  readonly pcm16k: Float32Array;
  readonly originalSampleRateHz: number;
  readonly originalChannels: number;
  readonly durationSec: number;
  readonly diagnostics: DownmixDiagnostics;
} {
  const sampleRateHz = params.sampleRateHz;
  const channels = Math.max(1, Math.floor(params.channels ?? 1));
  const layout = params.layout ?? 'interleaved';

  if (!Number.isFinite(sampleRateHz) || sampleRateHz < 8000 || sampleRateHz > 192000) {
    throw new Error(`UNSUPPORTED_SAMPLE_RATE: Sample rate ${sampleRateHz} Hz is outside 8000–192000 Hz.`);
  }
  if (params.pcm.length === 0) {
    throw new Error('INVALID_AUDIO_INPUT: Empty PCM buffer.');
  }
  assertFinitePcmSamples(params.pcm, 'Input PCM');

  const totalFrames = Math.floor(params.pcm.length / channels);
  if (totalFrames <= 0) {
    throw new Error('INVALID_AUDIO_INPUT: PCM buffer contains 0 complete frames.');
  }

  let mono: Float32Array;
  let diagnostics: DownmixDiagnostics;

  if (channels === 1) {
    mono = params.pcm;
    diagnostics = { phaseInversionDetected: false, deadChannelFallbackUsed: false, selectedChannelIndex: 0 };
  } else if (layout === 'planar') {
    const res = downmixStreamToMonoPhaseSafe({
      totalFrames,
      channels,
      readSample: (frame, ch) => params.pcm[ch * totalFrames + frame],
    });
    mono = res.mono;
    diagnostics = res.diagnostics;
  } else {
    const res = downmixStreamToMonoPhaseSafe({
      totalFrames,
      channels,
      readSample: (frame, ch) => params.pcm[frame * channels + ch],
    });
    mono = res.mono;
    diagnostics = res.diagnostics;
  }

  let pcm16k: Float32Array = mono;
  if (sampleRateHz !== SHAHAB_TARGET_SAMPLE_RATE_HZ) {
    const resampled = resampleTo16kMono([mono], sampleRateHz, SHAHAB_TARGET_SAMPLE_RATE_HZ).samples;
    pcm16k = resampled.length > 0 ? resampled : new Float32Array([mono[0] ?? 0]);
  }

  return {
    pcm16k,
    originalSampleRateHz: sampleRateHz,
    originalChannels: channels,
    durationSec: totalFrames / sampleRateHz,
    diagnostics,
  };
}
