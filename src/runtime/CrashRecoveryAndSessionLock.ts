import { ProjectDocument } from '../contracts/project-schema.contract';

export interface RecoveryCheckpointRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly dirtyShutdownDetected: boolean;
  readonly lastCheckpointTimestamp: number;
  readonly snapshot: ProjectDocument;
}

export interface RecoveryJournalStore {
  write(projectId: string, jsonPayload: string): Promise<void>;
  read(projectId: string): Promise<string | null>;
}

const defaultOpfsJournalStore: RecoveryJournalStore = {
  async write(projectId: string, jsonPayload: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      return;
    }
    const root = await navigator.storage.getDirectory();
    const recDir = await root.getDirectoryHandle('recovery-journal', { create: true });
    const fileHandle = await recDir.getFileHandle(`${projectId}.checkpoint.json`, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(jsonPayload);
    await writable.close();
  },

  async read(projectId: string): Promise<string | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      return null;
    }
    try {
      const root = await navigator.storage.getDirectory();
      const recDir = await root.getDirectoryHandle('recovery-journal', { create: false });
      const fileHandle = await recDir.getFileHandle(`${projectId}.checkpoint.json`, {
        create: false,
      });
      const file = await fileHandle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  },
};

const sameTabHeldLocks = new Map<
  string,
  { refCount: number; releaseFn: (() => void) | null; pendingPromise: Promise<boolean> | null }
>();

/**
 * Multi-Tab Web Locks & Crash Recovery Journal (Architecture Doc Sections 45 & 48)
 */
export class CrashRecoveryAndSessionLock {
  private readonly sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  private heldProjectId: string | null = null;
  private isReleased = false;
  private readonly journalStore: RecoveryJournalStore;

  constructor(journalStore: RecoveryJournalStore = defaultOpfsJournalStore) {
    this.journalStore = journalStore;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async acquireExclusiveProjectLock(projectId: string): Promise<boolean> {
    this.isReleased = false;
    this.heldProjectId = projectId;
    if (typeof navigator === 'undefined' || !('locks' in navigator)) return true;

    const existing = sameTabHeldLocks.get(projectId);
    if (existing) {
      existing.refCount += 1;
      if (existing.pendingPromise) {
        return existing.pendingPromise;
      }
      return true;
    }

    const entry: {
      refCount: number;
      releaseFn: (() => void) | null;
      pendingPromise: Promise<boolean> | null;
    } = {
      refCount: 1,
      releaseFn: null,
      pendingPromise: null,
    };
    sameTabHeldLocks.set(projectId, entry);

    const promise = new Promise<boolean>((resolve) => {
      navigator.locks.request(
        `project_edit_lock_${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            sameTabHeldLocks.delete(projectId);
            resolve(false);
            return;
          }
          if (entry.refCount <= 0) {
            sameTabHeldLocks.delete(projectId);
            resolve(true);
            return;
          }
          resolve(true);
          await new Promise<void>((release) => {
            if (entry.refCount <= 0) {
              sameTabHeldLocks.delete(projectId);
              release();
              return;
            }
            entry.releaseFn = release;
          });
        },
      );
    });

    entry.pendingPromise = promise;
    return promise;
  }

  public releaseProjectLock(): void {
    if (this.isReleased || !this.heldProjectId) return;
    this.isReleased = true;
    const projectId = this.heldProjectId;
    this.heldProjectId = null;
    const entry = sameTabHeldLocks.get(projectId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0 && entry.releaseFn) {
      sameTabHeldLocks.delete(projectId);
      const fn = entry.releaseFn;
      entry.releaseFn = null;
      fn();
    }
  }

  public async writeRecoveryCheckpoint(doc: ProjectDocument, isCleanExit = false): Promise<void> {
    const record: RecoveryCheckpointRecord = {
      projectId: doc.projectId,
      sessionId: this.sessionId,
      dirtyShutdownDetected: !isCleanExit,
      lastCheckpointTimestamp: Date.now(),
      snapshot: doc,
    };
    await this.journalStore.write(doc.projectId, JSON.stringify(record));
  }

  public async checkCrashRecovery(projectId: string): Promise<RecoveryCheckpointRecord | null> {
    try {
      const text = await this.journalStore.read(projectId);
      if (!text) return null;
      const parsed = JSON.parse(text) as RecoveryCheckpointRecord;
      return parsed.dirtyShutdownDetected ? parsed : null;
    } catch {
      return null;
    }
  }
}
