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

/**
 * Multi-Tab Web Locks & Crash Recovery Journal (Architecture Doc Sections 45 & 48)
 */
export class CrashRecoveryAndSessionLock {
  private readonly sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  private releaseLockFn: (() => void) | null = null;
  private readonly journalStore: RecoveryJournalStore;

  constructor(journalStore: RecoveryJournalStore = defaultOpfsJournalStore) {
    this.journalStore = journalStore;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async acquireExclusiveProjectLock(projectId: string): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('locks' in navigator)) return true;

    return new Promise<boolean>((resolve) => {
      navigator.locks.request(
        `project_edit_lock_${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          await new Promise<void>((release) => {
            this.releaseLockFn = release;
          });
        },
      );
    });
  }

  public releaseProjectLock(): void {
    if (this.releaseLockFn) {
      this.releaseLockFn();
      this.releaseLockFn = null;
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
