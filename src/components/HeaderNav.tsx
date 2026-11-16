import React from 'react';
import { Download } from 'lucide-react';

export type WorkspaceTab = 'studio' | 'graph' | 'storage';

interface HeaderNavProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onOpenExport: () => void;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  activeTab,
  onSelectTab,
  onOpenExport,
}) => {
  const navItems: { id: WorkspaceTab; label: string }[] = [
    { id: 'studio', label: 'محیط تدوین' },
    { id: 'graph', label: 'گراف پردازش و PDC' },
    { id: 'storage', label: 'ذخیره‌سازی OPFS و قراردادها' },
  ];

  return (
    <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-[#252F42] bg-[#0B0F17]">
      {/* Zone 1: Single-element Brand Wordmark */}
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onSelectTab('studio');
        }}
        className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 hover:text-amber-400 transition-colors"
      >
        آواپرداز
      </a>

      {/* Zone 2: Clean single-line navigation links */}
      <nav aria-label="بخش‌های استودیو" className="flex items-center gap-6 overflow-x-auto">
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
                  ? 'text-amber-400 border-amber-400'
                  : 'text-slate-400 border-transparent hover:text-slate-100'
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
          onClick={onOpenExport}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 rounded-md hover:bg-amber-300 active:bg-amber-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span>خروجی WAV</span>
        </button>
      </div>
    </header>
  );
};
