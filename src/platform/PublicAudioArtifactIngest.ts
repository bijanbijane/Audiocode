/**
 * AVP-PUBLIC-DATAPLANE-REAL-AUDIO-010
 * Streaming Binary Audio Ingestion, Private Temp Artifact Management & Constrained FFmpeg Decoding.
 *
 * Guarantees:
 * - Zero full-file PCM Float32Array allocation in Node.js heap.
 * - Streaming upload directly to 0700 temp directory / 0600 server-generated file with incremental SHA-256.
 * - Strict MIME type validation (rejects JSON/text/non-audio with 415).
 * - Strict upload byte cap enforced during streaming (413) and empty body check (400).
 * - Constrained FFmpeg subprocess (`-nostdin -protocol_whitelist file,pipe`, 64 KiB stderr cap, timeout, abort SIGKILL).
 * - Canonical 16 kHz mono float32le verification in bounded 256 KiB chunks (4-byte alignment + finite samples).
 * - Exact server-derived duration: `durationMs = Math.round((totalSamples16k * 1000) / 16000)`.
 * - Idempotent cleanup of private temp directory on every completion, error, or abort path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export const PUBLIC_AUDIO_SAMPLE_RATE = 16000;
export const PUBLIC_AUDIO_CHANNELS = 1;
export const DEFAULT_MAX_PUBLIC_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MiB
export const DEFAULT_DECODE_TIMEOUT_MS = 60_000;
const FFMPEG_STDERR_CAP_BYTES = 64 * 1024;
const PCM_VALIDATION_CHUNK_BYTES = 256 * 1024; // 65,536 Float32 samples (~4.1s @ 16 kHz)

export const SUPPORTED_PUBLIC_AUDIO_MIME_TYPES = new Set<string>([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
  'application/octet-stream',
]);

export type PublicAudioIngestErrorCode =
  | 'AUDIO_FORMAT_UNSUPPORTED'
  | 'EMPTY_AUDIO_BODY'
  | 'PAYLOAD_TOO_LARGE'
  | 'AUDIO_DECODE_FAILED'
  | 'AUDIO_DURATION_EXCEEDED'
  | 'REQUEST_ABORTED'
  | 'PROVIDER_UNAVAILABLE';

export class PublicAudioIngestError extends Error {
  public readonly httpStatus: number;
  public readonly code: PublicAudioIngestErrorCode;

  constructor(httpStatus: number, code: PublicAudioIngestErrorCode, message: string) {
    super(message);
    this.name = 'PublicAudioIngestError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export interface PublicAudioArtifact {
  readonly tempDirPath: string;
  readonly rawUploadFilePath: string;
  readonly canonicalPcmFilePath: string;
  readonly audioSha256: string;
  readonly uploadedBytes: number;
  readonly canonicalPcmBytes: number;
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly totalSamples16k: number;
  readonly durationMs: number;
  readonly detectedMimeType: string;
  dispose(): Promise<void>;
}

export interface IngestPublicAudioStreamParams {
  audioStream: Readable;
  contentType: string | undefined;
  contentLengthHeader?: string | number | undefined;
  maxUploadBytes?: number;
  maxDurationSeconds: number;
  ffmpegBinaryPath?: string;
  decodeTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

export function normalizeAndValidateAudioContentType(contentType: string | undefined): string {
  if (!contentType || typeof contentType !== 'string') {
    throw new PublicAudioIngestError(
      415,
      'AUDIO_FORMAT_UNSUPPORTED',
      'Missing Content-Type header. Upload raw binary audio (e.g., audio/wav, audio/ogg, audio/mpeg, audio/flac).'
    );
  }
  const baseMime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!baseMime || !SUPPORTED_PUBLIC_AUDIO_MIME_TYPES.has(baseMime)) {
    throw new PublicAudioIngestError(
      415,
      'AUDIO_FORMAT_UNSUPPORTED',
      `Unsupported Content-Type "${baseMime || contentType}". JSON payloads are not accepted; stream raw binary audio.`
    );
  }
  return baseMime;
}

async function safeRemoveDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

async function streamUploadToPrivateFile(params: {
  audioStream: Readable;
  targetFilePath: string;
  maxUploadBytes: number;
  abortSignal?: AbortSignal;
}): Promise<{ uploadedBytes: number; audioSha256: string }> {
  const { audioStream, targetFilePath, maxUploadBytes, abortSignal } = params;

  if (abortSignal?.aborted) {
    throw new PublicAudioIngestError(499, 'REQUEST_ABORTED', 'Client disconnected before audio upload began.');
  }

  const hash = crypto.createHash('sha256');
  const writeStream = createWriteStream(targetFilePath, { flags: 'wx', mode: 0o600 });
  let uploadedBytes = 0;

  return new Promise<{ uploadedBytes: number; audioSha256: string }>((resolve, reject) => {
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      audioStream.destroy();
      writeStream.destroy();
      reject(err);
    };

    const onAbort = () => {
      fail(new PublicAudioIngestError(499, 'REQUEST_ABORTED', 'Audio upload aborted by client disconnect.'));
    };

    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      uploadedBytes += buf.byteLength;
      if (uploadedBytes > maxUploadBytes) {
        fail(
          new PublicAudioIngestError(
            413,
            'PAYLOAD_TOO_LARGE',
            `Uploaded audio exceeds maximum allowed size (${maxUploadBytes} bytes).`
          )
        );
        return;
      }
      hash.update(buf);
      if (!writeStream.write(buf)) {
        audioStream.pause();
      }
    };

    const onDrain = () => {
      if (!settled) {
        audioStream.resume();
      }
    };

    const onEnd = () => {
      if (settled) return;
      writeStream.end();
    };

    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        uploadedBytes,
        audioSha256: hash.digest('hex'),
      });
    };

    const onStreamError = (err: Error) => {
      fail(
        err instanceof PublicAudioIngestError
          ? err
          : new PublicAudioIngestError(400, 'AUDIO_DECODE_FAILED', `Audio stream read error: ${err.message}`)
      );
    };

    const onWriteError = (err: Error) => {
      fail(new PublicAudioIngestError(503, 'PROVIDER_UNAVAILABLE', `Temporary audio staging write failed: ${err.message}`));
    };

    const onStreamClose = () => {
      if (!settled && !audioStream.readableEnded) {
        fail(new PublicAudioIngestError(499, 'REQUEST_ABORTED', 'Audio upload stream closed prematurely.'));
      }
    };

    const cleanupListeners = () => {
      audioStream.off('data', onData);
      audioStream.off('end', onEnd);
      audioStream.off('error', onStreamError);
      audioStream.off('close', onStreamClose);
      writeStream.off('drain', onDrain);
      writeStream.off('finish', onFinish);
      writeStream.off('error', onWriteError);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    audioStream.on('data', onData);
    audioStream.on('end', onEnd);
    audioStream.on('error', onStreamError);
    audioStream.on('close', onStreamClose);
    writeStream.on('drain', onDrain);
    writeStream.on('finish', onFinish);
    writeStream.on('error', onWriteError);
  });
}

async function decodeToCanonicalPcmWithFfmpeg(params: {
  ffmpegBinaryPath: string;
  inputFilePath: string;
  outputFilePath: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { ffmpegBinaryPath, inputFilePath, outputFilePath, timeoutMs, abortSignal } = params;

  if (abortSignal?.aborted) {
    throw new PublicAudioIngestError(499, 'REQUEST_ABORTED', 'Request aborted before audio decode started.');
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderrBytes = 0;
    const stderrChunks: Buffer[] = [];

    const args = [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      inputFilePath,
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      String(PUBLIC_AUDIO_CHANNELS),
      '-ar',
      String(PUBLIC_AUDIO_SAMPLE_RATE),
      '-f',
      'f32le',
      '-y',
      outputFilePath,
    ];

    const child = spawn(ffmpegBinaryPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    const killChild = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore already exited
      }
    };

    const fail = (err: PublicAudioIngestError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      killChild();
      reject(err);
    };

    const onAbort = () => {
      fail(new PublicAudioIngestError(499, 'REQUEST_ABORTED', 'Audio decode cancelled due to client disconnect.'));
    };

    const timer = setTimeout(() => {
      fail(
        new PublicAudioIngestError(
          422,
          'AUDIO_DECODE_FAILED',
          `Audio decode timed out after ${timeoutMs}ms.`
        )
      );
    }, timeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= FFMPEG_STDERR_CAP_BYTES) return;
      const remaining = FFMPEG_STDERR_CAP_BYTES - stderrBytes;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.byteLength;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        fail(
          new PublicAudioIngestError(
            503,
            'PROVIDER_UNAVAILABLE',
            `FFmpeg decoder binary "${ffmpegBinaryPath}" is unavailable in this container.`
          )
        );
        return;
      }
      fail(new PublicAudioIngestError(503, 'PROVIDER_UNAVAILABLE', `Audio decoder failed to start: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

      if (code === 0) {
        resolve();
        return;
      }

      const stderrSummary = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 300);
      reject(
        new PublicAudioIngestError(
          422,
          'AUDIO_DECODE_FAILED',
          `Audio payload could not be decoded to canonical 16 kHz mono PCM (exit=${String(code)}, signal=${String(signal)})${
            stderrSummary ? `: ${stderrSummary}` : '.'
          }`
        )
      );
    });
  });
}

async function verifyCanonicalPcmFileBounded(
  canonicalPcmFilePath: string,
  abortSignal?: AbortSignal
): Promise<{ canonicalPcmBytes: number; totalSamples16k: number }> {
  const stat = await fs.stat(canonicalPcmFilePath);
  const canonicalPcmBytes = stat.size;

  if (canonicalPcmBytes <= 0) {
    throw new PublicAudioIngestError(
      422,
      'AUDIO_DECODE_FAILED',
      'Decoded audio stream produced 0 PCM samples.'
    );
  }
  if (canonicalPcmBytes % 4 !== 0) {
    throw new PublicAudioIngestError(
      422,
      'AUDIO_DECODE_FAILED',
      `Decoded float32le PCM byte length (${canonicalPcmBytes}) is not 4-byte aligned.`
    );
  }

  // Stream-scan in bounded 256 KiB chunks to verify every sample is finite without allocating full PCM
  const handle = await fs.open(canonicalPcmFilePath, 'r');
  try {
    const readBuf = Buffer.allocUnsafe(PCM_VALIDATION_CHUNK_BYTES);
    let offset = 0;
    while (offset < canonicalPcmBytes) {
      if (abortSignal?.aborted) {
        throw new PublicAudioIngestError(499, 'REQUEST_ABORTED', 'Request aborted during canonical PCM verification.');
      }
      const bytesToRead = Math.min(PCM_VALIDATION_CHUNK_BYTES, canonicalPcmBytes - offset);
      const { bytesRead } = await handle.read(readBuf, 0, bytesToRead, offset);
      if (bytesRead <= 0) break;
      if (bytesRead % 4 !== 0) {
        throw new PublicAudioIngestError(422, 'AUDIO_DECODE_FAILED', 'Unaligned PCM read chunk encountered.');
      }
      for (let i = 0; i < bytesRead; i += 4) {
        const sample = readBuf.readFloatLE(i);
        if (!Number.isFinite(sample)) {
          throw new PublicAudioIngestError(
            422,
            'AUDIO_DECODE_FAILED',
            'Decoded PCM stream contains non-finite (NaN/Infinity) samples.'
          );
        }
      }
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }

  return {
    canonicalPcmBytes,
    totalSamples16k: canonicalPcmBytes / 4,
  };
}

export async function ingestPublicAudioStream(
  params: IngestPublicAudioStreamParams
): Promise<PublicAudioArtifact> {
  const detectedMimeType = normalizeAndValidateAudioContentType(params.contentType);
  const maxUploadBytes = params.maxUploadBytes ?? DEFAULT_MAX_PUBLIC_AUDIO_BYTES;
  const decodeTimeoutMs = params.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
  const ffmpegBinaryPath = params.ffmpegBinaryPath ?? process.env.FFMPEG_BINARY_PATH ?? 'ffmpeg';

  if (params.contentLengthHeader !== undefined) {
    const declared = Number(params.contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxUploadBytes) {
      params.audioStream.resume();
      throw new PublicAudioIngestError(
        413,
        'PAYLOAD_TOO_LARGE',
        `Declared Content-Length (${declared} bytes) exceeds maximum allowed upload size (${maxUploadBytes} bytes).`
      );
    }
  }

  const tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'avp-pub-audio-'));
  await fs.chmod(tempDirPath, 0o700);

  const rawUploadFilePath = path.join(tempDirPath, 'upload.bin');
  const canonicalPcmFilePath = path.join(tempDirPath, 'canonical_16k.f32le');

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await safeRemoveDir(tempDirPath);
  };

  try {
    const { uploadedBytes, audioSha256 } = await streamUploadToPrivateFile({
      audioStream: params.audioStream,
      targetFilePath: rawUploadFilePath,
      maxUploadBytes,
      abortSignal: params.abortSignal,
    });

    if (uploadedBytes <= 0) {
      throw new PublicAudioIngestError(400, 'EMPTY_AUDIO_BODY', 'Audio request body is empty.');
    }

    await decodeToCanonicalPcmWithFfmpeg({
      ffmpegBinaryPath,
      inputFilePath: rawUploadFilePath,
      outputFilePath: canonicalPcmFilePath,
      timeoutMs: decodeTimeoutMs,
      abortSignal: params.abortSignal,
    });

    await fs.chmod(canonicalPcmFilePath, 0o600).catch(() => {});

    const { canonicalPcmBytes, totalSamples16k } = await verifyCanonicalPcmFileBounded(
      canonicalPcmFilePath,
      params.abortSignal
    );

    const durationMs = Math.round((totalSamples16k * 1000) / PUBLIC_AUDIO_SAMPLE_RATE);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new PublicAudioIngestError(
        422,
        'AUDIO_DECODE_FAILED',
        'Decoded audio duration must be greater than 0 ms.'
      );
    }

    const maxDurationMs = Math.round(params.maxDurationSeconds * 1000);
    if (durationMs > maxDurationMs) {
      throw new PublicAudioIngestError(
        400,
        'AUDIO_DURATION_EXCEEDED',
        `Verified audio duration (${(durationMs / 1000).toFixed(2)}s) exceeds model maximum (${params.maxDurationSeconds}s).`
      );
    }

    return {
      tempDirPath,
      rawUploadFilePath,
      canonicalPcmFilePath,
      audioSha256,
      uploadedBytes,
      canonicalPcmBytes,
      sampleRate: PUBLIC_AUDIO_SAMPLE_RATE,
      channels: PUBLIC_AUDIO_CHANNELS,
      totalSamples16k,
      durationMs,
      detectedMimeType,
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}
