import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatBytesDual,
  normalizePersianTextDeterministic,
} from './ShahabContracts.ts';
import { createBlankImplementationState, ShahabEvidenceStore } from './ShahabEvidenceStore.ts';
import { inspectOnnxModelFile, writeStrippedOnnxVariant } from './ShahabOnnxInspector.ts';
import {
  evaluateDualTrackSample,
  detectDatasetLeakage,
  type ShahabDatasetManifest,
} from './ShahabBenchmarkAndErrorEngine.ts';
import {
  SHAHABPersianMemoryManager,
  SHAHABContextualVocabularyProvider,
  SHAHABFalseInsertionGuard,
} from './ShahabPersianMemoryAndContext.ts';
import { SHAHABFrozenModelAdapter, decodeWavToMono16k } from './ShahabZipformerEngine.ts';
import { SHAHAB_NEURAL_CORE_IDENTITY } from './ShahabEngineUnified.ts';
import { evaluateNeuralIndependenceDecision } from './ShahabFieldValidation.ts';
import { SHAHABNeuralInheritanceManager } from './ShahabNeuralGovernance.ts';
import { SHAHABRuntimeHardening, SHAHABArtifactIntegrityVerifier } from './ShahabReleaseHardening.ts';
import {
  assertNoSensitiveOperationalPayload,
  SHAHABUpdateLifecycleManager,
  SHAHABRegressionAnalyzer,
} from './ShahabOperationsGovernance.ts';
import {
  SHAHABResourceGuard,
  SHAHABJobStateMachine,
  SHAHABExecutionIsolationGuard,
  runIsolatedFaultInjectionSuite,
} from './ShahabResilienceEngine.ts';
import { computePercentileSummary, computeRtf } from './ShahabPerformanceEngine.ts';
import {
  auditZipformerStreamingCapability,
  SHAHABStreamingStateMachine,
  SHAHABBoundedAudioQueue,
  reconcileWindowWordsRepetitionPreserving,
  SHAHABEditorStreamingBridge,
} from './ShahabStreamingEngine.ts';
import {
  discoverCoarsePrivacySafeCapabilities,
  SHAHABCapabilityNegotiationEngine,
} from './ShahabRuntimeConformance.ts';
import {
  auditPersianOrthographyTransformation,
  guardUncalibratedDecoderScore,
  evaluateVerbatimPreservation,
  SHAHAB_PERSIAN_ERROR_TAXONOMY_18,
  classifyPersianMismatch,
  SHAHABReferenceAdjudicationWorkflow,
} from './ShahabPersianFidelity.ts';
import { runShahab020CompactModelResearch } from './ShahabCompactModelResearch.ts';
import {
  createShahabSdkEngine,
  SHAHAB_SDK_API_VERSION,
  ShahabSdkError,
} from './sdk/ShahabSdk.ts';
import {
  AvapardazShahabAdapter,
  AVAPARDAZ_FLICKS_PER_SECOND,
} from './adapters/AvapardazShahabAdapter.ts';
import {
  AdobeAuditionHostAdapter,
  AuditionLocalBridgeSecurityGuard,
  ADOBE_AUDITION_OFFICIAL_CAPABILITY_REGISTER,
  formatAuditionDecimalTime,
} from './adapters/AdobeAuditionHostAdapter.ts';

const ROOT = process.cwd();
const MODEL_DIR = path.join(ROOT, 'models', 'persian-zipformer-transducer', '1.0.0');
const SAMPLE_WAV = path.join(MODEL_DIR, 'sample.wav');
const DOCS_DIR = path.join(ROOT, 'docs', 'shahab');
const MODEL_ARTIFACTS_AVAILABLE = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
  'sample.wav',
].every((name) => fs.existsSync(path.join(MODEL_DIR, name)));
const MODEL_SMOKE_SKIP = 'Pinned Zipformer model artifacts and Persian sample are provisioned only in the model-smoke workflow';

test(
  'SHAHAB-002..004: Evidence store, dual byte formatting, Persian normalization & ONNX protobuf audit',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, () => {
  const bytes = formatBytesDual(115_768_868);
  assert.equal(bytes.mib, '110.41 MiB');
  assert.equal(bytes.mb, '115.77 MB');
  assert.equal(normalizePersianTextDeterministic('كتاب عربي').normalized, 'کتاب عربی');
  assert.equal(SHAHAB_NEURAL_CORE_IDENTITY, 'INHERITED-PERSIAN-ASR-CORE');

  const encStats = inspectOnnxModelFile(path.join(MODEL_DIR, 'encoder.int8.onnx'));
  assert.ok(encStats.nodeCount > 4000);
  assert.equal(encStats.opsetVersion, 14);
  assert.ok(encStats.inputs.some((i) => i.name === 'x'));
  assert.ok(encStats.outputs.some((o) => o.name === 'encoder_out'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-store-test-'));
  try {
    const store = new ShahabEvidenceStore(tmpDir);
    const blank = createBlankImplementationState({
      capturedAtUtc: new Date().toISOString(),
      osKernel: process.platform,
      osPrettyName: 'Linux Test',
      cpuArch: process.arch,
      cpuCores: 4,
      cpuModel: 'Test CPU',
      totalRamBytes: 8 * 1024 ** 3,
      availableRamBytes: 4 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      diskAvailableBytes: 50 * 1024 ** 3,
      gpuPresent: false,
      gpuModel: null,
      vramBytes: null,
      cudaAvailable: false,
      nodeVersion: process.version,
      npmVersion: '10.0.0',
      bunVersion: null,
      pythonVersion: null,
      pythonOnnxRuntimeProviders: [],
      jsOnnxRuntimeWebVersion: '1.31.1',
      sherpaOnnxBinaryPresent: false,
      nativeBuildTools: {},
      gitBranch: null,
      gitCommitSha: null,
      gitDirtyFileCount: null,
      gitStatusNote: 'test',
    });
    assert.ok('SHAHAB-021' in blank.missions);
    assert.ok('SHAHAB-024' in blank.missions);
    store.writeStateAtomic(blank);
    assert.equal(store.readState()?.missions['SHAHAB-024'].status, 'NOT_STARTED');

    const evt = store.appendEvent({
      missionId: 'SHAHAB-002',
      taskId: 'UNIT-TEST',
      eventType: 'UNIT_TEST_EVENT',
      oldValue: null,
      newValue: { ok: true },
      measurementValue: 1,
      measurementUnit: 'test',
      measurementMethod: 'unit_test',
      evidenceSource: 'ShahabProgram.test.ts',
      artifactRef: null,
      modelRevision: null,
      sha256: null,
      environmentId: 'unit-test',
      verificationStatus: 'VERIFIED',
    });
    assert.ok(evt.eventId.length > 5);
    assert.equal(store.readEvents().length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test(
  'SHAHAB-005..007 & SHAHAB-016: Real frozen Zipformer inference, OPT-001/OPT-002 exact parity, and percentile metrics',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, async () => {
  const adapter = new SHAHABFrozenModelAdapter({ modelDir: MODEL_DIR });
  try {
    const immut = adapter.verifyWeightImmutability();
    assert.equal(immut.immutable, true);
    assert.equal(immut.mismatches.length, 0);

    const wavBytes = fs.readFileSync(SAMPLE_WAV);
    const { pcm16k, durationSec } = decodeWavToMono16k(wavBytes);
    assert.ok(durationSec > 10);

    const slice = pcm16k.subarray(0, 16000 * 5);
    const encBase = await adapter.encodeAudio({
      pcm16k: slice,
      segmentId: 'test-opt-base',
      useCache: false,
      optimizationMode: 'BASELINE',
    });
    const encOpt = await adapter.encodeAudio({
      pcm16k: slice,
      segmentId: 'test-opt-cand',
      useCache: false,
      optimizationMode: 'OPTIMIZED',
    });
    const policy = adapter.policyManager.getPolicy('BALANCED');
    const hypBase = await adapter.decodeFromEncoderOutput({
      encoderOutput: encBase.encoderOutput,
      policy,
      optimizationMode: 'BASELINE',
    });
    const hypOpt = await adapter.decodeFromEncoderOutput({
      encoderOutput: encOpt.encoderOutput,
      policy,
      optimizationMode: 'OPTIMIZED',
    });

    assert.ok(hypBase.rawText.trim().length > 0);
    assert.equal(hypOpt.rawText, hypBase.rawText, 'OPT-001 + OPT-002 must maintain exact Persian transcript parity');

    const pct = computePercentileSummary([10, 20, 30, 40, 50], 'ms');
    assert.equal(pct.medianP50, 30);
    assert.equal(computeRtf(500, 5), 0.1);
  } finally {
    await adapter.dispose();
  }
});

test(
  'SHAHAB-SDK: refuses model files that do not match pinned release hashes',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, async () => {
  const tamperedModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-pinned-hash-test-'));
  let sdk: ReturnType<typeof createShahabSdkEngine> | null = null;
  try {
    for (const fileName of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      fs.copyFileSync(path.join(MODEL_DIR, fileName), path.join(tamperedModelDir, fileName));
    }
    fs.appendFileSync(path.join(tamperedModelDir, 'tokens.txt'), '\n# deliberate integrity-test mutation\n');

    sdk = createShahabSdkEngine({ modelDir: tamperedModelDir, docsDir: DOCS_DIR });
    await assert.rejects(
      sdk.initialize(),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Weight immutability check failed') &&
        error.message.includes('tokens.txt SHA-256 mismatch'),
    );
  } finally {
    if (sdk) await sdk.dispose();
    fs.rmSync(tamperedModelDir, { recursive: true, force: true });
  }
});

test('SHAHAB-006 & SHAHAB-008: Dual-track WER/CER, leakage detection, Persian memory & Greedy bias refusal', () => {
  const dual = evaluateDualTrackSample({
    referenceVerbatim: 'شکلات داغ بلژیکی',
    rawHypothesis: 'شکلات داغ بلژيكي',
  });
  assert.ok(dual.trackBNormalized.wer <= dual.trackAVerbatim.wer);

  const manifest: ShahabDatasetManifest = {
    schemaVersion: '1.0.0',
    manifestId: 'test-ds',
    revision: '1.0.0',
    createdAtUtc: new Date().toISOString(),
    immutableFrozenTest: true,
    samples: [
      {
        sampleId: 's1',
        datasetId: 'test-ds',
        datasetRevision: '1.0.0',
        split: 'frozen_test',
        originalSource: 'unit-test',
        license: 'Apache-2.0',
        audioPath: SAMPLE_WAV,
        audioSha256: 'abc',
        durationSec: 12,
        sampleRateHz: 16000,
        speakerId: 'spk1',
        sessionId: 'sess1',
        referenceTranscriptVerbatim: 'سلام',
        transcriptProvenance: 'unit-test',
        annotationStatus: 'HUMAN_VERIFIED',
        speechCategories: ['CLEAN_FORMAL_PERSIAN'],
        recordingConditions: 'clean',
      },
    ],
  };
  assert.equal(detectDatasetLeakage(manifest).clean, true);

  const mem = new SHAHABPersianMemoryManager();
  mem.addEntry({
    term: 'آواپرداز',
    scope: 'PROJECT',
    scopeOwnerId: 'proj-1',
    state: 'USER_CONFIRMED',
    evidenceSource: 'unit-test',
    confirmationMethod: 'direct_user_confirmation',
    vocab: ['▁آواپرداز', '▁آوا', 'پرداز'],
  });
  assert.equal(mem.listAll().length, 1);

  const ctxProvider = new SHAHABContextualVocabularyProvider();
  const greedyRefusal = ctxProvider.buildBiasMap({
    entries: mem.listAll(),
    decodingMethod: 'greedy_search',
    biasScore: 1.5,
  });
  assert.equal(greedyRefusal.supported, false);
  assert.equal(greedyRefusal.biasMap, null);

  const guard = new SHAHABFalseInsertionGuard();
  const audit = guard.evaluate({
    referenceVerbatim: 'شکلات داغ بلژیکی',
    rawBaselineText: 'شکلات داغ بلژیکی',
    contextAssistedText: 'شکلات داغ بلژیکی',
    activeContextTerms: ['آواپرداز'],
  });
  assert.equal(audit.falseInsertionRate, 0);
});

test(
  'SHAHAB-009 & SHAHAB-020: Lossless ONNX strip & honest sub-100 MiB uncompressed protection',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab-strip-test-'));
  try {
    const srcJoiner = path.join(MODEL_DIR, 'joiner.int8.onnx');
    const dstJoiner = path.join(tmpDir, 'joiner.stripped.onnx');
    const stripped = writeStrippedOnnxVariant(srcJoiner, dstJoiner);
    assert.ok(stripped.variantBytes <= stripped.sourceBytes);
    assert.ok(fs.existsSync(dstJoiner));

    const compact = runShahab020CompactModelResearch({
      activeModelTotalBytes: 115_768_868,
      activeModelHash: 'a'.repeat(64),
      variantBTotalBytes: 115_440_316,
      variantBHash: 'b'.repeat(64),
      variantDGzipBytes: 58_360_000,
      measuredColdLoadMs: 500,
      measuredWarmRtf: 0.09,
      measuredPeakRssMiB: 450,
      measuredTrackAWer: 0.4,
      measuredTrackACer: 0.2,
      docsDir: tmpDir,
    });
    assert.equal(compact.sub100MiBRuntimeCandidateAvailable, false);
    assert.equal(compact.activeApprovedModelProtected, true);
    assert.equal(compact.automaticCompactActivationExecuted, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SHAHAB-011..014: Decision A, Teacher Legal Gate, Runtime Hardening, Privacy Guard & Update Lifecycle', () => {
  const decision = evaluateNeuralIndependenceDecision({
    independentRecordingsEvaluated: 1,
    distinctSpeakersEvaluated: 1,
    humanReviewSubmissions: 0,
    cleanMeanTrackAWer: 0.4,
    cleanMeanTrackBWer: 0.35,
    noisyMeanTrackAWer: null,
    gpuAvailable: false,
    packageSizeMiB: 110.41,
    clusters: [],
  });
  assert.equal(decision.decisionCode, 'CONTINUE_FROZEN_WEIGHT_RUNTIME');

  const inheritance = new SHAHABNeuralInheritanceManager();
  const legalList = inheritance.evaluateTeacherLegalGate([
    {
      candidateId: 'cand-nemotron',
      displayName: 'Nemotron ASR Streaming Farsi',
      sourceKind: 'huggingface',
      repoId: 'mehdi-hf/nemotron-asr-streaming-farsi',
      upstreamUrl: 'https://huggingface.co/mehdi-hf/nemotron-asr-streaming-farsi',
      defaultBranch: 'main',
      pinnedRevisionSha: 'abc123',
      revisionStatus: 'VERIFIED',
      architecture: 'Nemotron',
      modelFamily: 'FastConformer',
      reportedParameters: {
        value: null,
        unit: 'parameters',
        method: 'upstream',
        source: 'test',
        timestampUtc: new Date().toISOString(),
        environment: 'test',
        status: 'NOT_MEASURED',
      },
      licenseSpdx: 'other',
      licenseFilePresent: false,
      licenseTextExcerpt: null,
      licenseStatus: 'LEGAL_GATE_REQUIRED',
      legalGateNote: 'Non-permissive license',
      totalRepositoryBytes: null,
      selectedInferencePackageBytes: null,
      fileCount: 0,
      files: [],
      supportedRuntimes: [],
      audioConfig: { sampleRateHz: 16000, channels: 1, featureDim: 80, note: 'test' },
      knownLimitations: [],
      inspectedAtUtc: new Date().toISOString(),
      inspectionStatus: 'VERIFIED',
    },
  ]);
  const nemotronGate = legalList.find((l) => l.repoId === 'mehdi-hf/nemotron-asr-streaming-farsi');
  assert.equal(nemotronGate?.eligibleForShahabTrainingTargets, false);

  const hardening = new SHAHABRuntimeHardening();
  const badBounds = hardening.validateRequestBounds({
    audioBytesLength: 0,
    durationSec: -1,
    sampleRateHz: 1000,
    activeConcurrentJobs: 99,
    requestedBeamPaths: 50,
    requestedRedecodePasses: 10,
  });
  assert.equal(badBounds.allowed, false);
  assert.ok(badBounds.violations.length >= 4);

  assert.throws(() => {
    assertNoSensitiveOperationalPayload({ rawTranscript: 'متن محرمانه کاربر' });
  });

  const upd = new SHAHABUpdateLifecycleManager('SHAHAB-R2.0.0-RC1');
  const stageRes = upd.validateAndStageUpdate({
    manifest: {
      manifestRevision: 'rev-1',
      releaseId: 'SHAHAB-R2.0.1',
      engineVersion: 'SHAHAB-R2.0.1',
      modelVersion: '0408facbcf3f',
      modelRevisionSha: '0408facbcf3f670121def48e0802c395c225d150',
      tokenizerSha256: 'a'.repeat(64),
      artifactFormat: 'ONNX_INT8_STATELESS7',
      artifacts: [{ fileName: 'tokens.txt', bytes: 10, sha256: 'a'.repeat(64) }],
      supportedProviders: ['wasm'],
      minAppVersion: '1.0.0',
      licenseSpdx: 'Apache-2.0',
      signatureBase64: null,
    },
    actualArtifacts: new Map([['tokens.txt', { bytes: 10, sha256: 'a'.repeat(64) }]]),
    currentProvider: 'wasm',
    requireCryptographicSignature: true,
    smokeTestPassed: true,
  });
  assert.equal(stageRes.state, 'UPDATE_BLOCKED');

  const analyzer = new SHAHABRegressionAnalyzer();
  const snapA = {
    releaseId: 'R1',
    modelArtifactHash: 'a'.repeat(64),
    datasetId: 'ds-1',
    datasetRevision: '1.0',
    hardwareProfile: 'linux-x64-cpu',
    runtimeVersion: 'onnxruntime-web@1.31.1',
    sampleCount: 4,
    validReferenceCount: 4,
    excludedSamplesCount: 0,
    trackAWer: 0.4,
    trackACer: 0.2,
    meanRtf: 0.1,
    peakRssBytes: 400_000_000,
  };
  const reg = analyzer.compare(snapA, { ...snapA, releaseId: 'R2' });
  assert.equal(reg.verdict, 'INSUFFICIENT_EVIDENCE');
});

test('SHAHAB-015: ResourceGuard concurrent load serialization, JobStateMachine, Isolation & 11/11 Fault Injection', async () => {
  const guard = new SHAHABResourceGuard({
    processRssSoftLimitBytes: 1_536 * 1024 * 1024,
    maxConcurrentModelLoads: 1,
    maxConcurrentInferenceJobs: 2,
    storageSafetyMarginBytes: 64 * 1024 * 1024,
  });
  let running = 0;
  let peak = 0;
  const results = await Promise.all(
    [1, 2, 3].map((n) =>
      guard.runSerializedModelLoad(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
        return n;
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(results.some((r) => r.serializedWaitOccurred), true);

  const sm = new SHAHABJobStateMachine();
  const created = sm.createJob({
    jobId: 'job-test-1',
    idempotencyKey: 'idem-job-test-1',
    executionMode: 'LOCAL',
    audioSourceId: 'src-1',
    audioContentSha256: 'abc',
    modelId: 'persian-zipformer-transducer-1.0.0',
    tokenizerSha256: 'tok',
    correlationId: 'corr-1',
  });
  assert.equal(created.job.state, 'CREATED');
  assert.equal(sm.transition('job-test-1', 'VALIDATING', { reason: 'start' }).accepted, true);
  assert.equal(sm.transition('job-test-1', 'COMPLETED', { reason: 'illegal-jump' }).accepted, false);

  const iso = new SHAHABExecutionIsolationGuard();
  const blocked = iso.evaluateModeTransition({
    fromMode: 'LOCAL',
    toMode: 'CLOUD',
    userExplicitlyAuthorizedTransfer: false,
    targetRuntimeSupported: true,
    sameLogicalContractVerified: true,
    modelTokenizerCompatible: true,
    capabilityDifferenceDisclosed: true,
    correlationId: 'c1',
  });
  assert.equal(blocked.allowed, false);

  const fi = await runIsolatedFaultInjectionSuite({ modelDir: MODEL_DIR });
  assert.equal(fi.passedScenarios, fi.totalScenarios, `Expected all fault-injection drills to pass (${fi.passedScenarios}/${fi.totalScenarios})`);
});

test(
  'SHAHAB-017: Honest streaming capability audit, 16-state machine, repetition preservation («نه نه») & Editor edit protection',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, () => {
  const audit = auditZipformerStreamingCapability(path.join(MODEL_DIR, 'encoder.int8.onnx'));
  assert.equal(audit.trueStatefulStreamingStatus, 'NOT_SUPPORTED_BY_MODEL');
  assert.equal(audit.selectedStreamingMode, 'INCREMENTAL_WINDOWED_INFERENCE');

  const sm = new SHAHABStreamingStateMachine();
  assert.equal(sm.transition('INITIALIZING', 'boot'), 'INITIALIZING');
  assert.equal(sm.transition('READY', 'ready'), 'READY');
  assert.equal(sm.transition('LISTENING', 'listen'), 'LISTENING');
  assert.throws(() => sm.transition('COMPLETED', 'illegal-direct-complete'));

  const q = new SHAHABBoundedAudioQueue<number>(2);
  assert.equal(q.enqueue(1).enqueued, true);
  assert.equal(q.enqueue(2).enqueued, true);
  const full = q.enqueue(3);
  assert.equal(full.enqueued, false);
  assert.equal(full.backpressured, true);

  const merged = reconcileWindowWordsRepetitionPreserving({
    committedWords: [{ word: 'نه', startSec: 0.2, endSec: 0.45 }],
    windowWords: [
      { word: 'نه', startSec: 0.22, endSec: 0.46 },
      { word: 'نه', startSec: 0.7, endSec: 0.95 },
      { word: 'خوبم', startSec: 1.0, endSec: 1.3 },
    ],
  });
  assert.equal(
    merged.mergedWords.filter((w) => w.word === 'نه').length,
    2,
    'Legitimate Persian repetition «نه نه» at distinct timestamps must be preserved',
  );

  const bridge = new SHAHABEditorStreamingBridge();
  bridge.applyStreamingRevision({
    revisionId: 'r1',
    sessionId: 's1',
    segmentId: 'seg-1',
    revisionType: 'CREATE',
    hypothesisState: 'PROVISIONAL_PARTIAL',
    text: 'سلام دنیا',
    startSec: 0,
    endSec: 1,
    emittedAtMs: Date.now(),
    streamingMode: 'INCREMENTAL_WINDOWED_INFERENCE',
  });
  bridge.applyUserManualEdit('seg-1', 'سلام دنیای ویرایش‌شده');
  const overwriteAttempt = bridge.applyStreamingRevision({
    revisionId: 'r2',
    sessionId: 's1',
    segmentId: 'seg-1',
    revisionType: 'REVISE',
    hypothesisState: 'REVISED_PARTIAL',
    text: 'سلام دنیای بعدی',
    startSec: 0,
    endSec: 1,
    emittedAtMs: Date.now(),
    streamingMode: 'INCREMENTAL_WINDOWED_INFERENCE',
  });
  assert.equal(overwriteAttempt.appliedToEditor, false);
  assert.equal(overwriteAttempt.reason, 'USER_EDIT_PROTECTED');
  assert.equal(bridge.getEffectiveDisplayText('seg-1'), 'سلام دنیای ویرایش‌شده');
});

test('SHAHAB-018: Coarse privacy-safe capabilities & deterministic Capability Negotiation (zero silent Local↔Cloud switch)', () => {
  const caps = discoverCoarsePrivacySafeCapabilities({ cloudEndpointAuthorized: false });
  assert.equal(caps.userAgentParsed, false);
  assert.equal(caps.fingerprintCollected, false);

  const engine = new SHAHABCapabilityNegotiationEngine();
  const blocked = engine.negotiate({
    requestedMode: 'CLOUD_ONLY',
    preferredProvider: 'cloud_api',
    requiredModelId: 'persian-zipformer-transducer-1.0.0',
    installedModelId: 'persian-zipformer-transducer-1.0.0',
    explicitCloudAuthorization: false,
    capabilities: caps,
  });
  assert.equal(blocked.outcome, 'BLOCKED_CLOUD_AUTHORIZATION_REQUIRED');
  assert.equal(blocked.silentModeSwitchOccurred, false);
  assert.equal(blocked.automaticModelSubstitutionOccurred, false);
});

test('SHAHAB-019: Persian orthography audit, verbatim preservation, 18-category error taxonomy, uncalibrated score guard & adjudication', () => {
  assert.equal(SHAHAB_PERSIAN_ERROR_TAXONOMY_18.length, 18);

  const ortho = auditPersianOrthographyTransformation('می روم كتاب');
  assert.equal(ortho.arabicYeKafConverted, true);
  assert.equal(ortho.rawPreservedSeparately, true);

  const guard = guardUncalibratedDecoderScore(-4.25);
  assert.equal(guard.isCalibratedProbability, false);
  assert.equal(guard.probabilityDisplayBlocked, true);

  const verb = evaluateVerbatimPreservation('نه نه من میام', 'نه نه من میام');
  assert.equal(verb.repetitionPreservationRate, 1);
  assert.equal(verb.verbatimFidelityPassed, true);

  const errors = classifyPersianMismatch('شکلات داغ بلژیکی', 'شکلات داغ بلژيكي');
  assert.ok(errors.length >= 1);

  const adj = new SHAHABReferenceAdjudicationWorkflow();
  const rec = adj.registerDisputeAndAdjudicate({
    sampleId: 'sample-1',
    annotatorA: 'شکلات داغ',
    annotatorB: 'شکلات داغ بلژیکی',
    adjudicatedText: 'شکلات داغ بلژیکی',
    rationale: 'Verified against audio waveform',
  });
  assert.equal(rec.currentLevel, 'L5_ADJUDICATED_GOLD_VERBATIM');
  assert.equal(rec.eligibleForBenchmarkClaims, true);
});

test('SHAHAB-021: Persisted System Qualification artifacts exist and never suppress release blockers', () => {
  const qualPath = path.join(DOCS_DIR, 'SHAHAB_SYSTEM_QUALIFICATION_STATE.json');
  assert.ok(fs.existsSync(qualPath), 'SHAHAB_SYSTEM_QUALIFICATION_STATE.json must be persisted');
  const qual = JSON.parse(fs.readFileSync(qualPath, 'utf8'));
  assert.equal(qual.missionId, 'SHAHAB-021');
  assert.equal(qual.integratedWorkloads.length, 8);
  assert.equal(qual.crossSubsystemTests.length, 6);
  assert.ok(qual.releaseDecision.releaseBlockersCount >= 2);
  assert.equal(qual.releaseDecision.primaryDecision, 'NO_GO_REQUIRES_ENGINEERING_FIXES');
  assert.equal(qual.releaseDecision.secondaryRecommendation, 'RECOMMEND_CURRENT_MODEL_RETENTION');
  assert.equal(qual.releaseDecision.failedChecks.length, 0);

  const verifier = new SHAHABArtifactIntegrityVerifier();
  assert.equal(typeof verifier.verifyDirectory, 'function');
});

test(
  'SHAHAB-022: Stable host-neutral SDK lifecycle, idempotency conflict, privacy boundary & post-dispose guard',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, async () => {
  const sdk = createShahabSdkEngine({
    modelDir: MODEL_DIR,
    docsDir: DOCS_DIR,
    clientIdentity: 'unit-test-sdk-022',
  });
  await sdk.initialize();
  await sdk.initialize(); // idempotent

  const grant = sdk.negotiateCapabilities({
    hostId: 'test-host',
    hostAdapterVersion: '1.0.0',
    requestedApiMajorVersion: 1,
    requestedExecutionMode: 'LOCAL',
    explicitCloudAuthorization: false,
    wantsWordLevelTiming: true,
    wantsTrueStatefulStreaming: true,
  });
  assert.equal(grant.compatible, true);
  assert.equal(grant.grantedExecutionMode, 'LOCAL');
  assert.equal(grant.silentModeSwitchOccurred, false);
  assert.ok(grant.explicitLimitations.length >= 2);

  await assert.rejects(
    async () => {
      await sdk.submitTranscription({
        apiVersion: SHAHAB_SDK_API_VERSION,
        requestId: 'req-unauth-cloud',
        idempotencyKey: 'idem-unauth-cloud',
        audioSource: {
          sourceKind: 'IN_MEMORY_PCM_BUFFER',
          sourceId: 's0',
          sampleRateHz: 16000,
          channels: 1,
          sampleFormat: 'FLOAT32_PCM',
          endianness: 'LITTLE_ENDIAN',
          frameCount: 1600,
          timelineOriginSec: 0,
          timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
          endOfStream: true,
          ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
          pcmFloat32: new Float32Array(1600),
        },
        executionMode: 'CLOUD',
        authorization: { tenantOrProjectId: 'p1', callerIdentity: 'test', explicitCloudConsent: false },
      });
    },
    (err: unknown) => err instanceof ShahabSdkError && err.payload.code === 'CONSENT_REQUIRED',
  );

  await sdk.dispose();
  assert.throws(
    () => sdk.getCapabilities(),
    (err: unknown) => err instanceof ShahabSdkError && err.payload.code === 'ENGINE_DISPOSED',
  );
});

test(
  'SHAHAB-023: Avapardaz native integration via SDK, non-destructive source hashing, flick mapping & revision staleness',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, async () => {
  const sdk = createShahabSdkEngine({ modelDir: MODEL_DIR, docsDir: DOCS_DIR });
  await sdk.initialize();
  try {
    const adapter = new AvapardazShahabAdapter(sdk);
    const { pcm16k } = decodeWavToMono16k(fs.readFileSync(SAMPLE_WAV));
    const offsetFlicks = AVAPARDAZ_FLICKS_PER_SECOND * 5;
    const rec = await adapter.transcribeProjectSelection({
      selection: {
        projectId: 'proj-unit-023',
        assetId: 'asset-01',
        mediaRevision: 'rev-1',
        audioStreamId: 'stream-0',
        clipId: 'clip-1',
        sourceSampleRateHz: 16000,
        sourceChannels: 1,
        sourceStartSample: 16000,
        sourceEndSample: 16000 * 5,
        timelineOffsetFlicks: offsetFlicks,
        playbackRate: 1.0,
        pitchPreservingTimeStretchApplied: false,
        sourcePcmFloat32: pcm16k,
      },
      executionMode: 'LOCAL',
      explicitCloudConsent: false,
    });
    assert.equal(rec.sourceManifest.sourceUnmodifiedVerified, true);
    assert.equal(rec.mappedSegments[0].timelineFlickRange?.startFlicks, offsetFlicks);
    assert.ok(rec.layers.rawAcousticOutput.length > 0);

    const edited = adapter.applyUserEdit(rec.transcriptId, rec.mappedSegments[0].segmentId, 'متن ویرایش‌شده کاربر');
    assert.equal(edited.protectedAgainstOverwrite, true);

    const srt = adapter.exportTranscript(rec.transcriptId, 'SRT_UTF8');
    assert.ok(srt.content.includes('-->'));

    const staleCount = adapter.notifyMediaRevisionChanged('asset-01', 'rev-2');
    assert.equal(staleCount, 1);
    assert.equal(
      adapter.getTranscript(rec.transcriptId, 'proj-unit-023')?.validityState,
      'STALE_SOURCE_REVISION_CHANGED',
    );
    assert.equal(adapter.getTranscript(rec.transcriptId, 'wrong-project'), null);
  } finally {
    await sdk.dispose();
  }
});

test(
  'SHAHAB-024: Adobe Audition Companion Adapter, Official Register, Markers CSV offset & Bridge Security',
  { skip: MODEL_ARTIFACTS_AVAILABLE ? false : MODEL_SMOKE_SKIP }, async () => {
  assert.ok(ADOBE_AUDITION_OFFICIAL_CAPABILITY_REGISTER.length >= 5);
  assert.equal(formatAuditionDecimalTime(85.5), '01:25.500');

  const guard = new AuditionLocalBridgeSecurityGuard({
    sessionToken: 'tok-test-024',
    allowedWorkspaceRoot: ROOT,
  });
  assert.equal(guard.authorizeBridgeRequest({ providedToken: null, payloadByteLength: 10 }).authorized, false);
  assert.equal(
    guard.authorizeBridgeRequest({ providedToken: 'tok-test-024', payloadByteLength: 10, requestedFilePath: '/etc/passwd' })
      .authorized,
    false,
  );
  assert.equal(
    guard.authorizeBridgeRequest({ providedToken: 'tok-test-024', payloadByteLength: 10, requestedFilePath: SAMPLE_WAV })
      .authorized,
    true,
  );

  const sdk = createShahabSdkEngine({ modelDir: MODEL_DIR, docsDir: DOCS_DIR });
  await sdk.initialize();
  try {
    const adapter = new AdobeAuditionHostAdapter(sdk);
    const caps = adapter.getDisclosedCapabilities();
    assert.equal(caps.integrationArchitecture, 'COMPANION_APP_APPROVED');
    assert.equal(caps.isNativeAudioPlugin, false);
    assert.equal(caps.automaticTranscriptInsertion, false);

    const pkg = await adapter.processAuditionExportedAudio({
      hostVersionDeclared: 'Adobe Audition 25.x',
      hostSessionId: 'aud-unit-sess-1',
      sourceAssetId: 'sample.wav',
      wavFilePath: SAMPLE_WAV,
      auditionSessionStartOffsetSec: 85.5,
      sourceSampleRateHz: 16000,
      executionMode: 'LOCAL',
      explicitCloudConsent: false,
    });
    assert.equal(pkg.sourceManifest.sourceFileIntactVerified, true);
    assert.equal(pkg.mappedSegments[0].auditionSessionStartSec, 85.5);
    assert.ok(pkg.outputs.auditionMarkersCsvTabDelimited.content.includes('01:25.500'));
    assert.equal(
      adapter.verifyPackageForRecoveryImport({
        packageId: pkg.packageId,
        currentHostSessionId: 'aud-unit-sess-1',
        currentAudioSha256: pkg.sourceManifest.exportedAudioSha256,
      }).safeToImport,
      true,
    );
    assert.equal(
      adapter.verifyPackageForRecoveryImport({
        packageId: pkg.packageId,
        currentHostSessionId: 'other-sess',
        currentAudioSha256: pkg.sourceManifest.exportedAudioSha256,
      }).safeToImport,
      false,
    );
  } finally {
    await sdk.dispose();
  }
});
