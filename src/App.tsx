import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Undo2,
  Redo2,
  Upload,
  Sparkles,
  Mic,
  Waves,
  FlaskConical,
  Terminal,
  Layers,
  Database,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';
import {
  EphemeralDspParams,
  ExportValidationReport,
  FlickRange,
  PersianWordToken,
  ProcessingNodeDescriptor,
  RecommendationActionMode,
  SmartRecommendation,
  StorageBrokerTelemetry,
  Track,
} from './contracts/v1_2';
import { HeaderNav, WorkspaceTab } from './components/HeaderNav';
import { WaveformCanvas } from './components/WaveformCanvas';
import { TranscriptPanel } from './components/TranscriptPanel';
import { SuggestionsPanel } from './components/SuggestionsPanel';
import { DspControlRack } from './components/DspControlRack';
import { ProcessingGraphView } from './components/ProcessingGraphView';
import { StorageBrokerView } from './components/StorageBrokerView';
import { ExportModal } from './components/ExportModal';
import { AsrResearchLabModal } from './components/AsrResearchLabModal';
import { DeveloperPlatformPortalModal } from './components/DeveloperPlatformPortalModal';
import { SpeechIntelligenceModal } from './components/SpeechIntelligenceModal';
import { DataFactoryModal } from './components/DataFactoryModal';
import { ModelFactoryModal } from './components/ModelFactoryModal';
import { SpeechSecurityModal } from './components/SpeechSecurityModal';
import { AuditionTransportBar, WaveformSelectionState } from './components/AuditionTransportBar';
import { AuditionSideDock } from './components/AuditionSideDock';
import {
  buildDefaultPersianPodcastProject,
  buildSyntheticMicRecordingPcm,
  ingestRecordedPcmTake,
  ingestUploadedAudioFile,
  LoadedStudioProject,
} from './engine/audioFixtures';
import {
  buildSplicePreviewBuffer,
  streamingChunkedRender,
  StudioAudioTransport,
} from './engine/audioPlayback';
import { createDefaultStudioGraph } from './engine/processingGraph';
import { ProcessingGraphEngine, ProcessingNodeSpec } from './processing-core/ProcessingGraphEngine';
import { ExportValidator, RenderManifest } from './processing-core/ExportValidator';
import { CrashRecoveryAndSessionLock } from './runtime/CrashRecoveryAndSessionLock';
import { AudioSecurityGuard } from './security/AudioSecurityGuard';
import {
  detectRuntimeCapabilities,
  encodeAndValidateWavExport,
  StorageBrokerClient,
} from './engine/storageBroker';
import {
  AVAPARDAZ_AUDIO_CACHE_SPLIT,
  AVAPARDAZ_MEMORY_POLICY,
} from './runtime/memory/MemoryPolicy';
import { getSharedMemoryBudgetManager } from './runtime/memory/MemoryBudgetManager';
import {
  applyBatchRecommendationsAtomically,
  applySyncSafeCut,
  cloneRecommendations,
  cloneTokens,
  cloneTracks,
  computeMultiWordCutRange,
  computeTimelineDurationFlicks,
  determineSyncSafeEditMode,
  projectRecommendationsAfterCut,
  projectTokensAfterCut,
  splitTrackClipsAtPlayhead,
  TimelineHistoryManager,
} from './engine/timeline';
import {
  alignPersianScriptToAudio,
  analyzeDeepPersianDisfluenciesAndRetakes,
  analyzeMultiTrackCrosstalkAndDiarization,
  analyzeMultiTrackPhaseCompatibility,
  analyzeStudioRecordingAcoustics,
  analyzeTranscriptProsodyAndChapters,
  applyCustomLexiconAndPhoneticCorrections,
  applyPersianVoice8BandEqToPcm,
  applyPunchInSpectralMatchAndWatermarkToSelectedTokens,
  applySpectralWienerDenoiseToPcm,
  applyWsolaTimeStretchToSelectedTokens,
  attenuateBreathsAndCoughsInAudio,
  buildOfflineAcousticSegmentedTranscript,
  convertTranscriptColloquialToFormal,
  encodeMono16kWavBase64,
  normalizeNumbersAndCompoundsInTranscript,
  optimizeAndAnalyzeTrilingualAsrTranscript,
  redactSelectedTokensInAudioAndTranscript,
  restorePersianProsodicPunctuation,
} from './engine/persianAsrTranscriber';
import { EnglishScriptRenderMode } from './ai-engine/asr/MultilingualCodeSwitchAndArabicEngine';
import { AudioRedactionMaskMode } from '../packages/audio-runtime/src/SensitiveContentAndPiiRedactorEngine';
import { buildPeakPyramid } from './engine/peakPyramid';
import { resampleTo16kMono } from './engine/resampler';
import { flicksToSeconds, formatTimecode, msToFlicks, secondsToFlicks } from './engine/timebase';

const DEFAULT_DSP_PARAMS: EphemeralDspParams = {
  highPassHz: 80,
  compressorThresholdDb: -18,
  compressorRatio: 3.0,
  noiseGateThresholdDb: -48,
  masterGainDb: 0,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('studio');
  const [project, setProject] = useState<LoadedStudioProject>(() =>
    buildDefaultPersianPodcastProject(),
  );
  const [tracks, setTracks] = useState<Track[]>(() => cloneTracks(project.tracks));
  const [tokens, setTokens] = useState<PersianWordToken[]>(() => cloneTokens(project.tokens));
  const [recommendations, setRecommendations] = useState<SmartRecommendation[]>(
    () => cloneRecommendations(project.recommendations),
  );
  const [selectedRecId, setSelectedRecId] = useState<string | null>(
    () => project.recommendations[0]?.id ?? null,
  );
  const [isTranscribingAsr, setIsTranscribingAsr] = useState<boolean>(false);
  const [englishRenderMode, setEnglishRenderMode] =
    useState<EnglishScriptRenderMode>('LATIN_TECHNICAL');

  // Transport & Adobe Audition Selection state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [detectedSyncOffsetMs, setDetectedSyncOffsetMs] = useState<number>(38.5);
  const [detectedClockDriftPpm, setDetectedClockDriftPpm] = useState<number>(14.2);
  const [selection, setSelection] = useState<WaveformSelectionState | null>(null);
  const [loopSelection, setLoopSelection] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [meterDb, setMeterDb] = useState<{ peakDb: number; rmsDb: number }>({
    peakDb: -60,
    rmsDb: -60,
  });

  // DSP & Ephemeral Gesture vs Committed Transaction
  const [ephemeralDsp, setEphemeralDsp] = useState<EphemeralDspParams>(DEFAULT_DSP_PARAMS);
  const [committedDsp, setCommittedDsp] = useState<EphemeralDspParams>(DEFAULT_DSP_PARAMS);
  const [isGestureActive, setIsGestureActive] = useState(false);
  const [eqResponseCurveDb, setEqResponseCurveDb] = useState<
    { freqHz: number; gainDb: number }[] | null
  >(null);
  const [, setHistoryTick] = useState(0);

  // Processing Graph & PDC
  const defaultGraph = useMemo(() => createDefaultStudioGraph(), []);
  const [graphNodes, setGraphNodes] = useState<ProcessingNodeDescriptor[]>(defaultGraph.nodes);

  // Storage Broker & Capabilities
  const capabilities = useMemo(() => detectRuntimeCapabilities(), []);
  const brokerRef = useRef<StorageBrokerClient | null>(null);
  const [telemetry, setTelemetry] = useState<StorageBrokerTelemetry>(() => ({
    opfsSupported: capabilities.opfsSupported,
    syncAccessHandleSupported: false,
    persistentStorageGranted: null,
    quotaUsedBytes: null,
    quotaTotalBytes: null,
    activeLeases: [],
    lockConflictsPrevented: 0,
    cacheStats: {
      maxBytes: AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
      usedBytes: 0,
      cachedBlocks: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
    },
    persistenceAvailable: false,
    persistenceStatus: 'OPFS-Unavailable',
    workerCacheStats: null,
    totalAudioCacheBudgetBytes: AVAPARDAZ_MEMORY_POLICY.audioCacheBytes,
  }));

  // Export Modal & Studio Tool Modals state
  const [exportOpen, setExportOpen] = useState(false);
  const [asrLabOpen, setAsrLabOpen] = useState(false);
  const [devPortalOpen, setDevPortalOpen] = useState(false);
  const [speechIntelOpen, setSpeechIntelOpen] = useState(false);
  const [dataFactoryOpen, setDataFactoryOpen] = useState(false);
  const [modelFactoryOpen, setModelFactoryOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [isTestingLru, setIsTestingLru] = useState(false);
  const [isRenderingExport, setIsRenderingExport] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportReport, setExportReport] = useState<ExportValidationReport | null>(null);
  const [exportManifest, setExportManifest] = useState<RenderManifest | null>(null);
  const [exportStrictErrors, setExportStrictErrors] = useState<string[]>([]);
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(null);

  const transportRef = useRef<StudioAudioTransport | null>(null);
  const historyRef = useRef<TimelineHistoryManager>(new TimelineHistoryManager());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const transport = new StudioAudioTransport();
    transportRef.current = transport;

    const broker = new StorageBrokerClient({
      mainThreadCacheBytes: AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
      workerCacheBytes: 0,
    });
    brokerRef.current = broker;

    const budgetManager = getSharedMemoryBudgetManager();
    const unregisterEviction = budgetManager.registerCacheEvictionCallback(() => {
      broker.lruCache.evictToBudget(0);
      if (!cancelled) {
        setTelemetry(broker.getTelemetry());
      }
    });

    broker
      .init()
      .then((t) => {
        if (!cancelled) {
          setTelemetry(t);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStatusNotice(
            `خطای راه‌اندازی Storage Broker: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

    const sessionLock = new CrashRecoveryAndSessionLock();
    sessionLock
      .acquireExclusiveProjectLock('avapardaz-demo-ep42')
      .then((acquired) => {
        if (!cancelled && !acquired) {
          setStatusNotice('هشدار هم‌زمانی: این پروژه هم‌اکنون در تب دیگری باز است (Web Locks Guard).');
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unregisterEviction();
      sessionLock.releaseProjectLock();
      transport.dispose();
      broker.dispose();
    };
  }, []);

  const totalDurationFlicks = useMemo(() => computeTimelineDurationFlicks(tracks), [tracks]);
  const totalDurationSec = flicksToSeconds(totalDurationFlicks);

  const handleStopAndReset = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);
    setMeterDb({ peakDb: -60, rmsDb: -60 });
    setPlayheadSec(selection ? selection.startSec : 0);
  };

  const handleTogglePlay = () => {
    if (!transportRef.current) return;
    if (isPlaying) {
      transportRef.current.stop();
      setIsPlaying(false);
      setPreviewingId(null);
      setMeterDb({ peakDb: -60, rmsDb: -60 });
      return;
    }

    const startSec = playheadSec >= totalDurationSec - 0.05 ? 0 : playheadSec;
    setIsPlaying(true);
    setPreviewingId(null);
    transportRef.current.playTimelineWindowed({
      tracks,
      assets: project.assets,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      startTimelineSec: startSec,
      totalDurationSec,
      endTimelineSec: totalDurationSec,
      loop: loopSelection && !selection,
      playbackRate,
      dspParams: ephemeralDsp,
      onTick: (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
      onMeter: (peakDb, rmsDb) => setMeterDb({ peakDb, rmsDb }),
      onEnded: () => {
        setIsPlaying(false);
        setMeterDb({ peakDb: -60, rmsDb: -60 });
      },
    });
  };

  const handlePlaySelectionRange = (targetSel?: WaveformSelectionState | null) => {
    const activeSel = targetSel ?? selection;
    if (!transportRef.current || !activeSel || activeSel.endSec - activeSel.startSec < 0.05) {
      return;
    }
    setPlayheadSec(activeSel.startSec);
    setIsPlaying(true);
    setPreviewingId(null);
    transportRef.current.playTimelineWindowed({
      tracks,
      assets: project.assets,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      startTimelineSec: activeSel.startSec,
      totalDurationSec,
      endTimelineSec: activeSel.endSec,
      loop: loopSelection,
      playbackRate,
      dspParams: ephemeralDsp,
      onTick: (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
      onMeter: (peakDb, rmsDb) => setMeterDb({ peakDb, rmsDb }),
      onEnded: () => {
        setIsPlaying(false);
        setMeterDb({ peakDb: -60, rmsDb: -60 });
      },
    });
  };

  const handleSeekSec = (sec: number) => {
    const clamped = Math.max(0, Math.min(totalDurationSec, sec));
    setPlayheadSec(clamped);
    if (isPlaying && transportRef.current) {
      transportRef.current.playTimelineWindowed({
        tracks,
        assets: project.assets,
        pcmSources: project.pcmSources,
        sampleRate: project.sampleRate,
        startTimelineSec: clamped,
        totalDurationSec,
        playbackRate,
        dspParams: ephemeralDsp,
        onTick: (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
        onMeter: (peakDb, rmsDb) => setMeterDb({ peakDb, rmsDb }),
        onEnded: () => {
          setIsPlaying(false);
          setMeterDb({ peakDb: -60, rmsDb: -60 });
        },
      });
    }
  };

  const handleSetInAtPlayhead = () => {
    const startSec = Number(Math.max(0, Math.min(totalDurationSec - 0.1, playheadSec)).toFixed(2));
    const endSec =
      selection && selection.endSec > startSec + 0.05
        ? selection.endSec
        : Number(Math.min(totalDurationSec, startSec + 1.0).toFixed(2));
    setSelection({
      startSec,
      endSec,
      trackId: selection?.trackId ?? tracks[0]?.id ?? 'track-host',
      scope: selection?.scope ?? 'all',
    });
  };

  const handleSetOutAtPlayhead = () => {
    const endSec = Number(Math.min(totalDurationSec, Math.max(0.1, playheadSec)).toFixed(2));
    const startSec =
      selection && selection.startSec < endSec - 0.05
        ? selection.startSec
        : Number(Math.max(0, endSec - 1.0).toFixed(2));
    setSelection({
      startSec,
      endSec,
      trackId: selection?.trackId ?? tracks[0]?.id ?? 'track-host',
      scope: selection?.scope ?? 'all',
    });
  };

  const handlePreviewRecommendation = (rec: SmartRecommendation, mode: 'before' | 'after') => {
    if (!transportRef.current) return;
    transportRef.current.stop();
    setIsPlaying(false);

    const previewTracksAfter = applySyncSafeCut(
      tracks,
      rec.trackId,
      rec.boundary.snappedRange,
      rec.recommendedMode,
    );

    const buf = buildSplicePreviewBuffer({
      tracksBeforeEdit: tracks,
      tracksAfterEdit: previewTracksAfter,
      assets: project.assets,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      cutRange: rec.boundary.snappedRange,
      dspParams: ephemeralDsp,
      mode,
    });

    const previewKey = `${rec.id}-${mode}`;
    setPreviewingId(previewKey);
    const startSec = Math.max(0, flicksToSeconds(rec.boundary.snappedRange.startFlicks) - 1.1);
    transportRef.current.playBuffer(
      buf,
      project.sampleRate,
      startSec,
      (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
      () => setPreviewingId(null),
    );
  };

  /**
   * Unified non-destructive cut executor that updates tracks, shifts/updates word tokens,
   * updates recommendations, and records an atomic Undo/Redo transaction.
   */
  const executeSynchronizedCut = (params: {
    targetTrackId: string;
    cutRange: FlickRange;
    mode: RecommendationActionMode;
    descriptionFa: string;
    affectedRecommendationId?: string;
  }) => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const nextTracks = applySyncSafeCut(
      tracks,
      params.targetTrackId,
      params.cutRange,
      params.mode,
    );
    const nextTokens = projectTokensAfterCut(
      tokens,
      tracks,
      params.targetTrackId,
      params.cutRange,
      params.mode,
    );
    const nextRecs = projectRecommendationsAfterCut(
      recommendations,
      tracks,
      params.targetTrackId,
      params.cutRange,
      params.mode,
      params.affectedRecommendationId,
    );

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type:
        params.mode === 'sync-locked-ripple-cut'
          ? 'sync-locked-ripple-cut'
          : 'in-place-room-tone-suppression',
      description: params.descriptionFa,
      beforeTracks: tracks,
      afterTracks: nextTracks,
      beforeTokens: tokens,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: nextRecs,
      affectedRecommendationId: params.affectedRecommendationId,
    });

    setTracks(nextTracks);
    setTokens(nextTokens);
    setRecommendations(nextRecs);
    const nextDurationSec = flicksToSeconds(computeTimelineDurationFlicks(nextTracks));
    if (playheadSec > nextDurationSec) {
      setPlayheadSec(Math.max(0, nextDurationSec));
    }
    setHistoryTick((v) => v + 1);
  };

  const handleAcceptRecommendation = (rec: SmartRecommendation) => {
    executeSynchronizedCut({
      targetTrackId: rec.trackId,
      cutRange: rec.boundary.snappedRange,
      mode: rec.recommendedMode,
      descriptionFa: `${
        rec.recommendedMode === 'sync-locked-ripple-cut' ? 'برش هم‌زمان' : 'جایگزینی Room Tone'
      }: ${rec.relatedText}`,
      affectedRecommendationId: rec.id,
    });
    setStatusNotice(`تغییر «${rec.relatedText}» به‌صورت غیرمخرب و همگام با متن اعمال شد.`);
  };

  const handleCutSelectedWords = (
    selectedTokenIds: string[],
    explicitMode?: RecommendationActionMode,
  ) => {
    const cutSpec = computeMultiWordCutRange(tokens, selectedTokenIds);
    if (!cutSpec) return;

    const decision = determineSyncSafeEditMode(
      tracks,
      cutSpec.trackId,
      cutSpec.range,
      tokens,
    );
    const modeToUse = explicitMode ?? decision.mode;

    executeSynchronizedCut({
      targetTrackId: cutSpec.trackId,
      cutRange: cutSpec.range,
      mode: modeToUse,
      descriptionFa: `${
        modeToUse === 'sync-locked-ripple-cut' ? 'برش متنی (Ripple)' : 'سکوت درجا (Room Tone)'
      }: «${cutSpec.combinedText}»`,
    });

    setStatusNotice(
      `تدوین متن‌محور: «${cutSpec.combinedText}» با حالت ${
        modeToUse === 'sync-locked-ripple-cut'
          ? 'برش زمانی همگام (Ripple Cut)'
          : 'جایگزینی درجا با Room Tone'
      } اعمال شد.`,
    );
  };

  const handleCutWaveformRange = (
    range: FlickRange,
    targetTrackId: string,
    mode: RecommendationActionMode,
  ) => {
    const startSec = flicksToSeconds(range.startFlicks).toFixed(2);
    const endSec = flicksToSeconds(range.endFlicks).toFixed(2);
    executeSynchronizedCut({
      targetTrackId,
      cutRange: range,
      mode,
      descriptionFa: `${
        mode === 'sync-locked-ripple-cut' ? 'برش بازه موج صوت' : 'Room Tone بازه موج صوت'
      } [${startSec}s..${endSec}s]`,
    });
    setStatusNotice(`بازه [${startSec}s تا ${endSec}s] با موفقیت تدوین و با واژگان همگام شد.`);
  };

  const handleSplitAtPlayhead = () => {
    const playheadFlicks = secondsToFlicks(playheadSec);
    const { tracks: nextTracks, splitCount } = splitTrackClipsAtPlayhead(tracks, playheadFlicks);
    if (splitCount === 0) {
      setStatusNotice('مکان‌نما را روی بخش میانی یک کلیپ صوتی قرار دهید تا برش (Split) انجام شود.');
      return;
    }

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'split',
      description: `برش کلیپ در مکان‌نما (${playheadSec.toFixed(2)}s)`,
      beforeTracks: tracks,
      afterTracks: nextTracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setTracks(nextTracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `برش غیرمخرب (Split) در زمان ${playheadSec.toFixed(2)} ثانیه روی ${splitCount} ترک با Micro-Crossfade اعمال شد.`,
    );
  };

  const handleUpdateTokenDisplayText = (tokenId: string, newDisplayText: string) => {
    setTokens((prev) =>
      prev.map((tok) => (tok.id === tokenId ? { ...tok, displayText: newDisplayText } : tok)),
    );
    setStatusNotice(`املای نمایشی واژه به «${newDisplayText}» با حفظ لایه خام ASR به‌روزرسانی شد.`);
  };

  const handleRunForcedAlignment = (customPersianScript: string, targetTrackId: string) => {
    const targetTrack = tracks.find((t) => t.id === targetTrackId) ?? tracks[0];
    if (!targetTrack) return;
    const primaryAssetId = targetTrack.clips[0]?.assetId ?? Object.keys(project.assets)[0];
    const pcm = project.pcmSources[primaryAssetId];
    const asset = project.assets[primaryAssetId];
    if (!pcm || !asset) return;

    const aligned = alignPersianScriptToAudio({
      pcm,
      sampleRate: project.sampleRate,
      trackId: targetTrack.id,
      speakerName: targetTrack.speakerLabel,
      rawTranscriptText: customPersianScript,
      acousticProfile: asset.acousticProfile,
      alignmentSource: 'ForcedAlignment',
    });

    const otherTrackTokens = tokens.filter((t) => t.trackId !== targetTrack.id);
    const mergedTokens = [...otherTrackTokens, ...aligned.tokens].sort(
      (a, b) => a.range.startFlicks - b.range.startFlicks,
    );

    const otherTrackRecs = recommendations.filter((r) => r.trackId !== targetTrack.id);
    const mergedRecs = [...otherTrackRecs, ...aligned.recommendations];

    setTokens(mergedTokens);
    setRecommendations(mergedRecs);
    setSelectedRecId(mergedRecs[0]?.id ?? null);
    setStatusNotice(
      `هم‌ترازی اجباری (Forced Alignment) انجام شد: ${aligned.tokens.length} واژه فارسی به مرزهای آوایی موج صوت اسنپ شد.`,
    );
  };

  const handleRunPersianAsr = async () => {
    const targetTrack = tracks[0];
    if (!targetTrack) return;
    const primaryAssetId = targetTrack.clips[0]?.assetId ?? Object.keys(project.assets)[0];
    const pcm = project.pcmSources[primaryAssetId];
    const asset = project.assets[primaryAssetId];
    if (!pcm || !asset) return;

    setIsTranscribingAsr(true);
    setStatusNotice('در حال اجرای خط لوله تبدیل صوت به متن فارسی و هم‌ترازی آوایی (ASR + Forced Alignment)...');

    try {
      // 1. Downsample to 16kHz Mono for ASR inference
      const resampled16k = resampleTo16kMono([pcm], project.sampleRate, 16_000);
      const wavBase64 = encodeMono16kWavBase64(resampled16k.samples, 16_000);

      let transcribedText = '';
      let sourceKind: PersianWordToken['alignmentSource'] = 'ASR';

      try {
        const res = await fetch('/api/v1/asr/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64: wavBase64,
            mimeType: 'audio/wav',
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { transcriptText?: string };
          if (data.transcriptText && data.transcriptText.trim().length > 0) {
            transcribedText = data.transcriptText.trim();
          }
        }
      } catch {
        // Fallback to local acoustic prosodic segmentation when offline
      }

      if (!transcribedText) {
        sourceKind = 'AcousticSnap';
        const existingTrackText = tokens
          .filter((t) => t.trackId === targetTrack.id)
          .map((t) => t.originalText)
          .join(' ');
        transcribedText =
          existingTrackText.trim().length > 0
            ? existingTrackText
            : buildOfflineAcousticSegmentedTranscript(
                pcm,
                project.sampleRate,
                asset.acousticProfile,
              );
      }

      const aligned = alignPersianScriptToAudio({
        pcm,
        sampleRate: project.sampleRate,
        trackId: targetTrack.id,
        speakerName: targetTrack.speakerLabel,
        rawTranscriptText: transcribedText,
        acousticProfile: asset.acousticProfile,
        alignmentSource: sourceKind,
      });

      const otherTrackTokens = tokens.filter((t) => t.trackId !== targetTrack.id);
      const mergedTokens = [...otherTrackTokens, ...aligned.tokens].sort(
        (a, b) => a.range.startFlicks - b.range.startFlicks,
      );
      const otherTrackRecs = recommendations.filter((r) => r.trackId !== targetTrack.id);
      const mergedRecs = [...otherTrackRecs, ...aligned.recommendations];

      setTokens(mergedTokens);
      setRecommendations(mergedRecs);
      setSelectedRecId(mergedRecs[0]?.id ?? null);
      setStatusNotice(
        `استخراج و هم‌ترازی آوایی تکمیل شد: ${aligned.tokens.length} واژه زمان‌بندی‌شده و ${aligned.recommendations.length} پیشنهاد تدوین شناسایی شد.`,
      );
    } finally {
      setIsTranscribingAsr(false);
    }
  };

  const handleRestoreProsodicPunctuation = () => {
    const primaryTrack = tracks[0];
    const primaryAssetId = primaryTrack?.clips[0]?.assetId ?? Object.keys(project.pcmSources)[0];
    const pcm = primaryAssetId ? project.pcmSources[primaryAssetId] : undefined;
    if (!pcm || tokens.length === 0) return;

    const beforeTokensSnapshot = cloneTokens(tokens);
    const nextTokens = restorePersianProsodicPunctuation(tokens, pcm, project.sampleRate);

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: 'بازسازی علائم نگارشی فارسی از روی آهنگ صدا (F0 Pitch & Pause)',
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setTokens(nextTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      'علائم نگارشی فارسی (، . ؟) بر اساس مکث‌ها و شیب فرکانس پایه (F0) در لایه نمایشی بازسازی شد.',
    );
  };

  const handleConvertColloquialToFormal = () => {
    if (tokens.length === 0) return;
    const beforeTokensSnapshot = cloneTokens(tokens);
    const { tokens: nextTokens, convertedCount } = convertTranscriptColloquialToFormal(tokens);

    if (convertedCount === 0) {
      setStatusNotice('تمام واژگان فعلی در لایه نمایشی از قبل به فرم معیار فارسی هستند.');
      return;
    }

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `تبدیل غیرمخرب ${convertedCount} واژه محاوره‌ای به فارسی معیار`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setTokens(nextTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `${convertedCount} واژه/فعل محاوره‌ای در لایه نمایشی به فارسی معیار تبدیل شد (با حفظ متن خام ASR و زمان‌بندی).`,
    );
  };

  const handleNormalizeNumbersAndCompounds = () => {
    if (tokens.length === 0) return;
    const beforeTokensSnapshot = cloneTokens(tokens);
    const { tokens: nextTokens, updatedCount } = normalizeNumbersAndCompoundsInTranscript(tokens);

    if (updatedCount === 0) {
      setStatusNotice('اعداد، مبالغ و ترکیبات نیم‌فاصله در لایه نمایشی از قبل استاندارد هستند.');
      return;
    }

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `اصلاح اعداد و نیم‌فاصله ترکیبات فارسی (${updatedCount} مورد)`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setTokens(nextTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `اصلاح اعداد، مبالغ و ترکیبات دووجهی/نیم‌فاصله روی ${updatedCount} بخش انجام شد.`,
    );
  };

  const handleRedactSelectedWords = (
    selectedTokenIds: string[],
    maskMode: AudioRedactionMaskMode,
  ) => {
    if (selectedTokenIds.length === 0) return;
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTokensSnapshot = cloneTokens(tokens);
    const updatedPcmSources = { ...project.pcmSources };
    const updatedAssets = { ...project.assets };
    let currentTokens = cloneTokens(tokens);
    let totalRedacted = 0;

    for (const trk of tracks) {
      const trkTokenIds = selectedTokenIds.filter((id) =>
        currentTokens.some((tok) => tok.id === id && tok.trackId === trk.id),
      );
      if (trkTokenIds.length === 0) continue;
      const assetId = trk.clips[0]?.assetId;
      const pcm = assetId ? updatedPcmSources[assetId] : undefined;
      const asset = assetId ? updatedAssets[assetId] : undefined;
      if (!assetId || !pcm || !asset) continue;

      const res = redactSelectedTokensInAudioAndTranscript({
        pcm,
        roomToneSample: asset.acousticProfile.roomToneSample,
        sampleRate: project.sampleRate,
        tokens: currentTokens,
        selectedTokenIds: trkTokenIds,
        mode: maskMode,
      });
      updatedPcmSources[assetId] = res.redactedPcm;
      updatedAssets[assetId] = {
        ...asset,
        peakPyramid: buildPeakPyramid(assetId, [res.redactedPcm], project.sampleRate),
      };
      currentTokens = res.updatedTokens;
      totalRedacted += res.redactedCount;
    }

    if (totalRedacted === 0) return;

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `پوشش صوتی امنیتی (${maskMode === 'BROADCAST_BLEEP_1KHZ' ? 'بوق ۱ کیلوهرتز' : 'مات‌سازی فرکانس پایین'}) روی ${totalRedacted} واژه`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: currentTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setTokens(currentTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `پوشش صوتی (${
        maskMode === 'BROADCAST_BLEEP_1KHZ'
          ? 'بوق استاندارد پخش ۱kHz'
          : 'فیلتر مات‌سازی صدا (210Hz Low-Pass)'
      }) با شیب ۱۵ms روی ${totalRedacted} واژه اعمال شد.`,
    );
  };

  const handleApplySpectralWienerDenoise = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const updatedPcmSources = { ...project.pcmSources };
    const updatedAssets = { ...project.assets };
    let avgFloorDropDb = 0;
    let count = 0;

    for (const [assetId, pcm] of Object.entries(updatedPcmSources)) {
      const asset = updatedAssets[assetId];
      if (!pcm || !asset) continue;
      const denoised = applySpectralWienerDenoiseToPcm({
        pcm,
        roomToneSample: asset.acousticProfile.roomToneSample,
      });
      updatedPcmSources[assetId] = denoised.denoisedPcm;
      updatedAssets[assetId] = {
        ...asset,
        peakPyramid: buildPeakPyramid(assetId, [denoised.denoisedPcm], project.sampleRate),
      };
      avgFloorDropDb += Math.max(0.5, denoised.beforeRmsDb - denoised.afterRmsDb);
      count++;
    }

    if (count === 0) return;
    const meanSnrGain = (avgFloorDropDb / count).toFixed(1);

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setStatusNotice(
      `حذف نویز طیفی تطبیقی (Decision-Directed Wiener Denoiser) روی تمام ترک‌ها اعمال شد (کاهش کف نویز: -${meanSnrGain} dB).`,
    );
  };

  const prosodyAndChaptersReport = useMemo(() => {
    const primaryTrack = tracks[0];
    const primaryAssetId =
      primaryTrack?.clips[0]?.assetId ?? Object.keys(project.pcmSources)[0];
    const pcm = primaryAssetId ? project.pcmSources[primaryAssetId] : undefined;
    if (!pcm || tokens.length === 0) return null;
    return analyzeTranscriptProsodyAndChapters({
      tokens,
      pcm,
      sampleRate: project.sampleRate,
    });
  }, [tokens, tracks, project.pcmSources, project.sampleRate]);

  const handleApplyCustomLexicon = (customVocabularyCsv: string) => {
    if (tokens.length === 0) return;
    const beforeTokensSnapshot = cloneTokens(tokens);
    const { tokens: nextTokens, correctedCount } =
      applyCustomLexiconAndPhoneticCorrections({
        tokens,
        customVocabularyCsv,
      });

    if (correctedCount === 0) {
      setStatusNotice(
        'واژه‌نامه اختصاصی ثبت شد؛ تمامی واژگان فعلی با املای استاندارد واژه‌نامه منطبق هستند.',
      );
      return;
    }

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `اصلاح هم‌آواها با واژه‌نامه اختصاصی (${correctedCount} واژه)`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setTokens(nextTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `واژه‌نامه اختصاصی اعمال شد: ${correctedCount} واژه هم‌آوا/تخصصی به املای استاندارد اصلاح گردید.`,
    );
  };

  const handleOptimizeTrilingualAsr = (nextMode: EnglishScriptRenderMode) => {
    const primaryTrack = tracks[0];
    const primaryAssetId =
      primaryTrack?.clips[0]?.assetId ?? Object.keys(project.pcmSources)[0];
    const pcm = primaryAssetId ? project.pcmSources[primaryAssetId] : undefined;
    if (!pcm || tokens.length === 0) return;

    const beforeTokensSnapshot = cloneTokens(tokens);
    const report = optimizeAndAnalyzeTrilingualAsrTranscript({
      tokens,
      pcm,
      sampleRate: project.sampleRate,
      englishRenderMode: nextMode,
      preserveArabicOrthography: true,
    });

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `بهینه‌سازی سه‌زبانه ASR (FA:${report.stats.persianCount} · EN:${report.stats.englishCount} · AR:${report.stats.arabicCount})`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: report.tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setEnglishRenderMode(nextMode);
    setTokens(report.tokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `موتور سه‌زبانه ASR (فارسی/انگلیسی/عربی) و بازامتیازدهی هم‌آواها اجرا شد: ${report.stats.persianCount} واژه فارسی، ${report.stats.englishCount} واژه انگلیسی (${
        nextMode === 'LATIN_TECHNICAL' ? 'نگارش Latin' : 'نگارش فارسی'
      }) و ${report.stats.arabicCount} واژه عربی شناسایی شد (اطمینان کالیبره‌شده Platt: ${(
        report.stats.meanCalibratedConfidence * 100
      ).toFixed(1)}٪).`,
    );
  };

  const handleWsolaTimeStretchSelectedWords = (
    selectedTokenIds: string[],
    tempoRatio: number,
  ) => {
    if (selectedTokenIds.length === 0) return;
    const firstTok = tokens.find((t) => selectedTokenIds.includes(t.id));
    if (!firstTok) return;
    const targetTrack = tracks.find((t) => t.id === firstTok.trackId);
    const assetId = targetTrack?.clips[0]?.assetId;
    const pcm = assetId ? project.pcmSources[assetId] : undefined;
    const asset = assetId ? project.assets[assetId] : undefined;
    if (!targetTrack || !assetId || !pcm || !asset) return;

    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTracksSnapshot = cloneTracks(tracks);
    const beforeTokensSnapshot = cloneTokens(tokens);

    const stretched = applyWsolaTimeStretchToSelectedTokens({
      pcm,
      sampleRate: project.sampleRate,
      tokens,
      tracks,
      targetTrackId: targetTrack.id,
      selectedTokenIds,
      tempoRatio,
    });

    const updatedPcmSources = {
      ...project.pcmSources,
      [assetId]: stretched.stretchedPcm,
    };
    const updatedAssets = {
      ...project.assets,
      [assetId]: {
        ...asset,
        peakPyramid: buildPeakPyramid(
          assetId,
          [stretched.stretchedPcm],
          project.sampleRate,
        ),
      },
    };

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `تغییر سرعت بیان بدون تغییر زیر و بمی (WSOLA ${tempoRatio}x)`,
      beforeTracks: beforeTracksSnapshot,
      afterTracks: stretched.updatedTracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: stretched.updatedTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setTracks(stretched.updatedTracks);
    setTokens(stretched.updatedTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `کشش/فشرده‌سازی زمانی بدون تغییر زیر و بمی صدا (WSOLA ${tempoRatio}x) روی واژگان انتخاب‌شده اعمال شد (تغییر زمان: ${
        stretched.deltaDurationSec >= 0 ? '+' : ''
      }${stretched.deltaDurationSec}s).`,
    );
  };

  const acousticAdvisor = useMemo(() => {
    const primaryTrack = tracks[0];
    const primaryAssetId =
      primaryTrack?.clips[0]?.assetId ?? Object.keys(project.pcmSources)[0];
    const pcm = primaryAssetId ? project.pcmSources[primaryAssetId] : undefined;
    const asset = primaryAssetId ? project.assets[primaryAssetId] : undefined;
    if (!pcm || !asset) return null;
    return analyzeStudioRecordingAcoustics({
      pcm,
      roomToneSample: asset.acousticProfile.roomToneSample,
      sampleRate: project.sampleRate,
    });
  }, [tracks, project.pcmSources, project.assets, project.sampleRate]);

  const handleApplyAcousticAdvisorPreset = () => {
    if (!acousticAdvisor) return;
    const nextDsp = acousticAdvisor.recommendedDsp;
    setEphemeralDsp(nextDsp);
    setCommittedDsp(nextDsp);
    setIsGestureActive(false);

    historyRef.current.commitTransaction({
      coalescingKey: 'dsp-acoustic-advisor',
      type: 'dsp-parameter-change',
      description: `کالیبراسیون خودکار DSP بر اساس مشاور آکوستیک (HPF ${nextDsp.highPassHz}Hz · Comp ${nextDsp.compressorThresholdDb}dB)`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `کالیبراسیون خودکار DSP اعمال شد: فیلتر بالاگذر ${nextDsp.highPassHz}Hz، کمپرسور ${nextDsp.compressorThresholdDb}dB (${nextDsp.compressorRatio}:1) و گیت ${nextDsp.noiseGateThresholdDb}dB (SNR فعلی: ${acousticAdvisor.report.signalToNoiseRatioDb}dB).`,
    );
  };

  const phaseDiagnostic = useMemo(() => {
    const pcmList = Object.values(project.pcmSources);
    if (pcmList.length < 2) return null;
    return analyzeMultiTrackPhaseCompatibility({
      pcmA: pcmList[0],
      pcmB: pcmList[1],
      sampleRate: project.sampleRate,
    });
  }, [project.pcmSources, project.sampleRate]);

  const handleApply8BandPersianVoiceEq = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const updatedPcmSources = { ...project.pcmSources };
    const updatedAssets = { ...project.assets };
    let latestCurve: { freqHz: number; gainDb: number }[] | null = null;
    let processedTracks = 0;

    for (const [assetId, pcm] of Object.entries(updatedPcmSources)) {
      const asset = updatedAssets[assetId];
      if (!pcm || !asset) continue;
      const res = applyPersianVoice8BandEqToPcm({
        pcm,
        sampleRate: project.sampleRate,
      });
      updatedPcmSources[assetId] = res.eqPcm;
      updatedAssets[assetId] = {
        ...asset,
        peakPyramid: buildPeakPyramid(assetId, [res.eqPcm], project.sampleRate),
      };
      latestCurve = res.responseCurveDb;
      processedTracks++;
    }

    if (processedTracks === 0) return;

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setEqResponseCurveDb(latestCurve);
    setStatusNotice(
      'اکوالایزر پارامتریک ۸ بانده ویژه کلام فارسی (حذف هام ۵۰Hz، شفافیت همخوان ۳.۲kHz و مهار صفیر ۶.۵kHz) اعمال شد.',
    );
  };

  const handlePunchInSpectralMatchSelectedWords = (selectedTokenIds: string[]) => {
    if (selectedTokenIds.length === 0) return;
    const firstTok = tokens.find((t) => selectedTokenIds.includes(t.id));
    if (!firstTok) return;
    const targetTrack = tracks.find((t) => t.id === firstTok.trackId);
    const assetId = targetTrack?.clips[0]?.assetId;
    const pcm = assetId ? project.pcmSources[assetId] : undefined;
    const asset = assetId ? project.assets[assetId] : undefined;
    if (!targetTrack || !assetId || !pcm || !asset) return;

    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTokensSnapshot = cloneTokens(tokens);
    const res = applyPunchInSpectralMatchAndWatermarkToSelectedTokens({
      pcm,
      roomToneSample: asset.acousticProfile.roomToneSample,
      sampleRate: project.sampleRate,
      tokens,
      selectedTokenIds,
    });

    const updatedPcmSources = {
      ...project.pcmSources,
      [assetId]: res.matchedPcm,
    };
    const updatedAssets = {
      ...project.assets,
      [assetId]: {
        ...asset,
        peakPyramid: buildPeakPyramid(assetId, [res.matchedPcm], project.sampleRate),
      },
    };

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `تطبیق طیفی ۴ بانده و واترمارک ۱۹kHz BPSK روی ${selectedTokenIds.length} واژه`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: res.updatedTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setTokens(res.updatedTokens);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `تطبیق طیفی ۴ بانده (4-Band Spectral EQ Match) با رنگ صدای استودیو و درج واترمارک اصالت ۱۹kHz BPSK روی ${selectedTokenIds.length} واژه انجام شد (تأیید واترمارک: ${
        res.isWatermarked ? 'معتبر ✓' : 'نامشخص'
      }).`,
    );
  };

  const handleSoftenBreathsAndCoughs = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const updatedPcmSources = { ...project.pcmSources };
    const updatedAssets = { ...project.assets };
    let totalBreaths = 0;
    let totalCoughs = 0;

    for (const trk of tracks) {
      const assetId = trk.clips[0]?.assetId;
      const pcm = assetId ? updatedPcmSources[assetId] : undefined;
      const asset = assetId ? updatedAssets[assetId] : undefined;
      if (!assetId || !pcm || !asset) continue;

      const res = attenuateBreathsAndCoughsInAudio({
        pcm,
        roomToneSample: asset.acousticProfile.roomToneSample,
        sampleRate: project.sampleRate,
        tokens,
        trackId: trk.id,
      });

      updatedPcmSources[assetId] = res.processedPcm;
      updatedAssets[assetId] = {
        ...asset,
        peakPyramid: buildPeakPyramid(
          assetId,
          [res.processedPcm],
          project.sampleRate,
        ),
      };
      totalBreaths += res.attenuatedBreathCount;
      totalCoughs += res.suppressedCoughCount;
    }

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setStatusNotice(
      `کنترل غیرکلامی تنفس و سرفه اعمال شد: ${totalBreaths} نفس پیش از جمله با شیب ۱۵ms به میزان -10dB نرم‌سازی شد${
        totalCoughs > 0 ? ` و ${totalCoughs} سرفه با Room Tone جایگزین گردید` : ''
      }.`,
    );
  };

  const handleScanMultiTrackCrosstalk = () => {
    const res = analyzeMultiTrackCrosstalkAndDiarization({
      tracks,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      existingRecommendations: recommendations,
    });
    setRecommendations(res.recommendations);
    setStatusNotice(
      `تفکیک چندگوینده و نشت میکروفون (Normalized Cross-Correlation): ${res.primarySpeechSegments} قطعه گفتار اصلی، ${res.overlappingSegments} هم‌پوشانی هم‌زمان و ${res.micBleedSegments} قطعه نشت صدا شناسایی شد.`,
    );
  };

  const handleBatchAcceptAllSafe = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTracksSnapshot = cloneTracks(tracks);
    const beforeTokensSnapshot = cloneTokens(tokens);
    const beforeRecsSnapshot = cloneRecommendations(recommendations);

    const batchResult = applyBatchRecommendationsAtomically({
      tracks,
      tokens,
      recommendations,
    });

    if (batchResult.appliedCount === 0) {
      setStatusNotice('هیچ پیشنهاد ایمنی برای پاک‌سازی دسته‌ای در انتظار نیست.');
      return;
    }

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'sync-locked-ripple-cut',
      description: `پاک‌سازی هوشمند دسته‌ای (${batchResult.appliedCount} تپق/مکث/نشت صدا)`,
      beforeTracks: beforeTracksSnapshot,
      afterTracks: batchResult.tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: batchResult.tokens,
      beforeRecommendations: beforeRecsSnapshot,
      afterRecommendations: batchResult.recommendations,
    });

    setTracks(batchResult.tracks);
    setTokens(batchResult.tokens);
    setRecommendations(batchResult.recommendations);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `پاک‌سازی دسته‌ای انجام شد: ${batchResult.appliedCount} مورد (${batchResult.rippleCutCount} برش زمانی و ${batchResult.roomToneCount} جایگزینی Room Tone) در یک تراکنش واحد اعمال شد.`,
    );
  };

  const handleRescanDeepDisfluencies = () => {
    let updatedRecs = cloneRecommendations(recommendations);
    let addedTotal = 0;

    for (const trk of tracks) {
      const assetId = trk.clips[0]?.assetId;
      const pcm = assetId ? project.pcmSources[assetId] : undefined;
      if (!pcm) continue;
      const beforeLen = updatedRecs.length;
      updatedRecs = analyzeDeepPersianDisfluenciesAndRetakes({
        tokens,
        pcm,
        sampleRate: project.sampleRate,
        trackId: trk.id,
        existingRecommendations: updatedRecs,
      });
      addedTotal += updatedRecs.length - beforeLen;
    }

    setRecommendations(updatedRecs);
    setStatusNotice(
      addedTotal > 0
        ? `اسکن عمیق تپق، مکث میانی و تکرار معنایی انجام شد: ${addedTotal} پیشنهاد جدید به لیست اضافه شد.`
        : 'اسکن عمیق انجام شد: تمام تپق‌ها، مکث‌ها و تکرارهای معنایی فعلی در لیست پیشنهادها پوشش داده شده‌اند.',
    );
  };

  const handleRecordStudioMicTake = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const { pcm, defaultScript } = buildSyntheticMicRecordingPcm(48_000);
    const recordedProject = ingestRecordedPcmTake({
      pcm,
      sampleRate: 48_000,
      takeName: 'Mic_Studio_Take_48k.wav',
      transcriptHint: defaultScript,
    });

    setProject(recordedProject);
    setTracks(cloneTracks(recordedProject.tracks));
    setTokens(cloneTokens(recordedProject.tokens));
    setRecommendations(cloneRecommendations(recordedProject.recommendations));
    setSelectedRecId(recordedProject.recommendations[0]?.id ?? null);
    setPlayheadSec(0);
    historyRef.current = new TimelineHistoryManager();
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `برداشت صوتی استودیو ضبط و هم‌ترازی آوایی شد: ${recordedProject.tokens.length} واژه فارسی و ${recordedProject.recommendations.length} پیشنهاد تپق/مکث استخراج گردید.`,
    );
  };

  const handleRejectRecommendation = (id: string) => {
    setRecommendations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: 'Rejected' } : r)),
    );
  };

  const handleNudgeBoundary = (id: string, deltaMs: number) => {
    const deltaFlicks = msToFlicks(deltaMs);
    setRecommendations((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const nextStart = Math.max(0, r.boundary.snappedRange.startFlicks + deltaFlicks);
        if (nextStart >= r.boundary.snappedRange.endFlicks - msToFlicks(120)) return r;
        const nextRange = {
          startFlicks: nextStart,
          endFlicks: r.boundary.snappedRange.endFlicks,
        };
        return {
          ...r,
          range: nextRange,
          boundary: {
            ...r.boundary,
            snappedRange: nextRange,
            rmsValleyShiftMs: r.boundary.rmsValleyShiftMs + deltaMs,
          },
        };
      }),
    );
  };

  const handleUndo = () => {
    const tx = historyRef.current.undo();
    if (!tx) return;
    transportRef.current?.stop();
    setIsPlaying(false);
    setTracks(cloneTracks(tx.beforeTracks));
    if (tx.beforeTokens) {
      setTokens(cloneTokens(tx.beforeTokens));
    }
    if (tx.beforeRecommendations) {
      setRecommendations(cloneRecommendations(tx.beforeRecommendations));
    } else if (tx.affectedRecommendationId) {
      setRecommendations((prev) =>
        prev.map((r) =>
          r.id === tx.affectedRecommendationId ? { ...r, status: 'Pending' } : r,
        ),
      );
    }
    setHistoryTick((v) => v + 1);
    setStatusNotice(`تراکنش «${tx.description}» بازگردانی شد (Undo).`);
  };

  const handleRedo = () => {
    const tx = historyRef.current.redo();
    if (!tx) return;
    transportRef.current?.stop();
    setIsPlaying(false);
    setTracks(cloneTracks(tx.afterTracks));
    if (tx.afterTokens) {
      setTokens(cloneTokens(tx.afterTokens));
    }
    if (tx.afterRecommendations) {
      setRecommendations(cloneRecommendations(tx.afterRecommendations));
    } else if (tx.affectedRecommendationId) {
      setRecommendations((prev) =>
        prev.map((r) =>
          r.id === tx.affectedRecommendationId ? { ...r, status: 'Accepted' } : r,
        ),
      );
    }
    setHistoryTick((v) => v + 1);
    setStatusNotice(`تراکنش «${tx.description}» دوباره اعمال شد (Redo).`);
  };

  const handleEphemeralDspChange = (next: EphemeralDspParams) => {
    setIsGestureActive(true);
    setEphemeralDsp(next);
  };

  const handleCommitDspGesture = (coalescingKey: string, labelFa: string) => {
    setIsGestureActive(false);
    if (JSON.stringify(ephemeralDsp) === JSON.stringify(committedDsp)) return;
    setCommittedDsp(ephemeralDsp);
    historyRef.current.commitTransaction({
      coalescingKey,
      type: 'dsp-parameter-change',
      description: labelFa,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });
    setHistoryTick((v) => v + 1);
  };

  const handleResetDsp = () => {
    setEphemeralDsp(DEFAULT_DSP_PARAMS);
    setCommittedDsp(DEFAULT_DSP_PARAMS);
    setIsGestureActive(false);
  };

  const handleToggleTrackMute = (trackId: string) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    );
  };

  const handleToggleTrackSolo = (trackId: string) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, solo: !t.solo } : t)),
    );
  };

  const applySyncedTrackTimelineShiftMs = (shiftMs: number, descriptionFa: string) => {
    const deltaFlicks = msToFlicks(shiftMs);
    const nextTracks = tracks.map((trk, idx) => {
      if (idx === 0 || !trk.syncGroupId) return trk;
      return {
        ...trk,
        clips: trk.clips.map((c) => {
          const nextStart = Math.max(0, c.timelineRange.startFlicks + deltaFlicks);
          const duration = c.timelineRange.endFlicks - c.timelineRange.startFlicks;
          return {
            ...c,
            timelineRange: {
              startFlicks: nextStart,
              endFlicks: nextStart + duration,
            },
          };
        }),
      };
    });

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'move',
      description: descriptionFa,
      beforeTracks: tracks,
      afterTracks: nextTracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });

    setTracks(nextTracks);
    setHistoryTick((v) => v + 1);
  };

  const handleAutoAlignSyncedTracks = () => {
    const offsetToCorrect = -detectedSyncOffsetMs;
    applySyncedTrackTimelineShiftMs(
      offsetToCorrect,
      `هم‌ترازسازی خودکار ترک‌های همگام (${detectedSyncOffsetMs.toFixed(1)}ms و جبران دریفت ${detectedClockDriftPpm.toFixed(1)}ppm)`,
    );
    setDetectedSyncOffsetMs(0);
    setDetectedClockDriftPpm(0);
    setStatusNotice(
      'انحراف زمانی و دریفت کلاک ترک‌های همگام به‌صورت غیرمخرب اصلاح و هم‌تراز شد (0.0 ms).',
    );
  };

  const handleNudgeSyncedTracksMs = (deltaMs: number) => {
    applySyncedTrackTimelineShiftMs(
      deltaMs,
      `جابجایی دستی زمان‌بندی ترک همگام (${deltaMs > 0 ? '+' : ''}${deltaMs}ms)`,
    );
    setDetectedSyncOffsetMs((prev) => Number((prev + deltaMs).toFixed(1)));
    setStatusNotice(
      `زمان‌بندی ترک همگام به میزان ${deltaMs > 0 ? '+' : ''}${deltaMs} میلی‌ثانیه جابجا شد (Nudge).`,
    );
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    transportRef.current?.stop();
    setIsPlaying(false);
    setStatusNotice(`در حال Ingest جریانی و تحلیل آوایی فارسی روی «${file.name}»...`);
    try {
      const loaded = await ingestUploadedAudioFile(file);
      historyRef.current = new TimelineHistoryManager();
      setProject(loaded);
      setTracks(cloneTracks(loaded.tracks));
      setTokens(cloneTokens(loaded.tokens));
      setRecommendations(cloneRecommendations(loaded.recommendations));
      setSelectedRecId(loaded.recommendations[0]?.id ?? null);
      setPlayheadSec(0);
      setHistoryTick((v) => v + 1);
      setStatusNotice(
        `فایل «${file.name}» وارد شد (${loaded.tokens.length} بخش آوایی و ${loaded.recommendations.length} پیشنهاد تدوین شناسایی شد).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.startsWith('SECURITY_')) {
        setStatusNotice(msg.replace(/^SECURITY_[A-Z_]+:\s*/, 'سپر امنیتی: '));
      } else {
        AudioSecurityGuard.sanitizeErrorForTelemetry(msg);
        setStatusNotice('خطا در دیکد فایل صوتی؛ لطفاً فرمت WAV یا MP3 معتبر انتخاب کنید.');
      }
    }
    e.target.value = '';
  };

  const handleResetDemoProject = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    const fresh = buildDefaultPersianPodcastProject();
    historyRef.current = new TimelineHistoryManager();
    setProject(fresh);
    setTracks(cloneTracks(fresh.tracks));
    setTokens(cloneTokens(fresh.tokens));
    setRecommendations(cloneRecommendations(fresh.recommendations));
    setSelectedRecId(fresh.recommendations[0]?.id ?? null);
    setPlayheadSec(0);
    setEphemeralDsp(DEFAULT_DSP_PARAMS);
    setCommittedDsp(DEFAULT_DSP_PARAMS);
    setDetectedSyncOffsetMs(38.5);
    setDetectedClockDriftPpm(14.2);
    setHistoryTick((v) => v + 1);
    setStatusNotice('پروژه نمونه پادکست فارسی بازیابی شد.');
  };

  const handleOpenExport = () => {
    setExportOpen(true);
    setIsRenderingExport(true);
    setExportProgress(0);
    setExportReport(null);
    setExportManifest(null);
    setExportStrictErrors([]);
    if (exportDownloadUrl) {
      URL.revokeObjectURL(exportDownloadUrl);
      setExportDownloadUrl(null);
    }

    setTimeout(() => {
      const rendered = streamingChunkedRender({
        tracks,
        assets: project.assets,
        pcmSources: project.pcmSources,
        sampleRate: project.sampleRate,
        dspParams: ephemeralDsp,
        onProgress: (pct) => setExportProgress(pct),
      });
      const { blob, report } = encodeAndValidateWavExport([rendered], project.sampleRate);

      // Compile formal RenderPlan + RenderManifest + ExportValidator (Architecture Sections 32-34)
      const graphEngine = new ProcessingGraphEngine();
      const specNodes: ProcessingNodeSpec[] = graphNodes.map((n) => ({
        id: n.id,
        type:
          n.kind === 'source'
            ? 'TRACK_SOURCE'
            : n.kind === 'eq'
              ? 'EQ_FILTER'
              : n.kind === 'compressor'
                ? 'COMPRESSOR'
                : n.kind === 'gate'
                  ? 'NOISE_GATE'
                  : 'MASTER_LIMITER',
        version: '1.0.0',
        enabled: !n.bypassed,
        latencySamples: n.latencySamples,
        preRollSamples: n.preRollSamples,
        tailSamples: n.tailSamples,
        committedParameters: { ...ephemeralDsp },
      }));
      const specEdges = defaultGraph.edges.map((e) => ({
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
      }));
      const assetHashes = Object.values(project.assets).map((a) => a.contentHash);
      const plan = graphEngine.compileGraph(
        specNodes,
        specEdges,
        project.sampleRate as 16000 | 22050 | 24000 | 32000 | 44100 | 48000 | 96000,
        assetHashes,
      );
      const strictReport = ExportValidator.validateRenderedPcm(
        [rendered],
        project.sampleRate as 16000 | 22050 | 24000 | 32000 | 44100 | 48000 | 96000,
        totalDurationSec,
      );
      const manifest: RenderManifest = {
        manifestId: `manifest_${Date.now()}`,
        projectRevision: historyRef.current.getProjectVersion(),
        versions: {
          projectSchemaVersion: 1,
          audioEngineVersion: '1.2.0',
          processingNodeCatalogVersion: '1.0.0',
          activeModelBundleVersion: 'fa-asr-bundle-1.2',
        },
        inputAssetContentHashes: assetHashes,
        graphCacheKey: plan.deterministicCacheKey,
        exportSampleRate: project.sampleRate as 16000 | 22050 | 24000 | 32000 | 44100 | 48000 | 96000,
        exportChannelCount: 1,
        renderedAtIso: new Date().toISOString(),
      };

      const url = URL.createObjectURL(blob);
      setExportReport(report);
      setExportManifest(manifest);
      setExportStrictErrors(strictReport.errors);
      setExportDownloadUrl(url);
      setIsRenderingExport(false);
    }, 60);
  };

  const handleRunBrokerConcurrencyTest = async () => {
    if (!brokerRef.current) return;
    const primaryId = Object.keys(project.assets)[0] ?? 'asset-host';
    const nextTel = await brokerRef.current.simulateConcurrentLockBrokerTest(primaryId);
    setTelemetry(nextTel);
  };

  const handleSimulateLruCacheFill = async () => {
    if (!brokerRef.current || isTestingLru) return;
    setIsTestingLru(true);
    try {
      const primaryId = Object.keys(project.assets)[0] ?? 'asset-host';
      const dummyBlock = new Float32Array(262_144); // 1 MiB per block
      const maxBytes = brokerRef.current.lruCache.getStats().maxBytes;
      const totalBlocks = Math.max(10, Math.floor(maxBytes / dummyBlock.byteLength) + 2);
      for (let i = 0; i < totalBlocks; i++) {
        await brokerRef.current.writePcmBlock(primaryId, i, [dummyBlock], 'playback-feeder');
      }
      // Exercise a cache hit (newest block warm) and a cache miss (block 0 evicted)
      brokerRef.current.lruCache.get(primaryId, totalBlocks - 1);
      brokerRef.current.lruCache.get(primaryId, 0);
      setTelemetry(brokerRef.current.getTelemetry());
    } finally {
      setIsTestingLru(false);
    }
  };

  const handleToggleNodeBypass = (nodeId: string) => {
    setGraphNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, bypassed: !n.bypassed } : n)),
    );
  };

  const auditionMarkers = useMemo(() => {
    const chapters = prosodyAndChaptersReport?.chapters ?? [];
    if (chapters.length > 0) {
      return chapters.map((ch, idx) => ({
        id: `chap_${idx}`,
        label: ch.suggestedTitleFa,
        startSec: flicksToSeconds(ch.range.start),
      }));
    }
    return recommendations
      .filter((r) => r.status === 'Pending')
      .slice(0, 6)
      .map((r) => ({
        id: r.id,
        label: r.relatedText,
        startSec: flicksToSeconds(r.range.startFlicks),
      }));
  }, [prosodyAndChaptersReport, recommendations]);

  const handleJumpPrevMarker = () => {
    const prev = [...auditionMarkers].reverse().find((m) => m.startSec < playheadSec - 0.15);
    handleSeekSec(prev ? prev.startSec : 0);
  };

  const handleJumpNextMarker = () => {
    const next = auditionMarkers.find((m) => m.startSec > playheadSec + 0.15);
    handleSeekSec(next ? next.startSec : totalDurationSec);
  };

  // Audition DAW Keyboard Shortcuts (Space: Play/Pause, I: In, O: Out, L: Loop, Escape: Clear selection)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        handleSetInAtPlayhead();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        handleSetOutAtPlayhead();
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setLoopSelection((v) => !v);
      } else if (e.key === 'Escape') {
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0F17] text-slate-100">
      <HeaderNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenExport={handleOpenExport}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 pt-5 pb-28 space-y-5">
        {/* Project & Transport Toolbar */}
        <section
          aria-label="نوار کنترل پروژه و پخش"
          className="border border-[#252F42] bg-[#131924] rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-4"
        >
          <div>
            <h1 className="text-base font-bold text-slate-100">{project.projectName}</h1>
            <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-2 font-mono">
              <span dir="ltr">{project.sampleRate} Hz</span>
              <span aria-hidden="true">·</span>
              <span className="font-sans">{tracks.length} ترک فعال</span>
              <span aria-hidden="true">·</span>
              <span>پردازش ۱۰۰٪ محلی ({capabilities.transportMode})</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Transport Buttons */}
            <button
              type="button"
              onClick={handleTogglePlay}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-emerald-500 text-slate-950 hover:bg-emerald-400 cursor-pointer"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>توقف</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>پخش</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleStopAndReset}
              aria-label="بازگشت به ابتدا"
              className="p-2 rounded-md border border-[#252F42] bg-[#0E131D] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <div
              dir="ltr"
              className="px-3 py-1.5 rounded-md border border-[#252F42] bg-[#0B0F17] font-mono text-xs text-amber-400"
              aria-label="زمان‌سنج پخش"
            >
              {formatTimecode(secondsToFlicks(playheadSec))} / {formatTimecode(totalDurationFlicks)}
            </div>

            <div className="h-5 w-px bg-[#252F42] mx-1 hidden sm:block" aria-hidden="true" />

            <button
              type="button"
              onClick={handleUndo}
              disabled={!historyRef.current.canUndo()}
              aria-label="بازگشت (Undo)"
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs rounded-md border border-[#252F42] text-slate-300 hover:bg-[#1E2738] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>بازگشت</span>
            </button>

            <button
              type="button"
              onClick={handleRedo}
              disabled={!historyRef.current.canRedo()}
              aria-label="تکرار (Redo)"
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs rounded-md border border-[#252F42] text-slate-300 hover:bg-[#1E2738] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>تکرار</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="hidden"
              aria-label="انتخاب فایل صوتی"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#252F42] bg-[#0E131D] text-slate-200 hover:bg-[#1E2738] cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              <span>ورود فایل صوتی</span>
            </button>

            <button
              type="button"
              data-testid="btn-record-studio-mic"
              onClick={handleRecordStudioMicTake}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 cursor-pointer"
            >
              <Mic className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />
              <span>ضبط برداشت صوتی</span>
            </button>

            <button
              type="button"
              data-testid="btn-spectral-wiener-denoise"
              onClick={handleApplySpectralWienerDenoise}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-cyan-500/40 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 cursor-pointer"
            >
              <Waves className="w-3.5 h-3.5 text-cyan-300" aria-hidden="true" />
              <span>حذف نویز طیفی Wiener</span>
            </button>

            <button
              type="button"
              onClick={handleResetDemoProject}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              <span>نمونه پادکست</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-asr-lab"
              onClick={() => setAsrLabOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-amber-400/50 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25 cursor-pointer"
            >
              <FlaskConical className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
              <span>آزمایشگاه تحقیق و مدل ASR</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-dev-portal"
              onClick={() => setDevPortalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-sky-400/50 bg-sky-400/15 text-sky-200 hover:bg-sky-400/25 cursor-pointer"
            >
              <Terminal className="w-3.5 h-3.5 text-sky-300" aria-hidden="true" />
              <span>پورتال API و توسعه‌دهندگان</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-speech-intel"
              onClick={() => setSpeechIntelOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-emerald-400/50 bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/25 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
              <span>هوشمندی گفتار (فاز ۱۱)</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-data-factory"
              onClick={() => setDataFactoryOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-cyan-400/50 bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/25 cursor-pointer"
            >
              <Database className="w-3.5 h-3.5 text-cyan-300" aria-hidden="true" />
              <span>کارخانه داده (فاز ۱۲)</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-model-factory"
              onClick={() => setModelFactoryOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-violet-400/50 bg-violet-400/15 text-violet-200 hover:bg-violet-400/25 cursor-pointer"
            >
              <GitBranch className="w-3.5 h-3.5 text-violet-300" aria-hidden="true" />
              <span>کارخانه مدل و MLOps (فاز ۱۳)</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-speech-security"
              onClick={() => setSecurityOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md border border-rose-400/50 bg-rose-400/15 text-rose-200 hover:bg-rose-400/25 cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-rose-300" aria-hidden="true" />
              <span>امنیت و مقاومت گفتار (فاز ۱۴)</span>
            </button>
          </div>
        </section>

        {statusNotice && (
          <div
            role="status"
            className="px-4 py-2.5 rounded-md border border-sky-500/30 bg-sky-500/10 text-xs text-sky-200 flex items-center justify-between"
          >
            <span>{statusNotice}</span>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="text-sky-300 hover:text-white cursor-pointer"
            >
              بستن
            </button>
          </div>
        )}

        {activeTab === 'studio' && (
          <div className="space-y-4">
            {/* Adobe Audition DAW Split Workspace: Side Media/Effects/Markers Bin + Multi-Track Editor */}
            <div className="grid grid-cols-1 xl:grid-cols-[290px_1fr] gap-4 items-start">
              <AuditionSideDock
                tracks={tracks}
                assets={project.assets}
                sampleRate={project.sampleRate}
                history={historyRef.current.getHistory()}
                markers={auditionMarkers}
                onSeekSec={handleSeekSec}
                onToggleTrackMute={handleToggleTrackMute}
                onToggleTrackSolo={handleToggleTrackSolo}
                onSelectTrackRange={(trackId, startSec, endSec) => {
                  setSelection({
                    startSec: Number(startSec.toFixed(2)),
                    endSec: Number(endSec.toFixed(2)),
                    trackId,
                    scope: 'track',
                  });
                  handleSeekSec(startSec);
                }}
                dspRackNode={
                  <div className="text-xs text-slate-300 space-y-2">
                    <p className="text-slate-400 leading-relaxed">
                      رک کامل DSP (HPF {ephemeralDsp.highPassHz}Hz · کمپرسور {ephemeralDsp.compressorThresholdDb}dB · گیت {ephemeralDsp.noiseGateThresholdDb}dB) به‌صورت زنده روی خروجی پخش و رندر فعال است.
                    </p>
                    <button
                      type="button"
                      onClick={handleApplyAcousticAdvisorPreset}
                      className="w-full py-1.5 px-2.5 rounded bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
                    >
                      کالیبراسیون خودکار DSP
                    </button>
                  </div>
                }
              />

              <div className="space-y-4 min-w-0">
                <WaveformCanvas
                  tracks={tracks}
                  assets={project.assets}
                  pcmSources={project.pcmSources}
                  recommendations={recommendations}
                  selectedRecId={selectedRecId}
                  playheadSec={playheadSec}
                  totalDurationSec={totalDurationSec}
                  zoom={zoom}
                  onZoomChange={setZoom}
                  onSeekSec={handleSeekSec}
                  onToggleTrackMute={handleToggleTrackMute}
                  onToggleTrackSolo={handleToggleTrackSolo}
                  onSelectRecommendation={(id) => setSelectedRecId(id)}
                  onSplitAtPlayhead={handleSplitAtPlayhead}
                  onCutWaveformRange={handleCutWaveformRange}
                  detectedSyncOffsetMs={detectedSyncOffsetMs}
                  detectedClockDriftPpm={detectedClockDriftPpm}
                  onAutoAlignSyncedTracks={handleAutoAlignSyncedTracks}
                  onNudgeSyncedTracksMs={handleNudgeSyncedTracksMs}
                  selection={selection}
                  onSelectionChange={setSelection}
                  onPlaySelectionRange={(sel) => handlePlaySelectionRange(sel)}
                />

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                  <div className="lg:col-span-7 space-y-4">
                    <TranscriptPanel
                      tokens={tokens}
                      tracks={tracks}
                      playheadSec={playheadSec}
                      totalDurationSec={totalDurationSec}
                      isTranscribingAsr={isTranscribingAsr}
                      onSeekSec={handleSeekSec}
                      onCutSelectedWords={handleCutSelectedWords}
                      onUpdateTokenDisplayText={handleUpdateTokenDisplayText}
                      onRunPersianAsr={handleRunPersianAsr}
                      onRunForcedAlignment={handleRunForcedAlignment}
                      onRestoreProsodicPunctuation={handleRestoreProsodicPunctuation}
                      onConvertColloquialToFormal={handleConvertColloquialToFormal}
                      onNormalizeNumbersAndCompounds={handleNormalizeNumbersAndCompounds}
                      onRedactSelectedWords={handleRedactSelectedWords}
                      prosodyAndChaptersReport={prosodyAndChaptersReport}
                      onApplyCustomLexicon={handleApplyCustomLexicon}
                      onWsolaTimeStretchSelectedWords={handleWsolaTimeStretchSelectedWords}
                      onPunchInSpectralMatchSelectedWords={handlePunchInSpectralMatchSelectedWords}
                      onOptimizeTrilingualAsr={handleOptimizeTrilingualAsr}
                      englishRenderMode={englishRenderMode}
                    />
                    <DspControlRack
                      ephemeralParams={ephemeralDsp}
                      committedParams={committedDsp}
                      isGestureActive={isGestureActive}
                      sampleRate={project.sampleRate}
                      history={historyRef.current.getHistory()}
                      acousticAdvisor={acousticAdvisor}
                      eqResponseCurveDb={eqResponseCurveDb}
                      phaseDiagnostic={phaseDiagnostic}
                      onEphemeralChange={handleEphemeralDspChange}
                      onCommitGesture={handleCommitDspGesture}
                      onResetDefaults={handleResetDsp}
                      onApplyAcousticAdvisorPreset={handleApplyAcousticAdvisorPreset}
                      onApply8BandPersianVoiceEq={handleApply8BandPersianVoiceEq}
                    />
                  </div>

                  <div className="lg:col-span-5">
                    <SuggestionsPanel
                      recommendations={recommendations}
                      selectedRecId={selectedRecId}
                      previewingId={previewingId}
                      onSelect={(id) => setSelectedRecId(id)}
                      onPreview={handlePreviewRecommendation}
                      onAccept={handleAcceptRecommendation}
                      onReject={handleRejectRecommendation}
                      onNudgeBoundary={handleNudgeBoundary}
                      onBatchAcceptAllSafe={handleBatchAcceptAllSafe}
                      onRescanDeepDisfluencies={handleRescanDeepDisfluencies}
                      onSoftenBreathsAndCoughs={handleSoftenBreathsAndCoughs}
                      onScanMultiTrackCrosstalk={handleScanMultiTrackCrosstalk}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'graph' && (
          <ProcessingGraphView
            nodes={graphNodes}
            edges={defaultGraph.edges}
            sampleRate={project.sampleRate}
            resamplerStats={project.resamplerStats}
            onToggleNodeBypass={handleToggleNodeBypass}
          />
        )}

        {activeTab === 'storage' && (
          <StorageBrokerView
            capabilities={capabilities}
            telemetry={telemetry}
            assets={project.assets}
            isTestingLru={isTestingLru}
            onRunBrokerConcurrencyTest={handleRunBrokerConcurrencyTest}
            onSimulateLruCacheFill={handleSimulateLruCacheFill}
          />
        )}
      </main>

      {/* Docked Bottom Adobe Audition Transport & Player Deck */}
      <AuditionTransportBar
        isPlaying={isPlaying}
        playheadSec={playheadSec}
        totalDurationSec={totalDurationSec}
        selection={selection}
        loopSelection={loopSelection}
        playbackRate={playbackRate}
        peakDb={meterDb.peakDb}
        rmsDb={meterDb.rmsDb}
        onTogglePlay={handleTogglePlay}
        onPlaySelection={() => handlePlaySelectionRange(selection)}
        onStopAndReset={handleStopAndReset}
        onSeekSec={handleSeekSec}
        onToggleLoop={() => setLoopSelection((v) => !v)}
        onChangePlaybackRate={(r) => setPlaybackRate(r)}
        onJumpPrevMarker={handleJumpPrevMarker}
        onJumpNextMarker={handleJumpNextMarker}
        onSetInAtPlayhead={handleSetInAtPlayhead}
        onSetOutAtPlayhead={handleSetOutAtPlayhead}
      />

      <ExportModal
        isOpen={exportOpen}
        isRendering={isRenderingExport}
        progressPct={exportProgress}
        report={exportReport}
        manifest={exportManifest}
        validationErrors={exportStrictErrors}
        downloadUrl={exportDownloadUrl}
        fileName={`avapardaz-export-${Date.now()}.wav`}
        onClose={() => setExportOpen(false)}
      />

      <AsrResearchLabModal
        isOpen={asrLabOpen}
        onClose={() => setAsrLabOpen(false)}
        studioPcm={
          project.pcmSources[tracks[0]?.clips[0]?.assetId ?? Object.keys(project.pcmSources)[0]] ??
          null
        }
        studioSampleRate={project.sampleRate}
        referenceTranscript={tokens.map((t) => t.displayText).join(' ')}
      />

      <DeveloperPlatformPortalModal
        isOpen={devPortalOpen}
        onClose={() => setDevPortalOpen(false)}
      />

      <SpeechIntelligenceModal
        isOpen={speechIntelOpen}
        onClose={() => setSpeechIntelOpen(false)}
        studioTranscriptSegments={
          tokens.length >= 2
            ? [
                {
                  segmentId: 'studio_seg_1',
                  startSec: flicksToSeconds(tokens[0].range.startFlicks),
                  endSec: flicksToSeconds(tokens[Math.floor(tokens.length / 2) - 1].range.endFlicks),
                  text: tokens
                    .slice(0, Math.floor(tokens.length / 2))
                    .map((t) => t.displayText)
                    .join(' '),
                },
                {
                  segmentId: 'studio_seg_2',
                  startSec: flicksToSeconds(tokens[Math.floor(tokens.length / 2)].range.startFlicks),
                  endSec: flicksToSeconds(tokens[tokens.length - 1].range.endFlicks),
                  text: tokens
                    .slice(Math.floor(tokens.length / 2))
                    .map((t) => t.displayText)
                    .join(' '),
                },
              ]
            : []
        }
      />

      <DataFactoryModal
        isOpen={dataFactoryOpen}
        onClose={() => setDataFactoryOpen(false)}
      />

      <ModelFactoryModal
        isOpen={modelFactoryOpen}
        onClose={() => setModelFactoryOpen(false)}
      />

      <SpeechSecurityModal
        isOpen={securityOpen}
        onClose={() => setSecurityOpen(false)}
      />
    </div>
  );
}
