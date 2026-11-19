/**
 * Centralized Local-First Privacy, Network Policy & Input Hardening Guard
 * (AVP-P08-001 Sections 3, 4, 9)
 */

export const LOCAL_PRIVACY_POLICY_VERSION = '1.0.0-avp-p08' as const;

export const LOCAL_ONLY_PROTECTED_DATA_CLASSES = [
  'ORIGINAL_AUDIO',
  'DECODED_AUDIO_BUFFERS',
  'RAW_TRANSCRIPT',
  'CORRECTED_TRANSCRIPT',
  'SPEECH_EVENT_RECORDS',
  'EDL_PROPOSALS',
  'HUMAN_EDITING_DECISIONS',
  'RENDERED_AUDIO',
  'PRIVATE_EXPORT_METADATA',
] as const;

export type LocalProtectedDataClass = (typeof LOCAL_ONLY_PROTECTED_DATA_CLASSES)[number];

/** Blocked legacy or remote ASR / upload endpoints that must never be invoked by production workflow */
const BLOCKED_PRODUCTION_REMOTE_PATTERNS: readonly RegExp[] = [
  /\/api\/v1\/asr\/transcribe/i,
  /generativelanguage\.googleapis\.com/i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /api\.openai\.com/i,
  /speech\.googleapis\.com/i,
];

export interface OutboundRequestAuditRecord {
  readonly url: string;
  readonly method: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly timestampMs: number;
}

export class LocalPrivacyViolationError extends Error {
  public readonly code = 'LOCAL_PRIVACY_VIOLATION';
  public readonly url: string;

  constructor(url: string, message: string) {
    super(message);
    this.name = 'LocalPrivacyViolationError';
    this.url = url;
  }
}

export class InputHardeningError extends Error {
  public readonly code:
    | 'INVALID_FILENAME'
    | 'PAYLOAD_TOO_LARGE'
    | 'PROTOTYPE_POLLUTION_BLOCKED'
    | 'MALFORMED_JSON'
    | 'INVALID_MODEL_MANIFEST'
    | 'CHECKSUM_MISMATCH';

  constructor(code: InputHardeningError['code'], message: string) {
    super(message);
    this.name = 'InputHardeningError';
    this.code = code;
  }
}

/**
 * Evaluates whether an outbound URL is permissible in Avapardaz's Local-First production mode.
 * Only same-origin static shell/worker/WASM assets or blob:/data: URLs are allowed.
 */
export function evaluateOutboundUrlPolicy(
  rawUrl: string,
  allowedLocalOrigin?: string,
): { readonly allowed: boolean; readonly reason: string } {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Empty URL is not permitted.' };
  }

  for (const blocked of BLOCKED_PRODUCTION_REMOTE_PATTERNS) {
    if (blocked.test(trimmed)) {
      return {
        allowed: false,
        reason: `Blocked by Avapardaz Local-First Privacy Policy: remote/legacy endpoint "${trimmed}" is forbidden in production workflow.`,
      };
    }
  }

  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return { allowed: true, reason: 'In-memory local blob/data URL.' };
  }

  // Relative local static assets (exclude /api/ routes)
  if (trimmed.startsWith('/')) {
    if (/^\/api\//i.test(trimmed)) {
      return {
        allowed: false,
        reason: `Backend API route "${trimmed}" is blocked in local-first production processing.`,
      };
    }
    return { allowed: true, reason: 'Same-origin static application asset.' };
  }

  try {
    const parsed = new URL(trimmed);
    const localHost =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]';
    const matchesOrigin = allowedLocalOrigin ? parsed.origin === allowedLocalOrigin : localHost;

    if (!matchesOrigin) {
      return {
        allowed: false,
        reason: `External origin "${parsed.origin}" is forbidden in offline/local-first mode.`,
      };
    }
    if (/^\/api\//i.test(parsed.pathname)) {
      return {
        allowed: false,
        reason: `Local API endpoint "${parsed.pathname}" is forbidden for production audio/transcript processing.`,
      };
    }
    return { allowed: true, reason: 'Whitelisted local application shell/WASM asset.' };
  } catch {
    return { allowed: false, reason: `Unparseable URL "${trimmed}".` };
  }
}

/**
 * Sanitizes an export filename against path traversal, null bytes, control chars,
 * Windows reserved names, and excessive lengths.
 */
export function sanitizeExportFilename(rawName: string, fallbackExtension = 'wav'): string {
  const safeExt = fallbackExtension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'wav';
  const stripped = (rawName ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .trim();

  const withoutLeadingDots = stripped.replace(/^\.+/, '');
  const base = withoutLeadingDots.length > 0 ? withoutLeadingDots.slice(0, 120) : 'avapardaz-export';
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  const safeBase = windowsReserved.test(base) ? `file_${base}` : base;

  const lowerExt = `.${safeExt}`;
  return safeBase.toLowerCase().endsWith(lowerExt) ? safeBase : `${safeBase}${lowerExt}`;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertNoPrototypePollution(node: unknown, depth = 0): void {
  if (depth > 40) {
    throw new InputHardeningError('MALFORMED_JSON', 'JSON nesting depth exceeds safe limit (40).');
  }
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      assertNoPrototypePollution(node[i], depth + 1);
    }
    return;
  }
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new InputHardeningError(
        'PROTOTYPE_POLLUTION_BLOCKED',
        `Blocked forbidden JSON key "${key}" during hardened import.`,
      );
    }
    assertNoPrototypePollution((node as Record<string, unknown>)[key], depth + 1);
  }
}

/**
 * Safely parses untrusted JSON (imported EDLs, transcripts, project metadata, model manifests)
 * with explicit byte-size bounds and prototype-pollution blocking.
 */
export function safeParseJsonWithGuards<T = unknown>(
  rawJson: string,
  maxBytes = 5 * 1024 * 1024,
): T {
  if (typeof rawJson !== 'string') {
    throw new InputHardeningError('MALFORMED_JSON', 'Input JSON must be a string.');
  }
  const byteLen = new TextEncoder().encode(rawJson).byteLength;
  if (byteLen > maxBytes) {
    throw new InputHardeningError(
      'PAYLOAD_TOO_LARGE',
      `JSON payload (${byteLen} B) exceeds maximum permitted size (${maxBytes} B).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new InputHardeningError(
      'MALFORMED_JSON',
      `Malformed JSON input: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Raw string scan catches `"__proto__":` even before Object.keys when JSON.parse creates own property
  if (/"__proto__"\s*:|"constructor"\s*:|"prototype"\s*:/i.test(rawJson)) {
    throw new InputHardeningError(
      'PROTOTYPE_POLLUTION_BLOCKED',
      'Rejected JSON containing prototype-pollution keys (__proto__/constructor/prototype).',
    );
  }

  assertNoPrototypePollution(parsed);
  return parsed as T;
}

export interface LocalModelManifest {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly architecture: 'FASTCONFORMER_CTC' | 'WHISPER_SEQ2SEQ';
  readonly fileName: string;
  readonly expectedSha256Hex: string;
  readonly expectedByteLength: number;
}

export function validateLocalModelManifest(raw: unknown): LocalModelManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputHardeningError('INVALID_MODEL_MANIFEST', 'Model manifest must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.modelId !== 'string' ||
    obj.modelId.trim().length === 0 ||
    typeof obj.modelVersion !== 'string' ||
    obj.modelVersion.trim().length === 0 ||
    (obj.architecture !== 'FASTCONFORMER_CTC' && obj.architecture !== 'WHISPER_SEQ2SEQ') ||
    typeof obj.fileName !== 'string' ||
    !/^[a-zA-Z0-9._-]+\.onnx$/i.test(obj.fileName) ||
    typeof obj.expectedSha256Hex !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(obj.expectedSha256Hex) ||
    typeof obj.expectedByteLength !== 'number' ||
    !Number.isSafeInteger(obj.expectedByteLength) ||
    obj.expectedByteLength <= 0
  ) {
    throw new InputHardeningError(
      'INVALID_MODEL_MANIFEST',
      'Model manifest failed strict schema validation (modelId, version, .onnx filename, 64-hex SHA-256, positive byteLength required).',
    );
  }

  return {
    modelId: obj.modelId.trim(),
    modelVersion: obj.modelVersion.trim(),
    architecture: obj.architecture,
    fileName: obj.fileName,
    expectedSha256Hex: obj.expectedSha256Hex.toLowerCase(),
    expectedByteLength: obj.expectedByteLength,
  };
}

/** Computes real SHA-256 hex digest using WebCrypto for local model integrity checks */
export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  throw new InputHardeningError(
    'CHECKSUM_MISMATCH',
    'WebCrypto SHA-256 is unavailable in this runtime; refusing unverified model checksum.',
  );
}

/** Strips sensitive transcript text, audio buffers, and filenames from diagnostic telemetry logs */
export function sanitizeLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set([
    'audioBase64',
    'pcm',
    'pcmMono',
    'pcmSources',
    'transcript',
    'transcriptText',
    'rawTranscript',
    'originalText',
    'displayText',
    'relatedText',
    'text',
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (sensitiveKeys.has(key)) {
      out[key] = '[REDACTED_LOCAL_ONLY]';
    } else if (value instanceof Float32Array || value instanceof Uint8Array) {
      out[key] = `[REDACTED_BINARY_${value.byteLength}B]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
