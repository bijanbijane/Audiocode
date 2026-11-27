import { streamPcmSourceAsCanonicalWav } from '../../asr-core/StreamingCanonicalPcmWav';
import type { NativeCompanionAudioSourceRequest } from '../../asr-core/NativeCompanionTransport';

/**
 * AVAPARDAZ — BROWSER CLIENT FOR SHARED LOCAL COMPANION SERVICE
 *
 * Connects the AVAPARDAZ Web Application to the EXACT SAME Local Companion IPC v1.0.0
 * contract used by the Adobe Audition CEP Plugin (zero duplicated ASR engines).
 *
 * - Auto-discovers same-origin `/api/v2/companion` (when served by local AVAPARDAZ host)
 *   or standalone desktop Companion (`http://127.0.0.1:47291/api/v2/companion`).
 * - Performs versioned HMAC handshake & per-request nonce generation.
 * - Submits 16 kHz Mono PCM16 WAV bytes strictly to loopback Companion (never external cloud).
 * - Polls honest chunk progress and supports real AbortSignal cancellation.
 */

export interface CompanionModelInfo {
  readonly modelId: string;
  readonly profileId: string;
  readonly displayName: string;
  readonly architecture: string;
  readonly quantization: string;
  readonly licenseSpdx: string;
  readonly supportedLanguages: readonly string[];
  readonly supportsNativeWordTimestamps: boolean;
  readonly diskSizeBytes: number;
  readonly integrityVerified: boolean;
}

export interface CompanionHealthResponse {
  readonly service: string;
  readonly serviceVersion: string;
  readonly ipcProtocolVersion: string;
  readonly offlineOnlyEnforced: boolean;
  readonly cloudUploadDisabled: boolean;
  readonly runtime: {
    readonly runtimeName: string;
    readonly available: boolean;
    readonly cpuThreads: number;
    readonly activeModelId: string | null;
    readonly installedModels: readonly CompanionModelInfo[];
    readonly processRssMb: number;
  };
  readonly sampleAudioAvailable?: boolean;
  readonly sampleAudioFilename?: string | null;
  readonly activeJobs: number;
}

export interface CompanionTranscriptionSegment {
  readonly id: string;
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly language: string;
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly words: readonly { readonly word: string; readonly startSec: number; readonly endSec: number }[];
}

export interface CompanionTranscriptionResult {
  readonly modelId: string;
  readonly architecture: string;
  readonly quantization: string;
  readonly offlineVerified: boolean;
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly dominantLanguage: string;
  readonly rawText: string;
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly segments: readonly CompanionTranscriptionSegment[];
}

export interface CompanionJobStatus {
  readonly jobId: string;
  readonly status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  readonly modelId: string | null;
  readonly languageHint: string;
  readonly progressPct: number;
  readonly currentChunk: number;
  readonly totalChunks: number;
  readonly elapsedMs: number;
  readonly partialText: string;
  readonly result: CompanionTranscriptionResult | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

function generateClientInstanceId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Secure random generator is required for Companion client identity.');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Encodes Float32Array PCM into canonical 16 kHz Mono PCM16 WAV bytes in the browser.
 */
export function encodeBrowserPcmToWav16kBytes(pcm: Float32Array, sourceSampleRate: number): Uint8Array {
  const targetRate = 16_000;
  let mono16k: Float32Array;
  if (sourceSampleRate === targetRate) {
    mono16k = pcm;
  } else {
    const ratio = sourceSampleRate / targetRate;
    const outLen = Math.max(1, Math.round(pcm.length / ratio));
    mono16k = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const lo = Math.floor(srcPos);
      const hi = Math.min(pcm.length - 1, lo + 1);
      const frac = srcPos - lo;
      mono16k[i] = pcm[lo] * (1 - frac) + pcm[hi] * frac;
    }
  }

  const dataByteLen = mono16k.length * 2;
  const wav = new ArrayBuffer(44 + dataByteLen);
  const view = new DataView(wav);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataByteLen, true);

  let offset = 44;
  for (let i = 0; i < mono16k.length; i++) {
    const clamped = Math.max(-1, Math.min(1, mono16k[i]));
    view.setInt16(offset, clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), true);
    offset += 2;
  }

  return new Uint8Array(wav);
}

export function encodeBrowserPcmToWav16kBase64(pcm: Float32Array, sourceSampleRate: number): string {
  return bytesToBase64(encodeBrowserPcmToWav16kBytes(pcm, sourceSampleRate));
}

async function parseJsonResponseSafe<T>(resp: Response, contextLabel: string): Promise<T> {
  const rawText = await resp.text();
  if (!rawText || rawText.trim().length === 0) {
    throw new Error(`${contextLabel}: پاسخ خالی از سرویس Companion دریافت شد (HTTP ${resp.status}).`);
  }
  try {
    return JSON.parse(rawText) as T;
  } catch {
    const titleMatch = rawText.match(/<title>([^<]{1,120})<\/title>/i);
    const proxyHint = titleMatch?.[1]?.trim();
    if (resp.status === 413) {
      throw new Error(
        `حجم بسته ارسالی از سقف مجاز پروکسی بیشتر بود (HTTP 413${proxyHint ? ` - ${proxyHint}` : ''}).`,
      );
    }
    throw new Error(
      `${contextLabel}: پاسخ غیر-JSON از سرور محلی دریافت شد (HTTP ${resp.status}${proxyHint ? ` - ${proxyHint}` : ''}).`,
    );
  }
}

const INLINE_WAV_MAX_BYTES = 384 * 1024; // <= 384 KiB inline; larger audio uses 256 KiB chunked transfer
const UPLOAD_CHUNK_BYTES = 256 * 1024;

export class CompanionWebClient {
  private readonly baseUrl: string;
  private readonly clientInstanceId: string;
  private sessionId: string | null = null;
  private sessionToken: string | null = null;

  constructor(baseUrl = '/api/v2/companion') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientInstanceId = generateClientInstanceId();
  }

  public async getHealth(signal?: AbortSignal): Promise<CompanionHealthResponse | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal,
      });
      if (!resp.ok) return null;
      return await parseJsonResponseSafe<CompanionHealthResponse>(resp, 'Companion Health');
    } catch {
      return null;
    }
  }

  public async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionId && this.sessionToken) return;
    const resp = await fetch(`${this.baseUrl}/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        host_id: 'cli-test',
        client_instance_id: this.clientInstanceId,
        host_version: 'web-1.0.0',
        panel_version: '1.0.0',
        host_adapter_version: '1.0.0',
        expected_contract_version: '2.0.0',
      }),
    });
    const data = await parseJsonResponseSafe<{
      compatible?: boolean;
      session_id?: string | null;
      session_token?: string | null;
      incompatibility_reasons?: string[];
      error?: string;
      message?: string;
    }>(resp, 'Companion Handshake');
    if (!resp.ok || !data.compatible || !data.session_id || !data.session_token) {
      throw new Error(
        data.incompatibility_reasons?.join('; ') ||
          data.message ||
          data.error ||
          `Companion handshake failed (${resp.status})`,
      );
    }
    this.sessionId = data.session_id;
    this.sessionToken = data.session_token;
  }

  public async sendIpc<TResponse = Record<string, unknown>>(
    command: 'CAPABILITY_LIST' | 'CAPABILITY_EXECUTE' | 'JOB_SUBMIT' | 'JOB_STATUS' | 'JOB_CANCEL' | 'HOST_CAPABILITY_MATRIX',
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    await this.ensureSession(signal);
    const resp = await fetch(`${this.baseUrl}/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.sessionToken}`,
      },
      signal,
      body: JSON.stringify({
        ipc_protocol_version: '1.0.0',
        session_id: this.sessionId,
        execution_mode: 'web-client',
        nonce: generateNonce(),
        timestamp_ms: Date.now(),
        command,
        payload,
      }),
    });

    if (resp.status === 401) {
      // Session expired — clear and retry handshake once
      this.sessionId = null;
      this.sessionToken = null;
      await this.ensureSession(signal);
      const retry = await fetch(`${this.baseUrl}/ipc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sessionToken}`,
        },
        signal,
        body: JSON.stringify({
          ipc_protocol_version: '1.0.0',
          session_id: this.sessionId,
          execution_mode: 'web-client',
          nonce: generateNonce(),
          timestamp_ms: Date.now(),
          command,
          payload,
        }),
      });
      const retryData = await parseJsonResponseSafe<{ message?: string; error?: string } & TResponse>(
        retry,
        `Companion IPC (${command})`,
      );
      if (!retry.ok) {
        throw new Error(retryData.message || retryData.error || `Companion IPC error (${retry.status})`);
      }
      return retryData as TResponse;
    }

    const data = await parseJsonResponseSafe<{ message?: string; error?: string } & TResponse>(
      resp,
      `Companion IPC (${command})`,
    );
    if (!resp.ok) {
      throw new Error(data.message || data.error || `Companion IPC error (${resp.status})`);
    }
    return data as TResponse;
  }

  public async transcribePcm(params: {
    readonly pcm: Float32Array;
    readonly sampleRate: number;
    readonly filename: string;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly modelId?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (job: CompanionJobStatus) => void;
  }): Promise<CompanionTranscriptionResult> {
    const safeFilename = params.filename.endsWith('.wav') ? params.filename : `${params.filename}.wav`;
    const wavBytes = encodeBrowserPcmToWav16kBytes(params.pcm, params.sampleRate);

    let submitPayload: Record<string, unknown>;
    if (wavBytes.byteLength <= INLINE_WAV_MAX_BYTES) {
      submitPayload = {
        audioBase64: bytesToBase64(wavBytes),
        filename: safeFilename,
        languageHint: params.languageHint ?? 'auto',
        modelId: params.modelId,
      };
    } else {
      const init = await this.sendIpc<{ ok: boolean; uploadId: string }>(
        'CAPABILITY_EXECUTE',
        { action: 'AUDIO_UPLOAD_INIT', filename: safeFilename },
        params.signal,
      );
      const uploadId = init.uploadId;
      const totalParts = Math.ceil(wavBytes.byteLength / UPLOAD_CHUNK_BYTES);
      try {
        for (let partIdx = 0; partIdx < totalParts; partIdx++) {
          if (params.signal?.aborted) {
            throw new Error('TRANSCRIPTION_CANCELLED');
          }
          const start = partIdx * UPLOAD_CHUNK_BYTES;
          const end = Math.min(wavBytes.byteLength, start + UPLOAD_CHUNK_BYTES);
          const slice = wavBytes.subarray(start, end);
          await this.sendIpc(
            'CAPABILITY_EXECUTE',
            {
              action: 'AUDIO_UPLOAD_CHUNK',
              uploadId,
              chunkIndex: partIdx,
              chunkBase64: bytesToBase64(slice),
            },
            params.signal,
          );
          params.onProgress?.({
            jobId: uploadId,
            status: 'QUEUED',
            modelId: params.modelId ?? 'در حال انتقال صوت محلی',
            languageHint: params.languageHint ?? 'auto',
            progressPct: Math.min(15, Math.round(((partIdx + 1) / totalParts) * 15)),
            currentChunk: partIdx + 1,
            totalChunks: totalParts,
            elapsedMs: 0,
            partialText: '',
            result: null,
            errorCode: null,
            errorMessage: null,
          });
        }
      } catch (err) {
        void this.sendIpc('CAPABILITY_EXECUTE', { action: 'AUDIO_UPLOAD_ABORT', uploadId }).catch(() => {});
        throw err;
      }
      submitPayload = {
        uploadId,
        filename: safeFilename,
        languageHint: params.languageHint ?? 'auto',
        modelId: params.modelId,
      };
    }

    const submitted = await this.sendIpc<{ ok: boolean; job: CompanionJobStatus }>(
      'JOB_SUBMIT',
      submitPayload,
      params.signal,
    );

    const jobId = submitted.job.jobId;
    params.onProgress?.(submitted.job);

    const onAbort = () => {
      void this.sendIpc('JOB_CANCEL', { jobId }).catch(() => {});
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (params.signal?.aborted) {
          throw new Error('TRANSCRIPTION_CANCELLED');
        }
        await new Promise((r) => setTimeout(r, 350));
        const polled = await this.sendIpc<{ ok: boolean; job: CompanionJobStatus }>(
          'JOB_STATUS',
          { jobId },
          params.signal,
        );
        const job = polled.job;
        params.onProgress?.(job);
        if (job.status === 'COMPLETED' && job.result) {
          return job.result;
        }
        if (job.status === 'CANCELLED') {
          throw new Error('TRANSCRIPTION_CANCELLED');
        }
        if (job.status === 'FAILED') {
          throw new Error(job.errorMessage || job.errorCode || 'LOCAL_INFERENCE_FAILED');
        }
      }
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Streams a source range-reader into Companion's file-backed transfer protocol.
   * The browser never creates a full-recording PCM array or WAV ArrayBuffer.
   */
  public async transcribeAudioSource(
    params: NativeCompanionAudioSourceRequest,
  ): Promise<CompanionTranscriptionResult> {
    if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
    if (!Number.isInteger(params.sampleRate) || params.sampleRate < 8_000 || params.sampleRate > 192_000) {
      throw new Error('INVALID_SOURCE_SAMPLE_RATE');
    }
    if (!Number.isSafeInteger(params.totalSamples) || params.totalSamples <= 0) {
      throw new Error('INVALID_SOURCE_SAMPLE_COUNT');
    }

    const safeFilename = params.filename.endsWith('.wav') ? params.filename : `${params.filename}.wav`;
    const outputSamples = Math.floor(params.totalSamples / (params.sampleRate / 16_000));
    const expectedBytes = 44 + outputSamples * 4;
    const totalChunks = Math.ceil(expectedBytes / UPLOAD_CHUNK_BYTES);
    const startedAt = performance.now();

    const initialized = await this.sendIpc<{
      ok: boolean;
      transferId?: string;
      code?: string;
      message?: string;
    }>(
      'CAPABILITY_EXECUTE',
      {
        action: 'AUDIO_TRANSFER_INIT',
        filename: safeFilename,
        format: 'wav',
        sampleRateHz: 16_000,
        channels: 1,
        endianness: 'little',
        expectedBytes,
        expectedFrames: outputSamples,
        totalChunks,
      },
      params.signal,
    );
    if (!initialized.ok || !initialized.transferId) {
      throw new Error(initialized.message || initialized.code || 'AUDIO_TRANSFER_INIT_FAILED');
    }

    const transferId = initialized.transferId;
    let transferFinalized = false;
    let submittedJobId: string | null = null;
    let uploadBuffer = new Uint8Array(UPLOAD_CHUNK_BYTES);
    let uploadBufferUsed = 0;
    let chunksSent = 0;

    const flushUploadChunk = async () => {
      if (uploadBufferUsed === 0) return;
      if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
      const chunk = uploadBuffer.subarray(0, uploadBufferUsed);
      const response = await this.sendIpc<{ ok?: boolean; error?: string; message?: string }>(
        'CAPABILITY_EXECUTE',
        {
          action: 'AUDIO_TRANSFER_CHUNK',
          transferId,
          chunkIndex: chunksSent,
          chunkBase64: bytesToBase64(chunk),
        },
        params.signal,
      );
      if (response.ok === false) {
        throw new Error(response.message || response.error || `AUDIO_TRANSFER_CHUNK_${chunksSent}_FAILED`);
      }
      chunksSent += 1;
      uploadBuffer = new Uint8Array(UPLOAD_CHUNK_BYTES);
      uploadBufferUsed = 0;
      params.onProgress?.({
        progressPct: Math.min(15, Math.round((chunksSent / totalChunks) * 15)),
        currentChunk: chunksSent,
        totalChunks,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    };

    const appendWavBytes = async (bytes: Uint8Array) => {
      let cursor = 0;
      while (cursor < bytes.byteLength) {
        if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
        const capacity = UPLOAD_CHUNK_BYTES - uploadBufferUsed;
        const copyCount = Math.min(capacity, bytes.byteLength - cursor);
        uploadBuffer.set(bytes.subarray(cursor, cursor + copyCount), uploadBufferUsed);
        uploadBufferUsed += copyCount;
        cursor += copyCount;
        if (uploadBufferUsed === UPLOAD_CHUNK_BYTES) await flushUploadChunk();
      }
    };

    try {
      const streamed = await streamPcmSourceAsCanonicalWav({
        sampleRate: params.sampleRate,
        totalSamples: params.totalSamples,
        readSourceRange: params.readSourceRange,
        signal: params.signal,
        chunkSizeSamples: 16_384,
        onWavChunk: appendWavBytes,
        onProgress: (percent) => {
          params.onProgress?.({
            progressPct: Math.min(15, Math.round(percent * 0.15)),
            currentChunk: chunksSent,
            totalChunks,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        },
      });

      await flushUploadChunk();
      if (streamed.totalWavBytes !== expectedBytes || streamed.sampleCount !== outputSamples) {
        throw new Error('AUDIO_TRANSFER_STREAM_SIZE_MISMATCH');
      }
      if (chunksSent !== totalChunks) {
        throw new Error(`AUDIO_TRANSFER_CHUNK_COUNT_MISMATCH: ${chunksSent}/${totalChunks}`);
      }

      const finalized = await this.sendIpc<{
        ok: boolean;
        code?: string;
        message?: string;
        sha256?: string;
      }>(
        'CAPABILITY_EXECUTE',
        { action: 'AUDIO_TRANSFER_FINALIZE', transferId },
        params.signal,
      );
      if (!finalized.ok) {
        throw new Error(finalized.message || finalized.code || 'AUDIO_TRANSFER_FINALIZE_FAILED');
      }
      transferFinalized = true;

      const submitted = await this.sendIpc<{ ok: boolean; job: CompanionJobStatus; message?: string; error?: string }>(
        'JOB_SUBMIT',
        {
          transferId,
          filename: safeFilename,
          languageHint: params.languageHint ?? 'auto',
          modelId: params.modelId,
        },
        params.signal,
      );
      if (!submitted.ok || !submitted.job?.jobId) {
        throw new Error(submitted.message || submitted.error || 'COMPANION_JOB_SUBMIT_FAILED');
      }

      const jobId = submitted.job.jobId;
      submittedJobId = jobId;
      params.onProgress?.({
        progressPct: Math.max(15, submitted.job.progressPct),
        currentChunk: submitted.job.currentChunk,
        totalChunks: submitted.job.totalChunks,
        elapsedMs: submitted.job.elapsedMs,
      });

      const onAbort = () => {
        void this.sendIpc('JOB_CANCEL', { jobId }).catch(() => {});
      };
      if (params.signal?.aborted) onAbort();
      else params.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        while (true) {
          if (params.signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
          await new Promise((resolve) => setTimeout(resolve, 350));
          const polled = await this.sendIpc<{ ok: boolean; job: CompanionJobStatus }>(
            'JOB_STATUS',
            { jobId },
            params.signal,
          );
          const job = polled.job;
          params.onProgress?.({
            progressPct: Math.max(15, job.progressPct),
            currentChunk: job.currentChunk,
            totalChunks: job.totalChunks,
            elapsedMs: job.elapsedMs,
          });
          if (job.status === 'COMPLETED' && job.result) return job.result;
          if (job.status === 'CANCELLED') throw new Error('TRANSCRIPTION_CANCELLED');
          if (job.status === 'FAILED') throw new Error(job.errorMessage || job.errorCode || 'LOCAL_INFERENCE_FAILED');
        }
      } finally {
        params.signal?.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      if (!submittedJobId) {
        await this.sendIpc(
          'CAPABILITY_EXECUTE',
          { action: 'AUDIO_TRANSFER_ABORT', transferId },
        ).catch(() => {});
      }
      throw error;
    }
  }

  public async fetchBundledSamplePersianAudio(signal?: AbortSignal): Promise<{
    readonly filename: string;
    readonly modelId: string;
    readonly mimeType: string;
    readonly wavBytes: Uint8Array;
  }> {
    const resp = await this.sendIpc<{
      ok: boolean;
      filename: string;
      modelId: string;
      mimeType: string;
      audioBase64: string;
    }>('CAPABILITY_EXECUTE', { action: 'GET_SAMPLE_PERSIAN_AUDIO' }, signal);
    if (!resp.ok || !resp.audioBase64) {
      throw new Error('نمونه صوتی فارسی همراه مدل در دسترس نیست.');
    }
    return {
      filename: resp.filename || 'shenava-sample-0.wav',
      modelId: resp.modelId || 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx',
      mimeType: resp.mimeType || 'audio/wav',
      wavBytes: base64ToBytes(resp.audioBase64),
    };
  }

  public async installNativeRuntime(signal?: AbortSignal): Promise<CompanionHealthResponse> {
    const resp = await this.sendIpc<{
      ok: boolean;
      health?: CompanionHealthResponse;
    }>('CAPABILITY_EXECUTE', { action: 'INSTALL_NATIVE_RUNTIME' }, signal);
    if (!resp.ok || !resp.health) {
      throw new Error('نصب موتور بومی Sherpa-ONNX ناموفق بود.');
    }
    return resp.health;
  }
}
