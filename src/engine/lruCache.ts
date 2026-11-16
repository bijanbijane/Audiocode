import { RollingCacheStats } from '../contracts/v1_2';

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
 * Bounds decoded Float32 PCM footprint in RAM/OPFS to prevent quota and memory explosions
 * on multi-hour, multi-track projects.
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
    if (maxBytes <= 0) {
      throw new Error('RollingLruBlockCache maxBytes must be > 0');
    }
    this.maxBytes = maxBytes;
  }

  static makeKey(assetId: string, blockIndex: number): string {
    return `${assetId}::blk:${blockIndex}`;
  }

  get(assetId: string, blockIndex: number): CachedPcmBlock | undefined {
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

  put(assetId: string, blockIndex: number, channels: Float32Array[]): CachedPcmBlock {
    const key = RollingLruBlockCache.makeKey(assetId, blockIndex);
    let byteSize = 0;
    for (const ch of channels) {
      byteSize += ch.byteLength;
    }

    const prev = this.map.get(key);
    if (prev) {
      this.usedBytes -= prev.byteSize;
      this.map.delete(key);
    }

    // Evict coldest blocks until byteSize fits within maxBytes budget
    while (this.usedBytes + byteSize > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) {
        this.usedBytes -= oldest.byteSize;
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

    if (byteSize <= this.maxBytes) {
      this.map.set(key, block);
      this.usedBytes += byteSize;
    }
    return block;
  }

  evictAsset(assetId: string): number {
    let removed = 0;
    for (const [key, block] of this.map.entries()) {
      if (block.assetId === assetId) {
        this.map.delete(key);
        this.usedBytes -= block.byteSize;
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
