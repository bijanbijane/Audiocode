/**
 * AVP-PLATFORM-CONTROL-PLANE-AUTHORIZATION-011
 * Centralized Authenticated Gateway for Platform Control Plane Administration.
 *
 * Security Invariants:
 * - Every administrative read and mutation goes through `authorizePlatformOperation()`.
 * - Organization, principal, project, role, and scopes come EXCLUSIVELY from `TrustedAuthContext`.
 * - Zero hardcoded tenant/principal fallbacks (`org_avapardaz_sandbox`, `usr_studio_owner_01`).
 * - Conflicting client-supplied `organizationId` / `tenantId` / `principalId` / `actorUserId` -> HTTP 403.
 * - Cross-tenant or nonexistent resource lookups -> HTTP 404 (no existence oracle).
 * - One-time owner bootstrap is disabled by default, requires >=32-byte secret, constant-time compare,
 *   3-failures/15-min rate limit, and refuses re-bootstrap once an active owner `api-keys:manage` key exists.
 */

import crypto from 'node:crypto';
import {
  authorizePlatformOperation,
  extractClaimedTenantId,
  type PlatformControlPlaneOperationId,
  type TrustedAuthContext,
} from '../security/AuthorizationPolicyEngine';
import {
  buildPlatformErrorEnvelope,
  PHASE10_VERSIONED_PLAN_CATALOG,
  type PlatformControlPlaneService,
  validateRequestedScopes,
  validateScopeDelegation,
} from './PlatformControlPlaneEngine';
import type {
  ApiCredentialScope,
  PlatformApiErrorEnvelope,
  ProjectEnvironment,
  PublicModelCatalogEntry,
} from './PlatformContractsAndSchemas';
import {
  validateWebhookDestinationUrl,
  validateWebhookEventSubscriptions,
  type WebhookDnsLookupFn,
} from './PlatformWebhookSecurity';

export interface PlatformControlPlaneResponse<T = unknown> {
  readonly status: number;
  readonly body: T | PlatformApiErrorEnvelope;
}

export interface PlatformControlPlaneGatewayOptions {
  readonly isProduction?: boolean;
  readonly bootstrapEnabled?: boolean;
  readonly bootstrapToken?: string;
  readonly allowedDevWebhookHosts?: readonly string[];
  readonly dnsLookup?: WebhookDnsLookupFn;
  readonly resolvePublicModels?: () => Promise<readonly PublicModelCatalogEntry[]> | readonly PublicModelCatalogEntry[];
  readonly nowMs?: () => number;
}

export const BOOTSTRAP_OWNER_SCOPES: readonly ApiCredentialScope[] = Object.freeze([
  'platform:read',
  'projects:read',
  'projects:write',
  'api-keys:manage',
  'billing:read',
  'billing:write',
  'webhooks:manage',
  'models:read',
  'audio:transcribe',
  'transcripts:read',
  'usage:read',
]);

const VALID_PROJECT_ENVIRONMENTS: ReadonlySet<ProjectEnvironment> = new Set([
  'DEVELOPMENT',
  'STAGING',
  'PRODUCTION',
]);

const BOOTSTRAP_MAX_FAILURES = 3;
const BOOTSTRAP_WINDOW_MS = 15 * 60 * 1000;

interface BootstrapFailureBucket {
  failedTimestamps: number[];
}

function asPlainRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function extractClaimedPrincipalId(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  for (const key of ['principalId', 'actorUserId', 'actorId', 'userId'] as const) {
    if (typeof body[key] === 'string' && body[key].trim().length > 0) {
      return body[key].trim();
    }
  }
  return null;
}

function extractClaimedRole(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  for (const key of ['role', 'actorRole'] as const) {
    if (typeof body[key] === 'string' && body[key].trim().length > 0) {
      return body[key].trim();
    }
  }
  return null;
}

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const digestA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export class PlatformControlPlaneGateway {
  private readonly controlPlane: PlatformControlPlaneService;
  private readonly options: PlatformControlPlaneGatewayOptions;
  private readonly bootstrapFailuresBySource = new Map<string, BootstrapFailureBucket>();

  constructor(
    controlPlane: PlatformControlPlaneService,
    options: PlatformControlPlaneGatewayOptions = {},
  ) {
    this.controlPlane = controlPlane;
    this.options = options;
  }

  private get isProduction(): boolean {
    if (typeof this.options.isProduction === 'boolean') return this.options.isProduction;
    return (process.env.NODE_ENV ?? 'development').trim().toLowerCase() === 'production';
  }

  private get nowMs(): number {
    return this.options.nowMs ? this.options.nowMs() : Date.now();
  }

  private isBootstrapEnabled(): boolean {
    if (typeof this.options.bootstrapEnabled === 'boolean') {
      return this.options.bootstrapEnabled;
    }
    return (process.env.PLATFORM_BOOTSTRAP_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  }

  private getConfiguredBootstrapToken(): string {
    if (typeof this.options.bootstrapToken === 'string') {
      return this.options.bootstrapToken;
    }
    return process.env.PLATFORM_BOOTSTRAP_TOKEN ?? '';
  }

  private authorize(params: {
    bearerToken: string;
    operation: PlatformControlPlaneOperationId;
    body?: Record<string, unknown> | null;
    claimedTenantId?: string | null;
    resourceTenantId?: string | null;
    requestId?: string;
  }):
    | { ok: true; context: TrustedAuthContext }
    | { ok: false; response: PlatformControlPlaneResponse } {
    const claimedTenant =
      params.claimedTenantId ?? extractClaimedTenantId(params.body ?? null);

    const decision = authorizePlatformOperation({
      controlPlane: this.controlPlane,
      bearerToken: params.bearerToken,
      operation: params.operation,
      claimedTenantId: claimedTenant,
      resourceTenantId: params.resourceTenantId ?? null,
      requestId: params.requestId,
      nowMs: this.nowMs,
    });

    if (!decision.allowed) {
      if (decision.organizationId) {
        this.controlPlane.recordAuditLog({
          organizationId: decision.organizationId,
          actorType: decision.principalId ? 'USER' : 'SYSTEM',
          actorId: decision.principalId ?? 'unauthenticated',
          action: params.operation,
          resourceType: 'platform_control_plane',
          resourceId: params.operation,
          outcome: 'DENIED',
          reason: decision.reasonCode,
        });
      }
      return {
        ok: false,
        response: {
          status: decision.httpStatus,
          body: decision.errorEnvelope,
        },
      };
    }

    // Reject client-supplied principal/actor spoofing or role spoofing
    const claimedPrincipal = extractClaimedPrincipalId(params.body ?? null);
    if (claimedPrincipal && claimedPrincipal !== decision.context.principalId) {
      this.controlPlane.recordAuditLog({
        organizationId: decision.context.organizationId,
        actorType: 'USER',
        actorId: decision.context.principalId,
        action: params.operation,
        resourceType: 'platform_control_plane',
        resourceId: decision.context.credentialId,
        outcome: 'DENIED',
        reason: 'DENIED_PRINCIPAL_OVERRIDE_ATTEMPT',
      });
      return {
        ok: false,
        response: {
          status: 403,
          body: buildPlatformErrorEnvelope({
            code: 'AUTHORIZATION_DENIED',
            message: 'Client cannot specify a conflicting principal or actor identity.',
            requestId: decision.context.requestId,
          }),
        },
      };
    }

    const claimedRole = extractClaimedRole(params.body ?? null);
    if (claimedRole && claimedRole !== decision.context.role) {
      this.controlPlane.recordAuditLog({
        organizationId: decision.context.organizationId,
        actorType: 'USER',
        actorId: decision.context.principalId,
        action: params.operation,
        resourceType: 'platform_control_plane',
        resourceId: decision.context.credentialId,
        outcome: 'DENIED',
        reason: 'DENIED_ROLE_OVERRIDE_ATTEMPT',
      });
      return {
        ok: false,
        response: {
          status: 403,
          body: buildPlatformErrorEnvelope({
            code: 'AUTHORIZATION_DENIED',
            message: 'Client cannot assert or override server-verified organization roles.',
            requestId: decision.context.requestId,
          }),
        },
      };
    }

    return { ok: true, context: decision.context };
  }

  /**
   * One-time restricted owner credential bootstrap (AVP-011 §6B).
   * Disabled unless PLATFORM_BOOTSTRAP_ENABLED=true and PLATFORM_BOOTSTRAP_TOKEN >= 32 bytes.
   */
  public bootstrapOwnerKey(params: {
    bootstrapHeaderToken: string;
    sourceAddress?: string;
    body?: unknown;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const requestId = params.requestId ?? `req_${crypto.randomUUID()}`;
    const sourceKey = (params.sourceAddress ?? 'unknown').trim() || 'unknown';
    const now = this.nowMs;

    if (!this.isBootstrapEnabled()) {
      return {
        status: 503,
        body: buildPlatformErrorEnvelope({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Platform owner credential bootstrap is disabled.',
          requestId,
        }),
      };
    }

    const configuredToken = this.getConfiguredBootstrapToken();
    if (!configuredToken || Buffer.byteLength(configuredToken, 'utf8') < 32) {
      return {
        status: 503,
        body: buildPlatformErrorEnvelope({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Platform bootstrap credential configuration is missing or invalid.',
          requestId,
        }),
      };
    }

    // Rate-limit failed attempts: max 3 per 15 minutes per source address
    const bucket = this.bootstrapFailuresBySource.get(sourceKey) ?? { failedTimestamps: [] };
    bucket.failedTimestamps = bucket.failedTimestamps.filter(
      (ts) => now - ts < BOOTSTRAP_WINDOW_MS,
    );
    if (bucket.failedTimestamps.length >= BOOTSTRAP_MAX_FAILURES) {
      const oldest = bucket.failedTimestamps[0];
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + BOOTSTRAP_WINDOW_MS - now) / 1000),
      );
      return {
        status: 429,
        body: buildPlatformErrorEnvelope({
          code: 'RATE_LIMITED',
          message: 'Too many failed bootstrap attempts. Try again later.',
          requestId,
          retryable: true,
          retryAfterSeconds,
        }),
      };
    }

    const provided = typeof params.bootstrapHeaderToken === 'string'
      ? params.bootstrapHeaderToken.trim()
      : '';
    if (!provided || !constantTimeTokenMatch(provided, configuredToken)) {
      bucket.failedTimestamps.push(now);
      this.bootstrapFailuresBySource.set(sourceKey, bucket);
      return {
        status: 401,
        body: buildPlatformErrorEnvelope({
          code: 'AUTHENTICATION_FAILED',
          message: 'Invalid or missing platform bootstrap token.',
          requestId,
        }),
      };
    }

    // Reject caller-supplied principalId / organizationId overrides
    const bodyObj = asPlainRecord(params.body);
    if (bodyObj === null) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object or empty.',
          requestId,
        }),
      };
    }
    if (
      extractClaimedPrincipalId(bodyObj) !== null ||
      extractClaimedTenantId(bodyObj) !== null
    ) {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Bootstrap endpoint does not accept caller-supplied principal or organization identifiers.',
          requestId,
        }),
      };
    }

    const seededOrgId = 'org_avapardaz_sandbox';
    const seededOwnerId = 'usr_studio_owner_01';
    const seededDevProjectId = 'prj_avapardaz_dev_01';

    const org = this.controlPlane.getOrganization(seededOrgId);
    const owner = this.controlPlane.getUser(seededOwnerId);
    const devProject = this.controlPlane.getProject(seededDevProjectId);
    if (
      !org ||
      org.organizationStatus !== 'ACTIVE' ||
      !owner ||
      owner.accountStatus !== 'ACTIVE' ||
      !devProject ||
      devProject.organizationId !== seededOrgId ||
      devProject.environment !== 'DEVELOPMENT'
    ) {
      return {
        status: 503,
        body: buildPlatformErrorEnvelope({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Seeded owner identity or development project is unavailable for bootstrap.',
          requestId,
        }),
      };
    }

    // Refuse re-bootstrap once an active owner credential with api-keys:manage exists
    if (this.controlPlane.hasActiveOwnerKeyWithManageScope(seededOrgId)) {
      this.controlPlane.recordAuditLog({
        organizationId: seededOrgId,
        actorType: 'SYSTEM',
        actorId: 'platform_bootstrap',
        action: 'PLATFORM_BOOTSTRAP_OWNER_KEY',
        resourceType: 'api_credential',
        resourceId: seededOrgId,
        outcome: 'DENIED',
        reason: 'ACTIVE_OWNER_MANAGE_KEY_ALREADY_EXISTS',
      });
      return {
        status: 409,
        body: buildPlatformErrorEnvelope({
          code: 'CONFLICT',
          message: 'Owner bootstrap already completed; an active owner credential with api-keys:manage already exists.',
          requestId,
        }),
      };
    }

    const issued = this.controlPlane.issueApiKey({
      organizationId: seededOrgId,
      projectId: seededDevProjectId,
      principalId: seededOwnerId,
      actorUserId: seededOwnerId,
      name: 'Bootstrapped Owner Admin Key (Development)',
      scopes: [...BOOTSTRAP_OWNER_SCOPES],
      expiresInDays: 30,
      requireFiniteExpiration: true,
      issuerRole: 'OWNER',
    });

    return {
      status: 201,
      body: {
        credential: issued.credential,
        plaintextSecretOnce: issued.plaintextSecretOnce,
        securityNotice:
          'Remove PLATFORM_BOOTSTRAP_TOKEN and set PLATFORM_BOOTSTRAP_ENABLED=false immediately after storing this credential.',
      },
    };
  }

  public async getOverview(params: {
    bearerToken: string;
    claimedTenantId?: string | null;
    requestId?: string;
  }): Promise<PlatformControlPlaneResponse> {
    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_READ_OVERVIEW',
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const overview = this.controlPlane.getPortalOverview(auth.context.organizationId);
    const resolvedModels = this.options.resolvePublicModels
      ? await this.options.resolvePublicModels()
      : overview.models;

    this.controlPlane.recordAuditLog({
      organizationId: auth.context.organizationId,
      actorType: 'USER',
      actorId: auth.context.principalId,
      action: 'PLATFORM_READ_OVERVIEW',
      resourceType: 'organization',
      resourceId: auth.context.organizationId,
      outcome: 'ALLOWED',
      reason: `CredentialId=${auth.context.credentialId}`,
    });

    return {
      status: 200,
      body: {
        ...overview,
        models: resolvedModels,
        plans: PHASE10_VERSIONED_PLAN_CATALOG,
      },
    };
  }

  public createProject(params: {
    bearerToken: string;
    body: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_CREATE_PROJECT',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const allowedKeys = new Set(['projectName', 'environment']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: `Unknown or forbidden field '${key}' in project creation payload.`,
            requestId: auth.context.requestId,
          }),
        };
      }
    }

    const rawName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
    if (rawName.length < 1 || rawName.length > 80) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'projectName must be a trimmed string between 1 and 80 characters.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const rawEnv = body.environment ?? 'DEVELOPMENT';
    if (typeof rawEnv !== 'string' || !VALID_PROJECT_ENVIRONMENTS.has(rawEnv as ProjectEnvironment)) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: "environment must be one of 'DEVELOPMENT', 'STAGING', or 'PRODUCTION'.",
          requestId: auth.context.requestId,
        }),
      };
    }
    const environment = rawEnv as ProjectEnvironment;

    // Step-up requirement for PRODUCTION project creation via API key (AVP-011 §9)
    if (environment === 'PRODUCTION') {
      this.controlPlane.recordAuditLog({
        organizationId: auth.context.organizationId,
        actorType: 'USER',
        actorId: auth.context.principalId,
        action: 'PLATFORM_CREATE_PROJECT',
        resourceType: 'project',
        resourceId: auth.context.organizationId,
        outcome: 'DENIED',
        reason: 'STEP_UP_AUTHENTICATION_REQUIRED_FOR_PRODUCTION_PROJECT',
      });
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'STEP_UP_AUTHENTICATION_REQUIRED',
          message:
            'Creating a PRODUCTION project via API credential requires fresh step-up authentication.',
          requestId: auth.context.requestId,
        }),
      };
    }

    // Reject duplicate project names in the same organization
    const existingProjects = this.controlPlane.listProjects(auth.context.organizationId);
    if (existingProjects.some((p) => p.projectName.toLowerCase() === rawName.toLowerCase())) {
      return {
        status: 409,
        body: buildPlatformErrorEnvelope({
          code: 'CONFLICT',
          message: 'A project with this name already exists in the organization.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const created = this.controlPlane.createProject({
      organizationId: auth.context.organizationId,
      projectName: rawName,
      environment,
      actorUserId: auth.context.principalId,
    });

    return {
      status: 201,
      body: created,
    };
  }

  public issueApiKey(params: {
    bearerToken: string;
    body: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_ISSUE_API_KEY',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const allowedKeys = new Set(['projectId', 'name', 'scopes', 'expiresInDays', 'allowedIpCidrs']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: `Unknown or forbidden field '${key}' in API key issuance payload.`,
            requestId: auth.context.requestId,
          }),
        };
      }
    }

    const requestedProjectId =
      typeof body.projectId === 'string' && body.projectId.trim().length > 0
        ? body.projectId.trim()
        : auth.context.projectId;

    const targetProject = this.controlPlane.getProject(requestedProjectId);
    if (!targetProject || targetProject.organizationId !== auth.context.organizationId) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Target project not found.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'name must be a trimmed string between 1 and 80 characters.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const scopeValidation = validateRequestedScopes(body.scopes);
    if (!scopeValidation.valid) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: scopeValidation.message,
          requestId: auth.context.requestId,
        }),
      };
    }

    const delegation = validateScopeDelegation({
      issuerRole: auth.context.role,
      requestedScopes: scopeValidation.scopes,
    });
    if (!delegation.allowed) {
      this.controlPlane.recordAuditLog({
        organizationId: auth.context.organizationId,
        actorType: 'USER',
        actorId: auth.context.principalId,
        action: 'PLATFORM_ISSUE_API_KEY',
        resourceType: 'api_credential',
        resourceId: targetProject.id,
        outcome: 'DENIED',
        reason: `SCOPE_DELEGATION_DENIED:${delegation.deniedScopes.join(',')}`,
      });
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Requested scopes exceed the permitted delegation boundary for your role.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const expiresInDays = body.expiresInDays === undefined ? 90 : body.expiresInDays;
    if (
      typeof expiresInDays !== 'number' ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > 365
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'expiresInDays must be an integer between 1 and 365.',
          requestId: auth.context.requestId,
        }),
      };
    }

    let allowedIpCidrs: string[] | undefined;
    if (body.allowedIpCidrs !== undefined) {
      if (
        !Array.isArray(body.allowedIpCidrs) ||
        !body.allowedIpCidrs.every((v) => typeof v === 'string' && v.trim().length > 0)
      ) {
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: 'allowedIpCidrs must be an array of non-empty strings.',
            requestId: auth.context.requestId,
          }),
        };
      }
      allowedIpCidrs = body.allowedIpCidrs.map((v) => v.trim());
    }

    try {
      const issued = this.controlPlane.issueApiKey({
        organizationId: auth.context.organizationId,
        projectId: targetProject.id,
        principalId: auth.context.principalId,
        actorUserId: auth.context.principalId,
        issuerRole: auth.context.role,
        name,
        scopes: scopeValidation.scopes,
        expiresInDays,
        requireFiniteExpiration: true,
        allowedIpCidrs,
      });
      return { status: 201, body: issued };
    } catch {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Unable to issue API credential with the supplied parameters.',
          requestId: auth.context.requestId,
        }),
      };
    }
  }

  public rotateApiKey(params: {
    bearerToken: string;
    credentialId: string;
    body?: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_ROTATE_API_KEY',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const target = this.controlPlane.getCredentialMetadata(params.credentialId);
    if (!target || target.organizationId !== auth.context.organizationId) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: 'API credential not found.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const overlapHours = body.overlapHours === undefined ? 24 : body.overlapHours;
    if (
      typeof overlapHours !== 'number' ||
      !Number.isFinite(overlapHours) ||
      overlapHours < 0 ||
      overlapHours > 24
    ) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'overlapHours must be a finite number between 0 and 24.',
          requestId: auth.context.requestId,
        }),
      };
    }

    try {
      const rotated = this.controlPlane.rotateApiKey({
        credentialId: target.id,
        organizationId: auth.context.organizationId,
        overlapHours,
        actorUserId: auth.context.principalId,
        issuerRole: auth.context.role,
      });
      return { status: 200, body: rotated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('CREDENTIAL_ALREADY_REVOKED') || msg.includes('CREDENTIAL_EXPIRED') || msg.includes('CREDENTIAL_OVERLAP_EXPIRED')) {
        return {
          status: 409,
          body: buildPlatformErrorEnvelope({
            code: 'CONFLICT',
            message: 'Credential cannot be rotated in its current lifecycle state.',
            requestId: auth.context.requestId,
          }),
        };
      }
      if (msg.includes('SCOPE_DELEGATION_DENIED')) {
        return {
          status: 403,
          body: buildPlatformErrorEnvelope({
            code: 'AUTHORIZATION_DENIED',
            message: 'Authenticated role cannot rotate a credential with scopes outside its delegation boundary.',
            requestId: auth.context.requestId,
          }),
        };
      }
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Credential rotation failed.',
          requestId: auth.context.requestId,
        }),
      };
    }
  }

  public revokeApiKey(params: {
    bearerToken: string;
    credentialId: string;
    body?: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_REVOKE_API_KEY',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const target = this.controlPlane.getCredentialMetadata(params.credentialId);
    if (!target || target.organizationId !== auth.context.organizationId) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: 'API credential not found.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const revoked = this.controlPlane.revokeApiKey({
      credentialId: target.id,
      organizationId: auth.context.organizationId,
      actorUserId: auth.context.principalId,
    });
    return { status: 200, body: revoked };
  }

  public issueInvoice(params: {
    bearerToken: string;
    body?: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object or empty.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_ISSUE_INVOICE',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    // Strictly reject caller-supplied financial/tenant overrides (AVP-011 §11)
    const forbiddenFields = Object.keys(body);
    if (forbiddenFields.length > 0) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: `Client-supplied billing override fields are forbidden (${forbiddenFields.join(', ')}).`,
          requestId: auth.context.requestId,
        }),
      };
    }

    const sub = this.controlPlane.getSubscription(auth.context.organizationId);
    if (!sub) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Active subscription not found for authenticated organization.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const serverComputedTaxBasisPoints = 0;
    const invoice = this.controlPlane.issueMonthlyStatementInvoice(
      auth.context.organizationId,
      serverComputedTaxBasisPoints,
      { actorUserId: auth.context.principalId },
    );

    return {
      status: 201,
      body: invoice,
    };
  }

  public async registerWebhook(params: {
    bearerToken: string;
    body: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): Promise<PlatformControlPlaneResponse> {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_REGISTER_WEBHOOK',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const allowedKeys = new Set(['url', 'eventSubscriptions']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: `Unknown or forbidden field '${key}' in webhook registration payload.`,
            requestId: auth.context.requestId,
          }),
        };
      }
    }

    const eventsCheck = validateWebhookEventSubscriptions(body.eventSubscriptions);
    if (!eventsCheck.valid) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: eventsCheck.message,
          requestId: auth.context.requestId,
        }),
      };
    }

    const urlCheck = await validateWebhookDestinationUrl({
      url: body.url,
      isProduction: this.isProduction,
      allowedDevHosts: this.options.allowedDevWebhookHosts,
      dnsLookup: this.options.dnsLookup,
    });
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      this.controlPlane.recordAuditLog({
        organizationId: auth.context.organizationId,
        actorType: 'USER',
        actorId: auth.context.principalId,
        action: 'PLATFORM_REGISTER_WEBHOOK',
        resourceType: 'webhook_endpoint',
        resourceId: auth.context.organizationId,
        outcome: 'DENIED',
        reason: urlCheck.reasonCode ?? 'WEBHOOK_URL_REJECTED',
      });
      return {
        status: 422,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: urlCheck.message ?? 'Webhook destination URL rejected by security policy.',
          requestId: auth.context.requestId,
          details: { reasonCode: urlCheck.reasonCode },
        }),
      };
    }

    try {
      const created = this.controlPlane.registerWebhookEndpoint({
        organizationId: auth.context.organizationId,
        url: urlCheck.normalizedUrl,
        eventSubscriptions: eventsCheck.events,
        actorId: auth.context.principalId,
      });
      const { signingSecret, ...sanitizedEndpoint } = created;
      return {
        status: 201,
        body: {
          endpoint: {
            ...sanitizedEndpoint,
            signingSecretMasked: `${signingSecret.slice(0, 10)}...****`,
          },
          signingSecretOnce: signingSecret,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('WEBHOOK_ENDPOINT_DUPLICATE') || msg.includes('WEBHOOK_ENDPOINT_LIMIT_EXCEEDED')) {
        return {
          status: 409,
          body: buildPlatformErrorEnvelope({
            code: 'CONFLICT',
            message: msg.includes('LIMIT')
              ? 'Organization has reached the maximum limit of 25 webhook endpoints.'
              : 'Webhook destination URL is already registered for this organization.',
            requestId: auth.context.requestId,
          }),
        };
      }
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Webhook endpoint registration failed.',
          requestId: auth.context.requestId,
        }),
      };
    }
  }

  public testWebhookDispatch(params: {
    bearerToken: string;
    body?: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_TEST_WEBHOOKS',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const authProject = this.controlPlane.getProject(auth.context.projectId);
    if (this.isProduction || !authProject || authProject.environment !== 'DEVELOPMENT') {
      return {
        status: 403,
        body: buildPlatformErrorEnvelope({
          code: 'AUTHORIZATION_DENIED',
          message: 'Webhook test dispatch is restricted to DEVELOPMENT environment.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const simulateFailure = Boolean(body.simulateFailure);
    const deliveries = this.controlPlane.dispatchWebhookEvent({
      organizationId: auth.context.organizationId,
      eventType: 'transcription.completed',
      data: { transcription_id: 'tr_sandbox_test', status: 'test_event' },
      simulateFailureForTesting: simulateFailure,
    });

    this.controlPlane.recordAuditLog({
      organizationId: auth.context.organizationId,
      actorType: 'USER',
      actorId: auth.context.principalId,
      action: 'PLATFORM_TEST_WEBHOOKS',
      resourceType: 'webhook_delivery',
      resourceId: auth.context.organizationId,
      outcome: 'ALLOWED',
      reason: `DispatchedCount=${deliveries.length}, SimulateFailure=${simulateFailure}`,
    });

    return {
      status: 200,
      body: { deliveries },
    };
  }

  public replayWebhookDelivery(params: {
    bearerToken: string;
    deliveryId: string;
    body?: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_MANAGE_WEBHOOKS',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    const existing = this.controlPlane.getWebhookDelivery(params.deliveryId);
    if (!existing || existing.organizationId !== auth.context.organizationId) {
      return {
        status: 404,
        body: buildPlatformErrorEnvelope({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Webhook delivery record not found.',
          requestId: auth.context.requestId,
        }),
      };
    }

    if (existing.status !== 'DEAD_LETTER') {
      return {
        status: 409,
        body: buildPlatformErrorEnvelope({
          code: 'CONFLICT',
          message: 'Only DEAD_LETTER webhook deliveries may be replayed.',
          requestId: auth.context.requestId,
        }),
      };
    }

    const replayed = this.controlPlane.replayDeadLetterWebhook(
      existing.deliveryId,
      auth.context.organizationId,
      auth.context.principalId,
    );

    return {
      status: 202,
      body: {
        delivery: replayed,
        workerAvailable: false,
        message: 'Replay enqueued as RETRY_SCHEDULED; delivery awaits live outbound delivery worker acknowledgement.',
      },
    };
  }

  public checkRegionPolicy(params: {
    bearerToken: string;
    body?: unknown;
    claimedTenantId?: string | null;
    requestId?: string;
  }): PlatformControlPlaneResponse {
    const body = asPlainRecord(params.body);
    if (!body) {
      return {
        status: 400,
        body: buildPlatformErrorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object.',
          requestId: params.requestId,
        }),
      };
    }

    const auth = this.authorize({
      bearerToken: params.bearerToken,
      operation: 'PLATFORM_CHECK_REGION',
      body,
      claimedTenantId: params.claimedTenantId,
      requestId: params.requestId,
    });
    if (!auth.ok) return auth.response;

    let targetProjectId = auth.context.projectId;
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== 'string' || body.projectId.trim().length === 0) {
        return {
          status: 400,
          body: buildPlatformErrorEnvelope({
            code: 'VALIDATION_ERROR',
            message: 'projectId must be a non-empty string when supplied.',
            requestId: auth.context.requestId,
          }),
        };
      }
      const requestedProject = this.controlPlane.getProject(body.projectId.trim());
      if (!requestedProject || requestedProject.organizationId !== auth.context.organizationId) {
        return {
          status: 404,
          body: buildPlatformErrorEnvelope({
            code: 'RESOURCE_NOT_FOUND',
            message: 'Project not found.',
            requestId: auth.context.requestId,
          }),
        };
      }
      if (
        requestedProject.id !== auth.context.projectId &&
        auth.context.role !== 'OWNER' &&
        auth.context.role !== 'ADMIN' &&
        auth.context.role !== 'SECURITY_AUDITOR'
      ) {
        return {
          status: 403,
          body: buildPlatformErrorEnvelope({
            code: 'AUTHORIZATION_DENIED',
            message: 'Credential is not authorized to inspect region policy for a different project.',
            requestId: auth.context.requestId,
          }),
        };
      }
      targetProjectId = requestedProject.id;
    }

    const requestedRegionId =
      typeof body.regionId === 'string' && body.regionId.trim().length > 0
        ? body.regionId.trim()
        : undefined;

    const check = this.controlPlane.validateRegionPolicy({
      organizationId: auth.context.organizationId,
      projectId: targetProjectId,
      requestedRegionId,
    });

    return {
      status: check.allowed ? 200 : 422,
      body: check,
    };
  }
}
