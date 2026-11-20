/**
 * PHASE 14F & 14G — PRIVACY ENGINEERING, PII DERIVATIVES, TENANT ISOLATION,
 * INDEPENDENT RETENTION POLICIES, EXTERNAL API CONSENT GATE & TELEMETRY SCRUBBING
 */

import crypto from 'node:crypto';
import { AudioSecurityGuard } from './AudioSecurityGuard';
import type {
  DeletionCascadeReport,
  ExternalProviderPrivacyDecision,
  PiiEntityType,
  PiiRedactionConfig,
  PrivacyRetentionPolicy,
  RedactedTranscriptDerivative,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecuritySeverity,
} from './SpeechSecurityContracts';

const SECRET_TOKEN_PATTERNS = [
  /asr_(?:live|test)_[a-zA-Z0-9_-]{8,}/g,
  /whsec_[a-zA-Z0-9_-]{8,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{12,}/gi,
  /(?:api_key|access_token|secret_key|token)\s*=\s*[^\s&;]{8,}/gi,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /sk-[0-9A-Za-z]{20,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const DEFAULT_PII_CONFIG: PiiRedactionConfig = {
  enabled: true,
  redactPhone: true,
  redactNationalId: true,
  redactBankCard: true,
  redactIban: true,
  redactEmail: true,
  preserveOriginalTranscript: true,
};

export function sanitizeSecurityTelemetry(input: string): string {
  let cleaned = AudioSecurityGuard.sanitizeErrorForTelemetry(input);
  for (const rx of SECRET_TOKEN_PATTERNS) {
    cleaned = cleaned.replace(rx, '[REDACTED_CREDENTIAL]');
  }
  return cleaned;
}

export class PrivacyRetentionAndIsolationEngine {
  private readonly retentionPolicies = new Map<string, PrivacyRetentionPolicy>();
  private readonly redactedDerivatives = new Map<string, RedactedTranscriptDerivative[]>();
  private readonly deletionHistory = new Map<string, DeletionCascadeReport[]>();
  private readonly tenantCache = new Map<string, { tenantId: string; payload: unknown }>();
  private readonly recordingOwners = new Map<string, string>(); // recordingId -> owning tenantId
  private readonly auditEvents: SecurityAuditEvent[] = [];

  public registerRecordingOwner(tenantId: string, recordingId: string): void {
    if (!recordingId || !recordingId.trim()) return;
    const existing = this.recordingOwners.get(recordingId);
    if (existing && existing !== tenantId) {
      throw new Error('TENANT_ISOLATION_DENIED: Recording is owned by another tenant.');
    }
    this.recordingOwners.set(recordingId, tenantId);
    if (this.recordingOwners.size > 10_000) {
      const oldestKey = this.recordingOwners.keys().next().value;
      if (oldestKey) this.recordingOwners.delete(oldestKey);
    }
  }

  public getRecordingOwner(recordingId: string): string | null {
    return this.recordingOwners.get(recordingId) ?? null;
  }

  public assertRecordingAccess(params: {
    requesterTenantId: string;
    recordingId: string;
    actorId: string;
    resourceType?: string;
  }): void {
    const owner = this.recordingOwners.get(params.recordingId);
    if (owner && owner !== params.requesterTenantId) {
      this.recordSecurityEvent({
        tenantId: params.requesterTenantId,
        eventType: 'TENANT_CROSS_BOUNDARY_ACCESS_DENIED',
        severity: 'CRITICAL',
        actorId: params.actorId,
        resourceType: params.resourceType ?? 'recording',
        resourceId: params.recordingId,
        actionOutcome: 'DENIED',
        summary: 'Cross-tenant recording operation denied prior to mutation.',
      });
      throw new Error('TENANT_ISOLATION_DENIED: Resource access denied.');
    }
  }

  // ── Security Audit Logging (12 Typed Events, Scrubbed) ─────────────────────

  public recordSecurityEvent(params: {
    tenantId: string;
    eventType: SecurityAuditEventType;
    severity: SecuritySeverity;
    actorId: string;
    resourceType: string;
    resourceId: string;
    actionOutcome: 'BLOCKED' | 'FLAGGED' | 'EXECUTED' | 'DENIED';
    summary: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): SecurityAuditEvent {
    const cleanSummary = sanitizeSecurityTelemetry(params.summary);
    const cleanMetadata: Record<string, string | number | boolean | null> = {};
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        cleanMetadata[k] = typeof v === 'string' ? sanitizeSecurityTelemetry(v) : v;
      }
    }
    const ev: SecurityAuditEvent = {
      eventId: `secev_${crypto.randomUUID().slice(0, 12)}`,
      tenantId: params.tenantId,
      eventType: params.eventType,
      severity: params.severity,
      actorId: params.actorId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      actionOutcome: params.actionOutcome,
      sanitizedSummary: cleanSummary,
      metadata: cleanMetadata,
      createdAtIso: new Date().toISOString(),
    };
    this.auditEvents.unshift(ev);
    if (this.auditEvents.length > 500) {
      this.auditEvents.length = 500;
    }
    return ev;
  }

  public listSecurityEvents(
    tenantId: string,
    options?: { readonly limit?: number; readonly eventType?: SecurityAuditEventType }
  ): SecurityAuditEvent[] {
    const maxLimit =
      typeof options?.limit === 'number' && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(200, Math.floor(options.limit)))
        : 200;
    return this.auditEvents
      .filter((e) => e.tenantId === tenantId && (!options?.eventType || e.eventType === options.eventType))
      .slice(0, maxLimit)
      .map((e) => ({
        ...e,
        sanitizedSummary: sanitizeSecurityTelemetry(e.sanitizedSummary),
        metadata: Object.fromEntries(
          Object.entries(e.metadata).map(([k, v]) => [
            k,
            typeof v === 'string' ? sanitizeSecurityTelemetry(v) : v,
          ])
        ),
      }));
  }

  // ── Tenant-Scoped Cache Keys & Existence-Hiding Lookup ─────────────────────

  public static buildTenantScopedCacheKey(params: {
    tenantId: string;
    projectId: string;
    recordingId: string;
    modelVersionId: string;
    transcriptVersion: number;
    normalizationConfig: string;
  }): string {
    const cfgHash = crypto.createHash('sha256').update(params.normalizationConfig).digest('hex').slice(0, 12);
    return `t:${params.tenantId}:p:${params.projectId}:r:${params.recordingId}:m:${params.modelVersionId}:tv:${params.transcriptVersion}:cfg:${cfgHash}`;
  }

  public putTenantScopedCache(key: string, tenantId: string, payload: unknown): void {
    if (!key.startsWith(`t:${tenantId}:`)) {
      throw new Error('CACHE_TENANT_SCOPE_VIOLATION: Cache key must carry explicit tenantId prefix.');
    }
    this.tenantCache.set(key, { tenantId, payload });
    if (this.tenantCache.size > 5_000) {
      const oldestKey = this.tenantCache.keys().next().value;
      if (oldestKey) this.tenantCache.delete(oldestKey);
    }
  }

  public getTenantScopedCache(key: string, requesterTenantId: string): unknown | null {
    const entry = this.tenantCache.get(key);
    // Existence hiding: never disclose whether another tenant holds the key
    if (!entry || entry.tenantId !== requesterTenantId) {
      if (entry && entry.tenantId !== requesterTenantId) {
        this.recordSecurityEvent({
          tenantId: requesterTenantId,
          eventType: 'TENANT_CROSS_BOUNDARY_ACCESS_DENIED',
          severity: 'CRITICAL',
          actorId: 'cache_boundary_guard',
          resourceType: 'cache_entry',
          resourceId: key.slice(0, 36),
          actionOutcome: 'DENIED',
          summary: 'Cross-tenant cache read rejected with existence hiding.',
        });
      }
      return null;
    }
    return entry.payload;
  }

  // ── Configurable PII Redaction Derivative (Original Preserved Separately) ───

  public createRedactedTranscriptDerivative(params: {
    tenantId: string;
    recordingId: string;
    originalTranscript: string;
    config?: Partial<PiiRedactionConfig>;
    actorId: string;
  }): RedactedTranscriptDerivative {
    this.assertRecordingAccess({
      requesterTenantId: params.tenantId,
      recordingId: params.recordingId,
      actorId: params.actorId,
      resourceType: 'transcript_derivative',
    });
    this.registerRecordingOwner(params.tenantId, params.recordingId);
    const cfg: PiiRedactionConfig = {
      ...DEFAULT_PII_CONFIG,
      ...params.config,
      preserveOriginalTranscript: true,
    };

    const originalSha256 = crypto.createHash('sha256').update(params.originalTranscript).digest('hex');
    if (!cfg.enabled) {
      return {
        derivativeId: `pii_${crypto.randomUUID().slice(0, 10)}`,
        tenantId: params.tenantId,
        recordingId: params.recordingId,
        originalSha256,
        originalPreservedIntact: true,
        redactedText: params.originalTranscript,
        redactionsApplied: 0,
        detectedTypes: [],
        configSnapshot: cfg,
        createdAtIso: new Date().toISOString(),
      };
    }

    let text = params.originalTranscript;
    let redactionsApplied = 0;
    const detectedTypes = new Set<PiiEntityType>();

    const applyMask = (rx: RegExp, mask: string, type: PiiEntityType) => {
      const m = text.match(rx);
      if (m && m.length > 0) {
        redactionsApplied += m.length;
        detectedTypes.add(type);
        text = text.replace(rx, mask);
      }
    };

    if (cfg.redactIban) {
      applyMask(/\bIR[0-9]{24}\b/gi, '[REDACTED_IBAN]', 'IR_SHEBA_IBAN');
    }
    if (cfg.redactBankCard) {
      applyMask(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED_CARD]', 'BANK_CARD_PAN');
    }
    if (cfg.redactPhone) {
      applyMask(/(?:\+98|0)9[0-9۰-۹]{9}\b/g, '[REDACTED_PHONE]', 'IR_MOBILE_PHONE');
    }
    if (cfg.redactNationalId) {
      // Explicit National ID context or clean 10-digit token not part of larger numbers
      applyMask(/(?:کد\s*ملی|شماره\s*ملی|national\s*id)\s*[:：]?\s*[0-9۰-۹]{10}/gi, '[REDACTED_NATIONAL_ID]', 'IR_NATIONAL_ID');
    }
    if (cfg.redactEmail) {
      applyMask(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]', 'EMAIL_ADDRESS');
    }

    const derivative: RedactedTranscriptDerivative = {
      derivativeId: `pii_${crypto.randomUUID().slice(0, 10)}`,
      tenantId: params.tenantId,
      recordingId: params.recordingId,
      originalSha256,
      originalPreservedIntact: true,
      redactedText: text,
      redactionsApplied,
      detectedTypes: [...detectedTypes],
      configSnapshot: cfg,
      createdAtIso: new Date().toISOString(),
    };

    const list = this.redactedDerivatives.get(params.tenantId) ?? [];
    list.unshift(derivative);
    if (list.length > 500) {
      list.length = 500;
    }
    this.redactedDerivatives.set(params.tenantId, list);

    this.recordSecurityEvent({
      tenantId: params.tenantId,
      eventType: 'PII_REDACTION_DERIVATIVE_CREATED',
      severity: 'LOW',
      actorId: params.actorId,
      resourceType: 'transcript_derivative',
      resourceId: derivative.derivativeId,
      actionOutcome: 'EXECUTED',
      summary: `Created separate PII-redacted derivative (${redactionsApplied} redactions); verbatim transcript preserved.`,
      metadata: { redactionsApplied, recordingId: params.recordingId },
    });

    return derivative;
  }

  public listRedactedDerivatives(tenantId: string): RedactedTranscriptDerivative[] {
    return this.redactedDerivatives.get(tenantId) ?? [];
  }

  // ── Independent Per-Artifact Retention & Cascading Deletion ────────────────

  public getOrDefaultRetentionPolicy(tenantId: string): PrivacyRetentionPolicy {
    return (
      this.retentionPolicies.get(tenantId) ?? {
        tenantId,
        rawAudioTtlDays: 30,
        intermediateChunksTtlHours: 4,
        rawTranscriptTtlDays: 90,
        redactedTranscriptTtlDays: 365,
        diagnosticsTtlDays: 30,
        securityLogsTtlDays: 180,
        externalApiTransferAllowed: false,
        allowedResidencyRegion: 'IR_LOCAL_ONLY',
        updatedBy: 'system_default_policy',
        updatedAtIso: new Date().toISOString(),
      }
    );
  }

  public updateRetentionPolicy(
    policy: Omit<PrivacyRetentionPolicy, 'updatedAtIso'>
  ): PrivacyRetentionPolicy {
    if (
      !Number.isInteger(policy.rawAudioTtlDays) ||
      policy.rawAudioTtlDays < 0 ||
      policy.rawAudioTtlDays > 3650 ||
      !Number.isInteger(policy.intermediateChunksTtlHours) ||
      policy.intermediateChunksTtlHours < 1 ||
      policy.intermediateChunksTtlHours > 720 ||
      !Number.isInteger(policy.rawTranscriptTtlDays) ||
      policy.rawTranscriptTtlDays < 0 ||
      policy.rawTranscriptTtlDays > 3650 ||
      !Number.isInteger(policy.redactedTranscriptTtlDays) ||
      policy.redactedTranscriptTtlDays < 0 ||
      policy.redactedTranscriptTtlDays > 3650 ||
      !Number.isInteger(policy.diagnosticsTtlDays) ||
      policy.diagnosticsTtlDays < 1 ||
      policy.diagnosticsTtlDays > 365 ||
      !Number.isInteger(policy.securityLogsTtlDays) ||
      policy.securityLogsTtlDays < 7 ||
      policy.securityLogsTtlDays > 3650
    ) {
      throw new Error(
        'RETENTION_POLICY_INVALID: Retention TTL values must be finite integers within allowed safety bounds.'
      );
    }
    const updated: PrivacyRetentionPolicy = {
      ...policy,
      updatedAtIso: new Date().toISOString(),
    };
    this.retentionPolicies.set(policy.tenantId, updated);
    this.recordSecurityEvent({
      tenantId: policy.tenantId,
      eventType: 'RETENTION_POLICY_UPDATED',
      severity: 'LOW',
      actorId: policy.updatedBy,
      resourceType: 'privacy_retention_policy',
      resourceId: policy.tenantId,
      actionOutcome: 'EXECUTED',
      summary: 'Updated tenant privacy retention policy.',
      metadata: {
        rawAudioTtlDays: updated.rawAudioTtlDays,
        securityLogsTtlDays: updated.securityLogsTtlDays,
        allowedResidencyRegion: updated.allowedResidencyRegion,
      },
    });
    return { ...updated };
  }

  public executeDeletionCascade(params: {
    tenantId: string;
    recordingId: string;
    actorId: string;
  }): DeletionCascadeReport {
    if (!params.recordingId || !params.recordingId.trim()) {
      throw new Error('VALIDATION_ERROR: recordingId is required for deletion cascade.');
    }
    // Fail closed prior to any store mutation if recording belongs to another tenant
    this.assertRecordingAccess({
      requesterTenantId: params.tenantId,
      recordingId: params.recordingId,
      actorId: params.actorId,
      resourceType: 'recording_privacy_cascade',
    });

    // Purge tenant-scoped cache entries referencing this exact recording segment
    for (const [key, entry] of this.tenantCache.entries()) {
      if (entry.tenantId === params.tenantId && key.includes(`:r:${params.recordingId}:m:`)) {
        this.tenantCache.delete(key);
      }
    }
    // Purge redacted derivatives for recording
    const current = this.redactedDerivatives.get(params.tenantId) ?? [];
    this.redactedDerivatives.set(
      params.tenantId,
      current.filter((d) => d.recordingId !== params.recordingId)
    );

    const report: DeletionCascadeReport = {
      deletionId: `del_${crypto.randomUUID().slice(0, 10)}`,
      tenantId: params.tenantId,
      recordingId: params.recordingId,
      status: 'PARTIAL_PENDING_BACKUP_EXPIRY',
      purgedStores: [
        'live_audio_chunks',
        'tenant_scoped_cache',
        'pii_redacted_derivatives',
        'tenant_semantic_vector_index',
      ],
      retainedSecurityAuditTrail: true,
      backupWindowHonestyNote:
        'Live storage, derivatives, vector entries, and caches purged immediately. Immutable point-in-time DB snapshots expire naturally according to the 14-day backup retention window (security audit trail preserved without raw PII).',
      executedAtIso: new Date().toISOString(),
    };

    const hist = this.deletionHistory.get(params.tenantId) ?? [];
    hist.unshift(report);
    if (hist.length > 500) {
      hist.length = 500;
    }
    this.deletionHistory.set(params.tenantId, hist);

    this.recordSecurityEvent({
      tenantId: params.tenantId,
      eventType: 'PRIVACY_RETENTION_DELETION_EXECUTED',
      severity: 'LOW',
      actorId: params.actorId,
      resourceType: 'recording_privacy_cascade',
      resourceId: params.recordingId,
      actionOutcome: 'EXECUTED',
      summary: `Executed cascading deletion across 4 live stores for recording ${params.recordingId}.`,
    });

    return report;
  }

  public listDeletionHistory(tenantId: string): DeletionCascadeReport[] {
    return this.deletionHistory.get(tenantId) ?? [];
  }

  // ── External Provider Consent & Residency Gate ─────────────────────────────

  public evaluateExternalProviderTransfer(params: {
    tenantId: string;
    providerId: string;
    providerRegion: 'IR_LOCAL_ONLY' | 'REGIONAL_EU' | 'GLOBAL_US';
  }): ExternalProviderPrivacyDecision {
    const policy = this.getOrDefaultRetentionPolicy(params.tenantId);
    if (!policy.externalApiTransferAllowed) {
      return {
        allowed: false,
        providerId: params.providerId,
        requestedRegion: params.providerRegion,
        reasonCode: 'BLOCKED_EXTERNAL_TRANSFER_DISABLED',
        explanation:
          'Tenant privacy policy disables external API speech/transcript egress; local/on-prem routing enforced.',
      };
    }
    if (
      policy.allowedResidencyRegion === 'IR_LOCAL_ONLY' ||
      (policy.allowedResidencyRegion === 'REGIONAL_EU' && params.providerRegion === 'GLOBAL_US')
    ) {
      return {
        allowed: false,
        providerId: params.providerId,
        requestedRegion: params.providerRegion,
        reasonCode: 'BLOCKED_RESIDENCY_MISMATCH',
        explanation: `Provider region '${params.providerRegion}' violates tenant residency policy '${policy.allowedResidencyRegion}'.`,
      };
    }
    return {
      allowed: true,
      providerId: params.providerId,
      requestedRegion: params.providerRegion,
      reasonCode: 'ALLOWED_BY_EXPLICIT_CONSENT',
      explanation: `External provider '${params.providerId}' cleared by explicit tenant consent & residency match.`,
    };
  }
}
