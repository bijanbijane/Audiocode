import { ProjectDocument } from '../contracts/project-schema.contract';

export type JobAccessKind = 'READ' | 'ANALYSIS' | 'MUTATION' | 'RENDER';

export interface JobCapabilitiesDescriptor {
  readonly jobId: string;
  readonly titleFa: string;
  readonly accessKind: JobAccessKind;
  readonly idempotent: boolean;
  readonly deterministic: boolean;
  readonly resumable: boolean;
  readonly retryable: boolean;
  readonly cancellable: boolean;
  readonly checkpointable: boolean;
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const val of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Job Scheduler & 4-Access-Level Concurrency Controller (Architecture Doc Section 31):
 * - READ & ANALYSIS run against immutable cloned snapshots without mutating timeline
 * - RENDER executes over a deep-frozen point-in-time Snapshot
 * - MUTATION jobs serialize deterministically via a Promise FIFO mutex queue & advance revision
 * - Stale ANALYSIS jobs started on an older revision are rejected cleanly before commit
 */
export class JobSchedulerAndConcurrencyController {
  private mutationQueueTail: Promise<void> = Promise.resolve();
  private runningJobs = new Map<
    string,
    {
      descriptor: JobCapabilitiesDescriptor;
      startedAtRevision: number;
      abortController: AbortController;
    }
  >();

  public getActiveJobIds(): string[] {
    return Array.from(this.runningJobs.keys());
  }

  public async scheduleAndExecuteJob<TResult>(params: {
    descriptor: JobCapabilitiesDescriptor;
    getCurrentProjectState: () => ProjectDocument;
    executeFn: (
      immutableSnapshot: Readonly<ProjectDocument>,
      abortSignal: AbortSignal,
    ) => Promise<TResult>;
    onCommitAnalysisOrMutation?: (
      result: TResult,
      currentProjectState: ProjectDocument,
    ) => void;
  }): Promise<{
    status: 'COMPLETED' | 'SUPERSEDED_STALE_REVISION' | 'CANCELLED';
    result?: TResult;
  }> {
    const { descriptor, getCurrentProjectState } = params;

    let releaseMutationMutex: (() => void) | null = null;
    if (descriptor.accessKind === 'MUTATION') {
      const prevTail = this.mutationQueueTail;
      let resolveNext!: () => void;
      this.mutationQueueTail = new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
      releaseMutationMutex = resolveNext;
      await prevTail;
    }

    const abortController = new AbortController();
    const snapshotAtStart = deepFreeze(structuredClone(getCurrentProjectState()));
    const startRevision = snapshotAtStart.revision;

    this.runningJobs.set(descriptor.jobId, {
      descriptor,
      startedAtRevision: startRevision,
      abortController,
    });

    try {
      const result = await params.executeFn(snapshotAtStart, abortController.signal);

      if (abortController.signal.aborted) {
        return { status: 'CANCELLED' };
      }

      const latestProjectState = getCurrentProjectState();

      // Section 31 Rule 4: Reject stale analysis if project mutated while job was running
      if (
        descriptor.accessKind === 'ANALYSIS' &&
        latestProjectState.revision !== startRevision
      ) {
        return { status: 'SUPERSEDED_STALE_REVISION' };
      }

      if (params.onCommitAnalysisOrMutation) {
        params.onCommitAnalysisOrMutation(result, latestProjectState);
      }

      // Section 31 Rule 3: MUTATION must advance project revision
      if (descriptor.accessKind === 'MUTATION') {
        const postCommitRevision = getCurrentProjectState().revision;
        if (postCommitRevision <= startRevision) {
          throw new Error(
            `MUTATION_REVISION_INVARIANT_VIOLATION: عملیات ${descriptor.jobId} باید نسخه پروژه (revision) را افزایش دهد.`,
          );
        }
      }

      return { status: 'COMPLETED', result };
    } finally {
      this.runningJobs.delete(descriptor.jobId);
      if (releaseMutationMutex) {
        releaseMutationMutex();
      }
    }
  }

  public cancelJob(jobId: string): boolean {
    const entry = this.runningJobs.get(jobId);
    if (!entry || !entry.descriptor.cancellable) return false;
    entry.abortController.abort();
    this.runningJobs.delete(jobId);
    return true;
  }
}
