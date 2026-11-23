import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  Download,
  Edit3,
  FileDiff,
  FileText,
  Gauge,
  Hash,
  ListTree,
  Loader2,
  Mic,
  Scissors,
  Search,
  ShieldAlert,
  Sparkles,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import {
  PersianWordToken,
  RecommendationActionMode,
  Track,
} from '../contracts/v1_2';
import { flicksToSeconds, secondsToFlicks } from '../engine/timebase';
import {
  computeMultiWordCutRange,
  determineSyncSafeEditMode,
} from '../engine/timeline';
import { resolveSpeakerTurnLabel } from '../utils/transcriptDisplay';
import {
  compareReferenceScriptWithTranscript,
  computeTrilingualTranscriptStats,
  exportTranscriptToPraatTextGrid,
  exportTranscriptToSrt,
  exportTranscriptToVtt,
  ProsodyAndChaptersReport,
  searchTranscriptPhonetically,
} from '../engine/persianAsrTranscriber';
import { EnglishScriptRenderMode } from '../ai-engine/asr/MultilingualCodeSwitchAndArabicEngine';
import { AudioRedactionMaskMode } from '../../packages/audio-runtime/src/SensitiveContentAndPiiRedactorEngine';
import type { CompanionHealthResponse } from '../host-bridge/companion/CompanionWebClient';
import type { ShahabLocalRuntimeStatusResponse } from '../asr-core/ShahabLocalHttpClient';

type TranscriptLayer = 'display' | 'normalized' | 'original';

export interface AsrInlineFeedbackState {
  readonly kind:
    | 'MODEL_NOT_INSTALLED'
    | 'CLOUD_UNCONFIGURED'
    | 'INFERENCE_ERROR'
    | 'NO_SPEECH'
    | 'READ_ONLY'
    | 'AUDIO_MISSING'
    | 'SUCCESS';
  readonly titleFa: string;
  readonly messageFa: string;
}

interface TranscriptPanelProps {
  tokens: PersianWordToken[];
  tracks: Track[];
  pcmSources?: Record<string, Float32Array>;
  sampleRate?: number;
  playheadSec: number;
  totalDurationSec?: number;
  isTranscribingAsr?: boolean;
  executionMode?: 'LOCAL' | 'CLOUD';
  cloudAsrConfigured?: boolean;
  companionHealth?: CompanionHealthResponse | null;
  isCheckingCompanion?: boolean;
  isInstallingNativeAsr?: boolean;
  hasBrowserInstalledModel?: boolean;
  shahabRuntimeStatus?: ShahabLocalRuntimeStatusResponse | null;
  isInstallingBrowserModel?: boolean;
  browserModelInstallPct?: number | null;
  projectSessionNonce?: number;
  asrInlineFeedback?: AsrInlineFeedbackState | null;
  onDismissAsrInlineFeedback?: () => void;
  onRetryCompanionConnection?: () => void;
  onInstallNativeCompanionEngine?: () => void;
  onInstallBrowserPersianModel?: (autoRunAfter?: boolean) => void;
  onLoadAndTranscribeSamplePersianAudio?: () => void;
  onRunCloudGeminiAsr?: () => void;
  onRunAcousticSegmentation?: () => void;
  onOpenLocalModelInstaller?: () => void;
  onSwitchToLocalExecutionMode?: () => void;
  onSeekSec: (sec: number) => void;
  onCutSelectedWords: (
    selectedTokenIds: string[],
    explicitMode?: RecommendationActionMode,
  ) => boolean | void;
  onUpdateTokenDisplayText: (tokenId: string, newDisplayText: string) => void;
  onRunPersianAsr: () => void;
  onRunForcedAlignment: (customPersianScript: string, targetTrackId: string) => void;
  onRestoreProsodicPunctuation?: () => void;
  onConvertColloquialToFormal?: () => void;
  onNormalizeNumbersAndCompounds?: () => void;
  onRedactSelectedWords?: (
    selectedTokenIds: string[],
    mode: AudioRedactionMaskMode,
  ) => boolean | void;
  prosodyAndChaptersReport?: ProsodyAndChaptersReport | null;
  onApplyCustomLexicon?: (customVocabularyCsv: string) => void;
  onWsolaTimeStretchSelectedWords?: (
    selectedTokenIds: string[],
    tempoRatio: number,
  ) => boolean | void;
  onPunchInSpectralMatchSelectedWords?: (selectedTokenIds: string[]) => boolean | void;
  onOptimizeTrilingualAsr?: (mode: EnglishScriptRenderMode) => void;
  englishRenderMode?: EnglishScriptRenderMode;
}

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  tokens,
  tracks,
  pcmSources,
  sampleRate,
  playheadSec,
  totalDurationSec = 12,
  isTranscribingAsr = false,
  executionMode = 'LOCAL',
  cloudAsrConfigured = false,
  companionHealth = null,
  isCheckingCompanion = false,
  isInstallingNativeAsr = false,
  hasBrowserInstalledModel = false,
  shahabRuntimeStatus = null,
  isInstallingBrowserModel = false,
  browserModelInstallPct = null,
  projectSessionNonce = 0,
  asrInlineFeedback = null,
  onDismissAsrInlineFeedback,
  onRetryCompanionConnection,
  onInstallNativeCompanionEngine,
  onInstallBrowserPersianModel,
  onLoadAndTranscribeSamplePersianAudio,
  onRunCloudGeminiAsr,
  onRunAcousticSegmentation,
  onOpenLocalModelInstaller,
  onSwitchToLocalExecutionMode,
  onSeekSec,
  onCutSelectedWords,
  onUpdateTokenDisplayText,
  onRunPersianAsr,
  onRunForcedAlignment,
  onRestoreProsodicPunctuation,
  onConvertColloquialToFormal,
  onNormalizeNumbersAndCompounds,
  onRedactSelectedWords,
  prosodyAndChaptersReport,
  onApplyCustomLexicon,
  onWsolaTimeStretchSelectedWords,
  onPunchInSpectralMatchSelectedWords,
  onOptimizeTrilingualAsr,
  englishRenderMode = 'LATIN_TECHNICAL',
}) => {
  const [layer, setLayer] = useState<TranscriptLayer>('display');
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingTextValue, setEditingTextValue] = useState<string>('');
  const [showForcedAlignDrawer, setShowForcedAlignDrawer] = useState<boolean>(false);
  const [forcedAlignError, setForcedAlignError] = useState<string | null>(null);
  const forcedAlignInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [forcedAlignTrackId, setForcedAlignTrackId] = useState<string>(
    () => tracks[0]?.id ?? 'track-host',
  );
  const [customScriptText, setCustomScriptText] = useState<string>(() =>
    tokens
      .filter((t) => t.trackId === (tracks[0]?.id ?? 'track-host'))
      .map((t) => t.displayText)
      .join(' '),
  );
  const [phoneticQuery, setPhoneticQuery] = useState<string>('');
  const [subtitlePreviewMode, setSubtitlePreviewMode] = useState<
    'none' | 'srt' | 'vtt' | 'textgrid'
  >('none');
  const [showScriptDiffDrawer, setShowScriptDiffDrawer] = useState<boolean>(false);
  const [referenceBookScript, setReferenceBookScript] = useState<string>(
    'سلام امروز پادکست جذاب ما درباره هوش مصنوعی صحبت می‌کنیم و نتیجه‌هایش عالی است',
  );
  const [showProsodyLexiconDrawer, setShowProsodyLexiconDrawer] = useState<boolean>(false);
  const [customLexiconInput, setCustomLexiconInput] = useState<string>(
    'طالقانی، تایپ‌اسکریپت، آواپرداز، صحبت، پادکست، هوش مصنوعی',
  );

  useEffect(() => {
    const firstTrackId = tracks[0]?.id ?? 'track-host';
    setForcedAlignTrackId(firstTrackId);
    const nextTrackText = tokens
      .filter((t) => t.trackId === firstTrackId)
      .map((t) => t.displayText)
      .join(' ');
    setCustomScriptText(nextTrackText);
    setSelectedTokenIds([]);
    setEditingTokenId(null);
    setForcedAlignError(null);
  }, [projectSessionNonce]);

  useEffect(() => {
    if (tracks.length > 0 && !tracks.some((t) => t.id === forcedAlignTrackId)) {
      setForcedAlignTrackId(tracks[0].id);
    }
  }, [tracks, forcedAlignTrackId]);

  const playheadFlicks = secondsToFlicks(playheadSec);

  const layerLabels: { id: TranscriptLayer; label: string }[] = [
    { id: 'display', label: 'متن نمایشی' },
    { id: 'normalized', label: 'نرمال‌شده' },
    { id: 'original', label: 'خام ASR' },
  ];

  // Clean up any stale selected IDs if tokens changed after a cut or Undo
  const activeSelectedIds = useMemo(() => {
    const validSet = new Set(tokens.map((t) => t.id));
    return selectedTokenIds.filter((id) => validSet.has(id));
  }, [tokens, selectedTokenIds]);

  // Phonetic & homophone search results
  const searchHits = useMemo(
    () => searchTranscriptPhonetically(tokens, phoneticQuery),
    [tokens, phoneticQuery],
  );

  const searchMatchedTokenIdSet = useMemo(
    () => new Set(searchHits.flatMap((h) => h.matchedTokenIds)),
    [searchHits],
  );

  const hasHomophoneHit = useMemo(
    () => searchHits.some((h) => h.matchType === 'HOMOPHONE_PHONETIC'),
    [searchHits],
  );

  const trilingualStats = useMemo(
    () => computeTrilingualTranscriptStats(tokens),
    [tokens],
  );

  // Script-to-Audio Deviation Report (Needleman-Wunsch Phonetic Alignment)
  const scriptDiffReport = useMemo(() => {
    if (!showScriptDiffDrawer) return null;
    const primaryTrackId = tracks[0]?.id ?? 'track-host';
    return compareReferenceScriptWithTranscript({
      referenceScript: referenceBookScript,
      tokens,
      targetTrackId: primaryTrackId,
    });
  }, [showScriptDiffDrawer, referenceBookScript, tokens, tracks]);

  const multiWordCutSpec = useMemo(
    () => computeMultiWordCutRange(tokens, activeSelectedIds),
    [tokens, activeSelectedIds],
  );

  const syncSafetyDecision = useMemo(() => {
    if (!multiWordCutSpec) return null;
    return determineSyncSafeEditMode(
      tracks,
      multiWordCutSpec.trackId,
      multiWordCutSpec.range,
      tokens,
      pcmSources,
      sampleRate,
    );
  }, [tracks, multiWordCutSpec, tokens, pcmSources, sampleRate]);

  const subtitlePreviewContent = useMemo(() => {
    if (subtitlePreviewMode === 'srt') return exportTranscriptToSrt(tokens);
    if (subtitlePreviewMode === 'vtt') return exportTranscriptToVtt(tokens);
    if (subtitlePreviewMode === 'textgrid') {
      return exportTranscriptToPraatTextGrid(tokens, totalDurationSec);
    }
    return '';
  }, [tokens, subtitlePreviewMode, totalDurationSec]);

  const handleDownloadSubtitleFile = (format: 'srt' | 'vtt' | 'textgrid') => {
    const content =
      format === 'srt'
        ? exportTranscriptToSrt(tokens)
        : format === 'vtt'
          ? exportTranscriptToVtt(tokens)
          : exportTranscriptToPraatTextGrid(tokens, totalDurationSec);
    const ext = format === 'textgrid' ? 'TextGrid' : format;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `avapardaz-transcript.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const handleSelectAllSearchHits = () => {
    const ids = Array.from(searchMatchedTokenIdSet);
    if (ids.length === 0) return;
    const firstTok = tokens.find((t) => t.id === ids[0]);
    if (!firstTok) return;
    const sameTrackIds = ids.filter((id) => {
      const tok = tokens.find((t) => t.id === id);
      return tok?.trackId === firstTok.trackId;
    });
    setSelectedTokenIds(sameTrackIds);
    onSeekSec(flicksToSeconds(firstTok.range?.startFlicks ?? 0));
  };

  const handleSelectScriptExtras = () => {
    if (!scriptDiffReport || scriptDiffReport.extraSpokenTokenIds.length === 0) return;
    setSelectedTokenIds(scriptDiffReport.extraSpokenTokenIds);
    const firstTok = tokens.find((t) => t.id === scriptDiffReport.extraSpokenTokenIds[0]);
    if (firstTok) {
      onSeekSec(flicksToSeconds(firstTok.range?.startFlicks ?? 0));
    }
  };

  const handleWordClick = (tok: PersianWordToken, e: React.MouseEvent<HTMLButtonElement>) => {
    const startSec = flicksToSeconds(tok.range?.startFlicks ?? 0);
    onSeekSec(startSec);

    if (e.shiftKey && activeSelectedIds.length > 0) {
      const lastId = activeSelectedIds[activeSelectedIds.length - 1];
      const sameTrack = tokens.filter((t) => t.trackId === tok.trackId);
      const idxA = sameTrack.findIndex((t) => t.id === lastId);
      const idxB = sameTrack.findIndex((t) => t.id === tok.id);
      if (idxA !== -1 && idxB !== -1) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        const rangeIds = sameTrack.slice(lo, hi + 1).map((t) => t.id);
        setSelectedTokenIds(rangeIds);
        return;
      }
    }

    setSelectedTokenIds((prev) => {
      const validPrev = prev.filter((id) => tokens.some((t) => t.id === id));
      if (validPrev.includes(tok.id)) {
        return validPrev.filter((id) => id !== tok.id);
      }
      const existingTrackId =
        validPrev.length > 0
          ? tokens.find((t) => t.id === validPrev[0])?.trackId
          : tok.trackId;
      if (existingTrackId && existingTrackId !== tok.trackId) {
        return [tok.id];
      }
      return [...validPrev, tok.id];
    });
  };

  const handleStartEditSingleWord = () => {
    if (activeSelectedIds.length !== 1) return;
    const tok = tokens.find((t) => t.id === activeSelectedIds[0]);
    if (!tok) return;
    setEditingTokenId(tok.id);
    setEditingTextValue(tok.displayText);
  };

  const handleSaveSingleWordEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTokenId || !editingTextValue.trim()) return;
    onUpdateTokenDisplayText(editingTokenId, editingTextValue.trim());
    setEditingTokenId(null);
    setSelectedTokenIds([]);
  };

  const handleApplyCut = (explicitMode?: RecommendationActionMode) => {
    if (activeSelectedIds.length === 0) return;
    const applied = onCutSelectedWords(activeSelectedIds, explicitMode);
    if (applied !== false) {
      setSelectedTokenIds([]);
      setEditingTokenId(null);
    }
  };

  const handleApplyRedaction = (mode: AudioRedactionMaskMode) => {
    if (!onRedactSelectedWords || activeSelectedIds.length === 0) return;
    const applied = onRedactSelectedWords(activeSelectedIds, mode);
    if (applied !== false) {
      setSelectedTokenIds([]);
      setEditingTokenId(null);
    }
  };

  const handleApplyWsolaStretch = (tempoRatio: number) => {
    if (!onWsolaTimeStretchSelectedWords || activeSelectedIds.length === 0) return;
    const applied = onWsolaTimeStretchSelectedWords(activeSelectedIds, tempoRatio);
    if (applied !== false) {
      setSelectedTokenIds([]);
      setEditingTokenId(null);
    }
  };

  const handleApplyPunchInMatch = () => {
    if (!onPunchInSpectralMatchSelectedWords || activeSelectedIds.length === 0) return;
    const applied = onPunchInSpectralMatchSelectedWords(activeSelectedIds);
    if (applied !== false) {
      setSelectedTokenIds([]);
      setEditingTokenId(null);
    }
  };

  const handleSelectBestTeaserTokens = () => {
    if (!prosodyAndChaptersReport || prosodyAndChaptersReport.bestTeaserTokenIds.length === 0) {
      return;
    }
    const ids = prosodyAndChaptersReport.bestTeaserTokenIds;
    setSelectedTokenIds(ids);
    const firstTok = tokens.find((t) => t.id === ids[0]);
    if (firstTok) {
      onSeekSec(flicksToSeconds(firstTok.range?.startFlicks ?? 0));
    }
  };

  const openForcedAlignDrawer = () => {
    setShowForcedAlignDrawer(true);
    setForcedAlignError(null);
    const targetId = tracks.some((t) => t.id === forcedAlignTrackId)
      ? forcedAlignTrackId
      : (tracks[0]?.id ?? 'track-host');
    setForcedAlignTrackId(targetId);
    const currentTrackText = tokens
      .filter((t) => t.trackId === targetId)
      .map((t) => t.displayText)
      .join(' ');
    setCustomScriptText(currentTrackText);
    setTimeout(() => forcedAlignInputRef.current?.focus(), 0);
  };

  const handleOpenForcedAlign = () => {
    const nextOpen = !showForcedAlignDrawer;
    if (nextOpen) {
      openForcedAlignDrawer();
    } else {
      setShowForcedAlignDrawer(false);
      setForcedAlignError(null);
    }
  };

  const handleExecuteForcedAlign = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customScriptText.trim()) {
      setForcedAlignError('لطفاً ابتدا متن گفتار فارسی را در کادر بالا وارد کنید.');
      forcedAlignInputRef.current?.focus();
      return;
    }
    setForcedAlignError(null);
    onRunForcedAlignment(customScriptText.trim(), forcedAlignTrackId);
    setShowForcedAlignDrawer(false);
    setSelectedTokenIds([]);
  };

  return (
    <section
      dir="rtl"
      aria-label="متن همگام‌شده فارسی و تدوین متن‌محور"
      className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg flex flex-col shadow-xs dark:shadow-none"
    >
      {/* Top Header & ASR / Forced Alignment Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-[#252F42]">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            تدوین متن‌محور و تراز آوایی فارسی (Text-Based Audio Editor)
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            روی هر واژه کلیک کنید تا انتخاب شود؛ با حذف یا بوق سانسور، صدای آن به‌صورت هوشمند و همگام روی تایم‌لاین اعمال می‌شود
          </p>
          <div
            data-testid="transcript-shahab-status"
            className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
          >
            {shahabRuntimeStatus?.available ? (
              <>
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                  <span>
                    موتور تبدیل صوت به متن شهاب (
                    <bdi dir="ltr" className="font-mono">
                      Zipformer INT8
                    </bdi>
                    ): متصل و آماده (۱۰۰٪ محلی)
                  </span>
                </span>
                {shahabRuntimeStatus.sampleAudioAvailable && onLoadAndTranscribeSamplePersianAudio && (
                  <button
                    type="button"
                    data-testid="btn-header-sample-persian"
                    disabled={isTranscribingAsr}
                    onClick={onLoadAndTranscribeSamplePersianAudio}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-600/35 dark:border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 cursor-pointer"
                  >
                    <span>تست با نمونه صوت واقعی فارسی</span>
                  </button>
                )}
              </>
            ) : hasBrowserInstalledModel ? (
              <>
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                  <span>
                    مدل فارسی مرورگر (شناوا ریزه INT8): آماده در OPFS (۱۰۰٪ مستقل و آفلاین)
                  </span>
                </span>
                {onLoadAndTranscribeSamplePersianAudio && (
                  <button
                    type="button"
                    data-testid="btn-header-sample-persian"
                    disabled={isTranscribingAsr}
                    onClick={onLoadAndTranscribeSamplePersianAudio}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-600/35 dark:border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 cursor-pointer"
                  >
                    <span>تست با نمونه صوت واقعی فارسی</span>
                  </button>
                )}
              </>
            ) : companionHealth?.runtime?.available ? (
              <>
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                  <span>
                    موتور بومی شهاب/شناوا: متصل (
                    <bdi dir="ltr" className="font-mono">
                      {companionHealth.runtime.activeModelId ?? 'Reza2kn/Shenava-Rizeh'}
                    </bdi>{' '}
                    INT8 · ۱۰۰٪ آفلاین روی CPU)
                  </span>
                </span>
                {companionHealth.sampleAudioAvailable && onLoadAndTranscribeSamplePersianAudio && (
                  <button
                    type="button"
                    data-testid="btn-header-sample-persian"
                    disabled={isTranscribingAsr}
                    onClick={onLoadAndTranscribeSamplePersianAudio}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-600/35 dark:border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 cursor-pointer"
                  >
                    <span>تست با نمونه صوت واقعی فارسی</span>
                  </button>
                )}
              </>
            ) : isCheckingCompanion && !companionHealth ? (
              <span className="inline-flex items-center gap-1.5 text-sky-700 dark:text-sky-300">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                <span>در حال بررسی موتور محلی شهاب/شناوا...</span>
              </span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2 text-amber-800 dark:text-amber-300">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                  <span>مدل فارسی محلی (مرورگر/Companion) هنوز نصب نشده است</span>
                </span>
                {onRetryCompanionConnection && (
                  <button
                    type="button"
                    data-testid="btn-header-retry-companion"
                    onClick={onRetryCompanionConnection}
                    className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 hover:bg-amber-500/20 cursor-pointer"
                  >
                    اتصال مجدد
                  </button>
                )}
                {companionHealth && onInstallNativeCompanionEngine && (
                  <button
                    type="button"
                    data-testid="btn-header-install-native-asr"
                    disabled={isInstallingNativeAsr}
                    onClick={onInstallNativeCompanionEngine}
                    className="px-2 py-0.5 rounded bg-emerald-500 text-slate-950 font-semibold hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {isInstallingNativeAsr ? 'در حال نصب...' : 'نصب خودکار موتور شهاب'}
                  </button>
                )}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="btn-run-persian-asr"
            disabled={isTranscribingAsr}
            onClick={onRunPersianAsr}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-sky-500/40 bg-sky-500/10 dark:bg-sky-500/15 text-sky-800 dark:text-sky-200 hover:bg-sky-500/20 dark:hover:bg-sky-500/25 disabled:opacity-50 cursor-pointer"
          >
            {isTranscribingAsr ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600 dark:text-sky-400" aria-hidden="true" />
            ) : (
              <Mic className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
            )}
            <span>{isTranscribingAsr ? 'در حال استخراج متن...' : 'تبدیل صوت به متن (ASR)'}</span>
          </button>

          <button
            type="button"
            data-testid="btn-toggle-forced-align"
            onClick={handleOpenForcedAlign}
            aria-expanded={showForcedAlignDrawer}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>هم‌ترازی متن با صوت (Forced Align)</span>
          </button>

          <button
            type="button"
            data-testid="btn-toggle-script-diff"
            onClick={() => setShowScriptDiffDrawer((prev) => !prev)}
            aria-expanded={showScriptDiffDrawer}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border cursor-pointer ${
              showScriptDiffDrawer
                ? 'border-amber-500/50 dark:border-amber-400/60 bg-amber-500/15 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200'
                : 'border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738]'
            }`}
          >
            <FileDiff className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>تطبیق با متن مرجع (Script Diff)</span>
          </button>

          <div
            role="group"
            aria-label="لایه متن فارسی"
            className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#0E131D] border border-slate-200 dark:border-[#252F42] rounded-md"
          >
            {layerLabels.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLayer(item.id)}
                aria-pressed={layer === item.id}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  layer === item.id
                    ? 'bg-amber-400 text-slate-950'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Phonetic & Homophone Search + Non-Destructive Prosodic/Colloquial Enhancements Bar */}
      <div className="px-4 py-2 border-b border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D]/80 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[230px]">
          <div className="relative flex-1 max-w-sm">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              data-testid="input-phonetic-search"
              value={phoneticQuery}
              onChange={(e) => setPhoneticQuery(e.target.value)}
              placeholder="جستجوی آوایی سه‌زبانه (فارسی / EN / عربی)..."
              aria-label="جستجوی آوایی در متن"
              className="w-full pr-8 pl-6 py-1 rounded bg-white dark:bg-[#131924] border border-slate-300 dark:border-[#252F42] text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-sky-500 dark:focus:border-sky-400"
            />
            {phoneticQuery && (
              <button
                type="button"
                onClick={() => setPhoneticQuery('')}
                aria-label="پاک کردن جستجو"
                className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {phoneticQuery.trim().length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span
                data-testid="phonetic-search-hit-count"
                className="text-sky-700 dark:text-sky-300 font-medium"
              >
                {searchMatchedTokenIdSet.size} منطبق
                {hasHomophoneHit ? ' (شامل تطبیق آوایی/هم‌آوا)' : ''}
              </span>
              {searchMatchedTokenIdSet.size > 0 && (
                <button
                  type="button"
                  data-testid="btn-select-search-hits"
                  onClick={handleSelectAllSearchHits}
                  className="px-2 py-0.5 rounded bg-sky-500/15 dark:bg-sky-500/20 border border-sky-500/40 text-sky-800 dark:text-sky-200 hover:bg-sky-500/25 dark:hover:bg-sky-500/30 text-[11px] cursor-pointer"
                >
                  انتخاب برای برش
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {onOptimizeTrilingualAsr && (
            <button
              type="button"
              data-testid="btn-optimize-trilingual-asr"
              onClick={() =>
                onOptimizeTrilingualAsr(
                  englishRenderMode === 'LATIN_TECHNICAL'
                    ? 'PERSIAN_TRANSLITERATED'
                    : 'LATIN_TECHNICAL',
                )
              }
              title="بهینه‌سازی سه‌زبانه ASR (فارسی + انگلیسی + عربی)، بازامتیازدهی دوطرفه هم‌آواها و سوئیچ نگارش انگلیسی (Latin / فارسی)"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-indigo-500/40 bg-indigo-500/10 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-200 hover:bg-indigo-500/20 dark:hover:bg-indigo-500/25 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-300" aria-hidden="true" />
              <span>
                سه‌زبانه FA/EN/AR ({englishRenderMode === 'LATIN_TECHNICAL' ? 'EN: Latin' : 'EN: فارسی'})
              </span>
            </button>
          )}

          {onRestoreProsodicPunctuation && (
            <button
              type="button"
              data-testid="btn-restore-punctuation"
              onClick={onRestoreProsodicPunctuation}
              title="گذاری خودکار ویرگول، نقطه و علامت سؤال بر اساس مکث و شیب فرکانس پایه F0"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <Wand2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span>علائم نگارشی (F0)</span>
            </button>
          )}

          {onConvertColloquialToFormal && (
            <button
              type="button"
              data-testid="btn-formalize-colloquial"
              onClick={onConvertColloquialToFormal}
              title="تبدیل غیرمخرب افعال و ضمایر محاوره‌ای به فارسی معیار در لایه نمایشی"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <BookOpenCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <span>معیارسازی محاوره</span>
            </button>
          )}

          {onNormalizeNumbersAndCompounds && (
            <button
              type="button"
              data-testid="btn-normalize-numbers-compounds"
              onClick={onNormalizeNumbersAndCompounds}
              title="تبدیل اعداد گفتاری به ارقام فارسی و اتصال ترکیبات نیم‌فاصله و اصطلاحات فنی"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              <Hash className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
              <span>اعداد و ترکیبات</span>
            </button>
          )}

          <button
            type="button"
            data-testid="btn-toggle-prosody-lexicon"
            onClick={() => setShowProsodyLexiconDrawer((prev) => !prev)}
            aria-expanded={showProsodyLexiconDrawer}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border cursor-pointer ${
              showProsodyLexiconDrawer
                ? 'border-emerald-500/50 dark:border-emerald-400/60 bg-emerald-500/15 dark:bg-emerald-400/15 text-emerald-800 dark:text-emerald-200'
                : 'border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738]'
            }`}
          >
            <ListTree className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>واژه‌نامه، آهنگ بیان و سرفصل‌ها</span>
          </button>

          <button
            type="button"
            data-testid="btn-toggle-srt-preview"
            onClick={() =>
              setSubtitlePreviewMode((prev) => (prev === 'none' ? 'srt' : 'none'))
            }
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border cursor-pointer ${
              subtitlePreviewMode !== 'none'
                ? 'border-amber-500/50 dark:border-amber-400/60 bg-amber-500/15 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200'
                : 'border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#131924] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738]'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>زیرنویس / TextGrid</span>
          </button>
        </div>
      </div>

      {/* Collapsible Custom Lexicon, Prosody/Pacing WPM & Chapter Markers Drawer */}
      {showProsodyLexiconDrawer && (
        <div
          data-testid="prosody-lexicon-drawer"
          className="px-4 py-3 border-b border-[#252F42] bg-[#0E131D] space-y-3"
        >
          {/* 1. Custom Persian Lexicon & Homophone Corrector */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="custom-lexicon-input"
                className="text-xs font-semibold text-emerald-300"
              >
                واژه‌نامه اختصاصی و اصلاح هم‌آواها (ت/ط، س/ص/ث، ق/غ، ز/ذ/ض/ظ):
              </label>
              {onApplyCustomLexicon && (
                <button
                  type="button"
                  data-testid="btn-apply-custom-lexicon"
                  onClick={() => onApplyCustomLexicon(customLexiconInput)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500 text-slate-950 hover:bg-emerald-400 text-xs font-semibold cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>اعمال واژه‌نامه و اصلاح هم‌آواها</span>
                </button>
              )}
            </div>
            <input
              id="custom-lexicon-input"
              type="text"
              data-testid="input-custom-lexicon"
              value={customLexiconInput}
              onChange={(e) => setCustomLexiconInput(e.target.value)}
              placeholder="واژگان تخصصی یا اسامی خاص را با ویرگول جدا کنید..."
              className="w-full px-3 py-1.5 rounded bg-[#131924] border border-[#252F42] text-xs text-slate-100 focus:outline-none focus:border-emerald-400"
            />
          </div>

          {/* 2. Prosody & Pacing WPM Coach + Chapter Markers */}
          {prosodyAndChaptersReport && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div
                data-testid="prosody-window-list"
                className="p-2.5 rounded bg-[#131924] border border-[#252F42] space-y-1.5"
              >
                <div className="text-xs font-semibold text-sky-300 flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                  <span>سرعت بیان (WPM) و پویایی آهنگ صدا (F0):</span>
                </div>
                {prosodyAndChaptersReport.prosodyWindows.length === 0 ? (
                  <p className="text-[11px] text-slate-400">
                    بازه صوتی برای تحلیل سرعت بیان کافی نیست.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-28 overflow-y-auto">
                    {prosodyAndChaptersReport.prosodyWindows.map((win, idx) => {
                      const startSec = flicksToSeconds(Number(win.windowRange.start));
                      const endSec = flicksToSeconds(Number(win.windowRange.end));
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => onSeekSec(startSec)}
                          className="w-full text-right p-1.5 rounded bg-[#0E131D] border border-[#252F42] hover:border-sky-400/50 text-[11px] flex flex-wrap items-center justify-between gap-2 cursor-pointer"
                        >
                          <span className="text-slate-200 font-medium">
                            {win.netWordsPerMinute} کلمه/دقیقه · {win.syllablesPerSecond} هجا/ثانیه · F0:{' '}
                            {win.medianPitchHz}Hz (±{win.pitchStdDevSemitones} نیم‌پرده)
                          </span>
                          <span dir="ltr" className="font-mono text-sky-300">
                            {startSec.toFixed(1)}s–{endSec.toFixed(1)}s
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div
                data-testid="chapter-markers-list"
                className="p-2.5 rounded bg-[#131924] border border-[#252F42] space-y-1.5"
              >
                <div className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                  <ListTree className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                  <span>سرفصل‌های موضوعی خودکار (TextTiling + TF-IDF):</span>
                </div>
                {prosodyAndChaptersReport.chapters.length === 0 ? (
                  <p className="text-[11px] text-slate-400">سرفصلی استخراج نشد.</p>
                ) : (
                  <div className="space-y-1.5 max-h-28 overflow-y-auto">
                    {prosodyAndChaptersReport.chapters.map((ch) => {
                      const startSec = flicksToSeconds(Number(ch.range.start));
                      return (
                        <button
                          key={ch.chapterIndex}
                          type="button"
                          data-testid={`btn-seek-chapter-${ch.chapterIndex}`}
                          onClick={() => onSeekSec(startSec)}
                          className="w-full text-right p-1.5 rounded bg-[#0E131D] border border-[#252F42] hover:border-amber-400/50 text-[11px] flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <span className="text-slate-200 truncate">{ch.suggestedTitleFa}</span>
                          <span dir="ltr" className="font-mono text-amber-300 shrink-0">
                            {ch.startTimestampFormatted}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. Cold-Open Podcast Teaser & TextRank Key Excerpt */}
          {prosodyAndChaptersReport && prosodyAndChaptersReport.bestTeaserExcerptFa && (
            <div
              data-testid="teaser-textrank-card"
              className="p-2.5 rounded bg-[#131924] border border-[#252F42] flex flex-wrap items-center justify-between gap-2"
            >
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                  <span>تیزر برگزیده پادکست (امتیاز ترکیبی هیجان آوایی F0 و چگالی واژگانی):</span>
                </div>
                <p className="text-xs text-slate-200">
                  «{prosodyAndChaptersReport.bestTeaserExcerptFa}»
                </p>
              </div>
              {prosodyAndChaptersReport.bestTeaserTokenIds.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-select-best-teaser"
                  onClick={handleSelectBestTeaserTokens}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-400/20 border border-amber-400/50 text-amber-200 hover:bg-amber-400/30 text-xs font-semibold cursor-pointer"
                >
                  <Sparkles className="w-3 h-3" aria-hidden="true" />
                  <span>
                    انتخاب واژگان تیزر برگزیده ({prosodyAndChaptersReport.bestTeaserTokenIds.length})
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Script-to-Audio Deviation Drawer (Needleman-Wunsch Phonetic Alignment) */}
      {showScriptDiffDrawer && scriptDiffReport && (
        <div
          data-testid="script-diff-drawer"
          className="px-4 py-3 border-b border-[#252F42] bg-[#0E131D] space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="reference-book-script-input"
              className="text-xs font-semibold text-amber-300"
            >
              متن مرجع کتاب / اسکریپت اصلی (مقایسه آوایی Needleman-Wunsch با گفتار گوینده):
            </label>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                data-testid="script-diff-extra-count"
                className="text-rose-300 font-medium"
              >
                اضافه‌گویی/تپق خارج از متن: {scriptDiffReport.extraCount}
              </span>
              <span className="text-amber-300 font-medium">
                جاافتاده از متن: {scriptDiffReport.omittedCount}
              </span>
              <span className="text-sky-300 font-medium">
                خوانش متفاوت: {scriptDiffReport.misreadCount}
              </span>
              {scriptDiffReport.extraSpokenTokenIds.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-select-script-extras"
                  onClick={handleSelectScriptExtras}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-rose-500/20 border border-rose-400/40 text-rose-200 hover:bg-rose-500/30 text-xs font-semibold cursor-pointer"
                >
                  <Scissors className="w-3 h-3" aria-hidden="true" />
                  <span>
                    انتخاب واژگان اضافه برای برش ({scriptDiffReport.extraSpokenTokenIds.length})
                  </span>
                </button>
              )}
            </div>
          </div>

          <textarea
            id="reference-book-script-input"
            data-testid="input-reference-script"
            rows={2}
            value={referenceBookScript}
            onChange={(e) => setReferenceBookScript(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-[#131924] border border-[#252F42] text-xs text-slate-100 focus:outline-none focus:border-amber-400 leading-6"
          />

          {scriptDiffReport.findings.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-28 overflow-y-auto pt-1">
              {scriptDiffReport.findings.map((f) => (
                <div
                  key={f.findingId}
                  className="p-2 rounded bg-[#131924] border border-[#252F42] text-[11px] flex items-center justify-between gap-2"
                >
                  <span className="text-slate-200">{f.descriptionFa}</span>
                  <span
                    dir="ltr"
                    className="font-mono text-slate-400 shrink-0"
                  >
                    {flicksToSeconds(Number(f.audioRange.start)).toFixed(2)}s
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Forced Alignment Script Editor */}
      {showForcedAlignDrawer && (
        <form
          onSubmit={handleExecuteForcedAlign}
          className="px-4 py-3 border-b border-[#252F42] bg-[#0E131D] space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="forced-align-script-input"
              className="text-xs font-semibold text-amber-300"
            >
              متن فارسی جهت هم‌ترازی آوایی کلمه‌به‌کلمه روی موج صوت (اسنپ به دره انرژی و تشخیص تپق):
            </label>
            {tracks.length > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <label htmlFor="forced-align-track-select" className="text-slate-400">
                  ترک هدف:
                </label>
                <select
                  id="forced-align-track-select"
                  value={forcedAlignTrackId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setForcedAlignTrackId(nextId);
                    const txt = tokens
                      .filter((t) => t.trackId === nextId)
                      .map((t) => t.displayText)
                      .join(' ');
                    if (txt) setCustomScriptText(txt);
                  }}
                  className="px-2 py-1 rounded bg-[#131924] border border-[#252F42] text-slate-200 text-xs"
                >
                  {tracks.map((trk) => (
                    <option key={trk.id} value={trk.id}>
                      {trk.name} ({trk.speakerLabel})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <textarea
            ref={forcedAlignInputRef}
            id="forced-align-script-input"
            data-testid="input-forced-align-script"
            rows={2}
            value={customScriptText}
            onChange={(e) => {
              setCustomScriptText(e.target.value);
              if (forcedAlignError) setForcedAlignError(null);
            }}
            placeholder="متن گفتار فارسی را وارد کنید..."
            className="w-full px-3 py-2 rounded-md bg-[#131924] border border-[#252F42] text-xs text-slate-100 focus:outline-none focus:border-amber-400 leading-6"
          />

          {forcedAlignError && (
            <p role="alert" className="text-[11px] text-rose-300">
              {forcedAlignError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForcedAlignDrawer(false);
                setForcedAlignError(null);
              }}
              className="px-2.5 py-1 text-xs rounded border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              data-testid="btn-apply-forced-align"
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              <span>اعمال هم‌ترازی آوایی روی موج صوت</span>
            </button>
          </div>
        </form>
      )}

      {/* Collapsible Subtitle SRT / VTT / Praat TextGrid Preview & Export Drawer */}
      {subtitlePreviewMode !== 'none' && (
        <div
          data-testid="subtitle-export-drawer"
          className="px-4 py-3 border-b border-[#252F42] bg-[#0E131D] space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-amber-300">
                پیش‌نمایش خروجی زمان‌بندی‌شده همگام با تایم‌لاین:
              </span>
              <button
                type="button"
                onClick={() => setSubtitlePreviewMode('srt')}
                className={`px-2 py-0.5 rounded text-xs cursor-pointer ${
                  subtitlePreviewMode === 'srt'
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'bg-[#131924] text-slate-300'
                }`}
              >
                SRT
              </button>
              <button
                type="button"
                onClick={() => setSubtitlePreviewMode('vtt')}
                className={`px-2 py-0.5 rounded text-xs cursor-pointer ${
                  subtitlePreviewMode === 'vtt'
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'bg-[#131924] text-slate-300'
                }`}
              >
                WebVTT
              </button>
              <button
                type="button"
                data-testid="btn-preview-textgrid"
                onClick={() => setSubtitlePreviewMode('textgrid')}
                className={`px-2 py-0.5 rounded text-xs cursor-pointer ${
                  subtitlePreviewMode === 'textgrid'
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'bg-[#131924] text-slate-300'
                }`}
              >
                Praat TextGrid
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="btn-download-srt"
                onClick={() => handleDownloadSubtitleFile('srt')}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>دانلود .SRT</span>
              </button>
              <button
                type="button"
                data-testid="btn-download-vtt"
                onClick={() => handleDownloadSubtitleFile('vtt')}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-[#252F42] bg-[#131924] text-slate-200 hover:bg-[#1E2738] cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>دانلود .VTT</span>
              </button>
              <button
                type="button"
                data-testid="btn-download-textgrid"
                onClick={() => handleDownloadSubtitleFile('textgrid')}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-[#252F42] bg-[#131924] text-slate-200 hover:bg-[#1E2738] cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>دانلود .TextGrid</span>
              </button>
              <button
                type="button"
                onClick={() => setSubtitlePreviewMode('none')}
                aria-label="بستن پیش‌نمایش زیرنویس"
                className="p-1 text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <pre
            dir="ltr"
            data-testid="subtitle-preview-text"
            className="p-2.5 rounded bg-[#0B0F17] border border-[#252F42] text-[11px] font-mono text-slate-200 max-h-36 overflow-y-auto whitespace-pre-wrap"
          >
            {subtitlePreviewContent}
          </pre>
        </div>
      )}

      {/* Active Text-Based Audio Editing Toolbar when word(s) are selected */}
      {multiWordCutSpec && syncSafetyDecision && (
        <div
          data-testid="transcript-word-edit-bar"
          className="px-4 py-2.5 border-b border-amber-500/35 bg-amber-50 dark:bg-amber-500/10 flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-amber-800 dark:text-amber-300">
                {activeSelectedIds.length} واژه انتخاب‌شده:
              </span>
              <span className="px-2 py-0.5 rounded bg-white dark:bg-[#0E131D] border border-amber-500/40 text-slate-900 dark:text-slate-100 font-medium">
                «{multiWordCutSpec.combinedText}»
              </span>
              <span dir="ltr" className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300">
                [{flicksToSeconds(multiWordCutSpec.range.startFlicks).toFixed(2)}s ..{' '}
                {flicksToSeconds(multiWordCutSpec.range.endFlicks).toFixed(2)}s]
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="btn-cut-selected-words"
                onClick={() => handleApplyCut()}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
              >
                <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {syncSafetyDecision.mode === 'sync-locked-ripple-cut'
                    ? 'برش هوشمند از صوت (Ripple Cut)'
                    : 'جایگزینی هوشمند با Room Tone (حفظ سینک)'}
                </span>
              </button>

              {syncSafetyDecision.mode !== 'in-place-room-tone-suppression' && (
                <button
                  type="button"
                  data-testid="btn-roomtone-cut-words"
                  onClick={() => handleApplyCut('in-place-room-tone-suppression')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-emerald-600/40 dark:border-emerald-500/40 bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-500/20 dark:hover:bg-emerald-500/25 cursor-pointer"
                >
                  <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>سکوت درجا (Room Tone)</span>
                </button>
              )}

              {onRedactSelectedWords && (
                <>
                  <button
                    type="button"
                    data-testid="btn-redact-bleep-words"
                    onClick={() => handleApplyRedaction('BROADCAST_BLEEP_1KHZ')}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-rose-600/40 dark:border-rose-500/40 bg-rose-500/10 dark:bg-rose-500/15 text-rose-800 dark:text-rose-200 hover:bg-rose-500/20 dark:hover:bg-rose-500/25 cursor-pointer"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>بوق سانسور ۱kHz</span>
                  </button>
                  <button
                    type="button"
                    data-testid="btn-redact-muffle-words"
                    onClick={() => handleApplyRedaction('LOW_PASS_VOICE_MUFFLE')}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                  >
                    <span>مات‌سازی صدا</span>
                  </button>
                </>
              )}

              {onWsolaTimeStretchSelectedWords && (
                <>
                  <button
                    type="button"
                    data-testid="btn-wsola-slow-words"
                    onClick={() => handleApplyWsolaStretch(0.8)}
                    title="کشش زمانی بدون تغییر زیر و بمی صدا (WSOLA 0.8x)"
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-sky-600/40 dark:border-sky-500/40 bg-sky-500/10 dark:bg-sky-500/15 text-sky-800 dark:text-sky-200 hover:bg-sky-500/20 dark:hover:bg-sky-500/25 cursor-pointer"
                  >
                    <Gauge className="w-3 h-3" aria-hidden="true" />
                    <span>کندتر ۰.۸x (WSOLA)</span>
                  </button>
                  <button
                    type="button"
                    data-testid="btn-wsola-fast-words"
                    onClick={() => handleApplyWsolaStretch(1.25)}
                    title="فشرده‌سازی زمانی بدون تغییر زیر و بمی صدا (WSOLA 1.25x)"
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-sky-600/40 dark:border-sky-500/40 bg-sky-500/10 dark:bg-sky-500/15 text-sky-800 dark:text-sky-200 hover:bg-sky-500/20 dark:hover:bg-sky-500/25 cursor-pointer"
                  >
                    <Gauge className="w-3 h-3" aria-hidden="true" />
                    <span>سریع‌تر ۱.۲۵x (WSOLA)</span>
                  </button>
                </>
              )}

              {onPunchInSpectralMatchSelectedWords && (
                <button
                  type="button"
                  data-testid="btn-punchin-spectral-match"
                  onClick={handleApplyPunchInMatch}
                  title="تطبیق طیفی ۴ بانده برداشت جایگزین با رنگ صدای استودیو و درج واترمارک نامحسوس ۱۹ کیلوهرتز BPSK"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-purple-600/40 dark:border-purple-500/40 bg-purple-500/10 dark:bg-purple-500/15 text-purple-800 dark:text-purple-200 hover:bg-purple-500/20 dark:hover:bg-purple-500/25 cursor-pointer"
                >
                  <Wand2 className="w-3 h-3 text-purple-600 dark:text-purple-300" aria-hidden="true" />
                  <span>تطبیق طیفی ۴ بانده + واترمارک ۱۹kHz</span>
                </button>
              )}

              {activeSelectedIds.length === 1 && (
                <button
                  type="button"
                  data-testid="btn-edit-word-spelling"
                  onClick={handleStartEditSingleWord}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <Edit3 className="w-3 h-3" aria-hidden="true" />
                  <span>اصلاح املا</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setSelectedTokenIds([]);
                  setEditingTokenId(null);
                }}
                aria-label="لغو انتخاب واژگان"
                className="p-1 rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#0E131D] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700 dark:text-slate-300">
            <span>{syncSafetyDecision.reasonFa}</span>
            {multiWordCutSpec.hasTrailingEzafeRisk && multiWordCutSpec.ezafeWarningFa && (
              <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300 font-medium">
                <AlertTriangle className="w-3 h-3 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />
                <span>{multiWordCutSpec.ezafeWarningFa}</span>
              </span>
            )}
          </div>

          {editingTokenId && (
            <form onSubmit={handleSaveSingleWordEdit} className="flex items-center gap-2 pt-1">
              <label htmlFor="edit-word-display-input" className="text-xs text-slate-700 dark:text-slate-300">
                املای نمایشی جدید:
              </label>
              <input
                id="edit-word-display-input"
                type="text"
                value={editingTextValue}
                onChange={(e) => setEditingTextValue(e.target.value)}
                className="px-2.5 py-1 rounded bg-white dark:bg-[#0E131D] border border-amber-500 dark:border-amber-400/60 text-xs text-slate-900 dark:text-slate-100 focus:outline-none"
              />
              <button
                type="submit"
                className="px-2.5 py-1 rounded bg-emerald-500 text-slate-950 font-semibold text-xs cursor-pointer"
              >
                ذخیره
              </button>
            </form>
          )}
        </div>
      )}

      {/* Inline ASR & Acoustic Alignment Status / Action Feedback */}
      {asrInlineFeedback && (
        <div
          role={asrInlineFeedback.kind === 'SUCCESS' ? 'status' : 'alert'}
          data-testid="transcript-asr-inline-panel"
          className={`px-4 py-3 border-b text-xs space-y-2 ${
            asrInlineFeedback.kind === 'SUCCESS'
              ? 'border-emerald-500/35 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-900 dark:text-emerald-100'
              : 'border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 text-amber-950 dark:text-amber-100'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                {asrInlineFeedback.kind === 'SUCCESS' ? (
                  <Check className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                )}
                <span>{asrInlineFeedback.titleFa}</span>
              </div>
              <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">
                {asrInlineFeedback.messageFa}
              </p>
            </div>
            {onDismissAsrInlineFeedback && (
              <button
                type="button"
                onClick={onDismissAsrInlineFeedback}
                aria-label="بستن پیام هم‌ترازی و ASR"
                className="p-1 rounded text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {asrInlineFeedback.kind !== 'SUCCESS' && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {cloudAsrConfigured &&
                onRunCloudGeminiAsr &&
                asrInlineFeedback.kind !== 'READ_ONLY' &&
                asrInlineFeedback.kind !== 'AUDIO_MISSING' && (
                  <button
                    type="button"
                    data-testid="btn-inline-cloud-gemini-asr"
                    disabled={isTranscribingAsr}
                    onClick={onRunCloudGeminiAsr}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {isTranscribingAsr ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {executionMode === 'CLOUD'
                        ? 'اجرای تبدیل صوت به متن (Gemini ASR)'
                        : 'تشخیص واقعی کلمات با Gemini ASR (انتقال صریح به حالت ابری)'}
                    </span>
                  </button>
                )}

              {asrInlineFeedback.kind === 'CLOUD_UNCONFIGURED' && onSwitchToLocalExecutionMode && (
                <button
                  type="button"
                  data-testid="btn-inline-switch-local"
                  onClick={onSwitchToLocalExecutionMode}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 cursor-pointer"
                >
                  <span>تغییر به حالت محلی (LOCAL)</span>
                </button>
              )}

              {onRunAcousticSegmentation &&
                asrInlineFeedback.kind !== 'READ_ONLY' &&
                asrInlineFeedback.kind !== 'AUDIO_MISSING' && (
                  <button
                    type="button"
                    data-testid="btn-run-acoustic-segmentation"
                    disabled={isTranscribingAsr}
                    onClick={onRunAcousticSegmentation}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-sky-600/40 dark:border-sky-500/40 bg-sky-500/10 dark:bg-sky-500/15 text-sky-800 dark:text-sky-200 font-medium text-xs hover:bg-sky-500/20 dark:hover:bg-sky-500/25 disabled:opacity-50 cursor-pointer"
                  >
                    <Wand2 className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                    <span>بخش‌بندی زمانی موج صوت بدون تشخیص کلمه</span>
                  </button>
                )}

              {asrInlineFeedback.kind !== 'READ_ONLY' && asrInlineFeedback.kind !== 'AUDIO_MISSING' && (
                <button
                  type="button"
                  data-testid="btn-inline-open-forced-align"
                  onClick={openForcedAlignDrawer}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-amber-500/50 bg-white dark:bg-[#0E131D] text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-[#1E2738] text-xs cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  <span>هم‌ترازی با متن دلخواه (Forced Align)</span>
                </button>
              )}

              {asrInlineFeedback.kind === 'NO_SPEECH' &&
                companionHealth?.sampleAudioAvailable &&
                onLoadAndTranscribeSamplePersianAudio && (
                  <button
                    type="button"
                    data-testid="btn-inline-test-sample-persian"
                    disabled={isTranscribingAsr}
                    onClick={onLoadAndTranscribeSamplePersianAudio}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {isTranscribingAsr ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>آزمایش با نمونه صوت واقعی فارسی (مدل شهاب / شناوا)</span>
                  </button>
                )}

              {(asrInlineFeedback.kind === 'MODEL_NOT_INSTALLED' ||
                asrInlineFeedback.kind === 'INFERENCE_ERROR') &&
                onInstallBrowserPersianModel && (
                  <button
                    type="button"
                    data-testid="btn-inline-install-browser-persian-model"
                    disabled={isInstallingBrowserModel || isTranscribingAsr}
                    onClick={() => onInstallBrowserPersianModel(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {isInstallingBrowserModel ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {isInstallingBrowserModel
                        ? `در حال نصب مدل فارسی در مرورگر (${browserModelInstallPct ?? 0}٪)...`
                        : 'نصب خودکار و اجرای مدل فارسی مرورگر (شناوا ریزه · ۳۶ مگابایت · آفلاین)'}
                    </span>
                  </button>
                )}

              {(asrInlineFeedback.kind === 'MODEL_NOT_INSTALLED' ||
                asrInlineFeedback.kind === 'INFERENCE_ERROR') &&
                onRetryCompanionConnection && (
                  <button
                    type="button"
                    data-testid="btn-inline-retry-companion"
                    disabled={isCheckingCompanion || isInstallingNativeAsr}
                    onClick={onRetryCompanionConnection}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-sky-500 text-slate-950 font-semibold text-xs hover:bg-sky-400 disabled:opacity-50 cursor-pointer"
                  >
                    <span>
                      {isCheckingCompanion ? 'در حال بررسی اتصال...' : 'بررسی مجدد اتصال شهاب/شناوا'}
                    </span>
                  </button>
                )}

              {(asrInlineFeedback.kind === 'MODEL_NOT_INSTALLED' ||
                asrInlineFeedback.kind === 'INFERENCE_ERROR') &&
                companionHealth &&
                onInstallNativeCompanionEngine && (
                  <button
                    type="button"
                    data-testid="btn-inline-install-native-asr"
                    disabled={isInstallingNativeAsr}
                    onClick={onInstallNativeCompanionEngine}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 font-semibold text-xs hover:bg-emerald-500/20 disabled:opacity-50 cursor-pointer"
                  >
                    {isInstallingNativeAsr ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {isInstallingNativeAsr
                        ? 'در حال نصب موتور بومی شهاب/شناوا...'
                        : 'نصب موتور بومی شهاب/شناوا (Companion)'}
                    </span>
                  </button>
                )}

              {asrInlineFeedback.kind === 'MODEL_NOT_INSTALLED' && onOpenLocalModelInstaller && (
                <button
                  type="button"
                  data-testid="btn-inline-open-model-modal"
                  onClick={onOpenLocalModelInstaller}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-300 dark:border-[#252F42] bg-white dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] text-xs cursor-pointer"
                >
                  <span>وارد کردن دستی فایل مدل (.onnx و tokens.txt)</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Word Token Stream */}
      <div
        data-testid="transcript-word-stream"
        className="p-4 min-h-[210px] max-h-[340px] overflow-y-auto"
      >
        {tokens.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-600 dark:text-slate-400 space-y-3">
            <p className="text-slate-800 dark:text-slate-200 font-medium">
              هنوز هیچ واژه‌ای در تایم‌لاین باقی نمانده یا استخراج نشده است.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {cloudAsrConfigured && onRunCloudGeminiAsr && (
                <button
                  type="button"
                  data-testid="btn-empty-cloud-gemini-asr"
                  disabled={isTranscribingAsr}
                  onClick={onRunCloudGeminiAsr}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                >
                  {isTranscribingAsr ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>
                    {isTranscribingAsr
                      ? 'در حال تشخیص کلمات فارسی...'
                      : 'تشخیص هوشمند کلمات فارسی (Gemini ASR)'}
                  </span>
                </button>
              )}

              {((shahabRuntimeStatus?.available && shahabRuntimeStatus.sampleAudioAvailable) ||
                (companionHealth?.runtime?.available && companionHealth.sampleAudioAvailable) ||
                hasBrowserInstalledModel) &&
                onLoadAndTranscribeSamplePersianAudio && (
                  <button
                    type="button"
                    data-testid="btn-empty-test-sample-persian"
                    disabled={isTranscribingAsr}
                    onClick={onLoadAndTranscribeSamplePersianAudio}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {isTranscribingAsr ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>آزمایش با نمونه صوت واقعی فارسی (موتور شهاب)</span>
                  </button>
                )}

              <button
                type="button"
                data-testid="btn-empty-run-persian-asr"
                disabled={isTranscribingAsr || isInstallingBrowserModel}
                onClick={onRunPersianAsr}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-500 text-slate-950 font-semibold text-xs hover:bg-sky-400 disabled:opacity-50 cursor-pointer"
              >
                {isTranscribingAsr || isInstallingBrowserModel ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>
                  {isInstallingBrowserModel
                    ? `در حال نصب خودکار مدل فارسی محلی (${browserModelInstallPct ?? 0}٪)...`
                    : isTranscribingAsr
                      ? 'در حال استخراج متن با موتور شهاب...'
                      : 'اجرای تبدیل صوت به متن (موتور شهاب)'}
                </span>
              </button>

              {!shahabRuntimeStatus?.available &&
                !hasBrowserInstalledModel &&
                !companionHealth?.runtime?.available &&
                onInstallBrowserPersianModel && (
                  <button
                    type="button"
                    data-testid="btn-empty-install-browser-persian-model"
                    disabled={isInstallingBrowserModel || isTranscribingAsr}
                    onClick={() => onInstallBrowserPersianModel(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500 text-slate-950 font-semibold text-xs hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {isInstallingBrowserModel ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {isInstallingBrowserModel
                        ? `در حال نصب مدل فارسی مرورگر (${browserModelInstallPct ?? 0}٪)...`
                        : 'نصب خودکار و اجرای مدل فارسی مرورگر (۳۶ مگابایت · آفلاین)'}
                    </span>
                  </button>
                )}

              {onRunAcousticSegmentation && (
                <button
                  type="button"
                  data-testid="btn-empty-acoustic-segment"
                  disabled={isTranscribingAsr}
                  onClick={onRunAcousticSegmentation}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sky-600/40 dark:border-sky-500/40 bg-sky-500/10 dark:bg-sky-500/15 text-sky-800 dark:text-sky-200 hover:bg-sky-500/20 dark:hover:bg-sky-500/25 disabled:opacity-50 text-xs font-medium cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                  <span>بخش‌بندی زمانی بدون تشخیص کلمه</span>
                </button>
              )}

              <button
                type="button"
                data-testid="btn-empty-forced-align"
                onClick={openForcedAlignDrawer}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] text-xs font-medium cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <span>هم‌ترازی متن دلخواه</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-3 leading-8">
            {tokens.map((tok, tokIdx) => {
              const startFlicks = tok.range?.startFlicks ?? 0;
              const endFlicks = tok.range?.endFlicks ?? startFlicks;
              const isActivePlayhead =
                playheadFlicks >= startFlicks && playheadFlicks < endFlicks;
              const isSelected = activeSelectedIds.includes(tok.id);
              const isSearchHit = searchMatchedTokenIdSet.has(tok.id);
              const speakerTurnPrefix = resolveSpeakerTurnLabel(tokens, tokIdx);
              const textValue =
                layer === 'original'
                  ? (tok.originalText ?? tok.displayText ?? '')
                  : layer === 'normalized'
                    ? (tok.normalizedText ?? tok.displayText ?? '')
                    : (tok.displayText ?? tok.originalText ?? '');

              if (layer === 'display' && textValue.trim().length === 0) {
                return null;
              }

              const startSec = flicksToSeconds(startFlicks);

              return (
                <React.Fragment key={tok.id}>
                  {speakerTurnPrefix && (
                    <span
                      data-testid="transcript-speaker-turn"
                      className="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none"
                    >
                      <bdi>{speakerTurnPrefix}</bdi>
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid={`transcript-token-${tok.id}`}
                    aria-pressed={isSelected}
                    onClick={(e) => handleWordClick(tok, e)}
                    title={`${tok.speakerName || 'گوینده'} · ${startSec.toFixed(2)}s · اطمینان ${(tok.confidence * 100).toFixed(0)}٪ · منبع: ${tok.alignmentSource} (کلیک: انتخاب واژه برای برش صوتی)`}
                    className={`group inline-flex items-center gap-1 px-2 py-0.5 rounded text-sm transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-amber-400 text-slate-950 font-semibold ring-2 ring-amber-300'
                        : isSearchHit
                          ? 'bg-sky-500/20 dark:bg-sky-500/25 text-sky-900 dark:text-sky-100 ring-2 ring-sky-500 dark:ring-sky-400 font-medium'
                          : isActivePlayhead
                            ? 'bg-amber-400/20 text-amber-900 dark:text-amber-200 ring-1 ring-amber-500/60 dark:ring-amber-400/60'
                            : tok.isCrosstalkSuppressed
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300/70 line-through decoration-emerald-500/70 dark:decoration-emerald-400/70'
                              : tok.isDisfluency
                                ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20'
                                : tok.hasTrailingEzafeRisk
                                  ? 'bg-sky-500/10 text-sky-800 dark:text-sky-200 hover:bg-sky-500/20'
                                  : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738]'
                    }`}
                  >
                    <span
                      className={
                        tok.isDisfluency && !isSelected
                          ? 'line-through decoration-rose-500/70 dark:decoration-rose-400/70'
                          : ''
                      }
                    >
                      {textValue}
                    </span>
                    {tok.detectedLanguage === 'EN' && (
                      <span
                        dir="ltr"
                        className={`text-[9px] font-mono px-1 py-0.2 rounded ${
                          isSelected
                            ? 'bg-slate-900 text-amber-300'
                            : 'bg-indigo-500/15 dark:bg-indigo-500/25 text-indigo-800 dark:text-indigo-200 border border-indigo-400/40'
                        }`}
                      >
                        EN
                      </span>
                    )}
                    {tok.detectedLanguage === 'AR' && (
                      <span
                        dir="ltr"
                        className={`text-[9px] font-mono px-1 py-0.2 rounded ${
                          isSelected
                            ? 'bg-slate-900 text-amber-300'
                            : 'bg-emerald-500/15 dark:bg-emerald-500/25 text-emerald-800 dark:text-emerald-200 border border-emerald-400/40'
                        }`}
                      >
                        AR
                      </span>
                    )}
                    {tok.hasTrailingEzafeRisk && (
                      <AlertTriangle
                        className={`w-3 h-3 shrink-0 ${
                          isSelected ? 'text-slate-900' : 'text-amber-600 dark:text-amber-400'
                        }`}
                        aria-label="خطر کسره اضافه معلق"
                      />
                    )}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      <div
        data-testid="trilingual-asr-telemetry-bar"
        className="px-4 py-2 border-t border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#101520] flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span>
            تشخیص چندزبانه (Code-Switching):
          </span>
          <span dir="ltr" className="text-slate-800 dark:text-slate-200 font-mono tabular-nums">
            FA: {trilingualStats.persianCount}
          </span>
          <span dir="ltr" className="text-indigo-700 dark:text-indigo-300 font-mono tabular-nums">
            EN: {trilingualStats.englishCount}
          </span>
          <span dir="ltr" className="text-emerald-700 dark:text-emerald-300 font-mono tabular-nums">
            AR: {trilingualStats.arabicCount}
          </span>
          <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
            <span>اطمینان کالیبره‌شده (Platt):</span>
            <bdi dir="ltr" className="font-mono tabular-nums font-semibold">
              {(trilingualStats.meanCalibratedConfidence * 100).toFixed(1)}%
            </bdi>
          </span>
        </div>
        <span data-testid="transcript-token-count" className="inline-flex items-center gap-1">
          <span>واژگان همگام‌شده:</span>
          <bdi dir="ltr" className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
            {tokens.length}
          </bdi>
        </span>
      </div>
    </section>
  );
};
