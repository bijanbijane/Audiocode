import {
  AIRecommendationRecord,
  ProjectDocument,
  TimelineTrack,
  TrackId,
} from '../contracts/project-schema.contract';

export interface TrackMergeConflict {
  readonly trackId: TrackId;
  readonly trackName: string;
  readonly localTrackState: TimelineTrack | null;
  readonly incomingTrackState: TimelineTrack | null;
  readonly reasonFa: string;
}

export interface ThreeWayMergeResult {
  readonly mergedCleanly: boolean;
  readonly mergedDocument: ProjectDocument;
  /** Recovery copy preserving incoming branch untouched when conflicts exist (Section 48) */
  readonly conflictRecoveryCopy: ProjectDocument | null;
  readonly conflicts: TrackMergeConflict[];
}

/**
 * Three-Way Project Merge & Conflict Recovery Engine (Sections 7 Domain 7 & 48)
 * Merges non-overlapping track and recommendation edits between Base Ancestor, Local Branch,
 * and Incoming Branch cleanly, and preserves a Conflict Recovery Copy on concurrent same-track edits.
 */
export class ProjectThreeWayMergeEngine {
  public static mergeProjectBranches(
    baseAncestor: ProjectDocument,
    localBranch: ProjectDocument,
    incomingBranch: ProjectDocument,
  ): ThreeWayMergeResult {
    const baseTracksMap = new Map<TrackId, string>(
      baseAncestor.tracks.map((t) => [t.id, JSON.stringify(t)]),
    );
    const localTracksMap = new Map<TrackId, TimelineTrack>(
      localBranch.tracks.map((t) => [t.id, t]),
    );
    const incomingTracksMap = new Map<TrackId, TimelineTrack>(
      incomingBranch.tracks.map((t) => [t.id, t]),
    );

    const allTrackIds = new Set<TrackId>([
      ...baseTracksMap.keys(),
      ...localTracksMap.keys(),
      ...incomingTracksMap.keys(),
    ]);

    const mergedTracks: TimelineTrack[] = [];
    const conflicts: TrackMergeConflict[] = [];

    for (const trackId of allTrackIds) {
      const baseSerialized = baseTracksMap.get(trackId);
      const localTrack = localTracksMap.get(trackId);
      const incomingTrack = incomingTracksMap.get(trackId);

      const localSerialized = localTrack ? JSON.stringify(localTrack) : undefined;
      const incomingSerialized = incomingTrack ? JSON.stringify(incomingTrack) : undefined;

      // 1. Both branches agree (including both deleted or identical edits)
      if (localSerialized === incomingSerialized) {
        if (localTrack) mergedTracks.push(structuredClone(localTrack));
        continue;
      }

      // 2. Only local branch modified/added/deleted this track relative to base -> keep local
      if (incomingSerialized === baseSerialized) {
        if (localTrack) mergedTracks.push(structuredClone(localTrack));
        continue;
      }

      // 3. Only incoming branch modified/added/deleted this track relative to base -> accept incoming
      if (localSerialized === baseSerialized) {
        if (incomingTrack) mergedTracks.push(structuredClone(incomingTrack));
        continue;
      }

      // 4. Both branches modified or deleted the same track differently -> record conflict, keep local
      const trackLabel = localTrack?.name ?? incomingTrack?.name ?? trackId;
      conflicts.push({
        trackId,
        trackName: trackLabel,
        localTrackState: localTrack ? structuredClone(localTrack) : null,
        incomingTrackState: incomingTrack ? structuredClone(incomingTrack) : null,
        reasonFa: `ترک «${trackLabel}» در هر دو نسخه به شکل متفاوتی ویرایش شده است.`,
      });
      if (localTrack) {
        mergedTracks.push(structuredClone(localTrack));
      }
    }

    const mergedRecommendations = this.mergeRecommendations(
      baseAncestor.recommendations,
      localBranch.recommendations,
      incomingBranch.recommendations,
    );

    // Three-way merge project name cleanly
    const mergedName =
      localBranch.name === baseAncestor.name && incomingBranch.name !== baseAncestor.name
        ? incomingBranch.name
        : localBranch.name;

    const nextRevision = Math.max(localBranch.revision, incomingBranch.revision) + 1;
    const mergedDocument: ProjectDocument = {
      ...structuredClone(localBranch),
      name: mergedName,
      revision: nextRevision,
      tracks: mergedTracks,
      recommendations: mergedRecommendations,
    };

    const conflictRecoveryCopy: ProjectDocument | null =
      conflicts.length > 0
        ? {
            ...structuredClone(incomingBranch),
            projectId: `${incomingBranch.projectId}_recovery_${Date.now()}`,
            name: `${incomingBranch.name} (نسخه بازیابی تعارض)`,
          }
        : null;

    return {
      mergedCleanly: conflicts.length === 0,
      mergedDocument,
      conflictRecoveryCopy,
      conflicts,
    };
  }

  private static mergeRecommendations(
    baseRecs: readonly AIRecommendationRecord[],
    localRecs: readonly AIRecommendationRecord[],
    incomingRecs: readonly AIRecommendationRecord[],
  ): AIRecommendationRecord[] {
    const baseMap = new Map<string, AIRecommendationRecord>(baseRecs.map((r) => [r.id, r]));
    const localMap = new Map<string, AIRecommendationRecord>(localRecs.map((r) => [r.id, r]));
    const incomingMap = new Map<string, AIRecommendationRecord>(
      incomingRecs.map((r) => [r.id, r]),
    );

    const allIds = new Set<string>([
      ...localMap.keys(),
      ...incomingMap.keys(),
    ]);

    const merged: AIRecommendationRecord[] = [];
    for (const id of allIds) {
      const baseRec = baseMap.get(id);
      const localRec = localMap.get(id);
      const incRec = incomingMap.get(id);

      if (localRec && !incRec) {
        if (!baseRec) merged.push(structuredClone(localRec));
        else if (JSON.stringify(localRec) !== JSON.stringify(baseRec)) {
          merged.push(structuredClone(localRec));
        }
        continue;
      }
      if (!localRec && incRec) {
        if (!baseRec) merged.push(structuredClone(incRec));
        else if (JSON.stringify(incRec) !== JSON.stringify(baseRec)) {
          merged.push(structuredClone(incRec));
        }
        continue;
      }
      if (!localRec || !incRec) continue;

      if (localRec.status === 'PENDING' && incRec.status !== 'PENDING') {
        merged.push(structuredClone(incRec));
      } else {
        merged.push(structuredClone(localRec));
      }
    }

    return merged;
  }
}
