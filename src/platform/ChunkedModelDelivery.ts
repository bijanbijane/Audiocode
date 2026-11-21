/**
 * Chunked & Resumable Model Delivery System (AVP-P0-001 Work Package B & AVP-P0-002 §6)
 *
 * Production-hardened chunked artifact installer:
 * - Bounded concurrency (`maxConcurrency`, default 2, max 6)
 * - Configurable retry policy with exponential backoff + jitter
 * - Cooperative `AbortSignal` cancellation with partial cleanup option
 * - Storage quota & capacity preflight validation
 * - Path traversal & unbounded download size rejection
 * - Per-chunk SHA-256 verification + complete-artifact incremental SHA-256 verification
 * - Duplicate concurrent installation prevention per `modelId@version`
 * - Atomic staging -> manifest commit (never exposes partial downloads as executable)
 */

import {
  computeRequiredModelQuotaBytes,
  formatModelChunkFileName,
  MAX_SAFE_MODEL_FILE_BYTES,
  ModelRepositoryError,
  StoredModelArtifactManifest,
  validateModelPathSegment,
  validateStoredModelArtifactManifest,
} from '../lifecycle/ModelRepositoryContracts';
import { IncrementalSha256 } from '../utils/StreamingSha256';

export interface ModelChunkDescriptor {
  readonly index: number;
  readonly url: string;
  readonly sha256Hex: string;
  readonly byteLength: number;
}

export interface ChunkedModelManifest {
  readonly modelId: string;
  readonly version: string;
  readonly totalBytes: number;
  readonly chunks: ModelChunkDescriptor[];
  readonly storageDirectory?: string;
  readonly sha256Hex?: string;
}

/**
 * Generates a runtime-consumable ChunkedModelManifest from a committed OPFS
 * StoredModelArtifactManifest, preserving exact chunk order, sizes, and digests.
 */
export function createChunkedModelManifestFromStoredArtifact(
  manifest: StoredModelArtifactManifest,
): ChunkedModelManifest {
  const validated = validateStoredModelArtifactManifest(manifest);
  return {
    modelId: validated.modelId,
    version: validated.version,
    totalBytes: validated.totalBytes,
    storageDirectory: validated.storageDirectory,
    sha256Hex: validated.sha256Hex,
    chunks: validated.chunks.map((c) => ({
      index: c.index,
      url: `opfs://ai-models/${validated.storageDirectory}/${formatModelChunkFileName(c.index)}`,
      sha256Hex: c.sha256Hex,
      byteLength: c.byteLength,
    })),
  };
}

export interface ChunkDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  resumedChunks: number;
  failedAttempts?: number;
}

export interface ChunkDownloadRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface ChunkedDownloadOptions {
  readonly maxConcurrency?: number;
  readonly retryPolicy?: Partial<ChunkDownloadRetryPolicy>;
  readonly availableQuotaBytes?: number | null;
  readonly cleanupOnCancel?: boolean;
  readonly allowMemoryFallback?: boolean;
  readonly randomFn?: () => number;
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_RETRY_POLICY: ChunkDownloadRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  jitterRatio: 0.25,
};

const SHA256_RE = /^[a-f0-9]{64}$/;

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('MODEL_DOWNLOAD_CANCELLED'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function computeBackoffWithJitterMs(
  attempt: number,
  policy: ChunkDownloadRetryPolicy,
  randomFn: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, Math.max(0, attempt)));
  const jitterSpan = exp * Math.max(0, Math.min(1, policy.jitterRatio));
  const jitter = (randomFn() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(exp + jitter));
}

export class ChunkedModelDownloader {
  private readonly memoryStaging = new Map<string, Map<number, Uint8Array>>();
  private readonly memoryCommitted = new Map<string, Map<number, Uint8Array>>();
  private readonly activeInstalls = new Set<string>();

  public async downloadOrResumeModel(
    manifest: ChunkedModelManifest,
    onProgress: (progress: ChunkDownloadProgress) => void,
    abortSignal?: AbortSignal,
    customFetchFn?: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
    options?: ChunkedDownloadOptions,
  ): Promise<{
    storageMode: 'OPFS' | 'Memory-Fallback';
    completedChunks: number;
    resumedChunks: number;
    verifiedFullSha256Hex: string;
    committedDirectory: string;
  }> {
    const safeModelId = validateModelPathSegment(manifest.modelId, 'modelId');
    const safeVersion = validateModelPathSegment(manifest.version, 'version');
    const dirName = validateModelPathSegment(
      manifest.storageDirectory ?? `${safeModelId}_${safeVersion}`,
      'storageDirectory',
    );
    const installKey = `${safeModelId}@${safeVersion}`;

    if (this.activeInstalls.has(installKey)) {
      throw new ModelRepositoryError(
        'MODEL_WRITE_FAILED',
        `DUPLICATE_INSTALL_IN_PROGRESS: Installation for "${installKey}" is already active.`,
      );
    }

    // Validate manifest integrity & bounds before writing anything
    if (
      !Number.isSafeInteger(manifest.totalBytes) ||
      manifest.totalBytes <= 0 ||
      manifest.totalBytes > MAX_SAFE_MODEL_FILE_BYTES
    ) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Invalid totalBytes (${manifest.totalBytes}); must be between 1 and ${MAX_SAFE_MODEL_FILE_BYTES}.`,
      );
    }
    if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
      throw new ModelRepositoryError('MODEL_MANIFEST_INVALID', 'Manifest chunks must be non-empty.');
    }

    let declaredSum = 0;
    for (let i = 0; i < manifest.chunks.length; i++) {
      const c = manifest.chunks[i];
      if (c.index !== i) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Chunk manifest index mismatch at position ${i}: received ${c.index}.`,
        );
      }
      if (!Number.isSafeInteger(c.byteLength) || c.byteLength <= 0) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Chunk #${i} has invalid byteLength ${c.byteLength}.`,
        );
      }
      if (typeof c.sha256Hex !== 'string' || !SHA256_RE.test(c.sha256Hex.toLowerCase())) {
        throw new ModelRepositoryError(
          'MODEL_MANIFEST_INVALID',
          `Chunk #${i} has invalid SHA-256 digest.`,
        );
      }
      declaredSum += c.byteLength;
    }
    if (declaredSum !== manifest.totalBytes) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        `Manifest chunk byte sum (${declaredSum}) !== totalBytes (${manifest.totalBytes}).`,
      );
    }
    if (manifest.sha256Hex && !SHA256_RE.test(manifest.sha256Hex.toLowerCase())) {
      throw new ModelRepositoryError(
        'MODEL_MANIFEST_INVALID',
        'Manifest full-artifact sha256Hex must be a valid 64-char hex digest.',
      );
    }

    // Storage quota preflight validation
    const requiredQuota = computeRequiredModelQuotaBytes(manifest.totalBytes);
    let availableQuota: number | null = options?.availableQuotaBytes ?? null;
    if (
      availableQuota === null &&
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
    ) {
      try {
        const est = await navigator.storage.estimate();
        if (typeof est.quota === 'number' && typeof est.usage === 'number') {
          availableQuota = Math.max(0, est.quota - est.usage);
        }
      } catch {
        availableQuota = null;
      }
    }
    if (availableQuota !== null && availableQuota < requiredQuota) {
      throw new ModelRepositoryError(
        'MODEL_STORAGE_QUOTA_EXCEEDED',
        `Insufficient storage quota: need ${requiredQuota} B, available ${availableQuota} B.`,
      );
    }

    const retryPolicy: ChunkDownloadRetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...(options?.retryPolicy ?? {}),
    };
    const maxConcurrency = Math.max(1, Math.min(6, Math.floor(options?.maxConcurrency ?? 2)));
    const sleepFn = options?.sleepFn ?? defaultSleep;
    const randomFn = options?.randomFn ?? Math.random;

    this.activeInstalls.add(installKey);

    const stagingDirName = `${dirName}.staging`;
    let modelsRoot: FileSystemDirectoryHandle | null = null;
    let stagingDir: FileSystemDirectoryHandle | null = null;

    try {
      if (typeof navigator !== 'undefined' && navigator.storage && 'getDirectory' in navigator.storage) {
        const root = await navigator.storage.getDirectory();
        modelsRoot = await root.getDirectoryHandle('ai-models', { create: true });
        stagingDir = await modelsRoot.getDirectoryHandle(stagingDirName, { create: true });
      }
    } catch {
      modelsRoot = null;
      stagingDir = null;
    }

    if (!stagingDir && options?.allowMemoryFallback === false) {
      this.activeInstalls.delete(installKey);
      throw new ModelRepositoryError(
        'MODEL_STORAGE_UNAVAILABLE',
        'OPFS storage is unavailable and memory fallback is disabled.',
      );
    }

    let memStagingBucket = this.memoryStaging.get(stagingDirName);
    if (!stagingDir && !memStagingBucket) {
      memStagingBucket = new Map<number, Uint8Array>();
      this.memoryStaging.set(stagingDirName, memStagingBucket);
    }

    let completedBytes = 0;
    let completedChunks = 0;
    let resumedChunks = 0;
    let failedAttempts = 0;

    const emitProgress = () => {
      onProgress({
        downloadedBytes: completedBytes,
        totalBytes: manifest.totalBytes,
        completedChunks,
        totalChunks: manifest.chunks.length,
        resumedChunks,
        failedAttempts,
      });
    };

    try {
      // Phase 1: Check already-verified staged chunks for deterministic resume
      const chunksToDownload: ModelChunkDescriptor[] = [];
      for (const chunk of manifest.chunks) {
        if (abortSignal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');
        const chunkFileName = formatModelChunkFileName(chunk.index);
        const alreadyValid = stagingDir
          ? await this.isChunkValidOpfs(stagingDir, chunkFileName, chunk.byteLength, chunk.sha256Hex)
          : await this.isChunkValidMemory(memStagingBucket!, chunk.index, chunk.byteLength, chunk.sha256Hex);

        if (alreadyValid) {
          completedBytes += chunk.byteLength;
          completedChunks++;
          resumedChunks++;
          emitProgress();
        } else {
          chunksToDownload.push(chunk);
        }
      }

      // Phase 2: Bounded-concurrency resumable chunk downloads with exponential backoff + jitter
      let cursor = 0;
      const runWorker = async (): Promise<void> => {
        while (cursor < chunksToDownload.length) {
          if (abortSignal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');
          const chunk = chunksToDownload[cursor++];
          const chunkFileName = formatModelChunkFileName(chunk.index);

          const buffer = await this.fetchChunkWithRetry(
            chunk.url,
            retryPolicy,
            abortSignal,
            customFetchFn,
            () => {
              failedAttempts++;
            },
            sleepFn,
            randomFn,
          );

          if (abortSignal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');

          if (buffer.byteLength !== chunk.byteLength) {
            throw new ModelRepositoryError(
              'MODEL_INTEGRITY_FAILURE',
              `MODEL_CHUNK_SIZE_MISMATCH: chunk #${chunk.index} expected ${chunk.byteLength} B, got ${buffer.byteLength} B.`,
            );
          }

          const isValidHash = await this.verifySha256(buffer, chunk.sha256Hex);
          if (!isValidHash) {
            throw new ModelRepositoryError(
              'MODEL_INTEGRITY_FAILURE',
              `MODEL_CHUNK_HASH_MISMATCH: chunk #${chunk.index}`,
            );
          }

          if (stagingDir) {
            const fileHandle = await stagingDir.getFileHandle(chunkFileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(buffer);
            await writable.close();
          } else {
            memStagingBucket!.set(chunk.index, new Uint8Array(buffer));
          }

          completedBytes += chunk.byteLength;
          completedChunks++;
          emitProgress();
        }
      };

      const workerCount = Math.min(maxConcurrency, Math.max(1, chunksToDownload.length));
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

      if (abortSignal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');

      // Phase 3: Full-artifact incremental SHA-256 verification before atomic commit
      const fullHasher = new IncrementalSha256();
      let verifiedTotal = 0;
      for (const chunk of manifest.chunks) {
        const chunkFileName = formatModelChunkFileName(chunk.index);
        let bytes: Uint8Array;
        if (stagingDir) {
          const handle = await stagingDir.getFileHandle(chunkFileName, { create: false });
          const file = await handle.getFile();
          bytes = new Uint8Array(await file.arrayBuffer());
        } else {
          const mem = memStagingBucket!.get(chunk.index);
          if (!mem) {
            throw new ModelRepositoryError(
              'MODEL_INTEGRITY_FAILURE',
              `Missing staged chunk #${chunk.index} during full verification.`,
            );
          }
          bytes = mem;
        }
        if (bytes.byteLength !== chunk.byteLength) {
          throw new ModelRepositoryError(
            'MODEL_INTEGRITY_FAILURE',
            `Staged chunk #${chunk.index} length mismatch during full verification.`,
          );
        }
        fullHasher.update(bytes);
        verifiedTotal += bytes.byteLength;
      }

      if (verifiedTotal !== manifest.totalBytes) {
        throw new ModelRepositoryError(
          'MODEL_INTEGRITY_FAILURE',
          `Verified total bytes (${verifiedTotal}) !== manifest totalBytes (${manifest.totalBytes}).`,
        );
      }

      const verifiedFullSha256Hex = fullHasher.digestHex();
      if (manifest.sha256Hex && verifiedFullSha256Hex !== manifest.sha256Hex.toLowerCase()) {
        throw new ModelRepositoryError(
          'MODEL_INTEGRITY_FAILURE',
          `FULL_ARTIFACT_HASH_MISMATCH: expected ${manifest.sha256Hex.toLowerCase()}, actual ${verifiedFullSha256Hex}.`,
        );
      }

      // Phase 4: Atomic commit from staging -> committed directory
      if (modelsRoot && stagingDir) {
        const finalDir = await modelsRoot.getDirectoryHandle(dirName, { create: true });
        for (const chunk of manifest.chunks) {
          const chunkFileName = formatModelChunkFileName(chunk.index);
          const srcHandle = await stagingDir.getFileHandle(chunkFileName, { create: false });
          const srcFile = await srcHandle.getFile();
          const dstHandle = await finalDir.getFileHandle(chunkFileName, { create: true });
          const writable = await dstHandle.createWritable();
          await writable.write(await srcFile.arrayBuffer());
          await writable.close();
        }
        try {
          await modelsRoot.removeEntry(stagingDirName, { recursive: true });
        } catch {
          // best-effort staging cleanup
        }
      } else {
        const committed = new Map<number, Uint8Array>();
        for (const [k, v] of memStagingBucket!.entries()) {
          committed.set(k, new Uint8Array(v));
        }
        this.memoryCommitted.set(dirName, committed);
        this.memoryStaging.delete(stagingDirName);
      }

      return {
        storageMode: stagingDir ? 'OPFS' : 'Memory-Fallback',
        completedChunks,
        resumedChunks,
        verifiedFullSha256Hex,
        committedDirectory: dirName,
      };
    } catch (err) {
      const cancelled =
        abortSignal?.aborted ||
        (err instanceof Error && err.message === 'MODEL_DOWNLOAD_CANCELLED');
      if (cancelled && options?.cleanupOnCancel) {
        await this.cleanupStaging(modelsRoot, stagingDirName);
      }
      throw err;
    } finally {
      this.activeInstalls.delete(installKey);
    }
  }

  public async cleanupStaging(
    modelsRoot: FileSystemDirectoryHandle | null,
    stagingDirName: string,
  ): Promise<void> {
    this.memoryStaging.delete(stagingDirName);
    if (modelsRoot) {
      try {
        await modelsRoot.removeEntry(stagingDirName, { recursive: true });
      } catch {
        // ignore missing staging directory
      }
    }
  }

  public getCommittedMemoryChunks(storageDirectory: string): ReadonlyMap<number, Uint8Array> | null {
    return this.memoryCommitted.get(storageDirectory) ?? null;
  }

  public hasStagingArtifacts(storageDirectory: string): boolean {
    return this.memoryStaging.has(`${storageDirectory}.staging`);
  }

  private async isChunkValidMemory(
    bucket: Map<number, Uint8Array>,
    index: number,
    expectedSize: number,
    expectedSha256Hex: string,
  ): Promise<boolean> {
    const existing = bucket.get(index);
    if (!existing || existing.byteLength !== expectedSize) return false;
    const digest = new IncrementalSha256().update(existing).digestHex();
    return digest === expectedSha256Hex.toLowerCase();
  }

  private async isChunkValidOpfs(
    dir: FileSystemDirectoryHandle,
    fileName: string,
    expectedSize: number,
    expectedSha256Hex: string,
  ): Promise<boolean> {
    try {
      const handle = await dir.getFileHandle(fileName, { create: false });
      const file = await handle.getFile();
      if (file.size !== expectedSize) return false;
      const buf = await file.arrayBuffer();
      return await this.verifySha256(buf, expectedSha256Hex);
    } catch {
      return false;
    }
  }

  private async fetchChunkWithRetry(
    url: string,
    policy: ChunkDownloadRetryPolicy,
    signal: AbortSignal | undefined,
    customFetchFn: ((url: string, signal?: AbortSignal) => Promise<ArrayBuffer>) | undefined,
    onRetryFail: () => void,
    sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
    randomFn: () => number,
  ): Promise<ArrayBuffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');
      try {
        if (customFetchFn) {
          return await customFetchFn(url, signal);
        }
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        return await res.arrayBuffer();
      } catch (err) {
        lastError = err;
        onRetryFail();
        if (signal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');
        if (attempt < policy.maxRetries) {
          const delayMs = computeBackoffWithJitterMs(attempt, policy, randomFn);
          await sleepFn(delayMs, signal);
        }
      }
    }
    throw lastError;
  }

  public async verifySha256(buffer: ArrayBuffer, expectedHex: string): Promise<boolean> {
    const actualHex = new IncrementalSha256().update(new Uint8Array(buffer)).digestHex();
    return actualHex.toLowerCase() === expectedHex.toLowerCase();
  }
}
