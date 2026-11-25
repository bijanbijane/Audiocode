/**
 * AVAPARDAZ — LOCAL SHAHAB ZIPFORMER HTTP CLIENT (BROWSER-SAFE)
 *
 * Connects the Studio UI (`src/App.tsx`) to the real local SHAHAB Zipformer-Transducer
 * runtime running on the local Avapardaz server (`/api/shahab/*`), with zero cloud calls.
 *
 * Hardening:
 * - Strictly validates JSON / audio Content-Type before parsing so reverse-proxy HTML
 *   pages (e.g. `/warmup.html` during server restarts or auth cookie checks) NEVER crash
 *   the UI with `Unexpected token '<', "<!doctype "... is not valid JSON`.
 * - Automatically retries transient server warmup responses with bounded backoff.
 * - Splits long tracks (>24s) into compact 16 kHz mono WAV chunks (<800 KB each) so
 *   requests never hit reverse-proxy body limits (32 MiB) or read timeouts (300s).
 */

import type { PersianWordToken } from '../contracts/v1_2';
import { resampleTo16kMono } from '../engine/resampler';
import { msToFlicks, secondsToFlicks } from '../engine/timebase';
import {
  DEFAULT_SHAHAB_CHUNK_SEC,
  DEFAULT_SHAHAB_OVERLAP_SEC,
  mergeChunkedTranscriptWords,
  planAudioChunks,
  type ChunkWordBucket,
} from './ShahabChunkMerger';
import { normalizeCanonicalPersianUtterance } from '../shahab/core/ShahabCorePersianNormalizer';

export interface ShahabLocalRuntimeStatusResponse {
  readonly available: boolean;
  readonly modelLoaded: boolean;
  readonly engine: 'SHAHAB_ZIPFORMER_TRANSDUCER';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly upstreamModelId: string;
  readonly runtime: 'shahab-zipformer-onnx-cpu';
  readonly offlineOnlyEnforced: true;
  readonly missingFiles: readonly string[];
  readonly integrityError?: string | null;
  readonly sampleAudioAvailable: boolean;
  readonly activeJobCount: number;
  readonly queuedJobCount?: number;
  readonly maxPendingJobs?: number;
  readonly lastMetrics: {
    readonly durationSec: number;
    readonly processingTimeMs: number;
    readonly realTimeFactor: number;
    readonly tokenCount: number;
    readonly rssAfterMb?: number;
    readonly peakRssMb?: number;
  } | null;
}

export interface ShahabServerTranscriptToken {
  readonly tokenId: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence: number | null;
  readonly timestampGranularity: 'WORD' | 'SEGMENT_ESTIMATED';
}

export interface ShahabServerTranscribeResponse {
  readonly ok: boolean;
  readonly transcript: {
    readonly schemaVersion: 'avp.transcript.v1';
    readonly transcriptVersion: string;
    readonly sourceAudioId: string;
    readonly sourceAudioHash: string;
    readonly sampleRate: number;
    readonly totalSourceSamples: number;
    readonly language: 'fa' | 'en' | 'fa-en';
    readonly modelId: string;
    readonly modelVersion: string;
    readonly runtime: string;
    readonly rawText: string;
    readonly normalizedText: string;
    readonly tokens: readonly ShahabServerTranscriptToken[];
    readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'TOKEN' | 'NONE';
    readonly realTimeFactor: number;
    readonly processingTimeMs: number;
    readonly offlineVerified: true;
  };
  readonly metrics: {
    readonly modelId: string;
    readonly upstreamModelId: string;
    readonly runtime: string;
    readonly durationSec: number;
    readonly processingTimeMs: number;
    readonly realTimeFactor: number;
    readonly tokenCount: number;
    readonly offlineVerified: true;
  };
}

function isJsonContentType(contentType: string | null): boolean {
  return Boolean(contentType && contentType.toLowerCase().includes('application/json'));
}

function isHtmlPayload(contentType: string | null, previewText: string): boolean {
  const ct = (contentType ?? '').toLowerCase();
  const trimmed = previewText.trimStart().toLowerCase();
  return ct.includes('text/html') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('عملیات توسط کاربر لغو شد.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('عملیات توسط کاربر لغو شد.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parses a JSON response safely, distinguishing proxy HTML warmup/auth pages and
 * transient proxy/queue errors (502/503/504/429) from terminal JSON errors.
 */
export async function parseShahabJsonResponse<T>(
  res: Response,
  fallbackErrorFa: string,
): Promise<
  | { readonly kind: 'JSON'; readonly data: T }
  | { readonly kind: 'RETRYABLE_HTML'; readonly preview: string }
  | { readonly kind: 'RETRYABLE_TRANSIENT'; readonly status: number; readonly message: string }
  | { readonly kind: 'ERROR'; readonly message: string }
> {
  const contentType = res.headers.get('content-type');
  const rawText = await res.text();

  if (isHtmlPayload(contentType, rawText)) {
    const lower = rawText.toLowerCase();
    const isWarmup = lower.includes('starting server') || lower.includes('warmup');
    if (isWarmup || res.status === 502 || res.status === 503 || res.status === 504 || res.ok) {
      return { kind: 'RETRYABLE_HTML', preview: rawText.slice(0, 120) };
    }
    return {
      kind: 'ERROR',
      message:
        'سرور محلی شهاب به جای پاسخ JSON صفحه HTML برگرداند. لطفاً صفحه را یک بار تازه (Refresh) کنید و دوباره تلاش کنید.',
    };
  }

  let parsed: unknown = null;
  if (rawText.trim().length > 0 && (isJsonContentType(contentType) || rawText.trimStart().startsWith('{'))) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        return {
          kind: 'RETRYABLE_TRANSIENT',
          status: res.status,
          message: `سرویس محلی شهاب موقتاً در دسترس نیست (HTTP ${res.status}).`,
        };
      }
      return {
        kind: 'ERROR',
        message: `${fallbackErrorFa} (پاسخ نامعتبر از سرور محلی دریافت شد).`,
      };
    }
  }

  if (!res.ok) {
    const errObj = parsed as { message?: string; error?: string } | null;
    if (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) {
      return {
        kind: 'RETRYABLE_TRANSIENT',
        status: res.status,
        message:
          errObj?.message ||
          (res.status === 429
            ? 'صف پردازش موتور شهاب موقتاً تکمیل است؛ در حال تلاش مجدد...'
            : `سرویس محلی شهاب موقتاً در دسترس نیست (HTTP ${res.status}).`),
      };
    }
    if (res.status === 413) {
      return {
        kind: 'ERROR',
        message:
          errObj?.message ||
          'حجم یا مدت‌زمان بسته صوتی از سقف مجاز سرور بیشتر است. لطفاً فایل کوتاه‌تر ارسال کنید یا فایل را تقسیم کنید.',
      };
    }
    return {
      kind: 'ERROR',
      message: errObj?.message || `${fallbackErrorFa} (HTTP ${res.status}).`,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      kind: 'ERROR',
      message: `${fallbackErrorFa} (بدنه پاسخ JSON خالی یا ناقص بود).`,
    };
  }

  return { kind: 'JSON', data: parsed as T };
}

/**
 * Resamples mono Float32 PCM to 16 kHz mono 16-bit PCM RIFF WAV bytes (~32 KB/sec).
 */
export function encodeMonoFloat32To16kWavBytes(
  pcm: Float32Array,
  sourceSampleRate: number,
): Uint8Array {
  const targetRate = 16000;
  const safeRate = Number.isFinite(sourceSampleRate) && sourceSampleRate > 0 ? sourceSampleRate : targetRate;

  let mono16k: Float32Array;
  if (Math.round(safeRate) === targetRate) {
    mono16k = pcm;
  } else {
    // Anti-aliased Kaiser-windowed sinc resampling prevents high-frequency Persian sibilant aliasing
    const resampled = resampleTo16kMono([pcm], safeRate, targetRate).samples;
    if (resampled.length > 0) {
      mono16k = resampled;
    } else if (pcm.length > 0) {
      mono16k = new Float32Array([Number.isFinite(pcm[0]) ? pcm[0] : 0]);
    } else {
      mono16k = new Float32Array(0);
    }
  }

  const dataByteLength = mono16k.length * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < mono16k.length; i++) {
    const clamped = Math.max(-1, Math.min(1, mono16k[i]));
    view.setInt16(offset, clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Losslessly resamples/encodes mono Float32 PCM to 16 kHz mono IEEE Float32 RIFF WAV bytes
 * (`audioFormat = 3`, 32-bit float, ~64 KB/sec), eliminating Int16 quantization loss on
 * low-amplitude speech over local HTTP transport while passing standard `RIFF...WAVE` checks (SHB-F10).
 */
export function encodeMonoFloat32To16kFloat32WavBytes(
  pcm: Float32Array,
  sourceSampleRate: number,
): Uint8Array {
  const targetRate = 16000;
  const safeRate = Number.isFinite(sourceSampleRate) && sourceSampleRate > 0 ? sourceSampleRate : targetRate;

  let mono16k: Float32Array;
  if (Math.round(safeRate) === targetRate) {
    mono16k = pcm;
  } else {
    const resampled = resampleTo16kMono([pcm], safeRate, targetRate).samples;
    if (resampled.length > 0) {
      mono16k = resampled;
    } else if (pcm.length > 0) {
      mono16k = new Float32Array([Number.isFinite(pcm[0]) ? pcm[0] : 0]);
    } else {
      mono16k = new Float32Array(0);
    }
  }

  const dataByteLength = mono16k.length * 4;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 3, true); // IEEE Float format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 32, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < mono16k.length; i++) {
    const raw = Number.isFinite(mono16k[i]) ? mono16k[i] : 0;
    const clamped = Math.max(-1, Math.min(1, raw));
    view.setFloat32(offset, clamped, true);
    offset += 4;
  }

  return new Uint8Array(buffer);
}

export async function fetchShahabRuntimeStatus(
  signal?: AbortSignal,
): Promise<ShahabLocalRuntimeStatusResponse | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch('/api/shahab/runtime-status', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok || !isJsonContentType(res.headers.get('content-type'))) {
        return null;
      }
      const data = (await res.json()) as ShahabLocalRuntimeStatusResponse;
      if (typeof data?.available !== 'boolean') return null;
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    return null;
  }
}

export async function fetchShahabSampleAudioFile(signal?: AbortSignal): Promise<File> {
  const retryDelaysMs = [1200, 2500];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const res = await fetch('/api/shahab/sample.wav', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (res.ok && (ct.startsWith('audio/') || ct === 'application/octet-stream')) {
      const blob = await res.blob();
      if (blob.size >= 44) {
        return new File([blob], 'shahab-sample-persian.wav', { type: 'audio/wav' });
      }
    }
    if (ct.includes('text/html') && attempt < retryDelaysMs.length) {
      await sleepWithAbort(retryDelaysMs[attempt], signal);
      continue;
    }
    throw new Error(
      ct.includes('text/html')
        ? 'سرور محلی در حال راه‌اندازی مجدد است یا نشست نیاز به تازه‌سازی صفحه دارد. لطفاً صفحه را Refresh کنید.'
        : `فایل صوتی نمونه شهاب در دسترس نیست (HTTP ${res.status}).`,
    );
  }
  throw new Error('فایل صوتی نمونه شهاب در دسترس نیست.');
}

export function mapShahabResponseToPersianWordTokens(params: {
  readonly response: ShahabServerTranscribeResponse;
  readonly trackId: string;
  readonly speakerName: string;
}): PersianWordToken[] {
  const speaker = params.speakerName.trim() || 'گوینده ۱';
  const tokens = params.response.transcript.tokens;

  return tokens.map((tok, idx) => {
    const startF = secondsToFlicks(Math.max(0, tok.startSec));
    const endF = Math.max(startF + msToFlicks(40), secondsToFlicks(Math.max(tok.startSec, tok.endSec)));
    const hasRealConfidence =
      typeof tok.confidence === 'number' && Number.isFinite(tok.confidence);
    const isWordGranularity = tok.timestampGranularity === 'WORD';
    return {
      id: `tok_shahab_${idx}`,
      trackId: params.trackId,
      speakerName: speaker,
      originalText: tok.rawText,
      normalizedText: tok.normalizedText || tok.rawText,
      displayText: tok.normalizedText || tok.rawText,
      range: {
        startFlicks: startF,
        endFlicks: endF,
      },
      // Never fabricate synthetic confidence (e.g. 0.85) when the model emits null
      confidence: hasRealConfidence ? Math.max(0, Math.min(1, tok.confidence!)) : 0,
      confidenceAvailable: hasRealConfidence,
      // Never mislabel proportionally distributed segment estimates as AcousticSnap
      alignmentSource: isWordGranularity ? 'ASR' : 'Estimated',
      alignmentPrecision: isWordGranularity ? 'model_timestamps' : 'distributed_segment',
      detectedLanguage: /[A-Za-z]/.test(tok.rawText) ? 'EN' : 'FA',
    };
  });
}

const DEFAULT_CHUNK_TIMEOUT_MS = 90_000;

interface EphemeralLocalSession {
  readonly token: string;
  readonly expiresAtMs: number;
}

// Held strictly in JS memory — NEVER persisted to localStorage/sessionStorage and zero static secrets in bundle.
let inMemoryLocalSession: EphemeralLocalSession | null = null;

function generateRequestNonce(): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

async function ensureLocalAudioSessionToken(signal?: AbortSignal, forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && inMemoryLocalSession && Date.now() + 15_000 < inMemoryLocalSession.expiresAtMs) {
    return inMemoryLocalSession.token;
  }
  try {
    const res = await fetch('/api/local-auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok || !isJsonContentType(res.headers.get('content-type'))) {
      inMemoryLocalSession = null;
      return null;
    }
    const data = (await res.json()) as { ok?: boolean; token?: string; expiresAtMs?: number };
    if (data?.ok && typeof data.token === 'string' && data.token.length > 16) {
      inMemoryLocalSession = {
        token: data.token,
        expiresAtMs: typeof data.expiresAtMs === 'number' ? data.expiresAtMs : Date.now() + 10 * 60 * 1000,
      };
      return inMemoryLocalSession.token;
    }
  } catch {
    // Caller will handle auth failure cleanly if endpoint is unavailable
  }
  inMemoryLocalSession = null;
  return null;
}

/**
 * Builds authenticated headers for protected SHAHAB local/hosted API calls using
 * only an ephemeral in-memory session token (never persisted to web storage).
 */
export async function buildAuthorizedShahabRequestHeaders(options?: {
  readonly contentType?: string;
  readonly includeReplayHeaders?: boolean;
  readonly forceRefresh?: boolean;
  readonly bearerToken?: string;
  readonly signal?: AbortSignal;
}): Promise<Record<string, string>> {
  const activeToken =
    options?.bearerToken ??
    (await ensureLocalAudioSessionToken(options?.signal, Boolean(options?.forceRefresh)));
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options?.contentType) {
    headers['Content-Type'] = options.contentType;
  }
  if (activeToken) {
    headers['Authorization'] = `Bearer ${activeToken}`;
  }
  if (options?.includeReplayHeaders) {
    headers['X-Request-Nonce'] = generateRequestNonce();
    headers['X-Request-Timestamp'] = String(Date.now());
  }
  return headers;
}

/**
 * Browser-safe authenticated fetch wrapper for `/api/shahab/*` control/state routes.
 * Automatically attaches the ephemeral in-memory Bearer token and fresh replay headers
 * for state-changing HTTP methods, with one automatic refresh retry on HTTP 401.
 */
export async function authorizedShahabFetch(
  url: string,
  init?: RequestInit & { readonly bearerToken?: string },
): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const baseHeaders = new Headers(init?.headers);

  const attempt = async (forceRefresh: boolean): Promise<Response> => {
    const authHeaders = await buildAuthorizedShahabRequestHeaders({
      includeReplayHeaders: isMutating,
      forceRefresh,
      bearerToken: init?.bearerToken,
      signal: init?.signal ?? undefined,
    });
    const merged = new Headers(baseHeaders);
    for (const [k, v] of Object.entries(authHeaders)) {
      if (k === 'Accept' && merged.has('Accept')) continue;
      merged.set(k, v);
    }
    return fetch(url, {
      ...init,
      credentials: init?.credentials ?? 'same-origin',
      cache: init?.cache ?? 'no-store',
      headers: merged,
    });
  };

  const first = await attempt(false);
  if (first.status === 401 && !init?.bearerToken) {
    inMemoryLocalSession = null;
    return attempt(true);
  }
  return first;
}

async function computeFullPcmFingerprintHex(pcm: Float32Array, sampleRate: number): Promise<string> {
  const rawView = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    try {
      // Prefix with sample rate so identical sample arrays at different rates hash distinctly
      const payload = new Uint8Array(4 + rawView.byteLength);
      new DataView(payload.buffer).setUint32(0, Math.round(sampleRate) >>> 0, true);
      payload.set(rawView, 4);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', payload);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through to deterministic non-crypto 256-bit fingerprint if SubtleCrypto is unavailable
    }
  }
  // Deterministic 4-lane 64-bit mixing fallback (zero Math.random)
  let h0 = BigInt('0xcbf29ce484222325') ^ BigInt(Math.round(sampleRate) >>> 0);
  let h1 = BigInt('0x84222325cbf29ce4') ^ BigInt(pcm.length);
  let h2 = BigInt('0x100000001b300001');
  let h3 = BigInt('0x9e3779b97f4a7c15');
  const prime = BigInt('0x100000001b3');
  const mask64 = BigInt('0xffffffffffffffff');
  for (let i = 0; i < rawView.byteLength; i++) {
    const b = BigInt(rawView[i]);
    if ((i & 3) === 0) h0 = ((h0 ^ b) * prime) & mask64;
    else if ((i & 3) === 1) h1 = ((h1 ^ b) * prime) & mask64;
    else if ((i & 3) === 2) h2 = ((h2 ^ b) * prime) & mask64;
    else h3 = ((h3 ^ b) * prime) & mask64;
  }
  return [h0, h1, h2, h3].map((v) => v.toString(16).padStart(16, '0')).join('');
}

async function postSingleWavChunkToShahab(params: {
  readonly wavBytes: Uint8Array;
  readonly filename: string;
  readonly decodePolicy: 'SPEED' | 'BALANCED' | 'PRECISION' | 'VERBATIM';
  readonly projectId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly bearerToken?: string;
}): Promise<ShahabServerTranscribeResponse> {
  const bodyBuffer = params.wavBytes.buffer.slice(
    params.wavBytes.byteOffset,
    params.wavBytes.byteOffset + params.wavBytes.byteLength,
  ) as ArrayBuffer;

  const timeoutMs = Math.max(5_000, params.timeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS);
  const retryDelaysMs = [1500, 3000, 5000];
  let refreshedAuthOnce = false;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (params.signal?.aborted) {
      throw new Error('عملیات رونویسی توسط کاربر لغو شد.');
    }

    const activeToken =
      params.bearerToken ?? (await ensureLocalAudioSessionToken(params.signal, refreshedAuthOnce));

    const attemptController = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => attemptController.abort();
    params.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, timeoutMs);

    const requestHeaders: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'audio/wav',
      'X-Audio-Filename': encodeURIComponent(params.filename),
      'X-Decode-Policy': params.decodePolicy,
      'X-Request-Nonce': generateRequestNonce(),
      'X-Request-Timestamp': String(Date.now()),
    };
    if (activeToken) {
      requestHeaders.Authorization = `Bearer ${activeToken}`;
    }
    if (params.projectId && params.projectId.trim().length > 0) {
      requestHeaders['X-Project-Id'] = params.projectId.trim();
    }

    let res: Response;
    try {
      res = await fetch('/api/shahab/transcribe', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: requestHeaders,
        body: bodyBuffer,
        signal: attemptController.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onCallerAbort);
      if (params.signal?.aborted) {
        throw new Error('عملیات رونویسی توسط کاربر لغو شد.');
      }
      if (attempt < retryDelaysMs.length) {
        await sleepWithAbort(retryDelaysMs[attempt], params.signal);
        continue;
      }
      throw new Error(
        timedOut
          ? `زمان انتظار برای پاسخ موتور محلی شهاب به پایان رسید (${Math.round(timeoutMs / 1000)} ثانیه).`
          : `ارتباط با سرویس محلی شهاب برقرار نشد: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onCallerAbort);

    // If ephemeral local session expired or server restarted, refresh once cleanly
    if (res.status === 401 && !params.bearerToken && !refreshedAuthOnce) {
      inMemoryLocalSession = null;
      refreshedAuthOnce = true;
      continue;
    }

    const parsed = await parseShahabJsonResponse<ShahabServerTranscribeResponse>(
      res,
      'اجرای موتور محلی شهاب ناموفق بود',
    );

    if (parsed.kind === 'JSON') {
      return parsed.data;
    }

    if (parsed.kind === 'RETRYABLE_HTML') {
      if (attempt < retryDelaysMs.length) {
        await sleepWithAbort(retryDelaysMs[attempt], params.signal);
        continue;
      }
      throw new Error(
        'سرویس محلی شهاب به جای پاسخ JSON صفحه HTML برگرداند (احتمالاً سرور در حال راه‌اندازی مجدد است یا کوکی نشست پیش‌نمایش منقضی شده). لطفاً صفحه را یک بار تازه (Refresh) کنید و دوباره تلاش کنید.',
      );
    }

    if (parsed.kind === 'RETRYABLE_TRANSIENT') {
      if (attempt < retryDelaysMs.length) {
        await sleepWithAbort(retryDelaysMs[attempt], params.signal);
        continue;
      }
      throw new Error(parsed.message);
    }

    throw new Error(parsed.message);
  }

  throw new Error('اجرای موتور محلی شهاب پس از چند تلاش ناموفق بود.');
}

export async function transcribePcmWithShahabLocal(params: {
  readonly pcm: Float32Array;
  readonly sampleRate: number;
  readonly trackId: string;
  readonly speakerName: string;
  readonly filename?: string;
  readonly projectId?: string;
  readonly decodePolicy?: 'SPEED' | 'BALANCED' | 'PRECISION' | 'VERBATIM';
  readonly transportEncoding?: 'float32' | 'pcm16';
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly percent: number;
    readonly currentChunk: number;
    readonly totalChunks: number;
  }) => void;
}): Promise<{
  readonly response: ShahabServerTranscribeResponse;
  readonly tokens: PersianWordToken[];
}> {
  const safeRate = Number.isFinite(params.sampleRate) && params.sampleRate > 0 ? params.sampleRate : 16000;
  const filename = params.filename ?? 'studio-track.wav';
  const decodePolicy = params.decodePolicy ?? 'BALANCED';
  const encodeChunk =
    params.transportEncoding === 'pcm16'
      ? encodeMonoFloat32To16kWavBytes
      : encodeMonoFloat32To16kFloat32WavBytes;

  const plannedChunks = planAudioChunks({
    totalSamples: params.pcm.length,
    sampleRate: safeRate,
    maxChunkSec: DEFAULT_SHAHAB_CHUNK_SEC,
    overlapSec: DEFAULT_SHAHAB_OVERLAP_SEC,
  });

  // Fast single-request path for clips <= 25s (1 chunk)
  if (plannedChunks.length <= 1) {
    params.onProgress?.({ percent: 15, currentChunk: 1, totalChunks: 1 });
    const wavBytes = encodeChunk(params.pcm, safeRate);
    const response = await postSingleWavChunkToShahab({
      wavBytes,
      filename,
      decodePolicy,
      projectId: params.projectId,
      signal: params.signal,
    });
    params.onProgress?.({ percent: 100, currentChunk: 1, totalChunks: 1 });
    const tokens = mapShahabResponseToPersianWordTokens({
      response,
      trackId: params.trackId,
      speakerName: params.speakerName,
    });
    return { response, tokens };
  }

  // Chunked path for longer audio (>24s): keeps every request <1.6 MB and merges cleanly
  const buckets: ChunkWordBucket<ShahabServerTranscriptToken>[] = [];
  let totalProcessingMs = 0;
  let lastResp: ShahabServerTranscribeResponse | null = null;

  for (let idx = 0; idx < plannedChunks.length; idx++) {
    const chunk = plannedChunks[idx];
    const slice = params.pcm.subarray(chunk.startSample, chunk.endSample);
    const wavBytes = encodeChunk(slice, safeRate);

    params.onProgress?.({
      percent: Math.round((idx / plannedChunks.length) * 100),
      currentChunk: idx + 1,
      totalChunks: plannedChunks.length,
    });

    const chunkResp = await postSingleWavChunkToShahab({
      wavBytes,
      filename: `${filename}#chunk${idx + 1}`,
      decodePolicy,
      projectId: params.projectId,
      signal: params.signal,
    });

    lastResp = chunkResp;
    totalProcessingMs += chunkResp.metrics.processingTimeMs;

    const shifted = chunkResp.transcript.tokens.map((t) => {
      const startSec = Number((chunk.startSec + t.startSec).toFixed(4));
      const endSec = Number((chunk.startSec + t.endSec).toFixed(4));
      return {
        ...t,
        startSec,
        endSec,
        startSample: Math.round(startSec * safeRate),
        endSample: Math.max(Math.round(startSec * safeRate) + 1, Math.round(endSec * safeRate)),
      };
    });

    buckets.push({
      chunkStartSec: chunk.startSec,
      chunkEndSec: chunk.endSec,
      words: shifted,
    });

    params.onProgress?.({
      percent: Math.round(((idx + 1) / plannedChunks.length) * 100),
      currentChunk: idx + 1,
      totalChunks: plannedChunks.length,
    });
  }

  const finalDurationSec = params.pcm.length / safeRate;
  const fullAudioHash = await computeFullPcmFingerprintHex(params.pcm, safeRate);
  const fullAudioId = `aud_${fullAudioHash.slice(0, 16)}`;
  const mergedRaw = mergeChunkedTranscriptWords({
    buckets,
    totalDurationSec: finalDurationSec,
  });
  const mergedServerTokens: ShahabServerTranscriptToken[] = mergedRaw.map((t, idx) => ({
    ...t,
    tokenId: `shahab_tok_${idx}`,
    startSample: Math.round(t.startSec * safeRate),
    endSample: Math.max(Math.round(t.startSec * safeRate) + 1, Math.round(t.endSec * safeRate)),
  }));

  const combinedRtf =
    finalDurationSec > 0 ? Number(((totalProcessingMs / 1000) / finalDurationSec).toFixed(4)) : 0;
  const rawText = mergedServerTokens.map((t) => t.rawText).join(' ').trim();
  // SHB-F06: Run the exact same canonical utterance normalizer as single-chunk server execution
  // so multi-word ZWNJ/orthography rules never diverge between 1-chunk and N-chunk audio.
  const normalizedText = normalizeCanonicalPersianUtterance(rawText);

  const response: ShahabServerTranscribeResponse = {
    ok: true,
    transcript: {
      schemaVersion: 'avp.transcript.v1',
      transcriptVersion: lastResp?.transcript.transcriptVersion ?? `tr_shahab_${Date.now()}`,
      sourceAudioId: fullAudioId,
      sourceAudioHash: fullAudioHash,
      sampleRate: safeRate,
      totalSourceSamples: params.pcm.length,
      language: lastResp?.transcript.language ?? 'fa',
      modelId: lastResp?.transcript.modelId ?? 'persian-zipformer-transducer',
      modelVersion: lastResp?.transcript.modelVersion ?? '1.0.0-shahab-zipformer-int8',
      runtime: lastResp?.transcript.runtime ?? 'shahab-zipformer-onnx-cpu',
      rawText,
      normalizedText,
      tokens: mergedServerTokens,
      timestampGranularity: mergedServerTokens.length > 0 ? 'SEGMENT' : 'NONE',
      realTimeFactor: combinedRtf,
      processingTimeMs: totalProcessingMs,
      offlineVerified: true,
    },
    metrics: {
      modelId: lastResp?.metrics.modelId ?? 'persian-zipformer-transducer',
      upstreamModelId: lastResp?.metrics.upstreamModelId ?? 'ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f',
      runtime: lastResp?.metrics.runtime ?? 'shahab-zipformer-onnx-cpu',
      durationSec: Number(finalDurationSec.toFixed(4)),
      processingTimeMs: totalProcessingMs,
      realTimeFactor: combinedRtf,
      tokenCount: mergedServerTokens.length,
      offlineVerified: true,
    },
  };

  const tokens = mapShahabResponseToPersianWordTokens({
    response,
    trackId: params.trackId,
    speakerName: params.speakerName,
  });

  return { response, tokens };
}
