/**
 * Browser-safe client for the isolated Fastify/PostgreSQL Platform API.
 *
 * All requests are same-origin and live behind /platform-api/.
 * No signing keys, database settings, or plan/expiry overrides belong in the browser.
 */

export interface PlatformApiUserSession {
  readonly userId: string;
  readonly accessToken: string;
}

export interface PlatformApiPublicKeyInfo {
  readonly publicKeySpkiBase64: string;
  readonly algorithm: 'Ed25519';
  readonly keyVersion: number;
  readonly keyId: string;
}

export interface PlatformApiLegacySignedEnvelope<T> {
  readonly payloadBase64: string;
  readonly signatureBase64: string;
  readonly algorithm: 'Ed25519';
  readonly keyVersion: number;
  readonly decodedPreview?: T;
}

export interface PlatformApiOfflineLeasePayload {
  readonly licenseId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  readonly issuedAtMs: number;
  readonly offlineGraceExpiresAtMs: number;
  readonly allowedModelTiers: readonly ('GROUP_A' | 'GROUP_B')[];
  readonly deviceFingerprint: string;
  readonly planTier: 'FREE_TRIAL' | 'PRO_MONTHLY' | 'PRO_ANNUAL' | 'STUDIO_ENTERPRISE';
  readonly issuedAtUnixSec: number;
  readonly offlineGraceExpiresAtUnixSec: number;
  readonly subscriptionExpiresAtUnixSec: number;
}

export interface PlatformApiSignedModelManifest {
  readonly modelId: string;
  readonly version: string;
  readonly status: 'ACTIVE' | 'SUPPORTED' | 'DEPRECATED' | 'REVOKED';
  readonly tier: 'GROUP_A' | 'GROUP_B';
  readonly totalBytes: number;
  readonly chunkSizeBytes: number;
  readonly chunks: readonly {
    readonly index: number;
    readonly url: string;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly sha256Hex: string;
  }[];
  readonly issuedAtMs: number;
}

export class PlatformApiHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformApiHttpError';
  }
}

export interface PlatformApiClientOptions {
  readonly basePath?: string;
  readonly fetchImpl?: typeof fetch;
}

export class PlatformApiClient {
  private readonly basePath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlatformApiClientOptions = {}) {
    const basePath = (options.basePath ?? '/platform-api').trim();
    if (!basePath.startsWith('/') || basePath.startsWith('//')) {
      throw new Error('PLATFORM_API_BASE_PATH_MUST_BE_SAME_ORIGIN');
    }
    this.basePath = basePath.replace(/\/+$/, '');
    if (!this.basePath) {
      throw new Error('PLATFORM_API_BASE_PATH_REQUIRED');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public register(email: string, password: string): Promise<PlatformApiUserSession> {
    return this.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  public login(email: string, password: string): Promise<PlatformApiUserSession> {
    return this.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  public getPublicKeyInfo(): Promise<PlatformApiPublicKeyInfo> {
    return this.request('/api/v1/crypto/public-key');
  }

  /**
   * The user identity, plan and entitlement expiry come exclusively from the
   * authenticated JWT and PostgreSQL. The client supplies only a device hash.
   */
  public issueOfflineLicenseLease(
    accessToken: string,
    deviceFingerprintHash: string,
    displayName?: string,
  ): Promise<PlatformApiLegacySignedEnvelope<PlatformApiOfflineLeasePayload>> {
    if (!accessToken.trim()) throw new Error('PLATFORM_API_ACCESS_TOKEN_REQUIRED');
    if (!/^[a-f0-9]{64}$/i.test(deviceFingerprintHash)) {
      throw new Error('PLATFORM_API_DEVICE_FINGERPRINT_HASH_INVALID');
    }

    return this.request('/api/v1/license/lease', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        deviceFingerprintHash: deviceFingerprintHash.toLowerCase(),
        ...(displayName?.trim() ? { displayName: displayName.trim().slice(0, 128) } : {}),
      }),
    });
  }

  public getSignedModelManifest(
    modelId: string,
  ): Promise<PlatformApiLegacySignedEnvelope<PlatformApiSignedModelManifest>> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(modelId)) {
      throw new Error('PLATFORM_API_MODEL_ID_INVALID');
    }
    return this.request(`/api/v1/models/${encodeURIComponent(modelId)}/manifest`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.basePath}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const raw = await response.text();
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        throw new PlatformApiHttpError(response.status, 'INVALID_PLATFORM_API_RESPONSE', 'Platform API returned invalid JSON.');
      }
    }

    if (!response.ok) {
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const code = typeof record.error === 'string'
        ? record.error
        : typeof record.code === 'string'
          ? record.code
          : 'PLATFORM_API_REQUEST_FAILED';
      const message = typeof record.messageFa === 'string'
        ? record.messageFa
        : typeof record.message === 'string'
          ? record.message
          : code;
      throw new PlatformApiHttpError(response.status, code, message);
    }

    return body as T;
  }
}
