import { ProjectDocument } from '../contracts/project-schema.contract';
import {
  AssetIdentityRecord,
  ProjectLifecycleAndMigrationEngine,
} from './ProjectLifecycleAndMigrationEngine';
import { ExportProfileSpec } from '../processing-core/StreamingExportEncoder';
import { UserExternalApiPolicy } from '../ai-engine/ExternalApiGovernanceGateway';

export type BackupKind = 'PROJECT_BACKUP' | 'MEDIA_BACKUP' | 'ENVIRONMENT_RECOVERY';

export interface BaseBackupManifest {
  readonly backupId: string;
  readonly kind: BackupKind;
  readonly createdAtIso: string;
  readonly appEngineVersion: string;
  readonly payloadSha256Hex: string;
  readonly limitationsNoteFa: string;
}

export interface ProjectBackupBundle {
  readonly manifest: BaseBackupManifest & { kind: 'PROJECT_BACKUP' };
  readonly projectDocument: ProjectDocument;
  readonly requiredAssetIdentities: AssetIdentityRecord[];
}

export interface MediaBackupBundle {
  readonly manifest: BaseBackupManifest & { kind: 'MEDIA_BACKUP' };
  readonly assetIdentities: AssetIdentityRecord[];
}

export interface EnvironmentRecoveryBundle {
  readonly manifest: BaseBackupManifest & { kind: 'ENVIRONMENT_RECOVERY' };
  readonly customExportProfiles: ExportProfileSpec[];
  readonly userApiPolicy: UserExternalApiPolicy;
  readonly installedModelRefs: { modelId: string; version: string }[];
}

export type RestoreValidationStageId =
  | 'STAGE_1_MANIFEST_KIND'
  | 'STAGE_2_SHA256_INTEGRITY'
  | 'STAGE_3_RUNTIME_COMPATIBILITY'
  | 'STAGE_4_SCHEMA_MIGRATION'
  | 'STAGE_5_ASSET_REFERENCES';

export interface RestoreValidationStageResult {
  readonly stage: RestoreValidationStageId;
  readonly passed: boolean;
  readonly detailFa: string;
}

export interface FiveStageProjectRestorePreflight {
  readonly canRestore: boolean;
  readonly failedStage: RestoreValidationStageId | null;
  readonly stages: RestoreValidationStageResult[];
  readonly missingAssetIds: string[];
  readonly contentChangedAssetIds: string[];
  readonly wasMigrated: boolean;
  readonly readOnlyRecommended: boolean;
}

/**
 * Triple-Pillar Backup & Environment Recovery Manager (Architecture Doc Section 46).
 * Strictly isolates Project Backup, Media Backup, and Environment Recovery with
 * multi-stage SHA-256, runtime, schema, and asset integrity verification before restore.
 */
export class BackupAndEnvironmentRestoreManager {
  public static async createProjectBackup(
    project: ProjectDocument,
    requiredAssets: readonly AssetIdentityRecord[],
    appEngineVersion: string,
  ): Promise<ProjectBackupBundle> {
    const payloadJson = JSON.stringify({ project, requiredAssets });
    const payloadSha256Hex = await this.computeSha256Text(payloadJson);

    return {
      manifest: {
        backupId: `bkp_proj_${project.projectId}_${Date.now()}`,
        kind: 'PROJECT_BACKUP',
        createdAtIso: new Date().toISOString(),
        appEngineVersion,
        payloadSha256Hex,
        limitationsNoteFa:
          'این بسته حاوی ساختار کامل پروژه، تایملاین و نتایج هوش مصنوعی است و شامل فایل‌های صوتی خام یا وزن مدل‌ها نمی‌شود.',
      },
      projectDocument: structuredClone(project),
      requiredAssetIdentities: structuredClone([...requiredAssets]),
    };
  }

  public static async createMediaBackup(
    assetIdentities: readonly AssetIdentityRecord[],
    appEngineVersion: string,
  ): Promise<MediaBackupBundle> {
    const payloadJson = JSON.stringify({ assetIdentities });
    const payloadSha256Hex = await this.computeSha256Text(payloadJson);

    return {
      manifest: {
        backupId: `bkp_media_${Date.now()}`,
        kind: 'MEDIA_BACKUP',
        createdAtIso: new Date().toISOString(),
        appEngineVersion,
        payloadSha256Hex,
        limitationsNoteFa:
          'این بسته صرفاً شامل رسانه‌های اصلی و امضای محتوای SHA-256 آن‌ها است و شامل تایملاین ویرایش یا تنظیمات محیط نیست.',
      },
      assetIdentities: structuredClone([...assetIdentities]),
    };
  }

  public static async createEnvironmentRecoveryBundle(
    customExportProfiles: readonly ExportProfileSpec[],
    userApiPolicy: UserExternalApiPolicy,
    installedModelRefs: readonly { modelId: string; version: string }[],
    appEngineVersion: string,
  ): Promise<EnvironmentRecoveryBundle> {
    const payloadJson = JSON.stringify({
      customExportProfiles,
      userApiPolicy,
      installedModelRefs,
    });
    const payloadSha256Hex = await this.computeSha256Text(payloadJson);

    return {
      manifest: {
        backupId: `bkp_env_${Date.now()}`,
        kind: 'ENVIRONMENT_RECOVERY',
        createdAtIso: new Date().toISOString(),
        appEngineVersion,
        payloadSha256Hex,
        limitationsNoteFa:
          'این بسته تنظیمات محیط کار، پروفایل‌های خروجی، سیاست‌های امنیتی و فهرست مدل‌های موردنیاز را بازیابی می‌کند.',
      },
      customExportProfiles: structuredClone([...customExportProfiles]),
      userApiPolicy: structuredClone(userApiPolicy),
      installedModelRefs: structuredClone([...installedModelRefs]),
    };
  }

  /**
   * Non-throwing 5-stage preflight verification report for UI preview & pre-restore auditing.
   */
  public static async preflightValidateProjectBackup(
    bundle: ProjectBackupBundle,
    availableLocalAssetsMap: Map<string, AssetIdentityRecord>,
    currentSupportedEngineMajor: number,
  ): Promise<FiveStageProjectRestorePreflight> {
    const stages: RestoreValidationStageResult[] = [];

    // Stage 1: Manifest & Kind
    const stage1Ok = Boolean(bundle?.manifest?.backupId && bundle.manifest.kind === 'PROJECT_BACKUP');
    stages.push({
      stage: 'STAGE_1_MANIFEST_KIND',
      passed: stage1Ok,
      detailFa: stage1Ok
        ? 'ساختار و نوع بسته پشتیبان پروژه تایید شد.'
        : 'RESTORE_INVALID_KIND: نوع بسته پشتیبان با بازیابی پروژه هم‌خوانی ندارد.',
    });
    if (!stage1Ok) {
      return {
        canRestore: false,
        failedStage: 'STAGE_1_MANIFEST_KIND',
        stages,
        missingAssetIds: [],
        contentChangedAssetIds: [],
        wasMigrated: false,
        readOnlyRecommended: false,
      };
    }

    // Stage 2: SHA-256 Payload Integrity
    const expectedJson = JSON.stringify({
      project: bundle.projectDocument,
      requiredAssets: bundle.requiredAssetIdentities,
    });
    const actualHash = await this.computeSha256Text(expectedJson);
    const stage2Ok = actualHash === bundle.manifest.payloadSha256Hex;
    stages.push({
      stage: 'STAGE_2_SHA256_INTEGRITY',
      passed: stage2Ok,
      detailFa: stage2Ok
        ? 'امضای یکپارچگی SHA-256 بسته تایید شد.'
        : 'RESTORE_HASH_MISMATCH: فایل پشتیبان پروژه دستکاری شده یا آسیب دیده است (عدم تطابق SHA-256).',
    });
    if (!stage2Ok) {
      return {
        canRestore: false,
        failedStage: 'STAGE_2_SHA256_INTEGRITY',
        stages,
        missingAssetIds: [],
        contentChangedAssetIds: [],
        wasMigrated: false,
        readOnlyRecommended: false,
      };
    }

    // Stage 3: Runtime Compatibility
    const backupEngineMajor = parseInt(bundle.manifest.appEngineVersion.split('.')[0] ?? '1', 10);
    const stage3Ok = Number.isFinite(backupEngineMajor) && backupEngineMajor <= currentSupportedEngineMajor;
    stages.push({
      stage: 'STAGE_3_RUNTIME_COMPATIBILITY',
      passed: stage3Ok,
      detailFa: stage3Ok
        ? `نسخه موتور (${bundle.manifest.appEngineVersion}) با محیط فعلی سازگار است.`
        : `RESTORE_RUNTIME_INCOMPATIBLE: این پشتیبان متعلق به موتور نسخه ${bundle.manifest.appEngineVersion} است و نیازمند به‌روزرسانی برنامه است.`,
    });
    if (!stage3Ok) {
      return {
        canRestore: false,
        failedStage: 'STAGE_3_RUNTIME_COMPATIBILITY',
        stages,
        missingAssetIds: [],
        contentChangedAssetIds: [],
        wasMigrated: false,
        readOnlyRecommended: false,
      };
    }

    // Stage 4: Schema Migration Safety
    const migrationResult = ProjectLifecycleAndMigrationEngine.migrateProjectSafely(
      bundle.projectDocument,
    );
    const stage4Ok = migrationResult.compatibility !== 'UNSUPPORTED';
    stages.push({
      stage: 'STAGE_4_SCHEMA_MIGRATION',
      passed: stage4Ok,
      detailFa: stage4Ok
        ? migrationResult.compatibility === 'COMPATIBLE_WITH_MIGRATION'
          ? 'اسکیمای پروژه به‌صورت غیرمخرب ارتقا یافت.'
          : 'اسکیمای پروژه معتبر است.'
        : 'RESTORE_SCHEMA_UNSUPPORTED: نسخه ساختار داده پروژه پشتیبانی نمی‌شود.',
    });
    if (!stage4Ok) {
      return {
        canRestore: false,
        failedStage: 'STAGE_4_SCHEMA_MIGRATION',
        stages,
        missingAssetIds: [],
        contentChangedAssetIds: [],
        wasMigrated: false,
        readOnlyRecommended: false,
      };
    }

    // Stage 5: Asset Reference Verification
    const missingAssetIds: string[] = [];
    const contentChangedAssetIds: string[] = [];
    for (const reqAsset of bundle.requiredAssetIdentities) {
      const localAsset = availableLocalAssetsMap.get(reqAsset.assetId);
      if (!localAsset) {
        missingAssetIds.push(reqAsset.assetId);
      } else if (localAsset.fullContentSha256 !== reqAsset.fullContentSha256) {
        contentChangedAssetIds.push(reqAsset.assetId);
      }
    }
    stages.push({
      stage: 'STAGE_5_ASSET_REFERENCES',
      passed: true,
      detailFa:
        missingAssetIds.length === 0 && contentChangedAssetIds.length === 0
          ? 'تمامی فایل‌های صوتی مرجع در دستگاه تایید شدند.'
          : `بررسی رسانه‌ها کامل شد (${missingAssetIds.length} فایل گمشده، ${contentChangedAssetIds.length} فایل تغییریافته نیازمند Relink).`,
    });

    return {
      canRestore: true,
      failedStage: null,
      stages,
      missingAssetIds,
      contentChangedAssetIds,
      wasMigrated: migrationResult.compatibility === 'COMPATIBLE_WITH_MIGRATION',
      readOnlyRecommended: migrationResult.compatibility === 'READ_ONLY',
    };
  }

  /**
   * 5-Stage Verified Project Restore:
   * 1) Kind check -> 2) SHA-256 Hash check -> 3) Runtime compatibility ->
   * 4) Schema migration check -> 5) Asset reference verification.
   */
  public static async validateAndRestoreProjectBackup(
    bundle: ProjectBackupBundle,
    availableLocalAssetsMap: Map<string, AssetIdentityRecord>,
    currentSupportedEngineMajor: number,
  ): Promise<{
    restoredDocument: ProjectDocument;
    missingAssetIds: string[];
    contentChangedAssetIds: string[];
    wasMigrated: boolean;
    readOnlyRecommended: boolean;
    validationStages: RestoreValidationStageResult[];
  }> {
    const preflight = await this.preflightValidateProjectBackup(
      bundle,
      availableLocalAssetsMap,
      currentSupportedEngineMajor,
    );
    if (!preflight.canRestore) {
      const failed = preflight.stages.find((s) => s.stage === preflight.failedStage);
      throw new Error(failed?.detailFa ?? 'RESTORE_VALIDATION_FAILED');
    }

    const migrationResult = ProjectLifecycleAndMigrationEngine.migrateProjectSafely(
      bundle.projectDocument,
    );

    return {
      restoredDocument: migrationResult.migratedDocument,
      missingAssetIds: preflight.missingAssetIds,
      contentChangedAssetIds: preflight.contentChangedAssetIds,
      wasMigrated: preflight.wasMigrated,
      readOnlyRecommended: preflight.readOnlyRecommended,
      validationStages: preflight.stages,
    };
  }

  public static async validateAndRestoreMediaBackup(
    bundle: MediaBackupBundle,
  ): Promise<{ assetIdentities: AssetIdentityRecord[] }> {
    if (bundle.manifest.kind !== 'MEDIA_BACKUP') {
      throw new Error('RESTORE_INVALID_KIND: نوع بسته پشتیبان رسانه معتبر نیست.');
    }
    const payloadJson = JSON.stringify({ assetIdentities: bundle.assetIdentities });
    const actualHash = await this.computeSha256Text(payloadJson);
    if (actualHash !== bundle.manifest.payloadSha256Hex) {
      throw new Error('RESTORE_HASH_MISMATCH: بسته پشتیبان رسانه دچار دستکاری یا خرابی است.');
    }
    return { assetIdentities: structuredClone(bundle.assetIdentities) };
  }

  public static async validateAndRestoreEnvironmentRecovery(
    bundle: EnvironmentRecoveryBundle,
    currentSupportedEngineMajor: number,
  ): Promise<{
    customExportProfiles: ExportProfileSpec[];
    userApiPolicy: UserExternalApiPolicy;
    installedModelRefs: { modelId: string; version: string }[];
  }> {
    if (bundle.manifest.kind !== 'ENVIRONMENT_RECOVERY') {
      throw new Error('RESTORE_INVALID_KIND: نوع بسته بازیابی محیط معتبر نیست.');
    }
    const payloadJson = JSON.stringify({
      customExportProfiles: bundle.customExportProfiles,
      userApiPolicy: bundle.userApiPolicy,
      installedModelRefs: bundle.installedModelRefs,
    });
    const actualHash = await this.computeSha256Text(payloadJson);
    if (actualHash !== bundle.manifest.payloadSha256Hex) {
      throw new Error('RESTORE_HASH_MISMATCH: بسته بازیابی محیط دچار دستکاری یا خرابی است.');
    }
    const backupEngineMajor = parseInt(bundle.manifest.appEngineVersion.split('.')[0] ?? '1', 10);
    if (backupEngineMajor > currentSupportedEngineMajor) {
      throw new Error(
        `RESTORE_RUNTIME_INCOMPATIBLE: بسته محیط مربوط به نسخه ${bundle.manifest.appEngineVersion} است.`,
      );
    }

    return {
      customExportProfiles: structuredClone(bundle.customExportProfiles),
      userApiPolicy: structuredClone(bundle.userApiPolicy),
      installedModelRefs: structuredClone(bundle.installedModelRefs),
    };
  }

  private static async computeSha256Text(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
