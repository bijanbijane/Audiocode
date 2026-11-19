import {
  assertValidProjectId,
  encodeProjectStorageKey,
} from './RecoveryCheckpointSchema';

/**
 * Runtime Reliability — Cryptographic Session Identity & Race-Free Project Session Locking.
 *
 * Locking strategy order:
 * 1. Primary: Browser Web Locks API (`navigator.locks`) with race-free same-tab ref-counting,
 *    guaranteed promise settlement, and monotonic fencing tokens.
 * 2. Fallback: Atomic IndexedDB compare-and-set lease (`avapardaz_runtime_locks_v1`) with
 *    monotonic fencing tokens, lease expiration, safe renewal, expired-lease reclamation,
 *    and ownership verification before release.
 * 3. Fail-Closed: When neither mechanism is available, explicitly reports `LOCK_UNAVAILABLE`
 *    and NEVER silently permits concurrent editing.
 */

export type ProjectLockState =
  | 'UNLOCKED'
  | 'ACQUIRING'
  | 'LOCKED'
  | 'CONTENDED'
  | 'LOCK_UNAVAILABLE'
  | 'RELEASED'
  | 'ERROR';

export type ProjectLockStrategy = 'WEB_LOCKS' | 'INDEXEDDB_LEASE' | 'NONE';

export type ProjectLockReasonCode =
  | 'LOCK_ACQUIRED_WEB_LOCKS'
  | 'LOCK_ACQUIRED_INDEXEDDB_LEASE'
  | 'LOCK_REENTRANT_SAME_SESSION'
  | 'LOCK_CONTENDED_OTHER_SESSION'
  | 'LOCK_BACKEND_UNAVAILABLE'
  | 'LOCK_REQUEST_REJECTED'
  | 'LOCK_RELEASED_BEFORE_ACQUIRE'
  | 'LOCK_LEASE_EXPIRED'
  | 'LOCK_LEASE_STOLEN'
  | 'LOCK_RENEWAL_FAILED'
  | 'LOCK_INVALID_PROJECT_ID';

export interface ProjectLockAcquisitionResult {
  readonly acquired: boolean;
  readonly state: ProjectLockState;
  readonly strategy: ProjectLockStrategy;
  readonly projectId: string;
  readonly sessionId: string;
  readonly fencingToken: number | null;
  readonly leaseExpiresAtMs: number | null;
  readonly reasonCode: ProjectLockReasonCode;
  readonly message: string;
}

export interface ProjectLockRenewalResult {
  readonly renewed: boolean;
  readonly state: ProjectLockState;
  readonly fencingToken: number | null;
  readonly leaseExpiresAtMs: number | null;
  readonly reasonCode: ProjectLockReasonCode;
  readonly message: string;
}

export interface ProjectLockReleaseResult {
  readonly released: boolean;
  readonly state: ProjectLockState;
  readonly reasonCode: string;
  readonly message: string;
}

export interface ProjectLeaseRecord {
  readonly projectKey: string;
  readonly projectId: string;
  readonly ownerSessionId: string;
  readonly acquiredAtMs: number;
  readonly renewedAtMs: number;
  readonly expiresAtMs: number;
  readonly fencingToken: number;
}

export interface WebLocksApiLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' },
    callback: (lock: { name: string } | null) => Promise<void> | void,
  ): Promise<unknown>;
}

/**
 * Atomic compare-and-set lease storage contract (backed by IndexedDB transactions in browsers
 * or deterministic in-memory atomic store in unit tests).
 */
export interface AtomicLeaseStore {
  readonly isDurable: boolean;
  tryAcquireLease(params: {
    readonly projectKey: string;
    readonly projectId: string;
    readonly ownerSessionId: string;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): Promise<{
    readonly acquired: boolean;
    readonly lease: ProjectLeaseRecord | null;
    readonly activeOwnerSessionId: string | null;
  }>;
  tryRenewLease(params: {
    readonly projectKey: string;
    readonly ownerSessionId: string;
    readonly expectedFencingToken: number;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): Promise<{
    readonly renewed: boolean;
    readonly lease: ProjectLeaseRecord | null;
    readonly reason: 'RENEWED' | 'EXPIRED' | 'NOT_OWNER' | 'MISSING';
  }>;
  tryReleaseLease(params: {
    readonly projectKey: string;
    readonly ownerSessionId: string;
    readonly expectedFencingToken: number;
  }): Promise<{
    readonly released: boolean;
    readonly reason: 'RELEASED' | 'NOT_OWNER' | 'MISSING';
  }>;
  inspectLease(projectKey: string, nowMs: number): Promise<{
    readonly lease: ProjectLeaseRecord | null;
    readonly isActive: boolean;
  }>;
  cleanupExpiredLeases(nowMs: number): Promise<number>;
}

export interface LockLossEvent {
  readonly projectId: string;
  readonly sessionId: string;
  readonly previousFencingToken: number | null;
  readonly nextState: ProjectLockState;
  readonly reasonCode: ProjectLockReasonCode;
  readonly message: string;
}

/**
 * Generates a collision-resistant cryptographically random session identifier.
 * Uses `crypto.randomUUID()` when available, falling back to `crypto.getRandomValues()`.
 * Never uses `Math.random()`.
 */
export function generateSecureSessionId(prefix = 'sess'): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `${prefix}_${cryptoObj.randomUUID()}`;
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    // RFC 4122 version 4 UUID bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return `${prefix}_${uuid}`;
  }
  throw new Error('CRYPTO_UNAVAILABLE: Secure cryptographic randomness is unavailable for session identity.');
}

/**
 * Shared same-tab Web Locks coordinator with race-free ref-counting and per-session tracking.
 */
interface SameTabWebLockEntry {
  readonly projectKey: string;
  readonly lockName: string;
  readonly holders: Set<string>;
  readonly cancelledBeforeGrant: Set<string>;
  status: 'ACQUIRING' | 'HELD' | 'FAILED' | 'RELEASED';
  fencingToken: number;
  releaseWebLock: (() => void) | null;
  requestCompletionPromise: Promise<void> | null;
  acquirePromise: Promise<{ acquired: boolean; fencingToken: number; reasonCode: ProjectLockReasonCode; message: string }>;
}

export class WebLocksCoordinator {
  private readonly entries = new Map<string, SameTabWebLockEntry>();
  private nextFencingToken = 1;

  constructor(private readonly locksApi: WebLocksApiLike) {}

  public isHeldInCurrentTab(projectKey: string, excludeSessionId?: string): boolean {
    const entry = this.entries.get(projectKey);
    if (!entry || entry.status !== 'HELD') return false;
    if (!excludeSessionId) return entry.holders.size > 0;
    for (const h of entry.holders) {
      if (h !== excludeSessionId) return true;
    }
    return false;
  }

  public getSameTabHolderCount(projectKey: string): number {
    return this.entries.get(projectKey)?.holders.size ?? 0;
  }

  public async acquire(
    projectId: string,
    sessionId: string,
    allowSameTabRefCount = true,
  ): Promise<ProjectLockAcquisitionResult> {
    const projectKey = encodeProjectStorageKey(projectId);
    const existing = this.entries.get(projectKey);

    if (existing && (existing.status === 'HELD' || existing.status === 'ACQUIRING')) {
      if (existing.holders.has(sessionId)) {
        // Idempotent re-acquire for the same session
        const outcome = await existing.acquirePromise;
        if (outcome.acquired && existing.holders.has(sessionId)) {
          return {
            acquired: true,
            state: 'LOCKED',
            strategy: 'WEB_LOCKS',
            projectId,
            sessionId,
            fencingToken: outcome.fencingToken,
            leaseExpiresAtMs: null,
            reasonCode: 'LOCK_REENTRANT_SAME_SESSION',
            message: 'Session already holds exclusive Web Lock for this project.',
          };
        }
      } else if (allowSameTabRefCount) {
        existing.holders.add(sessionId);
        existing.cancelledBeforeGrant.delete(sessionId);
        const outcome = await existing.acquirePromise;
        if (!outcome.acquired) {
          existing.holders.delete(sessionId);
          return {
            acquired: false,
            state:
              outcome.reasonCode === 'LOCK_REQUEST_REJECTED' ? 'ERROR' : 'CONTENDED',
            strategy: 'WEB_LOCKS',
            projectId,
            sessionId,
            fencingToken: null,
            leaseExpiresAtMs: null,
            reasonCode: outcome.reasonCode,
            message: outcome.message,
          };
        }
        if (existing.cancelledBeforeGrant.has(sessionId) || !existing.holders.has(sessionId)) {
          existing.cancelledBeforeGrant.delete(sessionId);
          return {
            acquired: false,
            state: 'RELEASED',
            strategy: 'WEB_LOCKS',
            projectId,
            sessionId,
            fencingToken: null,
            leaseExpiresAtMs: null,
            reasonCode: 'LOCK_RELEASED_BEFORE_ACQUIRE',
            message: 'Lock acquisition was released before completion.',
          };
        }
        return {
          acquired: true,
          state: 'LOCKED',
          strategy: 'WEB_LOCKS',
          projectId,
          sessionId,
          fencingToken: outcome.fencingToken,
          leaseExpiresAtMs: null,
          reasonCode: 'LOCK_ACQUIRED_WEB_LOCKS',
          message: 'Acquired same-tab reference to active Web Lock.',
        };
      } else {
        return {
          acquired: false,
          state: 'CONTENDED',
          strategy: 'WEB_LOCKS',
          projectId,
          sessionId,
          fencingToken: null,
          leaseExpiresAtMs: null,
          reasonCode: 'LOCK_CONTENDED_OTHER_SESSION',
          message: 'Project lock is currently held by another session.',
        };
      }
    }

    const lockName = `avapardaz_project_edit_lock_${projectKey}`;
    const token = this.nextFencingToken++;

    let settleAcquire!: (res: {
      acquired: boolean;
      fencingToken: number;
      reasonCode: ProjectLockReasonCode;
      message: string;
    }) => void;
    let settled = false;
    const safeSettle = (res: {
      acquired: boolean;
      fencingToken: number;
      reasonCode: ProjectLockReasonCode;
      message: string;
    }) => {
      if (!settled) {
        settled = true;
        settleAcquire(res);
      }
    };

    const acquirePromise = new Promise<{
      acquired: boolean;
      fencingToken: number;
      reasonCode: ProjectLockReasonCode;
      message: string;
    }>((resolve) => {
      settleAcquire = resolve;
    });

    const entry: SameTabWebLockEntry = {
      projectKey,
      lockName,
      holders: new Set([sessionId]),
      cancelledBeforeGrant: new Set(),
      status: 'ACQUIRING',
      fencingToken: token,
      releaseWebLock: null,
      requestCompletionPromise: null,
      acquirePromise,
    };
    this.entries.set(projectKey, entry);

    // Invoke Web Locks API safely — catch BOTH synchronous throws and asynchronous rejections
    let requestPromise: Promise<unknown>;
    try {
      requestPromise = Promise.resolve(
        this.locksApi.request(lockName, { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
          if (!lock) {
            entry.status = 'FAILED';
            if (this.entries.get(projectKey) === entry) {
              this.entries.delete(projectKey);
            }
            safeSettle({
              acquired: false,
              fencingToken: 0,
              reasonCode: 'LOCK_CONTENDED_OTHER_SESSION',
              message: 'Project lock is currently held by another tab or session.',
            });
            return;
          }

          // If all holders released before the lock callback executed, release immediately
          if (entry.holders.size === 0) {
            entry.status = 'RELEASED';
            if (this.entries.get(projectKey) === entry) {
              this.entries.delete(projectKey);
            }
            safeSettle({
              acquired: false,
              fencingToken: 0,
              reasonCode: 'LOCK_RELEASED_BEFORE_ACQUIRE',
              message: 'Lock was released before Web Locks grant completed.',
            });
            return;
          }

          entry.status = 'HELD';
          safeSettle({
            acquired: true,
            fencingToken: token,
            reasonCode: 'LOCK_ACQUIRED_WEB_LOCKS',
            message: 'Exclusive Web Lock acquired.',
          });

          await new Promise<void>((resolveRelease) => {
            if (entry.holders.size === 0 || entry.status === 'RELEASED') {
              if (this.entries.get(projectKey) === entry) {
                this.entries.delete(projectKey);
              }
              resolveRelease();
              return;
            }
            entry.releaseWebLock = resolveRelease;
          });
        }),
      );
    } catch (syncErr) {
      entry.status = 'FAILED';
      entry.holders.clear();
      if (this.entries.get(projectKey) === entry) {
        this.entries.delete(projectKey);
      }
      safeSettle({
        acquired: false,
        fencingToken: 0,
        reasonCode: 'LOCK_REQUEST_REJECTED',
        message: syncErr instanceof Error ? syncErr.message : 'Web Locks request threw synchronously.',
      });
      requestPromise = Promise.resolve();
    }

    entry.requestCompletionPromise = requestPromise.then(
      () => undefined,
      (asyncErr) => {
        entry.status = 'FAILED';
        entry.holders.clear();
        if (this.entries.get(projectKey) === entry) {
          this.entries.delete(projectKey);
        }
        safeSettle({
          acquired: false,
          fencingToken: 0,
          reasonCode: 'LOCK_REQUEST_REJECTED',
          message: asyncErr instanceof Error ? asyncErr.message : 'Web Locks request rejected.',
        });
      },
    );

    const outcome = await acquirePromise;

    if (!outcome.acquired) {
      entry.holders.delete(sessionId);
      const state: ProjectLockState =
        outcome.reasonCode === 'LOCK_RELEASED_BEFORE_ACQUIRE'
          ? 'RELEASED'
          : outcome.reasonCode === 'LOCK_CONTENDED_OTHER_SESSION'
            ? 'CONTENDED'
            : 'ERROR';
      return {
        acquired: false,
        state,
        strategy: 'WEB_LOCKS',
        projectId,
        sessionId,
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
      };
    }

    // Double-check whether this specific session called release() while awaiting
    if (entry.cancelledBeforeGrant.has(sessionId) || !entry.holders.has(sessionId)) {
      entry.cancelledBeforeGrant.delete(sessionId);
      return {
        acquired: false,
        state: 'RELEASED',
        strategy: 'WEB_LOCKS',
        projectId,
        sessionId,
        fencingToken: null,
        leaseExpiresAtMs: null,
        reasonCode: 'LOCK_RELEASED_BEFORE_ACQUIRE',
        message: 'Lock was released before acquisition settled.',
      };
    }

    return {
      acquired: true,
      state: 'LOCKED',
      strategy: 'WEB_LOCKS',
      projectId,
      sessionId,
      fencingToken: outcome.fencingToken,
      leaseExpiresAtMs: null,
      reasonCode: 'LOCK_ACQUIRED_WEB_LOCKS',
      message: 'Exclusive Web Lock acquired.',
    };
  }

  public async releaseAsync(projectId: string, sessionId: string): Promise<ProjectLockReleaseResult> {
    const projectKey = encodeProjectStorageKey(projectId);
    const entry = this.entries.get(projectKey);
    const completion = entry?.requestCompletionPromise ?? null;
    const result = this.release(projectId, sessionId);
    if (result.released && entry && entry.holders.size === 0 && completion) {
      await completion.catch(() => {});
    }
    return result;
  }

  public release(projectId: string, sessionId: string): ProjectLockReleaseResult {
    const projectKey = encodeProjectStorageKey(projectId);
    const entry = this.entries.get(projectKey);
    if (!entry) {
      return {
        released: false,
        state: 'RELEASED',
        reasonCode: 'LOCK_NOT_HELD',
        message: 'No active Web Lock entry for project.',
      };
    }

    if (!entry.holders.has(sessionId)) {
      return {
        released: false,
        state: 'RELEASED',
        reasonCode: 'SESSION_NOT_HOLDER',
        message: 'Session does not hold this project lock.',
      };
    }

    entry.holders.delete(sessionId);
    if (entry.status === 'ACQUIRING') {
      entry.cancelledBeforeGrant.add(sessionId);
    }

    if (entry.holders.size === 0) {
      entry.status = 'RELEASED';
      if (this.entries.get(projectKey) === entry) {
        this.entries.delete(projectKey);
      }
      if (entry.releaseWebLock) {
        const fn = entry.releaseWebLock;
        entry.releaseWebLock = null;
        fn();
      }
    }

    return {
      released: true,
      state: 'RELEASED',
      reasonCode: 'LOCK_RELEASED',
      message: 'Web Lock reference released.',
    };
  }

  /** Test/diagnostic helper to inspect active registry size. */
  public getActiveLockCount(): number {
    return this.entries.size;
  }
}

/**
 * Browser IndexedDB atomic compare-and-set lease store.
 * Every acquire/renew/release executes inside a single `readwrite` IndexedDB transaction,
 * guaranteeing cross-tab atomicity without relying on localStorage.
 */
const IDB_LOCK_DB_NAME = 'avapardaz_runtime_locks_v1';
const IDB_LOCK_STORE_NAME = 'project_leases';
const IDB_LOCK_DB_VERSION = 1;

export class IndexedDbAtomicLeaseStore implements AtomicLeaseStore {
  public readonly isDurable = true;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly idbFactory: IDBFactory) {}

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = this.idbFactory.open(IDB_LOCK_DB_NAME, IDB_LOCK_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_LOCK_STORE_NAME)) {
            db.createObjectStore(IDB_LOCK_STORE_NAME, { keyPath: 'projectKey' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          this.dbPromise = null;
          reject(req.error ?? new Error('Failed to open IndexedDB lock store.'));
        };
        req.onblocked = () => {
          this.dbPromise = null;
          reject(new Error('IndexedDB lock store open blocked by another connection.'));
        };
      } catch (err) {
        this.dbPromise = null;
        reject(err);
      }
    });
    return this.dbPromise;
  }

  public async tryAcquireLease(params: {
    readonly projectKey: string;
    readonly projectId: string;
    readonly ownerSessionId: string;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): Promise<{
    readonly acquired: boolean;
    readonly lease: ProjectLeaseRecord | null;
    readonly activeOwnerSessionId: string | null;
  }> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_LOCK_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_LOCK_STORE_NAME);
      const getReq = store.get(params.projectKey);

      let result: {
        acquired: boolean;
        lease: ProjectLeaseRecord | null;
        activeOwnerSessionId: string | null;
      } = { acquired: false, lease: null, activeOwnerSessionId: null };

      getReq.onsuccess = () => {
        const existing = getReq.result as ProjectLeaseRecord | undefined;
        if (
          existing &&
          existing.ownerSessionId !== params.ownerSessionId &&
          existing.expiresAtMs > params.nowMs
        ) {
          result = {
            acquired: false,
            lease: null,
            activeOwnerSessionId: existing.ownerSessionId,
          };
          return;
        }

        const nextToken =
          existing && existing.ownerSessionId === params.ownerSessionId && existing.expiresAtMs > params.nowMs
            ? existing.fencingToken
            : (existing?.fencingToken ?? 0) + 1;

        const nextLease: ProjectLeaseRecord = {
          projectKey: params.projectKey,
          projectId: params.projectId,
          ownerSessionId: params.ownerSessionId,
          acquiredAtMs:
            existing && existing.ownerSessionId === params.ownerSessionId && existing.expiresAtMs > params.nowMs
              ? existing.acquiredAtMs
              : params.nowMs,
          renewedAtMs: params.nowMs,
          expiresAtMs: params.nowMs + params.ttlMs,
          fencingToken: nextToken,
        };
        store.put(nextLease);
        result = {
          acquired: true,
          lease: nextLease,
          activeOwnerSessionId: params.ownerSessionId,
        };
      };

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB lease acquire transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB lease acquire transaction aborted.'));
    });
  }

  public async tryRenewLease(params: {
    readonly projectKey: string;
    readonly ownerSessionId: string;
    readonly expectedFencingToken: number;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): Promise<{
    readonly renewed: boolean;
    readonly lease: ProjectLeaseRecord | null;
    readonly reason: 'RENEWED' | 'EXPIRED' | 'NOT_OWNER' | 'MISSING';
  }> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_LOCK_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_LOCK_STORE_NAME);
      const getReq = store.get(params.projectKey);

      let result: {
        renewed: boolean;
        lease: ProjectLeaseRecord | null;
        reason: 'RENEWED' | 'EXPIRED' | 'NOT_OWNER' | 'MISSING';
      } = { renewed: false, lease: null, reason: 'MISSING' };

      getReq.onsuccess = () => {
        const existing = getReq.result as ProjectLeaseRecord | undefined;
        if (!existing) {
          result = { renewed: false, lease: null, reason: 'MISSING' };
          return;
        }
        if (
          existing.ownerSessionId !== params.ownerSessionId ||
          existing.fencingToken !== params.expectedFencingToken
        ) {
          result = { renewed: false, lease: null, reason: 'NOT_OWNER' };
          return;
        }
        if (existing.expiresAtMs <= params.nowMs) {
          result = { renewed: false, lease: null, reason: 'EXPIRED' };
          return;
        }

        const updated: ProjectLeaseRecord = {
          ...existing,
          renewedAtMs: params.nowMs,
          expiresAtMs: params.nowMs + params.ttlMs,
        };
        store.put(updated);
        result = { renewed: true, lease: updated, reason: 'RENEWED' };
      };

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB lease renewal transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB lease renewal transaction aborted.'));
    });
  }

  public async tryReleaseLease(params: {
    readonly projectKey: string;
    readonly ownerSessionId: string;
    readonly expectedFencingToken: number;
  }): Promise<{
    readonly released: boolean;
    readonly reason: 'RELEASED' | 'NOT_OWNER' | 'MISSING';
  }> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_LOCK_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_LOCK_STORE_NAME);
      const getReq = store.get(params.projectKey);

      let result: { released: boolean; reason: 'RELEASED' | 'NOT_OWNER' | 'MISSING' } = {
        released: false,
        reason: 'MISSING',
      };

      getReq.onsuccess = () => {
        const existing = getReq.result as ProjectLeaseRecord | undefined;
        if (!existing) {
          result = { released: false, reason: 'MISSING' };
          return;
        }
        if (
          existing.ownerSessionId !== params.ownerSessionId ||
          existing.fencingToken !== params.expectedFencingToken
        ) {
          result = { released: false, reason: 'NOT_OWNER' };
          return;
        }
        store.delete(params.projectKey);
        result = { released: true, reason: 'RELEASED' };
      };

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB lease release transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB lease release transaction aborted.'));
    });
  }

  public async inspectLease(
    projectKey: string,
    nowMs: number,
  ): Promise<{ readonly lease: ProjectLeaseRecord | null; readonly isActive: boolean }> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_LOCK_STORE_NAME, 'readonly');
      const store = tx.objectStore(IDB_LOCK_STORE_NAME);
      const getReq = store.get(projectKey);
      getReq.onsuccess = () => {
        const lease = (getReq.result as ProjectLeaseRecord | undefined) ?? null;
        resolve({ lease, isActive: Boolean(lease && lease.expiresAtMs > nowMs) });
      };
      getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB inspectLease failed.'));
    });
  }

  public async cleanupExpiredLeases(nowMs: number): Promise<number> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_LOCK_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_LOCK_STORE_NAME);
      let cleaned = 0;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value as ProjectLeaseRecord;
        if (rec && rec.expiresAtMs <= nowMs) {
          cursor.delete();
          cleaned++;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(cleaned);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB cleanupExpiredLeases failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB cleanupExpiredLeases aborted.'));
    });
  }
}

/**
 * Deterministic in-memory atomic lease store for testing IndexedDB lease contention,
 * expiration, fencing, renewal, and stale-owner rejection without real browser timers.
 */
export class InMemoryAtomicLeaseStore implements AtomicLeaseStore {
  public readonly isDurable = true;
  private readonly leases = new Map<string, ProjectLeaseRecord>();
  private readonly maxTokenSeen = new Map<string, number>();

  public async tryAcquireLease(params: {
    readonly projectKey: string;
    readonly projectId: string;
    readonly ownerSessionId: string;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): Promise<{
    readonly acquired: boolean;
    readonly lease: ProjectLeaseRecord | null;
    readonly activeOwnerSessionId: string | null;
  }> {
    const existing = this.leases.get(params.projectKey);
    if (
      existing &&
      existing.ownerSessionId !== params.ownerSessionId &&
      existing.expiresAtMs > params.nowMs
    ) {
      return {
        acquired: false,
        lease: null,
        activeOwnerSessionId: existing.ownerSessionId,
      };
    }

    const isReentrantActive =
      existing &&
      existing.ownerSessionId === params.ownerSessionId &&
      existing.expiresAtMs > params.nowMs;

    const prevMax = Math.max(
      this.maxTokenSeen.get(params.projectKey) ?? 0,
      existing?.fencingToken ?? 0,
    );
    const nextToken = isReentrantActive ? existing.fencingToken : prevMax + 1;
    this.maxTokenSeen.set(params.projectKey, nextToken);

    const nextLease: ProjectLeaseRecord = {
      projectKey: params.projectKey,
      projectId: params.projectId,
      ownerSessionId: params.ownerSessionId,
      acquiredAtMs: isReentrantActive ? existing.acquiredAtMs : params.nowMs,
      renewedAtMs: params.nowMs,
      expiresAtMs: params.nowMs + params.ttlMs,
      fencingToken: nextToken,
    };
    this.leases.set(params.projectKey, nextLease);
    return {
      acquired: true,
      lease: nextLease,
      activeOwnerSessionId: params.ownerSessionId,
    };
  }

  public async tryRenewLease(params: {
    readonly projectKey: string;
    readonly ownerSessionId: string;
    readonly expectedFencingToken: number;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): Promise<{
    readonly renewed: boolean;
    readonly lease: ProjectLeaseRecord | null;
    readonly reason: 'RENEWED' | 'EXPIRED' | 'NOT_OWNER' | 'MISSING';
  }> {
    const existing = this.leases.get(params.projectKey);
    if (!existing) return { renewed: false, lease: null, reason: 'MISSING' };
    if (
      existing.ownerSessionId !== params.ownerSessionId ||
      existing.fencingToken !== params.expectedFencingToken
    ) {
      return { renewed: false, lease: null, reason: 'NOT_OWNER' };
    }
    if (existing.expiresAtMs <= params.nowMs) {
      return { renewed: false, lease: null, reason: 'EXPIRED' };
    }
    const updated: ProjectLeaseRecord = {
      ...existing,
      renewedAtMs: params.nowMs,
      expiresAtMs: params.nowMs + params.ttlMs,
    };
    this.leases.set(params.projectKey, updated);
    return { renewed: true, lease: updated, reason: 'RENEWED' };
  }

  public async tryReleaseLease(params: {
    readonly projectKey: string;
    readonly ownerSessionId: string;
    readonly expectedFencingToken: number;
  }): Promise<{
    readonly released: boolean;
    readonly reason: 'RELEASED' | 'NOT_OWNER' | 'MISSING';
  }> {
    const existing = this.leases.get(params.projectKey);
    if (!existing) return { released: false, reason: 'MISSING' };
    if (
      existing.ownerSessionId !== params.ownerSessionId ||
      existing.fencingToken !== params.expectedFencingToken
    ) {
      return { released: false, reason: 'NOT_OWNER' };
    }
    this.leases.delete(params.projectKey);
    return { released: true, reason: 'RELEASED' };
  }

  public async inspectLease(
    projectKey: string,
    nowMs: number,
  ): Promise<{ readonly lease: ProjectLeaseRecord | null; readonly isActive: boolean }> {
    const lease = this.leases.get(projectKey) ?? null;
    return { lease, isActive: Boolean(lease && lease.expiresAtMs > nowMs) };
  }

  public async cleanupExpiredLeases(nowMs: number): Promise<number> {
    let cleaned = 0;
    for (const [k, v] of this.leases.entries()) {
      if (v.expiresAtMs <= nowMs) {
        this.leases.delete(k);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Helper for inspecting all stored leases in tests. */
  public snapshotLeases(): ProjectLeaseRecord[] {
    return [...this.leases.values()];
  }
}

let sharedBrowserWebLocksCoordinator: WebLocksCoordinator | null = null;
let sharedBrowserIndexedDbLeaseStore: IndexedDbAtomicLeaseStore | null = null;

export function getDefaultBrowserWebLocksCoordinator(): WebLocksCoordinator | null {
  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks &&
    typeof navigator.locks.request === 'function'
  ) {
    if (!sharedBrowserWebLocksCoordinator) {
      sharedBrowserWebLocksCoordinator = new WebLocksCoordinator(navigator.locks as WebLocksApiLike);
    }
    return sharedBrowserWebLocksCoordinator;
  }
  return null;
}

export function getDefaultBrowserIndexedDbLeaseStore(): IndexedDbAtomicLeaseStore | null {
  if (typeof globalThis !== 'undefined' && 'indexedDB' in globalThis && globalThis.indexedDB) {
    if (!sharedBrowserIndexedDbLeaseStore) {
      sharedBrowserIndexedDbLeaseStore = new IndexedDbAtomicLeaseStore(globalThis.indexedDB);
    }
    return sharedBrowserIndexedDbLeaseStore;
  }
  return null;
}

/**
 * Resolves a project's safe key safely with validation.
 */
export function resolveSafeProjectLockKey(projectId: string): string {
  assertValidProjectId(projectId);
  return encodeProjectStorageKey(projectId);
}
