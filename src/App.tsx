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
} from 'lucide-react';
import {
  EphemeralDspParams,
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
import {
  AsrInlineFeedbackState,
  TranscriptPanel,
} from './components/TranscriptPanel';
import { SuggestionsPanel } from './components/SuggestionsPanel';
import { DspControlRack } from './components/DspControlRack';
import { ProcessingGraphView } from './components/ProcessingGraphView';
import { StorageBrokerView } from './components/StorageBrokerView';
import { AsrResearchLabModal } from './components/AsrResearchLabModal';
import { DeveloperPlatformPortalModal } from './components/DeveloperPlatformPortalModal';
import { SpeechIntelligenceModal } from './components/SpeechIntelligenceModal';
import { DataFactoryModal } from './components/DataFactoryModal';
import { ModelFactoryModal } from './components/ModelFactoryModal';
import { SpeechSecurityModal } from './components/SpeechSecurityModal';
import { AuditionTransportBar, WaveformSelectionState } from './components/AuditionTransportBar';
import { AuditionSideDock } from './components/AuditionSideDock';
import { WorkflowStageBar } from './components/WorkflowStageBar';
import { EdlReviewPanel } from './components/EdlReviewPanel';
import { RenderExportModal } from './components/RenderExportModal';
import {
  createSharedLocalModelLifecycleManager,
  LifecycleManagementModal,
  LifecycleModalTab,
} from './components/LifecycleManagementModal';
import {
  buildTranscriptSegmentsFromTokens,
  createBrowserLocalProjectStore,
  StudioWorkflowController,
  StudioWorkflowState,
  WorkflowLocale,
} from './workflow/StudioWorkflowController';
import { AudioRenderConfig } from './audio-renderer';
import { EditProposal } from './ai-engine/edit-decision';
import { SampleRate } from './contracts/timebase.contract';
import {
  buildUserFacingFailure,
  classifyError,
  getSharedDiagnosticLogger,
  UserFacingFailureModel,
} from './reliability';
import type { ExecutionMode } from './processing-engine/UnifiedProcessingContract';
import { ExecutionModePreferenceStore } from './processing-engine/ExecutionModePreferenceStore';
import {
  buildDefaultPersianPodcastProject,
  buildSyntheticMicRecordingPcm,
  ingestRecordedPcmTake,
  ingestUploadedAudioFile,
  LoadedStudioProject,
} from './engine/audioFixtures';
import {
  buildSplicePreviewBuffer,
  StudioAudioTransport,
} from './engine/audioPlayback';
import {
  createDefaultStudioGraph,
  deriveDspBypassFlags,
  DspBypassFlags,
} from './engine/processingGraph';
import {
  CrashRecoveryAndSessionLock,
  CrashRecoveryInspectionResult,
  ProjectLockState,
  RecoveryWriteResult,
} from './runtime/CrashRecoveryAndSessionLock';
import type { ProjectDocument, TimelineTrack } from './contracts/project-schema.contract';
import type { AssetIdentityRecord } from './project-core/ProjectLifecycleAndMigrationEngine';
import { AudioSecurityGuard } from './security/AudioSecurityGuard';
import {
  detectRuntimeCapabilities,
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
  buildHonestAcousticSpeechSegments,
  convertTranscriptColloquialToFormal,
  encodeMono16kWavBase64,
  normalizeNumbersAndCompoundsInTranscript,
  optimizeAndAnalyzeTrilingualAsrTranscript,
  planAsrTranscriptionChunks,
  redactSelectedTokensInAudioAndTranscript,
  restorePersianProsodicPunctuation,
  shiftTokensAndRecommendationsByOffset,
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
  const [asrInlineFeedback, setAsrInlineFeedback] =
    useState<AsrInlineFeedbackState | null>(null);
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
  const dspBypassFlags = useMemo(() => deriveDspBypassFlags(graphNodes), [graphNodes]);

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

  // Studio Tool Modals state
  const [renderModalOpen, setRenderModalOpen] = useState(false);
  const [lifecycleModalOpen, setLifecycleModalOpen] = useState(false);
  const [lifecycleInitialTab, setLifecycleInitialTab] = useState<LifecycleModalTab>('health');
  const [asrLabOpen, setAsrLabOpen] = useState(false);
  const [devPortalOpen, setDevPortalOpen] = useState(false);
  const [speechIntelOpen, setSpeechIntelOpen] = useState(false);
  const [dataFactoryOpen, setDataFactoryOpen] = useState(false);
  const [modelFactoryOpen, setModelFactoryOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [isTestingLru, setIsTestingLru] = useState(false);

  // Mission 07/09/10/Unified Processing state controllers
  const workflowRef = useRef<StudioWorkflowController | null>(null);
  if (!workflowRef.current) {
    workflowRef.current = new StudioWorkflowController({
      projectStore: createBrowserLocalProjectStore(),
      initialLocale: 'fa',
      initialTheme: 'dark',
    });
  }
  const [workflowState, setWorkflowState] = useState<StudioWorkflowState>(() =>
    workflowRef.current!.getState(),
  );
  const modelManagerRef = useRef(createSharedLocalModelLifecycleManager());
  const executionModeStoreRef = useRef(new ExecutionModePreferenceStore());
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() =>
    executionModeStoreRef.current.getPreferredMode(),
  );
  const [cloudAsrConfigured, setCloudAsrConfigured] = useState<boolean>(false);
  const [activeFailure, setActiveFailure] = useState<UserFacingFailureModel | null>(null);

  const transportRef = useRef<StudioAudioTransport | null>(null);
  const activePlaybackScopeRef = useRef<'timeline' | 'selection'>('timeline');
  const historyRef = useRef<TimelineHistoryManager>(new TimelineHistoryManager());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const keydownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});

  const sessionLockRef = useRef<CrashRecoveryAndSessionLock | null>(null);
  const lockLifecycleChainRef = useRef<Promise<void>>(Promise.resolve());
  const [projectLockState, setProjectLockState] = useState<ProjectLockState>('ACQUIRING');
  const [checkpointStatus, setCheckpointStatus] = useState<RecoveryWriteResult | null>(null);
  const [recoveryInspection, setRecoveryInspection] =
    useState<CrashRecoveryInspectionResult | null>(null);
  const [projectSessionNonce, setProjectSessionNonce] = useState(0);
  const projectRevisionRef = useRef<number>(1);
  const latestTracksRef = useRef<Track[]>(tracks);
  latestTracksRef.current = tracks;
  const latestProjectRef = useRef<LoadedStudioProject>(project);
  latestProjectRef.current = project;

  const activeProjectId = useMemo(() => {
    const primaryAssetId = Object.keys(project.assets)[0];
    return primaryAssetId ? `avapardaz-${primaryAssetId.replace(/[^A-Za-z0-9_-]/g, '_')}` : 'avapardaz-demo-ep42';
  }, [project.assets]);

  const buildCanonicalProjectSnapshot = (
    projId: string,
    proj: LoadedStudioProject,
    currentTracks: Track[],
    revision: number,
  ): { doc: ProjectDocument; assetIdentities: AssetIdentityRecord[] } => {
    const canonicalTracks: TimelineTrack[] = currentTracks.map((tr) => ({
      id: tr.id,
      name: tr.name,
      syncGroupId: tr.syncGroupId ?? null,
      speakerId: null,
      muted: Boolean(tr.muted),
      solo: Boolean(tr.solo),
      clips: tr.clips.map((c) => {
        const timelineStart = Math.max(0, Math.round(c.timelineRange.startFlicks));
        const timelineEnd = Math.max(timelineStart + 1, Math.round(c.timelineRange.endFlicks));
        const clipDuration = timelineEnd - timelineStart;
        const sourceStart = Math.max(0, Math.round(c.sourceStartFlicks));
        return {
          id: c.id,
          trackId: tr.id,
          kind: c.kind === 'room-tone-fill' ? 'ROOM_TONE_FILL' : 'AUDIO_ASSET',
          assetId: c.assetId,
          sourceRange: {
            start: sourceStart,
            end: sourceStart + clipDuration,
          },
          timelineRange: {
            start: timelineStart,
            end: timelineEnd,
          },
          fadeInFlicks: Math.max(0, Math.round(msToFlicks(c.fadeInMs))),
          fadeOutFlicks: Math.max(0, Math.round(msToFlicks(c.fadeOutMs))),
          gainDb: Number.isFinite(c.gainDb) ? c.gainDb : 0,
        };
      }),
    }));

    const supportedRates = [16000, 22050, 24000, 32000, 44100, 48000, 96000] as const;
    const canonicalSampleRate = (
      supportedRates.includes(proj.sampleRate as (typeof supportedRates)[number])
        ? proj.sampleRate
        : 48000
    ) as SampleRate;

    const assetIdentities: AssetIdentityRecord[] = Object.values(proj.assets).map((asset) => {
      const pcm = proj.pcmSources[asset.id];
      return {
        assetId: asset.id,
        contentVersion: asset.contentVersion || 1,
        fullContentSha256: asset.contentHash || 'unhashed-local-asset',
        partialFingerprintSha256: asset.partialFingerprint || asset.contentHash || 'unhashed-local-asset',
        fileSize: Math.max(0, asset.fileSizeBytes),
        sampleRate: canonicalSampleRate,
        channelCount: asset.channelLayout === 'stereo' ? 2 : 1,
        sampleCount: pcm ? pcm.length : asset.exactSampleCount || 0,
        originalFileName: asset.name || 'audio.wav',
      };
    });

    return {
      doc: {
        projectId: projId,
        name: proj.projectName || 'پروژه آواپرداز',
        canonicalSampleRate,
        versions: {
          projectSchemaVersion: 2,
          audioEngineVersion: '1.2.0',
          processingNodeCatalogVersion: '1.2',
          activeModelBundleVersion: 'fa-asr-bundle-1.2',
        },
        revision,
        tracks: canonicalTracks,
        recommendations: [],
      },
      assetIdentities,
    };
  };

  const persistDirtyCheckpointForCurrentState = (nextTracks: Track[]) => {
    const lockMgr = sessionLockRef.current;
    if (!lockMgr || lockMgr.getLockState() !== 'LOCKED') return;
    projectRevisionRef.current += 1;
    const { doc, assetIdentities } = buildCanonicalProjectSnapshot(
      activeProjectId,
      latestProjectRef.current,
      nextTracks,
      projectRevisionRef.current,
    );
    void lockMgr
      .persistRecoveryCheckpoint(doc, {
        shutdownState: 'DIRTY_ACTIVE',
        requiredAssetIdentities: assetIdentities,
        requireHeldLock: true,
      })
      .then((res) => {
        setCheckpointStatus(res);
        if (!res.persisted) {
          setStatusNotice(
            `هشدار بازیابی بحران (${res.errorCode ?? 'STORAGE_ERROR'}): ذخیره Checkpoint پایدار ناموفق بود — پروژه در وضعیت محافظت‌نشده است.`,
          );
        }
      })
      .catch(() => {});
  };

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

    return () => {
      cancelled = true;
      unregisterEviction();
      transport.dispose();
      broker.dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/asr/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { cloudGeminiAsrConfigured?: boolean } | null) => {
        if (!cancelled && data && typeof data.cloudGeminiAsrConfigured === 'boolean') {
          setCloudAsrConfigured(data.cloudGeminiAsrConfigured);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Real project session lock acquisition, crash recovery inspection, lock-loss guard & clean shutdown
  useEffect(() => {
    let cancelled = false;
    const sessionLock = new CrashRecoveryAndSessionLock();
    sessionLockRef.current = sessionLock;
    setProjectLockState('ACQUIRING');

    const unsubLockLost = sessionLock.onLockLost((ev) => {
      if (cancelled) return;
      setProjectLockState(ev.nextState);
      setStatusNotice(
        `قفل انحصاری پروژه از دست رفت (${ev.reasonCode}): حالت فقط‌خواندنی فعال شد تا از تداخل ویرایش جلوگیری شود.`,
      );
    });

    const acquireTask = lockLifecycleChainRef.current
      .catch(() => {})
      .then(async () => {
        if (cancelled) {
          return;
        }
        const lockRes = await sessionLock.acquireProjectLock(activeProjectId);
        if (cancelled) {
          await sessionLock.releaseProjectLockAsync();
          return;
        }
        setProjectLockState(lockRes.state);
        if (!lockRes.acquired) {
          if (lockRes.state === 'LOCK_UNAVAILABLE') {
            setStatusNotice(
              'حالت فقط‌خواندنی امن: مرورگر فعلی از قفل انحصاری (Web Locks / IndexedDB) پشتیبانی نمی‌کند.',
            );
          } else {
            setStatusNotice(
              'حالت فقط‌خواندنی: این پروژه هم‌اکنون در تب دیگری باز است و ویرایش هم‌زمان مسدود شد.',
            );
          }
          return;
        }

        const inspection = await sessionLock.inspectCrashRecovery(activeProjectId);
        if (cancelled) return;
        setRecoveryInspection(inspection);
        if (inspection.status === 'RECOVERY_CORRUPTED' || inspection.status === 'RECOVERY_INCOMPATIBLE') {
          setStatusNotice(
            `هشدار بازیابی (${inspection.status}): نقطه بازیابی ذخیره‌شده آسیب‌دیده یا ناسازگار است (${inspection.errorCode ?? 'UNKNOWN'}).`,
          );
        } else if (inspection.status === 'RECOVERY_STORAGE_UNAVAILABLE') {
          setStatusNotice(
            'هشدار ذخیره‌سازی: حافظه پایدار بازیابی بحران در این محیط در دسترس نیست.',
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectLockState('ERROR');
        }
      });

    lockLifecycleChainRef.current = acquireTask;

    const handlePageHide = () => {
      if (sessionLock.getLockState() === 'LOCKED') {
        const { doc, assetIdentities } = buildCanonicalProjectSnapshot(
          activeProjectId,
          latestProjectRef.current,
          latestTracksRef.current,
          projectRevisionRef.current,
        );
        void sessionLock.completeCleanShutdown(doc, assetIdentities).catch(() => {});
      } else {
        void sessionLock.releaseProjectLockAsync().catch(() => {});
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', handlePageHide);
    }

    return () => {
      cancelled = true;
      unsubLockLost();
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', handlePageHide);
      }
      const cleanupTask = acquireTask
        .catch(() => {})
        .then(async () => {
          if (sessionLock.getLockState() === 'LOCKED') {
            const { doc, assetIdentities } = buildCanonicalProjectSnapshot(
              activeProjectId,
              latestProjectRef.current,
              latestTracksRef.current,
              projectRevisionRef.current,
            );
            await sessionLock.completeCleanShutdown(doc, assetIdentities);
          } else {
            await sessionLock.releaseProjectLockAsync();
          }
        })
        .catch(() => {});
      lockLifecycleChainRef.current = cleanupTask;
    };
  }, [activeProjectId]);

  // Keep StudioWorkflowController subscribed for the full app lifetime
  useEffect(() => {
    const ctrl = workflowRef.current!;
    const unsub = ctrl.subscribe(setWorkflowState);
    return () => {
      unsub();
    };
  }, []);

  // Open project in StudioWorkflowController ONLY when a genuinely new project session loads
  // (never on in-place PCM edits like denoise/redaction/EQ/WSOLA or Undo/Redo!)
  useEffect(() => {
    const ctrl = workflowRef.current!;
    const currentProject = latestProjectRef.current;
    const primaryAssetId = Object.keys(currentProject.assets)[0];
    const primaryAsset = primaryAssetId ? currentProject.assets[primaryAssetId] : undefined;
    const primaryPcm = primaryAssetId ? currentProject.pcmSources[primaryAssetId] : undefined;

    if (primaryAsset && primaryPcm) {
      ctrl.openProject({
        projectId: primaryAsset.id,
        projectName: currentProject.projectName,
        sourceAudio: {
          sourceAudioId: primaryAsset.id,
          sourceAudioHash: primaryAsset.contentHash,
          fileName: primaryAsset.name,
          format: primaryAsset.container,
          sampleRate: (currentProject.sampleRate as SampleRate) || 48000,
          channelCount: 1,
          bitDepth: 32,
          totalSamples: primaryPcm.length,
          durationSec: primaryPcm.length / currentProject.sampleRate,
          fileSizeBytes: primaryAsset.fileSizeBytes,
          importStatus: primaryAsset.container === 'synthetic-pcm' ? 'SYNTHETIC_FIXTURE' : 'VALIDATED',
          isDemoFixture: primaryAsset.container === 'synthetic-pcm',
        },
        initialSegments: buildTranscriptSegmentsFromTokens(
          currentProject.tokens,
          Object.fromEntries(currentProject.tracks.map((tr) => [tr.id, tr.name])),
        ),
      });
    }
  }, [activeProjectId, projectSessionNonce]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', workflowState.theme === 'dark');
    document.documentElement.lang = workflowState.locale === 'fa' ? 'fa' : 'en';
    document.documentElement.dir = workflowState.locale === 'fa' ? 'rtl' : 'ltr';
  }, [workflowState.theme, workflowState.locale]);

  const syncWorkflowTranscript = (
    nextTokens: readonly PersianWordToken[],
    changeSummary: string,
    options?: { establishRawIfEmpty?: boolean; targetTracks?: readonly Track[] },
  ) => {
    const ctrl = workflowRef.current;
    if (!ctrl) return;
    const speakerByTrackId = Object.fromEntries(
      (options?.targetTracks ?? tracks).map((tr) => [tr.id, tr.name]),
    );
    ctrl.syncTranscriptFromSegments({
      segments: buildTranscriptSegmentsFromTokens(nextTokens, speakerByTrackId),
      changeSummary,
      establishRawIfEmpty: options?.establishRawIfEmpty,
    });
  };

  const totalDurationFlicks = useMemo(() => computeTimelineDurationFlicks(tracks), [tracks]);
  const totalDurationSec = flicksToSeconds(totalDurationFlicks);

  const handleStopAndReset = () => {
    transportRef.current?.stop();
    activePlaybackScopeRef.current = 'timeline';
    setIsPlaying(false);
    setPreviewingId(null);
    setMeterDb({ peakDb: -60, rmsDb: -60 });
    setPlayheadSec(selection ? selection.startSec : 0);
  };

  const resyncActivePlayback = (overrides?: {
    tracks?: Track[];
    dspParams?: EphemeralDspParams;
    dspBypassFlags?: DspBypassFlags;
    startSec?: number;
    playbackRate?: number;
    loop?: boolean;
  }) => {
    if (!isPlaying || !transportRef.current) return;
    const activeTracks = overrides?.tracks ?? tracks;
    const activeDurationSec = flicksToSeconds(computeTimelineDurationFlicks(activeTracks));
    const activeLoop = overrides?.loop ?? loopSelection;
    const inSelectionScope =
      activePlaybackScopeRef.current === 'selection' &&
      selection !== null &&
      selection.endSec - selection.startSec >= 0.05;

    let startSec: number;
    let endSec: number;
    let shouldLoop: boolean;

    if (inSelectionScope && selection) {
      endSec = Math.min(activeDurationSec, selection.endSec);
      const requestedStart = overrides?.startSec ?? playheadSec;
      startSec =
        requestedStart >= endSec - 0.01 || requestedStart < selection.startSec
          ? selection.startSec
          : requestedStart;
      shouldLoop = activeLoop;
    } else {
      endSec = activeDurationSec;
      const requestedStart = overrides?.startSec ?? playheadSec;
      startSec = Math.max(0, Math.min(activeDurationSec, requestedStart));
      shouldLoop = activeLoop && !selection;
    }

    transportRef.current.playTimelineWindowed({
      tracks: activeTracks,
      assets: project.assets,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      startTimelineSec: startSec,
      totalDurationSec: activeDurationSec,
      endTimelineSec: endSec,
      loop: shouldLoop,
      playbackRate: overrides?.playbackRate ?? playbackRate,
      dspParams: overrides?.dspParams ?? ephemeralDsp,
      dspBypassFlags: overrides?.dspBypassFlags ?? dspBypassFlags,
      onTick: (tSec) => setPlayheadSec(Math.min(activeDurationSec, tSec)),
      onMeter: (peakDb, rmsDb) => setMeterDb({ peakDb, rmsDb }),
      onEnded: () => {
        setIsPlaying(false);
        setMeterDb({ peakDb: -60, rmsDb: -60 });
      },
    });
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

    activePlaybackScopeRef.current = 'timeline';
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
      dspBypassFlags,
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
    activePlaybackScopeRef.current = 'selection';
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
      dspBypassFlags,
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
      if (
        activePlaybackScopeRef.current === 'selection' &&
        selection &&
        (clamped < selection.startSec || clamped >= selection.endSec - 0.01)
      ) {
        activePlaybackScopeRef.current = 'timeline';
      }
      resyncActivePlayback({ startSec: clamped });
    }
  };

  const getTrackPrimaryAssetId = (
    track: Track | undefined,
    fallbackRecord?: Record<string, unknown>,
  ): string | undefined => {
    const speechAsset = track?.clips.find((c) => c.kind === 'speech')?.assetId;
    if (speechAsset) return speechAsset;
    if (track?.clips[0]?.assetId) return track.clips[0].assetId;
    return fallbackRecord ? Object.keys(fallbackRecord)[0] : undefined;
  };

  const clampSelectionRange = (
    sel: WaveformSelectionState | null,
    maxDurationSec: number = totalDurationSec,
  ): WaveformSelectionState | null => {
    if (!sel) return null;
    const maxSec = Math.max(0.05, maxDurationSec);
    const startSec = Number(Math.max(0, Math.min(maxSec, sel.startSec)).toFixed(3));
    const endSec = Number(Math.max(startSec, Math.min(maxSec, sel.endSec)).toFixed(3));
    if (endSec - startSec < 0.01) return null;
    return { ...sel, startSec, endSec };
  };

  const clampPlaybackAndSelectionToTracks = (nextTracks: Track[]) => {
    const nextDurationSec = flicksToSeconds(computeTimelineDurationFlicks(nextTracks));
    setPlayheadSec((prev) => (prev > nextDurationSec ? Math.max(0, nextDurationSec) : prev));
    setSelection((prev) => clampSelectionRange(prev, nextDurationSec));
  };

  const handleSetInAtPlayhead = () => {
    const maxSec = Math.max(0.1, totalDurationSec);
    const startSec = Number(Math.max(0, Math.min(maxSec - 0.05, playheadSec)).toFixed(2));
    const endSec =
      selection && selection.endSec > startSec + 0.05
        ? Math.min(maxSec, selection.endSec)
        : Number(Math.min(maxSec, startSec + 1.0).toFixed(2));
    setSelection(
      clampSelectionRange({
        startSec,
        endSec,
        trackId: selection?.trackId ?? tracks[0]?.id ?? 'track-host',
        scope: selection?.scope ?? 'all',
      }),
    );
  };

  const handleSetOutAtPlayhead = () => {
    const maxSec = Math.max(0.1, totalDurationSec);
    const endSec = Number(Math.min(maxSec, Math.max(0.05, playheadSec)).toFixed(2));
    const startSec =
      selection && selection.startSec < endSec - 0.05
        ? Math.max(0, selection.startSec)
        : Number(Math.max(0, endSec - 1.0).toFixed(2));
    setSelection(
      clampSelectionRange({
        startSec,
        endSec,
        trackId: selection?.trackId ?? tracks[0]?.id ?? 'track-host',
        scope: selection?.scope ?? 'all',
      }),
    );
  };

  const handlePreviewRecommendation = (rec: SmartRecommendation, mode: 'before' | 'after') => {
    if (!transportRef.current) return;
    transportRef.current.stop();
    setIsPlaying(false);

    const liveSafety = determineSyncSafeEditMode(
      tracks,
      rec.trackId,
      rec.boundary.snappedRange,
      tokens,
      project.pcmSources,
      project.sampleRate,
    );
    const effectiveMode: RecommendationActionMode =
      rec.recommendedMode === 'in-place-room-tone-suppression' ||
      liveSafety.mode === 'in-place-room-tone-suppression'
        ? 'in-place-room-tone-suppression'
        : 'sync-locked-ripple-cut';

    const previewTracksAfter = applySyncSafeCut(
      tracks,
      rec.trackId,
      rec.boundary.snappedRange,
      effectiveMode,
    );

    const buf = buildSplicePreviewBuffer({
      tracksBeforeEdit: tracks,
      tracksAfterEdit: previewTracksAfter,
      assets: project.assets,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      cutRange: rec.boundary.snappedRange,
      dspParams: ephemeralDsp,
      dspBypassFlags,
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
  const isReadOnlyLocked = projectLockState !== 'LOCKED';

  const executeSynchronizedCut = (params: {
    targetTrackId: string;
    cutRange: FlickRange;
    mode: RecommendationActionMode;
    descriptionFa: string;
    affectedRecommendationId?: string;
    scope?: 'track' | 'all';
  }): boolean => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return false;
    }
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    let nextTracks: Track[];
    let nextTokens: PersianWordToken[];
    let nextRecs: SmartRecommendation[];

    if (params.mode === 'in-place-room-tone-suppression' && params.scope === 'all') {
      const targetTrack = tracks.find((t) => t.id === params.targetTrackId);
      const targetSyncGroup = targetTrack?.syncGroupId;
      const affectedTracks = tracks.filter(
        (t) =>
          !t.muted &&
          (targetSyncGroup ? t.syncGroupId === targetSyncGroup : true),
      );
      const trackIdsToSuppress =
        affectedTracks.length > 0 ? affectedTracks.map((t) => t.id) : [params.targetTrackId];

      nextTracks = cloneTracks(tracks);
      nextTokens = cloneTokens(tokens);
      nextRecs = cloneRecommendations(recommendations);

      for (const tid of trackIdsToSuppress) {
        const prevTracksSnapshot = nextTracks;
        nextTracks = applySyncSafeCut(
          prevTracksSnapshot,
          tid,
          params.cutRange,
          'in-place-room-tone-suppression',
        );
        nextTokens = projectTokensAfterCut(
          nextTokens,
          prevTracksSnapshot,
          tid,
          params.cutRange,
          'in-place-room-tone-suppression',
        );
        nextRecs = projectRecommendationsAfterCut(
          nextRecs,
          prevTracksSnapshot,
          tid,
          params.cutRange,
          'in-place-room-tone-suppression',
          tid === params.targetTrackId ? params.affectedRecommendationId : undefined,
        );
      }
    } else {
      nextTracks = applySyncSafeCut(
        tracks,
        params.targetTrackId,
        params.cutRange,
        params.mode,
      );
      nextTokens = projectTokensAfterCut(
        tokens,
        tracks,
        params.targetTrackId,
        params.cutRange,
        params.mode,
      );
      nextRecs = projectRecommendationsAfterCut(
        recommendations,
        tracks,
        params.targetTrackId,
        params.cutRange,
        params.mode,
        params.affectedRecommendationId,
      );
    }

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
    syncWorkflowTranscript(nextTokens, params.descriptionFa, { targetTracks: nextTracks });
    setRecommendations(nextRecs);
    persistDirtyCheckpointForCurrentState(nextTracks);
    clampPlaybackAndSelectionToTracks(nextTracks);
    setHistoryTick((v) => v + 1);
    return true;
  };

  const handleAcceptRecommendation = (rec: SmartRecommendation) => {
    // Re-evaluate sync safety against live tracks, tokens, and peer PCM energy so stale recommendations cannot break sync
    const liveSafety = determineSyncSafeEditMode(
      tracks,
      rec.trackId,
      rec.boundary.snappedRange,
      tokens,
      project.pcmSources,
      project.sampleRate,
    );
    const effectiveMode: RecommendationActionMode =
      rec.recommendedMode === 'in-place-room-tone-suppression' ||
      liveSafety.mode === 'in-place-room-tone-suppression'
        ? 'in-place-room-tone-suppression'
        : 'sync-locked-ripple-cut';

    const applied = executeSynchronizedCut({
      targetTrackId: rec.trackId,
      cutRange: rec.boundary.snappedRange,
      mode: effectiveMode,
      descriptionFa: `${
        effectiveMode === 'sync-locked-ripple-cut' ? 'برش هم‌زمان' : 'جایگزینی Room Tone'
      }: ${rec.relatedText}`,
      affectedRecommendationId: rec.id,
    });
    if (!applied) return;
    setStatusNotice(`تغییر «${rec.relatedText}» به‌صورت غیرمخرب و همگام با متن اعمال شد.`);
  };

  const handleCutSelectedWords = (
    selectedTokenIds: string[],
    explicitMode?: RecommendationActionMode,
  ): boolean => {
    const cutSpec = computeMultiWordCutRange(tokens, selectedTokenIds);
    if (!cutSpec) return false;

    const decision = determineSyncSafeEditMode(
      tracks,
      cutSpec.trackId,
      cutSpec.range,
      tokens,
      project.pcmSources,
      project.sampleRate,
    );
    const modeToUse = explicitMode ?? decision.mode;

    const applied = executeSynchronizedCut({
      targetTrackId: cutSpec.trackId,
      cutRange: cutSpec.range,
      mode: modeToUse,
      descriptionFa: `${
        modeToUse === 'sync-locked-ripple-cut' ? 'برش متنی (Ripple)' : 'سکوت درجا (Room Tone)'
      }: «${cutSpec.combinedText}»`,
    });
    if (!applied) return false;

    setStatusNotice(
      `تدوین متن‌محور: «${cutSpec.combinedText}» با حالت ${
        modeToUse === 'sync-locked-ripple-cut'
          ? 'برش زمانی همگام (Ripple Cut)'
          : 'جایگزینی درجا با Room Tone'
      } اعمال شد.`,
    );
    return true;
  };

  const handleCutWaveformRange = (
    range: FlickRange,
    targetTrackId: string,
    mode: RecommendationActionMode,
    scope?: 'track' | 'all',
  ): boolean => {
    const startSec = flicksToSeconds(range.startFlicks).toFixed(2);
    const endSec = flicksToSeconds(range.endFlicks).toFixed(2);
    const applied = executeSynchronizedCut({
      targetTrackId,
      cutRange: range,
      mode,
      scope,
      descriptionFa: `${
        mode === 'sync-locked-ripple-cut' ? 'برش بازه موج صوت' : 'Room Tone بازه موج صوت'
      } [${startSec}s..${endSec}s]`,
    });
    if (!applied) return false;
    setStatusNotice(`بازه [${startSec}s تا ${endSec}s] با موفقیت تدوین و با واژگان همگام شد.`);
    return true;
  };

  const handleSplitAtPlayhead = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
    persistDirtyCheckpointForCurrentState(nextTracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `برش غیرمخرب (Split) در زمان ${playheadSec.toFixed(2)} ثانیه روی ${splitCount} ترک با Micro-Crossfade اعمال شد.`,
    );
  };

  const handleUpdateTokenDisplayText = (tokenId: string, newDisplayText: string) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    const existing = tokens.find((tok) => tok.id === tokenId);
    if (!existing || existing.displayText === newDisplayText) {
      return;
    }
    const beforeTokensSnapshot = cloneTokens(tokens);
    const nextTokens = tokens.map((tok) =>
      tok.id === tokenId ? { ...tok, displayText: newDisplayText } : tok,
    );
    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `ویرایش املای نمایشی واژه به «${newDisplayText}»`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });
    setTokens(nextTokens);
    syncWorkflowTranscript(nextTokens, `ویرایش املای نمایشی واژه به «${newDisplayText}»`);
    setHistoryTick((v) => v + 1);
    setStatusNotice(`املای نمایشی واژه به «${newDisplayText}» با حفظ لایه خام ASR به‌روزرسانی شد.`);
  };

  const resolveTrackAssetAndPcm = async (targetTrack: Track | undefined) => {
    if (!targetTrack) return null;
    const primaryAssetId = getTrackPrimaryAssetId(targetTrack, project.assets);
    if (!primaryAssetId) return null;
    const asset = project.assets[primaryAssetId];
    if (!asset) return null;

    let pcm = project.pcmSources[primaryAssetId];
    if (!pcm && brokerRef.current && asset.exactSampleCount > 0) {
      const blockSize = asset.blockSizeSamples ?? Math.max(1, asset.nativeSampleRate * 4);
      pcm = await brokerRef.current.streamReadRange(
        primaryAssetId,
        0,
        asset.exactSampleCount,
        blockSize,
        undefined,
        'io-broker',
      );
    }
    if (!pcm || pcm.length === 0) return null;
    return { targetTrack, primaryAssetId, asset, pcm };
  };

  const handleRunForcedAlignment = async (customPersianScript: string, targetTrackId: string) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      setAsrInlineFeedback({
        kind: 'READ_ONLY',
        titleFa: 'ویرایش غیرفعال است',
        messageFa: 'پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.',
      });
      return;
    }
    const targetTrack = tracks.find((t) => t.id === targetTrackId) ?? tracks[0];
    if (!targetTrack) return;
    const resolved = await resolveTrackAssetAndPcm(targetTrack);
    if (!resolved) {
      setStatusNotice('بافر صوتی ترک انتخاب‌شده در دسترس نیست؛ لطفاً فایل صوتی را دوباره وارد کنید.');
      setAsrInlineFeedback({
        kind: 'AUDIO_MISSING',
        titleFa: 'داده صوتی برای هم‌ترازی در دسترس نیست',
        messageFa: 'فایل صوتی این ترک در حافظه فعال یافت نشد.',
      });
      return;
    }
    const { asset, pcm } = resolved;

    const beforeTokensSnapshot = cloneTokens(tokens);
    const beforeRecsSnapshot = cloneRecommendations(recommendations);

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

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `هم‌ترازی اجباری (${aligned.tokens.length} واژه فارسی)`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: mergedTokens,
      beforeRecommendations: beforeRecsSnapshot,
      afterRecommendations: mergedRecs,
    });

    setTokens(mergedTokens);
    syncWorkflowTranscript(
      mergedTokens,
      `هم‌ترازی اجباری (${aligned.tokens.length} واژه فارسی)`,
      { establishRawIfEmpty: true },
    );
    setRecommendations(mergedRecs);
    setSelectedRecId(mergedRecs[0]?.id ?? null);
    setActiveFailure(null);
    setAsrInlineFeedback({
      kind: 'SUCCESS',
      titleFa: 'هم‌ترازی آوایی متن با صوت انجام شد',
      messageFa: `${aligned.tokens.length} واژه فارسی با دره‌های انرژی و نقاط عبور از صفر موج صوت هم‌تراز شدند.`,
    });
    persistDirtyCheckpointForCurrentState(tracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `هم‌ترازی اجباری (Forced Alignment) انجام شد: ${aligned.tokens.length} واژه فارسی به مرزهای آوایی موج صوت اسنپ شد.`,
    );
  };

  const handleChangeExecutionMode = (nextMode: ExecutionMode) => {
    executionModeStoreRef.current.setPreferredMode(
      nextMode,
      nextMode === 'CLOUD' ? { explicitCloudOptIn: true } : undefined,
    );
    setExecutionMode(nextMode);
    if (nextMode === 'LOCAL' && asrInlineFeedback?.kind === 'CLOUD_UNCONFIGURED') {
      setAsrInlineFeedback(null);
      setActiveFailure(null);
    }
    setStatusNotice(
      nextMode === 'LOCAL'
        ? 'مسیر پردازش روی حالت محلی (پیش‌فرض Local-First) تنظیم شد. این تغییر فقط روی کارهای جدید اعمال می‌شود.'
        : cloudAsrConfigured
          ? 'مسیر پردازش به‌صورت صریح روی حالت ابری (Gemini ASR) تنظیم شد.'
          : 'مسیر پردازش به‌صورت صریح روی حالت ابری (اختیاری) تنظیم شد. هیچ سرویس‌دهنده ابری متصل نیست و بازگشت خودکار پنهان انجام نمی‌شود.',
    );
  };

  const handleRunAcousticSegmentation = async () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      setAsrInlineFeedback({
        kind: 'READ_ONLY',
        titleFa: 'ویرایش غیرفعال است',
        messageFa: 'پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.',
      });
      return;
    }

    setIsTranscribingAsr(true);
    try {
      const resolved = await resolveTrackAssetAndPcm(tracks[0]);
      if (!resolved) {
        setStatusNotice('فایل صوتی قابل پردازش روی ترک اصلی یافت نشد.');
        setAsrInlineFeedback({
          kind: 'AUDIO_MISSING',
          titleFa: 'فایل صوتی یافت نشد',
          messageFa: 'برای تحلیل و هم‌ترازی آوایی، ابتدا یک فایل صوتی وارد یا ضبط کنید.',
        });
        return;
      }

      const { targetTrack, asset, pcm } = resolved;
      const beforeTokensSnapshot = cloneTokens(tokens);
      const beforeRecsSnapshot = cloneRecommendations(recommendations);

      const segResult = buildHonestAcousticSpeechSegments({
        pcm,
        sampleRate: project.sampleRate,
        trackId: targetTrack.id,
        speakerName: targetTrack.speakerLabel,
        acousticProfile: asset.acousticProfile,
      });

      if (segResult.burstCount === 0 || segResult.tokens.length === 0) {
        workflowRef.current?.setAsrState({
          state: 'NO_SPEECH_DETECTED',
          message: 'در این سیگنال صوتی بخش گفتاری فعال بالاتر از کف نویز اتاق شناسایی نشد.',
        });
        setAsrInlineFeedback({
          kind: 'NO_SPEECH',
          titleFa: 'گفتاری بالاتر از کف نویز شناسایی نشد',
          messageFa:
            'فایل صوتی بررسی شد اما بازه گفتاری فعالی با مدت حداقل ۹۰ میلی‌ثانیه بالاتر از سطح سکوت پیدا نشد.',
        });
        setStatusNotice('در تحلیل آوایی، بخش گفتاری فعالی بالاتر از کف نویز شناسایی نشد.');
        return;
      }

      const otherTrackTokens = tokens.filter((t) => t.trackId !== targetTrack.id);
      const mergedTokens = [...otherTrackTokens, ...segResult.tokens].sort(
        (a, b) => a.range.startFlicks - b.range.startFlicks,
      );
      const otherTrackRecs = recommendations.filter((r) => r.trackId !== targetTrack.id);
      const mergedRecs = [...otherTrackRecs, ...segResult.recommendations];

      historyRef.current.commitTransaction({
        coalescingKey: '',
        type: 'dsp-parameter-change',
        description: `بخش‌بندی و هم‌ترازی آوایی (${segResult.tokens.length} قطعه گفتاری)`,
        beforeTracks: tracks,
        afterTracks: tracks,
        beforeTokens: beforeTokensSnapshot,
        afterTokens: mergedTokens,
        beforeRecommendations: beforeRecsSnapshot,
        afterRecommendations: mergedRecs,
      });

      setTokens(mergedTokens);
      syncWorkflowTranscript(
        mergedTokens,
        `بخش‌بندی و هم‌ترازی آوایی (${segResult.tokens.length} قطعه گفتاری)`,
        { establishRawIfEmpty: true },
      );
      setRecommendations(mergedRecs);
      setSelectedRecId(mergedRecs[0]?.id ?? null);
      setActiveFailure(null);
      setAsrInlineFeedback({
        kind: 'SUCCESS',
        titleFa: 'بخش‌بندی و هم‌ترازی آوایی محلی انجام شد',
        messageFa: `${segResult.tokens.length} قطعه گفتار آوایی از روی انرژی موج صوت استخراج و به مرزهای عبور از صفر اسنپ شد (بدون نیاز به مدل ONNX؛ برای متن دقیق واژگان می‌توانید از «هم‌ترازی با متن دلخواه» یا نصب مدل ONNX استفاده کنید).`,
      });
      persistDirtyCheckpointForCurrentState(tracks);
      setHistoryTick((v) => v + 1);
      setStatusNotice(
        `بخش‌بندی آوایی محلی تکمیل شد: ${segResult.tokens.length} قطعه گفتاری هم‌تراز‌شده و ${segResult.recommendations.length} پیشنهاد تدوین شناسایی شد.`,
      );
    } finally {
      setIsTranscribingAsr(false);
    }
  };

    const executeCloudGeminiAsr = async () => {
      if (isReadOnlyLocked) {
        setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
        setAsrInlineFeedback({
          kind: 'READ_ONLY',
          titleFa: 'ویرایش غیرفعال است',
          messageFa: 'پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.',
        });
        return;
      }

      const resolved = await resolveTrackAssetAndPcm(tracks[0]);
      if (!resolved) {
        setStatusNotice('فایل صوتی قابل پردازش روی ترک اصلی یافت نشد.');
        setAsrInlineFeedback({
          kind: 'AUDIO_MISSING',
          titleFa: 'فایل صوتی یافت نشد',
          messageFa: 'برای اجرای تبدیل صوت به متن، ابتدا یک فایل صوتی معتبر وارد کنید.',
        });
        return;
      }
      const { targetTrack, asset, pcm } = resolved;

      setIsTranscribingAsr(true);
      setActiveFailure(null);
      workflowRef.current?.setAsrState({
        state: 'INFERENCE_RUNNING',
        modelId: 'gemini-3.5-transcribe',
        modelVersion: 'cloud-2026',
        progressPct: 20,
        message: 'در حال ارسال ایمن صوت به موتور Gemini ASR و استخراج کلمات فارسی...',
      });
      setStatusNotice('در حال تبدیل صوت به متن با Gemini ASR و هم‌ترازی آوایی روی تایم‌لاین...');

      try {
        const beforeTokensSnapshot = cloneTokens(tokens);
        const beforeRecsSnapshot = cloneRecommendations(recommendations);
        const chunkPlans = planAsrTranscriptionChunks(pcm.length, project.sampleRate, 60);

        const aggregatedTokens: PersianWordToken[] = [];
        const aggregatedRecs: SmartRecommendation[] = [];

        for (let idx = 0; idx < chunkPlans.length; idx++) {
          const plan = chunkPlans[idx];
          const chunkPcm = pcm.subarray(plan.startSample, plan.endSample);

          let maxAbs = 0;
          for (let s = 0; s < chunkPcm.length; s += 8) {
            const v = Math.abs(chunkPcm[s]);
            if (v > maxAbs) maxAbs = v;
          }
          if (maxAbs < 1e-4) {
            continue;
          }

          workflowRef.current?.setAsrState({
            state: 'INFERENCE_RUNNING',
            modelId: 'gemini-3.5-transcribe',
            modelVersion: 'cloud-2026',
            progressPct: Math.min(
              95,
              Math.round(((idx + 0.5) / Math.max(1, chunkPlans.length)) * 75) + 15,
            ),
            message: `در حال ارسال ایمن بخش ${idx + 1} از ${chunkPlans.length} به Gemini ASR و هم‌ترازی آوایی...`,
          });

          const resampled16k = resampleTo16kMono([chunkPcm], project.sampleRate, 16_000);
          const audioBase64 = encodeMono16kWavBase64(resampled16k.samples, 16_000);

          const resp = await fetch('/api/v1/asr/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64, mimeType: 'audio/wav' }),
          });

          const payload = (await resp.json().catch(() => ({}))) as {
            transcriptText?: string;
            error?: string;
            message?: string;
            messageFa?: string;
          };

          if (resp.status === 503 || payload.error === 'ASR_API_KEY_UNAVAILABLE') {
            setCloudAsrConfigured(false);
            const unavailableMsg =
              payload.messageFa ??
              'کلید سرویس ابری در سرور تنظیم نشده است. برای حفظ شفافیت، بازگشت خودکار به محلی انجام نشد.';
            workflowRef.current?.setAsrState({
              state: 'INFERENCE_FAILED',
              modelId: 'gemini-3.5-transcribe',
              modelVersion: 'cloud-2026',
              message: unavailableMsg,
            });
            const err = classifyError(
              new Error('CLOUD_PROVIDER_UNAVAILABLE: No Cloud provider endpoint or credentials are configured.'),
              { subsystem: 'ASR_RUNTIME' },
            );
            setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
            setAsrInlineFeedback({
              kind: 'CLOUD_UNCONFIGURED',
              titleFa: 'حالت ابری پیکربندی نشده است',
              messageFa: unavailableMsg,
            });
            setStatusNotice('کلید سرویس‌دهنده ابری روی سرور پیکربندی نشده است؛ بازگشت پنهان انجام نشد.');
            return;
          }

          if (!resp.ok) {
            throw new Error(payload.message ?? payload.error ?? `HTTP ${resp.status}`);
          }

          const chunkText = (payload.transcriptText ?? '').trim();
          if (chunkText.length > 0) {
            const aligned = alignPersianScriptToAudio({
              pcm: chunkPcm,
              sampleRate: project.sampleRate,
              precomputed16k: resampled16k.samples,
              trackId: targetTrack.id,
              speakerName: targetTrack.speakerLabel,
              rawTranscriptText: chunkText,
              acousticProfile: asset.acousticProfile,
              alignmentSource: 'ASR',
            });
            const shifted = shiftTokensAndRecommendationsByOffset({
              tokens: aligned.tokens,
              recommendations: aligned.recommendations,
              offsetSec: plan.startSec,
              chunkIndex: plan.chunkIndex,
            });
            aggregatedTokens.push(...shifted.tokens);
            aggregatedRecs.push(...shifted.recommendations);
          }

          if (idx + 1 < chunkPlans.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }

        if (aggregatedTokens.length === 0) {
          workflowRef.current?.setAsrState({
            state: 'NO_SPEECH_DETECTED',
            modelId: 'gemini-3.5-transcribe',
            modelVersion: 'cloud-2026',
            progressPct: 100,
            message: 'گفتار قابل‌تشخیصی در این فایل صوتی شناسایی نشد.',
          });
          setAsrInlineFeedback({
            kind: 'NO_SPEECH',
            titleFa: 'گفتار قابل‌تشخیصی در صوت یافت نشد',
            messageFa:
              'صوت بررسی شد اما واژه‌ای از گفتار استخراج نشد. اگر فایل بسیار آرام یا نویزی است، ابتدا «حذف نویز طیفی» را اجرا کنید یا از «هم‌ترازی با متن دلخواه» استفاده نمایید.',
          });
          setStatusNotice('در تبدیل صوت به متن (Gemini ASR)، گفتار قابل‌تشخیصی در این فایل یافت نشد.');
          return;
        }

        const otherTrackTokens = tokens.filter((t) => t.trackId !== targetTrack.id);
        const mergedTokens = [...otherTrackTokens, ...aggregatedTokens].sort(
          (a, b) => a.range.startFlicks - b.range.startFlicks,
        );
        const otherTrackRecs = recommendations.filter((r) => r.trackId !== targetTrack.id);
        const mergedRecs = [...otherTrackRecs, ...aggregatedRecs];

        historyRef.current.commitTransaction({
          coalescingKey: '',
          type: 'dsp-parameter-change',
          description: `تبدیل صوت به متن Gemini ASR (${aggregatedTokens.length} واژه فارسی)`,
          beforeTracks: tracks,
          afterTracks: tracks,
          beforeTokens: beforeTokensSnapshot,
          afterTokens: mergedTokens,
          beforeRecommendations: beforeRecsSnapshot,
          afterRecommendations: mergedRecs,
        });

        setTokens(mergedTokens);
        syncWorkflowTranscript(
          mergedTokens,
          `تبدیل صوت به متن Gemini ASR (${aggregatedTokens.length} واژه فارسی)`,
          { establishRawIfEmpty: true },
        );
        setRecommendations(mergedRecs);
        setSelectedRecId(mergedRecs[0]?.id ?? null);
        persistDirtyCheckpointForCurrentState(tracks);
        setHistoryTick((v) => v + 1);
        workflowRef.current?.setAsrState({
          state: 'TRANSCRIPTION_COMPLETED',
          modelId: 'gemini-3.5-transcribe',
          modelVersion: 'cloud-2026',
          progressPct: 100,
          message: `رونویسی و هم‌ترازی آوایی تکمیل شد (${aggregatedTokens.length} واژه).`,
        });
        setAsrInlineFeedback({
          kind: 'SUCCESS',
          titleFa: 'تبدیل صوت به متن و هم‌ترازی آوایی با موفقیت انجام شد',
          messageFa: `${aggregatedTokens.length} واژه واقعی از گفتار توسط Gemini ASR استخراج و به مرزهای موج صوت هم‌تراز شد (${aggregatedRecs.length} پیشنهاد تدوین).`,
        });
        setStatusNotice(
          `تبدیل صوت به متن تکمیل شد: ${aggregatedTokens.length} واژه واقعی استخراج و با تایم‌لاین هم‌تراز شد.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        workflowRef.current?.setAsrState({
          state: 'INFERENCE_FAILED',
          modelId: 'gemini-3.5-transcribe',
          modelVersion: 'cloud-2026',
          message: `خطا در تبدیل صوت به متن: ${msg}`,
        });
        setAsrInlineFeedback({
          kind: 'INFERENCE_ERROR',
          titleFa: 'خطا در ارتباط با سرویس تبدیل صوت به متن',
          messageFa: `درخواست رونویسی انجام نشد (${msg}). می‌توانید دوباره تلاش کنید یا از «هم‌ترازی با متن دلخواه» استفاده نمایید.`,
        });
        setStatusNotice(`خطا در تبدیل صوت به متن: ${msg}`);
      } finally {
        setIsTranscribingAsr(false);
      }
    };

    const handleRunCloudGeminiAsr = async () => {
      if (executionMode !== 'CLOUD') {
        executionModeStoreRef.current.setPreferredMode('CLOUD', { explicitCloudOptIn: true });
        setExecutionMode('CLOUD');
      }
      await executeCloudGeminiAsr();
    };

    const handleRunPersianAsr = async () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      setAsrInlineFeedback({
        kind: 'READ_ONLY',
        titleFa: 'ویرایش غیرفعال است',
        messageFa: 'پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.',
      });
      return;
    }

    const resolved = await resolveTrackAssetAndPcm(tracks[0]);
    if (!resolved) {
      setStatusNotice('فایل صوتی قابل پردازش روی ترک اصلی یافت نشد.');
      setAsrInlineFeedback({
        kind: 'AUDIO_MISSING',
        titleFa: 'فایل صوتی یافت نشد',
        messageFa: 'برای اجرای تبدیل صوت به متن و هم‌ترازی آوایی، ابتدا یک فایل صوتی معتبر وارد کنید.',
      });
      return;
    }
    const { targetTrack, asset, pcm } = resolved;

    // Unified Processing Architecture: explicit LOCAL default vs explicit CLOUD opt-in; ZERO silent fallback
    if (executionMode === 'CLOUD') {
      if (!cloudAsrConfigured) {
        const err = classifyError(
          new Error('CLOUD_PROVIDER_UNAVAILABLE: No Cloud provider endpoint or credentials are configured.'),
          { subsystem: 'ASR_RUNTIME' },
        );
        getSharedDiagnosticLogger().log({
          severity: 'WARNING',
          subsystem: 'ASR_RUNTIME',
          code: err.code,
          message: 'Explicit Cloud execution requested while no Cloud provider is configured.',
        });
        setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
        setAsrInlineFeedback({
          kind: 'CLOUD_UNCONFIGURED',
          titleFa: 'حالت ابری پیکربندی نشده است',
          messageFa:
            'مسیر پردازش روی «ابری (اختیاری)» قرار دارد اما هیچ سرور ابری متصل نیست. برای حفظ شفافیت، بازگشت خودکار پنهان انجام نشد؛ می‌توانید حالت محلی را فعال کنید یا بخش‌بندی زمانی موج صوت را اجرا نمایید.',
        });
        setStatusNotice(
          'حالت ابری انتخاب شده است اما هیچ سرویس‌دهنده ابری پیکربندی نشده است؛ بازگشت خودکار پنهان به محلی انجام نشد.',
        );
        return;
      }
      await executeCloudGeminiAsr();
      return;
    }

    // Honest Local ASR readiness check (NEVER calls remote /api/v1/asr/transcribe silently in LOCAL mode)
    const activeModel = modelManagerRef.current.getSnapshot().activeModel;
    if (!activeModel) {
      workflowRef.current?.setAsrState({
        state: 'MODEL_NOT_INSTALLED',
        message:
          'مدل عصبی محلی (.onnx) نصب نشده است. برای تشخیص واقعی کلمات، از «Gemini ASR (حالت ابری)» استفاده کنید یا فایل وزن .onnx را نصب نمایید.',
      });
      const err = classifyError(new Error('ASR_MODEL_NOT_INSTALLED: Local ONNX weights are not installed.'), {
        subsystem: 'ASR_MODEL',
      });
      getSharedDiagnosticLogger().log({
        severity: 'INFO',
        subsystem: 'ASR_MODEL',
        code: err.code,
        message: 'Local ASR requested with no installed ONNX weights.',
      });
      setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
      setAsrInlineFeedback({
        kind: 'MODEL_NOT_INSTALLED',
        titleFa: 'مدل عصبی محلی (.onnx) نصب نشده است',
        messageFa: cloudAsrConfigured
          ? 'در حالت «محلی (LOCAL)»، به دلیل نبود فایل وزن .onnx و جلوگیری از ارسال پنهان صوت، رونویسی خودکار کلمات اجرا نشد. برای تشخیص واقعی واژگان فارسی می‌توانید با یک کلیک روی دکمه سبز «تشخیص واقعی کلمات با Gemini ASR» زیر کلیک کنید یا فایل .onnx خود را نصب نمایید.'
          : 'برای جلوگیری از تولید متن ساختگی، رونویسی خودکار واژگان بدون فایل وزن .onnx انجام نمی‌شود. هم‌اکنون می‌توانید متن را در «هم‌ترازی با متن دلخواه» وارد کنید، بخش‌بندی زمانی موج صوت را اجرا نمایید یا فایل .onnx خود را نصب کنید.',
      });
      setStatusNotice(
        'مدل عصبی محلی نصب نشده است — خروجی ساختگی تولید نمی‌شود و صوت در حالت محلی به‌صورت پنهان به سرور ارسال نشد.',
      );
      return;
    }

    setIsTranscribingAsr(true);
    setActiveFailure(null);
    workflowRef.current?.setAsrState({
      state: 'INFERENCE_RUNNING',
      modelId: activeModel.modelId,
      modelVersion: activeModel.version,
      progressPct: 35,
      message: `در حال بررسی اصالت مدل ${activeModel.modelId} و اجرای هم‌ترازی آوایی محلی...`,
    });

    try {
      const integrityCheck = await modelManagerRef.current.verifyInstalledActiveModelOffline();
      if (!integrityCheck.ok) {
        const integrityMsg =
          integrityCheck.error ?? 'اصالت فایل وزن محلی (.onnx) تأیید نشد؛ لطفاً فایل مدل را دوباره نصب کنید.';
        workflowRef.current?.setAsrState({
          state: 'INFERENCE_FAILED',
          modelId: activeModel.modelId,
          modelVersion: activeModel.version,
          message: integrityMsg,
        });
        setAsrInlineFeedback({
          kind: 'INFERENCE_ERROR',
          titleFa: 'اصالت فایل مدل محلی تأیید نشد',
          messageFa: integrityMsg,
        });
        setStatusNotice(`اجرای محلی متوقف شد: ${integrityMsg}`);
        return;
      }

      const beforeTokensSnapshot = cloneTokens(tokens);
      const beforeRecsSnapshot = cloneRecommendations(recommendations);
      const existingTrackText = tokens
        .filter((t) => t.trackId === targetTrack.id)
        .map((t) => t.originalText)
        .join(' ');

      let nextTrackTokens: PersianWordToken[];
      let nextTrackRecs: SmartRecommendation[];
      const usedExistingScript = existingTrackText.trim().length > 0;

      if (usedExistingScript) {
        const aligned = alignPersianScriptToAudio({
          pcm,
          sampleRate: project.sampleRate,
          trackId: targetTrack.id,
          speakerName: targetTrack.speakerLabel,
          rawTranscriptText: existingTrackText,
          acousticProfile: asset.acousticProfile,
          alignmentSource: 'AcousticSnap',
        });
        nextTrackTokens = aligned.tokens;
        nextTrackRecs = aligned.recommendations;
      } else {
        const segResult = buildHonestAcousticSpeechSegments({
          pcm,
          sampleRate: project.sampleRate,
          trackId: targetTrack.id,
          speakerName: targetTrack.speakerLabel,
          acousticProfile: asset.acousticProfile,
        });
        nextTrackTokens = segResult.tokens;
        nextTrackRecs = segResult.recommendations;
      }

      if (nextTrackTokens.length === 0) {
        workflowRef.current?.setAsrState({
          state: 'NO_SPEECH_DETECTED',
          modelId: activeModel.modelId,
          modelVersion: activeModel.version,
          progressPct: 100,
          message: 'گفتاری بالاتر از کف نویز اتاق در این فایل شناسایی نشد.',
        });
        setAsrInlineFeedback({
          kind: 'NO_SPEECH',
          titleFa: 'گفتاری شناسایی نشد',
          messageFa: 'بازه گفتاری فعالی بالاتر از کف نویز اتاق در این فایل صوتی یافت نشد.',
        });
        setStatusNotice('در پردازش محلی، گفتاری بالاتر از کف نویز شناسایی نشد.');
        return;
      }

      const otherTrackTokens = tokens.filter((t) => t.trackId !== targetTrack.id);
      const mergedTokens = [...otherTrackTokens, ...nextTrackTokens].sort(
        (a, b) => a.range.startFlicks - b.range.startFlicks,
      );
      const otherTrackRecs = recommendations.filter((r) => r.trackId !== targetTrack.id);
      const mergedRecs = [...otherTrackRecs, ...nextTrackRecs];

      const opLabel = usedExistingScript
        ? `هم‌ترازی آوایی محلی (${nextTrackTokens.length} واژه)`
        : `بخش‌بندی گفتاری آکوستیک محلی (${nextTrackTokens.length} بازه)`;

      historyRef.current.commitTransaction({
        coalescingKey: '',
        type: 'dsp-parameter-change',
        description: opLabel,
        beforeTracks: tracks,
        afterTracks: tracks,
        beforeTokens: beforeTokensSnapshot,
        afterTokens: mergedTokens,
        beforeRecommendations: beforeRecsSnapshot,
        afterRecommendations: mergedRecs,
      });

      setTokens(mergedTokens);
      syncWorkflowTranscript(mergedTokens, opLabel, { establishRawIfEmpty: true });
      setRecommendations(mergedRecs);
      setSelectedRecId(mergedRecs[0]?.id ?? null);
      persistDirtyCheckpointForCurrentState(tracks);
      setHistoryTick((v) => v + 1);
      workflowRef.current?.setAsrState({
        state: 'TRANSCRIPTION_COMPLETED',
        modelId: activeModel.modelId,
        modelVersion: activeModel.version,
        progressPct: 100,
        message: `${opLabel} با تأیید اصالت ${activeModel.modelId} تکمیل شد.`,
      });
      setAsrInlineFeedback({
        kind: 'SUCCESS',
        titleFa: usedExistingScript
          ? 'هم‌ترازی آوایی محلی تکمیل شد'
          : 'بخش‌بندی گفتاری آکوستیک محلی تکمیل شد',
        messageFa: usedExistingScript
          ? `${nextTrackTokens.length} واژه موجود روی مرزهای موج صوت هم‌تراز شد (${nextTrackRecs.length} پیشنهاد تدوین). توجه: فایل ${activeModel.modelId} بدون واژه‌نامه Tokenizer هم‌ترازی آوایی انجام داده است.`
          : `${nextTrackTokens.length} بازه گفتاری آکوستیک و ${nextTrackRecs.length} پیشنهاد تدوین استخراج شد. برای دیکود کامل واژگان بدون واژه‌نامه محلی، از «هم‌ترازی با متن دلخواه» یا «Gemini ASR» استفاده کنید.`,
      });
      setStatusNotice(
        `${opLabel} تکمیل شد (${nextTrackRecs.length} پیشنهاد تدوین).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      workflowRef.current?.setAsrState({
        state: 'INFERENCE_FAILED',
        modelId: activeModel.modelId,
        modelVersion: activeModel.version,
        message: `خطا در پردازش محلی: ${msg}`,
      });
      setAsrInlineFeedback({
        kind: 'INFERENCE_ERROR',
        titleFa: 'خطا در پردازش آوایی محلی',
        messageFa: `اجرای پردازش محلی با خطا متوقف شد (${msg}).`,
      });
      setStatusNotice(`خطا در پردازش محلی: ${msg}`);
    } finally {
      setIsTranscribingAsr(false);
    }
  };

  const handleRestoreProsodicPunctuation = async () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (tokens.length === 0) return;
    const resolved = await resolveTrackAssetAndPcm(tracks[0]);
    if (!resolved) return;
    const { pcm } = resolved;

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
    syncWorkflowTranscript(nextTokens, 'بازسازی علائم نگارشی فارسی از روی آهنگ صدا');
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      'علائم نگارشی فارسی (، . ؟) بر اساس مکث‌ها و شیب فرکانس پایه (F0) در لایه نمایشی بازسازی شد.',
    );
  };

  const handleConvertColloquialToFormal = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
    syncWorkflowTranscript(nextTokens, `تبدیل ${convertedCount} واژه محاوره‌ای به معیار`);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `${convertedCount} واژه/فعل محاوره‌ای در لایه نمایشی به فارسی معیار تبدیل شد (با حفظ متن خام ASR و زمان‌بندی).`,
    );
  };

  const handleNormalizeNumbersAndCompounds = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
    syncWorkflowTranscript(nextTokens, `اصلاح اعداد و نیم‌فاصله ترکیبات (${updatedCount} مورد)`);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `اصلاح اعداد، مبالغ و ترکیبات دووجهی/نیم‌فاصله روی ${updatedCount} بخش انجام شد.`,
    );
  };

  const handleRedactSelectedWords = (
    selectedTokenIds: string[],
    maskMode: AudioRedactionMaskMode,
  ): boolean => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return false;
    }
    if (selectedTokenIds.length === 0) return false;
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTokensSnapshot = cloneTokens(tokens);
    const beforePcmSourcesSnapshot = { ...project.pcmSources };
    const beforeAssetsSnapshot = { ...project.assets };
    const updatedPcmSources = { ...project.pcmSources };
    const updatedAssets = { ...project.assets };
    let currentTokens = cloneTokens(tokens);
    let totalRedacted = 0;

    for (const trk of tracks) {
      const trkTokenIds = selectedTokenIds.filter((id) =>
        currentTokens.some((tok) => tok.id === id && tok.trackId === trk.id),
      );
      if (trkTokenIds.length === 0) continue;
      const assetId = getTrackPrimaryAssetId(trk);
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

    if (totalRedacted === 0) return false;

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
      beforePcmSources: beforePcmSourcesSnapshot,
      afterPcmSources: updatedPcmSources,
      beforeAssets: beforeAssetsSnapshot,
      afterAssets: updatedAssets,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setTokens(currentTokens);
    syncWorkflowTranscript(currentTokens, `پوشش صوتی امنیتی روی ${totalRedacted} واژه`);
    persistDirtyCheckpointForCurrentState(tracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `پوشش صوتی (${
        maskMode === 'BROADCAST_BLEEP_1KHZ'
          ? 'بوق استاندارد پخش ۱kHz'
          : 'فیلتر مات‌سازی صدا (210Hz Low-Pass)'
      }) با شیب ۱۵ms روی ${totalRedacted} واژه اعمال شد.`,
    );
    return true;
  };

  const handleApplySpectralWienerDenoise = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforePcmSourcesSnapshot = { ...project.pcmSources };
    const beforeAssetsSnapshot = { ...project.assets };
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

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `حذف نویز طیفی تطبیقی Wiener (-${meanSnrGain} dB)`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
      beforePcmSources: beforePcmSourcesSnapshot,
      afterPcmSources: updatedPcmSources,
      beforeAssets: beforeAssetsSnapshot,
      afterAssets: updatedAssets,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    persistDirtyCheckpointForCurrentState(tracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `حذف نویز طیفی تطبیقی (Decision-Directed Wiener Denoiser) روی تمام ترک‌ها اعمال شد (کاهش کف نویز: -${meanSnrGain} dB).`,
    );
  };

  const prosodyAndChaptersReport = useMemo(() => {
    const primaryTrack = tracks[0];
    const primaryAssetId = getTrackPrimaryAssetId(primaryTrack, project.pcmSources);
    const pcm = primaryAssetId ? project.pcmSources[primaryAssetId] : undefined;
    if (!pcm || tokens.length === 0) return null;
    return analyzeTranscriptProsodyAndChapters({
      tokens,
      pcm,
      sampleRate: project.sampleRate,
    });
  }, [tokens, tracks, project.pcmSources, project.sampleRate]);

  const handleApplyCustomLexicon = (customVocabularyCsv: string) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
    syncWorkflowTranscript(nextTokens, `اصلاح هم‌آواها با واژه‌نامه اختصاصی (${correctedCount} واژه)`);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `واژه‌نامه اختصاصی اعمال شد: ${correctedCount} واژه هم‌آوا/تخصصی به املای استاندارد اصلاح گردید.`,
    );
  };

  const handleOptimizeTrilingualAsr = async (nextMode: EnglishScriptRenderMode) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (tokens.length === 0) return;
    const resolved = await resolveTrackAssetAndPcm(tracks[0]);
    if (!resolved) return;
    const { pcm } = resolved;

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
    syncWorkflowTranscript(report.tokens, `بهینه‌سازی سه‌زبانه ASR (${nextMode})`);
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
  ): boolean => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return false;
    }
    if (selectedTokenIds.length === 0) return false;
    const firstTok = tokens.find((t) => selectedTokenIds.includes(t.id));
    if (!firstTok) return false;
    const targetTrack = tracks.find((t) => t.id === firstTok.trackId);
    const assetId = getTrackPrimaryAssetId(targetTrack);
    const pcm = assetId ? project.pcmSources[assetId] : undefined;
    const asset = assetId ? project.assets[assetId] : undefined;
    if (!targetTrack || !assetId || !pcm || !asset) return false;

    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTracksSnapshot = cloneTracks(tracks);
    const beforeTokensSnapshot = cloneTokens(tokens);
    const beforePcmSourcesSnapshot = { ...project.pcmSources };
    const beforeAssetsSnapshot = { ...project.assets };

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
        exactSampleCount: stretched.stretchedPcm.length,
        durationFlicks: secondsToFlicks(stretched.stretchedPcm.length / project.sampleRate),
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
      beforePcmSources: beforePcmSourcesSnapshot,
      afterPcmSources: updatedPcmSources,
      beforeAssets: beforeAssetsSnapshot,
      afterAssets: updatedAssets,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setTracks(stretched.updatedTracks);
    setTokens(stretched.updatedTokens);
    syncWorkflowTranscript(
      stretched.updatedTokens,
      `کشش زمانی WSOLA (${tempoRatio}x)`,
      { targetTracks: stretched.updatedTracks },
    );
    persistDirtyCheckpointForCurrentState(stretched.updatedTracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `کشش/فشرده‌سازی زمانی بدون تغییر زیر و بمی صدا (WSOLA ${tempoRatio}x) روی واژگان انتخاب‌شده اعمال شد (تغییر زمان: ${
        stretched.deltaDurationSec >= 0 ? '+' : ''
      }${stretched.deltaDurationSec}s).`,
    );
    return true;
  };

  const acousticAdvisor = useMemo(() => {
    const primaryTrack = tracks[0];
    const primaryAssetId = getTrackPrimaryAssetId(primaryTrack, project.pcmSources);
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
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (!acousticAdvisor) return;
    const beforeDspSnapshot = { ...committedDsp };
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
      beforeDsp: beforeDspSnapshot,
      afterDsp: { ...nextDsp },
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
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforePcmSourcesSnapshot = { ...project.pcmSources };
    const beforeAssetsSnapshot = { ...project.assets };
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

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: 'اکوالایزر پارامتریک ۸ بانده ویژه کلام فارسی',
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
      beforePcmSources: beforePcmSourcesSnapshot,
      afterPcmSources: updatedPcmSources,
      beforeAssets: beforeAssetsSnapshot,
      afterAssets: updatedAssets,
      beforeEqResponseCurveDb: eqResponseCurveDb,
      afterEqResponseCurveDb: latestCurve,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setEqResponseCurveDb(latestCurve);
    persistDirtyCheckpointForCurrentState(tracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      'اکوالایزر پارامتریک ۸ بانده ویژه کلام فارسی (حذف هام ۵۰Hz، شفافیت همخوان ۳.۲kHz و مهار صفیر ۶.۵kHz) اعمال شد.',
    );
  };

  const handlePunchInSpectralMatchSelectedWords = (selectedTokenIds: string[]): boolean => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return false;
    }
    if (selectedTokenIds.length === 0) return false;
    const firstTok = tokens.find((t) => selectedTokenIds.includes(t.id));
    if (!firstTok) return false;
    const targetTrack = tracks.find((t) => t.id === firstTok.trackId);
    const assetId = getTrackPrimaryAssetId(targetTrack);
    const pcm = assetId ? project.pcmSources[assetId] : undefined;
    const asset = assetId ? project.assets[assetId] : undefined;
    if (!targetTrack || !assetId || !pcm || !asset) return false;

    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTokensSnapshot = cloneTokens(tokens);
    const beforePcmSourcesSnapshot = { ...project.pcmSources };
    const beforeAssetsSnapshot = { ...project.assets };
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
      beforePcmSources: beforePcmSourcesSnapshot,
      afterPcmSources: updatedPcmSources,
      beforeAssets: beforeAssetsSnapshot,
      afterAssets: updatedAssets,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    setTokens(res.updatedTokens);
    syncWorkflowTranscript(res.updatedTokens, `تطبیق طیفی ۴ بانده روی ${selectedTokenIds.length} واژه`);
    persistDirtyCheckpointForCurrentState(tracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `تطبیق طیفی ۴ بانده (4-Band Spectral EQ Match) با رنگ صدای استودیو و درج واترمارک اصالت ۱۹kHz BPSK روی ${selectedTokenIds.length} واژه انجام شد (تأیید واترمارک: ${
        res.isWatermarked ? 'معتبر ✓' : 'نامشخص'
      }).`,
    );
    return true;
  };

  const handleSoftenBreathsAndCoughs = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforePcmSourcesSnapshot = { ...project.pcmSources };
    const beforeAssetsSnapshot = { ...project.assets };
    const updatedPcmSources = { ...project.pcmSources };
    const updatedAssets = { ...project.assets };
    let totalBreaths = 0;
    let totalCoughs = 0;
    let processedCount = 0;

    for (const trk of tracks) {
      const assetId = getTrackPrimaryAssetId(trk);
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
      processedCount++;
    }

    if (processedCount === 0) return;

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: `کنترل تنفس و سرفه (${totalBreaths} نفس · ${totalCoughs} سرفه)`,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
      beforePcmSources: beforePcmSourcesSnapshot,
      afterPcmSources: updatedPcmSources,
      beforeAssets: beforeAssetsSnapshot,
      afterAssets: updatedAssets,
    });

    setProject((prev) => ({
      ...prev,
      pcmSources: updatedPcmSources,
      assets: updatedAssets,
    }));
    persistDirtyCheckpointForCurrentState(tracks);
    setHistoryTick((v) => v + 1);
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
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
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
    syncWorkflowTranscript(
      batchResult.tokens,
      `پاک‌سازی هوشمند دسته‌ای (${batchResult.appliedCount} مورد)`,
      { targetTracks: batchResult.tracks },
    );
    setRecommendations(batchResult.recommendations);
    persistDirtyCheckpointForCurrentState(batchResult.tracks);
    clampPlaybackAndSelectionToTracks(batchResult.tracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `پاک‌سازی دسته‌ای انجام شد: ${batchResult.appliedCount} مورد (${batchResult.rippleCutCount} برش زمانی و ${batchResult.roomToneCount} جایگزینی Room Tone) در یک تراکنش واحد اعمال شد.`,
    );
  };

  const handleRescanDeepDisfluencies = () => {
    let updatedRecs = cloneRecommendations(recommendations);
    let addedTotal = 0;

    for (const trk of tracks) {
      const assetId = getTrackPrimaryAssetId(trk);
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
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
    setProjectSessionNonce((n) => n + 1);
    setTracks(cloneTracks(recordedProject.tracks));
    setTokens(cloneTokens(recordedProject.tokens));
    setRecommendations(cloneRecommendations(recordedProject.recommendations));
    setSelectedRecId(recordedProject.recommendations[0]?.id ?? null);
    setSelection(null);
    setPlayheadSec(0);
    setAsrInlineFeedback(null);
    setActiveFailure(null);
    setEphemeralDsp(DEFAULT_DSP_PARAMS);
    setCommittedDsp(DEFAULT_DSP_PARAMS);
    setEqResponseCurveDb(null);
    setDetectedSyncOffsetMs(0);
    setDetectedClockDriftPpm(0);
    historyRef.current = new TimelineHistoryManager();
    setHistoryTick((v) => v + 1);
    setStatusNotice(
      `برداشت صوتی استودیو ضبط و هم‌ترازی آوایی شد: ${recordedProject.tokens.length} واژه فارسی و ${recordedProject.recommendations.length} پیشنهاد تپق/مکث استخراج گردید.`,
    );
  };

  const handleRejectRecommendation = (id: string) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    setRecommendations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: 'Rejected' } : r)),
    );
  };

  const handleNudgeBoundary = (id: string, deltaMs: number) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
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
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    const tx = historyRef.current.undo();
    if (!tx) return;
    transportRef.current?.stop();
    setIsPlaying(false);
    const restoredTracks = cloneTracks(tx.beforeTracks);
    setTracks(restoredTracks);
    if (tx.beforeTokens) {
      const restoredTokens = cloneTokens(tx.beforeTokens);
      setTokens(restoredTokens);
      syncWorkflowTranscript(restoredTokens, `Undo: ${tx.description}`, {
        targetTracks: restoredTracks,
      });
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
    if (tx.beforeDsp) {
      setEphemeralDsp({ ...tx.beforeDsp });
      setCommittedDsp({ ...tx.beforeDsp });
      setIsGestureActive(false);
    }
    if (tx.beforePcmSources || tx.beforeAssets) {
      setProject((prev) => ({
        ...prev,
        pcmSources: tx.beforePcmSources ? { ...tx.beforePcmSources } : prev.pcmSources,
        assets: tx.beforeAssets ? { ...tx.beforeAssets } : prev.assets,
      }));
    }
    if (tx.beforeEqResponseCurveDb !== undefined) {
      setEqResponseCurveDb(tx.beforeEqResponseCurveDb);
    }
    persistDirtyCheckpointForCurrentState(restoredTracks);
    clampPlaybackAndSelectionToTracks(restoredTracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(`تراکنش «${tx.description}» بازگردانی شد (Undo).`);
  };

  const handleRedo = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    const tx = historyRef.current.redo();
    if (!tx) return;
    transportRef.current?.stop();
    setIsPlaying(false);
    const restoredTracks = cloneTracks(tx.afterTracks);
    setTracks(restoredTracks);
    if (tx.afterTokens) {
      const restoredTokens = cloneTokens(tx.afterTokens);
      setTokens(restoredTokens);
      syncWorkflowTranscript(restoredTokens, `Redo: ${tx.description}`, {
        targetTracks: restoredTracks,
      });
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
    if (tx.afterDsp) {
      setEphemeralDsp({ ...tx.afterDsp });
      setCommittedDsp({ ...tx.afterDsp });
      setIsGestureActive(false);
    }
    if (tx.afterPcmSources || tx.afterAssets) {
      setProject((prev) => ({
        ...prev,
        pcmSources: tx.afterPcmSources ? { ...tx.afterPcmSources } : prev.pcmSources,
        assets: tx.afterAssets ? { ...tx.afterAssets } : prev.assets,
      }));
    }
    if (tx.afterEqResponseCurveDb !== undefined) {
      setEqResponseCurveDb(tx.afterEqResponseCurveDb);
    }
    persistDirtyCheckpointForCurrentState(restoredTracks);
    clampPlaybackAndSelectionToTracks(restoredTracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(`تراکنش «${tx.description}» دوباره اعمال شد (Redo).`);
  };

  const handleEphemeralDspChange = (next: EphemeralDspParams) => {
    setIsGestureActive(true);
    setEphemeralDsp(next);
  };

  const handleCommitDspGesture = (coalescingKey: string, labelFa: string) => {
    setIsGestureActive(false);
    if (isReadOnlyLocked) {
      setEphemeralDsp(committedDsp);
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (JSON.stringify(ephemeralDsp) === JSON.stringify(committedDsp)) return;
    const beforeDspSnapshot = { ...committedDsp };
    const afterDspSnapshot = { ...ephemeralDsp };
    setCommittedDsp(afterDspSnapshot);
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
      beforeDsp: beforeDspSnapshot,
      afterDsp: afterDspSnapshot,
    });
    setHistoryTick((v) => v + 1);
    resyncActivePlayback({ dspParams: afterDspSnapshot });
  };

  const handleResetDsp = () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (JSON.stringify(committedDsp) === JSON.stringify(DEFAULT_DSP_PARAMS)) {
      setEphemeralDsp(DEFAULT_DSP_PARAMS);
      setIsGestureActive(false);
      return;
    }
    const beforeDspSnapshot = { ...committedDsp };
    const nextDsp = { ...DEFAULT_DSP_PARAMS };
    setEphemeralDsp(nextDsp);
    setCommittedDsp(nextDsp);
    setIsGestureActive(false);
    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: 'بازنشانی تنظیمات DSP به مقادیر پیش‌فرض',
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: tokens,
      afterTokens: tokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
      beforeDsp: beforeDspSnapshot,
      afterDsp: nextDsp,
    });
    setHistoryTick((v) => v + 1);
    resyncActivePlayback({ dspParams: nextDsp });
    setStatusNotice('تنظیمات DSP به مقادیر پیش‌فرض بازنشانی شد (قابل بازگردانی با Undo).');
  };

  const handleToggleTrackMute = (trackId: string) => {
    const nextTracks = tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t));
    setTracks(nextTracks);
    resyncActivePlayback({ tracks: nextTracks });
  };

  const handleToggleTrackSolo = (trackId: string) => {
    const nextTracks = tracks.map((t) => (t.id === trackId ? { ...t, solo: !t.solo } : t));
    setTracks(nextTracks);
    resyncActivePlayback({ tracks: nextTracks });
  };

  const applySyncedTrackTimelineShiftMs = (shiftMs: number, descriptionFa: string): boolean => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return false;
    }
    const hasSyncedPeerTrack = tracks.some((t, idx) => idx > 0 && Boolean(t.syncGroupId));
    if (!hasSyncedPeerTrack) {
      setStatusNotice('در پروژه تک‌ترک، ترک همگام دومی برای جابجایی زمانی وجود ندارد.');
      return false;
    }
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
    persistDirtyCheckpointForCurrentState(nextTracks);
    clampPlaybackAndSelectionToTracks(nextTracks);
    setHistoryTick((v) => v + 1);
    return true;
  };

  const handleAutoAlignSyncedTracks = () => {
    const offsetToCorrect = -detectedSyncOffsetMs;
    const applied = applySyncedTrackTimelineShiftMs(
      offsetToCorrect,
      `هم‌ترازسازی خودکار ترک‌های همگام (${detectedSyncOffsetMs.toFixed(1)}ms و جبران دریفت ${detectedClockDriftPpm.toFixed(1)}ppm)`,
    );
    if (!applied) return;
    setDetectedSyncOffsetMs(0);
    setDetectedClockDriftPpm(0);
    setStatusNotice(
      'انحراف زمانی و دریفت کلاک ترک‌های همگام به‌صورت غیرمخرب اصلاح و هم‌تراز شد (0.0 ms).',
    );
  };

  const handleNudgeSyncedTracksMs = (deltaMs: number) => {
    const applied = applySyncedTrackTimelineShiftMs(
      deltaMs,
      `جابجایی دستی زمان‌بندی ترک همگام (${deltaMs > 0 ? '+' : ''}${deltaMs}ms)`,
    );
    if (!applied) return;
    setDetectedSyncOffsetMs((prev) => Number((prev + deltaMs).toFixed(1)));
    setStatusNotice(
      `زمان‌بندی ترک همگام به میزان ${deltaMs > 0 ? '+' : ''}${deltaMs} میلی‌ثانیه جابجا شد (Nudge).`,
    );
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const MAX_BROWSER_UPLOAD_BYTES = 256 * 1024 * 1024;
    const lowerName = file.name.toLowerCase();
    const allowedExt = /\.(wav|wave|mp3|ogg|m4a|webm|flac|aac)$/i;

    if (file.size === 0) {
      const err = classifyError(new Error('AUDIO_DECODE_FAILED: File is empty (0 bytes).'), {
        subsystem: 'AUDIO_IMPORT',
      });
      setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
      setStatusNotice('خطا: فایل انتخاب‌شده خالی (۰ بایت) است. جلسه فعلی دست‌نخورده باقی ماند.');
      return;
    }

    if (file.size > MAX_BROWSER_UPLOAD_BYTES) {
      const err = classifyError(
        new Error(`MEMORY_LIMIT_EXCEEDED: File exceeds 256 MiB browser ingest limit (${file.size} B).`),
        { subsystem: 'AUDIO_IMPORT' },
      );
      setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
      setStatusNotice('خطا: حجم فایل از سقف ایمن ورود در مرورگر بیشتر است. جلسه فعلی حفظ شد.');
      return;
    }

    if (!allowedExt.test(lowerName) && !file.type.startsWith('audio/')) {
      const err = classifyError(
        new Error(`UNSUPPORTED_AUDIO_FORMAT: Unsupported file type "${file.name}".`),
        { subsystem: 'AUDIO_IMPORT' },
      );
      setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
      setStatusNotice('خطا: فرمت فایل پشتیبانی نمی‌شود. فقط فایل‌های صوتی معتبر (WAV/MP3/OGG/FLAC/M4A/WebM) مجاز هستند.');
      return;
    }

    transportRef.current?.stop();
    setIsPlaying(false);
    setActiveFailure(null);
    setStatusNotice(`در حال Ingest جریانی و تحلیل آوایی فارسی روی «${file.name}»...`);
    try {
      const loaded = await ingestUploadedAudioFile(file);
      historyRef.current = new TimelineHistoryManager();
      setProject(loaded);
      setProjectSessionNonce((n) => n + 1);
      setTracks(cloneTracks(loaded.tracks));
      setTokens(cloneTokens(loaded.tokens));
      setRecommendations(cloneRecommendations(loaded.recommendations));
      setSelectedRecId(loaded.recommendations[0]?.id ?? null);
      setSelection(null);
      setPlayheadSec(0);
      setAsrInlineFeedback(null);
      setEphemeralDsp(DEFAULT_DSP_PARAMS);
      setCommittedDsp(DEFAULT_DSP_PARAMS);
      setEqResponseCurveDb(null);
      setDetectedSyncOffsetMs(0);
      setDetectedClockDriftPpm(0);
      setHistoryTick((v) => v + 1);
      setStatusNotice(
        `فایل «${file.name}» وارد شد (${loaded.tokens.length} بخش آوایی و ${loaded.recommendations.length} پیشنهاد تدوین شناسایی شد).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const classified = classifyError(err, {
        subsystem: 'AUDIO_DECODE',
      });
      getSharedDiagnosticLogger().log({
        severity: 'WARNING',
        subsystem: 'AUDIO_DECODE',
        code: classified.code,
        message: 'Uploaded audio failed validation/decode; previous session preserved.',
      });
      setActiveFailure(buildUserFacingFailure(classified, workflowState.locale));
      if (msg.startsWith('SECURITY_')) {
        setStatusNotice(msg.replace(/^SECURITY_[A-Z_]+:\s*/, 'سپر امنیتی: '));
      } else {
        AudioSecurityGuard.sanitizeErrorForTelemetry(msg);
        setStatusNotice('خطا در دیکد فایل صوتی؛ فایل نامعتبر یا خراب است و پروژه فعلی دست‌نخورده باقی ماند.');
      }
    }
  };

  const handleResetDemoProject = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    const fresh = buildDefaultPersianPodcastProject();
    historyRef.current = new TimelineHistoryManager();
    setProject(fresh);
    setProjectSessionNonce((n) => n + 1);
    setTracks(cloneTracks(fresh.tracks));
    setTokens(cloneTokens(fresh.tokens));
    setRecommendations(cloneRecommendations(fresh.recommendations));
    setSelectedRecId(fresh.recommendations[0]?.id ?? null);
    setSelection(null);
    setPlayheadSec(0);
    setAsrInlineFeedback(null);
    setActiveFailure(null);
    setEphemeralDsp(DEFAULT_DSP_PARAMS);
    setCommittedDsp(DEFAULT_DSP_PARAMS);
    setEqResponseCurveDb(null);
    setDetectedSyncOffsetMs(38.5);
    setDetectedClockDriftPpm(14.2);
    setHistoryTick((v) => v + 1);
    setStatusNotice('پروژه نمونه پادکست فارسی بازیابی شد.');
  };

  const handleRunBrokerConcurrencyTest = async () => {
    if (!brokerRef.current) return;
    try {
      const primaryId = Object.keys(project.assets)[0] ?? 'asset-host';
      const nextTel = await brokerRef.current.simulateConcurrentLockBrokerTest(primaryId);
      setTelemetry(nextTel);
      setStatusNotice(
        `آزمون هم‌زمانی ۲ Worker با موفقیت انجام شد (تداخل قفل پیش‌گیری‌شده: ${nextTel.lockConflictsPrevented}).`,
      );
    } catch (err) {
      setStatusNotice(
        `خطا در آزمون هم‌زمانی کارگزار ذخیره‌سازی: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    const nextNodes = graphNodes.map((n) =>
      n.id === nodeId ? { ...n, bypassed: !n.bypassed } : n,
    );
    setGraphNodes(nextNodes);
    resyncActivePlayback({ dspBypassFlags: deriveDspBypassFlags(nextNodes) });
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

  // Mission 04/05/06/07 StudioWorkflowController handlers
  const handleRunMissionEdlAnalysis = async () => {
    const resolved = await resolveTrackAssetAndPcm(tracks[0]);
    if (!resolved) {
      setStatusNotice('بافر صوتی برای تحلیل رویدادها و EDL در دسترس نیست.');
      return;
    }
    const { targetTrack: primaryTrack, pcm } = resolved;

    const res = await workflowRef.current!.analyzeSpeechEventsAndBuildEdl({
      trackId: primaryTrack.id,
      pcmMono: pcm,
      sampleRate: (project.sampleRate as SampleRate) || 48000,
      wordTokens: tokens,
    });
    if (res.ok && res.edl) {
      setStatusNotice(
        `تحلیل محلی رویدادها و EDL کامل شد: ${res.eventResult?.events.length ?? 0} رویداد و ${res.edl.proposals.length} پیشنهاد تدوین (هیچ برشی بدون تأیید اعمال نمی‌شود).`,
      );
    } else if (!res.ok) {
      setStatusNotice('تحلیل رویدادها و EDL ناموفق بود یا به‌دلیل تغییر جلسه لغو شد.');
    }
  };

  const handlePreviewEdlProposal = (proposal: EditProposal, mode: 'before' | 'after') => {
    const activeRange = proposal.proposedRange ?? proposal.originalRange;
    const startSec = (activeRange?.startSample ?? 0) / project.sampleRate;
    const endSec = (activeRange?.endSample ?? 0) / project.sampleRate;
    const targetTrackId = tracks[0]?.id ?? 'track-host';
    const fakeRec: SmartRecommendation = {
      id: proposal.proposalId,
      trackId: targetTrackId,
      kind: 'long-pause',
      recommendedMode: 'sync-locked-ripple-cut',
      range: { startFlicks: secondsToFlicks(startSec), endFlicks: secondsToFlicks(endSec) },
      relatedText: proposal.operation,
      reasonFa: proposal.explanationFa,
      confidence: 0.9,
      sourceTier: 'Group-A-DSP',
      status: 'Pending',
      boundary: {
        rawRange: { startFlicks: secondsToFlicks(startSec), endFlicks: secondsToFlicks(endSec) },
        snappedRange: { startFlicks: secondsToFlicks(startSec), endFlicks: secondsToFlicks(endSec) },
        rmsValleyShiftMs: 0,
        zeroCrossingAdjusted: true,
        microCrossfadeMs: 10,
        pitchPlateauDetected: false,
        trailingEzafeRisk: false,
        reasonFa: proposal.explanationFa,
      },
    };
    handlePreviewRecommendation(fakeRec, mode);
  };

  const handleStartMission06Render = async (
    config: AudioRenderConfig,
    resumeFromCheckpoint: boolean,
  ) => {
    const resolved = await resolveTrackAssetAndPcm(tracks[0]);
    if (!resolved) {
      setStatusNotice('بافر صوتی برای رندر و خروجی نهایی در دسترس نیست.');
      return;
    }
    const { pcm } = resolved;

    await workflowRef.current!.startRender({
      pcmChannels: [pcm],
      config,
      resumeCheckpoint: resumeFromCheckpoint ? workflowState.recoverableCheckpoint : null,
    });
  };

  const handleToggleLoopSelection = () => {
    const nextLoop = !loopSelection;
    setLoopSelection(nextLoop);
    resyncActivePlayback({ loop: nextLoop });
  };

  const handleChangePlaybackRate = (nextRate: number) => {
    setPlaybackRate(nextRate);
    resyncActivePlayback({ playbackRate: nextRate });
  };

  // Audition DAW Keyboard Shortcuts — single stable window listener (no re-registration per render)
  keydownHandlerRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (e.target as HTMLElement | null)?.isContentEditable
    ) {
      return;
    }

    const hasOpenModal =
      renderModalOpen ||
      lifecycleModalOpen ||
      asrLabOpen ||
      devPortalOpen ||
      speechIntelOpen ||
      dataFactoryOpen ||
      modelFactoryOpen ||
      securityOpen;
    if (hasOpenModal) {
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (lower === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }
      if ((lower === 'z' && e.shiftKey) || lower === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      return;
    }

    if (e.altKey) return;

    if (e.code === 'Space') {
      e.preventDefault();
      handleTogglePlay();
    } else if (e.key === 'Home') {
      e.preventDefault();
      handleStopAndReset();
    } else if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      handleSetInAtPlayhead();
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      handleSetOutAtPlayhead();
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      handleToggleLoopSelection();
    } else if (e.key === 'Escape') {
      setSelection(null);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keydownHandlerRef.current(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      dir={workflowState.locale === 'fa' ? 'rtl' : 'ltr'}
      className="min-h-screen flex flex-col bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 overflow-x-hidden"
    >
      <HeaderNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenExport={() => setRenderModalOpen(true)}
        locale={workflowState.locale}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-3 sm:px-6 pt-4 pb-28 space-y-4">
        {/* Local-First Lifecycle, Execution Mode (LOCAL default / CLOUD opt-in), Theme/Locale & Reliability Failure Banner */}
        <WorkflowStageBar
          workflowState={workflowState}
          executionMode={executionMode}
          cloudProviderStatusLabel={
            cloudAsrConfigured
              ? workflowState.locale === 'fa'
                ? 'ابری آماده (Gemini ASR)'
                : 'Cloud Ready (Gemini ASR)'
              : workflowState.locale === 'fa'
                ? 'ابری پیکربندی نشده (بدون بازگشت پنهان)'
                : 'Cloud Unconfigured (No Silent Fallback)'
          }
          onChangeExecutionMode={handleChangeExecutionMode}
          cloudAsrConfigured={cloudAsrConfigured}
          onRunCloudGeminiAsr={handleRunCloudGeminiAsr}
          activeFailure={activeFailure}
          canInstallPwa={false}
          onTriggerInstallPwa={() => {}}
          onDismissFailure={() => setActiveFailure(null)}
          onRecoverFailure={() => {
            setLifecycleInitialTab('model');
            setLifecycleModalOpen(true);
          }}
          onImportAudioClick={() => fileInputRef.current?.click()}
          onOpenLifecycleModal={(tab) => {
            setLifecycleInitialTab(tab ?? 'health');
            setLifecycleModalOpen(true);
          }}
          onToggleTheme={() =>
            workflowRef.current?.setTheme(workflowState.theme === 'dark' ? 'light' : 'dark')
          }
          onToggleLocale={(next: WorkflowLocale) => workflowRef.current?.setLocale(next)}
          advancedLabs={{
            onOpenAsrLab: () => setAsrLabOpen(true),
            onOpenDevPortal: () => setDevPortalOpen(true),
            onOpenSpeechIntel: () => setSpeechIntelOpen(true),
            onOpenDataFactory: () => setDataFactoryOpen(true),
            onOpenModelFactory: () => setModelFactoryOpen(true),
            onOpenSpeechSecurity: () => setSecurityOpen(true),
          }}
        />

        {/* Project & Transport Toolbar */}
        <section
          dir="rtl"
          aria-label="نوار کنترل پروژه و پخش"
          className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-4"
        >
          <div className="min-w-0">
            <h1 className="text-base font-bold text-slate-900 dark:text-slate-100 truncate" data-testid="project-title">
              {project.projectName}
            </h1>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap items-center gap-2 font-mono">
              <span dir="ltr">{project.sampleRate} Hz</span>
              <span aria-hidden="true">·</span>
              <span className="font-sans">{tracks.length} ترک فعال</span>
              <span aria-hidden="true">·</span>
              <span>پردازش محلی ({capabilities.transportMode})</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Transport Buttons */}
            <button
              type="button"
              data-testid="toolbar-btn-play-pause"
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
              className="p-2 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <div
              dir="ltr"
              className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0B0F17] font-mono tabular-nums text-xs text-amber-700 dark:text-amber-400"
              aria-label="زمان‌سنج پخش"
            >
              {formatTimecode(secondsToFlicks(playheadSec))} / {formatTimecode(totalDurationFlicks)}
            </div>

            <div className="h-5 w-px bg-slate-300 dark:bg-[#252F42] mx-1 hidden sm:block" aria-hidden="true" />

            <button
              type="button"
              data-testid="btn-timeline-undo"
              onClick={handleUndo}
              disabled={!historyRef.current.canUndo()}
              aria-label="بازگشت (Undo)"
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>بازگشت</span>
            </button>

            <button
              type="button"
              data-testid="btn-timeline-redo"
              onClick={handleRedo}
              disabled={!historyRef.current.canRedo()}
              aria-label="تکرار (Redo)"
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>تکرار</span>
            </button>

            <input
              ref={fileInputRef}
              data-testid="audio-file-input"
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="hidden"
              aria-label="انتخاب فایل صوتی"
            />
            <button
              type="button"
              data-testid="btn-upload-audio"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              <span>ورود فایل صوتی</span>
            </button>

            <button
              type="button"
              data-testid="btn-record-studio-mic"
              onClick={handleRecordStudioMicTake}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-200 hover:bg-rose-500/20 cursor-pointer"
            >
              <Mic className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400" aria-hidden="true" />
              <span>ضبط برداشت صوتی</span>
            </button>

            <button
              type="button"
              data-testid="btn-spectral-wiener-denoise"
              onClick={handleApplySpectralWienerDenoise}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-cyan-500/40 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200 hover:bg-cyan-500/20 cursor-pointer"
            >
              <Waves className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-300" aria-hidden="true" />
              <span>حذف نویز طیفی</span>
            </button>

            <button
              type="button"
              data-testid="btn-reset-demo"
              onClick={handleResetDemoProject}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" aria-hidden="true" />
              <span>نمونه پادکست</span>
            </button>
          </div>
        </section>

        {statusNotice && (
          <div
            role="status"
            dir="rtl"
            data-testid="studio-status-notice"
            className="px-4 py-2.5 rounded-md border border-sky-500/30 bg-sky-500/10 text-xs text-sky-900 dark:text-sky-200 flex items-center justify-between gap-3"
          >
            <span>{statusNotice}</span>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="text-sky-700 dark:text-sky-300 hover:text-slate-950 dark:hover:text-white cursor-pointer shrink-0"
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
                  onSelectionChange={(nextSel) => setSelection(clampSelectionRange(nextSel))}
                  onPlaySelectionRange={(sel) => handlePlaySelectionRange(clampSelectionRange(sel))}
                />

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                  <div className="lg:col-span-7 space-y-4 min-w-0">
                    <TranscriptPanel
                      tokens={tokens}
                      tracks={tracks}
                      pcmSources={project.pcmSources}
                      sampleRate={project.sampleRate}
                      playheadSec={playheadSec}
                      totalDurationSec={totalDurationSec}
                      isTranscribingAsr={isTranscribingAsr}
                      executionMode={executionMode}
                      cloudAsrConfigured={cloudAsrConfigured}
                      projectSessionNonce={projectSessionNonce}
                      asrInlineFeedback={asrInlineFeedback}
                      onDismissAsrInlineFeedback={() => setAsrInlineFeedback(null)}
                      onRunCloudGeminiAsr={handleRunCloudGeminiAsr}
                      onRunAcousticSegmentation={handleRunAcousticSegmentation}
                      onOpenLocalModelInstaller={() => {
                        setLifecycleInitialTab('model');
                        setLifecycleModalOpen(true);
                      }}
                      onSwitchToLocalExecutionMode={() => handleChangeExecutionMode('LOCAL')}
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

                  <div className="lg:col-span-5 space-y-4 min-w-0">
                    <EdlReviewPanel
                      locale={workflowState.locale}
                      sampleRate={project.sampleRate}
                      tokens={tokens}
                      speechEventResult={workflowState.speechEventResult}
                      edlSnapshot={workflowState.edlSnapshot}
                      isAnalyzing={workflowState.isAnalyzingEvents}
                      canUndoEdl={workflowState.edlUndoStack.length > 0}
                      canRedoEdl={workflowState.edlRedoStack.length > 0}
                      onRunAnalysis={handleRunMissionEdlAnalysis}
                      onApproveProposal={(proposalId) => {
                        if (isReadOnlyLocked) {
                          setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
                          return;
                        }
                        const r = workflowRef.current!.applyHumanDecision({
                          action: 'APPROVE',
                          proposalId,
                        });
                        if (!r.ok && r.failure) {
                          setStatusNotice(`تأیید پیشنهاد مسدود شد: ${r.failure.message}`);
                        }
                      }}
                      onRejectProposal={(proposalId) => {
                        if (isReadOnlyLocked) {
                          setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
                          return;
                        }
                        const r = workflowRef.current!.applyHumanDecision({
                          action: 'REJECT',
                          proposalId,
                        });
                        if (!r.ok && r.failure) {
                          setStatusNotice(`رد پیشنهاد ناموفق بود: ${r.failure.message}`);
                        }
                      }}
                      onRequestReviewProposal={(proposalId) => {
                        if (isReadOnlyLocked) {
                          setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
                          return;
                        }
                        const r = workflowRef.current!.applyHumanDecision({
                          action: 'REQUEST_REVIEW',
                          proposalId,
                        });
                        if (!r.ok && r.failure) {
                          setStatusNotice(`ثبت درخواست بازبینی ناموفق بود: ${r.failure.message}`);
                        }
                      }}
                      onReviseBoundaryMs={(proposalId, dStartMs, dEndMs) => {
                        if (isReadOnlyLocked) {
                          setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
                          return;
                        }
                        const prop = workflowState.edlSnapshot?.proposals.find(
                          (p) => p.proposalId === proposalId,
                        );
                        if (!prop) return;
                        const activeRange = prop.proposedRange ?? prop.originalRange;
                        if (!activeRange) return;
                        const deltaStart = Math.round((dStartMs / 1000) * project.sampleRate);
                        const deltaEnd = Math.round((dEndMs / 1000) * project.sampleRate);
                        const r = workflowRef.current!.reviseProposalBoundaries({
                          proposalId,
                          newStartSample: Math.max(0, activeRange.startSample + deltaStart),
                          newEndSample: Math.min(
                            workflowState.sourceAudio?.totalSamples ?? activeRange.endSample + deltaEnd,
                            activeRange.endSample + deltaEnd,
                          ),
                        });
                        if (!r.ok && r.failure) {
                          setStatusNotice(`تغییر مرز پیشنهاد مجاز نیست: ${r.failure.message}`);
                        }
                      }}
                      onPreviewProposal={handlePreviewEdlProposal}
                      onSeekSec={handleSeekSec}
                      onUndoEdl={() => {
                        if (isReadOnlyLocked) {
                          setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
                          return;
                        }
                        workflowRef.current!.undoEdlDecision();
                      }}
                      onRedoEdl={() => {
                        if (isReadOnlyLocked) {
                          setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
                          return;
                        }
                        workflowRef.current!.redoEdlDecision();
                      }}
                      onApplyLinguisticReadableText={handleUpdateTokenDisplayText}
                    />

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
        onToggleLoop={handleToggleLoopSelection}
        onChangePlaybackRate={handleChangePlaybackRate}
        onJumpPrevMarker={handleJumpPrevMarker}
        onJumpNextMarker={handleJumpNextMarker}
        onSetInAtPlayhead={handleSetInAtPlayhead}
        onSetOutAtPlayhead={handleSetOutAtPlayhead}
      />

      <RenderExportModal
        isOpen={renderModalOpen}
        onClose={() => setRenderModalOpen(false)}
        workflowState={workflowState}
        projectSampleRate={(project.sampleRate as SampleRate) || 48000}
        tokens={tokens}
        onStartRender={handleStartMission06Render}
        onPauseRender={() => workflowRef.current?.requestPauseRender()}
        onCancelRender={() => workflowRef.current?.cancelRender()}
        onMarkDownloaded={(fileName) => workflowRef.current?.markExportSaved(fileName)}
      />

      <LifecycleManagementModal
        isOpen={lifecycleModalOpen}
        initialTab={lifecycleInitialTab}
        onClose={() => setLifecycleModalOpen(false)}
        workflowState={workflowState}
        modelManager={modelManagerRef.current}
        onModelStateChanged={() => {
          const snap = modelManagerRef.current.getSnapshot();
          if (snap.activeModel) {
            setActiveFailure(null);
            setAsrInlineFeedback((prev) =>
              prev?.kind === 'MODEL_NOT_INSTALLED' ? null : prev,
            );
            workflowRef.current?.setAsrState({
              state: 'MODEL_READY',
              modelId: snap.activeModel.modelId,
              modelVersion: snap.activeModel.version,
              message: `مدل محلی ${snap.activeModel.modelId} با SHA-256 تأیید و آماده است.`,
            });
          } else {
            workflowRef.current?.setAsrState({
              state: 'MODEL_NOT_INSTALLED',
              modelId: null,
              modelVersion: null,
              message: 'مدل محلی نصب نشده است.',
            });
          }
        }}
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
