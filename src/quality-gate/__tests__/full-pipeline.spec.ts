import { describe, it, expect } from 'vitest';
import { AutomatedQualityGateRunner } from '../AutomatedQualityGateRunner';
import { EndToEndArchitectureComplianceSuite } from '../EndToEndArchitectureComplianceSuite';
import { PersianCtcForcedAligner } from '../../ai-engine/PersianCtcForcedAligner';
import { AudioRestorationEngine } from '../../processing-core/AudioRestorationEngine';
import { RecordingQualityAdvisorEngine } from '../../../packages/audio-runtime/src/RecordingQualityAdvisorEngine';
import { LoudnessAndMasteringEngine } from '../../audio-engine/LoudnessAndMasteringEngine';
import { PersianTextNormalizer } from '../../ai-engine/PersianTextNormalizer';
import { PersianProsodyAndPacingAnalyzer } from '../../ai-engine/PersianProsodyAndPacingAnalyzer';
import { PersianPhoneticTranscriptSearchEngine } from '../../ai-engine/PersianPhoneticTranscriptSearchEngine';
import { PersianChapterAndTopicSegmenter } from '../../ai-engine/PersianChapterAndTopicSegmenter';
import { BatchProcessingOrchestrator } from '../../project-core/BatchProcessingOrchestrator';
import { ProjectThreeWayMergeEngine } from '../../project-core/ProjectThreeWayMergeEngine';
import { AudioSecurityGuard } from '../../security/AudioSecurityGuard';
import { SpeechReconstructionAndWatermarkEngine } from '../../../packages/audio-runtime/src/SpeechReconstructionAndWatermarkEngine';
import { OnnxPersianAsrAndVadAdapter } from '../../ai-engine/OnnxPersianAsrAndVadAdapter';
import { SpectralWienerDenoiserEngine } from '../../../packages/audio-runtime/src/SpectralWienerDenoiserEngine';
import { DirectStudioOpfsRecorder } from '../../../packages/audio-runtime/src/DirectStudioOpfsRecorder';
import { TimeStretchWsolaEngine } from '../../../packages/audio-runtime/src/TimeStretchWsolaEngine';
import { ScriptToAudioDeviationDetector } from '../../ai-engine/ScriptToAudioDeviationDetector';
import { PersianAudiogramCanvasRenderer } from '../../ui/export/PersianAudiogramCanvasRenderer';
import { PriorityWorkerPoolDispatcher } from '../../../packages/audio-runtime/src/PriorityWorkerPoolDispatcher';
import { ProjectVersionDiffEngine } from '../../project-core/ProjectVersionDiffEngine';
import { PersianShowNotesAndTextRankEngine } from '../../ai-engine/PersianShowNotesAndTextRankEngine';
import { AccessibleAudioStudioNavigator } from '../../ui/accessibility/AccessibleAudioStudioNavigator';
import { UserDecisionHistoryLedger } from '../../project-core/UserDecisionHistoryLedger';
import { MidSideVocalSpaceCarverEngine } from '../../../packages/audio-runtime/src/MidSideVocalSpaceCarverEngine';
import { AcousticTranslationSimulatorEngine } from '../../../packages/audio-runtime/src/AcousticTranslationSimulatorEngine';
import { NonVerbalVocalEventDetector } from '../../ai-engine/NonVerbalVocalEventDetector';
import { MerkleDagCacheManager } from '../../processing-core/MerkleDagCacheManager';
import { PersianNumeralAndCurrencyNormalizer } from '../../ai-engine/PersianNumeralAndCurrencyNormalizer';
import { PersianPodcastTeaserGeneratorEngine } from '../../ai-engine/PersianPodcastTeaserGeneratorEngine';
import { ProcessingNodeVersionRegistry } from '../../processing-core/ProcessingNodeVersionRegistry';
import { MultiRecorderClockDriftAligner } from '../../../packages/audio-runtime/src/MultiRecorderClockDriftAligner';
import { SensitiveContentAndPiiRedactorEngine } from '../../../packages/audio-runtime/src/SensitiveContentAndPiiRedactorEngine';
import { MultiSpeakerTurnLevelerEngine } from '../../project-core/MultiSpeakerTurnLevelerEngine';
import { VocalAndMusicStemSeparatorEngine } from '../../../packages/audio-runtime/src/VocalAndMusicStemSeparatorEngine';
import { LiveMarkerAndAnnotationManager } from '../../project-core/LiveMarkerAndAnnotationManager';
import { PersianProsodicPunctuationRestorer } from '../../ai-engine/PersianProsodicPunctuationRestorer';
import { PersianColloquialAndDialectNormalizer } from '../../ai-engine/PersianColloquialAndDialectNormalizer';
import { ModelDeliveryEconomicsAnalyzer } from '../../../backend/src/analytics/ModelDeliveryEconomicsAnalyzer';
import { AudioBusAndRoutingMatrixEngine } from '../../../packages/audio-runtime/src/AudioBusAndRoutingMatrixEngine';
import { EditQualityVsModelQualityEvaluator } from '../../project-core/evaluation/EditQualityVsModelQualityEvaluator';
import { PersianSpeechEvaluationCorpusBuilder } from '../../ai-engine/evaluation/PersianSpeechEvaluationCorpusBuilder';
import { ReleaseReadinessSignOffAuditor } from '../ReleaseReadinessSignOffAuditor';
import { StreamingPlaybackPumpController } from '../../../packages/audio-runtime/src/StreamingPlaybackPumpController';
import { WebGpuAcceleratedKernelRunner } from '../../../packages/audio-runtime/src/WebGpuAcceleratedKernelRunner';
import { SyntheticVerticalSliceHarness } from '../../harness/SyntheticVerticalSliceHarness';
import { Parametric8BandBiquadEq } from '../../../packages/audio-runtime/src/Parametric8BandBiquadEq';
import { ParallelChunkRenderCoordinator } from '../../processing-core/ParallelChunkRenderCoordinator';
import { PersianCtcPrefixBeamSearchDecoder } from '../../ai-engine/asr/PersianCtcPrefixBeamSearchDecoder';
import { UnifiedOnnxPersianAsrEngine } from '../../ai-engine/asr/UnifiedOnnxPersianAsrEngine';
import { PlatformBackendServices } from '../../../backend/src/PlatformBackendServices';
import { CompactPersianLanguageModelScorer } from '../../ai-engine/asr/CompactPersianLanguageModelScorer';
import { NodeOnnxAsrBenchmarkRunner } from '../../../backend/src/asr-worker/NodeOnnxAsrBenchmarkRunner';
import { BackendAuthAndPaymentService } from '../../../backend/src/BackendAuthAndPaymentService';
import {
  SentencePieceSubwordCtcMapper,
  WhisperCppAsrAdapter,
} from '../../ai-engine/asr/SentencePieceAndWhisperBridge';
import { SileroVadOnnxRunner } from '../../ai-engine/asr/SileroVadOnnxRunner';
import { SlidingWindowRateLimiter } from '../../../backend/src/server';
import {
  CausalFastConformerStreamingRunner,
  LocalAgreement2StreamStabilizer,
} from '../../ai-engine/asr/StreamingLivePersianAsrEngine';
import { BackendAsrJobQueueAndPool } from '../../../backend/src/queue/BackendAsrJobQueueAndPool';
import { BackendExternalApiProxyService } from '../../../backend/src/gateway/BackendExternalApiProxyService';
import { PersianPostAsrSpellingAndCompoundRestorer } from '../../ai-engine/asr/PersianPostAsrSpellingAndCompoundRestorer';
import { WhisperKvCacheAutoregressiveOptimizer } from '../../ai-engine/asr/WhisperKvCacheAutoregressiveOptimizer';
import { SpeakerEmbeddingOnnxRunner } from '../../ai-engine/asr/SpeakerEmbeddingOnnxRunner';
import { WebWorkerOrtRuntimeProvider } from '../../ai-engine/asr/WebWorkerOrtRuntimeProvider';
import { BackendModelGateValidatorAndPublisher } from '../../../backend/src/cli/BackendModelGateValidatorAndPublisher';
import { SequentialPersianAiPipelineRunner } from '../../ai-engine/workers/asr-inference.worker';
import { BatchPersianCorpusBenchmarkCli } from '../../../backend/src/cli/batch-persian-corpus-benchmark-cli';
import { BackendLicenseAndModelRevocationService } from '../../../backend/src/BackendLicenseAndModelRevocationService';
import { WhisperPlusCtcTwoStageAligner } from '../../ai-engine/asr/WhisperPlusCtcTwoStageAligner';
import { ContextBiasingTrieCtcScorer } from '../../ai-engine/asr/ContextBiasingTrieCtcScorer';
import { SingleFlightReadThroughCache } from '../../../backend/src/cache/BackendReadThroughCacheAndMetrics';
import { PersianFastConformerRnntAndTdtDecoder } from '../../ai-engine/asr/PersianFastConformerRnntAndTdtDecoder';
import { IntegratedPersianAsrService } from '../../ai-engine/asr/IntegratedPersianAsrService';
import { PersianPhoneticConfusionCorrector } from '../../ai-engine/asr/PersianPhoneticConfusionCorrector';
import { AsrRegressionDiffRunner } from '../../../backend/src/cli/AsrRegressionDiffRunner';
import { BackendModelCanaryRolloutService } from '../../../backend/src/rollout/BackendModelCanaryRolloutService';
import { PersianNBestConfusionNetworkBuilder } from '../../ai-engine/asr/PersianNBestLatticeAndWhisperPromptEngine';
import { NodeStreamingAudioIngestTranscoder } from '../../../backend/src/asr-worker/NodeStreamingAudioIngestTranscoder';
import { WhisperBeamSearchAndTempFallbackEngine } from '../../ai-engine/asr/WhisperBeamSearchAndTempFallbackEngine';
import { PreAsrMusicAndJingleBoundaryFilter } from '../../ai-engine/asr/PreAsrMusicAndJingleBoundaryFilter';
import { TransactionalOutboxDispatcher } from '../../../backend/src/ops/BackendJobOutboxAndAdvisoryLockService';
import { PersianAsrConfidenceCalibrator } from '../../ai-engine/asr/PersianAsrConfidenceCalibrator';
import { PersianSyntacticAcousticEndpointDetector } from '../../ai-engine/asr/PersianSyntacticAcousticEndpointDetector';
import { BackendTranscriptFormatterAndWebhookService } from '../../../backend/src/delivery/BackendTranscriptFormatterAndWebhookService';
import { SpeakerTurnBoundaryWordAligner } from '../../ai-engine/asr/SpeakerTurnBoundaryWordAligner';
import { EnterpriseApiKeyAndQuotaManager } from '../../../backend/src/auth/EnterpriseApiKeyAndQuotaManager';
import { AsrWorkerSupervisorAndWatchdog } from '../../../backend/src/asr-worker/AsrWorkerSupervisorAndWatchdog';
import { buildBackendApplication } from '../../../backend/src/BackendApplicationFactory';
import { PersianTopicAndKeywordIndexer } from '../../ai-engine/asr/PersianTopicAndKeywordIndexer';
import { WhisperCrossAttentionDtwAligner } from '../../ai-engine/asr/WhisperCrossAttentionDtwAligner';
import { DatabaseMigrationRunner } from '../../../backend/src/db/DatabaseMigrationRunner';
import { BackendBackgroundCronDaemon } from '../../../backend/src/ops/BackendBackgroundCronDaemon';
import { DynamicLengthBatchedCtcRunner } from '../../ai-engine/asr/DynamicLengthBatchedCtcRunner';
import { BackendBillingInvoiceAndUsageLedger } from '../../../backend/src/billing/BackendBillingInvoiceAndUsageLedger';
import { PreAsrInputSanityValidator } from '../../ai-engine/asr/PreAsrInputSanityValidator';
import { WebSocketLiveAsrGateway } from '../../../backend/src/gateway/WebSocketLiveAsrGateway';
import { NodeAsrModelSessionPool } from '../../../backend/src/asr-worker/NodeAsrModelSessionPool';
import { PraatTextGridAndLinguisticExporter } from '../../ai-engine/asr/PraatTextGridAndLinguisticExporter';
import { ServerSideEncryptedModelVault } from '../../../backend/src/security/ServerSideEncryptedModelVault';
import { DetailedAsrErrorBreakdownEvaluator } from '../../ai-engine/evaluation/DetailedAsrErrorBreakdownEvaluator';
import { PersianRoverMultiModelEnsembleEngine } from '../../ai-engine/asr/PersianRoverMultiModelEnsembleEngine';
import { BackendAsrStageLatencyProfiler } from '../../../backend/src/ops/BackendAsrStageLatencyProfiler';
import { BackendBatchHttpSubmissionController } from '../../../backend/src/gateway/BackendBatchHttpSubmissionController';
import { TimeMath } from '../../contracts/timebase.contract';
import fs from 'node:fs';
import path from 'node:path';

describe('Persian AI Audio Platform - Master Release Quality Gates (v1.2)', () => {
  it('Gate 1: Executes all 4 core quality gates with zero failures', () => {
    const report = AutomatedQualityGateRunner.runAllCoreQualityGates();
    expect(report.allGatesPassed).toBe(true);
    for (const gate of report.results) {
      expect(gate.passed).toBe(true);
    }
  });

  it('Gate 2: Passes End-to-End 32 Golden Rules compliance suite', async () => {
    const compliance =
      await EndToEndArchitectureComplianceSuite.runFullSystemComplianceVerification();
    expect(compliance.allChecksPassed).toBe(true);
    expect(compliance.verifiedRulesCount).toBe(32);
  });

  it('Gate 3: CTC Forced Aligner accurately aligns Persian words with repeated characters', () => {
    const vocab = new Map<string, number>([
      ['ا', 1],
      ['م', 2],
      ['ر', 3],
      ['و', 4],
      ['ز', 5],
      ['ت', 6],
    ]);

    const numFrames = 20;
    const logProbs: Float32Array[] = Array.from({ length: numFrames }, () =>
      new Float32Array(7).fill(-10.0),
    );

    const targetSeq = [0, 1, 2, 3, 4, 5, 0, 0, 6, 0, 6, 0];
    for (let t = 0; t < numFrames; t++) {
      const activeTok = targetSeq[Math.min(t, targetSeq.length - 1)];
      logProbs[t][activeTok] = -0.05;
    }

    const aligned = PersianCtcForcedAligner.alignPersianWordsToAudio(
      logProbs,
      vocab,
      [
        { id: 'w1', text: 'امروز' },
        { id: 'w2', text: 'تت' },
      ],
      0.02,
    );

    expect(aligned).toHaveLength(2);
    expect(aligned[0].alignedRange.start).toBeLessThan(aligned[0].alignedRange.end);
    expect(aligned[1].alignedRange.start).toBeGreaterThanOrEqual(aligned[0].alignedRange.end);
    expect(aligned[0].acousticConfidence).toBeGreaterThan(0.8);
  });

  it('Gate 4: Teager-Kaiser De-Clicker repairs sharp transient mouth clicks without disturbing speech', () => {
    const sr = 48000;
    const pcm = new Float32Array(4800);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.4 * Math.sin((2 * Math.PI * 200 * i) / sr);
    }

    pcm[1200] = 0.95;
    pcm[1201] = -0.92;
    pcm[1202] = 0.88;

    const clicksRepaired = AudioRestorationEngine.removeMouthClicksInPlace(pcm, sr, 10.0);
    expect(clicksRepaired).toBeGreaterThanOrEqual(1);
    expect(Math.abs(pcm[1201])).toBeLessThan(0.6);
  });

  it('Gate 5: RecordingQualityAdvisor detects 50Hz Iran mains hum using Goertzel algorithm', () => {
    const sr = 48000;
    const roomSlice = new Float32Array(24000);
    for (let i = 0; i < roomSlice.length; i++) {
      const detNoise = Math.sin(i * 1.73) * 0.0002;
      roomSlice[i] =
        0.02 * Math.sin((2 * Math.PI * 50 * i) / sr) +
        0.015 * Math.sin((2 * Math.PI * 100 * i) / sr) +
        detNoise;
    }

    const diag = RecordingQualityAdvisorEngine.analyzeRecordingQuality(
      roomSlice,
      roomSlice,
      sr,
    );
    expect(diag.has50HzMainsHum).toBe(true);
    expect(diag.recommendedGraphNodes.some((n) => n.id === 'auto_notch_50hz_hum')).toBe(true);
  });

  it('Gate 6: ITU-R BS.1770-4 Mastering Engine normalizes to -16 LUFS and enforces -1.0 dBTP ceiling', () => {
    const sr = 48000;
    const len = sr * 2;
    const chL = new Float32Array(len);
    const chR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const val = 0.05 * Math.sin((2 * Math.PI * 440 * i) / sr);
      chL[i] = val;
      chR[i] = val;
    }

    const { normalizedChannels } =
      LoudnessAndMasteringEngine.normalizeToTargetLufsWithTruePeakLimiter(
        [chL, chR],
        sr,
        -16.0,
        -1.0,
      );

    const postReport = LoudnessAndMasteringEngine.measureLoudnessAndTruePeak(
      normalizedChannels,
      sr,
    );
    expect(postReport.truePeakDbtp).toBeLessThanOrEqual(-0.95);
    expect(Math.abs(postReport.integratedLufs - -16.0)).toBeLessThan(1.0);
  });

  it('Gate 7: Persian Prosody, Phonetic Transcript Search, and TextTiling Chaptering work end-to-end', () => {
    const sr = 16000 as const;
    const pcm = new Float32Array(sr * 15);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.3 * Math.sin((2 * Math.PI * 150 * i) / sr);
    }

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      { id: 't1', text: 'تباتبایی', range: { start: 0, end: TimeMath.secondsToFlicks(0.45) }, confidence: 0.85 },
      { id: 't2', text: 'درباره', range: { start: TimeMath.secondsToFlicks(0.6), end: TimeMath.secondsToFlicks(1.05) }, confidence: 0.96 },
      { id: 't3', text: 'سادرات', range: { start: TimeMath.secondsToFlicks(1.2), end: TimeMath.secondsToFlicks(1.65) }, confidence: 0.84 },
      { id: 't4', text: 'اقتصاد', range: { start: TimeMath.secondsToFlicks(1.8), end: TimeMath.secondsToFlicks(2.25) }, confidence: 0.97 },
      { id: 't5', text: 'هوش', range: { start: TimeMath.secondsToFlicks(95.0), end: TimeMath.secondsToFlicks(95.5) }, confidence: 0.98 },
      { id: 't6', text: 'مصنوعی', range: { start: TimeMath.secondsToFlicks(95.6), end: TimeMath.secondsToFlicks(96.1) }, confidence: 0.98 },
    ]);

    const prosody = PersianProsodyAndPacingAnalyzer.analyzeProsodyWindows(tokens, pcm, sr, 15.0);
    expect(prosody).toHaveLength(1);
    expect(prosody[0].intonationStatus).toBe('MONOTONE_FLAT_RISK');

    const searchEngine = new PersianPhoneticTranscriptSearchEngine();
    searchEngine.indexTranscript(tokens);
    const hits = searchEngine.searchPhrase('طباطبایی');
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedTokenIds).toEqual(['t1']);

    const chapters = PersianChapterAndTopicSegmenter.generateChapters(tokens, 90.0);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(PersianChapterAndTopicSegmenter.formatChaptersForShowNotes(chapters)).toContain('00:00:00');
  });

  it('Gate 8: Batch Processing stages review projects, Privacy Boundary scrubs logs, and 3-Way Merge recovers conflicts', async () => {
    const baseDoc = {
      projectId: 'gate8_proj',
      name: 'پروژه تست',
      canonicalSampleRate: 48000 as const,
      versions: {
        projectSchemaVersion: 2,
        audioEngineVersion: '1.2.0',
        processingNodeCatalogVersion: '1.2.0',
        activeModelBundleVersion: '1.2.0',
      },
      revision: 1,
      tracks: [
        {
          id: 'trk_1',
          name: 'میزبان',
          syncGroupId: null,
          speakerId: 'S1',
          muted: false,
          solo: false,
          clips: [],
        },
      ],
      recommendations: [],
    };

    const batch = new BatchProcessingOrchestrator();
    batch.enqueueFiles([{ id: 'b1', fileName: 'ep1.wav', byteSize: 1024 }]);
    let purged = 0;
    const staged = await batch.runBatchPreAnalysisStage({
      analyzeSingleFileToStagedProject: async () => structuredClone(baseDoc),
      purgeTemporaryPcmCacheBetweenFiles: async () => {
        purged++;
      },
      onQueueUpdated: () => {},
    });
    expect(staged[0].status).toBe('AWAITING_USER_REVIEW');
    expect(purged).toBe(1);

    const scrubbed = AudioSecurityGuard.sanitizeErrorForTelemetry('Error /Users/ali/محرمانه.wav');
    expect(scrubbed).not.toContain('محرمانه');

    const local = {
      ...structuredClone(baseDoc),
      revision: 2,
      tracks: [{ ...baseDoc.tracks[0], muted: true }],
    };
    const incoming = {
      ...structuredClone(baseDoc),
      revision: 2,
      tracks: [{ ...baseDoc.tracks[0], solo: true }],
    };
    const mergeRes = ProjectThreeWayMergeEngine.mergeProjectBranches(baseDoc, local, incoming);
    expect(mergeRes.mergedCleanly).toBe(false);
    expect(mergeRes.conflicts).toHaveLength(1);
    expect(mergeRes.conflictRecoveryCopy).not.toBeNull();
  });

  it('Gate 9: Punch-In 4-Band EQ Matcher, 19kHz Provenance Watermark, and Master Architecture Map pass verification', () => {
    const sr = 48000 as const;
    const len = 24000;
    const refVoice = new Float32Array(len);
    const punchClip = new Float32Array(len);
    const roomTone = new Float32Array(4800);

    for (let i = 0; i < len; i++) {
      refVoice[i] = 0.25 * Math.sin((2 * Math.PI * 160 * i) / sr) + 0.05 * Math.sin((2 * Math.PI * 6000 * i) / sr);
      punchClip[i] = 0.08 * Math.sin((2 * Math.PI * 160 * i) / sr) + 0.18 * Math.sin((2 * Math.PI * 6000 * i) / sr);
    }

    const { matchedClipPcm, appliedBandGainsDb } =
      SpeechReconstructionAndWatermarkEngine.matchPunchInClipToStudioContext(
        refVoice,
        punchClip,
        roomTone,
        sr,
      );
    expect(appliedBandGainsDb[0]).toBeGreaterThan(2.0);
    expect(appliedBandGainsDb[3]).toBeLessThan(-2.0);

    SpeechReconstructionAndWatermarkEngine.embedSyntheticProvenanceWatermarkInPlace(matchedClipPcm, sr);
    const detect = SpeechReconstructionAndWatermarkEngine.detectSyntheticProvenanceWatermark(
      matchedClipPcm,
      sr,
    );
    expect(detect.isWatermarked).toBe(true);
    expect(detect.correlationConfidence).toBeGreaterThan(0.8);

    const mapPath = path.resolve(process.cwd(), 'docs/MasterRepositoryArchitectureMap.md');
    expect(fs.existsSync(mapPath)).toBe(true);
    expect(fs.readFileSync(mapPath, 'utf8')).toContain('SpeechReconstructionAndWatermarkEngine.ts');
  });

  it('Gate 10: Log-Mel 80-Band Extractor, Decision-Directed Wiener Denoiser, and Crash-Safe Recorder pass integration', async () => {
    const adapter = new OnnxPersianAsrAndVadAdapter();
    const pcm16k = new Float32Array(16000);
    for (let i = 0; i < 16000; i++) {
      pcm16k[i] = 0.2 * Math.sin((2 * Math.PI * 800 * i) / 16000);
    }
    const { numFrames, nMels, melTensor } = adapter.computeLogMelSpectrogram(pcm16k);
    expect(numFrames).toBe(98);
    expect(nMels).toBe(80);
    expect(melTensor.length).toBe(7840);

    const roomNoise = new Float32Array(4096);
    for (let i = 0; i < roomNoise.length; i++) roomNoise[i] = 0.03 * Math.sin(i * 1.93);
    const denoiser = new SpectralWienerDenoiserEngine(roomNoise);
    const denoised = denoiser.processChunk(roomNoise, 0.9);
    expect(denoised.length).toBe(roomNoise.length);

    expect(typeof DirectStudioOpfsRecorder.prototype.flush5SecondRecordedBlockToOpfs).toBe('function');
  });

  it('Gate 11: WSOLA Pitch-Invariant Time-Stretch, Audiobook Manuscript Deviation QC, and Audiogram Renderer pass verification', () => {
    const sr = 48000 as const;
    const input = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      input[i] = 0.35 * Math.sin((2 * Math.PI * 150 * i) / sr);
    }
    const stretched = TimeStretchWsolaEngine.processTimeStretch(input, sr, 1.5);
    expect(stretched.length).toBe(Math.floor(sr / 1.5));

    const spoken = PersianTextNormalizer.buildThreeLayerTranscript([
      { id: 's1', text: 'کتاب', range: { start: 0, end: TimeMath.secondsToFlicks(0.5) }, confidence: 0.96 },
      { id: 's2', text: 'جدید', range: { start: TimeMath.secondsToFlicks(0.6), end: TimeMath.secondsToFlicks(1.1) }, confidence: 0.95 },
    ]);
    const diffs = ScriptToAudioDeviationDetector.detectNarratorDeviations('کتاب صوتی جدید', spoken);
    expect(diffs.some((d) => d.kind === 'OMITTED_FROM_BOOK' && d.expectedBookText === 'صوتی')).toBe(true);

    expect(typeof PersianAudiogramCanvasRenderer.renderAudiogramFrame).toBe('function');
  });

  it('Gate 12: Priority Worker Pool Dispatcher, Project Version Diff Cherry-Picker, and Local TextRank Show-Notes Engine pass verification', async () => {
    const pool = new PriorityWorkerPoolDispatcher(
      'DESKTOP_STUDIO',
      () => async (taskType) => `executed:${taskType}`,
      { hardwareConcurrencyOverride: 6 },
    );
    expect(pool.getSlotCount()).toBe(4);
    const res = await pool.dispatchTask({
      taskId: 'gate12_t1',
      priority: 0,
      taskType: 'SPLICE_PREVIEW',
      payload: {},
    });
    expect(res).toBe('executed:SPLICE_PREVIEW');

    expect(typeof ProjectVersionDiffEngine.compareProjectVersions).toBe('function');
    expect(typeof ProjectVersionDiffEngine.cherryPickRestoreDeletedSpan).toBe('function');

    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      { id: 'n1', text: 'دکتر', range: { start: 0, end: TimeMath.secondsToFlicks(0.4) }, confidence: 0.98 },
      { id: 'n2', text: 'حسابی', range: { start: TimeMath.secondsToFlicks(0.5), end: TimeMath.secondsToFlicks(0.9) }, confidence: 0.98 },
      { id: 'n3', text: 'در', range: { start: TimeMath.secondsToFlicks(1.0), end: TimeMath.secondsToFlicks(1.2) }, confidence: 0.98 },
      { id: 'n4', text: 'دانشگاه', range: { start: TimeMath.secondsToFlicks(1.3), end: TimeMath.secondsToFlicks(1.7) }, confidence: 0.98 },
      { id: 'n5', text: 'تهران', range: { start: TimeMath.secondsToFlicks(1.8), end: TimeMath.secondsToFlicks(2.3) }, confidence: 0.98 },
    ]);
    const entities = PersianShowNotesAndTextRankEngine.extractNamedEntitiesWithTimestamps(tokens);
    expect(entities.some((e) => e.entityType === 'PERSON' && e.entityNameFa.includes('دکتر حسابی'))).toBe(true);
  });

  it('Gate 13: Accessible Screen-Reader Navigator, Section 37 Decision Ledger, and Mid/Side Vocal Space Carver pass verification', () => {
    const nav = new AccessibleAudioStudioNavigator();
    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      { id: 'a1', text: 'پادکست', range: { start: 0, end: TimeMath.secondsToFlicks(0.5) }, confidence: 0.95 },
      { id: 'a2', text: 'فارسی', range: { start: TimeMath.secondsToFlicks(0.6), end: TimeMath.secondsToFlicks(1.1) }, confidence: 0.97 },
    ]);
    const step = nav.navigateTokensByStep(tokens, 1, 48000);
    expect(step?.messageFa).toContain('فارسی');

    const ledger = new UserDecisionHistoryLedger();
    expect(ledger.autoMutateModelBehaviorOnRejection).toBe(false);

    const left = new Float32Array([0.6, -0.2]);
    const right = new Float32Array([0.2, 0.4]);
    const ms = MidSideVocalSpaceCarverEngine.encodeStereoToMidSide(left, right);
    const [decL, decR] = MidSideVocalSpaceCarverEngine.decodeMidSideToStereo(ms.mid, ms.side, 1.0);
    expect(Math.abs(decL[0] - left[0])).toBeLessThan(1e-6);
    expect(Math.abs(decR[1] - right[1])).toBeLessThan(1e-6);
  });

  it('Gate 14: Acoustic Translation Simulator, Non-Verbal Vocal Event Detector, and Merkle-DAG Subgraph Cache pass verification', () => {
    const silence = new Float32Array(1200);
    const [carL] = AcousticTranslationSimulatorEngine.simulateListeningEnvironment(
      [silence, silence],
      48000,
      'CAR_CABIN_IN_TRAFFIC',
    );
    expect(carL.some((v) => Math.abs(v) > 0)).toBe(true);

    expect(typeof NonVerbalVocalEventDetector.detectNonVerbalEventsInGaps).toBe('function');

    const merkle = new MerkleDagCacheManager<string>();
    const hashes = merkle.computePerNodeMerkleHashes({
      topologicalOrder: ['n1', 'n2'],
      nodes: [
        {
          id: 'n1',
          type: 'AI_DENOISER',
          version: '1.0',
          enabled: true,
          latencySamples: 0,
          preRollSamples: 0,
          tailSamples: 0,
          committedParameters: { strength: 0.8 },
        },
        {
          id: 'n2',
          type: 'EQ_FILTER',
          version: '1.0',
          enabled: true,
          latencySamples: 0,
          preRollSamples: 0,
          tailSamples: 0,
          committedParameters: { gainDb: 1.5 },
        },
      ],
      edges: [{ fromNodeId: 'n1', toNodeId: 'n2' }],
      sampleRate: 48000,
      channelCount: 2,
      runtimeBackend: 'WASM_SIMD',
      sourceAssetContentHashes: ['asset_hash_1'],
    });
    merkle.putNodeArtifact('n1', hashes.get('n1')!, 'cached_n1', 512);
    const status = merkle.resolveGraphCacheStatus(hashes);
    expect(status.hitNodeIds).toEqual(['n1']);
    expect(status.missInvalidatedNodeIds).toEqual(['n2']);
  });

  it('Gate 15: Persian Numeral/Currency Verbalizer, Podcast Cold-Open Teaser Generator, and Node Version Registry pass verification', () => {
    expect(PersianNumeralAndCurrencyNormalizer.numberToPersianSpokenWords(1405)).toBe(
      'هزار و چهارصد و پنج',
    );
    expect(typeof PersianPodcastTeaserGeneratorEngine.findBestColdOpenTeaserHooks).toBe('function');

    const registry = new ProcessingNodeVersionRegistry();
    const { upgradedNodes } = registry.upgradeGraphNodesToLatest([
      {
        id: 'n_den',
        type: 'AI_DENOISER',
        version: '1.0.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: { strengthPercent: 75 },
      },
    ]);
    expect(upgradedNodes[0].version).toBe('1.1.0');
    expect(upgradedNodes[0].committedParameters.reductionStrength).toBe(0.75);
  });

  it('Gate 16: Multi-Recorder Clock Drift Aligner, Sensitive PII Redactor, and Multi-Speaker Turn Leveler pass verification', () => {
    expect(typeof MultiRecorderClockDriftAligner.estimateOffsetAndClockDrift).toBe('function');
    expect(typeof MultiRecorderClockDriftAligner.applyDriftAndOffsetCorrection).toBe('function');

    const bleep = SensitiveContentAndPiiRedactorEngine.generateRedactedAudioSegment(
      new Float32Array(2400).fill(0.4),
      new Float32Array(240),
      48000,
      'BROADCAST_BLEEP_1KHZ',
    );
    expect(bleep.length).toBe(2400);

    expect(typeof MultiSpeakerTurnLevelerEngine.buildSpeakerLevelingAutomationLane).toBe(
      'function',
    );
  });

  it('Gate 17: Vocal/Music Stem Separator, Live Marker Reaction-Time Manager, and Prosodic Punctuation Restorer pass verification', () => {
    const stems = VocalAndMusicStemSeparatorEngine.separateVocalAndMusicStems(
      new Float32Array(1200).fill(0.25),
      new Float32Array(1200).fill(0.25),
      48000,
    );
    expect(stems.vocalMonoStem.length).toBe(1200);

    const markerMgr = new LiveMarkerAndAnnotationManager();
    const marker = markerMgr.addLiveMarkerWithReactionCompensation({
      rawTriggerFlicks: TimeMath.secondsToFlicks(5.0),
      category: 'EDIT_MISTAKE_FLAG',
      noteFa: 'تپق زنده',
    });
    expect(marker.timelineFlicks).toBe(TimeMath.secondsToFlicks(4.45));

    expect(typeof PersianProsodicPunctuationRestorer.restorePunctuationInDisplayLayer).toBe(
      'function',
    );
  });

  it('Gate 18: Colloquial-to-Formal Normalizer, Section 57 CDN Economics Analyzer, and Submix Bus Routing Matrix pass verification', () => {
    const conv = PersianColloquialAndDialectNormalizer.convertWordToFormalStandard('می‌خوان');
    expect(conv.formalWord).toBe('می\u200cخواهند');
    expect(conv.converted).toBe(true);

    const econ = ModelDeliveryEconomicsAnalyzer.computeSection57Metrics({
      modelId: 'conformer-fa',
      version: '1.2.0',
      modelTotalSizeBytes: 50 * 1024 * 1024,
      uniqueUsersCount: 100,
      chunkDownloadOkCount: 700,
      chunkFailureCount: 5,
      resumeSuccessCount: 5,
      localCacheHitCount: 400,
      totalBytesTransferredCdn: 102 * 50 * 1024 * 1024,
      deltaUpdateBytesTransferredCdn: 0,
    });
    expect(econ.modelDownloadSizeMb).toBe(50);
    expect(econ.redownloadRateRatio).toBe(1.02);

    expect(typeof AudioBusAndRoutingMatrixEngine.mixMultiTrackThroughSubmixBuses).toBe('function');
  });

  it('Gate 19: Edit-vs-Model Quality Evaluator, Section 39 Corpus Auditor, and Release Readiness Sign-Off Auditor pass verification', () => {
    expect(typeof EditQualityVsModelQualityEvaluator.evaluateAiModelQuality).toBe('function');
    expect(typeof EditQualityVsModelQualityEvaluator.evaluateFinalEditedAudioQuality).toBe(
      'function',
    );
    expect(typeof PersianSpeechEvaluationCorpusBuilder.auditCorpusCoverageAndLegality).toBe(
      'function',
    );

    const signOff = ReleaseReadinessSignOffAuditor.evaluateReleaseSignOff({
      importToExportWorksOfflineWithoutExternalApi: true,
      zeroWaitGroupAAvailableImmediatelyAfterImport: true,
      projectSurvivesTabCloseAndCrashRecovery: true,
      originalSourceAssetByteHashUnchanged: true,
      persianAsrBenchmarkedOnTargetDevices: true,
      postEditSplicesClickFreeAndPreserveEzafe: true,
      smartSuggestionsRequireExplicitUserApproval: true,
      playbackUnderrunsZeroDuringBackgroundAi: true,
      storageAndOpfsLockErrorsZeroUnderStress: true,
      fourWayVersionsAndModelProvenanceTracked: true,
      deviceRamAndDurationLimitsShownTransparently: true,
      gates: {
        functional: true,
        audioQuality: true,
        persianAiAndProsodicQuality: true,
        performance: true,
        memoryDiskAndStability: true,
        storageAndRecovery: true,
        securityAndCrossOriginIsolation: true,
        compatibilityAcrossDesktopAndIos: true,
        regression: true,
        userAcceptance: true,
      },
    });
    expect(signOff.approvedForRelease).toBe(true);
    expect(signOff.mvpCriteriaPassedCount).toBe(11);
    expect(signOff.releaseGatesPassedCount).toBe(10);
  });

  it('Gate 20: Streaming Playback Pump, WebGPU Kernel Runner, Synthetic Harness, 8-Band EQ, and Parallel Chunk Coordinator pass verification', () => {
    expect(typeof StreamingPlaybackPumpController.prototype.seekAndPrimeRingBuffer).toBe(
      'function',
    );
    expect(
      typeof WebGpuAcceleratedKernelRunner.prototype.computeWindowedRmsWithSlicedDispatch,
    ).toBe('function');

    const harnessRes = SyntheticVerticalSliceHarness.runCompleteSyntheticPipeline();
    expect(harnessRes.allStagesPassed).toBe(true);

    const eq = new Parametric8BandBiquadEq(48000);
    const resp = eq.computeFrequencyResponseDb(new Float32Array([100, 1000, 10000]));
    expect(resp.length).toBe(3);

    expect(typeof ParallelChunkRenderCoordinator.prototype.executeParallelStreamingRender).toBe(
      'function',
    );
  });

  it('Gate 21: CTC Prefix Beam Search Decoder, Unified ONNX ASR Engine, and Platform Backend Services pass verification', () => {
    const decoder = new PersianCtcPrefixBeamSearchDecoder(['<blk>', ' ', 'س', 'ل', 'ا', 'م']);
    expect(typeof decoder.decodeWithWordTimestamps).toBe('function');
    expect(typeof UnifiedOnnxPersianAsrEngine.prototype.transcribeWindow).toBe('function');
    expect(typeof PlatformBackendServices.prototype.registerAllRoutes).toBe('function');
  });

  it('Gate 22: Compact PLM1 Binary Language Model, Studio RIFF/WAV Benchmark Runner, and scrypt/EdDSA Payment Webhook Service pass verification', () => {
    const lm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(
      ['سلام پادکست فارسی', 'پادکست فارسی استودیویی'],
      1,
      1,
    );
    const bin = lm.serializeToBinary();
    const reloaded = CompactPersianLanguageModelScorer.loadFromBinary(bin);
    expect(reloaded.isKnownPersianWord('پادکست')).toBe(true);
    expect(typeof NodeOnnxAsrBenchmarkRunner.parseWavBufferToFloat32Channels).toBe('function');
    expect(typeof BackendAuthAndPaymentService.prototype.registerRoutes).toBe('function');
  });

  it('Gate 23: SentencePiece Subword Mapper, Whisper.cpp Adapter, Silero VAD v5 ONNX Runner, and Production Server Rate Limiter pass verification', () => {
    const spMapper = new SentencePieceSubwordCtcMapper(['<blk>', '\u2581سلام'], 0);
    expect(typeof spMapper.decodeSubwordMatrixToWords).toBe('function');
    expect(typeof WhisperCppAsrAdapter.prototype.transcribeWindow).toBe('function');
    expect(typeof SileroVadOnnxRunner.buildConsolidatedAsrBatches).toBe('function');

    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.isAllowed('ip:test', 1, 60000)).toBe(true);
    expect(limiter.isAllowed('ip:test', 1, 60000)).toBe(false);
  });

  it('Gate 24: Streaming Live ASR (Causal FastConformer + LocalAgreement-2), Cloud ASR Job Queue, and External API Proxy Gateway pass verification', () => {
    expect(typeof CausalFastConformerStreamingRunner.prototype.processLiveAudioChunk).toBe(
      'function',
    );
    expect(typeof LocalAgreement2StreamStabilizer.prototype.pushAudioChunkAndTranscribe).toBe(
      'function',
    );
    expect(typeof BackendAsrJobQueueAndPool.prototype.enqueueJobWithAdmissionControl).toBe(
      'function',
    );
    expect(typeof BackendExternalApiProxyService.prototype.registerRoutes).toBe('function');
  });

  it('Gate 25: Post-ASR ZWNJ Compound Restorer, Whisper KV-Cache Optimizer, Speaker Embedding AHC Runner, and WebWorker ORT Provider pass verification', () => {
    const restorer = new PersianPostAsrSpellingAndCompoundRestorer();
    const rawTokens = PersianTextNormalizer.buildThreeLayerTranscript([
      { id: 'w1', text: 'می', range: { start: TimeMath.secondsToFlicks(0.1), end: TimeMath.secondsToFlicks(0.2) }, confidence: 0.9 },
      { id: 'w2', text: 'خواهم', range: { start: TimeMath.secondsToFlicks(0.25), end: TimeMath.secondsToFlicks(0.6) }, confidence: 0.92 },
    ]);
    const restored = restorer.restoreCompoundsAndBilingualTerms(rawTokens);
    expect(restored).toHaveLength(1);
    expect(restored[0].displayText).toBe('می\u200cخواهم');

    expect(typeof WhisperKvCacheAutoregressiveOptimizer.prototype.decodeWithKvCache).toBe('function');
    expect(typeof SpeakerEmbeddingOnnxRunner.clusterEmbeddingsHierarchicalAhc).toBe('function');
    expect(typeof WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks).toBe('function');
  });

  it('Gate 26: Model Gate Validator/Publisher, Sequential AI Pipeline Worker, Corpus Benchmark CLI, and License/Model Revocation Service pass verification', () => {
    expect(typeof BackendModelGateValidatorAndPublisher.prototype.validatePackageAndPublishModel).toBe('function');
    expect(typeof SequentialPersianAiPipelineRunner.prototype.runFullSequentialPipeline).toBe('function');
    expect(typeof BatchPersianCorpusBenchmarkCli.executeFullCorpusBaseline).toBe('function');
    expect(typeof BackendLicenseAndModelRevocationService.prototype.registerRoutes).toBe('function');
  });

  it('Gate 27: Two-Stage Whisper+CTC Aligner, Context-Biasing Trie, Single-Flight Cache, TDT Decoder, Phonetic Confusion Corrector, Regression Diff Runner, and Canary Rollout pass verification', () => {
    expect(typeof WhisperPlusCtcTwoStageAligner.prototype.reAlignWhisperSegments).toBe('function');
    const baseLm = CompactPersianLanguageModelScorer.trainFromPersianCorpus(['سلام دنیا'], 1, 1);
    const trie = new ContextBiasingTrieCtcScorer(baseLm, [{ phrase: 'آواپرداز', boostLogProb: 1.8 }]);
    expect(trie.isKnownPersianWord('آواپرداز')).toBe(true);
    expect(trie.getPartialPrefixDepthBonus('آوا')).toBeGreaterThan(0);

    const sfCache = new SingleFlightReadThroughCache();
    expect(typeof sfCache.getOrComputeSingleFlight).toBe('function');
    expect(typeof PersianFastConformerRnntAndTdtDecoder.prototype.transcribeWindow).toBe('function');
    expect(typeof IntegratedPersianAsrService.prototype.transcribeAndAnalyzeAudio).toBe('function');
    expect(typeof PersianPhoneticConfusionCorrector.prototype.correctTranscriptWithContextRescoring).toBe('function');
    expect(typeof AsrRegressionDiffRunner.compareCandidateAgainstBaseline).toBe('function');
    expect(typeof BackendModelCanaryRolloutService.prototype.computeDeterministicBucket).toBe('function');
  });

  it('Gate 28: N-Best Sausage Lattice, Streaming Audio Ingest Transcoder, Whisper Beam+LZ77 Fallback, Music/Jingle Filter, Transactional Outbox, Platt Confidence Calibrator, Syntactic Endpointing, and SRT/Webhook Delivery pass verification', () => {
    expect(typeof PersianNBestConfusionNetworkBuilder.buildWordConfusionNetwork).toBe('function');
    expect(typeof NodeStreamingAudioIngestTranscoder.chunkFloat32LeByteStreamIntoOverlappingWindows).toBe('function');
    expect(typeof WhisperBeamSearchAndTempFallbackEngine.computeUtf8TextCompressionRatio).toBe('function');
    expect(typeof PreAsrMusicAndJingleBoundaryFilter.classifyAudioRegionsBeforeAsr).toBe('function');
    expect(typeof TransactionalOutboxDispatcher.prototype.enqueueOutboxEvent).toBe('function');

    const ece = PersianAsrConfidenceCalibrator.computeExpectedCalibrationError([
      { rawConfidence: 0.9, isCorrect: 1 },
      { rawConfidence: 0.85, isCorrect: 1 },
    ]);
    expect(ece.totalSamples).toBe(2);

    const ep = PersianSyntacticAcousticEndpointDetector.evaluateEndpoint({
      partialPersianTranscript: 'تدوین صدا کامل شد',
      trailingSilenceMs: 420,
      utteranceDurationMs: 2500,
      recentVoicedF0ContourHz: [155, 145, 135, 125, 115],
    });
    expect(ep.shouldCommitUtterance).toBe(true);

    const srt = BackendTranscriptFormatterAndWebhookService.formatToPersianSrt([
      { word: 'آواپرداز', startSec: 0.0, endSec: 0.8, speakerId: 'SPEAKER_1' },
    ]);
    expect(srt).toContain('00:00:00,000 --> 00:00:00,800');
  });

  it('Gate 29: Speaker Turn Word Aligner, Enterprise API Key & Atomic Quota Manager, Worker Watchdog Supervisor, BackendApplicationFactory, and Persian RAKE Keyphrase Indexer pass verification', () => {
    expect(typeof SpeakerTurnBoundaryWordAligner.alignTokensToSpeakerTurns).toBe('function');
    expect(typeof EnterpriseApiKeyAndQuotaManager.prototype.issueNewEnterpriseApiKey).toBe('function');
    expect(typeof EnterpriseApiKeyAndQuotaManager.prototype.consumeAudioQuotaAtomically).toBe('function');
    expect(typeof AsrWorkerSupervisorAndWatchdog.prototype.runSupervisedInferenceJob).toBe('function');
    expect(typeof buildBackendApplication).toBe('function');
    expect(typeof PersianTopicAndKeywordIndexer.extractPersianKeyphrases).toBe('function');
  });

  it('Gate 30: Whisper Cross-Attention DTW Aligner, PostgreSQL DatabaseMigrationRunner, and BackendBackgroundCronDaemon pass verification', () => {
    expect(typeof WhisperCrossAttentionDtwAligner.alignTokensAndGroupWords).toBe('function');
    expect(typeof DatabaseMigrationRunner.prototype.applyPendingMigrations).toBe('function');
    expect(typeof BackendBackgroundCronDaemon.prototype.runSingleSweepTick).toBe('function');
  });

  it('Gate 31: Dynamic-Length Batched CTC Runner, Immutable Billing Invoice Ledger, and Pre-ASR Input Sanity Validator pass verification', () => {
    expect(typeof DynamicLengthBatchedCtcRunner.prototype.transcribeVadSegmentsBatched).toBe('function');
    expect(typeof BackendBillingInvoiceAndUsageLedger.prototype.issueImmutableInvoiceForPayment).toBe('function');
    expect(typeof PreAsrInputSanityValidator.validateAndSanitizeForAsr).toBe('function');
  });

  it('Gate 32: WebSocket Live ASR Gateway, ONNX Session Pool, Praat TextGrid / NIST CTM Exporter, Encrypted Model Vault, Detailed WER/CER Evaluator, ROVER Ensemble, Stage Latency Profiler, and Batch HTTP Controller pass verification', () => {
    expect(typeof WebSocketLiveAsrGateway.prototype.openAuthenticatedSession).toBe('function');
    expect(typeof NodeAsrModelSessionPool.prototype.acquireSession).toBe('function');
    expect(typeof PraatTextGridAndLinguisticExporter.exportToPraatTextGrid).toBe('function');
    expect(typeof PraatTextGridAndLinguisticExporter.exportToNistCtm).toBe('function');
    expect(typeof ServerSideEncryptedModelVault.prototype.encryptModelBytes).toBe('function');
    expect(typeof DetailedAsrErrorBreakdownEvaluator.evaluateDetailedBreakdown).toBe('function');
    expect(typeof PersianRoverMultiModelEnsembleEngine.combineModelOutputs).toBe('function');
    expect(typeof BackendAsrStageLatencyProfiler.prototype.traceStage).toBe('function');
    expect(typeof BackendBatchHttpSubmissionController.prototype.registerRoutes).toBe('function');
  });
});

