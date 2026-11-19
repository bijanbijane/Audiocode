import { TaskPriority } from './TaskPriority';

export type SchedulerSubsystemKey =
  | 'playback'
  | 'editing'
  | 'analysis'
  | 'asr'
  | 'render'
  | 'waveform'
  | 'maintenance';

export interface TaskConcurrencyLimits {
  readonly maxTotalConcurrent: number;
  readonly maxQueueSize: number;
  readonly perSubsystemMax: Readonly<Record<SchedulerSubsystemKey, number>>;
}

export const DEFAULT_TASK_CONCURRENCY_LIMITS: TaskConcurrencyLimits = {
  maxTotalConcurrent: 4,
  maxQueueSize: 64,
  perSubsystemMax: {
    playback: 2,
    editing: 2,
    analysis: 1,
    asr: 1,
    render: 1,
    waveform: 2,
    maintenance: 1,
  },
};

export function isHeavyBackgroundSubsystem(subsystem: SchedulerSubsystemKey): boolean {
  return subsystem === 'asr' || subsystem === 'render';
}

export function canBypassThrottle(priority: TaskPriority): boolean {
  return (
    priority === 'CRITICAL_INTERACTION' ||
    priority === 'AUDIO_PLAYBACK' ||
    priority === 'USER_EDIT'
  );
}
