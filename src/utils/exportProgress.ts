import { RenderLifecycleState } from '../audio-renderer/AudioRenderTypes';

export type ExportUiLifecycleState = RenderLifecycleState | 'IDLE';

export type ExportStatusTone =
  | 'idle'
  | 'active'
  | 'paused'
  | 'success'
  | 'error'
  | 'cancelled';

export interface ExportStatusPresentation {
  readonly state: ExportUiLifecycleState;
  readonly tone: ExportStatusTone;
  readonly labelFa: string;
  readonly labelEn: string;
  readonly detailFa: string;
  readonly detailEn: string;
  /** 0 = idle, 1 = prepare/validate, 2 = render, 3 = finalize/verify, 4 = done */
  readonly stageIndex: 0 | 1 | 2 | 3 | 4;
  readonly isActive: boolean;
  readonly isPaused: boolean;
  readonly isCompleted: boolean;
  readonly isFailed: boolean;
  readonly isCancelled: boolean;
  readonly percent: number;
}

export function clampExportPercent(value: number | null | undefined, fallback = 0): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export function isActiveExportState(state: ExportUiLifecycleState): boolean {
  return (
    state === 'QUEUED' ||
    state === 'VALIDATING' ||
    state === 'PLANNING' ||
    state === 'RENDERING' ||
    state === 'FINALIZING' ||
    state === 'VALIDATING_OUTPUT'
  );
}

export function resolveExportStatusPresentation(params: {
  state: ExportUiLifecycleState;
  progressPercent?: number | null;
  currentOperation?: string | null;
  errorMessage?: string | null;
}): ExportStatusPresentation {
  const { state, progressPercent, currentOperation, errorMessage } = params;
  const op = currentOperation?.trim() || '';
  const err = errorMessage?.trim() || '';

  switch (state) {
    case 'IDLE':
      return {
        state,
        tone: 'idle',
        labelFa: 'آماده شروع خروجی',
        labelEn: 'Ready to Export',
        detailFa: 'تنظیمات خروجی را بررسی کنید و دکمه شروع رندر را بزنید.',
        detailEn: 'Review export settings and start rendering when ready.',
        stageIndex: 0,
        isActive: false,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: 0,
      };

    case 'QUEUED':
      return {
        state,
        tone: 'active',
        labelFa: 'در صف آماده‌سازی',
        labelEn: 'Queued',
        detailFa: op || 'در حال آماده‌سازی صف رندر غیرمخرب...',
        detailEn: op || 'Preparing non-destructive render queue...',
        stageIndex: 1,
        isActive: true,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 4),
      };

    case 'VALIDATING':
      return {
        state,
        tone: 'active',
        labelFa: 'اعتبارسنجی ورودی‌ها',
        labelEn: 'Validating Inputs',
        detailFa: op || 'بررسی سلامت فایل‌های صوتی و لیست برش‌ها (EDL)...',
        detailEn: op || 'Validating source audio tracks and edit list...',
        stageIndex: 1,
        isActive: true,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 10),
      };

    case 'PLANNING':
      return {
        state,
        tone: 'active',
        labelFa: 'برنامه‌ریزی برش و گذار',
        labelEn: 'Planning Splices',
        detailFa: op || 'محاسبه نقاط برش و طول Crossfade...',
        detailEn: op || 'Computing splice boundaries and crossfade ramps...',
        stageIndex: 1,
        isActive: true,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 18),
      };

    case 'RENDERING':
      return {
        state,
        tone: 'active',
        labelFa: 'در حال رندر صوت',
        labelEn: 'Rendering Audio',
        detailFa: op || 'پردازش جریانی ترک‌ها و اعمال برش‌ها...',
        detailEn: op || 'Streaming audio tracks and applying approved edits...',
        stageIndex: 2,
        isActive: true,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 45),
      };

    case 'FINALIZING':
      return {
        state,
        tone: 'active',
        labelFa: 'نهایی‌سازی فایل',
        labelEn: 'Finalizing File',
        detailFa: op || 'بستن هدر کانتینر صوتی و نوشتن بافر نهایی...',
        detailEn: op || 'Writing final container headers and flushing buffers...',
        stageIndex: 3,
        isActive: true,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 88),
      };

    case 'VALIDATING_OUTPUT':
      return {
        state,
        tone: 'active',
        labelFa: 'اعتبارسنجی خروجی نهایی',
        labelEn: 'Validating Output',
        detailFa: op || 'بررسی پیک صدا (True-Peak)، کلیپینگ و سلامت فایل...',
        detailEn: op || 'Verifying True-Peak headroom, clipping, and integrity...',
        stageIndex: 3,
        isActive: true,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 95),
      };

    case 'COMPLETED':
      return {
        state,
        tone: 'success',
        labelFa: 'تکمیل‌شده و آماده دانلود',
        labelEn: 'Completed & Ready',
        detailFa: op || 'فایل صوتی نهایی با موفقیت ساخته و اعتبارسنجی شد.',
        detailEn: op || 'Final audio rendered and validated successfully.',
        stageIndex: 4,
        isActive: false,
        isPaused: false,
        isCompleted: true,
        isFailed: false,
        isCancelled: false,
        percent: 100,
      };

    case 'PAUSED_USER':
      return {
        state,
        tone: 'paused',
        labelFa: 'متوقف‌شده توسط کاربر',
        labelEn: 'Paused by User',
        detailFa: op || 'فرآیند خروجی متوقف شده و قابل ادامه است.',
        detailEn: op || 'Export paused and ready to resume.',
        stageIndex: 2,
        isActive: false,
        isPaused: true,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 0),
      };

    case 'PAUSED_MEMORY_PRESSURE':
      return {
        state,
        tone: 'paused',
        labelFa: 'مکث به‌دلیل محدودیت حافظه',
        labelEn: 'Paused (Memory)',
        detailFa: op || 'رندر برای مدیریت حافظه متوقف شد.',
        detailEn: op || 'Paused temporarily due to memory pressure.',
        stageIndex: 2,
        isActive: false,
        isPaused: true,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 0),
      };

    case 'RECOVERABLE':
      return {
        state,
        tone: 'paused',
        labelFa: 'قابل ادامه از نقطه بازیابی',
        labelEn: 'Recoverable Checkpoint',
        detailFa: op || 'یک نقطه بازیابی معتبر برای ادامه رندر موجود است.',
        detailEn: op || 'A verified checkpoint is available to resume rendering.',
        stageIndex: 2,
        isActive: false,
        isPaused: true,
        isCompleted: false,
        isFailed: false,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 0),
      };

    case 'CANCELLED':
      return {
        state,
        tone: 'cancelled',
        labelFa: 'لغو شده',
        labelEn: 'Cancelled',
        detailFa: op || 'عملیات خروجی لغو شد؛ فایل اصلی بدون تغییر باقی ماند.',
        detailEn: op || 'Export cancelled; source audio remains untouched.',
        stageIndex: 0,
        isActive: false,
        isPaused: false,
        isCompleted: false,
        isFailed: false,
        isCancelled: true,
        percent: clampExportPercent(progressPercent, 0),
      };

    case 'FAILED':
    case 'FAILED_VALIDATION':
    default:
      return {
        state,
        tone: 'error',
        labelFa: state === 'FAILED_VALIDATION' ? 'خطای اعتبارسنجی خروجی' : 'خطا در ساخت خروجی',
        labelEn: state === 'FAILED_VALIDATION' ? 'Validation Failed' : 'Export Failed',
        detailFa: err || op || 'خطایی هنگام تولید فایل خروجی رخ داد. دوباره تلاش کنید.',
        detailEn: err || op || 'An error occurred while rendering audio. Please retry.',
        stageIndex: 0,
        isActive: false,
        isPaused: false,
        isCompleted: false,
        isFailed: true,
        isCancelled: false,
        percent: clampExportPercent(progressPercent, 0),
      };
  }
}

export function formatExportElapsed(elapsedMs: number | null | undefined, isFa: boolean): string | null {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }
  const totalSec = elapsedMs / 1000;
  if (totalSec < 60) {
    return isFa ? `${totalSec.toFixed(1)} ثانیه` : `${totalSec.toFixed(1)}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const remSec = Math.round(totalSec % 60);
  return isFa
    ? `${mins} دقیقه و ${remSec} ثانیه`
    : `${mins}m ${String(remSec).padStart(2, '0')}s`;
}
