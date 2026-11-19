/**
 * Strict Local Diagnostic Sanitizer (AVP-P10-001 Section 2 & 12)
 * Strips audio buffers, transcripts, user edits, auth tokens, API keys, private text, and full local file paths.
 */

const FORBIDDEN_KEY_PATTERN =
  /(audio|pcm|sample|buffer|transcript|text|utterance|word|script|token|secret|apikey|api_key|authorization|password|cookie|bearer|private|content|payload|rawfile|filecontent)/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /[A-Za-z]:\\[^\s'"]+/g,
  /\/(?:Users|home|var\/folders|private\/var|Volumes|mnt\/[a-z])\/[^\s'"]+/g,
];

export function sanitizeDiagnosticString(input: string, maxLength = 320): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '<redacted>');
  }
  // Never allow multi-line transcript-like prose blocks
  out = out.replace(/[\r\n]+/g, ' ').trim();
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength - 3)}...`;
  }
  return out;
}

export function sanitizeDiagnosticMetadata(
  raw?: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== 'object') return clean;

  const entries = Object.entries(raw).slice(0, 24);
  for (const [key, value] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      clean[key] = '[REDACTED]';
      continue;
    }
    if (
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value) ||
      (typeof Blob !== 'undefined' && value instanceof Blob)
    ) {
      clean[key] = '[REDACTED_BINARY]';
      continue;
    }
    if (value === null || typeof value === 'boolean') {
      clean[key] = value;
    } else if (typeof value === 'number') {
      clean[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'string') {
      clean[key] = sanitizeDiagnosticString(value, 160);
    } else if (Array.isArray(value)) {
      clean[key] = `[Array(${value.length})]`;
    } else if (typeof value === 'object') {
      clean[key] = '[Object]';
    }
  }
  return clean;
}
