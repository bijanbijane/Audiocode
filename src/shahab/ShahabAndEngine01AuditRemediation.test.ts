import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import * as ort from 'onnxruntime-web';

import {
  SHAHABFrozenModelAdapter,
  SHAHABRuntimeCapabilityRegistry,
  type ShahabEncoderOutputTensor,
} from './ShahabZipformerEngine';
import {
  ShahabZipformerAsrRuntime,
  ShahabZipformerRuntimeError,
} from './ShahabZipformerAsrRuntime';
import { createShahabHttpRouter } from './ShahabHttpRouter';
import { SHAHABFieldDatasetManifest } from './ShahabFieldValidation';
import {
  detectDatasetLeakage,
  type ShahabDatasetManifest,
} from './ShahabBenchmarkAndErrorEngine';
import {
  AudioApiSecurityGuard,
  validateBinaryAudioPayload,
} from '../security/AudioApiSecurityGuard';
import { detectAudioContainerFormat } from '../asr-core/CoreAudioIngestion';
import { SmartAudioEditPipeline } from '../workflow/SmartAudioEditPipeline';
import { SmartAudioEditJobManager } from '../workflow/SmartAudioEditJobManager';
import { createSmartAudioEditHttpRouter } from '../workflow/SmartAudioEditHttpRouter';
import type {
  ShahabAsrEngine,
  ShahabTranscribeRequest,
  SmartEditAnalysisRequest,
  SmartEditDecisionEngine,
} from '../workflow/SmartAudioEditContracts';

function buildValidPcm16WavBuffer(durationSec = 0.5, sampleRate = 16000): Buffer {
  const numFrames = Math.max(160, Math.round(durationSec * sampleRate));
  const dataSize = numFrames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numFrames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

test('WP-1: decodeFromEncoderOutput disposes 100% of decoder/joiner input and output tensors across greedy, beam, error, and cancel paths', async () => {
  const adapter = new SHAHABFrozenModelAdapter({ modelDir: os.tmpdir() });
  const vocabSize = 6;
  const dim = 4;

  const trackedInputs: Array<{ disposed: boolean }> = [];
  const trackedOutputs: Array<{ disposed: boolean }> = [];
  let failJoinerOnCall = -1;
  let joinerCallCount = 0;

  const wrapInputTensor = (t: ort.Tensor): void => {
    const tracker = { disposed: false };
    trackedInputs.push(tracker);
    const origDispose = typeof t.dispose === 'function' ? t.dispose.bind(t) : () => {};
    (t as { dispose: () => void }).dispose = () => {
      tracker.disposed = true;
      origDispose();
    };
  };

  const makeTrackedOutput = (data: Float32Array) => {
    const tracker = { disposed: false };
    trackedOutputs.push(tracker);
    return {
      data,
      dims: [1, data.length],
      dispose: () => {
        tracker.disposed = true;
        // Zero buffer on dispose to prove callers copied the logits instead of aliasing disposed memory
        data.fill(Number.NaN);
      },
    };
  };

  // Inject mock sessions & vocab directly (avoids requiring external .onnx model files on disk)
  const internal = adapter as unknown as {
    encoderSession: unknown;
    decoderSession: unknown;
    joinerSession: unknown;
    vocab: readonly string[];
    initializeRuntime: () => Promise<void>;
  };
  internal.vocab = ['<blk>', '▁سلام', '▁جهان', '▁تست', '▁آوا', '▁پرداز'];
  internal.initializeRuntime = async () => {};
  internal.encoderSession = {};
  internal.decoderSession = {
    run: async (feeds: { y: ort.Tensor }) => {
      wrapInputTensor(feeds.y);
      return {
        decoder_out: makeTrackedOutput(new Float32Array([0.1, 0.2, 0.3, 0.4])),
      };
    },
  };
  internal.joinerSession = {
    run: async (feeds: { encoder_out: ort.Tensor; decoder_out: ort.Tensor }) => {
      wrapInputTensor(feeds.encoder_out);
      wrapInputTensor(feeds.decoder_out);
      joinerCallCount++;
      if (failJoinerOnCall > 0 && joinerCallCount === failJoinerOnCall) {
        throw new Error('SIMULATED_JOINER_FAULT');
      }
      const logits = new Float32Array(vocabSize);
      logits[0] = joinerCallCount % 2 === 0 ? 3.0 : -1.0;
      logits[1 + (joinerCallCount % (vocabSize - 1))] = 2.5;
      return {
        logit: makeTrackedOutput(logits),
      };
    },
  };

  const encoderOutput: ShahabEncoderOutputTensor = {
    data: new Float32Array(5 * dim).fill(0.25),
    numFrames: 5,
    dim,
    dtype: 'float32',
    byteLength: 5 * dim * 4,
    encoderTimeMs: 1,
  };

  // 1. Greedy search (SPEED)
  const greedy = await adapter.decodeFromEncoderOutput({
    encoderOutput,
    policy: adapter.policyManager.getPolicy('SPEED'),
  });
  assert.ok(greedy.tokenIds.length > 0);
  assert.ok(Number.isFinite(greedy.logProbSum));
  assert.ok(trackedInputs.length > 0 && trackedInputs.every((t) => t.disposed));
  assert.ok(trackedOutputs.length > 0 && trackedOutputs.every((t) => t.disposed));

  // 2. Modified Beam Search (BALANCED)
  const beforeBeamIn = trackedInputs.length;
  const beam = await adapter.decodeFromEncoderOutput({
    encoderOutput,
    policy: adapter.policyManager.getPolicy('BALANCED'),
  });
  assert.ok(beam.tokenIds.length > 0);
  assert.ok(trackedInputs.length > beforeBeamIn);
  assert.ok(trackedInputs.every((t) => t.disposed));
  assert.ok(trackedOutputs.every((t) => t.disposed));

  // 3. Error path in joiner must still dispose input tensors
  failJoinerOnCall = joinerCallCount + 2;
  await assert.rejects(
    () =>
      adapter.decodeFromEncoderOutput({
        encoderOutput,
        policy: adapter.policyManager.getPolicy('SPEED'),
      }),
    /SIMULATED_JOINER_FAULT/,
  );
  assert.ok(trackedInputs.every((t) => t.disposed));
  assert.ok(trackedOutputs.every((t) => t.disposed));

  // 4. Cancelled path must reject with JOB_CANCELLED and leak zero tensors
  failJoinerOnCall = -1;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      adapter.decodeFromEncoderOutput({
        encoderOutput,
        policy: adapter.policyManager.getPolicy('BALANCED'),
        signal: ac.signal,
      }),
    (err: unknown) =>
      Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'JOB_CANCELLED'),
  );
  assert.ok(trackedInputs.every((t) => t.disposed));
  assert.ok(trackedOutputs.every((t) => t.disposed));
});

test('WP-1: SHAHABFrozenModelAdapter.cancel() genuinely aborts an in-flight transcribe() call', async () => {
  const adapter = new SHAHABFrozenModelAdapter({ modelDir: os.tmpdir() });
  const internal = adapter as unknown as {
    initializeRuntime: () => Promise<void>;
    encodeAudio: (params: { signal?: AbortSignal }) => Promise<never>;
  };
  internal.initializeRuntime = async () => {};
  internal.encodeAudio = async ({ signal }) => {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    const err = new Error('cancelled') as Error & { code: string };
    err.code = 'JOB_CANCELLED';
    throw err;
  };

  const transcribePromise = adapter.transcribe({
    jobId: 'cancel_test_job',
    projectId: 'proj-cancel-test',
    trackId: 'track-main',
    sourceAssetId: 'asset-cancel-test',
    sourceAssetSha256: '0'.repeat(64),
    fileName: 'cancel.wav',
    sampleRate: 16000,
    totalSamples: 1600,
    languageHint: 'fa',
    readSourceRange: async () => new Float32Array(1600),
  });

  // Trigger cancel while encodeAudio is waiting on the linked AbortSignal
  setTimeout(() => {
    void adapter.cancel();
  }, 15);

  await assert.rejects(
    () => transcribePromise,
    (err: unknown) =>
      Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'JOB_CANCELLED'),
  );
});

test('WP-2: Eager SHA-256 integrity readiness and truthful capability reporting without model weights', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-audit-wp2-'));
  try {
    // 1. Empty dir -> unavailable
    const emptyAdapter = new SHAHABFrozenModelAdapter({ modelDir: tmpDir });
    const emptyCaps = await emptyAdapter.probeCapabilities();
    assert.equal(emptyCaps.available, false);
    assert.deepEqual(emptyCaps.supportedArchitectures, ['ZIPFORMER_TRANSDUCER']);
    assert.ok(!emptyCaps.supportedArchitectures.includes('FASTCONFORMER_CTC'));
    assert.ok(!emptyCaps.supportedArchitectures.includes('WHISPER_SEQ2SEQ'));

    const registry = new SHAHABRuntimeCapabilityRegistry();
    const profiles = registry.listProfiles({ modelDir: tmpDir });
    const wasmProfile = profiles.find((p) => p.runtimeId === 'shahab-browser-wasm-cpu');
    const cloudProfile = profiles.find((p) => p.runtimeId === 'shahab-cloud-unified-contract');
    assert.equal(wasmProfile?.verifiedInCurrentContainer, false);
    assert.equal(cloudProfile?.verifiedInCurrentContainer, false);

    // 2. Corrupted required model files -> getRuntimeStatus() immediately reports available=false BEFORE transcribe()
    for (const file of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      fs.writeFileSync(path.join(tmpDir, file), Buffer.from('corrupt-bytes-for-eager-check'));
    }

    const rt = new ShahabZipformerAsrRuntime({ modelDir: tmpDir });
    const status = rt.getRuntimeStatus();
    assert.equal(status.available, false);
    assert.equal(status.integrityVerified, false);
    assert.ok(status.integrityError && status.integrityError.includes('SHA-256'));
    assert.equal(status.maxSingleRequestDurationSec, 600);

    const corruptCaps = await emptyAdapter.probeCapabilities();
    assert.equal(corruptCaps.available, false);

    await rt.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WP-3: RF64 WAV and AIFF format alignment across SecurityGuard + CoreAudioIngestion, and canonicalPcm16kMono handoff', async () => {
  // 1. RF64 WAV magic accepted by both security guard and CoreAudioIngestion
  const rf64 = Buffer.alloc(64);
  rf64.write('RF64', 0, 'ascii');
  rf64.write('WAVE', 8, 'ascii');
  assert.equal(validateBinaryAudioPayload(rf64, { minBytes: 44 }).ok, true);
  assert.equal(detectAudioContainerFormat(rf64, 'studio.wav'), 'wav');

  // 2. AIFF & AIFC magic accepted by both security guard and CoreAudioIngestion
  const aiff = Buffer.alloc(64);
  aiff.write('FORM', 0, 'ascii');
  aiff.write('AIFF', 8, 'ascii');
  assert.equal(validateBinaryAudioPayload(aiff, { minBytes: 44 }).ok, true);
  assert.equal(detectAudioContainerFormat(aiff, 'track.aiff'), 'aiff');
  assert.equal(detectAudioContainerFormat(Buffer.alloc(4), 'track.mp4'), 'm4a');

  // 3. SmartAudioEditPipeline.transcribe() forwards canonicalPcm16kMono to ShahabAsrEngine
  const capturedReqs: ShahabTranscribeRequest[] = [];
  const spyAsr: ShahabAsrEngine = {
    async transcribe(req) {
      capturedReqs.push(req);
      return {
        transcript: {
          schemaVersion: 'avp.transcript.v1',
          transcriptVersion: 'tr_spy_1',
          sourceAudioId: req.sourceAudioId,
          sourceAudioHash: req.sourceAudioHash ?? 'spy-hash',
          sampleRate: req.sourceSampleRate ?? 16000,
          totalSourceSamples: req.totalSourceSamples ?? 8000,
          language: 'fa',
          modelId: 'spy-shahab',
          modelVersion: '1.0.0',
          runtime: 'shahab-zipformer-onnx-cpu',
          rawText: 'سلام',
          normalizedText: 'سلام',
          tokens: [],
          timestampGranularity: 'SEGMENT',
          realTimeFactor: 0.1,
          processingTimeMs: 5,
          offlineVerified: true,
          createdAtMs: Date.now(),
        },
        metrics: {
          modelId: 'spy-shahab',
          upstreamModelId: 'spy',
          runtime: 'shahab-zipformer-onnx-cpu',
          durationSec: 0.5,
          processingTimeMs: 5,
          realTimeFactor: 0.1,
          rssBeforeMb: 50,
          rssAfterMb: 50,
          peakRssMb: 50,
          tokenCount: 0,
          offlineVerified: true,
        },
      };
    },
    unload() {
      return { unloaded: false, rssMb: 0 };
    },
  };

  const pipeline = new SmartAudioEditPipeline({ asrEngine: spyAsr });
  const wavBytes = buildValidPcm16WavBuffer(0.5, 16000);
  const imported = pipeline.importAndNormalizeAudio({
    audioBytes: wavBytes,
    filename: 'handoff.wav',
    projectId: 'proj-handoff-1',
  });
  await pipeline.transcribe({ job: imported.job, session: imported.session, audio: imported.audio });
  assert.equal(capturedReqs.length, 1);
  assert.strictEqual(capturedReqs[0].canonicalPcm16kMono, imported.audio.canonical16kMono);

  // 4. ShahabZipformerAsrRuntime validates NaN/Infinity and duration limits on canonicalPcm16kMono directly
  const rt = new ShahabZipformerAsrRuntime({ maxSingleRequestDurationSec: 2 });
  const nanPcm = new Float32Array(1600);
  nanPcm[0] = Number.NaN;
  await assert.rejects(
    () =>
      rt.transcribe({
        sourceAudioId: 'nan_pcm',
        sourceAudioHash: 'hash_nan',
        canonicalPcm16kMono: nanPcm,
      }),
    (err: unknown) => err instanceof ShahabZipformerRuntimeError && err.code === 'INVALID_AUDIO_INPUT',
  );

  const tooLongPcm = new Float32Array(16000 * 3); // 3s > 2s cap
  await assert.rejects(
    () =>
      rt.transcribe({
        sourceAudioId: 'long_pcm',
        sourceAudioHash: 'hash_long',
        canonicalPcm16kMono: tooLongPcm,
      }),
    (err: unknown) =>
      err instanceof ShahabZipformerRuntimeError && err.code === 'AUDIO_DURATION_LIMIT_EXCEEDED',
  );
  await rt.dispose();
});

test('WP-4: HTTP routers expose aligned 300s limits & X-Project-Id, and analysis cancellation transitions cleanly to CANCELLED/FAILED', async () => {
  // 1. Analysis cancellation & failure state transitions in SmartAudioEditJobManager
  const stubAsr: ShahabAsrEngine = {
    async transcribe(req) {
      return {
        transcript: {
          schemaVersion: 'avp.transcript.v1',
          transcriptVersion: 'tr_stub_1',
          sourceAudioId: req.sourceAudioId,
          sourceAudioHash: req.sourceAudioHash ?? 'stub-hash',
          sampleRate: req.sourceSampleRate ?? 16000,
          totalSourceSamples: req.totalSourceSamples ?? 8000,
          language: 'fa',
          modelId: 'stub',
          modelVersion: '1.0.0',
          runtime: 'shahab-zipformer-onnx-cpu',
          rawText: 'تست لغو تحلیل',
          normalizedText: 'تست لغو تحلیل',
          tokens: [],
          timestampGranularity: 'SEGMENT',
          realTimeFactor: 0.05,
          processingTimeMs: 2,
          offlineVerified: true,
          createdAtMs: Date.now(),
        },
        metrics: {
          modelId: 'stub',
          upstreamModelId: 'stub',
          runtime: 'shahab-zipformer-onnx-cpu',
          durationSec: 0.5,
          processingTimeMs: 2,
          realTimeFactor: 0.05,
          rssBeforeMb: 50,
          rssAfterMb: 50,
          peakRssMb: 50,
          tokenCount: 0,
          offlineVerified: true,
        },
      };
    },
    unload() {
      return { unloaded: false, rssMb: 0 };
    },
  };

  let receivedSignalInAnalyze: AbortSignal | undefined;
  let analyzeMode: 'cancel' | 'throw' = 'cancel';
  const controlledDecisionEngine: SmartEditDecisionEngine = {
    async analyzeAndGenerateEdl(request: SmartEditAnalysisRequest) {
      receivedSignalInAnalyze = request.signal;
      if (analyzeMode === 'throw') {
        throw new Error('ENGINE02_ANALYSIS_BOOM');
      }
      await new Promise<void>((_, reject) => {
        if (request.signal?.aborted) {
          reject(new Error('ANALYSIS_CANCELLED'));
          return;
        }
        request.signal?.addEventListener('abort', () => reject(new Error('ANALYSIS_CANCELLED')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    },
  };

  const pipeline = new SmartAudioEditPipeline({
    asrEngine: stubAsr,
    decisionEngine: controlledDecisionEngine,
  });
  const jobManager = new SmartAudioEditJobManager(pipeline, { requireExplicitOwnerId: true });
  const wavBytes = buildValidPcm16WavBuffer(0.5, 16000);

  // Cancel during ANALYZING -> job must land in CANCELLED (never stuck in ANALYZING)
  const snap1 = jobManager.createJobFromAudio({
    ownerId: 'owner-a',
    audioBytes: wavBytes,
    filename: 'cancel.wav',
    projectId: 'proj-cancel',
  });
  const ac = new AbortController();
  const runPromise1 = jobManager.runTranscribeAndAnalyze(snap1.job.jobId, {
    ownerId: 'owner-a',
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 15);
  await assert.rejects(() => runPromise1);
  assert.ok(receivedSignalInAnalyze !== undefined);
  assert.equal(jobManager.getJobSnapshot(snap1.job.jobId, 'owner-a')?.job.status, 'CANCELLED');

  // Error during ANALYZING -> job must land in FAILED (never stuck in ANALYZING)
  analyzeMode = 'throw';
  const snap2 = jobManager.createJobFromAudio({
    ownerId: 'owner-a',
    audioBytes: wavBytes,
    filename: 'fail.wav',
    projectId: 'proj-fail',
  });
  await assert.rejects(() =>
    jobManager.runTranscribeAndAnalyze(snap2.job.jobId, { ownerId: 'owner-a' }),
  );
  assert.equal(jobManager.getJobSnapshot(snap2.job.jobId, 'owner-a')?.job.status, 'FAILED');

  // 2. HTTP router status limits & validated X-Project-Id
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-audit-http-'));
  const rt = new ShahabZipformerAsrRuntime({ modelDir: tmpDir });
  const securityGuard = new AudioApiSecurityGuard({ mode: 'local' });
  const localSession = securityGuard.issueLocalSession('audit-local-user');
  const app = express();
  app.use('/api/shahab', createShahabHttpRouter({ shahabZipformerRuntime: rt, securityGuard }));
  const smartEdit = createSmartAudioEditHttpRouter({
    shahabZipformerRuntime: rt,
    asrEngine: stubAsr,
    securityGuard,
  });
  app.use('/api/v2/smart-edit', smartEdit.router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const shahabStatusRes = await fetch(`${baseUrl}/api/shahab/runtime-status`);
    assert.equal(shahabStatusRes.status, 200);
    const shahabStatus = (await shahabStatusRes.json()) as {
      integrityVerified: boolean;
      limits: { requestTimeoutMs: number; maxSingleRequestDurationSec: number; maxUploadBytes: number };
    };
    assert.equal(shahabStatus.integrityVerified, false);
    assert.equal(shahabStatus.limits.requestTimeoutMs, 300_000);
    assert.equal(shahabStatus.limits.maxSingleRequestDurationSec, 600);

    const smartStatusRes = await fetch(`${baseUrl}/api/v2/smart-edit/status`);
    assert.equal(smartStatusRes.status, 200);
    const smartStatus = (await smartStatusRes.json()) as {
      engine01: { integrityVerified: boolean };
      limits: { operationTimeoutMs: number; maxSingleRequestDurationSec: number };
    };
    assert.equal(smartStatus.engine01.integrityVerified, false);
    assert.equal(smartStatus.limits.operationTimeoutMs, 300_000);
    assert.equal(smartStatus.limits.maxSingleRequestDurationSec, 600);

    // POST /api/v2/smart-edit/jobs with valid local session auth + validated X-Project-Id header
    const createJobRes = await fetch(`${baseUrl}/api/v2/smart-edit/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localSession.token}`,
        'Content-Type': 'audio/wav',
        'X-Audio-Filename': 'episode.wav',
        'X-Project-Id': 'podcast_ep_42',
        'X-Request-Nonce': crypto.randomUUID(),
        'X-Request-Timestamp': String(Date.now()),
      },
      body: new Uint8Array(wavBytes),
    });
    assert.equal(createJobRes.status, 201);
    const created = (await createJobRes.json()) as { job: { jobId: string }; filename: string };
    assert.ok(created.job.jobId.startsWith('job_'));
    assert.equal(created.filename, 'episode.wav');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WP-5: Field manifest & benchmark leakage detection catch derived cross-split leakage and stop inflating category recording counts', () => {
  // 1. Replicate SHAHAB_FIELD_DATASET_MANIFEST.json cross-partition lineage + derived Category E pattern
  const fieldManifest = new SHAHABFieldDatasetManifest('audit-field-check', '1.0.0');
  const consent = {
    anonymousOperationalTelemetry: false,
    audioRetentionForResearch: true,
    transcriptRetentionForEvaluation: true,
    shareCorrectionsForResearch: false,
    consentRecordedAtIso: '2026-01-01T00:00:00Z',
    retentionPolicyDays: 90,
    withdrawn: false,
    withdrawnAtIso: null,
  };

  fieldManifest.addSample({
    sampleId: 'fa_field_a_001_clean_studio',
    audioSha256: 'hash_parent_clean',
    acousticFingerprint: 'fp_parent_clean',
    sourceIdentifier: 'sample.wav',
    sourceLicenseOrAuthorization: 'Apache-2.0',
    durationSec: 12.12,
    sampleRateHz: 16000,
    channelCount: 1,
    category: 'CATEGORY_A_STUDIO_PODCAST',
    recordingConditions: 'clean studio',
    referenceTranscript: 'متن آزمایشی فارسی برای بررسی نشت داده',
    referenceVerificationStatus: 'UPSTREAM_DOCUMENTED_DEMO',
    speakerGroupId: 'spk_parent',
    sessionGroupId: 'sess_parent',
    partition: 'FROZEN_TEST',
    consent,
    annotationVersion: '1.0',
    isDerivedAcousticConditionVariant: false,
    derivedFromSampleId: null,
  });

  // Derived noisy variant placed in DEV_DIAGNOSTIC with synthetic distinct speaker/session IDs
  fieldManifest.addSample({
    sampleId: 'fa_field_e_001_noisy_derived',
    audioSha256: 'hash_derived_noisy',
    acousticFingerprint: 'fp_derived_noisy',
    sourceIdentifier: 'sample.wav#noise',
    sourceLicenseOrAuthorization: 'Apache-2.0',
    durationSec: 12.12,
    sampleRateHz: 16000,
    channelCount: 1,
    category: 'CATEGORY_E_DIFFICULT_ACOUSTICS',
    recordingConditions: 'synthetic noise',
    referenceTranscript: 'متن آزمایشی فارسی برای بررسی نشت داده',
    referenceVerificationStatus: 'UPSTREAM_DOCUMENTED_DEMO',
    speakerGroupId: 'spk_synthetic_dev',
    sessionGroupId: 'sess_synthetic_dev',
    partition: 'DEV_DIAGNOSTIC',
    consent,
    annotationVersion: '1.0',
    isDerivedAcousticConditionVariant: true,
    derivedFromSampleId: 'fa_field_a_001_clean_studio',
  });

  const fieldLeak = fieldManifest.checkLeakage();
  assert.equal(fieldLeak.passed, false);
  assert.deepEqual(fieldLeak.crossPartitionLineageLeaks, ['fa_field_a_001_clean_studio']);

  const coverage = fieldManifest.getCategoryCoverage();
  assert.equal(coverage.CATEGORY_A_STUDIO_PODCAST.independentRecordingCount, 1);
  assert.equal(coverage.CATEGORY_E_DIFFICULT_ACOUSTICS.sampleCount, 1);
  assert.equal(coverage.CATEGORY_E_DIFFICULT_ACOUSTICS.independentRecordingCount, 0);
  assert.equal(coverage.CATEGORY_E_DIFFICULT_ACOUSTICS.status, 'INSUFFICIENT_DATA');

  // 2. Replicate SHAHAB_RELEASE_BENCHMARK.json cross-split identical-transcript + lineage leakage
  const benchManifest: ShahabDatasetManifest = {
    schemaVersion: '1.0.0',
    manifestId: 'audit-bench-leak',
    revision: '1.0.0',
    createdAtUtc: '2026-01-01T00:00:00Z',
    immutableFrozenTest: true,
    samples: [
      {
        sampleId: 'bench_frozen_clean',
        datasetId: 'audit-bench-leak',
        datasetRevision: '1.0.0',
        split: 'frozen_test',
        originalSource: 'sample.wav',
        license: 'Apache-2.0',
        audioPath: 'sample.wav',
        audioSha256: 'hash_clean',
        durationSec: 12.12,
        sampleRateHz: 16000,
        speakerId: 'spk_1',
        sessionId: 'sess_1',
        referenceTranscriptVerbatim: 'شکلات داغ بلژیکی استاندارد بالایی دارد',
        transcriptProvenance: 'upstream',
        annotationStatus: 'UPSTREAM_DOCUMENTED',
        speechCategories: ['CLEAN_FORMAL_PERSIAN'],
        recordingConditions: 'clean',
      },
      {
        sampleId: 'bench_dev_noisy',
        datasetId: 'audit-bench-leak',
        datasetRevision: '1.0.0',
        split: 'development',
        originalSource: 'sample.wav#noise',
        license: 'Apache-2.0',
        audioPath: 'sample_noisy.wav',
        audioSha256: 'hash_noisy',
        durationSec: 12.12,
        sampleRateHz: 16000,
        speakerId: 'spk_dev_other',
        sessionId: 'sess_dev_other',
        referenceTranscriptVerbatim: 'شکلات داغ بلژیکی استاندارد بالایی دارد',
        transcriptProvenance: 'derived',
        annotationStatus: 'DERIVED_STRESS_TEST',
        speechCategories: ['NOISY_RECORDINGS'],
        recordingConditions: 'noisy',
        derivedFromSampleId: 'bench_frozen_clean',
        isDerivedVariant: true,
      },
    ],
  };

  const benchLeak = detectDatasetLeakage(benchManifest);
  assert.equal(benchLeak.clean, false);
  assert.equal(benchLeak.crossSplitTranscriptLeaks?.length, 1);
  assert.equal(benchLeak.crossSplitLineageLeaks?.length, 1);
});

test('WP-6: CI quality gate workflow references only existing test files', () => {
  const workflowPath = path.resolve(process.cwd(), '.github/workflows/avapardaz-quality-gates.yml');
  const content = fs.readFileSync(workflowPath, 'utf-8');
  const testPaths = Array.from(content.matchAll(/src\/[A-Za-z0-9_./-]+\.test\.ts/g)).map((m) => m[0]);
  assert.ok(testPaths.length > 0, 'Expected CI workflow to reference at least one test file');
  for (const relPath of testPaths) {
    const absPath = path.resolve(process.cwd(), relPath);
    assert.equal(fs.existsSync(absPath), true, `CI workflow references missing test file: ${relPath}`);
  }
});
