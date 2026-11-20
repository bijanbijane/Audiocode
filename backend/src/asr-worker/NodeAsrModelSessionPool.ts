import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from '../../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';

export interface ModelPoolDescriptor {
  readonly modelKey: string; // e.g. "fastconformer-fa:1.2.0"
  readonly modelPathOrBytes: string | Uint8Array;
  readonly estimatedMemoryFootprintMb: number;
  readonly executionProviders: ('cuda' | 'cpu')[];
  readonly buildWarmupDummyFeeds?: () => Record<string, OrtTensorLike>;
}

interface PooledSessionRecord {
  readonly descriptor: ModelPoolDescriptor;
  readonly session: OrtSessionLike;
  activeLeases: number;
  lastUsedAtMs: number;
}

export class NodeAsrModelSessionPool {
  private readonly pool = new Map<string, PooledSessionRecord>();
  private readonly loadingPromises = new Map<string, Promise<PooledSessionRecord>>();
  private totalAllocatedMb = 0;
  private reservedLoadingMb = 0;

  constructor(
    private readonly ortProvider: OrtRuntimeProvider,
    private readonly maxMemoryBudgetMb: number = 4096
  ) {}

  /**
   * 1. Acquires a pre-warmed ONNX session with reference counting (preventing eviction while leased).
   */
  public async acquireSession(descriptor: ModelPoolDescriptor): Promise<{
    session: OrtSessionLike;
    release: () => void;
  }> {
    let record = this.pool.get(descriptor.modelKey);

    if (!record) {
      // Single-flight concurrent load coalescing
      let loading = this.loadingPromises.get(descriptor.modelKey);
      if (!loading) {
        const loadTask = this.loadAndWarmupModel(descriptor);
        loading = loadTask;
        this.loadingPromises.set(descriptor.modelKey, loadTask);
        void loadTask
          .finally(() => {
            if (this.loadingPromises.get(descriptor.modelKey) === loadTask) {
              this.loadingPromises.delete(descriptor.modelKey);
            }
          })
          .catch(() => {});
      }

      record = await loading;
    }

    record.activeLeases++;
    record.lastUsedAtMs = Date.now();

    let released = false;
    return {
      session: record.session,
      release: () => {
        if (released) return;
        released = true;
        record!.activeLeases = Math.max(0, record!.activeLeases - 1);
        record!.lastUsedAtMs = Date.now();
      },
    };
  }

  private async loadAndWarmupModel(
    descriptor: ModelPoolDescriptor
  ): Promise<PooledSessionRecord> {
    const footprintMb = Math.max(0, descriptor.estimatedMemoryFootprintMb);
    // Reserve memory synchronously BEFORE any await so concurrent loads cannot both pass the budget check
    this.reservedLoadingMb += footprintMb;
    let session: OrtSessionLike | null = null;
    try {
      await this.evictIdleSessionsIfNeeded(footprintMb);

      session = await this.ortProvider.createSession(
        descriptor.modelPathOrBytes,
        descriptor.executionProviders
      );

      // Execute Warm-Up pass before serving real traffic
      if (descriptor.buildWarmupDummyFeeds) {
        await session.run(descriptor.buildWarmupDummyFeeds());
      }

      const record: PooledSessionRecord = {
        descriptor,
        session,
        activeLeases: 0,
        lastUsedAtMs: Date.now(),
      };
      this.pool.set(descriptor.modelKey, record);
      this.totalAllocatedMb += footprintMb;
      return record;
    } catch (err) {
      if (session?.release) {
        await session.release().catch(() => {});
      }
      throw err;
    } finally {
      this.reservedLoadingMb = Math.max(0, this.reservedLoadingMb - footprintMb);
    }
  }

  /**
   * 2. Safely evicts idle sessions (activeLeases === 0) in LRU order to fit memory budget.
   *    Note: incomingMb is already included in this.reservedLoadingMb by loadAndWarmupModel.
   */
  private async evictIdleSessionsIfNeeded(incomingMb: number): Promise<void> {
    if (this.totalAllocatedMb + this.reservedLoadingMb <= this.maxMemoryBudgetMb) return;

    const idleCandidates = Array.from(this.pool.values())
      .filter((r) => r.activeLeases === 0)
      .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);

    const toRelease: PooledSessionRecord[] = [];
    for (const candidate of idleCandidates) {
      if (this.totalAllocatedMb + this.reservedLoadingMb <= this.maxMemoryBudgetMb) break;

      this.pool.delete(candidate.descriptor.modelKey);
      this.totalAllocatedMb = Math.max(
        0,
        this.totalAllocatedMb - candidate.descriptor.estimatedMemoryFootprintMb
      );
      toRelease.push(candidate);
    }

    for (const candidate of toRelease) {
      if (candidate.session.release) {
        await candidate.session.release();
      }
    }

    if (this.totalAllocatedMb + this.reservedLoadingMb > this.maxMemoryBudgetMb) {
      throw new Error(
        `SESSION_POOL_MEMORY_EXHAUSTED: فضای حافظه برای بارگذاری ${incomingMb}MB کافی نیست و تمام نشست‌های فعلی در حال کارند.`
      );
    }
  }

  public getPoolStats(): {
    loadedModelsCount: number;
    totalAllocatedMb: number;
    activeTotalLeases: number;
  } {
    let activeTotalLeases = 0;
    for (const r of this.pool.values()) activeTotalLeases += r.activeLeases;
    return {
      loadedModelsCount: this.pool.size,
      totalAllocatedMb: this.totalAllocatedMb,
      activeTotalLeases,
    };
  }
}
