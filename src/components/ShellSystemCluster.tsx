import React from 'react';
import { Keyboard, Languages, Moon, Settings, ShieldCheck, Sun } from 'lucide-react';
import type { WorkflowLocale } from '../workflow/StudioWorkflowController';

interface ShellSystemClusterProps {
  locale: WorkflowLocale;
  theme: 'light' | 'dark';
  onToggleLocale: () => void;
  onToggleTheme: () => void;
  onOpenLifecycleModal?: () => void;
  onOpenShortcuts?: () => void;
  onOpenSettings: () => void;
  settingsButtonTestId?: string;
  hideSecondaryOnXs?: boolean;
  children?: React.ReactNode;
}

export const ShellSystemCluster: React.FC<ShellSystemClusterProps> = ({
  locale,
  theme,
  onToggleLocale,
  onToggleTheme,
  onOpenLifecycleModal,
  onOpenShortcuts,
  onOpenSettings,
  settingsButtonTestId = 'btn-open-settings',
  hideSecondaryOnXs = false,
  children,
}) => {
  const isFa = locale === 'fa';
  const secondaryVisibility = hideSecondaryOnXs ? 'hidden sm:inline-flex' : 'inline-flex';
  const btnHeightCls = 'h-11 min-w-[44px] sm:h-7 sm:min-w-[28px] lg:h-[26px] lg:min-w-[26px]';
  const iconBtnCls = 'w-11 h-11 sm:w-7 sm:h-7 lg:w-[26px] lg:h-[26px]';

  return (
    <div
      data-testid="shell-system-cluster"
      className="inline-flex items-center gap-0.5 bg-[var(--avp-surface-secondary)]/85 border border-[var(--avp-border)] rounded-[var(--avp-radius-sm)] p-0.5 shrink-0"
    >
      <button
        type="button"
        data-testid="btn-toggle-locale"
        onClick={onToggleLocale}
        aria-label={isFa ? 'تغییر زبان به انگلیسی' : 'Switch language to Persian'}
        title={isFa ? 'تغییر زبان (FA / EN)' : 'Switch Language (FA / EN)'}
        className={`${secondaryVisibility} items-center justify-center gap-1 ${btnHeightCls} px-1.5 rounded-[var(--avp-radius-xs)] text-[11px] font-mono font-semibold text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors`}
      >
        <Languages className="w-3 h-3 hidden sm:inline" strokeWidth={1.75} aria-hidden="true" />
        <span>{isFa ? 'EN' : 'FA'}</span>
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
        className={`${secondaryVisibility} items-center justify-center ${iconBtnCls} rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors`}
      >
        {theme === 'dark' ? (
          <Sun className="w-3.5 h-3.5 text-[var(--avp-warning)]" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Moon className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>

      {onOpenLifecycleModal && (
        <button
          type="button"
          data-testid="btn-open-lifecycle-modal"
          onClick={onOpenLifecycleModal}
          aria-label={isFa ? 'سلامت و مدیریت موتورهای محلی' : 'Local Engine Health & Lifecycle'}
          title={isFa ? 'سلامت و مدیریت موتورهای محلی' : 'Local Engine Health & Lifecycle'}
          className={`${secondaryVisibility} items-center justify-center ${iconBtnCls} rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-accent-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors`}
        >
          <ShieldCheck className="w-3.5 h-3.5 text-[var(--avp-brand)]" strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}

      {onOpenShortcuts && (
        <button
          type="button"
          data-testid="btn-open-shortcuts"
          onClick={onOpenShortcuts}
          aria-label={isFa ? 'میانبرهای صفحه‌کلید (?)' : 'Keyboard Shortcuts (?)'}
          title={isFa ? 'میانبرهای صفحه‌کلید (?)' : 'Keyboard Shortcuts (?)'}
          className={`${secondaryVisibility} items-center justify-center ${iconBtnCls} rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors`}
        >
          <Keyboard className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}

      <button
        type="button"
        data-testid={settingsButtonTestId}
        onClick={onOpenSettings}
        aria-label={isFa ? 'تنظیمات آواپرداز' : 'Avapardaz Settings'}
        title={isFa ? 'تنظیمات' : 'Settings'}
        className={`${secondaryVisibility} items-center justify-center ${iconBtnCls} rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface)] cursor-pointer transition-colors`}
      >
        <Settings className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {children}
    </div>
  );
};
