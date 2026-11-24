import crypto from 'node:crypto';

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

export interface IssueLeaseRequest {
  userId: string;
  displayName?: string;
  deviceFingerprint: string;
  plan?: SubscriptionPlan;
  graceDays?: number;
}

function encodeUtf8Base64(jsonObj: unknown): string {
  return Buffer.from(JSON.stringify(jsonObj), 'utf8').toString('base64');
}

export class PlatformLicenseService {
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKey: crypto.KeyObject;
  private readonly publicKeySpkiBase64: string;
  private readonly keyVersion: number;

  constructor(options?: {
    privateKeyPem?: string;
    publicKeyPem?: string;
    keyVersion?: number;
  }) {
    this.keyVersion = options?.keyVersion ?? 1;

    if (options?.privateKeyPem && options?.publicKeyPem) {
      this.privateKey = crypto.createPrivateKey(options.privateKeyPem);
      this.publicKey = crypto.createPublicKey(options.publicKeyPem);
    } else {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      this.privateKey = privateKey;
      this.publicKey = publicKey;
    }

    const spkiDer = this.publicKey.export({ type: 'spki', format: 'der' });
    this.publicKeySpkiBase64 = Buffer.from(spkiDer).toString('base64');
  }

  public getPublicKeyInfo(): {
    publicKeySpkiBase64: string;
    algorithm: 'Ed25519';
    keyVersion: number;
  } {
    return {
      publicKeySpkiBase64: this.publicKeySpkiBase64,
      algorithm: 'Ed25519',
      keyVersion: this.keyVersion,
    };
  }

  public signPayload<T>(payload: T, includePreview = false): SignedEnvelope<T> {
    const payloadBase64 = encodeUtf8Base64(payload);
    const signatureBuffer = crypto.sign(
      null,
      Buffer.from(payloadBase64, 'utf8'),
      this.privateKey,
    );
    return {
      payloadBase64,
      signatureBase64: signatureBuffer.toString('base64'),
      algorithm: 'Ed25519',
      keyVersion: this.keyVersion,
      ...(includePreview ? { decodedPreview: payload } : {}),
    };
  }

  public issueOfflineLicenseLease(req: IssueLeaseRequest): SignedEnvelope<OfflineLicenseLeasePayload> {
    const cleanUserId = req.userId.trim();
    const cleanFingerprint = req.deviceFingerprint.trim();
    if (!cleanUserId || !cleanFingerprint) {
      throw new Error('INVALID_LEASE_REQUEST: userId and deviceFingerprint are required');
    }

    const now = Date.now();
    const plan: SubscriptionPlan = req.plan ?? 'PRO';
    const graceDays = Math.max(0, Math.min(30, req.graceDays ?? 14));
    const allowedModelTiers: readonly ModelTier[] =
      plan === 'FREE' ? ['GROUP_A'] : ['GROUP_A', 'GROUP_B'];

    const payload: OfflineLicenseLeasePayload = {
      licenseId: crypto.randomUUID(),
      userId: cleanUserId,
      displayName: (req.displayName ?? 'کاربر استودیو آواپرداز').trim(),
      plan,
      issuedAtMs: now,
      offlineGraceExpiresAtMs: now + graceDays * 24 * 60 * 60 * 1000,
      allowedModelTiers,
      deviceFingerprint: cleanFingerprint,
    };

    return this.signPayload(payload, true);
  }

  public issueSignedModelManifest(
    modelId: string,
    overrideStatus?: ModelLifecycleStatus,
  ): SignedModelManifest | null {
    const cleanId = modelId.trim();
    if (!cleanId) return null;

    // Deterministic signed catalog entry for core Persian AI & Acoustic models
    const catalog: Record<
      string,
      {
        version: string;
        status: ModelLifecycleStatus;
        tier: ModelTier;
        chunkCount: number;
        chunkSizeBytes: number;
      }
    > = {
      'whisper-fa-int8': {
        version: '2.4.1',
        status: 'ACTIVE',
        tier: 'GROUP_B',
        chunkCount: 4,
        chunkSizeBytes: 8 * 1024 * 1024,
      },
      'silero-vad-v5': {
        version: '5.0.0',
        status: 'ACTIVE',
        tier: 'GROUP_A',
        chunkCount: 1,
        chunkSizeBytes: 2 * 1024 * 1024,
      },
      'persian-g2p-align': {
        version: '1.2.0',
        status: 'SUPPORTED',
        tier: 'GROUP_B',
        chunkCount: 2,
        chunkSizeBytes: 8 * 1024 * 1024,
      },
      'legacy-denoise-v0': {
        version: '0.9.4',
        status: 'REVOKED',
        tier: 'GROUP_B',
        chunkCount: 1,
        chunkSizeBytes: 4 * 1024 * 1024,
      },
    };

    const entry = catalog[cleanId];
    if (!entry) return null;

    const status = overrideStatus ?? entry.status;
    const chunks: SignedModelChunk[] = [];
    for (let index = 0; index < entry.chunkCount; index++) {
      const seed = `${cleanId}:${entry.version}:chunk-${index}`;
      const sha256Hex = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
      chunks.push({
        index,
        url: `https://cdn.avapardaz.local/models/${encodeURIComponent(cleanId)}/${entry.version}/chunk-${index}.bin`,
        byteOffset: index * entry.chunkSizeBytes,
        byteLength: entry.chunkSizeBytes,
        sha256Hex,
      });
    }

    return {
      modelId: cleanId,
      version: entry.version,
      status,
      tier: entry.tier,
      totalBytes: entry.chunkCount * entry.chunkSizeBytes,
      chunkSizeBytes: entry.chunkSizeBytes,
      chunks,
      issuedAtMs: Date.now(),
    };
  }

  public issueSignedModelManifestEnvelope(
    modelId: string,
    overrideStatus?: ModelLifecycleStatus,
  ): SignedEnvelope<SignedModelManifest> | null {
    const manifest = this.issueSignedModelManifest(modelId, overrideStatus);
    if (!manifest) return null;
    return this.signPayload(manifest, true);
  }
}
