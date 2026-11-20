import crypto from 'node:crypto';

export interface EncryptedModelEnvelopeMetadata {
  readonly modelId: string;
  readonly version: string;
  readonly plaintextByteLength: number;
}

export class ServerSideEncryptedModelVault {
  private static readonly MAGIC = Buffer.from('EMV1', 'ascii'); // Encrypted Model Vault v1
  private readonly masterKekBytes: Buffer;

  constructor(masterKeyWrappingHex32Bytes: string) {
    if (
      typeof masterKeyWrappingHex32Bytes !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(masterKeyWrappingHex32Bytes)
    ) {
      throw new Error(
        'VAULT_INVALID_KEK_LENGTH: کلید اصلی رمزنگاری (KEK) باید دقیقاً ۳۲ بایت (۶۴ کاراکتر Hex) باشد.'
      );
    }
    this.masterKekBytes = Buffer.from(masterKeyWrappingHex32Bytes, 'hex');
  }

  /**
   * 1. Encrypts ONNX model binary weights using AES-256-GCM Envelope Encryption with AAD version binding.
   * Binary layout:
   * [0..3]: "EMV1"
   * [4..15]: KEK IV (12 bytes)
   * [16..31]: KEK AuthTag (16 bytes)
   * [32..63]: Wrapped DEK (32 bytes)
   * [64..75]: Payload IV (12 bytes)
   * [76..91]: Payload AuthTag (16 bytes)
   * [92..End]: Encrypted ONNX Model Ciphertext
   */
  public encryptModelBytes(
    plaintextOnnxBytes: Uint8Array,
    modelId: string,
    version: string
  ): Uint8Array {
    if (
      typeof modelId !== 'string' ||
      modelId.length === 0 ||
      modelId.includes(':') ||
      typeof version !== 'string' ||
      version.length === 0 ||
      version.includes(':')
    ) {
      throw new Error('VAULT_INVALID_AAD_CONTEXT: شناسه مدل و نسخه باید رشته‌های غیرخالی بدون کاراکتر «:» باشند.');
    }
    const aadContext = Buffer.from(`${modelId}:${version}`, 'utf8');

    // A) Generate unique random 256-bit Data Encryption Key (DEK)
    const dek = crypto.randomBytes(32);

    try {
      // B) Encrypt model payload with DEK and AAD context
      const payloadIv = crypto.randomBytes(12);
      const payloadCipher = crypto.createCipheriv('aes-256-gcm', dek, payloadIv);
      payloadCipher.setAAD(aadContext);
      const encryptedPayload = Buffer.concat([
        payloadCipher.update(plaintextOnnxBytes),
        payloadCipher.final(),
      ]);
      const payloadAuthTag = payloadCipher.getAuthTag();

      // C) Wrap DEK with server Master KEK
      const kekIv = crypto.randomBytes(12);
      const kekCipher = crypto.createCipheriv('aes-256-gcm', this.masterKekBytes, kekIv);
      kekCipher.setAAD(aadContext);
      const wrappedDek = Buffer.concat([kekCipher.update(dek), kekCipher.final()]);
      const kekAuthTag = kekCipher.getAuthTag();

      return Buffer.concat([
        ServerSideEncryptedModelVault.MAGIC,
        kekIv,
        kekAuthTag,
        wrappedDek,
        payloadIv,
        payloadAuthTag,
        encryptedPayload,
      ]);
    } finally {
      // Zero out temporary DEK from memory unconditionally, even on failure
      dek.fill(0);
    }
  }

  /**
   * 2. Decrypts ONNX model weights directly in memory without touching disk.
   * Any tampering with bytes, auth tags, or modelId:version AAD immediately throws.
   */
  public decryptModelBytesInMemory(
    encryptedEnvelope: Uint8Array,
    expectedModelId: string,
    expectedVersion: string
  ): Uint8Array {
    const buf = Buffer.isBuffer(encryptedEnvelope)
      ? encryptedEnvelope
      : Buffer.from(
          encryptedEnvelope.buffer,
          encryptedEnvelope.byteOffset,
          encryptedEnvelope.byteLength
        );

    if (
      buf.byteLength < 92 ||
      !buf.subarray(0, 4).equals(ServerSideEncryptedModelVault.MAGIC)
    ) {
      throw new Error('VAULT_INVALID_MAGIC_FORMAT: هدر بسته رمزنگاری‌شده مدل معتبر نیست.');
    }

    if (
      typeof expectedModelId !== 'string' ||
      expectedModelId.length === 0 ||
      expectedModelId.includes(':') ||
      typeof expectedVersion !== 'string' ||
      expectedVersion.length === 0 ||
      expectedVersion.includes(':')
    ) {
      throw new Error('VAULT_INVALID_AAD_CONTEXT: شناسه مدل و نسخه معتبر نیستند.');
    }

    const aadContext = Buffer.from(`${expectedModelId}:${expectedVersion}`, 'utf8');

    const kekIv = buf.subarray(4, 16);
    const kekAuthTag = buf.subarray(16, 32);
    const wrappedDek = buf.subarray(32, 64);
    const payloadIv = buf.subarray(64, 76);
    const payloadAuthTag = buf.subarray(76, 92);
    const ciphertext = buf.subarray(92);

    // A) Unwrap DEK
    const kekDecipher = crypto.createDecipheriv('aes-256-gcm', this.masterKekBytes, kekIv);
    kekDecipher.setAAD(aadContext);
    kekDecipher.setAuthTag(kekAuthTag);
    const dek = Buffer.concat([kekDecipher.update(wrappedDek), kekDecipher.final()]);

    try {
      // B) Decrypt model payload verifying AuthTag and AAD
      const payloadDecipher = crypto.createDecipheriv('aes-256-gcm', dek, payloadIv);
      payloadDecipher.setAAD(aadContext);
      payloadDecipher.setAuthTag(payloadAuthTag);
      return Buffer.concat([payloadDecipher.update(ciphertext), payloadDecipher.final()]);
    } finally {
      dek.fill(0);
    }
  }
}
