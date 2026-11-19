import { ProjectDocument } from '../contracts/project-schema.contract';
import { AssetIdentityRecord } from '../project-core/ProjectLifecycleAndMigrationEngine';
import { isQuotaExceededError } from '../engine/workerStorageCore';
import {
  assertValidProjectId,
  buildVerifiedCheckpointEnvelope,
  CheckpointShutdownState,
  DEFAULT_MAX_CHECKPOINT_BYTES,
  encodeProjectStorageKey,
  EnvelopeVerificationResult,
  MediaAssetVerificationSummary,
  RecoveryCheckpointEnvelope,
  RecoveryErrorCode,
  RecoveryInspectionStatus,
  validateProjectId,
  verifyAndParseCheckpointEnvelope,
  verifyRecoveredMediaReferences,
} from './RecoveryCheckpointSchema';
import {
  AtomicLeaseStore,
  generateSecureSessionId,
  getDefaultBrowserIndexedDbLeaseStore,
  getDefaultBrowserWebLocksCoordinator,
  LockLossEvent,
  ProjectLockAcquisitionResult,
  ProjectLockReasonCode,
  ProjectLockReleaseResult,
  ProjectLockRenewalResult,
  ProjectLockState,
  ProjectLockStrategy,
  WebLocksCoordinator,
} from './ProjectLockAdapters';

export * from './RecoveryCheckpointSchema';
export * from './ProjectLockAdapters';

/**
 * Backward-compatible projection of a verified RecoveryCheckpointEnvelope.
 */
export interface RecoveryCheckpointRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly dirtyShutdownDetected: boolean;
  readonly lastCheckpointTimestamp: number;
  readonly snapshot: ProjectDocument;
  readonly checkpointId?: string;
  readonly sequenceNumber?: number;
  readonly envelopeVersion?: number;
  readonly digestHex?: string;
  readonly requiredAssetIdentities?: readonly AssetIdentityRecord[];
}

export interface RecoveryJournalStore {
  /** Whether this store guarantees durable persistence across page reloads/crashes. */
  readonly isDurable?: boolean;
  /** Storage backend label for diagnostics (never exposes host OS paths). */
  readonly backendName?: string;
  write(projectId: string, jsonPayload: string): Promise<void>;
  read(projectId: string): Promise<string | null>;
  /**
   * Optional interruption-safe atomic commit primitive.
   * Writes to temp file / transaction, verifies digest, preserves previous valid checkpoint
   * on failure, and cleans up obsolete temp files.
   */
  writeAtomic?(params: {
    readonly projectKey: string;
    readonly projectId: string;
    readonly checkpointId: string;
    readonly sequenceNumber: number;
    readonly jsonPayload: string;
    readonly expectedDigestHex: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** Optional raw read by safe encoded projectKey. */
  readByKey?(projectKey: string): Promise<string | null>;
  /** Optional cleanup of obsolete temporary checkpoint files without deleting valid checkpoints. */
  cleanupObsoleteTempFiles?(projectKey: string): Promise<number>;
}

export interface OpfsRecoveryWritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

export interface OpfsRecoveryFileHandleLike {
  createWritable(): Promise<OpfsRecoveryWritableLike>;
  getFile(): Promise<{ text(): Promise<string> }>;
}

export interface OpfsRecoveryDirectoryLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsRecoveryDirectoryLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsRecoveryFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?: () => AsyncIterable<[string, { kind: 'file' | 'directory'; name: string }]>;
}

export interface RecoveryWriteResult {
  readonly persisted: boolean;
  readonly status: 'PERSISTED' | 'DEGRADED_STORAGE_UNAVAILABLE' | 'FAILED';
  readonly errorCode: RecoveryErrorCode | null;
  readonly message: string;
  readonly envelope: RecoveryCheckpointEnvelope | null;
  readonly byteLength: number;
}

export interface CrashRecoveryInspectionResult {
  readonly status: RecoveryInspectionStatus;
  readonly errorCode: RecoveryErrorCode | null;
  readonly message: string;
  readonly projectId: string;
  readonly durableStorageAvailable: boolean;
  readonly envelope: RecoveryCheckpointEnvelope | null;
  readonly migratedSnapshot: ProjectDocument | null;
  readonly record: RecoveryCheckpointRecord | null;
  readonly wasMigrated: boolean;
  readonly validationErrors: readonly string[];
}

export interface SafeCrashRecoveryPlan {
  readonly canRestore: boolean;
  readonly status: RecoveryInspectionStatus;
  readonly errorCode: RecoveryErrorCode | null;
  readonly message: string;
  readonly projectId: string;
  readonly lockHeldByCurrentSession: boolean;
  readonly lockHeldByAnotherSession: boolean;
  readonly hasRevisionConflict: boolean;
  readonly hasNewerCheckpointConflict: boolean;
  readonly currentSavedRevision: number | null;
  readonly recoveredRevision: number | null;
  readonly envelope: RecoveryCheckpointEnvelope | null;
  readonly migratedSnapshot: ProjectDocument | null;
  readonly wasMigrated: boolean;
  readonly mediaVerification: MediaAssetVerificationSummary | null;
}

export interface SafeCrashRecoveryExecutionResult {
  readonly restored: boolean;
  readonly status: RecoveryInspectionStatus;
  readonly errorCode: RecoveryErrorCode | null;
  readonly message: string;
  readonly document: ProjectDocument;
  readonly originalProjectPreserved: boolean;
  readonly wasMigrated: boolean;
  readonly mediaVerification: MediaAssetVerificationSummary | null;
  readonly restoredCheckpointId: string | null;
  readonly restoredSequenceNumber: number | null;
}

export interface CrashRecoveryAndSessionLockOptions {
  readonly journalStore?: RecoveryJournalStore | null;
  readonly webLocksCoordinator?: WebLocksCoordinator | null;
  readonly leaseStore?: AtomicLeaseStore | null;
  /** Disable automatic global navigator.locks / indexedDB discovery (useful for deterministic failure tests). */
  readonly disableDefaultLockBackends?: boolean;
  /** Disable automatic global OPFS / IndexedDB journal discovery (useful for deterministic storage-unavailable tests). */
  readonly disableDefaultJournalBackends?: boolean;
  /** Allow same-tab ref-counting when multiple components in the same tab open the same project. Default true. */
  readonly allowSameTabRefCount?: boolean;
  /** Lease TTL in ms for IndexedDB fallback locking. Default 30_000ms. */
  readonly leaseTtlMs?: number;
  /** Automatic renewal interval in ms for IndexedDB fallback locking (0 disables background timers). Default 10_000ms. */
  readonly leaseRenewIntervalMs?: number;
  /** Maximum checkpoint envelope size in bytes. */
  readonly maxCheckpointBytes?: number;
  /** Current supported audio engine major version for compatibility validation. */
  readonly currentSupportedEngineMajor?: number;
  /** Injectable deterministic clock for testing lease expiration/renewal without sleeps. */
  readonly nowFn?: () => number;
  /** Optional explicit session ID override (must still be non-empty). */
  readonly sessionId?: string;
}

const RECOVERY_DIR_NAME = 'recovery-journal';
const IDB_JOURNAL_DB_NAME = 'avapardaz_recovery_journal_v1';
const IDB_JOURNAL_STORE_NAME = 'checkpoints';
const IDB_JOURNAL_DB_VERSION = 1;

function classifyStorageError(err: unknown, fallbackCode: RecoveryErrorCode): {
  code: RecoveryErrorCode;
  message: string;
} {
  if (isQuotaExceededError(err)) {
    return {
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: 'Browser storage quota exceeded while saving crash recovery checkpoint.',
    };
  }
  if (err && typeof err === 'object') {
    const rec = err as { name?: unknown; code?: unknown; message?: unknown };
    if (
      rec.name === 'NotAllowedError' ||
      rec.name === 'SecurityError' ||
      rec.code === 'STORAGE_PERMISSION_DENIED'
    ) {
      return {
        code: 'STORAGE_PERMISSION_DENIED',
        message: 'Permission denied accessing browser recovery storage.',
      };
    }
    if (rec.name === 'AbortError' || rec.code === 'WRITE_CANCELLED') {
      return {
        code: 'WRITE_CANCELLED',
        message: 'Recovery checkpoint write was cancelled.',
      };
    }
    if (typeof rec.code === 'string') {
      return {
        code: rec.code as RecoveryErrorCode,
        message:
          typeof rec.message === 'string' && rec.message.length > 0
            ? sanitizeErrorMessage(rec.message)
            : 'Recovery storage operation failed.',
      };
    }
  }
  return {
    code: fallbackCode,
    message:
      err instanceof Error
        ? sanitizeErrorMessage(err.message)
        : 'Recovery storage operation failed.',
  };
}

/**
 * Strips any accidental host/filesystem path segments from error messages before exposing them.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<storage>')
    .replace(/\/(?:Users|home|var|tmp|etc|app|opt|mnt)\/[^\s'"]+/g, '<storage>');
}

function makeCodedError(code: RecoveryErrorCode, message: string): Error {
  const err = new Error(`${code}: ${message}`);
  (err as Error & { code?: RecoveryErrorCode }).code = code;
  return err;
}

/**
 * Interruption-safe OPFS recovery journal store.
 * Writes to a unique temporary file first, verifies read-back digest, rotates the prior
 * checkpoint into a bounded single backup slot (`.prev.json`), then replaces `.current.json`
 * and deletes the temporary file.
 */
export class OpfsRecoveryJournalStore implements RecoveryJournalStore {
  public readonly isDurable = true;
  public readonly backendName = 'OPFS';

  constructor(private readonly getRootDirectory: () => Promise<OpfsRecoveryDirectoryLike>) {}

  private async getRecoveryDir(create: boolean): Promise<OpfsRecoveryDirectoryLike> {
    const root = await this.getRootDirectory();
    return root.getDirectoryHandle(RECOVERY_DIR_NAME, { create });
  }

  public async write(projectId: string, jsonPayload: string): Promise<void> {
    const projectKey = encodeProjectStorageKey(projectId);
    const parsed = JSON.parse(jsonPayload) as Partial<RecoveryCheckpointEnvelope>;
    await this.writeAtomic({
      projectKey,
      projectId,
      checkpointId: parsed.checkpointId ?? generateSecureSessionId('chk'),
      sequenceNumber: parsed.sequenceNumber ?? 1,
      jsonPayload,
      expectedDigestHex: parsed.integrity?.digestHex ?? '',
    });
  }

  public async writeAtomic(params: {
    readonly projectKey: string;
    readonly projectId: string;
    readonly checkpointId: string;
    readonly sequenceNumber: number;
    readonly jsonPayload: string;
    readonly expectedDigestHex: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (params.signal?.aborted) {
      throw makeCodedError('WRITE_CANCELLED', 'Checkpoint write cancelled before starting.');
    }

    const recDir = await this.getRecoveryDir(true);
    const safeCheckpointSuffix = params.checkpointId.replace(/[^A-Za-z0-9_-]/g, '');
    const tmpName = `${params.projectKey}.tmp.${safeCheckpointSuffix}.json`;
    const currentName = `${params.projectKey}.current.json`;
    const prevName = `${params.projectKey}.prev.json`;

    // 1. Write to isolated temporary file
    const tmpHandle = await recDir.getFileHandle(tmpName, { create: true });
    let tmpWritable: OpfsRecoveryWritableLike | null = null;
    try {
      tmpWritable = await tmpHandle.createWritable();
      await tmpWritable.write(params.jsonPayload);
      if (params.signal?.aborted) {
        if (typeof tmpWritable.abort === 'function') {
          await tmpWritable.abort().catch(() => {});
        } else {
          await tmpWritable.close().catch(() => {});
        }
        await recDir.removeEntry(tmpName).catch(() => {});
        throw makeCodedError('WRITE_CANCELLED', 'Checkpoint write cancelled during staging.');
      }
      await tmpWritable.close();
      tmpWritable = null;

      // 2. Read back staged temp file and verify integrity before touching `.current.json`
      const stagedText = await (await tmpHandle.getFile()).text();
      if (stagedText !== params.jsonPayload) {
        throw makeCodedError('STORAGE_WRITE_FAILED', 'Staged checkpoint verification mismatch.');
      }
      if (params.expectedDigestHex) {
        const verified = await verifyAndParseCheckpointEnvelope({
          rawJson: stagedText,
          expectedProjectId: params.projectId,
        });
        if (!verified.envelope || verified.envelope.integrity.digestHex !== params.expectedDigestHex) {
          throw makeCodedError('STORAGE_WRITE_FAILED', 'Staged checkpoint failed post-write verification.');
        }
      }

      if (params.signal?.aborted) {
        await recDir.removeEntry(tmpName).catch(() => {});
        throw makeCodedError('WRITE_CANCELLED', 'Checkpoint write cancelled prior to commit.');
      }

      // 3. Enforce monotonic sequence against current stored file (if readable & valid)
      let existingCurrentText: string | null = null;
      try {
        const existingHandle = await recDir.getFileHandle(currentName, { create: false });
        existingCurrentText = await (await existingHandle.getFile()).text();
      } catch {
        existingCurrentText = null;
      }

      if (existingCurrentText) {
        try {
          const existingParsed = JSON.parse(existingCurrentText) as { sequenceNumber?: unknown };
          if (
            typeof existingParsed.sequenceNumber === 'number' &&
            existingParsed.sequenceNumber > params.sequenceNumber
          ) {
            await recDir.removeEntry(tmpName).catch(() => {});
            throw makeCodedError(
              'STALE_SEQUENCE_REJECTED',
              `Refusing to overwrite newer checkpoint sequence ${existingParsed.sequenceNumber} with older sequence ${params.sequenceNumber}.`,
            );
          }
        } catch (seqErr) {
          if ((seqErr as { code?: string }).code === 'STALE_SEQUENCE_REJECTED') {
            throw seqErr;
          }
          // Existing file was corrupted; safe to overwrite with verified staged payload
        }

        // Preserve prior checkpoint in bounded `.prev.json` backup slot before overwriting `.current.json`
        try {
          const prevHandle = await recDir.getFileHandle(prevName, { create: true });
          const prevWritable = await prevHandle.createWritable();
          await prevWritable.write(existingCurrentText);
          await prevWritable.close();
        } catch {
          // Best-effort backup rotation; do not corrupt current checkpoint
        }
      }

      // 4. Commit verified payload into `.current.json`
      const currentHandle = await recDir.getFileHandle(currentName, { create: true });
      const currentWritable = await currentHandle.createWritable();
      try {
        await currentWritable.write(stagedText);
        await currentWritable.close();
      } catch (commitErr) {
        if (typeof currentWritable.abort === 'function') {
          await currentWritable.abort().catch(() => {});
        }
        throw commitErr;
      }

      // 5. Remove staged temp file after verified commit
      await recDir.removeEntry(tmpName).catch(() => {});
    } catch (err) {
      if (tmpWritable && typeof tmpWritable.abort === 'function') {
        await tmpWritable.abort().catch(() => {});
      }
      await recDir.removeEntry(tmpName).catch(() => {});
      throw err;
    }
  }

  public async read(projectId: string): Promise<string | null> {
    const projectKey = encodeProjectStorageKey(projectId);
    return this.readByKey(projectKey);
  }

  public async readByKey(projectKey: string): Promise<string | null> {
    let recDir: OpfsRecoveryDirectoryLike;
    try {
      recDir = await this.getRecoveryDir(false);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'NotFoundError') {
        return null;
      }
      throw err;
    }
    try {
      const fileHandle = await recDir.getFileHandle(`${projectKey}.current.json`, {
        create: false,
      });
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'NotFoundError') {
        return null;
      }
      throw err;
    }
  }

  public async cleanupObsoleteTempFiles(projectKey: string): Promise<number> {
    let recDir: OpfsRecoveryDirectoryLike;
    try {
      recDir = await this.getRecoveryDir(false);
    } catch {
      return 0;
    }
    if (typeof recDir.entries !== 'function') return 0;

    let removed = 0;
    const prefix = `${projectKey}.tmp.`;
    for await (const [name, entry] of recDir.entries()) {
      if (entry.kind === 'file' && name.startsWith(prefix) && name.endsWith('.json')) {
        await recDir.removeEntry(name).catch(() => {});
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Transactional IndexedDB fallback recovery journal store.
 * Stores bounded `{ current, previous }` slots per projectKey inside a single atomic `readwrite`
 * transaction so interrupted writes roll back cleanly and preserve the previous valid checkpoint.
 */
interface IndexedDbCheckpointSlotRecord {
  readonly projectKey: string;
  readonly projectId: string;
  readonly currentSequenceNumber: number;
  readonly currentJson: string;
  readonly previousJson: string | null;
  readonly updatedAtMs: number;
}

export class IndexedDbRecoveryJournalStore implements RecoveryJournalStore {
  public readonly isDurable = true;
  public readonly backendName = 'IndexedDB';
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly idbFactory: IDBFactory) {}

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = this.idbFactory.open(IDB_JOURNAL_DB_NAME, IDB_JOURNAL_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_JOURNAL_STORE_NAME)) {
            db.createObjectStore(IDB_JOURNAL_STORE_NAME, { keyPath: 'projectKey' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          this.dbPromise = null;
          reject(req.error ?? new Error('Failed to open IndexedDB recovery journal.'));
        };
      } catch (err) {
        this.dbPromise = null;
        reject(err);
      }
    });
    return this.dbPromise;
  }

  public async write(projectId: string, jsonPayload: string): Promise<void> {
    const projectKey = encodeProjectStorageKey(projectId);
    const parsed = JSON.parse(jsonPayload) as Partial<RecoveryCheckpointEnvelope>;
    await this.writeAtomic({
      projectKey,
      projectId,
      checkpointId: parsed.checkpointId ?? generateSecureSessionId('chk'),
      sequenceNumber: parsed.sequenceNumber ?? 1,
      jsonPayload,
      expectedDigestHex: parsed.integrity?.digestHex ?? '',
    });
  }

  public async writeAtomic(params: {
    readonly projectKey: string;
    readonly projectId: string;
    readonly checkpointId: string;
    readonly sequenceNumber: number;
    readonly jsonPayload: string;
    readonly expectedDigestHex: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (params.signal?.aborted) {
      throw makeCodedError('WRITE_CANCELLED', 'Checkpoint write cancelled.');
    }
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_JOURNAL_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_JOURNAL_STORE_NAME);
      const getReq = store.get(params.projectKey);
      let staleRejected = false;

      getReq.onsuccess = () => {
        if (params.signal?.aborted) {
          tx.abort();
          return;
        }
        const existing = getReq.result as IndexedDbCheckpointSlotRecord | undefined;
        if (existing && existing.currentSequenceNumber > params.sequenceNumber) {
          staleRejected = true;
          tx.abort();
          return;
        }
        const nextRecord: IndexedDbCheckpointSlotRecord = {
          projectKey: params.projectKey,
          projectId: params.projectId,
          currentSequenceNumber: params.sequenceNumber,
          currentJson: params.jsonPayload,
          previousJson: existing?.currentJson ?? null,
          updatedAtMs: Date.now(),
        };
        store.put(nextRecord);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB checkpoint transaction failed.'));
      tx.onabort = () => {
        if (staleRejected) {
          reject(
            makeCodedError(
              'STALE_SEQUENCE_REJECTED',
              'Refusing to overwrite newer checkpoint sequence with older sequence.',
            ),
          );
          return;
        }
        if (params.signal?.aborted) {
          reject(makeCodedError('WRITE_CANCELLED', 'Checkpoint write cancelled.'));
          return;
        }
        reject(tx.error ?? new Error('IndexedDB checkpoint transaction aborted.'));
      };
    });
  }

  public async read(projectId: string): Promise<string | null> {
    const projectKey = encodeProjectStorageKey(projectId);
    return this.readByKey(projectKey);
  }

  public async readByKey(projectKey: string): Promise<string | null> {
    const db = await this.openDb();
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(IDB_JOURNAL_STORE_NAME, 'readonly');
      const store = tx.objectStore(IDB_JOURNAL_STORE_NAME);
      const getReq = store.get(projectKey);
      getReq.onsuccess = () => {
        const rec = getReq.result as IndexedDbCheckpointSlotRecord | undefined;
        resolve(rec ? rec.currentJson : null);
      };
      getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB checkpoint read failed.'));
    });
  }

  public async cleanupObsoleteTempFiles(): Promise<number> {
    return 0;
  }
}

function resolveDefaultJournalStore(): RecoveryJournalStore | null {
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  ) {
    return new OpfsRecoveryJournalStore(
      () => navigator.storage.getDirectory() as unknown as Promise<OpfsRecoveryDirectoryLike>,
    );
  }
  if (typeof globalThis !== 'undefined' && 'indexedDB' in globalThis && globalThis.indexedDB) {
    return new IndexedDbRecoveryJournalStore(globalThis.indexedDB);
  }
  return null;
}

function envelopeToCompatRecord(
  envelope: RecoveryCheckpointEnvelope,
  snapshot: ProjectDocument,
): RecoveryCheckpointRecord {
  return {
    projectId: envelope.projectId,
    sessionId: envelope.sessionId,
    dirtyShutdownDetected: envelope.shutdownState === 'DIRTY_ACTIVE',
    lastCheckpointTimestamp: envelope.createdAtMs,
    snapshot,
    checkpointId: envelope.checkpointId,
    sequenceNumber: envelope.sequenceNumber,
    envelopeVersion: envelope.envelopeVersion,
    digestHex: envelope.integrity.digestHex,
    requiredAssetIdentities: envelope.requiredAssetIdentities,
  };
}

/**
 * Multi-Tab Project Session Lock & Crash-Safe Verified Recovery Journal.
 *
 * Guarantees:
 * - Cryptographically generated session identity (stable for instance lifetime).
 * - Exclusive project locking via Web Locks (primary) or atomic IndexedDB leases (fallback),
 *   failing closed (`LOCK_UNAVAILABLE`) when neither mechanism exists.
 * - Versioned checkpoint envelopes with canonical SHA-256 integrity digests, strict
 *   ProjectDocument schema validation, safe migration integration, and per-project write serialization.
 * - Explicit clean/dirty shutdown lifecycle & conflict-aware recovery planning.
 */
export class CrashRecoveryAndSessionLock {
  private readonly sessionId: string;
  private readonly journalStore: RecoveryJournalStore | null;
  private readonly webLocksCoordinator: WebLocksCoordinator | null;
  private readonly leaseStore: AtomicLeaseStore | null;
  private readonly allowSameTabRefCount: boolean;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly maxCheckpointBytes: number;
  private readonly currentSupportedEngineMajor: number | undefined;
  private readonly nowFn: () => number;

  private lockState: ProjectLockState = 'UNLOCKED';
  private lockStrategy: ProjectLockStrategy = 'NONE';
  private heldProjectId: string | null = null;
  private heldProjectKey: string | null = null;
  private fencingToken: number | null = null;
  private leaseExpiresAtMs: number | null = null;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private activeAcquirePromise: Promise<ProjectLockAcquisitionResult> | null = null;
  private releaseRequestedDuringAcquire = false;
  private readonly lockLossListeners = new Set<(event: LockLossEvent) => void>();

  // Per-project checkpoint sequencing & write serialization
  private readonly sequenceByProjectKey = new Map<string, number>();
  private readonly writeQueueByProjectKey = new Map<string, Promise<unknown>>();
  private lastWriteResult: RecoveryWriteResult | null = null;

  constructor(
    journalStoreOrOptions?: RecoveryJournalStore | CrashRecoveryAndSessionLockOptions | null,
    maybeOptions?: CrashRecoveryAndSessionLockOptions,
  ) {
    let options: CrashRecoveryAndSessionLockOptions;
    if (
      journalStoreOrOptions &&
      typeof journalStoreOrOptions === 'object' &&
      'write' in journalStoreOrOptions &&
      'read' in journalStoreOrOptions
    ) {
      options = { ...(maybeOptions ?? {}), journalStore: journalStoreOrOptions };
    } else if (journalStoreOrOptions === null) {
      options = { ...(maybeOptions ?? {}), journalStore: null, disableDefaultJournalBackends: true };
    } else {
      options = { ...(journalStoreOrOptions ?? {}), ...(maybeOptions ?? {}) };
    }

    this.sessionId =
      options.sessionId && options.sessionId.trim().length > 0
        ? options.sessionId
        : generateSecureSessionId('sess');

    if (options.journalStore !== undefined) {
      this.journalStore = options.journalStore;
    } else if (options.disableDefaultJournalBackends) {
      this.journalStore = null;
    } else {
      this.journalStore = resolveDefaultJournalStore();
    }

    if (options.webLocksCoordinator !== undefined) {
      this.webLocksCoordinator = options.webLocksCoordinator;
    } else if (options.disableDefaultLockBackends) {
      this.webLocksCoordinator = null;
    } else {
      this.webLocksCoordinator = getDefaultBrowserWebLocksCoordinator();
    }

    if (options.leaseStore !== undefined) {
      this.leaseStore = options.leaseStore;
    } else if (options.disableDefaultLockBackends) {
      this.leaseStore = null;
    } else {
      this.leaseStore = getDefaultBrowserIndexedDbLeaseStore();
    }

    this.allowSameTabRefCount = options.allowSameTabRefCount ?? true;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 10_000;
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    this.currentSupportedEngineMajor = options.currentSupportedEngineMajor;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getLockState(): ProjectLockState {
    return this.lockState;
  }

  public getLockStrategy(): ProjectLockStrategy {
    return this.lockStrategy;
  }

  public getHeldProjectId(): string | null {
    return this.lockState === 'LOCKED' ? this.heldProjectId : null;
  }

  public getFencingToken(): number | null {
    return this.lockState === 'LOCKED' ? this.fencingToken : null;
  }

  public getLeaseExpiresAtMs(): number | null {
    return this.lockState === 'LOCKED' ? this.leaseExpiresAtMs : null;
  }

  public isDurableRecoveryStorageAvailable(): boolean {
    return Boolean(this.journalStore && this.journalStore.isDurable !== false);
  }

  public getLastWriteResult(): RecoveryWriteResult | null {
    return this.lastWriteResult;
  }

  public onLockLost(listener: (event: LockLossEvent) => void): () => void {
    this.lockLossListeners.add(listener);
    return () => {
      this.lockLossListeners.delete(listener);
    };
  }

  private emitLockLost(event: LockLossEvent): void {
    for (const listener of this.lockLossListeners) {
      try {
        listener(event);
      } catch {
        // Never allow listener errors to disrupt lock cleanup
      }
    }
  }

  private stopRenewalTimer(): void {
    if (this.renewalTimer !== null) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private startRenewalTimer(): void {
    this.stopRenewalTimer();
    if (this.lockStrategy !== 'INDEXEDDB_LEASE' || this.leaseRenewIntervalMs <= 0) {
      return;
    }
    this.renewalTimer = setInterval(() => {
      void this.renewProjectLock().catch(() => {});
    }, this.leaseRenewIntervalMs);
    if (typeof (this.renewalTimer as { unref?: () => void }).unref === 'function') {
      (this.renewalTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Typed exclusive project lock acquisition.
   * Never fails open: returns `LOCK_UNAVAILABLE` when no reliable lock backend exists.
   */
  public async acquireProjectLock(projectId: string): Promise<ProjectLockAcquisitionResult> {
    const idCheck = validateProjectId(projectId);
    if (!idCheck.valid) {
      this.lockState = 'ERROR';
      return {
        acquired: false,
        state: 'ERROR',
        strategy: 'NONE',
        projectId: String(projectId ?? ''),
        sessionId: this.sessionId,
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_INVALID_PROJECT_ID',
        message: idCheck.reason ?? 'Invalid project identifier.',
      };
    }

    const projectKey = encodeProjectStorageKey(projectId);

    // Idempotent re-acquire for the exact same project already held by this session
    if (this.lockState === 'LOCKED' && this.heldProjectId === projectId) {
      if (this.lockStrategy === 'INDEXEDDB_LEASE' && this.leaseStore) {
        const renew = await this.renewProjectLock();
        if (!renew.renewed) {
          return {
            acquired: false,
            state: renew.state,
            strategy: 'INDEXEDDB_LEASE',
            projectId,
            sessionId: this.sessionId,
            fencingToken: null,
            leaseExpiresAtMs: null,
            reasonCode: renew.reasonCode,
            message: renew.message,
          };
        }
      }
      return {
        acquired: true,
        state: 'LOCKED',
        strategy: this.lockStrategy,
        projectId,
        sessionId: this.sessionId,
        fencingToken: this.fencingToken,
        leaseExpiresAtMs: this.leaseExpiresAtMs,
        reasonCode: 'LOCK_REENTRANT_SAME_SESSION',
        message: 'Project lock is already owned by this session.',
      };
    }

    // If an acquisition for the same project is already in progress, await it cleanly
    if (this.lockState === 'ACQUIRING' && this.heldProjectId === projectId && this.activeAcquirePromise) {
      return this.activeAcquirePromise;
    }

    // If switching projects on the same session instance, release previous project cleanly first
    if (this.heldProjectId && this.heldProjectId !== projectId) {
      await this.releaseProjectLockAsync();
    }

    this.releaseRequestedDuringAcquire = false;
    this.lockState = 'ACQUIRING';
    this.heldProjectId = projectId;
    this.heldProjectKey = projectKey;

    const acquireWork = (async (): Promise<ProjectLockAcquisitionResult> => {
      // Primary Strategy: Web Locks API
      if (this.webLocksCoordinator) {
        this.lockStrategy = 'WEB_LOCKS';
        const res = await this.webLocksCoordinator.acquire(
          projectId,
          this.sessionId,
          this.allowSameTabRefCount,
        );

        if (this.releaseRequestedDuringAcquire) {
          if (res.acquired) {
            this.webLocksCoordinator.release(projectId, this.sessionId);
          }
          this.lockState = 'RELEASED';
          this.heldProjectId = null;
          this.heldProjectKey = null;
          this.fencingToken = null;
          this.leaseExpiresAtMs = null;
          return {
            acquired: false,
            state: 'RELEASED',
            strategy: 'WEB_LOCKS',
            projectId,
            sessionId: this.sessionId,
            fencingToken: null,
            leaseExpiresAtMs: null,
            reasonCode: 'LOCK_RELEASED_BEFORE_ACQUIRE',
            message: 'Lock acquisition was cancelled because release was called before completion.',
          };
        }

        if (!res.acquired) {
          this.lockState = res.state;
          this.heldProjectId = null;
          this.heldProjectKey = null;
          this.fencingToken = null;
          this.leaseExpiresAtMs = null;
          return res;
        }

        this.lockState = 'LOCKED';
        this.fencingToken = res.fencingToken;
        this.leaseExpiresAtMs = null;
        return res;
      }

      // Fallback Strategy: Atomic IndexedDB Lease
      if (this.leaseStore) {
        this.lockStrategy = 'INDEXEDDB_LEASE';
        try {
          const nowMs = this.nowFn();
          const attempt = await this.leaseStore.tryAcquireLease({
            projectKey,
            projectId,
            ownerSessionId: this.sessionId,
            nowMs,
            ttlMs: this.leaseTtlMs,
          });

          if (this.releaseRequestedDuringAcquire) {
            if (attempt.acquired && attempt.lease) {
              await this.leaseStore
                .tryReleaseLease({
                  projectKey,
                  ownerSessionId: this.sessionId,
                  expectedFencingToken: attempt.lease.fencingToken,
                })
                .catch(() => {});
            }
            this.lockState = 'RELEASED';
            this.heldProjectId = null;
            this.heldProjectKey = null;
            this.fencingToken = null;
            this.leaseExpiresAtMs = null;
            return {
              acquired: false,
              state: 'RELEASED',
              strategy: 'INDEXEDDB_LEASE',
              projectId,
              sessionId: this.sessionId,
              fencingToken: null,
              leaseExpiresAtMs: null,
              reasonCode: 'LOCK_RELEASED_BEFORE_ACQUIRE',
              message: 'Lease acquisition was cancelled because release was called before completion.',
            };
          }

          if (!attempt.acquired || !attempt.lease) {
            this.lockState = 'CONTENDED';
            this.heldProjectId = null;
            this.heldProjectKey = null;
            this.fencingToken = null;
            this.leaseExpiresAtMs = null;
            return {
              acquired: false,
              state: 'CONTENDED',
              strategy: 'INDEXEDDB_LEASE',
              projectId,
              sessionId: this.sessionId,
              fencingToken: null,
              leaseExpiresAtMs: null,
              reasonCode: 'LOCK_CONTENDED_OTHER_SESSION',
              message: 'Another active session currently owns the exclusive project lease.',
            };
          }

          this.lockState = 'LOCKED';
          this.fencingToken = attempt.lease.fencingToken;
          this.leaseExpiresAtMs = attempt.lease.expiresAtMs;
          this.startRenewalTimer();

          return {
            acquired: true,
            state: 'LOCKED',
            strategy: 'INDEXEDDB_LEASE',
            projectId,
            sessionId: this.sessionId,
            fencingToken: attempt.lease.fencingToken,
            leaseExpiresAtMs: attempt.lease.expiresAtMs,
            reasonCode: 'LOCK_ACQUIRED_INDEXEDDB_LEASE',
            message: 'Exclusive IndexedDB project lease acquired.',
          };
        } catch (err) {
          this.lockState = 'ERROR';
          this.heldProjectId = null;
          this.heldProjectKey = null;
          this.fencingToken = null;
          this.leaseExpiresAtMs = null;
          return {
            acquired: false,
            state: 'ERROR',
            strategy: 'INDEXEDDB_LEASE',
            projectId,
            sessionId: this.sessionId,
            fencingToken: null,
            leaseExpiresAtMs: null,
            reasonCode: 'LOCK_REQUEST_REJECTED',
            message:
              err instanceof Error
                ? sanitizeErrorMessage(err.message)
                : 'IndexedDB lease acquisition failed.',
          };
        }
      }

      // Fail-Closed: Neither Web Locks nor IndexedDB lease is available
      this.lockStrategy = 'NONE';
      this.lockState = 'LOCK_UNAVAILABLE';
      this.heldProjectId = null;
      this.heldProjectKey = null;
      this.fencingToken = null;
      this.leaseExpiresAtMs = null;
      return {
        acquired: false,
        state: 'LOCK_UNAVAILABLE',
        strategy: 'NONE',
        projectId,
        sessionId: this.sessionId,
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_BACKEND_UNAVAILABLE',
        message:
          'No exclusive cross-tab locking backend (Web Locks or IndexedDB) is available; refusing unsafe concurrent edit lock.',
      };
    })();

    this.activeAcquirePromise = acquireWork;
    try {
      return await acquireWork;
    } finally {
      if (this.activeAcquirePromise === acquireWork) {
        this.activeAcquirePromise = null;
      }
    }
  }

  /**
   * Backward-compatible Boolean adapter over `acquireProjectLock`.
   * Returns `false` when contended, errored, or `LOCK_UNAVAILABLE`.
   */
  public async acquireExclusiveProjectLock(projectId: string): Promise<boolean> {
    const result = await this.acquireProjectLock(projectId);
    return result.acquired;
  }

  /**
   * Renews an active IndexedDB lease and detects lock loss deterministically.
   * For Web Locks, confirms ownership is still held.
   */
  public async renewProjectLock(): Promise<ProjectLockRenewalResult> {
    if (this.lockState !== 'LOCKED' || !this.heldProjectId || !this.heldProjectKey) {
      return {
        renewed: false,
        state: this.lockState,
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_RENEWAL_FAILED',
        message: 'Cannot renew lock because this session does not currently own a project lock.',
      };
    }

    if (this.lockStrategy === 'WEB_LOCKS') {
      return {
        renewed: true,
        state: 'LOCKED',
        fencingToken: this.fencingToken,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_ACQUIRED_WEB_LOCKS',
        message: 'Web Lock remains actively held.',
      };
    }

    if (this.lockStrategy !== 'INDEXEDDB_LEASE' || !this.leaseStore || this.fencingToken === null) {
      return {
        renewed: false,
        state: 'LOCK_UNAVAILABLE',
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_BACKEND_UNAVAILABLE',
        message: 'Lease renewal backend is unavailable.',
      };
    }

    const projectId = this.heldProjectId;
    const projectKey = this.heldProjectKey;
    const previousToken = this.fencingToken;

    try {
      const outcome = await this.leaseStore.tryRenewLease({
        projectKey,
        ownerSessionId: this.sessionId,
        expectedFencingToken: previousToken,
        nowMs: this.nowFn(),
        ttlMs: this.leaseTtlMs,
      });

      if (!outcome.renewed || !outcome.lease) {
        this.stopRenewalTimer();
        const reasonCode: ProjectLockReasonCode =
          outcome.reason === 'EXPIRED'
            ? 'LOCK_LEASE_EXPIRED'
            : outcome.reason === 'NOT_OWNER'
              ? 'LOCK_LEASE_STOLEN'
              : 'LOCK_RENEWAL_FAILED';
        const nextState: ProjectLockState =
          outcome.reason === 'NOT_OWNER' ? 'CONTENDED' : 'ERROR';
        this.lockState = nextState;
        this.heldProjectId = null;
        this.heldProjectKey = null;
        this.fencingToken = null;
        this.leaseExpiresAtMs = null;

        const message =
          outcome.reason === 'NOT_OWNER'
            ? 'Project lock ownership was taken over by another session (fencing token superseded).'
            : outcome.reason === 'EXPIRED'
              ? 'Project lock lease expired before renewal completed.'
              : 'Project lock lease could not be renewed.';

        this.emitLockLost({
          projectId,
          sessionId: this.sessionId,
          previousFencingToken: previousToken,
          nextState,
          reasonCode,
          message,
        });

        return {
          renewed: false,
          state: nextState,
          fencingToken: null,
          leaseExpiresAtMs: null,
          reasonCode,
          message,
        };
      }

      this.leaseExpiresAtMs = outcome.lease.expiresAtMs;
      return {
        renewed: true,
        state: 'LOCKED',
        fencingToken: outcome.lease.fencingToken,
        leaseExpiresAtMs: outcome.lease.expiresAtMs,
        reasonCode: 'LOCK_ACQUIRED_INDEXEDDB_LEASE',
        message: 'Project lock lease renewed.',
      };
    } catch (err) {
      this.stopRenewalTimer();
      this.lockState = 'ERROR';
      this.heldProjectId = null;
      this.heldProjectKey = null;
      this.fencingToken = null;
      this.leaseExpiresAtMs = null;
      const message =
        err instanceof Error ? sanitizeErrorMessage(err.message) : 'Lease renewal threw an error.';
      this.emitLockLost({
        projectId,
        sessionId: this.sessionId,
        previousFencingToken: previousToken,
        nextState: 'ERROR',
        reasonCode: 'LOCK_RENEWAL_FAILED',
        message,
      });
      return {
        renewed: false,
        state: 'ERROR',
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_RENEWAL_FAILED',
        message,
      };
    }
  }

  /**
   * Verifies that this session STILL owns the active lock (checking lease expiration/fencing
   * in IndexedDB mode) before performing sensitive mutations or checkpoints.
   */
  public async verifyActiveLockOwnership(projectId: string): Promise<boolean> {
    if (this.lockState !== 'LOCKED' || this.heldProjectId !== projectId) {
      return false;
    }
    if (this.lockStrategy === 'WEB_LOCKS') {
      return true;
    }
    if (this.lockStrategy === 'INDEXEDDB_LEASE' && this.leaseStore && this.heldProjectKey) {
      const inspected = await this.leaseStore.inspectLease(this.heldProjectKey, this.nowFn());
      const valid = Boolean(
        inspected.isActive &&
          inspected.lease &&
          inspected.lease.ownerSessionId === this.sessionId &&
          inspected.lease.fencingToken === this.fencingToken,
      );
      if (!valid) {
        const previousToken = this.fencingToken;
        this.stopRenewalTimer();
        const nextState: ProjectLockState =
          inspected.isActive && inspected.lease?.ownerSessionId !== this.sessionId
            ? 'CONTENDED'
            : 'ERROR';
        const reasonCode: ProjectLockReasonCode =
          nextState === 'CONTENDED' ? 'LOCK_LEASE_STOLEN' : 'LOCK_LEASE_EXPIRED';
        this.lockState = nextState;
        this.heldProjectId = null;
        this.heldProjectKey = null;
        this.fencingToken = null;
        this.leaseExpiresAtMs = null;
        this.emitLockLost({
          projectId,
          sessionId: this.sessionId,
          previousFencingToken: previousToken,
          nextState,
          reasonCode,
          message: 'Active project lock ownership verification failed; halting further edits.',
        });
      }
      return valid;
    }
    return false;
  }

  /**
   * Checks whether ANOTHER session currently holds an active lock on `projectId`.
   */
  public async isLockedByAnotherSession(projectId: string): Promise<boolean> {
    assertValidProjectId(projectId);
    const projectKey = encodeProjectStorageKey(projectId);
    if (this.webLocksCoordinator) {
      if (this.webLocksCoordinator.isHeldInCurrentTab(projectKey, this.sessionId)) {
        return true;
      }
    }
    if (this.leaseStore) {
      const inspected = await this.leaseStore.inspectLease(projectKey, this.nowFn());
      if (
        inspected.isActive &&
        inspected.lease &&
        inspected.lease.ownerSessionId !== this.sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Asynchronous idempotent lock release with ownership/fencing verification.
   */
  public async releaseProjectLockAsync(): Promise<ProjectLockReleaseResult> {
    this.stopRenewalTimer();

    if (this.lockState === 'ACQUIRING') {
      this.releaseRequestedDuringAcquire = true;
      const pendingProjectId = this.heldProjectId;
      if (pendingProjectId && this.lockStrategy === 'WEB_LOCKS' && this.webLocksCoordinator) {
        this.webLocksCoordinator.release(pendingProjectId, this.sessionId);
      }
      this.lockState = 'RELEASED';
      return {
        released: true,
        state: 'RELEASED',
        reasonCode: 'LOCK_RELEASE_SCHEDULED_BEFORE_ACQUIRE',
        message: 'Release scheduled before acquisition completed.',
      };
    }

    if (this.lockState !== 'LOCKED' || !this.heldProjectId || !this.heldProjectKey) {
      if (this.lockState === 'UNLOCKED' || this.lockState === 'RELEASED') {
        this.lockState = 'RELEASED';
      }
      return {
        released: false,
        state: this.lockState,
        reasonCode: 'LOCK_ALREADY_RELEASED',
        message: 'Session does not currently hold a project lock.',
      };
    }

    const projectId = this.heldProjectId;
    const projectKey = this.heldProjectKey;
    const token = this.fencingToken;
    const strategy = this.lockStrategy;

    this.heldProjectId = null;
    this.heldProjectKey = null;
    this.fencingToken = null;
    this.leaseExpiresAtMs = null;
    this.lockState = 'RELEASED';

    if (strategy === 'WEB_LOCKS' && this.webLocksCoordinator) {
      return this.webLocksCoordinator.releaseAsync(projectId, this.sessionId);
    }

    if (strategy === 'INDEXEDDB_LEASE' && this.leaseStore && token !== null) {
      const res = await this.leaseStore.tryReleaseLease({
        projectKey,
        ownerSessionId: this.sessionId,
        expectedFencingToken: token,
      });
      return {
        released: res.released,
        state: 'RELEASED',
        reasonCode: res.reason === 'RELEASED' ? 'LOCK_RELEASED' : `LOCK_RELEASE_${res.reason}`,
        message:
          res.released
            ? 'IndexedDB lease released after verifying ownership and fencing token.'
            : 'Lease was already reclaimed or owned by another session; newer lease preserved.',
      };
    }

    return {
      released: false,
      state: 'RELEASED',
      reasonCode: 'LOCK_NO_BACKEND',
      message: 'No active backend lock to release.',
    };
  }

  /**
   * Synchronous backward-compatible wrapper around `releaseProjectLockAsync()`.
   * Safe to call repeatedly or before acquisition completes.
   */
  public releaseProjectLock(): void {
    void this.releaseProjectLockAsync().catch(() => {});
  }

  /**
   * Cleans up expired leases (IndexedDB mode) and obsolete temp checkpoint files (OPFS mode)
   * without touching any valid active checkpoint or active lease.
   */
  public async cleanupMaintenance(projectId?: string): Promise<{
    readonly expiredLeasesRemoved: number;
    readonly obsoleteTempFilesRemoved: number;
  }> {
    let expiredLeasesRemoved = 0;
    let obsoleteTempFilesRemoved = 0;

    if (this.leaseStore) {
      expiredLeasesRemoved = await this.leaseStore.cleanupExpiredLeases(this.nowFn()).catch(() => 0);
    }
    if (projectId && this.journalStore?.cleanupObsoleteTempFiles) {
      const check = validateProjectId(projectId);
      if (check.valid) {
        const key = encodeProjectStorageKey(projectId);
        obsoleteTempFilesRemoved = await this.journalStore
          .cleanupObsoleteTempFiles(key)
          .catch(() => 0);
      }
    }

    return { expiredLeasesRemoved, obsoleteTempFilesRemoved };
  }

  /**
   * Enqueues checkpoint persistence serialized per project so concurrent writes cannot race
   * or allow an older sequence to overwrite a newer sequence.
   */
  public async persistRecoveryCheckpoint(
    doc: ProjectDocument,
    options?: {
      readonly shutdownState?: CheckpointShutdownState;
      readonly requiredAssetIdentities?: readonly AssetIdentityRecord[];
      readonly requireHeldLock?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<RecoveryWriteResult> {
    const idCheck = validateProjectId(doc?.projectId);
    if (!idCheck.valid) {
      const res: RecoveryWriteResult = {
        persisted: false,
        status: 'FAILED',
        errorCode: 'INVALID_PROJECT_ID',
        message: idCheck.reason ?? 'Invalid project identifier.',
        envelope: null,
        byteLength: 0,
      };
      this.lastWriteResult = res;
      return res;
    }

    const projectKey = encodeProjectStorageKey(doc.projectId);
    const prevTask = this.writeQueueByProjectKey.get(projectKey) ?? Promise.resolve();

    // Reserve monotonic sequence BEFORE awaiting previous write so sequence order matches call order,
    // and serialize execution through the per-project queue.
    const nextTask = prevTask
      .catch(() => {})
      .then(() => this.executeSerializedCheckpointWrite(doc, projectKey, options));

    this.writeQueueByProjectKey.set(projectKey, nextTask);
    try {
      const res = await nextTask;
      this.lastWriteResult = res;
      return res;
    } finally {
      if (this.writeQueueByProjectKey.get(projectKey) === nextTask) {
        this.writeQueueByProjectKey.delete(projectKey);
      }
    }
  }

  private async executeSerializedCheckpointWrite(
    doc: ProjectDocument,
    projectKey: string,
    options?: {
      readonly shutdownState?: CheckpointShutdownState;
      readonly requiredAssetIdentities?: readonly AssetIdentityRecord[];
      readonly requireHeldLock?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<RecoveryWriteResult> {
    if (options?.signal?.aborted) {
      return {
        persisted: false,
        status: 'FAILED',
        errorCode: 'WRITE_CANCELLED',
        message: 'Checkpoint write was cancelled before persistence.',
        envelope: null,
        byteLength: 0,
      };
    }

    if (!this.journalStore || this.journalStore.isDurable === false) {
      return {
        persisted: false,
        status: 'DEGRADED_STORAGE_UNAVAILABLE',
        errorCode: 'STORAGE_UNAVAILABLE',
        message:
          'Durable crash recovery storage (OPFS/IndexedDB) is unavailable; checkpoint was NOT persisted.',
        envelope: null,
        byteLength: 0,
      };
    }

    // If caller requires active lock ownership (or this session previously acquired a lease),
    // verify ownership before writing so stale sessions cannot clobber newer checkpoints.
    if (options?.requireHeldLock) {
      const owns = await this.verifyActiveLockOwnership(doc.projectId);
      if (!owns) {
        return {
          persisted: false,
          status: 'FAILED',
          errorCode: 'LOCK_NOT_HELD',
          message: 'Cannot persist checkpoint because this session no longer owns the project lock.',
          envelope: null,
          byteLength: 0,
        };
      }
    } else if (this.lockStrategy === 'INDEXEDDB_LEASE' && this.lockState === 'LOCKED' && this.heldProjectId === doc.projectId) {
      const owns = await this.verifyActiveLockOwnership(doc.projectId);
      if (!owns) {
        return {
          persisted: false,
          status: 'FAILED',
          errorCode: 'LOCK_NOT_HELD',
          message: 'Lease ownership was lost; refusing to persist stale checkpoint.',
          envelope: null,
          byteLength: 0,
        };
      }
    }

    // Determine monotonic sequence (checking persisted sequence on first write for this project)
    let knownSeq = this.sequenceByProjectKey.get(projectKey) ?? 0;
    if (knownSeq === 0) {
      try {
        const existingRaw = this.journalStore.readByKey
          ? await this.journalStore.readByKey(projectKey)
          : await this.journalStore.read(doc.projectId);
        if (existingRaw) {
          const existingParsed = JSON.parse(existingRaw) as { sequenceNumber?: unknown };
          if (
            typeof existingParsed.sequenceNumber === 'number' &&
            Number.isSafeInteger(existingParsed.sequenceNumber) &&
            existingParsed.sequenceNumber > knownSeq
          ) {
            knownSeq = existingParsed.sequenceNumber;
          }
        }
      } catch {
        // Existing record unreadable or corrupt; begin monotonic sequence from 1
      }
    }
    const sequenceNumber = knownSeq + 1;
    const checkpointId = generateSecureSessionId('chk');
    const shutdownState: CheckpointShutdownState = options?.shutdownState ?? 'DIRTY_ACTIVE';

    let built: Awaited<ReturnType<typeof buildVerifiedCheckpointEnvelope>>;
    try {
      built = await buildVerifiedCheckpointEnvelope({
        snapshot: doc,
        sessionId: this.sessionId,
        checkpointId,
        sequenceNumber,
        createdAtMs: this.nowFn(),
        shutdownState,
        fencingToken: this.lockState === 'LOCKED' ? this.fencingToken : null,
        requiredAssetIdentities: options?.requiredAssetIdentities,
        maxCheckpointBytes: this.maxCheckpointBytes,
      });
    } catch (err) {
      const classified = classifyStorageError(err, 'INVALID_PROJECT_SCHEMA');
      return {
        persisted: false,
        status: 'FAILED',
        errorCode: classified.code,
        message: classified.message,
        envelope: null,
        byteLength: 0,
      };
    }

    if (options?.signal?.aborted) {
      return {
        persisted: false,
        status: 'FAILED',
        errorCode: 'WRITE_CANCELLED',
        message: 'Checkpoint write was cancelled prior to storage write.',
        envelope: null,
        byteLength: 0,
      };
    }

    try {
      if (this.journalStore.writeAtomic) {
        await this.journalStore.writeAtomic({
          projectKey,
          projectId: doc.projectId,
          checkpointId,
          sequenceNumber,
          jsonPayload: built.serializedJson,
          expectedDigestHex: built.envelope.integrity.digestHex,
          signal: options?.signal,
        });
      } else {
        await this.journalStore.write(doc.projectId, built.serializedJson);
      }

      // Only advance in-memory sequence watermark AFTER durable storage confirms completion
      this.sequenceByProjectKey.set(projectKey, sequenceNumber);

      return {
        persisted: true,
        status: 'PERSISTED',
        errorCode: null,
        message:
          shutdownState === 'CLEAN_SHUTDOWN'
            ? 'Verified clean-shutdown checkpoint persisted.'
            : 'Verified dirty recovery checkpoint persisted.',
        envelope: built.envelope,
        byteLength: built.byteLength,
      };
    } catch (err) {
      const classified = classifyStorageError(err, 'STORAGE_WRITE_FAILED');
      return {
        persisted: false,
        status: 'FAILED',
        errorCode: classified.code,
        message: classified.message,
        envelope: null,
        byteLength: built.byteLength,
      };
    }
  }

  /**
   * Backward-compatible checkpoint writer.
   * Throws an explicit coded Error if validation or durable storage fails (never silently drops writes).
   */
  public async writeRecoveryCheckpoint(
    doc: ProjectDocument,
    isCleanExit = false,
    requiredAssetIdentities?: readonly AssetIdentityRecord[],
  ): Promise<void> {
    const result = await this.persistRecoveryCheckpoint(doc, {
      shutdownState: isCleanExit ? 'CLEAN_SHUTDOWN' : 'DIRTY_ACTIVE',
      requiredAssetIdentities,
    });
    if (!result.persisted) {
      throw makeCodedError(result.errorCode ?? 'STORAGE_WRITE_FAILED', result.message);
    }
  }

  /**
   * Performs clean shutdown sequence:
   * 1. Persists a verified CLEAN_SHUTDOWN checkpoint preserving the latest valid snapshot.
   * 2. Releases the project lock ONLY after persistence completes.
   * If persistence fails, the previous DIRTY_ACTIVE checkpoint stays recoverable.
   */
  public async completeCleanShutdown(
    doc: ProjectDocument,
    requiredAssetIdentities?: readonly AssetIdentityRecord[],
  ): Promise<{
    readonly checkpointResult: RecoveryWriteResult;
    readonly lockReleaseResult: ProjectLockReleaseResult;
  }> {
    const checkpointResult = await this.persistRecoveryCheckpoint(doc, {
      shutdownState: 'CLEAN_SHUTDOWN',
      requiredAssetIdentities,
    });
    const lockReleaseResult = await this.releaseProjectLockAsync();
    return { checkpointResult, lockReleaseResult };
  }

  /**
   * Full structured inspection of stored recovery state.
   * Never silently discards corrupted or incompatible checkpoints.
   */
  public async inspectCrashRecovery(projectId: string): Promise<CrashRecoveryInspectionResult> {
    const idCheck = validateProjectId(projectId);
    if (!idCheck.valid) {
      return {
        status: 'RECOVERY_VALIDATION_FAILED',
        errorCode: 'INVALID_PROJECT_ID',
        message: idCheck.reason ?? 'Invalid project identifier.',
        projectId: String(projectId ?? ''),
        durableStorageAvailable: this.isDurableRecoveryStorageAvailable(),
        envelope: null,
        migratedSnapshot: null,
        record: null,
        wasMigrated: false,
        validationErrors: [idCheck.reason ?? 'Invalid project identifier.'],
      };
    }

    if (!this.journalStore || this.journalStore.isDurable === false) {
      return {
        status: 'RECOVERY_STORAGE_UNAVAILABLE',
        errorCode: 'STORAGE_UNAVAILABLE',
        message: 'Durable crash recovery storage is unavailable in this environment.',
        projectId,
        durableStorageAvailable: false,
        envelope: null,
        migratedSnapshot: null,
        record: null,
        wasMigrated: false,
        validationErrors: ['STORAGE_UNAVAILABLE'],
      };
    }

    const projectKey = encodeProjectStorageKey(projectId);
    let rawJson: string | null;
    try {
      rawJson = this.journalStore.readByKey
        ? await this.journalStore.readByKey(projectKey)
        : await this.journalStore.read(projectId);
    } catch (err) {
      const classified = classifyStorageError(err, 'STORAGE_READ_FAILED');
      return {
        status:
          classified.code === 'STORAGE_PERMISSION_DENIED'
            ? 'RECOVERY_STORAGE_UNAVAILABLE'
            : 'RECOVERY_CORRUPTED',
        errorCode: classified.code,
        message: classified.message,
        projectId,
        durableStorageAvailable: classified.code !== 'STORAGE_PERMISSION_DENIED',
        envelope: null,
        migratedSnapshot: null,
        record: null,
        wasMigrated: false,
        validationErrors: [classified.code],
      };
    }

    if (rawJson === null) {
      return {
        status: 'NO_RECOVERY_AVAILABLE',
        errorCode: null,
        message: 'No crash recovery checkpoint exists for this project.',
        projectId,
        durableStorageAvailable: true,
        envelope: null,
        migratedSnapshot: null,
        record: null,
        wasMigrated: false,
        validationErrors: [],
      };
    }

    const verified: EnvelopeVerificationResult = await verifyAndParseCheckpointEnvelope({
      rawJson,
      expectedProjectId: projectId,
      maxCheckpointBytes: this.maxCheckpointBytes,
      currentSupportedEngineMajor: this.currentSupportedEngineMajor,
    });

    if (verified.envelope) {
      const currentSeq = this.sequenceByProjectKey.get(projectKey) ?? 0;
      if (verified.envelope.sequenceNumber > currentSeq) {
        this.sequenceByProjectKey.set(projectKey, verified.envelope.sequenceNumber);
      }
    }

    const record =
      verified.status === 'RECOVERY_AVAILABLE' && verified.envelope && verified.migratedSnapshot
        ? envelopeToCompatRecord(verified.envelope, verified.migratedSnapshot)
        : null;

    return {
      status: verified.status,
      errorCode: verified.errorCode,
      message: verified.message,
      projectId,
      durableStorageAvailable: true,
      envelope: verified.envelope,
      migratedSnapshot: verified.migratedSnapshot,
      record,
      wasMigrated: verified.wasMigrated,
      validationErrors: verified.validationErrors,
    };
  }

  /**
   * Backward-compatible crash recovery reader.
   * Returns a verified RecoveryCheckpointRecord ONLY when a valid, schema-checked DIRTY checkpoint exists.
   */
  public async checkCrashRecovery(projectId: string): Promise<RecoveryCheckpointRecord | null> {
    const inspection = await this.inspectCrashRecovery(projectId);
    return inspection.status === 'RECOVERY_AVAILABLE' ? inspection.record : null;
  }

  /**
   * Evaluates recovery eligibility, lock contention, revision conflicts, and referenced media
   * integrity WITHOUT mutating the current project or original audio files.
   */
  public async planCrashRecovery(params: {
    readonly projectId: string;
    readonly currentSavedProject?: ProjectDocument | null;
    readonly availableLocalAssetsMap?: ReadonlyMap<string, AssetIdentityRecord>;
    readonly expectedCheckpointSequenceNumber?: number;
  }): Promise<SafeCrashRecoveryPlan> {
    const idCheck = validateProjectId(params.projectId);
    if (!idCheck.valid) {
      return {
        canRestore: false,
        status: 'RECOVERY_VALIDATION_FAILED',
        errorCode: 'INVALID_PROJECT_ID',
        message: idCheck.reason ?? 'Invalid project identifier.',
        projectId: String(params.projectId ?? ''),
        lockHeldByCurrentSession: false,
        lockHeldByAnotherSession: false,
        hasRevisionConflict: false,
        hasNewerCheckpointConflict: false,
        currentSavedRevision: params.currentSavedProject?.revision ?? null,
        recoveredRevision: null,
        envelope: null,
        migratedSnapshot: null,
        wasMigrated: false,
        mediaVerification: null,
      };
    }

    const lockHeldByCurrentSession = await this.verifyActiveLockOwnership(params.projectId);
    const lockHeldByAnotherSession = !lockHeldByCurrentSession
      ? await this.isLockedByAnotherSession(params.projectId)
      : false;

    const inspection = await this.inspectCrashRecovery(params.projectId);
    const currentSavedRevision = params.currentSavedProject?.revision ?? null;

    if (lockHeldByAnotherSession) {
      return {
        canRestore: false,
        status: inspection.status,
        errorCode: 'LOCK_CONTENDED',
        message: 'Cannot restore recovery checkpoint while another session owns the project lock.',
        projectId: params.projectId,
        lockHeldByCurrentSession: false,
        lockHeldByAnotherSession: true,
        hasRevisionConflict: false,
        hasNewerCheckpointConflict: false,
        currentSavedRevision,
        recoveredRevision: inspection.migratedSnapshot?.revision ?? null,
        envelope: inspection.envelope,
        migratedSnapshot: null,
        wasMigrated: inspection.wasMigrated,
        mediaVerification: null,
      };
    }

    if (inspection.status !== 'RECOVERY_AVAILABLE' || !inspection.envelope || !inspection.migratedSnapshot) {
      return {
        canRestore: false,
        status: inspection.status,
        errorCode: inspection.errorCode,
        message: inspection.message,
        projectId: params.projectId,
        lockHeldByCurrentSession,
        lockHeldByAnotherSession: false,
        hasRevisionConflict: false,
        hasNewerCheckpointConflict: false,
        currentSavedRevision,
        recoveredRevision: null,
        envelope: inspection.envelope,
        migratedSnapshot: null,
        wasMigrated: inspection.wasMigrated,
        mediaVerification: null,
      };
    }

    const recoveredDoc = inspection.migratedSnapshot;
    const hasRevisionConflict =
      currentSavedRevision !== null && recoveredDoc.revision < currentSavedRevision;

    const hasNewerCheckpointConflict =
      params.expectedCheckpointSequenceNumber !== undefined &&
      inspection.envelope.sequenceNumber > params.expectedCheckpointSequenceNumber;

    const mediaVerification = params.availableLocalAssetsMap
      ? verifyRecoveredMediaReferences(
          recoveredDoc,
          inspection.envelope.requiredAssetIdentities,
          params.availableLocalAssetsMap,
        )
      : null;

    if (!lockHeldByCurrentSession) {
      return {
        canRestore: false,
        status: 'RECOVERY_AVAILABLE',
        errorCode: 'LOCK_NOT_HELD',
        message: 'Acquire exclusive project lock before restoring recovery checkpoint.',
        projectId: params.projectId,
        lockHeldByCurrentSession: false,
        lockHeldByAnotherSession: false,
        hasRevisionConflict,
        hasNewerCheckpointConflict,
        currentSavedRevision,
        recoveredRevision: recoveredDoc.revision,
        envelope: inspection.envelope,
        migratedSnapshot: structuredClone(recoveredDoc),
        wasMigrated: inspection.wasMigrated,
        mediaVerification,
      };
    }

    if (hasNewerCheckpointConflict) {
      return {
        canRestore: false,
        status: 'RECOVERY_AVAILABLE',
        errorCode: 'CONFLICT_NEWER_CHECKPOINT_EXISTS',
        message: `A newer verified checkpoint (seq ${inspection.envelope.sequenceNumber}) exists compared to expected seq ${params.expectedCheckpointSequenceNumber}.`,
        projectId: params.projectId,
        lockHeldByCurrentSession: true,
        lockHeldByAnotherSession: false,
        hasRevisionConflict,
        hasNewerCheckpointConflict: true,
        currentSavedRevision,
        recoveredRevision: recoveredDoc.revision,
        envelope: inspection.envelope,
        migratedSnapshot: structuredClone(recoveredDoc),
        wasMigrated: inspection.wasMigrated,
        mediaVerification,
      };
    }

    if (hasRevisionConflict) {
      return {
        canRestore: false,
        status: 'RECOVERY_AVAILABLE',
        errorCode: 'CONFLICT_STALE_CHECKPOINT',
        message: `Recovery checkpoint revision (${recoveredDoc.revision}) is older than current saved project revision (${currentSavedRevision}); explicit conflict resolution required.`,
        projectId: params.projectId,
        lockHeldByCurrentSession: true,
        lockHeldByAnotherSession: false,
        hasRevisionConflict: true,
        hasNewerCheckpointConflict: false,
        currentSavedRevision,
        recoveredRevision: recoveredDoc.revision,
        envelope: inspection.envelope,
        migratedSnapshot: structuredClone(recoveredDoc),
        wasMigrated: inspection.wasMigrated,
        mediaVerification,
      };
    }

    return {
      canRestore: true,
      status: 'RECOVERY_AVAILABLE',
      errorCode: null,
      message: 'Verified recovery checkpoint is ready to restore.',
      projectId: params.projectId,
      lockHeldByCurrentSession: true,
      lockHeldByAnotherSession: false,
      hasRevisionConflict: false,
      hasNewerCheckpointConflict: false,
      currentSavedRevision,
      recoveredRevision: recoveredDoc.revision,
      envelope: inspection.envelope,
      migratedSnapshot: structuredClone(recoveredDoc),
      wasMigrated: inspection.wasMigrated,
      mediaVerification,
    };
  }

  /**
   * Executes safe crash recovery while preserving the original project intact on any failure
   * or unresolved conflict.
   */
  public async executeSafeCrashRecovery(params: {
    readonly currentSavedProject: ProjectDocument;
    readonly availableLocalAssetsMap?: ReadonlyMap<string, AssetIdentityRecord>;
    readonly expectedCheckpointSequenceNumber?: number;
    readonly conflictResolution?: 'REJECT_STALE' | 'FORCE_RESTORE_STALE';
  }): Promise<SafeCrashRecoveryExecutionResult> {
    const originalSnapshot = structuredClone(params.currentSavedProject);
    const plan = await this.planCrashRecovery({
      projectId: params.currentSavedProject.projectId,
      currentSavedProject: originalSnapshot,
      availableLocalAssetsMap: params.availableLocalAssetsMap,
      expectedCheckpointSequenceNumber: params.expectedCheckpointSequenceNumber,
    });

    const allowForcedStale =
      params.conflictResolution === 'FORCE_RESTORE_STALE' &&
      plan.errorCode === 'CONFLICT_STALE_CHECKPOINT' &&
      plan.lockHeldByCurrentSession &&
      !plan.lockHeldByAnotherSession &&
      !plan.hasNewerCheckpointConflict &&
      plan.migratedSnapshot !== null &&
      plan.envelope !== null;

    if (!plan.canRestore && !allowForcedStale) {
      return {
        restored: false,
        status: plan.status,
        errorCode: plan.errorCode,
        message: plan.message,
        document: originalSnapshot,
        originalProjectPreserved: true,
        wasMigrated: false,
        mediaVerification: plan.mediaVerification,
        restoredCheckpointId: null,
        restoredSequenceNumber: null,
      };
    }

    return {
      restored: true,
      status: 'RECOVERY_AVAILABLE',
      errorCode: null,
      message: allowForcedStale
        ? 'Restored stale recovery checkpoint under explicit user conflict resolution.'
        : 'Project safely restored from verified crash recovery checkpoint.',
      document: structuredClone(plan.migratedSnapshot!),
      originalProjectPreserved: false,
      wasMigrated: plan.wasMigrated,
      mediaVerification: plan.mediaVerification,
      restoredCheckpointId: plan.envelope!.checkpointId,
      restoredSequenceNumber: plan.envelope!.sequenceNumber,
    };
  }
}
