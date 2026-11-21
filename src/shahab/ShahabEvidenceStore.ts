/**
 * SHAHAB-002 — Evidence-First Persistent State & Append-Only JSONL Ledger Service
 *
 * Source of truth shared between:
 * - Build / mission / benchmark / acquisition scripts
 * - Express API routes (`/api/shahab/*`)
 * - Visible `SHAHAB LAB` dashboard inside Avapardaz
 *
 * Enforced Safety Invariants:
 * 1. Append-only ledger (`docs/shahab/SHAHAB_EVIDENCE_LEDGER.jsonl`): historical events
 *    are NEVER overwritten or deleted. Corrections append a new event with `supersedesEventId`.
 * 2. Atomic state persistence (`docs/shahab/SHAHAB_IMPLEMENTATION_STATE.json`): writes to
 *    temporary file and renames atomically to survive crashes and page reloads.
 * 3. Validation gates:
 *    - Rejects invalid download progress (`<0`, `>100`, `downloadedBytes > expectedBytes`)
 *    - Rejects `VERIFIED` integrity status when checksum failed
 *    - Rejects successful benchmark status when benchmark failed
 *    - Preserves `NOT_MEASURED` for unknown metrics
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeValidatedDownloadPercent,
  SHAHAB_PROGRAM_VERSION,
  SHAHAB_STATE_SCHEMA_VERSION,
  ShahabArtifactTransferRecord,
  ShahabBenchmarkRecord,
  ShahabEvidenceEvent,
  ShahabEvidenceStatus,
  ShahabHardwareEnvironment,
  ShahabImplementationState,
  ShahabMissionId,
  ShahabMissionRecord,
  ShahabPhaseStatus,
  ShahabTrackKey,
} from './ShahabContracts';

export interface ShahabEvidenceStorePaths {
  readonly rootDir: string;
  readonly stateFilePath: string;
  readonly ledgerFilePath: string;
}

export function resolveShahabStorePaths(baseDir?: string): ShahabEvidenceStorePaths {
  const rootDir = path.resolve(baseDir ?? path.join(process.cwd(), 'docs', 'shahab'));
  return {
    rootDir,
    stateFilePath: path.join(rootDir, 'SHAHAB_IMPLEMENTATION_STATE.json'),
    ledgerFilePath: path.join(rootDir, 'SHAHAB_EVIDENCE_LEDGER.jsonl'),
  };
}

export function createInitialMissionMap(): Record<ShahabMissionId, ShahabMissionRecord> {
  const defs: readonly [ShahabMissionId, string, number][] = [
    ['SHAHAB-001', 'Project Discovery and Implementation State', 6],
    ['SHAHAB-002', 'SHAHAB LAB — Live Engine Status and Evidence Dashboard', 7],
    ['SHAHAB-003', 'Remote Model Intelligence and Lazy Repository Access', 7],
    ['SHAHAB-004', 'Single-Model Selection and Verified Artifact Acquisition', 7],
    ['SHAHAB-005', 'Frozen Neural Core and First Real Inference', 7],
    ['SHAHAB-006', 'Acoustic State Reuse and Recurrent Decoding Feasibility', 6],
    ['SHAHAB-007', 'Adaptive Decoding and Selective Recognition', 6],
    ['SHAHAB-008', 'Persian Context Memory, Evidence Ledger and Selective Risk Control', 7],
    ['SHAHAB-009', 'Model Surgery, Quantization and Hard Size Optimization', 7],
    ['SHAHAB-010', 'Unified Engine Integration, Local/Cloud Execution and Release Candidate', 8],
    ['SHAHAB-011', 'Real-World Validation, Error Intelligence and Neural Independence Decision', 7],
    ['SHAHAB-012', 'Neural Knowledge Transfer and Proprietary Checkpoint Development', 6],
    ['SHAHAB-013', 'Neural Artifact Hardening, Reproducible Packaging and Release Verification', 8],
    ['SHAHAB-014', 'Production Observability, Safe Model Lifecycle and Human Feedback Governance', 8],
    ['SHAHAB-015', 'Fault Tolerance, Resilience Engineering, Disaster Recovery and Operational Continuity', 8],
    ['SHAHAB-016', 'Performance Engineering, Bottleneck Forensics and Evidence-Driven Optimization', 8],
    ['SHAHAB-017', 'True Streaming Inference, Incremental Audio Processing and State-Consistent Output', 8],
    ['SHAHAB-018', 'Cross-Platform Runtime Architecture, Capability Negotiation and Runtime Conformance', 8],
    ['SHAHAB-019', 'Persian Acoustic Fidelity, Linguistic Error Intelligence and Verbatim Preservation', 8],
    ['SHAHAB-020', 'Compact Model Research, Package Footprint Analysis and Active-Model Protection', 7],
    ['SHAHAB-021', 'Integrated System Qualification, Cross-Mission Validation and Release Readiness', 10],
    ['SHAHAB-022', 'Stable Engine SDK, Versioned API Contract and Host-Neutral Integration Boundary', 10],
    ['SHAHAB-023', 'Avapardaz Native Integration, Timeline-Aware Transcription and Non-Destructive Editing Workflow', 10],
    ['SHAHAB-024', 'Adobe Audition Integration, Official Extensibility Research and Host Adapter Engineering', 10],
  ];
  const map = {} as Record<ShahabMissionId, ShahabMissionRecord>;
  for (const [missionId, title, totalTaskCount] of defs) {
    map[missionId] = {
      missionId,
      title,
      status: 'NOT_STARTED',
      verifiedTaskCount: 0,
      totalTaskCount,
      startedAtUtc: null,
      verifiedAtUtc: null,
      acceptancePassed: null,
      blockers: [],
    };
  }
  return map;
}

export function createInitialTrackMap(): Record<ShahabTrackKey, ShahabPhaseStatus> {
  return {
    repository_inspection: 'NOT_STARTED',
    model_selection: 'NOT_STARTED',
    artifact_acquisition: 'NOT_STARTED',
    model_verification: 'NOT_STARTED',
    baseline_inference: 'NOT_STARTED',
    runtime_implementation: 'NOT_STARTED',
    decoder_implementation: 'NOT_STARTED',
    cache_implementation: 'NOT_STARTED',
    persian_context_memory: 'NOT_STARTED',
    quantization: 'NOT_STARTED',
    benchmarking: 'NOT_STARTED',
    local_cloud_integration: 'NOT_STARTED',
  };
}

export function createBlankImplementationState(
  hardwareEnvironment: ShahabHardwareEnvironment,
  nowUtc = new Date().toISOString(),
): ShahabImplementationState {
  const notMeasuredMetric = <T,>(unit: string, method: string): {
    readonly value: T | null;
    readonly unit: string;
    readonly method: string;
    readonly source: string;
    readonly timestampUtc: string;
    readonly environment: string;
    readonly status: ShahabEvidenceStatus;
  } => ({
    value: null,
    unit,
    method,
    source: 'unmeasured',
    timestampUtc: nowUtc,
    environment: `${hardwareEnvironment.osPrettyName} (${hardwareEnvironment.cpuArch})`,
    status: 'NOT_MEASURED',
  });

  return {
    schemaVersion: SHAHAB_STATE_SCHEMA_VERSION,
    programVersion: SHAHAB_PROGRAM_VERSION,
    productName: 'SHAHAB — Avapardaz Native Speech Recognition Engine',
    releaseId: null,
    currentMissionId: 'SHAHAB-001',
    currentPhase: 'Project Discovery and Implementation State',
    currentTask: 'Initialized baseline state',
    lastVerifiedEventId: null,
    lastUpdatedUtc: nowUtc,
    hardwareEnvironment,
    missions: createInitialMissionMap(),
    developmentTracks: createInitialTrackMap(),
    selectedModel: {
      modelId: null,
      displayName: null,
      modelFamily: null,
      architecture: null,
      upstreamRepository: null,
      immutableRevisionSha: null,
      licenseSpdx: null,
      licenseStatus: 'NOT_MEASURED',
      inputConfiguration: null,
      tokenizer: null,
      inferenceRuntime: null,
      weightImmutabilityVerified: false,
      modelLoadedStatus: 'NOT_LOADED',
      selectionDecisionRef: null,
    },
    candidateModels: [],
    thirdPartyReuseInventory: [],
    artifactInventory: [],
    parameterSummary: {
      publisherReportedParameters: notMeasuredMetric<number | string>('parameters', 'upstream_model_card'),
      independentlyParsedElements: notMeasuredMetric<number>('elements', 'onnx_initializer_parse'),
      verifiedParameterCount: notMeasuredMetric<number>('parameters', 'independent_checkpoint_verification'),
      trainableParameters: {
        value: 0,
        unit: 'parameters',
        method: 'frozen_inherited_core_policy',
        source: 'SHAHAB-PROGRAM-000 §7',
        timestampUtc: nowUtc,
        environment: `${hardwareEnvironment.osPrettyName} (${hardwareEnvironment.cpuArch})`,
        status: 'VERIFIED',
        note: 'Frozen inherited pretrained neural weights; zero gradient-based training.',
      },
      frozenParameters: notMeasuredMetric<number>('elements', 'onnx_initializer_parse'),
      parameterStorageBytes: notMeasuredMetric<number>('bytes', 'onnx_initializer_parse'),
      totalTensorCount: null,
      uniqueTensorCount: null,
      duplicateTensorCount: null,
      quantizedTensorCount: null,
      nonQuantizedTensorCount: null,
      externalDataTensorCount: null,
      dtypeDistribution: {},
      countingMethodology: 'NOT_MEASURED',
      graphs: [],
    },
    sizeBreakdown: {
      remoteRepositoryBytes: notMeasuredMetric<number>('bytes', 'remote_repo_manifest'),
      selectedMandatoryPackageBytes: notMeasuredMetric<number>('bytes', 'local_fs_stat'),
      localModelStoreBytes: notMeasuredMetric<number>('bytes', 'local_fs_stat'),
      installedPackageBytes: notMeasuredMetric<number>('bytes', 'local_fs_stat'),
      quantizedModelWeightsBytes: notMeasuredMetric<number>('bytes', 'local_fs_stat'),
      runtimeDependenciesBytes: notMeasuredMetric<number>('bytes', 'local_fs_stat'),
      downloadArchiveBytes: notMeasuredMetric<number>('bytes', 'gzip_archive_measure'),
      residentMemoryAfterLoadBytes: notMeasuredMetric<number>('bytes', 'process_rss_delta'),
      below100MiBVerified: false,
      below100MiBNote: 'NOT_MEASURED',
    },
    benchmarks: [],
    cacheExperiment: {
      status: 'NOT_STARTED',
      encoderReuseFeasible: null,
      feasibilityProofNote: 'NOT_MEASURED',
      numericalMaxAbsDiff: null,
      transcriptIdentical: null,
      measuredAtUtc: null,
      scenarios: [],
      measuredTimeSavedMs: null,
      measuredEncoderCallsAvoided: null,
      cacheMemoryOverheadBytes: null,
    },
    adaptiveDecoding: {
      status: 'NOT_STARTED',
      activePolicy: 'BALANCED',
      policyComparisons: [],
    },
    persianContext: {
      status: 'NOT_STARTED',
      verifiedProjectTermsCount: 0,
      verifiedDomainTermsCount: 0,
      unverifiedCandidatesCount: 0,
      contextualTermsAppliedCount: 0,
      targetTermRecoveryRate: null,
      falseInsertionRate: null,
      incorrectSubstitutionRate: null,
      userConfirmedCorrectionsCount: 0,
      evidenceCompletenessStatus: 'NOT_MEASURED',
      unresolvedSegmentsCount: 0,
      terms: [],
    },
    optimizationVariants: [],
    realInferenceTestCount: 0,
    realInferencePassedCount: 0,
    testSummary: {
      status: 'NOT_STARTED',
      totalTests: null,
      passedTests: null,
      failedTests: null,
      lastRunUtc: null,
      command: null,
    },
    blockers: [],
  };
}

/**
 * Strict integrity guardrails for SHAHAB-002 §8.
 */
export function validateArtifactTransferRecord(record: ShahabArtifactTransferRecord): void {
  const computedPct = computeValidatedDownloadPercent(record.downloadedBytes, record.expectedBytes);
  if (record.expectedBytes === null && record.downloadPercent !== null) {
    throw new Error(
      `INVALID_DOWNLOAD_PROGRESS: Artifact ${record.relativePath} has unknown expectedBytes; downloadPercent must be null (indeterminate).`,
    );
  }
  if (
    record.expectedBytes !== null &&
    record.downloadPercent !== null &&
    Math.abs(record.downloadPercent - (computedPct ?? 0)) > 0.05
  ) {
    throw new Error(
      `INVALID_DOWNLOAD_PROGRESS: Artifact ${record.relativePath} reported ${record.downloadPercent}% but actual ratio is ${computedPct}%.`,
    );
  }
  if (record.integrityStatus === 'VERIFIED') {
    if (!record.sha256Actual || !record.sha256Expected) {
      throw new Error(
        `INTEGRITY_POLICY_VIOLATION: Artifact ${record.relativePath} cannot be VERIFIED without both expected and actual SHA-256 digests.`,
      );
    }
    if (record.sha256Actual.toLowerCase() !== record.sha256Expected.toLowerCase()) {
      throw new Error(
        `INTEGRITY_POLICY_VIOLATION: Artifact ${record.relativePath} failed SHA-256 verification and cannot produce VERIFIED status.`,
      );
    }
    if (record.expectedBytes !== null && record.downloadedBytes !== record.expectedBytes) {
      throw new Error(
        `INTEGRITY_POLICY_VIOLATION: Artifact ${record.relativePath} byte count mismatch (${record.downloadedBytes} != ${record.expectedBytes}).`,
      );
    }
  }
}

export function validateBenchmarkRecord(record: ShahabBenchmarkRecord): void {
  if (record.status === 'VERIFIED' || record.status === 'MEASURED') {
    if (!record.dataset || !record.hardware || !record.modelRevision || !record.runtimeVersion) {
      throw new Error(
        `BENCHMARK_PROVENANCE_ERROR: Benchmark ${record.benchmarkId} requires dataset, hardware, modelRevision, and runtimeVersion.`,
      );
    }
    if (record.audioDurationSec <= 0 || record.sampleCount <= 0) {
      throw new Error(
        `BENCHMARK_PROVENANCE_ERROR: Benchmark ${record.benchmarkId} must have positive audioDurationSec and sampleCount.`,
      );
    }
  }
  if (record.status === 'BLOCKED' || record.status === 'NOT_MEASURED') {
    if (record.wer !== null && record.wer < 0) {
      throw new Error(`INVALID_BENCHMARK_METRIC: Negative WER (${record.wer}) is invalid.`);
    }
  }
}

export class ShahabEvidenceStore {
  public readonly paths: ShahabEvidenceStorePaths;

  constructor(baseDir?: string) {
    this.paths = resolveShahabStorePaths(baseDir);
  }

  public ensureDirectory(): void {
    fs.mkdirSync(this.paths.rootDir, { recursive: true });
  }

  public exists(): boolean {
    return fs.existsSync(this.paths.stateFilePath);
  }

  public readState(): ShahabImplementationState | null {
    if (!fs.existsSync(this.paths.stateFilePath)) {
      return null;
    }
    const raw = fs.readFileSync(this.paths.stateFilePath, 'utf-8');
    return JSON.parse(raw) as ShahabImplementationState;
  }

  public writeStateAtomic(state: ShahabImplementationState): void {
    for (const art of state.artifactInventory) {
      validateArtifactTransferRecord(art);
    }
    for (const bm of state.benchmarks) {
      validateBenchmarkRecord(bm);
    }
    this.ensureDirectory();
    const tmpPath = `${this.paths.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, this.paths.stateFilePath);
  }

  public readEvents(limit?: number): ShahabEvidenceEvent[] {
    if (!fs.existsSync(this.paths.ledgerFilePath)) {
      return [];
    }
    const raw = fs.readFileSync(this.paths.ledgerFilePath, 'utf-8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const events: ShahabEvidenceEvent[] = [];
    for (const line of lines) {
      events.push(JSON.parse(line) as ShahabEvidenceEvent);
    }
    if (typeof limit === 'number' && limit > 0 && events.length > limit) {
      return events.slice(events.length - limit);
    }
    return events;
  }

  /**
   * Appends an immutable evidence record to `SHAHAB_EVIDENCE_LEDGER.jsonl`.
   * Rejects duplicate event IDs and forbids overwriting existing ledger lines.
   */
  public appendEvent(
    input: Omit<ShahabEvidenceEvent, 'eventId' | 'timestampUtc'> & {
      readonly eventId?: string;
      readonly timestampUtc?: string;
    },
  ): ShahabEvidenceEvent {
    const existing = this.readEvents();
    const eventId =
      input.eventId ??
      `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    if (existing.some((e) => e.eventId === eventId)) {
      throw new Error(
        `LEDGER_IMMUTABILITY_VIOLATION: Event ID "${eventId}" already exists; historical events cannot be overwritten.`,
      );
    }

    if (
      input.eventType === 'CHECKSUM_FAILED' &&
      input.verificationStatus === 'VERIFIED'
    ) {
      throw new Error(
        'INTEGRITY_POLICY_VIOLATION: A CHECKSUM_FAILED event cannot carry verificationStatus=VERIFIED.',
      );
    }
    if (
      input.eventType === 'BENCHMARK_FAILED' &&
      input.verificationStatus === 'VERIFIED'
    ) {
      throw new Error(
        'BENCHMARK_POLICY_VIOLATION: A BENCHMARK_FAILED event cannot carry verificationStatus=VERIFIED.',
      );
    }

    const event: ShahabEvidenceEvent = {
      eventId,
      timestampUtc: input.timestampUtc ?? new Date().toISOString(),
      missionId: input.missionId,
      taskId: input.taskId,
      eventType: input.eventType,
      oldValue: input.oldValue,
      newValue: input.newValue,
      measurementValue: input.measurementValue,
      measurementUnit: input.measurementUnit,
      measurementMethod: input.measurementMethod,
      evidenceSource: input.evidenceSource,
      artifactRef: input.artifactRef,
      modelRevision: input.modelRevision,
      sha256: input.sha256,
      environmentId: input.environmentId,
      verificationStatus: input.verificationStatus,
      supersedesEventId: input.supersedesEventId ?? null,
    };

    this.ensureDirectory();
    fs.appendFileSync(this.paths.ledgerFilePath, `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  }

  /**
   * Appends a correction event referencing an earlier event without mutating or deleting
   * the original historical record.
   */
  public appendCorrectionEvent(
    supersedesEventId: string,
    correction: Omit<ShahabEvidenceEvent, 'eventId' | 'timestampUtc' | 'supersedesEventId'>,
  ): ShahabEvidenceEvent {
    const existing = this.readEvents();
    if (!existing.some((e) => e.eventId === supersedesEventId)) {
      throw new Error(
        `LEDGER_CORRECTION_ERROR: Referenced event "${supersedesEventId}" does not exist in ledger.`,
      );
    }
    return this.appendEvent({
      ...correction,
      supersedesEventId,
    });
  }
}
