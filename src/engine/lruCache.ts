import { RollingCacheStats } from '../contracts/v1_2';
import { measureTypedArrayListBackingBytes } from '../runtime/memory/MemoryPolicy';

export interface CachedPcmBlock {
  key: string;
  assetId: string;
  blockIndex: number;
  channels: Float32Array[];
  byteSize: number;
  lastAccessSeq: number;
}

/**
 * Rolling LRU Block Cache (v1.2 Hybrid Storage Spec)
 * Bounds decoded Float32 PCM footprint in RAM to prevent memory explosions.
 * Accounts for retained typed-array backing buffers rather than small subarray view lengths.
 */
export class RollingLruBlockCache {
  private readonly maxBytes: number;
  private usedBytes = 0;
  private accessCounter = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly map = new Map<string, CachedPcmBlock>();

  constructor(maxBytes: number) {
    if (
      typeof maxBytes !== 'number' ||
      !Number.isFinite(maxBytes) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    ) {
      throw new RangeError('RollingLruBlockCache maxBytes must be a positive safe integer');
    }
    this.maxBytes = maxBytes;
  }

  static makeKey(assetId: string, blockIndex: number): string {
    return `${assetId}::blk:${blockIndex}`;
  }

  get(assetId: string, blockIndex: number): CachedPcmBlock | undefined {
    if (
      typeof assetId !== 'string' ||
      assetId.length === 0 ||
      !Number.isSafeInteger(blockIndex) ||
      blockIndex < 0
    ) {
      this.misses++;
      return undefined;
    }

    const key = RollingLruBlockCache.makeKey(assetId, blockIndex);
    const existing = this.map.get(key);
    if (!existing) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Refresh LRU order by re-inserting at tail of Map
    this.map.delete(key);
    existing.lastAccessSeq = ++this.accessCounter;
    this.map.set(key, existing);
    return existing;
  }

  /**
   * Stores channels in the cache if valid and within `maxBytes` (measured conservatively by
   * backing-buffer retention). Returns `null` without evicting existing entries if the input
   * is empty, invalid, backed by an unmeasurable/SharedArrayBuffer, or larger than `maxBytes`.
   */
  put(assetId: string, blockIndex: number, channels: Float32Array[]): CachedPcmBlock | null {
    if (
      typeof assetId !== 'string' ||
      assetId.trim().length === 0 ||
      !Number.isSafeInteger(blockIndex) ||
      blockIndex < 0 ||
      !Array.isArray(channels) ||
      channels.length === 0
    ) {
      return null;
    }

    for (const ch of channels) {
      if (!(ch instanceof Float32Array) || ch.byteLength === 0) {
        return null;
      }
    }

    const byteSize = measureTypedArrayListBackingBytes(channels);
    if (byteSize === null || byteSize <= 0) {
      return null;
    }

    // Reject oversized entry BEFORE modifying or evicting any existing valid entries
    if (byteSize > this.maxBytes) {
      return null;
    }

    const key = RollingLruBlockCache.makeKey(assetId, blockIndex);
    const prev = this.map.get(key);
    if (prev) {
      this.usedBytes = Math.max(0, this.usedBytes - prev.byteSize);
      this.map.delete(key);
    }

    // Evict coldest blocks until byteSize fits within maxBytes budget
    while (this.usedBytes + byteSize > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) {
        this.usedBytes = Math.max(0, this.usedBytes - oldest.byteSize);
        this.evictions++;
      }
    }

    const block: CachedPcmBlock = {
      key,
      assetId,
      blockIndex,
      channels,
      byteSize,
      lastAccessSeq: ++this.accessCounter,
    };

    this.map.set(key, block);
    this.usedBytes += byteSize;
    return block;
  }

  evictAsset(assetId: string): number {
    let removed = 0;
    for (const [key, block] of this.map.entries()) {
      if (block.assetId === assetId) {
        this.map.delete(key);
        this.usedBytes = Math.max(0, this.usedBytes - block.byteSize);
        this.evictions++;
        removed++;
      }
    }
    return removed;
  }

  evictToBudget(targetMaxBytes: number): number {
    const safeTarget = Math.max(0, Math.trunc(targetMaxBytes));
    let removed = 0;
    while (this.usedBytes > safeTarget && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) {
        this.usedBytes = Math.max(0, this.usedBytes - oldest.byteSize);
        this.evictions++;
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
    this.usedBytes = 0;
  }

  getStats(): RollingCacheStats {
    return {
      maxBytes: this.maxBytes,
      usedBytes: this.usedBytes,
      cachedBlocks: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  listKeys(): string[] {
    return Array.from(this.map.keys());
  }
}
