/**
 * AVAPARDAZ — HARDENED SHAHAB HTTP ROUTER (/api/shahab/*)
 *
 * Phase 1A Security Containment:
 * - Enforces AudioApiSecurityGuard BEFORE body parsing (express.raw) so unauthorized,
 *   cross-origin, non-loopback (local), or unauthenticated (hosted) callers cannot upload audio.
 * - Validates Content-Type, Content-Length ceiling, and binary audio magic headers.
 * - Enforces replay defense (X-Request-Nonce + X-Request-Timestamp), rate limits,
 *   per-owner & global concurrency ceilings, processing timeout, and disconnect cancellation.
 * - Preserves existing response contracts without modifying ShahabZipformerEngine or Runtime.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { sanitizePublicErrorOutput } from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';
import { sanitizeDiagnosticString } from '../security/SecurityTrustBoundaryGuards';
import {
  AudioApiSecurityGuard,
  validateBinaryAudioPayload,
} from '../security/AudioApiSecurityGuard';
import {
  ShahabZipformerRuntimeError,
  type ShahabZipformerAsrRuntime,
  type ShahabZipformerRuntimeStatus,
} from './ShahabZipformerAsrRuntime';
import type { ShahabDecodePolicyId } from './ShahabZipformerEngine';

export interface ShahabTranscribeBackend {
  getRuntimeStatus(): ShahabZipformerRuntimeStatus;
  getBundledSampleAudioPath(): { readonly filePath: string; readonly filename: string; readonly modelId: string } | null;
  transcribe(
    request: Parameters<ShahabZipformerAsrRuntime['transcribe']>[0],
  ): ReturnType<ShahabZipformerAsrRuntime['transcribe']>;
}

export interface ShahabHttpRouterOptions {
  readonly shahabZipformerRuntime: ShahabZipformerAsrRuntime | ShahabTranscribeBackend;
  readonly securityGuard: AudioApiSecurityGuard;
  readonly maxUploadBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly maxConcurrentPerOwner?: number;
  readonly maxConcurrentGlobal?: number;
  readonly rateLimitMaxPerWindow?: number;
  readonly rateLimitWindowMs?: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000; // 2 minutes
const ALLOWED_AUDIO_CONTENT_TYPE_RE =
  /^(audio\/(wav|wave|x-wav|mpeg|mp3|flac|ogg|webm|mp4|aac|aiff|x-aiff)|application\/octet-stream)(;.*)?$/i;

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return sanitizeDiagnosticString(sanitizePublicErrorOutput(raw));
}

export function createShahabHttpRouter(options: ShahabHttpRouterOptions): Router {
  const { shahabZipformerRuntime, securityGuard } = options;
  const maxUploadBytes = Math.max(1024, options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
  const requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const maxConcurrentPerOwner = Math.max(1, options.maxConcurrentPerOwner ?? 1);
  const maxConcurrentGlobal = Math.max(maxConcurrentPerOwner, options.maxConcurrentGlobal ?? 2);
  const rateLimitMax = Math.max(1, options.rateLimitMaxPerWindow ?? 24);
  const rateLimitWindowMs = Math.max(1_000, options.rateLimitWindowMs ?? 60_000);

  const router = express.Router();

  // Status route: transport/origin guarded in local mode; full auth required in hosted mode
  router.get(
    '/runtime-status',
    securityGuard.middleware({
      requireAuth: securityGuard.config.mode === 'hosted',
      rateLimitBucket: 'shahab-status',
      rateLimitMax: 120,
    }),
    (_req, res) => {
      const status = shahabZipformerRuntime.getRuntimeStatus();
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        available: status.available,
        modelLoaded: status.modelLoaded,
        engine: status.engine,
        modelId: status.modelId,
        modelVersion: status.modelVersion,
        upstreamModelId: status.upstreamModelId,
        runtime: status.runtime,
        offlineOnlyEnforced: status.offlineOnlyEnforced,
        missingFiles: status.missingFiles,
        integrityError: status.integrityError ? sanitizeDiagnosticString(status.integrityError) : null,
        sampleAudioAvailable: status.sampleAudioAvailable,
        activeJobCount: status.activeJobCount,
        queuedJobCount: status.queuedJobCount,
        maxPendingJobs: status.maxPendingJobs,
        lastMetrics: status.lastMetrics,
      });
    },
  );

  // Sample audio route: transport/origin guarded in local mode; full auth required in hosted mode
  router.get(
    '/sample.wav',
    securityGuard.middleware({
      requireAuth: securityGuard.config.mode === 'hosted',
      rateLimitBucket: 'shahab-sample',
      rateLimitMax: 30,
    }),
    (_req, res) => {
      const sample = shahabZipformerRuntime.getBundledSampleAudioPath();
      if (!sample || !fs.existsSync(sample.filePath)) {
        res.status(404).json({
          error: 'SHAHAB_SAMPLE_NOT_FOUND',
          message: 'فایل نمونه صوتی فارسی شهاب روی دیسک یافت نشد.',
        });
        return;
      }
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(sample.filePath);
    },
  );

  // Pre-body Content-Type & Content-Length validation middleware (runs AFTER auth, BEFORE express.raw)
  const validateTranscribePreconditions = (req: Request, res: Response, next: NextFunction) => {
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].trim() : '';
    if (!ALLOWED_AUDIO_CONTENT_TYPE_RE.test(contentType)) {
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
        message: 'نوع محتوای مجاز برای رونویسی فقط فایل صوتی باینری (audio/wav و معادل‌های صوتی) است.',
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
          message: 'مقدار هدر Content-Length معتبر نیست.',
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
          message: `حجم فایل صوتی از سقف مجاز (${Math.round(maxUploadBytes / (1024 * 1024))} مگابایت) بیشتر است.`,
        });
        return;
      }
    }

    next();
  };

  router.post(
    '/transcribe',
    // 1. Authorization, Transport/Origin/Host boundary, Replay Protection & Rate Limiting BEFORE reading body!
    securityGuard.middleware({
      requireAuth: true,
      requireReplayProtection: true,
      requiredScope: 'shahab:transcribe',
      rateLimitBucket: 'shahab-transcribe',
      rateLimitMax,
      rateLimitWindowMs,
    }),
    // 2. Content-Type & Content-Length pre-validation BEFORE reading body
    validateTranscribePreconditions,
    // 3. Bounded binary body ingestion
    express.raw({
      type: () => true,
      limit: maxUploadBytes,
    }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const ownerId = res.locals.avapardazAuth?.ownerId ?? 'unknown';

      // 4. Validate binary audio payload structure (magic bytes & minimum length)
      const payloadCheck = validateBinaryAudioPayload(req.body, { minBytes: 44 });
      if (!payloadCheck.ok) {
        securityGuard.recordSecurityEvent({
          eventType: 'PAYLOAD_REJECTED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 400,
          code: payloadCheck.code ?? 'INVALID_AUDIO_INPUT',
          ownerId,
        });
        res.status(400).json({
          error: payloadCheck.code ?? 'INVALID_AUDIO_INPUT',
          code: payloadCheck.code ?? 'INVALID_AUDIO_INPUT',
          message: payloadCheck.message ?? 'بدنه درخواست باید فایل صوتی باینری معتبر (WAV/PCM) باشد.',
        });
        return;
      }

      // 5. Enforce per-owner and global concurrency limit
      const slot = securityGuard.acquireConcurrencySlot({
        bucket: 'shahab-transcribe',
        ownerId,
        maxPerOwner: maxConcurrentPerOwner,
        maxGlobal: maxConcurrentGlobal,
      });
      if (!slot.ok) {
        res.setHeader('Retry-After', '2');
        securityGuard.recordSecurityEvent({
          eventType: 'CONCURRENCY_LIMITED',
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: 429,
          code: slot.code,
          ownerId,
        });
        res.status(429).json({
          error: slot.code,
          code: slot.code,
          message: slot.message,
        });
        return;
      }

      const rawNameHeader = req.headers['x-audio-filename'];
      let filename = 'studio-track.wav';
      if (typeof rawNameHeader === 'string' && rawNameHeader.trim().length > 0) {
        let decoded = rawNameHeader.trim();
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          // Malformed percent-encoding: fall back to raw header text safely
        }
        const base = decoded.split(/[\\/]/).pop() ?? 'studio-track.wav';
        const cleaned = base
          .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
          .trim()
          .slice(0, 160);
        if (cleaned.length > 0 && cleaned !== '.' && cleaned !== '..') {
          filename = cleaned;
        }
      }

      const rawPolicy = String(req.headers['x-decode-policy'] ?? 'BALANCED').toUpperCase();
      const allowedPolicies: readonly ShahabDecodePolicyId[] = [
        'SPEED',
        'BALANCED',
        'PRECISION',
        'VERBATIM',
      ];
      const decodePolicy: ShahabDecodePolicyId = allowedPolicies.includes(
        rawPolicy as ShahabDecodePolicyId,
      )
        ? (rawPolicy as ShahabDecodePolicyId)
        : 'BALANCED';

      const abortController = new AbortController();
      let timedOut = false;
      let clientDisconnected = false;

      const onAborted = () => {
        clientDisconnected = true;
        abortController.abort();
      };
      const onResponseClose = () => {
        if (!res.writableEnded) {
          clientDisconnected = true;
          abortController.abort();
        }
      };
      req.on('aborted', onAborted);
      res.on('close', onResponseClose);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, requestTimeoutMs);

      try {
        const sourceAudioHash = crypto.createHash('sha256').update(req.body).digest('hex');
        const out = await shahabZipformerRuntime.transcribe({
          sourceAudioId: `aud_${sourceAudioHash.slice(0, 16)}`,
          sourceAudioHash,
          audioBytes: req.body,
          filename,
          languageHint: 'fa',
          decodePolicy,
          signal: abortController.signal,
        });

        if (!res.writableEnded) {
          res.json({
            ok: true,
            transcript: out.transcript,
            metrics: out.metrics,
          });
        }
      } catch (err) {
        if (clientDisconnected) {
          securityGuard.recordSecurityEvent({
            eventType: 'JOB_CANCELLED',
            method: req.method,
            path: req.originalUrl || req.path,
            statusCode: 499,
            code: 'CLIENT_DISCONNECTED_ABORT',
            ownerId,
          });
        }
        if (res.writableEnded) return;
        if (timedOut) {
          res.status(408).json({
            error: 'REQUEST_TIMEOUT',
            code: 'REQUEST_TIMEOUT',
            message: 'زمان مجاز برای پردازش صوتی به پایان رسید و عملیات متوقف شد.',
          });
          return;
        }
        const code =
          err instanceof ShahabZipformerRuntimeError ? err.code : 'ASR_INFERENCE_FAILED';
        // Avoid HTTP 502/503/504 because reverse-proxy warmup interceptors rewrite them to 200 HTML
        const status =
          code === 'MODEL_NOT_AVAILABLE' || code === 'SHAHAB_MODEL_INTEGRITY_FAILED'
            ? 422
            : code === 'INVALID_AUDIO_INPUT'
              ? 400
              : code === 'AUDIO_DURATION_LIMIT_EXCEEDED'
                ? 413
                : code === 'SHAHAB_QUEUE_FULL'
                  ? 429
                  : code === 'TRANSCRIPTION_CANCELLED'
                    ? 499
                    : 500;
        if (status === 429) {
          res.setHeader('Retry-After', '2');
        }
        res.status(status).json({
          error: code,
          code,
          message: sanitizeErrorMessage(err),
        });
      } finally {
        clearTimeout(timeoutHandle);
        req.off('aborted', onAborted);
        res.off('close', onResponseClose);
        slot.release();
      }
    },
  );

  // Scoped JSON error handler for body-parser errors (e.g., PayloadTooLargeError -> 413 JSON)
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
      error: status === 400 ? 'INVALID_REQUEST' : 'SHAHAB_ROUTE_ERROR',
      code: status === 400 ? 'INVALID_REQUEST' : 'SHAHAB_ROUTE_ERROR',
      message: sanitizeErrorMessage(err),
    });
  });

  return router;
}
