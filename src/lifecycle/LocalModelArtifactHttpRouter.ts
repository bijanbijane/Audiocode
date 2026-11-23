/**
 * AVAPARDAZ — HARDENED PUBLIC/IMMUTABLE BROWSER MODEL ARTIFACT ROUTER (PHASE 1A.1)
 *
 * Serves verified Shenava-Rizeh artifacts for Browser OPFS installation:
 *   POST /prepare
 *   GET  /artifacts/:filename
 *
 * Security & Resource Controls (Section 6):
 * - Kept cleanly separate from private user audio/job APIs (public immutable model files).
 * - Strict manifest-only filename allowlist + realpath confinement inside model rootDir.
 * - Strict HTTP Range enforcement:
 *     * Rejects multi-range (`bytes=0-1,2-3`), suffix-range (`bytes=-10`), malformed syntax,
 *       and out-of-bounds ranges with HTTP 416 + Content-Range.
 *     * Enforces hard 1 MiB (1,048,576 B) ceiling per Range response (rejects > 1 MiB with 416).
 *     * Requires bounded Range header for artifacts larger than 1 MiB (prevents full-file drain).
 * - Rate limit & per-IP/global concurrency limits (`429` + `Retry-After`).
 * - Single-flight preparation lock preventing concurrent duplicate model downloads/extractions.
 * - Pre-delivery integrity check (size + SHA-256 verification) so partial/corrupt files are never served.
 * - Strong versioned ETag (`If-None-Match` -> 304) + immutable Cache-Control policy.
 * - Stream cleanup on client disconnect (`res.on('close')`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { sanitizePublicErrorOutput } from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';
import {
  verifyModelFilesIntegrity,
  type EnsuredShenavaModelArtifacts,
} from '../asr-core/LocalSherpaNeuralEngine';
import { MODEL_CHUNK_SIZE_BYTES } from './ModelRepositoryContracts';

export const MAX_MODEL_ARTIFACT_RANGE_BYTES = MODEL_CHUNK_SIZE_BYTES; // 1 MiB (1,048,576 bytes)

export interface ShenavaArtifactProvider {
  ensureShenavaRizehModelArtifacts(): Promise<EnsuredShenavaModelArtifacts>;
}

export interface LocalModelArtifactRouterOptions {
  readonly provider: ShenavaArtifactProvider;
  /** Override max Range bytes (default 1 MiB; capped at 1 MiB). */
  readonly maxRangeBytes?: number;
  /** Max /prepare requests per client IP per window (default 20/min). */
  readonly prepareRateLimitMax?: number;
  /** Max /artifacts requests per client IP per window (default 300/min). */
  readonly artifactRateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
  /** Max concurrent active artifact streams per IP (default 8) and global (default 32). */
  readonly maxConcurrentStreamsPerIp?: number;
  readonly maxConcurrentStreamsGlobal?: number;
  /** Optional verifier override for synthetic unit tests (defaults to verifyModelFilesIntegrity). */
  readonly verifyArtifactIntegrity?: (filePath: string, expectedBytes: number, expectedSha256Hex: string) => boolean;
}

class SimpleSlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();

  public check(
    key: string,
    max: number,
    windowMs: number,
    nowMs = Date.now(),
  ): { readonly allowed: boolean; readonly retryAfterSec: number } {
    const cutoff = nowMs - windowMs;
    const active = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (active.length >= max) {
      const oldest = active[0] ?? nowMs;
      this.buckets.set(key, active);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)),
      };
    }
    active.push(nowMs);
    this.buckets.set(key, active);
    if (this.buckets.size > 4_000) {
      const first = this.buckets.keys().next().value;
      if (first && first !== key) this.buckets.delete(first);
    }
    return { allowed: true, retryAfterSec: 0 };
  }
}

const MANIFEST_ALLOWED_ARTIFACTS = new Set([
  'model.int8.onnx',
  'tokens.txt',
  'sample-0.wav',
]);

function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
  try {
    const realRoot = fs.realpathSync(rootDir);
    const realTarget = fs.realpathSync(candidatePath);
    const rel = path.relative(realRoot, realTarget);
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function defaultVerifyArtifact(
  filePath: string,
  expectedBytes: number,
  expectedSha256Hex: string,
): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size !== expectedBytes) return false;
  } catch {
    return false;
  }
  // Delegate to canonical provenance verifier if filename is registered; otherwise verify SHA-256 directly
  if (verifyModelFilesIntegrity([filePath])) {
    const baseName = path.basename(filePath);
    if (baseName === 'model.int8.onnx' || baseName === 'tokens.txt') {
      return true;
    }
  }
  // Fallback explicit SHA-256 check for non-canonical test fixtures
  try {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(256 * 1024);
      let n = 0;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex') === expectedSha256Hex.toLowerCase();
  } catch {
    return false;
  }
}

export function createLocalModelArtifactHttpRouter(options: LocalModelArtifactRouterOptions): Router {
  const router = express.Router();
  const maxRangeBytes = Math.min(
    MAX_MODEL_ARTIFACT_RANGE_BYTES,
    Math.max(1024, options.maxRangeBytes ?? MAX_MODEL_ARTIFACT_RANGE_BYTES),
  );
  const prepareRateLimitMax = Math.max(1, options.prepareRateLimitMax ?? 20);
  const artifactRateLimitMax = Math.max(1, options.artifactRateLimitMax ?? 300);
  const rateLimitWindowMs = Math.max(1_000, options.rateLimitWindowMs ?? 60_000);
  const maxConcurrentPerIp = Math.max(1, options.maxConcurrentStreamsPerIp ?? 8);
  const maxConcurrentGlobal = Math.max(1, options.maxConcurrentStreamsGlobal ?? 32);
  const verifyArtifact = options.verifyArtifactIntegrity ?? defaultVerifyArtifact;

  const rateLimiter = new SimpleSlidingWindowLimiter();
  let inFlightPrepare: Promise<EnsuredShenavaModelArtifacts> | null = null;
  let activeGlobalStreams = 0;
  const activePerIpStreams = new Map<string, number>();

  const getClientKey = (req: Request): string => req.socket?.remoteAddress ?? req.ip ?? 'unknown';

  /**
   * Single-flight wrapper ensuring concurrent /prepare or /artifacts requests
   * never trigger duplicate downloads/extractions of the Shenava-Rizeh model.
   */
  const ensureSingleFlight = (): Promise<EnsuredShenavaModelArtifacts> => {
    if (inFlightPrepare) {
      return inFlightPrepare;
    }
    const task = Promise.resolve().then(() => options.provider.ensureShenavaRizehModelArtifacts());
    inFlightPrepare = task.finally(() => {
      if (inFlightPrepare === task) {
        inFlightPrepare = null;
      }
    });
    return inFlightPrepare;
  };

  router.post('/prepare', async (req: Request, res: Response) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    const rate = rateLimiter.check(
      `prepare:${getClientKey(req)}`,
      prepareRateLimitMax,
      rateLimitWindowMs,
    );
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: 'MODEL_PREPARE_RATE_LIMITED',
        message: 'تعداد درخواست‌های آماده‌سازی مدل از حد مجاز فراتر رفت.',
      });
      return;
    }

    try {
      const ensured = await ensureSingleFlight();
      res.setHeader('Cache-Control', 'no-cache');
      res.json({
        ok: true,
        modelId: ensured.modelId,
        upstreamModelId: ensured.upstreamModelId,
        modelVersion: ensured.modelVersion,
        architecture: ensured.architecture,
        maxRangeBytes,
        sampleAudioAvailable: Boolean(ensured.sampleWavPath),
        artifacts: {
          'model.int8.onnx': {
            byteLength: ensured.modelOnnxBytes,
            sha256Hex: ensured.modelOnnxSha256Hex,
            url: '/api/v1/local-models/shenava-rizen/artifacts/model.int8.onnx',
          },
          'tokens.txt': {
            byteLength: ensured.tokensBytes,
            sha256Hex: ensured.tokensSha256Hex,
            url: '/api/v1/local-models/shenava-rizen/artifacts/tokens.txt',
          },
        },
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'MODEL_PREPARE_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.get('/artifacts/:filename', async (req: Request, res: Response) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    const requestedName = String(req.params.filename ?? '');
    if (
      !MANIFEST_ALLOWED_ARTIFACTS.has(requestedName) ||
      requestedName.includes('/') ||
      requestedName.includes('\\') ||
      requestedName.includes('..')
    ) {
      res.status(404).json({ ok: false, error: 'ARTIFACT_NOT_FOUND' });
      return;
    }

    const clientKey = getClientKey(req);
    const rate = rateLimiter.check(
      `artifact:${clientKey}`,
      artifactRateLimitMax,
      rateLimitWindowMs,
    );
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: 'ARTIFACT_RATE_LIMITED',
        message: 'تعداد درخواست‌های دریافت فایل مدل از سقف مجاز فراتر رفت.',
      });
      return;
    }

    const currentIpActive = activePerIpStreams.get(clientKey) ?? 0;
    if (activeGlobalStreams >= maxConcurrentGlobal || currentIpActive >= maxConcurrentPerIp) {
      res.setHeader('Retry-After', '2');
      res.status(429).json({
        ok: false,
        error: 'ARTIFACT_CONCURRENCY_LIMITED',
        message: 'سقف دانلود هم‌زمان فایل مدل تکمیل است.',
      });
      return;
    }

    activeGlobalStreams++;
    activePerIpStreams.set(clientKey, currentIpActive + 1);
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activeGlobalStreams = Math.max(0, activeGlobalStreams - 1);
      const nextIp = Math.max(0, (activePerIpStreams.get(clientKey) ?? 1) - 1);
      if (nextIp === 0) activePerIpStreams.delete(clientKey);
      else activePerIpStreams.set(clientKey, nextIp);
    };

    try {
      const ensured = await ensureSingleFlight();
      let targetPath: string | null = null;
      let contentType = 'application/octet-stream';
      let expectedBytes: number | null = null;
      let expectedSha256: string | null = null;

      if (requestedName === 'model.int8.onnx') {
        targetPath = ensured.modelOnnxPath;
        contentType = 'application/octet-stream';
        expectedBytes = ensured.modelOnnxBytes;
        expectedSha256 = ensured.modelOnnxSha256Hex;
      } else if (requestedName === 'tokens.txt') {
        targetPath = ensured.tokensPath;
        contentType = 'text/plain; charset=utf-8';
        expectedBytes = ensured.tokensBytes;
        expectedSha256 = ensured.tokensSha256Hex;
      } else if (requestedName === 'sample-0.wav') {
        targetPath = ensured.sampleWavPath;
        contentType = 'audio/wav';
      }

      if (!targetPath || !fs.existsSync(targetPath)) {
        releaseSlot();
        res.status(404).json({ ok: false, error: 'ARTIFACT_UNAVAILABLE' });
        return;
      }

      // Confinement check: resolved realpath must stay inside model rootDir (blocks symlink escape)
      if (!isPathInsideRoot(ensured.rootDir, targetPath)) {
        releaseSlot();
        res.status(403).json({ ok: false, error: 'ARTIFACT_PATH_CONFINEMENT_VIOLATION' });
        return;
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isFile() || stat.size <= 0) {
        releaseSlot();
        res.status(500).json({ ok: false, error: 'ARTIFACT_INTEGRITY_ERROR' });
        return;
      }

      // Pre-delivery integrity verification for manifest-tracked artifacts (never deliver corrupt/partial files)
      if (expectedBytes !== null && expectedSha256 !== null) {
        if (stat.size !== expectedBytes || !verifyArtifact(targetPath, expectedBytes, expectedSha256)) {
          releaseSlot();
          res.status(500).json({
            ok: false,
            error: 'ARTIFACT_INTEGRITY_ERROR',
            message: 'اصالت فایل مدل روی دیسک تأیید نشد؛ تحویل فایل متوقف شد.',
          });
          return;
        }
      }

      const etag = expectedSha256
        ? `"sha256-${expectedSha256.toLowerCase()}"`
        : `"v-${ensured.modelVersion}-${stat.size}-${Math.trunc(stat.mtimeMs)}"`;

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Max-Range-Bytes', String(maxRangeBytes));
      res.setHeader('Content-Type', contentType);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

      const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'].trim() : '';
      if (ifNoneMatch && ifNoneMatch === etag) {
        releaseSlot();
        res.status(304).end();
        return;
      }

      const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
      if (rangeHeader) {
        // Explicitly reject multi-range / ambiguous comma-separated ranges
        if (rangeHeader.includes(',')) {
          releaseSlot();
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          res.status(416).json({
            ok: false,
            error: 'MULTIPLE_RANGES_NOT_SUPPORTED',
            message: 'درخواست چندبازه (Multi-Range) پشتیبانی نمی‌شود.',
          });
          return;
        }

        const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
        if (!match) {
          releaseSlot();
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          res.status(416).json({
            ok: false,
            error: 'INVALID_RANGE_HEADER',
            message: 'فرمت هدر Range معتبر نیست.',
          });
          return;
        }

        const start = Number.parseInt(match[1], 10);
        const hasExplicitEnd = match[2].length > 0;
        const requestedEnd = hasExplicitEnd ? Number.parseInt(match[2], 10) : stat.size - 1;
        const end = Math.min(stat.size - 1, requestedEnd);

        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start >= stat.size ||
          start > end
        ) {
          releaseSlot();
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          res.status(416).json({
            ok: false,
            error: 'RANGE_NOT_SATISFIABLE',
            message: 'بازه درخواستی خارج از اندازه فایل مدل است.',
          });
          return;
        }

        const spanBytes = end - start + 1;
        if (spanBytes > maxRangeBytes) {
          releaseSlot();
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          res.status(416).json({
            ok: false,
            error: 'RANGE_TOO_LARGE',
            maxRangeBytes,
            message: `حداکثر اندازه هر پاسخ Range برابر ${maxRangeBytes} بایت (1 MiB) است.`,
          });
          return;
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', String(spanBytes));

        const stream = fs.createReadStream(targetPath, { start, end });
        const cleanupStream = () => {
          stream.destroy();
          releaseSlot();
        };
        res.on('close', cleanupStream);
        res.on('finish', releaseSlot);
        stream.on('error', () => {
          releaseSlot();
          if (!res.headersSent) {
            res.status(500).json({ ok: false, error: 'ARTIFACT_STREAM_ERROR' });
          } else {
            res.end();
          }
        });
        stream.pipe(res);
        return;
      }

      // Without a Range header: allow small artifacts (<= 1 MiB, e.g., tokens.txt, sample-0.wav),
      // but require bounded Range requests for large artifacts (> 1 MiB, e.g., model.int8.onnx)
      // so callers cannot bypass the 1 MiB Range cap by omitting Range.
      if (stat.size > maxRangeBytes) {
        releaseSlot();
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.status(416).json({
          ok: false,
          error: 'RANGE_REQUIRED_FOR_LARGE_ARTIFACT',
          maxRangeBytes,
          message: 'برای فایل‌های بزرگ‌تر از 1 MiB ارسال هدر Range با بازه حداکثر 1 MiB الزامی است.',
        });
        return;
      }

      res.setHeader('Content-Length', String(stat.size));
      const stream = fs.createReadStream(targetPath);
      res.on('close', () => {
        stream.destroy();
        releaseSlot();
      });
      res.on('finish', releaseSlot);
      stream.on('error', () => {
        releaseSlot();
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: 'ARTIFACT_STREAM_ERROR' });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      releaseSlot();
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'ARTIFACT_DELIVERY_FAILED',
          message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  });

  return router;
}
