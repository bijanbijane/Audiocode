import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';

export const WAVEFORM_LOD_SAMPLES_PER_BUCKET = [64, 256, 1024, 4096] as const;
export type WaveformLodLevel = (typeof WAVEFORM_LOD_SAMPLES_PER_BUCKET)[number];

export interface WaveformBucketTile {
  readonly assetId: string;
  readonly channelIndex: number;
  readonly samplesPerBucket: WaveformLodLevel;
  readonly tileIndex: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly mins: Float32Array;
  readonly maxs: Float32Array;
  readonly bytes: number;
  lastUsedSeq: number;
}

export interface WaveformCacheStats {
  readonly tileCount: number;
  readonly totalBytes: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly invalidations: number;
}

/**
 * Incremental, Bounded, Multiresolution Waveform Peak Cache (AVP-P11-001 Section 7)
 * - Generates ONLY requested visible tiles incrementally in bounded chunks.
 * - Preserves per-channel min/max visualization summaries without altering source PCM.
 * - Reuses valid cached tiles across zoom/scroll and invalidates ONLY affected sample ranges.
 * - Integrates with MemoryBudgetManager and automatically evicts LRU tiles under memory pressure.
 */
export class MultiresolutionWaveformCache {
  private readonly maxBytes: number;
  private readonly bucketsPerTile: number;
  private readonly memoryBudget: MemoryBudgetManager;
  private readonly tiles = new Map<string, WaveformBucketTile>();
  private readonly reservations = new Map<string, MemoryReservation>();
  private readonly unregisterEviction: () => void;

  private totalBytes = 0;
  private lruSeq = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options?: {
    readonly maxBytes?: number;
    readonly bucketsPerTile?: number;
    readonly memoryBudget?: MemoryBudgetManager;
  }) {
    const rawMaxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
    this.maxBytes = Number.isFinite(rawMaxBytes) ? Math.max(64 * 1024, rawMaxBytes) : 8 * 1024 * 1024;
    const rawBuckets = options?.bucketsPerTile ?? 512;
    this.bucketsPerTile = Number.isFinite(rawBuckets) ? Math.max(64, Math.floor(rawBuckets)) : 512;
    this.memoryBudget = options?.memoryBudget ?? getSharedMemoryBudgetManager();
    this.unregisterEviction = this.memoryBudget.registerCacheEvictionCallback((ctx) => {
      this.evictToFreeBytes(Math.max(ctx.targetFreeBytes, Math.floor(this.totalBytes * 0.5)));
    });
  }

  public static selectBestLod(samplesPerPixel: number): WaveformLodLevel {
    if (!Number.isFinite(samplesPerPixel)) return 1024;
    if (samplesPerPixel <= 128) return 64;
    if (samplesPerPixel <= 512) return 256;
    if (samplesPerPixel <= 2048) return 1024;
    return 4096;
  }

  /**
   * Computes or reuses ONLY the tiles overlapping [startSample, endSample) at the requested LOD.
   */
  public getOrComputeRangeTiles(params: {
    readonly assetId: string;
    readonly channelIndex: number;
    readonly sourceChannelPcm: Float32Array;
    readonly startSample: number;
    readonly endSample: number;
    readonly samplesPerBucket: WaveformLodLevel;
  }): readonly WaveformBucketTile[] {
    const { assetId, channelIndex, sourceChannelPcm, samplesPerBucket } = params;
    const totalSamples = sourceChannelPcm.length;
    if (totalSamples === 0) return [];
    if (!Number.isFinite(params.startSample) || !Number.isFinite(params.endSample)) return [];

    const clampedStart = Math.max(0, Math.min(totalSamples, Math.floor(params.startSample)));
    const clampedEnd = Math.max(clampedStart, Math.min(totalSamples, Math.ceil(params.endSample)));
    if (clampedEnd <= clampedStart) return [];

    const samplesPerTile = this.bucketsPerTile * samplesPerBucket;
    const firstTile = Math.floor(clampedStart / samplesPerTile);
    const lastTile = Math.floor((clampedEnd - 1) / samplesPerTile);
    const result: WaveformBucketTile[] = [];

    for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex += 1) {
      const key = this.buildKey(assetId, channelIndex, samplesPerBucket, tileIndex);
      const cached = this.tiles.get(key);
      if (cached) {
        cached.lastUsedSeq = ++this.lruSeq;
        this.hits += 1;
        result.push(cached);
        continue;
      }

      this.misses += 1;
      const tileStart = tileIndex * samplesPerTile;
      const tileEnd = Math.min(totalSamples, tileStart + samplesPerTile);
      const bucketCount = Math.max(1, Math.ceil((tileEnd - tileStart) / samplesPerBucket));
      const mins = new Float32Array(bucketCount);
      const maxs = new Float32Array(bucketCount);

      for (let b = 0; b < bucketCount; b += 1) {
        const bStart = tileStart + b * samplesPerBucket;
        const bEnd = Math.min(tileEnd, bStart + samplesPerBucket);
        let minVal = 1.0;
        let maxVal = -1.0;
        for (let s = bStart; s < bEnd; s += 1) {
          const rawV = sourceChannelPcm[s];
          const v = Number.isFinite(rawV) ? rawV : 0;
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
        if (bEnd <= bStart) {
          minVal = 0;
          maxVal = 0;
        }
        mins[b] = minVal;
        maxs[b] = maxVal;
      }

      const bytes = mins.byteLength + maxs.byteLength;
      const tile: WaveformBucketTile = {
        assetId,
        channelIndex,
        samplesPerBucket,
        tileIndex,
        startSample: tileStart,
        endSample: tileEnd,
        mins,
        maxs,
        bytes,
        lastUsedSeq: ++this.lruSeq,
      };

      this.storeTileBounded(key, tile);
      result.push(tile);
    }

    return result;
  }

  /** Invalidates ONLY tiles overlapping the modified source sample region */
  public invalidateSampleRange(assetId: string, startSample: number, endSample: number): number {
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) return 0;
    let removed = 0;
    for (const [key, tile] of Array.from(this.tiles.entries())) {
      if (
        tile.assetId === assetId &&
        tile.endSample > startSample &&
        tile.startSample < endSample
      ) {
        this.deleteTile(key);
        removed += 1;
        this.invalidations += 1;
      }
    }
    return removed;
  }

  public releaseAsset(assetId: string): number {
    let removed = 0;
    for (const [key, tile] of Array.from(this.tiles.entries())) {
      if (tile.assetId === assetId) {
        this.deleteTile(key);
        removed += 1;
      }
    }
    return removed;
  }

  public clear(): void {
    for (const key of Array.from(this.tiles.keys())) {
      this.deleteTile(key);
    }
  }

  public dispose(): void {
    this.unregisterEviction();
    this.clear();
  }

  public getStats(): WaveformCacheStats {
    return {
      tileCount: this.tiles.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      invalidations: this.invalidations,
    };
  }

  private storeTileBounded(key: string, tile: WaveformBucketTile): void {
    while (this.totalBytes + tile.bytes > this.maxBytes && this.tiles.size > 0) {
      if (!this.evictOldestTile()) break;
    }

    let reservation: MemoryReservation | null = null;
    try {
      reservation = this.memoryBudget.reserve({
        owner: `waveform_tile_${key}`,
        category: 'audio-cache',
        bytes: tile.bytes,
        priority: 'optional',
      });
    } catch {
      // Under emergency pressure, still return the freshly computed tile without retaining it in cache
      return;
    }

    this.tiles.set(key, tile);
    this.reservations.set(key, reservation);
    this.totalBytes += tile.bytes;
  }

  private evictToFreeBytes(targetBytes: number): void {
    let freed = 0;
    while (freed < targetBytes && this.tiles.size > 0) {
      const oldestKey = this.findOldestKey();
      if (!oldestKey) break;
      const tile = this.tiles.get(oldestKey);
      freed += tile?.bytes ?? 0;
      this.deleteTile(oldestKey);
      this.evictions += 1;
    }
  }

  private evictOldestTile(): boolean {
    const oldestKey = this.findOldestKey();
    if (!oldestKey) return false;
    this.deleteTile(oldestKey);
    this.evictions += 1;
    return true;
  }

  private findOldestKey(): string | null {
    let oldestKey: string | null = null;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [k, tile] of this.tiles.entries()) {
      if (tile.lastUsedSeq < oldestSeq) {
        oldestSeq = tile.lastUsedSeq;
        oldestKey = k;
      }
    }
    return oldestKey;
  }

  private deleteTile(key: string): void {
    const tile = this.tiles.get(key);
    if (tile) {
      this.totalBytes = Math.max(0, this.totalBytes - tile.bytes);
      this.tiles.delete(key);
    }
    const res = this.reservations.get(key);
    if (res) {
      this.memoryBudget.release(res);
      this.reservations.delete(key);
    }
  }

  private buildKey(
    assetId: string,
    channelIndex: number,
    lod: WaveformLodLevel,
    tileIndex: number,
  ): string {
    return `${assetId}:ch${channelIndex}:lod${lod}:t${tileIndex}`;
  }
}
