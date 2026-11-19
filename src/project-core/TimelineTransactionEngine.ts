import {
  AIRecommendationRecord,
  EditTransaction,
  ProjectDocument,
  RecommendationId,
  TimelineClip,
  TimelineTrack,
  TrackId,
} from '../contracts/project-schema.contract';
import { TimeRange } from '../contracts/timebase.contract';
import { SmartSpliceDescriptor } from '../contracts/persian-editing.contract';

export type SiblingSpeechChecker = (trackId: TrackId, range: TimeRange) => boolean;

/**
 * Non-Destructive Multi-Track Transaction Engine (Sections 22-26 & 37)
 * - Enforces Multi-Track Sync Protection (GLOBAL_SYNC_RIPPLE vs IN_PLACE_ROOM_TONE).
 * - Separates 60fps Ephemeral Gestures from committed Undo/Redo EditTransactions.
 * - Tracks Recommendation lifecycle (PENDING -> ACCEPTED / INVALIDATED) across Undo/Redo.
 */
export class TimelineTransactionEngine {
  private committedDoc: ProjectDocument;
  private ephemeralDoc: ProjectDocument | null = null;
  private activeGestureKey: string | null = null;
  private siblingSpeechChecker?: SiblingSpeechChecker;

  private undoStack: EditTransaction[] = [];
  private redoStack: EditTransaction[] = [];

  constructor(initialDoc: ProjectDocument, siblingSpeechChecker?: SiblingSpeechChecker) {
    this.committedDoc = structuredClone(initialDoc);
    this.siblingSpeechChecker = siblingSpeechChecker;
  }

  public getActiveState(): ProjectDocument {
    return this.ephemeralDoc ?? this.committedDoc;
  }

  public getCommittedState(): ProjectDocument {
    return this.committedDoc;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public beginEphemeralGesture(gestureKey: string): void {
    this.activeGestureKey = gestureKey;
    this.ephemeralDoc = structuredClone(this.committedDoc);
  }

  public updateEphemeralGesture(mutator: (draft: ProjectDocument) => void): ProjectDocument {
    if (!this.ephemeralDoc) {
      this.ephemeralDoc = structuredClone(this.committedDoc);
    }
    mutator(this.ephemeralDoc);
    return this.ephemeralDoc;
  }

  public commitEphemeralGesture(description: string): EditTransaction | null {
    if (!this.ephemeralDoc) return null;

    const tx = this.recordTransaction(
      description,
      this.committedDoc.tracks,
      this.ephemeralDoc.tracks,
      [],
      this.activeGestureKey ?? undefined,
    );

    this.committedDoc = {
      ...this.ephemeralDoc,
      revision: tx.projectRevisionAfter,
    };
    this.ephemeralDoc = null;
    this.activeGestureKey = null;
    return tx;
  }

  public cancelEphemeralGesture(): void {
    this.ephemeralDoc = null;
    this.activeGestureKey = null;
  }

  public applySmartSpliceRecommendation(
    recommendationId: RecommendationId,
    roomToneSourceRange: TimeRange,
  ): EditTransaction {
    const rec = this.committedDoc.recommendations.find((r) => r.id === recommendationId);
    if (!rec || rec.status !== 'PENDING') {
      throw new Error(`RECOMMENDATION_NOT_APPLICABLE: ${recommendationId}`);
    }

    const cutRange = rec.spliceDescriptor.snappedAcousticRange;
    if (
      !Number.isFinite(cutRange.start) ||
      !Number.isFinite(cutRange.end) ||
      cutRange.end <= cutRange.start
    ) {
      throw new Error(`INVALID_CUT_RANGE: ${recommendationId}`);
    }

    const targetTrack = this.committedDoc.tracks.find((t) => t.id === rec.targetTrackId);
    if (!targetTrack) {
      throw new Error(`TRACK_NOT_FOUND: ${rec.targetTrackId}`);
    }

    const beforeTracks = structuredClone(this.committedDoc.tracks);
    let afterTracks = structuredClone(this.committedDoc.tracks);

    const syncGroupId = targetTrack.syncGroupId;
    const siblingActive = this.hasCrosstalkOrActiveSpeechOnSiblingTracks(
      afterTracks,
      targetTrack.id,
      syncGroupId,
      cutRange,
      rec.spliceDescriptor,
    );

    const useGlobalRipple =
      rec.spliceDescriptor.cutStrategy === 'GLOBAL_SYNC_RIPPLE' && !siblingActive;

    if (useGlobalRipple) {
      afterTracks = afterTracks.map((track) => {
        const belongsToGroup = syncGroupId
          ? track.syncGroupId === syncGroupId
          : track.id === targetTrack.id;
        if (!belongsToGroup) return track;
        return this.executeRippleCutOnTrack(
          track,
          cutRange,
          rec.spliceDescriptor,
          roomToneSourceRange,
        );
      });
    } else {
      afterTracks = afterTracks.map((track) => {
        if (track.id !== targetTrack.id) return track;
        return this.executeInPlaceRoomToneReplaceOnTrack(
          track,
          cutRange,
          rec.spliceDescriptor,
          roomToneSourceRange,
        );
      });
    }

    const invalidatedIds = this.findOverlappingPendingRecommendations(
      rec.id,
      cutRange,
      useGlobalRipple ? null : targetTrack.id,
    );

    const cutDuration = cutRange.end - cutRange.start;
    const rawInjectFlicks = rec.spliceDescriptor.injectRoomToneFlicks;
    const safeInjectFlicks =
      Number.isFinite(rawInjectFlicks) && rawInjectFlicks > 0 ? rawInjectFlicks : 0;
    const roomToneDur = Math.min(safeInjectFlicks, cutDuration);
    const netShiftLeft = useGlobalRipple ? Math.max(0, cutDuration - roomToneDur) : 0;
    const affectedTrackIds = new Set(
      this.committedDoc.tracks
        .filter((t) => (syncGroupId ? t.syncGroupId === syncGroupId : t.id === targetTrack.id))
        .map((t) => t.id),
    );

    const beforeRecommendations = structuredClone(this.committedDoc.recommendations);
    const updatedRecommendations: AIRecommendationRecord[] = this.committedDoc.recommendations.map(
      (r) => {
        if (r.id === rec.id) {
          return { ...r, status: 'ACCEPTED', userDecisionTimestamp: Date.now() };
        }
        if (invalidatedIds.includes(r.id)) {
          return { ...r, status: 'INVALIDATED' };
        }
        if (
          useGlobalRipple &&
          netShiftLeft > 0 &&
          r.status === 'PENDING' &&
          affectedTrackIds.has(r.targetTrackId) &&
          r.spliceDescriptor.snappedAcousticRange.start >= cutRange.end
        ) {
          const snapped = r.spliceDescriptor.snappedAcousticRange;
          const raw = r.spliceDescriptor.rawAiRange;
          const nextSnappedStart = Math.max(0, snapped.start - netShiftLeft);
          const nextSnappedEnd = Math.max(nextSnappedStart + 1, snapped.end - netShiftLeft);
          const nextRawStart = Math.max(0, raw.start - netShiftLeft);
          const nextRawEnd = Math.max(nextRawStart + 1, raw.end - netShiftLeft);
          return {
            ...r,
            spliceDescriptor: {
              ...r.spliceDescriptor,
              snappedAcousticRange: {
                start: nextSnappedStart,
                end: nextSnappedEnd,
              },
              rawAiRange: {
                start: nextRawStart,
                end: nextRawEnd,
              },
            },
          };
        }
        return r;
      },
    );

    const tx = this.recordTransaction(
      `اعمال اصلاح هوشمند: ${rec.associatedText}`,
      beforeTracks,
      afterTracks,
      invalidatedIds,
      undefined,
      rec.id,
      beforeRecommendations,
      updatedRecommendations,
    );

    this.committedDoc = {
      ...this.committedDoc,
      revision: tx.projectRevisionAfter,
      tracks: afterTracks,
      recommendations: updatedRecommendations,
    };
    this.ephemeralDoc = null;
    this.activeGestureKey = null;

    return tx;
  }

  private executeRippleCutOnTrack(
    track: TimelineTrack,
    cutRange: TimeRange,
    descriptor: SmartSpliceDescriptor,
    roomToneSourceRange: TimeRange,
  ): TimelineTrack {
    const cutDuration = cutRange.end - cutRange.start;
    const safeInject =
      Number.isFinite(descriptor.injectRoomToneFlicks) && descriptor.injectRoomToneFlicks > 0
        ? descriptor.injectRoomToneFlicks
        : 0;
    const roomToneDur = Math.min(safeInject, cutDuration);
    const netShiftLeft = Math.max(0, cutDuration - roomToneDur);
    const safeFadeIn =
      Number.isFinite(descriptor.fadeInDurationFlicks) && descriptor.fadeInDurationFlicks > 0
        ? descriptor.fadeInDurationFlicks
        : 0;
    const safeFadeOut =
      Number.isFinite(descriptor.fadeOutDurationFlicks) && descriptor.fadeOutDurationFlicks > 0
        ? descriptor.fadeOutDurationFlicks
        : 0;

    const newClips: TimelineClip[] = [];
    let roomToneInserted = false;

    for (const clip of track.clips) {
      // Case A: Clip completely before cutRange
      if (clip.timelineRange.end <= cutRange.start) {
        newClips.push(clip);
        continue;
      }

      // Case B: Clip completely after cutRange -> shift left by netShiftLeft
      if (clip.timelineRange.start >= cutRange.end) {
        newClips.push({
          ...clip,
          timelineRange: {
            start: clip.timelineRange.start - netShiftLeft,
            end: clip.timelineRange.end - netShiftLeft,
          },
        });
        continue;
      }

      // Case C: Clip overlaps cutRange -> split left / optional room tone / split right
      if (clip.timelineRange.start < cutRange.start) {
        const leftDuration = cutRange.start - clip.timelineRange.start;
        newClips.push({
          ...clip,
          id: `${clip.id}_L`,
          sourceRange: {
            start: clip.sourceRange.start,
            end: clip.sourceRange.start + leftDuration,
          },
          timelineRange: {
            start: clip.timelineRange.start,
            end: cutRange.start,
          },
          fadeOutFlicks: safeFadeOut,
        });
      }

      if (roomToneDur > 0 && !roomToneInserted) {
        roomToneInserted = true;
        newClips.push({
          id: `rt_${track.id}_${cutRange.start}_r${this.committedDoc.revision + 1}`,
          trackId: track.id,
          kind: 'ROOM_TONE_FILL',
          assetId: clip.assetId,
          sourceRange: {
            start: roomToneSourceRange.start,
            end: roomToneSourceRange.start + roomToneDur,
          },
          timelineRange: {
            start: cutRange.start,
            end: cutRange.start + roomToneDur,
          },
          fadeInFlicks: safeFadeIn,
          fadeOutFlicks: safeFadeOut,
          gainDb: 0,
        });
      }

      if (clip.timelineRange.end > cutRange.end) {
        const rightDuration = clip.timelineRange.end - cutRange.end;
        newClips.push({
          ...clip,
          id: `${clip.id}_R`,
          sourceRange: {
            start: clip.sourceRange.end - rightDuration,
            end: clip.sourceRange.end,
          },
          timelineRange: {
            start: cutRange.start + roomToneDur,
            end: clip.timelineRange.end - netShiftLeft,
          },
          fadeInFlicks: safeFadeIn,
        });
      }
    }

    return { ...track, clips: newClips };
  }

  private executeInPlaceRoomToneReplaceOnTrack(
    track: TimelineTrack,
    cutRange: TimeRange,
    descriptor: SmartSpliceDescriptor,
    roomToneSourceRange: TimeRange,
  ): TimelineTrack {
    const cutDuration = cutRange.end - cutRange.start;
    return this.executeRippleCutOnTrack(
      track,
      cutRange,
      { ...descriptor, injectRoomToneFlicks: cutDuration },
      roomToneSourceRange,
    );
  }

  private hasCrosstalkOrActiveSpeechOnSiblingTracks(
    tracks: TimelineTrack[],
    targetTrackId: TrackId,
    syncGroupId: string | null,
    range: TimeRange,
    descriptor: SmartSpliceDescriptor,
  ): boolean {
    if (!syncGroupId) return false;
    if (descriptor.prosodicWarnings.includes('CROSSTALK_BLEED_ACTIVE')) {
      return true;
    }

    for (const t of tracks) {
      if (t.syncGroupId !== syncGroupId || t.id === targetTrackId || t.muted) continue;

      if (this.siblingSpeechChecker) {
        if (this.siblingSpeechChecker(t.id, range)) return true;
      } else {
        const hasOverlappingAudio = t.clips.some(
          (c) =>
            c.kind === 'AUDIO_ASSET' &&
            c.timelineRange.start < range.end &&
            c.timelineRange.end > range.start,
        );
        if (hasOverlappingAudio) return true;
      }
    }
    return false;
  }

  private findOverlappingPendingRecommendations(
    excludeId: RecommendationId,
    range: TimeRange,
    trackId: TrackId | null,
  ): RecommendationId[] {
    return this.committedDoc.recommendations
      .filter((r) => {
        if (r.id === excludeId || r.status !== 'PENDING') return false;
        if (trackId && r.targetTrackId !== trackId) return false;
        const rRange = r.spliceDescriptor.snappedAcousticRange;
        return rRange.start < range.end && rRange.end > range.start;
      })
      .map((r) => r.id);
  }

  private recordTransaction(
    description: string,
    beforeTracks: TimelineTrack[],
    afterTracks: TimelineTrack[],
    invalidatedIds: RecommendationId[],
    coalescingKey?: string,
    acceptedRecommendationId?: RecommendationId,
    beforeRecommendations?: AIRecommendationRecord[],
    afterRecommendations?: AIRecommendationRecord[],
  ): EditTransaction {
    const nextRev = this.committedDoc.revision + 1;
    const tx: EditTransaction = {
      operationId: `tx_${nextRev}_${Date.now()}`,
      coalescingKey,
      projectRevisionBefore: this.committedDoc.revision,
      projectRevisionAfter: nextRev,
      timestamp: Date.now(),
      description,
      beforeTracksSnapshot: structuredClone(beforeTracks),
      afterTracksSnapshot: structuredClone(afterTracks),
      beforeRecommendationsSnapshot: beforeRecommendations
        ? structuredClone(beforeRecommendations)
        : undefined,
      afterRecommendationsSnapshot: afterRecommendations
        ? structuredClone(afterRecommendations)
        : undefined,
      acceptedRecommendationId,
      invalidatedRecommendationIds: invalidatedIds,
    };
    this.undoStack.push(tx);
    this.redoStack = [];
    return tx;
  }

  public undo(): ProjectDocument | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    this.redoStack.push(tx);
    this.ephemeralDoc = null;
    this.activeGestureKey = null;

    this.committedDoc = {
      ...this.committedDoc,
      revision: tx.projectRevisionBefore,
      tracks: structuredClone(tx.beforeTracksSnapshot),
      recommendations: tx.beforeRecommendationsSnapshot
        ? structuredClone(tx.beforeRecommendationsSnapshot)
        : this.committedDoc.recommendations.map((r) => {
            if (r.id === tx.acceptedRecommendationId) {
              return { ...r, status: 'PENDING', userDecisionTimestamp: undefined };
            }
            if (tx.invalidatedRecommendationIds.includes(r.id)) {
              return { ...r, status: 'PENDING' };
            }
            return r;
          }),
    };
    return this.committedDoc;
  }

  public redo(): ProjectDocument | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this.undoStack.push(tx);
    this.ephemeralDoc = null;
    this.activeGestureKey = null;

    this.committedDoc = {
      ...this.committedDoc,
      revision: tx.projectRevisionAfter,
      tracks: structuredClone(tx.afterTracksSnapshot),
      recommendations: tx.afterRecommendationsSnapshot
        ? structuredClone(tx.afterRecommendationsSnapshot)
        : this.committedDoc.recommendations.map((r) => {
            if (r.id === tx.acceptedRecommendationId) {
              return { ...r, status: 'ACCEPTED', userDecisionTimestamp: Date.now() };
            }
            if (tx.invalidatedRecommendationIds.includes(r.id)) {
              return { ...r, status: 'INVALIDATED' };
            }
            return r;
          }),
    };
    return this.committedDoc;
  }
}
