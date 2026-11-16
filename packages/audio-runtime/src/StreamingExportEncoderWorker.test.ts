import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlobLinkedChunkedExportSink,
  buildPodcastId3v2Tag,
  computeFlacCrc16,
  computeFlacCrc8,
  decodeSynchsafe32,
  Mp3FrameEncoderAdapter,
  OpfsChunkedExportSink,
  PodcastMetadata,
  StreamingExportCodecError,
  StreamingExportSession,
} from './StreamingExportEncoderWorker';

const utf8Decoder = new TextDecoder();

const PODCAST_META: PodcastMetadata = {
  title: 'پادکست فناوری آوا — قسمت ۱۲',
  artist: 'مهسا کریمی',
  album: 'گفتگوهای مهندسی صدا',
  year: '1405',
  genre: 'Podcast',
  comment: 'خروجی جریانی استاندارد با متادیتای فصل‌ها',
  chapters: [
    {
      id: 'c2',
      titleFa: 'جمع‌بندی و پرسش و پاسخ',
      startMs: 25000,
      endMs: 42000,
      speakerName: 'امیر',
    },
    {
      id: 'c1',
      titleFa: 'آشنایی با ذخیره‌سازی OPFS',
      startMs: 0,
      endMs: 25000,
    },
  ],
};

function makeStereoSine(frames: number, freq: number, sampleRate: number): Float32Array[] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = (2 * Math.PI * freq * i) / sampleRate;
    l[i] = 0.4 * Math.sin(t);
    r[i] = -0.3 * Math.sin(t);
  }
  return [l, r];
}

function createVirtualOpfsProvider() {
  const files = new Map<string, Uint8Array>();
  let flushedCount = 0;
  let closedCount = 0;
  const removedFiles: string[] = [];

  const dirProvider = async () => ({
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new Error(`File not found: ${name}`);
        files.set(name, new Uint8Array(0));
      }
      return {
        async createSyncAccessHandle() {
          return {
            truncate(newSize: number) {
              const cur = files.get(name) ?? new Uint8Array(0);
              const next = new Uint8Array(newSize);
              next.set(cur.subarray(0, Math.min(cur.length, newSize)));
              files.set(name, next);
            },
            write(buffer: ArrayBufferView | ArrayBuffer, opts?: { at?: number }) {
              const src =
                buffer instanceof ArrayBuffer
                  ? new Uint8Array(buffer)
                  : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
              const at = opts?.at ?? 0;
              const cur = files.get(name) ?? new Uint8Array(0);
              const needed = at + src.byteLength;
              if (needed > cur.byteLength) {
                const grown = new Uint8Array(needed);
                grown.set(cur);
                grown.set(src, at);
                files.set(name, grown);
              } else {
                cur.set(src, at);
              }
              return src.byteLength;
            },
            flush() {
              flushedCount++;
            },
            close() {
              closedCount++;
            },
          };
        },
        async getFile() {
          const data = files.get(name) ?? new Uint8Array(0);
          return new File([data.slice().buffer], name, { type: 'application/octet-stream' });
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
      removedFiles.push(name);
    },
  });

  return {
    dirProvider,
    getBytes(name: string) {
      return files.get(name);
    },
    getStats() {
      return { flushedCount, closedCount, removedFiles };
    },
  };
}

test('OpfsChunkedExportSink streams 24-bit WAV chunks without monolithic RAM buffer, patches RIFF header on disk, and embeds ID3v2.4 chapters', async () => {
  const virtualOpfs = createVirtualOpfsProvider();
  const opfsSink = new OpfsChunkedExportSink('podcast_ep12.wav', virtualOpfs.dirProvider);

  const session = new StreamingExportSession(
    {
      format: 'WAV',
      sampleRate: 48000,
      channels: 2,
      wavBitDepth: 24,
      sinkMode: 'CUSTOM_SINK',
      customSink: opfsSink,
    },
    PODCAST_META,
  );

  await session.start();
  const totalFrames = 12000;
  const chunkSize = 2000; // 2000 * 2ch * 3bytes = 12000 bytes max per write
  const sine = makeStereoSine(totalFrames, 440, 48000);
  for (let start = 0; start < totalFrames; start += chunkSize) {
    await session.pushPcmChunk([
      sine[0].subarray(start, start + chunkSize),
      sine[1].subarray(start, start + chunkSize),
    ]);
  }

  const report = await session.finalize();
  const stats = virtualOpfs.getStats();
  assert.equal(stats.flushedCount, 1);
  assert.equal(stats.closedCount, 1);
  assert.equal(report.sinkKind, 'OPFS');
  assert.equal(report.totalFramesWritten, totalFrames);
  assert.equal(report.embeddedChapterCount, 2);
  assert.ok(report.peakSingleWriteBytes <= 12000, 'Peak write chunk stayed bounded at O(chunkSize)');
  assert.ok(report.blob instanceof Blob);

  const diskBytes = new Uint8Array(await report.blob!.arrayBuffer());
  const view = new DataView(diskBytes.buffer);
  assert.equal(utf8Decoder.decode(diskBytes.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), diskBytes.byteLength - 8);
  assert.equal(view.getUint16(34, true), 24);
  const expectedDataBytes = totalFrames * 2 * 3;
  assert.equal(view.getUint32(40, true), expectedDataBytes);

  const id3ChunkStart = 44 + expectedDataBytes;
  assert.equal(utf8Decoder.decode(diskBytes.subarray(id3ChunkStart, id3ChunkStart + 4)), 'id3 ');
  const id3TagLen = view.getUint32(id3ChunkStart + 4, true);
  assert.equal(id3TagLen, report.id3TagSizeBytes);
  assert.equal(utf8Decoder.decode(diskBytes.subarray(id3ChunkStart + 8, id3ChunkStart + 11)), 'ID3');
});

test('OpfsChunkedExportSink abort removes incomplete temporary OPFS file cleanly', async () => {
  const virtualOpfs = createVirtualOpfsProvider();
  const opfsSink = new OpfsChunkedExportSink('aborted_export.flac', virtualOpfs.dirProvider);
  const session = new StreamingExportSession(
    {
      format: 'FLAC',
      sampleRate: 48000,
      channels: 2,
      customSink: opfsSink,
    },
    PODCAST_META,
  );

  await session.start();
  await session.pushPcmChunk(makeStereoSine(1024, 300, 48000));
  await session.abort();

  assert.equal(virtualOpfs.getBytes('aborted_export.flac'), undefined);
  assert.deepEqual(virtualOpfs.getStats().removedFiles, ['aborted_export.flac']);
});

test('BlobLinkedChunkedExportSink patches across chunk boundaries and streams valid RFC 9639 FLAC with Persian Vorbis chapters', async () => {
  // Verify cross-chunk patching directly on BlobLinkedChunkedExportSink
  const sink = new BlobLinkedChunkedExportSink();
  await sink.open();
  await sink.append(new Uint8Array([1, 2, 3]));
  await sink.append(new Uint8Array([4, 5, 6]));
  await sink.patchAt(2, new Uint8Array([0xaa, 0xbb]));
  const patchedBlob = (await sink.finalize('application/octet-stream', false)).blob;
  assert.deepEqual(new Uint8Array(await patchedBlob.arrayBuffer()), new Uint8Array([1, 2, 0xaa, 0xbb, 5, 6]));

  // Stream FLAC directly to BLOB sink
  const silence = [new Float32Array(4096), new Float32Array(4096)];
  const sine = makeStereoSine(4500, 880, 48000);
  const flacSession = new StreamingExportSession(
    {
      format: 'FLAC',
      sampleRate: 48000,
      channels: 2,
      flacBitDepth: 16,
      flacBlockSize: 4096,
      sinkMode: 'BLOB',
    },
    PODCAST_META,
  );

  await flacSession.start();
  await flacSession.pushPcmChunk(silence);
  await flacSession.pushPcmChunk(sine);
  const report = await flacSession.finalize();

  assert.equal(report.sinkKind, 'BLOB');
  assert.ok(report.blob instanceof Blob);
  assert.equal(report.blob!.type, 'audio/flac');
  assert.equal(report.totalFramesWritten, 8596);
  assert.equal(report.embeddedChapterCount, 2);

  const bytes = new Uint8Array(await report.blob!.arrayBuffer());
  assert.equal(utf8Decoder.decode(bytes.subarray(0, 4)), 'fLaC');

  // Verify patched STREAMINFO totalSamples = 8596
  const si = bytes.subarray(8, 42);
  const totalSamples =
    ((si[13] & 0x0f) * 2 ** 32) +
    ((si[14] << 24) >>> 0) +
    (si[15] << 16) +
    (si[16] << 8) +
    si[17];
  assert.equal(totalSamples, 8596);

  // Verify Vorbis Comment chapters
  const vcLen = (bytes[43] << 16) | (bytes[44] << 8) | bytes[45];
  const vcText = utf8Decoder.decode(bytes.subarray(46, 46 + vcLen));
  assert.ok(vcText.includes('CHAPTER001=00:00:00.000'));
  assert.ok(vcText.includes('CHAPTER001NAME=آشنایی با ذخیره‌سازی OPFS'));
  assert.ok(vcText.includes('CHAPTER002=00:00:25.000'));
  assert.ok(vcText.includes('CHAPTER002NAME=جمع‌بندی و پرسش و پاسخ — امیر'));

  // Verify Frame 0 CRC-8 + CRC-16 and SUBFRAME_CONSTANT
  const frame0 = 46 + vcLen;
  assert.equal(bytes[frame0], 0xff);
  assert.equal(bytes[frame0 + 1], 0xf8);
  assert.equal(bytes[frame0 + 5], computeFlacCrc8(bytes.subarray(frame0, frame0 + 5)));
  assert.equal(bytes[frame0 + 6], 0x00); // SUBFRAME_CONSTANT
  const frame0Crc16Offset = frame0 + 12;
  assert.equal(
    (bytes[frame0Crc16Offset] << 8) | bytes[frame0Crc16Offset + 1],
    computeFlacCrc16(bytes.subarray(frame0, frame0Crc16Offset)),
  );
});

test('MP3 streaming rejects cleanly without adapter and prepends ID3v2.4 + CHAP/CTOC frames when adapter is supplied', async () => {
  const failing = new StreamingExportSession(
    { format: 'MP3', sampleRate: 44100, channels: 2, sinkMode: 'BLOB' },
    PODCAST_META,
  );
  await assert.rejects(() => failing.start(), (err: unknown) => err instanceof StreamingExportCodecError);

  const adapter: Mp3FrameEncoderAdapter = {
    init() {},
    encodeChunk() {
      return new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    },
    flush() {
      return new Uint8Array([0xff, 0xfb, 0x90, 0x44]);
    },
  };

  const session = new StreamingExportSession(
    {
      format: 'MP3',
      sampleRate: 44100,
      channels: 2,
      mp3BitrateKbps: 192,
      mp3EncoderAdapter: adapter,
      sinkMode: 'BLOB',
    },
    PODCAST_META,
  );
  await session.start();
  await session.pushPcmChunk(makeStereoSine(2048, 440, 44100));
  const report = await session.finalize();

  assert.ok(report.blob instanceof Blob);
  assert.equal(report.blob!.type, 'audio/mpeg');
  const out = new Uint8Array(await report.blob!.arrayBuffer());
  assert.equal(utf8Decoder.decode(out.subarray(0, 3)), 'ID3');
  assert.equal(decodeSynchsafe32(out, 6), report.id3TagSizeBytes - 10);
  assert.equal(out[report.id3TagSizeBytes], 0xff);
  assert.equal(out[report.id3TagSizeBytes + 1], 0xfb);

  const { normalizedChapters } = buildPodcastId3v2Tag(PODCAST_META);
  assert.equal(normalizedChapters[0].id, 'c1');
  assert.equal(normalizedChapters[1].id, 'c2');
});
