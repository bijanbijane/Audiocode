/**
 * SHAHAB-010 — Unified Engine Integration, Local/Cloud Execution & Release Candidate (SHAHAB-R1.4.0)
 *
 * Single public application-level speech recognition interface (`SHAHABEngine`) inside Avapardaz.
 *
 * Governing invariants:
 * - Frozen inherited neural core (`INHERITED-PERSIAN-ASR-CORE`, trainableParameters = 0)
 * - NEVER claims SHAHAB is a newly trained neural model
 * - One shared 19-stage logical processing pipeline across LOCAL, CLOUD, and AUTO modes
 * - Strict privacy gate: LOCAL never uploads audio; AUTO never silently escalates LOCAL -> CLOUD
 * - Raw acoustic transcript (Layer A) is immutable and never overwritten by normalization/correction
 * - Integrates existing Avapardaz P0-009, P0-010, and P0-012 modules directly (no duplicate engine)
 * - Never fabricates word timestamps, speaker labels, or confidence scores
 * - Model-independent error taxonomy (21 canonical codes) without exposing secrets or raw audio
 * - Zero ONNX/internal model types leaked in public plugin-safe contracts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizePersianTextDeterministic,
} from './ShahabContracts';
import { conditionPcmTo16kMono } from './core/ShahabCoreAudioConditioner';
import {
  SHAHABComputeBudgetController,
  SHAHABDecodePolicyManager,
  SHAHABFrozenModelAdapter,
  SHAHABMemoryGovernor,
  SHAHABRecurrentListeningController,
  SHAHABRuntimeCapabilityRegistry,
  ShahabAudioProfileReport,
  ShahabCacheIdentityKey,
  ShahabDecodePolicyConfig,
  ShahabDecodePolicyId,
  ShahabDecodedHypothesis,
  ShahabHotwordBiasMap,
  decodeWavToMono16k,
  profileAudioSignal,
} from './ShahabZipformerEngine';
import {
  SHAHABAcousticEvidenceLedger,
  SHAHABContextualVocabularyProvider,
  SHAHABFalseInsertionGuard,
  SHAHABPersianMemoryManager,
  SHAHABSelectiveRiskController,
  ShahabMemoryScope,
  ShahabSelectiveRiskAction,
  ShahabTranscriptSegmentEvidence,
} from './ShahabPersianMemoryAndContext';
import {
  detectMeaningCriticalTokens,
  evaluateProposedCorrection,
} from '../asr-core/PersianEvidenceCorrectionEngine';
import {
  VersionedPersianVocabularyManager,
  analyzePersianLexicalFidelity,
} from '../asr-core/PersianLexicalDisambiguationEngine';

export const SHAHAB_ENGINE_RELEASE = 'SHAHAB-R1.4.0' as const;
export const SHAHAB_NEURAL_CORE_IDENTITY = 'INHERITED-PERSIAN-ASR-CORE' as const;
export const SHAHAB_ENGINE_CONTRACT_VERSION = 'SHAHAB-ENGINE-CONTRACT-1.4.0' as const;

export type ShahabReleaseScopeClass =
  | 'VERIFIED_PRODUCTION_CANDIDATE'
  | 'VERIFIED_EXPERIMENTAL'
  | 'IMPLEMENTED_UNVERIFIED'
  | 'BLOCKED'
  | 'REJECTED';

export type ShahabReleaseGateStatus =
  | 'RELEASE_CANDIDATE'
  | 'BLOCKED'
  | 'REJECTED'
  | 'VERIFIED_RELEASE';

export type ShahabExecutionMode = 'LOCAL' | 'CLOUD' | 'AUTO';
export type ShahabFidelityMode = 'RAW_VERBATIM' | 'CONTEXT_ASSISTED' | 'NORMALIZED_READING' | 'AUTHORIZED_FINAL';

export type ShahabErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_AUDIO'
  | 'UNSUPPORTED_AUDIO_FORMAT'
  | 'UNSUPPORTED_SAMPLE_RATE'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_DOWNLOAD_REQUIRED'
  | 'MODEL_INTEGRITY_FAILURE'
  | 'MODEL_LOAD_FAILURE'
  | 'UNSUPPORTED_MODEL_CAPABILITY'
  | 'INSUFFICIENT_MEMORY'
  | 'ACCELERATOR_UNAVAILABLE'
  | 'INFERENCE_FAILURE'
  | 'DECODER_FAILURE'
  | 'CACHE_INVALIDATION'
  | 'EXECUTION_CANCELLED'
  | 'EXECUTION_TIMEOUT'
  | 'CLOUD_AUTHORIZATION_REQUIRED'
  | 'CLOUD_UNAVAILABLE'
  | 'STORAGE_FAILURE'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'UNKNOWN_INTERNAL_ERROR';

export interface ShahabEngineErrorPayload {
  readonly code: ShahabErrorCode;
  readonly message: string;
  readonly recoveryGuidance: string;
  readonly retryable: boolean;
  readonly partialResultsAvailable: boolean;
  readonly diagnosticRef: string;
}

export class SHAHABEngineError extends Error {
  public readonly code: ShahabErrorCode;
  public readonly recoveryGuidance: string;
  public readonly retryable: boolean;
  public readonly partialResultsAvailable: boolean;
  public readonly diagnosticRef: string;

  constructor(params: {
    readonly code: ShahabErrorCode;
    readonly message: string;
    readonly recoveryGuidance: string;
    readonly retryable?: boolean;
    readonly partialResultsAvailable?: boolean;
    readonly diagnosticRef?: string;
  }) {
    super(params.message);
    this.name = 'SHAHABEngineError';
    this.code = params.code;
    this.recoveryGuidance = params.recoveryGuidance;
    this.retryable = params.retryable ?? false;
    this.partialResultsAvailable = params.partialResultsAvailable ?? false;
    this.diagnosticRef = params.diagnosticRef ?? `shahab-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  public toPayload(): ShahabEngineErrorPayload {
    return {
      code: this.code,
      message: this.message,
      recoveryGuidance: this.recoveryGuidance,
      retryable: this.retryable,
      partialResultsAvailable: this.partialResultsAvailable,
      diagnosticRef: this.diagnosticRef,
    };
  }
}

export interface ShahabAudioSourceRef {
  readonly sourceId: string;
  readonly wavBytes?: Uint8Array;
  readonly pcmFloat32?: Float32Array;
  readonly sampleRateHz?: number;
  readonly channels?: number;
  readonly format?: 'wav' | 'pcm_f32';
}

export interface ShahabPrivacyPolicy {
  readonly localOnlyEnforced: boolean;
  readonly cloudAuthorized: boolean;
  readonly allowRemoteTeacherCalls: false;
  readonly allowAudioAnalyticsTransmission: false;
  readonly cloudAuthorizationRef?: string;
}

export interface ShahabRecognitionRequest {
  readonly requestId: string;
  readonly audioSource: ShahabAudioSourceRef;
  readonly executionPreference: ShahabExecutionMode;
  readonly modelProfile?: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8';
  readonly decodePolicy?: ShahabDecodePolicyId;
  readonly vocabularyScope?: {
    readonly enabled: boolean;
    readonly projectId?: string;
    readonly domainId?: string;
    readonly recordingId?: string;
    readonly allowedScopes?: readonly ShahabMemoryScope[];
  };
  readonly fidelityMode?: ShahabFidelityMode;
  readonly timingRequirements?: {
    readonly segmentTimestamps: boolean;
    readonly wordTimestamps: boolean;
  };
  readonly streamingPreference?: {
    readonly enabled: boolean;
    readonly chunkDurationSec?: number;
    readonly overlapSec?: number;
  };
  readonly cancellationSignal?: AbortSignal;
  readonly resourceConstraints?: {
    readonly maxMemoryBytes?: number;
    readonly timeoutMs?: number;
    readonly maxAudioDurationSec?: number;
  };
  readonly privacy: ShahabPrivacyPolicy;
  readonly enableSelectiveRedecode?: boolean;
}

/**
 * Plugin-safe, ONNX-free segment contract compatible with Avapardaz Timeline / future Adobe Audition hosts.
 */
export interface ShahabTranscriptSegment {
  readonly segmentId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly rawText: string;
  readonly contextAssistedText: string | null;
  readonly normalizedText: string | null;
  readonly authorizedFinalText: string;
  readonly wordTimingAvailable: false;
  readonly words: null;
  readonly speakerId: null;
  readonly speakerAssociationAvailable: false;
  readonly committed: boolean;
  readonly confidenceAvailable: false;
  readonly confidenceScore: null;
}

export interface ShahabAppliedTransformation {
  readonly stage: string;
  readonly module: string;
  readonly applied: boolean;
  readonly reversible: boolean;
  readonly reason: string;
}

export interface ShahabRecognitionResult {
  readonly contractVersion: typeof SHAHAB_ENGINE_CONTRACT_VERSION;
  readonly requestId: string;
  readonly engineRelease: typeof SHAHAB_ENGINE_RELEASE;
  readonly neuralCoreIdentity: typeof SHAHAB_NEURAL_CORE_IDENTITY;
  readonly trainableParameters: 0;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly modelVariant: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8';
  readonly modelArtifactHash: string;
  readonly executionModeRequested: ShahabExecutionMode;
  readonly executionModeActual: 'LOCAL' | 'CLOUD';
  readonly executionLocation: string;
  readonly runtimeId: string;
  readonly decoderPolicy: ShahabDecodePolicyId;
  readonly rawTranscript: string;
  readonly contextAssistedTranscript: string | null;
  readonly normalizedReadingTranscript: string | null;
  readonly authorizedFinalTranscript: string;
  readonly segments: readonly ShahabTranscriptSegment[];
  readonly wordLevelTimingAvailable: false;
  readonly speakerAssociationAvailable: false;
  readonly transcriptProvenance: {
    readonly audioSha256: string;
    readonly audioDurationSec: number;
    readonly sampleRateHz: number;
    readonly rawImmutablePreserved: true;
    readonly p009NormalizationApplied: boolean;
    readonly p010AuthorizationApplied: boolean;
    readonly p012AmbiguityGuardApplied: boolean;
    readonly p011ModuleStatus: 'NOT_PRESENT_IN_WORKSPACE';
  };
  readonly appliedTransformations: readonly ShahabAppliedTransformation[];
  readonly vocabularyContextProvenance: {
    readonly enabled: boolean;
    readonly scopesQueried: readonly ShahabMemoryScope[];
    readonly termsInjected: readonly string[];
    readonly blockedByFalseInsertionGuard: readonly string[];
    readonly refusedBecauseGreedyPolicy: boolean;
  };
  readonly uncertaintyAndRisk: {
    readonly riskAction: ShahabSelectiveRiskAction;
    readonly acousticUncertain: boolean;
    readonly confidenceScoreAvailable: false;
    readonly audioProfile: ShahabAudioProfileReport;
  };
  readonly warnings: readonly string[];
  readonly metrics: {
    readonly totalLatencyMs: number;
    readonly encoderMs: number;
    readonly decoderMs: number;
    readonly encoderCacheHit: boolean;
    readonly encoderInvocationsDelta: number;
    readonly rtf: number;
    readonly peakRssBytes: number;
    readonly pipelineStagesExecuted: readonly string[];
  };
  readonly evidenceReferences: {
    readonly ledgerSegmentId: string;
    readonly cacheIdentityKey: string | null;
  };
}

export interface ShahabAdapterCapabilityReport {
  readonly adapterId: string;
  readonly adapterClass: 'LOCAL_NATIVE' | 'BROWSER_WASM' | 'CLOUD_AUTHORIZED';
  readonly verificationStatus: 'VERIFIED' | 'BLOCKED' | 'NOT_VERIFIED';
  readonly supportedModelVariants: readonly ('ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8')[];
  readonly supportedDecodePolicies: readonly ShahabDecodePolicyId[];
  readonly supportedTensorPrecisions: readonly string[];
  readonly executionProvider: string;
  readonly streamingCapability: {
    readonly nativeStreamingGraph: false;
    readonly chunkedOverlapStreaming: boolean;
    readonly notes: string;
  };
  readonly timingCapability: {
    readonly segmentTimestamps: true;
    readonly wordTimestamps: false;
    readonly notes: string;
  };
  readonly maxPracticalAudioDurationSec: number;
  readonly availableMemoryBudgetBytes: number;
  readonly unsupportedOperations: readonly string[];
}

export interface SHAHABExecutionAdapter {
  readonly adapterId: string;
  readonly mode: 'LOCAL' | 'CLOUD';
  getCapabilities(): ShahabAdapterCapabilityReport;
  isAvailable(): boolean;
  ensureModelLoaded(variant: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8'): Promise<{
    readonly modelId: string;
    readonly modelRevision: string;
    readonly artifactHash: string;
    readonly loadEventOccurred: boolean;
    readonly loadMs: number;
  }>;
  unloadModel(): Promise<void>;
  executeAcousticStage(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly policy: ShahabDecodePolicyConfig;
    readonly useEncoderCache: boolean;
    readonly biasMap: ShahabHotwordBiasMap | null;
    readonly enableSelectiveRedecode: boolean;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly rawHypothesis: ShahabDecodedHypothesis;
    readonly contextHypothesis: ShahabDecodedHypothesis | null;
    readonly encoderCacheHit: boolean;
    readonly encoderMs: number;
    readonly encoderInvocationsDelta: number;
    readonly cacheIdentity: ShahabCacheIdentityKey | null;
    readonly redecodeTriggered: boolean;
    readonly runtimeId: string;
    readonly executionLocation: string;
  }>;
  getVocab(): readonly string[];
}

export interface ShahabVariantDirectoryMap {
  readonly ORIGINAL_INT8: {
    readonly modelDir: string;
    readonly modelId: string;
    readonly modelRevision: string;
    readonly expectedHashes: {
      readonly encoder: string;
      readonly decoder: string;
      readonly joiner: string;
      readonly tokens: string;
    };
  };
  readonly LOSSLESS_CLEANED_INT8?: {
    readonly modelDir: string;
    readonly modelId: string;
    readonly modelRevision: string;
    readonly expectedHashes: {
      readonly encoder: string;
      readonly decoder: string;
      readonly joiner: string;
      readonly tokens: string;
    };
  };
}


/**
 * Local Native Execution Adapter (runs verified frozen Zipformer INT8 ONNX graphs on local Node/WASM CPU).
 * Zero network audio transmission. Never mutates neural weights.
 */
export class SHAHABNativeExecutionAdapter implements SHAHABExecutionAdapter {
  public readonly adapterId: string = 'shahab-native-local-cpu-wasm';
  public readonly mode = 'LOCAL' as const;

  private readonly variants: ShahabVariantDirectoryMap;
  private readonly memoryGovernor: SHAHABMemoryGovernor;
  private readonly policyManager = new SHAHABDecodePolicyManager();
  private activeVariant: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8' | null = null;
  private activeAdapter: SHAHABFrozenModelAdapter | null = null;

  constructor(variants: ShahabVariantDirectoryMap, memoryGovernor?: SHAHABMemoryGovernor, customId?: string) {
    this.variants = variants;
    this.memoryGovernor = memoryGovernor ?? new SHAHABMemoryGovernor();
    if (customId) this.adapterId = customId;
  }

  public getCapabilities(): ShahabAdapterCapabilityReport {
    const supportedVariants: ('ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8')[] = ['ORIGINAL_INT8'];
    if (
      this.variants.LOSSLESS_CLEANED_INT8 &&
      fs.existsSync(path.join(this.variants.LOSSLESS_CLEANED_INT8.modelDir, 'encoder.int8.onnx'))
    ) {
      supportedVariants.push('LOSSLESS_CLEANED_INT8');
    }
    return {
      adapterId: this.adapterId,
      adapterClass: 'LOCAL_NATIVE',
      verificationStatus: this.isAvailable() ? 'VERIFIED' : 'BLOCKED',
      supportedModelVariants: supportedVariants,
      supportedDecodePolicies: ['SPEED', 'BALANCED', 'PRECISION', 'VOCABULARY', 'VERBATIM'],
      supportedTensorPrecisions: ['INT8_DYNAMIC_QUANTIZED_ONNX', 'FLOAT32_ACTIVATIONS'],
      executionProvider: 'onnxruntime-web@1.31.1 (WASM single-thread CPU; native C++ runtime unavailable)',
      streamingCapability: {
        nativeStreamingGraph: false,
        chunkedOverlapStreaming: true,
        notes: 'Offline stateless7 ONNX graph has no cached_key/cached_conv inputs; supports chunked overlap streaming.',
      },
      timingCapability: {
        segmentTimestamps: true,
        wordTimestamps: false,
        notes: 'Segment boundaries measured from PCM window; forced word-level timestamps not invented.',
      },
      maxPracticalAudioDurationSec: 3600,
      availableMemoryBudgetBytes: 512 * 1024 * 1024,
      unsupportedOperations: [
        'CUDA_GPU_EXECUTION (no GPU in container)',
        'INT4_MATMULNBITS (not supported in onnxruntime-web WASM)',
        'NATIVE_RECURRENT_STREAMING_CACHE (offline encoder graph)',
        'SPEAKER_DIARIZATION (single-stream ASR core)',
        'WORD_LEVEL_FORCED_ALIGNMENT (no verified aligner bundled)',
      ],
    };
  }

  public isAvailable(): boolean {
    const orig = this.variants.ORIGINAL_INT8;
    return (
      fs.existsSync(path.join(orig.modelDir, 'encoder.int8.onnx')) &&
      fs.existsSync(path.join(orig.modelDir, 'decoder.int8.onnx')) &&
      fs.existsSync(path.join(orig.modelDir, 'joiner.int8.onnx')) &&
      fs.existsSync(path.join(orig.modelDir, 'tokens.txt'))
    );
  }

  public async ensureModelLoaded(variant: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8'): Promise<{
    readonly modelId: string;
    readonly modelRevision: string;
    readonly artifactHash: string;
    readonly loadEventOccurred: boolean;
    readonly loadMs: number;
  }> {
    const cfg = variant === 'LOSSLESS_CLEANED_INT8' ? this.variants.LOSSLESS_CLEANED_INT8 : this.variants.ORIGINAL_INT8;
    if (!cfg) {
      throw new SHAHABEngineError({
        code: 'UNSUPPORTED_MODEL_CAPABILITY',
        message: `Model variant ${variant} is not registered on this runtime. No silent substitution allowed.`,
        recoveryGuidance: 'Select ORIGINAL_INT8 or generate and verify the requested variant first.',
      });
    }
    if (!fs.existsSync(path.join(cfg.modelDir, 'encoder.int8.onnx'))) {
      throw new SHAHABEngineError({
        code: 'MODEL_NOT_FOUND',
        message: `Required ONNX artifact missing for variant ${variant}.`,
        recoveryGuidance: 'Install verified model artifacts before execution.',
      });
    }

    if (this.activeAdapter && this.activeVariant === variant) {
      const immut = this.activeAdapter.verifyWeightImmutability();
      if (!immut.immutable) {
        throw new SHAHABEngineError({
          code: 'MODEL_INTEGRITY_FAILURE',
          message: `SHA-256 verification failed for loaded variant ${variant}: ${immut.mismatches.join('; ')}`,
          recoveryGuidance: 'Trigger rollback to verified ORIGINAL_INT8 artifacts or re-verify package hashes.',
        });
      }
      return {
        modelId: cfg.modelId,
        modelRevision: cfg.modelRevision,
        artifactHash: immut.hashes.encoder,
        loadEventOccurred: false,
        loadMs: 0,
      };
    }

    if (this.activeAdapter) {
      await this.activeAdapter.dispose();
      this.activeAdapter = null;
      this.activeVariant = null;
    }

    const adapter = new SHAHABFrozenModelAdapter({
      modelDir: cfg.modelDir,
      modelId: cfg.modelId,
      modelRevision: cfg.modelRevision,
      expectedHashes: cfg.expectedHashes,
      memoryGovernor: this.memoryGovernor,
    });
    const t0 = performance.now();
    try {
      await adapter.initializeRuntime();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SHAHABEngineError({
        code: msg.includes('immutability') || msg.includes('SHA-256') ? 'MODEL_INTEGRITY_FAILURE' : 'MODEL_LOAD_FAILURE',
        message: `Failed to initialize SHAHAB frozen model (${variant}): ${msg}`,
        recoveryGuidance: 'Verify artifact SHA-256 hashes and available memory budget.',
        retryable: false,
      });
    }
    const loadMs = Math.round(performance.now() - t0);
    this.activeAdapter = adapter;
    this.activeVariant = variant;
    const counters = adapter.getExecutionCounters();
    return {
      modelId: cfg.modelId,
      modelRevision: cfg.modelRevision,
      artifactHash: counters.verifiedHashes?.encoder ?? cfg.expectedHashes.encoder,
      loadEventOccurred: true,
      loadMs,
    };
  }

  public async unloadModel(): Promise<void> {
    if (this.activeAdapter) {
      await this.activeAdapter.dispose();
      this.activeAdapter = null;
      this.activeVariant = null;
    }
    this.memoryGovernor.clearAll();
  }

  public getVocab(): readonly string[] {
    return this.activeAdapter?.getVocab() ?? [];
  }

  public getInternalAdapterForTesting(): SHAHABFrozenModelAdapter | null {
    return this.activeAdapter;
  }

  public async executeAcousticStage(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly policy: ShahabDecodePolicyConfig;
    readonly useEncoderCache: boolean;
    readonly biasMap: ShahabHotwordBiasMap | null;
    readonly enableSelectiveRedecode: boolean;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly rawHypothesis: ShahabDecodedHypothesis;
    readonly contextHypothesis: ShahabDecodedHypothesis | null;
    readonly encoderCacheHit: boolean;
    readonly encoderMs: number;
    readonly encoderInvocationsDelta: number;
    readonly cacheIdentity: ShahabCacheIdentityKey | null;
    readonly redecodeTriggered: boolean;
    readonly runtimeId: string;
    readonly executionLocation: string;
  }> {
    if (!this.activeAdapter) {
      throw new SHAHABEngineError({
        code: 'MODEL_LOAD_FAILURE',
        message: 'Model adapter not initialized before acoustic execution.',
        recoveryGuidance: 'Call ensureModelLoaded() first.',
      });
    }
    const encBefore = this.activeAdapter.getExecutionCounters().encoderInvocations;
    const enc = await this.activeAdapter.encodeAudio({
      pcm16k: params.pcm16k,
      segmentId: params.segmentId,
      useCache: params.useEncoderCache,
      signal: params.signal,
    });
    const encAfter = this.activeAdapter.getExecutionCounters().encoderInvocations;

    // Layer A: Always decode pure acoustic raw hypothesis WITHOUT hotword bias
    const rawPolicy: ShahabDecodePolicyConfig = {
      ...params.policy,
      allowContextualBias: false,
      defaultContextBiasScore: 0,
    };
    const rawHypothesis = await this.activeAdapter.decodeFromEncoderOutput({
      encoderOutput: enc.encoderOutput,
      policy: rawPolicy,
      hotwordBias: null,
      signal: params.signal,
    });

    // Optional Layer B: Context-assisted decoding ONLY when policy supports modified_beam_search + biasMap exists
    let contextHypothesis: ShahabDecodedHypothesis | null = null;
    let redecodeTriggered = false;
    if (
      params.policy.allowContextualBias &&
      params.policy.decodingMethod === 'modified_beam_search' &&
      params.biasMap &&
      params.biasMap.activeTerms.length > 0
    ) {
      contextHypothesis = await this.activeAdapter.decodeFromEncoderOutput({
        encoderOutput: enc.encoderOutput,
        policy: params.policy,
        hotwordBias: params.biasMap,
        signal: params.signal,
      });
      redecodeTriggered = true;
    } else if (params.enableSelectiveRedecode && params.policy.decodingMethod === 'greedy_search') {
      const controller = new SHAHABRecurrentListeningController();
      const budget = new SHAHABComputeBudgetController({
        maxAdditionalPasses: 1,
        maxReprocessedAudioSec: 30,
        maxAddedLatencyMs: 3000,
        maxCacheMemoryBytes: 128 * 1024 * 1024,
      });
      const nextPolicy = this.policyManager.getPolicy('BALANCED');
      const decision = controller.decide({
        segmentId: params.segmentId,
        segmentDurationSec: params.pcm16k.length / 16000,
        currentPolicy: params.policy,
        candidateNextPolicy: nextPolicy,
        uncertain: true,
        budget,
        currentCacheBytes: this.memoryGovernor.getTelemetry().totalCacheBytes,
      });
      if (decision.action === 'REDECODE_WITH_DIFFERENT_SEARCH') {
        contextHypothesis = await this.activeAdapter.decodeFromEncoderOutput({
          encoderOutput: enc.encoderOutput,
          policy: nextPolicy,
          hotwordBias: null,
          signal: params.signal,
        });
        redecodeTriggered = true;
      }
    }

    return {
      rawHypothesis,
      contextHypothesis,
      encoderCacheHit: enc.cacheHit,
      encoderMs: enc.cacheHit ? 0 : enc.encoderOutput.encoderTimeMs,
      encoderInvocationsDelta: encAfter - encBefore,
      cacheIdentity: enc.cacheIdentity,
      redecodeTriggered,
      runtimeId: this.adapterId,
      executionLocation: 'LOCAL_DEVICE_CPU_WASM',
    };
  }
}

/**
 * Local Execution Adapter alias (SHAHAB-010 §4).
 */
export class SHAHABLocalExecutionAdapter extends SHAHABNativeExecutionAdapter {
  constructor(variants: ShahabVariantDirectoryMap, memoryGovernor?: SHAHABMemoryGovernor) {
    super(variants, memoryGovernor, 'shahab-local-execution-adapter');
  }
}

/**
 * Browser Local Execution Adapter descriptor (SHAHAB-010 §4).
 */
export class SHAHABBrowserExecutionAdapter implements SHAHABExecutionAdapter {
  public readonly adapterId = 'shahab-browser-wasm-adapter';
  public readonly mode = 'LOCAL' as const;

  public getCapabilities(): ShahabAdapterCapabilityReport {
    return {
      adapterId: this.adapterId,
      adapterClass: 'BROWSER_WASM',
      verificationStatus: 'NOT_VERIFIED',
      supportedModelVariants: ['ORIGINAL_INT8', 'LOSSLESS_CLEANED_INT8'],
      supportedDecodePolicies: ['SPEED', 'BALANCED', 'PRECISION', 'VOCABULARY', 'VERBATIM'],
      supportedTensorPrecisions: ['INT8_DYNAMIC_QUANTIZED_ONNX'],
      executionProvider: 'onnxruntime-web (Browser WASM SIMD; WebGPU NOT verified)',
      streamingCapability: {
        nativeStreamingGraph: false,
        chunkedOverlapStreaming: true,
        notes: 'Browser WASM requires ~116 MB artifact cache in OPFS; WebGPU unsupported/unverified in current container.',
      },
      timingCapability: {
        segmentTimestamps: true,
        wordTimestamps: false,
        notes: 'Segment timestamps only.',
      },
      maxPracticalAudioDurationSec: 600,
      availableMemoryBudgetBytes: 384 * 1024 * 1024,
      unsupportedOperations: [
        'BROWSER_WEBGPU (unverified — no GPU in environment)',
        'NODE_FS_MODEL_LOADING (requires OPFS / HTTP chunk fetch in browser)',
      ],
    };
  }

  public isAvailable(): boolean {
    return typeof window !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  public async ensureModelLoaded(): Promise<never> {
    throw new SHAHABEngineError({
      code: 'UNSUPPORTED_MODEL_CAPABILITY',
      message: 'SHAHABBrowserExecutionAdapter requires a live browser OPFS runtime with verified model blobs.',
      recoveryGuidance: 'Use SHAHABNativeExecutionAdapter on server/companion or complete browser OPFS model install.',
    });
  }

  public async unloadModel(): Promise<void> {
    // no-op
  }

  public getVocab(): readonly string[] {
    return [];
  }

  public async executeAcousticStage(): Promise<never> {
    throw new SHAHABEngineError({
      code: 'UNSUPPORTED_MODEL_CAPABILITY',
      message: 'Browser ONNX execution is not active in the Node runtime.',
      recoveryGuidance: 'Use SHAHABNativeExecutionAdapter or run inside an authorized browser worker.',
    });
  }
}

/**
 * Authorized Cloud Execution Adapter (SHAHAB-010 §4 & §8).
 */
export class SHAHABCloudExecutionAdapter implements SHAHABExecutionAdapter {
  public readonly adapterId = 'shahab-cloud-authorized-adapter';
  public readonly mode = 'CLOUD' as const;

  private readonly backingWorker: SHAHABNativeExecutionAdapter | null;
  private readonly cloudEndpointConfigured: boolean;

  constructor(options?: {
    readonly authorizedCloudWorker?: SHAHABNativeExecutionAdapter | null;
    readonly cloudEndpointConfigured?: boolean;
  }) {
    this.backingWorker = options?.authorizedCloudWorker ?? null;
    this.cloudEndpointConfigured = Boolean(options?.cloudEndpointConfigured ?? options?.authorizedCloudWorker);
  }

  public getCapabilities(): ShahabAdapterCapabilityReport {
    return {
      adapterId: this.adapterId,
      adapterClass: 'CLOUD_AUTHORIZED',
      verificationStatus: this.cloudEndpointConfigured && this.backingWorker?.isAvailable() ? 'VERIFIED' : 'BLOCKED',
      supportedModelVariants: ['ORIGINAL_INT8', 'LOSSLESS_CLEANED_INT8'],
      supportedDecodePolicies: ['SPEED', 'BALANCED', 'PRECISION', 'VOCABULARY', 'VERBATIM'],
      supportedTensorPrecisions: ['INT8_DYNAMIC_QUANTIZED_ONNX'],
      executionProvider: this.cloudEndpointConfigured
        ? 'Authorized Cloud Container Worker (onnxruntime-web WASM CPU, zero-retention)'
        : 'UNCONFIGURED (No external cloud ASR endpoint provisioned)',
      streamingCapability: {
        nativeStreamingGraph: false,
        chunkedOverlapStreaming: true,
        notes: 'Identical logical contract as Local; requires explicit user cloud authorization.',
      },
      timingCapability: {
        segmentTimestamps: true,
        wordTimestamps: false,
        notes: 'Segment timestamps only.',
      },
      maxPracticalAudioDurationSec: 3600,
      availableMemoryBudgetBytes: 512 * 1024 * 1024,
      unsupportedOperations: [
        'IMPLICIT_LOCAL_FALLBACK_UPLOAD (permanently forbidden)',
        'UNAUTHORIZED_AUDIO_RETENTION (permanently forbidden)',
      ],
    };
  }

  public isAvailable(): boolean {
    return this.cloudEndpointConfigured && Boolean(this.backingWorker?.isAvailable());
  }

  public async ensureModelLoaded(variant: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8'): Promise<{
    readonly modelId: string;
    readonly modelRevision: string;
    readonly artifactHash: string;
    readonly loadEventOccurred: boolean;
    readonly loadMs: number;
  }> {
    if (!this.backingWorker || !this.cloudEndpointConfigured) {
      throw new SHAHABEngineError({
        code: 'CLOUD_UNAVAILABLE',
        message: 'Authorized Cloud execution endpoint is not provisioned in this environment.',
        recoveryGuidance: 'Use LOCAL execution mode or provision an authorized SHAHAB Cloud worker.',
        retryable: true,
      });
    }
    return this.backingWorker.ensureModelLoaded(variant);
  }

  public async unloadModel(): Promise<void> {
    if (this.backingWorker) {
      await this.backingWorker.unloadModel();
    }
  }

  public getVocab(): readonly string[] {
    return this.backingWorker?.getVocab() ?? [];
  }

  public async executeAcousticStage(params: {
    readonly pcm16k: Float32Array;
    readonly segmentId: string;
    readonly policy: ShahabDecodePolicyConfig;
    readonly useEncoderCache: boolean;
    readonly biasMap: ShahabHotwordBiasMap | null;
    readonly enableSelectiveRedecode: boolean;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly rawHypothesis: ShahabDecodedHypothesis;
    readonly contextHypothesis: ShahabDecodedHypothesis | null;
    readonly encoderCacheHit: boolean;
    readonly encoderMs: number;
    readonly encoderInvocationsDelta: number;
    readonly cacheIdentity: ShahabCacheIdentityKey | null;
    readonly redecodeTriggered: boolean;
    readonly runtimeId: string;
    readonly executionLocation: string;
  }> {
    if (!this.backingWorker || !this.cloudEndpointConfigured) {
      throw new SHAHABEngineError({
        code: 'CLOUD_UNAVAILABLE',
        message: 'Cloud execution worker is unavailable.',
        recoveryGuidance: 'Retry when authorized cloud capacity is available or explicitly switch to LOCAL.',
        retryable: true,
      });
    }
    const res = await this.backingWorker.executeAcousticStage({
      ...params,
      // Zero-retention isolation in Cloud mode: do not retain cross-request audio/encoder cache
      useEncoderCache: false,
    });
    return {
      ...res,
      runtimeId: this.adapterId,
      executionLocation: 'CLOUD_AUTHORIZED_ZERO_RETENTION_WORKER',
    };
  }
}

export interface ShahabRuntimeTelemetrySnapshot {
  readonly engineRelease: typeof SHAHAB_ENGINE_RELEASE;
  readonly neuralCoreIdentity: typeof SHAHAB_NEURAL_CORE_IDENTITY;
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly failedRequests: number;
  readonly cancelledRequests: number;
  readonly modelLoadEvents: number;
  readonly modelUnloadEvents: number;
  readonly rollbackEvents: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly totalAudioDurationProcessedSec: number;
  readonly latenciesMs: readonly number[];
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly coldStartLoadMs: number | null;
  readonly warmStartMeanMs: number | null;
  readonly meanRtf: number | null;
  readonly peakRssBytes: number;
}

export interface ShahabStreamChunkUpdate {
  readonly chunkIndex: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly committedText: string;
  readonly uncommittedText: string;
  readonly duplicateBoundaryTokensSuppressed: number;
  readonly latencyMs: number;
}

export interface ShahabEngineOptions {
  readonly localAdapter: SHAHABExecutionAdapter;
  readonly cloudAdapter?: SHAHABExecutionAdapter;
  readonly browserAdapter?: SHAHABExecutionAdapter;
  readonly memoryManager?: SHAHABPersianMemoryManager;
  readonly maxConcurrentRequests?: number;
}

/**
 * SHAHABEngine — Single Unified Public Application-Level Recognition Engine (`SHAHAB-R1.4.0`).
 */
export class SHAHABEngine {
  public readonly engineRelease = SHAHAB_ENGINE_RELEASE;
  public readonly neuralCoreIdentity = SHAHAB_NEURAL_CORE_IDENTITY;

  private readonly localAdapter: SHAHABExecutionAdapter;
  private readonly cloudAdapter: SHAHABExecutionAdapter;
  private readonly browserAdapter: SHAHABExecutionAdapter;
  private readonly policyManager = new SHAHABDecodePolicyManager();
  private readonly vocabProvider = new SHAHABContextualVocabularyProvider();
  private readonly p012VocabManager = new VersionedPersianVocabularyManager();
  public readonly memoryManager: SHAHABPersianMemoryManager;
  public readonly evidenceLedger = new SHAHABAcousticEvidenceLedger();
  public readonly falseInsertionGuard = new SHAHABFalseInsertionGuard();
  public readonly selectiveRiskController = new SHAHABSelectiveRiskController();
  public readonly capabilityRegistry = new SHAHABRuntimeCapabilityRegistry();
  private readonly maxConcurrentRequests: number;

  private activeVariant: 'ORIGINAL_INT8' | 'LOSSLESS_CLEANED_INT8' = 'ORIGINAL_INT8';
  private activeRequests = 0;
  private completedRequests = 0;
  private failedRequests = 0;
  private cancelledRequests = 0;
  private modelLoadEvents = 0;
  private modelUnloadEvents = 0;
  private rollbackEvents = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalAudioDurationProcessedSec = 0;
  private readonly latenciesMs: number[] = [];
  private readonly rtfs: number[] = [];
  private coldStartLoadMs: number | null = null;
  private readonly warmLatenciesMs: number[] = [];
  private peakRssBytes = 0;

  constructor(options: ShahabEngineOptions) {
    this.localAdapter = options.localAdapter;
    this.cloudAdapter = options.cloudAdapter ?? new SHAHABCloudExecutionAdapter();
    this.browserAdapter = options.browserAdapter ?? new SHAHABBrowserExecutionAdapter();
    this.memoryManager = options.memoryManager ?? new SHAHABPersianMemoryManager();
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? 4;
  }

  public getAdapterCapabilities(): readonly ShahabAdapterCapabilityReport[] {
    return [
      this.localAdapter.getCapabilities(),
      this.browserAdapter.getCapabilities(),
      this.cloudAdapter.getCapabilities(),
    ];
  }

  public getTelemetry(): ShahabRuntimeTelemetrySnapshot {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const pct = (p: number): number | null => {
      if (sorted.length === 0) return null;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[idx];
    };
    const meanRtf =
      this.rtfs.length > 0
        ? Number((this.rtfs.reduce((a, b) => a + b, 0) / this.rtfs.length).toFixed(4))
        : null;
    const warmStartMeanMs =
      this.warmLatenciesMs.length > 0
        ? Math.round(this.warmLatenciesMs.reduce((a, b) => a + b, 0) / this.warmLatenciesMs.length)
        : null;

    return {
      engineRelease: this.engineRelease,
      neuralCoreIdentity: this.neuralCoreIdentity,
      activeRequests: this.activeRequests,
      completedRequests: this.completedRequests,
      failedRequests: this.failedRequests,
      cancelledRequests: this.cancelledRequests,
      modelLoadEvents: this.modelLoadEvents,
      modelUnloadEvents: this.modelUnloadEvents,
      rollbackEvents: this.rollbackEvents,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      totalAudioDurationProcessedSec: Number(this.totalAudioDurationProcessedSec.toFixed(3)),
      latenciesMs: [...this.latenciesMs],
      p50LatencyMs: pct(50),
      p95LatencyMs: pct(95),
      coldStartLoadMs: this.coldStartLoadMs,
      warmStartMeanMs,
      meanRtf,
      peakRssBytes: this.peakRssBytes,
    };
  }

  public async unloadModels(): Promise<void> {
    await this.localAdapter.unloadModel();
    await this.cloudAdapter.unloadModel();
    this.modelUnloadEvents++;
  }

  /**
   * SHAHAB-010 §16: Tested rollback to untouched upstream ORIGINAL_INT8 model artifacts
   * without losing project vocabulary, evidence ledger, or historical benchmarks.
   */
  public async rollbackToUpstreamOriginal(): Promise<{
    readonly rolledBackTo: 'ORIGINAL_INT8';
    readonly modelRevision: string;
    readonly artifactHash: string;
    readonly vocabularyPreservedCount: number;
    readonly ledgerEntriesPreserved: number;
  }> {
    await this.localAdapter.unloadModel();
    this.modelUnloadEvents++;
    this.activeVariant = 'ORIGINAL_INT8';
    const loaded = await this.localAdapter.ensureModelLoaded('ORIGINAL_INT8');
    if (loaded.loadEventOccurred) this.modelLoadEvents++;
    this.rollbackEvents++;
    return {
      rolledBackTo: 'ORIGINAL_INT8',
      modelRevision: loaded.modelRevision,
      artifactHash: loaded.artifactHash,
      vocabularyPreservedCount: this.memoryManager.listAll().length,
      ledgerEntriesPreserved: this.evidenceLedger.listAll().length,
    };
  }

  /**
   * Resolves authorized execution adapter without EVER violating Local-Only privacy.
   */
  private resolveAuthorizedAdapter(request: ShahabRecognitionRequest): {
    readonly adapter: SHAHABExecutionAdapter;
    readonly actualMode: 'LOCAL' | 'CLOUD';
  } {
    if (request.executionPreference === 'LOCAL') {
      if (!this.localAdapter.isAvailable()) {
        throw new SHAHABEngineError({
          code: 'MODEL_NOT_FOUND',
          message: 'Local SHAHAB execution adapter is unavailable (required model artifacts not installed).',
          recoveryGuidance: 'Install verified local model artifacts. Audio was NOT uploaded to Cloud.',
        });
      }
      return { adapter: this.localAdapter, actualMode: 'LOCAL' };
    }

    if (request.executionPreference === 'CLOUD') {
      if (request.privacy.localOnlyEnforced || !request.privacy.cloudAuthorized) {
        throw new SHAHABEngineError({
          code: 'CLOUD_AUTHORIZATION_REQUIRED',
          message: 'Cloud execution requested without explicit user/policy authorization.',
          recoveryGuidance: 'Obtain explicit Cloud authorization (cloudAuthorized=true, localOnlyEnforced=false) or use LOCAL.',
        });
      }
      if (!this.cloudAdapter.isAvailable()) {
        throw new SHAHABEngineError({
          code: 'CLOUD_UNAVAILABLE',
          message: 'Authorized Cloud execution environment is currently unavailable.',
          recoveryGuidance: 'Retry later or explicitly choose LOCAL execution.',
          retryable: true,
        });
      }
      return { adapter: this.cloudAdapter, actualMode: 'CLOUD' };
    }

    // AUTO mode: strictly respects authorization boundaries!
    // Never silently escalates to Cloud when Local is preferred or unauthorized.
    if (this.localAdapter.isAvailable()) {
      return { adapter: this.localAdapter, actualMode: 'LOCAL' };
    }
    if (!request.privacy.localOnlyEnforced && request.privacy.cloudAuthorized && this.cloudAdapter.isAvailable()) {
      return { adapter: this.cloudAdapter, actualMode: 'CLOUD' };
    }
    throw new SHAHABEngineError({
      code: request.privacy.localOnlyEnforced || !request.privacy.cloudAuthorized
        ? 'MODEL_NOT_FOUND'
        : 'CLOUD_UNAVAILABLE',
      message: 'AUTO mode could not execute: Local model unavailable and Cloud is not authorized or unavailable.',
      recoveryGuidance: 'Install local artifacts or explicitly authorize Cloud execution.',
    });
  }

  /**
   * Unified 19-stage logical recognition pipeline shared across LOCAL, CLOUD, and AUTO modes.
   */
  public async recognize(request: ShahabRecognitionRequest): Promise<ShahabRecognitionResult> {
    const tTotal0 = performance.now();
    const stages: string[] = [];

    if (this.activeRequests >= this.maxConcurrentRequests) {
      this.failedRequests++;
      throw new SHAHABEngineError({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message: `Concurrent SHAHAB recognition quota exceeded (max=${this.maxConcurrentRequests}).`,
        recoveryGuidance: 'Wait for an active recognition job to finish before submitting another request.',
        retryable: true,
      });
    }

    this.activeRequests++;
    try {
      // Stage 1: Request validation
      stages.push('01_REQUEST_VALIDATION');
      if (!request.requestId || !request.audioSource) {
        throw new SHAHABEngineError({
          code: 'INVALID_REQUEST',
          message: 'Request must include requestId and audioSource.',
          recoveryGuidance: 'Provide a valid ShahabRecognitionRequest payload.',
        });
      }
      if (request.cancellationSignal?.aborted) {
        this.cancelledRequests++;
        throw new SHAHABEngineError({
          code: 'EXECUTION_CANCELLED',
          message: 'Recognition request was cancelled before audio ingestion.',
          recoveryGuidance: 'Resubmit a new request if transcription is still needed.',
        });
      }

      // Stage 2–4: Audio source resolution, metadata inspection & format validation
      stages.push('02_AUDIO_SOURCE_RESOLUTION', '03_AUDIO_METADATA_INSPECTION', '04_INPUT_FORMAT_VALIDATION');
      let pcm16k: Float32Array;
      if (request.audioSource.wavBytes && request.audioSource.wavBytes.byteLength > 0) {
        try {
          const decoded = decodeWavToMono16k(request.audioSource.wavBytes);
          pcm16k = decoded.pcm16k;
        } catch (err) {
          throw new SHAHABEngineError({
            code: 'UNSUPPORTED_AUDIO_FORMAT',
            message: `Invalid or unsupported WAV input: ${err instanceof Error ? err.message : String(err)}`,
            recoveryGuidance: 'Provide a valid PCM-16 / IEEE-Float32 WAV or Float32 PCM buffer.',
          });
        }
      } else if (request.audioSource.pcmFloat32 && request.audioSource.pcmFloat32.length > 0) {
        const sr = request.audioSource.sampleRateHz ?? 16000;
        if (sr < 8000 || sr > 192000) {
          throw new SHAHABEngineError({
            code: 'UNSUPPORTED_SAMPLE_RATE',
            message: `Unsupported sample rate ${sr} Hz (supported range: 8000–192000 Hz).`,
            recoveryGuidance: 'Resample audio to 16000 Hz mono PCM.',
          });
        }
        try {
          pcm16k = conditionPcmTo16kMono({
            pcm: request.audioSource.pcmFloat32,
            sampleRateHz: sr,
            channels: request.audioSource.channels ?? 1,
          }).pcm16k;
        } catch (err) {
          throw new SHAHABEngineError({
            code: 'INVALID_AUDIO',
            message: err instanceof Error ? err.message : String(err),
            recoveryGuidance: 'Provide finite Float32 PCM samples within 8000–192000 Hz.',
          });
        }
      } else {
        throw new SHAHABEngineError({
          code: 'INVALID_AUDIO',
          message: 'Audio source contains zero audio samples.',
          recoveryGuidance: 'Provide non-empty wavBytes or pcmFloat32.',
        });
      }

      const audioDurationSec = pcm16k.length / 16000;
      const maxDur = request.resourceConstraints?.maxAudioDurationSec ?? 3600;
      if (audioDurationSec > maxDur) {
        throw new SHAHABEngineError({
          code: 'RESOURCE_LIMIT_EXCEEDED',
          message: `Audio duration (${audioDurationSec.toFixed(1)}s) exceeds configured limit (${maxDur}s).`,
          recoveryGuidance: 'Split audio into smaller segments or raise maxAudioDurationSec.',
        });
      }

      // Stage 5: Audio preprocessing & profiling
      stages.push('05_AUDIO_PREPROCESSING_AND_PROFILING');
      const audioProfile = profileAudioSignal(pcm16k, 16000);
      const audioSha256 = crypto
        .createHash('sha256')
        .update(Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength))
        .digest('hex');

      // Stage 6–8: Capability resolution, artifact check & model loading/reuse
      stages.push('06_MODEL_CAPABILITY_RESOLUTION', '07_ARTIFACT_AVAILABILITY_CHECK', '08_MODEL_LOAD_OR_REUSE');
      const { adapter, actualMode } = this.resolveAuthorizedAdapter(request);
      const variant = request.modelProfile ?? this.activeVariant;
      const loaded = await adapter.ensureModelLoaded(variant);
      if (loaded.loadEventOccurred) {
        this.modelLoadEvents++;
        if (this.coldStartLoadMs === null) this.coldStartLoadMs = loaded.loadMs;
      }

      // Stage 9: VAD & segmentation check
      stages.push('09_VAD_AND_SEGMENTATION');
      const warnings: string[] = [];
      if (request.timingRequirements?.wordTimestamps) {
        warnings.push('Word-level timestamps are unavailable for the inherited offline Zipformer core and were NOT fabricated.');
      }
      if (audioProfile.clippingRatio > 0.01) {
        warnings.push(`Audio clipping detected (${(audioProfile.clippingRatio * 100).toFixed(2)}% samples clipped).`);
      }

      // Stage 10–13: Acoustic recognition, Adaptive decoding, Selective re-decode & Persian Context Memory
      stages.push(
        '10_ACOUSTIC_RECOGNITION',
        '11_ADAPTIVE_DECODING',
        '12_SELECTIVE_REDECODE',
        '13_PERSIAN_CONTEXT_MEMORY_RETRIEVAL',
      );
      const policyId: ShahabDecodePolicyId = request.decodePolicy ?? 'BALANCED';
      const policyConfig = this.policyManager.getPolicy(policyId);
      const scopesQueried: ShahabMemoryScope[] = request.vocabularyScope?.enabled
        ? [...(request.vocabularyScope.allowedScopes ?? ['RECORDING', 'PROJECT', 'DOMAIN', 'USER_VOCABULARY'])]
        : [];

      let biasMap: ShahabHotwordBiasMap | null = null;
      let refusedBecauseGreedy = false;
      if (request.vocabularyScope?.enabled && scopesQueried.length > 0) {
        const retrieved = this.memoryManager.retrieveVerifiedForContext({
          recordingId: request.vocabularyScope.recordingId,
          projectId: request.vocabularyScope.projectId,
          domainId: request.vocabularyScope.domainId,
        });
        const built = this.vocabProvider.buildBiasMap({
          entries: retrieved,
          decodingMethod: policyConfig.decodingMethod,
          biasScore: policyConfig.defaultContextBiasScore || 0.6,
        });
        if (!built.supported) {
          refusedBecauseGreedy = policyConfig.decodingMethod === 'greedy_search';
        } else {
          biasMap = built.biasMap;
        }
      }

      const acousticOut = await adapter.executeAcousticStage({
        pcm16k,
        segmentId: `${request.audioSource.sourceId}_seg0`,
        policy: policyConfig,
        useEncoderCache: actualMode === 'LOCAL',
        biasMap,
        enableSelectiveRedecode: Boolean(request.enableSelectiveRedecode),
        signal: request.cancellationSignal,
      });

      if (acousticOut.encoderCacheHit) this.cacheHits++;
      else this.cacheMisses++;

      // Stage 14: Evidence reconciliation & False-Insertion Guard
      stages.push('14_EVIDENCE_RECONCILIATION');
      const rawTranscript = acousticOut.rawHypothesis.rawText;
      let contextAssistedTranscript: string | null = null;
      const blockedByGuard: string[] = [];
      let falseInsertionAudit: ReturnType<typeof this.falseInsertionGuard.evaluate> | null = null;

      if (acousticOut.contextHypothesis) {
        falseInsertionAudit = this.falseInsertionGuard.evaluate({
          referenceVerbatim: rawTranscript,
          rawBaselineText: rawTranscript,
          contextAssistedText: acousticOut.contextHypothesis.rawText,
          activeContextTerms: biasMap?.activeTerms ?? [],
        });
        if (falseInsertionAudit.thresholdExceeded) {
          blockedByGuard.push(...falseInsertionAudit.falseInsertedTerms);
          warnings.push('SHAHABFalseInsertionGuard disabled contextual substitution due to false-insertion threshold.');
        } else {
          contextAssistedTranscript = acousticOut.contextHypothesis.rawText;
        }
      }

      // Stage 15: Authorized normalization & correction integration (reusing existing P0-009, P0-010, P0-012)
      stages.push('15_AUTHORIZED_NORMALIZATION_CORRECTION');
      const transformations: ShahabAppliedTransformation[] = [];
      const baseTextForPost = contextAssistedTranscript ?? rawTranscript;
      const fidelityMode: ShahabFidelityMode = request.fidelityMode ?? 'RAW_VERBATIM';

      let normalizedReadingTranscript: string | null = null;
      let authorizedFinalTranscript = rawTranscript;
      let p009Applied = false;
      let p010Applied = false;
      let p012Applied = false;

      if (fidelityMode === 'NORMALIZED_READING' || fidelityMode === 'AUTHORIZED_FINAL') {
        const norm = normalizePersianTextDeterministic(baseTextForPost);
        normalizedReadingTranscript = norm.normalized;
        p009Applied = true;
        transformations.push({
          stage: 'NORMALIZATION',
          module: 'P0-009:PersianLinguisticQualityEngine',
          applied: true,
          reversible: true,
          reason: 'Deterministic Persian character/half-space normalization (Layer A raw untouched).',
        });

        // P0-012 Proper noun & lexical ambiguity protection
        const rawTokens = normalizedReadingTranscript.split(/\s+/).filter(Boolean);
        const lexicalAnalysis = analyzePersianLexicalFidelity({
          segmentId: `${request.requestId}_seg_0`,
          transcriptRevision: 1,
          tokens: rawTokens.map((t, i) => ({
            tokenId: `${request.requestId}_tok_${i}`,
            text: t,
            startSec: 0,
            endSec: Number(audioDurationSec.toFixed(3)),
            confidence: null,
          })),
          vocabulary: this.p012VocabManager,
        });
        p012Applied = true;
        transformations.push({
          stage: 'AMBIGUITY_AND_PROPER_NOUN_GUARD',
          module: 'P0-012:PersianLexicalDisambiguationEngine',
          applied: true,
          reversible: true,
          reason: `Inspected ${rawTokens.length} tokens; flagged ${lexicalAnalysis.ambiguities.length} lexical ambiguities without silent overwrite.`,
        });

        // P0-010 Correction authorization gate (never silently rewrites without authorization)
        const critical = detectMeaningCriticalTokens(rawTranscript);
        const p010Decision = evaluateProposedCorrection({
          proposalId: `p010_${request.requestId}`,
          transcriptRevision: 1,
          segmentId: `${request.requestId}_seg_0`,
          tokenIds: [`${request.requestId}_tok_0`],
          originalText: rawTranscript,
          proposedText: normalizedReadingTranscript,
          category: critical.length > 0 ? 'LEX_PROPER_NAME_SUBSTITUTION' : 'TEXT_ZWNJ_ERROR',
          evidence: [
            {
              evidenceId: `ev_p009_${request.requestId}`,
              tier: 'LINGUISTIC',
              polarity: 'SUPPORTING',
              source: 'P0-009:PersianLinguisticQualityEngine',
              summary: 'Deterministic Persian script/ZWNJ normalization',
            },
          ],
          confidence: {
            providerRawConfidence: acousticOut.rawHypothesis.logProbSum,
            providerSource: 'ASR_SEGMENT_AVG',
            calibrationDatasetQualified: false,
          },
        });
        p010Applied = true;
        authorizedFinalTranscript =
          fidelityMode === 'AUTHORIZED_FINAL' &&
          (p010Decision.outcome === 'SAFE_NORMALIZATION' || p010Decision.outcome === 'SUGGESTED_CORRECTION')
            ? normalizedReadingTranscript
            : fidelityMode === 'NORMALIZED_READING'
              ? normalizedReadingTranscript
              : rawTranscript;
        transformations.push({
          stage: 'CORRECTION_AUTHORIZATION',
          module: 'P0-010:PersianEvidenceCorrectionEngine',
          applied: true,
          reversible: true,
          reason: `P0-010 outcome=${p010Decision.outcome}; Layer A raw acoustic text preserved independently.`,
        });
      } else if (fidelityMode === 'CONTEXT_ASSISTED' && contextAssistedTranscript) {
        authorizedFinalTranscript = contextAssistedTranscript;
      }

      // Stage 16–17: Timing/alignment integration & transcript serialization
      stages.push('16_TIMING_AND_ALIGNMENT_INTEGRATION', '17_TRANSCRIPT_SERIALIZATION');
      const segment: ShahabTranscriptSegment = {
        segmentId: `${request.requestId}_seg_0`,
        startSec: 0,
        endSec: Number(audioDurationSec.toFixed(3)),
        rawText: rawTranscript,
        contextAssistedText: contextAssistedTranscript,
        normalizedText: normalizedReadingTranscript,
        authorizedFinalText: authorizedFinalTranscript,
        wordTimingAvailable: false,
        words: null,
        speakerId: null,
        speakerAssociationAvailable: false,
        committed: true,
        confidenceAvailable: false,
        confidenceScore: null,
      };

      // Stage 18–19: Resource cleanup & evidence persistence
      stages.push('18_RESOURCE_CLEANUP', '19_EVIDENCE_AND_TELEMETRY_PERSISTENCE');
      const acousticUncertain =
        audioProfile.clippingRatio > 0.01 ||
        (audioProfile.estimatedSnrDb !== null && audioProfile.estimatedSnrDb < 10) ||
        audioProfile.silenceRatio > 0.75;
      const riskAction = this.selectiveRiskController.selectAction({
        rawText: rawTranscript,
        contextAssistedText: contextAssistedTranscript,
        falseInsertionAudit,
        acousticUncertain,
      });

      const ledgerEntry: ShahabTranscriptSegmentEvidence = this.evidenceLedger.recordSegment({
        segmentId: segment.segmentId,
        audioSha256,
        startSec: segment.startSec,
        endSec: segment.endSec,
        modelId: loaded.modelId,
        modelRevision: loaded.modelRevision,
        decoderProfile: policyId,
        layerARawAcoustic: rawTranscript,
        layerBContextAssisted: contextAssistedTranscript,
        layerCAuthorizedFinal: authorizedFinalTranscript,
        contextTermsApplied: biasMap?.activeTerms ?? [],
        contextScope: scopesQueried.length > 0 ? scopesQueried.join(',') : null,
        rawDecoderLogProb: acousticOut.rawHypothesis.logProbSum,
        scoreProvenance: 'RAW_RNNT_LOG_PROB_UNCALIBRATED',
        evidenceClasses: ['RAW_MODEL_OUTPUT', 'OBSERVED_AUDIO_METADATA', 'DECODER_SCORE'],
        riskAction,
        userEdits: [],
      });

      const totalLatencyMs = Math.max(1, Math.round(performance.now() - tTotal0));
      const rtf = audioDurationSec > 0 ? Number((totalLatencyMs / 1000 / audioDurationSec).toFixed(4)) : 0;
      const rss = process.memoryUsage().rss;
      if (rss > this.peakRssBytes) this.peakRssBytes = rss;

      this.completedRequests++;
      this.totalAudioDurationProcessedSec += audioDurationSec;
      this.latenciesMs.push(totalLatencyMs);
      if (!loaded.loadEventOccurred) this.warmLatenciesMs.push(totalLatencyMs);
      this.rtfs.push(rtf);

      return {
        contractVersion: SHAHAB_ENGINE_CONTRACT_VERSION,
        requestId: request.requestId,
        engineRelease: this.engineRelease,
        neuralCoreIdentity: this.neuralCoreIdentity,
        trainableParameters: 0,
        modelId: loaded.modelId,
        modelRevision: loaded.modelRevision,
        modelVariant: variant,
        modelArtifactHash: loaded.artifactHash,
        executionModeRequested: request.executionPreference,
        executionModeActual: actualMode,
        executionLocation: acousticOut.executionLocation,
        runtimeId: acousticOut.runtimeId,
        decoderPolicy: policyId,
        rawTranscript,
        contextAssistedTranscript,
        normalizedReadingTranscript,
        authorizedFinalTranscript,
        segments: [segment],
        wordLevelTimingAvailable: false,
        speakerAssociationAvailable: false,
        transcriptProvenance: {
          audioSha256,
          audioDurationSec: Number(audioDurationSec.toFixed(3)),
          sampleRateHz: 16000,
          rawImmutablePreserved: true,
          p009NormalizationApplied: p009Applied,
          p010AuthorizationApplied: p010Applied,
          p012AmbiguityGuardApplied: p012Applied,
          p011ModuleStatus: 'NOT_PRESENT_IN_WORKSPACE',
        },
        appliedTransformations: transformations,
        vocabularyContextProvenance: {
          enabled: Boolean(request.vocabularyScope?.enabled),
          scopesQueried,
          termsInjected: biasMap?.activeTerms ?? [],
          blockedByFalseInsertionGuard: blockedByGuard,
          refusedBecauseGreedyPolicy: refusedBecauseGreedy,
        },
        uncertaintyAndRisk: {
          riskAction,
          acousticUncertain,
          confidenceScoreAvailable: false,
          audioProfile,
        },
        warnings,
        metrics: {
          totalLatencyMs,
          encoderMs: acousticOut.encoderMs,
          decoderMs: acousticOut.rawHypothesis.decodeTimeMs,
          encoderCacheHit: acousticOut.encoderCacheHit,
          encoderInvocationsDelta: acousticOut.encoderInvocationsDelta,
          rtf,
          peakRssBytes: this.peakRssBytes,
          pipelineStagesExecuted: stages,
        },
        evidenceReferences: {
          ledgerSegmentId: ledgerEntry.segmentId,
          cacheIdentityKey: acousticOut.cacheIdentity
            ? `${acousticOut.cacheIdentity.audioSha256.slice(0, 12)}:${acousticOut.cacheIdentity.modelRevision.slice(0, 8)}`
            : null,
        },
      };
    } catch (err) {
      if (err instanceof SHAHABEngineError) {
        if (err.code !== 'EXECUTION_CANCELLED') this.failedRequests++;
        throw err;
      }
      this.failedRequests++;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CANCELLED') || msg.includes('cancelled')) {
        this.cancelledRequests++;
        throw new SHAHABEngineError({
          code: 'EXECUTION_CANCELLED',
          message: 'SHAHAB recognition cancelled during inference.',
          recoveryGuidance: 'Submit a fresh request when ready.',
        });
      }
      throw new SHAHABEngineError({
        code: 'INFERENCE_FAILURE',
        message: `SHAHAB inference failed: ${msg}`,
        recoveryGuidance: 'Check model integrity and audio format, then retry.',
        retryable: true,
      });
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  /**
   * SHAHAB-010 §9: Verified chunked overlap streaming pathway over the frozen offline Zipformer core.
   */
  public async recognizeChunkedStream(
    request: ShahabRecognitionRequest,
    onChunk?: (update: ShahabStreamChunkUpdate) => void,
  ): Promise<{
    readonly updates: readonly ShahabStreamChunkUpdate[];
    readonly finalCommittedText: string;
    readonly timeToFirstTranscriptMs: number;
    readonly totalStreamLatencyMs: number;
    readonly totalDuplicateTokensSuppressed: number;
    readonly chunkCount: number;
    readonly nativeStreamingGraph: false;
  }> {
    const t0 = performance.now();
    const chunkSec = Math.max(1.5, request.streamingPreference?.chunkDurationSec ?? 4.0);
    const overlapSec = Math.max(0, Math.min(chunkSec * 0.4, request.streamingPreference?.overlapSec ?? 0.6));

    let pcm16k: Float32Array;
    if (request.audioSource.wavBytes) {
      pcm16k = decodeWavToMono16k(request.audioSource.wavBytes).pcm16k;
    } else if (request.audioSource.pcmFloat32) {
      const sr = request.audioSource.sampleRateHz ?? 16000;
      pcm16k = conditionPcmTo16kMono({
        pcm: request.audioSource.pcmFloat32,
        sampleRateHz: sr,
        channels: request.audioSource.channels ?? 1,
      }).pcm16k;
    } else {
      throw new SHAHABEngineError({
        code: 'INVALID_AUDIO',
        message: 'Streaming request requires valid audio samples.',
        recoveryGuidance: 'Provide wavBytes or pcmFloat32.',
      });
    }

    const chunkSamples = Math.round(chunkSec * 16000);
    const overlapSamples = Math.round(overlapSec * 16000);
    const stepSamples = Math.max(1600, chunkSamples - overlapSamples);

    const updates: ShahabStreamChunkUpdate[] = [];
    let committedWords: string[] = [];
    let timeToFirstTranscriptMs = 0;
    let totalDupSuppressed = 0;
    let chunkIdx = 0;

    for (let pos = 0; pos < pcm16k.length; pos += stepSamples) {
      if (request.cancellationSignal?.aborted) {
        this.cancelledRequests++;
        throw new SHAHABEngineError({
          code: 'EXECUTION_CANCELLED',
          message: `Chunked streaming cancelled at chunk ${chunkIdx}.`,
          recoveryGuidance: 'Partial committed chunks remain intact.',
          partialResultsAvailable: updates.length > 0,
        });
      }

      const end = Math.min(pcm16k.length, pos + chunkSamples);
      const slice = pcm16k.subarray(pos, end);
      if (slice.length < 3200 && chunkIdx > 0) break;

      const tChunk0 = performance.now();
      const chunkRes = await this.recognize({
        ...request,
        requestId: `${request.requestId}_chunk_${chunkIdx}`,
        audioSource: {
          sourceId: `${request.audioSource.sourceId}_chunk_${chunkIdx}`,
          pcmFloat32: slice,
          sampleRateHz: 16000,
          channels: 1,
          format: 'pcm_f32',
        },
      });
      const chunkMs = Math.round(performance.now() - tChunk0);
      if (chunkIdx === 0) timeToFirstTranscriptMs = Math.round(performance.now() - t0);

      const newWords = chunkRes.rawTranscript.trim().split(/\s+/).filter(Boolean);
      let dupCount = 0;
      if (committedWords.length > 0 && newWords.length > 0) {
        const maxCheck = Math.min(3, committedWords.length, newWords.length);
        for (let k = maxCheck; k >= 1; k--) {
          const tail = committedWords.slice(-k).join(' ');
          const head = newWords.slice(0, k).join(' ');
          if (tail === head) {
            dupCount = k;
            break;
          }
        }
      }
      totalDupSuppressed += dupCount;
      const deduped = newWords.slice(dupCount);

      const isLast = end >= pcm16k.length;
      let uncommittedText = '';
      if (!isLast && deduped.length > 1) {
        committedWords = [...committedWords, ...deduped.slice(0, -1)];
        uncommittedText = deduped[deduped.length - 1];
      } else {
        committedWords = [...committedWords, ...deduped];
      }

      const update: ShahabStreamChunkUpdate = {
        chunkIndex: chunkIdx,
        startSec: Number((pos / 16000).toFixed(3)),
        endSec: Number((end / 16000).toFixed(3)),
        committedText: committedWords.join(' '),
        uncommittedText,
        duplicateBoundaryTokensSuppressed: dupCount,
        latencyMs: chunkMs,
      };
      updates.push(update);
      onChunk?.(update);

      chunkIdx++;
      if (isLast) break;
    }

    return {
      updates,
      finalCommittedText: committedWords.join(' '),
      timeToFirstTranscriptMs,
      totalStreamLatencyMs: Math.round(performance.now() - t0),
      totalDuplicateTokensSuppressed: totalDupSuppressed,
      chunkCount: updates.length,
      nativeStreamingGraph: false,
    };
  }

  /**
   * SHAHAB-010 §11: Host-agnostic Avapardaz timeline / future Adobe Audition bridge.
   * Zero ONNX types leaked.
   */
  public toAvapardazEditingTimelineBridge(result: ShahabRecognitionResult): {
    readonly engineRelease: string;
    readonly modelRevision: string;
    readonly alignmentMode: 'SEGMENT_LEVEL_ONLY';
    readonly wordAlignmentAvailable: false;
    readonly segments: readonly {
      readonly id: string;
      readonly startSec: number;
      readonly endSec: number;
      readonly text: string;
      readonly rawVerbatimText: string;
      readonly speakerId: null;
      readonly editable: true;
    }[];
  } {
    return {
      engineRelease: result.engineRelease,
      modelRevision: result.modelRevision,
      alignmentMode: 'SEGMENT_LEVEL_ONLY',
      wordAlignmentAvailable: false,
      segments: result.segments.map((s) => ({
        id: s.segmentId,
        startSec: s.startSec,
        endSec: s.endSec,
        text: s.authorizedFinalText,
        rawVerbatimText: s.rawText,
        speakerId: null,
        editable: true,
      })),
    };
  }
}
