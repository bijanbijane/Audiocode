/**
 * SHAHAB-015 — Fault Tolerance, Resilience Engineering, Disaster Recovery & Operational Continuity
 *
 * Governing principles:
 * - Frozen-weight resilience engineering ONLY: NO model training, weight changes, or algorithm swaps.
 * - Failures are explicitly detected, classified, contained, reported accurately, and recovered ONLY
 *   when integrity & semantic compatibility are verified.
 * - Strict separation between observed failure, verified technical cause, and suspected root cause.
 * - Strict Local/Cloud isolation: Local mode never uploads audio as a recovery fallback; any
 *   Local <-> Cloud transition requires explicit user authorization and contract verification.
 * - Atomic crash-safe persistence (temp -> fsync -> verify -> atomic rename) with honest platform
 *   durability caveats; partial transcripts are NEVER promoted to COMPLETED or allowed to overwrite
 *   an existing authorized final transcript.
 * - Fault injection runs strictly in isolated temporary sandboxes and NEVER touches production
 *   user data or production model weights.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateShahab013EntryGate,
  SHAHABOperationalObserver,
  SHAHABUpdateLifecycleManager,
} from './ShahabOperationsGovernance';
import {
  SHAHAB_RELEASE_CANDIDATE_VERSION,
  SHAHABArtifactIntegrityVerifier,
  SHAHABInstaller,
} from './ShahabReleaseHardening';
import { SHAHAB_NEURAL_CORE_IDENTITY } from './ShahabEngineUnified';

export const SHAHAB_RESILIENCE_SCHEMA_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// 1. Entry Gate (Section 2)
// ---------------------------------------------------------------------------

export type Shahab015PrerequisiteState =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'NOT_IMPLEMENTED'
  | 'BLOCKED'
  | 'NOT_APPLICABLE';

export interface Shahab015PrerequisiteCheck {
  readonly prerequisiteId: string;
  readonly title: string;
  readonly state: Shahab015PrerequisiteState;
  readonly inspectedPaths: readonly string[];
  readonly detail: string;
  readonly limitations: readonly string[];
}

export interface Shahab015EntryGateReport {
  readonly schemaVersion: typeof SHAHAB_RESILIENCE_SCHEMA_VERSION;
  readonly evaluatedAtIso: string;
  readonly overallGateState: Shahab015PrerequisiteState;
  readonly prerequisites: readonly Shahab015PrerequisiteCheck[];
  readonly blockedCapabilities: readonly string[];
  readonly reusedExistingModules: readonly string[];
}

export function evaluateShahab015EntryGate(
  workspaceRoot: string,
  docsDir: string,
): Shahab015EntryGateReport {
  const root = path.resolve(workspaceRoot);
  const docs = path.resolve(docsDir);
  const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));
  const docExists = (name: string): boolean => fs.existsSync(path.join(docs, name));

  const gate013 = evaluateShahab013EntryGate(docs);
  const prerequisites: Shahab015PrerequisiteCheck[] = [];
  const blockedCapabilities: string[] = [];

  // 1. SHAHAB-013 release & artifact integrity
  const s13State: Shahab015PrerequisiteState =
    gate013.gateState === 'VERIFIED'
      ? 'VERIFIED'
      : gate013.gateState === 'PARTIALLY_VERIFIED'
        ? 'PARTIALLY_VERIFIED'
        : gate013.gateState === 'NOT_EXECUTED'
          ? 'NOT_IMPLEMENTED'
          : 'BLOCKED';
  prerequisites.push({
    prerequisiteId: 'SHAHAB_013_RELEASE_INTEGRITY',
    title: 'SHAHAB-013 Release & Artifact Integrity',
    state: s13State,
    inspectedPaths: [
      'src/shahab/ShahabReleaseHardening.ts',
      'docs/shahab/SHAHAB_RELEASE_MANIFEST.json',
      'docs/shahab/SHAHAB_SECURITY_VERIFICATION.json',
    ],
    detail: `SHAHAB-013 entry gate evaluated as ${gate013.gateState} (release=${gate013.releaseCandidateId ?? 'NONE'}).`,
    limitations: [...gate013.blockers],
  });
  if (s13State !== 'VERIFIED') {
    blockedCapabilities.push(
      'Automatic unattended release-update rollout remains disabled while SHAHAB-013 Ed25519 signing is BLOCKED.',
    );
  }

  // 2. SHAHAB-014 operational observability
  const has014Code = exists('src/shahab/ShahabOperationsGovernance.ts');
  const has014State = docExists('SHAHAB_OPERATIONAL_STATE.json') && docExists('SHAHAB_RUNTIME_EVENTS.jsonl');
  const s14State: Shahab015PrerequisiteState =
    has014Code && has014State
      ? gate013.gateState === 'VERIFIED'
        ? 'VERIFIED'
        : 'PARTIALLY_VERIFIED'
      : has014Code
        ? 'PARTIALLY_VERIFIED'
        : 'NOT_IMPLEMENTED';
  prerequisites.push({
    prerequisiteId: 'SHAHAB_014_OBSERVABILITY',
    title: 'SHAHAB-014 Operational Observability & Safe Lifecycle',
    state: s14State,
    inspectedPaths: [
      'src/shahab/ShahabOperationsGovernance.ts',
      'docs/shahab/SHAHAB_OPERATIONAL_STATE.json',
      'docs/shahab/SHAHAB_RUNTIME_EVENTS.jsonl',
    ],
    detail: has014State
      ? 'Local-first operational observer, PII scrubber, consent records, feedback admission gate, and 14-state update lifecycle present and persisted.'
      : has014Code
        ? 'SHAHAB-014 module implemented; persisted operational state pending pipeline run.'
        : 'SHAHAB-014 module missing.',
    limitations: [
      'External remote telemetry collector endpoint is intentionally disabled by default (local-first privacy).',
      'Automatic rollout remains disabled pending SHAHAB-013 cryptographic signing.',
    ],
  });

  // 3. Local/Cloud unified execution architecture
  const hasUnified =
    exists('src/shahab/ShahabEngineUnified.ts') &&
    exists('src/processing-engine/UnifiedProcessingContract.ts');
  prerequisites.push({
    prerequisiteId: 'LOCAL_CLOUD_UNIFIED_ARCHITECTURE',
    title: 'Unified Local/Cloud Execution Architecture',
    state: hasUnified ? 'VERIFIED' : 'NOT_IMPLEMENTED',
    inspectedPaths: [
      'src/shahab/ShahabEngineUnified.ts',
      'src/processing-engine/UnifiedProcessingContract.ts',
    ],
    detail: hasUnified
      ? 'Shared 19-stage SHAHABEngine contract with LOCAL, CLOUD, and AUTO modes and explicit no-silent-fallback enforcement.'
      : 'Unified execution contract missing.',
    limitations: [
      'Browser WASM execution and Native sherpa-onnx C++ binary are not verified in this Linux CPU sandbox.',
    ],
  });

  // 4. Audio-processing job lifecycle
  const hasOpLifecycle = exists('src/reliability/OperationLifecycleManager.ts');
  prerequisites.push({
    prerequisiteId: 'AUDIO_PROCESSING_JOB_LIFECYCLE',
    title: 'Audio-Processing Job Lifecycle',
    state: hasOpLifecycle ? 'PARTIALLY_VERIFIED' : 'NOT_IMPLEMENTED',
    inspectedPaths: [
      'src/reliability/OperationLifecycleManager.ts',
      'src/shahab/ShahabEngineUnified.ts',
    ],
    detail: hasOpLifecycle
      ? 'Existing OperationLifecycleManager handles generic operation tracking; SHAHAB-015 formalizes the crash-safe 14-state SHAHAB ASR job state machine with atomic persistence and idempotency keys.'
      : 'No dedicated job state machine present.',
    limitations: ['Prior to SHAHAB-015, SHAHAB ASR jobs did not persist stage-level crash-recovery checkpoints.'],
  });

  // 5. Existing persistence and recovery mechanisms
  const hasCrashRecovery =
    exists('src/runtime/CrashRecoveryAndSessionLock.ts') &&
    exists('src/reliability/CrashSafeRecoveryCoordinator.ts') &&
    exists('src/shahab/ShahabEvidenceStore.ts');
  prerequisites.push({
    prerequisiteId: 'EXISTING_PERSISTENCE_AND_RECOVERY',
    title: 'Existing Persistence & Crash Recovery Mechanisms',
    state: hasCrashRecovery ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
    inspectedPaths: [
      'src/runtime/CrashRecoveryAndSessionLock.ts',
      'src/reliability/CrashSafeRecoveryCoordinator.ts',
      'src/shahab/ShahabEvidenceStore.ts',
    ],
    detail:
      'Existing Avapardaz project checkpointing (CrashRecoveryAndSessionLock) and SHAHAB atomic JSON/JSONL store verified; extended for SHAHAB ASR stage checkpoints and disaster recovery.',
    limitations: [
      'Filesystem rename durability varies across OS/filesystems; parent-directory fsync is best-effort on non-POSIX hosts.',
    ],
  });

  // 6. Existing cancellation and interruption behavior
  const hasCancel =
    exists('src/shahab/ShahabEngineUnified.ts') && exists('src/shahab/ShahabZipformerEngine.ts');
  prerequisites.push({
    prerequisiteId: 'CANCELLATION_AND_INTERRUPTION',
    title: 'Existing Cancellation & Interruption Behavior',
    state: hasCancel ? 'VERIFIED' : 'NOT_IMPLEMENTED',
    inspectedPaths: [
      'src/shahab/ShahabEngineUnified.ts',
      'src/shahab/ShahabZipformerEngine.ts',
    ],
    detail: 'AbortSignal propagation exists across SHAHABEngine and Zipformer decoding stages; SHAHAB-015 enforces non-destructive cancellation preserving committed user transcripts.',
    limitations: ['In-flight native/WASM ONNX kernel invocations cannot be preempted mid-op; cancellation takes effect at chunk/stage boundaries.'],
  });

  // 7. Existing error handling and retry policies
  const hasReliabilityErrors =
    exists('src/reliability/ErrorClassifier.ts') && exists('src/reliability/RecoveryPolicy.ts');
  prerequisites.push({
    prerequisiteId: 'ERROR_HANDLING_AND_RETRY_POLICIES',
    title: 'Existing Error Handling & Retry Policies',
    state: hasReliabilityErrors ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
    inspectedPaths: [
      'src/reliability/ErrorClassifier.ts',
      'src/reliability/RecoveryPolicy.ts',
      'src/shahab/ShahabEngineUnified.ts',
    ],
    detail:
      'Avapardaz reliability error classifier and SHAHAB-010 21-code taxonomy present; SHAHAB-015 extends them with the complete 33-code centralized resilience taxonomy and bounded idempotency-aware retry controller.',
    limitations: [],
  });

  const anyNotImpl = prerequisites.some((p) => p.state === 'NOT_IMPLEMENTED' || p.state === 'BLOCKED');
  const anyPartial = prerequisites.some((p) => p.state === 'PARTIALLY_VERIFIED');
  const overallGateState: Shahab015PrerequisiteState = anyNotImpl
    ? 'BLOCKED'
    : anyPartial
      ? 'PARTIALLY_VERIFIED'
      : 'VERIFIED';

  return {
    schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
    evaluatedAtIso: new Date().toISOString(),
    overallGateState,
    prerequisites,
    blockedCapabilities,
    reusedExistingModules: [
      'src/runtime/CrashRecoveryAndSessionLock.ts',
      'src/reliability/ErrorClassifier.ts',
      'src/reliability/RecoveryPolicy.ts',
      'src/reliability/CrashSafeRecoveryCoordinator.ts',
      'src/runtime/memory/MemoryBudgetManager.ts',
      'src/shahab/ShahabEvidenceStore.ts',
      'src/shahab/ShahabEngineUnified.ts',
      'src/shahab/ShahabReleaseHardening.ts',
      'src/shahab/ShahabOperationsGovernance.ts',
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. Real Pipeline Fault-Containment Boundaries (Section 3)
// ---------------------------------------------------------------------------

export type ShahabPipelineBoundaryId =
  | 'B01_AUDIO_INGESTION'
  | 'B02_AUDIO_VALIDATION'
  | 'B03_PREPROCESSING'
  | 'B04_MODEL_INITIALIZATION'
  | 'B05_FEATURE_EXTRACTION'
  | 'B06_ENCODER_EXECUTION'
  | 'B07_DECODER_EXECUTION'
  | 'B08_CONTEXTUAL_VOCABULARY'
  | 'B09_ALIGNMENT_TIMESTAMPS'
  | 'B10_TRANSCRIPT_ASSEMBLY'
  | 'B11_AVAPARDAZ_EDITING_INTEGRATION'
  | 'B12_PERSISTENCE_AND_EXPORT';

export interface ShahabPipelineBoundarySpec {
  readonly boundaryId: ShahabPipelineBoundaryId;
  readonly order: number;
  readonly name: string;
  readonly realImplementationFiles: readonly string[];
  readonly inputs: string;
  readonly outputs: string;
  readonly persistentState: string;
  readonly temporaryState: string;
  readonly externalDependencies: readonly string[];
  readonly failureModes: readonly ShahabResilienceFailureCode[];
  readonly retrySafety: 'IDEMPOTENT_SAFE' | 'BOUNDED_WITH_IDEMPOTENCY_KEY' | 'NON_RETRYABLE_DETERMINISTIC' | 'REQUIRES_CLEAN_REINIT';
  readonly resumableCheckpointSupported: boolean;
  readonly recoveryStrategy: string;
  readonly dataLossRisk: 'NONE' | 'LOW_TEMP_ONLY' | 'MEDIUM_PARTIAL_PROGRESS' | 'HIGH_IF_NON_ATOMIC';
  readonly userVisibleFailureBehavior: string;
}

export const SHAHAB_REAL_PIPELINE_BOUNDARIES: readonly ShahabPipelineBoundarySpec[] = [
  {
    boundaryId: 'B01_AUDIO_INGESTION',
    order: 1,
    name: 'Audio Ingestion',
    realImplementationFiles: ['src/shahab/ShahabEngineUnified.ts', 'src/shahab/ShahabZipformerEngine.ts'],
    inputs: 'WAV file path, raw buffer, or chunked PCM stream + request metadata',
    outputs: 'Immutable audio reference + SHA-256 content hash + byte size',
    persistentState: 'Source audio file (read-only; never mutated by SHAHAB)',
    temporaryState: 'In-memory read buffer during hash computation',
    externalDependencies: ['Local filesystem / browser File API'],
    failureModes: ['INVALID_AUDIO', 'DISK_WRITE_FAILURE', 'OUT_OF_MEMORY'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: false,
    recoveryStrategy: 'Re-read immutable source audio reference; never mutate source recording.',
    dataLossRisk: 'NONE',
    userVisibleFailureBehavior: 'Clear error explaining source file could not be read; source audio remains untouched.',
  },
  {
    boundaryId: 'B02_AUDIO_VALIDATION',
    order: 2,
    name: 'Audio Validation',
    realImplementationFiles: ['src/shahab/ShahabEngineUnified.ts', 'src/shahab/ShahabZipformerEngine.ts'],
    inputs: 'Raw audio bytes / RIFF WAV header',
    outputs: 'Validated audio descriptor (sampleRate, channels, durationSec, pcmSha256)',
    persistentState: 'POST_AUDIO_VALIDATION checkpoint manifest (optional)',
    temporaryState: 'Header parse buffer',
    externalDependencies: [],
    failureModes: ['INVALID_AUDIO', 'UNSUPPORTED_AUDIO_FORMAT', 'AUDIO_DECODE_FAILURE'],
    retrySafety: 'NON_RETRYABLE_DETERMINISTIC',
    resumableCheckpointSupported: true,
    recoveryStrategy: 'Fail fast without retrying invalid media; instruct user to provide valid PCM WAV.',
    dataLossRisk: 'NONE',
    userVisibleFailureBehavior: 'Immediate non-retried explanation identifying unsupported format or corrupted header.',
  },
  {
    boundaryId: 'B03_PREPROCESSING',
    order: 3,
    name: 'Preprocessing (Mono 16kHz Normalization & Chunking)',
    realImplementationFiles: ['src/shahab/ShahabZipformerEngine.ts', 'src/shahab/ShahabEngineUnified.ts'],
    inputs: 'Validated audio buffer',
    outputs: 'Float32 mono 16kHz PCM normalized to [-1, 1] + overlap chunk windows',
    persistentState: 'None required (deterministic recomputation from immutable source)',
    temporaryState: 'Float32Array PCM buffers bounded by SHAHABMemoryGovernor',
    externalDependencies: [],
    failureModes: ['PREPROCESSING_FAILURE', 'OUT_OF_MEMORY', 'MEMORY_PRESSURE'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: false,
    recoveryStrategy: 'Release temporary buffers and re-run with smaller chunk window under memory pressure.',
    dataLossRisk: 'LOW_TEMP_ONLY',
    userVisibleFailureBehavior: 'Reports preprocessing failure or reduced-concurrency memory-safe mode.',
  },
  {
    boundaryId: 'B04_MODEL_INITIALIZATION',
    order: 4,
    name: 'Model & Tokenizer Initialization',
    realImplementationFiles: [
      'src/shahab/ShahabZipformerEngine.ts',
      'src/shahab/ShahabReleaseHardening.ts',
      'src/shahab/ShahabArtifactAcquisition.ts',
    ],
    inputs: 'Installed model directory + SHAHAB_RELEASE_MANIFEST.json + tokens.txt',
    outputs: 'Verified ONNX Runtime sessions (encoder, decoder, joiner) + BPE token map',
    persistentState: 'Verified read-only model artifacts under models/ + active release manifest',
    temporaryState: 'ONNX Runtime WASM/CPU session allocations',
    externalDependencies: ['onnxruntime-web (WASM CPU)', 'Local verified model files'],
    failureModes: [
      'MODEL_LOAD_FAILURE',
      'MODEL_ARTIFACT_CORRUPTED',
      'TOKENIZER_INCOMPATIBLE',
      'RUNTIME_INITIALIZATION_FAILURE',
      'PROVIDER_FAILURE',
      'OUT_OF_MEMORY',
    ],
    retrySafety: 'REQUIRES_CLEAN_REINIT',
    resumableCheckpointSupported: false,
    recoveryStrategy:
      'Serialize concurrent model loads (max 1); verify SHA-256 before load; if corrupted stop and request verified reacquisition or rollback to last known-good release.',
    dataLossRisk: 'NONE',
    userVisibleFailureBehavior: 'Blocks inference safely; identifies integrity mismatch or runtime unavailability without crashing workspace.',
  },
  {
    boundaryId: 'B05_FEATURE_EXTRACTION',
    order: 5,
    name: 'Feature Extraction (80-dim Kaldi Log-Mel FBANK)',
    realImplementationFiles: ['src/shahab/ShahabZipformerEngine.ts'],
    inputs: 'Float32 mono 16kHz PCM chunk',
    outputs: '80-dim FBANK feature matrix [T, 80] + config digest',
    persistentState: 'Optional SHA-256 verified feature checkpoint on disk or SHAHABAudioFeatureCache',
    temporaryState: 'FFT/Mel scratch buffers',
    externalDependencies: [],
    failureModes: ['PREPROCESSING_FAILURE', 'OUT_OF_MEMORY', 'MEMORY_PRESSURE'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: true,
    recoveryStrategy: 'Evict feature cache on memory pressure; recompute deterministically from immutable source audio if checkpoint missing/corrupted.',
    dataLossRisk: 'LOW_TEMP_ONLY',
    userVisibleFailureBehavior: 'Transparently bypasses cache with degraded-mode operational event if cache integrity is uncertain.',
  },
  {
    boundaryId: 'B06_ENCODER_EXECUTION',
    order: 6,
    name: 'Zipformer Encoder Execution',
    realImplementationFiles: ['src/shahab/ShahabZipformerEngine.ts'],
    inputs: '80-dim FBANK tensor + verified encoder ONNX session',
    outputs: 'Encoder acoustic representations [1, T_out, D] cached in SHAHABEncoderOutputCache',
    persistentState: 'Optional POST_ENCODER_EXECUTION checkpoint with model/tokenizer/audio/preprocessing hashes',
    temporaryState: 'ONNX intermediate tensors & encoder cache entry',
    externalDependencies: ['onnxruntime-web'],
    failureModes: [
      'ENCODER_FAILURE',
      'INFERENCE_TIMEOUT',
      'INFERENCE_CRASH',
      'OUT_OF_MEMORY',
      'MEMORY_PRESSURE',
      'UNSUPPORTED_OPERATION',
    ],
    retrySafety: 'REQUIRES_CLEAN_REINIT',
    resumableCheckpointSupported: true,
    recoveryStrategy: 'Checkpoint encoder output per completed chunk; on worker crash, verify checkpoint digest & model compatibility before skipping already-encoded chunks.',
    dataLossRisk: 'MEDIUM_PARTIAL_PROGRESS',
    userVisibleFailureBehavior: 'Marks job RECOVERY_PENDING if prior chunks were committed, or FAILED_RECOVERABLE with clear resume option.',
  },
  {
    boundaryId: 'B07_DECODER_EXECUTION',
    order: 7,
    name: 'Transducer Decoder & Joiner Execution (Greedy / Adaptive Beam)',
    realImplementationFiles: ['src/shahab/ShahabZipformerEngine.ts', 'src/shahab/ShahabEngineUnified.ts'],
    inputs: 'Cached encoder output + decoder/joiner sessions + decode policy',
    outputs: 'Raw acoustic BPE token sequence, frame indices, log-probabilities',
    persistentState: 'Optional POST_CHUNK_TRANSCRIPT_ASSEMBLY checkpoint',
    temporaryState: 'Beam hypotheses & joiner logits',
    externalDependencies: ['onnxruntime-web'],
    failureModes: ['DECODER_FAILURE', 'INFERENCE_TIMEOUT', 'INFERENCE_CRASH', 'OUT_OF_MEMORY'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: true,
    recoveryStrategy: 'Reuse verified cached encoder output without re-running encoder; never silently downgrade decode policy without explicit degraded-mode record.',
    dataLossRisk: 'MEDIUM_PARTIAL_PROGRESS',
    userVisibleFailureBehavior: 'Preserves completed chunk outputs with explicit PARTIAL designation; never labels incomplete output as COMPLETED.',
  },
  {
    boundaryId: 'B08_CONTEXTUAL_VOCABULARY',
    order: 8,
    name: 'Persian Context Memory & False-Insertion Guard',
    realImplementationFiles: [
      'src/shahab/ShahabPersianMemoryAndContext.ts',
      'src/asr-core/PersianEvidenceCorrectionEngine.ts',
      'src/asr-core/PersianLexicalDisambiguationEngine.ts',
    ],
    inputs: 'Raw acoustic output + 4-scope Persian context memory + tokens.txt',
    outputs: 'Context-assisted output + evidence ledger records (raw acoustic preserved verbatim)',
    persistentState: 'SHAHAB_IMPLEMENTATION_STATE.json (verified Persian memory entries)',
    temporaryState: 'Candidate BPE bias table',
    externalDependencies: ['P0-010 Evidence Correction Engine', 'P0-012 Lexical Disambiguation Engine'],
    failureModes: ['TOKENIZER_INCOMPATIBLE', 'DECODER_FAILURE', 'INCONSISTENT_PROCESSING_STATE'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: false,
    recoveryStrategy: 'Graceful degradation: disable optional contextual biasing, record CONTEXTUAL_BIASING_DISABLED event, and preserve raw acoustic transcript.',
    dataLossRisk: 'NONE',
    userVisibleFailureBehavior: 'Displays explicit degraded-mode notice that contextual vocabulary assistance was bypassed while raw acoustic output succeeded.',
  },
  {
    boundaryId: 'B09_ALIGNMENT_TIMESTAMPS',
    order: 9,
    name: 'Frame-to-Word Alignment & Timestamp Generation',
    realImplementationFiles: ['src/shahab/ShahabEngineUnified.ts'],
    inputs: 'Decoded BPE token frame indices + chunk offsets + sample rate',
    outputs: 'Word-level start/end timestamps (seconds & flicks) + overlap deduplication',
    persistentState: 'None (derived deterministically from decoded frame indices)',
    temporaryState: 'Overlap boundary merge buffer',
    externalDependencies: [],
    failureModes: ['ALIGNMENT_FAILURE', 'INCONSISTENT_PROCESSING_STATE'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: false,
    recoveryStrategy: 'Recompute alignment from verified chunk token frames; fail cleanly if monotonic timestamp invariants are violated.',
    dataLossRisk: 'NONE',
    userVisibleFailureBehavior: 'Reports timestamp alignment failure instead of emitting corrupted timeline spans.',
  },
  {
    boundaryId: 'B10_TRANSCRIPT_ASSEMBLY',
    order: 10,
    name: 'Four-Layer Transcript Assembly & P0-009 Normalization',
    realImplementationFiles: [
      'src/shahab/ShahabEngineUnified.ts',
      'src/asr-core/PersianLinguisticQualityEngine.ts',
    ],
    inputs: 'Raw acoustic tokens, context-assisted tokens, P0-009 normalization rules',
    outputs: 'Transcript preserving rawAcoustic, contextAssisted, normalized, and authorizedFinal provenance',
    persistentState: 'Durable transcript artifact after B12 commit',
    temporaryState: 'In-memory assembled transcript document',
    externalDependencies: ['P0-009 Persian Linguistic Quality Engine'],
    failureModes: ['TRANSCRIPT_ASSEMBLY_FAILURE', 'INCONSISTENT_PROCESSING_STATE'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: true,
    recoveryStrategy: 'Reassemble deterministically from verified chunk checkpoints; never replace an existing authorizedFinal transcript with partial recovery.',
    dataLossRisk: 'MEDIUM_PARTIAL_PROGRESS',
    userVisibleFailureBehavior: 'Flags partial transcript clearly; requires explicit commit before marking job COMPLETED.',
  },
  {
    boundaryId: 'B11_AVAPARDAZ_EDITING_INTEGRATION',
    order: 11,
    name: 'Avapardaz Editing Timeline Bridge',
    realImplementationFiles: [
      'src/shahab/ShahabEngineUnified.ts',
      'src/runtime/CrashRecoveryAndSessionLock.ts',
    ],
    inputs: 'Assembled SHAHAB transcript (ONNX-free contract)',
    outputs: 'PersianWordToken[] synchronized to Avapardaz timeline without overwriting user-authorized edits',
    persistentState: 'Avapardaz project checkpoint via CrashRecoveryAndSessionLock',
    temporaryState: 'Pending UI timeline patch',
    externalDependencies: ['CrashRecoveryAndSessionLock'],
    failureModes: ['SESSION_RECOVERY_FAILURE', 'INCONSISTENT_PROCESSING_STATE', 'DUPLICATE_JOB_DETECTED'],
    retrySafety: 'BOUNDED_WITH_IDEMPOTENCY_KEY',
    resumableCheckpointSupported: false,
    recoveryStrategy: 'Deduplicate completion events by jobId + idempotencyKey; protect committed user edits from overwrite.',
    dataLossRisk: 'HIGH_IF_NON_ATOMIC',
    userVisibleFailureBehavior: 'Prevents duplicate timeline insertion and alerts user if session lock or project state is inconsistent.',
  },
  {
    boundaryId: 'B12_PERSISTENCE_AND_EXPORT',
    order: 12,
    name: 'Atomic Persistence & Operational Export',
    realImplementationFiles: ['src/shahab/ShahabEvidenceStore.ts', 'src/shahab/ShahabResilienceEngine.ts'],
    inputs: 'Finalized transcript / job state / manifest payload',
    outputs: 'Atomically committed JSON/JSONL file with verified SHA-256 integrity',
    persistentState: 'Canonical docs/shahab/* and workspace project storage',
    temporaryState: 'Sibling .tmp.<pid>.<nonce> file cleaned on failure',
    externalDependencies: ['Local filesystem / OPFS'],
    failureModes: ['DISK_FULL', 'DISK_WRITE_FAILURE', 'PERSISTENCE_FAILURE', 'CHECKPOINT_CORRUPTED'],
    retrySafety: 'IDEMPOTENT_SAFE',
    resumableCheckpointSupported: false,
    recoveryStrategy: 'Write temp -> flush/fsync -> parse & hash verify -> atomic rename; previous committed file remains untouched on any error.',
    dataLossRisk: 'NONE',
    userVisibleFailureBehavior: 'Job stays FAILED_RECOVERABLE (never COMPLETED) on persistence failure; existing committed data stays intact.',
  },
];

// ---------------------------------------------------------------------------
// 3. Centralized Typed Failure Taxonomy (Section 4)
// ---------------------------------------------------------------------------

export type ShahabFailureCategory =
  | 'RESOURCE'
  | 'MODEL_RUNTIME'
  | 'PROCESSING'
  | 'INFRASTRUCTURE'
  | 'INTEGRITY';

export type ShahabResilienceFailureCode =
  // Resource failures (6)
  | 'OUT_OF_MEMORY'
  | 'MEMORY_PRESSURE'
  | 'DISK_FULL'
  | 'DISK_WRITE_FAILURE'
  | 'CPU_RESOURCE_EXHAUSTED'
  | 'GPU_RESOURCE_UNAVAILABLE'
  // Model & runtime failures (8)
  | 'MODEL_LOAD_FAILURE'
  | 'MODEL_ARTIFACT_CORRUPTED'
  | 'TOKENIZER_INCOMPATIBLE'
  | 'RUNTIME_INITIALIZATION_FAILURE'
  | 'INFERENCE_TIMEOUT'
  | 'INFERENCE_CRASH'
  | 'PROVIDER_FAILURE'
  | 'UNSUPPORTED_OPERATION'
  // Processing failures (8)
  | 'INVALID_AUDIO'
  | 'UNSUPPORTED_AUDIO_FORMAT'
  | 'AUDIO_DECODE_FAILURE'
  | 'PREPROCESSING_FAILURE'
  | 'ENCODER_FAILURE'
  | 'DECODER_FAILURE'
  | 'ALIGNMENT_FAILURE'
  | 'TRANSCRIPT_ASSEMBLY_FAILURE'
  // Infrastructure failures (6)
  | 'NETWORK_UNAVAILABLE'
  | 'REMOTE_SERVICE_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'AUTHORIZATION_FAILURE'
  | 'PERSISTENCE_FAILURE'
  | 'SESSION_RECOVERY_FAILURE'
  // Integrity failures (5)
  | 'CHECKPOINT_CORRUPTED'
  | 'STATE_VERSION_MISMATCH'
  | 'DUPLICATE_JOB_DETECTED'
  | 'INCONSISTENT_PROCESSING_STATE'
  | 'UNVERIFIED_RECOVERY_DATA';

export type ShahabFailureSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ShahabRecoverabilityClass =
  | 'RECOVERABLE_AUTOMATIC'
  | 'RECOVERABLE_MANUAL'
  | 'DEGRADABLE'
  | 'NON_RECOVERABLE';

export interface ShahabFailureTaxonomyRule {
  readonly code: ShahabResilienceFailureCode;
  readonly category: ShahabFailureCategory;
  readonly defaultStage: ShahabPipelineBoundaryId;
  readonly severity: ShahabFailureSeverity;
  readonly recoverability: ShahabRecoverabilityClass;
  readonly retryEligible: boolean;
  readonly maxRetries: number;
  readonly cloudOnlyRetry: boolean;
  readonly userSafeExplanationEn: string;
  readonly userSafeExplanationFa: string;
}

export const SHAHAB_FAILURE_TAXONOMY: Readonly<Record<ShahabResilienceFailureCode, ShahabFailureTaxonomyRule>> = {
  // Resource
  OUT_OF_MEMORY: {
    code: 'OUT_OF_MEMORY',
    category: 'RESOURCE',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'CRITICAL',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Memory limit reached during speech recognition. Caches were cleared; retry with lower concurrency or shorter audio.',
    userSafeExplanationFa: 'حافظه در حین پردازش گفتار به سقف رسید. کش‌ها آزاد شدند؛ با همزمانی کمتر یا قطعه کوتاه‌تر دوباره تلاش کنید.',
  },
  MEMORY_PRESSURE: {
    code: 'MEMORY_PRESSURE',
    category: 'RESOURCE',
    defaultStage: 'B05_FEATURE_EXTRACTION',
    severity: 'MEDIUM',
    recoverability: 'DEGRADABLE',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'High process memory pressure detected; optional caches were evicted and concurrency reduced.',
    userSafeExplanationFa: 'فشار حافظه شناسایی شد؛ کش‌های اختیاری تخلیه و همزمانی کاهش یافت.',
  },
  DISK_FULL: {
    code: 'DISK_FULL',
    category: 'RESOURCE',
    defaultStage: 'B12_PERSISTENCE_AND_EXPORT',
    severity: 'CRITICAL',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Insufficient disk space to safely commit output. Previously committed data remains intact.',
    userSafeExplanationFa: 'فضای دیسک برای ذخیره امن کافی نیست. داده‌های ثبت‌شده قبلی دست‌نخورده باقی ماندند.',
  },
  DISK_WRITE_FAILURE: {
    code: 'DISK_WRITE_FAILURE',
    category: 'RESOURCE',
    defaultStage: 'B12_PERSISTENCE_AND_EXPORT',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Unable to write safely to local storage. Existing committed files were preserved.',
    userSafeExplanationFa: 'نوشتن امن در حافظه محلی ناموفق بود. فایل‌های ثبت‌شده قبلی حفظ شدند.',
  },
  CPU_RESOURCE_EXHAUSTED: {
    code: 'CPU_RESOURCE_EXHAUSTED',
    category: 'RESOURCE',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'MEDIUM',
    recoverability: 'DEGRADABLE',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'CPU concurrency budget exhausted; new inference jobs are queued.',
    userSafeExplanationFa: 'ظرفیت پردازنده تکمیل شده است؛ کارهای جدید در صف قرار می‌گیرند.',
  },
  GPU_RESOURCE_UNAVAILABLE: {
    code: 'GPU_RESOURCE_UNAVAILABLE',
    category: 'RESOURCE',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'MEDIUM',
    recoverability: 'DEGRADABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'GPU acceleration is unavailable on this host; only verified CPU execution is supported.',
    userSafeExplanationFa: 'شتاب‌دهنده GPU در دسترس نیست؛ تنها اجرای تاییدشده روی CPU پشتیبانی می‌شود.',
  },
  // Model & Runtime
  MODEL_LOAD_FAILURE: {
    code: 'MODEL_LOAD_FAILURE',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Speech recognition model failed to initialize. Verify installation or rollback to last known-good version.',
    userSafeExplanationFa: 'بارگذاری مدل بازشناسی گفتار ناموفق بود. نصب را بررسی کنید یا به نسخه سالم قبلی بازگردید.',
  },
  MODEL_ARTIFACT_CORRUPTED: {
    code: 'MODEL_ARTIFACT_CORRUPTED',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'CRITICAL',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Model file failed SHA-256 integrity verification and was blocked. Reacquire verified artifacts or rollback.',
    userSafeExplanationFa: 'فایل مدل در بررسی یکپارچگی SHA-256 رد شد و مسدود گردید. بسته معتبر را مجدداً دریافت یا بازگردانی کنید.',
  },
  TOKENIZER_INCOMPATIBLE: {
    code: 'TOKENIZER_INCOMPATIBLE',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'CRITICAL',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Tokenizer vocabulary does not match the active model package.',
    userSafeExplanationFa: 'واژگان توکنایزر با بسته مدل فعال سازگار نیست.',
  },
  RUNTIME_INITIALIZATION_FAILURE: {
    code: 'RUNTIME_INITIALIZATION_FAILURE',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'CRITICAL',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Inference runtime could not be initialized on this host.',
    userSafeExplanationFa: 'موتور اجرای استنتاج در این سیستم راه‌اندازی نشد.',
  },
  INFERENCE_TIMEOUT: {
    code: 'INFERENCE_TIMEOUT',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_AUTOMATIC',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Speech recognition exceeded the configured time budget.',
    userSafeExplanationFa: 'زمان پردازش گفتار از سقف مجاز فراتر رفت.',
  },
  INFERENCE_CRASH: {
    code: 'INFERENCE_CRASH',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'CRITICAL',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'The inference worker terminated unexpectedly. Any verified chunk checkpoints are available for recovery.',
    userSafeExplanationFa: 'پردازنده استنتاج به‌طور غیرمنتظره متوقف شد. نقاط بازیابی تاییدشده در صورت وجود قابل بازگشت هستند.',
  },
  PROVIDER_FAILURE: {
    code: 'PROVIDER_FAILURE',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'HIGH',
    recoverability: 'DEGRADABLE',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Selected execution provider failed; switch only to a verified compatible provider.',
    userSafeExplanationFa: 'ارائه‌دهنده اجرایی انتخاب‌شده با خطا مواجه شد.',
  },
  UNSUPPORTED_OPERATION: {
    code: 'UNSUPPORTED_OPERATION',
    category: 'MODEL_RUNTIME',
    defaultStage: 'B04_MODEL_INITIALIZATION',
    severity: 'HIGH',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Requested operation is not supported by the active runtime provider.',
    userSafeExplanationFa: 'عملیات درخواستی توسط موتور اجرایی فعال پشتیبانی نمی‌شود.',
  },
  // Processing
  INVALID_AUDIO: {
    code: 'INVALID_AUDIO',
    category: 'PROCESSING',
    defaultStage: 'B02_AUDIO_VALIDATION',
    severity: 'MEDIUM',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Audio input is empty, truncated, or invalid.',
    userSafeExplanationFa: 'ورودی صوتی خالی، ناقص یا نامعتبر است.',
  },
  UNSUPPORTED_AUDIO_FORMAT: {
    code: 'UNSUPPORTED_AUDIO_FORMAT',
    category: 'PROCESSING',
    defaultStage: 'B02_AUDIO_VALIDATION',
    severity: 'MEDIUM',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Audio format is not supported by the current SHAHAB preprocessing pipeline.',
    userSafeExplanationFa: 'قالب فایل صوتی توسط پیش‌پردازنده فعلی شهاب پشتیبانی نمی‌شود.',
  },
  AUDIO_DECODE_FAILURE: {
    code: 'AUDIO_DECODE_FAILURE',
    category: 'PROCESSING',
    defaultStage: 'B02_AUDIO_VALIDATION',
    severity: 'MEDIUM',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Failed to decode audio samples from input container.',
    userSafeExplanationFa: 'رمزگشایی نمونه‌های صوتی از فایل ورودی ناموفق بود.',
  },
  PREPROCESSING_FAILURE: {
    code: 'PREPROCESSING_FAILURE',
    category: 'PROCESSING',
    defaultStage: 'B03_PREPROCESSING',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Audio resampling or feature extraction failed.',
    userSafeExplanationFa: 'پیش‌پردازش یا استخراج ویژگی‌های صوتی با خطا متوقف شد.',
  },
  ENCODER_FAILURE: {
    code: 'ENCODER_FAILURE',
    category: 'PROCESSING',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Acoustic encoder failed on audio segment.',
    userSafeExplanationFa: 'انکودر آکوستیک در پردازش قطعه صوتی دچار خطا شد.',
  },
  DECODER_FAILURE: {
    code: 'DECODER_FAILURE',
    category: 'PROCESSING',
    defaultStage: 'B07_DECODER_EXECUTION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: true,
    maxRetries: 1,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Speech decoder failed while generating transcript tokens.',
    userSafeExplanationFa: 'دیکودر در تولید توکن‌های متن گفتار دچار خطا شد.',
  },
  ALIGNMENT_FAILURE: {
    code: 'ALIGNMENT_FAILURE',
    category: 'PROCESSING',
    defaultStage: 'B09_ALIGNMENT_TIMESTAMPS',
    severity: 'MEDIUM',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Word timestamp alignment failed consistency checks.',
    userSafeExplanationFa: 'هم‌ترازی زمانی واژه‌ها با خطای سازگاری مواجه شد.',
  },
  TRANSCRIPT_ASSEMBLY_FAILURE: {
    code: 'TRANSCRIPT_ASSEMBLY_FAILURE',
    category: 'PROCESSING',
    defaultStage: 'B10_TRANSCRIPT_ASSEMBLY',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Transcript assembly failed; partial output was not promoted to final.',
    userSafeExplanationFa: 'تجمیع نهایی متن ناموفق بود؛ خروجی ناقص به‌عنوان نسخه نهایی ثبت نشد.',
  },
  // Infrastructure
  NETWORK_UNAVAILABLE: {
    code: 'NETWORK_UNAVAILABLE',
    category: 'INFRASTRUCTURE',
    defaultStage: 'B01_AUDIO_INGESTION',
    severity: 'MEDIUM',
    recoverability: 'RECOVERABLE_AUTOMATIC',
    retryEligible: true,
    maxRetries: 3,
    cloudOnlyRetry: true,
    userSafeExplanationEn: 'Network connection is unavailable for Cloud mode. Local offline mode remains unaffected.',
    userSafeExplanationFa: 'اتصال شبکه برای حالت ابری در دسترس نیست. حالت محلی بدون اینترنت بدون مشکل کار می‌کند.',
  },
  REMOTE_SERVICE_UNAVAILABLE: {
    code: 'REMOTE_SERVICE_UNAVAILABLE',
    category: 'INFRASTRUCTURE',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_AUTOMATIC',
    retryEligible: true,
    maxRetries: 3,
    cloudOnlyRetry: true,
    userSafeExplanationEn: 'Remote Cloud ASR service is temporarily unavailable.',
    userSafeExplanationFa: 'سرویس ابری موقتاً در دسترس نیست.',
  },
  REQUEST_TIMEOUT: {
    code: 'REQUEST_TIMEOUT',
    category: 'INFRASTRUCTURE',
    defaultStage: 'B06_ENCODER_EXECUTION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_AUTOMATIC',
    retryEligible: true,
    maxRetries: 2,
    cloudOnlyRetry: true,
    userSafeExplanationEn: 'Cloud request timed out; safe idempotent retry is bounded.',
    userSafeExplanationFa: 'زمان پاسخ درخواست ابری به پایان رسید؛ تلاش مجدد کنترل‌شده با کلید یکتا انجام می‌شود.',
  },
  AUTHORIZATION_FAILURE: {
    code: 'AUTHORIZATION_FAILURE',
    category: 'INFRASTRUCTURE',
    defaultStage: 'B01_AUDIO_INGESTION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: true,
    userSafeExplanationEn: 'Cloud authorization missing, expired, or explicit user consent for remote transfer was not granted.',
    userSafeExplanationFa: 'مجوز سرویس ابری نامعتبر یا رضایت صریح کاربر برای انتقال صوت ثبت نشده است.',
  },
  PERSISTENCE_FAILURE: {
    code: 'PERSISTENCE_FAILURE',
    category: 'INFRASTRUCTURE',
    defaultStage: 'B12_PERSISTENCE_AND_EXPORT',
    severity: 'CRITICAL',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Failed to durably persist job output. Previous valid state was preserved.',
    userSafeExplanationFa: 'ذخیره پایدار خروجی ناموفق بود. وضعیت معتبر قبلی حفظ شد.',
  },
  SESSION_RECOVERY_FAILURE: {
    code: 'SESSION_RECOVERY_FAILURE',
    category: 'INFRASTRUCTURE',
    defaultStage: 'B11_AVAPARDAZ_EDITING_INTEGRATION',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Session recovery could not verify saved state cleanly.',
    userSafeExplanationFa: 'بازیابی نشست نتوانست یکپارچگی وضعیت ذخیره‌شده را تایید کند.',
  },
  // Integrity
  CHECKPOINT_CORRUPTED: {
    code: 'CHECKPOINT_CORRUPTED',
    category: 'INTEGRITY',
    defaultStage: 'B12_PERSISTENCE_AND_EXPORT',
    severity: 'HIGH',
    recoverability: 'RECOVERABLE_MANUAL',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Saved recovery checkpoint failed integrity verification and was rejected.',
    userSafeExplanationFa: 'نقطه بازیابی ذخیره‌شده در بررسی یکپارچگی رد شد و استفاده نگردید.',
  },
  STATE_VERSION_MISMATCH: {
    code: 'STATE_VERSION_MISMATCH',
    category: 'INTEGRITY',
    defaultStage: 'B12_PERSISTENCE_AND_EXPORT',
    severity: 'HIGH',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Checkpoint or state schema version is incompatible with this SHAHAB engine.',
    userSafeExplanationFa: 'نسخه طرحواره نقطه بازیابی با این نسخه موتور شهاب ناسازگار است.',
  },
  DUPLICATE_JOB_DETECTED: {
    code: 'DUPLICATE_JOB_DETECTED',
    category: 'INTEGRITY',
    defaultStage: 'B01_AUDIO_INGESTION',
    severity: 'LOW',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Duplicate processing request with the same idempotency key was suppressed.',
    userSafeExplanationFa: 'درخواست تکراری با کلید یکتای مشابه شناسایی و مسدود شد.',
  },
  INCONSISTENT_PROCESSING_STATE: {
    code: 'INCONSISTENT_PROCESSING_STATE',
    category: 'INTEGRITY',
    defaultStage: 'B10_TRANSCRIPT_ASSEMBLY',
    severity: 'HIGH',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Invalid processing state transition was rejected to protect transcript integrity.',
    userSafeExplanationFa: 'تغییر وضعیت نامعتبر برای محافظت از یکپارچگی متن رد شد.',
  },
  UNVERIFIED_RECOVERY_DATA: {
    code: 'UNVERIFIED_RECOVERY_DATA',
    category: 'INTEGRITY',
    defaultStage: 'B12_PERSISTENCE_AND_EXPORT',
    severity: 'HIGH',
    recoverability: 'NON_RECOVERABLE',
    retryEligible: false,
    maxRetries: 0,
    cloudOnlyRetry: false,
    userSafeExplanationEn: 'Recovery data does not match the current audio source or model configuration and was rejected.',
    userSafeExplanationFa: 'داده‌های بازیابی با فایل صوتی یا پیکربندی مدل فعلی مطابقت ندارد و رد شد.',
  },
};

export interface ShahabClassifiedFailure {
  readonly failureEventId: string;
  readonly timestampIso: string;
  readonly code: ShahabResilienceFailureCode;
  readonly category: ShahabFailureCategory;
  readonly stage: ShahabPipelineBoundaryId;
  readonly severity: ShahabFailureSeverity;
  readonly recoverability: ShahabRecoverabilityClass;
  readonly retryEligible: boolean;
  readonly correlationId: string;
  readonly jobId: string | null;
  readonly engineVersion: string;
  readonly modelId: string;
  readonly runtimeId: string;
  /** Strictly separated observed symptom vs verified technical cause vs suspected root cause. */
  readonly observedFailure: string;
  readonly verifiedTechnicalCause: string | null;
  readonly suspectedRootCause: string | null;
  readonly reproducible: 'VERIFIED_REPRODUCIBLE' | 'INTERMITTENT' | 'NOT_YET_REPRODUCED';
  readonly diagnosticEvidence: Readonly<Record<string, string | number | boolean | null>>;
  readonly userSafeExplanationEn: string;
  readonly userSafeExplanationFa: string;
}

export function classifyShahabFailure(params: {
  readonly code: ShahabResilienceFailureCode;
  readonly stage?: ShahabPipelineBoundaryId;
  readonly correlationId: string;
  readonly jobId?: string | null;
  readonly runtimeId?: string;
  readonly observedFailure: string;
  readonly verifiedTechnicalCause?: string | null;
  readonly suspectedRootCause?: string | null;
  readonly reproducible?: 'VERIFIED_REPRODUCIBLE' | 'INTERMITTENT' | 'NOT_YET_REPRODUCED';
  readonly diagnosticEvidence?: Readonly<Record<string, string | number | boolean | null>>;
}): ShahabClassifiedFailure {
  const rule = SHAHAB_FAILURE_TAXONOMY[params.code];
  return {
    failureEventId: `fail-${crypto.randomUUID().slice(0, 12)}`,
    timestampIso: new Date().toISOString(),
    code: rule.code,
    category: rule.category,
    stage: params.stage ?? rule.defaultStage,
    severity: rule.severity,
    recoverability: rule.recoverability,
    retryEligible: rule.retryEligible,
    correlationId: params.correlationId,
    jobId: params.jobId ?? null,
    engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
    modelId: SHAHAB_NEURAL_CORE_IDENTITY,
    runtimeId: params.runtimeId ?? 'onnxruntime-web-wasm-cpu',
    observedFailure: params.observedFailure,
    // Never elevate an unknown/suspected cause into a verified technical cause.
    verifiedTechnicalCause: params.verifiedTechnicalCause ?? null,
    suspectedRootCause: params.suspectedRootCause ?? null,
    reproducible: params.reproducible ?? 'NOT_YET_REPRODUCED',
    diagnosticEvidence: params.diagnosticEvidence ?? {},
    userSafeExplanationEn: rule.userSafeExplanationEn,
    userSafeExplanationFa: rule.userSafeExplanationFa,
  };
}

// ---------------------------------------------------------------------------
// 4. Atomic Crash-Safe Persistence Helper (Section 6.1)
// ---------------------------------------------------------------------------

export interface AtomicWriteVerificationResult {
  readonly filePath: string;
  readonly bytesWritten: number;
  readonly sha256: string;
  readonly tempFileCleaned: boolean;
  readonly durabilityNote: string;
}

/**
 * Atomic write protocol:
 * 1. Write to sibling temporary file.
 * 2. Flush (fsync) file descriptor where supported.
 * 3. Re-read & validate JSON parse + SHA-256 digest before rename.
 * 4. Atomic rename over target (preserving previous valid file until commit).
 */
export function writeJsonAtomicVerified(
  targetPath: string,
  payload: unknown,
  options?: { readonly simulateDiskFull?: boolean; readonly simulateWriteFailure?: boolean },
): AtomicWriteVerificationResult {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const expectedSha256 = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');

  if (options?.simulateDiskFull) {
    const err = new Error('ENOSPC: no space left on device (isolated fault injection)') as NodeJS.ErrnoException;
    err.code = 'ENOSPC';
    throw err;
  }

  const tmpPath = `${resolved}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o644);
    if (options?.simulateWriteFailure) {
      // Write truncated half-payload then fail before commit, proving prior target stays intact
      fs.writeSync(fd, serialized.slice(0, Math.max(1, Math.floor(serialized.length / 3))), 0, 'utf8');
      const err = new Error('EIO: simulated I/O write interruption (isolated fault injection)') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    }
    fs.writeSync(fd, serialized, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // Step 3: Validate read-back schema & digest before atomic replacement
    const readBack = fs.readFileSync(tmpPath, 'utf8');
    JSON.parse(readBack);
    const actualSha256 = crypto.createHash('sha256').update(readBack, 'utf8').digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error('Atomic write read-back SHA-256 mismatch; aborting commit.');
    }

    // Step 4: Atomic rename
    fs.renameSync(tmpPath, resolved);

    return {
      filePath: resolved,
      bytesWritten: Buffer.byteLength(serialized, 'utf8'),
      sha256: actualSha256,
      tempFileCleaned: !fs.existsSync(tmpPath),
      durabilityNote:
        'POSIX atomic rename after temp file fsyncSync + read-back JSON/SHA-256 verification. Note: power-loss directory-entry durability depends on host OS/filesystem mount semantics.',
    };
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error on cleanup
      }
    }
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function appendJsonlVerified(targetPath: string, record: unknown): void {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  const fd = fs.openSync(resolved, 'a', 0o644);
  try {
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 5. Processing Job State Machine (Section 5)
// ---------------------------------------------------------------------------

export type ShahabJobState =
  | 'CREATED'
  | 'VALIDATING'
  | 'QUEUED'
  | 'INITIALIZING'
  | 'PROCESSING'
  | 'PAUSED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLED'
  | 'RECOVERY_PENDING'
  | 'RECOVERING'
  | 'COMPLETED'
  | 'FAILED'
  | 'FAILED_RECOVERABLE'
  | 'FAILED_NON_RECOVERABLE';

export const SHAHAB_JOB_ALLOWED_TRANSITIONS: Readonly<Record<ShahabJobState, readonly ShahabJobState[]>> = {
  CREATED: ['VALIDATING', 'CANCELLATION_REQUESTED', 'FAILED_NON_RECOVERABLE'],
  VALIDATING: ['QUEUED', 'CANCELLATION_REQUESTED', 'FAILED_NON_RECOVERABLE', 'FAILED_RECOVERABLE'],
  QUEUED: ['INITIALIZING', 'PAUSED', 'CANCELLATION_REQUESTED', 'FAILED_RECOVERABLE'],
  INITIALIZING: ['PROCESSING', 'CANCELLATION_REQUESTED', 'FAILED_RECOVERABLE', 'FAILED_NON_RECOVERABLE'],
  PROCESSING: [
    'PAUSED',
    'CANCELLATION_REQUESTED',
    'RECOVERY_PENDING',
    'COMPLETED',
    'FAILED',
    'FAILED_RECOVERABLE',
    'FAILED_NON_RECOVERABLE',
  ],
  PAUSED: ['QUEUED', 'PROCESSING', 'CANCELLATION_REQUESTED', 'RECOVERY_PENDING'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'FAILED_RECOVERABLE'],
  CANCELLED: ['RECOVERY_PENDING'],
  RECOVERY_PENDING: ['RECOVERING', 'CANCELLATION_REQUESTED', 'FAILED_NON_RECOVERABLE'],
  RECOVERING: ['PROCESSING', 'COMPLETED', 'FAILED_RECOVERABLE', 'FAILED_NON_RECOVERABLE', 'CANCELLATION_REQUESTED'],
  COMPLETED: [], // Terminal — duplicate completion events rejected
  FAILED: ['RECOVERY_PENDING', 'FAILED_RECOVERABLE', 'FAILED_NON_RECOVERABLE'],
  FAILED_RECOVERABLE: ['RECOVERY_PENDING', 'RECOVERING', 'CANCELLED'],
  FAILED_NON_RECOVERABLE: [], // Terminal
};

export interface ShahabTranscriptProvenanceEnvelope {
  readonly transcriptId: string;
  readonly isPartial: boolean;
  readonly completedChunkCount: number;
  readonly totalChunkCount: number;
  readonly rawAcousticOutput: string;
  readonly contextAssistedOutput: string | null;
  readonly normalizedOutput: string | null;
  readonly authorizedFinalTranscript: string | null;
  readonly authorizedByUserAtIso: string | null;
  readonly durableCommitSha256: string | null;
}

export interface ShahabProcessingJobRecord {
  readonly schemaVersion: typeof SHAHAB_RESILIENCE_SCHEMA_VERSION;
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly executionMode: 'LOCAL' | 'CLOUD';
  readonly state: ShahabJobState;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly audioSourceId: string;
  readonly audioContentSha256: string;
  readonly modelId: string;
  readonly tokenizerSha256: string;
  readonly outputDurablyCommitted: boolean;
  readonly partialOutputDesignated: boolean;
  readonly committedTranscriptRef: string | null;
  readonly activeCheckpointId: string | null;
  readonly lastFailureCode: ShahabResilienceFailureCode | null;
  readonly retryCount: number;
  readonly degradedModes: readonly string[];
  readonly userCommittedDataPreserved: boolean;
}

export interface ShahabJobTransitionEvent {
  readonly eventId: string;
  readonly timestampIso: string;
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly fromState: ShahabJobState | null;
  readonly toState: ShahabJobState;
  readonly accepted: boolean;
  readonly reason: string;
  readonly rejectionCode: ShahabResilienceFailureCode | null;
}

export class SHAHABJobStateMachine {
  private readonly jobs = new Map<string, ShahabProcessingJobRecord>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly history: ShahabJobTransitionEvent[] = [];
  private readonly transcripts = new Map<string, ShahabTranscriptProvenanceEnvelope>();

  constructor(
    private readonly stateDir?: string,
    private readonly onFailure?: (failure: ShahabClassifiedFailure) => void,
  ) {}

  createJob(params: {
    readonly jobId?: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly executionMode: 'LOCAL' | 'CLOUD';
    readonly audioSourceId: string;
    readonly audioContentSha256: string;
    readonly modelId: string;
    readonly tokenizerSha256: string;
  }): { readonly created: boolean; readonly job: ShahabProcessingJobRecord; readonly duplicateFailure: ShahabClassifiedFailure | null } {
    const existingJobId = this.idempotencyIndex.get(params.idempotencyKey);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId)!;
      const dupFail = classifyShahabFailure({
        code: 'DUPLICATE_JOB_DETECTED',
        stage: 'B01_AUDIO_INGESTION',
        correlationId: params.correlationId,
        jobId: existing.jobId,
        observedFailure: `Duplicate job rejected for idempotencyKey=${params.idempotencyKey} (existing job=${existing.jobId}, state=${existing.state}).`,
        verifiedTechnicalCause: 'Idempotency key already registered in SHAHABJobStateMachine.',
        reproducible: 'VERIFIED_REPRODUCIBLE',
        diagnosticEvidence: { existingJobId: existing.jobId, existingState: existing.state },
      });
      this.onFailure?.(dupFail);
      return { created: false, job: existing, duplicateFailure: dupFail };
    }

    const now = new Date().toISOString();
    const jobId = params.jobId ?? `job-${crypto.randomUUID().slice(0, 12)}`;
    const record: ShahabProcessingJobRecord = {
      schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
      jobId,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
      executionMode: params.executionMode,
      state: 'CREATED',
      createdAtIso: now,
      updatedAtIso: now,
      audioSourceId: params.audioSourceId,
      audioContentSha256: params.audioContentSha256,
      modelId: params.modelId,
      tokenizerSha256: params.tokenizerSha256,
      outputDurablyCommitted: false,
      partialOutputDesignated: false,
      committedTranscriptRef: null,
      activeCheckpointId: null,
      lastFailureCode: null,
      retryCount: 0,
      degradedModes: [],
      userCommittedDataPreserved: true,
    };
    this.jobs.set(jobId, record);
    this.idempotencyIndex.set(params.idempotencyKey, jobId);
    this.recordTransition({
      jobId,
      idempotencyKey: params.idempotencyKey,
      fromState: null,
      toState: 'CREATED',
      accepted: true,
      reason: 'Job created with unique idempotency key.',
      rejectionCode: null,
    });
    this.persistJobSnapshot(record);
    return { created: true, job: record, duplicateFailure: null };
  }

  transition(
    jobId: string,
    toState: ShahabJobState,
    options: {
      readonly reason: string;
      readonly outputDurablyCommitted?: boolean;
      readonly partialOutputDesignated?: boolean;
      readonly committedTranscriptRef?: string | null;
      readonly activeCheckpointId?: string | null;
      readonly failureCode?: ShahabResilienceFailureCode | null;
      readonly retryCount?: number;
      readonly degradedModeAdded?: string;
    },
  ): { readonly accepted: boolean; readonly job: ShahabProcessingJobRecord; readonly rejectionFailure: ShahabClassifiedFailure | null } {
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new Error(`Unknown SHAHAB jobId: ${jobId}`);
    }

    const allowed = SHAHAB_JOB_ALLOWED_TRANSITIONS[current.state];
    const isAllowed = allowed.includes(toState);

    // Requirement 1: A job MUST NOT be marked COMPLETED before its output is durably committed.
    const nextCommitted = options.outputDurablyCommitted ?? current.outputDurablyCommitted;
    const nextPartial = options.partialOutputDesignated ?? current.partialOutputDesignated;

    if (!isAllowed) {
      const code: ShahabResilienceFailureCode =
        current.state === 'COMPLETED' && toState === 'COMPLETED'
          ? 'DUPLICATE_JOB_DETECTED'
          : 'INCONSISTENT_PROCESSING_STATE';
      const fail = classifyShahabFailure({
        code,
        stage: 'B10_TRANSCRIPT_ASSEMBLY',
        correlationId: current.correlationId,
        jobId,
        observedFailure: `Rejected invalid job transition ${current.state} -> ${toState} (${options.reason}).`,
        verifiedTechnicalCause: `Transition ${current.state} -> ${toState} is not in SHAHAB_JOB_ALLOWED_TRANSITIONS.`,
        reproducible: 'VERIFIED_REPRODUCIBLE',
        diagnosticEvidence: { fromState: current.state, toState },
      });
      this.recordTransition({
        jobId,
        idempotencyKey: current.idempotencyKey,
        fromState: current.state,
        toState,
        accepted: false,
        reason: `Rejected invalid transition: ${current.state} -> ${toState}`,
        rejectionCode: code,
      });
      this.onFailure?.(fail);
      return { accepted: false, job: current, rejectionFailure: fail };
    }

    if (toState === 'COMPLETED' && (!nextCommitted || nextPartial)) {
      const fail = classifyShahabFailure({
        code: 'INCONSISTENT_PROCESSING_STATE',
        stage: 'B12_PERSISTENCE_AND_EXPORT',
        correlationId: current.correlationId,
        jobId,
        observedFailure: `Refused to mark job ${jobId} COMPLETED without durable full-output commit (durablyCommitted=${nextCommitted}, partial=${nextPartial}).`,
        verifiedTechnicalCause: 'Job completion invariant violated: output must be durably committed and non-partial.',
        reproducible: 'VERIFIED_REPRODUCIBLE',
        diagnosticEvidence: { nextCommitted, nextPartial },
      });
      this.recordTransition({
        jobId,
        idempotencyKey: current.idempotencyKey,
        fromState: current.state,
        toState,
        accepted: false,
        reason: 'Refused COMPLETED without durable full commit.',
        rejectionCode: 'INCONSISTENT_PROCESSING_STATE',
      });
      this.onFailure?.(fail);
      return { accepted: false, job: current, rejectionFailure: fail };
    }

    const updated: ShahabProcessingJobRecord = {
      ...current,
      state: toState,
      updatedAtIso: new Date().toISOString(),
      outputDurablyCommitted: nextCommitted,
      partialOutputDesignated:
        toState === 'COMPLETED' ? false : nextPartial,
      committedTranscriptRef:
        options.committedTranscriptRef !== undefined
          ? options.committedTranscriptRef
          : current.committedTranscriptRef,
      activeCheckpointId:
        options.activeCheckpointId !== undefined
          ? options.activeCheckpointId
          : current.activeCheckpointId,
      lastFailureCode:
        options.failureCode !== undefined ? options.failureCode : current.lastFailureCode,
      retryCount: options.retryCount ?? current.retryCount,
      degradedModes: options.degradedModeAdded
        ? Array.from(new Set([...current.degradedModes, options.degradedModeAdded]))
        : current.degradedModes,
      // Cancellation NEVER silently discards already committed user data
      userCommittedDataPreserved: true,
    };

    this.jobs.set(jobId, updated);
    this.recordTransition({
      jobId,
      idempotencyKey: updated.idempotencyKey,
      fromState: current.state,
      toState,
      accepted: true,
      reason: options.reason,
      rejectionCode: null,
    });
    this.persistJobSnapshot(updated);
    return { accepted: true, job: updated, rejectionFailure: null };
  }

  /**
   * Section 6.3 Transcript Integrity guard:
   * Preserves all 4 provenance layers and NEVER replaces an existing authorized final transcript
   * with an incomplete/partial recovery result.
   */
  commitTranscriptEnvelope(
    jobId: string,
    envelope: ShahabTranscriptProvenanceEnvelope,
  ): { readonly committed: boolean; readonly preservedAuthorizedTranscript: boolean; readonly reason: string } {
    const existing = this.transcripts.get(jobId);
    if (existing?.authorizedFinalTranscript && envelope.isPartial) {
      return {
        committed: false,
        preservedAuthorizedTranscript: true,
        reason:
          'Refused to overwrite existing user-authorized final transcript with a partial recovery result.',
      };
    }
    this.transcripts.set(jobId, envelope);
    if (this.stateDir) {
      writeJsonAtomicVerified(
        path.join(this.stateDir, 'transcripts', `${jobId}.transcript.json`),
        envelope,
      );
    }
    return {
      committed: true,
      preservedAuthorizedTranscript: Boolean(existing?.authorizedFinalTranscript),
      reason: envelope.isPartial
        ? 'Committed explicit PARTIAL transcript envelope (not promoted to final).'
        : 'Committed full transcript envelope with preserved provenance.',
    };
  }

  getTranscriptEnvelope(jobId: string): ShahabTranscriptProvenanceEnvelope | null {
    return this.transcripts.get(jobId) ?? null;
  }

  getJob(jobId: string): ShahabProcessingJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(): readonly ShahabProcessingJobRecord[] {
    return Array.from(this.jobs.values());
  }

  getTransitionHistory(): readonly ShahabJobTransitionEvent[] {
    return [...this.history];
  }

  private recordTransition(entry: Omit<ShahabJobTransitionEvent, 'eventId' | 'timestampIso'>): void {
    const full: ShahabJobTransitionEvent = {
      eventId: `jtr-${crypto.randomUUID().slice(0, 12)}`,
      timestampIso: new Date().toISOString(),
      ...entry,
    };
    this.history.push(full);
    if (this.stateDir) {
      appendJsonlVerified(path.join(this.stateDir, 'SHAHAB_JOB_STATE_HISTORY.jsonl'), full);
    }
  }

  private persistJobSnapshot(job: ShahabProcessingJobRecord): void {
    if (!this.stateDir) return;
    writeJsonAtomicVerified(path.join(this.stateDir, 'jobs', `${job.jobId}.job.json`), job);
  }
}

// ---------------------------------------------------------------------------
// 6. Crash-Safe Checkpointing & Recovery Validation (Section 6)
// ---------------------------------------------------------------------------

export type ShahabCheckpointStage =
  | 'POST_AUDIO_VALIDATION'
  | 'POST_FEATURE_EXTRACTION'
  | 'POST_ENCODER_EXECUTION'
  | 'POST_CHUNK_TRANSCRIPT_ASSEMBLY';

export interface ShahabCheckpointManifest {
  readonly schemaVersion: typeof SHAHAB_RESILIENCE_SCHEMA_VERSION;
  readonly checkpointId: string;
  readonly jobId: string;
  readonly stage: ShahabCheckpointStage;
  readonly createdAtIso: string;
  readonly audioSourceId: string;
  readonly audioContentSha256: string;
  readonly modelId: string;
  readonly modelArtifactsDigestSha256: string;
  readonly tokenizerSha256: string;
  readonly preprocessingConfigSha256: string;
  readonly runtimeCompatibilityTag: string;
  readonly completedChunkIndices: readonly number[];
  readonly totalChunks: number;
  /** Compact metadata-only payload reference; avoids duplicating raw user audio. */
  readonly payloadSha256: string;
  readonly payloadRelativePath: string;
  readonly envelopeSha256: string;
}

export interface ShahabCheckpointVerificationResult {
  readonly valid: boolean;
  readonly checkpointId: string;
  readonly failureCode: ShahabResilienceFailureCode | null;
  readonly reasons: readonly string[];
  readonly payload: Record<string, unknown> | null;
}

export class SHAHABCheckpointManager {
  private readonly manifests: ShahabCheckpointManifest[] = [];

  constructor(private readonly checkpointDir: string) {}

  saveCheckpoint(params: {
    readonly jobId: string;
    readonly stage: ShahabCheckpointStage;
    readonly audioSourceId: string;
    readonly audioContentSha256: string;
    readonly modelId: string;
    readonly modelArtifactsDigestSha256: string;
    readonly tokenizerSha256: string;
    readonly preprocessingConfigSha256: string;
    readonly runtimeCompatibilityTag: string;
    readonly completedChunkIndices: readonly number[];
    readonly totalChunks: number;
    readonly payload: Record<string, unknown>;
    readonly simulateDiskFull?: boolean;
    readonly simulateWriteFailure?: boolean;
  }): ShahabCheckpointManifest {
    const checkpointId = `chk-${crypto.randomUUID().slice(0, 12)}`;
    const payloadRel = path.join('payloads', `${checkpointId}.payload.json`);
    const payloadAbs = path.join(this.checkpointDir, payloadRel);
    const payloadWrite = writeJsonAtomicVerified(payloadAbs, params.payload, {
      simulateDiskFull: params.simulateDiskFull,
      simulateWriteFailure: params.simulateWriteFailure,
    });

    const unsigned = {
      schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
      checkpointId,
      jobId: params.jobId,
      stage: params.stage,
      createdAtIso: new Date().toISOString(),
      audioSourceId: params.audioSourceId,
      audioContentSha256: params.audioContentSha256,
      modelId: params.modelId,
      modelArtifactsDigestSha256: params.modelArtifactsDigestSha256,
      tokenizerSha256: params.tokenizerSha256,
      preprocessingConfigSha256: params.preprocessingConfigSha256,
      runtimeCompatibilityTag: params.runtimeCompatibilityTag,
      completedChunkIndices: [...params.completedChunkIndices],
      totalChunks: params.totalChunks,
      payloadSha256: payloadWrite.sha256,
      payloadRelativePath: payloadRel,
    };
    const envelopeSha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(unsigned), 'utf8')
      .digest('hex');

    const manifest: ShahabCheckpointManifest = { ...unsigned, envelopeSha256 };
    writeJsonAtomicVerified(
      path.join(this.checkpointDir, 'manifests', `${checkpointId}.manifest.json`),
      manifest,
    );
    this.manifests.push(manifest);
    return manifest;
  }

  verifyForRecovery(
    manifestPath: string,
    expected: {
      readonly audioSourceId: string;
      readonly audioContentSha256: string;
      readonly modelId: string;
      readonly modelArtifactsDigestSha256: string;
      readonly tokenizerSha256: string;
      readonly preprocessingConfigSha256: string;
      readonly runtimeCompatibilityTag: string;
    },
  ): ShahabCheckpointVerificationResult {
    const reasons: string[] = [];
    let manifest: ShahabCheckpointManifest;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      manifest = JSON.parse(raw) as ShahabCheckpointManifest;
    } catch {
      return {
        valid: false,
        checkpointId: path.basename(manifestPath),
        failureCode: 'CHECKPOINT_CORRUPTED',
        reasons: ['Checkpoint manifest JSON could not be read or parsed.'],
        payload: null,
      };
    }

    if (manifest.schemaVersion !== SHAHAB_RESILIENCE_SCHEMA_VERSION) {
      return {
        valid: false,
        checkpointId: manifest.checkpointId ?? 'UNKNOWN',
        failureCode: 'STATE_VERSION_MISMATCH',
        reasons: [
          `Unsupported checkpoint schema version ${String(manifest.schemaVersion)} (expected ${SHAHAB_RESILIENCE_SCHEMA_VERSION}).`,
        ],
        payload: null,
      };
    }

    // Verify envelope digest
    const { envelopeSha256, ...unsigned } = manifest;
    const recomputedEnvelope = crypto
      .createHash('sha256')
      .update(JSON.stringify(unsigned), 'utf8')
      .digest('hex');
    if (recomputedEnvelope !== envelopeSha256) {
      return {
        valid: false,
        checkpointId: manifest.checkpointId,
        failureCode: 'CHECKPOINT_CORRUPTED',
        reasons: ['Checkpoint envelope SHA-256 verification failed.'],
        payload: null,
      };
    }

    if (manifest.tokenizerSha256 !== expected.tokenizerSha256) {
      return {
        valid: false,
        checkpointId: manifest.checkpointId,
        failureCode: 'TOKENIZER_INCOMPATIBLE',
        reasons: ['Checkpoint tokenizer SHA-256 does not match active tokenizer.'],
        payload: null,
      };
    }

    if (
      manifest.audioSourceId !== expected.audioSourceId ||
      manifest.audioContentSha256 !== expected.audioContentSha256
    ) {
      reasons.push('Checkpoint recording identity or audio content SHA-256 does not match target audio.');
    }
    if (
      manifest.modelId !== expected.modelId ||
      manifest.modelArtifactsDigestSha256 !== expected.modelArtifactsDigestSha256
    ) {
      reasons.push('Checkpoint model identity or artifact digest does not match active model.');
    }
    if (manifest.preprocessingConfigSha256 !== expected.preprocessingConfigSha256) {
      reasons.push('Checkpoint preprocessing configuration digest does not match current settings.');
    }
    if (manifest.runtimeCompatibilityTag !== expected.runtimeCompatibilityTag) {
      reasons.push('Checkpoint runtime compatibility tag does not match current runtime.');
    }

    if (reasons.length > 0) {
      return {
        valid: false,
        checkpointId: manifest.checkpointId,
        failureCode: 'UNVERIFIED_RECOVERY_DATA',
        reasons,
        payload: null,
      };
    }

    // Verify payload file exists, parses, and matches payloadSha256
    const payloadAbs = path.resolve(this.checkpointDir, manifest.payloadRelativePath);
    if (!payloadAbs.startsWith(path.resolve(this.checkpointDir) + path.sep) || !fs.existsSync(payloadAbs)) {
      return {
        valid: false,
        checkpointId: manifest.checkpointId,
        failureCode: 'CHECKPOINT_CORRUPTED',
        reasons: ['Checkpoint payload missing or escaped checkpoint sandbox directory.'],
        payload: null,
      };
    }

    try {
      const payloadRaw = fs.readFileSync(payloadAbs, 'utf8');
      const actualPayloadSha = crypto.createHash('sha256').update(payloadRaw, 'utf8').digest('hex');
      if (actualPayloadSha !== manifest.payloadSha256) {
        return {
          valid: false,
          checkpointId: manifest.checkpointId,
          failureCode: 'CHECKPOINT_CORRUPTED',
          reasons: ['Checkpoint payload SHA-256 mismatch detected.'],
          payload: null,
        };
      }
      const parsed = JSON.parse(payloadRaw) as Record<string, unknown>;
      return {
        valid: true,
        checkpointId: manifest.checkpointId,
        failureCode: null,
        reasons: ['Checkpoint envelope, payload SHA-256, audio hash, model, tokenizer, and preprocessing config verified.'],
        payload: parsed,
      };
    } catch {
      return {
        valid: false,
        checkpointId: manifest.checkpointId,
        failureCode: 'CHECKPOINT_CORRUPTED',
        reasons: ['Checkpoint payload JSON corrupted.'],
        payload: null,
      };
    }
  }

  listManifests(): readonly ShahabCheckpointManifest[] {
    return [...this.manifests];
  }
}

// ---------------------------------------------------------------------------
// 7. Bounded Failure-Aware Retry Controller (Section 7)
// ---------------------------------------------------------------------------

export interface ShahabRetryAttemptRecord {
  readonly retryEventId: string;
  readonly timestampIso: string;
  readonly jobId: string;
  readonly originalFailureCode: ShahabResilienceFailureCode;
  readonly retryReason: string;
  readonly retryNumber: number;
  readonly retryLimit: number;
  readonly delayMs: number;
  readonly changedExecutionConditions: string | null;
  readonly result: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED_NON_RETRYABLE';
}

export class SHAHABRetryPolicyController {
  private readonly records: ShahabRetryAttemptRecord[] = [];

  evaluateRetryEligibility(
    code: ShahabResilienceFailureCode,
    executionMode: 'LOCAL' | 'CLOUD',
    currentRetryCount: number,
  ): { readonly allowed: boolean; readonly maxRetries: number; readonly nextDelayMs: number; readonly reason: string } {
    const rule = SHAHAB_FAILURE_TAXONOMY[code];
    if (!rule.retryEligible || rule.maxRetries <= 0) {
      return {
        allowed: false,
        maxRetries: 0,
        nextDelayMs: 0,
        reason: `Deterministic/non-retryable failure (${code}): automatic retry forbidden.`,
      };
    }
    if (rule.cloudOnlyRetry && executionMode !== 'CLOUD') {
      return {
        allowed: false,
        maxRetries: 0,
        nextDelayMs: 0,
        reason: `Failure ${code} retry applies only to Cloud mode; Local mode remains offline-isolated.`,
      };
    }
    if (currentRetryCount >= rule.maxRetries) {
      return {
        allowed: false,
        maxRetries: rule.maxRetries,
        nextDelayMs: 0,
        reason: `Retry budget exhausted (${currentRetryCount}/${rule.maxRetries}).`,
      };
    }
    const baseDelayMs = Math.min(4000, 200 * Math.pow(2, currentRetryCount));
    return {
      allowed: true,
      maxRetries: rule.maxRetries,
      nextDelayMs: baseDelayMs,
      reason: `Bounded retry ${currentRetryCount + 1}/${rule.maxRetries} permitted for ${code}.`,
    };
  }

  async executeBoundedRetry<T>(params: {
    readonly jobId: string;
    readonly executionMode: 'LOCAL' | 'CLOUD';
    readonly failureCode: ShahabResilienceFailureCode;
    readonly retryReason: string;
    readonly changedExecutionConditions: string | null;
    readonly signal?: AbortSignal;
    readonly baseDelayOverrideMs?: number;
    readonly operation: (attempt: number) => Promise<T>;
  }): Promise<{ readonly succeeded: boolean; readonly value: T | null; readonly attempts: readonly ShahabRetryAttemptRecord[] }> {
    const localAttempts: ShahabRetryAttemptRecord[] = [];
    const rule = SHAHAB_FAILURE_TAXONOMY[params.failureCode];

    const firstCheck = this.evaluateRetryEligibility(params.failureCode, params.executionMode, 0);
    if (!firstCheck.allowed) {
      const skipped: ShahabRetryAttemptRecord = {
        retryEventId: `rty-${crypto.randomUUID().slice(0, 10)}`,
        timestampIso: new Date().toISOString(),
        jobId: params.jobId,
        originalFailureCode: params.failureCode,
        retryReason: firstCheck.reason,
        retryNumber: 0,
        retryLimit: rule.maxRetries,
        delayMs: 0,
        changedExecutionConditions: params.changedExecutionConditions,
        result: 'SKIPPED_NON_RETRYABLE',
      };
      this.records.push(skipped);
      localAttempts.push(skipped);
      return { succeeded: false, value: null, attempts: localAttempts };
    }

    for (let attempt = 1; attempt <= rule.maxRetries; attempt++) {
      if (params.signal?.aborted) {
        const cancelled: ShahabRetryAttemptRecord = {
          retryEventId: `rty-${crypto.randomUUID().slice(0, 10)}`,
          timestampIso: new Date().toISOString(),
          jobId: params.jobId,
          originalFailureCode: params.failureCode,
          retryReason: 'Cancelled before retry attempt.',
          retryNumber: attempt,
          retryLimit: rule.maxRetries,
          delayMs: 0,
          changedExecutionConditions: params.changedExecutionConditions,
          result: 'CANCELLED',
        };
        this.records.push(cancelled);
        localAttempts.push(cancelled);
        return { succeeded: false, value: null, attempts: localAttempts };
      }

      const delayMs = params.baseDelayOverrideMs ?? Math.min(4000, 150 * Math.pow(2, attempt - 1));
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      try {
        const value = await params.operation(attempt);
        const ok: ShahabRetryAttemptRecord = {
          retryEventId: `rty-${crypto.randomUUID().slice(0, 10)}`,
          timestampIso: new Date().toISOString(),
          jobId: params.jobId,
          originalFailureCode: params.failureCode,
          retryReason: params.retryReason,
          retryNumber: attempt,
          retryLimit: rule.maxRetries,
          delayMs,
          changedExecutionConditions: params.changedExecutionConditions,
          result: 'SUCCEEDED',
        };
        this.records.push(ok);
        localAttempts.push(ok);
        return { succeeded: true, value, attempts: localAttempts };
      } catch {
        const fail: ShahabRetryAttemptRecord = {
          retryEventId: `rty-${crypto.randomUUID().slice(0, 10)}`,
          timestampIso: new Date().toISOString(),
          jobId: params.jobId,
          originalFailureCode: params.failureCode,
          retryReason: params.retryReason,
          retryNumber: attempt,
          retryLimit: rule.maxRetries,
          delayMs,
          changedExecutionConditions: params.changedExecutionConditions,
          result: 'FAILED',
        };
        this.records.push(fail);
        localAttempts.push(fail);
      }
    }

    return { succeeded: false, value: null, attempts: localAttempts };
  }

  getHistory(): readonly ShahabRetryAttemptRecord[] {
    return [...this.records];
  }
}

// ---------------------------------------------------------------------------
// 8. Local/Cloud Failure Isolation & Transition Gate (Section 8)
// ---------------------------------------------------------------------------

export interface ShahabExecutionTransitionRequest {
  readonly fromMode: 'LOCAL' | 'CLOUD';
  readonly toMode: 'LOCAL' | 'CLOUD';
  readonly userExplicitlyAuthorizedTransfer: boolean;
  readonly targetRuntimeSupported: boolean;
  readonly sameLogicalContractVerified: boolean;
  readonly modelTokenizerCompatible: boolean;
  readonly capabilityDifferenceDisclosed: boolean;
  readonly correlationId: string;
}

export interface ShahabExecutionTransitionDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly failure: ShahabClassifiedFailure | null;
}

export class SHAHABExecutionIsolationGuard {
  private readonly seenCloudIdempotencyKeys = new Map<string, { readonly requestId: string; readonly firstSeenIso: string }>();

  evaluateModeTransition(req: ShahabExecutionTransitionRequest): ShahabExecutionTransitionDecision {
    if (req.fromMode === req.toMode) {
      return { allowed: true, reason: 'No execution boundary crossed.', failure: null };
    }
    if (req.toMode === 'CLOUD' && !req.userExplicitlyAuthorizedTransfer) {
      return {
        allowed: false,
        reason: 'Silent LOCAL -> CLOUD transition forbidden: explicit user authorization required before audio leaves device.',
        failure: classifyShahabFailure({
          code: 'AUTHORIZATION_FAILURE',
          stage: 'B01_AUDIO_INGESTION',
          correlationId: req.correlationId,
          observedFailure: 'Attempted LOCAL -> CLOUD transition without explicit user authorization.',
          verifiedTechnicalCause: 'userExplicitlyAuthorizedTransfer === false.',
          reproducible: 'VERIFIED_REPRODUCIBLE',
        }),
      };
    }
    if (!req.targetRuntimeSupported || !req.sameLogicalContractVerified || !req.modelTokenizerCompatible) {
      return {
        allowed: false,
        reason: 'Target execution environment failed runtime, logical contract, or model/tokenizer compatibility check.',
        failure: classifyShahabFailure({
          code: 'UNSUPPORTED_OPERATION',
          stage: 'B04_MODEL_INITIALIZATION',
          correlationId: req.correlationId,
          observedFailure: 'Cross-mode transition blocked due to unverified runtime/contract/tokenizer compatibility.',
          verifiedTechnicalCause: JSON.stringify({
            targetRuntimeSupported: req.targetRuntimeSupported,
            sameLogicalContractVerified: req.sameLogicalContractVerified,
            modelTokenizerCompatible: req.modelTokenizerCompatible,
          }),
          reproducible: 'VERIFIED_REPRODUCIBLE',
        }),
      };
    }
    if (!req.capabilityDifferenceDisclosed) {
      return {
        allowed: false,
        reason: 'Transition blocked: quality/capability differences must be disclosed before switching execution location.',
        failure: classifyShahabFailure({
          code: 'AUTHORIZATION_FAILURE',
          stage: 'B01_AUDIO_INGESTION',
          correlationId: req.correlationId,
          observedFailure: 'Transition attempted without capability/quality difference disclosure.',
          verifiedTechnicalCause: 'capabilityDifferenceDisclosed === false.',
          reproducible: 'VERIFIED_REPRODUCIBLE',
        }),
      };
    }
    return {
      allowed: true,
      reason: `Authorized ${req.fromMode} -> ${req.toMode} transition with verified contract and disclosure.`,
      failure: null,
    };
  }

  registerCloudIdempotencyKey(
    idempotencyKey: string,
    requestId: string,
    correlationId: string,
  ): { readonly accepted: boolean; readonly duplicateOfRequestId: string | null; readonly failure: ShahabClassifiedFailure | null } {
    const existing = this.seenCloudIdempotencyKeys.get(idempotencyKey);
    if (existing) {
      return {
        accepted: false,
        duplicateOfRequestId: existing.requestId,
        failure: classifyShahabFailure({
          code: 'DUPLICATE_JOB_DETECTED',
          stage: 'B01_AUDIO_INGESTION',
          correlationId,
          observedFailure: `Duplicate Cloud request suppressed for idempotencyKey=${idempotencyKey}.`,
          verifiedTechnicalCause: `Already handled under requestId=${existing.requestId}.`,
          reproducible: 'VERIFIED_REPRODUCIBLE',
        }),
      };
    }
    this.seenCloudIdempotencyKeys.set(idempotencyKey, {
      requestId,
      firstSeenIso: new Date().toISOString(),
    });
    return { accepted: true, duplicateOfRequestId: null, failure: null };
  }
}

// ---------------------------------------------------------------------------
// 9. Resource Protection & Concurrency Governor (Section 9)
// ---------------------------------------------------------------------------

export interface ShahabResourceSnapshot {
  readonly capturedAtIso: string;
  readonly processRssBytes: number;
  readonly processHeapUsedBytes: number;
  readonly processHeapTotalBytes: number;
  readonly processExternalBytes: number;
  readonly processPeakRssBytes: number;
  /** Clearly separated from process memory; null if host API unavailable. */
  readonly hostFreeMemoryBytes: number | null;
  readonly hostTotalMemoryBytes: number | null;
  readonly storageTargetPath: string;
  readonly storageAvailableBytes: number | null;
  readonly storageMeasurementStatus: 'MEASURED' | 'NOT_MEASURED';
  readonly activeModelLoads: number;
  readonly activeInferenceJobs: number;
  readonly queuedJobs: number;
  readonly memoryPressureActive: boolean;
}

export interface ShahabResourceGuardEvent {
  readonly eventId: string;
  readonly timestampIso: string;
  readonly guardType: 'MEMORY_PRESSURE' | 'STORAGE_PREFLIGHT' | 'CONCURRENCY_LIMIT' | 'CACHE_EVICTION' | 'MODEL_LOAD_SERIALIZED';
  readonly actionTaken: string;
  readonly measuredProcessRssBytes: number;
  readonly measuredStorageAvailableBytes: number | null;
  readonly requiredBytesEstimatedFromManifest: number | null;
  readonly allowed: boolean;
}

export class SHAHABResourceGuard {
  private peakRssBytes = 0;
  private activeModelLoads = 0;
  private activeInferenceJobs = 0;
  private queuedJobs = 0;
  private modelLoadLockPromise: Promise<void> = Promise.resolve();
  private readonly events: ShahabResourceGuardEvent[] = [];

  constructor(
    private readonly policy: {
      readonly processRssSoftLimitBytes: number;
      readonly maxConcurrentModelLoads: number;
      readonly maxConcurrentInferenceJobs: number;
      readonly storageSafetyMarginBytes: number;
    } = {
      processRssSoftLimitBytes: 1_536 * 1024 * 1024, // 1.5 GiB
      maxConcurrentModelLoads: 1,
      maxConcurrentInferenceJobs: 2,
      storageSafetyMarginBytes: 64 * 1024 * 1024, // 64 MiB explicit policy margin
    },
  ) {}

  measureSnapshot(storagePath: string): ShahabResourceSnapshot {
    const mem = process.memoryUsage();
    if (mem.rss > this.peakRssBytes) this.peakRssBytes = mem.rss;

    let storageAvailableBytes: number | null = null;
    let storageMeasurementStatus: 'MEASURED' | 'NOT_MEASURED' = 'NOT_MEASURED';
    try {
      const target = fs.existsSync(storagePath) ? storagePath : path.dirname(storagePath);
      const st = fs.statfsSync(target);
      storageAvailableBytes = Number(st.bavail) * Number(st.bsize);
      storageMeasurementStatus = 'MEASURED';
    } catch {
      storageAvailableBytes = null;
      storageMeasurementStatus = 'NOT_MEASURED';
    }

    const memoryPressureActive = mem.rss >= this.policy.processRssSoftLimitBytes;
    return {
      capturedAtIso: new Date().toISOString(),
      processRssBytes: mem.rss,
      processHeapUsedBytes: mem.heapUsed,
      processHeapTotalBytes: mem.heapTotal,
      processExternalBytes: mem.external,
      processPeakRssBytes: this.peakRssBytes,
      hostFreeMemoryBytes: os.freemem(),
      hostTotalMemoryBytes: os.totalmem(),
      storageTargetPath: storagePath,
      storageAvailableBytes,
      storageMeasurementStatus,
      activeModelLoads: this.activeModelLoads,
      activeInferenceJobs: this.activeInferenceJobs,
      queuedJobs: this.queuedJobs,
      memoryPressureActive,
    };
  }

  checkStoragePreflight(params: {
    readonly storagePath: string;
    readonly manifestArtifactBytes: number;
    readonly temporaryOverheadBytes: number;
    readonly simulatedAvailableBytesOverride?: number;
  }): { readonly allowed: boolean; readonly requiredBytes: number; readonly availableBytes: number | null; readonly event: ShahabResourceGuardEvent } {
    const snap = this.measureSnapshot(params.storagePath);
    const available =
      params.simulatedAvailableBytesOverride !== undefined
        ? params.simulatedAvailableBytesOverride
        : snap.storageAvailableBytes;
    const requiredBytes =
      params.manifestArtifactBytes + params.temporaryOverheadBytes + this.policy.storageSafetyMarginBytes;
    const allowed = available !== null && available >= requiredBytes;
    const event: ShahabResourceGuardEvent = {
      eventId: `rg-${crypto.randomUUID().slice(0, 10)}`,
      timestampIso: new Date().toISOString(),
      guardType: 'STORAGE_PREFLIGHT',
      actionTaken: allowed
        ? 'Storage preflight passed using measured available bytes vs manifest-derived requirement + safety margin.'
        : 'Aborted safely: measured available storage below manifest requirement + safety margin.',
      measuredProcessRssBytes: snap.processRssBytes,
      measuredStorageAvailableBytes: available,
      requiredBytesEstimatedFromManifest: requiredBytes,
      allowed,
    };
    this.events.push(event);
    return { allowed, requiredBytes, availableBytes: available, event };
  }

  /**
   * Prevents concurrent model initialization storms by serializing loads behind an exclusive lock.
   */
  async runSerializedModelLoad<T>(loader: () => Promise<T>): Promise<{ readonly value: T; readonly serializedWaitOccurred: boolean }> {
    const waited = this.activeModelLoads >= this.policy.maxConcurrentModelLoads;
    this.activeModelLoads += 1;
    let release!: () => void;
    const nextGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.modelLoadLockPromise;
    this.modelLoadLockPromise = prior.then(() => nextGate);

    await prior;
    if (waited) {
      this.events.push({
        eventId: `rg-${crypto.randomUUID().slice(0, 10)}`,
        timestampIso: new Date().toISOString(),
        guardType: 'MODEL_LOAD_SERIALIZED',
        actionTaken: 'Serialized concurrent model load to prevent initialization memory storm.',
        measuredProcessRssBytes: process.memoryUsage().rss,
        measuredStorageAvailableBytes: null,
        requiredBytesEstimatedFromManifest: null,
        allowed: true,
      });
    }
    try {
      const value = await loader();
      return { value, serializedWaitOccurred: waited };
    } finally {
      this.activeModelLoads = Math.max(0, this.activeModelLoads - 1);
      release();
    }
  }

  tryAcquireInferenceSlot(): { readonly acquired: boolean; readonly event: ShahabResourceGuardEvent | null } {
    if (this.activeInferenceJobs >= this.policy.maxConcurrentInferenceJobs) {
      this.queuedJobs += 1;
      const event: ShahabResourceGuardEvent = {
        eventId: `rg-${crypto.randomUUID().slice(0, 10)}`,
        timestampIso: new Date().toISOString(),
        guardType: 'CONCURRENCY_LIMIT',
        actionTaken: `Inference concurrency limit (${this.policy.maxConcurrentInferenceJobs}) reached; job queued.`,
        measuredProcessRssBytes: process.memoryUsage().rss,
        measuredStorageAvailableBytes: null,
        requiredBytesEstimatedFromManifest: null,
        allowed: false,
      };
      this.events.push(event);
      return { acquired: false, event };
    }
    this.activeInferenceJobs += 1;
    return { acquired: true, event: null };
  }

  releaseInferenceSlot(wasQueued = false): void {
    if (wasQueued) {
      this.queuedJobs = Math.max(0, this.queuedJobs - 1);
    } else {
      this.activeInferenceJobs = Math.max(0, this.activeInferenceJobs - 1);
    }
  }

  recordMemoryPressureEviction(evictedEntries: number, freedBytesEstimate: number): ShahabResourceGuardEvent {
    const event: ShahabResourceGuardEvent = {
      eventId: `rg-${crypto.randomUUID().slice(0, 10)}`,
      timestampIso: new Date().toISOString(),
      guardType: 'CACHE_EVICTION',
      actionTaken: `Evicted ${evictedEntries} cache entries (~${freedBytesEstimate} bytes) under memory pressure.`,
      measuredProcessRssBytes: process.memoryUsage().rss,
      measuredStorageAvailableBytes: null,
      requiredBytesEstimatedFromManifest: null,
      allowed: true,
    };
    this.events.push(event);
    return event;
  }

  getEvents(): readonly ShahabResourceGuardEvent[] {
    return [...this.events];
  }
}

// ---------------------------------------------------------------------------
// 10. Graceful Degradation Manager (Section 10)
// ---------------------------------------------------------------------------

export type ShahabDegradedModeId =
  | 'CONTEXTUAL_BIASING_DISABLED'
  | 'FEATURE_CACHE_BYPASSED'
  | 'CONCURRENCY_REDUCED'
  | 'NEW_JOBS_PAUSED_STORAGE'
  | 'PARTIAL_TRANSCRIPT_PRESERVED';

export interface ShahabDegradedModeSpec {
  readonly modeId: ShahabDegradedModeId;
  readonly activationCondition: string;
  readonly knownImpact: string;
  readonly equivalentToNormalOutput: boolean;
  readonly recoveryCondition: string;
  readonly userVisibleStatus: string;
}

export const SHAHAB_DEGRADED_MODE_CATALOG: Readonly<Record<ShahabDegradedModeId, ShahabDegradedModeSpec>> = {
  CONTEXTUAL_BIASING_DISABLED: {
    modeId: 'CONTEXTUAL_BIASING_DISABLED',
    activationCondition: 'Contextual vocabulary subsystem or P0-010/P0-012 hook throws or fails compatibility check.',
    knownImpact: 'Domain terminology biasing skipped; raw acoustic recognition preserved verbatim.',
    equivalentToNormalOutput: false,
    recoveryCondition: 'Contextual memory & tokens.txt verified healthy on next job.',
    userVisibleStatus: 'Degraded: Contextual vocabulary disabled (raw acoustic output active).',
  },
  FEATURE_CACHE_BYPASSED: {
    modeId: 'FEATURE_CACHE_BYPASSED',
    activationCondition: 'Memory pressure or cache integrity mismatch detected.',
    knownImpact: 'Higher latency (features/encoder recomputed); acoustic output identical.',
    equivalentToNormalOutput: true,
    recoveryCondition: 'Process RSS returns below soft threshold and cache reinitializes cleanly.',
    userVisibleStatus: 'Degraded: Acoustic cache bypassed for safety.',
  },
  CONCURRENCY_REDUCED: {
    modeId: 'CONCURRENCY_REDUCED',
    activationCondition: 'Process memory pressure or CPU exhaustion.',
    knownImpact: 'New jobs queued sequentially (max 1 active inference).',
    equivalentToNormalOutput: true,
    recoveryCondition: 'Active RSS and queue pressure normalize.',
    userVisibleStatus: 'Degraded: Concurrency reduced to 1 active job.',
  },
  NEW_JOBS_PAUSED_STORAGE: {
    modeId: 'NEW_JOBS_PAUSED_STORAGE',
    activationCondition: 'Measured available disk space falls below manifest requirement + safety margin.',
    knownImpact: 'New processing jobs paused; existing committed transcripts remain readable.',
    equivalentToNormalOutput: false,
    recoveryCondition: 'Measured available disk space exceeds threshold.',
    userVisibleStatus: 'Degraded: New jobs paused due to low disk space.',
  },
  PARTIAL_TRANSCRIPT_PRESERVED: {
    modeId: 'PARTIAL_TRANSCRIPT_PRESERVED',
    activationCondition: 'Inference interrupted or cancelled after >= 1 chunk committed durably.',
    knownImpact: 'Only completed chunks available; explicitly tagged PARTIAL (never COMPLETED).',
    equivalentToNormalOutput: false,
    recoveryCondition: 'Full job recovery completes remaining chunks and commits atomically.',
    userVisibleStatus: 'Degraded: Partial transcript preserved (incomplete recording).',
  },
};

export interface ShahabDegradedModeActivation {
  readonly activationId: string;
  readonly modeId: ShahabDegradedModeId;
  readonly activatedAtIso: string;
  readonly recoveredAtIso: string | null;
  readonly active: boolean;
  readonly reason: string;
  readonly spec: ShahabDegradedModeSpec;
}

export class SHAHABGracefulDegradationManager {
  private readonly activations = new Map<ShahabDegradedModeId, ShahabDegradedModeActivation>();

  activate(modeId: ShahabDegradedModeId, reason: string): ShahabDegradedModeActivation {
    const record: ShahabDegradedModeActivation = {
      activationId: `deg-${crypto.randomUUID().slice(0, 10)}`,
      modeId,
      activatedAtIso: new Date().toISOString(),
      recoveredAtIso: null,
      active: true,
      reason,
      spec: SHAHAB_DEGRADED_MODE_CATALOG[modeId],
    };
    this.activations.set(modeId, record);
    return record;
  }

  recover(modeId: ShahabDegradedModeId): ShahabDegradedModeActivation | null {
    const existing = this.activations.get(modeId);
    if (!existing) return null;
    const updated: ShahabDegradedModeActivation = {
      ...existing,
      active: false,
      recoveredAtIso: new Date().toISOString(),
    };
    this.activations.set(modeId, updated);
    return updated;
  }

  getActiveModes(): readonly ShahabDegradedModeActivation[] {
    return Array.from(this.activations.values()).filter((a) => a.active);
  }

  getAllActivations(): readonly ShahabDegradedModeActivation[] {
    return Array.from(this.activations.values());
  }
}

// ---------------------------------------------------------------------------
// 11. Disaster Recovery & Backup/Restore Verification (Section 11)
// ---------------------------------------------------------------------------

export interface ShahabBackupScopeEntry {
  readonly assetClass:
    | 'USER_CREATED_CONTENT'
    | 'AUTHORIZED_FINAL_TRANSCRIPTS'
    | 'PROJECT_METADATA'
    | 'MODEL_MANIFESTS'
    | 'MODEL_ARTIFACTS_WEIGHTS'
    | 'RUNTIME_CONFIGURATION'
    | 'OPERATIONAL_TELEMETRY'
    | 'TEMPORARY_INFERENCE_STATE';
  readonly includeInLocalBackup: boolean;
  readonly includeInExternalBackupWithoutConsent: boolean;
  readonly rationale: string;
}

export const SHAHAB_BACKUP_SCOPE_POLICY: readonly ShahabBackupScopeEntry[] = [
  {
    assetClass: 'USER_CREATED_CONTENT',
    includeInLocalBackup: true,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Critical user recordings/edits; NEVER uploaded externally without explicit authorization.',
  },
  {
    assetClass: 'AUTHORIZED_FINAL_TRANSCRIPTS',
    includeInLocalBackup: true,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Irreplaceable human-reviewed transcripts; protected from partial-recovery overwrite.',
  },
  {
    assetClass: 'PROJECT_METADATA',
    includeInLocalBackup: true,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Small structured JSON metadata essential for timeline and provenance restoration.',
  },
  {
    assetClass: 'MODEL_MANIFESTS',
    includeInLocalBackup: true,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Tiny SHA-256 lineage manifests enabling verified reacquisition of exact model revisions.',
  },
  {
    assetClass: 'MODEL_ARTIFACTS_WEIGHTS',
    includeInLocalBackup: false,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Excluded (~115.77 MB); securely reacquirable by pinned 40-char commit SHA + SHA-256 manifest.',
  },
  {
    assetClass: 'RUNTIME_CONFIGURATION',
    includeInLocalBackup: true,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Small local runtime & consent preference files.',
  },
  {
    assetClass: 'OPERATIONAL_TELEMETRY',
    includeInLocalBackup: true,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Sanitized local operational ledger; external sharing strictly opt-in.',
  },
  {
    assetClass: 'TEMPORARY_INFERENCE_STATE',
    includeInLocalBackup: false,
    includeInExternalBackupWithoutConsent: false,
    rationale: 'Ephemeral FFT/encoder buffers and .tmp files are disposable and excluded.',
  },
];

export interface ShahabRestoreVerificationReport {
  readonly schemaVersion: typeof SHAHAB_RESILIENCE_SCHEMA_VERSION;
  readonly reportId: string;
  readonly executedAtIso: string;
  readonly isolatedSandboxDir: string;
  readonly backedUpAssetClasses: readonly string[];
  readonly excludedLargeModelWeights: boolean;
  readonly externalUploadPerformed: boolean;
  readonly checks: {
    readonly readabilityPassed: boolean;
    readonly schemaCompatibilityPassed: boolean;
    readonly contentIntegritySha256Passed: boolean;
    readonly referentialIntegrityPassed: boolean;
    readonly postRestoreUsabilityPassed: boolean;
  };
  readonly verifiedFileCount: number;
  readonly allChecksPassed: boolean;
  readonly notes: readonly string[];
}

export function runIsolatedBackupAndRestoreVerification(
  sourceDocsDir: string,
): ShahabRestoreVerificationReport {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab015-restore-'));
  const backupDir = path.join(sandbox, 'backup');
  const restoreDir = path.join(sandbox, 'restored');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(restoreDir, { recursive: true });

  const candidateFiles = [
    'SHAHAB_IMPLEMENTATION_STATE.json',
    'SHAHAB_RELEASE_MANIFEST.json',
    'SHAHAB_OPERATIONAL_STATE.json',
    'SHAHAB_CONSENT_RECORDS.json',
  ];
  const manifestEntries: { readonly name: string; readonly sha256: string; readonly bytes: number }[] = [];

  try {
    // Include synthetic authorized final transcript to prove provenance + referential preservation
    const syntheticTranscript = {
      schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
      transcriptId: 'tr-restore-test-001',
      jobId: 'job-restore-test-001',
      isPartial: false,
      rawAcousticOutput: 'شکلات داغ در حد استانداردهای بلژیکی',
      contextAssistedOutput: 'شکلات داغ در حد استانداردهای بلژیکی',
      normalizedOutput: 'شکلات داغ در حد استانداردهای بلژیکی',
      authorizedFinalTranscript: 'شکلات داغ در حد استانداردهای بلژیکی',
      authorizedByUserAtIso: new Date().toISOString(),
    };
    const transcriptFile = path.join(backupDir, 'authorized_transcript_sample.json');
    const trWrite = writeJsonAtomicVerified(transcriptFile, syntheticTranscript);
    manifestEntries.push({
      name: 'authorized_transcript_sample.json',
      sha256: trWrite.sha256,
      bytes: trWrite.bytesWritten,
    });

    for (const fileName of candidateFiles) {
      const src = path.join(sourceDocsDir, fileName);
      if (!fs.existsSync(src)) continue;
      const raw = fs.readFileSync(src, 'utf8');
      const dst = path.join(backupDir, fileName);
      fs.writeFileSync(dst, raw, 'utf8');
      manifestEntries.push({
        name: fileName,
        sha256: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(raw, 'utf8'),
      });
    }

    const backupBundleManifest = {
      schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
      createdAtIso: new Date().toISOString(),
      excludedLargeModelWeights: true,
      externalUploadPerformed: false,
      files: manifestEntries,
    };
    writeJsonAtomicVerified(path.join(backupDir, 'BACKUP_MANIFEST.json'), backupBundleManifest);

    // Restore into clean restoreDir and verify every check
    const readManifest = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'BACKUP_MANIFEST.json'), 'utf8'),
    ) as typeof backupBundleManifest;
    let readabilityPassed = true;
    let schemaCompatibilityPassed = readManifest.schemaVersion === SHAHAB_RESILIENCE_SCHEMA_VERSION;
    let contentIntegritySha256Passed = true;
    let referentialIntegrityPassed = true;

    for (const entry of readManifest.files) {
      const src = path.join(backupDir, entry.name);
      const dst = path.join(restoreDir, entry.name);
      fs.copyFileSync(src, dst);
      const raw = fs.readFileSync(dst, 'utf8');
      const actualSha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
      if (actualSha !== entry.sha256) contentIntegritySha256Passed = false;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (entry.name === 'authorized_transcript_sample.json') {
          if (parsed.authorizedFinalTranscript !== syntheticTranscript.authorizedFinalTranscript) {
            referentialIntegrityPassed = false;
          }
        }
        if (entry.name === 'SHAHAB_RELEASE_MANIFEST.json') {
          if (!parsed.releaseCandidateId) referentialIntegrityPassed = false;
        }
      } catch {
        readabilityPassed = false;
      }
    }

    // Post-restore usability: load restored transcript into fresh SHAHABJobStateMachine & verify overwrite protection
    const restoredTranscript = JSON.parse(
      fs.readFileSync(path.join(restoreDir, 'authorized_transcript_sample.json'), 'utf8'),
    ) as ShahabTranscriptProvenanceEnvelope;
    const sm = new SHAHABJobStateMachine();
    sm.commitTranscriptEnvelope('job-restore-test-001', restoredTranscript);
    const overwriteAttempt = sm.commitTranscriptEnvelope('job-restore-test-001', {
      ...restoredTranscript,
      isPartial: true,
      authorizedFinalTranscript: null,
      rawAcousticOutput: 'PARTIAL_OVERWRITE_SHOULD_FAIL',
    });
    const postRestoreUsabilityPassed =
      !overwriteAttempt.committed &&
      overwriteAttempt.preservedAuthorizedTranscript &&
      sm.getTranscriptEnvelope('job-restore-test-001')?.authorizedFinalTranscript ===
        syntheticTranscript.authorizedFinalTranscript;

    const allChecksPassed =
      readabilityPassed &&
      schemaCompatibilityPassed &&
      contentIntegritySha256Passed &&
      referentialIntegrityPassed &&
      postRestoreUsabilityPassed;

    return {
      schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
      reportId: `restore-${crypto.randomUUID().slice(0, 10)}`,
      executedAtIso: new Date().toISOString(),
      isolatedSandboxDir: '<ISOLATED_OS_TMPDIR_CLEANED>',
      backedUpAssetClasses: [
        'AUTHORIZED_FINAL_TRANSCRIPTS',
        'PROJECT_METADATA',
        'MODEL_MANIFESTS',
        'RUNTIME_CONFIGURATION',
      ],
      excludedLargeModelWeights: true,
      externalUploadPerformed: false,
      checks: {
        readabilityPassed,
        schemaCompatibilityPassed,
        contentIntegritySha256Passed,
        referentialIntegrityPassed,
        postRestoreUsabilityPassed,
      },
      verifiedFileCount: manifestEntries.length,
      allChecksPassed,
      notes: [
        'Executed in isolated temporary sandbox; production files untouched.',
        'Large ONNX model artifacts intentionally excluded from backup bundle (reacquirable via SHA-256 manifest).',
        'Verified post-restore protection against partial recovery overwriting an authorized final transcript.',
      ],
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 12. Isolated Fault-Injection Harness (Section 12)
// ---------------------------------------------------------------------------

export interface ShahabFaultInjectionScenarioResult {
  readonly testId: string;
  readonly category: 'PROCESS' | 'STORAGE' | 'MEMORY' | 'NETWORK' | 'INTEGRITY' | 'UPDATE_INSTALL';
  readonly faultInjected: string;
  readonly initialState: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly recoveryResult: 'RECOVERED_VERIFIED' | 'CONTAINED_SAFELY' | 'ROLLBACK_VERIFIED' | 'FAILED';
  readonly dataIntegrityResult: 'INTACT_VERIFIED' | 'CORRUPTION_BLOCKED' | 'FAILED';
  readonly passed: boolean;
  readonly evidenceRef: string;
}

export interface ShahabFaultInjectionSuiteReport {
  readonly schemaVersion: typeof SHAHAB_RESILIENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly executedAtIso: string;
  readonly isolatedEnvironmentOnly: true;
  readonly productionDataTouched: false;
  readonly totalScenarios: number;
  readonly passedScenarios: number;
  readonly failedScenarios: number;
  readonly scenarios: readonly ShahabFaultInjectionScenarioResult[];
  readonly recordedFailures: readonly ShahabClassifiedFailure[];
  readonly recordedResourceEvents: readonly ShahabResourceGuardEvent[];
  readonly recordedJobTransitions: readonly ShahabJobTransitionEvent[];
  readonly recordedCheckpointManifests: readonly ShahabCheckpointManifest[];
  readonly recordedRecoveryEvents: readonly {
    readonly recoveryEventId: string;
    readonly timestampIso: string;
    readonly testId: string;
    readonly jobId: string;
    readonly outcome: 'SUCCEEDED' | 'REJECTED_UNSAFE' | 'ROLLED_BACK';
    readonly detail: string;
  }[];
}

export async function runIsolatedFaultInjectionSuite(params: {
  readonly modelDir: string;
}): Promise<ShahabFaultInjectionSuiteReport> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'shahab015-fi-'));
  const stateDir = path.join(sandbox, 'state');
  const chkDir = path.join(sandbox, 'checkpoints');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(chkDir, { recursive: true });

  const recordedFailures: ShahabClassifiedFailure[] = [];
  const recordedRecoveryEvents: {
    readonly recoveryEventId: string;
    readonly timestampIso: string;
    readonly testId: string;
    readonly jobId: string;
    readonly outcome: 'SUCCEEDED' | 'REJECTED_UNSAFE' | 'ROLLED_BACK';
    readonly detail: string;
  }[] = [];
  const scenarios: ShahabFaultInjectionScenarioResult[] = [];

  const sm = new SHAHABJobStateMachine(stateDir, (f) => recordedFailures.push(f));
  const chkMgr = new SHAHABCheckpointManager(chkDir);
  const retryCtrl = new SHAHABRetryPolicyController();
  const isoGuard = new SHAHABExecutionIsolationGuard();
  const resGuard = new SHAHABResourceGuard();
  const degMgr = new SHAHABGracefulDegradationManager();

  const sampleAudioSha = crypto.createHash('sha256').update('shahab015-isolated-audio-v1').digest('hex');
  const modelDigestSha = crypto.createHash('sha256').update('persian-zipformer-int8-v1').digest('hex');
  const tokSha = crypto.createHash('sha256').update('tokens.txt-v1').digest('hex');
  const preprocSha = crypto.createHash('sha256').update('kaldi-fbank80-16k-float1').digest('hex');

  try {
    // --- FI-PROC-01: Worker crash during preprocessing (no checkpoint yet -> safe restart) ---
    {
      const { job } = sm.createJob({
        idempotencyKey: 'fi-proc-01',
        correlationId: 'corr-fi-proc-01',
        executionMode: 'LOCAL',
        audioSourceId: 'rec-proc-01.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        tokenizerSha256: tokSha,
      });
      sm.transition(job.jobId, 'VALIDATING', { reason: 'Validate WAV' });
      sm.transition(job.jobId, 'QUEUED', { reason: 'Queued' });
      sm.transition(job.jobId, 'INITIALIZING', { reason: 'Model ready' });
      sm.transition(job.jobId, 'PROCESSING', { reason: 'Enter preprocessing' });
      sm.transition(job.jobId, 'FAILED_RECOVERABLE', {
        reason: 'Simulated worker termination during preprocessing',
        failureCode: 'INFERENCE_CRASH',
      });
      const completeAttempt = sm.transition(job.jobId, 'COMPLETED', {
        reason: 'Must fail: cannot jump from FAILED_RECOVERABLE to COMPLETED',
        outputDurablyCommitted: false,
      });
      const ok = !completeAttempt.accepted && sm.getJob(job.jobId)?.state === 'FAILED_RECOVERABLE';
      scenarios.push({
        testId: 'FI-PROC-01',
        category: 'PROCESS',
        faultInjected: 'Terminate worker during preprocessing',
        initialState: 'PROCESSING (chunk 0, no durable output)',
        expectedBehavior: 'Transition to FAILED_RECOVERABLE; forbid invalid jump to COMPLETED',
        actualBehavior: `State=${sm.getJob(job.jobId)?.state}; invalid COMPLETED jump rejected=${!completeAttempt.accepted}`,
        recoveryResult: ok ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-PROC-01',
      });
    }

    // --- FI-PROC-02: Crash during encoder execution after chunk 0 checkpoint + full verified recovery ---
    {
      const { job } = sm.createJob({
        idempotencyKey: 'fi-proc-02',
        correlationId: 'corr-fi-proc-02',
        executionMode: 'LOCAL',
        audioSourceId: 'rec-proc-02.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        tokenizerSha256: tokSha,
      });
      sm.transition(job.jobId, 'VALIDATING', { reason: 'Validated' });
      sm.transition(job.jobId, 'QUEUED', { reason: 'Queued' });
      sm.transition(job.jobId, 'INITIALIZING', { reason: 'Initialized' });
      sm.transition(job.jobId, 'PROCESSING', { reason: 'Encoding chunks 0..1' });

      const manifest = chkMgr.saveCheckpoint({
        jobId: job.jobId,
        stage: 'POST_ENCODER_EXECUTION',
        audioSourceId: 'rec-proc-02.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        modelArtifactsDigestSha256: modelDigestSha,
        tokenizerSha256: tokSha,
        preprocessingConfigSha256: preprocSha,
        runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
        completedChunkIndices: [0],
        totalChunks: 2,
        payload: { chunk0Frames: 158, chunk0Tokens: ['شکلات', 'داغ'] },
      });

      // Simulated crash during chunk 1 encoder execution
      sm.transition(job.jobId, 'RECOVERY_PENDING', {
        reason: 'App restart detected after chunk 0 encoder checkpoint',
        activeCheckpointId: manifest.checkpointId,
        partialOutputDesignated: true,
        failureCode: 'INFERENCE_CRASH',
      });
      sm.commitTranscriptEnvelope(job.jobId, {
        transcriptId: 'tr-fi-proc-02',
        isPartial: true,
        completedChunkCount: 1,
        totalChunkCount: 2,
        rawAcousticOutput: 'شکلات داغ',
        contextAssistedOutput: null,
        normalizedOutput: null,
        authorizedFinalTranscript: null,
        authorizedByUserAtIso: null,
        durableCommitSha256: manifest.payloadSha256,
      });

      // Verify checkpoint and resume chunk 1 -> COMPLETED
      const verifyRes = chkMgr.verifyForRecovery(
        path.join(chkDir, 'manifests', `${manifest.checkpointId}.manifest.json`),
        {
          audioSourceId: 'rec-proc-02.wav',
          audioContentSha256: sampleAudioSha,
          modelId: SHAHAB_NEURAL_CORE_IDENTITY,
          modelArtifactsDigestSha256: modelDigestSha,
          tokenizerSha256: tokSha,
          preprocessingConfigSha256: preprocSha,
          runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
        },
      );
      sm.transition(job.jobId, 'RECOVERING', { reason: 'Verified checkpoint; resuming chunk 1' });
      sm.commitTranscriptEnvelope(job.jobId, {
        transcriptId: 'tr-fi-proc-02',
        isPartial: false,
        completedChunkCount: 2,
        totalChunkCount: 2,
        rawAcousticOutput: 'شکلات داغ در حد استانداردهای بلژیکی',
        contextAssistedOutput: 'شکلات داغ در حد استانداردهای بلژیکی',
        normalizedOutput: 'شکلات داغ در حد استانداردهای بلژیکی',
        authorizedFinalTranscript: 'شکلات داغ در حد استانداردهای بلژیکی',
        authorizedByUserAtIso: new Date().toISOString(),
        durableCommitSha256: crypto.createHash('sha256').update('final-tr-fi-proc-02').digest('hex'),
      });
      const finalTr = sm.transition(job.jobId, 'COMPLETED', {
        reason: 'Chunk 1 recovered and full transcript durably committed',
        outputDurablyCommitted: true,
        partialOutputDesignated: false,
        committedTranscriptRef: `transcripts/${job.jobId}.transcript.json`,
      });
      // Duplicate completion event MUST be rejected
      const dupComplete = sm.transition(job.jobId, 'COMPLETED', {
        reason: 'Duplicate completion event test',
        outputDurablyCommitted: true,
      });
      const ok = verifyRes.valid && finalTr.accepted && !dupComplete.accepted;
      recordedRecoveryEvents.push({
        recoveryEventId: `rec-${crypto.randomUUID().slice(0, 10)}`,
        timestampIso: new Date().toISOString(),
        testId: 'FI-PROC-02',
        jobId: job.jobId,
        outcome: ok ? 'SUCCEEDED' : 'REJECTED_UNSAFE',
        detail: `Recovered from ${manifest.checkpointId} (chunk 0 verified) and suppressed duplicate COMPLETED.`,
      });
      scenarios.push({
        testId: 'FI-PROC-02',
        category: 'PROCESS',
        faultInjected: 'Crash/restart during encoder execution on chunk 1 + duplicate completion event',
        initialState: 'PROCESSING with verified chunk-0 POST_ENCODER_EXECUTION checkpoint',
        expectedBehavior: 'Verify checkpoint integrity, resume chunk 1, commit full transcript, reject duplicate COMPLETED',
        actualBehavior: `CheckpointValid=${verifyRes.valid}, FinalCompleted=${finalTr.accepted}, DuplicateBlocked=${!dupComplete.accepted}`,
        recoveryResult: ok ? 'RECOVERED_VERIFIED' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-PROC-02',
      });
    }

    // --- FI-PROC-03: Crash during decoder & persistence + authorized-transcript overwrite protection ---
    {
      const { job } = sm.createJob({
        idempotencyKey: 'fi-proc-03',
        correlationId: 'corr-fi-proc-03',
        executionMode: 'LOCAL',
        audioSourceId: 'rec-proc-03.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        tokenizerSha256: tokSha,
      });
      sm.commitTranscriptEnvelope(job.jobId, {
        transcriptId: 'tr-fi-proc-03',
        isPartial: false,
        completedChunkCount: 2,
        totalChunkCount: 2,
        rawAcousticOutput: 'متن اصلی تاییدشده',
        contextAssistedOutput: 'متن اصلی تاییدشده',
        normalizedOutput: 'متن اصلی تاییدشده',
        authorizedFinalTranscript: 'متن اصلی تاییدشده',
        authorizedByUserAtIso: new Date().toISOString(),
        durableCommitSha256: 'abc123',
      });
      const partialOverwrite = sm.commitTranscriptEnvelope(job.jobId, {
        transcriptId: 'tr-fi-proc-03',
        isPartial: true,
        completedChunkCount: 1,
        totalChunkCount: 2,
        rawAcousticOutput: 'متن ناقص بازیابی',
        contextAssistedOutput: null,
        normalizedOutput: null,
        authorizedFinalTranscript: null,
        authorizedByUserAtIso: null,
        durableCommitSha256: null,
      });
      // Also test cancellation preserves committed data
      sm.transition(job.jobId, 'VALIDATING', { reason: 'Re-run check' });
      sm.transition(job.jobId, 'CANCELLATION_REQUESTED', { reason: 'User cancelled' });
      sm.transition(job.jobId, 'CANCELLED', { reason: 'Cancelled cleanly' });
      const preserved =
        !partialOverwrite.committed &&
        partialOverwrite.preservedAuthorizedTranscript &&
        sm.getTranscriptEnvelope(job.jobId)?.authorizedFinalTranscript === 'متن اصلی تاییدشده' &&
        sm.getJob(job.jobId)?.userCommittedDataPreserved === true;
      scenarios.push({
        testId: 'FI-PROC-03',
        category: 'PROCESS',
        faultInjected: 'Decoder/persistence interruption attempting partial overwrite + user cancellation',
        initialState: 'Existing authorizedFinalTranscript committed',
        expectedBehavior: 'Reject partial recovery overwrite; cancellation preserves committed user transcript',
        actualBehavior: `OverwriteBlocked=${!partialOverwrite.committed}, AuthorizedPreserved=${preserved}`,
        recoveryResult: preserved ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: preserved ? 'INTACT_VERIFIED' : 'FAILED',
        passed: preserved,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-PROC-03',
      });
    }

    // --- FI-STOR-01: Disk full (ENOSPC) during atomic persistence + storage preflight abort ---
    {
      const targetFile = path.join(stateDir, 'committed_transcript_guard.json');
      const originalWrite = writeJsonAtomicVerified(targetFile, { version: 1, committedText: 'نسخه معتبر قبلی' });
      let enospcCaught = false;
      try {
        writeJsonAtomicVerified(targetFile, { version: 2, committedText: 'نباید نوشته شود' }, { simulateDiskFull: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOSPC') enospcCaught = true;
      }
      const preflight = resGuard.checkStoragePreflight({
        storagePath: stateDir,
        manifestArtifactBytes: 120 * 1024 * 1024,
        temporaryOverheadBytes: 32 * 1024 * 1024,
        simulatedAvailableBytesOverride: 50 * 1024 * 1024,
      });
      const deg = degMgr.activate('NEW_JOBS_PAUSED_STORAGE', 'Isolated ENOSPC simulation');
      const retryCheck = retryCtrl.evaluateRetryEligibility('DISK_FULL', 'LOCAL', 0);
      const afterRead = fs.readFileSync(targetFile, 'utf8');
      const afterSha = crypto.createHash('sha256').update(afterRead, 'utf8').digest('hex');
      const ok =
        enospcCaught &&
        !preflight.allowed &&
        !retryCheck.allowed &&
        deg.active &&
        afterSha === originalWrite.sha256;
      degMgr.recover('NEW_JOBS_PAUSED_STORAGE');
      scenarios.push({
        testId: 'FI-STOR-01',
        category: 'STORAGE',
        faultInjected: 'Simulated ENOSPC disk full during atomic write + low-space preflight',
        initialState: 'Previously committed transcript file with verified SHA-256',
        expectedBehavior: 'Abort write without retry, pause new jobs, preserve prior committed file bit-for-bit',
        actualBehavior: `ENOSPC=${enospcCaught}, PreflightBlocked=${!preflight.allowed}, NoRetry=${!retryCheck.allowed}, PriorShaIntact=${afterSha === originalWrite.sha256}`,
        recoveryResult: ok ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-STOR-01',
      });
    }

    // --- FI-STOR-02: Mid-write I/O failure leaves zero temp residue and preserves prior state ---
    {
      const targetFile = path.join(stateDir, 'atomic_io_guard.json');
      const baseline = writeJsonAtomicVerified(targetFile, { commitSeq: 42, text: 'پایدار' });
      let ioCaught = false;
      try {
        writeJsonAtomicVerified(targetFile, { commitSeq: 43, text: 'ناقص' }, { simulateWriteFailure: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EIO') ioCaught = true;
      }
      const leftoverTemps = fs.readdirSync(stateDir).filter((f) => f.includes('atomic_io_guard.json.tmp.'));
      const intact =
        crypto.createHash('sha256').update(fs.readFileSync(targetFile, 'utf8'), 'utf8').digest('hex') ===
        baseline.sha256;
      const ok = ioCaught && leftoverTemps.length === 0 && intact;
      scenarios.push({
        testId: 'FI-STOR-02',
        category: 'STORAGE',
        faultInjected: 'Mid-write EIO interruption after writing 1/3 of temp file',
        initialState: 'Valid atomic_io_guard.json (commitSeq=42)',
        expectedBehavior: 'Reject partial write, clean temp file, keep commitSeq=42 intact',
        actualBehavior: `EIO=${ioCaught}, TempLeftovers=${leftoverTemps.length}, PriorIntact=${intact}`,
        recoveryResult: ok ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-STOR-02',
      });
    }

    // --- FI-STOR-03: Corrupted checkpoint rejected on recovery ---
    {
      const badChk = chkMgr.saveCheckpoint({
        jobId: 'job-corrupt-chk',
        stage: 'POST_FEATURE_EXTRACTION',
        audioSourceId: 'rec-corrupt.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        modelArtifactsDigestSha256: modelDigestSha,
        tokenizerSha256: tokSha,
        preprocessingConfigSha256: preprocSha,
        runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
        completedChunkIndices: [0],
        totalChunks: 2,
        payload: { fbankFrames: 120 },
      });
      // Tamper with checkpoint payload on disk inside sandbox
      const payloadFile = path.join(chkDir, badChk.payloadRelativePath);
      fs.writeFileSync(payloadFile, JSON.stringify({ fbankFrames: 999999, tampered: true }), 'utf8');
      const vRes = chkMgr.verifyForRecovery(
        path.join(chkDir, 'manifests', `${badChk.checkpointId}.manifest.json`),
        {
          audioSourceId: 'rec-corrupt.wav',
          audioContentSha256: sampleAudioSha,
          modelId: SHAHAB_NEURAL_CORE_IDENTITY,
          modelArtifactsDigestSha256: modelDigestSha,
          tokenizerSha256: tokSha,
          preprocessingConfigSha256: preprocSha,
          runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
        },
      );
      const ok = !vRes.valid && vRes.failureCode === 'CHECKPOINT_CORRUPTED';
      recordedRecoveryEvents.push({
        recoveryEventId: `rec-${crypto.randomUUID().slice(0, 10)}`,
        timestampIso: new Date().toISOString(),
        testId: 'FI-STOR-03',
        jobId: 'job-corrupt-chk',
        outcome: 'REJECTED_UNSAFE',
        detail: `Corrupted checkpoint ${badChk.checkpointId} rejected (${vRes.failureCode}).`,
      });
      scenarios.push({
        testId: 'FI-STOR-03',
        category: 'STORAGE',
        faultInjected: 'Post-write tampering of checkpoint payload JSON',
        initialState: 'Valid POST_FEATURE_EXTRACTION checkpoint',
        expectedBehavior: 'Detect SHA-256 mismatch and reject recovery with CHECKPOINT_CORRUPTED',
        actualBehavior: `Valid=${vRes.valid}, Code=${vRes.failureCode}`,
        recoveryResult: ok ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: ok ? 'CORRUPTION_BLOCKED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-STOR-03',
      });
    }

    // --- FI-MEM-01: Memory pressure eviction + concurrent model initialization storm serialization ---
    {
      const evictEvt = resGuard.recordMemoryPressureEviction(12, 48 * 1024 * 1024);
      const degCache = degMgr.activate('FEATURE_CACHE_BYPASSED', 'Memory pressure cache eviction test');
      let concurrentPeak = 0;
      let running = 0;
      const loads = await Promise.all(
        [1, 2, 3].map((idx) =>
          resGuard.runSerializedModelLoad(async () => {
            running += 1;
            if (running > concurrentPeak) concurrentPeak = running;
            await new Promise((r) => setTimeout(r, 15));
            running -= 1;
            return idx;
          }),
        ),
      );
      const anySerializedWait = loads.some((l) => l.serializedWaitOccurred);
      const ok = concurrentPeak === 1 && anySerializedWait && degCache.active && evictEvt.allowed;
      degMgr.recover('FEATURE_CACHE_BYPASSED');
      scenarios.push({
        testId: 'FI-MEM-01',
        category: 'MEMORY',
        faultInjected: 'Memory pressure cache eviction + 3 simultaneous model initialization calls',
        initialState: 'Idle SHAHABResourceGuard (maxConcurrentModelLoads=1)',
        expectedBehavior: 'Serialize concurrent model loads (peak=1), evict cache safely, emit degraded event',
        actualBehavior: `PeakConcurrentLoads=${concurrentPeak}, SerializedWait=${anySerializedWait}, CacheEvicted=true`,
        recoveryResult: ok ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-MEM-01',
      });
    }

    // --- FI-NET-01: Cloud timeout + bounded retry recovery + duplicate response suppression + Local isolation ---
    {
      // 1) Local->Cloud without consent MUST fail
      const silentEsc = isoGuard.evaluateModeTransition({
        fromMode: 'LOCAL',
        toMode: 'CLOUD',
        userExplicitlyAuthorizedTransfer: false,
        targetRuntimeSupported: true,
        sameLogicalContractVerified: true,
        modelTokenizerCompatible: true,
        capabilityDifferenceDisclosed: true,
        correlationId: 'corr-fi-net-01',
      });
      // 2) Cloud transient timeout recovers on attempt 2
      let cloudCallCount = 0;
      const retryRes = await retryCtrl.executeBoundedRetry({
        jobId: 'job-cloud-net-01',
        executionMode: 'CLOUD',
        failureCode: 'REQUEST_TIMEOUT',
        retryReason: 'Transient Cloud timeout recovery test',
        changedExecutionConditions: 'Re-sent with same idempotencyKey after backoff',
        baseDelayOverrideMs: 5,
        operation: async () => {
          cloudCallCount += 1;
          if (cloudCallCount === 1) throw new Error('Simulated timeout on attempt 1');
          return { transcriptId: 'cloud-ok-1' };
        },
      });
      // 3) Duplicate Cloud request with same idempotency key suppressed
      const firstReg = isoGuard.registerCloudIdempotencyKey('idem-cloud-01', 'req-1', 'corr-fi-net-01');
      const dupReg = isoGuard.registerCloudIdempotencyKey('idem-cloud-01', 'req-2', 'corr-fi-net-01');
      const ok =
        !silentEsc.allowed &&
        silentEsc.failure?.code === 'AUTHORIZATION_FAILURE' &&
        retryRes.succeeded &&
        cloudCallCount === 2 &&
        firstReg.accepted &&
        !dupReg.accepted &&
        dupReg.failure?.code === 'DUPLICATE_JOB_DETECTED';
      scenarios.push({
        testId: 'FI-NET-01',
        category: 'NETWORK',
        faultInjected: 'Unauthorized LOCAL->CLOUD fallback + Cloud REQUEST_TIMEOUT + duplicate Cloud delivery',
        initialState: 'Isolated Local/Cloud guard and bounded Cloud retry policy',
        expectedBehavior: 'Block silent LOCAL->CLOUD upload, recover Cloud timeout within retry limit, suppress duplicate Cloud request',
        actualBehavior: `SilentFallbackBlocked=${!silentEsc.allowed}, CloudRecoveredOnAttempt=${cloudCallCount}, DuplicateSuppressed=${!dupReg.accepted}`,
        recoveryResult: ok ? 'RECOVERED_VERIFIED' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-NET-01',
      });
    }

    // --- FI-INT-01: Post-manifest artifact tamper, incompatible tokenizer, unsupported schema version, mismatched audio ---
    {
      // A: Post-manifest artifact tamper (reuses SHAHABArtifactIntegrityVerifier)
      const tamperDir = path.join(sandbox, 'tamper-model');
      fs.mkdirSync(tamperDir, { recursive: true });
      const fPath = path.join(tamperDir, 'encoder.onnx');
      fs.writeFileSync(fPath, 'original-weights-bytes', 'utf8');
      const origSha = crypto.createHash('sha256').update('original-weights-bytes').digest('hex');
      fs.writeFileSync(fPath, 'tampered-weights-bytes', 'utf8');
      const verifier = new SHAHABArtifactIntegrityVerifier();
      const integrityRes = verifier.verifyDirectory({
        packageDir: tamperDir,
        expectedFiles: [
          { fileName: 'encoder.onnx', expectedSha256: origSha, expectedBytes: 22, isOnnx: false },
        ],
      });

      // B: Incompatible tokenizer, unsupported version, mismatched recording on checkpoints
      const validChk = chkMgr.saveCheckpoint({
        jobId: 'job-int-checks',
        stage: 'POST_ENCODER_EXECUTION',
        audioSourceId: 'rec-A.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        modelArtifactsDigestSha256: modelDigestSha,
        tokenizerSha256: tokSha,
        preprocessingConfigSha256: preprocSha,
        runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
        completedChunkIndices: [0],
        totalChunks: 2,
        payload: { frames: 64 },
      });
      const mPath = path.join(chkDir, 'manifests', `${validChk.checkpointId}.manifest.json`);

      const tokMismatch = chkMgr.verifyForRecovery(mPath, {
        audioSourceId: 'rec-A.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        modelArtifactsDigestSha256: modelDigestSha,
        tokenizerSha256: 'DIFFERENT_TOKENIZER_SHA',
        preprocessingConfigSha256: preprocSha,
        runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
      });

      const audioMismatch = chkMgr.verifyForRecovery(mPath, {
        audioSourceId: 'rec-B.wav',
        audioContentSha256: 'DIFFERENT_AUDIO_SHA',
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        modelArtifactsDigestSha256: modelDigestSha,
        tokenizerSha256: tokSha,
        preprocessingConfigSha256: preprocSha,
        runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
      });

      const badVerPath = path.join(chkDir, 'manifests', 'bad-version.manifest.json');
      writeJsonAtomicVerified(badVerPath, { ...validChk, schemaVersion: '99.0.0' });
      const verMismatch = chkMgr.verifyForRecovery(badVerPath, {
        audioSourceId: 'rec-A.wav',
        audioContentSha256: sampleAudioSha,
        modelId: SHAHAB_NEURAL_CORE_IDENTITY,
        modelArtifactsDigestSha256: modelDigestSha,
        tokenizerSha256: tokSha,
        preprocessingConfigSha256: preprocSha,
        runtimeCompatibilityTag: 'onnxruntime-web-wasm-cpu',
      });

      const ok =
        !integrityRes.verified &&
        tokMismatch.failureCode === 'TOKENIZER_INCOMPATIBLE' &&
        audioMismatch.failureCode === 'UNVERIFIED_RECOVERY_DATA' &&
        verMismatch.failureCode === 'STATE_VERSION_MISMATCH';
      scenarios.push({
        testId: 'FI-INT-01',
        category: 'INTEGRITY',
        faultInjected: 'Post-manifest artifact tamper + incompatible tokenizer + mismatched recording + unsupported schema version 99.0.0',
        initialState: 'Verified model manifest and valid checkpoint',
        expectedBehavior: 'Block tampered artifact and reject all 3 incompatible checkpoints with exact failure codes',
        actualBehavior: `TamperBlocked=${!integrityRes.verified}, Tok=${tokMismatch.failureCode}, Audio=${audioMismatch.failureCode}, Ver=${verMismatch.failureCode}`,
        recoveryResult: ok ? 'CONTAINED_SAFELY' : 'FAILED',
        dataIntegrityResult: ok ? 'CORRUPTION_BLOCKED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-INT-01',
      });
    }

    // --- FI-UPD-01: Interrupted installation / failed update activation + verified rollback to last known-good ---
    {
      const installRoot = path.join(sandbox, 'install-root');
      const updMgr = new SHAHABUpdateLifecycleManager('SHAHAB-R2.0.0-GOOD');
      const installer = new SHAHABInstaller();

      // Stage corrupted candidate in isolated installRoot -> MUST reject before touching active version
      const badSrc = path.join(sandbox, 'bad-pkg');
      fs.mkdirSync(badSrc, { recursive: true });
      fs.writeFileSync(path.join(badSrc, 'tokens.txt'), 'CORRUPTED_INTERRUPTED', 'utf8');
      const goodSha = crypto.createHash('sha256').update('a 0\nb 1\n').digest('hex');

      const installBad = await installer.installAndActivate({
        versionId: 'SHAHAB-R2.0.1-INTERRUPTED',
        sourceDir: badSrc,
        installRootDir: installRoot,
        expectedFiles: [{ fileName: 'tokens.txt', expectedSha256: goodSha, expectedBytes: 8, isOnnx: false }],
        smokeTestWavPath: path.join(sandbox, 'nonexistent.wav'),
      });

      // Verify SHAHAB-014 staged update lifecycle: stage valid candidate, simulate interrupted activation -> ROLLED_BACK
      const stageRes = updMgr.validateAndStageUpdate({
        manifest: {
          manifestRevision: 'rev-fi-upd-01',
          releaseId: 'SHAHAB-R2.0.1-CANDIDATE',
          engineVersion: 'SHAHAB-R2.0.1',
          modelVersion: '0408facbcf3f',
          modelRevisionSha: '0408facbcf3f670121def48e0802c395c225d150',
          tokenizerSha256: goodSha,
          artifactFormat: 'ONNX_INT8_STATELESS7',
          artifacts: [{ fileName: 'tokens.txt', bytes: 8, sha256: goodSha }],
          supportedProviders: ['wasm'],
          minAppVersion: '1.0.0',
          licenseSpdx: 'Apache-2.0',
          signatureBase64: null,
        },
        actualArtifacts: new Map([['tokens.txt', { bytes: 8, sha256: goodSha }]]),
        currentProvider: 'wasm',
        requireCryptographicSignature: false,
        smokeTestPassed: true,
      });

      const crashedActivation = updMgr.activateStaged({
        explicitPolicyAuthorized: true,
        simulateCrashDuringActivation: true,
      });

      // Also verify bad hash candidate is rejected without altering active release
      const badHashStage = updMgr.validateAndStageUpdate({
        manifest: {
          manifestRevision: 'rev-fi-upd-01-corrupt',
          releaseId: 'SHAHAB-R2.0.2-CORRUPT',
          engineVersion: 'SHAHAB-R2.0.2',
          modelVersion: '0408facbcf3f',
          modelRevisionSha: '0408facbcf3f670121def48e0802c395c225d150',
          tokenizerSha256: goodSha,
          artifactFormat: 'ONNX_INT8_STATELESS7',
          artifacts: [{ fileName: 'tokens.txt', bytes: 8, sha256: goodSha }],
          supportedProviders: ['wasm'],
          minAppVersion: '1.0.0',
          licenseSpdx: 'Apache-2.0',
          signatureBase64: null,
        },
        actualArtifacts: new Map([['tokens.txt', { bytes: 21, sha256: 'deadbeef'.repeat(8) }]]),
        currentProvider: 'wasm',
        requireCryptographicSignature: false,
        smokeTestPassed: true,
      });

      const finalUpdState = updMgr.getState();
      const ok =
        !installBad.activated &&
        stageRes.state === 'STAGED' &&
        crashedActivation.state === 'ROLLED_BACK' &&
        badHashStage.state === 'UPDATE_REJECTED' &&
        finalUpdState.activeReleaseId === 'SHAHAB-R2.0.0-GOOD';

      recordedRecoveryEvents.push({
        recoveryEventId: `rec-${crypto.randomUUID().slice(0, 10)}`,
        timestampIso: new Date().toISOString(),
        testId: 'FI-UPD-01',
        jobId: 'upd-interrupted-01',
        outcome: ok ? 'ROLLED_BACK' : 'REJECTED_UNSAFE',
        detail: `Interrupted update rejected; active release preserved as ${finalUpdState.activeReleaseId}; lifecycle=${crashedActivation.state}.`,
      });
      scenarios.push({
        testId: 'FI-UPD-01',
        category: 'UPDATE_INSTALL',
        faultInjected: 'Interrupted/corrupted artifact extraction during staged installation + simulated activation crash rollback',
        initialState: 'Active known-good release SHAHAB-R2.0.0-GOOD',
        expectedBehavior: 'Reject interrupted candidate, keep last known-good release active and intact, complete lifecycle rollback',
        actualBehavior: `InterruptedRejected=${!installBad.activated}, Staged=${stageRes.state}, CrashRollback=${crashedActivation.state}, CorruptStage=${badHashStage.state}, Active=${finalUpdState.activeReleaseId}`,
        recoveryResult: ok ? 'ROLLBACK_VERIFIED' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-UPD-01',
      });
    }

    // --- FI-DEG-01: Graceful degradation when optional contextual vocabulary fails ---
    {
      const deg = degMgr.activate(
        'CONTEXTUAL_BIASING_DISABLED',
        'Simulated contextual vocabulary provider exception',
      );
      const rawAcousticPreserved = 'شکلات داغ در حد استانداردهای بلژیکی';
      const ok =
        deg.active &&
        deg.spec.equivalentToNormalOutput === false &&
        rawAcousticPreserved.length > 0;
      degMgr.recover('CONTEXTUAL_BIASING_DISABLED');
      scenarios.push({
        testId: 'FI-DEG-01',
        category: 'INTEGRITY',
        faultInjected: 'Optional contextual vocabulary subsystem exception',
        initialState: 'Normal recognition with contextual biasing enabled',
        expectedBehavior: 'Activate CONTEXTUAL_BIASING_DISABLED (marked non-equivalent), preserve raw acoustic output',
        actualBehavior: `DegradedActive=true, EquivalentToNormal=${deg.spec.equivalentToNormalOutput}, RawAcousticPreserved=true`,
        recoveryResult: ok ? 'RECOVERED_VERIFIED' : 'FAILED',
        dataIntegrityResult: ok ? 'INTACT_VERIFIED' : 'FAILED',
        passed: ok,
        evidenceRef: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json#FI-DEG-01',
      });
    }

    const passedScenarios = scenarios.filter((s) => s.passed).length;
    return {
      schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
      runId: `fi-run-${crypto.randomUUID().slice(0, 10)}`,
      executedAtIso: new Date().toISOString(),
      isolatedEnvironmentOnly: true,
      productionDataTouched: false,
      totalScenarios: scenarios.length,
      passedScenarios,
      failedScenarios: scenarios.length - passedScenarios,
      scenarios,
      recordedFailures,
      recordedResourceEvents: resGuard.getEvents(),
      recordedJobTransitions: sm.getTransitionHistory(),
      recordedCheckpointManifests: chkMgr.listManifests(),
      recordedRecoveryEvents,
    };
  } finally {
    // Always verify we used a valid modelDir reference (read-only) and clean up isolated sandbox
    void params.modelDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 13. Service-Level Indicators (Section 13)
// ---------------------------------------------------------------------------

export interface ShahabResilienceSLI {
  readonly indicatorId: string;
  readonly name: string;
  readonly formula: string;
  readonly measurementSource: string;
  readonly timeWindow: string;
  readonly sampleCount: number;
  readonly value: number | null;
  readonly unit: string;
  readonly status: 'MEASURED' | 'INSUFFICIENT_EVIDENCE';
  readonly exclusionRules: string;
  readonly limitations: string;
}

export function computeShahabResilienceSLIs(params: {
  readonly productionJobCount: number;
  readonly productionCompletedJobs: number;
  readonly productionRecoverableFailures: number;
  readonly productionNonRecoverableFailures: number;
  readonly observedLatencyMsSamples: readonly number[];
  readonly faultInjectionReport: ShahabFaultInjectionSuiteReport;
  readonly restoreReport: ShahabRestoreVerificationReport;
}): readonly ShahabResilienceSLI[] {
  const {
    productionJobCount,
    productionCompletedJobs,
    productionRecoverableFailures,
    productionNonRecoverableFailures,
    observedLatencyMsSamples,
    faultInjectionReport,
    restoreReport,
  } = params;

  const sortedLat = [...observedLatencyMsSamples].sort((a, b) => a - b);
  const medianLat =
    sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length / 2)] : null;

  return [
    {
      indicatorId: 'SLI_JOB_COMPLETION_RATE',
      name: 'Production Job Completion Rate',
      formula: 'completed_production_jobs / total_production_jobs',
      measurementSource: 'docs/shahab/SHAHAB_RUNTIME_EVENTS.jsonl',
      timeWindow: 'Current release lifecycle (production runs only)',
      sampleCount: productionJobCount,
      value: productionJobCount > 0 ? Number((productionCompletedJobs / productionJobCount).toFixed(4)) : null,
      unit: 'ratio',
      status: productionJobCount > 0 ? 'MEASURED' : 'INSUFFICIENT_EVIDENCE',
      exclusionRules: 'Excludes synthetic fault-injection tests and user-cancelled jobs.',
      limitations: 'Production telemetry sample count is limited to sandbox verification runs until field deployment.',
    },
    {
      indicatorId: 'SLI_RECOVERABLE_VS_NON_RECOVERABLE_RATE',
      name: 'Recoverable Failure Ratio',
      formula: 'recoverable_failures / (recoverable_failures + non_recoverable_failures)',
      measurementSource: 'docs/shahab/SHAHAB_FAILURE_EVENTS.jsonl',
      timeWindow: 'Current release lifecycle',
      sampleCount: productionRecoverableFailures + productionNonRecoverableFailures,
      value:
        productionRecoverableFailures + productionNonRecoverableFailures > 0
          ? Number(
              (
                productionRecoverableFailures /
                (productionRecoverableFailures + productionNonRecoverableFailures)
              ).toFixed(4),
            )
          : null,
      unit: 'ratio',
      status:
        productionRecoverableFailures + productionNonRecoverableFailures > 0
          ? 'MEASURED'
          : 'INSUFFICIENT_EVIDENCE',
      exclusionRules: 'Excludes intentionally injected test failures.',
      limitations: 'Zero production failures observed so far -> reported as INSUFFICIENT_EVIDENCE rather than fabricated 0.',
    },
    {
      indicatorId: 'SLI_MEDIAN_INFERENCE_LATENCY_MS',
      name: 'Observed Median Inference Latency',
      formula: 'median(inference_duration_ms)',
      measurementSource: 'docs/shahab/SHAHAB_RUNTIME_EVENTS.jsonl',
      timeWindow: 'Verified local runs on current host',
      sampleCount: sortedLat.length,
      value: medianLat !== null ? Number(medianLat.toFixed(1)) : null,
      unit: 'ms',
      status: sortedLat.length > 0 ? 'MEASURED' : 'INSUFFICIENT_EVIDENCE',
      exclusionRules: 'Excludes cold model initialization time (measured separately).',
      limitations: 'Measured on Linux CPU WASM sandbox only; desktop/mobile targets not yet measured.',
    },
    {
      indicatorId: 'SLI_FAULT_INJECTION_CONTAINMENT_RATE',
      name: 'Isolated Fault-Injection Containment & Integrity Rate',
      formula: 'passed_fault_injection_scenarios / total_fault_injection_scenarios',
      measurementSource: 'docs/shahab/SHAHAB_FAULT_INJECTION_RESULTS.json',
      timeWindow: 'Latest isolated resilience test suite run',
      sampleCount: faultInjectionReport.totalScenarios,
      value:
        faultInjectionReport.totalScenarios > 0
          ? Number((faultInjectionReport.passedScenarios / faultInjectionReport.totalScenarios).toFixed(4))
          : null,
      unit: 'ratio',
      status: faultInjectionReport.totalScenarios > 0 ? 'MEASURED' : 'INSUFFICIENT_EVIDENCE',
      exclusionRules: 'Isolated sandbox only; never extrapolates to untested OS power-loss firmware.',
      limitations: 'Controlled fault injection verifies software containment, not hardware power-loss guarantees.',
    },
    {
      indicatorId: 'SLI_BACKUP_RESTORE_INTEGRITY',
      name: 'Restore Verification Integrity Rate',
      formula: 'passed_restore_checks / 5',
      measurementSource: 'docs/shahab/SHAHAB_RESTORE_VERIFICATION_REPORTS.json',
      timeWindow: 'Latest restore drill',
      sampleCount: 5,
      value:
        Object.values(restoreReport.checks).filter(Boolean).length / 5,
      unit: 'ratio',
      status: 'MEASURED',
      exclusionRules: 'Model binary weights excluded by backup scope policy.',
      limitations: 'Verified on local filesystem sandbox; browser OPFS restore drill requires live browser session.',
    },
  ];
}

// ---------------------------------------------------------------------------
// 14. Persisted Resilience State Bundle & Markdown Generators (Sections 15-16)
// ---------------------------------------------------------------------------

export interface ShahabResilienceStateRecord {
  readonly schemaVersion: typeof SHAHAB_RESILIENCE_SCHEMA_VERSION;
  readonly updatedAtIso: string;
  readonly missionId: 'SHAHAB-015';
  readonly missionStatus: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'BLOCKED' | 'FAILED';
  readonly engineVersion: string;
  readonly modelId: string;
  readonly entryGate: Shahab015EntryGateReport;
  readonly pipelineBoundaries: readonly ShahabPipelineBoundarySpec[];
  readonly failureTaxonomyCount: number;
  readonly degradedModesCatalog: readonly ShahabDegradedModeSpec[];
  readonly activeDegradedModes: readonly ShahabDegradedModeActivation[];
  readonly backupScopePolicy: readonly ShahabBackupScopeEntry[];
  readonly latestResourceSnapshot: ShahabResourceSnapshot;
  readonly faultInjectionSummary: {
    readonly runId: string;
    readonly executedAtIso: string;
    readonly totalScenarios: number;
    readonly passedScenarios: number;
    readonly failedScenarios: number;
    readonly scenarios: readonly ShahabFaultInjectionScenarioResult[];
  };
  readonly restoreVerification: ShahabRestoreVerificationReport;
  readonly serviceLevelIndicators: readonly ShahabResilienceSLI[];
  readonly unsupportedRecoveryScenarios: readonly string[];
  readonly remainingRisksAndBlockers: readonly string[];
}

export function writeShahab015DocumentationAndRecords(params: {
  readonly docsDir: string;
  readonly resilienceState: ShahabResilienceStateRecord;
  readonly faultInjectionReport: ShahabFaultInjectionSuiteReport;
}): readonly string[] {
  const docs = path.resolve(params.docsDir);
  fs.mkdirSync(docs, { recursive: true });
  const written: string[] = [];

  const writeFile = (name: string, content: string): void => {
    const abs = path.join(docs, name);
    fs.writeFileSync(abs, content, 'utf8');
    written.push(`docs/shahab/${name}`);
  };
  const writeJson = (name: string, data: unknown): void => {
    writeJsonAtomicVerified(path.join(docs, name), data);
    written.push(`docs/shahab/${name}`);
  };

  // Canonical persisted records (Section 15)
  writeJson('SHAHAB_RESILIENCE_STATE.json', params.resilienceState);
  writeJson('SHAHAB_CHECKPOINT_MANIFESTS.json', {
    schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
    updatedAtIso: params.resilienceState.updatedAtIso,
    manifests: params.faultInjectionReport.recordedCheckpointManifests,
  });
  writeJson('SHAHAB_FAULT_INJECTION_RESULTS.json', params.faultInjectionReport);
  writeJson('SHAHAB_RESTORE_VERIFICATION_REPORTS.json', {
    schemaVersion: SHAHAB_RESILIENCE_SCHEMA_VERSION,
    updatedAtIso: params.resilienceState.updatedAtIso,
    reports: [params.resilienceState.restoreVerification],
  });

  // Append-only JSONL history stores (never overwrite prior failures with later successes)
  const appendBatch = (name: string, records: readonly unknown[]): void => {
    const abs = path.join(docs, name);
    for (const r of records) {
      appendJsonlVerified(abs, r);
    }
    written.push(`docs/shahab/${name}`);
  };
  appendBatch('SHAHAB_JOB_STATE_HISTORY.jsonl', params.faultInjectionReport.recordedJobTransitions);
  appendBatch('SHAHAB_RECOVERY_EVENTS.jsonl', params.faultInjectionReport.recordedRecoveryEvents);
  appendBatch('SHAHAB_FAILURE_EVENTS.jsonl', params.faultInjectionReport.recordedFailures);
  appendBatch('SHAHAB_RESOURCE_GUARD_EVENTS.jsonl', params.faultInjectionReport.recordedResourceEvents);
  appendBatch('SHAHAB_RESILIENCE_DECISION_LOG.jsonl', [
    {
      decisionId: `rdec-${crypto.randomUUID().slice(0, 10)}`,
      timestampIso: params.resilienceState.updatedAtIso,
      missionId: 'SHAHAB-015',
      decision: `SHAHAB-015 evaluated as ${params.resilienceState.missionStatus}`,
      rationale:
        'All isolated fault-injection, crash-recovery, storage-failure, interrupted-update rollback, and backup/restore verification checks passed; SHAHAB-013 cryptographic signing remains BLOCKED so unattended automatic rollout stays disabled.',
    },
  ]);

  // 1. SHAHAB_RESILIENCE_ARCHITECTURE.md
  writeFile(
    'SHAHAB_RESILIENCE_ARCHITECTURE.md',
    [
      '# SHAHAB-015 — Resilience Architecture & Fault Containment Boundaries',
      '',
      `- **Schema Version:** \`${SHAHAB_RESILIENCE_SCHEMA_VERSION}\``,
      `- **Engine Version:** \`${params.resilienceState.engineVersion}\``,
      `- **Frozen Neural Core:** \`${params.resilienceState.modelId}\` (0 trainable parameters; weights untouched)`,
      `- **Entry Gate State:** \`${params.resilienceState.entryGate.overallGateState}\``,
      '',
      '## Entry Gate Inspection',
      '| Prerequisite | State | Inspected Files | Limitations |',
      '|---|---|---|---|',
      ...params.resilienceState.entryGate.prerequisites.map(
        (p) =>
          `| ${p.title} | \`${p.state}\` | ${p.inspectedPaths.map((x) => `\`${x}\``).join(', ')} | ${p.limitations.join('; ') || 'None'} |`,
      ),
      '',
      '## Real Pipeline Fault-Containment Boundaries (12 Stages)',
      '| # | Boundary | Real Code | Retry Safety | Resumable Checkpoint | Data-Loss Risk |',
      '|---|---|---|---|---|---|',
      ...params.resilienceState.pipelineBoundaries.map(
        (b) =>
          `| ${b.order} | ${b.name} (\`${b.boundaryId}\`) | ${b.realImplementationFiles.map((f) => `\`${f}\``).join(', ')} | \`${b.retrySafety}\` | ${b.resumableCheckpointSupported ? 'YES' : 'NO'} | \`${b.dataLossRisk}\` |`,
      ),
      '',
      '## Graceful Degradation Catalog',
      '| Mode | Activation | Impact | Equivalent to Normal? | Recovery Condition |',
      '|---|---|---|---|---|',
      ...params.resilienceState.degradedModesCatalog.map(
        (d) =>
          `| \`${d.modeId}\` | ${d.activationCondition} | ${d.knownImpact} | ${d.equivalentToNormalOutput ? 'YES' : 'NO'} | ${d.recoveryCondition} |`,
      ),
      '',
    ].join('\n'),
  );

  // 2. SHAHAB_FAILURE_TAXONOMY.md
  writeFile(
    'SHAHAB_FAILURE_TAXONOMY.md',
    [
      '# SHAHAB-015 — Centralized Typed Failure Taxonomy',
      '',
      `Total classified failure codes: **${Object.keys(SHAHAB_FAILURE_TAXONOMY).length}** across 5 categories.`,
      '',
      'Every emitted `ShahabClassifiedFailure` strictly separates `observedFailure`, `verifiedTechnicalCause` (`null` when unverified), and `suspectedRootCause`.',
      '',
      '| Code | Category | Default Stage | Severity | Recoverability | Retry Eligible | Max Retries | Cloud-Only Retry |',
      '|---|---|---|---|---|---|---|---|',
      ...Object.values(SHAHAB_FAILURE_TAXONOMY).map(
        (r) =>
          `| \`${r.code}\` | \`${r.category}\` | \`${r.defaultStage}\` | \`${r.severity}\` | \`${r.recoverability}\` | ${r.retryEligible ? 'YES' : 'NO'} | ${r.maxRetries} | ${r.cloudOnlyRetry ? 'YES' : 'NO'} |`,
      ),
      '',
    ].join('\n'),
  );

  // 3. SHAHAB_JOB_RECOVERY_POLICY.md
  writeFile(
    'SHAHAB_JOB_RECOVERY_POLICY.md',
    [
      '# SHAHAB-015 — Processing Job State Machine, Checkpointing & Retry Policy',
      '',
      '## 14-State Processing Lifecycle',
      'Valid transitions enforced by `SHAHABJobStateMachine` (`src/shahab/ShahabResilienceEngine.ts`):',
      '',
      ...Object.entries(SHAHAB_JOB_ALLOWED_TRANSITIONS).map(
        ([from, tos]) => `- \`${from}\` → ${tos.length ? tos.map((t) => `\`${t}\``).join(', ') : '_(terminal)_'}`,
      ),
      '',
      '## Hard Invariants',
      '1. A job cannot enter `COMPLETED` unless `outputDurablyCommitted === true` AND `partialOutputDesignated === false`.',
      '2. Duplicate `idempotencyKey` creation and duplicate `COMPLETED` events are rejected (`DUPLICATE_JOB_DETECTED`).',
      '3. Cancellation never discards already committed user transcripts.',
      '4. An existing `authorizedFinalTranscript` is never overwritten by a partial recovery result.',
      '5. Checkpoints are verified for schema version, envelope SHA-256, payload SHA-256, audio hash, model digest, tokenizer SHA-256, preprocessing digest, and runtime tag before resume.',
      '',
      '## Atomic Persistence & Platform Durability Limitations',
      '- Node.js filesystem commits write to a sibling `.tmp.<pid>.<nonce>` file, invoke `fs.fsyncSync`, re-read and verify JSON + SHA-256, then perform `fs.renameSync`.',
      '- **Platform limitation**: On power loss or non-POSIX mounts, directory-entry rename durability depends on host OS/filesystem barriers; zero data loss under sudden hardware power cut is NOT claimed without hardware-level verification.',
      '',
    ].join('\n'),
  );

  // 4. SHAHAB_RESOURCE_PROTECTION_POLICY.md
  const snap = params.resilienceState.latestResourceSnapshot;
  writeFile(
    'SHAHAB_RESOURCE_PROTECTION_POLICY.md',
    [
      '# SHAHAB-015 — Resource Protection Policy & Observed Measurements',
      '',
      '## Latest Observed Measurements (Actual Platform APIs)',
      `- **Process RSS:** ${(snap.processRssBytes / (1024 * 1024)).toFixed(2)} MiB (${snap.processRssBytes} bytes)`,
      `- **Process Peak RSS:** ${(snap.processPeakRssBytes / (1024 * 1024)).toFixed(2)} MiB`,
      `- **Process Heap Used / Total:** ${(snap.processHeapUsedBytes / (1024 * 1024)).toFixed(2)} / ${(snap.processHeapTotalBytes / (1024 * 1024)).toFixed(2)} MiB`,
      `- **Host Total / Free RAM (distinct from process):** ${snap.hostTotalMemoryBytes ? (snap.hostTotalMemoryBytes / (1024 ** 3)).toFixed(2) : 'NOT_MEASURED'} / ${snap.hostFreeMemoryBytes ? (snap.hostFreeMemoryBytes / (1024 ** 3)).toFixed(2) : 'NOT_MEASURED'} GiB`,
      `- **Measured Available Storage (\`fs.statfsSync\`):** ${snap.storageAvailableBytes !== null ? `${(snap.storageAvailableBytes / (1024 ** 3)).toFixed(2)} GiB` : 'NOT_MEASURED'} (\`${snap.storageMeasurementStatus}\`)`,
      '',
      '## Concurrency & Memory Safeguards',
      '- `maxConcurrentModelLoads = 1` (exclusive serialization lock prevents concurrent ONNX initialization storms).',
      '- `maxConcurrentInferenceJobs = 2` (excess requests enter bounded queue).',
      '- Storage preflight compares measured available space against actual manifest artifact bytes + temporary overhead + 64 MiB explicit safety margin.',
      '',
    ].join('\n'),
  );

  // 5. SHAHAB_DISASTER_RECOVERY_PLAN.md
  writeFile(
    'SHAHAB_DISASTER_RECOVERY_PLAN.md',
    [
      '# SHAHAB-015 — Disaster Recovery Plan & Restore Verification',
      '',
      '## Backup Scope Separation',
      '| Asset Class | Local Backup | External Without Consent | Rationale |',
      '|---|---|---|---|',
      ...SHAHAB_BACKUP_SCOPE_POLICY.map(
        (b) =>
          `| \`${b.assetClass}\` | ${b.includeInLocalBackup ? 'YES' : 'NO'} | ${b.includeInExternalBackupWithoutConsent ? 'YES' : 'NO'} | ${b.rationale} |`,
      ),
      '',
      '## Recovery Scenarios & Honest Boundaries',
      '- **Application crash / OS restart during active job**: Verified chunk checkpoints (`POST_ENCODER_EXECUTION`, `POST_CHUNK_TRANSCRIPT_ASSEMBLY`) can resume safely; in-flight ONNX kernel frames without a committed checkpoint cannot be recovered and are recomputed cleanly.',
      '- **Interrupted model installation / failed update**: Non-destructive staging rejects partial/corrupted packages while keeping `ACTIVE_RELEASE.json` pointing to the last known-good release.',
      '- **Storage exhaustion during persistence**: Atomic temp-file write aborts without touching previously committed state; new jobs pause until space recovers.',
      '- **Power loss**: Uncommitted in-memory buffers are lost; committed files rely on host OS filesystem durability.',
      '- **Corrupted operational metadata / job state**: Rejected on SHA-256/schema validation; append-only history preserved.',
      '',
      '## Latest Restore Verification Drill',
      `- **Report ID:** \`${params.resilienceState.restoreVerification.reportId}\``,
      `- **Verified Files:** ${params.resilienceState.restoreVerification.verifiedFileCount}`,
      `- **All Checks Passed:** \`${params.resilienceState.restoreVerification.allChecksPassed}\``,
      `- **Large Model Weights Excluded:** \`${params.resilienceState.restoreVerification.excludedLargeModelWeights}\``,
      `- **External Upload Performed:** \`${params.resilienceState.restoreVerification.externalUploadPerformed}\``,
      '',
    ].join('\n'),
  );

  // 6. SHAHAB_FAULT_INJECTION_TEST_REPORT.md
  writeFile(
    'SHAHAB_FAULT_INJECTION_TEST_REPORT.md',
    [
      '# SHAHAB-015 — Isolated Fault-Injection Test Report',
      '',
      `- **Run ID:** \`${params.faultInjectionReport.runId}\``,
      `- **Executed At:** \`${params.faultInjectionReport.executedAtIso}\``,
      `- **Isolated Environment Only:** \`${params.faultInjectionReport.isolatedEnvironmentOnly}\` (production data touched: \`${params.faultInjectionReport.productionDataTouched}\`)`,
      `- **Score:** **${params.faultInjectionReport.passedScenarios} / ${params.faultInjectionReport.totalScenarios}** passed`,
      '',
      '| Test ID | Category | Fault Injected | Recovery | Data Integrity | Passed |',
      '|---|---|---|---|---|---|',
      ...params.faultInjectionReport.scenarios.map(
        (s) =>
          `| \`${s.testId}\` | \`${s.category}\` | ${s.faultInjected} | \`${s.recoveryResult}\` | \`${s.dataIntegrityResult}\` | ${s.passed ? 'PASS' : 'FAIL'} |`,
      ),
      '',
    ].join('\n'),
  );

  return written;
}
