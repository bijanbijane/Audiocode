import { deterministicHexHash } from '../ai-engine/edit-decision/EditProvenance';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import {
  AudioExportWriter,
  BoundedChunkedByteSink,
  ExportWriteFailureError,
  StreamingByteSink,
} from './AudioExportWriter';
import { AudioRenderPlanner } from './AudioRenderPlanner';
import {
  AudioRenderRecovery,
  InMemoryRenderCheckpointStore,
  RenderCheckpointStore,
} from './AudioRenderRecovery';
import { AudioRenderValidator } from './AudioRenderValidator';
import { AudioSegmentAssembler } from './AudioSegmentAssembler';
import { AudioSourceReader } from './AudioSourceReader';
import {
  AudioRenderRequest,
  AudioRenderResult,
  RenderCheckpoint,
  RenderLifecycleState,
  RenderProgressSnapshot,
  RenderValidationReport,
} from './AudioRenderTypes';

export interface AudioRenderEngineOptions {
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly checkpointStore?: RenderCheckpointStore;
  readonly createSink?: (params: {
    readonly renderId: string;
    readonly estimatedOutputBytes: number;
    readonly maxOutputBytesQuota?: number;
    readonly memoryBudgetManager: MemoryBudgetManager;
  }) => StreamingByteSink;
}

/**
 * Production Non-Destructive Audio Rendering Engine (AVP-P06-001)
 *
 * Explicit lifecycle state machine:
 * QUEUED -> VALIDATING -> PLANNING -> RENDERING
 *   -> [PAUSED_MEMORY_PRESSURE | PAUSED_USER | CANCELLED | RECOVERABLE]
 *   -> FINALIZING -> VALIDATING_OUTPUT -> [COMPLETED | FAILED_VALIDATION | FAILED]
 *
 * Guarantees:
 * - Never mutates source audio, raw transcript, or approved EDL snapshots.
 * - Never loads entire source PCM into JS memory.
 * - Blocks completion if post-render validation fails (FAILED_VALIDATION).
 * - Preserves verified checkpoints on cancellation or memory-pressure pause.
 */
export class AudioRenderEngine {
  private readonly budget: MemoryBudgetManager;
  private readonly checkpointStore: RenderCheckpointStore;
  private readonly createSinkFn?: AudioRenderEngineOptions['createSink'];
  private activeRenderIds = new Set<string>();

  constructor(options: AudioRenderEngineOptions = {}) {
    this.budget = options.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.checkpointStore = options.checkpointStore ?? new InMemoryRenderCheckpointStore();
    this.createSinkFn = options.createSink;
  }

  public getCheckpointStore(): RenderCheckpointStore {
    return this.checkpointStore;
  }

  public isRenderActive(renderId?: string): boolean {
    if (renderId) return this.activeRenderIds.has(renderId);
    return this.activeRenderIds.size > 0;
  }

  public async render(request: AudioRenderRequest): Promise<AudioRenderResult> {
    return this.executeRender(request, null);
  }

  public async resumeFromCheckpoint(
    request: AudioRenderRequest,
    checkpoint: RenderCheckpoint,
  ): Promise<AudioRenderResult> {
    return this.executeRender(request, checkpoint);
  }

  private async executeRender(
    request: AudioRenderRequest,
    checkpointToResume: RenderCheckpoint | null,
  ): Promise<AudioRenderResult> {
    const startWallMs = Date.now();
    const nowMs = request.nowMs ?? startWallMs;
    const renderId =
      request.renderId ??
      `rnd_${deterministicHexHash(
        `${request.edl.edlId}:${request.edl.edlVersion}:${request.source.sourceAudioHash}:${request.config.encoding}:${nowMs}`,
      )}`;

    if (this.activeRenderIds.has(renderId)) {
      const preValidation: RenderValidationReport = {
        phase: 'PRE_RENDER',
        passed: false,
        errorCount: 1,
        warningCount: 0,
        failures: [
          {
            code: 'INVALID_SOURCE_IDENTITY',
            severity: 'ERROR',
            message: `Duplicate active render request detected for renderId "${renderId}".`,
            actionableFix: 'Wait for the active render to complete or cancel it first.',
          },
        ],
      };
      return {
        renderId,
        state: 'FAILED',
        ok: false,
        plan: null,
        output: null,
        outputBytes: null,
        preValidation,
        postValidation: null,
        boundaryChecks: [],
        crossfadeResults: [],
        checkpoint: null,
        sourceDurationSec: request.source.totalSamples / request.source.sampleRate,
        outputDurationSec: 0,
        removedDurationSec: 0,
        wallClockMs: Date.now() - startWallMs,
        realTimeFactor: null,
        peakReservedBytes: this.budget.getSnapshot().accountedBytes,
        sourceImmutableVerified: true,
        edlImmutableVerified: true,
        appliedProposalIds: [],
        failureReason: preValidation.failures[0].message,
      };
    }

    this.activeRenderIds.add(renderId);

    const emitState = (
      state: RenderLifecycleState,
      currentOperation: string,
      progressPercent: number | null,
      processedSourceSamples = 0,
      writtenOutputSamples = 0,
      expectedOutputSamples = request.source.totalSamples,
      currentSegmentIndex = 0,
      totalSegments = 0,
    ) => {
      const snap = this.budget.getSnapshot();
      const snapshot: RenderProgressSnapshot = {
        renderId,
        state,
        progressPercent,
        currentOperation,
        processedSourceSamples,
        totalSourceSamples: request.source.totalSamples,
        writtenOutputSamples,
        expectedOutputSamples,
        currentSegmentIndex,
        totalSegments,
        memoryPressure: snap.pressureLevel,
        accountedMemoryBytes: snap.accountedBytes,
        elapsedMs: Math.max(0, Date.now() - startWallMs),
      };
      request.onProgress?.(snapshot);
    };

    const sourceDurationSec =
      request.source.sampleRate > 0
        ? request.source.totalSamples / request.source.sampleRate
        : 0;

    let reader: AudioSourceReader | null = null;
    let sink: StreamingByteSink | null = null;
    let writer: AudioExportWriter | null = null;

    try {
      emitState('QUEUED', 'صف‌بندی درخواست رندر غیرمخرب', 0);

      if (request.abortSignal?.aborted) {
        emitState('CANCELLED', 'رندر پیش از شروع لغو شد', 0);
        return this.makeFailedResult({
          renderId,
          state: 'CANCELLED',
          plan: null,
          preValidation: {
            phase: 'PRE_RENDER',
            passed: false,
            errorCount: 0,
            warningCount: 0,
            failures: [],
          },
          sourceDurationSec,
          startWallMs,
          peakReservedBytes: this.budget.getSnapshot().accountedBytes,
          failureReason: 'Render aborted before planning.',
        });
      }

      emitState('VALIDATING', 'اعتبارسنجی شناسه منبع، نسخه EDL و پیشنهادهای تاییدشده', 2);
      emitState('PLANNING', 'محاسبه نقشه قطعی برش‌ها بر مبنای مختصات نمونه منبع', 5);

      const planResult = AudioRenderPlanner.buildPlan({
        edl: request.edl,
        sourceAudioId: request.source.sourceAudioId,
        sourceAudioHash: request.source.sourceAudioHash,
        sourceSampleRate: request.source.sampleRate,
        channelCount: request.source.channelCount,
        totalSourceSamples: request.source.totalSamples,
        expectedSourceAudioHash: request.expectedSourceAudioHash,
        expectedTranscriptVersion: request.expectedTranscriptVersion,
        expectedEdlVersion: request.expectedEdlVersion,
        config: request.config,
        projectDocument: request.projectDocument,
        proposalIds: request.proposalIds,
        nowMs,
      });

      if (!planResult.ok || !planResult.plan) {
        const preValidation: RenderValidationReport = {
          phase: 'PRE_RENDER',
          passed: false,
          errorCount: planResult.failures.filter((f) => f.severity === 'ERROR').length,
          warningCount: planResult.failures.filter((f) => f.severity === 'WARNING').length,
          failures: planResult.failures,
        };
        emitState('FAILED_VALIDATION', 'اعتبارسنجی پیش از رندر ناموفق بود', null);
        return this.makeFailedResult({
          renderId,
          state: 'FAILED_VALIDATION',
          plan: null,
          preValidation,
          sourceDurationSec,
          startWallMs,
          peakReservedBytes: this.budget.getSnapshot().accountedBytes,
          failureReason: planResult.failures.map((f) => f.message).join(' | '),
        });
      }

      const plan = planResult.plan;

      // Validate resume checkpoint compatibility BEFORE any writes
      if (checkpointToResume) {
        const cpCheck = AudioRenderRecovery.validateCheckpointCompatibility(
          checkpointToResume,
          plan,
        );
        if (!cpCheck.compatible) {
          const preValidation: RenderValidationReport = {
            phase: 'PRE_RENDER',
            passed: false,
            errorCount: cpCheck.failures.length,
            warningCount: 0,
            failures: cpCheck.failures,
          };
          emitState('FAILED_VALIDATION', 'نقطه بازیابی (Checkpoint) با نسخه فعلی ناسازگار است', null);
          return this.makeFailedResult({
            renderId,
            state: 'FAILED_VALIDATION',
            plan,
            preValidation,
            sourceDurationSec,
            startWallMs,
            peakReservedBytes: this.budget.getSnapshot().accountedBytes,
            failureReason: cpCheck.failures.map((f) => f.message).join(' | '),
          });
        }
      }

      const rawChunkSize = request.config.chunkSizeSamples ?? 16384;
      const chunkSizeSamples = Math.max(
        1024,
        Math.min(65536, Math.trunc(Number.isFinite(rawChunkSize) ? rawChunkSize : 16384)),
      );
      const estimatedWorkingBytes =
        chunkSizeSamples * plan.channelCount * Float32Array.BYTES_PER_ELEMENT * 2;

      const preValidation = AudioRenderValidator.validatePreRender({
        plan,
        memoryBudgetManager: this.budget,
        estimatedWorkingBytes,
      });

      if (!preValidation.passed) {
        const isMemError = preValidation.failures.some(
          (f) => f.code === 'MEMORY_BUDGET_EXHAUSTED',
        );
        const failState: RenderLifecycleState = isMemError
          ? 'PAUSED_MEMORY_PRESSURE'
          : 'FAILED_VALIDATION';
        emitState(failState, preValidation.failures[0]?.message ?? 'خطای اعتبارسنجی پیش از رندر', null);
        return this.makeFailedResult({
          renderId,
          state: failState,
          plan,
          preValidation,
          sourceDurationSec,
          startWallMs,
          peakReservedBytes: this.budget.getSnapshot().accountedBytes,
          failureReason: preValidation.failures.map((f) => f.message).join(' | '),
        });
      }

      // Initialize bounded source reader & streaming export writer
      reader = new AudioSourceReader(request.source, {
        memoryBudgetManager: this.budget,
        cacheBlockSamples: Math.min(16384, chunkSizeSamples),
      });

      sink = this.createSinkFn
        ? this.createSinkFn({
            renderId,
            estimatedOutputBytes: plan.estimatedOutputBytes,
            maxOutputBytesQuota: request.config.maxOutputBytesQuota,
            memoryBudgetManager: this.budget,
          })
        : new BoundedChunkedByteSink({
            memoryBudgetManager: this.budget,
            maxQuotaBytes: request.config.maxOutputBytesQuota,
          });

      writer = new AudioExportWriter({
        renderId,
        artifactId: `artifact_${plan.planHash}_${nowMs}`,
        container: plan.container,
        encoding: plan.encoding,
        sampleRate: plan.outputSampleRate,
        channelCount: plan.channelCount,
        sink,
      });

      const headerSizeBytes = plan.container === 'rf64' ? 80 : 44;
      const canResumeSinkInPlace =
        Boolean(checkpointToResume) &&
        plan.outputSampleRate === plan.sourceSampleRate &&
        sink.getTotalBytesWritten() === headerSizeBytes + checkpointToResume!.writtenDataBytes;

      let effectiveResume: RenderCheckpoint | null = null;
      if (canResumeSinkInPlace && checkpointToResume) {
        writer.resumeFromCheckpointState({
          writtenSamples: checkpointToResume.writtenOutputSamples,
          writtenDataBytes: checkpointToResume.writtenDataBytes,
          partialHashState: checkpointToResume.partialOutputHashState,
        });
        effectiveResume = checkpointToResume;
      } else {
        await writer.begin();
      }

      emitState(
        'RENDERING',
        'در حال مونتاژ جریانی و اعمال Crossfade ایمن در مرز برش‌ها',
        8,
        0,
        writer.getWrittenSamples(),
        plan.expectedOutputSamples,
        effectiveResume?.completedSegmentIndex ?? 0,
        plan.retainedSegments.length,
      );

      const assembly = await AudioSegmentAssembler.assembleStream({
        plan,
        reader,
        memoryBudgetManager: this.budget,
        baseChunkSizeSamples: chunkSizeSamples,
        enableTransitionLimiter: request.config.enableTransitionLimiter ?? true,
        resumeFromCheckpoint: effectiveResume,
        abortSignal: request.abortSignal,
        shouldPauseUser: request.shouldPauseUser,
        onChunkReady: async (payload) => {
          await writer!.writePlanarChunk(payload.planarChannels, payload.sampleCount);
        },
        onProgress: (info) => {
          const pct =
            plan.expectedOutputSamples > 0
              ? Math.min(
                  92,
                  Math.max(
                    8,
                    Math.round(8 + (info.writtenOutputSamples / plan.expectedOutputSamples) * 84),
                  ),
                )
              : null;
          emitState(
            'RENDERING',
            `پردازش قطعه ${Math.min(info.segmentIndex + 1, plan.retainedSegments.length)} از ${plan.retainedSegments.length}`,
            pct,
            info.processedSourceSamples,
            info.writtenOutputSamples,
            plan.expectedOutputSamples,
            info.segmentIndex,
            plan.retainedSegments.length,
          );
        },
      });

      // Handle non-completed streaming states cleanly with verified recoverable checkpoint
      if (assembly.status !== 'COMPLETED') {
        const checkpoint = AudioRenderRecovery.createCheckpoint({
          renderId,
          plan,
          completedSegmentIndex: assembly.lastCompletedSegmentIndex,
          nextSegmentSampleOffset: assembly.nextSegmentSampleOffset,
          writtenOutputSamples: writer.getWrittenSamples(),
          writtenDataBytes: writer.getWrittenDataBytes(),
          partialOutputHashState: writer.getPartialHashState(),
          stateAtCheckpoint: assembly.status,
          nowMs: Date.now(),
        });
        await this.checkpointStore.saveCheckpoint(checkpoint);
        // Preserve already-written bytes on persistent sinks when pausing so resume works in-place;
        // always abort & clean up on explicit cancellation or non-persistent RAM sinks.
        if (assembly.status === 'CANCELLED' || !sink.persistedExternally) {
          await writer.abort();
        }

        emitState(
          assembly.status,
          assembly.reason ?? `رندر در وضعیت ${assembly.status} متوقف شد`,
          null,
          0,
          assembly.totalEmittedOutputSamples,
          plan.expectedOutputSamples,
          assembly.lastCompletedSegmentIndex,
          plan.retainedSegments.length,
        );

        return {
          renderId,
          state: assembly.status,
          ok: false,
          plan,
          output: null,
          outputBytes: null,
          preValidation,
          postValidation: null,
          boundaryChecks: assembly.boundaryChecks,
          crossfadeResults: assembly.crossfadeResults,
          checkpoint,
          sourceDurationSec,
          outputDurationSec: 0,
          removedDurationSec: plan.removedDurationSec,
          wallClockMs: Math.max(0, Date.now() - startWallMs),
          realTimeFactor: null,
          peakReservedBytes: assembly.peakReservedBytes,
          sourceImmutableVerified: true,
          edlImmutableVerified: true,
          appliedProposalIds: [],
          failureReason: assembly.reason,
        };
      }

      // Check cancellation right before finalization
      if (request.abortSignal?.aborted) {
        await writer.abort();
        emitState('CANCELLED', 'رندر در مرحله نهایی‌سازی لغو شد و فایل موقت پاکسازی گردید', null);
        return {
          renderId,
          state: 'CANCELLED',
          ok: false,
          plan,
          output: null,
          outputBytes: null,
          preValidation,
          postValidation: null,
          boundaryChecks: assembly.boundaryChecks,
          crossfadeResults: assembly.crossfadeResults,
          checkpoint: null,
          sourceDurationSec,
          outputDurationSec: 0,
          removedDurationSec: plan.removedDurationSec,
          wallClockMs: Math.max(0, Date.now() - startWallMs),
          realTimeFactor: null,
          peakReservedBytes: assembly.peakReservedBytes,
          sourceImmutableVerified: true,
          edlImmutableVerified: true,
          appliedProposalIds: [],
          failureReason: 'Render cancelled during finalization; temporary artifact removed.',
        };
      }

      emitState(
        'FINALIZING',
        'نهایی‌سازی هدر فایل خروجی و محاسبه امضای یکپارچگی',
        95,
        plan.totalSourceSamples,
        writer.getWrittenSamples(),
        plan.expectedOutputSamples,
        plan.retainedSegments.length,
        plan.retainedSegments.length,
      );

      const outputMetadata = await writer.finalize(Date.now());
      const outputBytes = await sink.readAllBytes();

      emitState(
        'VALIDATING_OUTPUT',
        'اعتبارسنجی مستقل هدر، تعداد نمونه، دامنه و هش فایل خروجی',
        98,
        plan.totalSourceSamples,
        outputMetadata.totalOutputSamples,
        plan.expectedOutputSamples,
        plan.retainedSegments.length,
        plan.retainedSegments.length,
      );

      const postValidation = AudioRenderValidator.validatePostRender({
        plan,
        outputMetadata,
        outputBytes,
      });

      const wallClockMs = Math.max(0, Date.now() - startWallMs);
      const realTimeFactor =
        sourceDurationSec > 0
          ? Number(((wallClockMs / 1000) / sourceDurationSec).toFixed(4))
          : null;

      if (!postValidation.passed) {
        emitState(
          'FAILED_VALIDATION',
          `اعتبارسنجی خروجی ناموفق بود (${postValidation.errorCount} خطا)`,
          100,
          plan.totalSourceSamples,
          outputMetadata.totalOutputSamples,
          plan.expectedOutputSamples,
          plan.retainedSegments.length,
          plan.retainedSegments.length,
        );
        return {
          renderId,
          state: 'FAILED_VALIDATION',
          ok: false,
          plan,
          output: outputMetadata,
          outputBytes: null, // Block unvalidated output from being treated as valid deliverable
          preValidation,
          postValidation,
          boundaryChecks: assembly.boundaryChecks,
          crossfadeResults: assembly.crossfadeResults,
          checkpoint: null,
          sourceDurationSec,
          outputDurationSec: outputMetadata.durationSec,
          removedDurationSec: plan.removedDurationSec,
          wallClockMs,
          realTimeFactor,
          peakReservedBytes: Math.max(
            assembly.peakReservedBytes,
            this.budget.getSnapshot().highWaterMarkBytes,
          ),
          sourceImmutableVerified: true,
          edlImmutableVerified: true,
          appliedProposalIds: [],
          failureReason: postValidation.failures.map((f) => f.message).join(' | '),
        };
      }

      if (checkpointToResume) {
        await this.checkpointStore.deleteCheckpoint(checkpointToResume.checkpointId);
      }

      emitState(
        'COMPLETED',
        'رندر و اعتبارسنجی مستقل خروجی با موفقیت تکمیل شد',
        100,
        plan.totalSourceSamples,
        outputMetadata.totalOutputSamples,
        plan.expectedOutputSamples,
        plan.retainedSegments.length,
        plan.retainedSegments.length,
      );

      return {
        renderId,
        state: 'COMPLETED',
        ok: true,
        plan,
        output: outputMetadata,
        outputBytes,
        preValidation,
        postValidation,
        boundaryChecks: assembly.boundaryChecks,
        crossfadeResults: assembly.crossfadeResults,
        checkpoint: null,
        sourceDurationSec,
        outputDurationSec: outputMetadata.durationSec,
        removedDurationSec: plan.removedDurationSec,
        wallClockMs,
        realTimeFactor,
        peakReservedBytes: Math.max(
          assembly.peakReservedBytes,
          this.budget.getSnapshot().highWaterMarkBytes,
        ),
        sourceImmutableVerified: true,
        edlImmutableVerified: true,
        appliedProposalIds: [...plan.approvedProposalIds],
      };
    } catch (err) {
      if (writer) {
        try {
          await writer.abort();
        } catch {
          // ignore cleanup failure
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      const isQuotaOrWrite = err instanceof ExportWriteFailureError;
      const failCode = isQuotaOrWrite ? err.code : 'WRITE_IO_FAILURE';

      emitState('FAILED', `خطای رندر: ${message}`, null);

      return this.makeFailedResult({
        renderId,
        state: 'FAILED',
        plan: null,
        preValidation: {
          phase: 'PRE_RENDER',
          passed: false,
          errorCount: 1,
          warningCount: 0,
          failures: [
            {
              code: failCode,
              severity: 'ERROR',
              message,
              actionableFix: 'Verify available storage quota and retry render.',
            },
          ],
        },
        sourceDurationSec,
        startWallMs,
        peakReservedBytes: this.budget.getSnapshot().accountedBytes,
        failureReason: message,
      });
    } finally {
      reader?.dispose();
      if (sink instanceof BoundedChunkedByteSink) {
        sink.releaseMemoryReservations();
      }
      this.activeRenderIds.delete(renderId);
    }
  }

  private makeFailedResult(params: {
    readonly renderId: string;
    readonly state: RenderLifecycleState;
    readonly plan: AudioRenderResult['plan'];
    readonly preValidation: RenderValidationReport;
    readonly sourceDurationSec: number;
    readonly startWallMs: number;
    readonly peakReservedBytes: number;
    readonly failureReason?: string;
  }): AudioRenderResult {
    return {
      renderId: params.renderId,
      state: params.state,
      ok: false,
      plan: params.plan,
      output: null,
      outputBytes: null,
      preValidation: params.preValidation,
      postValidation: null,
      boundaryChecks: [],
      crossfadeResults: [],
      checkpoint: null,
      sourceDurationSec: params.sourceDurationSec,
      outputDurationSec: 0,
      removedDurationSec: params.plan?.removedDurationSec ?? 0,
      wallClockMs: Math.max(0, Date.now() - params.startWallMs),
      realTimeFactor: null,
      peakReservedBytes: params.peakReservedBytes,
      sourceImmutableVerified: true,
      edlImmutableVerified: true,
      appliedProposalIds: [],
      failureReason: params.failureReason,
    };
  }
}
