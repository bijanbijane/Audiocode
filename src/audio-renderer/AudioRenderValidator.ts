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
import { RenderArtifactReader, StreamingHexHasher } from './AudioExportWriter';

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

export const MAX_VALIDATION_READ_BYTES = 1024 * 1024; // 1 MiB

export interface ParsedWaveHeaderArtifact extends ParsedWaveArtifact {
  readonly declaredRiffSizeBytes?: number;
  readonly ds64RiffSizeBytes?: number | null;
  readonly ds64DataSizeBytes?: number | null;
  readonly ds64SampleCount?: number | null;
  readonly actualPayloadBytes?: number;
  readonly misalignedPayload?: boolean;
}

/**
 * Independently parses a bounded WAV (44-byte RIFF/WAVE) or RF64 (80-byte RF64/WAVE + ds64)
 * header window (at most 80 bytes) against the artifact's reported total byte size without
 * requiring or allocating the full output buffer.
 */
export function parseWaveHeaderBytes(
  headerBytes: Uint8Array,
  totalArtifactSizeBytes: number,
): ParsedWaveHeaderArtifact {
  const makeInvalid = (
    error: string,
    partial?: Partial<ParsedWaveHeaderArtifact>,
  ): ParsedWaveHeaderArtifact => ({
    valid: false,
    container: partial?.container ?? null,
    audioFormat: partial?.audioFormat ?? 0,
    encoding: partial?.encoding ?? null,
    channelCount: partial?.channelCount ?? 0,
    sampleRate: partial?.sampleRate ?? 0,
    byteRate: partial?.byteRate ?? 0,
    blockAlign: partial?.blockAlign ?? 0,
    bitsPerSample: partial?.bitsPerSample ?? 0,
    dataOffsetBytes: partial?.dataOffsetBytes ?? 0,
    dataByteLength: partial?.dataByteLength ?? 0,
    sampleCountPerChannel: partial?.sampleCountPerChannel ?? 0,
    declaredRiffSizeBytes: partial?.declaredRiffSizeBytes,
    ds64RiffSizeBytes: partial?.ds64RiffSizeBytes,
    ds64DataSizeBytes: partial?.ds64DataSizeBytes,
    ds64SampleCount: partial?.ds64SampleCount,
    actualPayloadBytes: partial?.actualPayloadBytes,
    misalignedPayload: partial?.misalignedPayload,
    error,
  });

  if (
    !Number.isSafeInteger(totalArtifactSizeBytes) ||
    totalArtifactSizeBytes < 44 ||
    !headerBytes ||
    headerBytes.byteLength < 44
  ) {
    return makeInvalid(
      `Output artifact too short (size=${totalArtifactSizeBytes} B, header=${headerBytes?.byteLength ?? 0} B) to be a valid WAV/RF64 file.`,
    );
  }

  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const magic = readAscii(headerBytes, 0, 4);
  const riffSize32 = view.getUint32(4, true);
  const waveId = readAscii(headerBytes, 8, 4);

  if ((magic !== 'RIFF' && magic !== 'RF64') || waveId !== 'WAVE') {
    return makeInvalid(`Invalid container header: magic="${magic}", format="${waveId}".`);
  }

  const container: RenderExportContainer = magic === 'RF64' ? 'rf64' : 'wav';
  if (container === 'rf64' && (headerBytes.byteLength < 80 || totalArtifactSizeBytes < 80)) {
    return makeInvalid(
      `RF64 header too short (size=${totalArtifactSizeBytes} B, header=${headerBytes.byteLength} B); expected at least 80 bytes.`,
      { container },
    );
  }
  if (container === 'rf64' && riffSize32 !== 0xffffffff) {
    return makeInvalid(
      `Invalid RF64 RIFF size sentinel: expected 0xffffffff, got 0x${riffSize32.toString(16)}.`,
      { container, declaredRiffSizeBytes: riffSize32 },
    );
  }

  let cursor = 12;
  let foundDs64 = false;
  let ds64RiffSizeBytes: number | null = null;
  let ds64DataSizeBytes: number | null = null;
  let ds64SampleCount: number | null = null;
  let audioFormat = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let foundFmt = false;
  let dataOffsetBytes = -1;
  let dataChunkSize32 = 0;

  while (cursor + 8 <= headerBytes.byteLength) {
    const chunkId = readAscii(headerBytes, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const payloadStart = cursor + 8;

    if (chunkId === 'ds64') {
      if (chunkSize < 28 || payloadStart + 28 > headerBytes.byteLength) {
        return makeInvalid('Truncated or malformed RF64 ds64 chunk.', { container });
      }
      ds64RiffSizeBytes = readUint64Le(view, payloadStart);
      ds64DataSizeBytes = readUint64Le(view, payloadStart + 8);
      ds64SampleCount = readUint64Le(view, payloadStart + 16);
      if (
        !Number.isSafeInteger(ds64RiffSizeBytes) ||
        !Number.isSafeInteger(ds64DataSizeBytes) ||
        !Number.isSafeInteger(ds64SampleCount)
      ) {
        return makeInvalid('RF64 ds64 64-bit size fields exceed safe integer bounds.', {
          container,
        });
      }
      foundDs64 = true;
    } else if (chunkId === 'fmt ') {
      if (chunkSize < 16 || payloadStart + 16 > headerBytes.byteLength) {
        return makeInvalid('Truncated or malformed fmt chunk.', { container });
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
      dataChunkSize32 = chunkSize;
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    if (!Number.isSafeInteger(paddedSize) || paddedSize < 0) {
      return makeInvalid(`Malformed chunk "${chunkId}" size (${chunkSize}).`, { container });
    }
    cursor = payloadStart + paddedSize;
  }

  if (!foundFmt || dataOffsetBytes < 0) {
    return makeInvalid('Missing required fmt or data chunk in WAV/RF64 header.', {
      container,
      audioFormat,
      channelCount,
      sampleRate,
      byteRate,
      blockAlign,
      bitsPerSample,
    });
  }

  if (container === 'rf64' && (!foundDs64 || ds64DataSizeBytes === null || ds64RiffSizeBytes === null)) {
    return makeInvalid('Missing required ds64 chunk in RF64 header.', {
      container,
      audioFormat,
      channelCount,
      sampleRate,
      byteRate,
      blockAlign,
      bitsPerSample,
      dataOffsetBytes,
    });
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
    return makeInvalid(
      `Header field mismatch: format=${audioFormat}, ch=${channelCount}, sr=${sampleRate}, bps=${bitsPerSample}, blockAlign=${blockAlign} (exp ${expectedBlockAlign}), byteRate=${byteRate} (exp ${expectedByteRate}).`,
      {
        container,
        audioFormat,
        encoding,
        channelCount,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
        dataOffsetBytes,
      },
    );
  }

  let dataByteLength: number;
  if (container === 'rf64') {
    dataByteLength = ds64DataSizeBytes!;
    if (dataByteLength > 0xffffffff && dataChunkSize32 !== 0xffffffff) {
      return makeInvalid(
        `RF64 data chunk size mismatch: ds64 declares ${dataByteLength} B (>4 GiB), but data chunk 32-bit size is ${dataChunkSize32} instead of 0xffffffff.`,
        {
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
          ds64RiffSizeBytes,
          ds64DataSizeBytes,
          ds64SampleCount,
        },
      );
    }
    if (
      dataByteLength <= 0xffffffff &&
      dataChunkSize32 !== 0xffffffff &&
      dataChunkSize32 !== dataByteLength
    ) {
      return makeInvalid(
        `RF64 data chunk size mismatch: ds64 declares ${dataByteLength} B, but data chunk declares ${dataChunkSize32} B.`,
        {
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
          ds64RiffSizeBytes,
          ds64DataSizeBytes,
          ds64SampleCount,
        },
      );
    }

    const expectedRiffSize64 = totalArtifactSizeBytes - 8;
    if (ds64RiffSizeBytes !== expectedRiffSize64) {
      return makeInvalid(
        `RF64 ds64 RIFF size mismatch: ds64 declares ${ds64RiffSizeBytes} B, actual file-8 is ${expectedRiffSize64} B.`,
        {
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
          ds64RiffSizeBytes,
          ds64DataSizeBytes,
          ds64SampleCount,
        },
      );
    }
  } else {
    dataByteLength = dataChunkSize32;
    const expectedRiffSize32 = totalArtifactSizeBytes - 8;
    if (riffSize32 !== expectedRiffSize32) {
      return makeInvalid(
        `RIFF container size mismatch: header declares ${riffSize32} B, actual file-8 is ${expectedRiffSize32} B.`,
        {
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
          declaredRiffSizeBytes: riffSize32,
        },
      );
    }
  }

  const actualPayloadBytes = totalArtifactSizeBytes - dataOffsetBytes;
  if (!Number.isSafeInteger(dataByteLength) || dataByteLength < 0) {
    return makeInvalid(`Invalid declared data chunk length (${dataByteLength} B).`, {
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
      actualPayloadBytes,
    });
  }

  if (actualPayloadBytes < dataByteLength) {
    return makeInvalid(
      `Truncated data chunk: header declares ${dataByteLength} B, actual artifact has ${actualPayloadBytes} B.`,
      {
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
        actualPayloadBytes,
      },
    );
  }

  if (actualPayloadBytes > dataByteLength) {
    return makeInvalid(
      `Unexpected trailing bytes after declared data chunk: header declares ${dataByteLength} B, actual artifact has ${actualPayloadBytes} B (${actualPayloadBytes - dataByteLength} B extra).`,
      {
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
        actualPayloadBytes,
      },
    );
  }

  const misalignedPayload = blockAlign <= 0 || dataByteLength % blockAlign !== 0;
  const sampleCountPerChannel = blockAlign > 0 ? Math.floor(dataByteLength / blockAlign) : 0;

  if (container === 'rf64' && ds64SampleCount !== null && ds64SampleCount !== sampleCountPerChannel) {
    return makeInvalid(
      `RF64 ds64 sample count mismatch: ds64 declares ${ds64SampleCount}, payload holds ${sampleCountPerChannel}.`,
      {
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
        ds64RiffSizeBytes,
        ds64DataSizeBytes,
        ds64SampleCount,
        actualPayloadBytes,
        misalignedPayload,
      },
    );
  }

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
    declaredRiffSizeBytes: container === 'rf64' ? ds64RiffSizeBytes! : riffSize32,
    ds64RiffSizeBytes,
    ds64DataSizeBytes,
    ds64SampleCount,
    actualPayloadBytes,
    misalignedPayload,
  };
}

/**
 * Independent Pre- & Post-Render Validator (AVP-P06-001, AVP-P08-001 & AVP-RENDER-ARTIFACT-LIFECYCLE-004)
 *
 * Pre-render: verifies plan validity, memory admission, and format compatibility.
 * Post-render: independently parses bounded output WAV/RF64 headers (<=80 B), streams
 * the entire data payload in bounded <=1 MiB windows to verify exact output hash,
 * sample count, duration, encoding, frame alignment, zero NaN/Infinity samples, and clipping.
 * Blocks completion on any error without ever allocating a full-file buffer.
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

  /**
   * Production streaming post-render validator.
   * Reads at most 80 bytes for header inspection and streams the payload in windows
   * no larger than MAX_VALIDATION_READ_BYTES (1 MiB). Never materializes the entire file.
   */
  public static async validatePostRenderArtifact(params: {
    readonly plan: ImmutableRenderPlan;
    readonly outputMetadata: RenderOutputMetadata;
    readonly artifact: RenderArtifactReader;
    readonly maxAllowedClippedSamples?: number;
  }): Promise<RenderValidationReport> {
    const failures: RenderValidationFailure[] = [];
    const { plan, outputMetadata, artifact } = params;
    const rawMaxClipped = params.maxAllowedClippedSamples ?? 0;
    const maxAllowedClippedSamples =
      Number.isFinite(rawMaxClipped) && rawMaxClipped >= 0
        ? Math.floor(rawMaxClipped)
        : 0;

    if (!artifact || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
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

    const headerReadLength = Math.min(80, artifact.sizeBytes);
    let headerBytes: Uint8Array;
    try {
      headerBytes = await artifact.readRange(0, headerReadLength);
    } catch (err) {
      failures.push({
        code: 'OUTPUT_UNREADABLE',
        severity: 'ERROR',
        message: `Failed to read output artifact header: ${err instanceof Error ? err.message : String(err)}`,
        actionableFix: 'Verify committed artifact readability before finalizing export.',
      });
      return {
        phase: 'POST_RENDER',
        passed: false,
        errorCount: 1,
        warningCount: 0,
        failures,
      };
    }

    if (headerBytes.byteLength !== headerReadLength) {
      failures.push({
        code: 'OUTPUT_UNREADABLE',
        severity: 'ERROR',
        message: `Short header read: expected ${headerReadLength} B, received ${headerBytes.byteLength} B.`,
        actionableFix: 'Verify artifact storage integrity and retry export.',
      });
      return {
        phase: 'POST_RENDER',
        passed: false,
        errorCount: 1,
        warningCount: 0,
        failures,
      };
    }

    const parsed = parseWaveHeaderBytes(headerBytes, artifact.sizeBytes);
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

      if (outputMetadata.fileSizeBytes !== artifact.sizeBytes) {
        failures.push({
          code: 'SAMPLE_COUNT_MISMATCH',
          severity: 'ERROR',
          message: `Output file size (${artifact.sizeBytes} B) != metadata fileSizeBytes (${outputMetadata.fileSizeBytes} B).`,
          actionableFix: 'Verify finalized output byte count matches committed artifact size.',
        });
      }

      // Verify exact block alignment & complete sample frames
      const expectedDataBytes =
        parsed.sampleCountPerChannel *
        parsed.channelCount *
        bytesPerSampleForEncoding(parsed.encoding!);
      if (parsed.misalignedPayload || expectedDataBytes !== parsed.dataByteLength) {
        failures.push({
          code: 'SAMPLE_COUNT_MISMATCH',
          severity: 'ERROR',
          message: `Data byte length (${parsed.dataByteLength}) is not an exact multiple of frame alignment (${parsed.blockAlign}).`,
          actionableFix: 'Verify streaming sample encoding alignment.',
        });
      }

      // Exact integer sample count check (allow +/- 2 samples only when resampled due to filter floor)
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

    let scannedNonFinite = Number.isFinite(outputMetadata.nonFiniteSampleCount)
      ? Math.max(0, Math.floor(outputMetadata.nonFiniteSampleCount))
      : 0;
    let scannedPeak = Number.isFinite(outputMetadata.peakAmplitude)
      ? Math.max(0, outputMetadata.peakAmplitude)
      : 0;
    let scannedClipped = Number.isFinite(outputMetadata.clippedSampleCount)
      ? Math.max(0, Math.floor(outputMetadata.clippedSampleCount))
      : 0;

    // Independent single-pass streaming payload verification:
    // 1. Recomputes exact headerDigest | payloadDigest hash over every byte.
    // 2. Independently inspects every IEEE float32 sample across bounded <= 1 MiB reads.
    let recomputedHash: string | undefined;
    if (parsed.valid) {
      const finalHeader = headerBytes.subarray(0, parsed.dataOffsetBytes);
      const headerHasher = new StreamingHexHasher();
      headerHasher.update(finalHeader);
      const headerDigest = headerHasher.digestHex();

      const payloadHasher = new StreamingHexHasher();
      const isFloat32 = parsed.encoding === 'float32';
      if (isFloat32) {
        scannedNonFinite = 0;
        scannedPeak = 0;
        scannedClipped = 0;
      }

      const carry = new Uint8Array(4);
      const carryView = new DataView(carry.buffer);
      let carryLen = 0;

      const payloadStart = parsed.dataOffsetBytes;
      const payloadEnd = payloadStart + parsed.dataByteLength;
      let cursor = payloadStart;
      let payloadReadOk = true;

      while (cursor < payloadEnd) {
        const toRead = Math.min(MAX_VALIDATION_READ_BYTES, payloadEnd - cursor);
        let chunk: Uint8Array;
        try {
          chunk = await artifact.readRange(cursor, toRead);
        } catch (err) {
          failures.push({
            code: 'OUTPUT_UNREADABLE',
            severity: 'ERROR',
            message: `Failed reading payload range [${cursor}, ${cursor + toRead}): ${err instanceof Error ? err.message : String(err)}`,
            actionableFix: 'Ensure committed artifact remains readable for the full duration of validation.',
          });
          payloadReadOk = false;
          break;
        }

        if (chunk.byteLength !== toRead) {
          failures.push({
            code: 'OUTPUT_UNREADABLE',
            severity: 'ERROR',
            message: `Short payload read at offset ${cursor}: expected ${toRead} B, received ${chunk.byteLength} B.`,
            actionableFix: 'Artifact storage returned fewer bytes than declared in container header.',
          });
          payloadReadOk = false;
          break;
        }

        payloadHasher.update(chunk);

        if (isFloat32) {
          let pos = 0;
          if (carryLen > 0) {
            const needed = 4 - carryLen;
            const take = Math.min(needed, chunk.byteLength);
            carry.set(chunk.subarray(0, take), carryLen);
            carryLen += take;
            pos += take;
            if (carryLen === 4) {
              const v = carryView.getFloat32(0, true);
              if (!Number.isFinite(v)) {
                scannedNonFinite++;
              } else {
                const a = Math.abs(v);
                if (a > scannedPeak) scannedPeak = a;
                if (a > 1.0) scannedClipped++;
              }
              carryLen = 0;
            }
          }

          const remainingAligned = chunk.byteLength - pos;
          const wholeFloats = Math.floor(remainingAligned / 4);
          if (wholeFloats > 0) {
            const view = new DataView(
              chunk.buffer,
              chunk.byteOffset + pos,
              wholeFloats * 4,
            );
            for (let i = 0; i < wholeFloats; i++) {
              const v = view.getFloat32(i * 4, true);
              if (!Number.isFinite(v)) {
                scannedNonFinite++;
              } else {
                const a = Math.abs(v);
                if (a > scannedPeak) scannedPeak = a;
                if (a > 1.0) scannedClipped++;
              }
            }
            pos += wholeFloats * 4;
          }

          if (pos < chunk.byteLength) {
            const tailLen = chunk.byteLength - pos;
            carry.set(chunk.subarray(pos, chunk.byteLength), 0);
            carryLen = tailLen;
          }
        }

        cursor += chunk.byteLength;
      }

      if (payloadReadOk) {
        if (isFloat32 && carryLen !== 0) {
          failures.push({
            code: 'SAMPLE_COUNT_MISMATCH',
            severity: 'ERROR',
            message: `Float32 payload ended with ${carryLen} unaligned trailing byte(s).`,
            actionableFix: 'Verify 4-byte float32 sample alignment across all exported chunks.',
          });
        }

        const payloadDigest = payloadHasher.digestHex();
        const combined = new StreamingHexHasher();
        combined.update(new TextEncoder().encode(`${headerDigest}|${payloadDigest}`));
        recomputedHash = combined.digestHex();

        if (recomputedHash !== outputMetadata.outputHash) {
          failures.push({
            code: 'HASH_VERIFICATION_FAILED',
            severity: 'ERROR',
            message: `Output hash mismatch: recomputed=${recomputedHash}, metadata=${outputMetadata.outputHash}.`,
            actionableFix: 'Output bytes may have been corrupted during write/finalization.',
          });
        }
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
      verifiedFileSizeBytes: artifact.sizeBytes,
      verifiedPeakAmplitude: Number(scannedPeak.toFixed(6)),
      verifiedClippedSamples: scannedClipped,
      verifiedNonFiniteSamples: scannedNonFinite,
      verifiedOutputHash: recomputedHash ?? outputMetadata.outputHash,
    };
  }

  /**
   * @deprecated Use `validatePostRenderArtifact()` for streaming bounded-memory validation.
   * Retained solely for legacy unit-test compatibility on small contiguous buffers.
   */
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
