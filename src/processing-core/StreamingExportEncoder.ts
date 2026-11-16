import { SampleRate, TimeMath } from '../contracts/timebase.contract';
import { TimedPersianToken } from '../ai-engine/PersianTextNormalizer';

export type ExportBitDepth = 16 | 24 | 32;

/**
 * Independent, versioned export profile contract (Architecture Doc Section 34)
 */
export interface ExportProfileSpec {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly nameFa: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: 1 | 2;
  readonly bitDepth: ExportBitDepth;
  readonly targetLufs: number;
  readonly truePeakCeilingDbtp: number;
  readonly applyTpdfDither: boolean;
}

export const STANDARD_EXPORT_PROFILES: Record<string, ExportProfileSpec> = {
  PODCAST_STEREO_STANDARD: {
    profileId: 'PODCAST_STEREO_STANDARD',
    profileVersion: 1,
    nameFa: 'استاندارد پادکست استریو (-16 LUFS / 48kHz / 24-bit)',
    sampleRate: 48000,
    channelCount: 2,
    bitDepth: 24,
    targetLufs: -16.0,
    truePeakCeilingDbtp: -1.0,
    applyTpdfDither: true,
  },
  PODCAST_MONO_VOICE: {
    profileId: 'PODCAST_MONO_VOICE',
    profileVersion: 1,
    nameFa: 'استاندارد گفتار مونو و کتاب صوتی (-19 LUFS / 44.1kHz / 16-bit)',
    sampleRate: 44100,
    channelCount: 1,
    bitDepth: 16,
    targetLufs: -19.0,
    truePeakCeilingDbtp: -1.0,
    applyTpdfDither: true,
  },
  BROADCAST_ARCHIVE_FLOAT32: {
    profileId: 'BROADCAST_ARCHIVE_FLOAT32',
    profileVersion: 1,
    nameFa: 'آرشیو استودیویی بدون افت (32-bit Float / 48kHz)',
    sampleRate: 48000,
    channelCount: 2,
    bitDepth: 32,
    targetLufs: -16.0,
    truePeakCeilingDbtp: -0.5,
    applyTpdfDither: false,
  },
};

/**
 * Structural interface matching OPFS FileSystemSyncAccessHandle for zero-RAM disk streaming.
 */
export interface WavSyncAccessTarget {
  truncate(newSize: number): void;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  flush(): void;
}

export interface PodcastChapterEntry {
  readonly titleFa: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * Streaming WAV encoder with TPDF dithering and OPFS random-access header back-patching.
 * Keeps peak JS heap usage O(chunkSize) (< 4 MB even for 3-hour exports).
 */
export class StreamingWavExportEncoder {
  private totalDataBytesWritten = 0;
  private totalFramesWritten = 0;
  private scratchChunkBuffer = new Uint8Array(0);

  constructor(
    private readonly syncHandle: WavSyncAccessTarget,
    private readonly profile: ExportProfileSpec,
  ) {}

  /**
   * 1. Initializes the OPFS target with a 44-byte placeholder RIFF/WAVE header at byte 0.
   */
  public beginStreamingExport(): void {
    this.totalDataBytesWritten = 0;
    this.totalFramesWritten = 0;
    this.syncHandle.truncate(0);
    const placeholderHeader = this.buildWavHeader(0);
    this.syncHandle.write(placeholderHeader, { at: 0 });
  }

  /**
   * 2. Encodes and streams a single audio chunk directly to disk, interleaving channels
   * and applying 2-LSB peak-to-peak TPDF dither when quantizing 32-bit float to 16/24-bit PCM.
   */
  public pushRenderedChunk(channels: Float32Array[]): void {
    const chCount = this.profile.channelCount;
    const frameCount = channels[0]?.length ?? 0;
    if (frameCount === 0) return;

    const bytesPerSample = this.profile.bitDepth / 8;
    const chunkByteLength = frameCount * chCount * bytesPerSample;

    if (this.scratchChunkBuffer.byteLength < chunkByteLength) {
      this.scratchChunkBuffer = new Uint8Array(chunkByteLength);
    }
    const outSlice = this.scratchChunkBuffer.subarray(0, chunkByteLength);
    const view = new DataView(outSlice.buffer, outSlice.byteOffset, outSlice.byteLength);

    let byteOffset = 0;
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < chCount; c++) {
        const srcCh = channels[Math.min(c, channels.length - 1)];
        const raw = Number.isFinite(srcCh[i]) ? srcCh[i] : 0;
        const sample = Math.max(-1.0, Math.min(1.0, raw));

        if (this.profile.bitDepth === 32) {
          view.setFloat32(byteOffset, sample, true);
          byteOffset += 4;
        } else if (this.profile.bitDepth === 24) {
          // 2-LSB peak-to-peak TPDF dither eliminates harmonic quantization distortion on room tone
          const dither = this.profile.applyTpdfDither ? Math.random() - Math.random() : 0;
          const scaled = Math.round(sample * 8388607.0 + dither);
          const clamped = Math.max(-8388608, Math.min(8388607, scaled));
          view.setUint8(byteOffset, clamped & 0xff);
          view.setUint8(byteOffset + 1, (clamped >> 8) & 0xff);
          view.setUint8(byteOffset + 2, (clamped >> 16) & 0xff);
          byteOffset += 3;
        } else {
          const dither = this.profile.applyTpdfDither ? Math.random() - Math.random() : 0;
          const scaled = Math.round(sample * 32767.0 + dither);
          const clamped = Math.max(-32768, Math.min(32767, scaled));
          view.setInt16(byteOffset, clamped, true);
          byteOffset += 2;
        }
      }
    }

    this.syncHandle.write(outSlice, {
      at: 44 + this.totalDataBytesWritten,
    });
    this.totalDataBytesWritten += chunkByteLength;
    this.totalFramesWritten += frameCount;
  }

  /**
   * 3. Back-patches byte 0..43 with exact RIFF & data chunk lengths and flushes to OPFS.
   */
  public finalizeStreamingExport(): { totalBytes: number; durationSeconds: number } {
    const finalHeader = this.buildWavHeader(this.totalDataBytesWritten);
    this.syncHandle.write(finalHeader, { at: 0 });
    this.syncHandle.flush();

    return {
      totalBytes: 44 + this.totalDataBytesWritten,
      durationSeconds: this.totalFramesWritten / this.profile.sampleRate,
    };
  }

  private buildWavHeader(dataByteLength: number): Uint8Array {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const bytesPerSample = this.profile.bitDepth / 8;
    const blockAlign = this.profile.channelCount * bytesPerSample;
    const byteRate = this.profile.sampleRate * blockAlign;
    const formatCode = this.profile.bitDepth === 32 ? 3 : 1;

    this.writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataByteLength, true);
    this.writeAscii(view, 8, 'WAVE');
    this.writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, formatCode, true);
    view.setUint16(22, this.profile.channelCount, true);
    view.setUint32(24, this.profile.sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, this.profile.bitDepth, true);
    this.writeAscii(view, 36, 'data');
    view.setUint32(40, dataByteLength, true);

    return new Uint8Array(header);
  }

  private writeAscii(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /**
   * 4a. Exports synchronized word-grouped Persian captions in WebVTT format.
   */
  public static exportSynchronizedPersianWebVtt(
    tokens: readonly TimedPersianToken[],
    maxWordsPerCaption = 8,
  ): string {
    const lines: string[] = ['WEBVTT', 'Kind: captions', 'Language: fa', ''];
    for (let i = 0; i < tokens.length; i += maxWordsPerCaption) {
      const group = tokens.slice(i, i + maxWordsPerCaption);
      if (group.length === 0) continue;

      const startSec = TimeMath.flicksToSeconds(group[0].range.start);
      const endSec = TimeMath.flicksToSeconds(group[group.length - 1].range.end);
      const text = group.map((t) => t.displayText).join(' ');

      lines.push(`${this.formatTimestamp(startSec, '.')} --> ${this.formatTimestamp(endSec, '.')}`);
      lines.push(text);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 4b. Exports synchronized word-grouped Persian captions in SubRip (.srt) format.
   */
  public static exportSynchronizedPersianSrt(
    tokens: readonly TimedPersianToken[],
    maxWordsPerCaption = 8,
  ): string {
    const lines: string[] = [];
    let cueIndex = 1;
    for (let i = 0; i < tokens.length; i += maxWordsPerCaption) {
      const group = tokens.slice(i, i + maxWordsPerCaption);
      if (group.length === 0) continue;

      const startSec = TimeMath.flicksToSeconds(group[0].range.start);
      const endSec = TimeMath.flicksToSeconds(group[group.length - 1].range.end);
      const text = group.map((t) => t.displayText).join(' ');

      lines.push(String(cueIndex++));
      lines.push(`${this.formatTimestamp(startSec, ',')} --> ${this.formatTimestamp(endSec, ',')}`);
      lines.push(text);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 4c. Exports podcast chapter markers as a WebVTT Chapters track (`Kind: chapters`).
   */
  public static exportPodcastChaptersWebVtt(chapters: readonly PodcastChapterEntry[]): string {
    const sorted = [...chapters].sort((a, b) => a.startSeconds - b.startSeconds);
    const lines: string[] = ['WEBVTT', 'Kind: chapters', 'Language: fa', ''];
    for (let i = 0; i < sorted.length; i++) {
      const ch = sorted[i];
      lines.push(`Chapter ${i + 1}`);
      lines.push(
        `${this.formatTimestamp(ch.startSeconds, '.')} --> ${this.formatTimestamp(ch.endSeconds, '.')}`,
      );
      lines.push(ch.titleFa);
      lines.push('');
    }
    return lines.join('\n');
  }

  private static formatTimestamp(seconds: number, msSeparator: '.' | ','): string {
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const hrs = Math.floor(totalMs / 3_600_000);
    const mins = Math.floor((totalMs % 3_600_000) / 60_000);
    const secs = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}${msSeparator}${String(ms).padStart(3, '0')}`;
  }
}
