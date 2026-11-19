import { SampleRate, TimeMath, Flicks } from '../contracts/timebase.contract';
import type { StructuredPlatformError } from '../contracts/PlatformErrorCatalog';

export type ExportAudioFormat = 'WAV' | 'FLAC' | 'MP3';
export type WavBitDepth = 16 | 24 | 32;
export type FlacBitDepth = 16 | 24;

export interface ExtractedTopicChapter {
  readonly id: string;
  readonly titleFa: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startFlicks?: Flicks;
  readonly endFlicks?: Flicks;
  readonly speakerName?: string;
}

export interface PodcastExportMetadata {
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly year?: string;
  readonly genre?: string;
  readonly comment?: string;
  readonly chapters: readonly ExtractedTopicChapter[];
}

export interface Mp3FrameEncoderAdapter {
  init(config: { sampleRate: SampleRate; channels: number; bitrateKbps: number }): void | Promise<void>;
  encodeChunk(channels: Float32Array[]): Uint8Array | Promise<Uint8Array>;
  flush(): Uint8Array | Promise<Uint8Array>;
}

export interface StreamingExportConfig {
  readonly format: ExportAudioFormat;
  readonly sampleRate: SampleRate;
  readonly channels: number;
  readonly wavBitDepth?: WavBitDepth;
  readonly flacBitDepth?: FlacBitDepth;
  readonly flacBlockSize?: number;
  readonly mp3BitrateKbps?: number;
  readonly mp3EncoderAdapter?: Mp3FrameEncoderAdapter;
}

export interface BinaryHeaderPatch {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface ExportStreamFinalizeResult {
  readonly format: ExportAudioFormat;
  readonly tailChunks: Uint8Array[];
  readonly headerPatches: BinaryHeaderPatch[];
  readonly totalBytesWritten: number;
  readonly totalFramesWritten: number;
  readonly durationSeconds: number;
  readonly id3TagSizeBytes: number;
  readonly embeddedChapterCount: number;
}

const utf8Encoder = new TextEncoder();

export function createExportCodecError(detail: string): StructuredPlatformError {
  return {
    code: 'ERR_EXPORT_CODEC_UNAVAILABLE',
    category: 'EXPORT_ERROR',
    severity: 'ERROR',
    retryable: false,
    recoveryStrategy: 'NONE_USER_ACTION_REQUIRED',
    userMessageFa:
      'کدک رمزگذار MP3 در محیط فعلی متصل نشده است؛ لطفاً آداپتور کدک MP3 را تزریق کنید یا از خروجی WAV/FLAC استفاده نمایید.',
    technicalDiagnosticRedacted: detail,
  };
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
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

function writeUint32BE(val: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, val >>> 0, false);
  return buf;
}

function writeUint32LE(val: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, val >>> 0, true);
  return buf;
}

function normalizeChapters(chapters: readonly ExtractedTopicChapter[]): ExtractedTopicChapter[] {
  return chapters
    .map((ch) => {
      const rawStartMs =
        typeof ch.startFlicks === 'number' && Number.isFinite(ch.startFlicks)
          ? Math.round(TimeMath.flicksToSeconds(ch.startFlicks) * 1000)
          : Number.isFinite(ch.startMs)
            ? Math.round(ch.startMs)
            : 0;
      const startMs = Math.max(0, rawStartMs);
      const rawEndMs =
        typeof ch.endFlicks === 'number' && Number.isFinite(ch.endFlicks)
          ? Math.round(TimeMath.flicksToSeconds(ch.endFlicks) * 1000)
          : Number.isFinite(ch.endMs)
            ? Math.round(ch.endMs)
            : startMs;
      return {
        ...ch,
        startMs,
        endMs: Math.max(startMs, rawEndMs),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

function buildId3v24Frame(frameId: string, payload: Uint8Array): Uint8Array {
  if (frameId.length !== 4) {
    throw new Error(`Invalid ID3v2 frame ID: ${frameId}`);
  }
  const header = new Uint8Array(10);
  for (let i = 0; i < 4; i++) {
    header[i] = frameId.charCodeAt(i) & 0x7f;
  }
  header.set(encodeSynchsafe32(payload.byteLength), 4);
  // Flags [8..9] = 0x00 0x00
  return concatUint8Arrays([header, payload]);
}

function buildId3Utf8TextFrame(frameId: string, text: string): Uint8Array {
  const encoded = utf8Encoder.encode(text);
  const payload = new Uint8Array(1 + encoded.byteLength);
  payload[0] = 0x03; // UTF-8 encoding in ID3v2.4
  payload.set(encoded, 1);
  return buildId3v24Frame(frameId, payload);
}

function buildId3CommentFrame(text: string, lang = 'fas'): Uint8Array {
  const encoded = utf8Encoder.encode(text);
  const langBytes = utf8Encoder.encode(lang.slice(0, 3).padEnd(3, ' '));
  // [encoding=0x03, lang(3), shortDescNullTerminated(0x00), text...]
  const payload = new Uint8Array(1 + 3 + 1 + encoded.byteLength);
  payload[0] = 0x03;
  payload.set(langBytes.subarray(0, 3), 1);
  payload[4] = 0x00;
  payload.set(encoded, 5);
  return buildId3v24Frame('COMM', payload);
}

/**
 * Builds a spec-compliant ID3v2.4 binary tag with UTF-8 Persian text frames
 * plus CTOC & CHAP podcast chapter markers derived from extracted topics.
 */
export function buildId3v2Tag(metadata: PodcastExportMetadata): {
  tagBytes: Uint8Array;
  normalizedChapters: ExtractedTopicChapter[];
} {
  const frames: Uint8Array[] = [];
  const normalizedChapters = normalizeChapters(metadata.chapters);

  if (metadata.title) frames.push(buildId3Utf8TextFrame('TIT2', metadata.title));
  if (metadata.artist) frames.push(buildId3Utf8TextFrame('TPE1', metadata.artist));
  if (metadata.album) frames.push(buildId3Utf8TextFrame('TALB', metadata.album));
  if (metadata.year) frames.push(buildId3Utf8TextFrame('TDRC', metadata.year));
  if (metadata.genre) frames.push(buildId3Utf8TextFrame('TCON', metadata.genre));
  if (metadata.comment) frames.push(buildId3CommentFrame(metadata.comment));

  const boundedChapters = normalizedChapters.slice(0, 255);
  if (boundedChapters.length > 0) {
    const childIds: Uint8Array[] = [];
    for (let i = 0; i < boundedChapters.length; i++) {
      childIds.push(utf8Encoder.encode(`ch${i}\0`));
    }

    const tocTitleFrame = buildId3Utf8TextFrame('TIT2', 'فهرست مباحث');
    const tocHeader = concatUint8Arrays([
      utf8Encoder.encode('toc\0'),
      new Uint8Array([0x03, boundedChapters.length & 0xff]), // top-level + ordered flags
      ...childIds,
      tocTitleFrame,
    ]);
    frames.push(buildId3v24Frame('CTOC', tocHeader));

    for (let i = 0; i < boundedChapters.length; i++) {
      const ch = boundedChapters[i];
      const displayTitle = ch.speakerName ? `${ch.titleFa} — ${ch.speakerName}` : ch.titleFa;
      const chapSubFrame = buildId3Utf8TextFrame('TIT2', displayTitle);
      const chapPayload = concatUint8Arrays([
        utf8Encoder.encode(`ch${i}\0`),
        writeUint32BE(ch.startMs),
        writeUint32BE(ch.endMs),
        new Uint8Array([0xff, 0xff, 0xff, 0xff]), // start offset unused
        new Uint8Array([0xff, 0xff, 0xff, 0xff]), // end offset unused
        chapSubFrame,
      ]);
      frames.push(buildId3v24Frame('CHAP', chapPayload));
    }
  }

  const body = concatUint8Arrays(frames);
  const header = new Uint8Array(10);
  header[0] = 0x49; // 'I'
  header[1] = 0x44; // 'D'
  header[2] = 0x33; // '3'
  header[3] = 0x04; // ID3v2.4
  header[4] = 0x00; // revision 0
  header[5] = 0x00; // flags
  header.set(encodeSynchsafe32(body.byteLength), 6);

  return {
    tagBytes: concatUint8Arrays([header, body]),
    normalizedChapters: boundedChapters,
  };
}

// ============================================================================
// FLAC CRC-8 (poly 0x07) & CRC-16 (poly 0x8005) Lookup Tables (RFC 9639)
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

export function computeFlacCrc8(data: Uint8Array, length = data.byteLength): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc = FLAC_CRC8_TABLE[crc ^ data[i]];
  }
  return crc;
}

export function computeFlacCrc16(data: Uint8Array, length = data.byteLength): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
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
  const prefixMask = ((0xff << (8 - len)) & 0xff);
  bytes[0] = prefixMask | v;
  return new Uint8Array(bytes);
}

function getFlacSampleRateCode(sampleRate: SampleRate): number {
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
    default:
      return 0x0; // 0 = get from STREAMINFO header per RFC 9639
  }
}

function formatChapterTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function buildFlacVorbisCommentBlock(metadata: PodcastExportMetadata): {
  blockBytes: Uint8Array;
  chapterCount: number;
} {
  const comments: string[] = [];
  if (metadata.title) comments.push(`TITLE=${metadata.title}`);
  if (metadata.artist) comments.push(`ARTIST=${metadata.artist}`);
  if (metadata.album) comments.push(`ALBUM=${metadata.album}`);
  if (metadata.year) comments.push(`DATE=${metadata.year}`);
  if (metadata.genre) comments.push(`GENRE=${metadata.genre}`);
  if (metadata.comment) comments.push(`DESCRIPTION=${metadata.comment}`);

  const chapters = normalizeChapters(metadata.chapters);
  for (let i = 0; i < chapters.length; i++) {
    const num = String(i + 1).padStart(3, '0');
    const ch = chapters[i];
    const label = ch.speakerName ? `${ch.titleFa} — ${ch.speakerName}` : ch.titleFa;
    comments.push(`CHAPTER${num}=${formatChapterTimestamp(ch.startMs)}`);
    comments.push(`CHAPTER${num}NAME=${label}`);
  }

  const vendorBytes = utf8Encoder.encode('Avapardaz Streaming FLAC Muxer v1.2');
  const encodedComments = comments.map((c) => utf8Encoder.encode(c));

  let payloadLen = 4 + vendorBytes.byteLength + 4;
  for (const c of encodedComments) {
    payloadLen += 4 + c.byteLength;
  }

  const block = new Uint8Array(4 + payloadLen);
  const view = new DataView(block.buffer);
  // Last metadata block flag (0x80) + block type 4 (VORBIS_COMMENT)
  block[0] = 0x84;
  block[1] = (payloadLen >>> 16) & 0xff;
  block[2] = (payloadLen >>> 8) & 0xff;
  block[3] = payloadLen & 0xff;

  let cursor = 4;
  view.setUint32(cursor, vendorBytes.byteLength, true);
  cursor += 4;
  block.set(vendorBytes, cursor);
  cursor += vendorBytes.byteLength;

  view.setUint32(cursor, encodedComments.length, true);
  cursor += 4;
  for (const c of encodedComments) {
    view.setUint32(cursor, c.byteLength, true);
    cursor += 4;
    block.set(c, cursor);
    cursor += c.byteLength;
  }

  return { blockBytes: block, chapterCount: chapters.length };
}

function quantizeSample(sample: number, bitDepth: 16 | 24): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  if (bitDepth === 16) {
    return Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
  }
  return Math.max(-8388608, Math.min(8388607, Math.round(clamped * 8388607)));
}

/**
 * Stateful streaming encoder session supporting incremental chunk emission
 * for WAV (16/24-bit PCM & 32-bit IEEE Float + RIFF id3 chunk),
 * FLAC (RFC 9639 lossless stream + Vorbis Comments/Chapters + CRC-8/CRC-16),
 * and MP3 (ID3v2.4 + CHAP/CTOC header + injectable frame encoder adapter).
 */
export class StreamingExportEncoderEngine {
  private readonly config: StreamingExportConfig;
  private readonly metadata: PodcastExportMetadata;
  private started = false;
  private finalized = false;

  private totalBytesWritten = 0;
  private totalFramesWritten = 0;
  private dataBytesWritten = 0;

  // FLAC state
  private flacFrameIndex = 0;
  private flacResidual: Float32Array[] = [];
  private readonly flacBlockSize: number;
  private flacChapterCount = 0;

  // ID3 tag state
  private id3TagBytes: Uint8Array = new Uint8Array(0);
  private id3ChapterCount = 0;

  constructor(config: StreamingExportConfig, metadata: PodcastExportMetadata) {
    if (!Number.isFinite(config.channels) || config.channels < 1 || config.channels > 8) {
      throw new Error(`Unsupported channel count: ${config.channels}`);
    }
    const safeSampleRate =
      Number.isFinite(config.sampleRate) && config.sampleRate > 0
        ? (Math.floor(config.sampleRate) as SampleRate)
        : 48000;
    this.config = { ...config, sampleRate: safeSampleRate };
    this.metadata = metadata;
    const rawBlockSize = config.flacBlockSize ?? 4096;
    this.flacBlockSize =
      Number.isFinite(rawBlockSize) && rawBlockSize >= 16
        ? Math.min(65535, Math.floor(rawBlockSize))
        : 4096;
  }

  public async start(): Promise<Uint8Array[]> {
    if (this.started) {
      throw new Error('StreamingExportEncoderEngine session already started.');
    }
    this.started = true;

    if (this.config.format === 'WAV') {
      const header = this.buildWavHeaderPlaceholder();
      this.totalBytesWritten += header.byteLength;
      return [header];
    }

    if (this.config.format === 'FLAC') {
      const flacInitChunks = this.buildFlacHeaderBlocks();
      this.flacResidual = Array.from({ length: this.config.channels }, () => new Float32Array(0));
      for (const chunk of flacInitChunks) {
        this.totalBytesWritten += chunk.byteLength;
      }
      return flacInitChunks;
    }

    // MP3
    if (!this.config.mp3EncoderAdapter) {
      throw createExportCodecError(
        'MP3 streaming export requested without an Mp3FrameEncoderAdapter implementation.',
      );
    }

    await this.config.mp3EncoderAdapter.init({
      sampleRate: this.config.sampleRate,
      channels: this.config.channels,
      bitrateKbps: this.config.mp3BitrateKbps ?? 192,
    });

    const { tagBytes, normalizedChapters } = buildId3v2Tag(this.metadata);
    this.id3TagBytes = tagBytes;
    this.id3ChapterCount = normalizedChapters.length;
    this.totalBytesWritten += tagBytes.byteLength;
    return [tagBytes];
  }

  public async pushPcmChunk(channels: Float32Array[]): Promise<Uint8Array[]> {
    if (!this.started || this.finalized) {
      throw new Error('Cannot push PCM chunk outside an active streaming session.');
    }
    if (channels.length !== this.config.channels) {
      throw new Error(
        `Channel mismatch: expected ${this.config.channels} channels, got ${channels.length}.`,
      );
    }
    const frameCount = channels[0]?.length ?? 0;
    if (frameCount === 0) return [];
    for (let c = 1; c < channels.length; c++) {
      if (channels[c].length !== frameCount) {
        throw new Error('All audio channels in a PCM chunk must have identical frame lengths.');
      }
    }

    this.totalFramesWritten += frameCount;

    if (this.config.format === 'WAV') {
      const chunkBytes = this.encodeWavPcmChunk(channels, frameCount);
      this.dataBytesWritten += chunkBytes.byteLength;
      this.totalBytesWritten += chunkBytes.byteLength;
      return [chunkBytes];
    }

    if (this.config.format === 'FLAC') {
      return this.encodeFlacPcmChunk(channels, frameCount, false);
    }

    // MP3 via adapter
    const adapter = this.config.mp3EncoderAdapter!;
    const encoded = await adapter.encodeChunk(channels);
    if (encoded.byteLength === 0) return [];
    this.totalBytesWritten += encoded.byteLength;
    return [encoded];
  }

  public async finalize(): Promise<ExportStreamFinalizeResult> {
    if (!this.started || this.finalized) {
      throw new Error('Streaming session cannot be finalized.');
    }
    this.finalized = true;

    const durationSeconds = this.totalFramesWritten / this.config.sampleRate;

    if (this.config.format === 'WAV') {
      const { tagBytes, normalizedChapters } = buildId3v2Tag(this.metadata);
      this.id3TagBytes = tagBytes;
      this.id3ChapterCount = normalizedChapters.length;

      const tailChunks: Uint8Array[] = [];
      let id3RiffChunkTotal = 0;
      if (tagBytes.byteLength > 0) {
        const needsPadByte = tagBytes.byteLength % 2 === 1;
        const riffId3Header = new Uint8Array(8);
        riffId3Header[0] = 0x69; // 'i'
        riffId3Header[1] = 0x64; // 'd'
        riffId3Header[2] = 0x33; // '3'
        riffId3Header[3] = 0x20; // ' '
        riffId3Header.set(writeUint32LE(tagBytes.byteLength), 4);

        const id3Chunk = needsPadByte
          ? concatUint8Arrays([riffId3Header, tagBytes, new Uint8Array([0])])
          : concatUint8Arrays([riffId3Header, tagBytes]);
        tailChunks.push(id3Chunk);
        id3RiffChunkTotal = id3Chunk.byteLength;
        this.totalBytesWritten += id3RiffChunkTotal;
      }

      // RIFF size = 4 ('WAVE') + 24 ('fmt ') + 8 ('data') + dataBytes + id3ChunkSize
      const riffSize = 36 + this.dataBytesWritten + id3RiffChunkTotal;
      const headerPatches: BinaryHeaderPatch[] = [
        { offset: 4, bytes: writeUint32LE(riffSize) },
        { offset: 40, bytes: writeUint32LE(this.dataBytesWritten) },
      ];

      return {
        format: 'WAV',
        tailChunks,
        headerPatches,
        totalBytesWritten: this.totalBytesWritten,
        totalFramesWritten: this.totalFramesWritten,
        durationSeconds,
        id3TagSizeBytes: tagBytes.byteLength,
        embeddedChapterCount: this.id3ChapterCount,
      };
    }

    if (this.config.format === 'FLAC') {
      const residualLen = this.flacResidual[0]?.length ?? 0;
      const tailChunks =
        residualLen > 0
          ? this.encodeFlacPcmChunk(
              this.flacResidual.map(() => new Float32Array(0)),
              0,
              true,
            )
          : [];

      // Patch STREAMINFO totalSamples (36-bit integer spanning bytes 21..25 of file,
      // i.e., offset 4 (fLaC) + 4 (block header) + 13 = byte 21, lower 4 bits of byte 21 + bytes 22..25).
      const streamInfoByte13To17 = this.buildFlacRateChannelsSampleTotalBytes(this.totalFramesWritten);
      const headerPatches: BinaryHeaderPatch[] = [
        {
          offset: 4 + 4 + 10, // STREAMINFO byte 10..17 (8 bytes holding rate/ch/bps/totalSamples)
          bytes: streamInfoByte13To17,
        },
      ];

      return {
        format: 'FLAC',
        tailChunks,
        headerPatches,
        totalBytesWritten: this.totalBytesWritten,
        totalFramesWritten: this.totalFramesWritten,
        durationSeconds,
        id3TagSizeBytes: 0,
        embeddedChapterCount: this.flacChapterCount,
      };
    }

    // MP3 finalize
    const adapter = this.config.mp3EncoderAdapter!;
    const flushed = await adapter.flush();
    const tailChunks = flushed.byteLength > 0 ? [flushed] : [];
    this.totalBytesWritten += flushed.byteLength;

    return {
      format: 'MP3',
      tailChunks,
      headerPatches: [],
      totalBytesWritten: this.totalBytesWritten,
      totalFramesWritten: this.totalFramesWritten,
      durationSeconds,
      id3TagSizeBytes: this.id3TagBytes.byteLength,
      embeddedChapterCount: this.id3ChapterCount,
    };
  }

  // --------------------------------------------------------------------------
  // WAV Helpers
  // --------------------------------------------------------------------------
  private buildWavHeaderPlaceholder(): Uint8Array {
    const bitDepth = this.config.wavBitDepth ?? 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = this.config.channels * bytesPerSample;
    const byteRate = this.config.sampleRate * blockAlign;
    const audioFormat = bitDepth === 32 ? 3 : 1; // 3 = IEEE Float, 1 = PCM

    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeAscii = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36, true); // Patched on finalize
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, audioFormat, true);
    view.setUint16(22, this.config.channels, true);
    view.setUint32(24, this.config.sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeAscii(36, 'data');
    view.setUint32(40, 0, true); // Patched on finalize

    return new Uint8Array(header);
  }

  private encodeWavPcmChunk(channels: Float32Array[], frameCount: number): Uint8Array {
    const bitDepth = this.config.wavBitDepth ?? 16;
    const bytesPerSample = bitDepth / 8;
    const out = new Uint8Array(frameCount * this.config.channels * bytesPerSample);
    const view = new DataView(out.buffer);
    let offset = 0;

    if (bitDepth === 16) {
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < this.config.channels; c++) {
          const sample = quantizeSample(channels[c][i], 16);
          view.setInt16(offset, sample, true);
          offset += 2;
        }
      }
    } else if (bitDepth === 24) {
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < this.config.channels; c++) {
          const sample = quantizeSample(channels[c][i], 24);
          out[offset] = sample & 0xff;
          out[offset + 1] = (sample >> 8) & 0xff;
          out[offset + 2] = (sample >> 16) & 0xff;
          offset += 3;
        }
      }
    } else {
      // 32-bit IEEE Float
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < this.config.channels; c++) {
          const v = Number.isFinite(channels[c][i]) ? channels[c][i] : 0;
          view.setFloat32(offset, Math.max(-1, Math.min(1, v)), true);
          offset += 4;
        }
      }
    }

    return out;
  }

  // --------------------------------------------------------------------------
  // FLAC Helpers (RFC 9639 Streaming Muxer)
  // --------------------------------------------------------------------------
  private buildFlacRateChannelsSampleTotalBytes(totalSamples: number): Uint8Array {
    const bitsPerSample = this.config.flacBitDepth ?? 16;
    const sr = this.config.sampleRate;
    const chMinus1 = (this.config.channels - 1) & 0x07;
    const bpsMinus1 = (bitsPerSample - 1) & 0x1f;

    const out = new Uint8Array(8);
    // 20 bits sample rate, 3 bits (ch-1), 5 bits (bps-1), 36 bits totalSamples
    out[0] = (sr >>> 12) & 0xff;
    out[1] = (sr >>> 4) & 0xff;
    out[2] = ((sr & 0x0f) << 4) | (chMinus1 << 1) | ((bpsMinus1 >>> 4) & 0x01);

    const totalBig = BigInt(Math.max(0, Math.floor(totalSamples)));
    const top4Total = Number((totalBig >> 32n) & 0x0fn);
    out[3] = ((bpsMinus1 & 0x0f) << 4) | top4Total;
    out[4] = Number((totalBig >> 24n) & 0xffn);
    out[5] = Number((totalBig >> 16n) & 0xffn);
    out[6] = Number((totalBig >> 8n) & 0xffn);
    out[7] = Number(totalBig & 0xffn);
    return out;
  }

  private buildFlacHeaderBlocks(): Uint8Array[] {
    const magic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // 'fLaC'

    const streamInfoBlock = new Uint8Array(4 + 34);
    streamInfoBlock[0] = 0x00; // Not last metadata block, type 0 (STREAMINFO)
    streamInfoBlock[1] = 0x00;
    streamInfoBlock[2] = 0x00;
    streamInfoBlock[3] = 34;

    const siView = new DataView(streamInfoBlock.buffer, 4);
    siView.setUint16(0, this.flacBlockSize, false); // min block size
    siView.setUint16(2, this.flacBlockSize, false); // max block size
    // minFrameSize (3 bytes) = 0, maxFrameSize (3 bytes) = 0
    streamInfoBlock.set(this.buildFlacRateChannelsSampleTotalBytes(0), 4 + 10);
    // Remaining 16 bytes [18..33] stay 0x00 (uncomputed streaming MD5, valid per RFC 9639)

    const { blockBytes: vorbisBlock, chapterCount } = buildFlacVorbisCommentBlock(this.metadata);
    this.flacChapterCount = chapterCount;

    return [magic, streamInfoBlock, vorbisBlock];
  }

  private encodeFlacPcmChunk(
    incoming: Float32Array[],
    incomingLen: number,
    flushTail: boolean,
  ): Uint8Array[] {
    const emitted: Uint8Array[] = [];

    for (let c = 0; c < this.config.channels; c++) {
      if (incomingLen > 0) {
        const merged = new Float32Array(this.flacResidual[c].length + incomingLen);
        merged.set(this.flacResidual[c], 0);
        merged.set(incoming[c], this.flacResidual[c].length);
        this.flacResidual[c] = merged;
      }
    }

    let available = this.flacResidual[0]?.length ?? 0;
    let cursor = 0;

    while (available - cursor >= this.flacBlockSize) {
      const slice = this.flacResidual.map((ch) => ch.subarray(cursor, cursor + this.flacBlockSize));
      const frame = this.encodeSingleFlacFrame(slice, this.flacBlockSize);
      emitted.push(frame);
      this.totalBytesWritten += frame.byteLength;
      cursor += this.flacBlockSize;
    }

    if (cursor > 0) {
      for (let c = 0; c < this.config.channels; c++) {
        this.flacResidual[c] = this.flacResidual[c].slice(cursor);
      }
    }

    if (flushTail && this.flacResidual[0].length > 0) {
      const rem = this.flacResidual[0].length;
      const frame = this.encodeSingleFlacFrame(this.flacResidual, rem);
      emitted.push(frame);
      this.totalBytesWritten += frame.byteLength;
      this.flacResidual = Array.from({ length: this.config.channels }, () => new Float32Array(0));
    }

    return emitted;
  }

  private encodeSingleFlacFrame(channels: Float32Array[], blockSize: number): Uint8Array {
    const bitDepth = this.config.flacBitDepth ?? 16;
    const bytesPerSample = bitDepth / 8;
    const srCode = getFlacSampleRateCode(this.config.sampleRate);

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

    const chAssignment = (this.config.channels - 1) & 0x0f;
    const sampleSizeCode = bitDepth === 16 ? 0x04 : 0x06;
    const frameNumberBytes = encodeFlacUtf8Number(this.flacFrameIndex++);

    const headerWithoutCrc = concatUint8Arrays([
      new Uint8Array([
        0xff,
        0xf8, // sync 0x3FFE + reserved 0 + fixed block strategy 0
        (blockSizeCode << 4) | srCode,
        (chAssignment << 4) | (sampleSizeCode << 1) | 0x00,
      ]),
      frameNumberBytes,
      extraBlockBytes,
    ]);
    const crc8 = computeFlacCrc8(headerWithoutCrc);
    const frameHeader = concatUint8Arrays([headerWithoutCrc, new Uint8Array([crc8])]);

    const subframes: Uint8Array[] = [];
    for (let c = 0; c < this.config.channels; c++) {
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
        // SUBFRAME_CONSTANT (0x00)
        const sf = new Uint8Array(1 + bytesPerSample);
        sf[0] = 0x00;
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
        // SUBFRAME_VERBATIM (0x02) — lossless uncompressed samples in RFC 9639 frame
        const sf = new Uint8Array(1 + blockSize * bytesPerSample);
        sf[0] = 0x02;
        let offset = 1;
        if (bitDepth === 16) {
          for (let i = 0; i < blockSize; i++) {
            const q = quantizeSample(ch[i], 16);
            sf[offset++] = (q >>> 8) & 0xff;
            sf[offset++] = q & 0xff;
          }
        } else {
          for (let i = 0; i < blockSize; i++) {
            const q = quantizeSample(ch[i], 24);
            sf[offset++] = (q >>> 16) & 0xff;
            sf[offset++] = (q >>> 8) & 0xff;
            sf[offset++] = q & 0xff;
          }
        }
        subframes.push(sf);
      }
    }

    const frameWithoutCrc16 = concatUint8Arrays([frameHeader, ...subframes]);
    const crc16 = computeFlacCrc16(frameWithoutCrc16);
    return concatUint8Arrays([
      frameWithoutCrc16,
      new Uint8Array([(crc16 >>> 8) & 0xff, crc16 & 0xff]),
    ]);
  }
}

/**
 * Convenience helper to assemble emitted stream chunks + header patches
 * when writing into an in-memory buffer or Blob (for short/medium files or tests).
 * Large 2-hour exports should write emitted chunks incrementally to OPFS/FileSystemWritableFileStream
 * and apply `headerPatches` via seek/write at offsets.
 */
export async function exportPcmToCompleteBuffer(
  channels: Float32Array[],
  config: StreamingExportConfig,
  metadata: PodcastExportMetadata,
  chunkFrames = 8192,
): Promise<{ bytes: Uint8Array; report: ExportStreamFinalizeResult }> {
  const engine = new StreamingExportEncoderEngine(config, metadata);
  const parts: Uint8Array[] = [];
  parts.push(...(await engine.start()));

  const totalFrames = channels[0]?.length ?? 0;
  const safeChunkFrames =
    Number.isFinite(chunkFrames) && chunkFrames > 0 ? Math.floor(chunkFrames) : 8192;
  for (let start = 0; start < totalFrames; start += safeChunkFrames) {
    const end = Math.min(totalFrames, start + safeChunkFrames);
    const slice = channels.map((ch) => ch.subarray(start, end));
    parts.push(...(await engine.pushPcmChunk(slice)));
  }

  const report = await engine.finalize();
  parts.push(...report.tailChunks);

  const bytes = concatUint8Arrays(parts);
  for (const patch of report.headerPatches) {
    bytes.set(patch.bytes, patch.offset);
  }

  return { bytes, report };
}

// ============================================================================
// Web Worker Message Protocol Bridge (Active when executed as a Dedicated Worker)
// ============================================================================
export type StreamingExportWorkerRequest =
  | {
      type: 'START_EXPORT';
      requestId: string;
      config: Omit<StreamingExportConfig, 'mp3EncoderAdapter'>;
      metadata: PodcastExportMetadata;
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

export type StreamingExportWorkerResponse =
  | {
      type: 'EXPORT_CHUNK';
      requestId: string;
      chunk: ArrayBuffer;
    }
  | {
      type: 'EXPORT_STARTED';
      requestId: string;
    }
  | {
      type: 'EXPORT_FINALIZED';
      requestId: string;
      result: ExportStreamFinalizeResult;
    }
  | {
      type: 'EXPORT_ERROR';
      requestId: string;
      error: StructuredPlatformError | { message: string };
    };

declare const WorkerGlobalScope: { prototype: object } | undefined;

const isDedicatedWorker =
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof (WorkerGlobalScope as unknown as { new (): object });

if (isDedicatedWorker) {
  const workerSessions = new Map<string, StreamingExportEncoderEngine>();
  const post = (msg: StreamingExportWorkerResponse, transfer: Transferable[] = []) => {
    (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(
      msg,
      transfer,
    );
  };

  const emitChunks = (requestId: string, chunks: Uint8Array[]) => {
    for (const chunk of chunks) {
      const copy = chunk.slice();
      post({ type: 'EXPORT_CHUNK', requestId, chunk: copy.buffer }, [copy.buffer]);
    }
  };

  (self as unknown as { onmessage: ((ev: MessageEvent<StreamingExportWorkerRequest>) => void) | null }).onmessage =
    async (event: MessageEvent<StreamingExportWorkerRequest>) => {
      const msg = event.data;
      try {
        if (msg.type === 'START_EXPORT') {
          const engine = new StreamingExportEncoderEngine(msg.config, msg.metadata);
          const initChunks = await engine.start();
          workerSessions.set(msg.requestId, engine);
          emitChunks(msg.requestId, initChunks);
          post({ type: 'EXPORT_STARTED', requestId: msg.requestId });
        } else if (msg.type === 'PUSH_PCM_CHUNK') {
          const engine = workerSessions.get(msg.requestId);
          if (!engine) throw new Error(`Export session not found: ${msg.requestId}`);
          const out = await engine.pushPcmChunk(msg.channels);
          emitChunks(msg.requestId, out);
        } else if (msg.type === 'FINALIZE_EXPORT') {
          const engine = workerSessions.get(msg.requestId);
          if (!engine) throw new Error(`Export session not found: ${msg.requestId}`);
          const result = await engine.finalize();
          workerSessions.delete(msg.requestId);
          post({ type: 'EXPORT_FINALIZED', requestId: msg.requestId, result });
        } else if (msg.type === 'ABORT_EXPORT') {
          workerSessions.delete(msg.requestId);
        }
      } catch (err) {
        const structured =
          typeof err === 'object' && err !== null && 'code' in err && 'userMessageFa' in err
            ? (err as StructuredPlatformError)
            : { message: err instanceof Error ? err.message : String(err) };
        post({ type: 'EXPORT_ERROR', requestId: msg.requestId, error: structured });
      }
    };
}
