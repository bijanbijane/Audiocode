import { AvapardazError, isAvapardazError } from './AvapardazError';
import { AvapardazErrorCode, ReliabilitySubsystemId } from './ErrorCode';
import { MemoryPressureError } from '../runtime/memory/MemoryBudgetManager';

export interface ErrorClassificationContext {
  readonly subsystem?: ReliabilitySubsystemId;
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly defaultCode?: AvapardazErrorCode;
  readonly isNonIdempotent?: boolean;
}

function stripSensitivePathsFromMessage(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<local-path>')
    .replace(/\/(?:Users|home|var|tmp|mnt|Volumes)\/[^\s'"]+/g, '<local-path>')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer <redacted>')
    .slice(0, 400);
}

/**
 * Classifies arbitrary runtime exceptions into explicit, non-collapsed AvapardazError instances.
 */
export function classifyError(
  error: unknown,
  context: ErrorClassificationContext = {},
): AvapardazError {
  if (isAvapardazError(error)) {
    if (context.isNonIdempotent && error.retryRecommended) {
      return new AvapardazError({
        code: error.code,
        subsystem: error.subsystem,
        severity: error.severity,
        recoverability: 'RECOVERABLE',
        userSafeMessageFa: error.userSafeMessageFa,
        userSafeMessageEn: error.userSafeMessageEn,
        technicalMessage: error.technicalMessage,
        operationId: context.operationId ?? error.operationId ?? undefined,
        correlationId: context.correlationId ?? error.correlationId,
        retryRecommended: false,
        originalDataSafe: error.originalDataSafe,
        recoveryAction: error.recoveryAction,
        metadata: error.metadata,
        cause: error.cause ?? error,
      });
    }
    return error;
  }

  const rawMsg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown operational failure';
  const safeMsg = stripSensitivePathsFromMessage(rawMsg);
  const lower = rawMsg.toLowerCase();
  const errName = error instanceof Error ? error.name : '';

  let code: AvapardazErrorCode = context.defaultCode ?? 'INTERNAL_UNEXPECTED_ERROR';
  let subsystem: ReliabilitySubsystemId | undefined = context.subsystem;

  if (
    error instanceof MemoryPressureError ||
    lower.includes('memory_pressure') ||
    lower.includes('hard application limit') ||
    lower.includes('memory budget')
  ) {
    code = 'MEMORY_BUDGET_EXCEEDED';
    subsystem = 'MEMORY_BUDGET';
  } else if (
    errName === 'QuotaExceededError' ||
    lower.includes('quotaexceeded') ||
    lower.includes('quota exceeded') ||
    lower.includes('output_quota_exceeded')
  ) {
    code = 'STORAGE_QUOTA_EXCEEDED';
    subsystem = subsystem ?? 'LOCAL_STORAGE';
  } else if (
    lower.includes('checksum') ||
    lower.includes('sha-256') ||
    lower.includes('sha256') ||
    lower.includes('integrity')
  ) {
    code = subsystem === 'ASR_MODEL' ? 'MODEL_CHECKSUM_MISMATCH' : 'PROJECT_CORRUPTED';
  } else if (lower.includes('model_not_installed') || lower.includes('no local model')) {
    code = 'MODEL_NOT_INSTALLED';
    subsystem = 'ASR_MODEL';
  } else if (lower.includes('onnx') || lower.includes('wasm runtime')) {
    code = lower.includes('load') ? 'MODEL_LOAD_FAILED' : 'ASR_RUNTIME_UNAVAILABLE';
    subsystem = 'ASR_RUNTIME';
  } else if (lower.includes('worker') && lower.includes('timeout')) {
    code = 'WORKER_TIMEOUT';
    subsystem = 'WORKER_INFRA';
  } else if (lower.includes('worker') && (lower.includes('crash') || lower.includes('terminated'))) {
    code = 'WORKER_CRASHED';
    subsystem = 'WORKER_INFRA';
  } else if (
    errName === 'EncodingError' ||
    lower.includes('decodeaudiodata') ||
    lower.includes('decode')
  ) {
    code = 'AUDIO_DECODE_FAILED';
    subsystem = 'AUDIO_DECODE';
  } else if (lower.includes('opfs') || lower.includes('indexeddb') || lower.includes('storage unavailable')) {
    code = 'STORAGE_UNAVAILABLE';
    subsystem = subsystem ?? 'LOCAL_STORAGE';
  } else if (lower.includes('incompatible') && (lower.includes('schema') || lower.includes('version'))) {
    code = 'UPDATE_INCOMPATIBLE';
    subsystem = subsystem ?? 'UPDATE_MANAGER';
  }

  return new AvapardazError({
    code,
    subsystem,
    technicalMessage: safeMsg,
    operationId: context.operationId,
    correlationId: context.correlationId,
    retryRecommended: context.isNonIdempotent ? false : undefined,
    cause: error,
  });
}
