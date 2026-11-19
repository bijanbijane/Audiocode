/**
 * Timeline Virtualization & Level-of-Detail (LOD) Event Renderer (AVP-P11-001 Section 6)
 * - Renders ONLY visible viewport sample range + bounded overscan.
 * - Preserves authoritative integer sourceStartSample/sourceEndSample separately from display X/width pixels.
 * - Aggregates dense clusters visually without EVER merging or destroying underlying edit decisions.
 * - Expands clusters cleanly on zoom-in and preserves selection/focus across virtualization scrolls.
 */

export interface TimelineVirtualizableEvent {
  readonly id: string;
  readonly trackId: string;
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly sampleRate: number;
  readonly kind: string;
  readonly status: string;
}

export interface TimelineViewportSpec {
  readonly viewportStartSample: number;
  readonly viewportEndSample: number;
  readonly viewportWidthPx: number;
  readonly overscanRatio?: number;
  /** Minimum pixel span before adjacent events visually cluster (display-only LOD) */
  readonly minItemWidthPx?: number;
  readonly selectedEventId?: string | null;
  readonly focusedEventId?: string | null;
}

export type RenderedTimelineItem =
  | {
      readonly renderKind: 'SINGLE';
      readonly stableKey: string;
      readonly event: TimelineVirtualizableEvent;
      readonly displayLeftPx: number;
      readonly displayWidthPx: number;
      readonly isSelected: boolean;
      readonly isFocused: boolean;
    }
  | {
      readonly renderKind: 'CLUSTER';
      readonly stableKey: string;
      readonly memberEventIds: readonly string[];
      readonly memberEvents: readonly TimelineVirtualizableEvent[];
      readonly sourceStartSample: number;
      readonly sourceEndSample: number;
      readonly displayLeftPx: number;
      readonly displayWidthPx: number;
      readonly containsSelection: boolean;
      readonly containsFocus: boolean;
    };

export interface TimelineVirtualizationResult {
  readonly totalInputEvents: number;
  readonly visibleRawEventCount: number;
  readonly renderedItems: readonly RenderedTimelineItem[];
  readonly overscanStartSample: number;
  readonly overscanEndSample: number;
  readonly aggregatedClusterCount: number;
}

/**
 * Pure deterministic virtualizer + non-destructive LOD clusterer.
 * Guarantees exact preservation of underlying event IDs and integer source sample coordinates.
 */
export function virtualizeTimelineEvents(
  sortedEvents: readonly TimelineVirtualizableEvent[],
  viewport: TimelineViewportSpec,
): TimelineVirtualizationResult {
  const spanSamples = Math.max(1, viewport.viewportEndSample - viewport.viewportStartSample);
  const overscanRatio = Math.max(0, Math.min(1, viewport.overscanRatio ?? 0.15));
  const overscanSamples = Math.round(spanSamples * overscanRatio);
  const overscanStart = Math.max(0, viewport.viewportStartSample - overscanSamples);
  const overscanEnd = viewport.viewportEndSample + overscanSamples;
  const pxPerSample = viewport.viewportWidthPx / spanSamples;
  const minWidthPx = Math.max(2, viewport.minItemWidthPx ?? 6);

  // Filter strictly to visible + overscan window (binary search start for O(log N + K))
  let lo = 0;
  let hi = sortedEvents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedEvents[mid].sourceEndSample < overscanStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const visibleEvents: TimelineVirtualizableEvent[] = [];
  for (let i = lo; i < sortedEvents.length; i += 1) {
    const ev = sortedEvents[i];
    if (ev.sourceStartSample > overscanEnd) break;
    if (ev.sourceEndSample >= overscanStart) {
      visibleEvents.push(ev);
    }
  }

  const renderedItems: RenderedTimelineItem[] = [];
  let clusterCount = 0;

  // Non-destructive display-only clustering when consecutive items fall below minWidthPx
  let i = 0;
  while (i < visibleEvents.length) {
    const ev = visibleEvents[i];
    const leftPx = (ev.sourceStartSample - viewport.viewportStartSample) * pxPerSample;
    const rawWidthPx = Math.max(1, (ev.sourceEndSample - ev.sourceStartSample) * pxPerSample);

    if (rawWidthPx >= minWidthPx || i + 1 >= visibleEvents.length) {
      renderedItems.push({
        renderKind: 'SINGLE',
        stableKey: `ev:${ev.id}`,
        event: ev,
        displayLeftPx: Number(leftPx.toFixed(2)),
        displayWidthPx: Number(Math.max(2, rawWidthPx).toFixed(2)),
        isSelected: viewport.selectedEventId === ev.id,
        isFocused: viewport.focusedEventId === ev.id,
      });
      i += 1;
      continue;
    }

    // Check if the next event on the same track is visually colliding (< minWidthPx gap)
    const clusterMembers: TimelineVirtualizableEvent[] = [ev];
    let clusterEndSample = ev.sourceEndSample;
    let j = i + 1;
    while (j < visibleEvents.length) {
      const next = visibleEvents[j];
      if (next.trackId !== ev.trackId) break;
      const nextLeftPx = (next.sourceStartSample - viewport.viewportStartSample) * pxPerSample;
      const currRightPx = (clusterEndSample - viewport.viewportStartSample) * pxPerSample;
      const nextWidthPx = (next.sourceEndSample - next.sourceStartSample) * pxPerSample;
      if (nextLeftPx - currRightPx < minWidthPx && nextWidthPx < minWidthPx) {
        clusterMembers.push(next);
        clusterEndSample = Math.max(clusterEndSample, next.sourceEndSample);
        j += 1;
      } else {
        break;
      }
    }

    if (clusterMembers.length === 1) {
      renderedItems.push({
        renderKind: 'SINGLE',
        stableKey: `ev:${ev.id}`,
        event: ev,
        displayLeftPx: Number(leftPx.toFixed(2)),
        displayWidthPx: Number(Math.max(2, rawWidthPx).toFixed(2)),
        isSelected: viewport.selectedEventId === ev.id,
        isFocused: viewport.focusedEventId === ev.id,
      });
    } else {
      clusterCount += 1;
      const clusterWidthPx = Math.max(
        minWidthPx,
        (clusterEndSample - ev.sourceStartSample) * pxPerSample,
      );
      renderedItems.push({
        renderKind: 'CLUSTER',
        stableKey: `cluster:${ev.trackId}:${clusterMembers[0].id}:${clusterMembers.length}`,
        memberEventIds: clusterMembers.map((m) => m.id),
        memberEvents: clusterMembers,
        sourceStartSample: ev.sourceStartSample,
        sourceEndSample: clusterEndSample,
        displayLeftPx: Number(leftPx.toFixed(2)),
        displayWidthPx: Number(clusterWidthPx.toFixed(2)),
        containsSelection: clusterMembers.some((m) => m.id === viewport.selectedEventId),
        containsFocus: clusterMembers.some((m) => m.id === viewport.focusedEventId),
      });
    }
    i = j;
  }

  return {
    totalInputEvents: sortedEvents.length,
    visibleRawEventCount: visibleEvents.length,
    renderedItems,
    overscanStartSample: overscanStart,
    overscanEndSample: overscanEnd,
    aggregatedClusterCount: clusterCount,
  };
}
