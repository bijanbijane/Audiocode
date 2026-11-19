import { AvapardazError, generateCorrelationId } from './AvapardazError';
import { getSharedDiagnosticLogger, LocalDiagnosticLogger } from './LocalDiagnosticLogger';

export interface SupervisedWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string; error?: unknown }) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
}

export interface WorkerSupervisorRequestOptions<TReq = unknown> {
  readonly type: string;
  readonly payload?: TReq;
  readonly transfer?: Transferable[];
  readonly timeoutMs?: number;
  readonly idempotent: boolean;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
  readonly onCheckpointPreserve?: () => void;
}

export interface WorkerSupervisorConfig {
  readonly workerName: string;
  readonly createWorker: () => SupervisedWorkerLike;
  readonly initTimeoutMs?: number;
  readonly defaultRequestTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly baseBackoffMs?: number;
  readonly logger?: LocalDiagnosticLogger;
  readonly requireInitHandshake?: boolean;
}

export type WorkerSupervisorState =
  | 'IDLE'
  | 'INITIALIZING'
  | 'READY'
  | 'RESTARTING'
  | 'EXHAUSTED'
  | 'DISPOSED';

interface PendingWorkerRequest {
  readonly id: string;
  readonly type: string;
  readonly idempotent: boolean;
  readonly operationId?: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortHandler?: () => void;
  readonly signal?: AbortSignal;
  readonly onCheckpointPreserve?: () => void;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: AvapardazError) => void;
  settled: boolean;
}

export interface WorkerSupervisorSnapshot {
  readonly workerName: string;
  readonly state: WorkerSupervisorState;
  readonly restartCount: number;
  readonly maxRestarts: number;
  readonly pendingCount: number;
  readonly rejectedMalformedCount: number;
  readonly rejectedStaleOrDuplicateCount: number;
}

function isValidWorkerEnvelope(data: unknown): data is {
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: string;
} {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.id === 'string' && obj.id.length > 0 && typeof obj.ok === 'boolean';
}

/**
 * Unified Worker Supervision Layer (AVP-P10-001 Section 4)
 * Guarantees init timeout, request timeout, strict envelope validation, correlation IDs,
 * explicit cancellation, late/duplicate response rejection, bounded restart with backoff,
 * pending request cleanup, transferable ownership safety, and zero blind retry of non-idempotent ops.
 */
export class WorkerSupervisor {
  private readonly workerName: string;
  private readonly createWorker: () => SupervisedWorkerLike;
  private readonly initTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly baseBackoffMs: number;
  private readonly logger: LocalDiagnosticLogger;
  private readonly requireInitHandshake: boolean;

  private worker: SupervisedWorkerLike | null = null;
  private state: WorkerSupervisorState = 'IDLE';
  private restartCount = 0;
  private rejectedMalformedCount = 0;
  private rejectedStaleOrDuplicateCount = 0;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingWorkerRequest>();
  private readonly completedIds = new Set<string>();
  private initPromise: Promise<void> | null = null;

  constructor(config: WorkerSupervisorConfig) {
    this.workerName = config.workerName;
    this.createWorker = config.createWorker;
    this.initTimeoutMs = Math.max(50, config.initTimeoutMs ?? 5_000);
    this.defaultRequestTimeoutMs = Math.max(50, config.defaultRequestTimeoutMs ?? 15_000);
    this.maxRestarts = Math.max(0, config.maxRestarts ?? 3);
    this.baseBackoffMs = Math.max(10, config.baseBackoffMs ?? 100);
    this.logger = config.logger ?? getSharedDiagnosticLogger();
    this.requireInitHandshake = config.requireInitHandshake ?? false;
  }

  public getSnapshot(): WorkerSupervisorSnapshot {
    return {
      workerName: this.workerName,
      state: this.state,
      restartCount: this.restartCount,
      maxRestarts: this.maxRestarts,
      pendingCount: this.pending.size,
      rejectedMalformedCount: this.rejectedMalformedCount,
      rejectedStaleOrDuplicateCount: this.rejectedStaleOrDuplicateCount,
    };
  }

  public async ensureReady(): Promise<void> {
    if (this.state === 'DISPOSED') {
      throw new AvapardazError({
        code: 'WORKER_CRASHED',
        subsystem: 'WORKER_INFRA',
        technicalMessage: `Worker "${this.workerName}" has been disposed.`,
        retryRecommended: false,
      });
    }
    if (this.state === 'EXHAUSTED') {
      throw new AvapardazError({
        code: 'WORKER_CRASHED',
        subsystem: 'WORKER_INFRA',
        severity: 'CRITICAL',
        recoverability: 'NON_RECOVERABLE',
        technicalMessage: `Worker "${this.workerName}" exhausted max restarts (${this.maxRestarts}).`,
        retryRecommended: false,
      });
    }
    if (this.state === 'READY' && this.worker) return;
    if (this.initPromise) return this.initPromise;

    this.state = 'INITIALIZING';
    this.initPromise = this.spawnWorkerWithHandshake();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  public async sendRequest<TRes = unknown, TReq = unknown>(
    options: WorkerSupervisorRequestOptions<TReq>,
  ): Promise<TRes> {
    if (options.signal?.aborted) {
      throw new AvapardazError({
        code: 'WORKER_TIMEOUT',
        subsystem: 'WORKER_INFRA',
        severity: 'INFO',
        recoverability: 'RECOVERABLE',
        technicalMessage: `Request "${options.type}" was aborted before dispatch.`,
        operationId: options.operationId,
        retryRecommended: options.idempotent,
      });
    }

    await this.ensureReady();
    if (!this.worker || this.state !== 'READY') {
      throw new AvapardazError({
        code: 'WORKER_CRASHED',
        subsystem: 'WORKER_INFRA',
        technicalMessage: `Worker "${this.workerName}" is not ready.`,
        operationId: options.operationId,
        retryRecommended: options.idempotent,
      });
    }

    // Never share/reuse detached Transferable buffers on retry
    const hasTransferables = Boolean(options.transfer && options.transfer.length > 0);
    const id = generateCorrelationId(`wrk_${++this.requestSeq}`);
    const timeoutMs = Math.max(25, options.timeoutMs ?? this.defaultRequestTimeoutMs);

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry || entry.settled) return;
        entry.settled = true;
        this.pending.delete(id);
        this.recordCompletedId(id);
        entry.onCheckpointPreserve?.();
        const err = new AvapardazError({
          code: 'WORKER_TIMEOUT',
          subsystem: 'WORKER_INFRA',
          technicalMessage: `Worker "${this.workerName}" request "${options.type}" timed out after ${timeoutMs}ms.`,
          operationId: options.operationId,
          correlationId: id,
          retryRecommended: options.idempotent && !hasTransferables,
          metadata: {
            workerName: this.workerName,
            requestType: options.type,
            timeoutMs,
            idempotent: options.idempotent,
          },
        });
        this.logger.logError(err);
        reject(err);
      }, timeoutMs);

      const abortHandler = () => {
        this.cancelRequest(id, 'ABORT_SIGNAL');
      };
      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      const pendingEntry: PendingWorkerRequest = {
        id,
        type: options.type,
        idempotent: options.idempotent,
        operationId: options.operationId,
        timer,
        abortHandler,
        signal: options.signal,
        onCheckpointPreserve: options.onCheckpointPreserve,
        resolve: (val) => resolve(val as TRes),
        reject,
        settled: false,
      };
      this.pending.set(id, pendingEntry);

      try {
        this.worker!.postMessage(
          {
            id,
            type: options.type,
            payload: options.payload,
          },
          options.transfer,
        );
      } catch (postErr) {
        this.cleanupPendingEntry(id);
        const err = new AvapardazError({
          code: 'WORKER_CRASHED',
          subsystem: 'WORKER_INFRA',
          technicalMessage: `Failed to postMessage to worker "${this.workerName}": ${postErr instanceof Error ? postErr.message : String(postErr)}`,
          operationId: options.operationId,
          correlationId: id,
          retryRecommended: false,
          cause: postErr,
        });
        this.logger.logError(err);
        reject(err);
      }
    });
  }

  public cancelRequest(correlationId: string, reason = 'CANCELLED_BY_CALLER'): boolean {
    const entry = this.pending.get(correlationId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this.cleanupPendingEntry(correlationId);
    this.recordCompletedId(correlationId);
    entry.onCheckpointPreserve?.();
    entry.reject(
      new AvapardazError({
        code: 'WORKER_TIMEOUT',
        subsystem: 'WORKER_INFRA',
        severity: 'INFO',
        recoverability: 'RECOVERABLE',
        technicalMessage: `Worker request "${entry.type}" cancelled (${reason}).`,
        operationId: entry.operationId,
        correlationId,
        retryRecommended: entry.idempotent,
      }),
    );
    return true;
  }

  public async ping(timeoutMs = 1500): Promise<boolean> {
    try {
      await this.sendRequest({
        type: '__ping__',
        timeoutMs,
        idempotent: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  public dispose(): void {
    if (this.state === 'DISPOSED') return;
    this.state = 'DISPOSED';

    for (const [id, entry] of Array.from(this.pending.entries())) {
      entry.settled = true;
      this.cleanupPendingEntry(id);
      this.recordCompletedId(id);
      entry.onCheckpointPreserve?.();
      entry.reject(
        new AvapardazError({
          code: 'WORKER_CRASHED',
          subsystem: 'WORKER_INFRA',
          severity: 'WARNING',
          recoverability: 'RECOVERABLE',
          technicalMessage: `Worker "${this.workerName}" disposed while request "${entry.type}" was pending.`,
          operationId: entry.operationId,
          correlationId: id,
          retryRecommended: false,
        }),
      );
    }

    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      try {
        this.worker.terminate();
      } catch {
        // Ignore terminate errors on already dead worker
      }
      this.worker = null;
    }
  }

  private async spawnWorkerWithHandshake(): Promise<void> {
    const instance = this.createWorker();
    this.worker = instance;

    instance.onmessage = (event) => this.handleWorkerMessage(event.data);
    instance.onerror = (event) => {
      void this.handleWorkerCrash(event?.message ?? 'Worker runtime error');
    };
    instance.onmessageerror = () => {
      this.rejectedMalformedCount += 1;
      this.logger.log({
        severity: 'WARNING',
        subsystem: 'WORKER_INFRA',
        code: 'WORKER_CRASHED',
        message: `Worker "${this.workerName}" emitted messageerror (deserialization failure).`,
      });
    };

    if (!this.requireInitHandshake) {
      this.state = 'READY';
      return;
    }

    // Wait for explicit __init__ ack within initTimeoutMs
    const initId = generateCorrelationId('init');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(initId);
        this.terminateCurrentWorkerSilently();
        this.state = 'IDLE';
        const err = new AvapardazError({
          code: 'WORKER_TIMEOUT',
          subsystem: 'WORKER_INFRA',
          severity: 'ERROR',
          technicalMessage: `Worker "${this.workerName}" initialization timed out after ${this.initTimeoutMs}ms.`,
          correlationId: initId,
          retryRecommended: true,
        });
        this.logger.logError(err);
        reject(err);
      }, this.initTimeoutMs);

      this.pending.set(initId, {
        id: initId,
        type: '__init__',
        idempotent: true,
        timer,
        resolve: () => {
          this.state = 'READY';
          resolve();
        },
        reject: (err) => {
          this.terminateCurrentWorkerSilently();
          this.state = 'IDLE';
          reject(err);
        },
        settled: false,
      });

      instance.postMessage({ id: initId, type: '__init__' });
    });
  }

  private handleWorkerMessage(data: unknown): void {
    if (!isValidWorkerEnvelope(data)) {
      this.rejectedMalformedCount += 1;
      this.logger.log({
        severity: 'WARNING',
        subsystem: 'WORKER_INFRA',
        code: 'WORKER_CRASHED',
        message: `Malformed message received from worker "${this.workerName}" and discarded.`,
      });
      return;
    }

    const entry = this.pending.get(data.id);
    if (!entry || entry.settled) {
      this.rejectedStaleOrDuplicateCount += 1;
      return;
    }

    entry.settled = true;
    this.cleanupPendingEntry(data.id);
    this.recordCompletedId(data.id);

    if (data.ok) {
      entry.resolve(data.payload);
    } else {
      const err = new AvapardazError({
        code: 'WORKER_CRASHED',
        subsystem: 'WORKER_INFRA',
        technicalMessage: `Worker "${this.workerName}" returned failure for "${entry.type}": ${data.error ?? 'Unknown worker error'}`,
        operationId: entry.operationId,
        correlationId: data.id,
        retryRecommended: entry.idempotent,
      });
      this.logger.logError(err);
      entry.reject(err);
    }
  }

  private async handleWorkerCrash(reason: string): Promise<void> {
    if (this.state === 'DISPOSED') return;

    this.terminateCurrentWorkerSilently();

    // 1-6. Preserve checkpoints, release abandoned resources, settle all pending requests cleanly.
    // Non-idempotent operations are NEVER blindly retried; they are marked INTERRUPTED/NON-RETRYABLE.
    for (const [id, entry] of Array.from(this.pending.entries())) {
      entry.settled = true;
      this.cleanupPendingEntry(id);
      this.recordCompletedId(id);
      entry.onCheckpointPreserve?.();
      const err = new AvapardazError({
        code: 'WORKER_CRASHED',
        subsystem: 'WORKER_INFRA',
        severity: entry.idempotent ? 'ERROR' : 'CRITICAL',
        recoverability: entry.idempotent ? 'RETRYABLE' : 'RECOVERABLE',
        technicalMessage: `Worker "${this.workerName}" crashed during "${entry.type}" (${reason}). Non-idempotent operation was NOT retried automatically.`,
        operationId: entry.operationId,
        correlationId: id,
        retryRecommended: entry.idempotent,
        metadata: {
          workerName: this.workerName,
          idempotent: entry.idempotent,
          restartCount: this.restartCount,
        },
      });
      this.logger.logError(err);
      entry.reject(err);
    }

    // Bounded restart policy with exponential backoff
    if (this.restartCount >= this.maxRestarts) {
      this.state = 'EXHAUSTED';
      this.logger.log({
        severity: 'CRITICAL',
        subsystem: 'WORKER_INFRA',
        code: 'WORKER_CRASHED',
        message: `Worker "${this.workerName}" reached restart limit (${this.maxRestarts}); automatic restarts halted.`,
      });
      return;
    }

    this.restartCount += 1;
    this.state = 'RESTARTING';
    const backoffMs = this.baseBackoffMs * Math.pow(2, this.restartCount - 1);
    await new Promise((r) => setTimeout(r, backoffMs));

    if (this.state !== 'RESTARTING') return;
    this.state = 'IDLE';
  }

  private cleanupPendingEntry(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
    }
    this.pending.delete(id);
  }

  private terminateCurrentWorkerSilently(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    try {
      this.worker.terminate();
    } catch {
      // Ignore
    }
    this.worker = null;
  }

  private recordCompletedId(id: string): void {
    this.completedIds.add(id);
    if (this.completedIds.size > 512) {
      const oldest = this.completedIds.values().next().value;
      if (oldest) this.completedIds.delete(oldest);
    }
  }
}
