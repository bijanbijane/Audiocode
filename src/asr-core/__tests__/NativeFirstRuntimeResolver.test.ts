import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAsrRuntimeResolver, type LocalAsrRuntimeAdapter } from '../UnifiedLocalAsrRuntime';

function adapter(target: 'BROWSER_WASM_CPU' | 'NATIVE_COMPANION_CPU', runtimeReady: boolean, counters: { probes: number; health: number }): LocalAsrRuntimeAdapter {
  return {
    runtimeTarget: target,
    runtimeName: target,
    probeCapabilities: async () => {
      counters.probes += 1;
      return { available: runtimeReady } as never;
    },
    initializeRuntime: async () => {},
    validateModel: async () => ({ valid: true } as never),
    loadModel: async () => {},
    transcribe: async () => ({} as never),
    cancel: async () => {},
    getHealth: async () => {
      counters.health += 1;
      return { runtimeReady } as never;
    },
    getResourceUsage: () => ({} as never),
    dispose: async () => {},
  } as LocalAsrRuntimeAdapter;
}

test('AUTO_LOCAL SHAHAB policy prefers Native Companion even when a browser model is already installed', async () => {
  const browserCounters = { probes: 0, health: 0 };
  const nativeCounters = { probes: 0, health: 0 };
  const browser = adapter('BROWSER_WASM_CPU', true, browserCounters);
  const native = adapter('NATIVE_COMPANION_CPU', true, nativeCounters);
  const resolver = new LocalAsrRuntimeResolver({ browser, nativeCompanion: native });

  const result = await resolver.resolve({
    preference: 'AUTO_LOCAL',
    preferNativeCompanionWhenReady: true,
    preferBrowserWhenModelInstalled: true,
    hasBrowserInstalledModel: true,
  });

  assert.equal(result.selectedAdapter, native);
  assert.equal(result.selectedTarget, 'NATIVE_COMPANION_CPU');
  assert.equal(result.reason, 'AUTO_LOCAL_SELECTED_NATIVE_COMPANION_PRIMARY');
  assert.deepEqual(result.checkedTargets, ['NATIVE_COMPANION_CPU']);
  assert.equal(nativeCounters.health, 1);
  assert.equal(browserCounters.probes, 0);
});

test('AUTO_LOCAL SHAHAB policy falls back to Browser WASM only when Native Companion is unavailable', async () => {
  const browserCounters = { probes: 0, health: 0 };
  const nativeCounters = { probes: 0, health: 0 };
  const browser = adapter('BROWSER_WASM_CPU', true, browserCounters);
  const native = adapter('NATIVE_COMPANION_CPU', false, nativeCounters);
  const resolver = new LocalAsrRuntimeResolver({ browser, nativeCompanion: native });

  const result = await resolver.resolve({
    preference: 'AUTO_LOCAL',
    preferNativeCompanionWhenReady: true,
    preferBrowserWhenModelInstalled: true,
    hasBrowserInstalledModel: true,
  });

  assert.equal(result.selectedAdapter, browser);
  assert.equal(result.selectedTarget, 'BROWSER_WASM_CPU');
  assert.equal(result.reason, 'AUTO_LOCAL_SELECTED_BROWSER_INSTALLED_MODEL');
  assert.deepEqual(result.checkedTargets, ['NATIVE_COMPANION_CPU', 'BROWSER_WASM_CPU']);
  assert.equal(nativeCounters.health, 1);
  assert.equal(browserCounters.probes, 1);
});
