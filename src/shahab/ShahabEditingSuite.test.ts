import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShahabAudioIntelligenceEngine } from './ShahabAudioIntelligenceEngine.ts';
import {
  ShahabEditorialPlannerEngine,
  SHAHAB_EDITORIAL_PROFILES,
  detectEditPlanConflicts,
} from './ShahabEditorialPlannerEngine.ts';
import { ShahabRenderEngine, independentlyDecodeWav } from './ShahabRenderEngine.ts';
import { buildControlledEditingPodcastFixture } from './ShahabEditingSuiteArtifacts.ts';
import { SHAHABFrozenModelAdapter, decodeWavToMono16k } from './ShahabZipformerEngine.ts';

describe('SHAHAB-028 — Acoustic Scene Intelligence & Temporal Audio Structure', () => {
  it('detects multi-label simultaneous events, clipping, dropout, quiet speech protection, and stereo imbalance honestly', () => {
    const engine = new ShahabAudioIntelligenceEngine(process.cwd());
    const caps = engine.getCapabilities();
    assert.equal(caps.streamingCapability, 'INCREMENTAL_WINDOW_ANALYSIS');
    assert.equal(caps.neuralAudioEventClassifierInstalled, false);
    assert.equal(caps.redLineGuardrails.neverInfersEmotionOrPsychology, true);
    assert.equal(caps.redLineGuardrails.neverFabricatesOverallQualityScore, true);

    const fixture = buildControlledEditingPodcastFixture(16000);
    const res = engine.analyzeAudioScene({
      audioId: 'test-audio-028',
      sampleRateHz: fixture.sampleRateHz,
      channelBuffers: fixture.channels,
      transcriptSpansSec: fixture.transcriptSpansSec,
      externalOverlapRegionsSec: fixture.overlapRegionsSec,
    });

    assert.equal(res.qualityDiagnostics.universalQualityScoreFabricated, false);
    assert.ok(res.events.some((e) => e.eventType === 'SPEECH_ACTIVITY'));
    assert.ok(res.events.some((e) => e.eventType === 'LONG_SILENCE'));
    assert.ok(res.events.some((e) => e.eventType === 'CLIPPING'));
    assert.ok(res.events.some((e) => e.eventType === 'SIGNAL_DROPOUT'));
    assert.ok(res.events.some((e) => e.eventType === 'OVERLAPPING_SPEECH'));
    assert.ok(res.overlappingEventPairsCount > 0, 'Must support simultaneous overlapping events');
    assert.equal(res.qualityDiagnostics.flatTopEventCount >= 1, true);
    assert.equal(res.qualityDiagnostics.signalDropoutCount >= 1, true);
    assert.ok(res.events.every((e) => e.calibratedProbabilityAvailable === false));

    // Reference evaluation harness
    const evalRep = engine.evaluateAgainstReference(res.events, fixture.referenceEvents, 0.35);
    assert.ok(evalRep.f1 >= 0.75, `Expected strong F1 on controlled fixture, got ${evalRep.f1}`);

    // Stereo channel imbalance detection
    const sr = 16000;
    const chL = new Float32Array(sr);
    const chR = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      const s = 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr);
      chL[i] = s;
      chR[i] = s * 0.1; // ~12 dB imbalance
    }
    const imb = engine.analyzeAudioScene({
      audioId: 'test-imbalance-028',
      sampleRateHz: sr,
      channelBuffers: [chL, chR],
    });
    assert.ok(imb.events.some((e) => e.eventType === 'CHANNEL_IMBALANCE'));
    assert.ok((imb.qualityDiagnostics.channelImbalanceDb ?? 0) >= 10);

    // Untranscribed speech coverage cross-check (NEVER treats untranscribed speech as silence)
    const cov = engine.analyzeAudioScene({
      audioId: 'test-cov-028',
      sampleRateHz: fixture.sampleRateHz,
      channelBuffers: fixture.channels,
      transcriptSpansSec: [fixture.transcriptSpansSec[0]], // omit 2nd & 3rd speech segments
    });
    assert.equal(cov.coverageCrossCheck.status, 'UNTRANSCRIBED_SPEECH_DETECTED');
    assert.ok(cov.coverageCrossCheck.untranscribedSpeechRanges.length >= 1);

    engine.dispose();
  });
});

describe('SHAHAB-029 — Transcript-Aware Editorial Intelligence & Edit Decision Planner', () => {
  it('supports all 9 profiles, Persian emphasis shielding, conflict/cycle detection, stale invalidation & approval lifecycle', () => {
    const audioIntel = new ShahabAudioIntelligenceEngine(process.cwd());
    const planner = new ShahabEditorialPlannerEngine();
    assert.equal(Object.keys(SHAHAB_EDITORIAL_PROFILES).length, 9);

    const fixture = buildControlledEditingPodcastFixture(16000);
    const scene = audioIntel.analyzeAudioScene({
      audioId: 'test-audio-029',
      sourceRevisionId: 'src_rev_29',
      sampleRateHz: fixture.sampleRateHz,
      channelBuffers: fixture.channels,
      transcriptSpansSec: fixture.transcriptSpansSec,
      externalOverlapRegionsSec: fixture.overlapRegionsSec,
    });

    const verbatim = planner.generateEditPlan({
      projectId: 'p1',
      audioId: scene.audioId,
      sourceRevisionId: scene.sourceRevisionId,
      profileId: 'VERBATIM_PRESERVATION',
      audioScene: scene,
      transcriptText: fixture.transcriptText,
      wordTimings: fixture.wordTimings,
    });
    assert.equal(
      verbatim.operations.some((o) => o.operationType === 'TRIM_SILENCE_OR_PAUSE' || o.operationType === 'REMOVE_FILLER_CANDIDATE'),
      false,
      'VERBATIM_PRESERVATION must not propose silence or filler cuts',
    );

    const plan = planner.generateEditPlan({
      projectId: 'p1',
      audioId: scene.audioId,
      sourceRevisionId: scene.sourceRevisionId,
      profileId: 'PODCAST_EDITING',
      audioScene: scene,
      transcriptText: fixture.transcriptText,
      wordTimings: fixture.wordTimings,
    });

    assert.ok(plan.operations.some((o) => o.operationType === 'TRIM_SILENCE_OR_PAUSE'));
    assert.ok(plan.operations.some((o) => o.operationType === 'REMOVE_FILLER_CANDIDATE' && o.affectedText === 'ام'));
    const marker = plan.operations.find((o) => o.operationType === 'REMOVE_FILLER_CANDIDATE' && o.affectedText === 'یعنی');
    assert.ok(marker, 'Must detect context-sensitive Persian discourse marker');
    assert.equal(marker.riskLevel, 'HIGH_RISK');
    assert.equal(marker.automationEligibility, 'HUMAN_REVIEW_REQUIRED');

    // Immediate stutter ("ما ما") detected, while rhetorical emphasis ("خیلی خیلی") is NOT misflagged as repetition!
    assert.ok(plan.operations.some((o) => o.operationType === 'REMOVE_REPETITION_CANDIDATE' && o.affectedText === 'ما'));
    assert.equal(
      plan.operations.some((o) => o.operationType === 'REMOVE_REPETITION_CANDIDATE' && o.affectedText === 'خیلی'),
      false,
      'Persian emphasis reduplication ("خیلی خیلی") must not be misflagged as stutter',
    );

    // Approve, Reject (preserving history), Protect Range, and Stale Invalidation
    const pauseOp = plan.operations.find((o) => o.operationType === 'TRIM_SILENCE_OR_PAUSE')!;
    const approved = planner.approveEditOperation(plan.planId, pauseOp.operationId, 'tester');
    assert.equal(approved.planRevision, plan.planRevision + 1);
    assert.equal(approved.summary.approvedCutCount, 1);

    const rejected = planner.rejectEditOperation(approved.planId, marker.operationId, 'Intentional emphasis', 'tester');
    const rejOp = rejected.operations.find((o) => o.operationId === marker.operationId)!;
    assert.equal(rejOp.approvalState, 'USER_REJECTED');
    assert.equal(rejOp.rejectionHistory.length, 1);

    const protectedPlan = planner.protectSourceRange(rejected.planId, {
      startSample: pauseOp.sourceRange.startSample,
      endSample: pauseOp.sourceRange.endSample,
      reason: 'Lock pause for dramatic pacing',
    });
    assert.throws(
      () => planner.approveEditOperation(protectedPlan.planId, pauseOp.operationId, 'tester'),
      /PROTECTED_RANGE_VIOLATION/,
    );

    // Cyclic dependency detection check
    const fakeOps = [
      { ...pauseOp, operationId: 'a', dependsOnOperationIds: ['b'] },
      { ...pauseOp, operationId: 'b', sourceRange: { ...pauseOp.sourceRange, startSample: 100, endSample: 200 }, dependsOnOperationIds: ['a'] },
    ];
    const confs = detectEditPlanConflicts(fakeOps, [], fixture.totalFrames);
    assert.ok(confs.some((c) => c.conflictType === 'CYCLIC_DEPENDENCY'));

    const stale = planner.invalidatePlansOnDependencyChange(scene.audioId, 'Source audio replaced');
    assert.equal(stale[0].validityState, 'STALE_DEPENDENCY_CHANGED');

    planner.dispose();
    audioIntel.dispose();
  });
});

describe('SHAHAB-030 — Non-Destructive Audio Render Engine & Precision Export', () => {
  it('rejects unapproved/stale/unsupported/path-escape renders and verifies stereo bit-exact PCM32F + PCM16 + crossfades', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-030-test-'));
    try {
      const audioIntel = new ShahabAudioIntelligenceEngine(process.cwd());
      const planner = new ShahabEditorialPlannerEngine();
      const renderEngine = new ShahabRenderEngine(tmpDir);

      const fixture = buildControlledEditingPodcastFixture(16000);
      const scene = audioIntel.analyzeAudioScene({
        audioId: 'test-audio-030',
        sourceRevisionId: 'src_rev_30',
        sampleRateHz: fixture.sampleRateHz,
        channelBuffers: fixture.channels,
        transcriptSpansSec: fixture.transcriptSpansSec,
        externalOverlapRegionsSec: fixture.overlapRegionsSec,
      });

      const unapprovedPlan = planner.generateEditPlan({
        projectId: 'p1',
        audioId: scene.audioId,
        sourceRevisionId: scene.sourceRevisionId,
        profileId: 'PODCAST_EDITING',
        audioScene: scene,
        transcriptText: fixture.transcriptText,
        wordTimings: fixture.wordTimings,
      });

      // 1. Unapproved plan rejected at execution boundary
      assert.throws(
        () =>
          renderEngine.submitFinalRender({
            plan: unapprovedPlan,
            expectedSourceRevisionId: scene.sourceRevisionId,
            expectedSourcePcmSha256: scene.sourcePcmSha256,
            sourceChannels: fixture.channels,
            sampleRateHz: fixture.sampleRateHz,
            exportFormat: 'WAV_PCM_32F',
          }),
        /UNAPPROVED_EDIT_PLAN_REJECTED/,
      );

      // Approve pause trim
      const pauseOp = unapprovedPlan.operations.find((o) => o.operationType === 'TRIM_SILENCE_OR_PAUSE')!;
      const approvedPlan = planner.approveEditOperation(unapprovedPlan.planId, pauseOp.operationId, 'tester');

      // 2. Unsupported format (MP3) rejected without silent downgrade
      assert.throws(
        () =>
          renderEngine.submitFinalRender({
            plan: approvedPlan,
            expectedSourceRevisionId: scene.sourceRevisionId,
            expectedSourcePcmSha256: scene.sourcePcmSha256,
            sourceChannels: fixture.channels,
            sampleRateHz: fixture.sampleRateHz,
            exportFormat: 'MP3',
          }),
        /UNSUPPORTED_EXPORT_FORMAT/,
      );

      // 3. Path traversal rejected
      assert.throws(
        () =>
          renderEngine.submitFinalRender({
            plan: approvedPlan,
            expectedSourceRevisionId: scene.sourceRevisionId,
            expectedSourcePcmSha256: scene.sourcePcmSha256,
            sourceChannels: fixture.channels,
            sampleRateHz: fixture.sampleRateHz,
            exportFormat: 'WAV_PCM_32F',
            outputFilePath: path.join(tmpDir, '..', 'escape.wav'),
          }),
        /PATH_TRAVERSAL_REJECTED/,
      );

      // 4. Verified stereo WAV_PCM_32F final render with EQUAL_POWER crossfade + independent WAV reopen
      const outWav = path.join(tmpDir, 'verified_stereo_32f.wav');
      const finalRes = renderEngine.submitFinalRender({
        plan: approvedPlan,
        expectedSourceRevisionId: scene.sourceRevisionId,
        expectedSourcePcmSha256: scene.sourcePcmSha256,
        sourceChannels: fixture.channels,
        sampleRateHz: fixture.sampleRateHz,
        exportFormat: 'WAV_PCM_32F',
        transitionCurve: 'EQUAL_POWER',
        defaultCrossfadeMs: 12,
        outputFilePath: outWav,
      });

      assert.equal(finalRes.validation.status, 'RENDER_VALIDATED');
      assert.equal(finalRes.validation.sourceHashUnchangedVerified, true);
      assert.equal(finalRes.validation.unmodifiedRegionBitExactVerified, true);
      assert.equal(finalRes.validation.actualChannels, 2, 'Stereo must be preserved without silent downmix');
      assert.equal(finalRes.validation.actualSampleRateHz, 16000);
      assert.ok(finalRes.totalRemovedMs >= 700);
      assert.ok(finalRes.appliedTransitions.length >= 1);
      assert.ok(fs.existsSync(outWav));

      // Independent reopen verification
      const reopened = independentlyDecodeWav(new Uint8Array(fs.readFileSync(outWav)));
      assert.equal(reopened.headerValid, true);
      assert.equal(reopened.channels, 2);
      assert.equal(reopened.totalFrames, finalRes.outputTotalFrames);

      // 5. Verified LINEAR crossfade & WAV_PCM_16 preview
      const prevRes = renderEngine.previewRender({
        plan: approvedPlan,
        expectedSourceRevisionId: scene.sourceRevisionId,
        expectedSourcePcmSha256: scene.sourcePcmSha256,
        sourceChannels: fixture.channels,
        sampleRateHz: fixture.sampleRateHz,
        exportFormat: 'WAV_PCM_16',
        transitionCurve: 'LINEAR',
        defaultCrossfadeMs: 10,
      });
      assert.equal(prevRes.validation.status, 'RENDER_VALIDATED');
      assert.equal(prevRes.appliedTransitions[0].curveType, 'LINEAR');

      // 6. Clean cancellation via AbortSignal
      const ac = new AbortController();
      ac.abort();
      const cancelled = renderEngine.previewRender({
        plan: approvedPlan,
        expectedSourceRevisionId: scene.sourceRevisionId,
        expectedSourcePcmSha256: scene.sourcePcmSha256,
        sourceChannels: fixture.channels,
        sampleRateHz: fixture.sampleRateHz,
        exportFormat: 'WAV_PCM_16',
        abortSignal: ac.signal,
      });
      assert.equal(cancelled.checkpointState, 'CANCELLED_CLEANLY');

      renderEngine.dispose();
      planner.dispose();
      audioIntel.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Mounted SHAHAB Persian Zipformer-Transducer Real Local Inference Smoke Test', () => {
  it(
    'loads SHA-256 verified INT8 ONNX weights and transcribes real Persian sample.wav locally',
    { skip: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'sample.wav'].every((name) => fs.existsSync(path.join(process.cwd(), 'models/persian-zipformer-transducer/1.0.0', name))) ? false : 'Pinned Zipformer model artifacts and Persian sample are provisioned only in the model-smoke workflow' },
    async () => {
    const modelDir = path.resolve(process.cwd(), 'models', 'persian-zipformer-transducer', '1.0.0');
    const sampleWav = path.join(modelDir, 'sample.wav');
    assert.ok(fs.existsSync(sampleWav), 'Pinned sample.wav must exist on disk');

    const adapter = new SHAHABFrozenModelAdapter({ modelDir });
    const immut = adapter.verifyWeightImmutability();
    assert.equal(immut.immutable, true, `SHA-256 mismatch: ${immut.mismatches.join(', ')}`);

    await adapter.initializeRuntime();
    const { pcm16k } = decodeWavToMono16k(fs.readFileSync(sampleWav));
    // Transcribe first 6 seconds for fast CI verification
    const clip = pcm16k.subarray(0, Math.min(pcm16k.length, 16000 * 6));
    const enc = await adapter.encodeAudio({ pcm16k: clip, segmentId: 'smoke_6s', useCache: true });
    const hyp = await adapter.decodeFromEncoderOutput({
      encoderOutput: enc.encoderOutput,
      policy: adapter.policyManager.getPolicy('BALANCED'),
    });
    assert.ok(hyp.rawText.trim().length > 5, 'Real Persian transcription must be non-empty');
    assert.ok(/[\u0600-\u06FF]/.test(hyp.rawText), `Expected Persian script output, got: ${hyp.rawText}`);
    await adapter.dispose();
  });
});
