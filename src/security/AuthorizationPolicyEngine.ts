/**
 * CENTRALIZED SERVER-SIDE AUTHORIZATION POLICY ENGINE
 *
 * Single authoritative RBAC, credential scope, and tenant-boundary policy evaluator
 * shared across Phase 14 Speech Security APIs (`/v1/security/*`) and
 * Phase 13 Model Factory & ML Governance APIs (`/v1/ml/*`).
 *
 * Security invariants:
 * - Fail closed on missing, revoked, suspended, ambiguous, or invalid roles/memberships.
 * - Never infer `OWNER` when a role is missing or invalid.
 * - Never trust client-supplied headers (`x-avapardaz-role`), query params, or body fields
 *   as authorization inputs.
 * - Always check BOTH server-side verified organization membership role AND credential scopes.
 * - Always validate tenant/resource ownership prior to any state mutation.
 */

import type {
  ApiCredentialScope,
  OrganizationRole,
  PlatformApiErrorEnvelope,
  PlatformErrorCode,
} from '../platform/PlatformContractsAndSchemas';
import {
  buildPlatformErrorEnvelope,
  type PlatformControlPlaneService,
} from '../platform/PlatformControlPlaneEngine';
import type { PrivacyRetentionPolicy } from './SpeechSecurityContracts';

export const VALID_ORGANIZATION_ROLES: readonly OrganizationRole[] = Object.freeze([
  'OWNER',
  'ADMIN',
  'DEVELOPER',
  'BILLING_ADMIN',
  'ANALYST',
  'VIEWER',
  'SECURITY_AUDITOR',
]);

export type SecurityOperationId =
  | 'SECURITY_READ_THREAT_MODEL'
  | 'SECURITY_INSPECT_AUDIO_UPLOAD'
  | 'SECURITY_VALIDATE_REMOTE_URL'
  | 'SECURITY_RUN_ROBUSTNESS_EVALUATION'
  | 'SECURITY_EVALUATE_TRANSCRIPT_BOUNDARY'
  | 'SECURITY_CREATE_REDACTED_DERIVATIVE'
  | 'SECURITY_UPDATE_RETENTION_POLICY'
  | 'SECURITY_EXECUTE_DELETION_CASCADE'
  | 'SECURITY_RUN_RED_TEAM_SUITE'
  | 'SECURITY_READ_AUDIT_EVENTS';

export type ModelFactoryOperationId =
  | 'ML_READ_MODELS'
  | 'ML_READ_MONITORING'
  | 'ML_MANAGE_EXPERIMENTS'
  | 'ML_EVALUATE_MODEL'
  | 'ML_OPTIMIZE_MODEL'
  | 'ML_PACKAGE_MODEL'
  | 'ML_APPROVE_MODEL'
  | 'ML_DEPLOY_NON_PROD'
  | 'ML_DEPLOY_PRODUCTION'
  | 'ML_PROMOTE_DEPLOYMENT'
  | 'ML_ROLLBACK_DEPLOYMENT'
  | 'ML_READ_GOVERNANCE_AUDIT';

export type PlatformControlPlaneOperationId =
  | 'PLATFORM_READ_OVERVIEW'
  | 'PLATFORM_CREATE_PROJECT'
  | 'PLATFORM_ISSUE_API_KEY'
  | 'PLATFORM_ROTATE_API_KEY'
  | 'PLATFORM_REVOKE_API_KEY'
  | 'PLATFORM_ISSUE_INVOICE'
  | 'PLATFORM_REGISTER_WEBHOOK'
  | 'PLATFORM_MANAGE_WEBHOOKS'
  | 'PLATFORM_TEST_WEBHOOKS'
  | 'PLATFORM_CHECK_REGION';

export type ProtectedOperationId =
  | SecurityOperationId
  | ModelFactoryOperationId
  | PlatformControlPlaneOperationId;

export type AuthorizationReasonCode =
  | 'ALLOWED'
  | 'DENIED_UNAUTHENTICATED'
  | 'DENIED_PRINCIPAL_DISABLED'
  | 'DENIED_ORGANIZATION_INACTIVE'
  | 'DENIED_MEMBERSHIP_MISSING_OR_REVOKED'
  | 'DENIED_MEMBERSHIP_AMBIGUOUS'
  | 'DENIED_INVALID_OR_MISSING_ROLE'
  | 'DENIED_ROLE_NOT_PERMITTED'
  | 'DENIED_INSUFFICIENT_CREDENTIAL_SCOPE'
  | 'DENIED_TENANT_BOUNDARY_MISMATCH'
  | 'DENIED_RESOURCE_OWNERSHIP_VIOLATION'
  | 'DENIED_RATE_LIMITED';

export interface OperationPolicyRule {
  readonly operation: ProtectedOperationId;
  readonly allowedRoles: readonly OrganizationRole[];
  readonly acceptedScopes: readonly ApiCredentialScope[];
  readonly category: 'SECURITY' | 'MODEL_FACTORY' | 'PLATFORM';
  readonly mutating: boolean;
}

export const PLATFORM_AUTHORIZATION_POLICIES: Readonly<
  Record<ProtectedOperationId, OperationPolicyRule>
> = Object.freeze({
  // ── Phase 14: Speech Security Operations (10 protected operations) ─────────
  SECURITY_READ_THREAT_MODEL: {
    operation: 'SECURITY_READ_THREAT_MODEL',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'VIEWER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['security:read', 'models:read', 'audio:transcribe'],
    category: 'SECURITY',
    mutating: false,
  },
  SECURITY_INSPECT_AUDIO_UPLOAD: {
    operation: 'SECURITY_INSPECT_AUDIO_UPLOAD',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['audio:transcribe', 'security:write'],
    category: 'SECURITY',
    mutating: false,
  },
  SECURITY_VALIDATE_REMOTE_URL: {
    operation: 'SECURITY_VALIDATE_REMOTE_URL',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['audio:transcribe', 'security:write'],
    category: 'SECURITY',
    mutating: false,
  },
  SECURITY_RUN_ROBUSTNESS_EVALUATION: {
    operation: 'SECURITY_RUN_ROBUSTNESS_EVALUATION',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['security:write', 'security:admin', 'models:read'],
    category: 'SECURITY',
    mutating: true,
  },
  SECURITY_EVALUATE_TRANSCRIPT_BOUNDARY: {
    operation: 'SECURITY_EVALUATE_TRANSCRIPT_BOUNDARY',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'SECURITY_AUDITOR'],
    acceptedScopes: ['audio:transcribe', 'transcripts:read', 'security:write'],
    category: 'SECURITY',
    mutating: false,
  },
  SECURITY_CREATE_REDACTED_DERIVATIVE: {
    operation: 'SECURITY_CREATE_REDACTED_DERIVATIVE',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['privacy:write', 'security:write', 'audio:transcribe'],
    category: 'SECURITY',
    mutating: true,
  },
  SECURITY_UPDATE_RETENTION_POLICY: {
    operation: 'SECURITY_UPDATE_RETENTION_POLICY',
    allowedRoles: ['OWNER', 'ADMIN', 'SECURITY_AUDITOR'],
    acceptedScopes: ['security:admin', 'privacy:write'],
    category: 'SECURITY',
    mutating: true,
  },
  SECURITY_EXECUTE_DELETION_CASCADE: {
    operation: 'SECURITY_EXECUTE_DELETION_CASCADE',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['security:admin', 'privacy:write'],
    category: 'SECURITY',
    mutating: true,
  },
  SECURITY_RUN_RED_TEAM_SUITE: {
    operation: 'SECURITY_RUN_RED_TEAM_SUITE',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['security:admin', 'security:write'],
    category: 'SECURITY',
    mutating: true,
  },
  SECURITY_READ_AUDIT_EVENTS: {
    operation: 'SECURITY_READ_AUDIT_EVENTS',
    allowedRoles: ['OWNER', 'ADMIN', 'SECURITY_AUDITOR'],
    acceptedScopes: ['security:audit', 'security:admin', 'security:read'],
    category: 'SECURITY',
    mutating: false,
  },

  // ── Phase 13: Model Factory & ML Governance Operations ─────────────────────
  ML_READ_MODELS: {
    operation: 'ML_READ_MODELS',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'VIEWER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['models:read'],
    category: 'MODEL_FACTORY',
    mutating: false,
  },
  ML_READ_MONITORING: {
    operation: 'ML_READ_MONITORING',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'VIEWER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['models:read', 'usage:read'],
    category: 'MODEL_FACTORY',
    mutating: false,
  },
  ML_MANAGE_EXPERIMENTS: {
    operation: 'ML_MANAGE_EXPERIMENTS',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_EVALUATE_MODEL: {
    operation: 'ML_EVALUATE_MODEL',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_OPTIMIZE_MODEL: {
    operation: 'ML_OPTIMIZE_MODEL',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_PACKAGE_MODEL: {
    operation: 'ML_PACKAGE_MODEL',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_APPROVE_MODEL: {
    operation: 'ML_APPROVE_MODEL',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['models:approve', 'models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_DEPLOY_NON_PROD: {
    operation: 'ML_DEPLOY_NON_PROD',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['models:deploy', 'models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_DEPLOY_PRODUCTION: {
    operation: 'ML_DEPLOY_PRODUCTION',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['models:deploy', 'models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_PROMOTE_DEPLOYMENT: {
    operation: 'ML_PROMOTE_DEPLOYMENT',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['models:deploy', 'models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_ROLLBACK_DEPLOYMENT: {
    operation: 'ML_ROLLBACK_DEPLOYMENT',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['models:deploy', 'models:write', 'audio:transcribe'],
    category: 'MODEL_FACTORY',
    mutating: true,
  },
  ML_READ_GOVERNANCE_AUDIT: {
    operation: 'ML_READ_GOVERNANCE_AUDIT',
    allowedRoles: ['OWNER', 'ADMIN', 'SECURITY_AUDITOR'],
    acceptedScopes: ['security:audit', 'security:admin', 'models:read'],
    category: 'MODEL_FACTORY',
    mutating: false,
  },

  // ── AVP-011: Platform Control Plane Administration Operations (10 protected operations) ──
  PLATFORM_READ_OVERVIEW: {
    operation: 'PLATFORM_READ_OVERVIEW',
    allowedRoles: ['OWNER', 'ADMIN', 'BILLING_ADMIN', 'ANALYST', 'SECURITY_AUDITOR'],
    acceptedScopes: ['platform:read'],
    category: 'PLATFORM',
    mutating: false,
  },
  PLATFORM_CREATE_PROJECT: {
    operation: 'PLATFORM_CREATE_PROJECT',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['projects:write'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_ISSUE_API_KEY: {
    operation: 'PLATFORM_ISSUE_API_KEY',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['api-keys:manage'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_ROTATE_API_KEY: {
    operation: 'PLATFORM_ROTATE_API_KEY',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['api-keys:manage'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_REVOKE_API_KEY: {
    operation: 'PLATFORM_REVOKE_API_KEY',
    allowedRoles: ['OWNER', 'ADMIN'],
    acceptedScopes: ['api-keys:manage'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_ISSUE_INVOICE: {
    operation: 'PLATFORM_ISSUE_INVOICE',
    allowedRoles: ['OWNER', 'BILLING_ADMIN'],
    acceptedScopes: ['billing:write'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_REGISTER_WEBHOOK: {
    operation: 'PLATFORM_REGISTER_WEBHOOK',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['webhooks:manage'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_MANAGE_WEBHOOKS: {
    operation: 'PLATFORM_MANAGE_WEBHOOKS',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['webhooks:manage'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_TEST_WEBHOOKS: {
    operation: 'PLATFORM_TEST_WEBHOOKS',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER'],
    acceptedScopes: ['webhooks:manage'],
    category: 'PLATFORM',
    mutating: true,
  },
  PLATFORM_CHECK_REGION: {
    operation: 'PLATFORM_CHECK_REGION',
    allowedRoles: ['OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'VIEWER', 'SECURITY_AUDITOR'],
    acceptedScopes: ['projects:read'],
    category: 'PLATFORM',
    mutating: false,
  },
});

export interface TrustedAuthContext {
  readonly principalId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly credentialId: string;
  readonly role: OrganizationRole;
  readonly scopes: readonly ApiCredentialScope[];
  readonly requestId: string;
}

export type AuthorizationOutcome =
  | {
      readonly allowed: true;
      readonly httpStatus: 200;
      readonly reasonCode: 'ALLOWED';
      readonly operation: ProtectedOperationId;
      readonly context: TrustedAuthContext;
    }
  | {
      readonly allowed: false;
      readonly httpStatus: 401 | 403 | 429;
      readonly reasonCode: AuthorizationReasonCode;
      readonly operation: ProtectedOperationId;
      readonly principalId: string | null;
      readonly organizationId: string | null;
      readonly role: OrganizationRole | null;
      readonly resourceTenantId: string | null;
      readonly errorEnvelope: PlatformApiErrorEnvelope;
    };

/**
 * Evaluates server-side authentication, verified membership role, credential scopes,
 * and optional resource tenant ownership for a protected operation.
 *
 * Strictly ignores any caller-supplied role or tenant override.
 */
export function authorizePlatformOperation(params: {
  readonly controlPlane: PlatformControlPlaneService;
  readonly bearerToken: string;
  readonly operation: ProtectedOperationId;
  readonly resourceTenantId?: string | null;
  readonly claimedTenantId?: string | null;
  readonly requestId?: string;
  readonly nowMs?: number;
}): AuthorizationOutcome {
  const policy = PLATFORM_AUTHORIZATION_POLICIES[params.operation];
  const requestId = params.requestId ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Step 1: Authenticate credential + verify active org, project, user, and unambiguous active membership
  const auth = params.controlPlane.authenticateApiKeyRequest({
    bearerToken: params.bearerToken,
    nowMs: params.nowMs,
  });

  if (!auth.authenticated) {
    const httpStatus: 401 | 403 | 429 =
      auth.httpStatus === 401 ? 401 : auth.httpStatus === 429 ? 429 : 403;
    return {
      allowed: false,
      httpStatus,
      reasonCode: auth.reasonCode,
      operation: params.operation,
      principalId: null,
      organizationId: null,
      role: null,
      resourceTenantId: params.resourceTenantId ?? null,
      errorEnvelope: auth.errorEnvelope,
    };
  }

  const principalRole = auth.principal.role;
  const orgId = auth.organization.id;
  const principalId = auth.principal.principalId;

  // Step 2: Fail closed if resolved membership role is missing or unrecognized (never default to OWNER)
  if (!principalRole || !VALID_ORGANIZATION_ROLES.includes(principalRole)) {
    return buildDenial({
      httpStatus: 403,
      errorCode: 'AUTHORIZATION_DENIED',
      reasonCode: 'DENIED_INVALID_OR_MISSING_ROLE',
      operation: params.operation,
      principalId,
      organizationId: orgId,
      role: null,
      resourceTenantId: params.resourceTenantId ?? null,
      requestId,
      message: 'Authorization denied.',
    });
  }

  // Step 3: Verify client did not attempt cross-tenant override via claimed tenantId / organizationId
  if (
    typeof params.claimedTenantId === 'string' &&
    params.claimedTenantId.trim().length > 0 &&
    params.claimedTenantId.trim() !== orgId
  ) {
    return buildDenial({
      httpStatus: 403,
      errorCode: 'TENANT_ISOLATION_DENIED',
      reasonCode: 'DENIED_TENANT_BOUNDARY_MISMATCH',
      operation: params.operation,
      principalId,
      organizationId: orgId,
      role: principalRole,
      resourceTenantId: params.claimedTenantId.trim(),
      requestId,
      message: 'Cross-tenant access denied.',
    });
  }

  // Step 4: Verify target resource tenant ownership (if known up front)
  if (
    typeof params.resourceTenantId === 'string' &&
    params.resourceTenantId.length > 0 &&
    params.resourceTenantId !== orgId
  ) {
    return buildDenial({
      httpStatus: 403,
      errorCode: 'TENANT_ISOLATION_DENIED',
      reasonCode: 'DENIED_RESOURCE_OWNERSHIP_VIOLATION',
      operation: params.operation,
      principalId,
      organizationId: orgId,
      role: principalRole,
      resourceTenantId: params.resourceTenantId,
      requestId,
      message: 'Resource access denied.',
    });
  }

  // Step 5: Verify server-side organization role is permitted for this operation
  if (!policy.allowedRoles.includes(principalRole)) {
    return buildDenial({
      httpStatus: 403,
      errorCode: 'AUTHORIZATION_DENIED',
      reasonCode: 'DENIED_ROLE_NOT_PERMITTED',
      operation: params.operation,
      principalId,
      organizationId: orgId,
      role: principalRole,
      resourceTenantId: params.resourceTenantId ?? orgId,
      requestId,
      message: `Operation '${params.operation}' is not permitted for the authenticated role.`,
    });
  }

  // Step 6: Independently verify credential scope (even OWNER cannot bypass least-privilege key scopes)
  const hasRequiredScope = policy.acceptedScopes.some((scope) =>
    auth.credential.scopes.includes(scope)
  );
  if (!hasRequiredScope) {
    return buildDenial({
      httpStatus: 403,
      errorCode: 'INSUFFICIENT_SCOPE',
      reasonCode: 'DENIED_INSUFFICIENT_CREDENTIAL_SCOPE',
      operation: params.operation,
      principalId,
      organizationId: orgId,
      role: principalRole,
      resourceTenantId: params.resourceTenantId ?? orgId,
      requestId,
      message: 'API credential lacks the required scope for this operation.',
    });
  }

  return {
    allowed: true,
    httpStatus: 200,
    reasonCode: 'ALLOWED',
    operation: params.operation,
    context: {
      principalId,
      organizationId: orgId,
      projectId: auth.project.id,
      credentialId: auth.credential.id,
      role: principalRole,
      scopes: [...auth.credential.scopes],
      requestId,
    },
  };
}

function buildDenial(params: {
  httpStatus: 401 | 403;
  errorCode: PlatformErrorCode;
  reasonCode: AuthorizationReasonCode;
  operation: ProtectedOperationId;
  principalId: string | null;
  organizationId: string | null;
  role: OrganizationRole | null;
  resourceTenantId: string | null;
  requestId: string;
  message: string;
}): AuthorizationOutcome {
  return {
    allowed: false,
    httpStatus: params.httpStatus,
    reasonCode: params.reasonCode,
    operation: params.operation,
    principalId: params.principalId,
    organizationId: params.organizationId,
    role: params.role,
    resourceTenantId: params.resourceTenantId,
    errorEnvelope: buildPlatformErrorEnvelope({
      code: params.errorCode,
      message: params.message,
      requestId: params.requestId,
      details: {
        reasonCode: params.reasonCode,
        operation: params.operation,
      },
    }),
  };
}

// ── Strict Retention Policy Patch Validator ──────────────────────────────────

const ALLOWED_RETENTION_MUTABLE_KEYS = new Set([
  'rawAudioTtlDays',
  'intermediateChunksTtlHours',
  'rawTranscriptTtlDays',
  'redactedTranscriptTtlDays',
  'diagnosticsTtlDays',
  'securityLogsTtlDays',
  'externalApiTransferAllowed',
  'allowedResidencyRegion',
]);

const IMMUTABLE_RETENTION_KEYS = new Set([
  'tenantId',
  'organizationId',
  'updatedBy',
  'updatedAtIso',
  'actorRole',
  'role',
  'principalId',
  'actorId',
]);

const ALLOWED_RESIDENCY_REGIONS = new Set([
  'IR_LOCAL_ONLY',
  'REGIONAL_EU',
  'GLOBAL_EXPLICIT_OPT_IN',
]);

export type ValidatedRetentionPatch = Partial<
  Omit<PrivacyRetentionPolicy, 'tenantId' | 'updatedAtIso' | 'updatedBy'>
>;

export function validateRetentionPolicyPatch(
  rawBody: unknown,
  authenticatedTenantId: string
):
  | { readonly ok: true; readonly patch: ValidatedRetentionPatch }
  | { readonly ok: false; readonly httpStatus: 400 | 403; readonly code: PlatformErrorCode; readonly message: string } {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'VALIDATION_ERROR',
      message: 'Retention policy update payload must be a JSON object.',
    };
  }

  const record = rawBody as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'VALIDATION_ERROR',
      message: 'At least one mutable retention policy field must be supplied.',
    };
  }

  // Explicitly detect cross-tenant override attempts first
  for (const tenantKey of ['tenantId', 'organizationId'] as const) {
    if (tenantKey in record) {
      const val = record[tenantKey];
      if (typeof val === 'string' && val.trim() !== authenticatedTenantId) {
        return {
          ok: false,
          httpStatus: 403,
          code: 'TENANT_ISOLATION_DENIED',
          message: `Client cannot override immutable tenant field '${tenantKey}'.`,
        };
      }
      return {
        ok: false,
        httpStatus: 400,
        code: 'VALIDATION_ERROR',
        message: `Immutable field '${tenantKey}' cannot be specified in retention policy updates.`,
      };
    }
  }

  for (const key of keys) {
    if (IMMUTABLE_RETENTION_KEYS.has(key)) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'VALIDATION_ERROR',
        message: `Immutable or server-controlled field '${key}' is forbidden in retention policy updates.`,
      };
    }
    if (!ALLOWED_RETENTION_MUTABLE_KEYS.has(key)) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'VALIDATION_ERROR',
        message: `Unknown retention policy field '${key}' rejected.`,
      };
    }
  }

  const checkIntRange = (field: string, val: unknown, min: number, max: number): string | null => {
    if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val)) {
      return `Field '${field}' must be a finite integer.`;
    }
    if (val < min || val > max) {
      return `Field '${field}' must be between ${min} and ${max}.`;
    }
    return null;
  };

  const bounds: ReadonlyArray<[string, number, number]> = [
    ['rawAudioTtlDays', 0, 3650],
    ['intermediateChunksTtlHours', 1, 720],
    ['rawTranscriptTtlDays', 0, 3650],
    ['redactedTranscriptTtlDays', 0, 3650],
    ['diagnosticsTtlDays', 1, 365],
    ['securityLogsTtlDays', 7, 3650],
  ];

  const patch: Record<string, unknown> = {};
  for (const [field, min, max] of bounds) {
    if (field in record) {
      const err = checkIntRange(field, record[field], min, max);
      if (err) {
        return { ok: false, httpStatus: 400, code: 'VALIDATION_ERROR', message: err };
      }
      patch[field] = record[field];
    }
  }

  if ('externalApiTransferAllowed' in record) {
    if (typeof record.externalApiTransferAllowed !== 'boolean') {
      return {
        ok: false,
        httpStatus: 400,
        code: 'VALIDATION_ERROR',
        message: "Field 'externalApiTransferAllowed' must be a boolean.",
      };
    }
    patch.externalApiTransferAllowed = record.externalApiTransferAllowed;
  }

  if ('allowedResidencyRegion' in record) {
    if (
      typeof record.allowedResidencyRegion !== 'string' ||
      !ALLOWED_RESIDENCY_REGIONS.has(record.allowedResidencyRegion)
    ) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'VALIDATION_ERROR',
        message:
          "Field 'allowedResidencyRegion' must be one of IR_LOCAL_ONLY, REGIONAL_EU, or GLOBAL_EXPLICIT_OPT_IN.",
      };
    }
    patch.allowedResidencyRegion = record.allowedResidencyRegion;
  }

  return { ok: true, patch: patch as ValidatedRetentionPatch };
}

/**
 * Extracts a client-supplied tenant claim if present in a raw request object so
 * gateways can explicitly reject cross-tenant targeting before any mutation.
 */
export function extractClaimedTenantId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const key of ['tenantId', 'organizationId', 'orgId'] as const) {
    if (typeof obj[key] === 'string' && obj[key].trim().length > 0) {
      return obj[key].trim();
    }
  }
  return null;
}
