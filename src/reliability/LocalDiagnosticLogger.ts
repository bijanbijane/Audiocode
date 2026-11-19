import { AvapardazError } from './AvapardazError';
import {
  DEFAULT_DIAGNOSTIC_RETENTION_POLICY,
  DiagnosticEventRecord,
  DiagnosticFilterOptions,
  DiagnosticRetentionPolicy,
} from './DiagnosticEvent';
import { DiagnosticRetentionManager } from './DiagnosticRetentionManager';
import { sanitizeDiagnosticMetadata, sanitizeDiagnosticString } from './DiagnosticSanitizer';
import { AvapardazErrorCode, ErrorSeverity, ReliabilitySubsystemId } from './ErrorCode';
import { AVAPARDAZ_VERSION_CONTRACT } from '../lifecycle/VersionCompatibilityContract';

export interface DiagnosticStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LogDiagnosticInput {
  readonly severity: ErrorSeverity;
  readonly subsystem: ReliabilitySubsystemId;
  readonly code: AvapardazErrorCode | string;
  readonly message: string;
  readonly operationId?: string | null;
  readonly correlationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const DEFAULT_STORAGE_KEY = 'avapardaz.local.diagnostics.v1';

function createDefaultStorageAdapter(): DiagnosticStorageAdapter | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Bounded, sanitized, deduplicating Local-First Diagnostic Logger.
 * Never transmits remotely; falls back to bounded in-memory buffer if storage fails; never throws.
 */
export class LocalDiagnosticLogger {
  private readonly retention: DiagnosticRetentionManager;
  private readonly storageKey: string;
  private readonly storage: DiagnosticStorageAdapter | null;
  private readonly clock: () => number;
  private entries: DiagnosticEventRecord[] = [];
  private usingInMemoryFallback = false;
  private seq = 0;

  constructor(options?: {
    readonly policy?: Partial<DiagnosticRetentionPolicy>;
    readonly storage?: DiagnosticStorageAdapter | null;
    readonly storageKey?: string;
    readonly clock?: () => number;
  }) {
    this.retention = new DiagnosticRetentionManager(options?.policy ?? DEFAULT_DIAGNOSTIC_RETENTION_POLICY);
    this.storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY;
    this.storage = options?.storage !== undefined ? options.storage : createDefaultStorageAdapter();
    this.clock = options?.clock ?? (() => Date.now());
    this.loadFromStorageSafe();
  }

  public isUsingInMemoryFallback(): boolean {
    return this.usingInMemoryFallback;
  }

  public log(input: LogDiagnosticInput): DiagnosticEventRecord {
    const nowMs = this.clock();
    const nowIso = new Date(nowMs).toISOString();
    const safeMsg = sanitizeDiagnosticString(input.message);
    const safeMeta = sanitizeDiagnosticMetadata(input.metadata);
    const fingerprint = `${input.severity}|${input.subsystem}|${input.code}|${safeMsg}`;

    // Deduplicate repeated identical errors within dedupeWindowMs to prevent flooding
    const lastIdx = this.entries.length - 1;
    for (let i = lastIdx; i >= Math.max(0, lastIdx - 12); i -= 1) {
      const existing = this.entries[i];
      if (existing.fingerprint === fingerprint) {
        const lastMs = Date.parse(existing.lastSeenIso);
        if (!Number.isNaN(lastMs) && nowMs - lastMs <= this.retention.policy.dedupeWindowMs) {
          const updated: DiagnosticEventRecord = {
            ...existing,
            lastSeenIso: nowIso,
            occurrenceCount: existing.occurrenceCount + 1,
            correlationId: input.correlationId ?? existing.correlationId,
          };
          this.entries[i] = updated;
          this.enforceAndPersistSafe(nowMs);
          return updated;
        }
      }
    }

    this.seq += 1;
    const record: DiagnosticEventRecord = {
      eventId: `diag_${nowMs.toString(36)}_${this.seq.toString(36)}`,
      timestampIso: nowIso,
      lastSeenIso: nowIso,
      severity: input.severity,
      subsystem: input.subsystem,
      code: input.code,
      message: safeMsg,
      operationId: input.operationId ?? null,
      correlationId: input.correlationId ?? null,
      occurrenceCount: 1,
      fingerprint,
      metadata: safeMeta,
    };

    this.entries.push(record);
    this.enforceAndPersistSafe(nowMs);
    return record;
  }

  public logError(error: AvapardazError): DiagnosticEventRecord {
    return this.log({
      severity: error.severity,
      subsystem: error.subsystem,
      code: error.code,
      message: error.technicalMessage,
      operationId: error.operationId,
      correlationId: error.correlationId,
      metadata: {
        recoverability: error.recoverability,
        retryRecommended: error.retryRecommended,
        originalDataSafe: error.originalDataSafe,
        ...error.metadata,
      },
    });
  }

  public query(filter: DiagnosticFilterOptions = {}): readonly DiagnosticEventRecord[] {
    let list = [...this.entries];
    if (filter.severities && filter.severities.length > 0) {
      const set = new Set(filter.severities);
      list = list.filter((e) => set.has(e.severity));
    }
    if (filter.subsystems && filter.subsystems.length > 0) {
      const set = new Set(filter.subsystems);
      list = list.filter((e) => set.has(e.subsystem));
    }
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      list = list.slice(-filter.limit);
    }
    return list;
  }

  public clear(): void {
    this.entries = [];
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey);
      } catch {
        this.usingInMemoryFallback = true;
      }
    }
  }

  public exportSanitizedBundle(filter: DiagnosticFilterOptions = {}): {
    readonly exportedAtIso: string;
    readonly appVersion: string;
    readonly storageMode: 'LOCAL_STORAGE' | 'IN_MEMORY_FALLBACK';
    readonly privacyGuarantee: string;
    readonly entryCount: number;
    readonly entries: readonly DiagnosticEventRecord[];
  } {
    const filtered = this.query(filter);
    return {
      exportedAtIso: new Date(this.clock()).toISOString(),
      appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
      storageMode: this.usingInMemoryFallback || !this.storage ? 'IN_MEMORY_FALLBACK' : 'LOCAL_STORAGE',
      privacyGuarantee:
        'Contains strictly sanitized operational metadata. Excludes audio buffers, transcripts, user edits, tokens, API keys, and full local file paths.',
      entryCount: filtered.length,
      entries: filtered,
    };
  }

  private loadFromStorageSafe(): void {
    if (!this.storage) {
      this.usingInMemoryFallback = true;
      return;
    }
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(
          (item): item is DiagnosticEventRecord =>
            item &&
            typeof item === 'object' &&
            typeof item.eventId === 'string' &&
            typeof item.code === 'string',
        );
        const applied = this.retention.applyRetention(this.entries, this.clock());
        this.entries = applied.records;
      }
    } catch {
      this.entries = [];
      this.usingInMemoryFallback = true;
    }
  }

  private enforceAndPersistSafe(nowMs: number): void {
    const applied = this.retention.applyRetention(this.entries, nowMs);
    this.entries = applied.records;

    if (!this.storage) {
      this.usingInMemoryFallback = true;
      return;
    }
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.entries));
      this.usingInMemoryFallback = false;
    } catch {
      // Storage full or blocked: stay safely in bounded in-memory buffer without crashing
      this.usingInMemoryFallback = true;
    }
  }
}

let sharedDiagnosticLogger: LocalDiagnosticLogger | null = null;

export function getSharedDiagnosticLogger(): LocalDiagnosticLogger {
  if (!sharedDiagnosticLogger) {
    sharedDiagnosticLogger = new LocalDiagnosticLogger();
  }
  return sharedDiagnosticLogger;
}
