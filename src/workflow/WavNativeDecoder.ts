/**
 * AVAPARDAZ — NATIVE MULTI-CHANNEL WAV DECODER & WAVEFORM PEAK EXTRACTOR
 *
 * Decodes PCM16, PCM24, and IEEE Float32 RIFF/WAVE files directly into planar Float32Array[]
 * preserving exact original sample rate and channel count (mono, stereo, multi-channel)
 * for sample-exact Engine 03 rendering without unnecessary resampling or FFmpeg round-trips.
 */

import type { SampleRate } from '../contracts/timebase.contract';

export interface DecodedNativeWav {
  readonly sampleRate: SampleRate;
  readonly rawSampleRateHz: number;
  readonly channelCount: number;
  readonly bitsPerSample: 16 | 24 | 32;
  readonly audioFormat: 1 | 3; // 1 = PCM, 3 = IEEE Float
  readonly totalSamples: number;
  readonly durationSec: number;
  readonly channels: readonly Float32Array[];
  readonly monoDownmix: Float32Array;
}

const SUPPORTED_SAMPLE_RATES: readonly SampleRate[] = [16000, 22050, 44100, 48000, 88200, 96000];

export function snapToSupportedSampleRate(hz: number): SampleRate {
  if ((SUPPORTED_SAMPLE_RATES as readonly number[]).includes(hz)) {
    return hz as SampleRate;
  }
  let best: SampleRate = 16000;
  let minDiff = Infinity;
  for (const sr of SUPPORTED_SAMPLE_RATES) {
    const diff = Math.abs(sr - hz);
    if (diff < minDiff) {
      minDiff = diff;
      best = sr;
    }
  }
  return best;
}

export function isSupportedExactSampleRate(hz: number): hz is SampleRate {
  return (SUPPORTED_SAMPLE_RATES as readonly number[]).includes(hz);
}

/**
 * Decodes RIFF/WAVE PCM16 / PCM24 / Float32 directly into planar Float32Array channels.
 * Returns null if the buffer is not a standard PCM/Float32 RIFF WAV (caller may use FFmpeg).
 */
export function decodeNativeWavToPlanar(bytes: Buffer | Uint8Array): DecodedNativeWav | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let audioFormat = 0;
  let channelCount = 0;
  let rawSampleRateHz = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && payloadStart + 16 <= bytes.byteLength) {
      audioFormat = view.getUint16(payloadStart, true);
      channelCount = view.getUint16(payloadStart + 2, true);
      rawSampleRateHz = view.getUint32(payloadStart + 4, true);
      bitsPerSample = view.getUint16(payloadStart + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = payloadStart;
      dataSize = Math.min(chunkSize, bytes.byteLength - payloadStart);
      break;
    }

    offset = payloadStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0 || channelCount < 1 || channelCount > 8 || rawSampleRateHz <= 0) {
    return null;
  }

  const isPcm16 = audioFormat === 1 && bitsPerSample === 16;
  const isPcm24 = audioFormat === 1 && bitsPerSample === 24;
  const isFloat32 = audioFormat === 3 && bitsPerSample === 32;
  if (!isPcm16 && !isPcm24 && !isFloat32) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channelCount;
  const totalSamples = Math.floor(dataSize / frameBytes);
  if (totalSamples <= 0) return null;

  const channels: Float32Array[] = Array.from(
    { length: channelCount },
    () => new Float32Array(totalSamples),
  );
  const monoDownmix = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    let monoSum = 0;
    const frameStart = dataOffset + i * frameBytes;
    for (let c = 0; c < channelCount; c++) {
      const samplePos = frameStart + c * bytesPerSample;
      let val = 0;
      if (isPcm16) {
        val = view.getInt16(samplePos, true) / 32768;
      } else if (isPcm24) {
        const b0 = bytes[samplePos];
        const b1 = bytes[samplePos + 1];
        const b2 = bytes[samplePos + 2];
        let int24 = b0 | (b1 << 8) | (b2 << 16);
        if (int24 & 0x800000) int24 |= ~0xffffff;
        val = int24 / 8388608;
      } else {
        const raw = view.getFloat32(samplePos, true);
        val = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      }
      channels[c][i] = val;
      monoSum += val;
    }
    monoDownmix[i] = monoSum / channelCount;
  }

  return {
    sampleRate: snapToSupportedSampleRate(rawSampleRateHz),
    rawSampleRateHz,
    channelCount,
    bitsPerSample: bitsPerSample as 16 | 24 | 32,
    audioFormat: audioFormat as 1 | 3,
    totalSamples,
    durationSec: Number((totalSamples / rawSampleRateHz).toFixed(4)),
    channels,
    monoDownmix,
  };
}

/**
 * Downsamples real decoded mono PCM into N normalized peak buckets [0..1] for honest
 * waveform visualization in the Web App (never synthetic/random bars).
 */
export function computeRealWaveformPeaks(
  monoSamples: Float32Array,
  bucketCount = 240,
): number[] {
  const safeBuckets = Math.max(16, Math.min(1000, Math.trunc(bucketCount)));
  if (monoSamples.length === 0) return Array(safeBuckets).fill(0);
  const peaks: number[] = new Array(safeBuckets);
  const samplesPerBucket = monoSamples.length / safeBuckets;

  for (let b = 0; b < safeBuckets; b++) {
    const start = Math.floor(b * samplesPerBucket);
    const end = Math.min(monoSamples.length, Math.max(start + 1, Math.floor((b + 1) * samplesPerBucket)));
    let maxAbs = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(monoSamples[i]);
      if (Number.isFinite(a) && a > maxAbs) maxAbs = a;
    }
    peaks[b] = Number(Math.min(1, maxAbs).toFixed(4));
  }
  return peaks;
}
