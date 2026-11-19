import {
  computeSha256Hex,
  safeParseJsonWithGuards,
  sanitizeExportFilename,
} from '../security/LocalPrivacyPolicy';
import {
  AVAPARDAZ_VERSION_CONTRACT,
  migratePersistedProjectSafely,
  PersistedProjectEnvelope,
} from './VersionCompatibilityContract';

export type ProjectBackupMode = 'METADATA_ONLY' | 'COMPLETE_PACKAGE';

export interface BackupIncludedFileEntry {
  readonly fileName: string;
  readonly role: 'PROJECT_METADATA' | 'SOURCE_AUDIO_REF' | 'SOURCE_AUDIO_BYTES';
  readonly byteLength: number;
  readonly sha256Hex: string;
}

export interface ProjectBackupPackage {
  readonly backupFormatVersion: '1.0.0';
  readonly mode: ProjectBackupMode;
  readonly appVersion: string;
  readonly projectSchemaVersion: number;
  readonly createdAtMs: number;
  readonly projectId: string;
  readonly projectName: string;
  readonly manifestEntries: readonly BackupIncludedFileEntry[];
  readonly project: PersistedProjectEnvelope;
  /** Only populated in COMPLETE_PACKAGE mode when user explicitly opts in */
  readonly embeddedAudioBase64?: Readonly<Record<string, string>>;
  readonly packageChecksumSha256: string;
}

export interface BackupCreationResult {
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly fileName: string | null;
  readonly estimatedBytes: number;
  readonly actualBytes: number;
  readonly packageJson: string | null;
  readonly backup: ProjectBackupPackage | null;
  readonly error?: string;
}

export interface BackupRestoreResult {
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly restoredProject: PersistedProjectEnvelope | null;
  readonly rollbackSnapshot: PersistedProjectEnvelope | null;
  readonly migratedFromVersion: number | null;
  readonly duplicateProjectDetected: boolean;
  readonly embeddedAssetsCount: number;
  readonly error?: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Local Project Backup & Restore Engine (AVP-P09-001 Section 10)
 *
 * Explicitly separates METADATA_ONLY from COMPLETE_PACKAGE (with selected audio assets),
 * enforces SHA-256 manifest verification, schema migration, duplicate-project protection,
 * and cancellation safety.
 */
export class ProjectBackupAndRestore {
  public static estimateBackupSizeBytes(params: {
    readonly project: PersistedProjectEnvelope;
    readonly mode: ProjectBackupMode;
    readonly selectedAudioAssets?: Readonly<Record<string, Uint8Array>>;
  }): number {
    const metaBytes = new TextEncoder().encode(JSON.stringify(params.project)).byteLength;
    if (params.mode === 'METADATA_ONLY' || !params.selectedAudioAssets) {
      return metaBytes + 512;
    }
    let audioBytes = 0;
    for (const buf of Object.values(params.selectedAudioAssets)) {
      // Base64 overhead ~4/3
      audioBytes += Math.ceil((buf.byteLength * 4) / 3) + 128;
    }
    return metaBytes + audioBytes + 1024;
  }

  public static async createBackup(params: {
    readonly project: PersistedProjectEnvelope;
    readonly mode: ProjectBackupMode;
    readonly selectedAudioAssets?: Readonly<Record<string, Uint8Array>>;
    readonly maxPackageBytes?: number;
    readonly abortSignal?: AbortSignal;
    readonly nowMs?: number;
  }): Promise<BackupCreationResult> {
    const nowMs = params.nowMs ?? Date.now();
    const estimatedBytes = this.estimateBackupSizeBytes(params);
    const maxBytes = params.maxPackageBytes ?? 64 * 1024 * 1024;

    if (params.abortSignal?.aborted) {
      return {
        ok: false,
        cancelled: true,
        fileName: null,
        estimatedBytes,
        actualBytes: 0,
        packageJson: null,
        backup: null,
        error: 'Backup cancelled before packaging.',
      };
    }

    if (estimatedBytes > maxBytes) {
      return {
        ok: false,
        cancelled: false,
        fileName: null,
        estimatedBytes,
        actualBytes: 0,
        packageJson: null,
        backup: null,
        error: `Estimated backup size (${estimatedBytes} B) exceeds safe in-memory package limit (${maxBytes} B). Use METADATA_ONLY backup or export audio separately.`,
      };
    }

    const projectBytes = new TextEncoder().encode(JSON.stringify(params.project));
    const projectSha = await computeSha256Hex(projectBytes);

    const manifestEntries: BackupIncludedFileEntry[] = [
      {
        fileName: 'project.json',
        role: 'PROJECT_METADATA',
        byteLength: projectBytes.byteLength,
        sha256Hex: projectSha,
      },
    ];

    let embeddedAudioBase64: Record<string, string> | undefined;

    if (params.mode === 'COMPLETE_PACKAGE' && params.selectedAudioAssets) {
      embeddedAudioBase64 = {};
      for (const [assetName, bytes] of Object.entries(params.selectedAudioAssets)) {
        if (params.abortSignal?.aborted) {
          return {
            ok: false,
            cancelled: true,
            fileName: null,
            estimatedBytes,
            actualBytes: 0,
            packageJson: null,
            backup: null,
            error: 'Backup cancelled during asset checksum computation; partial output discarded.',
          };
        }
        const safeName = sanitizeExportFilename(assetName, 'wav');
        const assetSha = await computeSha256Hex(bytes);
        manifestEntries.push({
          fileName: safeName,
          role: 'SOURCE_AUDIO_BYTES',
          byteLength: bytes.byteLength,
          sha256Hex: assetSha,
        });
        embeddedAudioBase64[safeName] = uint8ToBase64(bytes);
      }
    }

    const bodyWithoutChecksum = {
      backupFormatVersion: '1.0.0' as const,
      mode: params.mode,
      appVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
      projectSchemaVersion: params.project.schemaVersion,
      createdAtMs: nowMs,
      projectId: params.project.projectId,
      projectName: params.project.projectName,
      manifestEntries,
      project: params.project,
      ...(embeddedAudioBase64 ? { embeddedAudioBase64 } : {}),
    };

    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyWithoutChecksum));
    const packageChecksumSha256 = await computeSha256Hex(bodyBytes);

    const backup: ProjectBackupPackage = Object.freeze({
      ...bodyWithoutChecksum,
      packageChecksumSha256,
    });

    const packageJson = JSON.stringify(backup, null, 2);
    const actualBytes = new TextEncoder().encode(packageJson).byteLength;
    const suffix = params.mode === 'COMPLETE_PACKAGE' ? 'complete-backup' : 'metadata-backup';
    const fileName = sanitizeExportFilename(`${params.project.projectName}-${suffix}`, 'json');

    return {
      ok: true,
      cancelled: false,
      fileName,
      estimatedBytes,
      actualBytes,
      packageJson,
      backup,
    };
  }

  public static async restoreBackup(params: {
    readonly backupJson: string;
    readonly existingProjectIds: readonly string[];
    readonly allowOverwriteExisting?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly nowMs?: number;
  }): Promise<BackupRestoreResult> {
    if (params.abortSignal?.aborted) {
      return {
        ok: false,
        cancelled: true,
        restoredProject: null,
        rollbackSnapshot: null,
        migratedFromVersion: null,
        duplicateProjectDetected: false,
        embeddedAssetsCount: 0,
        error: 'Restore cancelled before parsing.',
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = safeParseJsonWithGuards<Record<string, unknown>>(params.backupJson, 80 * 1024 * 1024);
    } catch (err) {
      return {
        ok: false,
        cancelled: false,
        restoredProject: null,
        rollbackSnapshot: null,
        migratedFromVersion: null,
        duplicateProjectDetected: false,
        embeddedAssetsCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (
      parsed.backupFormatVersion !== '1.0.0' ||
      !Array.isArray(parsed.manifestEntries) ||
      typeof parsed.packageChecksumSha256 !== 'string' ||
      !parsed.project ||
      typeof parsed.project !== 'object'
    ) {
      return {
        ok: false,
        cancelled: false,
        restoredProject: null,
        rollbackSnapshot: null,
        migratedFromVersion: null,
        duplicateProjectDetected: false,
        embeddedAssetsCount: 0,
        error: 'Invalid or incomplete backup manifest.',
      };
    }

    // Verify package-level SHA-256 checksum
    const { packageChecksumSha256, ...bodyWithoutChecksum } = parsed;
    const expectedPkgHash = await computeSha256Hex(
      new TextEncoder().encode(JSON.stringify(bodyWithoutChecksum)),
    );
    if (expectedPkgHash !== packageChecksumSha256) {
      return {
        ok: false,
        cancelled: false,
        restoredProject: null,
        rollbackSnapshot: null,
        migratedFromVersion: null,
        duplicateProjectDetected: false,
        embeddedAssetsCount: 0,
        error: 'Corrupted backup: package SHA-256 integrity checksum mismatch.',
      };
    }

    // Verify per-file embedded asset checksums & presence
    const entries = parsed.manifestEntries as BackupIncludedFileEntry[];
    const embeddedMap = (parsed.embeddedAudioBase64 ?? {}) as Record<string, string>;
    let embeddedAssetsCount = 0;

    for (const entry of entries) {
      if (params.abortSignal?.aborted) {
        return {
          ok: false,
          cancelled: true,
          restoredProject: null,
          rollbackSnapshot: null,
          migratedFromVersion: null,
          duplicateProjectDetected: false,
          embeddedAssetsCount: 0,
          error: 'Restore cancelled during asset verification.',
        };
      }
      if (entry.role === 'SOURCE_AUDIO_BYTES') {
        const b64 = embeddedMap[entry.fileName];
        if (typeof b64 !== 'string') {
          return {
            ok: false,
            cancelled: false,
            restoredProject: null,
            rollbackSnapshot: null,
            migratedFromVersion: null,
            duplicateProjectDetected: false,
            embeddedAssetsCount: 0,
            error: `Missing embedded source asset "${entry.fileName}" declared in backup manifest.`,
          };
        }
        const bytes = base64ToUint8(b64);
        const actualSha = await computeSha256Hex(bytes);
        if (actualSha !== entry.sha256Hex) {
          return {
            ok: false,
            cancelled: false,
            restoredProject: null,
            rollbackSnapshot: null,
            migratedFromVersion: null,
            duplicateProjectDetected: false,
            embeddedAssetsCount: 0,
            error: `Embedded asset "${entry.fileName}" failed SHA-256 integrity check.`,
          };
        }
        embeddedAssetsCount++;
      }
    }

    const rawProject = parsed.project as PersistedProjectEnvelope;
    const duplicateDetected = params.existingProjectIds.includes(rawProject.projectId);
    if (duplicateDetected && !params.allowOverwriteExisting) {
      return {
        ok: false,
        cancelled: false,
        restoredProject: null,
        rollbackSnapshot: null,
        migratedFromVersion: null,
        duplicateProjectDetected: true,
        embeddedAssetsCount,
        error: `Project "${rawProject.projectId}" already exists; explicit user confirmation is required before overwriting.`,
      };
    }

    // Validate & safely migrate schema if older version
    const migration = migratePersistedProjectSafely(rawProject, params.nowMs);
    if (!migration.ok || !migration.migratedProject) {
      return {
        ok: false,
        cancelled: false,
        restoredProject: null,
        rollbackSnapshot: null,
        migratedFromVersion: null,
        duplicateProjectDetected: duplicateDetected,
        embeddedAssetsCount,
        error: migration.error ?? 'Schema compatibility check failed.',
      };
    }

    return {
      ok: true,
      cancelled: false,
      restoredProject: migration.migratedProject,
      rollbackSnapshot: migration.rollbackSnapshot,
      migratedFromVersion:
        migration.decision === 'MIGRATION_REQUIRED' ? rawProject.schemaVersion : null,
      duplicateProjectDetected: duplicateDetected,
      embeddedAssetsCount,
    };
  }
}
