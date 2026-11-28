/**
 * AVP-P0-001 Work Package C — Unified Local ASR Runtime Contract & Capability Resolver
 *
 * One unified processing contract shared by BOTH independent local runtimes:
 * - Execution Path A: Native Local Runtime (Standalone Companion + Native CPU)
 * - Execution Path B: Browser Local Runtime (Dedicated Web Worker + ONNX Runtime Web WASM/SIMD + OPFS)
 *
 * Non-negotiable invariants:
 * - Browser Local Runtime NEVER instantiates or depends on Native Companion.
 * - Zero cloud fallback (`allowCloudAsr: false`).
 * - SharedArrayBuffer is NOT required for CPU-only single-thread WASM execution.
 */

import {
  probeCrossPlatformCapabilities,
  resolveResourceTierProfile,
  buildGracefulDegradationPlan,
  type CrossPlatformCapabilities,
  type ResourceTierProfile,
  type GracefulDegradationPlan,
} from '../runtime/CrossPlatformResourcePolicy';
import type { ModelArchitecture } from '../lifecycle/ModelRepositoryContracts';
import {
  CanonicalModelManifest,
  evaluateModelRuntimeCompatibility,
  ModelCompatibilityReport,
  PERSIAN_NORMALIZATION_CONTRACT_VERSION,
} from '../lifecycle/CanonicalModelProvenance';
import {
  AVAPARDAZ_LOCAL_EXECUTION_POLICY,
  LocalAsrPolicyError,
} from '../runtime/LocalExecutionPolicy';

import { AVAPARDAZ_ASR_CONTRACT_VERSION } from './AsrContractVersion';
export { AVAPARDAZ_ASR_CONTRACT_VERSION } from './AsrContractVersion';

export type LocalAsrRuntimeTarget =
  | 'BROWSER_WASM_CPU'
  | 'BROWSER_WEBGPU_WITH_WASM_FALLBACK'
  | 'NATIVE_COMPANION_CPU';

export type AsrRuntimeErrorCode =
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_INITIALIZATION_FAILED'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_INTEGRITY_FAILURE'
  | 'MODEL_INCOMPATIBLE'
  | 'TENSOR_CONTRACT_MISMATCH'
  | 'AUDIO_INVALID'
  | 'AUDIO_FORMAT_UNSUPPORTED'
  | 'INFERENCE_FAILED'
  | 'INFERENCE_TIMEOUT'
  | 'JOB_CANCELLED'
  | 'JOB_ALREADY_RUNNING'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'CLOUD_FORBIDDEN'
  | 'COMPANION_UNAVAILABLE'
  | 'WORKER_CRASHED';

export class AsrRuntimeError extends Error {
  public readonly code: AsrRuntimeErrorCode;
  public readonly retryable: boolean;
  public readonly runtimeTarget: LocalAsrRuntimeTarget;
  public readonly jobId?: string;
  public readonly cause?: unknown;

  constructor(params: {
    readonly code: AsrRuntimeErrorCode;
    readonly message: string;
    readonly runtimeTarget: LocalAsrRuntimeTarget;
    readonly retryable?: boolean;
    readonly jobId?: string;
    readonly cause?: unknown;
  }) {
    super(params.message);
    this.name = 'AsrRuntimeError';
    this.code = params.code;
    this.runtimeTarget = params.runtimeTarget;
    this.retryable = Boolean(params.retryable);
    this.jobId = params.jobId;
    this.cause = params.cause;
  }
}

export interface BrowserCapabilityNegotiationResult {
  readonly runtimeTarget: 'BROWSER_WASM_CPU' | 'BROWSER_WEBGPU_WITH_WASM_FALLBACK';
  readonly wasmAvailable: boolean;
  readonly simdAvailable: boolean;
  readonly sharedArrayBufferAvailable: boolean;
  readonly crossOriginIsolated: boolean;
  readonly threadingEnabled: boolean;
  readonly recommendedThreads: number;
  readonly opfsAvailable: boolean;
  readonly webGpuAvailable: boolean;
  readonly memoryBudgetBytes: number;
  readonly tierProfile: ResourceTierProfile;
  readonly degradationPlan: GracefulDegradationPlan;
  readonly fallbackHierarchy: readonly ('webgpu' | 'wasm')[];
  readonly rawProbe: CrossPlatformCapabilities;
}

export interface AsrRuntimeCapabilityReport {
  readonly runtimeTarget: LocalAsrRuntimeTarget;
  readonly runtimeName: string;
  readonly runtimeVersion: string;
  readonly available: boolean;
  readonly offlineCapable: boolean;
  readonly wasmAvailable: boolean;
  readonly simdAvailable: boolean;
  readonly sharedArrayBufferAvailable: boolean;
  readonly opfsAvailable: boolean;
  readonly webGpuAvailable: boolean;
  readonly maxThreads: number;
  readonly memoryBudgetBytes: number;
  readonly maxSupportedOnnxOpset: number;
  readonly supportedArchitectures: readonly ModelArchitecture[];
  readonly notes: readonly string[];
}

export interface AsrModelLoadDescriptor {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly architecture: ModelArchitecture;
  readonly verifiedSha256Hex: string;
  readonly storageDirectory?: string;
  readonly manifest?: CanonicalModelManifest;
  readonly ctcVocabulary?: readonly string[];
  readonly whisperIdToBpeTokenEntries?: readonly [number, string][];
  readonly whisperSpecialTokens?: {
    readonly sotTokenId: number;
    readonly persianLangTokenId: number;
    readonly transcribeTaskTokenId: number;
    readonly eotTokenId: number;
    readonly timestampBeginId: number;
  };
  readonly executionProviders?: readonly ('webgpu' | 'wasm' | 'cpu')[];
}

export interface AsrModelValidationReport {
  readonly valid: boolean;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly integrityVerified: boolean;
  readonly compatibility: ModelCompatibilityReport | null;
  readonly errors: readonly string[];
}

export interface AsrProgressEvent {
  readonly jobId: string;
  readonly runtimeTarget: LocalAsrRuntimeTarget;
  readonly stage:
    | 'VALIDATING_AUDIO'
    | 'INITIALIZING_RUNTIME'
    | 'LOADING_MODEL'
    | 'PREPROCESSING'
    | 'INFERRING'
    | 'POSTPROCESSING'
    | 'COMPLETED';
  readonly percent: number;
  readonly currentChunk: number;
  readonly totalChunks: number;
  readonly elapsedMs: number;
  readonly messageFa: string;
}

export interface AvapardazWordSpan {
  readonly word: string;
  readonly normalizedWord: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly confidence: number;
}

export interface AvapardazTranscriptSegment {
  readonly id: string;
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly language: string;
  readonly confidence: number | null;
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly words: readonly AvapardazWordSpan[];
}

export interface AvapardazTranscriptResult {
  readonly contractVersion: typeof AVAPARDAZ_ASR_CONTRACT_VERSION;
  readonly jobId: string;
  readonly runtimeTarget: LocalAsrRuntimeTarget;
  readonly runtimeName: string;
  readonly executionProvider: 'wasm' | 'webgpu' | 'cpu';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelSha256Hex: string;
  readonly architecture: string;
  readonly normalizationVersion: typeof PERSIAN_NORMALIZATION_CONTRACT_VERSION;
  readonly offlineVerified: boolean;
  readonly sampleRateHz: 16000;
  readonly durationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly dominantLanguage: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly segments: readonly AvapardazTranscriptSegment[];
  readonly peakMemoryBytes: number;
}

export interface AsrTranscriptionRequest {
  readonly jobId: string;
  readonly projectId: string;
  readonly trackId: string;
  readonly sourceAssetId: string;
  readonly sourceAssetSha256: string;
  readonly fileName: string;
  readonly sampleRate: number;
  readonly totalSamples: number;
  /** Windowed range reader — prevents full-track PCM duplication for long audio */
  readonly readSourceRange: (startSample: number, count: number) => Promise<Float32Array>;
  readonly languageHint?: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly modelDescriptor?: AsrModelLoadDescriptor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: AsrProgressEvent) => void;
}

export interface AsrRuntimeHealthReport {
  readonly runtimeTarget: LocalAsrRuntimeTarget;
  readonly runtimeReady: boolean;
  readonly modelLoaded: boolean;
  readonly inferenceVerified: boolean;
  readonly activeModelId: string | null;
  readonly activeModelVersion: string | null;
  readonly activeJobId: string | null;
  readonly lastErrorCode: AsrRuntimeErrorCode | null;
  readonly timestampMs: number;
}

export interface AsrRuntimeResourceReport {
  readonly runtimeTarget: LocalAsrRuntimeTarget;
  readonly accountedMemoryBytes: number;
  readonly memoryHardLimitBytes: number;
  readonly activeWorkerCount: number;
  readonly activeJobCount: number;
}

/**
 * Single Canonical Local ASR Runtime Adapter Interface (Dependency Inversion).
 * Both Browser ONNX Worker Runtime and Native Companion Runtime implement this exact contract.
 */
export interface LocalAsrRuntimeAdapter {
  readonly runtimeTarget: LocalAsrRuntimeTarget;
  readonly runtimeName: string;

  probeCapabilities(): Promise<AsrRuntimeCapabilityReport>;
  initializeRuntime(signal?: AbortSignal): Promise<void>;
  validateModel(descriptor: AsrModelLoadDescriptor): Promise<AsrModelValidationReport>;
  loadModel(descriptor: AsrModelLoadDescriptor, signal?: AbortSignal): Promise<void>;
  transcribe(request: AsrTranscriptionRequest): Promise<AvapardazTranscriptResult>;
  cancel(jobId: string): Promise<void>;
  getHealth(): Promise<AsrRuntimeHealthReport>;
  getResourceUsage(): AsrRuntimeResourceReport;
  dispose(): Promise<void>;
}

/**
 * Deterministic Browser capability negotiation grounded in `CrossPlatformResourcePolicy`.
 * Guarantees:
 * - WASM CPU / SIMD is always the reliable baseline.
 * - SharedArrayBuffer / COI is NEVER required for CPU-only single-thread inference.
 * - WebGPU is opted in ONLY when hardware + model + runtime explicitly support it.
 */
export function negotiateBrowserAsrCapabilities(options?: {
  readonly capabilityOverrides?: Partial<CrossPlatformCapabilities>;
  readonly allowWebGpu?: boolean;
  readonly modelSupportsWebGpu?: boolean;
}): BrowserCapabilityNegotiationResult {
  const probed = probeCrossPlatformCapabilities();
  const rawProbe: CrossPlatformCapabilities = {
    ...probed,
    ...(options?.capabilityOverrides ?? {}),
  };

  const tierProfile = resolveResourceTierProfile(rawProbe);
  const degradationPlan = buildGracefulDegradationPlan({
    profile: tierProfile,
    pressureLevel: 'normal',
  });

  const crossOriginIsolated = rawProbe.crossOriginIsolated === true;
  const sharedArrayBufferAvailable = Boolean(rawProbe.sharedArrayBufferAvailable);
  const threadingEnabled = crossOriginIsolated && sharedArrayBufferAvailable;
  const recommendedThreads = threadingEnabled
    ? Math.max(1, Math.min(4, tierProfile.maxWasmWorkerThreads))
    : 1;

  const wasmAvailable = typeof WebAssembly === 'object';
  const simdAvailable = rawProbe.wasmSimdSupported === true;
  const opfsAvailable = rawProbe.opfsSupported === true;
  const webGpuAvailable = rawProbe.webGpuSupported === true;

  const canUseWebGpu =
    Boolean(options?.allowWebGpu) &&
    Boolean(options?.modelSupportsWebGpu) &&
    webGpuAvailable;

  const fallbackHierarchy: readonly ('webgpu' | 'wasm')[] = canUseWebGpu
    ? ['webgpu', 'wasm']
    : ['wasm'];

  const memoryBudgetBytes =
    typeof rawProbe.deviceMemoryGb === 'number' && rawProbe.deviceMemoryGb > 0
      ? Math.round(rawProbe.deviceMemoryGb * 1024 * 1024 * 1024 * 0.25)
      : tierProfile.maxCacheBytes * 8;

  return {
    runtimeTarget: canUseWebGpu ? 'BROWSER_WEBGPU_WITH_WASM_FALLBACK' : 'BROWSER_WASM_CPU',
    wasmAvailable,
    simdAvailable,
    sharedArrayBufferAvailable,
    crossOriginIsolated,
    threadingEnabled,
    recommendedThreads,
    opfsAvailable,
    webGpuAvailable,
    memoryBudgetBytes,
    tierProfile,
    degradationPlan,
    fallbackHierarchy,
    rawProbe,
  };
}

export type RuntimeSelectionPreference = 'AUTO_LOCAL' | 'BROWSER_ONLY' | 'NATIVE_COMPANION_ONLY';

export interface RuntimeResolutionResult {
  readonly selectedAdapter: LocalAsrRuntimeAdapter | null;
  readonly selectedTarget: LocalAsrRuntimeTarget | null;
  readonly reason: string;
  readonly checkedTargets: readonly LocalAsrRuntimeTarget[];
}

/**
 * Explicit, observable, deterministic local runtime resolver.
 * Never instantiates Companion when `BROWSER_ONLY` is requested, and never permits Cloud ASR.
 */
export class LocalAsrRuntimeResolver {
  constructor(
    private readonly adapters: {
      readonly browser?: LocalAsrRuntimeAdapter;
      readonly nativeCompanion?: LocalAsrRuntimeAdapter;
    },
  ) {}

  public async resolve(params: {
    readonly preference: RuntimeSelectionPreference;
    readonly requestedCloudMode?: boolean;
    readonly preferBrowserWhenModelInstalled?: boolean;
    readonly preferNativeCompanionWhenReady?: boolean;
    readonly hasBrowserInstalledModel?: boolean;
  }): Promise<RuntimeResolutionResult> {
    if (params.requestedCloudMode || !AVAPARDAZ_LOCAL_EXECUTION_POLICY.localOnlyEnforced) {
      throw new LocalAsrPolicyError(
        'LOCAL_ONLY_CLOUD_ASR_BLOCKED',
        'Cloud ASR is permanently disabled by AVAPARDAZ Local-Only Execution Policy.',
      );
    }

    const checkedTargets: LocalAsrRuntimeTarget[] = [];

    if (params.preference === 'BROWSER_ONLY') {
      if (!this.adapters.browser) {
        return {
          selectedAdapter: null,
          selectedTarget: null,
          reason: 'BROWSER_ADAPTER_NOT_REGISTERED',
          checkedTargets,
        };
      }
      checkedTargets.push(this.adapters.browser.runtimeTarget);
      const cap = await this.adapters.browser.probeCapabilities();
      if (!cap.available) {
        return {
          selectedAdapter: null,
          selectedTarget: null,
          reason: 'BROWSER_WASM_RUNTIME_UNAVAILABLE',
          checkedTargets,
        };
      }
      return {
        selectedAdapter: this.adapters.browser,
        selectedTarget: this.adapters.browser.runtimeTarget,
        reason: 'BROWSER_LOCAL_RUNTIME_SELECTED_INDEPENDENTLY',
        checkedTargets,
      };
    }

    if (params.preference === 'NATIVE_COMPANION_ONLY') {
      if (!this.adapters.nativeCompanion) {
        return {
          selectedAdapter: null,
          selectedTarget: null,
          reason: 'NATIVE_COMPANION_ADAPTER_NOT_REGISTERED',
          checkedTargets,
        };
      }
      checkedTargets.push(this.adapters.nativeCompanion.runtimeTarget);
      const health = await this.adapters.nativeCompanion.getHealth();
      if (!health.runtimeReady) {
        return {
          selectedAdapter: null,
          selectedTarget: null,
          reason: 'NATIVE_COMPANION_UNAVAILABLE',
          checkedTargets,
        };
      }
      return {
        selectedAdapter: this.adapters.nativeCompanion,
        selectedTarget: this.adapters.nativeCompanion.runtimeTarget,
        reason: 'NATIVE_COMPANION_RUNTIME_SELECTED',
        checkedTargets,
      };
    }

    // Product policy can prefer the installed/native Companion engine (SHAHAB Koochik)
    // while retaining Browser WASM as an automatic fallback if the local service is unavailable.
    if (params.preferNativeCompanionWhenReady && this.adapters.nativeCompanion) {
      checkedTargets.push(this.adapters.nativeCompanion.runtimeTarget);
      const health = await this.adapters.nativeCompanion.getHealth();
      if (health.runtimeReady) {
        return {
          selectedAdapter: this.adapters.nativeCompanion,
          selectedTarget: this.adapters.nativeCompanion.runtimeTarget,
          reason: 'AUTO_LOCAL_SELECTED_NATIVE_COMPANION_PRIMARY',
          checkedTargets,
        };
      }
    }

    // AUTO_LOCAL: If a local browser model is installed, prefer independent Browser Local Runtime first
    // so Browser execution never requires Companion!
    if (
      (params.preferBrowserWhenModelInstalled ?? true) &&
      params.hasBrowserInstalledModel &&
      this.adapters.browser
    ) {
      checkedTargets.push(this.adapters.browser.runtimeTarget);
      const cap = await this.adapters.browser.probeCapabilities();
      if (cap.available) {
        return {
          selectedAdapter: this.adapters.browser,
          selectedTarget: this.adapters.browser.runtimeTarget,
          reason: 'AUTO_LOCAL_SELECTED_BROWSER_INSTALLED_MODEL',
          checkedTargets,
        };
      }
    }

    // Otherwise check optional Native Companion if registered & ready
    if (this.adapters.nativeCompanion) {
      checkedTargets.push(this.adapters.nativeCompanion.runtimeTarget);
      const health = await this.adapters.nativeCompanion.getHealth();
      if (health.runtimeReady && health.modelLoaded) {
        return {
          selectedAdapter: this.adapters.nativeCompanion,
          selectedTarget: this.adapters.nativeCompanion.runtimeTarget,
          reason: 'AUTO_LOCAL_SELECTED_NATIVE_COMPANION',
          checkedTargets,
        };
      }
    }

    // Fall back to Browser Local Runtime (which will report honest MODEL_NOT_INSTALLED if no model is present)
    if (this.adapters.browser) {
      if (!checkedTargets.includes(this.adapters.browser.runtimeTarget)) {
        checkedTargets.push(this.adapters.browser.runtimeTarget);
      }
      const cap = await this.adapters.browser.probeCapabilities();
      if (cap.available) {
        return {
          selectedAdapter: this.adapters.browser,
          selectedTarget: this.adapters.browser.runtimeTarget,
          reason: 'AUTO_LOCAL_DEFAULTED_TO_BROWSER_RUNTIME',
          checkedTargets,
        };
      }
    }

    return {
      selectedAdapter: null,
      selectedTarget: null,
      reason: 'NO_LOCAL_RUNTIME_AVAILABLE',
      checkedTargets,
    };
  }
}
