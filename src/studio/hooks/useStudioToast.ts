import { useCallback, useEffect, useRef, useState } from 'react';

export interface StudioToastItem {
  id: number;
  message: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}

export function useStudioToast(autoDismissMs = 5200) {
  const [toast, setToast] = useState<StudioToastItem | null>(null);
  const [paused, setPaused] = useState(false);
  const seqRef = useRef(0);

  const showToast = useCallback(
    (message: string, tone: StudioToastItem['tone'] = 'info') => {
      const trimmed = message.trim();
      if (!trimmed) {
        setToast(null);
        return;
      }
      seqRef.current += 1;
      setToast({ id: seqRef.current, message: trimmed, tone });
    },
    [],
  );

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  useEffect(() => {
    if (!toast || paused || autoDismissMs <= 0) return;
    const timer = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [toast, paused, autoDismissMs]);

  return {
    toast,
    showToast,
    dismissToast,
    setToastPaused: setPaused,
  };
}
