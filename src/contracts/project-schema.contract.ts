import { AssetId } from './storage-broker.contract';
import { Flicks, SampleRate, TimeRange } from './timebase.contract';
import { DisfluencyType, SmartSpliceDescriptor } from './persian-editing.contract';

export type TrackId = string;
export type ClipId = string;
export type SyncGroupId = string;
export type OperationId = string;
export type RecommendationId = string;

/** Four independent project versions (Architecture Doc Section 21) */
export interface ProjectVersionMatrix {
  readonly projectSchemaVersion: number;
  readonly audioEngineVersion: string;
  readonly processingNodeCatalogVersion: string;
  readonly activeModelBundleVersion: string;
}

export type ClipKind = 'AUDIO_ASSET' | 'ROOM_TONE_FILL';

/** Non-destructive timeline clip (Principles 6 & 22) */
export interface TimelineClip {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly kind: ClipKind;
  readonly assetId: AssetId;
  /** Source media time range [start, end) in Flicks */
  readonly sourceRange: TimeRange;
  /** Project timeline placement range [start, end) in Flicks */
  readonly timelineRange: TimeRange;
  readonly fadeInFlicks: Flicks;
  readonly fadeOutFlicks: Flicks;
  readonly gainDb: number;
}

export interface TimelineTrack {
  readonly id: TrackId;
  readonly name: string;
  /** Sync group for multi-microphone podcasts/interviews (Section 24) */
  readonly syncGroupId: SyncGroupId | null;
  readonly speakerId: string | null;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly clips: TimelineClip[]; // Always sorted by timelineRange.start
}

/** Smart recommendation lifecycle (Section 37) */
export type RecommendationStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'SUPERSEDED'
  | 'INVALIDATED';

export interface AIRecommendationRecord {
  readonly id: RecommendationId;
  readonly targetTrackId: TrackId;
  readonly disfluencyType: DisfluencyType;
  readonly associatedText: string;
  readonly spliceDescriptor: SmartSpliceDescriptor;
  readonly status: RecommendationStatus;
  readonly createdAtProjectRevision: number;
  readonly userDecisionTimestamp?: number;
  readonly rejectionReason?: string;
}

/** Edit transaction structure for Undo/Redo (Section 25) */
export interface EditTransaction {
  readonly operationId: OperationId;
  readonly coalescingKey?: string;
  readonly projectRevisionBefore: number;
  readonly projectRevisionAfter: number;
  readonly timestamp: number;
  readonly description: string;
  readonly beforeTracksSnapshot: TimelineTrack[];
  readonly afterTracksSnapshot: TimelineTrack[];
  readonly beforeRecommendationsSnapshot?: AIRecommendationRecord[];
  readonly afterRecommendationsSnapshot?: AIRecommendationRecord[];
  readonly acceptedRecommendationId?: RecommendationId;
  readonly invalidatedRecommendationIds: RecommendationId[];
}

export interface ProjectDocument {
  readonly projectId: string;
  readonly name: string;
  readonly canonicalSampleRate: SampleRate;
  readonly versions: ProjectVersionMatrix;
  readonly revision: number;
  readonly tracks: TimelineTrack[];
  readonly recommendations: AIRecommendationRecord[];
}
