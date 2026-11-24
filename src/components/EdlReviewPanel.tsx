import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  Flag,
  Languages,
  Play,
  Redo2,
  RotateCcw,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import { EditDecisionListSnapshot, EditProposal } from '../ai-engine/edit-decision';
import { SpeechEventAnalysisResult } from '../ai-engine/speech-events';
import { PersianWordToken } from '../contracts/v1_2';
import { flicksToSamples, flicksToSeconds } from '../engine/timebase';
import {
  analyzePersianOrthography,
  analyzePersianPunctuationProposals,
  analyzePersianSpokenNumbers,
  assessSemanticChangeRisk,
  createPersianTranscriptDocument,
  PersianAsrCorrectionCandidate,
  PersianTranscriptDocument,
  renderTranscriptLayerText,
  TranscriptLayerKind,
  TranscriptTransformationEngine,
} from '../persian-linguistics';
import { formatNumberForLocale, formatStudioTimecode } from '../utils/formatters';
import { hasRtlCharacters } from '../utils/bidi';
import { getNextRovingTabIndex } from '../studio/layoutUtils';

interface EdlReviewPanelProps {
  locale: 'fa' | 'en';
  persianDigits?: boolean;
  timecodeFormat?: 'mm:ss.ms' | 'hh:mm:ss';
  sampleRate: number;
  tokens: readonly PersianWordToken[];
  speechEventResult: SpeechEventAnalysisResult | null;
  edlSnapshot: EditDecisionListSnapshot | null;
  isAnalyzing: boolean;
  canUndoEdl: boolean;
  canRedoEdl: boolean;
  forceExpanded?: boolean;
  onRunAnalysis: () => void;
  onApproveProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
  onRequestReviewProposal: (proposalId: string) => void;
  onReviseBoundaryMs: (proposalId: string, deltaStartMs: number, deltaEndMs: number) => void;
  onPreviewProposal: (proposal: EditProposal, mode: 'before' | 'after') => void;
  onSeekSec: (sec: number) => void;
  onUndoEdl: () => void;
  onRedoEdl: () => void;
  onApplyLinguisticReadableText?: (tokenId: string, nextDisplayText: string) => void;
  onApplyLinguisticBatchUpdates?: (
    updates: ReadonlyArray<{ tokenId: string; displayText: string }>,
    descriptionFa?: string,
  ) => void;
}

type PanelTab = 'edl' | 'events' | 'linguistics';

function riskIcon(risk: EditProposal['risk']['overallLevel']) {
  switch (risk) {
    case 'LOW':
      return <ShieldCheck className="w-3.5 h-3.5 text-[var(--avp-success-text)]" aria-hidden="true" />;
    case 'MEDIUM':
      return <AlertCircle className="w-3.5 h-3.5 text-[var(--avp-warning-text)]" aria-hidden="true" />;
    case 'HIGH':
      return <AlertTriangle className="w-3.5 h-3.5 text-[var(--avp-warning)]" aria-hidden="true" />;
    case 'CRITICAL':
    case 'UNKNOWN':
      return <ShieldAlert className="w-3.5 h-3.5 text-[var(--avp-danger)]" aria-hidden="true" />;
  }
}

function statusLabel(status: EditProposal['status'], isFa: boolean): string {
  switch (status) {
    case 'PROPOSED':
      return isFa ? 'پیشنهادی' : 'Proposed';
    case 'APPROVED':
      return isFa ? 'تأییدشده' : 'Approved';
    case 'REJECTED':
      return isFa ? 'ردشده' : 'Rejected';
    case 'NEEDS_REVIEW':
      return isFa ? 'نیازمند بازبینی' : 'Needs Review';
    case 'SUPERSEDED':
      return isFa ? 'جایگزین‌شده' : 'Superseded';
    case 'STALE':
      return isFa ? 'منقضی (Stale)' : 'Stale';
    case 'INVALID':
      return isFa ? 'نامعتبر' : 'Invalid';
    case 'APPLIED':
      return isFa ? 'اعمال‌شده' : 'Applied';
  }
}

function formatEdlOperationLabel(operation: string, isFa: boolean): string {
  const map: Record<string, { fa: string; en: string }> = {
    SHORTEN_SILENCE: { fa: 'کوتاه‌سازی مکث', en: 'Shorten Silence' },
    REMOVE_SILENCE: { fa: 'حذف سکوت اضافی', en: 'Remove Silence' },
    REMOVE_FILLER: { fa: 'حذف تپق و پرکننده', en: 'Remove Filler' },
    REMOVE_STUTTER: { fa: 'حذف تکرار کلام', en: 'Remove Repetition' },
    REMOVE_REPETITION: { fa: 'حذف تکرار کلام', en: 'Remove Repetition' },
    SUPPRESS_CROSSTALK: { fa: 'کاهش تداخل صدا', en: 'Suppress Crosstalk' },
    SOFTEN_BREATH: { fa: 'نرم‌سازی صدای نفس', en: 'Soften Breath' },
    ATTENUATE_BREATH: { fa: 'نرم‌سازی صدای نفس', en: 'Attenuate Breath' },
    ATTENUATE_COUGH: { fa: 'تضعیف سرفه و نویز', en: 'Attenuate Cough' },
    TRIM_BOUNDARY: { fa: 'اصلاح مرز برش', en: 'Trim Boundary' },
    CUT_SEGMENT: { fa: 'برش بخش انتخابی', en: 'Cut Segment' },
  };
  const entry = map[operation];
  if (entry) return isFa ? entry.fa : entry.en;
  return operation
    .toLowerCase()
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

export const EdlReviewPanel: React.FC<EdlReviewPanelProps> = ({
  locale,
  persianDigits = false,
  timecodeFormat = 'mm:ss.ms',
  sampleRate,
  tokens,
  speechEventResult,
  edlSnapshot,
  isAnalyzing,
  canUndoEdl,
  canRedoEdl,
  forceExpanded = false,
  onRunAnalysis,
  onApproveProposal,
  onRejectProposal,
  onRequestReviewProposal,
  onReviseBoundaryMs,
  onPreviewProposal,
  onSeekSec,
  onUndoEdl,
  onRedoEdl,
  onApplyLinguisticReadableText,
  onApplyLinguisticBatchUpdates,
}) => {
  const isFa = locale === 'fa';
  const [activeTab, setActiveTab] = useState<PanelTab>('edl');
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(forceExpanded);
  const [expandedProposalId, setExpandedProposalId] = useState<string | null>(null);

  useEffect(() => {
    if (forceExpanded) {
      setIsDrawerOpen(true);
    }
  }, [forceExpanded]);

  // P13 Persian Linguistic Refinement interactive state (non-destructive, versioned)
  const [lingLayer, setLingLayer] = useState<TranscriptLayerKind>('READABLE');
  const [lingDoc, setLingDoc] = useState<PersianTranscriptDocument | null>(null);
  const [lingTokenIdMap, setLingTokenIdMap] = useState<Record<string, string>>({});
  const [lingCandidates, setLingCandidates] = useState<PersianAsrCorrectionCandidate[]>([]);
  const [lingStatusMsg, setLingStatusMsg] = useState<string | null>(null);
  const transformEngine = useMemo(() => new TranscriptTransformationEngine(), []);

  // Reset stale linguistic analysis whenever underlying source tokens change (project switch / import / cut),
  // without resetting when only displayText changes from accepting a linguistic candidate.
  const rawTokenSignature = useMemo(
    () =>
      tokens
        .map((t) => `${t.id}:${t.originalText}:${t.isCrosstalkSuppressed ? 1 : 0}`)
        .join('|'),
    [tokens],
  );

  useEffect(() => {
    transformEngine.clearHistory();
    setLingDoc(null);
    setLingTokenIdMap({});
    setLingCandidates([]);
    setLingStatusMsg(null);
  }, [rawTokenSignature, transformEngine]);

  const handleRunPersianLinguistics = () => {
    setIsDrawerOpen(true);
    transformEngine.clearHistory();
    const activeTokens = tokens.filter((t) => !t.isCrosstalkSuppressed);
    const studioSpans: Array<{ tokenId: string; startChar: number; endChar: number }> = [];
    let cursor = 0;
    const rawParts: string[] = [];
    for (const tok of activeTokens) {
      const word = tok.originalText;
      if (rawParts.length > 0) cursor += 1;
      const startChar = cursor;
      const endChar = startChar + word.length;
      studioSpans.push({ tokenId: tok.id, startChar, endChar });
      rawParts.push(word);
      cursor = endChar;
    }
    const rawAsrText = rawParts.join(' ');
    const doc = createPersianTranscriptDocument({
      documentId: `ling_${Date.now()}`,
      rawAsrText,
      sampleRate,
      tokenSampleSpans: activeTokens.map((t) => ({
        sourceStartSample: flicksToSamples(t.range.startFlicks, sampleRate),
        sourceEndSample: flicksToSamples(t.range.endFlicks, sampleRate),
      })),
    });

    // Map each linguistic document tokenId back to its originating studio PersianWordToken.id
    const nextTokenIdMap: Record<string, string> = {};
    for (const lingTok of doc.tokens) {
      const matchedSpan = studioSpans.find(
        (s) => lingTok.startCharOffset < s.endChar && lingTok.endCharOffset > s.startChar,
      );
      if (matchedSpan) {
        nextTokenIdMap[lingTok.tokenId] = matchedSpan.tokenId;
      }
    }
    setLingTokenIdMap(nextTokenIdMap);

    const candidates: PersianAsrCorrectionCandidate[] = [];
    const orthoProposals = analyzePersianOrthography(doc);
    for (const op of orthoProposals) {
      candidates.push({
        candidateId: op.proposalId,
        sourceTranscriptVersion: doc.version,
        tokenIds: op.tokenIds,
        originalText: op.originalText,
        proposedText: op.proposedText,
        category: 'ORTHOGRAPHY_READABLE',
        evidenceStrength: op.confidenceStatus === 'STRONG_EVIDENCE' ? 'STRONG_EVIDENCE' : 'MODERATE_EVIDENCE',
        acousticEvidenceAvailable: false,
        acousticConfidence: null,
        linguisticEvidence: op.linguisticRationale,
        semanticRisk: assessSemanticChangeRisk({
          originalText: op.originalText,
          proposedText: op.proposedText,
          category: 'ORTHOGRAPHY_READABLE',
        }),
        alignmentImpact: op.alignmentRecalculationNeeded ? 'RECALCULATE_REQUIRED' : 'NONE',
        epistemicSource: 'DETERMINISTIC_NORMALIZATION',
        provenanceModule: 'PersianOrthographyAndCodeSwitching',
        sourceStartSample: null,
        sourceEndSample: null,
        status: 'PROPOSED',
      });
    }

    const numProposals = analyzePersianSpokenNumbers(doc);
    for (const np of numProposals) {
      if (np.status !== 'PARSEABLE_DISPLAY_PROPOSAL' || !np.formattedDisplayValue) continue;
      candidates.push({
        candidateId: np.proposalId,
        sourceTranscriptVersion: doc.version,
        tokenIds: np.tokenIds,
        originalText: np.originalSpokenText,
        proposedText: np.formattedDisplayValue,
        category: 'NUMBER_FORMAT',
        evidenceStrength: 'MODERATE_EVIDENCE',
        acousticEvidenceAvailable: false,
        acousticConfidence: null,
        linguisticEvidence: np.rationale,
        semanticRisk: assessSemanticChangeRisk({
          originalText: np.originalSpokenText,
          proposedText: np.formattedDisplayValue,
          category: 'NUMBER_FORMAT',
        }),
        alignmentImpact: 'NONE',
        epistemicSource: 'DETERMINISTIC_NORMALIZATION',
        provenanceModule: 'PersianPunctuationAndNumbers',
        sourceStartSample: null,
        sourceEndSample: null,
        status: 'PROPOSED',
      });
    }

    const puncts = analyzePersianPunctuationProposals(doc);
    for (const p of puncts.slice(0, 6)) {
      const tok = doc.tokens.find((t) => t.tokenId === p.afterTokenId);
      if (!tok || tok.readableText.endsWith(p.proposedMark)) continue;
      candidates.push({
        candidateId: p.proposalId,
        sourceTranscriptVersion: doc.version,
        tokenIds: [tok.tokenId],
        originalText: tok.readableText,
        proposedText: p.proposedMark,
        category: 'PUNCTUATION_ONLY',
        evidenceStrength: p.confidenceStatus === 'MODERATE_EVIDENCE' ? 'MODERATE_EVIDENCE' : 'WEAK_EVIDENCE',
        acousticEvidenceAvailable: p.pauseDurationMs !== null,
        acousticConfidence: null,
        linguisticEvidence: p.rationale,
        semanticRisk: assessSemanticChangeRisk({
          originalText: tok.readableText,
          proposedText: `${tok.readableText}${p.proposedMark}`,
          category: 'PUNCTUATION_ONLY',
        }),
        alignmentImpact: 'NONE',
        epistemicSource: 'RULE_BASED_LINGUISTIC_INFERENCE',
        provenanceModule: 'PersianPunctuationAndNumbers',
        sourceStartSample: tok.sourceStartSample,
        sourceEndSample: tok.sourceEndSample,
        status: 'PROPOSED',
      });
    }

    setLingDoc(doc);
    setLingCandidates(candidates);
    setLingStatusMsg(
      isFa
        ? `تحلیل زبان‌شناختی فارسی انجام شد: ${candidates.length} پیشنهاد غیرمخرب (نسخه خام ASR دست‌نخورده است).`
        : `Persian linguistic analysis finished: ${candidates.length} non-destructive proposals (raw ASR untouched).`,
    );
  };

  const handleAcceptLingCandidate = (candidate: PersianAsrCorrectionCandidate) => {
    if (!lingDoc) return;
    const syncedCandidate = { ...candidate, sourceTranscriptVersion: lingDoc.version };
    const res = transformEngine.applyAcceptedCandidate({
      document: lingDoc,
      candidate: syncedCandidate,
      allowWeakOrUnknownRiskExplicitly: true,
    });
    if (!res.applied) {
      setLingStatusMsg(res.rejectionReason ?? 'Candidate could not be applied.');
      return;
    }
    setLingDoc(res.document);
    setLingCandidates((prev) =>
      prev.map((c) => (c.candidateId === candidate.candidateId ? res.updatedCandidate : c)),
    );
    const tokenUpdates: Array<{ tokenId: string; displayText: string }> = [];
    const seenStudioIds = new Set<string>();
    for (const lingTokenId of candidate.tokenIds) {
      const updatedTok = res.document.tokens.find((t) => t.tokenId === lingTokenId);
      const studioTokenId = updatedTok ? lingTokenIdMap[updatedTok.tokenId] : undefined;
      if (updatedTok && studioTokenId && !seenStudioIds.has(studioTokenId)) {
        seenStudioIds.add(studioTokenId);
        tokenUpdates.push({ tokenId: studioTokenId, displayText: updatedTok.readableText });
      }
    }
    if (tokenUpdates.length > 0) {
      if (onApplyLinguisticBatchUpdates) {
        onApplyLinguisticBatchUpdates(
          tokenUpdates,
          `اعمال پالایش زبان‌شناختی «${candidate.originalText}» ← «${candidate.proposedText}»`,
        );
      } else if (onApplyLinguisticReadableText) {
        onApplyLinguisticReadableText(tokenUpdates[0].tokenId, tokenUpdates[0].displayText);
      }
    }
  };

  const handleRejectLingCandidate = (candidateId: string) => {
    setLingCandidates((prev) =>
      prev.map((c) => (c.candidateId === candidateId ? { ...c, status: 'REJECTED' } : c)),
    );
  };

  const handleRevertLingCandidate = (candidateId: string) => {
    if (!lingDoc) return;
    const res = transformEngine.revertCandidateById(lingDoc, candidateId);
    if (!res.reverted) return;
    setLingDoc(res.document);
    setLingCandidates((prev) =>
      prev.map((c) => (c.candidateId === candidateId ? { ...c, status: 'REVERTED' } : c)),
    );
    const revertUpdates: Array<{ tokenId: string; displayText: string }> = [];
    const seenStudioIds = new Set<string>();
    for (const restored of res.restoredTokens) {
      const studioTokenId = lingTokenIdMap[restored.tokenId];
      if (studioTokenId && !seenStudioIds.has(studioTokenId)) {
        seenStudioIds.add(studioTokenId);
        revertUpdates.push({ tokenId: studioTokenId, displayText: restored.readableText });
      }
    }
    if (revertUpdates.length > 0) {
      if (onApplyLinguisticBatchUpdates) {
        onApplyLinguisticBatchUpdates(revertUpdates, 'بازگردانی پالایش زبان‌شناختی فارسی');
      } else if (onApplyLinguisticReadableText) {
        onApplyLinguisticReadableText(revertUpdates[0].tokenId, revertUpdates[0].displayText);
      }
    }
  };

  const proposals = edlSnapshot?.proposals ?? [];
  const approvedCount = proposals.filter((p) => p.status === 'APPROVED').length;
  const events = speechEventResult?.events ?? [];

  const drawerVisible = forceExpanded || isDrawerOpen;

  return (
    <section
      data-testid="edl-review-inspector-dock"
      aria-label={isFa ? 'پنل بازبینی EDL، رویدادهای گفتاری و پالایش فارسی' : 'EDL Review, Speech Events & Persian Linguistics'}
      className={`border-t border-[var(--avp-border)] bg-[var(--avp-surface)] shrink-0 overflow-hidden ${
        forceExpanded ? 'flex flex-col h-full min-h-0' : ''
      }`}
    >
      {/* Unified Inspector Sub-Header (Wraps cleanly on narrow 272px tablet columns) */}
      <div className="min-h-[44px] sm:min-h-[38px] px-2.5 py-1 border-b border-[var(--avp-border-subtle)] bg-[var(--avp-surface-shell)] flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={() => setIsDrawerOpen((v) => !v)}
            aria-expanded={isDrawerOpen}
            aria-label={isFa ? 'باز یا بستن بخش تحلیل تدوین و فارسی' : 'Toggle EDL & Linguistics inspector'}
            title={isFa ? 'باز یا بستن بخش تحلیل EDL و پالایش فارسی' : 'Toggle EDL & Linguistics inspector'}
            className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-[26px] sm:min-h-[26px] sm:w-[26px] sm:h-[26px] rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface-hover)] shrink-0 cursor-pointer transition-colors"
          >
            {isDrawerOpen ? (
              <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" strokeWidth={1.75} />
            )}
          </button>

          <div
            role="tablist"
            aria-label={isFa ? 'بخش‌های بازبینی و زبان‌شناسی' : 'EDL and linguistics tabs'}
            onKeyDown={(e) => {
              const tabs: PanelTab[] = ['edl', 'events', 'linguistics'];
              const idx = tabs.indexOf(activeTab);
              const nextIdx = getNextRovingTabIndex(idx, tabs.length, e.key, isFa, 'horizontal');
              if (nextIdx !== null) {
                e.preventDefault();
                setActiveTab(tabs[nextIdx]);
                setIsDrawerOpen(true);
              }
            }}
            className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/80"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'edl'}
              tabIndex={activeTab === 'edl' ? 0 : -1}
              data-testid="tab-edl-review"
              onClick={() => {
                if (activeTab === 'edl') {
                  setIsDrawerOpen((v) => !v);
                } else {
                  setActiveTab('edl');
                  setIsDrawerOpen(true);
                }
              }}
              className={`inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2 sm:px-1.5 rounded-[5px] text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeTab === 'edl'
                  ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
              }`}
            >
              <span>{isFa ? 'تصمیمات' : 'EDL'}</span>
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--avp-surface-secondary)] font-mono text-[11px] font-bold">
                {formatNumberForLocale(proposals.length, { persianDigits })}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'events'}
              tabIndex={activeTab === 'events' ? 0 : -1}
              data-testid="tab-speech-events"
              onClick={() => {
                if (activeTab === 'events') {
                  setIsDrawerOpen((v) => !v);
                } else {
                  setActiveTab('events');
                  setIsDrawerOpen(true);
                }
              }}
              className={`inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2 sm:px-1.5 rounded-[5px] text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeTab === 'events'
                  ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
              }`}
            >
              <span>{isFa ? 'رویدادها' : 'Events'}</span>
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--avp-surface-secondary)] font-mono text-[11px] font-bold">
                {formatNumberForLocale(events.length, { persianDigits })}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'linguistics'}
              tabIndex={activeTab === 'linguistics' ? 0 : -1}
              data-testid="tab-persian-linguistics"
              onClick={() => {
                setActiveTab('linguistics');
                setIsDrawerOpen(true);
              }}
              className={`inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2 sm:px-1.5 rounded-[5px] text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeTab === 'linguistics'
                  ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
              }`}
            >
              <span>{isFa ? 'فارسی' : 'Persian'}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0 ms-auto">
          {activeTab !== 'linguistics' && (
            <>
              {drawerVisible && (
                <>
                  <button
                    type="button"
                    onClick={onUndoEdl}
                    disabled={!canUndoEdl}
                    aria-label={isFa ? 'بازگشت تصمیم EDL' : 'Undo EDL Decision'}
                    className="avp-btn-icon avp-btn-icon-sm avp-touch-icon"
                  >
                    <Undo2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onRedoEdl}
                    disabled={!canRedoEdl}
                    aria-label={isFa ? 'تکرار تصمیم EDL' : 'Redo EDL Decision'}
                    className="avp-btn-icon avp-btn-icon-sm avp-touch-icon"
                  >
                    <Redo2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </>
              )}
              <button
                type="button"
                data-testid="btn-run-edl-analysis"
                onClick={() => {
                  setIsDrawerOpen(true);
                  onRunAnalysis();
                }}
                disabled={isAnalyzing}
                title={isFa ? 'تحلیل رویدادهای گفتاری و ساخت لیست تصمیمات تدوین (EDL)' : 'Analyze speech events & build EDL'}
                className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2.5 sm:px-2 rounded-md border border-[var(--avp-accent)]/35 bg-[var(--avp-accent-soft)] hover:opacity-90 text-[var(--avp-accent-text)] font-semibold text-[11px] whitespace-nowrap cursor-pointer transition-opacity"
              >
                <Sparkles className="w-3 h-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span>
                  {isAnalyzing
                    ? isFa
                      ? 'تحلیل...'
                      : 'Running...'
                    : isFa
                      ? 'ساخت EDL'
                      : 'Build EDL'}
                </span>
              </button>
            </>
          )}
          {activeTab === 'linguistics' && (
            <button
              type="button"
              data-testid="btn-run-persian-linguistics"
              onClick={handleRunPersianLinguistics}
              className="avp-btn avp-btn-sm avp-btn-tonal min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2.5 sm:px-2 text-[11px]"
            >
              <Languages className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
              <span>{isFa ? 'تحلیل متن' : 'Analyze'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Tab 1: Mission 05 EDL Review (Rendered inside Unified Right Editorial Inspector) */}
      {drawerVisible && activeTab === 'edl' && (
        <div
          className={`p-2.5 space-y-2.5 overflow-y-auto bg-[var(--avp-surface)] ${
            forceExpanded ? 'flex-1 min-h-0' : 'max-h-[260px]'
          }`}
        >
          {!edlSnapshot ? (
            <div className="text-[11.5px] text-[var(--avp-text-muted)] py-3 text-center space-y-1">
              <p>
                {isFa
                  ? 'هنوز لیست تصمیمات تدوین (EDL) برای این پروژه ساخته نشده است. هیچ برشی بدون تأیید صریح شما اعمال نمی‌شود.'
                  : 'No Edit Decision List (EDL) has been generated yet. No cut is ever applied without your explicit approval.'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border-subtle)] pb-1.5">
                <span className="tabular-nums font-medium">
                  {isFa
                    ? `نسخه لیست تدوین ${formatNumberForLocale(edlSnapshot.edlVersion, { persianDigits })} · تأییدشده: ${formatNumberForLocale(approvedCount, { persianDigits })}/${formatNumberForLocale(proposals.length, { persianDigits })}`
                    : `EDL v${edlSnapshot.edlVersion} · Approved: ${approvedCount}/${proposals.length}`}
                </span>
                <details className="text-[11px] text-[var(--avp-text-muted)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--avp-text)]">
                    {isFa ? 'جزئیات فنی' : 'Technical details'}
                  </summary>
                  <div className="mt-1 font-mono text-[11px] text-[var(--avp-text-muted)]" dir="ltr">
                    Source Hash: {edlSnapshot.sourceAudioHash.slice(0, 16)}
                  </div>
                </details>
              </div>

              {proposals.length === 0 ? (
                <p className="text-[11.5px] text-[var(--avp-text-muted)] py-3 text-center">
                  {isFa
                    ? 'هیچ پیشنهاد تدوین پرخطر یا مکث اضافه‌ای در این قطعه شناسایی نشد.'
                    : 'No edit proposals were detected in this recording.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {proposals.map((prop) => {
                    const activeRange = prop.proposedRange ?? prop.originalRange;
                    const startSample = activeRange?.startSample ?? 0;
                    const endSample = activeRange?.endSample ?? 0;
                    const safeSampleRate = sampleRate > 0 ? sampleRate : 48_000;
                    const startSec = startSample / safeSampleRate;
                    const endSec = endSample / safeSampleRate;
                    const durationMs = Math.round((endSec - startSec) * 1000);
                    const isExpanded = expandedProposalId === prop.proposalId;
                    const operationLabel = formatEdlOperationLabel(prop.operation, isFa);

                    return (
                      <div
                        key={prop.proposalId}
                        data-testid={`edl-proposal-${prop.proposalId}`}
                        className="rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/55 p-2.5 space-y-1.5 text-[11.5px]"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5">
                            {riskIcon(prop.risk.overallLevel)}
                            <span className="font-semibold text-[var(--avp-text)]">
                              {operationLabel}
                            </span>
                            <span className="text-[var(--avp-text-muted)]">·</span>
                            <span className="text-[var(--avp-text-secondary)]">
                              {statusLabel(prop.status, isFa)}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => onSeekSec(startSec)}
                            dir="ltr"
                            className="font-mono tabular-nums text-[11px] min-h-[24px] px-1 rounded text-[var(--avp-warning-text)] hover:underline cursor-pointer"
                          >
                            {formatStudioTimecode(startSec, timecodeFormat, persianDigits)}–
                            {formatStudioTimecode(endSec, timecodeFormat, persianDigits)} (
                            {formatNumberForLocale(durationMs, { persianDigits })}ms)
                          </button>
                        </div>

                        <p className="text-[var(--avp-text-secondary)] leading-relaxed">
                          {isFa || !hasRtlCharacters(prop.explanationFa)
                            ? prop.explanationFa
                            : `${operationLabel} (${prop.risk.overallLevel} risk · ${durationMs}ms)`}
                        </p>

                        <div className="flex flex-wrap items-center gap-1 pt-0.5">
                          <button
                            type="button"
                            data-testid={`btn-approve-${prop.proposalId}`}
                            onClick={() => onApproveProposal(prop.proposalId)}
                            disabled={prop.status === 'APPROVED' || prop.status === 'INVALID' || prop.status === 'STALE'}
                            className="avp-btn avp-btn-sm avp-btn-secondary min-h-[44px] sm:min-h-[26px] px-2.5 sm:px-2 text-[11px]"
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'تأیید' : 'Approve'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRejectProposal(prop.proposalId)}
                            disabled={prop.status === 'REJECTED'}
                            className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2.5 sm:px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] disabled:opacity-40 cursor-pointer text-[11px]"
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'رد' : 'Reject'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRequestReviewProposal(prop.proposalId)}
                            className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] cursor-pointer text-[11px]"
                          >
                            <Flag className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'بازبینی' : 'Flag'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onPreviewProposal(prop, 'before')}
                            className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] cursor-pointer text-[11px]"
                          >
                            <Play className="w-2.5 h-2.5" aria-hidden="true" />
                            <span>{isFa ? 'قبل' : 'Before'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onPreviewProposal(prop, 'after')}
                            className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] cursor-pointer text-[11px]"
                          >
                            <Scissors className="w-2.5 h-2.5" aria-hidden="true" />
                            <span>{isFa ? 'بعد' : 'After'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onReviseBoundaryMs(prop.proposalId, -15, 15)}
                            className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[26px] px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-muted)] hover:bg-[var(--avp-surface-hover)] font-mono cursor-pointer text-[11px]"
                            title={isFa ? 'اصلاح مرز ±15ms' : 'Widen boundaries ±15ms'}
                          >
                            ±15ms
                          </button>
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-label={isFa ? 'جزئیات پیشنهاد' : 'Proposal details'}
                            onClick={() =>
                              setExpandedProposalId(isExpanded ? null : prop.proposalId)
                            }
                            className="ms-auto inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-[26px] sm:min-h-[26px] gap-0.5 text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] cursor-pointer text-[11px]"
                          >
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                            {isExpanded ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="mt-1.5 pt-1.5 border-t border-[var(--avp-border-subtle)] space-y-1 text-[11px] text-[var(--avp-text-muted)]">
                            <div>
                              <strong>{isFa ? 'کد عملیات:' : 'Operation Code:'}</strong>{' '}
                              <bdi dir="ltr" className="font-mono">{prop.operation}</bdi>
                            </div>
                            <div>
                              <strong>{isFa ? 'سطح ریسک:' : 'Risk Level:'}</strong> {prop.risk.overallLevel} (
                              {prop.risk.blockingReasons.join(' · ') || '—'})
                            </div>
                            <div className="font-mono" dir="ltr">
                              Samples: [{startSample} .. {endSample}] · {prop.boundary.measurementBasis}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Tab 2: Mission 04 Speech Events */}
      {drawerVisible && activeTab === 'events' && (
        <div
          className={`p-2.5 space-y-2 overflow-y-auto text-[11.5px] bg-[var(--avp-surface)] ${
            forceExpanded ? 'flex-1 min-h-0' : 'max-h-[260px]'
          }`}
        >
          {events.length === 0 ? (
            <p className="text-[var(--avp-text-muted)] py-5 text-center">
              {isFa
                ? 'برای مشاهده مکث‌ها، تپق‌ها و رویدادهای آوایی، دکمه «ساخت EDL» را بزنید.'
                : 'Click "Build EDL" to detect pauses, fillers, repetitions, and vocal events locally.'}
            </p>
          ) : (
            events.map((ev) => (
              <div
                key={ev.eventId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/55 px-2.5 py-2"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-[var(--avp-text)]">
                    {ev.category}{' '}
                    <span className="font-normal text-[var(--avp-text-muted)]">
                      ({ev.subtype})
                    </span>
                  </div>
                  <div className="text-[var(--avp-text-secondary)]">
                    {isFa || !hasRtlCharacters(ev.explanationFa)
                      ? ev.explanationFa
                      : `${ev.category} · ${ev.subtype} (${Math.round(ev.confidence * 100)}%)`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onSeekSec(ev.startSec)}
                  dir="ltr"
                  className="min-h-[44px] sm:min-h-[26px] px-1.5 font-mono tabular-nums text-[11px] text-[var(--avp-warning-text)] hover:underline cursor-pointer"
                >
                  {formatStudioTimecode(ev.startSec, timecodeFormat, persianDigits)}–
                  {formatStudioTimecode(ev.endSec, timecodeFormat, persianDigits)} ·{' '}
                  {formatNumberForLocale(Math.round(ev.confidence * 100), { persianDigits })}%
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 3: Persian Linguistic Intelligence */}
      {drawerVisible && activeTab === 'linguistics' && (
        <div
          className={`p-2.5 space-y-2.5 overflow-y-auto text-[11.5px] bg-[var(--avp-surface)] ${
            forceExpanded ? 'flex-1 min-h-0' : 'max-h-[260px]'
          }`}
        >
          {lingStatusMsg && (
            <div className="rounded-lg border border-[var(--avp-accent)]/30 bg-[var(--avp-accent-soft)] px-2.5 py-2 text-[var(--avp-text)]">
              {lingStatusMsg}
            </div>
          )}

          {!lingDoc ? (
            <p className="text-[var(--avp-text-muted)] py-4 text-center">
              {isFa
                ? 'پالایش زبان‌شناختی فارسی، لایه خام ASR و لایه دقیق گفتاری (Verbatim) را دست‌نخورده نگه می‌دارد و فقط پیشنهادهای مستند و قابل بازگشت تولید می‌کند.'
                : 'Persian linguistic refinement keeps Raw ASR and Verbatim layers immutable and only generates reversible evidence-based proposals.'}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    { id: 'RAW_ASR', fa: 'خام ASR', en: 'Raw ASR' },
                    { id: 'VERBATIM', fa: 'دقیق', en: 'Verbatim' },
                    { id: 'NORMALIZED', fa: 'معیار', en: 'Normalized' },
                    { id: 'READABLE', fa: 'خوانا', en: 'Readable' },
                  ] as const
                ).map((layerOpt) => (
                  <button
                    key={layerOpt.id}
                    type="button"
                    onClick={() => setLingLayer(layerOpt.id)}
                    className={`min-h-[44px] sm:min-h-[26px] px-2.5 py-0.5 rounded border text-[11px] font-medium cursor-pointer ${
                      lingLayer === layerOpt.id
                        ? 'border-[var(--avp-accent)] bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                        : 'border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
                    }`}
                  >
                    {isFa ? layerOpt.fa : layerOpt.en}
                  </button>
                ))}
                <span className="ms-auto font-mono text-[11px] text-[var(--avp-text-muted)]">
                  v{lingDoc.version}
                </span>
              </div>

              <div
                dir="auto"
                className="rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/55 p-2.5 leading-6 text-[var(--avp-text)]"
              >
                {renderTranscriptLayerText(lingDoc, lingLayer) || (isFa ? 'متنی موجود نیست' : 'No text')}
              </div>

              {lingCandidates.length === 0 ? (
                <p className="text-[var(--avp-text-muted)] text-center py-2">
                  {isFa
                    ? 'متن فعلی از نظر نیم‌فاصله، اعداد و علائم نگارشی نیاز به تغییر پیشنهادی ندارد.'
                    : 'No linguistic refinement proposals were needed for this transcript.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {lingCandidates.map((cand) => (
                    <div
                      key={cand.candidateId}
                      className="rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/55 p-2 space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span dir="rtl" className="font-semibold text-[var(--avp-text)]">
                          «{cand.originalText}» ← «{cand.proposedText}»
                        </span>
                        <span className="text-[11px] text-[var(--avp-text-muted)] font-mono">
                          {cand.category} · {cand.status}
                        </span>
                      </div>
                      <p className="text-[var(--avp-text-secondary)]">
                        {isFa || !hasRtlCharacters(cand.linguisticEvidence)
                          ? cand.linguisticEvidence
                          : `${cand.category} (${cand.evidenceStrength})`}
                      </p>
                      <div className="flex items-center gap-1.5 pt-0.5">
                        {cand.status === 'PROPOSED' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAcceptLingCandidate(cand)}
                              className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2.5 rounded bg-[var(--avp-accent)] text-white hover:bg-[var(--avp-accent-hover)] cursor-pointer text-[11px] font-semibold"
                            >
                              <Check className="w-3 h-3" />
                              <span>{isFa ? 'اعمال روی لایه خوانا' : 'Accept'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRejectLingCandidate(cand.candidateId)}
                              className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] cursor-pointer text-[11px]"
                            >
                              <X className="w-3 h-3" />
                              <span>{isFa ? 'رد' : 'Reject'}</span>
                            </button>
                          </>
                        )}
                        {cand.status === 'ACCEPTED' && (
                          <button
                            type="button"
                            onClick={() => handleRevertLingCandidate(cand.candidateId)}
                            className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] px-2.5 rounded border border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)] cursor-pointer text-[11px]"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>{isFa ? 'بازگردانی' : 'Revert'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
};
