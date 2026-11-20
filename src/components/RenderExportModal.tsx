import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FileText,
  Pause,
  Play,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import {
  AudioRenderConfig,
  RenderExportContainer,
  RenderExportEncoding,
  pipeRenderArtifactToWritable,
} from '../audio-renderer';
import { SampleRate } from '../contracts/timebase.contract';

type RenderFormatPreset = 'WAV_PCM16' | 'WAV_PCM24' | 'WAV_FLOAT32' | 'RF64_PCM24';
import { StudioWorkflowState } from '../workflow/StudioWorkflowController';
import { sanitizeExportFilename } from '../security/LocalPrivacyPolicy';
import { serializeEdlSnapshot } from '../ai-engine/edit-decision';
import { PersianWordToken } from '../contracts/v1_2';
import { flicksToSeconds } from '../engine/timebase';

interface RenderExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowState: StudioWorkflowState;
  projectSampleRate: SampleRate;
  tokens: readonly PersianWordToken[];
  onStartRender: (config: AudioRenderConfig, resumeFromCheckpoint: boolean) => void;
  onPauseRender: () => void;
  onCancelRender: () => void;
  onMarkDownloaded: (fileName: string) => void;
}

function downloadTextBlob(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeExportFilename(fileName);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function formatSrtTime(sec: number): string {
  const totalMs = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export const RenderExportModal: React.FC<RenderExportModalProps> = ({
  isOpen,
  onClose,
  workflowState,
  projectSampleRate,
  tokens,
  onStartRender,
  onPauseRender,
  onCancelRender,
  onMarkDownloaded,
}) => {
  const isFa = workflowState.locale === 'fa';
  const [format, setFormat] = useState<RenderFormatPreset>('WAV_PCM16');
  const [sampleRate, setSampleRate] = useState<SampleRate>(projectSampleRate);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    setSampleRate(projectSampleRate);
  }, [projectSampleRate]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isRendering =
    workflowState.renderState === 'QUEUED' ||
    workflowState.renderState === 'VALIDATING' ||
    workflowState.renderState === 'PLANNING' ||
    workflowState.renderState === 'RENDERING' ||
    workflowState.renderState === 'FINALIZING' ||
    workflowState.renderState === 'VALIDATING_OUTPUT';

  const result = workflowState.lastRenderResult;
  const outputArtifact = result?.outputArtifact ?? null;
  const validationPassed = Boolean(
    result?.ok &&
    result.state === 'COMPLETED' &&
    result.postValidation?.passed,
  );
  const canDownloadAudio = Boolean(
    validationPassed &&
    outputArtifact &&
    !outputArtifact.disposed &&
    !isDownloading,
  );

  const handleRun = (resume: boolean) => {
    setDownloadError(null);
    const encoding: RenderExportEncoding =
      format === 'WAV_FLOAT32' ? 'float32' : format === 'WAV_PCM16' ? 'pcm16' : 'pcm24';
    const container: RenderExportContainer = format === 'RF64_PCM24' ? 'rf64' : 'wav';
    onStartRender(
      {
        encoding,
        container,
        targetSampleRate: sampleRate,
        chunkSizeSamples: 8192,
        defaultCrossfadeMs: 10,
      },
      resume,
    );
  };

  const handleDownloadAudio = async () => {
    if (!canDownloadAudio || !result || !outputArtifact || outputArtifact.disposed) return;

    const renderedContainer =
      result.plan?.container ?? result.postValidation?.verifiedContainer ?? 'wav';
    const renderedEncoding =
      result.plan?.encoding ??
      (format === 'WAV_FLOAT32' ? 'float32' : format === 'WAV_PCM16' ? 'pcm16' : 'pcm24');
    const renderedPresetTag = `${renderedContainer}_${renderedEncoding}`.toLowerCase();
    const ext = renderedContainer === 'rf64' ? 'rf64.wav' : 'wav';
    const fileName = sanitizeExportFilename(`${workflowState.projectId}-${renderedPresetTag}.${ext}`);

    setIsDownloading(true);
    setDownloadError(null);

    try {
      // Primary desktop path: File System Access API streaming with native backpressure
      const savePicker =
        typeof window !== 'undefined'
          ? (
              window as unknown as {
                showSaveFilePicker?: (options?: {
                  suggestedName?: string;
                  types?: Array<{
                    description?: string;
                    accept: Record<string, string[]>;
                  }>;
                }) => Promise<{
                  createWritable: () => Promise<WritableStream<Uint8Array>>;
                }>;
              }
            ).showSaveFilePicker
          : undefined;

      if (typeof savePicker === 'function') {
        let fileHandle: { createWritable: () => Promise<WritableStream<Uint8Array>> } | null = null;
        let fallBackToBlob = false;

        try {
          fileHandle = await savePicker({
            suggestedName: fileName,
            types: [
              {
                description: renderedContainer === 'rf64' ? 'RF64 WAV Audio' : 'WAV Audio',
                accept: { [outputArtifact.contentType]: ['.wav'] },
              },
            ],
          });
        } catch (pickerErr) {
          const errName = pickerErr instanceof Error ? pickerErr.name : '';
          if (errName === 'AbortError') {
            // User dismissed the save dialog; do not trigger a duplicate fallback download.
            return;
          }
          if (
            errName === 'SecurityError' ||
            errName === 'NotAllowedError' ||
            errName === 'TypeError'
          ) {
            fallBackToBlob = true;
          } else {
            throw pickerErr;
          }
        }

        if (fileHandle && !fallBackToBlob) {
          const writable = await fileHandle.createWritable();
          await pipeRenderArtifactToWritable(outputArtifact, writable);
          onMarkDownloaded(fileName);
          return;
        }
      }

      // Fallback path: zero-concatenation Blob constructed directly from artifact chunks/stream
      const blob = await outputArtifact.createBlob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        onMarkDownloaded(fileName);
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : isFa
            ? 'ذخیره یا دانلود فایل صوتی با خطا مواجه شد.'
            : 'Audio export download failed.';
      setDownloadError(message);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleExportTranscript = (kind: 'txt' | 'srt' | 'json') => {
    const activeTokens = tokens.filter((t) => !t.isCrosstalkSuppressed);
    if (kind === 'txt') {
      downloadTextBlob(
        activeTokens.map((t) => t.displayText).join(' '),
        `${workflowState.projectId}-transcript.txt`,
        'text/plain;charset=utf-8',
      );
    } else if (kind === 'srt') {
      const srt = activeTokens
        .map((t, i) => {
          const s = formatSrtTime(flicksToSeconds(t.range.startFlicks));
          const e = formatSrtTime(flicksToSeconds(t.range.endFlicks));
          return `${i + 1}\n${s} --> ${e}\n${t.displayText}\n`;
        })
        .join('\n');
      downloadTextBlob(srt, `${workflowState.projectId}-subtitles.srt`, 'application/x-subrip;charset=utf-8');
    } else {
      downloadTextBlob(
        JSON.stringify(
          {
            projectId: workflowState.projectId,
            rawTranscript: workflowState.rawTranscriptVersion,
            versions: workflowState.transcriptVersions,
            tokens,
          },
          null,
          2,
        ),
        `${workflowState.projectId}-transcript.json`,
        'application/json;charset=utf-8',
      );
    }
  };

  const handleExportEdl = () => {
    if (!workflowState.edlSnapshot) return;
    downloadTextBlob(
      serializeEdlSnapshot(workflowState.edlSnapshot),
      `${workflowState.projectId}-edl-v${workflowState.edlSnapshot.edlVersion}.json`,
      'application/json;charset=utf-8',
    );
  };

  const progressPct = workflowState.renderProgress?.progressPercent ?? (validationPassed ? 100 : 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="render-export-modal-title"
      data-testid="render-export-modal"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-900 dark:text-slate-100 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-[#252F42] flex items-center justify-between">
          <div>
            <h2 id="render-export-modal-title" className="text-sm font-bold">
              {isFa ? 'رندر غیرمخرب و خروجی استاندارد (Mission 06)' : 'Non-Destructive Render & Export (Mission 06)'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {isFa
                ? 'فقط پیشنهادهای تأییدشده در EDL اعمال می‌شوند و فایل صوتی اصلی هرگز تغییر نمی‌کند.'
                : 'Only explicitly approved EDL proposals are applied; original audio is never modified.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isFa ? 'بستن پنجره رندر' : 'Close render modal'}
            className="p-1.5 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {/* Format & Sample Rate */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {isFa ? 'قالب خروجی صوتی' : 'Audio Export Format'}
              </span>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as RenderFormatPreset)}
                disabled={isRendering}
                className="w-full rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] px-3 py-2 text-xs"
              >
                <option value="WAV_PCM16">WAV PCM 16-bit (Standard)</option>
                <option value="WAV_PCM24">WAV PCM 24-bit (Broadcast)</option>
                <option value="WAV_FLOAT32">WAV IEEE Float 32-bit (Master)</option>
                <option value="RF64_PCM24">RF64 PCM 24-bit (&gt;4 GiB Long Form)</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {isFa ? 'نرخ نمونه‌برداری خروجی' : 'Target Sample Rate'}
              </span>
              <select
                value={sampleRate}
                onChange={(e) => setSampleRate(Number(e.target.value) as SampleRate)}
                disabled={isRendering}
                className="w-full rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] px-3 py-2 text-xs font-mono"
              >
                <option value={16000}>16000 Hz</option>
                <option value={44100}>44100 Hz</option>
                <option value={48000}>48000 Hz</option>
              </select>
            </label>
          </div>

          {/* 3-Stage Explicit Pipeline Verification */}
          <div className="rounded-md border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                {isFa ? 'وضعیت چرخه رندر:' : 'Render Lifecycle:'}{' '}
                <span className="font-mono text-amber-700 dark:text-amber-300">
                  {workflowState.renderState}
                </span>
              </span>
              <span className="font-mono tabular-nums">{Math.round(progressPct)}%</span>
            </div>

            <div className="h-2 rounded-full bg-slate-200 dark:bg-[#1E2738] overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all duration-150"
                style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
              <div className="flex items-center gap-1.5">
                <CheckCircle2
                  className={`w-3.5 h-3.5 ${
                    result?.state === 'COMPLETED' ? 'text-emerald-500' : 'text-slate-400'
                  }`}
                />
                <span>{isFa ? '۱. تکمیل رندر' : '1. Render Completed'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <ShieldCheck
                  className={`w-3.5 h-3.5 ${
                    validationPassed ? 'text-emerald-500' : 'text-slate-400'
                  }`}
                />
                <span>{isFa ? '۲. اعتبارسنجی مستقل فایل' : '2. Output Validated'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Download
                  className={`w-3.5 h-3.5 ${
                    workflowState.exportStatus === 'SAVED_OR_DOWNLOADED'
                      ? 'text-emerald-500'
                      : 'text-slate-400'
                  }`}
                />
                <span>{isFa ? '۳. ذخیره/دانلود فایل' : '3. File Downloaded'}</span>
              </div>
            </div>

            {(workflowState.exportError || downloadError) && (
              <div className="flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 p-2.5 text-rose-700 dark:text-rose-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{downloadError ?? workflowState.exportError}</span>
              </div>
            )}

            {result?.postValidation && (
              <div className="text-[11px] font-mono text-slate-600 dark:text-slate-400 flex flex-wrap gap-3" dir="ltr">
                <span>Validation: {result.postValidation.passed ? 'OK' : 'FAIL'}</span>
                <span>Container: {result.postValidation.verifiedContainer ?? 'wav'}</span>
                <span>Peak: {(result.postValidation.verifiedPeakAmplitude ?? 0).toFixed(4)}</span>
                <span>Bytes: {result.postValidation.verifiedFileSizeBytes ?? outputArtifact?.sizeBytes ?? 0}</span>
                <span>Samples: {result.postValidation.verifiedOutputSamples ?? 0}</span>
              </div>
            )}
          </div>

          {/* Primary Render & Download Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="btn-start-mission06-render"
              onClick={() => handleRun(false)}
              disabled={isRendering || !workflowState.edlSnapshot}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'شروع رندر غیرمخرب' : 'Start Non-Destructive Render'}</span>
            </button>

            {workflowState.recoverableCheckpoint && !isRendering && (
              <button
                type="button"
                onClick={() => handleRun(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{isFa ? 'ادامه از Checkpoint' : 'Resume Checkpoint'}</span>
              </button>
            )}

            {isRendering && (
              <>
                <button
                  type="button"
                  onClick={onPauseRender}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-slate-300 dark:border-[#252F42] cursor-pointer"
                >
                  <Pause className="w-3.5 h-3.5" />
                  <span>{isFa ? 'مکث' : 'Pause'}</span>
                </button>
                <button
                  type="button"
                  onClick={onCancelRender}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-rose-500/40 text-rose-600 dark:text-rose-300 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>{isFa ? 'لغو' : 'Cancel'}</span>
                </button>
              </>
            )}

            <button
              type="button"
              data-testid="btn-download-validated-audio"
              onClick={handleDownloadAudio}
              disabled={!canDownloadAudio}
              className="ms-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 text-white font-semibold hover:bg-emerald-500 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'دانلود فایل صوتی تأییدشده' : 'Download Validated Audio'}</span>
            </button>
          </div>

          {!workflowState.edlSnapshot && (
            <p className="text-amber-700 dark:text-amber-300">
              {isFa
                ? 'نکته: ابتدا در پنل تدوین دکمه «تحلیل رویدادها و ساخت EDL» را بزنید تا رندر غیرمخرب فعال شود.'
                : 'Note: Run "Analyze Events & Build EDL" first to enable Mission 06 non-destructive rendering.'}
            </p>
          )}

          {/* Secondary Exports: Transcript & EDL */}
          <div className="pt-3 border-t border-slate-200 dark:border-[#252F42] flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-600 dark:text-slate-400 font-medium">
              {isFa ? 'خروجی‌های متنی و مستند:' : 'Transcript & EDL Exports:'}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleExportTranscript('txt')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-300 dark:border-[#252F42] hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>TXT</span>
              </button>
              <button
                type="button"
                onClick={() => handleExportTranscript('srt')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-300 dark:border-[#252F42] hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>SRT</span>
              </button>
              <button
                type="button"
                onClick={() => handleExportTranscript('json')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-300 dark:border-[#252F42] hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
              >
                <FileJson className="w-3.5 h-3.5" />
                <span>Transcript JSON</span>
              </button>
              <button
                type="button"
                onClick={handleExportEdl}
                disabled={!workflowState.edlSnapshot}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-300 dark:border-[#252F42] hover:bg-slate-100 dark:hover:bg-[#1E2738] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <FileJson className="w-3.5 h-3.5" />
                <span>EDL JSON</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
