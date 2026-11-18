/**
 * PHASE 10 — CONTROL PLANE ENGINE (Commercial, Identity, API Keys, Quotas, Ledger, Webhooks, Regions)
 *
 * Architectural Guarantee (Phase 10 Section 1.3):
 * - Completely isolated from ASR model inference code.
 * - Uses integer minor monetary units (cents) and integer audio milliseconds. Never binary floats.
 * - Plaintext API secrets (`asr_live_...` / `asr_test_...`) are returned STRICTLY ONCE and stored as HMAC-SHA256 digests with a server-side pepper.
 * - Note on Runtime Persistence in G0 Container: PostgreSQL/Redis connections are not provisioned locally;
 *   this engine runs over deterministic in-memory stores backed by full PostgreSQL DDL migrations in `/platform/migrations/0001_phase10_commercial_postgres.sql`.
 */

import crypto from 'node:crypto';
import type {
  ApiCredentialIssuedResponse,
  ApiCredentialRecord,
  ApiCredentialScope,
  AuthoritativeUsageEvent,
  ImmutableBillingLedgerEntry,
  ImmutableInvoiceRecord,
  OrganizationInvitation,
  OrganizationMembership,
  OrganizationRole,
  PlanTierId,
  PlatformApiErrorEnvelope,
  PlatformAuditLogEntry,
  PlatformErrorCode,
  PlatformOrganization,
  PlatformPlanCatalogEntry,
  PlatformProject,
  PlatformRegionRecord,
  PlatformUser,
  PublicModelCatalogEntry,
  PublicWebhookEventType,
  TenantSubscriptionRecord,
  UsageReservationRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from './PlatformContractsAndSchemas';

export const PHASE10_VERSIONED_PLAN_CATALOG: readonly PlatformPlanCatalogEntry[] = [
  {
    planId: 'developer',
    planName: 'Developer (Sandbox & Evaluation)',
    planVersion: '2026-11-v1',
    billingInterval: 'monthly',
    currency: 'USD',
    subscriptionPriceMinor: 0,
    includedAudioMinutes: 60,
    overageRateMinorPerMinute: 1, // $0.01/min minor representation if enabled later
    streamingRateMinorPerMinute: 1,
    maxFileDurationSec: 600,
    maxUploadBytes: 25 * 1024 * 1024,
    concurrentBatchJobs: 2,
    concurrentStreamingSessions: 1,
    requestsPerMinute: 10,
    retentionDays: 7,
    supportedModels: ['asr-fa-en-v1', 'asr-fa-en-baseline'],
    externalProvidersPermitted: false,
    allowedRegions: ['ir-thr-01'],
    supportTier: 'community',
    planStatus: 'ACTIVE',
  },
  {
    planId: 'starter',
    planName: 'Starter',
    planVersion: '2026-11-v1',
    billingInterval: 'monthly',
    currency: 'USD',
    subscriptionPriceMinor: 2900,
    includedAudioMinutes: 1500,
    overageRateMinorPerMinute: 2,
    streamingRateMinorPerMinute: 2,
    maxFileDurationSec: 1800,
    maxUploadBytes: 100 * 1024 * 1024,
    concurrentBatchJobs: 10,
    concurrentStreamingSessions: 2,
    requestsPerMinute: 60,
    retentionDays: 30,
    supportedModels: ['asr-fa-en-v1', 'asr-fa-en-baseline', 'whisper-large-v3-fa'],
    externalProvidersPermitted: false,
    allowedRegions: ['ir-thr-01'],
    supportTier: 'standard',
    planStatus: 'ACTIVE',
  },
  {
    planId: 'growth',
    planName: 'Growth',
    planVersion: '2026-11-v1',
    billingInterval: 'monthly',
    currency: 'USD',
    subscriptionPriceMinor: 9900,
    includedAudioMinutes: 8000,
    overageRateMinorPerMinute: 1,
    streamingRateMinorPerMinute: 2,
    maxFileDurationSec: 7200,
    maxUploadBytes: 250 * 1024 * 1024,
    concurrentBatchJobs: 25,
    concurrentStreamingSessions: 10,
    requestsPerMinute: 300,
    retentionDays: 90,
    supportedModels: ['asr-fa-en-v1', 'asr-fa-en-baseline', 'whisper-large-v3-fa', 'qwen3-asr-1.7b-fa'],
    externalProvidersPermitted: true,
    allowedRegions: ['ir-thr-01'],
    supportTier: 'priority',
    planStatus: 'ACTIVE',
  },
  {
    planId: 'business',
    planName: 'Business',
    planVersion: '2026-11-v1',
    billingInterval: 'monthly',
    currency: 'USD',
    subscriptionPriceMinor: 39900,
    includedAudioMinutes: 40000,
    overageRateMinorPerMinute: 1,
    streamingRateMinorPerMinute: 1,
    maxFileDurationSec: 14400,
    maxUploadBytes: 512 * 1024 * 1024,
    concurrentBatchJobs: 100,
    concurrentStreamingSessions: 50,
    requestsPerMinute: 1000,
    retentionDays: 180,
    supportedModels: ['asr-fa-en-v1', 'asr-fa-en-baseline', 'whisper-large-v3-fa', 'qwen3-asr-1.7b-fa'],
    externalProvidersPermitted: true,
    allowedRegions: ['ir-thr-01'],
    supportTier: 'priority',
    planStatus: 'ACTIVE',
  },
  {
    planId: 'enterprise',
    planName: 'Enterprise (Private & Custom Contract)',
    planVersion: '2026-11-v1',
    billingInterval: 'contract',
    currency: 'USD',
    subscriptionPriceMinor: 0, // Contract-defined
    includedAudioMinutes: 250000,
    overageRateMinorPerMinute: 1,
    streamingRateMinorPerMinute: 1,
    maxFileDurationSec: 43200,
    maxUploadBytes: 2048 * 1024 * 1024,
    concurrentBatchJobs: 500,
    concurrentStreamingSessions: 250,
    requestsPerMinute: 5000,
    retentionDays: 365,
    supportedModels: ['asr-fa-en-v1', 'asr-fa-en-baseline', 'whisper-large-v3-fa', 'qwen3-asr-1.7b-fa'],
    externalProvidersPermitted: true,
    allowedRegions: ['ir-thr-01'],
    supportTier: 'dedicated_sla',
    planStatus: 'ACTIVE',
  },
];

export const PHASE10_PUBLIC_MODEL_CATALOG: readonly PublicModelCatalogEntry[] = [
  {
    modelId: 'asr-fa-en-v1',
    displayName: 'Avapardaz Persian-English v1 (Local Independent Engine)',
    version: '1.0.0',
    releaseState: 'STABLE',
    supportedLanguages: ['fa', 'en'],
    codeSwitchingSupported: true,
    supportedModes: ['batch', 'native_streaming', 'vad_segmented_streaming'],
    inputFormats: ['wav', 'mp3', 'ogg', 'pcm16'],
    maxAudioDurationSec: 3600,
    timestampsSupported: true,
    diarizationSupported: true,
    supportedRegions: ['ir-thr-01'],
    runtimeType: 'local_cpu_worker',
    availabilityInCurrentContainer: 'AVAILABLE_NOW',
    documentationAnchor: '#model-asr-fa-en-v1',
    retirementDateIso: null,
  },
  {
    modelId: 'asr-fa-en-baseline',
    displayName: 'Avapardaz Acoustic Baseline (Legacy Compat)',
    version: '0.9.0',
    releaseState: 'BETA',
    supportedLanguages: ['fa', 'en'],
    codeSwitchingSupported: true,
    supportedModes: ['batch', 'native_streaming'],
    inputFormats: ['wav', 'pcm16'],
    maxAudioDurationSec: 1800,
    timestampsSupported: true,
    diarizationSupported: false,
    supportedRegions: ['ir-thr-01'],
    runtimeType: 'local_cpu_worker',
    availabilityInCurrentContainer: 'AVAILABLE_NOW',
    documentationAnchor: '#model-asr-fa-en-baseline',
    retirementDateIso: null,
  },
  {
    modelId: 'qwen3-asr-1.7b-fa',
    displayName: 'Qwen3-ASR-1.7B Persian/English Worker',
    version: '1.7b-v1',
    releaseState: 'PREVIEW',
    supportedLanguages: ['fa', 'en'],
    codeSwitchingSupported: true,
    supportedModes: ['batch', 'native_streaming'],
    inputFormats: ['wav', 'pcm16'],
    maxAudioDurationSec: 1200,
    timestampsSupported: false, // Official Phase 5 matrix: Qwen Persian forced alignment unsupported
    diarizationSupported: false,
    supportedRegions: ['ir-thr-01'],
    runtimeType: 'self_hosted_gpu_vllm',
    availabilityInCurrentContainer: 'REQUIRES_GPU_WORKER',
    documentationAnchor: '#model-qwen3-asr',
    retirementDateIso: null,
  },
  {
    modelId: 'whisper-large-v3-fa',
    displayName: 'Whisper Large-v3 (Batch & VAD-Segmented Only)',
    version: '3.0.0',
    releaseState: 'BETA',
    supportedLanguages: ['fa', 'en'],
    codeSwitchingSupported: true,
    supportedModes: ['batch', 'vad_segmented_streaming'],
    inputFormats: ['wav', 'mp3', 'ogg'],
    maxAudioDurationSec: 3600,
    timestampsSupported: true,
    diarizationSupported: false,
    supportedRegions: ['ir-thr-01'],
    runtimeType: 'self_hosted_gpu_vllm',
    availabilityInCurrentContainer: 'REQUIRES_GPU_WORKER',
    documentationAnchor: '#model-whisper-large-v3',
    retirementDateIso: null,
  },
];

export const PHASE10_REGION_REGISTRY: readonly PlatformRegionRecord[] = [
  {
    regionId: 'ir-thr-01',
    displayName: 'Tehran Local Single-Region Runtime (G0)',
    provider: 'self_hosted_local',
    locationLabel: 'IR / Local Host Container',
    dataResidencyClass: 'DOMESTIC_LOCAL',
    healthStatus: 'OPERATIONAL_SINGLE_REGION',
    gpuCapacityAvailable: 0,
    freeVramGb: 0,
    activeStreamingSessions: 0,
    batchQueueDepth: 0,
    supportsFailoverFrom: [],
    pricingMultiplier: 1.0,
  },
  {
    regionId: 'eu-central-01',
    displayName: 'Frankfurt EU Staging Region (Not Yet Provisioned)',
    provider: 'staged_cloud',
    locationLabel: 'EU / Germany',
    dataResidencyClass: 'EU_GDPR',
    healthStatus: 'STAGED_NOT_OPERATIONAL',
    gpuCapacityAvailable: 0,
    freeVramGb: 0,
    activeStreamingSessions: 0,
    batchQueueDepth: 0,
    supportsFailoverFrom: [],
    pricingMultiplier: 1.25,
  },
];

export const ROLE_PERMISSION_MATRIX: Record<OrganizationRole, readonly string[]> = {
  OWNER: ['*'],
  ADMIN: ['org:manage', 'projects:write', 'keys:write', 'webhooks:write', 'usage:read', 'audit:read', 'asr:run'],
  DEVELOPER: ['projects:read', 'keys:write', 'webhooks:write', 'usage:read', 'asr:run'],
  BILLING_ADMIN: ['billing:write', 'invoices:read', 'usage:read', 'plans:write'],
  ANALYST: ['usage:read', 'projects:read'],
  VIEWER: ['projects:read', 'usage:read'],
  SECURITY_AUDITOR: ['audit:read', 'keys:read', 'projects:read', 'usage:read'],
};

export const WEBHOOK_RETRY_DELAYS_SECONDS = [10, 30, 120, 600, 3600, 21600] as const;

export function buildPlatformErrorEnvelope(params: {
  code: PlatformErrorCode;
  message: string;
  requestId?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}): PlatformApiErrorEnvelope {
  return {
    error: {
      code: params.code,
      message: params.message,
      request_id: params.requestId ?? `req_${crypto.randomUUID()}`,
      retryable: params.retryable ?? false,
      ...(params.retryAfterSeconds !== undefined ? { retry_after_seconds: params.retryAfterSeconds } : {}),
      details: params.details ?? {},
    },
  };
}

/**
 * Computes exact integer minor-unit billing charge without binary floating-point drift.
 */
export function computeIntegerOverageChargeMinor(params: {
  billedAudioSeconds: number;
  includedAudioMinutes: number;
  overageRateMinorPerMinute: number;
}): {
  billedMinutesWholeUpOrExactFloor: number;
  overageMinutes: number;
  overageChargeMinor: number;
} {
  const wholeBilledMinutes = Math.ceil(Math.max(0, params.billedAudioSeconds) / 60);
  const overageMinutes = Math.max(0, wholeBilledMinutes - Math.max(0, params.includedAudioMinutes));
  const overageChargeMinor = overageMinutes * Math.max(0, params.overageRateMinorPerMinute);
  return {
    billedMinutesWholeUpOrExactFloor: wholeBilledMinutes,
    overageMinutes,
    overageChargeMinor,
  };
}

/**
 * Token-Bucket Rate Limiter scoped independently per credential / project / IP.
 */
class ScopedTokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  public tryConsume(params: {
    bucketKey: string;
    capacityPerMinute: number;
    cost?: number;
    nowMs?: number;
  }): { allowed: boolean; remaining: number; limit: number; retryAfterSeconds: number } {
    const nowMs = params.nowMs ?? Date.now();
    const limit = Math.max(1, params.capacityPerMinute);
    const cost = params.cost ?? 1;
    const refillRatePerMs = limit / 60000;

    let bucket = this.buckets.get(params.bucketKey);
    if (!bucket) {
      bucket = { tokens: limit, lastRefillMs: nowMs };
      this.buckets.set(params.bucketKey, bucket);
    }

    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(limit, bucket.tokens + elapsedMs * refillRatePerMs);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit,
        retryAfterSeconds: 0,
      };
    }

    const deficit = cost - bucket.tokens;
    const waitMs = Math.ceil(deficit / Math.max(1e-9, refillRatePerMs));
    return {
      allowed: false,
      remaining: 0,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  }
}

export class PlatformControlPlaneService {
  private readonly serverPepper: string;
  private readonly users = new Map<string, PlatformUser>();
  private readonly organizations = new Map<string, PlatformOrganization>();
  private readonly memberships: OrganizationMembership[] = [];
  private readonly invitations = new Map<string, OrganizationInvitation>();
  private readonly projects = new Map<string, PlatformProject>();
  private readonly credentials = new Map<string, ApiCredentialRecord>();
  private readonly credentialsByPublicId = new Map<string, ApiCredentialRecord>();
  private readonly subscriptions = new Map<string, TenantSubscriptionRecord>();
  private readonly reservations = new Map<string, UsageReservationRecord>();
  private readonly usageEvents = new Map<string, AuthoritativeUsageEvent>();
  private readonly ledgerEntries: ImmutableBillingLedgerEntry[] = [];
  private readonly invoices = new Map<string, ImmutableInvoiceRecord>();
  private readonly processedPaymentEvents = new Set<string>();
  private readonly webhookEndpoints = new Map<string, WebhookEndpointRecord>();
  private readonly webhookDeliveries: WebhookDeliveryRecord[] = [];
  private readonly auditLogs: PlatformAuditLogEntry[] = [];
  private readonly rateLimiter = new ScopedTokenBucketLimiter();
  private invoiceSeq = 1001;

  constructor(options?: { serverPepper?: string }) {
    this.serverPepper =
      options?.serverPepper ??
      process.env.API_KEY_PEPPER ??
      'avapardaz-local-dev-pepper-configure-secret-in-prod';
    this.seedInitialTenantSandbox();
  }

  private seedInitialTenantSandbox(): void {
    const now = new Date().toISOString();
    const user: PlatformUser = {
      id: 'usr_studio_owner_01',
      email: 'developer@avapardaz.local',
      emailVerified: true,
      displayName: 'توسعه‌دهنده ارشد آواپرداز',
      identityProvider: 'local_password',
      mfaEnabled: true,
      accountStatus: 'ACTIVE',
      createdAtIso: now,
    };
    this.users.set(user.id, user);

    const org: PlatformOrganization = {
      id: 'org_avapardaz_sandbox',
      name: 'آواپرداز — فضای کار توسعه‌دهندگان (Sandbox)',
      billingCustomerReference: 'cust_local_sandbox_01',
      organizationStatus: 'ACTIVE',
      defaultRegionId: 'ir-thr-01',
      allowedRegions: ['ir-thr-01'],
      prohibitedRegions: ['eu-central-01'],
      allowCrossRegionFailover: false,
      hardSpendingLimitMinor: 5000, // $50.00 sandbox ceiling
      currency: 'USD',
      createdAtIso: now,
    };
    this.organizations.set(org.id, org);

    this.memberships.push({
      organizationId: org.id,
      userId: user.id,
      role: 'OWNER',
      membershipStatus: 'ACTIVE',
      createdAtIso: now,
    });

    const devProject: PlatformProject = {
      id: 'prj_avapardaz_dev_01',
      organizationId: org.id,
      projectName: 'سرویس استودیو تدوین صوت فارسی',
      environment: 'DEVELOPMENT',
      allowedModels: ['asr-fa-en-v1', 'asr-fa-en-baseline', 'qwen3-asr-1.7b-fa', 'whisper-large-v3-fa'],
      allowedEngines: ['asr_fa_en_v1', 'avapardaz_acoustic_raw_local'],
      allowedRegions: ['ir-thr-01'],
      retentionDays: 30,
      monthlyAudioSecondsQuota: 36000,
      requestsPerMinuteLimit: 60,
      status: 'ACTIVE',
      createdAtIso: now,
    };
    this.projects.set(devProject.id, devProject);

    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + 30 * 86400_000);
    this.subscriptions.set(org.id, {
      subscriptionId: 'sub_sandbox_01',
      organizationId: org.id,
      planId: 'developer',
      planVersion: '2026-11-v1',
      status: 'ACTIVE',
      currentPeriodStartIso: periodStart.toISOString(),
      currentPeriodEndIso: periodEnd.toISOString(),
      availableCreditMinor: 2500, // $25.00 sandbox evaluation credits
      reservedCreditMinor: 0,
      consumedCreditMinor: 0,
    });

    this.ledgerEntries.push({
      ledgerEntryId: 'ldg_init_credit_01',
      organizationId: org.id,
      transactionType: 'CREDIT_GRANT',
      amountMinor: 2500,
      currency: 'USD',
      debitAccount: 'platform:promotional_grants',
      creditAccount: `tenant:${org.id}:credit_balance`,
      usageEventId: null,
      invoiceId: null,
      paymentEventId: null,
      idempotencyKey: 'init_sandbox_grant_01',
      note: 'اعتبار اولیه ارزیابی پلتفرم توسعه‌دهندگان (Sandbox Non-Commercial)',
      createdAtIso: now,
    });

    this.registerWebhookEndpoint({
      organizationId: org.id,
      url: 'https://sandbox.avapardaz.local/webhooks/asr-events',
      eventSubscriptions: ['transcription.completed', 'transcription.failed', 'usage.threshold_reached'],
      actorId: user.id,
    });
  }

  private hashSecretWithPepper(secret: string): string {
    return crypto.createHmac('sha256', this.serverPepper).update(secret, 'utf8').digest('hex');
  }

  public recordAuditLog(entry: Omit<PlatformAuditLogEntry, 'auditId' | 'timestampIso'>): void {
    this.auditLogs.push({
      ...entry,
      auditId: `aud_${crypto.randomUUID()}`,
      timestampIso: new Date().toISOString(),
    });
  }

  public listAuditLogs(organizationId: string): PlatformAuditLogEntry[] {
    return this.auditLogs.filter((l) => l.organizationId === organizationId);
  }

  public hasRolePermission(organizationId: string, userId: string, requiredPermission: string): boolean {
    const membership = this.memberships.find(
      (m) => m.organizationId === organizationId && m.userId === userId && m.membershipStatus === 'ACTIVE'
    );
    if (!membership) return false;
    const perms = ROLE_PERMISSION_MATRIX[membership.role] ?? [];
    return perms.includes('*') || perms.includes(requiredPermission);
  }

  public createInvitation(params: {
    organizationId: string;
    actorUserId: string;
    email: string;
    role: OrganizationRole;
    projectIds: string[];
    expiresInHours?: number;
  }): { invitation: Omit<OrganizationInvitation, 'tokenHash'>; plaintextTokenOnce: string } {
    if (!this.hasRolePermission(params.organizationId, params.actorUserId, 'org:manage')) {
      throw new Error('RBAC_FORBIDDEN: Actor lacks org:manage permission');
    }

    const token = `inv_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = this.hashSecretWithPepper(token);
    const hours = params.expiresInHours ?? 72;
    const expiresAtIso = new Date(Date.now() + hours * 3600_000).toISOString();

    const inv: OrganizationInvitation = {
      invitationId: `invrec_${crypto.randomUUID()}`,
      organizationId: params.organizationId,
      email: params.email.trim().toLowerCase(),
      role: params.role,
      projectIds: params.projectIds,
      tokenHash,
      expiresAtIso,
      consumedAtIso: null,
      revokedAtIso: null,
      createdAtIso: new Date().toISOString(),
    };
    this.invitations.set(inv.invitationId, inv);
    this.recordAuditLog({
      organizationId: params.organizationId,
      actorType: 'USER',
      actorId: params.actorUserId,
      action: 'INVITATION_CREATED',
      resourceType: 'invitation',
      resourceId: inv.invitationId,
      outcome: 'ALLOWED',
      reason: `Invited ${inv.email} as ${inv.role}`,
    });

    const { tokenHash: _hidden, ...publicInv } = inv;
    return { invitation: publicInv, plaintextTokenOnce: token };
  }

  public acceptInvitation(params: {
    invitationId: string;
    plaintextToken: string;
    userId: string;
    email: string;
  }): OrganizationMembership {
    const inv = this.invitations.get(params.invitationId);
    if (!inv) throw new Error('INVITATION_NOT_FOUND');
    if (inv.revokedAtIso) throw new Error('INVITATION_REVOKED');
    if (inv.consumedAtIso) throw new Error('INVITATION_ALREADY_USED');
    if (new Date(inv.expiresAtIso).getTime() < Date.now()) throw new Error('INVITATION_EXPIRED');

    const incomingHash = this.hashSecretWithPepper(params.plaintextToken);
    if (!crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(inv.tokenHash))) {
      throw new Error('INVITATION_TOKEN_INVALID');
    }

    inv.consumedAtIso = new Date().toISOString();
    const membership: OrganizationMembership = {
      organizationId: inv.organizationId,
      userId: params.userId,
      role: inv.role,
      membershipStatus: 'ACTIVE',
      createdAtIso: inv.consumedAtIso,
    };
    this.memberships.push(membership);
    return membership;
  }

  public createOrganization(params: {
    name: string;
    defaultRegionId?: string;
    hardSpendingLimitMinor?: number;
    ownerUserId?: string;
  }): PlatformOrganization {
    const now = new Date().toISOString();
    const org: PlatformOrganization = {
      id: `org_${crypto.randomBytes(6).toString('hex')}`,
      name: params.name.trim(),
      billingCustomerReference: `cust_${crypto.randomBytes(5).toString('hex')}`,
      organizationStatus: 'ACTIVE',
      defaultRegionId: params.defaultRegionId ?? 'ir-thr-01',
      allowedRegions: [params.defaultRegionId ?? 'ir-thr-01'],
      prohibitedRegions: [],
      allowCrossRegionFailover: false,
      hardSpendingLimitMinor: params.hardSpendingLimitMinor ?? 5000,
      currency: 'USD',
      createdAtIso: now,
    };
    this.organizations.set(org.id, org);
    this.memberships.push({
      organizationId: org.id,
      userId: params.ownerUserId ?? 'usr_studio_owner_01',
      role: 'OWNER',
      membershipStatus: 'ACTIVE',
      createdAtIso: now,
    });
    return org;
  }

  public createProject(params: {
    organizationId: string;
    projectName: string;
    environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
    allowedModels?: string[];
    allowedRegions?: string[];
    actorUserId?: string;
  }): PlatformProject {
    const org = this.organizations.get(params.organizationId);
    if (!org) throw new Error('ORGANIZATION_NOT_FOUND');

    const regions = (params.allowedRegions ?? [org.defaultRegionId]).filter(
      (r) => !org.prohibitedRegions.includes(r)
    );
    const prj: PlatformProject = {
      id: `prj_${crypto.randomBytes(6).toString('hex')}`,
      organizationId: org.id,
      projectName: params.projectName.trim(),
      environment: params.environment,
      allowedModels: params.allowedModels ?? ['asr-fa-en-v1', 'asr-fa-en-baseline'],
      allowedEngines: ['asr_fa_en_v1', 'avapardaz_acoustic_raw_local'],
      allowedRegions: regions.length > 0 ? regions : [org.defaultRegionId],
      retentionDays: 30,
      monthlyAudioSecondsQuota: 36000,
      requestsPerMinuteLimit: 60,
      status: 'ACTIVE',
      createdAtIso: new Date().toISOString(),
    };
    this.projects.set(prj.id, prj);
    this.recordAuditLog({
      organizationId: org.id,
      actorType: 'USER',
      actorId: params.actorUserId ?? 'usr_studio_owner_01',
      action: 'PROJECT_CREATED',
      resourceType: 'project',
      resourceId: prj.id,
      outcome: 'ALLOWED',
      reason: `Environment=${prj.environment}`,
    });
    return prj;
  }

  public listProjects(organizationId: string): PlatformProject[] {
    return Array.from(this.projects.values()).filter((p) => p.organizationId === organizationId);
  }

  /**
   * Issues an API credential with public identifier + high-entropy random secret.
   * NEVER stores plaintext secret; returns `plaintextSecretOnce` strictly on creation.
   */
  public issueApiKey(params: {
    organizationId: string;
    projectId: string;
    name: string;
    scopes: ApiCredentialScope[];
    expiresInDays?: number;
    allowedIpCidrs?: string[];
    actorUserId?: string;
  }): ApiCredentialIssuedResponse {
    const project = this.projects.get(params.projectId);
    if (!project || project.organizationId !== params.organizationId) {
      throw new Error('TENANT_ISOLATION_DENIED: Project does not belong to organization');
    }

    const prefix: 'asr_live' | 'asr_test' =
      project.environment === 'PRODUCTION' ? 'asr_live' : 'asr_test';
    const publicId = crypto.randomBytes(6).toString('hex');
    const rawSecret = crypto.randomBytes(24).toString('base64url');
    const plaintextSecretOnce = `${prefix}_${publicId}_${rawSecret}`;
    const secretHash = this.hashSecretWithPepper(rawSecret);

    const nowIso = new Date().toISOString();
    const expiresAtIso =
      params.expiresInDays && params.expiresInDays > 0
        ? new Date(Date.now() + params.expiresInDays * 86400_000).toISOString()
        : null;

    const record: ApiCredentialRecord = {
      id: `cred_${crypto.randomBytes(6).toString('hex')}`,
      organizationId: params.organizationId,
      projectId: params.projectId,
      name: params.name.trim() || 'Default API Credential',
      publicIdentifier: publicId,
      secretHash,
      keyPrefix: prefix,
      environment: project.environment,
      scopes: [...params.scopes],
      allowedIpCidrs: params.allowedIpCidrs ?? [],
      expiresAtIso,
      overlapRevokesAtIso: null,
      lastUsedAtIso: null,
      revokedAtIso: null,
      createdAtIso: nowIso,
    };

    this.credentials.set(record.id, record);
    this.credentialsByPublicId.set(record.publicIdentifier, record);

    this.recordAuditLog({
      organizationId: params.organizationId,
      actorType: 'USER',
      actorId: params.actorUserId ?? 'usr_studio_owner_01',
      action: 'API_KEY_ISSUED',
      resourceType: 'api_credential',
      resourceId: record.id,
      outcome: 'ALLOWED',
      reason: `Prefix=${prefix}, PublicId=${publicId}, Scopes=${record.scopes.join(',')}`,
    });

    const { secretHash: _removed, ...sanitized } = record;
    return {
      credential: sanitized,
      plaintextSecretOnce,
    };
  }

  public listApiKeys(organizationId: string): Array<Omit<ApiCredentialRecord, 'secretHash'>> {
    return Array.from(this.credentials.values())
      .filter((c) => c.organizationId === organizationId)
      .map(({ secretHash: _s, ...rest }) => rest);
  }

  /**
   * Key Rotation with configurable overlap (default 24 hours).
   * Old credential remains active until `overlapRevokesAtIso` expires.
   */
  public rotateApiKey(params: {
    credentialId: string;
    organizationId: string;
    overlapHours?: number;
    actorUserId?: string;
  }): ApiCredentialIssuedResponse {
    const existing = this.credentials.get(params.credentialId);
    if (!existing || existing.organizationId !== params.organizationId) {
      throw new Error('TENANT_ISOLATION_DENIED: Credential not found in organization');
    }
    if (existing.revokedAtIso) {
      throw new Error('CREDENTIAL_ALREADY_REVOKED');
    }

    const overlapHours = params.overlapHours ?? 24;
    existing.overlapRevokesAtIso = new Date(Date.now() + overlapHours * 3600_000).toISOString();

    const replacement = this.issueApiKey({
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      name: `${existing.name} (Rotated)`,
      scopes: existing.scopes,
      allowedIpCidrs: existing.allowedIpCidrs,
      actorUserId: params.actorUserId,
    });

    this.recordAuditLog({
      organizationId: existing.organizationId,
      actorType: 'USER',
      actorId: params.actorUserId ?? 'usr_studio_owner_01',
      action: 'API_KEY_ROTATED',
      resourceType: 'api_credential',
      resourceId: existing.id,
      outcome: 'ALLOWED',
      reason: `OverlapHours=${overlapHours}, NewCredentialId=${replacement.credential.id}`,
    });

    return replacement;
  }

  public revokeApiKey(params: {
    credentialId: string;
    organizationId: string;
    actorUserId?: string;
  }): Omit<ApiCredentialRecord, 'secretHash'> {
    const existing = this.credentials.get(params.credentialId);
    if (!existing || existing.organizationId !== params.organizationId) {
      throw new Error('TENANT_ISOLATION_DENIED: Credential not found in organization');
    }
    existing.revokedAtIso = new Date().toISOString();
    this.recordAuditLog({
      organizationId: existing.organizationId,
      actorType: 'USER',
      actorId: params.actorUserId ?? 'usr_studio_owner_01',
      action: 'API_KEY_REVOKED',
      resourceType: 'api_credential',
      resourceId: existing.id,
      outcome: 'ALLOWED',
      reason: 'Immediate credential revocation',
    });
    const { secretHash: _removed, ...rest } = existing;
    return rest;
  }

  /**
   * Authenticates `asr_live_<publicId>_<secret>` / `asr_test_<publicId>_<secret>`,
   * checks expiration, overlap revocation, immediate revocation, required scope, and rate limit.
   */
  public authenticateApiKeyRequest(params: {
    bearerToken: string;
    requiredScope: ApiCredentialScope;
    requiredProjectId?: string;
    requiredEnvironment?: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
    nowMs?: number;
  }):
    | {
        authenticated: true;
        organization: PlatformOrganization;
        project: PlatformProject;
        credential: Omit<ApiCredentialRecord, 'secretHash'>;
        rateLimit: { remaining: number; limit: number };
      }
    | {
        authenticated: false;
        httpStatus: number;
        errorEnvelope: PlatformApiErrorEnvelope;
      } {
    const nowMs = params.nowMs ?? Date.now();
    const token = params.bearerToken.replace(/^Bearer\s+/i, '').trim();
    const match = token.match(/^(asr_live|asr_test)_([a-f0-9]+)_(.+)$/);
    if (!match) {
      return {
        authenticated: false,
        httpStatus: 401,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'Malformed or missing API key.',
        }),
      };
    }

    const [, prefix, publicId, rawSecret] = match;
    const cred = this.credentialsByPublicId.get(publicId);
    if (!cred || cred.keyPrefix !== prefix) {
      return {
        authenticated: false,
        httpStatus: 401,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'Invalid API key identifier.',
        }),
      };
    }

    const computedHash = this.hashSecretWithPepper(rawSecret);
    if (!crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(cred.secretHash))) {
      return {
        authenticated: false,
        httpStatus: 401,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'Invalid API key secret.',
        }),
      };
    }

    if (cred.revokedAtIso) {
      return {
        authenticated: false,
        httpStatus: 401,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'API key has been revoked.',
        }),
      };
    }

    if (cred.overlapRevokesAtIso && new Date(cred.overlapRevokesAtIso).getTime() <= nowMs) {
      return {
        authenticated: false,
        httpStatus: 401,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'Rotated API key overlap window has expired.',
        }),
      };
    }

    if (cred.expiresAtIso && new Date(cred.expiresAtIso).getTime() <= nowMs) {
      return {
        authenticated: false,
        httpStatus: 401,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'API key has expired.',
        }),
      };
    }

    const project = this.projects.get(cred.projectId);
    const org = this.organizations.get(cred.organizationId);
    if (!project || !org) {
      return {
        authenticated: false,
        httpStatus: 403,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Organization or project boundary invalid.',
        }),
      };
    }

    if (params.requiredProjectId && params.requiredProjectId !== project.id) {
      return {
        authenticated: false,
        httpStatus: 403,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Credential is not authorized for the target project.',
        }),
      };
    }

    if (params.requiredEnvironment && cred.environment !== params.requiredEnvironment) {
      return {
        authenticated: false,
        httpStatus: 403,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: `Credential environment (${cred.environment}) cannot access ${params.requiredEnvironment} resources.`,
        }),
      };
    }

    if (!cred.scopes.includes(params.requiredScope)) {
      return {
        authenticated: false,
        httpStatus: 403,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: `Missing required scope "${params.requiredScope}".`,
        }),
      };
    }

    // Scoped Token-Bucket Rate Limiter (per credential)
    const rate = this.rateLimiter.tryConsume({
      bucketKey: `cred:${cred.id}`,
      capacityPerMinute: project.requestsPerMinuteLimit,
      nowMs,
    });
    if (!rate.allowed) {
      return {
        authenticated: false,
        httpStatus: 429,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded for this API credential.',
          retryable: true,
          retryAfterSeconds: rate.retryAfterSeconds,
        }),
      };
    }

    cred.lastUsedAtIso = new Date(nowMs).toISOString();
    const { secretHash: _removed, ...sanitizedCred } = cred;
    return {
      authenticated: true,
      organization: org,
      project,
      credential: sanitizedCred,
      rateLimit: { remaining: rate.remaining, limit: rate.limit },
    };
  }

  /**
   * Region Eligibility & Data Residency Hard Constraint (Section 18.3 & Section 23.3):
   * Prohibited regions are rejected transparently rather than silently routing elsewhere.
   */
  public validateRegionPolicy(params: {
    organizationId: string;
    projectId: string;
    requestedRegionId?: string;
  }): { allowed: true; region: PlatformRegionRecord } | { allowed: false; errorEnvelope: PlatformApiErrorEnvelope } {
    const org = this.organizations.get(params.organizationId);
    const project = this.projects.get(params.projectId);
    if (!org || !project || project.organizationId !== org.id) {
      return {
        allowed: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Tenant boundary rejected.',
        }),
      };
    }

    const regionId = params.requestedRegionId ?? org.defaultRegionId;
    const region = PHASE10_REGION_REGISTRY.find((r) => r.regionId === regionId);
    if (!region) {
      return {
        allowed: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'REGION_UNAVAILABLE',
          message: `Unknown region "${regionId}".`,
        }),
      };
    }

    if (org.prohibitedRegions.includes(regionId) || !project.allowedRegions.includes(regionId)) {
      this.recordAuditLog({
        organizationId: org.id,
        actorType: 'SYSTEM',
        actorId: 'region-residency-guard',
        action: 'REGION_RESIDENCY_BLOCKED',
        resourceType: 'region',
        resourceId: regionId,
        outcome: 'DENIED',
        reason: `Region ${regionId} is prohibited by tenant/project residency policy.`,
      });
      return {
        allowed: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'REGION_UNAVAILABLE',
          message: `Processing in region "${regionId}" is prohibited by data residency policy.`,
        }),
      };
    }

    if (region.healthStatus !== 'OPERATIONAL_SINGLE_REGION') {
      return {
        allowed: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'REGION_UNAVAILABLE',
          message: `Region "${regionId}" is currently ${region.healthStatus} and not accepting production audio.`,
        }),
      };
    }

    return { allowed: true, region };
  }

  /**
   * Section 11.5: Atomic Usage Reservation BEFORE Inference Execution.
   * Uses integer minor units (`cents`) so concurrent jobs cannot double-spend credits.
   */
  public reserveUsageBudgetAtomically(params: {
    organizationId: string;
    projectId: string;
    requestId: string;
    estimatedDurationMs: number;
    modelId: string;
  }): { approved: true; reservation: UsageReservationRecord } | { approved: false; errorEnvelope: PlatformApiErrorEnvelope } {
    const sub = this.subscriptions.get(params.organizationId);
    const org = this.organizations.get(params.organizationId);
    const project = this.projects.get(params.projectId);
    if (!sub || !org || !project || project.organizationId !== org.id) {
      return {
        approved: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Subscription or tenant boundary missing.',
        }),
      };
    }

    const plan = PHASE10_VERSIONED_PLAN_CATALOG.find((p) => p.planId === sub.planId)!;
    const estMinutes = Math.max(1, Math.ceil(params.estimatedDurationMs / 60000));
    const estChargeMinor = estMinutes * plan.overageRateMinorPerMinute;

    // Check Monthly Audio Seconds Quota
    const consumedSecondsThisMonth = Array.from(this.usageEvents.values())
      .filter((u) => u.organizationId === org.id && u.meteringState !== 'REVERSED')
      .reduce((acc, u) => acc + Math.ceil(u.billableDurationMs / 1000), 0);

    if (consumedSecondsThisMonth + Math.ceil(params.estimatedDurationMs / 1000) > project.monthlyAudioSecondsQuota) {
      return {
        approved: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'QUOTA_EXCEEDED',
          message: 'Project monthly audio seconds quota exceeded.',
        }),
      };
    }

    if (sub.consumedCreditMinor + sub.reservedCreditMinor + estChargeMinor > org.hardSpendingLimitMinor) {
      return {
        approved: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'BUDGET_EXCEEDED',
          message: 'Organization hard spending limit reached (100%).',
        }),
      };
    }

    if (sub.availableCreditMinor < estChargeMinor) {
      return {
        approved: false,
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'BUDGET_EXCEEDED',
          message: 'Insufficient available balance to reserve estimated transcription cost.',
        }),
      };
    }

    // Atomic deduction into reserved pool
    sub.availableCreditMinor -= estChargeMinor;
    sub.reservedCreditMinor += estChargeMinor;

    const reservation: UsageReservationRecord = {
      reservationId: `res_${crypto.randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      requestId: params.requestId,
      estimatedAudioMs: params.estimatedDurationMs,
      reservedAmountMinor: estChargeMinor,
      currency: 'USD',
      status: 'RESERVED',
      expiresAtIso: new Date(Date.now() + 900_000).toISOString(),
      createdAtIso: new Date().toISOString(),
      settledAtIso: null,
    };
    this.reservations.set(reservation.reservationId, reservation);
    return { approved: true, reservation };
  }

  /**
   * Authoritative Usage Metering & Immutable Ledger Commit (Section 9 & 11).
   * Idempotent by `usageEventId` so duplicate retries NEVER double-charge.
   */
  public commitAuthoritativeUsageAndLedger(params: {
    reservationId: string;
    usageEventId: string;
    idempotencyKey: string;
    credentialId: string;
    transcriptionId: string;
    modelId: string;
    modelVersion: string;
    executionMode: 'batch' | 'native_streaming' | 'vad_segmented_streaming';
    verifiedAudioDurationMs: number;
    billableDurationMs: number;
    processingDurationMs: number;
    succeeded: boolean;
  }): AuthoritativeUsageEvent {
    const existing = this.usageEvents.get(params.usageEventId);
    if (existing) return existing; // Strictly idempotent

    const reservation = this.reservations.get(params.reservationId);
    if (!reservation) {
      throw new Error(`USAGE_RESERVATION_NOT_FOUND: ${params.reservationId}`);
    }
    const sub = this.subscriptions.get(reservation.organizationId)!;
    const plan = PHASE10_VERSIONED_PLAN_CATALOG.find((p) => p.planId === sub.planId)!;

    let actualCostMinor = 0;
    if (params.succeeded && params.billableDurationMs > 0) {
      const billedMin = Math.max(1, Math.ceil(params.billableDurationMs / 60000));
      actualCostMinor = Math.min(reservation.reservedAmountMinor, billedMin * plan.overageRateMinorPerMinute);
    }

    // Settle reservation atomically: move actualCostMinor to consumed, release unused back to available
    const unusedMinor = Math.max(0, reservation.reservedAmountMinor - actualCostMinor);
    sub.reservedCreditMinor = Math.max(0, sub.reservedCreditMinor - reservation.reservedAmountMinor);
    sub.availableCreditMinor += unusedMinor;
    sub.consumedCreditMinor += actualCostMinor;

    reservation.status = params.succeeded ? 'COMMITTED' : 'RELEASED';
    reservation.settledAtIso = new Date().toISOString();

    const usageEvent: AuthoritativeUsageEvent = {
      usageEventId: params.usageEventId,
      idempotencyKey: params.idempotencyKey,
      eventType: params.succeeded
        ? params.executionMode === 'batch'
          ? 'transcription.completed'
          : 'streaming.session.completed'
        : 'transcription.failed_reversed',
      organizationId: reservation.organizationId,
      projectId: reservation.projectId,
      credentialId: params.credentialId,
      requestId: reservation.requestId,
      transcriptionId: params.transcriptionId,
      modelId: params.modelId,
      modelVersion: params.modelVersion,
      executionMode: params.executionMode,
      audioDurationMs: Math.max(0, Math.round(params.verifiedAudioDurationMs)),
      billableDurationMs: params.succeeded ? Math.max(0, Math.round(params.billableDurationMs)) : 0,
      processingDurationMs: Math.max(0, Math.round(params.processingDurationMs)),
      unit: 'audio_milliseconds',
      actualCostMinor,
      currency: 'USD',
      meteringState: params.succeeded ? 'COMMITTED' : 'REVERSED',
      measuredAtIso: reservation.settledAtIso,
    };
    this.usageEvents.set(usageEvent.usageEventId, usageEvent);

    if (params.succeeded && actualCostMinor > 0) {
      this.ledgerEntries.push({
        ledgerEntryId: `ldg_${crypto.randomUUID()}`,
        organizationId: reservation.organizationId,
        transactionType: 'CREDIT_CONSUMPTION',
        amountMinor: actualCostMinor,
        currency: 'USD',
        debitAccount: `tenant:${reservation.organizationId}:credit_balance`,
        creditAccount: 'platform:recognized_usage_revenue',
        usageEventId: usageEvent.usageEventId,
        invoiceId: null,
        paymentEventId: null,
        idempotencyKey: `ledger:${usageEvent.usageEventId}`,
        note: `Authoritative metering ${usageEvent.billableDurationMs}ms on ${params.modelId}`,
        createdAtIso: reservation.settledAtIso,
      });
    }

    return usageEvent;
  }

  /**
   * Issues an immutable invoice snapshot (Section 11.8 & 20.11).
   * Subsequent plan price changes never mutate an already issued invoice.
   */
  public issueMonthlyStatementInvoice(organizationId: string, taxBasisPoints = 0): ImmutableInvoiceRecord {
    const sub = this.subscriptions.get(organizationId);
    if (!sub) throw new Error('SUBSCRIPTION_NOT_FOUND');
    const plan = PHASE10_VERSIONED_PLAN_CATALOG.find((p) => p.planId === sub.planId)!;

    const committedEvents = Array.from(this.usageEvents.values()).filter(
      (e) => e.organizationId === organizationId && e.meteringState === 'COMMITTED'
    );
    const totalBilledSeconds = Math.ceil(
      committedEvents.reduce((sum, e) => sum + e.billableDurationMs, 0) / 1000
    );

    const calc = computeIntegerOverageChargeMinor({
      billedAudioSeconds: totalBilledSeconds,
      includedAudioMinutes: plan.includedAudioMinutes,
      overageRateMinorPerMinute: plan.overageRateMinorPerMinute,
    });

    const subtotalMinor = plan.subscriptionPriceMinor + calc.overageChargeMinor;
    const taxMinor = Math.round((subtotalMinor * taxBasisPoints) / 10000);
    const totalMinor = subtotalMinor + taxMinor;

    const snapshot = {
      planId: plan.planId,
      planVersion: plan.planVersion,
      includedMinutes: plan.includedAudioMinutes,
      billedAudioMinutes: calc.billedMinutesWholeUpOrExactFloor,
      overageMinutes: calc.overageMinutes,
      unitRateMinorPerMinute: plan.overageRateMinorPerMinute,
    };

    const snapshotSha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(snapshot), 'utf8')
      .digest('hex');

    const now = new Date();
    const due = new Date(now.getTime() + 14 * 86400_000);
    const invoiceNumber = `INV-${now.getUTCFullYear()}-${String(this.invoiceSeq++).padStart(6, '0')}`;

    const invoice: ImmutableInvoiceRecord = {
      invoiceId: `inv_${crypto.randomUUID()}`,
      organizationId,
      invoiceNumber,
      pricingSnapshot: snapshot,
      subtotalMinor,
      taxMinor,
      discountMinor: 0,
      totalMinor,
      currency: 'USD',
      issueDateIso: now.toISOString(),
      dueDateIso: due.toISOString(),
      status: 'ISSUED',
      snapshotSha256,
    };

    this.invoices.set(invoice.invoiceId, invoice);
    return invoice;
  }

  /**
   * Section 11.7 & 19.5: Payment Webhook Signature + Timestamp + Replay Guard.
   */
  public verifyAndProcessPaymentWebhook(params: {
    providerEventId: string;
    organizationId: string;
    amountMinor: number;
    timestampEpochSec: number;
    payloadJson: string;
    signatureHex: string;
    webhookSecret: string;
    nowEpochSec?: number;
  }): { accepted: boolean; reason: string; duplicateReplay: boolean } {
    const nowSec = params.nowEpochSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - params.timestampEpochSec) > 300) {
      return { accepted: false, reason: 'PAYMENT_WEBHOOK_TIMESTAMP_EXPIRED', duplicateReplay: false };
    }

    const expectedSig = crypto
      .createHmac('sha256', params.webhookSecret)
      .update(`${params.timestampEpochSec}.${params.payloadJson}`, 'utf8')
      .digest('hex');

    if (
      params.signatureHex.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(params.signatureHex), Buffer.from(expectedSig))
    ) {
      return { accepted: false, reason: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID', duplicateReplay: false };
    }

    const uniqueKey = `psp:${params.providerEventId}`;
    if (this.processedPaymentEvents.has(uniqueKey)) {
      return { accepted: true, reason: 'DUPLICATE_PAYMENT_EVENT_IDEMPOTENT', duplicateReplay: true };
    }
    this.processedPaymentEvents.add(uniqueKey);

    const sub = this.subscriptions.get(params.organizationId);
    if (!sub) {
      return { accepted: false, reason: 'ORGANIZATION_NOT_FOUND', duplicateReplay: false };
    }

    sub.availableCreditMinor += Math.max(0, Math.round(params.amountMinor));
    this.ledgerEntries.push({
      ledgerEntryId: `ldg_${crypto.randomUUID()}`,
      organizationId: params.organizationId,
      transactionType: 'CREDIT_PURCHASE',
      amountMinor: Math.max(0, Math.round(params.amountMinor)),
      currency: 'USD',
      debitAccount: 'psp:settled_settlement_account',
      creditAccount: `tenant:${params.organizationId}:credit_balance`,
      usageEventId: null,
      invoiceId: null,
      paymentEventId: params.providerEventId,
      idempotencyKey: uniqueKey,
      note: 'Verified payment webhook credit top-up',
      createdAtIso: new Date().toISOString(),
    });

    return { accepted: true, reason: 'PAYMENT_CREDITED_VIA_IMMUTABLE_LEDGER', duplicateReplay: false };
  }

  public reconcileUsageAndBillingLedger(organizationId: string): {
    balanced: boolean;
    usageEventTotalMinor: number;
    ledgerConsumptionMinor: number;
    discrepancyMinor: number;
    eventCount: number;
  } {
    const usageTotal = Array.from(this.usageEvents.values())
      .filter((u) => u.organizationId === organizationId && u.meteringState === 'COMMITTED')
      .reduce((acc, u) => acc + u.actualCostMinor, 0);

    const ledgerTotal = this.ledgerEntries
      .filter((l) => l.organizationId === organizationId && l.transactionType === 'CREDIT_CONSUMPTION')
      .reduce((acc, l) => acc + l.amountMinor, 0);

    const eventCount = Array.from(this.usageEvents.values()).filter(
      (u) => u.organizationId === organizationId
    ).length;

    return {
      balanced: usageTotal === ledgerTotal,
      usageEventTotalMinor: usageTotal,
      ledgerConsumptionMinor: ledgerTotal,
      discrepancyMinor: usageTotal - ledgerTotal,
      eventCount,
    };
  }

  // ── Webhook Platform (Section 13) ─────────────────────────────────────────
  public registerWebhookEndpoint(params: {
    organizationId: string;
    url: string;
    eventSubscriptions: PublicWebhookEventType[];
    actorId?: string;
  }): WebhookEndpointRecord {
    const signingSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const ep: WebhookEndpointRecord = {
      endpointId: `wh_${crypto.randomBytes(6).toString('hex')}`,
      organizationId: params.organizationId,
      url: params.url.trim(),
      eventSubscriptions: params.eventSubscriptions,
      signingSecret,
      active: true,
      createdAtIso: new Date().toISOString(),
    };
    this.webhookEndpoints.set(ep.endpointId, ep);
    this.recordAuditLog({
      organizationId: params.organizationId,
      actorType: 'USER',
      actorId: params.actorId ?? 'usr_studio_owner_01',
      action: 'WEBHOOK_ENDPOINT_REGISTERED',
      resourceType: 'webhook_endpoint',
      resourceId: ep.endpointId,
      outcome: 'ALLOWED',
      reason: `Events=${ep.eventSubscriptions.join(',')}`,
    });
    return ep;
  }

  public signWebhookPayload(secret: string, timestampEpochSec: number, payloadJson: string): string {
    const mac = crypto
      .createHmac('sha256', secret)
      .update(`${timestampEpochSec}.${payloadJson}`, 'utf8')
      .digest('hex');
    return `t=${timestampEpochSec},v1=${mac}`;
  }

  public verifyWebhookSignatureHeader(params: {
    secret: string;
    signatureHeader: string;
    payloadJson: string;
    nowEpochSec?: number;
    maxToleranceSeconds?: number;
  }): { valid: boolean; reason: string } {
    const parts = Object.fromEntries(
      params.signatureHeader.split(',').map((kv) => kv.split('='))
    ) as { t?: string; v1?: string };

    const ts = Number(parts.t);
    if (!Number.isFinite(ts) || !parts.v1) {
      return { valid: false, reason: 'MALFORMED_SIGNATURE_HEADER' };
    }
    const nowSec = params.nowEpochSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > (params.maxToleranceSeconds ?? 300)) {
      return { valid: false, reason: 'WEBHOOK_SIGNATURE_EXPIRED' };
    }

    const expected = crypto
      .createHmac('sha256', params.secret)
      .update(`${ts}.${params.payloadJson}`, 'utf8')
      .digest('hex');
    if (
      parts.v1.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))
    ) {
      return { valid: false, reason: 'WEBHOOK_HMAC_MISMATCH' };
    }
    return { valid: true, reason: 'SIGNATURE_VALID' };
  }

  public dispatchWebhookEvent(params: {
    organizationId: string;
    eventType: PublicWebhookEventType;
    data: Record<string, unknown>;
    simulateFailureForTesting?: boolean;
  }): WebhookDeliveryRecord[] {
    const endpoints = Array.from(this.webhookEndpoints.values()).filter(
      (e) =>
        e.organizationId === params.organizationId &&
        e.active &&
        e.eventSubscriptions.includes(params.eventType)
    );
    const created: WebhookDeliveryRecord[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const eventId = `evt_${crypto.randomUUID()}`;
    const payloadJson = JSON.stringify({
      id: eventId,
      type: params.eventType,
      created_at: new Date().toISOString(),
      tenant_id: params.organizationId,
      data: params.data,
    });

    for (const ep of endpoints) {
      const signatureHeader = this.signWebhookPayload(ep.signingSecret, nowSec, payloadJson);
      const isLocalSandboxUrl = ep.url.includes('.local');
      const failed = Boolean(params.simulateFailureForTesting);

      const rec: WebhookDeliveryRecord = {
        deliveryId: `whd_${crypto.randomUUID()}`,
        endpointId: ep.endpointId,
        eventId,
        eventType: params.eventType,
        organizationId: params.organizationId,
        attemptNumber: failed ? 6 : 1,
        maxAttempts: WEBHOOK_RETRY_DELAYS_SECONDS.length,
        status: failed ? 'DEAD_LETTER' : isLocalSandboxUrl ? 'DELIVERED' : 'RETRY_SCHEDULED',
        httpStatus: failed ? 503 : isLocalSandboxUrl ? 200 : null,
        signatureHeader,
        payloadJson,
        nextRetryAtIso: failed
          ? null
          : isLocalSandboxUrl
          ? null
          : new Date(Date.now() + WEBHOOK_RETRY_DELAYS_SECONDS[0] * 1000).toISOString(),
        lastErrorSafe: failed
          ? 'HTTP 503 after 6 attempts (moved to Dead-Letter Queue)'
          : isLocalSandboxUrl
          ? null
          : 'External outbound delivery queued (requires live network worker)',
        deliveredAtIso: !failed && isLocalSandboxUrl ? new Date().toISOString() : null,
        createdAtIso: new Date().toISOString(),
      };
      this.webhookDeliveries.push(rec);
      created.push(rec);
    }
    return created;
  }

  public replayDeadLetterWebhook(deliveryId: string, organizationId: string): WebhookDeliveryRecord {
    const target = this.webhookDeliveries.find(
      (d) => d.deliveryId === deliveryId && d.organizationId === organizationId
    );
    if (!target) throw new Error('TENANT_ISOLATION_DENIED: Delivery not found in organization');
    const ep = this.webhookEndpoints.get(target.endpointId);
    if (!ep) throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');

    const nowSec = Math.floor(Date.now() / 1000);
    const replayed: WebhookDeliveryRecord = {
      ...target,
      deliveryId: `whd_${crypto.randomUUID()}`,
      attemptNumber: 1,
      status: 'DELIVERED',
      httpStatus: 200,
      signatureHeader: this.signWebhookPayload(ep.signingSecret, nowSec, target.payloadJson),
      lastErrorSafe: null,
      deliveredAtIso: new Date().toISOString(),
      createdAtIso: new Date().toISOString(),
    };
    this.webhookDeliveries.push(replayed);
    return replayed;
  }

  // ── Snapshot Views for Customer Portal & Governance ───────────────────────
  public getPortalOverview(organizationId = 'org_avapardaz_sandbox') {
    const org = this.organizations.get(organizationId);
    const sub = this.subscriptions.get(organizationId);
    const plan = sub ? PHASE10_VERSIONED_PLAN_CATALOG.find((p) => p.planId === sub.planId) : null;
    const projects = this.listProjects(organizationId);
    const credentials = this.listApiKeys(organizationId);
    const usage = Array.from(this.usageEvents.values()).filter(
      (u) => u.organizationId === organizationId
    );
    const ledger = this.ledgerEntries.filter((l) => l.organizationId === organizationId);
    const invoices = Array.from(this.invoices.values()).filter(
      (inv) => inv.organizationId === organizationId
    );
    const webhooks = Array.from(this.webhookEndpoints.values())
      .filter((w) => w.organizationId === organizationId)
      .map(({ signingSecret: _sec, ...rest }) => ({
        ...rest,
        signingSecretMasked: `${_sec.slice(0, 10)}...****`,
      }));
    const deliveries = this.webhookDeliveries.filter((d) => d.organizationId === organizationId);
    const reconciliation = this.reconcileUsageAndBillingLedger(organizationId);

    return {
      organization: org ?? null,
      subscription: sub ?? null,
      plan: plan ?? null,
      projects,
      credentials,
      usageEvents: usage,
      ledgerEntries: ledger,
      invoices,
      webhookEndpoints: webhooks,
      webhookDeliveries: deliveries,
      reconciliation,
      regions: PHASE10_REGION_REGISTRY,
      models: PHASE10_PUBLIC_MODEL_CATALOG,
      auditLogs: this.listAuditLogs(organizationId).slice(-25),
    };
  }
}

export const GLOBAL_PLATFORM_CONTROL_PLANE = new PlatformControlPlaneService();
