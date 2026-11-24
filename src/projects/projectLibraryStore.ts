/**
 * AVAPARDAZ — Local-First IndexedDB Project Library & Ref-Counted Audio Blob Store (Phase 02)
 *
 * Stores:
 * - `projects`: PersistedProjectRecord (metadata + tracks + tokens + recommendations + projectPreferences)
 * - `audioBlobs`: PersistedAudioBlobRecord (immutable audio File/Blob deduplicated by SHA-256 with refCount)
 *
 * Guarantees:
 * - Atomic project creation: rolls back blob refCount if project record write fails (zero orphans).
 * - Safe Duplicate: increments audioBlob.refCount and clones mutable tracks/tokens/recommendations.
 * - Safe Delete: decrements audioBlob.refCount and deletes the underlying audio blob ONLY when refCount reaches 0.
 * - Corrupt record protection: validates every read record with `isPersistedProjectRecordValid`.
 * - Graceful memory fallback when IndexedDB is unavailable in restricted contexts.
 */

import {
  PersistedAudioBlobMeta,
  PersistedProjectRecord,
  PersistedProjectSummary,
  ProjectPreferencesRecord,
  buildDuplicatedProjectRecord,
  deriveProjectStatus,
  isPersistedProjectRecordValid,
  planBlobRefCountOnDelete,
  validateProjectName,
} from './projectLibraryLogic';
import type { PersianWordToken, SmartRecommendation, Track } from '../contracts/v1_2';

const DB_NAME = 'avapardaz_project_hub_v1';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_AUDIO_BLOBS = 'audioBlobs';

interface PersistedAudioBlobRecord extends PersistedAudioBlobMeta {
  blob: Blob;
}

export type ProjectStoreErrorCode =
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_CORRUPTED'
  | 'AUDIO_BLOB_MISSING'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_ERROR';

export class ProjectStoreError extends Error {
  public readonly code: ProjectStoreErrorCode;
  public readonly messageFa: string;

  constructor(code: ProjectStoreErrorCode, messageEn: string, messageFa: string) {
    super(messageEn);
    this.name = 'ProjectStoreError';
    this.code = code;
    this.messageFa = messageFa;
  }
}

export interface StorageUsageEstimate {
  readonly supported: boolean;
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
  readonly projectCount: number;
  readonly audioBlobCount: number;
  readonly totalAudioBytes: number;
}

function classifyStorageError(err: unknown): ProjectStoreError {
  if (err instanceof ProjectStoreError) return err;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return new ProjectStoreError(
      'STORAGE_QUOTA_EXCEEDED',
      'Browser local storage quota exceeded.',
      'فضای ذخیره‌سازی محلی مرورگر پر شده است. لطفاً چند پروژه قدیمی را حذف کنید و دوباره تلاش کنید.',
    );
  }
  return new ProjectStoreError(
    'UNKNOWN_ERROR',
    msg || 'Unexpected project storage failure.',
    'خطای غیرمنتظره در ذخیره‌سازی محلی پروژه رخ داد. لطفاً دوباره تلاش کنید.',
  );
}

async function computeBlobSha256Hex(blob: Blob): Promise<string> {
  try {
    const buf = await blob.arrayBuffer();
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    // Deterministic lightweight fallback hash if crypto.subtle unavailable
    const view = new Uint8Array(buf);
    let h = 2166136261;
    const step = Math.max(1, Math.floor(view.length / 4096));
    for (let i = 0; i < view.length; i += step) {
      h ^= view[i];
      h = Math.imul(h, 16777619);
    }
    return `fnv_${(h >>> 0).toString(16)}_${blob.size}`;
  } catch {
    return `sz_${blob.size}_${Date.now()}`;
  }
}

function createProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `proj_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toSummary(record: PersistedProjectRecord): PersistedProjectSummary {
  return {
    id: record.id,
    schemaVersion: record.schemaVersion,
    name: record.name,
    sourceFileName: record.sourceFileName,
    sourceFileType: record.sourceFileType,
    sourceFileSizeBytes: record.sourceFileSizeBytes,
    audioBlobId: record.audioBlobId,
    durationSec: record.durationSec,
    sampleRate: record.sampleRate,
    trackCount: record.trackCount,
    wordCount: record.wordCount,
    pendingSuggestionCount: record.pendingSuggestionCount,
    status: record.status,
    storageState: record.storageState,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    lastOpenedAtMs: record.lastOpenedAtMs,
    waveformPreviewPeaks: record.waveformPreviewPeaks,
  };
}

class ProjectLibraryRepository {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private memProjects = new Map<string, PersistedProjectRecord>();
  private memBlobs = new Map<string, PersistedAudioBlobRecord>();

  private openDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined') {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
            db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_AUDIO_BLOBS)) {
            db.createObjectStore(STORE_AUDIO_BLOBS, { keyPath: 'blobId' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  private idbReq<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IDB request failed'));
    });
  }

  public async listProjects(): Promise<{
    projects: PersistedProjectSummary[];
    corruptedCount: number;
  }> {
    try {
      const db = await this.openDb();
      let rawRecords: unknown[] = [];
      if (db) {
        const tx = db.transaction(STORE_PROJECTS, 'readonly');
        rawRecords = await this.idbReq(tx.objectStore(STORE_PROJECTS).getAll());
      } else {
        rawRecords = Array.from(this.memProjects.values());
      }

      const projects: PersistedProjectSummary[] = [];
      let corruptedCount = 0;
      for (const rec of rawRecords) {
        if (isPersistedProjectRecordValid(rec)) {
          projects.push(toSummary(rec));
        } else {
          corruptedCount++;
        }
      }
      return { projects, corruptedCount };
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  public async getProjectWithAudio(projectId: string): Promise<{
    record: PersistedProjectRecord;
    audioFile: File;
  }> {
    try {
      const db = await this.openDb();
      let rawRecord: unknown;
      let blobRec: PersistedAudioBlobRecord | undefined;

      if (db) {
        const tx = db.transaction([STORE_PROJECTS, STORE_AUDIO_BLOBS], 'readonly');
        rawRecord = await this.idbReq(tx.objectStore(STORE_PROJECTS).get(projectId));
        if (isPersistedProjectRecordValid(rawRecord)) {
          blobRec = await this.idbReq(tx.objectStore(STORE_AUDIO_BLOBS).get(rawRecord.audioBlobId));
        }
      } else {
        rawRecord = this.memProjects.get(projectId);
        if (isPersistedProjectRecordValid(rawRecord)) {
          blobRec = this.memBlobs.get(rawRecord.audioBlobId);
        }
      }

      if (!rawRecord) {
        throw new ProjectStoreError(
          'PROJECT_NOT_FOUND',
          `Project "${projectId}" was not found.`,
          'پروژه درخواستی در حافظه محلی پیدا نشد.',
        );
      }

      if (!isPersistedProjectRecordValid(rawRecord)) {
        throw new ProjectStoreError(
          'PROJECT_CORRUPTED',
          `Project "${projectId}" metadata is corrupted.`,
          'ساختار ذخیره‌شده این پروژه دچار آسیب شده و قابل بازکردن نیست.',
        );
      }

      if (!blobRec || !(blobRec.blob instanceof Blob)) {
        throw new ProjectStoreError(
          'AUDIO_BLOB_MISSING',
          `Audio asset "${rawRecord.audioBlobId}" is missing for project "${projectId}".`,
          'فایل صوتی مرتبط با این پروژه در حافظه محلی یافت نشد.',
        );
      }

      const audioFile = new File([blobRec.blob], rawRecord.sourceFileName, {
        type: blobRec.mimeType || 'audio/wav',
        lastModified: rawRecord.createdAtMs,
      });

      // Update lastOpenedAtMs asynchronously without blocking open
      void this.touchLastOpened(rawRecord.id).catch(() => {});

      return { record: rawRecord, audioFile };
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  public async createProjectFromImportedAudio(params: {
    name: string;
    file: File;
    detectedContainer: string;
    durationSec: number;
    sampleRate: number;
    tracks: Track[];
    tokens: PersianWordToken[];
    recommendations: SmartRecommendation[];
    waveformPreviewPeaks: number[] | null;
  }): Promise<PersistedProjectRecord> {
    const nameCheck = validateProjectName(params.name);
    if (!nameCheck.valid) {
      throw new ProjectStoreError(
        'VALIDATION_ERROR',
        nameCheck.errorEn ?? 'Invalid project name',
        nameCheck.errorFa ?? 'نام پروژه نامعتبر است.',
      );
    }

    const nowMs = Date.now();
    const projectId = createProjectId();
    const sha256 = await computeBlobSha256Hex(params.file);
    const blobId = `blob_${sha256.slice(0, 24)}`;

    const db = await this.openDb();
    const storageState = db ? 'indexeddb-local' : 'memory-fallback';

    const record: PersistedProjectRecord = {
      id: projectId,
      schemaVersion: 1,
      name: nameCheck.trimmed,
      sourceFileName: params.file.name,
      sourceFileType: params.detectedContainer,
      sourceFileSizeBytes: params.file.size,
      audioBlobId: blobId,
      durationSec: Number.isFinite(params.durationSec) ? Math.max(0, params.durationSec) : 0,
      sampleRate: params.sampleRate,
      trackCount: params.tracks.length,
      wordCount: params.tokens.length,
      pendingSuggestionCount: params.recommendations.filter((r) => r.status === 'Pending').length,
      status: deriveProjectStatus({
        wordCount: params.tokens.length,
        recommendations: params.recommendations,
      }),
      storageState,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      lastOpenedAtMs: nowMs,
      waveformPreviewPeaks: params.waveformPreviewPeaks,
      tracks: structuredClone(params.tracks),
      tokens: structuredClone(params.tokens),
      recommendations: structuredClone(params.recommendations),
      projectPreferences: {
        zoomLevel: 1,
        selectedTrackId: params.tracks[0]?.id ?? null,
        markers: [],
      },
    };

    try {
      if (db) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_AUDIO_BLOBS, STORE_PROJECTS], 'readwrite');
          const blobStore = tx.objectStore(STORE_AUDIO_BLOBS);
          const projStore = tx.objectStore(STORE_PROJECTS);

          const getReq = blobStore.get(blobId);
          getReq.onsuccess = () => {
            const existing = getReq.result as PersistedAudioBlobRecord | undefined;
            if (existing) {
              blobStore.put({ ...existing, refCount: (existing.refCount || 0) + 1 });
            } else {
              const newBlob: PersistedAudioBlobRecord = {
                blobId,
                sha256,
                fileName: params.file.name,
                mimeType: params.file.type || 'audio/wav',
                sizeBytes: params.file.size,
                refCount: 1,
                createdAtMs: nowMs,
                blob: params.file,
              };
              blobStore.put(newBlob);
            }
            projStore.put(record);
          };
          getReq.onerror = () => reject(getReq.error);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
          tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
        });
      } else {
        const existing = this.memBlobs.get(blobId);
        if (existing) {
          this.memBlobs.set(blobId, { ...existing, refCount: existing.refCount + 1 });
        } else {
          this.memBlobs.set(blobId, {
            blobId,
            sha256,
            fileName: params.file.name,
            mimeType: params.file.type || 'audio/wav',
            sizeBytes: params.file.size,
            refCount: 1,
            createdAtMs: nowMs,
            blob: params.file,
          });
        }
        this.memProjects.set(projectId, record);
      }
      return record;
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  public async saveProjectEdits(
    projectId: string,
    patch: {
      name?: string;
      tracks: Track[];
      tokens: PersianWordToken[];
      recommendations: SmartRecommendation[];
      durationSec?: number;
      hasExported?: boolean;
      projectPreferences?: ProjectPreferencesRecord;
    },
  ): Promise<PersistedProjectRecord | null> {
    try {
      const db = await this.openDb();
      const nowMs = Date.now();

      if (db) {
        return await new Promise<PersistedProjectRecord | null>((resolve, reject) => {
          const tx = db.transaction(STORE_PROJECTS, 'readwrite');
          const store = tx.objectStore(STORE_PROJECTS);
          const getReq = store.get(projectId);
          let updated: PersistedProjectRecord | null = null;
          getReq.onsuccess = () => {
            const existing = getReq.result;
            if (!isPersistedProjectRecordValid(existing)) {
              resolve(null);
              return;
            }
            updated = {
              ...existing,
              name: patch.name ? patch.name.trim() : existing.name,
              tracks: structuredClone(patch.tracks),
              tokens: structuredClone(patch.tokens),
              recommendations: structuredClone(patch.recommendations),
              trackCount: patch.tracks.length,
              wordCount: patch.tokens.length,
              pendingSuggestionCount: patch.recommendations.filter((r) => r.status === 'Pending')
                .length,
              durationSec:
                patch.durationSec !== undefined && Number.isFinite(patch.durationSec)
                  ? patch.durationSec
                  : existing.durationSec,
              status: deriveProjectStatus({
                wordCount: patch.tokens.length,
                recommendations: patch.recommendations,
                hasExported: patch.hasExported || existing.status === 'completed',
              }),
              updatedAtMs: nowMs,
              projectPreferences: patch.projectPreferences
                ? structuredClone(patch.projectPreferences)
                : existing.projectPreferences,
            };
            store.put(updated);
          };
          getReq.onerror = () => reject(getReq.error);
          tx.oncomplete = () => resolve(updated);
          tx.onerror = () => reject(tx.error ?? new Error('Failed to save project edits'));
        });
      }

      const existing = this.memProjects.get(projectId);
      if (!existing) return null;
      const updated: PersistedProjectRecord = {
        ...existing,
        name: patch.name ? patch.name.trim() : existing.name,
        tracks: structuredClone(patch.tracks),
        tokens: structuredClone(patch.tokens),
        recommendations: structuredClone(patch.recommendations),
        trackCount: patch.tracks.length,
        wordCount: patch.tokens.length,
        pendingSuggestionCount: patch.recommendations.filter((r) => r.status === 'Pending').length,
        durationSec:
          patch.durationSec !== undefined && Number.isFinite(patch.durationSec)
            ? patch.durationSec
            : existing.durationSec,
        status: deriveProjectStatus({
          wordCount: patch.tokens.length,
          recommendations: patch.recommendations,
          hasExported: patch.hasExported || existing.status === 'completed',
        }),
        updatedAtMs: nowMs,
        projectPreferences: patch.projectPreferences
          ? structuredClone(patch.projectPreferences)
          : existing.projectPreferences,
      };
      this.memProjects.set(projectId, updated);
      return updated;
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  private async touchLastOpened(projectId: string): Promise<void> {
    const db = await this.openDb();
    const nowMs = Date.now();
    if (db) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_PROJECTS, 'readwrite');
        const store = tx.objectStore(STORE_PROJECTS);
        const getReq = store.get(projectId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (isPersistedProjectRecordValid(existing)) {
            store.put({ ...existing, lastOpenedAtMs: nowMs });
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      const existing = this.memProjects.get(projectId);
      if (existing) {
        this.memProjects.set(projectId, { ...existing, lastOpenedAtMs: nowMs });
      }
    }
  }

  public async renameProject(projectId: string, nextName: string): Promise<PersistedProjectSummary> {
    const check = validateProjectName(nextName);
    if (!check.valid) {
      throw new ProjectStoreError(
        'VALIDATION_ERROR',
        check.errorEn ?? 'Invalid name',
        check.errorFa ?? 'نام پروژه نامعتبر است.',
      );
    }
    try {
      const db = await this.openDb();
      const nowMs = Date.now();
      if (db) {
        return await new Promise<PersistedProjectSummary>((resolve, reject) => {
          const tx = db.transaction(STORE_PROJECTS, 'readwrite');
          const store = tx.objectStore(STORE_PROJECTS);
          const getReq = store.get(projectId);
          let updated: PersistedProjectRecord | null = null;
          getReq.onsuccess = () => {
            const existing = getReq.result;
            if (!isPersistedProjectRecordValid(existing)) {
              reject(
                new ProjectStoreError(
                  'PROJECT_NOT_FOUND',
                  'Project not found',
                  'پروژه پیدا نشد.',
                ),
              );
              return;
            }
            updated = { ...existing, name: check.trimmed, updatedAtMs: nowMs };
            store.put(updated);
          };
          tx.oncomplete = () => {
            if (updated) resolve(toSummary(updated));
          };
          tx.onerror = () => reject(tx.error);
        });
      }
      const existing = this.memProjects.get(projectId);
      if (!existing) {
        throw new ProjectStoreError('PROJECT_NOT_FOUND', 'Project not found', 'پروژه پیدا نشد.');
      }
      const updated = { ...existing, name: check.trimmed, updatedAtMs: nowMs };
      this.memProjects.set(projectId, updated);
      return toSummary(updated);
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  public async duplicateProject(
    projectId: string,
    locale: 'fa' | 'en' = 'fa',
  ): Promise<PersistedProjectSummary> {
    try {
      const db = await this.openDb();
      const newId = createProjectId();
      const nowMs = Date.now();

      if (db) {
        return await new Promise<PersistedProjectSummary>((resolve, reject) => {
          const tx = db.transaction([STORE_PROJECTS, STORE_AUDIO_BLOBS], 'readwrite');
          const projStore = tx.objectStore(STORE_PROJECTS);
          const blobStore = tx.objectStore(STORE_AUDIO_BLOBS);
          let duplicated: PersistedProjectRecord | null = null;

          const getReq = projStore.get(projectId);
          getReq.onsuccess = () => {
            const source = getReq.result;
            if (!isPersistedProjectRecordValid(source)) {
              reject(
                new ProjectStoreError(
                  'PROJECT_NOT_FOUND',
                  'Source project not found',
                  'پروژه مبدا برای کپی پیدا نشد.',
                ),
              );
              return;
            }
            duplicated = buildDuplicatedProjectRecord(source, newId, nowMs, locale);
            const blobReq = blobStore.get(source.audioBlobId);
            blobReq.onsuccess = () => {
              const blobRec = blobReq.result as PersistedAudioBlobRecord | undefined;
              if (blobRec) {
                blobStore.put({ ...blobRec, refCount: (blobRec.refCount || 1) + 1 });
              }
              projStore.put(duplicated);
            };
          };
          tx.oncomplete = () => {
            if (duplicated) resolve(toSummary(duplicated));
          };
          tx.onerror = () => reject(tx.error);
        });
      }

      const source = this.memProjects.get(projectId);
      if (!source) {
        throw new ProjectStoreError('PROJECT_NOT_FOUND', 'Project not found', 'پروژه پیدا نشد.');
      }
      const duplicated = buildDuplicatedProjectRecord(source, newId, nowMs, locale);
      const blobRec = this.memBlobs.get(source.audioBlobId);
      if (blobRec) {
        this.memBlobs.set(source.audioBlobId, { ...blobRec, refCount: blobRec.refCount + 1 });
      }
      this.memProjects.set(newId, duplicated);
      return toSummary(duplicated);
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  public async deleteProject(projectId: string): Promise<{ deletedBlob: boolean }> {
    try {
      const db = await this.openDb();
      if (db) {
        return await new Promise<{ deletedBlob: boolean }>((resolve, reject) => {
          const tx = db.transaction([STORE_PROJECTS, STORE_AUDIO_BLOBS], 'readwrite');
          const projStore = tx.objectStore(STORE_PROJECTS);
          const blobStore = tx.objectStore(STORE_AUDIO_BLOBS);
          let deletedBlob = false;

          const getReq = projStore.get(projectId);
          getReq.onsuccess = () => {
            const existing = getReq.result as Partial<PersistedProjectRecord> | undefined;
            projStore.delete(projectId);
            if (existing?.audioBlobId) {
              const bReq = blobStore.get(existing.audioBlobId);
              bReq.onsuccess = () => {
                const blobRec = bReq.result as PersistedAudioBlobRecord | undefined;
                if (!blobRec) return;
                const plan = planBlobRefCountOnDelete(blobRec.refCount);
                if (plan.shouldDeleteBlob) {
                  blobStore.delete(existing.audioBlobId!);
                  deletedBlob = true;
                } else {
                  blobStore.put({ ...blobRec, refCount: plan.nextRefCount });
                }
              };
            }
          };
          tx.oncomplete = () => resolve({ deletedBlob });
          tx.onerror = () => reject(tx.error);
        });
      }

      const existing = this.memProjects.get(projectId);
      this.memProjects.delete(projectId);
      let deletedBlob = false;
      if (existing?.audioBlobId) {
        const blobRec = this.memBlobs.get(existing.audioBlobId);
        if (blobRec) {
          const plan = planBlobRefCountOnDelete(blobRec.refCount);
          if (plan.shouldDeleteBlob) {
            this.memBlobs.delete(existing.audioBlobId);
            deletedBlob = true;
          } else {
            this.memBlobs.set(existing.audioBlobId, { ...blobRec, refCount: plan.nextRefCount });
          }
        }
      }
      return { deletedBlob };
    } catch (err) {
      throw classifyStorageError(err);
    }
  }

  public async getBlobRefCount(audioBlobId: string): Promise<number> {
    try {
      const db = await this.openDb();
      if (db) {
        const tx = db.transaction(STORE_AUDIO_BLOBS, 'readonly');
        const rec = (await this.idbReq(tx.objectStore(STORE_AUDIO_BLOBS).get(audioBlobId))) as
          | PersistedAudioBlobRecord
          | undefined;
        return rec?.refCount ?? 1;
      }
      return this.memBlobs.get(audioBlobId)?.refCount ?? 1;
    } catch {
      return 1;
    }
  }

  public async getStorageEstimate(): Promise<StorageUsageEstimate> {
    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    let supported = false;

    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        supported = true;
        usageBytes = typeof est.usage === 'number' ? est.usage : null;
        quotaBytes = typeof est.quota === 'number' ? est.quota : null;
      }
    } catch {
      // StorageManager estimate unavailable
    }

    let projectCount = 0;
    let audioBlobCount = 0;
    let totalAudioBytes = 0;

    try {
      const db = await this.openDb();
      if (db) {
        const tx = db.transaction([STORE_PROJECTS, STORE_AUDIO_BLOBS], 'readonly');
        const projs = await this.idbReq(tx.objectStore(STORE_PROJECTS).getAll());
        const blobs = (await this.idbReq(
          tx.objectStore(STORE_AUDIO_BLOBS).getAll(),
        )) as PersistedAudioBlobRecord[];
        projectCount = projs.length;
        audioBlobCount = blobs.length;
        totalAudioBytes = blobs.reduce((acc, b) => acc + (b.sizeBytes || 0), 0);
      } else {
        projectCount = this.memProjects.size;
        audioBlobCount = this.memBlobs.size;
        totalAudioBytes = Array.from(this.memBlobs.values()).reduce(
          (acc, b) => acc + b.sizeBytes,
          0,
        );
      }
    } catch {
      // ignore
    }

    return {
      supported,
      usageBytes,
      quotaBytes,
      projectCount,
      audioBlobCount,
      totalAudioBytes,
    };
  }
}

export const projectLibraryStore = new ProjectLibraryRepository();
