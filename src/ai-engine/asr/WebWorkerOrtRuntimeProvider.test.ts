import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpfsRootDirectoryLike,
  OrtWebBindingLike,
  WebWorkerOrtRuntimeProvider,
} from './WebWorkerOrtRuntimeProvider';
import { sha256Bytes } from '../../utils/StreamingSha256';
import { MemoryBudgetManager } from '../../runtime/memory/MemoryBudgetManager';

function buildMockOpfsRoot(filesByDir: Record<string, Record<string, Uint8Array>>): OpfsRootDirectoryLike {
  return {
    async getDirectoryHandle(name: string) {
      if (name !== 'ai-models') {
        throw new Error(`Unexpected root directory: ${name}`);
      }
      return {
        async getDirectoryHandle(modelDir: string) {
          const dir = filesByDir[modelDir];
          if (!dir) {
            throw new Error(`Directory not found: ${modelDir}`);
          }
          return {
            async getFileHandle(fileName: string) {
              const data = dir[fileName];
              if (!data) {
                throw new Error(`File not found: ${modelDir}/${fileName}`);
              }
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
}

describe('Section 114 & AVP-008: WebWorkerOrtRuntimeProvider & Hardened OPFS Model Assembler', () => {
  it('falls back from webgpu to wasm and assembles verified OPFS chunks with SHA-256 and MemoryBudgetManager admission', async () => {
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

    const chunk0 = new Uint8Array([10, 20, 30]);
    const chunk1 = new Uint8Array([40, 50]);
    const fullBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const hash0 = sha256Bytes(chunk0);
    const hash1 = sha256Bytes(chunk1);
    const fullHash = sha256Bytes(fullBytes);

    const manifestJson = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        modelId: 'conformer-fa',
        version: '1.0.0',
        generationId: 'gen-1',
        storageDirectory: 'conformer-fa_1.0.0_gen-1',
        fileName: 'conformer-fa.onnx',
        totalBytes: 5,
        sha256Hex: fullHash,
        chunkSizeBytes: 3,
        installedAtIso: '2026-11-20T00:00:00.000Z',
        verifiedAtIso: '2026-11-20T00:00:00.000Z',
        chunks: [
          { index: 0, fileName: 'chunk_0000.bin', byteLength: 3, sha256Hex: hash0 },
          { index: 1, fileName: 'chunk_0001.bin', byteLength: 2, sha256Hex: hash1 },
        ],
      }),
    );

    const mockOpfsRoot = buildMockOpfsRoot({
      'conformer-fa_1.0.0_gen-1': {
        'manifest.json': manifestJson,
        'chunk_0000.bin': chunk0,
        'chunk_0001.bin': chunk1,
      },
    });

    const budget = new MemoryBudgetManager({ totalSoftLimitBytes: 1024 * 1024 });
    let capturedReservationId: string | null = null;
    const assembled = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
      {
        modelId: 'conformer-fa',
        version: '1.0.0',
        storageDirectory: 'conformer-fa_1.0.0_gen-1',
        totalBytes: 5,
        sha256Hex: fullHash,
        chunks: [
          { index: 0, url: '/c0', sha256Hex: hash0, byteLength: 3 },
          { index: 1, url: '/c1', sha256Hex: hash1, byteLength: 2 },
        ],
      },
      mockOpfsRoot,
      {
        memoryBudgetManager: budget,
        onReservation: (res) => {
          capturedReservationId = res.id;
        },
      },
    );

    assert.deepEqual(Array.from(assembled), [10, 20, 30, 40, 50]);
    assert.ok(capturedReservationId !== null);
    assert.equal(budget.getSnapshot().usedBytes, 5);
    budget.release(capturedReservationId!);
    assert.equal(budget.getSnapshot().usedBytes, 0);
  });

  it('rejects corrupted chunks, mismatched manifest identity, wrong full-artifact hash, and MemoryBudgetManager denial', async () => {
    const chunk0 = new Uint8Array([1, 2, 3, 4]);
    const chunk1 = new Uint8Array([5, 6, 7, 8]);
    const hash0 = sha256Bytes(chunk0);
    const hash1 = sha256Bytes(chunk1);
    const fullHash = sha256Bytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    const corruptedOpfs = buildMockOpfsRoot({
      'model-a_1.0.0': {
        'chunk_0000.bin': new Uint8Array([1, 2, 3, 99]), // flipped byte
        'chunk_0001.bin': chunk1,
      },
    });

    const budget = new MemoryBudgetManager({ totalSoftLimitBytes: 1024 * 1024 });
    await assert.rejects(
      () =>
        WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
          {
            modelId: 'model-a',
            version: '1.0.0',
            totalBytes: 8,
            sha256Hex: fullHash,
            chunks: [
              { index: 0, url: '/c0', sha256Hex: hash0, byteLength: 4 },
              { index: 1, url: '/c1', sha256Hex: hash1, byteLength: 4 },
            ],
          },
          corruptedOpfs,
          { memoryBudgetManager: budget },
        ),
      /CHUNK_SHA256_MISMATCH|INTEGRITY/,
    );
    assert.equal(budget.getSnapshot().usedBytes, 0, 'Reservation must be released on failure');

    // Path traversal rejection
    await assert.rejects(
      () =>
        WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
          {
            modelId: '../escape',
            version: '1.0.0',
            totalBytes: 8,
            sha256Hex: fullHash,
            chunks: [
              { index: 0, url: '/c0', sha256Hex: hash0, byteLength: 4 },
              { index: 1, url: '/c1', sha256Hex: hash1, byteLength: 4 },
            ],
          },
          corruptedOpfs,
          { memoryBudgetManager: budget },
        ),
      /INVALID_MODEL_PATH_SEGMENT|INVALID_STORAGE_DIRECTORY/,
    );

    // Budget denial before allocating
    const tinyBudget = new MemoryBudgetManager({
      totalSoftLimitBytes: 4,
      categoryLimits: {
        AUDIO_PCM: 4,
        AI_MODEL: 4,
        WAVEFORM: 4,
        RENDER_BUFFER: 4,
        CACHE: 4,
        OTHER: 4,
      },
    });
    const validOpfs = buildMockOpfsRoot({
      'model-a_1.0.0': {
        'chunk_0000.bin': chunk0,
        'chunk_0001.bin': chunk1,
      },
    });
    await assert.rejects(
      () =>
        WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
          {
            modelId: 'model-a',
            version: '1.0.0',
            totalBytes: 8,
            sha256Hex: fullHash,
            chunks: [
              { index: 0, url: '/c0', sha256Hex: hash0, byteLength: 4 },
              { index: 1, url: '/c1', sha256Hex: hash1, byteLength: 4 },
            ],
          },
          validOpfs,
          { memoryBudgetManager: tinyBudget },
        ),
      /MODEL_MEMORY_BUDGET_DENIED|MEMORY_BUDGET/,
    );
  });
});
