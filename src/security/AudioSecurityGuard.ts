export type SupportedAudioContainer = 'WAV' | 'MP3' | 'FLAC' | 'OGG' | 'M4A_AAC' | 'WEBM';

/**
 * Audio Input Security & Local Privacy Boundary Guard (Architecture Doc Sections 41 & 42)
 * - Enforces binary magic-byte inspection instead of trusting filename extensions.
 * - Guards against decompression bombs via decoded duration & expansion ratio caps.
 * - Scrubs local file paths and Persian transcript text from telemetry/error logs.
 */
export class AudioSecurityGuard {
  public static readonly MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB cap
  public static readonly MAX_DURATION_SECONDS = 6 * 3600; // 6 hours cap per single asset
  public static readonly MAX_DECODE_EXPANSION_RATIO = 250; // e.g., tiny crafted file claiming huge PCM output

  public static verifyMagicBytes(
    headerBytes: Uint8Array,
    fileSize: number,
  ): SupportedAudioContainer {
    if (fileSize <= 12 || headerBytes.length < 12) {
      throw new Error('SECURITY_INVALID_FILE: فایل صوتی خالی یا ناقص است.');
    }
    if (fileSize > this.MAX_FILE_SIZE_BYTES) {
      throw new Error('SECURITY_FILE_TOO_LARGE: حجم فایل از سقف مجاز (۲ گیگابایت) بیشتر است.');
    }

    // RIFF....WAVE
    if (
      headerBytes[0] === 0x52 &&
      headerBytes[1] === 0x49 &&
      headerBytes[2] === 0x46 &&
      headerBytes[3] === 0x46 &&
      headerBytes[8] === 0x57 &&
      headerBytes[9] === 0x41 &&
      headerBytes[10] === 0x56 &&
      headerBytes[11] === 0x45
    ) {
      return 'WAV';
    }

    // fLaC
    if (
      headerBytes[0] === 0x66 &&
      headerBytes[1] === 0x4c &&
      headerBytes[2] === 0x61 &&
      headerBytes[3] === 0x43
    ) {
      return 'FLAC';
    }

    // OggS
    if (
      headerBytes[0] === 0x4f &&
      headerBytes[1] === 0x67 &&
      headerBytes[2] === 0x67 &&
      headerBytes[3] === 0x53
    ) {
      return 'OGG';
    }

    // ID3 tag or MPEG ADTS/MP3 frame sync
    if (
      (headerBytes[0] === 0x49 && headerBytes[1] === 0x44 && headerBytes[2] === 0x33) ||
      (headerBytes[0] === 0xff && (headerBytes[1] & 0xe0) === 0xe0)
    ) {
      return 'MP3';
    }

    // ISO Base Media File Format (ftyp) for M4A / MP4 audio
    if (
      headerBytes[4] === 0x66 &&
      headerBytes[5] === 0x74 &&
      headerBytes[6] === 0x79 &&
      headerBytes[7] === 0x70
    ) {
      return 'M4A_AAC';
    }

    // Matroska / WebM EBML header
    if (
      headerBytes[0] === 0x1a &&
      headerBytes[1] === 0x45 &&
      headerBytes[2] === 0xdf &&
      headerBytes[3] === 0xa3
    ) {
      return 'WEBM';
    }

    throw new Error(
      'SECURITY_UNSUPPORTED_MAGIC_BYTES: امضای باینری فایل با هیچ فرمت صوتی مجاز مطابقت ندارد.',
    );
  }

  public static assertSafeDecodedDuration(
    decodedDurationSeconds: number,
    compressedFileSizeBytes?: number,
    sampleRate = 48000,
    channelCount = 1,
  ): void {
    if (!Number.isFinite(decodedDurationSeconds) || decodedDurationSeconds < 0) {
      throw new Error('SECURITY_INVALID_DURATION: مدت زمان صوت معتبر نیست.');
    }
    if (decodedDurationSeconds > this.MAX_DURATION_SECONDS) {
      throw new Error(
        `SECURITY_DECOMPRESSION_BOMB_GUARD: مدت زمان صوت دیکدشده بیش از حد مجاز (${this.MAX_DURATION_SECONDS}s) است.`,
      );
    }
    if (compressedFileSizeBytes && compressedFileSizeBytes > 0) {
      const estimatedPcmBytes = decodedDurationSeconds * sampleRate * channelCount * 4;
      const ratio = estimatedPcmBytes / compressedFileSizeBytes;
      if (ratio > this.MAX_DECODE_EXPANSION_RATIO) {
        throw new Error(
          `SECURITY_DECOMPRESSION_BOMB_GUARD: نسبت بسط فشرده‌سازی (${ratio.toFixed(0)}x) غیرمجاز است.`,
        );
      }
    }
  }

  public static sanitizeErrorForTelemetry(rawErrorMessage: unknown): string {
    const text =
      typeof rawErrorMessage === 'string'
        ? rawErrorMessage
        : rawErrorMessage instanceof Error
          ? rawErrorMessage.message
          : String(rawErrorMessage ?? '');
    return text
      .replace(/([a-zA-Z]:\\[^\s]+|\/(?:Users|home|tmp|app|var|etc|usr)\/[^\s]+)/g, '[REDACTED_PATH]')
      .replace(/[\u0600-\u06FF]+(?:\u200c[\u0600-\u06FF]+)*/g, '[REDACTED_PERSIAN_CONTENT]');
  }
}
