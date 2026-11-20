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
import {
  ALL_PLATFORM_SCOPES,
  ALL_PUBLIC_WEBHOOK_EVENTS,
  type ApiCredentialIssuedResponse,
  type ApiCredentialRecord,
  type ApiCredentialScope,
  type AuthoritativeUsageEvent,
  type ImmutableBillingLedgerEntry,
  type ImmutableInvoiceRecord,
  type OrganizationInvitation,
  type OrganizationMembership,
  type OrganizationRole,
  type PlanTierId,
  type PlatformApiErrorEnvelope,
  type PlatformAuditLogEntry,
  type PlatformErrorCode,
  type PlatformOrganization,
  type PlatformPlanCatalogEntry,
  type PlatformProject,
  type PlatformRegionRecord,
  type PlatformUser,
  type PublicModelCatalogEntry,
  type PublicWebhookEventType,
  type TenantSubscriptionRecord,
  type UsageReservationRecord,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
} from './PlatformContractsAndSchemas';
import {
  MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION,
  validateWebhookEventSubscriptions,
} from './PlatformWebhookSecurity';

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
    availabilityInCurrentContainer: 'MODEL_NOT_INSTALLED',
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
    availabilityInCurrentContainer: 'MODEL_NOT_INSTALLED',
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

/**
 * Server-side scope delegation ceilings per organization role (AVP-011 §7).
 * No caller may delegate a scope exceeding their role's permitted delegation boundary.
 */
export const ROLE_DELEGATABLE_SCOPES: Readonly<
  Record<OrganizationRole, ReadonlySet<ApiCredentialScope>>
> = Object.freeze({
  OWNER: new Set<ApiCredentialScope>(ALL_PLATFORM_SCOPES),
  ADMIN: new Set<ApiCredentialScope>(
    Array.from(ALL_PLATFORM_SCOPES).filter((s) => s !== 'billing:write'),
  ),
  BILLING_ADMIN: new Set<ApiCredentialScope>([
    'platform:read',
    'billing:read',
    'billing:write',
    'usage:read',
    'projects:read',
  ]),
  DEVELOPER: new Set<ApiCredentialScope>([
    'audio:transcribe',
    'audio:stream',
    'audio:read',
    'transcripts:read',
    'usage:read',
    'projects:read',
    'webhooks:manage',
    'models:read',
    'models:write',
    'models:approve',
    'models:deploy',
    'security:read',
    'security:write',
    'privacy:write',
  ]),
  ANALYST: new Set<ApiCredentialScope>([
    'platform:read',
    'projects:read',
    'usage:read',
    'models:read',
    'transcripts:read',
    'security:read',
  ]),
  SECURITY_AUDITOR: new Set<ApiCredentialScope>([
    'platform:read',
    'projects:read',
    'usage:read',
    'models:read',
    'security:read',
    'security:write',
    'security:audit',
    'security:admin',
    'privacy:write',
  ]),
  VIEWER: new Set<ApiCredentialScope>([
    'projects:read',
    'usage:read',
    'models:read',
    'security:read',
  ]),
});

export function validateRequestedScopes(
  rawScopes: unknown,
):
  | { readonly valid: true; readonly scopes: ApiCredentialScope[] }
  | { readonly valid: false; readonly message: string } {
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
    return { valid: false, message: 'scopes must be a non-empty array of valid platform scopes.' };
  }
  const seen = new Set<ApiCredentialScope>();
  const validated: ApiCredentialScope[] = [];
  for (const item of rawScopes) {
    if (typeof item !== 'string' || item.trim() !== item || item.length === 0) {
      return { valid: false, message: 'Malformed scope entry rejected.' };
    }
    if (item === '*') {
      return { valid: false, message: "Wildcard scope '*' is strictly forbidden." };
    }
    if (!ALL_PLATFORM_SCOPES.has(item as ApiCredentialScope)) {
      return { valid: false, message: `Unknown scope '${item}' rejected.` };
    }
    const typed = item as ApiCredentialScope;
    if (seen.has(typed)) {
      return { valid: false, message: `Duplicate scope '${typed}' rejected.` };
    }
    seen.add(typed);
    validated.push(typed);
  }
  return { valid: true, scopes: validated };
}

export function validateScopeDelegation(params: {
  readonly issuerRole: OrganizationRole;
  readonly requestedScopes: readonly ApiCredentialScope[];
}): { readonly allowed: true } | { readonly allowed: false; readonly deniedScopes: ApiCredentialScope[] } {
  const ceiling = ROLE_DELEGATABLE_SCOPES[params.issuerRole];
  if (!ceiling) {
    return { allowed: false, deniedScopes: [...params.requestedScopes] };
  }
  const denied = params.requestedScopes.filter((s) => !ceiling.has(s));
  if (denied.length > 0) {
    return { allowed: false, deniedScopes: denied };
  }
  return { allowed: true };
}

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
  private readonly invoiceByOrgPeriod = new Map<string, string>();
  private readonly processedPaymentEvents = new Set<string>();
  private readonly webhookEndpoints = new Map<string, WebhookEndpointRecord>();
  private readonly webhookDeliveries: WebhookDeliveryRecord[] = [];
  private readonly auditLogs: PlatformAuditLogEntry[] = [];
  private readonly rateLimiter = new ScopedTokenBucketLimiter();
  private invoiceSeq = 1001;

  constructor(options?: { serverPepper?: string; nodeEnv?: string }) {
    const nodeEnv = (options?.nodeEnv ?? process.env.NODE_ENV ?? 'development')
      .trim()
      .toLowerCase();
    const configuredPepper = options?.serverPepper ?? process.env.API_KEY_PEPPER ?? '';
    const legacyPlaceholders = new Set([
      'avapardaz-local-dev-pepper-configure-secret',
      'avapardaz-local-dev-pepper-configure-secret-in-prod',
    ]);

    if (nodeEnv === 'production') {
      if (
        !configuredPepper ||
        legacyPlaceholders.has(configuredPepper) ||
        Buffer.byteLength(configuredPepper, 'utf8') < 32
      ) {
        throw new Error(
          'PRODUCTION_API_KEY_PEPPER_INVALID: API_KEY_PEPPER must be configured with at least 32 bytes of cryptographically random secret material in production.',
        );
      }
      this.serverPepper = configuredPepper;
    } else if (configuredPepper && !legacyPlaceholders.has(configuredPepper)) {
      this.serverPepper = configuredPepper;
    } else {
      // Development-only process-specific cryptographically random pepper (never hardcoded)
      this.serverPepper = crypto.randomBytes(32).toString('hex');
    }

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

  public createUser(params: {
    id?: string;
    email: string;
    displayName: string;
    accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  }): PlatformUser {
    const user: PlatformUser = {
      id: params.id ?? `usr_${crypto.randomBytes(6).toString('hex')}`,
      email: params.email.trim().toLowerCase(),
      emailVerified: true,
      displayName: params.displayName.trim() || params.email,
      identityProvider: 'local_password',
      mfaEnabled: true,
      accountStatus: params.accountStatus ?? 'ACTIVE',
      createdAtIso: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  public getUser(userId: string): PlatformUser | null {
    return this.users.get(userId) ?? null;
  }

  public setUserAccountStatus(
    userId: string,
    accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETED'
  ): PlatformUser {
    const user = this.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    user.accountStatus = accountStatus;
    return user;
  }

  public setOrganizationStatus(
    organizationId: string,
    organizationStatus: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED'
  ): PlatformOrganization {
    const org = this.organizations.get(organizationId);
    if (!org) throw new Error('ORGANIZATION_NOT_FOUND');
    org.organizationStatus = organizationStatus;
    return org;
  }

  public setOrganizationMembership(params: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
    membershipStatus?: 'ACTIVE' | 'REVOKED';
  }): OrganizationMembership {
    const org = this.organizations.get(params.organizationId);
    if (!org) throw new Error('ORGANIZATION_NOT_FOUND');
    const existing = this.memberships.find(
      (m) => m.organizationId === params.organizationId && m.userId === params.userId
    );
    if (existing) {
      existing.role = params.role;
      existing.membershipStatus = params.membershipStatus ?? 'ACTIVE';
      return existing;
    }
    const created: OrganizationMembership = {
      organizationId: params.organizationId,
      userId: params.userId,
      role: params.role,
      membershipStatus: params.membershipStatus ?? 'ACTIVE',
      createdAtIso: new Date().toISOString(),
    };
    this.memberships.push(created);
    return created;
  }

  public revokeOrganizationMembership(organizationId: string, userId: string): boolean {
    const existing = this.memberships.find(
      (m) => m.organizationId === organizationId && m.userId === userId
    );
    if (!existing) return false;
    existing.membershipStatus = 'REVOKED';
    return true;
  }

  public getOrganizationMembership(
    organizationId: string,
    userId: string
  ): OrganizationMembership | null {
    return (
      this.memberships.find(
        (m) => m.organizationId === organizationId && m.userId === userId
      ) ?? null
    );
  }

  public appendOrganizationMembershipRecord(record: OrganizationMembership): OrganizationMembership {
    this.memberships.push({ ...record });
    return record;
  }

  public hasRolePermission(organizationId: string, userId: string, requiredPermission: string): boolean {
    const user = this.users.get(userId);
    if (!user || user.accountStatus !== 'ACTIVE') return false;
    const org = this.organizations.get(organizationId);
    if (!org || org.organizationStatus !== 'ACTIVE') return false;
    const activeMemberships = this.memberships.filter(
      (m) => m.organizationId === organizationId && m.userId === userId && m.membershipStatus === 'ACTIVE'
    );
    if (activeMemberships.length !== 1) return false;
    const perms = ROLE_PERMISSION_MATRIX[activeMemberships[0].role] ?? [];
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
    if (!this.users.has(params.userId)) {
      this.users.set(params.userId, {
        id: params.userId,
        email: params.email.trim().toLowerCase(),
        emailVerified: true,
        displayName: params.email.trim().toLowerCase(),
        identityProvider: 'local_password',
        mfaEnabled: false,
        accountStatus: 'ACTIVE',
        createdAtIso: inv.consumedAtIso,
      });
    }
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
    const ownerUserId = params.ownerUserId ?? 'usr_studio_owner_01';
    if (!this.users.has(ownerUserId)) {
      this.users.set(ownerUserId, {
        id: ownerUserId,
        email: `${ownerUserId}@avapardaz.local`,
        emailVerified: true,
        displayName: ownerUserId,
        identityProvider: 'local_password',
        mfaEnabled: true,
        accountStatus: 'ACTIVE',
        createdAtIso: now,
      });
    }
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
      userId: ownerUserId,
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
      actorId: params.actorUserId ?? 'system_seed',
      action: 'PROJECT_CREATED',
      resourceType: 'project',
      resourceId: prj.id,
      outcome: 'ALLOWED',
      reason: `Environment=${prj.environment}`,
    });
    return prj;
  }

  public getOrganization(organizationId: string): PlatformOrganization | null {
    return this.organizations.get(organizationId) ?? null;
  }

  public getProject(projectId: string): PlatformProject | null {
    return this.projects.get(projectId) ?? null;
  }

  public getSubscription(organizationId: string): TenantSubscriptionRecord | null {
    return this.subscriptions.get(organizationId) ?? null;
  }

  public getCredentialMetadata(
    credentialId: string,
  ): Omit<ApiCredentialRecord, 'secretHash'> | null {
    const rec = this.credentials.get(credentialId);
    if (!rec) return null;
    const { secretHash: _s, ...rest } = rec;
    return rest;
  }

  public getWebhookDelivery(deliveryId: string): WebhookDeliveryRecord | null {
    return this.webhookDeliveries.find((d) => d.deliveryId === deliveryId) ?? null;
  }

  public hasActiveOwnerKeyWithManageScope(organizationId: string): boolean {
    const nowMs = Date.now();
    for (const cred of this.credentials.values()) {
      if (cred.organizationId !== organizationId) continue;
      if (cred.revokedAtIso) continue;
      if (cred.expiresAtIso && new Date(cred.expiresAtIso).getTime() <= nowMs) continue;
      if (cred.overlapRevokesAtIso && new Date(cred.overlapRevokesAtIso).getTime() <= nowMs) {
        continue;
      }
      if (!cred.scopes.includes('api-keys:manage')) continue;
      const activeOwnerMemberships = this.memberships.filter(
        (m) =>
          m.organizationId === organizationId &&
          m.userId === cred.principalId &&
          m.membershipStatus === 'ACTIVE' &&
          m.role === 'OWNER',
      );
      if (activeOwnerMemberships.length === 1) {
        return true;
      }
    }
    return false;
  }

  public listProjects(organizationId: string): PlatformProject[] {
    return Array.from(this.projects.values()).filter((p) => p.organizationId === organizationId);
  }

  /**
   * Issues an API credential with public identifier + high-entropy random secret.
   * NEVER stores plaintext secret; returns `plaintextSecretOnce` strictly on creation.
   *
   * Security guarantees (AVP-011 §2 & §7):
   * - Requires an explicit validated `principalId` (no implicit `'usr_studio_owner_01'` default).
   * - Verifies active user, active organization, unambiguous single ACTIVE membership, and project ownership.
   * - Validates every scope against `ALL_PLATFORM_SCOPES` (rejects unknown, duplicate, empty, or `'*'`).
   * - Enforces integer `expiresInDays` within [1, 365] when provided.
   */
  public issueApiKey(params: {
    organizationId: string;
    projectId: string;
    name: string;
    scopes: ApiCredentialScope[];
    expiresInDays?: number;
    expiresAtIso?: string | null;
    requireFiniteExpiration?: boolean;
    allowedIpCidrs?: string[];
    principalId: string;
    actorUserId?: string;
    issuerRole?: OrganizationRole;
  }): ApiCredentialIssuedResponse {
    const org = this.organizations.get(params.organizationId);
    if (!org || org.organizationStatus !== 'ACTIVE') {
      throw new Error('ORGANIZATION_INACTIVE_OR_NOT_FOUND');
    }

    const project = this.projects.get(params.projectId);
    if (!project || project.organizationId !== params.organizationId) {
      throw new Error('TENANT_ISOLATION_DENIED: Project does not belong to organization');
    }
    if (project.status !== 'ACTIVE') {
      throw new Error('PROJECT_INACTIVE');
    }

    if (typeof params.principalId !== 'string' || params.principalId.trim().length === 0) {
      throw new Error('PRINCIPAL_ID_REQUIRED: Explicit validated principalId is mandatory.');
    }
    const boundPrincipalId = params.principalId.trim();

    const user = this.users.get(boundPrincipalId);
    if (!user || user.accountStatus !== 'ACTIVE') {
      throw new Error('PRINCIPAL_NOT_ACTIVE: Principal does not exist or is not ACTIVE.');
    }

    const activeMemberships = this.memberships.filter(
      (m) =>
        m.organizationId === params.organizationId &&
        m.userId === boundPrincipalId &&
        m.membershipStatus === 'ACTIVE',
    );
    if (activeMemberships.length !== 1) {
      throw new Error(
        'MEMBERSHIP_INVALID: Principal must have exactly one ACTIVE membership in target organization.',
      );
    }

    const scopeCheck = validateRequestedScopes(params.scopes);
    if (!scopeCheck.valid) {
      throw new Error(`INVALID_SCOPES: ${scopeCheck.message}`);
    }

    if (params.issuerRole) {
      const delegation = validateScopeDelegation({
        issuerRole: params.issuerRole,
        requestedScopes: scopeCheck.scopes,
      });
      if (!delegation.allowed) {
        throw new Error(
          `SCOPE_DELEGATION_DENIED: Requested scopes exceed issuer role policy (${delegation.deniedScopes.join(', ')}).`,
        );
      }
    }

    let expiresAtIso: string | null;
    if (params.expiresAtIso !== undefined) {
      if (params.expiresAtIso === null) {
        if (params.requireFiniteExpiration) {
          throw new Error('INVALID_EXPIRATION: Indefinite credential expiration is not permitted.');
        }
        expiresAtIso = null;
      } else {
        const parsedMs = new Date(params.expiresAtIso).getTime();
        if (!Number.isFinite(parsedMs)) {
          throw new Error('INVALID_EXPIRATION: Malformed expiresAtIso timestamp.');
        }
        expiresAtIso = new Date(parsedMs).toISOString();
      }
    } else if (params.expiresInDays !== undefined) {
      if (
        typeof params.expiresInDays !== 'number' ||
        !Number.isInteger(params.expiresInDays) ||
        params.expiresInDays < 1 ||
        params.expiresInDays > 365
      ) {
        throw new Error(
          'INVALID_EXPIRATION: expiresInDays must be an integer between 1 and 365.',
        );
      }
      expiresAtIso = new Date(Date.now() + params.expiresInDays * 86400_000).toISOString();
    } else {
      if (params.requireFiniteExpiration) {
        throw new Error(
          'INVALID_EXPIRATION: expiresInDays (integer 1..365) is required for issued credentials.',
        );
      }
      expiresAtIso = null;
    }

    const prefix: 'asr_live' | 'asr_test' =
      project.environment === 'PRODUCTION' ? 'asr_live' : 'asr_test';
    const publicId = crypto.randomBytes(6).toString('hex');
    const rawSecret = crypto.randomBytes(24).toString('base64url');
    const plaintextSecretOnce = `${prefix}_${publicId}_${rawSecret}`;
    const secretHash = this.hashSecretWithPepper(rawSecret);

    const nowIso = new Date().toISOString();
    const record: ApiCredentialRecord = {
      id: `cred_${crypto.randomBytes(6).toString('hex')}`,
      organizationId: params.organizationId,
      projectId: params.projectId,
      principalId: boundPrincipalId,
      name: params.name.trim() || 'Default API Credential',
      publicIdentifier: publicId,
      secretHash,
      keyPrefix: prefix,
      environment: project.environment,
      scopes: [...scopeCheck.scopes],
      allowedIpCidrs: params.allowedIpCidrs ?? [],
      expiresAtIso,
      overlapRevokesAtIso: null,
      lastUsedAtIso: null,
      revokedAtIso: null,
      createdAtIso: nowIso,
    };

    this.credentials.set(record.id, record);
    this.credentialsByPublicId.set(record.publicIdentifier, record);

    const actorId = params.actorUserId ?? boundPrincipalId;
    this.recordAuditLog({
      organizationId: params.organizationId,
      actorType: 'USER',
      actorId,
      action: 'API_KEY_ISSUED',
      resourceType: 'api_credential',
      resourceId: record.id,
      outcome: 'ALLOWED',
      reason: `Prefix=${prefix}, PublicId=${publicId}, PrincipalId=${boundPrincipalId}, Scopes=${record.scopes.join(',')}`,
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
   * Atomic Key Rotation (AVP-011 §8):
   * Creates and verifies the replacement credential FIRST (preserving principal, project,
   * environment, IP restrictions, scopes, and exact expiration), and ONLY THEN sets the
   * old credential's overlap-revocation timestamp.
   */
  public rotateApiKey(params: {
    credentialId: string;
    organizationId: string;
    overlapHours?: number;
    actorUserId?: string;
    issuerRole?: OrganizationRole;
  }): ApiCredentialIssuedResponse {
    const existing = this.credentials.get(params.credentialId);
    if (!existing || existing.organizationId !== params.organizationId) {
      throw new Error('TENANT_ISOLATION_DENIED: Credential not found in organization');
    }
    if (existing.revokedAtIso) {
      throw new Error('CREDENTIAL_ALREADY_REVOKED');
    }
    const nowMs = Date.now();
    if (existing.expiresAtIso && new Date(existing.expiresAtIso).getTime() <= nowMs) {
      throw new Error('CREDENTIAL_EXPIRED');
    }
    if (existing.overlapRevokesAtIso && new Date(existing.overlapRevokesAtIso).getTime() <= nowMs) {
      throw new Error('CREDENTIAL_OVERLAP_EXPIRED');
    }

    const overlapHours = params.overlapHours ?? 24;
    if (typeof overlapHours !== 'number' || !Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > 24) {
      throw new Error('INVALID_OVERLAP_HOURS: overlapHours must be a finite number between 0 and 24.');
    }

    const actorId = params.actorUserId ?? existing.principalId;

    // Step 4-6: Issue replacement FIRST, preserving principal, project, IP restrictions, scopes, and exact expiration.
    const replacement = this.issueApiKey({
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      principalId: existing.principalId,
      name: `${existing.name} (Rotated)`,
      scopes: [...existing.scopes],
      allowedIpCidrs: [...existing.allowedIpCidrs],
      expiresAtIso: existing.expiresAtIso,
      actorUserId: actorId,
      issuerRole: params.issuerRole,
    });

    if (!this.credentials.has(replacement.credential.id)) {
      throw new Error('CREDENTIAL_ROTATION_PERSISTENCE_FAILED');
    }

    // Step 7: Only AFTER replacement succeeded, schedule overlap expiration on old key
    existing.overlapRevokesAtIso = new Date(Date.now() + overlapHours * 3600_000).toISOString();

    this.recordAuditLog({
      organizationId: existing.organizationId,
      actorType: 'USER',
      actorId,
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
      actorId: params.actorUserId ?? existing.principalId,
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
   * checks expiration, overlap revocation, immediate revocation, active organization/project,
   * server-side principal & active organization membership (fail-closed, never inferring OWNER),
   * required scope(s), and rate limit.
   *
   * Never leaks whether a credential ID, user ID, or organization exists.
   */
  public authenticateApiKeyRequest(params: {
    bearerToken: string;
    requiredScope?: ApiCredentialScope | readonly ApiCredentialScope[];
    requiredProjectId?: string;
    requiredEnvironment?: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
    nowMs?: number;
  }):
    | {
        authenticated: true;
        organization: PlatformOrganization;
        project: PlatformProject;
        credential: Omit<ApiCredentialRecord, 'secretHash'>;
        principal: {
          readonly principalId: string;
          readonly role: OrganizationRole;
          readonly organizationId: string;
          readonly accountStatus: 'ACTIVE';
          readonly membershipStatus: 'ACTIVE';
        };
        rateLimit: { remaining: number; limit: number };
      }
    | {
        authenticated: false;
        httpStatus: number;
        reasonCode:
          | 'DENIED_UNAUTHENTICATED'
          | 'DENIED_PRINCIPAL_DISABLED'
          | 'DENIED_ORGANIZATION_INACTIVE'
          | 'DENIED_MEMBERSHIP_MISSING_OR_REVOKED'
          | 'DENIED_MEMBERSHIP_AMBIGUOUS'
          | 'DENIED_INSUFFICIENT_CREDENTIAL_SCOPE'
          | 'DENIED_TENANT_BOUNDARY_MISMATCH'
          | 'DENIED_RATE_LIMITED';
        errorEnvelope: PlatformApiErrorEnvelope;
      } {
    const nowMs = params.nowMs ?? Date.now();
    const rawHeader = typeof params.bearerToken === 'string' ? params.bearerToken : '';
    const token = rawHeader.replace(/^Bearer\s+/i, '').trim();
    const match = token.match(/^(asr_live|asr_test)_([a-f0-9]+)_(.+)$/);
    const uniformAuthFailure = (): {
      authenticated: false;
      httpStatus: number;
      reasonCode: 'DENIED_UNAUTHENTICATED';
      errorEnvelope: PlatformApiErrorEnvelope;
    } => ({
      authenticated: false,
      httpStatus: 401,
      reasonCode: 'DENIED_UNAUTHENTICATED',
      errorEnvelope: buildPlatformErrorEnvelope({
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication failed.',
      }),
    });

    if (!match) {
      return uniformAuthFailure();
    }

    const [, prefix, publicId, rawSecret] = match;
    const cred = this.credentialsByPublicId.get(publicId);
    if (!cred || cred.keyPrefix !== prefix) {
      return uniformAuthFailure();
    }

    const computedHash = this.hashSecretWithPepper(rawSecret);
    const computedBuf = Buffer.from(computedHash);
    const storedBuf = Buffer.from(cred.secretHash);
    if (computedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(computedBuf, storedBuf)) {
      return uniformAuthFailure();
    }

    if (cred.revokedAtIso) {
      return uniformAuthFailure();
    }

    if (cred.overlapRevokesAtIso && new Date(cred.overlapRevokesAtIso).getTime() <= nowMs) {
      return uniformAuthFailure();
    }

    if (cred.expiresAtIso && new Date(cred.expiresAtIso).getTime() <= nowMs) {
      return uniformAuthFailure();
    }

    const project = this.projects.get(cred.projectId);
    const org = this.organizations.get(cred.organizationId);
    if (!project || !org || project.organizationId !== org.id) {
      return {
        authenticated: false,
        httpStatus: 403,
        reasonCode: 'DENIED_TENANT_BOUNDARY_MISMATCH',
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'TENANT_ISOLATION_DENIED',
          message: 'Organization or project boundary invalid.',
        }),
      };
    }

    if (org.organizationStatus !== 'ACTIVE' || project.status !== 'ACTIVE') {
      return {
        authenticated: false,
        httpStatus: 403,
        reasonCode: 'DENIED_ORGANIZATION_INACTIVE',
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Authorization denied.',
          details: { reasonCode: 'DENIED_ORGANIZATION_INACTIVE' },
        }),
      };
    }

    // Resolve bound server-side principal and single unambiguous active organization membership (fail-closed).
    const user = this.users.get(cred.principalId);
    if (!user || user.accountStatus !== 'ACTIVE') {
      return {
        authenticated: false,
        httpStatus: 403,
        reasonCode: 'DENIED_PRINCIPAL_DISABLED',
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Authorization denied.',
          details: { reasonCode: 'DENIED_PRINCIPAL_DISABLED' },
        }),
      };
    }

    const activeMemberships = this.memberships.filter(
      (m) =>
        m.organizationId === org.id &&
        m.userId === user.id &&
        m.membershipStatus === 'ACTIVE'
    );
    if (activeMemberships.length === 0) {
      return {
        authenticated: false,
        httpStatus: 403,
        reasonCode: 'DENIED_MEMBERSHIP_MISSING_OR_REVOKED',
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Authorization denied.',
          details: { reasonCode: 'DENIED_MEMBERSHIP_MISSING_OR_REVOKED' },
        }),
      };
    }
    if (activeMemberships.length > 1) {
      return {
        authenticated: false,
        httpStatus: 403,
        reasonCode: 'DENIED_MEMBERSHIP_AMBIGUOUS',
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Authorization denied.',
          details: { reasonCode: 'DENIED_MEMBERSHIP_AMBIGUOUS' },
        }),
      };
    }
    const membership = activeMemberships[0];

    if (params.requiredProjectId && params.requiredProjectId !== project.id) {
      return {
        authenticated: false,
        httpStatus: 403,
        reasonCode: 'DENIED_TENANT_BOUNDARY_MISMATCH',
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
        reasonCode: 'DENIED_INSUFFICIENT_CREDENTIAL_SCOPE',
        errorEnvelope: buildPlatformErrorEnvelope({
          code: 'INSUFFICIENT_SCOPE',
          message: 'Credential environment is not permitted for this operation.',
        }),
      };
    }

    if (params.requiredScope !== undefined) {
      const acceptedScopes = Array.isArray(params.requiredScope)
        ? params.requiredScope
        : [params.requiredScope];
      const hasScope = acceptedScopes.some((scope) => cred.scopes.includes(scope));
      if (!hasScope) {
        return {
          authenticated: false,
          httpStatus: 403,
          reasonCode: 'DENIED_INSUFFICIENT_CREDENTIAL_SCOPE',
          errorEnvelope: buildPlatformErrorEnvelope({
            code: 'INSUFFICIENT_SCOPE',
            message: 'Credential lacks required scope for this operation.',
            details: { reasonCode: 'DENIED_INSUFFICIENT_CREDENTIAL_SCOPE' },
          }),
        };
      }
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
        reasonCode: 'DENIED_RATE_LIMITED',
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
      principal: {
        principalId: user.id,
        role: membership.role,
        organizationId: org.id,
        accountStatus: 'ACTIVE',
        membershipStatus: 'ACTIVE',
      },
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
   * Issues an immutable invoice snapshot (Section 11.8 & 20.11 & AVP-011 §11).
   * Idempotent per (organizationId, billingPeriod): concurrent or repeated requests for the
   * same billing period return the original immutable snapshot without creating duplicates.
   */
  public issueMonthlyStatementInvoice(
    organizationId: string,
    taxBasisPoints = 0,
    options?: { actorUserId?: string; billingPeriodKey?: string },
  ): ImmutableInvoiceRecord {
    const sub = this.subscriptions.get(organizationId);
    if (!sub) throw new Error('SUBSCRIPTION_NOT_FOUND');
    const plan = PHASE10_VERSIONED_PLAN_CATALOG.find((p) => p.planId === sub.planId)!;

    if (!Number.isInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > 5000) {
      throw new Error('INVALID_TAX_BASIS_POINTS');
    }

    const periodKey =
      options?.billingPeriodKey ??
      `${sub.currentPeriodStartIso.slice(0, 10)}_${sub.currentPeriodEndIso.slice(0, 10)}`;
    const orgPeriodKey = `${organizationId}::${periodKey}`;
    const existingInvoiceId = this.invoiceByOrgPeriod.get(orgPeriodKey);
    if (existingInvoiceId) {
      const existing = this.invoices.get(existingInvoiceId);
      if (existing) {
        return existing;
      }
    }

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
    this.invoiceByOrgPeriod.set(orgPeriodKey, invoice.invoiceId);
    if (options?.actorUserId) {
      this.recordAuditLog({
        organizationId,
        actorType: 'USER',
        actorId: options.actorUserId,
        action: 'INVOICE_ISSUED',
        resourceType: 'invoice',
        resourceId: invoice.invoiceId,
        outcome: 'ALLOWED',
        reason: `InvoiceNumber=${invoice.invoiceNumber}, TotalMinor=${invoice.totalMinor}, Period=${periodKey}`,
      });
    }
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

  // ── Webhook Platform (Section 13 & AVP-011 §10) ───────────────────────────
  public registerWebhookEndpoint(params: {
    organizationId: string;
    url: string;
    eventSubscriptions: PublicWebhookEventType[];
    actorId?: string;
  }): WebhookEndpointRecord {
    const eventsValidation = validateWebhookEventSubscriptions(params.eventSubscriptions);
    if (!eventsValidation.valid) {
      throw new Error(`INVALID_WEBHOOK_EVENTS: ${eventsValidation.message}`);
    }

    const trimmedUrl = params.url.trim();
    const orgEndpoints = Array.from(this.webhookEndpoints.values()).filter(
      (e) => e.organizationId === params.organizationId,
    );
    if (orgEndpoints.some((e) => e.url === trimmedUrl)) {
      throw new Error('WEBHOOK_ENDPOINT_DUPLICATE: Endpoint URL is already registered for this organization.');
    }
    if (orgEndpoints.length >= MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION) {
      throw new Error(
        `WEBHOOK_ENDPOINT_LIMIT_EXCEEDED: Maximum ${MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION} webhook endpoints per organization.`,
      );
    }

    const signingSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const ep: WebhookEndpointRecord = {
      endpointId: `wh_${crypto.randomBytes(6).toString('hex')}`,
      organizationId: params.organizationId,
      url: trimmedUrl,
      eventSubscriptions: eventsValidation.events,
      signingSecret,
      active: true,
      createdAtIso: new Date().toISOString(),
    };
    this.webhookEndpoints.set(ep.endpointId, ep);
    this.recordAuditLog({
      organizationId: params.organizationId,
      actorType: 'USER',
      actorId: params.actorId ?? 'system_seed',
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
    verifiedHttpStatus?: number | null;
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
      const failed = Boolean(params.simulateFailureForTesting);
      const actualHttpStatus =
        typeof params.verifiedHttpStatus === 'number' ? params.verifiedHttpStatus : null;
      const genuinelyDelivered =
        !failed && actualHttpStatus !== null && actualHttpStatus >= 200 && actualHttpStatus < 300;

      const rec: WebhookDeliveryRecord = {
        deliveryId: `whd_${crypto.randomUUID()}`,
        endpointId: ep.endpointId,
        eventId,
        eventType: params.eventType,
        organizationId: params.organizationId,
        attemptNumber: failed ? 6 : 1,
        maxAttempts: WEBHOOK_RETRY_DELAYS_SECONDS.length,
        status: failed
          ? 'DEAD_LETTER'
          : genuinelyDelivered
            ? 'DELIVERED'
            : 'RETRY_SCHEDULED',
        httpStatus: failed ? 503 : genuinelyDelivered ? actualHttpStatus : null,
        signatureHeader,
        payloadJson,
        nextRetryAtIso:
          failed || genuinelyDelivered
            ? null
            : new Date(Date.now() + WEBHOOK_RETRY_DELAYS_SECONDS[0] * 1000).toISOString(),
        lastErrorSafe: failed
          ? 'HTTP 503 after 6 attempts (moved to Dead-Letter Queue)'
          : genuinelyDelivered
            ? null
            : 'Outbound webhook delivery scheduled (awaiting real HTTP 2xx acknowledgement from delivery worker)',
        deliveredAtIso: genuinelyDelivered ? new Date().toISOString() : null,
        createdAtIso: new Date().toISOString(),
      };
      this.webhookDeliveries.push(rec);
      created.push(rec);
    }
    return created;
  }

  /**
   * Honest DLQ Replay (AVP-011 §10):
   * Verifies tenant ownership and DEAD_LETTER status, then enqueues a new RETRY_SCHEDULED
   * attempt with a valid nextRetryAtIso. NEVER fabricates DELIVERED without an actual HTTP 2xx response.
   */
  public replayDeadLetterWebhook(
    deliveryId: string,
    organizationId: string,
    actorUserId?: string,
  ): WebhookDeliveryRecord {
    const target = this.webhookDeliveries.find(
      (d) => d.deliveryId === deliveryId && d.organizationId === organizationId
    );
    if (!target) throw new Error('TENANT_ISOLATION_DENIED: Delivery not found in organization');
    if (target.status !== 'DEAD_LETTER') {
      throw new Error('WEBHOOK_DELIVERY_NOT_DEAD_LETTER: Only DEAD_LETTER deliveries may be replayed.');
    }
    const ep = this.webhookEndpoints.get(target.endpointId);
    if (!ep || ep.organizationId !== organizationId) {
      throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const nowIso = new Date().toISOString();
    const replayed: WebhookDeliveryRecord = {
      ...target,
      deliveryId: `whd_${crypto.randomUUID()}`,
      attemptNumber: 1,
      status: 'RETRY_SCHEDULED',
      httpStatus: null,
      signatureHeader: this.signWebhookPayload(ep.signingSecret, nowSec, target.payloadJson),
      nextRetryAtIso: new Date(Date.now() + WEBHOOK_RETRY_DELAYS_SECONDS[0] * 1000).toISOString(),
      lastErrorSafe: 'Replay scheduled for outbound delivery worker (not yet acknowledged)',
      deliveredAtIso: null,
      createdAtIso: nowIso,
    };
    this.webhookDeliveries.push(replayed);
    if (actorUserId) {
      this.recordAuditLog({
        organizationId,
        actorType: 'USER',
        actorId: actorUserId,
        action: 'WEBHOOK_DELIVERY_REPLAY_SCHEDULED',
        resourceType: 'webhook_delivery',
        resourceId: replayed.deliveryId,
        outcome: 'ALLOWED',
        reason: `OriginalDeliveryId=${target.deliveryId}, EventId=${target.eventId}`,
      });
    }
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
