import { ExecutionModePreferenceStore } from './ExecutionModePreferenceStore';
import { LocalExecutionAdapter } from './LocalExecutionAdapter';
import { CloudExecutionAdapter } from './CloudExecutionAdapter';
import {
  ExecutionMode,
  ExecutionTraceEntry,
  ProviderCapabilityDescriptor,
  UnifiedExecutionAdapter,
  UnifiedProcessingError,
  UnifiedProcessingRequest,
  UnifiedProcessingResultEnvelope,
  validateUnifiedProcessingRequest,
  validateUnifiedProcessingResultEnvelope,
} from './UnifiedProcessingContract';

export interface UnifiedOrchestratorOptions {
  readonly localAdapter?: UnifiedExecutionAdapter;
  readonly cloudAdapter?: UnifiedExecutionAdapter;
  readonly preferenceStore?: ExecutionModePreferenceStore;
  readonly maxTraceEntries?: number;
}

export interface UnifiedCapabilityReport {
  readonly selectedPreferredMode: ExecutionMode;
  readonly explicitCloudOptInConfirmed: boolean;
  readonly localCapabilities: readonly ProviderCapabilityDescriptor[];
  readonly cloudCapabilities: readonly ProviderCapabilityDescriptor[];
}

/**
 * Single Central Unified Processing Orchestrator.
 *
 * Controls BOTH `LOCAL` and `CLOUD` execution paths through one shared contract,
 * one validation boundary, one provenance model, and one bounded sanitized trace.
 *
 * Strictly enforces:
 * - LOCAL is default; CLOUD requires explicit selection.
 * - ZERO silent fallback in either direction (Local -> Cloud or Cloud -> Local).
 * - Mode changes affect NEW jobs only; active jobs retain their snapshotted mode.
 * - Zero raw audio or transcript logging in trace records.
 */
export class UnifiedProcessingOrchestrator {
  public readonly preferenceStore: ExecutionModePreferenceStore;
  private readonly localAdapter: UnifiedExecutionAdapter;
  private readonly cloudAdapter: UnifiedExecutionAdapter;
  private readonly maxTraceEntries: number;
  private readonly traceHistory: ExecutionTraceEntry[] = [];
  private readonly activeJobModes = new Map<string, ExecutionMode>();
  private traceCounter = 0;

  constructor(options?: UnifiedOrchestratorOptions) {
    this.preferenceStore = options?.preferenceStore ?? new ExecutionModePreferenceStore();
    this.localAdapter = options?.localAdapter ?? new LocalExecutionAdapter();
    this.cloudAdapter =
      options?.cloudAdapter ??
      new CloudExecutionAdapter({
        config: {
          providerId: 'cloud-unconfigured',
          displayName: 'Remote Cloud ASR Provider (Unconfigured)',
          endpointUrl: null,
          configured: false,
        },
        transport: null,
      });
    const rawMaxTrace = options?.maxTraceEntries;
    this.maxTraceEntries =
      typeof rawMaxTrace === 'number' && Number.isFinite(rawMaxTrace)
        ? Math.max(10, Math.min(500, Math.floor(rawMaxTrace)))
        : 200;
  }

  public async discoverCapabilities(): Promise<UnifiedCapabilityReport> {
    const pref = this.preferenceStore.getSnapshot();
    const [localCapabilities, cloudCapabilities] = await Promise.all([
      this.localAdapter.discoverCapabilities(),
      this.cloudAdapter.discoverCapabilities(),
    ]);
    return Object.freeze({
      selectedPreferredMode: pref.preferredMode,
      explicitCloudOptInConfirmed: pref.explicitCloudOptInConfirmed,
      localCapabilities,
      cloudCapabilities,
    });
  }

  public getActiveJobExecutionMode(jobId: string): ExecutionMode | null {
    return this.activeJobModes.get(jobId) ?? null;
  }

  public getExecutionTrace(limit = 50): readonly ExecutionTraceEntry[] {
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      const safeLimit = Math.floor(limit);
      if (safeLimit <= 0) return Object.freeze([]);
      return Object.freeze(this.traceHistory.slice(-safeLimit));
    }
    return Object.freeze(this.traceHistory.slice(-50));
  }

  private recordTrace(entry: ExecutionTraceEntry): void {
    this.traceHistory.push(Object.freeze(entry));
    while (this.traceHistory.length > this.maxTraceEntries) {
      this.traceHistory.shift();
    }
  }

  public async execute(
    request: UnifiedProcessingRequest,
    signal?: AbortSignal,
  ): Promise<UnifiedProcessingResultEnvelope> {
    // Snapshot execution mode at job start so concurrent preference switches NEVER mutate active jobs
    const resolvedMode: ExecutionMode =
      request.executionMode ?? this.preferenceStore.getPreferredMode();

    validateUnifiedProcessingRequest(request, resolvedMode);

    const adapter = resolvedMode === 'LOCAL' ? this.localAdapter : this.cloudAdapter;
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const normalizedRequest: UnifiedProcessingRequest = Object.freeze({
      ...request,
      executionMode: resolvedMode,
    });

    this.activeJobModes.set(request.jobId, resolvedMode);

    try {
      const result = await adapter.execute(normalizedRequest, signal);

      if (!validateUnifiedProcessingResultEnvelope(result, request.jobId, resolvedMode)) {
        throw new UnifiedProcessingError({
          code: 'PROVIDER_INVALID_RESPONSE',
          executionMode: resolvedMode,
          providerId: adapter.adapterId,
          detailEn: 'Adapter returned a response that violated the canonical result envelope contract.',
        });
      }

      this.recordTrace({
        traceId: `trc_${++this.traceCounter}`,
        jobId: result.jobId,
        recordingId: result.recordingId,
        selectedExecutionMode: resolvedMode,
        actualAdapterId: result.provenance.actualAdapterId,
        providerId: result.provenance.providerId,
        processingMode: result.processingMode,
        status: result.status,
        startedAtIso: result.provenance.startedAtIso,
        completedAtIso: result.provenance.completedAtIso,
        actualDurationMs: result.provenance.actualDurationMs,
        retryCount: result.provenance.retryCount,
        fallbackUsed: result.provenance.fallbackUsed,
        failureCode: result.provenance.failureCode,
      });

      return result;
    } catch (err) {
      const completedAtMs = Date.now();
      const mapped =
        err instanceof UnifiedProcessingError
          ? err
          : new UnifiedProcessingError({
              code: 'PROCESSING_FAILED',
              executionMode: resolvedMode,
              providerId: adapter.adapterId,
              detailEn: err instanceof Error ? err.message : String(err),
            });

      this.recordTrace({
        traceId: `trc_${++this.traceCounter}`,
        jobId: request.jobId,
        recordingId: request.recordingId,
        selectedExecutionMode: resolvedMode,
        actualAdapterId: adapter.adapterId,
        providerId: mapped.providerId ?? adapter.adapterId,
        processingMode: request.processingMode,
        status: mapped.code === 'PROCESSING_CANCELLED' ? 'CANCELLED' : 'FAILED',
        startedAtIso,
        completedAtIso: new Date(completedAtMs).toISOString(),
        actualDurationMs: Math.max(0, completedAtMs - startedAtMs),
        retryCount: 0,
        fallbackUsed: false,
        failureCode: mapped.code,
      });

      throw mapped;
    } finally {
      this.activeJobModes.delete(request.jobId);
    }
  }
}
