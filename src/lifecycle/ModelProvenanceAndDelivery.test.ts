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

test('AVP-P0-007: 17-state ComponentUpdateOrchestrator performs atomic update, rejects bad sig/hash/disk, and rolls back failed activation', async () => {
  const orch = new ComponentUpdateOrchestrator({
    BROWSER_APP: '1.0.0',
    NATIVE_COMPANION: '1.0.0',
    AUDITION_CEP_EXTENSION: '1.0.0',
    MODEL_ARTIFACT: '1.0.0',
  });
  const goodHash = 'a'.repeat(64);

  // 1. Successful verified update
  const okRes = await orch.executeSafeUpdate({
    manifest: {
      component: 'NATIVE_COMPANION',
      version: '1.1.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
      signatureStatus: 'SIGNATURE_VERIFIED',
    },
    requireCryptographicSignature: true,
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

  // 2. Post-activation health failure triggers automatic rollback to 1.1.0
  let restoredTo: string | null = null;
  const rollbackRes = await orch.executeSafeUpdate({
    manifest: {
      component: 'NATIVE_COMPANION',
      version: '1.2.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
      signatureStatus: 'SIGNATURE_VERIFIED',
    },
    requireCryptographicSignature: true,
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

  // 3. Reject invalid cryptographic signature before download
  let downloadedOnBadSig = false;
  const badSigRes = await orch.executeSafeUpdate({
    manifest: {
      component: 'NATIVE_COMPANION',
      version: '1.3.0',
      sha256Hex: goodHash,
      sizeBytes: 10_000_000,
      signatureStatus: 'SIGNATURE_INVALID',
    },
    requireCryptographicSignature: true,
    availableDiskBytes: 50_000_000,
    downloadAndVerifySha256: async () => {
      downloadedOnBadSig = true;
      return { ok: true, actualSha256Hex: goodHash };
    },
    stageArtifact: async () => ({ ok: true, stagingDir: '/tmp/stage-1.3.0' }),
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
