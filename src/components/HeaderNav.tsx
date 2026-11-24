import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FlaskConical,
  FolderOpen,
  Moon,
  MoreVertical,
  Redo2,
  Settings,
  ShieldCheck,
  Sun,
  Undo2,
  Upload,
} from 'lucide-react';
import type { WorkflowLocale } from '../workflow/StudioWorkflowController';
import type { StudioWorkflowStepId } from './WorkflowStageBar';
import { GlobalAppBar } from './GlobalAppBar';
import { OfflineIndicator, PWAInstallButton } from '../ui/pwa/PWAInstallControls';
import { formatNumberForLocale } from '../utils/formatters';

export type WorkspaceTab = 'studio' | 'graph' | 'storage' | 'shahab';
export type ProjectSaveStatus = 'saved' | 'saving' | 'sample' | 'error';

export interface HeaderWorkflowStepItem {
  id: StudioWorkflowStepId;
  num: string;
  label: string;
  done: boolean;
}

interface HeaderNavProps {
  projectTitle: string;
  sampleRate?: number;
  trackCount?: number;
  wordCount?: number;
  saveStatus: ProjectSaveStatus;
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onBackToProjects: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onOpenLifecycleModal: (
    initialTab?: 'model' | 'offline' | 'health' | 'backup' | 'storage' | 'diagnostics' | 'companion',
  ) => void;
  onImportAudioClick?: () => void;
  workflowSteps?: HeaderWorkflowStepItem[];
  activeWorkflowStep?: StudioWorkflowStepId;
  onSelectWorkflowStep?: (step: StudioWorkflowStepId) => void;
  asrStatusLabel?: string;
  asrReady?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  executionMode: 'LOCAL' | 'CLOUD';
  onChangeExecutionMode: (mode: 'LOCAL' | 'CLOUD') => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  locale: WorkflowLocale;
  onToggleLocale: (next: WorkflowLocale) => void;
  persianDigits?: boolean;
  isLabMode?: boolean;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  projectTitle,
  sampleRate,
  trackCount,
  wordCount,
  saveStatus,
  activeTab,
  onSelectTab,
  onBackToProjects,
  onOpenExport,
  onOpenSettings,
  onOpenLifecycleModal,
  onImportAudioClick,
  workflowSteps,
  activeWorkflowStep = 'review',
  onSelectWorkflowStep,
  asrStatusLabel,
  asrReady = false,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  executionMode,
  onChangeExecutionMode,
  theme,
  onToggleTheme,
  locale,
  onToggleLocale,
  persianDigits = false,
  isLabMode = false,
}) => {
  const isFa = locale === 'fa';
  const BackIcon = isFa ? ArrowRight : ArrowLeft;
  const StepChevron = isFa ? ChevronLeft : ChevronRight;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const saveLabel =
    saveStatus === 'saving'
      ? isFa
        ? 'در حال ذخیره...'
        : 'Saving...'
      : saveStatus === 'saved'
        ? isFa
          ? 'ذخیره شد'
          : 'Saved'
        : saveStatus === 'error'
          ? isFa
            ? 'خطای ذخیره'
            : 'Save Error'
          : isFa
            ? 'نمونه'
            : 'Sample';

  const startSlot = (
    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
      <button
        type="button"
        data-testid="btn-back-to-projects"
        onClick={onBackToProjects}
        className="inline-flex items-center gap-1.5 h-[28px] px-2 sm:px-2.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-xs font-medium text-[var(--avp-text)] shrink-0 cursor-pointer transition-colors"
        title={isFa ? 'بازگشت به پروژه‌های من' : 'Back to My Projects'}
      >
        <BackIcon className="w-3.5 h-3.5 text-[var(--avp-text-secondary)]" strokeWidth={1.75} aria-hidden="true" />
        <FolderOpen className="w-3.5 h-3.5 text-[var(--avp-accent)]" strokeWidth={1.75} aria-hidden="true" />
        <span className="hidden sm:inline">{isFa ? 'پروژه‌ها' : 'Projects'}</span>
      </button>

      <div className="min-w-0 flex items-center gap-1.5">
        <h1
          data-testid="project-title"
          className="text-[12.5px] sm:text-[13px] font-semibold text-[var(--avp-text)] truncate max-w-[125px] sm:max-w-[200px] xl:max-w-[260px]"
          title={projectTitle}
        >
          {projectTitle}
        </h1>

        <span
          data-testid="project-save-status"
          className={`hidden sm:inline-flex items-center h-[20px] px-1.5 rounded text-[10px] font-medium whitespace-nowrap shrink-0 border ${
            saveStatus === 'error'
              ? 'border-[var(--avp-danger)]/40 bg-[var(--avp-danger-soft)] text-[var(--avp-danger)]'
              : saveStatus === 'saving'
                ? 'border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)]'
                : 'border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/80 text-[var(--avp-text-muted)]'
          }`}
        >
          {saveLabel}
        </span>

        {typeof sampleRate === 'number' && typeof trackCount === 'number' && (
          <span
            className="hidden 2xl:inline-flex items-center gap-1 h-[20px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[10px] font-mono text-[var(--avp-text-muted)] whitespace-nowrap shrink-0"
            dir="ltr"
          >
            <span>{Math.round(sampleRate / 1000)}kHz</span>
            <span aria-hidden="true">·</span>
            <span>{formatNumberForLocale(trackCount, { persianDigits })}T</span>
            {typeof wordCount === 'number' && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatNumberForLocale(wordCount, { persianDigits })}W</span>
              </>
            )}
          </span>
        )}
      </div>

      {/* Framed Document Undo / Redo Twin Capsule */}
      <div
        role="group"
        aria-label={isFa ? 'بازگشت و تکرار تغییر' : 'Undo and Redo'}
        className="hidden sm:inline-flex items-center h-[28px] rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/80 p-0.5 shrink-0"
      >
        <button
          type="button"
          data-testid="btn-timeline-undo"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={isFa ? 'بازگشت (Undo)' : 'Undo'}
          title={isFa ? 'بازگشت (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
          className="inline-flex items-center justify-center w-[24px] h-[22px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer transition-colors"
        >
          <Undo2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span className="w-px h-3.5 bg-[var(--avp-border)]" aria-hidden="true" />
        <button
          type="button"
          data-testid="btn-timeline-redo"
          onClick={onRedo}
          disabled={!canRedo}
          aria-label={isFa ? 'تکرار (Redo)' : 'Redo'}
          title={isFa ? 'تکرار (Ctrl+Y)' : 'Redo (Ctrl+Y)'}
          className="inline-flex items-center justify-center w-[24px] h-[22px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer transition-colors"
        >
          <Redo2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {activeTab !== 'studio' && (
        <button
          type="button"
          onClick={() => onSelectTab('studio')}
          className="avp-btn avp-btn-sm avp-btn-tonal ms-1 shrink-0"
        >
          {isFa ? 'بازگشت به استودیو' : 'Studio'}
        </button>
      )}
    </div>
  );

  const centerSlot =
    workflowSteps && onSelectWorkflowStep ? (
      <nav
        data-testid="workflow-stage-bar"
        aria-label={isFa ? 'مراحل کار تدوین صوتی' : 'Audio editing workflow stages'}
        className="flex items-center justify-center shrink-0"
      >
        <ol className="flex items-center gap-0.5 bg-[var(--avp-surface-secondary)]/80 border border-[var(--avp-border)] rounded-lg p-0.5">
          {workflowSteps.map((step, idx) => {
            const isActive = activeWorkflowStep === step.id;
            return (
              <li key={step.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  data-testid={`workflow-step-${step.id}`}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => onSelectWorkflowStep(step.id)}
                  className={`inline-flex items-center gap-1 h-[24px] px-1.5 xl:px-2 rounded-md text-[11px] xl:text-[11.5px] transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                      : step.done
                        ? 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] font-medium'
                        : 'text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] font-normal'
                  }`}
                >
                  <span
                    className={`w-3.5 h-3.5 rounded-full inline-flex items-center justify-center text-[9.5px] font-semibold shrink-0 ${
                      isActive
                        ? 'bg-[var(--avp-accent)] text-white'
                        : step.done
                          ? 'text-[var(--avp-accent-text)]'
                          : 'text-[var(--avp-text-faint)]'
                    }`}
                  >
                    {step.done && !isActive ? (
                      <Check className="w-2.5 h-2.5" strokeWidth={2.5} aria-hidden="true" />
                    ) : (
                      step.num
                    )}
                  </span>
                  <span>{step.label}</span>
                </button>

                {idx < workflowSteps.length - 1 && (
                  <StepChevron
                    className="w-3 h-3 text-[var(--avp-text-faint)] shrink-0"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    ) : null;

  const endSlot = (
    <div className="relative flex items-center gap-1 sm:gap-1.5 min-w-0 shrink-0">
      <div className="hidden xl:inline-flex items-center gap-1.5">
        <OfflineIndicator inline locale={locale} />
        <PWAInstallButton compact locale={locale} />
      </div>

      {isLabMode && (
        <span
          data-testid="lab-mode-indicator"
          title={isFa ? 'حالت آزمایشگاه مهندسی فعال است' : 'R&D Lab Mode Enabled'}
          className="hidden md:inline-flex items-center gap-1 h-[24px] px-2 rounded-md border border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)] text-[10.5px] font-mono font-semibold"
        >
          <FlaskConical className="w-3 h-3" aria-hidden="true" />
          <span>LAB</span>
        </span>
      )}

      {/* Local / Cloud Execution Mode */}
      <div className="flex items-center gap-0.5 bg-[var(--avp-surface-secondary)] border border-[var(--avp-border)] rounded-lg p-0.5">
        <div
          role="group"
          aria-label={isFa ? 'مسیر اجرای پردازش' : 'Processing execution mode'}
          className="inline-flex items-center gap-0.5"
        >
          <button
            type="button"
            data-testid="btn-mode-local"
            aria-pressed={executionMode === 'LOCAL'}
            onClick={() => onChangeExecutionMode('LOCAL')}
            className="avp-segmented-item h-[24px] px-1.5 sm:px-2 text-[10.5px] sm:text-[11px]"
          >
            {isFa ? 'محلی' : 'Local'}
          </button>
          <button
            type="button"
            data-testid="btn-mode-cloud"
            aria-pressed={executionMode === 'CLOUD'}
            onClick={() => onChangeExecutionMode('CLOUD')}
            className="avp-segmented-item h-[24px] px-1.5 sm:px-2 text-[10.5px] sm:text-[11px]"
          >
            {isFa ? 'ابری' : 'Cloud'}
          </button>
        </div>

        {asrStatusLabel && (
          <button
            type="button"
            data-testid="btn-asr-status-inspect"
            onClick={() => onOpenLifecycleModal('model')}
            title={asrStatusLabel}
            className="hidden sm:inline-flex items-center gap-1 h-[24px] px-1.5 rounded-md hover:bg-[var(--avp-surface)] text-[10.5px] text-[var(--avp-text-secondary)] cursor-pointer transition-colors"
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                asrReady ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              aria-hidden="true"
            />
            <span className="hidden 2xl:inline max-w-[120px] truncate">{asrStatusLabel}</span>
            <span className="sr-only 2xl:hidden">{asrStatusLabel}</span>
          </button>
        )}
      </div>

      {/* Unified System Utility Cluster */}
      <div className="inline-flex items-center gap-0.5 bg-[var(--avp-surface-secondary)]/80 border border-[var(--avp-border)] rounded-lg p-0.5">
        <button
          type="button"
          data-testid="btn-toggle-locale"
          onClick={() => onToggleLocale(isFa ? 'en' : 'fa')}
          aria-label={isFa ? 'تغییر زبان به انگلیسی' : 'Switch language to Persian'}
          title={isFa ? 'تغییر زبان (FA / EN)' : 'Switch Language (FA / EN)'}
          className="inline-flex items-center justify-center h-[24px] px-1.5 rounded-md text-[10.5px] font-mono font-semibold text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
        >
          {isFa ? 'EN' : 'FA'}
        </button>

        <button
          type="button"
          data-testid="btn-toggle-theme"
          onClick={onToggleTheme}
          aria-label={
            theme === 'dark'
              ? isFa
                ? 'تغییر به تم روشن'
                : 'Switch to light theme'
              : isFa
                ? 'تغییر به تم تیره'
                : 'Switch to dark theme'
          }
          title={theme === 'dark' ? (isFa ? 'تم روشن' : 'Light Mode') : isFa ? 'تم تیره' : 'Dark Mode'}
          className="inline-flex items-center justify-center w-[24px] h-[24px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
        >
          {theme === 'dark' ? (
            <Sun className="w-3.5 h-3.5 text-[var(--avp-warning)]" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Moon className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          data-testid="btn-open-lifecycle-modal"
          onClick={() => onOpenLifecycleModal('health')}
          aria-label={isFa ? 'سلامت و مدیریت موتورهای محلی' : 'Local Engine Health & Lifecycle'}
          title={isFa ? 'سلامت و مدیریت موتورهای محلی' : 'Local Engine Health & Lifecycle'}
          className="hidden sm:inline-flex items-center justify-center w-[24px] h-[24px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-accent-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
        >
          <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>

        <button
          type="button"
          data-testid="btn-open-settings"
          onClick={onOpenSettings}
          aria-label={isFa ? 'تنظیمات آواپرداز' : 'Avapardaz Settings'}
          title={isFa ? 'تنظیمات' : 'Settings'}
          className="inline-flex items-center justify-center w-[24px] h-[24px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors"
        >
          <Settings className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>

        {/* Mobile Secondary Overflow Menu (< sm) */}
        <button
          type="button"
          data-testid="btn-header-mobile-menu"
          aria-expanded={mobileMenuOpen}
          aria-label={isFa ? 'منوی بیشتر استودیو' : 'More studio actions'}
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="sm:hidden inline-flex items-center justify-center w-[24px] h-[24px] rounded-md text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface)] cursor-pointer"
        >
          <MoreVertical className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {/* Mobile Overflow Popover */}
      {mobileMenuOpen && (
        <div
          role="menu"
          className="sm:hidden absolute top-full end-0 mt-1.5 w-48 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-floating)] shadow-[var(--avp-shadow-md)] py-1 z-50 text-xs"
        >
          {onImportAudioClick && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMobileMenuOpen(false);
                onImportAudioClick();
              }}
              className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
              <span>{isFa ? 'ورود فایل صوتی جدید' : 'Import Audio'}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMobileMenuOpen(false);
              onUndo();
            }}
            disabled={!canUndo}
            className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 disabled:opacity-40 cursor-pointer"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>{isFa ? 'بازگشت تغییر (Undo)' : 'Undo'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMobileMenuOpen(false);
              onRedo();
            }}
            disabled={!canRedo}
            className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 disabled:opacity-40 cursor-pointer"
          >
            <Redo2 className="w-3.5 h-3.5" />
            <span>{isFa ? 'تکرار تغییر (Redo)' : 'Redo'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMobileMenuOpen(false);
              onOpenLifecycleModal('health');
            }}
            className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
            <span>{isFa ? 'سلامت و موتورهای محلی' : 'Health & Local Engines'}</span>
          </button>
        </div>
      )}

      {/* Primary Header CTA (ONLY Solid Green Button in Header) */}
      <button
        type="button"
        data-testid="btn-header-render-export"
        onClick={onOpenExport}
        className="avp-btn avp-btn-sm avp-btn-primary px-2.5 sm:px-3"
      >
        <Download className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        <span className="hidden xs:inline sm:inline">{isFa ? 'خروجی' : 'Export'}</span>
      </button>
    </div>
  );

  return (
    <GlobalAppBar
      dataTestId="studio-header"
      className="sticky top-0 backdrop-blur-sm bg-[var(--avp-surface-shell)]/95"
      startSlot={startSlot}
      centerSlot={centerSlot}
      endSlot={endSlot}
    />
  );
};
