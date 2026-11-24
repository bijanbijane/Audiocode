/**
 * AVAPARDAZ — Project Hub Pure Domain Logic (Phase 02)
 *
 * Covers:
 * - Persian/Arabic/ZWNJ-normalized search across project name, source file name, and ID
 * - Real status derivation (never fabricated)
 * - Deterministic sorting with stable tie-breakers
 * - Rename validation
 * - Ref-counted audio blob safety planning for Duplicate / Delete
 * - Corrupt persisted record rejection
 */

import type {
  PersianWordToken,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';

export type ProjectLifecycleStatus = 'editing' | 'review' | 'completed';
export type ProjectFilterTab = 'all' | 'recent' | 'editing' | 'completed';
export type ProjectSortField = 'updatedAt' | 'lastOpenedAt' | 'name';

export interface ProjectMarkerRecord {
  id: string;
  label: string;
  timeSec: number;
  kind: 'general' | 'edit' | 'start' | 'end' | 'review';
  createdAtMs: number;
}

export interface ProjectPreferencesRecord {
  zoomLevel?: number;
  selectedTrackId?: string | null;
  markers?: ProjectMarkerRecord[];
}

export interface PersistedProjectSummary {
  readonly id: string;
  readonly schemaVersion: number;
  readonly name: string;
  readonly sourceFileName: string;
  readonly sourceFileType: string;
  readonly sourceFileSizeBytes: number;
  readonly audioBlobId: string;
  readonly durationSec: number;
  readonly sampleRate: number;
  readonly trackCount: number;
  readonly wordCount: number;
  readonly pendingSuggestionCount: number;
  readonly status: ProjectLifecycleStatus;
  readonly storageState: 'indexeddb-local' | 'memory-fallback';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastOpenedAtMs: number;
  /** Downsampled real peaks (32–64 buckets) from actual PCM, or null if unavailable */
  readonly waveformPreviewPeaks: readonly number[] | null;
}

export interface PersistedProjectRecord extends PersistedProjectSummary {
  readonly tracks: Track[];
  readonly tokens: PersianWordToken[];
  readonly recommendations: SmartRecommendation[];
  readonly projectPreferences?: ProjectPreferencesRecord;
}

export interface PersistedAudioBlobMeta {
  readonly blobId: string;
  readonly sha256: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly refCount: number;
  readonly createdAtMs: number;
}

const ARABIC_TO_PERSIAN_RE_Y = /[يئى]/g;
const ARABIC_TO_PERSIAN_RE_K = /ك/g;
const DIACRITICS_RE = /[\u064B-\u065F\u0670\u0640]/g;
const ZWNJ_AND_SPACES_RE = /[\u200C\u200D\s]+/g;

/**
 * Normalizes Persian/Arabic characters, diacritics, and ZWNJ strictly for search comparison.
 * Never mutates stored display text or raw text.
 */
export function normalizePersianSearchQuery(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(ARABIC_TO_PERSIAN_RE_Y, 'ی')
    .replace(ARABIC_TO_PERSIAN_RE_K, 'ک')
    .replace(DIACRITICS_RE, '')
    .replace(/آ/g, 'ا')
    .replace(/[أإ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(ZWNJ_AND_SPACES_RE, ' ');
}

export function deriveProjectStatus(params: {
  wordCount: number;
  recommendations: readonly SmartRecommendation[];
  hasExported?: boolean;
}): ProjectLifecycleStatus {
  if (params.hasExported) return 'completed';
  const pendingCount = params.recommendations.filter((r) => r.status === 'Pending').length;
  if (params.recommendations.length > 0 && pendingCount === 0 && params.wordCount > 0) {
    return 'completed';
  }
  if (pendingCount > 0) return 'review';
  return 'editing';
}

export function validateProjectName(rawName: string): {
  valid: boolean;
  trimmed: string;
  errorFa?: string;
  errorEn?: string;
} {
  const trimmed = rawName.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      trimmed,
      errorFa: 'نام پروژه نمی‌تواند خالی باشد.',
      errorEn: 'Project name cannot be empty.',
    };
  }
  if (trimmed.length > 100) {
    return {
      valid: false,
      trimmed,
      errorFa: 'نام پروژه نباید بیش از ۱۰۰ کاراکتر باشد.',
      errorEn: 'Project name must be 100 characters or fewer.',
    };
  }
  return { valid: true, trimmed };
}

export function filterAndSortProjects(
  projects: readonly PersistedProjectSummary[],
  options: {
    query: string;
    filter: ProjectFilterTab;
    sortBy: ProjectSortField;
    recentWindowMs?: number;
    nowMs?: number;
  },
): PersistedProjectSummary[] {
  const normalizedQuery = normalizePersianSearchQuery(options.query);
  const nowMs = options.nowMs ?? Date.now();
  const recentWindowMs = options.recentWindowMs ?? 7 * 24 * 60 * 60 * 1000;

  const filtered = projects.filter((project) => {
    if (options.filter === 'recent') {
      if (nowMs - project.lastOpenedAtMs > recentWindowMs) return false;
    } else if (options.filter === 'editing') {
      if (project.status !== 'editing' && project.status !== 'review') return false;
    } else if (options.filter === 'completed') {
      if (project.status !== 'completed') return false;
    }

    if (!normalizedQuery) return true;
    const haystack = normalizePersianSearchQuery(
      `${project.name} ${project.sourceFileName} ${project.id}`,
    );
    return haystack.includes(normalizedQuery);
  });

  return [...filtered].sort((a, b) => {
    if (options.sortBy === 'updatedAt') {
      if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    } else if (options.sortBy === 'lastOpenedAt') {
      if (b.lastOpenedAtMs !== a.lastOpenedAtMs) return b.lastOpenedAtMs - a.lastOpenedAtMs;
    } else if (options.sortBy === 'name') {
      const cmp = a.name.localeCompare(b.name, 'fa');
      if (cmp !== 0) return cmp;
    }
    // Deterministic stable tie-breaker
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id.localeCompare(b.id);
  });
}

export function computeProjectHubCounts(
  projects: readonly PersistedProjectSummary[],
  nowMs = Date.now(),
  recentWindowMs = 7 * 24 * 60 * 60 * 1000,
): Record<ProjectFilterTab, number> {
  let recent = 0;
  let editing = 0;
  let completed = 0;
  for (const p of projects) {
    if (nowMs - p.lastOpenedAtMs <= recentWindowMs) recent++;
    if (p.status === 'editing' || p.status === 'review') editing++;
    if (p.status === 'completed') completed++;
  }
  return {
    all: projects.length,
    recent,
    editing,
    completed,
  };
}

/**
 * Pure ref-count planner for safe project deletion.
 * Guarantees an audio blob shared by a duplicated project is NEVER deleted while refCount > 1.
 */
export function planBlobRefCountOnDelete(
  currentRefCount: number,
): { nextRefCount: number; shouldDeleteBlob: boolean } {
  const safeCurrent = Number.isFinite(currentRefCount) ? Math.max(0, Math.trunc(currentRefCount)) : 0;
  const nextRefCount = Math.max(0, safeCurrent - 1);
  return {
    nextRefCount,
    shouldDeleteBlob: nextRefCount === 0,
  };
}

/**
 * Builds an independent duplicate record with fresh IDs and timestamps, sharing the immutable audio blob.
 */
export function buildDuplicatedProjectRecord(
  source: PersistedProjectRecord,
  newId: string,
  nowMs: number,
  locale: 'fa' | 'en' = 'fa',
): PersistedProjectRecord {
  const suffix = locale === 'fa' ? ' (کپی)' : ' (Copy)';
  const nextName = `${source.name}${suffix}`.slice(0, 100);
  return {
    ...source,
    id: newId,
    name: nextName,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lastOpenedAtMs: nowMs,
    tracks: structuredClone(source.tracks),
    tokens: structuredClone(source.tokens),
    recommendations: structuredClone(source.recommendations),
    projectPreferences: source.projectPreferences
      ? structuredClone(source.projectPreferences)
      : undefined,
    waveformPreviewPeaks: source.waveformPreviewPeaks ? [...source.waveformPreviewPeaks] : null,
  };
}

/**
 * Validates that a record loaded from IndexedDB is structurally intact and safe to open.
 */
export function isPersistedProjectRecordValid(raw: unknown): raw is PersistedProjectRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<PersistedProjectRecord>;
  return (
    typeof r.id === 'string' &&
    r.id.trim().length > 0 &&
    typeof r.name === 'string' &&
    typeof r.sourceFileName === 'string' &&
    typeof r.audioBlobId === 'string' &&
    r.audioBlobId.trim().length > 0 &&
    typeof r.sampleRate === 'number' &&
    Number.isFinite(r.sampleRate) &&
    r.sampleRate > 0 &&
    typeof r.durationSec === 'number' &&
    Number.isFinite(r.durationSec) &&
    r.durationSec >= 0 &&
    Array.isArray(r.tracks) &&
    Array.isArray(r.tokens) &&
    Array.isArray(r.recommendations)
  );
}

/**
 * Extracts real downsampled amplitude peaks (0..1) from decoded PCM for card preview.
 * Returns null if PCM is missing or empty — never fabricates synthetic peaks.
 */
export function extractRealWaveformPreviewPeaks(
  pcm: Float32Array | null | undefined,
  buckets = 48,
): number[] | null {
  if (!pcm || pcm.length === 0 || buckets <= 0) return null;
  const count = Math.min(buckets, pcm.length);
  const step = pcm.length / count;
  const peaks: number[] = [];
  let globalMax = 0;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(pcm.length, Math.max(start + 1, Math.floor((i + 1) * step)));
    let maxVal = 0;
    for (let s = start; s < end; s++) {
      const a = Math.abs(pcm[s]);
      if (Number.isFinite(a) && a > maxVal) maxVal = a;
    }
    peaks.push(maxVal);
    if (maxVal > globalMax) globalMax = maxVal;
  }
  if (globalMax <= 1e-6) {
    // True silent audio stays flat (0), never fabricated
    return peaks.map(() => 0);
  }
  return peaks.map((v) => Number((v / globalMax).toFixed(3)));
}

export const extractDownsampledWaveformPeaks = extractRealWaveformPreviewPeaks;

