/**
 * AVAPARDAZ — END-TO-END PROJECT WORKFLOW & SIGNAL-LEVEL AUDIO DSP CONFORMANCE SUITE
 * Missions: AVP-P0-003 (End-to-End Transcription Workflow, Edit Decisions, Persistence & Export),
 *           AVP-P0-008 (Audio DSP Integrity, Sample-Accurate Timeline & Deterministic Rendering)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DspReferenceFixtures,
  applyFadeInOut,
  classifySilenceWindow,
  convertChannelLayout,
  createCanonicalAudioBuffer,
  decodeWaveArtifactToPlanarFloat32,
  executeSampleAccurateTimeline,
  inspectNumericalIntegrity,
  renderAndVerifyDeterministicWav,
  resamplePlanarAudio,
  secondsToSampleIndex,
  sampleIndexToSeconds,
} from '../audio-renderer/CanonicalAudioDspEngine';
import { CanonicalProjectWorkflowEngine } from './CanonicalProjectWorkflowEngine';
import { AVAPARDAZ_ASR_CONTRACT_VERSION, type AvapardazTranscriptResult } from '../asr-core/UnifiedLocalAsrRuntime';

function dominantFrequencyHz(samples: Float32Array, sampleRate: number): number {
  let bestFreq = 0;
  let bestMag = -1;
  const N = Math.min(samples.length, 4096);
  for (let f = 100; f <= 4000; f += 20) {
    let re = 0;
    let im = 0;
    const omega = (2 * Math.PI * f) / sampleRate;
    for (let n = 0; n < N; n++) {
      re += samples[n] * Math.cos(omega * n);
      im -= samples[n] * Math.sin(omega * n);
    }
    const mag = re * re + im * im;
    if (mag > bestMag) {
      bestMag = mag;
      bestFreq = f;
    }
  }
  return bestFreq;
}

test('AVP-P0-008: integer sample-index timebase, anti-aliased Kaiser sinc resampling (down & up), channel downmix, fades, silence vs ambient, and NaN/Inf rejection', () => {
  assert.equal(secondsToSampleIndex(1.0, 48000, 'round'), 48000);
  assert.equal(secondsToSampleIndex(0.5, 44100, 'round'), 22050);
  assert.equal(sampleIndexToSeconds(48000, 48000), 1.0);

  // Anti-aliased downsampling 48kHz -> 16kHz preserves 1kHz tone and attenuates 14kHz above Nyquist (8kHz)
  const sr48 = 48000;
  const n48 = 24000; // 0.5s
  const sig1k = DspReferenceFixtures.sineWave(n48, sr48, 1000, 0.5);
  const sig14k = DspReferenceFixtures.sineWave(n48, sr48, 14000, 0.5);
  const mixed = new Float32Array(n48);
  for (let i = 0; i < n48; i++) mixed[i] = sig1k[i] + sig14k[i];

  const down16 = resamplePlanarAudio({ channels: [mixed], sourceSampleRate: 48000, targetSampleRate: 16000 }).channels[0];
  assert.equal(down16.length, 8000);
  const domDown = dominantFrequencyHz(down16, 16000);
  assert.ok(Math.abs(domDown - 1000) <= 40, `Expected ~1000Hz after downsample, got ${domDown}Hz`);

  const aliasTest = resamplePlanarAudio({ channels: [sig14k], sourceSampleRate: 48000, targetSampleRate: 16000 }).channels[0];
  const aliasInterior = aliasTest.subarray(200, aliasTest.length - 200);
  const aliasMetrics = inspectNumericalIntegrity([aliasInterior]);
  assert.ok(aliasMetrics.peakAmplitude < 0.01, `Steady-state aliasing energy too high: peak=${aliasMetrics.peakAmplitude}`);

  // Upsampling 16kHz -> 48kHz preserves 1kHz pitch accurately
  const sig16 = DspReferenceFixtures.sineWave(4000, 16000, 1000, 0.5);
  const up48 = resamplePlanarAudio({ channels: [sig16], sourceSampleRate: 16000, targetSampleRate: 48000 }).channels[0];
  assert.equal(up48.length, 12000);
  const domUp = dominantFrequencyHz(up48, 48000);
  assert.ok(Math.abs(domUp - 1000) <= 40, `Expected ~1000Hz after upsample, got ${domUp}Hz`);

  // Explicit multichannel downmix (stereo & 5.1 -> mono)
  const left = DspReferenceFixtures.sineWave(1600, 16000, 440, 0.6);
  const right = DspReferenceFixtures.sineWave(1600, 16000, 440, 0.6);
  const monoEq = convertChannelLayout({
    channels: [left, right],
    targetLayout: 'mono',
    downmixPolicy: 'equal_amplitude_0_5',
  });
  assert.equal(monoEq.length, 1);
  assert.ok(Math.abs(monoEq[0][10] - left[10]) < 1e-5);

  const surround51 = [left, right, left, new Float32Array(left.length), left, right];
  const mono51 = convertChannelLayout({
    channels: surround51,
    targetLayout: 'mono',
  });
  assert.equal(mono51.length, 1);
  assert.equal(mono51[0].length, left.length);

  // Edge fades eliminate abrupt step boundaries without clipping
  const step = DspReferenceFixtures.abruptStepTransition(1600, 800, 0.8, 0.8);
  const faded = applyFadeInOut({
    channels: [new Float32Array(step)],
    fadeInSamples: 160,
    fadeOutSamples: 160,
    curve: 'smooth-cosine',
  })[0];
  assert.ok(Math.abs(faded[0]) < 1e-4, 'Fade-in must start at zero');
  assert.ok(Math.abs(faded[faded.length - 1]) < 1e-4, 'Fade-out must end at zero');

  // Digital silence vs low-level ambient classification
  const digSil = DspReferenceFixtures.digitalSilence(3200);
  const nearSil = DspReferenceFixtures.nearSilence(3200, 0.002);
  assert.equal(classifySilenceWindow(digSil, 0, digSil.length).classification, 'DIGITAL_SILENCE');
  assert.equal(classifySilenceWindow(nearSil, 0, nearSil.length).classification, 'LOW_LEVEL_AMBIENT');

  // Numerical integrity rejects NaN and Infinity
  const corrupt = new Float32Array([0.1, Number.NaN, 0.2]);
  assert.throws(
    () =>
      createCanonicalAudioBuffer({
        assetId: 'bad-nan',
        sourceSha256: '0'.repeat(64),
        sampleRate: 16000,
        channels: [corrupt],
      }),
    /NON_FINITE|NUMERICAL_INTEGRITY|NaN/i,
  );
});

test('AVP-P0-008: deterministic sample-accurate timeline editing & independent WAV decode-back verification (PCM16, PCM24, Float32)', async () => {
  const sr = 16000;
  const tone = DspReferenceFixtures.sineWave(sr * 2, sr, 500, 0.5); // 32,000 samples
  const buf = createCanonicalAudioBuffer({
    assetId: 'dsp-ref-1',
    sourceSha256: 'b'.repeat(64),
    sampleRate: sr,
    channels: [tone],
  });

  // Cut middle 0.5s (8000 samples) -> exact output length 24000 samples
  const timeline = executeSampleAccurateTimeline({
    source: buf,
    operations: [
      {
        opId: 'cut-mid',
        kind: 'DELETE_RANGE',
        startSample: 8000,
        endSample: 16000,
        crossfadeSamples: 0,
      },
    ],
  });
  assert.equal(timeline.ok, true);
  assert.equal(timeline.outputFrameCount, 24000);

  for (const encoding of ['pcm16', 'pcm24', 'float32'] as const) {
    const r1 = await renderAndVerifyDeterministicWav({
      renderId: `det-${encoding}-1`,
      channels: timeline.channels,
      sourceSampleRate: 16000,
      outputSampleRate: 16000,
      targetLayout: 'mono',
      encoding,
    });
    const r2 = await renderAndVerifyDeterministicWav({
      renderId: `det-${encoding}-2`,
      channels: timeline.channels,
      sourceSampleRate: 16000,
      outputSampleRate: 16000,
      targetLayout: 'mono',
      encoding,
    });
    assert.equal(r1.ok, true, `WAV ${encoding} verification failed: ${r1.errorMessage ?? ''}`);
    assert.equal(r1.outputHash, r2.outputHash, `Non-deterministic WAV ${encoding} export`);
    assert.equal(r1.verifiedFrames, 24000);
    assert.ok(r1.wavBytes && r1.wavBytes.byteLength > 44);

    const decoded = decodeWaveArtifactToPlanarFloat32(r1.wavBytes);
    assert.equal(decoded.sampleRate, 16000);
    assert.equal(decoded.channelCount, 1);
    assert.equal(decoded.frameCount, 24000);
  }
});

test('AVP-P0-003: full end-to-end project workflow (Import -> Transcribe -> Analyze -> Review -> Approve/Reject/Modify -> Apply -> Undo/Redo -> Persist/Recover -> Export WAV + Source-Change Invalidation)', async () => {
  const sr = 16000;
  const audio = new Float32Array(sr * 3);
  const segA = DspReferenceFixtures.sineWave(sr, sr, 440, 0.4);
  const segC = DspReferenceFixtures.sineWave(sr, sr, 660, 0.4);
  audio.set(segA, 0);
  audio.set(segC, sr * 2);

  const engine = new CanonicalProjectWorkflowEngine({
    projectId: 'proj-e2e-001',
    projectName: 'پادکست تست فارسی',
    nowMs: 1700000000000,
  });

  const imported = await engine.importAndValidateAudio({
    sourceAudioId: 'src-01',
    fileName: 'podcast.wav',
    sampleRate: sr,
    channels: [audio],
  });
  assert.equal(imported.frameCount, sr * 3);
  assert.equal(engine.getState().stage, 'AUDIO_IMPORTED');

  const canonicalTranscript: AvapardazTranscriptResult = {
    contractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
    jobId: 'job-e2e-1',
    runtimeTarget: 'BROWSER_WASM_CPU',
    runtimeName: 'Browser Local Runtime',
    executionProvider: 'wasm',
    modelId: 'fa-fastconformer-ctc-int8',
    modelVersion: '1.0.0',
    modelSha256Hex: 'c'.repeat(64),
    architecture: 'FASTCONFORMER_CTC',
    normalizationVersion: '1.2.0-avp-fa',
    offlineVerified: true,
    sampleRateHz: sr,
    durationSec: 3.0,
    processingTimeMs: 120,
    realTimeFactor: 0.04,
    dominantLanguage: 'fa',
    rawText: 'ام دنیا',
    normalizedText: 'ام دنیا',
    timestampGranularity: 'WORD',
    segments: [
      {
        id: 's1',
        index: 0,
        startSec: 0.0,
        endSec: 0.9,
        startSample16k: 0,
        endSample16k: 14400,
        rawText: 'ام',
        normalizedText: 'ام',
        language: 'fa',
        confidence: 0.88,
        timestampGranularity: 'WORD',
        words: [
          { word: 'ام', normalizedWord: 'ام', startSec: 0.45, endSec: 0.85, startSample16k: 7200, endSample16k: 13600, confidence: 0.88 },
        ],
      },
      {
        id: 's2',
        index: 1,
        startSec: 0.85,
        endSec: 2.9,
        startSample16k: 13600,
        endSample16k: 46400,
        rawText: 'دنیا',
        normalizedText: 'دنیا',
        language: 'fa',
        confidence: 0.93,
        timestampGranularity: 'WORD',
        words: [{ word: 'دنیا', normalizedWord: 'دنیا', startSec: 2.1, endSec: 2.8, startSample16k: 33600, endSample16k: 44800, confidence: 0.93 }],
      },
    ],
    peakMemoryBytes: 32 * 1024 * 1024,
  };

  const tr = engine.attachVerifiedTranscriptResult(canonicalTranscript);
  assert.equal(tr.segments.length, 2);
  assert.ok(tr.timestampRepairs.length >= 1);

  const suggestions = engine.analyzeSpeechAndGenerateSuggestions({ minSilenceDurationSec: 0.5 });
  assert.ok(suggestions.length >= 2);
  assert.equal(engine.getState().decisions.every((d) => d.state === 'PENDING'), true);

  const firstDec = engine.getState().decisions[0];
  engine.reviewDecision({ decisionId: firstDec.decisionId, action: 'APPROVE', note: 'Approved by editor' });
  if (engine.getState().decisions.length > 1) {
    engine.reviewDecision({
      decisionId: engine.getState().decisions[1].decisionId,
      action: 'REJECT',
      note: 'Keep natural pause',
    });
  }
  assert.equal(engine.getState().decisions[0].state, 'APPROVED');

  const beforeSourceFirstSample = engine.getSourceBuffer()!.channels[0][100];
  const applied = engine.applyApprovedDecisions();
  assert.equal(applied.appliedCount, 1);
  assert.equal(engine.getSourceBuffer()!.channels[0][100], beforeSourceFirstSample);
  assert.equal(engine.getState().decisions[0].state, 'APPLIED');

  assert.equal(engine.undo(), true);
  assert.equal(engine.getState().decisions[0].state, 'UNDONE');
  assert.equal(engine.redo(), true);
  assert.equal(engine.getState().decisions[0].state, 'APPLIED');

  const exported = await engine.exportValidatedWav({ encoding: 'pcm16' });
  assert.equal(exported.ok, true);
  assert.ok(exported.exportRecord);
  assert.ok(exported.wavBytes && exported.wavBytes.byteLength > 44);
  assert.ok(exported.exportRecord.verifiedFrames < sr * 3);

  // Atomic save + simulated interrupted save recovery
  const saved = engine.saveAtomically(false);
  assert.equal(saved.ok, true);
  const interrupted = engine.saveAtomically(true);
  assert.equal(interrupted.ok, false);
  const lastGood = engine.getLastCommittedPersistenceJson();
  assert.ok(lastGood);

  const reloaded = new CanonicalProjectWorkflowEngine({ projectId: 'tmp', projectName: 'tmp' });
  const res = reloaded.restoreFromSerializedEnvelope(lastGood);
  assert.equal(res.ok, true);
  assert.equal(reloaded.getState().projectId, 'proj-e2e-001');
  assert.equal(reloaded.getState().decisions.length, engine.getState().decisions.length);

  const newAudio = DspReferenceFixtures.sineWave(Math.floor(sr * 1.5), sr, 330, 0.3);
  await engine.importAndValidateAudio({
    sourceAudioId: 'src-02',
    fileName: 'different.wav',
    sampleRate: sr,
    channels: [newAudio],
  });
  assert.equal(engine.getState().transcript?.invalidated, true);
  assert.equal(engine.getState().decisions.every((d) => d.state === 'INVALIDATED'), true);
});
