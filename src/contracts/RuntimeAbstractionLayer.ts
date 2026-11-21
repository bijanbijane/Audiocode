import { SampleRate, TimeRange } from './timebase.contract';

export type RuntimeEnvironmentKind =
  | 'BROWSER_LOCAL_RUNTIME'      // Active v1 local execution environment (Section 8.1)
  | 'NATIVE_DESKTOP_RUNTIME'     // Future Stage 14 Tauri/Native Rust GPU runtime
  | 'FIRST_PARTY_CLOUD_RUNTIME'  // Future Stage 15 Cloud runtime (strictly disabled in v1, Section 8.2)
  | 'EXTERNAL_API_RUNTIME';      // Optional explicit-consent external runtime (Section 8.3)

/** 1. Runtime-Agnostic Contracts for DSP nodes & AI tasks (Architecture Doc Section 9) */
export interface RuntimeAgnosticTaskEnvelope<TParams> {
  readonly taskId: string;
  readonly nodeOrModelId: string;
  readonly nodeOrModelVersion: string;
  readonly audioRange: TimeRange;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly parameters: TParams;
}

export interface RuntimeAgnosticTaskResult<TOutput> {
  readonly taskId: string;
  readonly executedOnRuntime: RuntimeEnvironmentKind;
  readonly runtimeVersionMetadata: string;
  readonly executionDurationMs: number;
  readonly output: TOutput;
}

/** 2. Runtime-Specific Contexts decoupled behind the abstraction boundary (Section 9) */
export interface BrowserLocalExecutionContext {
  readonly kind: 'BROWSER_LOCAL_RUNTIME';
  readonly crossOriginIsolated: boolean;
  readonly activeComputeBackend: 'WEBGPU' | 'WASM_SIMD';
  readonly opfsQuotaRemainingBytes: number;
  readonly maxWasmHeapBytes: number;
}

export interface NativeDesktopExecutionContext {
  readonly kind: 'NATIVE_DESKTOP_RUNTIME';
  readonly nativeGpuBackend: 'METAL' | 'VULKAN' | 'CUDA' | 'CPU_AVX2';
  readonly directDiskTempPath: string;
}

export interface FirstPartyCloudExecutionContext {
  readonly kind: 'FIRST_PARTY_CLOUD_RUNTIME';
  readonly jobQueueRegion: string;
  readonly estimatedComputeCreditsCost: number;
  readonly remoteStorageBucketRef: string;
}

export interface ExternalApiExecutionContext {
  readonly kind: 'EXTERNAL_API_RUNTIME';
  readonly providerId: string;
  readonly consentGrantId: string;
}

export type RuntimeSpecificContext =
  | BrowserLocalExecutionContext
  | NativeDesktopExecutionContext
  | FirstPartyCloudExecutionContext
  | ExternalApiExecutionContext;

export interface RuntimeExecutorAdapter<TParams, TOutput> {
  readonly runtimeKind: RuntimeEnvironmentKind;
  readonly runtimeVersionMetadata: string;
  execute(
    envelope: RuntimeAgnosticTaskEnvelope<TParams>,
    context: RuntimeSpecificContext,
  ): Promise<TOutput>;
}

/**
 * Execution Policy Router (Architecture Doc Section 10 & Golden Rule 3)
 * In v1, FIRST_PARTY_CLOUD_RUNTIME is strictly blocked, and EXTERNAL_API_RUNTIME
 * requires explicit external consent verified upstream.
 */
export class ExecutionPolicyRouter {
  private readonly v1CloudRuntimeDisabled = true as const;

  public selectTargetRuntime(params: {
    requestedRuntime: RuntimeEnvironmentKind;
    hasExplicitExternalApiConsent: boolean;
    nativeDesktopAdapterAvailable?: boolean;
  }): RuntimeEnvironmentKind {
    if (
      params.requestedRuntime === 'FIRST_PARTY_CLOUD_RUNTIME' &&
      this.v1CloudRuntimeDisabled
    ) {
      throw new Error(
        'RUNTIME_POLICY_CLOUD_DISABLED_IN_V1: طبق قانون ۳ معماری، پردازش ابری در نسخه اول غیرفعال است.',
      );
    }

    if (params.requestedRuntime === 'EXTERNAL_API_RUNTIME') {
      if (!params.hasExplicitExternalApiConsent) {
        throw new Error(
          'RUNTIME_POLICY_EXTERNAL_CONSENT_MISSING: مسیریاب اجرا حق ایجاد مجوز انتقال داده بدون رضایت کاربر را ندارد.',
        );
      }
      return 'EXTERNAL_API_RUNTIME';
    }

    if (
      params.requestedRuntime === 'NATIVE_DESKTOP_RUNTIME' &&
      params.nativeDesktopAdapterAvailable
    ) {
      return 'NATIVE_DESKTOP_RUNTIME';
    }

    return 'BROWSER_LOCAL_RUNTIME';
  }

  public async dispatchTask<TParams, TOutput>(params: {
    envelope: RuntimeAgnosticTaskEnvelope<TParams>;
    requestedRuntime: RuntimeEnvironmentKind;
    hasExplicitExternalApiConsent: boolean;
    context: RuntimeSpecificContext;
    adapters: Partial<Record<RuntimeEnvironmentKind, RuntimeExecutorAdapter<TParams, TOutput>>>;
  }): Promise<RuntimeAgnosticTaskResult<TOutput>> {
    const selectedRuntime = this.selectTargetRuntime({
      requestedRuntime: params.requestedRuntime,
      hasExplicitExternalApiConsent: params.hasExplicitExternalApiConsent,
      nativeDesktopAdapterAvailable: Boolean(params.adapters.NATIVE_DESKTOP_RUNTIME),
    });

    if (params.context.kind !== selectedRuntime) {
      throw new Error(
        `RUNTIME_CONTEXT_MISMATCH: expected ${selectedRuntime} context, got ${params.context.kind}`,
      );
    }

    const adapter = params.adapters[selectedRuntime];
    if (!adapter) {
      throw new Error(`RUNTIME_ADAPTER_MISSING: no adapter registered for ${selectedRuntime}`);
    }

    const t0 = performance.now();
    const output = await adapter.execute(params.envelope, params.context);
    const executionDurationMs = Number((performance.now() - t0).toFixed(3));

    return {
      taskId: params.envelope.taskId,
      executedOnRuntime: selectedRuntime,
      runtimeVersionMetadata: adapter.runtimeVersionMetadata,
      executionDurationMs,
      output,
    };
  }
}

export * from '../asr-core/UnifiedLocalAsrRuntime';

