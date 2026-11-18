/**
 * PHASE 14 — SPEECH AI SECURITY, ADVERSARIAL ROBUSTNESS, PRIVACY ENGINEERING & MODEL ABUSE DEFENSE
 * Canonical TypeScript contracts extending Phases 8, 10, 11, 12, and 13 without duplication.
 */

export type SecuritySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type LikelihoodLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type ImpactLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type SecurityAuditEventType =
  | 'AUDIO_UPLOAD_REJECTED'
  | 'URL_FETCH_SSRF_BLOCKED'
  | 'STREAMING_FRAME_REJECTED'
  | 'STREAMING_SESSION_HIJACK_BLOCKED'
  | 'QUOTA_OR_CONCURRENCY_EXCEEDED'
  | 'TRANSCRIPT_PROMPT_INJECTION_DETECTED'
  | 'TOOL_EXECUTION_UNAUTHORIZED_BLOCKED'
  | 'MODEL_ARTIFACT_TAMPER_OR_UNSAFE_BLOCKED'
  | 'DATASET_POISONING_ANOMALY_FLAGGED'
  | 'TENANT_CROSS_BOUNDARY_ACCESS_DENIED'
  | 'PII_REDACTION_DERIVATIVE_CREATED'
  | 'PRIVACY_RETENTION_DELETION_EXECUTED';

export interface SecurityAuditEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly eventType: SecurityAuditEventType;
  readonly severity: SecuritySeverity;
  readonly actorId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly actionOutcome: 'BLOCKED' | 'FLAGGED' | 'EXECUTED' | 'DENIED';
  readonly sanitizedSummary: string;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly createdAtIso: string;
}

export interface SpeechAiThreatEntry {
  readonly threatId: string;
  readonly category:
    | 'AUDIO_INGESTION'
    | 'STREAMING_REALTIME'
    | 'ADVERSARIAL_AUDIO'
    | 'TRANSCRIPT_LLM_BOUNDARY'
    | 'MODEL_SUPPLY_CHAIN'
    | 'DATA_POISONING'
    | 'PRIVACY_ISOLATION'
    | 'ABUSE_DOS_ECONOMIC';
  readonly title: string;
  readonly attackSurface: string;
  readonly threatActor: 'EXTERNAL_ANON' | 'MALICIOUS_TENANT_USER' | 'COMPROMISED_WORKER' | 'SUPPLY_CHAIN';
  readonly prerequisites: string;
  readonly likelihood: LikelihoodLevel;
  readonly impact: ImpactLevel;
  readonly severity: SecuritySeverity;
  readonly gateDisposition: 'BLOCK_RELEASE_IF_FAILING' | 'BLOCK_BEFORE_PROD' | 'DOCUMENT_AND_TRACK' | 'LOG_AND_MONITOR';
  readonly implementedControl: string;
  readonly residualRisk: string;
  readonly nonClaimNote: string;
}

export interface SpeechSecurityIncidentPlaybook {
  readonly playbookId: string;
  readonly title: string;
  readonly triggerCondition: string;
  readonly severity: SecuritySeverity;
  readonly immediateContainmentSteps: readonly string[];
  readonly forensicEvidenceToPreserve: readonly string[];
  readonly recoveryVerificationGate: string;
}

// ── 14B: Audio Ingestion, Decoder Sandbox & Anti-SSRF ─────────────────────────

export interface AudioIngestionSecurityLimits {
  readonly maxUploadBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxSampleRateHz: number;
  readonly minSampleRateHz: number;
  readonly maxChannels: number;
  readonly maxDecodedSamples: number;
  readonly maxCompressionExpansionRatio: number;
}

export interface AudioIngestionInspectionResult {
  readonly accepted: boolean;
  readonly detectedContainer: 'WAV' | 'MP3' | 'FLAC' | 'OGG' | 'M4A_AAC' | 'WEBM' | null;
  readonly sanitizedFilename: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly durationSeconds: number;
  readonly decodedSampleCount: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly rejectionCode: string | null;
  readonly rejectionReason: string | null;
}

export interface RemoteUrlPolicy {
  readonly remoteFetchEnabled: boolean;
  readonly allowedHostPatterns: readonly string[];
  readonly requireTls: boolean;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
}

export interface SsrfValidationDecision {
  readonly allowed: boolean;
  readonly normalizedUrl: string | null;
  readonly resolvedHost: string | null;
  readonly blockedReasonCode:
    | 'REMOTE_FETCH_DISABLED'
    | 'UNSUPPORTED_SCHEME'
    | 'RESTRICTED_PORT'
    | 'PRIVATE_OR_LOOPBACK_IP'
    | 'CLOUD_METADATA_ENDPOINT'
    | 'HOSTNAME_NOT_ALLOWLISTED'
    | 'INVALID_URL'
    | null;
  readonly explanation: string;
}

// ── 14B.2: Real-Time Streaming Security ───────────────────────────────────────

export interface StreamingSessionSecurityToken {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly modelScope: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly maxAudioSeconds: number;
  readonly maxMessagesPerSecond: number;
  readonly singleUseNonce: string;
  readonly hmacSignature: string;
}

export interface StreamingSecurityAdmissionResult {
  readonly admitted: boolean;
  readonly sessionId: string | null;
  readonly errorCode:
    | 'TOKEN_EXPIRED'
    | 'TOKEN_INVALID_SIGNATURE'
    | 'TOKEN_REPLAY_DETECTED'
    | 'TENANT_CONCURRENCY_LIMIT_EXCEEDED'
    | 'KEY_CONCURRENCY_LIMIT_EXCEEDED'
    | 'SESSION_HIJACK_PRINCIPAL_MISMATCH'
    | null;
  readonly detail: string;
}

export interface StreamingFrameSecurityVerdict {
  readonly accepted: boolean;
  readonly backpressureState: 'NORMAL' | 'WARNING' | 'OVERLOAD_REJECTED';
  readonly sequenceNumber: number | null;
  readonly rejectCode:
    | 'MALFORMED_ASR1_HEADER'
    | 'INVALID_FRAME_VERSION'
    | 'DUPLICATE_SEQUENCE'
    | 'OUT_OF_ORDER_SEQUENCE'
    | 'GAP_DISCONTINUITY'
    | 'MESSAGE_RATE_LIMIT_EXCEEDED'
    | 'AUDIO_QUOTA_EXCEEDED'
    | 'QUEUE_BACKPRESSURE_OVERLOAD'
    | null;
  readonly detail: string;
}

// ── 14C: Adversarial Robustness Evaluation (Isolated Defensive Testing) ───────

export type AdversarialFamilyId =
  | 'clean_baseline'
  | 'snr_25db_noise'
  | 'snr_15db_noise'
  | 'snr_5db_noise'
  | 'speed_0_90x'
  | 'speed_1_10x'
  | 'telephony_bandpass_300_3400hz'
  | 'phase_cancel_stereo_fold'
  | 'streaming_packet_loss_10pct'
  | 'bounded_perturbation_eps_0_015';

export interface RobustnessAttackSliceMetric {
  readonly familyId: AdversarialFamilyId;
  readonly familyLabel: string;
  readonly sampleCount: number;
  readonly faCerPercent: number | null;
  readonly enCerPercent: number | null;
  readonly codeSwitchCerPercent: number | null;
  readonly overallNormalizedCerPercent: number;
  readonly relativeDegradationVsCleanPct: number;
  readonly emptyTranscriptRatePct: number;
  readonly failureRatePct: number;
  readonly vadMissOrCutoffRatePct: number;
  readonly medianTimestampDriftMs: number;
}

export interface AdversarialRobustnessReport {
  readonly reportId: string;
  readonly tenantId: string;
  readonly modelVersionId: string;
  readonly executionMode: 'SYNTHETIC_AUTHORIZED_CPU';
  readonly authorizedFixtureOnly: true;
  readonly totalUtterancesEvaluated: number;
  readonly familyMetrics: readonly RobustnessAttackSliceMetric[];
  readonly summaryWithoutBlendedScore: {
    readonly cleanOverallCerPct: number;
    readonly worstDegradationFamily: AdversarialFamilyId;
    readonly worstDegradationCerPct: number;
    readonly emptyOutputUnderPerturbationRatePct: number;
    readonly faVsEnGapAtSnr5DbPp: number | null;
  };
  readonly explicitLimitations: readonly string[];
  readonly evaluatedAtIso: string;
}

// ── 14D: Untrusted Transcript Trust Boundary & Anti-Prompt Injection ──────────

export interface TranscriptTrustEnvelope {
  readonly envelopeId: string;
  readonly trustTier: 'UNTRUSTED_TRANSCRIPT_DATA';
  readonly authoritativeSystemInstructions: false;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly rawText: string;
  readonly sanitizedText: string;
  readonly neutralizedDirectives: readonly string[];
  readonly promptInjectionDetected: boolean;
}

export interface ToolAuthorizationDecision {
  readonly authorized: boolean;
  readonly toolName: string;
  readonly reasonCode:
    | 'AUTHORIZED_EXPLICIT_USER_RBAC'
    | 'BLOCKED_UNTRUSTED_TRANSCRIPT_SOURCE'
    | 'BLOCKED_MISSING_USER_CONFIRMATION'
    | 'BLOCKED_RBAC_ROLE_DENIED'
    | 'BLOCKED_TENANT_MISMATCH'
    | 'BLOCKED_INVALID_PARAMETERS';
  readonly detail: string;
  readonly requiresHumanConfirmation: true;
}

// ── 14E: Supply Chain & Data Poisoning Indicators ─────────────────────────────

export type PoisoningAnomalyType =
  | 'SUDDEN_SOURCE_SHIFT'
  | 'REPEATED_TEMPLATE_FLOODING'
  | 'SINGLE_CONTRIBUTOR_DOMINANCE'
  | 'CONFLICTING_TRANSCRIPTS_SAME_AUDIO_HASH'
  | 'NORMALIZATION_EVASION_ZERO_WIDTH_SPAM';

export interface PoisoningAnomalyIndicator {
  readonly indicatorId: string;
  readonly anomalyType: PoisoningAnomalyType;
  readonly severity: SecuritySeverity;
  readonly affectedRecordingIds: readonly string[];
  readonly disposition: 'INVESTIGATION_FLAG';
  readonly detail: string;
  readonly autoDeleted: false;
}

export interface ModelSupplyChainVerificationResult {
  readonly modelVersionId: string;
  readonly safeToLoad: boolean;
  readonly sha256Verified: boolean;
  readonly tokenizerHashVerified: boolean;
  readonly safeSerializationFormat: boolean;
  readonly rejectedFormatsDetected: readonly string[];
  readonly licenseVerifiedCommercial: boolean;
  readonly secretScanClean: boolean;
  readonly blockingReasons: readonly string[];
}

// ── 14F: Privacy, PII Redaction Derivative, Retention & External Transfer ─────

export interface PrivacyRetentionPolicy {
  readonly tenantId: string;
  readonly rawAudioTtlDays: number;
  readonly intermediateChunksTtlHours: number;
  readonly rawTranscriptTtlDays: number;
  readonly redactedTranscriptTtlDays: number;
  readonly diagnosticsTtlDays: number;
  readonly securityLogsTtlDays: number;
  readonly externalApiTransferAllowed: boolean;
  readonly allowedResidencyRegion: 'IR_LOCAL_ONLY' | 'REGIONAL_EU' | 'GLOBAL_EXPLICIT_OPT_IN';
  readonly updatedBy: string;
  readonly updatedAtIso: string;
}

export type PiiEntityType = 'IR_MOBILE_PHONE' | 'IR_NATIONAL_ID' | 'BANK_CARD_PAN' | 'IR_SHEBA_IBAN' | 'EMAIL_ADDRESS';

export interface PiiRedactionConfig {
  readonly enabled: boolean;
  readonly redactPhone: boolean;
  readonly redactNationalId: boolean;
  readonly redactBankCard: boolean;
  readonly redactIban: boolean;
  readonly redactEmail: boolean;
  readonly preserveOriginalTranscript: true;
}

export interface RedactedTranscriptDerivative {
  readonly derivativeId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly originalSha256: string;
  readonly originalPreservedIntact: true;
  readonly redactedText: string;
  readonly redactionsApplied: number;
  readonly detectedTypes: readonly PiiEntityType[];
  readonly configSnapshot: PiiRedactionConfig;
  readonly createdAtIso: string;
}

export interface DeletionCascadeReport {
  readonly deletionId: string;
  readonly tenantId: string;
  readonly recordingId: string;
  readonly status: 'COMPLETED' | 'PARTIAL_PENDING_BACKUP_EXPIRY';
  readonly purgedStores: readonly string[];
  readonly retainedSecurityAuditTrail: true;
  readonly backupWindowHonestyNote: string;
  readonly executedAtIso: string;
}

export interface ExternalProviderPrivacyDecision {
  readonly allowed: boolean;
  readonly providerId: string;
  readonly requestedRegion: string;
  readonly reasonCode: 'ALLOWED_BY_EXPLICIT_CONSENT' | 'BLOCKED_EXTERNAL_TRANSFER_DISABLED' | 'BLOCKED_RESIDENCY_MISMATCH';
  readonly explanation: string;
}

// ── Red Team Test Suite Output ────────────────────────────────────────────────

export interface RedTeamGroupResult {
  readonly groupCode: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  readonly groupTitle: string;
  readonly totalChecks: number;
  readonly passedChecks: number;
  readonly status: 'PASS' | 'FAIL';
  readonly findings: readonly {
    readonly testId: string;
    readonly attackVector: string;
    readonly expectedDefense: string;
    readonly observedOutcome: string;
    readonly defended: boolean;
  }[];
}
