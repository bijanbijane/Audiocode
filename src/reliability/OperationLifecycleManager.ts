import { AvapardazError, generateCorrelationId } from './AvapardazError';
import { ReliabilitySubsystemId } from './ErrorCode';
import { getSharedDiagnosticLogger, LocalDiagnosticLogger } from './LocalDiagnosticLogger';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryCategory,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';

export type ManagedOperationKind =
  | 'AUDIO_IMPORT'
  | 'MODEL_INSTALL'
  | 'LOCAL_ASR'
  | 'TRANSCRIPT_PERSIST'
  | 'PROJECT_BACKUP'
  | 'AUDIO_RENDER'
  | 'AUDIO_EXPORT'
  | 'PROJECT_RESTORE'
  | 'APP_UPDATE';

export type ManagedOperationState =
  | 'CREATED'
  | 'VALIDATING'
  | 'QUEUED'
  | 'RUNNING'
  | 'CHECKPOINTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'RECOVERY_REQUIRED';

export interface OperationProgress {
  /** Null means honest indeterminate progress; never fabricate percentages */
  readonly percent: number | null;
  readonly indeterminate: boolean;
  readonly stageLabel: string;
}

export interface ManagedOperationRecord {
  readonly operationId: string;
  readonly kind: ManagedOperationKind;
  readonly subsystem: ReliabilitySubsystemId;
  readonly idempotent: boolean;
  readonly safeToCancelUnderEmergencyMemory: boolean;
  readonly dedupeKey: string | null;
  readonly state: ManagedOperationState;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly progress: OperationProgress;
  readonly recoverable: boolean;
  readonly error: AvapardazError | null;
  readonly memoryReservationId: string | null;
}

const LEGAL_TRANSITIONS: Readonly<Record<ManagedOperationState, readonly ManagedOperationState[]>> = {
  CREATED: ['VALIDATING', 'QUEUED', 'RUNNING', 'CANCELLED', 'FAILED'],
  VALIDATING: ['QUEUED', 'RUNNING', 'CANCELLED', 'FAILED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED', 'INTERRUPTED'],
  RUNNING: ['CHECKPOINTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'RECOVERY_REQUIRED'],
  CHECKPOINTING: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'RECOVERY_REQUIRED'],
  COMPLETED: [],
  FAILED: ['RECOVERY_REQUIRED'],
  CANCELLED: [],
  INTERRUPTED: ['RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: [],
};

const TERMINAL_STATES = new Set<ManagedOperationState>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
]);

export function isLegalOperationTransition(
  from: ManagedOperationState,
  to: ManagedOperationState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface CreateOperationOptions {
  readonly kind: ManagedOperationKind;
  readonly subsystem: ReliabilitySubsystemId;
  readonly idempotent: boolean;
  readonly safeToCancelUnderEmergencyMemory?: boolean;
  readonly dedupeKey?: string;
  readonly stageLabel?: string;
  readonly estimatedMemoryBytes?: number;
  readonly memoryCategory?: MemoryCategory;
  readonly protectedUserData?: boolean;
  readonly onCleanup?: () => void;
}

/**
 * Shared Safe Operation Lifecycle Manager (AVP-P10-001 Sections 5 & 6)
 * - Enforces legal state transitions and rejects duplicate non-idempotent execution.
 * - Integrates with the single canonical MemoryBudgetManager (AVAPARDAZ_MEMORY_POLICY).
 * - Guarantees deterministic resource & memory reservation cleanup on completion, failure, or cancellation.
 */
export class OperationLifecycleManager {
  private readonly memoryBudget: MemoryBudgetManager;
  private readonly logger: LocalDiagnosticLogger;
  private readonly operations = new Map<string, ManagedOperationRecord>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cleanupHooks = new Map<string, () => void>();
  private readonly activeDedupeKeys = new Map<string, string>();
  private readonly reservations = new Map<string, MemoryReservation>();

  constructor(options?: {
    readonly memoryBudget?: MemoryBudgetManager;
    readonly logger?: LocalDiagnosticLogger;
  }) {
    this.memoryBudget = options?.memoryBudget ?? getSharedMemoryBudgetManager();
    this.logger = options?.logger ?? getSharedDiagnosticLogger();
  }

  public createOperation(options: CreateOperationOptions): {
    readonly record: ManagedOperationRecord;
    readonly signal: AbortSignal;
  } {
    // Prevent duplicate concurrent execution of non-idempotent operations
    if (options.dedupeKey && !options.idempotent) {
      const existingOpId = this.activeDedupeKeys.get(options.dedupeKey);
      if (existingOpId) {
        throw new AvapardazError({
          code: 'INTERNAL_UNEXPECTED_ERROR',
          subsystem: options.subsystem,
          severity: 'WARNING',
          recoverability: 'RECOVERABLE',
          userSafeMessageFa: 'این عملیات در حال اجرا است و از اجرای هم‌زمان تکراری جلوگیری شد.',
          userSafeMessageEn: 'Duplicate concurrent execution of this non-idempotent operation was blocked.',
          technicalMessage: `Duplicate active non-idempotent operation blocked for dedupeKey "${options.dedupeKey}" (active: ${existingOpId}).`,
          operationId: existingOpId,
          retryRecommended: false,
        });
      }
    }

    // Coordinated memory pressure admission check using the single AVAPARDAZ_MEMORY_POLICY
    const pressure = this.memoryBudget.getPressureLevel();
    if (
      pressure === 'emergency' &&
      options.estimatedMemoryBytes &&
      options.estimatedMemoryBytes > 0
    ) {
      // Cancel only explicitly safe-to-cancel optional operations first
      this.cancelEmergencyDisposableOperations();
      const postPressure = this.memoryBudget.getPressureLevel();
      if (postPressure === 'emergency' && !options.protectedUserData) {
        const err = new AvapardazError({
          code: 'MEMORY_BUDGET_EXCEEDED',
          subsystem: 'MEMORY_BUDGET',
          technicalMessage: `Blocked "${options.kind}" (${options.estimatedMemoryBytes} B) under emergency memory pressure.`,
          retryRecommended: false,
        });
        this.logger.logError(err);
        throw err;
      }
    }

    const operationId = generateCorrelationId(`op_${options.kind.toLowerCase()}`);
    let reservation: MemoryReservation | null = null;
    if (options.estimatedMemoryBytes && options.estimatedMemoryBytes > 0) {
      try {
        reservation = this.memoryBudget.reserve({
          owner: operationId,
          category: options.memoryCategory ?? 'other',
          bytes: Math.trunc(options.estimatedMemoryBytes),
          priority: options.protectedUserData ? 'protected' : 'normal',
          protectedUserData: options.protectedUserData,
        });
      } catch (memErr) {
        const err = new AvapardazError({
          code: 'MEMORY_BUDGET_EXCEEDED',
          subsystem: 'MEMORY_BUDGET',
          technicalMessage:
            memErr instanceof Error ? memErr.message : 'Memory reservation denied.',
          operationId,
          retryRecommended: false,
          cause: memErr,
        });
        this.logger.logError(err);
        throw err;
      }
    }

    const now = Date.now();
    const record: ManagedOperationRecord = {
      operationId,
      kind: options.kind,
      subsystem: options.subsystem,
      idempotent: options.idempotent,
      safeToCancelUnderEmergencyMemory: Boolean(options.safeToCancelUnderEmergencyMemory),
      dedupeKey: options.dedupeKey ?? null,
      state: 'CREATED',
      startedAtMs: now,
      updatedAtMs: now,
      finishedAtMs: null,
      progress: {
        percent: null,
        indeterminate: true,
        stageLabel: options.stageLabel ?? options.kind,
      },
      recoverable: false,
      error: null,
      memoryReservationId: reservation?.id ?? null,
    };

    const controller = new AbortController();
    this.operations.set(operationId, record);
    this.abortControllers.set(operationId, controller);
    if (options.onCleanup) {
      this.cleanupHooks.set(operationId, options.onCleanup);
    }
    if (options.dedupeKey && !options.idempotent) {
      this.activeDedupeKeys.set(options.dedupeKey, operationId);
    }
    if (reservation) {
      this.reservations.set(operationId, reservation);
    }

    return { record, signal: controller.signal };
  }

  public transition(
    operationId: string,
    nextState: ManagedOperationState,
    patch?: {
      readonly progress?: OperationProgress;
      readonly error?: AvapardazError | null;
      readonly recoverable?: boolean;
    },
  ): ManagedOperationRecord {
    const current = this.operations.get(operationId);
    if (!current) {
      throw new AvapardazError({
        code: 'INTERNAL_UNEXPECTED_ERROR',
        subsystem: 'INTERNAL',
        technicalMessage: `Unknown operationId "${operationId}".`,
      });
    }

    if (!isLegalOperationTransition(current.state, nextState)) {
      throw new AvapardazError({
        code: 'INTERNAL_UNEXPECTED_ERROR',
        subsystem: current.subsystem,
        technicalMessage: `Illegal operation state transition ${current.state} -> ${nextState} for ${operationId}.`,
        operationId,
      });
    }

    const now = Date.now();
    const isTerminal = TERMINAL_STATES.has(nextState);
    const updated: ManagedOperationRecord = {
      ...current,
      state: nextState,
      updatedAtMs: now,
      finishedAtMs: isTerminal ? now : current.finishedAtMs,
      progress: patch?.progress ?? current.progress,
      error: patch?.error !== undefined ? patch.error : current.error,
      recoverable: patch?.recoverable ?? current.recoverable,
    };
    this.operations.set(operationId, updated);

    if (isTerminal) {
      this.releaseOperationResources(operationId);
    }
    return updated;
  }

  public updateProgress(
    operationId: string,
    percent: number | null,
    stageLabel: string,
  ): ManagedOperationRecord | null {
    const current = this.operations.get(operationId);
    if (!current || TERMINAL_STATES.has(current.state)) return null;
    const validPct =
      typeof percent === 'number' && Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : null;
    const updated: ManagedOperationRecord = {
      ...current,
      updatedAtMs: Date.now(),
      progress: {
        percent: validPct,
        indeterminate: validPct === null,
        stageLabel,
      },
    };
    this.operations.set(operationId, updated);
    return updated;
  }

  public cancelOperation(operationId: string): boolean {
    const current = this.operations.get(operationId);
    if (!current || TERMINAL_STATES.has(current.state)) return false;
    this.abortControllers.get(operationId)?.abort();
    this.transition(operationId, 'CANCELLED');
    return true;
  }

  public cancelEmergencyDisposableOperations(): number {
    let cancelled = 0;
    for (const op of this.operations.values()) {
      if (
        !TERMINAL_STATES.has(op.state) &&
        op.safeToCancelUnderEmergencyMemory &&
        isLegalOperationTransition(op.state, 'CANCELLED')
      ) {
        if (this.cancelOperation(op.operationId)) {
          cancelled += 1;
        }
      }
    }
    return cancelled;
  }

  public getOperation(operationId: string): ManagedOperationRecord | null {
    return this.operations.get(operationId) ?? null;
  }

  public listActiveOperations(): readonly ManagedOperationRecord[] {
    return Array.from(this.operations.values()).filter((op) => !TERMINAL_STATES.has(op.state));
  }

  public hasActiveHeavyWork(): boolean {
    return this.listActiveOperations().some(
      (op) =>
        op.kind === 'LOCAL_ASR' ||
        op.kind === 'AUDIO_RENDER' ||
        op.kind === 'AUDIO_EXPORT' ||
        op.kind === 'MODEL_INSTALL',
    );
  }

  private releaseOperationResources(operationId: string): void {
    const op = this.operations.get(operationId);
    if (op?.dedupeKey && this.activeDedupeKeys.get(op.dedupeKey) === operationId) {
      this.activeDedupeKeys.delete(op.dedupeKey);
    }

    const res = this.reservations.get(operationId);
    if (res) {
      this.memoryBudget.release(res);
      this.reservations.delete(operationId);
    }

    const cleanup = this.cleanupHooks.get(operationId);
    if (cleanup) {
      this.cleanupHooks.delete(operationId);
      try {
        cleanup();
      } catch {
        // Cleanup must never throw during terminal state settlement
      }
    }
    this.abortControllers.delete(operationId);
  }
}
