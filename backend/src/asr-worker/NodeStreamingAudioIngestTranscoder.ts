import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface StreamedAsrWindowChunk {
  readonly windowIndex: number;
  readonly startSample16k: number;
  readonly pcm16kMono: Float32Array;
  readonly isFinalWindow: boolean;
}

/**
 * Section 129: Zero-Temp-File Streaming Multi-Format Audio Ingest Transcoder (16kHz Mono Float32LE)
 * Streams MP3/M4A/OGG/FLAC into sliding 25s windows (with 3s overlap), enforces backpressure,
 * and kills runaway streams exceeding maxAllowedDurationSec (Decompression Bomb Guard).
 */
export class NodeStreamingAudioIngestTranscoder {
  private static readonly TARGET_RATE = 16000;

  /**
   * Validates an FFmpeg input as a local filesystem path. When an allowed root is
   * supplied, canonicalizes existing symlink prefixes before enforcing confinement.
   */
  public static validateSafeLocalAudioPath(inputPath: unknown, allowedRoot?: string): string {
    if (
      typeof inputPath !== 'string' ||
      inputPath.trim().length === 0 ||
      inputPath.includes('\0')
    ) {
      throw new Error('INVALID_FFMPEG_INPUT_PATH');
    }

    const candidate = inputPath.trim();
    if (candidate.startsWith('-')) {
      throw new Error('SECURITY_FFMPEG_OPTION_INJECTION');
    }
    if (
      /^(?:concat|subfile|pipe|crypto|data|file|https?|ftp|rtmp|rtsp):/i.test(candidate) ||
      candidate.includes('://')
    ) {
      throw new Error('SECURITY_SSRF_PROTOCOL_FORBIDDEN');
    }

    const resolvedPath = path.resolve(candidate);
    if (allowedRoot !== undefined) {
      if (
        typeof allowedRoot !== 'string' ||
        allowedRoot.trim().length === 0 ||
        allowedRoot.includes('\0')
      ) {
        throw new Error('SECURITY_PATH_TRAVERSAL_FORBIDDEN');
      }
      const canonicalPath = this.resolveExistingPathPrefix(resolvedPath);
      const canonicalRoot = this.resolveExistingPathPrefix(path.resolve(allowedRoot));
      const relativePath = path.relative(canonicalRoot, canonicalPath);
      if (
        relativePath === '..' ||
        relativePath.startsWith('..' + path.sep) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error('SECURITY_PATH_TRAVERSAL_FORBIDDEN');
      }
    }

    return resolvedPath;
  }

  private static resolveExistingPathPrefix(candidatePath: string): string {
    let current = path.resolve(candidatePath);
    const missingSegments: string[] = [];

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(candidatePath);
      }
      missingSegments.unshift(path.basename(current));
      current = parent;
    }

    const canonicalPrefix = fs.realpathSync.native(current);
    return path.resolve(canonicalPrefix, ...missingSegments);
  }

  /**
   * Pure byte-stream chunker over arbitrary binary chunks (used by both live ffmpeg stdout and unit tests)
   */
  public static async *chunkFloat32LeByteStreamIntoOverlappingWindows(params: {
    byteChunks: AsyncIterable<Buffer | Uint8Array>;
    windowDurationSec?: number; // Default 25s
    overlapDurationSec?: number; // Default 3s
    maxAllowedDurationSec?: number; // Default 6 hours (Section 41)
    onKillProcess?: () => void;
    abortSignal?: AbortSignal;
  }): AsyncGenerator<StreamedAsrWindowChunk, void, void> {
    const winSec = params.windowDurationSec ?? 25;
    const overlapSec = params.overlapDurationSec ?? 3;
    const maxSec = params.maxAllowedDurationSec ?? 6 * 3600;

    if (
      !Number.isFinite(winSec) ||
      winSec <= 0 ||
      !Number.isFinite(overlapSec) ||
      overlapSec < 0 ||
      overlapSec >= winSec ||
      !Number.isFinite(maxSec) ||
      maxSec <= 0
    ) {
      throw new Error('INVALID_TRANSCODER_WINDOW_CONFIG');
    }

    const winSamples = Math.max(1, Math.floor(winSec * this.TARGET_RATE));
    const overlapSamples = Math.floor(overlapSec * this.TARGET_RATE);
    const strideSamples = Math.max(1, winSamples - overlapSamples);
    const maxAllowedSamples = Math.max(1, Math.floor(maxSec * this.TARGET_RATE));

    let leftoverBytes = Buffer.alloc(0);
    let ringSamples = new Float32Array(0);
    let totalSamplesEmittedFromStream = 0;
    let windowIndex = 0;
    let currentWindowStartSample = 0;

    for await (const rawChunk of params.byteChunks) {
      if (params.abortSignal?.aborted) {
        params.onKillProcess?.();
        throw new Error('STREAM_TRANSCODE_ABORTED');
      }

      const bufChunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const combinedBytes =
        leftoverBytes.length > 0 ? Buffer.concat([leftoverBytes, bufChunk]) : bufChunk;

      // Each Float32 sample is 4 bytes; keep any non-multiple-of-4 tail bytes for the next chunk
      const alignedByteLen = combinedBytes.length & ~3;
      leftoverBytes =
        alignedByteLen < combinedBytes.length
          ? Buffer.from(combinedBytes.subarray(alignedByteLen))
          : Buffer.alloc(0);

      if (alignedByteLen === 0) continue;

      const newSampleCount = alignedByteLen / 4;
      totalSamplesEmittedFromStream += newSampleCount;

      if (totalSamplesEmittedFromStream > maxAllowedSamples) {
        params.onKillProcess?.();
        throw new Error(
          `SECURITY_DECOMPRESSION_BOMB_GUARD: مدت صوت از سقف مجاز ${maxSec} ثانیه عبور کرد.`,
        );
      }

      const newFloats = new Float32Array(newSampleCount);
      for (let i = 0; i < newSampleCount; i++) {
        newFloats[i] = combinedBytes.readFloatLE(i * 4);
      }

      const merged = new Float32Array(ringSamples.length + newFloats.length);
      merged.set(ringSamples, 0);
      merged.set(newFloats, ringSamples.length);
      ringSamples = merged;

      while (ringSamples.length >= winSamples) {
        const windowPcm = ringSamples.slice(0, winSamples);
        yield {
          windowIndex,
          startSample16k: currentWindowStartSample,
          pcm16kMono: windowPcm,
          isFinalWindow: false,
        };

        windowIndex++;
        currentWindowStartSample += strideSamples;
        ringSamples = ringSamples.slice(strideSamples);
      }
    }

    if (ringSamples.length >= 1600) {
      yield {
        windowIndex,
        startSample16k: currentWindowStartSample,
        pcm16kMono: ringSamples,
        isFinalWindow: true,
      };
    }
  }

  public static async *streamAudioFileAsOverlapping16kWindows(params: {
    inputFilePath: string;
    allowedRoot?: string;
    windowDurationSec?: number;
    overlapDurationSec?: number;
    maxAllowedDurationSec?: number;
    ffmpegBinaryPath?: string;
    abortSignal?: AbortSignal;
  }): AsyncGenerator<StreamedAsrWindowChunk, void, void> {
    const safeInputPath = this.validateSafeLocalAudioPath(
      params.inputFilePath,
      params.allowedRoot,
    );

    const ffmpeg = spawn(
      params.ffmpegBinaryPath ?? 'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        safeInputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(this.TARGET_RATE),
        '-f',
        'f32le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const spawnState: { error: Error | null } = { error: null };
    ffmpeg.once('error', (err: Error) => {
      spawnState.error = err;
    });

    const maxStderrBytes = 8192;
    let stderrText = '';
    ffmpeg.stderr.on('data', (d: Buffer) => {
      if (stderrText.length < maxStderrBytes) {
        stderrText += d.toString('utf8').slice(0, maxStderrBytes - stderrText.length);
      }
    });

    const abortHandler = () => {
      ffmpeg.kill('SIGKILL');
    };
    params.abortSignal?.addEventListener('abort', abortHandler, { once: true });

    try {
      yield* this.chunkFloat32LeByteStreamIntoOverlappingWindows({
        byteChunks: ffmpeg.stdout,
        windowDurationSec: params.windowDurationSec,
        overlapDurationSec: params.overlapDurationSec,
        maxAllowedDurationSec: params.maxAllowedDurationSec,
        onKillProcess: () => ffmpeg.kill('SIGKILL'),
        abortSignal: params.abortSignal,
      });

      if (spawnState.error) {
        throw new Error(`FFMPEG_SPAWN_FAILED: ${spawnState.error.message}`);
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        if (ffmpeg.exitCode !== null) resolve(ffmpeg.exitCode);
        else ffmpeg.once('close', resolve);
      });

      if (exitCode !== 0 && !params.abortSignal?.aborted) {
        throw new Error(`FFMPEG_TRANSCODE_FAILED (code=${exitCode}): ${stderrText}`);
      }
    } finally {
      params.abortSignal?.removeEventListener('abort', abortHandler);
      if (ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    }
  }
}
