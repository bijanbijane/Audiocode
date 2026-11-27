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
import {
  CompanionLifecycleManager,
  type CompanionLifecycleState,
} from './CompanionLifecycleManager';
import {
  CompanionAudioTransferManager,
  type CompanionAudioTransferFormat,
} from './CompanionAudioTransfer';
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
import { sanitizeDiagnosticString } from '../../security/SecurityTrustBoundaryGuards';
import { mapCompanionJobResultForExecutionMode } from './CompanionJobResultMapper';

export const COMPANION_SERVICE_VERSION = '1.0.0' as const;

export type CompanionJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface CompanionSourceIdentity {
  readonly documentId?: string;
  readonly displayName?: string;
  readonly filePath?: string;
  readonly fileSizeBytes?: number;
  readonly fileModifiedMs?: number;
  readonly audioSha256?: string;
}

export interface CompanionJobRecord {
  readonly jobId: string;
  readonly status: CompanionJobState;
  readonly modelId: string | null;
  readonly languageHint: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly sourceName: string;
  readonly sourceIdentity?: CompanionSourceIdentity;
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
  readonly ownerId: string;
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
  readonly ownerId: string;
  readonly tempPath: string;
  readonly filename: string;
  readonly createdAtMs: number;
  writeFd: number | null;
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
const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024; // 256 KiB per-chunk network policy
const STAGED_UPLOAD_TTL_MS = 15 * 60 * 1000;

async function readSmallFileBoundedToBase64(
  filePath: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`Sample file size (${stat.size}) out of allowed bounds.`);
  }
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const chunkBuf = Buffer.allocUnsafe(Math.min(256 * 1024, stat.size));
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(chunkBuf.byteLength, stat.size - offset);
      const { bytesRead } = await fh.read(chunkBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      parts.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
      offset += bytesRead;
    }
    return Buffer.concat(parts).toString('base64');
  } finally {
    await fh.close().catch(() => {});
  }
}

export class LocalCompanionService {
  public readonly ipcBridge: CompanionIpcBridge;
  public readonly auditionAdapter: AdobeAuditionHostAdapter;
  public readonly neuralEngine: LocalSherpaNeuralEngine;
  public readonly lifecycleManager: CompanionLifecycleManager;
  public readonly audioTransfers: CompanionAudioTransferManager;
  private readonly jobs = new Map<string, InternalJobEntry>();
  private readonly stagedUploads = new Map<string, StagedAudioUpload>();
  private readonly uploadStagingDir: string;
  private readonly handshakeTimestampsMs: number[] = [];
  private readonly maxRetainedJobs: number;
  private readonly maxConcurrentJobs: number;

  constructor(options?: {
    readonly neuralEngine?: LocalSherpaNeuralEngine;
    readonly maxRetainedJobs?: number;
    readonly maxConcurrentJobs?: number;
    readonly bindHost?: string;
    readonly bindPort?: number;
    readonly lockFilePath?: string;
    readonly transferStagingDir?: string;
    readonly maxTransferBytes?: number;
    readonly maxTotalStagingBytes?: number;
    readonly maxConcurrentTransfers?: number;
  }) {
    this.ipcBridge = new CompanionIpcBridge();
    this.auditionAdapter = new AdobeAuditionHostAdapter();
    this.neuralEngine = options?.neuralEngine ?? new LocalSherpaNeuralEngine();
    this.lifecycleManager = new CompanionLifecycleManager({
      serviceVersion: COMPANION_SERVICE_VERSION,
      ipcProtocolVersion: COMPANION_IPC_PROTOCOL_VERSION,
      bindHost: options?.bindHost,
      bindPort: options?.bindPort,
      lockFilePath: options?.lockFilePath,
      initialState: 'STARTING',
    });
    this.audioTransfers = new CompanionAudioTransferManager({
      stagingDir: options?.transferStagingDir,
      maxTransferBytes: options?.maxTransferBytes,
      maxTotalStagingBytes: options?.maxTotalStagingBytes,
      maxConcurrentTransfers: options?.maxConcurrentTransfers,
    });
    this.uploadStagingDir = path.resolve(
      options?.transferStagingDir
        ? path.join(options.transferStagingDir, 'uploads')
        : path.join(os.tmpdir(), 'avapardaz-companion-uploads'),
    );
    this.cleanupOrphanedUploadsOnStartup();
    this.maxRetainedJobs = Math.max(8, Math.min(200, options?.maxRetainedJobs ?? 50));
    this.maxConcurrentJobs = Math.max(1, Math.min(16, options?.maxConcurrentJobs ?? 4));
    this.markServerBound();
  }

  private cleanupOrphanedUploadsOnStartup(): number {
    if (!fs.existsSync(this.uploadStagingDir)) return 0;
    let cleaned = 0;
    try {
      const lstat = fs.lstatSync(this.uploadStagingDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) return 0;
      for (const name of fs.readdirSync(this.uploadStagingDir)) {
        if (/^up_[a-f0-9]{16,32}\.bin$/i.test(name)) {
          try {
            fs.rmSync(path.resolve(this.uploadStagingDir, name), { force: true });
            cleaned++;
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    return cleaned;
  }

  public markServerBound(): void {
    if (this.lifecycleManager.getState() === 'STARTING') {
      this.lifecycleManager.transition('PORT_BOUND', 'HTTP loopback listener bound');
    }
    if (this.lifecycleManager.getState() === 'PORT_BOUND') {
      this.lifecycleManager.transition('AUTH_READY', 'HMAC session handshake ready');
    }
    this.syncLifecycleState();
  }

  private getActiveJobCount(): number {
    return Array.from(this.jobs.values()).filter(
      (j) => j.record.status === 'QUEUED' || j.record.status === 'RUNNING',
    ).length;
  }

  private syncLifecycleState(): CompanionLifecycleState {
    const runtime = this.neuralEngine.getStatus();
    return this.lifecycleManager.syncOperationalState({
      runtimeAvailable: runtime.available,
      activeJobs: this.getActiveJobCount(),
    });
  }

  public beginGracefulShutdown(reason: string): void {
    for (const entry of this.jobs.values()) {
      if (entry.record.status === 'RUNNING' || entry.record.status === 'QUEUED') {
        entry.abortController.abort();
      }
    }
    for (const uploadId of Array.from(this.stagedUploads.keys())) {
      this.abortStagedUpload(uploadId);
    }
    this.audioTransfers.cleanupAll();
    this.neuralEngine.unloadActiveModel();
    this.lifecycleManager.beginGracefulShutdown(reason);
  }

  public getHealth() {
    const runtime = this.neuralEngine.getStatus();
    const activeJobs = this.getActiveJobCount();
    const lifecycleState = this.lifecycleManager.syncOperationalState({
      runtimeAvailable: runtime.available,
      activeJobs,
    });
    const sampleAudio = this.neuralEngine.getBundledSampleAudioPath();
    this.audioTransfers.memoryAccountant.setExternalMetric(
      'nativeRuntimeMemory',
      process.memoryUsage().rss,
    );
    return {
      service: 'avapardaz-local-companion',
      serviceVersion: COMPANION_SERVICE_VERSION,
      ipcProtocolVersion: COMPANION_IPC_PROTOCOL_VERSION,
      instanceId: this.lifecycleManager.identity.instanceId,
      installationId: this.lifecycleManager.identity.installationId,
      pid: this.lifecycleManager.identity.pid,
      lifecycleState,
      offlineOnlyEnforced: true,
      cloudUploadDisabled: true,
      runtime,
      sampleAudioAvailable: Boolean(sampleAudio),
      sampleAudioFilename: sampleAudio?.filename ?? null,
      activeJobs,
      maxConcurrentJobs: this.maxConcurrentJobs,
      activeTransfers: this.audioTransfers.getActiveSessionCount(),
      reservedStagingBytes: this.audioTransfers.getTotalReservedStagingBytes(),
      memoryAccounting: this.audioTransfers.getMemoryAccounting(),
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

  private closeUploadFd(up: StagedAudioUpload): void {
    if (up.writeFd !== null) {
      const fd = up.writeFd;
      up.writeFd = null;
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  private sweepExpiredUploads(): void {
    const now = Date.now();
    for (const [id, up] of this.stagedUploads.entries()) {
      if (now - up.createdAtMs > STAGED_UPLOAD_TTL_MS) {
        this.stagedUploads.delete(id);
        this.closeUploadFd(up);
        try {
          fs.rmSync(up.tempPath, { force: true });
        } catch {
          // ignore cleanup race
        }
      }
    }
  }

  public initStagedUpload(
    filename?: string,
    ownerId = 'local-default',
  ): { readonly ok: boolean; readonly uploadId: string; readonly filename: string } {
    this.sweepExpiredUploads();
    const uploadId = `up_${crypto.randomBytes(16).toString('hex')}`;
    const safeName =
      typeof filename === 'string' && filename.trim().length > 0
        ? path.basename(filename.trim()).replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_')
        : 'audio.wav';
    fs.mkdirSync(this.uploadStagingDir, { recursive: true, mode: 0o700 });
    const tempPath = path.resolve(this.uploadStagingDir, `${uploadId}.bin`);
    const writeFd = fs.openSync(tempPath, 'wx', 0o600);
    this.stagedUploads.set(uploadId, {
      uploadId,
      ownerId,
      tempPath,
      filename: safeName,
      createdAtMs: Date.now(),
      writeFd,
      receivedBytes: 0,
    });
    return { ok: true, uploadId, filename: safeName };
  }

  public appendStagedUploadChunk(
    uploadId: string,
    chunkBase64: string,
    ownerId?: string,
  ): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly receivedBytes?: number;
    readonly code?: string;
    readonly message?: string;
  } {
    this.sweepExpiredUploads();
    const entry = this.stagedUploads.get(uploadId);
    if (!entry) {
      return { ok: false, statusCode: 404, code: 'UPLOAD_NOT_FOUND', message: 'Unknown or expired uploadId.' };
    }
    if (ownerId && ownerId !== entry.ownerId) {
      return {
        ok: false,
        statusCode: 403,
        code: 'UPLOAD_OWNER_MISMATCH',
        message: 'Access denied: upload belongs to a different session.',
      };
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(chunkBase64, 'base64');
    } catch {
      return { ok: false, statusCode: 400, code: 'INVALID_BASE64', message: 'Invalid base64 audio chunk.' };
    }
    if (bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
      return {
        ok: false,
        statusCode: 413,
        code: 'CHUNK_SIZE_EXCEEDS_POLICY',
        message: `Upload chunk (${bytes.byteLength} bytes) exceeds 256 KiB chunk policy.`,
      };
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
    if (entry.writeFd === null) {
      return { ok: false, statusCode: 409, code: 'UPLOAD_CLOSED', message: 'Staged upload is already closed.' };
    }
    fs.writeSync(entry.writeFd, bytes, 0, bytes.byteLength, entry.receivedBytes);
    entry.receivedBytes += bytes.byteLength;
    return { ok: true, statusCode: 200, receivedBytes: entry.receivedBytes };
  }

  public abortStagedUpload(uploadId: string, ownerId?: string): void {
    const entry = this.stagedUploads.get(uploadId);
    if (!entry) return;
    if (ownerId && ownerId !== entry.ownerId) return;
    this.stagedUploads.delete(uploadId);
    this.closeUploadFd(entry);
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
    readonly transferId?: string;
    readonly ownerId?: string;
    readonly filename?: string;
    readonly sourceIdentity?: CompanionSourceIdentity;
    readonly maxChunkDurationSec?: number;
    readonly overlapSec?: number;
    readonly numThreads?: number;
  }): {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly job?: CompanionJobRecord;
    readonly code?: string;
    readonly message?: string;
  } {
    if (this.lifecycleManager.getState() === 'SHUTTING_DOWN') {
      return {
        ok: false,
        statusCode: 503,
        code: 'COMPANION_SHUTTING_DOWN',
        message: 'Local Companion is shutting down and not accepting new jobs.',
      };
    }

    if (this.getActiveJobCount() >= this.maxConcurrentJobs) {
      return {
        ok: false,
        statusCode: 429,
        code: 'CONCURRENT_JOB_LIMIT_EXCEEDED',
        message: `Maximum concurrent transcription jobs (${this.maxConcurrentJobs}) reached; wait or cancel an active job.`,
      };
    }

    const runtime = this.neuralEngine.getStatus();
    if (!runtime.available) {
      return {
        ok: false,
        statusCode: 503,
        code: 'LOCAL_NEURAL_RUNTIME_UNAVAILABLE',
        message: 'Local Sherpa-ONNX neural runtime or verified ONNX models are not installed on this machine.',
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

    let resolvedPath: string | undefined;
    let audioBytes: Buffer | undefined;
    let acquiredTransferSource: import('./CompanionAudioTransfer').CompanionAudioSource | undefined;
    let stagedTempPathToCleanOnFinish: string | undefined;
    let sourceName =
      typeof params.filename === 'string' && params.filename.trim()
        ? path.basename(params.filename.trim())
        : 'audio.wav';
    let mergedSourceIdentity: CompanionSourceIdentity | undefined = params.sourceIdentity;

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
    } else if (typeof params.transferId === 'string' && params.transferId.trim().length > 0) {
      const acquired = this.audioTransfers.acquireAudioSource(params.transferId.trim(), {
        ownerId: params.ownerId,
      });
      if (!acquired.ok || !acquired.source) {
        return {
          ok: false,
          statusCode: acquired.statusCode,
          code: acquired.code ?? 'TRANSFER_NOT_FOUND',
          message: acquired.message ?? 'Audio transfer not found or not finalized.',
        };
      }
      acquiredTransferSource = acquired.source;
      sourceName = acquired.source.filename || sourceName;
      mergedSourceIdentity = {
        ...mergedSourceIdentity,
        audioSha256: acquired.source.sha256,
      };
    } else if (typeof params.uploadId === 'string' && params.uploadId.trim().length > 0) {
      this.sweepExpiredUploads();
      const staged = this.stagedUploads.get(params.uploadId.trim());
      if (!staged) {
        return {
          ok: false,
          statusCode: 404,
          code: 'UPLOAD_NOT_FOUND',
          message: 'Staged uploadId not found or expired.',
        };
      }
      if (params.ownerId && params.ownerId !== staged.ownerId) {
        return {
          ok: false,
          statusCode: 403,
          code: 'UPLOAD_OWNER_MISMATCH',
          message: 'Access denied: staged upload belongs to a different session.',
        };
      }
      this.stagedUploads.delete(staged.uploadId);
      this.closeUploadFd(staged);
      if (staged.receivedBytes === 0) {
        try {
          fs.rmSync(staged.tempPath, { force: true });
        } catch {
          // ignore
        }
        return { ok: false, statusCode: 400, code: 'EMPTY_AUDIO', message: 'Staged audio upload is empty.' };
      }
      // Hand off on-disk file path instead of loading entire upload into RAM via readFileSync
      resolvedPath = staged.tempPath;
      stagedTempPathToCleanOnFinish = staged.tempPath;
      sourceName = staged.filename || sourceName;
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
        return {
          ok: false,
          statusCode: 413,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Inline base64 audio exceeds 64 MiB limit; use chunked transfer or local file path.',
        };
      }
    } else {
      return {
        ok: false,
        statusCode: 400,
        code: 'MISSING_AUDIO_INPUT',
        message: 'Either filePath, transferId, uploadId, or audioBase64 must be provided.',
      };
    }

    const jobId = `job_${crypto.randomBytes(16).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const abortController = new AbortController();

    const initialRecord: CompanionJobRecord = {
      jobId,
      status: 'RUNNING',
      modelId: selectedModel.modelId,
      languageHint,
      sourceName,
      sourceIdentity: mergedSourceIdentity,
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

    const entry: InternalJobEntry = {
      record: initialRecord,
      abortController,
      ownerId: params.ownerId ?? 'local-default',
    };
    this.jobs.set(jobId, entry);
    this.trimOldJobs();
    this.syncLifecycleState();

    const startedMs = performance.now();

    const runAsyncJob = async () => {
      let finalTransferState: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'COMPLETED';
      try {
        let targetFilePath = resolvedPath;
        if (acquiredTransferSource) {
          const prepared = await acquiredTransferSource.prepareWavFileStreaming({
            signal: abortController.signal,
          });
          targetFilePath = prepared.wavFilePath;
        }

        const result = await this.neuralEngine.transcribe({
          modelId: selectedModel.modelId,
          languageHint,
          audioFilePath: targetFilePath,
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
        });

        if (entry.record.status === 'CANCELLED') {
          finalTransferState = 'CANCELLED';
          return;
        }
        entry.record = {
          ...entry.record,
          status: 'COMPLETED',
          progressPct: 100,
          elapsedMs: Math.round(performance.now() - startedMs),
          partialText: result.rawText,
          result,
          updatedAtIso: new Date().toISOString(),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          abortController.signal.aborted ||
          msg === 'TRANSCRIPTION_CANCELLED' ||
          msg === 'TRANSFER_PROCESSING_ABORTED'
        ) {
          finalTransferState = 'CANCELLED';
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
        finalTransferState = 'FAILED';
        const isFormat = /format|riff|wav|decode|unsupported|empty|corrupt/i.test(msg);
        entry.record = {
          ...entry.record,
          status: 'FAILED',
          elapsedMs: Math.round(performance.now() - startedMs),
          errorCode: isFormat ? 'UNSUPPORTED_OR_CORRUPT_AUDIO' : 'LOCAL_INFERENCE_FAILED',
          errorMessage: sanitizeDiagnosticString(msg).slice(0, 320),
          updatedAtIso: new Date().toISOString(),
        };
      } finally {
        if (acquiredTransferSource) {
          await acquiredTransferSource.close(finalTransferState).catch(() => {});
        }
        if (stagedTempPathToCleanOnFinish) {
          try {
            fs.rmSync(stagedTempPathToCleanOnFinish, { force: true });
          } catch {
            // ignore
          }
        }
        this.syncLifecycleState();
      }
    };

    void runAsyncJob();

    return { ok: true, statusCode: 202, job: initialRecord };
  }

  public getJob(jobId: string, ownerId?: string): CompanionJobRecord | null {
    const entry = this.jobs.get(jobId);
    if (!entry || (ownerId !== undefined && entry.ownerId !== ownerId)) return null;
    return entry.record;
  }

  public listJobs(ownerId?: string): readonly CompanionJobRecord[] {
    return Array.from(this.jobs.values())
      .filter((entry) => ownerId === undefined || entry.ownerId === ownerId)
      .map((entry) => entry.record);
  }

  public cancelJob(jobId: string, ownerId?: string): { readonly ok: boolean; readonly job?: CompanionJobRecord } {
    const entry = this.jobs.get(jobId);
    if (!entry || (ownerId !== undefined && entry.ownerId !== ownerId)) return { ok: false };
    if (entry.record.status === 'RUNNING' || entry.record.status === 'QUEUED') {
      entry.abortController.abort();
      entry.record = {
        ...entry.record,
        status: 'CANCELLED',
        errorCode: 'TRANSCRIPTION_CANCELLED',
        errorMessage: 'Transcription job cancelled by user.',
        updatedAtIso: new Date().toISOString(),
      };
      this.syncLifecycleState();
    }
    return { ok: true, job: entry.record };
  }

  public createExpressRouter(options?: CompanionRouterOptions): Router {
    const router = express.Router();
    const allowSameOriginProxyHost = Boolean(options?.allowSameOriginProxyHost);

    // Strict loopback + DNS rebinding + Origin + query-token guard middleware on ALL Companion routes
    router.use((req: Request, res: Response, next) => {
      res.setHeader('Cache-Control', 'no-store');

      // Forbid passing tokens in URL query string
      const queryObj = req.query as Record<string, unknown> | undefined;
      if (queryObj && typeof queryObj === 'object') {
        for (const key of Object.keys(queryObj)) {
          const lk = key.toLowerCase();
          if (
            lk === 'token' ||
            lk === 'session_token' ||
            lk === 'access_token' ||
            lk === 'authorization' ||
            lk === 'api_key'
          ) {
            res.status(400).json({
              error: 'IPC_TOKEN_IN_QUERY_FORBIDDEN',
              message: 'Passing authentication tokens in URL query parameters is forbidden.',
            });
            return;
          }
        }
      }

      const remoteAddr = req.socket?.remoteAddress ?? req.ip;
      if (!isLoopbackRemoteAddress(remoteAddr)) {
        res.status(403).json({
          error: 'IPC_LOOPBACK_ONLY',
          message: 'AVAPARDAZ Local Companion only accepts loopback connections (127.0.0.1 / ::1).',
        });
        return;
      }

      const secFetchSite =
        typeof req.headers['sec-fetch-site'] === 'string'
          ? req.headers['sec-fetch-site'].trim().toLowerCase()
          : undefined;
      if (secFetchSite === 'cross-site') {
        res.status(403).json({
          error: 'UNTRUSTED_ORIGIN_BLOCKED',
          message: 'Local Companion rejected cross-site browser request.',
        });
        return;
      }

      const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
      const rawForwardedHost =
        typeof req.headers['x-forwarded-host'] === 'string'
          ? req.headers['x-forwarded-host'].split(',')[0].trim().toLowerCase()
          : '';
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : undefined;

      // Strict DNS-rebinding defense: Host MUST be loopback (127.0.0.1 / localhost / [::1]).
      // Never accept arbitrary non-loopback Host merely because Origin also matches that Host.
      const hostOk = isAllowedLoopbackHostHeader(req.headers.host);
      if (!hostOk) {
        res.status(403).json({
          error: 'DNS_REBINDING_BLOCKED',
          message: 'Host header must be localhost, 127.0.0.1, or [::1].',
        });
        return;
      }

      // Same-origin reverse-proxy preview is allowed ONLY when Host is loopback and X-Forwarded-Host matches Origin.
      let sameOriginPreviewMatch = false;
      if (allowSameOriginProxyHost && rawForwardedHost && origin && origin.toLowerCase() !== 'null') {
        try {
          const parsed = new URL(origin);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            sameOriginPreviewMatch = parsed.host.toLowerCase() === rawForwardedHost;
          }
        } catch {
          sameOriginPreviewMatch = false;
        }
      }

      // Reject sandboxed web iframe Origin: null when Sec-Fetch-Site indicates a browser cross-context fetch.
      if (
        origin &&
        origin.toLowerCase() === 'null' &&
        secFetchSite !== undefined &&
        secFetchSite !== 'none'
      ) {
        res.status(403).json({
          error: 'UNTRUSTED_ORIGIN_BLOCKED',
          message: 'Local Companion rejected sandboxed null-origin browser request.',
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
      const nowMs = Date.now();
      while (this.handshakeTimestampsMs.length > 0 && nowMs - this.handshakeTimestampsMs[0] > 60_000) {
        this.handshakeTimestampsMs.shift();
      }
      if (this.handshakeTimestampsMs.length >= 60) {
        res.setHeader('Retry-After', '5');
        res.status(429).json({
          compatible: false,
          error: 'HANDSHAKE_RATE_LIMITED',
          message: 'Too many Companion handshake requests; retry shortly.',
        });
        return;
      }
      this.handshakeTimestampsMs.push(nowMs);

      const remoteAddr = req.socket?.remoteAddress ?? req.ip;
      const out = this.ipcBridge.handshake(req.body as CompanionHandshakeRequest, remoteAddr);
      res.status(out.statusCode).json(out.body);
    });

    router.post('/ipc', async (req, res) => {
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

      const envelope = envelope;
      const { command, payload } = envelope;
      const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

      switch (command) {
        case 'CAPABILITY_LIST': {
          const status = this.neuralEngine.getStatus();
          res.json({
            ok: true,
            serviceVersion: COMPANION_SERVICE_VERSION,
            runtime: status,
            capabilities: [
              'CAPABILITY_LIST',
              'HOST_CAPABILITY_MATRIX',
              'JOB_SUBMIT',
              'JOB_STATUS',
              'JOB_LIST',
              'JOB_CANCEL',
              'JOB_RECONNECT',
              'AUDIO_TRANSFER_INIT',
              'AUDIO_TRANSFER_CHUNK',
              'AUDIO_TRANSFER_FINALIZE',
              'AUDIO_TRANSFER_ABORT',
              'AUDIO_UPLOAD_INIT',
              'AUDIO_UPLOAD_CHUNK',
              'AUDIO_UPLOAD_ABORT',
              'GET_SAMPLE_PERSIAN_AUDIO',
              'INSTALL_NATIVE_RUNTIME',
              'MODEL_UNLOAD',
              'EXPORT_TRANSCRIPT',
            ],
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
          const rawSrcId =
            p.sourceIdentity && typeof p.sourceIdentity === 'object' && !Array.isArray(p.sourceIdentity)
              ? (p.sourceIdentity as Record<string, unknown>)
              : undefined;
          const sourceIdentity: CompanionSourceIdentity | undefined = rawSrcId
            ? {
                documentId: typeof rawSrcId.documentId === 'string' ? rawSrcId.documentId : undefined,
                displayName: typeof rawSrcId.displayName === 'string' ? rawSrcId.displayName : undefined,
                filePath: typeof rawSrcId.filePath === 'string' ? rawSrcId.filePath : undefined,
                fileSizeBytes: typeof rawSrcId.fileSizeBytes === 'number' ? rawSrcId.fileSizeBytes : undefined,
                fileModifiedMs: typeof rawSrcId.fileModifiedMs === 'number' ? rawSrcId.fileModifiedMs : undefined,
                audioSha256: typeof rawSrcId.audioSha256 === 'string' ? rawSrcId.audioSha256 : undefined,
              }
            : undefined;
          const submitted = this.submitTranscriptionJob({
            modelId: typeof p.modelId === 'string' ? p.modelId : undefined,
            languageHint: typeof p.languageHint === 'string' ? (p.languageHint as 'fa' | 'en' | 'fa-en' | 'auto') : 'auto',
            filePath: typeof p.filePath === 'string' ? p.filePath : undefined,
            audioBase64: typeof p.audioBase64 === 'string' ? p.audioBase64 : undefined,
            uploadId: typeof p.uploadId === 'string' ? p.uploadId : undefined,
            transferId: typeof p.transferId === 'string' ? p.transferId : undefined,
            ownerId: envelope.session_id,
            filename: typeof p.filename === 'string' ? p.filename : undefined,
            sourceIdentity,
            maxChunkDurationSec: typeof p.maxChunkDurationSec === 'number' ? p.maxChunkDurationSec : undefined,
            overlapSec: typeof p.overlapSec === 'number' ? p.overlapSec : undefined,
            numThreads: typeof p.numThreads === 'number' ? p.numThreads : undefined,
          });
          if (!submitted.ok) {
            res.status(submitted.statusCode).json({
              ok: false,
              error: submitted.code,
              message: submitted.message,
              request_id: envelope.request_id,
            });
            return;
          }
          res.status(202).json({ ok: true, job: submitted.job, request_id: envelope.request_id });
          return;
        }

        case 'JOB_STATUS':
        case 'JOB_RECONNECT': {
          const jobId = typeof p.jobId === 'string' ? p.jobId : '';
          const job = this.getJob(jobId, envelope.session_id);
          if (!job) {
            res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND', message: 'Unknown jobId.', request_id: envelope.request_id });
            return;
          }
          const responseJob = mapCompanionJobResultForExecutionMode(job, envelope.execution_mode);
          res.json({ ok: true, job: responseJob, reconnected: command === 'JOB_RECONNECT', request_id: envelope.request_id });
          return;
        }

        case 'JOB_LIST': {
          const jobs = this.listJobs(envelope.session_id).map((job) =>
            mapCompanionJobResultForExecutionMode(job, envelope.execution_mode),
          );
          res.json({ ok: true, jobs, request_id: envelope.request_id });
          return;
        }

        case 'JOB_CANCEL': {
          const jobId = typeof p.jobId === 'string' ? p.jobId : '';
          const cancelled = this.cancelJob(jobId, envelope.session_id);
          if (!cancelled.ok) {
            res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND', message: 'Unknown jobId.', request_id: envelope.request_id });
            return;
          }
          const responseJob = cancelled.job
            ? mapCompanionJobResultForExecutionMode(cancelled.job, envelope.execution_mode)
            : undefined;
          res.json({ ok: true, job: responseJob, request_id: envelope.request_id });
          return;
        }

        case 'CAPABILITY_EXECUTE': {
          const action = typeof p.action === 'string' ? p.action : '';
          const sessionOwnerId = envelope.session_id;
          if (action === 'AUDIO_TRANSFER_INIT') {
            const initRes = this.audioTransfers.initTransfer({
              filename: typeof p.filename === 'string' ? p.filename : undefined,
              format: p.format as CompanionAudioTransferFormat,
              sampleRateHz: Number(p.sampleRateHz),
              channels: Number(p.channels),
              endianness: p.endianness as 'little',
              expectedBytes: Number(p.expectedBytes),
              expectedFrames: Number(p.expectedFrames),
              totalChunks: Number(p.totalChunks),
              expectedSha256: typeof p.expectedSha256 === 'string' ? p.expectedSha256 : undefined,
              ownerId: sessionOwnerId,
            });
            res.status(initRes.statusCode).json(initRes);
            return;
          }
          if (action === 'AUDIO_TRANSFER_CHUNK') {
            const chunkRes = this.audioTransfers.appendChunk({
              transferId: typeof p.transferId === 'string' ? p.transferId : '',
              chunkIndex: Number(p.chunkIndex),
              chunkBase64: typeof p.chunkBase64 === 'string' ? p.chunkBase64 : '',
              chunkSha256: typeof p.chunkSha256 === 'string' ? p.chunkSha256 : undefined,
              ownerId: sessionOwnerId,
            });
            res.status(chunkRes.statusCode).json(chunkRes);
            return;
          }
          if (action === 'AUDIO_TRANSFER_FINALIZE') {
            const finRes = this.audioTransfers.finalizeTransfer(
              typeof p.transferId === 'string' ? p.transferId : '',
              { ownerId: sessionOwnerId },
            );
            res.status(finRes.statusCode).json(finRes);
            return;
          }
          if (action === 'AUDIO_TRANSFER_ABORT') {
            const aborted = this.audioTransfers.abortTransfer(
              typeof p.transferId === 'string' ? p.transferId : '',
              { ownerId: sessionOwnerId },
            );
            res.json({ ok: true, aborted });
            return;
          }
          if (action === 'AUDIO_UPLOAD_INIT') {
            const init = this.initStagedUpload(
              typeof p.filename === 'string' ? p.filename : undefined,
              sessionOwnerId,
            );
            res.json(init);
            return;
          }
          if (action === 'AUDIO_UPLOAD_CHUNK') {
            const uploadId = typeof p.uploadId === 'string' ? p.uploadId : '';
            const chunkBase64 = typeof p.chunkBase64 === 'string' ? p.chunkBase64 : '';
            const appended = this.appendStagedUploadChunk(uploadId, chunkBase64, sessionOwnerId);
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
            if (uploadId) this.abortStagedUpload(uploadId, sessionOwnerId);
            res.json({ ok: true });
            return;
          }
          if (action === 'MODEL_UNLOAD') {
            res.json({ ok: true, ...this.neuralEngine.unloadActiveModel() });
            return;
          }
          if (action === 'GET_SAMPLE_PERSIAN_AUDIO') {
            const sample = this.neuralEngine.getBundledSampleAudioPath();
            if (!sample) {
              res.status(404).json({
                ok: false,
                error: 'SAMPLE_AUDIO_NOT_AVAILABLE',
                message: 'Bundled Persian sample audio is unavailable on local disk.',
              });
              return;
            }
            try {
              const audioBase64 = await readSmallFileBoundedToBase64(sample.filePath);
              res.json({
                ok: true,
                filename: sample.filename,
                modelId: sample.modelId,
                mimeType: 'audio/wav',
                audioBase64,
              });
            } catch (err) {
              res.status(500).json({
                ok: false,
                error: 'SAMPLE_AUDIO_READ_FAILED',
                message: err instanceof Error ? err.message : 'Failed to read sample audio file.',
              });
            }
            return;
          }
          if (action === 'INSTALL_NATIVE_RUNTIME') {
            try {
              await this.neuralEngine.installShenavaRizehRuntime();
              this.syncLifecycleState();
              res.json({
                ok: true,
                health: this.getHealth(),
              });
            } catch (err) {
              res.status(500).json({
                ok: false,
                error: 'NATIVE_RUNTIME_INSTALL_FAILED',
                message: err instanceof Error ? err.message : 'Failed to install native runtime.',
              });
            }
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

    // Always return JSON on body-parser / middleware errors (never HTML error pages or internal paths)
    router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status =
        typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
          ? (err as { status: number }).status
          : 400;
      const message = sanitizeDiagnosticString(
        err instanceof Error ? err.message : 'Companion request error.',
      );
      res.status(status).json({
        ok: false,
        error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'COMPANION_REQUEST_ERROR',
        message,
      });
    });

    return router;
  }
}
