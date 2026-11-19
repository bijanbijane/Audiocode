import { SampleRate, TimeMath, TimeRange } from '../contracts/timebase.contract';
import {
  AIRecommendationRecord,
  ProjectDocument,
  RecommendationId,
} from '../contracts/project-schema.contract';
import { ProsodicWarningType } from '../contracts/persian-editing.contract';
import { AudioSecurityGuard } from '../security/AudioSecurityGuard';
import {
  CrashRecoveryAndSessionLock,
  CrashRecoveryAndSessionLockOptions,
  ProjectLockAcquisitionResult,
  ProjectLockState,
  RecoveryJournalStore,
  SafeCrashRecoveryExecutionResult,
} from '../runtime/CrashRecoveryAndSessionLock';
import { TimelineTransactionEngine } from '../project-core/TimelineTransactionEngine';
import {
  GraphEdge,
  ProcessingGraphEngine,
  ProcessingNodeSpec,
} from '../processing-core/ProcessingGraphEngine';
import { PersianAcousticSnapper } from '../audio-engine/PersianAcousticSnapper';
import { AntiAliasedResampler } from '../ai-engine/AntiAliasedResampler';
import { PersianTextNormalizer, TimedPersianToken } from '../ai-engine/PersianTextNormalizer';
import { PersianDisfluencyEngine } from '../ai-engine/PersianDisfluencyEngine';
import { ExportValidationReport, ExportValidator } from '../processing-core/ExportValidator';
import {
  AudioRestorationEngine,
  AudioRestorationPipelineConfig,
  RestorationTelemetrySummary,
  WasmRestorationBridge,
} from '../processing-core/AudioRestorationEngine';

/**
 * End-to-End Vertical Slice Orchestrator (Roadmap Step 6 / Architecture Section 7)
 * Connects security guard, session lock, crash recovery, Group A DSP, 16kHz resampler,
 * Group B Persian ASR alignment, non-destructive timeline transactions, PDC graph, and export validation.
 */
export class VerticalSliceOrchestrator {
  private readonly securityGuard = AudioSecurityGuard;
  private readonly sessionManager: CrashRecoveryAndSessionLock;
  private readonly graphEngine = new ProcessingGraphEngine();
  private txEngine: TimelineTransactionEngine | null = null;
  private activeProjectId: string | null = null;
  private readOnlyMode = true;
  private lastRecoveryResult: SafeCrashRecoveryExecutionResult | null = null;
  private lastCheckpointError: string | null = null;

  private roomToneBuffer: Float32Array = new Float32Array(24000);
  private roomToneRange: TimeRange = { start: 0, end: TimeMath.secondsToFlicks(0.5) };

  constructor(
    journalStore?: RecoveryJournalStore,
    sessionOptions?: CrashRecoveryAndSessionLockOptions,
  ) {
    this.sessionManager = new CrashRecoveryAndSessionLock(journalStore, sessionOptions);
    this.sessionManager.onLockLost(() => {
      this.readOnlyMode = true;
    });
  }

  public getSessionManager(): CrashRecoveryAndSessionLock {
    return this.sessionManager;
  }

  public getLockState(): ProjectLockState {
    return this.sessionManager.getLockState();
  }

  public isReadOnly(): boolean {
    return this.readOnlyMode;
  }

  public getLastRecoveryResult(): SafeCrashRecoveryExecutionResult | null {
    return this.lastRecoveryResult;
  }

  public getLastCheckpointError(): string | null {
    return this.lastCheckpointError;
  }

  public getRoomToneBuffer(): Float32Array {
    return this.roomToneBuffer;
  }

  public getTransactionEngine(): TimelineTransactionEngine | null {
    return this.txEngine;
  }

  public async initializeProjectSession(
    initialDoc: ProjectDocument,
    options?: {
      readonly allowReadOnlyOnContention?: boolean;
      readonly conflictResolution?: 'REJECT_STALE' | 'FORCE_RESTORE_STALE';
    },
  ): Promise<{
    lockAcquired: boolean;
    lockResult: ProjectLockAcquisitionResult;
    readOnly: boolean;
    recoveredFromCrash: boolean;
    recoveryResult: SafeCrashRecoveryExecutionResult | null;
    activeDocument: ProjectDocument;
  }> {
    const lockResult = await this.sessionManager.acquireProjectLock(initialDoc.projectId);
    if (!lockResult.acquired) {
      this.readOnlyMode = true;
      if (options?.allowReadOnlyOnContention) {
        this.activeProjectId = initialDoc.projectId;
        this.txEngine = new TimelineTransactionEngine(initialDoc);
        return {
          lockAcquired: false,
          lockResult,
          readOnly: true,
          recoveredFromCrash: false,
          recoveryResult: null,
          activeDocument: this.txEngine.getActiveState(),
        };
      }
      if (lockResult.state === 'LOCK_UNAVAILABLE') {
        throw new Error(
          'PROJECT_LOCK_UNAVAILABLE: محیط فعلی از قفل انحصاری پشتیبانی نمی‌کند؛ ویرایش مسدود شد.',
        );
      }
      throw new Error('PROJECT_LOCKED_IN_ANOTHER_TAB: این پروژه هم‌اکنون در تب دیگری باز است.');
    }

    this.activeProjectId = initialDoc.projectId;
    this.readOnlyMode = false;

    const recoveryResult = await this.sessionManager.executeSafeCrashRecovery({
      currentSavedProject: initialDoc,
      conflictResolution: options?.conflictResolution ?? 'REJECT_STALE',
    });
    this.lastRecoveryResult = recoveryResult;
    const docToLoad = recoveryResult.restored ? recoveryResult.document : initialDoc;

    this.txEngine = new TimelineTransactionEngine(docToLoad);
    return {
      lockAcquired: true,
      lockResult,
      readOnly: false,
      recoveredFromCrash: recoveryResult.restored,
      recoveryResult,
      activeDocument: this.txEngine.getActiveState(),
    };
  }

  public ingestAndRunZeroWaitGroupA(
    fileHeader12Bytes: Uint8Array,
    fileByteSize: number,
    decodedPreviewChannels: Float32Array[],
    sourceSampleRate: SampleRate,
  ): {
    containerFormat: string;
    noiseFloorDb: number;
    mono16kForAi: Float32Array;
  } {
    const containerFormat = this.securityGuard.verifyMagicBytes(fileHeader12Bytes, fileByteSize);
    const durationSec = (decodedPreviewChannels[0]?.length ?? 0) / sourceSampleRate;
    this.securityGuard.assertSafeDecodedDuration(
      durationSec,
      fileByteSize,
      sourceSampleRate,
      Math.max(1, decodedPreviewChannels.length),
    );

    const resampler = new AntiAliasedResampler(sourceSampleRate, 16000);
    const mono16kForAi = resampler.processToMono16k(decodedPreviewChannels);

    const { roomToneRangeSamples, noiseFloorDb } = PersianAcousticSnapper.extractRoomToneProfile(
      decodedPreviewChannels[0],
      sourceSampleRate,
    );

    this.roomToneBuffer = decodedPreviewChannels[0].slice(
      roomToneRangeSamples[0],
      roomToneRangeSamples[1],
    );
    this.roomToneRange = {
      start: TimeMath.samplesToFlicks(roomToneRangeSamples[0], sourceSampleRate),
      end: TimeMath.samplesToFlicks(roomToneRangeSamples[1], sourceSampleRate),
    };

    return {
      containerFormat,
      noiseFloorDb,
      mono16kForAi,
    };
  }

  public processPersianAsrAndBuildSmartRecommendations(
    rawTokens: { id: string; text: string; range: TimeRange; confidence: number }[],
    pcmMonoNative: Float32Array,
    sampleRate: SampleRate,
    targetTrackId: string,
  ): {
    threeLayerTokens: TimedPersianToken[];
    recommendations: AIRecommendationRecord[];
  } {
    const threeLayerTokens = PersianTextNormalizer.buildThreeLayerTranscript(
      rawTokens,
      targetTrackId,
    );
    const recommendations: AIRecommendationRecord[] = [];
    const baseRevision = this.txEngine?.getActiveState().revision ?? 1;

    for (let i = 0; i < threeLayerTokens.length; i++) {
      const token = threeLayerTokens[i];
      const prevToken = i > 0 ? threeLayerTokens[i - 1] : null;

      const startSample = TimeMath.flicksToSamplesFloor(token.range.start, sampleRate);
      const endSample = TimeMath.flicksToSamplesFloor(token.range.end, sampleRate);

      const isIndependentFiller = /^(ا+م+|ا+ه+|ا+و+م+|ه+م+)$/.test(token.normalizedText);

      const stretchOnsetSample = !isIndependentFiller
        ? PersianAcousticSnapper.findCoarticulatedStretchOnset(
            pcmMonoNative,
            startSample,
            endSample,
            sampleRate,
          )
        : null;

      if (!isIndependentFiller && stretchOnsetSample === null) continue;

      const rawCutStartSample = isIndependentFiller ? startSample : stretchOnsetSample!;
      const rawCutEndSample = endSample;

      const valleyStart = isIndependentFiller
        ? PersianAcousticSnapper.findMinimumEnergySample(
            pcmMonoNative,
            rawCutStartSample,
            sampleRate,
          )
        : rawCutStartSample;
      const valleyEnd = PersianAcousticSnapper.findMinimumEnergySample(
        pcmMonoNative,
        rawCutEndSample,
        sampleRate,
      );

      const snappedStart = PersianAcousticSnapper.snapToZeroCrossing(
        pcmMonoNative,
        valleyStart,
        sampleRate,
        true,
      );
      const snappedEnd = PersianAcousticSnapper.snapToZeroCrossing(
        pcmMonoNative,
        valleyEnd,
        sampleRate,
        true,
      );

      const safeEnd = Math.max(snappedStart + 1, snappedEnd);
      const warnings: ProsodicWarningType[] = [];
      if (
        prevToken &&
        PersianAcousticSnapper.detectTrailingEzafeRisk(
          prevToken.normalizedText,
          token.normalizedText,
          80,
        )
      ) {
        warnings.push('TRAILING_EZAFE_RISK');
      }

      recommendations.push({
        id: `rec_${token.tokenId}`,
        targetTrackId,
        disfluencyType: isIndependentFiller ? 'INDEPENDENT_FILLER' : 'COARTICULATED_STRETCH',
        associatedText: token.displayText,
        status: 'PENDING',
        createdAtProjectRevision: baseRevision,
        spliceDescriptor: {
          rawAiRange: token.range,
          snappedAcousticRange: {
            start: TimeMath.samplesToFlicks(snappedStart, sampleRate),
            end: TimeMath.samplesToFlicks(safeEnd, sampleRate),
          },
          fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
          injectRoomToneFlicks: isIndependentFiller ? TimeMath.secondsToFlicks(0.06) : 0,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: warnings,
          confidence: token.confidence,
        },
      });
    }

    // Also include linguistic disfluencies & abnormal pauses via PersianDisfluencyEngine
    const speechIssues = PersianDisfluencyEngine.analyzeTranscript(threeLayerTokens);
    const emittedTokenIds = new Set(recommendations.map((r) => r.id.replace(/^rec_/, '')));
    for (const issue of speechIssues) {
      if (issue.type === 'INDEPENDENT_FILLER') {
        if (issue.affectedTokenIds.some((id) => emittedTokenIds.has(id))) continue;
      }

      const startSample = TimeMath.flicksToSamplesFloor(issue.targetRange.start, sampleRate);
      const endSample = TimeMath.flicksToSamplesFloor(issue.targetRange.end, sampleRate);
      const snappedStart = PersianAcousticSnapper.snapToZeroCrossing(
        pcmMonoNative,
        Math.min(Math.max(0, startSample), Math.max(0, pcmMonoNative.length - 1)),
        sampleRate,
        true,
      );
      const snappedEnd = PersianAcousticSnapper.snapToZeroCrossing(
        pcmMonoNative,
        Math.min(Math.max(0, endSample), Math.max(0, pcmMonoNative.length - 1)),
        sampleRate,
        true,
      );
      const safeEnd = Math.max(snappedStart + 1, snappedEnd);

      recommendations.push({
        id: `rec_${issue.issueId}`,
        targetTrackId,
        disfluencyType: issue.type,
        associatedText: issue.displayExcerpt,
        status: 'PENDING',
        createdAtProjectRevision: baseRevision,
        spliceDescriptor: {
          rawAiRange: issue.targetRange,
          snappedAcousticRange: {
            start: TimeMath.samplesToFlicks(snappedStart, sampleRate),
            end: TimeMath.samplesToFlicks(safeEnd, sampleRate),
          },
          fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
          injectRoomToneFlicks: issue.suggestedRemainingPauseFlicks,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: [],
          confidence: issue.compositeConfidence,
        },
      });
    }

    return { threeLayerTokens, recommendations };
  }

  public async acceptRecommendationAndSaveCheckpoint(
    recommendationId: RecommendationId,
  ): Promise<ProjectDocument> {
    if (!this.txEngine || !this.activeProjectId) {
      throw new Error('SESSION_NOT_INITIALIZED');
    }
    if (this.readOnlyMode) {
      throw new Error('SESSION_READ_ONLY_LOCK_REQUIRED: پروژه در حالت فقط‌خواندنی است.');
    }
    const stillOwnsLock = await this.sessionManager.verifyActiveLockOwnership(this.activeProjectId);
    if (!stillOwnsLock) {
      this.readOnlyMode = true;
      throw new Error('PROJECT_LOCK_LOST: قفل انحصاری پروژه از دست رفت؛ تغییرات متوقف شد.');
    }
    this.txEngine.applySmartSpliceRecommendation(recommendationId, this.roomToneRange);
    const updatedDoc = this.txEngine.getActiveState();
    const writeResult = await this.sessionManager.persistRecoveryCheckpoint(updatedDoc, {
      shutdownState: 'DIRTY_ACTIVE',
      requireHeldLock: true,
    });
    if (!writeResult.persisted) {
      this.lastCheckpointError = `${writeResult.errorCode ?? 'STORAGE_WRITE_FAILED'}: ${writeResult.message}`;
      throw new Error(this.lastCheckpointError);
    }
    this.lastCheckpointError = null;
    return updatedDoc;
  }

  public async closeSessionCleanly(): Promise<void> {
    if (this.txEngine && !this.readOnlyMode) {
      const { checkpointResult } = await this.sessionManager.completeCleanShutdown(
        this.txEngine.getCommittedState(),
      );
      if (!checkpointResult.persisted) {
        this.lastCheckpointError = `${checkpointResult.errorCode ?? 'STORAGE_WRITE_FAILED'}: ${checkpointResult.message}`;
      } else {
        this.lastCheckpointError = null;
      }
      this.readOnlyMode = true;
      return;
    }
    await this.sessionManager.releaseProjectLockAsync();
    this.readOnlyMode = true;
  }

  public runAudioRestorationStage(
    channels: readonly Float32Array[],
    config: AudioRestorationPipelineConfig,
    wasmBridge: WasmRestorationBridge | null = null,
  ): {
    repairedChannels: Float32Array[];
    telemetry: RestorationTelemetrySummary;
    graphNodeSpec: ProcessingNodeSpec;
  } {
    const restorationEngine = new AudioRestorationEngine(wasmBridge);
    const { repairedChannels, telemetry } = restorationEngine.restoreChannels(channels, config);
    const graphNodeSpec = restorationEngine.buildProcessingGraphNodeSpec('node_restoration_2_4', config);
    return { repairedChannels, telemetry, graphNodeSpec };
  }

  public validateAndPrepareExport(
    nodes: ProcessingNodeSpec[],
    edges: GraphEdge[],
    renderedChannels: Float32Array[],
    sampleRate: SampleRate,
    expectedDurationSeconds: number,
    inputAssetHashes: string[],
  ): {
    renderPlanCacheKey: string;
    totalLatencySamples: number;
    validationReport: ExportValidationReport;
  } {
    const plan = this.graphEngine.compileGraph(nodes, edges, sampleRate, inputAssetHashes);
    const validationReport = ExportValidator.validateRenderedPcm(
      renderedChannels,
      sampleRate,
      expectedDurationSeconds,
    );

    return {
      renderPlanCacheKey: plan.deterministicCacheKey,
      totalLatencySamples: plan.totalGraphLatencySamples,
      validationReport,
    };
  }
}
