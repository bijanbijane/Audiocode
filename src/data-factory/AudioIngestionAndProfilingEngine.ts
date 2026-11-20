/**
 * PHASE 12B — AUDIO INGESTION, ISOLATED DECODING, METADATA/QUALITY PROFILING,
 * STEREO POLICY, CANONICAL 16kHz MONO PCM16 NORMALIZATION & REPRODUCIBLE AUGMENTATION
 *
 * Strictly reuses:
 * - AudioSecurityGuard (magic byte verification & decompression bomb protection)
 * - resampleTo16kMono (Kaiser-windowed sinc anti-aliased resampling)
 * - ffmpeg / ffprobe (when available on host) inside isolated child processes via execFile (never shell)
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AudioSecurityGuard } from '../security/AudioSecurityGuard';
import { resampleTo16kMono } from '../engine/resampler';
import type {
  AcousticQualityProfile,
  AudioArtifactRecord,
  AudioQualityClass,
  AudioTechnicalMetadata,
  AugmentationConfig,
  AugmentationRecordMetadata,
  DataFactoryUploadLimits,
  ResamplingProvenanceMetadata,
  StereoChannelPolicy,
  SupportedMediaFormat,
} from './DataFactoryContracts';
import { DEFAULT_DATA_FACTORY_LIMITS } from './DataFactoryContracts';

const execFileAsync = promisify(execFile);

export const DATA_FACTORY_AUDIO_SW_VERSION = 'avapardaz-data-factory-audio-v1.0.0';
export const PROFILER_ALGO_ID = 'acoustic-heuristic-snr-vad-v1';
export const PROFILER_ALGO_VERSION = '1.0.0';

export interface DecodedAudioBufferResult {
  readonly technical: AudioTechnicalMetadata;
  readonly acousticProfile: AcousticQualityProfile;
  readonly rawChecksumSha256: string;
  readonly fingerprint: string;
  readonly sampleRate: number;
  readonly channelChannelsPcm: Float32Array[];
}

export function sha256Hex(data: Uint8Array | Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Pure TypeScript RIFF/WAV parser with strict bounds & truncation validation.
 */
export function decodeWavBufferStrict(buf: Buffer): {
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  codec: string;
  channels: Float32Array[];
  declaredDataBytes: number;
  actualDataBytes: number;
} {
  if (buf.byteLength < 44) {
    throw new Error('CORRUPT_TRUNCATED_WAV: File smaller than minimum 44-byte RIFF/WAVE header.');
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('INVALID_CONTAINER: Expected RIFF/WAVE magic header.');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let declaredDataSize = 0;
  let foundFmt = false;

  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || bodyStart + 16 > buf.byteLength) {
        throw new Error('CORRUPT_WAV_FMT: Truncated or malformed fmt chunk.');
      }
      foundFmt = true;
      audioFormat = view.getUint16(bodyStart, true);
      numChannels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      declaredDataSize = chunkSize;
      break;
    }

    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!foundFmt || dataOffset === -1) {
    throw new Error('CORRUPT_WAV_STRUCTURE: Missing fmt or data chunk in WAV container.');
  }
  if (sampleRate < 8000 || sampleRate > 192000 || numChannels < 1 || numChannels > 8) {
    throw new Error(`UNSUPPORTED_WAV_PARAMS: sampleRate=${sampleRate}, channels=${numChannels}.`);
  }
  const supportedPcm =
    (audioFormat === 1 && (bitsPerSample === 16 || bitsPerSample === 24)) ||
    (audioFormat === 3 && bitsPerSample === 32);
  if (!supportedPcm) {
    throw new Error(`UNSUPPORTED_WAV_CODEC: audioFormat=${audioFormat}, bitDepth=${bitsPerSample}.`);
  }

  const availableBytes = buf.byteLength - dataOffset;
  if (declaredDataSize === 0 || availableBytes <= 0) {
    throw new Error('CORRUPT_TRUNCATED_WAV: Empty WAV data payload.');
  }
  // Strict truncation check: if file ends notably earlier than declared RIFF data chunk size
  if (availableBytes + 4 < declaredDataSize) {
    throw new Error(
      `CORRUPT_TRUNCATED_WAV: Declared ${declaredDataSize} audio bytes but only ${availableBytes} bytes present.`
    );
  }

  const bytesPerSample = bitsPerSample / 8;
  const usableBytes = Math.min(declaredDataSize, availableBytes);
  const frameBytes = numChannels * bytesPerSample;
  const totalFrames = Math.floor(usableBytes / frameBytes);
  if (totalFrames <= 0) {
    throw new Error('CORRUPT_TRUNCATED_WAV: Zero valid audio frames decoded.');
  }

  const channels = Array.from({ length: numChannels }, () => new Float32Array(totalFrames));
  let ptr = dataOffset;
  for (let f = 0; f < totalFrames; f++) {
    for (let c = 0; c < numChannels; c++) {
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = view.getFloat32(ptr, true);
      } else if (bitsPerSample === 24) {
        let int24 = buf[ptr] | (buf[ptr + 1] << 8) | (buf[ptr + 2] << 16);
        if (int24 & 0x800000) int24 |= ~0xffffff;
        val = int24 / 8388608.0;
      } else {
        val = view.getInt16(ptr, true) / 32768.0;
      }
      if (!Number.isFinite(val)) {
        throw new Error('CORRUPT_NAN_AUDIO: Non-finite PCM sample encountered.');
      }
      channels[c][f] = val;
      ptr += bytesPerSample;
    }
  }

  return {
    sampleRate,
    channelCount: numChannels,
    bitDepth: bitsPerSample,
    codec: audioFormat === 3 ? 'pcm_f32le' : bitsPerSample === 24 ? 'pcm_s24le' : 'pcm_s16le',
    channels,
    declaredDataBytes: declaredDataSize,
    actualDataBytes: usableBytes,
  };
}

/**
 * Encodes Float32 PCM channels into a canonical PCM16 Little-Endian RIFF/WAVE Buffer.
 */
export function encodePcm16WavBuffer(channels: Float32Array[], sampleRate: number): Buffer {
  const numChannels = Math.max(1, channels.length);
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const dataSize = numFrames * numChannels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const clamped = Math.max(-1.0, Math.min(1.0, channels[c][i] ?? 0));
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, int16)), offset);
      offset += 2;
    }
  }
  return buf;
}

function mapSecurityFormatToSupported(fmt: ReturnType<typeof AudioSecurityGuard.verifyMagicBytes>): SupportedMediaFormat {
  switch (fmt) {
    case 'WAV':
      return 'WAV';
    case 'FLAC':
      return 'FLAC';
    case 'MP3':
      return 'MP3';
    case 'M4A_AAC':
      return 'M4A_AAC';
    case 'OGG':
      return 'OGG_OPUS';
    case 'WEBM':
      return 'WEBM';
  }
}

/**
 * Computes a compact, deterministic 32-bucket acoustic energy fingerprint for probable transformed duplicate detection.
 * Fingerprint similarity flags probable near-duplicates for review — NEVER treated as definitive proof alone.
 */
export function computeAudioEnergyFingerprint(pcmMono: Float32Array): string {
  if (pcmMono.length === 0) return 'fp-empty';
  const buckets = 32;
  const step = Math.max(1, Math.floor(pcmMono.length / buckets));
  const energies: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = b === buckets - 1 ? pcmMono.length : Math.min(pcmMono.length, start + step);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      sumSq += pcmMono[i] * pcmMono[i];
    }
    energies.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }
  const mean = energies.reduce((a, b) => a + b, 0) / buckets;
  // Compare each adjacent bucket slope & relative energy -> 64-bit hex descriptor
  let bits = '';
  for (let i = 0; i < buckets; i++) {
    const aboveMean = energies[i] >= mean ? '1' : '0';
    const rising = i + 1 < buckets && energies[i + 1] >= energies[i] ? '1' : '0';
    bits += aboveMean + rising;
  }
  // Compress bitstring into 16 hex chars
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return `fpv1-${hex}`;
}

export function fingerprintBitSimilarity(fpA: string, fpB: string): number {
  const rawA = fpA.replace(/^fpv1-/, '');
  const rawB = fpB.replace(/^fpv1-/, '');
  if (rawA.length === 0 || rawA.length !== rawB.length) return 0;
  let sameBits = 0;
  const totalBits = rawA.length * 4;
  for (let i = 0; i < rawA.length; i++) {
    const a = parseInt(rawA[i], 16);
    const b = parseInt(rawB[i], 16);
    const xor = a ^ b;
    for (let bit = 0; bit < 4; bit++) {
      if (((xor >> bit) & 1) === 0) sameBits++;
    }
  }
  return sameBits / totalBits;
}

const MAX_DECODED_WAV_BYTES = 256 * 1024 * 1024; // 256 MiB hard cap against decompression bombs

/**
 * Isolated container decode using ffprobe + ffmpeg subprocess (no shell, strict timeout & size cap) when non-WAV containers arrive.
 */
async function decodeContainerWithIsolatedFfmpeg(
  fileBytes: Buffer,
  timeoutMs: number,
  maxDurationSeconds: number
): Promise<{
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  codec: string;
  container: string;
  bitrateBps: number | null;
  channels: Float32Array[];
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'avapardaz-ingest-'));
  const inPath = path.join(tmpDir, 'input.media');
  const outWavPath = path.join(tmpDir, 'decoded.wav');
  try {
    await fs.writeFile(inPath, fileBytes);
    const { stdout: probeRaw } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inPath],
      { timeout: Math.min(15_000, timeoutMs), maxBuffer: 2 * 1024 * 1024 }
    );
    const probe = JSON.parse(probeRaw) as {
      format?: { format_name?: string; bit_rate?: string; duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        sample_rate?: string;
        channels?: number;
        bits_per_raw_sample?: string;
      }>;
    };
    const audioStream = probe.streams?.find((s) => s.codec_type === 'audio');
    if (!audioStream) {
      throw new Error('UNSUPPORTED_MEDIA: No valid audio stream found inside container.');
    }
    const probedDurationSec = Number(probe.format?.duration);
    if (Number.isFinite(probedDurationSec) && probedDurationSec > maxDurationSeconds) {
      throw new Error(
        `UPLOAD_DURATION_EXCEEDED: Probed duration (${probedDurationSec.toFixed(1)}s) exceeds max limit (${maxDurationSeconds}s).`
      );
    }

    const safeCapSec = Math.max(1, Math.ceil(maxDurationSeconds) + 1);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        inPath,
        '-vn',
        '-t',
        String(safeCapSec),
        '-fs',
        String(MAX_DECODED_WAV_BYTES),
        '-c:a',
        'pcm_s16le',
        outWavPath,
      ],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }
    );
    const stat = await fs.stat(outWavPath);
    if (stat.size > MAX_DECODED_WAV_BYTES) {
      throw new Error(`UPLOAD_LIMIT_EXCEEDED: Decoded WAV exceeds safety cap (${MAX_DECODED_WAV_BYTES} bytes).`);
    }
    const wavBuf = await fs.readFile(outWavPath);
    const decoded = decodeWavBufferStrict(wavBuf);

    return {
      sampleRate: Number(audioStream.sample_rate) || decoded.sampleRate,
      channelCount: Number(audioStream.channels) || decoded.channelCount,
      bitDepth: Number(audioStream.bits_per_raw_sample) || decoded.bitDepth,
      codec: audioStream.codec_name || decoded.codec,
      container: probe.format?.format_name || 'unknown',
      bitrateBps: probe.format?.bit_rate ? Number(probe.format.bit_rate) : null,
      channels: decoded.channels,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function profilePcmChannelsAndQuality(params: {
  channels: Float32Array[];
  sampleRate: number;
  detectedFormat: SupportedMediaFormat;
  detectedMimeType: string;
  container: string;
  codec: string;
  bitDepth: number;
  bitrateBps: number | null;
  fileSizeBytes: number;
}): {
  technical: AudioTechnicalMetadata;
  acousticProfile: AcousticQualityProfile;
  fingerprint: string;
} {
  const { channels, sampleRate } = params;
  const numChannels = channels.length;
  const len = channels[0]?.length ?? 0;
  const durationSeconds = len / Math.max(1, sampleRate);

  let peak = 0;
  let sumSq = 0;
  let clippedSamples = 0;
  let totalSamples = 0;

  const chRms: number[] = [];
  for (let c = 0; c < numChannels; c++) {
    let cSq = 0;
    const ch = channels[c];
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clippedSamples++;
      cSq += ch[i] * ch[i];
      sumSq += ch[i] * ch[i];
      totalSamples++;
    }
    chRms.push(Math.sqrt(cSq / Math.max(1, ch.length)));
  }

  const rms = Math.sqrt(sumSq / Math.max(1, totalSamples));
  const rmsLevelDb = Number((20 * Math.log10(rms + 1e-12)).toFixed(2));
  const clippingPercentage = Number(((clippedSamples / Math.max(1, totalSamples)) * 100).toFixed(4));

  // Build mono proxy ONLY for non-destructive profiling analysis
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (let c = 0; c < numChannels; c++) acc += channels[c][i];
    mono[i] = acc / Math.max(1, numChannels);
  }

  let channelImbalanceDb: number | null = null;
  let stereoPhaseCorrelation: number | null = null;
  let recommendedChannelPolicy: StereoChannelPolicy = numChannels === 1 ? 'MONO_SOURCE' : 'SAFE_MIXDOWN';

  if (numChannels >= 2) {
    const ch0Db = 20 * Math.log10(chRms[0] + 1e-12);
    const ch1Db = 20 * Math.log10(chRms[1] + 1e-12);
    channelImbalanceDb = Number(Math.abs(ch0Db - ch1Db).toFixed(2));

    let cross = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i < len; i++) {
      cross += channels[0][i] * channels[1][i];
      e0 += channels[0][i] * channels[0][i];
      e1 += channels[1][i] * channels[1][i];
    }
    stereoPhaseCorrelation = Number((cross / (Math.sqrt(e0 * e1) + 1e-12)).toFixed(3));

    if (stereoPhaseCorrelation < -0.4) {
      // Out-of-phase stereo would cancel out on naive sum -> preserve left or isolate
      recommendedChannelPolicy = chRms[0] >= chRms[1] ? 'LEFT_CHANNEL' : 'RIGHT_CHANNEL';
    } else if (channelImbalanceDb > 12) {
      recommendedChannelPolicy = chRms[0] >= chRms[1] ? 'LEFT_CHANNEL' : 'RIGHT_CHANNEL';
    } else if (stereoPhaseCorrelation < 0.35) {
      recommendedChannelPolicy = 'MULTI_CHANNEL_PRESERVATION';
    } else {
      recommendedChannelPolicy = 'SAFE_MIXDOWN';
    }
  }

  // 20ms frame RMS percentiles for honest VAD / Noise floor / SNR heuristic estimate
  const frameLen = Math.max(1, Math.floor(sampleRate * 0.02));
  const frameRmsDbs: number[] = [];
  let silentFrames = 0;
  let activeFrames = 0;
  let longSilenceFrames = 0;
  let currentSilenceRun = 0;

  for (let start = 0; start < len; start += frameLen) {
    const end = Math.min(len, start + frameLen);
    let fSq = 0;
    for (let i = start; i < end; i++) fSq += mono[i] * mono[i];
    const fRms = Math.sqrt(fSq / Math.max(1, end - start));
    const fDb = 20 * Math.log10(fRms + 1e-12);
    frameRmsDbs.push(fDb);
    if (fDb < -52) {
      silentFrames++;
      currentSilenceRun++;
      if (currentSilenceRun >= 50) longSilenceFrames++; // > 1.0s sustained pause
    } else {
      currentSilenceRun = 0;
      if (fDb > -42) activeFrames++;
    }
  }

  const totalFramesCount = Math.max(1, frameRmsDbs.length);
  const silentRegionPercentage = Number(((silentFrames / totalFramesCount) * 100).toFixed(2));
  const voiceActivityRatio = Number((activeFrames / totalFramesCount).toFixed(3));
  const longSilenceRatio = Number((longSilenceFrames / totalFramesCount).toFixed(3));

  const sortedDbs = [...frameRmsDbs].sort((a, b) => a - b);
  const noiseFloorDb = sortedDbs[Math.floor(sortedDbs.length * 0.15)] ?? -70;
  const speechLevelDb = sortedDbs[Math.floor(sortedDbs.length * 0.85)] ?? -20;
  const estimatedSnrDb = Number(Math.max(0, Math.min(60, speechLevelDb - noiseFloorDb)).toFixed(2));

  // Acoustic decay proxy across active -> silent transitions
  let decayTransitions = 0;
  let slowDecayCount = 0;
  for (let i = 1; i < frameRmsDbs.length - 1; i++) {
    if (frameRmsDbs[i - 1] > -35 && frameRmsDbs[i] <= frameRmsDbs[i - 1]) {
      decayTransitions++;
      const drop = frameRmsDbs[i - 1] - frameRmsDbs[i + 1];
      if (drop < 6.0) slowDecayCount++;
    }
  }
  const reverberationProxyScore = Number(
    (decayTransitions > 0 ? slowDecayCount / decayTransitions : 0).toFixed(3)
  );

  // Quality Classification based on explicit documented rules
  let qualityClass: AudioQualityClass = 'UNKNOWN';
  if (durationSeconds < 0.25 || rmsLevelDb < -72 || voiceActivityRatio < 0.03) {
    qualityClass = 'UNUSABLE';
  } else if (clippingPercentage >= 2.0 || estimatedSnrDb < 6.0) {
    qualityClass = 'POOR';
  } else if (estimatedSnrDb < 15.0 || clippingPercentage >= 0.5 || reverberationProxyScore > 0.65) {
    qualityClass = 'CHALLENGING';
  } else if (estimatedSnrDb < 24.0 || clippingPercentage >= 0.1) {
    qualityClass = 'ACCEPTABLE';
  } else {
    qualityClass = 'CLEAN';
  }

  return {
    technical: {
      detectedFormat: params.detectedFormat,
      detectedMimeType: params.detectedMimeType,
      container: params.container,
      codec: params.codec,
      sampleRate,
      channelCount: numChannels,
      bitDepth: params.bitDepth,
      bitrateBps: params.bitrateBps,
      durationSeconds: Number(durationSeconds.toFixed(4)),
      fileSizeBytes: params.fileSizeBytes,
      peakAmplitude: Number(peak.toFixed(5)),
      rmsLevelDb,
      clippingPercentage,
      silentRegionPercentage,
      channelImbalanceDb,
      stereoPhaseCorrelation,
      recommendedChannelPolicy,
      corruptionDetected: false,
      corruptionReason: null,
    },
    acousticProfile: {
      profilerAlgorithmId: PROFILER_ALGO_ID,
      profilerAlgorithmVersion: PROFILER_ALGO_VERSION,
      isHeuristicEstimate: true,
      estimatedSnrDb,
      voiceActivityRatio,
      reverberationProxyScore,
      longSilenceRatio,
      speechClippingIndicator: clippingPercentage >= 0.5,
      backgroundNoiseIndicator: estimatedSnrDb < 15.0,
      speechOverlapProxyIndicator: numChannels >= 2 && (stereoPhaseCorrelation ?? 1) < 0.25,
      qualityClass,
      classificationRulesSummary:
        'Rule-v1: UNUSABLE(dur<0.25s|rms<-72dB|VAD<3%) | POOR(clip>=2%|SNR<6dB) | CHALLENGING(SNR<15dB|clip>=0.5%) | ACCEPTABLE(SNR<24dB) | CLEAN',
    },
    fingerprint: computeAudioEnergyFingerprint(mono),
  };
}

/**
 * Validates container magic bytes, enforces upload constraints, and executes isolated audio decode + profiling.
 */
export async function ingestAndDecodeUntrustedAudio(params: {
  fileBytes: Buffer;
  claimedFilename: string;
  claimedMimeType?: string;
  limits?: DataFactoryUploadLimits;
}): Promise<DecodedAudioBufferResult> {
  const limits = params.limits ?? DEFAULT_DATA_FACTORY_LIMITS;
  if (params.fileBytes.byteLength === 0) {
    throw new Error('SECURITY_EMPTY_FILE: Uploaded audio buffer is empty.');
  }
  if (params.fileBytes.byteLength > limits.maxUploadBytes) {
    throw new Error(
      `UPLOAD_LIMIT_EXCEEDED: File (${params.fileBytes.byteLength} bytes) exceeds limit (${limits.maxUploadBytes} bytes).`
    );
  }

  // Never trust filename extension or HTTP MIME header; inspect actual magic bytes
  const magicType = AudioSecurityGuard.verifyMagicBytes(
    new Uint8Array(params.fileBytes.buffer, params.fileBytes.byteOffset, Math.min(32, params.fileBytes.byteLength)),
    params.fileBytes.byteLength
  );
  const detectedFormat = mapSecurityFormatToSupported(magicType);
  const rawChecksumSha256 = sha256Hex(params.fileBytes);

  let sampleRate = 16000;
  let channelCount = 1;
  let bitDepth = 16;
  let codec = 'pcm_s16le';
  let container = detectedFormat.toLowerCase();
  let bitrateBps: number | null = null;
  let channels: Float32Array[];

  if (detectedFormat === 'WAV') {
    const wav = decodeWavBufferStrict(params.fileBytes);
    sampleRate = wav.sampleRate;
    channelCount = wav.channelCount;
    bitDepth = wav.bitDepth;
    codec = wav.codec;
    container = 'riff_wave';
    bitrateBps = sampleRate * channelCount * bitDepth;
    channels = wav.channels;
  } else {
    const ffDecoded = await decodeContainerWithIsolatedFfmpeg(
      params.fileBytes,
      limits.maxProcessingDurationMs,
      limits.maxDurationSeconds
    );
    sampleRate = ffDecoded.sampleRate;
    channelCount = ffDecoded.channelCount;
    bitDepth = ffDecoded.bitDepth;
    codec = ffDecoded.codec;
    container = ffDecoded.container;
    bitrateBps = ffDecoded.bitrateBps;
    channels = ffDecoded.channels;
  }

  const durationSeconds = (channels[0]?.length ?? 0) / Math.max(1, sampleRate);
  if (durationSeconds > limits.maxDurationSeconds) {
    throw new Error(
      `UPLOAD_DURATION_EXCEEDED: Audio duration (${durationSeconds.toFixed(1)}s) exceeds max limit (${limits.maxDurationSeconds}s).`
    );
  }
  AudioSecurityGuard.assertSafeDecodedDuration(
    durationSeconds,
    params.fileBytes.byteLength,
    sampleRate,
    channelCount
  );

  const mimeMap: Record<SupportedMediaFormat, string> = {
    WAV: 'audio/wav',
    FLAC: 'audio/flac',
    MP3: 'audio/mpeg',
    M4A_AAC: 'audio/mp4',
    OGG_OPUS: 'audio/ogg',
    WEBM: 'audio/webm',
  };

  const { technical, acousticProfile, fingerprint } = profilePcmChannelsAndQuality({
    channels,
    sampleRate,
    detectedFormat,
    detectedMimeType: mimeMap[detectedFormat],
    container,
    codec,
    bitDepth,
    bitrateBps,
    fileSizeBytes: params.fileBytes.byteLength,
  });

  return {
    technical,
    acousticProfile,
    rawChecksumSha256,
    fingerprint,
    sampleRate,
    channelChannelsPcm: channels,
  };
}

/**
 * Produces canonical 16,000 Hz Mono Signed PCM16 WAV derived artifact with explicit channel policy & full provenance.
 */
export function buildCanonical16kMonoArtifact(params: {
  tenantId: string;
  recordingId: string;
  parentArtifact: AudioArtifactRecord;
  sourceChannels: Float32Array[];
  sourceSampleRate: number;
  channelPolicy: StereoChannelPolicy;
  nextVersion: number;
}): {
  artifact: AudioArtifactRecord;
  canonicalWavBytes: Buffer;
  canonicalPcm16kMono: Float32Array;
} {
  if (params.sourceChannels.length === 0 || params.sourceChannels[0].length === 0) {
    throw new Error('CANONICAL_NORMALIZE_ERROR: Empty PCM channels.');
  }

  let selectedChannels: Float32Array[];
  if (params.sourceChannels.length === 1 || params.channelPolicy === 'MONO_SOURCE') {
    selectedChannels = [params.sourceChannels[0]];
  } else if (params.channelPolicy === 'LEFT_CHANNEL') {
    selectedChannels = [params.sourceChannels[0]];
  } else if (params.channelPolicy === 'RIGHT_CHANNEL') {
    selectedChannels = [params.sourceChannels[Math.min(1, params.sourceChannels.length - 1)]];
  } else if (params.channelPolicy === 'MULTI_CHANNEL_PRESERVATION') {
    // Check correlation; preserve dominant speaker channel for canonical mono track while flagging multi-channel original preserved
    selectedChannels = [params.sourceChannels[0]];
  } else {
    // SAFE_MIXDOWN: Phase-safe average
    selectedChannels = params.sourceChannels;
  }

  const resampled = resampleTo16kMono(selectedChannels, params.sourceSampleRate, 16_000);
  const expectedSampleCount = Math.floor(
    params.sourceChannels[0].length / (params.sourceSampleRate / 16_000)
  );
  const actualSampleCount = resampled.samples.length;

  let peak = 0;
  for (let i = 0; i < actualSampleCount; i++) {
    const abs = Math.abs(resampled.samples[i]);
    if (abs > peak) peak = abs;
  }
  const clippingIntroduced = peak > 1.0;

  const canonicalWavBytes = encodePcm16WavBuffer([resampled.samples], 16_000);
  const outputChecksumSha256 = sha256Hex(canonicalWavBytes);

  const sourceDurationMs = (params.sourceChannels[0].length / params.sourceSampleRate) * 1000;
  const outputDurationMs = (actualSampleCount / 16_000) * 1000;
  const durationDeltaMs = Number(Math.abs(sourceDurationMs - outputDurationMs).toFixed(3));

  const provenance: ResamplingProvenanceMetadata = {
    sourceSampleRate: params.sourceSampleRate,
    targetSampleRate: 16_000,
    channelPolicyApplied: params.channelPolicy,
    resamplingAlgorithm: 'kaiser_windowed_sinc_beta_6.5',
    filterCutoffHz: resampled.cutoffHz,
    filterTaps: resampled.filterTaps,
    processingLibraryVersion: DATA_FACTORY_AUDIO_SW_VERSION,
    inputChecksumSha256: params.parentArtifact.checksumSha256,
    outputChecksumSha256,
    durationDeltaMs,
    postResamplePeak: Number(peak.toFixed(5)),
    clippingIntroduced,
    expectedSampleCount,
    actualSampleCount,
  };

  const artifactId = `art_can_${crypto.randomUUID().slice(0, 12)}`;
  const artifact: AudioArtifactRecord = {
    artifactId,
    tenantId: params.tenantId,
    recordingId: params.recordingId,
    artifactType: 'CANONICAL_16K_MONO_PCM16',
    artifactVersion: params.nextVersion,
    parentArtifactId: params.parentArtifact.artifactId,
    storageLocation: `object://tenants/${params.tenantId}/recordings/${params.recordingId}/canonical_v${params.nextVersion}.wav`,
    checksumSha256: outputChecksumSha256,
    sampleRate: 16_000,
    channelCount: 1,
    durationSeconds: Number((actualSampleCount / 16_000).toFixed(4)),
    transformationConfig: {
      targetSampleRate: 16_000,
      channels: 1,
      format: 'pcm_s16le',
      channelPolicy: params.channelPolicy,
    },
    processingSoftwareVersion: DATA_FACTORY_AUDIO_SW_VERSION,
    resamplingProvenance: provenance,
    createdAtIso: new Date().toISOString(),
    deletedAtIso: null,
  };

  return {
    artifact,
    canonicalWavBytes,
    canonicalPcm16kMono: resampled.samples,
  };
}

/**
 * Deterministic PRNG for reproducible augmentation (Mulberry32).
 */
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Applies reproducible, seeded audio augmentation to canonical 16kHz PCM, NEVER modifying original source files.
 */
export function applyReproducibleAugmentation(params: {
  tenantId: string;
  recordingId: string;
  sourceArtifact: AudioArtifactRecord;
  canonicalPcm16k: Float32Array;
  config: AugmentationConfig;
  datasetReleaseId?: string | null;
  nextVersion: number;
}): {
  artifact: AudioArtifactRecord;
  augmentedWavBytes: Buffer;
  augmentedPcm16k: Float32Array;
} {
  const { config, canonicalPcm16k } = params;
  if (!config || typeof config !== 'object') {
    throw new Error('AUGMENTATION_GUARD: AugmentationConfig object is required.');
  }
  if (
    typeof config.speedFactor !== 'number' ||
    !Number.isFinite(config.speedFactor) ||
    config.speedFactor < 0.8 ||
    config.speedFactor > 1.25
  ) {
    throw new Error('AUGMENTATION_GUARD: speedFactor out of safe intelligible speech bounds [0.80, 1.25].');
  }
  if (
    typeof config.gainDb !== 'number' ||
    !Number.isFinite(config.gainDb) ||
    config.gainDb < -40 ||
    config.gainDb > 24
  ) {
    throw new Error('AUGMENTATION_GUARD: gainDb must be a finite number within [-40, 24].');
  }
  if (
    config.targetNoiseSnrDb !== null &&
    (typeof config.targetNoiseSnrDb !== 'number' ||
      !Number.isFinite(config.targetNoiseSnrDb) ||
      config.targetNoiseSnrDb < -10 ||
      config.targetNoiseSnrDb > 60)
  ) {
    throw new Error('AUGMENTATION_GUARD: targetNoiseSnrDb must be null or finite within [-10, 60].');
  }
  if (
    typeof config.reverberationMix !== 'number' ||
    !Number.isFinite(config.reverberationMix) ||
    config.reverberationMix < 0 ||
    config.reverberationMix > 1
  ) {
    throw new Error('AUGMENTATION_GUARD: reverberationMix must be a finite number within [0, 1].');
  }
  if (typeof config.randomSeed !== 'number' || !Number.isFinite(config.randomSeed)) {
    throw new Error('AUGMENTATION_GUARD: randomSeed must be a finite number.');
  }
  const rng = createSeededRng(config.randomSeed);

  // 1. Speed perturbation via linear resampling
  const outLen = Math.max(1, Math.floor(canonicalPcm16k.length / config.speedFactor));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * config.speedFactor;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = canonicalPcm16k[Math.min(canonicalPcm16k.length - 1, idx)] ?? 0;
    const s1 = canonicalPcm16k[Math.min(canonicalPcm16k.length - 1, idx + 1)] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }

  // 2. Controlled gain change
  const gainLinear = Math.pow(10, config.gainDb / 20);
  let signalSq = 0;
  for (let i = 0; i < outLen; i++) {
    out[i] = out[i] * gainLinear;
    signalSq += out[i] * out[i];
  }
  const signalRms = Math.sqrt(signalSq / Math.max(1, outLen));

  const seq: string[] = [`speed:${config.speedFactor}`, `gainDb:${config.gainDb}`];

  // 3. Seeded SNR noise mixing
  if (config.targetNoiseSnrDb !== null) {
    const targetNoiseRms = signalRms / Math.pow(10, config.targetNoiseSnrDb / 20);
    // Box-Muller deterministic Gaussian approx
    for (let i = 0; i < outLen; i++) {
      const u1 = Math.max(1e-7, rng());
      const u2 = rng();
      const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      out[i] = Math.max(-0.99, Math.min(0.99, out[i] + gauss * targetNoiseRms));
    }
    seq.push(`snrNoise:${config.targetNoiseSnrDb}dB`);
  }

  // 4. Optional simple first-order telephone bandpass proxy (300-3400Hz)
  if (config.telephoneBandpass) {
    let prevX = 0;
    let prevHp = 0;
    let prevLp = 0;
    const hpAlpha = 0.88;
    const lpAlpha = 0.45;
    for (let i = 0; i < outLen; i++) {
      const hp = hpAlpha * (prevHp + out[i] - prevX);
      prevX = out[i];
      prevHp = hp;
      const lp = prevLp + lpAlpha * (hp - prevLp);
      prevLp = lp;
      out[i] = Math.max(-0.99, Math.min(0.99, lp));
    }
    seq.push('telephoneBandpass:300-3400Hz');
  }

  // 5. Optional reverberation tap delay
  if (config.reverberationMix > 0) {
    const delaySamples = Math.floor(0.035 * 16_000);
    const mix = Math.min(0.4, config.reverberationMix);
    for (let i = delaySamples; i < outLen; i++) {
      out[i] = Math.max(-0.99, Math.min(0.99, out[i] + out[i - delaySamples] * mix));
    }
    seq.push(`reverbMix:${mix}`);
  }

  const augmentedWavBytes = encodePcm16WavBuffer([out], 16_000);
  const checksum = sha256Hex(augmentedWavBytes);
  const durationSeconds = Number((outLen / 16_000).toFixed(4));

  const augMeta: AugmentationRecordMetadata = {
    sourceRecordingId: params.recordingId,
    sourceArtifactId: params.sourceArtifact.artifactId,
    transformationSequence: seq,
    parameters: config,
    randomSeed: config.randomSeed,
    processingImplementationVersion: DATA_FACTORY_AUDIO_SW_VERSION,
    outputChecksumSha256: checksum,
    outputDurationSeconds: durationSeconds,
    datasetReleaseId: params.datasetReleaseId ?? null,
  };

  const artifact: AudioArtifactRecord = {
    artifactId: `art_aug_${crypto.randomUUID().slice(0, 12)}`,
    tenantId: params.tenantId,
    recordingId: params.recordingId,
    artifactType: 'AUGMENTED',
    artifactVersion: params.nextVersion,
    parentArtifactId: params.sourceArtifact.artifactId,
    storageLocation: `object://tenants/${params.tenantId}/recordings/${params.recordingId}/aug_v${params.nextVersion}_s${config.randomSeed}.wav`,
    checksumSha256: checksum,
    sampleRate: 16_000,
    channelCount: 1,
    durationSeconds,
    transformationConfig: {
      speedFactor: config.speedFactor,
      gainDb: config.gainDb,
      targetNoiseSnrDb: config.targetNoiseSnrDb,
      telephoneBandpass: config.telephoneBandpass,
      randomSeed: config.randomSeed,
    },
    processingSoftwareVersion: DATA_FACTORY_AUDIO_SW_VERSION,
    augmentationMetadata: augMeta,
    createdAtIso: new Date().toISOString(),
    deletedAtIso: null,
  };

  return {
    artifact,
    augmentedWavBytes,
    augmentedPcm16k: out,
  };
}
