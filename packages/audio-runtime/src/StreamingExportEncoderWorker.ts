/**
 * @paudio/audio-runtime — StreamingExportEncoderWorker.ts
 *
 * Chunked, memory-bounded streaming audio exporter supporting:
 * - WAV (16-bit PCM, 24-bit PCM, 32-bit IEEE Float) with trailing RIFF 'id3 ' chunk
 * - FLAC (RFC 9639 lossless stream: fLaC + STREAMINFO + VORBIS_COMMENT + CRC-8/16 frames)
 * - MP3 (ID3v2.4 + CTOC/CHAP header + injectable Mp3FrameEncoderAdapter bitstream pipeline)
 *
 * Zero-monolithic-RAM sink architecture:
 * - OPFS sink: streams directly via Worker FileSystemSyncAccessHandle (or FileSystemWritableFileStream)
 *   and applies O(1) seek/write header patches on finalize without copying the file.
 * - Blob sink: stores bounded encoded chunks as independent BlobParts, patches header slices in-place,
 *   and produces a linked Blob / ObjectURL without concatenating into one contiguous ArrayBuffer.
 */

export type ExportAudioFormat = 'WAV' | 'FLAC' | 'MP3';
export type ExportSampleRate = 16000 | 22050 | 24000 | 32000 | 44100 | 48000 | 96000;
export type WavBitDepth = 16 | 24 | 32;
export type FlacBitDepth = 16 | 24;
export type ExportSinkMode = 'OPFS' | 'BLOB' | 'CUSTOM_SINK';

export interface PodcastChapterInput {
  readonly id: string;
  readonly titleFa: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startFlicks?: number;
  readonly endFlicks?: number;
  readonly speakerName?: string;
}

export interface PodcastMetadata {
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly year?: string;
  readonly genre?: string;
  readonly comment?: string;
  readonly chapters: readonly PodcastChapterInput[];
}

export interface Mp3FrameEncoderAdapter {
  init(config: { sampleRate: ExportSampleRate; channels: number; bitrateKbps: number }): void | Promise<void>;
  encodeChunk(channels: Float32Array[]): Uint8Array | Promise<Uint8Array>;
  flush(): Uint8Array | Promise<Uint8Array>;
}

export interface BinaryPatch {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface ChunkedRandomAccessSink {
  readonly kind: 'OPFS' | 'BLOB' | 'CUSTOM';
  open(): Promise<void>;
  append(bytes: Uint8Array): Promise<void>;
  patchAt(offset: number, bytes: Uint8Array): Promise<void>;
  finalize(mimeType: string, createObjectUrl: boolean): Promise<{
    blob?: Blob;
    blobUrl?: string;
    opfsFileName?: string;
    totalBytesWritten: number;
  }>;
  abort(): Promise<void>;
}

export interface StreamingExportOptions {
  readonly format: ExportAudioFormat;
  readonly sampleRate: ExportSampleRate;
  readonly channels: number;
  readonly wavBitDepth?: WavBitDepth;
  readonly flacBitDepth?: FlacBitDepth;
  readonly flacBlockSize?: number;
  readonly mp3BitrateKbps?: number;
  readonly mp3EncoderAdapter?: Mp3FrameEncoderAdapter;
  readonly sinkMode?: ExportSinkMode;
  readonly opfsFileName?: string;
  readonly createObjectUrl?: boolean;
  readonly customSink?: ChunkedRandomAccessSink;
}

export interface StreamingExportReport {
  readonly format: ExportAudioFormat;
  readonly sinkKind: 'OPFS' | 'BLOB' | 'CUSTOM';
  readonly totalBytesWritten: number;
  readonly totalFramesWritten: number;
  readonly durationSeconds: number;
  readonly peakSingleWriteBytes: number;
  readonly embeddedChapterCount: number;
  readonly id3TagSizeBytes: number;
  readonly opfsFileName?: string;
  readonly blob?: Blob;
  readonly blobUrl?: string;
}

export class StreamingExportCodecError extends Error {
  public readonly code = 'ERR_EXPORT_CODEC_UNAVAILABLE';
  public readonly category = 'EXPORT_ERROR';
  public readonly userMessageFa =
    'کدک فشرده‌ساز MP3 متصل نشده است؛ آداپتور کدک MP3 را تزریق کنید یا از خروجی WAV/FLAC استفاده نمایید.';

  constructor(detail: string) {
    super(detail);
    this.name = 'StreamingExportCodecError';
  }
}

const FLICKS_PER_SECOND = 705_600_000;
const utf8Encoder = new TextEncoder();

function getMimeTypeForFormat(format: ExportAudioFormat): string {
  switch (format) {
    case 'WAV':
      return 'audio/wav';
    case 'FLAC':
      return 'audio/flac';
    case 'MP3':
      return 'audio/mpeg';
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function encodeSynchsafe32(value: number): Uint8Array {
  const v = Math.max(0, Math.floor(value)) >>> 0;
  return new Uint8Array([
    (v >>> 21) & 0x7f,
    (v >>> 14) & 0x7f,
    (v >>> 7) & 0x7f,
    v & 0x7f,
  ]);
}

export function decodeSynchsafe32(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function uint32BE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}

function uint32LE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

function normalizeChapters(chapters: readonly PodcastChapterInput[]): PodcastChapterInput[] {
  return chapters
    .map((ch) => {
      const startMs =
        typeof ch.startFlicks === 'number'
          ? Math.round((ch.startFlicks / FLICKS_PER_SECOND) * 1000)
          : Math.max(0, Math.round(ch.startMs));
      const rawEndMs =
        typeof ch.endFlicks === 'number'
          ? Math.round((ch.endFlicks / FLICKS_PER_SECOND) * 1000)
          : Math.max(startMs, Math.round(ch.endMs));
      return {
        ...ch,
        startMs,
        endMs: Math.max(startMs, rawEndMs),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

// ============================================================================
// ID3v2.4 + Podcast CTOC/CHAP Builder (UTF-8 Persian Support)
// ============================================================================
function buildId3v24Frame(frameId: string, payload: Uint8Array): Uint8Array {
  if (frameId.length !== 4) throw new Error(`Invalid ID3v2 frame ID: ${frameId}`);
  const header = new Uint8Array(10);
  for (let i = 0; i < 4; i++) header[i] = frameId.charCodeAt(i) & 0x7f;
  header.set(encodeSynchsafe32(payload.byteLength), 4);
  return concatBytes([header, payload]);
}

function buildId3TextFrame(frameId: string, text: string): Uint8Array {
  const encoded = utf8Encoder.encode(text);
  const payload = new Uint8Array(1 + encoded.byteLength);
  payload[0] = 0x03; // UTF-8
  payload.set(encoded, 1);
  return buildId3v24Frame(frameId, payload);
}

function buildId3CommentFrame(text: string, lang = 'fas'): Uint8Array {
  const encoded = utf8Encoder.encode(text);
  const langBytes = utf8Encoder.encode(lang.slice(0, 3).padEnd(3, ' '));
  const payload = new Uint8Array(5 + encoded.byteLength);
  payload[0] = 0x03;
  payload.set(langBytes.subarray(0, 3), 1);
  payload[4] = 0x00;
  payload.set(encoded, 5);
  return buildId3v24Frame('COMM', payload);
}

export function buildPodcastId3v2Tag(metadata: PodcastMetadata): {
  tagBytes: Uint8Array;
  normalizedChapters: PodcastChapterInput[];
} {
  const frames: Uint8Array[] = [];
  const chapters = normalizeChapters(metadata.chapters);

  if (metadata.title) frames.push(buildId3TextFrame('TIT2', metadata.title));
  if (metadata.artist) frames.push(buildId3TextFrame('TPE1', metadata.artist));
  if (metadata.album) frames.push(buildId3TextFrame('TALB', metadata.album));
  if (metadata.year) frames.push(buildId3TextFrame('TDRC', metadata.year));
  if (metadata.genre) frames.push(buildId3TextFrame('TCON', metadata.genre));
  if (metadata.comment) frames.push(buildId3CommentFrame(metadata.comment));

  const bounded = chapters.slice(0, 255);
  if (bounded.length > 0) {
    const childIds = bounded.map((_, idx) => utf8Encoder.encode(`ch${idx}\0`));
    const tocTitle = buildId3TextFrame('TIT2', 'فهرست مباحث');
    const ctocPayload = concatBytes([
      utf8Encoder.encode('toc\0'),
      new Uint8Array([0x03, bounded.length & 0xff]),
      ...childIds,
      tocTitle,
    ]);
    frames.push(buildId3v24Frame('CTOC', ctocPayload));

    for (let i = 0; i < bounded.length; i++) {
      const ch = bounded[i];
      const title = ch.speakerName ? `${ch.titleFa} — ${ch.speakerName}` : ch.titleFa;
      const chapPayload = concatBytes([
        utf8Encoder.encode(`ch${i}\0`),
        uint32BE(ch.startMs),
        uint32BE(ch.endMs),
        new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        buildId3TextFrame('TIT2', title),
      ]);
      frames.push(buildId3v24Frame('CHAP', chapPayload));
    }
  }

  const body = concatBytes(frames);
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = 0x04;
  header[4] = 0x00;
  header[5] = 0x00;
  header.set(encodeSynchsafe32(body.byteLength), 6);

  return {
    tagBytes: concatBytes([header, body]),
    normalizedChapters: bounded,
  };
}

// ============================================================================
// FLAC CRC-8 / CRC-16 + Vorbis Comment Builders (RFC 9639)
// ============================================================================
const FLAC_CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    table[i] = crc;
  }
  return table;
})();

const FLAC_CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    table[i] = crc;
  }
  return table;
})();

export function computeFlacCrc8(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.byteLength; i++) crc = FLAC_CRC8_TABLE[crc ^ data[i]];
  return crc;
}

export function computeFlacCrc16(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.byteLength; i++) {
    crc = ((crc << 8) ^ FLAC_CRC16_TABLE[((crc >>> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

function encodeFlacUtf8Number(value: number): Uint8Array {
  if (value < 0x80) return new Uint8Array([value]);
  const bytes: number[] = [];
  let len = 2;
  let maxVal = 0x7ff;
  while (value > maxVal && len < 7) {
    len++;
    maxVal = len === 7 ? Number.MAX_SAFE_INTEGER : (1 << (7 - len + 6 * (len - 1))) - 1;
  }
  let v = value;
  for (let i = len - 1; i > 0; i--) {
    bytes[i] = 0x80 | (v & 0x3f);
    v = Math.floor(v / 64);
  }
  bytes[0] = ((0xff << (8 - len)) & 0xff) | v;
  return new Uint8Array(bytes);
}

function getFlacSampleRateCode(sampleRate: ExportSampleRate): number {
  switch (sampleRate) {
    case 16000:
      return 0x5;
    case 22050:
      return 0x6;
    case 24000:
      return 0x7;
    case 32000:
      return 0x8;
    case 44100:
      return 0x9;
    case 48000:
      return 0xa;
    case 96000:
      return 0xb;
  }
}

function formatChapterTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const rem = clamped % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rem).padStart(3, '0')}`;
}

function buildFlacVorbisCommentBlock(metadata: PodcastMetadata): {
  blockBytes: Uint8Array;
  chapterCount: number;
} {
  const tags: string[] = [];
  if (metadata.title) tags.push(`TITLE=${metadata.title}`);
  if (metadata.artist) tags.push(`ARTIST=${metadata.artist}`);
  if (metadata.album) tags.push(`ALBUM=${metadata.album}`);
  if (metadata.year) tags.push(`DATE=${metadata.year}`);
  if (metadata.genre) tags.push(`GENRE=${metadata.genre}`);
  if (metadata.comment) tags.push(`DESCRIPTION=${metadata.comment}`);

  const chapters = normalizeChapters(metadata.chapters);
  for (let i = 0; i < chapters.length; i++) {
    const num = String(i + 1).padStart(3, '0');
    const ch = chapters[i];
    const name = ch.speakerName ? `${ch.titleFa} — ${ch.speakerName}` : ch.titleFa;
    tags.push(`CHAPTER${num}=${formatChapterTimestamp(ch.startMs)}`);
    tags.push(`CHAPTER${num}NAME=${name}`);
  }

  const vendor = utf8Encoder.encode('Avapardaz AudioRuntime Streaming FLAC v1.2');
  const encodedTags = tags.map((t) => utf8Encoder.encode(t));
  let payloadLen = 4 + vendor.byteLength + 4;
  for (const t of encodedTags) payloadLen += 4 + t.byteLength;

  const block = new Uint8Array(4 + payloadLen);
  const view = new DataView(block.buffer);
  block[0] = 0x84; // last-metadata-block flag (0x80) | type 4 (VORBIS_COMMENT)
  block[1] = (payloadLen >>> 16) & 0xff;
  block[2] = (payloadLen >>> 8) & 0xff;
  block[3] = payloadLen & 0xff;

  let cursor = 4;
  view.setUint32(cursor, vendor.byteLength, true);
  cursor += 4;
  block.set(vendor, cursor);
  cursor += vendor.byteLength;

  view.setUint32(cursor, encodedTags.length, true);
  cursor += 4;
  for (const t of encodedTags) {
    view.setUint32(cursor, t.byteLength, true);
    cursor += 4;
    block.set(t, cursor);
    cursor += t.byteLength;
  }

  return { blockBytes: block, chapterCount: chapters.length };
}

function quantizeSample(sample: number, bitDepth: 16 | 24): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  return bitDepth === 16
    ? Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)))
    : Math.max(-8388608, Math.min(8388607, Math.round(clamped * 8388607)));
}

// ============================================================================
// Chunked Sinks: OPFS Disk-Streaming Sink & BlobPart-Linked Sink
// ============================================================================
interface OpfsSyncAccessHandleLike {
  truncate(newSize: number): void;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

interface OpfsWritableStreamLike {
  write(data: Uint8Array | { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
}

interface OpfsFileHandleLike {
  createSyncAccessHandle?: () => Promise<OpfsSyncAccessHandleLike>;
  createWritable?: () => Promise<OpfsWritableStreamLike>;
  getFile: () => Promise<File>;
}

interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

/**
 * Streams encoded binary chunks directly to Origin Private File System (OPFS)
 * using Worker SyncAccessHandle (or FileSystemWritableFileStream fallback),
 * ensuring peak JS heap remains O(chunkSize) regardless of final podcast duration.
 */
export class OpfsChunkedExportSink implements ChunkedRandomAccessSink {
  public readonly kind = 'OPFS' as const;
  private readonly fileName: string;
  private readonly dirProvider: () => Promise<OpfsDirectoryLike>;
  private dir: OpfsDirectoryLike | null = null;
  private fileHandle: OpfsFileHandleLike | null = null;
  private syncHandle: OpfsSyncAccessHandleLike | null = null;
  private writableStream: OpfsWritableStreamLike | null = null;
  private cursor = 0;

  constructor(
    fileName: string,
    dirProvider?: () => Promise<OpfsDirectoryLike>,
  ) {
    this.fileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    this.dirProvider =
      dirProvider ??
      (async () => {
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
          throw new Error('OPFS navigator.storage.getDirectory() is unavailable in this environment.');
        }
        return (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryLike;
      });
  }

  public async open(): Promise<void> {
    this.dir = await this.dirProvider();
    this.fileHandle = await this.dir.getFileHandle(this.fileName, { create: true });

    if (typeof this.fileHandle.createSyncAccessHandle === 'function') {
      this.syncHandle = await this.fileHandle.createSyncAccessHandle();
      this.syncHandle.truncate(0);
    } else if (typeof this.fileHandle.createWritable === 'function') {
      this.writableStream = await this.fileHandle.createWritable();
    } else {
      throw new Error('OPFS file handle exposes neither createSyncAccessHandle nor createWritable.');
    }
    this.cursor = 0;
  }

  public async append(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    if (this.syncHandle) {
      let written = 0;
      while (written < bytes.byteLength) {
        written += this.syncHandle.write(bytes.subarray(written), { at: this.cursor + written });
      }
      this.cursor += bytes.byteLength;
      return;
    }
    if (this.writableStream) {
      await this.writableStream.write({ type: 'write', position: this.cursor, data: bytes });
      this.cursor += bytes.byteLength;
      return;
    }
    throw new Error('OpfsChunkedExportSink is not open.');
  }

  public async patchAt(offset: number, bytes: Uint8Array): Promise<void> {
    if (this.syncHandle) {
      this.syncHandle.write(bytes, { at: offset });
      return;
    }
    if (this.writableStream) {
      await this.writableStream.write({ type: 'write', position: offset, data: bytes });
      return;
    }
    throw new Error('OpfsChunkedExportSink is not open.');
  }

  public async finalize(
    _mimeType: string,
    createObjectUrl: boolean,
  ): Promise<{ blob?: Blob; blobUrl?: string; opfsFileName?: string; totalBytesWritten: number }> {
    if (this.syncHandle) {
      this.syncHandle.flush();
      this.syncHandle.close();
      this.syncHandle = null;
    } else if (this.writableStream) {
      await this.writableStream.close();
      this.writableStream = null;
    }

    const file = this.fileHandle ? await this.fileHandle.getFile() : undefined;
    const blobUrl =
      createObjectUrl && file && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : undefined;

    return {
      blob: file,
      blobUrl,
      opfsFileName: this.fileName,
      totalBytesWritten: this.cursor,
    };
  }

  public async abort(): Promise<void> {
    try {
      if (this.syncHandle) {
        this.syncHandle.close();
        this.syncHandle = null;
      }
      if (this.writableStream) {
        await this.writableStream.close().catch(() => {});
        this.writableStream = null;
      }
      if (this.dir) {
        await this.dir.removeEntry(this.fileName).catch(() => {});
      }
    } finally {
      this.fileHandle = null;
    }
  }
}

/**
 * Chunk-linked Blob sink: holds discrete small Uint8Array chunks as BlobParts
 * without allocating a single monolithic ArrayBuffer, patches headers across chunk boundaries
 * in-place, and links directly to a Blob / ObjectURL.
 */
export class BlobLinkedChunkedExportSink implements ChunkedRandomAccessSink {
  public readonly kind = 'BLOB' as const;
  private chunks: Uint8Array[] = [];
  private chunkOffsets: number[] = [];
  private totalBytes = 0;

  public async open(): Promise<void> {
    this.chunks = [];
    this.chunkOffsets = [];
    this.totalBytes = 0;
  }

  public async append(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    this.chunkOffsets.push(this.totalBytes);
    this.chunks.push(bytes);
    this.totalBytes += bytes.byteLength;
  }

  public async patchAt(offset: number, bytes: Uint8Array): Promise<void> {
    let remaining = bytes.byteLength;
    let srcOffset = 0;
    let targetOffset = offset;

    for (let i = 0; i < this.chunks.length && remaining > 0; i++) {
      const start = this.chunkOffsets[i];
      const chunk = this.chunks[i];
      const end = start + chunk.byteLength;
      if (targetOffset >= start && targetOffset < end) {
        const localStart = targetOffset - start;
        const copyLen = Math.min(remaining, chunk.byteLength - localStart);
        chunk.set(bytes.subarray(srcOffset, srcOffset + copyLen), localStart);
        srcOffset += copyLen;
        targetOffset += copyLen;
        remaining -= copyLen;
      }
    }

    if (remaining > 0) {
      throw new Error(`patchAt(${offset}, ${bytes.byteLength}) exceeded sink length ${this.totalBytes}.`);
    }
  }

  public async finalize(
    mimeType: string,
    createObjectUrl: boolean,
  ): Promise<{ blob: Blob; blobUrl?: string; totalBytesWritten: number }> {
    // Convert Uint8Array views cleanly into standard ArrayBuffer slices for Blob constructor typing
    const blobParts: BlobPart[] = this.chunks.map((c) => {
      if (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength && c.buffer instanceof ArrayBuffer) {
        return c.buffer;
      }
      return c.slice().buffer;
    });
    const blob = new Blob(blobParts, { type: mimeType });
    const blobUrl =
      createObjectUrl && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(blob)
        : undefined;
    return {
      blob,
      blobUrl,
      totalBytesWritten: this.totalBytes,
    };
  }

  public async abort(): Promise<void> {
    this.chunks = [];
    this.chunkOffsets = [];
    this.totalBytes = 0;
  }
}

// ============================================================================
// Core Streaming Encoder Coordinator (Connects Codec Stream -> Chunked Sink)
// ============================================================================
export class StreamingExportSession {
  private readonly options: StreamingExportOptions;
  private readonly metadata: PodcastMetadata;
  private readonly sink: ChunkedRandomAccessSink;
  private readonly flacBlockSize: number;

  private started = false;
  private finalized = false;
  private totalFramesWritten = 0;
  private dataBytesWritten = 0;
  private peakSingleWriteBytes = 0;

  // FLAC state
  private flacFrameIndex = 0;
  private flacResidual: Float32Array[] = [];
  private flacChapterCount = 0;

  // ID3 state
  private id3TagSizeBytes = 0;
  private id3ChapterCount = 0;

  constructor(options: StreamingExportOptions, metadata: PodcastMetadata) {
    if (options.channels < 1 || options.channels > 8) {
      throw new Error(`Unsupported channel count: ${options.channels}`);
    }
    this.options = options;
    this.metadata = metadata;
    this.flacBlockSize = options.flacBlockSize ?? 4096;
    this.sink = this.resolveSink(options);
  }

  private resolveSink(options: StreamingExportOptions): ChunkedRandomAccessSink {
    if (options.customSink) return options.customSink;
    const mode = options.sinkMode ?? 'BLOB';
    if (mode === 'OPFS') {
      const ext = options.format.toLowerCase();
      const defaultName = `avapardaz-export-${Date.now()}.${ext}`;
      return new OpfsChunkedExportSink(options.opfsFileName ?? defaultName);
    }
    return new BlobLinkedChunkedExportSink();
  }

  private async writeChunkToSink(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > this.peakSingleWriteBytes) {
      this.peakSingleWriteBytes = bytes.byteLength;
    }
    await this.sink.append(bytes);
  }

  public async start(): Promise<void> {
    if (this.started) throw new Error('StreamingExportSession already started.');
    this.started = true;

    if (this.options.format === 'MP3' && !this.options.mp3EncoderAdapter) {
      throw new StreamingExportCodecError(
        'MP3 streaming export requested without an Mp3FrameEncoderAdapter.',
      );
    }

    await this.sink.open();

    if (this.options.format === 'WAV') {
      await this.writeChunkToSink(this.buildWavHeaderPlaceholder());
      return;
    }

    if (this.options.format === 'FLAC') {
      const { magic, streamInfoBlock, vorbisBlock, chapterCount } = this.buildFlacInitBlocks();
      this.flacChapterCount = chapterCount;
      this.flacResidual = Array.from({ length: this.options.channels }, () => new Float32Array(0));
      await this.writeChunkToSink(magic);
      await this.writeChunkToSink(streamInfoBlock);
      await this.writeChunkToSink(vorbisBlock);
      return;
    }

    // MP3
    await this.options.mp3EncoderAdapter!.init({
      sampleRate: this.options.sampleRate,
      channels: this.options.channels,
      bitrateKbps: this.options.mp3BitrateKbps ?? 192,
    });
    const { tagBytes, normalizedChapters } = buildPodcastId3v2Tag(this.metadata);
    this.id3TagSizeBytes = tagBytes.byteLength;
    this.id3ChapterCount = normalizedChapters.length;
    await this.writeChunkToSink(tagBytes);
  }

  public async pushPcmChunk(channels: Float32Array[]): Promise<{ framesWritten: number }> {
    if (!this.started || this.finalized) {
      throw new Error('Cannot push PCM chunk outside an active streaming session.');
    }
    if (channels.length !== this.options.channels) {
      throw new Error(`Expected ${this.options.channels} channels, received ${channels.length}.`);
    }
    const frameCount = channels[0]?.length ?? 0;
    if (frameCount === 0) return { framesWritten: this.totalFramesWritten };
    for (let c = 1; c < channels.length; c++) {
      if (channels[c].length !== frameCount) {
        throw new Error('Channel buffers inside PCM chunk must have equal length.');
      }
    }

    this.totalFramesWritten += frameCount;

    if (this.options.format === 'WAV') {
      const pcmBytes = this.encodeWavChunk(channels, frameCount);
      this.dataBytesWritten += pcmBytes.byteLength;
      await this.writeChunkToSink(pcmBytes);
      return { framesWritten: this.totalFramesWritten };
    }

    if (this.options.format === 'FLAC') {
      await this.streamFlacPcm(channels, frameCount, false);
      return { framesWritten: this.totalFramesWritten };
    }

    // MP3
    const encoded = await this.options.mp3EncoderAdapter!.encodeChunk(channels);
    await this.writeChunkToSink(encoded);
    return { framesWritten: this.totalFramesWritten };
  }

  public async finalize(): Promise<StreamingExportReport> {
    if (!this.started || this.finalized) {
      throw new Error('StreamingExportSession cannot be finalized.');
    }
    this.finalized = true;

    let embeddedChapterCount = 0;

    if (this.options.format === 'WAV') {
      const { tagBytes, normalizedChapters } = buildPodcastId3v2Tag(this.metadata);
      this.id3TagSizeBytes = tagBytes.byteLength;
      this.id3ChapterCount = normalizedChapters.length;
      embeddedChapterCount = this.id3ChapterCount;

      let id3RiffChunkLen = 0;
      if (tagBytes.byteLength > 0) {
        const padByte = tagBytes.byteLength % 2 === 1 ? 1 : 0;
        const header = new Uint8Array(8);
        header[0] = 0x69; // 'i'
        header[1] = 0x64; // 'd'
        header[2] = 0x33; // '3'
        header[3] = 0x20; // ' '
        header.set(uint32LE(tagBytes.byteLength), 4);
        await this.writeChunkToSink(header);
        await this.writeChunkToSink(tagBytes);
        if (padByte) await this.writeChunkToSink(new Uint8Array([0]));
        id3RiffChunkLen = 8 + tagBytes.byteLength + padByte;
      }

      const riffSize = 36 + this.dataBytesWritten + id3RiffChunkLen;
      await this.sink.patchAt(4, uint32LE(riffSize));
      await this.sink.patchAt(40, uint32LE(this.dataBytesWritten));
    } else if (this.options.format === 'FLAC') {
      await this.streamFlacPcm(
        Array.from({ length: this.options.channels }, () => new Float32Array(0)),
        0,
        true,
      );
      embeddedChapterCount = this.flacChapterCount;
      // Patch STREAMINFO rate/channels/bps/totalSamples bytes [18..25] of the file
      await this.sink.patchAt(18, this.packFlacStreamInfoRateChannelsTotal(this.totalFramesWritten));
    } else {
      const tail = await this.options.mp3EncoderAdapter!.flush();
      await this.writeChunkToSink(tail);
      embeddedChapterCount = this.id3ChapterCount;
    }

    const sinkResult = await this.sink.finalize(
      getMimeTypeForFormat(this.options.format),
      this.options.createObjectUrl ?? false,
    );

    return {
      format: this.options.format,
      sinkKind: this.sink.kind,
      totalBytesWritten: sinkResult.totalBytesWritten,
      totalFramesWritten: this.totalFramesWritten,
      durationSeconds: this.totalFramesWritten / this.options.sampleRate,
      peakSingleWriteBytes: this.peakSingleWriteBytes,
      embeddedChapterCount,
      id3TagSizeBytes: this.id3TagSizeBytes,
      opfsFileName: sinkResult.opfsFileName,
      blob: sinkResult.blob,
      blobUrl: sinkResult.blobUrl,
    };
  }

  public async abort(): Promise<void> {
    this.finalized = true;
    await this.sink.abort();
  }

  // --------------------------------------------------------------------------
  // WAV Chunk Encoders
  // --------------------------------------------------------------------------
  private buildWavHeaderPlaceholder(): Uint8Array {
    const bitDepth = this.options.wavBitDepth ?? 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = this.options.channels * bytesPerSample;
    const byteRate = this.options.sampleRate * blockAlign;
    const audioFormat = bitDepth === 32 ? 3 : 1;

    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const writeAscii = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i);
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, audioFormat, true);
    view.setUint16(22, this.options.channels, true);
    view.setUint32(24, this.options.sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeAscii(36, 'data');
    view.setUint32(40, 0, true);
    return header;
  }

  private encodeWavChunk(channels: Float32Array[], frameCount: number): Uint8Array {
    const bitDepth = this.options.wavBitDepth ?? 16;
    const out = new Uint8Array(frameCount * this.options.channels * (bitDepth / 8));
    const view = new DataView(out.buffer);
    let offset = 0;

    if (bitDepth === 16) {
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < this.options.channels; c++) {
          view.setInt16(offset, quantizeSample(channels[c][i], 16), true);
          offset += 2;
        }
      }
    } else if (bitDepth === 24) {
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < this.options.channels; c++) {
          const q = quantizeSample(channels[c][i], 24);
          out[offset++] = q & 0xff;
          out[offset++] = (q >> 8) & 0xff;
          out[offset++] = (q >> 16) & 0xff;
        }
      }
    } else {
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < this.options.channels; c++) {
          const v = Number.isFinite(channels[c][i]) ? channels[c][i] : 0;
          view.setFloat32(offset, Math.max(-1, Math.min(1, v)), true);
          offset += 4;
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // FLAC Streaming Multiplexer (RFC 9639)
  // --------------------------------------------------------------------------
  private packFlacStreamInfoRateChannelsTotal(totalSamples: number): Uint8Array {
    const bitDepth = this.options.flacBitDepth ?? 16;
    const sr = this.options.sampleRate;
    const chMinus1 = (this.options.channels - 1) & 0x07;
    const bpsMinus1 = (bitDepth - 1) & 0x1f;

    const out = new Uint8Array(8);
    out[0] = (sr >>> 12) & 0xff;
    out[1] = (sr >>> 4) & 0xff;
    out[2] = ((sr & 0x0f) << 4) | (chMinus1 << 1) | ((bpsMinus1 >>> 4) & 0x01);

    const totalBig = BigInt(Math.max(0, Math.floor(totalSamples)));
    out[3] = ((bpsMinus1 & 0x0f) << 4) | Number((totalBig >> 32n) & 0x0fn);
    out[4] = Number((totalBig >> 24n) & 0xffn);
    out[5] = Number((totalBig >> 16n) & 0xffn);
    out[6] = Number((totalBig >> 8n) & 0xffn);
    out[7] = Number(totalBig & 0xffn);
    return out;
  }

  private buildFlacInitBlocks(): {
    magic: Uint8Array;
    streamInfoBlock: Uint8Array;
    vorbisBlock: Uint8Array;
    chapterCount: number;
  } {
    const magic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
    const streamInfoBlock = new Uint8Array(38);
    streamInfoBlock[0] = 0x00;
    streamInfoBlock[3] = 34;
    const view = new DataView(streamInfoBlock.buffer, 4);
    view.setUint16(0, this.flacBlockSize, false);
    view.setUint16(2, this.flacBlockSize, false);
    streamInfoBlock.set(this.packFlacStreamInfoRateChannelsTotal(0), 14);

    const { blockBytes: vorbisBlock, chapterCount } = buildFlacVorbisCommentBlock(this.metadata);
    return { magic, streamInfoBlock, vorbisBlock, chapterCount };
  }

  private async streamFlacPcm(
    incoming: Float32Array[],
    incomingLen: number,
    flushTail: boolean,
  ): Promise<void> {
    if (incomingLen > 0) {
      for (let c = 0; c < this.options.channels; c++) {
        const merged = new Float32Array(this.flacResidual[c].length + incomingLen);
        merged.set(this.flacResidual[c], 0);
        merged.set(incoming[c], this.flacResidual[c].length);
        this.flacResidual[c] = merged;
      }
    }

    const available = this.flacResidual[0]?.length ?? 0;
    let cursor = 0;
    while (available - cursor >= this.flacBlockSize) {
      const block = this.flacResidual.map((ch) => ch.subarray(cursor, cursor + this.flacBlockSize));
      const frame = this.encodeFlacFrame(block, this.flacBlockSize);
      await this.writeChunkToSink(frame);
      cursor += this.flacBlockSize;
    }

    if (cursor > 0) {
      for (let c = 0; c < this.options.channels; c++) {
        this.flacResidual[c] = this.flacResidual[c].slice(cursor);
      }
    }

    if (flushTail && (this.flacResidual[0]?.length ?? 0) > 0) {
      const rem = this.flacResidual[0].length;
      const frame = this.encodeFlacFrame(this.flacResidual, rem);
      await this.writeChunkToSink(frame);
      this.flacResidual = Array.from({ length: this.options.channels }, () => new Float32Array(0));
    }
  }

  private encodeFlacFrame(channels: Float32Array[], blockSize: number): Uint8Array {
    const bitDepth = this.options.flacBitDepth ?? 16;
    const bytesPerSample = bitDepth / 8;
    const srCode = getFlacSampleRateCode(this.options.sampleRate);

    let blockSizeCode: number;
    let extraBlockBytes: Uint8Array = new Uint8Array(0);
    if (blockSize === 4096) {
      blockSizeCode = 0x0c;
    } else if (blockSize <= 256) {
      blockSizeCode = 0x06;
      extraBlockBytes = new Uint8Array([blockSize - 1]);
    } else {
      blockSizeCode = 0x07;
      extraBlockBytes = new Uint8Array([((blockSize - 1) >>> 8) & 0xff, (blockSize - 1) & 0xff]);
    }

    const chAssignment = (this.options.channels - 1) & 0x0f;
    const sampleSizeCode = bitDepth === 16 ? 0x04 : 0x06;
    const frameIdxBytes = encodeFlacUtf8Number(this.flacFrameIndex++);

    const headerBody = concatBytes([
      new Uint8Array([
        0xff,
        0xf8,
        (blockSizeCode << 4) | srCode,
        (chAssignment << 4) | (sampleSizeCode << 1),
      ]),
      frameIdxBytes,
      extraBlockBytes,
    ]);
    const crc8 = computeFlacCrc8(headerBody);
    const header = concatBytes([headerBody, new Uint8Array([crc8])]);

    const subframes: Uint8Array[] = [];
    for (let c = 0; c < this.options.channels; c++) {
      const ch = channels[c];
      const firstQ = quantizeSample(ch[0], bitDepth);
      let isConstant = true;
      for (let i = 1; i < blockSize; i++) {
        if (quantizeSample(ch[i], bitDepth) !== firstQ) {
          isConstant = false;
          break;
        }
      }

      if (isConstant) {
        const sf = new Uint8Array(1 + bytesPerSample);
        sf[0] = 0x00; // SUBFRAME_CONSTANT
        if (bitDepth === 16) {
          sf[1] = (firstQ >>> 8) & 0xff;
          sf[2] = firstQ & 0xff;
        } else {
          sf[1] = (firstQ >>> 16) & 0xff;
          sf[2] = (firstQ >>> 8) & 0xff;
          sf[3] = firstQ & 0xff;
        }
        subframes.push(sf);
      } else {
        const sf = new Uint8Array(1 + blockSize * bytesPerSample);
        sf[0] = 0x02; // SUBFRAME_VERBATIM
        let pos = 1;
        if (bitDepth === 16) {
          for (let i = 0; i < blockSize; i++) {
            const q = quantizeSample(ch[i], 16);
            sf[pos++] = (q >>> 8) & 0xff;
            sf[pos++] = q & 0xff;
          }
        } else {
          for (let i = 0; i < blockSize; i++) {
            const q = quantizeSample(ch[i], 24);
            sf[pos++] = (q >>> 16) & 0xff;
            sf[pos++] = (q >>> 8) & 0xff;
            sf[pos++] = q & 0xff;
          }
        }
        subframes.push(sf);
      }
    }

    const frameBody = concatBytes([header, ...subframes]);
    const crc16 = computeFlacCrc16(frameBody);
    return concatBytes([frameBody, new Uint8Array([(crc16 >>> 8) & 0xff, crc16 & 0xff])]);
  }
}

// ============================================================================
// Web Worker Message Protocol Handler (Active when run inside Dedicated Worker)
// ============================================================================
export type WorkerExportRequest =
  | {
      type: 'START_EXPORT';
      requestId: string;
      options: Omit<StreamingExportOptions, 'mp3EncoderAdapter' | 'customSink'>;
      metadata: PodcastMetadata;
    }
  | {
      type: 'PUSH_PCM_CHUNK';
      requestId: string;
      channels: Float32Array[];
    }
  | {
      type: 'FINALIZE_EXPORT';
      requestId: string;
    }
  | {
      type: 'ABORT_EXPORT';
      requestId: string;
    };

export type WorkerExportResponse =
  | {
      type: 'EXPORT_STARTED';
      requestId: string;
    }
  | {
      type: 'EXPORT_PROGRESS';
      requestId: string;
      framesWritten: number;
    }
  | {
      type: 'EXPORT_FINALIZED';
      requestId: string;
      report: Omit<StreamingExportReport, 'blob'> & { hasBlob: boolean };
      blob?: Blob;
    }
  | {
      type: 'EXPORT_ABORTED';
      requestId: string;
    }
  | {
      type: 'EXPORT_ERROR';
      requestId: string;
      code: string;
      message: string;
      userMessageFa?: string;
    };

declare const WorkerGlobalScope: { prototype: object } | undefined;

const runningInWorker =
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof (WorkerGlobalScope as unknown as { new (): object });

if (runningInWorker) {
  const activeSessions = new Map<string, StreamingExportSession>();
  const postMsg = (payload: WorkerExportResponse) => {
    (self as unknown as { postMessage(msg: unknown): void }).postMessage(payload);
  };

  (self as unknown as { onmessage: ((ev: MessageEvent<WorkerExportRequest>) => void) | null }).onmessage =
    async (event: MessageEvent<WorkerExportRequest>) => {
      const msg = event.data;
      try {
        if (msg.type === 'START_EXPORT') {
          const session = new StreamingExportSession(msg.options, msg.metadata);
          await session.start();
          activeSessions.set(msg.requestId, session);
          postMsg({ type: 'EXPORT_STARTED', requestId: msg.requestId });
        } else if (msg.type === 'PUSH_PCM_CHUNK') {
          const session = activeSessions.get(msg.requestId);
          if (!session) throw new Error(`Unknown export session: ${msg.requestId}`);
          const { framesWritten } = await session.pushPcmChunk(msg.channels);
          postMsg({ type: 'EXPORT_PROGRESS', requestId: msg.requestId, framesWritten });
        } else if (msg.type === 'FINALIZE_EXPORT') {
          const session = activeSessions.get(msg.requestId);
          if (!session) throw new Error(`Unknown export session: ${msg.requestId}`);
          const fullReport = await session.finalize();
          activeSessions.delete(msg.requestId);
          const { blob, ...rest } = fullReport;
          postMsg({
            type: 'EXPORT_FINALIZED',
            requestId: msg.requestId,
            report: { ...rest, hasBlob: Boolean(blob) },
            blob,
          });
        } else if (msg.type === 'ABORT_EXPORT') {
          const session = activeSessions.get(msg.requestId);
          if (session) {
            await session.abort();
            activeSessions.delete(msg.requestId);
          }
          postMsg({ type: 'EXPORT_ABORTED', requestId: msg.requestId });
        }
      } catch (err) {
        if (err instanceof StreamingExportCodecError) {
          postMsg({
            type: 'EXPORT_ERROR',
            requestId: msg.requestId,
            code: err.code,
            message: err.message,
            userMessageFa: err.userMessageFa,
          });
          return;
        }
        postMsg({
          type: 'EXPORT_ERROR',
          requestId: msg.requestId,
          code: 'ERR_EXPORT_STREAM_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };
}
