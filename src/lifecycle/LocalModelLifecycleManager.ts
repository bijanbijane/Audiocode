import {
  computeSha256Hex,
  LocalModelManifest,
  validateLocalModelManifest,
} from '../security/LocalPrivacyPolicy';

export type ModelLifecycleState =
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_AVAILABLE'
  | 'DOWNLOAD_PENDING'
  | 'DOWNLOAD_IN_PROGRESS'
  | 'DOWNLOAD_PAUSED'
  | 'DOWNLOAD_INTERRUPTED'
  | 'DOWNLOAD_RESUMED'
  | 'CHECKSUM_VERIFICATION'
  | 'INTEGRITY_FAILURE'
  | 'INSTALLATION_COMPLETED'
  | 'MODEL_LOADING'
  | 'MODEL_READY'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_INCOMPATIBLE'
  | 'MODEL_UPDATE_AVAILABLE'
  | 'MODEL_REMOVED';

export interface InstalledModelDescriptor {
  readonly modelId: string;
  readonly version: string;
  readonly architecture: 'FASTCONFORMER_CTC' | 'WHISPER_SEQ2SEQ';
  readonly supportedRuntime: 'onnxruntime-web/wasm' | 'onnxruntime-web/webgpu';
  readonly supportedExecutionProviders: readonly ('webgpu' | 'wasm')[];
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly verifiedSha256Hex: string;
  readonly license: string;
  readonly sourceOrigin: string;
  readonly compatibilityMinAppVersion: string;
  readonly installedAtMs: number;
}

export interface PartialModelDownloadRecord {
  readonly modelId: string;
  readonly version: string;
  readonly expectedByteLength: number;
  readonly expectedSha256Hex: string;
  readonly receivedBytes: number;
  readonly supportsRangeResume: boolean;
  readonly updatedAtMs: number;
}

export interface ModelChunkStorageAdapter {
  writeTempChunk(key: string, offset: number, chunk: Uint8Array): Promise<void> | void;
  readTempBytes(key: string): Promise<Uint8Array | null> | Uint8Array | null;
  deleteTemp(key: string): Promise<void> | void;
  promoteTempToInstalled(tempKey: string, installedKey: string): Promise<void> | void;
  hasInstalled(installedKey: string): Promise<boolean> | boolean;
  readInstalledBytes(installedKey: string): Promise<Uint8Array | null> | Uint8Array | null;
  deleteInstalled(installedKey: string): Promise<void> | void;
  listKeys(): Promise<{ readonly installed: string[]; readonly temp: string[] }> | { readonly installed: string[]; readonly temp: string[] };
  getAvailableQuotaBytes?(): Promise<number | null> | number | null;
}

export class InMemoryModelChunkStorage implements ModelChunkStorageAdapter {
  private readonly tempFiles = new Map<string, Uint8Array>();
  private readonly installedFiles = new Map<string, Uint8Array>();
  public simulatedAvailableQuotaBytes: number | null = null;

  public writeTempChunk(key: string, offset: number, chunk: Uint8Array): void {
    const existing = this.tempFiles.get(key) ?? new Uint8Array(0);
    const nextLen = Math.max(existing.byteLength, offset + chunk.byteLength);
    const merged = new Uint8Array(nextLen);
    merged.set(existing, 0);
    merged.set(chunk, offset);
    this.tempFiles.set(key, merged);
  }

  public readTempBytes(key: string): Uint8Array | null {
    const found = this.tempFiles.get(key);
    return found ? new Uint8Array(found) : null;
  }

  public deleteTemp(key: string): void {
    this.tempFiles.delete(key);
  }

  public promoteTempToInstalled(tempKey: string, installedKey: string): void {
    const data = this.tempFiles.get(tempKey);
    if (!data) throw new Error(`Temporary model artifact "${tempKey}" not found.`);
    this.installedFiles.set(installedKey, data);
    this.tempFiles.delete(tempKey);
  }

  public hasInstalled(installedKey: string): boolean {
    return this.installedFiles.has(installedKey);
  }

  public readInstalledBytes(installedKey: string): Uint8Array | null {
    const found = this.installedFiles.get(installedKey);
    return found ? new Uint8Array(found) : null;
  }

  public deleteInstalled(installedKey: string): void {
    this.installedFiles.delete(installedKey);
  }

  public listKeys() {
    return {
      installed: Array.from(this.installedFiles.keys()),
      temp: Array.from(this.tempFiles.keys()),
    };
  }

  public getAvailableQuotaBytes(): number | null {
    return this.simulatedAvailableQuotaBytes;
  }
}

export interface ModelDownloadChunkStream {
  readonly supportsRangeResume: boolean;
  fetchRange(startByte: number, endByteExclusive: number): Promise<Uint8Array>;
}

export interface LocalModelLifecycleSnapshot {
  readonly state: ModelLifecycleState;
  readonly activeModel: InstalledModelDescriptor | null;
  readonly previousVerifiedModel: InstalledModelDescriptor | null;
  readonly partialDownload: PartialModelDownloadRecord | null;
  readonly downloadProgressPct: number | null;
  readonly lastError: string | null;
}

/**
 * Local Model Installation, Resumable Download, Verification & Rollback Manager (AVP-P09-001)
 *
 * Guarantees:
 * - Never activates unverified model weights.
 * - Never overwrites a working model before a replacement passes SHA-256 verification.
 * - Supports resumable downloads, rollback to previous verified model, and safe partial cleanup.
 * - Model removal never touches user projects or exported files.
 */
export class LocalModelLifecycleManager {
  private readonly storage: ModelChunkStorageAdapter;
  private state: ModelLifecycleState = 'MODEL_NOT_INSTALLED';
  private activeModel: InstalledModelDescriptor | null = null;
  private previousVerifiedModel: InstalledModelDescriptor | null = null;
  private partialDownload: PartialModelDownloadRecord | null = null;
  private downloadProgressPct: number | null = null;
  private lastError: string | null = null;

  constructor(storage?: ModelChunkStorageAdapter) {
    this.storage = storage ?? new InMemoryModelChunkStorage();
  }

  public getSnapshot(): LocalModelLifecycleSnapshot {
    return Object.freeze({
      state: this.state,
      activeModel: this.activeModel ? { ...this.activeModel } : null,
      previousVerifiedModel: this.previousVerifiedModel ? { ...this.previousVerifiedModel } : null,
      partialDownload: this.partialDownload ? { ...this.partialDownload } : null,
      downloadProgressPct: this.downloadProgressPct,
      lastError: this.lastError,
    });
  }

  public async installOrUpdateFromStream(params: {
    readonly manifest: LocalModelManifest;
    readonly stream: ModelDownloadChunkStream;
    readonly license: string;
    readonly sourceOrigin: string;
    readonly chunkSizeBytes?: number;
    readonly abortSignal?: AbortSignal;
    readonly shouldPause?: () => boolean;
    readonly onProgress?: (pct: number, receivedBytes: number, totalBytes: number) => void;
    readonly nowMs?: number;
  }): Promise<{ readonly ok: boolean; readonly snapshot: LocalModelLifecycleSnapshot }> {
    const manifest = validateLocalModelManifest(params.manifest);
    const nowMs = params.nowMs ?? Date.now();
    const chunkSize = Math.max(1024, Math.trunc(params.chunkSizeBytes ?? 64 * 1024));
    const tempKey = `temp_${manifest.modelId}_${manifest.modelVersion}`;
    const installedKey = `model_${manifest.modelId}_${manifest.modelVersion}`;

    // Check storage quota before starting download
    const availableQuota = await this.storage.getAvailableQuotaBytes?.();
    if (typeof availableQuota === 'number' && availableQuota < manifest.expectedByteLength) {
      this.state = 'MODEL_UNAVAILABLE';
      this.lastError = `Insufficient storage quota (${availableQuota} B) for model (${manifest.expectedByteLength} B).`;
      return { ok: false, snapshot: this.getSnapshot() };
    }

    const existingTemp = await this.storage.readTempBytes(tempKey);
    const canResume = Boolean(
      existingTemp &&
        existingTemp.byteLength > 0 &&
        existingTemp.byteLength < manifest.expectedByteLength &&
        params.stream.supportsRangeResume,
    );

    let offset = canResume ? existingTemp!.byteLength : 0;
    if (!canResume && existingTemp) {
      await this.storage.deleteTemp(tempKey);
    }

    this.state = canResume ? 'DOWNLOAD_RESUMED' : 'DOWNLOAD_PENDING';
    this.lastError = null;
    this.partialDownload = {
      modelId: manifest.modelId,
      version: manifest.modelVersion,
      expectedByteLength: manifest.expectedByteLength,
      expectedSha256Hex: manifest.expectedSha256Hex,
      receivedBytes: offset,
      supportsRangeResume: params.stream.supportsRangeResume,
      updatedAtMs: nowMs,
    };

    try {
      this.state = 'DOWNLOAD_IN_PROGRESS';
      while (offset < manifest.expectedByteLength) {
        if (params.abortSignal?.aborted) {
          this.state = 'DOWNLOAD_INTERRUPTED';
          this.lastError = 'Model download interrupted/cancelled before completion.';
          return { ok: false, snapshot: this.getSnapshot() };
        }
        if (params.shouldPause?.()) {
          this.state = 'DOWNLOAD_PAUSED';
          this.partialDownload = {
            ...this.partialDownload,
            receivedBytes: offset,
            updatedAtMs: Date.now(),
          };
          return { ok: false, snapshot: this.getSnapshot() };
        }

        const end = Math.min(manifest.expectedByteLength, offset + chunkSize);
        const chunk = await params.stream.fetchRange(offset, end);
        if (chunk.byteLength === 0) {
          this.state = 'DOWNLOAD_INTERRUPTED';
          this.lastError = `Stream ended prematurely at ${offset}/${manifest.expectedByteLength} B.`;
          return { ok: false, snapshot: this.getSnapshot() };
        }

        await this.storage.writeTempChunk(tempKey, offset, chunk);
        offset += chunk.byteLength;
        const pct = Math.min(99, Math.round((offset / manifest.expectedByteLength) * 100));
        this.downloadProgressPct = pct;
        this.partialDownload = {
          ...this.partialDownload,
          receivedBytes: offset,
          updatedAtMs: Date.now(),
        };
        params.onProgress?.(pct, offset, manifest.expectedByteLength);
      }

      // Mandatory SHA-256 verification BEFORE promoting or replacing any active model
      this.state = 'CHECKSUM_VERIFICATION';
      const assembled = await this.storage.readTempBytes(tempKey);
      if (!assembled || assembled.byteLength !== manifest.expectedByteLength) {
        await this.storage.deleteTemp(tempKey);
        this.partialDownload = null;
        this.state = 'INTEGRITY_FAILURE';
        this.lastError = `Downloaded byte count (${assembled?.byteLength ?? 0}) != expected (${manifest.expectedByteLength}).`;
        return { ok: false, snapshot: this.getSnapshot() };
      }

      const actualHash = await computeSha256Hex(assembled);
      if (actualHash !== manifest.expectedSha256Hex) {
        await this.storage.deleteTemp(tempKey);
        this.partialDownload = null;
        this.state = 'INTEGRITY_FAILURE';
        this.lastError = `SHA-256 checksum mismatch: expected ${manifest.expectedSha256Hex}, actual ${actualHash}. Working model (if any) left untouched.`;
        return { ok: false, snapshot: this.getSnapshot() };
      }

      // Atomic promotion: keep previous verified model for rollback
      await this.storage.promoteTempToInstalled(tempKey, installedKey);
      if (this.activeModel) {
        this.previousVerifiedModel = this.activeModel;
      }

      this.activeModel = {
        modelId: manifest.modelId,
        version: manifest.modelVersion,
        architecture: manifest.architecture,
        supportedRuntime: 'onnxruntime-web/wasm',
        supportedExecutionProviders: ['wasm', 'webgpu'],
        fileName: manifest.fileName,
        fileSizeBytes: manifest.expectedByteLength,
        verifiedSha256Hex: actualHash,
        license: params.license || 'Unspecified — verify upstream license before commercial use',
        sourceOrigin: params.sourceOrigin || 'local-user-import',
        compatibilityMinAppVersion: '1.0.0',
        installedAtMs: nowMs,
      };
      this.partialDownload = null;
      this.downloadProgressPct = 100;
      this.state = 'INSTALLATION_COMPLETED';
      this.lastError = null;
      return { ok: true, snapshot: this.getSnapshot() };
    } catch (err) {
      this.state = 'DOWNLOAD_INTERRUPTED';
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, snapshot: this.getSnapshot() };
    }
  }

  public async verifyInstalledActiveModelOffline(): Promise<{
    readonly ok: boolean;
    readonly state: ModelLifecycleState;
    readonly error?: string;
  }> {
    if (!this.activeModel) {
      this.state = 'MODEL_NOT_INSTALLED';
      return { ok: false, state: this.state, error: 'No installed local model found.' };
    }
    const key = `model_${this.activeModel.modelId}_${this.activeModel.version}`;
    const bytes = await this.storage.readInstalledBytes(key);
    if (!bytes) {
      this.state = 'MODEL_UNAVAILABLE';
      this.lastError = 'Installed model artifact is missing from local storage.';
      return { ok: false, state: this.state, error: this.lastError };
    }
    const actualHash = await computeSha256Hex(bytes);
    if (actualHash !== this.activeModel.verifiedSha256Hex) {
      this.state = 'INTEGRITY_FAILURE';
      this.lastError = 'Stored model failed offline SHA-256 verification.';
      return { ok: false, state: this.state, error: this.lastError };
    }
    this.state = 'MODEL_READY';
    this.lastError = null;
    return { ok: true, state: this.state };
  }

  /** Rolls back to the previous verified model when available in local storage */
  public async rollbackToPreviousVerifiedModel(): Promise<{
    readonly ok: boolean;
    readonly snapshot: LocalModelLifecycleSnapshot;
  }> {
    if (!this.previousVerifiedModel) {
      this.lastError = 'No previous verified model is available for rollback.';
      return { ok: false, snapshot: this.getSnapshot() };
    }
    const prevKey = `model_${this.previousVerifiedModel.modelId}_${this.previousVerifiedModel.version}`;
    const exists = await this.storage.hasInstalled(prevKey);
    if (!exists) {
      this.lastError = 'Previous verified model weights are no longer present in storage.';
      return { ok: false, snapshot: this.getSnapshot() };
    }
    this.activeModel = this.previousVerifiedModel;
    this.previousVerifiedModel = null;
    this.state = 'MODEL_READY';
    this.lastError = null;
    return { ok: true, snapshot: this.getSnapshot() };
  }

  /** Removes an installed model without ever touching user projects or exported files */
  public async removeActiveModel(): Promise<{
    readonly ok: boolean;
    readonly userProjectsPreserved: true;
    readonly snapshot: LocalModelLifecycleSnapshot;
  }> {
    if (this.activeModel) {
      const key = `model_${this.activeModel.modelId}_${this.activeModel.version}`;
      await this.storage.deleteInstalled(key);
      this.activeModel = null;
    }
    this.state = 'MODEL_REMOVED';
    this.downloadProgressPct = null;
    return { ok: true, userProjectsPreserved: true, snapshot: this.getSnapshot() };
  }

  public async cleanupInvalidPartialDownloads(): Promise<number> {
    const keys = await this.storage.listKeys();
    let cleaned = 0;
    for (const tempKey of keys.temp) {
      await this.storage.deleteTemp(tempKey);
      cleaned++;
    }
    this.partialDownload = null;
    return cleaned;
  }
}
