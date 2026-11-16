import {
  ExportValidationReport,
  FileHandleLease,
  RuntimeCapabilities,
  SeekTableEntry,
  StorageBrokerTelemetry,
} from '../contracts/v1_2';
import { RollingLruBlockCache } from './lruCache';

/**
 * Storage I/O Broker Client, Capability Probe, Seek Indexer, and Streaming WAV Exporter (v1.2)
 */

export function detectRuntimeCapabilities(): RuntimeCapabilities {
  const crossOriginIsolated = typeof self !== 'undefined' && Boolean((self as { crossOriginIsolated?: boolean }).crossOriginIsolated);
  const sharedArrayBufferSupported = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
  const audioWorkletSupported =
    typeof AudioWorkletNode !== 'undefined' || typeof AudioContext !== 'undefined';
  const webGpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const opfsSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage) &&
    'getDirectory' in navigator.storage;
  const hardwareConcurrency =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;

  let deviceTier: RuntimeCapabilities['deviceTier'] = 'Desktop Studio';
  if (typeof window !== 'undefined') {
    const w = window.innerWidth;
    if (w < 640) deviceTier = 'Mobile Companion';
    else if (w < 1024) deviceTier = 'Tablet Studio';
  }

  return {
    crossOriginIsolated,
    sharedArrayBufferSupported,
    transportMode: sharedArrayBufferSupported ? 'SharedArrayBuffer' : 'MessagePort-Fallback',
    audioWorkletSupported,
    webGpuSupported,
    gpuFallbackMode: webGpuSupported ? 'WebGPU-Sliced' : 'WASM-SIMD-CPU',
    opfsSupported,
    hardwareConcurrency,
    deviceTier,
  };
}

export async function requestPersistentStorage(): Promise<{
  persisted: boolean | null;
  quotaUsedBytes: number | null;
  quotaTotalBytes: number | null;
}> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage) {
      return { persisted: null, quotaUsedBytes: null, quotaTotalBytes: null };
    }
    let persisted: boolean | null = null;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
      if (!persisted && typeof navigator.storage.persist === 'function') {
        persisted = await navigator.storage.persist();
      }
    }
    let quotaUsedBytes: number | null = null;
    let quotaTotalBytes: number | null = null;
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      quotaUsedBytes = est.usage ?? null;
      quotaTotalBytes = est.quota ?? null;
    }
    return { persisted, quotaUsedBytes, quotaTotalBytes };
  } catch {
    return { persisted: null, quotaUsedBytes: null, quotaTotalBytes: null };
  }
}

export function buildSeekTable(
  totalSamples: number,
  blockSizeSamples: number,
  bytesPerSamplePerChannel: number,
  channels: number,
): SeekTableEntry[] {
  const entries: SeekTableEntry[] = [];
  let blockIndex = 0;
  let cursor = 0;
  while (cursor < totalSamples) {
    const count = Math.min(blockSizeSamples, totalSamples - cursor);
    const byteLength = count * bytesPerSamplePerChannel * channels;
    entries.push({
      blockIndex,
      startSample: cursor,
      sampleCount: count,
      byteOffset: cursor * bytesPerSamplePerChannel * channels,
      byteLength,
    });
    cursor += count;
    blockIndex++;
  }
  return entries;
}

export class StorageBrokerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;
  public readonly lruCache: RollingLruBlockCache;
  private telemetry: StorageBrokerTelemetry;

  constructor(cacheMaxBytes = 32 * 1024 * 1024) {
    this.lruCache = new RollingLruBlockCache(cacheMaxBytes);
    this.telemetry = {
      opfsSupported: false,
      syncAccessHandleSupported: false,
      persistentStorageGranted: null,
      quotaUsedBytes: null,
      quotaTotalBytes: null,
      activeLeases: [],
      lockConflictsPrevented: 0,
      cacheStats: this.lruCache.getStats(),
    };
  }

  async init(): Promise<StorageBrokerTelemetry> {
    const storageInfo = await requestPersistentStorage();
    this.telemetry.persistentStorageGranted = storageInfo.persisted;
    this.telemetry.quotaUsedBytes = storageInfo.quotaUsedBytes;
    this.telemetry.quotaTotalBytes = storageInfo.quotaTotalBytes;

    if (typeof Worker !== 'undefined' && !this.worker) {
      try {
        this.worker = new Worker(new URL('../workers/ioBroker.worker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (event) => {
          const { id, ok, payload, error } = event.data;
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          if (ok) entry.resolve(payload);
          else entry.reject(new Error(error ?? 'OPFS Broker error'));
        };
        const res = (await this.callWorker({ type: 'INIT' })) as {
          opfsAvailable: boolean;
          syncHandleAvailable: boolean;
          lockConflictsPrevented: number;
          leases: FileHandleLease[];
        };
        this.telemetry.opfsSupported = res.opfsAvailable;
        this.telemetry.syncAccessHandleSupported = res.syncHandleAvailable;
        this.telemetry.lockConflictsPrevented = res.lockConflictsPrevented;
        this.telemetry.activeLeases = res.leases;
      } catch {
        this.telemetry.opfsSupported = false;
      }
    }
    this.telemetry.cacheStats = this.lruCache.getStats();
    return this.getTelemetry();
  }

  private callWorker(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (!this.worker) {
      return Promise.resolve({
        opfsAvailable: false,
        syncHandleAvailable: false,
        lockConflictsPrevented: 0,
        leases: [],
      });
    }
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  async writePcmBlock(
    assetId: string,
    blockIndex: number,
    channels: Float32Array[],
    ownerWorker: FileHandleLease['ownerWorker'] = 'io-broker',
  ): Promise<void> {
    this.lruCache.put(assetId, blockIndex, channels);
    const mono = channels[0];
    const copy = new Float32Array(mono);
    const fileKey = `${assetId}_blk_${blockIndex}.f32`;
    if (this.worker) {
      const res = (await this.callWorker(
        {
          type: 'WRITE_BLOCK',
          fileKey,
          ownerWorker,
          data: copy.buffer,
        },
        [copy.buffer],
      )) as { lockConflictsPrevented: number; leases: FileHandleLease[] };
      if (res) {
        this.telemetry.lockConflictsPrevented = res.lockConflictsPrevented ?? this.telemetry.lockConflictsPrevented;
        this.telemetry.activeLeases = res.leases ?? this.telemetry.activeLeases;
      }
    }
    this.telemetry.cacheStats = this.lruCache.getStats();
  }

  async readPcmBlock(
    assetId: string,
    blockIndex: number,
    fallbackSource: Float32Array,
    startSample: number,
    sampleCount: number,
    ownerWorker: FileHandleLease['ownerWorker'] = 'playback-feeder',
  ): Promise<Float32Array> {
    const cached = this.lruCache.get(assetId, blockIndex);
    if (cached) {
      this.telemetry.cacheStats = this.lruCache.getStats();
      return cached.channels[0];
    }

    const fileKey = `${assetId}_blk_${blockIndex}.f32`;
    if (this.worker) {
      const res = (await this.callWorker({
        type: 'READ_BLOCK',
        fileKey,
        ownerWorker,
      })) as { buffer: ArrayBuffer | null; lockConflictsPrevented: number; leases: FileHandleLease[] };
      if (res?.leases) {
        this.telemetry.activeLeases = res.leases;
        this.telemetry.lockConflictsPrevented = res.lockConflictsPrevented ?? 0;
      }
      if (res?.buffer) {
        const loaded = new Float32Array(res.buffer);
        this.lruCache.put(assetId, blockIndex, [loaded]);
        this.telemetry.cacheStats = this.lruCache.getStats();
        return loaded;
      }
    }

    const sliced = fallbackSource.slice(startSample, startSample + sampleCount);
    this.lruCache.put(assetId, blockIndex, [sliced]);
    this.telemetry.cacheStats = this.lruCache.getStats();
    return sliced;
  }

  async simulateConcurrentLockBrokerTest(assetId: string): Promise<StorageBrokerTelemetry> {
    // Demonstrates two logical consumers (playback-feeder & ai-worker) reading via the central broker cleanly
    const dummy = new Float32Array(2048);
    await Promise.all([
      this.writePcmBlock(assetId, 999, [dummy], 'playback-feeder'),
      this.writePcmBlock(assetId, 999, [dummy], 'ai-worker'),
    ]);
    await this.callWorker({ type: 'DELETE_FILE', fileKey: `${assetId}_blk_999.f32` });
    this.lruCache.evictAsset(assetId);
    this.telemetry.cacheStats = this.lruCache.getStats();
    return this.getTelemetry();
  }

  getTelemetry(): StorageBrokerTelemetry {
    return {
      ...this.telemetry,
      cacheStats: this.lruCache.getStats(),
    };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Encodes Float32 PCM chunks into a standard 16-bit PCM WAV Blob
 * and computes Export Validation Report (LUFS approximation, True Peak, Clipping, Head/Tail fades).
 */
export function encodeAndValidateWavExport(
  monoOrStereoChannels: Float32Array[],
  sampleRate: number,
): { blob: Blob; report: ExportValidationReport } {
  const numChannels = Math.max(1, monoOrStereoChannels.length);
  const totalSamples = monoOrStereoChannels[0]?.length ?? 0;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = totalSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let peakLin = 0;
  let clippedSampleCount = 0;
  let sumSq = 0;
  let offset = 44;

  for (let i = 0; i < totalSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const raw = monoOrStereoChannels[c][i] ?? 0;
      const absRaw = Math.abs(raw);
      if (absRaw > peakLin) peakLin = absRaw;
      if (absRaw >= 0.999) clippedSampleCount++;
      sumSq += raw * raw;

      const clamped = Math.max(-1, Math.min(1, raw));
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  const rms = totalSamples > 0 ? Math.sqrt(sumSq / (totalSamples * numChannels)) : 0;
  const integratedLufs = Number((20 * Math.log10(Math.max(rms, 1e-6)) - 0.691).toFixed(1));
  const truePeakDbfs = Number((20 * Math.log10(Math.max(peakLin, 1e-6))).toFixed(2));
  const headValid = totalSamples > 0 ? Math.abs(monoOrStereoChannels[0][0]) < 0.1 : true;
  const tailValid =
    totalSamples > 0 ? Math.abs(monoOrStereoChannels[0][totalSamples - 1]) < 0.1 : true;

  const report: ExportValidationReport = {
    readable: totalSamples > 0,
    durationSeconds: Number((totalSamples / sampleRate).toFixed(3)),
    channelCount: numChannels,
    sampleRate,
    bitDepth: 16,
    clippedSampleCount,
    truePeakDbfs,
    integratedLufs,
    headTailFadeValid: headValid && tailValid,
    passed: totalSamples > 0 && clippedSampleCount === 0 && truePeakDbfs <= -0.1,
    fileSizeBytes: buffer.byteLength,
  };

  return {
    blob: new Blob([buffer], { type: 'audio/wav' }),
    report,
  };
}
