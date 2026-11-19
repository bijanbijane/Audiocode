import { SampleRate } from '../contracts/timebase.contract';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import { AVAPARDAZ_MEMORY_POLICY } from '../runtime/memory/MemoryPolicy';
import { StorageBrokerClient } from '../engine/storageBroker';
import { ChunkedPcmSource } from './AudioRenderTypes';

interface CachedBlock {
  readonly blockKey: string;
  readonly blockIndex: number;
  readonly startSample: number;
  readonly sampleCount: number;
  readonly channels: Float32Array[];
  readonly byteLength: number;
  readonly reservation: MemoryReservation;
}

export interface AudioSourceReaderOptions {
  readonly memoryBudgetManager?: MemoryBudgetManager;
  /** Block granularity for bounded LRU read cache (default: 16384 samples/ch) */
  readonly cacheBlockSamples?: number;
  /** Max bytes cached by this reader; strictly clamped <= AVAPARDAZ_MEMORY_POLICY.audioCacheBytes */
  readonly maxCacheBytes?: number;
}

/**
 * Wraps existing in-memory planar Float32Array channels as a bounded ChunkedPcmSource
 * without duplicating the whole buffer. Slices only the requested range per read.
 */
export function createPlanarArrayPcmSource(params: {
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sampleRate: SampleRate;
  readonly channels: readonly Float32Array[];
}): ChunkedPcmSource {
  if (params.channels.length === 0) {
    throw new RangeError('Planar PCM source requires at least 1 channel.');
  }
  const totalSamples = params.channels[0].length;
  for (let c = 1; c < params.channels.length; c++) {
    if (params.channels[c].length !== totalSamples) {
      throw new RangeError(
        `CHANNEL_MISMATCH: Channel ${c} length (${params.channels[c].length}) != channel 0 length (${totalSamples}).`,
      );
    }
  }

  return {
    sourceAudioId: params.sourceAudioId,
    sourceAudioHash: params.sourceAudioHash,
    sampleRate: params.sampleRate,
    channelCount: params.channels.length,
    totalSamples,
    async readPlanarRange(startSample: number, sampleCount: number): Promise<Float32Array[]> {
      const start = Math.max(0, Math.min(totalSamples, Math.trunc(startSample)));
      const end = Math.max(start, Math.min(totalSamples, start + Math.trunc(sampleCount)));
      const len = end - start;
      return params.channels.map((ch) => {
        const out = new Float32Array(len);
        out.set(ch.subarray(start, end));
        return out;
      });
    },
  };
}

/**
 * Bridges StorageBrokerClient OPFS/fallback chunk storage to ChunkedPcmSource.
 */
export function createStorageBrokerPcmSource(params: {
  readonly broker: StorageBrokerClient;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly totalSamples: number;
}): ChunkedPcmSource {
  return {
    sourceAudioId: params.sourceAudioId,
    sourceAudioHash: params.sourceAudioHash,
    sampleRate: params.sampleRate,
    channelCount: params.channelCount,
    totalSamples: params.totalSamples,
    async readPlanarRange(startSample: number, sampleCount: number): Promise<Float32Array[]> {
      const start = Math.max(0, Math.min(params.totalSamples, Math.trunc(startSample)));
      const end = Math.max(start, Math.min(params.totalSamples, start + Math.trunc(sampleCount)));
      const len = end - start;
      const out = Array.from({ length: params.channelCount }, () => new Float32Array(len));
      if (len === 0) return out;

      const monoRange = await params.broker.streamReadRange(
        params.sourceAudioId,
        start,
        len,
        65536,
      );
      const copyLen = Math.min(monoRange.length, len);
      for (let c = 0; c < params.channelCount; c++) {
        out[c].set(monoRange.subarray(0, copyLen), 0);
      }
      return out;
    },
  };
}

/**
 * Bounded Multi-Channel Audio Source Reader (AVP-P06-001)
 *
 * Reads arbitrary source sample windows strictly in bounded chunks, enforces LRU
 * cache limits well within AVAPARDAZ_MEMORY_POLICY.audioCacheBytes (32 MiB),
 * tracks all cached memory through MemoryBudgetManager, and evicts immediately
 * under memory pressure. Never loads the whole audio file into RAM.
 */
export class AudioSourceReader {
  public readonly source: ChunkedPcmSource;
  private readonly budget: MemoryBudgetManager;
  private readonly cacheBlockSamples: number;
  private readonly maxCacheBytes: number;
  private readonly cache = new Map<string, CachedBlock>();
  private readonly unregisterEviction: () => void;

  private cachedBytes = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private evictions = 0;
  private disposed = false;

  constructor(source: ChunkedPcmSource, options: AudioSourceReaderOptions = {}) {
    this.source = source;
    this.budget = options.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.cacheBlockSamples = Math.max(
      1024,
      Math.min(65536, Math.trunc(options.cacheBlockSamples ?? 16384)),
    );
    const requestedMax = options.maxCacheBytes ?? 4 * 1024 * 1024; // 4 MiB default bounded window cache
    this.maxCacheBytes = Math.max(
      64 * 1024,
      Math.min(AVAPARDAZ_MEMORY_POLICY.audioCacheBytes, Math.trunc(requestedMax)),
    );

    this.unregisterEviction = this.budget.registerCacheEvictionCallback(() => {
      this.evictAll();
    });
  }

  public async readRange(startSample: number, sampleCount: number): Promise<Float32Array[]> {
    if (this.disposed) {
      throw new Error('AudioSourceReader has been disposed.');
    }
    if (!Number.isInteger(startSample) || !Number.isInteger(sampleCount) || sampleCount < 0) {
      throw new RangeError(
        `Invalid readRange coordinates: startSample=${startSample}, sampleCount=${sampleCount}.`,
      );
    }
    const clampedStart = Math.max(0, Math.min(this.source.totalSamples, startSample));
    const clampedEnd = Math.max(
      clampedStart,
      Math.min(this.source.totalSamples, clampedStart + sampleCount),
    );
    const actualCount = clampedEnd - clampedStart;

    const result = Array.from(
      { length: this.source.channelCount },
      () => new Float32Array(actualCount),
    );
    if (actualCount === 0) return result;

    // Under throttle/emergency pressure, bypass caching and stream directly in small slices
    const pressure = this.budget.getPressureLevel();
    if (pressure === 'throttle' || pressure === 'emergency') {
      this.evictAll();
      const direct = await this.source.readPlanarRange(clampedStart, actualCount);
      this.validateChannelAlignment(direct, actualCount);
      return direct;
    }

    const firstBlock = Math.floor(clampedStart / this.cacheBlockSamples);
    const lastBlock = Math.floor((clampedEnd - 1) / this.cacheBlockSamples);

    for (let blockIdx = firstBlock; blockIdx <= lastBlock; blockIdx++) {
      const block = await this.getOrLoadBlock(blockIdx);
      const copyStart = Math.max(clampedStart, block.startSample);
      const copyEnd = Math.min(clampedEnd, block.startSample + block.sampleCount);
      const copyLen = copyEnd - copyStart;
      if (copyLen <= 0) continue;

      const srcOffset = copyStart - block.startSample;
      const dstOffset = copyStart - clampedStart;

      for (let ch = 0; ch < this.source.channelCount; ch++) {
        result[ch].set(
          block.channels[ch].subarray(srcOffset, srcOffset + copyLen),
          dstOffset,
        );
      }
    }

    return result;
  }

  public evictAll(): void {
    for (const entry of this.cache.values()) {
      this.budget.release(entry.reservation);
      this.evictions++;
    }
    this.cache.clear();
    this.cachedBytes = 0;
  }

  public getStats() {
    return {
      cachedBytes: this.cachedBytes,
      maxCacheBytes: this.maxCacheBytes,
      cachedBlocks: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      evictions: this.evictions,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterEviction();
    this.evictAll();
  }

  private async getOrLoadBlock(blockIndex: number): Promise<CachedBlock> {
    const key = `${this.source.sourceAudioId}:${blockIndex}`;
    const existing = this.cache.get(key);
    if (existing) {
      // Refresh LRU recency
      this.cache.delete(key);
      this.cache.set(key, existing);
      this.cacheHits++;
      return existing;
    }

    this.cacheMisses++;
    const startSample = blockIndex * this.cacheBlockSamples;
    const sampleCount = Math.min(
      this.cacheBlockSamples,
      Math.max(0, this.source.totalSamples - startSample),
    );
    const channels = await this.source.readPlanarRange(startSample, sampleCount);
    this.validateChannelAlignment(channels, sampleCount);

    const byteLength = sampleCount * this.source.channelCount * Float32Array.BYTES_PER_ELEMENT;
    if (byteLength === 0 || byteLength > this.maxCacheBytes) {
      // Do not cache if block exceeds cache cap
      return {
        blockKey: key,
        blockIndex,
        startSample,
        sampleCount,
        channels,
        byteLength,
        reservation: {
          id: 'uncached',
          owner: 'AudioSourceReader',
          category: 'audio-cache',
          bytes: 0,
          createdAt: Date.now(),
          priority: 'optional',
          protectedUserData: false,
        },
      };
    }

    // Evict LRU entries until new block fits inside maxCacheBytes
    while (this.cachedBytes + byteLength > this.maxCacheBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.cachedBytes = Math.max(0, this.cachedBytes - oldest.byteLength);
      this.budget.release(oldest.reservation);
      this.evictions++;
    }

    let reservation: MemoryReservation | null = null;
    try {
      reservation = this.budget.reserve({
        owner: `AudioSourceReader:${key}`,
        category: 'audio-cache',
        bytes: byteLength,
        priority: 'optional',
      });
    } catch {
      // Under memory pressure, return the read block uncached rather than failing the read
      return {
        blockKey: key,
        blockIndex,
        startSample,
        sampleCount,
        channels,
        byteLength,
        reservation: {
          id: 'uncached',
          owner: 'AudioSourceReader',
          category: 'audio-cache',
          bytes: 0,
          createdAt: Date.now(),
          priority: 'optional',
          protectedUserData: false,
        },
      };
    }

    const entry: CachedBlock = {
      blockKey: key,
      blockIndex,
      startSample,
      sampleCount,
      channels,
      byteLength,
      reservation,
    };
    this.cache.set(key, entry);
    this.cachedBytes += byteLength;
    return entry;
  }

  private validateChannelAlignment(channels: Float32Array[], expectedLength: number): void {
    if (channels.length !== this.source.channelCount) {
      throw new Error(
        `CHANNEL_MISMATCH: Expected ${this.source.channelCount} channels, got ${channels.length}.`,
      );
    }
    for (let c = 0; c < channels.length; c++) {
      if (channels[c].length !== expectedLength) {
        throw new Error(
          `CHANNEL_MISMATCH: Channel ${c} returned ${channels[c].length} samples, expected ${expectedLength}.`,
        );
      }
    }
  }
}
