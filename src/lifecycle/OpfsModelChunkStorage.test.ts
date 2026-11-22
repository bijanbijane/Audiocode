import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpfsDirectoryHandleLike,
  OpfsFileHandleLike,
  OpfsModelChunkStorage,
} from './OpfsModelChunkStorage';
import {
  ModelRepositoryError,
  PersistedModelRegistryPointer,
  StoredModelArtifactManifest,
} from './ModelRepositoryContracts';
import { sha256Bytes } from '../utils/StreamingSha256';

interface VirtualNode {
  kind: 'dir' | 'file';
  children?: Map<string, VirtualNode>;
  bytes?: Uint8Array;
}

class VirtualOpfsFs {
  public readonly root: VirtualNode = { kind: 'dir', children: new Map() };
  public failWritesWithQuotaExceeded = false;

  public getRootHandle(): OpfsDirectoryHandleLike {
    return this.wrapDir(this.root, 'root');
  }

  private wrapDir(node: VirtualNode, name: string): OpfsDirectoryHandleLike {
    const fs = this;
    return {
      kind: 'directory',
      name,
      async getDirectoryHandle(childName: string, options?: { create?: boolean }) {
        const existing = node.children!.get(childName);
        if (existing) {
          if (existing.kind !== 'dir') {
            throw new Error(`TypeMismatchError: ${childName} is not a directory`);
          }
          return fs.wrapDir(existing, childName);
        }
        if (!options?.create) {
          const err = new Error(`NotFoundError: directory ${childName} not found`);
          err.name = 'NotFoundError';
          throw err;
        }
        const created: VirtualNode = { kind: 'dir', children: new Map() };
        node.children!.set(childName, created);
        return fs.wrapDir(created, childName);
      },
      async getFileHandle(childName: string, options?: { create?: boolean }) {
        const existing = node.children!.get(childName);
        if (existing) {
          if (existing.kind !== 'file') {
            throw new Error(`TypeMismatchError: ${childName} is not a file`);
          }
          return fs.wrapFile(existing, childName);
        }
        if (!options?.create) {
          const err = new Error(`NotFoundError: file ${childName} not found`);
          err.name = 'NotFoundError';
          throw err;
        }
        const created: VirtualNode = { kind: 'file', bytes: new Uint8Array(0) };
        node.children!.set(childName, created);
        return fs.wrapFile(created, childName);
      },
      async removeEntry(childName: string) {
        if (!node.children!.has(childName)) {
          const err = new Error(`NotFoundError: ${childName}`);
          err.name = 'NotFoundError';
          throw err;
        }
        node.children!.delete(childName);
      },
      async *entries() {
        for (const [k, v] of node.children!.entries()) {
          yield [k, { kind: v.kind === 'dir' ? 'directory' : 'file', name: k }] as [
            string,
            { readonly kind: 'file' | 'directory'; readonly name?: string },
          ];
        }
      },
    };
  }

  private wrapFile(node: VirtualNode, name: string): OpfsFileHandleLike {
    const fs = this;
    return {
      kind: 'file',
      name,
      async getFile() {
        const snapshot = node.bytes ?? new Uint8Array(0);
        return {
          size: snapshot.byteLength,
          async arrayBuffer() {
            const copy = snapshot.slice();
            return copy.buffer;
          },
          async text() {
            return new TextDecoder().decode(snapshot);
          },
        };
      },
      async createWritable() {
        const parts: Uint8Array[] = [];
        return {
          async write(data: Uint8Array | ArrayBuffer | string) {
            if (fs.failWritesWithQuotaExceeded) {
              const err = new Error('Storage quota exceeded');
              err.name = 'QuotaExceededError';
              throw err;
            }
            if (typeof data === 'string') {
              parts.push(new TextEncoder().encode(data));
            } else if (data instanceof Uint8Array) {
              parts.push(data.slice());
            } else {
              parts.push(new Uint8Array(data.slice(0)));
            }
          },
          async close() {
            const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const p of parts) {
              merged.set(p, offset);
              offset += p.byteLength;
            }
            node.bytes = merged;
          },
          async abort() {
            parts.length = 0;
          },
        };
      },
    };
  }
}

describe('AVP-008: OpfsModelChunkStorage durable repository', () => {
  it('stages chunks in isolation, promotes atomically, and persists across storage re-instantiation', async () => {
    const vfs = new VirtualOpfsFs();
    const storage1 = new OpfsModelChunkStorage({
      getRootDirectory: async () => vfs.getRootHandle(),
      estimateStorage: async () => ({ quota: 2 * 1024 * 1024 * 1024, usage: 0 }),
    });
    await storage1.initialize();

    const chunk0 = new Uint8Array([1, 2, 3, 4]);
    const chunk1 = new Uint8Array([5, 6, 7]);
    const fullBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const fullHash = sha256Bytes(fullBytes);
    const storageDir = 'avapardaz-fa_1.0.0_gen1';

    await storage1.beginTemporaryArtifact({
      key: storageDir,
      expectedByteLength: fullBytes.byteLength,
      chunkSizeBytes: 4,
    });
    await storage1.writeTemporaryChunk(storageDir, 0, chunk0);
    await storage1.writeTemporaryChunk(storageDir, 4, chunk1);

    // Before promote/pointer write, active pointer must still be null
    assert.equal(await storage1.readActiveRegistryPointer(), null);

    const manifest: StoredModelArtifactManifest = {
      schemaVersion: 1,
      modelId: 'avapardaz-fa',
      version: '1.0.0',
      generationId: 'gen1',
      storageDirectory: storageDir,
      architecture: 'FASTCONFORMER_CTC',
      storageBackend: 'OPFS',
      fileName: 'avapardaz-fa.onnx',
      totalBytes: fullBytes.byteLength,
      chunkSizeBytes: 4,
      chunkCount: 2,
      sha256Hex: fullHash,
      committedAtMs: 1_795_046_400_000,
      chunks: [
        { index: 0, byteLength: 4, sha256Hex: sha256Bytes(chunk0) },
        { index: 1, byteLength: 3, sha256Hex: sha256Bytes(chunk1) },
      ],
    };

    await storage1.promoteTemporaryArtifact(storageDir, storageDir, manifest);
    const pointer: PersistedModelRegistryPointer = {
      schemaVersion: 1,
      modelId: 'avapardaz-fa',
      version: '1.0.0',
      generationId: 'gen1',
      storageDirectory: storageDir,
      architecture: 'FASTCONFORMER_CTC',
      supportedRuntime: 'onnxruntime-web/wasm',
      supportedExecutionProviders: ['wasm'],
      fileName: 'avapardaz-fa.onnx',
      fileSizeBytes: fullBytes.byteLength,
      verifiedSha256Hex: fullHash,
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
      compatibilityMinAppVersion: '1.0.0',
      installedAtMs: 1_795_046_400_000,
      committedAtMs: 1_795_046_400_000,
    };
    await storage1.writeActiveRegistryPointer(pointer);

    // Simulate complete browser reload with a fresh OpfsModelChunkStorage instance
    const storage2 = new OpfsModelChunkStorage({
      getRootDirectory: async () => vfs.getRootHandle(),
    });
    await storage2.initialize();

    const restoredPtr = await storage2.readActiveRegistryPointer();
    assert.deepEqual(restoredPtr, pointer);

    const restoredManifest = await storage2.getInstalledManifest(storageDir);
    assert.equal(restoredManifest?.sha256Hex, fullHash);
    assert.equal(restoredManifest?.chunks.length, 2);

    const r0 = await storage2.readInstalledChunk(storageDir, 0);
    const r1 = await storage2.readInstalledChunk(storageDir, 1);
    assert.ok(r0);
    assert.ok(r1);
    assert.deepEqual(Array.from(r0), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(r1), [5, 6, 7]);
  });

  it('rejects path traversal segments and maps QuotaExceededError to MODEL_STORAGE_QUOTA_EXCEEDED', async () => {
    const vfs = new VirtualOpfsFs();
    const storage = new OpfsModelChunkStorage({
      getRootDirectory: async () => vfs.getRootHandle(),
    });
    await storage.initialize();

    await assert.rejects(
      () =>
        storage.beginTemporaryArtifact({
          key: '../escape',
          expectedByteLength: 16,
          chunkSizeBytes: 8,
        }),
      (err: unknown) =>
        err instanceof ModelRepositoryError && err.code === 'MODEL_PATH_INVALID',
    );

    await storage.beginTemporaryArtifact({
      key: 'quota-test_1.0.0_g1',
      expectedByteLength: 16,
      chunkSizeBytes: 8,
    });
    vfs.failWritesWithQuotaExceeded = true;

    await assert.rejects(
      () => storage.writeTemporaryChunk('quota-test_1.0.0_g1', 0, new Uint8Array(8)),
      (err: unknown) =>
        err instanceof ModelRepositoryError && err.code === 'MODEL_STORAGE_QUOTA_EXCEEDED',
    );

    vfs.failWritesWithQuotaExceeded = false;
    await storage.deleteTemporaryArtifact('quota-test_1.0.0_g1');
    // Idempotent second delete must not throw
    await storage.deleteTemporaryArtifact('quota-test_1.0.0_g1');
  });
});
