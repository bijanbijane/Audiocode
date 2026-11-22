/**
 * AVAPARDAZ — CONTROLLED AUDIO EDIT JOB STATE MACHINE (AVP-EXECUTION-001 Section 4)
 *
 * Enforces explicit, deterministic state transitions across the 3-engine editing lifecycle.
 * Illegal transitions are rejected with `IllegalJobStateTransitionError`.
 */

export type AudioEditJobStatus =
  | 'IDLE'
  | 'VALIDATING'
  | 'PREPARING_AUDIO'
  | 'TRANSCRIBING'
  | 'VALIDATING_TRANSCRIPT'
  | 'ANALYZING'
  | 'GENERATING_EDL'
  | 'WAITING_USER_APPROVAL'
  | 'RENDERING_PREVIEW'
  | 'PREVIEW_READY'
  | 'RENDERING_FINAL'
  | 'VALIDATING_OUTPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface AudioEditJob {
  readonly jobId: string;
  readonly sourceAudioHash: string;
  readonly status: AudioEditJobStatus;
  /** Clamped strictly to [0, 100] */
  readonly progress: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly transcriptId?: string;
  readonly editDecisionId?: string;
  readonly edlId?: string;
  readonly previewArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export class IllegalJobStateTransitionError extends Error {
  public readonly code = 'ILLEGAL_JOB_STATE_TRANSITION' as const;
  public readonly fromStatus: AudioEditJobStatus;
  public readonly toStatus: AudioEditJobStatus;

  constructor(fromStatus: AudioEditJobStatus, toStatus: AudioEditJobStatus) {
    super(`ILLEGAL_JOB_STATE_TRANSITION: Cannot transition job from ${fromStatus} to ${toStatus}.`);
    this.name = 'IllegalJobStateTransitionError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export const ALLOWED_JOB_TRANSITIONS: Readonly<
  Record<AudioEditJobStatus, readonly AudioEditJobStatus[]>
> = Object.freeze({
  IDLE: ['VALIDATING', 'CANCELLED', 'FAILED'],
  VALIDATING: ['PREPARING_AUDIO', 'FAILED', 'CANCELLED'],
  PREPARING_AUDIO: ['TRANSCRIBING', 'FAILED', 'CANCELLED'],
  TRANSCRIBING: ['VALIDATING_TRANSCRIPT', 'FAILED', 'CANCELLED'],
  VALIDATING_TRANSCRIPT: ['ANALYZING', 'FAILED', 'CANCELLED'],
  ANALYZING: ['GENERATING_EDL', 'FAILED', 'CANCELLED'],
  GENERATING_EDL: ['WAITING_USER_APPROVAL', 'FAILED', 'CANCELLED'],
  WAITING_USER_APPROVAL: [
    'WAITING_USER_APPROVAL',
    'RENDERING_PREVIEW',
    'RENDERING_FINAL',
    'FAILED',
    'CANCELLED',
  ],
  RENDERING_PREVIEW: ['PREVIEW_READY', 'WAITING_USER_APPROVAL', 'FAILED', 'CANCELLED'],
  PREVIEW_READY: [
    'WAITING_USER_APPROVAL',
    'RENDERING_PREVIEW',
    'RENDERING_FINAL',
    'FAILED',
    'CANCELLED',
  ],
  RENDERING_FINAL: ['VALIDATING_OUTPUT', 'FAILED', 'CANCELLED'],
  VALIDATING_OUTPUT: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['RENDERING_PREVIEW', 'WAITING_USER_APPROVAL'], // Allows re-review or previewing post-completion without corrupting history
  FAILED: [],
  CANCELLED: [],
});

export const STAGE_DEFAULT_PROGRESS: Readonly<Record<AudioEditJobStatus, number>> = Object.freeze({
  IDLE: 0,
  VALIDATING: 5,
  PREPARING_AUDIO: 12,
  TRANSCRIBING: 20,
  VALIDATING_TRANSCRIPT: 58,
  ANALYZING: 68,
  GENERATING_EDL: 78,
  WAITING_USER_APPROVAL: 82,
  RENDERING_PREVIEW: 86,
  PREVIEW_READY: 90,
  RENDERING_FINAL: 92,
  VALIDATING_OUTPUT: 98,
  COMPLETED: 100,
  FAILED: 0,
  CANCELLED: 0,
});

export function clampJobProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function isTerminalJobStatus(status: AudioEditJobStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

export function canTransitionJobStatus(
  from: AudioEditJobStatus,
  to: AudioEditJobStatus,
): boolean {
  return ALLOWED_JOB_TRANSITIONS[from].includes(to);
}

export function createInitialAudioEditJob(params: {
  readonly jobId: string;
  readonly sourceAudioHash?: string;
  readonly nowMs?: number;
}): AudioEditJob {
  const now = params.nowMs ?? Date.now();
  return Object.freeze({
    jobId: params.jobId,
    sourceAudioHash: params.sourceAudioHash ?? '',
    status: 'IDLE',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function transitionAudioEditJob(
  current: AudioEditJob,
  nextStatus: AudioEditJobStatus,
  patch?: {
    readonly progress?: number;
    readonly sourceAudioHash?: string;
    readonly transcriptId?: string;
    readonly editDecisionId?: string;
    readonly edlId?: string;
    readonly previewArtifactId?: string;
    readonly outputArtifactId?: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly nowMs?: number;
  },
): AudioEditJob {
  if (!canTransitionJobStatus(current.status, nextStatus)) {
    throw new IllegalJobStateTransitionError(current.status, nextStatus);
  }

  const nextProgress =
    patch?.progress !== undefined
      ? clampJobProgress(patch.progress)
      : nextStatus === 'FAILED' || nextStatus === 'CANCELLED'
        ? current.progress
        : Math.max(current.progress, STAGE_DEFAULT_PROGRESS[nextStatus]);

  return Object.freeze({
    ...current,
    sourceAudioHash: patch?.sourceAudioHash ?? current.sourceAudioHash,
    status: nextStatus,
    progress: clampJobProgress(nextProgress),
    updatedAt: patch?.nowMs ?? Date.now(),
    transcriptId: patch?.transcriptId ?? current.transcriptId,
    editDecisionId: patch?.editDecisionId ?? current.editDecisionId,
    edlId: patch?.edlId ?? current.edlId,
    previewArtifactId: patch?.previewArtifactId ?? current.previewArtifactId,
    outputArtifactId: patch?.outputArtifactId ?? current.outputArtifactId,
    errorCode: nextStatus === 'FAILED' ? (patch?.errorCode ?? current.errorCode) : undefined,
    errorMessage:
      nextStatus === 'FAILED' || nextStatus === 'CANCELLED'
        ? (patch?.errorMessage ?? current.errorMessage)
        : undefined,
  });
}

export function updateJobProgressInPlace(
  current: AudioEditJob,
  progress: number,
  nowMs = Date.now(),
): AudioEditJob {
  return Object.freeze({
    ...current,
    progress: clampJobProgress(progress),
    updatedAt: nowMs,
  });
}
