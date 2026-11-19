/**
 * Priority Hierarchy for Avapardaz Task Scheduler (AVP-P11-001 Section 4)
 * Lower numeric rank executes first so playback and user edits are never starved by background jobs.
 */

export type TaskPriority =
  | 'CRITICAL_INTERACTION'
  | 'AUDIO_PLAYBACK'
  | 'USER_EDIT'
  | 'FOREGROUND_ANALYSIS'
  | 'BACKGROUND_ASR'
  | 'BACKGROUND_RENDER'
  | 'PREFETCH'
  | 'MAINTENANCE';

export const TASK_PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  CRITICAL_INTERACTION: 0,
  AUDIO_PLAYBACK: 1,
  USER_EDIT: 2,
  FOREGROUND_ANALYSIS: 3,
  BACKGROUND_ASR: 4,
  BACKGROUND_RENDER: 5,
  PREFETCH: 6,
  MAINTENANCE: 7,
};

export function compareTaskPriority(a: TaskPriority, b: TaskPriority): number {
  return TASK_PRIORITY_RANK[a] - TASK_PRIORITY_RANK[b];
}

export function isInteractivePriority(priority: TaskPriority): boolean {
  return (
    priority === 'CRITICAL_INTERACTION' ||
    priority === 'AUDIO_PLAYBACK' ||
    priority === 'USER_EDIT'
  );
}
