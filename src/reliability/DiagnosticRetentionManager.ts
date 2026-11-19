import {
  DEFAULT_DIAGNOSTIC_RETENTION_POLICY,
  DiagnosticEventRecord,
  DiagnosticRetentionPolicy,
} from './DiagnosticEvent';

export interface RetentionApplyResult {
  readonly records: DiagnosticEventRecord[];
  readonly evictedCount: number;
  readonly serializedBytes: number;
}

export class DiagnosticRetentionManager {
  public readonly policy: DiagnosticRetentionPolicy;

  constructor(policy: Partial<DiagnosticRetentionPolicy> = {}) {
    this.policy = {
      maxEntries: Math.max(10, policy.maxEntries ?? DEFAULT_DIAGNOSTIC_RETENTION_POLICY.maxEntries),
      maxBytes: Math.max(4096, policy.maxBytes ?? DEFAULT_DIAGNOSTIC_RETENTION_POLICY.maxBytes),
      maxAgeMs: Math.max(60_000, policy.maxAgeMs ?? DEFAULT_DIAGNOSTIC_RETENTION_POLICY.maxAgeMs),
      dedupeWindowMs: Math.max(
        1_000,
        policy.dedupeWindowMs ?? DEFAULT_DIAGNOSTIC_RETENTION_POLICY.dedupeWindowMs,
      ),
    };
  }

  public applyRetention(
    records: readonly DiagnosticEventRecord[],
    nowMs: number = Date.now(),
  ): RetentionApplyResult {
    const cutoffMs = nowMs - this.policy.maxAgeMs;
    let working = records.filter((rec) => {
      const ts = Date.parse(rec.lastSeenIso);
      return Number.isNaN(ts) || ts >= cutoffMs;
    });

    let evictedCount = records.length - working.length;

    // Enforce maxEntries (keep newest)
    if (working.length > this.policy.maxEntries) {
      const overflow = working.length - this.policy.maxEntries;
      working = working.slice(overflow);
      evictedCount += overflow;
    }

    // Enforce maxBytes by rotating oldest entries first
    let serializedBytes = new TextEncoder().encode(JSON.stringify(working)).byteLength;
    while (working.length > 1 && serializedBytes > this.policy.maxBytes) {
      working = working.slice(1);
      evictedCount += 1;
      serializedBytes = new TextEncoder().encode(JSON.stringify(working)).byteLength;
    }

    return {
      records: working,
      evictedCount,
      serializedBytes,
    };
  }
}
