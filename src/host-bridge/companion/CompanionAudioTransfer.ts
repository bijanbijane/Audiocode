/**
 * AVAPARDAZ — DETERMINISTIC STREAMING & FILE-BACKED AUDIO TRANSFER ENGINE FOR NATIVE COMPANION
 *
 * Implements AVAPARDAZ Phase 1B (Native Companion Streaming & Memory Foundation):
 * - Eliminates full-file RAM materialization (`fs.readFileSync(sess.tempPath)` / full `Float32Array` / full WAV Buffer)
 * - Explicit audio format metadata (`pcm_f32le`, `pcm_s16le`, `wav`) with exact sample rate, channel count,
 *   frame count, and byte count validation
 * - 10-state transfer lifecycle:
 *   `CREATED -> RECEIVING -> RECEIVED -> VALIDATING -> READY -> PROCESSING -> COMPLETED | CANCELLED | FAILED -> CLEANED`
 * - Strict sequential chunk indexing, duplicate chunk rejection, missing chunk detection, per-chunk & full SHA-256
 * - Backpressure-enforced disk writes (`<= 256 KiB` write buffers waiting on `drain`) and bounded file reads (`<= 256 KiB`)
 * - 7-category Memory Accounting (`transferBuffersBytes`, `fileReadBuffersBytes`, `fileWriteBuffersBytes`,
 *   `decoderBuffersBytes`, `encoderBuffersBytes`, `nativeRuntimeMemoryBytes`, `modelMemoryBytes`) with
 *   per-transfer live buffer ceiling (`<= 1 MiB`)
 * - Security & isolation: 128-bit `transferId`, `0o600` temp file mode, root-confined `stagingDir` with symlink
 *   and `..` traversal rejection, session/owner isolation (`ownerId`), concurrent transfer limit,
 *   total temp directory quota (`maxTotalStagingBytes`), TTL sweep, and startup orphan file cleanup
 * - File-backed `CompanionAudioSource` with `readRange`, `readPlanarChannels` (preserving 100% channel separation),
 *   streaming disk-to-disk WAV preparation (`prepareWavFileStreaming` with RIFF/RF64 header awareness),
 *   `AbortSignal` support, and consumer-gated `close()` lifecycle cleanup
 */

import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CompanionAudioTransferFormat = 'pcm_f32le' | 'pcm_s16le' | 'wav';

export type CompanionTransferLifecycleState =
  | 'CREATED'
  | 'RECEIVING'
  | 'RECEIVED'
  | 'VALIDATING'
  | 'READY'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'CLEANED';

export const MAX_NETWORK_CHUNK_BYTES = 256 * 1024; // 256 KiB
export const MAX_FILE_READ_BUFFER_BYTES = 256 * 1024; // 256 KiB
export const MAX_FILE_WRITE_BUFFER_BYTES = 256 * 1024; // 256 KiB
export const MAX_TOTAL_LIVE_BUFFERS_PER_TRANSFER_BYTES = 1024 * 1024; // 1 MiB

export type CompanionBufferCategory =
  | 'transferBuffers'
  | 'fileReadBuffers'
  | 'fileWriteBuffers'
  | 'decoderBuffers'
  | 'encoderBuffers'
  | 'nativeRuntimeMemory'
  | 'modelMemory';

export interface CompanionMemoryAccountingSnapshot {
  readonly transferBuffersBytes: number;
  readonly fileReadBuffersBytes: number;
  readonly fileWriteBuffersBytes: number;
  readonly decoderBuffersBytes: number;
  readonly encoderBuffersBytes: number;
  readonly nativeRuntimeMemoryBytes: number;
  readonly modelMemoryBytes: number;
  readonly peakTransferBuffersBytes: number;
  readonly peakFileReadBuffersBytes: number;
  readonly peakFileWriteBuffersBytes: number;
  readonly peakDecoderBuffersBytes: number;
  readonly peakEncoderBuffersBytes: number;
  readonly peakNativeRuntimeMemoryBytes: number;
  readonly peakModelMemoryBytes: number;
  readonly peakTotalLiveBuffersPerTransferBytes: number;
  readonly backpressureDrainWaitCount: number;
}

export class CompanionTransferMemoryAccountant {
  private current: Record<CompanionBufferCategory, number> = {
    transferBuffers: 0,
    fileReadBuffers: 0,
    fileWriteBuffers: 0,
    decoderBuffers: 0,
    encoderBuffers: 0,
    nativeRuntimeMemory: 0,
    modelMemory: 0,
  };

  private peaks: Record<CompanionBufferCategory, number> = {
    transferBuffers: 0,
    fileReadBuffers: 0,
    fileWriteBuffers: 0,
    decoderBuffers: 0,
    encoderBuffers: 0,
    nativeRuntimeMemory: 0,
    modelMemory: 0,
  };

  private perTransferLiveBytes = new Map<string, number>();
  private peakPerTransferLiveBytes = 0;
  private drainWaitCount = 0;

  public acquire(
    category: CompanionBufferCategory,
    bytes: number,
    transferId?: string,
  ): () => void {
    const safeBytes = Math.max(0, Math.floor(bytes));
    if (
      (category === 'transferBuffers' ||
        category === 'fileReadBuffers' ||
        category === 'fileWriteBuffers') &&
      safeBytes > MAX_NETWORK_CHUNK_BYTES
    ) {
      throw new Error(
        `BUFFER_POLICY_VIOLATION: ${category} allocation (${safeBytes} bytes) exceeds 256 KiB limit (${MAX_NETWORK_CHUNK_BYTES}).`,
      );
    }

    if (transferId) {
      const nextTransferTotal = (this.perTransferLiveBytes.get(transferId) ?? 0) + safeBytes;
      if (nextTransferTotal > MAX_TOTAL_LIVE_BUFFERS_PER_TRANSFER_BYTES) {
        throw new Error(
          `TRANSFER_LIVE_BUFFER_LIMIT_EXCEEDED: transfer ${transferId} live buffers (${nextTransferTotal} bytes) exceed 1 MiB ceiling.`,
        );
      }
      this.perTransferLiveBytes.set(transferId, nextTransferTotal);
      if (nextTransferTotal > this.peakPerTransferLiveBytes) {
        this.peakPerTransferLiveBytes = nextTransferTotal;
      }
    }

    this.current[category] += safeBytes;
    if (this.current[category] > this.peaks[category]) {
      this.peaks[category] = this.current[category];
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.current[category] = Math.max(0, this.current[category] - safeBytes);
      if (transferId) {
        const cur = this.perTransferLiveBytes.get(transferId) ?? 0;
        const next = Math.max(0, cur - safeBytes);
        if (next === 0) {
          this.perTransferLiveBytes.delete(transferId);
        } else {
          this.perTransferLiveBytes.set(transferId, next);
        }
      }
    };
  }

  public recordBackpressureDrainWait(): void {
    this.drainWaitCount += 1;
  }

  public setExternalMetric(
    category: 'nativeRuntimeMemory' | 'modelMemory',
    bytes: number,
  ): void {
    const safeBytes = Math.max(0, Math.floor(bytes));
    this.current[category] = safeBytes;
    if (safeBytes > this.peaks[category]) {
      this.peaks[category] = safeBytes;
    }
  }

  public getTransferLiveBytes(transferId: string): number {
    return this.perTransferLiveBytes.get(transferId) ?? 0;
  }

  public getSnapshot(): CompanionMemoryAccountingSnapshot {
    return {
      transferBuffersBytes: this.current.transferBuffers,
      fileReadBuffersBytes: this.current.fileReadBuffers,
      fileWriteBuffersBytes: this.current.fileWriteBuffers,
      decoderBuffersBytes: this.current.decoderBuffers,
      encoderBuffersBytes: this.current.encoderBuffers,
      nativeRuntimeMemoryBytes: this.current.nativeRuntimeMemory,
      modelMemoryBytes: this.current.modelMemory,
      peakTransferBuffersBytes: this.peaks.transferBuffers,
      peakFileReadBuffersBytes: this.peaks.fileReadBuffers,
      peakFileWriteBuffersBytes: this.peaks.fileWriteBuffers,
      peakDecoderBuffersBytes: this.peaks.decoderBuffers,
      peakEncoderBuffersBytes: this.peaks.encoderBuffers,
      peakNativeRuntimeMemoryBytes: this.peaks.nativeRuntimeMemory,
      peakModelMemoryBytes: this.peaks.modelMemory,
      peakTotalLiveBuffersPerTransferBytes: this.peakPerTransferLiveBytes,
      backpressureDrainWaitCount: this.drainWaitCount,
    };
  }
}

export interface CompanionAudioTransferInitRequest {
  readonly filename?: string;
  readonly format: CompanionAudioTransferFormat;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly endianness: 'little';
  readonly expectedBytes: number;
  readonly expectedFrames: number;
  readonly totalChunks: number;
  readonly expectedSha256?: string;
  readonly ownerId: string;
}

export interface CompanionAudioTransferChunkRequest {
  readonly transferId: string;
  readonly chunkIndex: number;
  readonly chunkBase64?: string;
  readonly chunkBytes?: Buffer;
  readonly chunkSha256?: string;
  readonly ownerId: string;
}

export interface FinalizedAudioTransfer {
  readonly transferId: string;
  readonly filename: string;
  readonly format: CompanionAudioTransferFormat;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly expectedFrames: number;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface WavHeaderMetadata {
  readonly valid: boolean;
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitsPerSample: number;
  readonly dataOffsetBytes: number;
  readonly dataByteLength: number;
  readonly frameCount: number;
  readonly isRf64: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface CompanionAudioSource {
  readonly transferId: string;
  readonly ownerId: string;
  readonly filename: string;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly exactSampleCount: number;
  readonly totalSampleValues: number;
  readonly format: CompanionAudioTransferFormat;
  readonly maxRangeSamples: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly tempFilePath: string;
  getLifecycleState(): CompanionTransferLifecycleState;
  getStateHistory(): readonly CompanionTransferLifecycleState[];
  readRange(startSample: number, sampleCount: number, signal?: AbortSignal): Promise<Float32Array>;
  readPlanarChannels(
    startFrame: number,
    frameCount: number,
    signal?: AbortSignal,
  ): Promise<readonly Float32Array[]>;
  prepareWavFileStreaming(options?: {
    readonly signal?: AbortSignal;
    readonly writeHighWaterMarkBytes?: number;
    readonly onChunkWritten?: (writtenBytes: number, totalBytes: number) => Promise<void> | void;
  }): Promise<{
    readonly wavFilePath: string;
    readonly totalWavBytes: number;
    readonly isRf64: boolean;
    readonly drainWaits: number;
  }>;
  close(finalState?: 'COMPLETED' | 'CANCELLED' | 'FAILED'): Promise<void>;
}

interface ActiveAudioTransferSession {
  readonly transferId: string;
  readonly ownerId: string;
  readonly filename: string;
  readonly format: CompanionAudioTransferFormat;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly expectedBytes: number;
  readonly expectedFrames: number;
  readonly totalChunks: number;
  readonly expectedSha256?: string;
  readonly tempPath: string;
  preparedWavPath?: string;
  readonly createdAtMs: number;
  updatedAtMs: number;
  readonly hasher: crypto.Hash;
  writeFd: number | null;
  nextChunkIndex: number;
  receivedBytes: number;
  reservedQuotaBytes: number;
  finalized: boolean;
  finalSha256?: string;
  wavHeader?: WavHeaderMetadata;
  state: CompanionTransferLifecycleState;
  readonly stateHistory: CompanionTransferLifecycleState[];
  activeAbortControllers: Set<AbortController>;
  activeFileHandles: Set<fs.promises.FileHandle>;
}

const ALLOWED_FORMATS = new Set<CompanionAudioTransferFormat>(['pcm_f32le', 'pcm_s16le', 'wav']);

/**
 * Parses and validates a WAV (RIFF or RF64) header from a bounded initial buffer (<= 4096 bytes).
 * Never requires reading the entire audio file into memory.
 */
export function parseWavHeaderFromInitialBytes(
  headerBuf: Buffer,
  totalFileSizeBytes: number,
): WavHeaderMetadata {
  if (headerBuf.byteLength < 44) {
    return {
      valid: false,
      audioFormat: 0,
      channels: 0,
      sampleRateHz: 0,
      bitsPerSample: 0,
      dataOffsetBytes: 0,
      dataByteLength: 0,
      frameCount: 0,
      isRf64: false,
      errorCode: 'INVALID_WAV_HEADER',
      errorMessage: 'WAV file is smaller than 44-byte minimum RIFF header.',
    };
  }

  const magic = headerBuf.toString('ascii', 0, 4);
  const waveTag = headerBuf.toString('ascii', 8, 12);
  if ((magic !== 'RIFF' && magic !== 'RF64') || waveTag !== 'WAVE') {
    return {
      valid: false,
      audioFormat: 0,
      channels: 0,
      sampleRateHz: 0,
      bitsPerSample: 0,
      dataOffsetBytes: 0,
      dataByteLength: 0,
      frameCount: 0,
      isRf64: false,
      errorCode: 'INVALID_WAV_HEADER',
      errorMessage: 'Missing RIFF/RF64 or WAVE signature.',
    };
  }

  const isRf64 = magic === 'RF64';
  let rf64DataSize: number | null = null;
  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let bitsPerSample = 0;
  let fmtFound = false;
  let dataOffsetBytes = -1;
  let dataByteLength = 0;

  let offset = 12;
  while (offset + 8 <= headerBuf.byteLength) {
    const chunkId = headerBuf.toString('ascii', offset, offset + 4);
    const chunkSize = headerBuf.readUInt32LE(offset + 4);
    const chunkPayloadOffset = offset + 8;

    if (chunkId === 'ds64' && chunkPayloadOffset + 28 <= headerBuf.byteLength) {
      const low = headerBuf.readUInt32LE(chunkPayloadOffset + 8);
      const high = headerBuf.readUInt32LE(chunkPayloadOffset + 12);
      rf64DataSize = high * 0x100000000 + low;
    } else if (chunkId === 'fmt ') {
      if (chunkSize < 16 || chunkPayloadOffset + 16 > headerBuf.byteLength) {
        return {
          valid: false,
          audioFormat: 0,
          channels: 0,
          sampleRateHz: 0,
          bitsPerSample: 0,
          dataOffsetBytes: 0,
          dataByteLength: 0,
          frameCount: 0,
          isRf64,
          errorCode: 'INVALID_WAV_FMT_CHUNK',
          errorMessage: 'Corrupt or truncated WAV fmt chunk.',
        };
      }
      audioFormat = headerBuf.readUInt16LE(chunkPayloadOffset);
      channels = headerBuf.readUInt16LE(chunkPayloadOffset + 2);
      sampleRateHz = headerBuf.readUInt32LE(chunkPayloadOffset + 4);
      bitsPerSample = headerBuf.readUInt16LE(chunkPayloadOffset + 14);
      fmtFound = true;
    } else if (chunkId === 'data') {
      dataOffsetBytes = chunkPayloadOffset;
      dataByteLength =
        isRf64 && chunkSize === 0xffffffff && rf64DataSize !== null
          ? rf64DataSize
          : chunkSize;
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    if (paddedSize < 0 || chunkPayloadOffset + paddedSize <= offset) {
      break;
    }
    offset = chunkPayloadOffset + paddedSize;
  }

  if (!fmtFound || dataOffsetBytes < 0) {
    return {
      valid: false,
      audioFormat,
      channels,
      sampleRateHz,
      bitsPerSample,
      dataOffsetBytes: 0,
      dataByteLength: 0,
      frameCount: 0,
      isRf64,
      errorCode: 'INVALID_WAV_STRUCTURE',
      errorMessage: 'WAV header missing fmt or data chunk within initial header window.',
    };
  }

  if (audioFormat !== 1 && audioFormat !== 3) {
    return {
      valid: false,
      audioFormat,
      channels,
      sampleRateHz,
      bitsPerSample,
      dataOffsetBytes,
      dataByteLength,
      frameCount: 0,
      isRf64,
      errorCode: 'UNSUPPORTED_WAV_ENCODING',
      errorMessage: `Unsupported WAV audioFormat (${audioFormat}); only PCM (1) or IEEE Float (3) supported.`,
    };
  }

  if (
    channels < 1 ||
    channels > 8 ||
    sampleRateHz < 8000 ||
    sampleRateHz > 192000 ||
    (bitsPerSample !== 16 && bitsPerSample !== 32)
  ) {
    return {
      valid: false,
      audioFormat,
      channels,
      sampleRateHz,
      bitsPerSample,
      dataOffsetBytes,
      dataByteLength,
      frameCount: 0,
      isRf64,
      errorCode: 'INVALID_WAV_PARAMETERS',
      errorMessage: `Invalid WAV parameters (channels=${channels}, sampleRate=${sampleRateHz}, bits=${bitsPerSample}).`,
    };
  }

  const availableDataBytes = totalFileSizeBytes - dataOffsetBytes;
  if (availableDataBytes <= 0 || dataByteLength <= 0 || dataByteLength > availableDataBytes) {
    return {
      valid: false,
      audioFormat,
      channels,
      sampleRateHz,
      bitsPerSample,
      dataOffsetBytes,
      dataByteLength,
      frameCount: 0,
      isRf64,
      errorCode: 'TRUNCATED_WAV_DATA',
      errorMessage: `WAV data chunk (${dataByteLength} bytes) exceeds available file bytes (${availableDataBytes}).`,
    };
  }

  const bytesPerFrame = channels * (bitsPerSample / 8);
  const frameCount = Math.floor(dataByteLength / bytesPerFrame);

  return {
    valid: true,
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    dataOffsetBytes,
    dataByteLength,
    frameCount,
    isRf64,
  };
}

/**
 * Builds either a standard 44-byte RIFF/WAVE header or an 80-byte RF64/WAVE header
 * when dataSize exceeds 32-bit RIFF limits (> 4 GiB - 36 bytes).
 */
export function buildStreamingWavHeader(params: {
  readonly dataByteLength: number;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bitsPerSample?: 16;
}): { readonly header: Buffer; readonly isRf64: boolean } {
  const bitsPerSample = params.bitsPerSample ?? 16;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = params.sampleRateHz * params.channels * bytesPerSample;
  const blockAlign = params.channels * bytesPerSample;
  const dataSize = params.dataByteLength;

  if (dataSize + 36 > 0xffffffff) {
    // 80-byte RF64 header (12-byte RF64 + 36-byte ds64 + 24-byte fmt + 8-byte data)
    const buf = Buffer.alloc(80);
    const riffSize64 = BigInt(72) + BigInt(dataSize);
    const dataSize64 = BigInt(dataSize);
    const sampleCount64 = BigInt(Math.floor(dataSize / blockAlign));

    buf.write('RF64', 0);
    buf.writeUInt32LE(0xffffffff, 4);
    buf.write('WAVE', 8);
    buf.write('ds64', 12);
    buf.writeUInt32LE(28, 16);
    buf.writeBigUInt64LE(riffSize64, 20);
    buf.writeBigUInt64LE(dataSize64, 28);
    buf.writeBigUInt64LE(sampleCount64, 36);
    buf.writeUInt32LE(0, 44); // tableLength = 0

    buf.write('fmt ', 48);
    buf.writeUInt32LE(16, 52);
    buf.writeUInt16LE(1, 56);
    buf.writeUInt16LE(params.channels, 58);
    buf.writeUInt32LE(params.sampleRateHz, 60);
    buf.writeUInt32LE(byteRate, 64);
    buf.writeUInt16LE(blockAlign, 68);
    buf.writeUInt16LE(bitsPerSample, 70);

    buf.write('data', 72);
    buf.writeUInt32LE(0xffffffff, 76);
    return { header: buf, isRf64: true };
  }

  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(params.channels, 22);
  buf.writeUInt32LE(params.sampleRateHz, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return { header: buf, isRf64: false };
}

export function encodePcmFloat32ToWav(samples: Float32Array, sampleRateHz: number, channels: number): Buffer {
  const numFrames = Math.floor(samples.length / channels);
  const bytesPerSample = 2;
  const dataSize = numFrames * channels * bytesPerSample;
  if (dataSize > MAX_FILE_WRITE_BUFFER_BYTES) {
    throw new Error(
      `FULL_FILE_MATERIALIZATION_FORBIDDEN: encodePcmFloat32ToWav called with ${dataSize} bytes (> 256 KiB). Use CompanionAudioSource.prepareWavFileStreaming instead.`,
    );
  }
  const { header } = buildStreamingWavHeader({
    dataByteLength: dataSize,
    sampleRateHz,
    channels,
  });
  const buf = Buffer.alloc(header.byteLength + dataSize);
  header.copy(buf, 0);
  const hLen = header.byteLength;
  for (let i = 0; i < numFrames * channels; i++) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buf.writeInt16LE(int16, hLen + i * 2);
  }
  return buf;
}

export function encodePcmInt16ToWav(pcmBytes: Buffer, sampleRateHz: number, channels: number): Buffer {
  const dataSize = pcmBytes.byteLength - (pcmBytes.byteLength % (channels * 2));
  if (dataSize > MAX_FILE_WRITE_BUFFER_BYTES) {
    throw new Error(
      `FULL_FILE_MATERIALIZATION_FORBIDDEN: encodePcmInt16ToWav called with ${dataSize} bytes (> 256 KiB). Use CompanionAudioSource.prepareWavFileStreaming instead.`,
    );
  }
  const { header } = buildStreamingWavHeader({
    dataByteLength: dataSize,
    sampleRateHz,
    channels,
  });
  const buf = Buffer.alloc(header.byteLength + dataSize);
  header.copy(buf, 0);
  pcmBytes.copy(buf, header.byteLength, 0, dataSize);
  return buf;
}

export class CompanionAudioTransferManager {
  private readonly sessions = new Map<string, ActiveAudioTransferSession>();
  private readonly closedHistory = new Map<
    string,
    {
      readonly state: CompanionTransferLifecycleState;
      readonly stateHistory: readonly CompanionTransferLifecycleState[];
      readonly ownerId: string;
    }
  >();
  private readonly stagingDir: string;
  private readonly maxTransferBytes: number;
  private readonly maxTotalStagingBytes: number;
  private readonly maxConcurrentTransfers: number;
  private readonly ttlMs: number;
  private totalReservedStagingBytes = 0;
  private orphanedFilesCleanedOnStartup = 0;
  public readonly memoryAccountant = new CompanionTransferMemoryAccountant();

  constructor(options?: {
    readonly stagingDir?: string;
    readonly maxTransferBytes?: number;
    readonly maxTotalStagingBytes?: number;
    readonly maxConcurrentTransfers?: number;
    readonly ttlMs?: number;
    readonly cleanupOrphansOnStartup?: boolean;
  }) {
    this.stagingDir = path.resolve(
      options?.stagingDir ?? path.join(os.tmpdir(), 'avapardaz-companion-transfers'),
    );
    this.maxTransferBytes = options?.maxTransferBytes ?? 512 * 1024 * 1024; // 512 MiB per transfer
    this.maxTotalStagingBytes = options?.maxTotalStagingBytes ?? 1024 * 1024 * 1024; // 1 GiB total staging quota
    this.maxConcurrentTransfers = Math.max(1, options?.maxConcurrentTransfers ?? 4);
    this.ttlMs = options?.ttlMs ?? 15 * 60 * 1000;

    if (options?.cleanupOrphansOnStartup !== false) {
      this.orphanedFilesCleanedOnStartup = this.cleanupOrphanedFilesOnStartup();
    }
  }

  public getStagingDir(): string {
    return this.stagingDir;
  }

  public getMemoryAccounting(): CompanionMemoryAccountingSnapshot {
    return this.memoryAccountant.getSnapshot();
  }

  public getTotalReservedStagingBytes(): number {
    return this.totalReservedStagingBytes;
  }

  public getOrphanedFilesCleanedOnStartup(): number {
    return this.orphanedFilesCleanedOnStartup;
  }

  private ensureSecureStagingDirectory(): void {
    fs.mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    const lstat = fs.lstatSync(this.stagingDir);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
      throw new Error('STAGING_DIR_UNSAFE: Companion stagingDir must be a real directory, not a symlink.');
    }
  }

  private resolveConfinedStagingFilePath(fileName: string): string {
    if (
      !fileName ||
      fileName.includes('\0') ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..')
    ) {
      throw new Error('PATH_CONFINEMENT_VIOLATION: Invalid transfer staging filename.');
    }
    this.ensureSecureStagingDirectory();
    const realRoot = fs.realpathSync(this.stagingDir);
    const candidate = path.resolve(realRoot, fileName);
    const rel = path.relative(realRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('PATH_CONFINEMENT_VIOLATION: Staging file escaped stagingDir root.');
    }
    return candidate;
  }

  /**
   * Detects and removes orphaned temporary transfer files (`xfr_*.part`, `xfr_*.wav`)
   * left behind by an abnormal Companion crash or restart.
   */
  public cleanupOrphanedFilesOnStartup(): number {
    if (!fs.existsSync(this.stagingDir)) return 0;
    let cleaned = 0;
    try {
      const lstat = fs.lstatSync(this.stagingDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) return 0;
      const entries = fs.readdirSync(this.stagingDir);
      for (const entryName of entries) {
        if (!/^xfr_[a-f0-9]{16,32}\.(part|prepared\.wav|wav)$/i.test(entryName)) {
          continue;
        }
        const transferIdMatch = entryName.match(/^(xfr_[a-f0-9]{16,32})\./i);
        const transferId = transferIdMatch ? transferIdMatch[1] : '';
        if (transferId && this.sessions.has(transferId)) {
          continue;
        }
        const fullPath = path.resolve(this.stagingDir, entryName);
        const rel = path.relative(this.stagingDir, fullPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        try {
          fs.rmSync(fullPath, { force: true });
          cleaned += 1;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore if directory doesn't exist yet
    }
    return cleaned;
  }

  private transitionState(
    sess: ActiveAudioTransferSession,
    nextState: CompanionTransferLifecycleState,
  ): void {
    if (sess.state !== nextState) {
      sess.state = nextState;
      sess.stateHistory.push(nextState);
      sess.updatedAtMs = Date.now();
    }
  }

  public getTransferLifecycleState(
    transferId: string,
    ownerId: string,
  ): CompanionTransferLifecycleState | null {
    const active = this.sessions.get(transferId);
    if (active) {
      return this.validateOwner(active, ownerId).ok ? active.state : null;
    }
    const closed = this.closedHistory.get(transferId);
    if (
      !closed ||
      typeof ownerId !== 'string' ||
      ownerId.trim().length === 0 ||
      ownerId.trim() !== closed.ownerId
    ) {
      return null;
    }
    return closed.state;
  }

  public getTransferStateHistory(
    transferId: string,
    ownerId: string,
  ): readonly CompanionTransferLifecycleState[] {
    const active = this.sessions.get(transferId);
    if (active) {
      return this.validateOwner(active, ownerId).ok ? [...active.stateHistory] : [];
    }
    const closed = this.closedHistory.get(transferId);
    if (
      !closed ||
      typeof ownerId !== 'string' ||
      ownerId.trim().length === 0 ||
      ownerId.trim() !== closed.ownerId
    ) {
      return [];
    }
    return [...closed.stateHistory];
  }

  public sweepExpired(nowMs = Date.now()): number {
    let removed = 0;
    for (const [id, sess] of this.sessions.entries()) {
      // Never delete a transfer while a consumer is actively PROCESSING it unless it also timed out beyond 4x TTL
      const effectiveTtl = sess.state === 'PROCESSING' ? this.ttlMs * 4 : this.ttlMs;
      if (nowMs - sess.updatedAtMs > effectiveTtl) {
        this.transitionState(sess, 'FAILED');
        this.cleanupSession(id, sess);
        removed++;
      }
    }
    return removed;
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private closeWriteFd(sess: ActiveAudioTransferSession): void {
    if (sess.writeFd !== null) {
      const fd = sess.writeFd;
      sess.writeFd = null;
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  private cleanupSession(
    transferId: string,
    sess?: ActiveAudioTransferSession,
    terminalBeforeClean?: 'COMPLETED' | 'CANCELLED' | 'FAILED',
  ): void {
    const target = sess ?? this.sessions.get(transferId);
    this.sessions.delete(transferId);
    if (!target) return;

    if (terminalBeforeClean && target.state !== terminalBeforeClean) {
      this.transitionState(target, terminalBeforeClean);
    }

    for (const controller of target.activeAbortControllers) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    target.activeAbortControllers.clear();

    for (const fh of target.activeFileHandles) {
      fh.close().catch(() => {});
    }
    target.activeFileHandles.clear();

    this.closeWriteFd(target);

    if (target.reservedQuotaBytes > 0) {
      this.totalReservedStagingBytes = Math.max(
        0,
        this.totalReservedStagingBytes - target.reservedQuotaBytes,
      );
      target.reservedQuotaBytes = 0;
    }

    try {
      fs.rmSync(target.tempPath, { force: true });
    } catch {
      // ignore race
    }
    if (target.preparedWavPath) {
      try {
        fs.rmSync(target.preparedWavPath, { force: true });
      } catch {
        // ignore race
      }
    }

    this.transitionState(target, 'CLEANED');
    this.closedHistory.set(transferId, {
      state: target.state,
      stateHistory: [...target.stateHistory],
      ownerId: target.ownerId,
    });
    if (this.closedHistory.size > 256) {
      const oldest = this.closedHistory.keys().next().value;
      if (oldest) this.closedHistory.delete(oldest);
    }
  }

  public initTransfer(req: CompanionAudioTransferInitRequest): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly transferId?: string;
    readonly state?: CompanionTransferLifecycleState;
    readonly code?: string;
    readonly message?: string;
  } {
    this.sweepExpired();

    if (typeof req.ownerId !== 'string' || req.ownerId.trim().length === 0) {
      return { ok: false, statusCode: 403, code: 'TRANSFER_OWNER_REQUIRED', message: 'A non-empty ownerId is required to initialize an audio transfer.' };
    }

    if (!ALLOWED_FORMATS.has(req.format)) {
      return {
        ok: false,
        statusCode: 400,
        code: 'UNSUPPORTED_AUDIO_FORMAT',
        message: `Unsupported transfer format "${String(req.format)}".`,
      };
    }
    if (req.endianness !== 'little') {
      return {
        ok: false,
        statusCode: 400,
        code: 'UNSUPPORTED_ENDIANNESS',
        message: 'Only little-endian PCM transfers are supported.',
      };
    }
    if (!Number.isInteger(req.sampleRateHz) || req.sampleRateHz < 8000 || req.sampleRateHz > 192000) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_SAMPLE_RATE',
        message: 'sampleRateHz must be an integer between 8000 and 192000.',
      };
    }
    if (!Number.isInteger(req.channels) || req.channels < 1 || req.channels > 8) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_CHANNEL_COUNT',
        message: 'channels must be an integer between 1 and 8.',
      };
    }
    if (!Number.isInteger(req.expectedBytes) || req.expectedBytes <= 0 || req.expectedBytes > this.maxTransferBytes) {
      return {
        ok: false,
        statusCode: req.expectedBytes > this.maxTransferBytes ? 413 : 400,
        code: 'INVALID_TRANSFER_SIZE',
        message: `expectedBytes must be between 1 and ${this.maxTransferBytes}.`,
      };
    }
    if (!Number.isInteger(req.expectedFrames) || req.expectedFrames <= 0) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_FRAME_COUNT',
        message: 'expectedFrames must be a positive integer.',
      };
    }
    if (!Number.isInteger(req.totalChunks) || req.totalChunks < 1 || req.totalChunks > 100_000) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_CHUNK_COUNT',
        message: 'totalChunks must be between 1 and 100000.',
      };
    }

    if (req.format === 'pcm_f32le' && req.expectedBytes !== req.expectedFrames * req.channels * 4) {
      return {
        ok: false,
        statusCode: 400,
        code: 'AUDIO_METADATA_MISMATCH',
        message: 'expectedBytes does not match expectedFrames * channels * 4 for pcm_f32le.',
      };
    }
    if (req.format === 'pcm_s16le' && req.expectedBytes !== req.expectedFrames * req.channels * 2) {
      return {
        ok: false,
        statusCode: 400,
        code: 'AUDIO_METADATA_MISMATCH',
        message: 'expectedBytes does not match expectedFrames * channels * 2 for pcm_s16le.',
      };
    }

    if (req.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(req.expectedSha256)) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_SHA256',
        message: 'expectedSha256 must be a 64-character hex digest.',
      };
    }

    if (this.sessions.size >= this.maxConcurrentTransfers) {
      return {
        ok: false,
        statusCode: 429,
        code: 'TRANSFER_CONCURRENCY_LIMIT_EXCEEDED',
        message: `Maximum concurrent audio transfers (${this.maxConcurrentTransfers}) reached.`,
      };
    }

    if (this.totalReservedStagingBytes + req.expectedBytes > this.maxTotalStagingBytes) {
      return {
        ok: false,
        statusCode: 507,
        code: 'TEMP_STORAGE_QUOTA_EXCEEDED',
        message: `Temp storage quota exceeded (${this.totalReservedStagingBytes + req.expectedBytes} > ${this.maxTotalStagingBytes} bytes).`,
      };
    }

    const transferId = `xfr_${crypto.randomBytes(16).toString('hex')}`;
    const ownerId = req.ownerId.trim();
    const safeName =
      typeof req.filename === 'string' && req.filename.trim().length > 0
        ? path.basename(req.filename.trim()).replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_')
        : `transfer.${req.format === 'wav' ? 'wav' : 'pcm'}`;

    let tempPath: string;
    let writeFd: number;
    try {
      tempPath = this.resolveConfinedStagingFilePath(`${transferId}.part`);
      writeFd = fs.openSync(tempPath, 'wx', 0o600);
    } catch (err) {
      return {
        ok: false,
        statusCode: 500,
        code: 'TRANSFER_STAGING_OPEN_FAILED',
        message: err instanceof Error ? err.message : 'Failed to create confined transfer temp file.',
      };
    }

    this.totalReservedStagingBytes += req.expectedBytes;
    const nowMs = Date.now();
    const session: ActiveAudioTransferSession = {
      transferId,
      ownerId,
      filename: safeName,
      format: req.format,
      sampleRateHz: req.sampleRateHz,
      channels: req.channels,
      expectedBytes: req.expectedBytes,
      expectedFrames: req.expectedFrames,
      totalChunks: req.totalChunks,
      expectedSha256: req.expectedSha256?.toLowerCase(),
      tempPath,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      hasher: crypto.createHash('sha256'),
      writeFd,
      nextChunkIndex: 0,
      receivedBytes: 0,
      reservedQuotaBytes: req.expectedBytes,
      finalized: false,
      state: 'CREATED',
      stateHistory: ['CREATED'],
      activeAbortControllers: new Set(),
      activeFileHandles: new Set(),
    };

    this.sessions.set(transferId, session);
    return { ok: true, statusCode: 200, transferId, state: session.state };
  }

  private validateOwner(
    sess: ActiveAudioTransferSession,
    ownerId: string,
  ): { readonly ok: boolean; readonly statusCode: number; readonly code?: string; readonly message?: string } {
    if (typeof ownerId !== 'string' || ownerId.trim().length === 0 || ownerId.trim() !== sess.ownerId) {
      return {
        ok: false,
        statusCode: 403,
        code: 'TRANSFER_OWNER_MISMATCH',
        message: 'Access denied: transfer belongs to a different session/owner.',
      };
    }
    return { ok: true, statusCode: 200 };
  }

  private prepareAndValidateChunk(req: CompanionAudioTransferChunkRequest): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly sess?: ActiveAudioTransferSession;
    readonly bytes?: Buffer;
    readonly code?: string;
    readonly message?: string;
  } {
    this.sweepExpired();
    const sess = this.sessions.get(req.transferId);
    if (!sess) {
      return {
        ok: false,
        statusCode: 404,
        code: 'TRANSFER_NOT_FOUND',
        message: 'Unknown or expired transferId.',
      };
    }
    const ownerCheck = this.validateOwner(sess, req.ownerId);
    if (!ownerCheck.ok) return ownerCheck;

    if (sess.finalized || (sess.state !== 'CREATED' && sess.state !== 'RECEIVING')) {
      return {
        ok: false,
        statusCode: 409,
        code: 'TRANSFER_ALREADY_FINALIZED',
        message: `Audio transfer cannot accept chunks in state ${sess.state}.`,
      };
    }
    if (!Number.isInteger(req.chunkIndex) || req.chunkIndex < 0 || req.chunkIndex >= sess.totalChunks) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_CHUNK_INDEX',
        message: `chunkIndex ${req.chunkIndex} is out of bounds.`,
      };
    }
    if (req.chunkIndex < sess.nextChunkIndex) {
      return {
        ok: false,
        statusCode: 409,
        code: 'DUPLICATE_CHUNK_REJECTED',
        message: `Duplicate chunkIndex ${req.chunkIndex} rejected.`,
      };
    }
    if (req.chunkIndex > sess.nextChunkIndex) {
      return {
        ok: false,
        statusCode: 409,
        code: 'OUT_OF_ORDER_CHUNK_REJECTED',
        message: `Out-of-order chunkIndex ${req.chunkIndex} (expected ${sess.nextChunkIndex}).`,
      };
    }

    let bytes: Buffer;
    if (req.chunkBytes !== undefined) {
      bytes = req.chunkBytes;
    } else if (typeof req.chunkBase64 === 'string' && req.chunkBase64.length > 0) {
      // Check encoded length before allocating > 256 KiB
      const estimatedDecodedBytes = Math.floor((req.chunkBase64.length * 3) / 4);
      if (estimatedDecodedBytes > MAX_NETWORK_CHUNK_BYTES + 4) {
        return {
          ok: false,
          statusCode: 413,
          code: 'CHUNK_SIZE_EXCEEDS_POLICY',
          message: `Chunk size (${estimatedDecodedBytes} bytes) exceeds 256 KiB network chunk limit.`,
        };
      }
      bytes = Buffer.from(req.chunkBase64, 'base64');
    } else {
      return { ok: false, statusCode: 400, code: 'EMPTY_CHUNK', message: 'chunkBase64 must be non-empty.' };
    }

    if (bytes.byteLength === 0) {
      return { ok: false, statusCode: 400, code: 'INVALID_BASE64', message: 'Decoded chunk is empty.' };
    }
    if (bytes.byteLength > MAX_NETWORK_CHUNK_BYTES) {
      return {
        ok: false,
        statusCode: 413,
        code: 'CHUNK_SIZE_EXCEEDS_POLICY',
        message: `Decoded chunk (${bytes.byteLength} bytes) exceeds 256 KiB policy limit (${MAX_NETWORK_CHUNK_BYTES}).`,
      };
    }

    if (req.chunkSha256 !== undefined) {
      const actualChunkHash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualChunkHash !== req.chunkSha256.toLowerCase()) {
        return {
          ok: false,
          statusCode: 422,
          code: 'CHUNK_CHECKSUM_MISMATCH',
          message: `SHA-256 mismatch on chunk ${req.chunkIndex}.`,
        };
      }
    }

    if (
      sess.receivedBytes + bytes.byteLength > sess.expectedBytes ||
      sess.receivedBytes + bytes.byteLength > this.maxTransferBytes
    ) {
      this.cleanupSession(req.transferId, sess, 'FAILED');
      return {
        ok: false,
        statusCode: 413,
        code: 'TRANSFER_OVERFLOW',
        message: 'Received audio bytes exceeded declared expectedBytes bound; transfer aborted.',
      };
    }

    return { ok: true, statusCode: 200, sess, bytes };
  }

  public appendChunk(req: CompanionAudioTransferChunkRequest): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly chunkIndex?: number;
    readonly receivedBytes?: number;
    readonly state?: CompanionTransferLifecycleState;
    readonly code?: string;
    readonly message?: string;
  } {
    const prep = this.prepareAndValidateChunk(req);
    if (!prep.ok || !prep.sess || !prep.bytes) {
      return {
        ok: false,
        statusCode: prep.statusCode,
        code: prep.code,
        message: prep.message,
      };
    }
    const { sess, bytes } = prep;

    let releaseNetworkBuf: (() => void) | null = null;
    let releaseWriteBuf: (() => void) | null = null;
    try {
      releaseNetworkBuf = this.memoryAccountant.acquire(
        'transferBuffers',
        bytes.byteLength,
        sess.transferId,
      );
      releaseWriteBuf = this.memoryAccountant.acquire(
        'fileWriteBuffers',
        bytes.byteLength,
        sess.transferId,
      );

      this.transitionState(sess, 'RECEIVING');
      if (sess.writeFd === null) {
        throw new Error('Transfer staging file descriptor is closed.');
      }
      let writtenTotal = 0;
      while (writtenTotal < bytes.byteLength) {
        const w = fs.writeSync(
          sess.writeFd,
          bytes,
          writtenTotal,
          bytes.byteLength - writtenTotal,
          sess.receivedBytes + writtenTotal,
        );
        if (w <= 0) {
          throw new Error('Zero bytes written to transfer staging file.');
        }
        writtenTotal += w;
      }
    } catch (err) {
      if (releaseWriteBuf) releaseWriteBuf();
      if (releaseNetworkBuf) releaseNetworkBuf();
      this.cleanupSession(req.transferId, sess, 'FAILED');
      return {
        ok: false,
        statusCode: 500,
        code: 'DISK_WRITE_ERROR',
        message: err instanceof Error ? err.message : 'Failed to write audio chunk to staging disk.',
      };
    } finally {
      if (releaseWriteBuf) releaseWriteBuf();
      if (releaseNetworkBuf) releaseNetworkBuf();
    }

    sess.hasher.update(bytes);
    sess.receivedBytes += bytes.byteLength;
    sess.nextChunkIndex += 1;

    if (sess.nextChunkIndex === sess.totalChunks) {
      this.closeWriteFd(sess);
      this.transitionState(sess, 'RECEIVED');
    }

    return {
      ok: true,
      statusCode: 200,
      chunkIndex: req.chunkIndex,
      receivedBytes: sess.receivedBytes,
      state: sess.state,
    };
  }

  public finalizeTransfer(
    transferId: string,
    options: { readonly ownerId: string },
  ): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly transferId?: string;
    readonly sha256?: string;
    readonly receivedBytes?: number;
    readonly state?: CompanionTransferLifecycleState;
    readonly code?: string;
    readonly message?: string;
  } {
    const sess = this.sessions.get(transferId);
    if (!sess) {
      return {
        ok: false,
        statusCode: 404,
        code: 'TRANSFER_NOT_FOUND',
        message: 'Unknown or expired transferId.',
      };
    }
    const ownerCheck = this.validateOwner(sess, options?.ownerId);
    if (!ownerCheck.ok) return ownerCheck;

    if (sess.finalized && sess.state === 'READY') {
      return {
        ok: true,
        statusCode: 200,
        transferId,
        sha256: sess.finalSha256,
        receivedBytes: sess.receivedBytes,
        state: sess.state,
      };
    }
    if (sess.nextChunkIndex !== sess.totalChunks) {
      this.cleanupSession(transferId, sess, 'FAILED');
      return {
        ok: false,
        statusCode: 422,
        code: 'TRANSFER_INCOMPLETE_CHUNKS',
        message: `Transfer truncated: received ${sess.nextChunkIndex}/${sess.totalChunks} chunks.`,
      };
    }
    if (sess.receivedBytes !== sess.expectedBytes) {
      this.cleanupSession(transferId, sess, 'FAILED');
      return {
        ok: false,
        statusCode: 422,
        code: 'TRANSFER_TRUNCATED',
        message: `Transfer byte mismatch: received ${sess.receivedBytes} bytes, expected ${sess.expectedBytes}.`,
      };
    }

    this.closeWriteFd(sess);
    if (sess.state !== 'RECEIVED') {
      this.transitionState(sess, 'RECEIVED');
    }
    this.transitionState(sess, 'VALIDATING');

    const digest = sess.hasher.digest('hex');
    if (sess.expectedSha256 && digest !== sess.expectedSha256) {
      this.cleanupSession(transferId, sess, 'FAILED');
      return {
        ok: false,
        statusCode: 422,
        code: 'TRANSFER_CHECKSUM_MISMATCH',
        message: 'Final audio transfer SHA-256 digest did not match expectedSha256.',
      };
    }

    // If format is 'wav', inspect ONLY the initial 4 KiB header on disk (never reading the full file)
    if (sess.format === 'wav') {
      const headerInspectBytes = Math.min(4096, sess.receivedBytes);
      const releaseHeaderBuf = this.memoryAccountant.acquire(
        'decoderBuffers',
        headerInspectBytes,
        sess.transferId,
      );
      let headerMeta: WavHeaderMetadata;
      let fd: number | null = null;
      try {
        fd = fs.openSync(sess.tempPath, 'r');
        const headerBuf = Buffer.alloc(headerInspectBytes);
        const bytesRead = fs.readSync(fd, headerBuf, 0, headerInspectBytes, 0);
        headerMeta = parseWavHeaderFromInitialBytes(
          headerBuf.subarray(0, bytesRead),
          sess.receivedBytes,
        );
      } catch (err) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
        }
        releaseHeaderBuf();
        this.cleanupSession(transferId, sess, 'FAILED');
        return {
          ok: false,
          statusCode: 500,
          code: 'TRANSFER_VALIDATION_READ_FAILED',
          message: err instanceof Error ? err.message : 'Failed to validate WAV header.',
        };
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
        }
        releaseHeaderBuf();
      }

      if (!headerMeta.valid) {
        this.cleanupSession(transferId, sess, 'FAILED');
        return {
          ok: false,
          statusCode: 422,
          code: headerMeta.errorCode ?? 'INVALID_WAV_HEADER',
          message: headerMeta.errorMessage ?? 'Corrupt WAV header detected during validation.',
        };
      }
      if (
        headerMeta.sampleRateHz !== sess.sampleRateHz ||
        headerMeta.channels !== sess.channels
      ) {
        this.cleanupSession(transferId, sess, 'FAILED');
        return {
          ok: false,
          statusCode: 422,
          code: 'WAV_HEADER_METADATA_MISMATCH',
          message: `WAV header (${headerMeta.sampleRateHz} Hz, ${headerMeta.channels}ch) does not match declared metadata (${sess.sampleRateHz} Hz, ${sess.channels}ch).`,
        };
      }
      sess.wavHeader = headerMeta;
    }

    sess.finalized = true;
    sess.finalSha256 = digest;
    this.transitionState(sess, 'READY');
    return {
      ok: true,
      statusCode: 200,
      transferId,
      sha256: digest,
      receivedBytes: sess.receivedBytes,
      state: sess.state,
    };
  }

  /**
   * Acquires a file-backed `CompanionAudioSource` for a finalized (`READY`) transfer.
   * Zero full-file memory allocation is performed: all reads and WAV preparations
   * stream directly from disk in bounded <= 256 KiB windows with backpressure.
   */
  public acquireAudioSource(
    transferId: string,
    options: { readonly ownerId: string },
  ): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly source?: CompanionAudioSource;
    readonly code?: string;
    readonly message?: string;
  } {
    const sess = this.sessions.get(transferId);
    if (!sess) {
      return {
        ok: false,
        statusCode: 404,
        code: 'TRANSFER_NOT_FOUND',
        message: 'Unknown or expired transferId.',
      };
    }
    const ownerCheck = this.validateOwner(sess, options?.ownerId);
    if (!ownerCheck.ok) return ownerCheck;

    if (!sess.finalized || !sess.finalSha256 || sess.state !== 'READY') {
      return {
        ok: false,
        statusCode: 409,
        code: 'TRANSFER_NOT_READY',
        message: `Audio transfer must be in READY state before acquiring source (current: ${sess.state}).`,
      };
    }

    this.transitionState(sess, 'PROCESSING');

    const bytesPerSampleValue =
      sess.format === 'pcm_f32le'
        ? 4
        : sess.format === 'pcm_s16le'
          ? 2
          : (sess.wavHeader?.bitsPerSample ?? 16) / 8;
    const isFloatEncoding =
      sess.format === 'pcm_f32le' ||
      (sess.format === 'wav' && sess.wavHeader?.audioFormat === 3);
    const bytesPerFrame = sess.channels * bytesPerSampleValue;
    const dataOffsetBytes = sess.format === 'wav' ? (sess.wavHeader?.dataOffsetBytes ?? 44) : 0;
    const dataByteLength =
      sess.format === 'wav'
        ? (sess.wavHeader?.dataByteLength ?? Math.max(0, sess.receivedBytes - dataOffsetBytes))
        : sess.receivedBytes;
    const exactFrameCount =
      sess.format === 'wav'
        ? (sess.wavHeader?.frameCount ?? Math.floor(dataByteLength / bytesPerFrame))
        : sess.expectedFrames;
    const maxRangeSamples = Math.max(1, Math.floor(MAX_FILE_READ_BUFFER_BYTES / bytesPerFrame));
    const finalSha256 = sess.finalSha256;
    let sourceClosed = false;

    const assertActiveAndNotAborted = (signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error('TRANSFER_PROCESSING_ABORTED');
      }
      if (sourceClosed || !this.sessions.has(transferId) || sess.state !== 'PROCESSING') {
        throw new Error('AUDIO_SOURCE_CLOSED');
      }
    };

    const readFrameRangeInterleaved = async (
      startFrame: number,
      frameCount: number,
      signal?: AbortSignal,
    ): Promise<Float32Array> => {
      assertActiveAndNotAborted(signal);
      if (!Number.isInteger(startFrame) || startFrame < 0 || startFrame > exactFrameCount) {
        throw new RangeError(`startSample (${startFrame}) out of bounds [0, ${exactFrameCount}].`);
      }
      if (!Number.isInteger(frameCount) || frameCount < 0) {
        throw new RangeError(`sampleCount (${frameCount}) must be a non-negative integer.`);
      }
      if (frameCount > maxRangeSamples) {
        throw new RangeError(
          `RANGE_TOO_LARGE: requested ${frameCount} frames exceeds maxRangeSamples (${maxRangeSamples}, 256 KiB ceiling).`,
        );
      }
      const clampedFrames = Math.min(frameCount, exactFrameCount - startFrame);
      if (clampedFrames === 0) {
        return new Float32Array(0);
      }

      const bytesToRead = clampedFrames * bytesPerFrame;
      const byteOffset = dataOffsetBytes + startFrame * bytesPerFrame;
      const releaseReadBuf = this.memoryAccountant.acquire(
        'fileReadBuffers',
        bytesToRead,
        sess.transferId,
      );
      const decodeFloatsBytes = clampedFrames * sess.channels * 4;
      const releaseDecodeBuf = this.memoryAccountant.acquire(
        'decoderBuffers',
        Math.min(decodeFloatsBytes, MAX_FILE_READ_BUFFER_BYTES * 2),
        sess.transferId,
      );

      let fh: fs.promises.FileHandle | null = null;
      try {
        fh = await fs.promises.open(sess.tempPath, 'r');
        sess.activeFileHandles.add(fh);
        assertActiveAndNotAborted(signal);

        const rawBuf = Buffer.allocUnsafe(bytesToRead);
        let totalRead = 0;
        while (totalRead < bytesToRead) {
          assertActiveAndNotAborted(signal);
          const { bytesRead } = await fh.read(
            rawBuf,
            totalRead,
            bytesToRead - totalRead,
            byteOffset + totalRead,
          );
          if (bytesRead <= 0) break;
          totalRead += bytesRead;
        }

        if (totalRead < bytesToRead) {
          throw new Error(
            `UNEXPECTED_EOF: read ${totalRead}/${bytesToRead} bytes from ${sess.transferId}.`,
          );
        }

        const totalValues = clampedFrames * sess.channels;
        const out = new Float32Array(totalValues);
        if (isFloatEncoding && bytesPerSampleValue === 4) {
          for (let i = 0; i < totalValues; i++) {
            const v = rawBuf.readFloatLE(i * 4);
            out[i] = Number.isFinite(v) ? v : 0;
          }
        } else if (bytesPerSampleValue === 2) {
          for (let i = 0; i < totalValues; i++) {
            const s16 = rawBuf.readInt16LE(i * 2);
            out[i] = s16 < 0 ? s16 / 32768 : s16 / 32767;
          }
        } else {
          for (let i = 0; i < totalValues; i++) {
            const s32 = rawBuf.readInt32LE(i * 4);
            out[i] = s32 / 2147483648;
          }
        }
        return out;
      } finally {
        if (fh) {
          sess.activeFileHandles.delete(fh);
          await fh.close().catch(() => {});
        }
        releaseDecodeBuf();
        releaseReadBuf();
      }
    };

    const source: CompanionAudioSource = {
      transferId: sess.transferId,
      ownerId: sess.ownerId,
      filename: sess.filename,
      sampleRate: sess.sampleRateHz,
      channelCount: sess.channels,
      exactSampleCount: exactFrameCount,
      totalSampleValues: exactFrameCount * sess.channels,
      format: sess.format,
      maxRangeSamples,
      byteLength: sess.receivedBytes,
      sha256: finalSha256,
      tempFilePath: sess.tempPath,

      getLifecycleState: () => this.getTransferLifecycleState(transferId, sess.ownerId) ?? 'CLEANED',
      getStateHistory: () => this.getTransferStateHistory(transferId, sess.ownerId),

      readRange: async (startSample: number, sampleCount: number, signal?: AbortSignal) => {
        return readFrameRangeInterleaved(startSample, sampleCount, signal);
      },

      readPlanarChannels: async (
        startFrame: number,
        frameCount: number,
        signal?: AbortSignal,
      ) => {
        const interleaved = await readFrameRangeInterleaved(startFrame, frameCount, signal);
        const actualFrames = Math.floor(interleaved.length / sess.channels);
        const planar: Float32Array[] = Array.from(
          { length: sess.channels },
          () => new Float32Array(actualFrames),
        );
        for (let f = 0; f < actualFrames; f++) {
          const base = f * sess.channels;
          for (let c = 0; c < sess.channels; c++) {
            planar[c][f] = interleaved[base + c];
          }
        }
        return planar;
      },

      prepareWavFileStreaming: async (prepOptions) => {
        assertActiveAndNotAborted(prepOptions?.signal);

        if (sess.format === 'wav') {
          return {
            wavFilePath: sess.tempPath,
            totalWavBytes: sess.receivedBytes,
            isRf64: Boolean(sess.wavHeader?.isRf64),
            drainWaits: 0,
          };
        }

        const preparedWavPath = this.resolveConfinedStagingFilePath(
          `${sess.transferId}.prepared.wav`,
        );
        sess.preparedWavPath = preparedWavPath;

        const targetPcm16Bytes = exactFrameCount * sess.channels * 2;
        const { header, isRf64 } = buildStreamingWavHeader({
          dataByteLength: targetPcm16Bytes,
          sampleRateHz: sess.sampleRateHz,
          channels: sess.channels,
          bitsPerSample: 16,
        });

        const requestedHwm = prepOptions?.writeHighWaterMarkBytes ?? MAX_FILE_WRITE_BUFFER_BYTES;
        const writeHwm = Math.max(1024, Math.min(MAX_FILE_WRITE_BUFFER_BYTES, requestedHwm));
        const readChunkBytes =
          sess.format === 'pcm_f32le'
            ? MAX_FILE_READ_BUFFER_BYTES - (MAX_FILE_READ_BUFFER_BYTES % (sess.channels * 4))
            : MAX_FILE_READ_BUFFER_BYTES - (MAX_FILE_READ_BUFFER_BYTES % (sess.channels * 2));

        const releaseReadBuf = this.memoryAccountant.acquire(
          'fileReadBuffers',
          readChunkBytes,
          sess.transferId,
        );
        const encoderChunkBytes =
          sess.format === 'pcm_f32le' ? Math.floor(readChunkBytes / 2) : readChunkBytes;
        const releaseWriteBuf = this.memoryAccountant.acquire(
          'fileWriteBuffers',
          writeHwm,
          sess.transferId,
        );
        const releaseEncoderBuf = this.memoryAccountant.acquire(
          'encoderBuffers',
          encoderChunkBytes,
          sess.transferId,
        );

        let fh: fs.promises.FileHandle | null = null;
        let ws: fs.WriteStream | null = null;
        let drainWaits = 0;

        const writeWithBackpressure = async (chunk: Buffer) => {
          if (!ws) throw new Error('WriteStream closed');
          assertActiveAndNotAborted(prepOptions?.signal);
          const canContinue = ws.write(chunk);
          if (!canContinue) {
            drainWaits += 1;
            this.memoryAccountant.recordBackpressureDrainWait();
            await once(ws, 'drain');
          }
        };

        try {
          fh = await fs.promises.open(sess.tempPath, 'r');
          sess.activeFileHandles.add(fh);
          ws = fs.createWriteStream(preparedWavPath, {
            flags: 'w',
            mode: 0o600,
            highWaterMark: writeHwm,
          });

          await writeWithBackpressure(header);

          const readBuf = Buffer.allocUnsafe(readChunkBytes);
          const encodeBuf =
            sess.format === 'pcm_f32le' ? Buffer.allocUnsafe(encoderChunkBytes) : null;

          let readOffset = 0;
          let totalWrittenWavBytes = header.byteLength;

          while (readOffset < sess.receivedBytes) {
            assertActiveAndNotAborted(prepOptions?.signal);
            const toRead = Math.min(readChunkBytes, sess.receivedBytes - readOffset);
            const { bytesRead } = await fh.read(readBuf, 0, toRead, readOffset);
            if (bytesRead <= 0) break;
            readOffset += bytesRead;

            let outSlice: Buffer;
            if (sess.format === 'pcm_f32le' && encodeBuf) {
              const floatCount = Math.floor(bytesRead / 4);
              for (let i = 0; i < floatCount; i++) {
                const rawFloat = readBuf.readFloatLE(i * 4);
                const clamped = Math.max(
                  -1,
                  Math.min(1, Number.isFinite(rawFloat) ? rawFloat : 0),
                );
                const int16 =
                  clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
                encodeBuf.writeInt16LE(int16, i * 2);
              }
              // Copy slice so WriteStream queue never aliases the next loop's encodeBuf
              outSlice = Buffer.from(encodeBuf.subarray(0, floatCount * 2));
            } else {
              outSlice = Buffer.from(readBuf.subarray(0, bytesRead));
            }

            await writeWithBackpressure(outSlice);
            totalWrittenWavBytes += outSlice.byteLength;
            if (prepOptions?.onChunkWritten) {
              await prepOptions.onChunkWritten(totalWrittenWavBytes, header.byteLength + targetPcm16Bytes);
            }
            assertActiveAndNotAborted(prepOptions?.signal);
          }

          assertActiveAndNotAborted(prepOptions?.signal);
          await new Promise<void>((resolve, reject) => {
            if (!ws) return resolve();
            ws.once('error', reject);
            ws.end(() => resolve());
          });

          return {
            wavFilePath: preparedWavPath,
            totalWavBytes: totalWrittenWavBytes,
            isRf64,
            drainWaits,
          };
        } catch (err) {
          if (ws) {
            try {
              ws.destroy();
            } catch {
              // ignore
            }
          }
          try {
            fs.rmSync(preparedWavPath, { force: true });
          } catch {
            // ignore
          }
          sess.preparedWavPath = undefined;
          throw err;
        } finally {
          if (fh) {
            sess.activeFileHandles.delete(fh);
            await fh.close().catch(() => {});
          }
          releaseEncoderBuf();
          releaseWriteBuf();
          releaseReadBuf();
        }
      },

      close: async (finalState = 'COMPLETED') => {
        if (sourceClosed) return;
        sourceClosed = true;
        this.cleanupSession(transferId, sess, finalState);
      },
    };

    return {
      ok: true,
      statusCode: 200,
      source,
    };
  }

  /**
   * Small-payload (<= 256 KiB) test helper retained ONLY for legacy unit tests.
   * Strictly forbids full-file reading on payloads > 256 KiB and uses bounded fd reads.
   */
  public consumeFinalizedTransferAsWav(
    transferId: string,
    options: { readonly ownerId: string },
  ): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly transfer?: FinalizedAudioTransfer;
    readonly wavBytes?: Buffer;
    readonly code?: string;
    readonly message?: string;
  } {
    const sess = this.sessions.get(transferId);
    if (!sess) {
      return {
        ok: false,
        statusCode: 404,
        code: 'TRANSFER_NOT_FOUND',
        message: 'Unknown or expired transferId.',
      };
    }
    const ownerCheck = this.validateOwner(sess, options?.ownerId);
    if (!ownerCheck.ok) return ownerCheck;

    if (!sess.finalized || !sess.finalSha256) {
      return {
        ok: false,
        statusCode: 409,
        code: 'TRANSFER_NOT_FINALIZED',
        message: 'Audio transfer must be finalized before submitting a job.',
      };
    }

    if (sess.receivedBytes > MAX_FILE_READ_BUFFER_BYTES) {
      return {
        ok: false,
        statusCode: 413,
        code: 'FULL_FILE_MATERIALIZATION_FORBIDDEN',
        message: `Payload (${sess.receivedBytes} bytes) exceeds 256 KiB single-buffer policy; use acquireAudioSource() streaming API.`,
      };
    }

    this.transitionState(sess, 'PROCESSING');
    const releaseRead = this.memoryAccountant.acquire(
      'fileReadBuffers',
      sess.receivedBytes,
      sess.transferId,
    );
    let rawBytes: Buffer;
    let fd: number | null = null;
    try {
      fd = fs.openSync(sess.tempPath, 'r');
      rawBytes = Buffer.allocUnsafe(sess.receivedBytes);
      let offset = 0;
      while (offset < sess.receivedBytes) {
        const r = fs.readSync(fd, rawBytes, offset, sess.receivedBytes - offset, offset);
        if (r <= 0) break;
        offset += r;
      }
    } catch {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      releaseRead();
      this.cleanupSession(transferId, sess, 'FAILED');
      return {
        ok: false,
        statusCode: 500,
        code: 'TRANSFER_READ_FAILED',
        message: 'Failed to read finalized audio transfer.',
      };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      releaseRead();
    }

    let wavBytes: Buffer;
    if (sess.format === 'wav') {
      wavBytes = rawBytes;
    } else if (sess.format === 'pcm_f32le') {
      const floatCount = Math.floor(rawBytes.byteLength / 4);
      const floats = new Float32Array(floatCount);
      for (let i = 0; i < floatCount; i++) {
        floats[i] = rawBytes.readFloatLE(i * 4);
      }
      wavBytes = encodePcmFloat32ToWav(floats, sess.sampleRateHz, sess.channels);
    } else {
      wavBytes = encodePcmInt16ToWav(rawBytes, sess.sampleRateHz, sess.channels);
    }

    const finalSha256 = sess.finalSha256;
    this.cleanupSession(transferId, sess, 'COMPLETED');

    return {
      ok: true,
      statusCode: 200,
      transfer: {
        transferId: sess.transferId,
        filename: sess.filename,
        format: sess.format,
        sampleRateHz: sess.sampleRateHz,
        channels: sess.channels,
        expectedFrames: sess.expectedFrames,
        bytes: rawBytes,
        sha256: finalSha256,
      },
      wavBytes,
    };
  }

  public abortTransfer(transferId: string, options: { readonly ownerId: string }): boolean {
    const sess = this.sessions.get(transferId);
    if (!sess) return false;
    if (
      typeof options?.ownerId !== 'string' ||
      options.ownerId.trim().length === 0 ||
      options.ownerId.trim() !== sess.ownerId
    ) {
      return false;
    }
    this.cleanupSession(transferId, sess, 'CANCELLED');
    return true;
  }

  public cleanupAll(): void {
    for (const [id, sess] of this.sessions.entries()) {
      this.cleanupSession(id, sess, 'CANCELLED');
    }
  }
}
