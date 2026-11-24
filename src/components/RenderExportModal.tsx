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
import { AccessibleModal } from './AccessibleModal';
import { ExportProgressIndicator } from './ExportProgressIndicator';
import {
  formatNumberForLocale,
  mapExportDefaultFormatToRenderConfig,
  sanitizeExportFileName,
} from '../utils/formatters';

interface RenderExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowState: StudioWorkflowState;
  locale?: 'fa' | 'en';
  persianDigits?: boolean;
  projectTitle?: string;
  projectSampleRate: SampleRate;
  totalDurationSec: number;
  tracks?: Track[];
  assets?: Record<string, AudioAsset>;
  tokens?: PersianWordToken[];
  markers?: AuditionChapterMarker[];
  defaultFormat?: ExportDefaultFormat;
  defaultSampleRate?: SampleRate;
  defaultCrossfadeMs?: 0 | 5 | 10 | 15;
  defaultFilenamePrefix?: string;
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

function buildCleanTranscriptText(tokens: PersianWordToken[], isFa: boolean): string {
  const active = tokens.filter((t) => !t.isCrosstalkSuppressed);
  if (active.length === 0) return '';
  const fallbackSpeaker = isFa ? 'گوینده ۱' : 'Speaker 1';
  const paragraphs: string[] = [];
  let currentSpeaker = active[0].speakerName || active[0].trackId || fallbackSpeaker;
  let bucket: string[] = [];

  for (const tok of active) {
    const spk = tok.speakerName || tok.trackId || fallbackSpeaker;
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
  locale,
  persianDigits = false,
  projectTitle = 'پروژه آواپرداز',
  projectSampleRate,
  totalDurationSec,
  tracks = [],
  assets = {},
  tokens = [],
  markers = [],
  defaultFormat = 'WAV_PCM16',
  defaultSampleRate,
  defaultCrossfadeMs = 10,
  defaultFilenamePrefix = '',
  onStartRender,
  onPauseRender,
  onCancelRender,
  onMarkDownloaded,
}) => {
  const effectiveLocale = locale ?? workflowState.locale ?? 'fa';
  const isFa = effectiveLocale === 'fa';

  const mappedDefaults = useMemo(
    () => mapExportDefaultFormatToRenderConfig(defaultFormat),
    [defaultFormat],
  );

  const [encoding, setEncoding] = useState<RenderExportEncoding>(mappedDefaults.encoding);
  const [container, setContainer] = useState<RenderExportContainer>(mappedDefaults.container);
  const [targetSampleRate, setTargetSampleRate] = useState<SampleRate>(
    defaultSampleRate ?? projectSampleRate,
  );
  const [crossfadeMs, setCrossfadeMs] = useState<number>(defaultCrossfadeMs);
  const [enableLimiter, setEnableLimiter] = useState<boolean>(true);
  const [showAdvancedMastering, setShowAdvancedMastering] = useState(false);

  const sanitizedDefaultName = useMemo(
    () => sanitizeExportFileName(projectTitle, defaultFilenamePrefix),
    [projectTitle, defaultFilenamePrefix],
  );

  const [customFileName, setCustomFileName] = useState<string>(sanitizedDefaultName);
  const [exportedArtifactNotice, setExportedArtifactNotice] = useState<string | null>(null);

  useEffect(() => {
    setCustomFileName(sanitizedDefaultName);
  }, [sanitizedDefaultName]);

  useEffect(() => {
    setEncoding(mappedDefaults.encoding);
    setContainer(mappedDefaults.container);
  }, [mappedDefaults]);

  useEffect(() => {
    setTargetSampleRate(defaultSampleRate ?? projectSampleRate);
  }, [defaultSampleRate, projectSampleRate]);

  useEffect(() => {
    setCrossfadeMs(defaultCrossfadeMs);
  }, [defaultCrossfadeMs]);

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
    setExportedArtifactNotice(
      isFa
        ? `فایل صوتی نهایی (${finalAudioFileName}) دانلود شد.`
        : `Final audio exported (${finalAudioFileName}).`,
    );
  };

  const handleExportCleanText = () => {
    const text = buildCleanTranscriptText(tokens, isFa);
    const fileName = `${cleanBaseName || 'transcript'}.txt`;
    triggerBrowserDownload(
      text || (isFa ? 'متنی برای خروجی یافت نشد.' : 'No transcript words available.'),
      fileName,
      'text/plain;charset=utf-8',
    );
    setExportedArtifactNotice(
      isFa
        ? `متن نهایی تدوین‌شده (${fileName}) دانلود شد.`
        : `Clean transcript exported (${fileName}).`,
    );
  };

  const handleExportSrt = () => {
    const srt = buildSrtSubtitles(tokens);
    const fileName = `${cleanBaseName || 'subtitles'}.srt`;
    triggerBrowserDownload(srt || '', fileName, 'text/plain;charset=utf-8');
    setExportedArtifactNotice(
      isFa
        ? `فایل زیرنویس زمان‌بندی‌شده (${fileName}) دانلود شد.`
        : `Timed subtitles exported (${fileName}).`,
    );
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
    setExportedArtifactNotice(
      isFa ? `بسته خلاصه پروژه (${fileName}) دانلود شد.` : `Project summary exported (${fileName}).`,
    );
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
    setExportedArtifactNotice(
      isFa
        ? `پروژه Adobe Audition (${fileName}) آماده و دانلود شد.`
        : `Adobe Audition session (${fileName}) downloaded.`,
    );
  };

  const activeWordsCount = tokens.length;
  const approvedCutsCount =
    workflowState.edlSnapshot?.proposals.filter((p) => p.status === 'APPROVED').length ?? 0;

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdropClick={!isRunning}
      disableEscape={isRunning}
      dir={isFa ? 'rtl' : 'ltr'}
      labelledBy="render-export-modal-title"
      dataTestId="render-export-modal"
      panelClassName="bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-2xl max-w-[820px] w-full shadow-[var(--avp-shadow-md)] overflow-hidden text-[var(--avp-text)] flex flex-col max-h-[90vh]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--avp-border)] bg-[var(--avp-surface-2)]/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--avp-brand-soft)] border border-[var(--avp-brand)]/30 flex items-center justify-center text-[var(--avp-brand)]">
            <FileAudio className="w-5 h-5" />
          </div>
          <div>
            <h2 id="render-export-modal-title" className="text-base font-bold text-[var(--avp-text)]">
              {isFa ? 'خروجی نهایی پروژه و مسترینگ صوت' : 'Final Export & Audio Mastering'}
            </h2>
            <p className="text-xs text-[var(--avp-text-secondary)]">
              {isFa
                ? 'دریافت فایل صوتی تدوین‌شده، متن تمیز، زیرنویس زمان‌بندی‌شده یا پروژه Audition'
                : 'Export mastered WAV/RF64 audio, clean transcript, SRT subtitles, or Audition session'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={isFa ? 'بستن پنجره خروجی' : 'Close export dialog'}
          className="avp-touch-icon rounded-lg text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] inline-flex items-center justify-center transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Two-Column Split Body */}
      <div
        className={`grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] divide-y lg:divide-y-0 lg:divide-x ${
          isFa ? 'lg:divide-x-reverse' : ''
        } divide-[var(--avp-border)] overflow-y-auto`}
      >
        {/* Audio Master Render Pipeline */}
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--avp-text)] flex items-center gap-1.5">
              <Volume2 className="w-4 h-4 text-[var(--avp-brand)]" />
              <span>{isFa ? 'پایپ‌لاین رندر و مسترینگ فایل صوتی' : 'Audio Render & Mastering Pipeline'}</span>
            </span>
            <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-[var(--avp-brand-soft)] text-[var(--avp-accent-text)]">
              {isFa ? 'پردازش غیرمخرب' : 'Non-Destructive DSP'}
            </span>
          </div>

          {/* Project Summary Bar */}
          <div className="grid grid-cols-3 gap-2.5 p-3 rounded-xl bg-[var(--avp-bg)] border border-[var(--avp-border-subtle)] text-xs">
            <div>
              <div className="text-[11px] text-[var(--avp-text-secondary)]">
                {isFa ? 'مدت‌زمان پروژه' : 'Duration'}
              </div>
              <div className="font-mono font-bold text-[var(--avp-text)] mt-0.5 tabular-nums">
                {formatNumberForLocale(totalDurationSec, { persianDigits, maximumFractionDigits: 1 })}{' '}
                {isFa ? 'ثانیه' : 's'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--avp-text-secondary)]">
                {isFa ? 'کلمات باقی‌مانده' : 'Active Words'}
              </div>
              <div className="font-bold text-[var(--avp-brand)] mt-0.5 tabular-nums">
                {formatNumberForLocale(activeWordsCount, { persianDigits })} {isFa ? 'کلمه' : 'words'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--avp-text-secondary)]">
                {isFa ? 'برش‌های تأییدشده' : 'Approved Cuts'}
              </div>
              <div className="font-bold text-[var(--avp-accent-text)] mt-0.5 tabular-nums">
                {formatNumberForLocale(approvedCutsCount, { persianDigits })} {isFa ? 'مورد' : 'edits'}
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
                {isFa ? 'نام فایل خروجی' : 'Output File Name'}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="export-filename-input"
                  type="text"
                  data-testid="input-export-filename"
                  value={customFileName}
                  disabled={isRunning}
                  onChange={(e) => setCustomFileName(e.target.value)}
                  dir="auto"
                  className="flex-1 min-h-[44px] sm:min-h-[36px] sm:h-9 px-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] text-xs text-[var(--avp-text)] focus:outline-none focus:border-[var(--avp-brand)]"
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
                <label
                  htmlFor="select-export-format"
                  className="block text-xs font-semibold text-[var(--avp-text)] mb-1.5"
                >
                  {isFa ? 'فرمت فایل صوتی' : 'Audio Encoding'}
                </label>
                <select
                  id="select-export-format"
                  data-testid="select-export-format"
                  value={encoding}
                  disabled={isRunning}
                  onChange={(e) => setEncoding(e.target.value as RenderExportEncoding)}
                  className="w-full min-h-[44px] sm:min-h-[36px] sm:h-9 rounded-xl bg-[var(--avp-bg)] border border-[var(--avp-border)] px-3 text-xs text-[var(--avp-text)] focus:outline-none focus:border-[var(--avp-brand)] cursor-pointer"
                >
                  <option value="pcm16">
                    {isFa ? 'WAV · 16-bit PCM (استاندارد)' : 'WAV · 16-bit PCM (Standard)'}
                  </option>
                  <option value="pcm24">
                    {isFa ? 'WAV · 24-bit PCM (مسترینگ)' : 'WAV · 24-bit PCM (Mastering)'}
                  </option>
                  <option value="float32">
                    {isFa ? 'WAV · 32-bit Float (داینامیک کامل)' : 'WAV · 32-bit Float (Full Range)'}
                  </option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="select-export-samplerate"
                  className="block text-xs font-semibold text-[var(--avp-text)] mb-1.5"
                >
                  {isFa ? 'نرخ نمونه‌برداری' : 'Sample Rate'}
                </label>
                <select
                  id="select-export-samplerate"
                  data-testid="select-export-samplerate"
                  value={targetSampleRate}
                  disabled={isRunning}
                  onChange={(e) => setTargetSampleRate(Number(e.target.value) as SampleRate)}
                  className="w-full min-h-[44px] sm:min-h-[36px] sm:h-9 rounded-xl bg-[var(--avp-bg)] border border-[var(--avp-border)] px-3 text-xs text-[var(--avp-text)] focus:outline-none focus:border-[var(--avp-brand)] cursor-pointer"
                >
                  <option value={48000}>
                    {isFa ? '48 kHz · استودیو و پادکست' : '48 kHz · Studio / Podcast'}
                  </option>
                  <option value={44100}>
                    {isFa ? '44.1 kHz · استاندارد پخش' : '44.1 kHz · CD / Broadcast'}
                  </option>
                  <option value={32000}>
                    {isFa ? '32 kHz · گفتار فشرده' : '32 kHz · Compact Speech'}
                  </option>
                  <option value={16000}>
                    {isFa ? '16 kHz · پردازش گفتار' : '16 kHz · Speech ASR'}
                  </option>
                </select>
              </div>
            </div>
          </div>

          {/* Progressive Disclosure: Advanced Mastering Settings */}
          <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] overflow-hidden">
            <button
              type="button"
              aria-expanded={showAdvancedMastering}
              onClick={() => setShowAdvancedMastering((v) => !v)}
              className="w-full min-h-[44px] sm:min-h-[40px] px-3.5 py-2.5 flex items-center justify-between text-xs font-semibold text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] transition-colors cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
                <span>
                  {isFa
                    ? `تنظیمات پیشرفته گذار صوتی (Crossfade: ${formatNumberForLocale(crossfadeMs, { persianDigits })}ms)`
                    : `Advanced Mastering & Splice Crossfade (${crossfadeMs}ms)`}
                </span>
              </span>
              {showAdvancedMastering ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvancedMastering && (
              <div className="p-3.5 pt-2 border-t border-[var(--avp-border-subtle)] grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label
                    htmlFor="select-export-container"
                    className="block text-[11px] font-medium text-[var(--avp-text-secondary)] mb-1"
                  >
                    {isFa ? 'کانتینر خروجی' : 'Container'}
                  </label>
                  <select
                    id="select-export-container"
                    data-testid="select-export-container"
                    value={container}
                    disabled={isRunning}
                    onChange={(e) => setContainer(e.target.value as RenderExportContainer)}
                    className="w-full min-h-[44px] sm:min-h-[34px] sm:h-8 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-border)] px-2.5 text-xs text-[var(--avp-text)]"
                  >
                    <option value="wav">{isFa ? 'RIFF WAV استاندارد' : 'Standard RIFF WAV'}</option>
                    <option value="rf64">{isFa ? 'RF64 (فایل +4GB)' : 'RF64 (>4GB Long Audio)'}</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="select-export-crossfade"
                    className="block text-[11px] font-medium text-[var(--avp-text-secondary)] mb-1"
                  >
                    {isFa ? 'طول Crossfade برش‌ها' : 'Splice Crossfade'}
                  </label>
                  <select
                    id="select-export-crossfade"
                    data-testid="select-export-crossfade"
                    value={crossfadeMs}
                    disabled={isRunning}
                    onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                    className="w-full min-h-[44px] sm:min-h-[34px] sm:h-8 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-border)] px-2.5 text-xs text-[var(--avp-text)]"
                  >
                    <option value={0}>{isFa ? '0ms (بدون محوشدگی)' : '0ms (Hard Cut)'}</option>
                    <option value={5}>{isFa ? '5ms (برش تند)' : '5ms (Tight)'}</option>
                    <option value={10}>{isFa ? '10ms (استاندارد گفتار)' : '10ms (Speech Standard)'}</option>
                    <option value={15}>{isFa ? '15ms (گذار نرم)' : '15ms (Smooth)'}</option>
                    <option value={18}>{isFa ? '18ms (خیلی نرم)' : '18ms (Extra Smooth)'}</option>
                  </select>
                </div>

                <div className="flex items-end pb-1">
                  <label
                    htmlFor="checkbox-export-limiter"
                    className="min-h-[44px] sm:min-h-0 flex items-center gap-2 text-xs text-[var(--avp-text)] cursor-pointer"
                  >
                    <input
                      id="checkbox-export-limiter"
                      type="checkbox"
                      checked={enableLimiter}
                      disabled={isRunning}
                      onChange={(e) => setEnableLimiter(e.target.checked)}
                      className="w-4 h-4 accent-[var(--avp-brand)]"
                    />
                    <span>{isFa ? 'محافظ پیک صدا (Limiter)' : 'Peak Limiter'}</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Export Progress Bar & Live Status Indicator (always visible across all lifecycle states) */}
          <ExportProgressIndicator
            testId="render-progress-panel"
            state={renderState}
            progressPercent={progress?.progressPercent ?? (isCompleted ? 100 : 0)}
            currentOperation={progress?.currentOperation ?? null}
            errorMessage={workflowState.exportError ?? null}
            currentSegmentIndex={progress?.currentSegmentIndex ?? null}
            totalSegments={progress?.totalSegments ?? null}
            elapsedMs={progress?.elapsedMs ?? null}
            locale={effectiveLocale}
            persianDigits={persianDigits}
          />

          {/* Post-Render Verification Result */}
          {isCompleted && result && result.output && (
            <div
              data-testid="render-post-validation-readout"
              className="rounded-xl border border-[var(--avp-success)]/35 bg-[var(--avp-success-soft)] p-3.5 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[var(--avp-success-text)] flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  {isFa
                    ? 'فایل صوتی نهایی با موفقیت آماده و اعتبارسنجی شد'
                    : 'Final audio rendered & validated successfully'}
                </span>
                <span className="text-[11px] font-mono text-[var(--avp-text-secondary)] tabular-nums" dir="ltr">
                  {(result.output.fileSizeBytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <div className="bg-[var(--avp-surface)] rounded-lg p-2 border border-[var(--avp-border-subtle)]">
                  <span className="text-[var(--avp-text-muted)] block">
                    {isFa ? 'فرمت و بیت' : 'Format / Bit'}
                  </span>
                  <span className="font-mono font-semibold text-[var(--avp-text)]" dir="ltr">
                    {result.output.sampleRate}Hz / {result.output.bitsPerSample}b
                  </span>
                </div>
                <div className="bg-[var(--avp-surface)] rounded-lg p-2 border border-[var(--avp-border-subtle)]">
                  <span className="text-[var(--avp-text-muted)] block">
                    {isFa ? 'پیک صدا' : 'True Peak'}
                  </span>
                  <span className="font-mono font-semibold text-[var(--avp-text)]" dir="ltr">
                    {result.output.truePeakDbfs.toFixed(2)} dBFS
                  </span>
                </div>
                <div className="bg-[var(--avp-surface)] rounded-lg p-2 border border-[var(--avp-border-subtle)]">
                  <span className="text-[var(--avp-text-muted)] block">
                    {isFa ? 'مدت‌زمان نهایی' : 'Duration'}
                  </span>
                  <span className="font-mono font-semibold text-[var(--avp-text)]" dir="ltr">
                    {result.output.durationSec.toFixed(2)}s
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Failure Readout */}
          {workflowState.exportError && (
            <div className="rounded-xl border border-[var(--avp-error)]/40 bg-[var(--avp-error-soft)] p-3 flex items-start gap-2.5 text-xs text-[var(--avp-error)]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="font-bold">{workflowState.exportError}</div>
            </div>
          )}
        </div>

        {/* Instant Script, Subtitle & DAW Project Deliverables */}
        <div className="p-5 bg-[var(--avp-surface-2)]/40 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--avp-text)] flex items-center gap-1.5">
                <FileCode2 className="w-4 h-4 text-[var(--avp-brand)]" />
                <span>
                  {isFa ? 'خروجی‌های فوری متن، زیرنویس و پروژه' : 'Instant Text, Subtitle & Project Files'}
                </span>
              </span>
              <span className="text-[11px] text-[var(--avp-text-muted)] font-mono">
                {isFa ? 'خروجی فوری' : '1-Click Export'}
              </span>
            </div>

            <p className="text-[11px] text-[var(--avp-text-secondary)] leading-relaxed">
              {isFa
                ? 'این خروجی‌ها بدون نیاز به انتظار برای رندر صوتی، مستقیماً از روی کلمات فعال و برش‌های تدوین (EDL) تولید می‌شوند:'
                : 'Generated immediately from your active transcript words and EDL edits without waiting for audio rendering:'}
            </p>

            <div className="space-y-2">
              <button
                type="button"
                data-testid="btn-export-audition-sesx"
                onClick={handleExportAuditionSesx}
                className="w-full min-h-[44px] p-2.5 rounded-xl border border-[var(--avp-brand)]/35 bg-[var(--avp-brand-soft)]/50 hover:bg-[var(--avp-brand-soft)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface)] border border-[var(--avp-brand)]/30 flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                    <FileCode2 className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-[var(--avp-text)]">
                      {isFa ? 'پروژه Adobe Audition (.sesx)' : 'Adobe Audition Session (.sesx)'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)] truncate">
                      {isFa
                        ? 'شامل تمام برش‌های کلیپ، Crossfade و مارکرها'
                        : 'Includes all clip cuts, crossfades & markers'}
                    </div>
                  </div>
                </div>
                <Download className="w-3.5 h-3.5 text-[var(--avp-brand)] shrink-0" aria-hidden="true" />
              </button>
              <p className="text-[11px] text-[var(--avp-text-muted)] px-1 leading-relaxed">
                {isFa
                  ? 'نکته Adobe Audition: فایل صوتی خروجی را در پوشه media/ کنار فایل .sesx قرار دهید تا مسیر ترک‌ها خودکار بارگذاری شود.'
                  : 'Adobe Audition tip: Place your exported audio inside a sibling media/ folder next to the .sesx file so tracks relink automatically.'}
              </p>

              <button
                type="button"
                data-testid="btn-export-srt"
                onClick={handleExportSrt}
                className="w-full min-h-[44px] p-2.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-hover)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                    <Subtitles className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-[var(--avp-text)]">
                      {isFa ? 'زیرنویس زمان‌بندی‌شده (.srt)' : 'Timed Subtitles (.srt)'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)] truncate">
                      {isFa ? 'هماهنگ با تایم‌کد کلمات فعال' : 'Synchronized to active word timestamps'}
                    </div>
                  </div>
                </div>
                <Download className="w-3.5 h-3.5 text-[var(--avp-text-secondary)] shrink-0" />
              </button>

              <button
                type="button"
                data-testid="btn-export-clean-txt"
                onClick={handleExportCleanText}
                className="w-full min-h-[44px] p-2.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-hover)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-[var(--avp-text)]">
                      {isFa ? 'متن تمیز تدوین‌شده (.txt)' : 'Clean Edited Transcript (.txt)'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)] truncate">
                      {isFa ? 'متن پاکیزه تفکیک‌شده بر اساس گوینده' : 'Speaker-separated clean transcript'}
                    </div>
                  </div>
                </div>
                <Download className="w-3.5 h-3.5 text-[var(--avp-text-secondary)] shrink-0" />
              </button>

              <button
                type="button"
                data-testid="btn-export-project-json"
                onClick={handleExportProjectJson}
                className="w-full min-h-[44px] p-2.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-hover)] text-start transition-colors flex items-center justify-between gap-2.5 cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] flex items-center justify-center text-[var(--avp-brand)] shrink-0">
                    <Braces className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-[var(--avp-text)]">
                      {isFa ? 'خلاصه پروژه (.json)' : 'Project Metadata Summary (.json)'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)] truncate">
                      {isFa ? 'تایم‌کد کامل کلمات و آمار برش‌ها' : 'Word timestamps & edit cut statistics'}
                    </div>
                  </div>
                </div>
                <Download className="w-3.5 h-3.5 text-[var(--avp-text-secondary)] shrink-0" />
              </button>
            </div>
          </div>

          <div role="status" aria-live="polite" aria-atomic="true">
            {exportedArtifactNotice && (
              <div className="px-3 py-2 rounded-lg bg-[var(--avp-brand-soft)] text-[var(--avp-accent-text)] text-xs font-medium flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{exportedArtifactNotice}</span>
              </div>
            )}
          </div>
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
                className="avp-btn avp-btn-warning-tonal min-h-[44px] sm:min-h-[36px]"
              >
                <Pause className="w-3.5 h-3.5" />
                {isFa ? 'مکث' : 'Pause'}
              </button>
              <button
                type="button"
                onClick={onCancelRender}
                className="avp-btn avp-btn-danger-ghost border border-[var(--avp-error)]/40 min-h-[44px] sm:min-h-[36px]"
              >
                <XCircle className="w-3.5 h-3.5" />
                {isFa ? 'لغو' : 'Cancel'}
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[36px]"
          >
            {isFa ? 'بستن' : 'Close'}
          </button>

          {isCompleted && result && (
            <button
              type="button"
              data-testid="btn-download-validated-audio"
              onClick={() => void handleDownloadValidatedAudio()}
              className="avp-btn min-h-[44px] sm:min-h-[36px] bg-[var(--avp-success)] hover:opacity-95 text-white font-bold shadow-[var(--avp-shadow-xs)]"
            >
              <Download className="w-3.5 h-3.5" />
              <span>
                {isFa ? `دانلود فایل صوتی (${finalAudioFileName})` : `Download Audio (${finalAudioFileName})`}
              </span>
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
            className="avp-btn avp-btn-primary px-5 min-h-[44px] sm:min-h-[36px] shadow-[var(--avp-shadow-xs)]"
          >
            {isCompleted ? (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isFa ? 'آماده‌سازی مجدد فایل صوتی' : 'Re-render Audio'}</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>{isFa ? 'آماده‌سازی فایل صوتی نهایی' : 'Render Final Audio'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </AccessibleModal>
  );
};
