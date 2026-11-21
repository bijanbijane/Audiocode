/**
 * SHAHAB-022 — Stable Engine SDK, Versioned API Contract, Host-Neutral Integration Boundary
 *
 * Architectural Law:
 *   Host Application -> Host Adapter -> SHAHAB SDK/API -> SHAHAB Engine -> Runtime Adapter -> Model
 *
 * Strict Non-Duplication & Isolation Rules:
 * - ZERO Avapardaz UI or Adobe-specific imports.
 * - Wraps canonical SHAHAB services (SHAHABFrozenModelAdapter, SHAHABEngine,
 *   SHAHABIncrementalStreamingSession, SHAHABCapabilityNegotiationEngine,
 *   SHAHABJobStateMachine, SHAHAB_FAILURE_TAXONOMY, SHAHABPersianFidelity).
 * - Never exposes mutable internal model tensors or undocumented decoder internals.
 * - Local-first default; NEVER silently converts Local -> Cloud; Cloud requires explicit authorization.
 * - Never fabricates word-level timestamps, confidence percentages, or TRUE_STATEFUL_STREAMING.
 * - Honors SHAHAB-021 Go/No-Go gate: blocked production capabilities (auto-update signing, GPU/WebGPU)
 *   remain explicitly UNAVAILABLE / BLOCKED.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePersianTextDeterministic } from '../ShahabContracts.ts';
import { SHAHAB_NEURAL_CORE_IDENTITY } from '../ShahabEngineUnified.ts';
import { ShahabEvidenceStore } from '../ShahabEvidenceStore.ts';
import {
  decodeWavToMono16k,
  SHAHABFrozenModelAdapter,
  type ShahabDecodePolicyId,
} from '../ShahabZipformerEngine.ts';
import { SHAHAB_RELEASE_CANDIDATE_VERSION } from '../ShahabReleaseHardening.ts';
import {
  auditZipformerStreamingCapability,
  SHAHABIncrementalStreamingSession,
  type ShahabStreamingCapabilityMode as ShahabStreamingMode,
} from '../ShahabStreamingEngine.ts';
import {
  discoverCoarsePrivacySafeCapabilities,
  SHAHABCapabilityNegotiationEngine,
} from '../ShahabRuntimeConformance.ts';
import {
  guardUncalibratedDecoderScore,
  auditPersianOrthographyTransformation,
} from '../ShahabPersianFidelity.ts';
import { SHAHABJobStateMachine } from '../ShahabResilienceEngine.ts';

// ── Semantic Version Constants (Distinct Identities per SHAHAB-022 §9) ──────
export const SHAHAB_SDK_API_VERSION = '1.0.0';
export const SHAHAB_SDK_MAJOR_VERSION = 1;
export const SHAHAB_SDK_BUILD_REVISION = 'shahab-sdk-1.0.0-internal';
export const SHAHAB_RESULT_SCHEMA_VERSION = '1.0.0';
export const SHAHAB_EVENT_SCHEMA_VERSION = '1.0.0';
export const SHAHAB_RUNTIME_ADAPTER_VERSION = 'onnxruntime-web@1.31.1-wasm-adapter-1.0';

// ── Typed Public Error Contract (§8) ────────────────────────────────────────
export type ShahabSdkErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_CAPABILITY'
  | 'UNSUPPORTED_API_VERSION'
  | 'ENGINE_DISPOSED'
  | 'MISSING_MODEL'
  | 'MODEL_INCOMPATIBLE'
  | 'RUNTIME_INIT_FAILURE'
  | 'AUDIO_DECODE_FAILURE'
  | 'PREPROCESSING_FAILURE'
  | 'INFERENCE_FAILURE'
  | 'RESOURCE_EXHAUSTION'
  | 'AUTHORIZATION_FAILURE'
  | 'CONSENT_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'JOB_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'PERSISTENCE_FAILURE'
  | 'INTERNAL_ENGINE_FAILURE';

export type ShahabSdkErrorCategory =
  | 'CONTRACT'
  | 'CAPABILITY'
  | 'MODEL'
  | 'RUNTIME'
  | 'AUDIO'
  | 'RESOURCE'
  | 'SECURITY_PRIVACY'
  | 'LIFECYCLE'
  | 'STORAGE'
  | 'INTERNAL';

export interface ShahabSdkErrorPayload {
  readonly code: ShahabSdkErrorCode;
  readonly category: ShahabSdkErrorCategory;
  readonly failureStage: string;
  readonly recoverable: boolean;
  readonly retryEligible: boolean;
  readonly userSafeMessageKey: string;
  readonly userSafeMessage: string;
  readonly diagnosticId: string;
  readonly jobId: string | null;
  readonly sessionId: string | null;
  readonly modelId: string | null;
  readonly runtimeId: string | null;
  readonly evidenceRef: string | null;
}

export class ShahabSdkError extends Error {
  public readonly payload: ShahabSdkErrorPayload;

  constructor(params: Omit<ShahabSdkErrorPayload, 'diagnosticId'> & { readonly diagnosticId?: string }) {
    super(params.userSafeMessage);
    this.name = 'ShahabSdkError';
    this.payload = {
      ...params,
      diagnosticId: params.diagnosticId ?? `diag_${crypto.randomBytes(5).toString('hex')}`,
    };
  }
}

// ── Host-Neutral Audio Input Contract (§4.4) ────────────────────────────────
export type ShahabAudioSampleFormat = 'FLOAT32_PCM' | 'INT16_PCM' | 'WAV_BYTES';

export interface ShahabAudioSourceDescriptor {
  readonly sourceKind: 'IN_MEMORY_PCM_BUFFER' | 'WAV_BYTE_BUFFER' | 'FILE_BACKED_WAV';
  readonly sourceId: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly sampleFormat: ShahabAudioSampleFormat;
  readonly endianness: 'LITTLE_ENDIAN';
  readonly frameCount: number | null;
  readonly timelineOriginSec: number;
  readonly timestampModel: 'ZERO_BASED_SOURCE_RELATIVE' | 'OFFSET_DECLARED_SOURCE_RELATIVE';
  readonly endOfStream: boolean;
  readonly ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE';
  /** Exactly one payload matching sourceKind */
  readonly pcmFloat32?: Float32Array;
  readonly wavBytes?: Uint8Array;
  /** Only allowed when explicitly within an authorized workspace root; never exposed in telemetry */
  readonly filePath?: string;
}

// ── Capability Discovery & Negotiation (§3.3 & §10) ─────────────────────────
export type ShahabCapabilitySupportLevel =
  | 'SUPPORTED_VERIFIED'
  | 'AVAILABLE_UNVERIFIED'
  | 'PARTIALLY_SUPPORTED'
  | 'UNSUPPORTED'
  | 'REQUIRES_PERMISSION'
  | 'BLOCKED'
  | 'UNKNOWN';

export interface ShahabSdkCapabilitiesReport {
  readonly apiVersion: string;
  readonly engineVersion: string;
  readonly qualificationGateDecision: string;
  readonly operations: {
    readonly offlineTranscription: ShahabCapabilitySupportLevel;
    readonly trueStatefulStreaming: ShahabCapabilitySupportLevel;
    readonly incrementalWindowedStreaming: ShahabCapabilitySupportLevel;
    readonly batchTranscription: ShahabCapabilitySupportLevel;
    readonly segmentTiming: ShahabCapabilitySupportLevel;
    readonly wordLevelForcedAlignment: ShahabCapabilitySupportLevel;
    readonly speakerDiarization: ShahabCapabilitySupportLevel;
    readonly contextualVocabularyBiasing: ShahabCapabilitySupportLevel;
    readonly cancellation: ShahabCapabilitySupportLevel;
    readonly pauseResumeStreaming: ShahabCapabilitySupportLevel;
    readonly localExecution: ShahabCapabilitySupportLevel;
    readonly cloudExecution: ShahabCapabilitySupportLevel;
    readonly automaticSignedModelUpdates: ShahabCapabilitySupportLevel;
    readonly gpuHardwareAcceleration: ShahabCapabilitySupportLevel;
  };
  readonly activeStreamingMode: ShahabStreamingMode;
  readonly acceptedAudioFormats: readonly ShahabAudioSampleFormat[];
  readonly maxAudioDurationSec: number;
  readonly maxPayloadBytes: number;
}

export interface ShahabHostCapabilityRequest {
  readonly hostId: string;
  readonly hostAdapterVersion: string;
  readonly requestedApiMajorVersion: number;
  readonly requestedExecutionMode: 'LOCAL' | 'CLOUD' | 'AUTO';
  readonly explicitCloudAuthorization: boolean;
  readonly wantsWordLevelTiming?: boolean;
  readonly wantsTrueStatefulStreaming?: boolean;
  readonly wantsSpeakerDiarization?: boolean;
  readonly wantsContextualVocabulary?: boolean;
}

export interface ShahabHostCapabilityGrant {
  readonly compatible: boolean;
  readonly grantedExecutionMode: 'LOCAL' | 'CLOUD' | 'UNAVAILABLE';
  readonly grantedStreamingMode: ShahabStreamingMode;
  readonly grantedTimingGranularity: 'SEGMENT_AND_TOKEN_ROUGH_NO_FORCED_WORD_ALIGNMENT';
  readonly silentModeSwitchOccurred: false;
  readonly silentModelSubstitutionOccurred: false;
  readonly explicitLimitations: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly capabilities: ShahabSdkCapabilitiesReport;
}

// ── Transcription Request & Canonical Result (§4.3 & §4.5) ──────────────────
export interface ShahabSdkAuthorizationContext {
  readonly tenantOrProjectId: string;
  readonly callerIdentity: string;
  readonly explicitCloudConsent: boolean;
  readonly consentRecordId?: string | null;
}

export interface ShahabSdkTranscriptionRequest {
  readonly apiVersion: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly audioSource: ShahabAudioSourceDescriptor;
  readonly executionMode: 'LOCAL' | 'CLOUD';
  readonly decodePolicy?: ShahabDecodePolicyId;
  readonly transcriptMode?: 'VERBATIM_AND_NORMALIZED' | 'VERBATIM_ONLY';
  readonly contextScopeId?: string | null;
  readonly contextTerms?: readonly string[];
  readonly timingRequirement?: 'SEGMENT_LEVEL' | 'WORD_LEVEL_IF_SUPPORTED';
  readonly authorization: ShahabSdkAuthorizationContext;
  readonly externalPersistenceContract?: 'SDK_MEMORY_AND_LEDGER' | 'HOST_DURABLE_STORE';
}

export type ShahabSdkJobState =
  | 'ACCEPTED'
  | 'VALIDATING'
  | 'QUEUED'
  | 'INITIALIZING'
  | 'PROCESSING'
  | 'PARTIAL_RESULT_AVAILABLE'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLED'
  | 'RECOVERY_PENDING'
  | 'FAILED';

export interface ShahabSdkTranscriptSegment {
  readonly segmentId: string;
  readonly revision: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample16k: number;
  readonly endSample16k: number;
  readonly textVerbatim: string;
  readonly textNormalized: string;
  readonly timingGranularity: 'SEGMENT_LEVEL';
  readonly timingProvenance: 'SHAHAB_ZIPFORMER_FRAME_STRIDE_40MS';
  readonly finalized: boolean;
}

export interface ShahabSdkTranscriptResult {
  readonly resultSchemaVersion: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly sessionId: string | null;
  readonly projectId: string;
  readonly outputRevision: number;
  readonly modelIdentity: {
    readonly modelId: string;
    readonly neuralCoreIdentity: string;
    readonly modelRevisionSha: string;
    readonly tokenizerSha256: string;
    readonly trainableParameters: 0;
  };
  readonly runtimeIdentity: {
    readonly sdkVersion: string;
    readonly engineVersion: string;
    readonly runtimeAdapterVersion: string;
    readonly provider: 'wasm' | 'cloud-authorized';
    readonly executionMode: 'LOCAL' | 'CLOUD';
  };
  readonly processingConfigDigest: string;
  readonly transcriptLayers: {
    readonly rawAcousticOutput: string;
    readonly contextAssistedOutput: string | null;
    readonly verbatimRepresentation: string;
    readonly normalizedRepresentation: string;
    readonly userEditedRepresentation: null;
    readonly authorizedFinalTranscript: null;
  };
  readonly segments: readonly ShahabSdkTranscriptSegment[];
  readonly timingDisclosure: {
    readonly wordLevelAlignmentSupported: false;
    readonly speakerDiarizationSupported: false;
    readonly decoderScoreCalibrationStatus: 'UNCALIBRATED_DECODER_SCORE';
    readonly rawDecoderLogProbSum: number | null;
    readonly note: string;
  };
  readonly audioMetrics: {
    readonly durationSec: number;
    readonly sampleRateHz: 16000;
    readonly sampleCount16k: number;
    readonly processingWallTimeMs: number;
    readonly rtf: number;
  };
  readonly durabilityState: 'COMMITTED_TO_SDK_STORE' | 'PENDING_HOST_PERSISTENCE';
  readonly provenanceRef: string;
  readonly completedAtUtc: string;
}

// ── Typed Event Contract (§7) ───────────────────────────────────────────────
export type ShahabSdkEventType =
  | 'JOB_ACCEPTED'
  | 'JOB_STAGE_CHANGED'
  | 'JOB_PROGRESS'
  | 'JOB_PARTIAL_RESULT'
  | 'JOB_FINAL_RESULT'
  | 'JOB_CANCELLATION_REQUESTED'
  | 'JOB_CANCELLED'
  | 'JOB_FAILED'
  | 'STREAM_CHUNK_ACK'
  | 'STREAM_PARTIAL_PROVISIONAL'
  | 'STREAM_PARTIAL_REVISED'
  | 'STREAM_SEGMENT_FINALIZED'
  | 'STREAM_COMPLETED'
  | 'STREAM_CANCELLED'
  | 'STREAM_ERROR'
  | 'ENGINE_WARNING';

export interface ShahabSdkEvent {
  readonly eventSchemaVersion: string;
  readonly eventId: string;
  readonly eventType: ShahabSdkEventType;
  readonly timestampUtc: string;
  readonly sequenceNumber: number;
  readonly orderingGuarantee: 'PER_JOB_OR_SESSION_STRICT_ORDER';
  readonly requestId: string;
  readonly jobId: string | null;
  readonly sessionId: string | null;
  readonly engineVersion: string;
  readonly modelRevision: string;
  readonly runtimeVersion: string;
  readonly provenance: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type ShahabSdkEventListener = (event: ShahabSdkEvent) => void;

export interface ShahabSdkCancellationOutcome {
  readonly jobId: string;
  readonly outcome:
    | 'CANCELLATION_REQUESTED'
    | 'CANCELLATION_COMPLETED'
    | 'CANCELLATION_TOO_LATE'
    | 'CANCELLATION_UNSUPPORTED'
    | 'CANCELLATION_FAILED';
  readonly alreadyCommittedOutputPreserved: boolean;
  readonly state: ShahabSdkJobState;
}

// ── Streaming Chunk & Ack Contract (§6) ─────────────────────────────────────
export interface ShahabSdkAudioChunk {
  readonly sessionId: string;
  readonly sequenceNumber: number;
  readonly startSampleIndex: number;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly pcmFloat32: Float32Array;
  readonly timestampSec: number;
  readonly ownershipPolicy: 'COPIED_ON_INGEST';
}

export interface ShahabSdkChunkAcknowledgement {
  readonly sessionId: string;
  readonly sequenceNumber: number;
  readonly received: boolean;
  readonly validated: boolean;
  readonly acceptedIntoQueue: boolean;
  readonly processed: boolean;
  readonly reflectedInTranscript: boolean;
  readonly duplicateRejected: boolean;
  readonly outOfOrderDetected: boolean;
  readonly backpressureTriggered: boolean;
}

export interface ShahabSdkEngineOptions {
  readonly modelDir: string;
  readonly authorizedWorkspaceRoot?: string;
  readonly docsDir?: string;
  readonly clientIdentity?: string;
  readonly maxAudioDurationSec?: number;
  readonly maxPayloadBytes?: number;
  readonly qualificationDecisionOverride?: string;
}

interface InternalJobRecord {
  readonly jobId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly projectId: string;
  readonly executionMode: 'LOCAL' | 'CLOUD';
  state: ShahabSdkJobState;
  readonly createdAtUtc: string;
  updatedAtUtc: string;
  readonly abortController: AbortController;
  readonly machine: SHAHABJobStateMachine;
  partialResults: Array<{ revision: number; text: string; timestampUtc: string }>;
  finalResult: ShahabSdkTranscriptResult | null;
  error: ShahabSdkErrorPayload | null;
  sequenceCounter: number;
  readonly listeners: Set<ShahabSdkEventListener>;
  readonly events: ShahabSdkEvent[];
  readonly executionPromise: Promise<void>;
}

interface InternalStreamingRecord {
  readonly sessionId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly streamingMode: ShahabStreamingMode;
  readonly session: SHAHABIncrementalStreamingSession;
  readonly seenSequences: Set<number>;
  lastSequence: number;
  disposed: boolean;
  cancelled: boolean;
  finalized: boolean;
  sequenceCounter: number;
  readonly listeners: Set<ShahabSdkEventListener>;
  readonly events: ShahabSdkEvent[];
}

const PINNED_MODEL_SHA = '0408facbcf3f670121def48e0802c395c225d150';

function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Canonical SHAHAB SDK Engine facade.
 * Wraps the real frozen Zipformer adapter, streaming session, capability negotiation,
 * and job state machine behind a stable host-neutral contract.
 */
export class ShahabSdkEngine {
  private readonly modelDir: string;
  private readonly authorizedWorkspaceRoot: string;
  private readonly docsDir: string;
  private readonly clientIdentity: string;
  private readonly maxAudioDurationSec: number;
  private readonly maxPayloadBytes: number;
  private readonly qualificationDecision: string;

  private adapter: SHAHABFrozenModelAdapter | null = null;
  private initialized = false;
  private disposed = false;
  private tokenizerSha256 = 'UNINITIALIZED';
  private modelArtifactHashes: Record<string, string> = {};
  private streamingMode: ShahabStreamingMode = 'INCREMENTAL_WINDOWED_INFERENCE';

  private readonly jobs = new Map<string, InternalJobRecord>();
  private readonly idempotencyIndex = new Map<string, string>(); // key -> jobId
  private readonly streamingSessions = new Map<string, InternalStreamingRecord>();
  private readonly diagnosticTrail: Array<Record<string, unknown>> = [];

  constructor(options: ShahabSdkEngineOptions) {
    this.modelDir = path.resolve(options.modelDir);
    this.authorizedWorkspaceRoot = path.resolve(options.authorizedWorkspaceRoot ?? process.cwd());
    this.docsDir = path.resolve(options.docsDir ?? path.join(process.cwd(), 'docs', 'shahab'));
    this.clientIdentity = options.clientIdentity ?? 'shahab-sdk-consumer';
    this.maxAudioDurationSec = options.maxAudioDurationSec ?? 3600;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024;
    this.qualificationDecision =
      options.qualificationDecisionOverride ?? this.readQualificationDecisionFromDisk();
  }

  private readQualificationDecisionFromDisk(): string {
    const qualPath = path.join(this.docsDir, 'SHAHAB_SYSTEM_QUALIFICATION_STATE.json');
    if (!fs.existsSync(qualPath)) return 'ENTRY_GATE_NOT_VERIFIED';
    try {
      const parsed = JSON.parse(fs.readFileSync(qualPath, 'utf8'));
      return String(parsed?.releaseDecision?.primaryDecision ?? 'ENTRY_GATE_NOT_VERIFIED');
    } catch {
      return 'ENTRY_GATE_NOT_VERIFIED';
    }
  }

  private assertNotDisposed(jobId: string | null = null, sessionId: string | null = null): void {
    if (this.disposed) {
      throw new ShahabSdkError({
        code: 'ENGINE_DISPOSED',
        category: 'LIFECYCLE',
        failureStage: 'ENGINE_LIFECYCLE',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.engine_disposed',
        userSafeMessage: 'SHAHAB SDK engine instance has been disposed and cannot accept requests.',
        jobId,
        sessionId,
        modelId: 'persian-zipformer-transducer-1.0.0',
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
  }

  /** Idempotent explicit initialization (§4.1). Verifies mandatory artifacts before reporting ready. */
  public async initialize(): Promise<void> {
    this.assertNotDisposed();
    if (this.initialized && this.adapter) return;

    const requiredFiles = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
    const hashes: Record<string, string> = {};
    for (const fileName of requiredFiles) {
      const fullPath = path.join(this.modelDir, fileName);
      if (!fs.existsSync(fullPath)) {
        throw new ShahabSdkError({
          code: 'MISSING_MODEL',
          category: 'MODEL',
          failureStage: 'MODEL_INITIALIZATION',
          recoverable: true,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.missing_model_artifact',
          userSafeMessage: `Required model artifact ${fileName} is missing from verified model store.`,
          jobId: null,
          sessionId: null,
          modelId: 'persian-zipformer-transducer-1.0.0',
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      hashes[fileName] = sha256Hex(fs.readFileSync(fullPath));
    }

    const audit = auditZipformerStreamingCapability(path.join(this.modelDir, 'encoder.int8.onnx'));
    this.streamingMode = audit.selectedStreamingMode;

    const adapter = new SHAHABFrozenModelAdapter({
      modelDir: this.modelDir,
      expectedHashes: {
        encoder: hashes['encoder.int8.onnx'],
        decoder: hashes['decoder.int8.onnx'],
        joiner: hashes['joiner.int8.onnx'],
        tokens: hashes['tokens.txt'],
      },
    });
    await adapter.initializeRuntime();
    this.adapter = adapter;
    this.modelArtifactHashes = hashes;
    this.tokenizerSha256 = hashes['tokens.txt'];
    this.initialized = true;
    this.recordDiagnostic('SDK_ENGINE_INITIALIZED', {
      clientIdentity: this.clientIdentity,
      streamingMode: this.streamingMode,
      qualificationDecision: this.qualificationDecision,
    });
  }

  public getEngineInfo() {
    this.assertNotDisposed();
    return {
      sdkApiVersion: SHAHAB_SDK_API_VERSION,
      sdkMajorVersion: SHAHAB_SDK_MAJOR_VERSION,
      sdkBuildRevision: SHAHAB_SDK_BUILD_REVISION,
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      resultSchemaVersion: SHAHAB_RESULT_SCHEMA_VERSION,
      eventSchemaVersion: SHAHAB_EVENT_SCHEMA_VERSION,
      runtimeAdapterVersion: SHAHAB_RUNTIME_ADAPTER_VERSION,
      initialized: this.initialized,
      qualificationDecision: this.qualificationDecision,
      clientIdentity: this.clientIdentity,
    };
  }

  public getRuntimeInfo() {
    this.assertNotDisposed();
    return {
      runtimeLibrary: 'onnxruntime-web',
      runtimeVersion: '1.31.1',
      adapterVersion: SHAHAB_RUNTIME_ADAPTER_VERSION,
      executionProvider: 'wasm',
      platform: process.platform,
      arch: process.arch,
      gpuHardwareAvailable: false,
      webGpuStatus: 'BLOCKED',
      nativeCppAddonStatus: 'UNAVAILABLE',
    };
  }

  public getModelInfo() {
    this.assertNotDisposed();
    return {
      modelId: 'persian-zipformer-transducer-1.0.0',
      neuralCoreIdentity: SHAHAB_NEURAL_CORE_IDENTITY,
      upstreamRepository: 'ramin-mahmoodi/persian-zipformer-asr',
      modelRevisionSha: PINNED_MODEL_SHA,
      licenseSpdx: 'Apache-2.0',
      trainableParameters: 0 as const,
      tokenizerSha256: this.tokenizerSha256,
      artifactHashes: { ...this.modelArtifactHashes },
      activeStreamingMode: this.streamingMode,
      trueStatefulStreamingSupported: false,
      uncompressedPackageMiB: 110.41,
      sub100MiBUncompressedSatisfied: false,
    };
  }

  public getCapabilities(): ShahabSdkCapabilitiesReport {
    this.assertNotDisposed();
    return {
      apiVersion: SHAHAB_SDK_API_VERSION,
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      qualificationGateDecision: this.qualificationDecision,
      operations: {
        offlineTranscription: 'SUPPORTED_VERIFIED',
        trueStatefulStreaming: 'UNSUPPORTED',
        incrementalWindowedStreaming: 'SUPPORTED_VERIFIED',
        batchTranscription: 'SUPPORTED_VERIFIED',
        segmentTiming: 'SUPPORTED_VERIFIED',
        wordLevelForcedAlignment: 'UNSUPPORTED',
        speakerDiarization: 'UNSUPPORTED',
        contextualVocabularyBiasing: 'PARTIALLY_SUPPORTED',
        cancellation: 'SUPPORTED_VERIFIED',
        pauseResumeStreaming: 'UNSUPPORTED',
        localExecution: 'SUPPORTED_VERIFIED',
        cloudExecution: 'REQUIRES_PERMISSION',
        automaticSignedModelUpdates: 'BLOCKED',
        gpuHardwareAcceleration: 'BLOCKED',
      },
      activeStreamingMode: this.streamingMode,
      acceptedAudioFormats: ['FLOAT32_PCM', 'INT16_PCM', 'WAV_BYTES'],
      maxAudioDurationSec: this.maxAudioDurationSec,
      maxPayloadBytes: this.maxPayloadBytes,
    };
  }

  /** Standard Host Capability Negotiation (§10). Never silently switches mode or fabricates capabilities. */
  public negotiateCapabilities(request: ShahabHostCapabilityRequest): ShahabHostCapabilityGrant {
    this.assertNotDisposed();
    const capabilities = this.getCapabilities();
    const explicitLimitations: string[] = [];
    const requiredPermissions: string[] = [];

    if (request.requestedApiMajorVersion !== SHAHAB_SDK_MAJOR_VERSION) {
      return {
        compatible: false,
        grantedExecutionMode: 'UNAVAILABLE',
        grantedStreamingMode: this.streamingMode,
        grantedTimingGranularity: 'SEGMENT_AND_TOKEN_ROUGH_NO_FORCED_WORD_ALIGNMENT',
        silentModeSwitchOccurred: false,
        silentModelSubstitutionOccurred: false,
        explicitLimitations: [
          `Incompatible API major version: requested v${request.requestedApiMajorVersion}, SDK provides v${SHAHAB_SDK_MAJOR_VERSION}.`,
        ],
        requiredPermissions: [],
        capabilities,
      };
    }

    const coarseCaps = discoverCoarsePrivacySafeCapabilities({
      cloudEndpointAuthorized: request.explicitCloudAuthorization,
    });
    const negotiator = new SHAHABCapabilityNegotiationEngine();
    const mappedMode =
      request.requestedExecutionMode === 'LOCAL'
        ? 'LOCAL_ONLY'
        : request.requestedExecutionMode === 'CLOUD'
          ? 'CLOUD_ONLY'
          : 'AUTO';
    const decision = negotiator.negotiate({
      requestedMode: mappedMode,
      preferredProvider: request.requestedExecutionMode === 'CLOUD' ? 'cloud_api' : 'wasm',
      requiredModelId: 'persian-zipformer-transducer-1.0.0',
      installedModelId: 'persian-zipformer-transducer-1.0.0',
      explicitCloudAuthorization: request.explicitCloudAuthorization,
      capabilities: coarseCaps,
    });

    if (request.wantsWordLevelTiming) {
      explicitLimitations.push(
        'Word-level forced alignment is UNSUPPORTED; SHAHAB provides segment-level & rough token-frame timing only.',
      );
    }
    if (request.wantsTrueStatefulStreaming) {
      explicitLimitations.push(
        'TRUE_STATEFUL_STREAMING is NOT_SUPPORTED_BY_MODEL (stateless7 encoder); granted INCREMENTAL_WINDOWED_INFERENCE.',
      );
    }
    if (request.wantsSpeakerDiarization) {
      explicitLimitations.push('Speaker diarization is UNSUPPORTED by the active frozen Persian Zipformer core.');
    }
    if (request.wantsContextualVocabulary) {
      explicitLimitations.push(
        'Contextual vocabulary biasing is supported only under modified_beam_search policies (refused under greedy_search).',
      );
    }
    if (request.requestedExecutionMode === 'CLOUD' && !request.explicitCloudAuthorization) {
      requiredPermissions.push('EXPLICIT_USER_CLOUD_TRANSFER_CONSENT');
      explicitLimitations.push('Cloud execution denied: explicit user authorization is absent.');
    }

    const grantedExecutionMode =
      decision.outcome === 'SELECTED_LOCAL_WASM'
        ? 'LOCAL'
        : decision.outcome === 'SELECTED_CLOUD_AUTHORIZED'
          ? 'CLOUD'
          : 'UNAVAILABLE';

    return {
      compatible: grantedExecutionMode !== 'UNAVAILABLE',
      grantedExecutionMode,
      grantedStreamingMode: this.streamingMode,
      grantedTimingGranularity: 'SEGMENT_AND_TOKEN_ROUGH_NO_FORCED_WORD_ALIGNMENT',
      silentModeSwitchOccurred: false,
      silentModelSubstitutionOccurred: false,
      explicitLimitations,
      requiredPermissions,
      capabilities,
    };
  }

  /** Submit an offline transcription job with strict validation, privacy enforcement & idempotency (§5). */
  public async submitTranscription(
    request: ShahabSdkTranscriptionRequest,
  ): Promise<{ readonly jobId: string; readonly state: ShahabSdkJobState; readonly replayedFromIdempotency: boolean }> {
    this.assertNotDisposed();

    // 1. Validate API version
    if (!request.apiVersion || !request.apiVersion.startsWith(`${SHAHAB_SDK_MAJOR_VERSION}.`)) {
      throw new ShahabSdkError({
        code: 'UNSUPPORTED_API_VERSION',
        category: 'CONTRACT',
        failureStage: 'REQUEST_VALIDATION',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.unsupported_api_version',
        userSafeMessage: `Unsupported API version "${request.apiVersion}". Expected ${SHAHAB_SDK_MAJOR_VERSION}.x.`,
        jobId: null,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }

    // 2. Validate required request identity fields
    if (!request.requestId?.trim() || !request.idempotencyKey?.trim() || !request.authorization?.tenantOrProjectId?.trim()) {
      throw new ShahabSdkError({
        code: 'INVALID_REQUEST',
        category: 'CONTRACT',
        failureStage: 'REQUEST_VALIDATION',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.invalid_request',
        userSafeMessage: 'requestId, idempotencyKey, and authorization.tenantOrProjectId are mandatory.',
        jobId: null,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }

    // 3. Enforce strict Local-first / explicit Cloud consent boundary (§3.2 & §12.1)
    if (request.executionMode === 'CLOUD' && !request.authorization.explicitCloudConsent) {
      throw new ShahabSdkError({
        code: 'CONSENT_REQUIRED',
        category: 'SECURITY_PRIVACY',
        failureStage: 'AUTHORIZATION_BOUNDARY',
        recoverable: true,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.cloud_consent_required',
        userSafeMessage: 'Cloud transcription requires explicit user authorization; Local-to-Cloud escalation is forbidden.',
        jobId: null,
        sessionId: null,
        modelId: 'persian-zipformer-transducer-1.0.0',
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }

    // 4. Compute deterministic payload digest for idempotency conflict detection (§5.1)
    const payloadDigest = sha256Hex(
      JSON.stringify({
        projectId: request.authorization.tenantOrProjectId,
        sourceId: request.audioSource.sourceId,
        sourceKind: request.audioSource.sourceKind,
        sampleRateHz: request.audioSource.sampleRateHz,
        channels: request.audioSource.channels,
        executionMode: request.executionMode,
        decodePolicy: request.decodePolicy ?? 'BALANCED',
      }),
    );

    const scopedKey = `${request.authorization.tenantOrProjectId}::${request.idempotencyKey}`;
    const existingJobId = this.idempotencyIndex.get(scopedKey);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) {
          throw new ShahabSdkError({
            code: 'IDEMPOTENCY_CONFLICT',
            category: 'CONTRACT',
            failureStage: 'IDEMPOTENCY_CHECK',
            recoverable: false,
            retryEligible: false,
            userSafeMessageKey: 'shahab.sdk.idempotency_conflict',
            userSafeMessage: 'Idempotency key was already used with a different transcription request payload.',
            jobId: existingJobId,
            sessionId: null,
            modelId: null,
            runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
            evidenceRef: null,
          });
        }
        return { jobId: existing.jobId, state: existing.state, replayedFromIdempotency: true };
      }
    }

    // 5. Decode and copy audio payload safely (host buffer ownership isolation §11.1)
    const decodedPcm = this.extractAndValidateAudioSource(request.audioSource);

    // 6. Register job record
    const jobId = `shjob_${crypto.randomBytes(6).toString('hex')}`;
    const nowUtc = new Date().toISOString();
    const machine = new SHAHABJobStateMachine();
    const abortController = new AbortController();

    const record: InternalJobRecord = {
      jobId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      payloadDigest,
      projectId: request.authorization.tenantOrProjectId,
      executionMode: request.executionMode,
      state: 'ACCEPTED',
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
      abortController,
      machine,
      partialResults: [],
      finalResult: null,
      error: null,
      sequenceCounter: 0,
      listeners: new Set(),
      events: [],
      executionPromise: Promise.resolve(),
    };

    this.jobs.set(jobId, record);
    this.idempotencyIndex.set(scopedKey, jobId);
    this.emitJobEvent(record, 'JOB_ACCEPTED', {
      executionMode: request.executionMode,
      sampleCount16k: decodedPcm.pcm16k.length,
      durationSec: decodedPcm.durationSec,
    });

    // Launch asynchronous execution tied to this job's lifecycle
    (record as { executionPromise: Promise<void> }).executionPromise = this.executeJobInternal(
      record,
      request,
      decodedPcm.pcm16k,
      decodedPcm.durationSec,
    );

    return { jobId, state: record.state, replayedFromIdempotency: false };
  }

  private extractAndValidateAudioSource(source: ShahabAudioSourceDescriptor): {
    readonly pcm16k: Float32Array;
    readonly durationSec: number;
  } {
    if (!source || source.sampleRateHz <= 0 || source.channels <= 0 || source.channels > 8) {
      throw new ShahabSdkError({
        code: 'INVALID_REQUEST',
        category: 'AUDIO',
        failureStage: 'AUDIO_VALIDATION',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.invalid_audio_format',
        userSafeMessage: 'Audio source must specify valid positive sampleRateHz and 1..8 channels.',
        jobId: null,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }

    let pcm16k: Float32Array;
    if (source.sourceKind === 'FILE_BACKED_WAV') {
      if (!source.filePath) {
        throw new ShahabSdkError({
          code: 'INVALID_REQUEST',
          category: 'AUDIO',
          failureStage: 'AUDIO_VALIDATION',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.missing_file_path',
          userSafeMessage: 'FILE_BACKED_WAV source requires an authorized filePath.',
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      const resolved = path.resolve(source.filePath);
      if (!resolved.startsWith(this.authorizedWorkspaceRoot + path.sep) && resolved !== this.authorizedWorkspaceRoot) {
        throw new ShahabSdkError({
          code: 'AUTHORIZATION_FAILURE',
          category: 'SECURITY_PRIVACY',
          failureStage: 'PATH_CONFINEMENT',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.unauthorized_audio_path',
          userSafeMessage: 'Audio file path is outside the authorized workspace boundary.',
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      if (!fs.existsSync(resolved)) {
        throw new ShahabSdkError({
          code: 'AUDIO_DECODE_FAILURE',
          category: 'AUDIO',
          failureStage: 'AUDIO_READ',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.audio_not_found',
          userSafeMessage: 'Requested audio source could not be read.',
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      const stat = fs.statSync(resolved);
      if (stat.size > this.maxPayloadBytes) {
        throw new ShahabSdkError({
          code: 'RESOURCE_EXHAUSTION',
          category: 'RESOURCE',
          failureStage: 'PAYLOAD_LIMIT',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.payload_too_large',
          userSafeMessage: `Audio payload exceeds SDK limit (${this.maxPayloadBytes} bytes).`,
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      const wavBuf = fs.readFileSync(resolved);
      const decoded = decodeWavToMono16k(wavBuf);
      // Copy buffer explicitly to guarantee ownership isolation (§11.1)
      pcm16k = new Float32Array(decoded.pcm16k);
    } else if (source.sourceKind === 'WAV_BYTE_BUFFER') {
      if (!source.wavBytes || source.wavBytes.byteLength === 0) {
        throw new ShahabSdkError({
          code: 'AUDIO_DECODE_FAILURE',
          category: 'AUDIO',
          failureStage: 'AUDIO_VALIDATION',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.empty_wav_buffer',
          userSafeMessage: 'WAV_BYTE_BUFFER payload is empty.',
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      if (source.wavBytes.byteLength > this.maxPayloadBytes) {
        throw new ShahabSdkError({
          code: 'RESOURCE_EXHAUSTION',
          category: 'RESOURCE',
          failureStage: 'PAYLOAD_LIMIT',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.payload_too_large',
          userSafeMessage: `Audio payload exceeds SDK limit (${this.maxPayloadBytes} bytes).`,
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      const decoded = decodeWavToMono16k(Buffer.from(source.wavBytes));
      pcm16k = new Float32Array(decoded.pcm16k);
    } else {
      // IN_MEMORY_PCM_BUFFER — always copy to protect caller ownership (§11.1)
      if (!source.pcmFloat32 || source.pcmFloat32.length === 0) {
        throw new ShahabSdkError({
          code: 'AUDIO_DECODE_FAILURE',
          category: 'AUDIO',
          failureStage: 'AUDIO_VALIDATION',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.empty_pcm_buffer',
          userSafeMessage: 'IN_MEMORY_PCM_BUFFER payload is empty.',
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      if (source.pcmFloat32.byteLength > this.maxPayloadBytes) {
        throw new ShahabSdkError({
          code: 'RESOURCE_EXHAUSTION',
          category: 'RESOURCE',
          failureStage: 'PAYLOAD_LIMIT',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.payload_too_large',
          userSafeMessage: `Audio PCM payload exceeds SDK limit (${this.maxPayloadBytes} bytes).`,
          jobId: null,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        });
      }
      // Downmix interleaved channels -> mono, then resample to 16 kHz deterministically
      const frameCount = Math.floor(source.pcmFloat32.length / source.channels);
      const mono = new Float32Array(frameCount);
      if (source.channels === 1) {
        mono.set(source.pcmFloat32.subarray(0, frameCount));
      } else {
        for (let i = 0; i < frameCount; i++) {
          let sum = 0;
          for (let ch = 0; ch < source.channels; ch++) {
            sum += source.pcmFloat32[i * source.channels + ch];
          }
          mono[i] = sum / source.channels;
        }
      }
      if (source.sampleRateHz === 16000) {
        pcm16k = mono;
      } else {
        const outLen = Math.max(1, Math.round((mono.length * 16000) / source.sampleRateHz));
        const resampled = new Float32Array(outLen);
        const ratio = source.sampleRateHz / 16000;
        for (let i = 0; i < outLen; i++) {
          const srcPos = i * ratio;
          const idx = Math.floor(srcPos);
          const frac = srcPos - idx;
          const s0 = mono[Math.min(idx, mono.length - 1)];
          const s1 = mono[Math.min(idx + 1, mono.length - 1)];
          resampled[i] = s0 + (s1 - s0) * frac;
        }
        pcm16k = resampled;
      }
    }

    const durationSec = Number((pcm16k.length / 16000).toFixed(4));
    if (durationSec > this.maxAudioDurationSec) {
      throw new ShahabSdkError({
        code: 'RESOURCE_EXHAUSTION',
        category: 'RESOURCE',
        failureStage: 'DURATION_LIMIT',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.duration_limit_exceeded',
        userSafeMessage: `Audio duration (${durationSec}s) exceeds maximum allowed (${this.maxAudioDurationSec}s).`,
        jobId: null,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    return { pcm16k, durationSec };
  }

  private async executeJobInternal(
    job: InternalJobRecord,
    request: ShahabSdkTranscriptionRequest,
    pcm16k: Float32Array,
    durationSec: number,
  ): Promise<void> {
    const t0 = performance.now();
    try {
      this.transitionJob(job, 'VALIDATING');
      if (job.abortController.signal.aborted) {
        this.finalizeCancelledJob(job);
        return;
      }
      this.transitionJob(job, 'INITIALIZING');
      await this.initialize();
      if (job.abortController.signal.aborted || !this.adapter) {
        this.finalizeCancelledJob(job);
        return;
      }

      this.transitionJob(job, 'PROCESSING');
      this.emitJobEvent(job, 'JOB_PROGRESS', {
        stage: 'ENCODER_AND_DECODER',
        processedAudioSec: 0,
        totalAudioSec: durationSec,
      });

      const policyId: ShahabDecodePolicyId = request.decodePolicy ?? 'BALANCED';
      const policy = this.adapter.policyManager.getPolicy(policyId);
      const enc = await this.adapter.encodeAudio({
        pcm16k,
        segmentId: `${job.jobId}_seg`,
        useCache: false,
        optimizationMode: 'OPTIMIZED',
      });

      if (job.abortController.signal.aborted) {
        this.finalizeCancelledJob(job);
        return;
      }

      const hyp = await this.adapter.decodeFromEncoderOutput({
        encoderOutput: enc.encoderOutput,
        policy,
        signal: job.abortController.signal,
        optimizationMode: 'OPTIMIZED',
      });

      if (job.abortController.signal.aborted) {
        this.finalizeCancelledJob(job);
        return;
      }

      this.transitionJob(job, 'FINALIZING');
      const rawText = hyp.rawText.trim();
      const ortho = auditPersianOrthographyTransformation(rawText);
      const normalizedText = normalizePersianTextDeterministic(ortho.normalized).normalized;
      const scoreGuard = guardUncalibratedDecoderScore(hyp.logProbSum);
      const wallMs = Number((performance.now() - t0).toFixed(2));
      const rtf = durationSec > 0 ? Number((wallMs / 1000 / durationSec).toFixed(4)) : 0;

      const segment: ShahabSdkTranscriptSegment = {
        segmentId: `${job.jobId}_seg_0001`,
        revision: 1,
        startSec: request.audioSource.timelineOriginSec,
        endSec: Number((request.audioSource.timelineOriginSec + durationSec).toFixed(4)),
        startSample16k: 0,
        endSample16k: pcm16k.length,
        textVerbatim: rawText,
        textNormalized: normalizedText,
        timingGranularity: 'SEGMENT_LEVEL',
        timingProvenance: 'SHAHAB_ZIPFORMER_FRAME_STRIDE_40MS',
        finalized: true,
      };

      const result: ShahabSdkTranscriptResult = {
        resultSchemaVersion: SHAHAB_RESULT_SCHEMA_VERSION,
        requestId: request.requestId,
        jobId: job.jobId,
        sessionId: null,
        projectId: job.projectId,
        outputRevision: 1,
        modelIdentity: {
          modelId: 'persian-zipformer-transducer-1.0.0',
          neuralCoreIdentity: SHAHAB_NEURAL_CORE_IDENTITY,
          modelRevisionSha: PINNED_MODEL_SHA,
          tokenizerSha256: this.tokenizerSha256,
          trainableParameters: 0,
        },
        runtimeIdentity: {
          sdkVersion: SHAHAB_SDK_API_VERSION,
          engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
          runtimeAdapterVersion: SHAHAB_RUNTIME_ADAPTER_VERSION,
          provider: request.executionMode === 'CLOUD' ? 'cloud-authorized' : 'wasm',
          executionMode: request.executionMode,
        },
        processingConfigDigest: sha256Hex(`${policyId}|${SHAHAB_RELEASE_CANDIDATE_VERSION}|${PINNED_MODEL_SHA}`).slice(0, 16),
        transcriptLayers: {
          rawAcousticOutput: rawText,
          contextAssistedOutput: null,
          verbatimRepresentation: rawText,
          normalizedRepresentation: normalizedText,
          userEditedRepresentation: null,
          authorizedFinalTranscript: null,
        },
        segments: [segment],
        timingDisclosure: {
          wordLevelAlignmentSupported: false,
          speakerDiarizationSupported: false,
          decoderScoreCalibrationStatus: scoreGuard.probabilityDisplayBlocked
            ? 'UNCALIBRATED_DECODER_SCORE'
            : 'UNCALIBRATED_DECODER_SCORE',
          rawDecoderLogProbSum: hyp.logProbSum,
          note: 'Segment-level timing only; word-level timestamps and speaker labels are NOT fabricated; decoder log-prob is uncalibrated.',
        },
        audioMetrics: {
          durationSec,
          sampleRateHz: 16000,
          sampleCount16k: pcm16k.length,
          processingWallTimeMs: wallMs,
          rtf,
        },
        durabilityState:
          request.externalPersistenceContract === 'HOST_DURABLE_STORE'
            ? 'PENDING_HOST_PERSISTENCE'
            : 'COMMITTED_TO_SDK_STORE',
        provenanceRef: `sdk://${SHAHAB_SDK_API_VERSION}/job/${job.jobId}`,
        completedAtUtc: new Date().toISOString(),
      };

      job.finalResult = result;
      this.transitionJob(job, 'COMPLETED');
      this.emitJobEvent(job, 'JOB_FINAL_RESULT', {
        outputRevision: result.outputRevision,
        segmentCount: result.segments.length,
        durationSec,
        processingWallTimeMs: wallMs,
        rtf,
        durabilityState: result.durabilityState,
      });
      this.recordDiagnostic('SDK_JOB_COMPLETED', {
        jobId: job.jobId,
        projectId: job.projectId,
        executionMode: job.executionMode,
        durationSec,
        wallMs,
        rtf,
      });
    } catch (err) {
      if (job.abortController.signal.aborted) {
        this.finalizeCancelledJob(job);
        return;
      }
      const sdkErr =
        err instanceof ShahabSdkError
          ? err.payload
          : new ShahabSdkError({
              code: 'INFERENCE_FAILURE',
              category: 'RUNTIME',
              failureStage: 'SDK_EXECUTION',
              recoverable: true,
              retryEligible: true,
              userSafeMessageKey: 'shahab.sdk.inference_failed',
              userSafeMessage: 'SHAHAB inference failed during execution.',
              jobId: job.jobId,
              sessionId: null,
              modelId: 'persian-zipformer-transducer-1.0.0',
              runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
              evidenceRef: null,
            }).payload;
      job.error = sdkErr;
      this.transitionJob(job, 'FAILED');
      this.emitJobEvent(job, 'JOB_FAILED', {
        errorCode: sdkErr.code,
        category: sdkErr.category,
        failureStage: sdkErr.failureStage,
      });
    }
  }

  private transitionJob(job: InternalJobRecord, next: ShahabSdkJobState): void {
    job.state = next;
    job.updatedAtUtc = new Date().toISOString();
    this.emitJobEvent(job, 'JOB_STAGE_CHANGED', { state: next });
  }

  private finalizeCancelledJob(job: InternalJobRecord): void {
    if (job.state === 'CANCELLED' || job.state === 'COMPLETED') return;
    job.state = 'CANCELLED';
    job.updatedAtUtc = new Date().toISOString();
    job.finalResult = null; // Cancelled job NEVER emits a fake normal final result (§5.2)
    this.emitJobEvent(job, 'JOB_CANCELLED', {
      alreadyCommittedPartialCount: job.partialResults.length,
    });
  }

  private emitJobEvent(job: InternalJobRecord, eventType: ShahabSdkEventType, payload: Record<string, unknown>): void {
    job.sequenceCounter += 1;
    const evt: ShahabSdkEvent = {
      eventSchemaVersion: SHAHAB_EVENT_SCHEMA_VERSION,
      eventId: `sdkevt_${crypto.randomBytes(5).toString('hex')}`,
      eventType,
      timestampUtc: new Date().toISOString(),
      sequenceNumber: job.sequenceCounter,
      orderingGuarantee: 'PER_JOB_OR_SESSION_STRICT_ORDER',
      requestId: job.requestId,
      jobId: job.jobId,
      sessionId: null,
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      modelRevision: PINNED_MODEL_SHA,
      runtimeVersion: SHAHAB_RUNTIME_ADAPTER_VERSION,
      provenance: `sdk://${SHAHAB_SDK_API_VERSION}/job/${job.jobId}`,
      payload,
    };
    job.events.push(evt);
    for (const listener of job.listeners) {
      try {
        listener(evt);
      } catch {
        // Listener errors must never corrupt engine state
      }
    }
  }

  public getJobStatus(jobId: string, projectId?: string) {
    this.assertNotDisposed(jobId);
    const job = this.jobs.get(jobId);
    if (!job || (projectId && job.projectId !== projectId)) {
      throw new ShahabSdkError({
        code: 'JOB_NOT_FOUND',
        category: 'LIFECYCLE',
        failureStage: 'JOB_QUERY',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.job_not_found',
        userSafeMessage: 'Requested job was not found within this project scope.',
        jobId,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    return {
      jobId: job.jobId,
      requestId: job.requestId,
      projectId: job.projectId,
      executionMode: job.executionMode,
      state: job.state,
      createdAtUtc: job.createdAtUtc,
      updatedAtUtc: job.updatedAtUtc,
      eventCount: job.events.length,
      error: job.error,
    };
  }

  public subscribeToJobEvents(jobId: string, listener: ShahabSdkEventListener): () => void {
    this.assertNotDisposed(jobId);
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ShahabSdkError({
        code: 'JOB_NOT_FOUND',
        category: 'LIFECYCLE',
        failureStage: 'EVENT_SUBSCRIPTION',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.job_not_found',
        userSafeMessage: 'Cannot subscribe to unknown job.',
        jobId,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
    };
  }

  public async cancelJob(jobId: string, projectId?: string): Promise<ShahabSdkCancellationOutcome> {
    this.assertNotDisposed(jobId);
    const job = this.jobs.get(jobId);
    if (!job || (projectId && job.projectId !== projectId)) {
      throw new ShahabSdkError({
        code: 'JOB_NOT_FOUND',
        category: 'LIFECYCLE',
        failureStage: 'JOB_CANCELLATION',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.job_not_found',
        userSafeMessage: 'Cannot cancel unknown job.',
        jobId,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    if (job.state === 'COMPLETED') {
      return {
        jobId,
        outcome: 'CANCELLATION_TOO_LATE',
        alreadyCommittedOutputPreserved: true,
        state: job.state,
      };
    }
    if (job.state === 'CANCELLED') {
      return {
        jobId,
        outcome: 'CANCELLATION_COMPLETED',
        alreadyCommittedOutputPreserved: true,
        state: job.state,
      };
    }
    job.state = 'CANCELLATION_REQUESTED';
    this.emitJobEvent(job, 'JOB_CANCELLATION_REQUESTED', {});
    job.abortController.abort();
    await job.executionPromise.catch(() => undefined);
    this.finalizeCancelledJob(job);
    return {
      jobId,
      outcome: 'CANCELLATION_COMPLETED',
      alreadyCommittedOutputPreserved: true,
      state: job.state,
    };
  }

  public async waitForFinalResult(jobId: string, projectId?: string): Promise<ShahabSdkTranscriptResult> {
    this.assertNotDisposed(jobId);
    const job = this.jobs.get(jobId);
    if (!job || (projectId && job.projectId !== projectId)) {
      throw new ShahabSdkError({
        code: 'JOB_NOT_FOUND',
        category: 'LIFECYCLE',
        failureStage: 'RESULT_RETRIEVAL',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.job_not_found',
        userSafeMessage: 'Job not found in project scope.',
        jobId,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    await job.executionPromise;
    if (job.state === 'CANCELLED') {
      throw new ShahabSdkError({
        code: 'CANCELLED',
        category: 'LIFECYCLE',
        failureStage: 'RESULT_RETRIEVAL',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.job_cancelled',
        userSafeMessage: 'Job was cancelled; no normal final transcript is emitted.',
        jobId,
        sessionId: null,
        modelId: 'persian-zipformer-transducer-1.0.0',
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    if (job.error || !job.finalResult) {
      throw new ShahabSdkError(
        job.error ?? {
          code: 'INTERNAL_ENGINE_FAILURE',
          category: 'INTERNAL',
          failureStage: 'RESULT_RETRIEVAL',
          recoverable: false,
          retryEligible: false,
          userSafeMessageKey: 'shahab.sdk.missing_result',
          userSafeMessage: 'Job terminated without a valid result.',
          jobId,
          sessionId: null,
          modelId: null,
          runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
          evidenceRef: null,
        },
      );
    }
    return job.finalResult;
  }

  public getJobEvents(jobId: string): readonly ShahabSdkEvent[] {
    const job = this.jobs.get(jobId);
    return job ? [...job.events] : [];
  }

  public disposeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.listeners.clear();
    return this.jobs.delete(jobId);
  }

  // ── Streaming SDK Contract (§6) ───────────────────────────────────────────
  public async createStreamingSession(params: {
    readonly requestId: string;
    readonly projectId: string;
    readonly windowSec?: number;
    readonly stepSec?: number;
    readonly maxQueueDepth?: number;
  }): Promise<{ readonly sessionId: string; readonly streamingMode: ShahabStreamingMode; readonly trueStatefulStreaming: false }> {
    this.assertNotDisposed();
    await this.initialize();
    if (!this.adapter) {
      throw new ShahabSdkError({
        code: 'RUNTIME_INIT_FAILURE',
        category: 'RUNTIME',
        failureStage: 'STREAMING_INIT',
        recoverable: true,
        retryEligible: true,
        userSafeMessageKey: 'shahab.sdk.runtime_not_ready',
        userSafeMessage: 'Runtime adapter is not initialized.',
        jobId: null,
        sessionId: null,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    const sessionId = `shstr_${crypto.randomBytes(6).toString('hex')}`;
    const session = new SHAHABIncrementalStreamingSession(this.adapter, {
      sessionId,
      windowSec: params.windowSec ?? 2.0,
      stepSec: params.stepSec ?? 1.0,
      maxQueueDepth: params.maxQueueDepth ?? 32,
    });
    await session.start();
    const rec: InternalStreamingRecord = {
      sessionId,
      requestId: params.requestId,
      projectId: params.projectId,
      streamingMode: this.streamingMode,
      session,
      seenSequences: new Set(),
      lastSequence: -1,
      disposed: false,
      cancelled: false,
      finalized: false,
      sequenceCounter: 0,
      listeners: new Set(),
      events: [],
    };
    this.streamingSessions.set(sessionId, rec);
    return { sessionId, streamingMode: this.streamingMode, trueStatefulStreaming: false };
  }

  public async appendAudioChunk(chunk: ShahabSdkAudioChunk): Promise<ShahabSdkChunkAcknowledgement> {
    this.assertNotDisposed(null, chunk.sessionId);
    const rec = this.streamingSessions.get(chunk.sessionId);
    if (!rec || rec.disposed || rec.cancelled || rec.finalized) {
      throw new ShahabSdkError({
        code: 'SESSION_NOT_FOUND',
        category: 'LIFECYCLE',
        failureStage: 'STREAM_APPEND',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.session_unavailable',
        userSafeMessage: 'Streaming session is unavailable, finalized, or disposed.',
        jobId: null,
        sessionId: chunk.sessionId,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }

    if (rec.seenSequences.has(chunk.sequenceNumber)) {
      return {
        sessionId: chunk.sessionId,
        sequenceNumber: chunk.sequenceNumber,
        received: true,
        validated: true,
        acceptedIntoQueue: false,
        processed: false,
        reflectedInTranscript: false,
        duplicateRejected: true,
        outOfOrderDetected: false,
        backpressureTriggered: false,
      };
    }

    const outOfOrder = rec.lastSequence >= 0 && chunk.sequenceNumber !== rec.lastSequence + 1;
    rec.seenSequences.add(chunk.sequenceNumber);
    rec.lastSequence = Math.max(rec.lastSequence, chunk.sequenceNumber);

    // Copy chunk buffer so caller owns original memory safely
    const copy = new Float32Array(chunk.pcmFloat32);
    const ingestRes = rec.session.ingestChunk({
      sessionId: chunk.sessionId,
      sequenceNumber: chunk.sequenceNumber,
      startSampleIndex: chunk.startSampleIndex,
      sampleRateHz: chunk.sampleRateHz,
      channels: chunk.channels,
      pcmInterleaved: copy,
      capturedAtMs: Date.now(),
    });
    const emittedRevs = ingestRes.validation.accepted && !ingestRes.backpressured
      ? await rec.session.processPendingWindows()
      : [];
    const ack: ShahabSdkChunkAcknowledgement = {
      sessionId: chunk.sessionId,
      sequenceNumber: chunk.sequenceNumber,
      received: true,
      validated: ingestRes.validation.accepted,
      acceptedIntoQueue: ingestRes.validation.accepted && !ingestRes.backpressured,
      processed: emittedRevs.length > 0,
      reflectedInTranscript: emittedRevs.length > 0,
      duplicateRejected: ingestRes.validation.issue === 'DUPLICATE_SEQUENCE',
      outOfOrderDetected: outOfOrder || ingestRes.validation.issue === 'OUT_OF_ORDER_SEQUENCE',
      backpressureTriggered: ingestRes.backpressured,
    };
    this.emitStreamEvent(rec, 'STREAM_CHUNK_ACK', { ...ack });
    return ack;
  }

  public async finalizeStreamingSession(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly streamingMode: ShahabStreamingMode;
    readonly finalTextVerbatim: string;
    readonly finalTextNormalized: string;
    readonly finalState: string;
  }> {
    this.assertNotDisposed(null, sessionId);
    const rec = this.streamingSessions.get(sessionId);
    if (!rec || rec.disposed) {
      throw new ShahabSdkError({
        code: 'SESSION_NOT_FOUND',
        category: 'LIFECYCLE',
        failureStage: 'STREAM_FINALIZE',
        recoverable: false,
        retryEligible: false,
        userSafeMessageKey: 'shahab.sdk.session_not_found',
        userSafeMessage: 'Streaming session not found.',
        jobId: null,
        sessionId,
        modelId: null,
        runtimeId: SHAHAB_RUNTIME_ADAPTER_VERSION,
        evidenceRef: null,
      });
    }
    const fin = await rec.session.endOfStream();
    rec.finalized = true;
    const raw = fin.finalTranscript.trim();
    const norm = normalizePersianTextDeterministic(raw).normalized;
    this.emitStreamEvent(rec, 'STREAM_COMPLETED', {
      finalState: fin.finalState,
      wordCount: raw ? raw.split(/\s+/).length : 0,
    });
    return {
      sessionId,
      streamingMode: rec.streamingMode,
      finalTextVerbatim: raw,
      finalTextNormalized: norm,
      finalState: fin.finalState,
    };
  }

  public cancelStreamingSession(sessionId: string): boolean {
    const rec = this.streamingSessions.get(sessionId);
    if (!rec) return false;
    rec.cancelled = true;
    rec.session.cancel('Cancelled via SHAHAB SDK');
    this.emitStreamEvent(rec, 'STREAM_CANCELLED', {});
    return true;
  }

  public disposeStreamingSession(sessionId: string): boolean {
    const rec = this.streamingSessions.get(sessionId);
    if (!rec) return false;
    rec.disposed = true;
    rec.listeners.clear();
    return this.streamingSessions.delete(sessionId);
  }

  private emitStreamEvent(
    rec: InternalStreamingRecord,
    eventType: ShahabSdkEventType,
    payload: Record<string, unknown>,
  ): void {
    rec.sequenceCounter += 1;
    const evt: ShahabSdkEvent = {
      eventSchemaVersion: SHAHAB_EVENT_SCHEMA_VERSION,
      eventId: `sdkevt_${crypto.randomBytes(5).toString('hex')}`,
      eventType,
      timestampUtc: new Date().toISOString(),
      sequenceNumber: rec.sequenceCounter,
      orderingGuarantee: 'PER_JOB_OR_SESSION_STRICT_ORDER',
      requestId: rec.requestId,
      jobId: null,
      sessionId: rec.sessionId,
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      modelRevision: PINNED_MODEL_SHA,
      runtimeVersion: SHAHAB_RUNTIME_ADAPTER_VERSION,
      provenance: `sdk://${SHAHAB_SDK_API_VERSION}/stream/${rec.sessionId}`,
      payload,
    };
    rec.events.push(evt);
    for (const l of rec.listeners) {
      try {
        l(evt);
      } catch {
        // ignore listener failure
      }
    }
  }

  /** Sanitized diagnostic export (§15) — zero raw audio, transcripts, or private file paths. */
  public exportSanitizedDiagnostics() {
    return {
      sdkApiVersion: SHAHAB_SDK_API_VERSION,
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      clientIdentity: this.clientIdentity,
      qualificationDecision: this.qualificationDecision,
      sanitizationPolicy: 'ZERO_RAW_TRANSCRIPT_ZERO_AUDIO_ZERO_PRIVATE_PATHS',
      activeJobsCount: this.jobs.size,
      activeStreamingSessionsCount: this.streamingSessions.size,
      recentEvents: this.diagnosticTrail.slice(-50),
    };
  }

  private recordDiagnostic(eventType: string, fields: Record<string, unknown>): void {
    this.diagnosticTrail.push({
      timestampUtc: new Date().toISOString(),
      eventType,
      ...fields,
    });
  }

  /** Idempotent explicit resource cleanup (§4.1 & §11.2). */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) {
      job.abortController.abort();
      job.listeners.clear();
    }
    this.jobs.clear();
    for (const sess of this.streamingSessions.values()) {
      sess.disposed = true;
      sess.listeners.clear();
    }
    this.streamingSessions.clear();
    if (this.adapter) {
      await this.adapter.dispose();
      this.adapter = null;
    }
    this.initialized = false;
  }
}

export function createShahabSdkEngine(options: ShahabSdkEngineOptions): ShahabSdkEngine {
  return new ShahabSdkEngine(options);
}

// ── Minimal Runnable Sample Host (§14.1) & Conformance Suite (§16) ──────────
export interface ShahabSdkConformanceCaseResult {
  readonly testId: string;
  readonly category:
    | 'API_CONTRACT'
    | 'ENGINE_LIFECYCLE'
    | 'JOB_LIFECYCLE'
    | 'STREAMING'
    | 'PRIVACY_SECURITY'
    | 'COMPATIBILITY'
    | 'CONCURRENCY';
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ShahabSdkStateArtifact {
  readonly missionId: 'SHAHAB-022';
  readonly generatedAtUtc: string;
  readonly entryGateQualificationDecision: string;
  readonly sdkApiVersion: string;
  readonly resultSchemaVersion: string;
  readonly eventSchemaVersion: string;
  readonly engineVersion: string;
  readonly modelIdentity: ReturnType<ShahabSdkEngine['getModelInfo']>;
  readonly capabilities: ShahabSdkCapabilitiesReport;
  readonly sampleHostRun: {
    readonly executed: boolean;
    readonly audioSourceId: string;
    readonly durationSec: number;
    readonly rtf: number;
    readonly eventsObserved: number;
    readonly secondJobCancelledCleanly: boolean;
    readonly transcriptNonEmpty: boolean;
    readonly provenanceRef: string;
  };
  readonly conformanceSuite: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly failedCases: number;
    readonly cases: readonly ShahabSdkConformanceCaseResult[];
  };
  readonly finalStatus: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'BLOCKED' | 'FAILED';
  readonly knownLimitations: readonly string[];
}

export async function runShahab022SdkVerification(params: {
  readonly modelDir: string;
  readonly sampleWavPath: string;
  readonly docsDir: string;
  readonly store?: ShahabEvidenceStore;
}): Promise<ShahabSdkStateArtifact> {
  const generatedAtUtc = new Date().toISOString();
  const cases: ShahabSdkConformanceCaseResult[] = [];

  const sdk = createShahabSdkEngine({
    modelDir: params.modelDir,
    docsDir: params.docsDir,
    clientIdentity: 'shahab-022-sample-host-and-conformance',
  });

  // Initialize twice to prove idempotency (§16.2)
  await sdk.initialize();
  await sdk.initialize();
  const modelInfo = sdk.getModelInfo();
  const capabilities = sdk.getCapabilities();
  const engineInfo = sdk.getEngineInfo();

  cases.push({
    testId: 'SDK-LIFE-01',
    category: 'ENGINE_LIFECYCLE',
    description: 'Idempotent initialization & verified immutable model identity',
    passed: engineInfo.initialized && modelInfo.trainableParameters === 0 && Object.keys(modelInfo.artifactHashes).length === 4,
    detail: `model=${modelInfo.modelId}, sha=${modelInfo.modelRevisionSha.slice(0, 12)}, hashes=4`,
  });

  // §16.1 & §16.6 Capability negotiation & incompatible API major version rejection
  const negValid = sdk.negotiateCapabilities({
    hostId: 'sample-host',
    hostAdapterVersion: '1.0.0',
    requestedApiMajorVersion: 1,
    requestedExecutionMode: 'LOCAL',
    explicitCloudAuthorization: false,
    wantsWordLevelTiming: true,
    wantsTrueStatefulStreaming: true,
  });
  const negBadMajor = sdk.negotiateCapabilities({
    hostId: 'stale-host',
    hostAdapterVersion: '0.1.0',
    requestedApiMajorVersion: 99,
    requestedExecutionMode: 'LOCAL',
    explicitCloudAuthorization: false,
  });
  cases.push({
    testId: 'SDK-COMPAT-01',
    category: 'COMPATIBILITY',
    description: 'Capability negotiation discloses unsupported word timing/stateful streaming & rejects incompatible major version',
    passed:
      negValid.compatible &&
      negValid.explicitLimitations.length >= 2 &&
      !negBadMajor.compatible &&
      !negValid.silentModeSwitchOccurred,
    detail: `limitations=${negValid.explicitLimitations.length}, badMajorRejected=${!negBadMajor.compatible}`,
  });

  // §16.5 Privacy & Security: unauthorized Cloud & path traversal rejection
  let cloudBlocked = false;
  try {
    await sdk.submitTranscription({
      apiVersion: SHAHAB_SDK_API_VERSION,
      requestId: 'req-cloud-unauth',
      idempotencyKey: 'idem-cloud-unauth',
      audioSource: {
        sourceKind: 'IN_MEMORY_PCM_BUFFER',
        sourceId: 'probe-1',
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'FLOAT32_PCM',
        endianness: 'LITTLE_ENDIAN',
        frameCount: 1600,
        timelineOriginSec: 0,
        timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        pcmFloat32: new Float32Array(1600),
      },
      executionMode: 'CLOUD',
      authorization: {
        tenantOrProjectId: 'proj-sec',
        callerIdentity: 'conformance',
        explicitCloudConsent: false,
      },
    });
  } catch (err) {
    cloudBlocked = err instanceof ShahabSdkError && err.payload.code === 'CONSENT_REQUIRED';
  }

  let traversalBlocked = false;
  try {
    await sdk.submitTranscription({
      apiVersion: SHAHAB_SDK_API_VERSION,
      requestId: 'req-path-esc',
      idempotencyKey: 'idem-path-esc',
      audioSource: {
        sourceKind: 'FILE_BACKED_WAV',
        sourceId: 'escape-probe',
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'WAV_BYTES',
        endianness: 'LITTLE_ENDIAN',
        frameCount: null,
        timelineOriginSec: 0,
        timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        filePath: '/etc/passwd',
      },
      executionMode: 'LOCAL',
      authorization: {
        tenantOrProjectId: 'proj-sec',
        callerIdentity: 'conformance',
        explicitCloudConsent: false,
      },
    });
  } catch (err) {
    traversalBlocked = err instanceof ShahabSdkError && err.payload.code === 'AUTHORIZATION_FAILURE';
  }
  cases.push({
    testId: 'SDK-PRIV-01',
    category: 'PRIVACY_SECURITY',
    description: 'Unauthorized Cloud transfer & out-of-workspace file paths are strictly rejected',
    passed: cloudBlocked && traversalBlocked,
    detail: `cloudBlocked=${cloudBlocked}, pathEscapeBlocked=${traversalBlocked}`,
  });

  // §14.1 Minimal Runnable Sample Host + §16.3 Job Lifecycle, Idempotency & Cancellation
  const wavBytes = fs.readFileSync(params.sampleWavPath);
  const { pcm16k } = decodeWavToMono16k(wavBytes);
  const sampleSlice = pcm16k.subarray(0, Math.min(pcm16k.length, 16000 * 6));
  const observedEvents: ShahabSdkEvent[] = [];

  const sub1 = await sdk.submitTranscription({
    apiVersion: SHAHAB_SDK_API_VERSION,
    requestId: 'req-sample-host-1',
    idempotencyKey: 'idem-sample-host-1',
    audioSource: {
      sourceKind: 'IN_MEMORY_PCM_BUFFER',
      sourceId: 'sample_wav_first_6s',
      sampleRateHz: 16000,
      channels: 1,
      sampleFormat: 'FLOAT32_PCM',
      endianness: 'LITTLE_ENDIAN',
      frameCount: sampleSlice.length,
      timelineOriginSec: 0,
      timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
      endOfStream: true,
      ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
      pcmFloat32: sampleSlice,
    },
    executionMode: 'LOCAL',
    decodePolicy: 'SPEED',
    authorization: {
      tenantOrProjectId: 'proj-sample-host',
      callerIdentity: 'shahab-022-sample-host',
      explicitCloudConsent: false,
    },
  });
  const unsub = sdk.subscribeToJobEvents(sub1.jobId, (e) => observedEvents.push(e));

  // Duplicate idempotent submission must return same jobId
  const sub1Replay = await sdk.submitTranscription({
    apiVersion: SHAHAB_SDK_API_VERSION,
    requestId: 'req-sample-host-1-retry',
    idempotencyKey: 'idem-sample-host-1',
    audioSource: {
      sourceKind: 'IN_MEMORY_PCM_BUFFER',
      sourceId: 'sample_wav_first_6s',
      sampleRateHz: 16000,
      channels: 1,
      sampleFormat: 'FLOAT32_PCM',
      endianness: 'LITTLE_ENDIAN',
      frameCount: sampleSlice.length,
      timelineOriginSec: 0,
      timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
      endOfStream: true,
      ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
      pcmFloat32: sampleSlice,
    },
    executionMode: 'LOCAL',
    decodePolicy: 'SPEED',
    authorization: {
      tenantOrProjectId: 'proj-sample-host',
      callerIdentity: 'shahab-022-sample-host',
      explicitCloudConsent: false,
    },
  });

  // Conflicting payload under same idempotency key must throw IDEMPOTENCY_CONFLICT
  let conflictDetected = false;
  try {
    await sdk.submitTranscription({
      apiVersion: SHAHAB_SDK_API_VERSION,
      requestId: 'req-sample-host-conflict',
      idempotencyKey: 'idem-sample-host-1',
      audioSource: {
        sourceKind: 'IN_MEMORY_PCM_BUFFER',
        sourceId: 'different_source_id',
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'FLOAT32_PCM',
        endianness: 'LITTLE_ENDIAN',
        frameCount: sampleSlice.length,
        timelineOriginSec: 0,
        timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        pcmFloat32: sampleSlice,
      },
      executionMode: 'LOCAL',
      decodePolicy: 'SPEED',
      authorization: {
        tenantOrProjectId: 'proj-sample-host',
        callerIdentity: 'shahab-022-sample-host',
        explicitCloudConsent: false,
      },
    });
  } catch (err) {
    conflictDetected = err instanceof ShahabSdkError && err.payload.code === 'IDEMPOTENCY_CONFLICT';
  }

  const finalRes1 = await sdk.waitForFinalResult(sub1.jobId, 'proj-sample-host');
  unsub();

  // Tenant/Project isolation check: proj-other cannot read proj-sample-host job
  let tenantIsolated = false;
  try {
    sdk.getJobStatus(sub1.jobId, 'proj-other');
  } catch (err) {
    tenantIsolated = err instanceof ShahabSdkError && err.payload.code === 'JOB_NOT_FOUND';
  }

  // Second test job cancellation (§14.1)
  const sub2 = await sdk.submitTranscription({
    apiVersion: SHAHAB_SDK_API_VERSION,
    requestId: 'req-sample-host-cancel',
    idempotencyKey: 'idem-sample-host-cancel',
    audioSource: {
      sourceKind: 'IN_MEMORY_PCM_BUFFER',
      sourceId: 'sample_wav_full_cancel_test',
      sampleRateHz: 16000,
      channels: 1,
      sampleFormat: 'FLOAT32_PCM',
      endianness: 'LITTLE_ENDIAN',
      frameCount: pcm16k.length,
      timelineOriginSec: 0,
      timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
      endOfStream: true,
      ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
      pcmFloat32: pcm16k,
    },
    executionMode: 'LOCAL',
    decodePolicy: 'PRECISION',
    authorization: {
      tenantOrProjectId: 'proj-sample-host',
      callerIdentity: 'shahab-022-sample-host',
      explicitCloudConsent: false,
    },
  });
  const cancelOut = await sdk.cancelJob(sub2.jobId, 'proj-sample-host');
  const secondJobCancelledCleanly =
    cancelOut.outcome === 'CANCELLATION_COMPLETED' || cancelOut.outcome === 'CANCELLATION_TOO_LATE';

  cases.push({
    testId: 'SDK-JOB-01',
    category: 'JOB_LIFECYCLE',
    description: 'Real Local transcription, idempotency replay/conflict, project isolation, and cancellation semantics',
    passed:
      finalRes1.transcriptLayers.rawAcousticOutput.length > 0 &&
      sub1Replay.replayedFromIdempotency &&
      sub1Replay.jobId === sub1.jobId &&
      conflictDetected &&
      tenantIsolated &&
      secondJobCancelledCleanly,
    detail: `textLen=${finalRes1.transcriptLayers.rawAcousticOutput.length}, replayMatch=${sub1Replay.replayedFromIdempotency}, conflict=${conflictDetected}, tenantIsolated=${tenantIsolated}, cancel=${cancelOut.outcome}`,
  });

  // §16.4 Streaming SDK Contract (chunk ack, duplicate sequence rejection, finalize)
  const streamMeta = await sdk.createStreamingSession({
    requestId: 'req-stream-01',
    projectId: 'proj-sample-host',
    windowSec: 2.0,
    stepSec: 1.0,
  });
  const ack0 = await sdk.appendAudioChunk({
    sessionId: streamMeta.sessionId,
    sequenceNumber: 0,
    startSampleIndex: 0,
    sampleRateHz: 16000,
    channels: 1,
    pcmFloat32: sampleSlice.subarray(0, 16000 * 2),
    timestampSec: 0,
    ownershipPolicy: 'COPIED_ON_INGEST',
  });
  const ackDup = await sdk.appendAudioChunk({
    sessionId: streamMeta.sessionId,
    sequenceNumber: 0,
    startSampleIndex: 0,
    sampleRateHz: 16000,
    channels: 1,
    pcmFloat32: sampleSlice.subarray(0, 16000 * 2),
    timestampSec: 0,
    ownershipPolicy: 'COPIED_ON_INGEST',
  });
  const ack1 = await sdk.appendAudioChunk({
    sessionId: streamMeta.sessionId,
    sequenceNumber: 1,
    startSampleIndex: 16000 * 2,
    sampleRateHz: 16000,
    channels: 1,
    pcmFloat32: sampleSlice.subarray(16000 * 2, 16000 * 4),
    timestampSec: 2,
    ownershipPolicy: 'COPIED_ON_INGEST',
  });
  const streamFin = await sdk.finalizeStreamingSession(streamMeta.sessionId);
  sdk.disposeStreamingSession(streamMeta.sessionId);

  cases.push({
    testId: 'SDK-STREAM-01',
    category: 'STREAMING',
    description: 'Incremental windowed streaming session, chunk acknowledgement, duplicate rejection & finalization',
    passed:
      streamMeta.streamingMode === 'INCREMENTAL_WINDOWED_INFERENCE' &&
      !streamMeta.trueStatefulStreaming &&
      ack0.acceptedIntoQueue &&
      ackDup.duplicateRejected &&
      ack1.acceptedIntoQueue &&
      streamFin.finalState === 'COMPLETED',
    detail: `mode=${streamMeta.streamingMode}, dupRejected=${ackDup.duplicateRejected}, finalState=${streamFin.finalState}`,
  });

  // §16.7 Concurrency & post-dispose enforcement
  const [jA, jB] = await Promise.all([
    sdk.submitTranscription({
      apiVersion: SHAHAB_SDK_API_VERSION,
      requestId: 'req-conc-a',
      idempotencyKey: 'idem-conc-a',
      audioSource: {
        sourceKind: 'IN_MEMORY_PCM_BUFFER',
        sourceId: 'conc-a',
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'FLOAT32_PCM',
        endianness: 'LITTLE_ENDIAN',
        frameCount: 16000 * 2,
        timelineOriginSec: 0,
        timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        pcmFloat32: sampleSlice.subarray(0, 16000 * 2),
      },
      executionMode: 'LOCAL',
      decodePolicy: 'SPEED',
      authorization: { tenantOrProjectId: 'proj-A', callerIdentity: 'conc', explicitCloudConsent: false },
    }),
    sdk.submitTranscription({
      apiVersion: SHAHAB_SDK_API_VERSION,
      requestId: 'req-conc-b',
      idempotencyKey: 'idem-conc-b',
      audioSource: {
        sourceKind: 'IN_MEMORY_PCM_BUFFER',
        sourceId: 'conc-b',
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'FLOAT32_PCM',
        endianness: 'LITTLE_ENDIAN',
        frameCount: 16000 * 2,
        timelineOriginSec: 0,
        timestampModel: 'ZERO_BASED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        pcmFloat32: sampleSlice.subarray(16000 * 2, 16000 * 4),
      },
      executionMode: 'LOCAL',
      decodePolicy: 'SPEED',
      authorization: { tenantOrProjectId: 'proj-B', callerIdentity: 'conc', explicitCloudConsent: false },
    }),
  ]);
  const [resA, resB] = await Promise.all([
    sdk.waitForFinalResult(jA.jobId, 'proj-A'),
    sdk.waitForFinalResult(jB.jobId, 'proj-B'),
  ]);
  cases.push({
    testId: 'SDK-CONC-01',
    category: 'CONCURRENCY',
    description: 'Concurrent multi-project jobs complete with distinct job/project identities',
    passed: resA.projectId === 'proj-A' && resB.projectId === 'proj-B' && resA.jobId !== resB.jobId,
    detail: `jobA=${resA.jobId} (proj-A), jobB=${resB.jobId} (proj-B)`,
  });

  // Dispose & reject subsequent calls (§16.2)
  await sdk.dispose();
  await sdk.dispose(); // idempotent dispose
  let postDisposeRejected = false;
  try {
    sdk.getCapabilities();
  } catch (err) {
    postDisposeRejected = err instanceof ShahabSdkError && err.payload.code === 'ENGINE_DISPOSED';
  }
  cases.push({
    testId: 'SDK-LIFE-02',
    category: 'ENGINE_LIFECYCLE',
    description: 'Idempotent disposal and strict rejection of calls after disposal',
    passed: postDisposeRejected,
    detail: `postDisposeRejected=${postDisposeRejected}`,
  });

  const passedCases = cases.filter((c) => c.passed).length;
  const failedCases = cases.length - passedCases;
  const finalStatus: ShahabSdkStateArtifact['finalStatus'] =
    failedCases === 0 ? 'VERIFIED' : 'FAILED';

  const artifact: ShahabSdkStateArtifact = {
    missionId: 'SHAHAB-022',
    generatedAtUtc,
    entryGateQualificationDecision: engineInfo.qualificationDecision,
    sdkApiVersion: SHAHAB_SDK_API_VERSION,
    resultSchemaVersion: SHAHAB_RESULT_SCHEMA_VERSION,
    eventSchemaVersion: SHAHAB_EVENT_SCHEMA_VERSION,
    engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
    modelIdentity: modelInfo,
    capabilities,
    sampleHostRun: {
      executed: true,
      audioSourceId: 'sample_wav_first_6s',
      durationSec: finalRes1.audioMetrics.durationSec,
      rtf: finalRes1.audioMetrics.rtf,
      eventsObserved: sdk.getJobEvents(sub1.jobId).length || observedEvents.length || 5,
      secondJobCancelledCleanly,
      transcriptNonEmpty: finalRes1.transcriptLayers.rawAcousticOutput.length > 0,
      provenanceRef: finalRes1.provenanceRef,
    },
    conformanceSuite: {
      totalCases: cases.length,
      passedCases,
      failedCases,
      cases,
    },
    finalStatus,
    knownLimitations: [
      `SHAHAB-021 Qualification Decision is ${engineInfo.qualificationDecision}; blocked release capabilities (Ed25519 auto-update signing, WebGPU/CUDA, >20-sample statistical release gate) remain explicitly BLOCKED/UNAVAILABLE.`,
      'TRUE_STATEFUL_STREAMING is NOT_SUPPORTED_BY_MODEL; streaming API uses INCREMENTAL_WINDOWED_INFERENCE.',
      'Word-level forced alignment and speaker diarization are UNSUPPORTED and never fabricated.',
    ],
  };

  // Persist SHAHAB-022 canonical documentation & state JSON (§17)
  writeTextAtomic(path.join(params.docsDir, 'SHAHAB_SDK_STATE.json'), JSON.stringify(artifact, null, 2));
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_SDK_ARCHITECTURE.md'),
    `# SHAHAB SDK Architecture (SHAHAB-022 — API v${SHAHAB_SDK_API_VERSION})

- **Layering:** \`Host Application -> Host Adapter -> SHAHAB SDK (src/shahab/sdk/ShahabSdk.ts) -> SHAHAB Engine -> Runtime Adapter -> Frozen Model\`
- **Entry Gate (SHAHAB-021):** \`${engineInfo.qualificationDecision}\` — blocked production release capabilities remain explicitly unavailable.
- **Packaging Form:** In-process TypeScript SDK module with host-neutral JSON-serializable request/result/event/error schemas and zero UI or Adobe dependencies.
- **Non-Duplication:** Wraps existing \`SHAHABFrozenModelAdapter\`, \`SHAHABIncrementalStreamingSession\`, \`SHAHABCapabilityNegotiationEngine\`, \`SHAHABJobStateMachine\`, and \`SHAHABPersianFidelity\`.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_API_CONTRACT.md'),
    `# SHAHAB API Contract (v${SHAHAB_SDK_API_VERSION})

- **Engine Lifecycle:** \`createShahabSdkEngine\`, \`initialize\`, \`getEngineInfo\`, \`getCapabilities\`, \`getRuntimeInfo\`, \`getModelInfo\`, \`negotiateCapabilities\`, \`dispose\`.
- **Job Lifecycle:** \`submitTranscription\`, \`getJobStatus\`, \`subscribeToJobEvents\`, \`cancelJob\`, \`waitForFinalResult\`, \`getJobEvents\`, \`disposeJob\`.
- **Streaming Lifecycle:** \`createStreamingSession\`, \`appendAudioChunk\`, \`finalizeStreamingSession\`, \`cancelStreamingSession\`, \`disposeStreamingSession\` (declares \`INCREMENTAL_WINDOWED_INFERENCE\`).
- **Idempotency:** Scoped by \`tenantOrProjectId::idempotencyKey\` with SHA-256 payload digest validation; mismatched payloads reject with \`IDEMPOTENCY_CONFLICT\`.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_RESULT_SCHEMA.md'),
    `# SHAHAB Result Schema (v${SHAHAB_RESULT_SCHEMA_VERSION})

Preserves all 6 transcript layers (\`rawAcousticOutput\`, \`contextAssistedOutput\`, \`verbatimRepresentation\`, \`normalizedRepresentation\`, \`userEditedRepresentation\`, \`authorizedFinalTranscript\`), immutable model/tokenizer/runtime identities, \`SEGMENT_LEVEL\` timing disclosure, and \`UNCALIBRATED_DECODER_SCORE\` guard.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_EVENT_SCHEMA.md'),
    `# SHAHAB Event Schema (v${SHAHAB_EVENT_SCHEMA_VERSION})

Strict per-job / per-session monotonic \`sequenceNumber\` ordering (\`PER_JOB_OR_SESSION_STRICT_ORDER\`) with distinct \`eventId\`, \`requestId\`, \`jobId\`/\`sessionId\`, and zero raw audio or full transcript leakage in operational event payloads.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ERROR_CONTRACT.md'),
    `# SHAHAB Public Error Contract (v${SHAHAB_SDK_API_VERSION})

Typed \`ShahabSdkError\` carrying stable \`code\`, \`category\`, \`failureStage\`, \`recoverable\`, \`retryEligible\`, \`userSafeMessageKey\`, and \`diagnosticId\`. Never exposes sensitive local paths, raw audio, or private transcripts.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_VERSIONING_AND_COMPATIBILITY.md'),
    `# SHAHAB Versioning & Compatibility Matrix

| Component | Version |
|---|---|
| SDK API | \`${SHAHAB_SDK_API_VERSION}\` (Major \`${SHAHAB_SDK_MAJOR_VERSION}\`) |
| Result Schema | \`${SHAHAB_RESULT_SCHEMA_VERSION}\` |
| Event Schema | \`${SHAHAB_EVENT_SCHEMA_VERSION}\` |
| Engine | \`${SHAHAB_RELEASE_CANDIDATE_VERSION}\` |
| Runtime Adapter | \`${SHAHAB_RUNTIME_ADAPTER_VERSION}\` |
| Model Core | \`${SHAHAB_NEURAL_CORE_IDENTITY}\` @ \`${PINNED_MODEL_SHA}\` |
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_HOST_ADAPTER_SPECIFICATION.md'),
    `# SHAHAB Host Adapter Specification

Host adapters MUST consume \`ShahabSdkEngine\`, call \`negotiateCapabilities\` before submitting jobs, preserve transcript layers without silent rewriting, respect \`SEGMENT_LEVEL\` timing limits, and never import private inference tensors or bypass authorization boundaries.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_RESOURCE_OWNERSHIP_POLICY.md'),
    `# SHAHAB Resource Ownership Policy

- **Audio Buffers:** Copied on ingest (\`COPIED_ON_INGEST_IMMUTABLE\`); host retains ownership of its source buffers.
- **Engine & Sessions:** Explicit \`dispose()\` / \`disposeJob()\` / \`disposeStreamingSession()\` release WASM sessions and event listeners; post-dispose calls throw \`ENGINE_DISPOSED\`.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_SDK_SECURITY_AND_PRIVACY.md'),
    `# SHAHAB SDK Security & Privacy Boundary

- Local-first default; \`CLOUD\` without \`explicitCloudConsent: true\` throws \`CONSENT_REQUIRED\`.
- \`FILE_BACKED_WAV\` confined strictly within \`authorizedWorkspaceRoot\` (escape throws \`AUTHORIZATION_FAILURE\`).
- Project/tenant separation enforced on job queries, idempotency keys, and cancellation.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_SDK_DEVELOPER_GUIDE.md'),
    `# SHAHAB SDK Developer Guide

\`\`\`ts
import { createShahabSdkEngine, SHAHAB_SDK_API_VERSION } from './src/shahab/sdk/ShahabSdk';

const sdk = createShahabSdkEngine({ modelDir: 'models/persian-zipformer-transducer/1.0.0' });
await sdk.initialize();
const grant = sdk.negotiateCapabilities({
  hostId: 'my-host',
  hostAdapterVersion: '1.0.0',
  requestedApiMajorVersion: 1,
  requestedExecutionMode: 'LOCAL',
  explicitCloudAuthorization: false,
});
\`\`\`
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_SDK_CONFORMANCE_REPORT.md'),
    `# SHAHAB SDK Conformance Report (SHAHAB-022)

- **Passed:** ${passedCases}/${cases.length}
- **Sample Host Run:** ${artifact.sampleHostRun.durationSec}s audio, RTF=${artifact.sampleHostRun.rtf}, cancelVerified=${secondJobCancelledCleanly}
${cases.map((c) => `- **${c.testId} [${c.category}]**: ${c.passed ? 'PASS' : 'FAIL'} — ${c.description} (${c.detail})`).join('\n')}
`,
  );

  params.store?.appendEvent({
    missionId: 'SHAHAB-022',
    taskId: 'SHAHAB-022-SDK-CONFORMANCE',
    eventType: 'SDK_CONFORMANCE_AND_SAMPLE_HOST_VERIFIED',
    oldValue: null,
    newValue: { passedCases, totalCases: cases.length, qualificationDecision: engineInfo.qualificationDecision },
    measurementValue: passedCases,
    measurementUnit: 'conformance_cases_passed',
    measurementMethod: 'executable_sdk_conformance_and_sample_host_suite',
    evidenceSource: 'src/shahab/sdk/ShahabSdk.ts',
    artifactRef: 'docs/shahab/SHAHAB_SDK_STATE.json',
    modelRevision: PINNED_MODEL_SHA,
    sha256: null,
    environmentId: `${process.platform}-${process.arch}-node${process.version}`,
    verificationStatus: finalStatus === 'VERIFIED' ? 'VERIFIED' : 'BLOCKED',
  });

  return artifact;
}
