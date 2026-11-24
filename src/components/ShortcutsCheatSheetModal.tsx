import React from 'react';
import { Download, FolderOpen, Keyboard, Settings, X } from 'lucide-react';
import { AccessibleModal } from './AccessibleModal';
import type { KeyboardShortcutMap } from '../settings/settingsStore';

interface ShortcutsCheatSheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  locale: 'fa' | 'en';
  shortcuts: KeyboardShortcutMap;
  onNavigateProjects?: () => void;
  onOpenSettings?: () => void;
  onOpenExport?: () => void;
}

function formatShortcutHuman(binding: string): string {
  return binding
    .replace('Mod+', 'Ctrl/Cmd + ')
    .replace('Shift+', 'Shift + ')
    .replace('Alt+', 'Alt + ')
    .replace('Key', '')
    .replace('Comma', ',')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→');
}

export const ShortcutsCheatSheetModal: React.FC<ShortcutsCheatSheetModalProps> = ({
  isOpen,
  onClose,
  locale,
  shortcuts,
  onNavigateProjects,
  onOpenSettings,
  onOpenExport,
}) => {
  const isFa = locale === 'fa';

  const items: Array<{ label: string; keys: string }> = [
    { label: isFa ? 'پخش / توقف موقت' : 'Play / Pause', keys: formatShortcutHuman(shortcuts.playPause) },
    { label: isFa ? 'پرش به عقب' : 'Seek Backward', keys: formatShortcutHuman(shortcuts.seekBackward) },
    { label: isFa ? 'پرش به جلو' : 'Seek Forward', keys: formatShortcutHuman(shortcuts.seekForward) },
    { label: isFa ? 'تکرار محدوده / فایل' : 'Toggle Loop', keys: formatShortcutHuman(shortcuts.toggleLoop) },
    { label: isFa ? 'تنظیم نقطه شروع انتخاب (In)' : 'Set Selection In', keys: 'I' },
    { label: isFa ? 'تنظیم نقطه پایان انتخاب (Out)' : 'Set Selection Out', keys: 'O' },
    { label: isFa ? 'افزودن نشانگر در Playhead' : 'Add Marker at Playhead', keys: 'M' },
    { label: isFa ? 'بازگشت به ابتدای صوت' : 'Rewind to Start', keys: 'Home' },
    { label: isFa ? 'بازگشت تغییر (Undo)' : 'Undo', keys: formatShortcutHuman(shortcuts.undo) },
    { label: isFa ? 'تکرار تغییر (Redo)' : 'Redo', keys: formatShortcutHuman(shortcuts.redo) },
    { label: isFa ? 'لغو انتخاب تایملاین' : 'Clear Selection', keys: formatShortcutHuman(shortcuts.clearSelection) },
    { label: isFa ? 'باز کردن پنجره خروجی' : 'Open Export', keys: formatShortcutHuman(shortcuts.openExport) },
    { label: isFa ? 'تنظیمات برنامه' : 'Open Settings', keys: formatShortcutHuman(shortcuts.openSettings) },
    { label: isFa ? 'راهنمای میانبرها و اقدامات سریع' : 'Shortcuts & Quick Actions', keys: '? / Ctrl+K' },
  ];

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdropClick
      labelledBy="shortcuts-cheatsheet-title"
      dir={isFa ? 'rtl' : 'ltr'}
      dataTestId="shortcuts-cheatsheet-modal"
      panelClassName="w-full max-w-2xl"
    >
      <div className="rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text)] shadow-[var(--avp-shadow-md)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--avp-accent-soft)] text-[var(--avp-accent-text)] flex items-center justify-center shrink-0">
              <Keyboard className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 id="shortcuts-cheatsheet-title" className="text-sm font-bold">
                {isFa ? 'راهنمای میانبرهای صفحه‌کلید و دستورات سریع' : 'Keyboard Shortcuts & Quick Actions'}
              </h2>
              <p className="text-[11px] text-[var(--avp-text-secondary)]">
                {isFa
                  ? 'کلیدهای قابل سفارشی‌سازی در بخش تنظیمات ← میانبرها'
                  : 'All bindings reflect your active preferences in Settings -> Keyboard Shortcuts'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={isFa ? 'بستن راهنمای میانبرها' : 'Close shortcuts overlay'}
            className="avp-btn-icon avp-touch-icon"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {(onNavigateProjects || onOpenExport || onOpenSettings) && (
          <div className="px-5 py-3 border-b border-[var(--avp-border-subtle)] bg-[var(--avp-bg)] flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-[var(--avp-text-muted)] me-1">
              {isFa ? 'دسترسی سریع:' : 'Quick Jump:'}
            </span>
            {onNavigateProjects && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateProjects();
                }}
                className="avp-btn avp-btn-sm avp-btn-outline min-h-[44px] sm:min-h-[28px]"
              >
                <FolderOpen className="w-3.5 h-3.5 text-[var(--avp-brand)]" aria-hidden="true" />
                <span>{isFa ? 'پروژه‌های من' : 'Projects Hub'}</span>
              </button>
            )}
            {onOpenExport && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenExport();
                }}
                className="avp-btn avp-btn-sm avp-btn-outline min-h-[44px] sm:min-h-[28px]"
              >
                <Download className="w-3.5 h-3.5 text-[var(--avp-brand)]" aria-hidden="true" />
                <span>{isFa ? 'پنجره خروجی' : 'Export Audio'}</span>
              </button>
            )}
            {onOpenSettings && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="avp-btn avp-btn-sm avp-btn-outline min-h-[44px] sm:min-h-[28px]"
              >
                <Settings className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isFa ? 'ویرایش میانبرها در تنظیمات' : 'Customize Shortcuts'}</span>
              </button>
            )}
          </div>
        )}

        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[60vh] overflow-y-auto">
          {items.map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-bg)] text-xs"
            >
              <span className="text-[var(--avp-text)] font-medium">{item.label}</span>
              <kbd
                dir="ltr"
                className="px-2 py-0.5 rounded bg-[var(--avp-surface)] border border-[var(--avp-border-strong)] font-mono text-[11px] font-semibold text-[var(--avp-accent-text)] shrink-0"
              >
                {item.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </AccessibleModal>
  );
};
