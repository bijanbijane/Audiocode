// src/sw/OfflineFirstServiceWorker.ts
var APP_SHELL_CACHE_VERSION = "paudio-shell-v1.2.0";
var APP_SHELL_CRITICAL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest"
];
function shouldBypassShellInterception(url) {
  return url.pathname.startsWith("/models/") || url.pathname.startsWith("/api/");
}
function enforceCrossOriginIsolationHeaders(response) {
  if (response.status === 0 || response.type === "opaque") {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
async function isSafeToActivateNewVersion(locksApi) {
  const api = locksApi ?? (typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : void 0);
  if (!api?.query) return true;
  const state = await api.query();
  const heldLocks = state.held ?? [];
  const hasActiveProjectOrAiJob = heldLocks.some(
    (lock) => Boolean(lock.name?.startsWith("project_edit_lock_")) || Boolean(lock.name?.startsWith("avapardaz-")) || Boolean(lock.name?.startsWith("ai-job-"))
  );
  return !hasActiveProjectOrAiJob;
}
function registerOfflineFirstServiceWorkerListeners(scope) {
  scope.addEventListener("install", (event) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);
        await cache.addAll(APP_SHELL_CRITICAL_ASSETS);
        const canActivateImmediately = await isSafeToActivateNewVersion();
        if (canActivateImmediately) {
          await scope.skipWaiting();
        }
      })()
    );
  });
  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const keys = await scope.caches.keys();
        for (const key of keys) {
          if (key.startsWith("paudio-shell-") && key !== APP_SHELL_CACHE_VERSION) {
            await scope.caches.delete(key);
          }
        }
        await scope.clients.claim();
      })()
    );
  });
  scope.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (shouldBypassShellInterception(url)) {
      return;
    }
    event.respondWith(
      (async () => {
        const cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);
        try {
          const networkResponse = await fetch(request);
          if (networkResponse.ok && (url.origin === scope.location.origin || url.pathname.endsWith(".wasm"))) {
            await cache.put(request, networkResponse.clone());
          }
          return enforceCrossOriginIsolationHeaders(networkResponse);
        } catch {
          const cachedResponse = await cache.match(request) ?? await cache.match("/index.html");
          if (!cachedResponse) {
            return enforceCrossOriginIsolationHeaders(
              new Response("Offline Mode: Resource not found in local shell cache.", {
                status: 503,
                statusText: "Service Unavailable"
              })
            );
          }
          return enforceCrossOriginIsolationHeaders(cachedResponse);
        }
      })()
    );
  });
}
var runtimeSelf = typeof self !== "undefined" ? self : void 0;
if (runtimeSelf && typeof runtimeSelf.skipWaiting === "function" && typeof runtimeSelf.addEventListener === "function" && runtimeSelf.caches && runtimeSelf.clients) {
  registerOfflineFirstServiceWorkerListeners(runtimeSelf);
}
export {
  APP_SHELL_CACHE_VERSION,
  APP_SHELL_CRITICAL_ASSETS,
  enforceCrossOriginIsolationHeaders,
  isSafeToActivateNewVersion,
  registerOfflineFirstServiceWorkerListeners,
  shouldBypassShellInterception
};
