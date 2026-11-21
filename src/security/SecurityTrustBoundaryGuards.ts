/**
 * AVP-P0-006 — Security Hardening, Local Data Protection & Trust-Boundary Guards
 *
 * Implements verifiable local-only security controls across AVAPARDAZ trust boundaries:
 * 1. Symlink-aware canonical path confinement (Node runtime).
 * 2. Prototype-pollution, nesting-depth, collection-size & numeric-bounds validator for untrusted project JSON.
 * 3. Audio decoder resource & metadata hardener.
 * 4. Privacy-preserving diagnostic log sanitizer (strips Bearer/HMAC tokens, raw PCM, transcripts,
 *    absolute user paths, and log-injection control characters).
 */

export const SECURITY_GUARD_VERSION = '1.0.0' as const;

export interface SecurityValidationResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly errors: readonly string[];
}

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PROJECT_DEPTH = 24;
const MAX_COLLECTION_ITEMS = 50_000;
const MAX_STRING_LENGTH = 250_000;

/**
 * Validates an untrusted project file JSON payload before deserialization or migration.
 * Defends against prototype pollution, excessive nesting depth, NaN/Infinity values,
 * duplicate IDs, oversized strings/collections, and suspicious filesystem paths.
 */
export function validateUntrustedProjectPayload(rawPayload: unknown): SecurityValidationResult {
  const errors: string[] = [];

  if (typeof rawPayload === 'string') {
    if (rawPayload.length > 50 * 1024 * 1024) {
      return { ok: false, code: 'PROJECT_FILE_TOO_LARGE', errors: ['Project JSON exceeds 50 MiB limit.'] };
    }
    try {
      rawPayload = JSON.parse(rawPayload);
    } catch {
      return { ok: false, code: 'MALFORMED_JSON', errors: ['Project file is not valid JSON.'] };
    }
  }

  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { ok: false, code: 'INVALID_PROJECT_ROOT', errors: ['Project payload must be a JSON object.'] };
  }

  const seenNodeIds = new Set<string>();

  const walk = (node: unknown, depth: number, pathStr: string): void => {
    if (errors.length >= 25) return;
    if (depth > MAX_PROJECT_DEPTH) {
      errors.push(`MAX_DEPTH_EXCEEDED at ${pathStr} (limit=${MAX_PROJECT_DEPTH}).`);
      return;
    }
    if (typeof node === 'string') {
      if (node.length > MAX_STRING_LENGTH) {
        errors.push(`STRING_TOO_LONG at ${pathStr} (${node.length} chars).`);
      }
      if (node.includes('\0')) {
        errors.push(`NULL_BYTE_REJECTED at ${pathStr}.`);
      }
      return;
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        errors.push(`NON_FINITE_NUMBER at ${pathStr}.`);
      }
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > MAX_COLLECTION_ITEMS) {
        errors.push(`COLLECTION_TOO_LARGE at ${pathStr} (${node.length} items).`);
        return;
      }
      for (let i = 0; i < node.length; i++) {
        walk(node[i], depth + 1, `${pathStr}[${i}]`);
      }
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length > MAX_COLLECTION_ITEMS) {
        errors.push(`OBJECT_TOO_MANY_KEYS at ${pathStr} (${keys.length} keys).`);
        return;
      }
      for (const k of keys) {
        if (FORBIDDEN_PROTO_KEYS.has(k)) {
          errors.push(`PROTOTYPE_POLLUTION_KEY_REJECTED: "${k}" at ${pathStr}.`);
          continue;
        }
        const val = obj[k];
        if ((k === 'filePath' || k === 'storageDirectory') && typeof val === 'string') {
          if (/(^|[\\/])\.\.([\\/]|$)/.test(val) || val.includes('\0')) {
            errors.push(`PATH_TRAVERSAL_IN_PROJECT_FIELD: "${k}" at ${pathStr}.`);
          }
        }
        if ((k === 'segmentId' || k === 'decisionId' || k === 'suggestionId') && typeof val === 'string') {
          const scopedKey = `${k}:${val}`;
          if (seenNodeIds.has(scopedKey)) {
            errors.push(`DUPLICATE_ENTITY_ID: "${val}" at ${pathStr}.${k}.`);
          } else {
            seenNodeIds.add(scopedKey);
          }
        }
        walk(val, depth + 1, `${pathStr}.${k}`);
      }
    }
  };

  walk(rawPayload, 0, '$');

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? undefined : 'UNTRUSTED_PROJECT_VALIDATION_FAILED',
    errors,
  };
}

/**
 * Audio decoder input resource & bounds validator (`AVP-P0-006 §7`).
 */
export function validateAudioDecodeInput(params: {
  readonly fileName: string;
  readonly byteLength: number;
  readonly sampleRate?: number;
  readonly channelCount?: number;
  readonly durationSec?: number;
  readonly maxFileBytes?: number;
  readonly maxDurationSec?: number;
}): SecurityValidationResult {
  const errors: string[] = [];
  const maxBytes = params.maxFileBytes ?? 512 * 1024 * 1024; // 512 MiB default browser cap
  const maxDur = params.maxDurationSec ?? 4 * 3600; // 4 hours

  if (!params.fileName || params.fileName.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(params.fileName)) {
    errors.push('INVALID_AUDIO_FILENAME: Contains null byte or path traversal.');
  }
  if (!Number.isSafeInteger(params.byteLength) || params.byteLength <= 0) {
    errors.push(`INVALID_AUDIO_BYTE_LENGTH: ${params.byteLength}.`);
  } else if (params.byteLength > maxBytes) {
    errors.push(`AUDIO_FILE_TOO_LARGE: ${params.byteLength} B exceeds limit ${maxBytes} B.`);
  }
  if (params.sampleRate !== undefined) {
    if (!Number.isFinite(params.sampleRate) || params.sampleRate < 8000 || params.sampleRate > 384_000) {
      errors.push(`INVALID_SAMPLE_RATE: ${params.sampleRate}.`);
    }
  }
  if (params.channelCount !== undefined) {
    if (!Number.isInteger(params.channelCount) || params.channelCount < 1 || params.channelCount > 8) {
      errors.push(`INVALID_CHANNEL_COUNT: ${params.channelCount}.`);
    }
  }
  if (params.durationSec !== undefined) {
    if (!Number.isFinite(params.durationSec) || params.durationSec <= 0 || params.durationSec > maxDur) {
      errors.push(`INVALID_AUDIO_DURATION: ${params.durationSec}s (max ${maxDur}s).`);
    }
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? undefined : 'AUDIO_SECURITY_VALIDATION_FAILED',
    errors,
  };
}

/**
 * Symlink-aware canonical filesystem boundary confinement check (Node/Companion runtime).
 */
export async function assertPathWithinAllowedRoot(params: {
  readonly candidatePath: string;
  readonly allowedRootDir: string;
}): Promise<{ readonly ok: boolean; readonly realPath?: string; readonly code?: string; readonly message?: string }> {
  const { candidatePath, allowedRootDir } = params;
  if (!candidatePath || candidatePath.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(candidatePath)) {
    return {
      ok: false,
      code: 'PATH_TRAVERSAL_REJECTED',
      message: 'Candidate path contains null byte or parent-directory traversal.',
    };
  }
  const path = await import('node:path');
  const fs = await import('node:fs');

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(allowedRootDir));
  } catch {
    return { ok: false, code: 'ALLOWED_ROOT_UNAVAILABLE', message: 'Allowed root directory does not exist.' };
  }

  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(path.resolve(candidatePath));
  } catch {
    return { ok: false, code: 'FILE_NOT_FOUND', message: 'Target file does not exist or cannot be resolved.' };
  }

  const rel = path.relative(realRoot, realCandidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      code: 'SYMLINK_OR_BOUNDARY_ESCAPE_REJECTED',
      message: 'Resolved canonical path escapes allowed filesystem boundary.',
    };
  }
  return { ok: true, realPath: realCandidate };
}

const SENSITIVE_FIELD_RE = /(token|secret|authorization|bearer|signature|hmac|password|transcript|rawText|normalizedText|partialText|pcm|audioBase64|audioBytes)/i;
const BEARER_OR_HEX_SECRET_RE = /(Bearer\s+[A-Za-z0-9._\-]+|ipc_[a-f0-9]+\.\d+\.[a-f0-9]{64})/gi;
const ABS_HOME_PATH_RE = /(\/(Users|home)\/[^/\s"']+|C:\\Users\\[^\\\s"']+)/gi;

/**
 * Privacy-preserving diagnostic sanitizer (`AVP-P0-005 §12`, `AVP-P0-006 §13`).
 * Strips auth tokens, HMAC signatures, raw PCM, full transcript strings, user home paths,
 * and CRLF/control characters used for log injection.
 */
export function sanitizeDiagnosticString(input: string): string {
  return input
    .replace(BEARER_OR_HEX_SECRET_RE, '[REDACTED_CREDENTIAL]')
    .replace(ABS_HOME_PATH_RE, '[REDACTED_USER_PATH]')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .slice(0, 512);
}

export function sanitizeDiagnosticRecord(record: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (record === null || record === undefined) return record;
  if (typeof record === 'string') return sanitizeDiagnosticString(record);
  if (typeof record === 'number' || typeof record === 'boolean') return record;
  if (ArrayBuffer.isView(record) || record instanceof ArrayBuffer) {
    return `[REDACTED_BINARY_${record.byteLength}B]`;
  }
  if (Array.isArray(record)) {
    if (record.length > 64) {
      return `[REDACTED_ARRAY_LEN_${record.length}]`;
    }
    return record.map((item) => sanitizeDiagnosticRecord(item, depth + 1));
  }
  if (typeof record === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_RE.test(k)) {
        out[k] = '[REDACTED_SENSITIVE_FIELD]';
      } else {
        out[k] = sanitizeDiagnosticRecord(v, depth + 1);
      }
    }
    return out;
  }
  return String(record);
}

export function buildLocalDiagnosticExport(params: {
  readonly appVersion: string;
  readonly runtimeTarget: string;
  readonly events: readonly Record<string, unknown>[];
  readonly memoryAccountedBytes: number;
  readonly memoryHardLimitBytes: number;
}): Record<string, unknown> {
  return {
    schema: 'avapardaz.local.diagnostics.v1',
    privacyGuarantee: 'LOCAL_ONLY_NO_AUDIO_NO_TRANSCRIPT_NO_TOKENS',
    exportedAtIso: new Date().toISOString(),
    appVersion: params.appVersion,
    runtimeTarget: params.runtimeTarget,
    memory: {
      accountedBytes: params.memoryAccountedBytes,
      hardLimitBytes: params.memoryHardLimitBytes,
    },
    events: params.events.slice(-200).map((e) => sanitizeDiagnosticRecord(e)),
  };
}
