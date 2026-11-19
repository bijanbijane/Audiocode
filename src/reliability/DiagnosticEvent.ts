import { AvapardazErrorCode, ErrorSeverity, ReliabilitySubsystemId } from './ErrorCode';

export interface DiagnosticEventRecord {
  readonly eventId: string;
  readonly timestampIso: string;
  readonly lastSeenIso: string;
  readonly severity: ErrorSeverity;
  readonly subsystem: ReliabilitySubsystemId;
  readonly code: AvapardazErrorCode | string;
  readonly message: string;
  readonly operationId: string | null;
  readonly correlationId: string | null;
  readonly occurrenceCount: number;
  readonly fingerprint: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DiagnosticRetentionPolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  readonly dedupeWindowMs: number;
}

export const DEFAULT_DIAGNOSTIC_RETENTION_POLICY: DiagnosticRetentionPolicy = {
  maxEntries: 250,
  maxBytes: 256 * 1024, // 256 KiB bounded local store
  maxAgeMs: 14 * 24 * 60 * 60 * 1000, // 14 days
  dedupeWindowMs: 60 * 1000, // coalesce identical repeated errors within 60s
};

export interface DiagnosticFilterOptions {
  readonly severities?: readonly ErrorSeverity[];
  readonly subsystems?: readonly ReliabilitySubsystemId[];
  readonly limit?: number;
}
