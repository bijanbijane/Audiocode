import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchProcessingOrchestrator } from './BatchProcessingOrchestrator';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

function makeStagedProject(id: string, pendingCount: number): ProjectDocument {
  return {
    projectId: `proj_${id}`,
    name: `فصل ${id}`,
    canonicalSampleRate: 48000,
    versions: {
      projectSchemaVersion: 2,
      audioEngineVersion: '1.2.0',
      processingNodeCatalogVersion: '1.2.0',
      activeModelBundleVersion: '1.2.0',
    },
    revision: 1,
    tracks: [],
    recommendations: Array.from({ length: pendingCount }, (_, idx) => ({
      id: `rec_${id}_${idx}`,
      targetTrackId: 'trk_1',
      disfluencyType: 'INDEPENDENT_FILLER' as const,
      associatedText: 'اممم',
      status: 'PENDING' as const,
      createdAtProjectRevision: 1,
      spliceDescriptor: {
        rawAiRange: { start: 0, end: TimeMath.secondsToFlicks(0.4) },
        snappedAcousticRange: { start: 0, end: TimeMath.secondsToFlicks(0.4) },
        fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
        fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
        injectRoomToneFlicks: 0,
        cutStrategy: 'GLOBAL_SYNC_RIPPLE' as const,
        prosodicWarnings: [],
        confidence: 0.91,
      },
    })),
  };
}

test('Section 57: BatchProcessingOrchestrator enforces Golden Rule 27 staging, bounded cache purging, and fault isolation', async () => {
  const orchestrator = new BatchProcessingOrchestrator();
  orchestrator.enqueueFiles([
    { id: 'f1', fileName: 'chapter1.wav', byteSize: 1024_000 },
    { id: 'f2', fileName: 'corrupt.wav', byteSize: 512_000 },
    { id: 'f3', fileName: 'chapter3.wav', byteSize: 2048_000 },
  ]);

  let purgeCalls = 0;
  const stage1Result = await orchestrator.runBatchPreAnalysisStage({
    analyzeSingleFileToStagedProject: async (item, onProgress) => {
      onProgress(50);
      if (item.itemId === 'f2') {
        throw new Error('CORRUPT_HEADER: فایل صوتی آسیب‌دیده است');
      }
      onProgress(100);
      return makeStagedProject(item.itemId, 2);
    },
    purgeTemporaryPcmCacheBetweenFiles: async () => {
      purgeCalls++;
    },
    onQueueUpdated: () => {},
  });

  // Bounded cache purge runs in finally block after EVERY queued file (including failed ones)
  assert.equal(purgeCalls, 3);
  assert.equal(stage1Result[0].status, 'AWAITING_USER_REVIEW');
  assert.equal(stage1Result[0].pendingRecommendationsCount, 2);
  assert.equal(stage1Result[1].status, 'FAILED_ISOLATED');
  assert.match(stage1Result[1].errorMessageFa ?? '', /CORRUPT_HEADER/);
  assert.equal(stage1Result[2].status, 'AWAITING_USER_REVIEW');

  // Stage 2 renders & validates ONLY AWAITING_USER_REVIEW items
  const stage2Result = await orchestrator.runBatchApprovedExportStage({
    renderAndValidateProject: async (project) => ({
      validationReport: {
        passed: true,
        structurallyValid: true,
        expectedDurationSeconds: 120,
        actualDurationSeconds: 120,
        channelCount: 2,
        frameCount: 5_760_000,
        maxSamplePeakDb: -1.0,
        clippedSamplesCount: 0,
        invalidSamplesCount: 0,
        hasStartOrEndClickRisk: false,
        errors: [],
      },
      manifest: {
        manifestId: `man_${project.projectId}`,
        projectRevision: project.revision,
        versions: project.versions,
        inputAssetContentHashes: ['abc123'],
        graphCacheKey: 'master_16lufs',
        exportSampleRate: 48000,
        exportChannelCount: 2,
        renderedAtIso: '2026-11-16T14:00:00.000Z',
      },
    }),
    purgeTemporaryPcmCacheBetweenFiles: async () => {
      purgeCalls++;
    },
    onQueueUpdated: () => {},
  });

  assert.equal(purgeCalls, 5); // +2 approved files exported
  assert.equal(stage2Result[0].status, 'COMPLETED_VALIDATED');
  assert.equal(stage2Result[1].status, 'FAILED_ISOLATED');
  assert.equal(stage2Result[2].status, 'COMPLETED_VALIDATED');
});
