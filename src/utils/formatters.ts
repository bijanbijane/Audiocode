import type { ExportDefaultFormat } from '../settings/settingsStore';

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/**
 * Converts ASCII digits 0-9 into Eastern Arabic / Persian digits ۰-۹.
 */
export function toPersianDigits(input: string | number): string {
  const str = String(input);
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      out += PERSIAN_DIGITS[code - 48];
    } else {
      out += str[i];
    }
  }
  return out;
}

export function formatNumberForLocale(
  value: number | string,
  options?: {
    persianDigits?: boolean;
    maximumFractionDigits?: number;
  },
): string {
  if (typeof value === 'string') {
    return options?.persianDigits ? toPersianDigits(value) : value;
  }
  const safeVal = Number.isFinite(value) ? value : 0;
  const formatted =
    typeof options?.maximumFractionDigits === 'number'
      ? safeVal.toFixed(options.maximumFractionDigits)
      : String(safeVal);
  return options?.persianDigits ? toPersianDigits(formatted) : formatted;
}

/**
 * Formats timeline seconds according to user's global timecodeFormat & persianDigits preferences.
 * Supports:
 * - 'mm:ss.ms' => MM:SS.mm (e.g., 01:05.32 or 1:02:05.32 when >= 1 hour)
 * - 'hh:mm:ss' => HH:MM:SS (e.g., 00:01:05)
 */
export function formatStudioTimecode(
  seconds: number,
  format: 'mm:ss.ms' | 'hh:mm:ss' = 'mm:ss.ms',
  persianDigits = false,
): string {
  const clamped = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const centis = Math.floor((totalMs % 1000) / 10);

  let raw: string;
  if (format === 'hh:mm:ss') {
    raw = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  } else if (hours > 0) {
    raw = `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  } else {
    raw = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }

  return persianDigits ? toPersianDigits(raw) : raw;
}

/**
 * Preserves readable Unicode/Persian project titles in default export filenames while
 * removing OS-illegal path characters and applying optional filenamePrefix cleanly.
 */
export function sanitizeExportFileName(rawName: string, prefix = ''): string {
  const cleanedPrefix = prefix.replace(/[\\/:*?"<>|]/g, '').trim();
  const cleanedBase = rawName
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const fallbackBase = cleanedBase.length > 0 ? cleanedBase : 'avapardaz-export';
  const combined = cleanedPrefix ? `${cleanedPrefix}${cleanedPrefix.endsWith('-') || cleanedPrefix.endsWith('_') || cleanedPrefix.endsWith(' ') ? '' : ' '}${fallbackBase}` : fallbackBase;
  return combined.slice(0, 96);
}

/**
 * Maps SettingsCenterModal ExportDefaultFormat enum to RenderExportModal encoding & container.
 */
export function mapExportDefaultFormatToRenderConfig(format: ExportDefaultFormat): {
  encoding: 'pcm16' | 'pcm24' | 'float32';
  container: 'wav' | 'rf64';
} {
  switch (format) {
    case 'WAV_PCM24':
      return { encoding: 'pcm24', container: 'wav' };
    case 'WAV_FLOAT32':
      return { encoding: 'float32', container: 'wav' };
    case 'RF64_PCM24':
      return { encoding: 'pcm24', container: 'rf64' };
    case 'WAV_PCM16':
    default:
      return { encoding: 'pcm16', container: 'wav' };
  }
}
