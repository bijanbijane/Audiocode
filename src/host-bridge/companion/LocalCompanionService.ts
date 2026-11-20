/**
 * AVAPARDAZ — SHARED LOCAL COMPANION SERVICE (v1.0.0)
 *
 * Single local ASR Companion service shared by BOTH:
 * 1. Adobe Audition CEP Plugin (via secure local loopback IPC)
 * 2. AVAPARDAZ Web Application (via same-origin / loopback IPC)
 *
 * Security & Privacy Invariants (PHASE-09 §8, PHASE-10 §6/13, PHASE-12 §3):
 * - Loopback-only remote address enforcement (`127.0.0.1` / `::1`)
 * - Strict `Host` header validation (DNS rebinding defense)
 * - Strict `Origin` allowlist (blocks malicious websites attempting localhost CSRF)
 * - Ephemeral HMAC-SHA256 session tokens + nonce replay defense via CompanionIpcBridge
 * - Strict file path canonicalization & traversal rejection (no shell execution)
 * - Zero transcript text written to stdout/stderr logs
 * - Strictly 100% local/offline neural inference (no cloud upload)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import {
  COMPANION_IPC_PROTOCOL_VERSION,
  CompanionIpcBridge,
  isLoopbackRemoteAddress,
  type CompanionHandshakeRequest,
} from './CompanionIpcBridge';
import { AdobeAuditionHostAdapter } from '../audition/AuditionHostAdapter';
import {
  LocalSherpaNeuralEngine,
  type LocalNeuralTranscriptionResult,
} from '../../asr-core/LocalSherpaNeuralEngine';
import {
  exportTranscript,
  type ExportableTranscriptSegment,
  type TranscriptExportFormat,
} from '../../utils/subtitleExporter';

export const COMPANION_SERVICE_VERSION = '1.0.0' as const;

export type CompanionJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface CompanionJobRecord {
  readonly jobId: string;
  readonly status: CompanionJobState;
  readonly modelId: string | null;
  readonly languageHint: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly sourceName: string;
  readonly progressPct: number;
  readonly currentChunk: number;
  readonly totalChunks: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly elapsedMs: number;
  readonly partialText: string;
  readonly result: LocalNeuralTranscriptionResult | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

interface InternalJobEntry {
  record: CompanionJobRecord;
  abortController: AbortController;
}

const ALLOWED_AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.flac',
  '.ogg',
  '.aac',
  '.webm',
  '.aif',
  '.aiff',
  '.pcm',
]);

/**
 * Validates HTTP Host header to defend against DNS rebinding attacks against localhost.
 */
export function isAllowedLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  const cleaned = hostHeader.trim().toLowerCase();
  return (
    /^localhost(:\d{1,5})?$/.test(cleaned) ||
    /^127\.0\.0\.1(:\d{1,5})?$/.test(cleaned) ||
    /^\[::1\](:\d{1,5})?$/.test(cleaned)
  );
}

/**
 * Validates Origin header: permits local loopback origins, Adobe CEP (`file://`, `null`, absent),
 * and rejects arbitrary third-party web origins attempting localhost CSRF.
 */
export function isAllowedCompanionOrigin(originHeader: string | undefined): boolean {
  if (originHeader === undefined || originHeader === '' || originHeader === 'null') {
    return true;
  }
  const cleaned = originHeader.trim().toLowerCase();
  if (cleaned.startsWith('file://')) return true;
  return (
    /^https?:\/\/localhost(:\d{1,5})?$/.test(cleaned) ||
    /^https?:\/\/127\.0\.0\.1(:\d{1,5})?$/.test(cleaned) ||
    /^https?:\/\/\[::1\](:\d{1,5})?$/.test(cleaned)
  );
}

/**
 * Validates local audio file paths submitted by Adobe Audition plugin / local clients.
 * Blocks null bytes, relative traversal segments (`..`), unsupported extensions,
 * and directories/special devices.
 */
export function validateLocalAudioFilePath(rawPath: unknown): {
  readonly ok: boolean;
  readonly resolvedPath?: string;
  readonly code?: string;
  readonly message?: string;
} {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, code: 'INVALID_FILE_PATH', message: 'Audio filePath must be a non-empty string.' };
  }
  if (rawPath.includes('\0') || rawPath.length > 4096) {
    return { ok: false, code: 'INVALID_FILE_PATH', message: 'Audio filePath contains illegal characters or exceeds limit.' };
  }
  // Reject explicit traversal patterns before canonical resolution
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rawPath)) {
    return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: 'Relative parent-directory traversal (..) is forbidden.' };
  }

  const resolved = path.resolve(rawPath);
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_AUDIO_EXTENSION',
      message: `Unsupported audio file extension "${ext || '(none)'}".`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, code: 'AUDIO_FILE_NOT_FOUND', message: 'Specified local audio file does not exist or is unreadable.' };
  }

  if (!stat.isFile()) {
    return { ok: false, code: 'NOT_A_REGULAR_FILE', message: 'Audio path must point to a regular file.' };
  }
  if (stat.size <= 0) {
    return { ok: false, code: 'EMPTY_AUDIO_FILE', message: 'Audio file is empty (0 bytes).' };
  }
  if (stat.size > 1024 * 1024 * 1024) {
    return { ok: false, code: 'AUDIO_FILE_TOO_LARGE', message: 'Audio file exceeds 1 GiB safety bound.' };
  }

  return { ok: true, resolvedPath: resolved };
}

interface StagedAudioUpload {
  readonly uploadId: string;
  readonly tempPath: string;
  readonly filename: string;
  readonly createdAtMs: number;
  receivedBytes: number;
}

export interface CompanionRouterOptions {
  /**
   * When mounted inside the same-origin web host (e.g., server.ts behind a local
   * reverse proxy like Cloud Run / AI Studio preview), allow requests whose Origin
   * host strictly matches the forwarded Host header while still blocking foreign
   * cross-origin CSRF and non-loopback sockets.
   * Standalone desktop Companion daemons MUST leave this false (strict loopback Host/Origin).
   */
  readonly allowSameOriginProxyHost?: boolean;
}

const MAX_STAGED_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB safety bound
const STAGED_UPLOAD_TTL_MS = 15 * 60 * 1000;

export class LocalCompanionService {
  public readonly ipcBridge: CompanionIpcBridge;
  public readonly auditionAdapter: AdobeAuditionHostAdapter;
  public readonly neuralEngine: LocalSherpaNeuralEngine;
  private readonly jobs = new Map<string, InternalJobEntry>();
  private readonly stagedUploads = new Map<string, StagedAudioUpload>();
  private readonly maxRetainedJobs: number;

  constructor(options?: {
    readonly neuralEngine?: LocalSherpaNeuralEngine;
    readonly maxRetainedJobs?: number;
  }) {
    this.ipcBridge = new CompanionIpcBridge();
    this.auditionAdapter = new AdobeAuditionHostAdapter();
    this.neuralEngine = options?.neuralEngine ?? new LocalSherpaNeuralEngine();
    this.maxRetainedJobs = Math.max(8, Math.min(200, options?.maxRetainedJobs ?? 50));
  }

  public getHealth() {
    const runtime = this.neuralEngine.getStatus();
    return {
      service: 'avapardaz-local-companion',
      serviceVersion: COMPANION_SERVICE_VERSION,
      ipcProtocolVersion: COMPANION_IPC_PROTOCOL_VERSION,
      offlineOnlyEnforced: true,
      cloudUploadDisabled: true,
      runtime,
      activeJobs: Array.from(this.jobs.values()).filter(
        (j) => j.record.status === 'QUEUED' || j.record.status === 'RUNNING',
      ).length,
      timestampIso: new Date().toISOString(),
    };
  }

  private trimOldJobs(): void {
    while (this.jobs.size > this.maxRetainedJobs) {
      const oldestKey = this.jobs.keys().next().value;
      if (!oldestKey) break;
      const entry = this.jobs.get(oldestKey);
      if (entry && (entry.record.status === 'RUNNING' || entry.record.status === 'QUEUED')) {
        break;
      }
      this.jobs.delete(oldestKey);
    }
  }

  private sweepExpiredUploads(): void {
    const now = Date.now();
    for (const [id, up] of this.stagedUploads.entries()) {
      if (now - up.createdAtMs > STAGED_UPLOAD_TTL_MS) {
        this.stagedUploads.delete(id);
        try {
          fs.rmSync(up.tempPath, { force: true });
        } catch {
          // ignore cleanup race
        }
      }
    }
  }

  public initStagedUpload(filename?: string): { readonly ok: boolean; readonly uploadId: string; readonly filename: string } {
    this.sweepExpiredUploads();
    const uploadId = `up_${crypto.randomBytes(8).toString('hex')}`;
    const safeName =
      typeof filename === 'string' && filename.trim().length > 0
        ? path.basename(filename.trim()).replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_')
        : 'audio.wav';
    const uploadDir = path.join(os.tmpdir(), 'avapardaz-companion-uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const tempPath = path.join(uploadDir, `${uploadId}.bin`);
    fs.writeFileSync(tempPath, Buffer.alloc(0));
    this.stagedUploads.set(uploadId, {
      uploadId,
      tempPath,
      filename: safeName,
      createdAtMs: Date.now(),
      receivedBytes: 0,
    });
    return { ok: true, uploadId, filename: safeName };
  }

  public appendStagedUploadChunk(
    uploadId: string,
    chunkBase64: string,
  ): { readonly ok: boolean; readonly statusCode: number; readonly receivedBytes?: number; readonly code?: string; readonly message?: string } {
    this.sweepExpiredUploads();
    const entry = this.stagedUploads.get(uploadId);
    if (!entry) {
      return { ok: false, statusCode: 404, code: 'UPLOAD_NOT_FOUND', message: 'Unknown or expired uploadId.' };
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(chunkBase64, 'base64');
    } catch {
      return { ok: false, statusCode: 400, code: 'INVALID_BASE64', message: 'Invalid base64 audio chunk.' };
    }
    if (entry.receivedBytes + bytes.byteLength > MAX_STAGED_UPLOAD_BYTES) {
      this.abortStagedUpload(uploadId);
      return {
        ok: false,
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Staged audio upload exceeds 64 MiB limit.',
      };
    }
    fs.appendFileSync(entry.tempPath, bytes);
    entry.receivedBytes += bytes.byteLength;
    return { ok: true, statusCode: 200, receivedBytes: entry.receivedBytes };
  }

  public abortStagedUpload(uploadId: string): void {
    const entry = this.stagedUploads.get(uploadId);
    if (!entry) return;
    this.stagedUploads.delete(uploadId);
    try {
      fs.rmSync(entry.tempPath, { force: true });
    } catch {
      // ignore
    }
  }

  public submitTranscriptionJob(params: {
    readonly modelId?: string;
    readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
    readonly filePath?: string;
    readonly audioBase64?: string;
    readonly uploadId?: string;
    readonly filename?: string;
    readonly maxChunkDurationSec?: number;
    readonly overlapSec?: number;
    readonly numThreads?: number;
  }): { readonly ok: boolean; readonly statusCode: number; readonly job?: CompanionJobRecord; readonly code?: string; readonly message?: string } {
    const runtime = this.neuralEngine.getStatus();
    if (!runtime.available) {
      return {
        ok: false,
        statusCode: 503,
        code: 'LOCAL_NEURAL_RUNTIME_UNAVAILABLE',
        message: 'Local Sherpa-ONNX neural runtime or verified ONNX models are not installed on this machine.',
      };
    }

    let resolvedPath: string | undefined;
    let audioBytes: Buffer | undefined;
    let sourceName = typeof params.filename === 'string' && params.filename.trim() ? path.basename(params.filename.trim()) : 'audio.wav';

    if (params.filePath !== undefined) {
      const pathCheck = validateLocalAudioFilePath(params.filePath);
      if (!pathCheck.ok || !pathCheck.resolvedPath) {
        return {
          ok: false,
          statusCode: pathCheck.code === 'PATH_TRAVERSAL_REJECTED' ? 403 : 400,
          code: pathCheck.code ?? 'INVALID_FILE_PATH',
          message: pathCheck.message ?? 'Invalid file path.',
        };
      }
      resolvedPath = pathCheck.resolvedPath;
      sourceName = path.basename(resolvedPath);
    } else if (typeof params.uploadId === 'string' && params.uploadId.trim().length > 0) {
      this.sweepExpiredUploads();
      const staged = this.stagedUploads.get(params.uploadId.trim());
      if (!staged) {
        return { ok: false, statusCode: 404, code: 'UPLOAD_NOT_FOUND', message: 'Staged uploadId not found or expired.' };
      }
      this.stagedUploads.delete(staged.uploadId);
      try {
        audioBytes = fs.readFileSync(staged.tempPath);
        sourceName = staged.filename || sourceName;
      } catch {
        return { ok: false, statusCode: 500, code: 'UPLOAD_READ_FAILED', message: 'Failed to read staged audio upload.' };
      } finally {
        try {
          fs.rmSync(staged.tempPath, { force: true });
        } catch {
          // ignore
        }
      }
      if (audioBytes.byteLength === 0) {
        return { ok: false, statusCode: 400, code: 'EMPTY_AUDIO', message: 'Staged audio upload is empty.' };
      }
    } else if (typeof params.audioBase64 === 'string' && params.audioBase64.trim().length > 0) {
      try {
        audioBytes = Buffer.from(params.audioBase64, 'base64');
      } catch {
        return { ok: false, statusCode: 400, code: 'INVALID_BASE64', message: 'Invalid base64 audio payload.' };
      }
      if (audioBytes.byteLength === 0) {
        return { ok: false, statusCode: 400, code: 'EMPTY_AUDIO', message: 'Decoded audio payload is empty.' };
      }
      if (audioBytes.byteLength > MAX_STAGED_UPLOAD_BYTES) {
        return { ok: false, statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Inline base64 audio exceeds 64 MiB limit; use chunked upload or local file path.' };
      }
    } else {
      return {
        ok: false,
        statusCode: 400,
        code: 'MISSING_AUDIO_INPUT',
        message: 'Either filePath, uploadId, or audioBase64 must be provided.',
      };
    }

    const languageHint =
      params.languageHint === 'fa' ||
      params.languageHint === 'en' ||
      params.languageHint === 'fa-en' ||
      params.languageHint === 'auto'
        ? params.languageHint
        : 'auto';

    const selectedModel = this.neuralEngine.selectModel(params.modelId, languageHint);
    if (!selectedModel) {
      return {
        ok: false,
        statusCode: 503,
        code: 'LOCAL_MODEL_NOT_INSTALLED',
        message: 'No verified local ONNX model available.',
      };
    }

    const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const abortController = new AbortController();

    const initialRecord: CompanionJobRecord = {
      jobId,
      status: 'RUNNING',
      modelId: selectedModel.modelId,
      languageHint,
      sourceName,
      progressPct: 0,
      currentChunk: 0,
      totalChunks: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      elapsedMs: 0,
      partialText: '',
      result: null,
      errorCode: null,
      errorMessage: null,
    };

    const entry: InternalJobEntry = { record: initialRecord, abortController };
    this.jobs.set(jobId, entry);
    this.trimOldJobs();

    const startedMs = performance.now();
    // Execute asynchronous local CPU neural inference (zero transcript logging)
    void this.neuralEngine
      .transcribe({
        modelId: selectedModel.modelId,
        languageHint,
        audioFilePath: resolvedPath,
        audioBytes,
        filename: sourceName,
        maxChunkDurationSec: params.maxChunkDurationSec,
        overlapSec: params.overlapSec,
        numThreads: params.numThreads,
        signal: abortController.signal,
        onProgress: (prog) => {
          if (entry.record.status === 'CANCELLED') return;
          entry.record = {
            ...entry.record,
            status: 'RUNNING',
            progressPct: prog.percent,
            currentChunk: prog.currentChunk,
            totalChunks: prog.totalChunks,
            elapsedMs: prog.elapsedMs,
            partialText: prog.partialText,
            updatedAtIso: new Date().toISOString(),
          };
        },
      })
      .then((result) => {
        if (entry.record.status === 'CANCELLED') return;
        entry.record = {
          ...entry.record,
          status: 'COMPLETED',
          progressPct: 100,
          elapsedMs: Math.round(performance.now() - startedMs),
          partialText: result.rawText,
          result,
          updatedAtIso: new Date().toISOString(),
        };
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (abortController.signal.aborted || msg === 'TRANSCRIPTION_CANCELLED') {
          entry.record = {
            ...entry.record,
            status: 'CANCELLED',
            elapsedMs: Math.round(performance.now() - startedMs),
            errorCode: 'TRANSCRIPTION_CANCELLED',
            errorMessage: 'Transcription job cancelled by user.',
            updatedAtIso: new Date().toISOString(),
          };
          return;
        }
        const isFormat = /format|riff|wav|decode|unsupported|empty|corrupt/i.test(msg);
        entry.record = {
          ...entry.record,
          status: 'FAILED',
          elapsedMs: Math.round(performance.now() - startedMs),
          errorCode: isFormat ? 'UNSUPPORTED_OR_CORRUPT_AUDIO' : 'LOCAL_INFERENCE_FAILED',
          errorMessage: msg.slice(0, 320),
          updatedAtIso: new Date().toISOString(),
        };
      });

    return { ok: true, statusCode: 202, job: initialRecord };
  }

  public getJob(jobId: string): CompanionJobRecord | null {
    return this.jobs.get(jobId)?.record ?? null;
  }

  public cancelJob(jobId: string): { readonly ok: boolean; readonly job?: CompanionJobRecord } {
    const entry = this.jobs.get(jobId);
    if (!entry) return { ok: false };
    if (entry.record.status === 'RUNNING' || entry.record.status === 'QUEUED') {
      entry.abortController.abort();
      entry.record = {
        ...entry.record,
        status: 'CANCELLED',
        errorCode: 'TRANSCRIPTION_CANCELLED',
        errorMessage: 'Transcription job cancelled by user.',
        updatedAtIso: new Date().toISOString(),
      };
    }
    return { ok: true, job: entry.record };
  }

  public createExpressRouter(options?: CompanionRouterOptions): Router {
    const router = express.Router();
    const allowSameOriginProxyHost = Boolean(options?.allowSameOriginProxyHost);

    // Strict loopback + DNS rebinding + Origin guard middleware on ALL Companion routes
    router.use((req: Request, res: Response, next) => {
      const remoteAddr = req.socket?.remoteAddress ?? req.ip;
      if (!isLoopbackRemoteAddress(remoteAddr)) {
        res.status(403).json({
          error: 'IPC_LOOPBACK_ONLY',
          message: 'AVAPARDAZ Local Companion only accepts loopback connections (127.0.0.1 / ::1).',
        });
        return;
      }

      const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
      const rawForwardedHost =
        typeof req.headers['x-forwarded-host'] === 'string'
          ? req.headers['x-forwarded-host'].split(',')[0].trim().toLowerCase()
          : '';
      const effectiveHost = allowSameOriginProxyHost && rawForwardedHost ? rawForwardedHost : rawHost;
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

      let sameOriginPreviewMatch = false;
      if (allowSameOriginProxyHost && origin && origin !== 'null') {
        try {
          const originHost = new URL(origin).host.toLowerCase();
          sameOriginPreviewMatch =
            Boolean(originHost) && (originHost === effectiveHost || originHost === rawHost);
        } catch {
          sameOriginPreviewMatch = false;
        }
      }

      const hostOk =
        isAllowedLoopbackHostHeader(req.headers.host) ||
        (allowSameOriginProxyHost &&
          Boolean(effectiveHost) &&
          (!origin || origin === 'null' || sameOriginPreviewMatch));

      if (!hostOk) {
        res.status(403).json({
          error: 'DNS_REBINDING_BLOCKED',
          message: 'Host header must be localhost, 127.0.0.1, or [::1].',
        });
        return;
      }

      const originOk = isAllowedCompanionOrigin(origin) || sameOriginPreviewMatch;
      if (!originOk) {
        res.status(403).json({
          error: 'UNTRUSTED_ORIGIN_BLOCKED',
          message: 'Local Companion rejected cross-origin request from untrusted origin.',
        });
        return;
      }

      if (origin && origin !== 'null') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    // Dedicated JSON parser with safe size limit for audio payloads
    router.use(express.json({ limit: '48mb' }));

    router.get('/health', (_req, res) => {
      res.json(this.getHealth());
    });

    router.post('/handshake', (req, res) => {
      const remoteAddr = req.socket?.remoteAddress ?? req.ip;
      const out = this.ipcBridge.handshake(req.body as CompanionHandshakeRequest, remoteAddr);
      res.status(out.statusCode).json(out.body);
    });

    router.post('/ipc', (req, res) => {
      const remoteAddr = req.socket?.remoteAddress ?? req.ip;
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

      const auth = this.ipcBridge.verifyAuthorizedIpcCall({
        remoteAddress: remoteAddr,
        bearerToken,
        envelope: req.body,
      });

      if (!auth.ok || !auth.envelope) {
        res.status(auth.statusCode).json({
          error: auth.code ?? 'IPC_UNAUTHORIZED',
          message: auth.message ?? 'Unauthorized Companion IPC request.',
        });
        return;
      }

      const { command, payload } = auth.envelope;
      const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

      switch (command) {
        case 'CAPABILITY_LIST': {
          const status = this.neuralEngine.getStatus();
          res.json({
            ok: true,
            serviceVersion: COMPANION_SERVICE_VERSION,
            runtime: status,
          });
          return;
        }

        case 'HOST_CAPABILITY_MATRIX': {
          res.json({
            ok: true,
            hostId: this.auditionAdapter.hostId,
            adapterVersion: this.auditionAdapter.adapterVersion,
            capabilities: this.auditionAdapter.getHostCapabilityMatrix(),
          });
          return;
        }

        case 'JOB_SUBMIT': {
          const submitted = this.submitTranscriptionJob({
            modelId: typeof p.modelId === 'string' ? p.modelId : undefined,
            languageHint: typeof p.languageHint === 'string' ? (p.languageHint as 'fa' | 'en' | 'fa-en' | 'auto') : 'auto',
            filePath: typeof p.filePath === 'string' ? p.filePath : undefined,
            audioBase64: typeof p.audioBase64 === 'string' ? p.audioBase64 : undefined,
            uploadId: typeof p.uploadId === 'string' ? p.uploadId : undefined,
            filename: typeof p.filename === 'string' ? p.filename : undefined,
            maxChunkDurationSec: typeof p.maxChunkDurationSec === 'number' ? p.maxChunkDurationSec : undefined,
            overlapSec: typeof p.overlapSec === 'number' ? p.overlapSec : undefined,
            numThreads: typeof p.numThreads === 'number' ? p.numThreads : undefined,
          });
          if (!submitted.ok) {
            res.status(submitted.statusCode).json({
              ok: false,
              error: submitted.code,
              message: submitted.message,
            });
            return;
          }
          res.status(202).json({ ok: true, job: submitted.job });
          return;
        }

        case 'JOB_STATUS': {
          const jobId = typeof p.jobId === 'string' ? p.jobId : '';
          const job = this.getJob(jobId);
          if (!job) {
            res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND', message: 'Unknown jobId.' });
            return;
          }
          res.json({ ok: true, job });
          return;
        }

        case 'JOB_CANCEL': {
          const jobId = typeof p.jobId === 'string' ? p.jobId : '';
          const cancelled = this.cancelJob(jobId);
          if (!cancelled.ok) {
            res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND', message: 'Unknown jobId.' });
            return;
          }
          res.json({ ok: true, job: cancelled.job });
          return;
        }

        case 'CAPABILITY_EXECUTE': {
          const action = typeof p.action === 'string' ? p.action : '';
          if (action === 'AUDIO_UPLOAD_INIT') {
            const init = this.initStagedUpload(typeof p.filename === 'string' ? p.filename : undefined);
            res.json(init);
            return;
          }
          if (action === 'AUDIO_UPLOAD_CHUNK') {
            const uploadId = typeof p.uploadId === 'string' ? p.uploadId : '';
            const chunkBase64 = typeof p.chunkBase64 === 'string' ? p.chunkBase64 : '';
            const appended = this.appendStagedUploadChunk(uploadId, chunkBase64);
            if (!appended.ok) {
              res.status(appended.statusCode).json({
                ok: false,
                error: appended.code,
                message: appended.message,
              });
              return;
            }
            res.json({ ok: true, uploadId, receivedBytes: appended.receivedBytes });
            return;
          }
          if (action === 'AUDIO_UPLOAD_ABORT') {
            const uploadId = typeof p.uploadId === 'string' ? p.uploadId : '';
            if (uploadId) this.abortStagedUpload(uploadId);
            res.json({ ok: true });
            return;
          }
          if (action === 'MODEL_UNLOAD') {
            res.json({ ok: true, ...this.neuralEngine.unloadActiveModel() });
            return;
          }
          if (action === 'EXPORT_TRANSCRIPT') {
            const fmt = p.format as TranscriptExportFormat;
            if (!['txt', 'srt', 'vtt', 'json'].includes(fmt)) {
              res.status(400).json({ ok: false, error: 'INVALID_EXPORT_FORMAT', message: 'Supported formats: txt, srt, vtt, json.' });
              return;
            }
            const segs = Array.isArray(p.segments) ? (p.segments as ExportableTranscriptSegment[]) : [];
            const selectedIds = Array.isArray(p.selectedIds) ? (p.selectedIds as string[]) : undefined;
            const offset = typeof p.timelineOffsetSec === 'number' ? p.timelineOffsetSec : 0;
            const exported = exportTranscript({
              format: fmt,
              segments: segs,
              selectedIds,
              timelineOffsetSec: offset,
              includeSpeakerLabels: Boolean(p.includeSpeakerLabels),
              metadata: typeof p.metadata === 'object' && p.metadata !== null ? (p.metadata as Record<string, unknown>) : undefined,
            });
            res.json({ ok: true, exported });
            return;
          }
          res.status(400).json({ ok: false, error: 'UNSUPPORTED_ACTION', message: `Unsupported action "${action}".` });
          return;
        }

        default:
          res.status(400).json({ ok: false, error: 'UNSUPPORTED_COMMAND', message: 'Unsupported IPC command.' });
      }
    });

    // Always return JSON on body-parser / middleware errors (never HTML error pages)
    router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status =
        typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
          ? (err as { status: number }).status
          : 400;
      const message = err instanceof Error ? err.message : 'Companion request error.';
      res.status(status).json({
        ok: false,
        error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'COMPANION_REQUEST_ERROR',
        message,
      });
    });

    return router;
  }
}
