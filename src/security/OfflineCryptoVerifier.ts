export type ModelTier = 'GROUP_A' | 'GROUP_B';
export type SubscriptionPlan = 'FREE' | 'PRO' | 'ENTERPRISE';
export type ModelLifecycleStatus = 'ACTIVE' | 'SUPPORTED' | 'DEPRECATED' | 'REVOKED';

export interface OfflineLicenseLeasePayload {
  readonly licenseId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly plan: SubscriptionPlan;
  readonly issuedAtMs: number;
  readonly offlineGraceExpiresAtMs: number;
  readonly allowedModelTiers: readonly ModelTier[];
  readonly deviceFingerprint: string;
}

export interface SignedEnvelope<T> {
  readonly payloadBase64: string;
  readonly signatureBase64: string;
  readonly algorithm: 'Ed25519';
  readonly keyVersion: number;
  readonly decodedPreview?: T;
}

export interface SignedModelChunk {
  readonly index: number;
  readonly url: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly sha256Hex: string;
}

export interface SignedModelManifest {
  readonly modelId: string;
  readonly version: string;
  readonly status: ModelLifecycleStatus;
  readonly tier: ModelTier;
  readonly totalBytes: number;
  readonly chunkSizeBytes: number;
  readonly chunks: readonly SignedModelChunk[];
  readonly issuedAtMs: number;
}

export interface LicenseVerificationResult {
  readonly isValid: boolean;
  readonly reason:
    | 'VALID'
    | 'SECURITY_SIGNATURE_TAMPERED'
    | 'LICENSE_CLOCK_TAMPERED'
    | 'SUBSCRIPTION_EXPIRED_READ_ONLY'
    | 'INVALID_PAYLOAD_FORMAT';
  readonly allowedModelTiers: readonly ModelTier[];
  readonly payload?: OfflineLicenseLeasePayload;
}

export interface ManifestVerificationResult {
  readonly isValid: boolean;
  readonly reason:
    | 'VALID'
    | 'SECURITY_SIGNATURE_TAMPERED'
    | 'MODEL_REVOKED'
    | 'INVALID_PAYLOAD_FORMAT';
  readonly manifest?: SignedModelManifest;
}

const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000; // 10 minutes tolerance for minor NTP drift

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64Utf8Json<T>(base64: string): T {
  const bytes = base64ToBytes(base64);
  const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(jsonText) as T;
}

export class OfflineCryptoVerifier {
  private static readonly subtle = globalThis.crypto.subtle;

  private static async verifyEd25519Envelope(
    payloadBase64: string,
    signatureBase64: string,
    publicKeySpkiBase64: string,
  ): Promise<boolean> {
    try {
      const keyBytes = base64ToBytes(publicKeySpkiBase64);
      const cryptoKey = await this.subtle.importKey(
        'spki',
        keyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      const payloadBytes = new TextEncoder().encode(payloadBase64);
      const sigBytes = base64ToBytes(signatureBase64);
      return await this.subtle.verify('Ed25519', cryptoKey, sigBytes, payloadBytes);
    } catch {
      return false;
    }
  }

  /**
   * Verifies an Ed25519 signed offline license lease using WebCrypto without network access.
   * Implements Clock Rollback detection and Data Hostage Prevention (read/export preserved via GROUP_A).
   */
  public static async verifyOfflineLicense(
    envelope: SignedEnvelope<OfflineLicenseLeasePayload>,
    publicKeySpkiBase64: string,
    lastSeenMonotonicNowMs: number,
    currentWallClockMs = Date.now(),
  ): Promise<LicenseVerificationResult> {
    if (!envelope?.payloadBase64 || !envelope?.signatureBase64) {
      return {
        isValid: false,
        reason: 'INVALID_PAYLOAD_FORMAT',
        allowedModelTiers: ['GROUP_A'],
      };
    }

    const signatureOk = await this.verifyEd25519Envelope(
      envelope.payloadBase64,
      envelope.signatureBase64,
      publicKeySpkiBase64,
    );

    if (!signatureOk) {
      return {
        isValid: false,
        reason: 'SECURITY_SIGNATURE_TAMPERED',
        allowedModelTiers: ['GROUP_A'],
      };
    }

    let payload: OfflineLicenseLeasePayload;
    try {
      payload = decodeBase64Utf8Json<OfflineLicenseLeasePayload>(envelope.payloadBase64);
    } catch {
      return {
        isValid: false,
        reason: 'INVALID_PAYLOAD_FORMAT',
        allowedModelTiers: ['GROUP_A'],
      };
    }

    // Clock rollback detection against persisted monotonic high-water timestamp
    if (
      currentWallClockMs < payload.issuedAtMs - MAX_CLOCK_SKEW_MS ||
      currentWallClockMs < lastSeenMonotonicNowMs - MAX_CLOCK_SKEW_MS
    ) {
      return {
        isValid: false,
        reason: 'LICENSE_CLOCK_TAMPERED',
        allowedModelTiers: ['GROUP_A'],
        payload,
      };
    }

    // Data Hostage Prevention: expired lease revokes GROUP_B heavy AI models,
    // while keeping GROUP_A core tools & project export accessible locally.
    if (currentWallClockMs > payload.offlineGraceExpiresAtMs) {
      return {
        isValid: false,
        reason: 'SUBSCRIPTION_EXPIRED_READ_ONLY',
        allowedModelTiers: ['GROUP_A'],
        payload,
      };
    }

    return {
      isValid: true,
      reason: 'VALID',
      allowedModelTiers: payload.allowedModelTiers,
      payload,
    };
  }

  /**
   * Verifies a signed model chunk manifest and blocks REVOKED versions.
   */
  public static async verifyModelManifest(
    envelope: SignedEnvelope<SignedModelManifest>,
    publicKeySpkiBase64: string,
  ): Promise<ManifestVerificationResult> {
    if (!envelope?.payloadBase64 || !envelope?.signatureBase64) {
      return { isValid: false, reason: 'INVALID_PAYLOAD_FORMAT' };
    }

    const signatureOk = await this.verifyEd25519Envelope(
      envelope.payloadBase64,
      envelope.signatureBase64,
      publicKeySpkiBase64,
    );
    if (!signatureOk) {
      return { isValid: false, reason: 'SECURITY_SIGNATURE_TAMPERED' };
    }

    let manifest: SignedModelManifest;
    try {
      manifest = decodeBase64Utf8Json<SignedModelManifest>(envelope.payloadBase64);
    } catch {
      return { isValid: false, reason: 'INVALID_PAYLOAD_FORMAT' };
    }

    if (manifest.status === 'REVOKED') {
      return { isValid: false, reason: 'MODEL_REVOKED', manifest };
    }

    return { isValid: true, reason: 'VALID', manifest };
  }
}
