import { computeSha256Hex } from '../security/LocalPrivacyPolicy';
import { AvapardazError } from './AvapardazError';

export const RECOVERY_RECORD_SCHEMA_VERSION = 1 as const;

export type RecoveryArtifactCategory =
  | 'COMMITTED_PROJECT_STATE'
  | 'COMMITTED_TIMELINE_TRANSACTION'
  | 'SAVED_TRANSCRIPT_VERSION'
  | 'APPROVED_EDL_VERSION'
  | 'VALID_RENDER_CHECKPOINT'
  | 'INCOMPLETE_TEMP_ARTIFACT';

export interface VersionedRecoveryRecord<TPayload = unknown> {
  readonly schemaVersion: typeof RECOVERY_RECORD_SCHEMA_VERSION;
  readonly recordId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly category: RecoveryArtifactCategory;
  readonly committed: boolean;
  readonly revisionNumber: number;
  readonly updatedAtMs: number;
  readonly payload: TPayload;
  readonly payloadSha256: string;
}

export type RecoveryResolutionOutcome =
  | 'NO_RECOVERY_NEEDED'
  | 'SAFE_RESTORE_CANDIDATE'
  | 'KEEP_NEWER_CURRENT_STATE'
  | 'REQUIRES_USER_DECISION'
  | 'REJECTED_CORRUPT_OR_INCOMPLETE';

export interface RecoveryEvaluationResult<TPayload = unknown> {
  readonly outcome: RecoveryResolutionOutcome;
  readonly reasonFa: string;
  readonly reasonEn: string;
  readonly integrityVerified: boolean;
  readonly candidateRecord: VersionedRecoveryRecord<TPayload> | null;
  readonly currentPreserved: boolean;
  readonly requiresExplicitUserChoice: boolean;
  readonly conflictCandidates?: {
    readonly currentRevision: number;
    readonly recoveryRevision: number;
    readonly currentUpdatedAtMs: number;
    readonly recoveryUpdatedAtMs: number;
  };
}

export interface RecoveryRecordStore {
  write(key: string, json: string): Promise<void>;
  read(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

/**
 * Crash-Safe Project & Job Recovery Coordinator (AVP-P10-001 Section 7)
 * - Integrity-checks every recovery record with SHA-256.
 * - Strictly separates committed states from incomplete/untrusted temporary writes.
 * - Never overwrites a newer valid project with an older recovery snapshot.
 * - Preserves both candidates and requires explicit user decision when ambiguous.
 */
export class CrashSafeRecoveryCoordinator {
  private readonly store: RecoveryRecordStore;
  private readonly staleSessionThresholdMs: number;

  constructor(store: RecoveryRecordStore, staleSessionThresholdMs = 30_000) {
    this.store = store;
    this.staleSessionThresholdMs = Math.max(1_000, staleSessionThresholdMs);
  }

  public async writeRecoveryRecord<TPayload>(params: {
    readonly recordId: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly category: RecoveryArtifactCategory;
    readonly committed: boolean;
    readonly revisionNumber: number;
    readonly updatedAtMs?: number;
    readonly payload: TPayload;
  }): Promise<VersionedRecoveryRecord<TPayload>> {
    const payloadJson = JSON.stringify(params.payload);
    const payloadSha256 = await computeSha256Hex(new TextEncoder().encode(payloadJson));
    const record: VersionedRecoveryRecord<TPayload> = {
      schemaVersion: RECOVERY_RECORD_SCHEMA_VERSION,
      recordId: params.recordId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      category: params.category,
      committed: params.committed,
      revisionNumber: params.revisionNumber,
      updatedAtMs: params.updatedAtMs ?? Date.now(),
      payload: params.payload,
      payloadSha256,
    };

    try {
      await this.store.write(this.buildKey(params.projectId, params.category), JSON.stringify(record));
      return record;
    } catch (err) {
      throw new AvapardazError({
        code: 'RECOVERY_FAILED',
        subsystem: 'RECOVERY_ENGINE',
        technicalMessage: `Failed to write recovery record for ${params.projectId}/${params.category}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  public async verifyAndReadRecord<TPayload>(
    projectId: string,
    category: RecoveryArtifactCategory,
  ): Promise<{
    readonly valid: boolean;
    readonly record: VersionedRecoveryRecord<TPayload> | null;
    readonly errorReason?: string;
  }> {
    const raw = await this.store.read(this.buildKey(projectId, category));
    if (!raw) {
      return { valid: true, record: null };
    }

    try {
      const parsed = JSON.parse(raw) as VersionedRecoveryRecord<TPayload>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.schemaVersion !== RECOVERY_RECORD_SCHEMA_VERSION ||
        parsed.projectId !== projectId ||
        typeof parsed.payloadSha256 !== 'string'
      ) {
        return { valid: false, record: null, errorReason: 'INVALID_RECOVERY_SCHEMA' };
      }

      const computedHash = await computeSha256Hex(new TextEncoder().encode(JSON.stringify(parsed.payload)));
      if (computedHash !== parsed.payloadSha256) {
        return { valid: false, record: null, errorReason: 'RECOVERY_CHECKSUM_MISMATCH' };
      }

      return { valid: true, record: parsed };
    } catch {
      return { valid: false, record: null, errorReason: 'RECOVERY_JSON_CORRUPTED' };
    }
  }

  public isSessionStale(lastHeartbeatMs: number, nowMs: number = Date.now()): boolean {
    return nowMs - lastHeartbeatMs > this.staleSessionThresholdMs;
  }

  /**
   * Evaluates whether a stored recovery record is safe to offer for restoration,
   * never restoring incomplete transactions as committed and never overwriting newer valid state.
   */
  public async evaluateRecovery<TPayload>(params: {
    readonly projectId: string;
    readonly category: RecoveryArtifactCategory;
    readonly currentRevisionNumber: number;
    readonly currentUpdatedAtMs: number;
    readonly currentHasUnsavedUserEdits?: boolean;
  }): Promise<RecoveryEvaluationResult<TPayload>> {
    const check = await this.verifyAndReadRecord<TPayload>(params.projectId, params.category);

    if (!check.valid) {
      return {
        outcome: 'REJECTED_CORRUPT_OR_INCOMPLETE',
        reasonFa: 'رکورد بازیابی تأیید اصالت (SHA-256) را نگذراند و نادیده گرفته شد؛ وضعیت فعلی ایمن است.',
        reasonEn: `Recovery record failed integrity verification (${check.errorReason}) and was rejected.`,
        integrityVerified: false,
        candidateRecord: null,
        currentPreserved: true,
        requiresExplicitUserChoice: false,
      };
    }

    if (!check.record) {
      return {
        outcome: 'NO_RECOVERY_NEEDED',
        reasonFa: 'رکورد بازیابی معوقی برای این پروژه وجود ندارد.',
        reasonEn: 'No pending recovery record found.',
        integrityVerified: true,
        candidateRecord: null,
        currentPreserved: true,
        requiresExplicitUserChoice: false,
      };
    }

    // Rule: Never restore an incomplete/uncommitted transaction or temporary artifact as committed
    if (!check.record.committed || check.record.category === 'INCOMPLETE_TEMP_ARTIFACT') {
      return {
        outcome: 'REJECTED_CORRUPT_OR_INCOMPLETE',
        reasonFa: 'نوشتن ناتمام یا تراکنش ثبت‌نشده شناسایی شد و هرگز به‌عنوان وضعیت ثبت‌شده بازیابی نمی‌شود.',
        reasonEn: 'Incomplete or uncommitted write detected; refused to restore as committed state.',
        integrityVerified: true,
        candidateRecord: check.record,
        currentPreserved: true,
        requiresExplicitUserChoice: false,
      };
    }

    // Rule: Never overwrite a newer valid project with an older recovery snapshot
    if (
      check.record.revisionNumber < params.currentRevisionNumber ||
      (check.record.revisionNumber === params.currentRevisionNumber &&
        check.record.updatedAtMs <= params.currentUpdatedAtMs)
    ) {
      return {
        outcome: 'KEEP_NEWER_CURRENT_STATE',
        reasonFa: 'نسخه فعلی پروژه جدیدتر از نقطه بازگشت ذخیره‌شده است؛ بازنویسی خودکار متوقف شد.',
        reasonEn: 'Current valid project state is newer than the recovery record; preserved current state.',
        integrityVerified: true,
        candidateRecord: check.record,
        currentPreserved: true,
        requiresExplicitUserChoice: false,
      };
    }

    // Rule: If current session has unsaved user edits or timestamps/revisions diverge ambiguously,
    // preserve both candidates and require an explicit user choice.
    if (
      params.currentHasUnsavedUserEdits ||
      (check.record.revisionNumber > params.currentRevisionNumber &&
        check.record.updatedAtMs < params.currentUpdatedAtMs)
    ) {
      return {
        outcome: 'REQUIRES_USER_DECISION',
        reasonFa: 'تعارض بین وضعیت فعلی و نقطه بازگشت وجود دارد؛ هر دو نسخه حفظ شده‌اند و انتخاب کاربر لازم است.',
        reasonEn: 'Ambiguous recovery conflict detected; both states preserved for explicit user choice.',
        integrityVerified: true,
        candidateRecord: check.record,
        currentPreserved: true,
        requiresExplicitUserChoice: true,
        conflictCandidates: {
          currentRevision: params.currentRevisionNumber,
          recoveryRevision: check.record.revisionNumber,
          currentUpdatedAtMs: params.currentUpdatedAtMs,
          recoveryUpdatedAtMs: check.record.updatedAtMs,
        },
      };
    }

    return {
      outcome: 'SAFE_RESTORE_CANDIDATE',
      reasonFa: 'نقطه بازگشت معتبر و تأییدشده (SHA-256) آماده بازیابی ایمن است.',
      reasonEn: 'Verified committed recovery checkpoint is available for safe restoration.',
      integrityVerified: true,
      candidateRecord: check.record,
      currentPreserved: true,
      requiresExplicitUserChoice: true,
    };
  }

  public async clearRecord(projectId: string, category: RecoveryArtifactCategory): Promise<void> {
    await this.store.remove(this.buildKey(projectId, category));
  }

  private buildKey(projectId: string, category: RecoveryArtifactCategory): string {
    return `recovery:${projectId}:${category}`;
  }
}
