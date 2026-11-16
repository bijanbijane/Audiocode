import React, { useEffect, useRef, useState } from 'react';
import {
  DeviceTier,
  ResilientAiRuntimeManager,
} from '../../runtime/ResilientAiRuntime';
import {
  EmpiricalHardwareProfile,
  HardwareBenchmarkProfiler,
} from '../../runtime/HardwareBenchmarkProfiler';
import { CrashRecoveryAndSessionLock } from '../../runtime/CrashRecoveryAndSessionLock';
import { ProjectDocument, RecommendationId } from '../../contracts/project-schema.contract';
import { TimeMath } from '../../contracts/timebase.contract';
import { DesktopAudioStudioApp } from '../desktop/DesktopAudioStudioApp';
import { MobileCompanionWorkspace } from '../mobile/MobileCompanionWorkspace';
import { OfflineIndicator, PWAInstallButton } from '../pwa/PWAInstallControls';
import { PersianTextNormalizer } from '../../ai-engine/PersianTextNormalizer';
import { LodWaveformCanvasRenderer, WaveformLodBuffer } from '../waveform/LodWaveformCanvasRenderer';

function createDemoSpeechWaveformLod(durationSeconds = 12, sampleRate = 48000): WaveformLodBuffer {
  const samplesPerPeak = 256 as const;
  const totalPeaks = Math.ceil((durationSeconds * sampleRate) / samplesPerPeak);
  const interleavedMinMaxInt8 = new Int8Array(totalPeaks * 2);

  for (let i = 0; i < totalPeaks; i++) {
    const t = (i * samplesPerPeak) / sampleRate;
    const isFiller = t >= 1.08 && t <= 1.62;
    const isStretch = t >= 3.45 && t <= 3.92;
    const isLongPause = t >= 4.41 && t <= 5.52;

    let amp = 0.25 + 0.55 * Math.abs(Math.sin(t * 7.3) * Math.cos(t * 2.9));
    if (isFiller) amp = 0.36;
    if (isStretch) amp = 0.68;
    if (isLongPause) amp = 0.04;

    const scaled = Math.max(2, Math.min(122, Math.round(amp * 110)));
    interleavedMinMaxInt8[i * 2] = -scaled;
    interleavedMinMaxInt8[i * 2 + 1] = scaled;
  }

  return { samplesPerPeak, interleavedMinMaxInt8 };
}

const DEMO_WAVEFORM_LOD = createDemoSpeechWaveformLod(12, 48000);

export const INITIAL_DEMO_PROJECT: ProjectDocument = {
  projectId: 'proj_persian_studio_default',
  name: 'پادکست فناوری فارسی - اپیزود اول',
  canonicalSampleRate: 48000,
  versions: {
    projectSchemaVersion: 2,
    audioEngineVersion: '1.2.0',
    processingNodeCatalogVersion: '1.0.0',
    activeModelBundleVersion: '1.2.0',
  },
  revision: 1,
  tracks: [
    {
      id: 'trk_1',
      name: 'میزبان اصلی',
      syncGroupId: 'sync_main',
      speakerId: 'SPEAKER_1',
      muted: false,
      solo: false,
      clips: [
        {
          id: 'clip_1',
          trackId: 'trk_1',
          kind: 'AUDIO_ASSET',
          assetId: 'asset_demo_1',
          sourceRange: { start: 0, end: TimeMath.secondsToFlicks(12) },
          timelineRange: { start: 0, end: TimeMath.secondsToFlicks(12) },
          fadeInFlicks: TimeMath.secondsToFlicks(0.01),
          fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
          gainDb: 0,
        },
      ],
    },
  ],
  recommendations: [
    {
      id: 'rec_demo_filler',
      targetTrackId: 'trk_1',
      disfluencyType: 'INDEPENDENT_FILLER',
      associatedText: '«اممم»',
      status: 'PENDING',
      createdAtProjectRevision: 1,
      spliceDescriptor: {
        rawAiRange: { start: TimeMath.secondsToFlicks(1.1), end: TimeMath.secondsToFlicks(1.6) },
        snappedAcousticRange: {
          start: TimeMath.secondsToFlicks(1.08),
          end: TimeMath.secondsToFlicks(1.62),
        },
        fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
        fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
        injectRoomToneFlicks: 0,
        cutStrategy: 'GLOBAL_SYNC_RIPPLE',
        prosodicWarnings: [],
        confidence: 0.93,
      },
    },
    {
      id: 'rec_demo_stretch',
      targetTrackId: 'trk_1',
      disfluencyType: 'COARTICULATED_STRETCH',
      associatedText: 'تپق کشیده متصل به «رفتیممممم»',
      status: 'PENDING',
      createdAtProjectRevision: 1,
      spliceDescriptor: {
        rawAiRange: { start: TimeMath.secondsToFlicks(3.48), end: TimeMath.secondsToFlicks(3.9) },
        snappedAcousticRange: {
          start: TimeMath.secondsToFlicks(3.45),
          end: TimeMath.secondsToFlicks(3.92),
        },
        fadeInDurationFlicks: TimeMath.secondsToFlicks(0.012),
        fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.012),
        injectRoomToneFlicks: 0,
        cutStrategy: 'GLOBAL_SYNC_RIPPLE',
        prosodicWarnings: [],
        confidence: 0.91,
      },
    },
    {
      id: 'rec_demo_pause',
      targetTrackId: 'trk_1',
      disfluencyType: 'LONG_PAUSE',
      associatedText: 'مکث طولانی ۱.۱ ثانیه‌ای بین دو جمله',
      status: 'PENDING',
      createdAtProjectRevision: 1,
      spliceDescriptor: {
        rawAiRange: { start: TimeMath.secondsToFlicks(4.42), end: TimeMath.secondsToFlicks(5.5) },
        snappedAcousticRange: {
          start: TimeMath.secondsToFlicks(4.41),
          end: TimeMath.secondsToFlicks(5.52),
        },
        fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
        fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
        injectRoomToneFlicks: TimeMath.secondsToFlicks(0.15),
        cutStrategy: 'GLOBAL_SYNC_RIPPLE',
        prosodicWarnings: [],
        confidence: 0.97,
      },
    },
  ],
};

export interface BootstrapDiagnosticSummary {
  readonly crossOriginIsolated: boolean;
  readonly opfsPersisted: boolean;
  readonly dirtyRecoveryDetected: boolean;
  readonly hardwareProfile: EmpiricalHardwareProfile;
  readonly resolvedTier: DeviceTier;
  readonly maxSafeRamMb: number;
}

export function resolveEffectiveDeviceTier(
  detectedTier: DeviceTier,
  searchQuery?: string,
): DeviceTier {
  if (searchQuery) {
    const params = new URLSearchParams(searchQuery);
    const tierParam = params.get('tier');
    if (tierParam === 'mobile') return 'MOBILE_COMPANION';
    if (tierParam === 'tablet') return 'TABLET_STUDIO';
    if (tierParam === 'desktop') return 'DESKTOP_STUDIO';
  }
  return detectedTier;
}

interface StudioRootBootstrapperProps {
  /** Primary full-featured desktop studio view (defaults to root App workspace). */
  desktopStudioElement?: React.ReactElement;
  /** Forces rendering the standalone v1.2 DesktopAudioStudioApp shell instead of default desktopStudioElement. */
  useV12DesktopShell?: boolean;
}

/**
 * Adaptive Studio Root Bootstrapper (Architecture Doc Sections 10, 14, 47 & 50)
 * Executes startup sequence:
 * 1. Registers Offline-First Service Worker (/sw.js) with COOP/COEP enforcement
 * 2. Requests Persistent OPFS Storage
 * 3. Runs Crash Recovery pending journal check
 * 4. Runs HardwareBenchmarkProfiler calibration and routes Desktop Studio vs Mobile Companion
 */
export const StudioRootBootstrapper: React.FC<StudioRootBootstrapperProps> = ({
  desktopStudioElement,
  useV12DesktopShell = false,
}) => {
  const [bootstrapSummary, setBootstrapSummary] = useState<BootstrapDiagnosticSummary | null>(null);
  const [v12Project, setV12Project] = useState<ProjectDocument>(INITIAL_DEMO_PROJECT);
  const [v12History, setV12History] = useState<ProjectDocument[]>([]);
  const [v12RedoStack, setV12RedoStack] = useState<ProjectDocument[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadFlicks, setPlayheadFlicks] = useState(0);
  const [tokens, setTokens] = useState(() =>
    PersianTextNormalizer.buildThreeLayerTranscript([
      { id: 't1', text: 'سلام، امروز', range: { start: 0, end: TimeMath.secondsToFlicks(0.95) }, confidence: 0.98 },
      { id: 't2', text: 'اممم', range: { start: TimeMath.secondsToFlicks(1.08), end: TimeMath.secondsToFlicks(1.62) }, confidence: 0.91 },
      { id: 't3', text: 'درباره', range: { start: TimeMath.secondsToFlicks(1.75), end: TimeMath.secondsToFlicks(2.45) }, confidence: 0.96 },
      { id: 't4', text: 'هوش مصنوعی', range: { start: TimeMath.secondsToFlicks(2.5), end: TimeMath.secondsToFlicks(3.35) }, confidence: 0.97 },
      { id: 't5', text: 'رفتیممممم', range: { start: TimeMath.secondsToFlicks(3.45), end: TimeMath.secondsToFlicks(3.92) }, confidence: 0.89 },
      { id: 't6', text: 'صحبت کنیم', range: { start: TimeMath.secondsToFlicks(5.6), end: TimeMath.secondsToFlicks(6.8) }, confidence: 0.96 },
    ]),
  );
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let active = true;

    async function bootstrapEnvironment() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }

      let opfsPersisted = false;
      if (navigator.storage && navigator.storage.persist) {
        try {
          opfsPersisted = await navigator.storage.persist();
        } catch {
          opfsPersisted = false;
        }
      }

      const crashLock = new CrashRecoveryAndSessionLock();
      const recoveryRecord = await crashLock.checkCrashRecovery(
        INITIAL_DEMO_PROJECT.projectId,
      );
      const dirtyRecoveryDetected = Boolean(recoveryRecord);

      const runtimeMgr = new ResilientAiRuntimeManager();
      const cap = await runtimeMgr.detectCapabilityTier();
      const hwProfile = await HardwareBenchmarkProfiler.runEmpiricalCalibration(
        cap.tier,
        cap.recommendedBackend,
      );

      const searchStr = typeof window !== 'undefined' ? window.location.search : '';
      const resolvedTier = resolveEffectiveDeviceTier(cap.tier, searchStr);

      if (active) {
        setBootstrapSummary({
          crossOriginIsolated:
            typeof window !== 'undefined' ? Boolean(window.crossOriginIsolated) : false,
          opfsPersisted,
          dirtyRecoveryDetected,
          hardwareProfile: hwProfile,
          resolvedTier,
          maxSafeRamMb: cap.maxWasmMemoryMb,
        });
      }
    }

    bootstrapEnvironment();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
    const height = Math.max(96, Math.round(rect.height || canvas.clientHeight || 160));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const pendingSplices = v12Project.recommendations
      .filter((r) => r.status === 'PENDING')
      .map((r) => r.spliceDescriptor);

    LodWaveformCanvasRenderer.renderViewport(
      ctx,
      width,
      height,
      DEMO_WAVEFORM_LOD,
      { start: 0, end: TimeMath.secondsToFlicks(12) },
      playheadFlicks,
      v12Project.canonicalSampleRate,
      pendingSplices,
    );
  }, [bootstrapSummary, v12Project, playheadFlicks]);

  useEffect(() => {
    if (!isPlaying) return;
    const durationFlicks = TimeMath.secondsToFlicks(12);
    const stepFlicks = TimeMath.secondsToFlicks(0.05);
    const id = window.setInterval(() => {
      setPlayheadFlicks((prev) => {
        const next = prev + stepFlicks;
        return next >= durationFlicks ? 0 : next;
      });
    }, 50);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  const commitRecommendationDecision = (
    recId: RecommendationId,
    nextStatus: 'ACCEPTED' | 'REJECTED',
  ) => {
    setV12History((prev) => [...prev, v12Project]);
    setV12RedoStack([]);
    setV12Project((curr) => ({
      ...curr,
      revision: curr.revision + 1,
      recommendations: curr.recommendations.map((r) =>
        r.id === recId ? { ...r, status: nextStatus, userDecisionTimestamp: Date.now() } : r,
      ),
    }));
  };

  const handleV12Undo = () => {
    if (v12History.length === 0) return;
    const prevDoc = v12History[v12History.length - 1];
    setV12RedoStack((r) => [v12Project, ...r]);
    setV12History((h) => h.slice(0, -1));
    setV12Project(prevDoc);
  };

  const handleV12Redo = () => {
    if (v12RedoStack.length === 0) return;
    const nextDoc = v12RedoStack[0];
    setV12History((h) => [...h, v12Project]);
    setV12RedoStack((r) => r.slice(1));
    setV12Project(nextDoc);
  };

  const handleNudgeMobileBoundary = (
    recId: RecommendationId,
    edge: 'START' | 'END',
    deltaMs: number,
  ) => {
    const deltaFlicks = TimeMath.secondsToFlicks(deltaMs / 1000);
    setV12Project((curr) => ({
      ...curr,
      recommendations: curr.recommendations.map((r) => {
        if (r.id !== recId) return r;
        const range = r.spliceDescriptor.snappedAcousticRange;
        const updatedRange =
          edge === 'START'
            ? { start: Math.max(0, Math.min(range.end - 1, range.start + deltaFlicks)), end: range.end }
            : { start: range.start, end: Math.max(range.start + 1, range.end + deltaFlicks) };
        return {
          ...r,
          spliceDescriptor: {
            ...r.spliceDescriptor,
            snappedAcousticRange: updatedRange,
          },
        };
      }),
    }));
  };

  if (!bootstrapSummary) {
    return (
      <div
        dir="rtl"
        role="status"
        className="min-h-screen bg-[#0B0F17] text-slate-200 flex items-center justify-center text-sm px-6 text-center"
      >
        در حال کالیبراسیون موتور صوتی محلی و سنجش توان پردازشی دستگاه...
      </div>
    );
  }

  if (bootstrapSummary.resolvedTier === 'MOBILE_COMPANION') {
    const pendingRecs = v12Project.recommendations.filter((r) => r.status === 'PENDING');
    return (
      <>
        <MobileCompanionWorkspace
          projectName={v12Project.name}
          pendingRecommendations={pendingRecs}
          estimatedMemoryUsageMb={92}
          maxSafeMemoryMb={bootstrapSummary.maxSafeRamMb}
          onAuditionPreview={(_recId, _mode) => {}}
          onNudgeCutBoundary={handleNudgeMobileBoundary}
          onAccept={(id) => commitRecommendationDecision(id, 'ACCEPTED')}
          onReject={(id) => commitRecommendationDecision(id, 'REJECTED')}
          onUndo={handleV12Undo}
        />
        <OfflineIndicator />
      </>
    );
  }

  const queryWantsV12Shell =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('shell') === 'v12';

  if (desktopStudioElement && !useV12DesktopShell && !queryWantsV12Shell) {
    return (
      <>
        {desktopStudioElement}
        <div className="fixed bottom-4 right-4 z-40">
          <PWAInstallButton />
        </div>
        <OfflineIndicator />
      </>
    );
  }

  return (
    <>
      <DesktopAudioStudioApp
        project={v12Project}
        tokens={tokens}
        playheadFlicks={playheadFlicks}
        isPlaying={isPlaying}
        shuttleSpeed={1.0}
        opfsPersisted={bootstrapSummary.opfsPersisted}
        opfsUsedMb={48}
        aiModelReady={true}
        aiModelDownloadProgressPercent={100}
        waveformCanvasRef={waveformCanvasRef}
        onTogglePlayPause={() => setIsPlaying((p) => !p)}
        onSeek={(target) => setPlayheadFlicks(target)}
        onUndo={handleV12Undo}
        onRedo={handleV12Redo}
        onPreviewSplice={(_recId, windowRange) => setPlayheadFlicks(windowRange.start)}
        onAcceptRecommendation={(id) => commitRecommendationDecision(id, 'ACCEPTED')}
        onRejectRecommendation={(id) => commitRecommendationDecision(id, 'REJECTED')}
        onUpdateDisplayTranscript={(tokenId, newText) =>
          setTokens((prev) =>
            prev.map((t) =>
              t.tokenId === tokenId
                ? { ...t, displayText: newText, normalizedText: PersianTextNormalizer.normalizeTokenText(newText) }
                : t,
            ),
          )
        }
        onApplyAutoAcousticFix={() => {}}
        onTriggerExport={() => {}}
      />
      <div className="fixed bottom-4 right-4 z-40">
        <PWAInstallButton />
      </div>
      <OfflineIndicator />
    </>
  );
};
