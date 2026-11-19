import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import {
  canBypassThrottle,
  isHeavyBackgroundSubsystem,
  SchedulerSubsystemKey,
  TaskConcurrencyLimits,
} from './TaskConcurrencyPolicy';
import { TaskPriority } from './TaskPriority';

export type TaskAdmissionDecision =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly state: 'QUEUE_SATURATED' | 'RESOURCE_LIMITED' | 'DUPLICATE_BLOCKED';
      readonly reason: string;
      readonly canResumeLater: boolean;
    };

export class TaskAdmissionController {
  private readonly memoryBudget: MemoryBudgetManager;
  private readonly limits: TaskConcurrencyLimits;

  constructor(
    limits: TaskConcurrencyLimits,
    memoryBudget: MemoryBudgetManager = getSharedMemoryBudgetManager(),
  ) {
    this.limits = limits;
    this.memoryBudget = memoryBudget;
  }

  public evaluateEnqueue(params: {
    readonly priority: TaskPriority;
    readonly subsystem: SchedulerSubsystemKey;
    readonly estimatedMemoryBytes: number;
    readonly currentQueueLength: number;
    readonly activeHeavyCount: number;
    readonly duplicateActiveOrQueued: boolean;
  }): TaskAdmissionDecision {
    if (params.duplicateActiveOrQueued) {
      return {
        admitted: false,
        state: 'DUPLICATE_BLOCKED',
        reason: 'A non-idempotent task with the same dedupeKey is already queued or running.',
        canResumeLater: true,
      };
    }

    if (params.currentQueueLength >= this.limits.maxQueueSize && !canBypassThrottle(params.priority)) {
      return {
        admitted: false,
        state: 'QUEUE_SATURATED',
        reason: `Task queue reached bounded limit (${this.limits.maxQueueSize}). Explicit backpressure applied.`,
        canResumeLater: true,
      };
    }

    const memSnap = this.memoryBudget.getSnapshot();
    if (
      memSnap.pressureLevel === 'emergency' &&
      !canBypassThrottle(params.priority) &&
      (params.priority === 'PREFETCH' ||
        params.priority === 'MAINTENANCE' ||
        isHeavyBackgroundSubsystem(params.subsystem))
    ) {
      return {
        admitted: false,
        state: 'RESOURCE_LIMITED',
        reason: 'Emergency memory pressure blocks background/prefetch tasks to protect playback and editing.',
        canResumeLater: true,
      };
    }

    if (params.estimatedMemoryBytes > 0) {
      const check = this.memoryBudget.canStartHeavyTask({
        estimatedBytes: params.estimatedMemoryBytes,
        optional: params.priority === 'PREFETCH' || params.priority === 'MAINTENANCE',
        activeHeavyTasks: isHeavyBackgroundSubsystem(params.subsystem) ? params.activeHeavyCount : 0,
      });
      if (!check.allowed && !canBypassThrottle(params.priority)) {
        return {
          admitted: false,
          state: 'RESOURCE_LIMITED',
          reason: check.reason ?? 'Memory admission denied.',
          canResumeLater: true,
        };
      }
    }

    return { admitted: true };
  }
}
