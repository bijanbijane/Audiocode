/**
 * AVAPARDAZ — DETERMINISTIC CHUNKED AUDIO TRANSFER ENGINE FOR NATIVE COMPANION
 *
 * Implements AVP-P0-004 Section 6 (Audio Transfer Architecture):
 * - Explicit audio format metadata (`pcm_f32le`, `pcm_s16le`, `wav`)
 * - Sample rate, channel count, endianness, frame count, and byte count validation
 * - Strict sequential chunk indexing (rejects duplicates and out-of-order chunks)
 * - Per-chunk SHA-256 verification and full-payload SHA-256 verification
 * - Truncation and over-length detection on finalize
 * - Deterministic cleanup of staged temporary buffers on abort, expiration, or completion
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CompanionAudioTransferFormat = 'pcm_f32le' | 'pcm_s16le' | 'wav';

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
}

export interface CompanionAudioTransferChunkRequest {
  readonly transferId: string;
  readonly chunkIndex: number;
  readonly chunkBase64: string;
  readonly chunkSha256?: string;
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

interface ActiveAudioTransferSession {
  readonly transferId: string;
  readonly filename: string;
  readonly format: CompanionAudioTransferFormat;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly expectedBytes: number;
  readonly expectedFrames: number;
  readonly totalChunks: number;
  readonly expectedSha256?: string;
  readonly tempPath: string;
  readonly createdAtMs: number;
  readonly hasher: crypto.Hash;
  nextChunkIndex: number;
  receivedBytes: number;
  finalized: boolean;
  finalSha256?: string;
}

const ALLOWED_FORMATS = new Set<CompanionAudioTransferFormat>(['pcm_f32le', 'pcm_s16le', 'wav']);

export function encodePcmFloat32ToWav(samples: Float32Array, sampleRateHz: number, channels: number): Buffer {
  const numFrames = Math.floor(samples.length / channels);
  const bytesPerSample = 2;
  const dataSize = numFrames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numFrames * channels; i++) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buf.writeInt16LE(int16, 44 + i * 2);
  }
  return buf;
}

export function encodePcmInt16ToWav(pcmBytes: Buffer, sampleRateHz: number, channels: number): Buffer {
  const dataSize = pcmBytes.byteLength - (pcmBytes.byteLength % (channels * 2));
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcmBytes.copy(buf, 44, 0, dataSize);
  return buf;
}

export class CompanionAudioTransferManager {
  private readonly sessions = new Map<string, ActiveAudioTransferSession>();
  private readonly stagingDir: string;
  private readonly maxTransferBytes: number;
  private readonly ttlMs: number;

  constructor(options?: {
    readonly stagingDir?: string;
    readonly maxTransferBytes?: number;
    readonly ttlMs?: number;
  }) {
    this.stagingDir = options?.stagingDir ?? path.join(os.tmpdir(), 'avapardaz-companion-transfers');
    this.maxTransferBytes = options?.maxTransferBytes ?? 128 * 1024 * 1024;
    this.ttlMs = options?.ttlMs ?? 15 * 60 * 1000;
  }

  public sweepExpired(nowMs = Date.now()): number {
    let removed = 0;
    for (const [id, sess] of this.sessions.entries()) {
      if (nowMs - sess.createdAtMs > this.ttlMs) {
        this.cleanupSession(id, sess);
        removed++;
      }
    }
    return removed;
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private cleanupSession(transferId: string, sess?: ActiveAudioTransferSession): void {
    const target = sess ?? this.sessions.get(transferId);
    this.sessions.delete(transferId);
    if (!target) return;
    try {
      fs.rmSync(target.tempPath, { force: true });
    } catch {
      // ignore race
    }
  }

  public initTransfer(req: CompanionAudioTransferInitRequest): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly transferId?: string;
    readonly code?: string;
    readonly message?: string;
  } {
    this.sweepExpired();

    if (!ALLOWED_FORMATS.has(req.format)) {
      return { ok: false, statusCode: 400, code: 'UNSUPPORTED_AUDIO_FORMAT', message: `Unsupported transfer format "${String(req.format)}".` };
    }
    if (req.endianness !== 'little') {
      return { ok: false, statusCode: 400, code: 'UNSUPPORTED_ENDIANNESS', message: 'Only little-endian PCM transfers are supported.' };
    }
    if (!Number.isInteger(req.sampleRateHz) || req.sampleRateHz < 8000 || req.sampleRateHz > 192000) {
      return { ok: false, statusCode: 400, code: 'INVALID_SAMPLE_RATE', message: 'sampleRateHz must be an integer between 8000 and 192000.' };
    }
    if (!Number.isInteger(req.channels) || req.channels < 1 || req.channels > 8) {
      return { ok: false, statusCode: 400, code: 'INVALID_CHANNEL_COUNT', message: 'channels must be an integer between 1 and 8.' };
    }
    if (!Number.isInteger(req.expectedBytes) || req.expectedBytes <= 0 || req.expectedBytes > this.maxTransferBytes) {
      return { ok: false, statusCode: req.expectedBytes > this.maxTransferBytes ? 413 : 400, code: 'INVALID_TRANSFER_SIZE', message: `expectedBytes must be between 1 and ${this.maxTransferBytes}.` };
    }
    if (!Number.isInteger(req.expectedFrames) || req.expectedFrames <= 0) {
      return { ok: false, statusCode: 400, code: 'INVALID_FRAME_COUNT', message: 'expectedFrames must be a positive integer.' };
    }
    if (!Number.isInteger(req.totalChunks) || req.totalChunks < 1 || req.totalChunks > 10_000) {
      return { ok: false, statusCode: 400, code: 'INVALID_CHUNK_COUNT', message: 'totalChunks must be between 1 and 10000.' };
    }

    // Verify exact byte-to-frame relation for raw PCM formats
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
      return { ok: false, statusCode: 400, code: 'INVALID_SHA256', message: 'expectedSha256 must be a 64-character hex digest.' };
    }

    fs.mkdirSync(this.stagingDir, { recursive: true });
    const transferId = `xfr_${crypto.randomBytes(8).toString('hex')}`;
    const safeName =
      typeof req.filename === 'string' && req.filename.trim().length > 0
        ? path.basename(req.filename.trim()).replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_')
        : `transfer.${req.format === 'wav' ? 'wav' : 'pcm'}`;
    const tempPath = path.join(this.stagingDir, `${transferId}.part`);
    fs.writeFileSync(tempPath, Buffer.alloc(0));

    this.sessions.set(transferId, {
      transferId,
      filename: safeName,
      format: req.format,
      sampleRateHz: req.sampleRateHz,
      channels: req.channels,
      expectedBytes: req.expectedBytes,
      expectedFrames: req.expectedFrames,
      totalChunks: req.totalChunks,
      expectedSha256: req.expectedSha256?.toLowerCase(),
      tempPath,
      createdAtMs: Date.now(),
      hasher: crypto.createHash('sha256'),
      nextChunkIndex: 0,
      receivedBytes: 0,
      finalized: false,
    });

    return { ok: true, statusCode: 200, transferId };
  }

  public appendChunk(req: CompanionAudioTransferChunkRequest): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly chunkIndex?: number;
    readonly receivedBytes?: number;
    readonly code?: string;
    readonly message?: string;
  } {
    this.sweepExpired();
    const sess = this.sessions.get(req.transferId);
    if (!sess) {
      return { ok: false, statusCode: 404, code: 'TRANSFER_NOT_FOUND', message: 'Unknown or expired transferId.' };
    }
    if (sess.finalized) {
      return { ok: false, statusCode: 409, code: 'TRANSFER_ALREADY_FINALIZED', message: 'Audio transfer is already finalized.' };
    }
    if (!Number.isInteger(req.chunkIndex) || req.chunkIndex < 0 || req.chunkIndex >= sess.totalChunks) {
      return { ok: false, statusCode: 400, code: 'INVALID_CHUNK_INDEX', message: `chunkIndex ${req.chunkIndex} is out of bounds.` };
    }
    if (req.chunkIndex < sess.nextChunkIndex) {
      return { ok: false, statusCode: 409, code: 'DUPLICATE_CHUNK_REJECTED', message: `Duplicate chunkIndex ${req.chunkIndex} rejected.` };
    }
    if (req.chunkIndex > sess.nextChunkIndex) {
      return {
        ok: false,
        statusCode: 409,
        code: 'OUT_OF_ORDER_CHUNK_REJECTED',
        message: `Out-of-order chunkIndex ${req.chunkIndex} (expected ${sess.nextChunkIndex}).`,
      };
    }

    if (typeof req.chunkBase64 !== 'string' || req.chunkBase64.length === 0) {
      return { ok: false, statusCode: 400, code: 'EMPTY_CHUNK', message: 'chunkBase64 must be non-empty.' };
    }
    const bytes = Buffer.from(req.chunkBase64, 'base64');
    if (bytes.byteLength === 0) {
      return { ok: false, statusCode: 400, code: 'INVALID_BASE64', message: 'Decoded chunk is empty.' };
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

    if (sess.receivedBytes + bytes.byteLength > sess.expectedBytes || sess.receivedBytes + bytes.byteLength > this.maxTransferBytes) {
      this.cleanupSession(req.transferId, sess);
      return {
        ok: false,
        statusCode: 413,
        code: 'TRANSFER_OVERFLOW',
        message: 'Received audio bytes exceeded declared expectedBytes bound; transfer aborted.',
      };
    }

    fs.appendFileSync(sess.tempPath, bytes);
    sess.hasher.update(bytes);
    sess.receivedBytes += bytes.byteLength;
    sess.nextChunkIndex += 1;

    return {
      ok: true,
      statusCode: 200,
      chunkIndex: req.chunkIndex,
      receivedBytes: sess.receivedBytes,
    };
  }

  public finalizeTransfer(transferId: string): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly transferId?: string;
    readonly sha256?: string;
    readonly receivedBytes?: number;
    readonly code?: string;
    readonly message?: string;
  } {
    const sess = this.sessions.get(transferId);
    if (!sess) {
      return { ok: false, statusCode: 404, code: 'TRANSFER_NOT_FOUND', message: 'Unknown or expired transferId.' };
    }
    if (sess.finalized) {
      return { ok: true, statusCode: 200, transferId, sha256: sess.finalSha256, receivedBytes: sess.receivedBytes };
    }
    if (sess.nextChunkIndex !== sess.totalChunks) {
      this.cleanupSession(transferId, sess);
      return {
        ok: false,
        statusCode: 422,
        code: 'TRANSFER_INCOMPLETE_CHUNKS',
        message: `Transfer truncated: received ${sess.nextChunkIndex}/${sess.totalChunks} chunks.`,
      };
    }
    if (sess.receivedBytes !== sess.expectedBytes) {
      this.cleanupSession(transferId, sess);
      return {
        ok: false,
        statusCode: 422,
        code: 'TRANSFER_TRUNCATED',
        message: `Transfer byte mismatch: received ${sess.receivedBytes} bytes, expected ${sess.expectedBytes}.`,
      };
    }

    const digest = sess.hasher.digest('hex');
    if (sess.expectedSha256 && digest !== sess.expectedSha256) {
      this.cleanupSession(transferId, sess);
      return {
        ok: false,
        statusCode: 422,
        code: 'TRANSFER_CHECKSUM_MISMATCH',
        message: 'Final audio transfer SHA-256 digest did not match expectedSha256.',
      };
    }

    sess.finalized = true;
    sess.finalSha256 = digest;
    return { ok: true, statusCode: 200, transferId, sha256: digest, receivedBytes: sess.receivedBytes };
  }

  public consumeFinalizedTransferAsWav(transferId: string): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly transfer?: FinalizedAudioTransfer;
    readonly wavBytes?: Buffer;
    readonly code?: string;
    readonly message?: string;
  } {
    const sess = this.sessions.get(transferId);
    if (!sess) {
      return { ok: false, statusCode: 404, code: 'TRANSFER_NOT_FOUND', message: 'Unknown or expired transferId.' };
    }
    if (!sess.finalized || !sess.finalSha256) {
      return { ok: false, statusCode: 409, code: 'TRANSFER_NOT_FINALIZED', message: 'Audio transfer must be finalized before submitting a job.' };
    }

    let rawBytes: Buffer;
    try {
      rawBytes = fs.readFileSync(sess.tempPath);
    } catch {
      this.cleanupSession(transferId, sess);
      return { ok: false, statusCode: 500, code: 'TRANSFER_READ_FAILED', message: 'Failed to read finalized audio transfer.' };
    } finally {
      this.cleanupSession(transferId, sess);
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
        sha256: sess.finalSha256,
      },
      wavBytes,
    };
  }

  public abortTransfer(transferId: string): boolean {
    if (!this.sessions.has(transferId)) return false;
    this.cleanupSession(transferId);
    return true;
  }

  public cleanupAll(): void {
    for (const [id, sess] of this.sessions.entries()) {
      this.cleanupSession(id, sess);
    }
  }
}
