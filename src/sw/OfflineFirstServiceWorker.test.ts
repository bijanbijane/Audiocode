import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_SHELL_CACHE_VERSION,
  APP_SHELL_CRITICAL_ASSETS,
  enforceCrossOriginIsolationHeaders,
  isSafeToActivateNewVersion,
  registerOfflineFirstServiceWorkerListeners,
  shouldBypassShellInterception,
  SwExtendableEventLike,
  SwFetchEventLike,
  SwGlobalScopeLike,
} from './OfflineFirstServiceWorker';

test('enforceCrossOriginIsolationHeaders guarantees COOP/COEP/CORP on cached offline responses while preserving opaque responses', () => {
  const plain = new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const isolated = enforceCrossOriginIsolationHeaders(plain);

  assert.equal(isolated.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(isolated.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(isolated.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(isolated.headers.get('Content-Type'), 'text/html');

  const opaqueLike = { status: 0, type: 'opaque' } as unknown as Response;
  assert.equal(enforceCrossOriginIsolationHeaders(opaqueLike), opaqueLike);
});

test('isSafeToActivateNewVersion blocks skipWaiting while project edit locks or AI jobs are held', async () => {
  const unsafeProject = await isSafeToActivateNewVersion({
    query: async () => ({ held: [{ name: 'project_edit_lock_ep1' }] }),
  });
  assert.equal(unsafeProject, false);

  const unsafeAiJob = await isSafeToActivateNewVersion({
    query: async () => ({ held: [{ name: 'ai-job-whisper-chunk-4' }] }),
  });
  assert.equal(unsafeAiJob, false);

  const safeIdle = await isSafeToActivateNewVersion({
    query: async () => ({ held: [{ name: 'unrelated-telemetry-lock' }] }),
  });
  assert.equal(safeIdle, true);
});

test('shouldBypassShellInterception isolates /models/ and /api/ from Service Worker shell caching', () => {
  assert.equal(shouldBypassShellInterception(new URL('https://studio.local/models/whisper-fa.bin')), true);
  assert.equal(shouldBypassShellInterception(new URL('https://studio.local/api/license/verify')), true);
  assert.equal(shouldBypassShellInterception(new URL('https://studio.local/index.html')), false);
});

test('ServiceWorker install/activate lifecycle caches critical shell assets and purges stale caches', async () => {
  const stored = new Map<string, Response>();
  const deletedCaches: string[] = [];
  let skipWaitingCalled = false;
  let claimed = false;

  const listeners = new Map<string, (ev: unknown) => void>();
  const fakeScope: SwGlobalScopeLike = {
    location: { origin: 'https://studio.local' },
    caches: {
      open: async () => ({
        addAll: async (assets) => {
          for (const a of assets) stored.set(a, new Response('ok', { status: 200 }));
        },
        match: async (req) => stored.get(typeof req === 'string' ? req : req.url),
        put: async (req, res) => {
          stored.set(typeof req === 'string' ? req : req.url, res);
        },
      }),
      keys: async () => ['paudio-shell-v1.0.0', APP_SHELL_CACHE_VERSION, 'unrelated-cache'],
      delete: async (k) => {
        deletedCaches.push(k);
        return true;
      },
    },
    clients: {
      claim: async () => {
        claimed = true;
      },
    },
    skipWaiting: async () => {
      skipWaitingCalled = true;
    },
    addEventListener: ((type: string, fn: (ev: unknown) => void) => {
      listeners.set(type, fn);
    }) as SwGlobalScopeLike['addEventListener'],
  };

  registerOfflineFirstServiceWorkerListeners(fakeScope);

  const installWait: Promise<unknown>[] = [];
  listeners.get('install')?.({ waitUntil: (p: Promise<unknown>) => installWait.push(p) });
  await Promise.all(installWait);

  for (const asset of APP_SHELL_CRITICAL_ASSETS) {
    assert.equal(stored.has(asset), true);
  }
  assert.equal(skipWaitingCalled, true);

  const activateWait: Promise<unknown>[] = [];
  listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => activateWait.push(p) });
  await Promise.all(activateWait);

  assert.deepEqual(deletedCaches, ['paudio-shell-v1.0.0']);
  assert.equal(claimed, true);
});
