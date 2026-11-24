import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  HeaderNav,
  HeaderWorkflowStepItem,
  ProjectSaveStatus,
  WorkspaceTab,
} from './components/HeaderNav';
import { WaveformCanvas } from './components/WaveformCanvas';
import {
  AsrInlineFeedbackState,
  TranscriptPanel,
} from './components/TranscriptPanel';
import {
  UnifiedEditorialInspector,
  type EditorialInspectorFocus,
} from './components/UnifiedEditorialInspector';
import { DspControlRack } from './components/DspControlRack';
import { ProcessingGraphView } from './components/ProcessingGraphView';
import { StorageBrokerView } from './components/StorageBrokerView';
import { ShahabLabView } from './components/ShahabLabView';
import { AsrResearchLabModal } from './components/AsrResearchLabModal';
import { SpeechSecurityModal } from './components/SpeechSecurityModal';
import { AuditionTransportBar, WaveformSelectionState } from './components/AuditionTransportBar';
import { AuditionDockTabId, AuditionSideDock } from './components/AuditionSideDock';
import {
  formatAsrShortStatus,
  StudioWorkflowStepId,
  WorkflowStageBar,
} from './components/WorkflowStageBar';
import { RenderExportModal } from './components/RenderExportModal';
import { ProjectsHubView } from './components/ProjectsHubView';
import { NewProjectModal } from './components/NewProjectModal';
import { SettingsCenterModal } from './components/SettingsCenterModal';
import {
  applyAccessibilityAttributesToDocument,
  applyThemeToDocument,
  resolveEffectiveTheme,
} from './utils/themePreference';
import { isLabModeEnabled } from './utils/labMode';
import { matchesShortcutBinding } from './utils/shortcuts';
import { usePWAInstall } from './ui/pwa/PWAInstallControls';
import {
  GlobalSettingsV1,
  loadGlobalSettings,
  saveGlobalSettings,
} from './settings/settingsStore';
import {
  extractDownsampledWaveformPeaks,
  PersistedProjectSummary,
} from './projects/projectLibraryLogic';
import { projectLibraryStore } from './projects/projectLibraryStore';
import {
  loadConfiguredCompanionEndpoint,
  saveConfiguredCompanionEndpoint,
} from './host-bridge/companion/CompanionDiagnostics';
import { buildCompanionTranscriptTokens } from './utils/transcriptDisplay';
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
  LoadedStudioProject,
  ProjectResourceLeaseSlot,
} from './engine/audioFixtures';
import {
  AudioImportCoordinatorError,
  importAudioProject,
} from './workflow/AudioImportCoordinator';
import {
  IngestAbortedError,
  IngestTransactionError,
} from './engine/streamingIngest';
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
import {
  getSharedMemoryBudgetManager,
  MemoryPressureError,
} from './runtime/memory/MemoryBudgetManager';
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
  normalizeNumbersAndCompoundsInTranscript,
  optimizeAndAnalyzeTrilingualAsrTranscript,
  redactSelectedTokensInAudioAndTranscript,
  restorePersianProsodicPunctuation,
} from './engine/persianAsrTranscriber';
import { EnglishScriptRenderMode } from './ai-engine/asr/MultilingualCodeSwitchAndArabicEngine';
import { AudioRedactionMaskMode } from '../packages/audio-runtime/src/SensitiveContentAndPiiRedactorEngine';
import { buildPeakPyramid } from './engine/peakPyramid';
import { flicksToSeconds, formatTimecode, msToFlicks, secondsToFlicks } from './engine/timebase';
import { evaluateLocalAsrExecutionReadiness } from './runtime/LocalExecutionPolicy';
import { CompanionWebClient } from './host-bridge/companion/CompanionWebClient';
import { BrowserOnnxAsrRuntimeAdapter } from './asr-core/BrowserOnnxAsrRuntimeAdapter';
import { NativeCompanionAsrRuntimeAdapter } from './asr-core/NativeCompanionAsrRuntimeAdapter';
import { UnifiedLocalAsrWorkflowService } from './workflow/UnifiedLocalAsrWorkflowService';
import { installShenavaRizehInBrowser } from './lifecycle/BrowserPersianModelInstaller';
import {
  fetchShahabRuntimeStatus,
  fetchShahabSampleAudioFile,
  transcribePcmWithShahabLocal,
  type ShahabLocalRuntimeStatusResponse,
} from './asr-core/ShahabLocalHttpClient';

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
  const [isInstallingBrowserModel, setIsInstallingBrowserModel] = useState<boolean>(false);
  const [browserModelInstallPct, setBrowserModelInstallPct] = useState<number | null>(null);
  const [hasBrowserInstalledModel, setHasBrowserInstalledModel] = useState<boolean>(false);
  const [shahabRuntimeStatus, setShahabRuntimeStatus] =
    useState<ShahabLocalRuntimeStatusResponse | null>(null);
  const [shahabStatusCheckedOnce, setShahabStatusCheckedOnce] = useState<boolean>(false);
  const [shahabStatusLastCheckedMs, setShahabStatusLastCheckedMs] = useState<number | null>(null);
  const [isRefreshingShahabStatus, setIsRefreshingShahabStatus] = useState<boolean>(false);
  const shahabRuntimeStatusRef = useRef<ShahabLocalRuntimeStatusResponse | null>(null);
  const shahabProbeSeqRef = useRef<number>(0);
  const shahabProbeAbortRef = useRef<AbortController | null>(null);
  const activeShahabTranscribeAbortRef = useRef<AbortController | null>(null);
  const [asrInlineFeedback, setAsrInlineFeedback] =
    useState<AsrInlineFeedbackState | null>(null);
  const [englishRenderMode, setEnglishRenderMode] =
    useState<EnglishScriptRenderMode>('LATIN_TECHNICAL');

  // Unified Global Settings (Light-First default) & Lab Mode gate
  const isLabMode = useMemo(() => isLabModeEnabled(), []);
  const { isInstallable: canInstallPwa, install: triggerInstallPwa } = usePWAInstall();
  const [globalSettings, setGlobalSettings] = useState<GlobalSettingsV1>(() => loadGlobalSettings());
  const [inspectorRequestedFocus, setInspectorRequestedFocus] =
    useState<EditorialInspectorFocus | null>(null);

  // Transport & Adobe Audition Selection state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [detectedSyncOffsetMs, setDetectedSyncOffsetMs] = useState<number>(38.5);
  const [detectedClockDriftPpm, setDetectedClockDriftPpm] = useState<number>(14.2);
  const [selection, setSelection] = useState<WaveformSelectionState | null>(null);
  const [loopSelection, setLoopSelection] = useState<boolean>(
    () => globalSettings.playback.loopEnabledByDefault,
  );
  const [playbackRate, setPlaybackRate] = useState<number>(
    () => globalSettings.playback.defaultRate,
  );
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
  const brokerReadyPromiseRef = useRef<Promise<StorageBrokerTelemetry> | null>(null);
  const activeImportAbortRef = useRef<AbortController | null>(null);
  const isImportingAudioRef = useRef<boolean>(false);
  const [isImportingAudio, setIsImportingAudio] = useState<boolean>(false);
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

  // Global Settings Modal status
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);

  const [appView, setAppView] = useState<'projects' | 'studio'>(() => {
    if (typeof window === 'undefined') return 'projects';
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'studio' || params.get('project')) {
      return 'studio';
    }
    return 'projects';
  });
  const [activePersistedProjectId, setActivePersistedProjectId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('project');
  });
  const [projectSaveStatus, setProjectSaveStatus] = useState<ProjectSaveStatus>('sample');
  const [hubProjects, setHubProjects] = useState<PersistedProjectSummary[]>([]);
  const [hubLoading, setHubLoading] = useState<boolean>(true);
  const [hubError, setHubError] = useState<string | null>(null);
  const [hubCorruptedCount, setHubCorruptedCount] = useState<number>(0);
  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false);
  const [activeWorkflowStep, setActiveWorkflowStep] = useState<StudioWorkflowStepId>('review');
  const [customMarkers, setCustomMarkers] = useState<Array<{ id: string; label: string; startSec: number }>>([]);
  const [mobileStudioPane, setMobileStudioPane] = useState<'center' | 'suggestions' | 'files'>('center');
  const [leftRailCollapsed, setLeftRailCollapsed] = useState<boolean>(false);
  const [sideDockTab, setSideDockTab] = useState<AuditionDockTabId>('files');
  const [trackHeightPx, setTrackHeightPx] = useState<number>(82);

  const handleStartSplitSashDrag = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startTrackH = trackHeightPx;
      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaY = moveEvent.clientY - startY;
        const nextH = Math.max(46, Math.min(180, Math.round(startTrackH + deltaY * 0.55)));
        setTrackHeightPx(nextH);
      };
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [trackHeightPx],
  );

  // Studio Tool Modals state
  const [renderModalOpen, setRenderModalOpen] = useState(false);
  const [lifecycleModalOpen, setLifecycleModalOpen] = useState(false);
  const [lifecycleInitialTab, setLifecycleInitialTab] = useState<LifecycleModalTab>('health');
  const [asrLabOpen, setAsrLabOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [isTestingLru, setIsTestingLru] = useState(false);

  // Mission 07/09/10/Unified Processing state controllers (Light-First default!)
  const workflowRef = useRef<StudioWorkflowController | null>(null);
  if (!workflowRef.current) {
    const initialEffectiveTheme = resolveEffectiveTheme(globalSettings.appearance.theme);
    workflowRef.current = new StudioWorkflowController({
      projectStore: createBrowserLocalProjectStore(),
      initialLocale: globalSettings.language.locale,
      initialTheme: initialEffectiveTheme,
    });
  }
  const [workflowState, setWorkflowState] = useState<StudioWorkflowState>(() =>
    workflowRef.current!.getState(),
  );
  const [companionEndpoint, setCompanionEndpoint] = useState<string>(() =>
    loadConfiguredCompanionEndpoint(),
  );
  const handleChangeCompanionEndpoint = useCallback((nextEndpoint: string) => {
    const saved = saveConfiguredCompanionEndpoint(nextEndpoint);
    if (saved.valid) {
      setCompanionEndpoint(saved.normalizedEndpoint);
    }
  }, []);
  const modelManagerRef = useRef(createSharedLocalModelLifecycleManager());
  const syncModelSnapshotToWorkflow = useCallback(() => {
    const snap = modelManagerRef.current.getSnapshot();
    setHasBrowserInstalledModel(Boolean(snap.activeModel));
    if (snap.activeModel && snap.runtimeReady) {
      setActiveFailure(null);
      setAsrInlineFeedback((prev) =>
        prev?.kind === 'MODEL_NOT_INSTALLED' ? null : prev,
      );
      workflowRef.current?.setAsrState({
        state: 'MODEL_READY',
        modelId: snap.activeModel.modelId,
        modelVersion: snap.activeModel.version,
        message: `مدل محلی ${snap.activeModel.modelId} (${snap.activeModel.version}) تأیید و در موتور استنتاج بارگذاری شده است.`,
      });
    } else if (snap.activeModel) {
      setActiveFailure(null);
      setAsrInlineFeedback((prev) =>
        prev?.kind === 'MODEL_NOT_INSTALLED' ? null : prev,
      );
      workflowRef.current?.setAsrState({
        state: 'MODEL_AVAILABLE',
        modelId: snap.activeModel.modelId,
        modelVersion: snap.activeModel.version,
        message: `مدل محلی ${snap.activeModel.modelId} (${snap.activeModel.version}) در OPFS ذخیره و تأیید شده است (در انتظار مقداردهی جلسه استنتاج).`,
      });
    } else if (snap.state === 'INTEGRITY_FAILURE') {
      workflowRef.current?.setAsrState({
        state: 'MODEL_INTEGRITY_FAILURE',
        modelId: null,
        modelVersion: null,
        message: snap.lastError ?? 'عدم تطابق امضای SHA-256 در فایل مدل ذخیره‌شده.',
      });
    } else if (shahabRuntimeStatusRef.current?.available) {
      workflowRef.current?.setAsrState({
        state: 'MODEL_READY',
        modelId: shahabRuntimeStatusRef.current.modelId,
        modelVersion: shahabRuntimeStatusRef.current.modelVersion,
        message: `موتور شهاب (${shahabRuntimeStatusRef.current.modelId}) متصل و آماده اجرا است.`,
      });
    } else {
      workflowRef.current?.setAsrState({
        state: 'MODEL_NOT_INSTALLED',
        modelId: null,
        modelVersion: null,
        message: 'مدل محلی نصب نشده است.',
      });
    }
  }, []);

  useEffect(() => {
    let active = true;
    void modelManagerRef.current
      .initialize()
      .then(() => {
        if (active) {
          syncModelSnapshotToWorkflow();
        }
      })
      .catch(() => {
        if (active) {
          syncModelSnapshotToWorkflow();
        }
      });
    return () => {
      active = false;
    };
  }, [syncModelSnapshotToWorkflow]);

  const executionModeStoreRef = useRef(new ExecutionModePreferenceStore());
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() =>
    executionModeStoreRef.current.getPreferredMode(),
  );
  const cloudAsrConfigured = false;
  const [activeFailure, setActiveFailure] = useState<UserFacingFailureModel | null>(null);

  const transportRef = useRef<StudioAudioTransport | null>(null);
  const projectResourceLeaseRef = useRef<ProjectResourceLeaseSlot>(new ProjectResourceLeaseSlot());
  const isMountedRef = useRef<boolean>(true);
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
    isMountedRef.current = true;
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

    const initPromise = broker.init();
    brokerReadyPromiseRef.current = initPromise;

    void initPromise
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

    void fetchShahabRuntimeStatus()
      .then((status) => {
        if (cancelled) return;
        setShahabStatusCheckedOnce(true);
        setShahabStatusLastCheckedMs(Date.now());
        if (status) {
          shahabRuntimeStatusRef.current = status;
          setShahabRuntimeStatus(status);
          if (status.available) {
            workflowRef.current?.setAsrState({
              state: 'MODEL_READY',
              modelId: status.modelId,
              modelVersion: status.modelVersion,
              message: `موتور شهاب (${status.modelId}) متصل و آماده اجرا است.`,
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setShahabStatusCheckedOnce(true);
          setShahabStatusLastCheckedMs(Date.now());
        }
      });

    return () => {
      cancelled = true;
      isMountedRef.current = false;
      activeImportAbortRef.current?.abort();
      activeImportAbortRef.current = null;
      shahabProbeAbortRef.current?.abort();
      shahabProbeAbortRef.current = null;
      activeShahabTranscribeAbortRef.current?.abort();
      activeShahabTranscribeAbortRef.current = null;
      isImportingAudioRef.current = false;
      brokerReadyPromiseRef.current = null;
      unregisterEviction();
      transport.stop();
      transport.dispose();
      projectResourceLeaseRef.current.clear();
      broker.dispose();
    };
  }, []);

  const refreshShahabRuntimeStatus = useCallback(async (showSpinner = false) => {
    const seq = ++shahabProbeSeqRef.current;
    shahabProbeAbortRef.current?.abort();
    const probeController = new AbortController();
    shahabProbeAbortRef.current = probeController;

    if (showSpinner) setIsRefreshingShahabStatus(true);
    try {
      const status = await fetchShahabRuntimeStatus(probeController.signal);
      if (!isMountedRef.current || seq !== shahabProbeSeqRef.current || probeController.signal.aborted) {
        return;
      }
      setShahabStatusCheckedOnce(true);
      setShahabStatusLastCheckedMs(Date.now());
      shahabRuntimeStatusRef.current = status;
      setShahabRuntimeStatus(status);
      if (status?.available) {
        const currentAsrState = workflowRef.current?.getState().asrState;
        if (currentAsrState === 'MODEL_NOT_INSTALLED' || currentAsrState === 'RUNTIME_UNAVAILABLE') {
          workflowRef.current?.setAsrState({
            state: 'MODEL_READY',
            modelId: status.modelId,
            modelVersion: status.modelVersion,
            message: `موتور شهاب (${status.modelId}) متصل و آماده اجرا است.`,
          });
        }
      }
    } finally {
      if (showSpinner && isMountedRef.current && seq === shahabProbeSeqRef.current) {
        setIsRefreshingShahabStatus(false);
      }
    }
  }, []);

  // Real-time live polling for SHAHAB engine status widget while on Studio tab
  useEffect(() => {
    if (activeTab !== 'studio') return;
    const intervalMs = isTranscribingAsr ? 1500 : 4000;
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshShahabRuntimeStatus(false);
    }, intervalMs);
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void refreshShahabRuntimeStatus(false);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      window.clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [activeTab, isTranscribingAsr, refreshShahabRuntimeStatus]);

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

  const handleUpdateGlobalSettings = useCallback((next: GlobalSettingsV1) => {
    setGlobalSettings((prev) => {
      if (next.playback.loopEnabledByDefault !== prev.playback.loopEnabledByDefault) {
        setLoopSelection(next.playback.loopEnabledByDefault);
      }
      return next;
    });
    setSettingsSaveStatus('saving');
    const saved = saveGlobalSettings(next);
    if (saved.ok) {
      setSettingsSaveStatus('saved');
      setSettingsSaveError(null);
    } else {
      setSettingsSaveStatus('error');
      setSettingsSaveError(saved.error ?? 'Failed to persist settings');
    }
    const effectiveTheme = resolveEffectiveTheme(next.appearance.theme);
    workflowRef.current?.setTheme(effectiveTheme);
    workflowRef.current?.setLocale(next.language.locale);
    setPlaybackRate(next.playback.defaultRate);
  }, []);

  const handleToggleThemeQuick = useCallback(() => {
    const currentEffective = resolveEffectiveTheme(globalSettings.appearance.theme);
    const nextTheme = currentEffective === 'dark' ? 'light' : 'dark';
    handleUpdateGlobalSettings({
      ...globalSettings,
      appearance: {
        ...globalSettings.appearance,
        theme: nextTheme,
      },
    });
  }, [globalSettings, handleUpdateGlobalSettings]);

  const handleToggleLocaleQuick = useCallback(
    (nextLocale?: WorkflowLocale) => {
      const target: WorkflowLocale =
        nextLocale ?? (globalSettings.language.locale === 'fa' ? 'en' : 'fa');
      handleUpdateGlobalSettings({
        ...globalSettings,
        language: {
          ...globalSettings.language,
          locale: target,
        },
      });
    },
    [globalSettings, handleUpdateGlobalSettings],
  );

  useEffect(() => {
    if (!isLabMode && activeTab !== 'studio') {
      setActiveTab('studio');
    }
  }, [activeTab, isLabMode]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const effectiveTheme = resolveEffectiveTheme(globalSettings.appearance.theme);
    applyThemeToDocument(effectiveTheme);
    applyAccessibilityAttributesToDocument({
      fontScale: globalSettings.workspace.transcriptFontScale,
      motionPreference: globalSettings.accessibility.motion,
      highContrast: globalSettings.accessibility.highContrast,
      density: globalSettings.workspace.density,
    });
    document.documentElement.lang = globalSettings.language.locale === 'fa' ? 'fa' : 'en';
    document.documentElement.dir = globalSettings.language.locale === 'fa' ? 'rtl' : 'ltr';
  }, [
    globalSettings.appearance.theme,
    globalSettings.language.locale,
    globalSettings.workspace.transcriptFontScale,
    globalSettings.workspace.density,
    globalSettings.accessibility.motion,
    globalSettings.accessibility.highContrast,
    workflowState.theme,
    workflowState.locale,
  ]);

  // Listen for OS theme changes ONLY when user explicitly selected 'system'
  useEffect(() => {
    if (globalSettings.appearance.theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const eff = resolveEffectiveTheme('system', mq.matches);
      applyThemeToDocument(eff);
      workflowRef.current?.setTheme(eff);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [globalSettings.appearance.theme]);

  // Load persisted Projects Hub list from IndexedDB
  const refreshProjectsHub = useCallback(async () => {
    setHubLoading(true);
    setHubError(null);
    try {
      const res = await projectLibraryStore.listProjects();
      setHubProjects(res.projects);
      setHubCorruptedCount(res.corruptedCount);
    } catch (err) {
      setHubError(
        err instanceof Error
          ? err.message
          : 'بارگذاری فهرست پروژه‌های محلی با خطا مواجه شد.',
      );
    } finally {
      setHubLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjectsHub();
  }, [refreshProjectsHub]);

  const syncBrowserUrlForView = useCallback((view: 'projects' | 'studio', projectId?: string | null) => {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      if (view === 'projects') {
        url.searchParams.delete('view');
        url.searchParams.delete('project');
      } else {
        url.searchParams.set('view', 'studio');
        if (projectId) url.searchParams.set('project', projectId);
        else url.searchParams.delete('project');
      }
      window.history.replaceState({}, '', url.toString());
    } catch {
      // Ignore restricted history APIs
    }
  }, []);

  const handleOpenHubProject = useCallback(
    async (projectId: string) => {
      try {
        setStatusNotice('در حال بارگذاری پروژه از حافظه محلی...');
        const loadedRec = await projectLibraryStore.getProjectWithAudio(projectId);
        const imported = await importAudioProject(loadedRec.audioFile, {
          broker: brokerRef.current,
          brokerReady: brokerReadyPromiseRef.current,
          memoryBudgetManager: getSharedMemoryBudgetManager(),
          retainActivePcmMirror:
            loadedRec.audioFile.size <= AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
        });

        transportRef.current?.stop();
        setIsPlaying(false);
        projectResourceLeaseRef.current.replaceWith(imported.runtimeResourceLease ?? null);
        historyRef.current = new TimelineHistoryManager();

        const hydratedProject: LoadedStudioProject = {
          ...imported,
          projectName: loadedRec.record.name,
        };
        const hydratedTracks =
          loadedRec.record.tracks.length > 0
            ? cloneTracks(loadedRec.record.tracks)
            : cloneTracks(imported.tracks);
        const hydratedTokens = cloneTokens(loadedRec.record.tokens);
        const hydratedRecs = cloneRecommendations(loadedRec.record.recommendations);

        setProject(hydratedProject);
        setProjectSessionNonce((n) => n + 1);
        setTracks(hydratedTracks);
        setTokens(hydratedTokens);
        setRecommendations(hydratedRecs);
        setSelectedRecId(hydratedRecs[0]?.id ?? null);
        setSelection(null);
        setPlayheadSec(0);
        setLoopSelection(globalSettings.playback.loopEnabledByDefault);
        setZoom(
          globalSettings.workspace.resetZoomOnProjectOpen
            ? 1
            : loadedRec.record.projectPreferences?.zoomLevel || 1,
        );
        setCustomMarkers(
          (loadedRec.record.projectPreferences?.markers ?? []).map((m) => ({
            id: m.id,
            label: m.label,
            startSec: m.timeSec,
          })),
        );
        setActivePersistedProjectId(loadedRec.record.id);
        setProjectSaveStatus('saved');
        setAppView('studio');
        setActiveTab('studio');
        syncBrowserUrlForView('studio', loadedRec.record.id);
        setStatusNotice(`پروژه «${loadedRec.record.name}» بارگذاری شد.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'باز کردن پروژه ناموفق بود.';
        setHubError(msg);
        setStatusNotice(msg);
      }
    },
    [
      globalSettings.playback.loopEnabledByDefault,
      globalSettings.workspace.resetZoomOnProjectOpen,
      syncBrowserUrlForView,
    ],
  );

  // Auto-open persisted project if URL contains ?project=<id>
  const initialProjectLoadRef = useRef(false);
  useEffect(() => {
    if (initialProjectLoadRef.current) return;
    initialProjectLoadRef.current = true;
    if (activePersistedProjectId) {
      void handleOpenHubProject(activePersistedProjectId);
    }
  }, [activePersistedProjectId, handleOpenHubProject]);

  const handleCreateHubProject = useCallback(
    async (params: { name: string; file: File; detectedContainer: string }) => {
      const imported = await importAudioProject(params.file, {
        broker: brokerRef.current,
        brokerReady: brokerReadyPromiseRef.current,
        memoryBudgetManager: getSharedMemoryBudgetManager(),
        retainActivePcmMirror:
          params.file.size <= AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes,
      });

      const primaryAsset = Object.values(imported.assets)[0];
      const primaryPcm = primaryAsset ? imported.pcmSources[primaryAsset.id] : undefined;
      const durationSec = primaryPcm
        ? primaryPcm.length / Math.max(1, imported.sampleRate)
        : flicksToSeconds(computeTimelineDurationFlicks(imported.tracks));
      const previewPeaks = primaryPcm ? extractDownsampledWaveformPeaks(primaryPcm, 48) : null;

      const created = await projectLibraryStore.createProjectFromImportedAudio({
        name: params.name,
        file: params.file,
        detectedContainer: params.detectedContainer,
        durationSec,
        sampleRate: imported.sampleRate,
        tracks: imported.tracks,
        tokens: imported.tokens,
        recommendations: imported.recommendations,
        waveformPreviewPeaks: previewPeaks,
      });

      transportRef.current?.stop();
      setIsPlaying(false);
      projectResourceLeaseRef.current.replaceWith(imported.runtimeResourceLease ?? null);
      historyRef.current = new TimelineHistoryManager();

      setProject({ ...imported, projectName: created.name });
      setProjectSessionNonce((n) => n + 1);
      setTracks(cloneTracks(imported.tracks));
      setTokens(cloneTokens(imported.tokens));
      setRecommendations(cloneRecommendations(imported.recommendations));
      setSelectedRecId(imported.recommendations[0]?.id ?? null);
      setSelection(null);
      setPlayheadSec(0);
      setLoopSelection(globalSettings.playback.loopEnabledByDefault);
      if (globalSettings.workspace.resetZoomOnProjectOpen) {
        setZoom(1);
      } else {
        setZoom(1);
      }
      setCustomMarkers([]);
      setActivePersistedProjectId(created.id);
      setProjectSaveStatus('saved');
      setNewProjectModalOpen(false);
      setAppView('studio');
      setActiveTab('studio');
      syncBrowserUrlForView('studio', created.id);
      setStatusNotice(`پروژه «${created.name}» ایجاد و ذخیره شد.`);
      void refreshProjectsHub();
    },
    [
      globalSettings.playback.loopEnabledByDefault,
      globalSettings.workspace.resetZoomOnProjectOpen,
      refreshProjectsHub,
      syncBrowserUrlForView,
    ],
  );

  const handleRenameHubProject = useCallback(
    async (projectId: string, nextName: string) => {
      await projectLibraryStore.renameProject(projectId, nextName);
      if (activePersistedProjectId === projectId) {
        setProject((prev) => ({ ...prev, projectName: nextName }));
      }
      await refreshProjectsHub();
    },
    [activePersistedProjectId, refreshProjectsHub],
  );

  const handleDuplicateHubProject = useCallback(
    async (projectId: string) => {
      await projectLibraryStore.duplicateProject(projectId);
      await refreshProjectsHub();
    },
    [refreshProjectsHub],
  );

  const handleDeleteHubProject = useCallback(
    async (projectId: string) => {
      await projectLibraryStore.deleteProject(projectId);
      if (activePersistedProjectId === projectId) {
        setActivePersistedProjectId(null);
        setProjectSaveStatus('sample');
      }
      await refreshProjectsHub();
    },
    [activePersistedProjectId, refreshProjectsHub],
  );

  const handleReturnToProjectsHub = useCallback(async () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);
    if (activePersistedProjectId && globalSettings.storage.autoSaveProjectEdits) {
      try {
        await projectLibraryStore.saveProjectEdits(activePersistedProjectId, {
          name: project.projectName,
          tracks,
          tokens,
          recommendations,
          durationSec: flicksToSeconds(computeTimelineDurationFlicks(tracks)),
          projectPreferences: {
            zoomLevel: zoom,
            selectedTrackId: tracks[0]?.id ?? null,
            markers: customMarkers.map((m) => ({
              id: m.id,
              label: m.label,
              timeSec: m.startSec,
              kind: 'general' as const,
              createdAtMs: Date.now(),
            })),
          },
        });
      } catch {
        // Keep user navigable even if storage temporarily fails
      }
    }
    setAppView('projects');
    syncBrowserUrlForView('projects');
    void refreshProjectsHub();
  }, [
    activePersistedProjectId,
    customMarkers,
    globalSettings.storage.autoSaveProjectEdits,
    project.projectName,
    recommendations,
    refreshProjectsHub,
    syncBrowserUrlForView,
    tokens,
    tracks,
    zoom,
  ]);

  const handleOpenSampleStudio = useCallback(() => {
    setActivePersistedProjectId(null);
    setProjectSaveStatus('sample');
    setLoopSelection(globalSettings.playback.loopEnabledByDefault);
    if (globalSettings.workspace.resetZoomOnProjectOpen) {
      setZoom(1);
    }
    setAppView('studio');
    setActiveTab('studio');
    syncBrowserUrlForView('studio', null);
  }, [
    globalSettings.playback.loopEnabledByDefault,
    globalSettings.workspace.resetZoomOnProjectOpen,
    syncBrowserUrlForView,
  ]);

  // Debounced autosave to IndexedDB for persisted projects
  const autosaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !activePersistedProjectId ||
      appView !== 'studio' ||
      !globalSettings.storage.autoSaveProjectEdits
    ) {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      return;
    }
    setProjectSaveStatus('saving');
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      void projectLibraryStore
        .saveProjectEdits(activePersistedProjectId, {
          name: project.projectName,
          tracks,
          tokens,
          recommendations,
          durationSec: flicksToSeconds(computeTimelineDurationFlicks(tracks)),
          projectPreferences: {
            zoomLevel: zoom,
            selectedTrackId: tracks[0]?.id ?? null,
            markers: customMarkers.map((m) => ({
              id: m.id,
              label: m.label,
              timeSec: m.startSec,
              kind: 'general' as const,
              createdAtMs: Date.now(),
            })),
          },
        })
        .then(() => {
          setProjectSaveStatus('saved');
        })
        .catch(() => {
          setProjectSaveStatus('error');
        });
    }, 650);

    return () => {
      if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    };
  }, [
    activePersistedProjectId,
    appView,
    globalSettings.storage.autoSaveProjectEdits,
    project.projectName,
    tracks,
    tokens,
    recommendations,
    customMarkers,
    zoom,
  ]);

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

    const streamReadAssetRange = (assetId: string, startSample: number, length: number) => {
      const asset = project.assets[assetId];
      const fallback = project.pcmSources[assetId];
      const blockSize =
        asset?.blockSizeSamples ?? Math.max(1, (asset?.nativeSampleRate ?? project.sampleRate) * 4);
      if (brokerRef.current && !brokerRef.current.isDisposed()) {
        return brokerRef.current.streamReadRange(
          assetId,
          startSample,
          length,
          blockSize,
          fallback,
          'playback-feeder',
        );
      }
      if (fallback) {
        const s = Math.max(0, Math.min(fallback.length, Math.trunc(startSample)));
        const e = Math.max(s, Math.min(fallback.length, s + Math.trunc(length)));
        return Promise.resolve(fallback.slice(s, e));
      }
      return Promise.resolve(new Float32Array(0));
    };

    transportRef.current.playTimelineWindowed({
      tracks: activeTracks,
      assets: project.assets,
      pcmSources: project.pcmSources,
      readAssetRange: streamReadAssetRange,
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
      readAssetRange: (assetId, startSample, length) => {
        const asset = project.assets[assetId];
        const fallback = project.pcmSources[assetId];
        const blockSize =
          asset?.blockSizeSamples ?? Math.max(1, (asset?.nativeSampleRate ?? project.sampleRate) * 4);
        if (brokerRef.current && !brokerRef.current.isDisposed()) {
          return brokerRef.current.streamReadRange(
            assetId,
            startSample,
            length,
            blockSize,
            fallback,
            'playback-feeder',
          );
        }
        return Promise.resolve(fallback ? fallback.slice(startSample, startSample + length) : new Float32Array(0));
      },
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

  const handlePlaySelectionRange = (
    targetSel?: WaveformSelectionState | null,
    options?: { isPreview?: boolean },
  ) => {
    const activeSel = targetSel ?? selection;
    if (!transportRef.current || !activeSel || activeSel.endSec - activeSel.startSec < 0.05) {
      return;
    }
    const continuePastPreviewEnd =
      Boolean(options?.isPreview) && !globalSettings.playback.stopAtPreviewEnd;
    activePlaybackScopeRef.current = continuePastPreviewEnd ? 'timeline' : 'selection';
    setPlayheadSec(activeSel.startSec);
    setIsPlaying(true);
    if (!options?.isPreview) {
      setPreviewingId(null);
    }
    transportRef.current.playTimelineWindowed({
      tracks,
      assets: project.assets,
      pcmSources: project.pcmSources,
      readAssetRange: (assetId, startSample, length) => {
        const asset = project.assets[assetId];
        const fallback = project.pcmSources[assetId];
        const blockSize =
          asset?.blockSizeSamples ?? Math.max(1, (asset?.nativeSampleRate ?? project.sampleRate) * 4);
        if (brokerRef.current && !brokerRef.current.isDisposed()) {
          return brokerRef.current.streamReadRange(
            assetId,
            startSample,
            length,
            blockSize,
            fallback,
            'playback-feeder',
          );
        }
        return Promise.resolve(fallback ? fallback.slice(startSample, startSample + length) : new Float32Array(0));
      },
      sampleRate: project.sampleRate,
      startTimelineSec: activeSel.startSec,
      totalDurationSec,
      endTimelineSec: continuePastPreviewEnd ? totalDurationSec : activeSel.endSec,
      loop: continuePastPreviewEnd ? false : loopSelection,
      playbackRate,
      dspParams: ephemeralDsp,
      dspBypassFlags,
      onTick: (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
      onMeter: (peakDb, rmsDb) => setMeterDb({ peakDb, rmsDb }),
      onEnded: () => {
        setIsPlaying(false);
        setPreviewingId(null);
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

  const handleBatchUpdateTokenDisplayTexts = (
    updates: ReadonlyArray<{ tokenId: string; displayText: string }>,
    descriptionFa?: string,
  ) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (updates.length === 0) return;
    const updateMap = new Map(updates.map((u) => [u.tokenId, u.displayText]));
    let changed = false;
    const nextTokens = tokens.map((tok) => {
      if (!updateMap.has(tok.id)) return tok;
      const nextText = updateMap.get(tok.id)!;
      if (tok.displayText !== nextText) {
        changed = true;
        return { ...tok, displayText: nextText };
      }
      return tok;
    });
    if (!changed) return;

    const beforeTokensSnapshot = cloneTokens(tokens);
    const label = descriptionFa ?? 'به‌روزرسانی گروهی املای نمایشی واژه‌ها';
    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'dsp-parameter-change',
      description: label,
      beforeTracks: tracks,
      afterTracks: tracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: nextTokens,
      beforeRecommendations: recommendations,
      afterRecommendations: recommendations,
    });
    setTokens(nextTokens);
    syncWorkflowTranscript(nextTokens, label);
    setHistoryTick((v) => v + 1);
    setStatusNotice(`${label} با حفظ لایه خام ASR اعمال شد.`);
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

    const primaryTrack = tracks[0];
    const primaryAssetId = primaryTrack ? getTrackPrimaryAssetId(primaryTrack, project.assets) : null;
    if (!primaryTrack || !primaryAssetId || !project.assets[primaryAssetId]) {
      setStatusNotice('فایل صوتی قابل پردازش روی ترک اصلی یافت نشد.');
      setAsrInlineFeedback({
        kind: 'AUDIO_MISSING',
        titleFa: 'فایل صوتی یافت نشد',
        messageFa: 'برای اجرای تبدیل صوت به متن و هم‌ترازی آوایی، ابتدا یک فایل صوتی معتبر وارد کنید.',
      });
      return;
    }

    if (executionMode === 'CLOUD') {
      const readiness = evaluateLocalAsrExecutionReadiness({
        hasInstalledModelWeights: false,
        hasVerifiedInferenceEngine: false,
        requestedCloudMode: true,
      });
      const err = classifyError(new Error(readiness.reasonEn), { subsystem: 'ASR_RUNTIME' });
      getSharedDiagnosticLogger().log({
        severity: 'WARNING',
        subsystem: 'ASR_RUNTIME',
        code: readiness.code,
        message: readiness.reasonEn,
      });
      setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
      setAsrInlineFeedback({
        kind: 'CLOUD_UNCONFIGURED',
        titleFa: readiness.titleFa,
        messageFa: readiness.messageFa,
      });
      setStatusNotice(readiness.titleFa);
      return;
    }

    const resolved = await resolveTrackAssetAndPcm(primaryTrack);
    if (!resolved) {
      setStatusNotice('داده‌های صوتی PCM برای ترک اصلی در دسترس نیست.');
      return;
    }

    // Primary local ASR path: Real SHAHAB Zipformer-Transducer engine on local runtime
    const liveShahab = shahabRuntimeStatus ?? (await fetchShahabRuntimeStatus());
    if (liveShahab && !shahabRuntimeStatus) {
      setShahabRuntimeStatus(liveShahab);
    }

    if (liveShahab?.available) {
      const speakerLabel = primaryTrack.speakerLabel || primaryTrack.name || 'گوینده ۱';
      setIsTranscribingAsr(true);
      setActiveFailure(null);
      setAsrInlineFeedback(null);
      setStatusNotice(
        'در حال اجرای موتور محلی شهاب (SHAHAB Zipformer INT8) روی صدای ترک اصلی...',
      );

      const transcribeAbort = new AbortController();
      activeShahabTranscribeAbortRef.current?.abort();
      activeShahabTranscribeAbortRef.current = transcribeAbort;

      try {
        const { response, tokens: nextTokens } = await transcribePcmWithShahabLocal({
          pcm: resolved.pcm,
          sampleRate: project.sampleRate,
          trackId: primaryTrack.id,
          speakerName: speakerLabel,
          filename: resolved.asset.name || 'studio-track.wav',
          decodePolicy: 'BALANCED',
          signal: transcribeAbort.signal,
          onProgress: (p) => {
            if (p.totalChunks > 1) {
              setStatusNotice(
                `در حال رونویسی با موتور شهاب — قطعه ${p.currentChunk} از ${p.totalChunks} (${p.percent}٪)...`,
              );
            }
          },
        });

        await refreshShahabRuntimeStatus(false);

        if (nextTokens.length === 0) {
          workflowRef.current?.setAsrState({
            state: 'NO_SPEECH_DETECTED',
            modelId: response.transcript.modelId,
            modelVersion: response.transcript.modelVersion,
            message: `موتور شهاب (${response.transcript.modelId}) گفتار فارسی قابل تشخیصی در این سیگنال صوتی پیدا نکرد.`,
          });
          setAsrInlineFeedback({
            kind: 'NO_SPEECH',
            titleFa: 'گفتار فارسی در این ترک صوتی تشخیص داده نشد',
            messageFa:
              'موتور شهاب (Zipformer INT8) صوت فعلی را پردازش کرد اما گفتار انسانی فارسی نیافت (پروژه پیش‌فرض دارای موج مصنوعی آزمایشی است). برای تست واقعی، دکمه «تست با نمونه صوت واقعی فارسی» را بزنید یا فایل صوتی خود را وارد کنید.',
          });
          setStatusNotice(
            `موتور شهاب گفتاری در این فایل تشخیص نداد (${response.transcript.modelId} | RTF=${response.metrics.realTimeFactor}).`,
          );
          return;
        }

        const beforeTokensSnapshot = cloneTokens(tokens);
        historyRef.current.commitTransaction({
          coalescingKey: '',
          type: 'restore-clip',
          description: `رونویسی محلی با موتور شهاب (${response.transcript.modelId})`,
          beforeTracks: tracks,
          afterTracks: tracks,
          beforeTokens: beforeTokensSnapshot,
          afterTokens: nextTokens,
          beforeRecommendations: recommendations,
          afterRecommendations: recommendations,
        });
        setTokens(nextTokens);
        syncWorkflowTranscript(nextTokens, `رونویسی محلی شهاب (${response.transcript.modelId})`);
        setHistoryTick((v) => v + 1);

        workflowRef.current?.setAsrState({
          state: 'TRANSCRIPTION_COMPLETED',
          modelId: response.transcript.modelId,
          modelVersion: response.transcript.modelVersion,
          message: `رونویسی با موتور شهاب انجام شد (${nextTokens.length} واژه | RTF=${response.metrics.realTimeFactor}).`,
        });
        setAsrInlineFeedback(null);
        setStatusNotice(
          `رونویسی موتور شهاب کامل شد (${nextTokens.length} واژه | ${response.transcript.modelId} | RTF=${response.metrics.realTimeFactor})`,
        );
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        workflowRef.current?.setAsrState({
          state: 'INFERENCE_FAILED',
          message: msg,
        });
        const classified = classifyError(err, { subsystem: 'ASR_RUNTIME' });
        getSharedDiagnosticLogger().log({
          severity: 'ERROR',
          subsystem: 'ASR_RUNTIME',
          code: 'SHAHAB_INFERENCE_FAILED',
          message: msg,
        });
        setActiveFailure(buildUserFacingFailure(classified, workflowState.locale));
        setAsrInlineFeedback({
          kind: 'INFERENCE_ERROR',
          titleFa: 'خطا در اجرای موتور شهاب',
          messageFa: msg,
        });
        setStatusNotice(`خطا در اجرای موتور شهاب: ${msg}`);
        return;
      } finally {
        if (activeShahabTranscribeAbortRef.current === transcribeAbort) {
          activeShahabTranscribeAbortRef.current = null;
        }
        setIsTranscribingAsr(false);
      }
    }

    const browserAdapter = new BrowserOnnxAsrRuntimeAdapter({
      modelManager: modelManagerRef.current,
      memoryBudgetManager: getSharedMemoryBudgetManager(),
      wasmAssetsBasePath: '/ort/',
    });
    const nativeAdapter = new NativeCompanionAsrRuntimeAdapter({
      companionClient: new CompanionWebClient(companionEndpoint),
      memoryBudgetManager: getSharedMemoryBudgetManager(),
    });

    if (!modelManagerRef.current.getSnapshot().initialized) {
      await modelManagerRef.current.initialize();
      syncModelSnapshotToWorkflow();
    }

    // If no local model is installed in browser OPFS yet and Companion is not active,
    // automatically provision and SHA-256-verify Shenava-Rizeh INT8 ONNX + tokens.txt.
    if (!modelManagerRef.current.getSnapshot().activeModel) {
      let companionAvailable = false;
      try {
        const cap = await nativeAdapter.probeCapabilities();
        companionAvailable = cap.available;
      } catch {
        companionAvailable = false;
      }

      if (!companionAvailable) {
        setIsInstallingBrowserModel(true);
        setBrowserModelInstallPct(0);
        setActiveFailure(null);
        setAsrInlineFeedback(null);
        setStatusNotice(
          'در حال نصب خودکار و راستی‌آزمایی مدل فارسی محلی در مرورگر (شناوا ریزه · ۳۶ مگابایت)...',
        );
        try {
          const installOutcome = await installShenavaRizehInBrowser({
            modelManager: modelManagerRef.current,
            onProgress: (pct, stage) => {
              setBrowserModelInstallPct(pct);
              const stageFa =
                stage === 'PREPARING'
                  ? 'آماده‌سازی فایل‌های مدل فارسی'
                  : stage === 'VERIFYING_TOKENS'
                    ? 'راستی‌آزمایی فایل واژگان tokens.txt'
                    : stage === 'STREAMING_ONNX'
                      ? 'دریافت و ذخیره مدل .onnx در OPFS مرورگر'
                      : 'تکمیل نصب مدل فارسی';
              setStatusNotice(`${stageFa} (${pct}٪)...`);
            },
          });
          syncModelSnapshotToWorkflow();

          if (!installOutcome.ok) {
            const msgFa =
              installOutcome.errorMessageFa ??
              'نصب خودکار مدل فارسی محلی ناموفق بود. می‌توانید فایل .onnx و tokens.txt را به‌صورت دستی وارد کنید.';
            workflowRef.current?.setAsrState({
              state: 'MODEL_NOT_INSTALLED',
              message: msgFa,
            });
            setAsrInlineFeedback({
              kind: 'MODEL_NOT_INSTALLED',
              titleFa: 'نصب خودکار مدل فارسی محلی ناموفق بود',
              messageFa: msgFa,
            });
            setActiveFailure(
              buildUserFacingFailure(
                classifyError(new Error('MODEL_NOT_INSTALLED'), { subsystem: 'ASR_MODEL' }),
                workflowState.locale,
              ),
            );
            setStatusNotice(msgFa);
            return;
          }
        } finally {
          setIsInstallingBrowserModel(false);
          setBrowserModelInstallPct(null);
        }
      }
    }

    const workflowService = new UnifiedLocalAsrWorkflowService({
      browserAdapter,
      nativeCompanionAdapter: nativeAdapter,
      modelManager: modelManagerRef.current,
    });

    const jobId = `studio_asr_${Date.now()}`;
    const speakerLabel = primaryTrack.speakerLabel || primaryTrack.name || 'گوینده ۱';
    const pcmData = resolved.pcm;

    setIsTranscribingAsr(true);
    setActiveFailure(null);
    setStatusNotice('در حال آماده‌سازی موتور ۱۰۰٪ محلی آواپرداز (مرورگر ONNX / Companion)...');

    try {
      const outcome = await workflowService.runTranscription({
        jobId,
        projectId: workflowState.projectId,
        trackId: primaryTrack.id,
        speakerName: speakerLabel,
        sourceAssetId: resolved.asset.id,
        sourceAssetSha256: workflowState.sourceAudio?.sourceAudioHash ?? resolved.asset.id,
        fileName: resolved.asset.name || 'studio-track.wav',
        sampleRate: project.sampleRate,
        totalSamples: pcmData.length,
        readSourceRange: async (startSample, count) => {
          const safeStart = Math.max(0, Math.min(pcmData.length, Math.floor(startSample)));
          const safeEnd = Math.max(safeStart, Math.min(pcmData.length, safeStart + Math.floor(count)));
          return pcmData.subarray(safeStart, safeEnd);
        },
        preference: 'AUTO_LOCAL',
        requestedCloudMode: false,
        languageHint: 'fa',
        onProgress: (ev) => {
          setStatusNotice(`${ev.messageFa} (${ev.percent}٪)`);
        },
      });

      if (!outcome.ok || !outcome.result) {
        const isNotInstalled = outcome.errorCode === 'MODEL_NOT_INSTALLED';
        workflowRef.current?.setAsrState({
          state: isNotInstalled ? 'MODEL_NOT_INSTALLED' : 'INFERENCE_FAILED',
          message: outcome.errorMessageFa ?? outcome.errorMessageEn ?? 'Local ASR failed.',
        });
        const err = classifyError(
          new Error(outcome.errorMessageEn ?? outcome.errorCode ?? 'LOCAL_ASR_FAILED'),
          { subsystem: isNotInstalled ? 'ASR_MODEL' : 'ASR_RUNTIME' },
        );
        getSharedDiagnosticLogger().log({
          severity: isNotInstalled ? 'INFO' : 'ERROR',
          subsystem: isNotInstalled ? 'ASR_MODEL' : 'ASR_RUNTIME',
          code: outcome.errorCode ?? 'LOCAL_ASR_FAILED',
          message: outcome.errorMessageEn ?? 'Local ASR execution could not proceed.',
        });
        setActiveFailure(buildUserFacingFailure(err, workflowState.locale));
        setAsrInlineFeedback({
          kind: isNotInstalled ? 'MODEL_NOT_INSTALLED' : 'INFERENCE_ERROR',
          titleFa: outcome.errorTitleFa ?? 'خطا در اجرای موتور محلی',
          messageFa: outcome.errorMessageFa ?? outcome.errorMessageEn ?? 'اجرای محلی ناموفق بود.',
        });
        setStatusNotice(outcome.errorTitleFa ?? 'اجرای موتور محلی ناموفق بود.');
        return;
      }

      const result = outcome.result;
      const nextTokens = outcome.tokens;

      if (nextTokens.length === 0) {
        workflowRef.current?.setAsrState({
          state: 'NO_SPEECH_DETECTED',
          modelId: result.modelId,
          modelVersion: result.modelVersion,
          message: `موتور محلی ${result.modelId} (${result.runtimeTarget}) گفتار انسانی قابل تشخیصی در این سیگنال صوتی پیدا نکرد.`,
        });
        setAsrInlineFeedback({
          kind: 'NO_SPEECH',
          titleFa: 'گفتاری توسط موتور محلی تشخیص داده نشد',
          messageFa: `موتور ${result.modelId} فایل صوتی را بررسی کرد اما کلمه گفتاری قابل تشخیصی نیافت. برای تست واقعی یک فایل گفتار فارسی وارد کنید.`,
        });
        setStatusNotice(
          `گفتاری در این فایل صوتی تشخیص داده نشد (${result.modelId} | RTF=${result.realTimeFactor}).`,
        );
        return;
      }

      const beforeTokensSnapshot = cloneTokens(tokens);
      historyRef.current.commitTransaction({
        coalescingKey: '',
        type: 'restore-clip',
        description: `رونویسی محلی عصبی (${result.modelId} / ${result.runtimeTarget})`,
        beforeTracks: tracks,
        afterTracks: tracks,
        beforeTokens: beforeTokensSnapshot,
        afterTokens: nextTokens,
        beforeRecommendations: recommendations,
        afterRecommendations: recommendations,
      });
      setTokens(nextTokens);
      syncWorkflowTranscript(nextTokens, `رونویسی محلی با ${result.modelId}`);
      setHistoryTick((v) => v + 1);

      workflowRef.current?.setAsrState({
        state: 'TRANSCRIPTION_COMPLETED',
        modelId: result.modelId,
        modelVersion: result.modelVersion,
        message: `رونویسی محلی با ${result.modelId} (${result.runtimeTarget}) انجام شد (${nextTokens.length} واژه | RTF=${result.realTimeFactor}).`,
      });
      setAsrInlineFeedback(null);
      setStatusNotice(
        `رونویسی ۱۰۰٪ محلی کامل شد (${nextTokens.length} واژه | ${result.modelId} | ${result.runtimeTarget} | RTF=${result.realTimeFactor})`,
      );
    } finally {
      await browserAdapter.dispose().catch(() => {});
      setIsTranscribingAsr(false);
    }
  };

  const handleInstallBrowserPersianModel = async (autoRunAfter = true) => {
    if (isInstallingBrowserModel || isTranscribingAsr) return;
    setIsInstallingBrowserModel(true);
    setBrowserModelInstallPct(0);
    setActiveFailure(null);
    setStatusNotice(
      'در حال نصب خودکار و راستی‌آزمایی مدل فارسی محلی در مرورگر (شناوا ریزه · ۳۶ مگابایت)...',
    );
    let installedOk = false;
    try {
      const res = await installShenavaRizehInBrowser({
        modelManager: modelManagerRef.current,
        onProgress: (pct) => {
          setBrowserModelInstallPct(pct);
          setStatusNotice(`در حال نصب مدل فارسی در مرورگر (${pct}٪)...`);
        },
      });
      syncModelSnapshotToWorkflow();
      if (res.ok) {
        installedOk = true;
        setAsrInlineFeedback(null);
        setStatusNotice(
          `مدل فارسی محلی (${res.modelId}) با ${res.tokenCount ?? 0} توکن نصب و تأیید شد.`,
        );
      } else {
        const msgFa =
          res.errorMessageFa ??
          'نصب خودکار مدل فارسی محلی ناموفق بود. لطفاً دوباره تلاش کنید یا فایل مدل را دستی وارد کنید.';
        setAsrInlineFeedback({
          kind: 'MODEL_NOT_INSTALLED',
          titleFa: 'نصب خودکار مدل فارسی محلی ناموفق بود',
          messageFa: msgFa,
        });
        setStatusNotice(msgFa);
      }
    } finally {
      setIsInstallingBrowserModel(false);
      setBrowserModelInstallPct(null);
    }

    if (installedOk && autoRunAfter) {
      await handleRunPersianAsr();
    }
  };

  const handleLoadAndTranscribeSamplePersianAudio = async () => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (isTranscribingAsr || isImportingAudio) return;

    setIsTranscribingAsr(true);
    setActiveFailure(null);
    setAsrInlineFeedback(null);
    setStatusNotice('در حال بارگذاری نمونه صوتی واقعی فارسی و اجرای موتور شهاب (Zipformer INT8)...');

    const sampleAbort = new AbortController();
    activeShahabTranscribeAbortRef.current?.abort();
    activeShahabTranscribeAbortRef.current = sampleAbort;

    try {
      const sampleFile = await fetchShahabSampleAudioFile(sampleAbort.signal);
      const loaded = await importAudioProject(sampleFile, {
        broker: brokerRef.current,
        brokerReady: brokerReadyPromiseRef.current,
        memoryBudgetManager: getSharedMemoryBudgetManager(),
        retainActivePcmMirror: true,
      });

      const primaryAsset = Object.values(loaded.assets)[0];
      const primaryTrack = loaded.tracks[0];
      const samplePcm = primaryAsset ? loaded.pcmSources[primaryAsset.id] : undefined;
      if (!primaryAsset || !primaryTrack || !samplePcm) {
        loaded.runtimeResourceLease?.dispose();
        throw new Error('بارگذاری داده‌های PCM فایل صوتی نمونه شهاب ناموفق بود.');
      }

      transportRef.current?.stop();
      setIsPlaying(false);
      projectResourceLeaseRef.current.replaceWith(loaded.runtimeResourceLease ?? null);
      historyRef.current = new TimelineHistoryManager();
      const nextTracks = cloneTracks(loaded.tracks);
      const nextRecs = cloneRecommendations(loaded.recommendations);
      setProject(loaded);
      setProjectSessionNonce((n) => n + 1);
      setTracks(nextTracks);
      setTokens([]);
      setRecommendations(nextRecs);
      setSelectedRecId(nextRecs[0]?.id ?? null);
      setSelection(null);
      setPlayheadSec(0);
      setEphemeralDsp(DEFAULT_DSP_PARAMS);
      setCommittedDsp(DEFAULT_DSP_PARAMS);
      setEqResponseCurveDb(null);
      setHistoryTick((v) => v + 1);

      setStatusNotice('فایل نمونه صوتی فارسی بارگذاری شد — در حال استنتاج با موتور شهاب (Zipformer INT8)...');

      const { response, tokens: nextTokens } = await transcribePcmWithShahabLocal({
        pcm: samplePcm,
        sampleRate: loaded.sampleRate,
        trackId: primaryTrack.id,
        speakerName: primaryTrack.speakerLabel || primaryTrack.name || 'گوینده فارسی',
        filename: sampleFile.name,
        decodePolicy: 'BALANCED',
        signal: sampleAbort.signal,
      });

      await refreshShahabRuntimeStatus(false);

      setTokens(nextTokens);
      syncWorkflowTranscript(nextTokens, `رونویسی شهاب روی نمونه صوتی فارسی (${response.transcript.modelId})`);
      workflowRef.current?.setAsrState({
        state: nextTokens.length > 0 ? 'TRANSCRIPTION_COMPLETED' : 'NO_SPEECH_DETECTED',
        modelId: response.transcript.modelId,
        modelVersion: response.transcript.modelVersion,
        message: `رونویسی شهاب انجام شد (${nextTokens.length} واژه | RTF=${response.metrics.realTimeFactor}).`,
      });
      setStatusNotice(
        `رونویسی موتور شهاب کامل شد (${nextTokens.length} واژه | ${response.transcript.modelId} | RTF=${response.metrics.realTimeFactor})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAsrInlineFeedback({
        kind: 'INFERENCE_ERROR',
        titleFa: 'خطا در اجرای نمونه صوتی با موتور شهاب',
        messageFa: msg,
      });
      setStatusNotice(`خطا در اجرای نمونه صوتی شهاب: ${msg}`);
    } finally {
      if (activeShahabTranscribeAbortRef.current === sampleAbort) {
        activeShahabTranscribeAbortRef.current = null;
      }
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

    projectResourceLeaseRef.current.replaceWith(recordedProject.runtimeResourceLease ?? null);
    setProject(recordedProject);
    setProjectSessionNonce((n) => n + 1);
    setTracks(cloneTracks(recordedProject.tracks));
    setTokens(cloneTokens(recordedProject.tokens));
    setRecommendations(cloneRecommendations(recordedProject.recommendations));
    setSelectedRecId(recordedProject.recommendations[0]?.id ?? null);
    setSelection(null);
    setPlayheadSec(0);
    setLoopSelection(globalSettings.playback.loopEnabledByDefault);
    if (globalSettings.workspace.resetZoomOnProjectOpen) {
      setZoom(1);
    }
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

    if (isImportingAudioRef.current) {
      setStatusNotice('عملیات ورود فایل صوتی دیگری در حال اجرا است؛ لطفاً تا تکمیل آن صبر کنید.');
      return;
    }

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

    const abortController = new AbortController();
    activeImportAbortRef.current = abortController;
    isImportingAudioRef.current = true;
    setIsImportingAudio(true);
    setActiveFailure(null);
    setStatusNotice('در حال ذخیره‌سازی جریانی و تحلیل آوایی فایل صوتی انتخاب‌شده...');

    try {
      const shouldRetainActiveMirror =
        file.size <= AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes;
      const loaded = await importAudioProject(file, {
        broker: brokerRef.current,
        brokerReady: brokerReadyPromiseRef.current,
        memoryBudgetManager: getSharedMemoryBudgetManager(),
        retainActivePcmMirror: shouldRetainActiveMirror,
        abortSignal: abortController.signal,
        onProgress: (progress) => {
          if (!isMountedRef.current || abortController.signal.aborted) return;
          if (progress.phase === 'persisting' && progress.percent % 20 === 0) {
            setStatusNotice(`در حال ذخیره‌سازی جریانی فایل صوتی (${progress.percent}٪)...`);
          }
        },
      });

      if (!isMountedRef.current || abortController.signal.aborted) {
        loaded.runtimeResourceLease?.dispose();
        return;
      }

      const primaryAsset = Object.values(loaded.assets)[0];
      const hasValidAudioBacking = Boolean(
        primaryAsset &&
          (loaded.pcmSources[primaryAsset.id] || primaryAsset.storageLifecycle === 'ready'),
      );
      if (!primaryAsset || !hasValidAudioBacking) {
        loaded.runtimeResourceLease?.dispose();
        throw new AudioImportCoordinatorError(
          'IMPORT_MANIFEST_INVALID',
          'Imported project is missing a verified primary asset or durable OPFS/resident audio backing.',
        );
      }

      // Transaction-safe activation commit: stop existing playback and replace lease/state
      // ONLY after full ingestion, OPFS manifest verification, and memory ownership succeed.
      transportRef.current?.stop();
      setIsPlaying(false);
      projectResourceLeaseRef.current.replaceWith(loaded.runtimeResourceLease ?? null);
      historyRef.current = new TimelineHistoryManager();
      setProject(loaded);
      setProjectSessionNonce((n) => n + 1);
      setTracks(cloneTracks(loaded.tracks));
      setTokens(cloneTokens(loaded.tokens));
      setRecommendations(cloneRecommendations(loaded.recommendations));
      setSelectedRecId(loaded.recommendations[0]?.id ?? null);
      setSelection(null);
      setPlayheadSec(0);
      setLoopSelection(globalSettings.playback.loopEnabledByDefault);
      if (globalSettings.workspace.resetZoomOnProjectOpen) {
        setZoom(1);
      }
      setAsrInlineFeedback(null);
      setEphemeralDsp(DEFAULT_DSP_PARAMS);
      setCommittedDsp(DEFAULT_DSP_PARAMS);
      setEqResponseCurveDb(null);
      setDetectedSyncOffsetMs(0);
      setDetectedClockDriftPpm(0);
      setHistoryTick((v) => v + 1);

      if (brokerRef.current && !brokerRef.current.isDisposed()) {
        setTelemetry(brokerRef.current.getTelemetry());
      }

      const persistenceBadge =
        primaryAsset.storageLifecycle === 'ready'
          ? `ذخیره‌سازی پایدار ${primaryAsset.storageBackend ?? 'OPFS'}`
          : 'حالت حافظه موقت (بدون OPFS)';

      setStatusNotice(
        `فایل «${file.name}» وارد شد (${persistenceBadge} • ${loaded.tokens.length} بخش آوایی و ${loaded.recommendations.length} پیشنهاد تدوین).`,
      );
    } catch (err) {
      if (!isMountedRef.current) return;

      if (brokerRef.current && !brokerRef.current.isDisposed()) {
        setTelemetry(brokerRef.current.getTelemetry());
      }

      if (err instanceof IngestAbortedError || abortController.signal.aborted) {
        setStatusNotice('ورود فایل صوتی متوقف شد و پروژه فعلی دست‌نخورده حفظ گردید.');
        return;
      }

      const msg = err instanceof Error ? err.message : '';
      const isMemoryPressure = err instanceof MemoryPressureError;
      const isStorageOrCoordinator =
        err instanceof IngestTransactionError || err instanceof AudioImportCoordinatorError;
      const classified = classifyError(err, {
        subsystem: isMemoryPressure || isStorageOrCoordinator ? 'AUDIO_IMPORT' : 'AUDIO_DECODE',
      });
      getSharedDiagnosticLogger().log({
        severity: 'WARNING',
        subsystem: isMemoryPressure || isStorageOrCoordinator ? 'AUDIO_IMPORT' : 'AUDIO_DECODE',
        code: isMemoryPressure
          ? err.code
          : isStorageOrCoordinator
            ? err.code
            : classified.code,
        message: isMemoryPressure
          ? 'Audio import rejected by application memory budget; previous session and reservation preserved.'
          : isStorageOrCoordinator
            ? 'Audio import storage/manifest verification failed; previous session preserved.'
            : 'Uploaded audio failed validation/decode; previous session preserved.',
      });
      setActiveFailure(buildUserFacingFailure(classified, workflowState.locale));
      if (isMemoryPressure) {
        setStatusNotice(
          'خطای سقف حافظه برنامه: فضای بودجه حافظه برای نگهداری این فایل صوتی در حافظه کافی نیست و پروژه فعلی دست‌نخورده حفظ شد.',
        );
      } else if (isStorageOrCoordinator) {
        setStatusNotice(
          'خطا در ذخیره‌سازی پایدار یا راستی‌آزمایی فایل صوتی؛ پروژه فعلی دست‌نخورده حفظ شد.',
        );
      } else if (msg.startsWith('SECURITY_')) {
        setStatusNotice(msg.replace(/^SECURITY_[A-Z_]+:\s*/, 'سپر امنیتی: '));
      } else {
        AudioSecurityGuard.sanitizeErrorForTelemetry(msg);
        setStatusNotice('خطا در دیکد فایل صوتی؛ فایل نامعتبر یا خراب است و پروژه فعلی دست‌نخورده باقی ماند.');
      }
    } finally {
      if (activeImportAbortRef.current === abortController) {
        activeImportAbortRef.current = null;
        isImportingAudioRef.current = false;
        if (isMountedRef.current) {
          setIsImportingAudio(false);
        }
      }
    }
  };

  const handleResetDemoProject = () => {
    transportRef.current?.stop();
    setIsPlaying(false);
    const fresh = buildDefaultPersianPodcastProject();
    projectResourceLeaseRef.current.clear();
    historyRef.current = new TimelineHistoryManager();
    setProject(fresh);
    setProjectSessionNonce((n) => n + 1);
    setTracks(cloneTracks(fresh.tracks));
    setTokens(cloneTokens(fresh.tokens));
    setRecommendations(cloneRecommendations(fresh.recommendations));
    setSelectedRecId(fresh.recommendations[0]?.id ?? null);
    setSelection(null);
    setPlayheadSec(0);
    setLoopSelection(globalSettings.playback.loopEnabledByDefault);
    if (globalSettings.workspace.resetZoomOnProjectOpen) {
      setZoom(1);
    }
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
    if (customMarkers.length > 0) {
      return [...customMarkers].sort((a, b) => a.startSec - b.startSec);
    }
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
  }, [customMarkers, prosodyAndChaptersReport, recommendations]);

  const handleAddMarkerAtPlayhead = useCallback(() => {
    const t = Number(playheadSec.toFixed(2));
    const idx = customMarkers.length + 1;
    const label =
      globalSettings.language.locale === 'fa'
        ? `نشانگر ${idx}`
        : `Marker ${idx}`;
    setCustomMarkers((prev) => [
      ...prev,
      { id: `mk_${Date.now()}_${idx}`, label, startSec: t },
    ]);
    setStatusNotice(
      globalSettings.language.locale === 'fa'
        ? `نشانگر «${label}» در ثانیه ${t.toFixed(2)} ثبت شد.`
        : `Marker "${label}" added at ${t.toFixed(2)}s.`,
    );
  }, [customMarkers.length, globalSettings.language.locale, playheadSec]);

  const handleRenameMarker = useCallback((markerId: string, nextLabel: string) => {
    setCustomMarkers((prev) =>
      prev.map((m) => (m.id === markerId ? { ...m, label: nextLabel } : m)),
    );
  }, []);

  const handleDeleteMarker = useCallback((markerId: string) => {
    setCustomMarkers((prev) => prev.filter((m) => m.id !== markerId));
  }, []);

  const handleStepBack = () => {
    handleSeekSec(Math.max(0, playheadSec - globalSettings.playback.seekStepSec));
  };

  const handleStepForward = () => {
    handleSeekSec(Math.min(totalDurationSec, playheadSec + globalSettings.playback.seekStepSec));
  };

  const handlePreviewSuggestionWithContext = (
    rec: SmartRecommendation,
    beforeSec: number,
    afterSec: number,
  ) => {
    const startSec = Math.max(0, flicksToSeconds(rec.boundary.snappedRange.startFlicks) - beforeSec);
    const endSec = Math.min(
      totalDurationSec,
      flicksToSeconds(rec.boundary.snappedRange.endFlicks) + afterSec,
    );
    if (endSec <= startSec + 0.05) {
      handlePreviewRecommendation(rec, 'before');
      return;
    }
    setPreviewingId(`${rec.id}-before`);
    handlePlaySelectionRange(
      {
        startSec,
        endSec,
        trackId: rec.trackId,
        scope: 'all',
      },
      { isPreview: true },
    );
  };

  const handleApplyApprovedBatch = (approvedRecs: readonly SmartRecommendation[]) => {
    if (isReadOnlyLocked) {
      setStatusNotice('ویرایش غیرفعال است: پروژه بدون قفل انحصاری در حالت فقط‌خواندنی قرار دارد.');
      return;
    }
    if (approvedRecs.length === 0) return;

    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const beforeTracksSnapshot = cloneTracks(tracks);
    const beforeTokensSnapshot = cloneTokens(tokens);
    const beforeRecsSnapshot = cloneRecommendations(recommendations);

    // Execute approved items in DESCENDING start timestamp order inside one undoable transaction
    let curTracks = cloneTracks(tracks);
    let curTokens = cloneTokens(tokens);
    let curRecs = cloneRecommendations(recommendations);
    let appliedCount = 0;

    const sorted = [...approvedRecs].sort(
      (a, b) => b.boundary.snappedRange.startFlicks - a.boundary.snappedRange.startFlicks,
    );

    for (const rec of sorted) {
      const liveRec = curRecs.find((r) => r.id === rec.id);
      if (!liveRec || (liveRec.status !== 'Pending' && liveRec.status !== 'Modified')) continue;
      const cutRange = liveRec.boundary.snappedRange;
      if (cutRange.endFlicks <= cutRange.startFlicks) continue;

      const mode = liveRec.recommendedMode;
      const tracksBeforeStep = curTracks;
      curTracks = applySyncSafeCut(tracksBeforeStep, liveRec.trackId, cutRange, mode);
      curTokens = projectTokensAfterCut(curTokens, tracksBeforeStep, liveRec.trackId, cutRange, mode);
      curRecs = projectRecommendationsAfterCut(
        curRecs,
        tracksBeforeStep,
        liveRec.trackId,
        cutRange,
        mode,
        liveRec.id,
      );
      appliedCount++;
    }

    if (appliedCount === 0) {
      setStatusNotice('هیچ پیشنهاد معتبری برای اعمال یافت نشد.');
      return;
    }

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type: 'sync-locked-ripple-cut',
      description: `اعمال برنامه تدوین (${appliedCount} پیشنهاد تأییدشده)`,
      beforeTracks: beforeTracksSnapshot,
      afterTracks: curTracks,
      beforeTokens: beforeTokensSnapshot,
      afterTokens: curTokens,
      beforeRecommendations: beforeRecsSnapshot,
      afterRecommendations: curRecs,
    });

    setTracks(curTracks);
    setTokens(curTokens);
    setRecommendations(curRecs);
    syncWorkflowTranscript(curTokens, `اعمال برنامه تدوین (${appliedCount} مورد)`, {
      targetTracks: curTracks,
    });
    persistDirtyCheckpointForCurrentState(curTracks);
    clampPlaybackAndSelectionToTracks(curTracks);
    setHistoryTick((v) => v + 1);
    setStatusNotice(`برنامه تدوین اعمال شد: ${appliedCount} پیشنهاد با قابلیت بازگشت (Undo).`);
  };

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

  // Audition DAW Keyboard Shortcuts — single stable window listener wired dynamically to GlobalSettings.shortcuts
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
      settingsModalOpen ||
      newProjectModalOpen ||
      lifecycleModalOpen ||
      asrLabOpen ||
      securityOpen;
    if (hasOpenModal || appView !== 'studio') {
      return;
    }

    const shortcuts = globalSettings.shortcuts;
    if (matchesShortcutBinding(e, shortcuts.openSettings)) {
      e.preventDefault();
      setSettingsModalOpen(true);
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.openExport)) {
      e.preventDefault();
      setRenderModalOpen(true);
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.undo)) {
      e.preventDefault();
      handleUndo();
      return;
    }
    if (
      matchesShortcutBinding(e, shortcuts.redo) ||
      ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y')
    ) {
      e.preventDefault();
      handleRedo();
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.playPause)) {
      e.preventDefault();
      handleTogglePlay();
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.seekBackward)) {
      e.preventDefault();
      handleStepBack();
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.seekForward)) {
      e.preventDefault();
      handleStepForward();
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.toggleLoop)) {
      e.preventDefault();
      handleToggleLoopSelection();
      return;
    }
    if (matchesShortcutBinding(e, shortcuts.clearSelection)) {
      setSelection(null);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Home') {
      e.preventDefault();
      handleStopAndReset();
    } else if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      handleSetInAtPlayhead();
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      handleSetOutAtPlayhead();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      handleAddMarkerAtPlayhead();
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keydownHandlerRef.current(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const effectiveTheme = resolveEffectiveTheme(globalSettings.appearance.theme);
  const currentLocale = globalSettings.language.locale;
  const isFa = currentLocale === 'fa';
  const showSuggestionsPanel = globalSettings.workspace.showSuggestionsPanel;
  const showFilesPanel = globalSettings.workspace.showFilesPanel;
  const hasAudioLoaded = tracks.length > 0 && totalDurationSec > 0;
  const hasTranscriptWords = tokens.length > 0;
  const pendingSuggestionsCount = recommendations.filter((r) => r.status === 'Pending').length;
  const acceptedSuggestionsCount = recommendations.filter((r) => r.status === 'Accepted').length;
  const asrStatusLabel = formatAsrShortStatus(workflowState.asrState, currentLocale);
  const asrReady =
    workflowState.asrState === 'MODEL_READY' ||
    workflowState.asrState === 'MODEL_AVAILABLE' ||
    workflowState.asrState === 'TRANSCRIPTION_COMPLETED' ||
    hasBrowserInstalledModel ||
    Boolean(shahabRuntimeStatus?.available);

  const headerWorkflowSteps: HeaderWorkflowStepItem[] = [
    {
      id: 'file',
      num: isFa ? '۱' : '1',
      label: isFa ? 'صوت' : 'Audio',
      done: hasAudioLoaded,
    },
    {
      id: 'transcribe',
      num: isFa ? '۲' : '2',
      label: isFa ? 'متن' : 'Text',
      done: hasTranscriptWords,
    },
    {
      id: 'review',
      num: isFa ? '۳' : '3',
      label: isFa ? 'بازبینی' : 'Review',
      done: acceptedSuggestionsCount > 0 && pendingSuggestionsCount === 0,
    },
    {
      id: 'export',
      num: isFa ? '۴' : '4',
      label: isFa ? 'خروجی' : 'Export',
      done: workflowState.exportStatus === 'SAVED_OR_DOWNLOADED',
    },
  ];

  const handleSelectWorkflowStep = (step: StudioWorkflowStepId) => {
    setActiveWorkflowStep(step);
    if (step === 'file') {
      setMobileStudioPane('files');
      setLeftRailCollapsed(false);
      setSideDockTab('files');
      setTrackHeightPx(124);
    } else if (step === 'transcribe') {
      setMobileStudioPane('center');
      setTrackHeightPx(50);
    } else if (step === 'review') {
      setMobileStudioPane('suggestions');
      setInspectorRequestedFocus('unified');
      setTrackHeightPx(82);
    } else if (step === 'export') {
      setRenderModalOpen(true);
    }
  };

  const handleOpenDeveloperViewFromSettings = (
    target: 'graph' | 'storage' | 'shahab' | 'asr-lab' | 'security' | 'lifecycle' | 'companion',
  ) => {
    setSettingsModalOpen(false);
    if (target === 'lifecycle') {
      setLifecycleInitialTab('health');
      setLifecycleModalOpen(true);
    } else if (target === 'companion') {
      setLifecycleInitialTab('companion');
      setLifecycleModalOpen(true);
    } else if (!isLabMode) {
      return;
    } else if (target === 'graph' || target === 'storage' || target === 'shahab') {
      setAppView('studio');
      setActiveTab(target);
    } else if (target === 'asr-lab') {
      setAsrLabOpen(true);
    } else if (target === 'security') {
      setSecurityOpen(true);
    }
  };

  return (
    <div
      dir={isFa ? 'rtl' : 'ltr'}
      className={
        appView === 'projects'
          ? 'min-h-screen flex flex-col bg-[var(--avp-bg)] text-[var(--avp-text)] overflow-x-hidden'
          : 'min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[var(--avp-bg)] text-[var(--avp-text)] overflow-x-hidden'
      }
    >
      {appView === 'projects' ? (
        <ProjectsHubView
          locale={currentLocale}
          theme={effectiveTheme}
          persianDigits={globalSettings.language.persianDigits}
          projects={hubProjects}
          isLoading={hubLoading}
          errorMessage={hubError}
          corruptedCount={hubCorruptedCount}
          onRetryLoad={() => void refreshProjectsHub()}
          onOpenNewProjectModal={() => setNewProjectModalOpen(true)}
          onOpenProject={(id) => void handleOpenHubProject(id)}
          onOpenSampleStudio={handleOpenSampleStudio}
          onRenameProject={handleRenameHubProject}
          onDuplicateProject={handleDuplicateHubProject}
          onDeleteProject={handleDeleteHubProject}
          onToggleTheme={handleToggleThemeQuick}
          onToggleLocale={() => handleToggleLocaleQuick()}
          onOpenSettings={() => setSettingsModalOpen(true)}
          onOpenLifecycleModal={() => {
            setLifecycleInitialTab('health');
            setLifecycleModalOpen(true);
          }}
        />
      ) : (
        <>
          {/* Hidden audio file input preserved for direct Studio import & E2E */}
          <input
            ref={fileInputRef}
            data-testid="audio-file-input"
            type="file"
            accept="audio/*"
            onChange={handleFileUpload}
            className="hidden"
            aria-label={isFa ? 'انتخاب فایل صوتی' : 'Select audio file'}
          />

          {/* 1. Unified 48px Studio Header (with embedded desktop 4-step stepper) */}
          <HeaderNav
            projectTitle={project.projectName}
            sampleRate={project.sampleRate}
            trackCount={tracks.length}
            wordCount={tokens.length}
            saveStatus={projectSaveStatus}
            activeTab={isLabMode ? activeTab : 'studio'}
            isLabMode={isLabMode}
            onSelectTab={(tab) => setActiveTab(isLabMode ? tab : 'studio')}
            onBackToProjects={() => void handleReturnToProjectsHub()}
            onOpenExport={() => setRenderModalOpen(true)}
            onOpenSettings={() => setSettingsModalOpen(true)}
            onOpenLifecycleModal={(tab) => {
              setLifecycleInitialTab(tab ?? 'health');
              setLifecycleModalOpen(true);
            }}
            onImportAudioClick={() => fileInputRef.current?.click()}
            workflowSteps={headerWorkflowSteps}
            activeWorkflowStep={activeWorkflowStep}
            onSelectWorkflowStep={handleSelectWorkflowStep}
            asrStatusLabel={asrStatusLabel}
            asrReady={asrReady}
            canUndo={historyRef.current.canUndo()}
            canRedo={historyRef.current.canRedo()}
            onUndo={handleUndo}
            onRedo={handleRedo}
            executionMode={executionMode}
            onChangeExecutionMode={handleChangeExecutionMode}
            theme={effectiveTheme}
            onToggleTheme={handleToggleThemeQuick}
            locale={currentLocale}
            persianDigits={globalSettings.language.persianDigits}
            onToggleLocale={handleToggleLocaleQuick}
          />

          {/* 2. Mobile-only Compact Stepper + Honest Failure Banner (Zero desktop chrome tax) */}
          <WorkflowStageBar
            workflowState={workflowState}
            executionMode={executionMode}
            cloudProviderStatusLabel={
              isFa ? 'سیاست ۱۰۰٪ محلی فعال' : '100% Local-Only Policy'
            }
            cloudAsrConfigured={cloudAsrConfigured}
            hasAudioLoaded={hasAudioLoaded}
            hasTranscriptWords={hasTranscriptWords}
            pendingSuggestionsCount={pendingSuggestionsCount}
            acceptedSuggestionsCount={acceptedSuggestionsCount}
            activeStep={activeWorkflowStep}
            onSelectStep={handleSelectWorkflowStep}
            activeFailure={activeFailure}
            canInstallPwa={canInstallPwa}
            onTriggerInstallPwa={() => void triggerInstallPwa()}
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
            persianDigits={globalSettings.language.persianDigits}
          />

          {/* Inline Full-Bleed Status Strip (only when active) */}
          {statusNotice && (
            <div
              role="status"
              data-testid="studio-status-notice"
              className="px-4 py-1.5 border-b border-[var(--avp-accent)]/25 bg-[var(--avp-accent-soft)]/70 text-xs text-[var(--avp-text)] flex items-center justify-between gap-3 shrink-0"
            >
              <span className="truncate">{statusNotice}</span>
              <button
                type="button"
                onClick={() => setStatusNotice(null)}
                className="text-[var(--avp-accent-text)] font-medium hover:underline cursor-pointer shrink-0"
              >
                {isFa ? 'بستن' : 'Dismiss'}
              </button>
            </div>
          )}

          {/* 3. Main Edge-to-Edge Split-Pane Studio Workspace (Reserved bottom space for docked Transport) */}
          <main className="flex-1 min-h-0 w-full flex flex-col pb-[108px] sm:pb-[64px] lg:pb-[56px]">
            {(!isLabMode || activeTab === 'studio') && (
              <>
                {/* Mobile/Tablet Compact Pane Switcher */}
                <div className="flex lg:hidden items-center px-3 py-1.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="avp-segmented w-full">
                    {(
                      [
                        { id: 'center', label: isFa ? 'تایملاین و متن' : 'Timeline & Text' },
                        { id: 'suggestions', label: isFa ? 'پیشنهادها' : 'Suggestions' },
                        { id: 'files', label: isFa ? 'فایل‌ها و افکت' : 'Files & DSP' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setMobileStudioPane(tab.id)}
                        aria-pressed={mobileStudioPane === tab.id}
                        className="avp-segmented-item flex-1"
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Full-Bleed Native Desktop 3-Pane Split Workspace (Hairline 1px Dividers)
                    Start/Right: Unified AI & Editorial Inspector
                    Center (flex-1 dominant): Audio Timeline + 6px Interactive Split Sash + Editorial Transcript
                    End/Left: Files, Tracks, Effects & Markers */}
                <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
                  {/* Pane 1 (Right in RTL): Unified AI & Editorial Inspector */}
                  {showSuggestionsPanel && (
                    <div
                      className={`lg:w-[288px] xl:w-[348px] shrink-0 min-w-0 lg:h-full lg:border-e border-[var(--avp-border)] bg-[var(--avp-surface)] ${
                        mobileStudioPane === 'suggestions'
                          ? 'flex flex-col'
                          : 'hidden lg:flex lg:flex-col'
                      }`}
                    >
                      <UnifiedEditorialInspector
                        recommendations={recommendations}
                        selectedRecId={selectedRecId}
                        previewingId={previewingId}
                        tracks={tracks}
                        assets={project.assets}
                        pcmSources={project.pcmSources}
                        tokens={tokens}
                        sampleRate={project.sampleRate}
                        totalDurationSec={totalDurationSec}
                        locale={currentLocale}
                        persianDigits={globalSettings.language.persianDigits}
                        timecodeFormat={globalSettings.language.timecodeFormat}
                        contextBeforeSec={globalSettings.playback.contextBeforeSec}
                        contextAfterSec={globalSettings.playback.contextAfterSec}
                        defaultCategory={globalSettings.suggestions.defaultCategory}
                        defaultSort={globalSettings.suggestions.defaultSort}
                        showContextTranscript={globalSettings.suggestions.showContextTranscript}
                        confirmBeforeApply={globalSettings.suggestions.confirmBeforeApply}
                        autoExpandDetails={globalSettings.suggestions.autoExpandDetails}
                        focusNextAfterReview={globalSettings.suggestions.focusNextAfterReview}
                        speechEventResult={workflowState.speechEventResult}
                        edlSnapshot={workflowState.edlSnapshot}
                        isAnalyzingEdl={workflowState.isAnalyzingEvents}
                        canUndoEdl={workflowState.edlUndoStack.length > 0}
                        canRedoEdl={workflowState.edlRedoStack.length > 0}
                        requestedFocus={inspectorRequestedFocus}
                        onSelectSuggestion={(id) => setSelectedRecId(id)}
                        onPreviewSuggestion={handlePreviewRecommendation}
                        onPreviewSuggestionWithContext={handlePreviewSuggestionWithContext}
                        onAcceptSuggestion={handleAcceptRecommendation}
                        onApplyApprovedBatch={handleApplyApprovedBatch}
                        onRejectSuggestion={handleRejectRecommendation}
                        onNudgeSuggestionBoundary={handleNudgeBoundary}
                        onJumpToRange={(startSec, endSec, trackId) => {
                          setSelection(
                            clampSelectionRange({
                              startSec,
                              endSec,
                              trackId,
                              scope: 'all',
                            }),
                          );
                          handleSeekSec(startSec);
                        }}
                        onRescanDeepDisfluencies={handleRescanDeepDisfluencies}
                        onSoftenBreathsAndCoughs={handleSoftenBreathsAndCoughs}
                        onRunEdlAnalysis={handleRunMissionEdlAnalysis}
                        onApproveEdlProposal={(proposalId) => {
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
                        onRejectEdlProposal={(proposalId) => {
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
                        onRequestReviewEdlProposal={(proposalId) => {
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
                        onReviseEdlBoundaryMs={(proposalId, dStartMs, dEndMs) => {
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
                        onPreviewEdlProposal={handlePreviewEdlProposal}
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
                        onApplyLinguisticBatchUpdates={handleBatchUpdateTokenDisplayTexts}
                      />
                    </div>
                  )}

                  {/* Pane 2 (Center Dominant): Locked Split Container -> Audio Timeline + 6px Split Sash + Editorial Transcript */}
                  <div
                    className={`flex-1 min-w-0 lg:h-full lg:overflow-hidden bg-[var(--avp-surface)] ${
                      mobileStudioPane === 'center' ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
                    }`}
                  >
                    <WaveformCanvas
                      tracks={tracks}
                      assets={project.assets}
                      pcmSources={project.pcmSources}
                      recommendations={recommendations}
                      selectedRecId={selectedRecId}
                      playheadSec={playheadSec}
                      totalDurationSec={totalDurationSec}
                      zoom={zoom}
                      locale={currentLocale}
                      showGrid={globalSettings.appearance.showWaveformGrid}
                      showRuler={globalSettings.workspace.showTimelineRuler}
                      showMarkers={globalSettings.workspace.showTimelineMarkers}
                      showEditRegions={globalSettings.workspace.showEditRegions}
                      markers={auditionMarkers}
                      onZoomChange={setZoom}
                      onSeekSec={handleSeekSec}
                      onToggleTrackMute={handleToggleTrackMute}
                      onToggleTrackSolo={handleToggleTrackSolo}
                      onSelectRecommendation={(id) => setSelectedRecId(id)}
                      onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
                      onSplitAtPlayhead={handleSplitAtPlayhead}
                      onCutWaveformRange={handleCutWaveformRange}
                      detectedSyncOffsetMs={detectedSyncOffsetMs}
                      detectedClockDriftPpm={detectedClockDriftPpm}
                      onAutoAlignSyncedTracks={handleAutoAlignSyncedTracks}
                      onNudgeSyncedTracksMs={handleNudgeSyncedTracksMs}
                      selection={selection}
                      onSelectionChange={(nextSel) => setSelection(clampSelectionRange(nextSel))}
                      onPlaySelectionRange={(sel) => handlePlaySelectionRange(clampSelectionRange(sel))}
                      trackHeightPx={trackHeightPx}
                      onTrackHeightChange={setTrackHeightPx}
                    />

                    {/* 6px Interactive Horizontal Split Sash (P0-3) */}
                    <div
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label={isFa ? 'تغییر ارتفاع تایملاین و بوم متن' : 'Resize timeline and transcript split'}
                      data-testid="center-split-sash"
                      onMouseDown={handleStartSplitSashDrag}
                      onDoubleClick={() => setTrackHeightPx(82)}
                      title={
                        isFa
                          ? 'کشیدن برای تنظیم نسبت تایملاین و متن (دابل‌کلیک: بازنشانی به 30/70)'
                          : 'Drag to resize timeline/transcript split (Double-click: reset 30/70)'
                      }
                      className="hidden lg:flex avp-split-sash"
                    >
                      <span className="avp-split-sash-pill" />
                    </div>

                    <TranscriptPanel
                      tokens={tokens}
                      tracks={tracks}
                      pcmSources={project.pcmSources}
                      sampleRate={project.sampleRate}
                      playheadSec={playheadSec}
                      totalDurationSec={totalDurationSec}
                      locale={currentLocale}
                      persianDigits={globalSettings.language.persianDigits}
                      timecodeFormat={globalSettings.language.timecodeFormat}
                      showTimestamps={true}
                      autoFollowPlayhead={true}
                      timelineSelection={selection}
                      onSyncTimelineSelection={(nextSel) => setSelection(clampSelectionRange(nextSel))}
                      onPlaySelectionRange={(sel) => handlePlaySelectionRange(clampSelectionRange(sel))}
                      isTranscribingAsr={isTranscribingAsr}
                      hasBrowserInstalledModel={hasBrowserInstalledModel}
                      shahabRuntimeStatus={shahabRuntimeStatus}
                      isInstallingBrowserModel={isInstallingBrowserModel}
                      browserModelInstallPct={browserModelInstallPct}
                      executionMode={executionMode}
                      cloudAsrConfigured={cloudAsrConfigured}
                      projectSessionNonce={projectSessionNonce}
                      asrInlineFeedback={asrInlineFeedback}
                      onDismissAsrInlineFeedback={() => setAsrInlineFeedback(null)}
                      onInstallBrowserPersianModel={handleInstallBrowserPersianModel}
                      onLoadAndTranscribeSamplePersianAudio={handleLoadAndTranscribeSamplePersianAudio}
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
                  </div>

                  {/* Pane 3 (Left in RTL): Collapsible & Adaptive Files / DSP Effects / History Rail */}
                  {showFilesPanel && (
                    <div
                      className={`${
                        leftRailCollapsed
                          ? 'lg:w-[48px]'
                          : sideDockTab === 'effects'
                            ? 'lg:w-[264px] xl:w-[312px]'
                            : 'lg:w-[232px] xl:w-[248px]'
                      } shrink-0 min-w-0 lg:h-full lg:border-s border-[var(--avp-border)] bg-[var(--avp-surface)] transition-[width] duration-150 flex flex-col`}
                    >
                      <AuditionSideDock
                        tracks={tracks}
                        assets={project.assets}
                        sampleRate={project.sampleRate}
                        history={historyRef.current.getHistory()}
                        markers={auditionMarkers}
                        locale={currentLocale}
                        persianDigits={globalSettings.language.persianDigits}
                        timecodeFormat={globalSettings.language.timecodeFormat}
                        collapsed={leftRailCollapsed}
                        activeDockTab={sideDockTab}
                        onDockTabChange={setSideDockTab}
                        onToggleCollapse={() => setLeftRailCollapsed((v) => !v)}
                        onImportAudioClick={() => fileInputRef.current?.click()}
                        onSeekSec={handleSeekSec}
                        onToggleTrackMute={handleToggleTrackMute}
                        onToggleTrackSolo={handleToggleTrackSolo}
                        onAddMarker={handleAddMarkerAtPlayhead}
                        onRenameMarker={handleRenameMarker}
                        onDeleteMarker={handleDeleteMarker}
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
                          <DspControlRack
                            ephemeralParams={ephemeralDsp}
                            committedParams={committedDsp}
                            isGestureActive={isGestureActive}
                            sampleRate={project.sampleRate}
                            locale={currentLocale}
                            persianDigits={globalSettings.language.persianDigits}
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
                        }
                      />
                    </div>
                  )}
                </div>
              </>
            )}

            {isLabMode && activeTab === 'graph' && (
              <div className="flex-1 min-h-0 overflow-y-auto max-w-[1440px] w-full mx-auto px-4 py-4">
                <ProcessingGraphView
                  nodes={graphNodes}
                  edges={defaultGraph.edges}
                  sampleRate={project.sampleRate}
                  resamplerStats={project.resamplerStats}
                  onToggleNodeBypass={handleToggleNodeBypass}
                />
              </div>
            )}

            {isLabMode && activeTab === 'storage' && (
              <div className="flex-1 min-h-0 overflow-y-auto max-w-[1440px] w-full mx-auto px-4 py-4">
                <StorageBrokerView
                  capabilities={capabilities}
                  telemetry={telemetry}
                  assets={project.assets}
                  isTestingLru={isTestingLru}
                  onRunBrokerConcurrencyTest={handleRunBrokerConcurrencyTest}
                  onSimulateLruCacheFill={handleSimulateLruCacheFill}
                />
              </div>
            )}

            {isLabMode && activeTab === 'shahab' && (
              <div className="flex-1 min-h-0 overflow-y-auto max-w-[1440px] w-full mx-auto px-4 py-4">
                <ShahabLabView />
              </div>
            )}
          </main>

          {/* 4. Docked Bottom Studio Audio Transport Bar */}
          <AuditionTransportBar
            isPlaying={isPlaying}
            hasAudio={tracks.length > 0 && totalDurationSec > 0}
            isPreviewMode={Boolean(previewingId)}
            previewLabel={isFa ? 'پیش‌شنوایی پیشنهاد' : 'Previewing Suggestion'}
            playheadSec={playheadSec}
            totalDurationSec={totalDurationSec}
            selection={selection}
            loopSelection={loopSelection}
            playbackRate={playbackRate}
            seekStepSec={globalSettings.playback.seekStepSec}
            peakDb={meterDb.peakDb}
            rmsDb={meterDb.rmsDb}
            locale={currentLocale}
            timecodeFormat={globalSettings.language.timecodeFormat}
            persianDigits={globalSettings.language.persianDigits}
            onTogglePlay={handleTogglePlay}
            onPlaySelection={() => handlePlaySelectionRange(selection)}
            onStopAndReset={handleStopAndReset}
            onExitPreview={handleStopAndReset}
            onSeekSec={handleSeekSec}
            onStepBack={handleStepBack}
            onStepForward={handleStepForward}
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
            locale={currentLocale}
            persianDigits={globalSettings.language.persianDigits}
            projectTitle={project.projectName}
            projectSampleRate={(project.sampleRate as SampleRate) || 48000}
            totalDurationSec={totalDurationSec}
            tracks={tracks}
            assets={project.assets}
            tokens={tokens}
            markers={auditionMarkers}
            defaultFormat={globalSettings.exportDefaults.format}
            defaultSampleRate={
              globalSettings.exportDefaults.sampleRate === 'source'
                ? (project.sampleRate as SampleRate) || 48000
                : globalSettings.exportDefaults.sampleRate
            }
            defaultCrossfadeMs={globalSettings.exportDefaults.defaultCrossfadeMs}
            defaultFilenamePrefix={globalSettings.exportDefaults.filenamePrefix}
            onStartRender={handleStartMission06Render}
            onPauseRender={() => workflowRef.current?.requestPauseRender()}
            onCancelRender={() => workflowRef.current?.cancelRender()}
            onMarkDownloaded={(fileName) => workflowRef.current?.markExportSaved(fileName)}
          />

          {isLabMode && (
            <>
              <AsrResearchLabModal
                isOpen={asrLabOpen}
                onClose={() => setAsrLabOpen(false)}
                studioPcm={
                  project.pcmSources[tracks[0]?.clips[0]?.assetId ?? Object.keys(project.pcmSources)[0]] ??
                  null
                }
                studioSampleRate={project.sampleRate}
                referenceTranscript={tokens.map((t) => t.displayText).join(' ')}
                modelManager={modelManagerRef.current}
              />

              <SpeechSecurityModal
                isOpen={securityOpen}
                onClose={() => setSecurityOpen(false)}
              />
            </>
          )}
        </>
      )}

      {/* Shared Application Modals across Projects Hub & Studio */}
      <NewProjectModal
        isOpen={newProjectModalOpen}
        locale={currentLocale}
        onClose={() => setNewProjectModalOpen(false)}
        onCreateProject={handleCreateHubProject}
      />

      <SettingsCenterModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        settings={globalSettings}
        onUpdateSettings={handleUpdateGlobalSettings}
        saveStatus={settingsSaveStatus}
        saveError={settingsSaveError}
        onOpenDeveloperView={handleOpenDeveloperViewFromSettings}
      />

      <LifecycleManagementModal
        isOpen={lifecycleModalOpen}
        initialTab={lifecycleInitialTab}
        onClose={() => setLifecycleModalOpen(false)}
        workflowState={workflowState}
        modelManager={modelManagerRef.current}
        onModelStateChanged={syncModelSnapshotToWorkflow}
        companionEndpoint={companionEndpoint}
        onChangeCompanionEndpoint={handleChangeCompanionEndpoint}
      />
    </div>
  );
}
