import { ProjectVersionMatrix } from '../contracts/project-schema.contract';

export type FeatureMaturityStage =
  | 'EXPERIMENTAL'
  | 'PREVIEW'
  | 'BETA'
  | 'STABLE'
  | 'DEPRECATED'
  | 'DISABLED';

export type DeviceTierRank = 'MOBILE_COMPANION' | 'TABLET_STUDIO' | 'DESKTOP_STUDIO';

export interface PlatformFeatureDescriptor {
  readonly featureId: string;
  readonly titleFa: string;
  readonly stage: FeatureMaturityStage;
  readonly minRequiredDeviceTier: DeviceTierRank;
  readonly minModelBundleVersion?: string;
}

export interface StagedReleaseBundle {
  readonly releaseId: string;
  readonly versions: ProjectVersionMatrix;
  readonly minCompatibleSchemaVersion: number;
  readonly stagedAtTimestamp: number;
}

const TIER_ORDER: Record<DeviceTierRank, number> = {
  MOBILE_COMPANION: 1,
  TABLET_STUDIO: 2,
  DESKTOP_STUDIO: 3,
};

/**
 * Atomic Release Update, Instant Rollback, and 6-Stage Feature Maturity Governance
 * (Architecture Doc Sections 47 & 54).
 */
export class ReleaseAndFeatureMaturityManager {
  private currentRelease: StagedReleaseBundle;
  private previousRollbackRelease: StagedReleaseBundle | null = null;
  private stagedNextRelease: StagedReleaseBundle | null = null;
  private readonly features = new Map<string, PlatformFeatureDescriptor>();

  constructor(initialRelease: StagedReleaseBundle, catalog: PlatformFeatureDescriptor[]) {
    this.currentRelease = initialRelease;
    for (const f of catalog) {
      this.features.set(f.featureId, f);
    }
  }

  public getReleaseState(): {
    current: StagedReleaseBundle;
    staged: StagedReleaseBundle | null;
    canRollback: boolean;
  } {
    return {
      current: this.currentRelease,
      staged: this.stagedNextRelease,
      canRollback: this.previousRollbackRelease !== null,
    };
  }

  public canActivateFeature(
    featureId: string,
    userOptedIntoExperimental: boolean,
    deviceTier: DeviceTierRank = 'DESKTOP_STUDIO',
  ): { allowed: boolean; badgeFa: string | null; reasonFa?: string } {
    const feat = this.features.get(featureId);
    if (!feat || feat.stage === 'DISABLED') {
      return { allowed: false, badgeFa: null, reasonFa: 'این قابلیت غیرفعال است.' };
    }

    if (TIER_ORDER[deviceTier] < TIER_ORDER[feat.minRequiredDeviceTier]) {
      return {
        allowed: false,
        badgeFa: null,
        reasonFa: `این قابلیت نیازمند سخت‌افزار حداقل ${feat.minRequiredDeviceTier} است.`,
      };
    }

    if (feat.stage === 'EXPERIMENTAL' && !userOptedIntoExperimental) {
      return {
        allowed: false,
        badgeFa: 'آزمایشی (Experimental)',
        reasonFa: 'قابلیت آزمایشی به صورت پیش‌فرض در محیط پایدار فعال نمی‌شود.',
      };
    }

    const badges: Record<FeatureMaturityStage, string | null> = {
      STABLE: null,
      BETA: 'نسخه بتا (Beta)',
      PREVIEW: 'پیش‌نمایش (Preview)',
      EXPERIMENTAL: 'آزمایشی (Experimental)',
      DEPRECATED: 'منسوخ‌شده (Deprecated)',
      DISABLED: null,
    };

    return {
      allowed: true,
      badgeFa: badges[feat.stage],
    };
  }

  public stageUpdateInBackground(nextBundle: StagedReleaseBundle): void {
    this.stagedNextRelease = nextBundle;
  }

  public commitStagedUpdateIfSafe(params: {
    hasActiveOpenProject: boolean;
    hasRunningJobs: boolean;
    activeProjectSchemaVersion?: number;
  }): { committed: boolean; activeRelease: StagedReleaseBundle; reasonFa: string } {
    if (!this.stagedNextRelease) {
      return {
        committed: false,
        activeRelease: this.currentRelease,
        reasonFa: 'نسخه جدیدی در صف انتظار نیست.',
      };
    }

    if (params.hasActiveOpenProject || params.hasRunningJobs) {
      return {
        committed: false,
        activeRelease: this.currentRelease,
        reasonFa:
          'پروژه یا عملیات پردازشی فعال است؛ اعمال نسخه جدید تا بسته شدن ایمن پروژه به تعویق افتاد.',
      };
    }

    if (
      params.activeProjectSchemaVersion !== undefined &&
      params.activeProjectSchemaVersion < this.stagedNextRelease.minCompatibleSchemaVersion
    ) {
      return {
        committed: false,
        activeRelease: this.currentRelease,
        reasonFa: 'نسخه جدید نیازمند اجرای مهاجرت اسکیما (Migration) روی پروژه است.',
      };
    }

    this.previousRollbackRelease = this.currentRelease;
    this.currentRelease = this.stagedNextRelease;
    this.stagedNextRelease = null;

    return {
      committed: true,
      activeRelease: this.currentRelease,
      reasonFa: 'نسخه جدید به صورت اتمیک و ایمن فعال شد.',
    };
  }

  public rollbackToPreviousRelease(): StagedReleaseBundle {
    if (!this.previousRollbackRelease) {
      throw new Error('NO_ROLLBACK_SNAPSHOT_AVAILABLE');
    }
    this.currentRelease = this.previousRollbackRelease;
    this.previousRollbackRelease = null;
    return this.currentRelease;
  }
}
