import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrokerWorkerLike,
  encodeAndValidateWavExport,
  StorageBrokerClient,
  WritePcmBlockResult,
} from './storageBroker';
import {
  IngestAbortedError,
  ingestAudioFileStreaming,
  IngestTransactionError,
  IngestTransactionTracker,
  parseWavHeaderStreaming,
  StreamingIngestBroker,
} from './streamingIngest';
import {
  OpfsDirectoryLike,
  WorkerBrokerRequest,
} from './workerStorageCore';
import {
  detectLongPauses,
  detectPitchPlateauSegments,
  extractAcousticProfile,
  refinePersianCutBoundary,
  snapToZeroCrossing,
} from './dsp';
import { resampleChunkedTo16kStream, resampleTo16kMono } from './resampler';
import { processChunkWithPreRoll } from './processingGraph';
import {
  applyWsolaTimeStretchToSelectedTokens,
  buildHonestAcousticSpeechSegments,
  encodeMono16kWavBase64,
  exportTranscriptToSrt,
  exportTranscriptToVtt,
  planAsrTranscriptionChunks,
  shiftTokensAndRecommendationsByOffset,
} from './persianAsrTranscriber';
import { buildSyntheticMicRecordingPcm } from './audioFixtures';
import { secondsToFlicks } from './timebase';
import {
  IngestTransactionSnapshot,
  PersistedAudioAssetManifest,
  PersianWordToken,
  StorageBrokerTelemetry,
  Track,
} from '../contracts/v1_2';
import { buildPeakPyramid, StreamingPeakPyramidBuilder } from './peakPyramid';
import { renderTimelineRangeToPcm, streamingChunkedRender } from './audioPlayback';
import { applySyncSafeCut, determineSyncSafeEditMode } from './timeline';
import { TimeStretchWsolaEngine } from '../../packages/audio-runtime/src/TimeStretchWsolaEngine';
import { SpectralWienerDenoiserEngine } from '../../packages/audio-runtime/src/SpectralWienerDenoiserEngine';
import { Parametric8BandBiquadEq } from '../../packages/audio-runtime/src/Parametric8BandBiquadEq';
import { SensitiveContentAndPiiRedactorEngine } from '../../packages/audio-runtime/src/SensitiveContentAndPiiRedactorEngine';
import { AudioBusAndRoutingMatrixEngine } from '../../packages/audio-runtime/src/AudioBusAndRoutingMatrixEngine';
import { MidSideVocalSpaceCarverEngine } from '../../packages/audio-runtime/src/MidSideVocalSpaceCarverEngine';
import { ChannelAndPhaseAlignmentEngine } from '../../packages/audio-runtime/src/ChannelAndPhaseAlignmentEngine';
import { MultiRecorderClockDriftAligner } from '../../packages/audio-runtime/src/MultiRecorderClockDriftAligner';
import { SmartSplicePreviewEngine } from '../../packages/audio-runtime/src/SmartSplicePreviewEngine';
import { VocalAndMusicStemSeparatorEngine } from '../../packages/audio-runtime/src/VocalAndMusicStemSeparatorEngine';
import { MultiSpeakerTurnLevelerEngine } from '../project-core/MultiSpeakerTurnLevelerEngine';
import { TimelineAutomationEngine } from '../project-core/TimelineAutomationEngine';
import { TimeMath } from '../contracts/timebase.contract';
import { LoudnessAndMasteringEngine } from '../audio-engine/LoudnessAndMasteringEngine';
import { PersianAcousticSnapper } from '../audio-engine/PersianAcousticSnapper';
import { CTRL_STATE, SharedAudioRingBuffer } from '../audio-engine/SharedRingBuffer';
import { AudioRestorationEngine } from '../processing-core/AudioRestorationEngine';
import { StreamingWavExportEncoder } from '../processing-core/StreamingExportEncoder';
import { RecordingQualityAdvisorEngine } from '../../packages/audio-runtime/src/RecordingQualityAdvisorEngine';
import { ProcessingGraphEngine, ProcessingNodeSpec } from '../processing-core/ProcessingGraphEngine';
import { ParallelChunkRenderCoordinator } from '../processing-core/ParallelChunkRenderCoordinator';
import { MerkleDagCacheManager } from '../processing-core/MerkleDagCacheManager';
import { TimelineTransactionEngine } from '../project-core/TimelineTransactionEngine';
import { PostEditValidationEngine } from '../project-core/PostEditValidationEngine';
import { StreamingPlaybackPumpController } from '../../packages/audio-runtime/src/StreamingPlaybackPumpController';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { buildId3v2Tag, exportPcmToCompleteBuffer } from '../processing-core/StreamingExportEncoderWorker';
import { DawTimelineInterchangeExporter } from '../project-core/DawTimelineInterchangeExporter';
import { PriorityWorkerPoolDispatcher, WorkerTaskPriority } from '../../packages/audio-runtime/src/PriorityWorkerPoolDispatcher';
import { LiveMarkerAndAnnotationManager } from '../project-core/LiveMarkerAndAnnotationManager';
import { SpeechReconstructionAndWatermarkEngine } from '../../packages/audio-runtime/src/SpeechReconstructionAndWatermarkEngine';
import { AcousticTranslationSimulatorEngine } from '../../packages/audio-runtime/src/AcousticTranslationSimulatorEngine';
import { AntiAliasedResampler } from '../ai-engine/AntiAliasedResampler';
import { MultiSpeakerDiarizationAndCrosstalkEngine } from '../ai-engine/MultiSpeakerDiarizationAndCrosstalkEngine';
import { NonVerbalVocalEventDetector } from '../ai-engine/NonVerbalVocalEventDetector';
import { PersianCtcForcedAligner } from '../ai-engine/PersianCtcForcedAligner';
import { AudioCrossfadeProcessor } from '../audio-renderer/AudioCrossfadeProcessor';
import { AudioBoundaryProcessor } from '../audio-renderer/AudioBoundaryProcessor';
import { buildAsrWindowMappings, mapWindowTokenToSourceRange } from '../audio-timing/AsrWindowReconciler';
import { AsrWindowRelativeSec } from '../audio-timing/SamplePosition';
import { PersianProsodyAndPacingAnalyzer } from '../ai-engine/PersianProsodyAndPacingAnalyzer';
import { PersianPodcastTeaserGeneratorEngine } from '../ai-engine/PersianPodcastTeaserGeneratorEngine';
import { PersianChapterAndTopicSegmenter } from '../ai-engine/PersianChapterAndTopicSegmenter';
import { PersianProsodicPunctuationRestorer } from '../ai-engine/PersianProsodicPunctuationRestorer';
import { PersianShowNotesAndTextRankEngine } from '../ai-engine/PersianShowNotesAndTextRankEngine';
import { AudioExportWriter, BoundedChunkedByteSink } from '../audio-renderer/AudioExportWriter';
import { createCommittedRenderArtifact } from '../audio-renderer/RenderOutputArtifact';
import { PersianDisfluencyEngine } from '../ai-engine/PersianDisfluencyEngine';
import { PersianSemanticRepetitionEngine } from '../ai-engine/PersianSemanticRepetitionEngine';
import { PersianPhoneticTranscriptSearchEngine } from '../ai-engine/PersianPhoneticTranscriptSearchEngine';
import { PersianChunkedAsrEngine } from '../ai-engine/PersianChunkedAsrWorker';
import { AudioRenderPlanner } from '../audio-renderer/AudioRenderPlanner';
import { AudioRenderValidator } from '../audio-renderer/AudioRenderValidator';
import { EditDecisionListSnapshot } from '../ai-engine/edit-decision/EditDecisionTypes';
import { CustomPersianLexiconManager } from '../ai-engine/CustomPersianLexiconManager';
import { OnnxPersianAsrAndVadAdapter } from '../ai-engine/OnnxPersianAsrAndVadAdapter';
import { ScriptToAudioDeviationDetector } from '../ai-engine/ScriptToAudioDeviationDetector';
import { AudioSourceReader, createPlanarArrayPcmSource } from '../audio-renderer/AudioSourceReader';
import { AudioRenderEngine } from '../audio-renderer/AudioRenderEngine';
import { EditBoundaryRefiner, normalizeTokensToSampleSpans } from '../ai-engine/edit-decision/EditBoundaryRefiner';
import { EditCandidateEvaluator, classifyEventConfidence } from '../ai-engine/edit-decision/EditCandidateEvaluator';
import { EditConflictResolver } from '../ai-engine/edit-decision/EditConflictResolver';
import { EditRiskEvaluator } from '../ai-engine/edit-decision/EditRiskEvaluator';
import { SilenceAndPauseAnalyzer } from '../ai-engine/speech-events/SilenceAndPauseAnalyzer';
import {
  applyPrecisionEligibilityAndThresholds,
  evaluateDetectedSpeechEvents,
  fuseSpeechEventEvidence,
} from '../ai-engine/speech-events/SpeechEventEvidenceFusion';
import { SpeechEvent } from '../ai-engine/speech-events/SpeechEventContracts';
import { EditProposal } from '../ai-engine/edit-decision/EditDecisionTypes';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import { checkProposalProvenanceStaleness } from '../ai-engine/edit-decision/EditProvenance';
import { SpeechEventEngine } from '../ai-engine/speech-events/SpeechEventEngine';
import { buildTimelineSuggestionsFromSpeechEvents } from '../ai-engine/speech-events/TimelineSuggestionBridge';
import {
  evaluateRealAudioAlignmentBenchmark,
  validateTranscriptTemporalIntegrity,
} from '../audio-timing/TemporalIntegrityValidator';
import {
  asAsrWindowRelativeSec,
  asSourceSamplePosition,
  createSourceSampleRange,
  TimelineDisplaySec,
} from '../audio-timing/SamplePosition';
import { reconcileOverlappingAsrWindows } from '../audio-timing/AsrWindowReconciler';
import { runPersianForcedAlignmentContract } from '../audio-timing/PersianAlignmentContract';
import { ResampleCoordinateMapper } from '../audio-timing/ResampleCoordinateMapper';
import { flicksToSourceSampleExact, scaleIntegerRational } from '../audio-timing/TimeConversion';
import {
  analyzePersianOrthography,
  analyzePersianPunctuationProposals,
  analyzePersianSpokenNumbers,
  assessSemanticChangeRisk,
  createPersianTranscriptDocument,
  renderTranscriptLayerText,
  TranscriptTransformationEngine,
} from '../persian-linguistics';
import {
  buildTranscriptSegmentsFromTokens,
  exportTranscriptContent,
  getSpeechEventsForSegment,
  StudioWorkflowController,
} from '../workflow/StudioWorkflowController';
import {
  evaluateAlignmentBoundaryMetrics,
  evaluateDiarizationQualityPerLanguage,
  runModularDiarizationCapability,
  runModularForcedAlignmentCapability,
} from '../intelligence/DiarizationAlignmentEngine';
import { generateModularSubtitles } from '../intelligence/TranslationSubtitlesEngine';
import {
  RealtimeIntelligenceStreamCoordinator,
  runConversationAnalyticsCapability,
  TenantIsolatedSemanticIndex,
} from '../intelligence/MeetingAnalyticsSearchEngine';
import {
  computeSignalHealth,
  float32ToPcm16Buffer,
  inspectAndDownmixChannels,
} from '../asr-core/CoreAudioIngestion';
import {
  CoreAcousticCtcEngine,
  extractAcousticFeatureFrames,
  synthesizeAcousticSpeechFromText,
  trainAcousticAdapterOnCorpus,
} from '../asr-core/CoreAcousticCtcEngine';
import { CoreStreamingAsrManager } from '../asr-core/CoreStreamingAsrEngine';
import {
  CoreBatchAndLongFormEngine,
  findBestBoundaryValleySample,
} from '../asr-core/CoreBatchAndLongFormEngine';
import {
  buildLongFormStressAudioPcm,
  computePairedBootstrapCi,
} from '../asr-core/CoreAsrBenchmarkSuite';
import { CoreModelRouter } from '../asr-core/CoreModelRouter';
import { ResponsiveSeekController } from '../performance/ResponsiveSeekController';
import { virtualizeTimelineEvents } from '../performance/TimelineVirtualizer';
import { AdaptiveDegradationController } from '../performance/AdaptiveDegradationController';
import { MultiresolutionWaveformCache } from '../performance/MultiresolutionWaveformCache';
import { PerformanceAggregator } from '../performance/PerformanceAggregator';
import { LongSessionMonitor } from '../performance/LongSessionMonitor';
import { PerformanceAnomalyDetector } from '../performance/PerformanceAnomalyDetector';
import { evaluatePerformanceRegressionInvariants } from '../performance/PerformanceRegressionGuard';
import { TaskScheduler } from '../performance/TaskScheduler';
import { HardwareBenchmarkProfiler } from '../runtime/HardwareBenchmarkProfiler';
import { UnifiedProcessingOrchestrator } from '../processing-engine/UnifiedProcessingOrchestrator';
import {
  CloudExecutionAdapter,
  DeterministicMockCloudTransport,
} from '../processing-engine/CloudExecutionAdapter';
import { LocalExecutionAdapter } from '../processing-engine/LocalExecutionAdapter';
import {
  UNIFIED_PROCESSING_CONFIG_VERSION,
  UNIFIED_PROCESSING_CONTRACT_VERSION,
  UnifiedProcessingError,
  uint8ArrayToTransportSafeAudioInput,
} from '../processing-engine/UnifiedProcessingContract';
import { evaluateRenderedAudioSignalQuality } from '../quality-gate/ReleaseReadinessGate';
import {
  computeAutoScrollViewport,
  dispatchStudioShortcutKeyDown,
  findActiveTokenIdAtFlicks,
} from '../hooks/useAudioStudioController';
import { AudioIngestionAndUrlGuard } from '../security/AudioIngestionAndUrlGuard';
import { StreamingSecurityGuard } from '../security/StreamingSecurityGuard';
import { WorkerStorageCore } from './workerStorageCore';

function makeWavFileLike(params: {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  dataBytes: number;
}) {
  const buf = new ArrayBuffer(44 + params.dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + params.dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, params.numChannels, true);
  view.setUint32(24, params.sampleRate, true);
  view.setUint32(28, params.sampleRate * params.blockAlign, true);
  view.setUint16(32, params.blockAlign, true);
  view.setUint16(34, params.bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, params.dataBytes, true);
  const blob = new Blob([buf], { type: 'audio/wav' });
  return {
    size: blob.size,
    slice: (start?: number, end?: number) => blob.slice(start, end),
  };
}

test('encodeAndValidateWavExport rejects NaN/Infinity, mismatched channels, and invalid sampleRate while validating stereo fades', () => {
  // 1. NaN & Infinity samples must fail validation and never poison LUFS/TruePeak with NaN
  const poisoned = new Float32Array([0, 0.25, Number.NaN, -0.25, Number.POSITIVE_INFINITY, 0]);
  const nanRes = encodeAndValidateWavExport([poisoned], 48_000);
  assert.equal(nanRes.report.passed, false);
  assert.equal(nanRes.report.readable, false);
  assert.equal(nanRes.report.invalidSampleCount, 2);
  assert.equal(Number.isFinite(nanRes.report.truePeakDbfs), true);
  assert.equal(Number.isFinite(nanRes.report.integratedLufs), true);

  // 2. Mismatched stereo channel lengths fail structurally
  const mismatch = encodeAndValidateWavExport(
    [new Float32Array(128), new Float32Array(64)],
    48_000,
  );
  assert.equal(mismatch.report.passed, false);
  assert.equal(mismatch.report.readable, false);
  assert.equal(mismatch.report.structurallyValid, false);

  // 3. Invalid sample rate & empty channel array fail structurally
  const badRate = encodeAndValidateWavExport([new Float32Array(128)], 0);
  assert.equal(badRate.report.passed, false);
  assert.equal(badRate.report.structurallyValid, false);
  assert.equal(badRate.report.durationSeconds, 0);

  const emptyCh = encodeAndValidateWavExport([], 48_000);
  assert.equal(emptyCh.report.passed, false);
  assert.equal(emptyCh.report.structurallyValid, false);

  // 4. Stereo head/tail fade check inspects ALL channels (catches click on right channel)
  const left = new Float32Array([0, 0.2, 0.2, 0]);
  const rightClick = new Float32Array([0, 0.2, 0.2, 0.65]);
  const stereoClick = encodeAndValidateWavExport([left, rightClick], 48_000);
  assert.equal(stereoClick.report.headTailFadeValid, false);

  // 5. Clean faded stereo PCM passes completely
  const cleanL = new Float32Array(480);
  const cleanR = new Float32Array(480);
  for (let i = 0; i < 480; i++) {
    const env = Math.sin((Math.PI * i) / 479);
    cleanL[i] = 0.4 * env * Math.sin((2 * Math.PI * 440 * i) / 48_000);
    cleanR[i] = 0.4 * env * Math.cos((2 * Math.PI * 440 * i) / 48_000);
  }
  const cleanRes = encodeAndValidateWavExport([cleanL, cleanR], 48_000);
  assert.equal(cleanRes.report.passed, true);
  assert.equal(cleanRes.report.readable, true);
  assert.equal(cleanRes.report.invalidSampleCount, 0);
  assert.equal(cleanRes.report.headTailFadeValid, true);
  assert.equal(cleanRes.report.channelCount, 2);
});

test('parseWavHeaderStreaming rejects undersized blockAlign headers to prevent DataView out-of-bounds reads', async () => {
  const malformed = makeWavFileLike({
    numChannels: 2,
    sampleRate: 48_000,
    bitsPerSample: 16,
    blockAlign: 2, // invalid: stereo 16-bit requires at least 4 bytes/frame
    dataBytes: 400,
  });
  assert.equal(await parseWavHeaderStreaming(malformed), null);

  const valid = makeWavFileLike({
    numChannels: 2,
    sampleRate: 48_000,
    bitsPerSample: 16,
    blockAlign: 4,
    dataBytes: 400,
  });
  const parsed = await parseWavHeaderStreaming(valid);
  assert.ok(parsed);
  assert.equal(parsed.totalSamples, 100);
  assert.equal(parsed.blockAlign, 4);
});

test('Core DSP functions safely handle empty buffers and non-positive or low sample rates without infinite loops or inverted ranges', () => {
  assert.deepEqual(snapToZeroCrossing(new Float32Array(0), 10), { index: 0, adjusted: false });
  assert.deepEqual(snapToZeroCrossing(new Float32Array([0.5]), 5), { index: 0, adjusted: false });

  const emptyBoundary = refinePersianCutBoundary(new Float32Array(0), 48_000, {
    startFlicks: secondsToFlicks(1),
    endFlicks: secondsToFlicks(2),
  });
  assert.ok(emptyBoundary.snappedRange.startFlicks <= emptyBoundary.snappedRange.endFlicks);
  assert.equal(Number.isFinite(emptyBoundary.rmsValleyShiftMs), true);

  const zeroRateBoundary = refinePersianCutBoundary(new Float32Array(100), 0, {
    startFlicks: secondsToFlicks(0.5),
    endFlicks: secondsToFlicks(1.0),
  });
  assert.equal(zeroRateBoundary.rmsValleyShiftMs, 0);

  const dummyProfile = {
    assetId: 'a1',
    noiseFloorDbfs: -60,
    roomToneRms: 0.001,
    roomToneSample: new Float32Array(10),
    sampleRate: 48_000,
  };
  assert.deepEqual(detectLongPauses(new Float32Array(100), 0, dummyProfile), []);
  assert.deepEqual(detectPitchPlateauSegments(new Float32Array(100), 0), []);
  assert.deepEqual(detectPitchPlateauSegments(new Float32Array(100), 100), []);
});

test('Resampler handles invalid rates, mismatched channel lengths, NaN samples, and zero chunk size safely', async () => {
  const badRate = resampleTo16kMono([new Float32Array(100)], 0, 16_000);
  assert.equal(badRate.samples.length, 0);

  const chA = new Float32Array(300).fill(0.2);
  chA[10] = Number.NaN;
  const chB = new Float32Array(150).fill(0.4);
  const res = resampleTo16kMono([chA, chB], 48_000, 16_000);
  assert.equal(res.samples.length, 50);
  for (let i = 0; i < res.samples.length; i++) {
    assert.equal(Number.isFinite(res.samples[i]), true);
  }

  const streamRes = await resampleChunkedTo16kStream({
    inputSampleRate: 48_000,
    targetSampleRate: 16_000,
    totalInputSamples: 0,
    chunkSizeSamples: 0,
    readInputChunkFn: async () => new Float32Array(0),
    onOutputChunk: () => {},
  });
  assert.equal(streamRes.totalOutputSamples, 0);
});

test('processChunkWithPreRoll sanitizes NaN samples without poisoning IIR filter state and clamps negative preRoll', () => {
  const input = new Float32Array(256).fill(0.25);
  input[12] = Number.NaN;
  input[13] = Number.POSITIVE_INFINITY;

  const out = processChunkWithPreRoll(input, -16, 48_000, {
    highPassHz: 85,
    noiseGateThresholdDb: -50,
    compressorThresholdDb: -18,
    compressorRatio: 3,
    masterGainDb: 0,
  });
  assert.equal(out.length, 256);
  for (let i = 0; i < out.length; i++) {
    assert.equal(Number.isFinite(out[i]), true);
  }
  assert.ok(Math.abs(out[200]) > 0.01, 'IIR state must recover after non-finite input sample');
});

test('SRT/VTT exporter handles 999.6ms rollover cleanly and encodeMono16kWavBase64 sanitizes non-finite input', () => {
  const tokens: PersianWordToken[] = [
    {
      id: 't1',
      trackId: 'tr1',
      speakerName: 'سارا',
      originalText: 'سلام',
      normalizedText: 'سلام',
      displayText: 'سلام',
      range: {
        startFlicks: secondsToFlicks(0.9996),
        endFlicks: secondsToFlicks(1.9997),
      },
      confidence: 0.98,
      alignmentSource: 'ASR',
    },
  ];
  const srt = exportTranscriptToSrt(tokens);
  assert.ok(srt.includes('00:00:01,000 --> 00:00:02,000'), `unexpected SRT: ${srt}`);
  const vtt = exportTranscriptToVtt(tokens);
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.000'), `unexpected VTT: ${vtt}`);

  const b64 = encodeMono16kWavBase64(new Float32Array([0, Number.NaN, 0.5, -0.5]), 0);
  const decoded = Buffer.from(b64, 'base64');
  assert.equal(decoded.toString('ascii', 0, 4), 'RIFF');
  assert.equal(decoded.readUInt32LE(24), 16_000);
});

test('applyWsolaTimeStretchToSelectedTokens shifts subsequent clip sourceStartFlicks and maps enclosing clip source offset', () => {
  const sampleRate = 16_000;
  const pcm = new Float32Array(sampleRate * 6);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }

  // Multi-clip track simulating a previous 1s ripple cut between clip-1 [0..2s] and clip-2 [2..4s] (sourceStart 3s)
  const tracks: Track[] = [
    {
      id: 'track-host',
      name: 'میزبان',
      speakerLabel: 'سارا',
      syncGroupId: null,
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'clip-1',
          assetId: 'asset-1',
          trackId: 'track-host',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(2) },
          sourceStartFlicks: 0,
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        },
        {
          id: 'clip-2',
          assetId: 'asset-1',
          trackId: 'track-host',
          kind: 'speech',
          timelineRange: { startFlicks: secondsToFlicks(2), endFlicks: secondsToFlicks(4) },
          sourceStartFlicks: secondsToFlicks(3),
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        },
      ],
    },
  ];

  const tokens: PersianWordToken[] = [
    {
      id: 'w1',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'اول',
      normalizedText: 'اول',
      displayText: 'اول',
      range: { startFlicks: secondsToFlicks(0.5), endFlicks: secondsToFlicks(1.5) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
    {
      id: 'w2',
      trackId: 'track-host',
      speakerName: 'سارا',
      originalText: 'دوم',
      normalizedText: 'دوم',
      displayText: 'دوم',
      range: { startFlicks: secondsToFlicks(2.5), endFlicks: secondsToFlicks(3.2) },
      confidence: 0.95,
      alignmentSource: 'ASR',
    },
  ];

  const res = applyWsolaTimeStretchToSelectedTokens({
    pcm,
    sampleRate,
    tokens,
    tracks,
    targetTrackId: 'track-host',
    selectedTokenIds: ['w1'],
    tempoRatio: 0.8,
  });

  const clip2Before = tracks[0].clips[1];
  const clip2After = res.updatedTracks[0].clips[1];
  const timelineShift = clip2After.timelineRange.startFlicks - clip2Before.timelineRange.startFlicks;
  const sourceShift = clip2After.sourceStartFlicks - clip2Before.sourceStartFlicks;

  assert.ok(timelineShift > 0, 'slowing down clip-1 must shift clip-2 later on timeline');
  assert.equal(
    sourceShift,
    timelineShift,
    'clip-2 sourceStartFlicks must shift by the exact same delta so it continues reading the same audio in stretchedPcm',
  );
});

test('PeakPyramid accurately captures >1.0 float peaks, sanitizes NaN/mismatched channels, and StreamingPeakPyramidBuilder.finalize() is idempotent', () => {
  const hot = new Float32Array(128).fill(1.35);
  hot[5] = Number.NaN;
  const shorter = new Float32Array(64).fill(1.35);
  const pyr = buildPeakPyramid('a-hot', [hot, shorter], 48_000, [0, -1, 64]);
  assert.equal(pyr.totalSamples, 64);
  assert.equal(pyr.levels.length, 1);
  assert.ok(pyr.levels[0].min[0] > 1.3, `min should capture >1.0 float level, got ${pyr.levels[0].min[0]}`);
  assert.ok(pyr.levels[0].max[0] > 1.3);
  assert.equal(Number.isFinite(pyr.levels[0].rms[0]), true);

  const builder = new StreamingPeakPyramidBuilder('a-stream', 48_000, [32]);
  builder.pushMonoChunk(new Float32Array(20).fill(0.5));
  const midSnap = builder.finalize();
  assert.equal(midSnap.levels[0].min.length, 1);
  builder.pushMonoChunk(new Float32Array(20).fill(-0.5));
  const finalSnap = builder.finalize();
  const finalSnapRepeat = builder.finalize();
  assert.equal(finalSnap.totalSamples, 40);
  assert.equal(finalSnap.levels[0].min.length, 2);
  assert.deepEqual(Array.from(finalSnap.levels[0].min), Array.from(finalSnapRepeat.levels[0].min));
});

test('audioPlayback guards invalid sampleRate, negative preRoll, zero chunkSeconds, and NaN source samples', () => {
  const tracks: Track[] = [
    {
      id: 'tr1',
      name: 'Track 1',
      speakerLabel: 'گوینده',
      syncGroupId: null,
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 'tr1',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(0.1) },
          sourceStartFlicks: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
          gainDb: 0,
          muted: false,
        },
      ],
    },
  ];
  const pcm = new Float32Array(1600).fill(0.2);
  pcm[10] = Number.NaN;
  const dspParams = {
    highPassHz: 80,
    noiseGateThresholdDb: -60,
    compressorThresholdDb: -18,
    compressorRatio: 2,
    masterGainDb: 0,
  };

  assert.equal(
    renderTimelineRangeToPcm({
      tracks,
      assets: {},
      pcmSources: { a1: pcm },
      sampleRate: 0,
      rangeFlicks: { startFlicks: 0, endFlicks: secondsToFlicks(0.1) },
      dspParams,
    }).length,
    0,
  );

  const rendered = streamingChunkedRender({
    tracks,
    assets: {},
    pcmSources: { a1: pcm },
    sampleRate: 16_000,
    dspParams,
    chunkSeconds: 0, // must not infinite loop
  });
  assert.equal(rendered.length, 1600);
  for (let i = 0; i < rendered.length; i++) {
    assert.equal(Number.isFinite(rendered[i]), true);
  }
});

test('timeline.ts ignores inverted cutRange without splitting clips and preserves acoustic sync-lock despite NaN samples', () => {
  const tracks: Track[] = [
    {
      id: 't-host',
      name: 'Host',
      speakerLabel: 'میزبان',
      syncGroupId: 'sync-1',
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c-host',
          assetId: 'a-host',
          trackId: 't-host',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(4) },
          sourceStartFlicks: 0,
          fadeInMs: 5,
          fadeOutMs: 5,
          gainDb: 0,
          muted: false,
        },
      ],
    },
    {
      id: 't-guest',
      name: 'Guest',
      speakerLabel: 'مهمان',
      syncGroupId: 'sync-1',
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      clips: [
        {
          id: 'c-guest',
          assetId: 'a-guest',
          trackId: 't-guest',
          kind: 'speech',
          timelineRange: { startFlicks: 0, endFlicks: secondsToFlicks(4) },
          sourceStartFlicks: 0,
          fadeInMs: 5,
          fadeOutMs: 5,
          gainDb: 0,
          muted: false,
        },
      ],
    },
  ];

  // Inverted cutRange must be a clean no-op
  const afterInverted = applySyncSafeCut(
    tracks,
    't-host',
    { startFlicks: secondsToFlicks(2), endFlicks: secondsToFlicks(1) },
    'sync-locked-ripple-cut',
  );
  assert.equal(afterInverted[0].clips.length, 1);
  assert.equal(afterInverted[0].clips[0].timelineRange.endFlicks, secondsToFlicks(4));

  // Peer track has active speech + one NaN sample: must still protect sync via in-place-room-tone-suppression
  const guestPcm = new Float32Array(16_000 * 4).fill(0.25);
  guestPcm[16_000] = Number.NaN;
  const safety = determineSyncSafeEditMode(
    tracks,
    't-host',
    { startFlicks: secondsToFlicks(0.5), endFlicks: secondsToFlicks(1.5) },
    [],
    { 'a-host': new Float32Array(16_000 * 4), 'a-guest': guestPcm },
    16_000,
  );
  assert.equal(safety.mode, 'in-place-room-tone-suppression');
});

test('audio-runtime DSP engines: WSOLA 96kHz bounds, Wiener/Biquad NaN recovery, and Redactor smooth edge crossfades', () => {
  // 1. WSOLA at 96kHz with 2100 samples (< 2400 winLength) & NaN tempoRatio must never produce NaN or empty output
  const pcm96k = new Float32Array(2100).fill(0.3);
  const out96k = TimeStretchWsolaEngine.processTimeStretch(pcm96k, 96_000, 0.8);
  assert.equal(out96k.length, 2100);
  for (let i = 0; i < out96k.length; i++) assert.equal(Number.isFinite(out96k[i]), true);

  const outNanTempo = TimeStretchWsolaEngine.processTimeStretch(pcm96k, 48_000, Number.NaN);
  assert.equal(outNanTempo.length, 2100);

  // 2. SpectralWienerDenoiserEngine & Parametric8BandBiquadEq recover cleanly from NaN samples
  const room = new Float32Array(4096).fill(0.01);
  room[10] = Number.NaN;
  const denoiser = new SpectralWienerDenoiserEngine(room);
  const noisy = new Float32Array(4096).fill(0.2);
  noisy[20] = Number.NaN;
  const cleaned = denoiser.processChunk(noisy, 0.85);
  for (let i = 0; i < cleaned.length; i++) assert.equal(Number.isFinite(cleaned[i]), true);

  const eq = new Parametric8BandBiquadEq(48_000);
  const eqBuf = new Float32Array(512).fill(0.2);
  eqBuf[5] = Number.NaN;
  eq.processInPlace(eqBuf);
  for (let i = 0; i < eqBuf.length; i++) assert.equal(Number.isFinite(eqBuf[i]), true);

  // 3. SensitiveContentAndPiiRedactorEngine blends edges seamlessly on ROOM_TONE_SILENT_MASK & LOW_PASS_VOICE_MUFFLE
  const orig = new Float32Array(4800).fill(0.4);
  orig[50] = Number.NaN;
  const rt = new Float32Array(240).fill(0.005);
  const maskedRt = SensitiveContentAndPiiRedactorEngine.generateRedactedAudioSegment(
    orig,
    rt,
    48_000,
    'ROOM_TONE_SILENT_MASK',
  );
  assert.ok(Math.abs(maskedRt[0] - orig[0]) < 1e-5, 'head edge should blend cleanly from original sample');
  assert.ok(Math.abs(maskedRt[maskedRt.length - 1] - orig[orig.length - 1]) < 1e-5, 'tail edge should blend cleanly');

  const muffled = SensitiveContentAndPiiRedactorEngine.generateRedactedAudioSegment(
    orig,
    rt,
    48_000,
    'LOW_PASS_VOICE_MUFFLE',
  );
  for (let i = 0; i < muffled.length; i++) assert.equal(Number.isFinite(muffled[i]), true);
  assert.ok(Math.abs(muffled[0] - orig[0]) < 1e-5);
});

test('MultiSpeakerTurnLevelerEngine preserves steady per-speaker gain across tight turn handoffs without keyframe interleaving', () => {
  const sr = 16_000 as const;
  const pcm = new Float32Array(sr * 6);
  // Speaker 1 [1.0s .. 3.0s]: loud (~ -6 dBFS -> needs negative cut)
  for (let i = sr * 1; i < sr * 3; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  pcm[sr * 2] = Number.NaN; // single NaN sample must not poison RMS calculation

  // Speaker 2 [3.05s .. 5.0s]: quiet (~ -33 dBFS -> needs positive boost), only 50ms gap (< 160ms)
  for (let i = Math.floor(sr * 3.05); i < sr * 5; i++) {
    pcm[i] = 0.03 * Math.sin((2 * Math.PI * 260 * i) / sr);
  }

  const lane = MultiSpeakerTurnLevelerEngine.buildSpeakerLevelingAutomationLane({
    trackId: 'trk_tight',
    pcmMono: pcm,
    sampleRate: sr,
    targetRmsDb: -18.0,
    speakerSegments: [
      {
        segmentId: 't1',
        trackId: 'trk_tight',
        speakerId: 'SPK_1',
        classification: 'PRIMARY_SPEECH',
        range: { start: TimeMath.secondsToFlicks(1.0), end: TimeMath.secondsToFlicks(3.0) },
        confidence: 0.95,
        manuallyVerifiedByUser: false,
      },
      {
        segmentId: 't2',
        trackId: 'trk_tight',
        speakerId: 'SPK_2',
        classification: 'PRIMARY_SPEECH',
        range: { start: TimeMath.secondsToFlicks(3.05), end: TimeMath.secondsToFlicks(5.0) },
        confidence: 0.95,
        manuallyVerifiedByUser: false,
      },
    ],
  });

  // Keyframe timestamps must be strictly non-decreasing with no 0 dB dip injected inside active speech
  for (let i = 1; i < lane.keyframes.length; i++) {
    assert.ok(lane.keyframes[i].timeFlicks >= lane.keyframes[i - 1].timeFlicks);
  }
  const spk1Early = TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(1.2));
  const spk1Late = TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(2.9));
  const spk2Early = TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(3.15));
  const spk2Late = TimelineAutomationEngine.evaluateAtFlicks(lane, TimeMath.secondsToFlicks(4.8));

  assert.ok(spk1Early < -5.0 && Math.abs(spk1Early - spk1Late) < 1e-6, 'Speaker 1 gain must stay steady');
  assert.ok(spk2Early > 8.0 && Math.abs(spk2Early - spk2Late) < 1e-6, 'Speaker 2 gain must stay steady');
});

test('TimelineAutomationEngine handles speech at t=0 without duplicate keyframe step, filters invalid ranges, and guards NaN/mismatched channels', () => {
  const lane = TimelineAutomationEngine.generatePodcastMusicDuckingLane({
    musicTrackId: 'trk_music',
    speechActiveRanges: [
      { start: 0, end: TimeMath.secondsToFlicks(2.0) },
      { start: TimeMath.secondsToFlicks(5.0), end: TimeMath.secondsToFlicks(3.0) }, // inverted -> ignored
    ],
    normalMusicGainDb: 0,
    duckedMusicGainDb: -14,
  });

  assert.equal(TimelineAutomationEngine.evaluateAtFlicks(lane, 0), -14);
  assert.equal(TimelineAutomationEngine.evaluateAtFlicks(lane, Number.NaN), 0);

  const ch0 = new Float32Array(128).fill(0.5);
  ch0[10] = Number.NaN;
  const ch1 = new Float32Array(64).fill(0.5);
  TimelineAutomationEngine.applyGainAutomationToChunkInPlace(lane, [ch0, ch1], 0, 48_000);
  for (let i = 0; i < ch0.length; i++) assert.equal(Number.isFinite(ch0[i]), true);
  for (let i = 0; i < ch1.length; i++) assert.equal(Number.isFinite(ch1[i]), true);
});

test('ChannelAndPhaseAlignmentEngine & MultiRecorderClockDriftAligner handle fractional lag, short/NaN buffers, and edge interpolation safely', () => {
  const sig = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
  // Fractional lag previously accessed targetChannel[i + 1.5] === undefined -> NaN
  const aligned = ChannelAndPhaseAlignmentEngine.alignPhaseAndPolarity(sig, sig, 1.4, false);
  for (let i = 0; i < aligned.length; i++) assert.equal(Number.isFinite(aligned[i]), true);
  assert.ok(Math.abs(aligned[0] - 0.2) < 1e-6);

  // Tiny 2-sample buffer with NaN must not divide by maxLag === 0
  const diag = ChannelAndPhaseAlignmentEngine.analyzeStereoPhaseAndDelay(
    new Float32Array([0.2, Number.NaN]),
    new Float32Array([0.2, 0.3]),
    48_000,
  );
  assert.equal(Number.isFinite(diag.zeroLagPhaseCorrelation), true);
  assert.equal(Number.isFinite(diag.estimatedRightLagSamples), true);

  // ClockDriftAligner guards invalid sampleRate, NaN samples, and boundary Catmull-Rom interpolation
  const badReport = MultiRecorderClockDriftAligner.estimateOffsetAndClockDrift(
    new Float32Array(100),
    new Float32Array(100),
    0 as unknown as 48000,
  );
  assert.equal(badReport.resampleStretchFactor, 1.0);

  const secWithNan = new Float32Array([0.1, 0.2, Number.NaN, 0.4, 0.5]);
  const resampled = MultiRecorderClockDriftAligner.applyDriftAndOffsetCorrection(secWithNan, 5, {
    initialOffsetSamples: 0,
    initialOffsetSeconds: 0,
    measuredClockDriftPpm: 0,
    resampleStretchFactor: 1.0001,
    alignmentConfidence: 0.9,
  });
  for (let i = 0; i < resampled.length; i++) assert.equal(Number.isFinite(resampled[i]), true);
});

test('AudioBusAndRoutingMatrixEngine, MidSideVocalSpaceCarverEngine, VocalAndMusicStemSeparatorEngine, and SmartSplicePreviewEngine resist NaN and invalid parameters', () => {
  const sr = 48_000 as const;
  const n = 1024;
  const voice = new Float32Array(n).fill(0.2);
  voice[5] = Number.NaN;
  const music = new Float32Array(n).fill(0.15);
  music[10] = Number.POSITIVE_INFINITY;

  const mix = AudioBusAndRoutingMatrixEngine.mixMultiTrackThroughSubmixBuses({
    trackBuffersMono: new Map([
      ['v', voice],
      ['m', music],
    ]),
    routingTable: [
      { trackId: 'v', targetSubmixBus: 'DIALOGUE_VOICE_BUS', gainDb: Number.NaN, pan: Number.NaN },
      { trackId: 'm', targetSubmixBus: 'MUSIC_BED_BUS', gainDb: -3, pan: 0 },
    ],
    sampleRate: sr,
    frameCount: n,
    enableSidechainVocalCarvingOnMusic: true,
    masterTargetLufs: Number.NaN,
  });
  for (let i = 0; i < n; i++) {
    assert.equal(Number.isFinite(mix.masterOutputStereo[0][i]), true);
    assert.equal(Number.isFinite(mix.masterOutputStereo[1][i]), true);
  }

  const [msL, msR] = MidSideVocalSpaceCarverEngine.decodeMidSideToStereo(music, voice, Number.NaN);
  for (let i = 0; i < n; i++) {
    assert.equal(Number.isFinite(msL[i]), true);
    assert.equal(Number.isFinite(msR[i]), true);
  }

  const stems = VocalAndMusicStemSeparatorEngine.separateVocalAndMusicStems(music, voice, sr);
  assert.equal(Number.isFinite(stems.vocalToMusicEnergyRatioDb), true);
  for (let i = 0; i < n; i++) {
    assert.equal(Number.isFinite(stems.vocalMonoStem[i]), true);
    assert.equal(Number.isFinite(stems.musicStereoStem[0][i]), true);
  }

  const preview = SmartSplicePreviewEngine.buildPreviewAuditionSession({
    mode: 'BEFORE_ORIGINAL',
    fullTrackMonoPcm: voice,
    roomToneBuffer: new Float32Array(0),
    sampleRate: sr,
    contextPaddingMs: Number.NaN,
    dspPreRollSamples: Number.NaN,
    spliceDescriptor: {
      rawAiRange: { start: 0, end: TimeMath.secondsToFlicks(0.005) },
      snappedAcousticRange: { start: 0, end: TimeMath.secondsToFlicks(0.005) },
      fadeOutDurationFlicks: 0,
      fadeInDurationFlicks: Number.NaN,
      injectRoomToneFlicks: Number.NaN,
      cutStrategy: 'IN_PLACE_ROOM_TONE',
      prosodicWarnings: [],
      confidence: 0.9,
    },
  });
  assert.ok(preview.pcm.length > 0);
  assert.equal(Number.isFinite(preview.durationMs), true);
});

test('LoudnessAndMasteringEngine handles mismatched channels, invalid sampleRate, and NaN samples/parameters safely', () => {
  const ch0 = new Float32Array(2048).fill(0.2);
  ch0[10] = Number.NaN;
  const ch1 = new Float32Array(1024).fill(0.2);

  const badRate = LoudnessAndMasteringEngine.measureLoudnessAndTruePeak(
    [ch0, ch1],
    0 as unknown as 48000,
  );
  assert.equal(badRate.integratedLufs, -70);

  const norm = LoudnessAndMasteringEngine.normalizeToTargetLufsWithTruePeakLimiter(
    [ch0, ch1],
    48_000,
    Number.NaN,
    Number.NaN,
  );
  assert.equal(norm.normalizedChannels[0].length, 1024);
  assert.equal(norm.normalizedChannels[1].length, 1024);
  for (let i = 0; i < 1024; i++) {
    assert.equal(Number.isFinite(norm.normalizedChannels[0][i]), true);
    assert.equal(Number.isFinite(norm.normalizedChannels[1][i]), true);
  }

  const [pL, pR] = LoudnessAndMasteringEngine.applyEqualPowerPan(ch0, Number.NaN);
  assert.equal(Number.isFinite(pL[10]), true);
  assert.equal(Number.isFinite(pR[10]), true);
});

test('PersianAcousticSnapper prevents empty roomToneBuffer division-by-zero NaN splice and guards sampleRate/bounds', () => {
  const left = new Float32Array(1000).fill(0.25);
  const right = new Float32Array(1000).fill(-0.25);
  // Previously roomTonePadMs > 0 with empty roomToneBuffer caused i % 0 -> NaN throughout output
  const spliced = PersianAcousticSnapper.applySeamlessSplice(
    left,
    right,
    new Float32Array(0),
    48_000,
    10,
    25,
  );
  assert.ok(spliced.length > 0);
  for (let i = 0; i < spliced.length; i++) assert.equal(Number.isFinite(spliced[i]), true);

  const rtBad = PersianAcousticSnapper.extractRoomToneProfile(left, 0 as unknown as 48000);
  assert.deepEqual(rtBad.roomToneRangeSamples, [0, 0]);

  const onset = PersianAcousticSnapper.findCoarticulatedStretchOnset(left, -50, 999_999, 48_000);
  assert.equal(onset === null || (onset >= 0 && onset <= left.length), true);
});

test('SharedAudioRingBuffer guards invalid capacity, empty/short push buffers, and short pull destination buffers', () => {
  const rb = new SharedAudioRingBuffer(128, 2);
  rb.setPlaying(true);

  assert.equal(rb.push([], 64), 0);
  assert.equal(rb.push([new Float32Array(10)], -5), 0);

  // Pushing frameCount=64 when channel only has 20 frames must cap to 20 instead of advancing stale garbage
  const pushed = rb.push([new Float32Array(20).fill(0.5), new Float32Array(20).fill(-0.5)], 64);
  assert.equal(pushed, 20);
  assert.equal(rb.availableRead(), 20);

  // Pulling 20 frames into a shorter 10-frame destination must not throw RangeError
  const shortOutL = new Float32Array(10);
  const shortOutR = new Float32Array(10);
  assert.equal(rb.pull([shortOutL, shortOutR], 20), true);
  assert.equal(shortOutL[0], 0.5);
  assert.equal(shortOutR[0], -0.5);
});

test('AudioRestorationEngine, StreamingWavExportEncoder, and RecordingQualityAdvisorEngine resist NaN, invalid rates, and zero step sizes', () => {
  // 1. AudioRestorationEngine: single-sample peak immediately before a clipped plateau must NOT skip the plateau
  const clipBuf = new Float32Array(20);
  clipBuf[4] = 0.999; // single-sample peak (runLen=1)
  clipBuf[5] = -0.999; // opposite-polarity plateau immediately after
  clipBuf[6] = -0.999;
  clipBuf[7] = -0.999;
  clipBuf[12] = Number.NaN;
  const clipStats = AudioRestorationEngine.deClipChannelInPlace(clipBuf, {
    enabled: true,
    clipThreshold: 0.992,
    normalizeReconstructedHeadroom: true,
  });
  assert.equal(clipStats.clippedSegmentsRepaired, 1);
  for (let i = 0; i < clipBuf.length; i++) assert.equal(Number.isFinite(clipBuf[i]), true);

  // De-reverb & TKEO & envelope de-reverb resist NaN samples and sampleRate <= 0
  const reverbBuf = new Float32Array(2048).fill(0.2);
  reverbBuf[100] = Number.NaN;
  AudioRestorationEngine.deReverbChannelInPlace(reverbBuf, 48_000, {
    enabled: true,
    reductionAmount: 0.6,
  });
  AudioRestorationEngine.reduceRoomReverbInPlace(reverbBuf, 48_000, Number.NaN);
  for (let i = 0; i < reverbBuf.length; i++) assert.equal(Number.isFinite(reverbBuf[i]), true);

  // 2. StreamingWavExportEncoder: maxWordsPerCaption=0 must not infinite-loop; NaN timestamps never emit "NaN"
  const token = {
    tokenId: 'tok1',
    trackId: 'trk1',
    originalText: 'سلام',
    normalizedText: 'سلام',
    displayText: 'سلام',
    range: { start: 0, end: TimeMath.secondsToFlicks(0.5) },
    confidence: 0.99,
  };
  const vtt = StreamingWavExportEncoder.exportSynchronizedPersianWebVtt([token], 0);
  assert.ok(vtt.includes('سلام') && !vtt.includes('NaN'));
  const chVtt = StreamingWavExportEncoder.exportPodcastChaptersWebVtt([
    { titleFa: 'مقدمه', startSeconds: Number.NaN, endSeconds: Number.NaN },
  ]);
  assert.ok(chVtt.includes('00:00:00.000 --> 00:00:00.000') && !chVtt.includes('NaN'));

  // 3. RecordingQualityAdvisorEngine resists NaN samples and sampleRate=0
  const room = new Float32Array(2048).fill(0.01);
  room[5] = Number.NaN;
  const speech = new Float32Array(4096).fill(0.2);
  speech[10] = Number.POSITIVE_INFINITY;
  const qa = RecordingQualityAdvisorEngine.analyzeRecordingQuality(speech, room, 48_000);
  assert.equal(Number.isFinite(qa.signalToNoiseRatioDb), true);
  assert.equal(Number.isFinite(qa.humFundamentalAndHarmonicsDb.hz50), true);
  const qaZero = RecordingQualityAdvisorEngine.analyzeRecordingQuality(
    speech,
    room,
    0 as unknown as 48000,
  );
  assert.equal(qaZero.has50HzMainsHum, false);
});

test('ParallelChunkRenderCoordinator serializes concurrent in-order flushes, aborts backpressure on error, and guards zero/invalid lengths', async () => {
  const graph = new ProcessingGraphEngine();
  const plan = graph.compileGraph(
    [
      {
        id: 'src',
        type: 'TRACK_SOURCE',
        version: '1.0',
        enabled: true,
        latencySamples: 0,
        preRollSamples: 0,
        tailSamples: 0,
        committedParameters: {},
      },
    ],
    [],
    48_000,
    ['a1'],
  );
  const coord = new ParallelChunkRenderCoordinator(graph);

  // 1. Out-of-order completion + slow async flush must never overlap flushes and must stay strictly ordered
  const flushedOrder: number[] = [];
  let activeFlushes = 0;
  let maxConcurrentFlushes = 0;

  const res = await coord.executeParallelStreamingRender({
    totalTimelineSamples: 400,
    sampleRate: 100 as unknown as 48000,
    compiledPlan: plan,
    chunkDurationSeconds: 1, // 4 chunks of 100 samples
    maxConcurrentWorkers: 4,
    renderChunkOnWorkerFn: async (task) => {
      // Later chunks finish earlier to stress out-of-order flushing
      await new Promise((r) => setTimeout(r, (4 - task.chunkIndex) * 5));
      return [new Float32Array(task.validTargetEndSample - task.validTargetStartSample).fill(task.chunkIndex)];
    },
    flushOrderedChunkToEncoderFn: async (chunkIndex) => {
      activeFlushes++;
      maxConcurrentFlushes = Math.max(maxConcurrentFlushes, activeFlushes);
      await new Promise((r) => setTimeout(r, 8));
      flushedOrder.push(chunkIndex);
      activeFlushes--;
    },
  });

  assert.deepEqual(flushedOrder, [0, 1, 2, 3]);
  assert.equal(maxConcurrentFlushes, 1, 'flushOrderedChunkToEncoderFn must never overlap concurrently');
  assert.equal(res.totalSamplesRendered, 400);

  // 2. Worker failure while sibling workers fill backpressure buffer must reject cleanly (no spin-deadlock)
  await assert.rejects(
    () =>
      coord.executeParallelStreamingRender({
        totalTimelineSamples: 1200,
        sampleRate: 100 as unknown as 48000,
        compiledPlan: plan,
        chunkDurationSeconds: 1,
        maxConcurrentWorkers: 2,
        renderChunkOnWorkerFn: async (task) => {
          if (task.chunkIndex === 0) {
            await new Promise((r) => setTimeout(r, 25));
            throw new Error('WORKER_RENDER_FAILED');
          }
          return [new Float32Array(100)];
        },
        flushOrderedChunkToEncoderFn: async () => {},
      }),
    /WORKER_RENDER_FAILED/,
  );

  // 3. Zero/negative totalTimelineSamples returns 0 cleanly without dispatching dummy chunks
  const emptyRes = await coord.executeParallelStreamingRender({
    totalTimelineSamples: 0,
    sampleRate: 48_000,
    compiledPlan: plan,
    chunkDurationSeconds: 0,
    renderChunkOnWorkerFn: async () => {
      throw new Error('SHOULD_NOT_BE_CALLED');
    },
    flushOrderedChunkToEncoderFn: async () => {},
  });
  assert.equal(emptyRes.totalSamplesRendered, 0);
});

test('ProcessingGraphEngine & MerkleDagCacheManager enforce duplicate ID checks, sanitize negative/NaN latencies, and produce order-independent cache keys', () => {
  const graph = new ProcessingGraphEngine();
  const baseNode: ProcessingNodeSpec = {
    id: 'n1',
    type: 'EQ_FILTER',
    version: '1.0',
    enabled: true,
    latencySamples: -50,
    preRollSamples: Number.NaN,
    tailSamples: -10,
    committedParameters: { gainDb: 2, freqHz: 1000 },
  };

  // Duplicate node IDs throw explicit DUPLICATE_GRAPH_NODE_ID instead of false cycle error
  assert.throws(
    () => graph.compileGraph([baseNode, { ...baseNode }], [], 48_000, ['h1']),
    /DUPLICATE_GRAPH_NODE_ID/,
  );

  // Negative/NaN latency & preRoll sanitized to 0
  const safePlan = graph.compileGraph([baseNode], [], 48_000, ['h1']);
  assert.equal(safePlan.totalGraphLatencySamples, 0);
  assert.equal(safePlan.requiredPreRollSamples, 0);
  assert.equal(safePlan.requiredTailSamples, 0);
  const feed = graph.computeChunkFeedWindow(-100, -50, safePlan);
  assert.equal(feed.diskReadStartSample, 0);
  assert.equal(feed.diskReadEndSample, 0);

  // Reordered edges and reordered parameter keys produce identical deterministicCacheKey
  const nA: ProcessingNodeSpec = {
    id: 'src',
    type: 'TRACK_SOURCE',
    version: '1.0',
    enabled: true,
    latencySamples: 0,
    preRollSamples: 0,
    tailSamples: 0,
    committedParameters: { b: 2, a: 1 },
  };
  const nB: ProcessingNodeSpec = {
    id: 'eq',
    type: 'EQ_FILTER',
    version: '1.0',
    enabled: true,
    latencySamples: 16,
    preRollSamples: 64,
    tailSamples: 0,
    committedParameters: { q: 1.4, freq: 800 },
  };
  const nC: ProcessingNodeSpec = {
    id: 'lim',
    type: 'MASTER_LIMITER',
    version: '1.0',
    enabled: true,
    latencySamples: 32,
    preRollSamples: 64,
    tailSamples: 0,
    committedParameters: { ceiling: -1 },
  };
  const plan1 = graph.compileGraph(
    [nA, nB, nC],
    [
      { fromNodeId: 'src', toNodeId: 'eq' },
      { fromNodeId: 'eq', toNodeId: 'lim' },
    ],
    48_000,
    ['asset1'],
  );
  const plan2 = graph.compileGraph(
    [
      { ...nA, committedParameters: { a: 1, b: 2 } },
      { ...nB, committedParameters: { freq: 800, q: 1.4 } },
      nC,
    ],
    [
      { fromNodeId: 'eq', toNodeId: 'lim' },
      { fromNodeId: 'src', toNodeId: 'eq' },
    ],
    48_000,
    ['asset1'],
  );
  assert.equal(plan1.deterministicCacheKey, plan2.deterministicCacheKey);

  // MerkleDagCacheManager must never store undefined hash when bypassed node's parent is missing
  const cache = new MerkleDagCacheManager<string>();
  const hashes = cache.computePerNodeMerkleHashes({
    topologicalOrder: ['eq'], // parent 'src' intentionally omitted
    nodes: [nA, { ...nB, enabled: false }],
    edges: [{ fromNodeId: 'src', toNodeId: 'eq' }],
    sampleRate: 48_000,
    channelCount: 2,
    runtimeBackend: 'WASM',
    sourceAssetContentHashes: ['asset1'],
  });
  const eqHash = hashes.get('eq');
  assert.equal(typeof eqHash, 'string');
  assert.ok(eqHash && eqHash.startsWith('mkl_'));
});

test('TimelineTransactionEngine & PostEditValidationEngine clear stale ephemeral state and guard NaN ranges/fades', () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const doc: ProjectDocument = {
    projectId: 'p-pass9',
    name: 'Pass 9',
    canonicalSampleRate: 48_000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0',
      activeModelBundleVersion: 'fa-v1',
    },
    revision: 1,
    tracks: [
      {
        id: 't1',
        name: 'Host',
        syncGroupId: null,
        speakerId: 'host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'a1',
            sourceRange: { start: 0, end: s(5) },
            timelineRange: { start: 0, end: s(5) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [
      {
        id: 'rec-neg-rt',
        targetTrackId: 't1',
        disfluencyType: 'INDEPENDENT_FILLER',
        associatedText: 'اممم',
        spliceDescriptor: {
          rawAiRange: { start: s(1), end: s(2) },
          snappedAcousticRange: { start: s(1), end: s(2) },
          fadeInDurationFlicks: Number.NaN,
          fadeOutDurationFlicks: -100,
          injectRoomToneFlicks: Number.NaN,
          cutStrategy: 'GLOBAL_SYNC_RIPPLE',
          prosodicWarnings: [],
          confidence: 0.9,
        },
        status: 'PENDING',
        createdAtProjectRevision: 1,
      },
    ],
  };

  const txEngine = new TimelineTransactionEngine(doc);
  // Start an uncommitted ephemeral gesture then apply a smart splice: stale ephemeralDoc must be cleared
  txEngine.beginEphemeralGesture('gain-drag');
  txEngine.updateEphemeralGesture((draft) => {
    draft.tracks[0].clips[0] = { ...draft.tracks[0].clips[0], gainDb: -12 };
  });
  txEngine.applySmartSpliceRecommendation('rec-neg-rt', { start: 0, end: s(0.5) });
  assert.equal(txEngine.getActiveState().tracks[0].clips.length, 2);
  assert.equal(txEngine.getActiveState().tracks[0].clips[0].gainDb, 0);
  assert.equal(Number.isFinite(txEngine.getActiveState().tracks[0].clips[0].fadeOutFlicks), true);

  // PostEditValidationEngine catches NaN fades/gain/range and autoHealTimelineIssues sanitizes them cleanly
  const corruptedDoc: ProjectDocument = {
    ...doc,
    tracks: [
      {
        ...doc.tracks[0],
        clips: [
          {
            ...doc.tracks[0].clips[0],
            id: 'c-bad-nan',
            timelineRange: { start: 0, end: Number.NaN },
          },
          {
            ...doc.tracks[0].clips[0],
            id: 'c-a',
            timelineRange: { start: 0, end: s(1) },
            fadeInFlicks: Number.NaN,
            fadeOutFlicks: Number.NaN,
            gainDb: Number.NaN,
          },
          {
            ...doc.tracks[0].clips[0],
            id: 'c-b',
            timelineRange: { start: s(1), end: s(2) },
            fadeInFlicks: Number.NaN,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
  };

  const preCheck = PostEditValidationEngine.validateProjectTimeline(corruptedDoc);
  assert.equal(preCheck.isValid, false);
  const codes = new Set(preCheck.issues.map((i) => i.issueCode));
  assert.equal(codes.has('ORPHAN_MICRO_SLIVER_CLIP'), true);
  assert.equal(codes.has('MISSING_BOUNDARY_MICRO_FADE'), true);

  const healed = PostEditValidationEngine.autoHealTimelineIssues(corruptedDoc);
  assert.equal(healed.tracks[0].clips.length, 2);
  for (const clip of healed.tracks[0].clips) {
    assert.equal(Number.isFinite(clip.fadeInFlicks) && clip.fadeInFlicks > 0, true);
    assert.equal(Number.isFinite(clip.fadeOutFlicks) && clip.fadeOutFlicks > 0, true);
    assert.equal(Number.isFinite(clip.gainDb), true);
  }
  const postCheck = PostEditValidationEngine.validateProjectTimeline(healed);
  assert.equal(postCheck.isValid, true);
});

test('StreamingPlaybackPumpController isolates per-track gain automation from earlier tracks and resists short/NaN PCM reads', async () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const doc: ProjectDocument = {
    projectId: 'p-pump-isolation',
    name: 'Pump Isolation',
    canonicalSampleRate: 48_000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0',
      activeModelBundleVersion: 'fa-v1',
    },
    revision: 1,
    tracks: [
      {
        id: 'trk_voice',
        name: 'Voice',
        syncGroupId: null,
        speakerId: 'host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c_voice',
            trackId: 'trk_voice',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_voice',
            sourceRange: { start: 0, end: s(1) },
            timelineRange: { start: 0, end: s(1) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
      {
        id: 'trk_music',
        name: 'Music',
        syncGroupId: null,
        speakerId: null,
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c_music',
            trackId: 'trk_music',
            kind: 'AUDIO_ASSET',
            assetId: 'asset_music',
            sourceRange: { start: 0, end: s(1) },
            timelineRange: { start: 0, end: s(1) },
            fadeInFlicks: 0,
            fadeOutFlicks: 0,
            gainDb: 0,
          },
        ],
      },
    ],
    recommendations: [],
  };

  const ring = new SharedAudioRingBuffer(16_384, 2);
  ring.setPlaying(true);

  const pump = new StreamingPlaybackPumpController(doc, ring, {
    readAssetSourceSamples: async (assetId, _start, count) => {
      if (assetId === 'asset_voice') {
        const buf = new Float32Array(count).fill(0.5);
        buf[5] = Number.NaN; // must not poison output
        return [buf, buf];
      }
      // Return slightly shorter music buffer to verify short-read safety
      const shortLen = Math.max(1, count - 10);
      return [new Float32Array(shortLen).fill(0.4), new Float32Array(shortLen).fill(0.4)];
    },
  });

  // Heavy -40 dB ducking automation ONLY on trk_music -> trk_voice must remain ~0.5, NOT ducked!
  pump.updateActiveTimelineSnapshot(doc, [
    {
      laneId: 'lane_duck_music',
      targetNodeOrTrackId: 'trk_music',
      parameterName: 'GAIN_DB',
      defaultValue: 0,
      keyframes: [
        { timeFlicks: 0, value: -40, curveToNext: 'LINEAR' },
        { timeFlicks: s(1), value: -40, curveToNext: 'LINEAR' },
      ],
    },
  ]);

  await pump.pumpSingleChunk();
  const outL = new Float32Array(4096);
  const outR = new Float32Array(4096);
  assert.equal(ring.pull([outL, outR], 4096), true);

  for (let i = 0; i < outL.length; i++) {
    assert.equal(Number.isFinite(outL[i]), true);
    assert.equal(Number.isFinite(outR[i]), true);
  }
  // Expected: voice (0.5) + music (0.4 * 10^(-40/20) = 0.004) = 0.504
  assert.ok(
    Math.abs(outL[100] - 0.504) < 0.01,
    `Expected ~0.504 (voice untouched + ducked music), got ${outL[100]}`,
  );
});

test('StreamingExportEncoderWorker & DawTimelineInterchangeExporter resist zero chunkFrames, invalid FLAC blockSize, and NaN chapter/clip metadata', async () => {
  // 1. buildId3v2Tag with NaN chapter timestamps must sanitize to finite non-negative ms
  const { normalizedChapters } = buildId3v2Tag({
    title: 'پادکست آزمایشی',
    chapters: [
      {
        id: 'ch-nan',
        titleFa: 'فصل اول',
        startMs: Number.NaN,
        endMs: Number.NaN,
        startFlicks: Number.NaN,
        endFlicks: Number.NaN,
      },
    ],
  });
  assert.equal(normalizedChapters[0].startMs, 0);
  assert.equal(normalizedChapters[0].endMs, 0);

  // 2. exportPcmToCompleteBuffer with flacBlockSize=0 and chunkFrames=0 must not hang
  const pcm = new Float32Array(256).fill(0.1);
  pcm[3] = Number.NaN;
  const flacOut = await exportPcmToCompleteBuffer(
    [pcm],
    {
      format: 'FLAC',
      sampleRate: 48_000,
      channels: 1,
      flacBlockSize: 0,
    },
    { title: 'FLAC Test', chapters: [] },
    0, // chunkFrames <= 0 must clamp safely
  );
  assert.ok(flacOut.bytes.byteLength > 42);
  assert.equal(flacOut.report.totalFramesWritten, 256);

  // 3. DawTimelineInterchangeExporter never emits "NaN" or "Infinity" in .sesx or .rpp
  const corruptedDoc: ProjectDocument = {
    projectId: 'daw-nan-test',
    name: 'پروژه تست',
    canonicalSampleRate: 0 as unknown as 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.0',
      activeModelBundleVersion: 'fa-v1',
    },
    revision: 1,
    tracks: [
      {
        id: 't1',
        name: 'گوینده',
        syncGroupId: null,
        speakerId: 'host',
        muted: false,
        solo: false,
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            kind: 'AUDIO_ASSET',
            assetId: 'a1',
            sourceRange: { start: Number.NaN, end: Number.NaN },
            timelineRange: { start: Number.NaN, end: Number.NaN },
            fadeInFlicks: Number.NaN,
            fadeOutFlicks: Number.NaN,
            gainDb: Number.NaN,
          },
        ],
      },
    ],
    recommendations: [],
  };
  const sesx = DawTimelineInterchangeExporter.exportToAdobeAuditionSesx(corruptedDoc, { a1: 'host.wav' });
  const rpp = DawTimelineInterchangeExporter.exportToReaperRpp(corruptedDoc, { a1: 'host.wav' }, Number.NaN);
  assert.equal(sesx.includes('NaN'), false);
  assert.equal(sesx.includes('Infinity'), false);
  assert.equal(rpp.includes('NaN'), false);
  assert.equal(rpp.includes('Infinity'), false);
});

test('PriorityWorkerPoolDispatcher, LiveMarkerAndAnnotationManager, SpeechReconstructionAndWatermarkEngine, and AcousticTranslationSimulatorEngine resist out-of-range and NaN inputs', async () => {
  // 1. PriorityWorkerPoolDispatcher clamps invalid priority index without crashing
  const pool = new PriorityWorkerPoolDispatcher(
    'DESKTOP_STUDIO',
    () => async (_type, payload) => payload,
    { hardwareConcurrencyOverride: Number.NaN, maxQueuedTasksBeforeBackpressure: -5 },
  );
  const taskRes = await pool.dispatchTask({
    taskId: 't-bad-prio',
    priority: 99 as unknown as WorkerTaskPriority,
    taskType: 'ECHO',
    payload: 'ok',
  });
  assert.equal(taskRes, 'ok');

  // 2. LiveMarkerAndAnnotationManager clamps oversized injectedRoomToneFlicks and ignores NaN ranges
  const markerMgr = new LiveMarkerAndAnnotationManager();
  const m1 = markerMgr.addLiveMarkerWithReactionCompensation({
    rawTriggerFlicks: Number.NaN,
    category: 'EDIT_MISTAKE_FLAG',
    noteFa: 'تپق اول',
    humanReactionLookbackMs: Number.NaN,
  });
  assert.equal(m1.timelineFlicks, 0);

  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  markerMgr.addLiveMarkerWithReactionCompensation({
    rawTriggerFlicks: s(5),
    category: 'CHAPTER_BOUNDARY',
    noteFa: 'فصل دوم',
    humanReactionLookbackMs: 0,
  });
  // Cut [1s..2s] with huge injectedRoomToneFlicks=10s must clamp room tone to cutDuration (1s) so netShiftLeft=0 (never shifts marker right to 14s!)
  const afterCut = markerMgr.applyRippleCutToMarkers({ start: s(1), end: s(2) }, s(10));
  const chMarker = afterCut.find((m) => m.category === 'CHAPTER_BOUNDARY')!;
  assert.equal(chMarker.timelineFlicks, s(5));

  // 3. SpeechReconstructionAndWatermarkEngine preserves watermark detection and 4-band matching despite NaN samples
  const sr = 48_000 as const;
  const refVoice = new Float32Array(2048).fill(0.15);
  refVoice[10] = Number.NaN;
  const punchVoice = new Float32Array(2048).fill(0.12);
  punchVoice[20] = Number.NaN;
  const roomTone = new Float32Array(512).fill(0.01);
  roomTone[0] = Number.NaN;

  const matched = SpeechReconstructionAndWatermarkEngine.matchPunchInClipToStudioContext(
    refVoice,
    punchVoice,
    roomTone,
    sr,
  );
  for (let i = 0; i < matched.matchedClipPcm.length; i++) {
    assert.equal(Number.isFinite(matched.matchedClipPcm[i]), true);
  }
  for (const g of matched.appliedBandGainsDb) {
    assert.equal(Number.isFinite(g), true);
  }

  const wmBuf = new Float32Array(4096);
  SpeechReconstructionAndWatermarkEngine.embedSyntheticProvenanceWatermarkInPlace(wmBuf, sr);
  wmBuf[100] = Number.NaN; // single NaN sample must not break 4th-order HPF detector
  const wmDetect = SpeechReconstructionAndWatermarkEngine.detectSyntheticProvenanceWatermark(wmBuf, sr);
  assert.equal(wmDetect.isWatermarked, true);
  assert.equal(Number.isFinite(wmDetect.correlationConfidence), true);

  // 4. AcousticTranslationSimulatorEngine handles NaN samples and mismatched channel lengths across all profiles
  const simL = new Float32Array(512).fill(0.2);
  simL[5] = Number.NaN;
  const simR = new Float32Array(256).fill(0.2);
  for (const profile of [
    'STUDIO_FLAT_BYPASS',
    'SMARTPHONE_MONO_SPEAKER',
    'LAPTOP_SMALL_SPEAKERS',
    'CAR_CABIN_IN_TRAFFIC',
  ] as const) {
    const [outL, outR] = AcousticTranslationSimulatorEngine.simulateListeningEnvironment(
      [simL, simR],
      0 as unknown as 48000,
      profile,
    );
    assert.equal(outL.length, 256);
    assert.equal(outR.length, 256);
    for (let i = 0; i < 256; i++) {
      assert.equal(Number.isFinite(outL[i]), true);
      assert.equal(Number.isFinite(outR[i]), true);
    }
  }
});

test('AntiAliasedResampler, MultiSpeakerDiarizationAndCrosstalkEngine, NonVerbalVocalEventDetector, and PersianCtcForcedAligner resist NaN inputs and mismatched buffers', async () => {
  // 1. AntiAliasedResampler handles taps=1, mismatched channel lengths, and NaN samples
  const resampler = new AntiAliasedResampler(48000, 16000, 1);
  const ch0 = new Float32Array(480).fill(0.25);
  ch0[10] = Number.NaN;
  const ch1 = new Float32Array(240).fill(0.25);
  const resampled = resampler.processToMono16k([ch0, ch1]);
  assert.equal(resampled.length, 80);
  for (let i = 0; i < resampled.length; i++) {
    assert.equal(Number.isFinite(resampled[i]), true);
  }

  // 2. MultiSpeakerDiarizationAndCrosstalkEngine handles NaN samples and embeddings
  const trackA = new Float32Array(4800).fill(0.2);
  trackA[5] = Number.NaN;
  const trackB = new Float32Array(4800).fill(0.02);
  trackB[15] = Number.POSITIVE_INFINITY;
  const diarSegs = MultiSpeakerDiarizationAndCrosstalkEngine.analyzeMultiTrackCrosstalkAndOverlap(
    [
      { trackId: 't1', speakerId: 'HOST', pcmMono: trackA },
      { trackId: 't2', speakerId: 'GUEST', pcmMono: trackB },
    ],
    48000,
    Number.NaN,
  );
  assert.equal(diarSegs.length > 0, true);
  for (const seg of diarSegs) {
    assert.equal(Number.isFinite(seg.confidence), true);
  }

  const embSegs = MultiSpeakerDiarizationAndCrosstalkEngine.assignSpeakersFromEmbeddings(
    't1',
    [
      {
        range: { start: 0, end: 1000 },
        embeddingVector: new Float32Array([0.8, Number.NaN, 0.6]),
        vadProbability: 0.9,
      },
      {
        range: { start: 1000, end: 2000 },
        embeddingVector: new Float32Array([0.8, 0.1]),
        vadProbability: 0.85,
      },
    ],
    Number.NaN,
  );
  assert.equal(embSegs.length > 0, true);
  assert.equal(Number.isFinite(embSegs[0].confidence), true);

  // 3. NonVerbalVocalEventDetector resists NaN sampleRate, out-of-bounds token ranges, and NaN PCM samples
  const nvPcm = new Float32Array(4000).fill(0.05);
  nvPcm[100] = Number.NaN;
  const nvEvents = NonVerbalVocalEventDetector.detectNonVerbalEventsInGaps(
    nvPcm,
    [
      {
        tokenId: 'tok1',
        trackId: 't1',
        originalText: 'سلام',
        normalizedText: 'سلام',
        displayText: 'سلام',
        range: { start: TimeMath.secondsToFlicks(10), end: TimeMath.secondsToFlicks(12) },
        confidence: 0.9,
        isDisfluency: false,
      },
    ],
    0 as unknown as 16000,
  );
  assert.equal(Array.isArray(nvEvents), true);

  const detailedScan = await NonVerbalVocalEventDetector.detectDetailedNonVerbalEvents({
    pcmMono: nvPcm,
    tokens: [
      {
        tokenId: 'tok-nan',
        trackId: 't1',
        originalText: 'تست',
        normalizedText: 'تست',
        displayText: 'تست',
        range: { start: Number.NaN, end: Number.NaN },
        confidence: 0.9,
        isDisfluency: false,
      },
    ],
    sampleRate: Number.NaN as unknown as 16000,
    offsetSeconds: Number.NaN,
  });
  assert.equal(Array.isArray(detailedScan.events), true);

  // 4. PersianCtcForcedAligner handles NaN emission log-probabilities without NaN confidence or ranges
  const vocab = new Map<string, number>([
    ['س', 1],
    ['ل', 2],
    ['ا', 3],
    ['م', 4],
  ]);
  const frames: Float32Array[] = Array.from({ length: 8 }, () => {
    const f = new Float32Array(5).fill(-1.5);
    f[1] = Number.NaN;
    return f;
  });
  const aligned = PersianCtcForcedAligner.alignPersianWordsAndCharacters(
    frames,
    vocab,
    [{ id: 'w1', text: 'سلام' }],
    0.02,
    Number.NaN,
  );
  assert.equal(aligned.words.length, 1);
  assert.equal(Number.isFinite(aligned.words[0].alignedRange.start), true);
  assert.equal(Number.isFinite(aligned.words[0].alignedRange.end), true);
  assert.equal(Number.isFinite(aligned.words[0].acousticConfidence), true);
});

test('AudioCrossfadeProcessor, AudioBoundaryProcessor, and AsrWindowReconciler resist NaN samples and malformed timestamps', () => {
  // 1. AudioCrossfadeProcessor
  const gains = AudioCrossfadeProcessor.computeGainPair('equal-power', Number.NaN);
  assert.equal(Number.isFinite(gains.fadeOutGain), true);
  assert.equal(Number.isFinite(gains.fadeInGain), true);

  const leftTail = [new Float32Array([0.5, Number.NaN, 0.3, 0.2, 0.1, 0.05])];
  const rightHead = [new Float32Array([0.05, 0.1, Number.POSITIVE_INFINITY, 0.3, 0.4, 0.5])];
  const xf = AudioCrossfadeProcessor.blendTransition({
    transitionIndex: 0,
    proposalId: 'p1',
    leftTail,
    rightHead,
    preferredCurve: 'auto',
  });
  assert.equal(Number.isFinite(xf.result.correlationCoefficient), true);
  assert.equal(Number.isFinite(xf.result.peakAfterLimit), true);
  for (let i = 0; i < xf.blended[0].length; i++) {
    assert.equal(Number.isFinite(xf.blended[0][i]), true);
  }

  // 2. AudioBoundaryProcessor with NaN samples and mismatched channel lengths
  const bLeft0 = new Float32Array(64).fill(0.1);
  bLeft0[63] = Number.NaN;
  const bLeft1 = new Float32Array(48).fill(0.1);
  const bRight0 = new Float32Array(64).fill(-0.1);
  const bRight1 = new Float32Array(48).fill(-0.1);
  const boundary = AudioBoundaryProcessor.evaluateAndRefineJunction({
    transitionIndex: 0,
    proposalId: 'p1',
    sampleRate: Number.NaN as unknown as 48000,
    originalLeftSample: 1000,
    originalRightSample: 2000,
    leftWindow: [bLeft0, bLeft1],
    rightWindow: [bRight0, bRight1],
    preserveTotalLength: true,
    leftPostWindow: [new Float32Array(16)], // fewer channels than leftWindow
    rightPreWindow: [new Float32Array(16)],
    maxAdjustmentSamples: Number.NaN,
    maxLeftPullbackSamples: 10,
    maxRightAdvanceSamples: 10,
  });
  assert.equal(Number.isFinite(boundary.leftRmsDb), true);
  assert.equal(Number.isFinite(boundary.rightRmsDb), true);
  assert.equal(Number.isFinite(boundary.discontinuityJump), true);

  // 3. AsrWindowReconciler rejects NaN relative timestamps gracefully without throwing RangeError
  const wins = buildAsrWindowMappings({
    totalSourceSamples: 48000 * 30,
    sourceSampleRate: 48000,
  });
  const mappedNan = mapWindowTokenToSourceRange(
    wins[0],
    Number.NaN as unknown as AsrWindowRelativeSec,
    1.0 as unknown as AsrWindowRelativeSec,
  );
  assert.equal(mappedNan.valid, false);
});

test('PersianProsodyAndPacingAnalyzer, PersianPodcastTeaserGeneratorEngine, PersianChapterAndTopicSegmenter, PersianProsodicPunctuationRestorer, and PersianShowNotesAndTextRankEngine resist NaN ranges and invalid sample rates', () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const tokens = Array.from({ length: 18 }, (_, i) => ({
    tokenId: `t_${i}`,
    trackId: 'tr1',
    originalText: i === 0 ? 'چرا' : i === 1 ? 'دکتر' : i === 2 ? 'حسینی' : 'نکته عجیب',
    normalizedText: i === 0 ? 'چرا' : i === 1 ? 'دکتر' : i === 2 ? 'حسینی' : 'نکته عجیب',
    displayText: i === 0 ? 'چرا' : i === 1 ? 'دکتر' : i === 2 ? 'حسینی' : 'نکته عجیب',
    range: { start: s(i * 0.8), end: s(i * 0.8 + 0.6) },
    confidence: 0.92,
  }));
  const badToken = {
    tokenId: 't_nan',
    trackId: 'tr1',
    originalText: 'خراب',
    normalizedText: 'خراب',
    displayText: 'خراب',
    range: { start: Number.NaN, end: Number.NaN },
    confidence: 0.5,
  };
  const mixedTokens = [...tokens, badToken];

  const pcm = new Float32Array(16000 * 16).fill(0.1);
  pcm[50] = Number.NaN;

  // 1. PersianProsodyAndPacingAnalyzer
  const prosody = PersianProsodyAndPacingAnalyzer.analyzeComprehensiveProsody(
    mixedTokens,
    pcm,
    16000,
    undefined,
    { windowDurationSec: 0, offsetSeconds: Number.NaN },
  );
  assert.equal(Number.isFinite(prosody.totalSpeakingRateWpm), true);
  assert.equal(Number.isFinite(prosody.netArticulationRateWpm), true);
  assert.equal(Number.isFinite(prosody.phraseRhythmCv), true);

  // 2. PersianPodcastTeaserGeneratorEngine
  const hooks = PersianPodcastTeaserGeneratorEngine.findBestColdOpenTeaserHooks(
    mixedTokens,
    pcm,
    0 as unknown as 16000,
    Number.NaN,
  );
  assert.equal(hooks.length > 0, true);
  for (const h of hooks) {
    assert.equal(Number.isFinite(h.combinedTeaserScore), true);
    assert.equal(Number.isFinite(h.acousticExcitementScore), true);
  }

  // 3. PersianChapterAndTopicSegmenter
  const chapters = PersianChapterAndTopicSegmenter.generateChapters(mixedTokens, Number.NaN);
  assert.equal(chapters.length > 0, true);
  for (const ch of chapters) {
    assert.equal(ch.startTimestampFormatted.includes('NaN'), false);
  }

  // 4. PersianProsodicPunctuationRestorer
  const punctuated = PersianProsodicPunctuationRestorer.restorePunctuationInDisplayLayer(
    mixedTokens,
    pcm,
    0 as unknown as 16000,
  );
  assert.equal(punctuated.length, mixedTokens.length);

  // 5. PersianShowNotesAndTextRankEngine
  const takeaways = PersianShowNotesAndTextRankEngine.extractTopKeyTakeaways(mixedTokens, 3);
  assert.equal(takeaways.length > 0, true);
  assert.equal(takeaways[0].timestampFormatted.includes('NaN'), false);

  const entities = PersianShowNotesAndTextRankEngine.extractNamedEntitiesWithTimestamps(mixedTokens);
  assert.equal(entities.length > 0, true);
  assert.equal(entities[0].firstMentionTimestamp.includes('NaN'), false);
});

test('AudioExportWriter resists NaN sampleCount and out-of-bounds short planar channel buffers without writing undefined as NaN', async () => {
  const sink = new BoundedChunkedByteSink();
  const writer = new AudioExportWriter({
    renderId: 'r-test',
    artifactId: 'a-test',
    container: 'wav',
    encoding: 'float32',
    sampleRate: 48000,
    channelCount: 2,
    sink,
  });
  await writer.begin();
  // NaN sampleCount must be ignored safely
  await writer.writePlanarChunk([new Float32Array(4), new Float32Array(4)], Number.NaN);
  assert.equal(writer.getWrittenSamples(), 0);

  // Short second channel must zero-pad missing tail samples rather than writing undefined -> NaN
  await writer.writePlanarChunk(
    [new Float32Array([0.25, 0.5, 0.75, 0.1]), new Float32Array([0.25, 0.5])],
    4,
  );
  const meta = await writer.finalize();
  assert.equal(meta.totalOutputSamples, 4);
  assert.equal(meta.nonFiniteSampleCount, 0);
});

test('PersianDisfluencyEngine, PersianSemanticRepetitionEngine, PersianPhoneticTranscriptSearchEngine, and PersianChunkedAsrEngine resist NaN ranges, confidences, and thresholds', async () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const tokens = [
    {
      tokenId: 'd1',
      trackId: 'tr1',
      originalText: 'اممم',
      normalizedText: 'اممم',
      displayText: 'اممم',
      range: { start: s(0), end: s(0.4) },
      confidence: Number.NaN,
    },
    {
      tokenId: 'd2',
      trackId: 'tr1',
      originalText: 'من',
      normalizedText: 'من',
      displayText: 'من',
      range: { start: s(0.6), end: s(0.9) },
      confidence: Number.NaN,
    },
    {
      tokenId: 'd3',
      trackId: 'tr1',
      originalText: 'من',
      normalizedText: 'من',
      displayText: 'من',
      range: { start: s(1.1), end: s(1.4) },
      confidence: 0.9,
    },
    {
      tokenId: 'd4',
      trackId: 'tr1',
      originalText: 'تست',
      normalizedText: 'تست',
      displayText: 'تست',
      range: { start: Number.NaN, end: Number.NaN },
      confidence: Number.NaN,
    },
  ];

  // 1. PersianDisfluencyEngine
  const issues = PersianDisfluencyEngine.analyzeTranscript(tokens, Number.NaN, Number.NaN);
  assert.equal(issues.length >= 2, true);
  for (const iss of issues) {
    assert.equal(Number.isFinite(iss.compositeConfidence), true);
    assert.equal(Number.isFinite(iss.targetRange.start), true);
    assert.equal(Number.isFinite(iss.targetRange.end), true);
  }
  const detailed = PersianDisfluencyEngine.analyzeSpeechDisfluenciesDetailed(tokens, {
    hasAcousticEvidence: true,
  });
  assert.equal(detailed.length >= 1, true);
  for (const det of detailed) {
    assert.equal(det.modelTokenConfidence === null || Number.isFinite(det.modelTokenConfidence), true);
    assert.equal(Number.isFinite(det.linguisticScore), true);
  }

  // 2. PersianSemanticRepetitionEngine
  const pcmWithNan = new Float32Array(16000 * 3).fill(0.2);
  pcmWithNan[100] = Number.NaN;
  const wordReps = PersianSemanticRepetitionEngine.classifyWordRepetitionsDetailed(tokens, {
    pcmMono: pcmWithNan,
    sampleRate: 16000,
  });
  assert.equal(wordReps.length, 1);
  assert.equal(Number.isFinite(wordReps[0].temporalSeparationMs), true);
  assert.equal(
    wordReps[0].acousticEnergyRatio !== null && Number.isFinite(wordReps[0].acousticEnergyRatio),
    true,
  );

  // 3. PersianPhoneticTranscriptSearchEngine with maxResults = NaN and NaN token ranges
  const searchEngine = new PersianPhoneticTranscriptSearchEngine();
  searchEngine.indexTranscript(tokens);
  const hits = searchEngine.searchPhrase('من', Number.NaN);
  assert.equal(hits.length, 2);
  for (const h of hits) {
    assert.equal(Number.isFinite(h.audioRange.start), true);
    assert.equal(Number.isFinite(h.audioRange.end), true);
  }

  // 4. PersianChunkedAsrEngine resists NaN prediction relativeStartSec / probability
  const asr = new PersianChunkedAsrEngine({
    modelId: 'fa-test',
    modelVersion: '1.0',
    detectVoiceActivity: async () => ({ hasSpeech: true, speechRatio: 0.8 }),
    transcribeWindow: async () => [
      {
        word: 'سلام',
        relativeStartSec: Number.NaN,
        relativeEndSec: Number.NaN,
        probability: Number.NaN,
      },
    ],
  });
  const transcribed = await asr.transcribeLongAudioStream(
    16000 * 2,
    async (_start, count) => new Float32Array(count),
    async () => {},
    Number.NaN,
  );
  assert.equal(transcribed.length, 1);
  assert.equal(Number.isFinite(transcribed[0].range.start), true);
  assert.equal(Number.isFinite(transcribed[0].range.end), true);
  assert.equal(Number.isFinite(transcribed[0].confidence), true);
});

test('AudioRenderPlanner and AudioRenderValidator resist NaN crossfade config and NaN maxAllowedClippedSamples', async () => {
  const edl: EditDecisionListSnapshot = {
    edlId: 'edl_p13',
    edlSchemaVersion: '1.0.0',
    edlVersion: 1,
    projectId: 'proj_p13',
    sourceAudioId: 'src_p13',
    sourceAudioHash: 'hash_p13',
    transcriptVersion: 'tv1',
    timebaseFlicksPerSecond: 705600000,
    sampleRate: 48000,
    totalSourceSamples: 48000,
    eventSourceVersions: {
      eventDetectorVersion: '1.0',
      decisionEngineVersion: '1.0',
      lexiconVersion: '1.0',
      thresholdConfigVersion: '1.0',
      modelVersions: {},
    },
    proposals: [],
    conflicts: [],
    validation: {
      isValid: true,
      status: 'VALID',
      errorCount: 0,
      warningCount: 0,
      failures: [],
    },
    decisionHistory: [],
    createdAtMs: 1000,
    modifiedAtMs: 1000,
    cancelled: false,
    processedEventCount: 0,
    totalInputEventCount: 0,
    persistenceStatus: 'IN_MEMORY_ONLY',
    persistenceNote: 'test',
  };

  const planRes = AudioRenderPlanner.buildPlan({
    edl,
    sourceAudioId: 'src_p13',
    sourceAudioHash: 'hash_p13',
    sourceSampleRate: 48000,
    channelCount: 1,
    totalSourceSamples: 48000,
    expectedSourceAudioHash: 'hash_p13',
    expectedTranscriptVersion: 'tv1',
    expectedEdlVersion: 1,
    config: {
      encoding: 'float32',
      container: 'wav',
      defaultCrossfadeMs: Number.NaN,
      maxBoundaryAdjustmentSamples: Number.NaN,
    },
  });
  assert.equal(planRes.ok, true);
  assert.ok(planRes.plan);

  // Write a float32 WAV with 1 clipped sample (+1.5) and validate with maxAllowedClippedSamples = NaN
  const sink = new BoundedChunkedByteSink();
  const writer = new AudioExportWriter({
    renderId: 'r_p13',
    artifactId: 'art_p13',
    container: 'wav',
    encoding: 'float32',
    sampleRate: 48000,
    channelCount: 1,
    sink,
  });
  await writer.begin();
  const chunk = new Float32Array(48000).fill(0.1);
  chunk[10] = 1.5; // clipped sample
  await writer.writePlanarChunk([chunk], 48000);
  const meta = await writer.finalize();

  const artifact = createCommittedRenderArtifact({
    sink,
    artifactId: meta.artifactId,
    sizeBytes: meta.fileSizeBytes,
  });
  const postReport = await AudioRenderValidator.validatePostRenderArtifact({
    plan: planRes.plan,
    outputMetadata: meta,
    artifact,
    maxAllowedClippedSamples: Number.NaN,
  });
  await artifact.dispose();
  assert.equal(postReport.passed, false);
  assert.equal(
    postReport.failures.some((f) => f.code === 'UNEXPECTED_CLIPPING'),
    true,
  );
});

test('CustomPersianLexiconManager, OnnxPersianAsrAndVadAdapter, and ScriptToAudioDeviationDetector resist NaN PCM samples, confidences, and thresholds', async () => {
  // 1. CustomPersianLexiconManager with NaN confidence and NaN uncertaintyThreshold
  const lex = new CustomPersianLexiconManager();
  lex.registerLexiconEntries([
    {
      entryId: 'lex1',
      canonicalDisplayForm: 'طالقانی',
      phoneticAliases: ['تالقانی'],
      category: 'PERSON_NAME',
    },
  ]);
  const toks = [
    {
      tokenId: 't1',
      trackId: 'tr1',
      originalText: 'تالقانی',
      normalizedText: 'تالقانی',
      displayText: 'تالقانی',
      range: { start: 0, end: 1000 },
      confidence: Number.NaN,
    },
    {
      tokenId: 't2',
      trackId: 'tr1',
      originalText: 'واژه',
      normalizedText: 'واژه',
      displayText: 'واژه',
      range: { start: 1000, end: 2000 },
      confidence: Number.NaN,
    },
  ];
  const suggestions = lex.findUncertainWordsAndSuggestCorrections(toks, Number.NaN);
  assert.equal(suggestions.length, 2);
  for (const s of suggestions) {
    assert.equal(Number.isFinite(s.asrConfidence), true);
    assert.equal(Number.isFinite(s.matchSimilarity), true);
  }

  // 2. OnnxPersianAsrAndVadAdapter resists NaN PCM samples in VAD and Log-Mel Spectrogram + NaN probs in CTC greedy decode
  const adapter = new OnnxPersianAsrAndVadAdapter();
  const pcm = new Float32Array(1600).fill(0.15);
  pcm[10] = Number.NaN;
  pcm[500] = Number.POSITIVE_INFINITY;
  const vad = await adapter.detectVoiceActivity(pcm);
  assert.equal(Number.isFinite(vad.speechRatio), true);

  const mel = adapter.computeLogMelSpectrogram(pcm);
  assert.equal(mel.numFrames > 0, true);
  for (let i = 0; i < mel.melTensor.length; i++) {
    assert.equal(Number.isFinite(mel.melTensor[i]), true);
  }

  const ctcWords = OnnxPersianAsrAndVadAdapter.greedyDecodeCtcToWords(
    [
      new Float32Array([0.1, Number.NaN, 0.85]),
      new Float32Array([0.1, 0.9, 0.05]),
    ],
    new Map([
      [1, 'م'],
      [2, 'س'],
    ]),
    Number.NaN,
  );
  assert.equal(ctcWords.length, 1);
  assert.equal(ctcWords[0].word, 'سم');
  assert.equal(Number.isFinite(ctcWords[0].relativeStartSec), true);
  assert.equal(Number.isFinite(ctcWords[0].relativeEndSec), true);
  assert.equal(Number.isFinite(ctcWords[0].probability), true);

  // 3. ScriptToAudioDeviationDetector sanitizes non-finite token ranges
  const devs = ScriptToAudioDeviationDetector.detectNarratorDeviations('سلام دنیا', [
    {
      tokenId: 'sp1',
      trackId: 'tr1',
      originalText: 'سلام',
      normalizedText: 'سلام',
      displayText: 'سلام',
      range: { start: Number.NaN, end: Number.NaN },
      confidence: 0.9,
    },
  ]);
  assert.equal(devs.length, 1);
  assert.equal(Number.isFinite(devs[0].audioRange.start), true);
  assert.equal(Number.isFinite(devs[0].audioRange.end), true);
});

test('AudioSourceReader, AudioSegmentAssembler, and AudioRenderEngine resist NaN chunkSizeSamples and cache options', async () => {
  const src = createPlanarArrayPcmSource({
    sourceAudioId: 'src_p14',
    sourceAudioHash: 'hash_p14',
    sampleRate: 48000,
    channels: [new Float32Array(4800).fill(0.1)],
  });
  const nanRead = await src.readPlanarRange(Number.NaN, Number.NaN);
  assert.equal(nanRead[0].length, 0);

  const reader = new AudioSourceReader(src, {
    cacheBlockSamples: Number.NaN,
    maxCacheBytes: Number.NaN,
  });
  const validSlice = await reader.readRange(0, 1024);
  assert.equal(validSlice[0].length, 1024);
  reader.dispose();

  const edl: EditDecisionListSnapshot = {
    edlId: 'edl_p14',
    edlSchemaVersion: '1.0.0',
    edlVersion: 1,
    projectId: 'proj_p14',
    sourceAudioId: 'src_p14',
    sourceAudioHash: 'hash_p14',
    transcriptVersion: 'tv1',
    timebaseFlicksPerSecond: 705600000,
    sampleRate: 48000,
    totalSourceSamples: 4800,
    eventSourceVersions: {
      eventDetectorVersion: '1.0',
      decisionEngineVersion: '1.0',
      lexiconVersion: '1.0',
      thresholdConfigVersion: '1.0',
      modelVersions: {},
    },
    proposals: [],
    conflicts: [],
    validation: {
      isValid: true,
      status: 'VALID',
      errorCount: 0,
      warningCount: 0,
      failures: [],
    },
    decisionHistory: [],
    createdAtMs: 1000,
    modifiedAtMs: 1000,
    cancelled: false,
    processedEventCount: 0,
    totalInputEventCount: 0,
    persistenceStatus: 'IN_MEMORY_ONLY',
    persistenceNote: 'test',
  };

  const engine = new AudioRenderEngine();
  const renderRes = await engine.render({
    edl,
    source: src,
    expectedSourceAudioHash: 'hash_p14',
    expectedTranscriptVersion: 'tv1',
    expectedEdlVersion: 1,
    config: {
      encoding: 'pcm16',
      container: 'wav',
      chunkSizeSamples: Number.NaN,
    },
  });
  assert.equal(renderRes.ok, true);
  assert.equal(renderRes.state, 'COMPLETED');
});

test('EditBoundaryRefiner, EditCandidateEvaluator, EditConflictResolver, and EditRiskEvaluator resist NaN confidences, noise floor, and sample bounds', () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);

  // 1. normalizeTokensToSampleSpans + EditBoundaryRefiner resist NaN token confidence & noiseFloorDbfs
  const spans = normalizeTokensToSampleSpans(
    [
      {
        tokenId: 'tok_nan',
        trackId: 'tr1',
        originalText: 'اممم',
        normalizedText: 'اممم',
        displayText: 'اممم',
        range: { start: s(0.2), end: s(0.6) },
        confidence: Number.NaN,
      },
    ],
    48000,
  );
  assert.equal(spans.length, 1);
  assert.equal(Number.isFinite(spans[0].confidence), true);

  const baseEvent: SpeechEvent = {
    eventId: 'ev_1',
    trackId: 'tr1',
    category: 'FILLER',
    subtype: 'VOCAL_FILLED_PAUSE',
    detectionState: 'DETECTED',
    uncertaintyState: 'LOW_UNCERTAINTY',
    detectionMethod: 'HYBRID_HEURISTIC_FUSION',
    startFlicks: s(0.2),
    endFlicks: s(0.6),
    durationFlicks: s(0.4),
    startSec: 0.2,
    endSec: 0.6,
    durationSec: 0.4,
    confidence: 0.9,
    scores: {
      acousticScore: 0.88,
      linguisticScore: 0.92,
      ruleEvidenceCount: 2,
      modelTokenConfidence: 0.85,
      combinedDecisionScore: 0.9,
      calibratedProbability: null,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      conflicts: [],
    },
    provenance: {
      engineVersion: '1.0',
      thresholdConfigVersion: '1.0',
      detectorModule: 'test',
      capabilityMode: 'heuristic',
    },
    relatedTokenIds: ['tok_nan'],
    relatedText: 'اممم',
    acousticEvidence: {
      noiseFloorDbfs: Number.NaN,
    },
    eligibleForEditSuggestion: true,
    requiresHumanReview: false,
    explanationFa: 'تپق',
  };

  const refined = EditBoundaryRefiner.refine({
    event: baseEvent,
    operation: 'REMOVE_FILLER',
    sampleRate: 48000,
    totalSourceSamples: 48000 * 2,
    tokenSpans: [
      {
        ...spans[0],
        confidence: Number.NaN,
      },
    ],
  });
  assert.equal(refined.valid, true);
  assert.equal(
    refined.boundaryConfidenceScore !== null && Number.isFinite(refined.boundaryConfidenceScore),
    true,
  );

  // 2. EditCandidateEvaluator rejects NaN event.confidence into INSUFFICIENT / review-required instead of auto-safe
  const nanConfEvent: SpeechEvent = {
    ...baseEvent,
    confidence: Number.NaN,
    durationSec: Number.NaN,
  };
  assert.equal(classifyEventConfidence(nanConfEvent), 'INSUFFICIENT');
  const evalFiller = EditCandidateEvaluator.evaluate(nanConfEvent);
  assert.equal(evalFiller.operation, 'NO_EDIT_RECOMMENDED');
  assert.equal(evalFiller.requiresHumanReview, true);

  // 3. EditRiskEvaluator flags NaN token confidence as MEDIUM word boundary uncertainty and sanitizes NaN overlappingEventCount
  const risk = EditRiskEvaluator.evaluate({
    event: baseEvent,
    operation: 'REMOVE_FILLER',
    boundary: refined,
    tokenSpans: [{ ...spans[0], confidence: Number.NaN }],
    overlappingEventCount: Number.NaN,
  });
  const wordDim = risk.dimensions.find((d) => d.dimension === 'WORD_BOUNDARY_UNCERTAINTY');
  const overlapDim = risk.dimensions.find((d) => d.dimension === 'OVERLAPPING_EVENT_RISK');
  assert.equal(wordDim?.level, 'MEDIUM');
  assert.equal(overlapDim?.level, 'LOW');

  // 4. EditConflictResolver pickHigherConfidenceWinner prefers finite 0.92 over NaN confidence
  const propA = {
    proposalId: 'prop_a',
    trackId: 'tr1',
    transcriptVersion: 'tv1',
    sampleRate: 48000,
    operation: 'REMOVE_FILLER',
    status: 'PROPOSED_FOR_REVIEW',
    requiresHumanReview: true,
    protectedEvent: false,
    eventCategory: 'FILLER',
    eventConfidenceScore: 0.92,
    speechEventSourceIds: ['ev_shared'],
    relatedTokenIds: [],
    conflictIds: [],
    originalRange: refined.originalInterval,
    proposedRange: refined.proposedInterval,
  } as unknown as EditProposal;

  const propB = {
    ...propA,
    proposalId: 'prop_b',
    eventConfidenceScore: Number.NaN,
  } as unknown as EditProposal;

  const resolved = EditConflictResolver.resolve({
    proposals: [propA, propB],
    expectedTranscriptVersion: 'tv1',
  });
  const winningA = resolved.proposals.find((p) => p.proposalId === 'prop_a');
  const supersededB = resolved.proposals.find((p) => p.proposalId === 'prop_b');
  assert.equal(winningA?.status, 'PROPOSED_FOR_REVIEW');
  assert.equal(supersededB?.status, 'SUPERSEDED');
});

test('SilenceAndPauseAnalyzer and SpeechEventEvidenceFusion resist NaN PCM samples, sampleRate, offsetSeconds, ruleEvidenceCount, and confidence', async () => {
  // 1. SilenceAndPauseAnalyzer with NaN sampleRate returns empty result cleanly
  const emptyRes = await SilenceAndPauseAnalyzer.analyzeSilenceAndPauses({
    pcmMono: new Float32Array(1600),
    sampleRate: Number.NaN as unknown as 16000,
  });
  assert.equal(emptyRes.detections.length, 0);

  // SilenceAndPauseAnalyzer with NaN PCM samples and NaN offsetSeconds detects silence without throwing in TimeMath.secondsToFlicks
  const silencePcm = new Float32Array(16000).fill(0);
  silencePcm[10] = Number.NaN;
  silencePcm[500] = Number.POSITIVE_INFINITY;
  const silRes = await SilenceAndPauseAnalyzer.analyzeSilenceAndPauses({
    pcmMono: silencePcm,
    sampleRate: 16000,
    offsetSeconds: Number.NaN,
    totalRecordingDurationSec: Number.NaN,
  });
  assert.equal(Number.isFinite(silRes.noiseFloorDbfs), true);
  assert.equal(silRes.detections.length > 0, true);
  for (const d of silRes.detections) {
    assert.equal(Number.isFinite(d.startSec), true);
    assert.equal(Number.isFinite(d.endSec), true);
    assert.equal(Number.isFinite(d.fullRange.start), true);
    assert.equal(Number.isFinite(d.fullRange.end), true);
    assert.equal(Number.isFinite(d.acousticScore), true);
  }

  // 2. SpeechEventEvidenceFusion resists NaN ruleEvidenceCount, NaN event.confidence, and NaN evaluation duration/IoU
  const fused = fuseSpeechEventEvidence({
    category: 'FILLER',
    acousticScore: 0.85,
    linguisticScore: 0.9,
    ruleEvidenceCount: Number.NaN,
    modelTokenConfidence: Number.NaN,
  });
  assert.equal(fused.scores.ruleEvidenceCount, 0);
  assert.equal(Number.isFinite(fused.decisionScore), true);

  const dummyEvent: SpeechEvent = {
    eventId: 'ev_nan_conf',
    trackId: 'tr1',
    category: 'FILLER',
    subtype: 'VOCAL_FILLED_PAUSE',
    detectionState: 'DETECTED',
    uncertaintyState: 'LOW_UNCERTAINTY',
    detectionMethod: 'HYBRID_HEURISTIC_FUSION',
    startFlicks: 0,
    endFlicks: 70560000,
    durationFlicks: 70560000,
    startSec: 0,
    endSec: 0.1,
    durationSec: 0.1,
    confidence: Number.NaN,
    scores: fused.scores,
    provenance: {
      engineVersion: '1.0',
      thresholdConfigVersion: '1.0',
      detectorModule: 'test',
      capabilityMode: 'heuristic',
    },
    relatedTokenIds: [],
    eligibleForEditSuggestion: true,
    requiresHumanReview: false,
    explanationFa: 'تپق',
  };
  const gated = applyPrecisionEligibilityAndThresholds(dummyEvent);
  assert.equal(gated.eligibleForEditSuggestion, false);
  assert.equal(gated.requiresHumanReview, true);

  const report = evaluateDetectedSpeechEvents({
    predicted: [gated],
    references: [
      {
        referenceId: 'ref1',
        category: 'FILLER',
        startSec: 0,
        endSec: 0.1,
        annotatorId: 'human-1',
      },
    ],
    totalAudioDurationSec: Number.NaN,
    minTemporalIou: Number.NaN,
  });
  assert.equal(Number.isFinite(report.totalAudioMinutes), true);
  assert.equal(Number.isFinite(report.falsePositivesPerMinute), true);
});

test('EditDecisionEngine and EditProvenance resist NaN batchSize, NaN event.confidence, and detect missing alignmentVersion staleness', async () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);
  const event: SpeechEvent = {
    eventId: 'ev_p16',
    trackId: 'tr1',
    category: 'FILLER',
    subtype: 'VOCAL_FILLED_PAUSE',
    detectionState: 'DETECTED',
    uncertaintyState: 'LOW_UNCERTAINTY',
    detectionMethod: 'HYBRID_HEURISTIC_FUSION',
    startFlicks: s(0.2),
    endFlicks: s(0.6),
    durationFlicks: s(0.4),
    startSec: 0.2,
    endSec: 0.6,
    durationSec: 0.4,
    confidence: Number.NaN,
    scores: {
      acousticScore: 0.88,
      linguisticScore: 0.9,
      ruleEvidenceCount: 2,
      modelTokenConfidence: 0.85,
      combinedDecisionScore: 0.89,
      calibratedProbability: null,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      conflicts: [],
    },
    provenance: {
      engineVersion: '1.0',
      thresholdConfigVersion: '1.0',
      detectorModule: 'test',
      capabilityMode: 'heuristic',
    },
    relatedTokenIds: [],
    relatedText: 'اممم',
    eligibleForEditSuggestion: true,
    requiresHumanReview: false,
    explanationFa: 'تپق',
  };

  // batchSize: NaN and nowMs: NaN must not skip loop or store NaN timestamps
  const edl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj_p16',
      sourceAudioId: 'src_p16',
      sourceAudioHash: 'hash_p16',
      transcriptVersion: 'tv1',
      sampleRate: 48000,
      totalSourceSamples: 48000 * 2,
    },
    events: [event],
    batchSize: Number.NaN,
    nowMs: Number.NaN,
  });

  assert.equal(edl.processedEventCount, 1);
  assert.equal(edl.proposals.length, 1);
  assert.equal(Number.isFinite(edl.createdAtMs), true);
  assert.equal(edl.proposals[0].eventConfidenceScore, null);

  // Proposal created without alignmentVersion must be detected as stale when active alignmentVersion is set
  const staleness = checkProposalProvenanceStaleness(edl.proposals[0], {
    alignmentVersion: 'align-v2',
  });
  assert.equal(staleness.isStale, true);
});

test('SpeechEventEngine, TimelineSuggestionBridge, and TemporalIntegrityValidator resist NaN PCM samples, flicks, confidences, and timestamps', async () => {
  const s = (sec: number) => TimeMath.secondsToFlicks(sec);

  // 1. SpeechEventEngine resists NaN PCM samples in token acoustic snippet and NaN config window/cap parameters
  const pcm = new Float32Array(16000 * 2).fill(0.15);
  pcm[100] = Number.NaN;
  pcm[3500] = Number.NaN;
  const analysis = await SpeechEventEngine.analyzeRecording({
    trackId: 'tr1',
    sampleRate: 16000,
    totalSamples: pcm.length,
    pcmMono: pcm,
    vadProvider: null,
    tokens: [
      {
        tokenId: 'tok_1',
        trackId: 'tr1',
        originalText: 'اممم',
        normalizedText: 'اممم',
        displayText: 'اممم',
        range: { start: s(0.2), end: s(0.6) },
        confidence: 0.9,
      },
      {
        tokenId: 'tok_bad',
        trackId: 'tr1',
        originalText: 'خراب',
        normalizedText: 'خراب',
        displayText: 'خراب',
        range: { start: Number.NaN, end: Number.NaN },
        confidence: 0.9,
      },
    ],
  });
  assert.equal(analysis.completedWindows >= 1, true);
  for (const ev of analysis.events) {
    if (ev.acousticEvidence?.rmsDb !== undefined) {
      assert.equal(Number.isFinite(ev.acousticEvidence.rmsDb), true);
    }
    if (ev.acousticEvidence?.peakDb !== undefined) {
      assert.equal(Number.isFinite(ev.acousticEvidence.peakDb), true);
    }
  }

  // 2. TimelineSuggestionBridge resists NaN startFlicks/endFlicks and NaN confidence/scores
  const bridgeRes = buildTimelineSuggestionsFromSpeechEvents([
    {
      eventId: 'ev_bridge_nan',
      trackId: 'tr1',
      category: 'FILLER',
      subtype: 'VOCAL_FILLED_PAUSE',
      detectionState: 'DETECTED',
      uncertaintyState: 'LOW_UNCERTAINTY',
      detectionMethod: 'HYBRID_HEURISTIC_FUSION',
      startSec: 0.2,
      endSec: 0.6,
      durationSec: 0.4,
      startFlicks: Number.NaN,
      endFlicks: Number.NaN,
      durationFlicks: Number.NaN,
      confidence: Number.NaN,
      scores: {
        acousticScore: Number.NaN,
        linguisticScore: Number.NaN,
        ruleEvidenceCount: 1,
        modelTokenConfidence: null,
        combinedDecisionScore: 0.85,
        calibratedProbability: Number.NaN,
        scoreCalibrationStatus: 'CALIBRATED_EMPIRICAL',
        conflicts: [],
      },
      provenance: {
        engineVersion: '1.0',
        thresholdConfigVersion: '1.0',
        detectorModule: 'test',
        capabilityMode: 'heuristic',
      },
      eligibleForEditSuggestion: true,
      requiresHumanReview: false,
      explanationFa: 'تپق',
    },
  ]);
  assert.equal(bridgeRes.suggestions.length, 1);
  const sug = bridgeRes.suggestions[0];
  assert.equal(Number.isFinite(sug.originalRangeFlicks.startFlicks), true);
  assert.equal(Number.isFinite(sug.originalRangeFlicks.endFlicks), true);
  assert.equal(Number.isFinite(sug.confidence), true);
  assert.equal(sug.evidenceSummary.includes('NaN'), false);

  // 3. TemporalIntegrityValidator flags NaN derivedStartSec and skips NaN benchmark timestamps
  const integrity = validateTranscriptTemporalIntegrity({
    tokens: [
      {
        tokenId: 't_nan_derived',
        originalToken: 'سلام',
        alignmentNormalizedText: 'سلام',
        displayNormalizedText: 'سلام',
        sampleRate: 16000,
        sourceStartSample: asSourceSamplePosition(0),
        sourceEndSample: asSourceSamplePosition(8000),
        derivedStartSec: Number.NaN as unknown as TimelineDisplaySec,
        derivedEndSec: 0.5 as unknown as TimelineDisplaySec,
        alignmentState: 'ALIGNED',
        alignmentMethod: 'CTC_VITERBI_FORCED_ALIGNMENT',
        modelId: 'ctc-1',
        modelVersion: '1.0',
        acousticScore: 0.9,
        evidenceProvenance: 'test',
        warnings: [],
      },
    ],
    authoritativeSampleRate: 16000,
    totalSourceSamples: 16000,
  });
  assert.equal(integrity.valid, false);
  assert.equal(
    integrity.violations.some((v) => v.code === 'TIME_SAMPLE_DISAGREEMENT'),
    true,
  );

  const bench = evaluateRealAudioAlignmentBenchmark({
    realHumanAnnotatedReferences: [
      {
        tokenId: 'b1',
        refStartMs: 100,
        refEndMs: 400,
        predStartMs: 110,
        predEndMs: 395,
      },
      {
        tokenId: 'b_nan',
        refStartMs: 500,
        refEndMs: 800,
        predStartMs: Number.NaN,
        predEndMs: 810,
      },
    ],
  });
  assert.equal(bench.status, 'EVALUATED');
  assert.equal(bench.medianAbsBoundaryErrorMs !== null && Number.isFinite(bench.medianAbsBoundaryErrorMs), true);
  assert.equal(bench.startBoundaryMeanErrorMs !== null && Number.isFinite(bench.startBoundaryMeanErrorMs), true);
});

test('AsrWindowReconciler, PersianAlignmentContract, ResampleCoordinateMapper & TimeConversion guard NaN confidence, invalid rates, and non-finite inputs', () => {
  // 1. TimeConversion & SamplePosition validation
  assert.throws(() => scaleIntegerRational(100, 1n, 0n), RangeError);
  assert.throws(() => flicksToSourceSampleExact(Number.NaN, 48000), RangeError);
  assert.throws(() => createSourceSampleRange(0, 100, Number.NaN), RangeError);

  // 2. ResampleCoordinateMapper sanitizes NaN/even filterTaps and invalid chunk bounds
  const mapper = new ResampleCoordinateMapper({
    sourceSampleRate: 48000,
    targetSampleRate: 16000,
    filterTaps: Number.NaN,
  });
  assert.equal(mapper.filterTaps, 63);
  const emptyChunk = mapper.resampleChunkContinuous({
    fullChannels: [new Float32Array(4800)],
    sourceStartSample: asSourceSamplePosition(1000),
    sourceEndSample: asSourceSamplePosition(500),
  });
  assert.equal(emptyChunk.resampledChunk.length, 0);

  // 3. AsrWindowReconciler sanitizes NaN confidence so valid-zone replacement works cleanly
  const windows = buildAsrWindowMappings({
    totalSourceSamples: 40 * 16000,
    sourceSampleRate: 16000,
    windowSampleRate: 16000,
    windowDurationSec: 25,
    overlapDurationSec: 3,
  });
  assert.equal(windows.length, 2);

  // Place overlapping duplicate token at 24.2s..24.6s (inside win_1's valid midpoint zone >= 23.5s)
  const reconciled = reconcileOverlappingAsrWindows({
    windows,
    predictionsByWindow: [
      {
        windowId: windows[0].windowId,
        tokens: [
          {
            tokenId: 'w0_dup',
            windowId: windows[0].windowId,
            windowIndex: 0,
            text: 'سلام',
            relativeStartSec: asAsrWindowRelativeSec(24.2),
            relativeEndSec: asAsrWindowRelativeSec(24.6),
            confidence: Number.NaN,
            modelId: 'm1',
            modelVersion: '1.0',
          },
        ],
      },
      {
        windowId: windows[1].windowId,
        tokens: [
          {
            tokenId: 'w1_dup',
            windowId: windows[1].windowId,
            windowIndex: 1,
            text: 'سلام',
            relativeStartSec: asAsrWindowRelativeSec(2.2),
            relativeEndSec: asAsrWindowRelativeSec(2.6),
            confidence: 0.92,
            modelId: 'm1',
            modelVersion: '1.0',
          },
        ],
      },
    ],
  });
  assert.equal(reconciled.deduplicatedOverlapCount, 1);
  assert.equal(reconciled.tokens.length, 1);
  assert.equal(reconciled.tokens[0].tokenId, 'w1_dup');
  assert.equal(reconciled.tokens[0].confidence, 0.92);

  // 4. PersianAlignmentContract resists NaN sourceSampleRate / totalSourceSamples / frameDurationSec
  const alignRes = runPersianForcedAlignmentContract({
    words: [{ id: 'w1', text: 'آواپرداز' }],
    sourceSampleRate: Number.NaN,
    totalSourceSamples: Number.NaN,
    frameDurationSec: Number.NaN,
    allowApproximateFallback: true,
  });
  assert.equal(alignRes.tokens.length, 1);
  assert.equal(alignRes.tokens[0].sampleRate, 48000);
  assert.equal(Number.isFinite(alignRes.tokens[0].derivedStartSec), true);
});

test('PersianTokenizer, PersianPunctuationAndNumbers & TranscriptTransformationEngine handle multi-token proposals and ambiguous number sequences cleanly', () => {
  // 1. createPersianTranscriptDocument sanitizes NaN sampleRate and NaN tokenSampleSpans
  const doc = createPersianTranscriptDocument({
    documentId: 'doc_p17',
    rawAsrText: 'می روم پنج پنج بیست و پنج هزار تومان',
    sampleRate: Number.NaN,
    tokenSampleSpans: [
      { sourceStartSample: Number.NaN, sourceEndSample: -50 },
      { sourceStartSample: 1000, sourceEndSample: 500 },
    ],
  });
  assert.equal(doc.tokens[0].sampleRate, 48000);
  assert.equal(doc.tokens[0].sourceStartSample, null);
  assert.equal(doc.tokens[0].sourceEndSample, null);
  assert.equal(doc.tokens[1].sourceStartSample, 1000);
  assert.equal(doc.tokens[1].sourceEndSample, 1000);

  // 2. analyzePersianPunctuationProposals resists non-finite sample coordinates
  const puncts = analyzePersianPunctuationProposals(doc);
  for (const p of puncts) {
    assert.equal(p.pauseDurationMs === null || Number.isFinite(p.pauseDurationMs), true);
  }

  // 3. analyzePersianSpokenNumbers flags «پنج پنج» as AMBIGUOUS_DO_NOT_CONVERT instead of summing to 10
  const repeatDoc = createPersianTranscriptDocument({
    documentId: 'doc_num_repeat',
    rawAsrText: 'پنج پنج و سپس بیست و پنج هزار تومان',
  });
  const numProposals = analyzePersianSpokenNumbers(repeatDoc);
  assert.equal(numProposals.length, 2);
  assert.equal(numProposals[0].status, 'AMBIGUOUS_DO_NOT_CONVERT');
  assert.equal(numProposals[0].parsedNumericValue, null);
  assert.equal(numProposals[1].status, 'PARSEABLE_DISPLAY_PROPOSAL');
  assert.equal(numProposals[1].parsedNumericValue, 25000);

  // 4. TranscriptTransformationEngine applies and reverts multi-token orthography proposals without duplicating absorbed tokens
  const orthoDoc = createPersianTranscriptDocument({
    documentId: 'doc_ortho_multi',
    rawAsrText: 'من می روم به خانه',
  });
  const orthoProposals = analyzePersianOrthography(orthoDoc);
  assert.equal(orthoProposals.length, 1);
  assert.equal(orthoProposals[0].tokenIds.length, 2);

  const engine = new TranscriptTransformationEngine();
  const applyRes = engine.applyAcceptedCandidate({
    document: orthoDoc,
    candidate: {
      candidateId: orthoProposals[0].proposalId,
      sourceTranscriptVersion: orthoDoc.version,
      tokenIds: orthoProposals[0].tokenIds,
      originalText: orthoProposals[0].originalText,
      proposedText: orthoProposals[0].proposedText,
      category: 'ORTHOGRAPHY_READABLE',
      evidenceStrength: 'STRONG_EVIDENCE',
      acousticEvidenceAvailable: false,
      acousticConfidence: null,
      linguisticEvidence: orthoProposals[0].linguisticRationale,
      semanticRisk: assessSemanticChangeRisk({
        originalText: orthoProposals[0].originalText,
        proposedText: orthoProposals[0].proposedText,
        category: 'ORTHOGRAPHY_READABLE',
      }),
      alignmentImpact: 'RECALCULATE_REQUIRED',
      epistemicSource: 'DETERMINISTIC_NORMALIZATION',
      provenanceModule: 'test',
      sourceStartSample: null,
      sourceEndSample: null,
      status: 'PROPOSED',
    },
  });
  assert.equal(applyRes.applied, true);
  assert.equal(renderTranscriptLayerText(applyRes.document, 'READABLE'), 'من می‌روم به خانه');
  assert.equal(renderTranscriptLayerText(applyRes.document, 'RAW_ASR'), 'من می روم به خانه');

  const revertRes = engine.revertCandidateById(applyRes.document, orthoProposals[0].proposalId);
  assert.equal(revertRes.reverted, true);
  assert.equal(renderTranscriptLayerText(revertRes.document, 'READABLE'), 'من می روم به خانه');
});

test('StudioWorkflowController sanitizes NaN token ranges, NaN export timestamps, NaN nowMs, and NaN progressPct', () => {
  // 1. buildTranscriptSegmentsFromTokens filters tokens with NaN flicks
  const segs = buildTranscriptSegmentsFromTokens(
    [
      {
        id: 'w_nan',
        trackId: 'tr1',
        speakerName: 'گوینده ۱',
        originalText: 'خراب',
        normalizedText: 'خراب',
        displayText: 'خراب',
        range: { startFlicks: Number.NaN, endFlicks: Number.NaN },
        confidence: 0.9,
        alignmentSource: 'ASR',
      },
      {
        id: 'w_ok',
        trackId: 'tr1',
        speakerName: 'گوینده ۱',
        originalText: 'سالم',
        normalizedText: 'سالم',
        displayText: 'سالم',
        range: { startFlicks: 0, endFlicks: 705_600_000 },
        confidence: Number.NaN,
        alignmentSource: 'ASR',
      },
    ],
    { tr1: 'گوینده ۱' },
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0].rawText, 'سالم');
  assert.equal(Number.isFinite(segs[0].startSec), true);
  assert.equal(Number.isFinite(segs[0].endSec), true);
  assert.equal(segs[0].alignmentConfidence, null);

  // 2. exportTranscriptContent txt format guards NaN segment startSec/endSec
  const txtExport = exportTranscriptContent({
    version: {
      versionId: 'v0',
      versionNumber: 0,
      kind: 'RAW_ASR_IMMUTABLE',
      createdAtMs: 1000,
      changeSummary: 'init',
      segments: [
        {
          ...segs[0],
          startSec: Number.NaN,
          endSec: Number.NaN,
        },
      ],
    },
    layer: 'raw',
    format: 'txt',
    projectName: 'پروژه تست',
  });
  assert.equal(txtExport.content.includes('NaN'), false);

  // 3. StudioWorkflowController openProject, setAsrState, editTranscriptSegment, and getSpeechEventsForSegment resist NaN
  const ctrl = new StudioWorkflowController();
  ctrl.openProject({
    projectId: 'p18',
    projectName: 'پروژه ۱۸',
    sourceAudio: null,
    initialSegments: segs,
    nowMs: Number.NaN,
  });
  const st1 = ctrl.getState();
  assert.equal(Number.isFinite(st1.rawTranscriptVersion?.createdAtMs), true);

  ctrl.setAsrState({
    state: 'INFERENCE_RUNNING',
    progressPct: Number.NaN,
    message: 'در حال اجرا',
  });
  assert.equal(ctrl.getState().asrProgressPct, null);

  const editRes = ctrl.editTranscriptSegment({
    segmentId: segs[0].segmentId,
    newText: 'سالم ویرایش‌شده',
    nowMs: Number.NaN,
  });
  assert.equal(editRes.ok, true);
  assert.equal(Number.isFinite(editRes.newVersion?.createdAtMs), true);

  assert.deepEqual(getSpeechEventsForSegment([], Number.NaN, 5), []);
});

test('DiarizationAlignmentEngine, TranslationSubtitlesEngine & MeetingAnalyticsSearchEngine resist NaN speaker counts, repeated-word subtitle wrapping, and NaN search topK', () => {
  // 1. runModularDiarizationCapability resists expectedSpeakerCount: NaN (never emits speaker_NaN)
  const diar = runModularDiarizationCapability({
    recordingId: 'rec_p18',
    durationSec: Number.NaN,
    expectedSpeakerCount: Number.NaN,
    transcriptSegments: [
      { segmentId: 's1', startSec: Number.NaN, endSec: Number.NaN, text: 'سلام' },
      { segmentId: 's2', startSec: 1.5, endSec: 2.5, text: 'درود' },
    ],
  });
  assert.equal(diar.segments.length, 2);
  for (const seg of diar.segments) {
    assert.equal(seg.speakerId.includes('NaN'), false);
    assert.equal(Number.isFinite(seg.startSec), true);
    assert.equal(Number.isFinite(seg.endSec), true);
  }

  // 2. evaluateDiarizationQualityPerLanguage & evaluateAlignmentBoundaryMetrics skip NaN segments
  const diarEval = evaluateDiarizationQualityPerLanguage({
    collarSec: Number.NaN,
    includeOverlapScoring: true,
    samples: [
      {
        recordingId: 'r1',
        language: 'fa',
        referenceSegments: [
          { startSec: 0, endSec: 1, speakerId: 'speaker_1' },
          { startSec: Number.NaN, endSec: Number.NaN, speakerId: 'speaker_1' },
        ],
        hypothesisSegments: [{ startSec: 0, endSec: 1, speakerId: 'speaker_1' }],
      },
    ],
  });
  assert.equal(diarEval.length, 1);
  assert.equal(Number.isFinite(diarEval[0].derPercent), true);

  const alignOut = runModularForcedAlignmentCapability({
    recordingId: 'rec_p18',
    sourceTranscriptArtifactId: 'art_1',
    sourceTranscriptVersion: 1,
    transcriptText: 'سلام دنیا',
    audioDurationSec: Number.NaN,
  });
  assert.equal(alignOut.unalignedCount, 2);

  const boundaryMetrics = evaluateAlignmentBoundaryMetrics({
    referenceWords: [{ wordId: 'w1', startSec: Number.NaN, endSec: 1 }],
    hypothesisWords: [],
  });
  assert.equal(Number.isFinite(boundaryMetrics.medianAbsErrorMs), true);

  // 3. generateModularSubtitles wrapIntoTwoBalancedLines does NOT duplicate Line 1 words when wrap boundary word appeared earlier
  const subs = generateModularSubtitles({
    segments: [
      {
        segmentId: 'seg_wrap',
        startSec: 0,
        endSec: 4,
        text: 'در این جلسه درباره معماری سیستم و در ادامه درباره تست صحبت کردیم',
      },
    ],
    includeSpeakerLabels: false,
    minDurationSec: Number.NaN,
    maxDurationSec: Number.NaN,
    minInterCueGapMs: Number.NaN,
    targetMaxCps: Number.NaN,
  });
  assert.equal(subs.cues.length, 1);
  // Joined lines must equal original normalized text without duplicating the prefix before the second «در»
  assert.equal(
    subs.cues[0].primaryText.replace(/\n/g, ' '),
    'در این جلسه درباره معماری سیستم و در ادامه درباره تست صحبت کردیم',
  );
  assert.equal(subs.exports.srt?.includes('NaN'), false);

  // 4. MeetingAnalyticsSearchEngine & RealtimeIntelligenceStreamCoordinator resist NaN duration, topK, and baseline latency
  const analytics = runConversationAnalyticsCapability({
    recordingId: 'rec_p18',
    totalDurationSec: Number.NaN,
    diarizationSegments: diar.segments,
    transcriptSegments: [{ segmentId: 's1', startSec: 0, endSec: 1, text: 'آیا آماده است؟' }],
  });
  assert.equal(Number.isFinite(analytics.totalDurationSec), true);
  assert.equal(Number.isFinite(analytics.speechToSilenceRatio), true);

  const semIdx = new TenantIsolatedSemanticIndex();
  semIdx.indexRecordingSegments({
    organizationId: 'org1',
    projectId: 'prj1',
    recordingId: 'rec1',
    transcriptVersion: 1,
    language: 'fa',
    segments: [{ segmentId: 's1', startSec: 0, endSec: 2, text: 'معماری آواپرداز' }],
  });
  const hits = semIdx.searchAuthorized({
    organizationId: 'org1',
    projectId: 'prj1',
    query: 'آواپرداز',
    topK: Number.NaN,
    minStartSec: Number.NaN,
    maxEndSec: Number.NaN,
  });
  assert.equal(hits.length, 1);

  const rtCoord = new RealtimeIntelligenceStreamCoordinator('sess_p18', Number.NaN);
  const rtOut = rtCoord.emitChunkEvents({
    asrBaselineLatencyMs: Number.NaN,
    chunkStartSample: Number.NaN,
    chunkEndSample: Number.NaN,
    finalText: 'تست زنده',
    enableOptionalIntelligence: true,
    simulatedOptionalWorkerLatencyMs: 50,
  });
  assert.equal(rtOut.asrStreamAlive, true);
  assert.equal(rtOut.throttledOptionalWorkers, true);
});

test('CoreAudioIngestion and CoreAcousticCtcEngine sanitize NaN/Infinity PCM samples, synthesis options, and adapter training parameters', () => {
  // 1. inspectAndDownmixChannels & computeSignalHealth sanitize NaN/Infinity samples in mono and stereo
  const left = new Float32Array(640);
  const right = new Float32Array(640);
  for (let i = 0; i < 640; i++) {
    left[i] = Math.sin(i * 0.1) * 0.5;
    right[i] = -left[i]; // phase-inverted stereo
  }
  left[10] = Number.NaN;
  right[20] = Number.POSITIVE_INFINITY;

  const stereoRes = inspectAndDownmixChannels([left, right]);
  assert.equal(stereoRes.inspection.phaseInversionRisk, true);
  assert.equal(Number.isFinite(stereoRes.inspection.leftRmsDb), true);
  assert.equal(Number.isFinite(stereoRes.inspection.rightRmsDb), true);
  assert.equal(Number.isFinite(stereoRes.inspection.interChannelCorrelation), true);
  assert.equal(stereoRes.monoFloat32.every((v) => Number.isFinite(v)), true);

  const monoRes = inspectAndDownmixChannels([left]);
  assert.equal(monoRes.monoFloat32.every((v) => Number.isFinite(v)), true);

  const health = computeSignalHealth(left);
  assert.equal(Number.isFinite(health.rmsDb), true);
  assert.equal(Number.isFinite(health.peakDb), true);
  assert.equal(Number.isFinite(health.estimatedSnrDb), true);
  assert.equal(Number.isFinite(health.dcOffset), true);

  // 2. synthesizeAcousticSpeechFromText handles NaN charDurationSec, noiseLevel, and speakerPitchHz
  const synth = synthesizeAcousticSpeechFromText('سلام امروز', {
    charDurationSec: Number.NaN,
    noiseLevel: Number.NaN,
    speakerPitchHz: Number.NaN,
  });
  assert.ok(synth.length >= 320);
  assert.equal(synth.every((v) => Number.isFinite(v)), true);

  // 3. extractAcousticFeatureFrames & CoreAcousticCtcEngine.decodePcmSegment resist NaN samples and NaN offset
  const dirtyPcm = new Float32Array(synth);
  dirtyPcm[50] = Number.NaN;
  dirtyPcm[200] = Number.NEGATIVE_INFINITY;
  const feat = extractAcousticFeatureFrames(dirtyPcm);
  assert.ok(feat.frames.length > 0);
  assert.equal(feat.frameRms.every((v) => Number.isFinite(v)), true);
  assert.equal(feat.frames.every((f) => f.every((v) => Number.isFinite(v))), true);

  const ctc = new CoreAcousticCtcEngine();
  const seg = ctc.decodePcmSegment({
    pcm16k: dirtyPcm,
    segmentIndex: Number.NaN,
    segmentOffsetSamples: Number.NaN,
  });
  assert.equal(seg.status, 'OK');
  assert.equal(Number.isFinite(seg.startSec), true);
  assert.equal(Number.isFinite(seg.endSec), true);
  assert.ok(seg.rawModelOutput.length > 0);

  // 4. trainAcousticAdapterOnCorpus sanitizes NaN learningRate and epochs
  const adapted = trainAcousticAdapterOnCorpus({
    trainingExamples: [{ pcm16k: dirtyPcm, transcript: 'سلام امروز', languageGroup: 'fa' }],
    candidateVersionId: 'cand_nan_safe',
    learningRate: Number.NaN,
    epochs: Number.NaN,
  });
  assert.equal(adapted.trainingLossCurve.every((v) => Number.isFinite(v)), true);
  assert.equal(
    adapted.adaptedWeights.prototypes.every((p) => p.every((v) => Number.isFinite(v))),
    true,
  );
});

test('CoreStreamingAsrManager, CoreBatchAndLongFormEngine, CoreAsrBenchmarkSuite, and CoreModelRouter resist NaN config parameters', () => {
  // 1. CoreStreamingAsrManager handles NaN session thresholds and still detects speech & finalizes
  const streamMgr = new CoreStreamingAsrManager(new CoreAcousticCtcEngine(), Number.NaN);
  const created = streamMgr.createSession({
    tenantId: 't_p19',
    vadEnergyThreshold: Number.NaN,
    silenceEndpointMs: Number.NaN,
    maxUtteranceSec: Number.NaN,
    maxQueuedSamples: Number.NaN,
  });
  assert.equal(created.accepted, true);

  const speechPcm = synthesizeAcousticSpeechFromText('سلام گفتار');
  const pcm16Buf = float32ToPcm16Buffer(speechPcm);
  const events = streamMgr.pushPcm16Chunk(created.sessionId, pcm16Buf);
  assert.equal(events.some((e) => e.type === 'speech.started'), true);
  const fin = streamMgr.finalizeSession(created.sessionId);
  assert.equal(Number.isFinite(fin.metrics.totalAudioSec), true);
  assert.equal(Number.isFinite(fin.metrics.rtf), true);

  // 2. CoreBatchAndLongFormEngine & findBestBoundaryValleySample handle NaN config values (including maxRetriesPerSegment: NaN)
  const valley = findBestBoundaryValleySample(speechPcm, Number.NaN, Number.NaN);
  assert.equal(Number.isFinite(valley), true);

  const batchEngine = new CoreBatchAndLongFormEngine();
  const batchRes = batchEngine.transcribeLongFormPcm({
    pcm16k: speechPcm,
    config: {
      maxSegmentDurationSec: Number.NaN,
      contextOverlapSec: Number.NaN,
      maxRetriesPerSegment: Number.NaN,
    },
  });
  assert.equal(batchRes.status, 'COMPLETED');
  assert.equal(batchRes.segments.length, 1);
  assert.equal(batchRes.segments[0].status, 'OK');

  // 3. computePairedBootstrapCi & buildLongFormStressAudioPcm handle NaN iterations, seed, error elements, and duration
  const ci = computePairedBootstrapCi({
    baselineErrors: [0.25, Number.NaN, 0.3],
    candidateErrors: [0.15, 0.1, Number.POSITIVE_INFINITY],
    metric: 'CER',
    iterations: Number.NaN,
    seed: Number.NaN,
  });
  assert.equal(Number.isFinite(ci.meanDelta), true);
  assert.equal(Number.isFinite(ci.ci95Low), true);
  assert.equal(Number.isFinite(ci.ci95High), true);

  const stressPcm = buildLongFormStressAudioPcm(Number.NaN);
  assert.ok(stressPcm.length > 0);

  // 4. CoreModelRouter.listRecentRoutingAudit handles limit: 0 and limit: NaN
  const router = new CoreModelRouter();
  router.routeInference({ mode: 'batch' });
  assert.equal(router.listRecentRoutingAudit(0).length, 0);
  assert.equal(router.listRecentRoutingAudit(-5).length, 0);
  assert.equal(router.listRecentRoutingAudit(Number.NaN).length, 1);
});

test('ResponsiveSeekController, TimelineVirtualizer, AdaptiveDegradationController & MultiresolutionWaveformCache resist NaN inputs', async () => {
  // 1. ResponsiveSeekController sanitizes NaN targetSample instead of corrupting lastAppliedSample
  const seekCtrl = new ResponsiveSeekController();
  await seekCtrl.seekToSample(1234, () => {});
  const badSeek = await seekCtrl.seekToSample(Number.NaN, () => {});
  assert.equal(badSeek.targetSample, 1234);
  assert.equal(seekCtrl.getStats().lastAppliedSample, 1234);

  // 2. virtualizeTimelineEvents resists NaN viewport bounds and filters out NaN events
  const virt = virtualizeTimelineEvents(
    [
      {
        id: 'ev_bad',
        trackId: 'tr1',
        sourceStartSample: Number.NaN,
        sourceEndSample: Number.NaN,
        sampleRate: 48000,
        kind: 'FILLER',
        status: 'PENDING',
      },
      {
        id: 'ev_ok',
        trackId: 'tr1',
        sourceStartSample: 100,
        sourceEndSample: 400,
        sampleRate: 48000,
        kind: 'FILLER',
        status: 'PENDING',
      },
    ],
    {
      viewportStartSample: 0,
      viewportEndSample: 1000,
      viewportWidthPx: Number.NaN,
      overscanRatio: Number.NaN,
      minItemWidthPx: Number.NaN,
    },
  );
  assert.equal(virt.visibleRawEventCount, 1);
  assert.equal(Number.isFinite(virt.overscanStartSample), true);
  assert.equal(Number.isFinite(virt.renderedItems[0].displayLeftPx), true);
  assert.equal(Number.isFinite(virt.renderedItems[0].displayWidthPx), true);

  // 3. AdaptiveDegradationController does not permanently freeze on NaN recoveryCooldownMs or nowMs
  const degrader = new AdaptiveDegradationController(Number.NaN);
  const s1 = degrader.evaluate({ memoryPressure: 'emergency', recentLongTaskCount: 0, nowMs: Number.NaN });
  assert.equal(s1.level, 'EMERGENCY_SAFE_MODE');
  const futureMs = Date.now() + 20_000;
  const s2 = degrader.evaluate({ memoryPressure: 'normal', recentLongTaskCount: 0, nowMs: futureMs });
  assert.equal(s2.level, 'DEGRADED');

  // 4. MultiresolutionWaveformCache guards NaN constructor options & prevents inverted min > max on NaN PCM samples
  const wfCache = new MultiresolutionWaveformCache({ maxBytes: Number.NaN, bucketsPerTile: Number.NaN });
  const dirtySamples = new Float32Array(128).fill(Number.NaN);
  const tiles = wfCache.getOrComputeRangeTiles({
    assetId: 'asset_nan',
    channelIndex: 0,
    sourceChannelPcm: dirtySamples,
    startSample: 0,
    endSample: 128,
    samplesPerBucket: 64,
  });
  assert.equal(tiles.length, 1);
  for (let i = 0; i < tiles[0].mins.length; i++) {
    assert.ok(tiles[0].mins[i] <= tiles[0].maxs[i]);
  }
  wfCache.dispose();
});

test('PerformanceAggregator, LongSessionMonitor, PerformanceAnomalyDetector, PerformanceRegressionGuard, TaskScheduler & HardwareBenchmarkProfiler resist NaN', async () => {
  // 1. PerformanceAggregator preserves bounded window despite maxWindowSamples: NaN
  const agg = new PerformanceAggregator(Number.NaN);
  for (let i = 0; i < 250; i++) agg.record('seek_latency_ms', i, false);
  assert.ok(agg.getStoredSampleCount() <= 200);

  // 2. LongSessionMonitor ignores NaN/Infinity metric and counter patches
  const monitor = new LongSessionMonitor();
  monitor.updateCounters({ loadedAudioAssets: 3 });
  monitor.updateCounters({ loadedAudioAssets: Number.NaN });
  monitor.recordMetric('main_thread_block_ms', Number.POSITIVE_INFINITY);
  const snap = monitor.getSnapshot();
  assert.equal(snap.counters.loadedAudioAssets, 3);
  assert.equal(Number.isFinite(snap.counters.totalMainThreadBlockingMs), true);

  // 3. PerformanceAnomalyDetector filters NaN samples safely
  const detector = new PerformanceAnomalyDetector();
  const anom = detector.detectLatencyRegression(
    'seek_latency_ms',
    [...Array(8).fill(5), Number.NaN, ...Array(8).fill(150)],
    100,
  );
  assert.ok(anom !== null);
  assert.equal(Number.isFinite(anom.baselineValue), true);

  // 4. evaluatePerformanceRegressionInvariants catches NaN metrics as violations
  const inv = evaluatePerformanceRegressionInvariants({
    queueDepth: Number.NaN,
    maxQueueDepth: 10,
    diagnosticSampleCount: 5,
    maxDiagnosticSamples: 100,
    workerCountBeforeCycles: 1,
    workerCountAfterCycles: 1,
    listenerCountBeforeCycles: 1,
    listenerCountAfterCycles: 1,
    memoryAccountedBytesAfterRelease: 0,
    waveformCacheBytes: 0,
    maxWaveformCacheBytes: 1024,
    transcriptFullClonesDuringLocalEdits: 0,
    staleAsyncResultsApplied: 0,
  });
  assert.equal(inv.passed, false);
  assert.ok(inv.violations.some((v) => v.includes('Non-finite')));

  // 5. TaskScheduler handles NaN limits cleanly and runs submitted task
  const sched = new TaskScheduler({ limits: { maxTotalConcurrent: Number.NaN, maxQueueSize: Number.NaN } });
  const sub = sched.submit({
    priority: 'CRITICAL_INTERACTION',
    subsystem: 'editing',
    idempotent: true,
    estimatedMemoryBytes: Number.NaN,
    deadlineMs: Number.NaN,
    run: () => 42,
  });
  assert.equal(sub.accepted, true);
  if (sub.accepted) {
    assert.equal(await sub.promise, 42);
  }

  // 6. HardwareBenchmarkProfiler.estimateJobProcessingDuration never emits NaN in Persian ETA
  const eta = HardwareBenchmarkProfiler.estimateJobProcessingDuration(
    Number.NaN,
    {
      measuredAtTimestamp: Date.now(),
      cpuComputeGflops: 2.0,
      opfsSequentialWriteMbPerSec: 100,
      storageBenchmarkSource: 'MEMORY_BANDWIDTH_FALLBACK',
      webgpuProbeLatencyMs: null,
      estimatedAsrRealTimeFactor: Number.NaN,
      maxSafeFileDurationMinutes: Number.NaN,
      recommendedDeviceTier: 'DESKTOP_STUDIO',
      benchmarkDurationMs: 10,
    },
    'GROUP_B_PERSIAN_ASR',
  );
  assert.equal(Number.isFinite(eta.estimatedSeconds), true);
  assert.equal(eta.humanReadableEstimateFa.includes('NaN'), false);
});

test('UnifiedProcessingOrchestrator, CloudExecutionAdapter, LocalExecutionAdapter, and UnifiedProcessingContract resist NaN limits, timeouts, retries, and byteLength', async () => {
  const pcm16 = new Uint8Array(3200);
  const audioInput = uint8ArrayToTransportSafeAudioInput({
    bytes: pcm16,
    encoding: 'BASE64_PCM16_16K_MONO',
    metadata: {
      filename: 'test.pcm',
      mimeType: 'audio/pcm',
      containerFormat: 'pcm16',
      sampleRateHz: 16000,
      channelCount: 1,
      durationSecEstimate: Number.NaN,
      sha256Hex: null,
    },
  });

  // 1. UnifiedProcessingContract rejects NaN byteLength
  await assert.rejects(
    async () => {
      const orch = new UnifiedProcessingOrchestrator();
      await orch.execute({
        contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
        jobId: 'job_nan_bytes',
        recordingId: 'rec_1',
        executionMode: 'LOCAL',
        processingMode: 'batch',
        audio: {
          ...audioInput,
          metadata: { ...audioInput.metadata, byteLength: Number.NaN },
        },
        languageHint: 'fa',
        config: {
          configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
          normalizationProfile: 'FA-STRICT-V1',
        },
        requestedCapabilities: ['RAW_TRANSCRIPT'],
        cancellationId: 'c_1',
      });
    },
    (err: unknown) => err instanceof UnifiedProcessingError && err.code === 'UNSUPPORTED_AUDIO_FORMAT',
  );

  // 2. LocalExecutionAdapter fails closed when constraints.maxMemoryBytes is NaN
  const localAdapter = new LocalExecutionAdapter();
  await assert.rejects(
    async () => {
      await localAdapter.execute({
        contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
        jobId: 'job_nan_mem',
        recordingId: 'rec_1',
        executionMode: 'LOCAL',
        processingMode: 'batch',
        audio: audioInput,
        languageHint: 'fa',
        config: {
          configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
          normalizationProfile: 'FA-STRICT-V1',
        },
        requestedCapabilities: ['RAW_TRANSCRIPT'],
        cancellationId: 'c_2',
        constraints: { maxMemoryBytes: Number.NaN },
      });
    },
    (err: unknown) =>
      err instanceof UnifiedProcessingError && err.code === 'PROCESSING_RESOURCE_LIMIT_EXCEEDED',
  );

  // 3. CloudExecutionAdapter & UnifiedProcessingOrchestrator execute cleanly even when timeoutMs, maxRetries, backoffBaseMs, maxTraceEntries are NaN
  const transport = new DeterministicMockCloudTransport({
    kind: 'SUCCESS',
    rawText: 'سلام آزمایش ابری',
  });
  const cloudAdapter = new CloudExecutionAdapter({
    config: {
      providerId: 'mock-cloud',
      displayName: 'Mock Cloud',
      endpointUrl: 'https://example.invalid/asr',
      configured: true,
    },
    transport,
    backoffBaseMs: Number.NaN,
  });

  const orch = new UnifiedProcessingOrchestrator({
    cloudAdapter,
    maxTraceEntries: Number.NaN,
  });
  const cloudRes = await orch.execute({
    contractVersion: UNIFIED_PROCESSING_CONTRACT_VERSION,
    jobId: 'job_cloud_nan_opts',
    recordingId: 'rec_1',
    executionMode: 'CLOUD',
    processingMode: 'batch',
    audio: audioInput,
    languageHint: 'fa',
    config: {
      configVersion: UNIFIED_PROCESSING_CONFIG_VERSION,
      normalizationProfile: 'FA-STRICT-V1',
    },
    requestedCapabilities: ['RAW_TRANSCRIPT'],
    cancellationId: 'c_3',
    constraints: {
      timeoutMs: Number.NaN,
      maxRetries: Number.NaN,
    },
  });
  assert.equal(cloudRes.status, 'COMPLETED');
  assert.equal(cloudRes.durationSec, 1.0);
  assert.equal(orch.getExecutionTrace(0).length, 0);
  assert.equal(orch.getExecutionTrace(-3).length, 0);
  assert.equal(orch.getExecutionTrace(Number.NaN).length, 1);
});

test('ReleaseReadinessGate, useAudioStudioController helpers, SharedRingBuffer, security guards, and WorkerStorageCore resist NaN & invalid bounds', async () => {
  // 1. ReleaseReadinessGate catches NaN sampleTolerance & NaN expectedSamplesPerChannel instead of passing silently
  const sink = new BoundedChunkedByteSink();
  const writer = new AudioExportWriter({
    renderId: 'r_gate',
    artifactId: 'a_gate',
    container: 'wav',
    encoding: 'pcm16',
    sampleRate: 48000,
    channelCount: 1,
    sink,
  });
  await writer.begin();
  await writer.writePlanarChunk([new Float32Array(4800).fill(0.1)], 4800);
  await writer.finalize();
  const gateBytes = await sink.readRange(0, sink.getTotalBytesWritten());
  sink.disposeCommitted();
  const gateRep = evaluateRenderedAudioSignalQuality({
    bytes: gateBytes,
    expectedSampleRate: 48000,
    expectedChannelCount: 1,
    expectedSamplesPerChannel: 1000,
    sampleTolerance: Number.NaN,
  });
  assert.equal(gateRep.valid, false);
  assert.ok(gateRep.issues.some((i) => i.includes('Sample count mismatch')));

  // 2. useAudioStudioController pure helpers resist NaN playheadFlicks & NaN currentShuttleSpeed
  assert.equal(findActiveTokenIdAtFlicks([], Number.NaN), null);
  const vp = { start: 0, end: 1000 };
  assert.deepEqual(computeAutoScrollViewport(vp, Number.NaN, true), vp);

  let updatedSpeed = 0;
  const handled = dispatchStudioShortcutKeyDown(
    {
      target: null,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: 'l',
      code: 'KeyL',
      preventDefault: () => {},
    },
    {
      clockReader: {
        readCurrentSampleFrameAtomically: () => Number.NaN,
        isPlaying: () => true,
        setPlaybackRate: () => {},
        togglePlayPause: () => {},
        seekToSample: () => {},
      },
      sampleRate: 48000,
      currentShuttleSpeed: Number.NaN,
      onSetShuttleSpeed: (s) => {
        updatedSpeed = s;
      },
      onUndo: () => {},
      onRedo: () => {},
    },
  );
  assert.equal(handled, true);
  assert.equal(updatedSpeed, 1.5);

  // 3. SharedAudioRingBuffer handles corrupted out-of-range WRITE_INDEX / READ_INDEX cleanly
  const ring = new SharedAudioRingBuffer(16, 1);
  const ctrlView = new Int32Array(ring.controlBuffer);
  ctrlView[CTRL_STATE.WRITE_INDEX] = -5;
  ctrlView[CTRL_STATE.READ_INDEX] = 25;
  assert.ok(ring.availableRead() >= 0 && ring.availableRead() < ring.capacityFrames);
  const pushed = ring.push([new Float32Array([0.1, 0.2, 0.3, 0.4])], 4);
  assert.equal(pushed, 4);

  // 4. AudioIngestionAndUrlGuard & StreamingSecurityGuard reject/sanitize NaN caps & TTL
  const wavHeader = new Uint8Array(64);
  wavHeader.set([0x52, 0x49, 0x46, 0x46, 0x38, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  const ingestRes = AudioIngestionAndUrlGuard.inspectUploadedAudio({
    filename: 'test.wav',
    bytes: wavHeader,
    declaredSampleRateHz: 16000,
    declaredChannels: 1,
    declaredDurationSeconds: Number.NaN,
    limits: { maxUploadBytes: Number.NaN },
  });
  assert.equal(ingestRes.accepted, false);

  const guard = new StreamingSecurityGuard({
    maxConcurrentPerTenant: Number.NaN,
    maxConcurrentPerKey: Number.NaN,
  });
  const tok = guard.issueSingleUseSessionToken({
    tenantId: 't1',
    projectId: 'p1',
    principalId: 'u1',
    ttlSeconds: Number.NaN,
    maxAudioSeconds: Number.NaN,
    maxMessagesPerSecond: Number.NaN,
  });
  assert.equal(Number.isFinite(tok.expiresAtMs), true);
  const admit = guard.admitStreamingSession({
    token: tok,
    connectingPrincipalId: 'u1',
    apiKeyId: 'k1',
    maxQueueDepth: Number.NaN,
  });
  assert.equal(admit.admitted, true);
  if (admit.sessionId) {
    guard.drainQueuedFrames(admit.sessionId, Number.NaN);
    guard.closeSession(admit.sessionId);
  }

  // 5. WorkerStorageCore.recoverStartupAssets handles NaN maxIngestingAgeMs cleanly
  const workerCore = new WorkerStorageCore();
  await workerCore.init(0);
  const recov = await workerCore.recoverStartupAssets(Number.NaN);
  assert.deepEqual(recov, { cleanedAssetIds: [], readyAssetIds: [] });
});

test('48. buildHonestAcousticSpeechSegments returns zero tokens for silence and aligns real speech bursts honestly without fake dialogue', () => {
  const sampleRate = 48_000;
  const silentPcm = new Float32Array(sampleRate * 2);
  const emptyResult = buildHonestAcousticSpeechSegments({
    pcm: silentPcm,
    sampleRate,
    trackId: 'track-silent',
    speakerName: 'گوینده',
    acousticProfile: {
      assetId: 'silent-1',
      noiseFloorDbfs: -60,
      roomToneRms: 0.002,
      roomToneSample: new Float32Array(1024),
      sampleRate,
    },
  });
  assert.equal(emptyResult.burstCount, 0);
  assert.equal(emptyResult.tokens.length, 0);

  const { pcm } = buildSyntheticMicRecordingPcm(sampleRate);
  const segResult = buildHonestAcousticSpeechSegments({
    pcm,
    sampleRate,
    trackId: 'track-mic-1',
    speakerName: 'گوینده استودیو',
    acousticProfile: {
      assetId: 'mic-1',
      noiseFloorDbfs: -48,
      roomToneRms: 0.004,
      roomToneSample: pcm.subarray(0, 2048),
      sampleRate,
    },
  });
  assert.ok(segResult.burstCount >= 8, `Expected >= 8 acoustic bursts, got ${segResult.burstCount}`);
  assert.equal(segResult.tokens.length, segResult.burstCount);
  for (const tok of segResult.tokens) {
    assert.equal(tok.alignmentSource, 'AcousticSnap');
    assert.ok(tok.range.endFlicks > tok.range.startFlicks);
    assert.ok(
      tok.displayText.includes('گفتار_آوایی') || tok.displayText.includes('کشیدگی_آوایی'),
      `Unexpected fabricated label: ${tok.displayText}`,
    );
  }
  assert.ok(segResult.recommendations.length >= 1, 'Expected at least 1 pause/plateau recommendation');
});

test('49. extractAcousticProfile and ingestAudioFileStreaming handle digital-zero pauses cleanly without suppressing speech bursts', async () => {
  const sampleRate = 16_000;
  const durSec = 2.5;
  const totalSamples = Math.floor(sampleRate * durSec);
  const pcm = new Float32Array(totalSamples);
  // 3 clean speech bursts separated by exact digital zeros (0.0)
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const active = (t >= 0.2 && t <= 0.65) || (t >= 1.0 && t <= 1.5) || (t >= 1.85 && t <= 2.25);
    if (active) {
      pcm[i] = 0.45 * Math.sin(2 * Math.PI * 220 * t);
    }
  }

  const profile = extractAcousticProfile('gated-wav', pcm, sampleRate);
  assert.ok(profile.roomToneRms <= 0.001, `Expected digital-zero floor <= 0.001, got ${profile.roomToneRms}`);
  assert.ok(profile.noiseFloorDbfs <= -55, `Expected noiseFloorDbfs <= -55, got ${profile.noiseFloorDbfs}`);

  const segResult = buildHonestAcousticSpeechSegments({
    pcm,
    sampleRate,
    trackId: 'track-gated',
    speakerName: 'گوینده',
    acousticProfile: profile,
  });
  assert.equal(segResult.burstCount, 3, `Expected 3 speech bursts, got ${segResult.burstCount}`);
  assert.equal(segResult.tokens.length, 3);

  // Also test streaming WAV ingest path directly
  const wavBuf = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(wavBuf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, totalSamples * 2, true);
  for (let i = 0; i < totalSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(pcm[i] * 32767), true);
  }
  const wavFile = new File([wavBuf], 'gated-3-bursts.wav', { type: 'audio/wav' });
  const loaded = await ingestAudioFileStreaming(wavFile);
  const asset = Object.values(loaded.assets)[0];
  assert.ok(asset.acousticProfile.roomToneRms <= 0.001, `Streaming roomToneRms was ${asset.acousticProfile.roomToneRms}`);
  const loadedPcm = loaded.pcmSources[asset.id];
  const streamedSeg = buildHonestAcousticSpeechSegments({
    pcm: loadedPcm,
    sampleRate: loaded.sampleRate,
    trackId: loaded.tracks[0].id,
    speakerName: loaded.tracks[0].speakerLabel,
    acousticProfile: asset.acousticProfile,
  });
  assert.equal(streamedSeg.burstCount, 3, `Expected 3 bursts after streaming ingest, got ${streamedSeg.burstCount}`);
});

test('50. planAsrTranscriptionChunks and shiftTokensAndRecommendationsByOffset preserve monotonic multi-chunk timestamps and unique IDs', () => {
  const sampleRate = 16_000;
  const totalSamples = sampleRate * 135; // 135 seconds -> 3 chunks (60s, 60s, 15s)
  const chunks = planAsrTranscriptionChunks(totalSamples, sampleRate, 60);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.startSec),
    [0, 60, 120],
  );
  assert.equal(chunks[2].endSample, totalSamples);
  assert.deepEqual(planAsrTranscriptionChunks(0, sampleRate, 60), []);

  const shifted = shiftTokensAndRecommendationsByOffset({
    tokens: [
      {
        id: 'tok-1',
        trackId: 'track-host',
        speakerName: 'سارا',
        originalText: 'سلام',
        normalizedText: 'سلام',
        displayText: 'سلام',
        range: { startFlicks: secondsToFlicks(1.2), endFlicks: secondsToFlicks(1.8) },
        confidence: 0.95,
        alignmentSource: 'ASR',
      },
    ],
    recommendations: [
      {
        id: 'rec-1',
        trackId: 'track-host',
        kind: 'standalone-filler',
        recommendedMode: 'sync-locked-ripple-cut',
        range: { startFlicks: secondsToFlicks(1.2), endFlicks: secondsToFlicks(1.8) },
        relatedText: 'سلام',
        reasonFa: 'تست',
        confidence: 0.9,
        sourceTier: 'Group-B-Persian-ASR',
        status: 'Pending',
        boundary: {
          rawRange: { startFlicks: secondsToFlicks(1.2), endFlicks: secondsToFlicks(1.8) },
          snappedRange: { startFlicks: secondsToFlicks(1.2), endFlicks: secondsToFlicks(1.8) },
          rmsValleyShiftMs: 0,
          zeroCrossingAdjusted: true,
          microCrossfadeMs: 10,
          pitchPlateauDetected: false,
          trailingEzafeRisk: false,
          reasonFa: 'تست',
        },
      },
    ],
    offsetSec: 60,
    chunkIndex: 1,
  });

  assert.equal(shifted.tokens[0].id, 'c1_tok-1');
  assert.equal(shifted.tokens[0].range.startFlicks, secondsToFlicks(61.2));
  assert.equal(shifted.tokens[0].range.endFlicks, secondsToFlicks(61.8));
  assert.equal(shifted.recommendations[0].id, 'c1_rec-1');
  assert.equal(shifted.recommendations[0].range.startFlicks, secondsToFlicks(61.2));
  assert.equal(shifted.recommendations[0].boundary.snappedRange.startFlicks, secondsToFlicks(61.2));
});

// ============================================================================
// AVP-INGEST-TRANSACTION-001 — Atomic OPFS Ingestion Integrity & Rollback Tests
// ============================================================================

function createDeterministicMultiBlockWavFile(params?: {
  sampleRate?: number;
  durationSec?: number;
  fileName?: string;
}): { file: File; pcm: Float32Array; sampleRate: number; totalSamples: number } {
  const sampleRate = params?.sampleRate ?? 16_000;
  const durationSec = params?.durationSec ?? 3.5; // With chunkSeconds=1 => 4 blocks (1s, 1s, 1s, 0.5s)
  const totalSamples = Math.round(sampleRate * durationSec);
  const pcm = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.35;
  }
  const encoded = encodeAndValidateWavExport([pcm], sampleRate);
  const file = new File([encoded.blob], params?.fileName ?? 'atomic-ingest-test.wav', {
    type: 'audio/wav',
  });
  return { file, pcm, sampleRate, totalSamples };
}

interface InjectedIngestBrokerHooks {
  readonly opfsAvailable?: boolean;
  readonly onWriteChunk?: (params: {
    assetId: string;
    chunkIndex: number;
    byteLength: number;
    defaultResult: WritePcmBlockResult;
  }) => Promise<WritePcmBlockResult> | WritePcmBlockResult;
  readonly onFinalize?: (params: {
    assetId: string;
    manifest: PersistedAudioAssetManifest;
  }) => Promise<PersistedAudioAssetManifest | null> | PersistedAudioAssetManifest | null;
  readonly onGetReadyManifest?: (params: {
    assetId: string;
    manifest: PersistedAudioAssetManifest | null;
  }) => Promise<PersistedAudioAssetManifest | null> | PersistedAudioAssetManifest | null;
  readonly onAbort?: (params: {
    assetId: string;
    reason: string;
    targetState: 'abandoned' | 'failed';
  }) => Promise<void> | void;
}

function createInjectedIngestBroker(hooks: InjectedIngestBrokerHooks = {}) {
  const opfsAvailable = hooks.opfsAvailable ?? true;
  const manifests = new Map<string, PersistedAudioAssetManifest>();
  const chunks = new Map<string, Map<number, ArrayBuffer>>();
  const writtenChunkIndexes: number[] = [];
  const abortCalls: Array<{ assetId: string; reason: string; targetState: 'abandoned' | 'failed' }> = [];
  let finalizeCalls = 0;
  let beginCalls = 0;

  const telemetry = (): StorageBrokerTelemetry => ({
    opfsSupported: opfsAvailable,
    syncAccessHandleSupported: false,
    persistentStorageGranted: opfsAvailable ? true : null,
    quotaUsedBytes: 0,
    quotaTotalBytes: 1024 * 1024 * 1024,
    persistenceAvailable: opfsAvailable,
    persistenceStatus: opfsAvailable ? 'OPFS-Writable' : 'OPFS-Unavailable',
    activeLeases: [],
    cacheStats: {
      usedBytes: 0,
      maxBytes: 24 * 1024 * 1024,
      cachedBlocks: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
    },
    workerCacheStats: null,
    totalAudioCacheBudgetBytes: 32 * 1024 * 1024,
    lockConflictsPrevented: 0,
    disposed: false,
    recoveredAssetCount: 0,
    cleanedAbandonedCount: 0,
  });

  const broker: StreamingIngestBroker = {
    isDisposed: () => false,
    getTelemetry: telemetry,
    async beginAssetIngest(manifest) {
      beginCalls++;
      if (!opfsAvailable) {
        return {
          manifest: { ...manifest, state: 'ingesting' },
          persisted: false,
          backend: 'OPFS-Unavailable',
        };
      }
      const stored: PersistedAudioAssetManifest = {
        ...manifest,
        state: 'ingesting',
      };
      manifests.set(manifest.assetId, stored);
      chunks.set(manifest.assetId, new Map());
      return {
        manifest: stored,
        persisted: true,
        backend: 'OPFS-Writable',
      };
    },
    async writeAssetChunk(assetId, chunkIndex, data) {
      writtenChunkIndexes.push(chunkIndex);
      const byteLength = data.byteLength;
      const defaultResult: WritePcmBlockResult = {
        persisted: opfsAvailable,
        backend: opfsAvailable ? 'OPFS-Writable' : 'OPFS-Unavailable',
        bytesWritten: opfsAvailable ? byteLength : 0,
        cachedInMainLru: true,
        blockIndex: chunkIndex,
      };
      const result = hooks.onWriteChunk
        ? await hooks.onWriteChunk({ assetId, chunkIndex, byteLength, defaultResult })
        : defaultResult;

      if (opfsAvailable && result.persisted) {
        let assetChunks = chunks.get(assetId);
        if (!assetChunks) {
          assetChunks = new Map();
          chunks.set(assetId, assetChunks);
        }
        const bytes =
          data instanceof Float32Array
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        assetChunks.set(chunkIndex, copy.buffer);
        const cur = manifests.get(assetId);
        if (cur) {
          manifests.set(assetId, { ...cur, updatedAtMs: Date.now() });
        }
      }
      return result;
    },
    async finalizeAsset(assetId, patch) {
      finalizeCalls++;
      const cur = manifests.get(assetId);
      if (!cur) return null;
      const now = Date.now();
      const finalized: PersistedAudioAssetManifest = {
        ...cur,
        ...(patch ?? {}),
        assetId,
        state: 'ready',
        updatedAtMs: now,
        finalizedAtMs: now,
      };
      manifests.set(assetId, finalized);
      if (hooks.onFinalize) {
        const overridden = await hooks.onFinalize({ assetId, manifest: finalized });
        if (overridden) {
          manifests.set(assetId, overridden);
        }
        return overridden;
      }
      return finalized;
    },
    async abortAssetIngest(assetId, reason, targetState = 'failed') {
      abortCalls.push({ assetId, reason, targetState });
      chunks.delete(assetId);
      const cur = manifests.get(assetId);
      if (cur) {
        manifests.set(assetId, {
          ...cur,
          state: targetState,
          errorMessage: reason,
          updatedAtMs: Date.now(),
          finalizedAtMs: null,
        });
      }
      if (hooks.onAbort) {
        await hooks.onAbort({ assetId, reason, targetState });
      }
    },
    async getReadyAssetManifest(assetId) {
      const cur = manifests.get(assetId) ?? null;
      const ready = cur && cur.state === 'ready' ? cur : null;
      if (hooks.onGetReadyManifest) {
        return hooks.onGetReadyManifest({ assetId, manifest: ready });
      }
      return ready;
    },
    async streamReadRange(assetId, startSample, length, blockSizeSamples, fallbackSource) {
      const out = new Float32Array(length);
      const assetChunks = chunks.get(assetId);
      if (assetChunks && assetChunks.size > 0) {
        const firstBlock = Math.floor(startSample / blockSizeSamples);
        const lastBlock = Math.floor((startSample + length - 1) / blockSizeSamples);
        let written = 0;
        for (let b = firstBlock; b <= lastBlock; b++) {
          const buf = assetChunks.get(b);
          if (!buf) continue;
          const view = new Float32Array(buf);
          const blockStart = b * blockSizeSamples;
          const sliceStart = Math.max(0, startSample - blockStart);
          const sliceEnd = Math.min(view.length, startSample + length - blockStart);
          if (sliceEnd > sliceStart) {
            out.set(view.subarray(sliceStart, sliceEnd), written);
            written += sliceEnd - sliceStart;
          }
        }
        return out;
      }
      if (fallbackSource) {
        const end = Math.min(fallbackSource.length, startSample + length);
        if (end > startSample) {
          out.set(fallbackSource.subarray(startSample, end), 0);
        }
      }
      return out;
    },
  };

  return {
    broker,
    manifests,
    chunks,
    writtenChunkIndexes,
    abortCalls,
    getFinalizeCalls: () => finalizeCalls,
    getBeginCalls: () => beginCalls,
  };
}

function createInMemoryOpfsRoot(): OpfsDirectoryLike {
  const createDir = (): OpfsDirectoryLike => {
    const files = new Map<string, ArrayBuffer>();
    const dirs = new Map<string, OpfsDirectoryLike>();
    return {
      async getFileHandle(name, options) {
        if (!files.has(name)) {
          if (!options?.create) {
            throw new Error(`NotFoundError: ${name}`);
          }
          files.set(name, new ArrayBuffer(0));
        }
        return {
          async createWritable() {
            return {
              async write(data: ArrayBuffer | string) {
                if (typeof data === 'string') {
                  const encoded = new TextEncoder().encode(data);
                  files.set(name, encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
                } else {
                  files.set(name, data.slice(0));
                }
              },
              async close() {},
            };
          },
          async getFile() {
            const data = files.get(name);
            if (!data) throw new Error(`NotFoundError: ${name}`);
            return {
              size: data.byteLength,
              async arrayBuffer() {
                return data.slice(0);
              },
              async text() {
                return new TextDecoder().decode(new Uint8Array(data));
              },
            };
          },
        };
      },
      async getDirectoryHandle(name, options) {
        let sub = dirs.get(name);
        if (!sub) {
          if (!options?.create) {
            throw new Error(`NotFoundError: dir ${name}`);
          }
          sub = createDir();
          dirs.set(name, sub);
        }
        return sub;
      },
      async removeEntry(name) {
        files.delete(name);
        dirs.delete(name);
      },
      async *entries() {
        for (const name of files.keys()) {
          yield [name, { kind: 'file' as const, name }];
        }
        for (const name of dirs.keys()) {
          yield [name, { kind: 'directory' as const, name }];
        }
      },
    };
  };
  return createDir();
}

function createRealBackedStorageBroker(root: OpfsDirectoryLike): StorageBrokerClient {
  class CoreBackedWorker implements BrokerWorkerLike {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent | { message?: string }) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    private readonly core = new WorkerStorageCore(async () => root);

    postMessage(message: unknown): void {
      const req = message as WorkerBrokerRequest;
      void this.core
        .handleMessage(req)
        .then(({ payload }) => {
          this.onmessage?.({ data: { id: req.id, ok: true, payload } } as MessageEvent);
        })
        .catch((err) => {
          this.onmessage?.({
            data: {
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
          } as MessageEvent);
        });
    }

    terminate(): void {}
  }

  return new StorageBrokerClient({
    workerFactory: () => new CoreBackedWorker(),
  });
}

test('51. Atomic ingest: all blocks persist successfully -> COMMITTED with exact accounting and ready manifest', async () => {
  const { file, totalSamples, sampleRate } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker();
  const states: string[] = [];

  const loaded = await ingestAudioFileStreaming(file, {
    broker: harness.broker,
    chunkSeconds: 1,
    onTransactionChange: (snap) => states.push(snap.state),
  });

  const asset = Object.values(loaded.assets)[0];
  assert.equal(asset.storageLifecycle, 'ready');
  assert.equal(asset.storageBackend, 'OPFS-Writable');
  assert.ok(asset.ingestTransaction, 'Expected ingestTransaction snapshot on committed asset');
  assert.equal(asset.ingestTransaction.state, 'COMMITTED');
  assert.equal(asset.ingestTransaction.expectedBlockCount, 4);
  assert.equal(asset.ingestTransaction.successfullyPersistedBlockCount, 4);
  assert.deepEqual(asset.ingestTransaction.persistedBlockIndexes, [0, 1, 2, 3]);
  assert.deepEqual(asset.ingestTransaction.failedBlockIndexes, []);
  assert.equal(asset.ingestTransaction.expectedBytes, totalSamples * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(asset.ingestTransaction.persistedBytes, totalSamples * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(typeof asset.ingestTransaction.commitTimestamp, 'number');
  assert.equal(harness.getFinalizeCalls(), 1);
  assert.equal(harness.abortCalls.length, 0);
  assert.equal(states[0], 'INITIALIZING');
  assert.ok(states.includes('WRITING'));
  assert.ok(states.includes('VERIFYING'));
  assert.equal(states[states.length - 1], 'COMMITTED');

  const readyManifest = await harness.broker.getReadyAssetManifest(asset.id);
  assert.ok(readyManifest);
  assert.equal(readyManifest.state, 'ready');
  assert.equal(readyManifest.totalBlocks, 4);
  assert.equal(readyManifest.totalSamples, totalSamples);
  assert.equal(readyManifest.sampleRate, sampleRate);
});

test('52. Atomic ingest: first block fails -> FAILED + deterministic rollback with zero ready manifest', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, defaultResult }) =>
      chunkIndex === 0 ? { ...defaultResult, persisted: false, bytesWritten: 0 } : defaultResult,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_CHUNK_PERSISTENCE_FAILED');
      assert.equal(err.transaction.state, 'FAILED');
      assert.deepEqual(err.transaction.failedBlockIndexes, [0]);
      assert.deepEqual(err.transaction.persistedBlockIndexes, []);
      assert.equal(err.transaction.commitTimestamp, null);
      return true;
    },
  );

  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.abortCalls.length, 1);
  assert.deepEqual(harness.writtenChunkIndexes, [0]);
  const assetId = harness.abortCalls[0].assetId;
  assert.equal(harness.chunks.has(assetId), false);
  assert.equal(await harness.broker.getReadyAssetManifest(assetId), null);
  assert.equal(harness.manifests.get(assetId)?.state, 'failed');
});

test('53. Atomic ingest: middle block fails -> FAILED + rollback cleans prior persisted blocks', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, defaultResult }) =>
      chunkIndex === 1 ? { ...defaultResult, persisted: false, bytesWritten: 0 } : defaultResult,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_CHUNK_PERSISTENCE_FAILED');
      assert.equal(err.transaction.state, 'FAILED');
      assert.deepEqual(err.transaction.persistedBlockIndexes, [0]);
      assert.deepEqual(err.transaction.failedBlockIndexes, [1]);
      return true;
    },
  );

  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.abortCalls.length, 1);
  assert.deepEqual(harness.writtenChunkIndexes, [0, 1]);
  const assetId = harness.abortCalls[0].assetId;
  assert.equal(harness.chunks.has(assetId), false);
  assert.equal(await harness.broker.getReadyAssetManifest(assetId), null);
});

test('54. Atomic ingest: final block fails -> FAILED + rollback cleans all earlier blocks and blocks finalization', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, defaultResult }) =>
      chunkIndex === 3 ? { ...defaultResult, persisted: false, bytesWritten: 0 } : defaultResult,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_CHUNK_PERSISTENCE_FAILED');
      assert.equal(err.transaction.state, 'FAILED');
      assert.deepEqual(err.transaction.persistedBlockIndexes, [0, 1, 2]);
      assert.deepEqual(err.transaction.failedBlockIndexes, [3]);
      return true;
    },
  );

  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.abortCalls.length, 1);
  const assetId = harness.abortCalls[0].assetId;
  assert.equal(harness.chunks.has(assetId), false);
  assert.equal(await harness.broker.getReadyAssetManifest(assetId), null);
});

test('55. Atomic ingest: one block returns fewer bytes than expected -> FAILED + rollback', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, byteLength, defaultResult }) =>
      chunkIndex === 2
        ? { ...defaultResult, persisted: true, bytesWritten: byteLength - 64 }
        : defaultResult,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_CHUNK_BYTE_MISMATCH');
      assert.equal(err.transaction.state, 'FAILED');
      assert.deepEqual(err.transaction.failedBlockIndexes, [2]);
      return true;
    },
  );

  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(await harness.broker.getReadyAssetManifest(harness.abortCalls[0].assetId), null);
});

test('56. Atomic ingest: duplicate block acknowledgement -> FAILED + rollback (and StorageBrokerClient rejects duplicate block writes)', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, defaultResult }) =>
      chunkIndex === 1 ? { ...defaultResult, blockIndex: 0 } : defaultResult,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_DUPLICATE_BLOCK_ACK');
      assert.equal(err.transaction.state, 'FAILED');
      assert.deepEqual(err.transaction.failedBlockIndexes, [1]);
      return true;
    },
  );
  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.abortCalls.length, 1);

  // Also verify StorageBrokerClient itself rejects duplicate block index writes and invalidates the transaction
  const root = createInMemoryOpfsRoot();
  const realBroker = createRealBackedStorageBroker(root);
  await realBroker.init();
  const now = Date.now();
  const manifest: PersistedAudioAssetManifest = {
    assetId: 'asset-dup-block-check',
    fileName: 'dup.wav',
    mimeType: 'audio/wav',
    fileSizeBytes: 1024,
    contentSha256: 'sha256:dup-block-check',
    sampleRate: 16_000,
    channels: 1,
    totalSamples: 1024,
    blockSizeSamples: 512,
    totalBlocks: 2,
    bytesPerSample: Float32Array.BYTES_PER_ELEMENT,
    state: 'ingesting',
    createdAtMs: now,
    updatedAtMs: now,
    finalizedAtMs: null,
  };
  await realBroker.beginAssetIngest(manifest);
  const first = await realBroker.writeAssetChunk(manifest.assetId, 0, new Float32Array(512));
  assert.equal(first.persisted, true);
  assert.equal(first.blockIndex, 0);

  await assert.rejects(
    realBroker.writeAssetChunk(manifest.assetId, 0, new Float32Array(512)),
    /BROKER_DUPLICATE_BLOCK_WRITE/,
  );
  await assert.rejects(
    realBroker.finalizeAsset(manifest.assetId),
    /failed|cannot be finalized/i,
  );
  realBroker.dispose();
});

test('57. Atomic ingest: missing block before finalization -> finalization rejected on both tracker and StorageBrokerClient', async () => {
  // 1) Transaction tracker refuses VERIFYING when a block is missing
  const tracker = new IngestTransactionTracker({
    assetId: 'asset-missing-block',
    expectedBlockCount: 3,
    expectedBytes: 3 * 512 * 4,
    totalSamples: 3 * 512,
    blockSizeSamples: 512,
  });
  tracker.beginWriting();
  tracker.acknowledgeBlockWrite({
    expectedBlockIndex: 0,
    expectedChunkBytes: 512 * 4,
    result: {
      persisted: true,
      backend: 'OPFS-Writable',
      bytesWritten: 512 * 4,
      cachedInMainLru: true,
      blockIndex: 0,
    },
  });
  tracker.acknowledgeBlockWrite({
    expectedBlockIndex: 2,
    expectedChunkBytes: 512 * 4,
    result: {
      persisted: true,
      backend: 'OPFS-Writable',
      bytesWritten: 512 * 4,
      cachedInMainLru: true,
      blockIndex: 2,
    },
  });
  assert.throws(
    () => tracker.enterVerifying(),
    (err: unknown) =>
      err instanceof IngestTransactionError && err.code === 'INGEST_INCOMPLETE_PERSISTENCE',
  );

  // 2) StorageBrokerClient rejects finalizeAsset when block 1 of [0,1,2] is missing
  const root = createInMemoryOpfsRoot();
  const realBroker = createRealBackedStorageBroker(root);
  await realBroker.init();
  const now = Date.now();
  const manifest: PersistedAudioAssetManifest = {
    assetId: 'asset-missing-broker',
    fileName: 'missing.wav',
    mimeType: 'audio/wav',
    fileSizeBytes: 6144,
    contentSha256: 'sha256:missing-broker',
    sampleRate: 16_000,
    channels: 1,
    totalSamples: 1536,
    blockSizeSamples: 512,
    totalBlocks: 3,
    bytesPerSample: Float32Array.BYTES_PER_ELEMENT,
    state: 'ingesting',
    createdAtMs: now,
    updatedAtMs: now,
    finalizedAtMs: null,
  };
  await realBroker.beginAssetIngest(manifest);
  await realBroker.writeAssetChunk(manifest.assetId, 0, new Float32Array(512));
  await realBroker.writeAssetChunk(manifest.assetId, 2, new Float32Array(512));

  await assert.rejects(
    realBroker.finalizeAsset(manifest.assetId),
    /BROKER_INCOMPLETE_BLOCKS/,
  );
  assert.equal(await realBroker.getReadyAssetManifest(manifest.assetId), null);
  // Once failed, transaction cannot later be finalized even if block 1 is attempted
  await assert.rejects(
    realBroker.writeAssetChunk(manifest.assetId, 1, new Float32Array(512)),
    /not active|failed/i,
  );
  await assert.rejects(
    realBroker.finalizeAsset(manifest.assetId),
    /failed|cannot be finalized/i,
  );
  realBroker.dispose();
});

test('58. Atomic ingest: manifest reports incorrect block count -> FAILED + rollback', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onGetReadyManifest: ({ manifest }) =>
      manifest ? { ...manifest, totalBlocks: manifest.totalBlocks - 1 } : null,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_MANIFEST_VALIDATION_FAILED');
      assert.equal(err.transaction.state, 'FAILED');
      return true;
    },
  );
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(harness.chunks.has(harness.abortCalls[0].assetId), false);
});

test('59. Atomic ingest: manifest reports incorrect sample count -> FAILED + rollback', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onGetReadyManifest: ({ manifest }) =>
      manifest ? { ...manifest, totalSamples: manifest.totalSamples - 128 } : null,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_MANIFEST_VALIDATION_FAILED');
      assert.equal(err.transaction.state, 'FAILED');
      return true;
    },
  );
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(harness.chunks.has(harness.abortCalls[0].assetId), false);
});

test('60. Atomic ingest: final manifest remains ingesting -> FAILED + rollback', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({
    onFinalize: ({ manifest }) => ({ ...manifest, state: 'ingesting' }),
    onGetReadyManifest: ({ assetId }) => harness.manifests.get(assetId) ?? null,
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_MANIFEST_VALIDATION_FAILED');
      assert.equal(err.transaction.state, 'FAILED');
      return true;
    },
  );
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(harness.manifests.get(harness.abortCalls[0].assetId)?.state, 'failed');
});

test('61. Atomic ingest: finalization throws unexpectedly -> FAILED + rollback preserving original exception', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const boom = new Error('Simulated OPFS manifest flush I/O failure');
  const harness = createInjectedIngestBroker({
    onFinalize: () => {
      throw boom;
    },
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.equal(err, boom, 'Original finalization exception must be preserved verbatim');
      const annotated = err as Error & {
        transaction?: IngestTransactionSnapshot;
        rollbackError?: unknown;
      };
      assert.equal(annotated.transaction?.state, 'FAILED');
      assert.equal(annotated.transaction?.commitTimestamp, null);
      return true;
    },
  );
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(harness.chunks.has(harness.abortCalls[0].assetId), false);
});

test('62. Atomic ingest: rollback throws -> original primary error is preserved verbatim and rollback error recorded separately', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const primaryErr = new Error('Primary write failure on block 2: disk full');
  const rollbackErr = new Error('Secondary rollback error: OPFS handle locked');
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, defaultResult }) => {
      if (chunkIndex === 2) {
        throw primaryErr;
      }
      return defaultResult;
    },
    onAbort: () => {
      throw rollbackErr;
    },
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, { broker: harness.broker, chunkSeconds: 1 }),
    (err: unknown) => {
      assert.equal(err, primaryErr, 'Primary write exception must not be masked by rollback failure');
      const annotated = err as Error & {
        transaction?: IngestTransactionSnapshot;
        rollbackError?: unknown;
      };
      assert.equal(annotated.rollbackError, rollbackErr);
      assert.match(
        annotated.transaction?.rollbackError ?? '',
        /Secondary rollback error: OPFS handle locked/,
      );
      assert.equal(annotated.transaction?.state, 'FAILED');
      assert.deepEqual(annotated.transaction?.failedBlockIndexes, [2]);
      return true;
    },
  );
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(harness.getFinalizeCalls(), 0);
});

test('63. Atomic ingest: OPFS unavailable initially -> valid complete memory fallback without marking OPFS persisted', async () => {
  const { file, pcm, totalSamples } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({ opfsAvailable: false });

  const loaded = await ingestAudioFileStreaming(file, {
    broker: harness.broker,
    chunkSeconds: 1,
    retainFallbackWhenOpfsUnavailable: true,
  });

  const asset = Object.values(loaded.assets)[0];
  assert.equal(asset.storageLifecycle, undefined);
  assert.equal(asset.storageBackend, 'Memory-Bounded-Fallback');
  assert.equal(asset.ingestTransaction, undefined);
  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.writtenChunkIndexes.length, 0);

  const assembled = loaded.pcmSources[asset.id];
  assert.ok(assembled instanceof Float32Array);
  assert.equal(assembled.length, totalSamples);
  // Spot-check sample integrity across first, middle, and final blocks
  assert.ok(Math.abs(assembled[100] - pcm[100]) < 1e-3);
  assert.ok(Math.abs(assembled[24_000] - pcm[24_000]) < 1e-3);
  assert.ok(Math.abs(assembled[totalSamples - 10] - pcm[totalSamples - 10]) < 1e-3);
});

test('64. Atomic ingest: OPFS unavailable with memory fallback disabled -> explicit storage failure', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const harness = createInjectedIngestBroker({ opfsAvailable: false });

  await assert.rejects(
    ingestAudioFileStreaming(file, {
      broker: harness.broker,
      chunkSeconds: 1,
      retainFallbackWhenOpfsUnavailable: false,
    }),
    (err: unknown) => {
      assert.ok(err instanceof IngestTransactionError);
      assert.equal(err.code, 'INGEST_STORAGE_UNAVAILABLE');
      assert.equal(err.transaction.state, 'FAILED');
      return true;
    },
  );
  assert.equal(harness.getFinalizeCalls(), 0);
});

test('65. Atomic ingest: AbortSignal fires during persistence -> ABORTED + rollback', async () => {
  const { file } = createDeterministicMultiBlockWavFile();
  const controller = new AbortController();
  const seenStates: IngestTransactionSnapshot['state'][] = [];
  const harness = createInjectedIngestBroker({
    onWriteChunk: ({ chunkIndex, defaultResult }) => {
      if (chunkIndex === 1) {
        controller.abort();
      }
      return defaultResult;
    },
  });

  await assert.rejects(
    ingestAudioFileStreaming(file, {
      broker: harness.broker,
      chunkSeconds: 1,
      abortSignal: controller.signal,
      onTransactionChange: (snap) => seenStates.push(snap.state),
    }),
    (err: unknown) => {
      assert.ok(err instanceof IngestAbortedError);
      assert.equal(err.code, 'INGEST_ABORTED');
      assert.equal(err.transaction?.state, 'ABORTED');
      return true;
    },
  );

  assert.equal(harness.getFinalizeCalls(), 0);
  assert.equal(harness.abortCalls.length, 1);
  assert.equal(harness.abortCalls[0].targetState, 'abandoned');
  assert.equal(harness.chunks.has(harness.abortCalls[0].assetId), false);
  assert.equal(await harness.broker.getReadyAssetManifest(harness.abortCalls[0].assetId), null);
  assert.ok(seenStates.includes('ABORTING'));
  assert.equal(seenStates[seenStates.length - 1], 'ABORTED');
});

test('66. StorageBrokerClient: concurrent duplicate finalization yields exactly one commit, idempotent abort, and rejects conflicting active begins', async () => {
  const root = createInMemoryOpfsRoot();
  const broker = createRealBackedStorageBroker(root);
  await broker.init();

  const now = Date.now();
  const manifest: PersistedAudioAssetManifest = {
    assetId: 'asset-concurrent-finalize',
    fileName: 'concurrent.wav',
    mimeType: 'audio/wav',
    fileSizeBytes: 8192,
    contentSha256: 'sha256:concurrent-finalize',
    sampleRate: 16_000,
    channels: 1,
    totalSamples: 2048,
    blockSizeSamples: 1024,
    totalBlocks: 2,
    bytesPerSample: Float32Array.BYTES_PER_ELEMENT,
    state: 'ingesting',
    createdAtMs: now,
    updatedAtMs: now,
    finalizedAtMs: null,
  };

  const beginRes = await broker.beginAssetIngest(manifest);
  assert.equal(beginRes.persisted, true);

  // Conflicting active begin for same assetId must be rejected unambiguously
  await assert.rejects(
    broker.beginAssetIngest(manifest),
    /BROKER_TRANSACTION_CONFLICT/,
  );

  const w0 = await broker.writeAssetChunk(manifest.assetId, 0, new Float32Array(1024).fill(0.1));
  const w1 = await broker.writeAssetChunk(manifest.assetId, 1, new Float32Array(1024).fill(0.2));
  assert.equal(w0.persisted, true);
  assert.equal(w1.persisted, true);

  // Fire two concurrent finalizeAsset calls for the same asset
  const results = await Promise.allSettled([
    broker.finalizeAsset(manifest.assetId),
    broker.finalizeAsset(manifest.assetId),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'Expected exactly one successful commit');
  assert.equal(rejected.length, 1, 'Expected second concurrent finalization to be rejected');
  assert.equal(
    (fulfilled[0] as PromiseFulfilledResult<PersistedAudioAssetManifest | null>).value?.state,
    'ready',
  );
  assert.match(
    String((rejected[0] as PromiseRejectedResult).reason),
    /BROKER_ALREADY_COMMITTED/,
  );

  const readyManifest = await broker.getReadyAssetManifest(manifest.assetId);
  assert.ok(readyManifest);
  assert.equal(readyManifest.state, 'ready');
  assert.equal(readyManifest.totalBlocks, 2);

  // Verify idempotent abortAssetIngest on a second asset
  const abortManifest: PersistedAudioAssetManifest = {
    ...manifest,
    assetId: 'asset-idempotent-abort',
  };
  await broker.beginAssetIngest(abortManifest);
  await broker.writeAssetChunk(abortManifest.assetId, 0, new Float32Array(1024).fill(0.5));
  await broker.abortAssetIngest(abortManifest.assetId, 'first abort', 'failed');
  await broker.abortAssetIngest(abortManifest.assetId, 'second idempotent abort', 'failed');
  assert.equal(await broker.getReadyAssetManifest(abortManifest.assetId), null);
  await assert.rejects(
    broker.finalizeAsset(abortManifest.assetId),
    /failed|cannot be finalized/i,
  );

  broker.dispose();
});

test('67. Memory fallback retention: OPFS-committed ingest retains zero resident fallback PCM, while non-OPFS fallback transfers exact lease ownership', async () => {
  const { file, totalSamples } = createDeterministicMultiBlockWavFile();
  const { MemoryBudgetManager } = await import('../runtime/memory/MemoryBudgetManager');
  const { AVAPARDAZ_MEMORY_POLICY } = await import('../runtime/memory/MemoryPolicy');

  // OPFS available: zero resident fallback PCM, zero lingering reservations, no fallback lease
  const opfsBudget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const opfsHarness = createInjectedIngestBroker({ opfsAvailable: true });
  const opfsLoaded = await ingestAudioFileStreaming(file, {
    broker: opfsHarness.broker,
    memoryBudgetManager: opfsBudget,
    chunkSeconds: 1,
  });
  assert.equal(Object.keys(opfsLoaded.pcmSources).length, 0);
  assert.equal(opfsLoaded.runtimeResourceLease, undefined);
  assert.equal(opfsBudget.getSnapshot().accountedBytes, 0);
  assert.equal(opfsBudget.getSnapshot().reservationCount, 0);

  // OPFS unavailable: single resident PCM buffer + exact reservation transferred to runtimeResourceLease
  const memBudget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const memHarness = createInjectedIngestBroker({ opfsAvailable: false });
  const memLoaded = await ingestAudioFileStreaming(file, {
    broker: memHarness.broker,
    memoryBudgetManager: memBudget,
    chunkSeconds: 1,
  });
  const assetId = Object.keys(memLoaded.assets)[0];
  const expectedBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  assert.equal(memLoaded.pcmSources[assetId]?.length, totalSamples);
  assert.equal(memBudget.getSnapshot().accountedBytes, expectedBytes);
  assert.ok(memLoaded.runtimeResourceLease);
  assert.equal(memLoaded.runtimeResourceLease.disposed, false);

  memLoaded.runtimeResourceLease.dispose();
  assert.equal(memLoaded.runtimeResourceLease.disposed, true);
  assert.equal(memBudget.getSnapshot().accountedBytes, 0);
  assert.equal(memBudget.getSnapshot().reservationCount, 0);
});

test('68. Render artifact lifecycle hardening: engine retains sink reservations until artifact disposal and workflow controller releases previous artifacts on replacement', async () => {
  const { MemoryBudgetManager } = await import('../runtime/memory/MemoryBudgetManager');
  const { AVAPARDAZ_MEMORY_POLICY } = await import('../runtime/memory/MemoryPolicy');
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const ctrl = new StudioWorkflowController({ memoryBudgetManager: budget });

  const sampleRate = 48_000 as const;
  const pcm = new Float32Array(sampleRate);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
  }

  ctrl.openProject({
    projectId: 'proj_art_hardening_1',
    projectName: 'Artifact Hardening 1',
    sourceAudio: {
      sourceAudioId: 'src_art_1',
      sourceAudioHash: 'sha256:art-hardening-1',
      fileName: 'art1.wav',
      format: 'wav',
      sampleRate,
      channelCount: 1,
      bitDepth: 32,
      totalSamples: pcm.length,
      durationSec: 1,
      fileSizeBytes: pcm.byteLength,
      importStatus: 'VALIDATED',
      isDemoFixture: false,
    },
  });

  await ctrl.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-main',
    pcmMono: pcm,
    sampleRate,
    wordTokens: [],
  });

  const firstRes = await ctrl.startRender({
    pcmChannels: [pcm],
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 1000,
  });
  assert.equal(firstRes?.ok, true);
  assert.ok(firstRes?.outputArtifact);
  const firstArtifact = firstRes.outputArtifact;
  assert.equal(firstArtifact.disposed, false);
  assert.equal(firstArtifact.lifecycleState, 'ACTIVE_IN_WORKFLOW');
  assert.ok(budget.getSnapshot().accountedBytes >= firstArtifact.sizeBytes);

  // Starting a second render must dispose the first artifact before replacing it
  const secondRes = await ctrl.startRender({
    pcmChannels: [pcm],
    config: { encoding: 'pcm24', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 2000,
  });
  assert.equal(firstArtifact.disposed, true);
  await assert.rejects(() => firstArtifact.readRange(0, 44));
  assert.equal(secondRes?.ok, true);
  assert.ok(secondRes?.outputArtifact);
  const secondArtifact = secondRes.outputArtifact;
  assert.equal(secondArtifact.disposed, false);

  // Switching project must dispose the second artifact and release all reservations
  ctrl.openProject({
    projectId: 'proj_art_hardening_2',
    projectName: 'Artifact Hardening 2',
    sourceAudio: null,
  });
  assert.equal(secondArtifact.disposed, true);
  assert.equal(ctrl.getState().lastRenderResult, null);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);

  ctrl.dispose();
});

test('69. Application upload-to-OPFS integration: single real-backed StorageBrokerClient, awaited init, atomic commit, active PCM mirror, failure isolation, and truthful memory-only fallback', async () => {
  const { importAudioProject } = await import('../workflow/AudioImportCoordinator');
  const { MemoryBudgetManager } = await import('../runtime/memory/MemoryBudgetManager');
  const { AVAPARDAZ_MEMORY_POLICY } = await import('../runtime/memory/MemoryPolicy');
  const { ProjectResourceLeaseSlot } = await import('./streamingIngest');

  const { file, totalSamples } = createDeterministicMultiBlockWavFile();
  const root = createInMemoryOpfsRoot();
  const broker = createRealBackedStorageBroker(root);
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const leaseSlot = new ProjectResourceLeaseSlot();

  // Start init asynchronously and immediately invoke importAudioProject with the barrier
  const brokerReady = broker.init();
  const loaded = await importAudioProject(file, {
    broker,
    brokerReady,
    memoryBudgetManager: budget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });

  const assetId = Object.keys(loaded.assets)[0];
  const asset = loaded.assets[assetId];
  assert.ok(asset);
  assert.equal(asset.storageLifecycle, 'ready');
  assert.ok(
    asset.storageBackend === 'OPFS-SyncAccessHandle' ||
      asset.storageBackend === 'OPFS-Writable',
    `Expected authoritative OPFS backend, got ${String(asset.storageBackend)}`,
  );
  assert.equal(asset.ingestTransaction?.state, 'COMMITTED');
  assert.equal(
    asset.ingestTransaction?.successfullyPersistedBlockCount,
    asset.seekTable.length,
  );

  // Ready manifest in real OPFS root matches all 7 mandatory invariants
  const readyManifest = await broker.getReadyAssetManifest(assetId);
  assert.ok(readyManifest);
  assert.equal(readyManifest.assetId, asset.id);
  assert.equal(readyManifest.state, 'ready');
  assert.equal(readyManifest.contentSha256, asset.contentHash);
  assert.equal(readyManifest.totalSamples, asset.exactSampleCount);
  assert.equal(readyManifest.totalBlocks, asset.seekTable.length);
  assert.equal(readyManifest.bytesPerSample, Float32Array.BYTES_PER_ELEMENT);
  assert.equal(readyManifest.blockSizeSamples, asset.blockSizeSamples);

  // Active PCM mirror is populated and accounted for exact totalSamples * 4 bytes (OPFS disk not counted)
  const expectedRamBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  assert.equal(loaded.pcmSources[assetId]?.length, totalSamples);
  assert.ok(loaded.runtimeResourceLease && !loaded.runtimeResourceLease.disposed);
  assert.equal(budget.getSnapshot().accountedBytes, expectedRamBytes);
  leaseSlot.replaceWith(loaded.runtimeResourceLease);

  // Injected storage failure during a subsequent upload MUST preserve the previous active project & lease
  const failingHarness = createInjectedIngestBroker({
    opfsAvailable: true,
    onWriteChunk: async ({ chunkIndex, defaultResult }) =>
      chunkIndex === 1
        ? { ...defaultResult, persisted: false, bytesWritten: 0, backend: 'OPFS-Unavailable' }
        : defaultResult,
  });
  await assert.rejects(() =>
    importAudioProject(file, {
      broker: failingHarness.broker,
      brokerReady: Promise.resolve(failingHarness.broker.getTelemetry()),
      memoryBudgetManager: budget,
      retainActivePcmMirror: true,
      chunkSeconds: 1,
    }),
  );
  assert.equal(loaded.runtimeResourceLease.disposed, false);
  assert.equal(budget.getSnapshot().accountedBytes, expectedRamBytes);
  assert.equal(failingHarness.abortCalls.length, 1);

  // Truthful memory-only fallback when OPFS is genuinely unavailable
  const fallbackBudget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const unavailableBroker = new StorageBrokerClient(); // No worker/OPFS in Node environment
  const unavailableReady = unavailableBroker.init();
  const fallbackLoaded = await importAudioProject(file, {
    broker: unavailableBroker,
    brokerReady: unavailableReady,
    memoryBudgetManager: fallbackBudget,
    retainActivePcmMirror: true,
    chunkSeconds: 1,
  });
  const fbAssetId = Object.keys(fallbackLoaded.assets)[0];
  const fbAsset = fallbackLoaded.assets[fbAssetId];
  assert.notEqual(fbAsset.storageLifecycle, 'ready');
  assert.equal(fbAsset.storageBackend, 'Memory-Bounded-Fallback');
  assert.equal(fallbackLoaded.pcmSources[fbAssetId]?.length, totalSamples);
  assert.equal(fallbackBudget.getSnapshot().accountedBytes, expectedRamBytes);

  fallbackLoaded.runtimeResourceLease?.dispose();
  assert.equal(fallbackBudget.getSnapshot().accountedBytes, 0);
  unavailableBroker.dispose();

  leaseSlot.clear();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  broker.dispose();
});




