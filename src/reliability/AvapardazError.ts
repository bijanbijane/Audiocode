import {
  AvapardazErrorCode,
  ErrorRecoverability,
  ErrorSeverity,
  ReliabilitySubsystemId,
} from './ErrorCode';
import { getRecoveryPolicy, RecoveryActionRecommendation } from './RecoveryPolicy';

export interface AvapardazErrorOptions {
  readonly code: AvapardazErrorCode;
  readonly subsystem?: ReliabilitySubsystemId;
  readonly severity?: ErrorSeverity;
  readonly recoverability?: ErrorRecoverability;
  readonly userSafeMessageFa?: string;
  readonly userSafeMessageEn?: string;
  readonly technicalMessage: string;
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly retryRecommended?: boolean;
  readonly originalDataSafe?: boolean;
  readonly recoveryAction?: RecoveryActionRecommendation;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  readonly cause?: unknown;
}

let correlationSeq = 0;

export function generateCorrelationId(prefix = 'corr'): string {
  correlationSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${correlationSeq.toString(36)}`;
}

export class AvapardazError extends Error {
  public readonly code: AvapardazErrorCode;
  public readonly subsystem: ReliabilitySubsystemId;
  public readonly severity: ErrorSeverity;
  public readonly recoverability: ErrorRecoverability;
  public readonly userSafeMessageFa: string;
  public readonly userSafeMessageEn: string;
  public readonly technicalMessage: string;
  public readonly timestampIso: string;
  public readonly operationId: string | null;
  public readonly correlationId: string;
  public readonly retryRecommended: boolean;
  public readonly originalDataSafe: boolean;
  public readonly recoveryAction: RecoveryActionRecommendation;
  public readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  public readonly cause?: unknown;

  constructor(options: AvapardazErrorOptions) {
    const policy = getRecoveryPolicy(options.code);
    super(options.technicalMessage);
    this.name = 'AvapardazError';
    this.code = options.code;
    this.subsystem = options.subsystem ?? policy.defaultSubsystem;
    this.severity = options.severity ?? policy.defaultSeverity;
    this.recoverability = options.recoverability ?? policy.defaultRecoverability;
    this.userSafeMessageFa = options.userSafeMessageFa ?? policy.userMessageFa;
    this.userSafeMessageEn = options.userSafeMessageEn ?? policy.userMessageEn;
    this.technicalMessage = options.technicalMessage;
    this.timestampIso = new Date().toISOString();
    this.operationId = options.operationId ?? null;
    this.correlationId = options.correlationId ?? generateCorrelationId('err');
    this.retryRecommended = options.retryRecommended ?? policy.retryRecommended;
    this.originalDataSafe = options.originalDataSafe ?? policy.originalDataSafe;
    this.recoveryAction = options.recoveryAction ?? policy.recoveryAction;
    this.metadata = options.metadata ? { ...options.metadata } : {};
    this.cause = options.cause;
  }

  public toSafeDiagnosticRecord(): {
    readonly code: AvapardazErrorCode;
    readonly subsystem: ReliabilitySubsystemId;
    readonly severity: ErrorSeverity;
    readonly recoverability: ErrorRecoverability;
    readonly timestampIso: string;
    readonly operationId: string | null;
    readonly correlationId: string;
    readonly retryRecommended: boolean;
    readonly originalDataSafe: boolean;
    readonly technicalMessage: string;
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  } {
    return {
      code: this.code,
      subsystem: this.subsystem,
      severity: this.severity,
      recoverability: this.recoverability,
      timestampIso: this.timestampIso,
      operationId: this.operationId,
      correlationId: this.correlationId,
      retryRecommended: this.retryRecommended,
      originalDataSafe: this.originalDataSafe,
      technicalMessage: this.technicalMessage,
      metadata: { ...this.metadata },
    };
  }
}

export function isAvapardazError(value: unknown): value is AvapardazError {
  return value instanceof AvapardazError;
}
