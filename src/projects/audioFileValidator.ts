/**
 * AVAPARDAZ — Content-Based Audio File Validator (Phase 02)
 *
 * Uses real binary header inspection via AudioSecurityGuard.verifyMagicBytes.
 * Never trusts filename extensions or browser MIME types alone.
 */

import { AudioSecurityGuard, SupportedAudioContainer } from '../security/AudioSecurityGuard';

export const MAX_PROJECT_AUDIO_FILE_BYTES = 256 * 1024 * 1024; // 256 MiB browser ceiling

export type AudioValidationErrorCode =
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'INVALID_MAGIC_BYTES'
  | 'READ_FAILED';

export interface AudioFileValidationResult {
  readonly valid: boolean;
  readonly container?: SupportedAudioContainer;
  readonly fileSizeBytes: number;
  readonly errorCode?: AudioValidationErrorCode;
  readonly errorFa?: string;
  readonly errorEn?: string;
}

export function validateAudioHeaderBytes(params: {
  fileName: string;
  fileSizeBytes: number;
  headerBytes: Uint8Array;
  maxBytes?: number;
}): AudioFileValidationResult {
  const maxBytes = params.maxBytes ?? MAX_PROJECT_AUDIO_FILE_BYTES;

  if (!Number.isFinite(params.fileSizeBytes) || params.fileSizeBytes <= 0) {
    return {
      valid: false,
      fileSizeBytes: 0,
      errorCode: 'FILE_EMPTY',
      errorFa: 'فایل انتخاب‌شده خالی است (۰ بایت). لطفاً یک فایل صوتی معتبر انتخاب کنید.',
      errorEn: 'The selected file is empty (0 bytes). Please choose a valid audio file.',
    };
  }

  if (params.fileSizeBytes > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    const fileMb = (params.fileSizeBytes / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      fileSizeBytes: params.fileSizeBytes,
      errorCode: 'FILE_TOO_LARGE',
      errorFa: `حجم فایل (${fileMb} مگابایت) از سقف مجاز مرورگر (${maxMb} مگابایت) بیشتر است.`,
      errorEn: `File size (${fileMb} MB) exceeds the browser upload limit (${maxMb} MB).`,
    };
  }

  try {
    const container = AudioSecurityGuard.verifyMagicBytes(
      params.headerBytes,
      params.fileSizeBytes,
    );
    return {
      valid: true,
      container,
      fileSizeBytes: params.fileSizeBytes,
    };
  } catch {
    return {
      valid: false,
      fileSizeBytes: params.fileSizeBytes,
      errorCode: 'INVALID_MAGIC_BYTES',
      errorFa:
        'محتوای باینری فایل با هیچ فرمت صوتی مجاز (WAV، MP3، FLAC، OGG، M4A یا WebM) مطابقت ندارد. تغییر پسوند فایل پذیرفته نمی‌شود.',
      errorEn:
        'Binary file signature does not match any supported audio format (WAV, MP3, FLAC, OGG, M4A, or WebM). Renamed non-audio files are rejected.',
    };
  }
}

export async function validateBrowserAudioFile(
  file: File,
  maxBytes = MAX_PROJECT_AUDIO_FILE_BYTES,
): Promise<AudioFileValidationResult> {
  if (!file || file.size <= 0) {
    return validateAudioHeaderBytes({
      fileName: file?.name ?? '',
      fileSizeBytes: 0,
      headerBytes: new Uint8Array(0),
      maxBytes,
    });
  }

  if (file.size > maxBytes) {
    return validateAudioHeaderBytes({
      fileName: file.name,
      fileSizeBytes: file.size,
      headerBytes: new Uint8Array(0),
      maxBytes,
    });
  }

  try {
    const headerBuf = await file.slice(0, 64).arrayBuffer();
    return validateAudioHeaderBytes({
      fileName: file.name,
      fileSizeBytes: file.size,
      headerBytes: new Uint8Array(headerBuf),
      maxBytes,
    });
  } catch {
    return {
      valid: false,
      fileSizeBytes: file.size,
      errorCode: 'READ_FAILED',
      errorFa: 'خواندن فایل صوتی ممکن نشد. لطفاً دسترسی فایل را بررسی کرده و دوباره تلاش کنید.',
      errorEn: 'Unable to read the selected audio file. Check file permissions and try again.',
    };
  }
}

export function deriveDefaultProjectNameFromFile(fileName: string): string {
  const cleaned = fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'پروژه صوتی جدید';
}

export function formatAudioByteSize(bytes: number, locale: 'fa' | 'en' = 'fa'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return locale === 'fa' ? '۰ بایت' : '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} ${locale === 'fa' ? 'بایت' : 'B'}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} ${locale === 'fa' ? 'کیلوبایت' : 'KB'}`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} ${locale === 'fa' ? 'مگابایت' : 'MB'}`;
}
