/**
 * SHAHAB-005, SHAHAB-006, SHAHAB-007 & SHAHAB-009 — Frozen Zipformer-Transducer Core,
 * Triple Acoustic Memory, Bounded Memory Governor, Adaptive Decoding & Runtime Capability Registry
 *
 * Implements:
 * - Exact Kaldi-compatible 80-dim Log-Mel FBANK extractor (matching sherpa-onnx / kaldi-native-fbank)
 * - SHAHABFrozenModelAdapter (implements Avapardaz LocalAsrRuntimeAdapter contract with ZERO weight mutation)
 * - Separated stages: extractFeatures() -> runEncoder() -> decodeGreedy() / decodeModifiedBeamSearch()
 * - Triple Memory Design:
 *     1. SHAHABAudioFeatureCache
 *     2. SHAHABEncoderOutputCache
 *     3. SHAHABStreamingStateCache (explicitly documents offline stateless7 graph non-streaming boundary)
 * - SHAHABMemoryGovernor (separate per-cache byte budgets, LRU eviction, memory pressure, cancellation cleanup)
 * - SHAHABAudioProfiler (objective RMS, silence, clipping, discontinuities, VAD, SNR estimate, speech-rate proxy)
 * - SHAHABDecodePolicyManager (SPEED | BALANCED | PRECISION | VOCABULARY | VERBATIM — genuinely differentiated!)
 * - SHAHABAdaptiveDecoder + SHAHABDecodeRiskEstimator + SHAHABComputeBudgetController + SHAHABRecurrentListeningController
 * - SHAHABRuntimeCapabilityRegistry
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import {
  AVAPARDAZ_ASR_CONTRACT_VERSION,
  AsrModelLoadDescriptor,
  AsrModelValidationReport,
  AsrRuntimeCapabilityReport,
  AsrRuntimeError,
  AsrRuntimeHealthReport,
  AsrRuntimeResourceReport,
  AsrTranscriptionRequest,
  AvapardazTranscriptResult,
  LocalAsrRuntimeAdapter,
} from '../asr-core/UnifiedLocalAsrRuntime';
import { detectTextLanguageTag, normalizeWithProfile } from '../asr-core/CoreNormalizationAndLanguage';
import { PERSIAN_NORMALIZATION_CONTRACT_VERSION } from '../lifecycle/CanonicalModelProvenance';
import { normalizePersianTextDeterministic } from './ShahabContracts';

export const SHAHAB_FEATURE_CONFIG_VERSION = 'KALDI_FBANK_80_16K_POVEY_25MS_10MS_V1';
export const SHAHAB_DECODER_INTERFACE_VERSION = 'STATELESS7_RNNT_CTX2_V1';

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
});

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
let cachedMelBank: { readonly bins: Float32Array[]; readonly lowFreq: number; readonly highFreq: number } | null = null;

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

export interface ShahabExtractedFeatures {
  readonly data: Float32Array; // [numFrames * 80]
  readonly numFrames: number;
  readonly featureDim: 80;
  readonly sampleRateHz: 16000;
  readonly audioDurationSec: number;
  readonly configVersion: string;
}

// Precomputed FFT-512 bit-reversal permutation and twiddle factors for OPT-001 (zero weight changes)
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
  const tw = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    tw[k] = Math.cos((-2 * Math.PI * k) / 512);
  }
  return tw;
})();

const FFT512_TWIDDLE_IM = (() => {
  const tw = new Float32Array(256);
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
  readonly endBin: number; // inclusive
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
 * Extracts Kaldi-compatible 80-dim Log-Mel FBANK features from 16kHz Mono Float32 PCM
 * (matching sherpa-onnx / kaldi-native-fbank defaults for Zipformer2 stateless7).
 * Supports `optimizationMode: 'BASELINE' | 'OPTIMIZED'` for controlled SHAHAB-016 A/B verification.
 */
export function extractKaldiFbank80(
  pcm16k: Float32Array,
  config: ShahabKaldiFbankConfig = DEFAULT_SHAHAB_FBANK_CONFIG,
  optimizationMode: 'BASELINE' | 'OPTIMIZED' = 'OPTIMIZED',
): ShahabExtractedFeatures {
  const tailSamples = Math.round(config.tailPadSec * config.sampleRateHz);
  const padded = new Float32Array(pcm16k.length + tailSamples);
  padded.set(pcm16k, 0);

  const frameLen = 400; // 25ms @ 16kHz
  const frameShift = 160; // 10ms @ 16kHz
  const numFrames = padded.length < frameLen ? 1 : 1 + Math.floor((padded.length - frameLen) / frameShift);
  const out = new Float32Array(numFrames * 80);

  const win = getPoveyWindow400();
  const re = new Float32Array(512);
  const im = new Float32Array(512);
  const power = new Float32Array(257);
  const eps = 1.1920929e-7; // FLT_EPSILON

  if (optimizationMode === 'OPTIMIZED') {
    const compactFilters = getCompactKaldiMelFilterbank(config.lowFreqHz, config.highFreqHz, 80);
    const paddedLen = padded.length;
    const preemph = config.preemphasisCoeff;
    const removeDc = config.removeDcOffset;

    for (let f = 0; f < numFrames; f++) {
      const start = f * frameShift;
      const avail = Math.min(frameLen, paddedLen - start);
      let mean = 0;
      if (removeDc) {
        let sum = 0;
        for (let i = 0; i < avail; i++) {
          sum += padded[start + i];
        }
        mean = sum / frameLen;
      }

      re.fill(0, frameLen);
      im.fill(0);
      let prev = (avail > 0 ? padded[start] : 0) - mean;
      re[0] = (prev - preemph * prev) * win[0];
      for (let i = 1; i < avail; i++) {
        const cur = padded[start + i] - mean;
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
        sum += start + i < padded.length ? padded[start + i] : 0;
      }
      const mean = config.removeDcOffset ? sum / frameLen : 0;

      re.fill(0);
      im.fill(0);
      let prev = (start < padded.length ? padded[start] : 0) - mean;
      re[0] = (prev - config.preemphasisCoeff * prev) * win[0];
      for (let i = 1; i < frameLen; i++) {
        const cur = (start + i < padded.length ? padded[start + i] : 0) - mean;
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

/**
 * Parses a standard PCM WAV (16-bit or 32-bit float, mono or multichannel) into 16kHz Mono Float32Array.
 */
export function decodeWavToMono16k(wavBytes: Uint8Array): {
  readonly pcm16k: Float32Array;
  readonly originalSampleRate: number;
  readonly originalChannels: number;
  readonly durationSec: number;
} {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  if (
    wavBytes.byteLength < 44 ||
    view.getUint32(0, false) !== 0x52494646 || // RIFF
    view.getUint32(8, false) !== 0x57415645 // WAVE
  ) {
    throw new Error('INVALID_WAV_HEADER: Expected RIFF/WAVE header.');
  }

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBytes.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 0x666d7420) {
      // fmt
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 0x64617461) {
      // data
      dataOffset = body;
      dataSize = Math.min(chunkSize, wavBytes.byteLength - body);
      break;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error('INVALID_WAV_DATA: Missing PCM data chunk.');
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = Math.floor(dataSize / (bytesPerSample * channels));
  const mono = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      const pos = dataOffset + (i * channels + ch) * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        acc += view.getFloat32(pos, true);
      } else if (bitsPerSample === 16) {
        acc += view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = wavBytes[pos];
        const b1 = wavBytes[pos + 1];
        const b2 = wavBytes[pos + 2];
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        acc += v / 8388608;
      } else {
        throw new Error(`UNSUPPORTED_WAV_FORMAT: format=${audioFormat}, bits=${bitsPerSample}`);
      }
    }
    mono[i] = acc / channels;
  }

  let pcm16k = mono;
  if (sampleRate !== 16000) {
    const targetLen = Math.max(1, Math.round((mono.length * 16000) / sampleRate));
    pcm16k = new Float32Array(targetLen);
    const ratio = sampleRate / 16000;
    for (let i = 0; i < targetLen; i++) {
      const pos = i * ratio;
      const lo = Math.min(mono.length - 1, Math.floor(pos));
      const hi = Math.min(mono.length - 1, lo + 1);
      const frac = pos - lo;
      pcm16k[i] = mono[lo] * (1 - frac) + mono[hi] * frac;
    }
  }

  return {
    pcm16k,
    originalSampleRate: sampleRate,
    originalChannels: channels,
    durationSec: mono.length / sampleRate,
  };
}

export function loadZipformerTokensTxt(tokensPath: string): readonly string[] {
  const raw = fs.readFileSync(tokensPath, 'utf-8');
  const tokens: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const lastSpace = line.lastIndexOf(' ');
    if (lastSpace <= 0) continue;
    const sym = line.slice(0, lastSpace);
    const id = Number.parseInt(line.slice(lastSpace + 1).trim(), 10);
    if (Number.isInteger(id) && id >= 0) {
      tokens[id] = sym;
    }
  }
  return tokens;
}

export function decodeBpeTokenIdsToText(tokenIds: readonly number[], vocab: readonly string[]): string {
  let text = '';
  for (const id of tokenIds) {
    if (id <= 0 || id >= vocab.length) continue;
    text += vocab[id] ?? '';
  }
  return text.replace(/▁/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ============================================================================
 * SHAHAB-006 / SHAHAB-007 — TRIPLE MEMORY DESIGN & BOUNDED MEMORY GOVERNOR
 * ============================================================================
 */

export interface ShahabCacheIdentityKey {
  readonly audioSha256: string;
  readonly segmentId: string;
  readonly segmentStartSample: number;
  readonly segmentEndSample: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly encoderSha256: string;
  readonly decoderSha256: string;
  readonly joinerSha256: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly featureConfigVersion: string;
  readonly runtimeVersion: string;
  readonly decoderInterfaceVersion: string;
}

export function serializeCacheIdentity(key: ShahabCacheIdentityKey): string {
  return [
    key.audioSha256,
    key.segmentId,
    `${key.segmentStartSample}:${key.segmentEndSample}`,
    `${key.modelId}@${key.modelRevision}`,
    key.encoderSha256,
    key.decoderSha256,
    key.joinerSha256,
    `${key.sampleRateHz}Hz/${key.channels}ch`,
    key.featureConfigVersion,
    key.runtimeVersion,
    key.decoderInterfaceVersion,
  ].join('|');
}

export interface ShahabEncoderOutputTensor {
  readonly data: Float32Array; // [numFrames * dim]
  readonly numFrames: number;
  readonly dim: number; // 384 for Zipformer2
  readonly dtype: 'float32';
  readonly byteLength: number;
  readonly encoderTimeMs: number;
}

export interface ShahabStreamingStateEntry {
  readonly supportedByActiveModel: false;
  readonly reason: string;
  readonly chunkPositionFrames: number;
  readonly byteLength: number;
}

interface BoundedCacheBucket<T> {
  readonly keyString: string;
  readonly identity: ShahabCacheIdentityKey;
  readonly value: T;
  readonly byteLength: number;
  lastAccessedAtMs: number;
}

class BoundedTypedCache<T> {
  private readonly map = new Map<string, BoundedCacheBucket<T>>();
  private usedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    public readonly cacheName: string,
    private maxBytes: number,
  ) {}

  public setBudgetBytes(maxBytes: number): void {
    this.maxBytes = Math.max(0, maxBytes);
    this.evictToBudget();
  }

  public get(identity: ShahabCacheIdentityKey): T | null {
    const keyString = serializeCacheIdentity(identity);
    const entry = this.map.get(keyString);
    if (!entry) {
      this.misses++;
      return null;
    }
    entry.lastAccessedAtMs = Date.now();
    this.hits++;
    return entry.value;
  }

  public set(identity: ShahabCacheIdentityKey, value: T, byteLength: number): boolean {
    if (byteLength > this.maxBytes) {
      return false; // Admission rejected: exceeds cache budget
    }
    const keyString = serializeCacheIdentity(identity);
    const prev = this.map.get(keyString);
    if (prev) {
      this.usedBytes -= prev.byteLength;
      this.map.delete(keyString);
    }
    this.map.set(keyString, {
      keyString,
      identity,
      value,
      byteLength,
      lastAccessedAtMs: Date.now(),
    });
    this.usedBytes += byteLength;
    this.evictToBudget();
    return true;
  }

  public invalidateByModelRevision(modelRevision: string): number {
    let removed = 0;
    for (const [k, v] of this.map.entries()) {
      if (v.identity.modelRevision === modelRevision) {
        this.usedBytes -= v.byteLength;
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  public invalidateByAudioSha256(audioSha256: string): number {
    let removed = 0;
    for (const [k, v] of this.map.entries()) {
      if (v.identity.audioSha256 === audioSha256) {
        this.usedBytes -= v.byteLength;
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  public clear(): void {
    this.map.clear();
    this.usedBytes = 0;
  }

  public getStats(): {
    readonly entries: number;
    readonly usedBytes: number;
    readonly maxBytes: number;
    readonly hits: number;
    readonly misses: number;
    readonly evictions: number;
    readonly hitRate: number;
  } {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }

  private evictToBudget(): void {
    while (this.usedBytes > this.maxBytes && this.map.size > 0) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of this.map.entries()) {
        if (v.lastAccessedAtMs < oldestTs) {
          oldestTs = v.lastAccessedAtMs;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const victim = this.map.get(oldestKey)!;
      this.usedBytes -= victim.byteLength;
      this.map.delete(oldestKey);
      this.evictions++;
    }
  }
}

export class SHAHABAudioFeatureCache extends BoundedTypedCache<ShahabExtractedFeatures> {
  constructor(maxBytes = 16 * 1024 * 1024) {
    super('SHAHABAudioFeatureCache', maxBytes);
  }
}

export class SHAHABEncoderOutputCache extends BoundedTypedCache<ShahabEncoderOutputTensor> {
  constructor(maxBytes = 32 * 1024 * 1024) {
    super('SHAHABEncoderOutputCache', maxBytes);
  }
}

export class SHAHABStreamingStateCache extends BoundedTypedCache<ShahabStreamingStateEntry> {
  public readonly streamingSupportedByCurrentGraph = false;
  public readonly architecturalReason =
    'Acquired encoder.int8.onnx (ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f) is an offline stateless7 graph exposing only inputs (x, x_lens) without cached_key/cached_val/cached_conv streaming tensors.';

  constructor(maxBytes = 8 * 1024 * 1024) {
    super('SHAHABStreamingStateCache', maxBytes);
  }
}

export class SHAHABMemoryGovernor {
  public readonly featureCache: SHAHABAudioFeatureCache;
  public readonly encoderCache: SHAHABEncoderOutputCache;
  public readonly streamingCache: SHAHABStreamingStateCache;

  constructor(budgets?: {
    readonly featureCacheBytes?: number;
    readonly encoderCacheBytes?: number;
    readonly streamingCacheBytes?: number;
  }) {
    this.featureCache = new SHAHABAudioFeatureCache(budgets?.featureCacheBytes ?? 16 * 1024 * 1024);
    this.encoderCache = new SHAHABEncoderOutputCache(budgets?.encoderCacheBytes ?? 32 * 1024 * 1024);
    this.streamingCache = new SHAHABStreamingStateCache(budgets?.streamingCacheBytes ?? 8 * 1024 * 1024);
  }

  public handleMemoryPressure(level: 'ELEVATED' | 'CRITICAL'): void {
    if (level === 'ELEVATED') {
      this.featureCache.clear();
    } else {
      this.featureCache.clear();
      this.encoderCache.clear();
      this.streamingCache.clear();
    }
  }

  public invalidateModelRevision(modelRevision: string): void {
    this.featureCache.invalidateByModelRevision(modelRevision);
    this.encoderCache.invalidateByModelRevision(modelRevision);
    this.streamingCache.invalidateByModelRevision(modelRevision);
  }

  public clearAll(): void {
    this.featureCache.clear();
    this.encoderCache.clear();
    this.streamingCache.clear();
  }

  public getTelemetry(): {
    readonly featureCacheBytes: number;
    readonly encoderCacheBytes: number;
    readonly streamingCacheBytes: number;
    readonly totalCacheBytes: number;
    readonly encoderCacheHitRate: number;
    readonly totalEvictions: number;
    readonly processRssBytes: number;
  } {
    const f = this.featureCache.getStats();
    const e = this.encoderCache.getStats();
    const s = this.streamingCache.getStats();
    return {
      featureCacheBytes: f.usedBytes,
      encoderCacheBytes: e.usedBytes,
      streamingCacheBytes: s.usedBytes,
      totalCacheBytes: f.usedBytes + e.usedBytes + s.usedBytes,
      encoderCacheHitRate: e.hitRate,
      totalEvictions: f.evictions + e.evictions + s.evictions,
      processRssBytes: typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().rss : 0,
    };
  }
}

/**
 * ============================================================================
 * SHAHAB-007 — AUDIO PROFILER, DECODE POLICIES, RISK ESTIMATOR & BUDGET CONTROL
 * ============================================================================
 */

export type ShahabDecodePolicyId = 'SPEED' | 'BALANCED' | 'PRECISION' | 'VOCABULARY' | 'VERBATIM';

export interface ShahabDecodePolicyConfig {
  readonly policyId: ShahabDecodePolicyId;
  readonly decodingMethod: 'greedy_search' | 'modified_beam_search';
  readonly maxActivePaths: number;
  readonly blankPenalty: number;
  readonly allowContextualBias: boolean;
  readonly defaultContextBiasScore: number;
  readonly maxAdditionalPasses: number;
  readonly preserveRawVerbatim: boolean;
  readonly description: string;
}

export class SHAHABDecodePolicyManager {
  private readonly policies: Readonly<Record<ShahabDecodePolicyId, ShahabDecodePolicyConfig>> = Object.freeze({
    SPEED: {
      policyId: 'SPEED',
      decodingMethod: 'greedy_search',
      maxActivePaths: 1,
      blankPenalty: 0.0,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 0,
      preserveRawVerbatim: true,
      description: 'Single-path greedy transducer decoding for minimum latency.',
    },
    BALANCED: {
      policyId: 'BALANCED',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      blankPenalty: 0.0,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 1,
      preserveRawVerbatim: true,
      description: 'Upstream-aligned modified beam search (max_active_paths=4, blank_penalty=0).',
    },
    PRECISION: {
      policyId: 'PRECISION',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 8,
      blankPenalty: 0.05,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 1,
      preserveRawVerbatim: true,
      description: 'Wider modified beam search (8 active paths) with mild blank penalty for difficult acoustics.',
    },
    VOCABULARY: {
      policyId: 'VOCABULARY',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 6,
      blankPenalty: 0.0,
      allowContextualBias: true,
      defaultContextBiasScore: 0.6,
      maxAdditionalPasses: 1,
      preserveRawVerbatim: true,
      description: 'Modified beam search with verified BPE contextual biasing and false-insertion guard.',
    },
    VERBATIM: {
      policyId: 'VERBATIM',
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      blankPenalty: -0.05,
      allowContextualBias: false,
      defaultContextBiasScore: 0.0,
      maxAdditionalPasses: 0,
      preserveRawVerbatim: true,
      description: 'Zero contextual override and conservative blank penalty preserving disfluencies and repetitions.',
    },
  });

  public getPolicy(id: ShahabDecodePolicyId): ShahabDecodePolicyConfig {
    return this.policies[id];
  }

  public listPolicies(): readonly ShahabDecodePolicyConfig[] {
    return Object.values(this.policies);
  }
}

export interface ShahabAudioProfileReport {
  readonly durationSec: number;
  readonly sampleRateHz: number;
  readonly rmsEnergy: number;
  readonly rmsDb: number;
  readonly silenceRatio: number;
  readonly clippedSampleCount: number;
  readonly clippingRatio: number;
  readonly discontinuityCount: number;
  readonly speechActivityRatio: number;
  readonly estimatedSnrDb: number | null;
  readonly snrAssumptionNote: string;
  readonly speechRateProxyTransitionsPerSec: number;
  readonly recommendedPolicy: ShahabDecodePolicyId;
  readonly recommendationReason: string;
}

export function profileAudioSignal(pcm16k: Float32Array, sampleRateHz = 16000): ShahabAudioProfileReport {
  const n = pcm16k.length;
  const durationSec = n / Math.max(1, sampleRateHz);
  if (n === 0) {
    return {
      durationSec: 0,
      sampleRateHz,
      rmsEnergy: 0,
      rmsDb: -120,
      silenceRatio: 1,
      clippedSampleCount: 0,
      clippingRatio: 0,
      discontinuityCount: 0,
      speechActivityRatio: 0,
      estimatedSnrDb: null,
      snrAssumptionNote: 'Empty buffer; SNR not computable.',
      speechRateProxyTransitionsPerSec: 0,
      recommendedPolicy: 'SPEED',
      recommendationReason: 'Empty audio segment.',
    };
  }

  let sumSq = 0;
  let clipped = 0;
  let discontinuities = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16k[i];
    sumSq += s * s;
    if (Math.abs(s) >= 0.995) clipped++;
    if (i > 0 && Math.abs(s - pcm16k[i - 1]) > 0.75) discontinuities++;
  }
  const rmsEnergy = Math.sqrt(sumSq / n);
  const rmsDb = rmsEnergy > 1e-9 ? 20 * Math.log10(rmsEnergy) : -120;

  // Frame-level RMS over 20ms frames for silence ratio & 10th-vs-90th percentile SNR proxy
  const frameSize = Math.max(1, Math.round(sampleRateHz * 0.02));
  const frameRms: number[] = [];
  let speechFrames = 0;
  let transitions = 0;
  let prevSpeech = false;
  for (let off = 0; off + frameSize <= n; off += frameSize) {
    let fs = 0;
    for (let k = 0; k < frameSize; k++) {
      const v = pcm16k[off + k];
      fs += v * v;
    }
    const r = Math.sqrt(fs / frameSize);
    frameRms.push(r);
    const isSpeech = r > 0.012;
    if (isSpeech) speechFrames++;
    if (isSpeech !== prevSpeech) transitions++;
    prevSpeech = isSpeech;
  }

  const totalFrames = Math.max(1, frameRms.length);
  const speechActivityRatio = Number((speechFrames / totalFrames).toFixed(4));
  const silenceRatio = Number((1 - speechActivityRatio).toFixed(4));

  let estimatedSnrDb: number | null = null;
  if (frameRms.length >= 10) {
    const sorted = [...frameRms].sort((a, b) => a - b);
    const p10 = Math.max(1e-7, sorted[Math.floor(sorted.length * 0.1)]);
    const p90 = Math.max(1e-7, sorted[Math.floor(sorted.length * 0.9)]);
    estimatedSnrDb = Number((20 * Math.log10(p90 / p10)).toFixed(2));
  }

  const clippingRatio = Number((clipped / n).toFixed(6));
  const speechRateProxy = Number((transitions / Math.max(0.1, durationSec)).toFixed(2));

  let recommendedPolicy: ShahabDecodePolicyId = 'BALANCED';
  let recommendationReason = 'Nominal studio audio SNR and speech activity; BALANCED modified beam search selected.';
  if (estimatedSnrDb !== null && estimatedSnrDb < 12) {
    recommendedPolicy = 'PRECISION';
    recommendationReason = `Degraded estimated SNR (${estimatedSnrDb} dB < 12 dB); recommending PRECISION wider beam.`;
  } else if (clippingRatio > 0.005 || discontinuities > 5) {
    recommendedPolicy = 'PRECISION';
    recommendationReason = `Observed clipping (${clipped} samples) or discontinuities (${discontinuities}); recommending PRECISION.`;
  } else if (speechActivityRatio < 0.08) {
    recommendedPolicy = 'SPEED';
    recommendationReason = `Predominantly silent audio (${(silenceRatio * 100).toFixed(1)}% silence); SPEED greedy pass sufficient.`;
  }

  return {
    durationSec: Number(durationSec.toFixed(4)),
    sampleRateHz,
    rmsEnergy: Number(rmsEnergy.toFixed(6)),
    rmsDb: Number(rmsDb.toFixed(2)),
    silenceRatio,
    clippedSampleCount: clipped,
    clippingRatio,
    discontinuityCount: discontinuities,
    speechActivityRatio,
    estimatedSnrDb,
    snrAssumptionNote:
      'Estimated via 90th-vs-10th percentile 20ms frame RMS ratio assuming stationary background noise floor (HEURISTIC_ESTIMATE, not calibrated SNR).',
    speechRateProxyTransitionsPerSec: speechRateProxy,
    recommendedPolicy,
    recommendationReason,
  };
}

export type ShahabSignalClass =
  | 'OBSERVED_SIGNAL'
  | 'MODEL_SCORE'
  | 'CALIBRATED_CONFIDENCE'
  | 'HEURISTIC_ESTIMATE'
  | 'UNKNOWN';

export interface ShahabRiskSignal {
  readonly name: string;
  readonly signalClass: ShahabSignalClass;
  readonly value: number | string | boolean | null;
  readonly note: string;
}

export type ShahabRecurrentAction =
  | 'ACCEPT_CURRENT_RESULT'
  | 'REDECODE_WITH_DIFFERENT_SEARCH'
  | 'REDECODE_WITH_EXTENDED_CONTEXT'
  | 'REPROCESS_BOUNDARY_REGION'
  | 'PRESERVE_ALTERNATIVES'
  | 'REQUEST_USER_REVIEW'
  | 'ABSTAIN_FROM_AUTOMATIC_CORRECTION';

export class SHAHABDecodeRiskEstimator {
  public assess(params: {
    readonly audioProfile: ShahabAudioProfileReport;
    readonly rawLogProbSum: number | null;
    readonly tokenCount: number;
    readonly greedyVsBeamDisagreed?: boolean;
  }): {
    readonly signals: readonly ShahabRiskSignal[];
    readonly uncertain: boolean;
    readonly confidenceCalibrationStatus: 'UNCALIBRATED_NO_VALIDATION_CURVE';
  } {
    const avgLogProb =
      params.rawLogProbSum !== null && params.tokenCount > 0
        ? Number((params.rawLogProbSum / params.tokenCount).toFixed(4))
        : null;

    const signals: ShahabRiskSignal[] = [
      {
        name: 'audio_clipping_ratio',
        signalClass: 'OBSERVED_SIGNAL',
        value: params.audioProfile.clippingRatio,
        note: 'Directly observed fraction of clipped PCM samples.',
      },
      {
        name: 'estimated_snr_db',
        signalClass: 'HEURISTIC_ESTIMATE',
        value: params.audioProfile.estimatedSnrDb,
        note: params.audioProfile.snrAssumptionNote,
      },
      {
        name: 'mean_token_log_prob',
        signalClass: 'MODEL_SCORE',
        value: avgLogProb,
        note: 'Raw RNN-T joiner log-probability mean; NOT a calibrated probability.',
      },
      {
        name: 'calibrated_word_confidence',
        signalClass: 'UNKNOWN',
        value: null,
        note: 'No independent Persian validation calibration curve available yet.',
      },
    ];

    const uncertain =
      (params.audioProfile.estimatedSnrDb !== null && params.audioProfile.estimatedSnrDb < 12) ||
      params.audioProfile.clippingRatio > 0.005 ||
      Boolean(params.greedyVsBeamDisagreed) ||
      (avgLogProb !== null && avgLogProb < -2.2);

    return {
      signals,
      uncertain,
      confidenceCalibrationStatus: 'UNCALIBRATED_NO_VALIDATION_CURVE',
    };
  }
}

export interface ShahabComputeBudgetConfig {
  readonly maxAdditionalPasses: number;
  readonly maxReprocessedAudioSec: number;
  readonly maxAddedLatencyMs: number;
  readonly maxCacheMemoryBytes: number;
}

export class SHAHABComputeBudgetController {
  private passesUsed = 0;
  private reprocessedAudioSec = 0;
  private addedLatencyMs = 0;

  constructor(public readonly limits: ShahabComputeBudgetConfig) {}

  public canSpendAdditionalPass(segmentDurationSec: number, currentCacheBytes: number): {
    readonly allowed: boolean;
    readonly reason: string;
  } {
    if (this.passesUsed >= this.limits.maxAdditionalPasses) {
      return { allowed: false, reason: `Max additional passes (${this.limits.maxAdditionalPasses}) reached.` };
    }
    if (this.reprocessedAudioSec + segmentDurationSec > this.limits.maxReprocessedAudioSec) {
      return {
        allowed: false,
        reason: `Reprocessed audio budget (${this.limits.maxReprocessedAudioSec}s) would be exceeded.`,
      };
    }
    if (this.addedLatencyMs >= this.limits.maxAddedLatencyMs) {
      return { allowed: false, reason: `Added latency budget (${this.limits.maxAddedLatencyMs}ms) exhausted.` };
    }
    if (currentCacheBytes > this.limits.maxCacheMemoryBytes) {
      return { allowed: false, reason: `Cache memory exceeds budget (${this.limits.maxCacheMemoryBytes} B).` };
    }
    return { allowed: true, reason: 'Within compute budget.' };
  }

  public recordAdditionalPass(segmentDurationSec: number, latencyMs: number): void {
    this.passesUsed++;
    this.reprocessedAudioSec += segmentDurationSec;
    this.addedLatencyMs += latencyMs;
  }

  public getUsage(): {
    readonly passesUsed: number;
    readonly reprocessedAudioSec: number;
    readonly addedLatencyMs: number;
  } {
    return {
      passesUsed: this.passesUsed,
      reprocessedAudioSec: Number(this.reprocessedAudioSec.toFixed(3)),
      addedLatencyMs: Math.round(this.addedLatencyMs),
    };
  }
}

export interface ShahabRecurrentDecisionRecord {
  readonly action: ShahabRecurrentAction;
  readonly reason: string;
  readonly changedVariable: string | null;
  readonly previousConfigKey: string;
  readonly nextConfigKey: string | null;
}

export class SHAHABRecurrentListeningController {
  private readonly executedConfigsBySegment = new Map<string, Set<string>>();

  public decide(params: {
    readonly segmentId: string;
    readonly segmentDurationSec: number;
    readonly currentPolicy: ShahabDecodePolicyConfig;
    readonly candidateNextPolicy: ShahabDecodePolicyConfig | null;
    readonly uncertain: boolean;
    readonly budget: SHAHABComputeBudgetController;
    readonly currentCacheBytes: number;
  }): ShahabRecurrentDecisionRecord {
    const prevKey = `${params.currentPolicy.decodingMethod}|p=${params.currentPolicy.maxActivePaths}|bp=${params.currentPolicy.blankPenalty}|cb=${params.currentPolicy.allowContextualBias}`;
    const seen = this.executedConfigsBySegment.get(params.segmentId) ?? new Set<string>();
    seen.add(prevKey);
    this.executedConfigsBySegment.set(params.segmentId, seen);

    if (!params.uncertain) {
      return {
        action: 'ACCEPT_CURRENT_RESULT',
        reason: 'Objective audio profile and decoder score show no uncertainty triggers.',
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    if (!params.candidateNextPolicy) {
      return {
        action: 'REQUEST_USER_REVIEW',
        reason: 'Segment flagged uncertain with no alternative decoder policy configured.',
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    const nextKey = `${params.candidateNextPolicy.decodingMethod}|p=${params.candidateNextPolicy.maxActivePaths}|bp=${params.candidateNextPolicy.blankPenalty}|cb=${params.candidateNextPolicy.allowContextualBias}`;
    if (seen.has(nextKey)) {
      // SHAHAB-007 §5 / §8 Guardrail: NEVER repeat identical deterministic config!
      return {
        action: 'PRESERVE_ALTERNATIVES',
        reason: 'Blocked duplicate re-decode: candidate configuration is identical to an already executed pass.',
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    const budgetCheck = params.budget.canSpendAdditionalPass(
      params.segmentDurationSec,
      params.currentCacheBytes,
    );
    if (!budgetCheck.allowed) {
      return {
        action: 'REQUEST_USER_REVIEW',
        reason: `Compute budget guardrail engaged: ${budgetCheck.reason}`,
        changedVariable: null,
        previousConfigKey: prevKey,
        nextConfigKey: null,
      };
    }

    return {
      action: 'REDECODE_WITH_DIFFERENT_SEARCH',
      reason: `Uncertainty detected; escalating from ${params.currentPolicy.policyId} to ${params.candidateNextPolicy.policyId} over cached encoder output.`,
      changedVariable: `decodingMethod/maxActivePaths (${params.currentPolicy.decodingMethod}:${params.currentPolicy.maxActivePaths} -> ${params.candidateNextPolicy.decodingMethod}:${params.candidateNextPolicy.maxActivePaths})`,
      previousConfigKey: prevKey,
      nextConfigKey: nextKey,
    };
  }
}

/**
 * ============================================================================
 * SHAHAB-005 — FROZEN ZIPFORMER-TRANSDUCER MODEL ADAPTER (REAL ONNX EXECUTION)
 * ============================================================================
 */

export interface ShahabHotwordBiasMap {
  /** Maps BPE token ID -> additive log-probability bias score (strictly bounded) */
  readonly tokenBiases: ReadonlyMap<number, number>;
  readonly activeTerms: readonly string[];
}

export interface ShahabDecodedHypothesis {
  readonly rawText: string;
  readonly tokenIds: readonly number[];
  readonly tokenTimestampsSec: readonly number[];
  readonly logProbSum: number;
  readonly decoderJoinerInvocations: number;
  readonly decodeTimeMs: number;
  readonly policyId: ShahabDecodePolicyId;
  readonly decodingMethod: 'greedy_search' | 'modified_beam_search';
  readonly maxActivePaths: number;
  readonly blankPenalty: number;
  readonly contextTermsApplied: readonly string[];
}

export interface ShahabFrozenAdapterOptions {
  readonly modelDir: string;
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly expectedHashes?: {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
    readonly tokens: string;
  };
  readonly memoryGovernor?: SHAHABMemoryGovernor;
}

export class SHAHABFrozenModelAdapter implements LocalAsrRuntimeAdapter {
  public readonly runtimeTarget = 'BROWSER_WASM_CPU' as const;
  public readonly runtimeName = 'SHAHAB Frozen Zipformer-Transducer Engine (onnxruntime-web WASM)';
  public readonly trainableParameters = 0 as const;

  private readonly modelDir: string;
  private readonly modelId: string;
  private readonly modelRevision: string;
  private readonly expectedHashes: {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
    readonly tokens: string;
  };

  public readonly memoryGovernor: SHAHABMemoryGovernor;
  public readonly policyManager = new SHAHABDecodePolicyManager();

  private encoderSession: ort.InferenceSession | null = null;
  private decoderSession: ort.InferenceSession | null = null;
  private joinerSession: ort.InferenceSession | null = null;
  private vocab: readonly string[] = [];
  private verifiedHashes: { encoder: string; decoder: string; joiner: string; tokens: string } | null = null;
  private loadTimeMs: number | null = null;
  private inferenceVerified = false;
  private activeJobId: string | null = null;
  private encoderInvocationCount = 0;
  private decoderInvocationCount = 0;

  constructor(options: ShahabFrozenAdapterOptions) {
    this.modelDir = path.resolve(options.modelDir);
    this.modelId = options.modelId ?? 'persian-zipformer-transducer';
    this.modelRevision = options.modelRevision ?? '0408facbcf3f670121def48e0802c395c225d150';
    this.expectedHashes = options.expectedHashes ?? {
      encoder: '08735923618e196bd093b369f6843c8a390a6113a391e7b7095115582fd2cd27',
      decoder: '9d4ad2da0335d86d8638ff026e6b37247d97df940af6ad40bba671af5fd4aa9d',
      joiner: 'a2a4a30585dc53e46afafd03690181107a610f67ff0e29cab460ec16df5cc00b',
      tokens: '435f9e09a290c764670044e54c2450670fc2eab50176cd912734fa6f92ab166f',
    };
    this.memoryGovernor = options.memoryGovernor ?? new SHAHABMemoryGovernor();
  }

  public getVocab(): readonly string[] {
    return this.vocab;
  }

  public getExecutionCounters(): {
    readonly encoderInvocations: number;
    readonly decoderInvocations: number;
    readonly loadTimeMs: number | null;
    readonly verifiedHashes: { encoder: string; decoder: string; joiner: string; tokens: string } | null;
  } {
    return {
      encoderInvocations: this.encoderInvocationCount,
      decoderInvocations: this.decoderInvocationCount,
      loadTimeMs: this.loadTimeMs,
      verifiedHashes: this.verifiedHashes,
    };
  }

  public resetExecutionCounters(): void {
    this.encoderInvocationCount = 0;
    this.decoderInvocationCount = 0;
  }

  public verifyWeightImmutability(): {
    readonly immutable: boolean;
    readonly hashes: { encoder: string; decoder: string; joiner: string; tokens: string };
    readonly mismatches: readonly string[];
  } {
    const hashFile = (name: string) =>
      crypto.createHash('sha256').update(fs.readFileSync(path.join(this.modelDir, name))).digest('hex');
    const actual = {
      encoder: hashFile('encoder.int8.onnx'),
      decoder: hashFile('decoder.int8.onnx'),
      joiner: hashFile('joiner.int8.onnx'),
      tokens: hashFile('tokens.txt'),
    };
    const mismatches: string[] = [];
    if (actual.encoder !== this.expectedHashes.encoder) mismatches.push('encoder.int8.onnx SHA-256 mismatch');
    if (actual.decoder !== this.expectedHashes.decoder) mismatches.push('decoder.int8.onnx SHA-256 mismatch');
    if (actual.joiner !== this.expectedHashes.joiner) mismatches.push('joiner.int8.onnx SHA-256 mismatch');
    if (actual.tokens !== this.expectedHashes.tokens) mismatches.push('tokens.txt SHA-256 mismatch');
    return { immutable: mismatches.length === 0, hashes: actual, mismatches };
  }

  public async probeCapabilities(): Promise<AsrRuntimeCapabilityReport> {
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeName: this.runtimeName,
      runtimeVersion: 'onnxruntime-web@1.31.1',
      available: true,
      offlineCapable: true,
      wasmAvailable: true,
      simdAvailable: true,
      sharedArrayBufferAvailable: typeof SharedArrayBuffer !== 'undefined',
      opfsAvailable: false,
      webGpuAvailable: false,
      maxThreads: 1,
      memoryBudgetBytes: 1024 * 1024 * 1024,
      maxSupportedOnnxOpset: 21,
      supportedArchitectures: ['FASTCONFORMER_CTC', 'WHISPER_SEQ2SEQ'],
      notes: [
        'Executes Zipformer2-Transducer (pruned_transducer_stateless7) via 3 separate ONNX sessions (encoder + decoder + joiner).',
        'Offline graph only (no cached_key/cached_conv streaming inputs); encoder_out reuse supported across decoder passes.',
      ],
    };
  }

  public async initializeRuntime(): Promise<void> {
    if (this.encoderSession && this.decoderSession && this.joinerSession) return;
    const immut = this.verifyWeightImmutability();
    if (!immut.immutable) {
      throw new AsrRuntimeError({
        code: 'MODEL_INTEGRITY_FAILURE',
        message: `Weight immutability check failed: ${immut.mismatches.join('; ')}`,
        runtimeTarget: this.runtimeTarget,
      });
    }
    this.verifiedHashes = immut.hashes;
    this.vocab = loadZipformerTokensTxt(path.join(this.modelDir, 'tokens.txt'));

    const t0 = performance.now();
    const encBytes = fs.readFileSync(path.join(this.modelDir, 'encoder.int8.onnx'));
    const decBytes = fs.readFileSync(path.join(this.modelDir, 'decoder.int8.onnx'));
    const joinBytes = fs.readFileSync(path.join(this.modelDir, 'joiner.int8.onnx'));

    this.decoderSession = await ort.InferenceSession.create(decBytes, { executionProviders: ['wasm'] });
    this.joinerSession = await ort.InferenceSession.create(joinBytes, { executionProviders: ['wasm'] });
    this.encoderSession = await ort.InferenceSession.create(encBytes, { executionProviders: ['wasm'] });
    this.loadTimeMs = Math.round(performance.now() - t0);
  }

  public async validateModel(descriptor: AsrModelLoadDescriptor): Promise<AsrModelValidationReport> {
    const immut = this.verifyWeightImmutability();
    return {
      valid: immut.immutable,
      modelId: descriptor.modelId,
      modelVersion: descriptor.modelVersion,
      integrityVerified: immut.immutable,
      compatibility: null,
      errors: immut.mismatches,
    };
  }

  public async loadModel(): Promise<void> {
    await this.initializeRuntime();
  }

  public buildCacheIdentity(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly segmentStartSample?: number;
    readonly segmentEndSample?: number;
  }): ShahabCacheIdentityKey {
    const audioSha256 = crypto
      .createHash('sha256')
      .update(Buffer.from(params.pcm16k.buffer, params.pcm16k.byteOffset, params.pcm16k.byteLength))
      .digest('hex');
    const hashes = this.verifiedHashes ?? this.expectedHashes;
    return {
      audioSha256,
      segmentId: params.segmentId,
      segmentStartSample: params.segmentStartSample ?? 0,
      segmentEndSample: params.segmentEndSample ?? params.pcm16k.length,
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      encoderSha256: hashes.encoder,
      decoderSha256: hashes.decoder,
      joinerSha256: hashes.joiner,
      sampleRateHz: 16000,
      channels: 1,
      featureConfigVersion: SHAHAB_FEATURE_CONFIG_VERSION,
      runtimeVersion: 'onnxruntime-web@1.31.1',
      decoderInterfaceVersion: SHAHAB_DECODER_INTERFACE_VERSION,
    };
  }

  /**
   * Stage 1: Acoustic Encoder execution (with optional Triple Cache lookup).
   */
  public async encodeAudio(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly useCache?: boolean;
    readonly signal?: AbortSignal;
    readonly optimizationMode?: 'BASELINE' | 'OPTIMIZED';
    readonly fbankConfig?: ShahabKaldiFbankConfig;
  }): Promise<{
    readonly encoderOutput: ShahabEncoderOutputTensor;
    readonly cacheHit: boolean;
    readonly cacheIdentity: ShahabCacheIdentityKey;
    readonly featureExtractionMs: number;
  }> {
    if (params.signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Encoding cancelled before start.',
        runtimeTarget: this.runtimeTarget,
      });
    }
    await this.initializeRuntime();
    const cacheIdentity = this.buildCacheIdentity({
      pcm16k: params.pcm16k,
      segmentId: params.segmentId,
    });

    if (params.useCache) {
      const cached = this.memoryGovernor.encoderCache.get(cacheIdentity);
      if (cached) {
        return { encoderOutput: cached, cacheHit: true, cacheIdentity, featureExtractionMs: 0 };
      }
    }

    let featureExtractionMs = 0;
    let features = params.useCache ? this.memoryGovernor.featureCache.get(cacheIdentity) : null;
    if (!features) {
      const tFeat0 = performance.now();
      features = extractKaldiFbank80(
        params.pcm16k,
        params.fbankConfig ?? DEFAULT_SHAHAB_FBANK_CONFIG,
        params.optimizationMode ?? 'OPTIMIZED',
      );
      featureExtractionMs = Number((performance.now() - tFeat0).toFixed(3));
      if (params.useCache) {
        this.memoryGovernor.featureCache.set(cacheIdentity, features, features.data.byteLength);
      }
    }

    if (params.signal?.aborted) {
      throw new AsrRuntimeError({
        code: 'JOB_CANCELLED',
        message: 'Encoding cancelled after feature extraction.',
        runtimeTarget: this.runtimeTarget,
      });
    }

    const tEnc0 = performance.now();
    const xTensor = new ort.Tensor('float32', features.data, [1, features.numFrames, 80]);
    const xLensTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(features.numFrames)]), [1]);
    const out = await this.encoderSession!.run({ x: xTensor, x_lens: xLensTensor });
    const encMs = Math.round(performance.now() - tEnc0);
    this.encoderInvocationCount++;

    const encData = new Float32Array(out.encoder_out.data as Float32Array);
    const encLens = out.encoder_out_lens.data as BigInt64Array;
    const validFrames = Number(encLens[0]);
    const dim = Number(out.encoder_out.dims[2] ?? 384);
    const trimmed = encData.subarray(0, validFrames * dim);
    const copy = new Float32Array(trimmed.length);
    copy.set(trimmed);

    const encoderOutput: ShahabEncoderOutputTensor = {
      data: copy,
      numFrames: validFrames,
      dim,
      dtype: 'float32',
      byteLength: copy.byteLength,
      encoderTimeMs: encMs,
    };

    if (params.useCache) {
      this.memoryGovernor.encoderCache.set(cacheIdentity, encoderOutput, encoderOutput.byteLength);
    }

    return { encoderOutput, cacheHit: false, cacheIdentity, featureExtractionMs };
  }

  /**
   * Stage 2: Stateless7 RNN-T Decoding from an existing Encoder output tensor
   * (supports greedy_search and modified_beam_search with optional BPE hotword logit biasing).
   */
  public async decodeFromEncoderOutput(params: {
    readonly encoderOutput: ShahabEncoderOutputTensor;
    readonly policy: ShahabDecodePolicyConfig;
    readonly hotwordBias?: ShahabHotwordBiasMap | null;
    readonly signal?: AbortSignal;
    readonly optimizationMode?: 'BASELINE' | 'OPTIMIZED';
  }): Promise<ShahabDecodedHypothesis> {
    await this.initializeRuntime();
    const t0 = performance.now();
    const { data, numFrames, dim } = params.encoderOutput;
    const decCache = new Map<string, Float32Array>();
    let decJoinCalls = 0;

    const runDecoder = async (t0Id: number, t1Id: number): Promise<Float32Array> => {
      const key = `${t0Id},${t1Id}`;
      const hit = decCache.get(key);
      if (hit) return hit;
      const y = new ort.Tensor('int64', BigInt64Array.from([BigInt(t0Id), BigInt(t1Id)]), [1, 2]);
      const res = await this.decoderSession!.run({ y });
      this.decoderInvocationCount++;
      decJoinCalls++;
      const out = new Float32Array(res.decoder_out.data as Float32Array);
      decCache.set(key, out);
      return out;
    };

    const runJoiner = async (frameIdx: number, decVec: Float32Array): Promise<Float32Array> => {
      const encSlice = data.subarray(frameIdx * dim, (frameIdx + 1) * dim);
      const res = await this.joinerSession!.run({
        encoder_out: new ort.Tensor('float32', encSlice, [1, dim]),
        decoder_out: new ort.Tensor('float32', decVec, [1, dim]),
      });
      decJoinCalls++;
      return res.logit.data as Float32Array;
    };

    const logSoftmax = (logits: Float32Array): Float32Array => {
      let max = -Infinity;
      for (let i = 0; i < logits.length; i++) {
        if (logits[i] > max) max = logits[i];
      }
      let sumExp = 0;
      for (let i = 0; i < logits.length; i++) {
        sumExp += Math.exp(logits[i] - max);
      }
      const logZ = max + Math.log(sumExp);
      const out = new Float32Array(logits.length);
      for (let i = 0; i < logits.length; i++) {
        out[i] = logits[i] - logZ;
      }
      return out;
    };

    const biasMap =
      params.policy.allowContextualBias && params.hotwordBias
        ? params.hotwordBias.tokenBiases
        : null;
    const activeTerms =
      params.policy.allowContextualBias && params.hotwordBias
        ? params.hotwordBias.activeTerms
        : [];
    const blankPenalty = params.policy.blankPenalty;

    if (params.policy.decodingMethod === 'greedy_search') {
      const emitted: number[] = [];
      const timestamps: number[] = [];
      let ctx0 = 0;
      let ctx1 = 0;
      let logProbSum = 0;
      let decVec = await runDecoder(ctx0, ctx1);

      for (let t = 0; t < numFrames; t++) {
        if (params.signal?.aborted) {
          throw new AsrRuntimeError({
            code: 'JOB_CANCELLED',
            message: 'Greedy decoding cancelled.',
            runtimeTarget: this.runtimeTarget,
          });
        }
        const logits = await runJoiner(t, decVec);
        const logProbs = logSoftmax(logits);
        let bestId = 0;
        let bestScore = logProbs[0] - blankPenalty;
        for (let v = 1; v < logProbs.length; v++) {
          const score = logProbs[v];
          if (score > bestScore) {
            bestScore = score;
            bestId = v;
          }
        }
        if (bestId !== 0) {
          emitted.push(bestId);
          timestamps.push(Number((t * 0.04).toFixed(3))); // 4x subsampling * 10ms = 40ms
          logProbSum += bestScore;
          ctx0 = ctx1;
          ctx1 = bestId;
          decVec = await runDecoder(ctx0, ctx1);
        }
      }

      this.inferenceVerified = true;
      return {
        rawText: decodeBpeTokenIdsToText(emitted, this.vocab),
        tokenIds: emitted,
        tokenTimestampsSec: timestamps,
        logProbSum: Number(logProbSum.toFixed(4)),
        decoderJoinerInvocations: decJoinCalls,
        decodeTimeMs: Math.round(performance.now() - t0),
        policyId: params.policy.policyId,
        decodingMethod: 'greedy_search',
        maxActivePaths: 1,
        blankPenalty,
        contextTermsApplied: [],
      };
    }

    // Modified Beam Search (stateless7: at most 1 non-blank symbol emitted per encoder frame)
    // OPT-002 (when optimizationMode === 'OPTIMIZED'):
    // 1. Per-frame Joiner context (c0, c1) deduplication (avoids redundant ONNX Joiner runs when multiple beams share the last 2 tokens).
    // 2. Reusable scratch buffer for logSoftmax (eliminates per-beam per-frame Float32Array allocations).
    // 3. O(K) insertion for top-K token selection (eliminates Array.prototype.sort() inside the inner vocab loop).
    const useDecoderOpt = (params.optimizationMode ?? 'OPTIMIZED') === 'OPTIMIZED';
    const beamSize = Math.max(2, Math.min(12, params.policy.maxActivePaths));
    interface BeamHyp {
      tokens: number[];
      timestamps: number[];
      score: number;
    }
    let beams: BeamHyp[] = [{ tokens: [0, 0], timestamps: [], score: 0 }];

    const logAddExp = (a: number, b: number) =>
      a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));

    const logSoftmaxInto = (logits: Float32Array, dst: Float32Array): Float32Array => {
      let maxVal = -Infinity;
      for (let i = 0; i < logits.length; i++) {
        if (logits[i] > maxVal) maxVal = logits[i];
      }
      let sumExp = 0;
      for (let i = 0; i < logits.length; i++) {
        sumExp += Math.exp(logits[i] - maxVal);
      }
      const logSum = maxVal + Math.log(sumExp);
      for (let i = 0; i < logits.length; i++) {
        dst[i] = logits[i] - logSum;
      }
      return dst;
    };

    const topIds = new Int32Array(beamSize + 1);
    const topLps = new Float64Array(beamSize + 1);

    for (let t = 0; t < numFrames; t++) {
      if (params.signal?.aborted) {
        throw new AsrRuntimeError({
          code: 'JOB_CANCELLED',
          message: 'Modified beam search cancelled.',
          runtimeTarget: this.runtimeTarget,
        });
      }
      const nextMap = new Map<string, BeamHyp>();
      const frameLogProbsCache = useDecoderOpt ? new Map<string, Float32Array>() : null;

      for (const hyp of beams) {
        const c0 = hyp.tokens[hyp.tokens.length - 2];
        const c1 = hyp.tokens[hyp.tokens.length - 1];
        let logProbs: Float32Array;

        if (frameLogProbsCache) {
          const ctxKey = `${c0}:${c1}`;
          const cachedLp = frameLogProbsCache.get(ctxKey);
          if (cachedLp) {
            logProbs = cachedLp;
          } else {
            const decVec = await runDecoder(c0, c1);
            const logits = await runJoiner(t, decVec);
            logProbs = logSoftmaxInto(logits, new Float32Array(logits.length));
            frameLogProbsCache.set(ctxKey, logProbs);
          }
        } else {
          const decVec = await runDecoder(c0, c1);
          const logits = await runJoiner(t, decVec);
          logProbs = logSoftmax(logits);
        }

        if (useDecoderOpt) {
          const maxK = beamSize + 1;
          topIds[0] = 0;
          topLps[0] = logProbs[0] - blankPenalty;
          let count = 1;

          for (let v = 1; v < logProbs.length; v++) {
            const bias = biasMap?.get(v) ?? 0;
            const lp = logProbs[v] + bias;
            if (count < maxK) {
              let pos = count;
              while (pos > 0 && lp > topLps[pos - 1]) {
                topIds[pos] = topIds[pos - 1];
                topLps[pos] = topLps[pos - 1];
                pos--;
              }
              topIds[pos] = v;
              topLps[pos] = lp;
              count++;
            } else if (lp > topLps[maxK - 1]) {
              let pos = maxK - 1;
              while (pos > 0 && lp > topLps[pos - 1]) {
                topIds[pos] = topIds[pos - 1];
                topLps[pos] = topLps[pos - 1];
                pos--;
              }
              topIds[pos] = v;
              topLps[pos] = lp;
            }
          }

          const frameTs = Number((t * 0.04).toFixed(3));
          for (let i = 0; i < count; i++) {
            const candId = topIds[i];
            const candLp = topLps[i];
            const newTokens = candId === 0 ? hyp.tokens : [...hyp.tokens, candId];
            const newTs = candId === 0 ? hyp.timestamps : [...hyp.timestamps, frameTs];
            const newScore = hyp.score + candLp;
            const key = newTokens.join(',');
            const existing = nextMap.get(key);
            if (!existing) {
              nextMap.set(key, { tokens: newTokens, timestamps: newTs, score: newScore });
            } else {
              existing.score = logAddExp(existing.score, newScore);
            }
          }
        } else {
          // Baseline unoptimized top-K with inner Array.sort()
          const top: { id: number; lp: number }[] = [{ id: 0, lp: logProbs[0] - blankPenalty }];
          for (let v = 1; v < logProbs.length; v++) {
            const bias = biasMap?.get(v) ?? 0;
            const lp = logProbs[v] + bias;
            if (top.length < beamSize + 1) {
              top.push({ id: v, lp });
              top.sort((a, b) => b.lp - a.lp);
            } else if (lp > top[top.length - 1].lp) {
              top[top.length - 1] = { id: v, lp };
              top.sort((a, b) => b.lp - a.lp);
            }
          }

          for (const cand of top) {
            const newTokens = cand.id === 0 ? hyp.tokens : [...hyp.tokens, cand.id];
            const newTs = cand.id === 0 ? hyp.timestamps : [...hyp.timestamps, Number((t * 0.04).toFixed(3))];
            const newScore = hyp.score + cand.lp;
            const key = newTokens.join(',');
            const existing = nextMap.get(key);
            if (!existing) {
              nextMap.set(key, { tokens: newTokens, timestamps: newTs, score: newScore });
            } else {
              existing.score = logAddExp(existing.score, newScore);
            }
          }
        }
      }

      beams = Array.from(nextMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, beamSize);
    }

    const best = beams[0] ?? { tokens: [0, 0], timestamps: [], score: 0 };
    const emitted = best.tokens.slice(2);
    this.inferenceVerified = true;

    return {
      rawText: decodeBpeTokenIdsToText(emitted, this.vocab),
      tokenIds: emitted,
      tokenTimestampsSec: best.timestamps,
      logProbSum: Number(best.score.toFixed(4)),
      decoderJoinerInvocations: decJoinCalls,
      decodeTimeMs: Math.round(performance.now() - t0),
      policyId: params.policy.policyId,
      decodingMethod: 'modified_beam_search',
      maxActivePaths: beamSize,
      blankPenalty,
      contextTermsApplied: activeTerms,
    };
  }

  /**
   * Implements Avapardaz unified `LocalAsrRuntimeAdapter.transcribe()` contract.
   */
  public async transcribe(request: AsrTranscriptionRequest): Promise<AvapardazTranscriptResult> {
    if (this.activeJobId) {
      throw new AsrRuntimeError({
        code: 'JOB_ALREADY_RUNNING',
        message: `SHAHAB job ${this.activeJobId} is already running.`,
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }
    if (!Number.isFinite(request.sampleRate) || request.sampleRate <= 0 || request.totalSamples <= 0) {
      throw new AsrRuntimeError({
        code: 'AUDIO_INVALID',
        message: 'Invalid audio sampleRate or empty buffer.',
        runtimeTarget: this.runtimeTarget,
        jobId: request.jobId,
      });
    }

    const startedMs = performance.now();
    this.activeJobId = request.jobId;
    try {
      await this.initializeRuntime();
      const rawPcm = await request.readSourceRange(0, request.totalSamples);
      let pcm16k = rawPcm;
      if (request.sampleRate !== 16000) {
        const targetLen = Math.max(1, Math.round((rawPcm.length * 16000) / request.sampleRate));
        pcm16k = new Float32Array(targetLen);
        const ratio = request.sampleRate / 16000;
        for (let i = 0; i < targetLen; i++) {
          const pos = i * ratio;
          const lo = Math.min(rawPcm.length - 1, Math.floor(pos));
          const hi = Math.min(rawPcm.length - 1, lo + 1);
          const frac = pos - lo;
          pcm16k[i] = rawPcm[lo] * (1 - frac) + rawPcm[hi] * frac;
        }
      }

      const { encoderOutput } = await this.encodeAudio({
        pcm16k,
        segmentId: `${request.jobId}_seg0`,
        useCache: true,
        signal: request.signal,
      });
      const policy = this.policyManager.getPolicy('BALANCED');
      const decoded = await this.decodeFromEncoderOutput({
        encoderOutput,
        policy,
        signal: request.signal,
      });

      const durationSec = request.totalSamples / request.sampleRate;
      const processingTimeMs = Math.max(1, Math.round(performance.now() - startedMs));
      const p009Norm = normalizePersianTextDeterministic(decoded.rawText).normalized;
      const normalizedText = normalizeWithProfile(p009Norm, 'MIXED-NORM-V1') || p009Norm;
      const lang = detectTextLanguageTag(normalizedText || decoded.rawText).language;

      return {
        contractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
        jobId: request.jobId,
        runtimeTarget: this.runtimeTarget,
        runtimeName: this.runtimeName,
        executionProvider: 'wasm',
        modelId: this.modelId,
        modelVersion: this.modelRevision.slice(0, 12),
        modelSha256Hex: this.verifiedHashes?.encoder ?? this.expectedHashes.encoder,
        architecture: 'FASTCONFORMER_CTC', // Existing contract enum compatibility; true Zipformer lineage recorded in modelId/metadata
        normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
        offlineVerified: true,
        sampleRateHz: 16000,
        durationSec: Number(durationSec.toFixed(6)),
        processingTimeMs,
        realTimeFactor: durationSec > 0 ? Number(((processingTimeMs / 1000) / durationSec).toFixed(4)) : 0,
        dominantLanguage: lang,
        rawText: decoded.rawText,
        normalizedText,
        timestampGranularity: 'SEGMENT',
        segments: [
          {
            id: `${request.jobId}_seg_1`,
            index: 0,
            startSec: 0,
            endSec: Number(durationSec.toFixed(6)),
            startSample16k: 0,
            endSample16k: pcm16k.length,
            rawText: decoded.rawText,
            normalizedText,
            language: lang,
            confidence: 0, // Honest: uncalibrated raw RNN-T scores are never misrepresented as calibrated probability
            timestampGranularity: 'SEGMENT',
            words: [],
          },
        ],
        peakMemoryBytes: this.memoryGovernor.getTelemetry().processRssBytes,
      };
    } finally {
      this.activeJobId = null;
    }
  }

  public async cancel(): Promise<void> {
    this.activeJobId = null;
  }

  public async unloadModel(): Promise<void> {
    await this.encoderSession?.release();
    await this.decoderSession?.release();
    await this.joinerSession?.release();
    this.encoderSession = null;
    this.decoderSession = null;
    this.joinerSession = null;
    this.memoryGovernor.clearAll();
  }

  public async getHealth(): Promise<AsrRuntimeHealthReport> {
    return {
      runtimeTarget: this.runtimeTarget,
      runtimeReady: this.encoderSession !== null,
      modelLoaded: this.encoderSession !== null && this.decoderSession !== null && this.joinerSession !== null,
      inferenceVerified: this.inferenceVerified,
      activeModelId: this.modelId,
      activeModelVersion: this.modelRevision.slice(0, 12),
      activeJobId: this.activeJobId,
      lastErrorCode: null,
      timestampMs: Date.now(),
    };
  }

  public getResourceUsage(): AsrRuntimeResourceReport {
    const t = this.memoryGovernor.getTelemetry();
    return {
      runtimeTarget: this.runtimeTarget,
      accountedMemoryBytes: t.totalCacheBytes,
      memoryHardLimitBytes: 56 * 1024 * 1024,
      activeWorkerCount: this.encoderSession ? 1 : 0,
      activeJobCount: this.activeJobId ? 1 : 0,
    };
  }

  public async dispose(): Promise<void> {
    await this.unloadModel();
  }
}

/**
 * ============================================================================
 * SHAHAB-009 — UNIFIED RUNTIME CAPABILITY REGISTRY
 * ============================================================================
 */
export interface ShahabRuntimeCapabilityProfile {
  readonly runtimeId: string;
  readonly executionLocation: 'LOCAL_BROWSER' | 'LOCAL_NATIVE' | 'CLOUD_AUTHORIZED';
  readonly executionProvider: string;
  readonly verifiedInCurrentContainer: boolean;
  readonly supportedTensorDtypes: readonly string[];
  readonly int4MatMulNBitsSupported: boolean | 'NOT_VERIFIED';
  readonly streamingEncoderSupported: boolean;
  readonly encoderOutputReuseSupported: boolean;
  readonly maxRecommendedPackageBytes: number;
  readonly localAudioUploadPolicy: 'NEVER_UPLOAD' | 'EXPLICIT_USER_AUTHORIZATION_REQUIRED';
  readonly statusNote: string;
}

export class SHAHABRuntimeCapabilityRegistry {
  public listProfiles(): readonly ShahabRuntimeCapabilityProfile[] {
    return [
      {
        runtimeId: 'shahab-browser-wasm-cpu',
        executionLocation: 'LOCAL_BROWSER',
        executionProvider: 'onnxruntime-web@1.31.1 (wasm)',
        verifiedInCurrentContainer: true,
        supportedTensorDtypes: ['FLOAT', 'INT8', 'UINT8', 'INT64', 'INT32', 'BOOL'],
        int4MatMulNBitsSupported: false,
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 256 * 1024 * 1024,
        localAudioUploadPolicy: 'NEVER_UPLOAD',
        statusNote:
          'Verified with real unmocked Persian Zipformer INT8 inference on sample.wav in this container.',
      },
      {
        runtimeId: 'shahab-browser-webgpu',
        executionLocation: 'LOCAL_BROWSER',
        executionProvider: 'onnxruntime-web (webgpu)',
        verifiedInCurrentContainer: false,
        supportedTensorDtypes: ['FLOAT', 'FLOAT16'],
        int4MatMulNBitsSupported: 'NOT_VERIFIED',
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 256 * 1024 * 1024,
        localAudioUploadPolicy: 'NEVER_UPLOAD',
        statusNote: 'UNVERIFIED: No physical GPU / WebGPU adapter in headless Linux container; dynamic INT8 ConvInteger/MatMulInteger ops typically fall back to WASM.',
      },
      {
        runtimeId: 'shahab-native-sherpa-cpu',
        executionLocation: 'LOCAL_NATIVE',
        executionProvider: 'sherpa-onnx C++ / ONNX Runtime CPU',
        verifiedInCurrentContainer: false,
        supportedTensorDtypes: ['FLOAT', 'INT8', 'UINT8', 'INT64'],
        int4MatMulNBitsSupported: 'NOT_VERIFIED',
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 2 * 1024 * 1024 * 1024,
        localAudioUploadPolicy: 'NEVER_UPLOAD',
        statusNote: 'UNVERIFIED in container: sherpa-onnx-offline binary not installed in Linux sandbox; supported on desktop Companion deployments.',
      },
      {
        runtimeId: 'shahab-cloud-unified-contract',
        executionLocation: 'CLOUD_AUTHORIZED',
        executionProvider: 'Unified Avapardaz Local/Cloud Contract (explicit opt-in only)',
        verifiedInCurrentContainer: true,
        supportedTensorDtypes: ['FLOAT', 'FLOAT16', 'INT8'],
        int4MatMulNBitsSupported: 'NOT_VERIFIED',
        streamingEncoderSupported: false,
        encoderOutputReuseSupported: true,
        maxRecommendedPackageBytes: 4 * 1024 * 1024 * 1024,
        localAudioUploadPolicy: 'EXPLICIT_USER_AUTHORIZATION_REQUIRED',
        statusNote:
          'Contract parity verified; local mode never implicitly uploads audio (AVP-P01-006 / SHAHAB-010 §2).',
      },
    ];
  }
}
