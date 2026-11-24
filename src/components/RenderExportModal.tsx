import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileAudio,
  FileCode2,
  FileText,
  Pause,
  Play,
  Sliders,
  Sparkles,
  Subtitles,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import { AudioAsset, PersianWordToken, Track } from '../contracts/v1_2';
import { SampleRate, TimeMath } from '../contracts/timebase.contract';
import { flicksToSeconds, msToFlicks } from '../engine/timebase';
import { StudioWorkflowState } from '../workflow/StudioWorkflowController';
import {
  AudioRenderConfig,
  RenderExportContainer,
  RenderExportEncoding,
} from '../audio-renderer';
import { ExportDefaultFormat } from '../settings/settingsStore';
import { AuditionChapterMarker } from './AuditionSideDock';

interface RenderExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowState: StudioWorkflowState;
  projectTitle?: string;
  projectSampleRate: SampleRate;
  totalDurationSec: number;
  tracks?: Track[];
  assets?: Record<string, AudioAsset>;
  tokens?: PersianWordToken[];
  markers?: AuditionChapterMarker[];
  defaultFormat?: ExportDefaultFormat;
  defaultSampleRate?: SampleRate;
  onStartRender: (config: AudioRenderConfig, resumeFromCheckpoint: boolean) => Promise<void> | void;
  onPauseRender: () => void;
  onCancelRender: () => void;
  onMarkDownloaded?: (fileName: string) => void;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function triggerBrowserDownload(content: string | Blob, fileName: string, mimeType?: string): void {
  const blob =
    content instanceof Blob
      ? content
      : new Blob([content], { type: mimeType ?? 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildCleanTranscriptText(tokens: PersianWordToken[]): string {
  const active = tokens.filter((t) => !t.isCrosstalkSuppressed);
  if (active.length === 0) return '';
  const paragraphs: string[] = [];
  let currentSpeaker = active[0].speakerName || active[0].trackId || 'گوینده ۱';
  let bucket: string[] = [];

  for (const tok of active) {
    const spk = tok.speakerName || tok.trackId || 'گوینده ۱';
    if (spk !== currentSpeaker && bucket.length > 0) {
      paragraphs.push(`${currentSpeaker}: ${bucket.join(' ')}`);
      bucket = [];
      currentSpeaker = spk;
    }
    bucket.push(tok.displayText);
  }
  if (bucket.length > 0) {
    paragraphs.push(`${currentSpeaker}: ${bucket.join(' ')}`);
  }
  return paragraphs.join('\n\n');
}

function formatSrtTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0',
  )},${String(ms).padStart(3, '0')}`;
}

function buildSrtSubtitles(tokens: PersianWordToken[]): string {
  const active = tokens.filter((t) => !t.isCrosstalkSuppressed);
  if (active.length === 0) return '';
  const blocks: string[] = [];
  const chunkSize = 8;
  let cueIndex = 1;

  for (let i = 0; i < active.length; i += chunkSize) {
    const slice = active.slice(i, i + chunkSize);
    const startSec = flicksToSeconds(slice[0].range.startFlicks);
    const endSec = Math.max(
      startSec + 0.4,
      flicksToSeconds(slice[slice.length - 1].range.endFlicks),
    );
    const line = slice.map((w) => w.displayText).join(' ');
    blocks.push(
      `${cueIndex}\n${formatSrtTimestamp(startSec)} --> ${formatSrtTimestamp(endSec)}\n${line}`,
    );
    cueIndex += 1;
  }
  return blocks.join('\n\n');
}

function buildAuditionSesxXml(params: {
  sessionName: string;
  sampleRate: SampleRate;
  bitDepth: 16 | 24 | 32;
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  markers: AuditionChapterMarker[];
}): string {
  const sr = params.sampleRate || 48000;
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>`,
    `<!DOCTYPE sesx>`,
    `<sesx version="1.9">`,
    `  <session appVersion="24.0" audioChannelType="stereo" bitDepth="${params.bitDepth}" sampleRate="${sr}">`,
    `    <name>${escapeXml(params.sessionName)}</name>`,
    `    <tracks>`,
  ];

  const referencedAssets = new Set<string>();
  params.tracks.forEach((track, trackIdx) => {
    lines.push(
      `      <audioTrack automationLaneOpenState="false" id="${trackIdx + 1}" index="${trackIdx + 1}">`,
      `        <trackParameters>`,
      `          <name>${escapeXml(track.name)}</name>`,
      `          <mute>${Boolean(track.muted)}</mute>`,
      `          <solo>${Boolean(track.solo)}</solo>`,
      `        </trackParameters>`,
    );

    track.clips.forEach((clip, clipIdx) => {
      referencedAssets.add(clip.assetId);
      const tlStartSample = TimeMath.flicksToSamplesFloor(
        Math.max(0, clip.timelineRange.startFlicks),
        sr,
      );
      const tlEndSample = Math.max(
        tlStartSample,
        TimeMath.flicksToSamplesFloor(Math.max(0, clip.timelineRange.endFlicks), sr),
      );
      const clipDurationFlicks = Math.max(
        0,
        clip.timelineRange.endFlicks - clip.timelineRange.startFlicks,
      );
      const srcStartSample = TimeMath.flicksToSamplesFloor(
        Math.max(0, clip.sourceStartFlicks),
        sr,
      );
      const srcEndSample = Math.max(
        srcStartSample,
        TimeMath.flicksToSamplesFloor(
          Math.max(0, clip.sourceStartFlicks + clipDurationFlicks),
          sr,
        ),
      );
      const clipLenSamples = Math.max(0, tlEndSample - tlStartSample);
      const fadeInSamples = Math.min(
        clipLenSamples,
        Math.max(0, TimeMath.flicksToSamplesFloor(Math.max(0, msToFlicks(clip.fadeInMs)), sr)),
      );
      const fadeOutSamples = Math.min(
        clipLenSamples,
        Math.max(0, TimeMath.flicksToSamplesFloor(Math.max(0, msToFlicks(clip.fadeOutMs)), sr)),
      );

      lines.push(
        `        <audioClip clipAutoCrossfade="true" fileID="${escapeXml(clip.assetId)}" id="${clipIdx}" name="${escapeXml(clip.id)}" startPoint="${tlStartSample}" endPoint="${tlEndSample}" sourceInPoint="${srcStartSample}" sourceOutPoint="${srcEndSample}">`,
        `          <fadeIn crossFadeLinkType="linkedAsymmetric" endPoint="${fadeInSamples}" shape="cosine" startPoint="0"/>`,
        `          <fadeOut crossFadeLinkType="linkedAsymmetric" endPoint="${clipLenSamples}" shape="cosine" startPoint="${Math.max(0, clipLenSamples - fadeOutSamples)}"/>`,
        `        </audioClip>`,
      );
    });

    lines.push(`      </audioTrack>`);
  });

  lines.push(`    </tracks>`, `    <files>`);
  for (const assetId of referencedAssets) {
    const meta = params.assets[assetId];
    const fileName = (meta?.name || `${assetId}.wav`).replace(/^.*[\\/]/, '');
    lines.push(
      `      <file id="${escapeXml(assetId)}" mediaHandler="AmioWav" relativePath="media/${escapeXml(fileName)}"/>`,
    );
  }
  lines.push(`    </files>`);

  if (params.markers.length > 0) {
    lines.push(`    <markers>`);
    params.markers.forEach((m, idx) => {
      const samplePos = Math.max(0, Math.round(m.startSec * sr));
      lines.push(
        `      <marker id="${idx + 1}" name="${escapeXml(m.label)}" startPoint="${samplePos}" type="cue"/>`,
      );
    });
    lines.push(`    </markers>`);
  }

  lines.push(`  </session>`, `</sesx>`);
  return lines.join('\n');
}

export const RenderExportModal: React.FC<RenderExportModalProps> = ({
  isOpen,
  onClose,
  workflowState,
  projectTitle = 'پروژه آواپرداز',
  projectSampleRate,
  totalDurationSec,
  tracks = [],
  assets = {},
  tokens = [],
  markers = [],
  defaultFormat = 'wav-pcm16',
  defaultSampleRate,
  onStartRender,
  onPauseRender,
  onCancelRender,
  onMarkDownloaded,
}) => {
  const [encoding, setEncoding] = useState<RenderExportEncoding>(() => {
    if (defaultFormat === 'wav-pcm24') return 'pcm24';
    if (defaultFormat === 'wav-float32') return 'float32';
    return 'pcm16';
  });
  const [container, setContainer] = useState<RenderExportContainer>('wav');
  const [targetSampleRate, setTargetSampleRate] = useState<SampleRate>(
    defaultSampleRate ?? projectSampleRate,
  );
  const [crossfadeMs, setCrossfadeMs] = useState<number>(10);
  const [enableLimiter, setEnableLimiter] = useState<boolean>(true);
  const [showAdvancedMastering, setShowAdvancedMastering] = useState(false);

  const sanitizedDefaultName = useMemo(() => {
    const base = projectTitle
      .trim()
      .replace(/[^\u0600-\u06FFa-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base ? `${base}-edited` : 'avapardaz-edited';
  }, [projectTitle]);

  const [customFileName, setCustomFileName] = useState<string>(sanitizedDefaultName);
  const [exportedArtifactNotice, setExportedArtifactNotice] = useState<string | null>(null);

  useEffect(() => {
    setCustomFileName(sanitizedDefaultName);
  }, [sanitizedDefaultName]);

  useEffect(() => {
    if (defaultFormat === 'wav-pcm24') setEncoding('pcm24');
    else if (defaultFormat === 'wav-float32') setEncoding('float32');
    else setEncoding('pcm16');
  }, [defaultFormat]);

  useEffect(() => {
    if (defaultSampleRate) setTargetSampleRate(defaultSampleRate);
  }, [defaultSampleRate]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const progress = workflowState.renderProgress;
  const result = workflowState.lastRenderResult;
  const renderState = workflowState.renderState;
  const isRunning =
    renderState === 'QUEUED' ||
    renderState === 'VALIDATING' ||
    renderState === 'PLANNING' ||
    renderState === 'RENDERING' ||
    renderState === 'FINALIZING' ||
    renderState === 'VALIDATING_OUTPUT';
  const isCompleted = renderState === 'COMPLETED' && result !== null && result.ok;

  const fileExtension = container === 'rf64' ? 'rf64.wav' : 'wav';
  const cleanBaseName = (customFileName || sanitizedDefaultName)
    .replace(/\.(wav|flac|txt|srt|json|sesx)$/i, '')
    .trim();
  const finalAudioFileName = `${cleanBaseName || 'avapardaz-edited'}.${fileExtension}`;

  const handleDownloadValidatedAudio = async () => {
    if (!result) return;
    let blob: Blob | null = null;
    if (result.outputArtifact) {
      blob = await result.outputArtifact.createBlob();
    } else if (result.outputBytes) {
      const safeBytes = new Uint8Array(result.outputBytes);
      blob = new Blob([safeBytes], { type: 'audio/wav' });
    }
    if (!blob) return;
    triggerBrowserDownload(blob, finalAudioFileName, 'audio/wav');
    onMarkDownloaded?.(finalAudioFileName);
    setExportedArtifactNotice(`فایل صوتی نهایی (${finalAudioFileName}) دانلود شد.`);
  };

  const handleExportCleanText = () => {
    const text = buildCleanTranscriptText(tokens);
    const fileName = `${cleanBaseName || 'transcript'}.txt`;
    triggerBrowserDownload(
      text || 'متنی برای خروجی یافت نشد.',
      fileName,
      'text/plain;charset=utf-8',
    );
    setExportedArtifactNotice(`متن نهایی تدوین‌شده (${fileName}) دانلود شد.`);
  };

  const handleExportSrt = () => {
    const srt = buildSrtSubtitles(tokens);
    const fileName = `${cleanBaseName || 'subtitles'}.srt`;
    triggerBrowserDownload(srt || '', fileName, 'text/plain;charset=utf-8');
    setExportedArtifactNotice(`فایل زیرنویس زمان‌بندی‌شده (${fileName}) دانلود شد.`);
  };

  const handleExportProjectJson = () => {
    const fileName = `${cleanBaseName || 'project'}-summary.json`;
    const approvedEdlCount =
      workflowState.edlSnapshot?.proposals.filter((p) => p.status === 'APPROVED').length ?? 0;
    const summaryPayload = {
      projectTitle,
      exportedAtIso: new Date().toISOString(),
      sampleRate: projectSampleRate,
      totalDurationSec,
      wordCount: tokens.length,
      approvedEdlCount,
      edlProposalCount: workflowState.edlSnapshot?.proposals.length ?? 0,
      transcript: tokens.map((t) => ({
        text: t.displayText,
        speaker: t.speakerName || t.trackId,
        disfluency: Boolean(t.isDisfluency),
        startSec: Number(flicksToSeconds(t.range.startFlicks).toFixed(3)),
        endSec: Number(flicksToSeconds(t.range.endFlicks).toFixed(3)),
      })),
    };
    triggerBrowserDownload(
      JSON.stringify(summaryPayload, null, 2),
      fileName,
      'application/json;charset=utf-8',
    );
    setExportedArtifactNotice(`بسته خلاصه پروژه (${fileName}) دانلود شد.`);
  };

  const handleExportAuditionSesx = () => {
    const bitDepth: 16 | 24 | 32 =
      encoding === 'pcm16' ? 16 : encoding === 'pcm24' ? 24 : 32;
    const xml = buildAuditionSesxXml({
      sessionName: cleanBaseName || projectTitle,
      sampleRate: targetSampleRate,
      bitDepth,
      tracks,
      assets,
      markers,
    });
    const fileName = `${cleanBaseName || 'session'}.sesx`;
    triggerBrowserDownload(xml, fileName, 'application/xml;charset=utf-8');
    setExportedArtifactNotice(`پروژه Adobe Audition (${fileName}) آماده و دانلود شد.`);
  };

  const activeWordsCount = tokens.length;
  const approvedCutsCount =
    workflowState.edlSnapshot?.proposals.filter((p) => p.status === 'APPROVED').length ?? 0;
  const progressPct = Math.round(progress?.progressPercent ?? (isCompleted ? 100 : 0));

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      data-testid="render-export-modal"
    >
      {/* Two-Column 820px Desktop Mastering & Export Suite (Blueprint 3 - P2-2) */}
      <div className="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-2xl max-w-[820px] w-full shadow-[var(--avp-shadow-md)] overflow-hidden text-[var(--avp-text)] flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--avp-border)] bg-[var(--avp-surface-2)]/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[var(--avp-brand-soft)] border border-[var(--avp-brand)]/30 flex items-center justify-center text-[var(--avp-brand)]">
              <FileAudio className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[var(--avp-text)]">
                خروجی نهایی پروژه و مسترینگ صوت
              </h2>
              <p className="text-xs text-[var(--avp-text-secondary)]">
                دریافت فایل صوتی تدوین‌شده، متن تمیز، زیرنویس زمان‌بندی‌شده یا پروژه Audition
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره خروجی"
            className="w-8 h-8 rounded-lg text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] inline-flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Two-Column Split Body: Right = Audio Master Pipeline | Left = Instant Deliverables */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] divide-y lg:divide-y-0 lg:divide-x lg:divide-x-reverse divide-[var(--avp-border)] overflow-y-auto">
          {/* RIGHT COLUMN: Audio Master Render Pipeline */}
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--avp-text)] flex items-center gap-1.5">
                <Volume2 className="w-4 h-4 text-[var(--avp-brand)]" />
                <span>پایپ‌لاین رندر و مسترینگ فایل صوتی</span>
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[var(--avp-brand-soft)] text-[var(--avp-brand)]">
                Non-Destructive DSP
              </span>
            </div>

            {/* Project Summary Bar */}
            <div className="grid grid-cols-3 gap-2.5 p-3 rounded-xl bg-[var(--avp-bg)] border border-[var(--avp-border-subtle)] text-xs">
              <div>
                <div className="text-[11px] text-[var(--avp-text-secondary)]">مدت‌زمان پروژه</div>
                <div className="font-mono font-bold text-[var(--avp-text)] mt-0.5">
                  {totalDurationSec.toFixed(1)} ثانیه
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--avp-text-secondary)]">کلمات باقی‌مانده</div>
                <div className="font-bold text-[var(--avp-brand)] mt-0.5">
                  {activeWordsCount} کلمه
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--avp-text-secondary)]">برش‌های تأییدشده</div>
                <div className="font-bold text-[var(--avp-accent-text)] mt-0.5">
                  {approvedCutsCount} مورد
                </div>
              </div>
            </div>

            {/* Output File Name & Primary Audio Format */}
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="export-filename-input"
                  className="block text-xs font-semibold text-[var(--avp-text)] mb-1.5"
                >
                  نام فایل خروجی
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="export-filename-input"
                    type="text"
                    data-testid="input-export-filename"
                    value={customFileName}
                    disabled={isRunning}
                    onChange={(e) => setCustomFileName(e.target.value)}
                    dir="ltr"
                    className="flex-1 h-9 px-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] text-xs font-mono text-[var(--avp-text)] focus:outline-none focus:border-[var(--avp-brand)]"
                  />
                  <span
                    className="text-xs font-mono text-[var(--avp-text-secondary)] px-2.5 py-1.5 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)]"
                    dir="ltr"
                  >
                    .{fileExtension}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[var(--avp-text)] mb-1.5">
                    فرمت فایل صوتی
                  </label>
                  <select
                    data-testid="select-export-format"
                    value={encoding}
                    disabled={isRunning}
                    onChange={(e) => setEncoding(e.target.value as RenderExportEncoding)}
                    className="w-full h-9 rounded-xl bg-[var(--avp-bg)] border border-[var(--avp-border)] px-3 text-xs text-[var(--avp-text)] focus:outline-none focus:border-[var(--avp-brand)] cursor-pointer"
                  >
                    <option value="pcm16">WAV (16-bit PCM استاندارد استودیو)</option>
                    <option value="pcm24">WAV (24-bit PCM مسترینگ حرفه‌ای)</option>
                    <option value="float32">WAV (32-bit Float دامنه دینامیکی کامل)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--avp-text)] mb-1.5">
                    کیفیت و نرخ نمونه‌برداری
                  </label>
                  <select
                    data-testid="select-export-samplerate"
                    value={targetSampleRate}
                    disabled={isRunning}
                    onChange={(e) => setTargetSampleRate(Number(e.target.value) as SampleRate)}
                    className="w-full h-9 rounded-xl bg-[var(--avp-bg)] border border-[var(--avp-border)] px-3 text-xs text-[var(--avp-text)] focus:outline-none focus:border-[var(--avp-brand)] cursor-pointer"
                  >
                    <option value={48000}>۴۸,۰۰۰ هرتز (استاندارد پادکست و ویدیو)</option>
                    <option value={44100}>۴۴,۱۰۰ هرتز (استاندارد موسیقی و پخش)</option>
                    <option value={32000}>۳۲,۰۰۰ هرتز (گفتار فشرده)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Progressive Disclosure: Advanced Mastering Settings */}
            <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAdvancedMastering((v) => !v)}
                className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-semibold text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] transition-colors cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <Sliders className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
                  <span>تنظیمات پیشرفته گذار صوتی (Crossfade: {crossfadeMs}ms)</span>
                </span>
                {showAdvancedMastering ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>

              {showAdvancedMastering && (
                <div className="p-3.5 pt-2 border-t border-[var(--avp-border-subtle)] grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-[var(--avp-text-secondary)] mb-1">
                      کانتینر خروجی
                    </label>
                    <select
                      data-testid="select-export-container"
                      value={container}
                      disabled={isRunning}
                      onChange={(e) => setContainer(e.target.value as RenderExportContainer)}
                      className="w-full h-8 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-border)] px-2.5 text-xs text-[var(--avp-text)]"
                    >
                      <option value="wav">RIFF WAV استاندارد</option>
                      <option value="rf64">RF64 (فایل‌های طولانی +4GB)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-[var(--avp-text-secondary)] mb-1">
                      طول Crossfade برش‌ها
                    </label>
                    <select
                      value={crossfadeMs}
                      disabled={isRunning}
                      onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                      className="w-full h-8 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-border)] px-2.5 text-xs text-[var(--avp-text)]"
                    >
                      <option value={5}>5ms (برش تند)</option>
                      <option value={10}>10ms (استاندارد گفتار)</option>
                      <option value={18}>18ms (گذار نرم)</option>
                    </select>
                  </div>

                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2 text-xs text-[var(--avp-text)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={enableLimiter}
                        disabled={isRunning}
                        onChange={(e) => setEnableLimiter(e.target.checked)}
                        className="accent-[var(--avp-brand)]"
                      />
                      <span>محافظ پیک صدا (Limiter)</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* Render Progress & Post-Render Summary */}
            {(progress || isCompleted) && (
              <div
                data-testid="render-progress-panel"
                className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3.5 space-y-2.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--avp-text)] font-semibold flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
                    وضعیت آماده‌سازی فایل صوتی:{' '}
                    {isCompleted
                      ? 'آماده دانلود'
                      : isRunning
                        ? progress?.currentOperation || 'در حال پردازش...'
                        : renderState}
                  </span>
                  <span className="font-mono text-[var(--avp-brand)] font-bold">
                    {progressPct}%
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-[var(--avp-surface-2)] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      renderState === 'FAILED' || renderState === 'FAILED_VALIDATION'
                        ? 'bg-[var(--avp-error)]'
                        : isCompleted
                          ? 'bg-[var(--avp-success)]'
                          : 'bg-[var(--avp-brand)]'
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Post-Render Verification Result */}
            {isCompleted && result && result.output && (
              <div
                data-testid="render-post-validation-readout"
                className="rounded-xl border border-[var(--avp-success)]/35 bg-[var(--avp-success)]/10 p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--avp-success)] flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    فایل صوتی نهایی با موفقیت آماده و اعتبارسنجی شد
                  </span>
                  <span className="text-[11px] font-mono text-[var(--avp-text-secondary)]">
                    {(result.output.fileSizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="bg-[var(--avp-surface)] rounded-lg p-2 border border-[var(--avp-border-subtle)]">
                    <span className="text-[var(--avp-text-muted)] block">فرمت و بیت</span>
                    <span className="font-mono font-semibold text-[var(--avp-text)]">
                      {result.output.sampleRate}Hz / {result.output.bitsPerSample}b
                    </span>
                  </div>
                  <div className="bg-[var(--avp-surface)] rounded-lg p-2 border border-[var(--avp-border-subtle)]">
                    <span className="text-[var(--avp-text-muted)] block">پیک صدا</span>
                    <span className="font-mono font-semibold text-[var(--avp-text)]">
                      {result.output.truePeakDbfs.toFixed(2)} dBFS
                    </span>
                  </div>
                  <div className="bg-[var(--avp-surface)] rounded-lg p-2 border border-[var(--avp-border-subtle)]">
                    <span className="text-[var(--avp-text-muted)] block">مدت‌زمان نهایی</span>
                    <span className="font-mono font-semibold text-[var(--avp-text)]">
                      {result.output.durationSec.toFixed(2)}s
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Failure Readout */}
            {workflowState.exportError && (
              <div className="rounded-xl border border-[var(--avp-error)]/40 bg-[var(--avp-error)]/10 p-3 flex items-start gap-2.5 text-xs text-[var(--avp-error)]">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="font-bold">{workflowState.exportError}</div>
              </div>
            )}
          </div>

          {/* LEFT COLUMN: Instant Script, Subtitle & DAW Project Deliverables */}
          <div className="p-5 bg-[var(--avp-surface-2)]/40 flex flex-col justify-between gap-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[var(--avp-text)] flex items-center gap-1.5">
                  <FileCode2 className="w-4 h-4 text-[var(--avp-brand)]" />
                  <span>خروجی‌های فوری متن، زیرنویس و پروژه</span>
                </span>
                <span className="text-[10px] text-[var(--avp-text-muted)] font-mono">
                  1-Click Export
                </span>
              </div>

              <p className="text-[11px] text-[var(--avp-text-secondary)] leading-relaxed">
                این خروجی‌ها بدون نیاز به انتظار برای رندر صوتی، مستقیماً از روی کلمات فعال و برش‌های تدوین (EDL) تولید می‌شوند:
              </p>

              <div className="space-y-2">
                {/* 1. Adobe Audition (.sesx) */}
                <button
                  type="button"
                  data-testid="btn-export-audition-sesx"
                  onClick={handleExportAuditionSesx}
                  className="w-full p-2.5 rounded-xl border border-[var(--avp-brand)]/35 bg-[var(--avp-brand-soft)]/50 hover:bg-[var(--avp-brand-soft)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-brand)]/30 flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                      <FileCode2 className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[var(--avp-text)]">
                        پروژه Adobe Audition (.sesx)
                      </div>
                      <div className="text-[10px] text-[var(--avp-text-secondary)] truncate">
                        شامل تمام برش‌های کلیپ، Crossfade و مارکرها
                      </div>
                    </div>
                  </div>
                  <Download className="w-3.5 h-3.5 text-[var(--avp-brand)] shrink-0" />
                </button>

                {/* 2. SRT Subtitles */}
                <button
                  type="button"
                  data-testid="btn-export-srt"
                  onClick={handleExportSrt}
                  className="w-full p-2.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-hover)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                      <Subtitles className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[var(--avp-text)]">
                        زیرنویس زمان‌بندی‌شده (.srt)
                      </div>
                      <div className="text-[10px] text-[var(--avp-text-secondary)] truncate">
                        هماهنگ با تایم‌کد کلمات فعال
                      </div>
                    </div>
                  </div>
                  <Download className="w-3.5 h-3.5 text-[var(--avp-text-secondary)] shrink-0" />
                </button>

                {/* 3. Clean Transcript (.txt) */}
                <button
                  type="button"
                  data-testid="btn-export-clean-txt"
                  onClick={handleExportCleanText}
                  className="w-full p-2.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-hover)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[var(--avp-text)]">
                        متن تمیز تدوین‌شده (.txt)
                      </div>
                      <div className="text-[10px] text-[var(--avp-text-secondary)] truncate">
                        متن پاکیزه تفکیک‌شده بر اساس گوینده
                      </div>
                    </div>
                  </div>
                  <Download className="w-3.5 h-3.5 text-[var(--avp-text-secondary)] shrink-0" />
                </button>

                {/* 4. Project Summary JSON */}
                <button
                  type="button"
                  data-testid="btn-export-project-json"
                  onClick={handleExportProjectJson}
                  className="w-full p-2.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-hover)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                      <Braces className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[var(--avp-text)]">
                        خلاصه پروژه (.json)
                      </div>
                      <div className="text-[10px] text-[var(--avp-text-secondary)] truncate">
                        تایم‌کد کامل کلمات و آمار برش‌ها
                      </div>
                    </div>
                  </div>
                  <Download className="w-3.5 h-3.5 text-[var(--avp-text-secondary)] shrink-0" />
                </button>
              </div>
            </div>

            {exportedArtifactNotice && (
              <div
                role="status"
                className="px-3 py-2 rounded-lg bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] text-xs font-medium flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>{exportedArtifactNotice}</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4 border-t border-[var(--avp-border)] bg-[var(--avp-surface-2)]/60">
          <div className="flex items-center gap-2">
            {isRunning && (
              <>
                <button
                  type="button"
                  onClick={onPauseRender}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--avp-warning)]/40 bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] text-xs font-medium cursor-pointer"
                >
                  <Pause className="w-3.5 h-3.5" />
                  مکث
                </button>
                <button
                  type="button"
                  onClick={onCancelRender}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--avp-error)]/40 bg-[var(--avp-error)]/10 text-[var(--avp-error)] text-xs font-medium cursor-pointer"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  لغو
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs font-medium text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] transition-colors cursor-pointer"
            >
              بستن
            </button>

            {isCompleted && result && (
              <button
                type="button"
                data-testid="btn-download-validated-audio"
                onClick={() => void handleDownloadValidatedAudio()}
                className="flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--avp-success)] hover:opacity-95 text-white text-xs font-bold shadow-[var(--avp-shadow-xs)] transition-all cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>دانلود فایل صوتی ({finalAudioFileName})</span>
              </button>
            )}

            <button
              type="button"
              data-testid="btn-start-mission06-render"
              disabled={isRunning}
              onClick={() =>
                void onStartRender(
                  {
                    encoding,
                    container,
                    targetSampleRate,
                    defaultCrossfadeMs: crossfadeMs,
                    enableTransitionLimiter: enableLimiter,
                  },
                  false,
                )
              }
              className="flex items-center gap-1.5 h-9 px-5 rounded-xl bg-[var(--avp-brand)] hover:bg-[var(--avp-brand-hover)] disabled:opacity-50 text-white text-xs font-bold shadow-[var(--avp-shadow-xs)] transition-all cursor-pointer"
            >
              {isCompleted ? (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>آماده‌سازی مجدد فایل صوتی</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>آماده‌سازی فایل صوتی نهایی</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
