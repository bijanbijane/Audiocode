import React from 'react';
import { CheckCircle2, Info, AlertTriangle, X } from 'lucide-react';
import type { StudioToastItem } from '../hooks/useStudioToast';

interface StudioToastProps {
  toast: StudioToastItem | null;
  locale: 'fa' | 'en';
  onDismiss: () => void;
  onPauseChange?: (paused: boolean) => void;
}

export const StudioToast: React.FC<StudioToastProps> = ({
  toast,
  locale,
  onDismiss,
  onPauseChange,
}) => {
  if (!toast) return null;
  const isFa = locale === 'fa';
  const tone = toast.tone ?? 'info';

  const toneClasses =
    tone === 'danger'
      ? 'border-[var(--avp-danger)]/45 bg-[var(--avp-surface-floating)] text-[var(--avp-text)]'
      : tone === 'warning'
        ? 'border-[var(--avp-warning)]/45 bg-[var(--avp-surface-floating)] text-[var(--avp-text)]'
        : tone === 'success'
          ? 'border-[var(--avp-success)]/45 bg-[var(--avp-surface-floating)] text-[var(--avp-text)]'
          : 'border-[var(--avp-border)] bg-[var(--avp-surface-floating)] text-[var(--avp-text)]';

  const ToneIcon =
    tone === 'danger' || tone === 'warning'
      ? AlertTriangle
      : tone === 'success'
        ? CheckCircle2
        : Info;

  const iconColor =
    tone === 'danger'
      ? 'text-[var(--avp-danger-text)]'
      : tone === 'warning'
        ? 'text-[var(--avp-warning-text)]'
        : tone === 'success'
          ? 'text-[var(--avp-success-text)]'
          : 'text-[var(--avp-accent-text)]';

  return (
    <div
      data-testid="studio-status-toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      dir={isFa ? 'rtl' : 'ltr'}
      onMouseEnter={() => onPauseChange?.(true)}
      onMouseLeave={() => onPauseChange?.(false)}
      onFocus={() => onPauseChange?.(true)}
      onBlur={() => onPauseChange?.(false)}
      className={`fixed bottom-[72px] inset-x-3 sm:inset-x-auto sm:start-4 sm:max-w-md z-[var(--avp-z-toast)] rounded-xl border shadow-[var(--avp-shadow-md)] px-3 py-2 flex items-center gap-2.5 text-xs ${toneClasses}`}
    >
      <ToneIcon className={`w-4 h-4 shrink-0 ${iconColor}`} strokeWidth={1.75} aria-hidden="true" />
      <span className="flex-1 min-w-0 leading-relaxed text-[var(--avp-text)]">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={isFa ? 'بستن پیام وضعیت' : 'Dismiss status message'}
        className="avp-touch-icon sm:w-7 sm:h-7 rounded-md text-[var(--avp-text-muted)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] inline-flex items-center justify-center shrink-0 cursor-pointer"
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};
