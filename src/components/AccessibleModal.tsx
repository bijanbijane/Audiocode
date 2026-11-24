import React, { useEffect, useRef } from 'react';

export interface AccessibleModalProps {
  isOpen: boolean;
  onClose: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  dir?: 'rtl' | 'ltr';
  disableEscape?: boolean;
  closeOnBackdropClick?: boolean;
  zIndexClassName?: string;
  backdropClassName?: string;
  panelClassName?: string;
  dataTestId?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

export const AccessibleModal: React.FC<AccessibleModalProps> = ({
  isOpen,
  onClose,
  labelledBy,
  ariaLabel,
  dir,
  disableEscape = false,
  closeOnBackdropClick = false,
  zIndexClassName = 'z-50',
  backdropClassName = 'bg-black/55 backdrop-blur-[2px]',
  panelClassName = '',
  dataTestId,
  initialFocusRef,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      if (panel.contains(document.activeElement)) return;
      const focusables = getFocusableElements(panel);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        panel.focus();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;

      if (e.key === 'Escape' && !disableEscape) {
        // Only intercept if focus or top modal owns event cleanly
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab') {
        const focusables = getFocusableElements(panel);
        if (focusables.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (!panel.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }

        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = prevOverflow;
      const prevEl = previousFocusRef.current;
      if (prevEl && typeof prevEl.focus === 'function' && document.contains(prevEl)) {
        prevEl.focus();
      }
    };
  }, [isOpen, disableEscape, initialFocusRef]);

  if (!isOpen) return null;

  return (
    <div
      dir={dir}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      data-testid={dataTestId}
      onMouseDown={(e) => {
        if (closeOnBackdropClick && !disableEscape && e.target === e.currentTarget) {
          onCloseRef.current();
        }
      }}
      className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center p-2 sm:p-4 ${backdropClassName}`}
    >
      <div ref={panelRef} tabIndex={-1} className={`outline-none ${panelClassName}`}>
        {children}
      </div>
    </div>
  );
};
