import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  ModelLifecycleStatus,
  ModelTier,
  SignedEnvelope,
  SignedModelChunk,
  SignedModelManifest,
} from '../../../src/security/OfflineCryptoVerifier';

export type ModelTaskType =
  | 'VAD'
  | 'PERSIAN_ASR'
  | 'FORCED_ALIGNMENT'
  | 'DISFLUENCY'
  | 'DIARIZATION'
  | 'DENOISER';

export type ModelRegistryTierGroup = 'GROUP_A' | 'GROUP_B' | 'GROUP_C';
export type ModelRegistryReleaseStatus =
  | 'CANDIDATE'
  | 'LIMITED_RELEASE'
  | ModelLifecycleStatus
  | 'ARCHIVED';

export interface CliModelPackagerConfig {
  readonly sourceModelFilePath: string;
  readonly outputDirectory: string;
  readonly modelId: string;
  readonly version: string;
  readonly taskType: ModelTaskType;
  readonly tierGroup: ModelRegistryTierGroup;
  readonly spdxLicense: string;
  readonly quantizationFormat: string;
  readonly minRamMb: number;
  readonly recommendedRamMb: number;
  readonly cdnBaseUrl: string;
  /** Defaults to 8 MiB per Section 40 CDN delivery policy. */
  readonly chunkSizeBytes?: number;
  readonly ed25519PrivateKeyPem: string;
  readonly keyVersion?: number;
  readonly manifestStatus?: ModelLifecycleStatus;
  readonly sqlInitialReleaseStatus?: ModelRegistryReleaseStatus;
}

export interface PackagedModelMetadata {
  readonly taskType: ModelTaskType;
  readonly tierGroup: ModelRegistryTierGroup;
  readonly spdxLicense: string;
  readonly quantizationFormat: string;
  readonly minRamMb: number;
  readonly recommendedRamMb: number;
}

export interface PackagedModelEnvelope extends SignedEnvelope<SignedModelManifest> {
  readonly metadata: PackagedModelMetadata;
}

export interface PackageModelResult {
  readonly manifestPath: string;
  readonly sqlMigrationPath: string;
  readonly totalChunks: number;
  readonly totalBytes: number;
  readonly signatureBase64: string;
  readonly envelope: PackagedModelEnvelope;
}

const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;

function assertSafeIdentifier(value: string, fieldName: string): string {
  const clean = value.trim();
  if (!clean || !SAFE_IDENTIFIER_RE.test(clean)) {
    throw new Error(`INVALID_CLI_FIELD: ${fieldName} must match [a-zA-Z0-9._-]+`);
  }
  return clean;
}

function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * DevOps Model Chunker, SHA-256 Hasher, Ed25519 Signer & PostgreSQL SQL Emitter (Sections 40, 44 & 57).
 * Produces:
 * - Content-addressable chunk_XXXX.bin shards (default 8MB)
 * - Ed25519 SignedEnvelope<SignedModelManifest> verified directly by OfflineCryptoVerifier
 * - Transactional PostgreSQL INSERT script aligned with backend/db/schema.sql
 */
export class DevOpsModelChunkerAndSigner {
  public static packageAndSignModel(config: CliModelPackagerConfig): PackageModelResult {
    const modelId = assertSafeIdentifier(config.modelId, 'modelId');
    const version = assertSafeIdentifier(config.version, 'version');
    const chunkSize = Math.max(1024, Math.floor(config.chunkSizeBytes ?? 8 * 1024 * 1024));

    if (!Number.isFinite(config.minRamMb) || config.minRamMb <= 0) {
      throw new Error('INVALID_CLI_FIELD: minRamMb must be positive');
    }
    if (!Number.isFinite(config.recommendedRamMb) || config.recommendedRamMb < config.minRamMb) {
      throw new Error('INVALID_CLI_FIELD: recommendedRamMb must be >= minRamMb');
    }

    const fileBuffer = fs.readFileSync(config.sourceModelFilePath);
    const totalBytes = fileBuffer.byteLength;
    if (totalBytes === 0) {
      throw new Error('EMPTY_MODEL_FILE: cannot package zero-byte model binary');
    }

    fs.mkdirSync(config.outputDirectory, { recursive: true });

    const normalizedBaseUrl = config.cdnBaseUrl.replace(/\/$/, '');
    const chunks: SignedModelChunk[] = [];
    let offset = 0;
    let chunkIndex = 0;

    while (offset < totalBytes) {
      const end = Math.min(offset + chunkSize, totalBytes);
      const slice = fileBuffer.subarray(offset, end);

      const sha256Hex = crypto.createHash('sha256').update(slice).digest('hex');
      const fileName = `chunk_${String(chunkIndex).padStart(4, '0')}.bin`;
      const chunkOutputPath = path.join(config.outputDirectory, fileName);

      fs.writeFileSync(chunkOutputPath, slice);

      chunks.push({
        index: chunkIndex,
        url: `${normalizedBaseUrl}/${encodeURIComponent(modelId)}/${encodeURIComponent(version)}/${fileName}`,
        byteOffset: offset,
        byteLength: slice.byteLength,
        sha256Hex,
      });

      offset = end;
      chunkIndex++;
    }

    const clientTier: ModelTier = config.tierGroup === 'GROUP_A' ? 'GROUP_A' : 'GROUP_B';
    const manifest: SignedModelManifest = {
      modelId,
      version,
      status: config.manifestStatus ?? 'ACTIVE',
      tier: clientTier,
      totalBytes,
      chunkSizeBytes: chunkSize,
      chunks,
      issuedAtMs: Date.now(),
    };

    // Match OfflineCryptoVerifier & PlatformLicenseService Ed25519 envelope signing contract
    const payloadBase64 = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
    const privateKeyObj = crypto.createPrivateKey(config.ed25519PrivateKeyPem);
    const signatureBase64 = crypto
      .sign(null, Buffer.from(payloadBase64, 'utf8'), privateKeyObj)
      .toString('base64');

    const metadata: PackagedModelMetadata = {
      taskType: config.taskType,
      tierGroup: config.tierGroup,
      spdxLicense: config.spdxLicense.trim(),
      quantizationFormat: config.quantizationFormat.trim(),
      minRamMb: Math.floor(config.minRamMb),
      recommendedRamMb: Math.floor(config.recommendedRamMb),
    };

    const envelope: PackagedModelEnvelope = {
      payloadBase64,
      signatureBase64,
      algorithm: 'Ed25519',
      keyVersion: config.keyVersion ?? 1,
      decodedPreview: manifest,
      metadata,
    };

    const manifestPath = path.join(config.outputDirectory, 'manifest.signed.json');
    fs.writeFileSync(manifestPath, JSON.stringify(envelope, null, 2), 'utf8');

    const sqlReleaseStatus = config.sqlInitialReleaseStatus ?? 'CANDIDATE';
    const sqlLines: string[] = [
      `-- Auto-generated Model Registry Migration for ${modelId} v${version}`,
      `BEGIN;`,
      `INSERT INTO ai_models_catalog (model_id, version, task_type, tier_group, release_status, spdx_license, quantization_format, min_ram_mb, recommended_ram_mb, total_size_bytes, manifest_ed25519_signature)`,
      `VALUES (${escapeSqlStringLiteral(modelId)}, ${escapeSqlStringLiteral(version)}, ${escapeSqlStringLiteral(config.taskType)}, ${escapeSqlStringLiteral(config.tierGroup)}, ${escapeSqlStringLiteral(sqlReleaseStatus)}, ${escapeSqlStringLiteral(metadata.spdxLicense)}, ${escapeSqlStringLiteral(metadata.quantizationFormat)}, ${metadata.minRamMb}, ${metadata.recommendedRamMb}, ${totalBytes}, ${escapeSqlStringLiteral(signatureBase64)})`,
      `ON CONFLICT (model_id, version) DO UPDATE SET release_status = EXCLUDED.release_status, total_size_bytes = EXCLUDED.total_size_bytes, manifest_ed25519_signature = EXCLUDED.manifest_ed25519_signature;`,
      ``,
    ];

    for (const c of chunks) {
      sqlLines.push(
        `INSERT INTO ai_model_chunks (model_id, version, chunk_index, sha256_hex, byte_length, cdn_path) VALUES (${escapeSqlStringLiteral(modelId)}, ${escapeSqlStringLiteral(version)}, ${c.index}, ${escapeSqlStringLiteral(c.sha256Hex)}, ${c.byteLength}, ${escapeSqlStringLiteral(c.url)}) ON CONFLICT (model_id, version, chunk_index) DO UPDATE SET sha256_hex = EXCLUDED.sha256_hex, byte_length = EXCLUDED.byte_length, cdn_path = EXCLUDED.cdn_path;`,
      );
    }
    sqlLines.push(`COMMIT;`, ``);

    const sqlMigrationPath = path.join(
      config.outputDirectory,
      `register_${modelId}_${version}.sql`,
    );
    fs.writeFileSync(sqlMigrationPath, sqlLines.join('\n'), 'utf8');

    return {
      manifestPath,
      sqlMigrationPath,
      totalChunks: chunks.length,
      totalBytes,
      signatureBase64,
      envelope,
    };
  }
}

export function runCliFromArgv(argv: readonly string[]): PackageModelResult {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag?.startsWith('--') && value !== undefined) {
      args.set(flag.slice(2), value);
    }
  }

  const required = (key: string): string => {
    const val = args.get(key);
    if (!val) throw new Error(`MISSING_CLI_ARG: --${key}`);
    return val;
  };

  const keyPemPath = required('private-key-pem');
  const ed25519PrivateKeyPem = fs.readFileSync(keyPemPath, 'utf8');
  const chunkMb = Number(args.get('chunk-mb') ?? '8');

  return DevOpsModelChunkerAndSigner.packageAndSignModel({
    sourceModelFilePath: required('input'),
    outputDirectory: required('out'),
    modelId: required('model-id'),
    version: required('version'),
    taskType: (args.get('task-type') ?? 'PERSIAN_ASR') as ModelTaskType,
    tierGroup: (args.get('tier-group') ?? 'GROUP_B') as ModelRegistryTierGroup,
    spdxLicense: args.get('license') ?? 'MIT',
    quantizationFormat: args.get('quantization') ?? 'Q5_K_M',
    minRamMb: Number(args.get('min-ram-mb') ?? '512'),
    recommendedRamMb: Number(args.get('recommended-ram-mb') ?? '1024'),
    cdnBaseUrl: required('cdn-base-url'),
    chunkSizeBytes: chunkMb * 1024 * 1024,
    ed25519PrivateKeyPem,
  });
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = runCliFromArgv(process.argv.slice(2));
  process.stdout.write(JSON.stringify({
    manifestPath: res.manifestPath,
    sqlMigrationPath: res.sqlMigrationPath,
    totalChunks: res.totalChunks,
    totalBytes: res.totalBytes,
  }, null, 2) + '\n');
}
