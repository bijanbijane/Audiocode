import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioExportWriter,
  BoundedChunkedByteSink,
  buildWaveContainerHeader,
  DEFAULT_MAX_ARTIFACT_READ_BYTES,
  RenderArtifactReader,
  RenderArtifactReadStreamOptions,
  StreamingHexHasher,
  validateArtifactRangeRead,
  validateArtifactStreamOptions,
} from './AudioExportWriter';
import {
  AudioRenderValidator,
  MAX_VALIDATION_READ_BYTES,
} from './AudioRenderValidator';
import { AudioRenderPlanner, bytesPerSampleForEncoding } from './AudioRenderPlanner';
import {
  ImmutableRenderPlan,
  RenderExportContainer,
  RenderExportEncoding,
  RenderOutputMetadata,
} from './AudioRenderTypes';
import { createCommittedRenderArtifact, pipeRenderArtifactToWritable } from './RenderOutputArtifact';
import { EditDecisionEngine } from '../ai-engine/edit-decision/EditDecisionEngine';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import { AVAPARDAZ_MEMORY_POLICY } from '../runtime/memory/MemoryPolicy';

/**
 * Instrumented range reader that records exact read bounds and verifies zero full-file reads.
 */
class InstrumentedArtifactReader implements RenderArtifactReader {
  public readonly sizeBytes: number;
  public readCount = 0;
  public maxReadLength = 0;
  public fullFileReadCount = 0;

  private readonly inner: RenderArtifactReader;
  private readonly payloadStart: number;
  private readonly payloadEnd: number;
  private readonly coveredPayloadIntervals: Array<[number, number]> = [];

  constructor(inner: RenderArtifactReader, payloadStart: number, payloadLength: number) {
    this.inner = inner;
    this.sizeBytes = inner.sizeBytes;
    this.payloadStart = payloadStart;
    this.payloadEnd = payloadStart + payloadLength;
  }

  public get totalPayloadBytesRead(): number {
    if (this.coveredPayloadIntervals.length === 0) return 0;
    const sorted = [...this.coveredPayloadIntervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curStart, curEnd] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const [nextStart, nextEnd] = sorted[i];
      if (nextStart <= curEnd) {
        if (nextEnd > curEnd) curEnd = nextEnd;
      } else {
        total += curEnd - curStart;
        curStart = nextStart;
        curEnd = nextEnd;
      }
    }
    total += curEnd - curStart;
    return total;
  }

  public async readRange(offset: number, length: number): Promise<Uint8Array> {
    this.readCount++;
    if (length > this.maxReadLength) this.maxReadLength = length;
    if (this.sizeBytes > MAX_VALIDATION_READ_BYTES && length >= this.sizeBytes) {
      this.fullFileReadCount++;
    }
    const overlapStart = Math.max(offset, this.payloadStart);
    const overlapEnd = Math.min(offset + length, this.payloadEnd);
    if (overlapEnd > overlapStart) {
      this.coveredPayloadIntervals.push([overlapStart, overlapEnd]);
    }
    return this.inner.readRange(offset, length);
  }

  public openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array> {
    return this.inner.openReadStream(options);
  }
}

/**
 * Synthetic virtual reader backed by deterministic on-the-fly generation (zero multi-hundred-MiB RAM).
 * Allows validating and benchmarking 8 MiB, 32 MiB, 64 MiB, and 256 MiB WAV/RF64 artifacts in milliseconds.
 */
class SyntheticVirtualWaveReader implements RenderArtifactReader {
  public readonly sizeBytes: number;
  public readonly headerBytes: Uint8Array;
  public readonly dataOffsetBytes: number;
  public readonly dataByteLength: number;
  public readonly outputHash: string;

  private readonly patternBlock: Uint8Array;
  private readonly maxReadWindowBytes: number;

  constructor(params: {
    readonly container: RenderExportContainer;
    readonly encoding: RenderExportEncoding;
    readonly sampleRate: 16000 | 44100 | 48000;
    readonly channelCount: number;
    readonly totalOutputSamples: number;
    readonly extraTrailingBytes?: number;
    readonly truncateByBytes?: number;
    readonly injectMutatedPayloadOffset?: number;
    readonly injectMutatedBytes?: Uint8Array;
    readonly maxReadWindowBytes?: number;
  }) {
    const bps = bytesPerSampleForEncoding(params.encoding);
    const dataBytes = params.totalOutputSamples * params.channelCount * bps;
    const header = buildWaveContainerHeader({
      container: params.container,
      encoding: params.encoding,
      sampleRate: params.sampleRate,
      channelCount: params.channelCount,
      totalOutputSamples: params.totalOutputSamples,
      dataBytes,
    });

    this.headerBytes = header;
    this.dataOffsetBytes = header.byteLength;
    this.dataByteLength = dataBytes;
    this.sizeBytes =
      header.byteLength +
      dataBytes +
      (params.extraTrailingBytes ?? 0) -
      (params.truncateByBytes ?? 0);
    this.maxReadWindowBytes = params.maxReadWindowBytes ?? DEFAULT_MAX_ARTIFACT_READ_BYTES;

    // 64 KiB repeating valid sample pattern (divisible by 4, 8, 12, 16, 24)
    const patternLen = 64 * 1024;
    this.patternBlock = new Uint8Array(patternLen);
    if (params.encoding === 'float32') {
      const view = new DataView(this.patternBlock.buffer);
      for (let i = 0; i < patternLen / 4; i++) {
        view.setFloat32(i * 4, 0.25 * Math.sin(i * 0.01), true);
      }
    } else {
      for (let i = 0; i < patternLen; i++) {
        this.patternBlock[i] = (i * 17 + 31) & 0xff;
      }
    }

    // Precompute exact expected output hash using bounded 1 MiB passes over the virtual payload
    const headerHasher = new StreamingHexHasher();
    headerHasher.update(this.headerBytes);
    const payloadHasher = new StreamingHexHasher();
    const scratch = new Uint8Array(Math.min(1024 * 1024, Math.max(1, dataBytes)));
    let remaining = dataBytes;
    let payloadPos = 0;
    while (remaining > 0) {
      const len = Math.min(scratch.byteLength, remaining);
      this.fillPayloadSlice(scratch, 0, payloadPos, len, params.injectMutatedPayloadOffset, params.injectMutatedBytes);
      payloadHasher.update(scratch.subarray(0, len));
      payloadPos += len;
      remaining -= len;
    }
    const combined = new StreamingHexHasher();
    combined.update(
      new TextEncoder().encode(`${headerHasher.digestHex()}|${payloadHasher.digestHex()}`),
    );
    this.outputHash = combined.digestHex();
    this.mutatedOffset = params.injectMutatedPayloadOffset;
    this.mutatedBytes = params.injectMutatedBytes;
  }

  private readonly mutatedOffset?: number;
  private readonly mutatedBytes?: Uint8Array;

  private fillPayloadSlice(
    dest: Uint8Array,
    destOffset: number,
    payloadOffset: number,
    length: number,
    mutatedOffset?: number,
    mutatedBytes?: Uint8Array,
  ): void {
    const pLen = this.patternBlock.byteLength;
    let written = 0;
    while (written < length) {
      const pIdx = (payloadOffset + written) % pLen;
      const chunkLen = Math.min(length - written, pLen - pIdx);
      dest.set(this.patternBlock.subarray(pIdx, pIdx + chunkLen), destOffset + written);
      written += chunkLen;
    }
    if (mutatedOffset !== undefined && mutatedBytes) {
      const mutStart = mutatedOffset;
      const mutEnd = mutatedOffset + mutatedBytes.byteLength;
      const sliceStart = payloadOffset;
      const sliceEnd = payloadOffset + length;
      const overlapStart = Math.max(mutStart, sliceStart);
      const overlapEnd = Math.min(mutEnd, sliceEnd);
      if (overlapEnd > overlapStart) {
        dest.set(
          mutatedBytes.subarray(overlapStart - mutStart, overlapEnd - mutStart),
          destOffset + (overlapStart - sliceStart),
        );
      }
    }
  }

  public async readRange(offset: number, length: number): Promise<Uint8Array> {
    validateArtifactRangeRead(this.sizeBytes, offset, length, this.maxReadWindowBytes);
    const out = new Uint8Array(length);
    if (length === 0) return out;

    let pos = 0;
    let cursor = offset;

    if (cursor < this.headerBytes.byteLength) {
      const headerTake = Math.min(length, this.headerBytes.byteLength - cursor);
      out.set(this.headerBytes.subarray(cursor, cursor + headerTake), pos);
      pos += headerTake;
      cursor += headerTake;
    }

    if (pos < length) {
      const payloadOffset = cursor - this.headerBytes.byteLength;
      this.fillPayloadSlice(
        out,
        pos,
        payloadOffset,
        length - pos,
        this.mutatedOffset,
        this.mutatedBytes,
      );
    }

    return out;
  }

  public openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array> {
    const { start, end, chunkSizeBytes } = validateArtifactStreamOptions(
      this.sizeBytes,
      options,
      this.maxReadWindowBytes,
    );
    let cursor = start;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (cursor >= end) {
          controller.close();
          return;
        }
        const toRead = Math.min(chunkSizeBytes, end - cursor);
        const slice = await this.readRange(cursor, toRead);
        cursor += slice.byteLength;
        controller.enqueue(slice);
        if (cursor >= end) controller.close();
      },
    });
  }
}

async function buildSyntheticPlanAndMeta(params: {
  container: RenderExportContainer;
  encoding: RenderExportEncoding;
  sampleRate: 16000 | 44100 | 48000;
  channelCount: number;
  totalOutputSamples: number;
  fileSizeBytes: number;
  outputHash: string;
}): Promise<{ plan: ImmutableRenderPlan; metadata: RenderOutputMetadata }> {
  const edl = await EditDecisionEngine.generateEdl({
    context: {
      projectId: 'proj-val',
      sourceAudioId: 'src-val',
      sourceAudioHash: 'sha256:val-test',
      transcriptVersion: 'tr-v1',
      sampleRate: params.sampleRate,
      channelLayout: params.channelCount === 2 ? 'stereo' : 'mono',
      totalSourceSamples: params.totalOutputSamples,
    },
    events: [],
    tokens: [],
    nowMs: 1000,
  });

  const planRes = AudioRenderPlanner.buildPlan({
    edl,
    sourceAudioId: 'src-val',
    sourceAudioHash: 'sha256:val-test',
    sourceSampleRate: params.sampleRate,
    channelCount: params.channelCount,
    totalSourceSamples: params.totalOutputSamples,
    expectedSourceAudioHash: 'sha256:val-test',
    expectedTranscriptVersion: 'tr-v1',
    expectedEdlVersion: edl.edlVersion,
    config: {
      container: params.container,
      encoding: params.encoding,
    },
    nowMs: 1000,
  });
  assert.equal(planRes.ok, true, planRes.failures.map((f) => f.message).join('; '));
  const plan = planRes.plan!;

  const metadata: RenderOutputMetadata = {
    renderId: 'rnd-val',
    artifactId: 'art-val',
    container: params.container,
    encoding: params.encoding,
    bitsPerSample: params.encoding === 'pcm16' ? 16 : params.encoding === 'pcm24' ? 24 : 32,
    sampleRate: params.sampleRate,
    channelCount: params.channelCount,
    totalOutputSamples: params.totalOutputSamples,
    durationSec: Number((params.totalOutputSamples / params.sampleRate).toFixed(6)),
    fileSizeBytes: params.fileSizeBytes,
    outputHash: params.outputHash,
    peakAmplitude: 0.25,
    truePeakDbfs: -12,
    clippedSampleCount: 0,
    nonFiniteSampleCount: 0,
    persistedExternally: true,
    finalizedAtMs: 1001,
  };

  return { plan, metadata };
}

async function generateRealArtifactBytes(params: {
  container: RenderExportContainer;
  encoding: RenderExportEncoding;
  sampleRate: 16000 | 44100 | 48000;
  channelCount: number;
  samples: number;
  mutateSamples?: (channels: Float32Array[]) => void;
}) {
  const budget = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
  const sink = new BoundedChunkedByteSink({ memoryBudgetManager: budget });
  const writer = new AudioExportWriter({
    renderId: 'rnd-gen',
    artifactId: 'art-gen',
    container: params.container,
    encoding: params.encoding,
    sampleRate: params.sampleRate,
    channelCount: params.channelCount,
    sink,
  });
  await writer.begin();
  const channels = Array.from({ length: params.channelCount }, (_, ch) => {
    const arr = new Float32Array(params.samples);
    for (let i = 0; i < params.samples; i++) {
      arr[i] = 0.25 * Math.sin(((i + ch * 17) * 2 * Math.PI * 220) / params.sampleRate);
    }
    return arr;
  });
  params.mutateSamples?.(channels);
  await writer.writePlanarChunk(channels, params.samples);
  const meta = await writer.finalize(2000);
  const artifact = createCommittedRenderArtifact({
    sink,
    artifactId: meta.artifactId,
    sizeBytes: meta.fileSizeBytes,
    memoryBudgetManager: budget,
  });
  const { plan } = await buildSyntheticPlanAndMeta({
    container: params.container,
    encoding: params.encoding,
    sampleRate: params.sampleRate,
    channelCount: params.channelCount,
    totalOutputSamples: params.samples,
    fileSizeBytes: meta.fileSizeBytes,
    outputHash: meta.outputHash,
  });
  return { artifact, meta, plan, budget };
}

function createBufferArtifactReader(bytes: Uint8Array): RenderArtifactReader {
  return {
    sizeBytes: bytes.byteLength,
    async readRange(offset: number, length: number): Promise<Uint8Array> {
      validateArtifactRangeRead(bytes.byteLength, offset, length);
      return bytes.slice(offset, offset + length);
    },
    openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array> {
      const { start, end, chunkSizeBytes } = validateArtifactStreamOptions(bytes.byteLength, options);
      let cursor = start;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cursor >= end) {
            controller.close();
            return;
          }
          const toRead = Math.min(chunkSizeBytes, end - cursor);
          controller.enqueue(bytes.slice(cursor, cursor + toRead));
          cursor += toRead;
          if (cursor >= end) controller.close();
        },
      });
    },
  };
}

test('1. Streaming validator passes valid 44-byte RIFF WAV & 80-byte RF64 across PCM16, PCM24, Float32, and multi-channel outputs', async () => {
  const cases: Array<{
    container: RenderExportContainer;
    encoding: RenderExportEncoding;
    channelCount: number;
    sampleRate: 16000 | 44100 | 48000;
  }> = [
    { container: 'wav', encoding: 'pcm16', channelCount: 1, sampleRate: 48000 },
    { container: 'wav', encoding: 'pcm24', channelCount: 2, sampleRate: 44100 },
    { container: 'wav', encoding: 'float32', channelCount: 2, sampleRate: 48000 },
    { container: 'rf64', encoding: 'pcm16', channelCount: 2, sampleRate: 48000 },
    { container: 'rf64', encoding: 'pcm24', channelCount: 1, sampleRate: 16000 },
    { container: 'rf64', encoding: 'float32', channelCount: 4, sampleRate: 48000 },
  ];

  for (const tc of cases) {
    const { artifact, meta, plan, budget } = await generateRealArtifactBytes({
      container: tc.container,
      encoding: tc.encoding,
      sampleRate: tc.sampleRate,
      channelCount: tc.channelCount,
      samples: 4096,
    });

    const report = await AudioRenderValidator.validatePostRenderArtifact({
      plan,
      outputMetadata: meta,
      artifact,
    });

    assert.equal(
      report.passed,
      true,
      `Case ${tc.container}/${tc.encoding}/${tc.channelCount}ch failed: ${report.failures.map((f) => f.message).join(' | ')}`,
    );
    assert.equal(report.verifiedContainer, tc.container);
    assert.equal(report.verifiedEncoding, tc.encoding);
    assert.equal(report.verifiedChannelCount, tc.channelCount);
    assert.equal(report.verifiedSampleRate, tc.sampleRate);
    assert.equal(report.verifiedOutputSamples, 4096);
    assert.equal(report.verifiedFileSizeBytes, meta.fileSizeBytes);
    assert.equal(report.verifiedOutputHash, meta.outputHash);

    await artifact.dispose();
    assert.equal(budget.getSnapshot().accountedBytes, 0);
  }
});

test('2. Streaming validator rejects corrupted header, bad ds64 sizes, bad fmt fields, truncated payload, trailing bytes, misaligned payload, and hash mismatch', async () => {
  const base = await generateRealArtifactBytes({
    container: 'wav',
    encoding: 'pcm16',
    sampleRate: 48000,
    channelCount: 2,
    samples: 1024,
  });
  const baseBytes = await base.artifact.readRange(0, base.artifact.sizeBytes);
  await base.artifact.dispose();

  // A. Corrupted RIFF magic
  {
    const bad = new Uint8Array(baseBytes);
    bad[0] = 0x58; // 'XIFF'
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: base.plan,
      outputMetadata: base.meta,
      artifact: createBufferArtifactReader(bad),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));
  }

  // B. Corrupted fmt field (wrong blockAlign)
  {
    const bad = new Uint8Array(baseBytes);
    new DataView(bad.buffer).setUint16(32, 99, true);
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: base.plan,
      outputMetadata: base.meta,
      artifact: createBufferArtifactReader(bad),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));
  }

  // C. Truncated payload
  {
    const truncated = baseBytes.slice(0, baseBytes.byteLength - 8);
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: base.plan,
      outputMetadata: base.meta,
      artifact: createBufferArtifactReader(truncated),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));
  }

  // D. Additional bytes after expected payload
  {
    const extra = new Uint8Array(baseBytes.byteLength + 16);
    extra.set(baseBytes, 0);
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: base.plan,
      outputMetadata: base.meta,
      artifact: createBufferArtifactReader(extra),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));
  }

  // E. Incorrect output hash (single payload byte flipped)
  {
    const tampered = new Uint8Array(baseBytes);
    tampered[tampered.byteLength - 1] ^= 0x01;
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: base.plan,
      outputMetadata: base.meta,
      artifact: createBufferArtifactReader(tampered),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'HASH_VERIFICATION_FAILED'));
  }

  // F. Misaligned payload (header & file size agree on non-frame-multiple data length)
  {
    const misalignedDataLen = 1024 * 4 - 2; // stereo pcm16 blockAlign=4 -> 2 bytes misaligned
    const misalignedHeader = buildWaveContainerHeader({
      container: 'wav',
      encoding: 'pcm16',
      sampleRate: 48000,
      channelCount: 2,
      totalOutputSamples: 1023,
      dataBytes: misalignedDataLen,
    });
    const misalignedFile = new Uint8Array(44 + misalignedDataLen);
    misalignedFile.set(misalignedHeader, 0);
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: base.plan,
      outputMetadata: { ...base.meta, fileSizeBytes: misalignedFile.byteLength },
      artifact: createBufferArtifactReader(misalignedFile),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'SAMPLE_COUNT_MISMATCH'));
  }

  // G. Incorrect RF64 ds64 sizes
  {
    const rf64 = await generateRealArtifactBytes({
      container: 'rf64',
      encoding: 'pcm24',
      sampleRate: 48000,
      channelCount: 2,
      samples: 512,
    });
    const rfBytes = await rf64.artifact.readRange(0, rf64.artifact.sizeBytes);
    await rf64.artifact.dispose();

    // Corrupt ds64 dataSize64 (offset 28)
    const badDs64 = new Uint8Array(rfBytes);
    new DataView(badDs64.buffer).setUint32(28, 1234, true);
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: rf64.plan,
      outputMetadata: rf64.meta,
      artifact: createBufferArtifactReader(badDs64),
    });
    assert.equal(rep.passed, false);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));

    // Corrupt ds64 sampleCount64 (offset 36)
    const badSampleCount = new Uint8Array(rfBytes);
    new DataView(badSampleCount.buffer).setUint32(36, 9999, true);
    const rep2 = await AudioRenderValidator.validatePostRenderArtifact({
      plan: rf64.plan,
      outputMetadata: rf64.meta,
      artifact: createBufferArtifactReader(badSampleCount),
    });
    assert.equal(rep2.passed, false);
    assert.ok(rep2.failures.some((f) => f.code === 'INVALID_CONTAINER_HEADER'));
  }
});

test('3. Streaming validator independently detects injected NaN, Infinity, and clipped float32 samples across bounded reads', async () => {
  // A. Injected NaN
  {
    const nanCase = await generateRealArtifactBytes({
      container: 'wav',
      encoding: 'float32',
      sampleRate: 48000,
      channelCount: 1,
      samples: 2048,
      mutateSamples: ([ch]) => {
        ch[1500] = Number.NaN;
      },
    });
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: nanCase.plan,
      outputMetadata: { ...nanCase.meta, nonFiniteSampleCount: 0 }, // lie in metadata; validator must catch independently
      artifact: nanCase.artifact,
    });
    await nanCase.artifact.dispose();
    assert.equal(rep.passed, false);
    assert.equal(rep.verifiedNonFiniteSamples, 1);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_FLOAT_SAMPLES'));
  }

  // B. Injected Infinity
  {
    const infCase = await generateRealArtifactBytes({
      container: 'wav',
      encoding: 'float32',
      sampleRate: 48000,
      channelCount: 1,
      samples: 2048,
      mutateSamples: ([ch]) => {
        ch[777] = Number.POSITIVE_INFINITY;
      },
    });
    const rep = await AudioRenderValidator.validatePostRenderArtifact({
      plan: infCase.plan,
      outputMetadata: { ...infCase.meta, nonFiniteSampleCount: 0 },
      artifact: infCase.artifact,
    });
    await infCase.artifact.dispose();
    assert.equal(rep.passed, false);
    assert.equal(rep.verifiedNonFiniteSamples, 1);
    assert.ok(rep.failures.some((f) => f.code === 'INVALID_FLOAT_SAMPLES'));
  }

  // C. Injected clipped float32 values with exact threshold enforcement
  {
    const clipCase = await generateRealArtifactBytes({
      container: 'wav',
      encoding: 'float32',
      sampleRate: 48000,
      channelCount: 1,
      samples: 2048,
      mutateSamples: ([ch]) => {
        ch[10] = 1.25;
        ch[20] = -1.5;
      },
    });
    const repFail = await AudioRenderValidator.validatePostRenderArtifact({
      plan: clipCase.plan,
      outputMetadata: { ...clipCase.meta, clippedSampleCount: 0 },
      artifact: clipCase.artifact,
      maxAllowedClippedSamples: 1,
    });
    assert.equal(repFail.passed, false);
    assert.equal(repFail.verifiedClippedSamples, 2);
    assert.equal(repFail.verifiedPeakAmplitude, 1.5);
    assert.ok(repFail.failures.some((f) => f.code === 'UNEXPECTED_CLIPPING'));

    const repAllow = await AudioRenderValidator.validatePostRenderArtifact({
      plan: clipCase.plan,
      outputMetadata: clipCase.meta,
      artifact: clipCase.artifact,
      maxAllowedClippedSamples: 2,
    });
    assert.equal(repAllow.passed, true);
    await clipCase.artifact.dispose();
  }
});

test('4. Large-file streaming validation & benchmark suite (8 MiB, 32 MiB, 64 MiB, 256 MiB) with instrumented zero-full-read enforcement', async () => {
  const sizesMiB = [8, 32, 64, 256] as const;

  for (const sizeMiB of sizesMiB) {
    const targetPayloadBytes = sizeMiB * 1024 * 1024;
    const channelCount = 1;
    const encoding: RenderExportEncoding = sizeMiB === 256 ? 'float32' : 'pcm16';
    const container: RenderExportContainer = sizeMiB === 256 ? 'rf64' : 'wav';
    const bps = bytesPerSampleForEncoding(encoding);
    const totalOutputSamples = targetPayloadBytes / (channelCount * bps);

    const virtualReader = new SyntheticVirtualWaveReader({
      container,
      encoding,
      sampleRate: 48000,
      channelCount,
      totalOutputSamples,
    });

    const { plan, metadata } = await buildSyntheticPlanAndMeta({
      container,
      encoding,
      sampleRate: 48000,
      channelCount,
      totalOutputSamples,
      fileSizeBytes: virtualReader.sizeBytes,
      outputHash: virtualReader.outputHash,
    });

    const instrumented = new InstrumentedArtifactReader(
      virtualReader,
      virtualReader.dataOffsetBytes,
      virtualReader.dataByteLength,
    );

    const t0 = performance.now();
    const report = await AudioRenderValidator.validatePostRenderArtifact({
      plan,
      outputMetadata: metadata,
      artifact: instrumented,
    });
    const validationMs = Number((performance.now() - t0).toFixed(2));

    assert.equal(
      report.passed,
      true,
      `${sizeMiB} MiB validation failed: ${report.failures.map((f) => f.message).join(' | ')}`,
    );

    // Mandatory instrumented large-file assertions (Section 11)
    assert.ok(
      instrumented.maxReadLength <= MAX_VALIDATION_READ_BYTES,
      `${sizeMiB} MiB exceeded 1 MiB read window: ${instrumented.maxReadLength}`,
    );
    assert.equal(
      instrumented.fullFileReadCount,
      0,
      `${sizeMiB} MiB triggered a full-file read`,
    );
    assert.equal(
      instrumented.totalPayloadBytesRead,
      virtualReader.dataByteLength,
      `${sizeMiB} MiB skipped payload bytes: read ${instrumented.totalPayloadBytesRead} of ${virtualReader.dataByteLength}`,
    );

    // Verify streaming download completion over the 256 MiB virtual artifact as well
    if (sizeMiB === 256) {
      let downloadedBytes = 0;
      let downloadClosed = false;
      const virtualArtifact = {
        artifactId: `virtual-${sizeMiB}mb`,
        sizeBytes: virtualReader.sizeBytes,
        contentType: 'audio/wav' as const,
        persistedExternally: true,
        disposed: false,
        lifecycleState: 'VALIDATED_READY' as const,
        readRange: virtualReader.readRange.bind(virtualReader),
        openReadStream: virtualReader.openReadStream.bind(virtualReader),
        createBlob: async () => new Blob([]),
        dispose: async () => {},
      };
      const transferred = await pipeRenderArtifactToWritable(virtualArtifact, {
        async write(chunk) {
          assert.ok(chunk.byteLength <= MAX_VALIDATION_READ_BYTES);
          downloadedBytes += chunk.byteLength;
        },
        async close() {
          downloadClosed = true;
        },
        async abort() {
          throw new Error('unexpected abort');
        },
      });
      assert.equal(downloadClosed, true);
      assert.equal(transferred, virtualReader.sizeBytes);
      assert.equal(downloadedBytes, virtualReader.sizeBytes);
    }

    assert.ok(validationMs >= 0);
  }
});

test('5. Large 256 MiB virtual float32 artifact catches a single injected NaN sample near EOF without full-file allocation', async () => {
  const payloadBytes = 256 * 1024 * 1024;
  const totalOutputSamples = payloadBytes / 4;
  const nanBytes = new Uint8Array(4);
  new DataView(nanBytes.buffer).setFloat32(0, Number.NaN, true);

  const virtualReader = new SyntheticVirtualWaveReader({
    container: 'rf64',
    encoding: 'float32',
    sampleRate: 48000,
    channelCount: 1,
    totalOutputSamples,
    injectMutatedPayloadOffset: payloadBytes - 4, // very last float sample of 256 MiB payload
    injectMutatedBytes: nanBytes,
  });

  const { plan, metadata } = await buildSyntheticPlanAndMeta({
    container: 'rf64',
    encoding: 'float32',
    sampleRate: 48000,
    channelCount: 1,
    totalOutputSamples,
    fileSizeBytes: virtualReader.sizeBytes,
    outputHash: virtualReader.outputHash,
  });

  const instrumented = new InstrumentedArtifactReader(
    virtualReader,
    virtualReader.dataOffsetBytes,
    virtualReader.dataByteLength,
  );

  const report = await AudioRenderValidator.validatePostRenderArtifact({
    plan,
    outputMetadata: metadata,
    artifact: instrumented,
  });

  assert.equal(report.passed, false);
  assert.equal(report.verifiedNonFiniteSamples, 1);
  assert.ok(report.failures.some((f) => f.code === 'INVALID_FLOAT_SAMPLES'));
  assert.ok(instrumented.maxReadLength <= MAX_VALIDATION_READ_BYTES);
  assert.equal(instrumented.fullFileReadCount, 0);
  assert.equal(instrumented.totalPayloadBytesRead, virtualReader.dataByteLength);
});
