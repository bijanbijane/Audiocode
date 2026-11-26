import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInitialAudioEditJob } from './AudioEditJobStateMachine';
import type { AudioRenderResult } from '../audio-renderer/AudioRenderTypes';
import type { ImportedAudioContext, SmartAudioEditPipeline } from './SmartAudioEditPipeline';
import type { SmartAudioEditSession } from './SmartAudioEditContracts';
import { SmartAudioEditJobManager } from './SmartAudioEditJobManager';

const ONE_MIB = 1024 * 1024;

function makeSession(jobId: string): SmartAudioEditSession {
  const now = Date.now();
  return {
    sessionId: jobId,
    projectId: 'project-test',
    trackId: 'track-test',
    filename: 'fixture.wav',
    sourceAudioId: `source-${jobId}`,
    sourceAudioHash: 'a'.repeat(64),
    sourceSampleRate: 48_000,
    sourceChannels: 1,
    totalSourceSamples: 0,
    sourceDurationSec: 0,
    transcript: null,
    asrMetrics: null,
    speechEvents: null,
    edl: null,
    edlHistory: [],
    edlHistoryIndex: -1,
    lastRenderResult: null,
    stageTrace: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function makeAudio(rawBytes: number): ImportedAudioContext {
  return {
    filename: 'fixture.wav',
    rawBytes: Buffer.alloc(rawBytes),
    sourceAudioId: 'source-test',
    sourceAudioHash: 'a'.repeat(64),
    sourceSampleRate: 48_000,
    sourceChannels: 1,
    totalSourceSamples: 0,
    sourceDurationSec: 0,
    canonical16kMono: new Float32Array(0),
    waveformPeaks: [],
    pcmSource: {} as ImportedAudioContext['pcmSource'],
  };
}

function makePipeline(options: {
  readonly rawBytes?: number;
  readonly renderBytes?: number;
} = {}): SmartAudioEditPipeline {
  return {
    importAndNormalizeAudio: (params: { jobId: string }) => ({
      job: createInitialAudioEditJob({ jobId: params.jobId, sourceAudioHash: 'a'.repeat(64) }),
      session: makeSession(params.jobId),
      audio: makeAudio(options.rawBytes ?? 128 * 1024),
    }),
    renderAndExport: async (params: { job: { jobId: string }; session: SmartAudioEditSession; outputFilePath?: string }) => {
      const outputPath = params.outputFilePath!;
      fs.writeFileSync(outputPath, Buffer.alloc(options.renderBytes ?? 9 * ONE_MIB, 7), { flag: 'w', mode: 0o600 });
      const sizeBytes = fs.statSync(outputPath).size;
      const outputArtifact = {
        sizeBytes,
        dispose: async () => undefined,
      };
      const renderResult = {
        ok: true,
        output: { sampleRate: 48_000, channels: 1, durationSec: 1 },
        preValidation: { passed: true },
        postValidation: {
          passed: true,
          verifiedOutputSamples: 48_000,
          verifiedDurationSec: 1,
          verifiedOutputHash: 'b'.repeat(64),
        },
        outputArtifact,
      } as unknown as AudioRenderResult;
      return {
        job: params.job,
        session: params.session,
        renderResult,
        exportedFilePath: outputPath,
        sourceHashImmutableVerified: true,
      };
    },
  } as unknown as SmartAudioEditPipeline;
}

function makeManager(
  pipeline: SmartAudioEditPipeline,
  limits: { maxRetainedJobs?: number; maxTotalRetainedBytes?: number; maxJobsPerOwner?: number } = {},
) {
  return new SmartAudioEditJobManager(pipeline, {
    maxRetainedJobs: limits.maxRetainedJobs ?? 4,
    maxTotalRetainedBytes: limits.maxTotalRetainedBytes ?? ONE_MIB,
    maxJobsPerOwner: limits.maxJobsPerOwner ?? 8,
    jobTtlMs: 60_000,
    requireExplicitOwnerId: true,
  });
}

test('SmartAudioEditJobManager rejects a single job larger than the retained-byte cap without inserting it', () => {
  const manager = makeManager(makePipeline({ rawBytes: ONE_MIB + 1 }));
  assert.throws(
    () => manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-too-large' }),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'JOB_RETAINED_BYTE_BUDGET_EXCEEDED'),
  );
  assert.equal(manager.getResourceStatus().trackedJobs, 0);
  assert.equal(manager.getTotalRetainedBytes(), 0);
  manager.disposeAll();
});

test('SmartAudioEditJobManager evicts idle jobs before exceeding either retained count or byte budget', () => {
  const manager = makeManager(makePipeline({ rawBytes: 600 * 1024 }), {
    maxRetainedJobs: 2,
    maxTotalRetainedBytes: ONE_MIB,
  });
  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-0001' });
  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-0002' });
  assert.equal(manager.getTotalRetainedBytes(), 600 * 1024);
  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-0003' });

  assert.equal(manager.getResourceStatus().trackedJobs, 1);
  assert.equal(manager.getTotalRetainedBytes(), 600 * 1024);
  assert.equal(manager.getJobSnapshot('job-0001', 'owner-1'), null);
  assert.equal(manager.getJobSnapshot('job-0002', 'owner-1'), null);
  assert.ok(manager.getJobSnapshot('job-0003', 'owner-1'));
  manager.disposeAll();
});

test('SmartAudioEditJobManager never evicts an active job to admit a newer job', () => {
  const manager = makeManager(makePipeline({ rawBytes: 128 * 1024 }), {
    maxRetainedJobs: 2,
    maxTotalRetainedBytes: ONE_MIB,
  });
  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-active' });
  const internals = manager as unknown as {
    jobs: Map<string, { activeAbort: AbortController | null }>;
  };
  internals.jobs.get('job-active')!.activeAbort = new AbortController();

  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-idle' });
  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-new' });

  assert.ok(manager.getJobSnapshot('job-active', 'owner-1'));
  assert.equal(manager.getJobSnapshot('job-idle', 'owner-1'), null);
  assert.ok(manager.getJobSnapshot('job-new', 'owner-1'));
  manager.disposeAll();
});

test('SmartAudioEditJobManager streams large final WAVs from disk and does not delete caller-owned output paths', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-job-manager-export-test-'));
  const externalOutputPath = path.join(tmpDir, 'caller-owned-output.wav');
  const manager = makeManager(makePipeline({ rawBytes: 128 * 1024, renderBytes: 9 * ONE_MIB }));
  try {
    manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-export' });
    await manager.renderFinal('job-export', { ownerId: 'owner-1', outputFilePath: externalOutputPath });

    assert.equal(fs.statSync(externalOutputPath).size, 9 * ONE_MIB);
    assert.equal(manager.getLastOutputFilePath('job-export', 'owner-1'), externalOutputPath);
    assert.equal(manager.getLastOutputWav('job-export', 'owner-1'), null, 'legacy accessor must not load large exports into RAM');
    assert.equal(manager.getJobSnapshot('job-export', 'owner-1')?.hasOutputWav, true);

    manager.disposeJob('job-export', 'owner-1');
    assert.equal(fs.existsSync(externalOutputPath), true, 'disposing a job must not delete a caller-owned export');
  } finally {
    manager.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('SmartAudioEditJobManager owns and removes its private temporary export directory on disposal', async () => {
  const manager = makeManager(makePipeline({ rawBytes: 128 * 1024, renderBytes: 2 * ONE_MIB }));
  manager.createJobFromAudio({ ownerId: 'owner-1', jobId: 'job-managed-export' });
  await manager.renderFinal('job-managed-export', { ownerId: 'owner-1' });
  const outputPath = manager.getLastOutputFilePath('job-managed-export', 'owner-1');
  assert.ok(outputPath);
  const outputDir = path.dirname(outputPath!);
  assert.equal(path.basename(outputDir).startsWith('avapardaz-smart-edit-'), true);
  assert.equal(fs.existsSync(outputPath!), true);

  manager.disposeJob('job-managed-export', 'owner-1');
  assert.equal(fs.existsSync(outputDir), false);
});
