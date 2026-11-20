/**
 * AVAPARDAZ — EXPLICIT PROCESSING JOB LIFECYCLE & IDEMPOTENCY MANAGER
 *
 * Compliant with AVP-ARCH-001 (Version 4.0) Section 7.5:
 * - Explicit states: QUEUED | RUNNING | COMPLETED | FAILED | CANCELLED | INTERRUPTED | RECOVERABLE | EXPIRED
 * - Idempotency key deduplication so duplicate submissions never re-run compute
 * - Cooperative AbortController cancellation
 * - Bounded memory retention & explicit TTL expiration
 */

import crypto from 'node:crypto';
import { UnifiedProcessingError, UnifiedProcessingErrorPayload } from '../UnifiedProcessingContract';
import {
  CanonicalCapabilityId,
  CanonicalJobState,
  CanonicalOperationEnvelope,
  CanonicalOperationResult,
  validateCanonicalOperationEnvelope,
} from './CanonicalCapabilityContracts';
import { ProcessingCapabilityRegistry } from './CapabilityRegistry';
import { sanitizeSecurityTelemetry } from '../../security/PrivacyRetentionAndIsolationEngine';

export interface ProcessingJobRecord {
  readonly job_id: string;
  readonly request_id: string;
  readonly idempotency_key: string;
  readonly capability_id: CanonicalCapabilityId;
  readonly project_id: string;
  readonly project_revision: number;
  readonly state: CanonicalJobState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly attempt_count: number;
  readonly deduplicated_from_idempotency: boolean;
  readonly result: CanonicalOperationResult | null;
  readonly error: UnifiedProcessingErrorPayload | null;
}

interface InternalJobState {
  record: ProcessingJobRecord;
  envelope: CanonicalOperationEnvelope;
  abortController: AbortController;
  executionPromise: Promise<ProcessingJobRecord> | null;
}

export interface ProcessingJobManagerOptions {
  readonly registry?: ProcessingCapabilityRegistry;
  readonly maxRetainedJobs?: number;
  readonly defaultTtlMs?: number;
}

export class ProcessingJobManager {
  private readonly registry: ProcessingCapabilityRegistry;
  private readonly maxRetainedJobs: number;
  private readonly defaultTtlMs: number;
  private readonly jobs = new Map<string, InternalJobState>();
  private readonly idempotencyIndex = new Map<string, string>();

  constructor(options?: ProcessingJobManagerOptions) {
    this.registry = options?.registry ?? new ProcessingCapabilityRegistry();
    const rawMax = options?.maxRetainedJobs;
    this.maxRetainedJobs =
      typeof rawMax === 'number' && Number.isFinite(rawMax)
        ? Math.max(20, Math.min(2000, Math.floor(rawMax)))
        : 500;
    const rawTtl = options?.defaultTtlMs;
    this.defaultTtlMs =
      typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0
        ? Math.max(1_000, Math.floor(rawTtl))
        : 60 * 60 * 1000;
  }

  public getRegistry(): ProcessingCapabilityRegistry {
    return this.registry;
  }

  public submitJob(
    envelope: CanonicalOperationEnvelope,
    options?: { readonly deferExecutionMs?: number },
  ): {
    readonly job: ProcessingJobRecord;
    readonly deduplicated: boolean;
    readonly completion: Promise<ProcessingJobRecord>;
  } {
    const validation = validateCanonicalOperationEnvelope(envelope);
    if (!validation.ok) {
      throw new UnifiedProcessingError({
        code: validation.code ?? 'INVALID_PROCESSING_REQUEST',
        executionMode: 'LOCAL',
        detailEn: validation.message ?? 'Invalid operation envelope.',
      });
    }

    this.sweepExpiredJobs();

    // Idempotency deduplication (Section 7.5)
    const existingJobId = this.idempotencyIndex.get(envelope.idempotency_key);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing && existing.record.state !== 'EXPIRED') {
        const snapshot: ProcessingJobRecord = Object.freeze({
          ...existing.record,
          deduplicated_from_idempotency: true,
        });
        return {
          job: snapshot,
          deduplicated: true,
          completion: existing.executionPromise ?? Promise.resolve(snapshot),
        };
      }
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + this.defaultTtlMs).toISOString();
    const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;

    const initialRecord: ProcessingJobRecord = Object.freeze({
      job_id: jobId,
      request_id: envelope.request_id,
      idempotency_key: envelope.idempotency_key,
      capability_id: envelope.capability_id,
      project_id: envelope.project_id,
      project_revision: envelope.project_revision,
      state: 'QUEUED',
      created_at: nowIso,
      updated_at: nowIso,
      expires_at: expiresIso,
      attempt_count: 1,
      deduplicated_from_idempotency: false,
      result: null,
      error: null,
    });

    const entry: InternalJobState = {
      record: initialRecord,
      envelope,
      abortController: new AbortController(),
      executionPromise: null,
    };

    this.jobs.set(jobId, entry);
    this.idempotencyIndex.set(envelope.idempotency_key, jobId);
    this.enforceRetentionBound();

    const deferMs =
      typeof options?.deferExecutionMs === 'number' &&
      Number.isFinite(options.deferExecutionMs) &&
      options.deferExecutionMs > 0
        ? Math.min(5_000, Math.floor(options.deferExecutionMs))
        : 0;

    entry.executionPromise = this.runJobAsync(entry, deferMs);

    return {
      job: initialRecord,
      deduplicated: false,
      completion: entry.executionPromise,
    };
  }

  private async runJobAsync(entry: InternalJobState, deferMs: number): Promise<ProcessingJobRecord> {
    if (deferMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deferMs);
        entry.abortController.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    if (entry.abortController.signal.aborted) {
      entry.record = Object.freeze({
        ...entry.record,
        state: 'CANCELLED',
        updated_at: new Date().toISOString(),
        error: new UnifiedProcessingError({
          code: 'PROCESSING_CANCELLED',
          executionMode: 'LOCAL',
        }).toPayload(),
      });
      return entry.record;
    }

    entry.record = Object.freeze({
      ...entry.record,
      state: 'RUNNING',
      updated_at: new Date().toISOString(),
    });

    try {
      const result = await this.registry.executeEnvelope(
        entry.envelope,
        entry.abortController.signal,
      );
      if (entry.abortController.signal.aborted) {
        entry.record = Object.freeze({
          ...entry.record,
          state: 'CANCELLED',
          updated_at: new Date().toISOString(),
          result: null,
          error: new UnifiedProcessingError({
            code: 'PROCESSING_CANCELLED',
            executionMode: result.actual_execution_environment,
          }).toPayload(),
        });
      } else {
        entry.record = Object.freeze({
          ...entry.record,
          state: result.status === 'CANCELLED' ? 'CANCELLED' : result.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
          updated_at: new Date().toISOString(),
          result,
          error: result.errors[0] ?? null,
        });
      }
      return entry.record;
    } catch (err) {
      const mapped =
        err instanceof UnifiedProcessingError
          ? err
          : new UnifiedProcessingError({
              code: 'PROCESSING_FAILED',
              executionMode: 'LOCAL',
              detailEn: sanitizeSecurityTelemetry(err instanceof Error ? err.message : String(err)),
            });

      const nextState: CanonicalJobState =
        mapped.code === 'PROCESSING_CANCELLED'
          ? 'CANCELLED'
          : mapped.retryable
            ? 'RECOVERABLE'
            : 'FAILED';

      entry.record = Object.freeze({
        ...entry.record,
        state: nextState,
        updated_at: new Date().toISOString(),
        result: null,
        error: mapped.toPayload(),
      });
      return entry.record;
    }
  }

  public getJob(jobId: string): ProcessingJobRecord | null {
    this.sweepExpiredJobs();
    return this.jobs.get(jobId)?.record ?? null;
  }

  public listJobs(limit = 50): readonly ProcessingJobRecord[] {
    this.sweepExpiredJobs();
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    return Object.freeze(
      Array.from(this.jobs.values())
        .map((j) => j.record)
        .slice(-safeLimit)
        .reverse(),
    );
  }

  public cancelJob(jobId: string): ProcessingJobRecord | null {
    this.sweepExpiredJobs();
    const entry = this.jobs.get(jobId);
    if (!entry) return null;

    if (
      entry.record.state === 'COMPLETED' ||
      entry.record.state === 'FAILED' ||
      entry.record.state === 'CANCELLED' ||
      entry.record.state === 'EXPIRED'
    ) {
      return entry.record;
    }

    entry.abortController.abort();
    entry.record = Object.freeze({
      ...entry.record,
      state: 'CANCELLED',
      updated_at: new Date().toISOString(),
      error: new UnifiedProcessingError({
        code: 'PROCESSING_CANCELLED',
        executionMode: 'LOCAL',
      }).toPayload(),
    });
    return entry.record;
  }

  public sweepExpiredJobs(nowMs = Date.now()): number {
    let expiredCount = 0;
    for (const entry of this.jobs.values()) {
      if (
        entry.record.state !== 'RUNNING' &&
        entry.record.state !== 'QUEUED' &&
        entry.record.state !== 'EXPIRED' &&
        Date.parse(entry.record.expires_at) <= nowMs
      ) {
        entry.record = Object.freeze({
          ...entry.record,
          state: 'EXPIRED',
          updated_at: new Date(nowMs).toISOString(),
        });
        expiredCount++;
      }
    }
    return expiredCount;
  }

  private enforceRetentionBound(): void {
    while (this.jobs.size > this.maxRetainedJobs) {
      let evictKey: string | undefined;
      for (const [k, entry] of this.jobs.entries()) {
        if (entry.record.state !== 'RUNNING' && entry.record.state !== 'QUEUED') {
          evictKey = k;
          break;
        }
      }
      if (!evictKey) {
        evictKey = this.jobs.keys().next().value;
      }
      if (!evictKey) break;
      const oldest = this.jobs.get(evictKey);
      if (oldest && this.idempotencyIndex.get(oldest.record.idempotency_key) === evictKey) {
        this.idempotencyIndex.delete(oldest.record.idempotency_key);
      }
      this.jobs.delete(evictKey);
    }
  }
}
