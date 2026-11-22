/**
 * AVAPARDAZ — SMART AUDIO EDIT JOB MANAGER & RESOURCE CONTROLLER (AVP-EXECUTION-001 Section 4 & 10)
 *
 * Manages isolated Smart Audio Edit jobs with strict resource budgets:
 * - Default Worker Concurrency: 1
 * - Maximum Simultaneous ASR Jobs: 1
 * - Maximum Simultaneous Render Jobs: 1
 * - Chunk Size: 32768 samples
 * - Cancellation propagation via per-job AbortController
 * - Bounded memory retention & cleanup of temporary buffers/artifacts
 */

import type { AudioRenderConfig, AudioRenderResult } from '../audio-renderer/AudioRenderTypes';
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
  chunkSizeSamples: 32768,
  maxRetainedJobs: 8,
});

interface ManagedJobEntry {
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

export class SmartAudioEditJobManager {
  public readonly pipeline: SmartAudioEditPipeline;
  private readonly jobs = new Map<string, ManagedJobEntry>();
  private activeAsrCount = 0;
  private activeRenderCount = 0;

  constructor(pipeline?: SmartAudioEditPipeline) {
    this.pipeline = pipeline ?? new SmartAudioEditPipeline();
  }

  public getResourceStatus() {
    return {
      ...SMART_EDIT_RESOURCE_LIMITS,
      activeAsrJobs: this.activeAsrCount,
      activeRenderJobs: this.activeRenderCount,
      trackedJobs: this.jobs.size,
      processRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
    };
  }

  public createJobFromAudio(params: {
    readonly audioBytes?: Buffer;
    readonly audioFilePath?: string;
    readonly filename?: string;
    readonly projectId?: string;
    readonly jobId?: string;
  }): JobSnapshotResponse {
    this.evictOldestIfNeeded();
    const { job, session, audio } = this.pipeline.importAndNormalizeAudio(params);
    const entry: ManagedJobEntry = {
      job,
      session,
      audio,
      activeAbort: null,
      lastPreviewWav: null,
      lastPreviewMode: null,
      lastOutputWav: null,
      lastOutputMeta: null,
      lastValidationSummary: null,
    };
    this.jobs.set(job.jobId, entry);
    return this.toSnapshot(entry);
  }

  public async runTranscribeAndAnalyze(
    jobId: string,
    options?: { readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto' },
  ): Promise<JobSnapshotResponse> {
    const entry = this.requireEntry(jobId);
    if (!entry.audio) {
      throw new SmartAudioEditError('AUDIO_BUFFER_DISPOSED', 'Audio buffer has already been released.');
    }
    if (this.activeAsrCount >= SMART_EDIT_RESOURCE_LIMITS.maxSimultaneousAsrJobs) {
      throw new SmartAudioEditError(
        'ASR_CONCURRENCY_LIMIT',
        'ASR_CONCURRENCY_LIMIT: Maximum simultaneous ASR jobs (1) already active.',
      );
    }

    const controller = new AbortController();
    entry.activeAbort = controller;
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

      const afterAnalysis = this.pipeline.analyzeAndGenerateEdl({
        job: entry.job,
        session: entry.session,
        audio: entry.audio,
        onJobUpdate: (updated) => {
          entry.job = updated;
        },
      });
      entry.job = afterAnalysis.job;
      entry.session = afterAnalysis.session;
      return this.toSnapshot(entry);
    } finally {
      this.activeAsrCount = Math.max(0, this.activeAsrCount - 1);
      entry.activeAbort = null;
    }
  }

  public applyDecision(
    jobId: string,
    params: {
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
    const entry = this.requireEntry(jobId);
    const res = this.pipeline.applyUserDecision({
      job: entry.job,
      session: entry.session,
      ...params,
    });
    entry.job = res.job;
    entry.session = res.session;
    return { snapshot: this.toSnapshot(entry), batchResult: res.batchResult };
  }

  public async generatePreview(
    jobId: string,
    params: {
      readonly mode: SmartEditPreviewMode;
      readonly proposalId?: string;
      readonly contextPaddingMs?: number;
      readonly crossfadeMs?: number;
    },
  ): Promise<{ readonly snapshot: JobSnapshotResponse; readonly preview: SmartEditPreviewResult }> {
    const entry = this.requireEntry(jobId);
    if (!entry.audio) {
      throw new SmartAudioEditError('AUDIO_BUFFER_DISPOSED', 'Audio buffer has been disposed.');
    }
    const controller = new AbortController();
    entry.activeAbort = controller;
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
      return { snapshot: this.toSnapshot(entry), preview: res.preview };
    } finally {
      entry.activeAbort = null;
    }
  }

  public async renderFinal(
    jobId: string,
    params?: {
      readonly config?: Partial<AudioRenderConfig>;
      readonly outputFilePath?: string;
      readonly releaseSourceAfterRender?: boolean;
    },
  ): Promise<{
    readonly snapshot: JobSnapshotResponse;
    readonly renderResult: AudioRenderResult;
    readonly wavBytes: Uint8Array;
  }> {
    const entry = this.requireEntry(jobId);
    if (!entry.audio) {
      throw new SmartAudioEditError('AUDIO_BUFFER_DISPOSED', 'Audio buffer has been disposed.');
    }
    if (this.activeRenderCount >= SMART_EDIT_RESOURCE_LIMITS.maxSimultaneousRenderJobs) {
      throw new SmartAudioEditError(
        'RENDER_CONCURRENCY_LIMIT',
        'RENDER_CONCURRENCY_LIMIT: Maximum simultaneous Render jobs (1) already active.',
      );
    }

    const controller = new AbortController();
    entry.activeAbort = controller;
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

      let wavBytes = new Uint8Array(0);
      if (res.renderResult.outputArtifact) {
        try {
          wavBytes = await res.renderResult.outputArtifact.readRange(
            0,
            res.renderResult.outputArtifact.sizeBytes,
          );
          entry.lastOutputWav = wavBytes;
        } finally {
          await res.renderResult.outputArtifact.dispose();
        }
      }

      if (params?.releaseSourceAfterRender) {
        entry.audio = null;
      }

      return { snapshot: this.toSnapshot(entry), renderResult: res.renderResult, wavBytes };
    } finally {
      this.activeRenderCount = Math.max(0, this.activeRenderCount - 1);
      entry.activeAbort = null;
    }
  }

  public cancelJob(jobId: string): JobSnapshotResponse {
    const entry = this.requireEntry(jobId);
    if (entry.activeAbort) {
      entry.activeAbort.abort();
    }
    if (entry.job.status !== 'CANCELLED' && entry.job.status !== 'COMPLETED' && entry.job.status !== 'FAILED') {
      entry.job = transitionAudioEditJob(entry.job, 'CANCELLED', {
        errorMessage: 'عملیات توسط کاربر لغو شد.',
      });
    }
    return this.toSnapshot(entry);
  }

  public getJobSnapshot(jobId: string): JobSnapshotResponse | null {
    const entry = this.jobs.get(jobId);
    return entry ? this.toSnapshot(entry) : null;
  }

  public listJobs(): readonly AudioEditJob[] {
    return Array.from(this.jobs.values()).map((e) => e.job);
  }

  public getLastPreviewWav(jobId: string): Uint8Array | null {
    return this.jobs.get(jobId)?.lastPreviewWav ?? null;
  }

  public getLastOutputWav(jobId: string): Uint8Array | null {
    return this.jobs.get(jobId)?.lastOutputWav ?? null;
  }

  public disposeJob(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    entry.activeAbort?.abort();
    entry.audio = null;
    entry.lastPreviewWav = null;
    entry.lastOutputWav = null;
    return this.jobs.delete(jobId);
  }

  private requireEntry(jobId: string): ManagedJobEntry {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      throw new SmartAudioEditError('JOB_NOT_FOUND', `JOB_NOT_FOUND: Job ${jobId} does not exist.`);
    }
    return entry;
  }

  private evictOldestIfNeeded(): void {
    while (this.jobs.size >= SMART_EDIT_RESOURCE_LIMITS.maxRetainedJobs) {
      const oldestKey = this.jobs.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.jobs.get(oldestKey);
      if (oldest && !oldest.activeAbort) {
        this.disposeJob(oldestKey);
      } else {
        break;
      }
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
