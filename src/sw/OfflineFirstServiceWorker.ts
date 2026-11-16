/**
 * Offline-First Atomic Service Worker with COOP/COEP Guarantee (Architecture Doc Sections 3, 11, 47 & 48)
 * - Precaches critical App Shell assets atomically.
 * - Guarantees Cross-Origin-Opener-Policy & Cross-Origin-Embedder-Policy on cached/offline responses
 *   so SharedArrayBuffer remains operational when the user launches offline.
 * - Queries navigator.locks before skipWaiting() to avoid updating mid-edit or during active AI jobs.
 */

export const APP_SHELL_CACHE_VERSION = 'paudio-shell-v1.2.0';

export const APP_SHELL_CRITICAL_ASSETS: readonly string[] = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
];

export interface LockSnapshotEntryLike {
  readonly name?: string;
}

export interface LockManagerLike {
  query?: () => Promise<{ readonly held?: readonly LockSnapshotEntryLike[] }>;
}

export interface SwCacheLike {
  addAll(requests: readonly string[]): Promise<void>;
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

export interface SwCacheStorageLike {
  open(cacheName: string): Promise<SwCacheLike>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

export interface SwExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SwFetchEventLike {
  readonly request: Request;
  respondWith(responsePromise: Promise<Response>): void;
}

export interface SwGlobalScopeLike {
  readonly location: { readonly origin: string };
  readonly caches: SwCacheStorageLike;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEventLike) => void): void;
}

/**
 * Model chunks (/models/) are managed directly via ChunkedModelDownloader + OPFS,
 * and backend API calls (/api/) must never be served from static app shell cache.
 */
export function shouldBypassShellInterception(url: URL): boolean {
  return url.pathname.startsWith('/models/') || url.pathname.startsWith('/api/');
}

/**
 * Injects Cross-Origin Isolation headers onto cached or fetched responses
 * so window.crossOriginIsolated stays true in full offline mode.
 */
export function enforceCrossOriginIsolationHeaders(response: Response): Response {
  if (response.status === 0 || response.type === 'opaque') {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Checks Web Locks state so atomic updates never replace the active worker while a project or AI job is running.
 */
export async function isSafeToActivateNewVersion(
  locksApi?: LockManagerLike,
): Promise<boolean> {
  const api =
    locksApi ??
    (typeof navigator !== 'undefined' && 'locks' in navigator
      ? (navigator.locks as unknown as LockManagerLike)
      : undefined);

  if (!api?.query) return true;

  const state = await api.query();
  const heldLocks = state.held ?? [];

  const hasActiveProjectOrAiJob = heldLocks.some(
    (lock) =>
      Boolean(lock.name?.startsWith('project_edit_lock_')) ||
      Boolean(lock.name?.startsWith('avapardaz-')) ||
      Boolean(lock.name?.startsWith('ai-job-')),
  );

  return !hasActiveProjectOrAiJob;
}

export function registerOfflineFirstServiceWorkerListeners(scope: SwGlobalScopeLike): void {
  scope.addEventListener('install', (event: SwExtendableEventLike) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);
        await cache.addAll(APP_SHELL_CRITICAL_ASSETS);

        const canActivateImmediately = await isSafeToActivateNewVersion();
        if (canActivateImmediately) {
          await scope.skipWaiting();
        }
      })(),
    );
  });

  scope.addEventListener('activate', (event: SwExtendableEventLike) => {
    event.waitUntil(
      (async () => {
        const keys = await scope.caches.keys();
        for (const key of keys) {
          if (key.startsWith('paudio-shell-') && key !== APP_SHELL_CACHE_VERSION) {
            await scope.caches.delete(key);
          }
        }
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('fetch', (event: SwFetchEventLike) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (shouldBypassShellInterception(url)) {
      return;
    }

    event.respondWith(
      (async () => {
        const cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);

        try {
          const networkResponse = await fetch(request);
          if (
            networkResponse.ok &&
            (url.origin === scope.location.origin || url.pathname.endsWith('.wasm'))
          ) {
            await cache.put(request, networkResponse.clone());
          }
          return enforceCrossOriginIsolationHeaders(networkResponse);
        } catch {
          const cachedResponse =
            (await cache.match(request)) ?? (await cache.match('/index.html'));

          if (!cachedResponse) {
            return enforceCrossOriginIsolationHeaders(
              new Response('Offline Mode: Resource not found in local shell cache.', {
                status: 503,
                statusText: 'Service Unavailable',
              }),
            );
          }
          return enforceCrossOriginIsolationHeaders(cachedResponse);
        }
      })(),
    );
  });
}

// Auto-bind only when executed inside a genuine Service Worker Global Scope
const runtimeSelf = typeof self !== 'undefined' ? (self as unknown as Partial<SwGlobalScopeLike>) : undefined;
if (
  runtimeSelf &&
  typeof runtimeSelf.skipWaiting === 'function' &&
  typeof runtimeSelf.addEventListener === 'function' &&
  runtimeSelf.caches &&
  runtimeSelf.clients
) {
  registerOfflineFirstServiceWorkerListeners(runtimeSelf as SwGlobalScopeLike);
}
