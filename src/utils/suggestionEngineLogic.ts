/**
 * AVAPARDAZ — Intelligent Suggestion Review & Edit Planning Pure Logic (Phase 04)
 *
 * Strictly enforces:
 * - 4 user-facing categories: filler, pause, repetition, breath
 * - Clear separation of Review Decision ('approved' vs 'rejected') from Applied Edit ('applied')
 * - Duplicate, Overlap, Conflict, and Stale detection
 * - Deduplicated total removal duration calculation (never double-counting overlapping spans)
 * - Strict timestamp validation before building an Edit Plan
 * - Context transcript extraction (before / inside / after)
 */

import {
  FLICKS_PER_SECOND,
  PersianWordToken,
  RecommendationKind,
  SmartRecommendation,
} from '../contracts/v1_2';
import { normalizePersianSearchQuery } from '../projects/projectLibraryLogic';

export type SuggestionCategory4 = 'filler' | 'pause' | 'repetition' | 'breath';

export type ReviewLifecycleState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'stale'
  | 'conflict';

export interface AnalyzedSuggestionItem {
  readonly recommendation: SmartRecommendation;
  readonly category: SuggestionCategory4;
  readonly lifecycle: ReviewLifecycleState;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly isRangeValid: boolean;
  readonly duplicateOfId: string | null;
  readonly conflictingIds: readonly string[];
  readonly overlapKind: 'none' | 'full' | 'partial' | 'adjacent';
  readonly contextBefore: string;
  readonly contextInside: string;
  readonly contextAfter: string;
}

export interface SuggestionEditPlanSummary {
  readonly approvedCount: number;
  readonly applicableItems: readonly AnalyzedSuggestionItem[];
  readonly conflictCount: number;
  readonly staleCount: number;
  readonly alreadyAppliedCount: number;
  readonly invalidRangeCount: number;
  /** Deduplicated union of removal intervals (seconds) — never double-counts overlaps */
  readonly totalRemovalSec: number;
  readonly canExecute: boolean;
}

export function mapRecommendationKindToCategory(
  kind: RecommendationKind,
  relatedText = '',
  reasonFa = '',
): SuggestionCategory4 {
  const combined = `${relatedText} ${reasonFa}`;
  if (kind === 'long-pause') return 'pause';
  if (kind === 'repetition') return 'repetition';
  if (
    kind === 'crosstalk-bleed' ||
    /نفس|تنفس|breath|inhale/i.test(combined)
  ) {
    return 'breath';
  }
  return 'filler';
}

export function isRecommendationRangeValid(
  rec: SmartRecommendation,
  durationSec: number,
): boolean {
  const startFlicks = rec.boundary?.snappedRange?.startFlicks ?? rec.range?.startFlicks;
  const endFlicks = rec.boundary?.snappedRange?.endFlicks ?? rec.range?.endFlicks;
  if (!Number.isFinite(startFlicks) || !Number.isFinite(endFlicks)) return false;
  if (startFlicks < 0 || endFlicks <= startFlicks) return false;
  const startSec = startFlicks / FLICKS_PER_SECOND;
  const endSec = endFlicks / FLICKS_PER_SECOND;
  if (Number.isFinite(durationSec) && durationSec > 0 && endSec > durationSec + 0.05) {
    return false;
  }
  return true;
}

/**
 * Extracts real surrounding transcript context (before, inside, after) for a time range.
 */
export function extractTranscriptContextForRange(
  tokens: readonly PersianWordToken[],
  startFlicks: number,
  endFlicks: number,
  contextWordWindow = 4,
): { before: string; inside: string; after: string } {
  if (tokens.length === 0) {
    return { before: '', inside: '', after: '' };
  }

  let firstInside = -1;
  let lastInside = -1;
  let nearestBefore = -1;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.range.endFlicks <= startFlicks) {
      nearestBefore = i;
    } else if (t.range.startFlicks < endFlicks && t.range.endFlicks > startFlicks) {
      if (firstInside === -1) firstInside = i;
      lastInside = i;
    }
  }

  if (firstInside !== -1) {
    const beforeSlice = tokens.slice(Math.max(0, firstInside - contextWordWindow), firstInside);
    const insideSlice = tokens.slice(firstInside, lastInside + 1);
    const afterSlice = tokens.slice(lastInside + 1, lastInside + 1 + contextWordWindow);
    return {
      before: beforeSlice.map((t) => t.displayText).join(' '),
      inside: insideSlice.map((t) => t.displayText).join(' '),
      after: afterSlice.map((t) => t.displayText).join(' '),
    };
  }

  // Pause / non-verbal event falling strictly between two words
  const beforeSlice =
    nearestBefore >= 0
      ? tokens.slice(Math.max(0, nearestBefore - contextWordWindow + 1), nearestBefore + 1)
      : [];
  const afterStart = nearestBefore + 1;
  const afterSlice = tokens.slice(afterStart, afterStart + contextWordWindow);
  return {
    before: beforeSlice.map((t) => t.displayText).join(' '),
    inside: '',
    after: afterSlice.map((t) => t.displayText).join(' '),
  };
}

/**
 * Analyzes all recommendations for validity, duplicates, overlaps, conflicts, stale state,
 * and surrounding transcript context without mutating raw recommendations.
 */
export function analyzeSuggestionsForReview(params: {
  recommendations: readonly SmartRecommendation[];
  approvedIds: ReadonlySet<string>;
  tokens: readonly PersianWordToken[];
  durationSec: number;
}): AnalyzedSuggestionItem[] {
  const { recommendations, approvedIds, tokens, durationSec } = params;

  const baseItems = recommendations.map((rec) => {
    const range = rec.boundary?.snappedRange ?? rec.range;
    const startSec = Number.isFinite(range.startFlicks) ? range.startFlicks / FLICKS_PER_SECOND : 0;
    const endSec = Number.isFinite(range.endFlicks) ? range.endFlicks / FLICKS_PER_SECOND : 0;
    const isValid = isRecommendationRangeValid(rec, durationSec);
    const category = mapRecommendationKindToCategory(rec.kind, rec.relatedText, rec.reasonFa);
    const ctx = extractTranscriptContextForRange(tokens, range.startFlicks, range.endFlicks);

    return {
      rec,
      category,
      startSec,
      endSec,
      durationSec: Math.max(0, endSec - startSec),
      isValid,
      ctx,
    };
  });

  const result: AnalyzedSuggestionItem[] = [];

  for (let i = 0; i < baseItems.length; i++) {
    const item = baseItems[i];
    const rec = item.rec;
    let duplicateOfId: string | null = null;
    const conflictingIds: string[] = [];
    let overlapKind: 'none' | 'full' | 'partial' | 'adjacent' = 'none';

    const isReviewable = rec.status === 'Pending' || rec.status === 'Modified';

    for (let j = 0; j < baseItems.length; j++) {
      if (i === j) continue;
      const other = baseItems[j];
      if (other.rec.trackId !== rec.trackId) continue;

      const nearSameStart = Math.abs(item.startSec - other.startSec) < 0.03;
      const nearSameEnd = Math.abs(item.endSec - other.endSec) < 0.03;

      if (nearSameStart && nearSameEnd) {
        overlapKind = 'full';
        if (j < i && other.category === item.category) {
          duplicateOfId = other.rec.id;
        } else if (isReviewable && (other.rec.status === 'Pending' || other.rec.status === 'Modified')) {
          conflictingIds.push(other.rec.id);
        }
        continue;
      }

      const overlapStart = Math.max(item.startSec, other.startSec);
      const overlapEnd = Math.min(item.endSec, other.endSec);
      if (overlapEnd > overlapStart + 0.01) {
        if (overlapKind !== 'full') overlapKind = 'partial';
        if (isReviewable && (other.rec.status === 'Pending' || other.rec.status === 'Modified')) {
          conflictingIds.push(other.rec.id);
        }
      } else if (
        Math.abs(item.endSec - other.startSec) <= 0.05 ||
        Math.abs(other.endSec - item.startSec) <= 0.05
      ) {
        if (overlapKind === 'none') overlapKind = 'adjacent';
      }
    }

    let lifecycle: ReviewLifecycleState;
    if (rec.status === 'Accepted') {
      lifecycle = 'applied';
    } else if (rec.status === 'Rejected') {
      lifecycle = 'rejected';
    } else if (rec.status === 'Invalidated' || rec.status === 'Superseded' || !item.isValid) {
      lifecycle = 'stale';
    } else if (conflictingIds.length > 0 && approvedIds.has(rec.id) && conflictingIds.some((cid) => approvedIds.has(cid))) {
      lifecycle = 'conflict';
    } else if (conflictingIds.length > 0 && !approvedIds.has(rec.id)) {
      lifecycle = 'conflict';
    } else if (approvedIds.has(rec.id)) {
      lifecycle = 'approved';
    } else {
      lifecycle = 'pending';
    }

    result.push({
      recommendation: rec,
      category: item.category,
      lifecycle,
      startSec: item.startSec,
      endSec: item.endSec,
      durationSec: item.durationSec,
      isRangeValid: item.isValid,
      duplicateOfId,
      conflictingIds,
      overlapKind,
      contextBefore: item.ctx.before,
      contextInside: item.ctx.inside || rec.relatedText,
      contextAfter: item.ctx.after,
    });
  }

  return result;
}

/**
 * Computes deduplicated union duration across a list of [startSec, endSec] intervals.
 */
export function computeDeduplicatedDurationSec(
  intervals: readonly { startSec: number; endSec: number }[],
): number {
  const valid = intervals
    .filter((iv) => Number.isFinite(iv.startSec) && Number.isFinite(iv.endSec) && iv.endSec > iv.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  if (valid.length === 0) return 0;
  let total = 0;
  let curStart = valid[0].startSec;
  let curEnd = valid[0].endSec;

  for (let i = 1; i < valid.length; i++) {
    const iv = valid[i];
    if (iv.startSec <= curEnd) {
      if (iv.endSec > curEnd) curEnd = iv.endSec;
    } else {
      total += curEnd - curStart;
      curStart = iv.startSec;
      curEnd = iv.endSec;
    }
  }
  total += curEnd - curStart;
  return Number(total.toFixed(4));
}

/**
 * Builds a validated Edit Plan summary for all user-approved suggestions.
 * Automatically excludes stale, conflicted, invalid-range, and already-applied items.
 */
export function buildSuggestionEditPlan(
  analyzed: readonly AnalyzedSuggestionItem[],
  approvedIds: ReadonlySet<string>,
): SuggestionEditPlanSummary {
  let conflictCount = 0;
  let staleCount = 0;
  let alreadyAppliedCount = 0;
  let invalidRangeCount = 0;
  const applicableItems: AnalyzedSuggestionItem[] = [];

  for (const item of analyzed) {
    if (!approvedIds.has(item.recommendation.id)) continue;
    if (!item.isRangeValid) {
      invalidRangeCount++;
      continue;
    }
    if (item.lifecycle === 'applied') {
      alreadyAppliedCount++;
      continue;
    }
    if (item.lifecycle === 'stale') {
      staleCount++;
      continue;
    }
    if (item.lifecycle === 'conflict') {
      conflictCount++;
      continue;
    }
    if (item.lifecycle === 'approved') {
      applicableItems.push(item);
    }
  }

  // Sort applicable edits in DESCENDING timeline order so sequential ripple cuts preserve earlier timestamps!
  const sortedApplicable = [...applicableItems].sort((a, b) => b.startSec - a.startSec);
  const totalRemovalSec = computeDeduplicatedDurationSec(sortedApplicable);

  return {
    approvedCount: approvedIds.size,
    applicableItems: sortedApplicable,
    conflictCount,
    staleCount,
    alreadyAppliedCount,
    invalidRangeCount,
    totalRemovalSec,
    canExecute: sortedApplicable.length > 0,
  };
}

export function filterAndSortAnalyzedSuggestions(
  items: readonly AnalyzedSuggestionItem[],
  options: {
    category: 'all' | SuggestionCategory4;
    status: 'all' | ReviewLifecycleState;
    query: string;
    sortBy: 'time' | 'category' | 'confidence' | 'order';
  },
): AnalyzedSuggestionItem[] {
  const q = normalizePersianSearchQuery(options.query);

  const filtered = items.filter((item) => {
    if (options.category !== 'all' && item.category !== options.category) return false;
    if (options.status !== 'all' && item.lifecycle !== options.status) return false;
    if (q) {
      const hay = normalizePersianSearchQuery(
        `${item.recommendation.relatedText} ${item.contextBefore} ${item.contextAfter} ${item.recommendation.reasonFa} ${item.category}`,
      );
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (options.sortBy === 'order') return filtered;

  return [...filtered].sort((a, b) => {
    if (options.sortBy === 'time') {
      if (a.startSec !== b.startSec) return a.startSec - b.startSec;
    } else if (options.sortBy === 'category') {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
    } else if (options.sortBy === 'confidence') {
      if (b.recommendation.confidence !== a.recommendation.confidence) {
        return b.recommendation.confidence - a.recommendation.confidence;
      }
    }
    return a.recommendation.id.localeCompare(b.recommendation.id);
  });
}
