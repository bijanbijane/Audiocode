/**
 * AVAPARDAZ — PHASE 1C-A: FILE-BACKED STREAMING CANONICAL AUDIO INGESTION
 *
 * Eliminates full-file RAM materialization in `LocalSherpaNeuralEngine` and Native ASR ingestion:
 * - Zero `fs.readFileSync(audioFilePath)` of full WAV/container payloads
 * - Zero full-file `canonical16kMono` (`Float32Array`) or `canonicalPcm16` (`Buffer`) in RAM
 * - Zero `Buffer.concat` to reconstruct full audio files
 * - Two-pass / streaming disk-backed architecture:
 *   1. Native RIFF/RF64 WAV Fast-Path (`16-bit PCM`, `24-bit PCM`, `32-bit PCM`, `32-bit IEEE Float`):
 *      - Reads source WAV in bounded `<= 256 KiB` frame windows via `fs.promises.FileHandle`
 *      - Computes streaming source SHA-256 and exact L/R stereo phase & RMS statistics
 *        (`MONO_PASSTHROUGH`, `LEFT_PRIMARY_PHASE_GUARD`, `DOMINANT_ACTIVE_CHANNEL`, `EQUAL_POWER_AVG`)
 *        matching `inspectAndDownmixChannels` mathematically without holding full channels in memory
 *      - Downmixes each window using the determined stereo policy and feeds `StreamingKaiserSincResampler`
 *        with continuous filter state (`ringTail`) across chunk boundaries (zero boundary phase reset)
 *      - Writes canonical `16 kHz Mono PCM16` WAV chunks to an unguessable `0o600` canonical temp file
 *        with real `drain` backpressure and atomic staging activation (incomplete canonical files are
 *        never exposed to the ASR engine)
 *   2. Non-WAV Container Fallback (MP3, FLAC, OGG, M4A, WebM via FFmpeg):
 *      - Decodes container to a temporary `16 kHz` raw `.s16` file on disk via `ffmpeg`
 *      - Streams the `.s16` file in `<= 256 KiB` windows to apply the exact Stereo Phase Guard and
 *        produce the canonical `16 kHz Mono PCM16` file without `fs.readFileSync(outStereo16kRaw)`
 * - 11-State Resource Lifecycle per Job:
 *   `OPENING_SOURCE -> READING -> DECODING -> RESAMPLING -> WRITING_CANONICAL -> CANONICAL_READY -> INFERENCE -> COMPLETED | FAILED | CANCELLED -> CLEANED`
 * - Separate Memory Accounting (`<= 8 MiB` hard ceiling on total temporary ingestion buffers per job)
 * - Windowed disk-to-disk ASR chunk extraction (`readCanonicalFloat32Window` & `exportCanonicalChunkWavToFile`)
 *   and Energy-Valley VAD boundary search (`findBestBoundaryValleySampleFromCanonicalFile`) reading only
 *   the `±1.5s` neighborhood (`~96 KiB`) around each nominal split point.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamingKaiserSincResampler } from '../engine/resampler';
import type {
  AudioContainerFormat,
  CoreAudioIngestResult,
  StereoChannelInspection,
} from './CoreAsrContracts';
import {
  detectAudioContainerFormat,
  isFfmpegAvailable,
  probeAudioStreamInfo,
} from './CoreAudioIngestion';

export const CANONICAL_TARGET_SAMPLE_RATE_HZ = 16_000;
export const MAX_INGESTION_IO_CHUNK_BYTES = 256 * 1024; // 256 KiB per read/write buffer
export const MAX_TOTAL_INGESTION_BUFFERS_BYTES = 8 * 1024 * 1024; // 8 MiB hard ceiling per job (Section 10)
const MAX_DECODED_DURATION_SEC = 7200; // 2 hours
const MAX_DECODED_PCM_BYTES = 1536 * 1024 * 1024; // 1.5 GiB safety ceiling for 60m+ 48kHz Stereo PCM32

export type NativeAsrIngestionLifecycleState =
  | 'OPENING_SOURCE'
  | 'READING'
  | 'DECODING'
  | 'RESAMPLING'
  | 'WRITING_CANONICAL'
  | 'CANONICAL_READY'
  | 'INFERENCE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CLEANED';

export type IngestionBufferCategory =
  | 'fileReadBuffer'
  | 'decoderBuffer'
  | 'resamplerBuffer'
  | 'canonicalOutputBuffer';

export interface NativeIngestionMemorySnapshot {
  readonly companionProcessRssBytes: number;
  readonly nativeInferenceChildRssBytes: number;
  readonly modelRuntimeBytes: number;
  readonly fileReadBufferBytes: number;
  readonly decoderBufferBytes: number;
  readonly resamplerBufferBytes: number;
  readonly canonicalOutputBufferBytes: number;
  readonly currentTotalIngestionBuffersBytes: number;
  readonly peakFileReadBufferBytes: number;
  readonly peakDecoderBufferBytes: number;
  readonly peakResamplerBufferBytes: number;
  readonly peakCanonicalOutputBufferBytes: number;
  readonly peakTotalIngestionBuffersBytes: number;
  readonly peakCompanionProcessRssBytes: number;
  readonly peakNativeInferenceChildRssBytes: number;
  readonly backpressureDrainWaits: number;
}

export class NativeIngestionMemoryTracker {
  private current: Record<IngestionBufferCategory, number> = {
    fileReadBuffer: 0,
    decoderBuffer: 0,
    resamplerBuffer: 0,
    canonicalOutputBuffer: 0,
  };

  private peaks: Record<IngestionBufferCategory, number> = {
    fileReadBuffer: 0,
    decoderBuffer: 0,
    resamplerBuffer: 0,
    canonicalOutputBuffer: 0,
  };

  private peakTotalIngestionBytes = 0;
  private companionRssBytes = process.memoryUsage().rss;
  private peakCompanionRssBytes = this.companionRssBytes;
  private childRssBytes = 0;
  private peakChildRssBytes = 0;
  private modelRuntimeBytes = 0;
  private drainWaits = 0;

  public acquire(category: IngestionBufferCategory, bytes: number): () => void {
    const safeBytes = Math.max(0, Math.floor(bytes));
    const currentTotal = this.getCurrentTotalIngestionBytes();
    if (currentTotal + safeBytes > MAX_TOTAL_INGESTION_BUFFERS_BYTES) {
      throw new Error(
        `INGESTION_BUFFER_BUDGET_EXCEEDED: allocating ${safeBytes} bytes in ${category} would exceed 8 MiB job ingestion limit (current=${currentTotal}).`,
      );
    }
    this.current[category] += safeBytes;
    if (this.current[category] > this.peaks[category]) {
      this.peaks[category] = this.current[category];
    }
    const nextTotal = this.getCurrentTotalIngestionBytes();
    if (nextTotal > this.peakTotalIngestionBytes) {
      this.peakTotalIngestionBytes = nextTotal;
    }
    this.sampleProcessRss();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.current[category] = Math.max(0, this.current[category] - safeBytes);
    };
  }

  public getCurrentTotalIngestionBytes(): number {
    return (
      this.current.fileReadBuffer +
      this.current.decoderBuffer +
      this.current.resamplerBuffer +
      this.current.canonicalOutputBuffer
    );
  }

  public sampleProcessRss(): number {
    const rss = process.memoryUsage().rss;
    this.companionRssBytes = rss;
    if (rss > this.peakCompanionRssBytes) {
      this.peakCompanionRssBytes = rss;
    }
    return rss;
  }

  public recordChildProcessRss(rssBytes: number): void {
    const safe = Math.max(0, Math.floor(rssBytes));
    this.childRssBytes = safe;
    if (safe > this.peakChildRssBytes) {
      this.peakChildRssBytes = safe;
    }
  }

  public setModelRuntimeBytes(bytes: number): void {
    this.modelRuntimeBytes = Math.max(0, Math.floor(bytes));
  }

  public recordDrainWait(): void {
    this.drainWaits += 1;
  }

  public getSnapshot(): NativeIngestionMemorySnapshot {
    this.sampleProcessRss();
    return {
      companionProcessRssBytes: this.companionRssBytes,
      nativeInferenceChildRssBytes: this.childRssBytes,
      modelRuntimeBytes: this.modelRuntimeBytes,
      fileReadBufferBytes: this.current.fileReadBuffer,
      decoderBufferBytes: this.current.decoderBuffer,
      resamplerBufferBytes: this.current.resamplerBuffer,
      canonicalOutputBufferBytes: this.current.canonicalOutputBuffer,
      currentTotalIngestionBuffersBytes: this.getCurrentTotalIngestionBytes(),
      peakFileReadBufferBytes: this.peaks.fileReadBuffer,
      peakDecoderBufferBytes: this.peaks.decoderBuffer,
      peakResamplerBufferBytes: this.peaks.resamplerBuffer,
      peakCanonicalOutputBufferBytes: this.peaks.canonicalOutputBuffer,
      peakTotalIngestionBuffersBytes: this.peakTotalIngestionBytes,
      peakCompanionProcessRssBytes: this.peakCompanionRssBytes,
      peakNativeInferenceChildRssBytes: this.peakChildRssBytes,
      backpressureDrainWaits: this.drainWaits,
    };
  }
}

export interface ParsedSourceWavLayout {
  readonly isRf64: boolean;
  readonly audioFormat: 1 | 3; // 1 = PCM, 3 = IEEE Float
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitsPerSample: 16 | 24 | 32;
  readonly bytesPerSample: 2 | 3 | 4;
  readonly blockAlign: number;
  readonly dataOffsetBytes: number;
  readonly dataByteLength: number;
  readonly exactFrameCount: number;
}

/**
 * Parses a RIFF or RF64 WAV header from a bounded initial buffer (<= 4096 bytes).
 */
export function parseSourceWavHeaderBounded(
  headerBytes: Buffer,
  totalFileSizeBytes: number,
): ParsedSourceWavLayout {
  if (headerBytes.byteLength < 44) {
    throw new Error('WAV_HEADER_TOO_SMALL: WAV file is smaller than 44-byte minimum header.');
  }
  const magic = headerBytes.toString('ascii', 0, 4);
  const wave = headerBytes.toString('ascii', 8, 12);
  if ((magic !== 'RIFF' && magic !== 'RF64') || wave !== 'WAVE') {
    throw new Error('WAV_INVALID_SIGNATURE: Missing RIFF/RF64 or WAVE signature.');
  }

  const isRf64 = magic === 'RF64';
  let ds64DataSize: number | null = null;
  let foundFmt = false;
  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffsetBytes = -1;
  let dataByteLength = 0;

  let offset = 12;
  while (offset + 8 <= headerBytes.byteLength) {
    const chunkId = headerBytes.toString('ascii', offset, offset + 4);
    const chunkSize = headerBytes.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;

    if (chunkId === 'ds64' && chunkSize >= 28 && payloadStart + 28 <= headerBytes.byteLength) {
      const lo = BigInt(headerBytes.readUInt32LE(payloadStart + 8));
      const hi = BigInt(headerBytes.readUInt32LE(payloadStart + 12));
      ds64DataSize = Number((hi << 32n) | lo);
    } else if (chunkId === 'fmt ') {
      if (chunkSize < 16 || payloadStart + 16 > headerBytes.byteLength) {
        throw new Error('WAV_CORRUPT_FMT_CHUNK: fmt chunk is truncated or smaller than 16 bytes.');
      }
      audioFormat = headerBytes.readUInt16LE(payloadStart);
      channels = headerBytes.readUInt16LE(payloadStart + 2);
      sampleRateHz = headerBytes.readUInt32LE(payloadStart + 4);
      byteRate = headerBytes.readUInt32LE(payloadStart + 8);
      blockAlign = headerBytes.readUInt16LE(payloadStart + 12);
      bitsPerSample = headerBytes.readUInt16LE(payloadStart + 14);
      foundFmt = true;
    } else if (chunkId === 'data') {
      dataOffsetBytes = payloadStart;
      dataByteLength =
        isRf64 && chunkSize === 0xffffffff && ds64DataSize !== null ? ds64DataSize : chunkSize;
      break;
    }

    const padded = chunkSize + (chunkSize % 2);
    if (padded < 0 || payloadStart + padded <= offset) break;
    offset = payloadStart + padded;
  }

  if (!foundFmt || dataOffsetBytes < 0) {
    throw new Error('WAV_STRUCTURE_INVALID: Missing fmt or data chunk in WAV header.');
  }
  if (channels < 1 || channels > 8) {
    throw new Error(`WAV_UNSUPPORTED_CHANNELS: Channel count ${channels} is outside [1, 8].`);
  }
  if (sampleRateHz < 8000 || sampleRateHz > 192000) {
    throw new Error(
      `WAV_SAMPLE_RATE_OUT_OF_RANGE: sampleRateHz ${sampleRateHz} is outside [8000, 192000].`,
    );
  }

  const isPcm = audioFormat === 1 && (bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32);
  const isFloat = audioFormat === 3 && bitsPerSample === 32;
  if (!isPcm && !isFloat) {
    throw new Error(
      `WAV_UNSUPPORTED_ENCODING: audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}.`,
    );
  }

  const bytesPerSample = (bitsPerSample / 8) as 2 | 3 | 4;
  const expectedBlockAlign = channels * bytesPerSample;
  if (blockAlign !== expectedBlockAlign || byteRate !== sampleRateHz * expectedBlockAlign) {
    throw new Error(
      `WAV_FMT_INCONSISTENT: blockAlign (${blockAlign}) or byteRate (${byteRate}) does not match channels*bytesPerSample.`,
    );
  }

  const availableBytes = totalFileSizeBytes - dataOffsetBytes;
  if (dataByteLength <= 0 || availableBytes < dataByteLength) {
    throw new Error(
      `WAV_TRUNCATED_PAYLOAD: Declared data size (${dataByteLength}) exceeds available bytes (${availableBytes}).`,
    );
  }

  const exactFrameCount = Math.floor(dataByteLength / expectedBlockAlign);
  if (exactFrameCount <= 0) {
    throw new Error('WAV_EMPTY_FRAMES: WAV contains 0 audio frames.');
  }

  return {
    isRf64,
    audioFormat: audioFormat as 1 | 3,
    channels,
    sampleRateHz,
    bitsPerSample: bitsPerSample as 16 | 24 | 32,
    bytesPerSample,
    blockAlign: expectedBlockAlign,
    dataOffsetBytes,
    dataByteLength: exactFrameCount * expectedBlockAlign,
    exactFrameCount,
  };
}

/**
 * Decodes a single bounded raw byte window of interleaved WAV frames into planar Float32Array[] channels.
 */
export function decodeWavChunkToPlanar(
  rawBuf: Buffer,
  bytesRead: number,
  layout: Pick<ParsedSourceWavLayout, 'audioFormat' | 'bitsPerSample' | 'bytesPerSample' | 'channels' | 'blockAlign'>,
  reusablePlanar: Float32Array[],
): number {
  const frameCount = Math.floor(bytesRead / layout.blockAlign);
  const { channels, bytesPerSample, audioFormat, bitsPerSample } = layout;

  for (let f = 0; f < frameCount; f++) {
    const frameBase = f * layout.blockAlign;
    for (let c = 0; c < channels; c++) {
      const pos = frameBase + c * bytesPerSample;
      let sample = 0;
      if (audioFormat === 1 && bitsPerSample === 16) {
        sample = rawBuf.readInt16LE(pos) / 32768;
      } else if (audioFormat === 1 && bitsPerSample === 24) {
        const b0 = rawBuf[pos];
        const b1 = rawBuf[pos + 1];
        const b2 = rawBuf[pos + 2];
        let int24 = b0 | (b1 << 8) | (b2 << 16);
        if (int24 & 0x800000) int24 |= ~0xffffff;
        sample = int24 / 8388608;
      } else if (audioFormat === 1 && bitsPerSample === 32) {
        sample = rawBuf.readInt32LE(pos) / 2147483648;
      } else {
        const raw = rawBuf.readFloatLE(pos);
        sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      }
      reusablePlanar[c][f] = sample;
    }
  }
  return frameCount;
}

/**
 * Downmixes a single planar window into `outMono[0..frameCount)` according to the resolved stereo policy.
 */
export function downmixPlanarChunkWithPolicy(
  planar: readonly Float32Array[],
  frameCount: number,
  inspection: StereoChannelInspection,
  outMono: Float32Array,
): void {
  const chCount = planar.length;
  if (chCount === 1) {
    const ch0 = planar[0];
    for (let i = 0; i < frameCount; i++) {
      const v = ch0[i];
      outMono[i] = Number.isFinite(v) ? v : 0;
    }
    return;
  }

  const left = planar[0];
  const right = planar[1];
  const preferLeft = inspection.leftRmsDb >= inspection.rightRmsDb;

  if (
    inspection.policyApplied === 'LEFT_PRIMARY_PHASE_GUARD' ||
    inspection.policyApplied === 'DOMINANT_ACTIVE_CHANNEL'
  ) {
    const active = preferLeft ? left : right;
    for (let i = 0; i < frameCount; i++) {
      const v = active[i];
      outMono[i] = Number.isFinite(v) ? v : 0;
    }
    return;
  }

  if (chCount === 2) {
    for (let i = 0; i < frameCount; i++) {
      const l = Number.isFinite(left[i]) ? left[i] : 0;
      const r = Number.isFinite(right[i]) ? right[i] : 0;
      outMono[i] = (l + r) * 0.5;
    }
    return;
  }

  // >2 channels equal-power average
  const invCh = 1 / chCount;
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < chCount; c++) {
      const v = planar[c][i];
      if (Number.isFinite(v)) sum += v;
    }
    outMono[i] = sum * invCh;
  }
}

export interface FileBackedCanonicalAudioSource {
  readonly jobId: string;
  readonly ownerId: string;
  readonly sourceFilePath: string;
  readonly sourceFilename: string;
  readonly sourceFormat: AudioContainerFormat;
  readonly sourceSampleRateHz: number;
  readonly sourceChannels: number;
  readonly sourceBitsPerSample: 16 | 24 | 32;
  readonly sourceEncoding: 'pcm_s16le' | 'pcm_s24le' | 'pcm_s32le' | 'pcm_f32le' | 'container';
  readonly sourceExactFrameCount: number;
  readonly sourceSha256: string;
  readonly canonicalWavFilePath: string;
  readonly canonicalDataOffsetBytes: 44;
  readonly canonicalSampleRateHz: 16000;
  readonly canonicalChannels: 1;
  readonly canonicalExactSampleCount: number;
  readonly canonicalDurationSec: number;
  readonly canonicalSha256: string;
  readonly stereoInspection: StereoChannelInspection;
  readonly signalHealth: CoreAudioIngestResult['signalHealth'];
  readonly warnings: readonly string[];
  readonly memoryTracker: NativeIngestionMemoryTracker;
  getLifecycleState(): NativeAsrIngestionLifecycleState;
  getStateHistory(): readonly NativeAsrIngestionLifecycleState[];
  markInferenceStarted(): void;
  readCanonicalFloat32Window(
    startSample: number,
    endSample: number,
    signal?: AbortSignal,
  ): Promise<Float32Array>;
  findBestBoundaryValleySampleOnDisk(
    nominalSample: number,
    searchRadiusSamples: number,
    signal?: AbortSignal,
  ): Promise<number>;
  exportCanonicalChunkWavToFile(
    startSample: number,
    endSample: number,
    destinationWavPath: string,
    signal?: AbortSignal,
  ): Promise<{ readonly frameCount: number; readonly byteLength: number }>;
  close(finalState?: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void>;
}

const DEFAULT_CANONICAL_STAGING_ROOT = path.join(
  os.tmpdir(),
  'avapardaz-native-asr-canonical',
);

/**
 * Cleans up any orphaned canonical ingestion directories or `.wav`/`.part` files left behind
 * by an unexpected process crash or restart (Section 8 requirement #11).
 */
export function cleanupOrphanedCanonicalIngestionFiles(
  stagingRoot = DEFAULT_CANONICAL_STAGING_ROOT,
  activeJobIds: ReadonlySet<string> = new Set(),
): number {
  if (!fs.existsSync(stagingRoot)) return 0;
  let cleaned = 0;
  try {
    const lstat = fs.lstatSync(stagingRoot);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return 0;
    for (const entryName of fs.readdirSync(stagingRoot)) {
      if (!/^canon_[a-f0-9]{16,32}/i.test(entryName)) continue;
      const jobIdMatch = entryName.match(/^(canon_[a-f0-9]{16,32})/i);
      const id = jobIdMatch ? jobIdMatch[1] : '';
      if (id && activeJobIds.has(id)) continue;
      const fullPath = path.resolve(stagingRoot, entryName);
      const rel = path.relative(stagingRoot, fullPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        cleaned += 1;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return cleaned;
}

function buildCanonical16kMonoWavHeader(sampleCount: number): Buffer {
  const dataBytes = sampleCount * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 1 channel
  header.writeUInt32LE(CANONICAL_TARGET_SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(CANONICAL_TARGET_SAMPLE_RATE_HZ * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Reads `[startSample, endSample)` from an on-disk 16 kHz Mono PCM16 canonical WAV file
 * into a bounded `Float32Array` window without reading the rest of the file.
 */
async function readCanonicalWindowFromHandle(
  fh: fs.promises.FileHandle,
  totalSamples: number,
  startSample: number,
  endSample: number,
  memoryTracker: NativeIngestionMemoryTracker,
  signal?: AbortSignal,
): Promise<Float32Array> {
  if (signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
  const clampedStart = Math.max(0, Math.min(totalSamples, Math.floor(startSample)));
  const clampedEnd = Math.max(clampedStart, Math.min(totalSamples, Math.floor(endSample)));
  const count = clampedEnd - clampedStart;
  if (count <= 0) return new Float32Array(0);

  const byteLength = count * 2;
  const releaseRead = memoryTracker.acquire('fileReadBuffer', Math.min(byteLength, MAX_INGESTION_IO_CHUNK_BYTES));
  const releaseDec = memoryTracker.acquire('decoderBuffer', count * 4);
  try {
    const out = new Float32Array(count);
    const ioBuf = Buffer.allocUnsafe(Math.min(byteLength, MAX_INGESTION_IO_CHUNK_BYTES));
    let samplesFilled = 0;

    while (samplesFilled < count) {
      if (signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
      const remainingBytes = (count - samplesFilled) * 2;
      const toRead = Math.min(ioBuf.byteLength, remainingBytes);
      const fileOffset = 44 + (clampedStart + samplesFilled) * 2;
      const { bytesRead } = await fh.read(ioBuf, 0, toRead, fileOffset);
      if (bytesRead <= 0) break;
      const samplesInChunk = Math.floor(bytesRead / 2);
      for (let i = 0; i < samplesInChunk; i++) {
        out[samplesFilled + i] = ioBuf.readInt16LE(i * 2) / 32768;
      }
      samplesFilled += samplesInChunk;
    }
    return out;
  } finally {
    releaseDec();
    releaseRead();
  }
}

/**
 * Streams an audio file (or small inline buffer first written to a confined temp file)
 * through bounded `<= 256 KiB` decode, stereo phase guard, and stateful `StreamingKaiserSincResampler`
 * into a verified on-disk `16 kHz Mono PCM16` canonical WAV file.
 */
export async function createStreamingCanonicalAudioSource(params: {
  readonly audioFilePath?: string;
  readonly audioBytes?: Buffer;
  readonly filename?: string;
  readonly ownerId?: string;
  readonly stagingRootDir?: string;
  readonly signal?: AbortSignal;
  readonly memoryTracker?: NativeIngestionMemoryTracker;
  readonly onLifecycleState?: (state: NativeAsrIngestionLifecycleState) => void;
}): Promise<FileBackedCanonicalAudioSource> {
  const memoryTracker = params.memoryTracker ?? new NativeIngestionMemoryTracker();
  const stagingRoot = path.resolve(params.stagingRootDir ?? DEFAULT_CANONICAL_STAGING_ROOT);
  const jobId = `canon_${crypto.randomBytes(16).toString('hex')}`;
  const ownerId = params.ownerId?.trim() || 'local-default';

  const stateHistory: NativeAsrIngestionLifecycleState[] = [];
  let currentState: NativeAsrIngestionLifecycleState = 'OPENING_SOURCE';

  const transition = (next: NativeAsrIngestionLifecycleState) => {
    if (currentState !== next) {
      currentState = next;
      stateHistory.push(next);
      params.onLifecycleState?.(next);
    }
  };
  stateHistory.push('OPENING_SOURCE');
  params.onLifecycleState?.('OPENING_SOURCE');

  const checkAbort = () => {
    if (params.signal?.aborted) {
      throw new Error('TRANSCRIPTION_CANCELLED');
    }
  };

  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const rootLstat = fs.lstatSync(stagingRoot);
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new Error('CANONICAL_STAGING_UNSAFE: stagingRootDir must be a real directory.');
  }

  const jobDir = path.resolve(stagingRoot, jobId);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });

  let sourceFilePath = params.audioFilePath ? path.resolve(params.audioFilePath) : '';
  let ownsSourceTempFile = false;

  const cleanupJobDir = () => {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    checkAbort();

    if (!sourceFilePath) {
      if (!params.audioBytes || params.audioBytes.byteLength === 0) {
        throw new Error('AUDIO_INGEST_EMPTY: Either audioFilePath or non-empty audioBytes is required.');
      }
      const ext = path.extname(params.filename || 'audio.wav') || '.wav';
      sourceFilePath = path.join(jobDir, `inline_input${ext}`);
      ownsSourceTempFile = true;
      // Write inline buffer in 256 KiB slices
      const fd = fs.openSync(sourceFilePath, 'wx', 0o600);
      try {
        let written = 0;
        while (written < params.audioBytes.byteLength) {
          checkAbort();
          const sliceLen = Math.min(
            MAX_INGESTION_IO_CHUNK_BYTES,
            params.audioBytes.byteLength - written,
          );
          fs.writeSync(fd, params.audioBytes, written, sliceLen, written);
          written += sliceLen;
        }
      } finally {
        fs.closeSync(fd);
      }
    }

    let sourceStat: fs.Stats;
    try {
      sourceStat = fs.statSync(sourceFilePath);
    } catch {
      throw new Error('AUDIO_FILE_NOT_FOUND: Source audio file does not exist or is unreadable.');
    }
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      throw new Error('AUDIO_INGEST_EMPTY: Source audio file is empty.');
    }

    const sourceFilename = path.basename(params.filename || sourceFilePath);

    // Inspect initial 4096 bytes ONLY to detect container magic and WAV layout
    transition('READING');
    const initialInspectLen = Math.min(4096, sourceStat.size);
    const releaseHeaderBuf = memoryTracker.acquire('fileReadBuffer', initialInspectLen);
    const headerBuf = Buffer.allocUnsafe(initialInspectLen);
    let sourceFh: fs.promises.FileHandle | null = null;
    try {
      sourceFh = await fs.promises.open(sourceFilePath, 'r');
      const { bytesRead } = await sourceFh.read(headerBuf, 0, initialInspectLen, 0);
      if (bytesRead < 12) {
        throw new Error('AUDIO_INGEST_TOO_SMALL: Audio file is smaller than 12 bytes.');
      }
    } finally {
      releaseHeaderBuf();
      if (sourceFh) {
        await sourceFh.close().catch(() => {});
        sourceFh = null;
      }
    }

    const headerSlice = headerBuf.subarray(0, initialInspectLen);
    const isRf64Magic =
      initialInspectLen >= 12 &&
      headerSlice.toString('ascii', 0, 4) === 'RF64' &&
      headerSlice.toString('ascii', 8, 12) === 'WAVE';
    const detectedFormat: AudioContainerFormat = isRf64Magic
      ? 'wav'
      : detectAudioContainerFormat(headerSlice, sourceFilename);

    if (detectedFormat === 'unknown') {
      throw new Error(
        'AUDIO_INGEST_UNSUPPORTED_MAGIC: File signature does not match supported audio containers.',
      );
    }

    // Compute source file SHA-256 via streaming (unless it is a native WAV, where Pass 1 hashes it while inspecting stereo)
    let wavTargetFilePath = sourceFilePath;
    let wavLayout: ParsedSourceWavLayout;
    let originalSampleRateHz = CANONICAL_TARGET_SAMPLE_RATE_HZ;
    let originalChannels = 1;
    let sourceBitsPerSample: 16 | 24 | 32 = 16;
    let sourceEncoding: FileBackedCanonicalAudioSource['sourceEncoding'] = 'pcm_s16le';
    let sourceSha256 = '';

    if (detectedFormat === 'wav') {
      wavLayout = parseSourceWavHeaderBounded(headerSlice, sourceStat.size);
      originalSampleRateHz = wavLayout.sampleRateHz;
      originalChannels = wavLayout.channels;
      sourceBitsPerSample = wavLayout.bitsPerSample;
      sourceEncoding =
        wavLayout.audioFormat === 3
          ? 'pcm_f32le'
          : wavLayout.bitsPerSample === 16
            ? 'pcm_s16le'
            : wavLayout.bitsPerSample === 24
              ? 'pcm_s24le'
              : 'pcm_s32le';
    } else {
      // Non-WAV container (MP3, FLAC, OGG, M4A, WebM): stream SHA-256 of source file first, then decode via FFmpeg to disk WAV
      if (!isFfmpegAvailable()) {
        throw new Error('AUDIO_DECODER_UNAVAILABLE: System ffmpeg binary is missing.');
      }
      const srcHasher = crypto.createHash('sha256');
      const releaseHashBuf = memoryTracker.acquire('fileReadBuffer', MAX_INGESTION_IO_CHUNK_BYTES);
      const hashFh = await fs.promises.open(sourceFilePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(MAX_INGESTION_IO_CHUNK_BYTES);
        let pos = 0;
        while (pos < sourceStat.size) {
          checkAbort();
          const { bytesRead } = await hashFh.read(
            buf,
            0,
            Math.min(buf.byteLength, sourceStat.size - pos),
            pos,
          );
          if (bytesRead <= 0) break;
          srcHasher.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
        sourceSha256 = srcHasher.digest('hex');
      } finally {
        await hashFh.close().catch(() => {});
        releaseHashBuf();
      }

      transition('DECODING');
      const streamInfo = probeAudioStreamInfo(sourceFilePath);
      originalSampleRateHz = streamInfo.sampleRateHz;
      originalChannels = streamInfo.channels;
      sourceEncoding = 'container';
      const probeChannels = Math.max(1, Math.min(2, streamInfo.channels));
      const decodedWavPath = path.join(jobDir, 'ffmpeg_decoded_16k.wav');

      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-i',
          sourceFilePath,
          '-vn',
          '-t',
          String(MAX_DECODED_DURATION_SEC),
          '-fs',
          String(MAX_DECODED_PCM_BYTES),
          '-acodec',
          'pcm_s16le',
          '-ar',
          String(CANONICAL_TARGET_SAMPLE_RATE_HZ),
          '-ac',
          String(probeChannels),
          '-f',
          'wav',
          decodedWavPath,
        ],
        { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      const decStat = fs.statSync(decodedWavPath);
      const decHeaderBuf = Buffer.allocUnsafe(Math.min(4096, decStat.size));
      const decFd = fs.openSync(decodedWavPath, 'r');
      try {
        fs.readSync(decFd, decHeaderBuf, 0, decHeaderBuf.byteLength, 0);
      } finally {
        fs.closeSync(decFd);
      }
      wavTargetFilePath = decodedWavPath;
      wavLayout = parseSourceWavHeaderBounded(decHeaderBuf, decStat.size);
    }

    // Align read chunk size to an exact multiple of blockAlign <= 256 KiB
    const framesPerChunk = Math.max(
      256,
      Math.floor(MAX_INGESTION_IO_CHUNK_BYTES / wavLayout.blockAlign),
    );
    const readChunkBytes = framesPerChunk * wavLayout.blockAlign;

    const releaseReadBuf = memoryTracker.acquire('fileReadBuffer', readChunkBytes);
    const releaseDecodeBuf = memoryTracker.acquire(
      'decoderBuffer',
      framesPerChunk * (wavLayout.channels + 1) * 4,
    );

    let stereoInspection: StereoChannelInspection;
    let signalHealth: CoreAudioIngestResult['signalHealth'];
    let canonicalExactSampleCount = 0;
    let canonicalSha256 = '';
    const canonicalPartPath = path.join(jobDir, 'canonical_16k_mono.wav.part');
    const canonicalWavFilePath = path.join(jobDir, 'canonical_16k_mono.wav');

    try {
      const readBuf = Buffer.allocUnsafe(readChunkBytes);
      const reusablePlanar: Float32Array[] = Array.from(
        { length: wavLayout.channels },
        () => new Float32Array(framesPerChunk),
      );
      const reusableMono = new Float32Array(framesPerChunk);

      const wavFh = await fs.promises.open(wavTargetFilePath, 'r');
      try {
        // PASS 1: Stream source file to compute exact SHA-256 (if native WAV) and exact L/R phase/RMS stereo inspection
        transition('DECODING');
        const wavHasher = sourceSha256 ? null : crypto.createHash('sha256');
        if (wavHasher) {
          // Hash the header bytes before dataOffsetBytes
          let hPos = 0;
          while (hPos < wavLayout.dataOffsetBytes) {
            checkAbort();
            const toRead = Math.min(readChunkBytes, wavLayout.dataOffsetBytes - hPos);
            const { bytesRead } = await wavFh.read(readBuf, 0, toRead, hPos);
            if (bytesRead <= 0) break;
            wavHasher.update(readBuf.subarray(0, bytesRead));
            hPos += bytesRead;
          }
        }

        let sumSqL = 0;
        let sumSqR = 0;
        let dotLR = 0;
        let framesInspected = 0;
        let dataCursor = 0;

        while (dataCursor < wavLayout.dataByteLength) {
          checkAbort();
          const toRead = Math.min(readChunkBytes, wavLayout.dataByteLength - dataCursor);
          const { bytesRead } = await wavFh.read(
            readBuf,
            0,
            toRead,
            wavLayout.dataOffsetBytes + dataCursor,
          );
          if (bytesRead <= 0) break;
          if (wavHasher) {
            wavHasher.update(readBuf.subarray(0, bytesRead));
          }
          const decodedFrames = decodeWavChunkToPlanar(
            readBuf,
            bytesRead,
            wavLayout,
            reusablePlanar,
          );
          if (wavLayout.channels === 1) {
            const c0 = reusablePlanar[0];
            for (let i = 0; i < decodedFrames; i++) {
              const s = Number.isFinite(c0[i]) ? c0[i] : 0;
              sumSqL += s * s;
            }
          } else {
            const c0 = reusablePlanar[0];
            const c1 = reusablePlanar[1];
            for (let i = 0; i < decodedFrames; i++) {
              const l = Number.isFinite(c0[i]) ? c0[i] : 0;
              const r = Number.isFinite(c1[i]) ? c1[i] : 0;
              sumSqL += l * l;
              sumSqR += r * r;
              dotLR += l * r;
            }
          }
          framesInspected += decodedFrames;
          dataCursor += bytesRead;
        }

        if (wavHasher) {
          // Hash any trailing metadata chunks after the data chunk so sourceSha256 matches full file hash
          const afterDataOffset = wavLayout.dataOffsetBytes + wavLayout.dataByteLength;
          const totalFileBytes = fs.statSync(wavTargetFilePath).size;
          let tPos = afterDataOffset;
          while (tPos < totalFileBytes) {
            checkAbort();
            const toRead = Math.min(readChunkBytes, totalFileBytes - tPos);
            const { bytesRead } = await wavFh.read(readBuf, 0, toRead, tPos);
            if (bytesRead <= 0) break;
            wavHasher.update(readBuf.subarray(0, bytesRead));
            tPos += bytesRead;
          }
          sourceSha256 = wavHasher.digest('hex');
        }

        const rmsL = framesInspected > 0 ? Math.sqrt(sumSqL / framesInspected) : 0;
        const leftDb = rmsL > 1e-6 ? 20 * Math.log10(rmsL) : -120;

        if (wavLayout.channels === 1) {
          stereoInspection = {
            originalChannels: 1,
            policyApplied: 'MONO_PASSTHROUGH',
            leftRmsDb: Number(leftDb.toFixed(2)),
            rightRmsDb: Number(leftDb.toFixed(2)),
            interChannelCorrelation: 1,
            phaseInversionRisk: false,
            silentChannelDetected: leftDb < -75,
            note: 'Single mono channel preserved directly.',
          };
        } else {
          const rmsR = framesInspected > 0 ? Math.sqrt(sumSqR / framesInspected) : 0;
          const rightDb = rmsR > 1e-6 ? 20 * Math.log10(rmsR) : -120;
          const denom = Math.sqrt(sumSqL * sumSqR);
          const corr = denom > 1e-12 ? dotLR / denom : 0;
          const phaseInversionRisk = corr < -0.55;
          const silentLeft = leftDb < -72 && rightDb > -50;
          const silentRight = rightDb < -72 && leftDb > -50;

          if (phaseInversionRisk) {
            stereoInspection = {
              originalChannels: wavLayout.channels,
              policyApplied: 'LEFT_PRIMARY_PHASE_GUARD',
              leftRmsDb: Number(leftDb.toFixed(2)),
              rightRmsDb: Number(rightDb.toFixed(2)),
              interChannelCorrelation: Number(corr.toFixed(3)),
              phaseInversionRisk: true,
              silentChannelDetected: false,
              note: 'Negative L/R correlation detected; kept dominant channel without destructive summing.',
            };
          } else if (silentLeft || silentRight) {
            stereoInspection = {
              originalChannels: wavLayout.channels,
              policyApplied: 'DOMINANT_ACTIVE_CHANNEL',
              leftRmsDb: Number(leftDb.toFixed(2)),
              rightRmsDb: Number(rightDb.toFixed(2)),
              interChannelCorrelation: Number(corr.toFixed(3)),
              phaseInversionRisk: false,
              silentChannelDetected: true,
              note: 'One stereo channel is silent; routed active channel cleanly to prevent -6dB loss.',
            };
          } else {
            stereoInspection = {
              originalChannels: wavLayout.channels,
              policyApplied: 'EQUAL_POWER_AVG',
              leftRmsDb: Number(leftDb.toFixed(2)),
              rightRmsDb: Number(rightDb.toFixed(2)),
              interChannelCorrelation: Number(corr.toFixed(3)),
              phaseInversionRisk: false,
              silentChannelDetected: false,
              note: 'Coherent stereo channels downmixed via equal-amplitude average.',
            };
          }
        }

        // PASS 2: Stream decode -> downmix -> stateful Kaiser-Sinc resample -> write canonical 16kHz Mono PCM16 WAV
        transition('RESAMPLING');
        const resampler = new StreamingKaiserSincResampler(
          wavLayout.sampleRateHz,
          CANONICAL_TARGET_SAMPLE_RATE_HZ,
        );
        const expectedCanonicalSamples = Math.floor(
          wavLayout.exactFrameCount / (wavLayout.sampleRateHz / CANONICAL_TARGET_SAMPLE_RATE_HZ),
        );

        const maxResampledChunkSamples =
          Math.ceil(
            framesPerChunk / (wavLayout.sampleRateHz / CANONICAL_TARGET_SAMPLE_RATE_HZ),
          ) +
          resampler.filterTaps +
          16;

        const releaseResamplerBuf = memoryTracker.acquire(
          'resamplerBuffer',
          maxResampledChunkSamples * 4 + resampler.filterTaps * 256 * 4,
        );
        const releaseOutBuf = memoryTracker.acquire(
          'canonicalOutputBuffer',
          MAX_INGESTION_IO_CHUNK_BYTES,
        );

        let ws: fs.WriteStream | null = null;
        try {
          transition('WRITING_CANONICAL');
          ws = fs.createWriteStream(canonicalPartPath, {
            flags: 'w',
            mode: 0o600,
            highWaterMark: MAX_INGESTION_IO_CHUNK_BYTES,
          });

          const canonicalHasher = crypto.createHash('sha256');
          const writeChunkWithBackpressure = async (buf: Buffer) => {
            if (!ws) throw new Error('Canonical WriteStream closed');
            checkAbort();
            canonicalHasher.update(buf);
            const ok = ws.write(buf);
            if (!ok) {
              memoryTracker.recordDrainWait();
              await once(ws, 'drain');
            }
          };

          const initialHeader = buildCanonical16kMonoWavHeader(expectedCanonicalSamples);
          await writeChunkWithBackpressure(initialHeader);

          // Signal health streaming accumulators
          let healthSum = 0;
          let healthSumSq = 0;
          let healthPeak = 0;
          let healthClipCount = 0;
          let healthSilentCount = 0;
          let winSqAcc = 0;
          let winSampleCount = 0;
          const winEnergies: number[] = [];

          const encodeAndWriteResampledFloat32 = async (samples16k: Float32Array) => {
            if (samples16k.length === 0) return;
            for (let i = 0; i < samples16k.length; i++) {
              const s = Number.isFinite(samples16k[i]) ? samples16k[i] : 0;
              healthSum += s;
              const sq = s * s;
              healthSumSq += sq;
              winSqAcc += sq;
              winSampleCount += 1;
              if (winSampleCount === 320) {
                if (winEnergies.length < 32_768) {
                  winEnergies.push(Math.sqrt(winSqAcc / 320));
                }
                winSqAcc = 0;
                winSampleCount = 0;
              }
              const abs = Math.abs(s);
              if (abs > healthPeak) healthPeak = abs;
              if (abs >= 0.985) healthClipCount += 1;
              if (abs < 0.008) healthSilentCount += 1;
            }

            const pcm16Out = Buffer.allocUnsafe(samples16k.length * 2);
            for (let i = 0; i < samples16k.length; i++) {
              const s = Number.isFinite(samples16k[i]) ? samples16k[i] : 0;
              const clamped = Math.max(-1, Math.min(1, s));
              pcm16Out.writeInt16LE(Math.round(clamped * 32767), i * 2);
            }
            canonicalExactSampleCount += samples16k.length;
            await writeChunkWithBackpressure(pcm16Out);
          };

          let pass2Cursor = 0;
          while (pass2Cursor < wavLayout.dataByteLength) {
            checkAbort();
            const toRead = Math.min(readChunkBytes, wavLayout.dataByteLength - pass2Cursor);
            const { bytesRead } = await wavFh.read(
              readBuf,
              0,
              toRead,
              wavLayout.dataOffsetBytes + pass2Cursor,
            );
            if (bytesRead <= 0) break;
            const decodedFrames = decodeWavChunkToPlanar(
              readBuf,
              bytesRead,
              wavLayout,
              reusablePlanar,
            );
            downmixPlanarChunkWithPolicy(
              reusablePlanar,
              decodedFrames,
              stereoInspection,
              reusableMono,
            );
            const monoSlice = reusableMono.subarray(0, decodedFrames);
            const resampledSlice = resampler.pushChunk(monoSlice);
            await encodeAndWriteResampledFloat32(resampledSlice);
            pass2Cursor += bytesRead;
          }

          const tailSlice = resampler.flush();
          await encodeAndWriteResampledFloat32(tailSlice);

          if (winSampleCount > 0 && winEnergies.length < 32_768) {
            winEnergies.push(Math.sqrt(winSqAcc / winSampleCount));
          }

          await new Promise<void>((resolve, reject) => {
            if (!ws) return resolve();
            ws.once('error', reject);
            ws.end(() => resolve());
          });
          ws = null;

          // If actual sample count differs from initial header estimate, patch the 44-byte RIFF header in place
          if (canonicalExactSampleCount !== expectedCanonicalSamples) {
            const patchedHeader = buildCanonical16kMonoWavHeader(canonicalExactSampleCount);
            const patchFd = fs.openSync(canonicalPartPath, 'r+');
            try {
              fs.writeSync(patchFd, patchedHeader, 0, 44, 0);
            } finally {
              fs.closeSync(patchFd);
            }
          }

          canonicalSha256 = canonicalHasher.digest('hex');

          // Atomic promotion from .part to final canonical_16k_mono.wav (incomplete files never reach READY)
          fs.renameSync(canonicalPartPath, canonicalWavFilePath);

          if (canonicalExactSampleCount === 0) {
            signalHealth = {
              rmsDb: -120,
              peakDb: -120,
              estimatedSnrDb: 0,
              clippingRatio: 0,
              dcOffset: 0,
              silenceRatio: 1,
              isSilent: true,
            };
          } else {
            winEnergies.sort((a, b) => a - b);
            const noiseFloor = winEnergies[Math.floor(winEnergies.length * 0.1)] ?? 1e-4;
            const speechLevel = winEnergies[Math.floor(winEnergies.length * 0.9)] ?? noiseFloor;
            const snrDb =
              noiseFloor > 1e-6
                ? 20 * Math.log10(Math.max(1e-6, speechLevel) / noiseFloor)
                : 45;
            const rms = Math.sqrt(healthSumSq / canonicalExactSampleCount);
            const rmsDb = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
            const peakDb = healthPeak > 1e-6 ? 20 * Math.log10(healthPeak) : -120;
            signalHealth = {
              rmsDb: Number(rmsDb.toFixed(2)),
              peakDb: Number(peakDb.toFixed(2)),
              estimatedSnrDb: Number(Math.max(0, Math.min(80, snrDb)).toFixed(2)),
              clippingRatio: Number((healthClipCount / canonicalExactSampleCount).toFixed(5)),
              dcOffset: Number((healthSum / canonicalExactSampleCount).toFixed(5)),
              silenceRatio: Number((healthSilentCount / canonicalExactSampleCount).toFixed(3)),
              isSilent: rmsDb < -65,
            };
          }
        } finally {
          if (ws) {
            try {
              ws.destroy();
            } catch {
              // ignore
            }
          }
          releaseOutBuf();
          releaseResamplerBuf();
        }
      } finally {
        await wavFh.close().catch(() => {});
      }

      // Clean up intermediate FFmpeg WAV or inline temp input immediately once canonical WAV is ready
      if (wavTargetFilePath !== sourceFilePath) {
        try {
          fs.rmSync(wavTargetFilePath, { force: true });
        } catch {
          // ignore
        }
      }
      if (ownsSourceTempFile) {
        try {
          fs.rmSync(sourceFilePath, { force: true });
        } catch {
          // ignore
        }
      }
    } finally {
      releaseDecodeBuf();
      releaseReadBuf();
    }

    const warnings: string[] = [];
    if (stereoInspection.phaseInversionRisk) {
      warnings.push(
        'Phase inversion risk between L/R channels mitigated via primary-channel guard.',
      );
    }
    if (signalHealth.clippingRatio > 0.01) {
      warnings.push(
        `Clipping ratio elevated (${(signalHealth.clippingRatio * 100).toFixed(2)}%).`,
      );
    }
    if (signalHealth.isSilent) {
      warnings.push('Audio signal RMS is below -65 dBFS (near-silent input).');
    }

    transition('CANONICAL_READY');

    let canonicalReadFh: fs.promises.FileHandle | null = await fs.promises.open(
      canonicalWavFilePath,
      'r',
    );
    let closed = false;

    const ensureOpen = (sig?: AbortSignal): fs.promises.FileHandle => {
      if (sig?.aborted || params.signal?.aborted) {
        throw new Error('TRANSCRIPTION_CANCELLED');
      }
      if (closed || !canonicalReadFh) {
        throw new Error('CANONICAL_AUDIO_SOURCE_CLOSED');
      }
      return canonicalReadFh;
    };

    const sourceHandle: FileBackedCanonicalAudioSource = {
      jobId,
      ownerId,
      sourceFilePath: params.audioFilePath ? path.resolve(params.audioFilePath) : sourceFilename,
      sourceFilename,
      sourceFormat: detectedFormat,
      sourceSampleRateHz: originalSampleRateHz,
      sourceChannels: originalChannels,
      sourceBitsPerSample,
      sourceEncoding,
      sourceExactFrameCount: wavLayout.exactFrameCount,
      sourceSha256,
      canonicalWavFilePath,
      canonicalDataOffsetBytes: 44,
      canonicalSampleRateHz: CANONICAL_TARGET_SAMPLE_RATE_HZ,
      canonicalChannels: 1,
      canonicalExactSampleCount,
      canonicalDurationSec: Number(
        (canonicalExactSampleCount / CANONICAL_TARGET_SAMPLE_RATE_HZ).toFixed(3),
      ),
      canonicalSha256,
      stereoInspection,
      signalHealth,
      warnings,
      memoryTracker,

      getLifecycleState: () => currentState,
      getStateHistory: () => [...stateHistory],

      markInferenceStarted: () => {
        if (!closed && currentState === 'CANONICAL_READY') {
          transition('INFERENCE');
        }
      },

      readCanonicalFloat32Window: async (startSample, endSample, sig) => {
        const fh = ensureOpen(sig);
        return readCanonicalWindowFromHandle(
          fh,
          canonicalExactSampleCount,
          startSample,
          endSample,
          memoryTracker,
          sig ?? params.signal,
        );
      },

      findBestBoundaryValleySampleOnDisk: async (
        nominalSample,
        searchRadiusSamples,
        sig,
      ) => {
        const fh = ensureOpen(sig);
        const safeTarget = Math.max(
          0,
          Math.min(canonicalExactSampleCount, Math.round(nominalSample)),
        );
        const safeRadius = Math.max(0, Math.round(searchRadiusSamples));
        const win = 320; // 20ms @ 16kHz
        const lo = Math.max(win, safeTarget - safeRadius);
        const hi = Math.min(canonicalExactSampleCount - win, safeTarget + safeRadius);
        if (hi <= lo) return safeTarget;

        // Read only the [lo, hi + win) window from disk (~96 KiB for ±1.5s radius)
        const windowEnd = Math.min(canonicalExactSampleCount, hi + win);
        const localFloats = await readCanonicalWindowFromHandle(
          fh,
          canonicalExactSampleCount,
          lo,
          windowEnd,
          memoryTracker,
          sig ?? params.signal,
        );

        let bestSample = safeTarget;
        let bestEnergy = Infinity;

        for (let globalPos = lo; globalPos <= hi; globalPos += 160) {
          const localPos = globalPos - lo;
          let e = 0;
          for (let i = localPos; i < localPos + win && i < localFloats.length; i++) {
            const s = localFloats[i];
            e += s * s;
          }
          if (e < bestEnergy) {
            bestEnergy = e;
            bestSample = globalPos + Math.floor(win / 2);
          }
        }
        return bestSample;
      },

      exportCanonicalChunkWavToFile: async (
        startSample,
        endSample,
        destinationWavPath,
        sig,
      ) => {
        const fh = ensureOpen(sig);
        const clampedStart = Math.max(
          0,
          Math.min(canonicalExactSampleCount, Math.floor(startSample)),
        );
        const clampedEnd = Math.max(
          clampedStart,
          Math.min(canonicalExactSampleCount, Math.floor(endSample)),
        );
        const frameCount = clampedEnd - clampedStart;
        const dataBytes = frameCount * 2;
        const header = buildCanonical16kMonoWavHeader(frameCount);

        const releaseIo = memoryTracker.acquire('fileReadBuffer', MAX_INGESTION_IO_CHUNK_BYTES);
        const outFd = fs.openSync(destinationWavPath, 'w', 0o600);
        try {
          fs.writeSync(outFd, header, 0, 44, 0);
          const copyBuf = Buffer.allocUnsafe(MAX_INGESTION_IO_CHUNK_BYTES);
          let copiedBytes = 0;
          while (copiedBytes < dataBytes) {
            if (sig?.aborted || params.signal?.aborted) {
              throw new Error('TRANSCRIPTION_CANCELLED');
            }
            const toRead = Math.min(copyBuf.byteLength, dataBytes - copiedBytes);
            const { bytesRead } = await fh.read(
              copyBuf,
              0,
              toRead,
              44 + clampedStart * 2 + copiedBytes,
            );
            if (bytesRead <= 0) break;
            fs.writeSync(outFd, copyBuf, 0, bytesRead, 44 + copiedBytes);
            copiedBytes += bytesRead;
          }
          return { frameCount, byteLength: 44 + copiedBytes };
        } finally {
          fs.closeSync(outFd);
          releaseIo();
        }
      },

      close: async (finalState = 'COMPLETED') => {
        if (closed) return;
        closed = true;
        transition(finalState);
        if (canonicalReadFh) {
          const fh = canonicalReadFh;
          canonicalReadFh = null;
          await fh.close().catch(() => {});
        }
        cleanupJobDir();
        transition('CLEANED');
      },
    };

    return sourceHandle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCancel =
      params.signal?.aborted ||
      msg === 'TRANSCRIPTION_CANCELLED' ||
      msg === 'RESAMPLE_ABORTED';
    transition(isCancel ? 'CANCELLED' : 'FAILED');
    cleanupJobDir();
    transition('CLEANED');
    throw err;
  }
}
