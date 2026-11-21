/**
 * Standalone, FIPS 180-4 compliant incremental SHA-256 engine and bounded-memory Blob hasher.
 *
 * Guarantees:
 * - Processes every byte of arbitrarily large files in O(1) memory (default 1 MiB read window,
 *   64-byte internal block buffer, 32-byte Uint32Array(8) hash state).
 * - Never calls blob.arrayBuffer() on the complete file.
 * - Never falls back to FNV-1a, sampling windows, or pseudo-SHA identifiers.
 */

export const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_SAFE_CHUNK_BYTES = 64 * 1024 * 1024;

// Standard FIPS 180-4 SHA-256 initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
const SHA256_IV = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

// Standard FIPS 180-4 SHA-256 round constants (first 32 bits of fractional parts of cube roots of first 64 primes)
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX_BYTES: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export interface Sha256BlobOptions {
  readonly chunkSizeBytes?: number;
  readonly shouldAbort?: () => void;
}

export class IncrementalSha256 {
  private readonly state = new Uint32Array(SHA256_IV);
  private readonly blockBuffer = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private bytesLow = 0;
  private bytesHigh = 0;
  private finalized = false;

  public update(data: Uint8Array): this {
    if (this.finalized) {
      throw new Error(
        'SHA256_ALREADY_FINALIZED: Cannot call update() after the SHA-256 digest has been finalized.',
      );
    }
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(
        'SHA256_INVALID_INPUT: IncrementalSha256.update() requires a Uint8Array.',
      );
    }

    const totalLen = data.byteLength;
    if (totalLen === 0) {
      return this;
    }

    // Track exact 64-bit byte count without floating-point precision loss
    const lowAdd = totalLen >>> 0;
    const highAdd = Math.floor(totalLen / 0x100000000);
    const prevLow = this.bytesLow;
    this.bytesLow = (prevLow + lowAdd) >>> 0;
    this.bytesHigh = (this.bytesHigh + highAdd + (this.bytesLow < prevLow ? 1 : 0)) >>> 0;

    let offset = 0;

    // Fill existing partial 64-byte block if present
    if (this.blockLength > 0) {
      const needed = 64 - this.blockLength;
      if (totalLen < needed) {
        this.blockBuffer.set(data, this.blockLength);
        this.blockLength += totalLen;
        return this;
      }
      this.blockBuffer.set(data.subarray(0, needed), this.blockLength);
      this.compressBlock(this.blockBuffer, 0);
      this.blockLength = 0;
      offset = needed;
    }

    // Compress full 64-byte blocks directly from the caller buffer (zero extra copy)
    while (offset + 64 <= totalLen) {
      this.compressBlock(data, offset);
      offset += 64;
    }

    // Retain trailing partial block (< 64 bytes) in the fixed 64-byte buffer
    const remaining = totalLen - offset;
    if (remaining > 0) {
      this.blockBuffer.set(data.subarray(offset), 0);
      this.blockLength = remaining;
    }

    return this;
  }

  public digest(): Uint8Array {
    if (this.finalized) {
      throw new Error(
        'SHA256_ALREADY_FINALIZED: Cannot call digest() more than once on the same IncrementalSha256 instance.',
      );
    }
    this.finalized = true;

    const buf = this.blockBuffer;
    let pos = this.blockLength;

    // Append mandatory '1' bit followed by zero bits (0x80 byte)
    buf[pos++] = 0x80;

    // If fewer than 8 bytes remain for the 64-bit big-endian bit length, pad and compress first
    if (pos > 56) {
      buf.fill(0, pos, 64);
      this.compressBlock(buf, 0);
      pos = 0;
    }

    buf.fill(0, pos, 56);

    // Encode exact 64-bit unsigned message length in bits (big-endian)
    const bitsHigh = ((this.bytesHigh << 3) | (this.bytesLow >>> 29)) >>> 0;
    const bitsLow = (this.bytesLow << 3) >>> 0;

    buf[56] = (bitsHigh >>> 24) & 0xff;
    buf[57] = (bitsHigh >>> 16) & 0xff;
    buf[58] = (bitsHigh >>> 8) & 0xff;
    buf[59] = bitsHigh & 0xff;
    buf[60] = (bitsLow >>> 24) & 0xff;
    buf[61] = (bitsLow >>> 16) & 0xff;
    buf[62] = (bitsLow >>> 8) & 0xff;
    buf[63] = bitsLow & 0xff;

    this.compressBlock(buf, 0);

    // Serialize 8 x 32-bit big-endian hash words into 32-byte digest
    const out = new Uint8Array(32);
    const st = this.state;
    for (let i = 0; i < 8; i++) {
      const word = st[i];
      const base = i * 4;
      out[base] = (word >>> 24) & 0xff;
      out[base + 1] = (word >>> 16) & 0xff;
      out[base + 2] = (word >>> 8) & 0xff;
      out[base + 3] = word & 0xff;
    }

    // Clear transient working buffers
    this.blockBuffer.fill(0);
    this.schedule.fill(0);
    this.blockLength = 0;

    return out;
  }

  public digestHex(): string {
    const bytes = this.digest();
    let hex = '';
    for (let i = 0; i < 32; i++) {
      hex += HEX_BYTES[bytes[i]];
    }
    return hex;
  }

  private compressBlock(chunk: Uint8Array, offset: number): void {
    const w = this.schedule;
    const k = SHA256_K;
    const st = this.state;

    // 1. Parse 16 big-endian 32-bit words
    for (let i = 0; i < 16; i++) {
      const base = offset + (i << 2);
      w[i] =
        ((chunk[base] << 24) |
          (chunk[base + 1] << 16) |
          (chunk[base + 2] << 8) |
          chunk[base + 3]) >>>
        0;
    }

    // 2. Extend message schedule to 64 words
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const w2 = w[i - 2];
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    // 3. Initialize working variables
    let a = st[0];
    let b = st[1];
    let c = st[2];
    let d = st[3];
    let e = st[4];
    let f = st[5];
    let g = st[6];
    let h = st[7];

    // 4. 64 compression rounds
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + k[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    // 5. Add compressed chunk back to current hash state
    st[0] = (st[0] + a) >>> 0;
    st[1] = (st[1] + b) >>> 0;
    st[2] = (st[2] + c) >>> 0;
    st[3] = (st[3] + d) >>> 0;
    st[4] = (st[4] + e) >>> 0;
    st[5] = (st[5] + f) >>> 0;
    st[6] = (st[6] + g) >>> 0;
    st[7] = (st[7] + h) >>> 0;
  }
}

export async function sha256Blob(
  blob: Blob,
  options?: Sha256BlobOptions,
): Promise<string> {
  if (
    !blob ||
    typeof blob !== 'object' ||
    typeof blob.size !== 'number' ||
    typeof blob.slice !== 'function'
  ) {
    throw new TypeError('SHA256_INVALID_BLOB: Expected a valid Blob instance.');
  }

  const totalSize = blob.size;
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new RangeError(
      `SHA256_INVALID_BLOB_SIZE: Blob size must be a non-negative safe integer, got ${String(totalSize)}.`,
    );
  }

  const chunkSizeBytes = options?.chunkSizeBytes ?? HASH_CHUNK_BYTES;
  if (
    typeof chunkSizeBytes !== 'number' ||
    !Number.isSafeInteger(chunkSizeBytes) ||
    chunkSizeBytes <= 0 ||
    chunkSizeBytes > MAX_SAFE_CHUNK_BYTES
  ) {
    throw new RangeError(
      `SHA256_INVALID_CHUNK_SIZE: chunkSizeBytes must be a safe integer in [1, ${MAX_SAFE_CHUNK_BYTES}], got ${String(chunkSizeBytes)}.`,
    );
  }

  const shouldAbort = options?.shouldAbort;
  if (shouldAbort !== undefined && typeof shouldAbort !== 'function') {
    throw new TypeError('SHA256_INVALID_ABORT_HOOK: shouldAbort must be a function when provided.');
  }

  const hasher = new IncrementalSha256();
  let offset = 0;

  shouldAbort?.();

  while (offset < totalSize) {
    shouldAbort?.();
    const end = Math.min(offset + chunkSizeBytes, totalSize);
    const expectedSliceLen = end - offset;

    let slice: Blob | null = blob.slice(offset, end);
    let buffer: ArrayBuffer | null = await slice.arrayBuffer();
    slice = null;

    shouldAbort?.();

    const actualLen = buffer.byteLength;
    if (actualLen !== expectedSliceLen) {
      buffer = null;
      throw new Error(
        `SHA256_SHORT_READ: Expected ${expectedSliceLen} bytes for slice [${offset}, ${end}), received ${actualLen} bytes.`,
      );
    }

    let chunkView: Uint8Array | null = new Uint8Array(buffer);
    hasher.update(chunkView);
    chunkView = null;
    buffer = null;
    offset = end;
  }

  if (offset !== totalSize) {
    throw new Error(
      `SHA256_INCOMPLETE_READ: Expected to hash ${totalSize} bytes, consumed ${offset} bytes.`,
    );
  }

  shouldAbort?.();
  return hasher.digestHex();
}

export function sha256Bytes(bytes: Uint8Array): string {
  return new IncrementalSha256().update(bytes).digestHex();
}

