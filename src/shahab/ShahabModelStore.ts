/**
 * SHAHAB — Model Store Resolution, Atomic Staging & Ed25519 Integrity Verifier (SHB-F01 & SHB-F07)
 *
 * - Supports `SHAHAB_MODEL_STORE_DIR` environment override so models live cleanly outside
 *   container/project root when provisioned in persistent user/system storage.
 * - Provides atomic `.part` -> `rename` staging helper (`writeModelArtifactAtomic`).
 * - Verifies optional detached Ed25519 manifest signatures truthfully without ever
 *   marking unsigned upstream manifests as signed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SHAHAB_MODEL_RELATIVE_PATH = path.join(
  'models',
  'persian-zipformer-transducer',
  '1.0.0',
);

export function resolvePersistentUserModelStoreDir(
  env: Record<string, string | undefined> = process.env,
): string {
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.resolve(base, 'Avapardaz', 'models', 'persian-zipformer-transducer', '1.0.0');
  }
  const xdg = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.resolve(xdg, 'avapardaz', 'models', 'persian-zipformer-transducer', '1.0.0');
}

/**
 * Resolves active SHAHAB model directory in strict priority order:
 * 1. `SHAHAB_MODEL_STORE_DIR` environment variable (if set)
 * 2. Persistent OS user model store if already populated with `encoder.int8.onnx`
 * 3. Default repository directory `models/persian-zipformer-transducer/1.0.0`
 */
export function resolveDefaultShahabModelDir(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.SHAHAB_MODEL_STORE_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const userStore = resolvePersistentUserModelStoreDir(env);
  try {
    const st = fs.statSync(path.join(userStore, 'encoder.int8.onnx'));
    if (st.isFile() && st.size > 0) {
      return userStore;
    }
  } catch {
    // Fall back cleanly to repository model directory
  }
  return path.resolve(cwd, DEFAULT_SHAHAB_MODEL_RELATIVE_PATH);
}

/**
 * Atomically writes a model file via sibling `.part-<rand>` temp file + rename
 * so partial writes never corrupt the model store.
 */
export function writeModelArtifactAtomic(targetPath: string, data: Uint8Array | string): void {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o755 });
  const tmpPath = `${resolved}.part-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o644 });
    fs.renameSync(tmpPath, resolved);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

/**
 * Computes SHA-256 of a file on disk using bounded 1 MiB chunk reads so verifying
 * 100+ MiB ONNX models never allocates the full model buffer in V8/Node heap (SHB-F09).
 */
export function hashFileSha256BoundedSync(filePath: string, chunkBytes = 1024 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(Math.max(4096, Math.floor(chunkBytes)));
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, null)) > 0) {
      hash.update(bytesRead === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export interface Ed25519ManifestVerificationResult {
  readonly verified: boolean;
  readonly status: 'VERIFIED' | 'UNSIGNED' | 'SIGNATURE_INVALID' | 'KEY_MISSING' | 'MALFORMED_INPUT';
  readonly reason: string;
}

/**
 * Verifies a detached Ed25519 signature over canonical manifest bytes.
 * Never marks missing/empty signatures as verified.
 */
export function verifyManifestEd25519Signature(params: {
  readonly manifestBytes: Uint8Array;
  readonly signatureBase64?: string | null;
  readonly publicKeyPem?: string | null;
}): Ed25519ManifestVerificationResult {
  const sigB64 = typeof params.signatureBase64 === 'string' ? params.signatureBase64.trim() : '';
  if (!sigB64) {
    return {
      verified: false,
      status: 'UNSIGNED',
      reason: 'Manifest has no detached Ed25519 signature (`signatureVerified = false`).',
    };
  }
  const pubPem = typeof params.publicKeyPem === 'string' ? params.publicKeyPem.trim() : '';
  if (!pubPem) {
    return {
      verified: false,
      status: 'KEY_MISSING',
      reason: 'Manifest signature is present, but trusted Ed25519 public key is not configured.',
    };
  }
  try {
    const sigBuf = Buffer.from(sigB64, 'base64');
    if (sigBuf.byteLength !== 64) {
      return {
        verified: false,
        status: 'MALFORMED_INPUT',
        reason: `Invalid Ed25519 signature length (${sigBuf.byteLength} bytes; expected 64).`,
      };
    }
    const ok = crypto.verify(null, params.manifestBytes, pubPem, sigBuf);
    return ok
      ? {
          verified: true,
          status: 'VERIFIED',
          reason: 'Detached Ed25519 manifest signature verified cleanly.',
        }
      : {
          verified: false,
          status: 'SIGNATURE_INVALID',
          reason: 'Detached Ed25519 manifest signature verification failed.',
        };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      status: 'MALFORMED_INPUT',
      reason: `Ed25519 verification error: ${msg}`,
    };
  }
}

export interface ShahabMetadataIntegrityAudit {
  readonly auditedAtUtc: string;
  readonly hasStaleOrContradictoryDocs: boolean;
  readonly manifestSignatureStatus: Ed25519ManifestVerificationResult['status'];
  readonly manifestSignatureVerified: boolean;
  readonly parameterLineageReportedElements: {
    readonly inheritedFrozenParameters: number;
    readonly nonTrainableConstantsElements: number;
    readonly combinedElements: number;
  };
  readonly findings: readonly string[];
}

export function auditShahabMetadataIntegrity(params: {
  readonly parameterLineage?: {
    readonly inheritedFrozenParameters?: number;
    readonly nonTrainableConstantsElements?: number;
  } | null;
  readonly compactModelState?: {
    readonly recommendation?: string;
    readonly candidates?: ReadonlyArray<{ readonly transportCompressedMiB?: number | null }>;
  } | null;
  readonly manifestPath?: string | null;
  readonly publicKeyPem?: string | null;
}): ShahabMetadataIntegrityAudit {
  const lineageFrozen = params.parameterLineage?.inheritedFrozenParameters ?? 0;
  const lineageNonTrainable = params.parameterLineage?.nonTrainableConstantsElements ?? 0;
  const compactRec = params.compactModelState?.recommendation ?? '';
  const expectedTransportMiB = params.compactModelState?.candidates?.[0]?.transportCompressedMiB ?? null;
  const recommendationHasStale5566 =
    compactRec.includes('55.66 MiB') &&
    expectedTransportMiB !== null &&
    Math.abs(expectedTransportMiB - 55.66) > 1;

  let manifestSignatureStatus: Ed25519ManifestVerificationResult['status'] = 'UNSIGNED';
  let manifestSignatureVerified = false;
  if (params.manifestPath && fs.existsSync(params.manifestPath)) {
    try {
      const rawManifest = fs.readFileSync(params.manifestPath);
      const parsedManifest = JSON.parse(rawManifest.toString('utf8')) as {
        ed25519SignatureBase64?: string | null;
      };
      const sigCheck = verifyManifestEd25519Signature({
        manifestBytes: rawManifest,
        signatureBase64: parsedManifest.ed25519SignatureBase64 ?? null,
        publicKeyPem: params.publicKeyPem ?? null,
      });
      manifestSignatureStatus = sigCheck.status;
      manifestSignatureVerified = sigCheck.verified;
    } catch {
      manifestSignatureStatus = 'MALFORMED_INPUT';
    }
  }

  const staleFindings: string[] = [];
  if (lineageFrozen > 0 && lineageNonTrainable > 0) {
    staleFindings.push(
      `SHAHAB_PARAMETER_LINEAGE reports inheritedFrozenParameters=${lineageFrozen} while nonTrainableConstantsElements=${lineageNonTrainable} (total=${lineageFrozen + lineageNonTrainable}); INT8 weights require accounting both logical and quantized storage elements.`,
    );
  }
  if (recommendationHasStale5566) {
    staleFindings.push(
      `SHAHAB_COMPACT_MODEL_STATE.recommendation mentions "55.66 MiB" while candidate transportCompressedMiB is ${expectedTransportMiB} MiB.`,
    );
  }
  if (!manifestSignatureVerified) {
    staleFindings.push(
      `Model manifest Ed25519 signature status is ${manifestSignatureStatus} (unsigned upstream asset manifest).`,
    );
  }

  return {
    auditedAtUtc: new Date().toISOString(),
    hasStaleOrContradictoryDocs: staleFindings.length > 0,
    manifestSignatureStatus,
    manifestSignatureVerified,
    parameterLineageReportedElements: {
      inheritedFrozenParameters: lineageFrozen,
      nonTrainableConstantsElements: lineageNonTrainable,
      combinedElements: lineageFrozen + lineageNonTrainable,
    },
    findings: staleFindings,
  };
}
