import type { ExecutionMode } from './UnifiedProcessingContract';

const DEFAULT_STORAGE_KEY = 'avapardaz.execution_mode.v1';

export interface ExecutionModeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ExecutionModePreferenceSnapshot {
  readonly preferredMode: ExecutionMode;
  /** Pure UI execution-mode preference; NEVER constitutes a cloud data-sharing consent grant. */
  readonly preferredModeSelected: ExecutionMode;
  readonly persisted: boolean;
  readonly updatedAtIso: string;
  /**
   * @deprecated Pure UI mode preference flag retained for backward compatibility.
   * NEVER represents a data-sharing consent grant; cloud dispatch always requires a fresh
   * one-time consent grant bound to exact audio bytes and range.
   */
  readonly explicitCloudOptInConfirmed: boolean;
  readonly isDataSharingConsentGrant: false;
}

/**
 * Single Execution-Mode Selection Store.
 *
 * - LOCAL is ALWAYS the initial default.
 * - CLOUD requires explicit user/configuration selection (`explicitCloudOptIn: true`).
 * - Stores ONLY UI execution-mode preference; NEVER persists or restores cloud data-sharing
 *   consent grants, receipt IDs, or audio transfer permissions across sessions.
 * - Changing preference affects NEW jobs only; active jobs keep their snapshotted mode.
 */
export class ExecutionModePreferenceStore {
  private preferredMode: ExecutionMode = 'LOCAL';
  private preferredModeSelected: ExecutionMode = 'LOCAL';
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
        preferredModeSelected?: unknown;
        explicitCloudOptInConfirmed?: unknown;
        updatedAtIso?: unknown;
      };
      const persistedCloudPref =
        parsed.preferredMode === 'CLOUD' &&
        (parsed.preferredModeSelected === 'CLOUD' || parsed.explicitCloudOptInConfirmed === true);
      if (persistedCloudPref) {
        this.preferredMode = 'CLOUD';
        this.preferredModeSelected = 'CLOUD';
      } else {
        this.preferredMode = 'LOCAL';
        this.preferredModeSelected = 'LOCAL';
      }
      if (typeof parsed.updatedAtIso === 'string') {
        this.updatedAtIso = parsed.updatedAtIso;
      }
      this.persisted = true;
    } catch {
      this.preferredMode = 'LOCAL';
      this.preferredModeSelected = 'LOCAL';
    }
  }

  public getSnapshot(): ExecutionModePreferenceSnapshot {
    return Object.freeze({
      preferredMode: this.preferredMode,
      preferredModeSelected: this.preferredModeSelected,
      persisted: this.persisted,
      updatedAtIso: this.updatedAtIso,
      explicitCloudOptInConfirmed: this.preferredModeSelected === 'CLOUD',
      isDataSharingConsentGrant: false as const,
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
    this.preferredModeSelected = mode;
    this.updatedAtIso = new Date().toISOString();

    if (this.storage) {
      try {
        // Persist UI mode preference ONLY — never consent grants, receipts, or sharing permissions.
        this.storage.setItem(
          this.storageKey,
          JSON.stringify({
            preferredMode: this.preferredMode,
            preferredModeSelected: this.preferredModeSelected,
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
