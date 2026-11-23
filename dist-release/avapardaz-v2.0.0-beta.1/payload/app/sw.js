// Avapardaz Offline-First Service Worker (classic script — no ES module export syntax)
var APP_SHELL_CACHE_VERSION = "paudio-shell-v1.3.0";
var APP_SHELL_CRITICAL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/asr-stream-worklet.js"
];

function shouldBypassShellInterception(url, origin, requestHeaders) {
  if (
    url.pathname.startsWith("/models/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/v1/")
  ) {
    return true;
  }
  if (requestHeaders && requestHeaders.has("range")) {
    return true;
  }
  if (/\.(wav|rf64|mp3|ogg|flac|m4a|opus|aac)$/i.test(url.pathname)) {
    return true;
  }
  if (origin && url.origin !== origin && !url.pathname.endsWith(".wasm")) {
    return true;
  }
  return false;
}

function enforceCrossOriginIsolationHeaders(response) {
  if (response.status === 0 || response.type === "opaque") {
    return response;
  }
  var headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

async function isSafeToActivateNewVersion(locksApi) {
  var api =
    locksApi ||
    (typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined);
  if (!api || !api.query) return true;
  var state = await api.query();
  var heldLocks = state.held || [];
  var hasActiveProjectOrAiJob = heldLocks.some(function (lock) {
    return (
      Boolean(lock.name && lock.name.startsWith("project_edit_lock_")) ||
      Boolean(lock.name && lock.name.startsWith("avapardaz-")) ||
      Boolean(lock.name && lock.name.startsWith("ai-job-")) ||
      Boolean(lock.name && lock.name.startsWith("render-job-")) ||
      Boolean(lock.name && lock.name.startsWith("model-install-"))
    );
  });
  return !hasActiveProjectOrAiJob;
}

function registerOfflineFirstServiceWorkerListeners(scope) {
  scope.addEventListener("install", function (event) {
    event.waitUntil(
      (async function () {
        var cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);
        await cache.addAll(APP_SHELL_CRITICAL_ASSETS);
        var canActivateImmediately = await isSafeToActivateNewVersion();
        if (canActivateImmediately) {
          await scope.skipWaiting();
        }
      })()
    );
  });

  scope.addEventListener("activate", function (event) {
    event.waitUntil(
      (async function () {
        var keys = await scope.caches.keys();
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (key.startsWith("paudio-shell-") && key !== APP_SHELL_CACHE_VERSION) {
            await scope.caches.delete(key);
          }
        }
        await scope.clients.claim();
      })()
    );
  });

  scope.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var url = new URL(request.url);
    if (shouldBypassShellInterception(url, scope.location.origin, request.headers)) {
      return;
    }
    event.respondWith(
      (async function () {
        var cache = await scope.caches.open(APP_SHELL_CACHE_VERSION);
        try {
          var networkResponse = await fetch(request);
          if (
            networkResponse.ok &&
            (url.origin === scope.location.origin || url.pathname.endsWith(".wasm"))
          ) {
            try {
              await cache.put(request, networkResponse.clone());
            } catch (_quotaErr) {
              // Quota exceeded on secondary write; still return live response cleanly
            }
          }
          return enforceCrossOriginIsolationHeaders(networkResponse);
        } catch (_offlineErr) {
          var cachedResponse = await cache.match(request);
          if (
            !cachedResponse &&
            (request.mode === "navigate" || url.pathname === "/" || url.pathname.indexOf(".") === -1)
          ) {
            cachedResponse = await cache.match("/index.html");
          }
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

  scope.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "SKIP_WAITING_IF_SAFE") return;
    if (Array.isArray(data.activeCriticalTasks) && data.activeCriticalTasks.length > 0) return;
    var promise = (async function () {
      var safe = await isSafeToActivateNewVersion();
      if (safe) {
        await scope.skipWaiting();
      }
    })();
    if (typeof event.waitUntil === "function") {
      event.waitUntil(promise);
    }
  });
}

if (
  typeof self !== "undefined" &&
  typeof self.skipWaiting === "function" &&
  typeof self.addEventListener === "function" &&
  self.caches &&
  self.clients
) {
  registerOfflineFirstServiceWorkerListeners(self);
}
