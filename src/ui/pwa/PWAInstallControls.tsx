import React, { useEffect, useState } from 'react';
import { Download, WifiOff } from 'lucide-react';
import { AccessibleModal } from '../../components/AccessibleModal';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

interface PWAInstallButtonProps {
  compact?: boolean;
  locale?: 'fa' | 'en';
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
  locale = 'fa',
  className = '',
}) => {
  const isFa = locale === 'fa';
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        data-testid="btn-pwa-install"
        onClick={() => void install()}
        title={isFa ? 'نصب نسخه آفلاین (PWA)' : 'Install Offline App'}
        className={`avp-btn ${compact ? 'avp-btn-sm' : ''} avp-btn-outline ${className}`}
      >
        <Download className="w-3.5 h-3.5 text-[var(--avp-brand)]" aria-hidden="true" />
        <span>{isFa ? (compact ? 'نصب آفلاین' : 'نصب نسخه آفلاین') : compact ? 'Install' : 'Install App'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          data-testid="btn-pwa-ios-guide"
          onClick={() => setShowIOSGuide(true)}
          className={`avp-btn ${compact ? 'avp-btn-sm' : ''} avp-btn-outline ${className}`}
        >
          <Download className="w-3.5 h-3.5 text-[var(--avp-brand)]" aria-hidden="true" />
          <span>{isFa ? 'نصب در iOS' : 'Install on iOS'}</span>
        </button>

        <AccessibleModal
          isOpen={showIOSGuide}
          onClose={() => setShowIOSGuide(false)}
          dir={isFa ? 'rtl' : 'ltr'}
          ariaLabel={isFa ? 'راهنمای نصب نسخه آفلاین در iOS' : 'iOS Offline Install Guide'}
          closeOnBackdropClick
          panelClassName="w-full max-w-sm rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-5 text-[var(--avp-text)] shadow-[var(--avp-shadow-md)]"
        >
          <h3 className="text-sm font-bold">
            {isFa ? 'نصب آواپرداز روی آیفون و آیپد' : 'Install Avapardaz on iOS'}
          </h3>
          <p className="mt-2 text-xs leading-6 text-[var(--avp-text-secondary)]">
            {isFa ? (
              <>
                ۱. دکمه Share در نوار ابزار Safari را لمس کنید.
                <br />
                ۲. گزینه Add to Home Screen را انتخاب کنید تا برنامه بدون اینترنت اجرا شود.
              </>
            ) : (
              <>
                1. Tap the Share button in Safari.
                <br />
                2. Select Add to Home Screen to launch Avapardaz offline.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => setShowIOSGuide(false)}
            className="mt-4 w-full avp-btn avp-btn-primary"
          >
            {isFa ? 'بستن' : 'Close'}
          </button>
        </AccessibleModal>
      </>
    );
  }

  return null;
};

interface OfflineIndicatorProps {
  inline?: boolean;
  locale?: 'fa' | 'en';
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({
  inline = true,
  locale = 'fa',
}) => {
  const isFa = locale === 'fa';
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      data-testid="offline-status-indicator"
      className={
        inline
          ? 'inline-flex items-center gap-1.5 h-[26px] rounded-[var(--avp-radius-sm)] border border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] px-2 text-[11px] font-medium text-[var(--avp-warning-text)] whitespace-nowrap'
          : 'inline-flex items-center gap-2 rounded-lg border border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] px-3 py-1.5 text-xs font-medium text-[var(--avp-warning-text)]'
      }
    >
      <WifiOff className="w-3.5 h-3.5 text-[var(--avp-warning)] shrink-0" aria-hidden="true" />
      <span>
        {isFa
          ? inline
            ? 'حالت آفلاین فعال'
            : 'حالت آفلاین — پردازش و ویرایش محلی فعال است'
          : inline
            ? 'Offline Ready'
            : 'Offline Mode — Local editing active'}
      </span>
    </div>
  );
};
