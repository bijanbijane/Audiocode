import type {
  AudioAsset,
  IngestTransactionSnapshot,
  PersistedAudioAssetManifest,
  StorageBrokerTelemetry,
} from '../contracts/v1_2';
import type { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';
import {
  ingestUploadedAudioFile,
  type LoadedStudioProject,
} from '../engine/audioFixtures';
import type { StorageBrokerClient } from '../engine/storageBroker';
import {
  IngestAbortedError,
  type StreamingIngestBroker,
  type StreamingIngestOptions,
} from '../engine/streamingIngest';

export interface AudioImportCoordinatorOptions {
  readonly broker: StorageBrokerClient | StreamingIngestBroker | null;
  readonly brokerReady: Promise<StorageBrokerTelemetry> | null;
  readonly memoryBudgetManager: MemoryBudgetManager;
  readonly retainActivePcmMirror: boolean;
  readonly chunkSeconds?: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (progress: {
    phase: 'validating' | 'decoding' | 'persisting' | 'analyzing' | 'finalizing';
    percent: number;
    chunkIndex?: number;
  }) => void;
  readonly onTransactionChange?: (snapshot: IngestTransactionSnapshot) => void;
  readonly decodeCompressedAudioFn?: StreamingIngestOptions['decodeCompressedAudioFn'];
  /**
   * Optional injection point for deterministic unit tests.
   * Production callers always use the default `ingestUploadedAudioFile`.
   */
  readonly ingestFn?: typeof ingestUploadedAudioFile;
}

export type AudioImportErrorCode =
  | 'IMPORT_INVALID_FILE'
  | 'IMPORT_BROKER_DISPOSED'
  | 'IMPORT_MANIFEST_INVALID'
  | 'IMPORT_MEMORY_OWNERSHIP_INVALID';

export class AudioImportCoordinatorError extends Error {
  public readonly code: AudioImportErrorCode;
  public readonly cause?: unknown;

  constructor(code: AudioImportErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AudioImportCoordinatorError';
    this.code = code;
    this.cause = cause;
  }
}

function isAuthoritativeOpfsBackend(backend: string | undefined): boolean {
  return backend === 'OPFS-SyncAccessHandle' || backend === 'OPFS-Writable';
}

function assertNotAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new IngestAbortedError();
  }
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  assertNotAborted(abortSignal);
  if (!abortSignal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new IngestAbortedError());
    };
    const cleanup = () => {
      abortSignal.removeEventListener('abort', onAbort);
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Verifies every mandatory persistence manifest invariant before an OPFS-backed
 * audio asset may be treated as durable and ready for activation.
 */
export function verifyReadyAssetManifestInvariants(params: {
  readonly asset: AudioAsset;
  readonly manifest: PersistedAudioAssetManifest | null;
}): void {
  const { asset, manifest } = params;

  if (!manifest) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Persisted OPFS manifest for asset "${asset.id}" is missing after finalization.`,
    );
  }
  if (manifest.assetId !== asset.id) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest assetId mismatch: expected "${asset.id}", got "${manifest.assetId}".`,
    );
  }
  if (manifest.state !== 'ready') {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest state for asset "${asset.id}" is "${manifest.state}", expected "ready".`,
    );
  }
  if (manifest.contentSha256 !== asset.contentHash) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest contentSha256 mismatch for asset "${asset.id}": expected "${asset.contentHash}", got "${manifest.contentSha256}".`,
    );
  }
  if (manifest.totalSamples !== asset.exactSampleCount) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest totalSamples mismatch for asset "${asset.id}": expected ${asset.exactSampleCount}, got ${manifest.totalSamples}.`,
    );
  }
  if (manifest.totalBlocks !== asset.seekTable.length) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest totalBlocks mismatch for asset "${asset.id}": expected ${asset.seekTable.length}, got ${manifest.totalBlocks}.`,
    );
  }
  if (manifest.bytesPerSample !== Float32Array.BYTES_PER_ELEMENT) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest bytesPerSample mismatch for asset "${asset.id}": expected ${Float32Array.BYTES_PER_ELEMENT}, got ${manifest.bytesPerSample}.`,
    );
  }
  if (
    asset.blockSizeSamples !== undefined &&
    manifest.blockSizeSamples !== asset.blockSizeSamples
  ) {
    throw new AudioImportCoordinatorError(
      'IMPORT_MANIFEST_INVALID',
      `Manifest blockSizeSamples mismatch for asset "${asset.id}": expected ${asset.blockSizeSamples}, got ${manifest.blockSizeSamples}.`,
    );
  }
}

/**
 * Single production application audio-import coordinator.
 *
 * Guarantees:
 * 1. Awaits deterministic StorageBroker initialization before inspecting telemetry.
 * 2. Never creates a second broker, never uses a disposed broker, and never treats
 *    a rejected initialization as successful persistence.
 * 3. Always passes explicit broker, memory budget manager, mirror policy, abort signal,
 *    and progress callbacks into `ingestUploadedAudioFile()`.
 * 4. Verifies persisted OPFS manifests against all mandatory invariants before returning.
 * 5. Enforces honest non-persistent metadata when OPFS is unavailable.
 * 6. Disposes any retained runtime resource lease if post-ingest validation or abort fails.
 */
export async function importAudioProject(
  file: File,
  options: AudioImportCoordinatorOptions,
): Promise<LoadedStudioProject> {
  assertNotAborted(options.abortSignal);

  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    throw new AudioImportCoordinatorError(
      'IMPORT_INVALID_FILE',
      'AUDIO_DECODE_FAILED: Uploaded audio file is missing or empty (0 bytes).',
    );
  }

  let effectiveBroker: StorageBrokerClient | StreamingIngestBroker | null = options.broker;
  let resolvedTelemetry: StorageBrokerTelemetry | null = null;

  // Step 1: Deterministic broker initialization barrier
  if (effectiveBroker) {
    if (effectiveBroker.isDisposed()) {
      throw new AudioImportCoordinatorError(
        'IMPORT_BROKER_DISPOSED',
        'Storage broker was already disposed before audio import started.',
      );
    }

    if (options.brokerReady) {
      try {
        resolvedTelemetry = await awaitWithAbort(options.brokerReady, options.abortSignal);
      } catch (initErr) {
        if (initErr instanceof IngestAbortedError || options.abortSignal?.aborted) {
          throw initErr instanceof IngestAbortedError ? initErr : new IngestAbortedError();
        }
        if (effectiveBroker.isDisposed()) {
          throw new AudioImportCoordinatorError(
            'IMPORT_BROKER_DISPOSED',
            'Storage broker was disposed during initialization.',
            initErr,
          );
        }
        // Rejected initialization must NEVER be treated as successful persistence.
        // Fall back explicitly to memory-only ingestion with no broker.
        effectiveBroker = null;
        resolvedTelemetry = null;
      }
    }

    assertNotAborted(options.abortSignal);

    if (effectiveBroker) {
      if (effectiveBroker.isDisposed()) {
        throw new AudioImportCoordinatorError(
          'IMPORT_BROKER_DISPOSED',
          'Storage broker was disposed before audio ingestion could begin.',
        );
      }
      // Inspect authoritative post-initialization telemetry from the live broker
      const liveTelemetry = effectiveBroker.getTelemetry();
      if (liveTelemetry.disposed || liveTelemetry.persistenceStatus === 'Disposed') {
        throw new AudioImportCoordinatorError(
          'IMPORT_BROKER_DISPOSED',
          'Storage broker telemetry reports disposed state before audio import.',
        );
      }
      resolvedTelemetry = liveTelemetry;
    }
  }

  // Step 2: Authoritative OPFS capability decision
  const opfsAvailable = Boolean(
    effectiveBroker &&
      !effectiveBroker.isDisposed() &&
      resolvedTelemetry &&
      resolvedTelemetry.opfsSupported &&
      resolvedTelemetry.persistenceAvailable &&
      isAuthoritativeOpfsBackend(resolvedTelemetry.persistenceStatus),
  );

  const ingestOptions: StreamingIngestOptions = {
    broker: opfsAvailable ? effectiveBroker : null,
    memoryBudgetManager: options.memoryBudgetManager,
    chunkSeconds: options.chunkSeconds,
    abortSignal: options.abortSignal,
    onProgress: options.onProgress,
    onTransactionChange: options.onTransactionChange,
    retainFallbackWhenOpfsUnavailable: !opfsAvailable,
    retainResidentPcmMirror: options.retainActivePcmMirror,
    decodeCompressedAudioFn: options.decodeCompressedAudioFn,
  };

  const ingest = options.ingestFn ?? ingestUploadedAudioFile;
  const loaded = await ingest(file, ingestOptions);

  // Step 3: Fail-closed post-ingest manifest, lifecycle, and memory-ownership verification.
  // Any failure here MUST dispose the returned runtime resource lease so zero memory leaks.
  try {
    assertNotAborted(options.abortSignal);

    const assetEntries = Object.entries(loaded.assets);
    if (assetEntries.length === 0) {
      throw new AudioImportCoordinatorError(
        'IMPORT_MANIFEST_INVALID',
        'Audio import produced a project with zero assets.',
      );
    }

    if (opfsAvailable && effectiveBroker) {
      if (effectiveBroker.isDisposed()) {
        throw new AudioImportCoordinatorError(
          'IMPORT_BROKER_DISPOSED',
          'Storage broker was disposed before post-ingest manifest verification completed.',
        );
      }

      const postIngestTelemetry = effectiveBroker.getTelemetry();

      for (const [assetId, asset] of assetEntries) {
        const readyManifest = await effectiveBroker.getReadyAssetManifest(assetId);
        verifyReadyAssetManifestInvariants({ asset, manifest: readyManifest });

        if (asset.storageLifecycle !== 'ready') {
          throw new AudioImportCoordinatorError(
            'IMPORT_MANIFEST_INVALID',
            `OPFS-backed asset "${assetId}" did not report storageLifecycle="ready" (got "${String(asset.storageLifecycle)}").`,
          );
        }

        if (!isAuthoritativeOpfsBackend(asset.storageBackend)) {
          throw new AudioImportCoordinatorError(
            'IMPORT_MANIFEST_INVALID',
            `OPFS-backed asset "${assetId}" reported non-OPFS storageBackend "${String(asset.storageBackend)}".`,
          );
        }

        if (
          isAuthoritativeOpfsBackend(postIngestTelemetry.persistenceStatus) &&
          asset.storageBackend !== postIngestTelemetry.persistenceStatus
        ) {
          asset.storageBackend = postIngestTelemetry.persistenceStatus;
        }

        if (options.retainActivePcmMirror) {
          const mirrorPcm = loaded.pcmSources[assetId];
          if (!(mirrorPcm instanceof Float32Array) || mirrorPcm.length !== asset.exactSampleCount) {
            throw new AudioImportCoordinatorError(
              'IMPORT_MEMORY_OWNERSHIP_INVALID',
              `Active PCM mirror missing or length-mismatched for OPFS asset "${assetId}".`,
            );
          }
          if (!loaded.runtimeResourceLease || loaded.runtimeResourceLease.disposed) {
            throw new AudioImportCoordinatorError(
              'IMPORT_MEMORY_OWNERSHIP_INVALID',
              `Active PCM mirror for OPFS asset "${assetId}" is missing a valid runtimeResourceLease.`,
            );
          }
        } else {
          if (loaded.pcmSources[assetId] !== undefined) {
            throw new AudioImportCoordinatorError(
              'IMPORT_MEMORY_OWNERSHIP_INVALID',
              `Unexpected resident PCM buffer retained for OPFS asset "${assetId}" when retainActivePcmMirror=false.`,
            );
          }
        }
      }
    } else {
      // Truthful memory-only fallback verification: NEVER allow false OPFS persistence claims.
      for (const [assetId, asset] of assetEntries) {
        if (asset.storageLifecycle === 'ready') {
          throw new AudioImportCoordinatorError(
            'IMPORT_MANIFEST_INVALID',
            `Memory-only fallback asset "${assetId}" falsely claimed storageLifecycle="ready".`,
          );
        }
        if (isAuthoritativeOpfsBackend(asset.storageBackend)) {
          throw new AudioImportCoordinatorError(
            'IMPORT_MANIFEST_INVALID',
            `Memory-only fallback asset "${assetId}" falsely claimed OPFS backend "${String(asset.storageBackend)}".`,
          );
        }
        const fallbackPcm = loaded.pcmSources[assetId];
        if (!(fallbackPcm instanceof Float32Array) || fallbackPcm.length !== asset.exactSampleCount) {
          throw new AudioImportCoordinatorError(
            'IMPORT_MEMORY_OWNERSHIP_INVALID',
            `Memory-only fallback asset "${assetId}" is missing a complete resident PCM buffer.`,
          );
        }
        if (!loaded.runtimeResourceLease || loaded.runtimeResourceLease.disposed) {
          throw new AudioImportCoordinatorError(
            'IMPORT_MEMORY_OWNERSHIP_INVALID',
            `Memory-only fallback asset "${assetId}" is missing a valid runtimeResourceLease.`,
          );
        }
      }
    }

    return loaded;
  } catch (verifyErr) {
    loaded.runtimeResourceLease?.dispose();
    throw verifyErr;
  }
}
