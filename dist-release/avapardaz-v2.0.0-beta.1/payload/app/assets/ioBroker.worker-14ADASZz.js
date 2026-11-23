// src/runtime/memory/MemoryPolicy.ts
/**
* Centralized application-managed memory policy and audio-cache split constants
* for Avapardaz local-first runtime discipline.
*
* NOTE: These constants govern application-managed memory accounting and admission
* thresholds. They do NOT guarantee a browser-process-wide, GPU, OS, or
* browser-internal decoded-media RAM ceiling of 1 GiB.
*/
const AVAPARDAZ_MEMORY_POLICY = {
	hardLimitBytes: 1073741824,
	targetBytes: 891289600,
	throttleBytes: 943718400,
	emergencyBytes: 996147200,
	audioCacheBytes: 33554432
};
const AVAPARDAZ_AUDIO_CACHE_SPLIT = {
	mainThreadBytes: 25165824,
	workerFallbackBytes: 8388608,
	combinedMaxBytes: AVAPARDAZ_MEMORY_POLICY.audioCacheBytes
};
if (AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes + AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes !== AVAPARDAZ_MEMORY_POLICY.audioCacheBytes) throw new Error("AVAPARDAZ_AUDIO_CACHE_SPLIT must sum to AVAPARDAZ_MEMORY_POLICY.audioCacheBytes");
// src/engine/workerStorageCore.ts
var StorageQuotaExceededError = class extends Error {
	constructor(message = "ظرفیت ذخیره‌سازی محلی مرورگر (OPFS Quota) تکمیل شده است.", cause) {
		super(message);
		this.code = "STORAGE_QUOTA_EXCEEDED";
		this.name = "StorageQuotaExceededError";
		if (cause !== void 0) this.cause = cause;
	}
};
function isQuotaExceededError(err) {
	if (!err || typeof err !== "object") return false;
	const rec = err;
	if (rec.name === "QuotaExceededError" || rec.code === "STORAGE_QUOTA_EXCEEDED") return true;
	if (typeof rec.message === "string" && /quota/i.test(rec.message)) return true;
	return false;
}
const ASSETS_ROOT_DIR = "avapardaz-assets";
const ASSET_MANIFEST_FILE = "manifest.json";
/**
* Strictly byte-bounded LRU cache for Worker-local ArrayBuffer blocks.
* Never claims durable persistence; used only when explicitly budgeted (<= 8 MiB).
*/
var BoundedWorkerBufferCache = class {
	constructor(maxBytes) {
		this.usedBytes = 0;
		this.hits = 0;
		this.misses = 0;
		this.evictions = 0;
		this.map = /* @__PURE__ */ new Map();
		if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes) throw new RangeError(`Worker cache budget must be an integer in [1, ${AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes}] bytes, got ${String(maxBytes)}`);
		this.maxBytes = maxBytes;
	}
	get(key) {
		const existing = this.map.get(key);
		if (!existing) {
			this.misses++;
			return null;
		}
		this.hits++;
		this.map.delete(key);
		this.map.set(key, existing);
		return existing;
	}
	put(key, buffer) {
		if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= 0) return false;
		if (buffer.byteLength > this.maxBytes) return false;
		const prev = this.map.get(key);
		if (prev) {
			this.usedBytes = Math.max(0, this.usedBytes - prev.byteLength);
			this.map.delete(key);
		}
		while (this.usedBytes + buffer.byteLength > this.maxBytes && this.map.size > 0) {
			const oldestKey = this.map.keys().next().value;
			if (oldestKey === void 0) break;
			const oldest = this.map.get(oldestKey);
			this.map.delete(oldestKey);
			if (oldest) {
				this.usedBytes = Math.max(0, this.usedBytes - oldest.byteLength);
				this.evictions++;
			}
		}
		this.map.set(key, buffer.slice(0));
		this.usedBytes += buffer.byteLength;
		return true;
	}
	delete(key) {
		const prev = this.map.get(key);
		if (prev) {
			this.usedBytes = Math.max(0, this.usedBytes - prev.byteLength);
			this.map.delete(key);
		}
	}
	deleteByPrefix(prefix) {
		let deleted = 0;
		for (const key of Array.from(this.map.keys())) if (key.startsWith(prefix)) {
			this.delete(key);
			deleted++;
		}
		return deleted;
	}
	clear() {
		this.map.clear();
		this.usedBytes = 0;
	}
	getStats() {
		return {
			maxBytes: this.maxBytes,
			usedBytes: this.usedBytes,
			cachedBlocks: this.map.size,
			hits: this.hits,
			misses: this.misses,
			evictions: this.evictions
		};
	}
};
var WorkerStorageCore = class {
	constructor(getOpfsDirectoryFn) {
		this.getOpfsDirectoryFn = getOpfsDirectoryFn;
		this.activeLeases = /* @__PURE__ */ new Map();
		this.keyMutexTails = /* @__PURE__ */ new Map();
		this.lockConflictsPrevented = 0;
		this.opfsAvailable = false;
		this.syncHandleAvailable = false;
		this.rootDir = null;
		this.boundedWorkerCache = null;
		this.fallbackManifests = /* @__PURE__ */ new Map();
	}
	async runWithKeyMutex(mutexKey, fn, onContention) {
		const prevTail = this.keyMutexTails.get(mutexKey);
		if (prevTail) onContention?.();
		let releaseCurrent;
		const currentGate = new Promise((resolve) => {
			releaseCurrent = resolve;
		});
		const nextTail = (prevTail ?? Promise.resolve()).then(() => currentGate);
		this.keyMutexTails.set(mutexKey, nextTail);
		if (prevTail) await prevTail.catch(() => {});
		try {
			return await fn();
		} finally {
			releaseCurrent();
			if (this.keyMutexTails.get(mutexKey) === nextTail) this.keyMutexTails.delete(mutexKey);
		}
	}
	async init(workerCacheMaxBytes = 0) {
		if (typeof workerCacheMaxBytes !== "number" || !Number.isSafeInteger(workerCacheMaxBytes) || workerCacheMaxBytes < 0 || workerCacheMaxBytes > AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes || workerCacheMaxBytes > AVAPARDAZ_MEMORY_POLICY.audioCacheBytes) throw new RangeError(`workerCacheMaxBytes must be in [0, ${AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes}] bytes`);
		this.boundedWorkerCache = workerCacheMaxBytes > 0 ? new BoundedWorkerBufferCache(workerCacheMaxBytes) : null;
		this.opfsAvailable = false;
		this.syncHandleAvailable = false;
		this.rootDir = null;
		try {
			const dir = this.getOpfsDirectoryFn ? await this.getOpfsDirectoryFn() : typeof navigator !== "undefined" && navigator.storage && "getDirectory" in navigator.storage ? await navigator.storage.getDirectory() : null;
			if (dir) {
				this.rootDir = dir;
				this.opfsAvailable = true;
				const probeHandle = await dir.getFileHandle("__avapardaz_probe.bin", { create: true });
				if (typeof probeHandle.createSyncAccessHandle === "function") {
					(await probeHandle.createSyncAccessHandle()).close();
					this.syncHandleAvailable = true;
				}
				await dir.removeEntry("__avapardaz_probe.bin").catch(() => {});
			}
		} catch {
			this.opfsAvailable = false;
			this.syncHandleAvailable = false;
			this.rootDir = null;
		}
		return {
			opfsAvailable: this.opfsAvailable,
			syncHandleAvailable: this.syncHandleAvailable,
			lockConflictsPrevented: this.lockConflictsPrevented,
			leases: Array.from(this.activeLeases.values()),
			workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
		};
	}
	sanitizeName(fileKey) {
		return fileKey.replace(/[^a-zA-Z0-9._-]/g, "_");
	}
	acquireLease(fileKey, ownerWorker) {
		const existing = this.activeLeases.get(fileKey);
		if (existing && existing.status === "active") this.lockConflictsPrevented++;
		const lease = {
			leaseId: `lease-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			fileKey,
			ownerWorker,
			mode: this.syncHandleAvailable ? "exclusive-broker" : "read-buffered",
			acquiredAt: Date.now(),
			status: "active"
		};
		this.activeLeases.set(fileKey, lease);
		return lease;
	}
	releaseLease(fileKey, leaseId) {
		const lease = this.activeLeases.get(fileKey);
		if (lease && (!leaseId || lease.leaseId === leaseId)) lease.status = "released";
	}
	async getAssetsRootDir(create) {
		if (!this.opfsAvailable || !this.rootDir) return null;
		if (typeof this.rootDir.getDirectoryHandle === "function") try {
			return await this.rootDir.getDirectoryHandle(ASSETS_ROOT_DIR, { create });
		} catch {
			return null;
		}
		return this.rootDir;
	}
	async getAssetDir(assetId, create) {
		const assetsRoot = await this.getAssetsRootDir(create);
		if (!assetsRoot) return null;
		const safeAssetId = this.sanitizeName(assetId);
		if (typeof assetsRoot.getDirectoryHandle === "function") try {
			return await assetsRoot.getDirectoryHandle(safeAssetId, { create });
		} catch {
			return null;
		}
		return assetsRoot;
	}
	assetFileName(assetId, fileName, hasSubdirs) {
		return hasSubdirs ? fileName : `${this.sanitizeName(assetId)}__${fileName}`;
	}
	hasHierarchicalSubdirs() {
		return Boolean(this.rootDir && typeof this.rootDir.getDirectoryHandle === "function");
	}
	async writeBytesToFileHandle(fh, bytes) {
		if (this.syncHandleAvailable && typeof fh.createSyncAccessHandle === "function") {
			const sync = await fh.createSyncAccessHandle();
			try {
				sync.truncate(0);
				sync.write(bytes, { at: 0 });
				sync.flush();
				return "OPFS-SyncAccessHandle";
			} finally {
				sync.close();
			}
		}
		if (typeof fh.createWritable === "function") {
			const writable = await fh.createWritable();
			try {
				const copy = bytes.slice().buffer;
				await writable.write(copy);
				await writable.close();
				return "OPFS-Writable";
			} catch (err) {
				await writable.close().catch(() => {});
				throw err;
			}
		}
		return "OPFS-Unavailable";
	}
	async readBytesFromFileHandle(fh) {
		if (this.syncHandleAvailable && typeof fh.createSyncAccessHandle === "function") {
			const sync = await fh.createSyncAccessHandle();
			try {
				const size = sync.getSize();
				const out = new Uint8Array(size);
				sync.read(out, { at: 0 });
				return out.buffer;
			} finally {
				sync.close();
			}
		}
		return (await fh.getFile()).arrayBuffer();
	}
	async readManifestRaw(assetId) {
		const safeAssetId = this.sanitizeName(assetId);
		return this.runWithKeyMutex(`manifest:${safeAssetId}`, async () => {
			if (this.opfsAvailable && this.rootDir) {
				const dir = await this.getAssetDir(safeAssetId, false);
				if (!dir) return null;
				const manifestName = this.assetFileName(safeAssetId, ASSET_MANIFEST_FILE, this.hasHierarchicalSubdirs());
				try {
					const fh = await dir.getFileHandle(manifestName, { create: false });
					const buf = await this.readBytesFromFileHandle(fh);
					const text = new TextDecoder().decode(new Uint8Array(buf));
					return JSON.parse(text);
				} catch {
					return null;
				}
			}
			return this.fallbackManifests.get(safeAssetId) ?? null;
		});
	}
	async writeManifestRaw(manifest) {
		const safeAssetId = this.sanitizeName(manifest.assetId);
		await this.runWithKeyMutex(`manifest:${safeAssetId}`, async () => {
			if (this.opfsAvailable && this.rootDir) {
				const dir = await this.getAssetDir(safeAssetId, true);
				if (!dir) throw new Error(`OPFS directory unavailable for asset ${safeAssetId}`);
				const manifestName = this.assetFileName(safeAssetId, ASSET_MANIFEST_FILE, this.hasHierarchicalSubdirs());
				try {
					const fh = await dir.getFileHandle(manifestName, { create: true });
					const encoded = new TextEncoder().encode(JSON.stringify(manifest));
					await this.writeBytesToFileHandle(fh, encoded);
				} catch (err) {
					if (isQuotaExceededError(err)) throw new StorageQuotaExceededError(void 0, err);
					throw err;
				}
			}
			this.fallbackManifests.set(safeAssetId, manifest);
		});
	}
	async beginAssetIngest(manifest) {
		const safeAssetId = this.sanitizeName(manifest.assetId);
		return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, async () => {
			const initialManifest = {
				...manifest,
				assetId: safeAssetId,
				state: "ingesting",
				updatedAtMs: Date.now(),
				finalizedAtMs: null
			};
			try {
				await this.writeManifestRaw(initialManifest);
				const backend = this.opfsAvailable ? this.syncHandleAvailable ? "OPFS-SyncAccessHandle" : "OPFS-Writable" : "OPFS-Unavailable";
				return {
					manifest: initialManifest,
					persisted: this.opfsAvailable,
					backend
				};
			} catch (err) {
				if (isQuotaExceededError(err)) {
					this.boundedWorkerCache?.clear();
					throw new StorageQuotaExceededError(void 0, err);
				}
				throw err;
			}
		});
	}
	async writeAssetChunk(assetId, chunkIndex, ownerWorker, buffer) {
		const safeAssetId = this.sanitizeName(assetId);
		const manifest = await this.readManifestRaw(safeAssetId);
		if (!manifest || manifest.state !== "ingesting" && manifest.state !== "ready") throw new Error(`ASSET_INVALID_LIFECYCLE_WRITE: Asset ${safeAssetId} is not in ingesting/ready state (${manifest?.state ?? "missing"}).`);
		const leaseKey = `${safeAssetId}:blk_${chunkIndex}`;
		return this.runWithKeyMutex(`chunk:${leaseKey}`, async () => {
			const lease = this.acquireLease(leaseKey, ownerWorker);
			try {
				const chunkFile = `blk_${chunkIndex}.f32`;
				if (this.opfsAvailable && this.rootDir) {
					const dir = await this.getAssetDir(safeAssetId, true);
					if (dir) {
						const targetName = this.assetFileName(safeAssetId, chunkFile, this.hasHierarchicalSubdirs());
						try {
							const fh = await dir.getFileHandle(targetName, { create: true });
							const backend = await this.writeBytesToFileHandle(fh, new Uint8Array(buffer));
							return {
								bytesWritten: buffer.byteLength,
								persisted: backend !== "OPFS-Unavailable",
								backend,
								cachedInWorker: false,
								workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
							};
						} catch (err) {
							if (isQuotaExceededError(err)) {
								this.boundedWorkerCache?.clear();
								throw new StorageQuotaExceededError(void 0, err);
							}
							throw err;
						}
					}
				}
				return {
					bytesWritten: 0,
					persisted: false,
					backend: "OPFS-Unavailable",
					cachedInWorker: this.boundedWorkerCache ? this.boundedWorkerCache.put(`${safeAssetId}__${chunkFile}`, buffer) : false,
					workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
				};
			} finally {
				this.releaseLease(leaseKey, lease.leaseId);
			}
		}, () => {
			this.lockConflictsPrevented++;
		});
	}
	async finalizeAsset(assetId, patch) {
		const safeAssetId = this.sanitizeName(assetId);
		return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, async () => {
			const existing = await this.readManifestRaw(safeAssetId);
			if (!existing) throw new Error(`ASSET_NOT_FOUND: Cannot finalize missing asset ${safeAssetId}`);
			if (existing.state === "abandoned" || existing.state === "failed") throw new Error(`ASSET_LIFECYCLE_ERROR: Cannot finalize ${existing.state} asset ${safeAssetId}`);
			const finalizing = {
				...existing,
				...patch,
				assetId: safeAssetId,
				state: "finalizing",
				updatedAtMs: Date.now()
			};
			await this.writeManifestRaw(finalizing);
			if (this.opfsAvailable && this.rootDir && finalizing.totalBlocks > 0) {
				const dir = await this.getAssetDir(safeAssetId, false);
				if (!dir) {
					await this.abortAssetIngestUnlocked(safeAssetId, "OPFS directory missing during finalization", "failed");
					throw new Error(`ASSET_FINALIZE_VERIFICATION_FAILED: Directory missing for ${safeAssetId}`);
				}
				for (let idx = 0; idx < finalizing.totalBlocks; idx++) {
					const expectedBytes = Math.min(finalizing.blockSizeSamples, Math.max(0, finalizing.totalSamples - idx * finalizing.blockSizeSamples)) * finalizing.bytesPerSample * finalizing.channels;
					const targetName = this.assetFileName(safeAssetId, `blk_${idx}.f32`, this.hasHierarchicalSubdirs());
					try {
						await this.runWithKeyMutex(`chunk:${safeAssetId}:blk_${idx}`, async () => {
							const file = await (await dir.getFileHandle(targetName, { create: false })).getFile();
							const actualBytes = typeof file.size === "number" ? file.size : (await file.arrayBuffer()).byteLength;
							if (actualBytes !== expectedBytes) throw new Error(`Chunk #${idx} size mismatch: expected ${expectedBytes} bytes, got ${actualBytes}`);
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await this.abortAssetIngestUnlocked(safeAssetId, `Chunk verification failed: ${msg}`, "failed");
						throw new Error(`ASSET_FINALIZE_VERIFICATION_FAILED: ${msg}`);
					}
				}
			}
			const now = Date.now();
			const ready = {
				...finalizing,
				state: "ready",
				updatedAtMs: now,
				finalizedAtMs: now
			};
			await this.writeManifestRaw(ready);
			return ready;
		});
	}
	async abortAssetIngestUnlocked(safeAssetId, reason, targetState = "abandoned") {
		const existing = await this.readManifestRaw(safeAssetId);
		if (existing) {
			const failedManifest = {
				...existing,
				state: targetState,
				updatedAtMs: Date.now(),
				finalizedAtMs: null,
				errorMessage: reason
			};
			this.fallbackManifests.set(safeAssetId, failedManifest);
			await this.writeManifestRaw(failedManifest).catch(() => {});
		}
		await this.deleteAssetUnlocked(safeAssetId);
		return {
			cleaned: true,
			state: targetState
		};
	}
	async abortAssetIngest(assetId, reason, targetState = "abandoned") {
		const safeAssetId = this.sanitizeName(assetId);
		return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, () => this.abortAssetIngestUnlocked(safeAssetId, reason, targetState));
	}
	async getReadyAssetManifest(assetId) {
		const manifest = await this.readManifestRaw(assetId);
		if (!manifest || manifest.state !== "ready") return null;
		return manifest;
	}
	async listReadyAssets() {
		const ready = [];
		if (this.opfsAvailable && this.rootDir) {
			const assetsRoot = await this.getAssetsRootDir(false);
			if (assetsRoot && typeof assetsRoot.entries === "function") {
				for await (const [name, handle] of assetsRoot.entries()) if (handle.kind === "directory") {
					const m = await this.getReadyAssetManifest(name);
					if (m) ready.push(m);
				}
				return ready;
			}
		}
		for (const m of this.fallbackManifests.values()) if (m.state === "ready") ready.push(m);
		return ready;
	}
	async readAssetChunk(assetId, chunkIndex, ownerWorker) {
		const safeAssetId = this.sanitizeName(assetId);
		const manifest = await this.readManifestRaw(safeAssetId);
		if (!manifest || manifest.state !== "ready") return {
			buffer: null,
			persisted: false
		};
		const leaseKey = `${safeAssetId}:blk_${chunkIndex}`;
		return this.runWithKeyMutex(`chunk:${leaseKey}`, async () => {
			const lease = this.acquireLease(leaseKey, ownerWorker);
			try {
				const chunkFile = `blk_${chunkIndex}.f32`;
				if (this.opfsAvailable && this.rootDir) {
					const dir = await this.getAssetDir(safeAssetId, false);
					if (!dir) return {
						buffer: null,
						persisted: false
					};
					const targetName = this.assetFileName(safeAssetId, chunkFile, this.hasHierarchicalSubdirs());
					const fh = await dir.getFileHandle(targetName, { create: false });
					return {
						buffer: await this.readBytesFromFileHandle(fh),
						persisted: true
					};
				}
				if (this.boundedWorkerCache) {
					const cached = this.boundedWorkerCache.get(`${safeAssetId}__${chunkFile}`);
					if (cached) return {
						buffer: cached.slice(0),
						persisted: false
					};
				}
				return {
					buffer: null,
					persisted: false
				};
			} catch {
				return {
					buffer: null,
					persisted: false
				};
			} finally {
				this.releaseLease(leaseKey, lease.leaseId);
			}
		}, () => {
			this.lockConflictsPrevented++;
		});
	}
	async deleteAssetUnlocked(safeAssetId) {
		this.fallbackManifests.delete(safeAssetId);
		this.boundedWorkerCache?.deleteByPrefix(`${safeAssetId}__`);
		this.boundedWorkerCache?.deleteByPrefix(`${safeAssetId}_blk_`);
		if (this.opfsAvailable && this.rootDir) {
			const assetsRoot = await this.getAssetsRootDir(false);
			if (assetsRoot) {
				if (this.hasHierarchicalSubdirs()) await assetsRoot.removeEntry(safeAssetId, { recursive: true }).catch(() => {});
				else if (typeof assetsRoot.entries === "function") {
					for await (const [name] of assetsRoot.entries()) if (name.startsWith(`${safeAssetId}__`)) await assetsRoot.removeEntry(name).catch(() => {});
				}
			}
		}
		for (const k of Array.from(this.activeLeases.keys())) if (k.startsWith(`${safeAssetId}:`) || k.startsWith(`${safeAssetId}_`)) this.activeLeases.delete(k);
		return { deleted: true };
	}
	async deleteAsset(assetId) {
		const safeAssetId = this.sanitizeName(assetId);
		return this.runWithKeyMutex(`lifecycle:${safeAssetId}`, () => this.deleteAssetUnlocked(safeAssetId));
	}
	async recoverStartupAssets(maxIngestingAgeMs = 0) {
		const cleanedAssetIds = [];
		const readyAssetIds = [];
		const now = Date.now();
		if (this.opfsAvailable && this.rootDir) {
			const assetsRoot = await this.getAssetsRootDir(false);
			if (assetsRoot && typeof assetsRoot.entries === "function") {
				const candidateIds = [];
				for await (const [name, handle] of assetsRoot.entries()) if (handle.kind === "directory") candidateIds.push(name);
				else if (name.endsWith(`__${ASSET_MANIFEST_FILE}`)) candidateIds.push(name.slice(0, -`__${ASSET_MANIFEST_FILE}`.length));
				for (const assetId of candidateIds) {
					const manifest = await this.readManifestRaw(assetId);
					if (!manifest) {
						await this.deleteAsset(assetId);
						cleanedAssetIds.push(assetId);
						continue;
					}
					if (manifest.state === "ready") {
						readyAssetIds.push(assetId);
						continue;
					}
					const safeMaxAge = typeof maxIngestingAgeMs === "number" && Number.isFinite(maxIngestingAgeMs) && maxIngestingAgeMs >= 0 ? maxIngestingAgeMs : 0;
					const ageMs = now - (manifest.updatedAtMs || manifest.createdAtMs || 0);
					if (manifest.state === "abandoned" || manifest.state === "failed" || manifest.state === "finalizing" || manifest.state === "ingesting" && ageMs >= safeMaxAge) {
						await this.deleteAsset(assetId);
						cleanedAssetIds.push(assetId);
					}
				}
				return {
					cleanedAssetIds,
					readyAssetIds
				};
			}
		}
		for (const [assetId, manifest] of Array.from(this.fallbackManifests.entries())) if (manifest.state === "ready") readyAssetIds.push(assetId);
		else {
			await this.deleteAsset(assetId);
			cleanedAssetIds.push(assetId);
		}
		return {
			cleanedAssetIds,
			readyAssetIds
		};
	}
	async writeBlock(fileKey, ownerWorker, buffer) {
		const safeName = this.sanitizeName(fileKey);
		return this.runWithKeyMutex(`file:${safeName}`, async () => {
			const lease = this.acquireLease(fileKey, ownerWorker);
			try {
				if (this.opfsAvailable && this.rootDir) try {
					const fh = await this.rootDir.getFileHandle(safeName, { create: true });
					const backend = await this.writeBytesToFileHandle(fh, new Uint8Array(buffer));
					if (backend !== "OPFS-Unavailable") return {
						bytesWritten: buffer.byteLength,
						persisted: true,
						backend,
						cachedInWorker: false,
						workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
					};
				} catch (err) {
					if (isQuotaExceededError(err)) {
						this.boundedWorkerCache?.clear();
						throw new StorageQuotaExceededError(void 0, err);
					}
					throw err;
				}
				return {
					bytesWritten: 0,
					persisted: false,
					backend: "OPFS-Unavailable",
					cachedInWorker: this.boundedWorkerCache ? this.boundedWorkerCache.put(safeName, buffer) : false,
					workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
				};
			} finally {
				this.releaseLease(fileKey, lease.leaseId);
			}
		}, () => {
			this.lockConflictsPrevented++;
		});
	}
	async readBlock(fileKey, ownerWorker) {
		const safeName = this.sanitizeName(fileKey);
		return this.runWithKeyMutex(`file:${safeName}`, async () => {
			const lease = this.acquireLease(fileKey, ownerWorker);
			try {
				if (this.opfsAvailable && this.rootDir) {
					const fh = await this.rootDir.getFileHandle(safeName);
					return {
						buffer: await this.readBytesFromFileHandle(fh),
						persisted: true
					};
				}
				if (this.boundedWorkerCache) {
					const cached = this.boundedWorkerCache.get(safeName);
					if (cached) return {
						buffer: cached.slice(0),
						persisted: false
					};
				}
				return {
					buffer: null,
					persisted: false
				};
			} catch {
				return {
					buffer: null,
					persisted: false
				};
			} finally {
				this.releaseLease(fileKey, lease.leaseId);
			}
		}, () => {
			this.lockConflictsPrevented++;
		});
	}
	async deleteFile(fileKey) {
		const safeName = this.sanitizeName(fileKey);
		return this.runWithKeyMutex(`file:${safeName}`, async () => {
			if (this.opfsAvailable && this.rootDir) await this.rootDir.removeEntry(safeName).catch(() => {});
			this.boundedWorkerCache?.delete(safeName);
			this.activeLeases.delete(fileKey);
			return { deleted: true };
		});
	}
	getState() {
		return {
			opfsAvailable: this.opfsAvailable,
			syncHandleAvailable: this.syncHandleAvailable,
			lockConflictsPrevented: this.lockConflictsPrevented,
			leases: Array.from(this.activeLeases.values()).slice(-12),
			workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
		};
	}
	async handleMessage(msg) {
		if (msg.type === "INIT") return {
			payload: await this.init(msg.workerCacheMaxBytes ?? 0),
			transfer: []
		};
		if (msg.type === "WRITE_BLOCK") return {
			payload: {
				...await this.writeBlock(msg.fileKey, msg.ownerWorker, msg.data),
				lockConflictsPrevented: this.lockConflictsPrevented,
				leases: Array.from(this.activeLeases.values()).slice(-12)
			},
			transfer: []
		};
		if (msg.type === "READ_BLOCK") {
			const res = await this.readBlock(msg.fileKey, msg.ownerWorker);
			return {
				payload: {
					buffer: res.buffer,
					persisted: res.persisted,
					lockConflictsPrevented: this.lockConflictsPrevented,
					leases: Array.from(this.activeLeases.values()).slice(-12),
					workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
				},
				transfer: res.buffer ? [res.buffer] : []
			};
		}
		if (msg.type === "DELETE_FILE") return {
			payload: await this.deleteFile(msg.fileKey),
			transfer: []
		};
		if (msg.type === "BEGIN_ASSET_INGEST") return {
			payload: await this.beginAssetIngest(msg.manifest),
			transfer: []
		};
		if (msg.type === "WRITE_ASSET_CHUNK") return {
			payload: {
				...await this.writeAssetChunk(msg.assetId, msg.chunkIndex, msg.ownerWorker, msg.data),
				lockConflictsPrevented: this.lockConflictsPrevented,
				leases: Array.from(this.activeLeases.values()).slice(-12)
			},
			transfer: []
		};
		if (msg.type === "READ_ASSET_CHUNK") {
			const res = await this.readAssetChunk(msg.assetId, msg.chunkIndex, msg.ownerWorker);
			return {
				payload: {
					buffer: res.buffer,
					persisted: res.persisted,
					lockConflictsPrevented: this.lockConflictsPrevented,
					leases: Array.from(this.activeLeases.values()).slice(-12),
					workerCacheStats: this.boundedWorkerCache?.getStats() ?? null
				},
				transfer: res.buffer ? [res.buffer] : []
			};
		}
		if (msg.type === "FINALIZE_ASSET") return {
			payload: { manifest: await this.finalizeAsset(msg.assetId, msg.patch) },
			transfer: []
		};
		if (msg.type === "ABORT_ASSET_INGEST") return {
			payload: await this.abortAssetIngest(msg.assetId, msg.reason, msg.targetState),
			transfer: []
		};
		if (msg.type === "GET_READY_ASSET") return {
			payload: { manifest: await this.getReadyAssetManifest(msg.assetId) },
			transfer: []
		};
		if (msg.type === "LIST_READY_ASSETS") return {
			payload: { assets: await this.listReadyAssets() },
			transfer: []
		};
		if (msg.type === "DELETE_ASSET") return {
			payload: await this.deleteAsset(msg.assetId),
			transfer: []
		};
		if (msg.type === "RECOVER_STARTUP_ASSETS") return {
			payload: await this.recoverStartupAssets(msg.maxIngestingAgeMs),
			transfer: []
		};
		return {
			payload: this.getState(),
			transfer: []
		};
	}
};
// src/workers/ioBroker.worker.ts
const core = new WorkerStorageCore();
self.onmessage = async (event) => {
	const msg = event.data;
	if (!msg || typeof msg !== "object" || typeof msg.id !== "string" || typeof msg.type !== "string") return;
	try {
		const { payload, transfer } = await core.handleMessage(msg);
		self.postMessage({
			id: msg.id,
			ok: true,
			payload
		}, transfer);
	} catch (err) {
		self.postMessage({
			id: msg.id,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		});
	}
};
