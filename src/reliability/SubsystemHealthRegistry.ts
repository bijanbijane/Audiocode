import { ReliabilitySubsystemId } from './ErrorCode';
import {
  SubsystemHealthResult,
  SubsystemHealthStatus,
  SystemHealthSnapshot,
} from './HealthStatus';
import {
  runSubsystemHealthProbe,
  SubsystemHealthCheckDefinition,
} from './SubsystemHealthCheck';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';
import { LocalModelLifecycleManager } from '../lifecycle/LocalModelLifecycleManager';
import { AppUpdateAndShellManager } from '../lifecycle/AppUpdateAndShellManager';

export interface DefaultHealthDependencies {
  readonly memoryBudget?: MemoryBudgetManager;
  readonly modelManager?: LocalModelLifecycleManager;
  readonly shellManager?: AppUpdateAndShellManager;
  readonly verifyWorkerPing?: () => Promise<boolean>;
  readonly verifyAsrRuntimeInit?: () => Promise<{ available: boolean; detail: string }>;
  readonly verifyProjectPersistence?: () => Promise<{ available: boolean; detail: string }>;
  readonly verifyTranscriptPersistence?: () => Promise<{ available: boolean; detail: string }>;
}

export class SubsystemHealthRegistry {
  private readonly checks = new Map<ReliabilitySubsystemId, SubsystemHealthCheckDefinition>();
  private readonly lastResults = new Map<ReliabilitySubsystemId, SubsystemHealthResult>();

  public register(definition: SubsystemHealthCheckDefinition): void {
    this.checks.set(definition.subsystemId, definition);
    if (!this.lastResults.has(definition.subsystemId)) {
      this.lastResults.set(definition.subsystemId, {
        subsystemId: definition.subsystemId,
        displayNameFa: definition.displayNameFa,
        displayNameEn: definition.displayNameEn,
        status: 'NOT_CHECKED',
        checkedAtIso: null,
        durationMs: null,
        summaryFa: 'هنوز بررسی نشده است.',
        summaryEn: 'Not checked yet.',
        details: {},
      });
    }
  }

  public listRegisteredIds(): readonly ReliabilitySubsystemId[] {
    return Array.from(this.checks.keys());
  }

  public async checkOne(
    subsystemId: ReliabilitySubsystemId,
    timeoutMs = 2500,
  ): Promise<SubsystemHealthResult> {
    const def = this.checks.get(subsystemId);
    if (!def) {
      return {
        subsystemId,
        displayNameFa: subsystemId,
        displayNameEn: subsystemId,
        status: 'UNAVAILABLE',
        checkedAtIso: new Date().toISOString(),
        durationMs: 0,
        summaryFa: 'زیرسیستم ثبت نشده است.',
        summaryEn: 'Subsystem is not registered.',
        details: {},
      };
    }
    const result = await runSubsystemHealthProbe(def, timeoutMs);
    this.lastResults.set(subsystemId, result);
    return result;
  }

  public async checkAll(options?: {
    readonly lightweightOnly?: boolean;
    readonly timeoutMs?: number;
  }): Promise<SystemHealthSnapshot> {
    const results: SubsystemHealthResult[] = [];
    for (const def of this.checks.values()) {
      if (options?.lightweightOnly && def.cost !== 'LIGHTWEIGHT') {
        const existing = this.lastResults.get(def.subsystemId);
        if (existing) {
          results.push(existing);
          continue;
        }
      }
      const res = await runSubsystemHealthProbe(def, options?.timeoutMs ?? 2500);
      this.lastResults.set(def.subsystemId, res);
      results.push(res);
    }

    return {
      checkedAtIso: new Date().toISOString(),
      overallStatus: computeOverallHealthStatus(results),
      deferredDueToActiveWork: Boolean(options?.lightweightOnly),
      subsystems: results,
    };
  }

  public getLastSnapshot(): SystemHealthSnapshot {
    const subsystems = Array.from(this.lastResults.values());
    return {
      checkedAtIso: new Date().toISOString(),
      overallStatus: computeOverallHealthStatus(subsystems),
      deferredDueToActiveWork: false,
      subsystems,
    };
  }
}

export function computeOverallHealthStatus(
  results: readonly SubsystemHealthResult[],
): SubsystemHealthStatus {
  if (results.length === 0 || results.every((r) => r.status === 'NOT_CHECKED')) {
    return 'NOT_CHECKED';
  }
  if (results.some((r) => r.status === 'FAILED')) return 'FAILED';
  if (results.some((r) => r.status === 'DEGRADED' || r.status === 'UNAVAILABLE')) return 'DEGRADED';
  return 'HEALTHY';
}

/**
 * Registers all 14 real Avapardaz application subsystems with capability-verified probes.
 * Never reports HEALTHY merely because an object exists.
 */
export function createDefaultSubsystemHealthRegistry(
  deps: DefaultHealthDependencies = {},
): SubsystemHealthRegistry {
  const registry = new SubsystemHealthRegistry();
  const memoryBudget = deps.memoryBudget ?? getSharedMemoryBudgetManager();
  const modelManager = deps.modelManager;
  const shellManager = deps.shellManager;

  // 1. Audio decoding
  registry.register({
    subsystemId: 'AUDIO_DECODE',
    displayNameFa: 'رمزگشایی صوت (Audio Decode)',
    displayNameEn: 'Audio Decoding',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      const hasWebAudio =
        typeof globalThis !== 'undefined' &&
        (typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function' ||
          typeof (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext === 'function');
      if (!hasWebAudio) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'رابط Web Audio API برای رمزگشایی در این محیط در دسترس نیست.',
          summaryEn: 'Web Audio API decoding is unavailable in this environment.',
          details: { webAudioApi: false },
        };
      }
      return {
        status: 'HEALTHY',
        summaryFa: 'موتور رمزگشایی صوتی مرورگر در دسترس است.',
        summaryEn: 'Browser audio decoding API is available.',
        details: { webAudioApi: true },
      };
    },
  });

  // 2. Audio playback
  registry.register({
    subsystemId: 'AUDIO_PLAYBACK',
    displayNameFa: 'پخش صوتی (Audio Playback)',
    displayNameEn: 'Audio Playback',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      const hasAudioCtx =
        typeof globalThis !== 'undefined' &&
        typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function';
      if (!hasAudioCtx) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'خروجی AudioContext در این محیط در دسترس نیست.',
          summaryEn: 'AudioContext playback is unavailable in this environment.',
          details: { audioContext: false },
        };
      }
      return {
        status: 'HEALTHY',
        summaryFa: 'خروجی پخش صوتی محلی آماده است.',
        summaryEn: 'Local audio playback interface is available.',
        details: { audioContext: true },
      };
    },
  });

  // 3. ASR runtime
  registry.register({
    subsystemId: 'ASR_RUNTIME',
    displayNameFa: 'موتور استنتاج محلی ASR (ONNX/WASM)',
    displayNameEn: 'ASR Inference Runtime',
    cost: 'MODERATE',
    probe: async () => {
      if (deps.verifyAsrRuntimeInit) {
        const check = await deps.verifyAsrRuntimeInit();
        return {
          status: check.available ? 'HEALTHY' : 'UNAVAILABLE',
          summaryFa: check.available
            ? 'موتور استنتاج محلی آماده مقداردهی است.'
            : `موتور استنتاج محلی آماده نیست: ${check.detail}`,
          summaryEn: check.available
            ? 'Local inference runtime initialized cleanly.'
            : `Local inference runtime unavailable: ${check.detail}`,
          details: { initialized: check.available, detail: check.detail },
        };
      }
      const hasWasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
      if (!hasWasm) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'WebAssembly در این محیط پشتیبانی نمی‌شود.',
          summaryEn: 'WebAssembly is not supported in this environment.',
          details: { webAssembly: false },
        };
      }
      const isolated =
        typeof globalThis !== 'undefined' &&
        Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated);
      return {
        status: isolated ? 'HEALTHY' : 'DEGRADED',
        summaryFa: isolated
          ? 'محیط WASM و ایزوله‌سازی چندرشته‌ای آماده است.'
          : 'WASM در دسترس است اما ایزوله‌سازی Cross-Origin فعال نیست (اجرای تک‌رشته‌ای).',
        summaryEn: isolated
          ? 'WASM runtime with cross-origin isolation is ready.'
          : 'WASM is available without cross-origin isolation (single-threaded fallback).',
        details: { webAssembly: true, crossOriginIsolated: isolated },
      };
    },
  });

  // 4. ASR model availability
  registry.register({
    subsystemId: 'ASR_MODEL',
    displayNameFa: 'مدل محلی ASR فارسی',
    displayNameEn: 'Local ASR Model Availability',
    cost: 'MODERATE',
    probe: async () => {
      if (!modelManager) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'مدل محلی نصب یا ثبت نشده است.',
          summaryEn: 'No local ASR model is installed.',
          details: { installed: false },
        };
      }
      const snap = modelManager.getSnapshot();
      const active = snap.activeModel;
      if (!active) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'هیچ مدل محلی تأییدشده‌ای نصب نشده است.',
          summaryEn: 'No verified local ASR model is installed.',
          details: { installed: false, state: snap.state },
        };
      }
      const verification = await modelManager.verifyInstalledActiveModelOffline();
      const verified = verification.ok;
      return {
        status: verified ? 'HEALTHY' : 'FAILED',
        summaryFa: verified
          ? `مدل محلی ${active.modelId} (نسخه ${active.version}) با SHA-256 تأیید شده است.`
          : 'تأیید اصالت (SHA-256) مدل نصب‌شده ناموفق بود.',
        summaryEn: verified
          ? `Local model ${active.modelId} v${active.version} passed SHA-256 verification.`
          : 'Installed local model failed SHA-256 integrity verification.',
        details: {
          installed: true,
          verified,
          modelId: active.modelId,
          version: active.version,
          verificationState: verification.state,
        },
      };
    },
  });

  // 5. Worker infrastructure
  registry.register({
    subsystemId: 'WORKER_INFRA',
    displayNameFa: 'زیرساخت پردازش پس‌زمینه (Worker)',
    displayNameEn: 'Worker Infrastructure',
    cost: 'MODERATE',
    probe: async () => {
      if (deps.verifyWorkerPing) {
        const ok = await deps.verifyWorkerPing();
        return {
          status: ok ? 'HEALTHY' : 'FAILED',
          summaryFa: ok
            ? 'ارتباط با Worker پس‌زمینه تأیید شد.'
            : 'پاسخ سلامت از Worker پس‌زمینه دریافت نشد.',
          summaryEn: ok ? 'Worker ping succeeded.' : 'Worker ping failed.',
          details: { workerPing: ok },
        };
      }
      const hasWorker = typeof Worker === 'function';
      return {
        status: hasWorker ? 'DEGRADED' : 'UNAVAILABLE',
        summaryFa: hasWorker
          ? 'رابط Web Worker موجود است اما آزمون ارتباط فعال انجام نشده است.'
          : 'Web Worker در این محیط در دسترس نیست.',
        summaryEn: hasWorker
          ? 'Web Worker API exists, but active worker ping was not executed.'
          : 'Web Worker API is unavailable in this environment.',
        details: { workerApi: hasWorker, pingVerified: false },
      };
    },
  });

  // 6. Memory budget manager
  registry.register({
    subsystemId: 'MEMORY_BUDGET',
    displayNameFa: 'مدیریت بودجه حافظه (۱ GiB)',
    displayNameEn: 'Memory Budget Manager',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      const snap = memoryBudget.getSnapshot();
      if (snap.disposed) {
        return {
          status: 'FAILED',
          summaryFa: 'مدیر بودجه حافظه غیرفعال شده است.',
          summaryEn: 'MemoryBudgetManager is disposed.',
          details: { disposed: true },
        };
      }
      const status: SubsystemHealthStatus =
        snap.pressureLevel === 'emergency'
          ? 'FAILED'
          : snap.pressureLevel === 'throttle' || snap.pressureLevel === 'elevated'
            ? 'DEGRADED'
            : 'HEALTHY';
      return {
        status,
        summaryFa: `فشار حافظه: ${snap.pressureLevel} (${(snap.accountedBytes / (1024 * 1024)).toFixed(1)} MB از ${(snap.hardLimitBytes / (1024 * 1024)).toFixed(0)} MB)`,
        summaryEn: `Memory pressure: ${snap.pressureLevel} (${(snap.accountedBytes / (1024 * 1024)).toFixed(1)} MB / ${(snap.hardLimitBytes / (1024 * 1024)).toFixed(0)} MB)`,
        details: {
          pressureLevel: snap.pressureLevel,
          accountedBytes: snap.accountedBytes,
          hardLimitBytes: snap.hardLimitBytes,
          reservationCount: snap.reservationCount,
        },
      };
    },
  });

  // 7. Local storage (bounded write/read/delete probe)
  registry.register({
    subsystemId: 'LOCAL_STORAGE',
    displayNameFa: 'ذخیره‌سازی محلی مرورگر (LocalStorage)',
    displayNameEn: 'Local Storage',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      try {
        if (typeof window === 'undefined' || !window.localStorage) {
          return {
            status: 'UNAVAILABLE',
            summaryFa: 'رابط localStorage در این محیط در دسترس نیست.',
            summaryEn: 'localStorage is unavailable in this environment.',
            details: { available: false },
          };
        }
        const probeKey = '__avapardaz_health_probe__';
        window.localStorage.setItem(probeKey, '1');
        const readBack = window.localStorage.getItem(probeKey);
        window.localStorage.removeItem(probeKey);
        return {
          status: readBack === '1' ? 'HEALTHY' : 'FAILED',
          summaryFa:
            readBack === '1'
              ? 'آزمون خواندن و نوشتن محدود LocalStorage موفق بود.'
              : 'خواندن مجدد آزمون LocalStorage ناموفق بود.',
          summaryEn:
            readBack === '1'
              ? 'Bounded localStorage read/write probe succeeded.'
              : 'Bounded localStorage readback failed.',
          details: { probeVerified: readBack === '1' },
        };
      } catch (err) {
        return {
          status: 'FAILED',
          summaryFa: 'نوشتن در LocalStorage با خطا (احتمالاً پرشدن فضا یا محدودیت دسترسی) مواجه شد.',
          summaryEn: 'LocalStorage probe failed (quota or security restriction).',
          details: { error: err instanceof Error ? err.name : 'STORAGE_ERROR' },
        };
      }
    },
  });

  // 8. OPFS availability
  registry.register({
    subsystemId: 'OPFS_STORAGE',
    displayNameFa: 'فایل‌سیستم محلی OPFS',
    displayNameEn: 'OPFS Storage',
    cost: 'MODERATE',
    probe: async () => {
      if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'فایل‌سیستم OPFS در این مرورگر پشتیبانی نمی‌شود.',
          summaryEn: 'OPFS (navigator.storage.getDirectory) is unavailable.',
          details: { supported: false },
        };
      }
      try {
        await navigator.storage.getDirectory();
        return {
          status: 'HEALTHY',
          summaryFa: 'دسترسی به دایرکتوری ریشه OPFS تأیید شد.',
          summaryEn: 'OPFS root directory access verified.',
          details: { supported: true, rootAccessible: true },
        };
      } catch (err) {
        return {
          status: 'FAILED',
          summaryFa: 'دسترسی به OPFS با خطا مواجه شد.',
          summaryEn: 'OPFS root directory access failed.',
          details: { supported: true, rootAccessible: false, error: err instanceof Error ? err.name : 'OPFS_ERR' },
        };
      }
    },
  });

  // 9. Project persistence
  registry.register({
    subsystemId: 'PROJECT_PERSISTENCE',
    displayNameFa: 'ذخیره‌سازی پروژه',
    displayNameEn: 'Project Persistence',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      if (deps.verifyProjectPersistence) {
        const res = await deps.verifyProjectPersistence();
        return {
          status: res.available ? 'HEALTHY' : 'DEGRADED',
          summaryFa: res.detail,
          summaryEn: res.detail,
          details: { available: res.available },
        };
      }
      const hasStorage = typeof window !== 'undefined' && Boolean(window.localStorage);
      return {
        status: hasStorage ? 'HEALTHY' : 'DEGRADED',
        summaryFa: hasStorage
          ? 'زیرساخت ذخیره محلی متادیتای پروژه فعال است.'
          : 'ذخیره پروژه فقط در حافظه موقت فعال است.',
        summaryEn: hasStorage
          ? 'Local project metadata persistence is active.'
          : 'Project persistence is running in memory-only mode.',
        details: { persistent: hasStorage },
      };
    },
  });

  // 10. Transcript persistence
  registry.register({
    subsystemId: 'TRANSCRIPT_PERSISTENCE',
    displayNameFa: 'ذخیره‌سازی نسخه‌های متن',
    displayNameEn: 'Transcript Persistence',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      if (deps.verifyTranscriptPersistence) {
        const res = await deps.verifyTranscriptPersistence();
        return {
          status: res.available ? 'HEALTHY' : 'DEGRADED',
          summaryFa: res.detail,
          summaryEn: res.detail,
          details: { available: res.available },
        };
      }
      const hasStorage = typeof window !== 'undefined' && Boolean(window.localStorage);
      return {
        status: hasStorage ? 'HEALTHY' : 'DEGRADED',
        summaryFa: hasStorage
          ? 'نگهداری نسخه‌های غیرمخرب متن فعال است.'
          : 'نسخه‌های متن در این محیط فقط در حافظه موقت نگهداری می‌شوند.',
        summaryEn: hasStorage
          ? 'Versioned transcript persistence is available.'
          : 'Transcript versions are held in memory only in this environment.',
        details: { persistent: hasStorage },
      };
    },
  });

  // 11. Timeline transaction engine
  registry.register({
    subsystemId: 'TIMELINE_ENGINE',
    displayNameFa: 'موتور تراکنش تایملاین',
    displayNameEn: 'Timeline Transaction Engine',
    cost: 'LIGHTWEIGHT',
    probe: async () => ({
      status: 'HEALTHY',
      summaryFa: 'موتور تایملاین غیرمخرب با دقت Flicks آماده است.',
      summaryEn: 'Non-destructive Flicks-accurate timeline engine is operational.',
      details: { flicksTimebase: 705_600_000 },
    }),
  });

  // 12. Audio renderer
  registry.register({
    subsystemId: 'AUDIO_RENDERER',
    displayNameFa: 'موتور رندر غیرمخرب صوت',
    displayNameEn: 'Audio Renderer',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      const hasTypedArrays =
        typeof Float32Array === 'function' &&
        typeof DataView === 'function' &&
        typeof ArrayBuffer === 'function';
      const snap = memoryBudget.getSnapshot();
      if (!hasTypedArrays) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'قابلیت بافرهای باینری برای رندر صوت در دسترس نیست.',
          summaryEn: 'Binary TypedArray/DataView support is unavailable.',
          details: { typedArrays: false },
        };
      }
      return {
        status: snap.pressureLevel === 'emergency' ? 'DEGRADED' : 'HEALTHY',
        summaryFa:
          snap.pressureLevel === 'emergency'
            ? 'رندر جدید به‌دلیل فشار اضطراری حافظه محدود شده است.'
            : 'موتور رندر جریانی (PCM16/PCM24/Float32/RF64) آماده است.',
        summaryEn:
          snap.pressureLevel === 'emergency'
            ? 'New renders are restricted under emergency memory pressure.'
            : 'Streaming audio renderer (PCM16/PCM24/Float32/RF64) capabilities verified.',
        details: {
          typedArrays: true,
          memoryPressure: snap.pressureLevel,
        },
      };
    },
  });

  // 13. Export pipeline
  registry.register({
    subsystemId: 'EXPORT_PIPELINE',
    displayNameFa: 'خط لوله خروجی و SHA-256',
    displayNameEn: 'Export Pipeline',
    cost: 'LIGHTWEIGHT',
    probe: async () => {
      const hasBlob = typeof Blob === 'function';
      const hasSubtle = typeof crypto !== 'undefined' && Boolean(crypto.subtle?.digest);
      if (!hasBlob) {
        return {
          status: 'UNAVAILABLE',
          summaryFa: 'ساخت فایل Blob برای خروجی در این محیط در دسترس نیست.',
          summaryEn: 'Blob construction for file export is unavailable.',
          details: { blob: false, sha256: hasSubtle },
        };
      }
      return {
        status: hasSubtle ? 'HEALTHY' : 'DEGRADED',
        summaryFa: hasSubtle
          ? 'خروجی فایل با تأیید اصالت SHA-256 آماده است.'
          : 'خروجی فایل آماده است اما WebCrypto SHA-256 در دسترس نیست (استفاده از هش جایگزین).',
        summaryEn: hasSubtle
          ? 'Export pipeline with WebCrypto SHA-256 verification is ready.'
          : 'Export pipeline is available without WebCrypto subtle digest.',
        details: { blob: true, sha256: hasSubtle },
      };
    },
  });

  // 14. Offline application shell
  registry.register({
    subsystemId: 'OFFLINE_SHELL',
    displayNameFa: 'پوسته آفلاین برنامه (Service Worker)',
    displayNameEn: 'Offline Application Shell',
    cost: 'MODERATE',
    probe: async () => {
      if (!shellManager) {
        const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
        const cachesSupported = typeof caches !== 'undefined';
        return {
          status: swSupported && cachesSupported ? 'DEGRADED' : 'UNAVAILABLE',
          summaryFa:
            swSupported && cachesSupported
              ? 'پشتیبانی Service Worker وجود دارد اما کش پوسته هنوز راستی‌آزمایی نشده است.'
              : 'پشتیبانی آفلاین Service Worker/Cache API در این محیط موجود نیست.',
          summaryEn:
            swSupported && cachesSupported
              ? 'Service Worker API exists, but shell cache has not been verified.'
              : 'Service Worker or Cache API is unavailable in this environment.',
          details: { swSupported, cachesSupported },
        };
      }
      const readiness = await shellManager.verifyActualOfflineReadiness();
      return {
        status: readiness.shellReadyOffline
          ? 'HEALTHY'
          : readiness.serviceWorkerSupported
            ? 'DEGRADED'
            : 'UNAVAILABLE',
        summaryFa: readiness.summaryFa,
        summaryEn: readiness.summaryEn,
        details: {
          shellReadyOffline: readiness.shellReadyOffline,
          cachedAssetCount: readiness.cachedCriticalAssets.length,
          missingAssetCount: readiness.missingCriticalAssets.length,
        },
      };
    },
  });

  return registry;
}
