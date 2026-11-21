/**
 * AVP-P0-002 §7 — Explicit 19-State Canonical Model Lifecycle State Machine
 *
 * Non-ambiguous operational guarantees:
 * - `INSTALLED` does NOT mean `INFERENCE_VERIFIED` or `ACTIVE`.
 * - `RUNTIME_INITIALIZED` does NOT mean `INFERENCE_VERIFIED` or `ACTIVE`.
 * - `ACTIVE` is reachable ONLY after `INFERENCE_VERIFIED` has been achieved on the exact installed artifact.
 * - All transitions are validated against an explicit transition table and persisted safely across restarts.
 */

export type CanonicalModelLifecycleState =
  | 'DISCOVERED'
  | 'METADATA_VALIDATED'
  | 'SOURCE_VERIFIED'
  | 'DOWNLOAD_PENDING'
  | 'DOWNLOADING'
  | 'DOWNLOAD_INTERRUPTED'
  | 'DOWNLOADED'
  | 'INTEGRITY_VERIFIED'
  | 'INSTALLING'
  | 'INSTALLED'
  | 'COMPATIBILITY_VERIFIED'
  | 'RUNTIME_INITIALIZED'
  | 'INFERENCE_VERIFIED'
  | 'ACTIVE'
  | 'UNAVAILABLE'
  | 'INCOMPATIBLE'
  | 'CORRUPTED'
  | 'REVOKED'
  | 'REMOVAL_PENDING';

export const ALL_CANONICAL_MODEL_STATES: readonly CanonicalModelLifecycleState[] = Object.freeze([
  'DISCOVERED',
  'METADATA_VALIDATED',
  'SOURCE_VERIFIED',
  'DOWNLOAD_PENDING',
  'DOWNLOADING',
  'DOWNLOAD_INTERRUPTED',
  'DOWNLOADED',
  'INTEGRITY_VERIFIED',
  'INSTALLING',
  'INSTALLED',
  'COMPATIBILITY_VERIFIED',
  'RUNTIME_INITIALIZED',
  'INFERENCE_VERIFIED',
  'ACTIVE',
  'UNAVAILABLE',
  'INCOMPATIBLE',
  'CORRUPTED',
  'REVOKED',
  'REMOVAL_PENDING',
]);

export interface ModelStateTransitionRecord {
  readonly from: CanonicalModelLifecycleState;
  readonly to: CanonicalModelLifecycleState;
  readonly timestampMs: number;
  readonly reason: string;
  readonly modelId: string;
  readonly version: string;
}

export interface PersistedModelStateLedger {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly version: string;
  readonly currentState: CanonicalModelLifecycleState;
  readonly verifiedSha256Hex: string | null;
  readonly inferenceVerifiedAtMs: number | null;
  readonly updatedAtMs: number;
  readonly history: readonly ModelStateTransitionRecord[];
}

export class InvalidModelStateTransitionError extends Error {
  public readonly code = 'INVALID_MODEL_STATE_TRANSITION' as const;
  public readonly from: CanonicalModelLifecycleState;
  public readonly to: CanonicalModelLifecycleState;

  constructor(from: CanonicalModelLifecycleState, to: CanonicalModelLifecycleState, reason?: string) {
    super(
      `Illegal model lifecycle transition ${from} -> ${to}${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'InvalidModelStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Exhaustive legal transition graph.
 * Notice:
 * - INSTALLED -> ACTIVE is FORBIDDEN (must pass COMPATIBILITY_VERIFIED -> RUNTIME_INITIALIZED -> INFERENCE_VERIFIED -> ACTIVE)
 * - RUNTIME_INITIALIZED -> ACTIVE is FORBIDDEN (must pass INFERENCE_VERIFIED -> ACTIVE)
 * - CORRUPTED / REVOKED cannot become ACTIVE without re-verification or re-installation.
 */
const LEGAL_TRANSITIONS: Readonly<
  Record<CanonicalModelLifecycleState, readonly CanonicalModelLifecycleState[]>
> = Object.freeze({
  DISCOVERED: ['METADATA_VALIDATED', 'UNAVAILABLE', 'INCOMPATIBLE', 'REVOKED'],
  METADATA_VALIDATED: ['SOURCE_VERIFIED', 'DOWNLOAD_PENDING', 'UNAVAILABLE', 'INCOMPATIBLE', 'REVOKED'],
  SOURCE_VERIFIED: ['DOWNLOAD_PENDING', 'INSTALLING', 'UNAVAILABLE', 'INCOMPATIBLE', 'REVOKED'],
  DOWNLOAD_PENDING: ['DOWNLOADING', 'UNAVAILABLE', 'REVOKED', 'REMOVAL_PENDING'],
  DOWNLOADING: ['DOWNLOADED', 'DOWNLOAD_INTERRUPTED', 'CORRUPTED', 'UNAVAILABLE', 'REMOVAL_PENDING'],
  DOWNLOAD_INTERRUPTED: ['DOWNLOAD_PENDING', 'DOWNLOADING', 'UNAVAILABLE', 'REMOVAL_PENDING'],
  DOWNLOADED: ['INTEGRITY_VERIFIED', 'CORRUPTED', 'REMOVAL_PENDING'],
  INTEGRITY_VERIFIED: ['INSTALLING', 'CORRUPTED', 'REVOKED', 'REMOVAL_PENDING'],
  INSTALLING: ['INSTALLED', 'CORRUPTED', 'UNAVAILABLE', 'REMOVAL_PENDING'],
  INSTALLED: ['COMPATIBILITY_VERIFIED', 'INCOMPATIBLE', 'CORRUPTED', 'REVOKED', 'REMOVAL_PENDING'],
  COMPATIBILITY_VERIFIED: ['RUNTIME_INITIALIZED', 'INCOMPATIBLE', 'CORRUPTED', 'REVOKED', 'REMOVAL_PENDING'],
  RUNTIME_INITIALIZED: ['INFERENCE_VERIFIED', 'CORRUPTED', 'UNAVAILABLE', 'INCOMPATIBLE', 'REVOKED', 'REMOVAL_PENDING'],
  INFERENCE_VERIFIED: ['ACTIVE', 'CORRUPTED', 'REVOKED', 'REMOVAL_PENDING'],
  ACTIVE: ['RUNTIME_INITIALIZED', 'COMPATIBILITY_VERIFIED', 'INSTALLED', 'CORRUPTED', 'REVOKED', 'UNAVAILABLE', 'REMOVAL_PENDING'],
  UNAVAILABLE: ['DISCOVERED', 'METADATA_VALIDATED', 'DOWNLOAD_PENDING', 'REMOVAL_PENDING'],
  INCOMPATIBLE: ['DISCOVERED', 'METADATA_VALIDATED', 'REMOVAL_PENDING'],
  CORRUPTED: ['DOWNLOAD_PENDING', 'REMOVAL_PENDING', 'UNAVAILABLE'],
  REVOKED: ['REMOVAL_PENDING'],
  REMOVAL_PENDING: ['UNAVAILABLE', 'DISCOVERED'],
});

export function isLegalModelStateTransition(
  from: CanonicalModelLifecycleState,
  to: CanonicalModelLifecycleState,
): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class ModelLifecycleStateMachine {
  private currentState: CanonicalModelLifecycleState;
  private verifiedSha256Hex: string | null;
  private inferenceVerifiedAtMs: number | null;
  private updatedAtMs: number;
  private readonly history: ModelStateTransitionRecord[];

  constructor(
    public readonly modelId: string,
    public readonly version: string,
    initialState: CanonicalModelLifecycleState = 'DISCOVERED',
    options?: {
      readonly verifiedSha256Hex?: string | null;
      readonly inferenceVerifiedAtMs?: number | null;
      readonly updatedAtMs?: number;
      readonly history?: readonly ModelStateTransitionRecord[];
    },
  ) {
    this.currentState = initialState;
    this.verifiedSha256Hex = options?.verifiedSha256Hex ?? null;
    this.inferenceVerifiedAtMs = options?.inferenceVerifiedAtMs ?? null;
    this.updatedAtMs = options?.updatedAtMs ?? Date.now();
    this.history = options?.history ? [...options.history] : [];
  }

  public getState(): CanonicalModelLifecycleState {
    return this.currentState;
  }

  public isOperationalForInference(): boolean {
    return this.currentState === 'ACTIVE' && this.inferenceVerifiedAtMs !== null;
  }

  public transition(
    nextState: CanonicalModelLifecycleState,
    reason: string,
    options?: {
      readonly nowMs?: number;
      readonly verifiedSha256Hex?: string;
    },
  ): ModelStateTransitionRecord {
    const nowMs = options?.nowMs ?? Date.now();
    if (!isLegalModelStateTransition(this.currentState, nextState)) {
      throw new InvalidModelStateTransitionError(
        this.currentState,
        nextState,
        reason,
      );
    }

    if (nextState === 'ACTIVE' && this.inferenceVerifiedAtMs === null) {
      throw new InvalidModelStateTransitionError(
        this.currentState,
        nextState,
        'ACTIVE requires prior INFERENCE_VERIFIED execution evidence.',
      );
    }

    if (options?.verifiedSha256Hex) {
      this.verifiedSha256Hex = options.verifiedSha256Hex.toLowerCase();
    }
    if (nextState === 'INFERENCE_VERIFIED') {
      this.inferenceVerifiedAtMs = nowMs;
    }
    if (
      nextState === 'CORRUPTED' ||
      nextState === 'REVOKED' ||
      nextState === 'REMOVAL_PENDING' ||
      nextState === 'UNAVAILABLE'
    ) {
      this.inferenceVerifiedAtMs = null;
    }

    const record: ModelStateTransitionRecord = {
      from: this.currentState,
      to: nextState,
      timestampMs: nowMs,
      reason,
      modelId: this.modelId,
      version: this.version,
    };

    this.currentState = nextState;
    this.updatedAtMs = nowMs;
    this.history.push(record);
    return record;
  }

  public toPersistedLedger(): PersistedModelStateLedger {
    return {
      schemaVersion: 1,
      modelId: this.modelId,
      version: this.version,
      currentState: this.currentState,
      verifiedSha256Hex: this.verifiedSha256Hex,
      inferenceVerifiedAtMs: this.inferenceVerifiedAtMs,
      updatedAtMs: this.updatedAtMs,
      history: [...this.history],
    };
  }

  /**
   * Safely restores a persisted state machine after application restart.
   * Transient states (`DOWNLOADING`, `INSTALLING`, `RUNTIME_INITIALIZED`) downgrade honestly
   * to their safe durable restart state (`DOWNLOAD_INTERRUPTED`, `UNAVAILABLE`, `COMPATIBILITY_VERIFIED`).
   */
  public static restoreFromLedger(raw: unknown): ModelLifecycleStateMachine {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('INVALID_MODEL_STATE_LEDGER: Expected JSON object.');
    }
    const ledger = raw as Partial<PersistedModelStateLedger>;
    if (
      ledger.schemaVersion !== 1 ||
      typeof ledger.modelId !== 'string' ||
      typeof ledger.version !== 'string' ||
      !ALL_CANONICAL_MODEL_STATES.includes(ledger.currentState as CanonicalModelLifecycleState)
    ) {
      throw new Error('INVALID_MODEL_STATE_LEDGER: Missing or unsupported ledger fields.');
    }

    let recoveredState = ledger.currentState as CanonicalModelLifecycleState;
    let recoveredInferenceVerifiedAt = ledger.inferenceVerifiedAtMs ?? null;

    if (recoveredState === 'DOWNLOADING') {
      recoveredState = 'DOWNLOAD_INTERRUPTED';
    } else if (recoveredState === 'INSTALLING') {
      recoveredState = 'UNAVAILABLE';
      recoveredInferenceVerifiedAt = null;
    } else if (recoveredState === 'RUNTIME_INITIALIZED') {
      // In-memory runtime sessions do not survive restart; model must re-initialize runtime
      recoveredState = 'COMPATIBILITY_VERIFIED';
    } else if (recoveredState === 'ACTIVE' && recoveredInferenceVerifiedAt === null) {
      recoveredState = 'INSTALLED';
    }

    return new ModelLifecycleStateMachine(ledger.modelId, ledger.version, recoveredState, {
      verifiedSha256Hex: ledger.verifiedSha256Hex ?? null,
      inferenceVerifiedAtMs: recoveredInferenceVerifiedAt,
      updatedAtMs: typeof ledger.updatedAtMs === 'number' ? ledger.updatedAtMs : Date.now(),
      history: Array.isArray(ledger.history) ? ledger.history : [],
    });
  }
}
