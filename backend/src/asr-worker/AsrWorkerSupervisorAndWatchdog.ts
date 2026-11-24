/**
 * @file backend/src/asr-worker/AsrWorkerSupervisorAndWatchdog.ts
 * @description Section 139: Isolated Backend ASR Worker Supervisor & Watchdog.
 *              Enforces execution timeout, liveness heartbeat, and RSS memory ceiling
 *              so a hung or leaky inference job is aborted cleanly without crashing the server.
 */

export interface WatchdogPolicy {
  readonly maxExecutionTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxWorkerRssMb: number;
}

export class AsrWorkerSupervisorAndWatchdog {
  constructor(private readonly policy: WatchdogPolicy) {}

  /**
   * Executes a heavy ASR inference job under strict Timeout, Heartbeat, and RSS memory supervision.
   * P1 #7: Invokes `onForceTerminateWorker` immediately when a threshold trips so isolated
   * `node:worker_threads` or child processes executing synchronous C++/ONNX kernels are forcefully terminated.
   */
  public async runSupervisedInferenceJob<TResult>(params: {
    jobId: string;
    executeFn: (ctx: {
      abortSignal: AbortSignal;
      emitHeartbeat: (progressPct: number) => void;
    }) => Promise<TResult>;
    readCurrentRssMbFn?: () => number;
    onForceTerminateWorker?: (
      reason: 'TIMEOUT' | 'HEARTBEAT_LOST' | 'MEMORY_LIMIT',
    ) => Promise<void> | void;
  }): Promise<TResult> {
    const abortController = new AbortController();
    let lastHeartbeatAtMs = Date.now();
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    const startTimeMs = Date.now();

    const getRssMb =
      params.readCurrentRssMbFn ??
      (() => process.memoryUsage().rss / (1024 * 1024));

    const watchdogPromise = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setInterval(() => {
        const now = Date.now();
        const elapsedTotal = now - startTimeMs;
        const sinceLastHeartbeat = now - lastHeartbeatAtMs;
        const currentRssMb = getRssMb();

        if (elapsedTotal > this.policy.maxExecutionTimeoutMs) {
          if (watchdogTimer) clearInterval(watchdogTimer);
          abortController.abort();
          void Promise.resolve(params.onForceTerminateWorker?.('TIMEOUT')).catch(() => {});
          reject(
            new Error(
              `WATCHDOG_JOB_TIMEOUT: کار ${params.jobId} بیش از سقف ${this.policy.maxExecutionTimeoutMs}ms طول کشید.`,
            ),
          );
          return;
        }

        if (sinceLastHeartbeat > this.policy.heartbeatIntervalMs) {
          if (watchdogTimer) clearInterval(watchdogTimer);
          abortController.abort();
          void Promise.resolve(params.onForceTerminateWorker?.('HEARTBEAT_LOST')).catch(
            () => {},
          );
          reject(
            new Error(
              `WATCHDOG_HEARTBEAT_LOST: کارگر استنتاج ${params.jobId} پاسخگو نیست (Heartbeat Timeout).`,
            ),
          );
          return;
        }

        if (currentRssMb > this.policy.maxWorkerRssMb) {
          if (watchdogTimer) clearInterval(watchdogTimer);
          abortController.abort();
          void Promise.resolve(params.onForceTerminateWorker?.('MEMORY_LIMIT')).catch(
            () => {},
          );
          reject(
            new Error(
              `WATCHDOG_MEMORY_LIMIT_EXCEEDED: مصرف حافظه (${currentRssMb.toFixed(1)}MB) از سقف ${this.policy.maxWorkerRssMb}MB عبور کرد.`,
            ),
          );
        }
      }, Math.min(250, Math.max(10, Math.floor(this.policy.heartbeatIntervalMs / 2))));
      watchdogTimer.unref?.();
    });

    try {
      const workPromise = params.executeFn({
        abortSignal: abortController.signal,
        emitHeartbeat: () => {
          lastHeartbeatAtMs = Date.now();
        },
      });
      // Prevent unhandled rejection crash if watchdog rejects before workPromise throws AbortError
      workPromise.catch(() => {});

      return await Promise.race([workPromise, watchdogPromise]);
    } finally {
      if (watchdogTimer) clearInterval(watchdogTimer);
    }
  }
}
