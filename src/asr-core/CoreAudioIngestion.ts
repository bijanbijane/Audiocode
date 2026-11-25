/**
 * CORE ASR ENGINE — MULTI-FORMAT INGESTION & STEREO PHASE GUARD (MILESTONE CORE-02)
 *
 * Uses local system FFmpeg/FFprobe for real multi-format container decoding
 * (WAV, MP3, FLAC, OGG/Opus, M4A/AAC, WebM) plus native RIFF WAV fast path.
 * Preserves stereo channels for inspection BEFORE canonical 16kHz Mono PCM16 conversion
 * so out-of-phase L/R cancellation or single-dead-channel stereo recordings are never destroyed.
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AudioContainerFormat,
  CoreAudioIngestResult,
  StereoChannelInspection,
} from './CoreAsrContracts';

const MAX_INGEST_BYTES = 128 * 1024 * 1024; // 128 MB hard safety cap against memory/decompression bombs
const MAX_DECODED_DURATION_SEC = 7200; // 2 hours max decoded audio per request
const MAX_DECODED_PCM_BYTES = 128 * 1024 * 1024; // 128 MB hard cap on decoded raw PCM output
const TARGET_SR = 16_000;

export function detectAudioContainerFormat(bytes: Buffer, filename = ''): AudioContainerFormat {
  if (bytes.length >= 12) {
    const riff = bytes.subarray(0, 4).toString('ascii');
    const wave = bytes.subarray(8, 12).toString('ascii');
    if ((riff === 'RIFF' || riff === 'RF64') && wave === 'WAVE') return 'wav';
    if (riff === 'FORM' && (wave === 'AIFF' || wave === 'AIFC')) return 'aiff';
  }
  if (bytes.length >= 4) {
    const magic4 = bytes.subarray(0, 4).toString('ascii');
    if (magic4 === 'fLaC') return 'flac';
    if (magic4 === 'OggS') return 'ogg';
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return 'webm';
    }
    if (bytes.length >= 8 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
      return 'm4a';
    }
    if (magic4.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
      return 'mp3';
    }
  }
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (ext === 'wav' || ext === 'mp3' || ext === 'flac' || ext === 'ogg' || ext === 'm4a' || ext === 'webm' || ext === 'aiff') {
    return ext;
  }
  if (ext === 'aif') return 'aiff';
  if (ext === 'mp4' || ext === 'aac') return 'm4a';
  return 'unknown';
}

export function isFfmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function probeAudioStreamInfo(filePath: string): {
  sampleRateHz: number;
  channels: number;
  codecName: string;
} {
  try {
    const raw = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=sample_rate,channels,codec_name',
        '-of',
        'json',
        filePath,
      ],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(raw) as {
      streams?: Array<{ sample_rate?: string; channels?: number; codec_name?: string }>;
    };
    const s = parsed.streams?.[0];
    return {
      sampleRateHz: Number(s?.sample_rate) || TARGET_SR,
      channels: Number(s?.channels) || 1,
      codecName: s?.codec_name ?? 'unknown',
    };
  } catch {
    return { sampleRateHz: TARGET_SR, channels: 1, codecName: 'unknown' };
  }
}

function rmsDbOfFloat32(samples: Float32Array): number {
  if (samples.length === 0) return -120;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = Number.isFinite(samples[i]) ? samples[i] : 0;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return rms > 1e-6 ? 20 * Math.log10(rms) : -120;
}

/**
 * Inspects multi-channel PCM at 16kHz BEFORE downmixing so out-of-phase or dead-channel
 * stereo files don't silently attenuate to silence.
 */
export function inspectAndDownmixChannels(channels: readonly Float32Array[]): {
  monoFloat32: Float32Array;
  inspection: StereoChannelInspection;
} {
  if (channels.length === 0 || channels[0].length === 0) {
    return {
      monoFloat32: new Float32Array(0),
      inspection: {
        originalChannels: 0,
        policyApplied: 'MONO_PASSTHROUGH',
        leftRmsDb: -120,
        rightRmsDb: -120,
        interChannelCorrelation: 1,
        phaseInversionRisk: false,
        silentChannelDetected: true,
        note: 'Empty channel buffer',
      },
    };
  }

  if (channels.length === 1) {
    const src = channels[0];
    let hasNonFinite = false;
    for (let i = 0; i < src.length; i++) {
      if (!Number.isFinite(src[i])) {
        hasNonFinite = true;
        break;
      }
    }
    const cleanMono = hasNonFinite ? new Float32Array(src.length) : src;
    if (hasNonFinite) {
      for (let i = 0; i < src.length; i++) {
        cleanMono[i] = Number.isFinite(src[i]) ? src[i] : 0;
      }
    }
    const leftDb = rmsDbOfFloat32(cleanMono);
    return {
      monoFloat32: cleanMono,
      inspection: {
        originalChannels: 1,
        policyApplied: 'MONO_PASSTHROUGH',
        leftRmsDb: Number(leftDb.toFixed(2)),
        rightRmsDb: Number(leftDb.toFixed(2)),
        interChannelCorrelation: 1,
        phaseInversionRisk: false,
        silentChannelDetected: leftDb < -75,
        note: 'Single mono channel preserved directly.',
      },
    };
  }

  const left = channels[0];
  const right = channels[1];
  const n = Math.min(left.length, right.length);
  const leftDb = rmsDbOfFloat32(left);
  const rightDb = rmsDbOfFloat32(right);

  let dot = 0;
  let magL = 0;
  let magR = 0;
  for (let i = 0; i < n; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    dot += l * r;
    magL += l * l;
    magR += r * r;
  }
  const denom = Math.sqrt(magL * magR);
  const corr = denom > 1e-12 ? dot / denom : 0;

  const phaseInversionRisk = corr < -0.55;
  const silentLeft = leftDb < -72 && rightDb > -50;
  const silentRight = rightDb < -72 && leftDb > -50;

  const mono = new Float32Array(n);
  if (phaseInversionRisk) {
    for (let i = 0; i < n; i++) {
      const raw = leftDb >= rightDb ? left[i] : right[i];
      mono[i] = Number.isFinite(raw) ? raw : 0;
    }
    return {
      monoFloat32: mono,
      inspection: {
        originalChannels: channels.length,
        policyApplied: 'LEFT_PRIMARY_PHASE_GUARD',
        leftRmsDb: Number(leftDb.toFixed(2)),
        rightRmsDb: Number(rightDb.toFixed(2)),
        interChannelCorrelation: Number(corr.toFixed(3)),
        phaseInversionRisk: true,
        silentChannelDetected: false,
        note: 'Negative L/R correlation detected; kept dominant channel without destructive summing.',
      },
    };
  }

  if (silentLeft || silentRight) {
    const active = leftDb >= rightDb ? left : right;
    for (let i = 0; i < n; i++) {
      mono[i] = Number.isFinite(active[i]) ? active[i] : 0;
    }
    return {
      monoFloat32: mono,
      inspection: {
        originalChannels: channels.length,
        policyApplied: 'DOMINANT_ACTIVE_CHANNEL',
        leftRmsDb: Number(leftDb.toFixed(2)),
        rightRmsDb: Number(rightDb.toFixed(2)),
        interChannelCorrelation: Number(corr.toFixed(3)),
        phaseInversionRisk: false,
        silentChannelDetected: true,
        note: 'One stereo channel is silent; routed active channel cleanly to prevent -6dB loss.',
      },
    };
  }

  for (let i = 0; i < n; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    mono[i] = (l + r) * 0.5;
  }
  return {
    monoFloat32: mono,
    inspection: {
      originalChannels: channels.length,
      policyApplied: 'EQUAL_POWER_AVG',
      leftRmsDb: Number(leftDb.toFixed(2)),
      rightRmsDb: Number(rightDb.toFixed(2)),
      interChannelCorrelation: Number(corr.toFixed(3)),
      phaseInversionRisk: false,
      silentChannelDetected: false,
      note: 'Coherent stereo channels downmixed via equal-amplitude average.',
    },
  };
}

export function float32ToPcm16Buffer(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Number.isFinite(samples[i]) ? samples[i] : 0;
    const clamped = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

export function pcm16BufferToFloat32(buf: Buffer): Float32Array {
  const count = Math.floor(buf.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

export function computeSignalHealth(samples: Float32Array): CoreAudioIngestResult['signalHealth'] {
  if (samples.length === 0) {
    return {
      rmsDb: -120,
      peakDb: -120,
      estimatedSnrDb: 0,
      clippingRatio: 0,
      dcOffset: 0,
      silenceRatio: 1,
      isSilent: true,
    };
  }

  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  let clipCount = 0;
  let silentSamples = 0;

  const winEnergies: number[] = [];
  const winLen = 320; // 20ms @ 16kHz
  for (let start = 0; start < samples.length; start += winLen) {
    const end = Math.min(samples.length, start + winLen);
    let wSq = 0;
    for (let i = start; i < end; i++) {
      const s = Number.isFinite(samples[i]) ? samples[i] : 0;
      sum += s;
      const sq = s * s;
      sumSq += sq;
      wSq += sq;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      if (abs >= 0.985) clipCount++;
      if (abs < 0.008) silentSamples++;
    }
    winEnergies.push(Math.sqrt(wSq / Math.max(1, end - start)));
  }

  winEnergies.sort((a, b) => a - b);
  const noiseFloor = winEnergies[Math.floor(winEnergies.length * 0.1)] ?? 1e-4;
  const speechLevel = winEnergies[Math.floor(winEnergies.length * 0.9)] ?? noiseFloor;
  const snrDb = noiseFloor > 1e-6 ? 20 * Math.log10(Math.max(1e-6, speechLevel) / noiseFloor) : 45;

  const rms = Math.sqrt(sumSq / samples.length);
  const rmsDb = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
  const clippingRatio = clipCount / samples.length;
  const dcOffset = sum / samples.length;
  const silenceRatio = silentSamples / samples.length;

  return {
    rmsDb: Number(rmsDb.toFixed(2)),
    peakDb: Number(peakDb.toFixed(2)),
    estimatedSnrDb: Number(Math.max(0, Math.min(80, snrDb)).toFixed(2)),
    clippingRatio: Number(clippingRatio.toFixed(5)),
    dcOffset: Number(dcOffset.toFixed(5)),
    silenceRatio: Number(silenceRatio.toFixed(3)),
    isSilent: rmsDb < -65,
  };
}

/**
 * Decodes WAV/MP3/FLAC/OGG/M4A/WebM or raw canonical PCM16 into canonical 16kHz Mono PCM16.
 */
export function ingestAudioBufferToCanonical16kMono(params: {
  recordingId?: string;
  filename: string;
  rawBytes: Buffer;
  rawPcm16Hint?: boolean;
}): CoreAudioIngestResult {
  const { filename, rawBytes, rawPcm16Hint = false } = params;
  const recordingId = params.recordingId ?? `rec_${crypto.randomBytes(6).toString('hex')}`;

  if (!rawBytes || rawBytes.length === 0) {
    throw new Error('AUDIO_INGEST_EMPTY: Audio payload is empty.');
  }
  if (rawBytes.length > MAX_INGEST_BYTES) {
    throw new Error(`AUDIO_INGEST_LIMIT_EXCEEDED: Payload exceeds ${MAX_INGEST_BYTES} bytes.`);
  }

  const audioSha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
  const warnings: string[] = [];

  if (rawPcm16Hint) {
    if (rawBytes.length % 2 !== 0) {
      throw new Error('AUDIO_INGEST_INVALID_PCM16: Raw PCM16 payload must have an even byte length.');
    }
    if (rawBytes.length > MAX_DECODED_PCM_BYTES) {
      throw new Error(
        `AUDIO_INGEST_DECODED_LIMIT_EXCEEDED: Raw PCM16 payload exceeds ${MAX_DECODED_PCM_BYTES} bytes.`,
      );
    }
    const f32 = pcm16BufferToFloat32(rawBytes);
    const durationSec = f32.length / TARGET_SR;
    if (durationSec > MAX_DECODED_DURATION_SEC) {
      throw new Error(
        `AUDIO_INGEST_DECODED_LIMIT_EXCEEDED: Raw PCM16 duration (${durationSec.toFixed(1)}s) exceeds ${MAX_DECODED_DURATION_SEC}s.`,
      );
    }
    const health = computeSignalHealth(f32);
    if (health.isSilent) warnings.push('Audio signal RMS is below -65 dBFS (near-silent input).');
    return {
      recordingId,
      sourceFilename: path.basename(filename || 'stream.pcm'),
      detectedFormat: 'pcm16',
      decoderUsed: 'raw_pcm16',
      originalSampleRateHz: TARGET_SR,
      originalChannels: 1,
      canonicalSampleRateHz: TARGET_SR,
      canonicalChannels: 1,
      canonicalPcm16: rawBytes,
      canonicalFloat32: f32,
      sampleCount: f32.length,
      durationSec: Number(durationSec.toFixed(4)),
      audioSha256,
      stereoInspection: inspectAndDownmixChannels([f32]).inspection,
      signalHealth: health,
      warnings,
    };
  }

  const detectedFormat = detectAudioContainerFormat(rawBytes, filename);
  if (detectedFormat === 'unknown') {
    throw new Error('AUDIO_INGEST_UNSUPPORTED_MAGIC: File signature does not match supported audio containers.');
  }

  if (!isFfmpegAvailable()) {
    throw new Error('AUDIO_DECODER_UNAVAILABLE: System ffmpeg binary is missing.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avapardaz-ingest-'));
  const ext = detectedFormat === 'pcm16' ? 'wav' : detectedFormat;
  const inputPath = path.join(tmpDir, `input.${ext}`);
  const outStereo16kRaw = path.join(tmpDir, 'out_16k_stereo_or_mono.s16');

  try {
    fs.writeFileSync(inputPath, rawBytes);
    const streamInfo = probeAudioStreamInfo(inputPath);
    // Preserve 2 channels for stereo so L/R Stereo Phase Guard runs;
    // for >2ch surround (e.g. 5.1/7.1), let FFmpeg downmix ALL channels to mono (-ac 1)
    // instead of truncating channels 3..N (such as the center dialogue channel).
    const probeChannels = streamInfo.channels === 2 ? 2 : 1;

    // Decode via ffmpeg at 16kHz with strict duration & output size caps
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        inputPath,
        '-vn',
        '-t',
        String(MAX_DECODED_DURATION_SEC),
        '-fs',
        String(MAX_DECODED_PCM_BYTES),
        '-af',
        'aresample=resampler=soxr:precision=28',
        '-acodec',
        'pcm_s16le',
        '-ar',
        String(TARGET_SR),
        '-ac',
        String(probeChannels),
        '-f',
        's16le',
        outStereo16kRaw,
      ],
      { timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const decodedStat = fs.statSync(outStereo16kRaw);
    if (decodedStat.size > MAX_DECODED_PCM_BYTES) {
      throw new Error(
        `AUDIO_INGEST_DECODED_LIMIT_EXCEEDED: Decoded PCM exceeds ${MAX_DECODED_PCM_BYTES} bytes.`,
      );
    }
    const decodedBuf = fs.readFileSync(outStereo16kRaw);
    const totalSamplesAllCh = Math.floor(decodedBuf.length / 2);
    const frames = Math.floor(totalSamplesAllCh / probeChannels);

    const channels: Float32Array[] = [];
    for (let c = 0; c < probeChannels; c++) {
      channels.push(new Float32Array(frames));
    }
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < probeChannels; c++) {
        channels[c][i] = decodedBuf.readInt16LE((i * probeChannels + c) * 2) / 32768;
      }
    }

    const { monoFloat32, inspection } = inspectAndDownmixChannels(channels);
    const canonicalPcm16 = float32ToPcm16Buffer(monoFloat32);
    const signalHealth = computeSignalHealth(monoFloat32);

    if (inspection.phaseInversionRisk) {
      warnings.push('Phase inversion risk between L/R channels mitigated via primary-channel guard.');
    }
    if (signalHealth.clippingRatio > 0.01) {
      warnings.push(`Clipping ratio elevated (${(signalHealth.clippingRatio * 100).toFixed(2)}%).`);
    }
    if (signalHealth.isSilent) {
      warnings.push('Audio signal RMS is below -65 dBFS (near-silent input).');
    }

    return {
      recordingId,
      sourceFilename: path.basename(filename || `audio.${ext}`),
      detectedFormat,
      decoderUsed: 'ffmpeg',
      originalSampleRateHz: streamInfo.sampleRateHz,
      originalChannels: streamInfo.channels,
      canonicalSampleRateHz: TARGET_SR,
      canonicalChannels: 1,
      canonicalPcm16,
      canonicalFloat32: monoFloat32,
      sampleCount: monoFloat32.length,
      durationSec: Number((monoFloat32.length / TARGET_SR).toFixed(4)),
      audioSha256,
      stereoInspection: inspection,
      signalHealth,
      warnings,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runProcessWithPipeBytes(params: {
  readonly bin: 'ffmpeg' | 'ffprobe';
  readonly args: readonly string[];
  readonly stdinBytes?: Buffer;
  readonly maxStdoutBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly stdout: Buffer; readonly stderr: string }> {
  const { bin, args, stdinBytes, maxStdoutBytes, timeoutMs, signal } = params;
  if (signal?.aborted) {
    throw new Error('AUDIO_INGEST_CANCELLED: Audio decoding cancelled before start.');
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: [stdinBytes ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore kill error
        }
      }
      reject(err);
    };

    const onAbort = () => {
      fail(new Error('AUDIO_INGEST_CANCELLED: Audio decoding cancelled via AbortSignal.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      fail(new Error(`AUDIO_INGEST_TIMEOUT: ${bin} exceeded ${timeoutMs}ms timeout.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxStdoutBytes) {
        fail(
          new Error(
            `AUDIO_INGEST_DECODED_LIMIT_EXCEEDED: Decoded stream exceeds ${maxStdoutBytes} bytes.`,
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrChunks.reduce((acc, b) => acc + b.length, 0) < 16_384) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`FFMPEG_PIPE_EXIT_${code}: ${stderrText || 'Unknown error'}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks, stdoutLen),
        stderr: stderrText,
      });
    });

    if (stdinBytes && child.stdin) {
      child.stdin.on('error', () => {
        // Ignore EPIPE when ffmpeg exits early on invalid stream
      });
      child.stdin.end(stdinBytes);
    }
  });
}

async function probeAudioStreamInfoAsync(params: {
  readonly inputSource: { readonly kind: 'pipe'; readonly bytes: Buffer } | { readonly kind: 'file'; readonly filePath: string };
  readonly signal?: AbortSignal;
}): Promise<{
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly codecName: string;
}> {
  try {
    const targetArg = params.inputSource.kind === 'pipe' ? 'pipe:0' : params.inputSource.filePath;
    const { stdout } = await runProcessWithPipeBytes({
      bin: 'ffprobe',
      args: [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=sample_rate,channels,codec_name',
        '-of',
        'json',
        targetArg,
      ],
      stdinBytes: params.inputSource.kind === 'pipe' ? params.inputSource.bytes : undefined,
      maxStdoutBytes: 256 * 1024,
      timeoutMs: 8_000,
      signal: params.signal,
    });
    const parsed = JSON.parse(stdout.toString('utf8')) as {
      streams?: Array<{ sample_rate?: string; channels?: number; codec_name?: string }>;
    };
    const s = parsed.streams?.[0];
    return {
      sampleRateHz: Number(s?.sample_rate) || TARGET_SR,
      channels: Number(s?.channels) || 1,
      codecName: s?.codec_name ?? 'unknown',
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('AUDIO_INGEST_CANCELLED')) {
      throw err;
    }
    return { sampleRateHz: TARGET_SR, channels: 1, codecName: 'unknown' };
  }
}

/**
 * Non-blocking async multi-format ingestion via FFmpeg `pipe:0 -> pipe:1` (`f32le` + `soxr:precision=28`).
 * Avoids blocking the Node.js event loop and writes ZERO temporary files for streamable containers
 * (MP3, FLAC, OGG, WebM, WAV, AIFF). Uses a `0o600` temp file fallback only if pipe demuxing fails
 * (e.g., non-faststart MP4/M4A moov-at-end).
 */
export async function ingestAudioBufferToCanonical16kMonoAsync(params: {
  recordingId?: string;
  filename: string;
  rawBytes: Buffer;
  rawPcm16Hint?: boolean;
  signal?: AbortSignal;
  includePcm16?: boolean;
}): Promise<CoreAudioIngestResult> {
  const { filename, rawBytes, rawPcm16Hint = false, signal, includePcm16 = true } = params;
  const recordingId = params.recordingId ?? `rec_${crypto.randomBytes(6).toString('hex')}`;

  if (signal?.aborted) {
    throw new Error('AUDIO_INGEST_CANCELLED: Audio decoding cancelled before start.');
  }
  if (!rawBytes || rawBytes.length === 0) {
    throw new Error('AUDIO_INGEST_EMPTY: Audio payload is empty.');
  }
  if (rawBytes.length > MAX_INGEST_BYTES) {
    throw new Error(`AUDIO_INGEST_LIMIT_EXCEEDED: Payload exceeds ${MAX_INGEST_BYTES} bytes.`);
  }

  if (rawPcm16Hint) {
    const syncRes = ingestAudioBufferToCanonical16kMono({
      recordingId,
      filename,
      rawBytes,
      rawPcm16Hint: true,
    });
    return includePcm16
      ? syncRes
      : { ...syncRes, canonicalPcm16: Buffer.alloc(0) };
  }

  const audioSha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
  const warnings: string[] = [];
  const detectedFormat = detectAudioContainerFormat(rawBytes, filename);
  if (detectedFormat === 'unknown') {
    throw new Error('AUDIO_INGEST_UNSUPPORTED_MAGIC: File signature does not match supported audio containers.');
  }

  const maxFloatStdoutBytes = MAX_DECODED_PCM_BYTES * 2;
  const buildFfmpegArgs = (inputArg: string, probeChannels: number): string[] => [
    '-y',
    '-v',
    'error',
    '-i',
    inputArg,
    '-vn',
    '-t',
    String(MAX_DECODED_DURATION_SEC),
    '-af',
    'aresample=resampler=soxr:precision=28',
    '-acodec',
    'pcm_f32le',
    '-ar',
    String(TARGET_SR),
    '-ac',
    String(probeChannels),
    '-f',
    'f32le',
    'pipe:1',
  ];

  let streamInfo: { readonly sampleRateHz: number; readonly channels: number; readonly codecName: string };
  let probeChannels: number;
  let decodedFloatBuf: Buffer;

  const tryPipeDecode = async () => {
    const probed = await probeAudioStreamInfoAsync({
      inputSource: { kind: 'pipe', bytes: rawBytes },
      signal,
    });
    const pChannels = probed.channels === 2 ? 2 : 1;
    const { stdout } = await runProcessWithPipeBytes({
      bin: 'ffmpeg',
      args: buildFfmpegArgs('pipe:0', pChannels),
      stdinBytes: rawBytes,
      maxStdoutBytes: maxFloatStdoutBytes,
      timeoutMs: 25_000,
      signal,
    });
    return { probed, pChannels, stdout };
  };

  const ext = detectedFormat === 'pcm16' ? 'wav' : detectedFormat;
  if (detectedFormat !== 'm4a') {
    try {
      const pipeRes = await tryPipeDecode();
      streamInfo = pipeRes.probed;
      probeChannels = pipeRes.pChannels;
      decodedFloatBuf = pipeRes.stdout;
    } catch (pipeErr) {
      if (
        pipeErr instanceof Error &&
        (pipeErr.message.includes('AUDIO_INGEST_CANCELLED') ||
          pipeErr.message.includes('AUDIO_INGEST_DECODED_LIMIT_EXCEEDED'))
      ) {
        throw pipeErr;
      }
      // Re-try with 0o600 temp file only when pipe demux cannot seek cleanly
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'avapardaz-ingest-'));
      await fs.promises.chmod(tmpDir, 0o700).catch(() => {});
      const inputPath = path.join(tmpDir, `input.${ext}`);
      try {
        await fs.promises.writeFile(inputPath, rawBytes, { mode: 0o600 });
        streamInfo = await probeAudioStreamInfoAsync({
          inputSource: { kind: 'file', filePath: inputPath },
          signal,
        });
        probeChannels = streamInfo.channels === 2 ? 2 : 1;
        const { stdout } = await runProcessWithPipeBytes({
          bin: 'ffmpeg',
          args: buildFfmpegArgs(inputPath, probeChannels),
          maxStdoutBytes: maxFloatStdoutBytes,
          timeoutMs: 25_000,
          signal,
        });
        decodedFloatBuf = stdout;
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } else {
    // M4A/MP4 often places moov atom at EOF; try pipe first, fallback cleanly to 0o600 temp file if unseekable
    try {
      const pipeRes = await tryPipeDecode();
      streamInfo = pipeRes.probed;
      probeChannels = pipeRes.pChannels;
      decodedFloatBuf = pipeRes.stdout;
    } catch (pipeErr) {
      if (
        pipeErr instanceof Error &&
        (pipeErr.message.includes('AUDIO_INGEST_CANCELLED') ||
          pipeErr.message.includes('AUDIO_INGEST_DECODED_LIMIT_EXCEEDED'))
      ) {
        throw pipeErr;
      }
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'avapardaz-ingest-'));
      await fs.promises.chmod(tmpDir, 0o700).catch(() => {});
      const inputPath = path.join(tmpDir, `input.${ext}`);
      try {
        await fs.promises.writeFile(inputPath, rawBytes, { mode: 0o600 });
        streamInfo = await probeAudioStreamInfoAsync({
          inputSource: { kind: 'file', filePath: inputPath },
          signal,
        });
        probeChannels = streamInfo.channels === 2 ? 2 : 1;
        const { stdout } = await runProcessWithPipeBytes({
          bin: 'ffmpeg',
          args: buildFfmpegArgs(inputPath, probeChannels),
          maxStdoutBytes: maxFloatStdoutBytes,
          timeoutMs: 25_000,
          signal,
        });
        decodedFloatBuf = stdout;
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  const totalSamplesAllCh = Math.floor(decodedFloatBuf.length / 4);
  const frames = Math.floor(totalSamplesAllCh / probeChannels);
  const channels: Float32Array[] = [];
  for (let c = 0; c < probeChannels; c++) {
    channels.push(new Float32Array(frames));
  }
  const view = new DataView(decodedFloatBuf.buffer, decodedFloatBuf.byteOffset, decodedFloatBuf.byteLength);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < probeChannels; c++) {
      const s = view.getFloat32((i * probeChannels + c) * 4, true);
      channels[c][i] = Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : 0;
    }
  }

  const { monoFloat32, inspection } = inspectAndDownmixChannels(channels);
  const canonicalPcm16 = includePcm16 ? float32ToPcm16Buffer(monoFloat32) : Buffer.alloc(0);
  const signalHealth = computeSignalHealth(monoFloat32);

  if (inspection.phaseInversionRisk) {
    warnings.push('Phase inversion risk between L/R channels mitigated via primary-channel guard.');
  }
  if (signalHealth.clippingRatio > 0.01) {
    warnings.push(`Clipping ratio elevated (${(signalHealth.clippingRatio * 100).toFixed(2)}%).`);
  }
  if (signalHealth.isSilent) {
    warnings.push('Audio signal RMS is below -65 dBFS (near-silent input).');
  }

  return {
    recordingId,
    sourceFilename: path.basename(filename || `audio.${ext}`),
    detectedFormat,
    decoderUsed: 'ffmpeg',
    originalSampleRateHz: streamInfo.sampleRateHz,
    originalChannels: streamInfo.channels,
    canonicalSampleRateHz: TARGET_SR,
    canonicalChannels: 1,
    canonicalPcm16,
    canonicalFloat32: monoFloat32,
    sampleCount: monoFloat32.length,
    durationSec: Number((monoFloat32.length / TARGET_SR).toFixed(4)),
    audioSha256,
    stereoInspection: inspection,
    signalHealth,
    warnings,
  };
}

/**
 * Helper to synthesize deterministic multi-formant speech-like waveform in CPU
 * (for hermetic multi-format encoding & acoustic recognition evaluation without pre-recorded MP3/FLAC on disk).
 */
export function encodeFloat32ToContainerWithFfmpeg(
  samples16k: Float32Array,
  format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm',
  sampleRate = 16_000,
): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avapardaz-enc-'));
  const pcmPath = path.join(tmpDir, 'src.s16');
  const outPath = path.join(tmpDir, `out.${format}`);
  try {
    fs.writeFileSync(pcmPath, float32ToPcm16Buffer(samples16k));
    const codecArgs =
      format === 'wav'
        ? ['-acodec', 'pcm_s16le']
        : format === 'mp3'
          ? ['-acodec', 'libmp3lame', '-b:a', '128k']
          : format === 'flac'
            ? ['-acodec', 'flac']
            : format === 'ogg'
              ? ['-acodec', 'libopus', '-b:a', '64k']
              : format === 'm4a'
                ? ['-acodec', 'aac', '-b:a', '96k']
                : ['-acodec', 'libopus', '-b:a', '64k'];

    execFileSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmPath, ...codecArgs, outPath],
      { timeout: 15_000 },
    );
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Removes orphaned `avapardaz-ingest-*` / `avapardaz-enc-*` temporary directories left behind
 * in `os.tmpdir()` after abrupt process termination (SIGKILL/OOM). Safe to call at server startup.
 */
export function cleanupOrphanedCoreIngestionTempFiles(options?: {
  readonly tmpRoot?: string;
  readonly maxAgeMs?: number;
}): { readonly removedCount: number; readonly removedPaths: readonly string[] } {
  const tmpRoot = options?.tmpRoot ?? os.tmpdir();
  const maxAgeMs = Math.max(0, options?.maxAgeMs ?? 15 * 60 * 1000);
  const cutoffMs = Date.now() - maxAgeMs;
  const removedPaths: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return { removedCount: 0, removedPaths };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('avapardaz-ingest-') && !entry.name.startsWith('avapardaz-enc-')) {
      continue;
    }
    const fullPath = path.join(tmpRoot, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (maxAgeMs === 0 || stat.mtimeMs <= cutoffMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removedPaths.push(fullPath);
      }
    } catch {
      // Ignore transient races with concurrent cleanup
    }
  }
  return { removedCount: removedPaths.length, removedPaths };
}
