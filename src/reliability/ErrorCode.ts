/**
 * Central Error Taxonomy for Avapardaz (AVP-P10-001)
 * Stable machine-readable codes, severities, recoverability classes, and subsystem identifiers.
 */

export type ErrorSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type ErrorRecoverability =
  | 'RECOVERABLE'
  | 'RETRYABLE'
  | 'REQUIRES_USER_ACTION'
  | 'NON_RECOVERABLE'
  | 'UNKNOWN';

export type ReliabilitySubsystemId =
  | 'AUDIO_IMPORT'
  | 'AUDIO_DECODE'
  | 'AUDIO_PLAYBACK'
  | 'ASR_MODEL'
  | 'ASR_RUNTIME'
  | 'WORKER_INFRA'
  | 'MEMORY_BUDGET'
  | 'LOCAL_STORAGE'
  | 'OPFS_STORAGE'
  | 'PROJECT_PERSISTENCE'
  | 'TRANSCRIPT_PERSISTENCE'
  | 'TIMELINE_ENGINE'
  | 'EDL_ENGINE'
  | 'AUDIO_RENDERER'
  | 'EXPORT_PIPELINE'
  | 'RECOVERY_ENGINE'
  | 'OFFLINE_SHELL'
  | 'UPDATE_MANAGER'
  | 'DIAGNOSTICS'
  | 'INTERNAL';

export const AVAPARDAZ_ERROR_CODES = [
  'AUDIO_IMPORT_FAILED',
  'AUDIO_DECODE_FAILED',
  'MODEL_NOT_INSTALLED',
  'MODEL_CHECKSUM_MISMATCH',
  'MODEL_LOAD_FAILED',
  'ASR_RUNTIME_UNAVAILABLE',
  'ASR_INFERENCE_FAILED',
  'WORKER_CRASHED',
  'WORKER_TIMEOUT',
  'MEMORY_BUDGET_EXCEEDED',
  'STORAGE_UNAVAILABLE',
  'STORAGE_QUOTA_EXCEEDED',
  'PROJECT_PERSISTENCE_FAILED',
  'PROJECT_CORRUPTED',
  'TRANSCRIPT_PERSISTENCE_FAILED',
  'TIMELINE_TRANSACTION_FAILED',
  'RENDER_FAILED',
  'EXPORT_FAILED',
  'RECOVERY_FAILED',
  'UPDATE_INCOMPATIBLE',
  'INTERNAL_UNEXPECTED_ERROR',
] as const;

export type AvapardazErrorCode = (typeof AVAPARDAZ_ERROR_CODES)[number];

export function isAvapardazErrorCode(value: unknown): value is AvapardazErrorCode {
  return (
    typeof value === 'string' &&
    (AVAPARDAZ_ERROR_CODES as readonly string[]).includes(value)
  );
}
