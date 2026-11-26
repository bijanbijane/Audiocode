import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFloat32ToContainerWithFfmpeg,
  isFfmpegAvailable,
  float32ToPcm16Buffer,
  ingestAudioBufferToCanonical16kMono,
  inspectAndDownmixChannels,
} from '../CoreAudioIngestion';
import {
  CORE_SAMPLE_RATE,
  CoreAcousticCtcEngine,
  probeRuntimeBackendAvailability,
  synthesizeAcousticSpeechFromText,
} from '../CoreAcousticCtcEngine';
import { buildAllNormalizationProfiles, detectTextLanguageTag } from '../CoreNormalizationAndLanguage';
import { CoreBatchAndLongFormEngine } from '../CoreBatchAndLongFormEngine';
import { CoreStreamingAsrManager } from '../CoreStreamingAsrEngine';
import {
  buildLongFormStressAudioPcm,
  runCoreBenchmarkAndAdaptationSuite,
} from '../CoreAsrBenchmarkSuite';

test(
  'CORE-02: Real FFmpeg multi-format decode (WAV, MP3, FLAC, OGG, M4A, WebM) & independent batch decode',
  { skip: isFfmpegAvailable() ? false : 'FFmpeg is required for multi-container codec integration tests' },
  () => {
  const speechPcm = synthesizeAcousticSpeechFromText('سلام امروز api بررسی');
  const formats: Array<'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm'> = [
    'wav',
    'mp3',
    'flac',
    'ogg',
    'm4a',
    'webm',
  ];

  const engine = new CoreBatchAndLongFormEngine();
  for (const fmt of formats) {
    const encoded = encodeFloat32ToContainerWithFfmpeg(speechPcm, fmt, CORE_SAMPLE_RATE);
    assert.ok(encoded.length > 100, `${fmt} encoded bytes should be non-empty`);

    const ingested = ingestAudioBufferToCanonical16kMono({
      filename: `sample.${fmt}`,
      rawBytes: encoded,
    });
    assert.equal(ingested.detectedFormat, fmt);
    assert.equal(ingested.canonicalSampleRateHz, 16_000);
    assert.equal(ingested.canonicalChannels, 1);
    assert.ok(ingested.durationSec > 0.5, `${fmt} decoded duration must exceed 0.5s`);

    const result = engine.transcribeAudioBytes({
      filename: `sample.${fmt}`,
      rawBytes: encoded,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.confidenceStatus, 'UNAVAILABLE_UNCALIBRATED');
    assert.equal(result.calibratedConfidence, null);
    assert.ok(result.rawModelOutput.length > 0, `${fmt} transcription should emit non-empty output`);
  }
});

test('CORE-02 Stereo Guard & Normalization Separation: anti-phase L/R never cancels to silence; raw != normalized', () => {
  const n = 4000;
  const left = new Float32Array(n);
  const rightAntiPhase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / CORE_SAMPLE_RATE) * 0.5;
    left[i] = v;
    rightAntiPhase[i] = -v;
  }

  const downmixed = inspectAndDownmixChannels([left, rightAntiPhase]);
  assert.equal(downmixed.inspection.phaseInversionRisk, true);
  assert.equal(downmixed.inspection.policyApplied, 'LEFT_PRIMARY_PHASE_GUARD');
  const rms = Math.sqrt(
    downmixed.monoFloat32.reduce((a, b) => a + b * b, 0) / downmixed.monoFloat32.length,
  );
  assert.ok(rms > 0.2, `Anti-phase protection must preserve audio RMS (${rms})`);

  const sampleRaw = 'سلام، من دارم می روم سراغ API و TypeScript كد!';
  const profiles = buildAllNormalizationProfiles(sampleRaw);
  assert.equal(profiles.RAW_UNMODIFIED, sampleRaw);
  assert.ok(profiles['FA-STRICT-V1'].includes('می\u200cروم'));
  assert.ok(!profiles['FA-RELAXED-V1'].includes('\u200c'));
  assert.ok(profiles['MIXED-NORM-V1'].includes('api'));
  assert.equal(detectTextLanguageTag(sampleRaw).language, 'fa-en');
});

test('CORE-05: Long-form boundary segmentation, sample offsets, and explicit failed-segment recovery', () => {
  const longPcm = buildLongFormStressAudioPcm(36);
  const batch = new CoreBatchAndLongFormEngine();

  const fullRes = batch.transcribeLongFormPcm({
    pcm16k: longPcm,
    config: { maxSegmentDurationSec: 12, contextOverlapSec: 1.5 },
  });
  assert.equal(fullRes.status, 'COMPLETED');
  assert.ok(fullRes.segments.length >= 3, `Expected >=3 segments, got ${fullRes.segments.length}`);
  assert.ok(fullRes.segments[1].startSec > 8, 'Second segment startSec must reflect true recording offset');

  // Inject deterministic segment failure on index 1 and ensure engine never fakes silent completion
  const partialRes = batch.transcribeLongFormPcm({
    pcm16k: longPcm,
    config: {
      maxSegmentDurationSec: 12,
      contextOverlapSec: 1.5,
      maxRetriesPerSegment: 1,
      simulateFailureOnSegmentIndex: 1,
    },
  });
  assert.equal(partialRes.status, 'PARTIAL_WITH_FAILURES');
  assert.equal(partialRes.failedSegmentRanges.length, 1);
  assert.equal(partialRes.failedSegmentRanges[0].segmentIndex, 1);
  assert.equal(partialRes.segments[1].status, 'FAILED');
});

test('CORE-06: Stateful streaming across 100ms, 250ms, 500ms, 1000ms chunks + overload rejection', () => {
  const speech = synthesizeAcousticSpeechFromText('سلام امروز سرویس');
  const silencePad = new Float32Array(CORE_SAMPLE_RATE * 0.6);
  const fullPcm = new Float32Array(speech.length + silencePad.length);
  fullPcm.set(speech, 0);

  const chunkDurationsMs = [100, 250, 500, 1000];
  for (const ms of chunkDurationsMs) {
    const manager = new CoreStreamingAsrManager(new CoreAcousticCtcEngine(), 4);
    const created = manager.createSession({
      tenantId: 'tenant_test',
      streamingCategory: 'STATEFUL_CHUNKED_STREAMING',
      silenceEndpointMs: 320,
    });
    assert.equal(created.accepted, true);
    assert.equal(created.readyEvent.type, 'session.ready');

    const samplesPerChunk = Math.round((ms / 1000) * CORE_SAMPLE_RATE);
    for (let pos = 0; pos < fullPcm.length; pos += samplesPerChunk) {
      const slice = fullPcm.subarray(pos, Math.min(fullPcm.length, pos + samplesPerChunk));
      manager.pushPcm16Chunk(created.sessionId, float32ToPcm16Buffer(slice));
    }

    const fin = manager.finalizeSession(created.sessionId);
    const events = manager.getSessionEvents(created.sessionId);
    const types = events.map((e) => e.type);

    assert.ok(types.includes('speech.started'), `${ms}ms stream should emit speech.started`);
    assert.ok(types.includes('transcript.final'), `${ms}ms stream should emit transcript.final`);
    assert.ok(types.includes('session.completed'), `${ms}ms stream should emit session.completed`);
    assert.equal(events[0].streamingCategory, 'STATEFUL_CHUNKED_STREAMING');
    assert.ok(fin.metrics.rtf >= 0);

    // Strictly monotonic sequence numbering
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i].seq, events[i - 1].seq + 1);
    }
  }

  // Test bounded queue overload rejection
  const overloadedManager = new CoreStreamingAsrManager(new CoreAcousticCtcEngine(), 2);
  const s1 = overloadedManager.createSession({ tenantId: 't1', maxQueuedSamples: 800 });
  const s2 = overloadedManager.createSession({ tenantId: 't1', maxQueuedSamples: 800 });
  const s3 = overloadedManager.createSession({ tenantId: 't1' });
  assert.equal(s3.accepted, false);
  assert.equal(s3.readyEvent.type, 'session.overloaded');

  const bigChunk = float32ToPcm16Buffer(synthesizeAcousticSpeechFromText('سلام امروز سرویس گفتار'));
  const overloadEvts = overloadedManager.pushPcm16Chunk(s1.sessionId, bigChunk);
  assert.ok(overloadEvts.some((e) => e.type === 'session.overloaded'));
  overloadedManager.finalizeSession(s1.sessionId);
  overloadedManager.finalizeSession(s2.sessionId);
});

test('CORE-03 & CORE-04: Disjoint FA/EN/MIXED evaluation, 2000-iter paired bootstrap CI & Level-B adaptation gate', () => {
  const report = runCoreBenchmarkAndAdaptationSuite(2000);
  assert.ok(report.baselineSlices.faStrict.utteranceCount >= 4);
  assert.ok(report.baselineSlices.en.utteranceCount >= 3);
  assert.ok(report.baselineSlices.mixed.utteranceCount >= 3);
  assert.equal(report.gateReport.bootstrapPersianCer.iterations, 2000);
  assert.ok(report.trainingSummary.trainedSteps > 0);
  assert.ok(
    report.gateReport.persianRelativeCerImprovementPct >= 5.0,
    `Expected FA CER relative improvement >= 5%, got ${report.gateReport.persianRelativeCerImprovementPct}%`,
  );
  assert.equal(report.gateReport.overallApproved, true);

  // Honest backend runtime availability probe (no fake external ONNX/Python claims)
  const backends = probeRuntimeBackendAvailability();
  const local = backends.find((b) => b.backendId === 'LOCAL_CPU_ACOUSTIC_CTC_ADAPTER');
  const pythonWorker = backends.find((b) => b.backendId === 'EXTERNAL_PYTHON_NEURAL_WORKER');
  assert.equal(local?.availableOnThisHost, true);
  assert.equal(pythonWorker?.availableOnThisHost, false);
});
