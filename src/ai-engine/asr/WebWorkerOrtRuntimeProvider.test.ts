import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpfsRootDirectoryLike,
  OrtWebBindingLike,
  WebWorkerOrtRuntimeProvider,
} from './WebWorkerOrtRuntimeProvider';

describe('Section 114: WebWorkerOrtRuntimeProvider & Single-Allocation OPFS Model Assembler', () => {
  it('falls back from webgpu to wasm on session creation failure and assembles OPFS chunks into one contiguous buffer', async () => {
    const triedProviders: (readonly string[])[] = [];
    const mockOrtWeb: OrtWebBindingLike = {
      env: { wasm: { wasmPaths: '', simd: false, numThreads: 1 } },
      Tensor: class {
        constructor(
          public type: 'float32' | 'int32' | 'int64',
          public data: Float32Array | Int32Array | BigInt64Array,
          public dims: readonly number[],
        ) {}
      },
      InferenceSession: {
        async create(_model, opts) {
          const eps = opts?.executionProviders ?? ['wasm'];
          triedProviders.push(eps);
          if (eps.includes('webgpu')) {
            throw new Error('WEBGPU_ADAPTER_UNSUPPORTED_OP');
          }
          return {
            async run() {
              return {};
            },
          };
        },
      },
    };

    const provider = new WebWorkerOrtRuntimeProvider('/ort/', mockOrtWeb, true);
    assert.ok(provider.configuredNumThreads >= 1);
    assert.equal(mockOrtWeb.env.wasm.simd, true);

    await provider.createSession(new Uint8Array([1, 2, 3]), ['webgpu', 'wasm']);
    assert.equal(triedProviders.length, 2);
    assert.deepEqual(triedProviders[0], ['webgpu', 'wasm']);
    assert.deepEqual(triedProviders[1], ['wasm']);

    // Test single-allocation OPFS chunk assembly
    const chunk0 = new Uint8Array([10, 20, 30]);
    const chunk1 = new Uint8Array([40, 50]);
    const mockOpfsRoot: OpfsRootDirectoryLike = {
      async getDirectoryHandle() {
        return {
          async getDirectoryHandle() {
            return {
              async getFileHandle(name: string) {
                const data = name.includes('0000') ? chunk0 : chunk1;
                return {
                  async getFile() {
                    return {
                      size: data.byteLength,
                      async arrayBuffer() {
                        return data.buffer.slice(
                          data.byteOffset,
                          data.byteOffset + data.byteLength,
                        );
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const assembled = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
      {
        modelId: 'conformer-fa',
        version: '1.0.0',
        totalBytes: 5,
        chunks: [
          { index: 0, url: '/c0', sha256Hex: 'a', byteLength: 3 },
          { index: 1, url: '/c1', sha256Hex: 'b', byteLength: 2 },
        ],
      },
      mockOpfsRoot,
    );

    assert.deepEqual(Array.from(assembled), [10, 20, 30, 40, 50]);
  });
});
