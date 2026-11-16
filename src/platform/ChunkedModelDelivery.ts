/**
 * Chunked & Resumable Model Delivery System (PoC #4)
 * Splits large ASR/VAD models into 8-16MB SHA-256 verified chunks stored atomically in OPFS
 * (with in-memory fallback for non-OPFS contexts) so interrupted downloads resume from the exact next chunk.
 */

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
}

export interface ChunkDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  resumedChunks: number;
}

export class ChunkedModelDownloader {
  private memoryCache = new Map<string, ArrayBuffer>();

  public async downloadOrResumeModel(
    manifest: ChunkedModelManifest,
    onProgress: (progress: ChunkDownloadProgress) => void,
    abortSignal?: AbortSignal,
    customFetchFn?: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
  ): Promise<{ storageMode: 'OPFS' | 'Memory-Fallback'; completedChunks: number; resumedChunks: number }> {
    let modelDir: FileSystemDirectoryHandle | null = null;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && 'getDirectory' in navigator.storage) {
        const root = await navigator.storage.getDirectory();
        const modelsRoot = await root.getDirectoryHandle('ai-models', { create: true });
        modelDir = await modelsRoot.getDirectoryHandle(
          `${manifest.modelId}_${manifest.version}`,
          { create: true },
        );
      }
    } catch {
      modelDir = null;
    }

    let completedBytes = 0;
    let completedChunks = 0;
    let resumedChunks = 0;

    for (const chunk of manifest.chunks) {
      if (abortSignal?.aborted) throw new Error('MODEL_DOWNLOAD_CANCELLED');

      const chunkKey = `${manifest.modelId}_${manifest.version}/chunk_${String(chunk.index).padStart(4, '0')}.bin`;
      const chunkFileName = `chunk_${String(chunk.index).padStart(4, '0')}.bin`;

      const alreadyValid = modelDir
        ? await this.isChunkValidOpfs(modelDir, chunkFileName, chunk.byteLength)
        : this.memoryCache.get(chunkKey)?.byteLength === chunk.byteLength;

      if (alreadyValid) {
        completedBytes += chunk.byteLength;
        completedChunks++;
        resumedChunks++;
        onProgress({
          downloadedBytes: completedBytes,
          totalBytes: manifest.totalBytes,
          completedChunks,
          totalChunks: manifest.chunks.length,
          resumedChunks,
        });
        continue;
      }

      const buffer = customFetchFn
        ? await customFetchFn(chunk.url, abortSignal)
        : await this.fetchChunkWithRetry(chunk.url, 3, abortSignal);

      const isValidHash = await this.verifySha256(buffer, chunk.sha256Hex);
      if (!isValidHash) {
        throw new Error(`MODEL_CHUNK_HASH_MISMATCH: chunk #${chunk.index}`);
      }

      if (modelDir) {
        const fileHandle = await modelDir.getFileHandle(chunkFileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(buffer);
        await writable.close();
      } else {
        this.memoryCache.set(chunkKey, buffer);
      }

      completedBytes += chunk.byteLength;
      completedChunks++;
      onProgress({
        downloadedBytes: completedBytes,
        totalBytes: manifest.totalBytes,
        completedChunks,
        totalChunks: manifest.chunks.length,
        resumedChunks,
      });
    }

    return {
      storageMode: modelDir ? 'OPFS' : 'Memory-Fallback',
      completedChunks,
      resumedChunks,
    };
  }

  private async isChunkValidOpfs(
    dir: FileSystemDirectoryHandle,
    fileName: string,
    expectedSize: number,
  ): Promise<boolean> {
    try {
      const handle = await dir.getFileHandle(fileName, { create: false });
      const file = await handle.getFile();
      return file.size === expectedSize;
    } catch {
      return false;
    }
  }

  private async fetchChunkWithRetry(
    url: string,
    maxRetries: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        return await res.arrayBuffer();
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
      }
    }
    throw lastError;
  }

  public async verifySha256(buffer: ArrayBuffer, expectedHex: string): Promise<boolean> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const actualHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return actualHex.toLowerCase() === expectedHex.toLowerCase();
  }
}
