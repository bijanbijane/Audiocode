import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  FlaskConical,
  FolderOpen,
  GitMerge,
  HardDrive,
  Keyboard,
  Layers,
  MoreVertical,
  Redo2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Undo2,
  Upload,
} from 'lucide-react';
import type { WorkflowLocale } from '../workflow/StudioWorkflowController';
import type { StudioWorkflowStepId } from './WorkflowStageBar';
import { GlobalAppBar } from './GlobalAppBar';
import { OfflineIndicator, PWAInstallButton } from '../ui/pwa/PWAInstallControls';
import { ShellSystemCluster } from './ShellSystemCluster';
import { formatNumberForLocale } from '../utils/formatters';
import { detectContentDirection, detectContentLang } from '../utils/bidi';

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
  onOpenShortcuts?: () => void;
  onOpenLabModal?: (target: 'asr-lab' | 'security' | 'dev-portal') => void;
  onOpenLifecycleModal: (
    initialTab?: 'model' | 'offline' | 'health' | 'backup' | 'storage' | 'diagnostics' | 'companion',
  ) => void;
  onImportAudioClick?: () => void;
  workflowSteps?: HeaderWorkflowStepItem[];
  activeWorkflowStep?: StudioWorkflowStepId;
  onSelectWorkflowStep?: (step: StudioWorkflowStepId) => void;
  canInstallPwa?: boolean;
  onTriggerInstallPwa?: () => void;
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
  onOpenShortcuts,
  onOpenLabModal,
  onOpenLifecycleModal,
  onImportAudioClick,
  workflowSteps,
  activeWorkflowStep = 'review',
  onSelectWorkflowStep,
  canInstallPwa = false,
  onTriggerInstallPwa,
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
  const [labMenuOpen, setLabMenuOpen] = useState(false);
  const [mobileStageMenuOpen, setMobileStageMenuOpen] = useState(false);

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

  const activeStepItem = workflowSteps?.find((s) => s.id === activeWorkflowStep) ?? workflowSteps?.[0];

  const startSlot = (
    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 sm:flex-initial">
      <button
        type="button"
        data-testid="btn-back-to-projects"
        onClick={onBackToProjects}
        className="inline-flex items-center justify-center gap-1.5 h-11 min-w-[44px] sm:h-7 sm:min-w-0 lg:h-[28px] px-2 sm:px-2.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)] text-xs font-medium text-[var(--avp-text)] shrink-0 cursor-pointer transition-colors"
        title={isFa ? 'بازگشت به پروژه‌های من' : 'Back to My Projects'}
      >
        <BackIcon className="w-3.5 h-3.5 text-[var(--avp-text-secondary)]" strokeWidth={1.75} aria-hidden="true" />
        <FolderOpen className="w-3.5 h-3.5 text-[var(--avp-accent)]" strokeWidth={1.75} aria-hidden="true" />
        <span className="hidden sm:inline">{isFa ? 'پروژه‌ها' : 'Projects'}</span>
      </button>

      <div className="min-w-0 flex-1 sm:flex-initial flex items-center gap-1.5">
        {activeTab === 'studio' ? (
          <h1
            data-testid="project-title"
            dir={detectContentDirection(projectTitle, isFa ? 'rtl' : 'ltr')}
            lang={detectContentLang(projectTitle)}
            className="text-[12.5px] sm:text-[13px] font-semibold text-[var(--avp-text)] truncate min-w-0 max-w-none sm:max-w-[200px] xl:max-w-[280px]"
            title={projectTitle}
          >
            {projectTitle}
          </h1>
        ) : (
          <span
            data-testid="project-title"
            dir={detectContentDirection(projectTitle, isFa ? 'rtl' : 'ltr')}
            lang={detectContentLang(projectTitle)}
            className="text-[12.5px] sm:text-[13px] font-semibold text-[var(--avp-text)] truncate min-w-0 max-w-none sm:max-w-[180px] xl:max-w-[240px]"
            title={projectTitle}
          >
            {projectTitle}
          </span>
        )}

        <span
          data-testid="project-save-status"
          className={`hidden sm:inline-flex items-center h-[22px] px-1.5 rounded text-[11px] font-medium whitespace-nowrap shrink-0 border ${
            saveStatus === 'error'
              ? 'border-[var(--avp-danger)]/40 bg-[var(--avp-danger-soft)] text-[var(--avp-danger-text)]'
              : saveStatus === 'saving'
                ? 'border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)]'
                : 'border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/80 text-[var(--avp-text-muted)]'
          }`}
        >
          {saveLabel}
        </span>

        {typeof sampleRate === 'number' && typeof trackCount === 'number' && (
          <span
            className="hidden 2xl:inline-flex items-center gap-1 h-[22px] px-1.5 rounded border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[11px] font-mono text-[var(--avp-text-muted)] whitespace-nowrap shrink-0"
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
        className="hidden sm:inline-flex items-center h-[30px] rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/80 p-0.5 shrink-0"
      >
        <button
          type="button"
          data-testid="btn-timeline-undo"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={isFa ? 'بازگشت (Undo)' : 'Undo'}
          title={isFa ? 'بازگشت (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
          className="inline-flex items-center justify-center w-[26px] h-[26px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer transition-colors"
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
          className="inline-flex items-center justify-center w-[26px] h-[26px] rounded-md text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer transition-colors"
        >
          <Redo2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {activeTab !== 'studio' && (
        <button
          type="button"
          data-testid="btn-back-to-studio"
          onClick={() => onSelectTab('studio')}
          className="avp-btn avp-btn-sm avp-btn-tonal ms-1 shrink-0"
        >
          {isFa ? 'بازگشت به استودیو' : 'Studio'}
        </button>
      )}
    </div>
  );

  const centerSlot =
    activeTab === 'studio' && workflowSteps && onSelectWorkflowStep ? (
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
                  className={`inline-flex items-center gap-1 h-[26px] px-1.5 xl:px-2 rounded-md text-[11px] xl:text-[11.5px] transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                      : step.done
                        ? 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] font-medium'
                        : 'text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] font-normal'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full inline-flex items-center justify-center text-[11px] font-semibold shrink-0 ${
                      isActive
                        ? 'bg-[var(--avp-brand-solid)] text-[var(--avp-on-brand)]'
                        : step.done
                          ? 'text-[var(--avp-accent-text)]'
                          : 'text-[var(--avp-text-faint)]'
                    }`}
                  >
                    {step.done && !isActive ? (
                      <Check className="w-2.5 h-2.5" strokeWidth={2.5} aria-hidden="true" />
                    ) : persianDigits ? (
                      formatNumberForLocale(Number(step.num.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))), {
                        persianDigits: true,
                      })
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

      {/* Compact <lg Active Stage Popover Trigger (Studio only) */}
      {activeTab === 'studio' && workflowSteps && onSelectWorkflowStep && activeStepItem && (
        <div className="relative lg:hidden">
          <button
            type="button"
            data-testid="btn-mobile-stage-popover"
            aria-expanded={mobileStageMenuOpen}
            onClick={() => {
              setMobileMenuOpen(false);
              setLabMenuOpen(false);
              setMobileStageMenuOpen((v) => !v);
            }}
            className="hidden sm:inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[11px] font-medium text-[var(--avp-text-secondary)] cursor-pointer"
          >
            <span className="font-mono text-[var(--avp-accent-text)] font-bold">
              {activeStepItem.num}
            </span>
            <span>{activeStepItem.label}</span>
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          </button>

          {mobileStageMenuOpen && (
            <div
              data-testid="mobile-workflow-stage-bar"
              role="menu"
              className="absolute top-full end-0 mt-1.5 w-52 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-floating)] shadow-[var(--avp-shadow-md)] py-1.5 z-[var(--avp-z-popover)] text-xs"
            >
              {workflowSteps.map((step) => {
                const isActive = activeWorkflowStep === step.id;
                return (
                  <button
                    key={step.id}
                    type="button"
                    role="menuitem"
                    data-testid={`mobile-workflow-step-${step.id}`}
                    onClick={() => {
                      setMobileStageMenuOpen(false);
                      onSelectWorkflowStep(step.id);
                    }}
                    className={`w-full px-3 py-2 text-start flex items-center justify-between gap-2 hover:bg-[var(--avp-hover)] cursor-pointer ${
                      isActive ? 'text-[var(--avp-accent-text)] font-semibold' : 'text-[var(--avp-text)]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-[11px]">{step.num}</span>
                      <span>{step.label}</span>
                    </span>
                    {step.done && <Check className="w-3.5 h-3.5 text-[var(--avp-accent)]" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Interactive 1-Click Engineering Lab Switcher (?mode=lab) */}
      {isLabMode && (
        <div className="relative hidden md:inline-flex items-center">
          <button
            type="button"
            data-testid="lab-mode-indicator"
            aria-expanded={labMenuOpen}
            onClick={() => {
              setMobileMenuOpen(false);
              setMobileStageMenuOpen(false);
              setLabMenuOpen((v) => !v);
            }}
            title={isFa ? 'تعویض ابزارهای آزمایشگاه مهندسی' : 'Switch R&D Lab Tools'}
            className="inline-flex items-center gap-1 h-[28px] px-2 rounded-md border border-[var(--avp-warning)]/45 bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)] text-[11px] font-mono font-semibold cursor-pointer hover:brightness-95 transition-all"
          >
            <FlaskConical className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>
              {activeTab === 'shahab'
                ? 'LAB · SHAHAB'
                : activeTab === 'graph'
                  ? 'LAB · GRAPH'
                  : activeTab === 'storage'
                    ? 'LAB · OPFS'
                    : 'LAB'}
            </span>
            <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
          </button>

          {labMenuOpen && (
            <div
              role="menu"
              data-testid="lab-switcher-menu"
              className="absolute top-full end-0 mt-1.5 w-56 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-floating)] shadow-[var(--avp-shadow-md)] py-1.5 z-[var(--avp-z-popover)] text-xs"
            >
              {(
                [
                  { id: 'studio' as const, label: isFa ? 'استودیوی تدوین صوت' : 'Audio Editing Studio', icon: <Layers className="w-3.5 h-3.5 text-[var(--avp-brand)]" /> },
                  { id: 'shahab' as const, label: 'SHAHAB LAB (ASR Observatory)', icon: <Cpu className="w-3.5 h-3.5 text-[var(--avp-warning)]" /> },
                  { id: 'graph' as const, label: isFa ? 'گراف پردازش و PDC' : 'Processing Graph & PDC', icon: <GitMerge className="w-3.5 h-3.5 text-[var(--avp-accent)]" /> },
                  { id: 'storage' as const, label: isFa ? 'ذخیره‌سازی OPFS و کش' : 'OPFS Storage Broker', icon: <HardDrive className="w-3.5 h-3.5 text-[var(--avp-success)]" /> },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-testid={`lab-nav-${item.id}`}
                  onClick={() => {
                    setLabMenuOpen(false);
                    onSelectTab(item.id);
                  }}
                  className={`w-full px-3 py-2 text-start flex items-center justify-between gap-2 hover:bg-[var(--avp-hover)] cursor-pointer ${
                    activeTab === item.id ? 'bg-[var(--avp-accent-soft)]/50 text-[var(--avp-accent-text)] font-semibold' : ''
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                  {activeTab === item.id && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}

              {onOpenLabModal && (
                <>
                  <div className="my-1 border-t border-[var(--avp-border-subtle)]" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="lab-nav-asr-lab"
                    onClick={() => {
                      setLabMenuOpen(false);
                      onOpenLabModal('asr-lab');
                    }}
                    className="w-full px-3 py-2 text-start flex items-center gap-2 hover:bg-[var(--avp-hover)] cursor-pointer"
                  >
                    <FlaskConical className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
                    <span>{isFa ? 'آزمایشگاه تحقیقاتی ASR' : 'ASR Research Lab Modal'}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="lab-nav-security"
                    onClick={() => {
                      setLabMenuOpen(false);
                      onOpenLabModal('security');
                    }}
                    className="w-full px-3 py-2 text-start flex items-center gap-2 hover:bg-[var(--avp-hover)] cursor-pointer"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-[var(--avp-danger)]" />
                    <span>{isFa ? 'امنیت و Red-Team گفتار' : 'Speech Security Sandbox'}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="lab-nav-dev-portal"
                    onClick={() => {
                      setLabMenuOpen(false);
                      onOpenLabModal('dev-portal');
                    }}
                    className="w-full px-3 py-2 text-start flex items-center gap-2 hover:bg-[var(--avp-hover)] cursor-pointer"
                  >
                    <Terminal className="w-3.5 h-3.5 text-[var(--avp-accent)]" />
                    <span>{isFa ? 'پورتال توسعه‌دهندگان API' : 'Developer API Portal'}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Local / Cloud Execution Mode (relocated to mobile overflow menu on < sm to preserve project title clarity) */}
      <div className="hidden sm:flex items-center gap-0.5 bg-[var(--avp-surface-secondary)] border border-[var(--avp-border)] rounded-lg p-0.5">
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
            className="avp-segmented-item h-7 lg:h-[26px] px-2 text-[11px]"
          >
            {isFa ? 'محلی' : 'Local'}
          </button>
          <button
            type="button"
            data-testid="btn-mode-cloud"
            aria-pressed={executionMode === 'CLOUD'}
            onClick={() => onChangeExecutionMode('CLOUD')}
            className="avp-segmented-item h-7 lg:h-[26px] px-2 text-[11px]"
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
            aria-label={isFa ? `وضعیت موتور و مدل‌های محلی: ${asrStatusLabel}` : `Engine & local models: ${asrStatusLabel}`}
            className="hidden sm:inline-flex items-center justify-center gap-1.5 min-w-[28px] min-h-[28px] h-7 lg:h-[26px] px-2 rounded-md hover:bg-[var(--avp-surface)] text-[11px] text-[var(--avp-text-secondary)] cursor-pointer transition-colors"
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                asrReady ? 'bg-[var(--avp-success)]' : 'bg-[var(--avp-warning)]'
              }`}
              aria-hidden="true"
            />
            <span className="hidden 2xl:inline max-w-[120px] truncate">{asrStatusLabel}</span>
            <span className="sr-only 2xl:hidden">{asrStatusLabel}</span>
          </button>
        )}
      </div>

      {/* Unified System Utility Cluster (Shield removed from top bar to eliminate redundant health/settings trigger; accessible via engine dot & Settings) */}
      <ShellSystemCluster
        locale={locale}
        theme={theme}
        onToggleLocale={() => onToggleLocale(isFa ? 'en' : 'fa')}
        onToggleTheme={onToggleTheme}
        onOpenShortcuts={onOpenShortcuts}
        onOpenSettings={onOpenSettings}
        settingsButtonTestId="btn-open-settings"
        hideSecondaryOnXs={true}
      >
        {/* Mobile Secondary Overflow Menu (< sm) */}
        <button
          type="button"
          data-testid="btn-header-mobile-menu"
          aria-expanded={mobileMenuOpen}
          aria-label={isFa ? 'منوی بیشتر استودیو' : 'More studio actions'}
          onClick={() => {
            setLabMenuOpen(false);
            setMobileStageMenuOpen(false);
            setMobileMenuOpen((v) => !v);
          }}
          className="sm:hidden inline-flex items-center justify-center w-11 h-11 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-surface)] cursor-pointer"
        >
          <MoreVertical className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </ShellSystemCluster>

      {/* Mobile Overflow Popover */}
      {mobileMenuOpen && (
        <div
          role="menu"
          className="sm:hidden absolute top-full end-0 mt-1.5 w-60 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-floating)] shadow-[var(--avp-shadow-md)] py-2 z-[var(--avp-z-popover)] text-xs"
        >
          <div className="px-3 py-1.5 border-b border-[var(--avp-border-subtle)] space-y-1.5">
            <div className="text-[11px] font-semibold text-[var(--avp-text-muted)]">
              {isFa ? 'مسیر پردازش' : 'Processing Mode'}
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                aria-pressed={executionMode === 'LOCAL'}
                onClick={() => {
                  onChangeExecutionMode('LOCAL');
                  setMobileMenuOpen(false);
                }}
                className={`flex-1 min-h-[38px] px-2.5 rounded-md border text-xs font-medium cursor-pointer ${
                  executionMode === 'LOCAL'
                    ? 'border-[var(--avp-accent)] bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                    : 'border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
                }`}
              >
                {isFa ? 'محلی (Local)' : 'Local'}
              </button>
              <button
                type="button"
                aria-pressed={executionMode === 'CLOUD'}
                onClick={() => {
                  onChangeExecutionMode('CLOUD');
                  setMobileMenuOpen(false);
                }}
                className={`flex-1 min-h-[38px] px-2.5 rounded-md border text-xs font-medium cursor-pointer ${
                  executionMode === 'CLOUD'
                    ? 'border-[var(--avp-accent)] bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                    : 'border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
                }`}
              >
                {isFa ? 'ابری (Cloud)' : 'Cloud'}
              </button>
            </div>
          </div>

          {activeTab === 'studio' && workflowSteps && onSelectWorkflowStep && (
            <div className="px-3 py-1.5 border-b border-[var(--avp-border-subtle)] space-y-1">
              <div className="text-[11px] font-semibold text-[var(--avp-text-muted)]">
                {isFa ? 'مراحل کار' : 'Workflow Stage'}
              </div>
              <div className="flex flex-wrap gap-1">
                {workflowSteps.map((step) => {
                  const isActive = activeWorkflowStep === step.id;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        onSelectWorkflowStep(step.id);
                      }}
                      className={`min-h-[36px] px-2.5 py-1 rounded text-[11px] border cursor-pointer ${
                        isActive
                          ? 'border-[var(--avp-accent)] bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] font-semibold'
                          : 'border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
                      }`}
                    >
                      {step.num}. {step.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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
              onToggleLocale(isFa ? 'en' : 'fa');
            }}
            className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center justify-between gap-2 cursor-pointer"
          >
            <span>{isFa ? 'تغییر زبان رابط کاربری' : 'Interface Language'}</span>
            <span className="font-mono text-[11px] font-semibold text-[var(--avp-accent-text)]">
              {isFa ? 'EN' : 'FA'}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMobileMenuOpen(false);
              onToggleTheme();
            }}
            className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center justify-between gap-2 cursor-pointer"
          >
            <span>{theme === 'dark' ? (isFa ? 'حالت روشن' : 'Light Mode') : isFa ? 'حالت تیره' : 'Dark Mode'}</span>
            <span className="text-[11px] text-[var(--avp-text-muted)]">
              {theme === 'dark' ? (isFa ? 'روشن' : 'Light') : isFa ? 'تیره' : 'Dark'}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMobileMenuOpen(false);
              onOpenSettings();
            }}
            className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
          >
            <span>{isFa ? 'تنظیمات استودیو' : 'Studio Settings'}</span>
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
          {onOpenShortcuts && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMobileMenuOpen(false);
                onOpenShortcuts();
              }}
              className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
            >
              <Keyboard className="w-3.5 h-3.5" />
              <span>{isFa ? 'میانبرهای صفحه‌کلید' : 'Keyboard Shortcuts'}</span>
            </button>
          )}
          {canInstallPwa && onTriggerInstallPwa && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMobileMenuOpen(false);
                onTriggerInstallPwa();
              }}
              className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
              <span>{isFa ? 'نصب اپلیکیشن آفلاین' : 'Install Offline App'}</span>
            </button>
          )}
          {isLabMode && (
            <>
              <div className="my-1 border-t border-[var(--avp-border-subtle)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onSelectTab('shahab');
                }}
                className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer text-[var(--avp-warning-text)] font-medium"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                <span>SHAHAB LAB</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Primary Header CTA (ONLY Solid Brand Button in Header — scoped to Studio route per AUD-14) */}
      {activeTab === 'studio' && (
        <button
          type="button"
          data-testid="btn-header-render-export"
          onClick={onOpenExport}
          aria-label={isFa ? 'خروجی و رندر صوت' : 'Render & Export Audio'}
          className="avp-btn avp-btn-sm avp-btn-primary h-11 min-w-[44px] sm:h-7 sm:min-w-0 lg:h-[var(--avp-ctrl-sm)] px-2.5 sm:px-3"
        >
          <Download className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden sm:inline">{isFa ? 'خروجی' : 'Export'}</span>
        </button>
      )}
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
