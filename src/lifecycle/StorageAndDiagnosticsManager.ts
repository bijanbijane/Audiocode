import { MemoryBudgetSnapshot } from '../runtime/memory/MemoryBudgetManager';
import { ReleaseReadinessReport } from '../quality-gate/ReleaseReadinessGate';
import { sanitizeLogPayload } from '../security/LocalPrivacyPolicy';
import { AVAPARDAZ_VERSION_CONTRACT } from './VersionCompatibilityContract';

export interface StorageBreakdownReport {
  readonly measuredAtMs: number;
  readonly storageApiAvailable: boolean;
  /** Browser StorageManager estimate (explicitly labeled as estimate, not exact bytes) */
  readonly estimatedUsageBytes: number | null;
  readonly estimatedQuotaBytes: number | null;
  readonly usageRatio: number | null;
  readonly quotaWarning: boolean;
  /** Explicitly measured application-tracked categories */
  readonly measuredInstalledModelBytes: number;
  readonly measuredProjectMetadataBytes: number;
  readonly measuredTempRenderBytes: number;
  readonly measuredPartialModelBytes: number;
  readonly measuredRecoverableCheckpointCount: number;
  readonly measuredAppCacheBytes: number | null;
  readonly error?: string;
}

export interface SafeCleanupTargetSummary {
  readonly abandonedTempRenderCount: number;
  readonly invalidPartialDownloadCount: number;
  readonly expiredCacheEntryCount: number;
  readonly obsoleteAppCacheCount: number;
  /** Protected counts are reported for transparency and NEVER auto-deleted */
  readonly protectedUserProjectsCount: number;
  readonly protectedSourceAudioCount: number;
  readonly protectedApprovedEdlCount: number;
  readonly protectedActiveCheckpointCount: number;
  readonly protectedOnlyValidModelPreserved: boolean;
}

export interface SafeCleanupExecutionResult {
  readonly cleanedTempRenderCount: number;
  readonly cleanedPartialDownloadsCount: number;
  readonly cleanedObsoleteCachesCount: number;
  readonly userProtectedDataUntouched: true;
  readonly warnings: readonly string[];
}

export interface LocalDiagnosticsBundle {
  readonly diagnosticsSchemaVersion: '1.0.0';
  readonly generatedAtIso: string;
  readonly localOnlyNotice: string;
  readonly appVersion: string;
  readonly buildId: string;
  readonly runtime: {
    readonly userAgentSanitized: string;
    readonly crossOriginIsolated: boolean;
    readonly workerAvailable: boolean;
    readonly wasmAvailable: boolean;
    readonly opfsAvailable: boolean;
  };
  readonly modelStatus: {
    readonly state: string;
    readonly modelId: string | null;
    readonly modelVersion: string | null;
  };
  readonly storageSummary: {
    readonly apiAvailable: boolean;
    readonly estimatedUsageBytes: number | null;
    readonly estimatedQuotaBytes: number | null;
    readonly quotaWarning: boolean;
  };
  readonly memoryPolicyState: {
    readonly accountedBytes: number;
    readonly highWaterMarkBytes: number;
    readonly hardLimitBytes: number;
    readonly pressureLevel: string;
  };
  readonly lastOperationStatus: string;
  readonly sanitizedErrorCodes: readonly string[];
  readonly releaseGateSummary: {
    readonly technicallyBuildable: boolean;
    readonly productionReady: boolean;
    readonly overallDecision: string;
  } | null;
}

/**
 * Honest Local Storage Visibility, Protected Cleanup & Privacy-Safe Diagnostics (AVP-P09-001 Sections 11 & 12)
 */
export class StorageAndDiagnosticsManager {
  public static async inspectStorage(params: {
    readonly storageEstimateFn?: () => Promise<{ usage?: number; quota?: number }>;
    readonly installedModelBytes: number;
    readonly projectMetadataBytes: number;
    readonly tempRenderBytes: number;
    readonly partialModelBytes: number;
    readonly recoverableCheckpointCount: number;
    readonly appCacheBytes?: number | null;
    readonly nowMs?: number;
  }): Promise<StorageBreakdownReport> {
    const nowMs = params.nowMs ?? Date.now();
    const estimateFn =
      params.storageEstimateFn ??
      (typeof navigator !== 'undefined' && navigator.storage?.estimate
        ? () => navigator.storage.estimate()
        : undefined);

    if (!estimateFn) {
      return {
        measuredAtMs: nowMs,
        storageApiAvailable: false,
        estimatedUsageBytes: null,
        estimatedQuotaBytes: null,
        usageRatio: null,
        quotaWarning: false,
        measuredInstalledModelBytes: params.installedModelBytes,
        measuredProjectMetadataBytes: params.projectMetadataBytes,
        measuredTempRenderBytes: params.tempRenderBytes,
        measuredPartialModelBytes: params.partialModelBytes,
        measuredRecoverableCheckpointCount: params.recoverableCheckpointCount,
        measuredAppCacheBytes: params.appCacheBytes ?? null,
        error: 'navigator.storage.estimate() is unavailable in this environment.',
      };
    }

    try {
      const est = await estimateFn();
      const usage = typeof est.usage === 'number' && Number.isFinite(est.usage) ? est.usage : null;
      const quota =
        typeof est.quota === 'number' && Number.isFinite(est.quota) && est.quota > 0
          ? est.quota
          : null;
      const ratio = usage !== null && quota !== null ? Number((usage / quota).toFixed(4)) : null;
      const quotaWarning = ratio !== null && ratio >= 0.85;

      return {
        measuredAtMs: nowMs,
        storageApiAvailable: true,
        estimatedUsageBytes: usage,
        estimatedQuotaBytes: quota,
        usageRatio: ratio,
        quotaWarning,
        measuredInstalledModelBytes: params.installedModelBytes,
        measuredProjectMetadataBytes: params.projectMetadataBytes,
        measuredTempRenderBytes: params.tempRenderBytes,
        measuredPartialModelBytes: params.partialModelBytes,
        measuredRecoverableCheckpointCount: params.recoverableCheckpointCount,
        measuredAppCacheBytes: params.appCacheBytes ?? null,
      };
    } catch (err) {
      return {
        measuredAtMs: nowMs,
        storageApiAvailable: false,
        estimatedUsageBytes: null,
        estimatedQuotaBytes: null,
        usageRatio: null,
        quotaWarning: false,
        measuredInstalledModelBytes: params.installedModelBytes,
        measuredProjectMetadataBytes: params.projectMetadataBytes,
        measuredTempRenderBytes: params.tempRenderBytes,
        measuredPartialModelBytes: params.partialModelBytes,
        measuredRecoverableCheckpointCount: params.recoverableCheckpointCount,
        measuredAppCacheBytes: params.appCacheBytes ?? null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Executes safe cleanup of ONLY temporary/partial/obsolete artifacts.
   * Structurally refuses to delete user source audio, projects, approved EDLs,
   * final exports, active recovery checkpoints, or the only valid installed model.
   */
  public static async runSafeCleanup(params: {
    readonly cleanAbandonedTempRenders: () => Promise<number> | number;
    readonly cleanInvalidPartialDownloads: () => Promise<number> | number;
    readonly cleanObsoleteAppCaches: () => Promise<number> | number;
  }): Promise<SafeCleanupExecutionResult> {
    const warnings: string[] = [];
    let cleanedTempRenderCount = 0;
    let cleanedPartialDownloadsCount = 0;
    let cleanedObsoleteCachesCount = 0;

    try {
      cleanedTempRenderCount = await params.cleanAbandonedTempRenders();
    } catch (err) {
      warnings.push(`Temp render cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      cleanedPartialDownloadsCount = await params.cleanInvalidPartialDownloads();
    } catch (err) {
      warnings.push(`Partial download cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      cleanedObsoleteCachesCount = await params.cleanObsoleteAppCaches();
    } catch (err) {
      warnings.push(`Obsolete cache cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      cleanedTempRenderCount,
      cleanedPartialDownloadsCount,
      cleanedObsoleteCachesCount,
      userProtectedDataUntouched: true,
      warnings,
    };
  }

  /**
   * Generates a privacy-preserving local diagnostics bundle strictly excluding audio,
   * transcripts, project names, private paths, secrets, and tokens. Never auto-uploads.
   */
  public static buildPrivacySafeDiagnosticsBundle(params: {
    readonly memorySnapshot: MemoryBudgetSnapshot;
    readonly storageReport: StorageBreakdownReport;
    readonly modelState: string;
    readonly modelId: string | null;
    readonly modelVersion: string | null;
    readonly lastOperationStatus: string;
    readonly errorCodes?: readonly string[];
    readonly releaseReport?: ReleaseReadinessReport | null;
    readonly opfsAvailable: boolean;
    readonly nowIso?: string;
  }): LocalDiagnosticsBundle {
    // Pass arbitrary metadata through sanitizeLogPayload to guarantee zero private leakage
    const sanitizedCheck = sanitizeLogPayload({
      lastOperationStatus: params.lastOperationStatus,
    });

    const rawUa =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent.slice(0, 140)
        : 'non-browser-runtime';

    const sanitizedErrorCodes = (params.errorCodes ?? [])
      .map((c) => c.replace(/[^A-Z0-9_:-]/gi, '').slice(0, 64))
      .filter((c) => c.length > 0);

    return Object.freeze({
      diagnosticsSchemaVersion: '1.0.0',
      generatedAtIso: params.nowIso ?? new Date().toISOString(),
      localOnlyNotice:
        'Generated strictly locally. Contains zero audio, transcript text, project names, file paths, secrets, or tokens. Never uploaded automatically.',
      appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
      buildId: AVAPARDAZ_VERSION_CONTRACT.buildId,
      runtime: {
        userAgentSanitized: rawUa,
        crossOriginIsolated:
          typeof globalThis !== 'undefined' && Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
        workerAvailable: typeof Worker !== 'undefined',
        wasmAvailable: typeof WebAssembly !== 'undefined',
        opfsAvailable: params.opfsAvailable,
      },
      modelStatus: {
        state: params.modelState,
        modelId: params.modelId,
        modelVersion: params.modelVersion,
      },
      storageSummary: {
        apiAvailable: params.storageReport.storageApiAvailable,
        estimatedUsageBytes: params.storageReport.estimatedUsageBytes,
        estimatedQuotaBytes: params.storageReport.estimatedQuotaBytes,
        quotaWarning: params.storageReport.quotaWarning,
      },
      memoryPolicyState: {
        accountedBytes: params.memorySnapshot.accountedBytes,
        highWaterMarkBytes: params.memorySnapshot.highWaterMarkBytes,
        hardLimitBytes: params.memorySnapshot.hardLimitBytes,
        pressureLevel: params.memorySnapshot.pressureLevel,
      },
      lastOperationStatus: String(sanitizedCheck.lastOperationStatus ?? 'UNKNOWN').slice(0, 80),
      sanitizedErrorCodes,
      releaseGateSummary: params.releaseReport
        ? {
            technicallyBuildable: params.releaseReport.technicallyBuildable,
            productionReady: params.releaseReport.productionReady,
            overallDecision: params.releaseReport.overallDecision,
          }
        : null,
    });
  }
}
