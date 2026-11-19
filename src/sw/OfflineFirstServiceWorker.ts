/**
 * Offline-First Atomic Service Worker with COOP/COEP Guarantee (Architecture Doc & Mission 09)
 * - Precaches critical App Shell assets atomically.
 * - Guarantees Cross-Origin-Opener-Policy & Cross-Origin-Embedder-Policy on cached/offline responses
 *   so SharedArrayBuffer remains operational when the user launches offline.
 * - Strictly bypasses /models/, /api/, /v1/, Range audio streams, private blobs, and external origins.
 * - Queries navigator.locks before skipWaiting() to avoid updating mid-edit or during active AI/render jobs.
 * - Protects existing working caches against storage quota failures during update installation.
 */

export const APP_SHELL_CACHE_VERSION = 'paudio-shell-v1.3.0';

export const APP_SHELL_CRITICAL_ASSETS: readonly string[] = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/asr-stream-worklet.js',
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

export interface SwMessageEventLike {
  readonly data?: { readonly type?: string; readonly activeCriticalTasks?: readonly string[] };
  waitUntil?(promise: Promise<unknown>): void;
}

export interface SwGlobalScopeLike {
  readonly location: { readonly origin: string };
  readonly caches: SwCacheStorageLike;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEventLike) => void): void;
  addEventListener?(type: 'message', listener: (event: SwMessageEventLike) => void): void;
}

/**
 * Model chunks (/models/), API endpoints (/api/, /v1/), and private audio downloads
 * must never be intercepted or served from static app shell cache.
 */
export function shouldBypassShellInterception(
  url: URL,
  origin?: string,
  requestHeaders?: Headers,
): boolean {
  if (
    url.pathname.startsWith('/models/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/v1/')
  ) {
    return true;
  }

  // Never cache partial/Range media requests or user-exported audio downloads
  if (requestHeaders?.has('range')) {
    return true;
  }
  if (/\.(wav|rf64|mp3|ogg|flac|m4a|opus|aac)$/i.test(url.pathname)) {
    return true;
  }

  // Never intercept cross-origin third-party requests (strict Local-First boundary)
  if (origin && url.origin !== origin && !url.pathname.endsWith('.wasm')) {
    return true;
  }

  return false;
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
 * Checks Web Locks state so atomic updates never replace the active worker while a project,
 * transcription, rendering, export, or model installation job is running.
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
      Boolean(lock.name?.startsWith('ai-job-')) ||
      Boolean(lock.name?.startsWith('render-job-')) ||
      Boolean(lock.name?.startsWith('model-install-')),
  );

  return !hasActiveProjectOrAiJob;
}

export function registerOfflineFirstServiceWorkerListeners(scope: SwGlobalScopeLike): void {
  scope.addEventListener('install', (event: SwExtendableEventLike) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);
        try {
          await cache.addAll(APP_SHELL_CRITICAL_ASSETS);
        } catch (err) {
          // Do not delete existing working caches on quota/network failure during install
          throw err;
        }

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
    if (shouldBypassShellInterception(url, scope.location.origin, request.headers)) {
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
            try {
              await cache.put(request, networkResponse.clone());
            } catch {
              // Quota exceeded on secondary cache write: still serve live response safely
            }
          }
          return enforceCrossOriginIsolationHeaders(networkResponse);
        } catch {
          const cachedResponse =
            (await cache.match(request)) ??
            (request.mode === 'navigate' || url.pathname === '/' || !url.pathname.includes('.')
              ? await cache.match('/index.html')
              : undefined);

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

  if (typeof scope.addEventListener === 'function') {
    (scope.addEventListener as (t: 'message', l: (e: SwMessageEventLike) => void) => void)(
      'message',
      (event: SwMessageEventLike) => {
        if (event.data?.type !== 'SKIP_WAITING_IF_SAFE') return;
        const activeTasks = event.data.activeCriticalTasks ?? [];
        if (activeTasks.length > 0) return;

        const activationPromise = (async () => {
          const safe = await isSafeToActivateNewVersion();
          if (safe) {
            await scope.skipWaiting();
          }
        })();
        event.waitUntil?.(activationPromise);
      },
    );
  }
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
