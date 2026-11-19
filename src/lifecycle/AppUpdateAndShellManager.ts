import { AVAPARDAZ_VERSION_CONTRACT } from './VersionCompatibilityContract';

export type AppUpdateLifecycleState =
  | 'IDLE'
  | 'UPDATE_AVAILABLE'
  | 'UPDATE_DOWNLOADING'
  | 'UPDATE_READY'
  | 'UPDATE_BLOCKED_ACTIVE_OP'
  | 'UPDATE_INSTALLING'
  | 'UPDATE_COMPLETED'
  | 'UPDATE_FAILED';

export interface ActiveOperationFlags {
  readonly asrInferenceRunning: boolean;
  readonly audioRenderingActive: boolean;
  readonly exportFinalizing: boolean;
  readonly modelInstalling: boolean;
  readonly projectPersisting: boolean;
}

export interface ShellOfflineVerificationReport {
  readonly checkedAtMs: number;
  readonly serviceWorkerRegistered: boolean;
  readonly criticalAssetsChecked: readonly string[];
  readonly missingCriticalAssets: readonly string[];
  readonly wasmAssetsCached: boolean;
  readonly localModelInstalled: boolean;
  readonly offlineStartupReady: boolean;
  readonly offlineFullAsrReady: boolean;
  readonly note: string;
}

export interface AppUpdateStateSnapshot {
  readonly state: AppUpdateLifecycleState;
  readonly currentVersion: string;
  readonly pendingVersion: string | null;
  readonly blockedByOperations: readonly string[];
  readonly checkpointsPreserved: boolean;
  readonly lastError: string | null;
}

/**
 * Controlled Application Update & Shell Offline Readiness Manager (AVP-P09-001 Sections 4, 5, 8)
 *
 * Never activates an update mid-ASR, mid-render, mid-export, mid-model-install, or mid-save.
 * Verifies actual cached shell assets rather than assuming registration implies offline readiness.
 */
export class AppUpdateAndShellManager {
  private state: AppUpdateLifecycleState = 'IDLE';
  private pendingVersion: string | null = null;
  private blockedByOperations: string[] = [];
  private lastError: string | null = null;

  public getSnapshot(): AppUpdateStateSnapshot {
    return Object.freeze({
      state: this.state,
      currentVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
      pendingVersion: this.pendingVersion,
      blockedByOperations: [...this.blockedByOperations],
      checkpointsPreserved: true,
      lastError: this.lastError,
    });
  }

  public notifyUpdateAvailable(nextVersion: string): AppUpdateStateSnapshot {
    this.pendingVersion = nextVersion;
    this.state = 'UPDATE_AVAILABLE';
    this.lastError = null;
    return this.getSnapshot();
  }

  public markUpdateReady(nextVersion: string): AppUpdateStateSnapshot {
    this.pendingVersion = nextVersion;
    this.state = 'UPDATE_READY';
    this.lastError = null;
    return this.getSnapshot();
  }

  public evaluateActiveBlockers(flags: ActiveOperationFlags): string[] {
    const blockers: string[] = [];
    if (flags.asrInferenceRunning) blockers.push('ASR_INFERENCE');
    if (flags.audioRenderingActive) blockers.push('AUDIO_RENDERING');
    if (flags.exportFinalizing) blockers.push('EXPORT_FINALIZATION');
    if (flags.modelInstalling) blockers.push('MODEL_INSTALLATION');
    if (flags.projectPersisting) blockers.push('PROJECT_PERSISTENCE');
    return blockers;
  }

  /**
   * Attempts to activate a waiting application update strictly when no critical local
   * operation is running. Preserves active checkpoints and project state before activation.
   */
  public async tryActivateUpdateSafely(params: {
    readonly activeOps: ActiveOperationFlags;
    readonly flushCheckpointsAndState: () => Promise<boolean> | boolean;
    readonly activateWorkerFn: () => Promise<void> | void;
  }): Promise<{ readonly activated: boolean; readonly snapshot: AppUpdateStateSnapshot }> {
    const blockers = this.evaluateActiveBlockers(params.activeOps);
    this.blockedByOperations = blockers;

    if (blockers.length > 0) {
      this.state = 'UPDATE_BLOCKED_ACTIVE_OP';
      this.lastError = `Update deferred to protect active operations: ${blockers.join(', ')}.`;
      return { activated: false, snapshot: this.getSnapshot() };
    }

    try {
      this.state = 'UPDATE_INSTALLING';
      const preserved = await params.flushCheckpointsAndState();
      if (!preserved) {
        this.state = 'UPDATE_FAILED';
        this.lastError = 'Failed to preserve checkpoints/project state; update aborted safely.';
        return { activated: false, snapshot: this.getSnapshot() };
      }
      await params.activateWorkerFn();
      this.state = 'UPDATE_COMPLETED';
      this.lastError = null;
      return { activated: true, snapshot: this.getSnapshot() };
    } catch (err) {
      this.state = 'UPDATE_FAILED';
      this.lastError = err instanceof Error ? err.message : String(err);
      return { activated: false, snapshot: this.getSnapshot() };
    }
  }

  /**
   * Verifies real offline startup readiness by inspecting cached critical shell assets
   * rather than blindly trusting service-worker registration or navigator.onLine.
   */
  public static async verifyActualOfflineReadiness(params: {
    readonly serviceWorkerRegistered: boolean;
    readonly criticalAssets: readonly string[];
    readonly hasCachedAsset: (assetPath: string) => Promise<boolean> | boolean;
    readonly wasmAssetsCached: boolean;
    readonly localModelInstalled: boolean;
    readonly nowMs?: number;
  }): Promise<ShellOfflineVerificationReport> {
    const missing: string[] = [];
    for (const asset of params.criticalAssets) {
      const ok = await params.hasCachedAsset(asset);
      if (!ok) missing.push(asset);
    }

    const offlineStartupReady = params.serviceWorkerRegistered && missing.length === 0;
    const offlineFullAsrReady =
      offlineStartupReady && params.wasmAssetsCached && params.localModelInstalled;

    let note = 'Offline shell verified.';
    if (!params.serviceWorkerRegistered) {
      note = 'Service worker is not active; offline reload is not guaranteed.';
    } else if (missing.length > 0) {
      note = `Missing ${missing.length} critical shell asset(s) in cache: ${missing.join(', ')}.`;
    } else if (!params.localModelInstalled) {
      note = 'App shell is cached for offline editing, but local ASR model is not installed yet.';
    }

    return Object.freeze({
      checkedAtMs: params.nowMs ?? Date.now(),
      serviceWorkerRegistered: params.serviceWorkerRegistered,
      criticalAssetsChecked: [...params.criticalAssets],
      missingCriticalAssets: missing,
      wasmAssetsCached: params.wasmAssetsCached,
      localModelInstalled: params.localModelInstalled,
      offlineStartupReady,
      offlineFullAsrReady,
      note,
    });
  }
}
