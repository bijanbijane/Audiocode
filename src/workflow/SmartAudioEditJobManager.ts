/**
 * AVAPARDAZ — SMART AUDIO EDIT JOB MANAGER & RESOURCE CONTROLLER (AVP-EXECUTION-001 + PHASE 1A)
 *
 * Manages owner-isolated Smart Audio Edit jobs with strict security & resource budgets:
 * - Strict ownerId binding & anti-IDOR ownership verification on every job operation
 * - Cryptographically unguessable 128-bit Job IDs (`job_<32-hex>`)
 * - Per-owner job quota, per-owner concurrency ceiling, global ASR/Render ceilings
 * - Byte-budgeted retention (`maxTotalRetainedBytes`) & TTL expiration with automatic cleanup
 * - External AbortSignal & timeout propagation to stop in-flight work on disconnect/cancel
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AudioRenderConfig, AudioRenderResult } from '../audio-renderer/AudioRenderTypes';
import { readRenderArtifactToUint8Array } from '../audio-renderer/RenderOutputArtifact';
import type { AudioEditJob } from './AudioEditJobStateMachine';
import { transitionAudioEditJob } from './AudioEditJobStateMachine';
import type {
  BatchLowRiskApprovalResult,
  SmartAudioEditSession,
  SmartEditPreviewMode,
  SmartEditPreviewResult,
} from './SmartAudioEditContracts';
import {
  SmartAudioEditError,
  SmartAudioEditPipeline,
  type ImportedAudioContext,
} from './SmartAudioEditPipeline';

export const SMART_EDIT_RESOURCE_LIMITS = Object.freeze({
  defaultWorkerConcurrency: 1,
  maxSimultaneousAsrJobs: 1,
  maxSimultaneousRenderJobs: 1,
  maxConcurrentActiveJobsPerOwner: 1,
  maxJobsPerOwner: 4,
  chunkSizeSamples: 32768,
  maxRetainedJobs: 8,
  maxTotalRetainedBytes: 256 * 1024 * 1024, // 256 MiB total retained audio budget
  jobTtlMs: 30 * 60 * 1000, // 30 minutes idle TTL
});

export interface SmartAudioEditJobManagerLimits {
  readonly maxSimultaneousAsrJobs?: number;
  readonly maxSimultaneousRenderJobs?: number;
  readonly maxConcurrentActiveJobsPerOwner?: number;
  readonly maxJobsPerOwner?: number;
  readonly maxRetainedJobs?: number;
  readonly maxTotalRetainedBytes?: number;
  readonly jobTtlMs?: number;
  /** When true (e.g., HTTP API / Hosted mode), omitting ownerId fails closed with JOB_ACCESS_DENIED. */
  readonly requireExplicitOwnerId?: boolean;
}

interface ManagedJobEntry {
  readonly ownerId: string;
  job: AudioEditJob;
  session: SmartAudioEditSession;
  audio: ImportedAudioContext | null;
  activeAbort: AbortController | null;
  lastPreviewWav: Uint8Array | null;
  lastPreviewMode: SmartEditPreviewMode | null;
  lastOutputWav: Uint8Array | null;
  lastOutputMeta: AudioRenderResult['output'];
  lastValidationSummary: {
    readonly prePassed: boolean;
    readonly postPassed: boolean;
    readonly verifiedOutputSamples: number | null;
    readonly verifiedDurationSec: number | null;
    readonly verifiedOutputHash: string | null;
  } | null;
  tempArtifactPaths: string[];
  lastAccessedAtMs: number;
}

export interface JobSnapshotResponse {
  readonly job: AudioEditJob;
  readonly filename: string;
  readonly sourceSampleRate: number;
  readonly sourceChannels: number;
  readonly totalSourceSamples: number;
  readonly sourceDurationSec: number;
  readonly waveformPeaks: readonly number[];
  readonly transcript: SmartAudioEditSession['transcript'];
  readonly asrMetrics: SmartAudioEditSession['asrMetrics'];
  readonly edl: SmartAudioEditSession['edl'];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasPreviewWav: boolean;
  readonly hasOutputWav: boolean;
  readonly lastOutputMeta: AudioRenderResult['output'];
  readonly lastValidationSummary: ManagedJobEntry['lastValidationSummary'];
  readonly stageTrace: SmartAudioEditSession['stageTrace'];
}

function estimateEntryRetainedBytes(entry: ManagedJobEntry): number {
  let total = 0;
  if (entry.audio) {
    total += entry.audio.rawBytes?.byteLength ?? 0;
    total += entry.audio.canonical16kMono?.byteLength ?? 0;
    // Account for decoded planar channels + mono downmix if retained
    total += entry.audio.totalSourceSamples * 4 * (entry.audio.sourceChannels + 1);
  }
  total += entry.lastPreviewWav?.byteLength ?? 0;
  total += entry.lastOutputWav?.byteLength ?? 0;
  return total;
}

export class SmartAudioEditJobManager {
  public readonly pipeline: SmartAudioEditPipeline;
  private readonly jobs = new Map<string, ManagedJobEntry>();
  private readonly limits: Required<SmartAudioEditJobManagerLimits>;
  private activeAsrCount = 0;
  private activeRenderCount = 0;

  constructor(pipeline?: SmartAudioEditPipeline, limits?: SmartAudioEditJobManagerLimits) {
    this.pipeline = pipeline ?? new SmartAudioEditPipeline();
    this.limits = {
      maxSimultaneousAsrJobs: Math.max(
        1,
        limits?.maxSimultaneousAsrJobs ?? SMART_EDIT_RESOURCE_LIMITS.maxSimultaneousAsrJobs,
      ),
      maxSimultaneousRenderJobs: Math.max(
        1,
        limits?.maxSimultaneousRenderJobs ?? SMART_EDIT_RESOURCE_LIMITS.maxSimultaneousRenderJobs,
      ),
      maxConcurrentActiveJobsPerOwner: Math.max(
        1,
        limits?.maxConcurrentActiveJobsPerOwner ??
          SMART_EDIT_RESOURCE_LIMITS.maxConcurrentActiveJobsPerOwner,
      ),
      maxJobsPerOwner: Math.max(
        1,
        limits?.maxJobsPerOwner ?? SMART_EDIT_RESOURCE_LIMITS.maxJobsPerOwner,
      ),
      maxRetainedJobs: Math.max(
        1,
        limits?.maxRetainedJobs ?? SMART_EDIT_RESOURCE_LIMITS.maxRetainedJobs,
      ),
      maxTotalRetainedBytes: Math.max(
        1024 * 1024,
        limits?.maxTotalRetainedBytes ?? SMART_EDIT_RESOURCE_LIMITS.maxTotalRetainedBytes,
      ),
      jobTtlMs: Math.max(1_000, limits?.jobTtlMs ?? SMART_EDIT_RESOURCE_LIMITS.jobTtlMs),
      requireExplicitOwnerId: Boolean(limits?.requireExplicitOwnerId),
    };
  }

  public getTotalRetainedBytes(ownerId?: string): number {
    let sum = 0;
    for (const entry of this.jobs.values()) {
      if (ownerId !== undefined && entry.ownerId !== ownerId) continue;
      sum += estimateEntryRetainedBytes(entry);
    }
    return sum;
  }

  public getResourceStatus(ownerId?: string) {
    this.sweepExpiredJobs();
    if (ownerId !== undefined) {
      let ownedJobs = 0;
      let ownedActive = 0;
      for (const entry of this.jobs.values()) {
        if (entry.ownerId === ownerId) {
          ownedJobs++;
          if (entry.activeAbort !== null) ownedActive++;
        }
      }
      return {
        maxJobsPerOwner: this.limits.maxJobsPerOwner,
        maxConcurrentActiveJobsPerOwner: this.limits.maxConcurrentActiveJobsPerOwner,
        trackedJobs: ownedJobs,
        activeJobs: ownedActive,
        retainedBytes: this.getTotalRetainedBytes(ownerId),
      };
    }
    return {
      ...SMART_EDIT_RESOURCE_LIMITS,
      ...this.limits,
      activeAsrJobs: this.activeAsrCount,
      activeRenderJobs: this.activeRenderCount,
      trackedJobs: this.jobs.size,
      retainedBytes: this.getTotalRetainedBytes(),
      processRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
    };
  }

  public createJobFromAudio(params: {
    readonly ownerId?: string;
    readonly audioBytes?: Buffer;
    readonly audioFilePath?: string;
    readonly filename?: string;
    readonly projectId?: string;
    readonly jobId?: string;
  }): JobSnapshotResponse {
    const trimmedOwner = typeof params.ownerId === 'string' ? params.ownerId.trim() : '';
    if (this.limits.requireExplicitOwnerId && !trimmedOwner) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'هویت مالک Job الزامی است.');
    }
    const ownerId = trimmedOwner || 'local-internal';
    this.sweepExpiredJobs();
    this.evictIdleJobsIfNeeded();

    // Enforce per-owner job quota (evict owner's oldest idle job if possible, otherwise reject)
    const ownerJobs = Array.from(this.jobs.entries()).filter(([, e]) => e.ownerId === ownerId);
    if (ownerJobs.length >= this.limits.maxJobsPerOwner) {
      const oldestIdleOwned = ownerJobs.find(([, e]) => !e.activeAbort);
      if (oldestIdleOwned) {
        this.disposeEntryInternal(oldestIdleOwned[0]);
      } else {
        throw new SmartAudioEditError(
          'OWNER_JOB_QUOTA_EXCEEDED',
          `حداکثر تعداد Job فعال برای این کاربر (${this.limits.maxJobsPerOwner}) تکمیل شده است.`,
        );
      }
    }

    // Generate cryptographically unguessable 128-bit Job ID unless explicitly provided internally
    const jobId = params.jobId ?? `job_${crypto.randomBytes(16).toString('hex')}`;
    const { job, session, audio } = this.pipeline.importAndNormalizeAudio({
      ...params,
      jobId,
    });
    const entry: ManagedJobEntry = {
      ownerId,
      job,
      session,
      audio,
      activeAbort: null,
      lastPreviewWav: null,
      lastPreviewMode: null,
      lastOutputWav: null,
      lastOutputMeta: null,
      lastValidationSummary: null,
      tempArtifactPaths: [],
      lastAccessedAtMs: Date.now(),
    };
    this.jobs.set(job.jobId, entry);
    this.evictIdleJobsIfNeeded(job.jobId);
    return this.toSnapshot(entry);
  }

  public async runTranscribeAndAnalyze(
    jobId: string,
    options?: {
      readonly ownerId?: string;
      readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<JobSnapshotResponse> {
    this.sweepExpiredJobs();
    const entry = this.requireEntry(jobId, options?.ownerId);
    if (!entry.audio) {
      throw new SmartAudioEditError('AUDIO_BUFFER_DISPOSED', 'Audio buffer has already been released.');
    }
    this.assertOwnerConcurrencyAvailable(entry.ownerId);
    if (this.activeAsrCount >= this.limits.maxSimultaneousAsrJobs) {
      throw new SmartAudioEditError(
        'ASR_CONCURRENCY_LIMIT',
        `ASR_CONCURRENCY_LIMIT: Maximum simultaneous ASR jobs (${this.limits.maxSimultaneousAsrJobs}) already active.`,
      );
    }

    const { controller, cleanup } = this.linkAbortController(options?.signal, options?.timeoutMs);
    entry.activeAbort = controller;
    entry.lastAccessedAtMs = Date.now();
    this.activeAsrCount++;

    try {
      const afterAsr = await this.pipeline.transcribe({
        job: entry.job,
        session: entry.session,
        audio: entry.audio,
        languageHint: options?.languageHint ?? 'fa',
        signal: controller.signal,
        onJobUpdate: (updated) => {
          entry.job = updated;
        },
      });
      entry.job = afterAsr.job;
      entry.session = afterAsr.session;

      if (controller.signal.aborted) {
        throw new SmartAudioEditError('TRANSCRIPTION_CANCELLED', 'عملیات رونویسی لغو شد.');
      }

      const afterAnalysis = await this.pipeline.analyzeAndGenerateEdl({
        job: entry.job,
        session: entry.session,
        audio: entry.audio,
        onJobUpdate: (updated) => {
          entry.job = updated;
        },
      });
      entry.job = afterAnalysis.job;
      entry.session = afterAnalysis.session;
      entry.lastAccessedAtMs = Date.now();
      return this.toSnapshot(entry);
    } finally {
      cleanup();
      this.activeAsrCount = Math.max(0, this.activeAsrCount - 1);
      entry.activeAbort = null;
    }
  }

  public applyDecision(
    jobId: string,
    params: {
      readonly ownerId?: string;
      readonly action:
        | 'APPROVE'
        | 'REJECT'
        | 'RETURN_TO_REVIEW'
        | 'APPROVE_ALL_LOW_RISK'
        | 'UNDO'
        | 'REDO';
      readonly proposalIds?: readonly string[];
      readonly reason?: string;
    },
  ): { readonly snapshot: JobSnapshotResponse; readonly batchResult?: BatchLowRiskApprovalResult } {
    this.sweepExpiredJobs();
    const entry = this.requireEntry(jobId, params.ownerId);
    const res = this.pipeline.applyUserDecision({
      job: entry.job,
      session: entry.session,
      action: params.action,
      proposalIds: params.proposalIds,
      reason: params.reason,
    });
    entry.job = res.job;
    entry.session = res.session;
    entry.lastAccessedAtMs = Date.now();
    return { snapshot: this.toSnapshot(entry), batchResult: res.batchResult };
  }

  public async generatePreview(
    jobId: string,
    params: {
      readonly ownerId?: string;
      readonly mode: SmartEditPreviewMode;
      readonly proposalId?: string;
      readonly contextPaddingMs?: number;
      readonly crossfadeMs?: number;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<{ readonly snapshot: JobSnapshotResponse; readonly preview: SmartEditPreviewResult }> {
    this.sweepExpiredJobs();
    const entry = this.requireEntry(jobId, params.ownerId);
    if (!entry.audio) {
      throw new SmartAudioEditError('AUDIO_BUFFER_DISPOSED', 'Audio buffer has been disposed.');
    }
    this.assertOwnerConcurrencyAvailable(entry.ownerId);

    const { controller, cleanup } = this.linkAbortController(params.signal, params.timeoutMs);
    entry.activeAbort = controller;
    entry.lastAccessedAtMs = Date.now();
    try {
      const res = await this.pipeline.generatePreview({
        job: entry.job,
        session: entry.session,
        audio: entry.audio,
        mode: params.mode,
        proposalId: params.proposalId,
        contextPaddingMs: params.contextPaddingMs,
        crossfadeMs: params.crossfadeMs,
        abortSignal: controller.signal,
        onJobUpdate: (updated) => {
          entry.job = updated;
        },
      });
      entry.job = res.job;
      entry.session = res.session;
      entry.lastPreviewWav = res.preview.ok ? res.preview.wavBytes : null;
      entry.lastPreviewMode = res.preview.ok ? params.mode : null;
      entry.lastAccessedAtMs = Date.now();
      this.evictIdleJobsIfNeeded(jobId);
      return { snapshot: this.toSnapshot(entry), preview: res.preview };
    } finally {
      cleanup();
      entry.activeAbort = null;
    }
  }

  public async renderFinal(
    jobId: string,
    params?: {
      readonly ownerId?: string;
      readonly config?: Partial<AudioRenderConfig>;
      readonly outputFilePath?: string;
      readonly releaseSourceAfterRender?: boolean;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<{
    readonly snapshot: JobSnapshotResponse;
    readonly renderResult: AudioRenderResult;
    readonly wavBytes: Uint8Array;
  }> {
    this.sweepExpiredJobs();
    const entry = this.requireEntry(jobId, params?.ownerId);
    if (!entry.audio) {
      throw new SmartAudioEditError('AUDIO_BUFFER_DISPOSED', 'Audio buffer has been disposed.');
    }
    this.assertOwnerConcurrencyAvailable(entry.ownerId);
    if (this.activeRenderCount >= this.limits.maxSimultaneousRenderJobs) {
      throw new SmartAudioEditError(
        'RENDER_CONCURRENCY_LIMIT',
        `RENDER_CONCURRENCY_LIMIT: Maximum simultaneous Render jobs (${this.limits.maxSimultaneousRenderJobs}) already active.`,
      );
    }

    const { controller, cleanup } = this.linkAbortController(params?.signal, params?.timeoutMs);
    entry.activeAbort = controller;
    entry.lastAccessedAtMs = Date.now();
    this.activeRenderCount++;

    try {
      const res = await this.pipeline.renderAndExport({
        job: entry.job,
        session: entry.session,
        audio: entry.audio,
        config: {
          chunkSizeSamples: SMART_EDIT_RESOURCE_LIMITS.chunkSizeSamples,
          ...params?.config,
        },
        outputFilePath: params?.outputFilePath,
        abortSignal: controller.signal,
        onJobUpdate: (updated) => {
          entry.job = updated;
        },
      });

      entry.job = res.job;
      entry.session = res.session;
      entry.lastOutputMeta = res.renderResult.output;
      entry.lastValidationSummary = {
        prePassed: res.renderResult.preValidation.passed,
        postPassed: Boolean(res.renderResult.postValidation?.passed),
        verifiedOutputSamples: res.renderResult.postValidation?.verifiedOutputSamples ?? null,
        verifiedDurationSec: res.renderResult.postValidation?.verifiedDurationSec ?? null,
        verifiedOutputHash: res.renderResult.postValidation?.verifiedOutputHash ?? null,
      };

      let wavBytes: Uint8Array = new Uint8Array(0);
      if (res.renderResult.outputArtifact) {
        try {
          wavBytes = await readRenderArtifactToUint8Array(res.renderResult.outputArtifact);
          entry.lastOutputWav = wavBytes;
        } finally {
          await res.renderResult.outputArtifact.dispose();
        }
      }

      if (params?.outputFilePath) {
        entry.tempArtifactPaths.push(params.outputFilePath);
      }

      if (params?.releaseSourceAfterRender) {
        entry.audio = null;
      }

      entry.lastAccessedAtMs = Date.now();
      this.evictIdleJobsIfNeeded(jobId);
      return { snapshot: this.toSnapshot(entry), renderResult: res.renderResult, wavBytes };
    } finally {
      cleanup();
      this.activeRenderCount = Math.max(0, this.activeRenderCount - 1);
      entry.activeAbort = null;
    }
  }

  public cancelJob(jobId: string, ownerId?: string): JobSnapshotResponse {
    this.sweepExpiredJobs();
    const entry = this.requireEntry(jobId, ownerId);
    if (entry.activeAbort) {
      entry.activeAbort.abort();
    }
    if (entry.job.status !== 'CANCELLED' && entry.job.status !== 'COMPLETED' && entry.job.status !== 'FAILED') {
      entry.job = transitionAudioEditJob(entry.job, 'CANCELLED', {
        errorMessage: 'عملیات توسط کاربر لغو شد.',
      });
    }
    entry.lastAccessedAtMs = Date.now();
    return this.toSnapshot(entry);
  }

  public getJobSnapshot(jobId: string, ownerId?: string): JobSnapshotResponse | null {
    this.sweepExpiredJobs();
    if (this.limits.requireExplicitOwnerId && (!ownerId || ownerId.trim().length === 0)) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی بدون هویت مالک مجاز نیست.');
    }
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    if (ownerId !== undefined && entry.ownerId !== ownerId) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی به این Job مجاز نیست.');
    }
    entry.lastAccessedAtMs = Date.now();
    return this.toSnapshot(entry);
  }

  public listJobs(ownerId?: string): readonly AudioEditJob[] {
    this.sweepExpiredJobs();
    if (this.limits.requireExplicitOwnerId && (!ownerId || ownerId.trim().length === 0)) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'فهرست Jobها بدون هویت مالک مجاز نیست.');
    }
    const list: AudioEditJob[] = [];
    for (const entry of this.jobs.values()) {
      if (ownerId !== undefined && entry.ownerId !== ownerId) continue;
      list.push(entry.job);
    }
    return list;
  }

  public getLastPreviewWav(jobId: string, ownerId?: string): Uint8Array | null {
    this.sweepExpiredJobs();
    if (this.limits.requireExplicitOwnerId && (!ownerId || ownerId.trim().length === 0)) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی بدون هویت مالک مجاز نیست.');
    }
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    if (ownerId !== undefined && entry.ownerId !== ownerId) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی به خروجی این Job مجاز نیست.');
    }
    entry.lastAccessedAtMs = Date.now();
    return entry.lastPreviewWav;
  }

  public getLastOutputWav(jobId: string, ownerId?: string): Uint8Array | null {
    this.sweepExpiredJobs();
    if (this.limits.requireExplicitOwnerId && (!ownerId || ownerId.trim().length === 0)) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی بدون هویت مالک مجاز نیست.');
    }
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    if (ownerId !== undefined && entry.ownerId !== ownerId) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی به خروجی این Job مجاز نیست.');
    }
    entry.lastAccessedAtMs = Date.now();
    return entry.lastOutputWav;
  }

  public disposeJob(jobId: string, ownerId?: string): boolean {
    if (this.limits.requireExplicitOwnerId && (!ownerId || ownerId.trim().length === 0)) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'حذف Job بدون هویت مالک مجاز نیست.');
    }
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    if (ownerId !== undefined && entry.ownerId !== ownerId) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'حذف Job متعلق به کاربر دیگر مجاز نیست.');
    }
    return this.disposeEntryInternal(jobId);
  }

  public disposeAll(): void {
    for (const jobId of Array.from(this.jobs.keys())) {
      this.disposeEntryInternal(jobId);
    }
  }

  private disposeEntryInternal(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    entry.activeAbort?.abort();
    entry.audio = null;
    entry.lastPreviewWav = null;
    entry.lastOutputWav = null;
    for (const tempPath of entry.tempArtifactPaths) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // ignore cleanup error
      }
    }
    entry.tempArtifactPaths.length = 0;
    return this.jobs.delete(jobId);
  }

  private assertOwnerConcurrencyAvailable(ownerId: string): void {
    let activeForOwner = 0;
    for (const entry of this.jobs.values()) {
      if (entry.ownerId === ownerId && entry.activeAbort !== null) {
        activeForOwner++;
      }
    }
    if (activeForOwner >= this.limits.maxConcurrentActiveJobsPerOwner) {
      throw new SmartAudioEditError(
        'OWNER_CONCURRENCY_LIMIT_EXCEEDED',
        `سقف عملیات هم‌زمان برای این کاربر (${this.limits.maxConcurrentActiveJobsPerOwner}) تکمیل شده است.`,
      );
    }
  }

  private linkAbortController(
    externalSignal?: AbortSignal,
    timeoutMs?: number,
  ): { readonly controller: AbortController; readonly cleanup: () => void } {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    return {
      controller,
      cleanup: () => {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  private requireEntry(jobId: string, ownerId?: string): ManagedJobEntry {
    if (this.limits.requireExplicitOwnerId && (!ownerId || ownerId.trim().length === 0)) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'هویت مالک Job الزامی است.');
    }
    const entry = this.jobs.get(jobId);
    if (!entry) {
      throw new SmartAudioEditError('JOB_NOT_FOUND', `JOB_NOT_FOUND: Job ${jobId} does not exist.`);
    }
    if (ownerId !== undefined && entry.ownerId !== ownerId) {
      throw new SmartAudioEditError('JOB_ACCESS_DENIED', 'دسترسی به این Job مجاز نیست.');
    }
    return entry;
  }

  private sweepExpiredJobs(nowMs = Date.now()): void {
    for (const [jobId, entry] of this.jobs.entries()) {
      if (!entry.activeAbort && nowMs - entry.lastAccessedAtMs > this.limits.jobTtlMs) {
        this.disposeEntryInternal(jobId);
      }
    }
  }

  /**
   * Evicts idle jobs (oldest first) whenever total job count OR retained byte budget exceeds caps.
   * Unlike the previous implementation, active jobs are skipped rather than halting eviction.
   */
  private evictIdleJobsIfNeeded(protectedJobId?: string): void {
    const candidates = Array.from(this.jobs.entries())
      .filter(([id, entry]) => id !== protectedJobId && !entry.activeAbort)
      .sort((a, b) => a[1].lastAccessedAtMs - b[1].lastAccessedAtMs);

    for (const [jobId] of candidates) {
      const overCount = this.jobs.size >= this.limits.maxRetainedJobs && !protectedJobId
        ? true
        : this.jobs.size > this.limits.maxRetainedJobs;
      const overBytes = this.getTotalRetainedBytes() > this.limits.maxTotalRetainedBytes;
      if (!overCount && !overBytes) break;
      this.disposeEntryInternal(jobId);
    }
  }

  private toSnapshot(entry: ManagedJobEntry): JobSnapshotResponse {
    return {
      job: entry.job,
      filename: entry.session.filename,
      sourceSampleRate: entry.session.sourceSampleRate,
      sourceChannels: entry.session.sourceChannels,
      totalSourceSamples: entry.session.totalSourceSamples,
      sourceDurationSec: entry.session.sourceDurationSec,
      waveformPeaks: entry.audio?.waveformPeaks ?? [],
      transcript: entry.session.transcript,
      asrMetrics: entry.session.asrMetrics,
      edl: entry.session.edl,
      canUndo: entry.session.edlHistoryIndex > 0,
      canRedo: entry.session.edlHistoryIndex < entry.session.edlHistory.length - 1,
      hasPreviewWav: entry.lastPreviewWav !== null,
      hasOutputWav: entry.lastOutputWav !== null,
      lastOutputMeta: entry.lastOutputMeta,
      lastValidationSummary: entry.lastValidationSummary,
      stageTrace: entry.session.stageTrace,
    };
  }
}
