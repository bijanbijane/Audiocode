import {
  EditTransaction,
  FlickRange,
  PersianWordToken,
  RecommendationActionMode,
  TimelineClip,
  Track,
} from '../contracts/v1_2';
import { rangeDurationFlicks, rangesOverlap } from './timebase';

/**
 * Multi-Track Sync-Locked Non-Destructive Timeline Engine (v1.2 Spec Sections 24 & 25)
 * - Enforces Sync-Lock Protection: Ripple Cut only shifts time when ALL synced tracks are silent in [start, end).
 * - Automatically falls back to In-Place Range Suppression (Room Tone Fill) when another track has active speech.
 * - Supports Gesture Coalescing (Ephemeral state vs committed EditTransaction) and full Undo/Redo.
 */

export function cloneTracks(tracks: Track[]): Track[] {
  return tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => ({
      ...c,
      timelineRange: { ...c.timelineRange },
    })),
  }));
}

/**
 * Determines whether a cut on `targetTrackId` in `cutRange` can safely Ripple Delete
 * or must use In-Place Room Tone Suppression to protect multi-track sync.
 */
export function determineSyncSafeEditMode(
  tracks: Track[],
  targetTrackId: string,
  cutRange: FlickRange,
  tokens: PersianWordToken[],
): { mode: RecommendationActionMode; reasonFa: string } {
  const targetTrack = tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack || !targetTrack.syncGroupId) {
    return {
      mode: 'sync-locked-ripple-cut',
      reasonFa: 'تک‌ترک یا خارج از گروه همگام‌سازی — برش زمانی (Ripple Cut) ایمن است.',
    };
  }

  const peerTracks = tracks.filter(
    (t) => t.id !== targetTrackId && t.syncGroupId === targetTrack.syncGroupId,
  );

  for (const peer of peerTracks) {
    // Check if peer track has active non-disfluency/non-crosstalk speech tokens overlapping cutRange
    const peerActiveToken = tokens.find(
      (tok) =>
        tok.trackId === peer.id &&
        !tok.isCrosstalkSuppressed &&
        rangesOverlap(tok.range, cutRange),
    );
    if (peerActiveToken) {
      return {
        mode: 'in-place-room-tone-suppression',
        reasonFa: `حفاظت سینک چندترک: در این بازه «${peer.speakerLabel}» در حال صحبت است («${peerActiveToken.displayText}»)؛ جایگزینی درجا با Room Tone اعمال می‌شود تا همگام‌سازی ترک‌ها به هم نخورد.`,
      };
    }
  }

  return {
    mode: 'sync-locked-ripple-cut',
    reasonFa: 'تمام ترک‌های همگام در این بازه ساکت‌اند — برش هم‌زمان قفل‌شده (Sync-Locked Ripple Cut) مجاز است.',
  };
}

/** Removes `[cutRange.startFlicks, cutRange.endFlicks)` from a single track's clips and optionally shifts later clips */
function cutRangeFromClipList(
  clips: TimelineClip[],
  cutRange: FlickRange,
  shiftFollowingClips: boolean,
  replaceWithRoomToneAssetId?: string,
  trackId?: string,
): TimelineClip[] {
  const cutDur = rangeDurationFlicks(cutRange);
  const nextClips: TimelineClip[] = [];

  for (const clip of clips) {
    const r = clip.timelineRange;
    // Case 1: Completely before cutRange
    if (r.endFlicks <= cutRange.startFlicks) {
      nextClips.push({ ...clip, timelineRange: { ...r } });
      continue;
    }

    // Case 2: Completely after cutRange
    if (r.startFlicks >= cutRange.endFlicks) {
      nextClips.push({
        ...clip,
        timelineRange: shiftFollowingClips
          ? {
              startFlicks: r.startFlicks - cutDur,
              endFlicks: r.endFlicks - cutDur,
            }
          : { ...r },
      });
      continue;
    }

    // Case 3: Overlaps cutRange -> split into left/right pieces
    if (r.startFlicks < cutRange.startFlicks) {
      nextClips.push({
        ...clip,
        id: `${clip.id}-L`,
        timelineRange: {
          startFlicks: r.startFlicks,
          endFlicks: cutRange.startFlicks,
        },
      });
    }

    if (!shiftFollowingClips && replaceWithRoomToneAssetId && trackId) {
      const fillStart = Math.max(r.startFlicks, cutRange.startFlicks);
      const fillEnd = Math.min(r.endFlicks, cutRange.endFlicks);
      if (fillEnd > fillStart) {
        nextClips.push({
          id: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          assetId: replaceWithRoomToneAssetId,
          trackId,
          kind: 'room-tone-fill',
          timelineRange: { startFlicks: fillStart, endFlicks: fillEnd },
          sourceStartFlicks: 0,
          fadeInMs: 10,
          fadeOutMs: 10,
          gainDb: 0,
          muted: false,
        });
      }
    }

    if (r.endFlicks > cutRange.endFlicks) {
      const consumedFromClipStart = cutRange.endFlicks - r.startFlicks;
      nextClips.push({
        ...clip,
        id: `${clip.id}-R`,
        timelineRange: shiftFollowingClips
          ? {
              startFlicks: cutRange.endFlicks - cutDur,
              endFlicks: r.endFlicks - cutDur,
            }
          : {
              startFlicks: cutRange.endFlicks,
              endFlicks: r.endFlicks,
            },
        sourceStartFlicks: clip.sourceStartFlicks + consumedFromClipStart,
      });
    }
  }

  return nextClips;
}

export function applySyncSafeCut(
  tracks: Track[],
  targetTrackId: string,
  cutRange: FlickRange,
  mode: RecommendationActionMode,
): Track[] {
  const targetTrack = tracks.find((t) => t.id === targetTrackId);
  if (!targetTrack) return tracks;

  if (mode === 'sync-locked-ripple-cut') {
    const syncGroup = targetTrack.syncGroupId;
    return tracks.map((t) => {
      const shouldApply = t.id === targetTrackId || (syncGroup !== null && t.syncGroupId === syncGroup);
      if (!shouldApply) return t;
      return {
        ...t,
        clips: cutRangeFromClipList(t.clips, cutRange, true),
      };
    });
  }

  // In-Place Room Tone Suppression: only affects targetTrackId, preserves timeline length & sync!
  return tracks.map((t) => {
    if (t.id !== targetTrackId) return t;
    const primaryAssetId = t.clips[0]?.assetId ?? 'asset-1';
    return {
      ...t,
      clips: cutRangeFromClipList(t.clips, cutRange, false, primaryAssetId, t.id),
    };
  });
}

export function computeTimelineDurationFlicks(tracks: Track[]): number {
  let maxEnd = 0;
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.timelineRange.endFlicks > maxEnd) {
        maxEnd = c.timelineRange.endFlicks;
      }
    }
  }
  return maxEnd;
}

/**
 * Transaction History Stack with Gesture Coalescing support (Section 25).
 * Ensures continuous slider drags only emit ONE committed transaction upon release.
 */
export class TimelineHistoryManager {
  private undoStack: EditTransaction[] = [];
  private redoStack: EditTransaction[] = [];
  private projectVersion = 1;

  commitTransaction(
    params: Omit<EditTransaction, 'operationId' | 'projectVersion' | 'commitStatus' | 'timestamp'>,
  ): EditTransaction {
    // If coalescingKey matches top of undoStack within 1.5s, merge instead of spamming stack
    const prev = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (
      prev &&
      prev.coalescingKey === params.coalescingKey &&
      params.coalescingKey !== '' &&
      now - prev.timestamp < 1500
    ) {
      prev.afterTracks = cloneTracks(params.afterTracks);
      prev.description = params.description;
      prev.timestamp = now;
      this.redoStack = [];
      return prev;
    }

    const tx: EditTransaction = {
      ...params,
      operationId: `tx-${++this.projectVersion}-${now}`,
      projectVersion: this.projectVersion,
      timestamp: now,
      beforeTracks: cloneTracks(params.beforeTracks),
      afterTracks: cloneTracks(params.afterTracks),
      commitStatus: 'committed',
    };

    this.undoStack.push(tx);
    this.redoStack = [];
    return tx;
  }

  undo(): EditTransaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    tx.commitStatus = 'reverted';
    this.redoStack.push(tx);
    return tx;
  }

  redo(): EditTransaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    tx.commitStatus = 'committed';
    this.undoStack.push(tx);
    return tx;
  }

  getHistory(): EditTransaction[] {
    return [...this.undoStack].reverse();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getProjectVersion(): number {
    return this.projectVersion;
  }
}
