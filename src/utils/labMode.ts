/**
 * Determines whether Developer / R&D Lab panels (SHAHAB LAB, Processing Graph,
 * OPFS Storage Broker, ASR Research Lab, Speech Security) are unlocked.
 * Disabled in normal creator sessions by default; enabled explicitly via `?mode=lab`.
 */
export function isLabModeEnabled(search?: string): boolean {
  const rawSearch =
    typeof search === 'string'
      ? search
      : typeof window !== 'undefined'
        ? window.location.search
        : '';

  if (!rawSearch) return false;
  try {
    const params = new URLSearchParams(rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`);
    const mode = params.get('mode')?.trim().toLowerCase();
    const lab = params.get('lab')?.trim().toLowerCase();
    return mode === 'lab' || lab === '1' || lab === 'true';
  } catch {
    return false;
  }
}

export function buildLabModeHref(currentHref?: string): string {
  try {
    const base =
      currentHref ??
      (typeof window !== 'undefined' ? window.location.href : 'http://localhost:3000/');
    const url = new URL(base);
    url.searchParams.set('mode', 'lab');
    return `${url.pathname}${url.search}`;
  } catch {
    return '?mode=lab';
  }
}
