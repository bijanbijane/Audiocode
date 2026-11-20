import {
  AcousticProfile,
  AudioAsset,
  FileHandleLease,
  IngestTransactionSnapshot,
  IngestTransactionState,
  PersistedAudioAssetManifest,
  SmartRecommendation,
  StorageBrokerTelemetry,
  Track,
} from '../contracts/v1_2';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import { AudioSecurityGuard, SupportedAudioContainer } from '../security/AudioSecurityGuard';
import { detectLongPauses, refinePersianCutBoundary } from './dsp';
import { StreamingPeakPyramidBuilder } from './peakPyramid';
import { StreamingKaiserSincResampler } from './resampler';
import {
  buildSeekTable,
  computeDeterministicAssetId,
  StorageBrokerClient,
  WritePcmBlockResult,
} from './storageBroker';
import { WorkerPersistenceBackend } from './workerStorageCore';
import { flicksToSeconds, secondsToFlicks } from './timebase';
import { LoadedStudioProject } from './audioFixtures';
import { HASH_CHUNK_BYTES, sha256Blob } from '../utils/StreamingSha256';

/**
 * Idempotent runtime-only resource ownership handle transferred to a successfully constructed
 * LoadedStudioProject. Must never be serialized into persistent project documents or manifests.
 */
export interface ProjectRuntimeResourceLease {
  readonly disposed: boolean;
  dispose(): void;
}

export function createProjectRuntimeResourceLease(
  memoryBudgetManager: MemoryBudgetManager,
  reservation: MemoryReservation,
): ProjectRuntimeResourceLease {
  let isDisposed = false;
  return {
    get disposed(): boolean {
      return isDisposed;
    },
    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;
      memoryBudgetManager.release(reservation);
    },
  };
}

/**
 * Deterministic single-active-project lease holder used by UI/application lifecycles to guarantee
 * previous project reservations are released exactly once on project replacement, demo restore,
 * or unmount, while keeping existing project reservations intact on failed imports.
 */
export class ProjectResourceLeaseSlot {
  private activeLease: ProjectRuntimeResourceLease | null = null;

  public get current(): ProjectRuntimeResourceLease | null {
    return this.activeLease;
  }

  public replaceWith(nextLease: ProjectRuntimeResourceLease | null | undefined): void {
    const previous = this.activeLease;
    if (previous && previous === nextLease) {
      return;
    }
    this.activeLease = nextLease ?? null;
    previous?.dispose();
  }

  public clear(): void {
    const previous = this.activeLease;
    this.activeLease = null;
    previous?.dispose();
  }
}

export function computeSafeResidentPcmBytes(totalSamples: number): number {
  if (
    typeof totalSamples !== 'number' ||
    !Number.isFinite(totalSamples) ||
    !Number.isSafeInteger(totalSamples) ||
    totalSamples <= 0
  ) {
    throw new RangeError(
      `INGEST_INVALID_PCM_SIZE: totalSamples must be a positive safe integer, received ${String(totalSamples)}.`,
    );
  }
  const bytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isFinite(bytes) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes / Float32Array.BYTES_PER_ELEMENT !== totalSamples
  ) {
    throw new RangeError(
      `INGEST_INVALID_PCM_SIZE: Resident PCM byte count overflows safe integer arithmetic for totalSamples=${totalSamples}.`,
    );
  }
  return bytes;
}

export function computeSafeDecodedSampleBytes(
  length: number,
  numberOfChannels: number,
): number {
  if (
    typeof length !== 'number' ||
    !Number.isFinite(length) ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    throw new RangeError(
      `INGEST_INVALID_DECODED_SIZE: decoded length must be a positive safe integer, received ${String(length)}.`,
    );
  }
  if (
    typeof numberOfChannels !== 'number' ||
    !Number.isFinite(numberOfChannels) ||
    !Number.isSafeInteger(numberOfChannels) ||
    numberOfChannels <= 0
  ) {
    throw new RangeError(
      `INGEST_INVALID_DECODED_SIZE: decoded numberOfChannels must be a positive safe integer, received ${String(numberOfChannels)}.`,
    );
  }
  const channelSamples = length * numberOfChannels;
  if (
    !Number.isSafeInteger(channelSamples) ||
    channelSamples / numberOfChannels !== length
  ) {
    throw new RangeError(
      `INGEST_INVALID_DECODED_SIZE: decoded sample count overflows safe integer arithmetic (length=${length}, channels=${numberOfChannels}).`,
    );
  }
  const bytes = channelSamples * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes / Float32Array.BYTES_PER_ELEMENT !== channelSamples
  ) {
    throw new RangeError(
      `INGEST_INVALID_DECODED_SIZE: decoded byte count overflows safe integer arithmetic (length=${length}, channels=${numberOfChannels}).`,
    );
  }
  return bytes;
}

export interface StreamingIngestBroker {
  isDisposed(): boolean;
  getTelemetry(): StorageBrokerTelemetry;
  beginAssetIngest(manifest: PersistedAudioAssetManifest): Promise<{
    manifest: PersistedAudioAssetManifest;
    persisted: boolean;
    backend: WorkerPersistenceBackend;
  }>;
  writeAssetChunk(
    assetId: string,
    chunkIndex: number,
    data: Float32Array | ArrayBuffer,
    ownerWorker?: FileHandleLease['ownerWorker'],
  ): Promise<WritePcmBlockResult>;
  finalizeAsset(
    assetId: string,
    patch?: Partial<PersistedAudioAssetManifest>,
  ): Promise<PersistedAudioAssetManifest | null>;
  abortAssetIngest(
    assetId: string,
    reason: string,
    targetState?: 'abandoned' | 'failed',
  ): Promise<void>;
  getReadyAssetManifest(assetId: string): Promise<PersistedAudioAssetManifest | null>;
  streamReadRange(
    assetId: string,
    startSample: number,
    length: number,
    blockSizeSamples: number,
    fallbackSource?: Float32Array,
    ownerWorker?: FileHandleLease['ownerWorker'],
  ): Promise<Float32Array>;
}

export interface StreamingIngestOptions {
  readonly broker?: StorageBrokerClient | StreamingIngestBroker | null;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly chunkSeconds?: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (progress: {
    phase: 'validating' | 'decoding' | 'persisting' | 'analyzing' | 'finalizing';
    percent: number;
    chunkIndex?: number;
  }) => void;
  readonly onTransactionChange?: (snapshot: IngestTransactionSnapshot) => void;
  readonly retainFallbackWhenOpfsUnavailable?: boolean;
  /**
   * When true and OPFS persistence is active, retains ONE budgeted contiguous resident PCM
   * mirror populated incrementally during the streaming chunk loop (zero duplicate full-duration
   * allocations) and transfers reservation ownership onto `loaded.runtimeResourceLease`.
   */
  readonly retainResidentPcmMirror?: boolean;
  readonly decodeCompressedAudioFn?: (
    encodedBytes: ArrayBuffer,
  ) => Promise<{
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    duration: number;
    getChannelData(channel: number): Float32Array;
  }>;
}

export interface ParsedWavLayout {
  readonly audioFormat: 1 | 3; // 1 = PCM integer, 3 = IEEE float
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly blockAlign: number;
  readonly dataOffsetBytes: number;
  readonly dataByteLength: number;
  readonly totalSamples: number;
}

export type IngestFailureCode =
  | 'INGEST_ABORTED'
  | 'INGEST_STORAGE_UNAVAILABLE'
  | 'INGEST_BEGIN_FAILED'
  | 'INGEST_CHUNK_PERSISTENCE_FAILED'
  | 'INGEST_CHUNK_BYTE_MISMATCH'
  | 'INGEST_DUPLICATE_BLOCK_ACK'
  | 'INGEST_INVALID_BLOCK_INDEX'
  | 'INGEST_INCOMPLETE_PERSISTENCE'
  | 'INGEST_FINALIZATION_FAILED'
  | 'INGEST_MANIFEST_VALIDATION_FAILED'
  | 'INGEST_FALLBACK_INTEGRITY_FAILED';

export class IngestAbortedError extends Error {
  public readonly code = 'INGEST_ABORTED' as const;
  public transaction?: IngestTransactionSnapshot;
  public rollbackError?: unknown;

  constructor(
    message = 'فرایند ورود فایل صوتی توسط کاربر متوقف شد.',
    details?: { transaction?: IngestTransactionSnapshot; rollbackError?: unknown },
  ) {
    super(message);
    this.name = 'IngestAbortedError';
    this.transaction = details?.transaction;
    this.rollbackError = details?.rollbackError;
  }
}

export class IngestTransactionError extends Error {
  public readonly code: IngestFailureCode;
  public readonly transaction: IngestTransactionSnapshot;
  public readonly primaryCause?: unknown;
  public readonly rollbackError?: unknown;

  constructor(params: {
    readonly code: IngestFailureCode;
    readonly message: string;
    readonly transaction: IngestTransactionSnapshot;
    readonly primaryCause?: unknown;
    readonly rollbackError?: unknown;
  }) {
    super(params.message);
    this.name = 'IngestTransactionError';
    this.code = params.code;
    this.transaction = params.transaction;
    this.primaryCause = params.primaryCause;
    this.rollbackError = params.rollbackError;
  }
}

let ingestTransactionSequence = 0;

/**
 * Deterministic ingestion transaction state machine enforcing exact block & byte accounting,
 * fail-closed persistence checks, and verified atomic commit/rollback transitions.
 */
export class IngestTransactionTracker {
  public readonly transactionId: string;
  public readonly assetId: string;
  public readonly expectedBlockCount: number;
  public readonly expectedBytes: number;
  public readonly totalSamples: number;
  public readonly blockSizeSamples: number;
  public readonly expectedContentSha256?: string;
  public readonly persistedBlockIndexes = new Set<number>();
  public readonly failedBlockIndexes = new Set<number>();

  private state: IngestTransactionState = 'INITIALIZING';
  private successfullyPersistedBlockCount = 0;
  private persistedBytes = 0;
  private commitTimestamp: number | null = null;
  private primaryFailureReason?: string;
  private rollbackErrorMessage?: string;
  private readonly onChange?: (snapshot: IngestTransactionSnapshot) => void;

  constructor(params: {
    readonly assetId: string;
    readonly expectedBlockCount: number;
    readonly expectedBytes: number;
    readonly totalSamples: number;
    readonly blockSizeSamples: number;
    readonly expectedContentSha256?: string;
    readonly onChange?: (snapshot: IngestTransactionSnapshot) => void;
  }) {
    this.transactionId = `ingest-tx-${++ingestTransactionSequence}-${params.assetId}`;
    this.assetId = params.assetId;
    this.expectedBlockCount = params.expectedBlockCount;
    this.expectedBytes = params.expectedBytes;
    this.totalSamples = params.totalSamples;
    this.blockSizeSamples = params.blockSizeSamples;
    this.expectedContentSha256 = params.expectedContentSha256;
    this.onChange = params.onChange;
    this.emit();
  }

  public getState(): IngestTransactionState {
    return this.state;
  }

  public getSuccessfullyPersistedBlockCount(): number {
    return this.successfullyPersistedBlockCount;
  }

  public getPersistedBytes(): number {
    return this.persistedBytes;
  }

  public getCommitTimestamp(): number | null {
    return this.commitTimestamp;
  }

  public snapshot(): IngestTransactionSnapshot {
    return {
      transactionId: this.transactionId,
      assetId: this.assetId,
      state: this.state,
      expectedBlockCount: this.expectedBlockCount,
      successfullyPersistedBlockCount: this.successfullyPersistedBlockCount,
      persistedBlockIndexes: Array.from(this.persistedBlockIndexes).sort((a, b) => a - b),
      failedBlockIndexes: Array.from(this.failedBlockIndexes).sort((a, b) => a - b),
      persistedBytes: this.persistedBytes,
      expectedBytes: this.expectedBytes,
      commitTimestamp: this.commitTimestamp,
      primaryFailureReason: this.primaryFailureReason,
      rollbackError: this.rollbackErrorMessage,
    };
  }

  private emit(): void {
    this.onChange?.(this.snapshot());
  }

  public beginWriting(): void {
    if (this.state !== 'INITIALIZING') {
      throw this.createError(
        'INGEST_BEGIN_FAILED',
        `Cannot enter WRITING from state "${this.state}".`,
      );
    }
    this.state = 'WRITING';
    this.emit();
  }

  public recordBlockFailure(blockIndex: number, reason: string): void {
    if (Number.isSafeInteger(blockIndex) && blockIndex >= 0) {
      this.failedBlockIndexes.add(blockIndex);
    }
    if (!this.primaryFailureReason) {
      this.primaryFailureReason = reason;
    }
  }

  public acknowledgeBlockWrite(params: {
    readonly expectedBlockIndex: number;
    readonly expectedChunkBytes: number;
    readonly result: WritePcmBlockResult;
  }): void {
    const { expectedBlockIndex, expectedChunkBytes, result } = params;

    if (this.state !== 'WRITING') {
      throw this.createError(
        'INGEST_CHUNK_PERSISTENCE_FAILED',
        `Cannot acknowledge block #${expectedBlockIndex} while transaction state is "${this.state}".`,
      );
    }
    if (this.failedBlockIndexes.size > 0) {
      throw this.createError(
        'INGEST_CHUNK_PERSISTENCE_FAILED',
        `Cannot acknowledge block #${expectedBlockIndex} after previous block failure.`,
      );
    }

    const ackedIndex =
      result.blockIndex !== undefined ? result.blockIndex : expectedBlockIndex;

    if (
      !Number.isSafeInteger(ackedIndex) ||
      ackedIndex < 0 ||
      ackedIndex >= this.expectedBlockCount
    ) {
      const reason = `Invalid block index acknowledgement (${String(ackedIndex)}) for expected block #${expectedBlockIndex} (expectedBlockCount=${this.expectedBlockCount}).`;
      this.recordBlockFailure(expectedBlockIndex, reason);
      throw this.createError('INGEST_INVALID_BLOCK_INDEX', reason);
    }

    if (this.persistedBlockIndexes.has(ackedIndex)) {
      const reason = `Duplicate persistence acknowledgement detected for block #${ackedIndex} while writing expected block #${expectedBlockIndex}.`;
      this.recordBlockFailure(expectedBlockIndex, reason);
      throw this.createError('INGEST_DUPLICATE_BLOCK_ACK', reason);
    }

    if (ackedIndex !== expectedBlockIndex) {
      const reason = `Mismatched block index acknowledgement: expected #${expectedBlockIndex}, got #${ackedIndex}.`;
      this.recordBlockFailure(expectedBlockIndex, reason);
      throw this.createError('INGEST_INVALID_BLOCK_INDEX', reason);
    }

    if (!result.persisted || result.backend === 'OPFS-Unavailable') {
      const reason = `Durable OPFS persistence failed for block #${expectedBlockIndex} (persisted=${String(result.persisted)}, backend=${result.backend}).`;
      this.recordBlockFailure(expectedBlockIndex, reason);
      throw this.createError('INGEST_CHUNK_PERSISTENCE_FAILED', reason);
    }

    if (
      typeof result.bytesWritten !== 'number' ||
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten !== expectedChunkBytes
    ) {
      const reason = `Block #${expectedBlockIndex} byte count mismatch: expected ${expectedChunkBytes} bytes, persisted ${String(result.bytesWritten)} bytes.`;
      this.recordBlockFailure(expectedBlockIndex, reason);
      throw this.createError('INGEST_CHUNK_BYTE_MISMATCH', reason);
    }

    this.persistedBlockIndexes.add(ackedIndex);
    this.successfullyPersistedBlockCount = this.persistedBlockIndexes.size;
    this.persistedBytes += result.bytesWritten;
  }

  public enterVerifying(): void {
    if (this.state !== 'WRITING') {
      throw this.createError(
        'INGEST_INCOMPLETE_PERSISTENCE',
        `Cannot enter VERIFYING from state "${this.state}".`,
      );
    }
    if (this.failedBlockIndexes.size > 0) {
      throw this.createError(
        'INGEST_INCOMPLETE_PERSISTENCE',
        `Cannot finalize asset "${this.assetId}": failed blocks present [${Array.from(this.failedBlockIndexes).join(', ')}].`,
      );
    }
    const missingIndexes: number[] = [];
    for (let idx = 0; idx < this.expectedBlockCount; idx++) {
      if (!this.persistedBlockIndexes.has(idx)) {
        missingIndexes.push(idx);
      }
    }
    if (
      missingIndexes.length > 0 ||
      this.persistedBlockIndexes.size !== this.expectedBlockCount ||
      this.successfullyPersistedBlockCount !== this.expectedBlockCount
    ) {
      const reason = `Incomplete block acknowledgement before finalization: persisted ${this.persistedBlockIndexes.size}/${this.expectedBlockCount} blocks; missing [${missingIndexes.join(', ')}].`;
      this.primaryFailureReason = this.primaryFailureReason ?? reason;
      throw this.createError('INGEST_INCOMPLETE_PERSISTENCE', reason);
    }
    if (this.persistedBytes !== this.expectedBytes) {
      const reason = `Persisted byte count mismatch before finalization: persisted ${this.persistedBytes} bytes, expected ${this.expectedBytes} bytes.`;
      this.primaryFailureReason = this.primaryFailureReason ?? reason;
      throw this.createError('INGEST_INCOMPLETE_PERSISTENCE', reason);
    }
    if (this.totalSamples <= 0 || this.expectedBytes !== this.totalSamples * Float32Array.BYTES_PER_ELEMENT) {
      const reason = `Sample accounting mismatch before finalization: totalSamples=${this.totalSamples}, expectedBytes=${this.expectedBytes}.`;
      this.primaryFailureReason = this.primaryFailureReason ?? reason;
      throw this.createError('INGEST_INCOMPLETE_PERSISTENCE', reason);
    }

    this.state = 'VERIFYING';
    this.emit();
  }

  public validateAndCommitManifest(manifest: PersistedAudioAssetManifest | null): void {
    if (this.state !== 'VERIFYING') {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Cannot commit transaction from state "${this.state}"; expected "VERIFYING".`,
      );
    }
    if (!manifest) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `getReadyAssetManifest("${this.assetId}") returned null after finalization.`,
      );
    }
    if (manifest.assetId !== this.assetId) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Manifest identity mismatch: expected assetId "${this.assetId}", got "${manifest.assetId}".`,
      );
    }
    if (manifest.state !== 'ready') {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Finalized manifest for "${this.assetId}" is in state "${manifest.state}", expected "ready".`,
      );
    }
    if (manifest.totalBlocks !== this.expectedBlockCount) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Finalized manifest totalBlocks mismatch: expected ${this.expectedBlockCount}, got ${manifest.totalBlocks}.`,
      );
    }
    if (manifest.totalSamples !== this.totalSamples) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Finalized manifest totalSamples mismatch: expected ${this.totalSamples}, got ${manifest.totalSamples}.`,
      );
    }
    if (
      this.expectedContentSha256 !== undefined &&
      manifest.contentSha256 !== this.expectedContentSha256
    ) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Finalized manifest contentSha256 mismatch: expected "${this.expectedContentSha256}", got "${manifest.contentSha256}".`,
      );
    }
    if (manifest.bytesPerSample !== Float32Array.BYTES_PER_ELEMENT) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Finalized manifest bytesPerSample mismatch: expected ${Float32Array.BYTES_PER_ELEMENT}, got ${manifest.bytesPerSample}.`,
      );
    }
    if (manifest.blockSizeSamples !== this.blockSizeSamples) {
      throw this.createError(
        'INGEST_MANIFEST_VALIDATION_FAILED',
        `Finalized manifest blockSizeSamples mismatch: expected ${this.blockSizeSamples}, got ${manifest.blockSizeSamples}.`,
      );
    }

    this.commitTimestamp = Date.now();
    this.state = 'COMMITTED';
    this.emit();
  }

  public beginAbort(reason: string): void {
    if (!this.primaryFailureReason) {
      this.primaryFailureReason = reason;
    }
    if (this.state !== 'ABORTED' && this.state !== 'FAILED') {
      this.state = 'ABORTING';
      this.emit();
    }
  }

  public finishAbort(target: 'ABORTED' | 'FAILED', rollbackError?: unknown): void {
    if (rollbackError !== undefined) {
      this.rollbackErrorMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    }
    this.state = target;
    this.emit();
  }

  public createError(
    code: IngestFailureCode,
    message: string,
    primaryCause?: unknown,
    rollbackError?: unknown,
  ): IngestTransactionError {
    if (!this.primaryFailureReason) {
      this.primaryFailureReason = message;
    }
    return new IngestTransactionError({
      code,
      message,
      transaction: this.snapshot(),
      primaryCause,
      rollbackError,
    });
  }
}

/**
 * Parses a RIFF/WAVE header incrementally via bounded Blob.slice() calls
 * without loading the whole file into JS memory. Returns null if non-PCM/unsupported WAV.
 */
export async function parseWavHeaderStreaming(file: {
  size: number;
  slice(start?: number, end?: number): Blob;
}): Promise<ParsedWavLayout | null> {
  if (file.size < 44) return null;
  const riffBuf = await file.slice(0, 12).arrayBuffer();
  const riffView = new DataView(riffBuf);
  const riffTag = String.fromCharCode(
    riffView.getUint8(0),
    riffView.getUint8(1),
    riffView.getUint8(2),
    riffView.getUint8(3),
  );
  const waveTag = String.fromCharCode(
    riffView.getUint8(8),
    riffView.getUint8(9),
    riffView.getUint8(10),
    riffView.getUint8(11),
  );
  if (riffTag !== 'RIFF' || waveTag !== 'WAVE') return null;

  let cursor = 12;
  let audioFormat: number | null = null;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;

  let safetyChunks = 0;
  while (cursor + 8 <= file.size && safetyChunks < 128) {
    safetyChunks++;
    const chunkHdrBuf = await file.slice(cursor, cursor + 8).arrayBuffer();
    if (chunkHdrBuf.byteLength < 8) break;
    const hdrView = new DataView(chunkHdrBuf);
    const id = String.fromCharCode(
      hdrView.getUint8(0),
      hdrView.getUint8(1),
      hdrView.getUint8(2),
      hdrView.getUint8(3),
    );
    const chunkSize = hdrView.getUint32(4, true);
    const payloadStart = cursor + 8;

    if (id === 'fmt ') {
      if (chunkSize < 16 || payloadStart + 16 > file.size) return null;
      const fmtBuf = await file.slice(payloadStart, payloadStart + 16).arrayBuffer();
      const fmtView = new DataView(fmtBuf);
      audioFormat = fmtView.getUint16(0, true);
      numChannels = fmtView.getUint16(2, true);
      sampleRate = fmtView.getUint32(4, true);
      blockAlign = fmtView.getUint16(12, true);
      bitsPerSample = fmtView.getUint16(14, true);
    } else if (id === 'data') {
      if (
        (audioFormat !== 1 && audioFormat !== 3) ||
        numChannels <= 0 ||
        numChannels > 32 ||
        sampleRate <= 0 ||
        blockAlign <= 0
      ) {
        return null;
      }
      if (
        audioFormat === 1 &&
        bitsPerSample !== 8 &&
        bitsPerSample !== 16 &&
        bitsPerSample !== 24 &&
        bitsPerSample !== 32
      ) {
        return null;
      }
      if (audioFormat === 3 && bitsPerSample !== 32) {
        return null;
      }
      const minBlockAlign = numChannels * (bitsPerSample / 8);
      if (blockAlign < minBlockAlign) {
        return null;
      }
      const availableBytes = Math.max(0, Math.min(chunkSize, file.size - payloadStart));
      const totalSamples = Math.floor(availableBytes / blockAlign);
      return {
        audioFormat,
        numChannels,
        sampleRate,
        bitsPerSample,
        blockAlign,
        dataOffsetBytes: payloadStart,
        dataByteLength: totalSamples * blockAlign,
        totalSamples,
      };
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    cursor = payloadStart + paddedSize;
  }

  return null;
}

function decodeWavChunkToMonoFloat32(
  bytes: ArrayBuffer,
  layout: ParsedWavLayout,
): Float32Array {
  const view = new DataView(bytes);
  const frameCount = Math.floor(bytes.byteLength / layout.blockAlign);
  const mono = new Float32Array(frameCount);
  const bytesPerSample = layout.bitsPerSample / 8;
  const invChannels = 1 / layout.numChannels;

  for (let i = 0; i < frameCount; i++) {
    const frameOffset = i * layout.blockAlign;
    let sum = 0;
    for (let c = 0; c < layout.numChannels; c++) {
      const off = frameOffset + c * bytesPerSample;
      if (off + bytesPerSample > bytes.byteLength) break;
      let sample = 0;
      if (layout.audioFormat === 3) {
        sample = view.getFloat32(off, true);
      } else if (layout.bitsPerSample === 16) {
        sample = view.getInt16(off, true) / 32768;
      } else if (layout.bitsPerSample === 24) {
        const b0 = view.getUint8(off);
        const b1 = view.getUint8(off + 1);
        const b2 = view.getUint8(off + 2);
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= ~0xffffff;
        sample = val / 8388608;
      } else if (layout.bitsPerSample === 32) {
        sample = view.getInt32(off, true) / 2147483648;
      } else if (layout.bitsPerSample === 8) {
        sample = (view.getUint8(off) - 128) / 128;
      }
      sum += Number.isFinite(sample) ? sample : 0;
    }
    mono[i] = Math.max(-1, Math.min(1, sum * invChannels));
  }

  return mono;
}

class StreamingAcousticProfileAccumulator {
  private readonly quietFrames: { rms: number; samples: Float32Array }[] = [];
  private readonly maxCollectedQuiet = 32;
  private readonly frameLen: number;
  private totalFramesCount = 0;
  private silentFramesCount = 0;

  constructor(
    private readonly assetId: string,
    private readonly sampleRate: number,
  ) {
    this.frameLen = Math.max(1, Math.round(sampleRate * 0.02));
  }

  public pushMonoChunk(chunk: Float32Array): void {
    for (let i = 0; i + this.frameLen <= chunk.length; i += this.frameLen) {
      let sumSq = 0;
      for (let j = 0; j < this.frameLen; j++) {
        const s = chunk[i + j];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / this.frameLen);
      this.totalFramesCount++;
      if (rms <= 1e-6) {
        this.silentFramesCount++;
        continue;
      }

      if (this.quietFrames.length < this.maxCollectedQuiet) {
        this.quietFrames.push({ rms, samples: chunk.slice(i, i + this.frameLen) });
        if (this.quietFrames.length === this.maxCollectedQuiet) {
          this.quietFrames.sort((a, b) => a.rms - b.rms);
        }
      } else if (rms < this.quietFrames[this.quietFrames.length - 1].rms) {
        this.quietFrames[this.quietFrames.length - 1] = {
          rms,
          samples: chunk.slice(i, i + this.frameLen),
        };
        this.quietFrames.sort((a, b) => a.rms - b.rms);
      }
    }
  }

  public finalize(): AcousticProfile {
    this.quietFrames.sort((a, b) => a.rms - b.rms);
    const silentRatio =
      this.totalFramesCount > 0 ? this.silentFramesCount / this.totalFramesCount : 0;

    if (this.quietFrames.length === 0 || silentRatio >= 0.1) {
      const desiredLen = Math.round(this.sampleRate * 0.5);
      return {
        assetId: this.assetId,
        noiseFloorDbfs: -66.02,
        roomToneRms: 0.0005,
        roomToneSample: new Float32Array(desiredLen),
        sampleRate: this.sampleRate,
      };
    }

    const p10Idx = Math.floor(this.quietFrames.length * 0.1);
    const roomToneRms = Math.max(this.quietFrames[p10Idx].rms, 0.0005);
    const noiseFloorDbfs = 20 * Math.log10(Math.max(roomToneRms, 1e-6));

    const desiredLen = Math.round(this.sampleRate * 0.5);
    const roomToneSample = new Float32Array(desiredLen);
    const quietPool = this.quietFrames.filter(
      (f) => f.rms <= Math.max(roomToneRms * 3, 0.015),
    );
    if (quietPool.length > 0) {
      let writeOffset = 0;
      let cursor = 0;
      while (writeOffset < desiredLen) {
        const frame = quietPool[cursor % quietPool.length].samples;
        const copyLen = Math.min(frame.length, desiredLen - writeOffset);
        roomToneSample.set(frame.subarray(0, copyLen), writeOffset);
        writeOffset += copyLen;
        cursor++;
      }
    }

    return {
      assetId: this.assetId,
      noiseFloorDbfs,
      roomToneRms,
      roomToneSample,
      sampleRate: this.sampleRate,
    };
  }
}

export async function ingestAudioFileStreaming(
  file: File,
  options: StreamingIngestOptions = {},
): Promise<LoadedStudioProject> {
  const {
    broker = null,
    memoryBudgetManager = getSharedMemoryBudgetManager(),
    chunkSeconds = 4,
    abortSignal,
    onProgress,
    onTransactionChange,
    retainFallbackWhenOpfsUnavailable = true,
    retainResidentPcmMirror = false,
    decodeCompressedAudioFn,
  } = options;

  const checkAbort = () => {
    if (abortSignal?.aborted) {
      throw new IngestAbortedError();
    }
  };

  onProgress?.({ phase: 'validating', percent: 2 });
  checkAbort();

  const headerSlice = await file.slice(0, Math.min(64, file.size)).arrayBuffer();
  const headerBytes = new Uint8Array(headerSlice);
  const verifiedContainer: SupportedAudioContainer = AudioSecurityGuard.verifyMagicBytes(
    headerBytes,
    file.size,
  );

  const contentHash = `sha256:${await sha256Blob(file, {
    chunkSizeBytes: HASH_CHUNK_BYTES,
    shouldAbort: checkAbort,
  })}`;
  checkAbort();

  const wavLayout = verifiedContainer === 'WAV' ? await parseWavHeaderStreaming(file) : null;

  let sampleRate = 0;
  let channelCount: 1 | 2 = 1;
  let totalSamples = 0;
  let decodedAudioBuffer: {
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    duration: number;
    getChannelData(channel: number): Float32Array;
  } | null = null;
  let encodedInputReservation: MemoryReservation | null = null;
  let encodedInputReleased = false;
  let decodedAudioReservation: MemoryReservation | null = null;
  let decodedAudioReleased = false;
  let pcmReservation: MemoryReservation | null = null;
  let fallbackPcm: Float32Array | null = null;
  let ownershipTransferred = false;

  const releaseEncodedInputReservation = () => {
    if (!encodedInputReleased) {
      encodedInputReleased = true;
      if (encodedInputReservation) {
        memoryBudgetManager.release(encodedInputReservation);
        encodedInputReservation = null;
      }
    }
  };

  const releaseDecodedAudioReservation = () => {
    if (!decodedAudioReleased) {
      decodedAudioReleased = true;
      decodedAudioBuffer = null;
      if (decodedAudioReservation) {
        memoryBudgetManager.release(decodedAudioReservation);
        decodedAudioReservation = null;
      }
    }
  };

  try {
    if (wavLayout) {
      sampleRate = wavLayout.sampleRate;
      channelCount = wavLayout.numChannels > 1 ? 2 : 1;
      totalSamples = wavLayout.totalSamples;
      AudioSecurityGuard.assertSafeDecodedDuration(
        totalSamples / sampleRate,
        file.size,
        sampleRate,
        wavLayout.numChannels,
      );
    } else {
      onProgress?.({ phase: 'decoding', percent: 8 });
      // A. Reserve exact application-accounted encoded input buffer bytes while resident
      const encodedInputBytes = file.size;
      if (!Number.isSafeInteger(encodedInputBytes) || encodedInputBytes <= 0) {
        throw new RangeError(
          `INGEST_INVALID_ENCODED_SIZE: Encoded audio file size must be a positive safe integer, received ${String(encodedInputBytes)}.`,
        );
      }

      encodedInputReservation = memoryBudgetManager.reserve({
        owner: `streaming-ingest:encoded-input:${file.name}`,
        category: 'decoded-audio',
        bytes: encodedInputBytes,
        priority: 'protected',
        protectedUserData: true,
      });

      let encodedBuffer: ArrayBuffer | null = null;
      try {
        encodedBuffer = await file.arrayBuffer();
        checkAbort();

        if (decodeCompressedAudioFn) {
          decodedAudioBuffer = await decodeCompressedAudioFn(encodedBuffer);
        } else {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const ctx = new AudioCtx();
          try {
            decodedAudioBuffer = await ctx.decodeAudioData(encodedBuffer);
          } finally {
            await ctx.close().catch(() => {});
          }
        }
      } finally {
        // Release encoded input buffer reference and reservation immediately once decode finishes/fails
        encodedBuffer = null;
        releaseEncodedInputReservation();
      }

      checkAbort();

      AudioSecurityGuard.assertSafeDecodedDuration(
        decodedAudioBuffer.duration,
        file.size,
        decodedAudioBuffer.sampleRate,
        decodedAudioBuffer.numberOfChannels,
      );

      // B. Account separately for the estimated multi-channel decoded AudioBuffer payload
      // (application-accounted estimate; distinct from browser-internal process memory)
      const decodedSampleBytes = computeSafeDecodedSampleBytes(
        decodedAudioBuffer.length,
        decodedAudioBuffer.numberOfChannels,
      );
      decodedAudioReservation = memoryBudgetManager.reserve({
        owner: `streaming-ingest:decoded-buffer:${file.name}`,
        category: 'decoded-audio',
        bytes: decodedSampleBytes,
        priority: 'protected',
        protectedUserData: true,
      });

      sampleRate = decodedAudioBuffer.sampleRate;
      channelCount = decodedAudioBuffer.numberOfChannels > 1 ? 2 : 1;
      totalSamples = decodedAudioBuffer.length;
    }

    checkAbort();
    if (totalSamples <= 0 || sampleRate <= 0) {
      throw new Error('AUDIO_EMPTY: فایل صوتی فاقد نمونه قابل‌پردازش است.');
    }

    const assetId = computeDeterministicAssetId({
      contentSha256: contentHash,
      fileName: file.name,
      fileSizeBytes: file.size,
      sampleRate,
      exactSampleCount: totalSamples,
    });

    const safeChunkSeconds = Math.max(1, Math.min(10, chunkSeconds));
    const blockSizeSamples = Math.round(sampleRate * safeChunkSeconds);
    const totalBlocks = Math.ceil(totalSamples / blockSizeSamples);
    const residentPcmBytes = computeSafeResidentPcmBytes(totalSamples);
    const expectedBytes = residentPcmBytes;

    const brokerTelemetry = broker?.getTelemetry();
    const shouldPersistChunks = Boolean(
      broker &&
        !broker.isDisposed() &&
        brokerTelemetry?.opfsSupported &&
        brokerTelemetry.persistenceStatus !== 'Disposed',
    );
    const shouldRetainResidentPcm = !shouldPersistChunks || Boolean(retainResidentPcmMirror);

    const tx = new IngestTransactionTracker({
      assetId,
      expectedBlockCount: totalBlocks,
      expectedBytes,
      totalSamples,
      blockSizeSamples,
      expectedContentSha256: contentHash,
      onChange: onTransactionChange,
    });

    if (!shouldPersistChunks && !retainFallbackWhenOpfsUnavailable) {
      const reason =
        'OPFS durable storage is unavailable and memory-only fallback is disabled (retainFallbackWhenOpfsUnavailable=false).';
      tx.beginAbort(reason);
      tx.finishAbort('FAILED');
      throw tx.createError('INGEST_STORAGE_UNAVAILABLE', reason);
    }

    const initialManifest: PersistedAudioAssetManifest = {
      assetId,
      fileName: file.name,
      mimeType: file.type || 'audio/wav',
      fileSizeBytes: file.size,
      contentSha256: contentHash,
      sampleRate,
      channels: 1, // Persisted chunks are mono-folded canonical studio tracks
      totalSamples,
      blockSizeSamples,
      totalBlocks,
      bytesPerSample: Float32Array.BYTES_PER_ELEMENT,
      state: 'ingesting',
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      finalizedAtMs: null,
    };

    let storageBackend = 'Memory-Unavailable';
    let beginAttempted = false;
    let opfsCommitted = false;

    const peakBuilder = new StreamingPeakPyramidBuilder(assetId, sampleRate);
    const resampler = new StreamingKaiserSincResampler(sampleRate, 16_000);
    const acousticAcc = new StreamingAcousticProfileAccumulator(assetId, sampleRate);
    const collectedPauseCandidates: Array<{ startSample: number; endSample: number; durationMs: number }> = [];
    let downsampled16kCount = 0;

    // Single resident PCM buffer (either memory-only fallback or active OPFS PCM mirror;
    // zero parallel chunk arrays and zero second full-duration assembly copy).
    let fallbackSamplesWritten = 0;
    let fallbackBlocksWritten = 0;

    try {
      if (shouldRetainResidentPcm) {
        // Admit and reserve full resident PCM requirement BEFORE allocating the single buffer
        // and BEFORE mutating OPFS state so memory-pressure rejections never dirty storage.
        pcmReservation = memoryBudgetManager.reserve({
          owner: shouldPersistChunks
            ? `streaming-ingest:${assetId}:resident-pcm-mirror`
            : `streaming-ingest:${assetId}:resident-pcm`,
          category: 'decoded-audio',
          bytes: residentPcmBytes,
          priority: 'protected',
          protectedUserData: true,
        });
        fallbackPcm = new Float32Array(totalSamples);
      }

      if (shouldPersistChunks && broker) {
        if (broker.isDisposed()) {
          throw tx.createError(
            'INGEST_STORAGE_UNAVAILABLE',
            `Storage broker was disposed before beginAssetIngest("${assetId}").`,
          );
        }
        beginAttempted = true;
        const beginRes = await broker.beginAssetIngest(initialManifest);
        if (!beginRes.persisted || beginRes.backend === 'OPFS-Unavailable') {
          throw tx.createError(
            'INGEST_BEGIN_FAILED',
            `Failed to initialize durable OPFS ingest transaction for asset "${assetId}" (backend: ${beginRes.backend}).`,
          );
        }
        storageBackend = beginRes.backend;
        tx.beginWriting();
      } else {
        tx.beginWriting();
      }

      for (let chunkIdx = 0; chunkIdx < totalBlocks; chunkIdx++) {
        checkAbort();

        const startSample = chunkIdx * blockSizeSamples;
        const count = Math.min(blockSizeSamples, totalSamples - startSample);
        const chunkBytes = count * Float32Array.BYTES_PER_ELEMENT;

        const chunkReservation = memoryBudgetManager.reserve({
          owner: `streaming-ingest:${assetId}:chunk-${chunkIdx}`,
          category: 'render-export-buffers',
          bytes: chunkBytes,
          priority: 'normal',
        });

        try {
          let monoChunk: Float32Array;
          if (wavLayout) {
            const byteStart = wavLayout.dataOffsetBytes + startSample * wavLayout.blockAlign;
            const byteEnd = byteStart + count * wavLayout.blockAlign;
            const rawSlice = await file.slice(byteStart, byteEnd).arrayBuffer();
            checkAbort();
            monoChunk = decodeWavChunkToMonoFloat32(rawSlice, wavLayout);
          } else if (decodedAudioBuffer) {
            monoChunk = new Float32Array(count);
            const numCh = Math.max(1, decodedAudioBuffer.numberOfChannels);
            const invCh = 1 / numCh;
            for (let c = 0; c < numCh; c++) {
              const channelView = decodedAudioBuffer
                .getChannelData(c)
                .subarray(startSample, startSample + count);
              for (let i = 0; i < channelView.length; i++) {
                const s = channelView[i];
                if (Number.isFinite(s)) {
                  monoChunk[i] += s * invCh;
                }
              }
            }
            for (let i = 0; i < count; i++) {
              monoChunk[i] = Math.max(-1, Math.min(1, monoChunk[i]));
            }
          } else {
            monoChunk = new Float32Array(count);
          }

          if (monoChunk.length !== count) {
            const reason = `Decoded chunk #${chunkIdx} sample count mismatch: expected ${count}, got ${monoChunk.length}.`;
            tx.recordBlockFailure(chunkIdx, reason);
            throw tx.createError('INGEST_CHUNK_BYTE_MISMATCH', reason);
          }

          peakBuilder.pushMonoChunk(monoChunk);
          acousticAcc.pushMonoChunk(monoChunk);

          const chunk16k = resampler.pushChunk(monoChunk);
          downsampled16kCount += chunk16k.length;

          // Group A DSP pause detection on current chunk with local acoustic baseline
          if (collectedPauseCandidates.length < 8) {
            const localProfile = acousticAcc.finalize();
            const chunkPauses = detectLongPauses(monoChunk, sampleRate, localProfile, 650);
            for (const p of chunkPauses) {
              collectedPauseCandidates.push({
                startSample: startSample + p.startSample,
                endSample: startSample + p.endSample,
                durationMs: p.durationMs,
              });
              if (collectedPauseCandidates.length >= 8) break;
            }
          }

          if (shouldPersistChunks && broker) {
            if (broker.isDisposed()) {
              const reason = `Storage broker was disposed during OPFS chunk write #${chunkIdx} for asset "${assetId}".`;
              tx.recordBlockFailure(chunkIdx, reason);
              throw tx.createError('INGEST_CHUNK_PERSISTENCE_FAILED', reason);
            }
            let writeRes: WritePcmBlockResult;
            try {
              writeRes = await broker.writeAssetChunk(
                assetId,
                chunkIdx,
                monoChunk,
                'io-broker',
              );
            } catch (writeErr) {
              tx.recordBlockFailure(
                chunkIdx,
                writeErr instanceof Error ? writeErr.message : String(writeErr),
              );
              throw writeErr;
            }
            checkAbort();
            tx.acknowledgeBlockWrite({
              expectedBlockIndex: chunkIdx,
              expectedChunkBytes: chunkBytes,
              result: writeRes,
            });
            storageBackend = writeRes.backend;
          }

          if (shouldRetainResidentPcm && fallbackPcm) {
            fallbackPcm.set(monoChunk, startSample);
            fallbackSamplesWritten += monoChunk.length;
            fallbackBlocksWritten++;
          }
        } finally {
          memoryBudgetManager.release(chunkReservation);
        }

        const pct = Math.min(92, 12 + Math.round(((chunkIdx + 1) / totalBlocks) * 80));
        onProgress?.({ phase: 'persisting', percent: pct, chunkIndex: chunkIdx });
      }

      // Decoded compressed AudioBuffer is no longer needed once all chunks are processed
      releaseDecodedAudioReservation();

      const tail16k = resampler.flush();
      downsampled16kCount += tail16k.length;

      onProgress?.({ phase: 'finalizing', percent: 96 });
      checkAbort();

      if (shouldPersistChunks && broker) {
        if (broker.isDisposed()) {
          throw tx.createError(
            'INGEST_FINALIZATION_FAILED',
            `Storage broker was disposed before finalization of asset "${assetId}".`,
          );
        }
        // Strict pre-finalization verification gate
        tx.enterVerifying();
        if (tx.getState() !== 'VERIFYING') {
          throw tx.createError(
            'INGEST_FINALIZATION_FAILED',
            `Expected transaction state VERIFYING before finalizeAsset(), got "${tx.getState()}".`,
          );
        }

        const finalizedManifest = await broker.finalizeAsset(assetId, {
          totalSamples,
          totalBlocks,
        });
        if (!finalizedManifest) {
          throw tx.createError(
            'INGEST_FINALIZATION_FAILED',
            `finalizeAsset("${assetId}") returned null.`,
          );
        }

        if (broker.isDisposed()) {
          throw tx.createError(
            'INGEST_FINALIZATION_FAILED',
            `Storage broker was disposed before manifest verification of asset "${assetId}".`,
          );
        }

        const readyManifest = await broker.getReadyAssetManifest(assetId);
        tx.validateAndCommitManifest(readyManifest);
        const postCommitBackend = broker.getTelemetry().persistenceStatus;
        if (
          postCommitBackend === 'OPFS-SyncAccessHandle' ||
          postCommitBackend === 'OPFS-Writable'
        ) {
          storageBackend = postCommitBackend;
        }
        opfsCommitted = tx.getState() === 'COMMITTED';
      }
    } catch (primaryErr) {
      const isAbort = primaryErr instanceof IngestAbortedError || Boolean(abortSignal?.aborted);
      const primaryMessage =
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr);

      tx.beginAbort(primaryMessage);

      let rollbackErr: unknown = undefined;
      if (shouldPersistChunks && broker && beginAttempted && !broker.isDisposed()) {
        try {
          await broker.abortAssetIngest(
            assetId,
            primaryMessage,
            isAbort ? 'abandoned' : 'failed',
          );
        } catch (rbErr) {
          rollbackErr = rbErr;
        }
      }

      tx.finishAbort(isAbort ? 'ABORTED' : 'FAILED', rollbackErr);
      const finalSnapshot = tx.snapshot();

      if (isAbort) {
        if (primaryErr instanceof IngestAbortedError) {
          primaryErr.transaction = finalSnapshot;
          if (rollbackErr !== undefined) {
            primaryErr.rollbackError = rollbackErr;
          }
          throw primaryErr;
        }
        throw new IngestAbortedError(primaryMessage, {
          transaction: finalSnapshot,
          rollbackError: rollbackErr,
        });
      }

      if (primaryErr instanceof IngestTransactionError) {
        throw new IngestTransactionError({
          code: primaryErr.code,
          message: primaryErr.message,
          transaction: finalSnapshot,
          primaryCause: primaryErr.primaryCause,
          rollbackError: rollbackErr,
        });
      }

      // Preserve the original exception verbatim (including MemoryPressureError)
      // while attaching transaction & rollback metadata separately
      if (primaryErr instanceof Error && Object.isExtensible(primaryErr)) {
        const annotated = primaryErr as Error & {
          transaction?: IngestTransactionSnapshot;
          rollbackError?: unknown;
        };
        annotated.transaction = finalSnapshot;
        if (rollbackErr !== undefined) {
          annotated.rollbackError = rollbackErr;
        }
      }
      throw primaryErr;
    }

    // Resident PCM integrity verification: applies whenever a resident buffer was retained
    // (either memory-only fallback when OPFS is unavailable, or budgeted active PCM mirror for OPFS).
    let pcmSources: Record<string, Float32Array> = {};
    if (shouldRetainResidentPcm) {
      if (
        !fallbackPcm ||
        fallbackBlocksWritten !== totalBlocks ||
        fallbackSamplesWritten !== totalSamples ||
        fallbackPcm.length !== totalSamples
      ) {
        const reason = `Resident PCM integrity failure: wrote ${fallbackBlocksWritten}/${totalBlocks} blocks and ${fallbackSamplesWritten}/${totalSamples} samples (buffer=${fallbackPcm?.length ?? 0}).`;
        tx.beginAbort(reason);
        tx.finishAbort('FAILED');
        throw tx.createError('INGEST_FALLBACK_INTEGRITY_FAILED', reason);
      }
      pcmSources = { [assetId]: fallbackPcm };
    }

    const acousticProfile = acousticAcc.finalize();
    const peakPyramid = peakBuilder.finalize();
    const durationFlicks = secondsToFlicks(totalSamples / sampleRate);

    const containerMap: Record<SupportedAudioContainer, AudioAsset['container']> = {
      WAV: 'wav',
      MP3: 'mp3',
      OGG: 'ogg',
      FLAC: 'wav',
      M4A_AAC: 'webm',
      WEBM: 'webm',
    };

    const asset: AudioAsset = {
      id: assetId,
      name: file.name,
      contentHash,
      partialFingerprint: `fp:${file.name}-${sampleRate}-${totalSamples}`,
      contentVersion: 1,
      fileSizeBytes: file.size,
      container: containerMap[verifiedContainer],
      codec: wavLayout ? `wav-${wavLayout.bitsPerSample}bit` : 'decoded-pcm',
      nativeSampleRate: sampleRate,
      channelLayout: channelCount > 1 ? 'stereo' : 'mono',
      exactSampleCount: totalSamples,
      durationFlicks,
      importTimestamp: Date.now(),
      validationStatus: 'verified',
      seekTable: buildSeekTable(totalSamples, blockSizeSamples, 4, 1),
      peakPyramid,
      acousticProfile,
      storageLifecycle: opfsCommitted ? 'ready' : undefined,
      storageBackend: opfsCommitted ? storageBackend : 'Memory-Bounded-Fallback',
      blockSizeSamples,
      ingestTransaction: opfsCommitted ? tx.snapshot() : undefined,
    };

    const tracks: Track[] = [
      {
        id: 'track-main',
        name: `ترک اصلی — ${file.name}`,
        speakerLabel: 'گوینده فایل ورودی',
        syncGroupId: null,
        muted: false,
        solo: false,
        gainDb: 0,
        pan: 0,
        clips: [
          {
            id: 'clip-upload-1',
            assetId,
            trackId: 'track-main',
            kind: 'speech',
            timelineRange: { startFlicks: 0, endFlicks: durationFlicks },
            sourceStartFlicks: 0,
            fadeInMs: 10,
            fadeOutMs: 10,
            gainDb: 0,
            muted: false,
          },
        ],
      },
    ];

    // Build Group A pause recommendations using bounded chunk reads
    const recommendations: SmartRecommendation[] = [];
    for (let i = 0; i < collectedPauseCandidates.length; i++) {
      const p = collectedPauseCandidates[i];
      const startSec = p.startSample / sampleRate + 0.08;
      const endSec = p.endSample / sampleRate - 0.08;
      if (endSec - startSec < 0.35) continue;
      const range = {
        startFlicks: secondsToFlicks(startSec),
        endFlicks: secondsToFlicks(endSec),
      };
      if (
        recommendations.some(
          (r) =>
            r.kind === 'long-pause' &&
            Math.abs(r.range.startFlicks - range.startFlicks) < secondsToFlicks(0.25),
        )
      ) {
        continue;
      }

      const contextStart = Math.max(0, Math.floor(startSec * sampleRate) - sampleRate);
      const contextLen = Math.min(totalSamples - contextStart, Math.ceil((endSec - startSec + 2) * sampleRate));
      const boundaryBuf = broker && opfsCommitted
        ? await broker.streamReadRange(
            assetId,
            contextStart,
            contextLen,
            blockSizeSamples,
            pcmSources[assetId],
            'io-broker',
          )
        : (pcmSources[assetId]?.subarray(contextStart, contextStart + contextLen) ?? new Float32Array(0));

      const localRange = {
        startFlicks: secondsToFlicks(Math.max(0, startSec - contextStart / sampleRate)),
        endFlicks: secondsToFlicks(Math.max(0, endSec - contextStart / sampleRate)),
      };
      const localBoundary = refinePersianCutBoundary(boundaryBuf, sampleRate, localRange, {
        microCrossfadeMs: 10,
      });
      const offsetFlicks = secondsToFlicks(contextStart / sampleRate);

      recommendations.push({
        id: `rec-pause-${i}`,
        trackId: 'track-main',
        kind: 'long-pause',
        recommendedMode: 'sync-locked-ripple-cut',
        range,
        relatedText: `مکث ${(p.durationMs / 1000).toFixed(2)} ثانیه‌ای`,
        reasonFa: `شناسایی خودکار سکوت (گروه A) در بازه ${flicksToSeconds(range.startFlicks).toFixed(2)} تا ${flicksToSeconds(range.endFlicks).toFixed(2)} ثانیه.`,
        confidence: 0.94,
        sourceTier: 'Group-A-DSP',
        status: 'Pending',
        boundary: {
          ...localBoundary,
          rawRange: range,
          snappedRange: {
            startFlicks: localBoundary.snappedRange.startFlicks + offsetFlicks,
            endFlicks: localBoundary.snappedRange.endFlicks + offsetFlicks,
          },
        },
      });
    }

    onProgress?.({ phase: 'analyzing', percent: 100 });
    const stats = resampler.getStats();

    // Transfer resident PCM reservation ownership ONLY after the complete project is constructed.
    const runtimeResourceLease = pcmReservation
      ? createProjectRuntimeResourceLease(memoryBudgetManager, pcmReservation)
      : undefined;

    const loadedProject: LoadedStudioProject = {
      projectName: file.name,
      sampleRate,
      assets: { [assetId]: asset },
      pcmSources,
      tracks,
      tokens: [], // Honest empty transcript until CanonicalLocalAsrService transcribes with a verified local model
      recommendations,
      resamplerStats: {
        inputSampleRate: sampleRate,
        outputSampleRate: stats.outputSampleRate,
        cutoffHz: stats.cutoffHz,
        filterTaps: stats.filterTaps,
        aliasingAttenuationDb: stats.aliasingAttenuationDb,
        downsampledLength: downsampled16kCount,
      },
      runtimeResourceLease,
    };

    ownershipTransferred = true;
    return loadedProject;
  } finally {
    releaseEncodedInputReservation();
    releaseDecodedAudioReservation();
    if (!ownershipTransferred && pcmReservation) {
      memoryBudgetManager.release(pcmReservation);
      pcmReservation = null;
      fallbackPcm = null;
    }
  }
}
