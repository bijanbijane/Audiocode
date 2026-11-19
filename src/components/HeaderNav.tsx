import React from 'react';
import { Download } from 'lucide-react';

export type WorkspaceTab = 'studio' | 'graph' | 'storage';

interface HeaderNavProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onOpenExport: () => void;
  locale?: 'fa' | 'en';
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  activeTab,
  onSelectTab,
  onOpenExport,
  locale = 'fa',
}) => {
  const isFa = locale === 'fa';
  const navItems: { id: WorkspaceTab; label: string }[] = [
    { id: 'studio', label: isFa ? 'محیط تدوین' : 'Editing Studio' },
    { id: 'graph', label: isFa ? 'گراف پردازش و PDC' : 'Processing Graph & PDC' },
    { id: 'storage', label: isFa ? 'ذخیره‌سازی OPFS و قراردادها' : 'OPFS Storage & Contracts' },
  ];

  return (
    <header className="flex items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 py-3.5 border-b border-slate-200 dark:border-[#252F42] bg-white dark:bg-[#0B0F17]">
      {/* Zone 1: Single-element Brand Wordmark */}
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onSelectTab('studio');
        }}
        className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
      >
        {isFa ? 'آواپرداز' : 'Avapardaz'}
      </a>

      {/* Zone 2: Clean single-line navigation links */}
      <nav aria-label={isFa ? 'بخش‌های استودیو' : 'Studio sections'} className="flex items-center gap-4 sm:gap-6 overflow-x-auto">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`py-1 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                isActive
                  ? 'text-amber-600 dark:text-amber-400 border-amber-500 dark:border-amber-400'
                  : 'text-slate-600 dark:text-slate-400 border-transparent hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary CTA */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          data-testid="btn-header-render-export"
          onClick={onOpenExport}
          className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 rounded-md hover:bg-amber-300 active:bg-amber-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{isFa ? 'رندر و خروجی' : 'Render & Export'}</span>
        </button>
      </div>
    </header>
  );
};

