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

interface EdlReviewPanelProps {
  locale: 'fa' | 'en';
  sampleRate: number;
  tokens: readonly PersianWordToken[];
  speechEventResult: SpeechEventAnalysisResult | null;
  edlSnapshot: EditDecisionListSnapshot | null;
  isAnalyzing: boolean;
  canUndoEdl: boolean;
  canRedoEdl: boolean;
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
      return <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />;
    case 'MEDIUM':
      return <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
    case 'HIGH':
      return <AlertTriangle className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" aria-hidden="true" />;
    case 'CRITICAL':
    case 'UNKNOWN':
      return <ShieldAlert className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" aria-hidden="true" />;
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

export const EdlReviewPanel: React.FC<EdlReviewPanelProps> = ({
  locale,
  sampleRate,
  tokens,
  speechEventResult,
  edlSnapshot,
  isAnalyzing,
  canUndoEdl,
  canRedoEdl,
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
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [expandedProposalId, setExpandedProposalId] = useState<string | null>(null);

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

  return (
    <section
      data-testid="edl-review-inspector-dock"
      aria-label={isFa ? 'پنل بازبینی EDL، رویدادهای گفتاری و پالایش فارسی' : 'EDL Review, Speech Events & Persian Linguistics'}
      className="border-t border-[var(--avp-border)] bg-[var(--avp-surface)] shrink-0 overflow-hidden"
    >
      {/* Unified Inspector Sub-Header (36px — Docked inside Right Editorial Inspector) */}
      <div className="h-[36px] px-2.5 border-b border-[var(--avp-border-subtle)] bg-[var(--avp-surface-shell)] flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto" role="tablist">
          <button
            type="button"
            onClick={() => setIsDrawerOpen((v) => !v)}
            aria-expanded={isDrawerOpen}
            title={isFa ? 'باز یا بستن بخش تحلیل EDL و پالایش فارسی' : 'Toggle EDL & Linguistics inspector'}
            className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface-hover)] shrink-0 cursor-pointer transition-colors"
          >
            {isDrawerOpen ? (
              <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" strokeWidth={1.75} />
            )}
          </button>

          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/80">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'edl'}
              data-testid="tab-edl-review"
              onClick={() => {
                if (activeTab === 'edl') {
                  setIsDrawerOpen((v) => !v);
                } else {
                  setActiveTab('edl');
                  setIsDrawerOpen(true);
                }
              }}
              className={`inline-flex items-center gap-1 h-[22px] px-1.5 rounded-[5px] text-[10.5px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeTab === 'edl'
                  ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
              }`}
            >
              <span>{isFa ? 'EDL' : 'EDL'}</span>
              <span className="inline-flex items-center justify-center min-w-[15px] h-[14px] px-1 rounded-full bg-[var(--avp-surface-secondary)] font-mono text-[9px] font-bold">
                {proposals.length}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'events'}
              data-testid="tab-speech-events"
              onClick={() => {
                if (activeTab === 'events') {
                  setIsDrawerOpen((v) => !v);
                } else {
                  setActiveTab('events');
                  setIsDrawerOpen(true);
                }
              }}
              className={`inline-flex items-center gap-1 h-[22px] px-1.5 rounded-[5px] text-[10.5px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeTab === 'events'
                  ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
              }`}
            >
              <span>{isFa ? 'رویدادها' : 'Events'}</span>
              <span className="inline-flex items-center justify-center min-w-[15px] h-[14px] px-1 rounded-full bg-[var(--avp-surface-secondary)] font-mono text-[9px] font-bold">
                {events.length}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'linguistics'}
              data-testid="tab-persian-linguistics"
              onClick={() => {
                setActiveTab('linguistics');
                setIsDrawerOpen(true);
              }}
              className={`inline-flex items-center gap-1 h-[22px] px-1.5 rounded-[5px] text-[10.5px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeTab === 'linguistics'
                  ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                  : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
              }`}
            >
              <span>{isFa ? 'پالایش فارسی' : 'Linguistics'}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {activeTab !== 'linguistics' && (
            <>
              {isDrawerOpen && (
                <>
                  <button
                    type="button"
                    onClick={onUndoEdl}
                    disabled={!canUndoEdl}
                    aria-label={isFa ? 'بازگشت تصمیم EDL' : 'Undo EDL Decision'}
                    className="avp-btn-icon-sm w-[22px] h-[22px]"
                  >
                    <Undo2 className="w-3 h-3" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onRedoEdl}
                    disabled={!canRedoEdl}
                    aria-label={isFa ? 'تکرار تصمیم EDL' : 'Redo EDL Decision'}
                    className="avp-btn-icon-sm w-[22px] h-[22px]"
                  >
                    <Redo2 className="w-3 h-3" strokeWidth={1.75} />
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
                className="inline-flex items-center gap-1 h-[24px] px-2 rounded-md border border-[var(--avp-accent)]/35 bg-[var(--avp-accent-soft)] hover:opacity-90 text-[var(--avp-accent-text)] font-semibold text-[10.5px] whitespace-nowrap cursor-pointer transition-opacity"
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
              className="avp-btn avp-btn-sm avp-btn-tonal h-[24px] px-2 text-[10.5px]"
            >
              <Languages className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
              <span>{isFa ? 'تحلیل متن' : 'Analyze'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Tab 1: Mission 05 EDL Review (Rendered inside Unified Right Editorial Inspector) */}
      {isDrawerOpen && activeTab === 'edl' && (
        <div className="p-2.5 space-y-2.5 max-h-[260px] overflow-y-auto bg-[var(--avp-surface)]">
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
                    ? `نسخه EDL ${edlSnapshot.edlVersion} · تأیید: ${approvedCount}/${proposals.length}`
                    : `EDL v${edlSnapshot.edlVersion} · Approved: ${approvedCount}/${proposals.length}`}
                </span>
                <span className="font-mono text-[10px] text-[var(--avp-text-muted)]" dir="ltr">
                  {edlSnapshot.sourceAudioHash.slice(0, 10)}
                </span>
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
                              {prop.operation}
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
                            className="font-mono tabular-nums text-[10.5px] text-[var(--avp-warning-text)] hover:underline cursor-pointer"
                          >
                            {startSec.toFixed(2)}s–{endSec.toFixed(2)}s ({durationMs}ms)
                          </button>
                        </div>

                        <p className="text-[var(--avp-text-secondary)] leading-relaxed">
                          {prop.explanationFa}
                        </p>

                        <div className="flex flex-wrap items-center gap-1 pt-0.5">
                          <button
                            type="button"
                            data-testid={`btn-approve-${prop.proposalId}`}
                            onClick={() => onApproveProposal(prop.proposalId)}
                            disabled={prop.status === 'APPROVED' || prop.status === 'INVALID' || prop.status === 'STALE'}
                            className="inline-flex items-center gap-1 h-[22px] px-2 rounded bg-[var(--avp-accent)] text-white hover:bg-[var(--avp-accent-hover)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed text-[10.5px] font-semibold"
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'تأیید' : 'Approve'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRejectProposal(prop.proposalId)}
                            disabled={prop.status === 'REJECTED'}
                            className="inline-flex items-center gap-1 h-[22px] px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] disabled:opacity-40 cursor-pointer text-[10.5px]"
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'رد' : 'Reject'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRequestReviewProposal(prop.proposalId)}
                            className="inline-flex items-center gap-1 h-[22px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] cursor-pointer text-[10.5px]"
                          >
                            <Flag className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'بازبینی' : 'Flag'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onPreviewProposal(prop, 'before')}
                            className="inline-flex items-center gap-1 h-[22px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] cursor-pointer text-[10.5px]"
                          >
                            <Play className="w-2.5 h-2.5" aria-hidden="true" />
                            <span>{isFa ? 'قبل' : 'Before'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onPreviewProposal(prop, 'after')}
                            className="inline-flex items-center gap-1 h-[22px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface-hover)] cursor-pointer text-[10.5px]"
                          >
                            <Scissors className="w-2.5 h-2.5" aria-hidden="true" />
                            <span>{isFa ? 'بعد' : 'After'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onReviseBoundaryMs(prop.proposalId, -15, 15)}
                            className="h-[22px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-muted)] hover:bg-[var(--avp-surface-hover)] font-mono cursor-pointer text-[10px]"
                            title={isFa ? 'اصلاح مرز ±15ms' : 'Widen boundaries ±15ms'}
                          >
                            ±15ms
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedProposalId(isExpanded ? null : prop.proposalId)
                            }
                            className="ms-auto inline-flex items-center gap-0.5 text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] cursor-pointer text-[10.5px]"
                          >
                            <Eye className="w-3 h-3" aria-hidden="true" />
                            {isExpanded ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="mt-1.5 pt-1.5 border-t border-[var(--avp-border-subtle)] space-y-1 text-[10.5px] text-[var(--avp-text-muted)]">
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
      {isDrawerOpen && activeTab === 'events' && (
        <div className="p-2.5 space-y-2 max-h-[260px] overflow-y-auto text-[11.5px] bg-[var(--avp-surface)]">
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
                  <div className="text-[var(--avp-text-secondary)]">{ev.explanationFa}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onSeekSec(ev.startSec)}
                  dir="ltr"
                  className="font-mono tabular-nums text-[10.5px] text-[var(--avp-warning-text)] hover:underline cursor-pointer"
                >
                  {ev.startSec.toFixed(2)}s–{ev.endSec.toFixed(2)}s ·{' '}
                  {Math.round(ev.confidence * 100)}%
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 3: Mission 13 Persian Linguistic Intelligence */}
      {isDrawerOpen && activeTab === 'linguistics' && (
        <div className="p-2.5 space-y-2.5 max-h-[260px] overflow-y-auto text-[11.5px] bg-[var(--avp-surface)]">
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
                {(['RAW_ASR', 'VERBATIM', 'NORMALIZED', 'READABLE'] as const).map((layer) => (
                  <button
                    key={layer}
                    type="button"
                    onClick={() => setLingLayer(layer)}
                    className={`px-2 py-0.5 rounded border text-[10px] font-mono font-medium cursor-pointer ${
                      lingLayer === layer
                        ? 'border-[var(--avp-accent)] bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                        : 'border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
                    }`}
                  >
                    {layer}
                  </button>
                ))}
                <span className="ms-auto font-mono text-[10.5px] text-[var(--avp-text-muted)]">
                  v{lingDoc.version}
                </span>
              </div>

              <div className="rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/55 p-2.5 leading-6 text-[var(--avp-text)]">
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
                        <span className="font-semibold text-[var(--avp-text)]">
                          «{cand.originalText}» ← «{cand.proposedText}»
                        </span>
                        <span className="text-[10px] text-[var(--avp-text-muted)] font-mono">
                          {cand.category} · {cand.status}
                        </span>
                      </div>
                      <p className="text-[var(--avp-text-secondary)]">{cand.linguisticEvidence}</p>
                      <div className="flex items-center gap-1.5 pt-0.5">
                        {cand.status === 'PROPOSED' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAcceptLingCandidate(cand)}
                              className="inline-flex items-center gap-1 h-[22px] px-2 rounded bg-[var(--avp-accent)] text-white hover:bg-[var(--avp-accent-hover)] cursor-pointer text-[10.5px] font-semibold"
                            >
                              <Check className="w-3 h-3" />
                              <span>{isFa ? 'اعمال روی لایه خوانا' : 'Accept'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRejectLingCandidate(cand.candidateId)}
                              className="inline-flex items-center gap-1 h-[22px] px-2 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] cursor-pointer text-[10.5px]"
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
                            className="inline-flex items-center gap-1 h-[22px] px-2 rounded border border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)] cursor-pointer text-[10.5px]"
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
