import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from './UnifiedOnnxPersianAsrEngine';
import { ChunkedModelManifest } from '../../platform/ChunkedModelDelivery';

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
        }>;
      }>;
    }>;
  }>;
}

/**
 * Section 114: Browser Web Worker onnxruntime-web Provider & Zero-Extra-Copy OPFS Chunk Assembler
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
    const modName = 'onnxruntime-web';
    const ort = (await import(/* @vite-ignore */ modName)) as OrtWebBindingLike;
    ort.env.wasm.wasmPaths = this.wasmAssetsBasePath;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = this.configuredNumThreads;
    return ort;
  }

  /**
   * Assemble 8MB model chunks from OPFS into a single pre-allocated Uint8Array without intermediate concatenations
   */
  public static async assembleModelBytesFromOpfsChunks(
    manifest: ChunkedModelManifest,
    opfsRootOverride?: OpfsRootDirectoryLike,
  ): Promise<Uint8Array> {
    const root: OpfsRootDirectoryLike =
      opfsRootOverride ?? ((await navigator.storage.getDirectory()) as unknown as OpfsRootDirectoryLike);
    const modelsRoot = await root.getDirectoryHandle('ai-models', { create: false });
    const modelDir = await modelsRoot.getDirectoryHandle(
      `${manifest.modelId}_${manifest.version}`,
      { create: false },
    );

    const assembled = new Uint8Array(manifest.totalBytes);
    let writeOffset = 0;

    for (const chunk of manifest.chunks) {
      const fileName = `chunk_${String(chunk.index).padStart(4, '0')}.bin`;
      const fileHandle = await modelDir.getFileHandle(fileName, { create: false });
      const file = await fileHandle.getFile();

      if (file.size !== chunk.byteLength) {
        throw new Error(
          `OPFS_CHUNK_CORRUPTED: اندازه قطعه #${chunk.index} نامعتبر است (${file.size} !== ${chunk.byteLength}).`,
        );
      }

      const chunkBuf = new Uint8Array(await file.arrayBuffer());
      assembled.set(chunkBuf, writeOffset);
      writeOffset += chunk.byteLength;
    }

    return assembled;
  }
}
