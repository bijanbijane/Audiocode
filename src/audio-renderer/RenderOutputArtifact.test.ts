import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { AVAPARDAZ_MEMORY_POLICY, MemoryPolicyConfig } from '../runtime/memory/MemoryPolicy';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import {
  AudioExportWriter,
  BoundedChunkedByteSink,
  DEFAULT_MAX_ARTIFACT_READ_BYTES,
  RenderArtifactReadStreamOptions,
  StreamingByteSink,
  validateArtifactRangeRead,
  validateArtifactStreamOptions,
} from './AudioExportWriter';
import {
  COMPATIBILITY_OUTPUT_BYTES_MAX_SIZE,
  CommittedRenderOutputArtifact,
  RenderOutputArtifact,
  createCommittedRenderArtifact,
  pipeRenderArtifactToWritable,
} from './RenderOutputArtifact';
import { AudioRenderEngine } from './AudioRenderEngine';
import { createPlanarArrayPcmSource } from './AudioSourceReader';
import { StudioWorkflowController } from '../workflow/StudioWorkflowController';

async function buildEmptyEdl(params: {
  projectId: string;
  sourceAudioId: string;
  sourceAudioHash: string;
  sampleRate: 16000 | 44100 | 48000;
  totalSourceSamples: number;
  channelLayout?: 'mono' | 'stereo';
}) {
  return EditDecisionEngine.generateEdl({
    context: {
      projectId: params.projectId,
      sourceAudioId: params.sourceAudioId,
      sourceAudioHash: params.sourceAudioHash,
      transcriptVersion: 'tr-v1',
      sampleRate: params.sampleRate,
      channelLayout: params.channelLayout ?? 'mono',
      totalSourceSamples: params.totalSourceSamples,
    },
    events: [],
    tokens: [],
    nowMs: 1000,
  });
}

async function readEntireStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

test('1. BoundedChunkedByteSink: range reads within single chunk, spanning chunks, repeated reads, and deterministic boundary rejections', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sink = new BoundedChunkedByteSink({ memoryBudgetManager: budget });

  const c0 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const c1 = new Uint8Array([8, 9, 10, 11]);
  const c2 = new Uint8Array([12, 13, 14, 15, 16, 17]);
  sink.append(c0);
  sink.append(c1);
  sink.append(c2);

  // Read before commit must reject
  await assert.rejects(() => sink.readRange(0, 4), /uncommitted/i);
  assert.throws(() => sink.openReadStream(), /uncommitted/i);

  sink.finalizeTempToCommitted();

  // Write after commit (both writeAt and append) must reject
  assert.throws(() => sink.append(new Uint8Array([99])), /finalized/i);
  assert.throws(() => sink.writeAt(0, new Uint8Array([99])), /finalized/i);

  // Range read within one chunk
  const within = await sink.readRange(2, 4);
  assert.deepEqual(Array.from(within), [2, 3, 4, 5]);

  // Range read spanning all three chunks preserves exact byte ordering
  const spanning = await sink.readRange(5, 10);
  assert.deepEqual(Array.from(spanning), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

  // Repeated reads return identical bytes
  const spanningRepeat = await sink.readRange(5, 10);
  assert.deepEqual(spanningRepeat, spanning);

  // Negative offset rejected
  await assert.rejects(() => sink.readRange(-1, 2), RangeError);
  // Unsafe integer rejected
  await assert.rejects(() => sink.readRange(Number.NaN, 2), RangeError);
  await assert.rejects(() => sink.readRange(0, 1.5), RangeError);
  // Read past EOF rejected
  await assert.rejects(() => sink.readRange(16, 3), RangeError);
  await assert.rejects(() => sink.readRange(19, 0), RangeError);
  // Read larger than 1 MiB default window rejected
  await assert.rejects(
    () => sink.readRange(0, DEFAULT_MAX_ARTIFACT_READ_BYTES + 1),
    RangeError,
  );

  // Stream entire sink -> exact byte equivalence
  const streamed = await readEntireStream(sink.openReadStream({ chunkSizeBytes: 5 }));
  assert.deepEqual(
    Array.from(streamed),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  );

  // Disposal clears chunks, releases reservations, and rejects subsequent reads
  assert.equal(budget.getSnapshot().accountedBytes, 18);
  sink.disposeCommitted();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
  assert.equal(sink.getRetainedChunkCount(), 0);
  await assert.rejects(() => sink.readRange(0, 1), /disposed/i);

  // Repeated disposal is idempotent with no double release
  sink.disposeCommitted();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('2. Small in-memory render transfers artifact ownership with compatibility bytes lease and releases everything on dispose', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sampleRate = 48_000 as const;
  const totalSamples = 24_000; // 0.5s -> ~48 KB pcm16 WAV (well under 8 MiB)
  const mono = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    mono[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }

  const edl = await buildEmptyEdl({
    projectId: 'proj-small',
    sourceAudioId: 'src-small',
    sourceAudioHash: 'sha256:small-render',
    sampleRate,
    totalSourceSamples: totalSamples,
  });

  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const res = await engine.render({
    edl,
    source: createPlanarArrayPcmSource({
      sourceAudioId: 'src-small',
      sourceAudioHash: 'sha256:small-render',
      sampleRate,
      channels: [mono],
    }),
    expectedSourceAudioHash: 'sha256:small-render',
    expectedTranscriptVersion: 'tr-v1',
    expectedEdlVersion: edl.edlVersion,
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 1001,
  });

  assert.equal(res.ok, true, res.failureReason);
  assert.equal(res.state, 'COMPLETED');
  assert.ok(res.outputArtifact);
  assert.ok(res.outputBytes);
  assert.equal(res.outputArtifact.disposed, false);
  assert.equal(res.outputArtifact.lifecycleState, 'VALIDATED_READY');
  assert.equal(res.outputArtifact.sizeBytes, 44 + totalSamples * 2);
  assert.equal(res.outputBytes.byteLength, res.outputArtifact.sizeBytes);

  // Invariant: activeArtifact.disposed === false => all artifact-owned memory reservations remain active
  // (Sink chunks + independent compatibility bytes reservation = 2x fileSizeBytes for small renders)
  const snapWhileActive = budget.getSnapshot();
  assert.equal(snapWhileActive.accountedBytes, res.outputArtifact.sizeBytes * 2);
  assert.ok(snapWhileActive.reservationCount >= 2);
  assert.equal(
    (res.outputArtifact as CommittedRenderOutputArtifact).getOwnedReservedBytes(),
    res.outputArtifact.sizeBytes * 2,
  );

  // Stream & Blob equivalence match compatibility bytes exactly
  const streamed = await readEntireStream(res.outputArtifact.openReadStream({ chunkSizeBytes: 16_384 }));
  assert.deepEqual(streamed, res.outputBytes);
  const blob = await res.outputArtifact.createBlob();
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, res.outputArtifact.sizeBytes);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), res.outputBytes);

  // Invariant: activeArtifact.dispose() => artifact-owned reservation count === 0
  await res.outputArtifact.dispose();
  assert.equal(res.outputArtifact.disposed, true);
  assert.equal(res.outputArtifact.lifecycleState, 'DISPOSED');
  assert.equal(
    (res.outputArtifact as CommittedRenderOutputArtifact).getOwnedReservationCount(),
    0,
  );
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);

  // Invariant: disposed artifact => subsequent readRange() rejects
  await assert.rejects(() => res.outputArtifact!.readRange(0, 44), /disposed/i);
  await assert.rejects(() => res.outputArtifact!.createBlob(), /disposed/i);
  assert.throws(() => res.outputArtifact!.openReadStream(), /disposed/i);

  // Repeated disposal is harmless and never double-releases
  await res.outputArtifact.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('3. Render larger than 8 MiB returns canonical outputArtifact only with outputBytes === null and zero full-array duplication', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sampleRate = 48_000 as const;
  // 2,200,000 samples * 4 bytes (float32 mono) = 8,800,000 B (~8.39 MiB > 8 MiB threshold)
  const totalSamples = 2_200_000;
  const expectedFileBytes = 44 + totalSamples * 4;
  assert.ok(expectedFileBytes > COMPATIBILITY_OUTPUT_BYTES_MAX_SIZE);

  const edl = await buildEmptyEdl({
    projectId: 'proj-large',
    sourceAudioId: 'src-large',
    sourceAudioHash: 'sha256:large-render-9mb',
    sampleRate,
    totalSourceSamples: totalSamples,
  });

  // Virtual streaming PCM source so the test itself does not allocate a huge source array
  const virtualSource = {
    sourceAudioId: 'src-large',
    sourceAudioHash: 'sha256:large-render-9mb',
    sampleRate,
    channelCount: 1,
    totalSamples,
    async readPlanarRange(startSample: number, sampleCount: number): Promise<Float32Array[]> {
      const out = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        out[i] = 0.2 * Math.sin(((startSample + i) % 100) * 0.062831853);
      }
      return [out];
    },
  };

  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const res = await engine.render({
    edl,
    source: virtualSource,
    expectedSourceAudioHash: 'sha256:large-render-9mb',
    expectedTranscriptVersion: 'tr-v1',
    expectedEdlVersion: edl.edlVersion,
    config: { encoding: 'float32', container: 'wav', chunkSizeSamples: 65536 },
    nowMs: 2000,
  });

  assert.equal(res.ok, true, res.failureReason);
  assert.equal(res.state, 'COMPLETED');
  assert.equal(res.postValidation?.passed, true);
  assert.ok(res.outputArtifact);
  assert.equal(res.outputBytes, null, 'Outputs > 8 MiB must never materialize compatibility outputBytes');
  assert.equal(res.outputArtifact.sizeBytes, expectedFileBytes);

  // Accounted memory holds ONLY the sink's chunk reservations (exact 1x output size, zero 2x copy!)
  assert.equal(budget.getSnapshot().accountedBytes, expectedFileBytes);

  // Streaming download & Blob creation succeed without full JS Uint8Array materialization
  let streamedBytes = 0;
  const reader = res.outputArtifact.openReadStream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    assert.ok(value!.byteLength <= DEFAULT_MAX_ARTIFACT_READ_BYTES);
    streamedBytes += value!.byteLength;
  }
  reader.releaseLock();
  assert.equal(streamedBytes, expectedFileBytes);

  await res.outputArtifact.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('4. Failed post-render validation immediately disposes artifact and releases all reservations', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sampleRate = 48_000 as const;
  const totalSamples = 8192;
  const mono = new Float32Array(totalSamples).fill(0.1);
  mono[100] = Number.NaN; // Triggers INVALID_FLOAT_SAMPLES during streaming post-render validation

  const edl = await buildEmptyEdl({
    projectId: 'proj-bad-val',
    sourceAudioId: 'src-bad-val',
    sourceAudioHash: 'sha256:bad-val',
    sampleRate,
    totalSourceSamples: totalSamples,
  });

  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const res = await engine.render({
    edl,
    source: createPlanarArrayPcmSource({
      sourceAudioId: 'src-bad-val',
      sourceAudioHash: 'sha256:bad-val',
      sampleRate,
      channels: [mono],
    }),
    expectedSourceAudioHash: 'sha256:bad-val',
    expectedTranscriptVersion: 'tr-v1',
    expectedEdlVersion: edl.edlVersion,
    config: { encoding: 'float32', container: 'wav', chunkSizeSamples: 4096 },
    nowMs: 3000,
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'FAILED_VALIDATION');
  assert.equal(res.outputArtifact, null);
  assert.equal(res.outputBytes, null);
  assert.equal(res.postValidation?.passed, false);
  assert.ok(res.postValidation?.failures.some((f) => f.code === 'INVALID_FLOAT_SAMPLES'));
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('5. Cancelled render retains no output artifact and releases all temporary reservations', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sampleRate = 48_000 as const;
  const totalSamples = 48_000;
  const mono = new Float32Array(totalSamples).fill(0.15);

  const edl = await buildEmptyEdl({
    projectId: 'proj-cancel',
    sourceAudioId: 'src-cancel',
    sourceAudioHash: 'sha256:cancel',
    sampleRate,
    totalSourceSamples: totalSamples,
  });

  const ac = new AbortController();
  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const res = await engine.render({
    edl,
    source: createPlanarArrayPcmSource({
      sourceAudioId: 'src-cancel',
      sourceAudioHash: 'sha256:cancel',
      sampleRate,
      channels: [mono],
    }),
    expectedSourceAudioHash: 'sha256:cancel',
    expectedTranscriptVersion: 'tr-v1',
    expectedEdlVersion: edl.edlVersion,
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 4096 },
    abortSignal: ac.signal,
    onProgress: (snap) => {
      if (snap.state === 'RENDERING' && snap.writtenOutputSamples > 0) {
        ac.abort();
      }
    },
    nowMs: 4000,
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'CANCELLED');
  assert.equal(res.outputArtifact, null);
  assert.equal(res.outputBytes, null);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('6. Memory pressure gracefully skips compatibility outputBytes without failing a valid render and preserves exact accounting', async () => {
  // Tight policy: hardLimit = 1 MiB, emergency = 900 KiB.
  // Output file ~192 KiB + existing 750 KiB reservation -> total 942 KiB (emergency pressure!).
  // Optional compatibility copy reservation must be rejected cleanly, returning outputBytes: null while render SUCCEEDS!
  const tightPolicy: MemoryPolicyConfig = {
    targetBytes: 850 * 1024,
    throttleBytes: 900 * 1024,
    emergencyBytes: 980 * 1024,
    hardLimitBytes: 1024 * 1024,
    audioCacheBytes: 64 * 1024,
  };
  const budget = new MemoryBudgetManager(tightPolicy);
  const existingLease = budget.reserve({
    owner: 'existing-project-pcm',
    category: 'decoded-audio',
    bytes: 750 * 1024,
    priority: 'protected',
    protectedUserData: true,
  });

  const sampleRate = 48_000 as const;
  const totalSamples = 48_000; // 1s pcm16 = 96,044 B (~93.8 KiB)
  const mono = new Float32Array(totalSamples).fill(0.1);
  const edl = await buildEmptyEdl({
    projectId: 'proj-pressure',
    sourceAudioId: 'src-pressure',
    sourceAudioHash: 'sha256:pressure',
    sampleRate,
    totalSourceSamples: totalSamples,
  });

  // Push accounted bytes so sink fits cleanly under hardLimit, but emergency is active for optional compat copy
  const extraLease = budget.reserve({
    owner: 'extra-pressure',
    category: 'other',
    bytes: 100 * 1024,
    priority: 'normal',
  });

  const engine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const res = await engine.render({
    edl,
    source: createPlanarArrayPcmSource({
      sourceAudioId: 'src-pressure',
      sourceAudioHash: 'sha256:pressure',
      sampleRate,
      channels: [mono],
    }),
    expectedSourceAudioHash: 'sha256:pressure',
    expectedTranscriptVersion: 'tr-v1',
    expectedEdlVersion: edl.edlVersion,
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 4096 },
    nowMs: 5000,
  });

  assert.equal(res.ok, true, res.failureReason);
  assert.equal(res.state, 'COMPLETED');
  assert.ok(res.outputArtifact);
  assert.equal(
    res.outputBytes,
    null,
    'Compatibility copy must be omitted under emergency pressure without failing valid render',
  );
  assert.equal(
    budget.getSnapshot().accountedBytes,
    750 * 1024 + 100 * 1024 + res.outputArtifact.sizeBytes,
  );

  await res.outputArtifact.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 750 * 1024 + 100 * 1024);
  budget.release(extraLease);
  budget.release(existingLease);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('7. Streaming download helper respects backpressure, closes on completion, and aborts without closing on failure', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sink = new BoundedChunkedByteSink({ memoryBudgetManager: budget });
  const payload = new Uint8Array(64 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  sink.append(payload);
  sink.finalizeTempToCommitted();

  const artifact = createCommittedRenderArtifact({
    sink,
    artifactId: 'art-stream-test',
    sizeBytes: payload.byteLength,
    memoryBudgetManager: budget,
  });

  // 1. Successful transfer with simulated slow consumer backpressure
  const receivedChunks: Uint8Array[] = [];
  let inFlightWrites = 0;
  let maxConcurrentWrites = 0;
  let closed = false;
  let aborted = false;

  const slowWritable = new WritableStream<Uint8Array>(
    {
      async write(chunk) {
        inFlightWrites++;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites);
        await new Promise((r) => setTimeout(r, 2));
        receivedChunks.push(new Uint8Array(chunk));
        inFlightWrites--;
      },
      close() {
        closed = true;
      },
      abort() {
        aborted = true;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );

  const transferred = await pipeRenderArtifactToWritable(artifact, slowWritable, {
    chunkSizeBytes: 16 * 1024,
  });
  assert.equal(transferred, payload.byteLength);
  assert.equal(closed, true);
  assert.equal(aborted, false);
  assert.equal(maxConcurrentWrites, 1, 'Backpressure must prevent overlapping unawaited writes');
  assert.equal(receivedChunks.length, 4);

  // 2. Interrupted transfer (destination write throws mid-stream) -> aborted, never closed
  let failClosed = false;
  let failAborted = false;
  let failWrites = 0;

  const failingDest = {
    async write(_chunk: Uint8Array): Promise<void> {
      failWrites++;
      if (failWrites === 2) {
        throw new Error('DISK_FULL_SIMULATED');
      }
    },
    async close(): Promise<void> {
      failClosed = true;
    },
    async abort(): Promise<void> {
      failAborted = true;
    },
  };

  await assert.rejects(
    () => pipeRenderArtifactToWritable(artifact, failingDest, { chunkSizeBytes: 16 * 1024 }),
    /DISK_FULL_SIMULATED/,
  );
  assert.equal(failClosed, false, 'Interrupted stream must NEVER close destination as complete');
  assert.equal(failAborted, true, 'Interrupted stream must abort destination');

  await artifact.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});

test('8. Cleanup exception in one resource never prevents release of remaining owned reservations, and external sink files are never deleted on dispose', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  let externalDeleted = false;
  let externalHandleClosed = false;
  const externalData = new Uint8Array([10, 20, 30, 40]);

  const externalSink: StreamingByteSink = {
    persistedExternally: true,
    append() {},
    writeAt() {},
    finalizeTempToCommitted() {},
    abortAndCleanup() {
      externalDeleted = true;
    },
    disposeCommitted() {
      externalHandleClosed = true;
      throw new Error('TRANSIENT_HANDLE_CLOSE_ERROR');
    },
    getTotalBytesWritten() {
      return externalData.byteLength;
    },
    async readRange(offset, length) {
      validateArtifactRangeRead(externalData.byteLength, offset, length);
      return externalData.slice(offset, offset + length);
    },
    openReadStream(options?: RenderArtifactReadStreamOptions) {
      const { start, end } = validateArtifactStreamOptions(externalData.byteLength, options);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(externalData.slice(start, end));
          controller.close();
        },
      });
    },
  };

  const artifact = createCommittedRenderArtifact({
    sink: externalSink,
    artifactId: 'art-ext-cleanup',
    sizeBytes: externalData.byteLength,
    memoryBudgetManager: budget,
  });

  const compatRes = budget.reserve({
    owner: 'compat-test',
    category: 'render-export-buffers',
    bytes: 4096,
  });
  artifact.attachOwnedReservation(compatRes);

  let secondCallbackRan = false;
  artifact.attachCleanupCallback(() => {
    secondCallbackRan = true;
  });

  await assert.rejects(() => artifact.dispose(), /TRANSIENT_HANDLE_CLOSE_ERROR/);
  assert.equal(artifact.disposed, true);
  assert.equal(externalHandleClosed, true);
  assert.equal(externalDeleted, false, 'External committed file must NEVER be deleted on dispose');
  assert.equal(secondCallbackRan, true, 'Cleanup error must not block subsequent cleanup callbacks');
  assert.equal(
    budget.getSnapshot().accountedBytes,
    0,
    'Cleanup error must not prevent releasing owned memory reservations',
  );
  assert.equal(budget.getSnapshot().reservationCount, 0);
});

test('9. StudioWorkflowController disposes active artifacts on new render, project replacement, stale async completion, and controller disposal', async () => {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);

  let resolveStaleRender!: () => void;
  const staleGate = new Promise<void>((resolve) => {
    resolveStaleRender = resolve;
  });

  let staleArtifactRef: CommittedRenderOutputArtifact | null = null;
  let callIndex = 0;

  const realEngine = new AudioRenderEngine({ memoryBudgetManager: budget });
  const wrappedEngine = {
    render: async (req: Parameters<AudioRenderEngine['render']>[0]) => {
      callIndex++;
      const res = await realEngine.render(req);
      if (callIndex === 3) {
        // Hold completion until project switches so this render becomes stale
        staleArtifactRef = res.outputArtifact as CommittedRenderOutputArtifact;
        await staleGate;
      }
      return res;
    },
    resumeFromCheckpoint: realEngine.resumeFromCheckpoint.bind(realEngine),
  } as unknown as AudioRenderEngine;

  const ctrl = new StudioWorkflowController({
    memoryBudgetManager: budget,
    renderEngine: wrappedEngine,
  });

  const sampleRate = 48_000 as const;
  const pcm = new Float32Array(24_000).fill(0.2);

  const openDemoProject = (projectId: string) => {
    ctrl.openProject({
      projectId,
      projectName: projectId,
      sourceAudio: {
        sourceAudioId: `src_${projectId}`,
        sourceAudioHash: `sha256:${projectId}`,
        fileName: `${projectId}.wav`,
        format: 'wav',
        sampleRate,
        channelCount: 1,
        bitDepth: 32,
        totalSamples: pcm.length,
        durationSec: pcm.length / sampleRate,
        fileSizeBytes: pcm.byteLength,
        importStatus: 'VALIDATED',
        isDemoFixture: false,
      },
    });
  };

  openDemoProject('proj_wf_1');
  await ctrl.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-main',
    pcmMono: pcm,
    sampleRate,
    wordTokens: [],
  });

  // Render #1
  const r1 = await ctrl.startRender({
    pcmChannels: [pcm],
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 1000,
  });
  assert.ok(r1?.outputArtifact);
  const art1 = r1.outputArtifact;
  assert.equal(art1.disposed, false);
  assert.equal(art1.lifecycleState, 'ACTIVE_IN_WORKFLOW');

  // Render #2 (new render must dispose Render #1's artifact)
  const r2 = await ctrl.startRender({
    pcmChannels: [pcm],
    config: { encoding: 'pcm24', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 2000,
  });
  assert.equal(art1.disposed, true);
  assert.ok(r2?.outputArtifact);
  const art2 = r2.outputArtifact;
  assert.equal(art2.disposed, false);

  // Render #3 (becomes stale when project switches before completion)
  const stalePromise = ctrl.startRender({
    pcmChannels: [pcm],
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 3000,
  });
  // Starting Render #3 immediately disposed Render #2's artifact
  assert.equal(art2.disposed, true);

  // Wait briefly until wrappedEngine has built staleArtifactRef
  for (let i = 0; i < 50 && !staleArtifactRef; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const capturedStaleArtifact = staleArtifactRef as RenderOutputArtifact | null;
  assert.ok(capturedStaleArtifact);
  assert.equal(capturedStaleArtifact.disposed, false);

  // Switch project while Render #3 is still pending
  openDemoProject('proj_wf_2');
  resolveStaleRender();
  const staleRes = await stalePromise;
  assert.equal(staleRes, null, 'Stale completion must return null and not enter workflow');
  assert.equal(
    capturedStaleArtifact.disposed,
    true,
    'Stale completion artifact must be immediately disposed',
  );
  assert.equal(budget.getSnapshot().accountedBytes, 0);

  // Render #4 in project 2, then dispose controller
  await ctrl.analyzeSpeechEventsAndBuildEdl({
    trackId: 'track-main',
    pcmMono: pcm,
    sampleRate,
    wordTokens: [],
  });
  const r4 = await ctrl.startRender({
    pcmChannels: [pcm],
    config: { encoding: 'pcm16', container: 'wav', chunkSizeSamples: 8192 },
    nowMs: 4000,
  });
  assert.ok(r4?.outputArtifact);
  const art4 = r4.outputArtifact;
  assert.equal(art4.disposed, false);
  assert.ok(budget.getSnapshot().accountedBytes > 0);

  ctrl.dispose();
  assert.equal(art4.disposed, true);
  assert.equal(ctrl.getState().lastRenderResult, null);
  assert.equal(budget.getSnapshot().accountedBytes, 0);
  assert.equal(budget.getSnapshot().reservationCount, 0);

  // Repeated controller disposal is harmless
  ctrl.dispose();
  assert.equal(budget.getSnapshot().accountedBytes, 0);
});
