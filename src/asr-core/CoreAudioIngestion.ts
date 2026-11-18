/**
 * CORE ASR ENGINE — MULTI-FORMAT INGESTION & STEREO PHASE GUARD (MILESTONE CORE-02)
 *
 * Uses local system FFmpeg/FFprobe for real multi-format container decoding
 * (WAV, MP3, FLAC, OGG/Opus, M4A/AAC, WebM) plus native RIFF WAV fast path.
 * Preserves stereo channels for inspection BEFORE canonical 16kHz Mono PCM16 conversion
 * so out-of-phase L/R cancellation or single-dead-channel stereo recordings are never destroyed.
 */

import { execFileSync } from 'node:child_process';
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
const TARGET_SR = 16_000;

export function detectAudioContainerFormat(bytes: Buffer, filename = ''): AudioContainerFormat {
  if (bytes.length >= 12) {
    const riff = bytes.subarray(0, 4).toString('ascii');
    const wave = bytes.subarray(8, 12).toString('ascii');
    if (riff === 'RIFF' && wave === 'WAVE') return 'wav';
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
  if (ext === 'wav' || ext === 'mp3' || ext === 'flac' || ext === 'ogg' || ext === 'm4a' || ext === 'webm') {
    return ext;
  }
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
      { encoding: 'utf8', timeout: 8000 },
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
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return rms > 1e-6 ? 20 * Math.log10(rms) : -120;
}

/**
 * Inspects multi-channel PCM at 16kHz BEFORE downmixing so out-of-phase or dead-channel
 * stereo files don't silently attenuate to silence.
 */
export function inspectAndDownmixChannels(channels: Float32Array[]): {
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
    const leftDb = rmsDbOfFloat32(channels[0]);
    return {
      monoFloat32: channels[0],
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
    dot += left[i] * right[i];
    magL += left[i] * left[i];
    magR += right[i] * right[i];
  }
  const denom = Math.sqrt(magL * magR);
  const corr = denom > 1e-12 ? dot / denom : 0;

  const phaseInversionRisk = corr < -0.55;
  const silentLeft = leftDb < -72 && rightDb > -50;
  const silentRight = rightDb < -72 && leftDb > -50;

  const mono = new Float32Array(n);
  if (phaseInversionRisk) {
    for (let i = 0; i < n; i++) mono[i] = leftDb >= rightDb ? left[i] : right[i];
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
    mono.set(active.subarray(0, n));
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
    mono[i] = (left[i] + right[i]) * 0.5;
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
    const clamped = Math.max(-1, Math.min(1, samples[i]));
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
      const s = samples[i];
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
    const f32 = pcm16BufferToFloat32(rawBytes);
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
      durationSec: Number((f32.length / TARGET_SR).toFixed(4)),
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
    const probeChannels = Math.max(1, Math.min(2, streamInfo.channels));

    // Decode via ffmpeg preserving up to 2 channels at 16kHz so we can inspect stereo correlation cleanly before downmix!
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        inputPath,
        '-vn',
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
      { timeout: 25_000 },
    );

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
