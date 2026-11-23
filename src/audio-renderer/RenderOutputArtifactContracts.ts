import type {
  MemoryBudgetManager,
  MemoryReservation,
} from '../runtime/memory/MemoryBudgetManager';

/** Optional range and chunk sizing for bounded artifact reads. */
export interface RenderArtifactReadStreamOptions {
  readonly start?: number;
  readonly end?: number;
  readonly chunkSizeBytes?: number;
}

/**
 * Bounded, range-addressable reader contract for committed render outputs.
 * Prevents unbounded full-file allocations during validation and export streaming.
 */
export interface RenderArtifactReader {
  readonly sizeBytes: number;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array>;
}

/**
 * Abstract streaming byte sink for OPFS / FileSystemWritableFileStream,
 * temporary disk storage, or a bounded chunked buffer.
 */
export interface StreamingByteSink {
  readonly persistedExternally: boolean;
  writeAt(offset: number, bytes: Uint8Array): Promise<void> | void;
  append(bytes: Uint8Array): Promise<void> | void;
  finalizeTempToCommitted(): Promise<void> | void;
  abortAndCleanup(): Promise<void> | void;
  getTotalBytesWritten(): number;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  openReadStream(options?: RenderArtifactReadStreamOptions): ReadableStream<Uint8Array>;
  createBlob?(contentType: string): Promise<Blob>;
  disposeCommitted?(): Promise<void> | void;
}

export type RenderArtifactLifecycleState =
  | 'WRITING'
  | 'FINALIZED'
  | 'VALIDATING'
  | 'VALIDATED_READY'
  | 'ACTIVE_IN_WORKFLOW'
  | 'DISPOSED';

export interface RenderOutputArtifact extends RenderArtifactReader {
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly contentType: 'audio/wav';
  readonly persistedExternally: boolean;
  readonly disposed: boolean;
  readonly lifecycleState: RenderArtifactLifecycleState;
  createBlob(): Promise<Blob>;
  dispose(): Promise<void>;
}

export interface CreateCommittedRenderArtifactParams {
  readonly sink: StreamingByteSink;
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly memoryBudgetManager?: MemoryBudgetManager;
  readonly contentType?: 'audio/wav';
  readonly maxReadWindowBytes?: number;
}
