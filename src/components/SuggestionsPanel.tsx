import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Crosshair,
  Play,
  RefreshCw,
  Scissors,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Waves,
  X,
} from 'lucide-react';
import {
  AudioAsset,
  PersianWordToken,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';
import {
  AnalyzedSuggestionItem,
  analyzeSuggestionsForReview,
  buildSuggestionEditPlan,
  filterAndSortAnalyzedSuggestions,
  ReviewLifecycleState,
  SuggestionCategory4,
} from '../utils/suggestionEngineLogic';
import { SuggestionWaveformMiniCard } from './SuggestionWaveformMiniCard';

interface SuggestionsPanelProps {
  recommendations: SmartRecommendation[];
  selectedRecId: string | null;
  previewingId: string | null;
  tracks?: Track[];
  assets?: Record<string, AudioAsset>;
  pcmSources?: Record<string, Float32Array>;
  tokens?: PersianWordToken[];
  sampleRate?: number;
  totalDurationSec?: number;
  locale?: 'fa' | 'en';
  contextBeforeSec?: number;
  contextAfterSec?: number;
  onSelect: (id: string) => void;
  onPreview: (rec: SmartRecommendation, mode: 'before' | 'after') => void;
  onPreviewWithContext?: (rec: SmartRecommendation, beforeSec: number, afterSec: number) => void;
  onAccept: (rec: SmartRecommendation) => void;
  onApplyApprovedBatch?: (items: readonly SmartRecommendation[]) => void;
  onReject: (id: string) => void;
  onNudgeBoundary: (id: string, deltaMs: number) => void;
  onJumpToRange?: (startSec: number, endSec: number, trackId: string) => void;
  onBatchAcceptAllSafe?: () => void;
  onRescanDeepDisfluencies?: () => void;
  onSoftenBreathsAndCoughs?: () => void;
  onScanMultiTrackCrosstalk?: () => void;
}

const CATEGORY_LABELS: Record<SuggestionCategory4, { fa: string; en: string }> = {
  filler: { fa: 'تپق', en: 'Filler' },
  pause: { fa: 'مکث', en: 'Pause' },
  repetition: { fa: 'تکرار', en: 'Repetition' },
  breath: { fa: 'نفس', en: 'Breath' },
};

const LIFECYCLE_LABELS: Record<ReviewLifecycleState, { fa: string; en: string }> = {
  pending: { fa: 'در انتظار', en: 'Pending' },
  approved: { fa: 'تأییدشده', en: 'Approved' },
  rejected: { fa: 'ردشده', en: 'Rejected' },
  applied: { fa: 'اعمال‌شده', en: 'Applied' },
  stale: { fa: 'منقضی', en: 'Stale' },
  conflict: { fa: 'تعارض', en: 'Conflict' },
};

export const SuggestionsPanel: React.FC<SuggestionsPanelProps> = ({
  recommendations,
  selectedRecId,
  previewingId,
  tracks,
  assets,
  pcmSources,
  tokens = [],
  sampleRate,
  totalDurationSec = 0,
  locale = 'fa',
  contextBeforeSec = 2,
  contextAfterSec = 2,
  onSelect,
  onPreview,
  onPreviewWithContext,
  onAccept,
  onApplyApprovedBatch,
  onReject,
  onNudgeBoundary,
  onJumpToRange,
  onRescanDeepDisfluencies,
  onSoftenBreathsAndCoughs,
}) => {
  const isFa = locale === 'fa';
  const [categoryFilter, setCategoryFilter] = useState<'all' | SuggestionCategory4>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ReviewLifecycleState>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'time' | 'category' | 'confidence' | 'order'>('time');
  const [approvedIds, setApprovedIds] = useState<Set<string>>(() => new Set());
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(() => new Set());
  const [showEditPlanModal, setShowEditPlanModal] = useState(false);
  // Default collapsed so 3-4 complete suggestion cards sit visible above the fold (expandable on demand!)
  const [showMiniCard, setShowMiniCard] = useState(false);
  const [showFiltersDrawer, setShowFiltersDrawer] = useState(false);
  const [showSearchInput, setShowSearchInput] = useState(false);

  const effectiveApprovedIds = useMemo(() => {
    const next = new Set<string>();
    const pendingSet = new Set(
      recommendations
        .filter((r) => r.status === 'Pending' || r.status === 'Modified')
        .map((r) => r.id),
    );
    approvedIds.forEach((id) => {
      if (pendingSet.has(id)) next.add(id);
    });
    return next;
  }, [recommendations, approvedIds]);

  const analyzedItems = useMemo(
    () =>
      analyzeSuggestionsForReview({
        recommendations,
        approvedIds: effectiveApprovedIds,
        tokens,
        durationSec: totalDurationSec,
      }),
    [recommendations, effectiveApprovedIds, tokens, totalDurationSec],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<'all' | SuggestionCategory4, number> = {
      all: analyzedItems.length,
      filler: 0,
      pause: 0,
      repetition: 0,
      breath: 0,
    };
    for (const item of analyzedItems) {
      counts[item.category] += 1;
    }
    return counts;
  }, [analyzedItems]);

  const filteredItems = useMemo(
    () =>
      filterAndSortAnalyzedSuggestions(analyzedItems, {
        category: categoryFilter,
        status: statusFilter,
        query: searchQuery,
        sortBy,
      }),
    [analyzedItems, categoryFilter, statusFilter, searchQuery, sortBy],
  );

  const editPlan = useMemo(
    () => buildSuggestionEditPlan(analyzedItems, effectiveApprovedIds),
    [analyzedItems, effectiveApprovedIds],
  );

  const pendingCount = useMemo(
    () => recommendations.filter((r) => r.status === 'Pending').length,
    [recommendations],
  );

  const activePreviewRec =
    recommendations.find((r) => r.id === selectedRecId) ??
    filteredItems[0]?.recommendation ??
    recommendations.find((r) => r.status === 'Pending') ??
    recommendations[0] ??
    null;

  const canRenderMiniCard = Boolean(
    showMiniCard &&
      activePreviewRec &&
      tracks &&
      tracks.length > 0 &&
      assets &&
      sampleRate &&
      sampleRate > 0,
  );

  const toggleApproveReview = (id: string) => {
    setApprovedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleBatchCheck = (id: string) => {
    setSelectedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchApproveFiltered = () => {
    const targetIds =
      selectedBatchIds.size > 0
        ? Array.from(selectedBatchIds)
        : filteredItems
            .filter((it) => it.lifecycle === 'pending' && it.isRangeValid)
            .map((it) => it.recommendation.id);
    if (targetIds.length === 0) return;
    setApprovedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) next.add(id);
      return next;
    });
    setSelectedBatchIds(new Set());
  };

  const handleBatchRejectSelected = () => {
    const targetIds = Array.from(selectedBatchIds);
    for (const id of targetIds) {
      onReject(id);
    }
    setSelectedBatchIds(new Set());
    setApprovedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) next.delete(id);
      return next;
    });
  };

  const handleConfirmExecuteEditPlan = () => {
    if (!editPlan.canExecute) return;
    const recsToApply = editPlan.applicableItems.map((it) => it.recommendation);
    if (onApplyApprovedBatch) {
      onApplyApprovedBatch(recsToApply);
    } else {
      for (const rec of recsToApply) {
        onAccept(rec);
      }
    }
    setApprovedIds(new Set());
    setSelectedBatchIds(new Set());
    setShowEditPlanModal(false);
  };

  const hasExtraFilterActive = statusFilter !== 'all' || sortBy !== 'time';

  return (
    <section
      data-testid="suggestions-panel"
      aria-label={isFa ? 'پیشنهادهای هوشمند تدوین' : 'Smart Editing Suggestions'}
      className="avp-pane-shell flex flex-col h-full min-h-0 overflow-hidden"
    >
      {/* Slim Native Inspector Header (36px) */}
      <div className="h-[36px] px-3 border-b border-[var(--avp-border)] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <h2 className="text-[12.5px] font-semibold text-[var(--avp-text)] truncate">
            {isFa ? 'پیشنهادهای هوشمند' : 'Smart Suggestions'}
          </h2>
          <span
            data-testid="pending-recommendations-count"
            className="text-[11px] font-mono tabular-nums text-[var(--avp-accent-text)] font-semibold"
          >
            ({pendingCount})
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowSearchInput((v) => !v)}
            aria-pressed={showSearchInput || Boolean(searchQuery)}
            title={isFa ? 'جستجو در پیشنهادها' : 'Search suggestions'}
            aria-label={isFa ? 'جستجو در پیشنهادها' : 'Search suggestions'}
            className={`avp-btn-icon avp-btn-icon-sm ${
              showSearchInput || searchQuery ? 'avp-btn-tonal' : ''
            }`}
          >
            <Search className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => setShowFiltersDrawer((v) => !v)}
            aria-expanded={showFiltersDrawer}
            title={isFa ? 'فیلتر وضعیت و مرتب‌سازی' : 'Status filter & sort'}
            className={`avp-btn-icon avp-btn-icon-sm ${
              showFiltersDrawer || hasExtraFilterActive ? 'avp-btn-tonal' : ''
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>

          {onRescanDeepDisfluencies && (
            <button
              type="button"
              data-testid="btn-rescan-disfluencies"
              onClick={onRescanDeepDisfluencies}
              title={isFa ? 'اسکن مجدد تپق و مکث' : 'Rescan Disfluencies'}
              aria-label={isFa ? 'اسکن مجدد' : 'Rescan'}
              className="avp-btn-icon avp-btn-icon-sm"
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowMiniCard((v) => !v)}
            aria-pressed={showMiniCard}
            title={
              isFa
                ? 'نمایش یا پنهان‌کردن پیش‌نمایش موجی اثر حذف'
                : 'Toggle before/after mini waveform diff'
            }
            aria-label={isFa ? 'پیش‌نمایش موجی' : 'Waveform diff preview'}
            className={`avp-btn-icon avp-btn-icon-sm ${showMiniCard ? 'avp-btn-tonal' : ''}`}
          >
            <Waves className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Compact 2-Tier Category Tabs & Batch Strip */}
      <div className="border-b border-[var(--avp-border)] bg-[var(--avp-surface)] shrink-0">
        {/* Tier 1: Clean Underline Category Tabs with Counter Badges */}
        <div
          role="tablist"
          aria-label={isFa ? 'دسته‌بندی پیشنهادها' : 'Suggestion categories'}
          className="grid grid-cols-5 px-1.5 border-b border-[var(--avp-border-subtle)]"
        >
          {(['all', 'filler', 'pause', 'repetition', 'breath'] as const).map((cat) => {
            const active = categoryFilter === cat;
            const label = cat === 'all' ? (isFa ? 'همه' : 'All') : CATEGORY_LABELS[cat][locale];
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                data-testid={`suggestion-cat-${cat}`}
                aria-selected={active}
                onClick={() => setCategoryFilter(cat)}
                className={`h-[30px] px-1 text-[11px] font-medium transition-colors flex items-center justify-center gap-1 border-b-2 -mb-px cursor-pointer whitespace-nowrap ${
                  active
                    ? 'border-[var(--avp-accent)] text-[var(--avp-accent-text)] font-semibold'
                    : 'border-transparent text-[var(--avp-text-muted)] hover:text-[var(--avp-text)]'
                }`}
              >
                <span>{label}</span>
                <span
                  className={`inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full font-mono text-[9.5px] leading-none ${
                    active
                      ? 'bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-bold'
                      : 'bg-[var(--avp-surface-secondary)] text-[var(--avp-text-muted)]'
                  }`}
                >
                  {categoryCounts[cat]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Optional Collapsible Search / Filter Drawers */}
        {(showSearchInput || Boolean(searchQuery) || showFiltersDrawer) && (
          <div className="px-2.5 pt-1.5 pb-1 space-y-1.5 border-b border-[var(--avp-border-subtle)] bg-[var(--avp-surface-secondary)]/50">
            {(showSearchInput || Boolean(searchQuery)) && (
              <div className="relative flex-1 min-w-0">
                <Search
                  className="w-3.5 h-3.5 text-[var(--avp-text-muted)] absolute top-1/2 -translate-y-1/2 start-2.5 pointer-events-none"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <input
                  type="text"
                  autoFocus={showSearchInput}
                  data-testid="input-suggestions-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={isFa ? 'جستجو در پیشنهادها...' : 'Filter suggestions...'}
                  className="avp-input h-[26px] w-full ps-8 pe-6 text-[11.5px]"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label={isFa ? 'پاک‌کردن جستجو' : 'Clear search'}
                    className="absolute top-1/2 -translate-y-1/2 end-1.5 text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] cursor-pointer"
                  >
                    <X className="w-3 h-3" strokeWidth={1.75} />
                  </button>
                )}
              </div>
            )}

            {showFiltersDrawer && (
              <div className="grid grid-cols-2 gap-1.5">
                <select
                  aria-label={isFa ? 'فیلتر وضعیت پیشنهاد' : 'Filter by status'}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'all' | ReviewLifecycleState)}
                  className="avp-select w-full"
                >
                  <option value="all">{isFa ? 'همه وضعیت‌ها' : 'All Status'}</option>
                  <option value="pending">{isFa ? 'در انتظار' : 'Pending'}</option>
                  <option value="approved">{isFa ? 'تأییدشده' : 'Approved'}</option>
                  <option value="applied">{isFa ? 'اعمال‌شده' : 'Applied'}</option>
                  <option value="rejected">{isFa ? 'ردشده' : 'Rejected'}</option>
                  <option value="conflict">{isFa ? 'تعارض' : 'Conflict'}</option>
                </select>

                <select
                  aria-label={isFa ? 'مرتب‌سازی پیشنهادها' : 'Sort suggestions'}
                  value={sortBy}
                  onChange={(e) =>
                    setSortBy(e.target.value as 'time' | 'category' | 'confidence' | 'order')
                  }
                  className="avp-select w-full"
                >
                  <option value="time">{isFa ? 'مرتب‌سازی: زمان' : 'Sort: Time'}</option>
                  <option value="confidence">{isFa ? 'مرتب‌سازی: اطمینان' : 'Sort: Confidence'}</option>
                  <option value="category">{isFa ? 'مرتب‌سازی: دسته' : 'Sort: Category'}</option>
                </select>
              </div>
            )}
          </div>
        )}

        {/* Tier 2: Slim 30px Framed Batch Action Strip */}
        <div className="px-2.5 h-[30px] flex items-center justify-between gap-1 bg-[var(--avp-surface-secondary)]/35">
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              data-testid="btn-batch-approve-suggestions"
              onClick={handleBatchApproveFiltered}
              className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-[10.5px] font-medium text-[var(--avp-text)] cursor-pointer transition-colors"
            >
              <CheckCheck
                className="w-3 h-3 text-[var(--avp-accent)]"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span>
                {selectedBatchIds.size > 0
                  ? isFa
                    ? `تأیید (${selectedBatchIds.size})`
                    : `Approve (${selectedBatchIds.size})`
                  : isFa
                    ? 'تأیید دسته‌ای'
                    : 'Approve All'}
              </span>
            </button>

            {selectedBatchIds.size > 0 && (
              <button
                type="button"
                onClick={handleBatchRejectSelected}
                className="avp-btn avp-btn-sm avp-btn-danger-ghost px-1.5 text-[10.5px] h-[22px]"
              >
                <X className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                <span>{isFa ? 'رد' : 'Reject'}</span>
              </button>
            )}

            {onSoftenBreathsAndCoughs && (
              <button
                type="button"
                data-testid="btn-soften-breaths-coughs"
                onClick={onSoftenBreathsAndCoughs}
                title={isFa ? 'نرم‌سازی صدای نفس‌ها (-10dB)' : 'Soften Breaths (-10dB)'}
                className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-[10.5px] font-medium text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] cursor-pointer transition-colors"
              >
                {isFa ? 'نرم‌سازی نفس' : 'Soften Breaths'}
              </button>
            )}
          </div>

          {effectiveApprovedIds.size > 0 && (
            <button
              type="button"
              data-testid="btn-open-edit-plan-modal"
              onClick={() => setShowEditPlanModal(true)}
              className="avp-btn avp-btn-sm avp-btn-tonal px-2 text-[10.5px] h-[22px]"
            >
              <Sparkles className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
              <span>
                {isFa
                  ? `اعمال (${editPlan.applicableItems.length})`
                  : `Apply (${editPlan.applicableItems.length})`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* On-Demand Mini Waveform Diff Preview (Toggled via Wave icon in header) */}
      {canRenderMiniCard && activePreviewRec && tracks && assets && sampleRate && (
        <div className="shrink-0 border-b border-[var(--avp-border)]">
          <SuggestionWaveformMiniCard
            recommendation={activePreviewRec}
            tracks={tracks}
            assets={assets}
            pcmSources={pcmSources}
            tokens={tokens}
            sampleRate={sampleRate}
            locale={locale}
          />
        </div>
      )}

      {/* Clean Suggestion List — 3 to 4 Complete Cards Visible Above the Fold */}
      <div className="divide-y divide-[var(--avp-border-subtle)] overflow-y-auto flex-1 min-h-0 bg-[var(--avp-surface)]">
        {filteredItems.length === 0 ? (
          <div className="p-6 text-center space-y-1.5">
            <p className="text-xs font-medium text-[var(--avp-text-secondary)]">
              {recommendations.length === 0
                ? isFa
                  ? 'پیشنهاد تدوینی برای این پروژه یافت نشد.'
                  : 'No editing suggestions detected yet.'
                : isFa
                  ? 'هیچ پیشنهادی با فیلتر فعلی مطابقت ندارد.'
                  : 'No suggestions match the current filter.'}
            </p>
            {searchQuery || categoryFilter !== 'all' || statusFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => {
                  setCategoryFilter('all');
                  setStatusFilter('all');
                  setSearchQuery('');
                }}
                className="text-xs font-medium text-[var(--avp-accent-text)] hover:underline cursor-pointer"
              >
                {isFa ? 'پاک کردن فیلترها' : 'Clear filters'}
              </button>
            ) : null}
          </div>
        ) : (
          filteredItems.map((item: AnalyzedSuggestionItem) => {
            const rec = item.recommendation;
            const isSelected = rec.id === selectedRecId;
            const isReviewable =
              item.lifecycle === 'pending' ||
              item.lifecycle === 'approved' ||
              item.lifecycle === 'conflict';
            const isApproved = effectiveApprovedIds.has(rec.id);
            const hasValidConfidence = Number.isFinite(rec.confidence) && rec.confidence > 0;

            return (
              <div
                key={rec.id}
                data-testid={`suggestion-card-${rec.id}`}
                tabIndex={0}
                onClick={() => {
                  onSelect(rec.id);
                  if (onJumpToRange && item.isRangeValid) {
                    onJumpToRange(item.startSec, item.endSec, rec.trackId);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onSelect(rec.id);
                  }
                }}
                className={`group/card px-2.5 py-2 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--avp-accent)] ${
                  isSelected
                    ? 'bg-[var(--avp-accent-soft)]/45'
                    : 'hover:bg-[var(--avp-surface-shell)]/70'
                }`}
              >
                {/* Layer 1: Unified Single-Row Metadata (Checkbox + Category + Status | Time Range + Δ Savings) */}
                <div className="flex items-center justify-between gap-1.5 text-[10.5px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {isReviewable && (
                      <input
                        type="checkbox"
                        data-testid={`btn-review-approve-${rec.id}`}
                        aria-label={
                          isFa ? `انتخاب دسته‌ای ${rec.relatedText}` : `Select ${rec.relatedText}`
                        }
                        checked={selectedBatchIds.has(rec.id) || isApproved}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => {
                          toggleBatchCheck(rec.id);
                          toggleApproveReview(rec.id);
                        }}
                        className="rounded border-[var(--avp-border)] accent-[var(--avp-accent)] cursor-pointer shrink-0"
                      />
                    )}
                    <span className="font-bold text-[11px] text-[var(--avp-text)] truncate">
                      {CATEGORY_LABELS[item.category][locale]}
                    </span>
                    <span className="text-[var(--avp-text-faint)]" aria-hidden="true">
                      ·
                    </span>
                    <span
                      className={`text-[10px] font-medium whitespace-nowrap ${
                        item.lifecycle === 'approved' || item.lifecycle === 'applied'
                          ? 'text-[var(--avp-accent-text)]'
                          : item.lifecycle === 'conflict' || item.lifecycle === 'stale'
                            ? 'text-[var(--avp-warning-text)]'
                            : 'text-[var(--avp-text-muted)]'
                      }`}
                    >
                      {LIFECYCLE_LABELS[item.lifecycle][locale]}
                    </span>
                  </div>

                  {/* Consolidated Monospace Time Range & Δ Savings Capsule */}
                  <span
                    dir="ltr"
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--avp-surface-secondary)]/85 text-[10px] font-mono tabular-nums text-[var(--avp-text-secondary)] shrink-0"
                    title={hasValidConfidence ? `${Math.round(rec.confidence * 100)}% confidence` : undefined}
                  >
                    <span>
                      {item.startSec.toFixed(2)}–{item.endSec.toFixed(2)}s
                    </span>
                    <span className="text-[var(--avp-text-faint)]">·</span>
                    <span className="font-semibold text-[var(--avp-accent-text)]">
                      Δ{item.durationSec.toFixed(2)}s
                    </span>
                  </span>
                </div>

                {/* Layer 2: Concise Title + Whisper Context Line */}
                <p className="mt-1 text-[12px] font-semibold text-[var(--avp-text)] truncate">
                  {rec.relatedText}
                </p>

                {(item.contextBefore || item.contextAfter) ? (
                  <p className="text-[10.5px] text-[var(--avp-text-muted)] mt-0.5 truncate">
                    {item.contextBefore ? <span>… {item.contextBefore} </span> : null}
                    <mark className="px-1 rounded-xs bg-[var(--avp-warning-soft)] text-[var(--avp-text)] font-medium">
                      {item.contextInside || rec.relatedText}
                    </mark>
                    {item.contextAfter ? <span> {item.contextAfter} …</span> : null}
                  </p>
                ) : (
                  <p className="text-[10.5px] text-[var(--avp-text-muted)] mt-0.5 truncate">
                    {rec.reasonFa}
                  </p>
                )}

                {/* Concise Warnings Only When Present */}
                {item.conflictingIds.length > 0 && (
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--avp-warning-text)]">
                    <AlertTriangle className="w-2.5 h-2.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    <span className="truncate">
                      {isFa
                        ? `هم‌پوشانی با ${item.conflictingIds.length} پیشنهاد دیگر`
                        : `Overlaps ${item.conflictingIds.length} suggestion(s)`}
                    </span>
                  </div>
                )}

                {rec.boundary.trailingEzafeRisk && (
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--avp-danger)]">
                    <AlertTriangle className="w-2.5 h-2.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    <span className="truncate">
                      {isFa
                        ? `خطر کسره اضافه روی «${rec.boundary.trailingEzafeWord}ِ»`
                        : `Ezafe risk on "${rec.boundary.trailingEzafeWord}"`}
                    </span>
                  </div>
                )}

                {/* Layer 3: Crisp 2-Pole Action Footer (Right: Context/Cut Preview Pill | Left: Apply + Dismiss) */}
                {isReviewable ? (
                  <div className="mt-1.5 flex items-center justify-between gap-1.5">
                    <div className="inline-flex items-center rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/55 p-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onPreviewWithContext) {
                            onPreviewWithContext(rec, contextBeforeSec, contextAfterSec);
                          } else {
                            onPreview(rec, 'before');
                          }
                        }}
                        title={isFa ? 'پخش با بافت اطراف' : 'Play with context'}
                        className="inline-flex items-center gap-1 h-[22px] px-2 rounded-[5px] text-[10.5px] font-medium text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
                      >
                        <Play
                          className="w-2.5 h-2.5 text-[var(--avp-accent)]"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                        <span>
                          {previewingId === `${rec.id}-before`
                            ? isFa
                              ? 'پخش...'
                              : '...'
                            : isFa
                              ? 'بافت'
                              : 'Context'}
                        </span>
                      </button>

                      <span className="w-px h-3 bg-[var(--avp-border)]" aria-hidden="true" />

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPreview(rec, 'after');
                        }}
                        title={isFa ? 'پیش‌شنوایی نتیجه پس از برش' : 'Preview cut splice'}
                        className="inline-flex items-center gap-1 h-[22px] px-2 rounded-[5px] text-[10.5px] font-medium text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
                      >
                        <Scissors className="w-2.5 h-2.5" strokeWidth={1.75} aria-hidden="true" />
                        <span>
                          {previewingId === `${rec.id}-after`
                            ? isFa
                              ? 'پخش...'
                              : '...'
                            : isFa
                              ? 'برش'
                              : 'Cut'}
                        </span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {onJumpToRange && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onJumpToRange(item.startSec, item.endSec, rec.trackId);
                          }}
                          title={isFa ? 'پرش روی تایم‌لاین' : 'Jump on timeline'}
                          aria-label={isFa ? 'پرش روی تایم‌لاین' : 'Jump on timeline'}
                          className="avp-btn-icon avp-btn-icon-sm opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 transition-opacity"
                        >
                          <Crosshair className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNudgeBoundary(rec.id, -40);
                        }}
                        title={isFa ? 'اصلاح مرز شروع (-40ms)' : 'Nudge start -40ms'}
                        aria-label={`اصلاح مرز ${rec.relatedText}`}
                        className="avp-btn-icon avp-btn-icon-sm opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 transition-opacity"
                      >
                        <SlidersHorizontal className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAccept(rec);
                        }}
                        aria-label={`اعمال پیشنهاد ${rec.relatedText}`}
                        className="avp-btn avp-btn-sm avp-btn-tonal h-[24px] px-2.5 text-[11px]"
                      >
                        <Check className="w-3 h-3" strokeWidth={2} aria-hidden="true" />
                        <span>{isFa ? 'اعمال' : 'Apply'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onReject(rec.id);
                        }}
                        aria-label={`رد پیشنهاد ${rec.relatedText}`}
                        title={isFa ? 'رد پیشنهاد' : 'Dismiss'}
                        className="avp-btn-icon avp-btn-icon-sm avp-btn-danger-ghost"
                      >
                        <X className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 text-[10.5px] font-medium text-[var(--avp-text-muted)]">
                    {item.lifecycle === 'applied'
                      ? isFa
                        ? 'اعمال شد (قابل بازگشت با Undo)'
                        : 'Applied (Undoable)'
                      : item.lifecycle === 'stale'
                        ? isFa
                          ? 'منقضی‌شده در اثر تغییرات قبلی'
                          : 'Stale after prior edits'
                        : isFa
                          ? 'رد شد'
                          : 'Rejected'}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Edit Plan Batch Confirmation Modal */}
      {showEditPlanModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          data-testid="edit-plan-confirm-modal"
        >
          <div className="w-full max-w-md rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface-floating)] text-[var(--avp-text)] shadow-[var(--avp-shadow-md)] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[var(--avp-border)] flex items-center justify-between">
              <h3 className="text-sm font-bold">
                {isFa ? 'خلاصه برنامه تدوین (Edit Plan)' : 'Review Edit Plan'}
              </h3>
              <button
                type="button"
                onClick={() => setShowEditPlanModal(false)}
                className="avp-btn-icon avp-btn-icon-sm"
              >
                <X className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-3">
                  <div className="text-[11px] text-[var(--avp-text-muted)]">
                    {isFa ? 'قابل اعمال' : 'Ready to Apply'}
                  </div>
                  <div className="text-base font-bold font-mono text-[var(--avp-accent-text)] mt-0.5">
                    {editPlan.applicableItems.length}
                  </div>
                </div>
                <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] p-3">
                  <div className="text-[11px] text-[var(--avp-text-muted)]">
                    {isFa ? 'کاهش زمان (بدون هم‌پوشانی)' : 'Deduplicated Reduction'}
                  </div>
                  <bdi dir="ltr" className="avp-bidi-num text-base font-bold block mt-0.5">
                    -{editPlan.totalRemovalSec.toFixed(2)}s
                  </bdi>
                </div>
              </div>

              {(editPlan.conflictCount > 0 ||
                editPlan.staleCount > 0 ||
                editPlan.invalidRangeCount > 0) && (
                <div className="rounded-xl border border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] p-3 text-[11px] space-y-1">
                  <div className="font-semibold text-[var(--avp-text)]">
                    {isFa
                      ? 'موارد کنارگذاشته‌شده برای حفظ سلامت صوت:'
                      : 'Excluded for audio safety:'}
                  </div>
                  {editPlan.conflictCount > 0 && (
                    <div>
                      •{' '}
                      {isFa
                        ? `${editPlan.conflictCount} مورد دارای تعارض هم‌پوشانی`
                        : `${editPlan.conflictCount} overlapping conflict(s)`}
                    </div>
                  )}
                  {editPlan.staleCount > 0 && (
                    <div>
                      •{' '}
                      {isFa
                        ? `${editPlan.staleCount} مورد منقضی‌شده (Stale)`
                        : `${editPlan.staleCount} stale item(s)`}
                    </div>
                  )}
                  {editPlan.invalidRangeCount > 0 && (
                    <div>
                      •{' '}
                      {isFa
                        ? `${editPlan.invalidRangeCount} مورد با بازه نامعتبر`
                        : `${editPlan.invalidRangeCount} invalid range(s)`}
                    </div>
                  )}
                </div>
              )}

              <p className="text-[11px] text-[var(--avp-text-muted)] leading-relaxed">
                {isFa
                  ? 'تغییرات به‌صورت غیرمخرب و از انتها به ابتدای تایم‌لاین اعمال می‌شوند و با Undo قابل بازگشت هستند.'
                  : 'Edits apply non-destructively from latest to earliest timestamp and remain fully undoable.'}
              </p>
            </div>

            <div className="px-5 py-3 border-t border-[var(--avp-border)] bg-[var(--avp-surface-shell)] flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowEditPlanModal(false)}
                className="avp-btn avp-btn-outline"
              >
                {isFa ? 'انصراف' : 'Cancel'}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-execute-edit-plan"
                disabled={!editPlan.canExecute}
                onClick={handleConfirmExecuteEditPlan}
                className="avp-btn avp-btn-primary"
              >
                {isFa ? 'اجرای برنامه تدوین' : 'Execute Edit Plan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
