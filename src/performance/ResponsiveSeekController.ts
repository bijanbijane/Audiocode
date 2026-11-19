/**
 * Responsive Seek & Playback Coalescing Controller (AVP-P11-001 Section 8)
 * - Cancels obsolete rapid seek requests via monotonic generation counter.
 * - Ensures playback never blocks on background ASR/rendering and never accumulates stale seek callbacks.
 * - Preserves exact sample-accurate seek coordinates without silently altering audio quality.
 */

export interface SeekRequestResult {
  readonly seekGeneration: number;
  readonly targetSample: number;
  readonly applied: boolean;
  readonly superseded: boolean;
  readonly latencyMs: number;
}

export class ResponsiveSeekController {
  private generation = 0;
  private activeAbort: AbortController | null = null;
  private lastAppliedSample = 0;
  private totalRequests = 0;
  private supersededCount = 0;
  private appliedCount = 0;

  public async seekToSample(
    targetSample: number,
    executor: (sample: number, signal: AbortSignal) => Promise<void> | void,
  ): Promise<SeekRequestResult> {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const clampedSample = Math.max(0, Math.trunc(targetSample));
    this.totalRequests += 1;

    // Immediately cancel any previous in-flight seek so stale buffers/callbacks never accumulate
    if (this.activeAbort) {
      this.activeAbort.abort('SUPERSEDED_BY_NEWER_SEEK');
      this.supersededCount += 1;
    }

    const myGen = ++this.generation;
    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      await executor(clampedSample, controller.signal);
      if (myGen !== this.generation || controller.signal.aborted) {
        return {
          seekGeneration: myGen,
          targetSample: clampedSample,
          applied: false,
          superseded: true,
          latencyMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start),
        };
      }
      this.lastAppliedSample = clampedSample;
      this.appliedCount += 1;
      return {
        seekGeneration: myGen,
        targetSample: clampedSample,
        applied: true,
        superseded: false,
        latencyMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start),
      };
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = null;
      }
    }
  }

  public cancelPending(): void {
    if (this.activeAbort) {
      this.activeAbort.abort('CANCELLED');
      this.activeAbort = null;
    }
  }

  public getStats(): {
    readonly lastAppliedSample: number;
    readonly totalRequests: number;
    readonly appliedCount: number;
    readonly supersededCount: number;
  } {
    return {
      lastAppliedSample: this.lastAppliedSample,
      totalRequests: this.totalRequests,
      appliedCount: this.appliedCount,
      supersededCount: this.supersededCount,
    };
  }
}
