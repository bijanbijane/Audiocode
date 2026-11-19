import React, { useMemo, useState } from 'react';
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
}) => {
  const isFa = locale === 'fa';
  const [activeTab, setActiveTab] = useState<PanelTab>('edl');
  const [expandedProposalId, setExpandedProposalId] = useState<string | null>(null);

  // P13 Persian Linguistic Refinement interactive state (non-destructive, versioned)
  const [lingLayer, setLingLayer] = useState<TranscriptLayerKind>('READABLE');
  const [lingDoc, setLingDoc] = useState<PersianTranscriptDocument | null>(null);
  const [lingTokenIdMap, setLingTokenIdMap] = useState<Record<string, string>>({});
  const [lingCandidates, setLingCandidates] = useState<PersianAsrCorrectionCandidate[]>([]);
  const [lingStatusMsg, setLingStatusMsg] = useState<string | null>(null);
  const transformEngine = useMemo(() => new TranscriptTransformationEngine(), []);

  const handleRunPersianLinguistics = () => {
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
    const updatedTok = res.document.tokens.find((t) => t.tokenId === candidate.tokenIds[0]);
    const studioTokenId = updatedTok ? lingTokenIdMap[updatedTok.tokenId] : undefined;
    if (updatedTok && studioTokenId && onApplyLinguisticReadableText) {
      onApplyLinguisticReadableText(studioTokenId, updatedTok.readableText);
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
    const studioTokenId = res.revertedTokenId ? lingTokenIdMap[res.revertedTokenId] : undefined;
    if (studioTokenId && res.restoredReadableText !== null && onApplyLinguisticReadableText) {
      onApplyLinguisticReadableText(studioTokenId, res.restoredReadableText);
    }
  };

  const proposals = edlSnapshot?.proposals ?? [];
  const approvedCount = proposals.filter((p) => p.status === 'APPROVED').length;
  const events = speechEventResult?.events ?? [];

  return (
    <section
      aria-label={isFa ? 'پنل بازبینی EDL، رویدادهای گفتاری و پالایش فارسی' : 'EDL Review, Speech Events & Persian Linguistics'}
      className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg overflow-hidden"
    >
      {/* Header & Tabs */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-[#252F42] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 overflow-x-auto" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'edl'}
            data-testid="tab-edl-review"
            onClick={() => setActiveTab('edl')}
            className={`pb-1 text-xs font-semibold whitespace-nowrap border-b-2 cursor-pointer transition-colors ${
              activeTab === 'edl'
                ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {isFa ? `پیشنهادهای تدوین EDL (${proposals.length})` : `EDL Proposals (${proposals.length})`}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'events'}
            data-testid="tab-speech-events"
            onClick={() => setActiveTab('events')}
            className={`pb-1 text-xs font-semibold whitespace-nowrap border-b-2 cursor-pointer transition-colors ${
              activeTab === 'events'
                ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {isFa ? `رویدادهای گفتاری (${events.length})` : `Speech Events (${events.length})`}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'linguistics'}
            data-testid="tab-persian-linguistics"
            onClick={() => setActiveTab('linguistics')}
            className={`pb-1 text-xs font-semibold whitespace-nowrap border-b-2 cursor-pointer transition-colors ${
              activeTab === 'linguistics'
                ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {isFa ? 'پالایش زبان‌شناختی فارسی' : 'Persian Linguistics'}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {activeTab !== 'linguistics' && (
            <>
              <button
                type="button"
                onClick={onUndoEdl}
                disabled={!canUndoEdl}
                aria-label={isFa ? 'بازگشت تصمیم EDL' : 'Undo EDL Decision'}
                className="p-1.5 rounded border border-slate-300 dark:border-[#252F42] text-slate-600 dark:text-slate-300 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onRedoEdl}
                disabled={!canRedoEdl}
                aria-label={isFa ? 'تکرار تصمیم EDL' : 'Redo EDL Decision'}
                className="p-1.5 rounded border border-slate-300 dark:border-[#252F42] text-slate-600 dark:text-slate-300 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="btn-run-edl-analysis"
                onClick={onRunAnalysis}
                disabled={isAnalyzing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-400 text-slate-950 text-xs font-semibold hover:bg-amber-300 disabled:opacity-50 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {isAnalyzing
                    ? isFa
                      ? 'در حال تحلیل...'
                      : 'Analyzing...'
                    : isFa
                      ? 'تحلیل رویدادها و ساخت EDL'
                      : 'Analyze Events & Build EDL'}
                </span>
              </button>
            </>
          )}
          {activeTab === 'linguistics' && (
            <button
              type="button"
              data-testid="btn-run-persian-linguistics"
              onClick={handleRunPersianLinguistics}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-400 text-slate-950 text-xs font-semibold hover:bg-amber-300 cursor-pointer"
            >
              <Languages className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'تحلیل زبان‌شناختی متن' : 'Analyze Persian Text'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Tab 1: Mission 05 EDL Review */}
      {activeTab === 'edl' && (
        <div className="p-4 space-y-3 max-h-[420px] overflow-y-auto">
          {!edlSnapshot ? (
            <div className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center space-y-2">
              <p>
                {isFa
                  ? 'هنوز لیست تصمیمات تدوین (EDL) برای این پروژه ساخته نشده است. هیچ برشی بدون تأیید صریح شما اعمال نمی‌شود.'
                  : 'No Edit Decision List (EDL) has been generated yet. No cut is ever applied without your explicit approval.'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-[#252F42] pb-2">
                <span className="tabular-nums">
                  {isFa
                    ? `نسخه EDL: ${edlSnapshot.edlVersion} · تأییدشده برای رندر: ${approvedCount} از ${proposals.length}`
                    : `EDL v${edlSnapshot.edlVersion} · Approved for Render: ${approvedCount} / ${proposals.length}`}
                </span>
                <span className="font-mono text-[11px]" dir="ltr">
                  {edlSnapshot.sourceAudioHash.slice(0, 12)}
                </span>
              </div>

              {proposals.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
                  {isFa
                    ? 'هیچ پیشنهاد تدوین پرخطر یا مکث اضافه‌ای در این قطعه شناسایی نشد.'
                    : 'No edit proposals were detected in this recording.'}
                </p>
              ) : (
                <div className="space-y-2.5">
                  {proposals.map((prop) => {
                    const activeRange = prop.proposedRange ?? prop.originalRange;
                    const startSample = activeRange?.startSample ?? 0;
                    const endSample = activeRange?.endSample ?? 0;
                    const startSec = startSample / sampleRate;
                    const endSec = endSample / sampleRate;
                    const durationMs = Math.round((endSec - startSec) * 1000);
                    const isExpanded = expandedProposalId === prop.proposalId;

                    return (
                      <div
                        key={prop.proposalId}
                        data-testid={`edl-proposal-${prop.proposalId}`}
                        className="rounded-md border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-3 space-y-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            {riskIcon(prop.risk.overallLevel)}
                            <span className="font-semibold text-slate-900 dark:text-slate-100">
                              {prop.operation}
                            </span>
                            <span className="text-slate-500 dark:text-slate-400">·</span>
                            <span className="text-slate-700 dark:text-slate-300">
                              {statusLabel(prop.status, isFa)}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => onSeekSec(startSec)}
                            dir="ltr"
                            className="font-mono tabular-nums text-[11px] text-amber-700 dark:text-amber-300 hover:underline cursor-pointer"
                          >
                            {startSec.toFixed(2)}s – {endSec.toFixed(2)}s ({durationMs}ms)
                          </button>
                        </div>

                        <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                          {prop.explanationFa}
                        </p>

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <button
                            type="button"
                            data-testid={`btn-approve-${prop.proposalId}`}
                            onClick={() => onApproveProposal(prop.proposalId)}
                            disabled={prop.status === 'APPROVED' || prop.status === 'INVALID' || prop.status === 'STALE'}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'تأیید' : 'Approve'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRejectProposal(prop.proposalId)}
                            disabled={prop.status === 'REJECTED'}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-[#1E2738] disabled:opacity-40 cursor-pointer"
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'رد' : 'Reject'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRequestReviewProposal(prop.proposalId)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-[#1E2738] cursor-pointer"
                          >
                            <Flag className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'بازبینی' : 'Flag'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onPreviewProposal(prop, 'before')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-[#1E2738] cursor-pointer"
                          >
                            <Play className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'قبل' : 'Before'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onPreviewProposal(prop, 'after')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-[#1E2738] cursor-pointer"
                          >
                            <Scissors className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'بعد' : 'After'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onReviseBoundaryMs(prop.proposalId, -15, 15)}
                            className="px-2 py-1 rounded border border-slate-300 dark:border-[#252F42] text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-[#1E2738] font-mono cursor-pointer"
                            title={isFa ? 'اصلاح مرز ±15ms' : 'Widen boundaries ±15ms'}
                          >
                            ±15ms
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedProposalId(isExpanded ? null : prop.proposalId)
                            }
                            className="ms-auto inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                          >
                            <Eye className="w-3 h-3" aria-hidden="true" />
                            <span>{isFa ? 'شواهد' : 'Evidence'}</span>
                            {isExpanded ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="mt-2 pt-2 border-t border-slate-200 dark:border-[#252F42] space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
                            <div>
                              <strong>{isFa ? 'سطح ریسک:' : 'Risk Level:'}</strong> {prop.risk.overallLevel} (
                              {prop.risk.blockingReasons.join(' · ') || '—'})
                            </div>
                            <div className="font-mono" dir="ltr">
                              Samples: [{startSample} .. {endSample}] · Basis:{' '}
                              {prop.boundary.measurementBasis} · Event IDs:{' '}
                              {prop.speechEventSourceIds.join(', ') || 'none'}
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
      {activeTab === 'events' && (
        <div className="p-4 space-y-2 max-h-[420px] overflow-y-auto text-xs">
          {events.length === 0 ? (
            <p className="text-slate-500 dark:text-slate-400 py-6 text-center">
              {isFa
                ? 'برای مشاهده مکث‌ها، تپق‌ها، پرکننده‌های گفتاری و رویدادهای آوایی، دکمه «تحلیل رویدادها» را بزنید.'
                : 'Click "Analyze Events" to detect pauses, fillers, repetitions, and vocal events locally.'}
            </p>
          ) : (
            events.map((ev) => (
              <div
                key={ev.eventId}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] px-3 py-2"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-slate-900 dark:text-slate-100">
                    {ev.category}{' '}
                    <span className="font-normal text-slate-500 dark:text-slate-400">
                      ({ev.subtype})
                    </span>
                  </div>
                  <div className="text-slate-600 dark:text-slate-400">{ev.explanationFa}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onSeekSec(ev.startSec)}
                  dir="ltr"
                  className="font-mono tabular-nums text-[11px] text-amber-700 dark:text-amber-300 hover:underline cursor-pointer"
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
      {activeTab === 'linguistics' && (
        <div className="p-4 space-y-3 max-h-[420px] overflow-y-auto text-xs">
          {lingStatusMsg && (
            <div className="rounded border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sky-900 dark:text-sky-200">
              {lingStatusMsg}
            </div>
          )}

          {!lingDoc ? (
            <p className="text-slate-500 dark:text-slate-400 py-5 text-center">
              {isFa
                ? 'پالایش زبان‌شناختی فارسی، لایه خام ASR و لایه دقیق گفتاری (Verbatim) را دست‌نخورده نگه می‌دارد و فقط پیشنهادهای مستند و قابل بازگشت تولید می‌کند.'
                : 'Persian linguistic refinement keeps Raw ASR and Verbatim layers immutable and only generates reversible evidence-based proposals.'}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {(['RAW_ASR', 'VERBATIM', 'NORMALIZED', 'READABLE'] as const).map((layer) => (
                  <button
                    key={layer}
                    type="button"
                    onClick={() => setLingLayer(layer)}
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer ${
                      lingLayer === layer
                        ? 'border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200'
                        : 'border-slate-300 dark:border-[#252F42] text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {layer}
                  </button>
                ))}
                <span className="ms-auto font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  v{lingDoc.version}
                </span>
              </div>

              <div className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-3 leading-7 text-slate-800 dark:text-slate-200">
                {renderTranscriptLayerText(lingDoc, lingLayer) || (isFa ? 'متنی موجود نیست' : 'No text')}
              </div>

              {lingCandidates.length === 0 ? (
                <p className="text-slate-500 dark:text-slate-400 text-center py-2">
                  {isFa
                    ? 'متن فعلی از نظر نیم‌فاصله، اعداد و علائم نگارشی نیاز به تغییر پیشنهادی ندارد.'
                    : 'No linguistic refinement proposals were needed for this transcript.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {lingCandidates.map((cand) => (
                    <div
                      key={cand.candidateId}
                      className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] p-2.5 space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          «{cand.originalText}» ← «{cand.proposedText}»
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                          {cand.category} · {cand.semanticRisk.riskLevel} · {cand.status}
                        </span>
                      </div>
                      <p className="text-slate-600 dark:text-slate-400">{cand.linguisticEvidence}</p>
                      <div className="flex items-center gap-2 pt-0.5">
                        {cand.status === 'PROPOSED' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAcceptLingCandidate(cand)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer"
                            >
                              <Check className="w-3 h-3" />
                              <span>{isFa ? 'اعمال روی لایه خوانا' : 'Accept'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRejectLingCandidate(cand.candidateId)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 cursor-pointer"
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
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-500/40 text-amber-700 dark:text-amber-300 cursor-pointer"
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
