/**
 * AVAPARDAZ — LOCAL SMART AUDIO EDIT HTTP ROUTER (/api/v2/smart-edit/*)
 *
 * Exposes the unified 3-engine SmartAudioEditPipeline & SmartAudioEditJobManager
 * to the local Web App over Express without any cloud ASR or mock paths.
 * Raw audio uploads use binary express.raw() (bounded to 64 MiB) before JSON parsing.
 */

import express from 'express';
import fs from 'node:fs';
import { LocalSherpaNeuralEngine } from '../asr-core/LocalSherpaNeuralEngine';
import { SHAHAB_FA_LITE_MANIFEST, ShahabLocalAsrRuntime } from '../asr-core/ShahabModelManifest';
import { SmartAudioEditError, SmartAudioEditPipeline } from './SmartAudioEditPipeline';
import { SmartAudioEditJobManager } from './SmartAudioEditJobManager';
import type { SmartEditPreviewMode } from './SmartAudioEditContracts';

const MAX_SMART_EDIT_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB

function toHttpError(err: unknown): { status: number; code: string; message: string } {
  const code =
    err instanceof SmartAudioEditError
      ? err.code
      : err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'SMART_EDIT_ERROR';
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'MODEL_NOT_AVAILABLE') return { status: 503, code, message };
  if (code === 'JOB_NOT_FOUND') return { status: 404, code, message };
  if (
    code === 'ASR_CONCURRENCY_LIMIT' ||
    code === 'RENDER_CONCURRENCY_LIMIT' ||
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

export function createSmartAudioEditHttpRouter(options?: {
  readonly neuralEngine?: LocalSherpaNeuralEngine;
  readonly jobManager?: SmartAudioEditJobManager;
}): {
  readonly router: express.Router;
  readonly jobManager: SmartAudioEditJobManager;
} {
  const neuralEngine = options?.neuralEngine ?? new LocalSherpaNeuralEngine();
  const shahabRuntime = new ShahabLocalAsrRuntime({ neuralEngine });
  const pipeline = new SmartAudioEditPipeline({ asrEngine: shahabRuntime });
  const jobManager = options?.jobManager ?? new SmartAudioEditJobManager(pipeline);

  const router = express.Router();

  router.get('/status', (_req, res) => {
    const rt = shahabRuntime.getRuntimeStatus();
    const bundledSample = neuralEngine.getBundledSampleAudioPath();
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
      resources: jobManager.getResourceStatus(),
    });
  });

  // Create job from raw binary audio (audio/* or application/octet-stream) or JSON { useBundledSample: true }
  router.post(
    '/jobs',
    express.raw({
      type: (req) => {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        return ct.startsWith('audio/') || ct === 'application/octet-stream';
      },
      limit: MAX_SMART_EDIT_UPLOAD_BYTES,
    }),
    express.json({ limit: '1mb' }),
    (req, res) => {
      try {
        if (Buffer.isBuffer(req.body) && req.body.byteLength > 0) {
          const rawHeader = req.headers['x-audio-filename'];
          const decodedName =
            typeof rawHeader === 'string' && rawHeader.trim().length > 0
              ? decodeURIComponent(rawHeader.trim())
              : 'uploaded-audio.wav';
          const snapshot = jobManager.createJobFromAudio({
            audioBytes: req.body,
            filename: decodedName,
          });
          res.status(201).json(snapshot);
          return;
        }

        const body = (req.body ?? {}) as { useBundledSample?: boolean };
        if (body.useBundledSample) {
          const sample = neuralEngine.getBundledSampleAudioPath();
          if (!sample || !fs.existsSync(sample.filePath)) {
            res.status(404).json({
              error: 'BUNDLED_SAMPLE_NOT_FOUND',
              code: 'BUNDLED_SAMPLE_NOT_FOUND',
              message: 'فایل صوتی نمونه بومی روی دیسک یافت نشد.',
            });
            return;
          }
          const snapshot = jobManager.createJobFromAudio({
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
        const e = toHttpError(err);
        res.status(e.status).json({ error: e.code, code: e.code, message: e.message });
      }
    },
  );

  router.use(express.json({ limit: '2mb' }));

  router.get('/jobs', (_req, res) => {
    res.json({ jobs: jobManager.listJobs(), resources: jobManager.getResourceStatus() });
  });

  router.get('/jobs/:jobId', (req, res) => {
    const snap = jobManager.getJobSnapshot(req.params.jobId);
    if (!snap) {
      res.status(404).json({ error: 'JOB_NOT_FOUND', code: 'JOB_NOT_FOUND', message: 'Job not found.' });
      return;
    }
    res.json(snap);
  });

  router.post('/jobs/:jobId/run', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { languageHint?: 'fa' | 'en' | 'fa-en' | 'auto' };
      const snapshot = await jobManager.runTranscribeAndAnalyze(req.params.jobId, {
        languageHint: body.languageHint ?? 'fa',
      });
      res.json(snapshot);
    } catch (err) {
      const e = toHttpError(err);
      const snap = jobManager.getJobSnapshot(req.params.jobId);
      res.status(e.status).json({ error: e.code, code: e.code, message: e.message, snapshot: snap });
    }
  });

  router.post('/jobs/:jobId/decisions', (req, res) => {
    try {
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
        action: body.action,
        proposalIds: body.proposalIds,
        reason: body.reason,
      });
      res.json(result);
    } catch (err) {
      const e = toHttpError(err);
      res.status(e.status).json({ error: e.code, code: e.code, message: e.message });
    }
  });

  router.post('/jobs/:jobId/preview', async (req, res) => {
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
        mode,
        proposalId: body.proposalId,
        contextPaddingMs: body.contextPaddingMs,
        crossfadeMs: body.crossfadeMs,
      });

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
      res.send(Buffer.from(preview.wavBytes));
    } catch (err) {
      const e = toHttpError(err);
      res.status(e.status).json({ error: e.code, code: e.code, message: e.message });
    }
  });

  router.post('/jobs/:jobId/render', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        encoding?: 'pcm16' | 'pcm24' | 'float32';
        defaultCrossfadeMs?: number;
      };
      const { snapshot, renderResult } = await jobManager.renderFinal(req.params.jobId, {
        config: {
          encoding: body.encoding ?? 'pcm24',
          defaultCrossfadeMs: body.defaultCrossfadeMs ?? 10,
        },
      });
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
      const e = toHttpError(err);
      const snap = jobManager.getJobSnapshot(req.params.jobId);
      res.status(e.status).json({ error: e.code, code: e.code, message: e.message, snapshot: snap });
    }
  });

  router.get('/jobs/:jobId/export', (req, res) => {
    const snap = jobManager.getJobSnapshot(req.params.jobId);
    const wav = jobManager.getLastOutputWav(req.params.jobId);
    if (!snap || !wav || wav.byteLength === 0) {
      res.status(404).json({
        error: 'RENDER_OUTPUT_NOT_READY',
        code: 'RENDER_OUTPUT_NOT_READY',
        message: 'فایل خروجی رندرشده هنوز آماده نیست.',
      });
      return;
    }
    const safeBase = snap.filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="avapardaz-edited-${safeBase || 'output'}.wav"`,
    );
    res.send(Buffer.from(wav));
  });

  router.post('/jobs/:jobId/cancel', (req, res) => {
    try {
      const snap = jobManager.cancelJob(req.params.jobId);
      res.json(snap);
    } catch (err) {
      const e = toHttpError(err);
      res.status(e.status).json({ error: e.code, code: e.code, message: e.message });
    }
  });

  router.delete('/jobs/:jobId', (req, res) => {
    const removed = jobManager.disposeJob(req.params.jobId);
    res.json({ ok: removed, jobId: req.params.jobId });
  });

  return { router, jobManager };
}
