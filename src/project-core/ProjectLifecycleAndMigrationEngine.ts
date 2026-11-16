import { AssetId } from '../contracts/storage-broker.contract';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { SampleRate } from '../contracts/timebase.contract';

export type RelinkMatchStatus =
  | 'NOT_FOUND'
  | 'CANDIDATE_FOUND'
  | 'UNVERIFIED_MATCH'
  | 'HASH_VERIFIED'
  | 'CONTENT_CHANGED';

export type ProjectCompatibilityStatus =
  | 'COMPATIBLE'
  | 'COMPATIBLE_WITH_MIGRATION'
  | 'COMPATIBLE_WITH_LIMITATIONS'
  | 'READ_ONLY'
  | 'UNSUPPORTED';

export interface AssetIdentityRecord {
  readonly assetId: AssetId;
  readonly contentVersion: number;
  readonly fullContentSha256: string;
  readonly partialFingerprintSha256: string;
  readonly fileSize: number;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly sampleCount: number;
  readonly originalFileName: string;
}

export interface ProjectPackageArchive {
  readonly packageFormatVersion: 1;
  readonly exportedAtIso: string;
  readonly projectDocument: ProjectDocument;
  readonly assetIdentities: AssetIdentityRecord[];
  readonly provenanceLog: Record<string, unknown>[];
}

export class ProjectLifecycleAndMigrationEngine {
  public static readonly CURRENT_SCHEMA_VERSION = 2;
  public static readonly CURRENT_AUDIO_ENGINE_MAJOR = '1';
  public static readonly CURRENT_NODE_CATALOG_VERSION = '1.2';

  /**
   * Computes fast 3-slice Partial Fingerprint (64KB head + middle + tail) per Section 16.
   */
  public static async computePartialFingerprint(file: Blob): Promise<string> {
    const sliceSize = 64 * 1024;
    if (file.size <= sliceSize * 3) {
      return this.computeSha256Blob(file);
    }

    const midOffset = Math.floor(file.size / 2) - Math.floor(sliceSize / 2);
    const head = file.slice(0, sliceSize);
    const mid = file.slice(midOffset, midOffset + sliceSize);
    const tail = file.slice(file.size - sliceSize, file.size);

    const combined = new Blob([head, mid, tail]);
    return this.computeSha256Blob(combined);
  }

  public static async computeFullContentHash(file: Blob): Promise<string> {
    return this.computeSha256Blob(file);
  }

  /**
   * Missing Media Resolution lifecycle (Section 17):
   * Size & Partial Fingerprint -> Full Content Hash -> Relink / Content Version decision.
   */
  public static async evaluateCandidateForMissingAsset(
    missingAsset: AssetIdentityRecord,
    candidateBlob: Blob,
    candidateName?: string,
  ): Promise<{
    status: RelinkMatchStatus;
    requiresNewContentVersion: boolean;
    candidateFullHash?: string;
    reasonFa: string;
  }> {
    const resolvedName =
      candidateName ?? ('name' in candidateBlob ? String((candidateBlob as File).name) : '');
    const candidatePartial = await this.computePartialFingerprint(candidateBlob);

    if (
      candidateBlob.size === missingAsset.fileSize &&
      candidatePartial === missingAsset.partialFingerprintSha256
    ) {
      const fullHash = await this.computeSha256Blob(candidateBlob);
      if (fullHash === missingAsset.fullContentSha256) {
        return {
          status: 'HASH_VERIFIED',
          requiresNewContentVersion: false,
          candidateFullHash: fullHash,
          reasonFa:
            'تطابق ۱۰۰٪ باینری فایل با نسخه اصلی پروژه تأیید شد (حتی اگر نام فایل تغییر کرده باشد).',
        };
      }
    }

    if (resolvedName && resolvedName === missingAsset.originalFileName) {
      const fullHash = await this.computeSha256Blob(candidateBlob);
      return {
        status: 'CONTENT_CHANGED',
        requiresNewContentVersion: true,
        candidateFullHash: fullHash,
        reasonFa:
          'نام فایل مشابه است اما محتوای باینری آن تغییر کرده است. در صورت تأیید کاربر، با Content Version جدید ثبت می‌شود.',
      };
    }

    return {
      status: 'UNVERIFIED_MATCH',
      requiresNewContentVersion: true,
      reasonFa: 'فایل انتخابی از نظر اندازه و امضای محتوا با فایل گمشده تفاوت دارد.',
    };
  }

  /**
   * Non-destructive 4-dimensional Project Schema Migration (Section 21):
   * Source Snapshot -> Temporary Migration -> Validation -> Commit.
   */
  public static migrateProjectSafely(rawDoc: ProjectDocument): {
    compatibility: ProjectCompatibilityStatus;
    sourceSnapshot: ProjectDocument;
    migratedDocument: ProjectDocument;
    noticesFa: string[];
  } {
    const sourceSnapshot = structuredClone(rawDoc);
    const schemaVer = rawDoc.versions.projectSchemaVersion;
    const noticesFa: string[] = [];

    if (!Number.isInteger(schemaVer) || schemaVer < 1) {
      return {
        compatibility: 'UNSUPPORTED',
        sourceSnapshot,
        migratedDocument: sourceSnapshot,
        noticesFa: ['نسخه اسکیمای پروژه نامعتبر یا پشتیبانی‌نشده است.'],
      };
    }

    if (schemaVer > this.CURRENT_SCHEMA_VERSION) {
      return {
        compatibility: 'READ_ONLY',
        sourceSnapshot,
        migratedDocument: sourceSnapshot,
        noticesFa: [
          `پروژه با نسخه جدیدتر (${schemaVer}) ساخته شده است و در حالت فقط‌خواندنی باز می‌شود.`,
        ],
      };
    }

    const engineMajor = rawDoc.versions.audioEngineVersion.split('.')[0];
    const hasDimensionMismatch =
      engineMajor !== this.CURRENT_AUDIO_ENGINE_MAJOR ||
      rawDoc.versions.processingNodeCatalogVersion !== this.CURRENT_NODE_CATALOG_VERSION;

    if (schemaVer === this.CURRENT_SCHEMA_VERSION) {
      if (hasDimensionMismatch) {
        noticesFa.push(
          'نسخه موتور DSP یا کاتالوگ نودها با نسخه فعلی تفاوت جزئی دارد؛ پروژه با محدودیت سازگاری باز شد.',
        );
        return {
          compatibility: 'COMPATIBLE_WITH_LIMITATIONS',
          sourceSnapshot,
          migratedDocument: sourceSnapshot,
          noticesFa,
        };
      }
      return {
        compatibility: 'COMPATIBLE',
        sourceSnapshot,
        migratedDocument: sourceSnapshot,
        noticesFa,
      };
    }

    // Run schema migration strictly on cloned temporary copy
    const tempDoc: ProjectDocument = {
      ...structuredClone(rawDoc),
      versions: {
        ...rawDoc.versions,
        projectSchemaVersion: this.CURRENT_SCHEMA_VERSION,
      },
      tracks: rawDoc.tracks.map((t) => ({
        ...t,
        syncGroupId: t.syncGroupId ?? null,
      })),
    };

    if (!this.validateMigratedDocument(tempDoc)) {
      throw new Error(
        'PROJECT_MIGRATION_VALIDATION_FAILED: ساختار پروژه پس از مهاجرت موقت معتبر نیست؛ بازگشت به نسخه مبدأ.',
      );
    }

    noticesFa.push(
      `مهاجرت غیرمخرب از نسخه ${schemaVer} به ${this.CURRENT_SCHEMA_VERSION} با حفظ Snapshot مبدأ انجام شد.`,
    );

    return {
      compatibility: 'COMPATIBLE_WITH_MIGRATION',
      sourceSnapshot,
      migratedDocument: tempDoc,
      noticesFa,
    };
  }

  /**
   * Packages portable project metadata & asset hashes without bundling heavy AI models or PCM LRU cache.
   */
  public static buildProjectPackageArchive(
    projectDocument: ProjectDocument,
    assetIdentities: AssetIdentityRecord[],
    provenanceLog: Record<string, unknown>[] = [],
  ): ProjectPackageArchive {
    return {
      packageFormatVersion: 1,
      exportedAtIso: new Date().toISOString(),
      projectDocument: structuredClone(projectDocument),
      assetIdentities: structuredClone(assetIdentities),
      provenanceLog: structuredClone(provenanceLog),
    };
  }

  private static validateMigratedDocument(doc: ProjectDocument): boolean {
    if (!doc.projectId || doc.revision < 0) return false;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.timelineRange.end <= clip.timelineRange.start) return false;
        if (clip.sourceRange.end <= clip.sourceRange.start) return false;
      }
    }
    return true;
  }

  private static async computeSha256Blob(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
