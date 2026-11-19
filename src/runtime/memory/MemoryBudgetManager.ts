import {
  AVAPARDAZ_MEMORY_POLICY,
  MemoryPolicyConfig,
  validateMemoryPolicy,
} from './MemoryPolicy';

export type MemoryCategory =
  | 'decoded-audio'
  | 'asr-input-windows'
  | 'asr-feature-buffers'
  | 'model-runtime'
  | 'render-export-buffers'
  | 'audio-cache'
  | 'other';

export type MemoryReservationPriority = 'protected' | 'normal' | 'optional';

export type MemoryPressureLevel = 'normal' | 'elevated' | 'throttle' | 'emergency';

export interface MemoryReservationRequest {
  readonly owner: string;
  readonly category: MemoryCategory;
  readonly bytes: number;
  readonly priority?: MemoryReservationPriority;
  /** True for active user audio, transcripts, approved edits, or in-progress transactions. */
  readonly protectedUserData?: boolean;
}

export interface MemoryReservation {
  readonly id: string;
  readonly owner: string;
  readonly category: MemoryCategory;
  readonly bytes: number;
  readonly createdAt: number;
  readonly priority: MemoryReservationPriority;
  readonly protectedUserData: boolean;
}

export interface BrowserJsHeapMeasurement {
  readonly available: boolean;
  readonly usedJSHeapSizeBytes: number | null;
  readonly totalJSHeapSizeBytes: number | null;
  readonly jsHeapSizeLimitBytes: number | null;
  readonly scopeNote: string;
}

export interface MemoryBudgetSnapshot {
  readonly accountedBytes: number;
  readonly reservationCount: number;
  readonly highWaterMarkBytes: number;
  readonly hardLimitBytes: number;
  readonly targetBytes: number;
  readonly throttleBytes: number;
  readonly emergencyBytes: number;
  readonly availableBytes: number;
  readonly pressureLevel: MemoryPressureLevel;
  readonly throttled: boolean;
  readonly allowOptionalPrefetch: boolean;
  readonly recommendedMaxConcurrentHeavyTasks: number;
  readonly evictionTriggerCount: number;
  readonly disposed: boolean;
  readonly byCategory: Readonly<Record<MemoryCategory, number>>;
  readonly browserJsHeap: BrowserJsHeapMeasurement;
}

export interface HeavyTaskAdmissionResult {
  readonly allowed: boolean;
  readonly pressureLevel: MemoryPressureLevel;
  readonly throttled: boolean;
  readonly allowOptionalPrefetch: boolean;
  readonly recommendedMaxConcurrentHeavyTasks: number;
  readonly reason?: string;
}

export interface CacheEvictionContext {
  readonly pressureLevel: MemoryPressureLevel;
  readonly accountedBytes: number;
  readonly targetFreeBytes: number;
}

export type CacheEvictionCallback = (context: CacheEvictionContext) => void;

export class InvalidMemoryReservationError extends RangeError {
  public readonly code = 'INVALID_MEMORY_RESERVATION';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMemoryReservationError';
  }
}

export class MemoryPressureError extends Error {
  public readonly code = 'MEMORY_PRESSURE_LIMIT';
  public readonly requestedBytes: number;
  public readonly accountedBytes: number;
  public readonly availableBytes: number;
  public readonly hardLimitBytes: number;
  public readonly pressureLevel: MemoryPressureLevel;

  constructor(params: {
    message: string;
    requestedBytes: number;
    accountedBytes: number;
    hardLimitBytes: number;
    pressureLevel: MemoryPressureLevel;
  }) {
    super(params.message);
    this.name = 'MemoryPressureError';
    this.requestedBytes = params.requestedBytes;
    this.accountedBytes = params.accountedBytes;
    this.hardLimitBytes = params.hardLimitBytes;
    this.availableBytes = Math.max(0, params.hardLimitBytes - params.accountedBytes);
    this.pressureLevel = params.pressureLevel;
  }
}

const ALL_CATEGORIES: readonly MemoryCategory[] = [
  'decoded-audio',
  'asr-input-windows',
  'asr-feature-buffers',
  'model-runtime',
  'render-export-buffers',
  'audio-cache',
  'other',
];

function createEmptyCategoryMap(): Record<MemoryCategory, number> {
  return {
    'decoded-audio': 0,
    'asr-input-windows': 0,
    'asr-feature-buffers': 0,
    'model-runtime': 0,
    'render-export-buffers': 0,
    'audio-cache': 0,
    other: 0,
  };
}

function readBrowserJsHeapMeasurement(): BrowserJsHeapMeasurement {
  const perf =
    typeof performance !== 'undefined'
      ? (performance as unknown as {
          memory?: {
            usedJSHeapSize?: unknown;
            totalJSHeapSize?: unknown;
            jsHeapSizeLimit?: unknown;
          };
        })
      : undefined;

  const mem = perf?.memory;
  if (
    mem &&
    typeof mem.usedJSHeapSize === 'number' &&
    Number.isFinite(mem.usedJSHeapSize) &&
    typeof mem.totalJSHeapSize === 'number' &&
    Number.isFinite(mem.totalJSHeapSize) &&
    typeof mem.jsHeapSizeLimit === 'number' &&
    Number.isFinite(mem.jsHeapSizeLimit)
  ) {
    return {
      available: true,
      usedJSHeapSizeBytes: Math.trunc(mem.usedJSHeapSize),
      totalJSHeapSizeBytes: Math.trunc(mem.totalJSHeapSize),
      jsHeapSizeLimitBytes: Math.trunc(mem.jsHeapSizeLimit),
      scopeNote:
        'Main-thread JS heap only; excludes Workers, WebAssembly, GPU, decoded media, and browser-internal buffers.',
    };
  }

  return {
    available: false,
    usedJSHeapSizeBytes: null,
    totalJSHeapSizeBytes: null,
    jsHeapSizeLimitBytes: null,
    scopeNote:
      'Browser JS heap telemetry (performance.memory) is unavailable in this environment.',
  };
}

/**
 * Application-managed memory reservation and pressure-control coordinator.
 * All admission decisions use exact integer byte arithmetic.
 */
export class MemoryBudgetManager {
  public readonly policy: MemoryPolicyConfig;

  private readonly reservations = new Map<string, MemoryReservation>();
  private readonly evictionCallbacks = new Set<CacheEvictionCallback>();
  private readonly categoryTotals: Record<MemoryCategory, number> = createEmptyCategoryMap();

  private accountedBytes = 0;
  private highWaterMarkBytes = 0;
  private seq = 0;
  private evictionTriggerCount = 0;
  private isRunningEvictionCallbacks = false;
  private disposed = false;

  constructor(policy: MemoryPolicyConfig = AVAPARDAZ_MEMORY_POLICY) {
    validateMemoryPolicy(policy);
    this.policy = { ...policy };
  }

  public getPressureLevel(bytes: number = this.accountedBytes): MemoryPressureLevel {
    if (bytes >= this.policy.emergencyBytes) return 'emergency';
    if (bytes >= this.policy.throttleBytes) return 'throttle';
    if (bytes >= this.policy.targetBytes) return 'elevated';
    return 'normal';
  }

  public registerCacheEvictionCallback(callback: CacheEvictionCallback): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.evictionCallbacks.add(callback);
    return () => {
      this.evictionCallbacks.delete(callback);
    };
  }

  public canStartHeavyTask(options?: {
    readonly estimatedBytes?: number;
    readonly optional?: boolean;
    readonly activeHeavyTasks?: number;
    readonly defaultMaxConcurrentHeavyTasks?: number;
  }): HeavyTaskAdmissionResult {
    const pressureLevel = this.getPressureLevel();
    const throttled = pressureLevel === 'throttle' || pressureLevel === 'emergency';
    const allowOptionalPrefetch = !throttled;
    const baseMaxConcurrent =
      typeof options?.defaultMaxConcurrentHeavyTasks === 'number' &&
      Number.isSafeInteger(options.defaultMaxConcurrentHeavyTasks) &&
      options.defaultMaxConcurrentHeavyTasks >= 1
        ? options.defaultMaxConcurrentHeavyTasks
        : 2;
    const recommendedMaxConcurrentHeavyTasks = throttled ? 1 : baseMaxConcurrent;

    if (this.disposed) {
      return {
        allowed: false,
        pressureLevel,
        throttled: true,
        allowOptionalPrefetch: false,
        recommendedMaxConcurrentHeavyTasks: 0,
        reason: 'MemoryBudgetManager has been disposed.',
      };
    }

    const estimatedBytes = options?.estimatedBytes ?? 0;
    if (
      typeof estimatedBytes !== 'number' ||
      !Number.isFinite(estimatedBytes) ||
      !Number.isSafeInteger(estimatedBytes) ||
      estimatedBytes < 0
    ) {
      return {
        allowed: false,
        pressureLevel,
        throttled,
        allowOptionalPrefetch,
        recommendedMaxConcurrentHeavyTasks,
        reason: 'Invalid estimatedBytes for heavy task admission.',
      };
    }

    if (pressureLevel === 'emergency' && options?.optional) {
      return {
        allowed: false,
        pressureLevel,
        throttled: true,
        allowOptionalPrefetch: false,
        recommendedMaxConcurrentHeavyTasks,
        reason: 'Optional memory-intensive work is blocked at emergency memory pressure.',
      };
    }

    if (
      typeof options?.activeHeavyTasks === 'number' &&
      options.activeHeavyTasks >= recommendedMaxConcurrentHeavyTasks
    ) {
      return {
        allowed: false,
        pressureLevel,
        throttled,
        allowOptionalPrefetch,
        recommendedMaxConcurrentHeavyTasks,
        reason: throttled
          ? 'Throttled memory state limits concurrent heavy processing to at most 1 task.'
          : 'Active heavy task count reached concurrency limit.',
      };
    }

    if (this.accountedBytes + estimatedBytes > this.policy.hardLimitBytes) {
      return {
        allowed: false,
        pressureLevel,
        throttled,
        allowOptionalPrefetch,
        recommendedMaxConcurrentHeavyTasks,
        reason: `Estimated ${estimatedBytes} B exceeds remaining application budget (${this.policy.hardLimitBytes - this.accountedBytes} B).`,
      };
    }

    return {
      allowed: true,
      pressureLevel,
      throttled,
      allowOptionalPrefetch,
      recommendedMaxConcurrentHeavyTasks,
    };
  }

  public reserve(request: MemoryReservationRequest): MemoryReservation {
    if (this.disposed) {
      throw new Error('MemoryBudgetManager has been disposed.');
    }

    if (!request || typeof request.owner !== 'string' || request.owner.trim().length === 0) {
      throw new InvalidMemoryReservationError('Reservation owner must be a non-empty string.');
    }

    if (!ALL_CATEGORIES.includes(request.category)) {
      throw new InvalidMemoryReservationError(`Unknown memory category: ${String(request.category)}`);
    }

    const bytes = request.bytes;
    if (
      typeof bytes !== 'number' ||
      !Number.isFinite(bytes) ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0
    ) {
      throw new InvalidMemoryReservationError(
        `Reservation bytes must be a positive safe integer, received ${String(bytes)}.`,
      );
    }

    const priority: MemoryReservationPriority =
      request.priority ?? (request.protectedUserData ? 'protected' : 'normal');
    const protectedUserData = Boolean(request.protectedUserData || priority === 'protected');

    const projected = this.accountedBytes + bytes;
    const currentPressure = this.getPressureLevel();
    const projectedPressure = this.getPressureLevel(projected);

    // At emergency pressure (current or projected) or if hard limit would be exceeded,
    // invoke non-destructive cache eviction callbacks first (never touching protected user data).
    if (
      projectedPressure === 'emergency' ||
      currentPressure === 'emergency' ||
      projected > this.policy.hardLimitBytes
    ) {
      const targetFreeBytes = Math.max(
        0,
        projected - this.policy.targetBytes,
      );
      this.invokeCacheEvictionCallbacks(
        projectedPressure === 'emergency' ? 'emergency' : currentPressure,
        targetFreeBytes,
      );
    }

    const postEvictionPressure = this.getPressureLevel();
    const postEvictionProjected = this.accountedBytes + bytes;

    if (priority === 'optional' && postEvictionPressure === 'emergency') {
      throw new MemoryPressureError({
        message: `Rejected optional memory reservation "${request.owner}" (${bytes} B) under emergency memory pressure (${this.accountedBytes} / ${this.policy.hardLimitBytes} B).`,
        requestedBytes: bytes,
        accountedBytes: this.accountedBytes,
        hardLimitBytes: this.policy.hardLimitBytes,
        pressureLevel: postEvictionPressure,
      });
    }

    if (
      !Number.isSafeInteger(postEvictionProjected) ||
      postEvictionProjected > this.policy.hardLimitBytes
    ) {
      throw new MemoryPressureError({
        message: `Memory reservation "${request.owner}" (${bytes} B) would exceed hard application limit (${this.accountedBytes} + ${bytes} > ${this.policy.hardLimitBytes} B).`,
        requestedBytes: bytes,
        accountedBytes: this.accountedBytes,
        hardLimitBytes: this.policy.hardLimitBytes,
        pressureLevel: postEvictionPressure,
      });
    }

    const reservation: MemoryReservation = {
      id: `mem-res-${++this.seq}`,
      owner: request.owner.trim(),
      category: request.category,
      bytes,
      createdAt: Date.now(),
      priority,
      protectedUserData,
    };

    this.reservations.set(reservation.id, reservation);
    this.accountedBytes += bytes;
    this.categoryTotals[reservation.category] += bytes;
    if (this.accountedBytes > this.highWaterMarkBytes) {
      this.highWaterMarkBytes = this.accountedBytes;
    }

    return reservation;
  }

  public release(reservationOrId: string | MemoryReservation | null | undefined): boolean {
    if (!reservationOrId) return false;
    const id = typeof reservationOrId === 'string' ? reservationOrId : reservationOrId.id;
    const existing = this.reservations.get(id);
    if (!existing) {
      return false;
    }

    this.reservations.delete(id);
    this.accountedBytes = Math.max(0, this.accountedBytes - existing.bytes);
    this.categoryTotals[existing.category] = Math.max(
      0,
      this.categoryTotals[existing.category] - existing.bytes,
    );
    return true;
  }

  public listActiveReservations(): readonly MemoryReservation[] {
    return Array.from(this.reservations.values());
  }

  public getSnapshot(): MemoryBudgetSnapshot {
    const pressureLevel = this.getPressureLevel();
    const throttled = pressureLevel === 'throttle' || pressureLevel === 'emergency';

    return {
      accountedBytes: this.accountedBytes,
      reservationCount: this.reservations.size,
      highWaterMarkBytes: this.highWaterMarkBytes,
      hardLimitBytes: this.policy.hardLimitBytes,
      targetBytes: this.policy.targetBytes,
      throttleBytes: this.policy.throttleBytes,
      emergencyBytes: this.policy.emergencyBytes,
      availableBytes: Math.max(0, this.policy.hardLimitBytes - this.accountedBytes),
      pressureLevel,
      throttled,
      allowOptionalPrefetch: !throttled && !this.disposed,
      recommendedMaxConcurrentHeavyTasks: this.disposed ? 0 : throttled ? 1 : 2,
      evictionTriggerCount: this.evictionTriggerCount,
      disposed: this.disposed,
      byCategory: { ...this.categoryTotals },
      browserJsHeap: readBrowserJsHeapMeasurement(),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reservations.clear();
    this.evictionCallbacks.clear();
    this.accountedBytes = 0;
    for (const key of ALL_CATEGORIES) {
      this.categoryTotals[key] = 0;
    }
  }

  private invokeCacheEvictionCallbacks(
    pressureLevel: MemoryPressureLevel,
    targetFreeBytes: number,
  ): void {
    if (this.isRunningEvictionCallbacks || this.evictionCallbacks.size === 0) return;
    this.isRunningEvictionCallbacks = true;
    this.evictionTriggerCount++;
    try {
      for (const cb of Array.from(this.evictionCallbacks)) {
        try {
          cb({
            pressureLevel,
            accountedBytes: this.accountedBytes,
            targetFreeBytes,
          });
        } catch {
          // A misbehaving cache listener must never break memory accounting or drop protected data.
        }
      }
    } finally {
      this.isRunningEvictionCallbacks = false;
    }
  }
}

let sharedBudgetManager: MemoryBudgetManager | null = null;

export function getSharedMemoryBudgetManager(): MemoryBudgetManager {
  if (!sharedBudgetManager || sharedBudgetManager.getSnapshot().disposed) {
    sharedBudgetManager = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  }
  return sharedBudgetManager;
}

export function resetSharedMemoryBudgetManagerForTests(): void {
  if (sharedBudgetManager) {
    sharedBudgetManager.dispose();
    sharedBudgetManager = null;
  }
}
