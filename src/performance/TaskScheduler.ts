import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import { TaskAdmissionController } from './TaskAdmissionController';
import {
  DEFAULT_TASK_CONCURRENCY_LIMITS,
  isHeavyBackgroundSubsystem,
  SchedulerSubsystemKey,
  TaskConcurrencyLimits,
} from './TaskConcurrencyPolicy';
import { compareTaskPriority, TaskPriority } from './TaskPriority';

export interface ScheduledTaskRequest<T> {
  readonly taskId?: string;
  readonly priority: TaskPriority;
  readonly subsystem: SchedulerSubsystemKey;
  readonly idempotent: boolean;
  readonly dedupeKey?: string;
  readonly estimatedMemoryBytes?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly run: (ctx: { readonly signal: AbortSignal }) => Promise<T> | T;
}

export type TaskSubmissionResult<T> =
  | {
      readonly accepted: true;
      readonly taskId: string;
      readonly promise: Promise<T>;
      readonly cancel: () => boolean;
      readonly reprioritize: (nextPriority: TaskPriority) => boolean;
    }
  | {
      readonly accepted: false;
      readonly state: 'QUEUE_SATURATED' | 'RESOURCE_LIMITED' | 'DUPLICATE_BLOCKED';
      readonly reason: string;
      readonly canResumeLater: boolean;
    };

interface QueuedTaskEntry {
  readonly taskId: string;
  priority: TaskPriority;
  readonly subsystem: SchedulerSubsystemKey;
  readonly idempotent: boolean;
  readonly dedupeKey: string | null;
  readonly estimatedMemoryBytes: number;
  readonly enqueuedOrder: number;
  readonly deadlineAtMs: number | null;
  readonly abortController: AbortController;
  readonly run: (ctx: { readonly signal: AbortSignal }) => Promise<unknown> | unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export interface TaskSchedulerSnapshot {
  readonly queuedCount: number;
  readonly activeCount: number;
  readonly activeHeavyCount: number;
  readonly maxQueueSize: number;
  readonly completedCount: number;
  readonly cancelledCount: number;
  readonly rejectedBackpressureCount: number;
}

/**
 * Priority-Aware, Bounded, Backpressure-Safe Task Scheduler (AVP-P11-001 Section 4)
 * - Guarantees interactive & playback tasks preempt background ASR/rendering.
 * - Prevents competing heavy ASR + Render jobs without resource admission.
 * - Never silently discards user tasks: returns explicit QUEUE_SATURATED / RESOURCE_LIMITED state.
 */
export class TaskScheduler {
  private readonly limits: TaskConcurrencyLimits;
  private readonly admission: TaskAdmissionController;
  private readonly queue: QueuedTaskEntry[] = [];
  private readonly active = new Map<string, QueuedTaskEntry>();
  private readonly activeBySubsystem = new Map<SchedulerSubsystemKey, number>();
  private readonly activeOrQueuedDedupe = new Set<string>();

  private orderSeq = 0;
  private taskSeq = 0;
  private completedCount = 0;
  private cancelledCount = 0;
  private rejectedBackpressureCount = 0;

  constructor(options?: {
    readonly limits?: Partial<TaskConcurrencyLimits>;
    readonly memoryBudget?: MemoryBudgetManager;
  }) {
    const rawMaxConc = options?.limits?.maxTotalConcurrent ?? DEFAULT_TASK_CONCURRENCY_LIMITS.maxTotalConcurrent;
    const rawMaxQueue = options?.limits?.maxQueueSize ?? DEFAULT_TASK_CONCURRENCY_LIMITS.maxQueueSize;
    this.limits = {
      maxTotalConcurrent: Number.isFinite(rawMaxConc)
        ? Math.max(1, Math.floor(rawMaxConc))
        : DEFAULT_TASK_CONCURRENCY_LIMITS.maxTotalConcurrent,
      maxQueueSize: Number.isFinite(rawMaxQueue)
        ? Math.max(1, Math.floor(rawMaxQueue))
        : DEFAULT_TASK_CONCURRENCY_LIMITS.maxQueueSize,
      perSubsystemMax: {
        ...DEFAULT_TASK_CONCURRENCY_LIMITS.perSubsystemMax,
        ...(options?.limits?.perSubsystemMax ?? {}),
      },
    };
    this.admission = new TaskAdmissionController(
      this.limits,
      options?.memoryBudget ?? getSharedMemoryBudgetManager(),
    );
  }

  public getSnapshot(): TaskSchedulerSnapshot {
    let activeHeavyCount = 0;
    for (const item of this.active.values()) {
      if (isHeavyBackgroundSubsystem(item.subsystem)) activeHeavyCount += 1;
    }
    return {
      queuedCount: this.queue.length,
      activeCount: this.active.size,
      activeHeavyCount,
      maxQueueSize: this.limits.maxQueueSize,
      completedCount: this.completedCount,
      cancelledCount: this.cancelledCount,
      rejectedBackpressureCount: this.rejectedBackpressureCount,
    };
  }

  public submit<T>(request: ScheduledTaskRequest<T>): TaskSubmissionResult<T> {
    const dedupeKey = !request.idempotent && request.dedupeKey ? request.dedupeKey : null;
    const duplicate = dedupeKey !== null && this.activeOrQueuedDedupe.has(dedupeKey);
    const snap = this.getSnapshot();

    const safeEstimatedMemBytes =
      typeof request.estimatedMemoryBytes === 'number' &&
      Number.isFinite(request.estimatedMemoryBytes) &&
      request.estimatedMemoryBytes > 0
        ? request.estimatedMemoryBytes
        : 0;
    const decision = this.admission.evaluateEnqueue({
      priority: request.priority,
      subsystem: request.subsystem,
      estimatedMemoryBytes: safeEstimatedMemBytes,
      currentQueueLength: this.queue.length,
      activeHeavyCount: snap.activeHeavyCount,
      duplicateActiveOrQueued: duplicate,
    });

    if (!decision.admitted) {
      this.rejectedBackpressureCount += 1;
      return {
        accepted: false,
        state: decision.state,
        reason: decision.reason,
        canResumeLater: decision.canResumeLater,
      };
    }

    const taskId = request.taskId ?? `task_${++this.taskSeq}`;
    const abortController = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        abortController.abort(request.signal.reason);
      } else {
        request.signal.addEventListener('abort', () => this.cancelTask(taskId), { once: true });
      }
    }

    let resolveFn!: (v: unknown) => void;
    let rejectFn!: (r: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveFn = (v) => resolve(v as T);
      rejectFn = reject;
    });

    const entry: QueuedTaskEntry = {
      taskId,
      priority: request.priority,
      subsystem: request.subsystem,
      idempotent: request.idempotent,
      dedupeKey,
      estimatedMemoryBytes: safeEstimatedMemBytes,
      enqueuedOrder: ++this.orderSeq,
      deadlineAtMs:
        typeof request.deadlineMs === 'number' &&
        Number.isFinite(request.deadlineMs) &&
        request.deadlineMs > 0
          ? Date.now() + request.deadlineMs
          : null,
      abortController,
      run: request.run,
      resolve: resolveFn,
      reject: rejectFn,
    };

    if (dedupeKey) {
      this.activeOrQueuedDedupe.add(dedupeKey);
    }

    if (abortController.signal.aborted) {
      this.cleanupDedupe(entry);
      this.cancelledCount += 1;
      entry.reject(new Error(`Task "${taskId}" cancelled before scheduling.`));
    } else {
      this.insertSorted(entry);
      this.pump();
    }

    return {
      accepted: true,
      taskId,
      promise,
      cancel: () => this.cancelTask(taskId),
      reprioritize: (nextPriority: TaskPriority) => this.reprioritizeTask(taskId, nextPriority),
    };
  }

  public cancelTask(taskId: string): boolean {
    const qIdx = this.queue.findIndex((t) => t.taskId === taskId);
    if (qIdx >= 0) {
      const [removed] = this.queue.splice(qIdx, 1);
      removed.abortController.abort('CANCELLED');
      this.cleanupDedupe(removed);
      this.cancelledCount += 1;
      removed.reject(new Error(`Task "${taskId}" cancelled while queued.`));
      return true;
    }

    const running = this.active.get(taskId);
    if (running) {
      running.abortController.abort('CANCELLED');
      return true;
    }
    return false;
  }

  public reprioritizeTask(taskId: string, nextPriority: TaskPriority): boolean {
    const qIdx = this.queue.findIndex((t) => t.taskId === taskId);
    if (qIdx < 0) return false;
    const [entry] = this.queue.splice(qIdx, 1);
    entry.priority = nextPriority;
    this.insertSorted(entry);
    this.pump();
    return true;
  }

  public cancelAllByPriority(priority: TaskPriority): number {
    let count = 0;
    for (const item of [...this.queue]) {
      if (item.priority === priority && this.cancelTask(item.taskId)) {
        count += 1;
      }
    }
    return count;
  }

  private insertSorted(entry: QueuedTaskEntry): void {
    let idx = this.queue.length;
    for (let i = 0; i < this.queue.length; i += 1) {
      const cmp = compareTaskPriority(entry.priority, this.queue[i].priority);
      if (cmp < 0 || (cmp === 0 && entry.enqueuedOrder < this.queue[i].enqueuedOrder)) {
        idx = i;
        break;
      }
    }
    this.queue.splice(idx, 0, entry);
  }

  private pump(): void {
    while (this.active.size < this.limits.maxTotalConcurrent && this.queue.length > 0) {
      const nextIndex = this.findNextEligibleIndex();
      if (nextIndex < 0) break;

      const [entry] = this.queue.splice(nextIndex, 1);

      // Deadline check
      if (entry.deadlineAtMs !== null && Date.now() > entry.deadlineAtMs) {
        this.cleanupDedupe(entry);
        entry.reject(new Error(`Task "${entry.taskId}" missed deadline before execution.`));
        continue;
      }

      if (entry.abortController.signal.aborted) {
        this.cleanupDedupe(entry);
        this.cancelledCount += 1;
        entry.reject(new Error(`Task "${entry.taskId}" was cancelled.`));
        continue;
      }

      this.startEntry(entry);
    }
  }

  private findNextEligibleIndex(): number {
    let activeHeavy = 0;
    for (const running of this.active.values()) {
      if (isHeavyBackgroundSubsystem(running.subsystem)) activeHeavy += 1;
    }

    for (let i = 0; i < this.queue.length; i += 1) {
      const candidate = this.queue[i];
      const subActive = this.activeBySubsystem.get(candidate.subsystem) ?? 0;
      const subMax = this.limits.perSubsystemMax[candidate.subsystem] ?? 1;
      if (subActive >= subMax) continue;
      // Do not allow simultaneous ASR + Render heavy tasks without explicit headroom
      if (isHeavyBackgroundSubsystem(candidate.subsystem) && activeHeavy >= 1) continue;
      return i;
    }
    return -1;
  }

  private startEntry(entry: QueuedTaskEntry): void {
    this.active.set(entry.taskId, entry);
    this.activeBySubsystem.set(
      entry.subsystem,
      (this.activeBySubsystem.get(entry.subsystem) ?? 0) + 1,
    );

    Promise.resolve()
      .then(() => entry.run({ signal: entry.abortController.signal }))
      .then(
        (result) => {
          this.finishEntry(entry);
          this.completedCount += 1;
          entry.resolve(result);
          this.pump();
        },
        (err) => {
          this.finishEntry(entry);
          if (entry.abortController.signal.aborted) {
            this.cancelledCount += 1;
          }
          entry.reject(err);
          this.pump();
        },
      );
  }

  private finishEntry(entry: QueuedTaskEntry): void {
    this.active.delete(entry.taskId);
    const prev = this.activeBySubsystem.get(entry.subsystem) ?? 1;
    this.activeBySubsystem.set(entry.subsystem, Math.max(0, prev - 1));
    this.cleanupDedupe(entry);
  }

  private cleanupDedupe(entry: QueuedTaskEntry): void {
    if (entry.dedupeKey) {
      this.activeOrQueuedDedupe.delete(entry.dedupeKey);
    }
  }
}
