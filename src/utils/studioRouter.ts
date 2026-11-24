import { isLabModeEnabled } from './labMode';

export type StudioAppView = 'projects' | 'studio';
export type StudioWorkspaceTab = 'studio' | 'graph' | 'storage' | 'shahab';

export interface ParsedStudioRoute {
  appView: StudioAppView;
  projectId: string | null;
  activeTab: StudioWorkspaceTab;
  isLabMode: boolean;
}

const LAB_ROUTE_TABS: Record<string, StudioWorkspaceTab> = {
  '/lab/shahab': 'shahab',
  '/lab/graph': 'graph',
  '/lab/storage': 'storage',
};

function normalizePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === '/') return '/';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function parseStudioRoute(locationLike?: {
  pathname?: string;
  search?: string;
}): ParsedStudioRoute {
  const rawPath =
    locationLike?.pathname ??
    (typeof window !== 'undefined' ? window.location.pathname : '/');
  const rawSearch =
    locationLike?.search ??
    (typeof window !== 'undefined' ? window.location.search : '');

  const path = normalizePath(rawPath);
  const params = new URLSearchParams(
    rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch,
  );
  const queryLab = isLabModeEnabled(rawSearch);
  const queryProject = params.get('project')?.trim() || null;
  const queryView = params.get('view')?.trim().toLowerCase();
  const queryTab = params.get('tab')?.trim().toLowerCase();

  // Lab sub-routes: /lab/shahab | /lab/graph | /lab/storage
  if (path in LAB_ROUTE_TABS) {
    return {
      appView: 'studio',
      projectId: queryProject,
      activeTab: LAB_ROUTE_TABS[path],
      isLabMode: true,
    };
  }

  // Clean project studio path: /studio or /studio/:projectId
  if (path === '/studio' || path.startsWith('/studio/')) {
    const pathId =
      path.length > '/studio/'.length
        ? decodeURIComponent(path.slice('/studio/'.length))
        : null;
    const validPathId = pathId && pathId.trim().length > 0 ? pathId.trim() : null;
    const resolvedTab: StudioWorkspaceTab =
      queryLab && (queryTab === 'shahab' || queryTab === 'graph' || queryTab === 'storage')
        ? queryTab
        : 'studio';

    return {
      appView: 'studio',
      projectId: validPathId ?? queryProject,
      activeTab: resolvedTab,
      isLabMode: queryLab,
    };
  }

  // Clean projects hub path: /projects or /
  if (path === '/projects') {
    return {
      appView: 'projects',
      projectId: null,
      activeTab: 'studio',
      isLabMode: queryLab,
    };
  }

  // Backward-compatible root with ?mode=lab&view=shahab|graph|storage or ?view=studio or ?project=<id>
  if (queryLab && (queryView === 'shahab' || queryView === 'graph' || queryView === 'storage')) {
    return {
      appView: 'studio',
      projectId: queryProject,
      activeTab: queryView,
      isLabMode: true,
    };
  }

  if (queryView === 'studio' || queryProject) {
    const resolvedTab: StudioWorkspaceTab =
      queryLab && (queryTab === 'shahab' || queryTab === 'graph' || queryTab === 'storage')
        ? queryTab
        : 'studio';
    return {
      appView: 'studio',
      projectId: queryProject,
      activeTab: resolvedTab,
      isLabMode: queryLab,
    };
  }

  return {
    appView: 'projects',
    projectId: null,
    activeTab: 'studio',
    isLabMode: queryLab,
  };
}

export function buildStudioRouteUrl(
  target: {
    appView: StudioAppView;
    projectId?: string | null;
    activeTab?: StudioWorkspaceTab;
    preserveLabMode?: boolean;
  },
  currentHref?: string,
): string {
  const baseHref =
    currentHref ??
    (typeof window !== 'undefined' ? window.location.href : 'http://localhost:3000/');
  const url = new URL(baseHref);
  const currentlyLab = isLabModeEnabled(url.search) || Boolean(target.preserveLabMode);

  // Clean legacy view/project/tab query params so path owns the route cleanly
  url.searchParams.delete('view');
  url.searchParams.delete('project');
  url.searchParams.delete('tab');

  if (currentlyLab) {
    if (!url.searchParams.has('lab') && !url.searchParams.has('mode')) {
      url.searchParams.set('mode', 'lab');
    }
  }

  if (target.appView === 'projects') {
    url.pathname = '/projects';
  } else if (
    currentlyLab &&
    target.activeTab &&
    target.activeTab !== 'studio'
  ) {
    url.pathname = `/lab/${target.activeTab}`;
    if (target.projectId) {
      url.searchParams.set('project', target.projectId);
    }
  } else {
    url.pathname = target.projectId
      ? `/studio/${encodeURIComponent(target.projectId)}`
      : '/studio';
  }

  return `${url.pathname}${url.search}`;
}
