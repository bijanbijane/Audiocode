import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDARD_EXPORT_PROFILES,
  StreamingWavExportEncoder,
  WavSyncAccessTarget,
} from './StreamingExportEncoder';
import { TimedPersianToken } from '../ai-engine/PersianTextNormalizer';
import { TimeMath } from '../contracts/timebase.contract';

function createMemorySyncTarget() {
  let buf = new Uint8Array(0);
  let flushed = 0;

  const target: WavSyncAccessTarget = {
    truncate(newSize: number) {
      const next = new Uint8Array(newSize);
      next.set(buf.subarray(0, Math.min(buf.length, newSize)));
      buf = next;
    },
    write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }) {
      const src =
        buffer instanceof ArrayBuffer
          ? new Uint8Array(buffer)
          : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const at = options?.at ?? 0;
      if (at + src.byteLength > buf.byteLength) {
        const grown = new Uint8Array(at + src.byteLength);
        grown.set(buf);
        buf = grown;
      }
      buf.set(src, at);
      return src.byteLength;
    },
    flush() {
      flushed++;
    },
  };

  return { target, getBuffer: () => buf, getFlushed: () => flushed };
}

test('StreamingWavExportEncoder streams 24-bit & 32-bit profiles to OPFS target with byte-0 back-patching', () => {
  for (const profile of [
    STANDARD_EXPORT_PROFILES.PODCAST_STEREO_STANDARD,
    STANDARD_EXPORT_PROFILES.PODCAST_MONO_VOICE,
    STANDARD_EXPORT_PROFILES.BROADCAST_ARCHIVE_FLOAT32,
  ]) {
    const { target, getBuffer, getFlushed } = createMemorySyncTarget();
    const encoder = new StreamingWavExportEncoder(target, profile);

    encoder.beginStreamingExport();
    const chunkFrames = 1200;
    const left = new Float32Array(chunkFrames).fill(0.25);
    const right = new Float32Array(chunkFrames).fill(-0.25);

    encoder.pushRenderedChunk([left, right]);
    encoder.pushRenderedChunk([left, right]);
    const result = encoder.finalizeStreamingExport();

    const totalFrames = chunkFrames * 2;
    const expectedDataBytes = totalFrames * profile.channelCount * (profile.bitDepth / 8);
    assert.equal(result.totalBytes, 44 + expectedDataBytes);
    assert.ok(Math.abs(result.durationSeconds - totalFrames / profile.sampleRate) < 1e-9);
    assert.equal(getFlushed(), 1);

    const out = getBuffer();
    const view = new DataView(out.buffer);
    assert.equal(String.fromCharCode(...out.subarray(0, 4)), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + expectedDataBytes);
    assert.equal(view.getUint16(20, true), profile.bitDepth === 32 ? 3 : 1);
    assert.equal(view.getUint16(22, true), profile.channelCount);
    assert.equal(view.getUint32(24, true), profile.sampleRate);
    assert.equal(view.getUint16(34, true), profile.bitDepth);
    assert.equal(view.getUint32(40, true), expectedDataBytes);
  }
});

test('TPDF dithering produces zero-mean +-1 LSB noise when enabled and exact zeros when disabled', () => {
  const { target: tOn, getBuffer: getOn } = createMemorySyncTarget();
  const encOn = new StreamingWavExportEncoder(tOn, STANDARD_EXPORT_PROFILES.PODCAST_MONO_VOICE);
  encOn.beginStreamingExport();
  encOn.pushRenderedChunk([new Float32Array(4000)]);
  encOn.finalizeStreamingExport();

  const onBytes = getOn();
  const onView = new DataView(onBytes.buffer, 44);
  let sum = 0;
  let nonZeroCount = 0;
  for (let i = 0; i < 4000; i++) {
    const s = onView.getInt16(i * 2, true);
    assert.ok(s >= -1 && s <= 1, `Silence TPDF dither exceeded +-1 LSB: ${s}`);
    sum += s;
    if (s !== 0) nonZeroCount++;
  }
  assert.ok(nonZeroCount > 200, 'Expected active TPDF dither variations');
  assert.ok(Math.abs(sum / 4000) < 0.1, 'Expected near-zero dither DC offset');

  const { target: tOff, getBuffer: getOff } = createMemorySyncTarget();
  const encOff = new StreamingWavExportEncoder(tOff, {
    ...STANDARD_EXPORT_PROFILES.PODCAST_MONO_VOICE,
    applyTpdfDither: false,
  });
  encOff.beginStreamingExport();
  encOff.pushRenderedChunk([new Float32Array(512)]);
  encOff.finalizeStreamingExport();
  const offView = new DataView(getOff().buffer, 44);
  for (let i = 0; i < 512; i++) {
    assert.equal(offView.getInt16(i * 2, true), 0);
  }
});

test('WebVTT, SRT, and Podcast Chapters export format Persian captions and handle 59.9996s rollover cleanly', () => {
  const tokens: TimedPersianToken[] = [
    {
      tokenId: 't1',
      trackId: 'track-1',
      originalText: 'سلام',
      normalizedText: 'سلام',
      displayText: 'سلام',
      range: { start: TimeMath.secondsToFlicks(0.5), end: TimeMath.secondsToFlicks(1.25) },
      confidence: 0.99,
    },
    {
      tokenId: 't2',
      trackId: 'track-1',
      originalText: 'دوستان',
      normalizedText: 'دوستان',
      displayText: 'دوستان',
      range: { start: TimeMath.secondsToFlicks(1.25), end: TimeMath.secondsToFlicks(59.9996) },
      confidence: 0.98,
    },
  ];

  const vtt = StreamingWavExportEncoder.exportSynchronizedPersianWebVtt(tokens, 8);
  assert.ok(vtt.startsWith('WEBVTT\nKind: captions\nLanguage: fa\n'));
  assert.ok(vtt.includes('00:00:00.500 --> 00:01:00.000'));
  assert.ok(vtt.includes('سلام دوستان'));

  const srt = StreamingWavExportEncoder.exportSynchronizedPersianSrt(tokens, 1);
  assert.ok(srt.includes('1\n00:00:00,500 --> 00:00:01,250\nسلام'));
  assert.ok(srt.includes('2\n00:00:01,250 --> 00:01:00,000\nدوستان'));

  const chaptersVtt = StreamingWavExportEncoder.exportPodcastChaptersWebVtt([
    { titleFa: 'بخش دوم', startSeconds: 120, endSeconds: 300 },
    { titleFa: 'مقدمه', startSeconds: 0, endSeconds: 120 },
  ]);
  assert.ok(chaptersVtt.includes('Kind: chapters'));
  assert.ok(chaptersVtt.indexOf('مقدمه') < chaptersVtt.indexOf('بخش دوم'));
});
