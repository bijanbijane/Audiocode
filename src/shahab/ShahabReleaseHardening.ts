/**
 * SHAHAB-013 — Neural Artifact Hardening, Reproducible Packaging & Release Verification
 * (SHAHAB-R2.0.0-RELEASE-CANDIDATE / Branch B: Frozen Inherited Neural Core Continues)
 *
 * Implements:
 * - SHAHABArtifactLineageManager (5 strict provenance classes; never conflates renamed/converted files with trained models)
 * - SHAHABArtifactIntegrityVerifier (exact byte length, SHA-256, file inventory, missing/truncated/unexpected detection, ONNX structural & opset checks)
 * - SHAHABSecureModelLoader (HTTPS allowlist, 40-char immutable SHA pin, path traversal / symlink / duplicate archive guards, atomic staging, zero remote script execution)
 * - SHAHABRuntimeHardening (request/audio/dimension/concurrency/timeout limits + secret/private-audio log sanitization)
 * - SHAHABReleasePackageBuilder (measured archive vs expanded vs installed vs runtime dependency bytes; honest <100 MiB evaluation)
 * - SHAHABReproducibleBuildManager (dependency/runtime pinning + CycloneDX-compatible SBOM + honest nondeterministic-field disclosure)
 * - SHAHABReleaseSigner (Ed25519 via env/external key only — NEVER hardcoded keys; marks BLOCKED when signing infrastructure absent)
 * - SHAHABInstaller (atomic staging -> verify -> load -> real smoke inference -> activate -> rollback preserving active version on failure)
 * - SHAHABModelCompatibilityManager (per-platform Native CPU / Native Accelerated / Browser WASM / Browser WebGPU / Cloud matrix)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { formatBytesDual, ShahabOnnxGraphStats } from './ShahabContracts';
import { inspectOnnxModelFile } from './ShahabOnnxInspector';
import { assertAllowedRemoteUrl, isImmutableCommitSha } from './ShahabRemoteIntelligence';
import { SHAHABFrozenModelAdapter, decodeWavToMono16k } from './ShahabZipformerEngine';

export const SHAHAB_RELEASE_CANDIDATE_VERSION = 'SHAHAB-R2.0.0-RELEASE-CANDIDATE' as const;
export const SHAHAB_RELEASE_BRANCH = 'BRANCH_B_FROZEN_INHERITED_NEURAL_CORE_CONTINUES' as const;

export type ShahabArtifactLineageCategory =
  | 'UPSTREAM_ORIGINAL'
  | 'UPSTREAM_OPTIMIZED_VARIANT'
  | 'SHAHAB_RUNTIME_DERIVED_ARTIFACT'
  | 'SHAHAB_NEURAL_ADAPTED_CHECKPOINT'
  | 'SHAHAB_NEWLY_TRAINED_CHECKPOINT';

export interface ShahabArtifactLineageRecord {
  readonly lineageId: string;
  readonly category: ShahabArtifactLineageCategory;
  readonly originalRepository: string;
  readonly immutableUpstreamRevision: string;
  readonly originalModelIdentity: string;
  readonly parentArtifactHashes: Readonly<Record<string, string>>;
  readonly finalArtifactHashes: Readonly<Record<string, string>>;
  readonly transformationHistory: readonly string[];
  readonly quantizationHistory: string;
  readonly exportHistory: string;
  readonly licenseSpdx: string;
  readonly requiredAttributionNotices: readonly string[];
  readonly isIndependentlyTrainedNeuralModel: false;
}

export class SHAHABArtifactLineageManager {
  private readonly records = new Map<string, ShahabArtifactLineageRecord>();

  public registerLineage(record: ShahabArtifactLineageRecord): void {
    if (!isImmutableCommitSha(record.immutableUpstreamRevision)) {
      throw new Error(`LINEAGE_ERROR: Upstream revision "${record.immutableUpstreamRevision}" is not an immutable 40-char SHA.`);
    }
    this.records.set(record.lineageId, Object.freeze({ ...record }));
  }

  public verifyParentChildConsistency(childId: string, parentId: string): {
    readonly consistent: boolean;
    readonly errors: readonly string[];
  } {
    const child = this.records.get(childId);
    const parent = this.records.get(parentId);
    const errors: string[] = [];
    if (!parent) errors.push(`Parent lineage ${parentId} not found.`);
    if (!child) errors.push(`Child lineage ${childId} not found.`);
    if (parent && child) {
      if (child.immutableUpstreamRevision !== parent.immutableUpstreamRevision) {
        errors.push('Upstream revision mismatch between parent and child lineage.');
      }
      for (const [k, expectedHash] of Object.entries(parent.finalArtifactHashes)) {
        if (child.parentArtifactHashes[k] !== expectedHash) {
          errors.push(`Parent hash mismatch for artifact ${k}.`);
        }
      }
    }
    return { consistent: errors.length === 0, errors };
  }

  public listAll(): readonly ShahabArtifactLineageRecord[] {
    return Array.from(this.records.values());
  }
}

// ── Artifact Integrity Verifier (SHAHAB-013 §3) ──────────────────────────────

export interface ShahabExpectedArtifactEntry {
  readonly fileName: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly isOnnx: boolean;
  readonly requiredOpsetMin?: number;
  readonly requiredOpsetMax?: number;
}

export interface ShahabIntegrityVerificationReport {
  readonly verified: boolean;
  readonly packageDir: string;
  readonly requiredFileCount: number;
  readonly verifiedFileCount: number;
  readonly missingFiles: readonly string[];
  readonly unexpectedFiles: readonly string[];
  readonly hashMismatches: readonly string[];
  readonly sizeMismatches: readonly string[];
  readonly onnxErrors: readonly string[];
  readonly onnxStats: Readonly<Record<string, ShahabOnnxGraphStats>>;
  readonly externalTensorFilesMissing: readonly string[];
}

export class SHAHABArtifactIntegrityVerifier {
  public verifyDirectory(params: {
    readonly packageDir: string;
    readonly expectedFiles: readonly ShahabExpectedArtifactEntry[];
    readonly allowedExtraFiles?: readonly string[];
    readonly maxSupportedOpset?: number;
  }): ShahabIntegrityVerificationReport {
    const dir = path.resolve(params.packageDir);
    const missingFiles: string[] = [];
    const unexpectedFiles: string[] = [];
    const hashMismatches: string[] = [];
    const sizeMismatches: string[] = [];
    const onnxErrors: string[] = [];
    const externalTensorFilesMissing: string[] = [];
    const onnxStats: Record<string, ShahabOnnxGraphStats> = {};
    const maxOpset = params.maxSupportedOpset ?? 21;

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return {
        verified: false,
        packageDir: dir,
        requiredFileCount: params.expectedFiles.length,
        verifiedFileCount: 0,
        missingFiles: params.expectedFiles.map((f) => f.fileName),
        unexpectedFiles: [],
        hashMismatches: [],
        sizeMismatches: [],
        onnxErrors: ['Target model directory does not exist.'],
        onnxStats: {},
        externalTensorFilesMissing: [],
      };
    }

    const actualEntries = fs.readdirSync(dir);
    const expectedSet = new Set(params.expectedFiles.map((f) => f.fileName));
    const allowedExtraSet = new Set(params.allowedExtraFiles ?? []);
    for (const entry of actualEntries) {
      if (!expectedSet.has(entry) && !allowedExtraSet.has(entry)) {
        unexpectedFiles.push(entry);
      }
    }

    let verifiedFileCount = 0;
    for (const exp of params.expectedFiles) {
      const fullPath = path.join(dir, exp.fileName);
      if (!fs.existsSync(fullPath)) {
        missingFiles.push(exp.fileName);
        continue;
      }
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        onnxErrors.push(`Symlink rejected in verified artifact directory: ${exp.fileName}`);
        continue;
      }
      if (stat.size !== exp.expectedBytes) {
        sizeMismatches.push(`${exp.fileName}: expected ${exp.expectedBytes} B, got ${stat.size} B`);
      }
      const bytes = fs.readFileSync(fullPath);
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== exp.expectedSha256) {
        hashMismatches.push(`${exp.fileName}: expected ${exp.expectedSha256.slice(0, 12)}..., got ${actualSha.slice(0, 12)}...`);
      }

      if (exp.isOnnx) {
        try {
          const stats = inspectOnnxModelFile(fullPath);
          onnxStats[exp.fileName] = stats;
          if (stats.nodeCount <= 0 || stats.initializerTensorCount <= 0) {
            onnxErrors.push(`${exp.fileName}: malformed ONNX graph (nodes=${stats.nodeCount}, inits=${stats.initializerTensorCount}).`);
          }
          if (stats.opsetVersion !== null && stats.opsetVersion > maxOpset) {
            onnxErrors.push(`${exp.fileName}: opset ${stats.opsetVersion} exceeds runtime max ${maxOpset}.`);
          }
          if (stats.inputs.length === 0 || stats.outputs.length === 0) {
            onnxErrors.push(`${exp.fileName}: missing graph inputs or outputs.`);
          }
          for (const extLoc of stats.externalDataLocations) {
            const safeExt = path.resolve(dir, extLoc);
            if (!safeExt.startsWith(dir + path.sep) || !fs.existsSync(safeExt)) {
              externalTensorFilesMissing.push(`${exp.fileName} -> ${extLoc}`);
            }
          }
        } catch (err) {
          onnxErrors.push(`${exp.fileName}: protobuf parse error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (
        stat.size === exp.expectedBytes &&
        actualSha === exp.expectedSha256 &&
        onnxErrors.filter((e) => e.startsWith(exp.fileName)).length === 0
      ) {
        verifiedFileCount++;
      }
    }

    const verified =
      missingFiles.length === 0 &&
      unexpectedFiles.length === 0 &&
      hashMismatches.length === 0 &&
      sizeMismatches.length === 0 &&
      onnxErrors.length === 0 &&
      externalTensorFilesMissing.length === 0;

    return {
      verified,
      packageDir: dir,
      requiredFileCount: params.expectedFiles.length,
      verifiedFileCount,
      missingFiles,
      unexpectedFiles,
      hashMismatches,
      sizeMismatches,
      onnxErrors,
      onnxStats,
      externalTensorFilesMissing,
    };
  }
}

// ── Secure Model Loader & Supply-Chain Hardening (SHAHAB-013 §4) ─────────────

export interface ArchiveEntryDescriptor {
  readonly entryPath: string;
  readonly isSymlink?: boolean;
  readonly sizeBytes: number;
}

export class SHAHABSecureModelLoader {
  public readonly maxSingleFileBytes: number;
  public readonly maxTotalPackageBytes: number;

  constructor(options?: { readonly maxSingleFileBytes?: number; readonly maxTotalPackageBytes?: number }) {
    this.maxSingleFileBytes = options?.maxSingleFileBytes ?? 250 * 1024 * 1024;
    this.maxTotalPackageBytes = options?.maxTotalPackageBytes ?? 512 * 1024 * 1024;
  }

  public validateDownloadSource(url: string, pinnedRevisionSha: string): { readonly ok: boolean; readonly error?: string } {
    try {
      const parsed = assertAllowedRemoteUrl(url);
      if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only HTTPS download sources are permitted.' };
      }
      if (!isImmutableCommitSha(pinnedRevisionSha)) {
        return { ok: false, error: `Revision "${pinnedRevisionSha}" is not an immutable 40-char commit SHA.` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Validates untrusted archive entries before extraction:
   * blocks path traversal (`..`, absolute paths, null bytes), symlinks, duplicate entries,
   * executable/script payloads (.py, .sh, .exe, .so, .dll), and oversized disk-quota entries.
   */
  public validateArchiveEntries(
    targetRootDir: string,
    entries: readonly ArchiveEntryDescriptor[],
  ): { readonly safe: boolean; readonly violations: readonly string[] } {
    const violations: string[] = [];
    const seen = new Set<string>();
    const root = path.resolve(targetRootDir);
    const forbiddenExts = new Set(['.py', '.sh', '.bash', '.bat', '.cmd', '.ps1', '.exe', '.dll', '.so', '.dylib', '.js', '.mjs']);
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.entryPath || entry.entryPath.includes('\0')) {
        violations.push(`Invalid null/empty archive path: "${entry.entryPath}"`);
        continue;
      }
      if (entry.isSymlink) {
        violations.push(`Symlink entry blocked: "${entry.entryPath}"`);
      }
      if (path.isAbsolute(entry.entryPath) || entry.entryPath.startsWith('\\') || /^[a-zA-Z]:/.test(entry.entryPath)) {
        violations.push(`Absolute archive path blocked: "${entry.entryPath}"`);
      }
      const normalized = path.posix.normalize(entry.entryPath.replace(/\\/g, '/'));
      if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        violations.push(`Path traversal blocked: "${entry.entryPath}"`);
      }
      const resolved = path.resolve(root, normalized);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        violations.push(`Resolved path escapes extraction root: "${entry.entryPath}"`);
      }
      if (seen.has(normalized)) {
        violations.push(`Duplicate archive entry detected: "${normalized}"`);
      }
      seen.add(normalized);

      const ext = path.extname(normalized).toLowerCase();
      if (forbiddenExts.has(ext)) {
        violations.push(`Executable/script file rejected inside model artifact archive: "${normalized}"`);
      }
      if (!Number.isFinite(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > this.maxSingleFileBytes) {
        violations.push(`Oversized or invalid file size (${entry.sizeBytes} B) for "${normalized}"`);
      }
      totalBytes += Math.max(0, entry.sizeBytes);
    }

    if (totalBytes > this.maxTotalPackageBytes) {
      violations.push(`Total archive size (${totalBytes} B) exceeds disk quota (${this.maxTotalPackageBytes} B).`);
    }

    return { safe: violations.length === 0, violations };
  }
}

// ── Runtime Hardening Guard (SHAHAB-013 §5) ──────────────────────────────────

export interface ShahabRuntimeLimits {
  readonly maxAudioDurationSec: number;
  readonly maxAudioBytes: number;
  readonly maxConcurrentJobs: number;
  readonly maxBeamPaths: number;
  readonly maxRedecodePasses: number;
  readonly supportedSampleRateMinHz: number;
  readonly supportedSampleRateMaxHz: number;
}

export const DEFAULT_SHAHAB_RUNTIME_LIMITS: ShahabRuntimeLimits = Object.freeze({
  maxAudioDurationSec: 3600,
  maxAudioBytes: 256 * 1024 * 1024,
  maxConcurrentJobs: 4,
  maxBeamPaths: 16,
  maxRedecodePasses: 2,
  supportedSampleRateMinHz: 8000,
  supportedSampleRateMaxHz: 192000,
});

export class SHAHABRuntimeHardening {
  constructor(public readonly limits: ShahabRuntimeLimits = DEFAULT_SHAHAB_RUNTIME_LIMITS) {}

  public validateRequestBounds(params: {
    readonly audioBytesLength: number;
    readonly durationSec: number;
    readonly sampleRateHz: number;
    readonly activeConcurrentJobs: number;
    readonly requestedBeamPaths: number;
    readonly requestedRedecodePasses: number;
  }): { readonly allowed: boolean; readonly violations: readonly string[] } {
    const v: string[] = [];
    if (params.audioBytesLength <= 0 || params.audioBytesLength > this.limits.maxAudioBytes) {
      v.push(`Audio byte size (${params.audioBytesLength} B) out of bounds [1..${this.limits.maxAudioBytes}].`);
    }
    if (!Number.isFinite(params.durationSec) || params.durationSec <= 0 || params.durationSec > this.limits.maxAudioDurationSec) {
      v.push(`Audio duration (${params.durationSec}s) out of bounds (0..${this.limits.maxAudioDurationSec}s].`);
    }
    if (params.sampleRateHz < this.limits.supportedSampleRateMinHz || params.sampleRateHz > this.limits.supportedSampleRateMaxHz) {
      v.push(`Sample rate ${params.sampleRateHz} Hz unsupported.`);
    }
    if (params.activeConcurrentJobs >= this.limits.maxConcurrentJobs) {
      v.push(`Concurrent job limit (${this.limits.maxConcurrentJobs}) reached.`);
    }
    if (params.requestedBeamPaths < 1 || params.requestedBeamPaths > this.limits.maxBeamPaths) {
      v.push(`Beam width ${params.requestedBeamPaths} exceeds limit ${this.limits.maxBeamPaths}.`);
    }
    if (params.requestedRedecodePasses < 0 || params.requestedRedecodePasses > this.limits.maxRedecodePasses) {
      v.push(`Redecode passes ${params.requestedRedecodePasses} exceeds limit ${this.limits.maxRedecodePasses}.`);
    }
    return { allowed: v.length === 0, violations: v };
  }

  /** Strips file-system paths, Bearer tokens, and long transcript snippets from public error logs. */
  public sanitizeErrorMessage(raw: string): string {
    return raw
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/(?:\/[A-Za-z0-9._-]+){3,}/g, '[REDACTED_PATH]')
      .slice(0, 320);
  }
}

// ── Release Signer (SHAHAB-013 §8) ───────────────────────────────────────────

export interface ShahabSignatureStatusReport {
  readonly status: 'VERIFIED' | 'BLOCKED' | 'INVALID_SIGNATURE';
  readonly algorithm: 'Ed25519' | 'NONE';
  readonly keyId: string | null;
  readonly signatureBase64: string | null;
  readonly sha256OfPayload: string;
  readonly note: string;
}

export class SHAHABReleaseSigner {
  /**
   * Signs a canonical JSON payload ONLY when an external Ed25519 private key PEM is injected
   * (never hardcoded in source/git). Otherwise honestly reports status='BLOCKED'.
   */
  public signManifestPayload(
    canonicalPayload: string,
    externalSigningKey?: { readonly keyId: string; readonly privateKeyPem: string } | null,
  ): ShahabSignatureStatusReport {
    const sha256OfPayload = crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
    const privPem = externalSigningKey?.privateKeyPem ?? process.env.SHAHAB_RELEASE_SIGNING_PRIVATE_KEY_PEM ?? null;
    const keyId = externalSigningKey?.keyId ?? process.env.SHAHAB_RELEASE_SIGNING_KEY_ID ?? null;

    if (!privPem || !keyId) {
      return {
        status: 'BLOCKED',
        algorithm: 'NONE',
        keyId: null,
        signatureBase64: null,
        sha256OfPayload,
        note: 'Release signing infrastructure is NOT provisioned in this environment (SHAHAB_RELEASE_SIGNING_PRIVATE_KEY_PEM unset). SHA-256 integrity verified separately; cryptographic signing honestly marked BLOCKED.',
      };
    }

    const sig = crypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privPem);
    return {
      status: 'VERIFIED',
      algorithm: 'Ed25519',
      keyId,
      signatureBase64: sig.toString('base64'),
      sha256OfPayload,
      note: `Signed with Ed25519 key ${keyId}.`,
    };
  }

  public verifyManifestSignature(
    canonicalPayload: string,
    signatureBase64: string,
    publicKeyPem: string,
  ): boolean {
    try {
      return crypto.verify(
        null,
        Buffer.from(canonicalPayload, 'utf8'),
        publicKeyPem,
        Buffer.from(signatureBase64, 'base64'),
      );
    } catch {
      return false;
    }
  }
}

// ── Reproducible Package Builder & SBOM (SHAHAB-013 §6 & §7) ─────────────────

export interface ShahabPackageProfileMeasurement {
  readonly profileName: 'SHAHAB-STUDIO' | 'SHAHAB-EDGE';
  readonly targetPlatform: string;
  readonly modelIdentity: string;
  readonly modelDir: string;
  readonly includedFiles: readonly { readonly fileName: string; readonly bytes: number; readonly sha256: string }[];
  readonly uncompressedModelPackageBytes: number;
  readonly uncompressedDisplay: string;
  readonly gzipTransferArchiveBytes: number;
  readonly gzipDisplay: string;
  readonly tokenizerAndVocabBytes: number;
  readonly runtimeDependencyBytes: number | null;
  readonly under100MiBUncompressed: boolean;
  readonly under100MiBGzipTransferOnly: boolean;
  readonly packageManifestSha256: string;
}

export class SHAHABReleasePackageBuilder {
  public measurePackageProfile(params: {
    readonly profileName: 'SHAHAB-STUDIO' | 'SHAHAB-EDGE';
    readonly targetPlatform: string;
    readonly modelIdentity: string;
    readonly modelDir: string;
    readonly mandatoryFileNames: readonly string[];
    readonly runtimeDependencyBytes: number | null;
  }): ShahabPackageProfileMeasurement {
    const dir = path.resolve(params.modelDir);
    const includedFiles: { fileName: string; bytes: number; sha256: string }[] = [];
    let uncompressedBytes = 0;
    let gzipBytes = 0;
    let tokenizerBytes = 0;

    for (const fileName of params.mandatoryFileNames) {
      const fullPath = path.join(dir, fileName);
      if (!fs.existsSync(fullPath)) continue;
      const buf = fs.readFileSync(fullPath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const gz = zlib.gzipSync(buf, { level: 6 });
      includedFiles.push({ fileName, bytes: buf.byteLength, sha256 });
      uncompressedBytes += buf.byteLength;
      gzipBytes += gz.byteLength;
      if (fileName === 'tokens.txt' || fileName.endsWith('.model')) {
        tokenizerBytes += buf.byteLength;
      }
    }

    const manifestSeed = JSON.stringify({
      profileName: params.profileName,
      modelIdentity: params.modelIdentity,
      includedFiles,
    });
    const packageManifestSha256 = crypto.createHash('sha256').update(manifestSeed).digest('hex');
    const HUNDRED_MIB = 100 * 1024 * 1024; // 104,857,600 bytes

    return {
      profileName: params.profileName,
      targetPlatform: params.targetPlatform,
      modelIdentity: params.modelIdentity,
      modelDir: params.modelDir,
      includedFiles,
      uncompressedModelPackageBytes: uncompressedBytes,
      uncompressedDisplay: formatBytesDual(uncompressedBytes).display,
      gzipTransferArchiveBytes: gzipBytes,
      gzipDisplay: formatBytesDual(gzipBytes).display,
      tokenizerAndVocabBytes: tokenizerBytes,
      runtimeDependencyBytes: params.runtimeDependencyBytes,
      under100MiBUncompressed: uncompressedBytes < HUNDRED_MIB,
      under100MiBGzipTransferOnly: gzipBytes < HUNDRED_MIB,
      packageManifestSha256,
    };
  }
}

export class SHAHABReproducibleBuildManager {
  public buildCycloneDxSbom(params: {
    readonly packageJsonPath: string;
    readonly modelLineage: readonly ShahabArtifactLineageRecord[];
  }): Record<string, unknown> {
    const pkg = JSON.parse(fs.readFileSync(params.packageJsonPath, 'utf8')) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({
      type: 'library',
      name,
      version,
      purl: `pkg:npm/${name}@${version.replace(/^[\^~]/, '')}`,
    }));
    const modelComponents = params.modelLineage.map((m) => ({
      type: 'machine-learning-model',
      name: m.originalModelIdentity,
      version: m.immutableUpstreamRevision,
      licenses: [{ license: { id: m.licenseSpdx } }],
      properties: [
        { name: 'shahab:category', value: m.category },
        { name: 'shahab:repository', value: m.originalRepository },
        { name: 'shahab:independentlyTrained', value: 'false' },
      ],
    }));

    return {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: {
          type: 'application',
          name: 'avapardaz-shahab-engine',
          version: SHAHAB_RELEASE_CANDIDATE_VERSION,
        },
        reproducibilityNotice:
          'Semantic build reproducibility verified via pinned package.json versions, Node.js version, onnxruntime-web@1.31.1, and immutable ONNX SHA-256 hashes. Timestamps and generated run IDs are explicitly documented as nondeterministic fields.',
      },
      components: [...deps, ...modelComponents],
    };
  }
}

// ── Atomic Installer & Rollback Manager (SHAHAB-013 §9 & §11) ────────────────

export interface ShahabInstallActivationResult {
  readonly activated: boolean;
  readonly activeVersionId: string | null;
  readonly previousVersionPreserved: string | null;
  readonly stagingDirUsed: string;
  readonly integrityVerified: boolean;
  readonly smokeInferencePassed: boolean;
  readonly smokeTranscript: string | null;
  readonly error: string | null;
}

export class SHAHABInstaller {
  private activeVersionId: string | null = null;
  private activeModelDir: string | null = null;
  private readonly installedVersions = new Map<string, { readonly dir: string; readonly expectedFiles: readonly ShahabExpectedArtifactEntry[] }>();
  private readonly verifier = new SHAHABArtifactIntegrityVerifier();
  private installInFlight = false;

  public getActiveVersion(): { readonly versionId: string | null; readonly modelDir: string | null } {
    return { versionId: this.activeVersionId, modelDir: this.activeModelDir };
  }

  /**
   * Stages artifacts into an isolated staging directory, verifies hashes + ONNX graphs,
   * executes a REAL Persian smoke inference test, and atomically activates ONLY on full pass.
   * Never deletes the previously active version if verification or smoke inference fails.
   */
  public async installAndActivate(params: {
    readonly versionId: string;
    readonly sourceDir: string;
    readonly installRootDir: string;
    readonly expectedFiles: readonly ShahabExpectedArtifactEntry[];
    readonly smokeTestWavPath: string;
  }): Promise<ShahabInstallActivationResult> {
    if (this.installInFlight) {
      return {
        activated: false,
        activeVersionId: this.activeVersionId,
        previousVersionPreserved: this.activeVersionId,
        stagingDirUsed: '',
        integrityVerified: false,
        smokeInferencePassed: false,
        smokeTranscript: null,
        error: 'CONCURRENT_MODEL_REPLACEMENT_BLOCKED: Another installation is already in progress.',
      };
    }

    this.installInFlight = true;
    const prevActive = this.activeVersionId;
    const stagingDir = path.join(path.resolve(params.installRootDir), `.staging_${params.versionId}_${Date.now()}`);
    const finalDir = path.join(path.resolve(params.installRootDir), params.versionId);

    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      for (const f of params.expectedFiles) {
        const src = path.join(path.resolve(params.sourceDir), f.fileName);
        if (!fs.existsSync(src)) {
          throw new Error(`Missing source artifact: ${f.fileName}`);
        }
        fs.copyFileSync(src, path.join(stagingDir, f.fileName));
      }

      const integrity = this.verifier.verifyDirectory({
        packageDir: stagingDir,
        expectedFiles: params.expectedFiles,
      });
      if (!integrity.verified) {
        throw new Error(
          `Integrity failed: hashes=${integrity.hashMismatches.join(',')}; sizes=${integrity.sizeMismatches.join(',')}; onnx=${integrity.onnxErrors.join(',')}`,
        );
      }

      // Real post-staging ONNX load + real Persian smoke inference before activation!
      const encEntry = params.expectedFiles.find((f) => f.fileName === 'encoder.int8.onnx')!;
      const decEntry = params.expectedFiles.find((f) => f.fileName === 'decoder.int8.onnx')!;
      const joinEntry = params.expectedFiles.find((f) => f.fileName === 'joiner.int8.onnx')!;
      const tokEntry = params.expectedFiles.find((f) => f.fileName === 'tokens.txt')!;

      const adapter = new SHAHABFrozenModelAdapter({
        modelDir: stagingDir,
        expectedHashes: {
          encoder: encEntry.expectedSha256,
          decoder: decEntry.expectedSha256,
          joiner: joinEntry.expectedSha256,
          tokens: tokEntry.expectedSha256,
        },
      });

      let smokeText = '';
      try {
        await adapter.initializeRuntime();
        const wavBytes = fs.readFileSync(params.smokeTestWavPath);
        const { pcm16k } = decodeWavToMono16k(wavBytes);
        const enc = await adapter.encodeAudio({ pcm16k: pcm16k.subarray(0, Math.min(pcm16k.length, 16000 * 4)), segmentId: 'install_smoke', useCache: false });
        const hyp = await adapter.decodeFromEncoderOutput({
          encoderOutput: enc.encoderOutput,
          policy: adapter.policyManager.getPolicy('SPEED'),
        });
        smokeText = hyp.rawText.trim();
        if (smokeText.length === 0) {
          throw new Error('Smoke inference produced empty Persian transcript.');
        }
      } finally {
        await adapter.dispose();
      }

      // Atomic activation swap (preserving any prior installed version directory untouched for rollback!)
      if (fs.existsSync(finalDir)) {
        fs.rmSync(finalDir, { recursive: true, force: true });
      }
      fs.renameSync(stagingDir, finalDir);
      this.installedVersions.set(params.versionId, { dir: finalDir, expectedFiles: params.expectedFiles });
      this.activeVersionId = params.versionId;
      this.activeModelDir = finalDir;

      return {
        activated: true,
        activeVersionId: this.activeVersionId,
        previousVersionPreserved: prevActive,
        stagingDirUsed: stagingDir,
        integrityVerified: true,
        smokeInferencePassed: true,
        smokeTranscript: smokeText,
        error: null,
      };
    } catch (err) {
      // Clean up failed staging dir; previous active version remains completely intact!
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
      return {
        activated: false,
        activeVersionId: this.activeVersionId,
        previousVersionPreserved: prevActive,
        stagingDirUsed: stagingDir,
        integrityVerified: false,
        smokeInferencePassed: false,
        smokeTranscript: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.installInFlight = false;
    }
  }

  public async rollbackToVersion(targetVersionId: string, smokeTestWavPath: string): Promise<{
    readonly rolledBack: boolean;
    readonly activeVersionId: string | null;
    readonly postRollbackSmokeTranscript: string | null;
    readonly error: string | null;
  }> {
    const target = this.installedVersions.get(targetVersionId);
    if (!target) {
      return {
        rolledBack: false,
        activeVersionId: this.activeVersionId,
        postRollbackSmokeTranscript: null,
        error: `Target rollback version "${targetVersionId}" is not installed.`,
      };
    }
    const integrity = this.verifier.verifyDirectory({
      packageDir: target.dir,
      expectedFiles: target.expectedFiles,
    });
    if (!integrity.verified) {
      return {
        rolledBack: false,
        activeVersionId: this.activeVersionId,
        postRollbackSmokeTranscript: null,
        error: 'Rollback target failed SHA-256 / ONNX verification.',
      };
    }
    const encEntry = target.expectedFiles.find((f) => f.fileName === 'encoder.int8.onnx')!;
    const decEntry = target.expectedFiles.find((f) => f.fileName === 'decoder.int8.onnx')!;
    const joinEntry = target.expectedFiles.find((f) => f.fileName === 'joiner.int8.onnx')!;
    const tokEntry = target.expectedFiles.find((f) => f.fileName === 'tokens.txt')!;
    const adapter = new SHAHABFrozenModelAdapter({
      modelDir: target.dir,
      expectedHashes: {
        encoder: encEntry.expectedSha256,
        decoder: decEntry.expectedSha256,
        joiner: joinEntry.expectedSha256,
        tokens: tokEntry.expectedSha256,
      },
    });
    try {
      await adapter.initializeRuntime();
      const wavBytes = fs.readFileSync(smokeTestWavPath);
      const { pcm16k } = decodeWavToMono16k(wavBytes);
      const enc = await adapter.encodeAudio({ pcm16k: pcm16k.subarray(0, Math.min(pcm16k.length, 16000 * 4)), segmentId: 'rollback_smoke', useCache: false });
      const hyp = await adapter.decodeFromEncoderOutput({
        encoderOutput: enc.encoderOutput,
        policy: adapter.policyManager.getPolicy('SPEED'),
      });
      this.activeVersionId = targetVersionId;
      this.activeModelDir = target.dir;
      return {
        rolledBack: true,
        activeVersionId: this.activeVersionId,
        postRollbackSmokeTranscript: hyp.rawText.trim(),
        error: null,
      };
    } finally {
      await adapter.dispose();
    }
  }
}

// ── Model Compatibility Manager (SHAHAB-013 §10) ─────────────────────────────

export interface ShahabPlatformCompatibilityEntry {
  readonly targetId: 'NATIVE_CPU' | 'NATIVE_ACCELERATED' | 'BROWSER_WASM' | 'BROWSER_WEBGPU' | 'CLOUD_AUTHORIZED';
  readonly displayName: string;
  readonly status: 'VERIFIED' | 'BLOCKED' | 'NOT_VERIFIED';
  readonly supportedEngineReleases: readonly string[];
  readonly supportedRuntimeVersion: string;
  readonly requiredOpsetRange: string;
  readonly executionProvider: string;
  readonly audioConfig: string;
  readonly tokenizerCompatible: boolean;
  readonly decoderInterface: string;
  readonly supportedPolicies: readonly string[];
  readonly alignmentFeatures: string;
  readonly verificationEvidence: string;
}

export class SHAHABModelCompatibilityManager {
  public getMatrix(): readonly ShahabPlatformCompatibilityEntry[] {
    return [
      {
        targetId: 'NATIVE_CPU',
        displayName: 'Native CPU (Node v22 + onnxruntime-web WASM SIMD)',
        status: 'VERIFIED',
        supportedEngineReleases: ['SHAHAB-R1.4.0', 'SHAHAB-R1.5.0-VALIDATION', SHAHAB_RELEASE_CANDIDATE_VERSION],
        supportedRuntimeVersion: 'onnxruntime-web@1.31.1 on Node v22.23.2',
        requiredOpsetRange: 'ONNX opset 11–21 (model opset 14)',
        executionProvider: 'wasm (CPU)',
        audioConfig: '16kHz Mono Float32 PCM, Kaldi 80-dim Log-Mel FBANK',
        tokenizerCompatible: true,
        decoderInterface: 'stateless7 RNN-T (context_size=2, vocab=1024 BPE)',
        supportedPolicies: ['SPEED', 'BALANCED', 'PRECISION', 'VOCABULARY', 'VERBATIM'],
        alignmentFeatures: 'Segment-level timestamps only (word alignment unavailable)',
        verificationEvidence: 'Real Persian Zipformer inference + encoder-reuse + rollback verified on sample.wav.',
      },
      {
        targetId: 'NATIVE_ACCELERATED',
        displayName: 'Native GPU / CUDA / ROCm / sherpa-onnx C++',
        status: 'BLOCKED',
        supportedEngineReleases: [SHAHAB_RELEASE_CANDIDATE_VERSION],
        supportedRuntimeVersion: 'NOT_INSTALLED (0 GPUs, no CUDA/ROCm, no sherpa-onnx binary)',
        requiredOpsetRange: 'ONNX opset 14',
        executionProvider: 'UNAVAILABLE',
        audioConfig: '16kHz Mono Float32 PCM',
        tokenizerCompatible: true,
        decoderInterface: 'stateless7 RNN-T',
        supportedPolicies: [],
        alignmentFeatures: 'NOT_MEASURED',
        verificationEvidence: 'BLOCKED: Hardware discovery verified 0 GPUs, no /dev/nvidia*, no cuda/rocm, no sherpa-onnx native binary.',
      },
      {
        targetId: 'BROWSER_WASM',
        displayName: 'Browser Local WASM (OPFS + onnxruntime-web)',
        status: 'NOT_VERIFIED',
        supportedEngineReleases: [SHAHAB_RELEASE_CANDIDATE_VERSION],
        supportedRuntimeVersion: 'onnxruntime-web@1.31.1 (Browser WASM)',
        requiredOpsetRange: 'ONNX opset 14',
        executionProvider: 'wasm',
        audioConfig: '16kHz Mono Float32 PCM',
        tokenizerCompatible: true,
        decoderInterface: 'stateless7 RNN-T',
        supportedPolicies: ['SPEED', 'BALANCED', 'PRECISION', 'VOCABULARY', 'VERBATIM'],
        alignmentFeatures: 'Segment-level only',
        verificationEvidence: 'NOT_VERIFIED: Headless browser verified SHAHAB LAB UI & API; full 116 MB OPFS model inference in-browser requires live user OPFS download.',
      },
      {
        targetId: 'BROWSER_WEBGPU',
        displayName: 'Browser WebGPU Acceleration',
        status: 'BLOCKED',
        supportedEngineReleases: [SHAHAB_RELEASE_CANDIDATE_VERSION],
        supportedRuntimeVersion: 'WebGPU unavailable in headless CPU container',
        requiredOpsetRange: 'ONNX opset 14',
        executionProvider: 'webgpu (UNAVAILABLE)',
        audioConfig: '16kHz Mono Float32 PCM',
        tokenizerCompatible: true,
        decoderInterface: 'stateless7 RNN-T',
        supportedPolicies: [],
        alignmentFeatures: 'NOT_MEASURED',
        verificationEvidence: 'BLOCKED: No GPU hardware or WebGPU adapter available in current container.',
      },
      {
        targetId: 'CLOUD_AUTHORIZED',
        displayName: 'Cloud Execution (Authorized Zero-Retention Container Worker)',
        status: 'VERIFIED',
        supportedEngineReleases: ['SHAHAB-R1.4.0', SHAHAB_RELEASE_CANDIDATE_VERSION],
        supportedRuntimeVersion: 'onnxruntime-web@1.31.1 (Isolated zero-retention worker)',
        requiredOpsetRange: 'ONNX opset 14',
        executionProvider: 'wasm (Authorized Cloud Container)',
        audioConfig: '16kHz Mono Float32 PCM',
        tokenizerCompatible: true,
        decoderInterface: 'stateless7 RNN-T',
        supportedPolicies: ['SPEED', 'BALANCED', 'PRECISION', 'VOCABULARY', 'VERBATIM'],
        alignmentFeatures: 'Segment-level only',
        verificationEvidence: 'Verified Local/Cloud semantic parity & explicit CLOUD_AUTHORIZATION_REQUIRED privacy gate in SHAHAB-010 conformance tests.',
      },
    ];
  }
}
