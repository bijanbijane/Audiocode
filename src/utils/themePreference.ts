/**
 * AVAPARDAZ — Light-First Theme & Visual Accessibility Document Applier
 *
 * Non-negotiable policy:
 * - First launch ALWAYS defaults to 'light' (never auto-switching to dark from OS).
 * - Explicit user choice is persisted in localStorage under 'avapardaz_theme_v1'.
 * - Optional 'system' mode is ONLY honored if the user explicitly selected 'system' in Settings.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type TranscriptFontScale = 'sm' | 'md' | 'lg';
export type MotionPreference = 'normal' | 'reduced';

export const THEME_STORAGE_KEY = 'avapardaz_theme_v1';
export const LIGHT_THEME_COLOR = '#FAFBFC';
export const DARK_THEME_COLOR = '#101720';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function getSafeStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage blocked in restricted browsing context
  }
  return null;
}

export function isValidThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Loads stored theme preference. Defaults strictly to 'light' on first launch
 * or when storage is unavailable/corrupted.
 */
export function loadStoredThemeChoice(storage?: StorageLike | null): ThemeChoice {
  const store = getSafeStorage(storage);
  if (!store) return 'light';
  try {
    const raw = store.getItem(THEME_STORAGE_KEY);
    if (isValidThemeChoice(raw)) return raw;
  } catch {
    // Ignore storage read failures
  }
  return 'light';
}

export function resolveEffectiveTheme(
  choice: ThemeChoice,
  osPrefersDark = false,
): ResolvedTheme {
  if (choice === 'dark') return 'dark';
  if (choice === 'system') return osPrefersDark ? 'dark' : 'light';
  return 'light';
}

export function detectOsPrefersDark(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch {
    // Ignore matchMedia errors
  }
  return false;
}

export function loadResolvedInitialTheme(storage?: StorageLike | null): ResolvedTheme {
  const choice = loadStoredThemeChoice(storage);
  return resolveEffectiveTheme(choice, choice === 'system' ? detectOsPrefersDark() : false);
}

export function saveStoredThemeChoice(
  choice: ThemeChoice,
  storage?: StorageLike | null,
): { ok: boolean; error?: string } {
  const store = getSafeStorage(storage);
  if (!store) {
    return { ok: false, error: 'STORAGE_UNAVAILABLE' };
  }
  try {
    store.setItem(THEME_STORAGE_KEY, choice);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'STORAGE_WRITE_FAILED',
    };
  }
}

export function applyThemeToDocument(resolvedTheme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (resolvedTheme === 'dark') {
    root.classList.add('dark');
    root.dataset.theme = 'dark';
  } else {
    root.classList.remove('dark');
    root.dataset.theme = 'light';
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      'content',
      resolvedTheme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR,
    );
  }
}

export function applyAccessibilityAttributesToDocument(options: {
  fontScale: TranscriptFontScale;
  motionPreference: MotionPreference;
  highContrast: boolean;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.fontScale = options.fontScale;
  root.dataset.motion = options.motionPreference;
  if (options.highContrast) {
    root.classList.add('avp-high-contrast');
  } else {
    root.classList.remove('avp-high-contrast');
  }
}
