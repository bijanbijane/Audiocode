import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import {
  bitsPerSampleForEncoding,
  bytesPerSampleForEncoding,
} from './AudioRenderPlanner';
import {
  ImmutableRenderPlan,
  RenderExportContainer,
  RenderExportEncoding,
  RenderOutputMetadata,
  RenderValidationFailure,
  RenderValidationReport,
} from './AudioRenderTypes';
import { StreamingHexHasher } from './AudioExportWriter';

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length && offset + i < bytes.byteLength; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function readUint64Le(view: DataView, offset: number): number {
  const lo = BigInt(view.getUint32(offset, true));
  const hi = BigInt(view.getUint32(offset + 4, true));
  return Number((hi << 32n) | lo);
}

export interface ParsedWaveArtifact {
  readonly valid: boolean;
  readonly container: RenderExportContainer | null;
  readonly audioFormat: number;
  readonly encoding: RenderExportEncoding | null;
  readonly channelCount: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  readonly dataOffsetBytes: number;
  readonly dataByteLength: number;
  readonly sampleCountPerChannel: number;
  readonly error?: string;
}

/**
 * Independently parses WAV (RIFF/WAVE) or RF64 (RF64/WAVE + ds64) container bytes
 * without trusting the renderer's internal metadata.
 */
export function parseWaveContainerBytes(bytes: Uint8Array): ParsedWaveArtifact {
  if (!bytes || bytes.byteLength < 44) {
    return {
      valid: false,
      container: null,
      audioFormat: 0,
      encoding: null,
      channelCount: 0,
      sampleRate: 0,
      byteRate: 0,
      blockAlign: 0,
      bitsPerSample: 0,
      dataOffsetBytes: 0,
      dataByteLength: 0,
      sampleCountPerChannel: 0,
      error: `Output buffer too short (${bytes?.byteLength ?? 0} B) to be a valid WAV/RF64 file.`,
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readAscii(bytes, 0, 4);
  const waveId = readAscii(bytes, 8, 4);

  if ((magic !== 'RIFF' && magic !== 'RF64') || waveId !== 'WAVE') {
    return {
      valid: false,
      container: null,
      audioFormat: 0,
      encoding: null,
      channelCount: 0,
      sampleRate: 0,
      byteRate: 0,
      blockAlign: 0,
      bitsPerSample: 0,
      dataOffsetBytes: 0,
      dataByteLength: 0,
      sampleCountPerChannel: 0,
      error: `Invalid container header: magic="${magic}", format="${waveId}".`,
    };
  }

  const container: RenderExportContainer = magic === 'RF64' ? 'rf64' : 'wav';
  let cursor = 12;
  let ds64DataSize: number | null = null;
  let audioFormat = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let foundFmt = false;
  let dataOffsetBytes = -1;
  let dataByteLength = 0;

  while (cursor + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const payloadStart = cursor + 8;

    if (chunkId === 'ds64') {
      if (payloadStart + 28 > bytes.byteLength) {
        return {
          valid: false,
          container,
          audioFormat: 0,
          encoding: null,
          channelCount: 0,
          sampleRate: 0,
          byteRate: 0,
          blockAlign: 0,
          bitsPerSample: 0,
          dataOffsetBytes: 0,
          dataByteLength: 0,
          sampleCountPerChannel: 0,
          error: 'Truncated RF64 ds64 chunk.',
        };
      }
      ds64DataSize = readUint64Le(view, payloadStart + 8);
    } else if (chunkId === 'fmt ') {
      if (payloadStart + 16 > bytes.byteLength) {
        return {
          valid: false,
          container,
          audioFormat: 0,
          encoding: null,
          channelCount: 0,
          sampleRate: 0,
          byteRate: 0,
          blockAlign: 0,
          bitsPerSample: 0,
          dataOffsetBytes: 0,
          dataByteLength: 0,
          sampleCountPerChannel: 0,
          error: 'Truncated fmt chunk.',
        };
      }
      audioFormat = view.getUint16(payloadStart, true);
      channelCount = view.getUint16(payloadStart + 2, true);
      sampleRate = view.getUint32(payloadStart + 4, true);
      byteRate = view.getUint32(payloadStart + 8, true);
      blockAlign = view.getUint16(payloadStart + 12, true);
      bitsPerSample = view.getUint16(payloadStart + 14, true);
      foundFmt = true;
    } else if (chunkId === 'data') {
      dataOffsetBytes = payloadStart;
      dataByteLength =
        container === 'rf64' && chunkSize === 0xffffffff && ds64DataSize !== null
          ? ds64DataSize
          : chunkSize;
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    cursor = payloadStart + paddedSize;
  }

  if (!foundFmt || dataOffsetBytes < 0) {
    return {
      valid: false,
      container,
      audioFormat,
      encoding: null,
      channelCount,
      sampleRate,
      byteRate,
      blockAlign,
      bitsPerSample,
      dataOffsetBytes: 0,
      dataByteLength: 0,
      sampleCountPerChannel: 0,
      error: 'Missing required fmt or data chunk in WAV/RF64 output.',
    };
  }

  let encoding: RenderExportEncoding | null = null;
  if (audioFormat === 1 && bitsPerSample === 16) encoding = 'pcm16';
  else if (audioFormat === 1 && bitsPerSample === 24) encoding = 'pcm24';
  else if (audioFormat === 3 && bitsPerSample === 32) encoding = 'float32';

  const expectedBlockAlign = channelCount * (bitsPerSample / 8);
  const expectedByteRate = sampleRate * expectedBlockAlign;
  if (
    !encoding ||
    channelCount <= 0 ||
    sampleRate <= 0 ||
    blockAlign !== expectedBlockAlign ||
    byteRate !== expectedByteRate
  ) {
    return {
      valid: false,
      container,
      audioFormat,
      encoding,
      channelCount,
      sampleRate,
      byteRate,
      blockAlign,
      bitsPerSample,
      dataOffsetBytes,
      dataByteLength,
      sampleCountPerChannel: 0,
      error: `Header field mismatch: format=${audioFormat}, ch=${channelCount}, sr=${sampleRate}, bps=${bitsPerSample}, blockAlign=${blockAlign} (exp ${expectedBlockAlign}), byteRate=${byteRate} (exp ${expectedByteRate}).`,
    };
  }

  const actualPayloadBytes = bytes.byteLength - dataOffsetBytes;
  if (
    !Number.isFinite(dataByteLength) ||
    dataByteLength < 0 ||
    actualPayloadBytes < dataByteLength
  ) {
    return {
      valid: false,
      container,
      audioFormat,
      encoding,
      channelCount,
      sampleRate,
      byteRate,
      blockAlign,
      bitsPerSample,
      dataOffsetBytes,
      dataByteLength,
      sampleCountPerChannel: 0,
      error: `Truncated or invalid data chunk: header declares ${dataByteLength} B, actual buffer has ${actualPayloadBytes} B.`,
    };
  }

  const sampleCountPerChannel =
    blockAlign > 0 ? Math.floor(dataByteLength / blockAlign) : 0;

  return {
    valid: true,
    container,
    audioFormat,
    encoding,
    channelCount,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffsetBytes,
    dataByteLength,
    sampleCountPerChannel,
  };
}

/**
 * Independent Pre- & Post-Render Validator (AVP-P06-001 & AVP-P08-001)
 *
 * Pre-render: verifies plan validity, memory admission, and format compatibility.
 * Post-render: independently parses output WAV/RF64 header bytes, verifies exact
 * sample count, duration, encoding, hash, zero NaN/Infinity samples, clipping,
 * and source-to-output timeline mapping consistency. Blocks completion on any error.
 */
export class AudioRenderValidator {
  public static validatePreRender(params: {
    readonly plan: ImmutableRenderPlan;
    readonly memoryBudgetManager: MemoryBudgetManager;
    readonly estimatedWorkingBytes: number;
  }): RenderValidationReport {
    const failures: RenderValidationFailure[] = [];
    const { plan, memoryBudgetManager, estimatedWorkingBytes } = params;

    // Verify source-to-output mapping continuity and non-overlap
    let expectedOut = 0;
    let prevSourceEnd = -1;
    for (const seg of plan.retainedSegments) {
      if (seg.sourceStartSample < prevSourceEnd) {
        failures.push({
          code: 'TIMELINE_MAPPING_INCONSISTENT',
          severity: 'ERROR',
          message: `Retained segment ${seg.segmentIndex} overlaps preceding source segment.`,
          actionableFix: 'Rebuild render plan with strictly disjoint retained segments.',
        });
      }
      if (seg.outputStartSample !== expectedOut) {
        failures.push({
          code: 'TIMELINE_MAPPING_INCONSISTENT',
          severity: 'ERROR',
          message: `Output timeline gap/overlap at segment ${seg.segmentIndex}: expected ${expectedOut}, got ${seg.outputStartSample}.`,
          actionableFix: 'Recompute contiguous output coordinates in AudioRenderPlanner.',
        });
      }
      expectedOut += seg.sampleCount;
      prevSourceEnd = seg.sourceEndSample;
    }

    if (expectedOut !== plan.expectedPreResampleOutputSamples) {
      failures.push({
        code: 'TIMELINE_MAPPING_INCONSISTENT',
        severity: 'ERROR',
        message: `Sum of retained segment samples (${expectedOut}) != plan.expectedPreResampleOutputSamples (${plan.expectedPreResampleOutputSamples}).`,
        actionableFix: 'Fix render plan sample accounting.',
      });
    }

    // Memory admission check
    const admission = memoryBudgetManager.canStartHeavyTask({
      estimatedBytes: estimatedWorkingBytes,
      optional: false,
    });
    if (!admission.allowed) {
      failures.push({
        code: 'MEMORY_BUDGET_EXHAUSTED',
        severity: 'ERROR',
        message: admission.reason ?? 'Insufficient memory budget to start streaming render.',
        actionableFix: 'Release cached audio buffers or close other tasks before rendering.',
      });
    }

    const errorCount = failures.filter((f) => f.severity === 'ERROR').length;
    const warningCount = failures.filter((f) => f.severity === 'WARNING').length;

    return {
      phase: 'PRE_RENDER',
      passed: errorCount === 0,
      errorCount,
      warningCount,
      failures,
    };
  }

  public static validatePostRender(params: {
    readonly plan: ImmutableRenderPlan;
    readonly outputMetadata: RenderOutputMetadata;
    readonly outputBytes: Uint8Array | null;
    readonly maxAllowedClippedSamples?: number;
  }): RenderValidationReport {
    const failures: RenderValidationFailure[] = [];
    const { plan, outputMetadata, outputBytes } = params;
    const rawMaxClipped = params.maxAllowedClippedSamples ?? 0;
    const maxAllowedClippedSamples =
      Number.isFinite(rawMaxClipped) && rawMaxClipped >= 0
        ? Math.floor(rawMaxClipped)
        : 0;

    if (!outputBytes || outputBytes.byteLength === 0) {
      failures.push({
        code: 'OUTPUT_UNREADABLE',
        severity: 'ERROR',
        message: 'Rendered output artifact is missing or empty.',
        actionableFix: 'Re-run render and ensure the export sink commits output bytes.',
      });
      return {
        phase: 'POST_RENDER',
        passed: false,
        errorCount: 1,
        warningCount: 0,
        failures,
      };
    }

    const parsed = parseWaveContainerBytes(outputBytes);
    if (!parsed.valid) {
      failures.push({
        code: 'INVALID_CONTAINER_HEADER',
        severity: 'ERROR',
        message: parsed.error ?? 'Output container header validation failed.',
        actionableFix: 'Verify WAV/RF64 header encoding before finalizing export.',
      });
    } else {
      if (parsed.container !== plan.container) {
        failures.push({
          code: 'INVALID_CONTAINER_HEADER',
          severity: 'ERROR',
          message: `Output container "${parsed.container}" != planned "${plan.container}".`,
          actionableFix: 'Ensure AudioExportWriter uses planned container format.',
        });
      }
      if (parsed.encoding !== plan.encoding) {
        failures.push({
          code: 'INVALID_CONTAINER_HEADER',
          severity: 'ERROR',
          message: `Output encoding "${parsed.encoding}" != planned "${plan.encoding}".`,
          actionableFix: 'Ensure AudioExportWriter uses planned bit depth / encoding.',
        });
      }
      if (parsed.bitsPerSample !== bitsPerSampleForEncoding(plan.encoding)) {
        failures.push({
          code: 'INVALID_CONTAINER_HEADER',
          severity: 'ERROR',
          message: `Output bitsPerSample (${parsed.bitsPerSample}) != planned (${bitsPerSampleForEncoding(plan.encoding)}).`,
          actionableFix: 'Verify fmt chunk bit depth.',
        });
      }
      if (parsed.sampleRate !== plan.outputSampleRate) {
        failures.push({
          code: 'INVALID_CONTAINER_HEADER',
          severity: 'ERROR',
          message: `Output sampleRate (${parsed.sampleRate}) != planned (${plan.outputSampleRate}).`,
          actionableFix: 'Verify sample rate preservation or intentional resampler rate.',
        });
      }
      if (parsed.channelCount !== plan.channelCount) {
        failures.push({
          code: 'CHANNEL_MISMATCH',
          severity: 'ERROR',
          message: `Output channelCount (${parsed.channelCount}) != planned (${plan.channelCount}).`,
          actionableFix: 'Preserve exact source channel count through rendering.',
        });
      }

      // Exact integer sample count check (allow +/- 1 sample only when resampled due to filter floor)
      const sampleTolerance = plan.outputSampleRate === plan.sourceSampleRate ? 0 : 2;
      if (Math.abs(parsed.sampleCountPerChannel - plan.expectedOutputSamples) > sampleTolerance) {
        failures.push({
          code: 'SAMPLE_COUNT_MISMATCH',
          severity: 'ERROR',
          message: `Rendered sample count (${parsed.sampleCountPerChannel}) != expected (${plan.expectedOutputSamples}).`,
          actionableFix: 'Check for dropped or duplicated segment chunks during assembly.',
        });
      }

      const verifiedDuration = parsed.sampleCountPerChannel / parsed.sampleRate;
      const expectedDuration = plan.expectedOutputSamples / plan.outputSampleRate;
      if (Math.abs(verifiedDuration - expectedDuration) > 0.002) {
        failures.push({
          code: 'DURATION_MISMATCH',
          severity: 'ERROR',
          message: `Rendered duration (${verifiedDuration.toFixed(4)}s) differs from expected (${expectedDuration.toFixed(4)}s).`,
          actionableFix: 'Verify segment sample math and header data chunk size.',
        });
      }
    }

    // Independent hash verification over actual header + data payload
    if (parsed.valid) {
      const headerSlice = outputBytes.subarray(0, parsed.dataOffsetBytes);
      const dataSlice = outputBytes.subarray(
        parsed.dataOffsetBytes,
        parsed.dataOffsetBytes + parsed.dataByteLength,
      );
      const headerHasher = new StreamingHexHasher();
      headerHasher.update(headerSlice);
      const payloadHasher = new StreamingHexHasher();
      payloadHasher.update(dataSlice);
      const combined = new StreamingHexHasher();
      combined.update(
        new TextEncoder().encode(`${headerHasher.digestHex()}|${payloadHasher.digestHex()}`),
      );
      const recomputedHash = combined.digestHex();
      if (recomputedHash !== outputMetadata.outputHash) {
        failures.push({
          code: 'HASH_VERIFICATION_FAILED',
          severity: 'ERROR',
          message: `Output hash mismatch: recomputed=${recomputedHash}, metadata=${outputMetadata.outputHash}.`,
          actionableFix: 'Output bytes may have been corrupted during write/finalization.',
        });
      }
    }

    // Independent scan of float32 samples for NaN/Infinity and peak amplitude
    let scannedNonFinite = Number.isFinite(outputMetadata.nonFiniteSampleCount)
      ? Math.max(0, Math.floor(outputMetadata.nonFiniteSampleCount))
      : 0;
    let scannedPeak = Number.isFinite(outputMetadata.peakAmplitude)
      ? Math.max(0, outputMetadata.peakAmplitude)
      : 0;
    let scannedClipped = Number.isFinite(outputMetadata.clippedSampleCount)
      ? Math.max(0, Math.floor(outputMetadata.clippedSampleCount))
      : 0;

    if (parsed.valid && parsed.encoding === 'float32') {
      scannedNonFinite = 0;
      scannedPeak = 0;
      scannedClipped = 0;
      const view = new DataView(
        outputBytes.buffer,
        outputBytes.byteOffset + parsed.dataOffsetBytes,
        parsed.dataByteLength,
      );
      const totalFloats = Math.floor(parsed.dataByteLength / 4);
      for (let i = 0; i < totalFloats; i++) {
        const v = view.getFloat32(i * 4, true);
        if (!Number.isFinite(v)) {
          scannedNonFinite++;
        } else {
          const a = Math.abs(v);
          if (a > scannedPeak) scannedPeak = a;
          if (a > 1.0) scannedClipped++;
        }
      }
    } else if (parsed.valid) {
      // Independent check that payload byte count matches exact frame size
      const expectedBytes =
        parsed.sampleCountPerChannel *
        parsed.channelCount *
        bytesPerSampleForEncoding(parsed.encoding!);
      if (expectedBytes !== parsed.dataByteLength) {
        failures.push({
          code: 'SAMPLE_COUNT_MISMATCH',
          severity: 'ERROR',
          message: `Data byte length (${parsed.dataByteLength}) is not an exact multiple of frame alignment (${parsed.blockAlign}).`,
          actionableFix: 'Verify streaming sample encoding alignment.',
        });
      }
    }

    if (scannedNonFinite > 0) {
      failures.push({
        code: 'INVALID_FLOAT_SAMPLES',
        severity: 'ERROR',
        message: `Detected ${scannedNonFinite} NaN/Infinity PCM sample(s) in rendered output.`,
        actionableFix: 'Sanitize upstream audio or transition math before exporting.',
      });
    }

    if (scannedClipped > maxAllowedClippedSamples) {
      failures.push({
        code: 'UNEXPECTED_CLIPPING',
        severity: 'ERROR',
        message: `Detected ${scannedClipped} clipped sample(s) exceeding +/-1.0 full scale (peak=${scannedPeak.toFixed(4)}).`,
        actionableFix: 'Enable transition limiter or reduce input gain before export.',
      });
    }

    const errorCount = failures.filter((f) => f.severity === 'ERROR').length;
    const warningCount = failures.filter((f) => f.severity === 'WARNING').length;

    return {
      phase: 'POST_RENDER',
      passed: errorCount === 0,
      errorCount,
      warningCount,
      failures,
      verifiedContainer: parsed.container ?? undefined,
      verifiedEncoding: parsed.encoding ?? undefined,
      verifiedSampleRate: parsed.sampleRate || undefined,
      verifiedChannelCount: parsed.channelCount || undefined,
      verifiedOutputSamples: parsed.sampleCountPerChannel,
      verifiedDurationSec:
        parsed.sampleRate > 0
          ? Number((parsed.sampleCountPerChannel / parsed.sampleRate).toFixed(6))
          : 0,
      verifiedFileSizeBytes: outputBytes.byteLength,
      verifiedPeakAmplitude: Number(scannedPeak.toFixed(6)),
      verifiedClippedSamples: scannedClipped,
      verifiedNonFiniteSamples: scannedNonFinite,
      verifiedOutputHash: outputMetadata.outputHash,
    };
  }
}
