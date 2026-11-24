/**
 * AVAPARDAZ — Unified Global Settings & Personalization Store (Phase 08)
 *
 * Strictly separates:
 * 1. Global User Preferences (persisted in localStorage under 'avapardaz_settings_v1')
 * 2. Project Preferences (stored per-project inside IndexedDB project records)
 * 3. Session UI State (ephemeral React state — never persisted as global settings)
 */

import {
  MotionPreference,
  StorageLike,
  THEME_STORAGE_KEY,
  ThemeChoice,
  TranscriptFontScale,
  isValidThemeChoice,
  saveStoredThemeChoice,
} from '../utils/themePreference';

export const SETTINGS_STORAGE_KEY = 'avapardaz_settings_v1';
export const SETTINGS_SCHEMA_VERSION = 1 as const;

export type SettingsCategoryKey =
  | 'appearance'
  | 'language'
  | 'workspace'
  | 'playback'
  | 'suggestions'
  | 'exportDefaults'
  | 'shortcuts'
  | 'accessibility'
  | 'storage';

export type SupportedPlaybackRate = 0.5 | 0.75 | 1.0 | 1.25 | 1.5 | 2.0;
export type ExportDefaultFormat = 'WAV_PCM16' | 'WAV_PCM24' | 'WAV_FLOAT32' | 'RF64_PCM24';
export type ExportDefaultSampleRate = 16000 | 44100 | 48000;
export type SuggestionSortOrder = 'time' | 'category' | 'confidence' | 'order';
export type SuggestionCategoryFilter = 'all' | 'filler' | 'pause' | 'repetition' | 'breath';
export type WorkspaceDensity = 'comfortable' | 'compact';

export interface KeyboardShortcutMap {
  playPause: string;
  seekBackward: string;
  seekForward: string;
  toggleLoop: string;
  undo: string;
  redo: string;
  clearSelection: string;
  openExport: string;
  openSettings: string;
}

export interface GlobalSettingsV1 {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  appearance: {
    theme: ThemeChoice;
    showWaveformGrid: boolean;
  };
  language: {
    locale: 'fa' | 'en';
    timecodeFormat: 'mm:ss.ms' | 'hh:mm:ss';
    persianDigits: boolean;
  };
  workspace: {
    showSuggestionsPanel: boolean;
    showFilesPanel: boolean;
    density: WorkspaceDensity;
    transcriptFontScale: TranscriptFontScale;
    showTimelineRuler: boolean;
    showTimelineMarkers: boolean;
    showEditRegions: boolean;
    resetZoomOnProjectOpen: boolean;
  };
  playback: {
    defaultRate: SupportedPlaybackRate;
    seekStepSec: 1 | 5 | 10;
    contextBeforeSec: 0.5 | 1 | 1.5 | 2;
    contextAfterSec: 0.5 | 1 | 1.5 | 2;
    stopAtPreviewEnd: boolean;
    loopEnabledByDefault: boolean;
  };
  suggestions: {
    defaultCategory: SuggestionCategoryFilter;
    defaultSort: SuggestionSortOrder;
    autoExpandDetails: boolean;
    focusNextAfterReview: boolean;
    confirmBeforeApply: boolean;
    showContextTranscript: boolean;
  };
  exportDefaults: {
    format: ExportDefaultFormat;
    sampleRate: ExportDefaultSampleRate | 'source';
    defaultCrossfadeMs: 0 | 5 | 10 | 15;
    filenamePrefix: string;
  };
  shortcuts: KeyboardShortcutMap;
  accessibility: {
    fontScale: TranscriptFontScale;
    motion: MotionPreference;
    highContrast: boolean;
  };
  storage: {
    autoSaveProjectEdits: boolean;
  };
}

export const SUPPORTED_PLAYBACK_RATES: readonly SupportedPlaybackRate[] = [
  0.5, 0.75, 1.0, 1.25, 1.5, 2.0,
];

export const DEFAULT_SHORTCUTS: Readonly<KeyboardShortcutMap> = Object.freeze({
  playPause: 'Space',
  seekBackward: 'ArrowLeft',
  seekForward: 'ArrowRight',
  toggleLoop: 'KeyL',
  undo: 'Mod+KeyZ',
  redo: 'Mod+Shift+KeyZ',
  clearSelection: 'Escape',
  openExport: 'Mod+KeyE',
  openSettings: 'Mod+Comma',
});

export function createDefaultGlobalSettings(): GlobalSettingsV1 {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    appearance: {
      theme: 'light',
      showWaveformGrid: true,
    },
    language: {
      locale: 'fa',
      timecodeFormat: 'mm:ss.ms',
      persianDigits: false,
    },
    workspace: {
      showSuggestionsPanel: true,
      showFilesPanel: true,
      density: 'comfortable',
      transcriptFontScale: 'md',
      showTimelineRuler: true,
      showTimelineMarkers: true,
      showEditRegions: true,
      resetZoomOnProjectOpen: true,
    },
    playback: {
      defaultRate: 1.0,
      seekStepSec: 5,
      contextBeforeSec: 1,
      contextAfterSec: 1,
      stopAtPreviewEnd: true,
      loopEnabledByDefault: false,
    },
    suggestions: {
      defaultCategory: 'all',
      defaultSort: 'time',
      autoExpandDetails: true,
      focusNextAfterReview: true,
      confirmBeforeApply: true,
      showContextTranscript: true,
    },
    exportDefaults: {
      format: 'WAV_PCM16',
      sampleRate: 'source',
      defaultCrossfadeMs: 10,
      filenamePrefix: '',
    },
    shortcuts: { ...DEFAULT_SHORTCUTS },
    accessibility: {
      fontScale: 'md',
      motion: 'normal',
      highContrast: false,
    },
    storage: {
      autoSaveProjectEdits: true,
    },
  };
}

const VALID_FONT_SCALES = new Set<TranscriptFontScale>(['sm', 'md', 'lg']);
const VALID_EXPORT_FORMATS = new Set<ExportDefaultFormat>([
  'WAV_PCM16',
  'WAV_PCM24',
  'WAV_FLOAT32',
  'RF64_PCM24',
]);
const VALID_SAMPLE_RATES = new Set<number | string>(['source', 16000, 44100, 48000]);
const VALID_SEEK_STEPS = new Set<number>([1, 5, 10]);
const VALID_CONTEXT_SECS = new Set<number>([0.5, 1, 1.5, 2]);
const VALID_CROSSFADES = new Set<number>([0, 5, 10, 15]);
const VALID_SUGGESTION_CATS = new Set<SuggestionCategoryFilter>([
  'all',
  'filler',
  'pause',
  'repetition',
  'breath',
]);
const VALID_SUGGESTION_SORTS = new Set<SuggestionSortOrder>([
  'time',
  'category',
  'confidence',
  'order',
]);

const RESERVED_BROWSER_SHORTCUTS = new Set<string>([
  'Mod+KeyR',
  'Mod+KeyW',
  'Mod+KeyT',
  'Mod+KeyN',
  'Mod+KeyQ',
  'F5',
  'F12',
]);

export function validateShortcutBinding(
  action: keyof KeyboardShortcutMap,
  binding: string,
  currentMap: KeyboardShortcutMap,
): { valid: boolean; reason?: string } {
  const trimmed = binding.trim();
  if (!trimmed || trimmed.length > 32) {
    return { valid: false, reason: 'EMPTY_OR_TOO_LONG' };
  }
  if (RESERVED_BROWSER_SHORTCUTS.has(trimmed)) {
    return { valid: false, reason: 'BROWSER_RESERVED' };
  }
  for (const [key, val] of Object.entries(currentMap)) {
    if (key !== action && val === trimmed) {
      return { valid: false, reason: `CONFLICT:${key}` };
    }
  }
  return { valid: true };
}

/**
 * Validates and migrates any stored settings object (including legacy v0 / missing fields)
 * into a safe, complete GlobalSettingsV1 object without throwing.
 */
export function migrateAndValidateSettings(
  raw: unknown,
  legacyThemeRaw?: string | null,
): { settings: GlobalSettingsV1; migrated: boolean; warnings: string[] } {
  const defaults = createDefaultGlobalSettings();
  const warnings: string[] = [];
  let migrated = false;

  if (!raw || typeof raw !== 'object') {
    if (isValidThemeChoice(legacyThemeRaw)) {
      defaults.appearance.theme = legacyThemeRaw;
      migrated = true;
    }
    return { settings: defaults, migrated, warnings };
  }

  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    migrated = true;
  }

  const app = (obj.appearance as Record<string, unknown> | undefined) ?? {};
  const lang = (obj.language as Record<string, unknown> | undefined) ?? {};
  const ws = (obj.workspace as Record<string, unknown> | undefined) ?? {};
  const pb = (obj.playback as Record<string, unknown> | undefined) ?? {};
  const sug = (obj.suggestions as Record<string, unknown> | undefined) ?? {};
  const exp = (obj.exportDefaults as Record<string, unknown> | undefined) ?? {};
  const sc = (obj.shortcuts as Record<string, unknown> | undefined) ?? {};
  const a11y = (obj.accessibility as Record<string, unknown> | undefined) ?? {};
  const st = (obj.storage as Record<string, unknown> | undefined) ?? {};

  const theme = isValidThemeChoice(app.theme)
    ? app.theme
    : isValidThemeChoice(legacyThemeRaw)
      ? legacyThemeRaw
      : defaults.appearance.theme;
  if (app.theme !== undefined && !isValidThemeChoice(app.theme)) {
    warnings.push('Invalid theme reset to light');
  }

  const locale = lang.locale === 'en' ? 'en' : 'fa';

  const defaultRate = SUPPORTED_PLAYBACK_RATES.includes(pb.defaultRate as SupportedPlaybackRate)
    ? (pb.defaultRate as SupportedPlaybackRate)
    : defaults.playback.defaultRate;

  const seekStepSec = VALID_SEEK_STEPS.has(Number(pb.seekStepSec))
    ? (Number(pb.seekStepSec) as 1 | 5 | 10)
    : defaults.playback.seekStepSec;

  const contextBeforeSec = VALID_CONTEXT_SECS.has(Number(pb.contextBeforeSec))
    ? (Number(pb.contextBeforeSec) as 0.5 | 1 | 1.5 | 2)
    : defaults.playback.contextBeforeSec;

  const contextAfterSec = VALID_CONTEXT_SECS.has(Number(pb.contextAfterSec))
    ? (Number(pb.contextAfterSec) as 0.5 | 1 | 1.5 | 2)
    : defaults.playback.contextAfterSec;

  const format = VALID_EXPORT_FORMATS.has(exp.format as ExportDefaultFormat)
    ? (exp.format as ExportDefaultFormat)
    : defaults.exportDefaults.format;

  const sampleRate = VALID_SAMPLE_RATES.has(exp.sampleRate as number | string)
    ? (exp.sampleRate as ExportDefaultSampleRate | 'source')
    : defaults.exportDefaults.sampleRate;

  const defaultCrossfadeMs = VALID_CROSSFADES.has(Number(exp.defaultCrossfadeMs))
    ? (Number(exp.defaultCrossfadeMs) as 0 | 5 | 10 | 15)
    : defaults.exportDefaults.defaultCrossfadeMs;

  const fontScale = VALID_FONT_SCALES.has(a11y.fontScale as TranscriptFontScale)
    ? (a11y.fontScale as TranscriptFontScale)
    : VALID_FONT_SCALES.has(ws.transcriptFontScale as TranscriptFontScale)
      ? (ws.transcriptFontScale as TranscriptFontScale)
      : defaults.accessibility.fontScale;

  const mergedShortcuts: KeyboardShortcutMap = { ...DEFAULT_SHORTCUTS };
  for (const key of Object.keys(DEFAULT_SHORTCUTS) as Array<keyof KeyboardShortcutMap>) {
    const candidate = sc[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const check = validateShortcutBinding(key, candidate, mergedShortcuts);
      if (check.valid) {
        mergedShortcuts[key] = candidate.trim();
      } else {
        warnings.push(`Shortcut ${key} reset due to ${check.reason}`);
      }
    }
  }

  return {
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      appearance: {
        theme,
        showWaveformGrid:
          typeof app.showWaveformGrid === 'boolean'
            ? app.showWaveformGrid
            : defaults.appearance.showWaveformGrid,
      },
      language: {
        locale,
        timecodeFormat:
          lang.timecodeFormat === 'hh:mm:ss' ? 'hh:mm:ss' : defaults.language.timecodeFormat,
        persianDigits:
          typeof lang.persianDigits === 'boolean'
            ? lang.persianDigits
            : defaults.language.persianDigits,
      },
      workspace: {
        showSuggestionsPanel:
          typeof ws.showSuggestionsPanel === 'boolean'
            ? ws.showSuggestionsPanel
            : defaults.workspace.showSuggestionsPanel,
        showFilesPanel:
          typeof ws.showFilesPanel === 'boolean'
            ? ws.showFilesPanel
            : defaults.workspace.showFilesPanel,
        density: ws.density === 'compact' ? 'compact' : 'comfortable',
        transcriptFontScale: VALID_FONT_SCALES.has(ws.transcriptFontScale as TranscriptFontScale)
          ? (ws.transcriptFontScale as TranscriptFontScale)
          : fontScale,
        showTimelineRuler:
          typeof ws.showTimelineRuler === 'boolean'
            ? ws.showTimelineRuler
            : defaults.workspace.showTimelineRuler,
        showTimelineMarkers:
          typeof ws.showTimelineMarkers === 'boolean'
            ? ws.showTimelineMarkers
            : defaults.workspace.showTimelineMarkers,
        showEditRegions:
          typeof ws.showEditRegions === 'boolean'
            ? ws.showEditRegions
            : defaults.workspace.showEditRegions,
        resetZoomOnProjectOpen:
          typeof ws.resetZoomOnProjectOpen === 'boolean'
            ? ws.resetZoomOnProjectOpen
            : defaults.workspace.resetZoomOnProjectOpen,
      },
      playback: {
        defaultRate,
        seekStepSec,
        contextBeforeSec,
        contextAfterSec,
        stopAtPreviewEnd:
          typeof pb.stopAtPreviewEnd === 'boolean'
            ? pb.stopAtPreviewEnd
            : defaults.playback.stopAtPreviewEnd,
        loopEnabledByDefault:
          typeof pb.loopEnabledByDefault === 'boolean'
            ? pb.loopEnabledByDefault
            : defaults.playback.loopEnabledByDefault,
      },
      suggestions: {
        defaultCategory: VALID_SUGGESTION_CATS.has(sug.defaultCategory as SuggestionCategoryFilter)
          ? (sug.defaultCategory as SuggestionCategoryFilter)
          : defaults.suggestions.defaultCategory,
        defaultSort: VALID_SUGGESTION_SORTS.has(sug.defaultSort as SuggestionSortOrder)
          ? (sug.defaultSort as SuggestionSortOrder)
          : defaults.suggestions.defaultSort,
        autoExpandDetails:
          typeof sug.autoExpandDetails === 'boolean'
            ? sug.autoExpandDetails
            : defaults.suggestions.autoExpandDetails,
        focusNextAfterReview:
          typeof sug.focusNextAfterReview === 'boolean'
            ? sug.focusNextAfterReview
            : defaults.suggestions.focusNextAfterReview,
        confirmBeforeApply:
          typeof sug.confirmBeforeApply === 'boolean'
            ? sug.confirmBeforeApply
            : defaults.suggestions.confirmBeforeApply,
        showContextTranscript:
          typeof sug.showContextTranscript === 'boolean'
            ? sug.showContextTranscript
            : defaults.suggestions.showContextTranscript,
      },
      exportDefaults: {
        format,
        sampleRate,
        defaultCrossfadeMs,
        filenamePrefix:
          typeof exp.filenamePrefix === 'string'
            ? exp.filenamePrefix.slice(0, 40)
            : defaults.exportDefaults.filenamePrefix,
      },
      shortcuts: mergedShortcuts,
      accessibility: {
        fontScale,
        motion: a11y.motion === 'reduced' ? 'reduced' : 'normal',
        highContrast: Boolean(a11y.highContrast),
      },
      storage: {
        autoSaveProjectEdits:
          typeof st.autoSaveProjectEdits === 'boolean'
            ? st.autoSaveProjectEdits
            : defaults.storage.autoSaveProjectEdits,
      },
    },
    migrated,
    warnings,
  };
}

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

export function loadGlobalSettings(storage?: StorageLike | null): GlobalSettingsV1 {
  const store = getStorage(storage);
  if (!store) return createDefaultGlobalSettings();
  try {
    const rawStr = store.getItem(SETTINGS_STORAGE_KEY);
    const legacyTheme = store.getItem(THEME_STORAGE_KEY);
    const parsed = rawStr ? JSON.parse(rawStr) : null;
    const { settings } = migrateAndValidateSettings(parsed, legacyTheme);
    return settings;
  } catch {
    return createDefaultGlobalSettings();
  }
}

export function saveGlobalSettings(
  settings: GlobalSettingsV1,
  storage?: StorageLike | null,
): { ok: boolean; error?: string } {
  const store = getStorage(storage);
  if (!store) return { ok: false, error: 'STORAGE_UNAVAILABLE' };
  try {
    const validated = migrateAndValidateSettings(settings).settings;
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
    // Keep fast boot script key in sync so initial paint never flashes wrong theme
    saveStoredThemeChoice(validated.appearance.theme, store);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'STORAGE_WRITE_FAILED',
    };
  }
}

export function resetSettingsCategory(
  current: GlobalSettingsV1,
  category: SettingsCategoryKey,
): GlobalSettingsV1 {
  const defaults = createDefaultGlobalSettings();
  return {
    ...current,
    [category]: structuredClone(defaults[category]),
  };
}

export function resetAllGlobalSettings(): GlobalSettingsV1 {
  return createDefaultGlobalSettings();
}
