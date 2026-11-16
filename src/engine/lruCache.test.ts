import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingLruBlockCache } from './lruCache';

test('RollingLruBlockCache enforces strict byte budget and evicts least-recently-used block', () => {
  // Each block is 1024 Float32 samples = 4096 bytes. Cap at 10,000 bytes (max 2 blocks).
  const cache = new RollingLruBlockCache(10_000);

  cache.put('asset-1', 0, [new Float32Array(1024)]);
  cache.put('asset-1', 1, [new Float32Array(1024)]);

  // Access block 0 so block 1 becomes the LRU victim
  assert.ok(cache.get('asset-1', 0) !== undefined);

  // Inserting block 2 should evict block 1, keeping total <= 8192 bytes
  cache.put('asset-1', 2, [new Float32Array(1024)]);

  const stats = cache.getStats();
  assert.equal(stats.cachedBlocks, 2);
  assert.equal(stats.usedBytes, 8192);
  assert.equal(stats.evictions, 1);
  assert.equal(cache.get('asset-1', 1), undefined);
  assert.ok(cache.get('asset-1', 0) !== undefined);
  assert.ok(cache.get('asset-1', 2) !== undefined);
});
