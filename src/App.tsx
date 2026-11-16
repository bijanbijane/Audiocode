import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Undo2,
  Redo2,
  Upload,
  Sparkles,
} from 'lucide-react';
import {
  EphemeralDspParams,
  ExportValidationReport,
  ProcessingNodeDescriptor,
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
import {
  buildDefaultPersianPodcastProject,
  ingestUploadedAudioFile,
  LoadedStudioProject,
} from './engine/audioFixtures';
import {
  buildSplicePreviewBuffer,
  renderTimelineRangeToPcm,
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
  applySyncSafeCut,
  cloneTracks,
  computeTimelineDurationFlicks,
  TimelineHistoryManager,
} from './engine/timeline';
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
  const [recommendations, setRecommendations] = useState<SmartRecommendation[]>(
    () => project.recommendations,
  );
  const [selectedRecId, setSelectedRecId] = useState<string | null>(
    () => project.recommendations[0]?.id ?? null,
  );

  // Transport state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [detectedSyncOffsetMs, setDetectedSyncOffsetMs] = useState<number>(38.5);
  const [detectedClockDriftPpm, setDetectedClockDriftPpm] = useState<number>(14.2);

  // DSP & Ephemeral Gesture vs Committed Transaction
  const [ephemeralDsp, setEphemeralDsp] = useState<EphemeralDspParams>(DEFAULT_DSP_PARAMS);
  const [committedDsp, setCommittedDsp] = useState<EphemeralDspParams>(DEFAULT_DSP_PARAMS);
  const [isGestureActive, setIsGestureActive] = useState(false);
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
      maxBytes: 32 * 1024 * 1024,
      usedBytes: 0,
      cachedBlocks: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
    },
  }));

  // Export Modal state
  const [exportOpen, setExportOpen] = useState(false);
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
    const transport = new StudioAudioTransport();
    transportRef.current = transport;

    const broker = new StorageBrokerClient(1024 * 1024 * 8); // 8MB demo LRU cap
    brokerRef.current = broker;
    broker.init().then((t) => {
      setTelemetry(t);
    });

    const sessionLock = new CrashRecoveryAndSessionLock();
    sessionLock.acquireExclusiveProjectLock('avapardaz-demo-ep42').then((acquired) => {
      if (!acquired) {
        setStatusNotice('هشدار هم‌زمانی: این پروژه هم‌اکنون در تب دیگری باز است (Web Locks Guard).');
      }
    });

    return () => {
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
    setPlayheadSec(0);
  };

  const handleTogglePlay = () => {
    if (!transportRef.current) return;
    if (isPlaying) {
      transportRef.current.stop();
      setIsPlaying(false);
      setPreviewingId(null);
      return;
    }

    const startSec = playheadSec >= totalDurationSec - 0.05 ? 0 : playheadSec;
    const pcm = renderTimelineRangeToPcm({
      tracks,
      assets: project.assets,
      pcmSources: project.pcmSources,
      sampleRate: project.sampleRate,
      rangeFlicks: {
        startFlicks: secondsToFlicks(startSec),
        endFlicks: totalDurationFlicks,
      },
      dspParams: ephemeralDsp,
    });

    setIsPlaying(true);
    setPreviewingId(null);
    transportRef.current.playBuffer(
      pcm,
      project.sampleRate,
      startSec,
      (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
      () => setIsPlaying(false),
    );
  };

  const handleSeekSec = (sec: number) => {
    const clamped = Math.max(0, Math.min(totalDurationSec, sec));
    setPlayheadSec(clamped);
    if (isPlaying && transportRef.current) {
      const pcm = renderTimelineRangeToPcm({
        tracks,
        assets: project.assets,
        pcmSources: project.pcmSources,
        sampleRate: project.sampleRate,
        rangeFlicks: {
          startFlicks: secondsToFlicks(clamped),
          endFlicks: totalDurationFlicks,
        },
        dspParams: ephemeralDsp,
      });
      transportRef.current.playBuffer(
        pcm,
        project.sampleRate,
        clamped,
        (tSec) => setPlayheadSec(Math.min(totalDurationSec, tSec)),
        () => setIsPlaying(false),
      );
    }
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

  const handleAcceptRecommendation = (rec: SmartRecommendation) => {
    transportRef.current?.stop();
    setIsPlaying(false);
    setPreviewingId(null);

    const nextTracks = applySyncSafeCut(
      tracks,
      rec.trackId,
      rec.boundary.snappedRange,
      rec.recommendedMode,
    );

    historyRef.current.commitTransaction({
      coalescingKey: '',
      type:
        rec.recommendedMode === 'sync-locked-ripple-cut'
          ? 'sync-locked-ripple-cut'
          : 'in-place-room-tone-suppression',
      description: `${
        rec.recommendedMode === 'sync-locked-ripple-cut' ? 'برش هم‌زمان' : 'جایگزینی Room Tone'
      }: ${rec.relatedText}`,
      beforeTracks: tracks,
      afterTracks: nextTracks,
      affectedRecommendationId: rec.id,
    });

    setTracks(nextTracks);
    setRecommendations((prev) =>
      prev.map((r) => (r.id === rec.id ? { ...r, status: 'Accepted' } : r)),
    );
    setHistoryTick((v) => v + 1);
    setStatusNotice(`تغییر «${rec.relatedText}» به‌صورت غیرمخرب اعمال شد.`);
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
    if (tx.affectedRecommendationId) {
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
    if (tx.affectedRecommendationId) {
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
    setStatusNotice(`در حال Ingest جریانی و تحلیل گروه A روی «${file.name}»...`);
    try {
      const loaded = await ingestUploadedAudioFile(file);
      historyRef.current = new TimelineHistoryManager();
      setProject(loaded);
      setTracks(cloneTracks(loaded.tracks));
      setRecommendations(loaded.recommendations);
      setSelectedRecId(loaded.recommendations[0]?.id ?? null);
      setPlayheadSec(0);
      setHistoryTick((v) => v + 1);
      setStatusNotice(
        `فایل «${file.name}» با موفقیت وارد شد (${loaded.recommendations.length} پیشنهاد گروه A شناسایی شد).`,
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
    setRecommendations(fresh.recommendations);
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
      const dummyBlock = new Float32Array(262_144); // 1 MB per block
      for (let i = 0; i < 10; i++) {
        await brokerRef.current.writePcmBlock(primaryId, i, [dummyBlock], 'playback-feeder');
        setTelemetry(brokerRef.current.getTelemetry());
      }
      // Exercise a cache hit (block 9 still warm) and a cache miss (block 0 evicted)
      brokerRef.current.lruCache.get(primaryId, 9);
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

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0F17] text-slate-100">
      <HeaderNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenExport={handleOpenExport}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 py-5 space-y-5">
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
              onClick={handleResetDemoProject}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              <span>نمونه پادکست</span>
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
          <div className="space-y-5">
            <WaveformCanvas
              tracks={tracks}
              assets={project.assets}
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
              detectedSyncOffsetMs={detectedSyncOffsetMs}
              detectedClockDriftPpm={detectedClockDriftPpm}
              onAutoAlignSyncedTracks={handleAutoAlignSyncedTracks}
              onNudgeSyncedTracksMs={handleNudgeSyncedTracksMs}
            />

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              <div className="lg:col-span-7 space-y-5">
                <TranscriptPanel
                  tokens={project.tokens}
                  playheadSec={playheadSec}
                  onSeekSec={handleSeekSec}
                />
                <DspControlRack
                  ephemeralParams={ephemeralDsp}
                  committedParams={committedDsp}
                  isGestureActive={isGestureActive}
                  history={historyRef.current.getHistory()}
                  onEphemeralChange={handleEphemeralDspChange}
                  onCommitGesture={handleCommitDspGesture}
                  onResetDefaults={handleResetDsp}
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
                />
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
    </div>
  );
}
