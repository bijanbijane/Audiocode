import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from './UnifiedOnnxPersianAsrEngine';
import { ChunkedModelManifest } from '../../platform/ChunkedModelDelivery';
import { IncrementalSha256 } from '../../utils/StreamingSha256';
import { safeParseJsonWithGuards } from '../../security/LocalPrivacyPolicy';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryReservation,
} from '../../runtime/memory/MemoryBudgetManager';
import {
  formatModelChunkFileName,
  MODEL_ARTIFACT_MANIFEST_FILE,
  MODEL_REPOSITORY_ROOT_DIR,
  ModelRepositoryError,
  StoredModelArtifactManifest,
  validateModelPathSegment,
  validateStoredModelArtifactManifest,
} from '../../lifecycle/ModelRepositoryContracts';

export interface OrtWebBindingLike {
  env: {
    wasm: {
      wasmPaths: string;
      simd: boolean;
      numThreads: number;
    };
  };
  Tensor: new (
    type: 'float32' | 'int32' | 'int64',
    data: Float32Array | Int32Array | BigInt64Array,
    dims: readonly number[],
  ) => OrtTensorLike;
  InferenceSession: {
    create(
      modelBytesOrPath: Uint8Array | string,
      options?: {
        executionProviders?: readonly ('webgpu' | 'wasm')[];
        graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
      },
    ): Promise<OrtSessionLike>;
  };
}

export interface OpfsRootDirectoryLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    getDirectoryHandle(
      subName: string,
      subOptions?: { create?: boolean },
    ): Promise<{
      getFileHandle(
        fileName: string,
        fileOptions?: { create?: boolean },
      ): Promise<{
        getFile(): Promise<{
          size: number;
          arrayBuffer(): Promise<ArrayBuffer>;
          text?(): Promise<string>;
        }>;
      }>;
    }>;
  }>;
}

export interface AssembleModelFromOpfsOptions {
  readonly memoryBudgetManager?: MemoryBudgetManager;
  /**
   * Optional ownership callback. When provided, caller becomes responsible for
   * releasing the `model-runtime` reservation (e.g. after ONNX session unload).
   * When omitted, the reservation is released after assembly completes or fails.
   */
  readonly onReservation?: (reservation: MemoryReservation) => void;
  /** Abort signal to cancel chunk reading/verification promptly. */
  readonly signal?: AbortSignal;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const msg = (err as { message?: unknown }).message;
  return (
    name === 'NotFoundError' ||
    (typeof msg === 'string' && /not\s*found|ENOENT/i.test(msg))
  );
}

/**
 * Section 114 / AVP-MODEL-OPFS-DURABILITY-008:
 * Browser Web Worker onnxruntime-web Provider & Verified Single-Allocation OPFS Chunk Assembler
 */
export class WebWorkerOrtRuntimeProvider implements OrtRuntimeProvider {
  public readonly configuredNumThreads: number;

  constructor(
    private readonly wasmAssetsBasePath: string = '/ort/',
    private readonly customOrtWebBinding?: OrtWebBindingLike,
    crossOriginIsolatedOverride?: boolean,
  ) {
    const isIsolated =
      crossOriginIsolatedOverride ??
      (typeof self !== 'undefined' && Boolean((self as any).crossOriginIsolated));
    const cores =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
    this.configuredNumThreads = isIsolated ? Math.min(4, Math.max(1, cores - 1)) : 1;

    if (this.customOrtWebBinding) {
      this.customOrtWebBinding.env.wasm.wasmPaths = this.wasmAssetsBasePath;
      this.customOrtWebBinding.env.wasm.simd = true;
      this.customOrtWebBinding.env.wasm.numThreads = this.configuredNumThreads;
    }
  }

  public createTensor(
    type: 'float32' | 'int32' | 'int64',
    data: Float32Array | Int32Array | BigInt64Array,
    dims: readonly number[],
  ): OrtTensorLike {
    if (this.customOrtWebBinding) {
      return new this.customOrtWebBinding.Tensor(type, data, dims);
    }
    return {
      type,
      data,
      dims: [...dims],
    };
  }

  public async createSession(
    modelBytesOrPath: Uint8Array | string,
    executionProviders: ('webgpu' | 'wasm' | 'cuda' | 'cpu')[],
  ): Promise<OrtSessionLike> {
    const webProviders = executionProviders
      .map((p) => (p === 'cpu' || p === 'cuda' ? 'wasm' : p))
      .filter((v, i, arr) => arr.indexOf(v) === i);

    const providersToTry: ('webgpu' | 'wasm')[] =
      webProviders.length > 0 ? (webProviders as ('webgpu' | 'wasm')[]) : ['wasm'];

    const ortBinding = this.customOrtWebBinding ?? (await this.loadDynamicOrtWeb());

    try {
      return await ortBinding.InferenceSession.create(modelBytesOrPath, {
        executionProviders: providersToTry,
        graphOptimizationLevel: 'all',
      });
    } catch (err) {
      // Automatic safe fallback to WASM SIMD if WebGPU driver rejects an ONNX operator
      if (providersToTry.includes('webgpu')) {
        return await ortBinding.InferenceSession.create(modelBytesOrPath, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      }
      throw err;
    }
  }

  private async loadDynamicOrtWeb(): Promise<OrtWebBindingLike> {
    const ort = (await import('onnxruntime-web')) as unknown as OrtWebBindingLike;
    ort.env.wasm.wasmPaths = this.wasmAssetsBasePath;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = this.configuredNumThreads;
    return ort;
  }

  /**
   * Assembles verified model chunks from `OPFS/ai-models/{storageDirectory}` into a single
   * pre-allocated Uint8Array after explicit `MemoryBudgetManager` admission, verifying:
   * - Path segment safety (`modelId`, `version`, `storageDirectory`)
   * - Committed `manifest.json` identity (when present in the artifact directory)
   * - Contiguous chunk indices and exact byte lengths
   * - Per-chunk SHA-256 integrity
   * - Complete-artifact SHA-256 integrity
   *
   * Never falls back to an unrecognized model directory.
   */
  public static async assembleModelBytesFromOpfsChunks(
    manifest: ChunkedModelManifest,
    opfsRootOverride?: OpfsRootDirectoryLike,
    options?: AssembleModelFromOpfsOptions,
  ): Promise<Uint8Array> {
    if (options?.signal?.aborted) {
      throw new Error('OPFS_MODEL_ASSEMBLY_ABORTED');
    }

    const safeModelId = validateModelPathSegment(manifest.modelId, 'modelId');
    const safeVersion = validateModelPathSegment(manifest.version, 'version');
    const targetDirName = validateModelPathSegment(
      manifest.storageDirectory ?? `${safeModelId}_${safeVersion}`,
      'storageDirectory',
    );

    if (
      !Number.isSafeInteger(manifest.totalBytes) ||
      manifest.totalBytes <= 0 ||
      !Array.isArray(manifest.chunks) ||
      manifest.chunks.length === 0
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Invalid ChunkedModelManifest for "${targetDirName}": totalBytes or chunks invalid.`,
      );
    }

    let declaredSum = 0;
    for (let i = 0; i < manifest.chunks.length; i++) {
      const c = manifest.chunks[i];
      if (c.index !== i) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Chunk manifest for "${targetDirName}" has out-of-order or non-contiguous index ${c.index} (expected ${i}).`,
        );
      }
      if (!Number.isSafeInteger(c.byteLength) || c.byteLength <= 0) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Chunk #${i} in "${targetDirName}" has invalid byteLength ${c.byteLength}.`,
        );
      }
      if (typeof c.sha256Hex !== 'string' || !SHA256_HEX_RE.test(c.sha256Hex.toLowerCase())) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Chunk #${i} in "${targetDirName}" is missing a valid 64-hex SHA-256 digest.`,
        );
      }
      declaredSum += c.byteLength;
    }

    if (declaredSum !== manifest.totalBytes) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Chunk manifest byte sum (${declaredSum}) does not equal totalBytes (${manifest.totalBytes}).`,
      );
    }

    if (
      manifest.sha256Hex !== undefined &&
      !SHA256_HEX_RE.test(manifest.sha256Hex.toLowerCase())
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Manifest sha256Hex for "${targetDirName}" is not a valid 64-hex SHA-256 digest.`,
      );
    }

    const root: OpfsRootDirectoryLike =
      opfsRootOverride ??
      ((await navigator.storage.getDirectory()) as unknown as OpfsRootDirectoryLike);
    const modelsRoot = await root.getDirectoryHandle(MODEL_REPOSITORY_ROOT_DIR, {
      create: false,
    });
    const modelDir = await modelsRoot.getDirectoryHandle(targetDirName, { create: false });

    // If a committed manifest.json exists in the artifact directory, verify strict identity match
    let storedManifest: StoredModelArtifactManifest | null = null;
    try {
      const manifestHandle = await modelDir.getFileHandle(MODEL_ARTIFACT_MANIFEST_FILE, {
        create: false,
      });
      const manifestFile = await manifestHandle.getFile();
      const rawText =
        typeof manifestFile.text === 'function'
          ? await manifestFile.text()
          : new TextDecoder().decode(new Uint8Array(await manifestFile.arrayBuffer()));
      const parsed = safeParseJsonWithGuards<unknown>(rawText, 4 * 1024 * 1024);
      storedManifest = validateStoredModelArtifactManifest(parsed, targetDirName);
    } catch (err) {
      if (!isNotFoundError(err)) {
        if (err instanceof ModelRepositoryError) throw err;
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Corrupted OPFS manifest.json in "${targetDirName}": ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }

    if (storedManifest) {
      if (
        storedManifest.modelId !== safeModelId ||
        storedManifest.version !== safeVersion ||
        storedManifest.totalBytes !== manifest.totalBytes ||
        storedManifest.chunkCount !== manifest.chunks.length ||
        (manifest.sha256Hex &&
          storedManifest.sha256Hex !== manifest.sha256Hex.toLowerCase())
      ) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `OPFS stored manifest in "${targetDirName}" does not match requested model identity (${safeModelId}@${safeVersion}).`,
        );
      }
    }

    // Mandatory MemoryBudgetManager admission BEFORE allocating the contiguous model buffer
    const budgetManager = options?.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    const reservation = budgetManager.reserve({
      owner: `ort-model-assembly:${safeModelId}@${safeVersion}`,
      category: 'model-runtime',
      bytes: manifest.totalBytes,
      priority: 'normal',
    });

    let reservationTransferred = false;
    try {
      const assembled = new Uint8Array(manifest.totalBytes);
      const fullHasher = new IncrementalSha256();
      let writeOffset = 0;

      for (const chunk of manifest.chunks) {
        if (options?.signal?.aborted) {
          throw new Error('OPFS_MODEL_ASSEMBLY_ABORTED');
        }

        const fileName = formatModelChunkFileName(chunk.index);
        const fileHandle = await modelDir.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();

        if (file.size !== chunk.byteLength) {
          throw new ModelRepositoryError(
            'MODEL_INTEGRITY_FAILURE',
            `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} size mismatch (${file.size} !== ${chunk.byteLength}).`,
          );
        }

        const chunkBuf = new Uint8Array(await file.arrayBuffer());
        if (chunkBuf.byteLength !== chunk.byteLength) {
          throw new ModelRepositoryError(
            'MODEL_INTEGRITY_FAILURE',
            `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} readback length mismatch (${chunkBuf.byteLength} !== ${chunk.byteLength}).`,
          );
        }

        const actualChunkSha = new IncrementalSha256().update(chunkBuf).digestHex();
        const expectedChunkSha = chunk.sha256Hex.toLowerCase();
        if (actualChunkSha !== expectedChunkSha) {
          throw new ModelRepositoryError(
            'MODEL_INTEGRITY_FAILURE',
            `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} SHA-256 mismatch (expected ${expectedChunkSha}, actual ${actualChunkSha}).`,
          );
        }

        if (storedManifest) {
          const manifestChunk = storedManifest.chunks[chunk.index];
          if (
            !manifestChunk ||
            manifestChunk.sha256Hex !== actualChunkSha ||
            manifestChunk.byteLength !== chunkBuf.byteLength
          ) {
            throw new ModelRepositoryError(
              'MODEL_INTEGRITY_FAILURE',
              `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} does not match committed manifest.json.`,
            );
          }
        }

        fullHasher.update(chunkBuf);
        assembled.set(chunkBuf, writeOffset);
        writeOffset += chunk.byteLength;
      }

      if (writeOffset !== manifest.totalBytes) {
        throw new ModelRepositoryError(
          'MODEL_INTEGRITY_FAILURE',
          `OPFS_MODEL_INCOMPLETE: Assembled ${writeOffset} B != expected ${manifest.totalBytes} B.`,
        );
      }

      const expectedFullSha = (
        manifest.sha256Hex ?? storedManifest?.sha256Hex
      )?.toLowerCase();
      if (expectedFullSha) {
        const actualFullSha = fullHasher.digestHex();
        if (actualFullSha !== expectedFullSha) {
          throw new ModelRepositoryError(
            'MODEL_INTEGRITY_FAILURE',
            `OPFS_MODEL_HASH_MISMATCH: Complete model SHA-256 mismatch (expected ${expectedFullSha}, actual ${actualFullSha}).`,
          );
        }
      }

      if (options?.onReservation) {
        options.onReservation(reservation);
        reservationTransferred = true;
      }

      return assembled;
    } finally {
      if (!reservationTransferred) {
        budgetManager.release(reservation);
      }
    }
  }
}
