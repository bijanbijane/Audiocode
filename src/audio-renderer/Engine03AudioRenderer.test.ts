/**
 * AVP-ENGINE03-001 — Comprehensive 30-Scenario Verification Suite for Engine 03 (Audio Renderer)
 *
 * Tests the canonical Engine 03 stack (AudioRenderEngine, AudioRenderPlanner, AudioSegmentAssembler,
 * AudioBoundaryProcessor, AudioCrossfadeProcessor, AudioExportWriter, AudioRenderValidator,
 * SmartEditPreviewRenderer, RenderOutputArtifact) and its real integration with Engine 02,
 * StudioWorkflowController, CanonicalProjectWorkflowEngine, SmartAudioEditPipeline, and WavNativeDecoder.
 *
 * Every audio assertion decodes the actual exported WAV/RF64 bytes back into PCM samples and verifies
 * exact container metadata, sample count, sample rate, channel count, amplitude integrity, and content.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AudioExportWriter,
  AudioRenderEngine,
  AudioRenderPlanner,
  AudioRenderValidator,
  BoundedChunkedByteSink,
  ExportWriteFailureError,
  SmartEditPreviewRenderer,
  createCommittedRenderArtifact,
  createPlanarArrayPcmSource,
  mapOutputSampleToSourceSample,
  mapSourceSampleToOutputSample,
  parseWaveHeaderBytes,
  readRenderArtifactToUint8Array,
} from './index';
import type {
  AudioRenderConfig,
  ChunkedPcmSource,
  RenderExportEncoding,
} from './AudioRenderTypes';
import type { RenderArtifactReader, StreamingByteSink } from './AudioExportWriter';
import {
  EDIT_DECISION_ENGINE_VERSION,
  EDL_SCHEMA_VERSION,
  type EditDecisionListSnapshot,
  type EditProposal,
  type EditProposalProvenance,
  type EditRiskAssessment,
  type SourceSampleInterval,
} from '../ai-engine/edit-decision/EditDecisionTypes';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import { analyzeShahabOutputWithEngine02 } from '../ai-engine/edit-decision/ShahabToEngine02Adapter';
import { SPEECH_EVENT_ENGINE_VERSION, SPEECH_EVENT_THRESHOLD_CONFIG_VERSION } from '../ai-engine/speech-events/SpeechEventContracts';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { decodeNativeWavToPlanar } from '../workflow/WavNativeDecoder';
import { StudioWorkflowController } from '../workflow/StudioWorkflowController';
import { CanonicalProjectWorkflowEngine } from '../workflow/CanonicalProjectWorkflowEngine';
import { SmartAudioEditPipeline } from '../workflow/SmartAudioEditPipeline';
import { FLICKS_PER_SECOND, TimeMath, type SampleRate } from '../contracts/timebase.contract';
import type { TranscriptDocument } from '../workflow/SmartAudioEditContracts';
import { AVAPARDAZ_ASR_CONTRACT_VERSION } from '../asr-core/UnifiedLocalAsrRuntime';
import { PERSIAN_NORMALIZATION_CONTRACT_VERSION } from '../lifecycle/CanonicalModelProvenance';

// ---------------------------------------------------------------------------
// Deterministic Fixture Helpers
// ---------------------------------------------------------------------------

function hashChannelsSha256(channels: readonly Float32Array[]): string {
  const h = crypto.createHash('sha256');
  for (const ch of channels) {
    h.update(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength));
  }
  return h.digest('hex');
}

function makeSineChannel(
  length: number,
  sampleRate: number,
  freqHz: number,
  amplitude = 0.5,
  phaseOffset = 0,
): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate + phaseOffset);
  }
  return out;
}

function makeSegmentedFixture(
  sampleRate: SampleRate,
  segments: ReadonlyArray<{ readonly samples: number; readonly freqHz: number; readonly amp: number }>,
): Float32Array {
  const total = segments.reduce((acc, s) => acc + s.samples, 0);
  const out = new Float32Array(total);
  let cursor = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.samples; i++) {
      out[cursor + i] =
        seg.amp === 0 ? 0 : seg.amp * Math.sin((2 * Math.PI * seg.freqHz * i) / sampleRate);
    }
    cursor += seg.samples;
  }
  return out;
}

function rmsRange(samples: Float32Array, start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(samples.length, end);
  if (e <= s) return 0;
  let sumSq = 0;
  for (let i = s; i < e; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / (e - s));
}

function makeInterval(startSample: number, endSample: number, sampleRate: SampleRate): SourceSampleInterval {
  const startFlicks = TimeMath.samplesToFlicks(startSample, sampleRate);
  const endFlicks = TimeMath.samplesToFlicks(endSample, sampleRate);
  return {
    startSample,
    endSample,
    sampleRate,
    timebaseFlicksPerSecond: FLICKS_PER_SECOND,
    startFlicks,
    endFlicks,
    startSec: startSample / sampleRate,
    endSec: endSample / sampleRate,
    durationMs: ((endSample - startSample) / sampleRate) * 1000,
  };
}

function makeTestProposal(params: {
  readonly id: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRate: SampleRate;
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly transcriptVersion: string;
  readonly status?: EditProposal['status'];
  readonly operation?: EditProposal['operation'];
  readonly protectedEvent?: boolean;
  readonly relatedText?: string;
}): EditProposal {
  const status = params.status ?? 'APPROVED';
  const operation = params.operation ?? 'REMOVE_FILLER';
  const risk: EditRiskAssessment = {
    overallLevel: 'LOW',
    dimensions: [],
    heuristicRankingScore: 0.1,
    scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
    automaticApprovalEligible: false,
    approvalPermitted: true,
    mandatoryHumanReview: false,
    blockingReasons: [],
  };
  const provenance: EditProposalProvenance = {
    projectId: 'proj-e03-test',
    sourceAudioId: params.sourceAudioId,
    sourceAudioHash: params.sourceAudioHash,
    transcriptVersion: params.transcriptVersion,
    speechEventSourceIds: [`ev_${params.id}`],
    eventDetectorVersion: SPEECH_EVENT_ENGINE_VERSION,
    decisionEngineVersion: EDIT_DECISION_ENGINE_VERSION,
    modelVersions: {},
    lexiconVersion: '1.0.0',
    thresholdConfigVersion: SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
  };
  const interval = makeInterval(params.startSample, params.endSample, params.sampleRate);
  return {
    proposalId: params.id,
    proposalVersion: 1,
    projectId: 'proj-e03-test',
    trackId: 'track-main',
    sourceAudioId: params.sourceAudioId,
    sourceAudioHash: params.sourceAudioHash,
    transcriptVersion: params.transcriptVersion,
    speechEventSourceIds: [`ev_${params.id}`],
    eventDetectorVersion: SPEECH_EVENT_ENGINE_VERSION,
    modelVersions: {},
    lexiconVersion: '1.0.0',
    timebaseFlicksPerSecond: FLICKS_PER_SECOND,
    sampleRate: params.sampleRate,
    originalRange: interval,
    proposedRange: interval,
    operation,
    eventCategory: operation === 'SHORTEN_SILENCE' ? 'SILENCE' : 'FILLER',
    eventSubtype: operation === 'SHORTEN_SILENCE' ? 'LONG_UNNECESSARY_SILENCE' : 'VOCAL_FILLED_PAUSE',
    candidateEligibility: 'SAFE_EDIT_CANDIDATE',
    evidenceReferences: [],
    confidenceClassification: 'HIGH_HEURISTIC',
    eventConfidenceScore: 0.92,
    scoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
    calibratedProbability: null,
    boundary: {
      valid: true,
      originalInterval: interval,
      proposedInterval: interval,
      measurementBasis: 'MEASURED_ACOUSTIC',
      boundaryConfidence: 'HIGH',
      boundaryConfidenceScore: 0.9,
      boundaryScoreCalibrationStatus: 'UNCALIBRATED_HEURISTIC',
      refinementMethod: 'test-fixture',
      leftSafetyMarginSamples: 0,
      rightSafetyMarginSamples: 0,
      phonemeBoundariesAvailable: false,
      appliedEvidence: [],
      warnings: [],
    },
    risk,
    requiresHumanReview: false,
    protectedEvent: params.protectedEvent ?? false,
    createdAtMs: 1700000000000,
    status,
    validationStatus: 'VALID',
    validationIssues: [],
    provenance,
    relatedTokenIds: [],
    relatedText: params.relatedText ?? params.id,
    explanationFa: `پیشنهاد تست ${params.id}`,
    conflictIds: [],
  };
}

function makeTestEdl(params: {
  readonly source: ChunkedPcmSource;
  readonly proposals: readonly EditProposal[];
  readonly edlVersion?: number;
  readonly transcriptVersion?: string;
}): EditDecisionListSnapshot {
  const edlVersion = params.edlVersion ?? 1;
  const transcriptVersion = params.transcriptVersion ?? 'tr_v1';
  return {
    edlId: `edl_${params.source.sourceAudioId}`,
    edlSchemaVersion: EDL_SCHEMA_VERSION,
    edlVersion,
    projectId: 'proj-e03-test',
    sourceAudioId: params.source.sourceAudioId,
    sourceAudioHash: params.source.sourceAudioHash,
    transcriptVersion,
    timebaseFlicksPerSecond: FLICKS_PER_SECOND,
    sampleRate: params.source.sampleRate,
    totalSourceSamples: params.source.totalSamples,
    eventSourceVersions: {
      eventDetectorVersion: SPEECH_EVENT_ENGINE_VERSION,
      decisionEngineVersion: EDIT_DECISION_ENGINE_VERSION,
      lexiconVersion: '1.0.0',
      thresholdConfigVersion: SPEECH_EVENT_THRESHOLD_CONFIG_VERSION,
      modelVersions: {},
    },
    proposals: params.proposals,
    conflicts: [],
    validation: {
      isValid: true,
      status: 'VALID',
      errorCount: 0,
      warningCount: 0,
      failures: [],
    },
    decisionHistory: [],
    createdAtMs: 1700000000000,
    modifiedAtMs: 1700000000000,
    cancelled: false,
    processedEventCount: params.proposals.length,
    totalInputEventCount: params.proposals.length,
    persistenceStatus: 'IN_MEMORY_ONLY',
    persistenceNote: 'test-fixture',
  };
}

function makeSource(
  id: string,
  sampleRate: SampleRate,
  channels: readonly Float32Array[],
): { readonly source: ChunkedPcmSource; readonly sha256: string } {
  const sha256 = hashChannelsSha256(channels);
  const source = createPlanarArrayPcmSource({
    sourceAudioId: id,
    sourceAudioHash: sha256,
    sampleRate,
    channels,
  });
  return { source, sha256 };
}

function baseConfig(overrides: Partial<AudioRenderConfig> = {}): AudioRenderConfig {
  return {
    encoding: 'float32',
    container: 'wav',
    defaultCrossfadeMs: 0,
    maxBoundaryAdjustmentSamples: 0,
    enableTransitionLimiter: true,
    chunkSizeSamples: 4096,
    ...overrides,
  };
}

function makeByteReader(bytes: Uint8Array): RenderArtifactReader {
  return {
    sizeBytes: bytes.byteLength,
    readRange: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
    openReadStream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

async function encodeFixtureWavBytes(
  channels: readonly Float32Array[],
  sampleRate: SampleRate,
  encoding: RenderExportEncoding = 'pcm16',
): Promise<Uint8Array> {
  const sink = new BoundedChunkedByteSink();
  const writer = new AudioExportWriter({
    renderId: 'fixture_wav',
    artifactId: 'art_fixture_wav',
    container: 'wav',
    encoding,
    sampleRate,
    channelCount: channels.length,
    sink,
  });
  await writer.begin();
  await writer.writePlanarChunk(channels, channels[0].length);
  const meta = await writer.finalize();
  const art = createCommittedRenderArtifact({
    artifactId: meta.artifactId,
    sizeBytes: meta.fileSizeBytes,
    sink,
  });
  try {
    return await readRenderArtifactToUint8Array(art);
  } finally {
    await art.dispose();
  }
}

async function renderAndDecode(
  engine: AudioRenderEngine,
  source: ChunkedPcmSource,
  edl: EditDecisionListSnapshot,
  config: AudioRenderConfig = baseConfig(),
  proposalIds?: readonly string[],
) {
  const result = await engine.render({
    edl,
    source,
    expectedSourceAudioHash: source.sourceAudioHash,
    expectedTranscriptVersion: edl.transcriptVersion,
    expectedEdlVersion: edl.edlVersion,
    config,
    proposalIds,
  });
  let bytes: Uint8Array | null = null;
  let decoded = null;
  if (result.ok && result.outputArtifact) {
    try {
      bytes = await readRenderArtifactToUint8Array(result.outputArtifact);
      decoded = decodeNativeWavToPlanar(bytes);
    } finally {
      await result.outputArtifact.dispose();
    }
  }
  return { result, bytes, decoded };
}

// ---------------------------------------------------------------------------
// Scenarios 1–5: Identity & Boundary Cuts (Zero, Start, Middle, End, Multi)
// ---------------------------------------------------------------------------

test('S01 & S09: Zero-edit render & empty approved operations produce sample-for-sample identical WAV output', async () => {
  const budget = new MemoryBudgetManager();
  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const sr: SampleRate = 16000;
  const ch0 = makeSineChannel(8000, sr, 440, 0.6);
  const { source, sha256 } = makeSource('src-s01', sr, [ch0]);
  const edl = makeTestEdl({ source, proposals: [] });

  const { result, decoded } = await renderAndDecode(engine, source, edl, baseConfig({ encoding: 'float32' }));
  assert.equal(result.ok, true);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.appliedProposalIds.length, 0);
  assert.equal(result.postValidation?.passed, true);
  assert.ok(decoded !== null);
  assert.equal(decoded!.totalSamples, ch0.length);
  assert.equal(decoded!.sampleRate, sr);
  assert.equal(decoded!.channelCount, 1);
  for (let i = 0; i < ch0.length; i++) {
    assert.ok(Math.abs(decoded!.channels[0][i] - ch0[i]) < 1e-6, `Mismatch at sample ${i}`);
  }
  assert.equal(hashChannelsSha256([ch0]), sha256);
});

test('S02: Cut at start of file removes [0, 2000) and preserves remaining tail exactly', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const ch0 = makeSegmentedFixture(sr, [
    { samples: 2000, freqHz: 200, amp: 0.25 },
    { samples: 6000, freqHz: 880, amp: 0.7 },
  ]);
  const { source } = makeSource('src-s02', sr, [ch0]);
  const pStart = makeTestProposal({
    id: 'p-start',
    startSample: 0,
    endSample: 2000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
  });
  const edl = makeTestEdl({ source, proposals: [pStart] });

  const { result, decoded } = await renderAndDecode(engine, source, edl);
  assert.equal(result.ok, true, result.failureReason);
  assert.equal(decoded?.totalSamples, 6000);
  for (let i = 0; i < 6000; i++) {
    assert.ok(Math.abs(decoded!.channels[0][i] - ch0[2000 + i]) < 1e-6);
  }
});

test('S03: Cut in middle of file removes [3000, 5000) and joins prefix + suffix cleanly', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const ch0 = makeSegmentedFixture(sr, [
    { samples: 3000, freqHz: 300, amp: 0.4 },
    { samples: 2000, freqHz: 0, amp: 0 },
    { samples: 3000, freqHz: 900, amp: 0.75 },
  ]);
  const { source } = makeSource('src-s03', sr, [ch0]);
  const pMid = makeTestProposal({
    id: 'p-mid',
    startSample: 3000,
    endSample: 5000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
  });
  const edl = makeTestEdl({ source, proposals: [pMid] });

  const { result, decoded } = await renderAndDecode(engine, source, edl);
  assert.equal(result.ok, true, result.failureReason);
  assert.equal(decoded?.totalSamples, 6000);
  for (let i = 0; i < 3000; i++) {
    assert.ok(Math.abs(decoded!.channels[0][i] - ch0[i]) < 1e-6);
    assert.ok(Math.abs(decoded!.channels[0][3000 + i] - ch0[5000 + i]) < 1e-6);
  }
});

test('S04: Cut at end of file removes [6000, 8000) and preserves prefix exactly', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const ch0 = makeSegmentedFixture(sr, [
    { samples: 6000, freqHz: 500, amp: 0.65 },
    { samples: 2000, freqHz: 150, amp: 0.2 },
  ]);
  const { source } = makeSource('src-s04', sr, [ch0]);
  const pEnd = makeTestProposal({
    id: 'p-end',
    startSample: 6000,
    endSample: 8000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
  });
  const edl = makeTestEdl({ source, proposals: [pEnd] });

  const { result, decoded } = await renderAndDecode(engine, source, edl);
  assert.equal(result.ok, true, result.failureReason);
  assert.equal(decoded?.totalSamples, 6000);
  for (let i = 0; i < 6000; i++) {
    assert.ok(Math.abs(decoded!.channels[0][i] - ch0[i]) < 1e-6);
  }
});

test('S05 & S14: Multiple independent cuts preserve exact ordering and unmodified content of retained segments', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const ch0 = makeSegmentedFixture(sr, [
    { samples: 2000, freqHz: 250, amp: 0.2 },
    { samples: 1000, freqHz: 1000, amp: 0.9 },
    { samples: 2000, freqHz: 400, amp: 0.5 },
    { samples: 1500, freqHz: 1200, amp: 0.9 },
    { samples: 2000, freqHz: 600, amp: 0.8 },
    { samples: 500, freqHz: 1400, amp: 0.9 },
    { samples: 1000, freqHz: 350, amp: 0.35 },
  ]);
  const { source } = makeSource('src-s05', sr, [ch0]);
  const proposals = [
    makeTestProposal({
      id: 'p-cut-3',
      startSample: 8500,
      endSample: 9000,
      sampleRate: sr,
      sourceAudioId: source.sourceAudioId,
      sourceAudioHash: source.sourceAudioHash,
      transcriptVersion: 'tr_v1',
    }),
    makeTestProposal({
      id: 'p-cut-1',
      startSample: 2000,
      endSample: 3000,
      sampleRate: sr,
      sourceAudioId: source.sourceAudioId,
      sourceAudioHash: source.sourceAudioHash,
      transcriptVersion: 'tr_v1',
    }),
    makeTestProposal({
      id: 'p-cut-2',
      startSample: 5000,
      endSample: 6500,
      sampleRate: sr,
      sourceAudioId: source.sourceAudioId,
      sourceAudioHash: source.sourceAudioHash,
      transcriptVersion: 'tr_v1',
    }),
  ];
  const edl = makeTestEdl({ source, proposals });

  const { result, decoded } = await renderAndDecode(engine, source, edl);
  assert.equal(result.ok, true, result.failureReason);
  assert.equal(decoded?.totalSamples, 7000);
  const out = decoded!.channels[0];
  assert.ok(Math.abs(rmsRange(out, 100, 1900) - 0.2 / Math.SQRT2) < 0.01);
  assert.ok(Math.abs(rmsRange(out, 2100, 3900) - 0.5 / Math.SQRT2) < 0.01);
  assert.ok(Math.abs(rmsRange(out, 4100, 5900) - 0.8 / Math.SQRT2) < 0.01);
  assert.ok(Math.abs(rmsRange(out, 6100, 6900) - 0.35 / Math.SQRT2) < 0.01);
});

// ---------------------------------------------------------------------------
// Scenarios 6–8 & 10: Invalid Inputs, Overlaps, Negative/OOB, Approval Gate
// ---------------------------------------------------------------------------

test('S06: Overlapping approved ranges are cleanly rejected without rendering', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const { source } = makeSource('src-s06', sr, [makeSineChannel(8000, sr, 440)]);
  const edl = makeTestEdl({
    source,
    proposals: [
      makeTestProposal({
        id: 'p-ov-1',
        startSample: 2000,
        endSample: 4000,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
      makeTestProposal({
        id: 'p-ov-2',
        startSample: 3500,
        endSample: 5000,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });

  const { result } = await renderAndDecode(engine, source, edl);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'FAILED_VALIDATION');
  assert.ok(result.preValidation.failures.some((f) => f.code === 'DUPLICATE_OR_OVERLAPPING_REMOVAL'));
  assert.equal(result.outputArtifact, null);
});

test('S07 & S08: Negative sample coordinates and out-of-range coordinates are strictly rejected', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const { source } = makeSource('src-s07', sr, [makeSineChannel(4000, sr, 440)]);

  const edlNeg = makeTestEdl({
    source,
    proposals: [
      makeTestProposal({
        id: 'p-neg',
        startSample: -100,
        endSample: 500,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });
  const negRes = await renderAndDecode(engine, source, edlNeg);
  assert.equal(negRes.result.ok, false);
  assert.equal(negRes.result.state, 'FAILED_VALIDATION');
  assert.ok(negRes.result.preValidation.failures.some((f) => f.code === 'INVALID_SAMPLE_COORDINATES'));

  const edlOob = makeTestEdl({
    source,
    proposals: [
      makeTestProposal({
        id: 'p-oob',
        startSample: 3000,
        endSample: 9999,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });
  const oobRes = await renderAndDecode(engine, source, edlOob);
  assert.equal(oobRes.result.ok, false);
  assert.equal(oobRes.result.state, 'FAILED_VALIDATION');
  assert.ok(oobRes.result.preValidation.failures.some((f) => f.code === 'INVALID_SAMPLE_COORDINATES'));
});

test('S10: Unapproved proposals are explicitly rejected when requested and NEVER deleted in normal render', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const ch0 = makeSineChannel(8000, sr, 440, 0.6);
  const { source } = makeSource('src-s10', sr, [ch0]);
  const pUnapproved = makeTestProposal({
    id: 'p-pending',
    startSample: 2000,
    endSample: 4000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
    status: 'PROPOSED',
  });
  const pRejected = makeTestProposal({
    id: 'p-rejected',
    startSample: 4500,
    endSample: 6000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
    status: 'REJECTED',
  });
  const edl = makeTestEdl({ source, proposals: [pUnapproved, pRejected] });

  const targeted = await renderAndDecode(engine, source, edl, baseConfig(), ['p-pending']);
  assert.equal(targeted.result.ok, false);
  assert.equal(targeted.result.state, 'FAILED_VALIDATION');
  assert.ok(targeted.result.preValidation.failures.some((f) => f.code === 'UNAPPROVED_PROPOSAL'));

  const normal = await renderAndDecode(engine, source, edl);
  assert.equal(normal.result.ok, true);
  assert.equal(normal.result.appliedProposalIds.length, 0);
  assert.equal(normal.decoded?.totalSamples, 8000);
});

// ---------------------------------------------------------------------------
// Scenarios 11 & 12: Non-Destructive Preview & Preview-vs-Export Consistency
// ---------------------------------------------------------------------------

test('S11 & S12: Preview preserves source immutability and FULL preview matches Final Export byte-for-byte', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const previewRenderer = new SmartEditPreviewRenderer(engine);
  const sr: SampleRate = 16000;
  const ch0 = makeSegmentedFixture(sr, [
    { samples: 8000, freqHz: 320, amp: 0.5 },
    { samples: 4000, freqHz: 1100, amp: 0.7 },
    { samples: 8000, freqHz: 480, amp: 0.55 },
  ]);
  const { source, sha256 } = makeSource('src-s11-12', sr, [ch0]);
  const pCut = makeTestProposal({
    id: 'p-prev-cut',
    startSample: 8000,
    endSample: 12000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
    status: 'APPROVED',
  });
  const edl = makeTestEdl({ source, proposals: [pCut] });

  const origPrev = await previewRenderer.generatePreview({
    mode: 'ORIGINAL',
    source,
    edl,
    proposalId: 'p-prev-cut',
    contextPaddingMs: 400,
    crossfadeMs: 10,
    encoding: 'pcm16',
  });
  const editedPrev = await previewRenderer.generatePreview({
    mode: 'EDITED',
    source,
    edl,
    proposalId: 'p-prev-cut',
    contextPaddingMs: 400,
    crossfadeMs: 10,
    encoding: 'pcm16',
  });
  assert.equal(origPrev.ok, true, origPrev.failureReason);
  assert.equal(editedPrev.ok, true, editedPrev.failureReason);
  const decodedOrig = decodeNativeWavToPlanar(origPrev.wavBytes);
  const decodedEdited = decodeNativeWavToPlanar(editedPrev.wavBytes);
  assert.ok(decodedOrig !== null && decodedEdited !== null);
  assert.equal(decodedOrig!.totalSamples - decodedEdited!.totalSamples, 4000);

  const fullPrev = await previewRenderer.generatePreview({
    mode: 'FULL',
    source,
    edl,
    crossfadeMs: 10,
    encoding: 'pcm16',
  });
  assert.equal(fullPrev.ok, true, fullPrev.failureReason);

  const finalExport = await previewRenderer.renderFinalAudio({
    edl,
    source,
    config: { encoding: 'pcm16', defaultCrossfadeMs: 10 },
  });
  assert.equal(finalExport.ok, true, finalExport.failureReason);
  assert.ok(finalExport.outputArtifact !== null);
  const exportBytes = await readRenderArtifactToUint8Array(finalExport.outputArtifact!);
  await finalExport.outputArtifact!.dispose();

  const decodedFullPrev = decodeNativeWavToPlanar(fullPrev.wavBytes);
  const decodedExport = decodeNativeWavToPlanar(exportBytes);
  assert.ok(decodedFullPrev !== null && decodedExport !== null);
  assert.equal(decodedFullPrev!.sampleRate, decodedExport!.sampleRate);
  assert.equal(decodedFullPrev!.channelCount, decodedExport!.channelCount);
  assert.equal(decodedFullPrev!.totalSamples, decodedExport!.totalSamples);
  assert.equal(fullPrev.wavBytes.byteLength, exportBytes.byteLength);
  assert.deepEqual(fullPrev.wavBytes, exportBytes);

  assert.equal(hashChannelsSha256([ch0]), sha256);
});

// ---------------------------------------------------------------------------
// Scenario 13: Exact Timeline Coordinate Mapping Before/After Cuts
// ---------------------------------------------------------------------------

test('S13: Source <-> Output timeline coordinate mapping accurately tracks retained and removed positions', () => {
  const sr: SampleRate = 16000;
  const { source } = makeSource('src-s13', sr, [makeSineChannel(10000, sr, 440)]);
  const edl = makeTestEdl({
    source,
    proposals: [
      makeTestProposal({
        id: 'cut-a',
        startSample: 2000,
        endSample: 3500,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
      makeTestProposal({
        id: 'cut-b',
        startSample: 6000,
        endSample: 7000,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });

  const built = AudioRenderPlanner.buildPlan({
    edl,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    sourceSampleRate: sr,
    channelCount: 1,
    totalSourceSamples: 10000,
    expectedSourceAudioHash: source.sourceAudioHash,
    expectedTranscriptVersion: 'tr_v1',
    expectedEdlVersion: 1,
    config: baseConfig(),
  });
  assert.equal(built.ok, true, built.failures.map((f) => f.message).join(' | '));
  const plan = built.plan!;
  assert.equal(plan.expectedOutputSamples, 7500);

  const m1 = mapSourceSampleToOutputSample(plan, 1500);
  assert.equal(m1.mapped, true);
  assert.equal(m1.outputSample, 1500);
  assert.equal(mapOutputSampleToSourceSample(plan, 1500).sourceSample, 1500);

  const mCut = mapSourceSampleToOutputSample(plan, 2500);
  assert.equal(mCut.mapped, false);
  assert.equal(mCut.removedByProposalId, 'cut-a');

  const m2 = mapSourceSampleToOutputSample(plan, 4000);
  assert.equal(m2.mapped, true);
  assert.equal(m2.outputSample, 2500);
  assert.equal(mapOutputSampleToSourceSample(plan, 2500).sourceSample, 4000);

  const m3 = mapSourceSampleToOutputSample(plan, 8000);
  assert.equal(m3.mapped, true);
  assert.equal(m3.outputSample, 5500);
  assert.equal(mapOutputSampleToSourceSample(plan, 5500).sourceSample, 8000);
});

// ---------------------------------------------------------------------------
// Scenarios 15 & 16: Cut Boundaries, Controllable Crossfade & Clipping Guard
// ---------------------------------------------------------------------------

test('S15: Cut boundaries support controllable crossfade (0ms direct cut vs 10ms smoothed transition)', async () => {
  const sr: SampleRate = 16000;
  const ch0 = new Float32Array(9000);
  // Continuous around cut boundaries (3000 and 6000); polarity flips inside the removed region [3000, 6000)
  ch0.fill(0.7, 0, 4500);
  ch0.fill(-0.7, 4500, 9000);

  const { source } = makeSource('src-s15', sr, [ch0]);
  const edl = makeTestEdl({
    source,
    proposals: [
      makeTestProposal({
        id: 'p-step',
        startSample: 3000,
        endSample: 6000,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });

  const engineA = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const direct = await renderAndDecode(
    engineA,
    source,
    edl,
    baseConfig({ defaultCrossfadeMs: 0, maxBoundaryAdjustmentSamples: 0, encoding: 'float32' }),
  );
  assert.equal(direct.result.ok, true, direct.result.failureReason);
  assert.equal(direct.result.crossfadeResults.length, 0);
  const directJump = Math.abs(direct.decoded!.channels[0][3000] - direct.decoded!.channels[0][2999]);
  assert.ok(directJump > 1.3, `Expected abrupt step jump with 0ms crossfade, got ${directJump}`);

  const engineB = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const smoothed = await renderAndDecode(
    engineB,
    source,
    edl,
    baseConfig({ defaultCrossfadeMs: 10, maxBoundaryAdjustmentSamples: 0, encoding: 'float32' }),
  );
  assert.equal(smoothed.result.ok, true, smoothed.result.failureReason);
  assert.equal(smoothed.result.crossfadeResults.length, 1);
  assert.equal(smoothed.decoded?.totalSamples, 6000);
  let maxDelta = 0;
  for (let i = 2900; i < 3100; i++) {
    const d = Math.abs(smoothed.decoded!.channels[0][i] - smoothed.decoded!.channels[0][i - 1]);
    if (d > maxDelta) maxDelta = d;
  }
  assert.ok(maxDelta < 0.05, `Crossfaded transition must suppress click/step pop, maxDelta=${maxDelta}`);
});

test('S16: Transition limiter prevents unexpected clipping on hot signals and rejects NaN/Inf samples', async () => {
  const sr: SampleRate = 16000;
  const ch0 = makeSineChannel(9000, sr, 200, 0.98);
  const { source } = makeSource('src-s16-hot', sr, [ch0]);
  const edl = makeTestEdl({
    source,
    proposals: [
      makeTestProposal({
        id: 'p-hot',
        startSample: 3000,
        endSample: 6000,
        sampleRate: sr,
        sourceAudioId: source.sourceAudioId,
        sourceAudioHash: source.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });

  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const { result, decoded } = await renderAndDecode(
    engine,
    source,
    edl,
    baseConfig({
      encoding: 'float32',
      defaultCrossfadeMs: 10,
      crossfadeCurve: 'equal-power',
      enableTransitionLimiter: true,
    }),
  );
  assert.equal(result.ok, true, result.failureReason);
  assert.equal(result.postValidation?.passed, true);
  assert.equal(result.postValidation?.verifiedClippedSamples, 0);
  assert.equal(result.postValidation?.verifiedNonFiniteSamples, 0);
  for (let i = 0; i < decoded!.totalSamples; i++) {
    const v = decoded!.channels[0][i];
    assert.ok(Number.isFinite(v) && Math.abs(v) <= 1.0, `Sample ${i} clipped or non-finite: ${v}`);
  }

  const badPcm = new Float32Array(4000);
  badPcm[1234] = Number.NaN;
  const { source: badSrc } = makeSource('src-s16-nan', sr, [badPcm]);
  const badEdl = makeTestEdl({ source: badSrc, proposals: [] });
  const badRes = await renderAndDecode(engine, badSrc, badEdl, baseConfig({ encoding: 'float32' }));
  assert.equal(badRes.result.ok, false);
});

// ---------------------------------------------------------------------------
// Scenario 17: Empty & Corrupted / Spoofed Audio Rejection
// ---------------------------------------------------------------------------

test('S17: Empty audio (0 samples), spoofed .wav text file, and truncated WAV headers are strictly rejected', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const { source: emptySrc } = makeSource('src-s17-empty', sr, [new Float32Array(0)]);
  const emptyEdl = makeTestEdl({ source: emptySrc, proposals: [] });
  const emptyRes = await renderAndDecode(engine, emptySrc, emptyEdl);
  assert.equal(emptyRes.result.ok, false);
  assert.equal(emptyRes.result.state, 'FAILED_VALIDATION');

  const fakeWav = new TextEncoder().encode('This is definitely not a WAV audio file, even with .wav extension!');
  assert.equal(decodeNativeWavToPlanar(fakeWav), null);
  assert.equal(parseWaveHeaderBytes(fakeWav, fakeWav.byteLength).valid, false);

  const trunc = new Uint8Array(50);
  trunc.set(new TextEncoder().encode('RIFF'), 0);
  const v = new DataView(trunc.buffer);
  v.setUint32(4, 10036, true);
  trunc.set(new TextEncoder().encode('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  trunc.set(new TextEncoder().encode('data'), 36);
  v.setUint32(40, 10000, true);
  assert.equal(decodeNativeWavToPlanar(trunc), null);
  assert.equal(parseWaveHeaderBytes(trunc, trunc.byteLength).valid, false);
});

// ---------------------------------------------------------------------------
// Scenarios 18–22: Sample Rates, Mono, Stereo, WAV PCM16/PCM24 & Float32/RF64
// ---------------------------------------------------------------------------

test('S18: Supported sample rates (16k, 44.1k, 48k) preserved by default + intentional resampling verified', async () => {
  const rates: readonly SampleRate[] = [16000, 44100, 48000];
  for (const sr of rates) {
    const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
    const samples = Math.round(sr * 0.25);
    const { source } = makeSource(`src-sr-${sr}`, sr, [makeSineChannel(samples, sr, 440, 0.5)]);
    const edl = makeTestEdl({ source, proposals: [] });
    const { result, decoded } = await renderAndDecode(
      engine,
      source,
      edl,
      baseConfig({ encoding: 'pcm16' }),
    );
    assert.equal(result.ok, true);
    assert.equal(decoded?.rawSampleRateHz, sr);
    assert.equal(decoded?.totalSamples, samples);
  }

  const engineRs = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const { source: src48 } = makeSource('src-rs-48k', 48000, [makeSineChannel(24000, 48000, 440, 0.5)]);
  const edl48 = makeTestEdl({ source: src48, proposals: [] });
  const rs = await renderAndDecode(
    engineRs,
    src48,
    edl48,
    baseConfig({ encoding: 'pcm16', targetSampleRate: 16000 }),
  );
  assert.equal(rs.result.ok, true);
  assert.equal(rs.decoded?.rawSampleRateHz, 16000);
  assert.ok(Math.abs(rs.decoded!.totalSamples - 8000) <= 2);
});

test('S19 & S20: Mono (1ch) and Stereo (2ch) preserve exact channel count and independent L/R content', async () => {
  const sr: SampleRate = 48000;
  const engineMono = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const monoCh = makeSineChannel(9600, sr, 300, 0.5);
  const { source: monoSrc } = makeSource('src-s19-mono', sr, [monoCh]);
  const monoRes = await renderAndDecode(engineMono, monoSrc, makeTestEdl({ source: monoSrc, proposals: [] }));
  assert.equal(monoRes.result.ok, true);
  assert.equal(monoRes.decoded?.channelCount, 1);
  assert.equal(monoRes.decoded?.totalSamples, 9600);

  const engineStereo = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const leftCh = makeSineChannel(12000, sr, 220, 0.25);
  const rightCh = makeSineChannel(12000, sr, 880, 0.8);
  const { source: stereoSrc } = makeSource('src-s20-stereo', sr, [leftCh, rightCh]);
  const stereoEdl = makeTestEdl({
    source: stereoSrc,
    proposals: [
      makeTestProposal({
        id: 'p-stereo-cut',
        startSample: 4000,
        endSample: 6000,
        sampleRate: sr,
        sourceAudioId: stereoSrc.sourceAudioId,
        sourceAudioHash: stereoSrc.sourceAudioHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });
  const stereoRes = await renderAndDecode(engineStereo, stereoSrc, stereoEdl, baseConfig({ encoding: 'pcm24' }));
  assert.equal(stereoRes.result.ok, true, stereoRes.result.failureReason);
  assert.equal(stereoRes.decoded?.channelCount, 2);
  assert.equal(stereoRes.decoded?.totalSamples, 10000);
  assert.ok(Math.abs(rmsRange(stereoRes.decoded!.channels[0], 0, 4000) - 0.25 / Math.SQRT2) < 0.01);
  assert.ok(Math.abs(rmsRange(stereoRes.decoded!.channels[1], 0, 4000) - 0.8 / Math.SQRT2) < 0.01);
});

test('S21 & S22: WAV PCM16, WAV PCM24, WAV Float32, and RF64 PCM24 decode back with high precision', async () => {
  const sr: SampleRate = 44100;
  const ch0 = makeSineChannel(4410, sr, 523.25, 0.6);
  const cases: ReadonlyArray<{
    readonly container: 'wav' | 'rf64';
    readonly encoding: RenderExportEncoding;
    readonly maxErr: number;
  }> = [
    { container: 'wav', encoding: 'pcm16', maxErr: 1 / 32768 + 1e-5 },
    { container: 'wav', encoding: 'pcm24', maxErr: 1 / 8388608 + 1e-6 },
    { container: 'wav', encoding: 'float32', maxErr: 1e-6 },
    { container: 'rf64', encoding: 'pcm24', maxErr: 1 / 8388608 + 1e-6 },
  ];

  for (const tc of cases) {
    const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
    const { source } = makeSource(`src-fmt-${tc.container}-${tc.encoding}`, sr, [ch0]);
    const edl = makeTestEdl({ source, proposals: [] });
    const { result, bytes, decoded } = await renderAndDecode(
      engine,
      source,
      edl,
      baseConfig({ container: tc.container, encoding: tc.encoding }),
    );
    assert.equal(result.ok, true, `Failed for ${tc.container}/${tc.encoding}: ${result.failureReason}`);
    assert.ok(bytes !== null && decoded !== null);
    const parsedHeader = parseWaveHeaderBytes(bytes!.subarray(0, 80), bytes!.byteLength);
    assert.equal(parsedHeader.valid, true);
    assert.equal(parsedHeader.container, tc.container);
    assert.equal(parsedHeader.encoding, tc.encoding);
    assert.equal(decoded!.totalSamples, ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      assert.ok(
        Math.abs(decoded!.channels[0][i] - ch0[i]) <= tc.maxErr,
        `Sample error exceeded tolerance for ${tc.container}/${tc.encoding} at ${i}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Scenarios 23–25: Cancellation, Export Write Failure & Resource Cleanup (>1 MiB)
// ---------------------------------------------------------------------------

test('S23: Mid-render cancellation cleans up reservations and produces no committed output artifact', async () => {
  const budget = new MemoryBudgetManager();
  const baseline = budget.getSnapshot().accountedBytes;
  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const sr: SampleRate = 16000;
  const ch0 = makeSineChannel(64000, sr, 440, 0.5);
  const { source } = makeSource('src-s23-cancel', sr, [ch0]);
  const edl = makeTestEdl({ source, proposals: [] });
  const abortCtrl = new AbortController();

  const res = await engine.render({
    edl,
    source,
    expectedSourceAudioHash: source.sourceAudioHash,
    expectedTranscriptVersion: 'tr_v1',
    expectedEdlVersion: 1,
    config: baseConfig({ chunkSizeSamples: 2048 }),
    abortSignal: abortCtrl.signal,
    onProgress: (snap) => {
      if (snap.state === 'RENDERING' && snap.writtenOutputSamples > 0) {
        abortCtrl.abort();
      }
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'CANCELLED');
  assert.equal(res.outputArtifact, null);
  assert.equal(engine.isRenderActive(), false);
  assert.equal(engine.isSourceRenderActive(source.sourceAudioId), false);
  assert.equal(budget.getSnapshot().accountedBytes, baseline);
});

test('S24: Export write/quota failure leaves source untouched, returns structured FAILED state, and releases memory', async () => {
  const budget = new MemoryBudgetManager();
  const baseline = budget.getSnapshot().accountedBytes;
  const failingSink: StreamingByteSink = {
    persistedExternally: false,
    writeAt: async () => {},
    append: async () => {
      throw new ExportWriteFailureError('OUTPUT_QUOTA_EXCEEDED', 'Simulated disk full / quota exceeded.');
    },
    finalizeTempToCommitted: async () => {},
    abortAndCleanup: () => {},
    getTotalBytesWritten: () => 0,
    readRange: async () => new Uint8Array(0),
    openReadStream: () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
  };
  const engine = new AudioRenderEngine({
    memoryBudgetManager: budget,
    createSink: () => failingSink,
  });
  const sr: SampleRate = 16000;
  const ch0 = makeSineChannel(8000, sr, 440, 0.5);
  const { source, sha256 } = makeSource('src-s24-fail', sr, [ch0]);
  const edl = makeTestEdl({ source, proposals: [] });

  const res = await engine.render({
    edl,
    source,
    expectedSourceAudioHash: source.sourceAudioHash,
    expectedTranscriptVersion: 'tr_v1',
    expectedEdlVersion: 1,
    config: baseConfig(),
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'FAILED');
  assert.equal(res.outputArtifact, null);
  assert.ok(res.preValidation.failures.some((f) => f.code === 'OUTPUT_QUOTA_EXCEEDED'));
  assert.equal(hashChannelsSha256([ch0]), sha256);
  assert.equal(budget.getSnapshot().accountedBytes, baseline);
});

test('S25: Memory resources return to baseline after >1 MiB render and atomic streaming export succeeds without 1 MiB readRange crash', async () => {
  const budget = new MemoryBudgetManager();
  const baseline = budget.getSnapshot().accountedBytes;
  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const sr: SampleRate = 48000;
  const samples = 48000 * 7; // ~1.34 MiB stereo PCM16 (> 1 MiB readRange cap)
  const left = makeSineChannel(samples, sr, 440, 0.4);
  const right = makeSineChannel(samples, sr, 660, 0.4);
  const { source } = makeSource('src-s25-large', sr, [left, right]);
  const edl = makeTestEdl({ source, proposals: [] });

  const renderRes = await engine.render({
    edl,
    source,
    expectedSourceAudioHash: source.sourceAudioHash,
    expectedTranscriptVersion: 'tr_v1',
    expectedEdlVersion: 1,
    config: baseConfig({ encoding: 'pcm16', chunkSizeSamples: 16384 }),
  });

  assert.equal(renderRes.ok, true);
  assert.ok(renderRes.outputArtifact !== null);
  assert.ok(renderRes.outputArtifact!.sizeBytes > 1024 * 1024);

  const wavBytes = await readRenderArtifactToUint8Array(renderRes.outputArtifact!);
  assert.equal(wavBytes.byteLength, renderRes.outputArtifact!.sizeBytes);
  const decoded = decodeNativeWavToPlanar(wavBytes);
  assert.equal(decoded?.totalSamples, samples);
  assert.equal(decoded?.channelCount, 2);

  await renderRes.outputArtifact!.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, baseline);
});

// ---------------------------------------------------------------------------
// Scenarios 26 & 27: Sequential Multi-Op Renders, Duplicate & Concurrency Guards
// ---------------------------------------------------------------------------

test('S26 & S27: Sequential multi-op renders succeed, while concurrent conflicting renders and re-applying EDL onto already-rendered output are blocked', async () => {
  const engine = new AudioRenderEngine({ memoryBudgetManager: new MemoryBudgetManager() });
  const sr: SampleRate = 16000;
  const ch0 = makeSineChannel(16000, sr, 440, 0.5);
  const { source } = makeSource('src-s26-27', sr, [ch0]);

  const p1 = makeTestProposal({
    id: 'p-seq-1',
    startSample: 2000,
    endSample: 4000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
  });
  const p2 = makeTestProposal({
    id: 'p-seq-2',
    startSample: 8000,
    endSample: 10000,
    sampleRate: sr,
    sourceAudioId: source.sourceAudioId,
    sourceAudioHash: source.sourceAudioHash,
    transcriptVersion: 'tr_v1',
  });

  const r1 = await renderAndDecode(engine, source, makeTestEdl({ source, proposals: [p1], edlVersion: 1 }));
  assert.equal(r1.result.ok, true, r1.result.failureReason);
  assert.equal(r1.decoded?.totalSamples, 14000);

  const r2 = await renderAndDecode(engine, source, makeTestEdl({ source, proposals: [p1, p2], edlVersion: 2 }));
  assert.equal(r2.result.ok, true, r2.result.failureReason);
  assert.equal(r2.decoded?.totalSamples, 12000);

  const dupRes = await renderAndDecode(
    engine,
    source,
    makeTestEdl({ source, proposals: [p1], edlVersion: 3 }),
    baseConfig(),
    ['p-seq-1', 'p-seq-1'],
  );
  assert.equal(dupRes.result.ok, false);
  assert.ok(dupRes.result.preValidation.failures.some((f) => f.code === 'DUPLICATE_OR_OVERLAPPING_REMOVAL'));

  const renderedOutputHash = r1.result.output!.outputHash;
  const renderedAsFakeSource = createPlanarArrayPcmSource({
    sourceAudioId: 'already-rendered-out',
    sourceAudioHash: renderedOutputHash,
    sampleRate: sr,
    channels: [r1.decoded!.channels[0]],
  });
  const forgedEdl = makeTestEdl({
    source: renderedAsFakeSource,
    proposals: [
      makeTestProposal({
        id: 'p-reapply',
        startSample: 2000,
        endSample: 4000,
        sampleRate: sr,
        sourceAudioId: renderedAsFakeSource.sourceAudioId,
        sourceAudioHash: renderedOutputHash,
        transcriptVersion: 'tr_v1',
      }),
    ],
  });
  const reapplyRes = await renderAndDecode(engine, renderedAsFakeSource, forgedEdl);
  assert.equal(reapplyRes.result.ok, false);
  assert.equal(reapplyRes.result.state, 'FAILED_VALIDATION');
  assert.ok(reapplyRes.result.failureReason?.includes('already-rendered output'));

  const slowSource: ChunkedPcmSource = {
    sourceAudioId: 'src-concurrent-lock',
    sourceAudioHash: source.sourceAudioHash,
    sampleRate: sr,
    channelCount: 1,
    totalSamples: 16000,
    readPlanarRange: async (start, count) => {
      await new Promise((r) => setTimeout(r, 15));
      return source.readPlanarRange(start, count);
    },
  };
  const edlSlow = makeTestEdl({ source: slowSource, proposals: [] });
  const [firstRun, secondRun] = await Promise.all([
    engine.render({
      renderId: 'rnd-concurrent-A',
      edl: edlSlow,
      source: slowSource,
      expectedSourceAudioHash: slowSource.sourceAudioHash,
      expectedTranscriptVersion: 'tr_v1',
      expectedEdlVersion: 1,
      config: baseConfig(),
    }),
    (async () => {
      await new Promise((r) => setTimeout(r, 2));
      return engine.render({
        renderId: 'rnd-concurrent-B',
        edl: edlSlow,
        source: slowSource,
        expectedSourceAudioHash: slowSource.sourceAudioHash,
        expectedTranscriptVersion: 'tr_v1',
        expectedEdlVersion: 1,
        config: baseConfig(),
      });
    })(),
  ]);
  assert.equal(firstRun.ok, true);
  assert.equal(secondRun.ok, false);
  assert.ok(secondRun.failureReason?.includes('Concurrent conflicting render'));
  await firstRun.outputArtifact?.dispose();
});

// ---------------------------------------------------------------------------
// Scenario 28: Non-Destructive Undo & Redo via Existing Workflow History
// ---------------------------------------------------------------------------

test('S28: Non-destructive Undo & Redo via CanonicalProjectWorkflowEngine and StudioWorkflowController restore exact state', async () => {
  const sr: SampleRate = 16000;
  const speechA = makeSineChannel(9600, sr, 440, 0.5);
  const silence = new Float32Array(8000);
  const speechB = makeSineChannel(9600, sr, 660, 0.5);
  const fullPcm = new Float32Array(speechA.length + silence.length + speechB.length);
  fullPcm.set(speechA, 0);
  fullPcm.set(silence, speechA.length);
  fullPcm.set(speechB, speechA.length + silence.length);
  const origHash = hashChannelsSha256([fullPcm]);

  const wf = new CanonicalProjectWorkflowEngine({ projectId: 'proj-undo', projectName: 'Undo Test' });
  await wf.importAndValidateAudio({
    sourceAudioId: 'aud-undo',
    fileName: 'undo.wav',
    sampleRate: sr,
    channels: [fullPcm],
  });
  wf.attachVerifiedTranscriptResult({
    contractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
    jobId: 'job-undo',
    runtimeTarget: 'NATIVE_COMPANION_CPU',
    runtimeName: 'test-runtime',
    executionProvider: 'cpu',
    modelId: 'shahab-test',
    modelVersion: '1.0.0',
    modelSha256Hex: '0'.repeat(64),
    architecture: 'zipformer-transducer',
    normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
    offlineVerified: true,
    sampleRateHz: 16000,
    durationSec: fullPcm.length / sr,
    processingTimeMs: 10,
    realTimeFactor: 0.05,
    dominantLanguage: 'fa',
    rawText: 'سلام خوبی',
    normalizedText: 'سلام خوبی',
    timestampGranularity: 'SEGMENT',
    peakMemoryBytes: 1024,
    segments: [
      {
        id: 's1',
        index: 0,
        startSec: 0,
        endSec: 0.6,
        startSample16k: 0,
        endSample16k: 9600,
        rawText: 'سلام',
        normalizedText: 'سلام',
        language: 'fa',
        confidence: 0.95,
        timestampGranularity: 'SEGMENT',
        words: [],
      },
      {
        id: 's2',
        index: 1,
        startSec: 1.1,
        endSec: 1.7,
        startSample16k: 17600,
        endSample16k: 27200,
        rawText: 'خوبی',
        normalizedText: 'خوبی',
        language: 'fa',
        confidence: 0.95,
        timestampGranularity: 'SEGMENT',
        words: [],
      },
    ],
  });
  const suggestions = wf.analyzeSpeechAndGenerateSuggestions({ minSilenceDurationSec: 0.35 });
  assert.ok(suggestions.length >= 1);
  const decId = wf.getState().decisions[0].decisionId;
  wf.reviewDecision({ decisionId: decId, action: 'APPROVE' });
  wf.applyApprovedDecisions();

  const expEdited = await wf.exportValidatedWav({ encoding: 'pcm16' });
  assert.equal(expEdited.ok, true);
  assert.ok(expEdited.exportRecord!.verifiedFrames < fullPcm.length);

  assert.equal(wf.undo(), true);
  const expUndone = await wf.exportValidatedWav({ encoding: 'pcm16' });
  assert.equal(expUndone.ok, true);
  assert.equal(expUndone.exportRecord!.verifiedFrames, fullPcm.length);

  assert.equal(wf.redo(), true);
  const expRedone = await wf.exportValidatedWav({ encoding: 'pcm16' });
  assert.equal(expRedone.ok, true);
  assert.equal(expRedone.exportRecord!.verifiedFrames, expEdited.exportRecord!.verifiedFrames);
  assert.equal(hashChannelsSha256([fullPcm]), origHash);

  const ctrl = new StudioWorkflowController({ memoryBudgetManager: new MemoryBudgetManager() });
  ctrl.openProject({
    projectId: 'proj-ctrl-undo',
    projectName: 'Ctrl Undo',
    sourceAudio: {
      sourceAudioId: 'aud-ctrl-undo',
      sourceAudioHash: origHash,
      fileName: 'undo.wav',
      format: 'wav',
      sampleRate: sr,
      channelCount: 1,
      bitDepth: 16,
      totalSamples: fullPcm.length,
      durationSec: fullPcm.length / sr,
      fileSizeBytes: fullPcm.byteLength,
      importStatus: 'VALIDATED',
      isDemoFixture: false,
    },
  });
  const analyzed = await ctrl.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-main',
    pcmMono: fullPcm,
    sampleRate: sr,
    wordTokens: [],
  });
  assert.equal(analyzed.ok, true);
  if (analyzed.edl && analyzed.edl.proposals.length > 0) {
    const pid = analyzed.edl.proposals[0].proposalId;
    const beforeStatus = analyzed.edl.proposals[0].status;
    assert.equal(ctrl.applyHumanDecision({ action: 'APPROVE', proposalId: pid }).ok, true);
    assert.equal(ctrl.getState().edlSnapshot?.proposals.find((p) => p.proposalId === pid)?.status, 'APPROVED');
    assert.equal(ctrl.undoEdlDecision(), true);
    assert.equal(ctrl.getState().edlSnapshot?.proposals.find((p) => p.proposalId === pid)?.status, beforeStatus);
    assert.equal(ctrl.redoEdlDecision(), true);
    assert.equal(ctrl.getState().edlSnapshot?.proposals.find((p) => p.proposalId === pid)?.status, 'APPROVED');
  }
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// Scenario 29: Independent Post-Render Validation Catches Corrupted Output
// ---------------------------------------------------------------------------

test('S29: Independent post-render validator catches tampered WAV payload and blocks COMPLETED status', async () => {
  const budget = new MemoryBudgetManager();
  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const sr: SampleRate = 16000;
  const { source } = makeSource('src-s29', sr, [makeSineChannel(4000, sr, 440, 0.5)]);
  const edl = makeTestEdl({ source, proposals: [] });

  const renderRes = await engine.render({
    edl,
    source,
    expectedSourceAudioHash: source.sourceAudioHash,
    expectedTranscriptVersion: 'tr_v1',
    expectedEdlVersion: 1,
    config: baseConfig({ encoding: 'pcm16' }),
  });
  assert.equal(renderRes.ok, true);
  const validBytes = await readRenderArtifactToUint8Array(renderRes.outputArtifact!);
  await renderRes.outputArtifact!.dispose();

  const tampered = new Uint8Array(validBytes);
  tampered[tampered.byteLength - 10] ^= 0xff;
  const report = await AudioRenderValidator.validatePostRenderArtifact({
    plan: renderRes.plan!,
    outputMetadata: renderRes.output!,
    artifact: makeByteReader(tampered),
  });
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((f) => f.code === 'HASH_VERIFICATION_FAILED'));

  const corruptHeader = new Uint8Array(validBytes);
  corruptHeader[0] = 0x58;
  const headerReport = await AudioRenderValidator.validatePostRenderArtifact({
    plan: renderRes.plan!,
    outputMetadata: renderRes.output!,
    artifact: makeByteReader(corruptHeader),
  });
  assert.equal(headerReport.passed, false);
  assert.ok(headerReport.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));
});

// ---------------------------------------------------------------------------
// Scenario 30: Full Vertical Slice (WAV Import -> Engine 02 -> Approval -> Engine 03 -> Preview -> Export)
// ---------------------------------------------------------------------------

test('S30: End-to-end vertical slice (Engine 02 -> Human Approval -> Engine 03 -> Preview -> Atomic Export) cuts ONLY approved regions', async () => {
  const sr: SampleRate = 16000;
  // Build a realistic 5.5s WAV PCM16 recording with subtle -60 dBFS room tone floor and voiced spans:
  // [0.2..0.6s "امروز"] [0.65..1.05s "اممم"] [1.1..2.9s long room-tone pause]
  // [2.95..3.35s "سلام" #1] [3.4..3.8s "سلام" #2] [3.9..4.6s "چطوری"] [4.6..5.5s tail]
  const totalFixtureSamples = Math.round(5.5 * sr);
  const rawPcm = new Float32Array(totalFixtureSamples);
  for (let i = 0; i < totalFixtureSamples; i++) {
    rawPcm[i] = Math.sin((2 * Math.PI * 63 * i) / sr) * 0.0008;
  }
  const voicedSpans = [
    { startSec: 0.2, endSec: 0.6, freqHz: 260, amp: 0.35 },
    { startSec: 0.65, endSec: 1.05, freqHz: 210, amp: 0.32 },
    { startSec: 2.95, endSec: 3.35, freqHz: 350, amp: 0.4 },
    { startSec: 3.4, endSec: 3.8, freqHz: 350, amp: 0.4 },
    { startSec: 3.9, endSec: 4.6, freqHz: 520, amp: 0.45 },
  ];
  for (const sp of voicedSpans) {
    const s = Math.floor(sp.startSec * sr);
    const e = Math.floor(sp.endSec * sr);
    for (let i = s; i < e; i++) {
      const t = i / sr;
      rawPcm[i] =
        sp.amp * (0.65 * Math.sin(2 * Math.PI * sp.freqHz * t) + 0.35 * Math.sin(2 * Math.PI * sp.freqHz * 1.9 * t));
    }
  }
  const rawWavUint8 = await encodeFixtureWavBytes([rawPcm], sr, 'pcm16');
  const rawWavBuffer = Buffer.from(rawWavUint8);

  const pipeline = new SmartAudioEditPipeline();
  const imported = pipeline.importAndNormalizeAudio({
    audioBytes: rawWavBuffer,
    filename: 'persian_vertical_slice.wav',
    projectId: 'proj-e03-s30',
  });
  const totalSamples = imported.audio.totalSourceSamples;
  const sourceAudioId = imported.audio.sourceAudioId;
  const sourceHash = imported.audio.sourceAudioHash;

  const transcript: TranscriptDocument = {
    schemaVersion: 'avp.transcript.v1',
    transcriptVersion: 'tr_s30_v1',
    sourceAudioId,
    sourceAudioHash: sourceHash,
    sampleRate: sr,
    totalSourceSamples: totalSamples,
    language: 'fa',
    modelId: 'shahab-fa-lite',
    modelVersion: '1.0.0',
    runtime: 'sherpa-onnx-cpu',
    rawText: 'امروز اممم سلام سلام چطوری',
    normalizedText: 'امروز اممم سلام سلام چطوری',
    tokens: [
      {
        tokenId: 'tok_0',
        rawText: 'امروز',
        normalizedText: 'امروز',
        startSample: Math.round(0.2 * sr),
        endSample: Math.round(0.6 * sr),
        startSec: 0.2,
        endSec: 0.6,
        confidence: 0.96,
        timestampGranularity: 'WORD',
      },
      {
        tokenId: 'tok_1',
        rawText: 'اممم',
        normalizedText: 'اممم',
        startSample: Math.round(0.65 * sr),
        endSample: Math.round(1.05 * sr),
        startSec: 0.65,
        endSec: 1.05,
        confidence: 0.94,
        timestampGranularity: 'WORD',
      },
      {
        tokenId: 'tok_2',
        rawText: 'سلام',
        normalizedText: 'سلام',
        startSample: Math.round(2.95 * sr),
        endSample: Math.round(3.35 * sr),
        startSec: 2.95,
        endSec: 3.35,
        confidence: 0.95,
        timestampGranularity: 'WORD',
      },
      {
        tokenId: 'tok_3',
        rawText: 'سلام',
        normalizedText: 'سلام',
        startSample: Math.round(3.4 * sr),
        endSample: Math.round(3.8 * sr),
        startSec: 3.4,
        endSec: 3.8,
        confidence: 0.95,
        timestampGranularity: 'WORD',
      },
      {
        tokenId: 'tok_4',
        rawText: 'چطوری',
        normalizedText: 'چطوری',
        startSample: Math.round(3.9 * sr),
        endSample: Math.round(4.6 * sr),
        startSec: 3.9,
        endSec: 4.6,
        confidence: 0.96,
        timestampGranularity: 'WORD',
      },
    ],
    timestampGranularity: 'WORD',
    realTimeFactor: 0.1,
    processingTimeMs: 40,
    offlineVerified: true,
    createdAtMs: 1700000000000,
  };

  // Run REAL Engine 02 analysis
  const engine02 = await analyzeShahabOutputWithEngine02({
    projectId: 'proj-e03-s30',
    trackId: 'track-main',
    sourceAudioId,
    sourceAudioHash: sourceHash,
    sampleRate: sr,
    totalSourceSamples: totalSamples,
    channelLayout: 'mono',
    pcmMono: imported.audio.canonical16kMono,
    analysisSampleRate: sr,
    transcriptDocument: transcript,
  });

  const actionable = engine02.edl.proposals.filter(
    (p) =>
      (p.validationStatus === 'VALID' || p.validationStatus === 'WARNING') &&
      !p.protectedEvent &&
      p.risk.approvalPermitted &&
      (p.operation === 'REMOVE_FILLER' ||
        p.operation === 'REMOVE_ACCIDENTAL_REPETITION' ||
        p.operation === 'SHORTEN_SILENCE'),
  );
  assert.ok(
    actionable.length >= 2,
    `Expected >=2 actionable Engine 02 proposals, got ${actionable.length} (total=${engine02.edl.proposals.length})`,
  );

  // Approve ONLY the first actionable proposal; explicitly reject the second
  const approvedTarget = actionable[0];
  const rejectedTarget = actionable[1];
  const step1 = EditDecisionEngine.approveProposal(engine02.edl, approvedTarget.proposalId, {
    reason: 'تأیید کاربر برای تست S30',
  });
  assert.equal(step1.ok, true);
  const step2 = EditDecisionEngine.rejectProposal(step1.snapshot, rejectedTarget.proposalId, {
    reason: 'رد کاربر برای تست S30',
  });
  assert.equal(step2.ok, true);
  const finalEdl = step2.snapshot;

  const readySession = {
    ...imported.session,
    transcript,
    speechEvents: engine02.speechEvents,
    edl: finalEdl,
    edlHistory: [finalEdl],
    edlHistoryIndex: 0,
  };
  const waitingJob = {
    ...imported.job,
    status: 'WAITING_USER_APPROVAL' as const,
    edlId: finalEdl.edlId,
  };

  // FULL Preview via Engine 03
  const prevRes = await pipeline.generatePreview({
    job: waitingJob,
    session: readySession,
    audio: imported.audio,
    mode: 'FULL',
    crossfadeMs: 10,
  });
  assert.equal(prevRes.preview.ok, true, prevRes.preview.failureReason);
  assert.deepEqual(prevRes.preview.appliedProposalIds, [approvedTarget.proposalId]);

  // Final Render + Atomic Disk Export via Engine 03
  const tmpOutPath = path.join(os.tmpdir(), `avp-e03-s30-${Date.now()}.wav`);
  try {
    const exportRes = await pipeline.renderAndExport({
      job: prevRes.job,
      session: prevRes.session,
      audio: imported.audio,
      config: { encoding: 'pcm16', defaultCrossfadeMs: 10 },
      outputFilePath: tmpOutPath,
      requireAtLeastOneApproval: true,
    });
    assert.equal(exportRes.job.status, 'COMPLETED');
    assert.equal(exportRes.sourceHashImmutableVerified, true);
    assert.deepEqual(exportRes.renderResult.appliedProposalIds, [approvedTarget.proposalId]);
    assert.equal(exportRes.exportedFilePath, tmpOutPath);
    assert.ok(fs.existsSync(tmpOutPath));

    const exportedDiskBytes = fs.readFileSync(tmpOutPath);
    const decodedOut = decodeNativeWavToPlanar(exportedDiskBytes);
    assert.ok(decodedOut !== null);

    // Exact expected output length = totalSamples - ONLY approvedTarget's removed range!
    const approvedRange = approvedTarget.proposedRange ?? approvedTarget.originalRange!;
    const approvedRemovedLen = approvedRange.endSample - approvedRange.startSample;
    assert.equal(decodedOut!.totalSamples, totalSamples - approvedRemovedLen);
    assert.equal(decodedOut!.sampleRate, sr);
    assert.equal(decodedOut!.channelCount, 1);

    // Rejected proposal's region must remain intact & mapped in output timeline
    const rejRange = rejectedTarget.proposedRange ?? rejectedTarget.originalRange!;
    const rejMid = Math.floor((rejRange.startSample + rejRange.endSample) / 2);
    const mappedRej = mapSourceSampleToOutputSample(exportRes.renderResult.plan!, rejMid);
    assert.equal(mappedRej.mapped, true, 'Rejected proposal region must remain mapped in output');
    assert.equal(mappedRej.removedByProposalId, null);

    // Preview WAV and Exported Disk WAV match byte-for-byte
    assert.deepEqual(new Uint8Array(exportedDiskBytes), prevRes.preview.wavBytes);

    await exportRes.renderResult.outputArtifact?.dispose();
  } finally {
    if (fs.existsSync(tmpOutPath)) fs.unlinkSync(tmpOutPath);
  }
});
