/**
 * @file backend/src/auth/EnterpriseApiKeyAndQuotaManager.ts
 * @description Section 138: B2B Enterprise API Key Issuance, SHA-256 Storage, Scope Authorization,
 *              and Race-Free Atomic PostgreSQL Audio Quota Consumption.
 */

import crypto from 'node:crypto';
import type { PgPoolLike } from '../PlatformBackendServices';

export type EnterpriseKeyScope =
  | 'MODELS_READ'
  | 'EXTERNAL_GATEWAY'
  | 'CLOUD_ASR_ENTERPRISE';

const ALLOWED_ENTERPRISE_SCOPES = new Set<EnterpriseKeyScope>([
  'MODELS_READ',
  'EXTERNAL_GATEWAY',
  'CLOUD_ASR_ENTERPRISE',
]);
const MAX_QUOTA_DELTA_SECONDS = 2_147_483_647;

export interface VerifiedEnterpriseKeyContext {
  readonly keyId: string;
  readonly organizationId: string;
  readonly scopes: EnterpriseKeyScope[];
  readonly remainingAudioSeconds: number;
}

export class EnterpriseApiKeyAndQuotaManager {
  constructor(private readonly db: PgPoolLike) {}

  /**
   * 1. Issues a new `paudio_live_...` API key and stores ONLY its SHA-256 hash in PostgreSQL.
   *    The plaintext key is returned once and cannot be retrieved again.
   */
  public async issueNewEnterpriseApiKey(params: {
    organizationId: string;
    scopes: EnterpriseKeyScope[];
    monthlyAudioSecondsLimit: number;
    expiresInDays?: number;
  }): Promise<{
    keyId: string;
    plaintextApiKeyOnce: string;
    keyPrefix: string;
  }> {
    if (
      typeof params.organizationId !== 'string' ||
      params.organizationId.trim().length === 0 ||
      !Array.isArray(params.scopes) ||
      params.scopes.length === 0 ||
      typeof params.monthlyAudioSecondsLimit !== 'number' ||
      !Number.isSafeInteger(params.monthlyAudioSecondsLimit) ||
      params.monthlyAudioSecondsLimit < 0
    ) {
      throw new Error('ENTERPRISE_KEY_ISSUE_INVALID_PARAMS');
    }
    if (
      params.expiresInDays !== undefined &&
      (!Number.isSafeInteger(params.expiresInDays) || params.expiresInDays <= 0)
    ) {
      throw new Error('ENTERPRISE_KEY_INVALID_EXPIRY_DAYS');
    }
    const normalizedScopes: EnterpriseKeyScope[] = [];
    for (const s of params.scopes) {
      if (typeof s !== 'string' || !ALLOWED_ENTERPRISE_SCOPES.has(s as EnterpriseKeyScope)) {
        throw new Error('ENTERPRISE_KEY_INVALID_SCOPE');
      }
      if (!normalizedScopes.includes(s as EnterpriseKeyScope)) {
        normalizedScopes.push(s as EnterpriseKeyScope);
      }
    }

    const rawSecret = crypto.randomBytes(24).toString('hex');
    const plaintextApiKeyOnce = `paudio_live_${rawSecret}`;
    const keyPrefix = plaintextApiKeyOnce.slice(0, 18);
    const keySha256Hex = this.hashApiKey(plaintextApiKeyOnce);

    const res = await this.db.query<{ key_id: string }>(
      `INSERT INTO enterprise_api_keys
       (organization_id, key_prefix, key_sha256_hex, scopes, monthly_audio_seconds_limit, expires_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() + ($6 || ' days')::interval END)
       RETURNING key_id`,
      [
        params.organizationId.trim(),
        keyPrefix,
        keySha256Hex,
        normalizedScopes,
        params.monthlyAudioSecondsLimit,
        params.expiresInDays ?? null,
      ],
    );

    return {
      keyId: res.rows[0].key_id,
      plaintextApiKeyOnce,
      keyPrefix,
    };
  }

  /**
   * 2. Authenticates a provided plaintext key via SHA-256 lookup and verifies revocation, expiry, and scope.
   */
  public async authenticateAndAuthorizeScope(
    providedPlaintextKey: string,
    requiredScope: EnterpriseKeyScope,
  ): Promise<VerifiedEnterpriseKeyContext> {
    if (
      typeof providedPlaintextKey !== 'string' ||
      !providedPlaintextKey.startsWith('paudio_live_')
    ) {
      throw new Error('ENTERPRISE_KEY_MALFORMED');
    }

    const hashHex = this.hashApiKey(providedPlaintextKey);
    const res = await this.db.query<{
      key_id: string;
      organization_id: string;
      scopes: EnterpriseKeyScope[];
      monthly_audio_seconds_limit: string;
      monthly_audio_seconds_used: string;
      revoked: boolean;
      expires_at: Date | null;
    }>(
      `SELECT key_id, organization_id, scopes, monthly_audio_seconds_limit,
              monthly_audio_seconds_used, revoked, expires_at
       FROM enterprise_api_keys
       WHERE key_sha256_hex = $1`,
      [hashHex],
    );

    if (res.rows.length === 0) {
      throw new Error('ENTERPRISE_KEY_INVALID');
    }

    const row = res.rows[0];
    if (row.revoked) {
      throw new Error('ENTERPRISE_KEY_REVOKED');
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      throw new Error('ENTERPRISE_KEY_EXPIRED');
    }
    if (!row.scopes.includes(requiredScope)) {
      throw new Error(
        `ENTERPRISE_KEY_FORBIDDEN_SCOPE: نیازمند مجوز ${requiredScope}`,
      );
    }

    const remaining = Math.max(
      0,
      Number(row.monthly_audio_seconds_limit) -
        Number(row.monthly_audio_seconds_used),
    );

    return {
      keyId: row.key_id,
      organizationId: row.organization_id,
      scopes: row.scopes,
      remainingAudioSeconds: remaining,
    };
  }

  /**
   * 3. Atomically deducts audio seconds quota in PostgreSQL without race conditions under concurrent requests.
   */
  public async consumeAudioQuotaAtomically(
    keyId: string,
    requestedAudioSeconds: number,
  ): Promise<{
    approved: boolean;
    newUsedSeconds: number;
    remainingSeconds: number;
  }> {
    if (
      typeof keyId !== 'string' ||
      keyId.trim().length === 0 ||
      typeof requestedAudioSeconds !== 'number' ||
      !Number.isFinite(requestedAudioSeconds) ||
      requestedAudioSeconds <= 0
    ) {
      return { approved: false, newUsedSeconds: 0, remainingSeconds: 0 };
    }

    const roundedSec = Math.max(1, Math.ceil(requestedAudioSeconds));
    if (!Number.isSafeInteger(roundedSec) || roundedSec > MAX_QUOTA_DELTA_SECONDS) {
      return { approved: false, newUsedSeconds: 0, remainingSeconds: 0 };
    }

    const res = await this.db.query<{
      monthly_audio_seconds_used: string;
      monthly_audio_seconds_limit: string;
    }>(
      `UPDATE enterprise_api_keys
       SET monthly_audio_seconds_used = monthly_audio_seconds_used + $2
       WHERE key_id = $1
         AND revoked = FALSE
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (monthly_audio_seconds_used + $2) <= monthly_audio_seconds_limit
       RETURNING monthly_audio_seconds_used, monthly_audio_seconds_limit`,
      [keyId, roundedSec],
    );

    if (res.rows.length === 0) {
      return { approved: false, newUsedSeconds: 0, remainingSeconds: 0 };
    }

    const used = Number(res.rows[0].monthly_audio_seconds_used);
    const limit = Number(res.rows[0].monthly_audio_seconds_limit);
    return {
      approved: true,
      newUsedSeconds: used,
      remainingSeconds: Math.max(0, limit - used),
    };
  }

  /**
   * 4. Atomically refunds previously deducted quota if downstream job enqueue/admission fails.
   */
  public async refundAudioQuotaAtomically(
    keyId: string,
    refundAudioSeconds: number,
  ): Promise<void> {
    if (
      typeof keyId !== 'string' ||
      keyId.trim().length === 0 ||
      typeof refundAudioSeconds !== 'number' ||
      !Number.isFinite(refundAudioSeconds) ||
      refundAudioSeconds <= 0
    ) {
      return;
    }
    const roundedSec = Math.max(1, Math.ceil(refundAudioSeconds));
    if (!Number.isSafeInteger(roundedSec) || roundedSec > MAX_QUOTA_DELTA_SECONDS) {
      return;
    }
    await this.db.query(
      `UPDATE enterprise_api_keys
       SET monthly_audio_seconds_used = GREATEST(0, monthly_audio_seconds_used - $2)
       WHERE key_id = $1`,
      [keyId, roundedSec],
    );
  }

  private hashApiKey(plaintextKey: string): string {
    return crypto.createHash('sha256').update(plaintextKey, 'utf8').digest('hex');
  }
}
