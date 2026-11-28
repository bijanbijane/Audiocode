/**
 * @file backend/src/license/DeviceSeatEnforcementService.ts
 * @description Single authoritative device-seat policy, subscription entitlement resolution,
 *              protected license route matching, and transactional row-locked seat enforcement.
 */

import {
  PgTransactionClient,
  PinnedTransactionUnavailableError,
} from '../db/PinnedPostgresTransaction';

export type LicensePlanTier =
  | 'FREE_TRIAL'
  | 'PRO_MONTHLY'
  | 'PRO_ANNUAL'
  | 'STUDIO_ENTERPRISE';

/**
 * Single authoritative device-seat allowance table shared across lease issuance
 * and device-seat enforcement. Never accepts client-supplied plan overrides.
 */
export const PLAN_MAX_DEVICES: Readonly<Record<LicensePlanTier, number>> = Object.freeze({
  FREE_TRIAL: 1,
  PRO_MONTHLY: 2,
  PRO_ANNUAL: 3,
  STUDIO_ENTERPRISE: 10,
});

/**
 * Exact set of authenticated license endpoints protected by the EdDSA JWT preHandler
 * across both BackendApplicationFactory and server.ts.
 */
export const PROTECTED_LICENSE_ROUTE_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/license/lease',
  '/api/v1/license/enforce-device-seat',
  '/api/v1/license/sync-state',
]);

const DEVICE_FINGERPRINT_SHA256_REGEX = /^[0-9a-fA-F]{64}$/;

export function isSupportedPlanTier(value: unknown): value is LicensePlanTier {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PLAN_MAX_DEVICES, value)
  );
}

/**
 * Extracts normalized pathname independently of query string or fragment.
 */
export function extractUrlPathname(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return '';
  }
  const queryIdx = rawUrl.indexOf('?');
  const hashIdx = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (queryIdx !== -1 && queryIdx < end) end = queryIdx;
  if (hashIdx !== -1 && hashIdx < end) end = hashIdx;
  const pathname = rawUrl.slice(0, end);
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function isProtectedAuthenticatedUserRoute(rawUrl: string): boolean {
  const pathname = extractUrlPathname(rawUrl);
  return (
    PROTECTED_LICENSE_ROUTE_PATHS.has(pathname) ||
    /^\/api\/v1\/billing\/users\/[^/]+\/invoices$/.test(pathname)
  );
}

/** Backward-compatible name retained for existing license-route callers. */
export function isProtectedLicenseRoute(rawUrl: string): boolean {
  return isProtectedAuthenticatedUserRoute(rawUrl);
}

export class InvalidUserIdentityError extends Error {
  public readonly code = 'AUTHENTICATION_REQUIRED' as const;

  constructor(message = 'Valid authenticated user identity is required.') {
    super(message);
    this.name = 'InvalidUserIdentityError';
  }
}

export class InvalidDeviceFingerprintError extends Error {
  public readonly code = 'INVALID_DEVICE_FINGERPRINT' as const;

  constructor(message = 'Device fingerprint must be a valid 64-character hex SHA-256 string.') {
    super(message);
    this.name = 'InvalidDeviceFingerprintError';
  }
}

export class NoActiveSubscriptionError extends Error {
  public readonly code = 'NO_ACTIVE_SUBSCRIPTION' as const;

  constructor(message = 'No active non-expired subscription was found for this account.') {
    super(message);
    this.name = 'NoActiveSubscriptionError';
  }
}

export class DeviceSeatPolicyError extends Error {
  public readonly code = 'DEVICE_SEAT_POLICY_VIOLATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceSeatPolicyError';
  }
}

export function validateAndNormalizeDeviceFingerprintHash(raw: unknown): string {
  if (typeof raw !== 'string' || !DEVICE_FINGERPRINT_SHA256_REGEX.test(raw)) {
    throw new InvalidDeviceFingerprintError();
  }
  return raw.toLowerCase();
}

export interface AuthoritativeSubscriptionRecord {
  readonly id: string;
  readonly planTier: LicensePlanTier;
  readonly currentPeriodEnd: Date;
  readonly offlineGraceHours: number;
}

export interface DeviceSeatEnforcementResult {
  readonly seatAllowed: true;
  readonly userId: string;
  readonly normalizedDeviceFingerprintHash: string;
  readonly subscription: AuthoritativeSubscriptionRecord;
  readonly maxDevicesAllowed: number;
  readonly activeDevicesAfterEnforcement: number;
  readonly evictedOldDevicesCount: number;
  readonly evictedDeviceHashes: readonly string[];
}

interface LockedSubscriptionRow {
  readonly id: string;
  readonly plan_tier: string;
  readonly current_period_end: Date | string;
  readonly offline_grace_hours: number;
}

interface LockedActiveLeaseRow {
  readonly lease_id: string;
  readonly device_fingerprint_hash: string;
  readonly issued_at: Date | string;
}

/**
 * Enforces per-account device-seat limits exclusively from database-backed subscription
 * entitlement inside the caller's pinned PostgreSQL transaction.
 *
 * Locking discipline:
 * 1. Locks the user row (`SELECT id FROM users WHERE id = $1 FOR UPDATE`) to serialize
 *    concurrent lease/seat operations per account even when zero leases currently exist.
 * 2. Resolves and locks the latest active, non-expired subscription (`FOR UPDATE`).
 * 3. Locks all active, non-revoked, non-expired leases ordered oldest-first (`FOR UPDATE`).
 * 4. Computes distinct devices, evicts oldest distinct devices in a single parameterized
 *    `UPDATE` when over capacity, and returns authoritative entitlement + seat counts.
 */
export async function enforceDeviceSeatsForAuthenticatedUser(
  client: PgTransactionClient,
  authenticatedUserId: string,
  deviceFingerprintHash: string,
): Promise<DeviceSeatEnforcementResult> {
  if (typeof authenticatedUserId !== 'string' || authenticatedUserId.trim().length === 0) {
    throw new InvalidUserIdentityError();
  }
  const userId = authenticatedUserId.trim();
  const normalizedFingerprint = validateAndNormalizeDeviceFingerprintHash(deviceFingerprintHash);

  // 1. Serialize per-account entitlement & seat operations on the user row.
  const userRes = await client.query<{ id: string; status?: string }>(
    `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  if (userRes.rows.length === 0) {
    throw new NoActiveSubscriptionError('Account does not exist.');
  }
  if (userRes.rows[0].status !== undefined && userRes.rows[0].status !== 'ACTIVE') {
    throw new NoActiveSubscriptionError('Account is not active.');
  }

  // 2. Resolve authoritative active, non-expired subscription from PostgreSQL.
  const subRes = await client.query<LockedSubscriptionRow>(
    `SELECT id, plan_tier, current_period_end, offline_grace_hours
     FROM subscriptions
     WHERE user_id = $1 AND status = 'ACTIVE' AND current_period_end > NOW()
     ORDER BY current_period_end DESC
     LIMIT 1
     FOR UPDATE`,
    [userId],
  );

  if (subRes.rows.length === 0) {
    throw new NoActiveSubscriptionError();
  }

  const subRow = subRes.rows[0];
  if (!isSupportedPlanTier(subRow.plan_tier)) {
    throw new DeviceSeatPolicyError(`Unsupported subscription plan tier: ${String(subRow.plan_tier)}`);
  }

  const periodEnd = new Date(subRow.current_period_end);
  if (Number.isNaN(periodEnd.getTime()) || periodEnd.getTime() <= Date.now()) {
    throw new NoActiveSubscriptionError('Active subscription period has expired.');
  }

  if (
    typeof subRow.offline_grace_hours !== 'number' ||
    !Number.isInteger(subRow.offline_grace_hours) ||
    subRow.offline_grace_hours < 0
  ) {
    throw new DeviceSeatPolicyError('Invalid subscription offline_grace_hours configuration.');
  }

  const maxDevices = PLAN_MAX_DEVICES[subRow.plan_tier];
  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    throw new DeviceSeatPolicyError('Invalid device seat limit for subscription tier.');
  }

  // 3. Lock active leases for this account ordered oldest-first.
  const activeLeasesRes = await client.query<LockedActiveLeaseRow>(
    `SELECT lease_id, device_fingerprint_hash, issued_at
     FROM offline_license_leases
     WHERE user_id = $1 AND revoked = FALSE AND offline_grace_expires_at > NOW()
     ORDER BY issued_at ASC
     FOR UPDATE`,
    [userId],
  );

  // Preserve oldest-first distinct device order while normalizing case for matching.
  const distinctDevices = new Map<string, Set<string>>();
  for (const row of activeLeasesRes.rows) {
    const rawHash = String(row.device_fingerprint_hash);
    const normalizedKey = rawHash.trim().toLowerCase();
    let variants = distinctDevices.get(normalizedKey);
    if (!variants) {
      variants = new Set<string>();
      distinctDevices.set(normalizedKey, variants);
    }
    variants.add(rawHash);
  }

  const isKnownDevice = distinctDevices.has(normalizedFingerprint);
  let evictedNormalizedKeys: string[] = [];

  if (!isKnownDevice && distinctDevices.size >= maxDevices) {
    const devicesToEvictCount = Math.max(0, distinctDevices.size - maxDevices + 1);
    evictedNormalizedKeys = Array.from(distinctDevices.keys()).slice(0, devicesToEvictCount);
  } else if (isKnownDevice && distinctDevices.size > maxDevices) {
    // Handle tier downgrade: keep current device, evict oldest excess other devices.
    const excessCount = distinctDevices.size - maxDevices;
    evictedNormalizedKeys = Array.from(distinctDevices.keys())
      .filter((key) => key !== normalizedFingerprint)
      .slice(0, excessCount);
  }

  if (evictedNormalizedKeys.length > 0) {
    const rawHashesToRevoke: string[] = [];
    for (const key of evictedNormalizedKeys) {
      const variants = distinctDevices.get(key);
      if (variants) {
        for (const raw of variants) {
          rawHashesToRevoke.push(raw);
        }
      }
    }

    await client.query(
      `UPDATE offline_license_leases
       SET revoked = TRUE
       WHERE user_id = $1
         AND revoked = FALSE
         AND device_fingerprint_hash = ANY($2)`,
      [userId, rawHashesToRevoke],
    );
  }

  const evictedOldDevicesCount = evictedNormalizedKeys.length;
  const activeDevicesAfterEnforcement = isKnownDevice
    ? distinctDevices.size - evictedOldDevicesCount
    : distinctDevices.size - evictedOldDevicesCount + 1;

  return {
    seatAllowed: true,
    userId,
    normalizedDeviceFingerprintHash: normalizedFingerprint,
    subscription: {
      id: subRow.id,
      planTier: subRow.plan_tier,
      currentPeriodEnd: periodEnd,
      offlineGraceHours: subRow.offline_grace_hours,
    },
    maxDevicesAllowed: maxDevices,
    activeDevicesAfterEnforcement,
    evictedOldDevicesCount,
    evictedDeviceHashes: evictedNormalizedKeys,
  };
}

export interface LicenseHttpReplyLike {
  status(code: number): LicenseHttpReplyLike;
  send(payload: unknown): unknown;
}

/**
 * Maps license domain and transaction failures to classified HTTP responses
 * without ever exposing raw PostgreSQL error details or stack traces.
 */
export function sendClassifiedLicenseError(
  reply: LicenseHttpReplyLike,
  err: unknown,
): unknown {
  if (err instanceof InvalidUserIdentityError) {
    return reply.status(401).send({
      error: 'AUTHENTICATION_REQUIRED',
      messageFa: 'احراز هویت معتبر برای دسترسی به مجوز الزامی است.',
    });
  }
  if (err instanceof InvalidDeviceFingerprintError) {
    return reply.status(400).send({
      error: 'INVALID_DEVICE_FINGERPRINT',
      messageFa: 'شناسه سخت‌افزاری دستگاه نامعتبر است.',
    });
  }
  if (err instanceof NoActiveSubscriptionError) {
    return reply.status(403).send({
      error: 'NO_ACTIVE_SUBSCRIPTION',
      messageFa: 'اشتراک فعالی برای این حساب کاربری یافت نشد.',
    });
  }
  if (err instanceof DeviceSeatPolicyError) {
    return reply.status(409).send({
      error: 'DEVICE_SEAT_POLICY_VIOLATION',
      messageFa: 'سیاست سهمیه دستگاه‌های این اشتراک معتبر نیست.',
    });
  }
  if (err instanceof PinnedTransactionUnavailableError) {
    return reply.status(503).send({
      error: 'LICENSE_TRANSACTION_UNAVAILABLE',
      messageFa: 'سرویس تراکنش پایگاه داده در حال حاضر در دسترس نیست.',
    });
  }
  return reply.status(500).send({
    error: 'LICENSE_INTERNAL_ERROR',
    messageFa: 'خطای داخلی در پردازش درخواست مجوز رخ داد.',
  });
}
