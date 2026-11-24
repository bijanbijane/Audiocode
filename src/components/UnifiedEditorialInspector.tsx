import React, { useEffect, useState } from 'react';
import { ListChecks, Sparkles, SplitSquareVertical } from 'lucide-react';
import type { EditDecisionListSnapshot, EditProposal } from '../ai-engine/edit-decision';
import type { SpeechEventAnalysisResult } from '../ai-engine/speech-events';
import type {
  AudioAsset,
  PersianWordToken,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import type { SuggestionCategoryFilter, SuggestionSortOrder } from '../settings/settingsStore';
import { SuggestionsPanel } from './SuggestionsPanel';
import { EdlReviewPanel } from './EdlReviewPanel';
import { formatNumberForLocale } from '../utils/formatters';
import { getNextRovingTabIndex } from '../studio/layoutUtils';

export type EditorialInspectorFocus = 'unified' | 'suggestions' | 'edl';

interface UnifiedEditorialInspectorProps {
  recommendations: SmartRecommendation[];
  selectedRecId: string | null;
  previewingId: string | null;
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  pcmSources: Record<string, Float32Array>;
  tokens: PersianWordToken[];
  sampleRate: number;
  totalDurationSec: number;
  locale: 'fa' | 'en';
  persianDigits?: boolean;
  timecodeFormat?: 'mm:ss.ms' | 'hh:mm:ss';
  contextBeforeSec: number;
  contextAfterSec: number;
  defaultCategory?: SuggestionCategoryFilter;
  defaultSort?: SuggestionSortOrder;
  showContextTranscript?: boolean;
  confirmBeforeApply?: boolean;
  autoExpandDetails?: boolean;
  focusNextAfterReview?: boolean;
  speechEventResult: SpeechEventAnalysisResult | null;
  edlSnapshot: EditDecisionListSnapshot | null;
  isAnalyzingEdl: boolean;
  canUndoEdl: boolean;
  canRedoEdl: boolean;
  requestedFocus?: EditorialInspectorFocus | null;
  onSelectSuggestion: (id: string) => void;
  onPreviewSuggestion: (rec: SmartRecommendation, mode: 'before' | 'after') => void;
  onPreviewSuggestionWithContext: (
    rec: SmartRecommendation,
    beforeSec: number,
    afterSec: number,
  ) => void;
  onAcceptSuggestion: (rec: SmartRecommendation) => void;
  onApplyApprovedBatch: (items: readonly SmartRecommendation[]) => void;
  onRejectSuggestion: (id: string) => void;
  onNudgeSuggestionBoundary: (id: string, deltaMs: number) => void;
  onJumpToRange: (startSec: number, endSec: number, trackId: string) => void;
  onRescanDeepDisfluencies: () => void;
  onSoftenBreathsAndCoughs: () => void;
  onRunEdlAnalysis: () => void;
  onApproveEdlProposal: (proposalId: string) => void;
  onRejectEdlProposal: (proposalId: string) => void;
  onRequestReviewEdlProposal: (proposalId: string) => void;
  onReviseEdlBoundaryMs: (proposalId: string, deltaStartMs: number, deltaEndMs: number) => void;
  onPreviewEdlProposal: (proposal: EditProposal, mode: 'before' | 'after') => void;
  onSeekSec: (sec: number) => void;
  onUndoEdl: () => void;
  onRedoEdl: () => void;
  onApplyLinguisticBatchUpdates: (
    updates: ReadonlyArray<{ tokenId: string; displayText: string }>,
    descriptionFa?: string,
  ) => void;
}

export const UnifiedEditorialInspector: React.FC<UnifiedEditorialInspectorProps> = ({
  recommendations,
  selectedRecId,
  previewingId,
  tracks,
  assets,
  pcmSources,
  tokens,
  sampleRate,
  totalDurationSec,
  locale,
  persianDigits = false,
  timecodeFormat = 'mm:ss.ms',
  contextBeforeSec,
  contextAfterSec,
  defaultCategory = 'all',
  defaultSort = 'time',
  showContextTranscript = true,
  confirmBeforeApply = true,
  autoExpandDetails = false,
  focusNextAfterReview = true,
  speechEventResult,
  edlSnapshot,
  isAnalyzingEdl,
  canUndoEdl,
  canRedoEdl,
  requestedFocus = null,
  onSelectSuggestion,
  onPreviewSuggestion,
  onPreviewSuggestionWithContext,
  onAcceptSuggestion,
  onApplyApprovedBatch,
  onRejectSuggestion,
  onNudgeSuggestionBoundary,
  onJumpToRange,
  onRescanDeepDisfluencies,
  onSoftenBreathsAndCoughs,
  onRunEdlAnalysis,
  onApproveEdlProposal,
  onRejectEdlProposal,
  onRequestReviewEdlProposal,
  onReviseEdlBoundaryMs,
  onPreviewEdlProposal,
  onSeekSec,
  onUndoEdl,
  onRedoEdl,
  onApplyLinguisticBatchUpdates,
}) => {
  const isFa = locale === 'fa';
  const [focusMode, setFocusMode] = useState<EditorialInspectorFocus>('suggestions');

  useEffect(() => {
    if (requestedFocus) {
      setFocusMode(requestedFocus);
    }
  }, [requestedFocus]);

  const pendingSuggestions = recommendations.filter((r) => r.status === 'Pending').length;
  const edlCount = edlSnapshot?.proposals.length ?? 0;

  return (
    <div
      data-testid="unified-editorial-inspector"
      className="avp-pane-shell flex flex-col h-full min-h-0 overflow-hidden bg-[var(--avp-surface)]"
    >
      {/* Unified Inspector Top Mode Bar */}
      <div className="min-h-[44px] sm:min-h-[36px] px-1.5 xl:px-2 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)] flex flex-wrap sm:flex-nowrap items-center justify-between gap-1 shrink-0 py-1 sm:py-0">
        <span className="hidden xl:inline text-[11px] font-bold text-[var(--avp-text-secondary)] whitespace-nowrap">
          {isFa ? 'بازرس' : 'Inspector'}
        </span>

        <div
          role="tablist"
          aria-label={isFa ? 'نمای بازرس تدوین' : 'Inspector layout'}
          onKeyDown={(e) => {
            const modes: EditorialInspectorFocus[] = ['suggestions', 'edl', 'unified'];
            const idx = modes.indexOf(focusMode);
            const nextIdx = getNextRovingTabIndex(idx, modes.length, e.key, isFa, 'horizontal');
            if (nextIdx !== null) {
              e.preventDefault();
              setFocusMode(modes[nextIdx]);
            }
          }}
          className="flex xl:inline-flex flex-1 xl:flex-initial items-center p-0.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)] gap-0.5 shrink-0"
        >
          <button
            type="button"
            role="tab"
            data-testid="inspector-mode-suggestions"
            aria-selected={focusMode === 'suggestions'}
            tabIndex={focusMode === 'suggestions' ? 0 : -1}
            onClick={() => setFocusMode('suggestions')}
            className={`inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2 rounded-[5px] text-[11px] font-medium cursor-pointer transition-colors whitespace-nowrap ${
              focusMode === 'suggestions'
                ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                : 'text-[var(--avp-text-muted)] hover:text-[var(--avp-text)]'
            }`}
          >
            <Sparkles className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>
              {isFa ? 'پیشنهاد' : 'Edits'} ({formatNumberForLocale(pendingSuggestions, { persianDigits })})
            </span>
          </button>

          <button
            type="button"
            role="tab"
            data-testid="inspector-mode-edl"
            aria-selected={focusMode === 'edl'}
            tabIndex={focusMode === 'edl' ? 0 : -1}
            onClick={() => setFocusMode('edl')}
            className={`inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2 rounded-[5px] text-[11px] font-medium cursor-pointer transition-colors whitespace-nowrap ${
              focusMode === 'edl'
                ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                : 'text-[var(--avp-text-muted)] hover:text-[var(--avp-text)]'
            }`}
          >
            <ListChecks className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>
              {isFa ? 'تصمیمات' : 'EDL'} ({formatNumberForLocale(edlCount, { persianDigits })})
            </span>
          </button>

          <button
            type="button"
            role="tab"
            data-testid="inspector-mode-unified"
            aria-selected={focusMode === 'unified'}
            tabIndex={focusMode === 'unified' ? 0 : -1}
            onClick={() => setFocusMode('unified')}
            title={isFa ? 'نمای یکپارچه (پیشنهادها + لیست تدوین)' : 'Unified split view'}
            className={`inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[26px] sm:h-[26px] px-2 rounded-[5px] text-[11px] font-medium cursor-pointer transition-colors whitespace-nowrap ${
              focusMode === 'unified'
                ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                : 'text-[var(--avp-text-muted)] hover:text-[var(--avp-text)]'
            }`}
          >
            <SplitSquareVertical className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>{isFa ? 'یکپارچه' : 'All'}</span>
          </button>
        </div>
      </div>

      {/* Top Section: Smart Suggestions (flex-1 when unified or suggestions) */}
      {focusMode !== 'edl' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <SuggestionsPanel
            recommendations={recommendations}
            selectedRecId={selectedRecId}
            previewingId={previewingId}
            tracks={tracks}
            assets={assets}
            pcmSources={pcmSources}
            tokens={tokens}
            sampleRate={sampleRate}
            totalDurationSec={totalDurationSec}
            locale={locale}
            persianDigits={persianDigits}
            timecodeFormat={timecodeFormat}
            contextBeforeSec={contextBeforeSec}
            contextAfterSec={contextAfterSec}
            defaultCategory={defaultCategory}
            defaultSort={defaultSort}
            showContextTranscript={showContextTranscript}
            confirmBeforeApply={confirmBeforeApply}
            autoExpandDetails={autoExpandDetails}
            focusNextAfterReview={focusNextAfterReview}
            embedded
            onSelect={onSelectSuggestion}
            onPreview={onPreviewSuggestion}
            onPreviewWithContext={onPreviewSuggestionWithContext}
            onAccept={onAcceptSuggestion}
            onApplyApprovedBatch={onApplyApprovedBatch}
            onReject={onRejectSuggestion}
            onNudgeBoundary={onNudgeSuggestionBoundary}
            onJumpToRange={onJumpToRange}
            onRescanDeepDisfluencies={onRescanDeepDisfluencies}
            onSoftenBreathsAndCoughs={onSoftenBreathsAndCoughs}
          />
        </div>
      )}

      {/* Bottom / Expanded Section: EDL Review, Speech Events & Persian Linguistics */}
      {focusMode !== 'suggestions' && (
        <div className={focusMode === 'edl' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'shrink-0'}>
          <EdlReviewPanel
            locale={locale}
            persianDigits={persianDigits}
            timecodeFormat={timecodeFormat}
            sampleRate={sampleRate}
            tokens={tokens}
            speechEventResult={speechEventResult}
            edlSnapshot={edlSnapshot}
            isAnalyzing={isAnalyzingEdl}
            canUndoEdl={canUndoEdl}
            canRedoEdl={canRedoEdl}
            forceExpanded={focusMode === 'edl'}
            onRunAnalysis={onRunEdlAnalysis}
            onApproveProposal={onApproveEdlProposal}
            onRejectProposal={onRejectEdlProposal}
            onRequestReviewProposal={onRequestReviewEdlProposal}
            onReviseBoundaryMs={onReviseEdlBoundaryMs}
            onPreviewProposal={onPreviewEdlProposal}
            onSeekSec={onSeekSec}
            onUndoEdl={onUndoEdl}
            onRedoEdl={onRedoEdl}
            onApplyLinguisticBatchUpdates={onApplyLinguisticBatchUpdates}
          />
        </div>
      )}
    </div>
  );
};
