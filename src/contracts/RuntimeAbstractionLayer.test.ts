import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserLocalExecutionContext,
  ExecutionPolicyRouter,
  NativeDesktopExecutionContext,
  RuntimeAgnosticTaskEnvelope,
} from './RuntimeAbstractionLayer';
import { TimeMath } from './timebase.contract';

test('ExecutionPolicyRouter enforces Golden Rule 3 (v1 Cloud disabled) and explicit external consent', () => {
  const router = new ExecutionPolicyRouter();

  assert.equal(
    router.selectTargetRuntime({
      requestedRuntime: 'BROWSER_LOCAL_RUNTIME',
      hasExplicitExternalApiConsent: false,
    }),
    'BROWSER_LOCAL_RUNTIME',
  );

  assert.throws(
    () =>
      router.selectTargetRuntime({
        requestedRuntime: 'FIRST_PARTY_CLOUD_RUNTIME',
        hasExplicitExternalApiConsent: true,
      }),
    /RUNTIME_POLICY_CLOUD_DISABLED_IN_V1/,
  );

  assert.throws(
    () =>
      router.selectTargetRuntime({
        requestedRuntime: 'EXTERNAL_API_RUNTIME',
        hasExplicitExternalApiConsent: false,
      }),
    /RUNTIME_POLICY_EXTERNAL_CONSENT_MISSING/,
  );

  assert.equal(
    router.selectTargetRuntime({
      requestedRuntime: 'EXTERNAL_API_RUNTIME',
      hasExplicitExternalApiConsent: true,
    }),
    'EXTERNAL_API_RUNTIME',
  );
});

test('ExecutionPolicyRouter dispatches identical RuntimeAgnosticTaskEnvelope across browser & future desktop adapters', async () => {
  const router = new ExecutionPolicyRouter();
  const envelope: RuntimeAgnosticTaskEnvelope<{ targetLufs: number }> = {
    taskId: 'task-master-1',
    nodeOrModelId: 'loudness-normalizer',
    nodeOrModelVersion: '1.2.0',
    audioRange: { start: 0, end: TimeMath.secondsToFlicks(10) },
    sampleRate: 48000,
    channelCount: 2,
    parameters: { targetLufs: -16 },
  };

  const browserCtx: BrowserLocalExecutionContext = {
    kind: 'BROWSER_LOCAL_RUNTIME',
    crossOriginIsolated: true,
    activeComputeBackend: 'WEBGPU',
    opfsQuotaRemainingBytes: 2_000_000_000,
    maxWasmHeapBytes: 512_000_000,
  };

  const desktopCtx: NativeDesktopExecutionContext = {
    kind: 'NATIVE_DESKTOP_RUNTIME',
    nativeGpuBackend: 'METAL',
    directDiskTempPath: '/tmp/avapardaz-cache',
  };

  const adapters = {
    BROWSER_LOCAL_RUNTIME: {
      runtimeKind: 'BROWSER_LOCAL_RUNTIME' as const,
      runtimeVersionMetadata: 'wasm-simd-1.2',
      execute: async (env: RuntimeAgnosticTaskEnvelope<{ targetLufs: number }>) =>
        `browser:${env.parameters.targetLufs}`,
    },
    NATIVE_DESKTOP_RUNTIME: {
      runtimeKind: 'NATIVE_DESKTOP_RUNTIME' as const,
      runtimeVersionMetadata: 'tauri-metal-2.0',
      execute: async (env: RuntimeAgnosticTaskEnvelope<{ targetLufs: number }>) =>
        `desktop:${env.parameters.targetLufs}`,
    },
  };

  const resBrowser = await router.dispatchTask({
    envelope,
    requestedRuntime: 'BROWSER_LOCAL_RUNTIME',
    hasExplicitExternalApiConsent: false,
    context: browserCtx,
    adapters,
  });
  assert.equal(resBrowser.executedOnRuntime, 'BROWSER_LOCAL_RUNTIME');
  assert.equal(resBrowser.output, 'browser:-16');

  const resDesktop = await router.dispatchTask({
    envelope,
    requestedRuntime: 'NATIVE_DESKTOP_RUNTIME',
    hasExplicitExternalApiConsent: false,
    context: desktopCtx,
    adapters,
  });
  assert.equal(resDesktop.executedOnRuntime, 'NATIVE_DESKTOP_RUNTIME');
  assert.equal(resDesktop.output, 'desktop:-16');
});
