import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeMath } from '../contracts/timebase.contract';
import { PersianWordToken } from '../contracts/v1_2';
import {
  SPEECH_EVENT_ENGINE_VERSION,
  SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
  SpeechEvent,
} from '../ai-engine/speech-events/SpeechEventContracts';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import { AudioRenderEngine } from './AudioRenderEngine';
import { createPlanarArrayPcmSource } from './AudioSourceReader';
import { StreamingByteSink } from './AudioExportWriter';
import { parseWaveContainerBytes } from './AudioRenderValidator';
import { InMemoryRenderCheckpointStore } from './AudioRenderRecovery';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';

function makeFillerSpeechEvent(params: {
  id: string;
  startSec: number;
  endSec: number;
}): SpeechEvent {
  const startFlicks = TimeMath.secondsToFlicks(params.startSec);
  const endFlicks = TimeMath.secondsToFlicks(params.endSec);
  return {
    eventId: params.id,
    trackId: 'track-main',
    category: 'FILLER',
    subtype: 'VOCAL_FILLED_PAUSE',
    detectionState: 'DETECTED',
    startSec: params.startSec,
    endSec: params.endSec,
    durationSec: params.endSec - params.startSec,
    startFlicks,
    endFlicks,
    durationFlicks: endFlicks - startFlicks,
    relatedTokenIds: [`tok-${params.id}`],
    relatedText: 'اممم',
    acousticEvidence: {
      rmsDb: -26,
      peakDb: -16,
      noiseFloorDbfs: -54,
      vadSpeechRatio: 0.85,
      vadActiveOverlap: false,
      digitalZeroRatio: 0,
    },
    linguisticEvidence: {
      matchedLexiconId: 'fa_vocal_filler_omm',
      canonicalForm: 'اممم',
      linguisticRole: 'VOCAL_FILLED_PAUSE',
    },
    detectionMethod: 'HYBRID_HEURISTIC_FUSION',
    confidence: 0.94,
    uncertaintyState: 'LOW_UNCERTAINTY',
    scores: {
      acousticScore: 0.92,
      linguisticScore: 0.95,
      ruleEvidenceCount: 3,
      modelTokenConfidence: 0.96,
      combinedDecisionScore: 0.94,
      calibratedProbability: null,
      scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      conflicts: [],
    },
    provenance: {
      engineVersion: SPEECH_EVENT_ENGINE_VERSION,
      thresholdConfigVersion: SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
      detectorModule: 'test-fixture',
      capabilityMode: 'heuristic',
    },
    eligibleForEditSuggestion: true,
    requiresHumanReview: false,
    explanationFa: 'تپق صوتی تست',
  };
}

function makeFillerToken(params: {
  id: string;
  startSec: number;
  endSec: number;
}): PersianWordToken {
  return {
    id: `tok-${params.id}`,
    trackId: 'track-main',
    speakerName: 'گوینده',
    originalText: 'اممم',
    normalizedText: 'اممم',
    displayText: 'اممم',
    range: {
      startFlicks: TimeMath.secondsToFlicks(params.startSec),
      endFlicks: TimeMath.secondsToFlicks(params.endSec),
    },
    confidence: 0.96,
    alignmentSource: 'ForcedAlignment',
    alignmentPrecision: 'forced_aligned',
    isDisfluency: true,
  };
}

/**
 * Simulated persistent disk/OPFS byte sink that retains written bytes across pause/resume
 * so checkpoint recovery can be verified byte-for-byte.
 */
class PersistentInMemorySink implements StreamingByteSink {
  public readonly persistedExternally = true;
  private buffer = new Uint8Array(0);

  public append(bytes: Uint8Array): void {
    const next = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
    next.set(this.buffer, 0);
    next.set(bytes, this.buffer.byteLength);
    this.buffer = next;
  }

  public writeAt(offset: number, bytes: Uint8Array): void {
    const required = offset + bytes.byteLength;
    if (required > this.buffer.byteLength) {
      const next = new Uint8Array(required);
      next.set(this.buffer, 0);
      this.buffer = next;
    }
    this.buffer.set(bytes, offset);
  }

  public finalizeTempToCommitted(): void {
    // Persistent file atomically promoted
  }

  public abortAndCleanup(): void {
    this.buffer = new Uint8Array(0);
  }

  public readAllBytes(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  public getTotalBytesWritten(): number {
    return this.buffer.byteLength;
  }
}

function decodeFloat32WavSamples(wavBytes: Uint8Array): Float32Array {
  const parsed = parseWaveContainerBytes(wavBytes);
  assert.equal(parsed.valid, true, parsed.error);
  assert.equal(parsed.encoding, 'float32');
  const view = new DataView(
    wavBytes.buffer,
    wavBytes.byteOffset + parsed.dataOffsetBytes,
    parsed.dataByteLength,
  );
  const out = new Float32Array(parsed.sampleCountPerChannel);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

test('AudioRenderEngine centered crossfade produces monotonic, click-free transition with zero backward jump and exact sample count', async () => {
  const sampleRate = 48_000 as const;
  const totalSamples = sampleRate * 2; // 2.0s
  // Constant -0.5 before cut [0..1.0s), +0.5 after cut [1.0s..2.0s)
  // Cut removes [0.5s..1.0s), leaving 1.5s (72000 samples).
  // With pre-roll/post-roll: left side around cut is -0.5, right side around cut is +0.5.
  const mono = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    mono[i] = i < sampleRate * 0.75 ? -0.5 : 0.5;
  }

  const edl0 = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-xfade',
      sourceAudioId: 'src-xfade',
      sourceAudioHash: 'sha256:xfade-test',
      transcriptVersion: 'tr-1',
      sampleRate,
      channelLayout: 'mono',
      totalSourceSamples: totalSamples,
    },
    events: [makeFillerSpeechEvent({ id: 'ev-1', startSec: 0.5, endSec: 1.0 })],
    tokens: [makeFillerToken({ id: 'ev-1', startSec: 0.5, endSec: 1.0 })],
    nowMs: 1000,
  });

  const approved = EditDecisionEngine.approveProposal(edl0, edl0.proposals[0].proposalId, {
    nowMs: 1001,
  });
  assert.equal(approved.ok, true, approved.failure?.message);

  const engine = new AudioRenderEngine({
    memoryBudgetManager: new MemoryBudgetManager(),
  });

  const res = await engine.render({
    edl: approved.snapshot,
    source: createPlanarArrayPcmSource({
      sourceAudioId: 'src-xfade',
      sourceAudioHash: 'sha256:xfade-test',
      sampleRate,
      channels: [mono],
    }),
    expectedSourceAudioHash: 'sha256:xfade-test',
    expectedTranscriptVersion: 'tr-1',
    expectedEdlVersion: approved.snapshot.edlVersion,
    config: {
      encoding: 'float32',
      container: 'wav',
      defaultCrossfadeMs: 10, // 480 samples
      maxBoundaryAdjustmentSamples: 0, // disable shift to test pure crossfade waveform
      crossfadeCurve: 'linear',
    },
    nowMs: 1002,
  });

  assert.equal(res.ok, true, res.failureReason);
  assert.equal(res.state, 'COMPLETED');
  assert.ok(res.outputBytes);
  assert.equal(res.output?.totalOutputSamples, res.plan?.expectedOutputSamples);

  const outSamples = decodeFloat32WavSamples(res.outputBytes);
  assert.equal(outSamples.length, res.plan!.expectedOutputSamples);

  // Inspect transition neighborhood around cut index (0.5s = 24000 samples)
  const cutSample = res.plan!.retainedSegments[0].sampleCount;
  const winStart = cutSample - 300;
  const winEnd = cutSample + 300;
  let maxStep = 0;
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = winStart + 1; i < winEnd; i++) {
    const diff = outSamples[i] - outSamples[i - 1];
    // Monotonic non-decreasing from -0.5 to +0.5 (tiny float tolerance 1e-4)
    assert.ok(
      diff >= -1e-4,
      `Detected backward time jump / non-monotonic drop at sample ${i}: ${outSamples[i - 1]} -> ${outSamples[i]}`,
    );
    if (Math.abs(diff) > maxStep) maxStep = Math.abs(diff);
    if (outSamples[i] < minVal) minVal = outSamples[i];
    if (outSamples[i] > maxVal) maxVal = outSamples[i];
  }
  // Smooth transition: max sample-to-sample step across 480-sample ramp from -0.5 to +0.5 is ~1/479 (~0.0021)
  assert.ok(maxStep < 0.01, `Expected smooth crossfade step < 0.01, got ${maxStep}`);
  assert.ok(minVal <= -0.49 && maxVal >= 0.49);
});

test('AudioRenderEngine genuinely applies length-preserving acoustic boundary shift while preserving exact output sample count', async () => {
  const sampleRate = 48_000 as const;
  const totalSamples = sampleRate * 2;
  // Construct a waveform with a sharp discontinuity at the nominal cut boundary (24000 vs 48000),
  // but clean zero values shifted +12 samples forward (24012 vs 48012).
  const mono = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    mono[i] = 0.05 * Math.sin((2 * Math.PI * 100 * i) / sampleRate);
  }
  // Inject opposing polarity impulse right at the nominal boundary [23990..24005] and [47995..48005]
  for (let i = 23990; i < 24006; i++) mono[i] = 0.25;
  for (let i = 47995; i < 48006; i++) mono[i] = -0.25;
  // Smooth matching zero-crossing right at +12 samples (left index 24011, right index 48012)
  for (let i = 24006; i < 24030; i++) mono[i] = 0;
  for (let i = 48006; i < 48030; i++) mono[i] = 0;

  const edl0 = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-bnd',
      sourceAudioId: 'src-bnd',
      sourceAudioHash: 'sha256:bnd-test',
      transcriptVersion: 'tr-1',
      sampleRate,
      channelLayout: 'mono',
      totalSourceSamples: totalSamples,
    },
    events: [makeFillerSpeechEvent({ id: 'ev-bnd', startSec: 0.5, endSec: 1.0 })],
    tokens: [makeFillerToken({ id: 'ev-bnd', startSec: 0.5, endSec: 1.0 })],
    nowMs: 2000,
  });

  const approved = EditDecisionEngine.approveProposal(edl0, edl0.proposals[0].proposalId, {
    nowMs: 2001,
  });
  assert.equal(approved.ok, true, approved.failure?.message);

  const engine = new AudioRenderEngine({
    memoryBudgetManager: new MemoryBudgetManager(),
  });
  const res = await engine.render({
    edl: approved.snapshot,
    source: createPlanarArrayPcmSource({
      sourceAudioId: 'src-bnd',
      sourceAudioHash: 'sha256:bnd-test',
      sampleRate,
      channels: [mono],
    }),
    expectedSourceAudioHash: 'sha256:bnd-test',
    expectedTranscriptVersion: 'tr-1',
    expectedEdlVersion: approved.snapshot.edlVersion,
    config: {
      encoding: 'float32',
      container: 'wav',
      defaultCrossfadeMs: 3,
      maxBoundaryAdjustmentSamples: 32,
    },
    nowMs: 2002,
  });

  assert.equal(res.ok, true, res.failureReason);
  assert.equal(res.boundaryChecks.length, 1);
  const bc = res.boundaryChecks[0];
  assert.equal(bc.adjustmentApplied, true);
  assert.equal(bc.leftAdjustmentSamples, bc.rightAdjustmentSamples);
  assert.notEqual(bc.leftAdjustmentSamples, 0);
  // Exact total output samples must still match plan with 0 drift!
  assert.equal(res.output?.totalOutputSamples, res.plan?.expectedOutputSamples);
  assert.equal(res.postValidation?.passed, true);
});

test('AudioRenderEngine pause and persistent-sink checkpoint resume produces byte-for-byte identical WAV output and hash', async () => {
  const sampleRate = 48_000 as const;
  const totalSamples = sampleRate * 2; // 96000 samples
  const mono = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    mono[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }

  const edl0 = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-resume',
      sourceAudioId: 'src-resume',
      sourceAudioHash: 'sha256:resume-test',
      transcriptVersion: 'tr-1',
      sampleRate,
      channelLayout: 'mono',
      totalSourceSamples: totalSamples,
    },
    events: [makeFillerSpeechEvent({ id: 'ev-r1', startSec: 0.6, endSec: 0.9 })],
    tokens: [makeFillerToken({ id: 'ev-r1', startSec: 0.6, endSec: 0.9 })],
    nowMs: 3000,
  });
  const approved = EditDecisionEngine.approveProposal(edl0, edl0.proposals[0].proposalId, {
    nowMs: 3001,
  });
  assert.equal(approved.ok, true, approved.failure?.message);

  const source = createPlanarArrayPcmSource({
    sourceAudioId: 'src-resume',
    sourceAudioHash: 'sha256:resume-test',
    sampleRate,
    channels: [mono],
  });

  // 1. Reference uninterrupted render
  const refEngine = new AudioRenderEngine({
    memoryBudgetManager: new MemoryBudgetManager(),
  });
  const refResult = await refEngine.render({
    edl: approved.snapshot,
    source,
    expectedSourceAudioHash: 'sha256:resume-test',
    expectedTranscriptVersion: 'tr-1',
    expectedEdlVersion: approved.snapshot.edlVersion,
    config: {
      encoding: 'pcm16',
      container: 'wav',
      chunkSizeSamples: 4096,
      defaultCrossfadeMs: 10,
      maxBoundaryAdjustmentSamples: 64,
    },
    nowMs: 3002,
  });
  assert.equal(refResult.ok, true, refResult.failureReason);
  assert.ok(refResult.outputBytes);

  // 2. Paused render onto a persistent sink, followed by resumeFromCheckpoint onto the SAME sink
  const persistentSink = new PersistentInMemorySink();
  const checkpointStore = new InMemoryRenderCheckpointStore();
  const resumeEngine = new AudioRenderEngine({
    memoryBudgetManager: new MemoryBudgetManager(),
    checkpointStore,
    createSink: () => persistentSink,
  });

  let pauseChecks = 0;
  const pausedResult = await resumeEngine.render({
    edl: approved.snapshot,
    source,
    expectedSourceAudioHash: 'sha256:resume-test',
    expectedTranscriptVersion: 'tr-1',
    expectedEdlVersion: approved.snapshot.edlVersion,
    config: {
      encoding: 'pcm16',
      container: 'wav',
      chunkSizeSamples: 4096,
      defaultCrossfadeMs: 10,
      maxBoundaryAdjustmentSamples: 64,
    },
    // Pause after 3 chunks have been written
    shouldPauseUser: () => ++pauseChecks > 3,
    nowMs: 3002,
  });

  assert.equal(pausedResult.ok, false);
  assert.equal(pausedResult.state, 'PAUSED_USER');
  assert.ok(pausedResult.checkpoint);
  assert.ok(pausedResult.checkpoint.writtenOutputSamples > 0);
  // Persistent sink MUST preserve the header + writtenDataBytes across pause
  assert.equal(
    persistentSink.getTotalBytesWritten(),
    44 + pausedResult.checkpoint.writtenDataBytes,
  );

  // Resume using the saved checkpoint onto the same persistent sink
  const resumedResult = await resumeEngine.resumeFromCheckpoint(
    {
      edl: approved.snapshot,
      source,
      expectedSourceAudioHash: 'sha256:resume-test',
      expectedTranscriptVersion: 'tr-1',
      expectedEdlVersion: approved.snapshot.edlVersion,
      config: {
        encoding: 'pcm16',
        container: 'wav',
        chunkSizeSamples: 4096,
        defaultCrossfadeMs: 10,
        maxBoundaryAdjustmentSamples: 64,
      },
      nowMs: 3002,
    },
    pausedResult.checkpoint,
  );

  assert.equal(resumedResult.ok, true, resumedResult.failureReason);
  assert.equal(resumedResult.state, 'COMPLETED');
  assert.equal(resumedResult.postValidation?.passed, true);
  assert.ok(resumedResult.outputBytes);
  assert.equal(resumedResult.output?.outputHash, refResult.output?.outputHash);
  assert.deepEqual(resumedResult.outputBytes, refResult.outputBytes);
});
