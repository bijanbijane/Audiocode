import React, { useState } from 'react';
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
  provenanceItems?: AnalysisProvenanceItem[];
  diagnosticLogs?: DiagnosticLogEntry[];
  onSendApprovedDiagnosticBundle?: (sanitizedJsonPayload: string) => void;
}

/**
 * Unified Desktop Audio Studio Shell (Architecture Doc Sections 50-53)
 * Integrates Project Header (OPFS persistence + local AI state + Undo/Redo),
 * Acoustic Advisor Bar (50Hz mains hum / plosive / sibilance alerts),
 * Persian Transcript Workspace, and the Bottom Dock (Waveform Canvas, DSP Graph Advisor, LUFS Export).
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
  provenanceItems = DEFAULT_STUDIO_PROVENANCE_ITEMS,
  diagnosticLogs = DEFAULT_DIAGNOSTIC_LOGS,
  onSendApprovedDiagnosticBundle = () => {},
}) => {
  const [selectedExportProfileId, setSelectedExportProfileId] = useState<string>(
    'PODCAST_STEREO_STANDARD',
  );
  const [activeBottomTab, setActiveBottomTab] = useState<DesktopBottomTab>('TIMELINE');
  const [syncOffsetMs, setSyncOffsetMs] = useState<number>(38.5);
  const [clockDriftPpm, setClockDriftPpm] = useState<number>(14.2);

  const sampleRateKhz = (project.canonicalSampleRate / 1000).toFixed(
    project.canonicalSampleRate % 1000 === 0 ? 0 : 1,
  );
  const hasSyncDrift = Math.abs(syncOffsetMs) > 0.1 || Math.abs(clockDriftPpm) > 1.0;

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* 1. Three-zone Project Header (OPFS persistence, Local AI readiness, Undo/Redo) */}
      <header className="h-14 px-6 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-8">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-bold text-base text-slate-100 tracking-tight whitespace-nowrap shrink-0">
            آواپرداز
          </span>
          <span aria-hidden="true" className="text-slate-600">
            /
          </span>
          <span className="text-sm text-slate-200 font-medium truncate">{project.name}</span>
          <span aria-hidden="true" className="text-slate-700 hidden md:inline">
            ·
          </span>
          <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap hidden md:inline">
            نسخه ویرایش #{project.revision} ·{' '}
            <span dir="ltr" className="font-mono">
              {sampleRateKhz}kHz
            </span>
          </span>
        </div>

        <div className="hidden lg:flex items-center gap-3 text-xs text-slate-300 whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {opfsPersisted ? (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            )}
            <span className={opfsPersisted ? 'text-emerald-300' : 'text-amber-300'}>
              {opfsPersisted ? 'فضای محلی پایدار' : 'فضای موقت مرورگر'}
            </span>
            <span className="text-slate-500 tabular-nums font-mono" dir="ltr">
              ({opfsUsedMb} MB)
            </span>
          </span>

          <span aria-hidden="true" className="text-slate-700">
            ·
          </span>

          <span className="inline-flex items-center gap-1.5">
            {aiModelReady ? (
              <Check className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
            ) : (
              <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin shrink-0" aria-hidden="true" />
            )}
            <span className="text-slate-200 tabular-nums">
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 text-slate-200 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>واگرد</span>
          </button>
          <button
            type="button"
            onClick={onRedo}
            title="بازانجام (Ctrl+Shift+Z)"
            aria-label="بازانجام تغییرات (Ctrl+Shift+Z)"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 text-slate-200 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
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
          className="bg-amber-950/35 border-b border-amber-800/60 px-6 py-2.5 flex items-center justify-between gap-4 text-xs"
        >
          <div className="flex items-center gap-2 text-amber-200 min-w-0">
            <Mic className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span className="font-semibold shrink-0">مشاور آکوستیک ضبط:</span>
            <span className="truncate">{acousticDiagnostic.summaryAdviceFa[0]}</span>
          </div>
          <button
            type="button"
            onClick={onApplyAutoAcousticFix}
            className="px-4 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300 text-slate-950 font-semibold whitespace-nowrap shrink-0 cursor-pointer"
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
        className="bg-slate-900 border-t border-slate-800 px-6 py-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTogglePlayPause}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 text-slate-950 font-bold text-xs whitespace-nowrap shrink-0 cursor-pointer"
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
            <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
              سرعت مرور (L):{' '}
              <span dir="ltr" className="font-mono text-slate-200">
                {shuttleSpeed.toFixed(1)}x
              </span>
            </span>
          </div>

          <div
            role="tablist"
            aria-label="بخش‌های پنل پایین استودیو"
            className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg text-xs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeBottomTab === 'TIMELINE'}
              onClick={() => setActiveBottomTab('TIMELINE')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                activeBottomTab === 'TIMELINE'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Waves className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="tabular-nums">موج صوتی و تایم‌لاین ({project.tracks.length} ترک)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeBottomTab === 'PROCESSING'}
              onClick={() => setActiveBottomTab('PROCESSING')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                activeBottomTab === 'PROCESSING'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
              <span>گراف پردازش و ترمیم صدا (DSP)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeBottomTab === 'EXPORT'}
              onClick={() => setActiveBottomTab('EXPORT')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                activeBottomTab === 'EXPORT'
                  ? 'bg-emerald-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
              <span>خروجی نهایی و مسترینگ (Export)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeBottomTab === 'PROVENANCE'}
              onClick={() => setActiveBottomTab('PROVENANCE')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                activeBottomTab === 'PROVENANCE'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              <span>منشأ AI و ممیزی گزارش</span>
            </button>
          </div>
        </div>

        {activeBottomTab === 'TIMELINE' && (
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2.5">
            <div
              data-testid="v12-waveform-sync-drift-bar"
              className="flex flex-wrap items-center justify-between gap-3 text-xs pb-2 border-b border-slate-800/80"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400 font-medium">وضعیت همگام‌سازی چند ضبط‌کننده:</span>
                <span
                  data-testid="v12-waveform-sync-drift-status"
                  className={`px-2.5 py-0.5 rounded border font-medium tabular-nums ${
                    hasSyncDrift
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
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
                          <span className="mx-1.5 text-amber-500/60">·</span>
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
                  className="px-2 py-1 rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 font-mono text-[11px] cursor-pointer"
                >
                  <span dir="ltr">-5ms</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSyncOffsetMs((v) => Number((v + 5).toFixed(1)))}
                  className="px-2 py-1 rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 font-mono text-[11px] cursor-pointer"
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
                  className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold text-xs cursor-pointer disabled:cursor-not-allowed"
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
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            {acousticDiagnostic ? (
              <>
                <div className="flex flex-wrap items-center gap-6 text-slate-300">
                  <div>
                    <span className="text-slate-400">نسبت سیگنال به نویز (SNR): </span>
                    <span dir="ltr" className="font-mono tabular-nums text-slate-100">
                      {acousticDiagnostic.signalToNoiseRatioDb.toFixed(1)} dB
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">هوم برق شهر (50Hz): </span>
                    <span className="font-medium text-slate-100">
                      {acousticDiagnostic.has50HzMainsHum ? 'شناسایی شده' : 'سالم'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">رویداد پاپ / صفیری: </span>
                    <span className="font-mono tabular-nums text-slate-100">
                      {acousticDiagnostic.plosivePopEvents.length} /{' '}
                      {acousticDiagnostic.harshSibilanceEvents.length}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">فیلترهای پیشنهادی: </span>
                    <span className="font-mono tabular-nums text-sky-300">
                      {acousticDiagnostic.recommendedGraphNodes.length} گره پردازش
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onApplyAutoAcousticFix}
                  disabled={acousticDiagnostic.recommendedGraphNodes.length === 0}
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                >
                  اعمال گره‌های ترمیم پیشنهادی
                </button>
              </>
            ) : (
              <p className="text-slate-400">
                هنوز تحلیل آکوستیکی روی پروژه ثبت نشده است؛ پس از ورود صوت، وضعیت هوم ۵۰ هرتز، پاپ و تیزی حروف صفیری اینجا نمایش داده می‌شود.
              </p>
            )}
          </div>
        )}

        {activeBottomTab === 'EXPORT' && (
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label
                htmlFor="desktop-export-profile"
                className="text-xs text-slate-300 font-medium whitespace-nowrap"
              >
                پروفایل خروجی استاندارد:
              </label>
              <select
                id="desktop-export-profile"
                value={selectedExportProfileId}
                onChange={(e) => setSelectedExportProfileId(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
              >
                {Object.values(STANDARD_EXPORT_PROFILES).map((prof) => (
                  <option key={prof.profileId} value={prof.profileId}>
                    {prof.nameFa}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => onTriggerExport(selectedExportProfileId)}
              className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 text-white font-bold text-xs whitespace-nowrap shrink-0 cursor-pointer"
            >
              شروع رندر جریانی و اعتبارسنجی خروجی (LUFS & True-Peak)
            </button>
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
