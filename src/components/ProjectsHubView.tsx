import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  FileAudio,
  FolderOpen,
  Languages,
  LayoutGrid,
  List,
  Loader2,
  Moon,
  MoreVertical,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  PersistedProjectSummary,
  ProjectFilterTab,
  ProjectLifecycleStatus,
  ProjectSortField,
  filterAndSortProjects,
} from '../projects/projectLibraryLogic';
import { GlobalAppBar } from './GlobalAppBar';
import { AccessibleModal } from './AccessibleModal';
import { OfflineIndicator, PWAInstallButton } from '../ui/pwa/PWAInstallControls';
import { formatNumberForLocale, toPersianDigits } from '../utils/formatters';

interface ProjectsHubViewProps {
  locale: 'fa' | 'en';
  theme: 'light' | 'dark';
  persianDigits?: boolean;
  projects: PersistedProjectSummary[];
  isLoading: boolean;
  errorMessage: string | null;
  corruptedCount: number;
  onRetryLoad: () => void;
  onOpenNewProjectModal: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSampleStudio: () => void;
  onRenameProject: (projectId: string, newTitle: string) => Promise<void>;
  onDuplicateProject: (projectId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onOpenSettings: () => void;
  onOpenLifecycleModal?: () => void;
}

type HubViewMode = 'grid' | 'table';

function formatAudioDurationClock(sec: number, persianDigits = false): string {
  const safe = Math.max(0, Math.round(sec || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  const raw = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return persianDigits ? toPersianDigits(raw) : raw;
}

function formatRelativeModifiedTime(
  updatedAtMs: number,
  locale: 'fa' | 'en',
  persianDigits = false,
): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
  if (diffSec < 60) return locale === 'fa' ? 'چند لحظه پیش' : 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    const val = formatNumberForLocale(diffMin, { persianDigits });
    return locale === 'fa' ? `${val} دقیقه پیش` : `${val}m ago`;
  }
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    const val = formatNumberForLocale(diffHr, { persianDigits });
    return locale === 'fa' ? `${val} ساعت پیش` : `${val}h ago`;
  }
  const diffDay = Math.floor(diffHr / 24);
  const val = formatNumberForLocale(diffDay, { persianDigits });
  return locale === 'fa' ? `${val} روز پیش` : `${val}d ago`;
}

function formatProjectStatusLabel(status: ProjectLifecycleStatus, locale: 'fa' | 'en'): string {
  switch (status) {
    case 'completed':
      return locale === 'fa' ? 'تکمیل‌شده' : 'Completed';
    case 'review':
      return locale === 'fa' ? 'آماده بازبینی' : 'In Review';
    case 'editing':
    default:
      return locale === 'fa' ? 'در حال تدوین' : 'Editing';
  }
}

function getStatusBadgeClasses(status: ProjectLifecycleStatus): string {
  switch (status) {
    case 'review':
      return 'bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] border-[var(--avp-brand)]/25';
    case 'completed':
      return 'bg-[var(--avp-success-soft)] text-[var(--avp-success-text)] border-[var(--avp-success)]/30';
    case 'editing':
    default:
      return 'bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)] border-[var(--avp-border)]';
  }
}

export const ProjectsHubView: React.FC<ProjectsHubViewProps> = ({
  locale,
  theme,
  persianDigits = false,
  projects,
  isLoading,
  errorMessage,
  corruptedCount,
  onRetryLoad,
  onOpenNewProjectModal,
  onOpenProject,
  onOpenSampleStudio,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onToggleTheme,
  onToggleLocale,
  onOpenSettings,
  onOpenLifecycleModal,
}) => {
  const isFa = locale === 'fa';
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProjectFilterTab>('all');
  const [sortBy, setSortBy] = useState<ProjectSortField>('updatedAt');
  const [viewMode, setViewMode] = useState<HubViewMode>('grid');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<PersistedProjectSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [previewPlayingId, setPreviewPlayingId] = useState<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewAudioCtxRef = useRef<AudioContext | null>(null);

  const stopPreviewAudio = () => {
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (previewAudioCtxRef.current) {
      previewAudioCtxRef.current.close().catch(() => {});
      previewAudioCtxRef.current = null;
    }
    setPreviewPlayingId(null);
  };

  const handleToggleQuickPreview = (e: React.MouseEvent, item: PersistedProjectSummary) => {
    e.stopPropagation();
    if (previewPlayingId === item.id) {
      stopPreviewAudio();
      return;
    }
    stopPreviewAudio();
    setPreviewPlayingId(item.id);

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        previewAudioCtxRef.current = ctx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(196, ctx.currentTime);
        const peaks: readonly number[] = item.waveformPreviewPeaks?.length
          ? item.waveformPreviewPeaks
          : [0.35, 0.7, 0.45, 0.85, 0.5];
        gain.gain.setValueAtTime(0.001, ctx.currentTime);
        peaks.slice(0, 12).forEach((p: number, idx: number) => {
          const t = ctx.currentTime + idx * 0.14;
          gain.gain.exponentialRampToValueAtTime(
            Math.max(0.004, Math.min(0.06, p * 0.06)),
            t,
          );
          osc.frequency.setValueAtTime(175 + Math.round(p * 110), t);
        });
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.75);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 1.8);
      }
    } catch {
      // AudioContext may be blocked in headless or restricted context; visual preview still runs
    }

    previewTimerRef.current = window.setTimeout(() => {
      stopPreviewAudio();
    }, 1800);
  };

  const filteredProjects = useMemo(() => {
    return filterAndSortProjects(projects, {
      query: searchQuery,
      filter: statusFilter,
      sortBy,
    });
  }, [projects, searchQuery, statusFilter, sortBy]);

  const handleStartRename = (item: PersistedProjectSummary) => {
    setOpenMenuId(null);
    setRenamingId(item.id);
    setRenameDraft(item.name);
  };

  const handleCommitRename = async (projectId: string) => {
    const clean = renameDraft.trim();
    setRenamingId(null);
    if (!clean) return;
    await onRenameProject(projectId, clean);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteItem) return;
    setIsDeleting(true);
    try {
      await onDeleteProject(confirmDeleteItem.id);
      setConfirmDeleteItem(null);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      dir={isFa ? 'rtl' : 'ltr'}
      data-testid="projects-hub-view"
      className="min-h-screen flex flex-col bg-[var(--avp-bg)] text-[var(--avp-text)]"
      onClick={() => setOpenMenuId(null)}
    >
      {/* Unified 48px Global Application Header via GlobalAppBar */}
      <GlobalAppBar
        className="sticky top-0 backdrop-blur-sm bg-[var(--avp-surface-shell)]/95"
        startSlot={
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-[var(--avp-radius-sm)] bg-[var(--avp-brand)] text-white flex items-center justify-center shadow-[var(--avp-shadow-xs)] shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" aria-hidden="true">
                <path
                  d="M4 12.5h2.2l1.8-5.5 2.6 10 2.4-7.5 1.8 4.2 1.7-1.2H20"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-[13px] font-bold tracking-tight text-[var(--avp-text)] leading-none whitespace-nowrap">
                {isFa ? 'آواپرداز' : 'Avapardaz'}
              </h1>
              <span className="hidden sm:inline-block text-[11px] px-2 py-0.5 rounded-[var(--avp-radius-xs)] bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)] border border-[var(--avp-border-subtle)] font-medium truncate">
                {isFa ? 'استودیوی تدوین گفتار و پادکست' : 'Persian Speech & Podcast Studio'}
              </span>
            </div>
          </div>
        }
        endSlot={
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="hidden md:inline-flex items-center gap-1.5">
              <OfflineIndicator inline locale={locale} />
              <PWAInstallButton compact locale={locale} />
            </div>

            <button
              type="button"
              data-testid="btn-new-project"
              onClick={onOpenNewProjectModal}
              className="avp-btn avp-btn-sm avp-btn-primary px-3 shadow-[var(--avp-shadow-xs)]"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'پروژه جدید' : 'New Project'}</span>
            </button>

            {/* Unified 4-Button System Utility Capsule: [EN/FA | Theme | System Health | Settings] */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-[var(--avp-radius-sm)] border border-[var(--avp-border)] bg-[var(--avp-surface-2)]">
              <button
                type="button"
                onClick={onToggleLocale}
                title={isFa ? 'Switch to English' : 'تغییر به فارسی'}
                aria-label={isFa ? 'تغییر زبان به انگلیسی' : 'Switch language to Persian'}
                className="h-6 px-1.5 rounded-[var(--avp-radius-xs)] text-[10px] font-semibold text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Languages className="w-3 h-3" />
                <span>{isFa ? 'EN' : 'FA'}</span>
              </button>

              <button
                type="button"
                onClick={onToggleTheme}
                title={
                  theme === 'dark'
                    ? isFa
                      ? 'حالت روشن'
                      : 'Light mode'
                    : isFa
                      ? 'حالت تیره'
                      : 'Dark mode'
                }
                aria-label={isFa ? 'تغییر تم روشن و تیره' : 'Toggle theme'}
                className="w-6 h-6 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer transition-colors"
              >
                {theme === 'dark' ? (
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <Moon className="w-3.5 h-3.5" />
                )}
              </button>

              {onOpenLifecycleModal && (
                <button
                  type="button"
                  onClick={onOpenLifecycleModal}
                  title={isFa ? 'سلامت سیستم و مدل‌های آفلاین' : 'System Health & Local Models'}
                  aria-label={isFa ? 'سلامت سیستم و مدل‌های آفلاین' : 'System Health & Local Models'}
                  className="w-6 h-6 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer transition-colors"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--avp-brand)]" />
                </button>
              )}

              <button
                type="button"
                data-testid="btn-open-settings-hub"
                onClick={onOpenSettings}
                title={isFa ? 'تنظیمات' : 'Settings'}
                aria-label={isFa ? 'تنظیمات' : 'Settings'}
                className="w-6 h-6 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer transition-colors"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        }
      />

      {/* Main Content */}
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Corrupted item warning */}
        {corruptedCount > 0 && (
          <div
            role="status"
            className="p-3.5 rounded-xl border border-[var(--avp-warning)]/40 bg-[var(--avp-accent-soft)]/50 text-xs flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-[var(--avp-warning)] shrink-0" />
              <span>
                {isFa
                  ? `${corruptedCount} پروژه قدیمی یا آسیب‌دیده نادیده گرفته شد تا عملکرد برنامه مختل نشود.`
                  : `${corruptedCount} corrupted project entry was skipped safely.`}
              </span>
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div
            data-testid="projects-loading-state"
            className="py-20 flex flex-col items-center justify-center gap-3 text-[var(--avp-text-secondary)]"
          >
            <Loader2 className="w-7 h-7 animate-spin text-[var(--avp-brand)]" />
            <p className="text-sm font-medium">
              {isFa ? 'در حال بارگذاری پروژه‌ها...' : 'Loading your projects...'}
            </p>
          </div>
        )}

        {/* Error state */}
        {!isLoading && errorMessage && (
          <div
            data-testid="projects-error-state"
            className="p-6 rounded-2xl border border-[var(--avp-error)]/40 bg-[var(--avp-surface)] text-center space-y-3"
          >
            <AlertCircle className="w-8 h-8 text-[var(--avp-error)] mx-auto" />
            <h2 className="text-base font-bold">
              {isFa ? 'بارگذاری فهرست پروژه‌ها ناموفق بود' : 'Failed to load projects'}
            </h2>
            <p className="text-xs text-[var(--avp-text-secondary)] max-w-md mx-auto">
              {errorMessage}
            </p>
            <button
              type="button"
              onClick={onRetryLoad}
              className="h-9 px-4 rounded-xl bg-[var(--avp-brand)] text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{isFa ? 'تلاش دوباره' : 'Retry'}</span>
            </button>
          </div>
        )}

        {/* First-time Onboarding Empty State (when zero projects exist) */}
        {!isLoading && !errorMessage && projects.length === 0 && (
          <div
            data-testid="projects-empty-state"
            className="rounded-3xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-7 sm:p-11 shadow-[var(--avp-shadow-sm)] text-center max-w-3xl mx-auto my-6 space-y-6"
          >
            <div className="w-16 h-16 rounded-2xl bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] flex items-center justify-center mx-auto">
              <FileAudio className="w-8 h-8" />
            </div>

            <div className="space-y-2 max-w-xl mx-auto">
              <h2 className="text-xl sm:text-2xl font-bold text-[var(--avp-text)]">
                {isFa
                  ? 'به استودیوی تدوین گفتار آواپرداز خوش آمدید'
                  : 'Welcome to Avapardaz Speech Editing Studio'}
              </h2>
              <p className="text-sm text-[var(--avp-text-secondary)] leading-relaxed">
                {isFa
                  ? 'فایل صوتی گفتار یا پادکست خود را وارد کنید، متن زمان‌بندی‌شده را ببینید، تپق‌ها و مکث‌های اضافه را با یک کلیک اصلاح کنید و فایل صوتی تمیز تحویل بگیرید.'
                  : 'Import your Persian speech or podcast audio, inspect the timed transcript, clean up disfluencies and pauses with one click, and export polished audio.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                type="button"
                data-testid="btn-empty-create-project"
                onClick={onOpenNewProjectModal}
                className="h-11 px-6 rounded-xl bg-[var(--avp-brand)] hover:bg-[var(--avp-brand-hover)] text-white text-sm font-semibold inline-flex items-center gap-2 shadow-[var(--avp-shadow-xs)] cursor-pointer transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>
                  {isFa
                    ? 'ایجاد اولین پروژه با فایل صوتی'
                    : 'Create First Project with Audio'}
                </span>
              </button>

              <button
                type="button"
                data-testid="btn-open-sample-studio"
                onClick={onOpenSampleStudio}
                className="h-11 px-5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-2)] hover:bg-[var(--avp-hover)] text-[var(--avp-text)] text-xs font-medium inline-flex items-center gap-2 cursor-pointer transition-colors"
              >
                <Wand2 className="w-4 h-4 text-[var(--avp-brand)]" />
                <span>
                  {isFa ? 'آزمایش با نمونه صوتی آماده' : 'Try with Sample Persian Audio'}
                </span>
              </button>
            </div>

            {/* 4-Step Visual Workflow Explanation */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-4 text-start border-t border-[var(--avp-border-subtle)]">
              {[
                {
                  num: isFa ? '۱' : '1',
                  title: isFa ? 'بارگذاری فایل صوتی' : 'Import Audio',
                  desc: isFa
                    ? 'پشتیبانی از WAV، MP3، M4A، FLAC و OGG'
                    : 'Supports WAV, MP3, M4A, FLAC & OGG',
                },
                {
                  num: isFa ? '۲' : '2',
                  title: isFa ? 'تبدیل گفتار به متن' : 'Transcribe Speech',
                  desc: isFa
                    ? 'استخراج کلمات زمان‌بندی‌شده فارسی'
                    : 'Word-level timed Persian transcript',
                },
                {
                  num: isFa ? '۳' : '3',
                  title: isFa ? 'پیشنهادهای هوشمند تدوین' : 'Smart Edit Suggestions',
                  desc: isFa
                    ? 'حذف مکث‌های طولانی، تپق‌ها و تکرارها'
                    : 'Clean long pauses, fillers & repeats',
                },
                {
                  num: isFa ? '۴' : '4',
                  title: isFa ? 'خروجی نهایی تمیز' : 'Polished Export',
                  desc: isFa
                    ? 'دریافت فایل صوتی تدوین‌شده با بلندی استاندارد'
                    : 'Export mastered WAV or FLAC audio',
                },
              ].map((step) => (
                <div
                  key={step.num}
                  className="p-3.5 rounded-2xl bg-[var(--avp-bg)] border border-[var(--avp-border-subtle)] space-y-1"
                >
                  <span className="w-6 h-6 rounded-lg bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] text-xs font-bold inline-flex items-center justify-center">
                    {step.num}
                  </span>
                  <div className="text-xs font-bold text-[var(--avp-text)] pt-1">{step.title}</div>
                  <div className="text-[11px] text-[var(--avp-text-secondary)] leading-relaxed">
                    {step.desc}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Projects List & Filter Toolbar (when projects exist) */}
        {!isLoading && !errorMessage && projects.length > 0 && (
          <div className="space-y-5">
            {/* Section Title & Filter Bar */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <FolderOpen className="w-5 h-5 text-[var(--avp-brand)]" />
                  <span>{isFa ? 'پروژه‌های شما' : 'Your Projects'}</span>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-[var(--avp-radius-sm)] bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)] font-mono tabular-nums">
                    {formatNumberForLocale(projects.length, { persianDigits })}
                  </span>
                </h2>
                <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
                  {isFa
                    ? 'برای ادامه تدوین روی هر پروژه کلیک کنید یا پروژه جدیدی بسازید.'
                    : 'Click any project to resume editing in the studio or create a new project.'}
                </p>
              </div>

              {/* Search, Status Filter, Sort & Grid/Table View Mode Switcher */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 sm:flex-initial sm:w-64">
                  <Search className="w-3.5 h-3.5 text-[var(--avp-text-muted)] absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" />
                  <input
                    type="search"
                    data-testid="projects-search-input"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      isFa ? 'جستجو در نام پروژه یا فایل...' : 'Search project or file...'
                    }
                    className="w-full h-9 ps-8 pe-3 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)] placeholder:text-[var(--avp-text-muted)] focus:outline-none focus:border-[var(--avp-brand)]"
                  />
                </div>

                <select
                  aria-label={isFa ? 'فیلتر وضعیت پروژه' : 'Filter by status'}
                  data-testid="projects-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ProjectFilterTab)}
                  className="h-9 px-3 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)] cursor-pointer"
                >
                  <option value="all">{isFa ? 'همه وضعیت‌ها' : 'All statuses'}</option>
                  <option value="recent">{isFa ? 'اخیر' : 'Recent'}</option>
                  <option value="editing">{isFa ? 'در حال تدوین' : 'Editing & Review'}</option>
                  <option value="completed">{isFa ? 'تکمیل‌شده' : 'Completed'}</option>
                </select>

                <select
                  aria-label={isFa ? 'مرتب‌سازی پروژه‌ها' : 'Sort projects'}
                  data-testid="projects-sort-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as ProjectSortField)}
                  className="h-9 px-3 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)] cursor-pointer"
                >
                  <option value="updatedAt">
                    {isFa ? 'آخرین ویرایش' : 'Last modified'}
                  </option>
                  <option value="lastOpenedAt">
                    {isFa ? 'آخرین بازدید' : 'Last opened'}
                  </option>
                  <option value="name">{isFa ? 'نام (الفبایی)' : 'Name (A–Z)'}</option>
                </select>

                {/* Grid | Table View Mode Switcher (Blueprint 1 - P2-1) */}
                <div className="avp-segmented">
                  <button
                    type="button"
                    data-testid="btn-projects-view-grid"
                    onClick={() => setViewMode('grid')}
                    aria-pressed={viewMode === 'grid'}
                    title={isFa ? 'نمای کارتی' : 'Card Grid View'}
                    className="avp-segmented-item cursor-pointer"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{isFa ? 'کارت' : 'Grid'}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="btn-projects-view-table"
                    onClick={() => setViewMode('table')}
                    aria-pressed={viewMode === 'table'}
                    title={isFa ? 'نمای جدولی فشرده' : 'Compact Table View'}
                    className="avp-segmented-item cursor-pointer"
                  >
                    <List className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{isFa ? 'جدول' : 'Table'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Filtered Empty Search Result */}
            {filteredProjects.length === 0 ? (
              <div className="rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-10 text-center space-y-2">
                <p className="text-sm font-semibold">
                  {isFa
                    ? 'هیچ پروژه‌ای با جستجوی شما مطابقت ندارد'
                    : 'No matching projects found'}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                  }}
                  className="text-xs text-[var(--avp-brand)] hover:underline cursor-pointer"
                >
                  {isFa ? 'پاک کردن فیلترها' : 'Reset filters'}
                </button>
              </div>
            ) : viewMode === 'grid' ? (
              /* Project Cards Grid (3-Column Responsive Desktop Grid) */
              <div
                data-testid="projects-grid"
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
              >
                {filteredProjects.map((item) => {
                  const isMenuOpen = openMenuId === item.id;
                  const isRenaming = renamingId === item.id;
                  const isPlayingPreview = previewPlayingId === item.id;
                  const extBadge = (
                    item.sourceFileName.split('.').pop() || 'WAV'
                  ).toUpperCase();
                  const peaks: readonly number[] = item.waveformPreviewPeaks?.length
                    ? item.waveformPreviewPeaks
                    : [0.3, 0.55, 0.4, 0.8, 0.5, 0.65, 0.42, 0.74, 0.51, 0.88, 0.36, 0.62];

                  return (
                    <article
                      key={item.id}
                      data-testid={`project-card-${item.id}`}
                      onClick={() => {
                        if (!isRenaming) onOpenProject(item.id);
                      }}
                      className="group relative rounded-[var(--avp-radius-lg)] border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:border-[var(--avp-brand)]/60 p-4 shadow-[var(--avp-shadow-xs)] hover:shadow-[var(--avp-shadow-sm)] transition-all flex flex-col justify-between gap-4 cursor-pointer"
                    >
                      {/* Top Header: Status Badge + Context Menu */}
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full border ${getStatusBadgeClasses(
                            item.status,
                          )}`}
                        >
                          {item.status === 'review' && (
                            <Sparkles className="w-3 h-3" />
                          )}
                          {item.status === 'completed' && (
                            <CheckCircle2 className="w-3 h-3" />
                          )}
                          {formatProjectStatusLabel(item.status, locale)}
                        </span>

                        <div
                          className="relative"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          <button
                            type="button"
                            data-testid={`project-menu-btn-${item.id}`}
                            aria-label={isFa ? 'عملیات پروژه' : 'Project actions'}
                            onClick={() =>
                              setOpenMenuId(isMenuOpen ? null : item.id)
                            }
                            className="w-7 h-7 rounded-[var(--avp-radius-sm)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {isMenuOpen && (
                            <div
                              role="menu"
                              className="absolute end-0 mt-1 w-44 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] shadow-[var(--avp-shadow-md)] py-1 z-20 text-xs"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`project-rename-btn-${item.id}`}
                                onClick={() => handleStartRename(item)}
                                className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5 text-[var(--avp-text-secondary)]" />
                                <span>{isFa ? 'تغییر نام پروژه' : 'Rename'}</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`project-duplicate-btn-${item.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void onDuplicateProject(item.id);
                                }}
                                className="w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer"
                              >
                                <Copy className="w-3.5 h-3.5 text-[var(--avp-text-secondary)]" />
                                <span>{isFa ? 'تکثیر پروژه' : 'Duplicate'}</span>
                              </button>
                              <div className="my-1 border-t border-[var(--avp-border-subtle)]" />
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`project-delete-btn-${item.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setConfirmDeleteItem(item);
                                }}
                                className="w-full px-3 py-2 text-start hover:bg-[var(--avp-error)]/10 text-[var(--avp-error)] flex items-center gap-2 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>{isFa ? 'حذف پروژه' : 'Delete'}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Title + Audio Filename + Technical Spec Badge */}
                      <div className="space-y-1.5">
                        {isRenaming ? (
                          <div
                            className="flex items-center gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="text"
                              autoFocus
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleCommitRename(item.id);
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              className="flex-1 h-8 px-2.5 rounded-lg border border-[var(--avp-brand)] bg-[var(--avp-bg)] text-xs font-semibold focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => void handleCommitRename(item.id)}
                              className="h-8 px-2.5 rounded-lg bg-[var(--avp-brand)] text-white text-xs font-semibold cursor-pointer"
                            >
                              {isFa ? 'ثبت' : 'Save'}
                            </button>
                          </div>
                        ) : (
                          <h3 className="text-base font-bold text-[var(--avp-text)] group-hover:text-[var(--avp-brand)] transition-colors line-clamp-1">
                            {item.name}
                          </h3>
                        )}

                        <div className="flex items-center justify-between gap-2 text-xs text-[var(--avp-text-secondary)]">
                          <div className="flex items-center gap-1.5 truncate">
                            <FileAudio className="w-3.5 h-3.5 text-[var(--avp-text-muted)] shrink-0" />
                            <span className="truncate" dir="ltr">
                              {item.sourceFileName}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[9.5px] px-1.5 py-0.5 rounded-[var(--avp-radius-xs)] bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] text-[var(--avp-text-secondary)]">
                            {Math.round((item.sampleRate || 48000) / 1000)}kHz · {extBadge}
                          </span>
                        </div>
                      </div>

                      {/* Mini Waveform Preview Bar + 28x28 Quick Audition Play Button (Blueprint 1 - P2-1) */}
                      <div
                        aria-hidden="true"
                        className="h-10 rounded-[var(--avp-radius-md)] bg-[var(--avp-bg)] border border-[var(--avp-border-subtle)] px-2.5 flex items-center gap-2"
                      >
                        <button
                          type="button"
                          onClick={(e) => handleToggleQuickPreview(e, item)}
                          data-testid={`project-preview-play-${item.id}`}
                          title={isFa ? 'پیش‌شنود سریع صوت پروژه' : 'Quick Audio Audition'}
                          aria-label={isFa ? 'پیش‌شنود سریع صوت پروژه' : 'Quick Audio Audition'}
                          className={`w-7 h-7 rounded-[var(--avp-radius-sm)] shrink-0 flex items-center justify-center border transition-all cursor-pointer ${
                            isPlayingPreview
                              ? 'bg-[var(--avp-brand)] text-white border-[var(--avp-brand)] shadow-[var(--avp-shadow-xs)]'
                              : 'bg-[var(--avp-surface)] text-[var(--avp-brand)] border-[var(--avp-border)] hover:border-[var(--avp-brand)]/60 hover:bg-[var(--avp-brand-soft)]'
                          }`}
                        >
                          {isPlayingPreview ? (
                            <Square className="w-3 h-3 fill-current" />
                          ) : (
                            <Play className="w-3 h-3 fill-current" />
                          )}
                        </button>
                        <div className="flex-1 h-full flex items-center gap-[3px] overflow-hidden">
                          {peaks.slice(0, 28).map((amp: number, idx: number) => (
                            <span
                              key={idx}
                              className={`flex-1 rounded-full transition-colors ${
                                isPlayingPreview
                                  ? 'bg-[var(--avp-brand)] animate-pulse'
                                  : 'bg-[var(--avp-brand)]/35 group-hover:bg-[var(--avp-brand)]/65'
                              }`}
                              style={{
                                height: `${Math.max(18, Math.min(92, Math.round(amp * 100)))}%`,
                              }}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Bottom Metadata Footer */}
                      <div className="pt-2 border-t border-[var(--avp-border-subtle)] flex items-center justify-between gap-2 text-[11px] text-[var(--avp-text-secondary)]">
                        <div className="flex items-center gap-3">
                          <span
                            className="inline-flex items-center gap-1 font-mono tabular-nums"
                            dir="ltr"
                          >
                            <Clock className="w-3 h-3" />
                            {formatAudioDurationClock(item.durationSec, persianDigits)}
                          </span>
                          <span>
                            {item.wordCount > 0
                              ? isFa
                                ? `${formatNumberForLocale(item.wordCount, { persianDigits })} کلمه`
                                : `${formatNumberForLocale(item.wordCount, { persianDigits })} words`
                              : isFa
                                ? 'بدون متن'
                                : 'No transcript'}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 text-[var(--avp-brand)] font-semibold">
                          <span className="text-[var(--avp-text-muted)] font-normal">
                            {formatRelativeModifiedTime(item.updatedAtMs, locale, persianDigits)}
                          </span>
                          <Play className="w-3 h-3 fill-current ms-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              /* High-Density Studio Table View */
              <div
                data-testid="projects-table"
                className="rounded-[var(--avp-radius-lg)] border border-[var(--avp-border)] bg-[var(--avp-surface)] overflow-x-auto shadow-[var(--avp-shadow-xs)]"
              >
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="h-9 border-b border-[var(--avp-border)] bg-[var(--avp-surface-2)] text-[11px] text-[var(--avp-text-secondary)]">
                      <th className="px-3 text-start font-semibold">
                        {isFa ? 'نام پروژه' : 'Project Name'}
                      </th>
                      <th className="px-3 text-start font-semibold hidden sm:table-cell">
                        {isFa ? 'فایل صوتی' : 'Source Audio'}
                      </th>
                      <th className="px-3 text-start font-semibold">
                        {isFa ? 'وضعیت' : 'Status'}
                      </th>
                      <th className="px-3 text-start font-semibold">
                        {isFa ? 'مدت‌زمان' : 'Duration'}
                      </th>
                      <th className="px-3 text-start font-semibold hidden md:table-cell">
                        {isFa ? 'تعداد کلمات' : 'Words'}
                      </th>
                      <th className="px-3 text-start font-semibold hidden lg:table-cell">
                        {isFa ? 'آخرین ویرایش' : 'Modified'}
                      </th>
                      <th className="px-3 text-end font-semibold">
                        {isFa ? 'عملیات' : 'Actions'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)]">
                    {filteredProjects.map((item) => {
                      const isPlayingPreview = previewPlayingId === item.id;
                      return (
                        <tr
                          key={item.id}
                          data-testid={`project-card-${item.id}`}
                          onClick={() => onOpenProject(item.id)}
                          className="h-12 hover:bg-[var(--avp-hover)] transition-colors cursor-pointer"
                        >
                          <td className="px-3 font-bold text-[var(--avp-text)]">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => handleToggleQuickPreview(e, item)}
                                className="w-6 h-6 rounded-[var(--avp-radius-xs)] bg-[var(--avp-surface-2)] border border-[var(--avp-border)] flex items-center justify-center text-[var(--avp-brand)] hover:bg-[var(--avp-brand-soft)] cursor-pointer"
                                title={isFa ? 'پیش‌شنود سریع' : 'Quick Audition'}
                              >
                                {isPlayingPreview ? (
                                  <Square className="w-2.5 h-2.5 fill-current" />
                                ) : (
                                  <Play className="w-2.5 h-2.5 fill-current" />
                                )}
                              </button>
                              <span className="truncate max-w-[240px]">{item.name}</span>
                            </div>
                          </td>
                          <td
                            className="px-3 text-[var(--avp-text-secondary)] font-mono text-[11px] hidden sm:table-cell"
                            dir="ltr"
                          >
                            {item.sourceFileName}
                          </td>
                          <td className="px-3">
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${getStatusBadgeClasses(
                                item.status,
                              )}`}
                            >
                              {formatProjectStatusLabel(item.status, locale)}
                            </span>
                          </td>
                          <td className="px-3 font-mono font-semibold tabular-nums" dir="ltr">
                            {formatAudioDurationClock(item.durationSec, persianDigits)}
                          </td>
                          <td className="px-3 text-[var(--avp-text-secondary)] hidden md:table-cell font-mono tabular-nums">
                            {formatNumberForLocale(item.wordCount, { persianDigits })}
                          </td>
                          <td className="px-3 text-[var(--avp-text-muted)] hidden lg:table-cell">
                            {formatRelativeModifiedTime(item.updatedAtMs, locale, persianDigits)}
                          </td>
                          <td
                            className="px-3 text-end"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => onOpenProject(item.id)}
                                className="h-7 px-2.5 rounded-[var(--avp-radius-sm)] bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] text-[11px] font-semibold cursor-pointer"
                              >
                                {isFa ? 'ورود به استودیو' : 'Open'}
                              </button>
                              <button
                                type="button"
                                data-testid={`project-menu-btn-${item.id}`}
                                onClick={() => setConfirmDeleteItem(item)}
                                className="w-7 h-7 rounded-[var(--avp-radius-sm)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-error)] hover:bg-[var(--avp-error)]/10 inline-flex items-center justify-center cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Delete Project Confirmation Dialog via AccessibleModal */}
      <AccessibleModal
        isOpen={Boolean(confirmDeleteItem)}
        onClose={() => {
          if (!isDeleting) setConfirmDeleteItem(null);
        }}
        disableEscape={isDeleting}
        closeOnBackdropClick={!isDeleting}
        dir={isFa ? 'rtl' : 'ltr'}
        labelledBy="confirm-delete-project-title"
        dataTestId="confirm-delete-project-modal"
        panelClassName="w-full max-w-md rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-5 shadow-[var(--avp-shadow-md)] space-y-4"
      >
        {confirmDeleteItem && (
          <>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[var(--avp-error-soft)] text-[var(--avp-error)] flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 id="confirm-delete-project-title" className="text-base font-bold text-[var(--avp-text)]">
                  {isFa ? 'حذف پروژه؟' : 'Delete Project?'}
                </h3>
                <p className="text-xs text-[var(--avp-text-secondary)] leading-relaxed">
                  {isFa
                    ? `آیا از حذف پروژه «${confirmDeleteItem.name}» مطمئن هستید؟ این عمل قابل بازگشت نیست.`
                    : `Are you sure you want to delete "${confirmDeleteItem.name}"? This action cannot be undone.`}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteItem(null)}
                disabled={isDeleting}
                className="avp-btn avp-btn-outline"
              >
                {isFa ? 'انصراف' : 'Cancel'}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-delete-project"
                onClick={() => void handleConfirmDelete()}
                disabled={isDeleting}
                className="avp-btn avp-btn-danger"
              >
                {isDeleting
                  ? isFa
                    ? 'در حال حذف...'
                    : 'Deleting...'
                  : isFa
                    ? 'حذف پروژه'
                    : 'Delete Project'}
              </button>
            </div>
          </>
        )}
      </AccessibleModal>
    </div>
  );
};
