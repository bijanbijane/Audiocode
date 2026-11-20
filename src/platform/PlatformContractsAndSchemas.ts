/**
 * PHASE 10 — INDEPENDENT ASR PLATFORM & DEVELOPER ECOSYSTEM
 * Core Domain Contracts, Security Scopes, Ledger Types, Plans & Region Schemas
 *
 * Strictly separates Commercial Control Plane (Accounts, Tenants, API Keys, Billing, Webhooks)
 * from Scientific Data Plane (Audio Inference, Adaptive Routing, Transcript Post-Processing).
 */

export type ProductLineId =
  | 'PRODUCT_A_BATCH_STT'
  | 'PRODUCT_B_REALTIME_STREAMING'
  | 'PRODUCT_C_LONG_FORM_STT'
  | 'PRODUCT_D_ENTERPRISE_ASR'
  | 'PRODUCT_E_RESEARCH_EVAL';

export type ProductMaturityStage =
  | 'PRIVATE_ALPHA'
  | 'PRIVATE_BETA'
  | 'PUBLIC_BETA'
  | 'PRODUCTION'
  | 'ENTERPRISE_GA'
  | 'DEPRECATED';

export type OrganizationRole =
  | 'OWNER'
  | 'ADMIN'
  | 'DEVELOPER'
  | 'BILLING_ADMIN'
  | 'ANALYST'
  | 'VIEWER'
  | 'SECURITY_AUDITOR';

export type ProjectEnvironment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

export type ApiCredentialScope =
  | 'audio:transcribe'
  | 'audio:stream'
  | 'audio:read'
  | 'transcripts:read'
  | 'usage:read'
  | 'projects:read'
  | 'projects:write'
  | 'webhooks:manage'
  | 'models:read'
  | 'models:write'
  | 'models:approve'
  | 'models:deploy'
  | 'security:read'
  | 'security:write'
  | 'security:audit'
  | 'security:admin'
  | 'privacy:write'
  | 'platform:read'
  | 'api-keys:manage'
  | 'billing:read'
  | 'billing:write';

export const ALL_PLATFORM_SCOPES: ReadonlySet<ApiCredentialScope> = new Set<ApiCredentialScope>([
  'audio:transcribe',
  'audio:stream',
  'audio:read',
  'transcripts:read',
  'usage:read',
  'projects:read',
  'projects:write',
  'webhooks:manage',
  'models:read',
  'models:write',
  'models:approve',
  'models:deploy',
  'security:read',
  'security:write',
  'security:audit',
  'security:admin',
  'privacy:write',
  'platform:read',
  'api-keys:manage',
  'billing:read',
  'billing:write',
]);

export type PlatformErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_DENIED'
  | 'INSUFFICIENT_SCOPE'
  | 'STEP_UP_AUTHENTICATION_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'TENANT_ISOLATION_DENIED'
  | 'AUDIO_FORMAT_UNSUPPORTED'
  | 'AUDIO_DURATION_EXCEEDED'
  | 'UPLOAD_TOO_LARGE'
  | 'LANGUAGE_UNSUPPORTED'
  | 'MODEL_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'BUDGET_EXCEEDED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'ASYNC_EXECUTION_UNAVAILABLE'
  | 'TRANSCRIPTION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REGION_UNAVAILABLE';

export interface PlatformApiErrorEnvelope {
  error: {
    code: PlatformErrorCode;
    message: string;
    request_id: string;
    retryable: boolean;
    retry_after_seconds?: number;
    details: Record<string, unknown>;
  };
}

export interface PlatformUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  identityProvider: 'local_password' | 'oidc_sso';
  mfaEnabled: boolean;
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  createdAtIso: string;
}

export interface PlatformOrganization {
  id: string;
  name: string;
  billingCustomerReference: string;
  organizationStatus: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED';
  defaultRegionId: string;
  allowedRegions: string[];
  prohibitedRegions: string[];
  allowCrossRegionFailover: boolean;
  hardSpendingLimitMinor: number;
  currency: 'USD' | 'IRR';
  createdAtIso: string;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  membershipStatus: 'ACTIVE' | 'REVOKED';
  createdAtIso: string;
}

export interface OrganizationInvitation {
  invitationId: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  projectIds: string[];
  tokenHash: string;
  expiresAtIso: string; // 72h default
  consumedAtIso: string | null;
  revokedAtIso: string | null;
  createdAtIso: string;
}

export interface PlatformProject {
  id: string;
  organizationId: string;
  projectName: string;
  environment: ProjectEnvironment;
  allowedModels: string[];
  allowedEngines: string[];
  allowedRegions: string[];
  retentionDays: number;
  monthlyAudioSecondsQuota: number;
  requestsPerMinuteLimit: number;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAtIso: string;
}

export interface ApiCredentialRecord {
  id: string;
  organizationId: string;
  projectId: string;
  /** Server-side bound principal (PlatformUser.id). Authorization role is resolved strictly from this principal's active organization membership. */
  principalId: string;
  name: string;
  publicIdentifier: string;
  secretHash: string; // HMAC-SHA256 with server-side pepper over high-entropy random secret
  keyPrefix: 'asr_live' | 'asr_test';
  environment: ProjectEnvironment;
  scopes: ApiCredentialScope[];
  allowedIpCidrs: string[];
  expiresAtIso: string | null;
  overlapRevokesAtIso: string | null;
  lastUsedAtIso: string | null;
  revokedAtIso: string | null;
  createdAtIso: string;
}

export interface ApiCredentialIssuedResponse {
  credential: Omit<ApiCredentialRecord, 'secretHash'>;
  plaintextSecretOnce: string; // Shown strictly once at creation/rotation
}

export type PlanTierId = 'developer' | 'starter' | 'growth' | 'business' | 'enterprise';

export interface PlatformPlanCatalogEntry {
  planId: PlanTierId;
  planName: string;
  planVersion: string;
  billingInterval: 'monthly' | 'contract';
  currency: 'USD';
  subscriptionPriceMinor: number; // Integer minor units (cents)
  includedAudioMinutes: number;
  overageRateMinorPerMinute: number; // Integer cents per minute
  streamingRateMinorPerMinute: number;
  maxFileDurationSec: number;
  maxUploadBytes: number;
  concurrentBatchJobs: number;
  concurrentStreamingSessions: number;
  requestsPerMinute: number;
  retentionDays: number;
  supportedModels: string[];
  externalProvidersPermitted: boolean;
  allowedRegions: string[];
  supportTier: 'community' | 'standard' | 'priority' | 'dedicated_sla';
  planStatus: 'ACTIVE' | 'DEPRECATED';
}

export interface TenantSubscriptionRecord {
  subscriptionId: string;
  organizationId: string;
  planId: PlanTierId;
  planVersion: string;
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  currentPeriodStartIso: string;
  currentPeriodEndIso: string;
  availableCreditMinor: number;
  reservedCreditMinor: number;
  consumedCreditMinor: number;
}

export type MeteringState =
  | 'RECEIVED'
  | 'VALIDATED'
  | 'RESERVED'
  | 'COMMITTED'
  | 'RECONCILED'
  | 'REVERSED';

export interface AuthoritativeUsageEvent {
  usageEventId: string;
  idempotencyKey: string;
  eventType: 'transcription.completed' | 'streaming.session.completed' | 'transcription.failed_reversed';
  organizationId: string;
  projectId: string;
  credentialId: string;
  requestId: string;
  transcriptionId: string;
  modelId: string;
  modelVersion: string;
  executionMode: 'batch' | 'native_streaming' | 'vad_segmented_streaming';
  audioDurationMs: number;
  billableDurationMs: number;
  processingDurationMs: number;
  unit: 'audio_milliseconds';
  actualCostMinor: number;
  currency: 'USD';
  meteringState: MeteringState;
  measuredAtIso: string;
}

export interface UsageReservationRecord {
  reservationId: string;
  organizationId: string;
  projectId: string;
  requestId: string;
  estimatedAudioMs: number;
  reservedAmountMinor: number;
  currency: 'USD';
  status: 'RESERVED' | 'COMMITTED' | 'RELEASED';
  expiresAtIso: string;
  createdAtIso: string;
  settledAtIso: string | null;
}

export type LedgerTransactionType =
  | 'SUBSCRIPTION_CHARGE'
  | 'USAGE_CHARGE'
  | 'CREDIT_PURCHASE'
  | 'CREDIT_GRANT'
  | 'CREDIT_CONSUMPTION'
  | 'REFUND'
  | 'ADJUSTMENT'
  | 'TAX'
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_REVERSAL';

export interface ImmutableBillingLedgerEntry {
  ledgerEntryId: string;
  organizationId: string;
  transactionType: LedgerTransactionType;
  amountMinor: number;
  currency: 'USD';
  debitAccount: string;
  creditAccount: string;
  usageEventId: string | null;
  invoiceId: string | null;
  paymentEventId: string | null;
  idempotencyKey: string;
  note: string;
  createdAtIso: string;
}

export type InvoiceStatus =
  | 'DRAFT'
  | 'ISSUED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'OVERDUE'
  | 'VOID'
  | 'REFUNDED';

export interface ImmutableInvoiceRecord {
  invoiceId: string;
  organizationId: string;
  invoiceNumber: string;
  pricingSnapshot: {
    planId: PlanTierId;
    planVersion: string;
    includedMinutes: number;
    billedAudioMinutes: number;
    overageMinutes: number;
    unitRateMinorPerMinute: number;
  };
  subtotalMinor: number;
  taxMinor: number;
  discountMinor: number;
  totalMinor: number;
  currency: 'USD';
  issueDateIso: string;
  dueDateIso: string;
  status: InvoiceStatus;
  snapshotSha256: string;
}

export type PublicWebhookEventType =
  | 'transcription.queued'
  | 'transcription.processing'
  | 'transcription.completed'
  | 'transcription.failed'
  | 'streaming.session.completed'
  | 'usage.threshold_reached'
  | 'quota.exceeded'
  | 'subscription.updated'
  | 'invoice.created'
  | 'invoice.paid'
  | 'payment.failed';

export interface WebhookEndpointRecord {
  endpointId: string;
  organizationId: string;
  url: string;
  eventSubscriptions: PublicWebhookEventType[];
  signingSecret: string;
  active: boolean;
  createdAtIso: string;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  eventType: PublicWebhookEventType;
  organizationId: string;
  attemptNumber: number;
  maxAttempts: number;
  status: 'PENDING' | 'DELIVERED' | 'RETRY_SCHEDULED' | 'DEAD_LETTER';
  httpStatus: number | null;
  signatureHeader: string;
  payloadJson: string;
  nextRetryAtIso: string | null;
  lastErrorSafe: string | null;
  deliveredAtIso: string | null;
  createdAtIso: string;
}

export type PublicModelReleaseState = 'PREVIEW' | 'BETA' | 'STABLE' | 'DEPRECATED' | 'RETIRED';

export type PublicModelAvailability =
  | 'AVAILABLE_NOW'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_NOT_READY'
  | 'MODEL_INTEGRITY_FAILURE'
  | 'REQUIRES_GPU_WORKER'
  | 'REQUIRES_API_KEY';

export const ALL_PUBLIC_WEBHOOK_EVENTS: ReadonlySet<PublicWebhookEventType> =
  new Set<PublicWebhookEventType>([
    'transcription.completed',
    'transcription.failed',
    'streaming.session.completed',
    'usage.threshold_reached',
    'invoice.issued',
    'payment.failed',
    'model.deprecated',
  ]);

export interface PublicModelCatalogEntry {
  modelId: string;
  displayName: string;
  version: string;
  releaseState: PublicModelReleaseState;
  supportedLanguages: Array<'fa' | 'en'>;
  codeSwitchingSupported: boolean;
  supportedModes: Array<'batch' | 'native_streaming' | 'vad_segmented_streaming'>;
  inputFormats: Array<'wav' | 'mp3' | 'ogg' | 'pcm16'>;
  maxAudioDurationSec: number;
  timestampsSupported: boolean;
  diarizationSupported: boolean;
  supportedRegions: string[];
  runtimeType: 'local_cpu_worker' | 'self_hosted_gpu_vllm' | 'optional_external_cloud';
  availabilityInCurrentContainer: PublicModelAvailability;
  documentationAnchor: string;
  retirementDateIso: string | null;
}

export interface PlatformRegionRecord {
  regionId: string;
  displayName: string;
  provider: string;
  locationLabel: string;
  dataResidencyClass: 'DOMESTIC_LOCAL' | 'EU_GDPR' | 'US_STANDARD';
  healthStatus: 'OPERATIONAL_SINGLE_REGION' | 'STAGED_NOT_OPERATIONAL' | 'DEGRADED';
  gpuCapacityAvailable: number;
  freeVramGb: number;
  activeStreamingSessions: number;
  batchQueueDepth: number;
  supportsFailoverFrom: string[];
  pricingMultiplier: number;
}

export type BatchJobLifecycleState =
  | 'QUEUED'
  | 'VALIDATING'
  | 'PROCESSING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface PublicTranscriptionJobRecord {
  id: string;
  object: 'audio.transcription';
  organizationId: string;
  projectId: string;
  credentialId: string;
  regionId: string;
  status: BatchJobLifecycleState;
  stateHistory: Array<{ state: BatchJobLifecycleState; timestampIso: string }>;
  model: string;
  modelVersion: string;
  modelSha256?: string;
  executionBackend?: string;
  language: 'fa' | 'en' | 'fa-en' | 'auto';
  executionMode: 'batch' | 'long_form_async';
  text: string | null;
  rawTranscript?: string | null;
  normalizedTranscript?: string | null;
  segments?: Array<{ startMs: number; endMs: number; text: string; confidence?: number }>;
  calibratedConfidence?: number | null;
  durationMs: number;
  billableMs: number;
  processingDurationMs?: number;
  actualCostMinor: number;
  currency: 'USD';
  timestampsAvailable: boolean;
  diarizationAvailable: boolean;
  metadata: Record<string, string>;
  createdAtIso: string;
  completedAtIso: string | null;
}

export interface PlatformAuditLogEntry {
  auditId: string;
  organizationId: string;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: 'ALLOWED' | 'DENIED';
  reason: string;
  timestampIso: string;
}
