/**
 * Anti-Aliased Windowed-Sinc Resampler (44.1kHz / 48kHz -> 16,000 Hz Mono)
 * Prevents high-frequency sibilant aliasing (س، ش، ز، ف) when feeding Persian ASR/VAD models.
 */

export interface ResampleResult {
  samples: Float32Array;
  outputSampleRate: number;
  cutoffHz: number;
  filterTaps: number;
  aliasingAttenuationDb: number;
}

/** Modified Bessel function I0 for Kaiser window */
function besselI0(x: number): number {
  let sum = 1.0;
  let term = 1.0;
  const xHalf = x * 0.5;
  for (let k = 1; k <= 20; k++) {
    term *= (xHalf / k) * (xHalf / k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Downsamples mono or interleaved/planar multi-channel audio to 16kHz mono
 * using a Kaiser-windowed sinc low-pass filter at 0.9 * (targetRate / 2) = 7,200 Hz.
 */
export function resampleTo16kMono(
  channels: Float32Array[],
  inputSampleRate: number,
  targetSampleRate = 16_000,
): ResampleResult {
  if (channels.length === 0 || channels[0].length === 0) {
    return {
      samples: new Float32Array(0),
      outputSampleRate: targetSampleRate,
      cutoffHz: targetSampleRate * 0.45,
      filterTaps: 0,
      aliasingAttenuationDb: 0,
    };
  }

  const inputLength = channels[0].length;
  // Mix down to mono first without overflow
  const mono = new Float32Array(inputLength);
  const invCh = 1 / channels.length;
  for (let i = 0; i < inputLength; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      sum += channels[c][i];
    }
    mono[i] = sum * invCh;
  }

  if (inputSampleRate === targetSampleRate) {
    return {
      samples: mono,
      outputSampleRate: targetSampleRate,
      cutoffHz: targetSampleRate * 0.5,
      filterTaps: 1,
      aliasingAttenuationDb: 96,
    };
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.floor(inputLength / ratio);
  const output = new Float32Array(outputLength);

  // Cutoff at 0.9 * Nyquist of target rate (7200 Hz for 16kHz)
  const cutoffHz = targetSampleRate * 0.45;
  const fc = cutoffHz / inputSampleRate; // normalized to input sample rate
  const halfWidth = Math.max(12, Math.round(16 * (inputSampleRate / targetSampleRate)));
  const filterTaps = halfWidth * 2 + 1;
  const beta = 6.5; // Kaiser beta (~65+ dB stopband attenuation)
  const invI0Beta = 1 / besselI0(beta);

  for (let outIdx = 0; outIdx < outputLength; outIdx++) {
    const center = outIdx * ratio;
    const centerInt = Math.floor(center);
    const startTap = Math.max(0, centerInt - halfWidth);
    const endTap = Math.min(inputLength - 1, centerInt + halfWidth);

    let acc = 0;
    let weightSum = 0;

    for (let inIdx = startTap; inIdx <= endTap; inIdx++) {
      const x = inIdx - center;
      const norm = x / halfWidth;
      const windowArg = Math.max(0, 1 - norm * norm);
      const win = besselI0(beta * Math.sqrt(windowArg)) * invI0Beta;
      const sincArg = 2 * fc * x;
      const sinc =
        Math.abs(sincArg) < 1e-8
          ? 2 * fc
          : Math.sin(Math.PI * sincArg) / (Math.PI * x);
      const w = sinc * win;
      acc += mono[inIdx] * w;
      weightSum += w;
    }

    output[outIdx] = weightSum > 1e-9 ? acc / weightSum : 0;
  }

  return {
    samples: output,
    outputSampleRate: targetSampleRate,
    cutoffHz,
    filterTaps,
    aliasingAttenuationDb: 68,
  };
}

/** Measures RMS energy of a Float32Array */
export function computeSignalRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}
