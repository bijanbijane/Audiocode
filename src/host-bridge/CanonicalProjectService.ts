/**
 * AVAPARDAZ — HOST-NEUTRAL CANONICAL PROJECT & NON-DESTRUCTIVE EDIT PLAN SERVICE
 *
 * Compliant with AVP-ARCH-001 (Version 4.0) Sections 10 & 11 (INV-001, INV-008):
 * - Host-neutral project, media identity (stable media_id + sha256 + separate storage_ref),
 *   tracks, clips, markers, integer sample positions + explicit sample_rate_hz.
 * - Strictly separates Analysis -> EditPlan Proposal -> Human Approval -> Commit -> Rollback.
 * - Enforces Concurrency & Stale-Revision Guard (Section 11.3): rejects committing any
 *   EditPlan whose base_project_revision != current project.revision (409 STALE_PROJECT_REVISION).
 * - Never overwrites original source media references; stores full pre-commit revision snapshots.
 */

import crypto from 'node:crypto';
import type { SampleRate } from '../contracts/timebase.contract';

export const CANONICAL_PROJECT_SCHEMA_VERSION = '2.0.0' as const;

export type MediaAvailabilityStatus = 'AVAILABLE' | 'MISSING' | 'MOVED' | 'UNAVAILABLE';

export interface CanonicalSourceMedia {
  readonly media_id: string;
  readonly display_name: string;
  readonly sha256_hex: string;
  readonly sample_rate_hz: SampleRate;
  readonly channel_count: number;
  readonly total_samples: number;
  readonly bit_depth: 16 | 24 | 32;
  readonly encoding: 'pcm' | 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm';
  /** Mutable storage/host path separated from permanent media_id identity (Section 10.2) */
  readonly storage_ref: string | null;
  readonly availability: MediaAvailabilityStatus;
  readonly registered_at: string;
}

export interface CanonicalClip {
  readonly clip_id: string;
  readonly media_id: string;
  /** Exact integer sample positions on the project timeline (Section 10.1) */
  readonly timeline_start_sample: number;
  readonly timeline_end_sample: number;
  /** Exact integer offset inside source media */
  readonly source_in_sample: number;
  readonly gain_db: number;
  readonly muted: boolean;
}

export interface CanonicalTrack {
  readonly track_id: string;
  readonly name: string;
  readonly speaker_label: string;
  readonly channel_count: 1 | 2;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly gain_db: number;
  readonly clips: readonly CanonicalClip[];
}

export interface CanonicalMarker {
  readonly marker_id: string;
  readonly label: string;
  readonly sample_position: number;
  readonly duration_samples: number;
  readonly kind: 'CHAPTER' | 'SPEECH_EVENT' | 'USER_CUE';
}

export type EditOperationAction = 'CUT_RANGE' | 'SHORTEN_SILENCE' | 'MUTE_RANGE' | 'ADD_MARKER';

export interface EditPlanItem {
  readonly item_id: string;
  readonly track_id: string;
  readonly action: EditOperationAction;
  readonly start_sample: number;
  readonly end_sample: number;
  readonly reason: string;
  readonly approved: boolean;
}

export type EditPlanStatus = 'PROPOSED' | 'APPROVED' | 'COMMITTED' | 'REJECTED' | 'STALE';

export interface CanonicalEditPlan {
  readonly plan_id: string;
  readonly project_id: string;
  readonly base_project_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: EditPlanStatus;
  readonly provenance_request_id: string | null;
  readonly items: readonly EditPlanItem[];
  readonly committed_revision: number | null;
}

export interface ProjectRevisionEntry {
  readonly revision: number;
  readonly timestamp: string;
  readonly summary: string;
  readonly plan_id: string | null;
  readonly tracks_snapshot: readonly CanonicalTrack[];
  readonly markers_snapshot: readonly CanonicalMarker[];
}

export interface CanonicalProject {
  readonly schema_version: typeof CANONICAL_PROJECT_SCHEMA_VERSION;
  readonly project_id: string;
  readonly name: string;
  readonly sample_rate_hz: SampleRate;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly media: Readonly<Record<string, CanonicalSourceMedia>>;
  readonly tracks: readonly CanonicalTrack[];
  readonly markers: readonly CanonicalMarker[];
  readonly edit_plans: Readonly<Record<string, CanonicalEditPlan>>;
  readonly revision_history: readonly ProjectRevisionEntry[];
}

export class ProjectServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'PROJECT_ALREADY_EXISTS'
      | 'PLAN_NOT_FOUND'
      | 'INVALID_PROJECT_INPUT'
      | 'STALE_PROJECT_REVISION'
      | 'PLAN_NOT_APPROVED'
      | 'PLAN_ALREADY_COMMITTED'
      | 'REVISION_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectServiceError';
  }
}

const ALLOWED_SAMPLE_RATES = new Set<number>([16000, 22050, 24000, 32000, 44100, 48000, 96000]);
const ALLOWED_EDIT_ACTIONS = new Set<EditOperationAction>([
  'CUT_RANGE',
  'SHORTEN_SILENCE',
  'MUTE_RANGE',
  'ADD_MARKER',
]);
const MAX_RETAINED_PROJECTS = 500;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeIdentifierKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !RESERVED_OBJECT_KEYS.has(value.trim());
}

export class CanonicalProjectService {
  private readonly projects = new Map<string, CanonicalProject>();

  public createProject(params: {
    readonly project_id?: string;
    readonly name: string;
    readonly sample_rate_hz: SampleRate;
    readonly tracks?: readonly CanonicalTrack[];
    readonly media?: readonly CanonicalSourceMedia[];
  }): CanonicalProject {
    if (!params || typeof params !== 'object') {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Project payload object is required.');
    }
    if (!params.name || typeof params.name !== 'string' || params.name.trim().length === 0) {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Project name is required.');
    }
    if (typeof params.sample_rate_hz !== 'number' || !ALLOWED_SAMPLE_RATES.has(params.sample_rate_hz)) {
      throw new ProjectServiceError(
        400,
        'INVALID_PROJECT_INPUT',
        'sample_rate_hz must be a supported Flicks-exact rate (16000, 22050, 24000, 32000, 44100, 48000, 96000).',
      );
    }
    if (params.project_id !== undefined && typeof params.project_id !== 'string') {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'project_id must be a string when provided.');
    }
    const projectId = params.project_id?.trim() || `proj_${crypto.randomBytes(6).toString('hex')}`;
    if (RESERVED_OBJECT_KEYS.has(projectId)) {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'project_id uses a reserved identifier.');
    }
    if (this.projects.has(projectId)) {
      throw new ProjectServiceError(
        409,
        'PROJECT_ALREADY_EXISTS',
        `Project "${projectId}" already exists.`,
      );
    }
    const nowIso = new Date().toISOString();

    const mediaMap: Record<string, CanonicalSourceMedia> = {};
    if (params.media !== undefined && !Array.isArray(params.media)) {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'media must be an array.');
    }
    for (const m of params.media ?? []) {
      if (!m || typeof m !== 'object' || !isSafeIdentifierKey(m.media_id)) {
        throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Each media entry requires a valid non-reserved media_id.');
      }
      mediaMap[m.media_id.trim()] = Object.freeze({ ...m, media_id: m.media_id.trim() });
    }

    if (params.tracks !== undefined && !Array.isArray(params.tracks)) {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'tracks must be an array.');
    }
    const initialTracks = (params.tracks ?? []).map((t) => {
      if (
        !t ||
        typeof t !== 'object' ||
        Array.isArray(t) ||
        typeof t.track_id !== 'string' ||
        t.track_id.trim().length === 0
      ) {
        throw new ProjectServiceError(
          400,
          'INVALID_PROJECT_INPUT',
          'Each track must be an object with a non-empty track_id.',
        );
      }
      if (!Array.isArray(t.clips)) {
        throw new ProjectServiceError(
          400,
          'INVALID_PROJECT_INPUT',
          `Track "${t.track_id}" must provide a clips array.`,
        );
      }
      const frozenClips = t.clips.map((c: CanonicalClip) => {
        if (
          !c ||
          typeof c !== 'object' ||
          Array.isArray(c) ||
          typeof c.clip_id !== 'string' ||
          c.clip_id.trim().length === 0 ||
          !Number.isInteger(c.timeline_start_sample) ||
          !Number.isInteger(c.timeline_end_sample) ||
          !Number.isInteger(c.source_in_sample) ||
          c.timeline_start_sample < 0 ||
          c.timeline_end_sample <= c.timeline_start_sample ||
          c.source_in_sample < 0
        ) {
          throw new ProjectServiceError(
            400,
            'INVALID_PROJECT_INPUT',
            `Track "${t.track_id}" contains an invalid clip definition.`,
          );
        }
        return Object.freeze({ ...c });
      });
      return Object.freeze({ ...t, clips: Object.freeze(frozenClips) });
    });
    const initialRevisionEntry: ProjectRevisionEntry = Object.freeze({
      revision: 1,
      timestamp: nowIso,
      summary: 'Initial project creation',
      plan_id: null,
      tracks_snapshot: initialTracks,
      markers_snapshot: [],
    });

    const project: CanonicalProject = Object.freeze({
      schema_version: CANONICAL_PROJECT_SCHEMA_VERSION,
      project_id: projectId,
      name: params.name.trim(),
      sample_rate_hz: params.sample_rate_hz,
      revision: 1,
      created_at: nowIso,
      updated_at: nowIso,
      media: Object.freeze(mediaMap),
      tracks: Object.freeze(initialTracks),
      markers: Object.freeze([]),
      edit_plans: Object.freeze({}),
      revision_history: Object.freeze([initialRevisionEntry]),
    });

    this.projects.set(projectId, project);
    while (this.projects.size > MAX_RETAINED_PROJECTS) {
      const oldestId = this.projects.keys().next().value;
      if (!oldestId) break;
      this.projects.delete(oldestId);
    }
    return project;
  }

  public getProject(projectId: string): CanonicalProject | null {
    return this.projects.get(projectId) ?? null;
  }

  public listProjects(): readonly CanonicalProject[] {
    return Object.freeze(Array.from(this.projects.values()));
  }

  public registerMedia(
    projectId: string,
    media: Omit<CanonicalSourceMedia, 'media_id' | 'registered_at'> & { readonly media_id?: string },
  ): CanonicalProject {
    const existing = this.projects.get(projectId);
    if (!existing) {
      throw new ProjectServiceError(404, 'PROJECT_NOT_FOUND', `Project "${projectId}" not found.`);
    }
    if (
      !media ||
      typeof media !== 'object' ||
      typeof media.sha256_hex !== 'string' ||
      media.sha256_hex.trim().length === 0 ||
      !Number.isInteger(media.total_samples) ||
      media.total_samples <= 0
    ) {
      throw new ProjectServiceError(
        400,
        'INVALID_PROJECT_INPUT',
        'Media registration requires non-empty sha256_hex and positive integer total_samples.',
      );
    }

    if (media.media_id !== undefined && !isSafeIdentifierKey(media.media_id)) {
      throw new ProjectServiceError(
        400,
        'INVALID_PROJECT_INPUT',
        'media_id must be a non-empty, non-reserved string when provided.',
      );
    }
    const mediaId =
      typeof media.media_id === 'string' && media.media_id.trim().length > 0
        ? media.media_id.trim()
        : `med_${crypto.randomBytes(5).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const record: CanonicalSourceMedia = Object.freeze({
      ...media,
      display_name:
        typeof media.display_name === 'string' && media.display_name.trim().length > 0
          ? media.display_name.trim()
          : mediaId,
      media_id: mediaId,
      registered_at: nowIso,
    });

    const nextRevision = existing.revision + 1;
    const updated: CanonicalProject = Object.freeze({
      ...existing,
      revision: nextRevision,
      updated_at: nowIso,
      media: Object.freeze({
        ...existing.media,
        [mediaId]: record,
      }),
      revision_history: Object.freeze([
        ...existing.revision_history,
        Object.freeze({
          revision: nextRevision,
          timestamp: nowIso,
          summary: `Registered media "${record.display_name}" (${mediaId})`,
          plan_id: null,
          tracks_snapshot: existing.tracks,
          markers_snapshot: existing.markers,
        }),
      ]),
    });

    this.projects.set(projectId, updated);
    return updated;
  }

  public createEditPlan(
    projectId: string,
    params: {
      readonly provenance_request_id?: string | null;
      readonly items: readonly Omit<EditPlanItem, 'item_id' | 'approved'>[];
    },
  ): CanonicalEditPlan {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectServiceError(404, 'PROJECT_NOT_FOUND', `Project "${projectId}" not found.`);
    }
    if (!params || !Array.isArray(params.items) || params.items.length === 0) {
      throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Edit plan must contain at least one item.');
    }

    for (const item of params.items) {
      if (!item || typeof item !== 'object') {
        throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Each edit plan item must be an object.');
      }
      if (typeof item.track_id !== 'string' || item.track_id.trim().length === 0) {
        throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Each edit plan item requires a non-empty track_id.');
      }
      if (!ALLOWED_EDIT_ACTIONS.has(item.action)) {
        throw new ProjectServiceError(
          400,
          'INVALID_PROJECT_INPUT',
          `Unsupported edit plan action "${String(item.action)}".`,
        );
      }
      if (
        !Number.isInteger(item.start_sample) ||
        !Number.isInteger(item.end_sample) ||
        item.start_sample < 0 ||
        item.end_sample <= item.start_sample
      ) {
        throw new ProjectServiceError(
          400,
          'INVALID_PROJECT_INPUT',
          `Invalid sample range [${item.start_sample}, ${item.end_sample}) in edit plan item.`,
        );
      }
      if (typeof item.reason !== 'string') {
        throw new ProjectServiceError(400, 'INVALID_PROJECT_INPUT', 'Each edit plan item requires a string reason.');
      }
    }

    const nowIso = new Date().toISOString();
    const planId = `plan_${crypto.randomBytes(5).toString('hex')}`;
    const plan: CanonicalEditPlan = Object.freeze({
      plan_id: planId,
      project_id: projectId,
      base_project_revision: project.revision,
      created_at: nowIso,
      updated_at: nowIso,
      status: 'PROPOSED',
      provenance_request_id: params.provenance_request_id ?? null,
      items: Object.freeze(
        params.items.map((it, idx) =>
          Object.freeze({
            ...it,
            item_id: `${planId}_item_${idx}`,
            approved: false,
          }),
        ),
      ),
      committed_revision: null,
    });

    const updatedProject: CanonicalProject = Object.freeze({
      ...project,
      edit_plans: Object.freeze({
        ...project.edit_plans,
        [planId]: plan,
      }),
    });
    this.projects.set(projectId, updatedProject);
    return plan;
  }

  public approveEditPlan(
    projectId: string,
    planId: string,
    approvedItemIds?: readonly string[],
  ): CanonicalEditPlan {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectServiceError(404, 'PROJECT_NOT_FOUND', `Project "${projectId}" not found.`);
    }
    const plan = Object.prototype.hasOwnProperty.call(project.edit_plans, planId)
      ? project.edit_plans[planId]
      : undefined;
    if (!plan) {
      throw new ProjectServiceError(404, 'PLAN_NOT_FOUND', `Edit plan "${planId}" not found.`);
    }
    if (plan.status === 'COMMITTED') {
      throw new ProjectServiceError(409, 'PLAN_ALREADY_COMMITTED', 'Edit plan has already been committed.');
    }
    if (plan.status === 'STALE' || project.revision !== plan.base_project_revision) {
      throw new ProjectServiceError(
        409,
        'STALE_PROJECT_REVISION',
        `Edit plan "${planId}" is stale (base revision ${plan.base_project_revision}, current ${project.revision}).`,
      );
    }

    if (
      approvedItemIds !== undefined &&
      (!Array.isArray(approvedItemIds) || approvedItemIds.some((id) => typeof id !== 'string'))
    ) {
      throw new ProjectServiceError(
        400,
        'INVALID_PROJECT_INPUT',
        'approvedItemIds must be an array of strings when provided.',
      );
    }

    const approvedSet = approvedItemIds ? new Set(approvedItemIds) : null;
    const updatedItems = plan.items.map((it) =>
      Object.freeze({
        ...it,
        approved: approvedSet ? approvedSet.has(it.item_id) : true,
      }),
    );

    const anyApproved = updatedItems.some((it) => it.approved);
    const updatedPlan: CanonicalEditPlan = Object.freeze({
      ...plan,
      status: anyApproved ? 'APPROVED' : 'REJECTED',
      updated_at: new Date().toISOString(),
      items: Object.freeze(updatedItems),
    });

    this.projects.set(
      projectId,
      Object.freeze({
        ...project,
        edit_plans: Object.freeze({
          ...project.edit_plans,
          [planId]: updatedPlan,
        }),
      }),
    );
    return updatedPlan;
  }

  /**
   * Non-destructive transactional commit with strict Stale-Project Revision Guard (Section 11.3).
   */
  public commitEditPlan(
    projectId: string,
    planId: string,
    expectedRevision?: number,
  ): { readonly project: CanonicalProject; readonly committed_plan: CanonicalEditPlan } {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectServiceError(404, 'PROJECT_NOT_FOUND', `Project "${projectId}" not found.`);
    }
    const plan = Object.prototype.hasOwnProperty.call(project.edit_plans, planId)
      ? project.edit_plans[planId]
      : undefined;
    if (!plan) {
      throw new ProjectServiceError(404, 'PLAN_NOT_FOUND', `Edit plan "${planId}" not found.`);
    }
    if (plan.status === 'COMMITTED') {
      throw new ProjectServiceError(409, 'PLAN_ALREADY_COMMITTED', 'Edit plan was already committed.');
    }
    if (plan.status !== 'APPROVED') {
      throw new ProjectServiceError(
        409,
        'PLAN_NOT_APPROVED',
        'Edit plan must be explicitly approved by the user before commit (AVP-ARCH-001 Section 11).',
      );
    }

    // Section 11.3 Concurrency & Stale Project Detection
    if (
      project.revision !== plan.base_project_revision ||
      (expectedRevision !== undefined && expectedRevision !== project.revision)
    ) {
      const stalePlan: CanonicalEditPlan = Object.freeze({
        ...plan,
        status: 'STALE',
        updated_at: new Date().toISOString(),
      });
      this.projects.set(
        projectId,
        Object.freeze({
          ...project,
          edit_plans: Object.freeze({
            ...project.edit_plans,
            [planId]: stalePlan,
          }),
        }),
      );
      throw new ProjectServiceError(
        409,
        'STALE_PROJECT_REVISION',
        `Project revision changed (${plan.base_project_revision} -> ${project.revision}). Refusing to apply stale edit plan "${planId}".`,
      );
    }

    const approvedItems = plan.items.filter((i) => i.approved);
    let nextTracks = project.tracks.map((t) => ({
      ...t,
      clips: [...t.clips],
    }));
    const nextMarkers = [...project.markers];

    for (const item of approvedItems) {
      if (item.action === 'ADD_MARKER') {
        nextMarkers.push(
          Object.freeze({
            marker_id: `mrk_${crypto.randomBytes(4).toString('hex')}`,
            label: item.reason,
            sample_position: item.start_sample,
            duration_samples: item.end_sample - item.start_sample,
            kind: 'SPEECH_EVENT',
          }),
        );
        continue;
      }

      // Non-destructive clip splitting/trimming around [start_sample, end_sample) — source media is untouched!
      nextTracks = nextTracks.map((track) => {
        if (track.track_id !== item.track_id) return track;
        const rewrittenClips: CanonicalClip[] = [];
        for (const clip of track.clips) {
          // No overlap
          if (clip.timeline_end_sample <= item.start_sample || clip.timeline_start_sample >= item.end_sample) {
            rewrittenClips.push(clip);
            continue;
          }
          if (item.action === 'MUTE_RANGE') {
            rewrittenClips.push(Object.freeze({ ...clip, muted: true }));
            continue;
          }
          // CUT_RANGE / SHORTEN_SILENCE: split non-destructively into left/right portions referencing original media
          if (clip.timeline_start_sample < item.start_sample) {
            rewrittenClips.push(
              Object.freeze({
                ...clip,
                clip_id: `${clip.clip_id}_L`,
                timeline_end_sample: item.start_sample,
              }),
            );
          }
          if (clip.timeline_end_sample > item.end_sample) {
            const deltaSamples = item.end_sample - clip.timeline_start_sample;
            rewrittenClips.push(
              Object.freeze({
                ...clip,
                clip_id: `${clip.clip_id}_R`,
                timeline_start_sample: item.end_sample,
                source_in_sample: clip.source_in_sample + Math.max(0, deltaSamples),
              }),
            );
          }
        }
        return { ...track, clips: rewrittenClips };
      });
    }

    const nowIso = new Date().toISOString();
    const nextRevision = project.revision + 1;
    const frozenTracks = Object.freeze(nextTracks.map((t) => Object.freeze({ ...t, clips: Object.freeze(t.clips) })));
    const frozenMarkers = Object.freeze(nextMarkers);

    const committedPlan: CanonicalEditPlan = Object.freeze({
      ...plan,
      status: 'COMMITTED',
      updated_at: nowIso,
      committed_revision: nextRevision,
    });

    const updatedProject: CanonicalProject = Object.freeze({
      ...project,
      revision: nextRevision,
      updated_at: nowIso,
      tracks: frozenTracks,
      markers: frozenMarkers,
      edit_plans: Object.freeze({
        ...project.edit_plans,
        [planId]: committedPlan,
      }),
      revision_history: Object.freeze([
        ...project.revision_history,
        Object.freeze({
          revision: nextRevision,
          timestamp: nowIso,
          summary: `Committed edit plan ${planId} (${approvedItems.length} approved operations)`,
          plan_id: planId,
          tracks_snapshot: frozenTracks,
          markers_snapshot: frozenMarkers,
        }),
      ]),
    });

    this.projects.set(projectId, updatedProject);
    return { project: updatedProject, committed_plan: committedPlan };
  }

  public rollbackToRevision(projectId: string, targetRevision: number): CanonicalProject {
    if (typeof targetRevision !== 'number' || !Number.isInteger(targetRevision) || targetRevision < 1) {
      throw new ProjectServiceError(
        400,
        'INVALID_PROJECT_INPUT',
        'targetRevision must be a positive integer.',
      );
    }
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectServiceError(404, 'PROJECT_NOT_FOUND', `Project "${projectId}" not found.`);
    }
    const target = project.revision_history.find((r) => r.revision === targetRevision);
    if (!target) {
      throw new ProjectServiceError(
        404,
        'REVISION_NOT_FOUND',
        `Revision ${targetRevision} does not exist for project "${projectId}".`,
      );
    }

    const nowIso = new Date().toISOString();
    const nextRevision = project.revision + 1;
    const rolledBack: CanonicalProject = Object.freeze({
      ...project,
      revision: nextRevision,
      updated_at: nowIso,
      tracks: target.tracks_snapshot,
      markers: target.markers_snapshot,
      revision_history: Object.freeze([
        ...project.revision_history,
        Object.freeze({
          revision: nextRevision,
          timestamp: nowIso,
          summary: `Compensating rollback to revision ${targetRevision}`,
          plan_id: null,
          tracks_snapshot: target.tracks_snapshot,
          markers_snapshot: target.markers_snapshot,
        }),
      ]),
    });

    this.projects.set(projectId, rolledBack);
    return rolledBack;
  }
}
