import { SampleRate } from '../contracts/timebase.contract';
import type {
  RenderArtifactReadStreamOptions,
  StreamingByteSink,
} from './RenderOutputArtifactContracts';
export type {
  RenderArtifactReadStreamOptions,
  RenderArtifactReader,
  StreamingByteSink,
} from './RenderOutputArtifactContracts';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import {
  bitsPerSampleForEncoding,
  bytesPerSampleForEncoding,
} from './AudioRenderPlanner';
import {
  RenderExportContainer,
  RenderExportEncoding,
  RenderOutputMetadata,
  RIFF_WAV_MAX_DATA_BYTES,
} from './AudioRenderTypes';

export const DEFAULT_MAX_ARTIFACT_READ_BYTES = 1024 * 1024; // 1 MiB



/**
 * Bounded, range-addressable reader contract for committed render outputs.
 * Prevents unbounded full-file allocations during validation and export streaming.
 */


export function validateArtifactRangeRead(
  sizeBytes: number,
  offset: number,
  length: number,
  maxReadWindowBytes = DEFAULT_MAX_ARTIFACT_READ_BYTES,
): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError(`Invalid artifact sizeBytes: ${String(sizeBytes)}.`);
  }
  if (!Number.isSafeInteger(maxReadWindowBytes) || maxReadWindowBytes <= 0) {
    throw new RangeError(`Invalid maxReadWindowBytes: ${String(maxReadWindowBytes)}.`);
  }
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid readRange offset: ${String(offset)}.`);
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid readRange length: ${String(length)}.`);
  }
  if (length > maxReadWindowBytes) {
    throw new RangeError(
      `Requested readRange length (${length} B) exceeds maximum window (${maxReadWindowBytes} B).`,
    );
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || offset > sizeBytes || end > sizeBytes) {
    throw new RangeError(
      `Requested range [${offset}, ${offset} + ${length}) exceeds artifact size (${sizeBytes} B).`,
    );
  }
}

export function validateArtifactStreamOptions(
  sizeBytes: number,
  options?: RenderArtifactReadStreamOptions,
  maxReadWindowBytes = DEFAULT_MAX_ARTIFACT_READ_BYTES,
): { readonly start: number; readonly end: number; readonly chunkSizeBytes: number } {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError(`Invalid artifact sizeBytes: ${String(sizeBytes)}.`);
  }
  if (!Number.isSafeInteger(maxReadWindowBytes) || maxReadWindowBytes <= 0) {
    throw new RangeError(`Invalid maxReadWindowBytes: ${String(maxReadWindowBytes)}.`);
  }
  const start = options?.start ?? 0;
  const end = options?.end ?? sizeBytes;
  const chunkSizeBytes = options?.chunkSizeBytes ?? maxReadWindowBytes;

  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > sizeBytes) {
    throw new RangeError(`Invalid stream start offset: ${String(start)} (size=${sizeBytes}).`);
  }
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start || end > sizeBytes) {
    throw new RangeError(`Invalid stream end offset: ${String(end)} (start=${start}, size=${sizeBytes}).`);
  }
  if (
    typeof chunkSizeBytes !== 'number' ||
    !Number.isSafeInteger(chunkSizeBytes) ||
    chunkSizeBytes <= 0 ||
    chunkSizeBytes > maxReadWindowBytes
  ) {
    throw new RangeError(
      `Invalid stream chunkSizeBytes: ${String(chunkSizeBytes)} (max=${maxReadWindowBytes}).`,
    );
  }

  return { start, end, chunkSizeBytes };
}

/**
 * Abstract streaming byte sink so AudioExportWriter can write incrementally to
 * OPFS / FileSystemWritableFileStream, temp disk storage, or a bounded chunked buffer
 * without ever building a giant single contiguous output array in JS memory.
 */


export class ExportWriteFailureError extends Error {
  public readonly code: 'WRITE_IO_FAILURE' | 'OUTPUT_QUOTA_EXCEEDED';

  constructor(code: 'WRITE_IO_FAILURE' | 'OUTPUT_QUOTA_EXCEEDED', message: string) {
    super(message);
    this.name = 'ExportWriteFailureError';
    this.code = code;
  }
}

/**
 * Bounded chunked in-memory byte sink governed by MemoryBudgetManager and optional quota.
 * Uses explicit staging/commit/disposal boundaries so uncommitted, aborted, or disposed
 * outputs are never readable and chunk reservations remain active for the exact lifetime
 * of the retained chunks.
 */
export class BoundedChunkedByteSink implements StreamingByteSink {
  public readonly persistedExternally = false;
  private readonly budget: MemoryBudgetManager;
  private readonly maxQuotaBytes: number | null;
  private readonly maxReadWindowBytes: number;
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private readonly chunkOffsets: number[] = [];
  private readonly reservations: MemoryReservation[] = [];

  private totalBytes = 0;
  private committed = false;
  private aborted = false;
  private disposed = false;

  constructor(options?: {
    readonly memoryBudgetManager?: MemoryBudgetManager;
    readonly maxQuotaBytes?: number;
    readonly maxReadWindowBytes?: number;
  }) {
    this.budget = options?.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.maxQuotaBytes =
      typeof options?.maxQuotaBytes === 'number' &&
      Number.isFinite(options.maxQuotaBytes) &&
      options.maxQuotaBytes >= 0
        ? Math.trunc(options.maxQuotaBytes)
        : null;
    const rawMaxRead = options?.maxReadWindowBytes ?? DEFAULT_MAX_ARTIFACT_READ_BYTES;
    if (!Number.isSafeInteger(rawMaxRead) || rawMaxRead <= 0) {
      throw new RangeError(`Invalid maxReadWindowBytes: ${String(rawMaxRead)}.`);
    }
    this.maxReadWindowBytes = rawMaxRead;
  }

  public append(bytes: Uint8Array): void {
    if (this.aborted || this.disposed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot append to aborted or disposed export sink.');
    }
    if (this.committed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot append to finalized export sink.');
    }
    if (bytes.byteLength === 0) return;

    const nextTotal = this.totalBytes + bytes.byteLength;
    if (!Number.isSafeInteger(nextTotal)) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Export byte length overflowed safe integer range.');
    }
    if (this.maxQuotaBytes !== null && nextTotal > this.maxQuotaBytes) {
      throw new ExportWriteFailureError(
        'OUTPUT_QUOTA_EXCEEDED',
        `Write of ${bytes.byteLength} B exceeds export quota (${this.maxQuotaBytes} B).`,
      );
    }

    const reservation = this.budget.reserve({
      owner: `BoundedChunkedByteSink:chunk_${this.chunks.length}`,
      category: 'render-export-buffers',
      bytes: bytes.byteLength,
      priority: 'normal',
    });

    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      this.reservations.push(reservation);
      this.chunkOffsets.push(this.totalBytes);
      this.chunks.push(copy);
      this.totalBytes = nextTotal;
    } catch (err) {
      this.budget.release(reservation);
      throw err;
    }
  }

  public writeAt(offset: number, bytes: Uint8Array): void {
    if (this.aborted || this.disposed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot writeAt on aborted or disposed export sink.');
    }
    if (this.committed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot writeAt on finalized export sink.');
    }
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(offset + bytes.byteLength) ||
      offset + bytes.byteLength > this.totalBytes
    ) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `writeAt(${offset}, ${bytes.byteLength}) out of bounds for size ${this.totalBytes}.`,
      );
    }
    if (bytes.byteLength === 0) return;

    let remaining = bytes.byteLength;
    let srcPos = 0;
    let idx = this.findChunkIndex(offset);

    while (remaining > 0 && idx >= 0 && idx < this.chunks.length) {
      const chunk = this.chunks[idx];
      const localStart = offset + srcPos - this.chunkOffsets[idx];
      const writable = Math.min(remaining, chunk.byteLength - localStart);
      chunk.set(bytes.subarray(srcPos, srcPos + writable), localStart);
      srcPos += writable;
      remaining -= writable;
      idx++;
    }
  }

  public finalizeTempToCommitted(): void {
    if (this.aborted || this.disposed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot finalize an aborted or disposed sink.');
    }
    if (this.committed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Export sink is already finalized.');
    }
    this.committed = true;
  }

  public abortAndCleanup(): void {
    this.aborted = true;
    this.committed = false;
    this.disposed = true;
    this.clearChunksAndReleaseReservations();
  }

  public disposeCommitted(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.committed = false;
    this.clearChunksAndReleaseReservations();
  }

  public async readRange(offset: number, length: number): Promise<Uint8Array> {
    this.assertReadable();
    validateArtifactRangeRead(this.totalBytes, offset, length, this.maxReadWindowBytes);
    if (length === 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(length);
    let idx = this.findChunkIndex(offset);
    let remaining = length;
    let outPos = 0;
    let currentOffset = offset;

    while (remaining > 0 && idx >= 0 && idx < this.chunks.length) {
      const chunk = this.chunks[idx];
      const localStart = currentOffset - this.chunkOffsets[idx];
      const readable = Math.min(remaining, chunk.byteLength - localStart);
      out.set(chunk.subarray(localStart, localStart + readable), outPos);
      outPos += readable;
      currentOffset += readable;
      remaining -= readable;
      idx++;
    }

    if (remaining !== 0) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `BoundedChunkedByteSink range read underflow (${remaining} B unread).`,
      );
    }

    return out;
  }

  public openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array> {
    this.assertReadable();
    const { start, end, chunkSizeBytes } = validateArtifactStreamOptions(
      this.totalBytes,
      options,
      this.maxReadWindowBytes,
    );

    let cursor = start;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (cursor >= end) {
          controller.close();
          return;
        }
        try {
          const toRead = Math.min(chunkSizeBytes, end - cursor);
          const slice = await this.readRange(cursor, toRead);
          cursor += slice.byteLength;
          controller.enqueue(slice);
          if (cursor >= end) {
            controller.close();
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  public async createBlob(contentType = 'audio/wav'): Promise<Blob> {
    this.assertReadable();
    return new Blob(this.chunks as BlobPart[], { type: contentType });
  }

  public getTotalBytesWritten(): number {
    return this.totalBytes;
  }

  public getRetainedChunkCount(): number {
    return this.chunks.length;
  }

  public getActiveReservationCount(): number {
    return this.reservations.length;
  }

  public getActiveReservedBytes(): number {
    let total = 0;
    for (const r of this.reservations) {
      total += r.bytes;
    }
    return total;
  }

  public isCommitted(): boolean {
    return this.committed && !this.aborted && !this.disposed;
  }

  public isDisposed(): boolean {
    return this.disposed || this.aborted;
  }

  private assertReadable(): void {
    if (!this.committed || this.aborted || this.disposed) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        'Attempted to read uncommitted, aborted, or disposed render artifact.',
      );
    }
  }

  private findChunkIndex(offset: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const start = this.chunkOffsets[mid];
      const end = start + this.chunks[mid].byteLength;
      if (offset < start) {
        hi = mid - 1;
      } else if (offset >= end) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return -1;
  }

  private clearChunksAndReleaseReservations(): void {
    this.chunks.length = 0;
    this.chunkOffsets.length = 0;
    this.totalBytes = 0;

    const toRelease = this.reservations.splice(0, this.reservations.length);
    let firstError: unknown = null;
    for (const r of toRelease) {
      try {
        this.budget.release(r);
      } catch (err) {
        if (firstError === null) firstError = err;
      }
    }
    if (firstError !== null) {
      throw firstError;
    }
  }
}

/** Deterministic streaming dual-lane 64-bit FNV-1a hasher (pure JS, zero allocation per chunk) */
export class StreamingHexHasher {
  private h1 = 0x811c9dc5;
  private h2 = 0x9e3779b9;
  private byteCount = 0;

  public update(bytes: Uint8Array): void {
    let a = this.h1;
    let b = this.h2;
    for (let i = 0; i < bytes.byteLength; i++) {
      const v = bytes[i];
      a ^= v;
      a = Math.imul(a, 0x01000193) >>> 0;
      b ^= v ^ ((i + this.byteCount) & 0xff);
      b = Math.imul(b, 0x85ebca6b) >>> 0;
    }
    this.h1 = a;
    this.h2 = b;
    this.byteCount += bytes.byteLength;
  }

  public snapshotState(): string {
    return `${(this.h1 >>> 0).toString(16).padStart(8, '0')}:${(this.h2 >>> 0).toString(16).padStart(8, '0')}:${this.byteCount}`;
  }

  public restoreState(state: string): void {
    const parts = state.split(':');
    if (parts.length !== 3) {
      throw new Error(`Invalid StreamingHexHasher state: ${state}`);
    }
    this.h1 = parseInt(parts[0], 16) >>> 0;
    this.h2 = parseInt(parts[1], 16) >>> 0;
    this.byteCount = Number(parts[2]) || 0;
  }

  public digestHex(): string {
    const a = (this.h1 >>> 0).toString(16).padStart(8, '0');
    const b = (this.h2 >>> 0).toString(16).padStart(8, '0');
    const lenHex = (this.byteCount >>> 0).toString(16).padStart(8, '0');
    return `avphash64:${a}${b}${lenHex}`;
  }
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function writeUint64Le(view: DataView, offset: number, value: number): void {
  const big = BigInt(Math.max(0, Math.trunc(value)));
  const lo = Number(big & 0xffffffffn);
  const hi = Number((big >> 32n) & 0xffffffffn);
  view.setUint32(offset, lo, true);
  view.setUint32(offset + 4, hi, true);
}

/**
 * Builds a classic 44-byte RIFF/WAVE header or an 80-byte RF64/WAVE header (with ds64 chunk).
 */
export function buildWaveContainerHeader(params: {
  readonly container: RenderExportContainer;
  readonly encoding: RenderExportEncoding;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly totalOutputSamples: number;
  readonly dataBytes: number;
}): Uint8Array {
  const { container, encoding, sampleRate, channelCount, totalOutputSamples, dataBytes } = params;
  const bitsPerSample = bitsPerSampleForEncoding(encoding);
  const bytesPerSample = bytesPerSampleForEncoding(encoding);
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const audioFormat = encoding === 'float32' ? 3 : 1; // 1 = PCM, 3 = IEEE float

  if (container === 'wav') {
    if (dataBytes > RIFF_WAV_MAX_DATA_BYTES) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `OUTPUT_SIZE_EXCEEDS_RIFF_LIMIT: dataBytes (${dataBytes}) exceeds 32-bit RIFF WAV ceiling.`,
      );
    }
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM/IEEE fmt chunk size
    view.setUint16(20, audioFormat, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
    return header;
  }

  // RF64 container (EBU Tech 3306): 12 (RF64) + 36 (ds64) + 24 (fmt ) + 8 (data) = 80 bytes
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);
  const riffSize64 = 72 + dataBytes;

  writeAscii(view, 0, 'RF64');
  view.setUint32(4, 0xffffffff, true); // Sentinel indicating 64-bit size in ds64
  writeAscii(view, 8, 'WAVE');

  // ds64 chunk (28-byte payload)
  writeAscii(view, 12, 'ds64');
  view.setUint32(16, 28, true);
  writeUint64Le(view, 20, riffSize64);
  writeUint64Le(view, 28, dataBytes);
  writeUint64Le(view, 36, totalOutputSamples);
  view.setUint32(44, 0, true); // tableLength

  // fmt chunk
  writeAscii(view, 48, 'fmt ');
  view.setUint32(52, 16, true);
  view.setUint16(56, audioFormat, true);
  view.setUint16(58, channelCount, true);
  view.setUint32(60, sampleRate, true);
  view.setUint32(64, byteRate, true);
  view.setUint16(68, blockAlign, true);
  view.setUint16(70, bitsPerSample, true);

  // data chunk
  writeAscii(view, 72, 'data');
  view.setUint32(76, dataBytes > 0xffffffff ? 0xffffffff : dataBytes, true);
  return header;
}

/**
 * Streaming Audio Export Writer (AVP-P06-001)
 *
 * Encodes multi-channel planar Float32 audio chunks incrementally into WAV PCM16,
 * WAV PCM24, WAV IEEE Float32, or RF64 containers, tracks exact peak/clipping/NaN
 * telemetry and deterministic output hash on the fly, and finalizes header atomically.
 */
export class AudioExportWriter {
  public readonly renderId: string;
  public readonly artifactId: string;
  public readonly container: RenderExportContainer;
  public readonly encoding: RenderExportEncoding;
  public readonly sampleRate: SampleRate;
  public readonly channelCount: number;
  public readonly sink: StreamingByteSink;

  private readonly bytesPerSample: 2 | 3 | 4;
  private readonly bitsPerSample: 16 | 24 | 32;
  private readonly headerSizeBytes: number;
  private readonly dataHasher = new StreamingHexHasher();

  private headerWritten = false;
  private finalized = false;
  private aborted = false;
  private writtenSamples = 0;
  private writtenDataBytes = 0;
  private peakAmplitude = 0;
  private clippedSampleCount = 0;
  private nonFiniteSampleCount = 0;

  constructor(params: {
    readonly renderId: string;
    readonly artifactId: string;
    readonly container: RenderExportContainer;
    readonly encoding: RenderExportEncoding;
    readonly sampleRate: SampleRate;
    readonly channelCount: number;
    readonly sink: StreamingByteSink;
  }) {
    this.renderId = params.renderId;
    this.artifactId = params.artifactId;
    this.container = params.container;
    this.encoding = params.encoding;
    this.sampleRate = params.sampleRate;
    this.channelCount = params.channelCount;
    this.sink = params.sink;
    this.bytesPerSample = bytesPerSampleForEncoding(params.encoding);
    this.bitsPerSample = bitsPerSampleForEncoding(params.encoding);
    this.headerSizeBytes = params.container === 'rf64' ? 80 : 44;
  }

  public async begin(): Promise<void> {
    if (this.headerWritten) return;
    const placeholderHeader = buildWaveContainerHeader({
      container: this.container,
      encoding: this.encoding,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      totalOutputSamples: 0,
      dataBytes: 0,
    });
    await this.sink.append(placeholderHeader);
    this.headerWritten = true;
  }

  /**
   * Restores writer progress & streaming hash state when resuming onto an existing
   * persistent sink that already contains the placeholder header + previously written data bytes.
   */
  public resumeFromCheckpointState(params: {
    readonly writtenSamples: number;
    readonly writtenDataBytes: number;
    readonly partialHashState: string;
  }): void {
    const expectedSinkBytes = this.headerSizeBytes + params.writtenDataBytes;
    const actualSinkBytes = this.sink.getTotalBytesWritten();
    if (actualSinkBytes !== expectedSinkBytes) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `CHECKPOINT_SINK_MISMATCH: Sink holds ${actualSinkBytes} B, expected ${expectedSinkBytes} B (header ${this.headerSizeBytes} + data ${params.writtenDataBytes}).`,
      );
    }
    this.dataHasher.restoreState(params.partialHashState);
    this.writtenSamples = params.writtenSamples;
    this.writtenDataBytes = params.writtenDataBytes;
    this.headerWritten = true;
  }

  public async writePlanarChunk(
    planarChannels: readonly Float32Array[],
    sampleCount: number,
  ): Promise<void> {
    if (this.aborted) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Writer was aborted.');
    }
    if (this.finalized) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Writer is already finalized.');
    }
    if (!this.headerWritten) {
      await this.begin();
    }
    if (planarChannels.length !== this.channelCount) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `CHANNEL_MISMATCH: Writer expected ${this.channelCount} channels, got ${planarChannels.length}.`,
      );
    }
    if (!Number.isFinite(sampleCount) || sampleCount <= 0) return;
    const safeSampleCount = Math.floor(sampleCount);
    if (safeSampleCount <= 0) return;

    const chunkBytes = safeSampleCount * this.channelCount * this.bytesPerSample;
    if (
      this.container === 'wav' &&
      this.writtenDataBytes + chunkBytes > RIFF_WAV_MAX_DATA_BYTES
    ) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `OUTPUT_SIZE_EXCEEDS_RIFF_LIMIT: Streaming data exceeded 32-bit RIFF WAV limit.`,
      );
    }

    const encoded = new Uint8Array(chunkBytes);
    const view = new DataView(encoded.buffer);
    let byteOffset = 0;

    for (let i = 0; i < safeSampleCount; i++) {
      for (let c = 0; c < this.channelCount; c++) {
        const ch = planarChannels[c];
        const raw = i < ch.length ? ch[i] : 0;
        if (!Number.isFinite(raw)) {
          this.nonFiniteSampleCount++;
          // Write zero for PCM integer safety; preserve NaN only if float32 so validator catches it
          if (this.encoding === 'float32') {
            view.setFloat32(byteOffset, raw, true);
          } else if (this.encoding === 'pcm16') {
            view.setInt16(byteOffset, 0, true);
          } else {
            encoded[byteOffset] = 0;
            encoded[byteOffset + 1] = 0;
            encoded[byteOffset + 2] = 0;
          }
          byteOffset += this.bytesPerSample;
          continue;
        }

        const absVal = Math.abs(raw);
        if (absVal > this.peakAmplitude) {
          this.peakAmplitude = absVal;
        }
        if (absVal > 1.0) {
          this.clippedSampleCount++;
        }

        const clamped = Math.max(-1, Math.min(1, raw));

        if (this.encoding === 'pcm16') {
          const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
          view.setInt16(byteOffset, Math.max(-32768, Math.min(32767, int16)), true);
        } else if (this.encoding === 'pcm24') {
          const int24 =
            clamped < 0 ? Math.round(clamped * 8388608) : Math.round(clamped * 8388607);
          const bounded = Math.max(-8388608, Math.min(8388607, int24));
          const unsigned = bounded < 0 ? bounded + 0x1000000 : bounded;
          encoded[byteOffset] = unsigned & 0xff;
          encoded[byteOffset + 1] = (unsigned >> 8) & 0xff;
          encoded[byteOffset + 2] = (unsigned >> 16) & 0xff;
        } else {
          view.setFloat32(byteOffset, raw, true);
        }

        byteOffset += this.bytesPerSample;
      }
    }

    await this.sink.append(encoded);
    this.dataHasher.update(encoded);
    this.writtenSamples += safeSampleCount;
    this.writtenDataBytes += chunkBytes;
  }

  public getPartialHashState(): string {
    return this.dataHasher.snapshotState();
  }

  public getWrittenSamples(): number {
    return this.writtenSamples;
  }

  public getWrittenDataBytes(): number {
    return this.writtenDataBytes;
  }

  public async finalize(nowMs = Date.now()): Promise<RenderOutputMetadata> {
    if (this.aborted) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot finalize aborted export writer.');
    }
    if (!this.headerWritten) {
      await this.begin();
    }

    const finalHeader = buildWaveContainerHeader({
      container: this.container,
      encoding: this.encoding,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      totalOutputSamples: this.writtenSamples,
      dataBytes: this.writtenDataBytes,
    });

    await this.sink.writeAt(0, finalHeader);
    await this.sink.finalizeTempToCommitted();
    this.finalized = true;

    const finalHasher = new StreamingHexHasher();
    finalHasher.update(finalHeader);
    // Combine finalized header digest with streaming payload digest deterministically
    const headerDigest = finalHasher.digestHex();
    const payloadDigest = this.dataHasher.digestHex();
    const combinedHasher = new StreamingHexHasher();
    combinedHasher.update(new TextEncoder().encode(`${headerDigest}|${payloadDigest}`));
    const outputHash = combinedHasher.digestHex();

    const truePeakDbfs =
      this.peakAmplitude <= 1e-6
        ? -96
        : Number((20 * Math.log10(this.peakAmplitude)).toFixed(2));

    return {
      renderId: this.renderId,
      artifactId: this.artifactId,
      container: this.container,
      encoding: this.encoding,
      bitsPerSample: this.bitsPerSample,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      totalOutputSamples: this.writtenSamples,
      durationSec: Number((this.writtenSamples / this.sampleRate).toFixed(6)),
      fileSizeBytes: this.headerSizeBytes + this.writtenDataBytes,
      outputHash,
      peakAmplitude: Number(this.peakAmplitude.toFixed(6)),
      truePeakDbfs,
      clippedSampleCount: this.clippedSampleCount,
      nonFiniteSampleCount: this.nonFiniteSampleCount,
      persistedExternally: this.sink.persistedExternally,
      finalizedAtMs: nowMs,
    };
  }

  public async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    await this.sink.abortAndCleanup();
  }
}
