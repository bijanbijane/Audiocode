import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  HardDrive,
  Loader2,
  Mic,
  Pause,
  Play,
  Redo2,
  ShieldCheck,
  Sliders,
  Undo2,
  Waves,
  XCircle,
} from 'lucide-react';
import { PersianTranscriptWorkspace } from '../workspace/PersianTranscriptWorkspace';
import { TimedPersianToken } from '../../ai-engine/PersianTextNormalizer';
import {
  ProjectDocument,
  RecommendationId,
} from '../../contracts/project-schema.contract';
import { Flicks, TimeRange } from '../../contracts/timebase.contract';
import { STANDARD_EXPORT_PROFILES } from '../../processing-core/StreamingExportEncoder';
import { RecordingAcousticDiagnosticReport } from '../../../packages/audio-runtime/src/RecordingQualityAdvisorEngine';
import {
  AnalysisProvenanceItem,
  DiagnosticLogEntry,
  ProvenanceAndSupportAuditPanel,
} from '../governance/ProvenanceAndSupportAuditPanel';
import { getNextRovingTabIndex } from '../../studio/layoutUtils';
import { ExportProgressIndicator } from '../../components/ExportProgressIndicator';
import { ExportUiLifecycleState, isActiveExportState } from '../../utils/exportProgress';

export type DesktopBottomTab = 'TIMELINE' | 'PROCESSING' | 'EXPORT' | 'PROVENANCE';

const DEFAULT_STUDIO_PROVENANCE_ITEMS: AnalysisProvenanceItem[] = [
  {
    analysisId: 'prov_asr_1',
    taskTitleFa: 'تشخیص گفتار و هم‌ترازی زمانی فارسی (ASR + CTC)',
    modelId: 'whisper-small-fa-ct2-q8',
    modelVersion: '1.2.0',
    executedRuntime: 'LOCAL_WASM_SIMD',
    inputAssetHashPrefix: '8f3a19c2',
    confidencePercent: 95,
    validityStatus: 'VALID_CURRENT',
  },
  {
    analysisId: 'prov_disf_1',
    taskTitleFa: 'تحلیل تپق، سکوت و کلمات کشیده',
    modelId: 'persian-disfluency-prosody-v1',
    modelVersion: '1.2.0',
    executedRuntime: 'LOCAL_WASM_SIMD',
    inputAssetHashPrefix: '8f3a19c2',
    confidencePercent: 92,
    validityStatus: 'VALID_CURRENT',
  },
];

const DEFAULT_DIAGNOSTIC_LOGS: DiagnosticLogEntry[] = [
  {
    logId: 'log_1',
    timestampIso: '2026-11-16T13:55:00.000Z',
    category: 'AUDIO_WORKLET',
    rawMessage: 'RingBuffer underrun prevented cleanly on /Users/editor/Documents/اپیزود_جدید.wav (sampleRate=48000)',
  },
  {
    logId: 'log_2',
    timestampIso: '2026-11-16T13:55:12.000Z',
    category: 'WASM_RUNTIME',
    rawMessage: 'SIMD runtime warm-calibrated in 14.2ms; GPU fallback unused.',
  },
];

export interface DesktopStudioProps {
  project: ProjectDocument;
  tokens: TimedPersianToken[];
  playheadFlicks: Flicks;
  isPlaying: boolean;
  shuttleSpeed: number;
  opfsPersisted: boolean;
  opfsUsedMb: number;
  aiModelReady: boolean;
  aiModelDownloadProgressPercent: number;
  acousticDiagnostic?: RecordingAcousticDiagnosticReport;
  waveformCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onTogglePlayPause: () => void;
  onSeek: (targetFlicks: Flicks) => void;
  onUndo: () => void;
  onRedo: () => void;
  onPreviewSplice: (recId: RecommendationId, windowRange: TimeRange) => void;
  onAcceptRecommendation: (recId: RecommendationId) => void;
  onRejectRecommendation: (recId: RecommendationId, reason?: string) => void;
  onUpdateDisplayTranscript: (tokenId: string, newText: string) => void;
  onApplyAutoAcousticFix: () => void;
  onTriggerExport: (profileId: string) => void;
  onCancelExport?: () => void;
  initialBottomTab?: DesktopBottomTab;
  exportState?: ExportUiLifecycleState;
  exportProgressPercent?: number;
  exportOperationLabel?: string | null;
  exportError?: string | null;
  provenanceItems?: AnalysisProvenanceItem[];
  diagnosticLogs?: DiagnosticLogEntry[];
  onSendApprovedDiagnosticBundle?: (sanitizedJsonPayload: string) => void;
}

/**
 * Standalone Experimental v1.2 Desktop Audio Studio Shell (`useV12DesktopShell`).
 * Aligned with shared `--avp-*` design tokens and ARIA controls for parity with root `App.tsx`.
 */
export const DesktopAudioStudioApp: React.FC<DesktopStudioProps> = ({
  project,
  tokens,
  playheadFlicks,
  isPlaying,
  shuttleSpeed,
  opfsPersisted,
  opfsUsedMb,
  aiModelReady,
  aiModelDownloadProgressPercent,
  acousticDiagnostic,
  waveformCanvasRef,
  onTogglePlayPause,
  onSeek,
  onUndo,
  onRedo,
  onPreviewSplice,
  onAcceptRecommendation,
  onRejectRecommendation,
  onUpdateDisplayTranscript,
  onApplyAutoAcousticFix,
  onTriggerExport,
  onCancelExport,
  initialBottomTab = 'TIMELINE',
  exportState,
  exportProgressPercent,
  exportOperationLabel = null,
  exportError = null,
  provenanceItems = DEFAULT_STUDIO_PROVENANCE_ITEMS,
  diagnosticLogs = DEFAULT_DIAGNOSTIC_LOGS,
  onSendApprovedDiagnosticBundle = () => {},
}) => {
  const [selectedExportProfileId, setSelectedExportProfileId] = useState<string>(
    'PODCAST_STEREO_STANDARD',
  );
  const [activeBottomTab, setActiveBottomTab] = useState<DesktopBottomTab>(initialBottomTab);
  const [syncOffsetMs, setSyncOffsetMs] = useState<number>(38.5);
  const [clockDriftPpm, setClockDriftPpm] = useState<number>(14.2);

  // Local fallback export progress state when parent does not supply controlled exportState
  const [localExportState, setLocalExportState] = useState<ExportUiLifecycleState>('IDLE');
  const [localExportPercent, setLocalExportPercent] = useState<number>(0);
  const [localExportOp, setLocalExportOp] = useState<string | null>(null);
  const exportTimersRef = useRef<number[]>([]);

  const clearLocalExportTimers = () => {
    for (const id of exportTimersRef.current) {
      window.clearTimeout(id);
    }
    exportTimersRef.current = [];
  };

  useEffect(() => () => clearLocalExportTimers(), []);

  const effectiveExportState: ExportUiLifecycleState = exportState ?? localExportState;
  const effectiveExportPercent =
    typeof exportProgressPercent === 'number' ? exportProgressPercent : localExportPercent;
  const effectiveExportOp = exportOperationLabel ?? localExportOp;
  const isExportRunning = isActiveExportState(effectiveExportState);

  const handleStartDesktopExport = () => {
    onTriggerExport(selectedExportProfileId);
    if (exportState !== undefined) return;
    clearLocalExportTimers();
    const profileName =
      STANDARD_EXPORT_PROFILES[selectedExportProfileId]?.nameFa ?? selectedExportProfileId;
    setLocalExportState('VALIDATING');
    setLocalExportPercent(12);
    setLocalExportOp(`اعتبارسنجی پروفایل «${profileName}» و ترک‌های صوتی...`);

    const stages: Array<{ delayMs: number; state: ExportUiLifecycleState; pct: number; op: string }> = [
      { delayMs: 280, state: 'RENDERING', pct: 48, op: 'رندر جریانی صوت و اعمال برش‌های تاییدشده...' },
      { delayMs: 620, state: 'VALIDATING_OUTPUT', pct: 86, op: 'اندازه‌گیری LUFS و اعتبارسنجی True-Peak...' },
      { delayMs: 960, state: 'COMPLETED', pct: 100, op: `فایل خروجی با پروفایل «${profileName}» آماده است.` },
    ];
    exportTimersRef.current = stages.map((step) =>
      window.setTimeout(() => {
        setLocalExportState(step.state);
        setLocalExportPercent(step.pct);
        setLocalExportOp(step.op);
      }, step.delayMs),
    );
  };

  const handleCancelDesktopExport = () => {
    onCancelExport?.();
    if (exportState !== undefined) return;
    clearLocalExportTimers();
    setLocalExportState('CANCELLED');
    setLocalExportPercent(0);
    setLocalExportOp('فرآیند خروجی توسط کاربر لغو شد.');
  };

  const sampleRateKhz = (project.canonicalSampleRate / 1000).toFixed(
    project.canonicalSampleRate % 1000 === 0 ? 0 : 1,
  );
  const hasSyncDrift = Math.abs(syncOffsetMs) > 0.1 || Math.abs(clockDriftPpm) > 1.0;

  const bottomTabs: Array<{
    id: DesktopBottomTab;
    label: string;
    icon: React.ReactNode;
    activeClass: string;
  }> = [
    {
      id: 'TIMELINE',
      label: `موج صوتی و تایم‌لاین (${project.tracks.length} ترک)`,
      icon: <Waves className="w-3.5 h-3.5" aria-hidden="true" />,
      activeClass: 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] border border-[var(--avp-border)]',
    },
    {
      id: 'PROCESSING',
      label: 'گراف پردازش و ترمیم صدا (DSP)',
      icon: <Sliders className="w-3.5 h-3.5" aria-hidden="true" />,
      activeClass: 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] border border-[var(--avp-border)]',
    },
    {
      id: 'EXPORT',
      label: 'خروجی نهایی و مسترینگ (Export)',
      icon: <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />,
      activeClass: 'bg-[var(--avp-success)] text-[var(--avp-on-brand)]',
    },
    {
      id: 'PROVENANCE',
      label: 'منشأ AI و ممیزی گزارش',
      icon: <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />,
      activeClass: 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] border border-[var(--avp-border)]',
    },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-[var(--avp-bg)] text-[var(--avp-text)] flex flex-col font-sans">
      {/* 1. Three-zone Project Header (OPFS persistence, Local AI readiness, Undo/Redo) */}
      <header className="h-14 px-6 bg-[var(--avp-surface-shell)] border-b border-[var(--avp-border)] flex items-center justify-between gap-8">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-bold text-base text-[var(--avp-text)] tracking-tight whitespace-nowrap shrink-0">
            آواپرداز
          </span>
          <span aria-hidden="true" className="text-[var(--avp-text-muted)]">
            /
          </span>
          <h1 className="text-sm text-[var(--avp-text)] font-medium truncate">{project.name}</h1>
          <span aria-hidden="true" className="text-[var(--avp-text-muted)] hidden md:inline">
            ·
          </span>
          <span className="text-xs text-[var(--avp-text-secondary)] tabular-nums whitespace-nowrap hidden md:inline">
            نسخه ویرایش #{project.revision} ·{' '}
            <span dir="ltr" className="font-mono">
              {sampleRateKhz}kHz
            </span>
          </span>
        </div>

        <div className="hidden lg:flex items-center gap-3 text-xs text-[var(--avp-text-secondary)] whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {opfsPersisted ? (
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--avp-success-text)] shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--avp-warning-text)] shrink-0" aria-hidden="true" />
            )}
            <span className={opfsPersisted ? 'text-[var(--avp-success-text)]' : 'text-[var(--avp-warning-text)]'}>
              {opfsPersisted ? 'فضای محلی پایدار' : 'فضای موقت مرورگر'}
            </span>
            <span className="text-[var(--avp-text-muted)] tabular-nums font-mono" dir="ltr">
              ({opfsUsedMb} MB)
            </span>
          </span>

          <span aria-hidden="true" className="text-[var(--avp-text-muted)]">
            ·
          </span>

          <span className="inline-flex items-center gap-1.5">
            {aiModelReady ? (
              <Check className="w-3.5 h-3.5 text-[var(--avp-accent-text)] shrink-0" aria-hidden="true" />
            ) : (
              <Loader2 className="w-3.5 h-3.5 text-[var(--avp-accent-text)] animate-spin shrink-0" aria-hidden="true" />
            )}
            <span className="text-[var(--avp-text)] tabular-nums">
              {aiModelReady
                ? 'موتور AI فارسی آماده (محلی)'
                : `دریافت مدل در پس‌زمینه (${aiModelDownloadProgressPercent}٪)`}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onUndo}
            title="واگرد (Ctrl+Z)"
            aria-label="واگرد تغییرات (Ctrl+Z)"
            className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[32px] text-xs font-medium whitespace-nowrap shrink-0"
          >
            <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>واگرد</span>
          </button>
          <button
            type="button"
            onClick={onRedo}
            title="بازانجام (Ctrl+Shift+Z)"
            aria-label="بازانجام تغییرات (Ctrl+Shift+Z)"
            className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[32px] text-xs font-medium whitespace-nowrap shrink-0"
          >
            <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>بازانجام</span>
          </button>
        </div>
      </header>

      {/* 2. Cold-Start Acoustic Advisor Banner (50Hz mains hum / plosives / sibilance) */}
      {acousticDiagnostic && acousticDiagnostic.summaryAdviceFa.length > 0 && (
        <div
          role="region"
          aria-label="مشاور آکوستیک ضبط"
          className="bg-[var(--avp-warning-soft)] border-b border-[var(--avp-warning)]/40 px-6 py-2.5 flex items-center justify-between gap-4 text-xs"
        >
          <div className="flex items-center gap-2 text-[var(--avp-warning-text)] min-w-0">
            <Mic className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="font-semibold shrink-0">مشاور آکوستیک ضبط:</span>
            <span className="truncate text-[var(--avp-text)]">{acousticDiagnostic.summaryAdviceFa[0]}</span>
          </div>
          <button
            type="button"
            onClick={onApplyAutoAcousticFix}
            className="avp-btn avp-btn-tonal min-h-[44px] sm:min-h-[32px] font-semibold whitespace-nowrap shrink-0"
          >
            افزودن خودکار فیلترهای ترمیم
          </button>
        </div>
      )}

      {/* 3. Main Workspace: Synchronized Persian Transcript + Smart Disfluency Suggestions */}
      <main className="flex-1 p-5 overflow-hidden">
        <PersianTranscriptWorkspace
          tokens={tokens}
          recommendations={project.recommendations}
          playheadFlicks={playheadFlicks}
          onSeek={onSeek}
          onPreviewSplice={onPreviewSplice}
          onAcceptRecommendation={onAcceptRecommendation}
          onRejectRecommendation={onRejectRecommendation}
          onUpdateDisplayTranscript={onUpdateDisplayTranscript}
        />
      </main>

      {/* 4. Bottom Studio Dock: Transport Controls, Waveform Canvas, DSP Processing Advisor, LUFS Export */}
      <section
        aria-label="پنل کنترل پخش و تایم‌لاین"
        className="bg-[var(--avp-surface-shell)] border-t border-[var(--avp-border)] px-6 py-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTogglePlayPause}
              className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px] px-4 font-bold text-xs whitespace-nowrap shrink-0"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>توقف (Space)</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>پخش (Space)</span>
                </>
              )}
            </button>
            <span className="text-xs text-[var(--avp-text-secondary)] tabular-nums whitespace-nowrap">
              سرعت مرور (L):{' '}
              <span dir="ltr" className="font-mono text-[var(--avp-text)]">
                {shuttleSpeed.toFixed(1)}x
              </span>
            </span>
          </div>

          <div
            role="tablist"
            aria-label="بخش‌های پنل پایین استودیو"
            className="flex items-center gap-1 p-1 bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] rounded-lg text-xs"
          >
            {bottomTabs.map((tab, idx) => {
              const isSelected = activeBottomTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => setActiveBottomTab(tab.id)}
                  onKeyDown={(e) => {
                    const nextIdx = getNextRovingTabIndex(idx, bottomTabs.length, e.key, true, 'horizontal');
                    if (nextIdx === null) return;
                    e.preventDefault();
                    setActiveBottomTab(bottomTabs[nextIdx].id);
                    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                    buttons?.[nextIdx]?.focus();
                  }}
                  className={`inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-[32px] px-3 py-1.5 rounded-md font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    isSelected ? tab.activeClass : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
                  }`}
                >
                  {tab.icon}
                  <span className="tabular-nums">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {activeBottomTab === 'TIMELINE' && (
          <div className="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-lg p-3 space-y-2.5">
            <div
              data-testid="v12-waveform-sync-drift-bar"
              className="flex flex-wrap items-center justify-between gap-3 text-xs pb-2 border-b border-[var(--avp-border-subtle)]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[var(--avp-text-secondary)] font-medium">وضعیت همگام‌سازی چند ضبط‌کننده:</span>
                <span
                  data-testid="v12-waveform-sync-drift-status"
                  className={`px-2.5 py-0.5 rounded border font-medium tabular-nums ${
                    hasSyncDrift
                      ? 'bg-[var(--avp-warning-soft)] border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)]'
                      : 'bg-[var(--avp-success-soft)] border-[var(--avp-success)]/40 text-[var(--avp-success-text)]'
                  }`}
                >
                  {hasSyncDrift ? (
                    <>
                      <span>انحراف زمانی شناسایی‌شده: </span>
                      <span dir="ltr" className="font-mono font-semibold">
                        {syncOffsetMs >= 0 ? '+' : ''}
                        {syncOffsetMs.toFixed(1)} ms
                      </span>
                      {Math.abs(clockDriftPpm) > 0.5 && (
                        <>
                          <span className="mx-1.5 opacity-60">·</span>
                          <span>دریفت کلاک: </span>
                          <span dir="ltr" className="font-mono">
                            +{clockDriftPpm.toFixed(1)} ppm
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span>هم‌تراز شده: ۰.۰ ms (سینک دقیق نمونه)</span>
                  )}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSyncOffsetMs((v) => Number((v - 5).toFixed(1)))}
                  className="avp-btn avp-btn-sm avp-btn-outline min-h-[44px] sm:min-h-[28px] font-mono text-[11px]"
                >
                  <span dir="ltr">-5ms</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSyncOffsetMs((v) => Number((v + 5).toFixed(1)))}
                  className="avp-btn avp-btn-sm avp-btn-outline min-h-[44px] sm:min-h-[28px] font-mono text-[11px]"
                >
                  <span dir="ltr">+5ms</span>
                </button>
                <button
                  type="button"
                  disabled={!hasSyncDrift}
                  onClick={() => {
                    setSyncOffsetMs(0);
                    setClockDriftPpm(0);
                  }}
                  className="avp-btn avp-btn-sm avp-btn-tonal min-h-[44px] sm:min-h-[28px] font-semibold text-xs disabled:opacity-45"
                >
                  اصلاح آنی و هم‌ترازسازی (Align)
                </button>
              </div>
            </div>

            <canvas
              ref={waveformCanvasRef}
              width={1280}
              height={110}
              data-testid="desktop-waveform-canvas"
              aria-label="بوم نمایش موج صوتی چندترک"
              className="w-full h-28 block cursor-pointer"
            />
          </div>
        )}

        {activeBottomTab === 'PROCESSING' && (
          <div className="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            {acousticDiagnostic ? (
              <>
                <div className="flex flex-wrap items-center gap-6 text-[var(--avp-text-secondary)]">
                  <div>
                    <span>نسبت سیگنال به نویز (SNR): </span>
                    <span dir="ltr" className="font-mono tabular-nums text-[var(--avp-text)]">
                      {acousticDiagnostic.signalToNoiseRatioDb.toFixed(1)} dB
                    </span>
                  </div>
                  <div>
                    <span>هوم برق شهر (50Hz): </span>
                    <span className="font-medium text-[var(--avp-text)]">
                      {acousticDiagnostic.has50HzMainsHum ? 'شناسایی شده' : 'سالم'}
                    </span>
                  </div>
                  <div>
                    <span>رویداد پاپ / صفیری: </span>
                    <span className="font-mono tabular-nums text-[var(--avp-text)]">
                      {acousticDiagnostic.plosivePopEvents.length} /{' '}
                      {acousticDiagnostic.harshSibilanceEvents.length}
                    </span>
                  </div>
                  <div>
                    <span>فیلترهای پیشنهادی: </span>
                    <span className="font-mono tabular-nums text-[var(--avp-accent-text)]">
                      {acousticDiagnostic.recommendedGraphNodes.length} گره پردازش
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onApplyAutoAcousticFix}
                  disabled={acousticDiagnostic.recommendedGraphNodes.length === 0}
                  className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[34px] font-semibold whitespace-nowrap shrink-0"
                >
                  اعمال گره‌های ترمیم پیشنهادی
                </button>
              </>
            ) : (
              <p className="text-[var(--avp-text-secondary)]">
                هنوز تحلیل آکوستیکی روی پروژه ثبت نشده است؛ پس از ورود صوت، وضعیت هوم ۵۰ هرتز، پاپ و تیزی حروف صفیری اینجا نمایش داده می‌شود.
              </p>
            )}
          </div>
        )}

        {activeBottomTab === 'EXPORT' && (
          <div className="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-lg p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <label
                  htmlFor="desktop-export-profile"
                  className="text-xs text-[var(--avp-text)] font-medium whitespace-nowrap"
                >
                  پروفایل خروجی استاندارد:
                </label>
                <select
                  id="desktop-export-profile"
                  value={selectedExportProfileId}
                  disabled={isExportRunning}
                  onChange={(e) => setSelectedExportProfileId(e.target.value)}
                  className="avp-input min-h-[44px] sm:min-h-[34px] px-3 py-1.5 text-xs"
                >
                  {Object.values(STANDARD_EXPORT_PROFILES).map((prof) => (
                    <option key={prof.profileId} value={prof.profileId}>
                      {prof.nameFa}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                {isExportRunning && (
                  <button
                    type="button"
                    data-testid="btn-desktop-cancel-export"
                    onClick={handleCancelDesktopExport}
                    className="avp-btn avp-btn-danger-ghost border border-[var(--avp-error)]/40 min-h-[44px] sm:min-h-[36px] text-xs"
                  >
                    <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                    لغو خروجی
                  </button>
                )}

                <button
                  type="button"
                  data-testid="btn-desktop-start-export"
                  disabled={isExportRunning}
                  onClick={handleStartDesktopExport}
                  className="avp-btn min-h-[44px] sm:min-h-[36px] px-5 bg-[var(--avp-brand-solid)] text-[var(--avp-on-brand)] hover:opacity-90 disabled:opacity-60 font-bold text-xs whitespace-nowrap shrink-0"
                >
                  {isExportRunning
                    ? 'در حال رندر و اعتبارسنجی...'
                    : 'شروع رندر جریانی و اعتبارسنجی خروجی (LUFS & True-Peak)'}
                </button>
              </div>
            </div>

            <ExportProgressIndicator
              testId="desktop-export-progress-panel"
              state={effectiveExportState}
              progressPercent={effectiveExportPercent}
              currentOperation={effectiveExportOp}
              errorMessage={exportError}
              locale="fa"
            />
          </div>
        )}

        {activeBottomTab === 'PROVENANCE' && (
          <ProvenanceAndSupportAuditPanel
            provenanceItems={provenanceItems}
            diagnosticLogs={diagnosticLogs}
            onSendApprovedDiagnosticBundle={onSendApprovedDiagnosticBundle}
          />
        )}
      </section>
    </div>
  );
};
