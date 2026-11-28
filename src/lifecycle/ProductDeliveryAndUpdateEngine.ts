/**
 * AVP-P0-007 — Production Installation, Update Orchestration, First-Run Readiness,
 * Recovery, Storage Migration & Safe Uninstallation Engine
 *
 * Implements:
 * 1. Independent component versioning & compatibility contract across Browser, Companion,
 *    IPC Protocol, CEP Extension, Canonical Processing Contract, Project Schema, Model Manifest,
 *    and Native Runtime.
 * 2. Deterministic First-Run Initialization (strictly separating installed != initialized !=
 *    runtime available != model installed != model verified != inference ready != Audition connected).
 * 3. Exact 17-state Update Orchestration state machine with manifest/signature/SHA-256 verification,
 *    compatibility gating, staging, atomic activation, post-update verification, rollback, and
 *    interrupted-update recovery without destroying user projects or last known-good versions.
 * 4. Storage category separation & safe uninstallation (never deletes user projects/media implicitly).
 * 5. Environment-separated browser deployment validator (development vs staging vs production).
 */

import { AVAPARDAZ_VERSION_CONTRACT } from './VersionCompatibilityContract';
import { CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION } from './CanonicalModelProvenance';
import { AVAPARDAZ_ASR_CONTRACT_VERSION } from '../asr-core/UnifiedLocalAsrRuntime';

export type ReleaseComponentKind =
  | 'BROWSER_APP'
  | 'NATIVE_COMPANION'
  | 'AUDITION_CEP_EXTENSION'
  | 'MODEL_ARTIFACT';

export interface ComponentVersionRegistry {
  readonly browserAppVersion: string;
  readonly nativeCompanionVersion: string;
  readonly ipcProtocolVersion: string;
  readonly cepExtensionVersion: string;
  readonly canonicalProcessingContractVersion: string;
  readonly projectSchemaVersion: number;
  readonly modelManifestSchemaVersion: string;
  readonly nativeRuntimeDependencyVersion: string;
}

export const CURRENT_COMPONENT_VERSIONS: ComponentVersionRegistry = Object.freeze({
  browserAppVersion: AVAPARDAZ_VERSION_CONTRACT.appVersion,
  nativeCompanionVersion: '1.0.0',
  ipcProtocolVersion: '1.0.0',
  cepExtensionVersion: '1.0.0',
  canonicalProcessingContractVersion: AVAPARDAZ_ASR_CONTRACT_VERSION,
  projectSchemaVersion: AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion,
  modelManifestSchemaVersion: CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION,
  nativeRuntimeDependencyVersion: 'sherpa-onnx>=1.10.0',
});

export type CompatibilityMatrixStatus =
  | 'VERIFIED'
  | 'COMPATIBLE_BUT_UNTESTED'
  | 'INCOMPATIBLE'
  | 'BLOCKED'
  | 'NOT_SUPPORTED'
  | 'NOT_TESTED';

export interface ComponentCompatibilityCheckResult {
  readonly compatible: boolean;
  readonly status: CompatibilityMatrixStatus;
  readonly blockingReasons: readonly string[];
  readonly requiresMigration: boolean;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compares strict SemVer release versions, including prerelease precedence.
 * Returns null for malformed versions so callers can fail closed.
 */
function compareReleaseVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = value.trim().match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    );
    if (!match || ![match[1], match[2], match[3]].every((part) => Number.isSafeInteger(Number(part)))) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
      prerelease: match[4]?.split('.') ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;

  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined || bi === undefined) {
      if (ai === bi) return 0;
      return ai === undefined ? -1 : 1;
    }
    if (ai === bi) continue;
    const an = /^(0|[1-9]\d*)$/.test(ai);
    const bn = /^(0|[1-9]\d*)$/.test(bi);
    if (an && bn) {
      if (ai.length !== bi.length) return ai.length > bi.length ? 1 : -1;
      return ai > bi ? 1 : -1;
    }
    if (an !== bn) return an ? -1 : 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

/**
 * Evaluates cross-component version compatibility before permitting activation or job start.
 */
export function evaluateComponentCompatibility(params: {
  readonly cepRequiredIpcProtocol?: string;
  readonly companionIpcProtocol?: string;
  readonly projectSchemaVersion?: number;
  readonly modelManifestSchemaVersion?: string;
  readonly modelRequiresWebGpu?: boolean;
  readonly browserHasWebGpu?: boolean;
  readonly companionSupportsModelFormat?: boolean;
}): ComponentCompatibilityCheckResult {
  const blockingReasons: string[] = [];
  let requiresMigration = false;

  if (params.cepRequiredIpcProtocol && params.companionIpcProtocol) {
    const req = parseSemver(params.cepRequiredIpcProtocol);
    const cur = parseSemver(params.companionIpcProtocol);
    if (!req || !cur || req[0] !== cur[0] || cur[1] < req[1]) {
      blockingReasons.push(
        `IPC_PROTOCOL_INCOMPATIBLE: CEP requires IPC ${params.cepRequiredIpcProtocol}, Companion provides ${params.companionIpcProtocol}.`,
      );
    }
  }

  if (params.projectSchemaVersion !== undefined) {
    if (params.projectSchemaVersion > AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion) {
      blockingReasons.push(
        `PROJECT_SCHEMA_FUTURE_VERSION: Project schema v${params.projectSchemaVersion} exceeds supported v${AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion}.`,
      );
    } else if (params.projectSchemaVersion < AVAPARDAZ_VERSION_CONTRACT.minSupportedProjectSchemaVersion) {
      blockingReasons.push(
        `PROJECT_SCHEMA_UNSUPPORTED_LEGACY: Project schema v${params.projectSchemaVersion} is below minimum supported v${AVAPARDAZ_VERSION_CONTRACT.minSupportedProjectSchemaVersion}.`,
      );
    } else if (params.projectSchemaVersion < AVAPARDAZ_VERSION_CONTRACT.projectSchemaVersion) {
      requiresMigration = true;
    }
  }

  if (params.modelManifestSchemaVersion) {
    const mVer = parseSemver(params.modelManifestSchemaVersion);
    const curVer = parseSemver(CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION);
    if (!mVer || !curVer || mVer[0] > curVer[0]) {
      blockingReasons.push(
        `MODEL_MANIFEST_SCHEMA_TOO_NEW: Manifest schema ${params.modelManifestSchemaVersion} exceeds supported ${CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION}.`,
      );
    }
  }

  if (params.modelRequiresWebGpu && !params.browserHasWebGpu) {
    blockingReasons.push('BROWSER_CAPABILITY_MISSING: Model requires WebGPU which is unavailable.');
  }

  if (params.companionSupportsModelFormat === false) {
    blockingReasons.push('COMPANION_MODEL_FORMAT_UNSUPPORTED: Installed Native Companion does not support this model format.');
  }

  return {
    compatible: blockingReasons.length === 0,
    status: blockingReasons.length === 0 ? 'VERIFIED' : 'INCOMPATIBLE',
    blockingReasons,
    requiresMigration,
  };
}

/**
 * Deterministic First-Run Initialization (`AVP-P0-007 §6`).
 * Strictly distinguishes installed vs initialized vs runtime vs model vs verified vs inference ready.
 */
export interface FirstRunProbeInput {
  readonly mode: 'BROWSER_ONLY' | 'NATIVE_AUDITION' | 'HYBRID';
  readonly appIntegrityVerified: boolean;
  readonly storageWritable: boolean;
  readonly browserWasmAvailable?: boolean;
  readonly companionInstalled?: boolean;
  readonly companionIpcProtocol?: string;
  readonly nativeDependencyAvailable?: boolean;
  readonly modelCatalogReadable: boolean;
  readonly modelInstalled: boolean;
  readonly modelChecksumVerified: boolean;
  readonly modelRuntimeCompatible: boolean;
  readonly realInferenceProbePassed: boolean;
  readonly auditionCepConnected?: boolean;
}

export interface FirstRunReadinessReport {
  readonly applicationInstalled: boolean;
  readonly applicationInitialized: boolean;
  readonly runtimeAvailable: boolean;
  readonly modelInstalled: boolean;
  readonly modelVerified: boolean;
  readonly inferenceReady: boolean;
  readonly adobeAuditionConnected: boolean;
  readonly modelAcquisitionRequired: boolean;
  readonly blockingReasons: readonly string[];
  readonly warnings: readonly string[];
}

export function evaluateFirstRunReadiness(probe: FirstRunProbeInput): FirstRunReadinessReport {
  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (!probe.appIntegrityVerified) blockingReasons.push('APP_INTEGRITY_FAILED');
  if (!probe.storageWritable) blockingReasons.push('STORAGE_PERMISSION_DENIED');

  let runtimeAvailable = false;
  if (probe.mode === 'BROWSER_ONLY') {
    // Companion is NEVER mandatory for browser-only operation
    runtimeAvailable = Boolean(probe.browserWasmAvailable);
    if (!runtimeAvailable) blockingReasons.push('BROWSER_WASM_UNAVAILABLE');
  } else if (probe.mode === 'NATIVE_AUDITION') {
    // Browser app is NEVER mandatory for native Audition operation
    runtimeAvailable = Boolean(probe.companionInstalled && probe.nativeDependencyAvailable);
    if (!probe.companionInstalled) blockingReasons.push('NATIVE_COMPANION_MISSING');
    if (!probe.nativeDependencyAvailable) blockingReasons.push('NATIVE_RUNTIME_DEPENDENCY_MISSING');
  } else {
    runtimeAvailable = Boolean(
      probe.browserWasmAvailable || (probe.companionInstalled && probe.nativeDependencyAvailable),
    );
    if (!runtimeAvailable) blockingReasons.push('NO_LOCAL_RUNTIME_AVAILABLE');
  }

  if (!probe.modelCatalogReadable) {
    warnings.push('Model catalog unavailable; offline local model import still possible.');
  }
  if (!probe.modelInstalled) {
    blockingReasons.push('MODEL_ACQUISITION_REQUIRED');
  } else if (!probe.modelChecksumVerified) {
    blockingReasons.push('MODEL_INTEGRITY_UNVERIFIED');
  } else if (!probe.modelRuntimeCompatible) {
    blockingReasons.push('MODEL_RUNTIME_INCOMPATIBLE');
  }

  const applicationInstalled = probe.appIntegrityVerified;
  const applicationInitialized = applicationInstalled && probe.storageWritable;
  const modelVerified = probe.modelInstalled && probe.modelChecksumVerified && probe.modelRuntimeCompatible;
  const inferenceReady = applicationInitialized && runtimeAvailable && modelVerified && probe.realInferenceProbePassed;

  return {
    applicationInstalled,
    applicationInitialized,
    runtimeAvailable,
    modelInstalled: probe.modelInstalled,
    modelVerified,
    inferenceReady,
    adobeAuditionConnected: Boolean(probe.auditionCepConnected),
    modelAcquisitionRequired: !probe.modelInstalled,
    blockingReasons,
    warnings,
  };
}

/**
 * Exact 17-State Update Orchestration State Machine (`AVP-P0-007 §7 & §8`).
 */
export type ComponentUpdateState =
  | 'UPDATE_DISCOVERED'
  | 'UPDATE_METADATA_VERIFIED'
  | 'UPDATE_COMPATIBILITY_CHECKED'
  | 'UPDATE_AUTHENTICITY_VERIFIED'
  | 'UPDATE_DOWNLOAD_PENDING'
  | 'UPDATE_DOWNLOADING'
  | 'UPDATE_DOWNLOADED'
  | 'UPDATE_INTEGRITY_VERIFIED'
  | 'UPDATE_STAGED'
  | 'UPDATE_READY'
  | 'UPDATE_ACTIVATING'
  | 'UPDATE_ACTIVATED'
  | 'UPDATE_VERIFICATION_PENDING'
  | 'UPDATE_VERIFIED'
  | 'UPDATE_FAILED'
  | 'UPDATE_ROLLBACK_PENDING'
  | 'UPDATE_ROLLED_BACK';

const LEGAL_UPDATE_TRANSITIONS: Readonly<Record<ComponentUpdateState, readonly ComponentUpdateState[]>> = {
  UPDATE_DISCOVERED: ['UPDATE_METADATA_VERIFIED', 'UPDATE_FAILED'],
  UPDATE_METADATA_VERIFIED: ['UPDATE_COMPATIBILITY_CHECKED', 'UPDATE_FAILED'],
  UPDATE_COMPATIBILITY_CHECKED: ['UPDATE_AUTHENTICITY_VERIFIED', 'UPDATE_FAILED'],
  UPDATE_AUTHENTICITY_VERIFIED: ['UPDATE_DOWNLOAD_PENDING', 'UPDATE_FAILED'],
  UPDATE_DOWNLOAD_PENDING: ['UPDATE_DOWNLOADING', 'UPDATE_FAILED'],
  UPDATE_DOWNLOADING: ['UPDATE_DOWNLOADED', 'UPDATE_FAILED'],
  UPDATE_DOWNLOADED: ['UPDATE_INTEGRITY_VERIFIED', 'UPDATE_FAILED'],
  UPDATE_INTEGRITY_VERIFIED: ['UPDATE_STAGED', 'UPDATE_FAILED'],
  UPDATE_STAGED: ['UPDATE_READY', 'UPDATE_FAILED'],
  UPDATE_READY: ['UPDATE_ACTIVATING', 'UPDATE_FAILED'],
  UPDATE_ACTIVATING: ['UPDATE_ACTIVATED', 'UPDATE_ROLLBACK_PENDING', 'UPDATE_FAILED'],
  UPDATE_ACTIVATED: ['UPDATE_VERIFICATION_PENDING', 'UPDATE_ROLLBACK_PENDING'],
  UPDATE_VERIFICATION_PENDING: ['UPDATE_VERIFIED', 'UPDATE_ROLLBACK_PENDING'],
  UPDATE_VERIFIED: ['UPDATE_DISCOVERED'],
  UPDATE_FAILED: ['UPDATE_ROLLBACK_PENDING', 'UPDATE_DISCOVERED'],
  UPDATE_ROLLBACK_PENDING: ['UPDATE_ROLLED_BACK', 'UPDATE_FAILED'],
  UPDATE_ROLLED_BACK: ['UPDATE_DISCOVERED'],
};

export interface UpdateManifestPayload {
  readonly component: ReleaseComponentKind;
  readonly version: string;
  readonly minCompatibleIpcProtocol?: string;
  readonly sha256Hex: string;
  readonly sizeBytes: number;
  readonly releaseNotes?: string;
}

export interface UpdateManifestSignature {
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly signatureBase64: string;
}

export interface UpdateManifest extends UpdateManifestPayload {
  readonly signature: UpdateManifestSignature;
}

/** Stable, versioned field order: the signature binds update identity and artifact digest. */
export function canonicalizeUpdateManifest(manifest: UpdateManifestPayload, keyId: string): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    signatureAlgorithm: 'Ed25519',
    keyId,
    component: manifest.component,
    version: manifest.version,
    minCompatibleIpcProtocol: manifest.minCompatibleIpcProtocol ?? null,
    sha256Hex: manifest.sha256Hex.toLowerCase(),
    sizeBytes: manifest.sizeBytes,
    releaseNotes: manifest.releaseNotes ?? null,
  });
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function decodeUpdateSignatureBase64(value: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function verifyUpdateManifestSignature(
  manifest: UpdateManifest,
  trustedSigningKeys: ReadonlyMap<string, Uint8Array>,
): Promise<boolean> {
  const signature = manifest?.signature;
  if (
    !signature ||
    typeof signature !== 'object' ||
    signature.algorithm !== 'Ed25519' ||
    typeof signature.keyId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(signature.keyId) ||
    typeof signature.signatureBase64 !== 'string'
  ) return false;

  const publicKeyBytes = trustedSigningKeys.get(signature.keyId);
  const signatureBytes = decodeUpdateSignatureBase64(signature.signatureBase64);
  const subtle = globalThis.crypto?.subtle;
  if (!publicKeyBytes || publicKeyBytes.length !== 32 || !signatureBytes || signatureBytes.length !== 64 || !subtle) {
    return false;
  }

  try {
    const publicKey = await subtle.importKey('raw', toOwnedArrayBuffer(publicKeyBytes), { name: 'Ed25519' }, false, ['verify']);
    const payload = new TextEncoder().encode(canonicalizeUpdateManifest(manifest, signature.keyId));
    return await subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      toOwnedArrayBuffer(signatureBytes),
      toOwnedArrayBuffer(payload),
    );
  } catch {
    return false;
  }
}

export interface ComponentSlotRecord {
  readonly component: ReleaseComponentKind;
  readonly activeVersion: string;
  readonly previousKnownGoodVersion: string | null;
  readonly candidateVersion: string | null;
  readonly state: ComponentUpdateState;
  readonly stagingDir: string | null;
  readonly lastError: string | null;
  readonly history: readonly { readonly from: ComponentUpdateState; readonly to: ComponentUpdateState; readonly reason: string }[];
}

export class ComponentUpdateOrchestrator {
  private readonly slots = new Map<ReleaseComponentKind, ComponentSlotRecord>();
  private readonly activePinnedJobs = new Set<string>();
  private readonly trustedSigningKeys: ReadonlyMap<string, Uint8Array>;

  constructor(
    initialVersions: Readonly<Record<ReleaseComponentKind, string>>,
    trustedSigningKeys: Readonly<Record<string, Uint8Array>> = {},
  ) {
    const pinnedKeys = new Map<string, Uint8Array>();
    for (const [keyId, publicKeyBytes] of Object.entries(trustedSigningKeys)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || publicKeyBytes.length !== 32) {
        throw new Error('INVALID_RELEASE_TRUST_ROOT');
      }
      pinnedKeys.set(keyId, new Uint8Array(publicKeyBytes));
    }
    this.trustedSigningKeys = pinnedKeys;
    for (const [comp, ver] of Object.entries(initialVersions) as [ReleaseComponentKind, string][]) {
      this.slots.set(comp, {
        component: comp,
        activeVersion: ver,
        previousKnownGoodVersion: null,
        candidateVersion: null,
        state: 'UPDATE_VERIFIED',
        stagingDir: null,
        lastError: null,
        history: [],
      });
    }
  }

  public getSlot(component: ReleaseComponentKind): ComponentSlotRecord {
    const s = this.slots.get(component);
    if (!s) throw new Error(`Unknown component: ${component}`);
    return s;
  }

  public pinActiveJob(jobId: string): void {
    this.activePinnedJobs.add(jobId);
  }

  public releasePinnedJob(jobId: string): void {
    this.activePinnedJobs.delete(jobId);
  }

  public transition(
    component: ReleaseComponentKind,
    next: ComponentUpdateState,
    reason: string,
    patch?: Partial<Pick<ComponentSlotRecord, 'activeVersion' | 'previousKnownGoodVersion' | 'candidateVersion' | 'stagingDir' | 'lastError'>>,
  ): ComponentSlotRecord {
    const cur = this.getSlot(component);
    if (!LEGAL_UPDATE_TRANSITIONS[cur.state].includes(next)) {
      throw new Error(`ILLEGAL_UPDATE_TRANSITION: ${component} cannot move ${cur.state} -> ${next}`);
    }
    const updated: ComponentSlotRecord = {
      ...cur,
      ...patch,
      state: next,
      history: [...cur.history, { from: cur.state, to: next, reason }],
    };
    this.slots.set(component, updated);
    return updated;
  }

  /**
   * Executes the full verified, atomic-activation, rollback-safe update pipeline for a component.
   * Never activates an unverified or incompatible update; automatically rolls back to
   * `previousKnownGoodVersion` if post-activation health verification fails.
   */
  public async executeSafeUpdate(params: {
    readonly manifest: UpdateManifest;
    readonly availableDiskBytes: number;
    readonly downloadAndVerifySha256: () => Promise<{ readonly ok: boolean; readonly actualSha256Hex?: string; readonly error?: string }>;
    readonly stageArtifact: () => Promise<{ readonly ok: boolean; readonly stagingDir?: string; readonly error?: string }>;
    readonly activateArtifact: (stagingDir: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly verifyPostActivationHealth: () => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly restorePreviousVersion: (prevVersion: string) => Promise<boolean>;
  }): Promise<{ readonly ok: boolean; readonly slot: ComponentSlotRecord; readonly rolledBack: boolean }> {
    const { manifest } = params;
    const comp = manifest.component;
    const initial = this.getSlot(comp);

    this.transition(comp, 'UPDATE_DISCOVERED', `Discovered ${comp}@${manifest.version}`, {
      candidateVersion: manifest.version,
      lastError: null,
    });

    // 1. Metadata validation
    if (!parseSemver(manifest.version) || !/^[a-f0-9]{64}$/i.test(manifest.sha256Hex) || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) {
      const failed = this.transition(comp, 'UPDATE_FAILED', 'Invalid update manifest metadata.', {
        lastError: 'INVALID_UPDATE_MANIFEST',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_METADATA_VERIFIED', 'Manifest schema & checksum format valid.');

    // 2. Compatibility check
    if (manifest.minCompatibleIpcProtocol) {
      const compat = evaluateComponentCompatibility({
        cepRequiredIpcProtocol: manifest.minCompatibleIpcProtocol,
        companionIpcProtocol: CURRENT_COMPONENT_VERSIONS.ipcProtocolVersion,
      });
      if (!compat.compatible) {
        const failed = this.transition(comp, 'UPDATE_FAILED', compat.blockingReasons.join(' | '), {
          lastError: 'INCOMPATIBLE_UPDATE_VERSION',
        });
        return { ok: false, slot: failed, rolledBack: false };
      }
    }
    this.transition(comp, 'UPDATE_COMPATIBILITY_CHECKED', 'Component compatibility verified.');

    // 3. Authenticity check: cryptographic Ed25519 verification against constructor-pinned keys is mandatory.
    // Caller-supplied status strings are deliberately not part of the manifest contract.
    const signatureVerified = await verifyUpdateManifestSignature(manifest, this.trustedSigningKeys);
    if (!signatureVerified) {
      const failed = this.transition(comp, 'UPDATE_FAILED', 'Release manifest signature is missing, untrusted, malformed, or invalid.', {
        lastError: 'UPDATE_AUTHENTICITY_FAILED',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_AUTHENTICITY_VERIFIED', `Ed25519 signature verified with trusted key ${manifest.signature.keyId}.`);

    // 3.1. Anti-rollback / replay protection. A valid signature never authorizes an older
    // or already-active release. SemVer prerelease precedence is respected (beta.2 > beta.1).
    const versionOrder = compareReleaseVersions(manifest.version, initial.activeVersion);
    if (versionOrder === null || versionOrder <= 0) {
      const failed = this.transition(comp, 'UPDATE_FAILED', 'Update version is not strictly newer than the active release.', {
        lastError: 'UPDATE_VERSION_NOT_NEWER',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }

    // 4. Storage preflight (require 2x size headroom for staging + active preservation)
    if (params.availableDiskBytes < manifest.sizeBytes * 2) {
      const failed = this.transition(comp, 'UPDATE_FAILED', 'Insufficient disk space for safe staged update.', {
        lastError: 'INSUFFICIENT_DISK_SPACE',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_DOWNLOAD_PENDING', 'Disk preflight passed.');
    this.transition(comp, 'UPDATE_DOWNLOADING', 'Downloading artifact.');

    // 5. Download & SHA-256 verification
    let dl: { readonly ok: boolean; readonly actualSha256Hex?: string; readonly error?: string };
    try {
      dl = await params.downloadAndVerifySha256();
    } catch (error) {
      dl = { ok: false, error: `Download callback threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!dl.ok) {
      const failed = this.transition(comp, 'UPDATE_FAILED', dl.error ?? 'Download failed.', {
        lastError: 'UPDATE_DOWNLOAD_FAILED',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_DOWNLOADED', 'Artifact download finished.');

    if (!dl.actualSha256Hex || dl.actualSha256Hex.toLowerCase() !== manifest.sha256Hex.toLowerCase()) {
      const failed = this.transition(comp, 'UPDATE_FAILED', 'SHA-256 checksum mismatch after download.', {
        lastError: 'UPDATE_HASH_MISMATCH',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_INTEGRITY_VERIFIED', 'SHA-256 checksum matched manifest.');

    // 6. Staging
    let staged: { readonly ok: boolean; readonly stagingDir?: string; readonly error?: string };
    try {
      staged = await params.stageArtifact();
    } catch (error) {
      staged = { ok: false, error: `Staging callback threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!staged.ok || !staged.stagingDir) {
      const failed = this.transition(comp, 'UPDATE_FAILED', staged.error ?? 'Staging failed.', {
        lastError: 'UPDATE_STAGING_FAILED',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_STAGED', 'Staged outside active installation.', {
      stagingDir: staged.stagingDir,
    });

    // Defer activation if active inference/render job is pinned
    if (this.activePinnedJobs.size > 0) {
      const ready = this.transition(comp, 'UPDATE_READY', 'Update staged & ready; waiting for active jobs to complete.', {
        previousKnownGoodVersion: initial.activeVersion,
      });
      return { ok: false, slot: ready, rolledBack: false };
    }
    this.transition(comp, 'UPDATE_READY', 'Ready for atomic activation.');

    // 7. Atomic activation (preserving previousKnownGoodVersion!)
    const prevKnownGood = initial.activeVersion;
    this.transition(comp, 'UPDATE_ACTIVATING', `Activating ${manifest.version} (previous known-good=${prevKnownGood}).`, {
      previousKnownGoodVersion: prevKnownGood,
    });

    let act: { readonly ok: boolean; readonly error?: string };
    try {
      act = await params.activateArtifact(staged.stagingDir);
    } catch (error) {
      act = { ok: false, error: `Activation callback threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!act.ok) {
      return this.performRollback(comp, prevKnownGood, act.error ?? 'Activation failed.', params.restorePreviousVersion);
    }

    this.transition(comp, 'UPDATE_ACTIVATED', 'Switched active pointer.', {
      activeVersion: manifest.version,
    });
    this.transition(comp, 'UPDATE_VERIFICATION_PENDING', 'Running post-update health verification.');

    let health: { readonly ok: boolean; readonly error?: string };
    try {
      health = await params.verifyPostActivationHealth();
    } catch (error) {
      health = { ok: false, error: `Post-activation health callback threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!health.ok) {
      return this.performRollback(
        comp,
        prevKnownGood,
        health.error ?? 'Post-activation health check failed.',
        params.restorePreviousVersion,
      );
    }

    const verified = this.transition(comp, 'UPDATE_VERIFIED', 'Post-update verification succeeded.', {
      candidateVersion: null,
      stagingDir: null,
      lastError: null,
    });
    return { ok: true, slot: verified, rolledBack: false };
  }

  /**
   * Resumes a verified, staged update after active inference/render jobs have released their pins.
   * The staged bytes are reused; this path never downloads or re-stages the artifact.
   */
  public async resumeStagedUpdate(params: {
    readonly component: ReleaseComponentKind;
    readonly activateArtifact: (stagingDir: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly verifyPostActivationHealth: () => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly restorePreviousVersion: (prevVersion: string) => Promise<boolean>;
  }): Promise<{ readonly ok: boolean; readonly slot: ComponentSlotRecord; readonly rolledBack: boolean }> {
    const current = this.getSlot(params.component);
    if (current.state !== 'UPDATE_READY') {
      return { ok: false, slot: current, rolledBack: false };
    }
    if (this.activePinnedJobs.size > 0) {
      return { ok: false, slot: current, rolledBack: false };
    }

    const candidateVersion = current.candidateVersion;
    const stagingDir = current.stagingDir;
    const previousVersion = current.previousKnownGoodVersion;
    const versionOrder = candidateVersion
      ? compareReleaseVersions(candidateVersion, current.activeVersion)
      : null;
    if (!candidateVersion || !stagingDir || !previousVersion || versionOrder === null || versionOrder <= 0) {
      const failed = this.transition(params.component, 'UPDATE_FAILED', 'Staged update metadata is incomplete or no longer newer than the active release.', {
        lastError: 'INVALID_STAGED_UPDATE',
      });
      return { ok: false, slot: failed, rolledBack: false };
    }

    this.transition(params.component, 'UPDATE_ACTIVATING', `Resuming staged update ${candidateVersion} after active jobs completed.`);
    let activation: { readonly ok: boolean; readonly error?: string };
    try {
      activation = await params.activateArtifact(stagingDir);
    } catch (error) {
      activation = {
        ok: false,
        error: `Deferred activation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!activation.ok) {
      return this.performRollback(
        params.component,
        previousVersion,
        activation.error ?? 'Deferred activation failed.',
        params.restorePreviousVersion,
      );
    }

    this.transition(params.component, 'UPDATE_ACTIVATED', 'Activated deferred staged update.', {
      activeVersion: candidateVersion,
    });
    this.transition(params.component, 'UPDATE_VERIFICATION_PENDING', 'Running post-update health verification.');
    let health: { readonly ok: boolean; readonly error?: string };
    try {
      health = await params.verifyPostActivationHealth();
    } catch (error) {
      health = {
        ok: false,
        error: `Deferred post-activation health check threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!health.ok) {
      return this.performRollback(
        params.component,
        previousVersion,
        health.error ?? 'Deferred update health check failed.',
        params.restorePreviousVersion,
      );
    }

    const verified = this.transition(params.component, 'UPDATE_VERIFIED', 'Deferred update passed post-activation health verification.', {
      candidateVersion: null,
      stagingDir: null,
      lastError: null,
    });
    return { ok: true, slot: verified, rolledBack: false };
  }

  /**
   * Recovers an interrupted update after physically removing its staged artifact.
   * The cleanup callback is mandatory whenever a staging directory is recorded. If
   * cleanup fails, the state and staging reference remain intact so startup recovery
   * can be retried without falsely reporting that disk cleanup succeeded.
   */
  public async recoverInterruptedUpdate(
    component: ReleaseComponentKind,
    cleanupStagingArtifact: (stagingDir: string) => Promise<void>,
  ): Promise<ComponentSlotRecord> {
    const cur = this.getSlot(component);
    const interruptedStates: ComponentUpdateState[] = [
      'UPDATE_DOWNLOADING',
      'UPDATE_DOWNLOADED',
      'UPDATE_STAGED',
      'UPDATE_READY',
      'UPDATE_ACTIVATING',
      'UPDATE_VERIFICATION_PENDING',
      'UPDATE_ROLLBACK_PENDING',
    ];
    if (!interruptedStates.includes(cur.state)) {
      return cur;
    }

    if (cur.stagingDir) {
      try {
        await cleanupStagingArtifact(cur.stagingDir);
      } catch (error) {
        throw new Error(
          `STAGING_CLEANUP_FAILED: could not remove interrupted artifact at ${cur.stagingDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const targetVersion = cur.previousKnownGoodVersion ?? cur.activeVersion;
    if (cur.state !== 'UPDATE_ROLLBACK_PENDING') {
      if (LEGAL_UPDATE_TRANSITIONS[cur.state].includes('UPDATE_ROLLBACK_PENDING')) {
        this.transition(component, 'UPDATE_ROLLBACK_PENDING', 'Detected interrupted update on restart; staged artifact cleanup completed.');
      } else {
        this.transition(component, 'UPDATE_FAILED', 'Detected interrupted pre-activation update on restart; staged artifact cleanup completed.');
        this.transition(component, 'UPDATE_ROLLBACK_PENDING', 'Cleaning up interrupted staging state.');
      }
    }
    return this.transition(component, 'UPDATE_ROLLED_BACK', `Recovered cleanly to known-good version ${targetVersion}.`, {
      activeVersion: targetVersion,
      candidateVersion: null,
      stagingDir: null,
      lastError: 'RECOVERED_FROM_INTERRUPTED_UPDATE',
    });
  }

  private async performRollback(
    component: ReleaseComponentKind,
    prevKnownGood: string,
    reason: string,
    restoreFn: (prevVersion: string) => Promise<boolean>,
  ): Promise<{ readonly ok: boolean; readonly slot: ComponentSlotRecord; readonly rolledBack: boolean }> {
    this.transition(component, 'UPDATE_ROLLBACK_PENDING', reason, { lastError: reason });
    let restored = false;
    try {
      restored = await restoreFn(prevKnownGood);
    } catch (error) {
      const failed = this.transition(component, 'UPDATE_FAILED', 'Rollback restoration threw an exception.', {
        lastError: `ROLLBACK_FAILED: ${reason}; restore threw: ${error instanceof Error ? error.message : String(error)}`,
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    if (!restored) {
      const failed = this.transition(component, 'UPDATE_FAILED', 'Rollback restoration failed.', {
        lastError: `ROLLBACK_FAILED: ${reason}`,
      });
      return { ok: false, slot: failed, rolledBack: false };
    }
    const rolled = this.transition(component, 'UPDATE_ROLLED_BACK', `Restored previous known-good ${prevKnownGood}.`, {
      activeVersion: prevKnownGood,
      candidateVersion: null,
      stagingDir: null,
    });
    return { ok: false, slot: rolled, rolledBack: true };
  }
}

/**
 * Storage Categories & Safe Uninstallation Planner (`AVP-P0-007 §11 & §12`).
 * Guarantees user-owned projects & source media are NEVER implicitly deleted.
 */
export type StorageCategory =
  | 'APP_BINARIES'
  | 'APP_CONFIG'
  | 'COMPANION_RUNTIME'
  | 'CEP_EXTENSION'
  | 'MODEL_ARTIFACTS'
  | 'TEMP_PROCESSING_FILES'
  | 'DIAGNOSTIC_LOGS'
  | 'USER_PROJECTS'
  | 'USER_SOURCE_MEDIA'
  | 'USER_EXPORTS';

export interface UninstallAuthorizationOptions {
  readonly removeAppBinaries: boolean;
  readonly removeCompanion: boolean;
  readonly removeCepExtension: boolean;
  readonly removeTempAndCache: boolean;
  readonly removeDownloadedModels: boolean;
  readonly removeDiagnosticLogs: boolean;
  /** Explicit authorization required — defaults to false, NEVER implicitly deleted */
  readonly explicitlyAuthorizedDeleteUserProjects?: boolean;
  readonly explicitlyAuthorizedDeleteUserMedia?: boolean;
}

export function buildSafeUninstallPlan(opts: UninstallAuthorizationOptions): {
  readonly categoriesToDelete: readonly StorageCategory[];
  readonly categoriesPreserved: readonly StorageCategory[];
  readonly mustStopCompanionProcessFirst: boolean;
  readonly mustCleanStaleLockAndIpcEndpoints: boolean;
} {
  const del: StorageCategory[] = [];
  const preserve: StorageCategory[] = [];

  const route = (cat: StorageCategory, shouldDelete: boolean) => {
    if (shouldDelete) del.push(cat);
    else preserve.push(cat);
  };

  route('APP_BINARIES', opts.removeAppBinaries);
  route('COMPANION_RUNTIME', opts.removeCompanion);
  route('CEP_EXTENSION', opts.removeCepExtension);
  route('TEMP_PROCESSING_FILES', opts.removeTempAndCache);
  route('MODEL_ARTIFACTS', opts.removeDownloadedModels);
  route('DIAGNOSTIC_LOGS', opts.removeDiagnosticLogs);
  route('APP_CONFIG', false);
  // User-owned assets NEVER deleted unless explicitly authorized
  route('USER_PROJECTS', opts.explicitlyAuthorizedDeleteUserProjects === true);
  route('USER_SOURCE_MEDIA', opts.explicitlyAuthorizedDeleteUserMedia === true);
  route('USER_EXPORTS', false);

  return {
    categoriesToDelete: del,
    categoriesPreserved: preserve,
    mustStopCompanionProcessFirst: opts.removeCompanion || opts.removeAppBinaries,
    mustCleanStaleLockAndIpcEndpoints: opts.removeCompanion,
  };
}

/**
 * Environment-separated browser deployment validator (`AVP-P0-007 §14`).
 */
export type DeploymentEnvironment = 'development' | 'internal_testing' | 'staging' | 'production';

export function validateDeploymentConfiguration(config: {
  readonly environment: DeploymentEnvironment;
  readonly allowCloudAsr: boolean;
  readonly hasDebugEndpointsEnabled: boolean;
  readonly cspHeader: string;
  readonly coopHeader: string;
  readonly coepHeader: string;
  readonly ortAssetsPresent: boolean;
}): { readonly valid: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  if (config.allowCloudAsr) {
    errors.push('LOCAL_ONLY_VIOLATION: Browser deployment must never enable Cloud ASR.');
  }
  if (!config.ortAssetsPresent) {
    errors.push('MISSING_ORT_WASM_ASSETS: Self-hosted /ort/ ONNX Runtime Web WASM assets are mandatory.');
  }
  if (config.environment === 'production') {
    if (config.hasDebugEndpointsEnabled) {
      errors.push('PROD_DEBUG_LEAK: Development/debug endpoints must be disabled in production.');
    }
    if (!config.cspHeader.includes("default-src 'self'")) {
      errors.push("PROD_CSP_WEAK: Production CSP must enforce default-src 'self'.");
    }
    if (config.cspHeader.includes('unsafe-eval') && !config.cspHeader.includes('wasm-unsafe-eval')) {
      errors.push('PROD_CSP_UNSAFE_EVAL: Use wasm-unsafe-eval instead of broad unsafe-eval.');
    }
    if (config.coopHeader !== 'same-origin') {
      errors.push('PROD_COOP_MISSING: Cross-Origin-Opener-Policy must be same-origin.');
    }
  }
  return { valid: errors.length === 0, errors };
}
