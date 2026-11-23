import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';
import {
  BoundedChunkedByteSink,
  DEFAULT_MAX_ARTIFACT_READ_BYTES,
  ExportWriteFailureError,
  validateArtifactRangeRead,
  validateArtifactStreamOptions,
} from './AudioExportWriter';
import type {
  CreateCommittedRenderArtifactParams,
  RenderArtifactLifecycleState,
  RenderArtifactReadStreamOptions,
  RenderOutputArtifact,
  StreamingByteSink,
} from './RenderOutputArtifactContracts';
export type {
  CreateCommittedRenderArtifactParams,
  RenderArtifactLifecycleState,
  RenderOutputArtifact,
} from './RenderOutputArtifactContracts';

/** Maximum output size eligible for populating the deprecated outputBytes compatibility field (8 MiB) */
export const COMPATIBILITY_OUTPUT_BYTES_MAX_SIZE = 8 * 1024 * 1024;






/**
 * Deterministic lifecycle owner for a committed rendered audio output artifact.
 *
 * Lifecycle:
 *   FINALIZED -> VALIDATING -> VALIDATED_READY -> ACTIVE_IN_WORKFLOW -> DISPOSED
 *                    \-> (validation failure) -> DISPOSED
 *
 * Guarantees:
 * - Retains sink memory reservations while active and readable.
 * - Releases all owned reservations (sink chunks + optional compatibility copy) exactly once on dispose().
 * - Invalidates all subsequent reads after dispose().
 * - Never lets one cleanup failure prevent release of remaining owned resources.
 * - Never deletes committed externally persisted user files on dispose().
 */
export class CommittedRenderOutputArtifact implements RenderOutputArtifact {
  public readonly artifactId: string;
  public readonly sizeBytes: number;
  public readonly contentType: 'audio/wav';
  public readonly persistedExternally: boolean;

  private readonly sink: StreamingByteSink;
  private readonly budget: MemoryBudgetManager;
  private readonly maxReadWindowBytes: number;
  private readonly ownedReservations: MemoryReservation[] = [];
  private readonly cleanupCallbacks: Array<() => Promise<void> | void> = [];

  private _lifecycleState: RenderArtifactLifecycleState = 'FINALIZED';
  private _disposed = false;
  private _disposePromise: Promise<void> | null = null;

  constructor(params: CreateCommittedRenderArtifactParams) {
    if (!params.artifactId || params.artifactId.trim().length === 0) {
      throw new Error('RenderOutputArtifact requires a non-empty artifactId.');
    }
    if (!Number.isSafeInteger(params.sizeBytes) || params.sizeBytes < 0) {
      throw new RangeError(`Invalid artifact sizeBytes: ${String(params.sizeBytes)}.`);
    }
    const maxRead = params.maxReadWindowBytes ?? DEFAULT_MAX_ARTIFACT_READ_BYTES;
    if (!Number.isSafeInteger(maxRead) || maxRead <= 0) {
      throw new RangeError(`Invalid maxReadWindowBytes: ${String(maxRead)}.`);
    }

    this.artifactId = params.artifactId;
    this.sizeBytes = params.sizeBytes;
    this.contentType = params.contentType ?? 'audio/wav';
    this.persistedExternally = params.sink.persistedExternally;
    this.sink = params.sink;
    this.budget = params.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.maxReadWindowBytes = maxRead;
  }

  public get disposed(): boolean {
    return this._disposed;
  }

  public get lifecycleState(): RenderArtifactLifecycleState {
    return this._lifecycleState;
  }

  public markValidating(): void {
    if (this._disposed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot validate a disposed render artifact.');
    }
    this._lifecycleState = 'VALIDATING';
  }

  public markValidatedReady(): void {
    if (this._disposed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot mark a disposed render artifact ready.');
    }
    this._lifecycleState = 'VALIDATED_READY';
  }

  public markActiveInWorkflow(): void {
    if (this._disposed) {
      throw new ExportWriteFailureError('WRITE_IO_FAILURE', 'Cannot activate a disposed render artifact.');
    }
    this._lifecycleState = 'ACTIVE_IN_WORKFLOW';
  }

  /**
   * Attaches a MemoryReservation (such as a <=8 MiB compatibility outputBytes buffer)
   * to this artifact's lifecycle lease so disposal releases it atomically.
   */
  public attachOwnedReservation(reservation: MemoryReservation): void {
    if (this._disposed) {
      this.budget.release(reservation);
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        'Cannot attach memory reservation to a disposed render artifact.',
      );
    }
    this.ownedReservations.push(reservation);
  }

  /** Registers an auxiliary cleanup callback executed during dispose(). */
  public attachCleanupCallback(callback: () => Promise<void> | void): void {
    if (this._disposed) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        'Cannot attach cleanup callback to a disposed render artifact.',
      );
    }
    this.cleanupCallbacks.push(callback);
  }

  /** Number of active MemoryBudgetManager reservations owned by this artifact (including sink chunks). */
  public getOwnedReservationCount(): number {
    if (this._disposed) return 0;
    const sinkResCount =
      this.sink instanceof BoundedChunkedByteSink ? this.sink.getActiveReservationCount() : 0;
    return this.ownedReservations.length + sinkResCount;
  }

  /** Total accounted bytes owned by this artifact across sink chunks and attached leases. */
  public getOwnedReservedBytes(): number {
    if (this._disposed) return 0;
    let total =
      this.sink instanceof BoundedChunkedByteSink ? this.sink.getActiveReservedBytes() : 0;
    for (const r of this.ownedReservations) {
      total += r.bytes;
    }
    return total;
  }

  /** Number of retained in-memory chunks (0 for externally persisted or disposed artifacts). */
  public getRetainedChunkCount(): number {
    if (this._disposed) return 0;
    return this.sink instanceof BoundedChunkedByteSink ? this.sink.getRetainedChunkCount() : 0;
  }

  public async readRange(offset: number, length: number): Promise<Uint8Array> {
    this.assertNotDisposed();
    validateArtifactRangeRead(this.sizeBytes, offset, length, this.maxReadWindowBytes);
    if (length === 0) {
      return new Uint8Array(0);
    }
    const bytes = await this.sink.readRange(offset, length);
    this.assertNotDisposed();
    return bytes;
  }

  public openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array> {
    this.assertNotDisposed();
    const { start, end, chunkSizeBytes } = validateArtifactStreamOptions(
      this.sizeBytes,
      options,
      this.maxReadWindowBytes,
    );

    let cursor = start;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (this._disposed) {
          controller.error(
            new ExportWriteFailureError(
              'WRITE_IO_FAILURE',
              `Render artifact "${this.artifactId}" was disposed during streaming.`,
            ),
          );
          return;
        }
        if (cursor >= end) {
          controller.close();
          return;
        }
        try {
          const toRead = Math.min(chunkSizeBytes, end - cursor);
          const slice = await this.readRange(cursor, toRead);
          cursor += slice.byteLength;
          controller.enqueue(slice);
          if (cursor >= end) {
            controller.close();
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  public async createBlob(): Promise<Blob> {
    this.assertNotDisposed();
    if (typeof this.sink.createBlob === 'function') {
      const blob = await this.sink.createBlob(this.contentType);
      this.assertNotDisposed();
      return blob;
    }

    // Stream bounded chunks (<= 1 MiB each) into Blob parts without building one contiguous JS array.
    const parts: BlobPart[] = [];
    const reader = this.openReadStream({ chunkSizeBytes: this.maxReadWindowBytes }).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          parts.push(value as unknown as BlobPart);
        }
      }
    } finally {
      reader.releaseLock();
    }

    this.assertNotDisposed();
    return new Blob(parts, { type: this.contentType });
  }

  public dispose(): Promise<void> {
    if (this._disposePromise) {
      return this._disposePromise;
    }

    // Synchronously invalidate state and release synchronous in-memory reservations first
    // so synchronous callers (e.g., openProject / controller.dispose) observe immediate release.
    this._disposed = true;
    this._lifecycleState = 'DISPOSED';

    const errors: unknown[] = [];

    // 1. Release all artifact-attached MemoryBudgetManager reservations (e.g., compat outputBytes)
    const attachedReservations = this.ownedReservations.splice(0, this.ownedReservations.length);
    for (const reservation of attachedReservations) {
      try {
        this.budget.release(reservation);
      } catch (err) {
        errors.push(err);
      }
    }

    // 2. For in-memory BoundedChunkedByteSink, dispose synchronously right away
    let asyncSinkDispose: Promise<void> | null = null;
    if (this.sink instanceof BoundedChunkedByteSink) {
      try {
        this.sink.disposeCommitted();
      } catch (err) {
        errors.push(err);
      }
    } else if (typeof this.sink.disposeCommitted === 'function') {
      try {
        const res = this.sink.disposeCommitted();
        if (res && typeof (res as Promise<void>).then === 'function') {
          asyncSinkDispose = res as Promise<void>;
        }
      } catch (err) {
        errors.push(err);
      }
    }

    // 3. Execute auxiliary cleanup callbacks without letting any single failure block the rest
    const callbacks = this.cleanupCallbacks.splice(0, this.cleanupCallbacks.length);
    const asyncCallbackPromises: Promise<void>[] = [];
    for (const cb of callbacks) {
      try {
        const res = cb();
        if (res && typeof (res as Promise<void>).then === 'function') {
          asyncCallbackPromises.push(
            (res as Promise<void>).catch((err) => {
              errors.push(err);
            }),
          );
        }
      } catch (err) {
        errors.push(err);
      }
    }

    this._disposePromise = (async () => {
      if (asyncSinkDispose) {
        try {
          await asyncSinkDispose;
        } catch (err) {
          errors.push(err);
        }
      }
      if (asyncCallbackPromises.length > 0) {
        await Promise.all(asyncCallbackPromises);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `Multiple cleanup errors occurred while disposing render artifact "${this.artifactId}".`,
        );
      }
    })();

    return this._disposePromise;
  }

  private assertNotDisposed(): void {
    if (this._disposed) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `Render artifact "${this.artifactId}" has been disposed and can no longer be read.`,
      );
    }
  }
}

export function createCommittedRenderArtifact(
  params: CreateCommittedRenderArtifactParams,
): CommittedRenderOutputArtifact {
  return new CommittedRenderOutputArtifact(params);
}

/**
 * Optionally materializes the deprecated `outputBytes` compatibility view ONLY when:
 * 1. The artifact is active and <= 8 MiB (COMPATIBILITY_OUTPUT_BYTES_MAX_SIZE).
 * 2. An independent MemoryBudgetManager reservation for the exact copy size can be obtained.
 *
 * The compatibility reservation is attached to the artifact's lifecycle lease so disposing
 * the artifact releases both the primary output resources and the compatibility copy.
 * Never throws on budget exhaustion or large outputs — returns null gracefully.
 */
export async function materializeCompatibilityOutputBytes(
  artifact: CommittedRenderOutputArtifact,
  memoryBudgetManager: MemoryBudgetManager,
): Promise<Uint8Array | null> {
  if (
    artifact.disposed ||
    artifact.sizeBytes <= 0 ||
    artifact.sizeBytes > COMPATIBILITY_OUTPUT_BYTES_MAX_SIZE
  ) {
    return null;
  }

  let compatReservation: MemoryReservation;
  try {
    compatReservation = memoryBudgetManager.reserve({
      owner: `RenderOutputArtifact:${artifact.artifactId}:compat-bytes`,
      category: 'render-export-buffers',
      bytes: artifact.sizeBytes,
      priority: 'optional',
    });
  } catch {
    return null;
  }

  try {
    const out = new Uint8Array(artifact.sizeBytes);
    const reader = artifact.openReadStream().getReader();
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          out.set(value, offset);
          offset += value.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (offset !== artifact.sizeBytes || artifact.disposed) {
      memoryBudgetManager.release(compatReservation);
      return null;
    }

    artifact.attachOwnedReservation(compatReservation);
    return out;
  } catch {
    memoryBudgetManager.release(compatReservation);
    return null;
  }
}

export interface ArtifactWritableDestination {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/**
 * Streams a validated RenderOutputArtifact into a WritableStream or FileSystemWritableFileStream
 * while preserving backpressure. Closes the destination only after all bytes complete
 * successfully, and aborts the destination deterministically on any read/write failure.
 */
export async function pipeRenderArtifactToWritable(
  artifact: RenderOutputArtifact,
  destination: WritableStream<Uint8Array> | ArtifactWritableDestination,
  options?: { readonly chunkSizeBytes?: number },
): Promise<number> {
  if (artifact.disposed) {
    throw new ExportWriteFailureError(
      'WRITE_IO_FAILURE',
      `Cannot stream disposed render artifact "${artifact.artifactId}".`,
    );
  }

  let totalTransferredBytes = 0;
  const sourceStream = artifact.openReadStream({
    chunkSizeBytes: options?.chunkSizeBytes,
  });

  if (typeof (destination as WritableStream<Uint8Array>).getWriter === 'function') {
    const writable = destination as WritableStream<Uint8Array>;
    const reader = sourceStream.getReader();
    const writer = writable.getWriter();
    try {
      while (true) {
        await writer.ready;
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await writer.write(value);
          totalTransferredBytes += value.byteLength;
        }
      }
      if (totalTransferredBytes !== artifact.sizeBytes) {
        throw new ExportWriteFailureError(
          'WRITE_IO_FAILURE',
          `Incomplete artifact stream transfer: wrote ${totalTransferredBytes} B of ${artifact.sizeBytes} B.`,
        );
      }
      await writer.close();
      return totalTransferredBytes;
    } catch (err) {
      try {
        await writer.abort(err);
      } catch {
        // preserve primary transfer failure
      }
      try {
        await reader.cancel(err);
      } catch {
        // preserve primary transfer failure
      }
      throw err;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  const dest = destination as ArtifactWritableDestination;
  const reader = sourceStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await dest.write(value);
        totalTransferredBytes += value.byteLength;
      }
    }
    if (totalTransferredBytes !== artifact.sizeBytes) {
      throw new ExportWriteFailureError(
        'WRITE_IO_FAILURE',
        `Incomplete artifact stream transfer: wrote ${totalTransferredBytes} B of ${artifact.sizeBytes} B.`,
      );
    }
    await dest.close();
    return totalTransferredBytes;
  } catch (err) {
    try {
      await dest.abort(err);
    } catch {
      // preserve primary transfer failure
    }
    try {
      await reader.cancel(err);
    } catch {
      // preserve primary transfer failure
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
}

