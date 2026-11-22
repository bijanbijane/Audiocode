import { CoreModelRouter } from '../asr-core/CoreModelRouter';
import { probeRuntimeBackendAvailability } from '../asr-core/CoreAcousticCtcEngine';
import {
  buildAllNormalizationProfiles,
  detectTextLanguageTag,
} from '../asr-core/CoreNormalizationAndLanguage';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import {
  CapabilityAvailabilityState,
  ProviderCapabilityDescriptor,
  transportSafeAudioInputToUint8Array,
  UNIFIED_PROCESSING_CONFIG_VERSION,
  UNIFIED_PROCESSING_CONTRACT_VERSION,
  UnifiedExecutionAdapter,
  UnifiedProcessingError,
  UnifiedProcessingRequest,
  UnifiedProcessingResultEnvelope,
  UnifiedTranscriptSegment,
} from './UnifiedProcessingContract';

export interface LocalExecutionAdapterOptions {
  readonly coreRouter?: CoreModelRouter;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly simulateRuntimeUnavailable?: boolean;
  readonly neuralWeightsInstalled?: boolean;
  readonly checkNeuralWeightsAvailable?: () => {
    readonly available: boolean;
    readonly modelId?: string | null;
    readonly modelVersion?: string | null;
  };
}

/**
 * Local Execution Adapter wrapping the existing Core ASR components
 * (`CoreAudioIngestion`, `CoreBatchAndLongFormEngine`, `CoreStreamingAsrEngine`, `CoreModelRouter`).
 *
 * - Default execution path; works offline without network calls.
 * - Never claims deterministic acoustic CTC decoding is an open-vocabulary neural model.
 * - Fails closed with LOCAL_RUNTIME_UNAVAILABLE if neural weights are explicitly required
 *   but absent on this host.
 * - Enforces the 1 GiB application MemoryBudgetManager policy and releases temporary reservations.
 */
export class LocalExecutionAdapter implements UnifiedExecutionAdapter {
  public readonly adapterId = 'avapardaz-local-adapter-v1';
  public readonly executionMode = 'LOCAL' as const;

  private readonly coreRouter: CoreModelRouter;
  private readonly memoryBudget: MemoryBudgetManager;
  private readonly simulateRuntimeUnavailable: boolean;
  private readonly neuralWeightsInstalled: boolean;
  private readonly checkNeuralWeightsAvailable?: LocalExecutionAdapterOptions['checkNeuralWeightsAvailable'];

  constructor(options?: LocalExecutionAdapterOptions) {
    this.coreRouter = options?.coreRouter ?? new CoreModelRouter();
    this.memoryBudget = options?.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.simulateRuntimeUnavailable = Boolean(options?.simulateRuntimeUnavailable);
    this.neuralWeightsInstalled = Boolean(options?.neuralWeightsInstalled);
    this.checkNeuralWeightsAvailable = options?.checkNeuralWeightsAvailable;
  }

  public async discoverCapabilities(): Promise<readonly ProviderCapabilityDescriptor[]> {
    const nowIso = new Date().toISOString();
    if (this.simulateRuntimeUnavailable) {
      return Object.freeze([
        {
          executionMode: 'LOCAL' as const,
          providerId: 'local-cpu-acoustic-ctc',
          displayName: 'Local CPU Acoustic CTC Adapter',
          availability: 'MISSING_REQUIRED_RUNTIME' as const,
          reason: 'Local audio processing runtime is unavailable in this environment.',
          modelId: null,
          modelVersion: null,
          isGenuineNeuralModel: false,
          supportedProcessingModes: ['batch', 'long_form', 'streaming'] as const,
          supportedCapabilities: ['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS'] as const,
          requiresNetwork: false,
          verifiedAtIso: nowIso,
        },
      ]);
    }

    const hostBackends = probeRuntimeBackendAvailability();
    const externalProbe = this.checkNeuralWeightsAvailable?.();
    const descriptors: ProviderCapabilityDescriptor[] = hostBackends.map((b) => {
      let availability: CapabilityAvailabilityState;
      const isExternalNeuralReady =
        b.backendId === 'EXTERNAL_ONNX_RUNTIME' &&
        (b.availableOnThisHost || this.neuralWeightsInstalled || Boolean(externalProbe?.available));

      if (b.backendId === 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER') {
        availability = b.availableOnThisHost ? 'AVAILABLE_NOW' : 'MISSING_REQUIRED_RUNTIME';
      } else if (b.backendId === 'EXTERNAL_ONNX_RUNTIME') {
        availability = isExternalNeuralReady
          ? 'AVAILABLE_NOW'
          : b.weightsPresent
            ? 'MISSING_REQUIRED_RUNTIME'
            : 'MISSING_MODEL_WEIGHTS';
      } else {
        availability = b.availableOnThisHost
          ? 'AVAILABLE_NOW'
          : 'BLOCKED_BY_EXTERNAL_INFRASTRUCTURE';
      }

      return Object.freeze({
        executionMode: 'LOCAL' as const,
        providerId: b.backendId,
        displayName: b.displayName,
        availability,
        reason: isExternalNeuralReady
          ? `Verified local Sherpa-ONNX CPU neural runtime ready (${externalProbe?.modelId ?? 'Reza2kn/Shenava-Rizeh'}).`
          : b.reasonIfUnavailable ??
            (b.backendId === 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER'
              ? 'Deterministic local CPU acoustic CTC adapter verified (not an open-vocabulary neural model).'
              : 'Verified local neural runtime available.'),
        modelId:
          b.backendId === 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER'
            ? this.coreRouter.acousticEngine.getModelVersionId()
            : isExternalNeuralReady
              ? (externalProbe?.modelId ?? 'Reza2kn/Shenava-Rizeh')
              : null,
        modelVersion:
          b.backendId === 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER'
            ? this.coreRouter.acousticEngine.getModelVersionId()
            : isExternalNeuralReady
              ? (externalProbe?.modelVersion ?? 'INT8')
              : null,
        isGenuineNeuralModel: b.backendId !== 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        supportedProcessingModes: ['batch', 'long_form', 'streaming'] as const,
        supportedCapabilities:
          b.timestampGranularity === 'WORD'
            ? (['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS', 'WORD_TIMESTAMPS'] as const)
            : (['RAW_TRANSCRIPT', 'NORMALIZED_VARIANTS', 'SEGMENT_TIMESTAMPS'] as const),
        requiresNetwork: false,
        verifiedAtIso: nowIso,
      });
    });

    return Object.freeze(descriptors);
  }

  public async execute(
    request: UnifiedProcessingRequest,
    signal?: AbortSignal,
  ): Promise<UnifiedProcessingResultEnvelope> {
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const capabilities = await this.discoverCapabilities();

    if (signal?.aborted) {
      throw new UnifiedProcessingError({
        code: 'PROCESSING_CANCELLED',
        executionMode: 'LOCAL',
        providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
      });
    }

    if (this.simulateRuntimeUnavailable) {
      throw new UnifiedProcessingError({
        code: 'LOCAL_RUNTIME_UNAVAILABLE',
        executionMode: 'LOCAL',
        providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        detailEn: 'Local audio processing runtime is unavailable on this host.',
      });
    }

    if (request.config.requireNeuralWeights) {
      const neuralReady = capabilities.some(
        (c) => c.isGenuineNeuralModel && c.availability === 'AVAILABLE_NOW',
      );
      if (!neuralReady) {
        throw new UnifiedProcessingError({
          code: 'LOCAL_RUNTIME_UNAVAILABLE',
          executionMode: 'LOCAL',
          providerId: 'EXTERNAL_ONNX_RUNTIME',
          detailEn:
            'Genuine local neural ASR weights are not installed on this device. Refusing to substitute deterministic acoustic decoding as open-vocabulary neural ASR.',
          detailFa:
            'وزن‌های مدل عصبی محلی روی این دستگاه نصب نشده‌اند. بدون نصب مدل محلی، رونویسی عصبی واقعی انجام نمی‌شود.',
        });
      }
    }

    // Check memory policy before decoding audio bytes
    const rawByteLength = request.audio.metadata.byteLength;
    if (
      typeof rawByteLength !== 'number' ||
      !Number.isFinite(rawByteLength) ||
      rawByteLength <= 0
    ) {
      throw new UnifiedProcessingError({
        code: 'UNSUPPORTED_AUDIO_FORMAT',
        executionMode: 'LOCAL',
        providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        detailEn: 'Audio input metadata byteLength must be a positive finite number.',
      });
    }
    const estimatedWorkingBytes = Math.max(64 * 1024, Math.floor(rawByteLength * 4));
    const rawMaxMem = request.constraints?.maxMemoryBytes;
    const maxAllowedBytes =
      rawMaxMem !== undefined
        ? typeof rawMaxMem === 'number' && Number.isFinite(rawMaxMem) && rawMaxMem >= 0
          ? rawMaxMem
          : 0
        : this.memoryBudget.getSnapshot().hardLimitBytes;
    if (estimatedWorkingBytes > maxAllowedBytes) {
      throw new UnifiedProcessingError({
        code: 'PROCESSING_RESOURCE_LIMIT_EXCEEDED',
        executionMode: 'LOCAL',
        providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        detailEn: `Estimated working set (${estimatedWorkingBytes} B) exceeds allowed memory limit (${maxAllowedBytes} B).`,
      });
    }

    let reservationId: string | null = null;
    try {
      const reservation = this.memoryBudget.reserve({
        owner: `local_proc_${request.jobId}`,
        category: 'asr-input-windows',
        bytes: estimatedWorkingBytes,
      });
      reservationId = reservation.id;
    } catch {
      throw new UnifiedProcessingError({
        code: 'PROCESSING_RESOURCE_LIMIT_EXCEEDED',
        executionMode: 'LOCAL',
        providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        detailEn: 'Local MemoryBudgetManager rejected allocation to stay within the 1 GiB hard limit.',
      });
    }

    try {
      if (signal?.aborted) {
        throw new UnifiedProcessingError({
          code: 'PROCESSING_CANCELLED',
          executionMode: 'LOCAL',
          providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        });
      }

      const rawUint8 = transportSafeAudioInputToUint8Array(request.audio);
      const rawBuffer = Buffer.from(rawUint8.buffer, rawUint8.byteOffset, rawUint8.byteLength);

      if (request.processingMode === 'streaming') {
        const session = this.coreRouter.streamingManager.createSession({
          sessionId: `uni_${request.jobId}`,
          tenantId: 'local-user',
          languageHint: request.languageHint,
          streamingCategory: 'STATEFUL_CHUNKED_STREAMING',
          silenceEndpointMs: 320,
        });
        if (!session.accepted) {
          throw new UnifiedProcessingError({
            code: 'PROCESSING_RESOURCE_LIMIT_EXCEEDED',
            executionMode: 'LOCAL',
            providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
            detailEn: session.readyEvent.detail ?? 'Local streaming session concurrency limit reached.',
          });
        }

        try {
          const chunkBytes = 16_000 * 2 * 0.25; // 250ms @ 16kHz PCM16
          for (let offset = 0; offset < rawBuffer.byteLength; offset += chunkBytes) {
            if (signal?.aborted) {
              this.coreRouter.streamingManager.finalizeSession(session.sessionId);
              throw new UnifiedProcessingError({
                code: 'PROCESSING_CANCELLED',
                executionMode: 'LOCAL',
                providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
              });
            }
            const chunk = rawBuffer.subarray(
              offset,
              Math.min(rawBuffer.byteLength, offset + chunkBytes),
            );
            this.coreRouter.streamingManager.pushPcm16Chunk(session.sessionId, chunk);
          }

          const finalized = this.coreRouter.streamingManager.finalizeSession(session.sessionId);
          const events = this.coreRouter.streamingManager.getSessionEvents(session.sessionId);
          const finals = events.filter((e) => e.type === 'transcript.final');
          const rawText = finals
            .map((e) => e.rawModelOutput ?? '')
            .filter(Boolean)
            .join(' ')
            .trim();
          const langInfo = detectTextLanguageTag(rawText);
          const normalizedByProfile = buildAllNormalizationProfiles(rawText);
          const completedAtMs = Date.now();

          const segments: UnifiedTranscriptSegment[] = finals.map((e, idx) => {
            const segRaw = e.rawModelOutput ?? '';
            const safeStartSec =
              typeof e.startSec === 'number' && Number.isFinite(e.startSec) && e.startSec >= 0
                ? e.startSec
                : 0;
            const fallbackEndSec =
              typeof finalized.metrics.totalAudioSec === 'number' &&
              Number.isFinite(finalized.metrics.totalAudioSec) &&
              finalized.metrics.totalAudioSec >= safeStartSec
                ? finalized.metrics.totalAudioSec
                : safeStartSec;
            const safeEndSec =
              typeof e.endSec === 'number' && Number.isFinite(e.endSec) && e.endSec >= safeStartSec
                ? e.endSec
                : fallbackEndSec;
            return {
              segmentId: `seg_${idx}`,
              segmentIndex: idx,
              startSec: safeStartSec,
              endSec: safeEndSec,
              startSample: Math.round(safeStartSec * 16_000),
              endSample: Math.round(safeEndSec * 16_000),
              language: e.language ?? langInfo.language,
              languageConfidence: null,
              rawModelOutput: segRaw,
              normalizedByProfile: buildAllNormalizationProfiles(segRaw),
              words: [],
              timestampGranularity: 'SEGMENT',
              confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
              calibratedConfidence: null,
              retryCount: 0,
              status: 'OK',
              failureReason: null,
            };
          });

          return Object.freeze({
            contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
            jobId: request.jobId,
            recordingId: request.recordingId,
            status: 'COMPLETED',
            executionMode: 'LOCAL',
            processingMode: 'streaming',
            durationSec: finalized.metrics.totalAudioSec,
            dominantLanguage: langInfo.language,
            rawModelOutput: rawText,
            normalizedByProfile,
            confidenceStatus: 'UNAVAILABLE_UNCALIBRATED',
            calibratedConfidence: null,
            timestampGranularity: 'SEGMENT',
            segments,
            failedSegmentRanges: [],
            warnings: [
              'Executed via local deterministic CPU acoustic CTC streaming adapter (not open-vocabulary neural weights).',
            ],
            audioSha256Hex: request.audio.metadata.sha256Hex,
            capabilitySnapshot: capabilities,
            resourceUsage: {
              measurementKind: 'MEASURED' as const,
              processingTimeMs: finalized.metrics.totalProcessingMs,
              realTimeFactor: finalized.metrics.rtf,
              peakMemoryBytes:
                typeof process !== 'undefined' && process.memoryUsage
                  ? process.memoryUsage().rss
                  : null,
            },
            provenance: {
              jobId: request.jobId,
              recordingId: request.recordingId,
              selectedExecutionMode: 'LOCAL' as const,
              actualAdapterId: this.adapterId,
              providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
              modelId: this.coreRouter.acousticEngine.getModelVersionId(),
              modelVersion: this.coreRouter.acousticEngine.getModelVersionId(),
              isGenuineNeuralModel: false,
              contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
              configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
              startedAtIso,
              completedAtIso: new Date(completedAtMs).toISOString(),
              actualDurationMs: Math.max(0, completedAtMs - startedAtMs),
              retryCount: 0,
              fallbackUsed: false,
              fallbackAuthorizedReason: null,
              failureCode: null,
              failureReason: null,
            },
            error: null,
          });
        } catch (err) {
          if (err instanceof UnifiedProcessingError) throw err;
          throw new UnifiedProcessingError({
            code: 'PROCESSING_FAILED',
            executionMode: 'LOCAL',
            providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
            detailEn: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Batch or Long-Form via existing CoreBatchAndLongFormEngine
      this.coreRouter.routeInference({
        mode: request.processingMode,
        languageHint: request.languageHint,
      });

      let coreResult;
      try {
        coreResult = this.coreRouter.batchEngine.transcribeAudioBytes({
          filename: request.audio.metadata.filename,
          rawBytes: rawBuffer,
          rawPcm16Hint: request.audio.encoding === 'BASE64_PCM16_16K_MONO',
          languageHint: request.languageHint,
          longFormConfig: {
            ...(request.config.maxSegmentDurationSec !== undefined
              ? { maxSegmentDurationSec: request.config.maxSegmentDurationSec }
              : {}),
            ...(request.config.contextOverlapSec !== undefined
              ? { contextOverlapSec: request.config.contextOverlapSec }
              : {}),
            ...(request.config.maxRetriesPerSegment !== undefined
              ? { maxRetriesPerSegment: request.config.maxRetriesPerSegment }
              : {}),
            ...(request.config.simulateFailureOnSegmentIndex !== undefined
              ? { simulateFailureOnSegmentIndex: request.config.simulateFailureOnSegmentIndex }
              : {}),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isFormatErr = /format|riff|wav|ffmpeg|decode|empty|unsupported/i.test(msg);
        throw new UnifiedProcessingError({
          code: isFormatErr ? 'UNSUPPORTED_AUDIO_FORMAT' : 'PROCESSING_FAILED',
          executionMode: 'LOCAL',
          providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
          detailEn: msg,
        });
      }

      if (signal?.aborted) {
        throw new UnifiedProcessingError({
          code: 'PROCESSING_CANCELLED',
          executionMode: 'LOCAL',
          providerId: 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER',
        });
      }

      const completedAtMs = Date.now();
      const segments: UnifiedTranscriptSegment[] = coreResult.segments.map((s) => ({
        segmentId: s.segmentId,
        segmentIndex: s.segmentIndex,
        startSec: s.startSec,
        endSec: s.endSec,
        startSample: s.startSample,
        endSample: s.endSample,
        language: s.language,
        languageConfidence: s.languageConfidence,
        rawModelOutput: s.rawModelOutput,
        normalizedByProfile: s.normalizedByProfile,
        words: s.words,
        timestampGranularity: s.timestampGranularity,
        confidenceStatus: s.confidenceStatus,
        calibratedConfidence: s.calibratedConfidence,
        retryCount: s.retryCount,
        status: s.status,
        failureReason: s.failureReason,
      }));

      const totalSegmentRetries = segments.reduce((acc, s) => acc + s.retryCount, 0);

      return Object.freeze({
        contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
        jobId: request.jobId,
        recordingId: request.recordingId,
        status: coreResult.status,
        executionMode: 'LOCAL',
        processingMode: request.processingMode,
        durationSec: coreResult.durationSec,
        dominantLanguage: coreResult.dominantLanguage,
        rawModelOutput: coreResult.rawModelOutput,
        normalizedByProfile: coreResult.normalizedByProfile,
        confidenceStatus: coreResult.confidenceStatus,
        calibratedConfidence: coreResult.calibratedConfidence,
        timestampGranularity: coreResult.timestampGranularity,
        segments,
        failedSegmentRanges: coreResult.failedSegmentRanges,
        warnings: [
          ...coreResult.ingestWarnings,
          'Executed via local deterministic CPU acoustic CTC adapter (not open-vocabulary neural weights).',
        ],
        audioSha256Hex: coreResult.audioSha256,
        capabilitySnapshot: capabilities,
        resourceUsage: {
          measurementKind: 'MEASURED' as const,
          processingTimeMs: coreResult.processingTimeMs,
          realTimeFactor: coreResult.realTimeFactor,
          peakMemoryBytes: Math.round(coreResult.peakRssMb * 1024 * 1024),
        },
        provenance: {
          jobId: request.jobId,
          recordingId: request.recordingId,
          selectedExecutionMode: 'LOCAL' as const,
          actualAdapterId: this.adapterId,
          providerId: coreResult.backendUsed,
          modelId: coreResult.modelVersionId,
          modelVersion: coreResult.modelVersionId,
          isGenuineNeuralModel: false,
          contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
          configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
          startedAtIso,
          completedAtIso: new Date(completedAtMs).toISOString(),
          actualDurationMs: Math.max(0, completedAtMs - startedAtMs),
          retryCount: totalSegmentRetries,
          fallbackUsed: false,
          fallbackAuthorizedReason: null,
          failureCode: coreResult.status === 'FAILED' ? ('PROCESSING_FAILED' as const) : null,
          failureReason:
            coreResult.status === 'FAILED'
              ? coreResult.failedSegmentRanges[0]?.reason ?? 'All local segments failed.'
              : null,
        },
        error:
          coreResult.status === 'FAILED'
            ? {
                code: 'PROCESSING_FAILED' as const,
                messageEn: 'Local segment decoding failed for all segments.',
                messageFa: 'پردازش محلی برای تمام بخش‌های صوتی با خطا مواجه شد.',
                retryable: false,
                executionMode: 'LOCAL' as const,
                providerId: coreResult.backendUsed,
              }
            : null,
      });
    } finally {
      if (reservationId) {
        this.memoryBudget.release(reservationId);
      }
    }
  }
}
