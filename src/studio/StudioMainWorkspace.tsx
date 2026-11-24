import React from 'react';
import { WaveformCanvas } from '../components/WaveformCanvas';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { UnifiedEditorialInspector } from '../components/UnifiedEditorialInspector';
import { AuditionSideDock, type AuditionDockTabId } from '../components/AuditionSideDock';
import { DspControlRack } from '../components/DspControlRack';
import { resolveLeftRailWidthClass } from './layoutUtils';

export interface StudioMainWorkspaceProps {
  isFa: boolean;
  mobileStudioPane: 'center' | 'suggestions' | 'files';
  onChangeMobileStudioPane: (pane: 'center' | 'suggestions' | 'files') => void;
  showSuggestionsPanel: boolean;
  showFilesPanel: boolean;
  inspectorOnFlexStart: boolean;
  leftRailCollapsed: boolean;
  sideDockTab: AuditionDockTabId;
  onStartSplitSashDrag: (e: React.MouseEvent<HTMLDivElement>) => void;
  onResetTrackHeight: () => void;
  inspectorProps: React.ComponentProps<typeof UnifiedEditorialInspector>;
  waveformProps: React.ComponentProps<typeof WaveformCanvas>;
  transcriptProps: React.ComponentProps<typeof TranscriptPanel>;
  sideDockProps: Omit<React.ComponentProps<typeof AuditionSideDock>, 'dspRackNode'>;
  dspRackProps: React.ComponentProps<typeof DspControlRack>;
}

export const StudioMainWorkspace: React.FC<StudioMainWorkspaceProps> = ({
  isFa,
  mobileStudioPane,
  onChangeMobileStudioPane,
  showSuggestionsPanel,
  showFilesPanel,
  inspectorOnFlexStart,
  leftRailCollapsed,
  sideDockTab,
  onStartSplitSashDrag,
  onResetTrackHeight,
  inspectorProps,
  waveformProps,
  transcriptProps,
  sideDockProps,
  dspRackProps,
}) => {
  return (
    <>
      {/* Mobile/Tablet Compact Pane Switcher */}
      <div className="flex lg:hidden items-center px-3 py-1.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface)]">
        <div className="avp-segmented w-full">
          {(
            [
              { id: 'center', label: isFa ? 'تایملاین و متن' : 'Timeline & Text' },
              { id: 'suggestions', label: isFa ? 'پیشنهادها' : 'Suggestions' },
              { id: 'files', label: isFa ? 'فایل‌ها و افکت' : 'Files & DSP' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChangeMobileStudioPane(tab.id)}
              aria-pressed={mobileStudioPane === tab.id}
              className="avp-segmented-item flex-1 min-h-[44px]"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Full-Bleed Native Desktop 3-Pane Split Workspace (Hairline 1px Dividers) */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* Unified AI & Editorial Inspector */}
        {showSuggestionsPanel && (
          <div
            className={`lg:w-[272px] xl:w-[348px] shrink-0 min-w-0 lg:h-full ${
              inspectorOnFlexStart
                ? 'lg:order-1 lg:border-e'
                : 'lg:order-3 lg:border-s'
            } border-[var(--avp-border)] bg-[var(--avp-surface)] ${
              mobileStudioPane === 'suggestions'
                ? 'flex flex-col'
                : 'hidden lg:flex lg:flex-col'
            }`}
          >
            <UnifiedEditorialInspector {...inspectorProps} />
          </div>
        )}

        {/* Center Dominant: Locked Split Container -> Audio Timeline + 6px Split Sash + Editorial Transcript */}
        <div
          className={`flex-1 min-w-0 lg:order-2 lg:h-full lg:overflow-hidden bg-[var(--avp-surface)] ${
            mobileStudioPane === 'center' ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
          }`}
        >
          <WaveformCanvas {...waveformProps} />

          {/* 6px Interactive Horizontal Split Sash */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={isFa ? 'تغییر ارتفاع تایملاین و بوم متن' : 'Resize timeline and transcript split'}
            data-testid="center-split-sash"
            onMouseDown={onStartSplitSashDrag}
            onDoubleClick={onResetTrackHeight}
            title={
              isFa
                ? 'کشیدن برای تنظیم نسبت تایملاین و متن (دابل‌کلیک: بازنشانی به 30/70)'
                : 'Drag to resize timeline/transcript split (Double-click: reset 30/70)'
            }
            className="hidden lg:flex avp-split-sash"
          >
            <span className="avp-split-sash-pill" />
          </div>

          <TranscriptPanel {...transcriptProps} />
        </div>

        {/* Collapsible & Adaptive Files / DSP Effects / History Rail */}
        {showFilesPanel && (
          <div
            className={`${
              mobileStudioPane === 'files'
                ? 'w-full flex flex-col'
                : `${resolveLeftRailWidthClass(leftRailCollapsed, sideDockTab)} hidden lg:flex lg:flex-col`
            } shrink-0 min-w-0 lg:h-full ${
              inspectorOnFlexStart
                ? 'lg:order-3 lg:border-s'
                : 'lg:order-1 lg:border-e'
            } border-t lg:border-t-0 border-[var(--avp-border)] bg-[var(--avp-surface)] transition-[width] duration-150`}
          >
            <AuditionSideDock
              {...sideDockProps}
              collapsed={mobileStudioPane === 'files' ? false : sideDockProps.collapsed}
              onToggleCollapse={() => {
                if (typeof window !== 'undefined' && window.innerWidth < 1024) {
                  onChangeMobileStudioPane(mobileStudioPane === 'files' ? 'center' : 'files');
                } else {
                  sideDockProps.onToggleCollapse?.();
                }
              }}
              onDockTabChange={(tab) => {
                sideDockProps.onDockTabChange?.(tab);
                if (typeof window !== 'undefined' && window.innerWidth < 1024) {
                  onChangeMobileStudioPane('files');
                }
              }}
              dspRackNode={<DspControlRack {...dspRackProps} />}
            />
          </div>
        )}
      </div>
    </>
  );
};
