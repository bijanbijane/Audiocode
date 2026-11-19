import type { ExecutionMode } from './UnifiedProcessingContract';

const DEFAULT_STORAGE_KEY = 'avapardaz.execution_mode.v1';

export interface ExecutionModeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ExecutionModePreferenceSnapshot {
  readonly preferredMode: ExecutionMode;
  readonly persisted: boolean;
  readonly updatedAtIso: string;
  readonly explicitCloudOptInConfirmed: boolean;
}

/**
 * Single Execution-Mode Selection Store.
 *
 * - LOCAL is ALWAYS the initial default.
 * - CLOUD requires explicit user/configuration selection (`explicitCloudOptIn: true`).
 * - Changing preference affects NEW jobs only; active jobs keep their snapshotted mode.
 * - Uses browser localStorage when available, without adding any new persistence dependency.
 */
export class ExecutionModePreferenceStore {
  private preferredMode: ExecutionMode = 'LOCAL';
  private explicitCloudOptInConfirmed = false;
  private updatedAtIso: string = new Date().toISOString();
  private persisted = false;
  private readonly storage: ExecutionModeStorageLike | null;
  private readonly storageKey: string;
  private readonly listeners = new Set<(snap: ExecutionModePreferenceSnapshot) => void>();

  constructor(options?: {
    readonly storage?: ExecutionModeStorageLike | null;
    readonly storageKey?: string;
  }) {
    this.storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY;
    this.storage =
      options?.storage !== undefined
        ? options.storage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;

    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        preferredMode?: unknown;
        explicitCloudOptInConfirmed?: unknown;
        updatedAtIso?: unknown;
      };
      if (parsed.preferredMode === 'CLOUD' && parsed.explicitCloudOptInConfirmed === true) {
        this.preferredMode = 'CLOUD';
        this.explicitCloudOptInConfirmed = true;
      } else {
        this.preferredMode = 'LOCAL';
        this.explicitCloudOptInConfirmed = false;
      }
      if (typeof parsed.updatedAtIso === 'string') {
        this.updatedAtIso = parsed.updatedAtIso;
      }
      this.persisted = true;
    } catch {
      this.preferredMode = 'LOCAL';
      this.explicitCloudOptInConfirmed = false;
    }
  }

  public getSnapshot(): ExecutionModePreferenceSnapshot {
    return Object.freeze({
      preferredMode: this.preferredMode,
      persisted: this.persisted,
      updatedAtIso: this.updatedAtIso,
      explicitCloudOptInConfirmed: this.explicitCloudOptInConfirmed,
    });
  }

  public getPreferredMode(): ExecutionMode {
    return this.preferredMode;
  }

  public setPreferredMode(
    mode: ExecutionMode,
    options?: { readonly explicitCloudOptIn?: boolean },
  ): ExecutionModePreferenceSnapshot {
    if (mode === 'CLOUD' && !options?.explicitCloudOptIn) {
      throw new Error(
        'CLOUD execution requires explicit user or application opt-in (explicitCloudOptIn: true).',
      );
    }

    this.preferredMode = mode;
    this.explicitCloudOptInConfirmed = mode === 'CLOUD';
    this.updatedAtIso = new Date().toISOString();

    if (this.storage) {
      try {
        this.storage.setItem(
          this.storageKey,
          JSON.stringify({
            preferredMode: this.preferredMode,
            explicitCloudOptInConfirmed: this.explicitCloudOptInConfirmed,
            updatedAtIso: this.updatedAtIso,
          }),
        );
        this.persisted = true;
      } catch {
        this.persisted = false;
      }
    }

    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
    return snap;
  }

  public subscribe(listener: (snap: ExecutionModePreferenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
