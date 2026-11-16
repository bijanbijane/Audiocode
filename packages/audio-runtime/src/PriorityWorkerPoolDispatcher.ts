import { DeviceTier } from '../../../src/runtime/ResilientAiRuntime';

/** 4-tier priority queue levels for studio worker pool (Sections 11, 12 & 31) */
export type WorkerTaskPriority =
  | 0 // P0_REALTIME_PREVIEW: A/B splice audition & immediate playback pre-roll
  | 1 // P1_VIEWPORT_INTERACTIVE: Waveform LOD & playhead neighborhood blocks
  | 2 // P2_MUTATION_COMMIT: Transaction persistence, Seek Table & post-edit validation
  | 3; // P3_BACKGROUND_BATCH: Heavy Persian ASR, diarization & batch processing

export interface WorkerTaskRequest<TPayload, TResult> {
  readonly taskId: string;
  readonly priority: WorkerTaskPriority;
  readonly taskType: string;
  readonly payload: TPayload;
  /** Zero-copy ArrayBuffer / MessagePort transferables */
  readonly transferables?: Transferable[];
  readonly abortSignal?: AbortSignal;
  readonly resolve: (res: TResult) => void;
  readonly reject: (err: Error) => void;
}

interface ManagedWorkerSlot {
  readonly slotIndex: number;
  busy: boolean;
  activeTaskId: string | null;
  executeOnWorker: (
    taskType: string,
    payload: unknown,
    transferables?: Transferable[],
  ) => Promise<unknown>;
}

/**
 * Priority Web Worker Pool Dispatcher with Hardware-Concurrency Reservation & Backpressure
 * (Architecture Doc Sections 11, 13 & 31)
 * Reserves at least 2 logical CPU cores for the AudioWorklet real-time thread and UI main thread,
 * caps mobile companion to 1 heavy worker to prevent iOS Safari Jetsam OOM kills, and schedules
 * P0_REALTIME_PREVIEW ahead of P3_BACKGROUND_BATCH tasks between chunks.
 */
export class PriorityWorkerPoolDispatcher {
  private readonly slots: ManagedWorkerSlot[] = [];
  private readonly priorityQueues: [
    WorkerTaskRequest<unknown, unknown>[],
    WorkerTaskRequest<unknown, unknown>[],
    WorkerTaskRequest<unknown, unknown>[],
    WorkerTaskRequest<unknown, unknown>[],
  ] = [[], [], [], []];

  private readonly maxQueuedTasksBeforeBackpressure: number;

  constructor(
    deviceTier: DeviceTier,
    createWorkerExecutorFn: (
      slotIndex: number,
    ) => (taskType: string, payload: unknown, transferables?: Transferable[]) => Promise<unknown>,
    options?: {
      hardwareConcurrencyOverride?: number;
      maxQueuedTasksBeforeBackpressure?: number;
    },
  ) {
    this.maxQueuedTasksBeforeBackpressure = options?.maxQueuedTasksBeforeBackpressure ?? 256;

    const logicalCores =
      options?.hardwareConcurrencyOverride ??
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4);

    const maxAllowedByTier =
      deviceTier === 'MOBILE_COMPANION'
        ? 1
        : deviceTier === 'TABLET_STUDIO'
          ? 2
          : Math.min(6, Math.max(2, logicalCores - 2));

    for (let i = 0; i < maxAllowedByTier; i++) {
      this.slots.push({
        slotIndex: i,
        busy: false,
        activeTaskId: null,
        executeOnWorker: createWorkerExecutorFn(i),
      });
    }
  }

  public getSlotCount(): number {
    return this.slots.length;
  }

  /**
   * Enqueues a prioritized worker task with P3 background backpressure protection.
   */
  public dispatchTask<TPayload, TResult>(params: {
    taskId: string;
    priority: WorkerTaskPriority;
    taskType: string;
    payload: TPayload;
    transferables?: Transferable[];
    abortSignal?: AbortSignal;
  }): Promise<TResult> {
    const totalPending = this.getTotalPendingCount();
    if (totalPending >= this.maxQueuedTasksBeforeBackpressure && params.priority === 3) {
      return Promise.reject(
        new Error(
          'WORKER_POOL_BACKPRESSURE_LIMIT: صف پردازش پس‌زمینه پر است؛ لطفاً منتظر تخلیه قطعات فعلی بمانید.',
        ),
      );
    }

    if (params.abortSignal?.aborted) {
      return Promise.reject(new Error('TASK_ABORTED_BEFORE_DISPATCH'));
    }

    return new Promise<TResult>((resolve, reject) => {
      const req: WorkerTaskRequest<unknown, unknown> = {
        taskId: params.taskId,
        priority: params.priority,
        taskType: params.taskType,
        payload: params.payload,
        transferables: params.transferables,
        abortSignal: params.abortSignal,
        resolve: (res) => resolve(res as TResult),
        reject,
      };

      this.priorityQueues[params.priority].push(req);
      this.pumpNextAvailableTasks();
    });
  }

  private pumpNextAvailableTasks(): void {
    for (const slot of this.slots) {
      if (slot.busy) continue;

      const nextTask = this.dequeueHighestPriorityValidTask();
      if (!nextTask) break;

      slot.busy = true;
      slot.activeTaskId = nextTask.taskId;

      slot
        .executeOnWorker(nextTask.taskType, nextTask.payload, nextTask.transferables)
        .then((result) => {
          nextTask.resolve(result);
        })
        .catch((err) => {
          nextTask.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          slot.busy = false;
          slot.activeTaskId = null;
          this.pumpNextAvailableTasks();
        });
    }
  }

  private dequeueHighestPriorityValidTask(): WorkerTaskRequest<unknown, unknown> | null {
    for (let p = 0; p <= 3; p++) {
      const queue = this.priorityQueues[p];
      while (queue.length > 0) {
        const candidate = queue.shift()!;
        if (candidate.abortSignal?.aborted) {
          candidate.reject(new Error('TASK_ABORTED_IN_QUEUE'));
          continue;
        }
        return candidate;
      }
    }
    return null;
  }

  public getTotalPendingCount(): number {
    return (
      this.priorityQueues[0].length +
      this.priorityQueues[1].length +
      this.priorityQueues[2].length +
      this.priorityQueues[3].length
    );
  }
}
