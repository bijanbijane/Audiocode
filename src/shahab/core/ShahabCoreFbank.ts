/**
 * SHAHAB SHARED CORE — Kaldi-Compatible 80-dim Log-Mel FBANK Extractor (SHB-F02 & SHB-F06)
 *
 * Host-independent, zero-Node-fs acoustic frontend matching `kaldi-native-fbank` / `sherpa-onnx`
 * expectations for Zipformer2-Transducer (`pruned_transducer_stateless7`):
 * - Applies Kaldi 16-bit dynamic range scaling (`pcmScaleFactor = 32768.0` by default) to
 *   normalized `[-1, +1]` Float32 PCM before pre-emphasis, Povey windowing, and FFT power,
 *   resolving SHB-F02's ~20.8 dB (`2 * ln(32768)`) feature distribution shift.
 * - Precomputed FFT-512 bit-reversal & twiddle tables + compact sparse Mel filterbank bounds.
 */

export const SHAHAB_FEATURE_CONFIG_VERSION = 'KALDI_FBANK_80_16K_POVEY_25MS_10MS_SCALE32768_V2';

export interface ShahabKaldiFbankConfig {
  readonly sampleRateHz: 16000;
  readonly frameLengthMs: 25;
  readonly frameShiftMs: 10;
  readonly numMelBins: 80;
  readonly lowFreqHz: number;
  readonly highFreqHz: number;
  readonly preemphasisCoeff: number;
  readonly removeDcOffset: boolean;
  readonly windowType: 'povey';
  readonly tailPadSec: number;
  /**
   * Scales normalized `[-1, +1]` Float32 PCM to `kaldi-native-fbank` / `sherpa-onnx`
   * 16-bit sample amplitude (`32768.0`). Must remain `32768` for upstream Zipformer models.
   */
  readonly pcmScaleFactor?: number;
}

export const DEFAULT_SHAHAB_FBANK_CONFIG: ShahabKaldiFbankConfig = Object.freeze({
  sampleRateHz: 16000,
  frameLengthMs: 25,
  frameShiftMs: 10,
  numMelBins: 80,
  lowFreqHz: 20,
  highFreqHz: 7600,
  preemphasisCoeff: 0.97,
  removeDcOffset: true,
  windowType: 'povey',
  tailPadSec: 0.6,
  pcmScaleFactor: 32768,
});

export interface ShahabExtractedFeatures {
  readonly data: Float32Array; // [numFrames * 80]
  readonly numFrames: number;
  readonly featureDim: 80;
  readonly sampleRateHz: 16000;
  readonly audioDurationSec: number;
  readonly configVersion: string;
}

// Radix-2 in-place iterative Cooley-Tukey FFT (N=512)
function fft512(re: Float32Array, im: Float32Array): void {
  const n = 512;
  let j = 0;
  for (let i = 1; i < n; i++) {
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
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    const half = len >>> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
        const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }
}

function hzToMelKaldi(hz: number): number {
  return 1127.0 * Math.log(1.0 + hz / 700.0);
}

let cachedPoveyWindow: Float32Array | null = null;
let cachedMelBank: {
  readonly bins: Float32Array[];
  readonly lowFreq: number;
  readonly highFreq: number;
} | null = null;

function getPoveyWindow400(): Float32Array {
  if (cachedPoveyWindow) return cachedPoveyWindow;
  const win = new Float32Array(400);
  const a = (2 * Math.PI) / (400 - 1);
  for (let i = 0; i < 400; i++) {
    win[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  }
  cachedPoveyWindow = win;
  return win;
}

function getKaldiMelFilterbank(lowFreq: number, highFreq: number, numMelBins = 80): Float32Array[] {
  if (cachedMelBank && cachedMelBank.lowFreq === lowFreq && cachedMelBank.highFreq === highFreq) {
    return cachedMelBank.bins;
  }
  const nFft = 512;
  const numFftBins = nFft / 2; // 256
  const fftBinWidth = 16000 / nFft; // 31.25 Hz
  const melLow = hzToMelKaldi(lowFreq);
  const melHigh = hzToMelKaldi(highFreq);
  const melDelta = (melHigh - melLow) / (numMelBins + 1);

  const bins: Float32Array[] = [];
  for (let m = 0; m < numMelBins; m++) {
    const leftMel = melLow + m * melDelta;
    const centerMel = melLow + (m + 1) * melDelta;
    const rightMel = melLow + (m + 2) * melDelta;
    const weights = new Float32Array(numFftBins + 1);
    for (let k = 0; k < numFftBins; k++) {
      const freq = fftBinWidth * k;
      const mel = hzToMelKaldi(freq);
      if (mel > leftMel && mel < rightMel) {
        if (mel <= centerMel) {
          weights[k] = (mel - leftMel) / (centerMel - leftMel);
        } else {
          weights[k] = (rightMel - mel) / (rightMel - centerMel);
        }
      }
    }
    bins.push(weights);
  }
  cachedMelBank = { bins, lowFreq, highFreq };
  return bins;
}

// Precomputed FFT-512 bit-reversal permutation and twiddle factors for OPT-001
const FFT512_BIT_REV = (() => {
  const n = 512;
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < 9; b++) {
      r = (r << 1) | (x & 1);
      x >>>= 1;
    }
    rev[i] = r;
  }
  return rev;
})();

const FFT512_TWIDDLE_RE = (() => {
  const tw = new Float64Array(256);
  for (let k = 0; k < 256; k++) {
    tw[k] = Math.cos((-2 * Math.PI * k) / 512);
  }
  return tw;
})();

const FFT512_TWIDDLE_IM = (() => {
  const tw = new Float64Array(256);
  for (let k = 0; k < 256; k++) {
    tw[k] = Math.sin((-2 * Math.PI * k) / 512);
  }
  return tw;
})();

function fft512Optimized(re: Float32Array, im: Float32Array): void {
  const n = 512;
  for (let i = 0; i < n; i++) {
    const j = FFT512_BIT_REV[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >>> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const twIdx = k * step;
        const wRe = FFT512_TWIDDLE_RE[twIdx];
        const wIm = FFT512_TWIDDLE_IM[twIdx];
        const idxA = i + k;
        const idxB = idxA + half;
        const uRe = re[idxA];
        const uIm = im[idxA];
        const vRe = re[idxB] * wRe - im[idxB] * wIm;
        const vIm = re[idxB] * wIm + im[idxB] * wRe;
        re[idxA] = uRe + vRe;
        im[idxA] = uIm + vIm;
        re[idxB] = uRe - vRe;
        im[idxB] = uIm - vIm;
      }
    }
  }
}

interface CompactMelFilter {
  readonly startBin: number;
  readonly endBin: number;
  readonly weights: Float32Array;
}

let cachedCompactMelBank: {
  readonly filters: CompactMelFilter[];
  readonly lowFreq: number;
  readonly highFreq: number;
} | null = null;

function getCompactKaldiMelFilterbank(lowFreq: number, highFreq: number, numMelBins = 80): CompactMelFilter[] {
  if (
    cachedCompactMelBank &&
    cachedCompactMelBank.lowFreq === lowFreq &&
    cachedCompactMelBank.highFreq === highFreq
  ) {
    return cachedCompactMelBank.filters;
  }
  const full = getKaldiMelFilterbank(lowFreq, highFreq, numMelBins);
  const filters: CompactMelFilter[] = [];
  for (let m = 0; m < full.length; m++) {
    const w = full[m];
    let startBin = -1;
    let endBin = -1;
    for (let k = 0; k < 256; k++) {
      if (w[k] > 0) {
        if (startBin === -1) startBin = k;
        endBin = k;
      }
    }
    if (startBin === -1) {
      filters.push({ startBin: 0, endBin: -1, weights: new Float32Array(0) });
    } else {
      filters.push({
        startBin,
        endBin,
        weights: w.slice(startBin, endBin + 1),
      });
    }
  }
  cachedCompactMelBank = { filters, lowFreq, highFreq };
  return filters;
}

/**
 * Extracts Kaldi-compatible 80-dim Log-Mel FBANK features from 16kHz Mono Float32 PCM.
 * Note (SHB-F02): Does NOT allocate a full-length padded Float32Array copy; reads directly
 * from `pcm16k` with zero tail beyond `pcm16k.length`, scaling by `pcmScaleFactor` (32768.0).
 */
export function extractKaldiFbank80(
  pcm16k: Float32Array,
  config: ShahabKaldiFbankConfig = DEFAULT_SHAHAB_FBANK_CONFIG,
  optimizationMode: 'BASELINE' | 'OPTIMIZED' = 'OPTIMIZED',
): ShahabExtractedFeatures {
  const tailSamples = Math.max(0, Math.round(config.tailPadSec * config.sampleRateHz));
  const paddedLen = pcm16k.length + tailSamples;
  const pcmLen = pcm16k.length;
  const scale =
    typeof config.pcmScaleFactor === 'number' &&
    Number.isFinite(config.pcmScaleFactor) &&
    config.pcmScaleFactor > 0
      ? config.pcmScaleFactor
      : 32768;

  const frameLen = 400; // 25ms @ 16kHz
  const frameShift = 160; // 10ms @ 16kHz
  const numFrames = paddedLen < frameLen ? 1 : 1 + Math.floor((paddedLen - frameLen) / frameShift);
  const out = new Float32Array(numFrames * 80);

  const win = getPoveyWindow400();
  const re = new Float32Array(512);
  const im = new Float32Array(512);
  const power = new Float32Array(257);
  const eps = 1.1920929e-7; // FLT_EPSILON

  if (optimizationMode === 'OPTIMIZED') {
    const compactFilters = getCompactKaldiMelFilterbank(config.lowFreqHz, config.highFreqHz, 80);
    const preemph = config.preemphasisCoeff;
    const removeDc = config.removeDcOffset;

    for (let f = 0; f < numFrames; f++) {
      const start = f * frameShift;
      const avail = start < pcmLen ? Math.min(frameLen, pcmLen - start) : 0;
      let mean = 0;
      if (removeDc && avail > 0) {
        let sum = 0;
        for (let i = 0; i < avail; i++) {
          sum += pcm16k[start + i] * scale;
        }
        mean = sum / frameLen;
      }

      re.fill(0, frameLen);
      im.fill(0);
      let prev = (avail > 0 ? pcm16k[start] * scale : 0) - mean;
      re[0] = (prev - preemph * prev) * win[0];
      for (let i = 1; i < avail; i++) {
        const cur = pcm16k[start + i] * scale - mean;
        re[i] = (cur - preemph * prev) * win[i];
        prev = cur;
      }
      for (let i = avail; i < frameLen; i++) {
        const cur = -mean;
        re[i] = (cur - preemph * prev) * win[i];
        prev = cur;
      }

      fft512Optimized(re, im);

      for (let k = 0; k <= 256; k++) {
        const rk = re[k];
        const ik = im[k];
        power[k] = rk * rk + ik * ik;
      }

      const rowOffset = f * 80;
      for (let m = 0; m < 80; m++) {
        const cf = compactFilters[m];
        let melEnergy = 0;
        const w = cf.weights;
        const startBin = cf.startBin;
        for (let j = 0; j < w.length; j++) {
          melEnergy += w[j] * power[startBin + j];
        }
        out[rowOffset + m] = Math.log(melEnergy > eps ? melEnergy : eps);
      }
    }
  } else {
    const melBins = getKaldiMelFilterbank(config.lowFreqHz, config.highFreqHz, 80);
    for (let f = 0; f < numFrames; f++) {
      const start = f * frameShift;
      let sum = 0;
      for (let i = 0; i < frameLen; i++) {
        const idx = start + i;
        sum += idx < pcmLen ? pcm16k[idx] * scale : 0;
      }
      const mean = config.removeDcOffset ? sum / frameLen : 0;

      re.fill(0);
      im.fill(0);
      let prev = (start < pcmLen ? pcm16k[start] * scale : 0) - mean;
      re[0] = (prev - config.preemphasisCoeff * prev) * win[0];
      for (let i = 1; i < frameLen; i++) {
        const idx = start + i;
        const cur = (idx < pcmLen ? pcm16k[idx] * scale : 0) - mean;
        re[i] = (cur - config.preemphasisCoeff * prev) * win[i];
        prev = cur;
      }

      fft512(re, im);

      for (let k = 0; k <= 256; k++) {
        power[k] = re[k] * re[k] + im[k] * im[k];
      }

      const rowOffset = f * 80;
      for (let m = 0; m < 80; m++) {
        const w = melBins[m];
        let melEnergy = 0;
        for (let k = 0; k < 256; k++) {
          if (w[k] > 0) melEnergy += w[k] * power[k];
        }
        out[rowOffset + m] = Math.log(Math.max(melEnergy, eps));
      }
    }
  }

  return {
    data: out,
    numFrames,
    featureDim: 80,
    sampleRateHz: 16000,
    audioDurationSec: pcm16k.length / 16000,
    configVersion: SHAHAB_FEATURE_CONFIG_VERSION,
  };
}
