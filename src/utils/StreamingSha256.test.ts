import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  HASH_CHUNK_BYTES,
  IncrementalSha256,
  sha256Blob,
} from './StreamingSha256';
import {
  IngestAbortedError,
  ingestAudioFileStreaming,
} from '../engine/streamingIngest';
import { encodeAndValidateWavExport } from '../engine/storageBroker';

function referenceSha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function deterministicBytes(length: number, seed = 0x5a): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/**
 * Virtual procedural Blob that synthesizes deterministic bytes on demand per slice
 * without allocating multi-hundred-MiB buffers in RAM, while recording every read.
 */
function createTrackingVirtualBlob(params: {
  readonly totalSize: number;
  readonly mutation?: { readonly offset: number; readonly xorMask: number };
  readonly onSliceRead?: (sliceIndex: number, start: number, end: number) => void;
}) {
  const { totalSize, mutation, onSliceRead } = params;
  const readRanges: Array<{ start: number; end: number; length: number }> = [];
  let maxReadSize = 0;
  let totalBytesRead = 0;
  let fullArrayBufferCalled = false;

  const fillRange = (start: number, end: number): ArrayBuffer => {
    const len = end - start;
    const buf = new ArrayBuffer(len);
    const view = new Uint8Array(buf);
    for (let i = 0; i < len; i++) {
      const pos = start + i;
      // Fast deterministic per-position byte generator
      let v = ((pos * 2654435761) >>> 24) ^ ((pos >>> 8) & 0xff) ^ (pos & 0xff);
      if (mutation && pos === mutation.offset) {
        v ^= mutation.xorMask;
      }
      view[i] = v & 0xff;
    }
    return buf;
  };

  const blobLike = {
    size: totalSize,
    type: 'application/octet-stream',
    slice(start = 0, end = totalSize): Blob {
      const clampedStart = Math.max(0, Math.min(totalSize, start));
      const clampedEnd = Math.max(clampedStart, Math.min(totalSize, end));
      const length = clampedEnd - clampedStart;
      const sliceIndex = readRanges.length;
      readRanges.push({ start: clampedStart, end: clampedEnd, length });
      if (length > maxReadSize) maxReadSize = length;
      totalBytesRead += length;
      return {
        size: length,
        type: 'application/octet-stream',
        async arrayBuffer(): Promise<ArrayBuffer> {
          onSliceRead?.(sliceIndex, clampedStart, clampedEnd);
          return fillRange(clampedStart, clampedEnd);
        },
      } as unknown as Blob;
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      fullArrayBufferCalled = true;
      throw new Error('FORBIDDEN_FULL_FILE_READ: blob.arrayBuffer() must never be called on the complete file.');
    },
  } as unknown as Blob;

  const computeReferenceHash = (): string => {
    const ref = createHash('sha256');
    const step = 1024 * 1024;
    for (let offset = 0; offset < totalSize; offset += step) {
      const end = Math.min(offset + step, totalSize);
      ref.update(new Uint8Array(fillRange(offset, end)));
    }
    return ref.digest('hex');
  };

  return {
    blob: blobLike,
    readRanges,
    getMaxReadSize: () => maxReadSize,
    getTotalBytesRead: () => totalBytesRead,
    wasFullArrayBufferCalled: () => fullArrayBufferCalled,
    computeReferenceHash,
  };
}

test('A. Standard FIPS 180-4 / NIST SHA-256 test vectors pass exactly', () => {
  const enc = new TextEncoder();

  // Vector 1: Empty string
  assert.equal(
    new IncrementalSha256().digestHex(),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    new IncrementalSha256().update(new Uint8Array(0)).digestHex(),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );

  // Vector 2: "abc"
  assert.equal(
    new IncrementalSha256().update(enc.encode('abc')).digestHex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  // Vector 3: NIST 448-bit / 56-byte boundary multi-block vector
  assert.equal(
    new IncrementalSha256()
      .update(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .digestHex(),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );

  // Vector 4: NIST 896-bit / 112-byte multi-block vector
  assert.equal(
    new IncrementalSha256()
      .update(
        enc.encode(
          'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        ),
      )
      .digestHex(),
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  );

  // Vector 5: NIST 1,000,000 repetitions of 'a'
  const millionHasher = new IncrementalSha256();
  const blockOfA = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i++) {
    millionHasher.update(blockOfA);
  }
  assert.equal(
    millionHasher.digestHex(),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('B. Block-boundary integrity matches independent Node crypto SHA-256 across all padding boundaries', () => {
  const lengths = [1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1023, 1024, 1025];
  for (const len of lengths) {
    const payload = deterministicBytes(len, 0x1337 + len);
    const actual = new IncrementalSha256().update(payload).digestHex();
    const expected = referenceSha256Hex(payload);
    assert.equal(actual, expected, `Digest mismatch at boundary length=${len}`);
    assert.equal(actual.length, 64);
    assert.match(actual, /^[0-9a-f]{64}$/);
  }
});

test('C. Incremental update equivalence holds across arbitrary chunking strategies', () => {
  const payload = deterministicBytes(131_107, 0x9e3779b9); // ~128 KiB + odd tail
  const expected = referenceSha256Hex(payload);

  // 1. One complete update
  assert.equal(new IncrementalSha256().update(payload).digestHex(), expected);

  // 2. Fixed 64-byte updates
  const h64 = new IncrementalSha256();
  for (let o = 0; o < payload.length; o += 64) {
    h64.update(payload.subarray(o, Math.min(o + 64, payload.length)));
  }
  assert.equal(h64.digestHex(), expected);

  // 3. Fixed 1 KiB updates
  const h1k = new IncrementalSha256();
  for (let o = 0; o < payload.length; o += 1024) {
    h1k.update(payload.subarray(o, Math.min(o + 1024, payload.length)));
  }
  assert.equal(h1k.digestHex(), expected);

  // 4. Fixed 64 KiB updates
  const h64k = new IncrementalSha256();
  for (let o = 0; o < payload.length; o += 65536) {
    h64k.update(payload.subarray(o, Math.min(o + 65536, payload.length)));
  }
  assert.equal(h64k.digestHex(), expected);

  // 5. Irregular prime/non-aligned update boundaries
  const steps = [1, 3, 7, 13, 29, 55, 56, 63, 64, 65, 127, 257, 1021, 4099];
  const hIrreg = new IncrementalSha256();
  let off = 0;
  let stepIdx = 0;
  while (off < payload.length) {
    const step = steps[stepIdx % steps.length];
    const end = Math.min(off + step, payload.length);
    hIrreg.update(payload.subarray(off, end));
    off = end;
    stepIdx++;
  }
  assert.equal(hIrreg.digestHex(), expected);

  // 6. Single-byte updates (exercise on multi-block 4099-byte slice to keep fast & exact)
  const singleBytePayload = payload.subarray(0, 4099);
  const hSingle = new IncrementalSha256();
  for (let i = 0; i < singleBytePayload.length; i++) {
    hSingle.update(singleBytePayload.subarray(i, i + 1));
  }
  assert.equal(hSingle.digestHex(), referenceSha256Hex(singleBytePayload));
});

test('D. Large-file (> 8 MiB) collision regression: single interior unsampled byte mutation produces distinct full SHA-256', async () => {
  // 10 MiB payload (> previous 8 MiB threshold).
  // Previous 3-window sampler read [0, 512 KiB), [4.75 MiB, 5.25 MiB), [9.5 MiB, 10 MiB).
  // Mutate exactly one byte at 2 MiB + 137 (strictly inside the old unsampled blind spot).
  const sizeBytes = 10 * 1024 * 1024;
  const unsampledOffset = 2 * 1024 * 1024 + 137;

  const original = createTrackingVirtualBlob({ totalSize: sizeBytes });
  const modified = createTrackingVirtualBlob({
    totalSize: sizeBytes,
    mutation: { offset: unsampledOffset, xorMask: 0x01 },
  });

  const hashOriginal = await sha256Blob(original.blob);
  const hashModified = await sha256Blob(modified.blob);

  assert.notEqual(hashOriginal, hashModified);
  assert.equal(hashOriginal, original.computeReferenceHash());
  assert.equal(hashModified, modified.computeReferenceHash());
  assert.equal(original.getTotalBytesRead(), sizeBytes);
  assert.equal(modified.getTotalBytesRead(), sizeBytes);

  // Also verify end-to-end through ingestAudioFileStreaming() on two real > 8 MiB WAV Files
  // 16 kHz * 16-bit mono = 32,000 B/s => 270 seconds = 8,640,044 bytes (> 8 MiB)
  const wavSamples = 16_000 * 270;
  const pcm = new Float32Array(wavSamples);
  for (let i = 0; i < 16_000; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 220 * i) / 16_000) * 0.25;
  }
  const encoded = encodeAndValidateWavExport([pcm], 16_000);
  const wavBytesA = new Uint8Array(await encoded.blob.arrayBuffer());
  assert.ok(wavBytesA.byteLength > 8 * 1024 * 1024, 'WAV must exceed 8 MiB threshold');

  const wavBytesB = new Uint8Array(wavBytesA);
  // Flip one interior byte strictly outside 512 KiB head/mid/tail windows
  const wavUnsampledOffset = 2 * 1024 * 1024 + 1024;
  wavBytesB[wavUnsampledOffset] ^= 0x04;

  const fileA = new File([wavBytesA], 'large-episode.wav', { type: 'audio/wav' });
  const fileB = new File([wavBytesB], 'large-episode.wav', { type: 'audio/wav' });

  const [ingestedA, ingestedB] = await Promise.all([
    ingestAudioFileStreaming(fileA, { chunkSeconds: 10 }),
    ingestAudioFileStreaming(fileB, { chunkSeconds: 10 }),
  ]);
  const assetA = Object.values(ingestedA.assets)[0];
  const assetB = Object.values(ingestedB.assets)[0];

  assert.equal(assetA.contentHash, `sha256:${referenceSha256Hex(wavBytesA)}`);
  assert.equal(assetB.contentHash, `sha256:${referenceSha256Hex(wavBytesB)}`);
  assert.notEqual(assetA.contentHash, assetB.contentHash);
  assert.notEqual(assetA.id, assetB.id);
});

test('E. Filename independence: identical binary payloads with different filenames produce identical full-content hashes', async () => {
  const pcm = new Float32Array(16_000 * 2);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 330 * i) / 16_000) * 0.3;
  }
  const encoded = encodeAndValidateWavExport([pcm], 16_000);
  const raw = new Uint8Array(await encoded.blob.arrayBuffer());
  const expectedHex = referenceSha256Hex(raw);

  const file1 = new File([raw], 'episode-01-original.wav', { type: 'audio/wav' });
  const file2 = new File([raw], 'renamed-archive-copy-99.wav', { type: 'audio/wav' });

  const [h1, h2] = await Promise.all([sha256Blob(file1), sha256Blob(file2)]);
  assert.equal(h1, expectedHex);
  assert.equal(h2, expectedHex);

  const [ing1, ing2] = await Promise.all([
    ingestAudioFileStreaming(file1, { chunkSeconds: 1 }),
    ingestAudioFileStreaming(file2, { chunkSeconds: 1 }),
  ]);
  const a1 = Object.values(ing1.assets)[0];
  const a2 = Object.values(ing2.assets)[0];
  assert.equal(a1.contentHash, `sha256:${expectedHex}`);
  assert.equal(a2.contentHash, `sha256:${expectedHex}`);
  assert.equal(a1.id, a2.id);
});

test('F. Bounded-memory verification: sha256Blob never performs full-file read and enforces maxReadSize <= 1 MiB', async () => {
  const totalSize = 5 * 1024 * 1024 + 123_457; // ~5.12 MiB
  const tracked = createTrackingVirtualBlob({ totalSize });

  const digest = await sha256Blob(tracked.blob);

  assert.equal(tracked.wasFullArrayBufferCalled(), false);
  assert.ok(tracked.getMaxReadSize() <= HASH_CHUNK_BYTES);
  assert.equal(tracked.getTotalBytesRead(), totalSize);
  assert.equal(tracked.readRanges.length, Math.ceil(totalSize / HASH_CHUNK_BYTES));
  assert.equal(digest, tracked.computeReferenceHash());
});

test('G. Abort behavior: aborting mid-stream stops chunk reads immediately and preserves IngestAbortedError in ingestion', async () => {
  const totalSize = 6 * 1024 * 1024;
  let aborted = false;
  const tracked = createTrackingVirtualBlob({
    totalSize,
    onSliceRead: (sliceIndex) => {
      if (sliceIndex === 2) {
        aborted = true;
      }
    },
  });

  await assert.rejects(
    sha256Blob(tracked.blob, {
      chunkSizeBytes: HASH_CHUNK_BYTES,
      shouldAbort: () => {
        if (aborted) {
          throw new IngestAbortedError('Aborted during chunk 2');
        }
      },
    }),
    (err: unknown) => err instanceof IngestAbortedError,
  );

  // Only slices 0, 1, 2 were read; slices 3, 4, 5 must never be read
  assert.equal(tracked.readRanges.length, 3);
  assert.equal(tracked.getTotalBytesRead(), 3 * HASH_CHUNK_BYTES);

  // Verify ingestAudioFileStreaming propagates IngestAbortedError when abort fires during hashing
  const pcm = new Float32Array(16_000 * 40); // ~1.28 MiB WAV => 2 hash chunks at 1 MiB
  const wavBlob = encodeAndValidateWavExport([pcm], 16_000).blob;
  const wavBuf = await wavBlob.arrayBuffer();
  const controller = new AbortController();
  let ingestSlices = 0;

  const baseFile = new File([wavBuf], 'abort-hash-test.wav', { type: 'audio/wav' });
  const abortingFile = new Proxy(baseFile, {
    get(target, prop, receiver) {
      if (prop === 'slice') {
        return (start?: number, end?: number, contentType?: string) => {
          const s = target.slice(start, end, contentType);
          // First slice is 64-byte magic check; second slice is first 1 MiB hash chunk
          ingestSlices++;
          if (ingestSlices === 2) {
            controller.abort();
          }
          return s;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });

  await assert.rejects(
    ingestAudioFileStreaming(abortingFile, { abortSignal: controller.signal }),
    (err: unknown) => err instanceof IngestAbortedError,
  );
  // Must stop right after the aborted hash chunk without continuing to parse/decode remaining chunks
  assert.equal(ingestSlices, 2);
});

test('H. Finalization protection and strict input/chunk-size validation', async () => {
  const hasher = new IncrementalSha256();
  hasher.update(new Uint8Array([1, 2, 3]));
  const firstDigest = hasher.digest();
  assert.equal(firstDigest.byteLength, 32);

  assert.throws(() => hasher.update(new Uint8Array([4])), /SHA256_ALREADY_FINALIZED/);
  assert.throws(() => hasher.digest(), /SHA256_ALREADY_FINALIZED/);
  assert.throws(() => hasher.digestHex(), /SHA256_ALREADY_FINALIZED/);

  const hexHasher = new IncrementalSha256();
  const hex = hexHasher.digestHex();
  assert.equal(hex.length, 64);
  assert.throws(() => hexHasher.update(new Uint8Array(1)), /SHA256_ALREADY_FINALIZED/);
  assert.throws(() => hexHasher.digestHex(), /SHA256_ALREADY_FINALIZED/);

  // Invalid update() input types
  const h = new IncrementalSha256();
  for (const invalid of [null, undefined, 'abc', [1, 2, 3], new ArrayBuffer(4), 42]) {
    assert.throws(() => h.update(invalid as unknown as Uint8Array), TypeError);
  }

  // Invalid chunkSizeBytes configurations
  const validBlob = new Blob([new Uint8Array(16)]);
  for (const badChunk of [0, -1, -1024, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 128 * 1024 * 1024]) {
    await assert.rejects(
      sha256Blob(validBlob, { chunkSizeBytes: badChunk }),
      RangeError,
    );
  }

  // Invalid blob.size
  const badSizeBlob = {
    size: -5,
    slice: () => validBlob,
  } as unknown as Blob;
  await assert.rejects(sha256Blob(badSizeBlob), RangeError);
});

test('I. Deterministic resource benchmark across 1 MiB, 8 MiB, 64 MiB, and 256 MiB bounded payloads', async () => {
  const tiers = [
    { label: '1 MiB', bytes: 1 * 1024 * 1024 },
    { label: '8 MiB', bytes: 8 * 1024 * 1024 },
    { label: '64 MiB', bytes: 64 * 1024 * 1024 },
    { label: '256 MiB', bytes: 256 * 1024 * 1024 },
  ];

  const results: Array<{
    label: string;
    durationMs: number;
    readOps: number;
    totalBytesHashed: number;
    maxChunkAllocation: number;
    digestMatchesReference: boolean;
  }> = [];

  for (const tier of tiers) {
    const tracked = createTrackingVirtualBlob({ totalSize: tier.bytes });
    const startMs = performance.now();
    const digest = await sha256Blob(tracked.blob, { chunkSizeBytes: HASH_CHUNK_BYTES });
    const durationMs = performance.now() - startMs;

    const expected = tracked.computeReferenceHash();
    const digestMatchesReference = digest === expected;

    assert.equal(digestMatchesReference, true, `Digest mismatch on ${tier.label} payload`);
    assert.equal(tracked.wasFullArrayBufferCalled(), false);
    assert.equal(tracked.getTotalBytesRead(), tier.bytes);
    assert.equal(tracked.readRanges.length, Math.ceil(tier.bytes / HASH_CHUNK_BYTES));
    assert.ok(tracked.getMaxReadSize() <= HASH_CHUNK_BYTES);

    results.push({
      label: tier.label,
      durationMs: Math.round(durationMs * 100) / 100,
      readOps: tracked.readRanges.length,
      totalBytesHashed: tracked.getTotalBytesRead(),
      maxChunkAllocation: tracked.getMaxReadSize(),
      digestMatchesReference,
    });
  }

  assert.equal(results.length, 4);
  for (const r of results) {
    assert.equal(r.digestMatchesReference, true);
    assert.equal(r.maxChunkAllocation, HASH_CHUNK_BYTES);
  }
});
