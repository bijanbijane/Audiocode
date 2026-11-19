import {
  AcousticProfile,
  AudioAsset,
  PersistedAudioAssetManifest,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import { AudioSecurityGuard, SupportedAudioContainer } from '../security/AudioSecurityGuard';
import { detectLongPauses, refinePersianCutBoundary } from './dsp';
import { StreamingPeakPyramidBuilder } from './peakPyramid';
import { StreamingKaiserSincResampler } from './resampler';
import {
  buildSeekTable,
  computeDeterministicAssetId,
  StorageBrokerClient,
} from './storageBroker';
import { flicksToSeconds, secondsToFlicks } from './timebase';
import { LoadedStudioProject } from './audioFixtures';

export interface StreamingIngestOptions {
  readonly broker?: StorageBrokerClient | null;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly chunkSeconds?: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (progress: {
    phase: 'validating' | 'decoding' | 'persisting' | 'analyzing' | 'finalizing';
    percent: number;
    chunkIndex?: number;
  }) => void;
  readonly retainFallbackWhenOpfsUnavailable?: boolean;
  readonly decodeCompressedAudioFn?: (
    encodedBytes: ArrayBuffer,
  ) => Promise<{
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    duration: number;
    getChannelData(channel: number): Float32Array;
  }>;
}

export interface ParsedWavLayout {
  readonly audioFormat: 1 | 3; // 1 = PCM integer, 3 = IEEE float
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly blockAlign: number;
  readonly dataOffsetBytes: number;
  readonly dataByteLength: number;
  readonly totalSamples: number;
}

export class IngestAbortedError extends Error {
  public readonly code = 'INGEST_ABORTED';

  constructor(message = 'فرایند ورود فایل صوتی توسط کاربر متوقف شد.') {
    super(message);
    this.name = 'IngestAbortedError';
  }
}

async function computeBoundedContentHash(file: {
  name: string;
  size: number;
  slice(start?: number, end?: number): Blob;
}): Promise<string> {
  const MAX_FULL_HASH_BYTES = 8 * 1024 * 1024;
  let sampleBytes: Uint8Array;

  if (file.size <= MAX_FULL_HASH_BYTES) {
    sampleBytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
  } else {
    // Bounded 3-window fingerprint (head + mid + tail + size) keeps hashing O(1) RAM on multi-GB files
    const win = 512 * 1024;
    const midOffset = Math.max(0, Math.floor(file.size / 2) - Math.floor(win / 2));
    const tailOffset = Math.max(0, file.size - win);
    const [head, mid, tail] = await Promise.all([
      file.slice(0, win).arrayBuffer(),
      file.slice(midOffset, midOffset + win).arrayBuffer(),
      file.slice(tailOffset, file.size).arrayBuffer(),
    ]);
    const meta = new TextEncoder().encode(`|size:${file.size}|name:${file.name}`);
    sampleBytes = new Uint8Array(head.byteLength + mid.byteLength + tail.byteLength + meta.byteLength);
    let offset = 0;
    sampleBytes.set(new Uint8Array(head), offset);
    offset += head.byteLength;
    sampleBytes.set(new Uint8Array(mid), offset);
    offset += mid.byteLength;
    sampleBytes.set(new Uint8Array(tail), offset);
    offset += tail.byteLength;
    sampleBytes.set(meta, offset);
  }

  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest('SHA-256', sampleBytes.slice().buffer);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  }

  // Fallback FNV-1a digest if WebCrypto subtle is absent
  let h = 0x811c9dc5;
  for (let i = 0; i < sampleBytes.length; i++) {
    h ^= sampleBytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `sha256:${h.toString(16).padStart(8, '0')}${file.size.toString(16).padStart(8, '0')}`;
}

/**
 * Parses a RIFF/WAVE header incrementally via bounded Blob.slice() calls
 * without loading the whole file into JS memory. Returns null if non-PCM/unsupported WAV.
 */
export async function parseWavHeaderStreaming(file: {
  size: number;
  slice(start?: number, end?: number): Blob;
}): Promise<ParsedWavLayout | null> {
  if (file.size < 44) return null;
  const riffBuf = await file.slice(0, 12).arrayBuffer();
  const riffView = new DataView(riffBuf);
  const riffTag = String.fromCharCode(
    riffView.getUint8(0),
    riffView.getUint8(1),
    riffView.getUint8(2),
    riffView.getUint8(3),
  );
  const waveTag = String.fromCharCode(
    riffView.getUint8(8),
    riffView.getUint8(9),
    riffView.getUint8(10),
    riffView.getUint8(11),
  );
  if (riffTag !== 'RIFF' || waveTag !== 'WAVE') return null;

  let cursor = 12;
  let audioFormat: number | null = null;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;

  let safetyChunks = 0;
  while (cursor + 8 <= file.size && safetyChunks < 128) {
    safetyChunks++;
    const chunkHdrBuf = await file.slice(cursor, cursor + 8).arrayBuffer();
    if (chunkHdrBuf.byteLength < 8) break;
    const hdrView = new DataView(chunkHdrBuf);
    const id = String.fromCharCode(
      hdrView.getUint8(0),
      hdrView.getUint8(1),
      hdrView.getUint8(2),
      hdrView.getUint8(3),
    );
    const chunkSize = hdrView.getUint32(4, true);
    const payloadStart = cursor + 8;

    if (id === 'fmt ') {
      if (chunkSize < 16 || payloadStart + 16 > file.size) return null;
      const fmtBuf = await file.slice(payloadStart, payloadStart + 16).arrayBuffer();
      const fmtView = new DataView(fmtBuf);
      audioFormat = fmtView.getUint16(0, true);
      numChannels = fmtView.getUint16(2, true);
      sampleRate = fmtView.getUint32(4, true);
      blockAlign = fmtView.getUint16(12, true);
      bitsPerSample = fmtView.getUint16(14, true);
    } else if (id === 'data') {
      if (
        (audioFormat !== 1 && audioFormat !== 3) ||
        numChannels <= 0 ||
        numChannels > 32 ||
        sampleRate <= 0 ||
        blockAlign <= 0
      ) {
        return null;
      }
      if (
        audioFormat === 1 &&
        bitsPerSample !== 8 &&
        bitsPerSample !== 16 &&
        bitsPerSample !== 24 &&
        bitsPerSample !== 32
      ) {
        return null;
      }
      if (audioFormat === 3 && bitsPerSample !== 32) {
        return null;
      }
      const minBlockAlign = numChannels * (bitsPerSample / 8);
      if (blockAlign < minBlockAlign) {
        return null;
      }
      const availableBytes = Math.max(0, Math.min(chunkSize, file.size - payloadStart));
      const totalSamples = Math.floor(availableBytes / blockAlign);
      return {
        audioFormat,
        numChannels,
        sampleRate,
        bitsPerSample,
        blockAlign,
        dataOffsetBytes: payloadStart,
        dataByteLength: totalSamples * blockAlign,
        totalSamples,
      };
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    cursor = payloadStart + paddedSize;
  }

  return null;
}

function decodeWavChunkToMonoFloat32(
  bytes: ArrayBuffer,
  layout: ParsedWavLayout,
): Float32Array {
  const view = new DataView(bytes);
  const frameCount = Math.floor(bytes.byteLength / layout.blockAlign);
  const mono = new Float32Array(frameCount);
  const bytesPerSample = layout.bitsPerSample / 8;
  const invChannels = 1 / layout.numChannels;

  for (let i = 0; i < frameCount; i++) {
    const frameOffset = i * layout.blockAlign;
    let sum = 0;
    for (let c = 0; c < layout.numChannels; c++) {
      const off = frameOffset + c * bytesPerSample;
      if (off + bytesPerSample > bytes.byteLength) break;
      let sample = 0;
      if (layout.audioFormat === 3) {
        sample = view.getFloat32(off, true);
      } else if (layout.bitsPerSample === 16) {
        sample = view.getInt16(off, true) / 32768;
      } else if (layout.bitsPerSample === 24) {
        const b0 = view.getUint8(off);
        const b1 = view.getUint8(off + 1);
        const b2 = view.getUint8(off + 2);
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= ~0xffffff;
        sample = val / 8388608;
      } else if (layout.bitsPerSample === 32) {
        sample = view.getInt32(off, true) / 2147483648;
      } else if (layout.bitsPerSample === 8) {
        sample = (view.getUint8(off) - 128) / 128;
      }
      sum += Number.isFinite(sample) ? sample : 0;
    }
    mono[i] = Math.max(-1, Math.min(1, sum * invChannels));
  }

  return mono;
}

class StreamingAcousticProfileAccumulator {
  private readonly quietFrames: { rms: number; samples: Float32Array }[] = [];
  private readonly maxCollectedQuiet = 32;
  private readonly frameLen: number;
  private totalFramesCount = 0;
  private silentFramesCount = 0;

  constructor(
    private readonly assetId: string,
    private readonly sampleRate: number,
  ) {
    this.frameLen = Math.max(1, Math.round(sampleRate * 0.02));
  }

  public pushMonoChunk(chunk: Float32Array): void {
    for (let i = 0; i + this.frameLen <= chunk.length; i += this.frameLen) {
      let sumSq = 0;
      for (let j = 0; j < this.frameLen; j++) {
        const s = chunk[i + j];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / this.frameLen);
      this.totalFramesCount++;
      if (rms <= 1e-6) {
        this.silentFramesCount++;
        continue;
      }

      if (this.quietFrames.length < this.maxCollectedQuiet) {
        this.quietFrames.push({ rms, samples: chunk.slice(i, i + this.frameLen) });
        if (this.quietFrames.length === this.maxCollectedQuiet) {
          this.quietFrames.sort((a, b) => a.rms - b.rms);
        }
      } else if (rms < this.quietFrames[this.quietFrames.length - 1].rms) {
        this.quietFrames[this.quietFrames.length - 1] = {
          rms,
          samples: chunk.slice(i, i + this.frameLen),
        };
        this.quietFrames.sort((a, b) => a.rms - b.rms);
      }
    }
  }

  public finalize(): AcousticProfile {
    this.quietFrames.sort((a, b) => a.rms - b.rms);
    const silentRatio =
      this.totalFramesCount > 0 ? this.silentFramesCount / this.totalFramesCount : 0;

    if (this.quietFrames.length === 0 || silentRatio >= 0.1) {
      const desiredLen = Math.round(this.sampleRate * 0.5);
      return {
        assetId: this.assetId,
        noiseFloorDbfs: -66.02,
        roomToneRms: 0.0005,
        roomToneSample: new Float32Array(desiredLen),
        sampleRate: this.sampleRate,
      };
    }

    const p10Idx = Math.floor(this.quietFrames.length * 0.1);
    const roomToneRms = Math.max(this.quietFrames[p10Idx].rms, 0.0005);
    const noiseFloorDbfs = 20 * Math.log10(Math.max(roomToneRms, 1e-6));

    const desiredLen = Math.round(this.sampleRate * 0.5);
    const roomToneSample = new Float32Array(desiredLen);
    const quietPool = this.quietFrames.filter(
      (f) => f.rms <= Math.max(roomToneRms * 3, 0.015),
    );
    if (quietPool.length > 0) {
      let writeOffset = 0;
      let cursor = 0;
      while (writeOffset < desiredLen) {
        const frame = quietPool[cursor % quietPool.length].samples;
        const copyLen = Math.min(frame.length, desiredLen - writeOffset);
        roomToneSample.set(frame.subarray(0, copyLen), writeOffset);
        writeOffset += copyLen;
        cursor++;
      }
    }

    return {
      assetId: this.assetId,
      noiseFloorDbfs,
      roomToneRms,
      roomToneSample,
      sampleRate: this.sampleRate,
    };
  }
}

export async function ingestAudioFileStreaming(
  file: File,
  options: StreamingIngestOptions = {},
): Promise<LoadedStudioProject> {
  const {
    broker = null,
    memoryBudgetManager = getSharedMemoryBudgetManager(),
    chunkSeconds = 4,
    abortSignal,
    onProgress,
    retainFallbackWhenOpfsUnavailable = true,
    decodeCompressedAudioFn,
  } = options;

  const checkAbort = () => {
    if (abortSignal?.aborted) {
      throw new IngestAbortedError();
    }
  };

  onProgress?.({ phase: 'validating', percent: 2 });
  checkAbort();

  const headerSlice = await file.slice(0, Math.min(64, file.size)).arrayBuffer();
  const headerBytes = new Uint8Array(headerSlice);
  const verifiedContainer: SupportedAudioContainer = AudioSecurityGuard.verifyMagicBytes(
    headerBytes,
    file.size,
  );

  const contentHash = await computeBoundedContentHash(file);
  checkAbort();

  const wavLayout = verifiedContainer === 'WAV' ? await parseWavHeaderStreaming(file) : null;

  let sampleRate = 0;
  let channelCount: 1 | 2 = 1;
  let totalSamples = 0;
  let decodedAudioBuffer: {
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    duration: number;
    getChannelData(channel: number): Float32Array;
  } | null = null;
  let decodeReservation: MemoryReservation | null = null;
  let decodedReleased = false;

  const releaseDecodeReservation = () => {
    if (!decodedReleased) {
      decodedReleased = true;
      decodedAudioBuffer = null;
      memoryBudgetManager.release(decodeReservation);
      decodeReservation = null;
    }
  };

  try {
    if (wavLayout) {
      sampleRate = wavLayout.sampleRate;
      channelCount = wavLayout.numChannels > 1 ? 2 : 1;
      totalSamples = wavLayout.totalSamples;
      AudioSecurityGuard.assertSafeDecodedDuration(
        totalSamples / sampleRate,
        file.size,
        sampleRate,
        wavLayout.numChannels,
      );
    } else {
      onProgress?.({ phase: 'decoding', percent: 8 });
      // Compressed formats require AudioContext decoding; reserve transient budget upfront and free right after chunking
      const estimatedEncodedReserve = Math.max(1024, file.size);
      decodeReservation = memoryBudgetManager.reserve({
        owner: `streaming-ingest:decode:${file.name}`,
        category: 'decoded-audio',
        bytes: estimatedEncodedReserve,
        priority: 'protected',
        protectedUserData: true,
      });

      const arrayBuffer = await file.arrayBuffer();
      checkAbort();

      if (decodeCompressedAudioFn) {
        decodedAudioBuffer = await decodeCompressedAudioFn(arrayBuffer);
      } else {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        try {
          decodedAudioBuffer = await ctx.decodeAudioData(arrayBuffer);
        } finally {
          await ctx.close().catch(() => {});
        }
      }

      AudioSecurityGuard.assertSafeDecodedDuration(
        decodedAudioBuffer.duration,
        file.size,
        decodedAudioBuffer.sampleRate,
        decodedAudioBuffer.numberOfChannels,
      );

      sampleRate = decodedAudioBuffer.sampleRate;
      channelCount = decodedAudioBuffer.numberOfChannels > 1 ? 2 : 1;
      totalSamples = decodedAudioBuffer.length;
    }

    checkAbort();
    if (totalSamples <= 0 || sampleRate <= 0) {
      throw new Error('AUDIO_EMPTY: فایل صوتی فاقد نمونه قابل‌پردازش است.');
    }

    const assetId = computeDeterministicAssetId({
      contentSha256: contentHash,
      fileName: file.name,
      fileSizeBytes: file.size,
      sampleRate,
      exactSampleCount: totalSamples,
    });

    const safeChunkSeconds = Math.max(1, Math.min(10, chunkSeconds));
    const blockSizeSamples = Math.round(sampleRate * safeChunkSeconds);
    const totalBlocks = Math.ceil(totalSamples / blockSizeSamples);

    const brokerTelemetry = broker?.getTelemetry();
    const shouldPersistChunks = Boolean(
      broker &&
        !broker.isDisposed() &&
        brokerTelemetry?.opfsSupported,
    );

    const initialManifest: PersistedAudioAssetManifest = {
      assetId,
      fileName: file.name,
      mimeType: file.type || 'audio/wav',
      fileSizeBytes: file.size,
      contentSha256: contentHash,
      sampleRate,
      channels: 1, // Persisted chunks are mono-folded canonical studio tracks
      totalSamples,
      blockSizeSamples,
      totalBlocks,
      bytesPerSample: Float32Array.BYTES_PER_ELEMENT,
      state: 'ingesting',
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      finalizedAtMs: null,
    };

    let ingestPersisted = false;
    let storageBackend = 'Memory-Unavailable';

    if (shouldPersistChunks && broker) {
      const beginRes = await broker.beginAssetIngest(initialManifest);
      ingestPersisted = beginRes.persisted;
      storageBackend = beginRes.backend;
    }

    const peakBuilder = new StreamingPeakPyramidBuilder(assetId, sampleRate);
    const resampler = new StreamingKaiserSincResampler(sampleRate, 16_000);
    const acousticAcc = new StreamingAcousticProfileAccumulator(assetId, sampleRate);
    const collectedPauseCandidates: Array<{ startSample: number; endSample: number; durationMs: number }> = [];
    let downsampled16kCount = 0;

    // Only keep fallback PCM when OPFS persistence is unavailable AND caller requested it
    const fallbackChunks: Float32Array[] = [];

    try {
      for (let chunkIdx = 0; chunkIdx < totalBlocks; chunkIdx++) {
        checkAbort();

        const startSample = chunkIdx * blockSizeSamples;
        const count = Math.min(blockSizeSamples, totalSamples - startSample);
        const chunkBytes = count * Float32Array.BYTES_PER_ELEMENT;

        const chunkReservation = memoryBudgetManager.reserve({
          owner: `streaming-ingest:${assetId}:chunk-${chunkIdx}`,
          category: 'render-export-buffers',
          bytes: chunkBytes,
          priority: 'normal',
        });

        try {
          let monoChunk: Float32Array;
          if (wavLayout) {
            const byteStart = wavLayout.dataOffsetBytes + startSample * wavLayout.blockAlign;
            const byteEnd = byteStart + count * wavLayout.blockAlign;
            const rawSlice = await file.slice(byteStart, byteEnd).arrayBuffer();
            checkAbort();
            monoChunk = decodeWavChunkToMonoFloat32(rawSlice, wavLayout);
          } else if (decodedAudioBuffer) {
            monoChunk = new Float32Array(count);
            const numCh = Math.max(1, decodedAudioBuffer.numberOfChannels);
            const invCh = 1 / numCh;
            for (let c = 0; c < numCh; c++) {
              const channelView = decodedAudioBuffer
                .getChannelData(c)
                .subarray(startSample, startSample + count);
              for (let i = 0; i < channelView.length; i++) {
                const s = channelView[i];
                if (Number.isFinite(s)) {
                  monoChunk[i] += s * invCh;
                }
              }
            }
            for (let i = 0; i < count; i++) {
              monoChunk[i] = Math.max(-1, Math.min(1, monoChunk[i]));
            }
          } else {
            monoChunk = new Float32Array(count);
          }

          peakBuilder.pushMonoChunk(monoChunk);
          acousticAcc.pushMonoChunk(monoChunk);

          const chunk16k = resampler.pushChunk(monoChunk);
          downsampled16kCount += chunk16k.length;

          // Group A DSP pause detection on current chunk with local acoustic baseline
          if (collectedPauseCandidates.length < 8) {
            const localProfile = acousticAcc.finalize();
            const chunkPauses = detectLongPauses(monoChunk, sampleRate, localProfile, 650);
            for (const p of chunkPauses) {
              collectedPauseCandidates.push({
                startSample: startSample + p.startSample,
                endSample: startSample + p.endSample,
                durationMs: p.durationMs,
              });
              if (collectedPauseCandidates.length >= 8) break;
            }
          }

          if (shouldPersistChunks && broker) {
            const writeRes = await broker.writeAssetChunk(
              assetId,
              chunkIdx,
              monoChunk,
              'io-broker',
            );
            ingestPersisted = ingestPersisted || writeRes.persisted;
            if (writeRes.persisted) {
              storageBackend = writeRes.backend;
            }
          } else if (retainFallbackWhenOpfsUnavailable) {
            fallbackChunks.push(monoChunk);
          }
        } finally {
          memoryBudgetManager.release(chunkReservation);
        }

        const pct = Math.min(92, 12 + Math.round(((chunkIdx + 1) / totalBlocks) * 80));
        onProgress?.({ phase: 'persisting', percent: pct, chunkIndex: chunkIdx });
      }

      // Decoded compressed AudioBuffer is no longer needed once all chunks are written
      releaseDecodeReservation();

      const tail16k = resampler.flush();
      downsampled16kCount += tail16k.length;

      onProgress?.({ phase: 'finalizing', percent: 96 });
      checkAbort();

      if (shouldPersistChunks && broker && ingestPersisted) {
        await broker.finalizeAsset(assetId, {
          totalSamples,
          totalBlocks,
        });
      }
    } catch (err) {
      if (shouldPersistChunks && broker) {
        const isAbort = err instanceof IngestAbortedError || abortSignal?.aborted;
        await broker.abortAssetIngest(
          assetId,
          err instanceof Error ? err.message : String(err),
          isAbort ? 'abandoned' : 'failed',
        );
      }
      throw err;
    }

    const acousticProfile = acousticAcc.finalize();
    const peakPyramid = peakBuilder.finalize();
    const durationFlicks = secondsToFlicks(totalSamples / sampleRate);

    const containerMap: Record<SupportedAudioContainer, AudioAsset['container']> = {
      WAV: 'wav',
      MP3: 'mp3',
      OGG: 'ogg',
      FLAC: 'wav',
      M4A_AAC: 'webm',
      WEBM: 'webm',
    };

    const asset: AudioAsset = {
      id: assetId,
      name: file.name,
      contentHash,
      partialFingerprint: `fp:${file.name}-${sampleRate}-${totalSamples}`,
      contentVersion: 1,
      fileSizeBytes: file.size,
      container: containerMap[verifiedContainer],
      codec: wavLayout ? `wav-${wavLayout.bitsPerSample}bit` : 'decoded-pcm',
      nativeSampleRate: sampleRate,
      channelLayout: channelCount > 1 ? 'stereo' : 'mono',
      exactSampleCount: totalSamples,
      durationFlicks,
      importTimestamp: Date.now(),
      validationStatus: 'verified',
      seekTable: buildSeekTable(totalSamples, blockSizeSamples, 4, 1),
      peakPyramid,
      acousticProfile,
      storageLifecycle: ingestPersisted ? 'ready' : undefined,
      storageBackend: ingestPersisted ? storageBackend : 'Memory-Bounded-Fallback',
      blockSizeSamples,
    };

    const tracks: Track[] = [
      {
        id: 'track-main',
        name: `ترک اصلی — ${file.name}`,
        speakerLabel: 'گوینده فایل ورودی',
        syncGroupId: null,
        muted: false,
        solo: false,
        gainDb: 0,
        pan: 0,
        clips: [
          {
            id: 'clip-upload-1',
            assetId,
            trackId: 'track-main',
            kind: 'speech',
            timelineRange: { startFlicks: 0, endFlicks: durationFlicks },
            sourceStartFlicks: 0,
            fadeInMs: 10,
            fadeOutMs: 10,
            gainDb: 0,
            muted: false,
          },
        ],
      },
    ];

    // Assemble fallback PCM ONLY when OPFS persistence was NOT active
    let pcmSources: Record<string, Float32Array> = {};
    if (!ingestPersisted && retainFallbackWhenOpfsUnavailable && fallbackChunks.length > 0) {
      const assembled = new Float32Array(totalSamples);
      let off = 0;
      for (const c of fallbackChunks) {
        if (off >= assembled.length) break;
        const copyLen = Math.min(c.length, assembled.length - off);
        assembled.set(c.subarray(0, copyLen), off);
        off += copyLen;
      }
      pcmSources = { [assetId]: assembled };
    }

    // Build Group A pause recommendations using bounded chunk reads
    const recommendations: SmartRecommendation[] = [];
    for (let i = 0; i < collectedPauseCandidates.length; i++) {
      const p = collectedPauseCandidates[i];
      const startSec = p.startSample / sampleRate + 0.08;
      const endSec = p.endSample / sampleRate - 0.08;
      if (endSec - startSec < 0.35) continue;
      const range = {
        startFlicks: secondsToFlicks(startSec),
        endFlicks: secondsToFlicks(endSec),
      };
      if (
        recommendations.some(
          (r) =>
            r.kind === 'long-pause' &&
            Math.abs(r.range.startFlicks - range.startFlicks) < secondsToFlicks(0.25),
        )
      ) {
        continue;
      }

      const contextStart = Math.max(0, Math.floor(startSec * sampleRate) - sampleRate);
      const contextLen = Math.min(totalSamples - contextStart, Math.ceil((endSec - startSec + 2) * sampleRate));
      const boundaryBuf = broker && ingestPersisted
        ? await broker.streamReadRange(
            assetId,
            contextStart,
            contextLen,
            blockSizeSamples,
            pcmSources[assetId],
            'io-broker',
          )
        : (pcmSources[assetId]?.subarray(contextStart, contextStart + contextLen) ?? new Float32Array(0));

      const localRange = {
        startFlicks: secondsToFlicks(Math.max(0, startSec - contextStart / sampleRate)),
        endFlicks: secondsToFlicks(Math.max(0, endSec - contextStart / sampleRate)),
      };
      const localBoundary = refinePersianCutBoundary(boundaryBuf, sampleRate, localRange, {
        microCrossfadeMs: 10,
      });
      const offsetFlicks = secondsToFlicks(contextStart / sampleRate);

      recommendations.push({
        id: `rec-pause-${i}`,
        trackId: 'track-main',
        kind: 'long-pause',
        recommendedMode: 'sync-locked-ripple-cut',
        range,
        relatedText: `مکث ${(p.durationMs / 1000).toFixed(2)} ثانیه‌ای`,
        reasonFa: `شناسایی خودکار سکوت (گروه A) در بازه ${flicksToSeconds(range.startFlicks).toFixed(2)} تا ${flicksToSeconds(range.endFlicks).toFixed(2)} ثانیه.`,
        confidence: 0.94,
        sourceTier: 'Group-A-DSP',
        status: 'Pending',
        boundary: {
          ...localBoundary,
          rawRange: range,
          snappedRange: {
            startFlicks: localBoundary.snappedRange.startFlicks + offsetFlicks,
            endFlicks: localBoundary.snappedRange.endFlicks + offsetFlicks,
          },
        },
      });
    }

    onProgress?.({ phase: 'analyzing', percent: 100 });
    const stats = resampler.getStats();

    return {
      projectName: file.name,
      sampleRate,
      assets: { [assetId]: asset },
      pcmSources,
      tracks,
      tokens: [], // Honest empty transcript until CanonicalLocalAsrService transcribes with a verified local model
      recommendations,
      resamplerStats: {
        inputSampleRate: sampleRate,
        outputSampleRate: stats.outputSampleRate,
        cutoffHz: stats.cutoffHz,
        filterTaps: stats.filterTaps,
        aliasingAttenuationDb: stats.aliasingAttenuationDb,
        downsampledLength: downsampled16kCount,
      },
    };
  } finally {
    releaseDecodeReservation();
  }
}
