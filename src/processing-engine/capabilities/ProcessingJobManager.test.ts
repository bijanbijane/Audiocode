import { describe, expect, it, vi } from 'vitest';
import type { ProcessingCapabilityRegistry } from './CapabilityRegistry';
import type { CanonicalOperationEnvelope, CanonicalOperationResult } from './CanonicalCapabilityContracts';
import { ProcessingJobManager } from './ProcessingJobManager';

function makeEnvelope(idempotencyKey: string, requestId: string): CanonicalOperationEnvelope {
  return {
    request_id: requestId,
    capability_id: 'speech.transcription',
    operation_version: '1.0.0',
    contract_version: '2.0.0',
    project_id: 'project-test',
    project_revision: 0,
    media_references: [],
    input_payload: {},
    configuration: {},
    execution_policy: 'LOCAL_ONLY',
    requested_model_policy: 'AUTO_BEST_LOCAL',
    idempotency_key: idempotencyKey,
    created_at: new Date(0).toISOString(),
    correlation_id: requestId,
  };
}

describe('ProcessingJobManager owner isolation', () => {
  it('isolates idempotency, lookup, listing, and cancellation by owner', () => {
    const registry = {
      executeEnvelope: vi.fn(async () => ({
        status: 'COMPLETED',
        actual_execution_environment: 'LOCAL',
        errors: [],
      } as unknown as CanonicalOperationResult)),
    } as unknown as ProcessingCapabilityRegistry;
    const manager = new ProcessingJobManager({ registry });
    const ownerAEnvelope = makeEnvelope('shared-idempotency-key', 'request-owner-a');

    const ownerA = manager.submitJob(ownerAEnvelope, {
      ownerId: 'owner-A',
      deferExecutionMs: 5_000,
    });
    const ownerADuplicate = manager.submitJob(ownerAEnvelope, {
      ownerId: 'owner-A',
      deferExecutionMs: 5_000,
    });
    const ownerB = manager.submitJob(
      makeEnvelope('shared-idempotency-key', 'request-owner-b'),
      { ownerId: 'owner-B', deferExecutionMs: 5_000 },
    );

    expect(ownerADuplicate.deduplicated).toBe(true);
    expect(ownerADuplicate.job.job_id).toBe(ownerA.job.job_id);
    expect(ownerB.deduplicated).toBe(false);
    expect(ownerB.job.job_id).not.toBe(ownerA.job.job_id);

    expect(manager.getJob(ownerA.job.job_id, 'owner-A')?.job_id).toBe(ownerA.job.job_id);
    expect(manager.getJob(ownerA.job.job_id, 'owner-B')).toBeNull();
    expect(manager.getJob(ownerA.job.job_id)).toBeNull();
    expect(manager.cancelJob(ownerA.job.job_id, 'owner-B')).toBeNull();
    expect(manager.listJobs(20)).toHaveLength(0);
    expect(manager.listJobs(20, 'owner-A').map((job) => job.job_id)).toEqual([ownerA.job.job_id]);
    expect(manager.listJobs(20, 'owner-B').map((job) => job.job_id)).toEqual([ownerB.job.job_id]);
    expect(manager.getTrackedJobCount()).toBe(2);

    expect(manager.cancelJob(ownerA.job.job_id, 'owner-A')?.state).toBe('CANCELLED');
    expect(manager.cancelJob(ownerB.job.job_id, 'owner-B')?.state).toBe('CANCELLED');
  });

  it('rejects blank owner identities instead of creating an unscoped IPC job', () => {
    const manager = new ProcessingJobManager({
      registry: { executeEnvelope: vi.fn() } as unknown as ProcessingCapabilityRegistry,
    });

    expect(() =>
      manager.submitJob(makeEnvelope('blank-owner-key', 'request-blank-owner'), {
        ownerId: '   ',
      }),
    ).toThrow('A non-empty ownerId is required for owner-scoped jobs.');
  });
});
