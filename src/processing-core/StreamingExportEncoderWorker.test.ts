import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildId3v2Tag,
  computeFlacCrc16,
  computeFlacCrc8,
  decodeSynchsafe32,
  exportPcmToCompleteBuffer,
  Mp3FrameEncoderAdapter,
  PodcastExportMetadata,
  StreamingExportEncoderEngine,
} from './StreamingExportEncoderWorker';
import { TimeMath } from '../contracts/timebase.contract';

const utf8Decoder = new TextDecoder();

const SAMPLE_METADATA: PodcastExportMetadata = {
  title: 'اپیزود چهاردهم: آینده پردازش صوت فارسی',
  artist: 'آرش نادری',
  album: 'پادکست آواپرداز',
  year: '1405',
  genre: 'Podcast',
  comment: 'تولیدشده با موتور تدوین هوشمند آواپرداز',
  chapters: [
    // Intentionally unsorted to verify deterministic chronological sorting + Flicks conversion
    {
      id: 'chap-2',
      titleFa: 'تحلیل معماری بدون سرور و حریم خصوصی',
      startMs: 0,
      endMs: 0,
      startFlicks: TimeMath.secondsToFlicks(12.5),
      endFlicks: TimeMath.secondsToFlicks(35.0),
      speakerName: 'سارا',
    },
    {
      id: 'chap-1',
      titleFa: 'مقدمه و معرفی مبحث',
      startMs: 0,
      endMs: 12500,
    },
  ],
};

function makeStereoSineChannels(frameCount: number, freqHz: number, sampleRate: number): Float32Array[] {
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const phase = (2 * Math.PI * freqHz * i) / sampleRate;
    left[i] = 0.5 * Math.sin(phase);
    right[i] = -0.25 * Math.sin(phase);
  }
  return [left, right];
}

test('buildId3v2Tag generates valid ID3v2.4 binary header with UTF-8 Persian frames and sorted CHAP/CTOC chapters', () => {
  const { tagBytes, normalizedChapters } = buildId3v2Tag(SAMPLE_METADATA);

  assert.equal(utf8Decoder.decode(tagBytes.subarray(0, 3)), 'ID3');
  assert.equal(tagBytes[3], 0x04); // ID3v2.4
  assert.equal(tagBytes[4], 0x00);

  const declaredBodySize = decodeSynchsafe32(tagBytes, 6);
  assert.equal(declaredBodySize, tagBytes.byteLength - 10);

  assert.equal(normalizedChapters.length, 2);
  assert.equal(normalizedChapters[0].id, 'chap-1');
  assert.equal(normalizedChapters[0].startMs, 0);
  assert.equal(normalizedChapters[1].id, 'chap-2');
  assert.equal(normalizedChapters[1].startMs, 12500);
  assert.equal(normalizedChapters[1].endMs, 35000);

  // Walk ID3v2.4 frames and verify TIT2, CTOC, and CHAP contents
  const frameIds: string[] = [];
  const chapTitles: string[] = [];
  const chapTimings: Array<[number, number]> = [];
  let cursor = 10;

  while (cursor + 10 <= tagBytes.byteLength) {
    const id = utf8Decoder.decode(tagBytes.subarray(cursor, cursor + 4));
    const size = decodeSynchsafe32(tagBytes, cursor + 4);
    const payload = tagBytes.subarray(cursor + 10, cursor + 10 + size);
    frameIds.push(id);

    if (id === 'TIT2') {
      assert.equal(payload[0], 0x03); // UTF-8
      assert.equal(utf8Decoder.decode(payload.subarray(1)), SAMPLE_METADATA.title);
    } else if (id === 'CHAP') {
      const nulIdx = payload.indexOf(0);
      assert.ok(nulIdx > 0);
      const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const startMs = pv.getUint32(nulIdx + 1, false);
      const endMs = pv.getUint32(nulIdx + 5, false);
      chapTimings.push([startMs, endMs]);
      // Subframe TIT2 starts at nulIdx + 17
      const subId = utf8Decoder.decode(payload.subarray(nulIdx + 17, nulIdx + 21));
      assert.equal(subId, 'TIT2');
      const subSize = decodeSynchsafe32(payload, nulIdx + 21);
      const subPayload = payload.subarray(nulIdx + 27, nulIdx + 27 + subSize);
      assert.equal(subPayload[0], 0x03);
      chapTitles.push(utf8Decoder.decode(subPayload.subarray(1)));
    }

    cursor += 10 + size;
  }

  assert.equal(cursor, tagBytes.byteLength);
  assert.ok(frameIds.includes('TIT2'));
  assert.ok(frameIds.includes('TPE1'));
  assert.ok(frameIds.includes('COMM'));
  assert.ok(frameIds.includes('CTOC'));
  assert.deepEqual(chapTimings, [
    [0, 12500],
    [12500, 35000],
  ]);
  assert.deepEqual(chapTitles, [
    'مقدمه و معرفی مبحث',
    'تحلیل معماری بدون سرور و حریم خصوصی — سارا',
  ]);
});

test('Streaming WAV encoder produces valid 16-bit, 24-bit, and 32-bit Float files with RIFF id3 chunk', async () => {
  const channels = makeStereoSineChannels(12000, 440, 48000);

  for (const bitDepth of [16, 24, 32] as const) {
    const { bytes, report } = await exportPcmToCompleteBuffer(
      channels,
      { format: 'WAV', sampleRate: 48000, channels: 2, wavBitDepth: bitDepth },
      SAMPLE_METADATA,
      3500,
    );

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(utf8Decoder.decode(bytes.subarray(0, 4)), 'RIFF');
    assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
    assert.equal(utf8Decoder.decode(bytes.subarray(8, 12)), 'WAVE');
    assert.equal(utf8Decoder.decode(bytes.subarray(12, 16)), 'fmt ');

    const expectedFormatCode = bitDepth === 32 ? 3 : 1;
    assert.equal(view.getUint16(20, true), expectedFormatCode);
    assert.equal(view.getUint16(22, true), 2);
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(view.getUint16(34, true), bitDepth);

    const expectedDataBytes = 12000 * 2 * (bitDepth / 8);
    assert.equal(utf8Decoder.decode(bytes.subarray(36, 40)), 'data');
    assert.equal(view.getUint32(40, true), expectedDataBytes);

    // Trailing RIFF 'id3 ' chunk immediately after PCM data
    const id3Offset = 44 + expectedDataBytes;
    assert.equal(utf8Decoder.decode(bytes.subarray(id3Offset, id3Offset + 4)), 'id3 ');
    const id3DeclaredLen = view.getUint32(id3Offset + 4, true);
    assert.equal(id3DeclaredLen, report.id3TagSizeBytes);
    assert.equal(utf8Decoder.decode(bytes.subarray(id3Offset + 8, id3Offset + 11)), 'ID3');
    assert.equal(report.totalFramesWritten, 12000);
    assert.equal(report.embeddedChapterCount, 2);
  }
});

test('Streaming FLAC encoder emits valid fLaC STREAMINFO, Vorbis Persian chapters, CRC-8/16 frames, and constant-subframe silence compression', async () => {
  const silence = [new Float32Array(4096), new Float32Array(4096)];
  const sine = makeStereoSineChannels(5000, 1000, 48000);
  const fullLeft = new Float32Array(silence[0].length + sine[0].length);
  const fullRight = new Float32Array(silence[1].length + sine[1].length);
  fullLeft.set(silence[0], 0);
  fullLeft.set(sine[0], silence[0].length);
  fullRight.set(silence[1], 0);
  fullRight.set(sine[1], silence[1].length);

  const { bytes, report } = await exportPcmToCompleteBuffer(
    [fullLeft, fullRight],
    { format: 'FLAC', sampleRate: 48000, channels: 2, flacBitDepth: 16, flacBlockSize: 4096 },
    SAMPLE_METADATA,
    3000,
  );

  assert.equal(utf8Decoder.decode(bytes.subarray(0, 4)), 'fLaC');
  assert.equal(report.totalFramesWritten, 9096);
  assert.equal(report.embeddedChapterCount, 2);

  // STREAMINFO block (offset 4, len 4 + 34 = 38)
  assert.equal(bytes[4], 0x00); // not last, type 0
  const siLen = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  assert.equal(siLen, 34);

  // Extract packed totalSamples (36 bits across bytes[21] low nibble + bytes[22..25])
  const si = bytes.subarray(8, 42);
  const decodedRate = (si[10] << 12) | (si[11] << 4) | (si[12] >>> 4);
  const decodedChannels = ((si[12] >>> 1) & 0x07) + 1;
  const decodedBps = (((si[12] & 0x01) << 4) | (si[13] >>> 4)) + 1;
  const decodedTotalSamples =
    ((si[13] & 0x0f) * 2 ** 32) +
    ((si[14] << 24) >>> 0) +
    (si[15] << 16) +
    (si[16] << 8) +
    si[17];

  assert.equal(decodedRate, 48000);
  assert.equal(decodedChannels, 2);
  assert.equal(decodedBps, 16);
  assert.equal(decodedTotalSamples, 9096);

  // VORBIS_COMMENT block (offset 42)
  assert.equal(bytes[42], 0x84); // last block | type 4
  const vcLen = (bytes[43] << 16) | (bytes[44] << 8) | bytes[45];
  const vcPayloadText = utf8Decoder.decode(bytes.subarray(46, 46 + vcLen));
  assert.ok(vcPayloadText.includes(`TITLE=${SAMPLE_METADATA.title}`));
  assert.ok(vcPayloadText.includes('CHAPTER001=00:00:00.000'));
  assert.ok(vcPayloadText.includes('CHAPTER001NAME=مقدمه و معرفی مبحث'));
  assert.ok(vcPayloadText.includes('CHAPTER002=00:00:12.500'));
  assert.ok(vcPayloadText.includes('CHAPTER002NAME=تحلیل معماری بدون سرور و حریم خصوصی — سارا'));

  // Audio frames start at offset 46 + vcLen
  const framesStart = 46 + vcLen;
  // Frame 0: 4096 samples of digital silence -> SUBFRAME_CONSTANT (tiny frame!)
  assert.equal(bytes[framesStart], 0xff);
  assert.equal(bytes[framesStart + 1], 0xf8);
  // Header is 5 bytes (2 sync/meta + 1 block/sr + 1 ch/bps + 1 frameIdx=0) + 1 byte CRC-8
  const frame0HeaderWithoutCrc = bytes.subarray(framesStart, framesStart + 5);
  assert.equal(bytes[framesStart + 5], computeFlacCrc8(frame0HeaderWithoutCrc));
  // Constant subframes for stereo 16-bit: 2 * (1 byte header 0x00 + 2 bytes sample) = 6 bytes
  assert.equal(bytes[framesStart + 6], 0x00); // Ch0 SUBFRAME_CONSTANT
  assert.equal(bytes[framesStart + 9], 0x00); // Ch1 SUBFRAME_CONSTANT
  const frame0BodyEnd = framesStart + 6 + 6;
  const expectedFrame0Crc16 = computeFlacCrc16(bytes.subarray(framesStart, frame0BodyEnd));
  const actualFrame0Crc16 = (bytes[frame0BodyEnd] << 8) | bytes[frame0BodyEnd + 1];
  assert.equal(actualFrame0Crc16, expectedFrame0Crc16);

  // Frame 1 starts at frame0BodyEnd + 2: 4096 samples of sine wave -> SUBFRAME_VERBATIM (0x02)
  const frame1Start = frame0BodyEnd + 2;
  assert.equal(bytes[frame1Start], 0xff);
  assert.equal(bytes[frame1Start + 1], 0xf8);
  const frame1HeaderWithoutCrc = bytes.subarray(frame1Start, frame1Start + 5);
  assert.equal(bytes[frame1Start + 5], computeFlacCrc8(frame1HeaderWithoutCrc));
  assert.equal(bytes[frame1Start + 6], 0x02); // Ch0 SUBFRAME_VERBATIM
});

test('Streaming MP3 pipeline rejects honestly when no codec adapter is supplied and prepends ID3v2.4 when adapter is present', async () => {
  const noAdapterEngine = new StreamingExportEncoderEngine(
    { format: 'MP3', sampleRate: 48000, channels: 2 },
    SAMPLE_METADATA,
  );
  await assert.rejects(() => noAdapterEngine.start(), (err: unknown) => {
    const structured = err as { code?: string; category?: string };
    return structured.code === 'ERR_EXPORT_CODEC_UNAVAILABLE' && structured.category === 'EXPORT_ERROR';
  });

  let initializedBitrate = 0;
  let encodedFrames = 0;
  const mockMp3Adapter: Mp3FrameEncoderAdapter = {
    init(cfg) {
      initializedBitrate = cfg.bitrateKbps;
    },
    encodeChunk(channels) {
      encodedFrames += channels[0].length;
      // Synthetic MPEG-1 Layer III frame header sync (0xFF 0xFB) marker
      return new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    },
    flush() {
      return new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    },
  };

  const channels = makeStereoSineChannels(4096, 440, 48000);
  const { bytes, report } = await exportPcmToCompleteBuffer(
    channels,
    {
      format: 'MP3',
      sampleRate: 48000,
      channels: 2,
      mp3BitrateKbps: 256,
      mp3EncoderAdapter: mockMp3Adapter,
    },
    SAMPLE_METADATA,
    2048,
  );

  assert.equal(initializedBitrate, 256);
  assert.equal(encodedFrames, 4096);
  assert.equal(utf8Decoder.decode(bytes.subarray(0, 3)), 'ID3');
  assert.equal(report.embeddedChapterCount, 2);
  // Immediately after ID3v2 tag, MP3 frame sync bytes begin cleanly
  assert.equal(bytes[report.id3TagSizeBytes], 0xff);
  assert.equal(bytes[report.id3TagSizeBytes + 1], 0xfb);
});
