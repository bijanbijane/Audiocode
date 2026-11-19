import { SystemHealthSnapshot } from './HealthStatus';
import { SubsystemHealthRegistry } from './SubsystemHealthRegistry';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
} from '../runtime/memory/MemoryBudgetManager';

export interface HealthSchedulerOptions {
  readonly registry: SubsystemHealthRegistry;
  readonly memoryBudget?: MemoryBudgetManager;
  readonly isHeavyWorkActive: () => boolean;
}

/**
 * Coordinates lightweight health checks without competing with active ASR, rendering,
 * or elevated/emergency memory pressure.
 */
export class HealthCheckScheduler {
  private readonly registry: SubsystemHealthRegistry;
  private readonly memoryBudget: MemoryBudgetManager;
  private readonly isHeavyWorkActive: () => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: HealthSchedulerOptions) {
    this.registry = options.registry;
    this.memoryBudget = options.memoryBudget ?? getSharedMemoryBudgetManager();
    this.isHeavyWorkActive = options.isHeavyWorkActive;
  }

  public async runScheduledCheck(forceFull = false): Promise<SystemHealthSnapshot> {
    if (this.running) {
      return this.registry.getLastSnapshot();
    }
    const pressure = this.memoryBudget.getPressureLevel();
    const heavyActive = this.isHeavyWorkActive();

    if (!forceFull && (heavyActive || pressure === 'throttle' || pressure === 'emergency')) {
      return {
        ...this.registry.getLastSnapshot(),
        deferredDueToActiveWork: true,
      };
    }

    this.running = true;
    try {
      return await this.registry.checkAll({
        lightweightOnly: !forceFull && pressure === 'elevated',
      });
    } finally {
      this.running = false;
    }
  }

  public start(intervalMs = 60_000, onSnapshot?: (snapshot: SystemHealthSnapshot) => void): void {
    this.stop();
    const safeInterval = Math.max(5_000, intervalMs);
    this.timer = setInterval(() => {
      void this.runScheduledCheck(false).then((snap) => onSnapshot?.(snap));
    }, safeInterval);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
