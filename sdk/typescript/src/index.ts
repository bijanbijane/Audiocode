/**
 * Official TypeScript SDK (`@asr-platform/sdk`) for Independent Persian-English ASR Platform v1.
 *
 * Security & Reliability:
 * - Supports server-side API keys (`asr_live_...` / `asr_test_...`) and short-lived browser session tokens.
 * - Implements exponential backoff + jitter ONLY on retryable HTTP codes (429, 502, 503, 504) or network errors.
 * - Never retries 400/401/402/403/409/422 non-retryable validation, auth, budget, or idempotency errors.
 */

export interface ASRClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateTranscriptionParams {
  model?: 'asr-fa-en-v1' | 'asr-fa-en-baseline' | 'qwen3-asr-1.7b-fa' | 'whisper-large-v3-fa';
  language?: 'auto' | 'fa' | 'en' | 'fa-en';
  timestamps?: boolean;
  diarization?: boolean;
  domain_profile?: 'general' | 'technology' | 'business' | 'real_estate' | 'education' | 'medical' | 'legal';
  execution_mode?: 'batch' | 'long_form_async';
  region_id?: string;
  audio_duration_ms?: number;
  raw_text_hint?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  id: string;
  object: 'audio.transcription';
  status: string;
  model: string;
  model_version: string;
  region_id: string;
  language: string;
  text: string | null;
  duration_ms: number;
  usage: {
    audio_seconds: number;
    billable_seconds: number;
    actual_cost_minor_cents: number;
    currency: 'USD';
  };
  timestamps_available: boolean;
  diarization_available: boolean;
  created_at: string;
}

export class ASRApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId: string;
  public readonly retryable: boolean;

  constructor(params: { status: number; code: string; message: string; requestId: string; retryable: boolean }) {
    super(`[${params.code}] ${params.message} (status=${params.status}, request_id=${params.requestId})`);
    this.name = 'ASRApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.retryable = params.retryable;
  }
}

export class ASRClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  public readonly audio: {
    transcriptions: {
      create: (params: CreateTranscriptionParams) => Promise<TranscriptionResult>;
      retrieve: (transcriptionId: string, signal?: AbortSignal) => Promise<TranscriptionResult>;
      estimate: (params: { model?: string; duration_seconds: number; region_id?: string }) => Promise<unknown>;
    };
    streamingSessions: {
      create: (params: { model?: string; language?: string; region_id?: string }) => Promise<unknown>;
    };
  };

  public readonly models: {
    list: () => Promise<unknown>;
  };

  constructor(options: ASRClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('ASRClient requires a non-empty apiKey or short-lived browser session token.');
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;

    this.audio = {
      transcriptions: {
        create: (params) =>
          this.request<TranscriptionResult>('POST', '/v1/audio/transcriptions', params, params.idempotencyKey, params.signal),
        retrieve: (id, signal) =>
          this.request<TranscriptionResult>('GET', `/v1/audio/transcriptions/${encodeURIComponent(id)}`, undefined, undefined, signal),
        estimate: (params) => this.request('POST', '/v1/audio/estimates', params),
      },
      streamingSessions: {
        create: (params) => this.request('POST', '/v1/audio/streaming-sessions', params),
      },
    };

    this.models = {
      list: () => this.request('GET', '/v1/models'),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    externalSignal?: AbortSignal
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      if (externalSignal) {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        };
        if (idempotencyKey) {
          headers['Idempotency-Key'] = idempotencyKey;
        }

        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const json = (await res.json()) as Record<string, unknown>;
        if (res.ok) {
          return json as unknown as T;
        }

        const errObj = (json?.error as Record<string, unknown> | undefined) ?? {};
        const apiError = new ASRApiError({
          status: res.status,
          code: String(errObj.code ?? 'HTTP_ERROR'),
          message: String(errObj.message ?? res.statusText),
          requestId: String(errObj.request_id ?? 'unknown'),
          retryable: Boolean(errObj.retryable) && [429, 502, 503, 504].includes(res.status),
        });

        if (!apiError.retryable || attempt >= this.maxRetries) {
          throw apiError;
        }
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ASRApiError && !err.retryable) {
          throw err;
        }
        if (attempt >= this.maxRetries) {
          throw err;
        }
      }

      attempt++;
      const jitterMs = Math.floor(Math.random() * 150);
      const backoffMs = Math.min(4000, 250 * Math.pow(2, attempt) + jitterMs);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * Web-Crypto / Node-safe HMAC-SHA256 webhook signature verifier (`t=<epoch>,v1=<hex>`).
 */
export async function verifyAsrWebhookSignature(params: {
  secret: string;
  signatureHeader: string;
  rawPayload: string;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const parts = Object.fromEntries(params.signatureHeader.split(',').map((p) => p.split('='))) as {
    t?: string;
    v1?: string;
  };
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > (params.toleranceSeconds ?? 300)) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(params.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${params.rawPayload}`));
  const hex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex === parts.v1;
}
