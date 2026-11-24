import React, { useEffect, useMemo, useState } from 'react';
import {
  Accessibility,
  AlertTriangle,
  Check,
  Cpu,
  Download,
  Globe,
  HardDrive,
  Keyboard,
  LayoutPanelLeft,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react';
import {
  ExportDefaultFormat,
  GlobalSettingsV1,
  KeyboardShortcutMap,
  SETTINGS_SCHEMA_VERSION,
  SUPPORTED_PLAYBACK_RATES,
  SettingsCategoryKey,
  SuggestionCategoryFilter,
  SuggestionSortOrder,
  SupportedPlaybackRate,
  WorkspaceDensity,
  WorkspaceInspectorSide,
  resetAllGlobalSettings,
  resetSettingsCategory,
  validateShortcutBinding,
} from '../settings/settingsStore';
import { StorageUsageEstimate, projectLibraryStore } from '../projects/projectLibraryStore';
import { formatAudioByteSize } from '../projects/audioFileValidator';
import { AdobeAuditionHostAdapter } from '../host-bridge/audition/AuditionHostAdapter';
import { AccessibleModal } from './AccessibleModal';
import { isLabModeEnabled } from '../utils/labMode';
import { getNextRovingTabIndex } from '../studio/layoutUtils';

type SettingsNavTab = SettingsCategoryKey | 'advanced';

interface SettingsCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: GlobalSettingsV1;
  onUpdateSettings: (next: GlobalSettingsV1) => void;
  saveStatus: 'saved' | 'saving' | 'error';
  saveError: string | null;
  isLabMode?: boolean;
  onOpenShortcutsCheatSheet?: () => void;
  onOpenDeveloperView?: (
    target:
      | 'graph'
      | 'storage'
      | 'shahab'
      | 'asr-lab'
      | 'security'
      | 'dev-portal'
      | 'lifecycle'
      | 'companion',
  ) => void;
}

export const SettingsCenterModal: React.FC<SettingsCenterModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  saveStatus,
  saveError,
  isLabMode: isLabModeProp,
  onOpenShortcutsCheatSheet,
  onOpenDeveloperView,
}) => {
  const isFa = settings.language.locale === 'fa';
  const [activeTab, setActiveTab] = useState<SettingsNavTab>('appearance');
  const [storageEstimate, setStorageEstimate] = useState<StorageUsageEstimate | null>(null);
  const [confirmResetScope, setConfirmResetScope] = useState<'category' | 'all' | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const auditionCapabilities = useMemo(
    () => new AdobeAuditionHostAdapter().getHostCapabilityMatrix(),
    [],
  );

  const isLabMode =
    isLabModeProp ??
    isLabModeEnabled(
      typeof window !== 'undefined' ? window.location.search : '',
      typeof window !== 'undefined' ? window.location.pathname : '',
    );

  useEffect(() => {
    if (!isOpen || activeTab !== 'storage') return;
    let active = true;
    void projectLibraryStore.getStorageEstimate().then((est) => {
      if (active) setStorageEstimate(est);
    });
    return () => {
      active = false;
    };
  }, [isOpen, activeTab]);

  const navItems: Array<{ id: SettingsNavTab; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: isFa ? 'ظاهر برنامه' : 'Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'language', label: isFa ? 'زبان و منطقه' : 'Language & Region', icon: <Globe className="w-4 h-4" /> },
    { id: 'workspace', label: isFa ? 'محیط تدوین' : 'Workspace', icon: <LayoutPanelLeft className="w-4 h-4" /> },
    { id: 'playback', label: isFa ? 'پخش و صوت' : 'Playback & Audio', icon: <Volume2 className="w-4 h-4" /> },
    { id: 'suggestions', label: isFa ? 'پیشنهادهای هوشمند' : 'Smart Suggestions', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'exportDefaults', label: isFa ? 'تنظیمات خروجی' : 'Export Defaults', icon: <Download className="w-4 h-4" /> },
    { id: 'shortcuts', label: isFa ? 'میانبرهای صفحه‌کلید' : 'Keyboard Shortcuts', icon: <Keyboard className="w-4 h-4" /> },
    { id: 'accessibility', label: isFa ? 'دسترس‌پذیری' : 'Accessibility', icon: <Accessibility className="w-4 h-4" /> },
    { id: 'storage', label: isFa ? 'ذخیره‌سازی و حریم خصوصی' : 'Storage & Privacy', icon: <HardDrive className="w-4 h-4" /> },
    { id: 'advanced', label: isFa ? 'تنظیمات پیشرفته' : 'Advanced', icon: <SlidersHorizontal className="w-4 h-4" /> },
  ];

  const handleResetConfirm = () => {
    if (confirmResetScope === 'all') {
      onUpdateSettings(resetAllGlobalSettings());
    } else if (confirmResetScope === 'category' && activeTab !== 'advanced') {
      onUpdateSettings(resetSettingsCategory(settings, activeTab));
    }
    setConfirmResetScope(null);
  };

  const shortcutLabels: Record<keyof KeyboardShortcutMap, string> = {
    playPause: isFa ? 'پخش / مکث' : 'Play / Pause',
    seekBackward: isFa ? 'عقب رفتن' : 'Seek Backward',
    seekForward: isFa ? 'جلو رفتن' : 'Seek Forward',
    toggleLoop: isFa ? 'تکرار (Loop)' : 'Toggle Loop',
    undo: isFa ? 'بازگشت (Undo)' : 'Undo',
    redo: isFa ? 'تکرار (Redo)' : 'Redo',
    clearSelection: isFa ? 'لغو انتخاب' : 'Clear Selection',
    openExport: isFa ? 'پنجره خروجی' : 'Open Export',
    openSettings: isFa ? 'تنظیمات' : 'Open Settings',
  };

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdropClick={!confirmResetScope}
      labelledBy="settings-center-title"
      dir={isFa ? 'rtl' : 'ltr'}
      disableEscape={Boolean(confirmResetScope)}
      dataTestId="settings-center-modal"
      panelClassName="w-full max-w-5xl"
    >
      <div className="w-full h-[min(86vh,760px)] rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text)] shadow-[var(--avp-shadow-md)] flex flex-col overflow-hidden">
        {/* Top Header */}
        <div className="px-6 py-4 border-b border-[var(--avp-border)] flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 id="settings-center-title" className="text-lg font-bold">
              {isFa ? 'تنظیمات' : 'Settings'}
            </h2>
            <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
              {isFa
                ? 'محیط و شیوه کار آواپرداز را مطابق نیاز خود تنظیم کنید. این تنظیمات عمومی‌اند و فایل پروژه‌ها را تغییر نمی‌دهند.'
                : 'Personalize your Avapardaz workspace. Global preferences never modify project audio or edit history.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              data-testid="settings-save-status"
              className={`text-xs font-medium inline-flex items-center gap-1 ${
                saveStatus === 'error'
                  ? 'text-[var(--avp-error)]'
                  : 'text-[var(--avp-text-secondary)]'
              }`}
            >
              {saveStatus === 'saved' && <Check className="w-3.5 h-3.5 text-[var(--avp-brand)]" />}
              {saveStatus === 'saved'
                ? isFa
                  ? 'ذخیره شد'
                  : 'Saved'
                : saveStatus === 'saving'
                  ? isFa
                    ? 'در حال ذخیره...'
                    : 'Saving...'
                  : saveError ?? (isFa ? 'خطا در ذخیره' : 'Save error')}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={isFa ? 'بستن تنظیمات' : 'Close settings'}
              className="avp-touch-icon sm:w-9 sm:h-9 rounded-xl border border-[var(--avp-border)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 2-Pane Body (Responsive mobile grouped <select> + desktop grouped sidebar) */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          {/* Mobile Category Picker (<768px) — eliminates blind horizontal overflow (AUD-16) */}
          <div className="md:hidden shrink-0 border-b border-[var(--avp-border)] bg-[var(--avp-bg)] px-4 py-2.5">
            <label htmlFor="settings-mobile-category-select" className="sr-only">
              {isFa ? 'انتخاب بخش تنظیمات' : 'Select settings category'}
            </label>
            <select
              id="settings-mobile-category-select"
              data-testid="settings-mobile-category-select"
              value={activeTab}
              onChange={(e) => setActiveTab(e.target.value as SettingsNavTab)}
              className="avp-select w-full min-h-[44px] text-xs font-semibold text-[var(--avp-text)] px-3"
            >
              <optgroup label={isFa ? 'محیط کار و ظاهر' : 'Workspace & UI'}>
                <option value="appearance">{isFa ? 'ظاهر برنامه' : 'Appearance'}</option>
                <option value="language">{isFa ? 'زبان و منطقه' : 'Language & Region'}</option>
                <option value="workspace">{isFa ? 'محیط تدوین' : 'Workspace'}</option>
                <option value="shortcuts">{isFa ? 'میانبرهای صفحه‌کلید' : 'Keyboard Shortcuts'}</option>
                <option value="accessibility">{isFa ? 'دسترس‌پذیری' : 'Accessibility'}</option>
              </optgroup>
              <optgroup label={isFa ? 'صوت، هوش مصنوعی و خروجی' : 'Audio, AI & Export'}>
                <option value="playback">{isFa ? 'پخش و صوت' : 'Playback & Audio'}</option>
                <option value="suggestions">{isFa ? 'پیشنهادهای هوشمند' : 'Smart Suggestions'}</option>
                <option value="exportDefaults">{isFa ? 'تنظیمات خروجی' : 'Export Defaults'}</option>
              </optgroup>
              <optgroup label={isFa ? 'فضای ذخیره و پیشرفته' : 'Storage & System'}>
                <option value="storage">{isFa ? 'ذخیره‌سازی و حریم خصوصی' : 'Storage & Privacy'}</option>
                <option value="advanced">{isFa ? 'تنظیمات پیشرفته' : 'Advanced'}</option>
              </optgroup>
            </select>
          </div>

          {/* Desktop Sidebar Navigation (Grouped into 3 Semantic Sections) */}
          <div
            role="tablist"
            aria-label={isFa ? 'دسته‌بندی تنظیمات' : 'Settings categories'}
            className="hidden md:flex md:w-[240px] shrink-0 md:border-e border-[var(--avp-border)] bg-[var(--avp-bg)] md:p-3 md:overflow-y-auto md:flex-col gap-3"
          >
            {[
              {
                groupTitle: isFa ? 'محیط کار و ظاهر' : 'Workspace & UI',
                ids: ['appearance', 'language', 'workspace', 'shortcuts', 'accessibility'] as SettingsNavTab[],
              },
              {
                groupTitle: isFa ? 'صوت، هوش مصنوعی و خروجی' : 'Audio, AI & Export',
                ids: ['playback', 'suggestions', 'exportDefaults'] as SettingsNavTab[],
              },
              {
                groupTitle: isFa ? 'فضای ذخیره و پیشرفته' : 'Storage & System',
                ids: ['storage', 'advanced'] as SettingsNavTab[],
              },
            ].map((group) => (
              <div key={group.groupTitle} className="flex md:flex-col gap-1 shrink-0">
                <div className="hidden md:block px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-[var(--avp-text-muted)]">
                  {group.groupTitle}
                </div>
                {group.ids.map((tabId) => {
                  const item = navItems.find((n) => n.id === tabId);
                  if (!item) return null;
                  const active = activeTab === item.id;
                  const tabOrder: SettingsNavTab[] = [
                    'appearance',
                    'language',
                    'workspace',
                    'shortcuts',
                    'accessibility',
                    'playback',
                    'suggestions',
                    'exportDefaults',
                    'storage',
                    'advanced',
                  ];
                  const idx = tabOrder.indexOf(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      data-testid={`settings-tab-${item.id}`}
                      onClick={() => setActiveTab(item.id)}
                      onKeyDown={(e) => {
                        const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 768;
                        const nextIdx = getNextRovingTabIndex(
                          idx,
                          tabOrder.length,
                          e.key,
                          isFa,
                          isDesktop ? 'vertical' : 'horizontal',
                        );
                        if (nextIdx !== null) {
                          e.preventDefault();
                          const nextId = tabOrder[nextIdx];
                          setActiveTab(nextId);
                          const el = e.currentTarget
                            .closest('[role="tablist"]')
                            ?.querySelector<HTMLButtonElement>(`[data-testid="settings-tab-${nextId}"]`);
                          el?.focus();
                        }
                      }}
                      className={`min-h-[44px] md:min-h-[36px] md:h-9 px-3 rounded-[var(--avp-radius-md)] text-xs font-medium inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                        active
                          ? 'bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] font-semibold'
                          : 'text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)]'
                      }`}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Content Area */}
          <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-6">
            {activeTab === 'appearance' && (
              <section className="space-y-5">
                <div>
                  <h3 className="text-sm font-bold">{isFa ? 'ظاهر برنامه' : 'Appearance'}</h3>
                  <p className="text-xs text-[var(--avp-text-secondary)] mt-1">
                    {isFa
                      ? 'تم روشن حالت پیش‌فرض اولین اجرا است و انتخاب شما میان نشست‌ها ذخیره می‌شود.'
                      : 'Light theme is the first-launch default. Your explicit choice persists across reloads.'}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(['light', 'dark', 'system'] as const).map((choice) => {
                    const selected = settings.appearance.theme === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        data-testid={`settings-theme-${choice}`}
                        onClick={() =>
                          onUpdateSettings({
                            ...settings,
                            appearance: { ...settings.appearance, theme: choice },
                          })
                        }
                        className={`p-3.5 rounded-xl border text-start space-y-2.5 cursor-pointer ${
                          selected
                            ? 'border-[var(--avp-brand)] bg-[var(--avp-brand-soft)]'
                            : 'border-[var(--avp-border)] bg-[var(--avp-bg)] hover:bg-[var(--avp-hover)]'
                        }`}
                      >
                        <div
                          className={`h-12 rounded-lg border p-2 flex flex-col justify-between ${
                            choice === 'dark'
                              ? 'bg-[#101720] border-[#2E3B48]'
                              : choice === 'light'
                                ? 'bg-[#FAFBFC] border-[#E1E6E9]'
                                : 'bg-gradient-to-r from-[#FAFBFC] to-[#101720] border-[#8B959E]/40'
                          }`}
                        >
                          <div className="h-1.5 w-10 rounded bg-[#16816F]" />
                          <div className="h-3 rounded bg-[#0D1520] flex items-center px-1.5">
                            <div className="h-1 w-full rounded bg-[#43C7A7]/80" />
                          </div>
                        </div>
                        <div className="text-xs font-semibold">
                          {choice === 'light'
                            ? isFa
                              ? 'روشن (پیش‌فرض)'
                              : 'Light (Default)'
                            : choice === 'dark'
                              ? isFa
                                ? 'تیره'
                                : 'Dark'
                              : isFa
                                ? 'هماهنگ با سیستم'
                                : 'Follow System'}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <label className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold">
                      {isFa ? 'خطوط راهنمای زمانی روی Waveform' : 'Show subtle time grid on Waveform'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)]">
                      {isFa ? 'نمایش خطوط عمودی کم‌رنگ در ناحیه تایملاین' : 'Display subtle vertical time markers'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.appearance.showWaveformGrid}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        appearance: { ...settings.appearance, showWaveformGrid: e.target.checked },
                      })
                    }
                    className="w-4 h-4 accent-[var(--avp-brand)]"
                  />
                </label>
              </section>
            )}

            {activeTab === 'language' && (
              <section className="space-y-5">
                <h3 className="text-sm font-bold">{isFa ? 'زبان و منطقه' : 'Language & Region'}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(['fa', 'en'] as const).map((loc) => (
                    <button
                      key={loc}
                      type="button"
                      data-testid={`settings-locale-${loc}`}
                      onClick={() =>
                        onUpdateSettings({
                          ...settings,
                          language: { ...settings.language, locale: loc },
                        })
                      }
                      className={`p-4 rounded-xl border text-start cursor-pointer ${
                        settings.language.locale === loc
                          ? 'border-[var(--avp-brand)] bg-[var(--avp-brand-soft)]'
                          : 'border-[var(--avp-border)] bg-[var(--avp-bg)] hover:bg-[var(--avp-hover)]'
                      }`}
                    >
                      <div className="text-sm font-bold">{loc === 'fa' ? 'فارسی (RTL)' : 'English (LTR)'}</div>
                      <div className="text-xs text-[var(--avp-text-secondary)] mt-1">
                        {loc === 'fa'
                          ? 'جهت راست‌به‌چپ کامل با حفظ اعداد فنی و تایم‌کد LTR'
                          : 'Full Left-to-Right studio layout with tabular timecodes'}
                      </div>
                    </button>
                  ))}
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold">
                    {isFa ? 'قالب نمایش تایم‌کد' : 'Timecode Display Format'}
                  </span>
                  <select
                    value={settings.language.timecodeFormat}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        language: {
                          ...settings.language,
                          timecodeFormat: e.target.value as 'mm:ss.ms' | 'hh:mm:ss',
                        },
                      })
                    }
                    className="w-full max-w-xs h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs font-mono"
                    dir="ltr"
                  >
                    <option value="mm:ss.ms">00:00.000 (MM:SS.ms)</option>
                    <option value="hh:mm:ss">00:00:00 (HH:MM:SS)</option>
                  </select>
                </label>

                <label className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold">
                      {isFa ? 'نمایش اعداد با ارقام فارسی (۰-۹)' : 'Use Persian Numerals (۰-۹)'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)]">
                      {isFa
                        ? 'تبدیل ارقام شمارنده‌ها، تایم‌کدها و آمارهای رابط به ارقام فارسی'
                        : 'Render UI counters, timecodes, and metrics with Persian digits'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="settings-persian-digits"
                    checked={settings.language.persianDigits}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        language: { ...settings.language, persianDigits: e.target.checked },
                      })
                    }
                    className="w-4 h-4 accent-[var(--avp-brand)]"
                  />
                </label>
              </section>
            )}

            {activeTab === 'workspace' && (
              <section className="space-y-4">
                <h3 className="text-sm font-bold">{isFa ? 'محیط تدوین' : 'Workspace Preferences'}</h3>
                <div className="space-y-3">
                  {[
                    {
                      key: 'showSuggestionsPanel' as const,
                      label: isFa ? 'نمایش پنل پیشنهادهای هوشمند به‌صورت پیش‌فرض' : 'Show Smart Suggestions panel by default',
                    },
                    {
                      key: 'showFilesPanel' as const,
                      label: isFa ? 'نمایش پنل فایل‌ها و ترک‌ها به‌صورت پیش‌فرض' : 'Show Files & Tracks panel by default',
                    },
                    {
                      key: 'showTimelineRuler' as const,
                      label: isFa ? 'نمایش خط‌کش زمانی (Time Ruler)' : 'Show Timeline Time Ruler',
                    },
                    {
                      key: 'showTimelineMarkers' as const,
                      label: isFa ? 'نمایش نشانگرها (Markers) روی تایملاین' : 'Show Markers on Timeline',
                    },
                    {
                      key: 'showEditRegions' as const,
                      label: isFa ? 'نمایش محدوده‌های تدوین و پیشنهاد روی تایملاین' : 'Show Edit & Suggestion overlays on Timeline',
                    },
                    {
                      key: 'resetZoomOnProjectOpen' as const,
                      label: isFa ? 'بازنشانی بزرگ‌نمایی تایملاین هنگام باز کردن پروژه جدید' : 'Reset timeline zoom on project open',
                    },
                  ].map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer"
                    >
                      <span className="text-xs font-medium">{item.label}</span>
                      <input
                        type="checkbox"
                        checked={settings.workspace[item.key]}
                        onChange={(e) =>
                          onUpdateSettings({
                            ...settings,
                            workspace: { ...settings.workspace, [item.key]: e.target.checked },
                          })
                        }
                        className="w-4 h-4 accent-[var(--avp-brand)]"
                      />
                    </label>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold block">
                      {isFa ? 'تراکم چیدمان (Density)' : 'Workspace Density'}
                    </span>
                    <div className="inline-flex rounded-xl border border-[var(--avp-border)] p-1 bg-[var(--avp-bg)] gap-1">
                      {(['comfortable', 'compact'] as WorkspaceDensity[]).map((den) => (
                        <button
                          key={den}
                          type="button"
                          data-testid={`settings-density-${den}`}
                          onClick={() =>
                            onUpdateSettings({
                              ...settings,
                              workspace: { ...settings.workspace, density: den },
                            })
                          }
                          className={`px-3.5 py-1.5 min-h-[44px] sm:min-h-[32px] rounded-lg text-xs font-medium cursor-pointer ${
                            settings.workspace.density === den
                              ? 'bg-[var(--avp-brand-solid)] text-[var(--avp-on-brand)]'
                              : 'text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)]'
                          }`}
                        >
                          {den === 'comfortable'
                            ? isFa
                              ? 'راحت (پیش‌فرض)'
                              : 'Comfortable'
                            : isFa
                              ? 'فشرده'
                              : 'Compact'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold block">
                      {isFa ? 'اندازه متن تدوین (Transcript)' : 'Transcript Text Size'}
                    </span>
                    <div className="inline-flex rounded-xl border border-[var(--avp-border)] p-1 bg-[var(--avp-bg)] gap-1">
                      {(['sm', 'md', 'lg'] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() =>
                            onUpdateSettings({
                              ...settings,
                              workspace: { ...settings.workspace, transcriptFontScale: sz },
                              accessibility: { ...settings.accessibility, fontScale: sz },
                            })
                          }
                          className={`px-3.5 py-1.5 min-h-[44px] sm:min-h-[32px] rounded-lg text-xs font-medium cursor-pointer ${
                            settings.workspace.transcriptFontScale === sz
                              ? 'bg-[var(--avp-brand-solid)] text-[var(--avp-on-brand)]'
                              : 'text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)]'
                          }`}
                        >
                          {sz === 'sm' ? (isFa ? 'کوچک' : 'Small') : sz === 'md' ? (isFa ? 'متوسط' : 'Medium') : isFa ? 'بزرگ' : 'Large'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <span className="text-xs font-semibold block">
                    {isFa ? 'جایگاه پنل بازرس هوشمند (Inspector Side)' : 'Smart Inspector Placement'}
                  </span>
                  <div className="inline-flex flex-wrap rounded-xl border border-[var(--avp-border)] p-1 bg-[var(--avp-bg)] gap-1">
                    {(['auto', 'right', 'left'] as WorkspaceInspectorSide[]).map((side) => (
                      <button
                        key={side}
                        type="button"
                        data-testid={`settings-inspector-side-${side}`}
                        onClick={() =>
                          onUpdateSettings({
                            ...settings,
                            workspace: { ...settings.workspace, inspectorSide: side },
                          })
                        }
                        className={`px-3.5 py-1.5 min-h-[44px] sm:min-h-[32px] rounded-lg text-xs font-medium cursor-pointer ${
                          settings.workspace.inspectorSide === side
                            ? 'bg-[var(--avp-brand-solid)] text-[var(--avp-on-brand)]'
                            : 'text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)]'
                        }`}
                      >
                        {side === 'auto'
                          ? isFa
                            ? 'خودکار (بر اساس جهت زبان)'
                            : 'Auto (RTL/LTR)'
                          : side === 'right'
                            ? isFa
                              ? 'سمت راست'
                              : 'Right'
                            : isFa
                              ? 'سمت چپ'
                              : 'Left'}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {activeTab === 'playback' && (
              <section className="space-y-4">
                <h3 className="text-sm font-bold">{isFa ? 'پخش و صوت' : 'Playback & Audio'}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'سرعت پیش‌فرض پخش' : 'Default Playback Rate'}
                    </span>
                    <select
                      dir="ltr"
                      data-testid="settings-playback-rate"
                      value={settings.playback.defaultRate}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          playback: {
                            ...settings.playback,
                            defaultRate: Number(e.target.value) as SupportedPlaybackRate,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs font-mono"
                    >
                      {SUPPORTED_PLAYBACK_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r.toFixed(2).replace(/\.00$/, '.0')}x
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'گام جابه‌جایی (Seek Step)' : 'Seek Step Interval'}
                    </span>
                    <select
                      value={settings.playback.seekStepSec}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          playback: {
                            ...settings.playback,
                            seekStepSec: Number(e.target.value) as 1 | 5 | 10,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs"
                    >
                      <option value={1}>{isFa ? '۱ ثانیه (کوتاه)' : '1 second (Short)'}</option>
                      <option value={5}>{isFa ? '۵ ثانیه (متوسط)' : '5 seconds (Medium)'}</option>
                      <option value={10}>{isFa ? '۱۰ ثانیه (بلند)' : '10 seconds (Long)'}</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'حاشیه پیش‌شنوایی قبل از محدوده' : 'Context Before Preview'}
                    </span>
                    <select
                      value={settings.playback.contextBeforeSec}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          playback: {
                            ...settings.playback,
                            contextBeforeSec: Number(e.target.value) as 0.5 | 1 | 1.5 | 2,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs"
                    >
                      <option value={0.5}>{isFa ? '۰.۵ ثانیه' : '0.5 s'}</option>
                      <option value={1}>{isFa ? '۱ ثانیه' : '1.0 s'}</option>
                      <option value={1.5}>{isFa ? '۱.۵ ثانیه' : '1.5 s'}</option>
                      <option value={2}>{isFa ? '۲ ثانیه' : '2.0 s'}</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'حاشیه پیش‌شنوایی بعد از محدوده' : 'Context After Preview'}
                    </span>
                    <select
                      value={settings.playback.contextAfterSec}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          playback: {
                            ...settings.playback,
                            contextAfterSec: Number(e.target.value) as 0.5 | 1 | 1.5 | 2,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs"
                    >
                      <option value={0.5}>{isFa ? '۰.۵ ثانیه' : '0.5 s'}</option>
                      <option value={1}>{isFa ? '۱ ثانیه' : '1.0 s'}</option>
                      <option value={1.5}>{isFa ? '۱.۵ ثانیه' : '1.5 s'}</option>
                      <option value={2}>{isFa ? '۲ ثانیه' : '2.0 s'}</option>
                    </select>
                  </label>
                </div>

                <div className="space-y-2.5">
                  {[
                    {
                      key: 'stopAtPreviewEnd' as const,
                      label: isFa
                        ? 'توقف خودکار پخش در پایان بازه پیش‌شنوایی / انتخاب'
                        : 'Stop playback automatically at end of selection/preview',
                    },
                    {
                      key: 'loopEnabledByDefault' as const,
                      label: isFa
                        ? 'فعال‌بودن تکرار (Loop) به‌صورت پیش‌فرض هنگام باز کردن پروژه'
                        : 'Enable Loop mode by default on project open',
                    },
                  ].map((opt) => (
                    <label
                      key={opt.key}
                      className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer"
                    >
                      <span className="text-xs font-medium">{opt.label}</span>
                      <input
                        type="checkbox"
                        checked={settings.playback[opt.key]}
                        onChange={(e) =>
                          onUpdateSettings({
                            ...settings,
                            playback: { ...settings.playback, [opt.key]: e.target.checked },
                          })
                        }
                        className="w-4 h-4 accent-[var(--avp-brand)]"
                      />
                    </label>
                  ))}
                </div>

                <p className="text-[11px] text-[var(--avp-text-secondary)] rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3">
                  {isFa
                    ? 'نکته فنی موتور پخش: تغییر سرعت از طریق Web Audio AudioBufferSourceNode.playbackRate انجام می‌شود و تغییر سرعت همراه با تغییر Pitch است (بدون ادعای Pitch-Preserving مصنوعی).'
                    : 'Audio Engine note: Playback speed uses native Web Audio AudioBufferSourceNode.playbackRate (pitch scales with rate; no unverified pitch-preservation claim).'}
                </p>
              </section>
            )}

            {activeTab === 'suggestions' && (
              <section className="space-y-4">
                <h3 className="text-sm font-bold">{isFa ? 'پیشنهادهای هوشمند' : 'Smart Suggestions'}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'دسته فیلتر پیش‌فرض' : 'Default Category Filter'}
                    </span>
                    <select
                      value={settings.suggestions.defaultCategory}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          suggestions: {
                            ...settings.suggestions,
                            defaultCategory: e.target.value as SuggestionCategoryFilter,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs"
                    >
                      <option value="all">{isFa ? 'همه دسته‌ها' : 'All Categories'}</option>
                      <option value="filler">{isFa ? 'تپق و گفتار ناخواسته' : 'Fillers & Disfluencies'}</option>
                      <option value="pause">{isFa ? 'مکث و سکوت' : 'Pauses & Silence'}</option>
                      <option value="repetition">{isFa ? 'تکرار گفتار' : 'Repetitions'}</option>
                      <option value="breath">{isFa ? 'نفس اضافی' : 'Breath / Non-verbal'}</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'ترتیب نمایش پیش‌فرض' : 'Default Sort Order'}
                    </span>
                    <select
                      value={settings.suggestions.defaultSort}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          suggestions: {
                            ...settings.suggestions,
                            defaultSort: e.target.value as SuggestionSortOrder,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs"
                    >
                      <option value="time">{isFa ? 'زمان در فایل' : 'Timeline Position'}</option>
                      <option value="category">{isFa ? 'نوع تشخیص' : 'Category'}</option>
                      <option value="confidence">{isFa ? 'میزان اطمینان' : 'Confidence'}</option>
                      <option value="order">{isFa ? 'ترتیب تولید' : 'Detection Order'}</option>
                    </select>
                  </label>
                </div>

                {[
                  {
                    key: 'showContextTranscript' as const,
                    label: isFa ? 'نمایش متن اطراف محدوده در بازبینی پیشنهاد' : 'Show surrounding transcript context',
                  },
                  {
                    key: 'confirmBeforeApply' as const,
                    label: isFa ? 'نمایش خلاصه Edit Plan پیش از اعمال حذف گروهی' : 'Show Edit Plan confirmation before batch apply',
                  },
                  {
                    key: 'autoExpandDetails' as const,
                    label: isFa ? 'نمایش خودکار پیش‌نمایش موجی در پنل پیشنهادها' : 'Auto-expand mini waveform diff preview',
                  },
                  {
                    key: 'focusNextAfterReview' as const,
                    label: isFa ? 'انتقال خودکار انتخاب به پیشنهاد بعدی پس از تأیید یا رد' : 'Auto-focus next pending suggestion after review',
                  },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer"
                  >
                    <span className="text-xs font-medium">{opt.label}</span>
                    <input
                      type="checkbox"
                      checked={settings.suggestions[opt.key]}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          suggestions: { ...settings.suggestions, [opt.key]: e.target.checked },
                        })
                      }
                      className="w-4 h-4 accent-[var(--avp-brand)]"
                    />
                  </label>
                ))}
              </section>
            )}

            {activeTab === 'exportDefaults' && (
              <section className="space-y-4">
                <h3 className="text-sm font-bold">{isFa ? 'تنظیمات پیش‌فرض خروجی' : 'Export Defaults'}</h3>
                <p className="text-xs text-[var(--avp-text-secondary)]">
                  {isFa
                    ? 'فقط انکودرهای واقعی و اعتبارسنجی‌شده در موتور رندر غیرمخرب نمایش داده می‌شوند.'
                    : 'Only real, independently validated encoders supported by the local AudioRenderEngine are listed.'}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">{isFa ? 'فرمت پیش‌فرض' : 'Default Format'}</span>
                    <select
                      dir="ltr"
                      value={settings.exportDefaults.format}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          exportDefaults: {
                            ...settings.exportDefaults,
                            format: e.target.value as ExportDefaultFormat,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs font-mono"
                    >
                      <option value="WAV_PCM16">WAV PCM 16-bit (Standard)</option>
                      <option value="WAV_PCM24">WAV PCM 24-bit (Broadcast)</option>
                      <option value="WAV_FLOAT32">WAV IEEE Float 32-bit (Master)</option>
                      <option value="RF64_PCM24">RF64 PCM 24-bit (&gt;4 GiB Long Form)</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">{isFa ? 'نرخ نمونه‌برداری' : 'Sample Rate'}</span>
                    <select
                      dir="ltr"
                      value={settings.exportDefaults.sampleRate}
                      onChange={(e) => {
                        const v = e.target.value;
                        onUpdateSettings({
                          ...settings,
                          exportDefaults: {
                            ...settings.exportDefaults,
                            sampleRate: v === 'source' ? 'source' : (Number(v) as 16000 | 44100 | 48000),
                          },
                        });
                      }}
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs font-mono"
                    >
                      <option value="source">{isFa ? 'حفظ نرخ اصلی فایل' : 'Keep Source Sample Rate'}</option>
                      <option value={16000}>16000 Hz</option>
                      <option value={44100}>44100 Hz</option>
                      <option value={48000}>48000 Hz</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'محوشدگی پیش‌فرض مرز برش (Crossfade)' : 'Default Splice Crossfade'}
                    </span>
                    <select
                      dir="ltr"
                      value={settings.exportDefaults.defaultCrossfadeMs}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          exportDefaults: {
                            ...settings.exportDefaults,
                            defaultCrossfadeMs: Number(e.target.value) as 0 | 5 | 10 | 15,
                          },
                        })
                      }
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs font-mono"
                    >
                      <option value={0}>0 ms (Hard Cut)</option>
                      <option value={5}>5 ms</option>
                      <option value={10}>10 ms (Default)</option>
                      <option value={15}>15 ms</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold">
                      {isFa ? 'پیشوند نام فایل خروجی' : 'Filename Prefix'}
                    </span>
                    <input
                      type="text"
                      dir="auto"
                      value={settings.exportDefaults.filenamePrefix}
                      onChange={(e) =>
                        onUpdateSettings({
                          ...settings,
                          exportDefaults: {
                            ...settings.exportDefaults,
                            filenamePrefix: e.target.value,
                          },
                        })
                      }
                      placeholder={isFa ? 'مثلاً avapardaz_' : 'e.g. avapardaz_'}
                      className="w-full h-10 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] px-3 text-xs"
                    />
                  </label>
                </div>
              </section>
            )}

            {activeTab === 'shortcuts' && (
              <section className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold">{isFa ? 'میانبرهای صفحه‌کلید' : 'Keyboard Shortcuts'}</h3>
                    <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
                      {isFa
                        ? 'میانبرها هنگام تایپ در فیلدهای متنی اجرا نمی‌شوند و از تداخل با کلیدهای مرورگر جلوگیری می‌شود.'
                        : 'Shortcuts automatically pause while typing in inputs and prevent browser conflicts.'}
                    </p>
                  </div>
                  {onOpenShortcutsCheatSheet && (
                    <button
                      type="button"
                      data-testid="btn-settings-open-shortcuts-sheet"
                      onClick={() => {
                        onClose();
                        onOpenShortcutsCheatSheet();
                      }}
                      className="avp-btn avp-btn-sm avp-btn-outline"
                    >
                      <Keyboard className="w-3.5 h-3.5" />
                      <span>{isFa ? 'راهنمای کامل میانبرها (? / Ctrl+K)' : 'Full Cheat Sheet (? / Ctrl+K)'}</span>
                    </button>
                  )}
                </div>
                {shortcutError && (
                  <p className="text-xs text-[var(--avp-error)]" role="alert">
                    {shortcutError}
                  </p>
                )}
                <div className="divide-y divide-[var(--avp-border)] rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] overflow-hidden">
                  {(Object.keys(settings.shortcuts) as Array<keyof KeyboardShortcutMap>).map((k) => (
                    <div key={k} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                      <label htmlFor={`shortcut-input-${k}`} className="font-medium text-[var(--avp-text)]">
                        {shortcutLabels[k]}
                      </label>
                      <input
                        id={`shortcut-input-${k}`}
                        dir="ltr"
                        type="text"
                        value={settings.shortcuts[k]}
                        onChange={(e) => {
                          const nextVal = e.target.value;
                          const check = validateShortcutBinding(k, nextVal, settings.shortcuts);
                          if (!check.valid) {
                            setShortcutError(
                              isFa
                                ? `میانبر نامعتبر یا تکراری (${check.reason})`
                                : `Invalid or conflicting shortcut (${check.reason})`,
                            );
                            return;
                          }
                          setShortcutError(null);
                          onUpdateSettings({
                            ...settings,
                            shortcuts: { ...settings.shortcuts, [k]: nextVal.trim() },
                          });
                        }}
                        className="w-36 min-h-[44px] sm:min-h-[34px] sm:h-8 px-2.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-center font-mono text-[11px]"
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {activeTab === 'accessibility' && (
              <section className="space-y-4">
                <h3 className="text-sm font-bold">{isFa ? 'دسترس‌پذیری' : 'Accessibility'}</h3>
                <label className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold">
                      {isFa ? 'کاهش حرکت و انیمیشن (Reduced Motion)' : 'Reduced Motion'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)]">
                      {isFa ? 'حذف انتقال‌های متحرک اضافی در کل رابط' : 'Minimize UI transitions and motion'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.accessibility.motion === 'reduced'}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        accessibility: {
                          ...settings.accessibility,
                          motion: e.target.checked ? 'reduced' : 'normal',
                        },
                      })
                    }
                    className="w-4 h-4 accent-[var(--avp-brand)]"
                  />
                </label>

                <label className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold">
                      {isFa ? 'کنتراست بالاتر مرزها و متن‌های کمکی' : 'Higher Border & Secondary Text Contrast'}
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-secondary)]">
                      {isFa ? 'افزایش خوانایی مرز پنل‌ها در هر دو تم' : 'Strengthen panel borders and muted text contrast'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.accessibility.highContrast}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        accessibility: {
                          ...settings.accessibility,
                          highContrast: e.target.checked,
                        },
                      })
                    }
                    className="w-4 h-4 accent-[var(--avp-brand)]"
                  />
                </label>
              </section>
            )}

            {activeTab === 'storage' && (
              <section className="space-y-4">
                <h3 className="text-sm font-bold">
                  {isFa ? 'ذخیره‌سازی محلی و حریم خصوصی' : 'Local Storage & Privacy'}
                </h3>
                <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-4 space-y-2 text-xs text-[var(--avp-text-secondary)]">
                  <p>
                    {isFa
                      ? '• پروژه‌ها و فایل‌های صوتی واردشده در IndexedDB مرورگر شما ذخیره می‌شوند و با کپی پروژه به‌شکل ایمن (Ref-Counted) مدیریت می‌گردند.'
                      : '• Projects and imported audio files are persisted locally inside your browser IndexedDB with ref-counted audio blobs.'}
                  </p>
                  <p>
                    {isFa
                      ? '• پردازش صوتی پایه، تایملاین، تدوین غیرمخرب و خروجی WAV به‌صورت محلی روی دستگاه انجام می‌شوند. تنها در حالت انتخاب صریح «ابری» درخواست به مسیر API ارسال می‌شود.'
                      : '• Core audio decoding, timeline editing, and WAV export run locally on-device. External API requests occur only if Cloud mode is explicitly chosen.'}
                  </p>
                </div>

                {storageEstimate && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3">
                      <div className="text-[11px] text-[var(--avp-text-muted)]">
                        {isFa ? 'تعداد پروژه‌ها' : 'Projects'}
                      </div>
                      <div className="text-base font-bold tabular-nums mt-1">
                        {storageEstimate.projectCount}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3">
                      <div className="text-[11px] text-[var(--avp-text-muted)]">
                        {isFa ? 'حجم صوت ذخیره‌شده' : 'Stored Audio'}
                      </div>
                      <div className="text-base font-bold tabular-nums mt-1">
                        {formatAudioByteSize(storageEstimate.totalAudioBytes, settings.language.locale)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3">
                      <div className="text-[11px] text-[var(--avp-text-muted)]">
                        {isFa ? 'مصرف تخمینی مرورگر' : 'Est. Usage'}
                      </div>
                      <div className="text-base font-bold tabular-nums mt-1">
                        {storageEstimate.usageBytes !== null
                          ? formatAudioByteSize(storageEstimate.usageBytes, settings.language.locale)
                          : '—'}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-3">
                      <div className="text-[11px] text-[var(--avp-text-muted)]">
                        {isFa ? 'سهمیه تقریبی' : 'Est. Quota'}
                      </div>
                      <div className="text-base font-bold tabular-nums mt-1">
                        {storageEstimate.quotaBytes !== null
                          ? formatAudioByteSize(storageEstimate.quotaBytes, settings.language.locale)
                          : '—'}
                      </div>
                    </div>
                  </div>
                )}

                <label className="flex items-center justify-between gap-4 p-3.5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] cursor-pointer">
                  <span className="text-xs font-medium">
                    {isFa ? 'ذخیره خودکار تغییرات پروژه در IndexedDB' : 'Auto-save project edits to local IndexedDB'}
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.storage.autoSaveProjectEdits}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        storage: { autoSaveProjectEdits: e.target.checked },
                      })
                    }
                    className="w-4 h-4 accent-[var(--avp-brand)]"
                  />
                </label>
              </section>
            )}

            {activeTab === 'advanced' && (
              <section className="space-y-5">
                <div>
                  <h3 className="text-sm font-bold flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-[var(--avp-brand)]" />
                    <span>{isFa ? 'تنظیمات پیشرفته و یکپارچه‌سازی' : 'Advanced & Integrations'}</span>
                  </h3>
                  <p className="text-xs text-[var(--avp-text-secondary)] mt-1">
                    {isFa
                      ? `نسخه طرح تنظیمات: v${SETTINGS_SCHEMA_VERSION} · هسته پردازش صوت محلی v1.2`
                      : `Settings Schema: v${SETTINGS_SCHEMA_VERSION} · Local Audio Processing Core v1.2`}
                  </p>
                </div>

                {/* Honest Adobe Audition Capability Matrix */}
                <div className="rounded-xl border border-[var(--avp-border)] bg-[var(--avp-bg)] p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-bold">
                      {isFa
                        ? 'ماتریس قابلیت‌های واقعی Adobe Audition'
                        : 'Adobe Audition Host Capability Matrix'}
                    </h4>
                    <span className="text-[11px] font-mono text-[var(--avp-text-muted)]">
                      SESX v1.9 + Companion IPC
                    </span>
                  </div>
                  <div className="space-y-2">
                    {auditionCapabilities.map((cap) => (
                      <div
                        key={cap.feature_id}
                        className="rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] p-2.5 text-[11px] flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div>
                          <div className="font-semibold text-[var(--avp-text)]">
                            {cap.required_host_operation}
                          </div>
                          <div className="text-[var(--avp-text-secondary)] mt-0.5">
                            {cap.integration_mechanism}
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[11px] shrink-0 ${
                            cap.verification_state === 'VERIFIED_CONTRACT_AND_SCHEMA'
                              ? 'bg-[var(--avp-ready-bg)] text-[var(--avp-ready-text)]'
                              : 'bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)]'
                          }`}
                        >
                          {cap.verification_state === 'VERIFIED_CONTRACT_AND_SCHEMA'
                            ? isFa
                              ? 'قرارداد تأییدشده'
                              : 'Schema Verified'
                            : isFa
                              ? 'نیازمند Audition دسکتاپ'
                              : 'Requires Desktop Audition'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Clean Product Health & Companion Tools + Strict ?mode=lab Engineering Gate */}
                {onOpenDeveloperView && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold text-[var(--avp-text-secondary)]">
                        {isFa ? 'موتور صوتی آفلاین و اتصال دسکتاپ' : 'Offline Speech Engine & Desktop Bridge'}
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {(
                          [
                            {
                              id: 'lifecycle',
                              label: isFa
                                ? 'وضعیت موتور صوتی، مدل‌های محلی و آفلاین'
                                : 'Local Speech Engine, Models & Offline Status',
                            },
                            { id: 'companion', label: isFa ? 'اتصال Companion / Audition' : 'Companion / Audition Bridge' },
                          ] as const
                        ).map((tool) => (
                          <button
                            key={tool.id}
                            type="button"
                            data-testid={tool.id === 'lifecycle' ? 'btn-open-lifecycle-from-settings' : undefined}
                            onClick={() => {
                              onClose();
                              onOpenDeveloperView(tool.id);
                            }}
                            className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[34px]"
                          >
                            {tool.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {isLabMode && (
                      <div className="space-y-2 pt-2 border-t border-[var(--avp-border)]">
                        <h4 className="text-xs font-bold text-[var(--avp-warning-text)]">
                          {isFa ? 'ابزارهای مهندسی و آزمایشگاه (?mode=lab)' : 'Engineering & R&D Lab Tools (?mode=lab)'}
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {(
                            [
                              { id: 'graph', label: isFa ? 'گراف پردازش و PDC' : 'Processing Graph & PDC' },
                              { id: 'storage', label: isFa ? 'ذخیره‌سازی OPFS' : 'OPFS Storage Broker' },
                              { id: 'shahab', label: 'SHAHAB LAB' },
                              { id: 'asr-lab', label: isFa ? 'آزمایشگاه ASR' : 'ASR Research Lab' },
                              { id: 'security', label: isFa ? 'امنیت و حریم خصوصی' : 'Speech Security' },
                              { id: 'dev-portal', label: isFa ? 'پورتال توسعه‌دهندگان API' : 'Developer API Portal' },
                            ] as const
                          ).map((tool) => (
                            <button
                              key={tool.id}
                              type="button"
                              onClick={() => {
                                onClose();
                                onOpenDeveloperView(tool.id);
                              }}
                              className="avp-btn avp-btn-sm avp-btn-outline"
                            >
                              {tool.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>

        {/* Footer Reset Actions */}
        <div className="px-6 py-3.5 border-t border-[var(--avp-border)] bg-[var(--avp-bg)] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {activeTab !== 'advanced' && (
              <button
                type="button"
                data-testid="btn-reset-settings-category"
                onClick={() => setConfirmResetScope('category')}
                className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[36px]"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{isFa ? 'بازنشانی این بخش' : 'Reset Category'}</span>
              </button>
            )}
            <button
              type="button"
              data-testid="btn-reset-all-settings"
              onClick={() => setConfirmResetScope('all')}
              className="avp-btn avp-btn-danger-ghost min-h-[44px] sm:min-h-[36px]"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{isFa ? 'بازنشانی تمام تنظیمات عمومی' : 'Reset All Global Settings'}</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px]"
          >
            {isFa ? 'بستن' : 'Done'}
          </button>
        </div>
      </div>

      {/* Scoped Reset Confirmation Dialog */}
      <AccessibleModal
        isOpen={Boolean(confirmResetScope)}
        onClose={() => setConfirmResetScope(null)}
        labelledBy="settings-reset-confirm-title"
        dir={isFa ? 'rtl' : 'ltr'}
        zIndexClassName="z-[var(--avp-z-confirm)]"
        panelClassName="w-full max-w-md"
      >
        <div className="w-full rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-6 space-y-4 shadow-[var(--avp-shadow-md)] text-[var(--avp-text)]">
          <div className="flex items-center gap-2.5 text-[var(--avp-warning)]">
            <AlertTriangle className="w-5 h-5" />
            <h3 id="settings-reset-confirm-title" className="text-sm font-bold text-[var(--avp-text)]">
              {confirmResetScope === 'all'
                ? isFa
                  ? 'بازنشانی تمام تنظیمات عمومی؟'
                  : 'Reset all global settings?'
                : isFa
                  ? 'بازنشانی این دسته از تنظیمات؟'
                  : 'Reset this settings category?'}
            </h3>
          </div>
          <p className="text-xs leading-relaxed text-[var(--avp-text-secondary)]">
            {isFa
              ? 'این عملیات فقط ترجیحات عمومی رابط را به پیش‌فرض برمی‌گرداند و هیچ پروژه، فایل صوتی، متن یا تاریخچه تدوین شما حذف نمی‌شود.'
              : 'This resets global preferences to safe defaults. None of your projects, audio files, transcripts, or edit histories will be deleted.'}
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmResetScope(null)}
              className="avp-btn avp-btn-outline"
            >
              {isFa ? 'انصراف' : 'Cancel'}
            </button>
            <button
              type="button"
              data-testid="btn-confirm-settings-reset"
              onClick={handleResetConfirm}
              className="avp-btn avp-btn-primary"
            >
              {isFa ? 'تأیید بازنشانی' : 'Confirm Reset'}
            </button>
          </div>
        </div>
      </AccessibleModal>
    </AccessibleModal>
  );
};
