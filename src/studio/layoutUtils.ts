export const DESKTOP_EXPANDED_RAIL_MIN_WIDTH = 1280;

/**
 * On tablet viewports (1024px–1279px), auto-collapse the left rail to its 48px
 * icon strip so the center WaveformCanvas & TranscriptPanel retain ample editing width
 * while keeping `audition-side-dock` visible.
 */
export function shouldCollapseLeftRailByDefault(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }
  return viewportWidth < DESKTOP_EXPANDED_RAIL_MIN_WIDTH;
}

/**
 * Returns true only when rendering the interactive Studio Audio Workbench
 * (and hides studio transport / workflow stepper when viewing dedicated Lab routes).
 */
export function shouldShowStudioWorkbenchChrome(
  isLabMode: boolean,
  activeTab: 'studio' | 'graph' | 'storage' | 'shahab',
): boolean {
  return !isLabMode || activeTab === 'studio';
}

/**
 * Computes responsive width classes for the collapsible left studio dock
 * so 1024px tablet frames preserve generous horizontal space for the center pane.
 */
export function resolveLeftRailWidthClass(
  collapsed: boolean,
  sideDockTab: 'files' | 'effects' | 'history' | 'markers',
): string {
  if (collapsed) return 'lg:w-[48px]';
  return sideDockTab === 'effects'
    ? 'lg:w-[264px] xl:w-[312px]'
    : 'lg:w-[232px] xl:w-[248px]';
}

/**
 * Computes next tab index for WAI-ARIA roving tablist keyboard navigation,
 * honoring RTL horizontal arrow direction.
 */
export function getNextRovingTabIndex(
  currentIndex: number,
  totalCount: number,
  key: string,
  isRtl: boolean,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): number | null {
  if (totalCount <= 0 || currentIndex < 0 || currentIndex >= totalCount) {
    return null;
  }

  if (key === 'Home') return 0;
  if (key === 'End') return totalCount - 1;

  const forwardKey =
    orientation === 'vertical' ? 'ArrowDown' : isRtl ? 'ArrowLeft' : 'ArrowRight';
  const backwardKey =
    orientation === 'vertical' ? 'ArrowUp' : isRtl ? 'ArrowRight' : 'ArrowLeft';

  if (key === forwardKey) {
    return (currentIndex + 1) % totalCount;
  }
  if (key === backwardKey) {
    return (currentIndex - 1 + totalCount) % totalCount;
  }
  return null;
}
