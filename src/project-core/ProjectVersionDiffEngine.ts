import {
  ProjectDocument,
  RecommendationId,
  TimelineClip,
  TrackId,
} from '../contracts/project-schema.contract';
import { Flicks, TimeMath, TimeRange } from '../contracts/timebase.contract';

export interface DeletedSourceSpanDiff {
  readonly diffId: string;
  readonly trackId: TrackId;
  readonly assetId: string;
  /** Source media time range present in older revision but removed in newer revision */
  readonly deletedSourceRange: TimeRange;
  readonly durationRemovedSeconds: number;
  readonly associatedRecommendationId?: RecommendationId;
  readonly associatedTextFa?: string;
}

export interface ProjectVersionComparisonReport {
  readonly olderRevision: number;
  readonly newerRevision: number;
  readonly olderTotalDurationSeconds: number;
  readonly newerTotalDurationSeconds: number;
  readonly netTimeSavedSeconds: number;
  readonly deletedSourceSpans: DeletedSourceSpanDiff[];
  readonly newlyAcceptedRecommendationsCount: number;
}

/**
 * Project Version Diff & Non-Linear Cherry-Pick Restore Engine (Sections 2.5, 15 & 21)
 * Computes exact source-media spans removed between any two project revisions and allows
 * selectively restoring a historical cut without undoing subsequent timeline edits.
 */
export class ProjectVersionDiffEngine {
  /**
   * Computes structural and temporal differences between an older and newer project revision.
   */
  public static compareProjectVersions(
    olderDoc: ProjectDocument,
    newerDoc: ProjectDocument,
  ): ProjectVersionComparisonReport {
    const olderDurSec = this.computeProjectTotalDurationSeconds(olderDoc);
    const newerDurSec = this.computeProjectTotalDurationSeconds(newerDoc);

    const deletedSourceSpans: DeletedSourceSpanDiff[] = [];

    for (const oldTrack of olderDoc.tracks) {
      const newTrack = newerDoc.tracks.find((t) => t.id === oldTrack.id);
      if (!newTrack) continue;

      const oldAudioClips = oldTrack.clips.filter((c) => c.kind === 'AUDIO_ASSET');
      const newAudioClips = newTrack.clips.filter((c) => c.kind === 'AUDIO_ASSET');

      for (const oldClip of oldAudioClips) {
        const uncoveredRanges = this.subtractCoveredSourceRanges(
          oldClip.sourceRange,
          newAudioClips
            .filter((nc) => nc.assetId === oldClip.assetId)
            .map((nc) => nc.sourceRange),
        );

        for (const uncov of uncoveredRanges) {
          const durSec = TimeMath.flicksToSeconds(uncov.end - uncov.start);
          if (durSec < 0.015) continue; // Ignore sub-15ms micro-trims

          const matchedRec = newerDoc.recommendations.find(
            (r) =>
              r.status === 'ACCEPTED' &&
              r.targetTrackId === oldTrack.id &&
              Math.abs(r.spliceDescriptor.snappedAcousticRange.start - uncov.start) <
                TimeMath.secondsToFlicks(0.5),
          );

          deletedSourceSpans.push({
            diffId: `diff_${oldTrack.id}_${uncov.start}`,
            trackId: oldTrack.id,
            assetId: oldClip.assetId,
            deletedSourceRange: uncov,
            durationRemovedSeconds: Number(durSec.toFixed(2)),
            associatedRecommendationId: matchedRec?.id,
            associatedTextFa: matchedRec?.associatedText,
          });
        }
      }
    }

    const oldAcceptedCount = olderDoc.recommendations.filter(
      (r) => r.status === 'ACCEPTED',
    ).length;
    const newAcceptedCount = newerDoc.recommendations.filter(
      (r) => r.status === 'ACCEPTED',
    ).length;

    return {
      olderRevision: olderDoc.revision,
      newerRevision: newerDoc.revision,
      olderTotalDurationSeconds: Number(olderDurSec.toFixed(2)),
      newerTotalDurationSeconds: Number(newerDurSec.toFixed(2)),
      netTimeSavedSeconds: Number(Math.max(0, olderDurSec - newerDurSec).toFixed(2)),
      deletedSourceSpans,
      newlyAcceptedRecommendationsCount: Math.max(0, newAcceptedCount - oldAcceptedCount),
    };
  }

  /**
   * Restores a specific deleted source span back into the current project timeline
   * while preserving all later edits (shifting subsequent clips right by the restored span duration).
   */
  public static cherryPickRestoreDeletedSpan(
    currentDoc: ProjectDocument,
    spanToRestore: DeletedSourceSpanDiff,
  ): ProjectDocument {
    const restoreDuration: Flicks =
      spanToRestore.deletedSourceRange.end - spanToRestore.deletedSourceRange.start;
    const defaultFade = TimeMath.secondsToFlicks(0.008);

    const updatedTracks = currentDoc.tracks.map((track) => {
      if (track.id !== spanToRestore.trackId) return track;

      const updatedClips: TimelineClip[] = [];
      let restoredInserted = false;
      let shiftRightOffset: Flicks = 0;

      for (const clip of track.clips) {
        if (
          !restoredInserted &&
          clip.kind === 'AUDIO_ASSET' &&
          clip.assetId === spanToRestore.assetId &&
          clip.sourceRange.start >= spanToRestore.deletedSourceRange.end
        ) {
          const insertTimelineStart = clip.timelineRange.start;
          updatedClips.push({
            id: `restored_${spanToRestore.deletedSourceRange.start}`,
            trackId: track.id,
            kind: 'AUDIO_ASSET',
            assetId: spanToRestore.assetId,
            sourceRange: { ...spanToRestore.deletedSourceRange },
            timelineRange: {
              start: insertTimelineStart,
              end: insertTimelineStart + restoreDuration,
            },
            fadeInFlicks: defaultFade,
            fadeOutFlicks: defaultFade,
            gainDb: clip.gainDb,
          });
          restoredInserted = true;
          shiftRightOffset = restoreDuration;
        }

        updatedClips.push({
          ...clip,
          timelineRange: {
            start: clip.timelineRange.start + shiftRightOffset,
            end: clip.timelineRange.end + shiftRightOffset,
          },
        });
      }

      if (!restoredInserted) {
        const lastEnd =
          updatedClips.length > 0
            ? updatedClips[updatedClips.length - 1].timelineRange.end
            : 0;
        updatedClips.push({
          id: `restored_${spanToRestore.deletedSourceRange.start}`,
          trackId: track.id,
          kind: 'AUDIO_ASSET',
          assetId: spanToRestore.assetId,
          sourceRange: { ...spanToRestore.deletedSourceRange },
          timelineRange: {
            start: lastEnd,
            end: lastEnd + restoreDuration,
          },
          fadeInFlicks: defaultFade,
          fadeOutFlicks: defaultFade,
          gainDb: 0,
        });
      }

      return { ...track, clips: updatedClips };
    });

    return {
      ...currentDoc,
      revision: currentDoc.revision + 1,
      tracks: updatedTracks,
    };
  }

  private static subtractCoveredSourceRanges(
    baseRange: TimeRange,
    coveredRanges: TimeRange[],
  ): TimeRange[] {
    let remaining: TimeRange[] = [{ ...baseRange }];

    for (const cov of coveredRanges) {
      const nextRemaining: TimeRange[] = [];
      for (const rem of remaining) {
        if (cov.end <= rem.start || cov.start >= rem.end) {
          nextRemaining.push(rem);
          continue;
        }
        if (cov.start > rem.start) {
          nextRemaining.push({ start: rem.start, end: cov.start });
        }
        if (cov.end < rem.end) {
          nextRemaining.push({ start: cov.end, end: rem.end });
        }
      }
      remaining = nextRemaining;
    }

    return remaining;
  }

  private static computeProjectTotalDurationSeconds(doc: ProjectDocument): number {
    let maxEndFlicks = 0;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.timelineRange.end > maxEndFlicks) {
          maxEndFlicks = clip.timelineRange.end;
        }
      }
    }
    return TimeMath.flicksToSeconds(maxEndFlicks);
  }
}
