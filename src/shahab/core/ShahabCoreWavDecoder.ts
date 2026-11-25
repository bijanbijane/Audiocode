/**
 * SHAHAB SHARED CORE — Host-Independent RIFF / RF64 WAV Decoder (SHB-F06)
 *
 * Parses PCM16, PCM24, IEEE Float32, and WAVE_FORMAT_EXTENSIBLE (0xFFFE) RIFF/RF64 WAV
 * payloads with strict truncation detection, zero-extra-array phase-safe downmixing,
 * and anti-aliased Kaiser-windowed sinc resampling to 16 kHz Mono Float32 PCM.
 */

import { resampleTo16kMono } from '../../engine/resampler';
import { downmixStreamToMonoPhaseSafe } from './ShahabCoreAudioConditioner';

export function decodeWavToMono16k(wavBytes: Uint8Array): {
  readonly pcm16k: Float32Array;
  readonly originalSampleRate: number;
  readonly originalChannels: number;
  readonly durationSec: number;
} {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const magic = wavBytes.byteLength >= 4 ? view.getUint32(0, false) : 0;
  const isRiff = magic === 0x52494646; // RIFF
  const isRf64 = magic === 0x52463634; // RF64
  if (
    wavBytes.byteLength < 44 ||
    (!isRiff && !isRf64) ||
    view.getUint32(8, false) !== 0x57415645 // WAVE
  ) {
    throw new Error('INVALID_WAV_HEADER: Expected RIFF/RF64 WAVE header.');
  }

  let offset = 12;
  let foundFmt = false;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let ds64DataSize: number | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBytes.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 0x64733634) {
      // ds64 (RF64 64-bit sizes)
      if (chunkSize >= 28 && body + 28 <= wavBytes.byteLength) {
        const lo = BigInt(view.getUint32(body + 8, true));
        const hi = BigInt(view.getUint32(body + 12, true));
        ds64DataSize = Number((hi << 32n) | lo);
      }
    } else if (chunkId === 0x666d7420) {
      // fmt
      if (chunkSize < 16 || body + 16 > wavBytes.byteLength) {
        throw new Error('INVALID_WAV_FMT: Truncated fmt chunk.');
      }
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      // Support WAVE_FORMAT_EXTENSIBLE (0xFFFE) for PCM (0x0001) and IEEE Float (0x0003)
      if (audioFormat === 0xfffe && chunkSize >= 40 && body + 40 <= wavBytes.byteLength) {
        const subFormatTag = view.getUint16(body + 24, true);
        const validExtGuidTail =
          view.getUint16(body + 26, true) === 0x0000 &&
          view.getUint16(body + 28, true) === 0x0000 &&
          view.getUint16(body + 30, true) === 0x0010 &&
          wavBytes[body + 32] === 0x80 &&
          wavBytes[body + 33] === 0x00 &&
          wavBytes[body + 34] === 0x00 &&
          wavBytes[body + 35] === 0xaa &&
          wavBytes[body + 36] === 0x00 &&
          wavBytes[body + 37] === 0x38 &&
          wavBytes[body + 38] === 0x9b &&
          wavBytes[body + 39] === 0x71;
        if (validExtGuidTail && (subFormatTag === 1 || subFormatTag === 3)) {
          audioFormat = subFormatTag;
        }
      }
      foundFmt = true;
    } else if (chunkId === 0x64617461) {
      // data
      dataOffset = body;
      const declaredSize =
        isRf64 && chunkSize === 0xffffffff && ds64DataSize !== null ? ds64DataSize : chunkSize;
      const availableBytes = wavBytes.byteLength - body;
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new Error('INVALID_WAV_DATA: Invalid declared WAV data chunk size.');
      }
      if (declaredSize > availableBytes) {
        throw new Error(
          `INVALID_WAV_TRUNCATED: Declared data size (${declaredSize} B) exceeds available bytes (${availableBytes} B).`,
        );
      }
      dataSize = declaredSize;
      break;
    }
    const nextOffset = body + chunkSize + (chunkSize % 2);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (!foundFmt) {
    throw new Error('INVALID_WAV_FMT: Missing fmt chunk.');
  }
  if (channels < 1 || channels > 8) {
    throw new Error(`INVALID_WAV_CHANNELS: Unsupported channel count (${channels}).`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 384000) {
    throw new Error(`INVALID_WAV_SAMPLE_RATE: Unsupported sample rate (${sampleRate}).`);
  }
  const isPcm16 = audioFormat === 1 && bitsPerSample === 16;
  const isPcm24 = audioFormat === 1 && bitsPerSample === 24;
  const isFloat32 = audioFormat === 3 && bitsPerSample === 32;
  if (!isPcm16 && !isPcm24 && !isFloat32) {
    throw new Error(`UNSUPPORTED_WAV_FORMAT: format=${audioFormat}, bits=${bitsPerSample}`);
  }
  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error('INVALID_WAV_DATA: Missing PCM data chunk.');
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const totalFrames = Math.floor(dataSize / frameBytes);
  if (totalFrames <= 0) {
    throw new Error('INVALID_WAV_DATA: WAV contains 0 audio frames.');
  }

  const readSample = (pos: number): number => {
    if (isFloat32) {
      const v = view.getFloat32(pos, true);
      return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }
    if (isPcm16) {
      return view.getInt16(pos, true) / 32768;
    }
    const b0 = wavBytes[pos];
    const b1 = wavBytes[pos + 1];
    const b2 = wavBytes[pos + 2];
    let v = b0 | (b1 << 8) | (b2 << 16);
    if (v & 0x800000) v |= ~0xffffff;
    return v / 8388608;
  };

  const { mono } = downmixStreamToMonoPhaseSafe({
    totalFrames,
    channels,
    readSample: (frame, ch) => readSample(dataOffset + frame * frameBytes + ch * bytesPerSample),
  });

  let pcm16k: Float32Array = mono;
  if (sampleRate !== 16000) {
    const resampled = resampleTo16kMono([mono], sampleRate, 16000).samples;
    pcm16k = resampled.length > 0 ? resampled : new Float32Array([mono[0] ?? 0]);
  }

  return {
    pcm16k,
    originalSampleRate: sampleRate,
    originalChannels: channels,
    durationSec: mono.length / sampleRate,
  };
}
