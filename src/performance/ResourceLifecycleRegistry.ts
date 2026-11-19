/**
 * Deterministic Project-Scoped Resource Ownership & Leak Prevention Registry (AVP-P11-001 Section 10)
 * Tracks temporary resources (object URLs, timers, listeners, abort controllers, caches, workers)
 * per project/scope and guarantees clean deterministic disposal without ever deleting user-owned files or checkpoints.
 */

export type OwnedResourceKind =
  | 'OBJECT_URL'
  | 'TIMER'
  | 'EVENT_LISTENER'
  | 'ABORT_CONTROLLER'
  | 'CACHE'
  | 'WORKER'
  | 'AUDIO_BUFFER'
  | 'OTHER';

interface RegisteredResourceEntry {
  readonly id: string;
  readonly scopeId: string;
  readonly kind: OwnedResourceKind;
  readonly release: () => void;
  released: boolean;
}

export class ResourceLifecycleRegistry {
  private readonly entries = new Map<string, RegisteredResourceEntry>();
  private seq = 0;

  public register(
    scopeId: string,
    kind: OwnedResourceKind,
    release: () => void,
  ): string {
    const id = `res_${++this.seq}`;
    this.entries.set(id, {
      id,
      scopeId,
      kind,
      release,
      released: false,
    });
    return id;
  }

  public releaseOne(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.released) return false;
    entry.released = true;
    this.entries.delete(id);
    try {
      entry.release();
    } catch {
      // Deterministic cleanup must never throw
    }
    return true;
  }

  public releaseScope(scopeId: string): number {
    let releasedCount = 0;
    for (const [id, entry] of Array.from(this.entries.entries())) {
      if (entry.scopeId === scopeId) {
        if (this.releaseOne(id)) releasedCount += 1;
      }
    }
    return releasedCount;
  }

  public releaseAll(): number {
    let releasedCount = 0;
    for (const id of Array.from(this.entries.keys())) {
      if (this.releaseOne(id)) releasedCount += 1;
    }
    return releasedCount;
  }

  public getActiveCount(scopeId?: string): number {
    if (!scopeId) return this.entries.size;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.scopeId === scopeId) count += 1;
    }
    return count;
  }

  public getCountsByKind(): Readonly<Record<OwnedResourceKind, number>> {
    const counts: Record<OwnedResourceKind, number> = {
      OBJECT_URL: 0,
      TIMER: 0,
      EVENT_LISTENER: 0,
      ABORT_CONTROLLER: 0,
      CACHE: 0,
      WORKER: 0,
      AUDIO_BUFFER: 0,
      OTHER: 0,
    };
    for (const entry of this.entries.values()) {
      counts[entry.kind] += 1;
    }
    return counts;
  }
}
