/**
 * AVAPARDAZ — AUTOMATED TEST SUITE
 * Missions: AVP-P0-002 (Model Artifact Qualification & Provenance),
 *           AVP-P0-007 (Installation, Update Orchestration, Recovery & Distribution),
 *           AVP-PERSIAN-ZIPFORMER-ASSET-ACQUISITION-001 (Genuine Zipformer-Transducer Package)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SHAHAB_ZIPFORMER_MODEL_DIR } from '../shahab/ShahabZipformerAsrRuntime';
import {
  CANONICAL_PERSIAN_ASR_CATALOG,
  computeManifestCanonicalDigest,
  validateCanonicalModelManifest,
  verifyManifestAuthenticity,
  evaluateModelRuntimeCompatibility,
  validateOnnxSessionTensorContract,
  parseCtcTokensTxt,
} from './CanonicalModelProvenance';
import {
  ALL_CANONICAL_MODEL_STATES,
  ModelLifecycleStateMachine,
  InvalidModelStateTransitionError,
} from './ModelLifecycleStateMachine';
import {
  CURRENT_COMPONENT_VERSIONS,
  evaluateComponentCompatibility,
  evaluateFirstRunReadiness,
  ComponentUpdateOrchestrator,
  canonicalizeUpdateManifest,
  type UpdateManifest,
  type UpdateManifestPayload,
  buildSafeUninstallPlan,
  validateDeploymentConfiguration,
} from './ProductDeliveryAndUpdateEngine';

test('AVP-P0-002: canonical manifest schema v2.0.0 validates catalog and rejects malformed/tampered manifests', async () => {
  assert.ok(CANONICAL_PERSIAN_ASR_CATALOG.length >= 1);
  for (const manifest of CANONICAL_PERSIAN_ASR_CATALOG) {
    const res = validateCanonicalModelManifest(manifest);
    assert.equal(res.valid, true, `Catalog manifest ${manifest.modelId} must validate: ${res.errors.join(', ')}`);
  }

  // Reject missing required fields & traversal paths
  const badRes = validateCanonicalModelManifest({
    schemaVersion: '2.0.0',
    modelId: '../escape',
    version: 'not-semver',
    artifacts: [{ role: 'encoder', path: '../../etc/passwd', sizeBytes: -5, sha256Hex: 'bad' }],
  });
  assert.equal(badRes.valid, false);
  assert.ok(badRes.errors.length >= 3);

  // Checksum-only vs cryptographic signature authenticity separation
  const sample = CANONICAL_PERSIAN_ASR_CATALOG[0];
  const authNoVerifier = await verifyManifestAuthenticity(sample);
  assert.equal(authNoVerifier, 'UNSIGNED_CHECKSUM_ONLY');

  const expectedDigest = computeManifestCanonicalDigest(sample);
  const signedManifest = {
    ...sample,
    provenance: {
      ...sample.provenance,
      signature: {
        algorithm: 'Ed25519' as const,
        keyId: 'avp-test-key',
        signatureBase64: 'dGVzdC1zaWduYXR1cmU=',
        signedPayloadSha256Hex: expectedDigest,
        signedAtIso: '2026-01-01T00:00:00.000Z',
      },
    },
  };

  const authUntrusted = await verifyManifestAuthenticity(signedManifest);
  assert.equal(authUntrusted, 'SIGNATURE_KEY_UNTRUSTED');

  const authWithValidVerifier = await verifyManifestAuthenticity(signedManifest, {
    verify: async () => 'SIGNATURE_VERIFIED',
  });
  assert.equal(authWithValidVerifier, 'SIGNATURE_VERIFIED');

  const authWithInvalidVerifier = await verifyManifestAuthenticity(signedManifest, {
    verify: async () => 'SIGNATURE_INVALID',
  });
  assert.equal(authWithInvalidVerifier, 'SIGNATURE_INVALID');
});

test('AVP-P0-002: exact 19-state ModelLifecycleStateMachine enforces legal transitions and restart recovery', () => {
  assert.equal(ALL_CANONICAL_MODEL_STATES.length, 19);
  const sm = new ModelLifecycleStateMachine('fa-fastconformer-ctc-int8', '1.0.0', 'DISCOVERED');
  assert.equal(sm.getState(), 'DISCOVERED');

  sm.transition('METADATA_VALIDATED', 'Manifest schema v2 validated');
  sm.transition('SOURCE_VERIFIED', 'Source provenance verified');
  sm.transition('DOWNLOAD_PENDING', 'Queued');
  sm.transition('DOWNLOADING', 'Streaming chunks');
  sm.transition('DOWNLOAD_INTERRUPTED', 'User paused');
  sm.transition('DOWNLOADING', 'Resumed');
  sm.transition('DOWNLOADED', 'All chunks received');
  sm.transition('INTEGRITY_VERIFIED', 'SHA-256 matched', { verifiedSha256Hex: 'a'.repeat(64) });
  sm.transition('INSTALLING', 'Staging atomic commit');
  sm.transition('INSTALLED', 'Committed to OPFS');
  // Direct INSTALLED -> ACTIVE is FORBIDDEN
  assert.throws(
    () => sm.transition('ACTIVE', 'Illegal shortcut'),
    (err: unknown) => err instanceof InvalidModelStateTransitionError,
  );
  sm.transition('COMPATIBILITY_VERIFIED', 'WASM SIMD & memory verified');
  sm.transition('RUNTIME_INITIALIZED', 'ORT session initialized');
  sm.transition('INFERENCE_VERIFIED', 'Real inference probe succeeded');
  sm.transition('ACTIVE', 'Model active for inference');
  assert.equal(sm.getState(), 'ACTIVE');
  assert.equal(sm.isOperationalForInference(), true);

  // Persisted ledger survives simulated app restart
  const persisted = sm.toPersistedLedger();
  const restored = ModelLifecycleStateMachine.restoreFromLedger(persisted);
  assert.equal(restored.getState(), 'ACTIVE');
  assert.equal(restored.toPersistedLedger().history.length, persisted.history.length);
});

test('AVP-P0-002: compatibility checks, ONNX tensor contract check, and tokens.txt parser', () => {
  const sample = CANONICAL_PERSIAN_ASR_CATALOG[0];
  const compatOk = evaluateModelRuntimeCompatibility(sample, {
    runtimeTarget: 'BROWSER_WASM_CPU',
    availableMemoryBudgetBytes: 4 * 1024 * 1024 * 1024,
    wasmAvailable: true,
    simdAvailable: true,
    sharedArrayBufferAvailable: true,
    webGpuAvailable: false,
    maxSupportedOnnxOpset: 17,
  });
  assert.equal(compatOk.compatible, true, `Expected compatible, got: ${compatOk.reasons.join('; ')}`);

  const compatLowMem = evaluateModelRuntimeCompatibility(sample, {
    runtimeTarget: 'BROWSER_WASM_CPU',
    availableMemoryBudgetBytes: 16 * 1024 * 1024,
    wasmAvailable: true,
    simdAvailable: false,
    sharedArrayBufferAvailable: false,
    webGpuAvailable: false,
    maxSupportedOnnxOpset: 17,
  });
  assert.equal(compatLowMem.compatible, false);
  assert.ok(compatLowMem.reasons.length >= 1);

  const tensorCheck = validateOnnxSessionTensorContract(
    sample,
    ['audio_signal', 'length'],
    ['logprobs'],
  );
  assert.equal(tensorCheck.valid, true);

  const tensorMismatch = validateOnnxSessionTensorContract(
    sample,
    ['wrong_input'],
    ['wrong_output'],
  );
  assert.equal(tensorMismatch.valid, false);

  const vocab = parseCtcTokensTxt('<blk> 0\nسلام 1\nدنیا 2\n');
  assert.deepEqual(vocab, ['<blk>', 'سلام', 'دنیا']);
});

test('AVP-P0-007: independent component compatibility, first-run readiness, safe uninstall, and prod deployment config', () => {
  const compatOk = evaluateComponentCompatibility({
    companionIpcProtocol: CURRENT_COMPONENT_VERSIONS.ipcProtocolVersion,
    cepRequiredIpcProtocol: CURRENT_COMPONENT_VERSIONS.ipcProtocolVersion,
    projectSchemaVersion: CURRENT_COMPONENT_VERSIONS.projectSchemaVersion,
    modelManifestSchemaVersion: CURRENT_COMPONENT_VERSIONS.modelManifestSchemaVersion,
  });
  assert.equal(compatOk.compatible, true);
  assert.equal(compatOk.status, 'VERIFIED');

  const compatMajorMismatch = evaluateComponentCompatibility({
    companionIpcProtocol: '1.0.0',
    cepRequiredIpcProtocol: '2.0.0',
  });
  assert.equal(compatMajorMismatch.compatible, false);
  assert.equal(compatMajorMismatch.status, 'INCOMPATIBLE');

  // Browser-only user does NOT need Companion
  const browserOnlyReady = evaluateFirstRunReadiness({
    mode: 'BROWSER_ONLY',
    appIntegrityVerified: true,
    storageWritable: true,
    browserWasmAvailable: true,
    companionInstalled: false,
    nativeDependencyAvailable: false,
    modelCatalogReadable: true,
    modelInstalled: true,
    modelChecksumVerified: true,
    modelRuntimeCompatible: true,
    realInferenceProbePassed: true,
  });
  assert.equal(browserOnlyReady.inferenceReady, true);
  assert.equal(browserOnlyReady.blockingReasons.length, 0);

  // Native-Audition user does NOT need Browser
  const nativeReady = evaluateFirstRunReadiness({
    mode: 'NATIVE_AUDITION',
    appIntegrityVerified: true,
    storageWritable: true,
    browserWasmAvailable: false,
    companionInstalled: true,
    nativeDependencyAvailable: true,
    auditionCepConnected: true,
    modelCatalogReadable: true,
    modelInstalled: true,
    modelChecksumVerified: true,
    modelRuntimeCompatible: true,
    realInferenceProbePassed: true,
  });
  assert.equal(nativeReady.inferenceReady, true);
  assert.equal(nativeReady.adobeAuditionConnected, true);

  // Safe uninstall ALWAYS preserves user projects & media unless explicitly authorized
  const defaultUninstall = buildSafeUninstallPlan({
    removeAppBinaries: true,
    removeCompanion: true,
    removeCepExtension: true,
    removeTempAndCache: true,
    removeDownloadedModels: false,
    removeDiagnosticLogs: false,
    explicitlyAuthorizedDeleteUserProjects: false,
    explicitlyAuthorizedDeleteUserMedia: false,
  });
  assert.ok(defaultUninstall.categoriesPreserved.includes('USER_PROJECTS'));
  assert.ok(defaultUninstall.categoriesPreserved.includes('USER_SOURCE_MEDIA'));
  assert.ok(!defaultUninstall.categoriesToDelete.includes('USER_PROJECTS'));

  // Deployment configuration rejects unsafe production flags
  const unsafeProd = validateDeploymentConfiguration({
    environment: 'production',
    allowCloudAsr: true,
    hasDebugEndpointsEnabled: true,
    cspHeader: "default-src * 'unsafe-eval'",
    coopHeader: 'unsafe-none',
    coepHeader: 'unsafe-none',
    ortAssetsPresent: false,
  });
  assert.equal(unsafeProd.valid, false);
  assert.ok(unsafeProd.errors.length >= 4);
});

test('AVP-P0-007: update orchestration requires real Ed25519 signatures, binds metadata and digest, and rolls back failed activation', async () => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = keyPair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const trustedSigningKeys = {
    'avp-test-release-key': new Uint8Array(publicKeyDer.subarray(-32)),
  };
  const orch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  }, trustedSigningKeys);
  const goodHash = 'a'.repeat(64);
  const signManifest = (payload: UpdateManifestPayload): UpdateManifest => ({
    ...payload,
    signature: {
      algorithm: 'Ed25519',
      keyId: 'avp-test-release-key',
      signatureBase64: crypto.sign(null, Buffer.from(canonicalizeUpdateManifest(payload, 'avp-test-release-key')), keyPair.privateKey).toString('base64'),
    },
  });

  // 1. A real Ed25519 signature from the pinned test key permits the update.
  const okRes = await orch.executeSafeUpdate({
    manifest: signManifest({
      component: 'NATIVE_COMPANION',
      version: '1.1.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
    }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-1.1.0' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.rolledBack, false);
  assert.equal(okRes.slot.activeVersion, '1.1.0');
  assert.equal(okRes.slot.previousKnownGoodVersion, '1.0.0');

  // 2. Older releases and replay of the active version are rejected before download.
  for (const replayVersion of ['1.0.9', '1.1.0']) {
    let replayDownloaded = false;
    const replayRes = await orch.executeSafeUpdate({
      manifest: signManifest({
        component: 'NATIVE_COMPANION',
        version: replayVersion,
        sha256Hex: goodHash,
        sizeBytes: 10_000_000,
      }),
      availableDiskBytes: 50_000_000,
      downloadAndVerifySha256: async () => {
        replayDownloaded = true;
        return { ok: true, actualSha256Hex: goodHash };
      },
      stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/replay-must-not-stage' }),
      activateArtifact: async () => ({ ok: true }),
      verifyPostActivationHealth: async () => ({ ok: true }),
      restorePreviousVersion: async () => true,
    });
    assert.equal(replayRes.ok, false);
    assert.equal(replayRes.slot.lastError, 'UPDATE_VERSION_NOT_NEWER');
    assert.equal(replayDownloaded, false);
  }

  // A pinned render job defers activation; after release, the staged artifact resumes without re-download.
  const deferredOrch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  }, trustedSigningKeys);
  deferredOrch.pinActiveJob('render-1');
  const deferredRes = await deferredOrch.executeSafeUpdate({
    manifest: signManifest({
      component: 'NATIVE_COMPANION',
      version: '1.1.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
    }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/deferred-stage-1.1.0' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(deferredRes.ok, false);
  assert.equal(deferredRes.slot.state, 'UPDATE_READY');
  assert.equal(deferredRes.slot.activeVersion, '1.0.0');
  assert.equal(deferredRes.slot.previousKnownGoodVersion, '1.0.0');

  let activatedBeforePinRelease = false;
  const stillPinnedRes = await deferredOrch.resumeStagedUpdate({
    component: 'NATIVE_COMPANION',
    activateArtifact: async () => {
      activatedBeforePinRelease = true;
      return { ok: true };
    },
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(stillPinnedRes.ok, false);
  assert.equal(activatedBeforePinRelease, false);

  deferredOrch.releasePinnedJob('render-1');
  let resumedStagingPath: string | null = null;
  const resumedRes = await deferredOrch.resumeStagedUpdate({
    component: 'NATIVE_COMPANION',
    activateArtifact: async (stagingDir) => {
      resumedStagingPath = stagingDir;
      return { ok: true };
    },
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(resumedRes.ok, true);
  assert.equal(resumedStagingPath, '/tmp/deferred-stage-1.1.0');
  assert.equal(resumedRes.slot.activeVersion, '1.1.0');
  assert.equal(resumedRes.slot.state, 'UPDATE_VERIFIED');

  // Deferred activation callbacks may throw; the orchestrator must still enter rollback.
  const throwingActivationOrch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  }, trustedSigningKeys);
  throwingActivationOrch.pinActiveJob('render-throw-activation');
  await throwingActivationOrch.executeSafeUpdate({
    manifest: signManifest({ component: 'NATIVE_COMPANION', version: '1.1.0', sha256Hex: goodHash, sizeBytes: 10_000_000 }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/deferred-throw-activation' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  throwingActivationOrch.releasePinnedJob('render-throw-activation');
  const thrownActivationRes = await throwingActivationOrch.resumeStagedUpdate({
    component: 'NATIVE_COMPANION',
    activateArtifact: async () => { throw new Error('simulated activation exception'); },
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(thrownActivationRes.rolledBack, true);
  assert.equal(thrownActivationRes.slot.state, 'UPDATE_ROLLED_BACK');
  assert.equal(thrownActivationRes.slot.activeVersion, '1.0.0');

  // A thrown health probe also rolls back; a thrown restore callback fails closed.
  const throwingHealthOrch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  }, trustedSigningKeys);
  throwingHealthOrch.pinActiveJob('render-throw-health');
  await throwingHealthOrch.executeSafeUpdate({
    manifest: signManifest({ component: 'NATIVE_COMPANION', version: '1.1.0', sha256Hex: goodHash, sizeBytes: 10_000_000 }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/deferred-throw-health' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  throwingHealthOrch.releasePinnedJob('render-throw-health');
  const thrownHealthRes = await throwingHealthOrch.resumeStagedUpdate({
    component: 'NATIVE_COMPANION',
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => { throw new Error('simulated health exception'); },
    restorePreviousVersion: async () => true,
  });
  assert.equal(thrownHealthRes.rolledBack, true);
  assert.equal(thrownHealthRes.slot.state, 'UPDATE_ROLLED_BACK');
  assert.equal(thrownHealthRes.slot.activeVersion, '1.0.0');

  // Restart recovery must clear the staged UPDATE_READY reference and preserve the active version.
  const interruptedReadyOrch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  }, trustedSigningKeys);
  interruptedReadyOrch.pinActiveJob('render-2');
  await interruptedReadyOrch.executeSafeUpdate({
    manifest: signManifest({
      component: 'NATIVE_COMPANION',
      version: '1.1.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
    }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/interrupted-ready-stage' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  const recoveredReady = interruptedReadyOrch.recoverInterruptedUpdate('NATIVE_COMPANION');
  assert.equal(recoveredReady.state, 'UPDATE_ROLLED_BACK');
  assert.equal(recoveredReady.activeVersion, '1.0.0');
  assert.equal(recoveredReady.candidateVersion, null);
  assert.equal(recoveredReady.stagingDir, null);

  // SemVer prerelease ordering permits beta.2 after beta.1.
  const prereleaseOrch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '2.0.0-beta.1',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  }, trustedSigningKeys);
  const prereleaseRes = await prereleaseOrch.executeSafeUpdate({
    manifest: signManifest({
      component: 'NATIVE_COMPANION',
      version: '2.0.0-beta.2',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
    }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-beta-2' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(prereleaseRes.ok, true);
  assert.equal(prereleaseRes.slot.activeVersion, '2.0.0-beta.2');

  // 3. Post-activation health failure triggers automatic rollback to 1.1.0.
  let restoredTo: string | null = null;
  const rollbackRes = await orch.executeSafeUpdate({
    manifest: signManifest({
      component: 'NATIVE_COMPANION',
      version: '1.2.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
    }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => ({ ok: true, actualSha256Hex: goodHash }),
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-1.2.0' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: false, error: 'Companion health endpoint timed out' }),
    restorePreviousVersion: async (prev) => {
      restoredTo = prev;
      return true;
    },
  });
  assert.equal(rollbackRes.ok, false);
  assert.equal(rollbackRes.rolledBack, true);
  assert.equal(restoredTo, '1.1.0');
  assert.equal(rollbackRes.slot.activeVersion, '1.1.0');
  assert.equal(rollbackRes.slot.state, 'UPDATE_ROLLED_BACK');

  // 3. A tampered manifest digest is rejected before any download.
  let downloadedOnTamperedManifest = false;
  const validButAltered = signManifest({
    component: 'NATIVE_COMPANION',
    version: '1.3.0',
    sha256Hex: goodHash,
    sizeBytes: 10_000_000,
  });
  const tamperedRes = await orch.executeSafeUpdate({
    manifest: { ...validButAltered, sha256Hex: 'b'.repeat(64) },
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => {
      downloadedOnTamperedManifest = true;
      return { ok: true, actualSha256Hex: 'b'.repeat(64) };
    },
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-1.3.0' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(tamperedRes.ok, false);
  assert.equal(downloadedOnTamperedManifest, false);
  assert.equal(tamperedRes.slot.lastError, 'UPDATE_AUTHENTICITY_FAILED');

  // 4. A valid signature is still rejected if its key is not in the pinned trust store.
  const noTrustRoot = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  });
  let downloadedWithoutTrustRoot = false;
  const noTrustRes = await noTrustRoot.executeSafeUpdate({
    manifest: signManifest({
      component: 'NATIVE_COMPANION',
      version: '1.1.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
    }),
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => {
      downloadedWithoutTrustRoot = true;
      return { ok: true, actualSha256Hex: goodHash };
    },
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-no-root' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(noTrustRes.ok, false);
  assert.equal(downloadedWithoutTrustRoot, false);
  assert.equal(noTrustRes.slot.lastError, 'UPDATE_AUTHENTICITY_FAILED');

  // 5. A cryptographically malformed signature is rejected before download.
  let downloadedOnBadSig = false;
  const badSigManifest = signManifest({
    component: 'NATIVE_COMPANION',
    version: '1.4.0',
    sha256Hex: goodHash,
    sizeBytes: 10_000_000,
  });
  const badSigRes = await orch.executeSafeUpdate({
    manifest: {
      ...badSigManifest,
      signature: { ...badSigManifest.signature, signatureBase64: 'A'.repeat(88) },
    },
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => {
      downloadedOnBadSig = true;
      return { ok: true, actualSha256Hex: goodHash };
    },
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-bad-signature' }),
    activateArtifact: async () => ({ ok: true }),
    verifyPostActivationHealth: async () => ({ ok: true }),
    restorePreviousVersion: async () => true,
  });
  assert.equal(badSigRes.ok, false);
  assert.equal(downloadedOnBadSig, false);
  assert.equal(badSigRes.slot.lastError, 'UPDATE_AUTHENTICITY_FAILED');
});

test('AVP-PERSIAN-ZIPFORMER-ASSET-ACQUISITION-001: acquired Zipformer-Transducer package matches exact SHA-256, ONNX structure, tokens.txt=1024, and is NOT wired to CTC engine', (t) => {
  const pkgDir = path.resolve(process.cwd(), 'models/persian-zipformer-transducer/1.0.0');
  const modelDir = DEFAULT_SHAHAB_ZIPFORMER_MODEL_DIR;
  const manifestPath = path.join(pkgDir, 'manifest.json');
  assert.equal(fs.existsSync(manifestPath), true, 'manifest.json must exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.modelId, 'persian-zipformer-transducer');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.language, 'fa-IR');
  assert.equal(manifest.architecture, 'zipformer2-transducer');
  assert.equal(manifest.quantization, 'int8');
  assert.equal(manifest.sampleRate, 16000);
  assert.equal(manifest.featureDim, 80);
  assert.equal(manifest.decodingMethod, 'modified_beam_search');
  assert.equal(manifest.maxActivePaths, 4);
  assert.equal(manifest.runtimeCompatibility.compatibleWithCoreAcousticCtcEngine, false);
  assert.equal(manifest.runtimeCompatibility.asrInferenceWired, false);

  // Verify every declared file with SHA-256 & exact byte count on disk
  for (const entry of manifest.files) {
    const metadataFiles = new Set(['README.md', 'LICENSE', 'NOTICE', 'transcribe.py']);
    const absPath = path.join(metadataFiles.has(entry.path) ? pkgDir : modelDir, entry.path);
    if (!fs.existsSync(absPath)) {
      t.skip(`External model asset is not provisioned in this environment: ${entry.path}`);
      return;
    }
    const stat = fs.statSync(absPath);
    assert.ok(stat.size > 0, `${entry.path} must be non-empty`);
    if (typeof entry.sizeBytes === 'number') {
      assert.equal(stat.size, entry.sizeBytes, `Byte count mismatch for ${entry.path}`);
    }
    if (typeof entry.sha256 === 'string') {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      assert.equal(actual, entry.sha256, `SHA-256 mismatch for ${entry.path}`);
    }
  }

  // Verify tokens.txt UTF-8 Persian content & exact 1024 count
  const tokensText = fs.readFileSync(path.join(modelDir, 'tokens.txt'), 'utf8');
  const lines = tokensText.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1024);
  assert.equal(lines[0], '<blk> 0');

  // Verify CoreAcousticCtcEngine does NOT reference persian-zipformer-transducer
  const ctcSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/asr-core/CoreAcousticCtcEngine.ts'), 'utf8');
  assert.equal(ctcSrc.includes('persian-zipformer-transducer'), false);
});
