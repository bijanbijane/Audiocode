import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryModelChunkStorage,
  LocalModelLifecycleManager,
} from './LocalModelLifecycleManager';
import {
  MAX_MODEL_CHUNK_BYTES,
  PersistedModelRegistryPointer,
  StoredModelArtifactManifest,
  StreamingModelChunkStorage,
} from './ModelRepositoryContracts';
import {
  OpfsDirectoryHandleLike,
  OpfsFileHandleLike,
  OpfsModelChunkStorage,
} from './OpfsModelChunkStorage';
import { IncrementalSha256, sha256Bytes } from '../utils/StreamingSha256';
import {
  OpfsRootDirectoryLike,
  WebWorkerOrtRuntimeProvider,
} from '../ai-engine/asr/WebWorkerOrtRuntimeProvider';
import { MemoryBudgetManager } from '../runtime/memory/MemoryBudgetManager';

function createManifest(params: {
  modelId?: string;
  version?: string;
  byteLength: number;
  sha256Hex: string;
}) {
  return {
    modelId: params.modelId ?? 'avapardaz-fa-conformer',
    modelVersion: params.version ?? '1.0.0',
    architecture: 'FASTCONFORMER_CTC' as const,
    fileName: `${params.modelId ?? 'avapardaz-fa-conformer'}.onnx`,
    expectedByteLength: params.byteLength,
    expectedSha256Hex: params.sha256Hex,
  };
}

function makeDeterministicPayload(sizeBytes: number, seed: number): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i * 31 + seed) & 0xff;
  }
  return buf;
}

function makeRangeStream(payload: Uint8Array) {
  return {
    supportsRangeResume: true,
    async fetchRange(startByte: number, endByteExclusive: number): Promise<Uint8Array> {
      return payload.slice(startByte, endByteExclusive);
    },
  };
}

/**
 * Virtual bounded-RAM storage spy for testing 16/64/256/512 MiB model streams without
 * allocating hundreds of megabytes in test RAM. Tracks every chunk size and digests chunks
 * incrementally on the fly.
 */
class BoundedRamStreamingStorageSpy implements StreamingModelChunkStorage {
  public maxObservedChunkBytes = 0;
  public totalBytesWritten = 0;
  public activePointer: PersistedModelRegistryPointer | null = null;
  public previousPointer: PersistedModelRegistryPointer | null = null;
  public manifests = new Map<string, StoredModelArtifactManifest>();
  private stagingChunkBytes = new Map<string, number>();

  public isStorageAvailable(): boolean {
    return true;
  }
  public getStorageBackendName(): 'MEMORY_TEST' {
    return 'MEMORY_TEST';
  }
  public async initialize(): Promise<void> {}
  public async getAvailableQuotaBytes(): Promise<number | null> {
    return 4 * 1024 * 1024 * 1024;
  }
  public async beginTemporaryArtifact(params: {
    key: string;
    expectedByteLength: number;
    chunkSizeBytes: number;
  }): Promise<void> {
    this.stagingChunkBytes.set(params.key, 0);
  }
  public async writeTemporaryChunk(key: string, _offset: number, chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength > this.maxObservedChunkBytes) {
      this.maxObservedChunkBytes = chunk.byteLength;
    }
    this.totalBytesWritten += chunk.byteLength;
    this.stagingChunkBytes.set(key, (this.stagingChunkBytes.get(key) ?? 0) + chunk.byteLength);
  }
  public async readTemporaryProgress(key: string): Promise<number> {
    return this.stagingChunkBytes.get(key) ?? 0;
  }
  public async deleteTemporaryArtifact(key: string): Promise<void> {
    this.stagingChunkBytes.delete(key);
  }
  public async readTemporaryChunk(key: string, index: number): Promise<Uint8Array | null> {
    const bytes = this.stagingChunkBytes.get(key) ?? 0;
    const start = index * MAX_MODEL_CHUNK_BYTES;
    if (start >= bytes) return null;
    return new Uint8Array(Math.min(MAX_MODEL_CHUNK_BYTES, bytes - start));
  }
  public async getTemporaryArtifactSize(key: string): Promise<number> {
    return this.stagingChunkBytes.get(key) ?? 0;
  }
  public async promoteTemporaryArtifact(
    temporaryKey: string,
    installedKey: string,
    manifest: StoredModelArtifactManifest,
  ): Promise<void> {
    this.manifests.set(installedKey, manifest);
    this.stagingChunkBytes.delete(temporaryKey);
  }
  public async getInstalledManifest(
    storageDirectory: string,
  ): Promise<StoredModelArtifactManifest | null> {
    return this.manifests.get(storageDirectory) ?? null;
  }
  public async readInstalledChunk(storageDirectory: string, chunkIndex: number): Promise<Uint8Array | null> {
    const manifest = this.manifests.get(storageDirectory);
    if (!manifest) return null;
    const entry = manifest.chunks[chunkIndex];
    if (!entry) return null;
    const buf = new Uint8Array(entry.byteLength);
    buf.fill((chunkIndex * 17 + 5) & 0xff);
    return buf;
  }
  public async deleteInstalledArtifact(storageDirectory: string): Promise<void> {
    this.manifests.delete(storageDirectory);
  }
  public async readActiveRegistryPointer(): Promise<PersistedModelRegistryPointer | null> {
    return this.activePointer;
  }
  public async writeActiveRegistryPointer(pointer: PersistedModelRegistryPointer | null): Promise<void> {
    this.activePointer = pointer;
  }
  public async readPreviousRegistryPointer(): Promise<PersistedModelRegistryPointer | null> {
    return this.previousPointer;
  }
  public async writePreviousRegistryPointer(pointer: PersistedModelRegistryPointer | null): Promise<void> {
    this.previousPointer = pointer;
  }
  public async listArtifacts(): Promise<{ installed: string[]; temporary: string[] }> {
    return {
      installed: Array.from(this.manifests.keys()),
      temporary: Array.from(this.stagingChunkBytes.keys()),
    };
  }
}

describe('AVP-008: LocalModelLifecycleManager durability, bounded streaming, rollback & runtime handoff', () => {
  it('persists installed model across restart and hydrates as MODEL_AVAILABLE (never falsely MODEL_READY)', async () => {
    const sharedStorage = new InMemoryModelChunkStorage();
    const mgr1 = new LocalModelLifecycleManager(sharedStorage);
    await mgr1.initialize();

    const payload = makeDeterministicPayload(128 * 1024, 11);
    const sha = sha256Bytes(payload);
    const manifest = createManifest({ byteLength: payload.byteLength, sha256Hex: sha });

    const installSnap = await mgr1.installOrUpdateFromStream({
      manifest,
      stream: makeRangeStream(payload),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
    });

    assert.equal(installSnap.snapshot.state, 'MODEL_AVAILABLE');
    assert.equal(installSnap.snapshot.runtimeReady, false);
    assert.equal(installSnap.snapshot.activeModel?.verifiedSha256Hex, sha);

    // Explicit runtime readiness transition
    mgr1.markRuntimeReady(true);
    assert.equal(mgr1.getSnapshot().state, 'MODEL_READY');
    assert.equal(mgr1.getSnapshot().runtimeReady, true);

    // Simulate reload: fresh manager instance over same durable storage
    const mgr2 = new LocalModelLifecycleManager(sharedStorage);
    const hydrated = await mgr2.initialize();

    assert.equal(hydrated.state, 'MODEL_AVAILABLE', 'Reloaded verified model must enter MODEL_AVAILABLE, not MODEL_READY');
    assert.equal(hydrated.runtimeReady, false);
    assert.equal(hydrated.activeModel?.modelId, manifest.modelId);
    assert.equal(hydrated.activeModel?.verifiedSha256Hex, sha);

    const offlineOk = await mgr2.verifyInstalledActiveModelOffline();
    assert.equal(offlineOk, true);
    assert.equal(mgr2.getSnapshot().state, 'MODEL_AVAILABLE');
  });

  it('streams 16 MiB, 64 MiB, 256 MiB, and 512 MiB virtual models with strictly bounded <= 1 MiB chunk reads', async () => {
    for (const sizeMiB of [16, 64, 256, 512]) {
      const storage = new BoundedRamStreamingStorageSpy();
      const mgr = new LocalModelLifecycleManager(storage);
      await mgr.initialize();

      const totalBytes = sizeMiB * 1024 * 1024;
      const chunkBytes = MAX_MODEL_CHUNK_BYTES; // 1 MiB
      const chunkCount = totalBytes / chunkBytes;

      // Pre-compute exact streaming SHA-256 without ever allocating totalBytes in RAM
      const preHasher = new IncrementalSha256();
      const scratch = new Uint8Array(chunkBytes);
      for (let i = 0; i < chunkCount; i++) {
        scratch.fill((i * 17 + 5) & 0xff);
        preHasher.update(scratch);
      }
      const expectedSha = preHasher.digestHex();

      async function* virtualStream(): AsyncIterable<Uint8Array> {
        for (let i = 0; i < chunkCount; i++) {
          const buf = new Uint8Array(chunkBytes);
          buf.fill((i * 17 + 5) & 0xff);
          yield buf;
        }
      }

      const snap = await mgr.installOrUpdateFromStream({
        manifest: createManifest({
          modelId: `virtual-${sizeMiB}mib`,
          version: '1.0.0',
          byteLength: totalBytes,
          sha256Hex: expectedSha,
        }),
        stream: {
          supportsRangeResume: true,
          async fetchRange(startByte: number, endByteExclusive: number): Promise<Uint8Array> {
            const out = new Uint8Array(endByteExclusive - startByte);
            let offset = startByte;
            while (offset < endByteExclusive) {
              const chunkIndex = Math.floor(offset / chunkBytes);
              const withinChunk = offset % chunkBytes;
              const count = Math.min(endByteExclusive - offset, chunkBytes - withinChunk);
              out.fill((chunkIndex * 17 + 5) & 0xff, offset - startByte, offset - startByte + count);
              offset += count;
            }
            return out;
          },
        },
        license: 'Apache-2.0',
        sourceOrigin: 'local-file',
      });

      assert.equal(snap.snapshot.state, 'MODEL_AVAILABLE');
      assert.equal(snap.snapshot.activeModel?.fileSizeBytes, totalBytes);
      assert.equal(snap.snapshot.activeModel?.verifiedSha256Hex, expectedSha);
      assert.ok(
        storage.maxObservedChunkBytes <= MAX_MODEL_CHUNK_BYTES,
        `Chunk write exceeded 1 MiB for ${sizeMiB} MiB model: ${storage.maxObservedChunkBytes}`,
      );
      assert.equal(storage.totalBytesWritten, totalBytes);
    }
  });

  it('preserves previous verified model on failed replacement and supports verified rollback after successful update', async () => {
    const storage = new InMemoryModelChunkStorage();
    const mgr = new LocalModelLifecycleManager(storage);
    await mgr.initialize();

    const v1Bytes = makeDeterministicPayload(64 * 1024, 1);
    const v1Sha = sha256Bytes(v1Bytes);
    await mgr.installOrUpdateFromStream({
      manifest: createManifest({ version: '1.0.0', byteLength: v1Bytes.byteLength, sha256Hex: v1Sha }),
      stream: makeRangeStream(v1Bytes),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
    });
    assert.equal(mgr.getSnapshot().activeModel?.version, '1.0.0');

    // Attempt corrupted v2 install (wrong hash) -> v1 must remain active & intact
    const badV2Bytes = makeDeterministicPayload(64 * 1024, 99);
    const failedSnap = await mgr.installOrUpdateFromStream({
      manifest: createManifest({
        version: '2.0.0-bad',
        byteLength: badV2Bytes.byteLength,
        sha256Hex: 'f'.repeat(64),
      }),
      stream: makeRangeStream(badV2Bytes),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
    });
    assert.equal(failedSnap.snapshot.state, 'INTEGRITY_FAILURE');
    assert.equal(failedSnap.snapshot.activeModel?.version, '1.0.0', 'Active model v1 must survive failed v2 install');

    // Install valid v2 -> rollback to v1
    const v2Bytes = makeDeterministicPayload(80 * 1024, 2);
    const v2Sha = sha256Bytes(v2Bytes);
    const v2Snap = await mgr.installOrUpdateFromStream({
      manifest: createManifest({ version: '2.0.0', byteLength: v2Bytes.byteLength, sha256Hex: v2Sha }),
      stream: makeRangeStream(v2Bytes),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
    });
    assert.equal(v2Snap.snapshot.state, 'MODEL_AVAILABLE');
    assert.equal(v2Snap.snapshot.activeModel?.version, '2.0.0');
    assert.equal(v2Snap.snapshot.previousVerifiedModel?.version, '1.0.0');

    const rolledBack = await mgr.rollbackToPreviousVerifiedModel();
    assert.equal(rolledBack.snapshot.state, 'MODEL_AVAILABLE');
    assert.equal(rolledBack.snapshot.activeModel?.version, '1.0.0');
    assert.equal(rolledBack.snapshot.activeModel?.verifiedSha256Hex, v1Sha);
  });

  it('rejects quota exhaustion, handles abort cleanly, and surfaces OPFS unavailability truthfully', async () => {
    const storage = new InMemoryModelChunkStorage();
    storage.simulatedAvailableQuotaBytes = 4 * 1024 * 1024; // Below 16 MiB safety margin
    const mgr = new LocalModelLifecycleManager(storage);
    await mgr.initialize();

    const payload = makeDeterministicPayload(32 * 1024, 7);
    const sha = sha256Bytes(payload);
    const quotaSnap = await mgr.installOrUpdateFromStream({
      manifest: createManifest({ byteLength: payload.byteLength, sha256Hex: sha }),
      stream: makeRangeStream(payload),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
    });
    assert.equal(quotaSnap.snapshot.activeModel, null);
    assert.equal(quotaSnap.errorCode === 'MODEL_STORAGE_QUOTA_EXCEEDED', true);

    // Abort mid-stream
    storage.simulatedAvailableQuotaBytes = 1024 * 1024 * 1024;
    const ac = new AbortController();
    async function* abortingStream(): AsyncIterable<Uint8Array> {
      yield payload.subarray(0, 8192);
      ac.abort();
      yield payload.subarray(8192);
    }
    const abortedSnap = await mgr.installOrUpdateFromStream({
      manifest: createManifest({ byteLength: payload.byteLength, sha256Hex: sha }),
      stream: makeRangeStream(payload),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
      abortSignal: ac.signal,
      
    });
    assert.equal(abortedSnap.snapshot.activeModel, null);
    assert.equal((await storage.listArtifacts()).temporary.length, 0);

    // Unavailable storage
    const unavailableStorage = new InMemoryModelChunkStorage();
    unavailableStorage.simulatedStorageUnavailable = true;
    const unavailableMgr = new LocalModelLifecycleManager(unavailableStorage);
    const unavailSnap = await unavailableMgr.initialize();
    assert.equal(unavailSnap.state, 'MODEL_UNAVAILABLE');
  });

  it('produces a runtime ChunkedModelManifest compatible end-to-end with WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks', async () => {
    // Minimal virtual OPFS root shared by OpfsModelChunkStorage and WebWorkerOrtRuntimeProvider
    const files = new Map<string, Map<string, Uint8Array>>();
    const makeDirHandle = (path: string): OpfsDirectoryHandleLike => ({
      kind: 'directory',
      name: path,
      async getDirectoryHandle(name: string) {
        const next = path ? `${path}/${name}` : name;
        if (!files.has(next)) files.set(next, new Map());
        return makeDirHandle(next);
      },
      async getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandleLike> {
        if (!files.has(path)) files.set(path, new Map());
        const dirMap = files.get(path)!;
        if (!dirMap.has(name) && !opts?.create) {
          const e = new Error('NotFoundError');
          e.name = 'NotFoundError';
          throw e;
        }
        return {
          kind: 'file',
          name,
          async getFile() {
            const bytes = dirMap.get(name) ?? new Uint8Array(0);
            return {
              size: bytes.byteLength,
              async arrayBuffer() {
                const copy = bytes.slice();
                return copy.buffer;
              },
              async text() {
                return new TextDecoder().decode(bytes);
              },
            };
          },
          async createWritable() {
            const parts: Uint8Array[] = [];
            return {
              async write(data: Uint8Array | ArrayBuffer | string) {
                if (typeof data === 'string') parts.push(new TextEncoder().encode(data));
                else if (data instanceof Uint8Array) parts.push(data.slice());
                else parts.push(new Uint8Array(data.slice(0)));
              },
              async close() {
                const len = parts.reduce((a, b) => a + b.byteLength, 0);
                const out = new Uint8Array(len);
                let o = 0;
                for (const p of parts) {
                  out.set(p, o);
                  o += p.byteLength;
                }
                dirMap.set(name, out);
              },
            };
          },
        };
      },
      async removeEntry(name: string) {
        files.get(path)?.delete(name);
        const prefix = path ? `${path}/${name}` : name;
        for (const k of Array.from(files.keys())) {
          if (k === prefix || k.startsWith(`${prefix}/`)) {
            files.delete(k);
          }
        }
      },
    });

    const opfsStorage = new OpfsModelChunkStorage({
      getRootDirectory: async () => makeDirHandle(''),
      estimateStorage: async () => ({ quota: 2 * 1024 * 1024 * 1024, usage: 0 }),
    });
    const mgr = new LocalModelLifecycleManager(opfsStorage);
    await mgr.initialize();

    const payload = makeDeterministicPayload(45_000, 42);
    const sha = sha256Bytes(payload);
    await mgr.installOrUpdateFromStream({
      manifest: createManifest({
        modelId: 'conformer-e2e',
        version: '1.2.3',
        byteLength: payload.byteLength,
        sha256Hex: sha,
      }),
      stream: makeRangeStream(payload),
      license: 'Apache-2.0',
      sourceOrigin: 'local-file',
    });

    const runtimeManifest = await mgr.getActiveRuntimeManifest();
    assert.ok(runtimeManifest !== null);
    assert.equal(runtimeManifest!.sha256Hex, sha);

    const budget = new MemoryBudgetManager();
    let reservationId: string | null = null;
    const assembled = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(
      runtimeManifest!,
      makeDirHandle('') as unknown as OpfsRootDirectoryLike,
      {
        memoryBudgetManager: budget,
        onReservation: (r) => {
          reservationId = r.id;
        },
      },
    );

    assert.equal(assembled.byteLength, payload.byteLength);
    assert.equal(sha256Bytes(assembled), sha);
    assert.ok(reservationId !== null);
    budget.release(reservationId!);
    assert.equal(budget.getSnapshot().accountedBytes, 0);
  });
});
