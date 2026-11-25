/**
 * SHAHAB — Tenant-Isolated, Serialized Context Memory Store
 *
 * Fixes SHB-F06 & SHB-F07:
 * 1. Moves operational user vocabulary OUT of repository documentation (`docs/shahab/`).
 * 2. Enforces strict `ownerId` + optional `projectId` partitioning so hosted/multi-project
 *    users can never read or delete each other's Persian domain terms (blocks IDOR).
 * 3. Serializes read-modify-write mutations with atomic rename to prevent concurrent lost updates.
 * 4. Exposes `getVerifiedTermsForBiasing()` so live `/api/shahab/transcribe` actually feeds
 *    the authenticated owner's verified terms into the SHAHAB decoder.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ShahabMemoryScope = 'SESSION' | 'PROJECT' | 'WORKSPACE' | 'USER';
export type ShahabMemoryCategory =
  | 'PROPER_NOUN'
  | 'TECHNICAL_TERM'
  | 'DOMAIN_TERM'
  | 'BRAND_OR_ACRONYM'
  | 'COLLOQUIAL_FORM';
export type ShahabMemoryVerificationStatus =
  | 'USER_VERIFIED'
  | 'UNVERIFIED_CANDIDATE'
  | 'ADMIN_APPROVED';

export interface ShahabContextMemoryRecord {
  readonly entryId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly term: string;
  readonly canonicalSurface: string;
  readonly scope: ShahabMemoryScope;
  readonly category: ShahabMemoryCategory;
  readonly verificationStatus: ShahabMemoryVerificationStatus;
  readonly boostWeight: number;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
  readonly source: string;
}

interface StoredOwnerBucket {
  readonly schemaVersion: '1.0.0';
  readonly ownerId: string;
  readonly updatedAtUtc: string;
  readonly entries: readonly ShahabContextMemoryRecord[];
}

const ALLOWED_SCOPES = new Set<ShahabMemoryScope>(['SESSION', 'PROJECT', 'WORKSPACE', 'USER']);
const ALLOWED_CATEGORIES = new Set<ShahabMemoryCategory>([
  'PROPER_NOUN',
  'TECHNICAL_TERM',
  'DOMAIN_TERM',
  'BRAND_OR_ACRONYM',
  'COLLOQUIAL_FORM',
]);
const ALLOWED_STATUSES = new Set<ShahabMemoryVerificationStatus>([
  'USER_VERIFIED',
  'UNVERIFIED_CANDIDATE',
  'ADMIN_APPROVED',
]);

export function resolveDefaultShahabDataDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.AVAPARDAZ_SHAHAB_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.resolve(localAppData, 'Avapardaz', 'shahab-state');
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.resolve(xdgDataHome, 'avapardaz', 'shahab-state');
}

export class ShahabContextMemoryStore {
  private readonly rootDir: string;
  private readonly maxEntriesPerOwner: number;
  private readonly ownerLocks = new Map<string, Promise<void>>();

  constructor(options?: {
    readonly rootDir?: string;
    readonly maxEntriesPerOwner?: number;
  }) {
    this.rootDir = path.resolve(options?.rootDir ?? resolveDefaultShahabDataDir());
    this.maxEntriesPerOwner = Math.max(10, Math.min(2000, options?.maxEntriesPerOwner ?? 500));
  }

  public getRootDir(): string {
    return this.rootDir;
  }

  private getOwnerBucketPath(ownerId: string): string {
    const hash = crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
    const resolved = path.resolve(this.rootDir, `memory_${hash}.json`);
    if (!resolved.startsWith(this.rootDir + path.sep)) {
      throw new Error('PATH_TRAVERSAL_REJECTED');
    }
    return resolved;
  }

  private enqueueOwnerMutation<T>(ownerId: string, fn: () => T): Promise<T> {
    const prev = this.ownerLocks.get(ownerId) ?? Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.ownerLocks.set(ownerId, tail);
    return run;
  }

  private readOwnerEntriesSync(ownerId: string): ShahabContextMemoryRecord[] {
    const filePath = this.getOwnerBucketPath(ownerId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoredOwnerBucket>;
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(
        (e): e is ShahabContextMemoryRecord =>
          typeof e === 'object' && e !== null && e.ownerId === ownerId && typeof e.entryId === 'string',
      );
    } catch {
      return [];
    }
  }

  private writeOwnerEntriesAtomicSync(ownerId: string, entries: readonly ShahabContextMemoryRecord[]): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const filePath = this.getOwnerBucketPath(ownerId);
    const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const payload: StoredOwnerBucket = {
      schemaVersion: '1.0.0',
      ownerId,
      updatedAtUtc: new Date().toISOString(),
      entries,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  public listEntries(params: {
    readonly ownerId: string;
    readonly projectId?: string;
  }): readonly ShahabContextMemoryRecord[] {
    const all = this.readOwnerEntriesSync(params.ownerId);
    if (!params.projectId) return all;
    return all.filter(
      (e) => e.scope === 'USER' || e.scope === 'WORKSPACE' || e.projectId === params.projectId,
    );
  }

  public getVerifiedTermsForBiasing(params: {
    readonly ownerId: string;
    readonly projectId?: string;
    readonly maxTerms?: number;
  }): readonly { readonly term: string; readonly boostWeight: number }[] {
    const entries = this.listEntries({ ownerId: params.ownerId, projectId: params.projectId });
    const maxTerms = Math.max(1, Math.min(200, params.maxTerms ?? 64));
    const verified: { term: string; boostWeight: number }[] = [];
    for (const e of entries) {
      if (e.verificationStatus !== 'USER_VERIFIED' && e.verificationStatus !== 'ADMIN_APPROVED') {
        continue;
      }
      verified.push({ term: e.canonicalSurface || e.term, boostWeight: e.boostWeight });
      if (verified.length >= maxTerms) break;
    }
    return verified;
  }

  public async addEntry(params: {
    readonly ownerId: string;
    readonly projectId?: string;
    readonly term: string;
    readonly scope?: string;
    readonly category?: string;
    readonly verificationStatus?: string;
    readonly boostWeight?: number;
    readonly source?: string;
  }): Promise<{ readonly entry: ShahabContextMemoryRecord; readonly totalEntries: number }> {
    const rawTerm = typeof params.term === 'string' ? params.term.trim() : '';
    const scope = (params.scope ?? 'PROJECT') as ShahabMemoryScope;
    const category = (params.category ?? 'DOMAIN_TERM') as ShahabMemoryCategory;
    const verificationStatus = (params.verificationStatus ?? 'USER_VERIFIED') as ShahabMemoryVerificationStatus;

    if (!rawTerm || rawTerm.length > 120) {
      throw new Error('INVALID_TERM');
    }
    if (
      !ALLOWED_SCOPES.has(scope) ||
      !ALLOWED_CATEGORIES.has(category) ||
      !ALLOWED_STATUSES.has(verificationStatus)
    ) {
      throw new Error('INVALID_MEMORY_METADATA');
    }

    const projectId = (params.projectId ?? 'default').trim() || 'default';
    return this.enqueueOwnerMutation(params.ownerId, () => {
      const existing = this.readOwnerEntriesSync(params.ownerId);
      const nowUtc = new Date().toISOString();
      const entry: ShahabContextMemoryRecord = {
        entryId: `mem_${crypto.randomBytes(6).toString('hex')}`,
        ownerId: params.ownerId,
        projectId,
        term: rawTerm,
        canonicalSurface: rawTerm.replace(/\u064A/g, '\u06CC').replace(/\u0643/g, '\u06A9'),
        scope,
        category,
        verificationStatus,
        boostWeight:
          typeof params.boostWeight === 'number' && Number.isFinite(params.boostWeight)
            ? Math.max(0.1, Math.min(2.0, params.boostWeight))
            : 1.0,
        createdAtUtc: nowUtc,
        updatedAtUtc: nowUtc,
        source: params.source ?? 'SHAHAB_API',
      };

      const nextEntries = [entry, ...existing].slice(0, this.maxEntriesPerOwner);
      this.writeOwnerEntriesAtomicSync(params.ownerId, nextEntries);
      return { entry, totalEntries: nextEntries.length };
    });
  }

  public async deleteEntry(params: {
    readonly ownerId: string;
    readonly entryId: string;
  }): Promise<{ readonly deleted: boolean; readonly remainingCount: number }> {
    const entryId = params.entryId.trim();
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(entryId)) {
      throw new Error('INVALID_ENTRY_ID');
    }
    return this.enqueueOwnerMutation(params.ownerId, () => {
      const existing = this.readOwnerEntriesSync(params.ownerId);
      const filtered = existing.filter((item) => item.entryId !== entryId);
      const deleted = filtered.length !== existing.length;
      if (deleted) {
        this.writeOwnerEntriesAtomicSync(params.ownerId, filtered);
      }
      return { deleted, remainingCount: filtered.length };
    });
  }
}
