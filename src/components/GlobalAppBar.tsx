import React from 'react';

export interface GlobalAppBarProps {
  dir?: 'rtl' | 'ltr';
  startSlot?: React.ReactNode;
  centerSlot?: React.ReactNode;
  endSlot?: React.ReactNode;
  className?: string;
  dataTestId?: string;
}

/**
 * Shared Top Shell Chrome primitive unifying Projects Hub & Studio Headers
 * under strict L0 Surface Shell tokens, 1px hairline border, and balanced 3-zone grid.
 */
export const GlobalAppBar: React.FC<GlobalAppBarProps> = ({
  dir,
  startSlot,
  centerSlot,
  endSlot,
  className = '',
  dataTestId,
}) => {
  return (
    <header
      dir={dir}
      data-testid={dataTestId}
      className={`w-full min-h-[var(--avp-header-h)] bg-[var(--avp-surface-shell)] border-b border-[var(--avp-border)] px-3 sm:px-4 py-1.5 flex items-center justify-between gap-2 sm:gap-3 shrink-0 z-30 ${className}`}
    >
      <div className="flex items-center gap-2 min-w-0">{startSlot}</div>
      {centerSlot ? (
        <div className="hidden lg:flex items-center justify-center min-w-0 shrink">
          {centerSlot}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 shrink-0">{endSlot}</div>
    </header>
  );
};
