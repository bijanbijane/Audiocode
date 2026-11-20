import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportTranscriptContent,
  StudioWorkflowController,
  TranscriptVersionRecord,
} from './StudioWorkflowController';
import {
  assessSemanticChangeRisk,
  createPersianTranscriptDocument,
  PersianAsrCorrectionCandidate,
  TranscriptTransformationEngine,
} from '../persian-linguistics';
import { AudioRenderEngine } from '../audio-renderer';

test('exportTranscriptContent formats SRT timestamps with safe millisecond rollover (never emits ,1000)', () => {
  const version: TranscriptVersionRecord = {
    versionId: 'tr_v1_test',
    versionNumber: 1,
    kind: 'USER_CORRECTED',
    createdAtMs: 1_700_000_000_000,
    changeSummary: 'test',
    segments: [
      {
        segmentId: 'seg_1',
        trackId: 'track-host',
        speakerLabel: 'میزبان',
        startSec: 1.9996,
        endSec: 59.9997,
        rawText: 'سلام دنیا',
        editedText: 'سلام دنیا',
        normalizedText: 'سلام دنیا',
        tokenIds: ['tok-1'],
        alignmentQuality: 'FORCED_ALIGNED',
        alignmentConfidence: 0.98,
      },
    ],
  };

  const exported = exportTranscriptContent({
    version,
    layer: 'user_corrected',
    format: 'srt',
    projectName: 'test-podcast',
  });

  assert.match(exported.content, /00:00:02,000 --> 00:01:00,000/);
  assert.doesNotMatch(exported.content, /,1000/);
});

test('StudioWorkflowController.startRender rejects concurrent duplicate calls while QUEUED', async () => {
  let resolveRender!: () => void;
  const renderGate = new Promise<void>((resolve) => {
    resolveRender = resolve;
  });

  const fakeEngine = {
    render: async () => {
      await renderGate;
      return {
        renderId: 'rnd_test',
        state: 'COMPLETED' as const,
        ok: true,
        plan: null,
        output: null,
        outputArtifact: null,
        outputBytes: new Uint8Array([1, 2, 3, 4]),
        preValidation: {
          phase: 'PRE_RENDER' as const,
          passed: true,
          errorCount: 0,
          warningCount: 0,
          failures: [],
        },
        postValidation: {
          phase: 'POST_RENDER' as const,
          passed: true,
          errorCount: 0,
          warningCount: 0,
          failures: [],
        },
        boundaryChecks: [],
        crossfadeResults: [],
        checkpoint: null,
        sourceDurationSec: 1,
        outputDurationSec: 1,
        removedDurationSec: 0,
        wallClockMs: 5,
        realTimeFactor: 0.01,
        peakReservedBytes: 1024,
        sourceImmutableVerified: true,
        edlImmutableVerified: true,
        appliedProposalIds: [],
        failureReason: null,
      };
    },
    resumeFromCheckpoint: async () => {
      throw new Error('not used');
    },
  } as unknown as AudioRenderEngine;

  const ctrl = new StudioWorkflowController({ renderEngine: fakeEngine });
  const pcm = new Float32Array(48_000);
  ctrl.openProject({
    projectId: 'proj_dup_guard',
    projectName: 'Dup Guard Test',
    sourceAudio: {
      sourceAudioId: 'src_1',
      sourceAudioHash: 'hash_12345678',
      fileName: 'test.wav',
      format: 'wav',
      sampleRate: 48000,
      channelCount: 1,
      bitDepth: 32,
      totalSamples: pcm.length,
      durationSec: 1,
      fileSizeBytes: pcm.byteLength,
      importStatus: 'VALIDATED',
      isDemoFixture: false,
    },
  });

  await ctrl.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-host',
    pcmMono: pcm,
    sampleRate: 48000,
    wordTokens: [],
  });

  const config = {
    encoding: 'pcm16' as const,
    container: 'wav' as const,
    targetSampleRate: 48000 as const,
    chunkSizeSamples: 8192,
    defaultCrossfadeMs: 10,
  };

  // Start first render -> synchronously transitions to QUEUED
  const firstPromise = ctrl.startRender({ pcmChannels: [pcm], config });
  assert.equal(ctrl.getState().renderState, 'QUEUED');

  // Second concurrent call while still QUEUED MUST be rejected with null
  const duplicateResult = await ctrl.startRender({ pcmChannels: [pcm], config });
  assert.equal(duplicateResult, null);

  resolveRender();
  const firstResult = await firstPromise;
  assert.equal(firstResult?.ok, true);
});

test('TranscriptTransformationEngine.revertCandidateById reverts only the targeted accepted candidate', () => {
  const engine = new TranscriptTransformationEngine();
  const doc0 = createPersianTranscriptDocument({
    documentId: 'doc_revert_target',
    rawAsrText: 'می روم به خانه ها',
    sampleRate: 48000,
  });

  const tok0 = doc0.tokens[0];
  const tok3 = doc0.tokens[3];
  assert.ok(tok0 && tok3);

  const candA: PersianAsrCorrectionCandidate = {
    candidateId: 'cand_A',
    sourceTranscriptVersion: doc0.version,
    tokenIds: [tok0.tokenId],
    originalText: tok0.readableText,
    proposedText: 'می‌روم',
    category: 'ORTHOGRAPHY_READABLE',
    evidenceStrength: 'STRONG_EVIDENCE',
    acousticEvidenceAvailable: false,
    acousticConfidence: null,
    linguisticEvidence: 'ZWNJ normalization',
    semanticRisk: assessSemanticChangeRisk({
      originalText: tok0.readableText,
      proposedText: 'می‌روم',
      category: 'ORTHOGRAPHY_READABLE',
    }),
    alignmentImpact: 'NONE',
    epistemicSource: 'DETERMINISTIC_NORMALIZATION',
    provenanceModule: 'test',
    sourceStartSample: null,
    sourceEndSample: null,
    status: 'PROPOSED',
  };

  const applyA = engine.applyAcceptedCandidate({ document: doc0, candidate: candA });
  assert.equal(applyA.applied, true);

  const candB: PersianAsrCorrectionCandidate = {
    ...candA,
    candidateId: 'cand_B',
    sourceTranscriptVersion: applyA.document.version,
    tokenIds: [tok3.tokenId],
    originalText: tok3.readableText,
    proposedText: 'خانه‌ها',
  };

  const applyB = engine.applyAcceptedCandidate({ document: applyA.document, candidate: candB });
  assert.equal(applyB.applied, true);

  // Revert cand_A specifically (NOT cand_B, which was applied last)
  const revertA = engine.revertCandidateById(applyB.document, 'cand_A');
  assert.equal(revertA.reverted, true);
  assert.equal(revertA.revertedTokenId, tok0.tokenId);
  assert.equal(revertA.restoredReadableText, tok0.readableText);

  const afterTok0 = revertA.document.tokens.find((t) => t.tokenId === tok0.tokenId);
  const afterTok3 = revertA.document.tokens.find((t) => t.tokenId === tok3.tokenId);
  assert.equal(afterTok0?.readableText, tok0.readableText, 'Targeted cand_A must be reverted');
  assert.equal(afterTok3?.readableText, 'خانه‌ها', 'Unrelated cand_B must stay intact');
});

test('StudioWorkflowController.syncTranscriptFromSegments preserves raw baseline immutability and tracks subsequent versions', () => {
  const ctrl = new StudioWorkflowController();
  ctrl.openProject({
    projectId: 'proj_sync_transcript',
    projectName: 'Sync Transcript Test',
    sourceAudio: {
      sourceAudioId: 'src_sync_1',
      sourceAudioHash: 'hash_sync_123',
      fileName: 'audio.wav',
      format: 'wav',
      sampleRate: 48000,
      channelCount: 1,
      bitDepth: 32,
      totalSamples: 48_000,
      durationSec: 1,
      fileSizeBytes: 192_000,
      importStatus: 'VALIDATED',
      isDemoFixture: false,
    },
    nowMs: 1_700_000_000_000,
  });

  // Initial raw upload has no transcript yet
  assert.equal(ctrl.getState().rawTranscriptVersion, null);
  assert.equal(ctrl.getState().transcriptVersions.length, 0);

  // First ASR sync establishes immutable raw version
  const rawVer = ctrl.syncTranscriptFromSegments({
    establishRawIfEmpty: true,
    changeSummary: 'ASR initial',
    nowMs: 1_700_000_001_000,
    segments: [
      {
        segmentId: 'seg_1',
        trackId: 'track-host',
        speakerLabel: 'میزبان',
        startSec: 0,
        endSec: 0.9,
        rawText: 'سلام دنیا',
        editedText: 'سلام دنیا',
        normalizedText: 'سلام دنیا',
        tokenIds: ['t1', 't2'],
        alignmentQuality: 'ASR_TIMESTAMP',
        alignmentConfidence: 0.92,
      },
    ],
  });
  assert.equal(rawVer?.kind, 'RAW_ASR_IMMUTABLE');
  assert.equal(ctrl.getState().transcriptVersions.length, 1);

  // Subsequent edit appends USER_CORRECTED without mutating rawTranscriptVersion
  const v2 = ctrl.syncTranscriptFromSegments({
    changeSummary: 'Normalized punctuation',
    nowMs: 1_700_000_002_000,
    segments: [
      {
        segmentId: 'seg_1',
        trackId: 'track-host',
        speakerLabel: 'میزبان',
        startSec: 0,
        endSec: 0.9,
        rawText: 'سلام دنیا',
        editedText: 'سلام، دنیا!',
        normalizedText: 'سلام، دنیا!',
        tokenIds: ['t1', 't2'],
        alignmentQuality: 'ASR_TIMESTAMP',
        alignmentConfidence: 0.92,
      },
    ],
  });
  assert.equal(v2?.kind, 'USER_CORRECTED');
  assert.equal(ctrl.getState().transcriptVersions.length, 2);
  assert.equal(ctrl.getState().rawTranscriptVersion?.segments[0]?.rawText, 'سلام دنیا');
  assert.equal(ctrl.getActiveTranscriptVersion()?.segments[0]?.editedText, 'سلام، دنیا!');
});

test('StudioWorkflowController.startRender recovers cleanly to FAILED if renderEngine rejects and allows subsequent renders', async () => {
  let attempt = 0;
  const flakyEngine = {
    render: async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('SIMULATED_IO_CRASH');
      }
      return {
        renderId: 'rnd_recovered',
        state: 'COMPLETED' as const,
        ok: true,
        plan: null,
        output: null,
        outputArtifact: null,
        outputBytes: new Uint8Array([1, 2, 3, 4]),
        preValidation: {
          phase: 'PRE_RENDER' as const,
          passed: true,
          errorCount: 0,
          warningCount: 0,
          failures: [],
        },
        postValidation: {
          phase: 'POST_RENDER' as const,
          passed: true,
          errorCount: 0,
          warningCount: 0,
          failures: [],
        },
        boundaryChecks: [],
        crossfadeResults: [],
        checkpoint: null,
        sourceDurationSec: 1,
        outputDurationSec: 1,
        removedDurationSec: 0,
        wallClockMs: 5,
        realTimeFactor: 0.01,
        peakReservedBytes: 1024,
        sourceImmutableVerified: true,
        edlImmutableVerified: true,
        appliedProposalIds: [],
        failureReason: null,
      };
    },
    resumeFromCheckpoint: async () => {
      throw new Error('not used');
    },
  } as unknown as AudioRenderEngine;

  const ctrl = new StudioWorkflowController({ renderEngine: flakyEngine });
  const pcm = new Float32Array(48_000);
  ctrl.openProject({
    projectId: 'proj_render_recover',
    projectName: 'Render Recovery Test',
    sourceAudio: {
      sourceAudioId: 'src_rec_1',
      sourceAudioHash: 'hash_rec_1234',
      fileName: 'test.wav',
      format: 'wav',
      sampleRate: 48000,
      channelCount: 1,
      bitDepth: 32,
      totalSamples: pcm.length,
      durationSec: 1,
      fileSizeBytes: pcm.byteLength,
      importStatus: 'VALIDATED',
      isDemoFixture: false,
    },
  });

  await ctrl.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-host',
    pcmMono: pcm,
    sampleRate: 48000,
    wordTokens: [],
  });

  const config = {
    encoding: 'pcm16' as const,
    container: 'wav' as const,
    targetSampleRate: 48000 as const,
    chunkSizeSamples: 8192,
    defaultCrossfadeMs: 10,
  };

  const first = await ctrl.startRender({ pcmChannels: [pcm], config });
  assert.equal(first, null);
  assert.equal(ctrl.getState().renderState, 'FAILED');
  assert.equal(ctrl.getState().exportStatus, 'FAILED');
  assert.equal(ctrl.getState().exportError, 'SIMULATED_IO_CRASH');

  // Must NOT be permanently locked out from subsequent renders
  const second = await ctrl.startRender({ pcmChannels: [pcm], config });
  assert.equal(second?.ok, true);
  assert.equal(ctrl.getState().renderState, 'COMPLETED');
  assert.equal(ctrl.getState().exportStatus, 'VALIDATED_READY');
});

test('TranscriptTransformationEngine.revertCandidateById returns all restoredTokens for multi-token absorbed merges', () => {
  const engine = new TranscriptTransformationEngine();
  const doc0 = createPersianTranscriptDocument({
    documentId: 'doc_multitok_revert',
    rawAsrText: 'می روم خانه',
    sampleRate: 48000,
  });

  const [tok0, tok1] = doc0.tokens;
  assert.ok(tok0 && tok1);

  const mergeCand: PersianAsrCorrectionCandidate = {
    candidateId: 'cand_merge_mi_ravam',
    sourceTranscriptVersion: doc0.version,
    tokenIds: [tok0.tokenId, tok1.tokenId],
    originalText: 'می روم',
    proposedText: 'می‌روم',
    category: 'ORTHOGRAPHY_READABLE',
    evidenceStrength: 'STRONG_EVIDENCE',
    acousticEvidenceAvailable: false,
    acousticConfidence: null,
    linguisticEvidence: 'ZWNJ prefix merge',
    semanticRisk: assessSemanticChangeRisk({
      originalText: 'می روم',
      proposedText: 'می‌روم',
      category: 'ORTHOGRAPHY_READABLE',
    }),
    alignmentImpact: 'NONE',
    epistemicSource: 'DETERMINISTIC_NORMALIZATION',
    provenanceModule: 'test',
    sourceStartSample: null,
    sourceEndSample: null,
    status: 'PROPOSED',
  };

  const applied = engine.applyAcceptedCandidate({ document: doc0, candidate: mergeCand });
  assert.equal(applied.applied, true);
  assert.equal(applied.document.tokens[0].readableText, 'می‌روم');
  assert.equal(applied.document.tokens[1].readableText, '');

  const reverted = engine.revertCandidateById(applied.document, mergeCand.candidateId);
  assert.equal(reverted.reverted, true);
  assert.deepEqual(reverted.restoredTokens, [
    { tokenId: tok0.tokenId, readableText: 'می' },
    { tokenId: tok1.tokenId, readableText: 'روم' },
  ]);
  assert.equal(reverted.document.tokens[0].readableText, 'می');
  assert.equal(reverted.document.tokens[1].readableText, 'روم');
});


