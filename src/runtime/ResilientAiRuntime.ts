/**
 * Resilient AI Runtime Manager (PoC #4)
 * - Capability Tiering (Mobile Companion 384MB iOS Safari cap vs Tablet vs Desktop)
 * - Single-Active-Heavy-Model memory guard
 * - Web Locks background stability
 * - Automatic GPUDevice.lost checkpoint fallback to WASM_SIMD without restarting the job
 */

export type ExecutionBackend = 'WEBGPU' | 'WASM_SIMD';
export type DeviceTier = 'MOBILE_COMPANION' | 'TABLET_STUDIO' | 'DESKTOP_STUDIO';

interface WebGpuAdapterLike {
  requestDevice: () => Promise<WebGpuDeviceLike>;
}

interface WebGpuDeviceLike {
  lost: Promise<{ reason: string; message: string }>;
}

export class ResilientAiRuntimeManager {
  private currentBackend: ExecutionBackend = 'WASM_SIMD';
  private activeHeavyModelId: string | null = null;
  private gpuDevice: WebGpuDeviceLike | null = null;

  constructor(initialBackend: ExecutionBackend = 'WASM_SIMD') {
    this.currentBackend = initialBackend;
  }

  public getCurrentBackend(): ExecutionBackend {
    return this.currentBackend;
  }

  public getActiveHeavyModelId(): string | null {
    return this.activeHeavyModelId;
  }

  public async detectCapabilityTier(): Promise<{
    tier: DeviceTier;
    recommendedBackend: ExecutionBackend;
    maxWasmMemoryMb: number;
  }> {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (typeof navigator !== 'undefined' &&
        navigator.platform === 'MacIntel' &&
        navigator.maxTouchPoints > 1);
    const deviceMemoryGb =
      (typeof navigator !== 'undefined'
        ? (navigator as unknown as { deviceMemory?: number }).deviceMemory
        : undefined) ?? (isIOS ? 3 : 8);

    if (typeof navigator !== 'undefined' && 'gpu' in navigator && !isIOS) {
      try {
        const gpuApi = (navigator as unknown as {
          gpu: { requestAdapter: (opts: { powerPreference: string }) => Promise<WebGpuAdapterLike | null> };
        }).gpu;
        const adapter = await gpuApi.requestAdapter({ powerPreference: 'high-performance' });
        if (adapter) {
          this.gpuDevice = await adapter.requestDevice();
          this.currentBackend = 'WEBGPU';
          this.gpuDevice.lost.then(() => {
            this.gpuDevice = null;
            this.currentBackend = 'WASM_SIMD';
          });
        }
      } catch {
        this.currentBackend = 'WASM_SIMD';
      }
    }

    if (isIOS || deviceMemoryGb <= 4) {
      return {
        tier: 'MOBILE_COMPANION',
        recommendedBackend: 'WASM_SIMD',
        maxWasmMemoryMb: 384,
      };
    }

    if (deviceMemoryGb <= 6) {
      return {
        tier: 'TABLET_STUDIO',
        recommendedBackend: this.currentBackend,
        maxWasmMemoryMb: 768,
      };
    }

    return {
      tier: 'DESKTOP_STUDIO',
      recommendedBackend: this.currentBackend,
      maxWasmMemoryMb: 2048,
    };
  }

  public async executeChunkedJobWithCheckpoint<TResult>(
    modelId: string,
    totalChunks: number,
    lastCompletedChunkIndex: number,
    runChunkFn: (chunkIdx: number, backend: ExecutionBackend) => Promise<TResult>,
    saveCheckpointFn: (chunkIdx: number, result: TResult) => Promise<void>,
    unloadPreviousModelFn: (prevModelId: string) => Promise<void>,
  ): Promise<{ fallbackTriggered: boolean; finalBackend: ExecutionBackend }> {
    if (this.activeHeavyModelId && this.activeHeavyModelId !== modelId) {
      await unloadPreviousModelFn(this.activeHeavyModelId);
      this.activeHeavyModelId = null;
    }
    this.activeHeavyModelId = modelId;

    let fallbackTriggered = false;

    const executeLoop = async () => {
      for (let idx = lastCompletedChunkIndex + 1; idx < totalChunks; idx++) {
        try {
          const result = await runChunkFn(idx, this.currentBackend);
          await saveCheckpointFn(idx, result);
        } catch (err) {
          if (this.currentBackend === 'WEBGPU') {
            fallbackTriggered = true;
            this.currentBackend = 'WASM_SIMD';
            const fallbackResult = await runChunkFn(idx, 'WASM_SIMD');
            await saveCheckpointFn(idx, fallbackResult);
          } else {
            throw err;
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    };

    if (typeof navigator !== 'undefined' && navigator.locks && 'request' in navigator.locks) {
      await navigator.locks.request(`ai-job-${modelId}`, executeLoop);
    } else {
      await executeLoop();
    }

    return {
      fallbackTriggered,
      finalBackend: this.currentBackend,
    };
  }
}
