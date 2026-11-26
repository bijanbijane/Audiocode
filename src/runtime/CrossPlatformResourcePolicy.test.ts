import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGracefulDegradationPlan,
  probeCrossPlatformCapabilities,
  resolveResourceTierProfile,
} from './CrossPlatformResourcePolicy';

test('CrossPlatformResourcePolicy probes Windows/macOS/Linux x86_64/ARM64 and Chrome/Edge/Firefox/Safari without M2 hardcoding', () => {
  const winChrome = probeCrossPlatformCapabilities({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    architectureHint: 'x86_64',
    hardwareConcurrency: 8,
    deviceMemoryGb: 16,
    crossOriginIsolated: true,
    sharedArrayBufferAvailable: true,
    wasmSimdSupported: true,
    opfsSupported: true,
    opfsSyncAccessHandleSupported: true,
    storageQuotaBytes: 4_000_000_000,
    storageUsageBytes: 128_000_000,
    audioWorkletSupported: true,
    webGpuSupported: false,
  });
  assert.equal(winChrome.os, 'windows');
  assert.equal(winChrome.arch, 'x86_64');
  assert.equal(winChrome.browser, 'chrome');
  assert.equal(winChrome.wasmThreadsSupported, true);
  assert.equal(winChrome.deviceAgnostic, true);

  const macSafariArm = probeCrossPlatformCapabilities({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
    platform: 'MacIntel',
    architectureHint: 'arm64',
    hardwareConcurrency: 8,
    deviceMemoryGb: null, // Safari omits navigator.deviceMemory
    crossOriginIsolated: false,
    sharedArrayBufferAvailable: false,
    wasmSimdSupported: true,
    opfsSupported: true,
    opfsSyncAccessHandleSupported: true,
    audioWorkletSupported: true,
    webGpuSupported: false,
  });
  assert.equal(macSafariArm.os, 'macos');
  assert.equal(macSafariArm.arch, 'arm64');
  assert.equal(macSafariArm.browser, 'safari');
  assert.equal(macSafariArm.deviceMemoryGb, 'UNKNOWN');
  assert.equal(macSafariArm.wasmThreadsSupported, false);

  const linuxFirefox = probeCrossPlatformCapabilities({
    userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    platform: 'Linux x86_64',
    architectureHint: 'x86_64',
    hardwareConcurrency: 16,
    deviceMemoryGb: 32,
    crossOriginIsolated: true,
    sharedArrayBufferAvailable: true,
    wasmSimdSupported: true,
    opfsSupported: true,
    opfsSyncAccessHandleSupported: true,
    audioWorkletSupported: true,
    webGpuSupported: false,
  });
  assert.equal(linuxFirefox.os, 'linux');
  assert.equal(linuxFirefox.arch, 'x86_64');
  assert.equal(linuxFirefox.browser, 'firefox');

  const winEdge = probeCrossPlatformCapabilities({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    platform: 'Win32',
    hardwareConcurrency: 4,
    deviceMemoryGb: 8,
    crossOriginIsolated: true,
    sharedArrayBufferAvailable: true,
    wasmSimdSupported: true,
    opfsSupported: true,
    opfsSyncAccessHandleSupported: true,
  });
  assert.equal(winEdge.browser, 'edge');
});

test('resolveResourceTierProfile maps 4-8GB, 8-16GB, 16-32GB, >32GB, and UNKNOWN cleanly with zero Cloud fallback', () => {
  const mkCaps = (ram: number | null, cores: number | null, coi = true) =>
    probeCrossPlatformCapabilities({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0',
      hardwareConcurrency: cores,
      deviceMemoryGb: ram,
      crossOriginIsolated: coi,
      sharedArrayBufferAvailable: coi,
    });

  const t0 = resolveResourceTierProfile(mkCaps(8, 4));
  assert.equal(t0.tier, 'TIER-0');
  assert.equal(t0.tierClass, 'LOW_RESOURCE');
  assert.equal(t0.allowCloudFallback, false);

  const t1 = resolveResourceTierProfile(mkCaps(16, 8));
  assert.equal(t1.tier, 'TIER-1');
  assert.equal(t1.tierClass, 'MAINSTREAM');
  assert.equal(t1.allowCloudFallback, false);

  const t2 = resolveResourceTierProfile(mkCaps(32, 12));
  assert.equal(t2.tier, 'TIER-2');
  assert.equal(t2.tierClass, 'PERFORMANCE');
  assert.equal(t2.allowCloudFallback, false);

  const t3 = resolveResourceTierProfile(mkCaps(64, 16));
  assert.equal(t3.tier, 'TIER-3');
  assert.equal(t3.tierClass, 'WORKSTATION');
  assert.equal(t3.allowCloudFallback, false);

  // Unknown RAM + 4 cores -> conservative TIER-0
  const unknownLow = resolveResourceTierProfile(mkCaps(null, 4, false));
  assert.equal(unknownLow.tier, 'TIER-0');
  assert.equal(unknownLow.maxWasmWorkerThreads, 1);
  assert.equal(unknownLow.allowCloudFallback, false);
});

test('buildGracefulDegradationPlan enforces 6-step degradation under pressure and never falls back to Cloud ASR', () => {
  const profile = resolveResourceTierProfile(
    probeCrossPlatformCapabilities({
      hardwareConcurrency: 12,
      deviceMemoryGb: 32,
      crossOriginIsolated: true,
      sharedArrayBufferAvailable: true,
    }),
  );

  const normal = buildGracefulDegradationPlan({ profile, pressureLevel: 'normal' });
  assert.equal(normal.activeSteps.length, 0);
  assert.equal(normal.allowCloudFallback, false);

  const throttle = buildGracefulDegradationPlan({ profile, pressureLevel: 'throttle' });
  assert.ok(throttle.activeSteps.includes('REDUCE_BLOCK_CACHE_SIZE'));
  assert.ok(throttle.activeSteps.includes('REDUCE_WORKER_THREADS'));
  assert.ok(throttle.activeSteps.includes('SERIALIZE_HEAVY_TASKS'));
  assert.ok(throttle.activeSteps.includes('DISABLE_NON_ESSENTIAL_PREFETCH'));
  assert.equal(throttle.effectiveMaxConcurrentHeavyTasks, 1);
  assert.equal(throttle.prefetchEnabled, false);
  assert.equal(throttle.allowCloudFallback, false);

  const emergencyOver = buildGracefulDegradationPlan({
    profile,
    pressureLevel: 'emergency',
    overHardLimit: true,
  });
  assert.ok(emergencyOver.activeSteps.includes('USE_SMALLER_CHUNK_WINDOWS'));
  assert.ok(emergencyOver.activeSteps.includes('REJECT_OVER_BUDGET_WITH_USER_MESSAGE'));
  assert.equal(emergencyOver.effectiveWorkerThreads, 1);
  assert.equal(emergencyOver.allowCloudFallback, false);
  assert.ok(emergencyOver.userFacingGuidanceFa && emergencyOver.userFacingGuidanceFa.length > 10);
});
