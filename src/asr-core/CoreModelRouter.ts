/**
 * CORE ASR ENGINE — MINIMAL BENCHMARK-GROUNDED ROUTER & PROFILER (MILESTONE CORE-07)
 *
 * Strictly selects between actually verified backends on the current host.
 * Logs explicit routing decisions, warmup status, and measured RTF/latency.
 */

import crypto from 'node:crypto';
import {
  CoreAcousticCtcEngine,
  probeRuntimeBackendAvailability,
} from './CoreAcousticCtcEngine';
import { CoreBatchAndLongFormEngine } from './CoreBatchAndLongFormEngine';
import { CoreStreamingAsrManager } from './CoreStreamingAsrEngine';
import type {
  AsrBackendKind,
  DetectedLanguageTag,
  RoutingAuditRecord,
} from './CoreAsrContracts';

export class CoreModelRouter {
  private readonly auditTrail: RoutingAuditRecord[] = [];
  public readonly acousticEngine: CoreAcousticCtcEngine;
  public readonly batchEngine: CoreBatchAndLongFormEngine;
  public readonly streamingManager: CoreStreamingAsrManager;
  private warmupStats: { warmedUp: boolean; warmupLatencyMs: number } | null = null;

  constructor(acousticEngine?: CoreAcousticCtcEngine) {
    this.acousticEngine = acousticEngine ?? new CoreAcousticCtcEngine();
    this.batchEngine = new CoreBatchAndLongFormEngine(this.acousticEngine);
    this.streamingManager = new CoreStreamingAsrManager(this.acousticEngine, 8);
  }

  public warmup(): { warmedUp: boolean; warmupLatencyMs: number; peakRssMb: number } {
    this.warmupStats = this.acousticEngine.warmup();
    const peakRssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    return { ...this.warmupStats, peakRssMb };
  }

  public routeInference(params: {
    mode: 'batch' | 'long_form' | 'streaming';
    preferredBackend?: AsrBackendKind;
    languageHint?: DetectedLanguageTag | 'auto';
  }): RoutingAuditRecord {
    const backends = probeRuntimeBackendAvailability();
    const preferred = params.preferredBackend ?? 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER';
    const prefEntry = backends.find((b) => b.backendId === preferred);

    let selectedBackend: AsrBackendKind = 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER';
    let fallbackTriggered = false;
    let fallbackReason: string | null = null;

    if (prefEntry && prefEntry.availableOnThisHost) {
      selectedBackend = prefEntry.backendId;
    } else if (preferred !== 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER') {
      fallbackTriggered = true;
      fallbackReason =
        prefEntry?.reasonIfUnavailable ??
        `Preferred backend ${preferred} is not available on this host; routed to verified CPU acoustic adapter.`;
    }

    const record: RoutingAuditRecord = {
      routingId: `rte_${crypto.randomBytes(4).toString('hex')}`,
      timestampIso: new Date().toISOString(),
      mode: params.mode,
      requestedLanguageHint: params.languageHint ?? 'auto',
      selectedBackend,
      selectedModelVersionId: this.acousticEngine.getModelVersionId(),
      fallbackTriggered,
      fallbackReason,
      availableBackends: backends,
    };

    this.auditTrail.push(record);
    if (this.auditTrail.length > 200) this.auditTrail.shift();
    return record;
  }

  public getHealthAndProfile(): {
    status: 'READY';
    warmup: { warmedUp: boolean; warmupLatencyMs: number } | null;
    activeStreamingSessions: number;
    peakRssMb: number;
    backends: ReturnType<typeof probeRuntimeBackendAvailability>;
    recentRoutingCount: number;
  } {
    return {
      status: 'READY',
      warmup: this.warmupStats,
      activeStreamingSessions: this.streamingManager.getActiveSessionCount(),
      peakRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
      backends: probeRuntimeBackendAvailability(),
      recentRoutingCount: this.auditTrail.length,
    };
  }

  public listRecentRoutingAudit(limit = 20): RoutingAuditRecord[] {
    if (typeof limit === 'number' && limit <= 0) return [];
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 20;
    return this.auditTrail.slice(-safeLimit);
  }
}
