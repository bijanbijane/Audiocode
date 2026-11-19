import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingLruBlockCache } from './lruCache';

test('RollingLruBlockCache enforces strict byte budget and evicts least-recently-used block', () => {
  // Each block is 1024 Float32 samples = 4096 bytes. Cap at 10,000 bytes (max 2 blocks).
  const cache = new RollingLruBlockCache(10_000);

  assert.ok(cache.put('asset-1', 0, [new Float32Array(1024)]) !== null);
  assert.ok(cache.put('asset-1', 1, [new Float32Array(1024)]) !== null);

  // Access block 0 so block 1 becomes the LRU victim
  assert.ok(cache.get('asset-1', 0) !== undefined);

  // Inserting block 2 should evict block 1, keeping total <= 8192 bytes
  assert.ok(cache.put('asset-1', 2, [new Float32Array(1024)]) !== null);

  const stats = cache.getStats();
  assert.equal(stats.cachedBlocks, 2);
  assert.equal(stats.usedBytes, 8192);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 0);
  assert.equal(cache.get('asset-1', 1), undefined);
  assert.ok(cache.get('asset-1', 0) !== undefined);
  assert.ok(cache.get('asset-1', 2) !== undefined);
});

test('RollingLruBlockCache rejects oversized entries without evicting existing cached blocks', () => {
  const cache = new RollingLruBlockCache(8192);
  cache.put('asset-1', 0, [new Float32Array(1024)]); // 4096 B
  cache.put('asset-1', 1, [new Float32Array(1024)]); // 4096 B

  // Attempt to insert 16384-byte block (> 8192 maxBytes)
  const rejected = cache.put('asset-1', 2, [new Float32Array(4096)]);
  assert.equal(rejected, null);

  // Also test replacing an existing key with an oversized entry — original entry must stay intact
  const rejectedReplace = cache.put('asset-1', 0, [new Float32Array(4096)]);
  assert.equal(rejectedReplace, null);

  const stats = cache.getStats();
  assert.equal(stats.cachedBlocks, 2);
  assert.equal(stats.usedBytes, 8192);
  assert.equal(stats.evictions, 0);
  assert.ok(cache.get('asset-1', 0) !== undefined);
  assert.ok(cache.get('asset-1', 1) !== undefined);
});

test('RollingLruBlockCache accounts accurately for replacements and multi-channel entries', () => {
  const cache = new RollingLruBlockCache(20_000);

  // Stereo separate buffers: 2 * 4096 = 8192 B
  const inserted = cache.put('stereo', 0, [new Float32Array(1024), new Float32Array(1024)]);
  assert.ok(inserted !== null);
  assert.equal(inserted.byteSize, 8192);
  assert.equal(cache.getStats().usedBytes, 8192);

  // Replace same key with a smaller mono block: 4096 B
  const replaced = cache.put('stereo', 0, [new Float32Array(1024)]);
  assert.ok(replaced !== null);
  assert.equal(cache.getStats().cachedBlocks, 1);
  assert.equal(cache.getStats().usedBytes, 4096);
  assert.equal(cache.getStats().evictions, 0);

  // Stereo views backed by one shared ArrayBuffer count the backing buffer once (8192 B)
  const sharedPlanar = new Float32Array(2048); // 8192 B backing
  const ch0 = sharedPlanar.subarray(0, 1024);
  const ch1 = sharedPlanar.subarray(1024, 2048);
  const sharedEntry = cache.put('stereo', 1, [ch0, ch1]);
  assert.ok(sharedEntry !== null);
  assert.equal(sharedEntry.byteSize, 8192);
  assert.equal(cache.getStats().usedBytes, 4096 + 8192);
});

test('RollingLruBlockCache accounts for large subarray backing buffers and rejects huge retained buffers', () => {
  const cache = new RollingLruBlockCache(16_384);
  cache.put('asset-a', 0, [new Float32Array(1024)]); // 4096 B

  // Small 16-byte view into a 64 KiB backing ArrayBuffer (> 16 KiB cache ceiling)
  const hugeBacking = new Float32Array(16_384); // 65,536 B
  const tinyView = hugeBacking.subarray(0, 4); // only 16 B visible
  assert.equal(tinyView.byteLength, 16);

  // Must be rejected based on 65,536 B backing buffer without flushing asset-a:0
  assert.equal(cache.put('asset-a', 1, [tinyView]), null);
  assert.equal(cache.getStats().usedBytes, 4096);
  assert.equal(cache.getStats().cachedBlocks, 1);

  // Subarray with 8,192 B backing buffer fits and accounts for full 8,192 B (not 16 B)
  const mediumBacking = new Float32Array(2048); // 8,192 B
  const mediumSlice = mediumBacking.subarray(10, 14);
  const stored = cache.put('asset-a', 2, [mediumSlice]);
  assert.ok(stored !== null);
  assert.equal(stored.byteSize, 8192);
  assert.equal(cache.getStats().usedBytes, 4096 + 8192);
});

test('RollingLruBlockCache rejects empty, invalid, and SharedArrayBuffer inputs cleanly', () => {
  assert.throws(() => new RollingLruBlockCache(0), RangeError);
  assert.throws(() => new RollingLruBlockCache(-100), RangeError);
  assert.throws(() => new RollingLruBlockCache(Number.NaN), RangeError);

  const cache = new RollingLruBlockCache(16_384);
  cache.put('asset-a', 0, [new Float32Array(512)]);

  assert.equal(cache.put('', 0, [new Float32Array(512)]), null);
  assert.equal(cache.put('asset-a', -1, [new Float32Array(512)]), null);
  assert.equal(cache.put('asset-a', 1.5, [new Float32Array(512)]), null);
  assert.equal(cache.put('asset-a', 1, []), null);
  assert.equal(cache.put('asset-a', 1, [new Float32Array(0)]), null);

  if (typeof SharedArrayBuffer !== 'undefined') {
    const sabView = new Float32Array(new SharedArrayBuffer(1024));
    assert.equal(cache.put('asset-a', 2, [sabView]), null);
  }

  assert.equal(cache.getStats().cachedBlocks, 1);
  assert.equal(cache.getStats().usedBytes, 2048);
});
