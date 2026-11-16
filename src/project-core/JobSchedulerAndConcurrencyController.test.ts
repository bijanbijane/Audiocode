import test from 'node:test';
import assert from 'node:assert/strict';
import { JobSchedulerAndConcurrencyController } from './JobSchedulerAndConcurrencyController';
import { ProjectDocument } from '../contracts/project-schema.contract';

function makeProjectDoc(revision = 1): ProjectDocument {
  return {
    projectId: 'proj-job-1',
    name: 'تایملاین مصاحبه',
    canonicalSampleRate: 48000,
    revision,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2',
      activeModelBundleVersion: 'v1',
    },
    tracks: [],
    recommendations: [],
  };
}

test('JobScheduler rejects stale ANALYSIS results when project revision mutates mid-flight', async () => {
  const controller = new JobSchedulerAndConcurrencyController();
  let project = makeProjectDoc(1);
  let committedAnalysis = false;

  const analysisPromise = controller.scheduleAndExecuteJob({
    descriptor: {
      jobId: 'asr-job-1',
      titleFa: 'تحلیل گفتار فارسی',
      accessKind: 'ANALYSIS',
      idempotent: true,
      deterministic: true,
      resumable: true,
      retryable: true,
      cancellable: true,
      checkpointable: true,
    },
    getCurrentProjectState: () => project,
    async executeFn(snapshot) {
      assert.equal(snapshot.revision, 1);
      // Attempting in-place mutation of frozen snapshot throws TypeError in strict mode
      assert.throws(() => {
        (snapshot as { name: string }).name = 'mutated';
      }, TypeError);
      await new Promise((r) => setTimeout(r, 25));
      return { tokenCount: 42 };
    },
    onCommitAnalysisOrMutation() {
      committedAnalysis = true;
    },
  });

  // User edits timeline concurrently -> MUTATION advances revision to 2
  const mutationResult = await controller.scheduleAndExecuteJob({
    descriptor: {
      jobId: 'cut-job-1',
      titleFa: 'برش تپق گوینده',
      accessKind: 'MUTATION',
      idempotent: false,
      deterministic: true,
      resumable: false,
      retryable: false,
      cancellable: false,
      checkpointable: true,
    },
    getCurrentProjectState: () => project,
    async executeFn() {
      return { cutPerformed: true };
    },
    onCommitAnalysisOrMutation() {
      project = { ...project, revision: project.revision + 1 };
    },
  });

  assert.equal(mutationResult.status, 'COMPLETED');
  const analysisResult = await analysisPromise;
  assert.equal(analysisResult.status, 'SUPERSEDED_STALE_REVISION');
  assert.equal(committedAnalysis, false);
});

test('JobScheduler serializes concurrent MUTATION jobs strictly via FIFO mutex and enforces revision bump', async () => {
  const controller = new JobSchedulerAndConcurrencyController();
  let project = makeProjectDoc(10);
  const executionLog: string[] = [];

  const jobA = controller.scheduleAndExecuteJob({
    descriptor: {
      jobId: 'mut-a',
      titleFa: 'عملیات الف',
      accessKind: 'MUTATION',
      idempotent: false,
      deterministic: true,
      resumable: false,
      retryable: false,
      cancellable: false,
      checkpointable: true,
    },
    getCurrentProjectState: () => project,
    async executeFn() {
      executionLog.push('A-start');
      await new Promise((r) => setTimeout(r, 20));
      executionLog.push('A-end');
    },
    onCommitAnalysisOrMutation() {
      project = { ...project, revision: project.revision + 1 };
    },
  });

  const jobB = controller.scheduleAndExecuteJob({
    descriptor: {
      jobId: 'mut-b',
      titleFa: 'عملیات ب',
      accessKind: 'MUTATION',
      idempotent: false,
      deterministic: true,
      resumable: false,
      retryable: false,
      cancellable: false,
      checkpointable: true,
    },
    getCurrentProjectState: () => project,
    async executeFn() {
      executionLog.push('B-start');
      executionLog.push('B-end');
    },
    onCommitAnalysisOrMutation() {
      project = { ...project, revision: project.revision + 1 };
    },
  });

  await Promise.all([jobA, jobB]);
  // Strict FIFO mutual exclusion: A completes before B even begins
  assert.deepEqual(executionLog, ['A-start', 'A-end', 'B-start', 'B-end']);
  assert.equal(project.revision, 12);

  // Mutation that fails to increment revision violates Section 31 Rule 3
  await assert.rejects(
    () =>
      controller.scheduleAndExecuteJob({
        descriptor: {
          jobId: 'mut-broken',
          titleFa: 'عملیات بدون افزایش نسخه',
          accessKind: 'MUTATION',
          idempotent: false,
          deterministic: true,
          resumable: false,
          retryable: false,
          cancellable: false,
          checkpointable: true,
        },
        getCurrentProjectState: () => project,
        async executeFn() {},
      }),
    /MUTATION_REVISION_INVARIANT_VIOLATION/,
  );
});

test('JobScheduler supports RENDER snapshot isolation and cancellable jobs', async () => {
  const controller = new JobSchedulerAndConcurrencyController();
  let project = makeProjectDoc(3);

  const renderJob = controller.scheduleAndExecuteJob({
    descriptor: {
      jobId: 'render-1',
      titleFa: 'رندر خروجی نهایی',
      accessKind: 'RENDER',
      idempotent: true,
      deterministic: true,
      resumable: true,
      retryable: true,
      cancellable: true,
      checkpointable: true,
    },
    getCurrentProjectState: () => project,
    async executeFn(snapshot) {
      await new Promise((r) => setTimeout(r, 20));
      // Snapshot captured at revision 3 stays immutable even after project bumps to 4
      return snapshot.revision;
    },
  });

  project = { ...project, revision: 4 };
  const renderRes = await renderJob;
  assert.equal(renderRes.status, 'COMPLETED');
  assert.equal(renderRes.result, 3);

  // Test cancellation
  const cancelJobPromise = controller.scheduleAndExecuteJob({
    descriptor: {
      jobId: 'cancel-me',
      titleFa: 'تسک قابل لغو',
      accessKind: 'READ',
      idempotent: true,
      deterministic: true,
      resumable: false,
      retryable: false,
      cancellable: true,
      checkpointable: false,
    },
    getCurrentProjectState: () => project,
    async executeFn(_snapshot, signal) {
      await new Promise((r) => setTimeout(r, 25));
      return signal.aborted;
    },
  });

  const cancelled = controller.cancelJob('cancel-me');
  assert.equal(cancelled, true);
  const cancelOutcome = await cancelJobPromise;
  assert.equal(cancelOutcome.status, 'CANCELLED');
});
