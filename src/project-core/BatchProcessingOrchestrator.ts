import { ProjectDocument } from '../contracts/project-schema.contract';
import { ExportValidationReport, RenderManifest } from '../processing-core/ExportValidator';

export type BatchItemStatus =
  | 'QUEUED'
  | 'INGESTING_AND_DIAGNOSING'
  | 'RUNNING_PERSIAN_AI_ANALYSIS'
  | 'AWAITING_USER_REVIEW'       // Golden Rule 27: AI suggestions wait for explicit user approval
  | 'RENDERING_MASTER_OUTPUT'
  | 'COMPLETED_VALIDATED'
  | 'FAILED_ISOLATED';           // Failure of a single file must never abort remaining batch items

export interface BatchQueueItem {
  readonly itemId: string;
  readonly sourceFileName: string;
  readonly fileByteSize: number;
  readonly status: BatchItemStatus;
  readonly progressPercent: number;
  readonly generatedProject?: ProjectDocument;
  readonly pendingRecommendationsCount?: number;
  readonly exportReport?: ExportValidationReport;
  readonly renderManifest?: RenderManifest;
  readonly errorMessageFa?: string;
}

/**
 * Bounded-Memory Studio Batch Processing Orchestrator (Sections 12, 29 & Golden Rule 27)
 * Stage 1 runs ingest + diagnostics + Persian ASR/alignment/disfluency analysis across queued files,
 * staging PENDING recommendations in AWAITING_USER_REVIEW projects while purging transient PCM caches
 * between every file so memory stays bounded to ~1 active audio file.
 * Stage 2 renders & validates only user-reviewed/approved projects (-16 LUFS / True-Peak).
 */
export class BatchProcessingOrchestrator {
  private items: BatchQueueItem[] = [];
  private isAborted = false;
  private isRunning = false;

  public enqueueFiles(
    files: readonly { id: string; fileName: string; byteSize: number }[],
  ): BatchQueueItem[] {
    const newItems: BatchQueueItem[] = files.map((f) => ({
      itemId: f.id,
      sourceFileName: f.fileName,
      fileByteSize: f.byteSize,
      status: 'QUEUED',
      progressPercent: 0,
    }));
    this.items.push(...newItems);
    return [...this.items];
  }

  public getItemsSnapshot(): BatchQueueItem[] {
    return [...this.items];
  }

  public abortBatch(): void {
    this.isAborted = true;
  }

  /**
   * Stage 1: Sequential AI analysis & staging for user review with bounded cache purge between files.
   */
  public async runBatchPreAnalysisStage(params: {
    analyzeSingleFileToStagedProject: (
      item: BatchQueueItem,
      onProgress: (pct: number) => void,
    ) => Promise<ProjectDocument>;
    purgeTemporaryPcmCacheBetweenFiles: () => Promise<void>;
    onQueueUpdated: (snapshot: BatchQueueItem[]) => void;
  }): Promise<BatchQueueItem[]> {
    if (this.isRunning) {
      throw new Error('BATCH_ALREADY_RUNNING: عملیات دسته‌ای دیگری در حال اجرا است.');
    }

    this.isRunning = true;
    this.isAborted = false;

    try {
      for (let i = 0; i < this.items.length; i++) {
        if (this.isAborted) break;
        const item = this.items[i];
        if (item.status !== 'QUEUED') continue;

        this.updateItem(i, { status: 'INGESTING_AND_DIAGNOSING', progressPercent: 10 });
        params.onQueueUpdated([...this.items]);

        try {
          this.updateItem(i, { status: 'RUNNING_PERSIAN_AI_ANALYSIS', progressPercent: 25 });
          params.onQueueUpdated([...this.items]);

          const stagedProject = await params.analyzeSingleFileToStagedProject(
            this.items[i],
            (pct) => {
              const boundedPct = Math.max(0, Math.min(100, pct));
              this.updateItem(i, {
                progressPercent: Math.min(95, 25 + Math.round(boundedPct * 0.7)),
              });
              params.onQueueUpdated([...this.items]);
            },
          );

          const pendingCount = stagedProject.recommendations.filter(
            (r) => r.status === 'PENDING',
          ).length;

          // Golden Rule 27: Stop in AWAITING_USER_REVIEW with pending recommendations intact
          this.updateItem(i, {
            status: 'AWAITING_USER_REVIEW',
            progressPercent: 100,
            generatedProject: stagedProject,
            pendingRecommendationsCount: pendingCount,
          });
        } catch (err) {
          // Fault isolation (Section 41): Keep failing file isolated while batch continues
          this.updateItem(i, {
            status: 'FAILED_ISOLATED',
            errorMessageFa:
              err instanceof Error
                ? err.message
                : 'خطا در تحلیل فایل؛ سایر فایل‌های صف بدون توقف ادامه می‌یابند.',
          });
        } finally {
          try {
            await params.purgeTemporaryPcmCacheBetweenFiles();
          } catch {
            // Do not abort queue if transient cache cleanup raises on an already-released handle
          }
          params.onQueueUpdated([...this.items]);
        }
      }

      return [...this.items];
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Stage 2: Render & Export Validation (-16 LUFS / True-Peak) for user-reviewed projects.
   */
  public async runBatchApprovedExportStage(params: {
    renderAndValidateProject: (project: ProjectDocument) => Promise<{
      validationReport: ExportValidationReport;
      manifest: RenderManifest;
    }>;
    purgeTemporaryPcmCacheBetweenFiles: () => Promise<void>;
    onQueueUpdated: (snapshot: BatchQueueItem[]) => void;
    updateReviewedProject?: (itemId: string, updatedProject: ProjectDocument) => void;
  }): Promise<BatchQueueItem[]> {
    if (this.isRunning) {
      throw new Error('BATCH_ALREADY_RUNNING: عملیات دسته‌ای دیگری در حال اجرا است.');
    }

    this.isRunning = true;
    this.isAborted = false;

    try {
      for (let i = 0; i < this.items.length; i++) {
        if (this.isAborted) break;
        const item = this.items[i];
        if (item.status !== 'AWAITING_USER_REVIEW' || !item.generatedProject) continue;

        this.updateItem(i, { status: 'RENDERING_MASTER_OUTPUT', progressPercent: 50 });
        params.onQueueUpdated([...this.items]);

        try {
          const { validationReport, manifest } = await params.renderAndValidateProject(
            item.generatedProject,
          );

          if (!validationReport.passed) {
            this.updateItem(i, {
              status: 'FAILED_ISOLATED',
              exportReport: validationReport,
              errorMessageFa: `خروجی از دروازه اعتبارسنجی عبور نکرد: ${validationReport.errors.join(' | ')}`,
            });
          } else {
            this.updateItem(i, {
              status: 'COMPLETED_VALIDATED',
              progressPercent: 100,
              exportReport: validationReport,
              renderManifest: manifest,
            });
          }
        } catch (err) {
          this.updateItem(i, {
            status: 'FAILED_ISOLATED',
            errorMessageFa: err instanceof Error ? err.message : 'خطا در رندر خروجی فایل.',
          });
        } finally {
          try {
            await params.purgeTemporaryPcmCacheBetweenFiles();
          } catch {
            // Keep remaining batch items progressing cleanly
          }
          params.onQueueUpdated([...this.items]);
        }
      }

      return [...this.items];
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Applies user-reviewed edits back into a staged queue item before Stage 2 export.
   */
  public commitUserReviewedProject(itemId: string, reviewedProject: ProjectDocument): boolean {
    const idx = this.items.findIndex((it) => it.itemId === itemId);
    if (idx === -1) return false;
    const pendingCount = reviewedProject.recommendations.filter(
      (r) => r.status === 'PENDING',
    ).length;
    this.updateItem(idx, {
      generatedProject: reviewedProject,
      pendingRecommendationsCount: pendingCount,
    });
    return true;
  }

  private updateItem(index: number, patch: Partial<BatchQueueItem>): void {
    this.items[index] = { ...this.items[index], ...patch };
  }
}
