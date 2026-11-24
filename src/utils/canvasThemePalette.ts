/**
 * Centralized CSS-Variable Canvas & SVG Theme Palette Reader (AUD-13)
 *
 * Single Source of Truth for Canvas 2D and SVG visualizations (`WaveformCanvas`,
 * `SuggestionWaveformMiniCard`, `DspFrequencyResponseGraph`, `AuditionTransportBar`)
 * so acoustic renderings stay synchronized with Light, Dark, and High-Contrast themes.
 */

export interface CanvasThemePalette {
  readonly isDark: boolean;
  readonly isHighContrast: boolean;
  readonly surface: string;
  readonly surfaceShell: string;
  readonly surfaceSecondary: string;
  readonly border: string;
  readonly borderSubtle: string;
  readonly text: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly brand: string;
  readonly brandSolid: string;
  readonly brandSoft: string;
  readonly accentText: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly waveBg: string;
  readonly waveSurface: string;
  readonly waveStroke: string;
  readonly waveStrokeSecondary: string;
  readonly waveSelection: string;
  readonly waveGrid: string;
  readonly wavePlayhead: string;
  readonly trackHost: string;
  readonly trackGuest: string;
}

const FALLBACK_LIGHT: CanvasThemePalette = {
  isDark: false,
  isHighContrast: false,
  surface: '#FFFFFF',
  surfaceShell: '#F5F6F8',
  surfaceSecondary: '#EEF1F4',
  border: '#E2E7EC',
  borderSubtle: '#EDF0F4',
  text: '#141C24',
  textSecondary: '#424E5B',
  textMuted: '#576370',
  brand: '#0F766E',
  brandSolid: '#0F766E',
  brandSoft: '#E5F4F0',
  accentText: '#0F6254',
  success: '#15803D',
  warning: '#D98A1C',
  danger: '#C83742',
  waveBg: '#0D1520',
  waveSurface: '#131E2D',
  waveStroke: '#1FA38B',
  waveStrokeSecondary: '#38BDF8',
  waveSelection: '#E5A13B',
  waveGrid: 'rgba(148, 163, 184, 0.18)',
  wavePlayhead: '#F43F5E',
  trackHost: '#0F766E',
  trackGuest: '#0284C7',
};

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = style.getPropertyValue(name).trim();
  return val.length > 0 ? val : fallback;
}

export function readCanvasThemePalette(): CanvasThemePalette {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return FALLBACK_LIGHT;
  }
  const root = document.documentElement;
  const style = window.getComputedStyle(root);
  const isDark = root.classList.contains('dark');
  const isHighContrast = root.classList.contains('avp-high-contrast');

  return {
    isDark,
    isHighContrast,
    surface: readCssVar(style, '--avp-surface', FALLBACK_LIGHT.surface),
    surfaceShell: readCssVar(style, '--avp-surface-shell', FALLBACK_LIGHT.surfaceShell),
    surfaceSecondary: readCssVar(style, '--avp-surface-secondary', FALLBACK_LIGHT.surfaceSecondary),
    border: readCssVar(style, '--avp-border', FALLBACK_LIGHT.border),
    borderSubtle: readCssVar(style, '--avp-border-subtle', FALLBACK_LIGHT.borderSubtle),
    text: readCssVar(style, '--avp-text', FALLBACK_LIGHT.text),
    textSecondary: readCssVar(style, '--avp-text-secondary', FALLBACK_LIGHT.textSecondary),
    textMuted: readCssVar(style, '--avp-text-muted', FALLBACK_LIGHT.textMuted),
    brand: readCssVar(style, '--avp-brand', FALLBACK_LIGHT.brand),
    brandSolid: readCssVar(style, '--avp-brand-solid', FALLBACK_LIGHT.brandSolid),
    brandSoft: readCssVar(style, '--avp-brand-soft', FALLBACK_LIGHT.brandSoft),
    accentText: readCssVar(style, '--avp-accent-text', FALLBACK_LIGHT.accentText),
    success: readCssVar(style, '--avp-success', FALLBACK_LIGHT.success),
    warning: readCssVar(style, '--avp-warning', FALLBACK_LIGHT.warning),
    danger: readCssVar(style, '--avp-danger', FALLBACK_LIGHT.danger),
    waveBg: readCssVar(style, '--avp-wave-bg', FALLBACK_LIGHT.waveBg),
    waveSurface: readCssVar(style, '--avp-wave-surface', FALLBACK_LIGHT.waveSurface),
    waveStroke: readCssVar(style, '--avp-wave-stroke', FALLBACK_LIGHT.waveStroke),
    waveStrokeSecondary: readCssVar(
      style,
      '--avp-wave-stroke-secondary',
      FALLBACK_LIGHT.waveStrokeSecondary,
    ),
    waveSelection: readCssVar(style, '--avp-wave-selection', FALLBACK_LIGHT.waveSelection),
    waveGrid: readCssVar(style, '--avp-wave-grid', FALLBACK_LIGHT.waveGrid),
    wavePlayhead: readCssVar(style, '--avp-wave-playhead', FALLBACK_LIGHT.wavePlayhead),
    trackHost: readCssVar(style, '--avp-track-host', FALLBACK_LIGHT.trackHost),
    trackGuest: readCssVar(style, '--avp-track-guest', FALLBACK_LIGHT.trackGuest),
  };
}
