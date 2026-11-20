/**
 * Avapardaz Phase-01 Cross-Platform Capability Prober & Resource Policy (AVP-P01-007)
 *
 * Device-agnostic, non-hardware-locked runtime policy supporting:
 * - OS: Windows, macOS, Linux, Unknown
 * - Arch: x86_64, ARM64, Unknown
 * - Browsers: Chrome, Edge, Firefox, Safari, Unknown
 * - 4 Resource Tiers: TIER-0 (4-8GB), TIER-1 (>8-16GB), TIER-2 (>16-32GB), TIER-3 (>32GB)
 * - 6-step graceful degradation (NEVER falls back to Cloud ASR).
 */

export type RuntimeOsFamily = 'windows' | 'macos' | 'linux' | 'unknown';
export type RuntimeCpuArch = 'x86_64' | 'arm64' | 'unknown';
export type RuntimeBrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'node' | 'unknown';

export type ResourceTierId = 'TIER-0' | 'TIER-1' | 'TIER-2' | 'TIER-3';
export type ResourceTierClass = 'LOW_RESOURCE' | 'MAINSTREAM' | 'PERFORMANCE' | 'WORKSTATION';

export interface CrossPlatformCapabilityProbeInput {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly architectureHint?: string;
  readonly hardwareConcurrency?: number | null;
  readonly deviceMemoryGb?: number | null;
  readonly crossOriginIsolated?: boolean | null;
  readonly sharedArrayBufferAvailable?: boolean;
  readonly wasmSimdSupported?: boolean | null;
  readonly opfsSupported?: boolean | null;
  readonly opfsSyncAccessHandleSupported?: boolean | null;
  readonly storageQuotaBytes?: number | null;
  readonly storageUsageBytes?: number | null;
  readonly audioWorkletSupported?: boolean | null;
  readonly webGpuSupported?: boolean | null;
}

export interface CrossPlatformCapabilities {
  readonly os: RuntimeOsFamily;
  readonly arch: RuntimeCpuArch;
  readonly browser: RuntimeBrowserFamily;
  readonly cpuCores: number | 'UNKNOWN';
  readonly deviceMemoryGb: number | 'UNKNOWN';
  readonly crossOriginIsolated: boolean | 'UNKNOWN';
  readonly sharedArrayBufferAvailable: boolean;
  readonly wasmThreadsSupported: boolean;
  readonly wasmSimdSupported: boolean | 'UNKNOWN';
  readonly opfsSupported: boolean | 'UNKNOWN';
  readonly opfsSyncAccessHandleSupported: boolean | 'UNKNOWN';
  readonly storageQuotaBytes: number | 'UNKNOWN';
  readonly storageUsageBytes: number | 'UNKNOWN';
  readonly audioWorkletSupported: boolean | 'UNKNOWN';
  readonly webGpuSupported: boolean | 'UNKNOWN';
  /** Explicitly true: policy never assumes Apple M2 or any specific vendor CPU. */
  readonly deviceAgnostic: true;
}

export interface ResourceTierProfile {
  readonly tier: ResourceTierId;
  readonly tierClass: ResourceTierClass;
  readonly ramRangeLabel: string;
  readonly maxChunkSeconds: number;
  readonly maxCacheBytes: number;
  readonly maxWasmWorkerThreads: number;
  readonly maxConcurrentHeavyTasks: number;
  readonly enablePrefetch: boolean;
  readonly recommendedModelProfile: 'int8-compact' | 'int8-balanced' | 'int8-or-fp16-accurate' | 'full-accuracy';
  readonly allowCloudFallback: false;
}

export type GracefulDegradationStep =
  | 'REDUCE_BLOCK_CACHE_SIZE'
  | 'REDUCE_WORKER_THREADS'
  | 'SERIALIZE_HEAVY_TASKS'
  | 'DISABLE_NON_ESSENTIAL_PREFETCH'
  | 'USE_SMALLER_CHUNK_WINDOWS'
  | 'REJECT_OVER_BUDGET_WITH_USER_MESSAGE';

export interface GracefulDegradationPlan {
  readonly pressureLevel: 'normal' | 'elevated' | 'throttle' | 'emergency';
  readonly tier: ResourceTierId;
  readonly effectiveCacheBytes: number;
  readonly effectiveWorkerThreads: number;
  readonly effectiveMaxConcurrentHeavyTasks: number;
  readonly effectiveChunkSeconds: number;
  readonly prefetchEnabled: boolean;
  readonly activeSteps: readonly GracefulDegradationStep[];
  readonly allowCloudFallback: false;
  readonly userFacingGuidanceFa: string | null;
}

const MiB = 1024 * 1024;

/**
 * Minimal valid WebAssembly v128 SIMD module (validates true WASM SIMD support at runtime).
 */
const MINIMAL_WASM_SIMD_PROBE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // magic \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type: () -> v128
  0x03, 0x02, 0x01, 0x00, // func 0: type 0
  0x0a, 0x16, 0x01, 0x14, 0x00, // code section: 1 func body
  0xfd, 0x0c, // v128.const
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 zero bytes
  0x0b, // end
]);

export function probeWasmSimdSupport(): boolean | 'UNKNOWN' {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return 'UNKNOWN';
  }
  try {
    return WebAssembly.validate(MINIMAL_WASM_SIMD_PROBE_BYTES);
  } catch {
    return false;
  }
}

export function detectOsFamily(userAgent = '', platform = ''): RuntimeOsFamily {
  const combined = `${userAgent} ${platform}`.toLowerCase();
  if (/\bwin(dows|32|64|nt)\b/.test(combined)) return 'windows';
  if (/\b(mac os x|macintosh|macintel|darwin)\b/.test(combined)) return 'macos';
  if (/\b(linux|x11|ubuntu|debian|fedora)\b/.test(combined) && !/android/.test(combined)) return 'linux';
  return 'unknown';
}

export function detectCpuArch(userAgent = '', platform = '', archHint = ''): RuntimeCpuArch {
  const combined = `${archHint} ${platform} ${userAgent}`.toLowerCase();
  if (/\b(arm64|aarch64)\b/.test(combined)) return 'arm64';
  if (/\b(x86_64|x64|amd64|win64|wow64|x86-64)\b/.test(combined)) return 'x86_64';
  return 'unknown';
}

export function detectBrowserFamily(userAgent = ''): RuntimeBrowserFamily {
  const ua = userAgent.toLowerCase();
  if (!ua) {
    if (typeof process !== 'undefined' && Boolean(process.versions?.node)) {
      return 'node';
    }
    return 'unknown';
  }
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('firefox/')) return 'firefox';
  if (ua.includes('chrome/') || ua.includes('chromium/')) return 'chrome';
  if (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('chromium/')) return 'safari';
  return 'unknown';
}

/**
 * Probes host capabilities honestly without assuming vendor-specific hardware (never M2-locked).
 * Any unavailable API reports `'UNKNOWN'` instead of fabricated defaults.
 */
export function probeCrossPlatformCapabilities(
  input?: CrossPlatformCapabilityProbeInput,
): CrossPlatformCapabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua = input?.userAgent ?? nav?.userAgent ?? '';
  const platform =
    input?.platform ??
    nav?.platform ??
    (typeof process !== 'undefined' ? process.platform : '');
  const archHint =
    input?.architectureHint ??
    (typeof process !== 'undefined' ? process.arch : '');

  const rawCores =
    input && 'hardwareConcurrency' in input
      ? input.hardwareConcurrency
      : nav?.hardwareConcurrency ?? null;
  const cpuCores: number | 'UNKNOWN' =
    typeof rawCores === 'number' && Number.isFinite(rawCores) && rawCores >= 1
      ? Math.trunc(rawCores)
      : 'UNKNOWN';

  const navDeviceMemory = (nav as (Navigator & { deviceMemory?: unknown }) | undefined)?.deviceMemory;
  const rawMemoryGb =
    input && 'deviceMemoryGb' in input
      ? input.deviceMemoryGb
      : typeof navDeviceMemory === 'number'
        ? navDeviceMemory
        : null;
  const deviceMemoryGb: number | 'UNKNOWN' =
    typeof rawMemoryGb === 'number' && Number.isFinite(rawMemoryGb) && rawMemoryGb > 0
      ? rawMemoryGb
      : 'UNKNOWN';

  const rawCoi =
    input && 'crossOriginIsolated' in input
      ? input.crossOriginIsolated
      : typeof globalThis !== 'undefined' && 'crossOriginIsolated' in globalThis
        ? Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
        : null;
  const crossOriginIsolated: boolean | 'UNKNOWN' =
    typeof rawCoi === 'boolean' ? rawCoi : 'UNKNOWN';

  const sharedArrayBufferAvailable =
    input && 'sharedArrayBufferAvailable' in input
      ? Boolean(input.sharedArrayBufferAvailable)
      : typeof SharedArrayBuffer !== 'undefined';

  const wasmThreadsSupported =
    sharedArrayBufferAvailable && crossOriginIsolated === true;

  const wasmSimdSupported: boolean | 'UNKNOWN' =
    input && 'wasmSimdSupported' in input
      ? input.wasmSimdSupported === null || input.wasmSimdSupported === undefined
        ? 'UNKNOWN'
        : input.wasmSimdSupported
      : probeWasmSimdSupport();

  const opfsSupported: boolean | 'UNKNOWN' =
    input && 'opfsSupported' in input
      ? input.opfsSupported === null || input.opfsSupported === undefined
        ? 'UNKNOWN'
        : input.opfsSupported
      : nav
        ? Boolean(nav.storage && 'getDirectory' in nav.storage)
        : 'UNKNOWN';

  const opfsSyncAccessHandleSupported: boolean | 'UNKNOWN' =
    input && 'opfsSyncAccessHandleSupported' in input
      ? input.opfsSyncAccessHandleSupported === null || input.opfsSyncAccessHandleSupported === undefined
        ? 'UNKNOWN'
        : input.opfsSyncAccessHandleSupported
      : 'UNKNOWN';

  const storageQuotaBytes: number | 'UNKNOWN' =
    typeof input?.storageQuotaBytes === 'number' && Number.isFinite(input.storageQuotaBytes) && input.storageQuotaBytes >= 0
      ? Math.trunc(input.storageQuotaBytes)
      : 'UNKNOWN';

  const storageUsageBytes: number | 'UNKNOWN' =
    typeof input?.storageUsageBytes === 'number' && Number.isFinite(input.storageUsageBytes) && input.storageUsageBytes >= 0
      ? Math.trunc(input.storageUsageBytes)
      : 'UNKNOWN';

  const audioWorkletSupported: boolean | 'UNKNOWN' =
    input && 'audioWorkletSupported' in input
      ? input.audioWorkletSupported === null || input.audioWorkletSupported === undefined
        ? 'UNKNOWN'
        : input.audioWorkletSupported
      : typeof AudioWorkletNode !== 'undefined'
        ? true
        : typeof window !== 'undefined'
          ? false
          : 'UNKNOWN';

  const webGpuSupported: boolean | 'UNKNOWN' =
    input && 'webGpuSupported' in input
      ? input.webGpuSupported === null || input.webGpuSupported === undefined
        ? 'UNKNOWN'
        : input.webGpuSupported
      : nav
        ? 'gpu' in nav
        : 'UNKNOWN';

  return {
    os: detectOsFamily(ua, platform),
    arch: detectCpuArch(ua, platform, archHint),
    browser: detectBrowserFamily(ua),
    cpuCores,
    deviceMemoryGb,
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    wasmThreadsSupported,
    wasmSimdSupported,
    opfsSupported,
    opfsSyncAccessHandleSupported,
    storageQuotaBytes,
    storageUsageBytes,
    audioWorkletSupported,
    webGpuSupported,
    deviceAgnostic: true,
  };
}

/**
 * Classifies host capabilities into AVP-P01-007 Resource Tiers:
 * - TIER-0 (`LOW_RESOURCE`): <= 8 GB RAM (or unknown RAM with <= 4 cores -> conservative)
 * - TIER-1 (`MAINSTREAM`): > 8 GB to 16 GB RAM (or unknown RAM with > 4 cores)
 * - TIER-2 (`PERFORMANCE`): > 16 GB to 32 GB RAM
 * - TIER-3 (`WORKSTATION`): > 32 GB RAM
 */
export function resolveResourceTierProfile(capabilities: CrossPlatformCapabilities): ResourceTierProfile {
  const ram = capabilities.deviceMemoryGb;
  const cores = capabilities.cpuCores === 'UNKNOWN' ? 4 : capabilities.cpuCores;
  const maxThreadsCap = capabilities.wasmThreadsSupported ? Math.max(1, Math.min(cores - 1, 8)) : 1;

  if (ram === 'UNKNOWN') {
    if (cores <= 4) {
      return {
        tier: 'TIER-0',
        tierClass: 'LOW_RESOURCE',
        ramRangeLabel: 'UNKNOWN (conservative 4-8 GB fallback)',
        maxChunkSeconds: 2,
        maxCacheBytes: 16 * MiB,
        maxWasmWorkerThreads: Math.min(2, maxThreadsCap),
        maxConcurrentHeavyTasks: 1,
        enablePrefetch: false,
        recommendedModelProfile: 'int8-compact',
        allowCloudFallback: false,
      };
    }
    return {
      tier: 'TIER-1',
      tierClass: 'MAINSTREAM',
      ramRangeLabel: 'UNKNOWN (conservative mainstream profile)',
      maxChunkSeconds: 4,
      maxCacheBytes: 24 * MiB,
      maxWasmWorkerThreads: Math.min(4, maxThreadsCap),
      maxConcurrentHeavyTasks: 1,
      enablePrefetch: true,
      recommendedModelProfile: 'int8-balanced',
      allowCloudFallback: false,
    };
  }

  if (ram <= 8) {
    return {
      tier: 'TIER-0',
      tierClass: 'LOW_RESOURCE',
      ramRangeLabel: '4-8 GB RAM',
      maxChunkSeconds: 2,
      maxCacheBytes: 16 * MiB,
      maxWasmWorkerThreads: Math.min(2, maxThreadsCap),
      maxConcurrentHeavyTasks: 1,
      enablePrefetch: false,
      recommendedModelProfile: 'int8-compact',
      allowCloudFallback: false,
    };
  }

  if (ram <= 16) {
    return {
      tier: 'TIER-1',
      tierClass: 'MAINSTREAM',
      ramRangeLabel: '8-16 GB RAM',
      maxChunkSeconds: 4,
      maxCacheBytes: 24 * MiB,
      maxWasmWorkerThreads: Math.min(4, maxThreadsCap),
      maxConcurrentHeavyTasks: 2,
      enablePrefetch: true,
      recommendedModelProfile: 'int8-balanced',
      allowCloudFallback: false,
    };
  }

  if (ram <= 32) {
    return {
      tier: 'TIER-2',
      tierClass: 'PERFORMANCE',
      ramRangeLabel: '16-32 GB RAM',
      maxChunkSeconds: 4,
      maxCacheBytes: 32 * MiB,
      maxWasmWorkerThreads: Math.min(6, maxThreadsCap),
      maxConcurrentHeavyTasks: 2,
      enablePrefetch: true,
      recommendedModelProfile: 'int8-or-fp16-accurate',
      allowCloudFallback: false,
    };
  }

  return {
    tier: 'TIER-3',
    tierClass: 'WORKSTATION',
    ramRangeLabel: '>32 GB RAM',
    maxChunkSeconds: 4,
    maxCacheBytes: 32 * MiB,
    maxWasmWorkerThreads: Math.min(8, maxThreadsCap),
    maxConcurrentHeavyTasks: 2,
    enablePrefetch: true,
    recommendedModelProfile: 'full-accuracy',
    allowCloudFallback: false,
  };
}

/**
 * Computes deterministic 6-step graceful degradation under memory pressure.
 * Strictly forbids Cloud ASR fallback at every degradation level.
 */
export function buildGracefulDegradationPlan(params: {
  readonly profile: ResourceTierProfile;
  readonly pressureLevel: 'normal' | 'elevated' | 'throttle' | 'emergency';
  readonly overHardLimit?: boolean;
}): GracefulDegradationPlan {
  const { profile, pressureLevel, overHardLimit = false } = params;
  const activeSteps: GracefulDegradationStep[] = [];

  let effectiveCacheBytes = profile.maxCacheBytes;
  let effectiveWorkerThreads = profile.maxWasmWorkerThreads;
  let effectiveMaxConcurrentHeavyTasks = profile.maxConcurrentHeavyTasks;
  let effectiveChunkSeconds = profile.maxChunkSeconds;
  let prefetchEnabled = profile.enablePrefetch;
  let userFacingGuidanceFa: string | null = null;

  if (pressureLevel === 'elevated') {
    activeSteps.push('REDUCE_BLOCK_CACHE_SIZE', 'DISABLE_NON_ESSENTIAL_PREFETCH');
    effectiveCacheBytes = Math.max(8 * MiB, Math.floor(profile.maxCacheBytes * 0.5));
    prefetchEnabled = false;
  } else if (pressureLevel === 'throttle') {
    activeSteps.push(
      'REDUCE_BLOCK_CACHE_SIZE',
      'REDUCE_WORKER_THREADS',
      'SERIALIZE_HEAVY_TASKS',
      'DISABLE_NON_ESSENTIAL_PREFETCH',
    );
    effectiveCacheBytes = Math.max(4 * MiB, Math.floor(profile.maxCacheBytes * 0.25));
    effectiveWorkerThreads = Math.max(1, Math.min(2, Math.floor(profile.maxWasmWorkerThreads / 2)));
    effectiveMaxConcurrentHeavyTasks = 1;
    prefetchEnabled = false;
    userFacingGuidanceFa =
      'حافظه در حالت کنترل فشار قرار دارد: پردازش‌های سنگین به‌صورت نوبتی و با کش محدود ادامه می‌یابند.';
  } else if (pressureLevel === 'emergency' || overHardLimit) {
    activeSteps.push(
      'REDUCE_BLOCK_CACHE_SIZE',
      'REDUCE_WORKER_THREADS',
      'SERIALIZE_HEAVY_TASKS',
      'DISABLE_NON_ESSENTIAL_PREFETCH',
      'USE_SMALLER_CHUNK_WINDOWS',
    );
    if (overHardLimit) {
      activeSteps.push('REJECT_OVER_BUDGET_WITH_USER_MESSAGE');
    }
    effectiveCacheBytes = 4 * MiB;
    effectiveWorkerThreads = 1;
    effectiveMaxConcurrentHeavyTasks = 1;
    effectiveChunkSeconds = Math.min(2, profile.maxChunkSeconds);
    prefetchEnabled = false;
    userFacingGuidanceFa = overHardLimit
      ? 'درخواست جدید از سقف حافظه ایمن ۱ گیگابایت عبور می‌کند و متوقف شد. داده‌های پروژه حفظ شده‌اند؛ پس از آزادسازی حافظه دوباره تلاش کنید.'
      : 'فشار اضطراری حافظه: کش موقت تخلیه شد و پنجره پردازش کوچک‌تر گردید تا پروژه بدون کرش ادامه یابد.';
  }

  return {
    pressureLevel,
    tier: profile.tier,
    effectiveCacheBytes,
    effectiveWorkerThreads,
    effectiveMaxConcurrentHeavyTasks,
    effectiveChunkSeconds,
    prefetchEnabled,
    activeSteps,
    allowCloudFallback: false,
    userFacingGuidanceFa,
  };
}
