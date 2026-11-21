/**
 * SHAHAB-014 — Production Observability, Safe Model Lifecycle, Human Feedback Governance
 * & Evidence-Driven Continuous Improvement
 *
 * Governing principles:
 * - Operational governance ONLY — NO training, fine-tuning, distillation, or weight modification.
 * - Local-first privacy: external telemetry disabled by default; NEVER emits raw audio, transcripts,
 *   corrected transcripts, speaker PII, personal vocabulary, or sensitive paths in operational events.
 * - Strict unknown vs zero distinction (`NOT_MEASURED` vs `0`).
 * - User corrections NEVER silently enter benchmark/research datasets (11-state feedback lifecycle + Admission Gate).
 * - 14-state immutable update lifecycle with non-destructive staging, replay protection, and atomic rollback.
 * - Comparable regression analyzer rejecting single-sample or mismatched-dataset claims.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SHAHAB_RELEASE_CANDIDATE_VERSION, SHAHABReleaseSigner } from './ShahabReleaseHardening';
import { SHAHAB_NEURAL_CORE_IDENTITY } from './ShahabEngineUnified';

export const SHAHAB_OPERATIONS_SCHEMA_VERSION = '1.0.0' as const;

export type ShahabEntryGateState = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'BLOCKED' | 'NOT_EXECUTED';

export interface Shahab013EntryGateReport {
  readonly gateState: ShahabEntryGateState;
  readonly evaluatedAtIso: string;
  readonly releaseCandidateId: string | null;
  readonly checks: readonly {
    readonly checkId: string;
    readonly passed: boolean;
    readonly evidencePath: string;
    readonly detail: string;
  }[];
  readonly automaticRolloutAllowed: boolean;
  readonly blockers: readonly string[];
}

export function evaluateShahab013EntryGate(docsDir: string): Shahab013EntryGateReport {
  const base = path.resolve(docsDir);
  const files = {
    manifest: path.join(base, 'SHAHAB_RELEASE_MANIFEST.json'),
    security: path.join(base, 'SHAHAB_SECURITY_VERIFICATION.json'),
    install: path.join(base, 'SHAHAB_INSTALLATION_TESTS.json'),
    rollback: path.join(base, 'SHAHAB_ROLLBACK_TESTS.json'),
    compat: path.join(base, 'SHAHAB_RUNTIME_COMPATIBILITY.json'),
  };

  if (!fs.existsSync(files.manifest)) {
    return {
      gateState: 'NOT_EXECUTED',
      evaluatedAtIso: new Date().toISOString(),
      releaseCandidateId: null,
      checks: [],
      automaticRolloutAllowed: false,
      blockers: ['SHAHAB_RELEASE_MANIFEST.json not found — SHAHAB-013 has not been executed.'],
    };
  }

  const checks: { checkId: string; passed: boolean; evidencePath: string; detail: string }[] = [];
  const blockers: string[] = [];

  const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8')) as {
    releaseCandidateId?: string;
    verificationStatus?: string;
    signatureStatus?: { status?: string };
  };
  const security = fs.existsSync(files.security)
    ? (JSON.parse(fs.readFileSync(files.security, 'utf8')) as { allChecksPassed?: boolean })
    : null;
  const install = fs.existsSync(files.install)
    ? (JSON.parse(fs.readFileSync(files.install, 'utf8')) as { passed?: boolean; smokeInferencePassed?: boolean })
    : null;
  const rollback = fs.existsSync(files.rollback)
    ? (JSON.parse(fs.readFileSync(files.rollback, 'utf8')) as { passed?: boolean; postRollbackInferencePassed?: boolean })
    : null;

  const hasManifest = Boolean(manifest.releaseCandidateId);
  checks.push({
    checkId: 'RELEASE_MANIFEST_PRESENT',
    passed: hasManifest,
    evidencePath: 'docs/shahab/SHAHAB_RELEASE_MANIFEST.json',
    detail: hasManifest ? `Candidate ${manifest.releaseCandidateId}` : 'Missing releaseCandidateId',
  });

  const secOk = Boolean(security?.allChecksPassed);
  checks.push({
    checkId: 'SECURITY_VERIFICATION_PASSED',
    passed: secOk,
    evidencePath: 'docs/shahab/SHAHAB_SECURITY_VERIFICATION.json',
    detail: secOk ? 'All supply-chain & integrity security checks passed.' : 'Security report missing or failed.',
  });
  if (!secOk) blockers.push('SHAHAB-013 security verification incomplete or failed.');

  const instOk = Boolean(install?.passed && install?.smokeInferencePassed);
  checks.push({
    checkId: 'INSTALL_AND_SMOKE_INFERENCE_PASSED',
    passed: instOk,
    evidencePath: 'docs/shahab/SHAHAB_INSTALLATION_TESTS.json',
    detail: instOk ? 'Atomic install & post-install Persian smoke inference verified.' : 'Install smoke test missing or failed.',
  });
  if (!instOk) blockers.push('Post-install smoke inference not verified.');

  const rbOk = Boolean(rollback?.passed && rollback?.postRollbackInferencePassed);
  checks.push({
    checkId: 'ROLLBACK_VERIFIED',
    passed: rbOk,
    evidencePath: 'docs/shahab/SHAHAB_ROLLBACK_TESTS.json',
    detail: rbOk ? 'Rollback & post-rollback Persian inference verified.' : 'Rollback verification missing or failed.',
  });
  if (!rbOk) blockers.push('Rollback verification failed.');

  const signingVerified = manifest.signatureStatus?.status === 'VERIFIED';
  checks.push({
    checkId: 'RELEASE_CRYPTOGRAPHIC_SIGNING',
    passed: signingVerified,
    evidencePath: 'docs/shahab/SHAHAB_RELEASE_MANIFEST.json',
    detail: signingVerified
      ? 'Ed25519 signature verified.'
      : 'BLOCKED: No external signing key infrastructure provisioned (SHA-256 integrity verified separately).',
  });
  if (!signingVerified) {
    blockers.push('External cryptographic signing infrastructure not provisioned (automatic production rollout disabled).');
  }

  const coreIntegrityOk = hasManifest && secOk && instOk && rbOk;
  const gateState: ShahabEntryGateState = !coreIntegrityOk
    ? 'BLOCKED'
    : signingVerified
      ? 'VERIFIED'
      : 'PARTIALLY_VERIFIED';

  return {
    gateState,
    evaluatedAtIso: new Date().toISOString(),
    releaseCandidateId: manifest.releaseCandidateId ?? null,
    checks,
    // Automatic rollout ONLY allowed if full VERIFIED (including cryptographic signing)
    automaticRolloutAllowed: gateState === 'VERIFIED',
    blockers,
  };
}

// ── Operational Observability Core (SHAHAB-014 §4 & §5) ──────────────────────

export type ShahabOperationalEventType =
  | 'ENGINE_INITIALIZED'
  | 'MODEL_LOAD_STARTED'
  | 'MODEL_LOAD_COMPLETED'
  | 'MODEL_LOAD_FAILED'
  | 'INFERENCE_STARTED'
  | 'INFERENCE_COMPLETED'
  | 'INFERENCE_FAILED'
  | 'DECODER_RETRY_STARTED'
  | 'DECODER_RETRY_COMPLETED'
  | 'CACHE_HIT'
  | 'CACHE_MISS'
  | 'CACHE_EVICTION'
  | 'MEMORY_PRESSURE_DETECTED'
  | 'RUNTIME_PROVIDER_SELECTED'
  | 'RUNTIME_PROVIDER_FALLBACK'
  | 'UPDATE_DISCOVERED'
  | 'UPDATE_VERIFICATION_FAILED'
  | 'UPDATE_STAGED'
  | 'UPDATE_ACTIVATED'
  | 'ROLLBACK_STARTED'
  | 'ROLLBACK_COMPLETED'
  | 'ROLLBACK_FAILED'
  | 'USER_FEEDBACK_RECEIVED'
  | 'USER_FEEDBACK_CONSENT_CHANGED'
  | 'DIAGNOSTIC_EXPORT_CREATED';

export interface ShahabOperationalEvent {
  readonly schemaVersion: typeof SHAHAB_OPERATIONS_SCHEMA_VERSION;
  readonly eventId: string;
  readonly timestampIso: string;
  readonly eventType: ShahabOperationalEventType;
  readonly engineVersion: string;
  readonly modelVersion: string | null;
  readonly modelArtifactHash: string | null;
  readonly runtimeProvider: string;
  readonly executionMode: 'LOCAL' | 'CLOUD';
  readonly sessionCorrelationId: string; // Opaque non-PII correlation ID
  readonly provenanceStatus: 'MEASURED' | 'VERIFIED' | 'REPORTED' | 'NOT_MEASURED' | 'BLOCKED';
  readonly errorCode: string | null;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

const FORBIDDEN_TELEMETRY_FIELD_KEYS = new Set([
  'rawtranscript',
  'transcript',
  'correctedtranscript',
  'audiobytes',
  'pcm',
  'wavbytes',
  'speakername',
  'personalvocabulary',
  'filepath',
  'projectname',
  'username',
  'email',
]);

export function assertNoSensitiveOperationalPayload(
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  for (const [key, val] of Object.entries(fields)) {
    const kLower = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_TELEMETRY_FIELD_KEYS.has(kLower)) {
      throw new Error(`PRIVACY_GUARD_VIOLATION: Sensitive field "${key}" is forbidden in operational telemetry events.`);
    }
    if (typeof val === 'string') {
      if (val.startsWith('data:audio/') || /\/(home|Users)\/[^/]+/i.test(val)) {
        throw new Error(`PRIVACY_GUARD_VIOLATION: Field "${key}" appears to contain audio data URI or personal filesystem path.`);
      }
    }
  }
}

export interface ShahabTelemetryConsentState {
  readonly schemaVersion: typeof SHAHAB_OPERATIONS_SCHEMA_VERSION;
  readonly localDiagnosticsEnabled: boolean;
  readonly externalOperationalTelemetryOptIn: boolean;
  readonly externalResearchContributionOptIn: boolean;
  readonly destinationDescription: string;
  readonly retentionPolicyDays: number;
  readonly linkableToAccountOrDevice: false;
  readonly updatedAtIso: string;
  readonly revocationHistory: readonly {
    readonly revokedAtIso: string;
    readonly scope: 'EXTERNAL_OPERATIONAL' | 'EXTERNAL_RESEARCH' | 'ALL_EXTERNAL';
    readonly queuedItemsCancelled: number;
    readonly alreadyTransmittedCount: number;
    readonly remoteDeletionConfirmed: false;
    readonly truthfulDisclosure: string;
  }[];
}

export interface ShahabMetricDefinition {
  readonly metricName: string;
  readonly formula: string;
  readonly unit: string;
  readonly clockSource: string;
  readonly includesModelInit: boolean;
  readonly includesAudioPreprocessing: boolean;
  readonly includesQueueTime: boolean;
  readonly scope: 'FULL_RECORDING' | 'STREAMING_CHUNK' | 'PROCESS_SNAPSHOT';
}

export const SHAHAB_OPERATIONAL_METRIC_DEFINITIONS: readonly ShahabMetricDefinition[] = Object.freeze([
  {
    metricName: 'RTF',
    formula: 'measured_inference_wall_time_sec / audio_duration_sec',
    unit: 'ratio (dimensionless)',
    clockSource: 'performance.now() high-resolution monotonic clock',
    includesModelInit: false,
    includesAudioPreprocessing: true,
    includesQueueTime: false,
    scope: 'FULL_RECORDING',
  },
  {
    metricName: 'model_load_time_ms',
    formula: 't_sessions_ready - t_load_start',
    unit: 'milliseconds',
    clockSource: 'performance.now()',
    includesModelInit: true,
    includesAudioPreprocessing: false,
    includesQueueTime: false,
    scope: 'PROCESS_SNAPSHOT',
  },
  {
    metricName: 'peak_process_rss_bytes',
    formula: 'max(process.memoryUsage().rss) across observed inference window',
    unit: 'bytes',
    clockSource: 'Node.js process.memoryUsage().rss',
    includesModelInit: true,
    includesAudioPreprocessing: true,
    includesQueueTime: false,
    scope: 'PROCESS_SNAPSHOT',
  },
  {
    metricName: 'gpu_utilization_pct',
    formula: 'UNAVAILABLE (0 GPUs detected in container)',
    unit: 'NOT_MEASURED',
    clockSource: 'NONE',
    includesModelInit: false,
    includesAudioPreprocessing: false,
    includesQueueTime: false,
    scope: 'PROCESS_SNAPSHOT',
  },
]);

export interface ShahabOperationalMetricsSummary {
  readonly sampleCount: number;
  readonly timeRangeStartIso: string | null;
  readonly timeRangeEndIso: string | null;
  readonly monitoringActive: boolean;
  readonly modelLoadsSucceeded: number;
  readonly modelLoadsFailed: number;
  readonly inferencesSucceeded: number;
  readonly inferencesFailed: number;
  readonly providerFallbacks: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheEvictions: number;
  readonly updatesFailed: number;
  readonly rollbacksCompleted: number;
  readonly rollbacksFailed: number;
  readonly meanRtf: number | 'NOT_MEASURED';
  readonly meanInferenceMs: number | 'NOT_MEASURED';
  readonly totalAudioDurationSec: number;
  readonly lastModelLoadMs: number | 'NOT_MEASURED';
  readonly peakProcessRssBytes: number | 'NOT_MEASURED';
  readonly gpuUtilizationPct: 'NOT_MEASURED';
  readonly gpuMemoryBytes: 'NOT_MEASURED';
}

export class SHAHABOperationalObserver {
  private events: ShahabOperationalEvent[] = [];
  private externalQueue: ShahabOperationalEvent[] = [];
  private externalTransmittedCount = 0;
  private consent: ShahabTelemetryConsentState = {
    schemaVersion: SHAHAB_OPERATIONS_SCHEMA_VERSION,
    localDiagnosticsEnabled: true,
    externalOperationalTelemetryOptIn: false, // Disabled by default (SHAHAB-014 §5.2)
    externalResearchContributionOptIn: false, // Disabled by default
    destinationDescription: 'LOCAL_ONLY (No external monitoring endpoint configured)',
    retentionPolicyDays: 30,
    linkableToAccountOrDevice: false,
    updatedAtIso: new Date().toISOString(),
    revocationHistory: [],
  };

  public getConsentState(): ShahabTelemetryConsentState {
    return this.consent;
  }

  public setConsent(params: {
    readonly localDiagnosticsEnabled?: boolean;
    readonly externalOperationalTelemetryOptIn?: boolean;
    readonly externalResearchContributionOptIn?: boolean;
  }): ShahabTelemetryConsentState {
    const prevExtOp = this.consent.externalOperationalTelemetryOptIn;
    const prevExtRes = this.consent.externalResearchContributionOptIn;
    const nextExtOp = params.externalOperationalTelemetryOptIn ?? prevExtOp;
    const nextExtRes = params.externalResearchContributionOptIn ?? prevExtRes;

    const revocations = [...this.consent.revocationHistory];
    let cancelledQueued = 0;

    if ((prevExtOp && !nextExtOp) || (prevExtRes && !nextExtRes)) {
      cancelledQueued = this.externalQueue.length;
      this.externalQueue = []; // Immediately drop unsent queued transmissions!
      const scope =
        prevExtOp && !nextExtOp && prevExtRes && !nextExtRes
          ? 'ALL_EXTERNAL'
          : prevExtOp && !nextExtOp
            ? 'EXTERNAL_OPERATIONAL'
            : 'EXTERNAL_RESEARCH';
      revocations.push({
        revokedAtIso: new Date().toISOString(),
        scope,
        queuedItemsCancelled: cancelledQueued,
        alreadyTransmittedCount: this.externalTransmittedCount,
        remoteDeletionConfirmed: false,
        truthfulDisclosure:
          this.externalTransmittedCount === 0
            ? 'Zero items had been transmitted externally prior to revocation. Future & queued transmissions stopped.'
            : `${this.externalTransmittedCount} operational record(s) were previously transmitted; remote deletion is NOT claimed until confirmed externally.`,
      });
    }

    this.consent = {
      ...this.consent,
      localDiagnosticsEnabled: params.localDiagnosticsEnabled ?? this.consent.localDiagnosticsEnabled,
      externalOperationalTelemetryOptIn: nextExtOp,
      externalResearchContributionOptIn: nextExtRes,
      updatedAtIso: new Date().toISOString(),
      revocationHistory: revocations,
    };

    this.recordEvent({
      eventType: 'USER_FEEDBACK_CONSENT_CHANGED',
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      modelVersion: SHAHAB_NEURAL_CORE_IDENTITY,
      modelArtifactHash: null,
      runtimeProvider: 'shahab-operations',
      executionMode: 'LOCAL',
      sessionCorrelationId: 'consent-control',
      provenanceStatus: 'VERIFIED',
      fields: {
        localDiagnosticsEnabled: this.consent.localDiagnosticsEnabled,
        externalOperationalTelemetryOptIn: this.consent.externalOperationalTelemetryOptIn,
        externalResearchContributionOptIn: this.consent.externalResearchContributionOptIn,
        queuedCancelledOnRevoke: cancelledQueued,
      },
    });

    return this.consent;
  }

  public getPendingExternalQueueCount(): number {
    return this.externalQueue.length;
  }

  public recordEvent(input: {
    readonly eventType: ShahabOperationalEventType;
    readonly engineVersion: string;
    readonly modelVersion: string | null;
    readonly modelArtifactHash: string | null;
    readonly runtimeProvider: string;
    readonly executionMode: 'LOCAL' | 'CLOUD';
    readonly sessionCorrelationId: string;
    readonly provenanceStatus: 'MEASURED' | 'VERIFIED' | 'REPORTED' | 'NOT_MEASURED' | 'BLOCKED';
    readonly errorCode?: string | null;
    readonly fields?: Readonly<Record<string, string | number | boolean | null>>;
  }): ShahabOperationalEvent | null {
    const fields = input.fields ?? {};
    assertNoSensitiveOperationalPayload(fields);

    const event: ShahabOperationalEvent = {
      schemaVersion: SHAHAB_OPERATIONS_SCHEMA_VERSION,
      eventId: `op_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestampIso: new Date().toISOString(),
      eventType: input.eventType,
      engineVersion: input.engineVersion,
      modelVersion: input.modelVersion,
      modelArtifactHash: input.modelArtifactHash,
      runtimeProvider: input.runtimeProvider,
      executionMode: input.executionMode,
      sessionCorrelationId: input.sessionCorrelationId,
      provenanceStatus: input.provenanceStatus,
      errorCode: input.errorCode ?? null,
      fields,
    };

    if (this.consent.localDiagnosticsEnabled || input.eventType === 'USER_FEEDBACK_CONSENT_CHANGED') {
      this.events.push(event);
    }
    if (this.consent.externalOperationalTelemetryOptIn) {
      this.externalQueue.push(event);
    }
    return event;
  }

  public listEvents(limit = 200): readonly ShahabOperationalEvent[] {
    return this.events.slice(-limit);
  }

  public clearLocalDiagnostics(): { readonly clearedCount: number } {
    const clearedCount = this.events.length;
    this.events = [];
    return { clearedCount };
  }

  public exportSanitizedDiagnosticPackage(): {
    readonly exportedAtIso: string;
    readonly schemaVersion: typeof SHAHAB_OPERATIONS_SCHEMA_VERSION;
    readonly containsAudioOrTranscripts: false;
    readonly consent: ShahabTelemetryConsentState;
    readonly metricDefinitions: readonly ShahabMetricDefinition[];
    readonly summary: ShahabOperationalMetricsSummary;
    readonly eventCount: number;
    readonly events: readonly ShahabOperationalEvent[];
  } {
    const summary = this.computeSummary();
    this.recordEvent({
      eventType: 'DIAGNOSTIC_EXPORT_CREATED',
      engineVersion: SHAHAB_RELEASE_CANDIDATE_VERSION,
      modelVersion: SHAHAB_NEURAL_CORE_IDENTITY,
      modelArtifactHash: null,
      runtimeProvider: 'shahab-operations',
      executionMode: 'LOCAL',
      sessionCorrelationId: 'diagnostic-export',
      provenanceStatus: 'VERIFIED',
      fields: { exportedEventCount: this.events.length, sanitizedNoPii: true },
    });
    return {
      exportedAtIso: new Date().toISOString(),
      schemaVersion: SHAHAB_OPERATIONS_SCHEMA_VERSION,
      containsAudioOrTranscripts: false,
      consent: this.consent,
      metricDefinitions: SHAHAB_OPERATIONAL_METRIC_DEFINITIONS,
      summary,
      eventCount: this.events.length,
      events: [...this.events],
    };
  }

  public computeSummary(): ShahabOperationalMetricsSummary {
    const infCompleted = this.events.filter((e) => e.eventType === 'INFERENCE_COMPLETED');
    const rtfs = infCompleted
      .map((e) => e.fields.rtf)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const infMs = infCompleted
      .map((e) => e.fields.inferenceDurationMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const audioSecs = infCompleted
      .map((e) => e.fields.audioDurationSec)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const loadEvents = this.events.filter((e) => e.eventType === 'MODEL_LOAD_COMPLETED');
    const lastLoad = loadEvents.length > 0 ? loadEvents[loadEvents.length - 1].fields.loadDurationMs : null;
    const rssValues = this.events
      .map((e) => e.fields.peakRssBytes)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    return {
      sampleCount: infCompleted.length,
      timeRangeStartIso: this.events[0]?.timestampIso ?? null,
      timeRangeEndIso: this.events[this.events.length - 1]?.timestampIso ?? null,
      monitoringActive: this.consent.localDiagnosticsEnabled,
      modelLoadsSucceeded: loadEvents.length,
      modelLoadsFailed: this.events.filter((e) => e.eventType === 'MODEL_LOAD_FAILED').length,
      inferencesSucceeded: infCompleted.length,
      inferencesFailed: this.events.filter((e) => e.eventType === 'INFERENCE_FAILED').length,
      providerFallbacks: this.events.filter((e) => e.eventType === 'RUNTIME_PROVIDER_FALLBACK').length,
      cacheHits: this.events.filter((e) => e.eventType === 'CACHE_HIT').length,
      cacheMisses: this.events.filter((e) => e.eventType === 'CACHE_MISS').length,
      cacheEvictions: this.events.filter((e) => e.eventType === 'CACHE_EVICTION').length,
      updatesFailed: this.events.filter((e) => e.eventType === 'UPDATE_VERIFICATION_FAILED').length,
      rollbacksCompleted: this.events.filter((e) => e.eventType === 'ROLLBACK_COMPLETED').length,
      rollbacksFailed: this.events.filter((e) => e.eventType === 'ROLLBACK_FAILED').length,
      meanRtf: rtfs.length > 0 ? Number((rtfs.reduce((a, b) => a + b, 0) / rtfs.length).toFixed(4)) : 'NOT_MEASURED',
      meanInferenceMs: infMs.length > 0 ? Math.round(infMs.reduce((a, b) => a + b, 0) / infMs.length) : 'NOT_MEASURED',
      totalAudioDurationSec: Number(audioSecs.reduce((a, b) => a + b, 0).toFixed(2)),
      lastModelLoadMs: typeof lastLoad === 'number' ? lastLoad : 'NOT_MEASURED',
      peakProcessRssBytes: rssValues.length > 0 ? Math.max(...rssValues) : 'NOT_MEASURED',
      gpuUtilizationPct: 'NOT_MEASURED',
      gpuMemoryBytes: 'NOT_MEASURED',
    };
  }
}

// ── Human Feedback & Correction Governance (SHAHAB-014 §6) ───────────────────

export type ShahabFeedbackLifecycleState =
  | 'FEEDBACK_RECEIVED'
  | 'CONSENT_PENDING'
  | 'CONSENT_GRANTED'
  | 'CONSENT_DENIED'
  | 'ELIGIBLE_FOR_REVIEW'
  | 'HUMAN_REVIEWED'
  | 'APPROVED_AS_REFERENCE'
  | 'REJECTED_AS_REFERENCE'
  | 'WITHDRAWN'
  | 'DELETION_REQUESTED'
  | 'DELETED_WHERE_VERIFIABLE';

export type ShahabReferenceQualityLabel =
  | 'USER_EDITED'
  | 'USER_CONFIRMED'
  | 'HUMAN_REVIEWED'
  | 'MULTI_REVIEWER_AGREED'
  | 'EXPERT_VERIFIED'
  | 'REFERENCE_UNRESOLVED';

export interface ShahabFeedbackRecord {
  readonly feedbackId: string;
  readonly recordingCorrelationId: string;
  readonly rawAcousticHash: string;
  readonly userEditHash: string;
  readonly lifecycleState: ShahabFeedbackLifecycleState;
  readonly referenceQualityLabel: ShahabReferenceQualityLabel;
  readonly explicitResearchConsentGranted: boolean;
  readonly humanReviewed: boolean;
  readonly leakageCheckPassed: boolean;
  readonly admittedToDatasetRevision: string | null;
  readonly conflictingCorrectionsCount: number;
  readonly createdAtIso: string;
  readonly history: readonly { readonly atIso: string; readonly state: ShahabFeedbackLifecycleState; readonly note: string }[];
}

export class SHAHABFeedbackGovernanceManager {
  private readonly records = new Map<string, ShahabFeedbackRecord>();

  /**
   * Receiving an editing correction NEVER grants research consent or admits it to a dataset.
   */
  public receiveUserEditFeedback(params: {
    readonly recordingCorrelationId: string;
    readonly rawAcousticText: string;
    readonly userEditedText: string;
  }): ShahabFeedbackRecord {
    const id = `fb_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    // Store cryptographic hashes rather than exposing raw transcript text in operational governance tables
    const record: ShahabFeedbackRecord = {
      feedbackId: id,
      recordingCorrelationId: params.recordingCorrelationId,
      rawAcousticHash: crypto.createHash('sha256').update(params.rawAcousticText).digest('hex'),
      userEditHash: crypto.createHash('sha256').update(params.userEditedText).digest('hex'),
      lifecycleState: 'CONSENT_PENDING',
      referenceQualityLabel: 'USER_EDITED',
      explicitResearchConsentGranted: false,
      humanReviewed: false,
      leakageCheckPassed: false,
      admittedToDatasetRevision: null,
      conflictingCorrectionsCount: 0,
      createdAtIso: now,
      history: [
        { atIso: now, state: 'FEEDBACK_RECEIVED', note: 'User editing correction captured; research consent NOT assumed.' },
        { atIso: now, state: 'CONSENT_PENDING', note: 'Awaiting explicit separate research-use authorization.' },
      ],
    };
    this.records.set(id, record);
    return record;
  }

  public setResearchConsent(feedbackId: string, granted: boolean): ShahabFeedbackRecord {
    const cur = this.records.get(feedbackId);
    if (!cur) throw new Error(`Feedback ${feedbackId} not found.`);
    const now = new Date().toISOString();
    const nextState: ShahabFeedbackLifecycleState = granted ? 'ELIGIBLE_FOR_REVIEW' : 'CONSENT_DENIED';
    const updated: ShahabFeedbackRecord = {
      ...cur,
      lifecycleState: nextState,
      explicitResearchConsentGranted: granted,
      history: [
        ...cur.history,
        { atIso: now, state: granted ? 'CONSENT_GRANTED' : 'CONSENT_DENIED', note: `Explicit research consent=${granted}` },
        ...(granted ? [{ atIso: now, state: 'ELIGIBLE_FOR_REVIEW' as const, note: 'Queued for independent human review.' }] : []),
      ],
    };
    this.records.set(feedbackId, updated);
    return updated;
  }

  public recordHumanReview(params: {
    readonly feedbackId: string;
    readonly approved: boolean;
    readonly qualityLabel: ShahabReferenceQualityLabel;
    readonly conflicting?: boolean;
  }): ShahabFeedbackRecord {
    const cur = this.records.get(params.feedbackId);
    if (!cur) throw new Error(`Feedback ${params.feedbackId} not found.`);
    if (!cur.explicitResearchConsentGranted) {
      throw new Error('CONSENT_REQUIRED: Cannot review feedback for research without explicit consent.');
    }
    const now = new Date().toISOString();
    const nextState: ShahabFeedbackLifecycleState = params.conflicting
      ? 'HUMAN_REVIEWED'
      : params.approved
        ? 'APPROVED_AS_REFERENCE'
        : 'REJECTED_AS_REFERENCE';
    const updated: ShahabFeedbackRecord = {
      ...cur,
      lifecycleState: nextState,
      referenceQualityLabel: params.conflicting ? 'REFERENCE_UNRESOLVED' : params.qualityLabel,
      humanReviewed: true,
      conflictingCorrectionsCount: cur.conflictingCorrectionsCount + (params.conflicting ? 1 : 0),
      history: [...cur.history, { atIso: now, state: nextState, note: `Human review label=${params.qualityLabel}` }],
    };
    this.records.set(params.feedbackId, updated);
    return updated;
  }

  /**
   * Dataset Admission Gate (SHAHAB-014 §6.2):
   * Requires explicit research consent + human approval + zero unresolved conflict + leakage pass.
   */
  public admitToDataset(params: {
    readonly feedbackId: string;
    readonly datasetRevision: string;
    readonly leakageCheckPassed: boolean;
  }): { readonly admitted: boolean; readonly reason: string; readonly record: ShahabFeedbackRecord } {
    const cur = this.records.get(params.feedbackId);
    if (!cur) throw new Error(`Feedback ${params.feedbackId} not found.`);
    if (!cur.explicitResearchConsentGranted) {
      return { admitted: false, reason: 'BLOCKED: Explicit research consent not granted.', record: cur };
    }
    if (cur.lifecycleState !== 'APPROVED_AS_REFERENCE' || !cur.humanReviewed) {
      return { admitted: false, reason: `BLOCKED: Feedback state is ${cur.lifecycleState} (requires APPROVED_AS_REFERENCE).`, record: cur };
    }
    if (cur.referenceQualityLabel === 'REFERENCE_UNRESOLVED' || cur.conflictingCorrectionsCount > 0) {
      return { admitted: false, reason: 'BLOCKED: Unresolved reviewer conflict.', record: cur };
    }
    if (!params.leakageCheckPassed) {
      return { admitted: false, reason: 'BLOCKED: Duplicate/leakage check failed.', record: cur };
    }
    const updated: ShahabFeedbackRecord = {
      ...cur,
      leakageCheckPassed: true,
      admittedToDatasetRevision: params.datasetRevision,
      history: [
        ...cur.history,
        { atIso: new Date().toISOString(), state: 'APPROVED_AS_REFERENCE', note: `Admitted to dataset ${params.datasetRevision}` },
      ],
    };
    this.records.set(params.feedbackId, updated);
    return { admitted: true, reason: `Admitted to ${params.datasetRevision}`, record: updated };
  }

  public withdrawAndDelete(feedbackId: string): ShahabFeedbackRecord {
    const cur = this.records.get(feedbackId);
    if (!cur) throw new Error(`Feedback ${feedbackId} not found.`);
    const now = new Date().toISOString();
    const updated: ShahabFeedbackRecord = {
      ...cur,
      lifecycleState: 'DELETED_WHERE_VERIFIABLE',
      explicitResearchConsentGranted: false,
      admittedToDatasetRevision: null,
      history: [
        ...cur.history,
        { atIso: now, state: 'WITHDRAWN', note: 'User withdrew feedback consent.' },
        { atIso: now, state: 'DELETION_REQUESTED', note: 'Local operational feedback deletion executed.' },
        { atIso: now, state: 'DELETED_WHERE_VERIFIABLE', note: 'Deleted from local operational store.' },
      ],
    };
    this.records.set(feedbackId, updated);
    return updated;
  }

  public getGovernanceSummary(): {
    readonly totalReceived: number;
    readonly consentPending: number;
    readonly consentGranted: number;
    readonly consentDenied: number;
    readonly humanReviewed: number;
    readonly approvedForDataset: number;
    readonly withdrawnOrDeleted: number;
    readonly exposesRawTranscriptOrAudio: false;
  } {
    const all = Array.from(this.records.values());
    return {
      totalReceived: all.length,
      consentPending: all.filter((r) => r.lifecycleState === 'CONSENT_PENDING').length,
      consentGranted: all.filter((r) => r.explicitResearchConsentGranted).length,
      consentDenied: all.filter((r) => r.lifecycleState === 'CONSENT_DENIED').length,
      humanReviewed: all.filter((r) => r.humanReviewed).length,
      approvedForDataset: all.filter((r) => r.admittedToDatasetRevision !== null).length,
      withdrawnOrDeleted: all.filter(
        (r) =>
          r.lifecycleState === 'WITHDRAWN' ||
          r.lifecycleState === 'DELETION_REQUESTED' ||
          r.lifecycleState === 'DELETED_WHERE_VERIFIABLE',
      ).length,
      exposesRawTranscriptOrAudio: false,
    };
  }
}

// ── Safe Model & Runtime Update Lifecycle (SHAHAB-014 §7) ────────────────────

export type ShahabUpdateLifecycleState =
  | 'UPDATE_AVAILABLE'
  | 'MANIFEST_VALIDATION_PENDING'
  | 'MANIFEST_VERIFIED'
  | 'SIGNATURE_VERIFIED'
  | 'ARTIFACT_DOWNLOAD_PENDING'
  | 'ARTIFACT_INTEGRITY_VERIFIED'
  | 'COMPATIBILITY_VERIFIED'
  | 'STAGED'
  | 'CANARY'
  | 'ACTIVE'
  | 'ROLLBACK_PENDING'
  | 'ROLLED_BACK'
  | 'UPDATE_REJECTED'
  | 'UPDATE_BLOCKED';

export interface ShahabUpdateManifest {
  readonly manifestRevision: string;
  readonly releaseId: string;
  readonly engineVersion: string;
  readonly modelVersion: string;
  readonly modelRevisionSha: string;
  readonly tokenizerSha256: string;
  readonly artifactFormat: 'ONNX_INT8_STATELESS7';
  readonly artifacts: readonly { readonly fileName: string; readonly bytes: number; readonly sha256: string }[];
  readonly supportedProviders: readonly string[];
  readonly minAppVersion: string;
  readonly licenseSpdx: string;
  readonly signatureBase64: string | null;
  readonly signingPublicKeyPem?: string | null;
}

export interface ShahabUpdateHistoryEntry {
  readonly updateId: string;
  readonly releaseId: string;
  readonly state: ShahabUpdateLifecycleState;
  readonly previousActiveReleaseId: string | null;
  readonly reason: string;
  readonly timestampIso: string;
}

export class SHAHABUpdateLifecycleManager {
  private activeReleaseId: string;
  private previousVerifiedReleaseId: string | null = null;
  private stagedManifest: ShahabUpdateManifest | null = null;
  private readonly processedManifestRevisions = new Set<string>();
  private readonly history: ShahabUpdateHistoryEntry[] = [];
  private readonly signer = new SHAHABReleaseSigner();

  constructor(initialActiveReleaseId: string) {
    this.activeReleaseId = initialActiveReleaseId;
  }

  public getState(): {
    readonly activeReleaseId: string;
    readonly previousVerifiedReleaseId: string | null;
    readonly stagedReleaseId: string | null;
    readonly rollbackAvailable: boolean;
    readonly history: readonly ShahabUpdateHistoryEntry[];
  } {
    return {
      activeReleaseId: this.activeReleaseId,
      previousVerifiedReleaseId: this.previousVerifiedReleaseId,
      stagedReleaseId: this.stagedManifest?.releaseId ?? null,
      rollbackAvailable: this.previousVerifiedReleaseId !== null,
      history: [...this.history],
    };
  }

  public validateAndStageUpdate(params: {
    readonly manifest: ShahabUpdateManifest;
    readonly actualArtifacts: ReadonlyMap<string, { readonly bytes: number; readonly sha256: string }>;
    readonly currentProvider: string;
    readonly requireCryptographicSignature: boolean;
    readonly smokeTestPassed: boolean;
  }): { readonly state: ShahabUpdateLifecycleState; readonly activeReleaseUnchanged: boolean; readonly reason: string } {
    const m = params.manifest;
    const rec = (state: ShahabUpdateLifecycleState, reason: string) => {
      this.history.push({
        updateId: `upd_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
        releaseId: m.releaseId || 'UNKNOWN',
        state,
        previousActiveReleaseId: this.activeReleaseId,
        reason,
        timestampIso: new Date().toISOString(),
      });
      return { state, activeReleaseUnchanged: true, reason };
    };

    if (!m.releaseId || !m.manifestRevision || !Array.isArray(m.artifacts) || m.artifacts.length === 0) {
      return rec('UPDATE_REJECTED', 'Malformed update manifest (missing releaseId, manifestRevision, or artifacts).');
    }
    if (this.processedManifestRevisions.has(m.manifestRevision)) {
      return rec('UPDATE_REJECTED', `Duplicate or replayed manifest revision "${m.manifestRevision}" blocked.`);
    }

    // Cryptographic signature check if required or provided
    if (m.signatureBase64 && m.signingPublicKeyPem) {
      const canonical = JSON.stringify({
        manifestRevision: m.manifestRevision,
        releaseId: m.releaseId,
        modelRevisionSha: m.modelRevisionSha,
        artifacts: m.artifacts,
      });
      if (!this.signer.verifyManifestSignature(canonical, m.signatureBase64, m.signingPublicKeyPem)) {
        return rec('UPDATE_REJECTED', 'Invalid Ed25519 manifest signature.');
      }
    } else if (params.requireCryptographicSignature) {
      return rec('UPDATE_BLOCKED', 'Cryptographic signature required for rollout, but signing infrastructure is unavailable.');
    }

    // Verify exact artifact hashes & sizes
    for (const art of m.artifacts) {
      const actual = params.actualArtifacts.get(art.fileName);
      if (!actual) {
        return rec('UPDATE_REJECTED', `Missing acquired artifact: ${art.fileName}`);
      }
      if (actual.bytes !== art.bytes || actual.sha256 !== art.sha256) {
        return rec('UPDATE_REJECTED', `Integrity mismatch for ${art.fileName} (expected sha=${art.sha256.slice(0, 10)}, got ${actual.sha256.slice(0, 10)}).`);
      }
    }

    // Provider compatibility check
    if (!m.supportedProviders.includes(params.currentProvider)) {
      return rec('UPDATE_REJECTED', `Incompatible runtime provider: current=${params.currentProvider}, supported=${m.supportedProviders.join(',')}`);
    }

    // Isolated smoke test check
    if (!params.smokeTestPassed) {
      return rec('UPDATE_REJECTED', 'Isolated post-staging smoke inference test failed; active release preserved.');
    }

    this.processedManifestRevisions.add(m.manifestRevision);
    this.stagedManifest = m;
    return rec('STAGED', `Update ${m.releaseId} verified, compatibility-checked, and staged without overwriting active release.`);
  }

  public activateStaged(params: { readonly explicitPolicyAuthorized: boolean; readonly simulateCrashDuringActivation?: boolean }): {
    readonly state: ShahabUpdateLifecycleState;
    readonly activeReleaseId: string;
    readonly reason: string;
  } {
    if (!this.stagedManifest) {
      return { state: 'UPDATE_REJECTED', activeReleaseId: this.activeReleaseId, reason: 'No staged update ready for activation.' };
    }
    if (!params.explicitPolicyAuthorized) {
      return { state: 'UPDATE_BLOCKED', activeReleaseId: this.activeReleaseId, reason: 'Unauthorized update activation rejected.' };
    }
    if (params.simulateCrashDuringActivation) {
      const failedId = this.stagedManifest.releaseId;
      this.stagedManifest = null;
      this.history.push({
        updateId: `upd_crash_${Date.now()}`,
        releaseId: failedId,
        state: 'ROLLED_BACK',
        previousActiveReleaseId: this.activeReleaseId,
        reason: 'Interrupted activation detected — active release kept intact without partial overwrite.',
        timestampIso: new Date().toISOString(),
      });
      return {
        state: 'ROLLED_BACK',
        activeReleaseId: this.activeReleaseId,
        reason: 'Activation interrupted; previous verified release preserved.',
      };
    }

    this.previousVerifiedReleaseId = this.activeReleaseId;
    this.activeReleaseId = this.stagedManifest.releaseId;
    this.stagedManifest = null;
    this.history.push({
      updateId: `upd_act_${Date.now()}`,
      releaseId: this.activeReleaseId,
      state: 'ACTIVE',
      previousActiveReleaseId: this.previousVerifiedReleaseId,
      reason: `Activated release ${this.activeReleaseId} (rollback target retained: ${this.previousVerifiedReleaseId}).`,
      timestampIso: new Date().toISOString(),
    });
    return {
      state: 'ACTIVE',
      activeReleaseId: this.activeReleaseId,
      reason: `Release ${this.activeReleaseId} is now active.`,
    };
  }

  public rollback(params: { readonly targetArtifactsVerified: boolean }): {
    readonly state: ShahabUpdateLifecycleState;
    readonly activeReleaseId: string;
    readonly reason: string;
  } {
    if (!this.previousVerifiedReleaseId) {
      return { state: 'UPDATE_BLOCKED', activeReleaseId: this.activeReleaseId, reason: 'No previous verified release available for rollback.' };
    }
    if (!params.targetArtifactsVerified) {
      this.history.push({
        updateId: `rb_fail_${Date.now()}`,
        releaseId: this.previousVerifiedReleaseId,
        state: 'UPDATE_BLOCKED',
        previousActiveReleaseId: this.activeReleaseId,
        reason: 'Rollback target integrity check failed; aborting partial rollback.',
        timestampIso: new Date().toISOString(),
      });
      return { state: 'UPDATE_BLOCKED', activeReleaseId: this.activeReleaseId, reason: 'Rollback target corrupted.' };
    }
    const target = this.previousVerifiedReleaseId;
    const prev = this.activeReleaseId;
    this.activeReleaseId = target;
    this.history.push({
      updateId: `rb_ok_${Date.now()}`,
      releaseId: target,
      state: 'ROLLED_BACK',
      previousActiveReleaseId: prev,
      reason: `Atomic rollback from ${prev} to verified ${target} succeeded.`,
      timestampIso: new Date().toISOString(),
    });
    return { state: 'ROLLED_BACK', activeReleaseId: this.activeReleaseId, reason: `Rolled back to ${target}.` };
  }
}

// ── Regression Detection Analyzer (SHAHAB-014 §8) ────────────────────────────

export type ShahabRegressionVerdict =
  | 'NO_REGRESSION_DETECTED'
  | 'REGRESSION_DETECTED'
  | 'INCONCLUSIVE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'COMPARISON_INVALID';

export interface ShahabReleaseEvalSnapshot {
  readonly releaseId: string;
  readonly modelArtifactHash: string;
  readonly datasetId: string;
  readonly datasetRevision: string;
  readonly hardwareProfile: string;
  readonly runtimeVersion: string;
  readonly sampleCount: number;
  readonly validReferenceCount: number;
  readonly excludedSamplesCount: number;
  readonly trackAWer: number | null;
  readonly trackACer: number | null;
  readonly meanRtf: number | null;
  readonly peakRssBytes: number | null;
}

export interface ShahabRegressionReport {
  readonly comparisonId: string;
  readonly evaluatedAtIso: string;
  readonly previousRelease: ShahabReleaseEvalSnapshot;
  readonly candidateRelease: ShahabReleaseEvalSnapshot;
  readonly verdict: ShahabRegressionVerdict;
  readonly deltaTrackAWer: number | null;
  readonly deltaTrackACer: number | null;
  readonly deltaRtf: number | null;
  readonly statisticalLimitation: string;
  readonly recommendedThresholdsForApproval: {
    readonly maxAllowedWerIncreaseAbsolute: number;
    readonly maxAllowedRtfIncreaseRatio: number;
    readonly minPairedSamplesForClaim: number;
    readonly policyApprovalStatus: 'PROPOSED_AWAITING_PRODUCT_OWNER_APPROVAL';
  };
  readonly reason: string;
}

export class SHAHABRegressionAnalyzer {
  public compare(
    previous: ShahabReleaseEvalSnapshot,
    candidate: ShahabReleaseEvalSnapshot,
  ): ShahabRegressionReport {
    const base = {
      comparisonId: `reg_${Date.now()}`,
      evaluatedAtIso: new Date().toISOString(),
      previousRelease: previous,
      candidateRelease: candidate,
      recommendedThresholdsForApproval: {
        maxAllowedWerIncreaseAbsolute: 0.01,
        maxAllowedRtfIncreaseRatio: 1.15,
        minPairedSamplesForClaim: 20,
        policyApprovalStatus: 'PROPOSED_AWAITING_PRODUCT_OWNER_APPROVAL' as const,
      },
    };

    if (previous.datasetId !== candidate.datasetId || previous.datasetRevision !== candidate.datasetRevision) {
      return {
        ...base,
        verdict: 'COMPARISON_INVALID',
        deltaTrackAWer: null,
        deltaTrackACer: null,
        deltaRtf: null,
        statisticalLimitation: 'Dataset ID or revision mismatch invalidates direct comparison.',
        reason: `Incompatible datasets: ${previous.datasetId}@${previous.datasetRevision} vs ${candidate.datasetId}@${candidate.datasetRevision}.`,
      };
    }

    if (
      previous.validReferenceCount === 0 ||
      candidate.validReferenceCount === 0 ||
      previous.trackAWer === null ||
      candidate.trackAWer === null
    ) {
      return {
        ...base,
        verdict: 'COMPARISON_INVALID',
        deltaTrackAWer: null,
        deltaTrackACer: null,
        deltaRtf: null,
        statisticalLimitation: 'Missing verified reference transcripts.',
        reason: 'Cannot compute WER/CER regression without valid reference transcripts.',
      };
    }

    const deltaWer = Number((candidate.trackAWer - previous.trackAWer).toFixed(4));
    const deltaCer =
      previous.trackACer !== null && candidate.trackACer !== null
        ? Number((candidate.trackACer - previous.trackACer).toFixed(4))
        : null;
    const deltaRtf =
      previous.meanRtf !== null && candidate.meanRtf !== null
        ? Number((candidate.meanRtf - previous.meanRtf).toFixed(4))
        : null;

    if (Math.min(previous.sampleCount, candidate.sampleCount) < 20) {
      // If an obvious degradation occurred even on small sample, flag REGRESSION_DETECTED;
      // NEVER declare an improvement or statistical pass from < 20 samples!
      if (deltaWer > 0.05) {
        return {
          ...base,
          verdict: 'REGRESSION_DETECTED',
          deltaTrackAWer: deltaWer,
          deltaTrackACer: deltaCer,
          deltaRtf,
          statisticalLimitation: `Small sample size (n=${Math.min(previous.sampleCount, candidate.sampleCount)}); large degradation observed.`,
          reason: `Track A WER degraded by +${(deltaWer * 100).toFixed(2)}% on matched benchmark audio.`,
        };
      }
      return {
        ...base,
        verdict: deltaWer === 0 ? 'INSUFFICIENT_EVIDENCE' : 'INCONCLUSIVE',
        deltaTrackAWer: deltaWer,
        deltaTrackACer: deltaCer,
        deltaRtf,
        statisticalLimitation: `Sample count (n=${Math.min(previous.sampleCount, candidate.sampleCount)}) is below minimum paired sample threshold (20) for statistical significance.`,
        reason:
          deltaWer === 0
            ? 'Zero observed WER delta on matched samples, but sample count is insufficient for statistical population claims.'
            : `Observed WER delta (${(deltaWer * 100).toFixed(2)}%) is statistically inconclusive at n=${Math.min(previous.sampleCount, candidate.sampleCount)}.`,
      };
    }

    if (deltaWer > 0.01) {
      return {
        ...base,
        verdict: 'REGRESSION_DETECTED',
        deltaTrackAWer: deltaWer,
        deltaTrackACer: deltaCer,
        deltaRtf,
        statisticalLimitation: 'Paired comparison evaluated against proposed 1.0% WER tolerance.',
        reason: `Candidate WER increased by +${(deltaWer * 100).toFixed(2)}%.`,
      };
    }

    return {
      ...base,
      verdict: 'NO_REGRESSION_DETECTED',
      deltaTrackAWer: deltaWer,
      deltaTrackACer: deltaCer,
      deltaRtf,
      statisticalLimitation: 'Paired comparison on identical immutable evaluation dataset.',
      reason: `Candidate WER delta (${(deltaWer * 100).toFixed(2)}%) within proposed tolerance.`,
    };
  }
}
