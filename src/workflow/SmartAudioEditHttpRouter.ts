/**
 * AVAPARDAZ — HARDENED SMART AUDIO EDIT HTTP ROUTER (/api/v2/smart-edit/*)
 *
 * Phase 1A Security Containment:
 * - Enforces AudioApiSecurityGuard (Local loopback/Origin/DNS-rebinding vs Hosted fail-closed auth)
 *   BEFORE any body parsing (express.raw / express.json).
 * - Enforces strict per-owner job isolation (anti-IDOR) on every read, preview, render, export, cancel, delete.
 * - Enforces replay protection on sensitive mutations and exports, per-owner concurrency & byte quotas,
 *   binary audio payload validation, timeout & client disconnect cancellation, and sanitized error responses.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import { LocalSherpaNeuralEngine } from '../asr-core/LocalSherpaNeuralEngine';
import { SHAHAB_FA_LITE_MANIFEST, ShahabLocalAsrRuntime } from '../asr-core/ShahabModelManifest';
import { ShahabZipformerAsrRuntime } from '../shahab/ShahabZipformerAsrRuntime';
import { sanitizePublicErrorOutput } from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';
import { sanitizeDiagnosticString } from '../security/SecurityTrustBoundaryGuards';
import {
  AudioApiSecurityGuard,
  validateBinaryAudioPayload,
} from '../security/AudioApiSecurityGuard';
import { SmartAudioEditError, SmartAudioEditPipeline } from './SmartAudioEditPipeline';
import { SmartAudioEditJobManager } from './SmartAudioEditJobManager';
import type { ShahabAsrEngine, SmartEditPreviewMode } from './SmartAudioEditContracts';

const DEFAULT_MAX_SMART_EDIT_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB
const DEFAULT_OPERATION_TIMEOUT_MS = 180_000; // 3 minutes
const SAFE_JOB_ID_RE = /^[a-zA-Z0-9_-]{4,80}$/;
const ALLOWED_UPLOAD_CONTENT_TYPE_RE =
  /^(audio\/(wav|wave|x-wav|mpeg|mp3|flac|ogg|webm|mp4|aac|aiff|x-aiff)|application\/octet-stream|application\/json)(;.*)?$/i;

function sanitizeErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return sanitizeDiagnosticString(sanitizePublicErrorOutput(raw));
}

function toHttpError(err: unknown): { status: number; code: string; message: string } {
  const code =
    err instanceof SmartAudioEditError
      ? err.code
      : err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'SMART_EDIT_ERROR';
  const message = sanitizeErr(err);

  if (code === 'JOB_ACCESS_DENIED') return { status: 403, code, message: 'دسترسی به این Job مجاز نیست.' };
  if (code === 'JOB_NOT_FOUND') return { status: 404, code, message: 'Job مورد نظر یافت نشد.' };
  if (code === 'MODEL_NOT_AVAILABLE' || code === 'SHAHAB_MODEL_INTEGRITY_FAILED') {
    return { status: 422, code, message };
  }
  if (code === 'AUDIO_DURATION_LIMIT_EXCEEDED' || code === 'PAYLOAD_TOO_LARGE') {
    return { status: 413, code, message };
  }
  if (
    code === 'SHAHAB_QUEUE_FULL' ||
    code === 'OWNER_CONCURRENCY_LIMIT_EXCEEDED' ||
    code === 'OWNER_JOB_QUOTA_EXCEEDED' ||
    code === 'ASR_CONCURRENCY_LIMIT' ||
    code === 'RENDER_CONCURRENCY_LIMIT'
  ) {
    return { status: 429, code, message };
  }
  if (
    code === 'ILLEGAL_JOB_STATE_TRANSITION' ||
    code === 'APPROVAL_GATE_BLOCKED' ||
    code === 'SOURCE_AUDIO_HASH_MISMATCH' ||
    code === 'EDL_OUT_OF_BOUNDS'
  ) {
    return { status: 409, code, message };
  }
  if (code === 'INVALID_AUDIO_INPUT') return { status: 400, code, message };
  if (code.includes('CANCELLED')) return { status: 499, code, message };
  return { status: 500, code, message };
}

function attachRequestAbortSignal(
  req: Request,
  res: Response,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly didTimeout: () => boolean; readonly didDisconnect: () => boolean; readonly cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  let disconnected = false;

  const onAborted = () => {
    disconnected = true;
    controller.abort();
  };
  const onClose = () => {
    if (!res.writableEnded) {
      disconnected = true;
      controller.abort();
    }
  };
  req.on('aborted', onAborted);
  res.on('close', onClose);

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    didDisconnect: () => disconnected,
    cleanup: () => {
      clearTimeout(timer);
      req.off('aborted', onAborted);
      res.off('close', onClose);
    },
  };
}

export function createSmartAudioEditHttpRouter(options?: {
  readonly neuralEngine?: LocalSherpaNeuralEngine;
  readonly shahabZipformerRuntime?: ShahabZipformerAsrRuntime;
  readonly asrEngine?: ShahabAsrEngine;
  readonly jobManager?: SmartAudioEditJobManager;
  readonly securityGuard?: AudioApiSecurityGuard;
  readonly maxUploadBytes?: number;
  readonly operationTimeoutMs?: number;
}): {
  readonly router: express.Router;
  readonly jobManager: SmartAudioEditJobManager;
  readonly securityGuard: AudioApiSecurityGuard;
} {
  const neuralEngine = options?.neuralEngine ?? new LocalSherpaNeuralEngine();
  const zipformerRuntime = options?.shahabZipformerRuntime ?? new ShahabZipformerAsrRuntime();
  const sherpaFallbackRuntime = new ShahabLocalAsrRuntime({ neuralEngine });
  const useZipformerPrimary =
    Boolean(options?.shahabZipformerRuntime) || zipformerRuntime.getRuntimeStatus().available;
  const activeAsrEngine: ShahabAsrEngine =
    options?.asrEngine ?? (useZipformerPrimary ? zipformerRuntime : sherpaFallbackRuntime);

  const pipeline = new SmartAudioEditPipeline({ asrEngine: activeAsrEngine });
  const securityGuard = options?.securityGuard ?? new AudioApiSecurityGuard();
  const jobManager =
    options?.jobManager ??
    new SmartAudioEditJobManager(pipeline, { requireExplicitOwnerId: true });
  const maxUploadBytes = Math.max(1024, options?.maxUploadBytes ?? DEFAULT_MAX_SMART_EDIT_UPLOAD_BYTES);
  const operationTimeoutMs = Math.max(100, options?.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);

  const router = express.Router();

  const resolveBundledSample = () =>
    zipformerRuntime.getBundledSampleAudioPath() ?? neuralEngine.getBundledSampleAudioPath();

  const requireValidJobId = (req: Request, res: Response, next: NextFunction) => {
    const jobId = String(req.params.jobId ?? '');
    if (!SAFE_JOB_ID_RE.test(jobId)) {
      res.status(400).json({
        error: 'INVALID_JOB_ID',
        code: 'INVALID_JOB_ID',
        message: 'شناسه Job نامعتبر است.',
      });
      return;
    }
    next();
  };

  const getOwnerId = (res: Response): string => {
    const ownerId = res.locals.avapardazAuth?.ownerId;
    if (!ownerId) {
      throw new SmartAudioEditError('AUTH_REQUIRED', 'احراز هویت الزامی است.');
    }
    return ownerId;
  };

  const handleRouteError = (req: Request, res: Response, err: unknown, jobIdForSnapshot?: string) => {
    if (res.writableEnded) return;
    const e = toHttpError(err);
    const ownerId = res.locals.avapardazAuth?.ownerId;
    if (e.code === 'JOB_ACCESS_DENIED') {
      securityGuard.recordSecurityEvent({
        eventType: 'IDOR_ATTEMPT_BLOCKED',
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: 403,
        code: 'JOB_ACCESS_DENIED',
        ownerId,
      });
      // Never return snapshot or job existence metadata on unauthorized access
      res.status(403).json({ error: e.code, code: e.code, message: e.message });
      return;
    }
    if (e.status === 429) {
      res.setHeader('Retry-After', '2');
    }
    let snapshot: unknown = undefined;
    if (jobIdForSnapshot && ownerId) {
      try {
        snapshot = jobManager.getJobSnapshot(jobIdForSnapshot, ownerId);
      } catch {
        snapshot = undefined;
      }
    }
    res.status(e.status).json({
      error: e.code,
      code: e.code,
      message: e.message,
      ...(snapshot ? { snapshot } : {}),
    });
  };

  router.get(
    '/status',
    securityGuard.middleware({
      requireAuth: securityGuard.config.mode === 'hosted',
      rateLimitBucket: 'smart-edit-status',
      rateLimitMax: 120,
    }),
    (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const bundledSample = resolveBundledSample();
      if (useZipformerPrimary) {
        const zt = zipformerRuntime.getRuntimeStatus();
        res.json({
          ok: true,
          engine01: {
            engine: zt.engine,
            modelId: zt.modelId,
            version: zt.modelVersion,
            upstreamModelId: zt.upstreamModelId,
            runtime: zt.runtime,
            available: zt.available,
            shahabLoaded: zt.modelLoaded,
            binaryAvailable: zt.available,
            offlineOnlyEnforced: true,
            missingFiles: zt.missingFiles,
            integrityError: zt.integrityError ? sanitizeDiagnosticString(zt.integrityError) : null,
            activeJobCount: zt.activeJobCount,
            queuedJobCount: zt.queuedJobCount,
            lastMetrics: zt.lastMetrics,
          },
          bundledSample: bundledSample
            ? { available: true, filename: bundledSample.filename, modelId: bundledSample.modelId }
            : { available: false },
          resources:
            securityGuard.config.mode === 'hosted'
              ? jobManager.getResourceStatus(res.locals.avapardazAuth?.ownerId)
              : jobManager.getResourceStatus(),
        });
        return;
      }

      const rt = sherpaFallbackRuntime.getRuntimeStatus();
      res.json({
        ok: true,
        engine01: {
          modelId: SHAHAB_FA_LITE_MANIFEST.modelId,
          version: SHAHAB_FA_LITE_MANIFEST.version,
          upstreamModelId: SHAHAB_FA_LITE_MANIFEST.provenance.upstreamModelId,
          available: rt.available,
          shahabLoaded: rt.shahabLoaded,
          binaryAvailable: Boolean(rt.binaryPath),
          offlineOnlyEnforced: true,
          cpuThreads: rt.cpuThreads,
          lastMetrics: rt.lastMetrics,
        },
        bundledSample: bundledSample
          ? { available: true, filename: bundledSample.filename, modelId: bundledSample.modelId }
          : { available: false },
        resources:
          securityGuard.config.mode === 'hosted'
            ? jobManager.getResourceStatus(res.locals.avapardazAuth?.ownerId)
            : jobManager.getResourceStatus(),
      });
    },
  );

  // Pre-body Content-Type & Content-Length validation for POST /jobs (runs AFTER auth, BEFORE express.raw)
  const validateJobUploadPreconditions = (req: Request, res: Response, next: NextFunction) => {
    const ct = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].trim() : '';
    if (!ALLOWED_UPLOAD_CONTENT_TYPE_RE.test(ct)) {
      securityGuard.recordSecurityEvent({
        eventType: 'PAYLOAD_REJECTED',
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        ownerId: res.locals.avapardazAuth?.ownerId,
      });
      res.status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'نوع محتوای درخواست باید فایل صوتی باینری یا application/json باشد.',
      });
      return;
    }

    const rawLength = req.headers['content-length'];
    if (typeof rawLength === 'string' && rawLength.trim().length > 0) {
      const parsedLen = Number.parseInt(rawLength, 10);
      if (!Number.isFinite(parsedLen) || parsedLen < 0) {
        res.status(400).json({
          error: 'INVALID_CONTENT_LENGTH',
          code: 'INVALID_CONTENT_LENGTH',
          message: 'مقدار Content-Length نامعتبر است.',
        });
        return;
      }
      if (parsedLen > maxUploadBytes) {
        securityGuard.recordSecurityEvent({
          eventType: 'PAYLOAD_REJECTED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 413,
          code: 'PAYLOAD_TOO_LARGE',
          ownerId: res.locals.avapardazAuth?.ownerId,
          details: { contentLength: parsedLen, maxUploadBytes },
        });
        res.status(413).json({
          error: 'PAYLOAD_TOO_LARGE',
          code: 'PAYLOAD_TOO_LARGE',
          message: 'حجم فایل ارسالی از سقف مجاز فراتر رفته است.',
        });
        return;
      }
    }

    next();
  };

  // Create job from raw binary audio (audio/* or application/octet-stream) or JSON { useBundledSample: true }
  router.post(
    '/jobs',
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'smart-edit:write',
      rateLimitBucket: 'smart-edit-create',
      rateLimitMax: 20,
    }),
    validateJobUploadPreconditions,
    express.raw({
      type: (req) => {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        return ct.startsWith('audio/') || ct === 'application/octet-stream';
      },
      limit: maxUploadBytes,
    }),
    express.json({ limit: '1mb' }),
    (req, res) => {
      try {
        const ownerId = getOwnerId(res);
        if (Buffer.isBuffer(req.body) && req.body.byteLength > 0) {
          const binaryCheck = validateBinaryAudioPayload(req.body, { minBytes: 44 });
          if (!binaryCheck.ok) {
            securityGuard.recordSecurityEvent({
              eventType: 'PAYLOAD_REJECTED',
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: 400,
              code: binaryCheck.code ?? 'INVALID_AUDIO_INPUT',
              ownerId,
            });
            res.status(400).json({
              error: binaryCheck.code ?? 'INVALID_AUDIO_INPUT',
              code: binaryCheck.code ?? 'INVALID_AUDIO_INPUT',
              message: binaryCheck.message ?? 'فایل صوتی معتبر نیست.',
            });
            return;
          }

          const rawHeader = req.headers['x-audio-filename'];
          let decodedName = 'uploaded-audio.wav';
          if (typeof rawHeader === 'string' && rawHeader.trim().length > 0) {
            let candidate = rawHeader.trim();
            try {
              candidate = decodeURIComponent(candidate);
            } catch {
              // Malformed percent-encoding: fall back safely
            }
            const base = candidate.split(/[\\/]/).pop() ?? 'uploaded-audio.wav';
            const cleaned = base
              .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
              .trim()
              .slice(0, 160);
            if (cleaned.length > 0 && cleaned !== '.' && cleaned !== '..') {
              decodedName = cleaned;
            }
          }
          const snapshot = jobManager.createJobFromAudio({
            ownerId,
            audioBytes: req.body,
            filename: decodedName,
          });
          res.status(201).json(snapshot);
          return;
        }

        const rawBody = (req.body ?? {}) as Record<string, unknown>;
        if ('ownerId' in rawBody || 'owner_id' in rawBody) {
          securityGuard.recordSecurityEvent({
            eventType: 'IDOR_ATTEMPT_BLOCKED',
            method: req.method,
            path: req.originalUrl || req.path,
            statusCode: 400,
            code: 'OWNER_OVERRIDE_FORBIDDEN',
            ownerId,
          });
          res.status(400).json({
            error: 'OWNER_OVERRIDE_FORBIDDEN',
            code: 'OWNER_OVERRIDE_FORBIDDEN',
            message: 'تعیین دستی ownerId در بدنه درخواست مجاز نیست؛ مالکیت صرفاً از توکن احراز هویت استخراج می‌شود.',
          });
          return;
        }
        const body = rawBody as { useBundledSample?: boolean };
        if (body.useBundledSample) {
          const sample = resolveBundledSample();
          if (!sample || !fs.existsSync(sample.filePath)) {
            res.status(404).json({
              error: 'BUNDLED_SAMPLE_NOT_FOUND',
              code: 'BUNDLED_SAMPLE_NOT_FOUND',
              message: 'فایل صوتی نمونه بومی روی دیسک یافت نشد.',
            });
            return;
          }
          const snapshot = jobManager.createJobFromAudio({
            ownerId,
            audioFilePath: sample.filePath,
            filename: sample.filename,
          });
          res.status(201).json(snapshot);
          return;
        }

        res.status(400).json({
          error: 'INVALID_AUDIO_INPUT',
          code: 'INVALID_AUDIO_INPUT',
          message: 'بدنه درخواست باید فایل صوتی باینری (WAV/MP3/FLAC) یا useBundledSample=true باشد.',
        });
      } catch (err) {
        handleRouteError(req, res, err);
      }
    },
  );

  // Protect all remaining /jobs* endpoints with auth before JSON parsing
  router.use(
    securityGuard.middleware({
      requireAuth: true,
      requiredScope: 'smart-edit:read',
      rateLimitBucket: 'smart-edit-api',
      rateLimitMax: 90,
    }),
  );
  router.use(express.json({ limit: '2mb' }));
  // Reject any attempt to inject ownerId/owner_id in JSON bodies of job mutations
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.body &&
      typeof req.body === 'object' &&
      !Buffer.isBuffer(req.body) &&
      ('ownerId' in (req.body as Record<string, unknown>) ||
        'owner_id' in (req.body as Record<string, unknown>))
    ) {
      securityGuard.recordSecurityEvent({
        eventType: 'IDOR_ATTEMPT_BLOCKED',
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: 400,
        code: 'OWNER_OVERRIDE_FORBIDDEN',
        ownerId: res.locals.avapardazAuth?.ownerId,
      });
      res.status(400).json({
        error: 'OWNER_OVERRIDE_FORBIDDEN',
        code: 'OWNER_OVERRIDE_FORBIDDEN',
        message: 'تعیین دستی ownerId در بدنه درخواست مجاز نیست.',
      });
      return;
    }
    next();
  });

  router.get('/jobs', (_req, res) => {
    const ownerId = getOwnerId(res);
    res.json({
      jobs: jobManager.listJobs(ownerId),
      resources:
        securityGuard.config.mode === 'hosted'
          ? jobManager.getResourceStatus(ownerId)
          : jobManager.getResourceStatus(),
    });
  });

  router.get('/jobs/:jobId', requireValidJobId, (req, res) => {
    try {
      const ownerId = getOwnerId(res);
      const snap = jobManager.getJobSnapshot(req.params.jobId, ownerId);
      if (!snap) {
        res.status(404).json({ error: 'JOB_NOT_FOUND', code: 'JOB_NOT_FOUND', message: 'Job not found.' });
        return;
      }
      res.json(snap);
    } catch (err) {
      handleRouteError(req, res, err);
    }
  });

  router.post(
    '/jobs/:jobId/run',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'smart-edit:write',
      rateLimitBucket: 'smart-edit-run',
      rateLimitMax: 20,
    }),
    async (req, res) => {
      const ownerId = getOwnerId(res);
      const abort = attachRequestAbortSignal(req, res, operationTimeoutMs);
      try {
        const body = (req.body ?? {}) as { languageHint?: 'fa' | 'en' | 'fa-en' | 'auto' };
        const snapshot = await jobManager.runTranscribeAndAnalyze(req.params.jobId, {
          ownerId,
          languageHint: body.languageHint ?? 'fa',
          signal: abort.signal,
          timeoutMs: operationTimeoutMs,
        });
        if (!res.writableEnded) {
          res.json(snapshot);
        }
      } catch (err) {
        if (abort.didDisconnect()) {
          securityGuard.recordSecurityEvent({
            eventType: 'JOB_CANCELLED',
            method: req.method,
            path: req.originalUrl || req.path,
            statusCode: 499,
            code: 'CLIENT_DISCONNECTED_ABORT',
            ownerId,
          });
        }
        if (!res.writableEnded && abort.didTimeout()) {
          res.status(408).json({
            error: 'REQUEST_TIMEOUT',
            code: 'REQUEST_TIMEOUT',
            message: 'زمان پردازش Job به پایان رسید و عملیات متوقف شد.',
          });
          return;
        }
        handleRouteError(req, res, err, req.params.jobId);
      } finally {
        abort.cleanup();
      }
    },
  );

  router.post(
    '/jobs/:jobId/decisions',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requiredScope: 'smart-edit:write',
      rateLimitBucket: 'smart-edit-decisions',
      rateLimitMax: 60,
    }),
    (req, res) => {
      try {
        const ownerId = getOwnerId(res);
        const body = (req.body ?? {}) as {
          action?: 'APPROVE' | 'REJECT' | 'RETURN_TO_REVIEW' | 'APPROVE_ALL_LOW_RISK' | 'UNDO' | 'REDO';
          proposalIds?: string[];
          reason?: string;
        };
        const allowed = new Set([
          'APPROVE',
          'REJECT',
          'RETURN_TO_REVIEW',
          'APPROVE_ALL_LOW_RISK',
          'UNDO',
          'REDO',
        ]);
        if (!body.action || !allowed.has(body.action)) {
          res.status(400).json({
            error: 'INVALID_DECISION_ACTION',
            code: 'INVALID_DECISION_ACTION',
            message: 'نوع عملیات تصمیم‌گیری معتبر نیست.',
          });
          return;
        }
        const result = jobManager.applyDecision(req.params.jobId, {
          ownerId,
          action: body.action,
          proposalIds: body.proposalIds,
          reason: body.reason,
        });
        res.json(result);
      } catch (err) {
        handleRouteError(req, res, err);
      }
    },
  );

  router.post(
    '/jobs/:jobId/preview',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requiredScope: 'smart-edit:read',
      rateLimitBucket: 'smart-edit-preview',
      rateLimitMax: 30,
    }),
    async (req, res) => {
      const ownerId = getOwnerId(res);
      const abort = attachRequestAbortSignal(req, res, operationTimeoutMs);
      try {
        const body = (req.body ?? {}) as {
          mode?: SmartEditPreviewMode;
          proposalId?: string;
          contextPaddingMs?: number;
          crossfadeMs?: number;
        };
        const mode: SmartEditPreviewMode =
          body.mode === 'ORIGINAL' || body.mode === 'EDITED' || body.mode === 'FULL'
            ? body.mode
            : 'EDITED';

        const { snapshot, preview } = await jobManager.generatePreview(req.params.jobId, {
          ownerId,
          mode,
          proposalId: body.proposalId,
          contextPaddingMs: body.contextPaddingMs,
          crossfadeMs: body.crossfadeMs,
          signal: abort.signal,
          timeoutMs: operationTimeoutMs,
        });

        if (res.writableEnded) return;
        if (!preview.ok || preview.wavBytes.byteLength === 0) {
          res.status(422).json({
            error: 'PREVIEW_FAILED',
            code: 'PREVIEW_FAILED',
            message: preview.failureReason ?? 'تولید پیش‌نمایش صوتی ناموفق بود.',
            snapshot,
          });
          return;
        }

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('X-Preview-Mode', preview.mode);
        res.setHeader('X-Preview-Duration-Sec', String(preview.durationSec));
        res.setHeader('X-Preview-Samples', String(preview.totalSamples));
        res.setHeader('X-Job-Status', snapshot.job.status);
        res.setHeader('X-Job-Progress', String(snapshot.job.progress));
        res.send(
          Buffer.from(preview.wavBytes.buffer, preview.wavBytes.byteOffset, preview.wavBytes.byteLength),
        );
      } catch (err) {
        if (!res.writableEnded && abort.didTimeout()) {
          res.status(408).json({
            error: 'REQUEST_TIMEOUT',
            code: 'REQUEST_TIMEOUT',
            message: 'زمان تولید پیش‌نمایش صوتی به پایان رسید.',
          });
          return;
        }
        handleRouteError(req, res, err);
      } finally {
        abort.cleanup();
      }
    },
  );

  router.post(
    '/jobs/:jobId/render',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'smart-edit:write',
      rateLimitBucket: 'smart-edit-render',
      rateLimitMax: 20,
    }),
    async (req, res) => {
      const ownerId = getOwnerId(res);
      const abort = attachRequestAbortSignal(req, res, operationTimeoutMs);
      try {
        const body = (req.body ?? {}) as {
          encoding?: 'pcm16' | 'pcm24' | 'float32';
          defaultCrossfadeMs?: number;
        };
        const { snapshot, renderResult } = await jobManager.renderFinal(req.params.jobId, {
          ownerId,
          config: {
            encoding: body.encoding ?? 'pcm24',
            defaultCrossfadeMs: body.defaultCrossfadeMs ?? 10,
          },
          signal: abort.signal,
          timeoutMs: operationTimeoutMs,
        });
        if (res.writableEnded) return;
        res.json({
          snapshot,
          exportUrl: `/api/v2/smart-edit/jobs/${encodeURIComponent(req.params.jobId)}/export`,
          renderValidation: {
            preValidationPassed: renderResult.preValidation.passed,
            postValidationPassed: Boolean(renderResult.postValidation?.passed),
            appliedProposalIds: renderResult.appliedProposalIds,
            sourceDurationSec: renderResult.sourceDurationSec,
            outputDurationSec: renderResult.outputDurationSec,
            removedDurationSec: renderResult.removedDurationSec,
            output: renderResult.output,
          },
        });
      } catch (err) {
        if (!res.writableEnded && abort.didTimeout()) {
          res.status(408).json({
            error: 'REQUEST_TIMEOUT',
            code: 'REQUEST_TIMEOUT',
            message: 'زمان رندر نهایی به پایان رسید.',
          });
          return;
        }
        handleRouteError(req, res, err, req.params.jobId);
      } finally {
        abort.cleanup();
      }
    },
  );

  router.get(
    '/jobs/:jobId/export',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'smart-edit:read',
      rateLimitBucket: 'smart-edit-export',
      rateLimitMax: 30,
    }),
    (req, res) => {
      try {
        const ownerId = getOwnerId(res);
        const snap = jobManager.getJobSnapshot(req.params.jobId, ownerId);
        const wav = jobManager.getLastOutputWav(req.params.jobId, ownerId);
        if (!snap || !wav || wav.byteLength === 0) {
          res.status(404).json({
            error: 'RENDER_OUTPUT_NOT_READY',
            code: 'RENDER_OUTPUT_NOT_READY',
            message: 'فایل خروجی رندرشده هنوز آماده نیست.',
          });
          return;
        }
        const safeBase = snap.filename
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="avapardaz-edited-${safeBase || 'output'}.wav"`,
        );
        res.send(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
      } catch (err) {
        handleRouteError(req, res, err);
      }
    },
  );

  router.post(
    '/jobs/:jobId/cancel',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'smart-edit:write',
      rateLimitBucket: 'smart-edit-cancel',
      rateLimitMax: 30,
    }),
    (req, res) => {
      try {
        const ownerId = getOwnerId(res);
        const snap = jobManager.cancelJob(req.params.jobId, ownerId);
        securityGuard.recordSecurityEvent({
          eventType: 'JOB_CANCELLED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 200,
          code: 'JOB_CANCELLED_BY_OWNER',
          ownerId,
        });
        res.json(snap);
      } catch (err) {
        handleRouteError(req, res, err);
      }
    },
  );

  router.delete(
    '/jobs/:jobId',
    requireValidJobId,
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'smart-edit:write',
      rateLimitBucket: 'smart-edit-delete',
      rateLimitMax: 30,
    }),
    (req, res) => {
      try {
        const ownerId = getOwnerId(res);
        const removed = jobManager.disposeJob(req.params.jobId, ownerId);
        res.json({ ok: removed, jobId: req.params.jobId });
      } catch (err) {
        handleRouteError(req, res, err);
      }
    },
  );

  // Scoped JSON error handler (handles body-parser PayloadTooLargeError -> 413 JSON cleanly)
  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const isTooLarge =
      status === 413 ||
      (typeof err === 'object' &&
        err !== null &&
        'type' in err &&
        (err as { type?: unknown }).type === 'entity.too.large');
    if (isTooLarge) {
      securityGuard.recordSecurityEvent({
        eventType: 'PAYLOAD_REJECTED',
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        ownerId: res.locals.avapardazAuth?.ownerId,
      });
      res.status(413).json({
        error: 'PAYLOAD_TOO_LARGE',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'حجم فایل ارسالی از سقف مجاز فراتر رفته است.',
      });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status === 400 ? 'INVALID_REQUEST' : 'SMART_EDIT_ERROR',
      code: status === 400 ? 'INVALID_REQUEST' : 'SMART_EDIT_ERROR',
      message: sanitizeErr(err),
    });
  });

  return { router, jobManager, securityGuard };
}
