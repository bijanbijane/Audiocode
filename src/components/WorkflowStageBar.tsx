import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Cpu,
  Database,
  Download,
  FlaskConical,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sliders,
  Sun,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { StudioWorkflowState, WorkflowLocale } from '../workflow/StudioWorkflowController';
import { UserFacingFailureModel } from '../reliability';
import type { CompanionHealthResponse } from '../host-bridge/companion/CompanionWebClient';

export interface AdvancedLabActions {
  readonly onOpenAsrLab: () => void;
  readonly onOpenDevPortal: () => void;
  readonly onOpenSpeechIntel: () => void;
  readonly onOpenDataFactory: () => void;
  readonly onOpenModelFactory: () => void;
  readonly onOpenSpeechSecurity: () => void;
}

interface WorkflowStageBarProps {
  workflowState: StudioWorkflowState;
  executionMode: 'LOCAL' | 'CLOUD';
  cloudProviderStatusLabel: string;
  cloudAsrConfigured?: boolean;
  companionHealth?: CompanionHealthResponse | null;
  onRunCloudGeminiAsr?: () => void;
  onChangeExecutionMode: (nextMode: 'LOCAL' | 'CLOUD') => void;
  activeFailure: UserFacingFailureModel | null;
  canInstallPwa: boolean;
  onTriggerInstallPwa: () => void;
  onDismissFailure: () => void;
  onRetryFailure?: () => void;
  onRecoverFailure?: () => void;
  onImportAudioClick: () => void;
  onOpenLifecycleModal: (
    initialTab?: 'model' | 'offline' | 'health' | 'backup' | 'storage' | 'diagnostics',
  ) => void;
  onToggleTheme: () => void;
  onToggleLocale: (next: WorkflowLocale) => void;
  advancedLabs: AdvancedLabActions;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function asrLabel(
  state: StudioWorkflowState['asrState'],
  locale: WorkflowLocale,
  companionHealth?: CompanionHealthResponse | null,
): string {
  const isFa = locale === 'fa';
  switch (state) {
    case 'MODEL_NOT_INSTALLED':
      return isFa ? 'مدل محلی نصب نشده' : 'Local ASR Not Installed';
    case 'MODEL_AVAILABLE':
      return isFa ? 'مدل محلی ذخیره و تأیید شد (در انتظار اجرا)' : 'Local Model Verified (OPFS)';
    case 'MODEL_INTEGRITY_FAILURE':
      return isFa ? 'خطای اصالت مدل' : 'Model Integrity Failure';
    case 'RUNTIME_UNAVAILABLE':
      return isFa ? 'موتور WASM/ORT ناموجود' : 'Runtime Unavailable';
    case 'MODEL_LOADING':
      return isFa ? 'بارگذاری مدل محلی...' : 'Loading Local Model...';
    case 'MODEL_READY':
      if (companionHealth?.runtime?.available) {
        return isFa
          ? 'موتور بومی شهاب/شناوا آماده'
          : 'Native Engine Ready (Shenava-Rizeh)';
      }
      return isFa ? 'مدل محلی آماده' : 'Local Model Ready';
    case 'INFERENCE_RUNNING':
      return isFa ? 'در حال رونویسی محلی...' : 'Running Local ASR...';
    case 'INFERENCE_FAILED':
      return isFa ? 'خطای رونویسی محلی' : 'Local ASR Failed';
    case 'NO_SPEECH_DETECTED':
      return isFa ? 'گفتاری شناسایی نشد' : 'No Speech Detected';
    case 'TRANSCRIPTION_COMPLETED':
      return isFa ? 'رونویسی تکمیل شد' : 'Transcription Completed';
    case 'TRANSCRIPTION_CANCELLED':
      return isFa ? 'رونویسی لغو شد' : 'Transcription Cancelled';
  }
}

export const WorkflowStageBar: React.FC<WorkflowStageBarProps> = ({
  workflowState,
  executionMode,
  cloudProviderStatusLabel,
  cloudAsrConfigured = false,
  companionHealth = null,
  onRunCloudGeminiAsr,
  onChangeExecutionMode,
  activeFailure,
  canInstallPwa,
  onTriggerInstallPwa,
  onDismissFailure,
  onRetryFailure,
  onRecoverFailure,
  onImportAudioClick,
  onOpenLifecycleModal,
  onToggleTheme,
  onToggleLocale,
  advancedLabs,
}) => {
  const [labsOpen, setLabsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const isFa = workflowState.locale === 'fa';

  useEffect(() => {
    if (!labsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setLabsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLabsOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [labsOpen]);

  const memUsed = formatMb(workflowState.memoryAccountedBytes);
  const memLimit = formatMb(workflowState.memoryHardLimitBytes);

  return (
    <div className="space-y-3">
      <section
        aria-label={isFa ? 'نوار وضعیت محلی و چرخه عمر استودیو' : 'Local Studio Status & Lifecycle Bar'}
        className="border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs"
      >
        {/* Left / Start: Honest local/cloud mode + runtime facts separated by hairlines */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-slate-600 dark:text-slate-300">
          {/* Explicit Unified Processing Mode Selector (LOCAL default, CLOUD opt-in) */}
          <div
            role="group"
            aria-label={isFa ? 'انتخاب مسیر اجرای پردازش' : 'Processing execution mode'}
            className="inline-flex items-center rounded border border-slate-300 dark:border-[#252F42] overflow-hidden"
          >
            <button
              type="button"
              data-testid="btn-mode-local"
              aria-pressed={executionMode === 'LOCAL'}
              onClick={() => onChangeExecutionMode('LOCAL')}
              className={`px-2 py-1 text-[11px] font-semibold whitespace-nowrap cursor-pointer ${
                executionMode === 'LOCAL'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-50 dark:bg-[#0E131D] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {isFa ? 'محلی (پیش‌فرض)' : 'LOCAL (Default)'}
            </button>
            <button
              type="button"
              data-testid="btn-mode-cloud"
              aria-pressed={executionMode === 'CLOUD'}
              onClick={() => onChangeExecutionMode('CLOUD')}
              className={`px-2 py-1 text-[11px] font-semibold whitespace-nowrap cursor-pointer ${
                executionMode === 'CLOUD'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-50 dark:bg-[#0E131D] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {isFa ? 'ابری (اختیاری)' : 'CLOUD (Opt-In)'}
            </button>
          </div>

          <span className="h-3.5 w-px bg-slate-300 dark:bg-[#252F42]" aria-hidden="true" />

          <button
            type="button"
            onClick={() => onOpenLifecycleModal('model')}
            className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300 hover:text-amber-600 dark:hover:text-amber-300 transition-colors cursor-pointer"
            data-testid="btn-asr-status-inspect"
          >
            <Cpu className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" aria-hidden="true" />
            <span>
              {executionMode === 'LOCAL'
                ? asrLabel(workflowState.asrState, workflowState.locale, companionHealth)
                : cloudProviderStatusLabel}
            </span>
          </button>

          <span className="h-3.5 w-px bg-slate-300 dark:bg-[#252F42]" aria-hidden="true" />

          <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
            <HardDrive className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" aria-hidden="true" />
            <span>
              {workflowState.persistenceState === 'PERSISTED_LOCAL'
                ? isFa
                  ? 'ذخیره محلی فعال'
                  : 'Local Persistence Active'
                : isFa
                  ? 'حافظه محلی نشست'
                  : 'Local Session Memory'}
            </span>
          </div>

          <span className="h-3.5 w-px bg-slate-300 dark:bg-[#252F42]" aria-hidden="true" />

          <div
            className="flex items-center gap-1.5 font-mono tabular-nums text-slate-600 dark:text-slate-400"
            dir="ltr"
            title={isFa ? 'بودجه حافظه صوتی محلی (سقف ۱ GiB)' : 'Local audio memory budget (1 GiB cap)'}
          >
            <span>
              {memUsed} / {memLimit}
            </span>
            <span className="text-[11px] uppercase">({workflowState.memoryPressure})</span>
          </div>
        </div>

        {/* Right / End: Compact high-craft studio controls */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onImportAudioClick}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] whitespace-nowrap cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{isFa ? 'ورود صوت' : 'Import Audio'}</span>
          </button>

          <button
            type="button"
            data-testid="btn-open-lifecycle-modal"
            onClick={() => onOpenLifecycleModal('health')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] whitespace-nowrap cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>{isFa ? 'مدیریت محصول و سلامت' : 'Product & Health'}</span>
          </button>

          {canInstallPwa && (
            <button
              type="button"
              onClick={onTriggerInstallPwa}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200 hover:bg-amber-500/20 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'نصب برنامه آفلاین' : 'Install Offline App'}</span>
            </button>
          )}

          {/* Progressive Disclosure Menu for Advanced Engineering & Research Modals */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              data-testid="btn-advanced-labs-menu"
              aria-expanded={labsOpen}
              aria-haspopup="menu"
              onClick={() => setLabsOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] whitespace-nowrap cursor-pointer"
            >
              <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'ابزارهای پیشرفته' : 'Advanced Labs'}</span>
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            {labsOpen && (
              <div
                role="menu"
                className="absolute z-40 mt-1.5 w-60 end-0 rounded-md border border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#131924] shadow-xl py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="btn-toggle-asr-lab"
                  onClick={() => {
                    setLabsOpen(false);
                    advancedLabs.onOpenAsrLab();
                  }}
                  className="w-full px-3 py-2 text-start flex items-center gap-2 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <FlaskConical className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
                  <span>{isFa ? 'آزمایشگاه تحقیق و مدل ASR' : 'ASR Research Lab'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="btn-toggle-speech-intel"
                  onClick={() => {
                    setLabsOpen(false);
                    advancedLabs.onOpenSpeechIntel();
                  }}
                  className="w-full px-3 py-2 text-start flex items-center gap-2 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                  <span>{isFa ? 'هوشمندی گفتار' : 'Speech Intelligence'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="btn-toggle-data-factory"
                  onClick={() => {
                    setLabsOpen(false);
                    advancedLabs.onOpenDataFactory();
                  }}
                  className="w-full px-3 py-2 text-start flex items-center gap-2 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <Database className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />
                  <span>{isFa ? 'کارخانه داده فارسی' : 'Persian Data Factory'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="btn-toggle-model-factory"
                  onClick={() => {
                    setLabsOpen(false);
                    advancedLabs.onOpenModelFactory();
                  }}
                  className="w-full px-3 py-2 text-start flex items-center gap-2 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5 text-violet-500" aria-hidden="true" />
                  <span>{isFa ? 'کارخانه مدل و MLOps' : 'Model Factory & MLOps'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="btn-toggle-speech-security"
                  onClick={() => {
                    setLabsOpen(false);
                    advancedLabs.onOpenSpeechSecurity();
                  }}
                  className="w-full px-3 py-2 text-start flex items-center gap-2 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-rose-500" aria-hidden="true" />
                  <span>{isFa ? 'امنیت و مقاومت گفتار' : 'Speech Security'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="btn-toggle-dev-portal"
                  onClick={() => {
                    setLabsOpen(false);
                    advancedLabs.onOpenDevPortal();
                  }}
                  className="w-full px-3 py-2 text-start flex items-center gap-2 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
                >
                  <Terminal className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
                  <span>{isFa ? 'پورتال API و قراردادها' : 'API & Contracts Portal'}</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            data-testid="btn-toggle-locale"
            onClick={() => onToggleLocale(isFa ? 'en' : 'fa')}
            aria-label={isFa ? 'تغییر زبان به انگلیسی' : 'Switch language to Persian'}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] whitespace-nowrap cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="font-mono">{isFa ? 'EN' : 'FA'}</span>
          </button>

          <button
            type="button"
            data-testid="btn-toggle-theme"
            onClick={onToggleTheme}
            aria-label={
              workflowState.theme === 'dark'
                ? isFa
                  ? 'تغییر به تم روشن'
                  : 'Switch to light theme'
                : isFa
                  ? 'تغییر به تم تیره'
                  : 'Switch to dark theme'
            }
            className="p-1.5 rounded-md border border-slate-300 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
          >
            {workflowState.theme === 'dark' ? (
              <Sun className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-slate-700" aria-hidden="true" />
            )}
          </button>
        </div>
      </section>

      {/* P10 Honest User-Facing Failure Banner (plain Persian, original-data safety, real actions only) */}
      {activeFailure && (
        <div
          role="alert"
          data-testid="reliability-failure-banner"
          className="rounded-lg border border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-xs space-y-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1">
                <div className="font-semibold text-rose-900 dark:text-rose-100">
                  {activeFailure.title}
                </div>
                <p className="text-rose-800 dark:text-rose-200 leading-relaxed">
                  {activeFailure.explanation}
                </p>
                <p className="text-emerald-800 dark:text-emerald-300 font-medium">
                  {activeFailure.originalDataStatus}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onDismissFailure}
              aria-label={isFa ? 'بستن اعلان خطا' : 'Dismiss error notice'}
              className="p-1 text-rose-700 dark:text-rose-300 hover:text-rose-950 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 ps-6">
            {activeFailure.code === 'MODEL_NOT_INSTALLED' &&
              cloudAsrConfigured &&
              onRunCloudGeminiAsr && (
                <button
                  type="button"
                  data-testid="btn-banner-cloud-gemini-asr"
                  onClick={onRunCloudGeminiAsr}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500 text-slate-950 font-semibold hover:bg-emerald-400 cursor-pointer"
                >
                  <span>
                    {isFa
                      ? 'تشخیص واقعی کلمات با Gemini ASR (انتقال صریح به ابری)'
                      : 'Transcribe Real Words via Gemini ASR (Opt-In Cloud)'}
                  </span>
                </button>
              )}
            {activeFailure.canRetry && onRetryFailure && (
              <button
                type="button"
                onClick={onRetryFailure}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isFa ? 'تلاش مجدد' : 'Retry'}</span>
              </button>
            )}
            {activeFailure.recoveryAction && onRecoverFailure && (
              <button
                type="button"
                onClick={onRecoverFailure}
                className="px-3 py-1.5 rounded border border-rose-400/50 text-rose-900 dark:text-rose-100 hover:bg-rose-500/15 cursor-pointer"
              >
                {isFa ? activeFailure.recoveryAction.labelFa : activeFailure.recoveryAction.labelEn}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenLifecycleModal('diagnostics')}
              className="px-3 py-1.5 rounded border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              {isFa ? 'مشاهده گزارش عیب‌یابی محلی' : 'View Local Diagnostics'}
            </button>
            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 ms-auto" dir="ltr">
              {activeFailure.code}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
