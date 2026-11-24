import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Edit3,
  FileDiff,
  FileText,
  Gauge,
  Hash,
  ListTree,
  Loader2,
  Mic,
  Play,
  Scissors,
  Search,
  ShieldAlert,
  Sliders,
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
import {
  findActiveTokenIndexBinarySearch,
  findTokensInTimeRange,
  resolveSelectionAudioRange,
  searchTranscriptTokens,
  selectContiguousTokenRange,
} from '../utils/transcriptSync';
import type { WaveformSelectionState } from './AuditionTransportBar';
import { formatNumberForLocale, formatStudioTimecode } from '../utils/formatters';

type TranscriptLayer = 'display' | 'normalized' | 'original';

const HIGH_SCALE_WINDOW_THRESHOLD = 1500;
const HIGH_SCALE_PAGE_SIZE = 500;

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
  locale?: 'fa' | 'en';
  persianDigits?: boolean;
  timecodeFormat?: 'mm:ss.ms' | 'hh:mm:ss';
  showTimestamps?: boolean;
  autoFollowPlayhead?: boolean;
  timelineSelection?: WaveformSelectionState | null;
  onSyncTimelineSelection?: (sel: WaveformSelectionState | null) => void;
  onPlaySelectionRange?: (sel: WaveformSelectionState) => void;
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

interface MemoWordProps {
  tok: PersianWordToken;
  index: number;
  textValue: string;
  showLanguageBadge: boolean;
  isActivePlayhead: boolean;
  isSelected: boolean;
  isInTimelineSelection: boolean;
  isSearchHit: boolean;
  isCurrentSearchMatch: boolean;
  onWordClick: (tok: PersianWordToken, idx: number, e: React.MouseEvent<HTMLButtonElement>) => void;
  onWordKeyDown: (tok: PersianWordToken, idx: number, e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

const TranscriptWordItem = React.memo<MemoWordProps>(
  ({
    tok,
    index,
    textValue,
    showLanguageBadge,
    isActivePlayhead,
    isSelected,
    isInTimelineSelection,
    isSearchHit,
    isCurrentSearchMatch,
    onWordClick,
    onWordKeyDown,
  }) => {
    const startSec = flicksToSeconds(tok.range?.startFlicks ?? 0);
    const hasConfidence = Number.isFinite(tok.confidence) && tok.confidence > 0;

    return (
      <button
        type="button"
        data-testid={`transcript-token-${tok.id}`}
        data-active-playhead={isActivePlayhead ? 'true' : undefined}
        aria-pressed={isSelected}
        onClick={(e) => onWordClick(tok, index, e)}
        onKeyDown={(e) => onWordKeyDown(tok, index, e)}
        title={`${tok.speakerName || 'گوینده'} · ${startSec.toFixed(2)}s${hasConfidence ? ` · ${(tok.confidence * 100).toFixed(0)}%` : ''}`}
        className={`group inline-flex items-baseline gap-1 px-1.5 py-0 rounded-md leading-snug transition-colors cursor-pointer ${
          isSelected
            ? 'bg-[var(--avp-accent)] text-white font-semibold'
            : isCurrentSearchMatch
              ? 'bg-[var(--avp-warning)] text-slate-950 font-semibold ring-2 ring-[var(--avp-warning)]'
              : isSearchHit
                ? 'bg-[var(--avp-warning-soft)] text-[var(--avp-text)] ring-1 ring-[var(--avp-warning)] font-medium'
                : isActivePlayhead
                  ? 'bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                  : isInTimelineSelection
                    ? 'bg-[var(--avp-warning-soft)]/70 text-[var(--avp-text)] border-b-2 border-[var(--avp-warning)]'
                    : tok.isCrosstalkSuppressed
                      ? 'text-[var(--avp-text-faint)] line-through'
                      : tok.isDisfluency
                        ? 'bg-[var(--avp-danger-soft)] text-[var(--avp-danger)] ring-1 ring-inset ring-[var(--avp-danger)]/25 hover:opacity-90'
                        : tok.hasTrailingEzafeRisk
                          ? 'text-[var(--avp-text)] underline decoration-dotted decoration-[var(--avp-warning)] underline-offset-4 hover:bg-[var(--avp-surface-hover)]'
                          : 'text-[var(--avp-text)] hover:bg-[var(--avp-surface-hover)]'
        }`}
      >
        <span className={tok.isDisfluency && !isSelected ? 'line-through decoration-[var(--avp-danger)]/60' : ''}>
          {textValue}
        </span>
        {showLanguageBadge && tok.detectedLanguage === 'EN' && (
          <bdi
            dir="ltr"
            className={`text-[9px] font-mono leading-none px-0.5 rounded transition-opacity ${
              isSelected
                ? 'text-white/80'
                : 'text-[var(--avp-text-faint)] opacity-75'
            }`}
          >
            EN
          </bdi>
        )}
        {showLanguageBadge && tok.detectedLanguage === 'AR' && (
          <bdi
            dir="ltr"
            className={`text-[9px] font-mono leading-none px-0.5 rounded transition-opacity ${
              isSelected
                ? 'text-white/80'
                : 'text-[var(--avp-accent-text)] opacity-80'
            }`}
          >
            AR
          </bdi>
        )}
        {tok.hasTrailingEzafeRisk && (
          <AlertTriangle
            className={`w-3 h-3 shrink-0 self-center ${isSelected ? 'text-white' : 'text-[var(--avp-warning)]'}`}
            strokeWidth={1.75}
            aria-label="خطر کسره اضافه معلق"
          />
        )}
      </button>
    );
  },
);
TranscriptWordItem.displayName = 'TranscriptWordItem';

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  tokens,
  tracks,
  pcmSources,
  sampleRate,
  playheadSec,
  totalDurationSec = 12,
  locale = 'fa',
  persianDigits = false,
  timecodeFormat = 'mm:ss.ms',
  showTimestamps = true,
  autoFollowPlayhead = true,
  timelineSelection = null,
  onSyncTimelineSelection,
  onPlaySelectionRange,
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
  const isFa = locale === 'fa';
  const [layer, setLayer] = useState<TranscriptLayer>('display');
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);
  const [anchorTokenIndex, setAnchorTokenIndex] = useState<number | null>(null);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingTextValue, setEditingTextValue] = useState<string>('');
  const [showAdvancedTools, setShowAdvancedTools] = useState<boolean>(false);
  const [showForcedAlignDrawer, setShowForcedAlignDrawer] = useState<boolean>(false);
  const [forcedAlignError, setForcedAlignError] = useState<string | null>(null);
  const forcedAlignInputRef = useRef<HTMLTextAreaElement | null>(null);
  const streamContainerRef = useRef<HTMLDivElement | null>(null);
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
  const [showMobileSearch, setShowMobileSearch] = useState<boolean>(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState<number>(0);
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
  const [windowPage, setWindowPage] = useState<number>(0);

  useEffect(() => {
    const firstTrackId = tracks[0]?.id ?? 'track-host';
    setForcedAlignTrackId(firstTrackId);
    const nextTrackText = tokens
      .filter((t) => t.trackId === firstTrackId)
      .map((t) => t.displayText)
      .join(' ');
    setCustomScriptText(nextTrackText);
    setSelectedTokenIds([]);
    setAnchorTokenIndex(null);
    setEditingTokenId(null);
    setForcedAlignError(null);
    setWindowPage(0);
  }, [projectSessionNonce]);

  useEffect(() => {
    if (tracks.length > 0 && !tracks.some((t) => t.id === forcedAlignTrackId)) {
      setForcedAlignTrackId(tracks[0].id);
    }
  }, [tracks, forcedAlignTrackId]);

  const playheadFlicks = secondsToFlicks(playheadSec);

  // O(log N) active word lookup for smooth high-scale playback tracking
  const activePlayheadTokenIndex = useMemo(
    () => findActiveTokenIndexBinarySearch(tokens, playheadFlicks),
    [tokens, playheadFlicks],
  );

  const isWindowed = tokens.length > HIGH_SCALE_WINDOW_THRESHOLD;
  const totalPages = isWindowed ? Math.ceil(tokens.length / HIGH_SCALE_PAGE_SIZE) : 1;

  // Auto-follow playhead across pages and scroll active word into view when enabled
  useEffect(() => {
    if (!autoFollowPlayhead || activePlayheadTokenIndex < 0) return;
    if (isWindowed) {
      const targetPage = Math.floor(activePlayheadTokenIndex / HIGH_SCALE_PAGE_SIZE);
      if (targetPage !== windowPage) setWindowPage(targetPage);
    }
    const container = streamContainerRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>('[data-active-playhead="true"]');
    if (activeEl) {
      const cRect = container.getBoundingClientRect();
      const eRect = activeEl.getBoundingClientRect();
      if (eRect.top < cRect.top + 16 || eRect.bottom > cRect.bottom - 16) {
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [autoFollowPlayhead, activePlayheadTokenIndex, isWindowed, windowPage]);

  const visibleSliceStart = isWindowed ? windowPage * HIGH_SCALE_PAGE_SIZE : 0;
  const visibleTokens = useMemo(
    () =>
      isWindowed
        ? tokens.slice(visibleSliceStart, visibleSliceStart + HIGH_SCALE_PAGE_SIZE)
        : tokens,
    [tokens, isWindowed, visibleSliceStart],
  );

  // Clean up any stale selected IDs if tokens changed after a cut or Undo
  const activeSelectedIds = useMemo(() => {
    if (selectedTokenIds.length === 0) return [];
    const validSet = new Set(tokens.map((t) => t.id));
    return selectedTokenIds.filter((id) => validSet.has(id));
  }, [tokens, selectedTokenIds]);

  const selectedIdSet = useMemo(() => new Set(activeSelectedIds), [activeSelectedIds]);

  // Reverse sync: highlight tokens inside current Timeline selection
  const timelineSelectedTokenIdSet = useMemo(() => {
    if (!timelineSelection) return new Set<string>();
    const matched = findTokensInTimeRange(
      tokens,
      timelineSelection.startSec,
      timelineSelection.endSec,
    );
    return new Set(matched.map((t) => t.id));
  }, [tokens, timelineSelection]);

  // Combined Persian/Arabic/ZWNJ + phonetic search
  const normalizedSearchResult = useMemo(
    () => searchTranscriptTokens(tokens, phoneticQuery),
    [tokens, phoneticQuery],
  );

  const phoneticHits = useMemo(
    () =>
      phoneticQuery.trim().length > 0 && tokens.length <= 15_000
        ? searchTranscriptPhonetically(tokens, phoneticQuery)
        : [],
    [tokens, phoneticQuery],
  );

  const searchMatchedIds = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const id of normalizedSearchResult.matchedTokenIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    for (const h of phoneticHits) {
      for (const id of h.matchedTokenIds) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
    return ordered;
  }, [normalizedSearchResult, phoneticHits]);

  const searchMatchedTokenIdSet = useMemo(() => new Set(searchMatchedIds), [searchMatchedIds]);

  useEffect(() => {
    setActiveMatchIdx(0);
  }, [phoneticQuery]);

  const currentSearchMatchId =
    searchMatchedIds.length > 0
      ? searchMatchedIds[activeMatchIdx % searchMatchedIds.length]
      : null;

  const jumpToSearchMatch = (nextIdx: number) => {
    if (searchMatchedIds.length === 0) return;
    const wrapped = (nextIdx + searchMatchedIds.length) % searchMatchedIds.length;
    setActiveMatchIdx(wrapped);
    const targetId = searchMatchedIds[wrapped];
    const tokIdx = tokens.findIndex((t) => t.id === targetId);
    if (tokIdx >= 0) {
      if (isWindowed) {
        setWindowPage(Math.floor(tokIdx / HIGH_SCALE_PAGE_SIZE));
      }
      onSeekSec(flicksToSeconds(tokens[tokIdx].range?.startFlicks ?? 0));
    }
  };

  const trilingualStats = useMemo(() => computeTrilingualTranscriptStats(tokens), [tokens]);

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

  const validatedSelectedAudioRange = useMemo(
    () => resolveSelectionAudioRange(tokens, activeSelectedIds, totalDurationSec),
    [tokens, activeSelectedIds, totalDurationSec],
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

  const syncSelectionToTimeline = useCallback(
    (ids: string[], trackId: string) => {
      if (!onSyncTimelineSelection) return;
      if (ids.length === 0) {
        onSyncTimelineSelection(null);
        return;
      }
      const span = resolveSelectionAudioRange(tokens, ids, totalDurationSec);
      if (span) {
        onSyncTimelineSelection({
          startSec: span.startSec,
          endSec: span.endSec,
          trackId,
          scope: 'all',
        });
      }
    },
    [onSyncTimelineSelection, tokens, totalDurationSec],
  );

  const handleWordClick = useCallback(
    (tok: PersianWordToken, globalIndex: number, e: React.MouseEvent<HTMLButtonElement>) => {
      const startSec = flicksToSeconds(tok.range?.startFlicks ?? 0);
      onSeekSec(startSec);

      if (e.shiftKey && anchorTokenIndex !== null) {
        const rangeIds = selectContiguousTokenRange(tokens, anchorTokenIndex, globalIndex).filter(
          (id) => {
            const candidate = tokens.find((t) => t.id === id);
            return candidate?.trackId === tok.trackId;
          },
        );
        setSelectedTokenIds(rangeIds);
        syncSelectionToTimeline(rangeIds, tok.trackId);
        return;
      }

      setAnchorTokenIndex(globalIndex);
      const validSet = new Set(tokens.map((t) => t.id));
      const validPrev = activeSelectedIds.filter((id) => validSet.has(id));
      let next: string[];
      if (validPrev.includes(tok.id)) {
        next = validPrev.filter((id) => id !== tok.id);
      } else {
        const existingTrackId =
          validPrev.length > 0
            ? tokens.find((t) => t.id === validPrev[0])?.trackId
            : tok.trackId;
        next =
          existingTrackId && existingTrackId !== tok.trackId
            ? [tok.id]
            : [...validPrev, tok.id];
      }
      setSelectedTokenIds(next);
      syncSelectionToTimeline(next, tok.trackId);
    },
    [activeSelectedIds, anchorTokenIndex, onSeekSec, syncSelectionToTimeline, tokens],
  );

  const handleWordKeyDown = useCallback(
    (tok: PersianWordToken, globalIndex: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Escape') {
        setSelectedTokenIds([]);
        setEditingTokenId(null);
        onSyncTimelineSelection?.(null);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const step = isFa
          ? e.key === 'ArrowLeft'
            ? 1
            : -1
          : e.key === 'ArrowRight'
            ? 1
            : -1;
        const nextIdx = Math.max(0, Math.min(tokens.length - 1, globalIndex + step));
        if (nextIdx === globalIndex) return;
        e.preventDefault();
        const nextTok = tokens[nextIdx];
        if (!nextTok) return;
        if (e.shiftKey) {
          const base = anchorTokenIndex ?? globalIndex;
          const rangeIds = selectContiguousTokenRange(tokens, base, nextIdx);
          setSelectedTokenIds(rangeIds);
          syncSelectionToTimeline(rangeIds, nextTok.trackId);
        } else {
          setAnchorTokenIndex(nextIdx);
          setSelectedTokenIds([nextTok.id]);
          syncSelectionToTimeline([nextTok.id], nextTok.trackId);
        }
        onSeekSec(flicksToSeconds(nextTok.range?.startFlicks ?? 0));
      }
    },
    [anchorTokenIndex, isFa, onSeekSec, onSyncTimelineSelection, syncSelectionToTimeline, tokens],
  );

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
      onSyncTimelineSelection?.(null);
    }
  };

  const handlePreviewSelectedWords = () => {
    if (!validatedSelectedAudioRange || !onPlaySelectionRange) return;
    const trackId = multiWordCutSpec?.trackId ?? tracks[0]?.id ?? 'track-host';
    onPlaySelectionRange({
      startSec: validatedSelectedAudioRange.startSec,
      endSec: validatedSelectedAudioRange.endSec,
      trackId,
      scope: 'all',
    });
  };

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

  const openForcedAlignDrawer = () => {
    setShowAdvancedTools(true);
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

  const handleExecuteForcedAlign = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customScriptText.trim()) {
      setForcedAlignError(
        isFa ? 'لطفاً ابتدا متن گفتار را وارد کنید.' : 'Please enter speech text first.',
      );
      forcedAlignInputRef.current?.focus();
      return;
    }
    setForcedAlignError(null);
    onRunForcedAlignment(customScriptText.trim(), forcedAlignTrackId);
    setShowForcedAlignDrawer(false);
    setSelectedTokenIds([]);
  };

  const handleSelectAllSearchHits = () => {
    if (searchMatchedIds.length === 0) return;
    const firstTok = tokens.find((t) => t.id === searchMatchedIds[0]);
    if (!firstTok) return;
    const sameTrackIds = searchMatchedIds.filter((id) => {
      const tok = tokens.find((t) => t.id === id);
      return tok?.trackId === firstTok.trackId;
    });
    setSelectedTokenIds(sameTrackIds);
    syncSelectionToTimeline(sameTrackIds, firstTok.trackId);
    onSeekSec(flicksToSeconds(firstTok.range?.startFlicks ?? 0));
  };

  const layerLabels: { id: TranscriptLayer; label: string }[] = [
    { id: 'display', label: isFa ? 'نمایشی' : 'Display' },
    { id: 'normalized', label: isFa ? 'نرمال' : 'Norm' },
    { id: 'original', label: isFa ? 'خام' : 'Raw' },
  ];

  // Group visible words into contiguous editorial speaker-turn rows
  const speakerTurns = useMemo(() => {
    const groups: Array<{
      key: string;
      speakerLabel: string;
      trackId: string;
      isSecondaryTrack: boolean;
      startSec: number;
      items: Array<{ tok: PersianWordToken; globalIdx: number; textValue: string }>;
    }> = [];

    for (let localIdx = 0; localIdx < visibleTokens.length; localIdx++) {
      const tok = visibleTokens[localIdx];
      const globalIdx = visibleSliceStart + localIdx;
      const textValue =
        layer === 'original'
          ? (tok.originalText ?? tok.displayText ?? '')
          : layer === 'normalized'
            ? (tok.normalizedText ?? tok.displayText ?? '')
            : (tok.displayText ?? tok.originalText ?? '');

      if (layer === 'display' && textValue.trim().length === 0) continue;

      const turnPrefix = resolveSpeakerTurnLabel(tokens, globalIdx);
      const startSec = flicksToSeconds(tok.range?.startFlicks ?? 0);
      const trackIdx = tracks.findIndex((t) => t.id === tok.trackId);
      const isSecondaryTrack =
        trackIdx > 0 || tok.trackId.includes('guest') || (tok.speakerName ?? '').includes('آرش');

      if (groups.length === 0 || turnPrefix) {
        groups.push({
          key: `${tok.id}-${globalIdx}`,
          speakerLabel: turnPrefix || tok.speakerName || (isFa ? 'گوینده' : 'Speaker'),
          trackId: tok.trackId,
          isSecondaryTrack,
          startSec,
          items: [{ tok, globalIdx, textValue }],
        });
      } else {
        groups[groups.length - 1].items.push({ tok, globalIdx, textValue });
      }
    }
    return groups;
  }, [visibleTokens, visibleSliceStart, layer, tokens, tracks, isFa]);

  return (
    <section
      data-testid="transcript-panel"
      aria-label={isFa ? 'تدوین متن‌محور و رونویسی' : 'Text-Based Transcript Editor'}
      className="avp-pane relative flex-1 flex flex-col min-h-0 overflow-hidden"
    >
      {/* Single Compact 38px Editorial Toolbar (Strictly Single-Line on Desktop & Mobile) */}
      <div className="h-[38px] px-2.5 sm:px-3 border-b border-[var(--avp-border)] bg-[var(--avp-surface)] flex items-center justify-between gap-1.5 sm:gap-2 shrink-0">
        {/* Title + Word Count Pill + Inline Desktop Search / Mobile Search Toggle */}
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 shrink-0">
            <h2 className="text-[12px] sm:text-[12.5px] font-bold text-[var(--avp-text)] whitespace-nowrap">
              {isFa ? 'متن رونویسی' : 'Transcript'}
            </h2>
            <span
              data-testid="transcript-token-count"
              className="inline-flex items-center h-[20px] px-1.5 rounded bg-[var(--avp-surface-secondary)] border border-[var(--avp-border-subtle)] text-[10px] sm:text-[10.5px] font-medium text-[var(--avp-text-secondary)] whitespace-nowrap"
            >
              <bdi dir="ltr" className="avp-bidi-num font-mono font-semibold">{tokens.length}</bdi>
              <span className="hidden xl:inline ms-1">{isFa ? 'واژه' : 'words'}</span>
            </span>
          </div>

          <span className="avp-divider-v hidden xl:inline-block" aria-hidden="true" />

          {/* Desktop Inline Search Input (xl+) */}
          <div className="hidden xl:flex items-center gap-1 flex-1 min-w-0 max-w-[220px]">
            <div className="relative flex-1 min-w-0">
              <Search
                className="w-3.5 h-3.5 text-[var(--avp-text-faint)] absolute top-1/2 -translate-y-1/2 start-2.5 pointer-events-none"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <input
                type="text"
                data-testid="input-phonetic-search"
                value={phoneticQuery}
                onChange={(e) => setPhoneticQuery(e.target.value)}
                placeholder={isFa ? 'جستجو در متن...' : 'Search transcript...'}
                className="avp-input h-[26px] w-full ps-7 pe-7 text-xs"
              />
              {phoneticQuery ? (
                <button
                  type="button"
                  onClick={() => setPhoneticQuery('')}
                  aria-label={isFa ? 'پاک کردن جستجو' : 'Clear search'}
                  className="absolute top-1/2 -translate-y-1/2 end-1.5 text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] cursor-pointer"
                >
                  <X className="w-3 h-3" strokeWidth={1.75} />
                </button>
              ) : (
                <kbd
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 -translate-y-1/2 end-1.5 inline-flex items-center justify-center h-[16px] px-1 rounded border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] text-[9.5px] font-mono text-[var(--avp-text-faint)]"
                >
                  /
                </kbd>
              )}
            </div>

            {phoneticQuery.trim() && (
              <div className="flex items-center gap-0.5 shrink-0">
                <span
                  data-testid="phonetic-search-hit-count"
                  className="text-[11px] avp-bidi-num text-[var(--avp-text-secondary)] px-1"
                >
                  {searchMatchedIds.length > 0
                    ? `${(activeMatchIdx % searchMatchedIds.length) + 1}/${searchMatchedIds.length}`
                    : '0'}
                </span>
                <button
                  type="button"
                  disabled={searchMatchedIds.length === 0}
                  onClick={() => jumpToSearchMatch(activeMatchIdx - 1)}
                  aria-label={isFa ? 'نتیجه قبلی' : 'Previous match'}
                  className="avp-btn-icon-sm"
                >
                  <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  disabled={searchMatchedIds.length === 0}
                  onClick={() => jumpToSearchMatch(activeMatchIdx + 1)}
                  aria-label={isFa ? 'نتیجه بعدی' : 'Next match'}
                  className="avp-btn-icon-sm"
                >
                  <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
                {searchMatchedIds.length > 0 && (
                  <button
                    type="button"
                    data-testid="btn-select-search-hits"
                    onClick={handleSelectAllSearchHits}
                    className="avp-btn avp-btn-sm avp-btn-tonal"
                  >
                    {isFa ? 'انتخاب' : 'Select'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Compact/Tablet Search Toggle Icon Button (<xl) */}
          <div className="xl:hidden shrink-0">
            <button
              type="button"
              data-testid="btn-toggle-mobile-search"
              aria-expanded={showMobileSearch}
              aria-label={isFa ? 'جستجو در متن' : 'Search transcript'}
              onClick={() => setShowMobileSearch((v) => !v)}
              className={`avp-btn-icon avp-btn-icon-sm ${
                showMobileSearch || phoneticQuery.trim() ? 'avp-btn-tonal' : ''
              }`}
            >
              <Search className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Right/End Controls: Layer Segmented + Framed Text Tools + ASR Trigger (Strictly 26px height grid) */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div
            role="group"
            aria-label={isFa ? 'لایه متن' : 'Transcript layer'}
            className="avp-segmented avp-segmented-sm h-[26px]"
          >
            {layerLabels.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLayer(item.id)}
                aria-pressed={layer === item.id}
                className="avp-segmented-item"
              >
                {item.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            data-testid="btn-toggle-advanced-text-tools"
            aria-expanded={showAdvancedTools}
            aria-label={isFa ? 'ابزارهای متنی' : 'Text Tools'}
            title={isFa ? 'ابزارهای متنی' : 'Text Tools'}
            onClick={() => setShowAdvancedTools((v) => !v)}
            className={`inline-flex items-center gap-1 h-[26px] px-2 rounded-lg border text-[11px] font-medium cursor-pointer transition-colors ${
              showAdvancedTools
                ? 'border-[var(--avp-accent)]/40 bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                : 'border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/70 text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface-hover)]'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden xl:inline">{isFa ? 'ابزارهای متنی' : 'Text Tools'}</span>
            {showAdvancedTools ? (
              <ChevronUp className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            data-testid="btn-run-persian-asr"
            disabled={isTranscribingAsr}
            onClick={onRunPersianAsr}
            className={`avp-btn avp-btn-sm h-[26px] ${
              tokens.length === 0 ? 'avp-btn-primary' : 'avp-btn-tonal'
            }`}
          >
            {isTranscribingAsr ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Mic className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            )}
            <span className="hidden xs:inline sm:inline">
              {isTranscribingAsr
                ? isFa
                  ? 'در حال رونویسی...'
                  : 'Transcribing...'
                : isFa
                  ? 'رونویسی (ASR)'
                  : 'Transcribe'}
            </span>
          </button>
        </div>

        {/* Accessible screen-reader status */}
        <div data-testid="transcript-shahab-status" className="sr-only">
          {shahabRuntimeStatus?.available || companionHealth?.runtime?.available || hasBrowserInstalledModel
            ? isFa
              ? 'موتور فارسی محلی آماده'
              : 'Local Persian ASR Ready'
            : isCheckingCompanion
              ? isFa
                ? 'بررسی موتور محلی...'
                : 'Checking local ASR...'
              : isFa
                ? 'موتور محلی نصب نشده'
                : 'Local ASR Not Installed'}
        </div>
      </div>

      {/* Collapsible Compact/Tablet Search Row (<xl, toggled via search icon) */}
      {showMobileSearch && (
        <div className="xl:hidden px-3 py-1.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search
              className="w-3.5 h-3.5 text-[var(--avp-text-faint)] absolute top-1/2 -translate-y-1/2 start-2.5 pointer-events-none"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              type="text"
              value={phoneticQuery}
              onChange={(e) => setPhoneticQuery(e.target.value)}
              placeholder={isFa ? 'جستجو در متن...' : 'Search transcript...'}
              className="avp-input h-7 w-full ps-8 pe-6 text-xs"
            />
            {phoneticQuery && (
              <button
                type="button"
                onClick={() => setPhoneticQuery('')}
                aria-label={isFa ? 'پاک کردن جستجو' : 'Clear search'}
                className="absolute top-1/2 -translate-y-1/2 end-1.5 text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] cursor-pointer"
              >
                <X className="w-3 h-3" strokeWidth={1.75} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Contextual Advanced Text Tools Popover (Tier 3 Layering on Desktop: zero vertical layout shift on transcript stream) */}
      {showAdvancedTools && (
        <div
          data-testid="transcript-advanced-tools-popover"
          className="px-4 py-2.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-floating)] lg:bg-[var(--avp-surface-floating)]/98 lg:backdrop-blur-xs lg:absolute lg:top-[38px] lg:inset-x-0 lg:z-40 lg:shadow-[var(--avp-shadow-md)] lg:max-h-[420px] lg:overflow-y-auto space-y-2.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="btn-toggle-forced-align"
              onClick={() => setShowForcedAlignDrawer((v) => !v)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-[var(--avp-text)] cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-[var(--avp-warning)]" />
              <span>{isFa ? 'هم‌ترازی با متن (Forced Align)' : 'Forced Align'}</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-script-diff"
              onClick={() => setShowScriptDiffDrawer((v) => !v)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-[var(--avp-text)] cursor-pointer"
            >
              <FileDiff className="w-3.5 h-3.5 text-[var(--avp-accent)]" />
              <span>{isFa ? 'تطبیق متن مرجع (Script Diff)' : 'Script Diff'}</span>
            </button>

            {onRestoreProsodicPunctuation && (
              <button
                type="button"
                data-testid="btn-restore-punctuation"
                onClick={onRestoreProsodicPunctuation}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] cursor-pointer"
              >
                <BookOpenCheck className="w-3.5 h-3.5" />
                <span>{isFa ? 'علائم سجاوندی' : 'Punctuation'}</span>
              </button>
            )}

            {onConvertColloquialToFormal && (
              <button
                type="button"
                data-testid="btn-formalize-colloquial"
                onClick={onConvertColloquialToFormal}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] cursor-pointer"
              >
                <Wand2 className="w-3.5 h-3.5" />
                <span>{isFa ? 'محاوره به معیار' : 'Formalize'}</span>
              </button>
            )}

            {onNormalizeNumbersAndCompounds && (
              <button
                type="button"
                data-testid="btn-normalize-numbers-compounds"
                onClick={onNormalizeNumbersAndCompounds}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] cursor-pointer"
              >
                <Hash className="w-3.5 h-3.5" />
                <span>{isFa ? 'اعداد و نیم‌فاصله' : 'Normalize'}</span>
              </button>
            )}

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
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] cursor-pointer"
              >
                <span>
                  {isFa ? 'سه‌زبانه' : 'Trilingual'} ({trilingualStats.englishCount} EN)
                </span>
              </button>
            )}

            <button
              type="button"
              data-testid="btn-toggle-prosody-lexicon"
              onClick={() => setShowProsodyLexiconDrawer((v) => !v)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] cursor-pointer"
            >
              <ListTree className="w-3.5 h-3.5" />
              <span>{isFa ? 'فصل‌بندی و واژگان' : 'Chapters & Lexicon'}</span>
            </button>

            <button
              type="button"
              data-testid="btn-toggle-srt-preview"
              onClick={() => setSubtitlePreviewMode((m) => (m === 'none' ? 'srt' : 'none'))}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>SRT / VTT / TextGrid</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAdvancedTools(false)}
              aria-label={isFa ? 'بستن ابزارهای متنی' : 'Close text tools'}
              className="ms-auto avp-btn-icon avp-btn-icon-sm"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </div>

          {showForcedAlignDrawer && (
            <form
              onSubmit={handleExecuteForcedAlign}
              className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--avp-text)]">
                  {isFa ? 'هم‌ترازی متن دلخواه با صوت (Forced Align)' : 'Forced Text-to-Audio Alignment'}
                </span>
                <select
                  value={forcedAlignTrackId}
                  onChange={(e) => setForcedAlignTrackId(e.target.value)}
                  className="px-2 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] text-xs"
                >
                  {tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                ref={forcedAlignInputRef}
                data-testid="input-forced-align-script"
                rows={3}
                value={customScriptText}
                onChange={(e) => setCustomScriptText(e.target.value)}
                className="w-full rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] p-2.5 text-xs"
              />
              {forcedAlignError && <p className="text-[var(--avp-danger)]">{forcedAlignError}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowForcedAlignDrawer(false)}
                  className="px-3 py-1.5 rounded-lg border border-[var(--avp-border)] cursor-pointer"
                >
                  {isFa ? 'بستن' : 'Close'}
                </button>
                <button
                  type="submit"
                  data-testid="btn-apply-forced-align"
                  className="px-3.5 py-1.5 rounded-lg bg-[var(--avp-accent)] text-white font-semibold cursor-pointer"
                >
                  {isFa ? 'اجرای هم‌ترازی' : 'Run Forced Align'}
                </button>
              </div>
            </form>
          )}

          {showScriptDiffDrawer && (
            <div
              data-testid="script-diff-drawer"
              className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{isFa ? 'مقایسه با متن مرجع' : 'Reference Script Diff'}</span>
                {scriptDiffReport && (
                  <span data-testid="script-diff-extra-count" className="text-[11px] font-mono">
                    {scriptDiffReport.extraSpokenTokenIds.length} {isFa ? 'واژه اضافه' : 'extra'}
                  </span>
                )}
              </div>
              <textarea
                data-testid="input-reference-script"
                rows={2}
                value={referenceBookScript}
                onChange={(e) => setReferenceBookScript(e.target.value)}
                className="w-full rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] p-2 text-xs"
              />
              {scriptDiffReport && scriptDiffReport.extraSpokenTokenIds.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-select-script-extras"
                  onClick={() => {
                    setSelectedTokenIds(scriptDiffReport.extraSpokenTokenIds);
                    const firstTok = tokens.find(
                      (t) => t.id === scriptDiffReport.extraSpokenTokenIds[0],
                    );
                    if (firstTok) onSeekSec(flicksToSeconds(firstTok.range?.startFlicks ?? 0));
                  }}
                  className="px-2.5 py-1 rounded-md bg-[var(--avp-warning)] text-slate-950 font-semibold cursor-pointer"
                >
                  {isFa ? 'انتخاب واژه‌های اضافه' : 'Select Extra Spoken Words'}
                </button>
              )}
            </div>
          )}

          {showProsodyLexiconDrawer && (
            <div
              data-testid="prosody-lexicon-drawer"
              className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{isFa ? 'واژه‌نامه اختصاصی و فصل‌ها' : 'Custom Lexicon & Chapters'}</span>
                {onApplyCustomLexicon && (
                  <button
                    type="button"
                    data-testid="btn-apply-custom-lexicon"
                    onClick={() => onApplyCustomLexicon(customLexiconInput)}
                    className="px-2.5 py-1 rounded-md bg-[var(--avp-accent)] text-white font-semibold cursor-pointer"
                  >
                    {isFa ? 'اعمال واژگان' : 'Apply Lexicon'}
                  </button>
                )}
              </div>
              <input
                type="text"
                data-testid="input-custom-lexicon"
                value={customLexiconInput}
                onChange={(e) => setCustomLexiconInput(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] text-xs"
              />
              {prosodyAndChaptersReport && prosodyAndChaptersReport.chapters.length > 0 && (
                <div data-testid="chapter-markers-list" className="flex flex-wrap gap-1.5">
                  {prosodyAndChaptersReport.chapters.map((ch) => {
                    const chapterStartSec = flicksToSeconds(ch.range.start);
                    return (
                      <button
                        key={ch.chapterIndex}
                        type="button"
                        data-testid={`btn-seek-chapter-${ch.chapterIndex}`}
                        onClick={() => onSeekSec(chapterStartSec)}
                        className="px-2 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] text-[11px] cursor-pointer"
                      >
                        {ch.suggestedTitleFa} ({ch.startTimestampFormatted})
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {subtitlePreviewMode !== 'none' && (
            <div
              data-testid="subtitle-export-drawer"
              className="p-3 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  {(['srt', 'vtt', 'textgrid'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-testid={m === 'textgrid' ? 'btn-preview-textgrid' : undefined}
                      onClick={() => setSubtitlePreviewMode(m)}
                      className={`px-2 py-1 rounded-md text-[11px] font-mono uppercase cursor-pointer ${
                        subtitlePreviewMode === m
                          ? 'bg-[var(--avp-accent)] text-white'
                          : 'border border-[var(--avp-border)]'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="btn-download-srt"
                    onClick={() => handleDownloadSubtitleFile('srt')}
                    className="px-2 py-1 rounded-md border border-[var(--avp-border)] text-[11px] cursor-pointer"
                  >
                    SRT
                  </button>
                  <button
                    type="button"
                    data-testid="btn-download-vtt"
                    onClick={() => handleDownloadSubtitleFile('vtt')}
                    className="px-2 py-1 rounded-md border border-[var(--avp-border)] text-[11px] cursor-pointer"
                  >
                    VTT
                  </button>
                  <button
                    type="button"
                    data-testid="btn-download-textgrid"
                    onClick={() => handleDownloadSubtitleFile('textgrid')}
                    className="px-2 py-1 rounded-md border border-[var(--avp-border)] text-[11px] cursor-pointer"
                  >
                    TextGrid
                  </button>
                </div>
              </div>
              <pre
                data-testid="subtitle-preview-text"
                dir="ltr"
                className="max-h-32 overflow-y-auto p-2 rounded-lg bg-[var(--avp-surface-secondary)] font-mono text-[11px]"
              >
                {subtitlePreviewContent}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Contextual Word Selection Action Bar (Clear Separation: Text-Only Edit vs Audio Deletion) */}
      {activeSelectedIds.length > 0 && (
        <div
          data-testid="transcript-word-edit-bar"
          className="px-4 py-2.5 border-b border-[var(--avp-border)] bg-[var(--avp-accent-soft)]/70 space-y-2 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-bold text-[var(--avp-accent-text)]">
                {activeSelectedIds.length} {isFa ? 'واژه انتخاب‌شده' : 'word(s) selected'}
              </span>
              {validatedSelectedAudioRange && (
                <span dir="ltr" className="font-mono text-[11px] text-[var(--avp-text-secondary)]">
                  {validatedSelectedAudioRange.startSec.toFixed(2)}s –{' '}
                  {validatedSelectedAudioRange.endSec.toFixed(2)}s (Δ{' '}
                  {validatedSelectedAudioRange.durationSec.toFixed(2)}s)
                </span>
              )}
              {syncSafetyDecision?.mode === 'in-place-room-tone-suppression' && (
                <span className="text-[11px] text-[var(--avp-warning)] font-medium">
                  · {isFa ? 'پیشنهاد حفظ سینک: Room Tone' : 'Sync-Safe: Room Tone'}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* Preview Selected Words Audio */}
              {onPlaySelectionRange && validatedSelectedAudioRange && (
                <button
                  type="button"
                  data-testid="btn-preview-selected-words"
                  onClick={handlePreviewSelectedWords}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-[var(--avp-text)] font-medium cursor-pointer"
                >
                  <Play className="w-3 h-3 text-[var(--avp-accent)]" aria-hidden="true" />
                  <span>{isFa ? 'پخش انتخاب' : 'Play Selection'}</span>
                </button>
              )}

              {/* Action 1: Text-Only Correction (Explicitly does NOT modify audio) */}
              {activeSelectedIds.length === 1 && (
                <button
                  type="button"
                  data-testid="btn-edit-word-spelling"
                  onClick={handleStartEditSingleWord}
                  title={
                    isFa
                      ? 'اصلاح املای کلمه فقط در متن رونویسی — هیچ تغییری در فایل صوتی ایجاد نمی‌شود'
                      : 'Edit transcript text only — does not alter audio'
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-[var(--avp-text)] font-medium cursor-pointer"
                >
                  <Edit3 className="w-3 h-3 text-[var(--avp-accent)]" aria-hidden="true" />
                  <span>{isFa ? 'اصلاح متن (بدون تغییر صوت)' : 'Edit Text Only'}</span>
                </button>
              )}

              {/* Action 2: Audio Range Deletion (Non-destructive Ripple Cut) */}
              <button
                type="button"
                data-testid="btn-cut-selected-words"
                onClick={() => handleApplyCut()}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--avp-danger)] hover:opacity-90 text-white font-semibold cursor-pointer"
              >
                <Scissors className="w-3 h-3" aria-hidden="true" />
                <span>{isFa ? 'حذف از صوت' : 'Delete Audio'}</span>
              </button>

              <button
                type="button"
                data-testid="btn-roomtone-cut-words"
                onClick={() => handleApplyCut('in-place-room-tone-suppression')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--avp-accent)]/40 bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-medium cursor-pointer"
              >
                <VolumeX className="w-3 h-3" aria-hidden="true" />
                <span>{isFa ? 'Room Tone درجا' : 'Room Tone'}</span>
              </button>

              {onRedactSelectedWords && (
                <button
                  type="button"
                  data-testid="btn-redact-bleep-words"
                  onClick={() => {
                    if (onRedactSelectedWords(activeSelectedIds, 'BROADCAST_BLEEP_1KHZ') !== false) {
                      setSelectedTokenIds([]);
                    }
                  }}
                  title={isFa ? 'بوق سانسور ۱ کیلوهرتز' : '1kHz Bleep Redaction'}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] cursor-pointer"
                >
                  <ShieldAlert className="w-3 h-3 text-[var(--avp-warning)]" aria-hidden="true" />
                  <span>{isFa ? 'بوق' : 'Bleep'}</span>
                </button>
              )}

              {onWsolaTimeStretchSelectedWords && (
                <button
                  type="button"
                  data-testid="btn-wsola-fast-words"
                  onClick={() => {
                    if (onWsolaTimeStretchSelectedWords(activeSelectedIds, 1.2) !== false) {
                      setSelectedTokenIds([]);
                    }
                  }}
                  title={isFa ? 'تند کردن گفتار انتخابی (WSOLA)' : 'Speed up selection (WSOLA)'}
                  className="hidden xl:inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] cursor-pointer"
                >
                  <Gauge className="w-3 h-3" aria-hidden="true" />
                  <span>1.2x</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setSelectedTokenIds([]);
                  setEditingTokenId(null);
                  onSyncTimelineSelection?.(null);
                }}
                aria-label={isFa ? 'لغو انتخاب واژه‌ها' : 'Clear word selection'}
                className="p-1 rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Inline Text-Only Spelling Correction Form */}
          {editingTokenId && (
            <form
              onSubmit={handleSaveSingleWordEdit}
              className="flex items-center gap-2 pt-1.5 border-t border-[var(--avp-border)]"
            >
              <span className="text-[11px] text-[var(--avp-text-secondary)] shrink-0">
                {isFa ? 'اصلاح فقط متن رونویسی:' : 'Transcript text only:'}
              </span>
              <input
                type="text"
                autoFocus
                data-testid="input-edit-word-text"
                value={editingTextValue}
                onChange={(e) => setEditingTextValue(e.target.value)}
                className="flex-1 max-w-xs px-2.5 py-1 rounded-lg border border-[var(--avp-accent)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)]"
              />
              <button
                type="submit"
                data-testid="btn-save-word-text"
                className="px-3 py-1 rounded-lg bg-[var(--avp-accent)] text-white font-semibold text-xs cursor-pointer"
              >
                {isFa ? 'ذخیره متن' : 'Save Text'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Honest Inline ASR Status / Unavailability Panel */}
      {asrInlineFeedback && (
        <div
          role={asrInlineFeedback.kind === 'SUCCESS' ? 'status' : 'alert'}
          data-testid="transcript-asr-inline-panel"
          className={`px-4 py-3 border-b border-[var(--avp-border)] text-xs space-y-2 ${
            asrInlineFeedback.kind === 'SUCCESS'
              ? 'bg-[var(--avp-accent-soft)]/60 text-[var(--avp-text)]'
              : 'bg-[var(--avp-warning-soft)]/70 text-[var(--avp-text)]'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                {asrInlineFeedback.kind === 'SUCCESS' ? (
                  <Check className="w-3.5 h-3.5 shrink-0 text-[var(--avp-accent)]" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[var(--avp-warning)]" aria-hidden="true" />
                )}
                <span>{asrInlineFeedback.titleFa}</span>
              </div>
              <p className="text-[11px] text-[var(--avp-text-secondary)] leading-relaxed">
                {asrInlineFeedback.messageFa}
              </p>
            </div>
            {onDismissAsrInlineFeedback && (
              <button
                type="button"
                onClick={onDismissAsrInlineFeedback}
                aria-label={isFa ? 'بستن پیام' : 'Dismiss notice'}
                className="p-1 rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {asrInlineFeedback.kind !== 'SUCCESS' && (
            <div className="flex flex-wrap items-center gap-2">
              {cloudAsrConfigured &&
                onRunCloudGeminiAsr &&
                asrInlineFeedback.kind !== 'READ_ONLY' &&
                asrInlineFeedback.kind !== 'AUDIO_MISSING' && (
                  <button
                    type="button"
                    data-testid="btn-inline-cloud-gemini-asr"
                    disabled={isTranscribingAsr}
                    onClick={onRunCloudGeminiAsr}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--avp-accent)] text-white font-semibold text-xs hover:bg-[var(--avp-accent-hover)] disabled:opacity-50 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {executionMode === 'CLOUD'
                        ? isFa
                          ? 'اجرای Gemini ASR'
                          : 'Run Gemini ASR'
                        : isFa
                          ? 'تشخیص با Gemini ASR (انتقال صریح به ابری)'
                          : 'Use Gemini ASR (Opt-In Cloud)'}
                    </span>
                  </button>
                )}

              {asrInlineFeedback.kind === 'CLOUD_UNCONFIGURED' && onSwitchToLocalExecutionMode && (
                <button
                  type="button"
                  data-testid="btn-inline-switch-local"
                  onClick={onSwitchToLocalExecutionMode}
                  className="px-2.5 py-1.5 rounded-lg bg-[var(--avp-accent)] text-white font-semibold text-xs cursor-pointer"
                >
                  {isFa ? 'تغییر به حالت محلی' : 'Switch to Local'}
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
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text)] font-medium text-xs cursor-pointer"
                  >
                    <Wand2 className="w-3.5 h-3.5 text-[var(--avp-accent)]" />
                    <span>{isFa ? 'بخش‌بندی زمانی بدون تشخیص کلمه' : 'Acoustic Segmentation'}</span>
                  </button>
                )}

              {asrInlineFeedback.kind !== 'READ_ONLY' && asrInlineFeedback.kind !== 'AUDIO_MISSING' && (
                <button
                  type="button"
                  data-testid="btn-inline-open-forced-align"
                  onClick={openForcedAlignDrawer}
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text)] text-xs cursor-pointer"
                >
                  {isFa ? 'هم‌ترازی با متن دلخواه' : 'Forced Align'}
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
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--avp-accent)] text-white font-semibold text-xs disabled:opacity-50 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {isInstallingBrowserModel
                        ? `${browserModelInstallPct ?? 0}%`
                        : isFa
                          ? 'نصب مدل فارسی مرورگر (آفلاین)'
                          : 'Install Local Browser Model'}
                    </span>
                  </button>
                )}

              {asrInlineFeedback.kind === 'MODEL_NOT_INSTALLED' && onOpenLocalModelInstaller && (
                <button
                  type="button"
                  data-testid="btn-inline-open-model-modal"
                  onClick={onOpenLocalModelInstaller}
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] text-xs cursor-pointer"
                >
                  {isFa ? 'ورود دستی فایل مدل (.onnx)' : 'Load Local .onnx Model'}
                </button>
              )}

              {onRetryCompanionConnection && (
                <button
                  type="button"
                  data-testid="btn-inline-retry-companion"
                  onClick={onRetryCompanionConnection}
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] text-xs cursor-pointer"
                >
                  {isFa ? 'بررسی مجدد موتور محلی' : 'Retry Local Engine'}
                </button>
              )}

              {companionHealth && onInstallNativeCompanionEngine && (
                <button
                  type="button"
                  data-testid="btn-inline-install-native-asr"
                  disabled={isInstallingNativeAsr}
                  onClick={onInstallNativeCompanionEngine}
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--avp-accent)]/40 bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-medium text-xs cursor-pointer"
                >
                  {isFa ? 'نصب موتور بومی شهاب' : 'Install Native Engine'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* High-Scale Pagination Header (only shown for >1,500 words) */}
      {isWindowed && (
        <div className="px-4 py-1.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] flex items-center justify-between text-[11px] text-[var(--avp-text-secondary)]">
          <span>
            {isFa
              ? `نمایش واژه‌های ${visibleSliceStart + 1} تا ${Math.min(tokens.length, visibleSliceStart + HIGH_SCALE_PAGE_SIZE)} از ${tokens.length}`
              : `Showing words ${visibleSliceStart + 1}–${Math.min(tokens.length, visibleSliceStart + HIGH_SCALE_PAGE_SIZE)} of ${tokens.length}`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={windowPage === 0}
              onClick={() => setWindowPage((p) => Math.max(0, p - 1))}
              className="px-2 py-0.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] disabled:opacity-40 cursor-pointer"
            >
              {isFa ? 'قبلی' : 'Prev'}
            </button>
            <span className="font-mono px-1.5">
              {windowPage + 1}/{totalPages}
            </span>
            <button
              type="button"
              disabled={windowPage >= totalPages - 1}
              onClick={() => setWindowPage((p) => Math.min(totalPages - 1, p + 1))}
              className="px-2 py-0.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] disabled:opacity-40 cursor-pointer"
            >
              {isFa ? 'بعدی' : 'Next'}
            </button>
          </div>
        </div>
      )}

      {/* Editorial Word Stream Body — Speaker-Gutter Reading Surface */}
      <div
        ref={streamContainerRef}
        data-testid="transcript-word-stream"
        className="flex-1 px-4 sm:px-6 py-4 min-h-[240px] overflow-y-auto bg-[var(--avp-surface)] avp-transcript-body"
      >
        {tokens.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <p className="text-sm font-semibold text-[var(--avp-text)]">
              {isFa
                ? 'هنوز رونویسی برای این فایل تولید نشده است'
                : 'No transcript has been generated for this audio yet'}
            </p>
            <p className="text-xs text-[var(--avp-text-muted)] max-w-md mx-auto">
              {isFa
                ? 'می‌توانید رونویسی محلی یا بخش‌بندی صوتی را اجرا کنید یا متن آماده را با صوت هم‌تراز نمایید.'
                : 'Run local speech transcription, acoustic segmentation, or forced alignment with an existing script.'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <button
                type="button"
                data-testid="btn-empty-run-persian-asr"
                disabled={isTranscribingAsr || isInstallingBrowserModel}
                onClick={onRunPersianAsr}
                className="avp-btn avp-btn-primary"
              >
                <Mic className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>{isFa ? 'شروع رونویسی (ASR)' : 'Start Transcription'}</span>
              </button>

              {onRunAcousticSegmentation && (
                <button
                  type="button"
                  data-testid="btn-empty-acoustic-segment"
                  disabled={isTranscribingAsr}
                  onClick={onRunAcousticSegmentation}
                  className="avp-btn avp-btn-outline"
                >
                  <Wand2 className="w-3.5 h-3.5 text-[var(--avp-accent)]" strokeWidth={1.75} />
                  <span>{isFa ? 'بخش‌بندی زمانی' : 'Acoustic Segments'}</span>
                </button>
              )}

              <button
                type="button"
                data-testid="btn-empty-forced-align"
                onClick={openForcedAlignDrawer}
                className="avp-btn avp-btn-outline"
              >
                <Sparkles className="w-3.5 h-3.5 text-[var(--avp-warning)]" strokeWidth={1.75} />
                <span>{isFa ? 'هم‌ترازی متن دلخواه' : 'Forced Align'}</span>
              </button>

              {onLoadAndTranscribeSamplePersianAudio &&
                (shahabRuntimeStatus?.available ||
                  companionHealth?.runtime?.available ||
                  hasBrowserInstalledModel) && (
                  <button
                    type="button"
                    data-testid="btn-empty-test-sample-persian"
                    onClick={onLoadAndTranscribeSamplePersianAudio}
                    className="avp-btn avp-btn-tonal"
                  >
                    {isFa ? 'تست با نمونه فارسی' : 'Test Persian Sample'}
                  </button>
                )}
            </div>
          </div>
        ) : (
          <div className="w-full divide-y divide-[var(--avp-border-subtle)]">
            {speakerTurns.map((turn) => {
              const isTurnActive = turn.items.some(
                (it) => it.globalIdx === activePlayheadTokenIndex,
              );
              const lastTok = turn.items[turn.items.length - 1]?.tok;
              const turnEndSec = lastTok
                ? flicksToSeconds(lastTok.range?.endFlicks ?? 0)
                : turn.startSec + 0.5;
              const turnDurSec = Math.max(0.1, turnEndSec - turn.startSec);
              const turnTokenIds = turn.items.map((it) => it.tok.id);
              const isEntireTurnSelected =
                turnTokenIds.length > 0 && turnTokenIds.every((id) => selectedIdSet.has(id));

              return (
                <div
                  key={turn.key}
                  className={`group/turn grid grid-cols-1 sm:grid-cols-[88px_1fr_120px] gap-y-1 sm:gap-x-3 py-2.5 px-2 -mx-2 rounded-lg transition-colors items-baseline ${
                    isTurnActive
                      ? 'bg-[var(--avp-accent-soft)]/30'
                      : 'hover:bg-[var(--avp-surface-secondary)]/45'
                  }`}
                >
                  {/* Column 1 (Right in RTL — 88px Speaker Gutter) */}
                  <button
                    type="button"
                    data-testid="transcript-speaker-turn"
                    onClick={() => onSeekSec(turn.startSec)}
                    title={
                      isFa
                        ? `پرش به ${turn.speakerLabel} (${turn.startSec.toFixed(1)}s)`
                        : `Seek to ${turn.speakerLabel} (${turn.startSec.toFixed(1)}s)`
                    }
                    className="flex sm:flex-col items-baseline sm:items-start gap-2 sm:gap-1 select-none pt-0.5 ps-2 border-s-2 text-start cursor-pointer transition-colors"
                    style={{
                      borderInlineStartColor: turn.isSecondaryTrack ? '#38bdf8' : '#10b981',
                    }}
                  >
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-bold truncate max-w-full ${
                        turn.isSecondaryTrack
                          ? 'text-sky-600 dark:text-sky-400'
                          : 'text-[var(--avp-accent-text)]'
                      }`}
                    >
                      <bdi>{turn.speakerLabel}</bdi>
                    </span>
                    {showTimestamps && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded bg-[var(--avp-surface-secondary)]/80 group-hover/turn:bg-[var(--avp-accent-soft)]/60 transition-colors">
                        <Play
                          className="w-2 h-2 opacity-60 sm:opacity-40 group-hover/turn:opacity-100 text-[var(--avp-accent-text)] transition-opacity shrink-0 fill-current"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                        <bdi
                          dir="ltr"
                          className="avp-bidi-num text-[9.5px] text-[var(--avp-text-muted)] group-hover/turn:text-[var(--avp-text)]"
                        >
                          {formatStudioTimecode(turn.startSec, timecodeFormat, persianDigits)}
                        </bdi>
                      </span>
                    )}
                  </button>

                  {/* Column 2 (Center — Balanced Editorial Word Flow) */}
                  <div className="flex flex-wrap items-baseline gap-x-1 gap-y-1.5 max-w-[72ch]">
                    {turn.items.map(({ tok, globalIdx, textValue }) => (
                      <TranscriptWordItem
                        key={tok.id}
                        tok={tok}
                        index={globalIdx}
                        textValue={textValue}
                        showLanguageBadge={layer === 'original'}
                        isActivePlayhead={globalIdx === activePlayheadTokenIndex}
                        isSelected={selectedIdSet.has(tok.id)}
                        isInTimelineSelection={timelineSelectedTokenIdSet.has(tok.id)}
                        isSearchHit={searchMatchedTokenIdSet.has(tok.id)}
                        isCurrentSearchMatch={currentSearchMatchId === tok.id}
                        onWordClick={handleWordClick}
                        onWordKeyDown={handleWordKeyDown}
                      />
                    ))}
                  </div>

                  {/* Column 3 (Left/End — Aligned Axis & Touch Discoverable) */}
                  <div className="flex items-center justify-end gap-1 self-center sm:border-s border-[var(--avp-border-subtle)] sm:ps-2 min-w-[112px]">
                    {onPlaySelectionRange && (
                      <button
                        type="button"
                        onClick={() =>
                          onPlaySelectionRange({
                            startSec: turn.startSec,
                            endSec: turnEndSec,
                            trackId: turn.trackId,
                            scope: 'track',
                          })
                        }
                        title={isFa ? 'پخش این نوبت گفتار' : 'Play this speaker turn'}
                        aria-label={isFa ? 'پخش نوبت گفتار' : 'Play speaker turn'}
                        className="inline-flex items-center justify-center w-[22px] h-[22px] rounded border border-[var(--avp-border-subtle)] bg-[var(--avp-surface)] text-[var(--avp-text-muted)] opacity-75 sm:opacity-0 sm:group-hover/turn:opacity-100 focus-visible:opacity-100 hover:text-[var(--avp-accent-text)] hover:border-[var(--avp-accent)]/50 transition-all cursor-pointer shrink-0"
                      >
                        <Play className="w-2.5 h-2.5 fill-current" strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTokenIds(turnTokenIds);
                        syncSelectionToTimeline(turnTokenIds, turn.trackId);
                      }}
                      title={
                        isFa
                          ? `انتخاب کل این نوبت (${turn.items.length} واژه · ${turnDurSec.toFixed(1)} ثانیه)`
                          : `Select entire turn (${turn.items.length} words · ${turnDurSec.toFixed(1)}s)`
                      }
                      className={`inline-flex items-center gap-1 h-[22px] px-1.5 rounded border text-[9.5px] font-mono tabular-nums transition-all cursor-pointer shrink-0 ${
                        isEntireTurnSelected
                          ? 'border-[var(--avp-accent)] bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                          : 'border-[var(--avp-border-subtle)] bg-[var(--avp-surface-secondary)]/55 text-[var(--avp-text-faint)] group-hover/turn:border-[var(--avp-border)] group-hover/turn:text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)]'
                      }`}
                    >
                      <bdi dir="ltr">{formatNumberForLocale(turnDurSec, { persianDigits, maximumFractionDigits: 1 })}s</bdi>
                      <span aria-hidden="true">·</span>
                      <span>
                        {formatNumberForLocale(turn.items.length, { persianDigits })} {isFa ? 'واژه' : 'w'}
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
